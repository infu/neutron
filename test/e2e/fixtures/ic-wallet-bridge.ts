import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Actor, HttpAgent, type ActorMethod } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { Principal } from "@dfinity/principal";
import { getAddress, Interface, Transaction } from "ethers";
import type { LocalNeutronRuntime } from "../../../packages/neutron-provision/src/local_session.ts";
import { localIdentityFromSeed } from "../../../packages/neutron-provision/src/kernel.ts";
import type { BridgeIntent, BridgeSource, BridgeStep } from "../../../apps/wallet/src/bridge.ts";
import { createLocalEvmChain, type LocalEvmTransactionEvidence } from "./evm-wallet-chain.ts";

const CKETH_LEDGER = "ss2fx-dyaaa-aaaar-qacoq-cai";
const CKETH_MINTER = "sv3dd-oaaaa-aaaar-qacoa-cai";
const DONOR_TARGET = 1_000_000_000_000_000n;
const helperAbi = new Interface([
  "function getMinterAddress() view returns (address)",
  "function deposit(bytes32 principal) payable",
  "event ReceivedEth(address indexed from, uint256 value, bytes32 indexed principal)",
]);

type Opt<T> = [] | [T];
type Account = { owner: Principal; subaccount: Opt<Uint8Array> };
type EventSource = { transaction_hash: string; log_index: bigint };
type Deposit = EventSource & { block_number: bigint; from_address: string; value: bigint; principal: Principal; subaccount: Opt<Uint8Array> };
type Payload = { AcceptedDeposit: Deposit } | { MintedCkEth: { event_source: EventSource; mint_block_index: bigint } } |
  { InvalidDeposit: { event_source: EventSource; reason: string } } | { QuarantinedDeposit: { event_source: EventSource } };
type MinterEvent = { timestamp: bigint; payload: Opt<Payload> };
type IndexedEvent = MinterEvent & { index: bigint };
export type IcrcValue = { Blob: Uint8Array } | { Text: string } | { Nat: bigint } | { Int: bigint } | { Array: IcrcValue[] } | { Map: [string, IcrcValue][] };
type Ledger = {
  icrc1_balance_of: ActorMethod<[Account], bigint>;
  icrc1_fee: ActorMethod<[], bigint>;
  icrc2_allowance: ActorMethod<[{ account: Account; spender: Account }], { allowance: bigint }>;
  icrc1_transfer: ActorMethod<[{ to: Account; amount: bigint; fee: Opt<bigint>; from_subaccount: Opt<Uint8Array>; memo: Opt<Uint8Array>; created_at_time: Opt<bigint> }], { Ok: bigint } | { Err: unknown }>;
  icrc3_get_blocks: ActorMethod<[[{ start: bigint; length: bigint }]], { blocks: { id: bigint; block: IcrcValue }[] }>;
};
type MinterInfo = { minter_address: Opt<string>; smart_contract_address: Opt<string>; eth_helper_contract_address: Opt<string>; cketh_ledger_id: Opt<Principal> };
type Minter = {
  get_minter_info: ActorMethod<[], MinterInfo>;
  get_events: ActorMethod<[{ start: bigint; length: bigint }], { events: MinterEvent[]; total_event_count: bigint }>;
  retrieve_eth_status: ActorMethod<[bigint], WithdrawalStatus>;
};
type WithdrawalStatus = { NotFound: null } | { Pending: null } | { TxCreated: null } | { TxSent: { transaction_hash: string } } | { TxFinalized:
  { Success: { transaction_hash: string; effective_transaction_fee: Opt<bigint> } } |
  { Reimbursed: { transaction_hash: string; reimbursed_amount: bigint; reimbursed_in_block: bigint } } |
  { PendingReimbursement: { transaction_hash: string } } };
type Management = {
  canister_status: ActorMethod<[{ canister_id: Principal }], { status: { running: null } | { stopping: null } | { stopped: null }; settings: { controllers: Principal[] }; module_hash: Opt<Uint8Array> }>;
  stop_canister: ActorMethod<[{ canister_id: Principal }], undefined>;
  start_canister: ActorMethod<[{ canister_id: Principal }], undefined>;
};

export type IcWalletMintEvidence = {
  accepted: { transactionHash: string; logIndex: string; blockNumber: string; fromAddress: string; amount: string; recipient: string; subaccount: string | null; eventIndex: string; timestampNs: string };
  minted: { transactionHash: string; logIndex: string; ledgerBlockIndex: string; eventIndex: string; timestampNs: string };
  ledgerBlock: { index: string; kind: "mint"; amount: string; recipient: string; subaccount: string | null };
};
export type IcWalletBridgeFixture = {
  ckethLedger: string;
  ckethMinter: string;
  helperAddress: string;
  donorDepositHash: string | null;
  walletBridge(id: string): Promise<BridgeIntent>;
  refreshWalletBridge(id: string): Promise<BridgeIntent>;
  walletTransferForBurn(burnIndex: string | bigint, ledgerId?: string): Promise<IcWalletTransferEvidence>;
  walletTransfer(requestId: string): Promise<IcWalletTransferEvidence>;
  ckethBalance(owner: string | Principal): Promise<bigint>;
  ckethFee(): Promise<bigint>;
  ckethAllowance(owner: string | Principal): Promise<bigint>;
  pauseMinter(): Promise<() => Promise<void>>;
  advanceUntilMint(hash: string): Promise<IcWalletMintEvidence>;
  advanceUntilWithdrawal(burnIndex: string | bigint, recipient: string): Promise<IcWalletWithdrawalEvidence>;
  unrelatedTransfer(owner: string | Principal, amount: bigint): Promise<{ blockIndex: bigint; balanceDelta: bigint }>;
};
export type IcWalletWithdrawalEvidence = {
  burn: { index: string; kind: "burn"; amount: string; owner: string; subaccount: string | null };
  transaction: LocalEvmTransactionEvidence;
  minterStatus: "TxFinalized.Success";
  effectiveTransactionFeeWei: string | null;
  recipientBalanceWei: string;
};
export type IcWalletTransferEvidence = {
  requestId: string; ledger: string; amount: string; destination: string; native: boolean;
  status: "pending" | "succeeded" | "rejected"; blockIndex: string | null;
  settlement: { status: "pending" | "submitted" | "confirmed" | "failed" | "unknown"; transactionHash: string | null } | null;
};

/** Real released ckETH protocol, on the explicitly selected disposable runtime.
 * No balance injection, canister reinstall, chain reset, or clock adjustment.
 * The donor's ckETH comes from an ordinary Ethereum helper deposit and mint.
 */
export async function createIcWalletBridgeFixture(runtime: LocalNeutronRuntime, options: { fundDonor?: boolean } = {}): Promise<IcWalletBridgeFixture> {
  await assertIsolatedRuntime(runtime);
  const chain = await createLocalEvmChain();
  const node = await chain.rpc<{ forkConfig?: { forkUrl?: unknown; forkBlockNumber?: unknown } }>("anvil_nodeInfo");
  if (node.forkConfig?.forkUrl != null || node.forkConfig?.forkBlockNumber != null) throw new Error("ckETH fixture requires unforked local Anvil");
  // This identity is the controller configured by local_fixtures.ts. Importing
  // that Bun-only provisioner module into Node/Playwright would run import.meta.dir.
  const controller = seededIdentity("neutron-pocketic-ledger-minter-v1");
  const donor = seededIdentity("neutron-ic-wallet-bridge-e2e-donor-v1");
  const createAgent = async (identity: Ed25519KeyIdentity) => {
    const agent = await HttpAgent.create({ host: runtime.gatewayUrl, identity, verifyQuerySignatures: false });
    await agent.fetchRootKey();
    return agent;
  };
  const [controllerAgent, donorAgent, developerAgent] = await Promise.all([
    createAgent(controller), createAgent(donor), createAgent(localIdentityFromSeed(runtime.developerIdentitySeed)),
  ]);
  const minterPrincipal = Principal.fromText(CKETH_MINTER);
  const management = Actor.createActor<Management>(managementIdl, { agent: controllerAgent, canisterId: "aaaaa-aa", effectiveCanisterId: minterPrincipal });
  const status = await management.canister_status({ canister_id: minterPrincipal });
  if (!("running" in status.status) || !status.module_hash.length || !status.settings.controllers.some((value) => value.toText() === controller.getPrincipal().toText())) {
    throw new Error("The selected ckETH minter is not the running, fixture-controlled installed canister");
  }
  const minter = Actor.createActor<Minter>(minterIdl, { agent: developerAgent, canisterId: CKETH_MINTER });
  const ledger = Actor.createActor<Ledger>(ledgerIdl, { agent: donorAgent, canisterId: CKETH_LEDGER });
  const wallet = Actor.createActor<{
    app_wallet__wallet_bridge_status_v1: ActorMethod<[Uint8Array], { ok: WireIntent } | { err: string }>;
    app_wallet__wallet_bridge_refresh_v1: ActorMethod<[{ id: Uint8Array; event_page_length: bigint }], { ok: WireIntent } | { err: string }>;
    app_wallet__wallet_transfers_pending_v2: ActorMethod<[null], WireTransfer[]>;
    app_wallet__wallet_transfer_status_v2: ActorMethod<[Uint8Array], { ok: WireTransfer } | { err: string }>;
  }>(walletIdl, { agent: developerAgent, canisterId: runtime.canisterId });
  const info = await minter.get_minter_info();
  if (info.cketh_ledger_id[0]?.toText() !== CKETH_LEDGER) throw new Error("The real minter reports a different ckETH ledger");
  const helperAddress = getAddress(info.eth_helper_contract_address[0] ?? info.smart_contract_address[0] ?? "");
  const minterAddress = getAddress(info.minter_address[0] ?? "");
  const code = await chain.rpc<string>("eth_getCode", [helperAddress, "latest"]);
  const configuredMinter = helperAbi.decodeFunctionResult("getMinterAddress", await chain.rpc<string>("eth_call", [{ to: helperAddress, data: helperAbi.encodeFunctionData("getMinterAddress") }, "latest"]))[0];
  if (code === "0x" || getAddress(configuredMinter) !== minterAddress) throw new Error("The existing Ethereum helper does not point to the real minter");

  const ckethBalance = (owner: string | Principal) => ledger.icrc1_balance_of(account(owner));
  const ckethAllowance = async (owner: string | Principal) => (await ledger.icrc2_allowance({ account: account(owner), spender: account(minterPrincipal) })).allowance;
  async function allEvents(): Promise<IndexedEvent[]> {
    const output: IndexedEvent[] = [];
    let start = 0n;
    while (true) {
      const page = await minter.get_events({ start, length: 100n });
      output.push(...page.events.map((event, index) => ({ ...event, index: start + BigInt(index) })));
      start += BigInt(page.events.length);
      if (start >= page.total_event_count) return output;
      if (!page.events.length) throw new Error("Real minter event pagination did not advance");
    }
  }
  async function advanceUntilMint(hash: string): Promise<IcWalletMintEvidence> {
    const transactionHash = checkedHash(hash);
    await chain.rpc("anvil_mine", ["0x80"]);
    // PocketIC stays on wall-clock auto-progress: advancing IC time invalidates
    // browser ingress/certificates and alters application review expiry.
    const deadline = Date.now() + 300_000;
    let last = "No AcceptedDeposit event yet";
    do {
      const events = await allEvents();
      const acceptedEvent = events.find((event) => event.payload[0] && "AcceptedDeposit" in event.payload[0] && event.payload[0].AcceptedDeposit.transaction_hash.toLowerCase() === transactionHash);
      const accepted = acceptedEvent?.payload[0];
      for (const event of events) {
        const payload = event.payload[0];
        if (payload && "InvalidDeposit" in payload && payload.InvalidDeposit.event_source.transaction_hash.toLowerCase() === transactionHash) throw new Error(`Minter rejected this deposit: ${payload.InvalidDeposit.reason}`);
        if (payload && "QuarantinedDeposit" in payload && payload.QuarantinedDeposit.event_source.transaction_hash.toLowerCase() === transactionHash) throw new Error("Minter quarantined this exact deposit");
      }
      if (acceptedEvent && accepted && "AcceptedDeposit" in accepted) {
        const deposit = accepted.AcceptedDeposit;
        last = `AcceptedDeposit at event ${acceptedEvent.index}; awaiting MintedCkEth`;
        const mintEvent = events.find((event) => event.payload[0] && "MintedCkEth" in event.payload[0] && event.payload[0].MintedCkEth.event_source.transaction_hash.toLowerCase() === transactionHash && event.payload[0].MintedCkEth.event_source.log_index === deposit.log_index);
        const mint = mintEvent?.payload[0];
        if (mintEvent && mint && "MintedCkEth" in mint) {
          const mintBlock = mint.MintedCkEth.mint_block_index;
          const blocks = await ledger.icrc3_get_blocks([{ start: mintBlock, length: 1n }]);
          if (blocks.blocks.length !== 1 || blocks.blocks[0]!.id !== mintBlock) throw new Error("The real ledger did not return the minter's exact mint block");
          const ledgerBlock = verifyMintBlock(blocks.blocks[0]!, deposit);
          await verifyEthereumDeposit(transactionHash, deposit);
          return {
            accepted: { transactionHash, logIndex: String(deposit.log_index), blockNumber: String(deposit.block_number), fromAddress: getAddress(deposit.from_address), amount: String(deposit.value), recipient: deposit.principal.toText(), subaccount: canonicalSubaccount(deposit.subaccount[0]), eventIndex: String(acceptedEvent.index), timestampNs: String(acceptedEvent.timestamp) },
            minted: { transactionHash, logIndex: String(deposit.log_index), ledgerBlockIndex: String(mintBlock), eventIndex: String(mintEvent.index), timestampNs: String(mintEvent.timestamp) },
            ledgerBlock,
          };
        }
      }
      await delay(2_000);
    } while (Date.now() < deadline);
    throw new Error(`Real ckETH protocol did not mint ${transactionHash} within five minutes: ${last}`);
  }
  async function verifyEthereumDeposit(hash: string, deposit: Deposit): Promise<void> {
    const [transaction, receipt] = await Promise.all([
      chain.rpc<{ hash: string; from: string; to: string; value: string; input: string; blockNumber: string }>("eth_getTransactionByHash", [hash]),
      chain.rpc<{ transactionHash: string; status: string; blockNumber: string; logs: { address: string; transactionHash: string; logIndex: string; data: string; topics: string[] }[] }>("eth_getTransactionReceipt", [hash]),
    ]);
    if (!transaction || !receipt || receipt.status !== "0x1" || checkedHash(transaction.hash) !== hash || checkedHash(receipt.transactionHash) !== hash || getAddress(transaction.to) !== helperAddress || getAddress(transaction.from) !== getAddress(deposit.from_address) || BigInt(transaction.value) !== deposit.value || BigInt(transaction.blockNumber) !== deposit.block_number || BigInt(receipt.blockNumber) !== deposit.block_number) throw new Error("Actual Ethereum transaction/receipt does not match the minter acceptance");
    const recipient = principalWord(deposit.principal);
    if (transaction.input.toLowerCase() !== helperAbi.encodeFunctionData("deposit", [recipient]).toLowerCase() || canonicalSubaccount(deposit.subaccount[0]) !== null) throw new Error("The legacy helper recipient calldata differs from the minter acceptance");
    const log = receipt.logs.find((entry) => BigInt(entry.logIndex) === deposit.log_index && getAddress(entry.address) === helperAddress && checkedHash(entry.transactionHash) === hash);
    const parsed = log && helperAbi.parseLog(log);
    if (!parsed || parsed.name !== "ReceivedEth" || getAddress(parsed.args[0]) !== getAddress(deposit.from_address) || BigInt(parsed.args[1]) !== deposit.value || parsed.args[2].toLowerCase() !== recipient) throw new Error("The exact Ethereum helper log differs from the minter acceptance");
  }
  async function advanceUntilWithdrawal(burnIndex: string | bigint, recipient: string): Promise<IcWalletWithdrawalEvidence> {
    const index = BigInt(burnIndex);
    if (index < 0n || index > (1n << 64n) - 1n) throw new Error("Invalid withdrawal burn block index");
    const target = getAddress(recipient);
    const blocks = await ledger.icrc3_get_blocks([{ start: index, length: 1n }]);
    if (blocks.blocks.length !== 1 || blocks.blocks[0]!.id !== index) throw new Error("The real ledger did not return the withdrawal burn block");
    const tx = fields(fields(blocks.blocks[0]!.block).get("tx")!);
    const op = tx.get("op"), amount = tx.get("amt"), from = tx.get("from");
    if (!op || !("Text" in op) || op.Text !== "burn" || !amount || !("Nat" in amount) || !from || !("Array" in from) || !from.Array.length || from.Array.length > 2 || !("Blob" in from.Array[0]!)) throw new Error("The requested ledger block is not a real withdrawal burn");
    const subaccount = from.Array[1];
    if (subaccount && !("Blob" in subaccount)) throw new Error("Withdrawal burn has invalid subaccount");
    const burn: IcWalletWithdrawalEvidence["burn"] = { index: String(index), kind: "burn", amount: String(amount.Nat), owner: Principal.fromUint8Array(from.Array[0].Blob).toText(), subaccount: canonicalSubaccount(subaccount?.Blob) };
    const finalized = new Set<string>();
    let last = "Pending";
    // Pinned minter a47e543 processes withdrawals every six minutes, then
    // retries pending finalization after three minutes. Allow both timers.
    const deadline = Date.now() + 720_000;
    do {
      const status = await minter.retrieve_eth_status(index);
      last = Object.keys(status)[0]!;
      if ("TxSent" in status) {
        const hash = checkedHash(status.TxSent.transaction_hash);
        if (!finalized.has(hash)) {
          // The pinned minter exposes TxSent immediately after signing, before
          // broadcast completes. Advance finality only after this hash is mined.
          const receipt = await chain.rpc<{ transactionHash: string; blockNumber: string | null } | null>("eth_getTransactionReceipt", [hash]);
          if (receipt?.blockNumber != null) {
            if (checkedHash(receipt.transactionHash) !== hash) throw new Error("Withdrawal receipt identifies a different transaction");
            const receiptBlock = BigInt(receipt.blockNumber);
            await chain.rpc("anvil_mine", ["0x80"]);
            const finalizedBlock = await chain.rpc<{ number: string | null } | null>("eth_getBlockByNumber", ["finalized", false]);
            if (finalizedBlock?.number != null && BigInt(finalizedBlock.number) >= receiptBlock) finalized.add(hash);
          }
        }
      }
      if ("TxFinalized" in status) {
        const result = status.TxFinalized;
        if (!("Success" in result)) throw new Error(`Real withdrawal did not succeed: ${JSON.stringify(result, bigintJson)}`);
        const transaction = await chain.evidence(result.Success.transaction_hash);
        if (getAddress(transaction.to) !== target || getAddress(transaction.from) !== minterAddress || BigInt(transaction.valueWei) <= 0n || BigInt(transaction.valueWei) > amount.Nat) throw new Error("Finalized minter transaction differs from the real withdrawal recipient or burn amount");
        const signedTransaction = Transaction.from(transaction.raw);
        // Pinned minter state/transactions/mod.rs:create_transaction deducts
        // maximum gas cost from the burn; replacements preserve that total.
        // Unused maximum gas stays with the minter, so actual gas is not enough.
        if (signedTransaction.data !== "0x" || signedTransaction.maxFeePerGas === null || amount.Nat !== signedTransaction.value + signedTransaction.gasLimit * signedTransaction.maxFeePerGas) throw new Error("The withdrawal burn does not equal the signed native payout plus its maximum gas cost");
        const effectiveFee = BigInt(transaction.gasUsed) * BigInt(transaction.effectiveGasPriceWei);
        if (result.Success.effective_transaction_fee[0] !== undefined && result.Success.effective_transaction_fee[0] !== effectiveFee) throw new Error("Minter fee disagrees with the actual Ethereum receipt");
        return { burn, transaction, minterStatus: "TxFinalized.Success", effectiveTransactionFeeWei: result.Success.effective_transaction_fee[0]?.toString() ?? null, recipientBalanceWei: String(await chain.balance(target)) };
      }
      await delay(2_000);
    } while (Date.now() < deadline);
    throw new Error(`Real withdrawal ${index} did not finalize within twelve minutes: ${last}`);
  }

  let donorDepositHash: string | null = null;
  const donorBalance = await ckethBalance(donor.getPrincipal());
  if (options.fundDonor !== false && donorBalance < DONOR_TARGET) {
    const accounts = await chain.rpc<string[]>("eth_accounts");
    if (!accounts[0]) throw new Error("Local Anvil has no unlocked fixture donor");
    donorDepositHash = checkedHash(await chain.rpc<string>("eth_sendTransaction", [{ from: getAddress(accounts[0]), to: helperAddress, value: `0x${(DONOR_TARGET - donorBalance).toString(16)}`, data: helperAbi.encodeFunctionData("deposit", [principalWord(donor.getPrincipal())]), gas: "0x30d40" }]));
    const evidence = await advanceUntilMint(donorDepositHash);
    if (evidence.ledgerBlock.recipient !== donor.getPrincipal().toText() || await ckethBalance(donor.getPrincipal()) !== DONOR_TARGET) throw new Error("Real helper deposit did not fund the IC donor exactly");
  }

  return {
    ckethLedger: CKETH_LEDGER, ckethMinter: CKETH_MINTER, helperAddress, donorDepositHash, ckethBalance, ckethFee: () => ledger.icrc1_fee(), ckethAllowance, advanceUntilMint, advanceUntilWithdrawal,
    async walletBridge(id) {
      if (!/^[0-9a-f]{32}$/u.test(id)) throw new Error("Invalid Wallet bridge ID");
      const result = await wallet.app_wallet__wallet_bridge_status_v1(Uint8Array.from(Buffer.from(id, "hex")));
      if ("err" in result) throw new Error(`Wallet bridge query: ${result.err}`);
      return normalizeBridge(result.ok);
    },
    async refreshWalletBridge(id) {
      if (!/^[0-9a-f]{32}$/u.test(id)) throw new Error("Invalid Wallet bridge ID");
      const result = await wallet.app_wallet__wallet_bridge_refresh_v1({ id: Uint8Array.from(Buffer.from(id, "hex")), event_page_length: 100n });
      if ("err" in result) throw new Error(`Wallet bridge refresh: ${result.err}`);
      return normalizeBridge(result.ok);
    },
    async walletTransferForBurn(burnIndex, ledgerId = CKETH_LEDGER) {
      const index = BigInt(burnIndex);
      const records = await wallet.app_wallet__wallet_transfers_pending_v2(null);
      const matches = records.filter((record) => record.ledger.toText() === ledgerId && record.native && "succeeded" in record.status && record.status.succeeded.block_index === index);
      if (matches.length !== 1) throw new Error(`Expected one durable Wallet operation for burn ${index}, found ${matches.length}`);
      return normalizeTransfer(matches[0]!);
    },
    async walletTransfer(requestId) {
      if (!/^[0-9a-f]{32}$/u.test(requestId)) throw new Error("Invalid Wallet transfer ID");
      const result = await wallet.app_wallet__wallet_transfer_status_v2(Uint8Array.from(Buffer.from(requestId, "hex")));
      if ("err" in result) throw new Error(`Wallet transfer query: ${result.err}`);
      return normalizeTransfer(result.ok);
    },
    async pauseMinter() {
      let stopped = false;
      const resume = async () => {
        if (!stopped) return;
        await management.start_canister({ canister_id: minterPrincipal });
        stopped = false;
      };
      // If the stop response itself is lost, attempt to restart before failing.
      stopped = true;
      try { await management.stop_canister({ canister_id: minterPrincipal }); }
      catch (error) { await resume(); throw error; }
      return resume; // The caller must invoke this in finally.
    },
    async unrelatedTransfer(owner, amount) {
      if (amount <= 0n) throw new Error("Unrelated transfer amount must be positive");
      const before = await ckethBalance(owner);
      const fee = await ledger.icrc1_fee();
      if (await ckethBalance(donor.getPrincipal()) < amount + fee) throw new Error("The protocol-funded donor has insufficient ckETH");
      const result = await ledger.icrc1_transfer({ to: account(owner), amount, fee: [fee], from_subaccount: [], memo: [new Uint8Array(randomBytes(16))], created_at_time: [] });
      if ("Err" in result) throw new Error(`Real unrelated ICRC transfer failed: ${JSON.stringify(result.Err, bigintJson)}`);
      const balanceDelta = await ckethBalance(owner) - before;
      if (balanceDelta !== amount) throw new Error("Unrelated ICRC transfer did not increase the recipient balance exactly");
      return { blockIndex: result.Ok, balanceDelta };
    },
  };
}

async function assertIsolatedRuntime(runtime: LocalNeutronRuntime): Promise<void> {
  if (!["evm-wallet-local.ndeploy.session.json", "evm-wallet-erc20-local.ndeploy.session.json"].includes(path.basename(runtime.sessionPath))) throw new Error("ckETH qualification requires the dedicated EVM Wallet session");
  for (const value of [runtime.gatewayUrl, runtime.controlUrl]) {
    const url = new URL(value);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname) || url.username || url.password) throw new Error("ckETH qualification requires loopback PocketIC endpoints");
  }
  const journal = JSON.parse(await readFile(runtime.sessionPath, "utf8"));
  if (journal.runtime?.kind !== "pocketic" || journal.runtime.profile !== "full_protocol_fixtures" || journal.runtime.instanceId !== runtime.instanceId || journal.runtime.controlUrl !== runtime.controlUrl || journal.runtime.gateway?.url !== runtime.gatewayUrl || journal.runtime.fixtures?.cketh_minter !== CKETH_MINTER || journal.runtime.fixtures?.cketh_ledger !== CKETH_LEDGER || !journal.localFleet?.nodes?.some((node: { canisterId: string }) => node.canisterId === runtime.canisterId)) throw new Error("The runtime descriptor does not identify the completed isolated full-protocol fixture");
}
function seededIdentity(domain: string) { return Ed25519KeyIdentity.generate(new Uint8Array(createHash("sha256").update(domain).digest())); }
function account(owner: string | Principal): Account { return { owner: typeof owner === "string" ? Principal.fromText(owner) : owner, subaccount: [] }; }
function checkedHash(hash: string): string { if (!/^0x[0-9a-f]{64}$/iu.test(hash)) throw new Error("Invalid transaction hash"); return hash.toLowerCase(); }
function bigintJson(_key: string, value: unknown): unknown { return typeof value === "bigint" ? value.toString() : value; }
function principalWord(principal: Principal): string { const value = new Uint8Array(32); value[0] = principal.toUint8Array().length; value.set(principal.toUint8Array(), 1); return `0x${Buffer.from(value).toString("hex")}`; }
function canonicalSubaccount(bytes?: Uint8Array): string | null { return !bytes || bytes.every((byte) => byte === 0) ? null : Buffer.from(bytes).toString("hex"); }
function fields(value: IcrcValue): Map<string, IcrcValue> { if (!("Map" in value)) throw new Error("ICRC3 block must contain a map"); const result = new Map(value.Map); if (result.size !== value.Map.length) throw new Error("Ambiguous duplicate ICRC3 fields"); return result; }
export function verifyMintBlock(block: { id: bigint; block: IcrcValue }, deposit: Deposit): IcWalletMintEvidence["ledgerBlock"] {
  const root = fields(block.block);
  const tx = fields(root.get("tx")!);
  const kind = root.get("btype");
  const op = tx.get("op");
  if (kind ? !("Text" in kind) || kind.Text !== "1mint" : !op || !("Text" in op) || op.Text !== "mint") throw new Error("The minter block is not an ICRC mint");
  const amount = tx.get("amt");
  const to = tx.get("to");
  if (!amount || !("Nat" in amount) || amount.Nat !== deposit.value || !to || !("Array" in to) || to.Array.length < 1 || to.Array.length > 2 || !("Blob" in to.Array[0]!)) throw new Error("The exact ledger mint has incorrect amount or recipient");
  const owner = Principal.fromUint8Array(to.Array[0].Blob).toText();
  const subaccountValue = to.Array[1];
  if (subaccountValue && !("Blob" in subaccountValue)) throw new Error("The ledger mint has an invalid subaccount");
  const subaccount = canonicalSubaccount(subaccountValue?.Blob);
  if (owner !== deposit.principal.toText() || subaccount !== canonicalSubaccount(deposit.subaccount[0])) throw new Error("The exact ledger mint recipient differs from the Ethereum deposit");
  return { index: String(block.id), kind: "mint", amount: String(amount.Nat), recipient: owner, subaccount };
}

type WireIntent = {
  id: Uint8Array; account: string; amount: bigint; revision: bigint; created_at: bigint; updated_at: bigint; event_cursor: bigint;
  source: { external: null } | { evm: null } | { evm_agent: { app_id: string; installation_uid: string } };
  quote: { chain_id: bigint; ledger: Principal; minter: Principal; helper_address: string; helper_mode: { legacy: null } | { subaccount: null }; minter_address: string; token_address: Opt<string>; recipient: Principal; principal_word: string; subaccount_word: string };
  steps: { kind: Record<BridgeStep["kind"], null>; state: Record<BridgeStep["state"], null>; operation_id: Opt<string>; transaction_hash: Opt<string>; error: Opt<string> }[];
  accepted_deposit: Opt<{ log_index: bigint; block_number: bigint; event_index: bigint }>;
  mint: Opt<{ ledger_block_index: bigint; event_index: bigint; verified_ledger: boolean }>; error: Opt<string>;
};
type WireTransfer = {
  request_id: Uint8Array; ledger: Principal; amount: bigint; destination: string; native: boolean;
  status: { pending: null } | { rejected: string } | { succeeded: { block_index: bigint } };
  settlement: Opt<{ status: { pending: string } | { submitted: { transaction_hash: string } } | { confirmed: { transaction_hash: string } } | { failed: string } | { unknown: string } }>;
};
function normalizeTransfer(record: WireTransfer): IcWalletTransferEvidence {
  const status = "succeeded" in record.status ? "succeeded" : "rejected" in record.status ? "rejected" : "pending";
  const settlement = record.settlement[0]?.status;
  return {
    requestId: Buffer.from(record.request_id).toString("hex"), ledger: record.ledger.toText(), amount: String(record.amount), destination: record.destination, native: record.native, status,
    blockIndex: "succeeded" in record.status ? String(record.status.succeeded.block_index) : null,
    settlement: settlement ? { status: Object.keys(settlement)[0] as NonNullable<IcWalletTransferEvidence["settlement"]>["status"], transactionHash: "confirmed" in settlement ? settlement.confirmed.transaction_hash : "submitted" in settlement ? settlement.submitted.transaction_hash : null } : null,
  };
}
function normalizeBridge(record: WireIntent): BridgeIntent {
  const q = record.quote;
  if (q.chain_id !== 1n) throw new Error("Bridge is not on the qualified Ethereum chain");
  const source: BridgeSource = "evm_agent" in record.source ? { appId: record.source.evm_agent.app_id, installationUid: record.source.evm_agent.installation_uid } : "evm" in record.source ? "evm" : "external";
  const accepted = record.accepted_deposit[0];
  const mint = record.mint[0];
  return {
    id: Buffer.from(record.id).toString("hex"), source, account: getAddress(record.account), amount: String(record.amount), revision: String(record.revision), createdAt: String(record.created_at), updatedAt: String(record.updated_at), eventCursor: String(record.event_cursor),
    quote: { chainId: "1", ledger: q.ledger.toText(), minter: q.minter.toText(), helperAddress: getAddress(q.helper_address), helperMode: "legacy" in q.helper_mode ? "legacy" : "subaccount", minterAddress: getAddress(q.minter_address), tokenAddress: q.token_address[0] ?? null, recipient: q.recipient.toText(), principalWord: q.principal_word, subaccountWord: q.subaccount_word },
    steps: record.steps.map((step) => ({ kind: Object.keys(step.kind)[0] as BridgeStep["kind"], state: Object.keys(step.state)[0] as BridgeStep["state"], operationId: step.operation_id[0] ?? null, transactionHash: (step.transaction_hash[0] as `0x${string}` | undefined) ?? null, error: step.error[0] ?? null })),
    acceptedDeposit: accepted ? { logIndex: String(accepted.log_index), blockNumber: String(accepted.block_number), eventIndex: String(accepted.event_index) } : null,
    mint: mint ? { ledgerBlockIndex: String(mint.ledger_block_index), eventIndex: String(mint.event_index), verifiedLedger: mint.verified_ledger } : null, error: record.error[0] ?? null,
  };
}

export const minterIdl: IDL.InterfaceFactory = ({ IDL }) => {
  const source = IDL.Record({ transaction_hash: IDL.Text, log_index: IDL.Nat });
  const payload = IDL.Variant({
    AcceptedDeposit: IDL.Record({ transaction_hash: IDL.Text, log_index: IDL.Nat, block_number: IDL.Nat, from_address: IDL.Text, value: IDL.Nat, principal: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) }),
    MintedCkEth: IDL.Record({ event_source: source, mint_block_index: IDL.Nat }),
    InvalidDeposit: IDL.Record({ event_source: source, reason: IDL.Text }), QuarantinedDeposit: IDL.Record({ event_source: source }),
  });
  return IDL.Service({
    get_minter_info: IDL.Func([], [IDL.Record({ minter_address: IDL.Opt(IDL.Text), smart_contract_address: IDL.Opt(IDL.Text), eth_helper_contract_address: IDL.Opt(IDL.Text), cketh_ledger_id: IDL.Opt(IDL.Principal) })], ["query"]),
    // Opt projection deliberately preserves forward compatibility with the
    // released minter's other event variants; no fake event service is used.
    get_events: IDL.Func([IDL.Record({ start: IDL.Nat64, length: IDL.Nat64 })], [IDL.Record({ events: IDL.Vec(IDL.Record({ timestamp: IDL.Nat64, payload: IDL.Opt(payload) })), total_event_count: IDL.Nat64 })], ["query"]),
    retrieve_eth_status: IDL.Func([IDL.Nat64], [IDL.Variant({ NotFound: IDL.Null, Pending: IDL.Null, TxCreated: IDL.Null, TxSent: IDL.Record({ transaction_hash: IDL.Text }), TxFinalized: IDL.Variant({ Success: IDL.Record({ transaction_hash: IDL.Text, effective_transaction_fee: IDL.Opt(IDL.Nat) }), Reimbursed: IDL.Record({ transaction_hash: IDL.Text, reimbursed_amount: IDL.Nat, reimbursed_in_block: IDL.Nat }), PendingReimbursement: IDL.Record({ transaction_hash: IDL.Text }) }) })], []),
  });
};
export const ledgerIdl: IDL.InterfaceFactory = ({ IDL }) => {
  const account = IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) });
  const value = IDL.Rec(); value.fill(IDL.Variant({ Blob: IDL.Vec(IDL.Nat8), Text: IDL.Text, Nat: IDL.Nat, Int: IDL.Int, Array: IDL.Vec(value), Map: IDL.Vec(IDL.Tuple(IDL.Text, value)) }));
  const error = IDL.Variant({ BadFee: IDL.Record({ expected_fee: IDL.Nat }), BadBurn: IDL.Record({ min_burn_amount: IDL.Nat }), InsufficientFunds: IDL.Record({ balance: IDL.Nat }), TooOld: IDL.Null, CreatedInFuture: IDL.Record({ ledger_time: IDL.Nat64 }), TemporarilyUnavailable: IDL.Null, Duplicate: IDL.Record({ duplicate_of: IDL.Nat }), GenericError: IDL.Record({ error_code: IDL.Nat, message: IDL.Text }) });
  return IDL.Service({
    icrc1_balance_of: IDL.Func([account], [IDL.Nat], ["query"]), icrc1_fee: IDL.Func([], [IDL.Nat], ["query"]),
    icrc1_minting_account: IDL.Func([], [IDL.Opt(account)], ["query"]),
    icrc2_allowance: IDL.Func([IDL.Record({ account, spender: account })], [IDL.Record({ allowance: IDL.Nat })], ["query"]),
    icrc1_transfer: IDL.Func([IDL.Record({ to: account, amount: IDL.Nat, fee: IDL.Opt(IDL.Nat), from_subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)), memo: IDL.Opt(IDL.Vec(IDL.Nat8)), created_at_time: IDL.Opt(IDL.Nat64) })], [IDL.Variant({ Ok: IDL.Nat, Err: error })], []),
    icrc3_get_blocks: IDL.Func([IDL.Vec(IDL.Record({ start: IDL.Nat, length: IDL.Nat }))], [IDL.Record({ blocks: IDL.Vec(IDL.Record({ id: IDL.Nat, block: value })) })], ["query"]),
  });
};
const managementIdl: IDL.InterfaceFactory = ({ IDL }) => {
  const request = IDL.Record({ canister_id: IDL.Principal });
  return IDL.Service({
    canister_status: IDL.Func([request], [IDL.Record({ status: IDL.Variant({ running: IDL.Null, stopped: IDL.Null, stopping: IDL.Null }), settings: IDL.Record({ controllers: IDL.Vec(IDL.Principal) }), module_hash: IDL.Opt(IDL.Vec(IDL.Nat8)) })], []),
    stop_canister: IDL.Func([request], [], []), start_canister: IDL.Func([request], [], []),
  });
};
const walletIdl: IDL.InterfaceFactory = ({ IDL }) => {
  const quote = IDL.Record({ chain_id: IDL.Nat, ledger: IDL.Principal, minter: IDL.Principal, helper_address: IDL.Text, helper_mode: IDL.Variant({ legacy: IDL.Null, subaccount: IDL.Null }), minter_address: IDL.Text, token_address: IDL.Opt(IDL.Text), recipient: IDL.Principal, principal_word: IDL.Text, subaccount_word: IDL.Text });
  const step = IDL.Record({ kind: IDL.Variant({ reset_approval: IDL.Null, approval: IDL.Null, deposit: IDL.Null }), state: IDL.Variant({ ready: IDL.Null, unknown: IDL.Null, submitted: IDL.Null, confirmed: IDL.Null, failed: IDL.Null }), operation_id: IDL.Opt(IDL.Text), transaction_hash: IDL.Opt(IDL.Text), error: IDL.Opt(IDL.Text) });
  const intent = IDL.Record({ id: IDL.Vec(IDL.Nat8), quote, source: IDL.Variant({ external: IDL.Null, evm: IDL.Null, evm_agent: IDL.Record({ app_id: IDL.Text, installation_uid: IDL.Text }) }), account: IDL.Text, amount: IDL.Nat, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)), steps: IDL.Vec(step), revision: IDL.Nat, created_at: IDL.Int, updated_at: IDL.Int, event_cursor: IDL.Nat64, accepted_deposit: IDL.Opt(IDL.Record({ log_index: IDL.Nat, block_number: IDL.Nat, event_index: IDL.Nat64 })), mint: IDL.Opt(IDL.Record({ ledger_block_index: IDL.Nat, event_index: IDL.Nat64, verified_ledger: IDL.Bool })), error: IDL.Opt(IDL.Text) });
  const result = IDL.Variant({ ok: intent, err: IDL.Text });
  const settlement = IDL.Record({ status: IDL.Variant({ pending: IDL.Text, submitted: IDL.Record({ transaction_hash: IDL.Text }), confirmed: IDL.Record({ transaction_hash: IDL.Text }), failed: IDL.Text, unknown: IDL.Text }) });
  const transfer = IDL.Record({ request_id: IDL.Vec(IDL.Nat8), ledger: IDL.Principal, amount: IDL.Nat, destination: IDL.Text, native: IDL.Bool, status: IDL.Variant({ pending: IDL.Null, rejected: IDL.Text, succeeded: IDL.Record({ block_index: IDL.Nat }) }), settlement: IDL.Opt(settlement) });
  return IDL.Service({
    app_wallet__wallet_bridge_status_v1: IDL.Func([IDL.Vec(IDL.Nat8)], [result], ["query"]),
    app_wallet__wallet_bridge_refresh_v1: IDL.Func([IDL.Record({ id: IDL.Vec(IDL.Nat8), event_page_length: IDL.Nat64 })], [result], []),
    app_wallet__wallet_transfers_pending_v2: IDL.Func([IDL.Null], [IDL.Vec(transfer)], ["query"]),
    app_wallet__wallet_transfer_status_v2: IDL.Func([IDL.Vec(IDL.Nat8)], [IDL.Variant({ ok: transfer, err: IDL.Text })], ["query"]),
  });
};
