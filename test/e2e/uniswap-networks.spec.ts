import { randomBytes } from "node:crypto";
import path from "node:path";
import { expect, test, type FrameLocator, type Locator, type Page } from "@playwright/test";
import { getAddress, Interface, parseUnits, Transaction } from "ethers";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
import { resolveLocalNeutronRuntime } from "../../packages/neutron-provision/src/local_session.ts";
import type { EvmSendTransactionRequest } from "../../packages/neutron-tools/src/evm_wallet.ts";
import { allowEvmInspectionGrantsUntil, expectNoEvmKernelDialogs, installEvmWalletBrowserFaults, readEvmWalletFault, setEvmWalletFault, startEvmKernelDialogAudit } from "./fixtures/evm-wallet-browser.ts";
import { createEvmNetworkFixture, type EvmNetworkFixture } from "./fixtures/evm-wallet-network.ts";
import { createUniswapNetworkFixture, withStableUniswapQuote, type UniswapNetworkFixture, type UniswapQuoteMiningEvidence } from "./fixtures/uniswap-network.ts";

// Run with one worker during the coordinator's exclusive Wallet nonce window.
// These are real Kernel/consumer/Wallet/chain-key signatures and official V3
// execution, on explicitly selected disposable, unforked local Anvil chains.
// Local chain 42161 does not establish Nitro posting fees or L1 finality.
test.describe.configure({ retries: 0 });
test.beforeEach(({ page }) => { page.setDefaultTimeout(20_000); });
test.skip(path.basename(process.env.NEUTRON_NDEPLOY_CONFIG ?? "") !== "evm-wallet-local.ndeploy.json", "Requires the dedicated disposable EVM Wallet PocketIC/Anvil deployment");

const UNISWAP_FRAME = 'iframe[data-app-id="uniswap"][data-tile-id="uniswap"]';
const WALLET_FRAME = 'iframe[data-app-id="evm_wallet"][data-tile-id="evm_wallet"]';
const AMOUNT = "0.001";
const ATOMS = parseUnits(AMOUNT, 18);
const approveAbi = new Interface(["function approve(address spender,uint256 amount) returns (bool)"]);
const routerAbi = new Interface([
  "function multicall(uint256 deadline,bytes[] data) payable returns (bytes[] results)",
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function refundETH() payable",
]);
type SavedRequests = { id: string; approvalRequest: EvmSendTransactionRequest | null; swapRequest: EvmSendTransactionRequest };
const fixtures = new Map<string, { network: EvmNetworkFixture; contracts: UniswapNetworkFixture }>();

for (const chainId of ["1", "42161"] as const) {
  for (const route of ["native-to-token", "token-to-token"] as const) {
    test(`chain ${chainId}: ${route} uses separate Wallet decisions and recovers its saved swap`, async ({ page }, testInfo) => {
      test.setTimeout(720_000);
      let fixture = fixtures.get(chainId);
      if (!fixture) {
        const network = await createEvmNetworkFixture(chainId);
        fixture = { network, contracts: await createUniswapNetworkFixture(network) };
        fixtures.set(chainId, fixture);
      }
      const { network, contracts } = fixture;
      const { chain } = network;
      let quoteNumber = 0;
      const recordQuoteMining = async (evidence: UniswapQuoteMiningEvidence) => {
        await testInfo.attach(`quote-mining-${++quoteNumber}`, { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
      };
      const native = route === "native-to-token";
      const tokenOut = native ? contracts.tokenA : contracts.tokenB;
      await installEvmWalletBrowserFaults(page, ["evm_wallet", "uniswap"]);
      let uniswap = await openUniswap(page);
      await uniswap.getByRole("button", { name: "Connect EVM Wallet", exact: true }).click();
      const connected = uniswap.getByRole("button", { name: "Refresh wallet", exact: true });
      await allowEvmInspectionGrantsUntil(page, async () => await connected.isVisible() && await connected.isEnabled());
      await uniswap.getByLabel(/^Network/u).selectOption(chainId);
      await uniswap.getByText("Swap settings and custom token", { exact: true }).click();
      const address = getAddress(await uniswap.getByLabel("Recipient", { exact: true }).inputValue());
      await contracts.fund(address);
      const recipient = getAddress(`0x${randomBytes(20).toString("hex")}`);
      expect(recipient).not.toBe(address);
      for (const token of [contracts.tokenA, contracts.tokenB]) {
        await uniswap.getByLabel("Custom token contract", { exact: true }).fill(token);
        await uniswap.getByRole("button", { name: "Read and add token", exact: true }).click();
        await allowEvmInspectionGrantsUntil(page, async () => await uniswap.getByLabel("Input token", { exact: true }).locator(`option[value="${token.toLowerCase()}"]`).count() === 1);
      }
      await uniswap.getByLabel("Input token", { exact: true }).selectOption(native ? "native" : contracts.tokenA.toLowerCase());
      await uniswap.getByLabel("Output token", { exact: true }).selectOption(tokenOut.toLowerCase());
      await uniswap.getByLabel("Input amount", { exact: true }).fill(AMOUNT);
      await uniswap.getByLabel("Recipient", { exact: true }).fill(recipient);
      const before = {
        nonce: await chain.nonce(address), native: await chain.balance(address),
        input: await contracts.balance(contracts.tokenA, address),
        recipientOutput: await contracts.balance(tokenOut, recipient),
        accountOutput: await contracts.balance(tokenOut, address),
      };
      if (!native) expect(await contracts.allowance(contracts.tokenA, address), "The isolated route starts with no outstanding fixture-token allowance").toBe(0n);
      const wallet = page.frameLocator(WALLET_FRAME);

      // A declined native swap proves that quote/account access is insufficient
      // authority for a financial effect on each selected network.
      let declined: SavedRequests | null = null;
      if (native) {
        await requestQuote(page, uniswap, true, network, recordQuoteMining);
        await uniswap.getByRole("button", { name: "Review swap in EVM Wallet", exact: true }).click();
        await allowEvmInspectionGrantsUntil(page, () => wallet.getByTestId("evm-review").isVisible());
        const card = uniswap.locator(".uni-saved").first();
        declined = await savedRequests(card);
        expect(declined.approvalRequest).toBeNull();
        await expectWalletRequest(wallet, declined.swapRequest, address, chainId);
        await wallet.getByTestId("evm-review-decline").click();
        await expect(card).toContainText("rejected", { timeout: 120_000 });
        await expect(card.getByRole("button", { name: "Check wallet status", exact: true })).toBeEnabled();
        expect(await chain.nonce(address)).toBe(before.nonce);
        expect(await chain.balance(address)).toBe(before.native);
        expect(await contracts.balance(tokenOut, recipient)).toBe(before.recipientOutput);
      }

      const { minimumOut, priceImpactPercent } = await requestQuote(page, uniswap, native, network, recordQuoteMining);
      if (native) await setEvmWalletFault(uniswap, "dropNextTransactionReply");
      await uniswap.getByRole("button", { name: native ? "Review swap in EVM Wallet" : "Save swap and review approval", exact: true }).click();
      await allowEvmInspectionGrantsUntil(page, () => wallet.getByTestId("evm-review").isVisible());
      let card = uniswap.locator(".uni-saved").first();
      const requests = await savedRequests(card);
      if (declined) expect(requests.id).not.toBe(declined.id);
      expect(requests.swapRequest.chainId).toBe(chainId);
      expect(requests.swapRequest.to.toLowerCase()).toBe(contracts.router.toLowerCase());
      expect(requests.swapRequest.valueWei).toBe(native ? ATOMS.toString() : "0");
      assertSwapCalldata(requests.swapRequest, contracts, recipient, minimumOut, native);
      let approvalEvidence: Awaited<ReturnType<typeof chain.evidence>> | null = null;

      if (!native) {
        const approval = requests.approvalRequest;
        expect(approval).not.toBeNull();
        if (!approval) throw new Error("Token route requires an exact approval");
        expect(approval.chainId).toBe(chainId);
        expect(approval.to.toLowerCase()).toBe(contracts.tokenA.toLowerCase());
        expect(approval.valueWei).toBe("0");
        expect(approval.requestId).not.toBe(requests.swapRequest.requestId);
        const decoded = approveAbi.decodeFunctionData("approve", approval.data!);
        expect(getAddress(decoded.spender)).toBe(contracts.router);
        expect(decoded.amount).toBe(ATOMS);
        await expectWalletRequest(wallet, approval, address, chainId);
        await expect(wallet.getByTestId("evm-review")).toContainText(new RegExp(contracts.router, "iu"));
        await startEvmKernelDialogAudit(page);
        await wallet.getByTestId("evm-review-approve").click();
        await expect(wallet.getByTestId("evm-review")).toHaveCount(0, { timeout: 120_000 });
        await expect.poll(() => chain.nonce(address), { timeout: 120_000 }).toBe(before.nonce + 1n);
        await expectNoEvmKernelDialogs(page);
        await reconcile(page, card, "Review swap");
        approvalEvidence = await chain.evidence(await transactionHash(card, "Approval"));
        expect(approvalEvidence.chainId).toBe(chainId);
        expect(approvalEvidence.from.toLowerCase()).toBe(address.toLowerCase());
        expect(Transaction.from(approvalEvidence.raw).data).toBe(approval.data);
        expect(await contracts.allowance(contracts.tokenA, address)).toBe(ATOMS);
        expect(await contracts.balance(contracts.tokenA, address)).toBe(before.input);
        expect(await contracts.balance(tokenOut, recipient)).toBe(before.recipientOutput);
        // Complete approval, incomplete swap: restore the exact saved requests
        // and require a second Wallet decision for the still-unsubmitted step.
        await page.reload(); uniswap = await openUniswap(page, false);
        card = savedCard(uniswap, requests.id);
        expect(await savedRequests(card)).toEqual(requests);
        expect(await chain.nonce(address)).toBe(before.nonce + 1n);
        await card.getByRole("button", { name: "Review swap", exact: true }).click();
        await allowEvmInspectionGrantsUntil(page, () => wallet.getByTestId("evm-review").isVisible());
      } else {
        expect(requests.approvalRequest).toBeNull();
      }

      await expectWalletRequest(wallet, requests.swapRequest, address, chainId);
      await startEvmKernelDialogAudit(page);
      await testInfo.attach("swap-wallet-review", { body: await page.screenshot(), contentType: "image/png" });
      await wallet.getByTestId("evm-review-approve").click();
      const expectedNonce = before.nonce + (native ? 1n : 2n);
      await expect.poll(() => chain.nonce(address), { timeout: 120_000 }).toBe(expectedNonce);
      let lostReply: Record<string, unknown> | null = null;
      if (native) {
        await expect.poll(async () => (await readEvmWalletFault(uniswap)).droppedReply !== null, { timeout: 120_000 }).toBe(true);
        lostReply = (await readEvmWalletFault(uniswap)).droppedReply;
        expect(lostReply).toMatchObject({ requestId: requests.swapRequest.requestId, chainId });
        await expectNoEvmKernelDialogs(page);
        await page.reload(); uniswap = await openUniswap(page, false);
        card = savedCard(uniswap, requests.id);
        expect(await savedRequests(card)).toEqual(requests);
        // The successful Wallet reply was actually dropped; only status on
        // the original saved request can discover its already-sent bytes.
        await expect(card.getByRole("link", { name: /^Swap /u })).toHaveCount(0);
        expect(await chain.nonce(address)).toBe(expectedNonce);
      } else {
        await expect(wallet.getByTestId("evm-review")).toHaveCount(0, { timeout: 120_000 });
        await expectNoEvmKernelDialogs(page);
      }
      await reconcile(page, card, "Receipt: success");
      const swapHash = await transactionHash(card, "Swap");
      if (lostReply) expect(swapHash).toBe(lostReply.transactionHash);
      const swapEvidence = await chain.evidence(swapHash);
      expect(swapEvidence.chainId).toBe(chainId);
      expect(swapEvidence.from.toLowerCase()).toBe(address.toLowerCase());
      expect(swapEvidence.to.toLowerCase()).toBe(contracts.router.toLowerCase());
      expect(swapEvidence.valueWei).toBe(requests.swapRequest.valueWei);
      expect(Transaction.from(swapEvidence.raw).data).toBe(requests.swapRequest.data);
      const actualOutput = await contracts.balance(tokenOut, recipient) - before.recipientOutput;
      expect(actualOutput).toBeGreaterThanOrEqual(minimumOut);
      expect(await contracts.balance(tokenOut, address)).toBe(before.accountOutput);
      if (native) {
        const actualNetworkFee = BigInt(swapEvidence.gasUsed) * BigInt(swapEvidence.effectiveGasPriceWei);
        expect(before.native - await chain.balance(address)).toBe(ATOMS + actualNetworkFee);
      } else {
        expect(before.input - await contracts.balance(contracts.tokenA, address)).toBe(ATOMS);
        expect(await contracts.allowance(contracts.tokenA, address)).toBe(0n);
      }
      await page.reload(); uniswap = await openUniswap(page, false);
      card = savedCard(uniswap, requests.id);
      expect(await savedRequests(card)).toEqual(requests);
      await expect(card).toContainText("Receipt: success");
      await reconcile(page, card, "Receipt: success");
      expect(await chain.nonce(address)).toBe(expectedNonce);
      expect(await transactionHash(card, "Swap")).toBe(swapHash);
      await expect(card.getByRole("button", { name: "Review exact approval", exact: true })).toHaveCount(0);
      await expect(card.getByRole("button", { name: "Review swap", exact: true })).toHaveCount(0);
      await testInfo.attach("network-swap-evidence", {
        body: JSON.stringify({ chainId, route, node: network.clientVersion, qualification: "Local unforked Anvil execution; Nitro posting fees, sequencer behavior and L1 finality are not exercised", factory: contracts.factory, router: contracts.router, pools: contracts.pools, tokenIn: native ? null : contracts.tokenA, tokenOut, recipient, priceImpactPercent, minimumOut: minimumOut.toString(), actualOutput: actualOutput.toString(), requests, declined, lostReply, approvalEvidence, swapEvidence }, null, 2),
        contentType: "application/json",
      });
    });
  }
}

async function openUniswap(page: Page, navigate = true): Promise<FrameLocator> {
  const runtime = resolveLocalNeutronRuntime();
  if (navigate) await page.goto(localCanisterOrigin(runtime.canisterId, runtime.gatewayUrl));
  await page.waitForFunction(() => typeof (window as typeof window & { __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: unknown }).__NEUTRON_PLAYWRIGHT_LOGIN_AS__ === "function");
  const principal = await page.evaluate(async (seed) => {
    const login = (window as typeof window & { __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: (seed: number) => Promise<string> }).__NEUTRON_PLAYWRIGHT_LOGIN_AS__;
    if (!login) throw new Error("Local-only Kernel login hook is unavailable");
    return login(seed);
  }, runtime.developerIdentitySeed);
  expect(principal).toBe(runtime.developerIdentityPrincipal);
  await expect(page.locator('[data-tid="auth-error"]')).toHaveCount(0);
  for (const appId of ["evm_wallet", "uniswap"]) await expect(page.locator(`[data-tid="app-background-frame"][data-app-id="${appId}"]`)).toHaveAttribute("data-resident-launch", "ready", { timeout: 120_000 });
  if (await page.locator(UNISWAP_FRAME).count() === 0) {
    await page.locator('[data-tid="launcher-open"]').click();
    await page.locator('[data-tid="launcher-tile-uniswap-uniswap"]').click();
  }
  const uniswap = page.frameLocator(UNISWAP_FRAME);
  await expect(uniswap.locator(".uni-app")).toBeVisible();
  return uniswap;
}
async function requestQuote(page: Page, uniswap: FrameLocator, native: boolean, network: EvmNetworkFixture, recordMining: (evidence: UniswapQuoteMiningEvidence) => Promise<void>): Promise<{ minimumOut: bigint; priceImpactPercent: string }> {
  const read = () => readQuote(page, uniswap, native, network.chainId);
  return network.chainId === "1" ? withStableUniswapQuote(network, read, recordMining) : read();
}
async function readQuote(page: Page, uniswap: FrameLocator, native: boolean, chainId: "1" | "42161"): Promise<{ minimumOut: bigint; priceImpactPercent: string }> {
  await uniswap.getByRole("button", { name: "Get quote", exact: true }).click();
  const save = uniswap.getByRole("button", { name: native ? "Review swap in EVM Wallet" : "Save swap and review approval", exact: true });
  await allowEvmInspectionGrantsUntil(page, async () => await save.isVisible() && await save.isEnabled());
  const minimum = await uniswap.locator(".uni-review").getByText("Minimum received", { exact: true }).locator("xpath=following-sibling::dd[1]").textContent();
  if (!minimum) throw new Error("Uniswap quote omitted its minimum output");
  const atoms = parseUnits(minimum.trim().split(/\s+/u)[0]!, 18);
  expect(atoms).toBeGreaterThan(0n);
  const priceImpact = uniswap.locator(".uni-review").getByText("Price impact excluding pool fee", { exact: true }).locator("xpath=following-sibling::dd[1]");
  const priceImpactPercent = (await priceImpact.textContent())?.trim() ?? "";
  if (chainId === "1") {
    // The final Ethereum qualification runs after the large factory-code read
    // fix. Its seeded official pool must produce a numeric impact, not hide a
    // failed getPool/slot0 read behind the app's valid unavailable state.
    expect(priceImpactPercent, "The seeded official V3 pool must return numeric price impact").toMatch(/^-?\d+(?:\.\d+)?%$/u);
    expect(Number.isFinite(Number(priceImpactPercent.slice(0, -1)))).toBe(true);
  }
  return { minimumOut: atoms, priceImpactPercent };
}
function savedCard(uniswap: FrameLocator, id: string): Locator { return uniswap.locator(".uni-saved").filter({ hasText: id }); }
async function savedRequests(card: Locator): Promise<SavedRequests> {
  const value = await card.locator("details pre").textContent();
  if (!value) throw new Error("Uniswap saved request evidence is unavailable");
  return JSON.parse(value) as SavedRequests;
}
async function transactionHash(card: Locator, stage: "Approval" | "Swap"): Promise<string> {
  const href = await card.getByRole("link", { name: new RegExp(`^${stage} `, "u") }).getAttribute("href");
  const hash = href?.match(/0x[0-9a-f]{64}/iu)?.[0];
  if (!hash) throw new Error(`Uniswap omitted the ${stage} hash`);
  return hash;
}
async function reconcile(page: Page, card: Locator, outcome: "Review swap" | "Receipt: success"): Promise<void> {
  const button = card.getByRole("button", { name: "Check wallet status", exact: true });
  await expect(button).toBeEnabled({ timeout: 120_000 });
  await button.click();
  await allowEvmInspectionGrantsUntil(page, async () => outcome === "Review swap" ? await card.getByRole("button", { name: outcome, exact: true }).isVisible() : (await card.textContent())?.includes(outcome) ?? false);
  await expect(button).toBeEnabled({ timeout: 120_000 });
}
async function expectWalletRequest(wallet: FrameLocator, request: EvmSendTransactionRequest, address: string, chainId: string): Promise<void> {
  const review = wallet.getByTestId("evm-review");
  await expect(review).toHaveCount(1);
  await expect(review).toContainText("Requested by uniswap · Installation");
  await expect(review).toContainText(new RegExp(address, "iu"));
  await expect(review).toContainText(new RegExp(request.to, "iu"));
  await expect(review).toContainText(chainId === "1" ? "Ethereum" : "Arbitrum");
  await expect(review).toContainText("Maximum network fee");
  await expect(wallet.getByTestId("evm-review-request-id")).toHaveText(request.requestId);
  await expect(wallet.getByTestId("evm-review-approve")).toBeEnabled();
}
function assertSwapCalldata(request: EvmSendTransactionRequest, contracts: UniswapNetworkFixture, recipient: string, minimum: bigint, native: boolean) {
  const multicall = routerAbi.decodeFunctionData("multicall", request.data!);
  expect(multicall.deadline).toBeGreaterThan(BigInt(Math.floor(Date.now() / 1000)));
  expect(multicall.data).toHaveLength(native ? 2 : 1);
  const params = routerAbi.decodeFunctionData("exactInputSingle", multicall.data[0]).params;
  expect(getAddress(params.tokenIn)).toBe(native ? contracts.wrapped : contracts.tokenA);
  expect(getAddress(params.tokenOut)).toBe(native ? contracts.tokenA : contracts.tokenB);
  expect(params.fee).toBe(3000n);
  expect(getAddress(params.recipient)).toBe(recipient);
  expect(params.amountIn).toBe(ATOMS);
  expect(params.amountOutMinimum).toBe(minimum);
  if (native) expect(multicall.data[1]).toBe(routerAbi.encodeFunctionData("refundETH"));
}
