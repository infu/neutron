import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { expect, test, type FrameLocator, type Page, type TestInfo } from "@playwright/test";
import { getAddress, Interface, parseEther, Transaction } from "ethers";
import { Principal } from "@dfinity/principal";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
import { resolveLocalNeutronRuntime, type LocalNeutronRuntime } from "../../packages/neutron-provision/src/local_session.ts";
import type { BridgeIntent } from "../../apps/wallet/src/bridge.ts";
import {
  allowEvmInspectionGrantsUntil,
  expectNoEvmKernelDialogs,
  installEvmWalletBrowserFaults,
  readEvmWalletFault,
  setEvmWalletFault,
  startEvmKernelDialogAudit,
} from "./fixtures/evm-wallet-browser.ts";
import { createLocalEvmChain } from "./fixtures/evm-wallet-chain.ts";
import { createIcWalletBridgeFixture } from "./fixtures/ic-wallet-bridge.ts";

// Both networks are the explicit disposable PocketIC/Anvil deployment. The
// application bundles, MessageBus, chain-key signer, helper, minter, and ledger
// are real. Browser faults drop one actual successful Wallet reply and block
// IC Wallet browser storage, exercising its durable canister recovery paths.
test.describe.configure({ retries: 0 });
test.beforeEach(({ page }) => { page.setDefaultTimeout(20_000); });
test.skip(
  path.basename(process.env.NEUTRON_NDEPLOY_CONFIG ?? "") !== "evm-wallet-local.ndeploy.json",
  "Requires the dedicated disposable EVM Wallet PocketIC/Anvil deployment",
);

const EVM_WALLET_FRAME = 'iframe[data-app-id="evm_wallet"][data-tile-id="evm_wallet"]';
const DEPOSIT_AMOUNT = "0.05";
const DEPOSIT_WEI = parseEther(DEPOSIT_AMOUNT);

test("IC Wallet recovers a lost EVM deposit reply, verifies its exact mint, and redeems to EVM Wallet", async ({ page }, testInfo) => {
  // Released minters use their real wall-clock processing/finality timers.
  test.setTimeout(1_800_000);
  const runtime = resolveLocalNeutronRuntime();
  const config = JSON.parse(await readFile(process.env.NEUTRON_NDEPLOY_CONFIG!, "utf8"));
  const archives = await Promise.all([config.artifacts.kernel, ...config.artifacts.packages].map(async (artifact: { path: string }) => {
    const bytes = await readFile(artifact.path);
    return { path: artifact.path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }));
  await saveEvidence(testInfo, "ic-bridge-selected-local-archives", { body: json({ canisterId: runtime.canisterId, sessionPath: runtime.sessionPath, archives }), contentType: "application/json" });
  const chain = await createLocalEvmChain();
  const protocol = await createIcWalletBridgeFixture(runtime);
  await installEvmWalletBrowserFaults(page, ["evm_wallet", "kitchensink", "wallet"]);
  await page.addInitScript(() => {
    if (!/^\/app\/wallet\//u.test(location.pathname)) return;
    for (const key of ["localStorage", "sessionStorage"]) {
      Object.defineProperty(window, key, { configurable: true, get() { throw new DOMException("Storage blocked for IC Wallet qualification", "SecurityError"); } });
    }
  });
  await openNeutron(page, runtime);
  const evmWallet = await openApp(page, "evm_wallet", "evm_wallet");
  await expect(evmWallet.getByTestId("evm-account-address")).toHaveText(/^0x[0-9a-f]{40}$/iu, { timeout: 120_000 });
  const address = getAddress((await evmWallet.getByTestId("evm-account-address").textContent())!);
  await chain.fund(address);
  let wallet = await openApp(page, "wallet", "wallet");
  await configureCketh(page, wallet, protocol.ckethLedger);
  await openCkethDeposit(wallet, protocol.ckethLedger);
  if (await wallet.getByRole("combobox", { name: "Saved deposits", exact: true }).count()) {
    await wallet.getByRole("combobox", { name: "Saved deposits", exact: true }).selectOption("");
  }
  await wallet.getByRole("combobox", { name: "Deposit source", exact: true }).selectOption("evm");
  await wallet.getByLabel("Amount of ckETH to deposit", { exact: true }).fill(DEPOSIT_AMOUNT);
  const before = {
    nonce: await chain.nonce(address),
    ckethBalance: await protocol.ckethBalance(runtime.canisterId),
  };
  await setEvmWalletFault(wallet, "dropNextTransactionReply");
  await wallet.getByRole("button", { name: "Deposit with EVM Wallet", exact: true }).click();
  await allowEvmInspectionGrantsUntil(page, () => evmWallet.getByTestId("evm-review").isVisible());
  const id = await wallet.getByRole("combobox", { name: "Saved deposits", exact: true }).inputValue();
  expect(id).toMatch(/^[0-9a-f]{32}$/u);
  const prepared = await protocol.walletBridge(id);
  expect(prepared.source).toBe("evm");
  expect(prepared.account.toLowerCase()).toBe(address.toLowerCase());
  expect(prepared.amount).toBe(DEPOSIT_WEI.toString());
  expect(prepared.quote).toMatchObject({
    chainId: "1", ledger: protocol.ckethLedger, minter: protocol.ckethMinter,
    tokenAddress: null, recipient: runtime.canisterId,
  });
  expect(prepared.quote.helperAddress.toLowerCase()).toBe(protocol.helperAddress.toLowerCase());
  expect(prepared.quote.principalWord.toLowerCase()).toBe(principalWord(runtime.canisterId));
  expect(prepared.quote.subaccountWord).toBe(`0x${"0".repeat(64)}`);
  const preparedStep = depositStep(prepared);
  expect(preparedStep).toMatchObject({ state: "unknown", transactionHash: null });
  expect(preparedStep.operationId).toMatch(/^[0-9a-f]{32}$/u);
  expect(prepared.steps.filter((step) => step.kind !== "deposit").every((step) => step.operationId === null && step.transactionHash === null)).toBe(true);
  await expect(wallet.getByLabel("Amount of ckETH to deposit", { exact: true })).toHaveCount(0);
  await expect(wallet.getByRole("combobox", { name: "Deposit source", exact: true })).toHaveCount(0);
  await expect(wallet.getByRole("combobox", { name: "Saved deposits", exact: true })).toBeDisabled();
  const review = evmWallet.getByTestId("evm-review");
  await expect(review).toHaveCount(1);
  await expect(review).toContainText("Requested by wallet · Installation");
  await expect(review).toContainText(new RegExp(address, "iu"));
  await expect(review).toContainText(new RegExp(protocol.helperAddress, "iu"));
  await expect(review).toContainText(`${DEPOSIT_WEI} wei`);
  await expect(review).toContainText("Ethereum");
  await expect(review).toContainText("Maximum network fee");
  await expect(evmWallet.getByTestId("evm-review-request-id")).toHaveText(preparedStep.operationId!);

  // A real unrelated ICRC transfer increases the receiving account's balance
  // while this deposit is pending. Refresh must still require its own event
  // and ledger mint, and must not infer completion from that balance increase.
  const unrelated = await protocol.unrelatedTransfer(runtime.canisterId, parseEther("0.0001"));
  expect(unrelated.balanceDelta).toBe(parseEther("0.0001"));
  expect(await protocol.ckethBalance(runtime.canisterId)).toBe(before.ckethBalance + unrelated.balanceDelta);
  const afterUnrelated = await protocol.refreshWalletBridge(id);
  expect(afterUnrelated.acceptedDeposit).toBeNull();
  expect(afterUnrelated.mint).toBeNull();
  expect(depositStep(afterUnrelated).transactionHash).toBeNull();
  expect(await chain.nonce(address)).toBe(before.nonce);
  await saveEvidence(testInfo, "ic-wallet-exact-deposit-review", { body: await page.screenshot(), contentType: "image/png" });
  await startEvmKernelDialogAudit(page);
  await evmWallet.getByTestId("evm-review-approve").click();
  await expect.poll(async () => (await readEvmWalletFault(wallet)).droppedReply !== null, { timeout: 180_000 }).toBe(true);
  const dropped = (await readEvmWalletFault(wallet)).droppedReply!;
  expect(dropped.requestId).toBe(preparedStep.operationId);
  expect(dropped.chainId).toBe("1");
  expect(String(dropped.address).toLowerCase()).toBe(address.toLowerCase());
  expect(dropped.transactionHash).toMatch(/^0x[0-9a-f]{64}$/iu);
  expect(typeof dropped.operationId).toBe("string");
  await expect(review).toHaveCount(0);
  await expectNoEvmKernelDialogs(page);
  const hash = String(dropped.transactionHash);
  await saveEvidence(testInfo, "ic-wallet-deposit-before-reload", { body: json({ id, address, before, prepared, afterUnrelated, unrelated, dropped }), contentType: "application/json" });
  // A successful send reply can precede inclusion. Read the same hash until
  // its receipt exists; this must never turn into another send request.
  await expect.poll(() => chain.rpc("eth_getTransactionReceipt", [hash]), { timeout: 180_000 }).not.toBeNull();
  const transaction = await chain.evidence(hash);
  expect(transaction.from.toLowerCase()).toBe(address.toLowerCase());
  expect(transaction.to.toLowerCase()).toBe(protocol.helperAddress.toLowerCase());
  expect(transaction.chainId).toBe("1");
  expect(transaction.valueWei).toBe(DEPOSIT_WEI.toString());
  expect(BigInt(transaction.nonce)).toBe(before.nonce);
  expect(Transaction.from(transaction.raw).data.toLowerCase()).toBe(expectedDepositData(prepared).toLowerCase());
  expect(await chain.nonce(address)).toBe(before.nonce + 1n);
  const interrupted = await protocol.walletBridge(id);
  expect(depositStep(interrupted)).toMatchObject({ state: "unknown", operationId: preparedStep.operationId, transactionHash: null });

  // Reload destroys the waiting consumer and reads its canister journal. The
  // exact Wallet request must recover the approved transaction without another
  // review, signature, nonce, or Ethereum deposit.
  await page.reload();
  await openNeutron(page, runtime, false);
  wallet = await openApp(page, "wallet", "wallet");
  await openCkethDeposit(wallet, protocol.ckethLedger);
  await expect(wallet.getByRole("combobox", { name: "Saved deposits", exact: true })).toHaveValue(id);
  await expect(wallet.getByLabel("Amount of ckETH to deposit", { exact: true })).toHaveCount(0);
  await expect(wallet.getByRole("combobox", { name: "Deposit source", exact: true })).toHaveCount(0);
  expect(await protocol.walletBridge(id)).toEqual(interrupted);
  await wallet.getByRole("button", { name: "Resume saved deposit", exact: true }).click();
  await allowEvmInspectionGrantsUntil(page, async () => depositStep(await protocol.walletBridge(id)).state === "confirmed");
  const recovered = await protocol.walletBridge(id);
  expect(recovered.quote).toEqual(prepared.quote);
  expect(recovered.account).toBe(prepared.account);
  expect(recovered.amount).toBe(prepared.amount);
  expect(depositStep(recovered)).toMatchObject({ state: "confirmed", operationId: preparedStep.operationId, transactionHash: hash });
  await expect(page.frameLocator(EVM_WALLET_FRAME).getByTestId("evm-review")).toHaveCount(0);
  expect(await chain.nonce(address)).toBe(before.nonce + 1n);

  const mint = await protocol.advanceUntilMint(hash);
  expect(mint.accepted).toMatchObject({ transactionHash: hash, amount: DEPOSIT_WEI.toString(), recipient: runtime.canisterId, subaccount: null });
  expect(mint.accepted.fromAddress.toLowerCase()).toBe(address.toLowerCase());
  expect(mint.minted.transactionHash).toBe(hash);
  expect(mint.minted.logIndex).toBe(mint.accepted.logIndex);
  expect(mint.ledgerBlock).toMatchObject({ index: mint.minted.ledgerBlockIndex, kind: "mint", amount: DEPOSIT_WEI.toString(), recipient: runtime.canisterId, subaccount: null });
  expect(BigInt(mint.ledgerBlock.index)).not.toBe(unrelated.blockIndex);
  await expect(wallet.getByRole("button", { name: "Check deposit and mint", exact: true })).toBeEnabled({ timeout: 120_000 });
  await wallet.getByRole("button", { name: "Check deposit and mint", exact: true }).click();
  await expect(wallet.locator(".wallet-bridge-status")).toContainText(`Mint verified at IC ledger block ${mint.ledgerBlock.index}`, { timeout: 120_000 });
  const completed = await protocol.walletBridge(id);
  expect(completed.acceptedDeposit).toEqual({ logIndex: mint.accepted.logIndex, blockNumber: mint.accepted.blockNumber, eventIndex: mint.accepted.eventIndex });
  expect(completed.mint).toEqual({ ledgerBlockIndex: mint.ledgerBlock.index, eventIndex: mint.minted.eventIndex, verifiedLedger: true });
  expect(await protocol.ckethBalance(runtime.canisterId)).toBe(before.ckethBalance + unrelated.balanceDelta + DEPOSIT_WEI);
  expect(await chain.nonce(address)).toBe(before.nonce + 1n);
  await saveEvidence(testInfo, "ic-wallet-deposit-mint-and-recovery", {
    body: json({ prepared, unrelated, afterUnrelated, dropped, transaction, interrupted, recovered, mint, completed }),
    contentType: "application/json",
  });
  await saveEvidence(testInfo, "ic-wallet-exact-mint-verified", { body: await page.screenshot(), contentType: "image/png" });

  await qualifyNativeRedemption(page, testInfo, wallet, runtime, protocol, chain, address, prepared.quote.minterAddress);
});

test("reconcile an interrupted qualification deposit without another signature", async ({ page }, testInfo) => {
  const expectedHash = process.env.NEUTRON_IC_BRIDGE_RECOVERY_HASH;
  test.skip(!expectedHash, "Run only to reconcile a specifically recorded interrupted qualification");
  test.setTimeout(600_000);
  expect(expectedHash).toMatch(/^0x[0-9a-f]{64}$/iu);
  const runtime = resolveLocalNeutronRuntime();
  const protocol = await createIcWalletBridgeFixture(runtime);
  const chain = await createLocalEvmChain();
  const transaction = await chain.evidence(expectedHash!);
  expect(transaction.valueWei).toBe(DEPOSIT_WEI.toString());
  expect(transaction.to.toLowerCase()).toBe(protocol.helperAddress.toLowerCase());
  const beforeNonce = await chain.nonce(transaction.from);
  await openNeutron(page, runtime);
  const wallet = await openApp(page, "wallet", "wallet");
  await openCkethDeposit(wallet, protocol.ckethLedger);
  const saved = wallet.getByRole("combobox", { name: "Saved deposits", exact: true });
  const ids = await saved.locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value).filter((value) => /^[0-9a-f]{32}$/u.test(value)));
  const candidates = [];
  for (const id of ids) {
    const intent = await protocol.walletBridge(id);
    if (intent.amount === DEPOSIT_WEI.toString() && intent.account.toLowerCase() === transaction.from.toLowerCase() && depositStep(intent).state === "unknown" && depositStep(intent).transactionHash === null) candidates.push(intent);
  }
  expect(candidates).toHaveLength(1);
  const interrupted = candidates[0]!;
  expect(Transaction.from(transaction.raw).data.toLowerCase()).toBe(expectedDepositData(interrupted).toLowerCase());
  await saved.selectOption(interrupted.id);
  await wallet.getByRole("button", { name: "Resume saved deposit", exact: true }).click();
  await allowEvmInspectionGrantsUntil(page, async () => depositStep(await protocol.walletBridge(interrupted.id)).transactionHash === expectedHash);
  const mint = await protocol.advanceUntilMint(expectedHash!);
  const reconciled = await protocol.refreshWalletBridge(interrupted.id);
  expect(reconciled.mint).toMatchObject({ verifiedLedger: true, ledgerBlockIndex: mint.minted.ledgerBlockIndex });
  expect(depositStep(reconciled).operationId).toBe(depositStep(interrupted).operationId);
  expect(await chain.nonce(transaction.from)).toBe(beforeNonce);
  await saveEvidence(testInfo, "interrupted-qualification-reconciled", { body: json({ expectedHash, beforeNonce, interrupted, transaction, mint, reconciled }), contentType: "application/json" });
});


test("complete native redemption after an interrupted qualification deposit", async ({ page }, testInfo) => {
  const id = process.env.NEUTRON_IC_BRIDGE_RECOVERY_ID;
  const hash = process.env.NEUTRON_IC_BRIDGE_RECOVERY_HASH;
  test.skip(!id || !hash, "Run only after the specifically recorded interrupted deposit has been reconciled");
  test.setTimeout(900_000);
  const runtime = resolveLocalNeutronRuntime();
  const protocol = await createIcWalletBridgeFixture(runtime);
  const chain = await createLocalEvmChain();
  const completed = await protocol.walletBridge(id!);
  expect(completed.mint?.verifiedLedger).toBe(true);
  expect(depositStep(completed).transactionHash).toBe(hash);
  const transaction = await chain.evidence(hash!);
  expect(transaction.from.toLowerCase()).toBe(completed.account.toLowerCase());
  expect(transaction.valueWei).toBe(DEPOSIT_WEI.toString());
  await openNeutron(page, runtime);
  const wallet = await openApp(page, "wallet", "wallet");
  await openCkethDeposit(wallet, protocol.ckethLedger);
  await wallet.getByRole("combobox", { name: "Saved deposits", exact: true }).selectOption(id!);
  await expect(wallet.locator(".wallet-bridge-status")).toContainText(`Mint verified at IC ledger block ${completed.mint!.ledgerBlockIndex}`);
  await saveEvidence(testInfo, "ic-wallet-resumed-mint-verified", { body: await page.screenshot(), contentType: "image/png" });
  await qualifyNativeRedemption(page, testInfo, wallet, runtime, protocol, chain, completed.account, completed.quote.minterAddress);
});

async function qualifyNativeRedemption(
  page: Page, testInfo: TestInfo, wallet: FrameLocator, runtime: LocalNeutronRuntime,
  protocol: Awaited<ReturnType<typeof createIcWalletBridgeFixture>>,
  chain: Awaited<ReturnType<typeof createLocalEvmChain>>, address: string, minterAddress: string,
): Promise<void> {
  const beforeRedemption = {
    ethBalance: await chain.balance(address), ckethBalance: await protocol.ckethBalance(runtime.canisterId),
    nonce: await chain.nonce(address), allowance: await protocol.ckethAllowance(runtime.canisterId), ledgerFee: await protocol.ckethFee(),
  };
  const burnIndex = await requestNativeRedemption(page, wallet, protocol.ckethLedger, address);
  const queued = await protocol.walletTransferForBurn(burnIndex);
  expect(queued).toMatchObject({ ledger: protocol.ckethLedger, amount: parseEther("0.01").toString(), native: true, status: "succeeded", blockIndex: burnIndex });
  expect(queued.destination.toLowerCase()).toBe(address.toLowerCase());
  expect(queued.requestId).toMatch(/^[0-9a-f]{32}$/u);
  expect(queued.settlement?.status).not.toBe("confirmed");
  expect(await protocol.ckethBalance(runtime.canisterId)).toBe(beforeRedemption.ckethBalance - parseEther("0.01") - beforeRedemption.ledgerFee);
  expect(await protocol.ckethAllowance(runtime.canisterId)).toBe(beforeRedemption.ledgerFee);
  await saveEvidence(testInfo, "ic-wallet-native-burn-queued", { body: await page.screenshot(), contentType: "image/png" });
  await page.reload();
  await openNeutron(page, runtime, false);
  wallet = await openApp(page, "wallet", "wallet");
  const savedTransfers = wallet.getByRole("region", { name: "Saved transfers awaiting recovery", exact: true });
  const recovery = savedTransfers.locator(":scope > div").filter({ hasText: address });
  await expect(recovery.getByRole("button", { name: "Check native settlement", exact: true })).toBeVisible();
  const restoredWithdrawal = await protocol.walletTransfer(queued.requestId);
  expect(restoredWithdrawal).toEqual(queued);
  const payout = await protocol.advanceUntilWithdrawal(burnIndex, address);
  expect(payout.burn).toEqual({ index: burnIndex, kind: "burn", amount: parseEther("0.01").toString(), owner: runtime.canisterId, subaccount: null });
  expect(payout.minterStatus).toBe("TxFinalized.Success");
  expect(payout.transaction.to.toLowerCase()).toBe(address.toLowerCase());
  expect(payout.transaction.from.toLowerCase()).toBe(minterAddress.toLowerCase());
  expect(await chain.balance(address)).toBe(beforeRedemption.ethBalance + BigInt(payout.transaction.valueWei));
  expect(BigInt(payout.recipientBalanceWei)).toBe(await chain.balance(address));
  expect(await chain.nonce(address)).toBe(beforeRedemption.nonce);
  await recovery.getByRole("button", { name: "Check native settlement", exact: true }).click();
  await expect.poll(async () => (await protocol.walletTransfer(queued.requestId)).settlement?.status, { timeout: 120_000 }).toBe("confirmed");
  const settled = await protocol.walletTransfer(queued.requestId);
  expect(settled).toMatchObject({ requestId: queued.requestId, blockIndex: burnIndex, status: "succeeded", settlement: { status: "confirmed", transactionHash: payout.transaction.hash } });
  await expect(recovery).toHaveCount(0);
  await expect(page.frameLocator(EVM_WALLET_FRAME).getByTestId("evm-review")).toHaveCount(0);
  await saveEvidence(testInfo, "ic-wallet-native-redemption-and-reload", {
    body: json({ beforeRedemption, queued, restoredWithdrawal, payout, settled, ckethBalance: await protocol.ckethBalance(runtime.canisterId), allowance: await protocol.ckethAllowance(runtime.canisterId) }),
    contentType: "application/json",
  });
}

function depositStep(intent: BridgeIntent) {
  const step = intent.steps.find((candidate) => candidate.kind === "deposit");
  if (!step) throw new Error(`Bridge ${intent.id} has no deposit step`);
  return step;
}

function principalWord(principal: string): string {
  const bytes = Principal.fromText(principal).toUint8Array();
  const word = new Uint8Array(32);
  word[0] = bytes.length;
  word.set(bytes, 1);
  return `0x${Buffer.from(word).toString("hex")}`;
}

function expectedDepositData(intent: BridgeIntent): string {
  const abi = new Interface(["function deposit(bytes32 principal) payable", "function depositEth(bytes32 principal,bytes32 subaccount) payable"]);
  return intent.quote.helperMode === "legacy"
    ? abi.encodeFunctionData("deposit", [principalWord(intent.quote.recipient)])
    : abi.encodeFunctionData("depositEth", [principalWord(intent.quote.recipient), intent.quote.subaccountWord]);
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
  for (const appId of ["evm_wallet", "wallet"]) {
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

async function configureCketh(page: Page, wallet: FrameLocator, ledger: string): Promise<void> {
  const setup = wallet.getByRole("searchbox", { name: "Find token ledger", exact: true });
  await expect(setup.or(wallet.locator(".wallet-token").first()).first()).toBeVisible();
  const token = wallet.locator(`article.wallet-token[data-ledger="${ledger}"]`);
  if (await token.count() === 0) {
    if (!await setup.isVisible()) await wallet.getByRole("button", { name: "Choose token ledgers", exact: true }).click();
    const catalogRow = wallet.locator(".wallet-catalog-row").filter({ has: wallet.locator(`[title="${ledger}"]`) });
    if (!await catalogRow.getByRole("checkbox").isChecked()) await catalogRow.click();
    await expect(catalogRow.getByRole("checkbox")).toBeChecked();
    await wallet.getByRole("button", { name: "Apply", exact: true }).click();
    await expect.poll(async () => {
      const grant = page.locator('[data-tid="backend-call-dialog"]');
      if (await grant.isVisible()) {
        await expect(grant).toContainText(ledger);
        await page.locator('[data-tid="backend-call-approve"]').click();
      }
      return !await setup.isVisible() && await token.isVisible();
    }, { timeout: 120_000, intervals: [100, 250, 500] }).toBe(true);
  }
  await expect(token).toBeVisible();
  await wallet.getByRole("button", { name: "Refresh token metadata", exact: true }).click();
  await expect(token.locator(".wallet-token-balance")).toHaveAttribute("title", /Fee /u, { timeout: 120_000 });
}

async function openCkethDeposit(wallet: FrameLocator, ledger: string): Promise<void> {
  const amount = wallet.getByLabel("Amount of ckETH to deposit", { exact: true });
  const saved = wallet.getByRole("combobox", { name: "Saved deposits", exact: true });
  if (!await amount.isVisible() && !await saved.isVisible()) {
    await wallet.locator(`article.wallet-token[data-ledger="${ledger}"]`).getByRole("button", { name: "Deposit ckETH", exact: true }).click();
  }
  await expect(amount.or(saved).first()).toBeVisible({ timeout: 120_000 });
}

async function requestNativeRedemption(page: Page, wallet: FrameLocator, ledger: string, address: string): Promise<string> {
  const contacts = await openApp(page, "contacts", "contacts");
  const contactName = `EVM redemption ${Date.now()}`;
  await contacts.getByRole("button", { name: "Add contact", exact: true }).click();
  await contacts.getByRole("textbox", { name: "Name", exact: true }).fill(contactName);
  await contacts.getByLabel("New destination network", { exact: true }).selectOption("ethereum_mainnet");
  await contacts.getByRole("button", { name: "Add destination", exact: true }).click();
  await expect(contacts.getByLabel("Destination 1 network", { exact: true })).toHaveValue("ethereum_mainnet");
  await contacts.getByRole("textbox", { name: "Destination 1 address", exact: true }).fill(address);
  await contacts.getByRole("button", { name: "Save", exact: true }).click();
  await expect(contacts.getByRole("heading", { name: contactName, exact: true })).toBeVisible();
  await wallet.getByRole("button", { name: "Back to tokens", exact: true }).click();
  await wallet.getByRole("button", { name: "Refresh balances", exact: true }).click();
  await wallet.locator(`article.wallet-token[data-ledger="${ledger}"]`).getByRole("button", { name: "Send ckETH", exact: true }).click();
  await wallet.getByLabel("Transfer network", { exact: true }).selectOption("ethereum_mainnet");
  await wallet.getByRole("button", { name: "Use EVM Wallet address", exact: true }).click();
  await allowEvmInspectionGrantsUntil(page, async () => (await wallet.getByRole("searchbox", { name: "Search contact destinations", exact: true }).inputValue()).toLowerCase() === address.toLowerCase());
  const destination = wallet.locator(".wallet-destination-row").filter({ hasText: contactName });
  await expect(destination.getByTitle(new RegExp(`^${address}$`, "iu"))).toBeVisible();
  await destination.getByRole("button", { name: `Send to ${contactName}`, exact: true }).click();
  await wallet.getByRole("textbox", { name: "Transfer amount", exact: true }).fill("0.01");
  await expect(wallet.locator(".wallet-transfer-recipient").getByTitle(new RegExp(`^${address}$`, "iu"))).toBeVisible();
  await wallet.getByRole("button", { name: "Withdraw", exact: true }).click();
  const receipt = wallet.locator(".wallet-transfer-receipt");
  await expect(receipt).toContainText("Withdrawal queued", { timeout: 120_000 });
  const burnIndex = (await receipt.textContent())?.match(/Request (\d+)/u)?.[1];
  if (!burnIndex) throw new Error("The native withdrawal receipt contains no ckETH burn block index");
  return burnIndex;
}
