import { randomBytes } from "node:crypto";
import path from "node:path";
import { expect, test, type FrameLocator, type Locator, type Page } from "@playwright/test";
import { getAddress, Transaction } from "ethers";
import type { EvmBalancesResult, EvmReadContractResult } from "neutron-tools/evm_wallet";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
import { resolveLocalNeutronRuntime, type LocalNeutronRuntime } from "../../packages/neutron-provision/src/local_session.ts";
import type { EvmDemoRecord } from "../../apps/kitchensink/src/evm_wallet_demo.ts";
import { allowEvmInspectionGrantsUntil, expectNoEvmKernelDialogs, startEvmKernelDialogAudit } from "./fixtures/evm-wallet-browser.ts";
import { createEvmNetworkFixture } from "./fixtures/evm-wallet-network.ts";
import { createEvmSignatureFixtures, verifyEvmSignature, type EvmSignatureChainId } from "./fixtures/evm-wallet-signatures.ts";

// This matrix runs against unchanged installed app bundles and the actual
// Kernel chain-key signer. A coordinator must serialize each chain's financial
// window with the IC bridge, Uniswap and allowance specs sharing its account.
// The unforked 42161 fixture proves explicit network handling, not Nitro fees.
test.describe.configure({ retries: 0 });
test.beforeEach(({ page }) => page.setDefaultTimeout(20_000));
test.skip(path.basename(process.env.NEUTRON_NDEPLOY_CONFIG ?? "") !== "evm-wallet-local.ndeploy.json", "Requires the disposable EVM Wallet deployment and coordinated local networks");
const KITCHEN_FRAME = 'iframe[data-app-id="kitchensink"][data-tile-id="main"]';
const WALLET_FRAME = 'iframe[data-app-id="evm_wallet"][data-tile-id="evm_wallet"]';
const AMOUNT_WEI = "1000000000000";

for (const chainId of ["1", "42161"] as const) {
  test(`chain ${chainId}: live balances, native transfer and state-changing contract call through EVM Wallet`, async ({ page }, testInfo) => {
    test.setTimeout(600_000);
    const runtime = resolveLocalNeutronRuntime();
    const network = await createEvmNetworkFixture(chainId);
    const { chain } = network;
    const kitchen = await openKitchen(page, runtime);
    const address = await discoverAccount(page, kitchen, chainId);
    await network.fund(address);
    const balanceRead = await readBalances(page, kitchen, chainId, address);
    expect(BigInt(balanceRead.nativeBalanceWei)).toBe(await chain.balance(address));
    const recipient = getAddress(`0x${randomBytes(20).toString("hex")}`);
    const before = { nonce: await chain.nonce(address), balance: await chain.balance(address), recipient: await chain.balance(recipient) };
    const prepared = await prepareNative(kitchen, recipient, chainId);
    await prepared.card.getByRole("button", { name: "Request wallet review: step 1", exact: true }).click();
    const wallet = page.frameLocator(WALLET_FRAME);
    await allowEvmInspectionGrantsUntil(page, () => wallet.getByTestId("evm-review").isVisible());
    await assertReview(wallet, chainId, address, prepared.record.intent.id);
    await expect(wallet.getByTestId("evm-review")).toContainText("Requested by kitchensink · Installation");
    await expect(wallet.getByTestId("evm-review")).toContainText(new RegExp(recipient, "iu"));
    await expect(wallet.getByTestId("evm-review")).toContainText(`${AMOUNT_WEI} wei`);
    await startEvmKernelDialogAudit(page);
    await wallet.getByTestId("evm-review-approve").click();
    await expect.poll(async () => !!(await savedRecord(prepared.card)).progress[0]?.operation?.transactionHash, { timeout: 180_000 }).toBe(true);
    const nativeHash = (await savedRecord(prepared.card)).progress[0]!.operation!.transactionHash!;
    await expect.poll(() => chain.nonce(address), { timeout: 60_000 }).toBe(before.nonce + 1n);
    const native = await chain.evidence(nativeHash);
    expect(native).toMatchObject({ chainId, valueWei: AMOUNT_WEI });
    expect(native.from.toLowerCase()).toBe(address.toLowerCase());
    expect(native.to.toLowerCase()).toBe(recipient.toLowerCase());
    expect(BigInt(native.nonce)).toBe(before.nonce);
    expect(Transaction.from(native.raw).data).toBe("0x");
    expect(await chain.balance(recipient)).toBe(before.recipient + BigInt(AMOUNT_WEI));
    expect(await chain.balance(address)).toBe(before.balance - BigInt(AMOUNT_WEI) - BigInt(native.gasUsed) * BigInt(native.effectiveGasPriceWei));
    await reconcileNative(page, prepared.card);
    await expectNoEvmKernelDialogs(page);

    const storage = await network.deployStorage();
    const initial = await readStorage(page, kitchen, chainId, address, storage.address);
    expect(BigInt(initial.result)).toBe(0n);
    expect(initial.code.toLowerCase()).toBe(storage.runtime);
    const stored = (1n << 200n) + 9007199254740993n;
    const calldata = `0x${stored.toString(16).padStart(64, "0")}`;
    const callBefore = { nonce: await chain.nonce(address), balance: await chain.balance(address) };
    await wallet.getByTestId("evm-network-select").selectOption(chainId);
    await wallet.getByRole("navigation", { name: "Wallet pages" }).getByRole("button", { name: "Send", exact: true }).click();
    await wallet.getByRole("combobox", { name: "Asset", exact: true }).selectOption("native");
    await wallet.getByTestId("evm-send-to").fill(storage.address);
    await wallet.getByTestId("evm-send-amount").fill("0");
    await wallet.getByLabel("Include contract calldata", { exact: true }).check();
    await wallet.getByRole("textbox", { name: "Exact calldata", exact: true }).fill(calldata);
    await wallet.getByTestId("evm-send-review").click();
    await expect(wallet.getByText("Current request awaiting resolution", { exact: true })).toBeVisible();
    await expect(wallet.getByTestId("evm-review")).toBeVisible({ timeout: 120_000 });
    const contractRequestId = (await wallet.getByTestId("evm-review-request-id").textContent())!;
    await assertReview(wallet, chainId, address, contractRequestId);
    await expect(wallet.getByTestId("evm-review")).toContainText("Requested by evm_wallet · Installation");
    await expect(wallet.getByTestId("evm-review")).toContainText(new RegExp(storage.address, "iu"));
    expect(await wallet.getByTestId("evm-review").locator("pre").allTextContents()).toContain(calldata);
    await startEvmKernelDialogAudit(page);
    await wallet.getByTestId("evm-review-approve").click();
    const notice = wallet.locator('form [role="status"]').filter({ hasText: /^Operation /u });
    await expect(notice).toContainText(/0x[0-9a-f]{64}/iu, { timeout: 180_000 });
    const callHash = (await notice.textContent())!.match(/0x[0-9a-f]{64}/iu)![0];
    const call = await chain.evidence(callHash);
    expect(call).toMatchObject({ chainId, valueWei: "0" });
    expect(call.from.toLowerCase()).toBe(address.toLowerCase());
    expect(call.to.toLowerCase()).toBe(storage.address.toLowerCase());
    expect(BigInt(call.nonce)).toBe(callBefore.nonce);
    expect(Transaction.from(call.raw).data).toBe(calldata);
    expect(await chain.nonce(address)).toBe(callBefore.nonce + 1n);
    expect(await chain.balance(address)).toBe(callBefore.balance - BigInt(call.gasUsed) * BigInt(call.effectiveGasPriceWei));
    expect(BigInt(await chain.rpc<string>("eth_getStorageAt", [storage.address, "0x0", "latest"]))).toBe(stored);
    const final = await readStorage(page, kitchen, chainId, address, storage.address);
    expect(final.result).toBe(calldata);
    await expectNoEvmKernelDialogs(page);
    await testInfo.attach(`chain-${chainId}-execution`, { contentType: "application/json", body: JSON.stringify({
      canisterId: runtime.canisterId, gatewayUrl: runtime.gatewayUrl,
      chainId, rpcUrl: network.rpcUrl, clientVersion: network.clientVersion, executionFixture: network.nodeKind,
      scope: "Actual app chain-key signing and independent EVM execution; no Nitro parent fee or finality claim", address,
      balanceRead, native, nativeOperation: (await savedRecord(prepared.card)).progress[0]?.operation,
      contract: { requestId: contractRequestId, fixture: storage, initial, calldata, transaction: call, final },
    }, null, 2) });
  });

  test(`chain ${chainId}: personal, exact EIP-712 and permit signatures recover the actual chain-key account`, async ({ page }, testInfo) => {
    test.setTimeout(600_000);
    // Exploratory signatures may share a fixture with an unrelated incoming
    // redemption. Final qualification keeps the default balance invariant.
    const exploratorySmoke = process.env.NEUTRON_EVM_SIGNATURE_SMOKE_ONLY === "1";
    if (exploratorySmoke) testInfo.annotations.push({ type: "exploratory", description: "Concurrent incoming redemption may change native balance; not final qualification evidence" });
    const runtime = resolveLocalNeutronRuntime();
    const network = await createEvmNetworkFixture(chainId);
    const kitchen = await openKitchen(page, runtime);
    const address = await discoverAccount(page, kitchen, chainId);
    const wallet = await openWallet(page);
    await wallet.getByTestId("evm-network-select").selectOption(chainId);
    await wallet.getByRole("navigation", { name: "Wallet pages" }).getByRole("button", { name: "Sign", exact: true }).click();
    const before = { nonce: await network.chain.nonce(address), balance: await network.chain.balance(address) };
    const fixtures = createEvmSignatureFixtures({ address, chainId, invocationId: randomBytes(16).toString("hex") });
    const evidence = [];
    for (const fixture of Object.values(fixtures)) {
      await wallet.getByTestId("evm-sign-mode").selectOption(fixture.kind);
      const content = fixture.kind === "message" ? fixture.message : fixture.request.typedDataJson;
      await wallet.getByTestId("evm-sign-content").fill(content);
      await wallet.getByTestId("evm-sign-review").click();
      // Creating the saved request is synchronous UI work. A sandbox-blocked
      // native form submit must fail here, before waiting on backend review.
      await expect(wallet.getByTestId("evm-sign-current")).toBeVisible();
      await expect(wallet.getByTestId("evm-review")).toBeVisible({ timeout: 120_000 });
      const requestId = (await wallet.getByTestId("evm-review-request-id").textContent())!;
      await assertReview(wallet, chainId, address, requestId);
      await expect(wallet.getByTestId("evm-review")).toContainText("Requested by evm_wallet · Installation");
      await expect(wallet.getByTestId("evm-sign-current")).toContainText(`Request ${requestId} · Chain ${chainId}`);
      // Exact text comparison catches uint256 literals rounded by browser JSON.
      expect(await wallet.getByTestId("evm-review").locator("pre").allTextContents()).toContain(content);
      await startEvmKernelDialogAudit(page);
      await wallet.getByTestId("evm-review-approve").click();
      await expect(wallet.getByTestId("evm-sign-result")).toBeVisible({ timeout: 180_000 });
      const signature = (await wallet.getByTestId("evm-sign-result").textContent())!;
      const verified = await verifyEvmSignature(fixture, signature);
      const result = await wallet.getByTestId("evm-sign-result").locator('xpath=..').textContent();
      expect(result).toMatch(/Operation .+: signed/u);
      evidence.push({ name: fixture.name, requestId, result, ...verified });
      await expectNoEvmKernelDialogs(page);
      expect(await network.chain.nonce(address)).toBe(before.nonce);
      if (!exploratorySmoke) expect(await network.chain.balance(address)).toBe(before.balance);
      await wallet.getByRole("button", { name: "New signature", exact: true }).click();
    }
    await testInfo.attach(`chain-${chainId}-signatures`, { contentType: "application/json", body: JSON.stringify({ exploratorySmoke, canisterId: runtime.canisterId, gatewayUrl: runtime.gatewayUrl, chainId, clientVersion: network.clientVersion, address, evidence }, null, 2) });
  });
}

async function openKitchen(page: Page, runtime: LocalNeutronRuntime): Promise<FrameLocator> {
  await page.goto(localCanisterOrigin(runtime.canisterId, runtime.gatewayUrl));
  await page.waitForFunction(() => typeof (window as typeof window & { __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: unknown }).__NEUTRON_PLAYWRIGHT_LOGIN_AS__ === "function");
  const principal = await page.evaluate(async (seed) => {
    const login = (window as typeof window & { __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: (seed: number) => Promise<string> }).__NEUTRON_PLAYWRIGHT_LOGIN_AS__;
    if (!login) throw new Error("Local-only Kernel login hook is unavailable");
    return login(seed);
  }, runtime.developerIdentitySeed);
  expect(principal).toBe(runtime.developerIdentityPrincipal);
  for (const appId of ["evm_wallet", "kitchensink"]) await expect(page.locator(`[data-tid="app-background-frame"][data-app-id="${appId}"]`)).toHaveAttribute("data-resident-launch", "ready", { timeout: 120_000 });
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

async function openWallet(page: Page): Promise<FrameLocator> {
  if (await page.locator(WALLET_FRAME).count() === 0) {
    await page.locator('[data-tid="launcher-open"]').click();
    await page.locator('[data-tid="launcher-tile-evm_wallet-evm_wallet"]').click();
  }
  const wallet = page.frameLocator(WALLET_FRAME);
  await expect(wallet.getByTestId("evm-network-select")).toBeEnabled({ timeout: 120_000 });
  return wallet;
}

async function discoverAccount(page: Page, kitchen: FrameLocator, chainId: EvmSignatureChainId): Promise<string> {
  await kitchen.locator('[data-tid="evm-wallet-discover"]').click();
  await allowEvmInspectionGrantsUntil(page, () => kitchen.locator('[data-tid="evm-wallet-prepare"]').isEnabled());
  await expect(kitchen.locator('[data-tid="evm-wallet-chain"] option[value="1"]')).toHaveCount(1);
  await expect(kitchen.locator('[data-tid="evm-wallet-chain"] option[value="42161"]')).toHaveCount(1);
  await kitchen.locator('[data-tid="evm-wallet-chain"]').selectOption(chainId);
  const option = await kitchen.getByLabel(/^Account/u).locator("option:checked").textContent();
  const address = option?.match(/0x[0-9a-f]{40}/iu)?.[0];
  if (!address) throw new Error(`EVM Wallet returned no account address: ${option}`);
  return getAddress(address);
}

async function readResult<T>(page: Page, kitchen: FrameLocator): Promise<T> {
  const evidence = kitchen.locator('[data-tid="evm-wallet-evidence"]');
  await allowEvmInspectionGrantsUntil(page, async () => await evidence.getAttribute("aria-busy") === "false" && await evidence.locator("pre").count() === 1);
  await expect(evidence).toHaveAttribute("role", "status");
  return JSON.parse((await evidence.locator("pre").textContent())!) as T;
}

async function readBalances(page: Page, kitchen: FrameLocator, chainId: string, address: string): Promise<EvmBalancesResult> {
  await kitchen.locator('[data-tid="evm-wallet-token"]').fill("");
  await kitchen.getByRole("button", { name: "Read native and selected token balances", exact: true }).click();
  const result = await readResult<EvmBalancesResult>(page, kitchen);
  expect(result).toMatchObject({ chainId, accountId: "main", tokens: [], completeness: "requested_only" });
  expect(result.address.toLowerCase()).toBe(address.toLowerCase());
  expect(BigInt(result.blockNumber)).toBeGreaterThanOrEqual(0n);
  expect(BigInt(result.observedAtNs)).toBeGreaterThan(0n);
  return result;
}

async function readStorage(page: Page, kitchen: FrameLocator, chainId: string, address: string, to: string): Promise<EvmReadContractResult> {
  await kitchen.getByLabel("Read-only contract address", { exact: true }).fill(to);
  await kitchen.getByLabel("Read calldata (hex)", { exact: true }).fill("0x");
  await kitchen.getByRole("button", { name: "Read contract without signing", exact: true }).click();
  const result = await readResult<EvmReadContractResult>(page, kitchen);
  expect(result).toMatchObject({ chainId, accountId: "main", data: "0x" });
  expect(result.to.toLowerCase()).toBe(to.toLowerCase());
  expect(result.address.toLowerCase()).toBe(address.toLowerCase());
  expect(BigInt(result.blockNumber)).toBeGreaterThanOrEqual(0n);
  expect(BigInt(result.observedAtNs)).toBeGreaterThan(0n);
  return result;
}

async function prepareNative(kitchen: FrameLocator, recipient: string, chainId: string): Promise<{ card: Locator; record: EvmDemoRecord }> {
  await kitchen.locator('[data-tid="evm-wallet-kind"]').selectOption("native");
  await kitchen.locator('[data-tid="evm-wallet-destination"]').fill(recipient);
  await kitchen.locator('[data-tid="evm-wallet-amount"]').fill(AMOUNT_WEI);
  const cards = kitchen.locator('[data-tid="evm-wallet-intents"] [data-tid^="evm-intent-"]');
  const previous = await cards.count();
  await kitchen.locator('[data-tid="evm-wallet-prepare"]').click();
  await expect(cards).toHaveCount(previous + 1);
  const record = await savedRecord(cards.first());
  expect(record.intent.chainId).toBe(chainId);
  expect(record.intent.steps[0]?.request).toMatchObject({ to: recipient.toLowerCase(), valueWei: AMOUNT_WEI, data: "0x" });
  return { record, card: kitchen.locator(`[data-tid="evm-intent-${record.intent.id}"]`) };
}

async function savedRecord(card: Locator): Promise<EvmDemoRecord> {
  return JSON.parse((await card.locator("details pre").textContent())!) as EvmDemoRecord;
}

async function reconcileNative(page: Page, card: Locator): Promise<void> {
  if ((await savedRecord(card)).progress[0]?.operation?.status !== "confirmed") {
    await card.getByRole("button", { name: "Reconcile or resume saved request", exact: true }).click();
    await allowEvmInspectionGrantsUntil(page, async () => (await savedRecord(card)).progress[0]?.operation?.status === "confirmed");
  }
  expect((await savedRecord(card)).progress[0]?.operation?.receipt?.status).toBe("success");
}

async function assertReview(wallet: FrameLocator, chainId: string, address: string, requestId: string): Promise<void> {
  const review = wallet.getByTestId("evm-review");
  await expect(review).toHaveCount(1);
  await expect(review).toContainText(`${chainId === "1" ? "Ethereum" : "Arbitrum One"} · ${chainId}`);
  await expect(review).toContainText(new RegExp(address, "iu"));
  await expect(wallet.getByTestId("evm-review-request-id")).toHaveText(requestId);
  await expect(wallet.getByTestId("evm-review-approve")).toBeEnabled();
}
