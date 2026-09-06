import { randomBytes } from "node:crypto";
import path from "node:path";
import { expect, test, type FrameLocator, type Locator, type Page } from "@playwright/test";
import { getAddress, parseUnits, Transaction } from "ethers";
import { resolveLocalNeutronRuntime, type LocalNeutronRuntime } from "../../packages/neutron-provision/src/local_session.ts";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
import type { EvmDemoRecord } from "../../apps/kitchensink/src/evm_wallet_demo.ts";
import {
  allowEvmInspectionGrantsUntil,
  expectNoEvmKernelDialogs,
  installEvmWalletBrowserFaults,
  readEvmWalletFault,
  setEvmWalletFault,
  startEvmKernelDialogAudit,
} from "./fixtures/evm-wallet-browser.ts";
import { createLocalEvmChain } from "./fixtures/evm-wallet-chain.ts";

// This suite changes only the explicitly selected disposable PocketIC/Anvil
// fixture. It must never infer an EVM network from a browser wallet or URL.
test.describe.configure({ retries: 0 });
test.beforeEach(({ page }) => { page.setDefaultTimeout(20_000); });
test.skip(
  path.basename(process.env.NEUTRON_NDEPLOY_CONFIG ?? "") !== "evm-wallet-local.ndeploy.json",
  "Requires the dedicated disposable EVM Wallet PocketIC/Anvil deployment",
);

const KITCHEN_FRAME = 'iframe[data-app-id="kitchensink"][data-tile-id="main"]';
const WALLET_FRAME = 'iframe[data-app-id="evm_wallet"][data-tile-id="evm_wallet"]';
const WALLET_RESIDENT = 'iframe[data-app-id="evm_wallet"][data-tid="app-background-frame"]';
const AMOUNT_WEI = "1000000000000";

test("one Wallet decision signs a real transaction; a lost reply and reload reconcile the same operation", async ({ page }, testInfo) => {
  test.setTimeout(480_000);
  const runtime = resolveLocalNeutronRuntime();
  const chain = await createLocalEvmChain();
  await installEvmWalletBrowserFaults(page);
  let kitchen = await openEvmKitchen(page, runtime);
  const address = await discoverAccount(page, kitchen);
  await chain.fund(address);
  const recipient = getAddress(`0x${randomBytes(20).toString("hex")}`);
  const before = {
    nonce: await chain.nonce(address),
    sourceBalance: await chain.balance(address),
    recipientBalance: await chain.balance(recipient),
  };

  // The initial decline also establishes account/network inspection and saved
  // operation recovery grants. These cannot authorize a new signature.
  const declined = await prepareNative(kitchen, recipient);
  await declined.card.getByRole("button", { name: "Request wallet review: step 1", exact: true }).click();
  const wallet = page.frameLocator(WALLET_FRAME);
  await allowEvmInspectionGrantsUntil(page, () => wallet.getByTestId("evm-review").isVisible());
  await expectReview(wallet, declined.record, recipient, address);
  await wallet.getByTestId("evm-review-decline").click();
  await expect.poll(async () => (await savedRecord(declined.card)).progress[0]?.operation?.status, {
    timeout: 120_000,
  }).toBe("rejected");
  await expect(wallet.getByTestId("evm-review")).toHaveCount(0);
  expect(await chain.nonce(address)).toBe(before.nonce);
  expect(await chain.balance(address)).toBe(before.sourceBalance);
  expect(await chain.balance(recipient)).toBe(before.recipientBalance);

  const accepted = await prepareNative(kitchen, recipient);
  expect(accepted.record.intent.id).not.toBe(declined.record.intent.id);
  await startEvmKernelDialogAudit(page);
  await setEvmWalletFault(kitchen, "dropNextTransactionReply");
  await accepted.card.getByRole("button", { name: "Request wallet review: step 1", exact: true }).click();
  await expectReview(wallet, accepted.record, recipient, address);
  await expect(page.locator(WALLET_FRAME)).toHaveCount(1);
  await testInfo.attach("wallet-review", { body: await page.screenshot(), contentType: "image/png" });
  await wallet.getByTestId("evm-review-approve").click();
  await expect.poll(async () => (await readEvmWalletFault(kitchen)).droppedReply !== null, {
    timeout: 180_000,
  }).toBe(true);
  const dropped = (await readEvmWalletFault(kitchen)).droppedReply!;
  expect(dropped.requestId).toBe(accepted.record.intent.id);
  expect(dropped.chainId).toBe("1");
  expect(dropped.address?.toString().toLowerCase()).toBe(address.toLowerCase());
  expect(typeof dropped.operationId).toBe("string");
  expect(dropped.transactionHash).toMatch(/^0x[0-9a-f]{64}$/iu);
  await expect(wallet.getByTestId("evm-review")).toHaveCount(0);
  await expectNoEvmKernelDialogs(page);

  // The reply was lost after the backend saved/sent its exact signed bytes.
  await expect.poll(() => chain.nonce(address), { timeout: 60_000 }).toBe(before.nonce + 1n);
  expect(await chain.balance(recipient)).toBe(before.recipientBalance + BigInt(AMOUNT_WEI));
  const evidence = await chain.evidence(String(dropped.transactionHash));
  expect(evidence.from.toLowerCase()).toBe(address.toLowerCase());
  expect(evidence.to?.toLowerCase()).toBe(recipient.toLowerCase());
  expect(evidence.valueWei).toBe(AMOUNT_WEI);
  expect(evidence.chainId).toBe("1");
  expect(BigInt(evidence.nonce)).toBe(before.nonce);

  await page.reload();
  kitchen = await openEvmKitchen(page, runtime, false);
  const restored = kitchen.locator(`[data-tid="evm-intent-${accepted.record.intent.id}"]`);
  await expect(restored).toBeVisible();
  // Reload reads the durable resident journal. The old tile could still have
  // displayed its pre-request snapshot while awaiting the deliberately lost
  // reply, so inspect the saved attempted state before any reconciliation.
  const interrupted = await savedRecord(restored);
  expect(interrupted.intent).toEqual(accepted.record.intent);
  expect(interrupted.progress[0]?.attempted).toBe(true);
  expect(interrupted.progress[0]?.operation).toBeNull();
  expect(await chain.nonce(address)).toBe(before.nonce + 1n);
  await restored.getByRole("button", { name: "Reconcile or resume saved request", exact: true }).click();
  await allowEvmInspectionGrantsUntil(page, async () => (await savedRecord(restored)).progress[0]?.operation?.status === "confirmed");
  const reconciled = await savedRecord(restored);
  expect(reconciled.progress[0]?.operation).toMatchObject({
    operationId: dropped.operationId,
    requestId: accepted.record.intent.id,
    transactionHash: dropped.transactionHash,
    status: "confirmed",
    receipt: { status: "success" },
  });
  await expect(restored.getByRole("button", { name: "Recorded terminal outcome", exact: true })).toBeDisabled();
  await expect(page.frameLocator(WALLET_FRAME).getByTestId("evm-review")).toHaveCount(0);
  expect(await chain.nonce(address)).toBe(before.nonce + 1n);
  expect(await chain.balance(recipient)).toBe(before.recipientBalance + BigInt(AMOUNT_WEI));
  await testInfo.attach("signed-transaction-and-recovery", {
    body: JSON.stringify({ evidence, declined: (await savedRecord(kitchen.locator(`[data-tid="evm-intent-${declined.record.intent.id}"]`))).progress, interrupted, reconciled }, null, 2),
    contentType: "application/json",
  });
  await testInfo.attach("wallet-recovered", { body: await page.screenshot(), contentType: "image/png" });
});

test("an older Kernel caller payload without installation identity cannot create a financial effect", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const runtime = resolveLocalNeutronRuntime();
  const chain = await createLocalEvmChain();
  await installEvmWalletBrowserFaults(page);
  const kitchen = await openEvmKitchen(page, runtime);
  const address = await discoverAccount(page, kitchen);
  await chain.fund(address);
  const recipient = getAddress(`0x${randomBytes(20).toString("hex")}`);
  const before = { nonce: await chain.nonce(address), source: await chain.balance(address), recipient: await chain.balance(recipient) };
  const prepared = await prepareNative(kitchen, recipient);
  const walletFrameCount = await page.locator(WALLET_FRAME).count();
  const resident = page.frameLocator(WALLET_RESIDENT);
  await setEvmWalletFault(resident, "omitCallerInstallationUid");
  await prepared.card.getByRole("button", { name: "Request wallet review: step 1", exact: true }).click();
  await allowEvmInspectionGrantsUntil(page, async () => (await savedRecord(prepared.card)).progress[0]?.error?.includes("Kernel-authenticated caller installation identity") ?? false);
  expect((await readEvmWalletFault(resident)).omittedCallerCount).toBeGreaterThan(0);
  const record = await savedRecord(prepared.card);
  expect(record.progress[0]?.operation).toBeNull();
  expect(record.progress[0]?.attempted).toBe(true);
  // The ordinary Wallet tile can remain open from an earlier operation; a
  // rejected caller must neither open another tile nor present a new review.
  await expect(page.locator(WALLET_FRAME)).toHaveCount(walletFrameCount);
  if (walletFrameCount > 0) await expect(page.frameLocator(WALLET_FRAME).getByTestId("evm-review")).toHaveCount(0);
  expect(await chain.nonce(address)).toBe(before.nonce);
  expect(await chain.balance(address)).toBe(before.source);
  expect(await chain.balance(recipient)).toBe(before.recipient);
  await testInfo.attach("missing-installation-provenance", { body: JSON.stringify(record, null, 2), contentType: "application/json" });
});

test("Uniswap approves exact tokens, survives reload, and swaps through EVM Wallet against official contracts", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  const { createLocalUniswapFixture } = await import("./fixtures/evm-wallet-uniswap.ts");
  const runtime = resolveLocalNeutronRuntime();
  const chain = await createLocalEvmChain();
  const contracts = await createLocalUniswapFixture();
  const kitchen = await openEvmKitchen(page, runtime);
  const address = await discoverAccount(page, kitchen);
  await contracts.fund(address);
  let uniswap = await openUniswap(page);
  await uniswap.getByRole("button", { name: "Connect EVM Wallet", exact: true }).click();
  const connected = uniswap.getByRole("button", { name: "Refresh wallet", exact: true });
  await allowEvmInspectionGrantsUntil(page, async () => await connected.isVisible() && await connected.isEnabled());
  await uniswap.getByLabel(/^Network/u).selectOption("1");
  await uniswap.getByText("Swap settings and custom token", { exact: true }).click();
  for (const token of [contracts.tokenA, contracts.tokenB]) {
    await uniswap.getByLabel("Custom token contract", { exact: true }).fill(token);
    await uniswap.getByRole("button", { name: "Read and add token", exact: true }).click();
    await allowEvmInspectionGrantsUntil(page, async () => (await uniswap.getByLabel("Input token", { exact: true }).locator(`option[value="${token.toLowerCase()}"]`).count()) === 1);
  }
  await uniswap.getByLabel("Input token", { exact: true }).selectOption(contracts.tokenA.toLowerCase());
  await uniswap.getByLabel("Output token", { exact: true }).selectOption(contracts.tokenB.toLowerCase());
  await uniswap.getByLabel("Input amount", { exact: true }).fill("0.001");
  await uniswap.getByLabel("Recipient", { exact: true }).fill(address);
  const before = {
    nonce: await chain.nonce(address),
    input: await contracts.balance(contracts.tokenA, address),
    output: await contracts.balance(contracts.tokenB, address),
  };
  await uniswap.getByRole("button", { name: "Get quote", exact: true }).click();
  const save = uniswap.getByRole("button", { name: "Save swap and review approval", exact: true });
  await allowEvmInspectionGrantsUntil(page, async () => await save.isVisible() && await save.isEnabled());
  const minimumText = await uniswap.locator(".uni-review").getByText("Minimum received", { exact: true }).locator("xpath=following-sibling::dd[1]").textContent();
  if (!minimumText) throw new Error("Uniswap quote has no minimum received");
  const minimumOut = parseUnits(minimumText.trim().split(/\s+/u)[0]!, 18);
  expect(minimumOut).toBeGreaterThan(0n);
  await save.click();
  const wallet = page.frameLocator(WALLET_FRAME);
  await allowEvmInspectionGrantsUntil(page, () => wallet.getByTestId("evm-review").isVisible());
  const saved = uniswap.locator(".uni-saved").first();
  const requests = JSON.parse((await saved.locator("details pre").textContent())!) as {
    id: string;
    approvalRequest: { requestId: string; to: string; valueWei: string; data: string };
    swapRequest: { requestId: string; to: string; valueWei: string; data: string };
  };
  expect(requests.approvalRequest.to.toLowerCase()).toBe(contracts.tokenA.toLowerCase());
  expect(requests.swapRequest.to.toLowerCase()).toBe(contracts.router.toLowerCase());
  expect(requests.approvalRequest.valueWei).toBe("0");
  expect(requests.swapRequest.valueWei).toBe("0");
  await expect(wallet.getByTestId("evm-review")).toContainText("Requested by uniswap · Installation");
  await expect(wallet.getByTestId("evm-review-request-id")).toHaveText(requests.approvalRequest.requestId);
  await expect(wallet.getByTestId("evm-review")).toContainText(new RegExp(contracts.router, "iu"));
  await startEvmKernelDialogAudit(page);
  await wallet.getByTestId("evm-review-approve").click();
  await expect(wallet.getByTestId("evm-review")).toHaveCount(0, { timeout: 120_000 });
  await expect.poll(() => chain.nonce(address), { timeout: 120_000 }).toBe(before.nonce + 1n);
  await expect(saved.getByRole("button", { name: "Check wallet status", exact: true })).toBeEnabled();
  await saved.getByRole("button", { name: "Check wallet status", exact: true }).click();
  await expect(saved.getByRole("button", { name: "Review swap", exact: true })).toBeVisible({ timeout: 120_000 });
  await expectNoEvmKernelDialogs(page);
  const approvalHref = await saved.getByRole("link", { name: /^Approval /u }).getAttribute("href");
  const approvalHash = approvalHref?.match(/0x[0-9a-f]{64}/iu)?.[0];
  if (!approvalHash) throw new Error("Uniswap has no approval transaction hash");
  const approvalEvidence = await chain.evidence(approvalHash);
  expect(approvalEvidence.from.toLowerCase()).toBe(address.toLowerCase());
  expect(approvalEvidence.to.toLowerCase()).toBe(contracts.tokenA.toLowerCase());
  expect(Transaction.from(approvalEvidence.raw).data).toBe(requests.approvalRequest.data);
  expect(await contracts.allowance(contracts.tokenA, address)).toBe(parseUnits("0.001", 18));
  expect(await contracts.balance(contracts.tokenA, address)).toBe(before.input);
  expect(await contracts.balance(contracts.tokenB, address)).toBe(before.output);

  // Approval is a completed financial step. Reload must preserve it and only
  // offer the still-unsubmitted swap with its original minimum/deadline bytes.
  await page.reload();
  await openEvmKitchen(page, runtime, false);
  uniswap = await openUniswap(page);
  const restored = uniswap.locator(".uni-saved").filter({ hasText: requests.id });
  await expect(restored).toHaveCount(1);
  expect(JSON.parse((await restored.locator("details pre").textContent())!)).toEqual(requests);
  expect(await chain.nonce(address)).toBe(before.nonce + 1n);
  await restored.getByRole("button", { name: "Review swap", exact: true }).click();
  const resumedWallet = page.frameLocator(WALLET_FRAME);
  await allowEvmInspectionGrantsUntil(page, () => resumedWallet.getByTestId("evm-review").isVisible());
  await expect(resumedWallet.getByTestId("evm-review-request-id")).toHaveText(requests.swapRequest.requestId);
  await expect(resumedWallet.getByTestId("evm-review")).toContainText("Requested by uniswap · Installation");
  await expect(resumedWallet.getByTestId("evm-review")).toContainText(new RegExp(contracts.router, "iu"));
  await startEvmKernelDialogAudit(page);
  await testInfo.attach("uniswap-wallet-review", { body: await page.screenshot(), contentType: "image/png" });
  await resumedWallet.getByTestId("evm-review-approve").click();
  await expect(resumedWallet.getByTestId("evm-review")).toHaveCount(0, { timeout: 120_000 });
  await expect.poll(() => chain.nonce(address), { timeout: 120_000 }).toBe(before.nonce + 2n);
  await expect(restored.getByRole("button", { name: "Check wallet status", exact: true })).toBeEnabled();
  await restored.getByRole("button", { name: "Check wallet status", exact: true }).click();
  await expect(restored).toContainText("Receipt: success", { timeout: 120_000 });
  await expectNoEvmKernelDialogs(page);
  const swapHref = await restored.getByRole("link", { name: /^Swap /u }).getAttribute("href");
  const swapHash = swapHref?.match(/0x[0-9a-f]{64}/iu)?.[0];
  if (!swapHash) throw new Error("Uniswap has no swap transaction hash");
  const swapEvidence = await chain.evidence(swapHash);
  expect(swapEvidence.from.toLowerCase()).toBe(address.toLowerCase());
  expect(swapEvidence.to.toLowerCase()).toBe(contracts.router.toLowerCase());
  expect(Transaction.from(swapEvidence.raw).data).toBe(requests.swapRequest.data);
  const actualInput = before.input - await contracts.balance(contracts.tokenA, address);
  const actualOutput = await contracts.balance(contracts.tokenB, address) - before.output;
  expect(actualInput).toBe(parseUnits("0.001", 18));
  expect(actualOutput).toBeGreaterThanOrEqual(minimumOut);
  expect(await contracts.allowance(contracts.tokenA, address)).toBe(0n);
  await restored.getByRole("button", { name: "Check wallet status", exact: true }).click();
  await expect(restored.getByRole("button", { name: "Check wallet status", exact: true })).toBeEnabled();
  expect(await chain.nonce(address)).toBe(before.nonce + 2n);
  await expect(restored.getByRole("button", { name: "Review exact approval", exact: true })).toHaveCount(0);
  await expect(restored.getByRole("button", { name: "Review swap", exact: true })).toHaveCount(0);
  await testInfo.attach("uniswap-official-contract-evidence", {
    body: JSON.stringify({ factory: contracts.factory, router: contracts.router, tokenA: contracts.tokenA, tokenB: contracts.tokenB, minimumOut: minimumOut.toString(), actualInput: actualInput.toString(), actualOutput: actualOutput.toString(), requests, approvalEvidence, swapEvidence }, null, 2),
    contentType: "application/json",
  });
});

async function openUniswap(page: Page): Promise<FrameLocator> {
  const selector = 'iframe[data-app-id="uniswap"][data-tile-id="uniswap"]';
  if (await page.locator(selector).count() === 0) {
    await page.locator('[data-tid="launcher-open"]').click();
    await page.locator('[data-tid="launcher-tile-uniswap-uniswap"]').click();
  }
  const frame = page.frameLocator(selector);
  await expect(frame.locator(".uni-app")).toBeVisible();
  return frame;
}

async function openEvmKitchen(page: Page, runtime: LocalNeutronRuntime, navigate = true): Promise<FrameLocator> {
  if (navigate) await page.goto(localCanisterOrigin(runtime.canisterId, runtime.gatewayUrl));
  await page.waitForFunction(() => typeof (window as typeof window & {
    __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: unknown;
  }).__NEUTRON_PLAYWRIGHT_LOGIN_AS__ === "function");
  const principal = await page.evaluate(async (seed) => {
    const login = (window as typeof window & {
      __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: (seed: number) => Promise<string>;
    }).__NEUTRON_PLAYWRIGHT_LOGIN_AS__;
    if (!login) throw new Error("Local-only Kernel login hook is unavailable");
    return login(seed);
  }, runtime.developerIdentitySeed);
  expect(principal).toBe(runtime.developerIdentityPrincipal);
  await expect(page.locator('[data-tid="auth-error"]')).toHaveCount(0);
  for (const appId of ["evm_wallet", "kitchensink"]) {
    await expect(page.locator(`[data-tid="app-background-frame"][data-app-id="${appId}"]`)).toHaveAttribute("data-resident-launch", "ready", { timeout: 120_000 });
  }
  if (await page.locator(KITCHEN_FRAME).count() === 0) {
    await page.locator('[data-tid="launcher-open"]').click();
    await page.locator('[data-tid="launcher-tile-kitchensink-main"]').click();
  }
  const kitchen = page.frameLocator(KITCHEN_FRAME);
  await expect(kitchen.locator('[data-tid="kitchen-tile-main"]')).toBeVisible();
  await kitchen.locator('[data-tid="kitchen-nav-evm_wallet"]').click();
  await expect(kitchen.locator('[data-tid="evm-wallet-intents"]')).toBeVisible();
  return kitchen;
}

async function discoverAccount(page: Page, kitchen: FrameLocator): Promise<string> {
  await kitchen.locator('[data-tid="evm-wallet-discover"]').click();
  await allowEvmInspectionGrantsUntil(page, () => kitchen.locator('[data-tid="evm-wallet-prepare"]').isEnabled());
  await kitchen.locator('[data-tid="evm-wallet-chain"]').selectOption("1");
  const option = await kitchen.getByLabel(/^Account/u).locator("option:checked").textContent();
  const address = option?.match(/0x[0-9a-f]{40}/iu)?.[0];
  if (!address) throw new Error(`EVM Wallet returned no account address: ${option}`);
  return getAddress(address);
}

async function prepareNative(kitchen: FrameLocator, recipient: string): Promise<{ card: Locator; record: EvmDemoRecord }> {
  await kitchen.locator('[data-tid="evm-wallet-kind"]').selectOption("native");
  await kitchen.locator('[data-tid="evm-wallet-destination"]').fill(recipient);
  await kitchen.locator('[data-tid="evm-wallet-amount"]').fill(AMOUNT_WEI);
  const cards = kitchen.locator('[data-tid="evm-wallet-intents"] [data-tid^="evm-intent-"]');
  const previous = await cards.count();
  await kitchen.locator('[data-tid="evm-wallet-prepare"]').click();
  await expect(cards).toHaveCount(previous + 1);
  const record = await savedRecord(cards.first());
  expect(record.intent.chainId).toBe("1");
  expect(record.intent.steps[0]?.request).toMatchObject({ to: recipient.toLowerCase(), valueWei: AMOUNT_WEI, data: "0x" });
  expect(record.progress[0]?.attempted).toBe(false);
  return { record, card: kitchen.locator(`[data-tid="evm-intent-${record.intent.id}"]`) };
}

async function savedRecord(card: Locator): Promise<EvmDemoRecord> {
  const value = await card.locator("details pre").textContent();
  if (!value) throw new Error("Saved consumer intent evidence is unavailable");
  return JSON.parse(value) as EvmDemoRecord;
}

async function expectReview(wallet: FrameLocator, record: EvmDemoRecord, recipient: string, address: string): Promise<void> {
  const review = wallet.getByTestId("evm-review");
  await expect(review).toBeVisible({ timeout: 120_000 });
  await expect(review).toHaveCount(1);
  await expect(review).toContainText("Requested by kitchensink · Installation");
  await expect(review).toContainText(new RegExp(recipient, "iu"));
  await expect(review).toContainText(new RegExp(address, "iu"));
  await expect(review).toContainText(`${AMOUNT_WEI} wei`);
  await expect(review).toContainText("Ethereum");
  await expect(review).toContainText("Maximum network fee");
  await expect(wallet.getByTestId("evm-review-request-id")).toHaveText(record.intent.id);
  await expect(wallet.getByTestId("evm-review-approve")).toBeEnabled();
}
