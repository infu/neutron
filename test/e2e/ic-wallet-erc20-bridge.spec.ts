import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { expect, test, type FrameLocator, type Locator, type Page, type TestInfo } from "@playwright/test";
import { getAddress, Interface, parseEther, parseUnits, Transaction } from "ethers";
import { Principal } from "@dfinity/principal";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
import { resolveLocalNeutronRuntime, type LocalNeutronRuntime } from "../../packages/neutron-provision/src/local_session.ts";
import type { BridgeIntent, BridgeStep } from "../../apps/wallet/src/bridge.ts";
import type { EvmDemoRecord } from "../../apps/kitchensink/src/evm_wallet_demo.ts";
import {
  allowEvmInspectionGrantsUntil, expectNoEvmKernelDialogs,
  installEvmWalletBrowserFaults, readEvmWalletFault, setEvmWalletFault,
  startEvmKernelDialogAudit,
} from "./fixtures/evm-wallet-browser.ts";
import { createLocalEvmChain, type LocalEvmChain, type LocalEvmTransactionEvidence } from "./fixtures/evm-wallet-chain.ts";
import { createIcWalletErc20Fixture } from "./fixtures/ic-wallet-erc20-bridge.ts";

// This deployment initializes its ERC20 ledgers with the official minter as
// minting account. It never replaces a ledger in an existing Neutron fixture.
// Every approval below uses the installed EVM Wallet and chain-key signer.
test.describe.configure({ retries: 0 });
test.beforeEach(({ page }) => { page.setDefaultTimeout(20_000); });
test.skip(
  path.basename(process.env.NEUTRON_NDEPLOY_CONFIG ?? "") !== "evm-wallet-erc20-local.ndeploy.json",
  "Requires the dedicated disposable ckERC20 PocketIC/Anvil deployment",
);

const EVM_FRAME = 'iframe[data-app-id="evm_wallet"][data-tile-id="evm_wallet"]';
const DEPOSIT_AMOUNT = "20";
const DEPOSIT_ATOMS = parseUnits(DEPOSIT_AMOUNT, 6);
const REDEEM_AMOUNT = "5";
const REDEEM_ATOMS = parseUnits(REDEEM_AMOUNT, 6);
const SEEDED_ALLOWANCE = parseUnits("1", 6);
const erc20 = new Interface(["function approve(address spender,uint256 amount) returns (bool)"]);

test("ckUSDC resets an existing allowance, recovers a lost approval reply, mints exactly, and redeems with quoted ckETH gas", async ({ page }, testInfo) => {
  test.setTimeout(1_800_000);
  const runtime = resolveLocalNeutronRuntime();
  const config = JSON.parse(await readFile(process.env.NEUTRON_NDEPLOY_CONFIG!, "utf8"));
  const archives = await Promise.all([config.artifacts.kernel, ...config.artifacts.packages].map(async (artifact: { path: string }) => {
    const bytes = await readFile(artifact.path);
    return { path: artifact.path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }));
  const installed = await installedErc20Evidence(runtime, archives);
  await saveEvidence(testInfo, "ckusdc-selected-local-archives", { body: json({ canisterId: runtime.canisterId, sessionPath: runtime.sessionPath, archives, installed }), contentType: "application/json" });
  const chain = await createLocalEvmChain();
  const protocol = await createIcWalletErc20Fixture(runtime);
  const token = protocol.token;
  expect(token.symbol).toBe("ckUSDC");
  await installEvmWalletBrowserFaults(page, ["evm_wallet", "kitchensink", "wallet"]);
  await page.addInitScript(() => {
    if (!/^\/app\/wallet\//u.test(location.pathname)) return;
    for (const key of ["localStorage", "sessionStorage"]) {
      Object.defineProperty(window, key, { configurable: true, get() { throw new DOMException("Storage blocked for ckUSDC qualification", "SecurityError"); } });
    }
  });
  await openNeutron(page, runtime);
  const evmWallet = await openApp(page, "evm_wallet", "evm_wallet");
  await expect(evmWallet.getByTestId("evm-account-address")).toHaveText(/^0x[0-9a-f]{40}$/iu, { timeout: 120_000 });
  const address = getAddress((await evmWallet.getByTestId("evm-account-address").textContent())!);
  await chain.fund(address);
  await protocol.mintTokenToEvm(address, parseUnits("100", 6));
  const seed = await seedAllowance(page, evmWallet, token.address, token.helperAddress, address, chain);
  expect(await protocol.helperAllowance(address)).toBe(SEEDED_ALLOWANCE);
  const seedTransaction = await minedTransactionEvidence(chain, seed.progress[0]!.operation!.transactionHash!);
  assertTransaction(seedTransaction, address, token.address, erc20.encodeFunctionData("approve", [token.helperAddress, SEEDED_ALLOWANCE]));
  expect(seed.progress[1]!.attempted).toBe(false);
  expect(seed.progress[1]!.operation).toBeNull();

  let wallet = await openApp(page, "wallet", "wallet");
  await configureTokens(page, wallet, [protocol.ckethLedger, token.ledger]);
  await openDeposit(wallet, token.ledger);
  const savedDeposits = wallet.getByRole("combobox", { name: "Saved deposits", exact: true });
  if (await savedDeposits.count()) await savedDeposits.selectOption("");
  await wallet.getByRole("combobox", { name: "Deposit source", exact: true }).selectOption("evm");
  await wallet.getByLabel("Amount of ckUSDC to deposit", { exact: true }).fill(DEPOSIT_AMOUNT);
  const before = {
    nonce: await chain.nonce(address), tokenBalance: await protocol.tokenBalance(runtime.canisterId),
    evmTokenBalance: await protocol.evmTokenBalance(address), allowance: await protocol.helperAllowance(address),
  };
  await wallet.getByRole("button", { name: "Deposit with EVM Wallet", exact: true }).click();
  await allowEvmInspectionGrantsUntil(page, () => evmWallet.getByTestId("evm-review").isVisible());
  const id = await wallet.getByRole("combobox", { name: "Saved deposits", exact: true }).inputValue();
  expect(id).toMatch(/^[0-9a-f]{32}$/u);
  const prepared = await protocol.walletBridge(id);
  expect(prepared).toMatchObject({ source: "evm", amount: DEPOSIT_ATOMS.toString() });
  expect(prepared.account.toLowerCase()).toBe(address.toLowerCase());
  expect(prepared.quote).toMatchObject({ chainId: "1", ledger: token.ledger, minter: protocol.ckethMinter, recipient: runtime.canisterId });
  expect(prepared.quote.tokenAddress?.toLowerCase()).toBe(token.address.toLowerCase());
  expect(prepared.quote.helperAddress.toLowerCase()).toBe(token.helperAddress.toLowerCase());
  expect(prepared.quote.principalWord.toLowerCase()).toBe(principalWord(runtime.canisterId));
  expect(prepared.quote.subaccountWord).toBe(`0x${"0".repeat(64)}`);
  const resetRequest = step(prepared, "reset_approval").operationId;
  expect(step(prepared, "reset_approval")).toMatchObject({ state: "unknown", transactionHash: null });
  expect(step(prepared, "approval")).toMatchObject({ state: "ready", operationId: null, transactionHash: null });
  expect(step(prepared, "deposit")).toMatchObject({ state: "ready", operationId: null, transactionHash: null });
  await expectTransactionReview(evmWallet, resetRequest!, token.address, address);
  await expect(wallet.getByLabel("Amount of ckUSDC to deposit", { exact: true })).toHaveCount(0);
  await saveEvidence(testInfo, "ckusdc-reset-approval-review", { body: await page.screenshot(), contentType: "image/png" });
  await startEvmKernelDialogAudit(page);
  await evmWallet.getByTestId("evm-review-approve").click();
  await expect.poll(async () => (await protocol.walletBridge(id)).steps.find((entry) => entry.kind === "approval")?.operationId, { timeout: 180_000 }).toMatch(/^[0-9a-f]{32}$/u);
  const resetCompleted = await protocol.walletBridge(id);
  const reset = step(resetCompleted, "reset_approval");
  const approvalRequest = step(resetCompleted, "approval").operationId!;
  expect(reset).toMatchObject({ state: "confirmed", operationId: resetRequest });
  expect(reset.transactionHash).toMatch(/^0x[0-9a-f]{64}$/iu);
  expect(approvalRequest).not.toBe(resetRequest);
  await expectTransactionReview(evmWallet, approvalRequest, token.address, address);
  expect(await protocol.helperAllowance(address)).toBe(0n);
  expect(await chain.nonce(address)).toBe(before.nonce + 1n);
  const resetTransaction = await minedTransactionEvidence(chain, reset.transactionHash!);
  assertTransaction(resetTransaction, address, token.address, erc20.encodeFunctionData("approve", [token.helperAddress, 0n]));
  expect(BigInt(resetTransaction.nonce)).toBe(before.nonce);

  // Lose the actual successful approval reply, after its signed transaction
  // has landed. The reset remains complete and deposit remains undispatched.
  await setEvmWalletFault(wallet, "dropNextTransactionReply");
  await evmWallet.getByTestId("evm-review-approve").click();
  await expect.poll(async () => (await readEvmWalletFault(wallet)).droppedReply !== null, { timeout: 180_000 }).toBe(true);
  const dropped = (await readEvmWalletFault(wallet)).droppedReply!;
  expect(dropped.requestId).toBe(approvalRequest);
  expect(dropped.chainId).toBe("1");
  expect(String(dropped.address).toLowerCase()).toBe(address.toLowerCase());
  const approvalHash = String(dropped.transactionHash);
  expect(approvalHash).toMatch(/^0x[0-9a-f]{64}$/iu);
  const approvalTransaction = await minedTransactionEvidence(chain, approvalHash);
  assertTransaction(approvalTransaction, address, token.address, erc20.encodeFunctionData("approve", [token.helperAddress, DEPOSIT_ATOMS]));
  expect(BigInt(approvalTransaction.nonce)).toBe(before.nonce + 1n);
  expect(await protocol.helperAllowance(address)).toBe(DEPOSIT_ATOMS);
  expect(await protocol.evmTokenBalance(address)).toBe(before.evmTokenBalance);
  expect(await chain.nonce(address)).toBe(before.nonce + 2n);
  const interrupted = await protocol.walletBridge(id);
  expect(step(interrupted, "reset_approval")).toEqual(reset);
  expect(step(interrupted, "approval")).toMatchObject({ state: "unknown", operationId: approvalRequest, transactionHash: null });
  expect(step(interrupted, "deposit")).toMatchObject({ state: "ready", operationId: null, transactionHash: null });
  await expect(evmWallet.getByTestId("evm-review")).toHaveCount(0);
  await expectNoEvmKernelDialogs(page);
  await saveEvidence(testInfo, "ckusdc-lost-approval-reply", { body: json({ seed, seedTransaction, before, prepared, resetCompleted, resetTransaction, dropped, approvalTransaction, interrupted }), contentType: "application/json" });

  await page.reload();
  await openNeutron(page, runtime, false);
  wallet = await openApp(page, "wallet", "wallet");
  await openDeposit(wallet, token.ledger);
  await expect(wallet.getByRole("combobox", { name: "Saved deposits", exact: true })).toHaveValue(id);
  expect(await protocol.walletBridge(id)).toEqual(interrupted);
  await wallet.getByRole("button", { name: "Resume saved deposit", exact: true }).click();
  const restoredEvm = page.frameLocator(EVM_FRAME);
  await allowEvmInspectionGrantsUntil(page, () => restoredEvm.getByTestId("evm-review").isVisible());
  const recovered = await protocol.walletBridge(id);
  expect(recovered.quote).toEqual(prepared.quote);
  expect(recovered.account).toBe(prepared.account);
  expect(recovered.amount).toBe(prepared.amount);
  expect(step(recovered, "reset_approval")).toEqual(reset);
  expect(step(recovered, "approval")).toMatchObject({ state: "confirmed", operationId: approvalRequest, transactionHash: approvalHash });
  const depositRequest = step(recovered, "deposit").operationId!;
  expect(new Set([resetRequest, approvalRequest, depositRequest]).size).toBe(3);
  await expectTransactionReview(restoredEvm, depositRequest, token.helperAddress, address);
  expect(await chain.nonce(address)).toBe(before.nonce + 2n);
  expect(await protocol.helperAllowance(address)).toBe(DEPOSIT_ATOMS);
  await saveEvidence(testInfo, "ckusdc-recovered-approval-deposit-review", { body: await page.screenshot(), contentType: "image/png" });
  await startEvmKernelDialogAudit(page);
  await restoredEvm.getByTestId("evm-review-approve").click();
  await expect.poll(async () => step(await protocol.walletBridge(id), "deposit").state, { timeout: 180_000 }).toBe("confirmed");
  const deposited = await protocol.walletBridge(id);
  expect(step(deposited, "reset_approval")).toEqual(reset);
  expect(step(deposited, "approval")).toEqual(step(recovered, "approval"));
  const depositHash = step(deposited, "deposit").transactionHash!;
  const depositTransaction = await minedTransactionEvidence(chain, depositHash);
  assertTransaction(depositTransaction, address, token.helperAddress, expectedDepositData(deposited));
  expect(BigInt(depositTransaction.nonce)).toBe(before.nonce + 2n);
  expect(await chain.nonce(address)).toBe(before.nonce + 3n);
  expect(await protocol.helperAllowance(address)).toBe(0n);
  expect(await protocol.evmTokenBalance(address)).toBe(before.evmTokenBalance - DEPOSIT_ATOMS);
  await expectNoEvmKernelDialogs(page);
  const mint = await protocol.advanceUntilTokenMint(depositHash);
  expect(mint.accepted).toMatchObject({ transactionHash: depositHash, amount: DEPOSIT_ATOMS.toString(), recipient: runtime.canisterId });
  expect(mint.accepted.tokenAddress.toLowerCase()).toBe(token.address.toLowerCase());
  expect(mint.accepted.fromAddress.toLowerCase()).toBe(address.toLowerCase());
  expect(mint.minted.transactionHash).toBe(depositHash);
  expect(mint.minted.logIndex).toBe(mint.accepted.logIndex);
  expect(mint.ledgerBlock).toMatchObject({ index: mint.minted.ledgerBlockIndex, kind: "mint", amount: DEPOSIT_ATOMS.toString(), recipient: runtime.canisterId, subaccount: null });
  await expect(wallet.getByRole("button", { name: "Check deposit and mint", exact: true })).toBeEnabled({ timeout: 120_000 });
  await wallet.getByRole("button", { name: "Check deposit and mint", exact: true }).click();
  await expect(wallet.locator(".wallet-bridge-status")).toContainText(`Mint verified at IC ledger block ${mint.ledgerBlock.index}`, { timeout: 120_000 });
  const completed = await protocol.walletBridge(id);
  expect(completed.acceptedDeposit).toEqual({ logIndex: mint.accepted.logIndex, blockNumber: mint.accepted.blockNumber, eventIndex: mint.accepted.eventIndex });
  expect(completed.mint).toEqual({ ledgerBlockIndex: mint.ledgerBlock.index, eventIndex: mint.minted.eventIndex, verifiedLedger: true });
  expect(await protocol.tokenBalance(runtime.canisterId)).toBe(before.tokenBalance + DEPOSIT_ATOMS);
  expect(await chain.nonce(address)).toBe(before.nonce + 3n);
  await saveEvidence(testInfo, "ckusdc-exact-deposit-mint-and-recovery", { body: json({ recovered, deposited, depositTransaction, mint, completed }), contentType: "application/json" });

  // Gas is real ckETH obtained through the released helper and ledger. Its
  // balance and allowance are independent from the asset ledger's balance.
  const gasFunding = await protocol.unrelatedTransfer(runtime.canisterId, parseEther("0.0008"));
  await qualifyTokenRedemption(page, testInfo, wallet, runtime, protocol, chain, address, prepared.quote.minterAddress, gasFunding);
});

test("complete ckUSDC redemption from the recorded completed deposit after minter fee readiness", async ({ page }, testInfo) => {
  test.setTimeout(1_200_000);
  const depositEvidencePath = process.env.NEUTRON_IC_ERC20_COMPLETED_DEPOSIT_EVIDENCE;
  const existingContact = process.env.NEUTRON_IC_ERC20_REDEMPTION_CONTACT;
  test.skip(!depositEvidencePath || !existingContact, "Requires the saved completed-deposit proof and its existing redemption contact");
  const depositEvidenceBytes = await readFile(depositEvidencePath!);
  const depositEvidence = JSON.parse(depositEvidenceBytes.toString()) as { completed: BridgeIntent; depositTransaction: LocalEvmTransactionEvidence; mint: { ledgerBlock: { index: string } } };
  const runtime = resolveLocalNeutronRuntime();
  const config = JSON.parse(await readFile(process.env.NEUTRON_NDEPLOY_CONFIG!, "utf8"));
  const archives = await Promise.all([config.artifacts.kernel, ...config.artifacts.packages].map(async (artifact: { path: string }) => {
    const bytes = await readFile(artifact.path);
    return { path: artifact.path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }));
  const installed = await installedErc20Evidence(runtime, archives);
  const protocol = await createIcWalletErc20Fixture(runtime, { fundDonor: false });
  const chain = await createLocalEvmChain();
  const completed = await protocol.walletBridge(depositEvidence.completed.id);
  expect(completed).toEqual(depositEvidence.completed);
  expect(completed.mint?.verifiedLedger).toBe(true);
  expect(completed.amount).toBe(DEPOSIT_ATOMS.toString());
  expect(completed.quote.recipient).toBe(runtime.canisterId);
  expect(completed.quote.ledger).toBe(protocol.token.ledger);
  const hash = step(completed, "deposit").transactionHash!;
  const transaction = await minedTransactionEvidence(chain, hash);
  expect(transaction).toEqual(depositEvidence.depositTransaction);
  assertTransaction(transaction, completed.account, protocol.token.helperAddress, expectedDepositData(completed));
  // The interrupted run never submitted Withdraw. These exact balances and
  // nonce reject replaying this continuation after any withdrawal effect.
  expect(await protocol.tokenBalance(runtime.canisterId)).toBe(DEPOSIT_ATOMS);
  expect(await protocol.tokenAllowance(runtime.canisterId)).toBe(0n);
  expect(await protocol.ckethAllowance(runtime.canisterId)).toBe(0n);
  expect(await chain.nonce(completed.account)).toBe(BigInt(transaction.nonce) + 1n);
  await installEvmWalletBrowserFaults(page, ["evm_wallet", "kitchensink", "wallet"]);
  await page.addInitScript(() => {
    if (!/^\/app\/wallet\//u.test(location.pathname)) return;
    for (const key of ["localStorage", "sessionStorage"]) Object.defineProperty(window, key, { configurable: true, get() { throw new DOMException("Storage blocked for ckUSDC qualification", "SecurityError"); } });
  });
  await openNeutron(page, runtime);
  const wallet = await openApp(page, "wallet", "wallet");
  await openApp(page, "evm_wallet", "evm_wallet");
  await openDeposit(wallet, protocol.token.ledger);
  await wallet.getByRole("combobox", { name: "Saved deposits", exact: true }).selectOption(completed.id);
  await expect(wallet.locator(".wallet-bridge-status")).toContainText(`Mint verified at IC ledger block ${completed.mint!.ledgerBlockIndex}`);
  await saveEvidence(testInfo, "ckusdc-redemption-continuation-input", { body: json({ installed, source: { path: depositEvidencePath, sha256: createHash("sha256").update(depositEvidenceBytes).digest("hex") }, completed, transaction, existingContact, noNewDeposit: true, noDonorFunding: true }), contentType: "application/json" });
  await qualifyTokenRedemption(page, testInfo, wallet, runtime, protocol, chain, completed.account, completed.quote.minterAddress, null, existingContact);
});

async function qualifyTokenRedemption(
  page: Page, testInfo: TestInfo, wallet: FrameLocator, runtime: LocalNeutronRuntime,
  protocol: Awaited<ReturnType<typeof createIcWalletErc20Fixture>>, chain: LocalEvmChain,
  address: string, minterAddress: string,
  gasFunding: { blockIndex: bigint; balanceDelta: bigint } | null,
  existingContact?: string,
): Promise<void> {
  const token = protocol.token;
  const beforeRedemption = {
    nonce: await chain.nonce(address), evmTokenBalance: await protocol.evmTokenBalance(address),
    assetBalance: await protocol.tokenBalance(runtime.canisterId), assetFee: await protocol.tokenFee(),
    assetAllowance: await protocol.tokenAllowance(runtime.canisterId),
    gasBalance: await protocol.ckethBalance(runtime.canisterId), gasFee: await protocol.ckethFee(),
    gasAllowance: await protocol.ckethAllowance(runtime.canisterId),
  };
  const requested = await requestTokenRedemption(page, wallet, token.ledger, address, beforeRedemption, existingContact, testInfo);
  const queued = await protocol.walletTransferForBurn(requested.assetBurnIndex);
  expect(queued).toMatchObject({ ledger: token.ledger, amount: REDEEM_ATOMS.toString(), native: true, status: "succeeded", blockIndex: requested.assetBurnIndex });
  expect(queued.destination.toLowerCase()).toBe(address.toLowerCase());
  expect(queued.settlement?.status).not.toBe("confirmed");
  const afterBurn = {
    assetBalance: await protocol.tokenBalance(runtime.canisterId),
    gasBalance: await protocol.ckethBalance(runtime.canisterId),
    assetAllowance: await protocol.tokenAllowance(runtime.canisterId),
    gasAllowance: await protocol.ckethAllowance(runtime.canisterId),
  };
  expect(afterBurn.assetBalance).toBe(beforeRedemption.assetBalance - REDEEM_ATOMS - beforeRedemption.assetFee);
  // The minter can refresh its fee downward after the reviewed quote. The
  // ledger debit includes one separate approval fee; its remaining allowance
  // must be exactly the approved budget minus the amount actually burned.
  // The independent minter event and exact burn block below must prove this
  // balance-derived amount, so a balance change alone never establishes it.
  const observedGasBurn = beforeRedemption.gasBalance - afterBurn.gasBalance - beforeRedemption.gasFee;
  expect(observedGasBurn).toBeGreaterThan(0n);
  expect(observedGasBurn).toBeLessThanOrEqual(requested.gasBudget);
  expect(beforeRedemption.gasBalance - afterBurn.gasBalance).toBeLessThanOrEqual(requested.gasMaximumDebit);
  expect(afterBurn.assetAllowance).toBe(0n);
  expect(afterBurn.gasAllowance).toBe(requested.gasBudget - observedGasBurn);
  await saveEvidence(testInfo, "ckusdc-requested-redemption-and-debits", { body: json({ gasFunding, beforeRedemption, requested, queued, afterBurn, observedGasBurn }), contentType: "application/json" });
  await saveEvidence(testInfo, "ckusdc-native-asset-and-gas-burns", { body: await page.screenshot(), contentType: "image/png" });
  await page.reload();
  await openNeutron(page, runtime, false);
  wallet = await openApp(page, "wallet", "wallet");
  const savedTransfers = wallet.getByRole("region", { name: "Saved transfers awaiting recovery", exact: true });
  const recovery = savedTransfers.locator(":scope > div").filter({ hasText: address });
  await expect(recovery.getByRole("button", { name: "Check native settlement", exact: true })).toBeVisible();
  const restoredWithdrawal = await protocol.walletTransfer(queued.requestId);
  expect(restoredWithdrawal).toEqual(queued);
  const payout = await protocol.advanceUntilTokenWithdrawal(requested.assetBurnIndex, requested.gasBurnIndex, address);
  expect(payout.assetBurn).toMatchObject({ index: requested.assetBurnIndex, kind: "burn", amount: REDEEM_ATOMS.toString(), owner: runtime.canisterId, subaccount: null });
  expect(payout.gasBurn).toMatchObject({ index: requested.gasBurnIndex, kind: "burn", amount: observedGasBurn.toString(), owner: runtime.canisterId, subaccount: null });
  expect(payout.accepted).toMatchObject({ amount: REDEEM_ATOMS.toString(), assetLedger: token.ledger, assetBurnIndex: requested.assetBurnIndex, gasBurnIndex: requested.gasBurnIndex, maxGasFeeWei: payout.gasBurn.amount });
  expect(payout.accepted.recipient.toLowerCase()).toBe(address.toLowerCase());
  const actualGasBurn = BigInt(payout.gasBurn.amount);
  expect(actualGasBurn).toBeLessThanOrEqual(requested.gasBudget);
  expect(afterBurn.gasBalance).toBe(beforeRedemption.gasBalance - actualGasBurn - beforeRedemption.gasFee);
  expect(afterBurn.gasAllowance).toBe(requested.gasBudget - actualGasBurn);
  expect(payout.minterStatus).toBe("TxFinalized.Success");
  expect(payout.transaction.from.toLowerCase()).toBe(minterAddress.toLowerCase());
  expect(payout.transaction.to.toLowerCase()).toBe(token.address.toLowerCase());
  expect(payout.transaction.valueWei).toBe("0");
  expect(await protocol.evmTokenBalance(address)).toBe(beforeRedemption.evmTokenBalance + REDEEM_ATOMS);
  expect(await chain.nonce(address)).toBe(beforeRedemption.nonce);
  await recovery.getByRole("button", { name: "Check native settlement", exact: true }).click();
  await expect.poll(async () => (await protocol.walletTransfer(queued.requestId)).settlement?.status, { timeout: 120_000 }).toBe("confirmed");
  const settled = await protocol.walletTransfer(queued.requestId);
  expect(settled).toMatchObject({ requestId: queued.requestId, blockIndex: requested.assetBurnIndex, status: "succeeded", settlement: { status: "confirmed", transactionHash: payout.transaction.hash } });
  await expect(recovery).toHaveCount(0);
  await expect(page.frameLocator(EVM_FRAME).getByTestId("evm-review")).toHaveCount(0);
  await saveEvidence(testInfo, "ckusdc-native-redemption-quote-debits-and-reload", { body: json({ gasFunding, beforeRedemption, requested, queued, afterBurn, restoredWithdrawal, payout, settled, finalAssetBalance: await protocol.tokenBalance(runtime.canisterId), finalGasBalance: await protocol.ckethBalance(runtime.canisterId) }), contentType: "application/json" });
}

function step(intent: BridgeIntent, kind: BridgeStep["kind"]): BridgeStep {
  const result = intent.steps.find((candidate) => candidate.kind === kind);
  if (!result) throw new Error(`Bridge ${intent.id} has no ${kind} step`);
  return result;
}

function principalWord(principal: string): string {
  const bytes = Principal.fromText(principal).toUint8Array();
  const word = new Uint8Array(32);
  word[0] = bytes.length;
  word.set(bytes, 1);
  return `0x${Buffer.from(word).toString("hex")}`;
}

function expectedDepositData(intent: BridgeIntent): string {
  const abi = new Interface([
    "function deposit(address token,uint256 amount,bytes32 principal)",
    "function depositErc20(address token,uint256 amount,bytes32 principal,bytes32 subaccount)",
  ]);
  const args = [intent.quote.tokenAddress, BigInt(intent.amount), principalWord(intent.quote.recipient)];
  return intent.quote.helperMode === "legacy"
    ? abi.encodeFunctionData("deposit", args)
    : abi.encodeFunctionData("depositErc20", [...args, intent.quote.subaccountWord]);
}

function assertTransaction(transaction: LocalEvmTransactionEvidence, from: string, to: string, data: string): void {
  expect(transaction.from.toLowerCase()).toBe(from.toLowerCase());
  expect(transaction.to.toLowerCase()).toBe(to.toLowerCase());
  expect(transaction.chainId).toBe("1");
  expect(transaction.valueWei).toBe("0");
  expect(Transaction.from(transaction.raw).data.toLowerCase()).toBe(data.toLowerCase());
}

async function waitForMinedReceipt(chain: LocalEvmChain, hash: string): Promise<void> {
  expect(hash).toMatch(/^0x[0-9a-f]{64}$/iu);
  // A successful Wallet reply proves broadcast, not inclusion. Poll the same
  // hash using reads only; full transaction/receipt validation follows below.
  await expect.poll(async () => {
    const receipt = await chain.rpc<{ blockNumber: string | null } | null>("eth_getTransactionReceipt", [hash]);
    return receipt?.blockNumber != null;
  }, { timeout: 120_000, intervals: [250, 500, 1_000] }).toBe(true);
}

async function minedTransactionEvidence(chain: LocalEvmChain, hash: string): Promise<LocalEvmTransactionEvidence> {
  await waitForMinedReceipt(chain, hash);
  return chain.evidence(hash);
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

async function saveEvidence(testInfo: TestInfo, name: string, evidence: { body: string | Buffer; contentType: string }): Promise<void> {
  const output = testInfo.outputPath(`${name}.${evidence.contentType === "image/png" ? "png" : "json"}`);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, evidence.body);
  await testInfo.attach(name, { path: output, contentType: evidence.contentType });
}

async function openNeutron(page: Page, runtime: LocalNeutronRuntime, navigate = true): Promise<void> {
  if (navigate) await page.goto(localCanisterOrigin(runtime.canisterId, runtime.gatewayUrl));
  await page.waitForFunction(() => typeof (window as typeof window & { __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: unknown }).__NEUTRON_PLAYWRIGHT_LOGIN_AS__ === "function");
  const principal = await page.evaluate(async (seed) => {
    const login = (window as typeof window & { __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: (seed: number) => Promise<string> }).__NEUTRON_PLAYWRIGHT_LOGIN_AS__;
    if (!login) throw new Error("Local-only Kernel login hook is unavailable");
    return login(seed);
  }, runtime.developerIdentitySeed);
  expect(principal).toBe(runtime.developerIdentityPrincipal);
  await expect(page.locator('[data-tid="auth-error"]')).toHaveCount(0);
  for (const appId of ["evm_wallet", "wallet", "kitchensink"]) {
    await expect(page.locator(`[data-tid="app-background-frame"][data-app-id="${appId}"]`)).toHaveAttribute("data-resident-launch", "ready", { timeout: 120_000 });
  }
}

async function openApp(page: Page, appId: string, tileId: string): Promise<FrameLocator> {
  const selector = `iframe[data-app-id="${appId}"][data-tile-id="${tileId}"]`;
  if (await page.locator(selector).count() === 0) {
    await page.locator('[data-tid="launcher-open"]').click();
    await page.locator(`[data-tid="launcher-tile-${appId}-${tileId}"]`).click();
  }
  return page.frameLocator(selector);
}

async function configureTokens(page: Page, wallet: FrameLocator, ledgers: string[]): Promise<void> {
  const setup = wallet.getByRole("searchbox", { name: "Find token ledger", exact: true });
  await expect(setup.or(wallet.locator(".wallet-token").first()).first()).toBeVisible();
  const missing = [];
  for (const ledger of ledgers) if (await wallet.locator(`article.wallet-token[data-ledger="${ledger}"]`).count() === 0) missing.push(ledger);
  if (missing.length) {
    if (!await setup.isVisible()) await wallet.getByRole("button", { name: "Choose token ledgers", exact: true }).click();
    for (const ledger of missing) {
      const row = wallet.locator(".wallet-catalog-row").filter({ has: wallet.locator(`[title="${ledger}"]`) });
      if (!await row.getByRole("checkbox").isChecked()) await row.click();
      await expect(row.getByRole("checkbox")).toBeChecked();
    }
    await wallet.getByRole("button", { name: "Apply", exact: true }).click();
    await expect.poll(async () => {
      const grant = page.locator('[data-tid="backend-call-dialog"]');
      if (await grant.isVisible()) {
        const content = await grant.textContent() ?? "";
        expect(ledgers.some((ledger) => content.includes(ledger)), content).toBe(true);
        await page.locator('[data-tid="backend-call-approve"]').click();
      }
      return !await setup.isVisible() && await wallet.locator(`article.wallet-token[data-ledger="${ledgers[ledgers.length - 1]}"]`).isVisible();
    }, { timeout: 120_000, intervals: [100, 250, 500] }).toBe(true);
  }
  await wallet.getByRole("button", { name: "Refresh token metadata", exact: true }).click();
  for (const ledger of ledgers) await expect(wallet.locator(`article.wallet-token[data-ledger="${ledger}"] .wallet-token-balance`)).toHaveAttribute("title", /Fee /u, { timeout: 120_000 });
}

async function openDeposit(wallet: FrameLocator, ledger: string): Promise<void> {
  const amount = wallet.getByLabel("Amount of ckUSDC to deposit", { exact: true });
  const saved = wallet.getByRole("combobox", { name: "Saved deposits", exact: true });
  if (!await amount.isVisible() && !await saved.isVisible()) await wallet.locator(`article.wallet-token[data-ledger="${ledger}"]`).getByRole("button", { name: "Deposit ckUSDC", exact: true }).click();
  await expect(amount.or(saved).first()).toBeVisible({ timeout: 120_000 });
}

async function expectTransactionReview(wallet: FrameLocator, requestId: string, destination: string, address: string): Promise<void> {
  await expect(wallet.getByTestId("evm-review-request-id")).toHaveText(requestId, { timeout: 120_000 });
  const review = wallet.getByTestId("evm-review");
  await expect(review).toContainText("Requested by wallet · Installation");
  await expect(review).toContainText(new RegExp(destination, "iu"));
  await expect(review).toContainText(new RegExp(address, "iu"));
  await expect(review).toContainText("Ethereum");
  await expect(review).toContainText("Maximum network fee");
  await expect(wallet.getByTestId("evm-review-approve")).toBeEnabled();
}

async function savedRecord(card: Locator): Promise<EvmDemoRecord> {
  const value = await card.locator("details pre").textContent();
  if (!value) throw new Error("The saved KitchenSink approval evidence is unavailable");
  return JSON.parse(value) as EvmDemoRecord;
}

async function seedAllowance(page: Page, evmWallet: FrameLocator, token: string, helper: string, address: string, chain: LocalEvmChain): Promise<EvmDemoRecord> {
  const kitchen = await openApp(page, "kitchensink", "main");
  await kitchen.locator('[data-tid="kitchen-nav-evm_wallet"]').click();
  await kitchen.locator('[data-tid="evm-wallet-discover"]').click();
  await allowEvmInspectionGrantsUntil(page, () => kitchen.locator('[data-tid="evm-wallet-prepare"]').isEnabled());
  await kitchen.locator('[data-tid="evm-wallet-chain"]').selectOption("1");
  await expect(kitchen.getByLabel(/^Account/u).locator("option:checked")).toContainText(new RegExp(address, "iu"));
  await kitchen.locator('[data-tid="evm-wallet-kind"]').selectOption("approval_call");
  await kitchen.locator('[data-tid="evm-wallet-token"]').fill(token);
  await kitchen.locator('[data-tid="evm-wallet-destination"]').fill(helper);
  await kitchen.locator('[data-tid="evm-wallet-amount"]').fill(SEEDED_ALLOWANCE.toString());
  // Step 2 is never requested. This is the real helper's harmless read calldata.
  await kitchen.locator('[data-tid="evm-wallet-calldata"]').fill(new Interface(["function getMinterAddress() view returns (address)"]).encodeFunctionData("getMinterAddress"));
  const cards = kitchen.locator('[data-tid="evm-wallet-intents"] [data-tid^="evm-intent-"]');
  const previous = await cards.count();
  await kitchen.locator('[data-tid="evm-wallet-prepare"]').click();
  await expect(cards).toHaveCount(previous + 1);
  const prepared = await savedRecord(cards.first());
  const card = kitchen.locator(`[data-tid="evm-intent-${prepared.intent.id}"]`);
  expect(prepared.intent.steps[0]?.request).toMatchObject({ chainId: "1", to: token.toLowerCase(), valueWei: "0", data: erc20.encodeFunctionData("approve", [helper, SEEDED_ALLOWANCE]) });
  await card.getByRole("button", { name: "Request wallet review: step 1", exact: true }).click();
  await allowEvmInspectionGrantsUntil(page, () => evmWallet.getByTestId("evm-review").isVisible());
  await expect(evmWallet.getByTestId("evm-review-request-id")).toHaveText(prepared.intent.id);
  await expect(evmWallet.getByTestId("evm-review")).toContainText("Requested by kitchensink · Installation");
  await evmWallet.getByTestId("evm-review-approve").click();
  await expect.poll(async () => (await savedRecord(card)).progress[0]?.operation?.transactionHash, { timeout: 180_000 }).toMatch(/^0x[0-9a-f]{64}$/iu);
  // Reconcile only after actual inclusion; one early status response could
  // otherwise leave this saved example submitted until another explicit click.
  await waitForMinedReceipt(chain, (await savedRecord(card)).progress[0]!.operation!.transactionHash!);
  if ((await savedRecord(card)).progress[0]?.operation?.status !== "confirmed") {
    await expect(card.getByRole("button", { name: "Reconcile or resume saved request", exact: true })).toBeEnabled({ timeout: 120_000 });
    await card.getByRole("button", { name: "Reconcile or resume saved request", exact: true }).click();
    await allowEvmInspectionGrantsUntil(page, async () => (await savedRecord(card)).progress[0]?.operation?.status === "confirmed");
  }
  return savedRecord(card);
}

async function requestTokenRedemption(page: Page, wallet: FrameLocator, ledger: string, address: string, before: { assetFee: bigint; gasFee: bigint; gasAllowance: bigint; gasBalance: bigint }, existingContact?: string, testInfo?: TestInfo): Promise<{ assetBurnIndex: string; gasBurnIndex: string; gasBudget: bigint; gasMaximumDebit: bigint; review: string }> {
  const contacts = await openApp(page, "contacts", "contacts");
  const name = existingContact ?? `ckUSDC redemption ${Date.now()}`;
  if (!existingContact) {
    await contacts.getByRole("button", { name: "Add contact", exact: true }).click();
    await contacts.getByRole("textbox", { name: "Name", exact: true }).fill(name);
    await contacts.getByLabel("New destination network", { exact: true }).selectOption("ethereum_mainnet");
    await contacts.getByRole("button", { name: "Add destination", exact: true }).click();
    await contacts.getByRole("textbox", { name: "Destination 1 address", exact: true }).fill(address);
    await contacts.getByRole("button", { name: "Save", exact: true }).click();
    await expect(contacts.getByRole("heading", { name, exact: true })).toBeVisible();
  }
  await wallet.getByRole("button", { name: "Back to tokens", exact: true }).click();
  await wallet.getByRole("button", { name: "Refresh balances", exact: true }).click();
  await wallet.locator(`article.wallet-token[data-ledger="${ledger}"]`).getByRole("button", { name: "Send ckUSDC", exact: true }).click();
  await wallet.getByLabel("Transfer network", { exact: true }).selectOption("ethereum_mainnet");
  await wallet.getByRole("button", { name: "Use EVM Wallet address", exact: true }).click();
  await allowEvmInspectionGrantsUntil(page, async () => (await wallet.getByRole("searchbox", { name: "Search contact destinations", exact: true }).inputValue()).toLowerCase() === address.toLowerCase());
  const destination = wallet.locator(".wallet-destination-row").filter({ hasText: name });
  await expect(destination.getByTitle(new RegExp(`^${address}$`, "iu"))).toBeVisible();
  await destination.getByRole("button", { name: `Send to ${name}`, exact: true }).click();
  await wallet.getByRole("textbox", { name: "Transfer amount", exact: true }).fill(REDEEM_AMOUNT);
  await expect(wallet.locator(".wallet-transfer-recipient").getByTitle(new RegExp(`^${address}$`, "iu"))).toBeVisible();
  const gasRow = (label: string) => wallet.locator(".wallet-withdrawal-cost").filter({ has: wallet.getByText(label, { exact: true }) }).locator("dd");
  await expect(gasRow("Ethereum gas budget")).toContainText(/\([0-9]+ atoms\)/u, { timeout: 120_000 });
  const gasBudget = atoms((await gasRow("Ethereum gas budget").textContent())!);
  const gasMaximumDebit = atoms((await gasRow("Maximum ckETH debit").textContent())!);
  expect(gasBudget).toBeGreaterThan(0n);
  expect(atoms((await gasRow("ckETH approval fee").textContent())!)).toBe(before.gasFee);
  await expect(gasRow("ckETH allowance")).toHaveText(`${gasBudget} atoms`);
  expect(gasMaximumDebit).toBe(gasBudget + before.gasFee);
  expect(before.gasBalance).toBeGreaterThanOrEqual(gasMaximumDebit);
  const assetFeeText = await wallet.getByText("Approval fee", { exact: true }).locator("xpath=following-sibling::dd[1]").textContent();
  expect(parseUnits(assetFeeText!.trim().split(/\s+/u)[0]!, 6)).toBe(before.assetFee);
  await expect(wallet.getByText("Paid in ckETH", { exact: true })).toBeVisible();
  const review = (await wallet.locator("body").textContent())!;
  await expect(wallet.getByRole("button", { name: "Withdraw", exact: true })).toBeEnabled();
  if (testInfo) {
    await saveEvidence(testInfo, "ckusdc-prewithdrawal-gas-review", { body: json({ address, ledger, amount: REDEEM_AMOUNT, amountAtoms: REDEEM_ATOMS, before, gasBudget, gasMaximumDebit, review }), contentType: "application/json" });
    await saveEvidence(testInfo, "ckusdc-prewithdrawal-gas-review", { body: await page.screenshot(), contentType: "image/png" });
  }
  await wallet.getByRole("button", { name: "Withdraw", exact: true }).click();
  const receipt = wallet.locator(".wallet-transfer-receipt");
  await expect(receipt).toContainText("Withdrawal queued", { timeout: 180_000 });
  const indices = (await receipt.textContent())?.match(/Request (\d+) \/ gas burn (\d+)/u);
  if (!indices) throw new Error("The ckUSDC withdrawal receipt must retain both asset and gas burn indices");
  return { assetBurnIndex: indices[1]!, gasBurnIndex: indices[2]!, gasBudget, gasMaximumDebit, review };
}

function atoms(value: string): bigint {
  const amount = /\(([0-9]+) atoms\)/u.exec(value)?.[1];
  if (!amount) throw new Error(`The numeric withdrawal review omitted atomic units: ${value}`);
  return BigInt(amount);
}

async function installedErc20Evidence(runtime: LocalNeutronRuntime, archives: { path: string; size: number; sha256: string }[]) {
  const setupPath = process.env.NEUTRON_IC_ERC20_SETUP_EVIDENCE;
  if (!setupPath) throw new Error("Set NEUTRON_IC_ERC20_SETUP_EVIDENCE to the configure command's actual protocol receipt");
  const directory = path.resolve(".neutron/release-receipts/evm-wallet-completion-2026-09-06/erc20-runtime");
  expect(path.dirname(path.resolve(setupPath))).toBe(directory);
  const filenames = [path.join(directory, "ready.json"), path.join(directory, "first-deployment.json"), path.resolve(setupPath), runtime.sessionPath];
  const bytes = await Promise.all(filenames.map((filename) => readFile(filename)));
  const [ready, deployment, setup, journal] = bytes.map((value) => JSON.parse(value.toString()));
  const normalize = (pins: { path: string; size: number; sha256: string }[]) => pins.map((pin) => ({ path: path.resolve(pin.path), size: pin.size, sha256: pin.sha256 }));
  expect(normalize(archives)).toEqual(normalize(deployment.packagePins));
  expect(ready.packagePins).toEqual(deployment.packagePins);
  expect(setup.packagePins).toEqual(deployment.packagePins);
  for (const receipt of [ready, deployment, setup]) expect(receipt.configSha256).toBe(journal.configSha256);
  expect(path.resolve(ready.sessionPath)).toBe(runtime.sessionPath);
  expect(path.resolve(deployment.sessionPath)).toBe(runtime.sessionPath);
  expect(deployment.node.canisterId).toBe(runtime.canisterId);
  expect(setup.canisterId).toBe(runtime.canisterId);
  expect(deployment.deploymentId).toBe(journal.current.deploymentId);
  expect(setup.deploymentId).toBe(journal.current.deploymentId);
  expect(deployment.firstCreatedCanisterOnly).toBe(true);
  expect(deployment.reinstallPermitted).toBe(false);
  expect(journal.active).toBeUndefined();
  expect(createHash("sha256").update(bytes[3]!).digest("hex")).toBe(deployment.sessionSha256);
  for (const field of ["pid", "processIdentity", "controlUrl", "instanceId", "rootKeyBase64", "stateDirectory"] as const) {
    expect(ready.descriptor[field]).toBe(journal.runtime[field]);
    expect(setup.descriptor[field]).toBe(journal.runtime[field]);
  }
  expect(ready.descriptor.controlUrl).toBe(runtime.controlUrl);
  expect(ready.descriptor.instanceId).toBe(runtime.instanceId);
  expect(ready.descriptor.gateway.url).toBe(runtime.gatewayUrl);
  for (const [index, filename] of filenames.slice(0, 2).entries()) {
    expect(setup.sourceEvidence[index]).toEqual({ path: path.relative(process.cwd(), filename), sha256: createHash("sha256").update(bytes[index]!).digest("hex") });
  }
  const feeReadinessPath = path.join(directory, "fee-readiness.json");
  const feeReadinessBytes = await readFile(feeReadinessPath);
  const feeReadiness = JSON.parse(feeReadinessBytes.toString());
  expect(feeReadiness.deploymentId).toBe(deployment.deploymentId);
  expect(feeReadiness.packagePins).toEqual(deployment.packagePins);
  expect(["existing_normal_fee_cache", "normal_donor_withdrawal_finalized"]).toContain(feeReadiness.status);
  expect(BigInt((feeReadiness.quoted ?? feeReadiness.fee).max_transaction_fee)).toBeGreaterThan(0n);
  return { ready, deployment, setup, feeReadiness, receipts: [
    ...filenames.map((filename, index) => ({ path: path.relative(process.cwd(), filename), sha256: createHash("sha256").update(bytes[index]!).digest("hex") })),
    { path: path.relative(process.cwd(), feeReadinessPath), sha256: createHash("sha256").update(feeReadinessBytes).digest("hex") },
  ] };
}
