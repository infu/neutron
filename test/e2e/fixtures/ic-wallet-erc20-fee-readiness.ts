import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Actor, HttpAgent } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { Principal } from "@dfinity/principal";
import { Interface, getAddress } from "ethers";
import { resolveLocalNeutronRuntime } from "../../../packages/neutron-provision/src/local_session.ts";
import { verifyPocketIcRuntime } from "../../../packages/neutron-provision/src/pocketic_supervisor.ts";
import { createLocalEvmChain } from "./evm-wallet-chain.ts";
import { createIcWalletBridgeFixture } from "./ic-wallet-bridge.ts";

// The released minter lazily fetches fees only while processing a withdrawal.
// An ordinary donor withdrawal initializes that cache; no minter state or clock
// is injected. Importing this helper performs no runtime action.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ledgerId = "ss2fx-dyaaa-aaaar-qacoq-cai";
const minterId = "sv3dd-oaaaa-aaaar-qacoa-cai";
const tokenLedger = "xevnm-gaaaa-aaaar-qafnq-cai";
const account = IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) });
const fee = IDL.Record({ max_fee_per_gas: IDL.Nat, max_priority_fee_per_gas: IDL.Nat, gas_limit: IDL.Nat, max_transaction_fee: IDL.Nat, timestamp: IDL.Opt(IDL.Nat64) });
const json = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2) + "\n";

export async function ensureErc20MinterFeeReadiness(configPath: string): Promise<string> {
  assert.equal(path.resolve(configPath), path.join(root, "evm-wallet-erc20-local.ndeploy.json"));
  const runtime = resolveLocalNeutronRuntime({ configPath });
  const directory = path.join(root, ".neutron/release-receipts/evm-wallet-completion-2026-09-06/erc20-runtime");
  const ready = JSON.parse(await readFile(path.join(directory, "ready.json"), "utf8"));
  const deployment = JSON.parse(await readFile(path.join(directory, "first-deployment.json"), "utf8"));
  assert.equal(ready.descriptor.stateDirectory, path.join(root, ".neutron/evm-wallet-erc20-pocketic"));
  assert.equal(runtime.controlUrl, ready.descriptor.controlUrl);
  assert.equal(runtime.gatewayUrl, ready.descriptor.gateway.url);
  assert.equal(runtime.canisterId, deployment.node.canisterId);
  assert.equal(deployment.firstCreatedCanisterOnly, true);
  assert.equal(deployment.reinstallPermitted, false);
  await verifyPocketIcRuntime(ready.descriptor);
  const donor = Ed25519KeyIdentity.generate(new Uint8Array(createHash("sha256").update("neutron-ic-wallet-bridge-e2e-donor-v1").digest()));
  const agent = await HttpAgent.create({ host: runtime.gatewayUrl, identity: donor, verifyQuerySignatures: false });
  await agent.fetchRootKey();
  assert.equal(Buffer.from(agent.rootKey!).toString("base64"), ready.descriptor.rootKeyBase64);
  const minter = Actor.createActor<any>(({ IDL }) => IDL.Service({
    get_minter_info: IDL.Func([], [IDL.Record({ minimum_withdrawal_amount: IDL.Opt(IDL.Nat), minter_address: IDL.Opt(IDL.Text) })], ["query"]),
    eip_1559_transaction_price: IDL.Func([IDL.Opt(IDL.Record({ ckerc20_ledger_id: IDL.Principal }))], [fee], ["query"]),
    withdraw_eth: IDL.Func([IDL.Record({ recipient: IDL.Text, amount: IDL.Nat, from_subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) })], [IDL.Variant({ Ok: IDL.Record({ block_index: IDL.Nat }), Err: IDL.Variant({ AmountTooLow: IDL.Record({ min_withdrawal_amount: IDL.Nat }), InsufficientFunds: IDL.Record({ balance: IDL.Nat }), InsufficientAllowance: IDL.Record({ allowance: IDL.Nat }), RecipientAddressBlocked: IDL.Record({ address: IDL.Text }), TemporarilyUnavailable: IDL.Text }) })], []),
  }), { agent, canisterId: minterId });
  const finalPath = path.join(directory, "fee-readiness.json");
  const progressPath = path.join(directory, "fee-readiness-progress.json");
  let previousProgress = false;
  try { await readFile(progressPath); previousProgress = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (previousProgress) {
    // The cache can become ready before a prior donor withdrawal settles. It
    // must not conceal an interrupted financial attempt on a setup retry.
    const completed = JSON.parse(await readFile(finalPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new Error("Previous donor fee-readiness attempt requires same-request reconciliation; no new effect was submitted");
      throw error;
    }));
    assert.equal(completed.deploymentId, deployment.deploymentId);
    assert.equal(completed.status, "normal_donor_withdrawal_finalized");
    return finalPath;
  }
  let cached: unknown;
  try { cached = await minter.eip_1559_transaction_price([{ ckerc20_ledger_id: Principal.fromText(tokenLedger) }]); }
  catch (error) { assert.match(String(error), /last transaction price estimate is not available/u); }
  if (cached) {
    try { await readFile(finalPath); return finalPath; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await writeFile(finalPath, json({ completedAt: new Date().toISOString(), deploymentId: deployment.deploymentId, packagePins: deployment.packagePins, status: "existing_normal_fee_cache", fee: cached, noDonorWithdrawal: true }), { flag: "wx" });
    return finalPath;
  }
  const proof: Record<string, unknown> = {
    startedAt: new Date().toISOString(), deploymentId: deployment.deploymentId, packagePins: deployment.packagePins,
    donor: donor.getPrincipal().toText(), purpose: "Distinct ordinary donor withdrawal to initialize the released minter fee cache; no user bridge or redemption is repeated.",
    source: "https://github.com/dfinity/ic/blob/a47e5434753752c1d2972fbc4407d14f88964285/rs/ethereum/cketh/minter/src/withdraw.rs#L150",
  };
  // Existing or uncertain attempts require explicit same-request reconciliation,
  // never a second withdrawal just because the response was lost.
  await writeFile(progressPath, json(proof), { flag: "wx" });
  const checkpoint = async (stage: string, values: Record<string, unknown> = {}) => { Object.assign(proof, values, { stage, updatedAt: new Date().toISOString() }); await writeFile(progressPath, json(proof)); console.log(stage); };
  const ledger = Actor.createActor<any>(({ IDL }) => IDL.Service({
    icrc1_balance_of: IDL.Func([account], [IDL.Nat], ["query"]), icrc1_fee: IDL.Func([], [IDL.Nat], ["query"]),
    icrc2_allowance: IDL.Func([IDL.Record({ account, spender: account })], [IDL.Record({ allowance: IDL.Nat, expires_at: IDL.Opt(IDL.Nat64) })], ["query"]),
    icrc2_approve: IDL.Func([IDL.Record({ amount: IDL.Nat, spender: account, from_subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)), expected_allowance: IDL.Opt(IDL.Nat), expires_at: IDL.Opt(IDL.Nat64), fee: IDL.Opt(IDL.Nat), memo: IDL.Opt(IDL.Vec(IDL.Nat8)), created_at_time: IDL.Opt(IDL.Nat64) })], [IDL.Variant({ Ok: IDL.Nat, Err: IDL.Reserved })], []),
  }), { agent, canisterId: ledgerId });
  const donorAccount = { owner: donor.getPrincipal(), subaccount: [] };
  const spender = { owner: Principal.fromText(minterId), subaccount: [] };
  const info = await minter.get_minter_info();
  const amount = info.minimum_withdrawal_amount[0] as bigint;
  assert(amount > 0n && amount <= 10_000_000_000_000_000n);
  const ledgerFee = await ledger.icrc1_fee() as bigint;
  const balanceBefore = await ledger.icrc1_balance_of(donorAccount) as bigint;
  const allowanceBefore = (await ledger.icrc2_allowance({ account: donorAccount, spender })).allowance as bigint;
  assert.equal(allowanceBefore, 0n);
  const chain = await createLocalEvmChain();
  const protocol = await createIcWalletBridgeFixture(runtime, { fundDonor: false });
  const helper = new Interface(["function deposit(bytes32 principal) payable"]);
  const principalBytes = donor.getPrincipal().toUint8Array(); const word = new Uint8Array(32); word[0] = principalBytes.length; word.set(principalBytes, 1);
  const accounts = await chain.rpc<string[]>("eth_accounts"); const recipient = getAddress(accounts[0]!);
  const funding = amount + ledgerFee + 1_000_000_000_000_000n;
  await checkpoint("donor_funding_submitting", { amount, ledgerFee, balanceBefore, allowanceBefore, recipient, funding });
  const depositHash = await chain.rpc<string>("eth_sendTransaction", [{ from: recipient, to: protocol.helperAddress, value: `0x${funding.toString(16)}`, data: helper.encodeFunctionData("deposit", [`0x${Buffer.from(word).toString("hex")}`]), gas: "0x30d40" }]);
  await checkpoint("donor_funding_submitted", { depositHash });
  const mint = await protocol.advanceUntilMint(depositHash);
  assert.equal(mint.ledgerBlock.recipient, donor.getPrincipal().toText());
  assert.equal(BigInt(mint.ledgerBlock.amount), funding);
  assert.equal(await ledger.icrc1_balance_of(donorAccount), balanceBefore + funding);
  await checkpoint("donor_funding_minted", { mint });
  const createdAtTime = BigInt(Date.now()) * 1_000_000n;
  await checkpoint("donor_approval_submitting", { createdAtTime });
  const approval = await ledger.icrc2_approve({ amount, spender, from_subaccount: [], expected_allowance: [0n], expires_at: [], fee: [ledgerFee], memo: [], created_at_time: [createdAtTime] });
  assert("Ok" in approval, json(approval));
  await checkpoint("donor_approved", { approval });
  await checkpoint("donor_withdrawal_submitting");
  const withdrawal = await minter.withdraw_eth({ amount, recipient, from_subaccount: [] });
  assert("Ok" in withdrawal, json(withdrawal));
  await checkpoint("donor_withdrawal_queued", { withdrawal });
  const payout = await protocol.advanceUntilWithdrawal(withdrawal.Ok.block_index, recipient);
  assert.equal(payout.burn.owner, donor.getPrincipal().toText());
  assert.equal(BigInt(payout.burn.amount), amount);
  const quoted = await minter.eip_1559_transaction_price([{ ckerc20_ledger_id: Principal.fromText(tokenLedger) }]);
  assert(quoted.max_transaction_fee > 0n);
  const balanceAfter = await ledger.icrc1_balance_of(donorAccount) as bigint;
  assert.equal(balanceAfter, balanceBefore + funding - amount - ledgerFee);
  assert.equal((await ledger.icrc2_allowance({ account: donorAccount, spender })).allowance, 0n);
  await checkpoint("donor_withdrawal_finalized_fee_ready", { payout, quoted, balanceAfter });
  await writeFile(finalPath, json({ ...proof, completedAt: new Date().toISOString(), status: "normal_donor_withdrawal_finalized", noUserBridgeOrRedemptionRepeated: true, noClockOrMinterStateInjection: true }), { flag: "wx" });
  return finalPath;
}

if (import.meta.main) {
  const [command, configPath, ...extra] = process.argv.slice(2);
  assert.equal(command, "ensure"); assert(configPath && extra.length === 0);
  console.log(await ensureErc20MinterFeeReadiness(configPath));
}
