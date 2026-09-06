import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

test("chain 1: saved token intent adopts a confirmed approval speed-up before its separate swap", async ({ page }, testInfo) => {
  test.skip(!process.env.NEUTRON_UNISWAP_SAVED_INTENT, "Explicit coordinator-owned saved-intent continuation only");
  test.setTimeout(900_000);
  const saved = JSON.parse(await readFile(process.env.NEUTRON_UNISWAP_SAVED_INTENT!, "utf8"));
  const intent = JSON.parse(saved.quote_json);
  const quote = intent.quote;
  expect(saved.phase).toBe("queued"); expect(saved.revision).toBe("0");
  expect(saved.chain_id).toBe("1");
  const network = await createEvmNetworkFixture("1");
  expect(network.nodeKind).toBe("anvil");
  const { chain } = network;
  const owner = getAddress(quote.accountAddress), recipient = getAddress(quote.recipient);
  const tokenIn = getAddress(quote.tokenIn.address), tokenOut = getAddress(quote.tokenOut.address);
  const router = getAddress(quote.router);
  const tokenAbi = new Interface(["function balanceOf(address) view returns(uint256)", "function allowance(address,address) view returns(uint256)"]);
  const readToken = async (token: string, method: string, args: string[]) => BigInt(tokenAbi.decodeFunctionResult(method, await chain.rpc<string>("eth_call", [{ to: token, data: tokenAbi.encodeFunctionData(method, args) }, "latest"]))[0]);
  const modes = async () => ({ automine: await chain.rpc<boolean>("anvil_getAutomine"), interval: await chain.rpc<number | null>("anvil_getIntervalMining") });
  const originalMining = await modes(); expect(originalMining).toEqual({ automine: false, interval: 1 });
  const progress: Record<string, unknown> = { savedId: saved.id, originalMining, stages: [] };
  const checkpoint = async (stage: string, fields: Record<string, unknown> = {}) => {
    Object.assign(progress, fields); (progress.stages as unknown[]).push({ stage, observedAt: new Date().toISOString() });
    const file = testInfo.outputPath("effect-checkpoints.json"); await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(progress, null, 2) + "\n");
  };
  await installEvmWalletBrowserFaults(page, ["evm_wallet", "uniswap"]);
  let uniswap = await openUniswap(page);
  let card = savedCard(uniswap, saved.id);
  await expect(card).toHaveCount(1, { timeout: 120_000 });
  const originalRequests: SavedRequests = { id: saved.id, approvalRequest: JSON.parse(saved.approval_request_json), swapRequest: JSON.parse(saved.swap_request_json) };
  expect(await savedRequests(card)).toEqual(originalRequests);
  const before = { nonce: await chain.nonce(owner), input: await readToken(tokenIn, "balanceOf", [owner]), output: await readToken(tokenOut, "balanceOf", [recipient]), accountOutput: await readToken(tokenOut, "balanceOf", [owner]) };
  expect(await chain.rpc<string>("eth_getTransactionCount", [owner, "pending"]).then(BigInt)).toBe(before.nonce);
  expect(await readToken(tokenIn, "allowance", [owner, router])).toBe(0n);
  await checkpoint("saved-intent-restored-before-effects", { originalRequests, deadline: quote.deadline, before: Object.fromEntries(Object.entries(before).map(([key, value]) => [key, value.toString()])) });
  let requests = originalRequests;
  let minimumOut = BigInt(quote.minimumOut), priceImpactPercent = `${Number(quote.priceImpactBps) / 100}%`;
  const wallet = page.frameLocator(WALLET_FRAME);
  // This continuation has explicit coordinator authorization to preserve the
  // nearly expired request, then make one fresh intent after actual expiry.
  const remainingMs = Number(quote.deadline) * 1000 - Date.now();
  if (remainingMs > 0 && remainingMs < 300_000 && process.env.NEUTRON_UNISWAP_ALLOW_FRESH_AFTER_EXPIRY === "1") {
    await card.getByRole("button", { name: "Check wallet status", exact: true }).click();
    await allowEvmInspectionGrantsUntil(page, () => card.getByRole("button", { name: "Check wallet status", exact: true }).isEnabled());
    await expect(card).toContainText("queued"); await expect(card.getByRole("link")).toHaveCount(0);
    expect(await savedRequests(card)).toEqual(originalRequests);
    expect(await chain.nonce(owner)).toBe(before.nonce);
    await checkpoint("nearly-expired-original-preserved-without-wallet-operation", { originalCard: await card.textContent() });
    while (Date.now() <= Number(quote.deadline) * 1000) await page.waitForTimeout(Math.min(10_000, Number(quote.deadline) * 1000 - Date.now() + 1_000));
  }
  if (BigInt(quote.deadline) <= BigInt(Math.floor(Date.now() / 1000))) {
    await expect(card).toContainText("deadline expired");
    await expect(card.getByRole("button", { name: "Review exact approval", exact: true })).toHaveCount(0);
    await card.getByRole("button", { name: "Check wallet status", exact: true }).click();
    await allowEvmInspectionGrantsUntil(page, () => card.getByRole("button", { name: "Check wallet status", exact: true }).isEnabled());
    await expect(card).toContainText("queued");
    await expect(card.getByRole("link")).toHaveCount(0);
    expect(await savedRequests(card)).toEqual(originalRequests);
    expect(await chain.nonce(owner)).toBe(before.nonce); expect(await chain.rpc<string>("eth_getTransactionCount", [owner, "pending"]).then(BigInt)).toBe(before.nonce);
    await checkpoint("original-expired-without-wallet-operation-or-effect", { originalCard: await card.textContent() });
    expect(process.env.NEUTRON_UNISWAP_ALLOW_FRESH_AFTER_EXPIRY).toBe("1");
    await uniswap.getByRole("button", { name: "Connect EVM Wallet", exact: true }).click();
    const connected = uniswap.getByRole("button", { name: "Refresh wallet", exact: true });
    await allowEvmInspectionGrantsUntil(page, async () => await connected.isVisible() && await connected.isEnabled());
    await uniswap.getByLabel(/^Network/u).selectOption("1");
    await uniswap.getByText("Swap settings and custom token", { exact: true }).click();
    expect(getAddress(await uniswap.getByLabel("Recipient", { exact: true }).inputValue())).toBe(owner);
    for (const token of [tokenIn, tokenOut]) {
      await uniswap.getByLabel("Custom token contract", { exact: true }).fill(token);
      await uniswap.getByRole("button", { name: "Read and add token", exact: true }).click();
      await allowEvmInspectionGrantsUntil(page, async () => await uniswap.getByLabel("Input token", { exact: true }).locator(`option[value="${token.toLowerCase()}"]`).count() === 1);
    }
    await uniswap.getByLabel("Input token", { exact: true }).selectOption(tokenIn.toLowerCase());
    await uniswap.getByLabel("Output token", { exact: true }).selectOption(tokenOut.toLowerCase());
    await uniswap.getByLabel("Input amount", { exact: true }).fill(AMOUNT);
    await uniswap.getByLabel("Recipient", { exact: true }).fill(recipient);
    ({ minimumOut, priceImpactPercent } = await requestQuote(page, uniswap, false, network, async evidence => { await checkpoint("fresh-quote-mining-restored", { quoteMining: evidence }); }));
    await uniswap.getByRole("button", { name: "Save swap and review approval", exact: true }).click();
    await allowEvmInspectionGrantsUntil(page, () => wallet.getByTestId("evm-review").isVisible());
    card = uniswap.locator(".uni-saved").first(); requests = await savedRequests(card);
    expect(requests.id).not.toBe(originalRequests.id);
    expect(requests.approvalRequest!.requestId).not.toBe(originalRequests.approvalRequest!.requestId);
    expect(requests.swapRequest.requestId).not.toBe(originalRequests.swapRequest.requestId);
    await checkpoint("fresh-intent-created-after-original-expiry", { requests });
  } else {
    await card.getByRole("button", { name: "Review exact approval", exact: true }).click();
    await allowEvmInspectionGrantsUntil(page, () => wallet.getByTestId("evm-review").isVisible());
    await checkpoint("original-intent-approval-review", { requests });
  }
  const approval = requests.approvalRequest!;
  expect(approval.to.toLowerCase()).toBe(tokenIn.toLowerCase()); expect(approval.valueWei).toBe("0");
  const decodedApproval = approveAbi.decodeFunctionData("approve", approval.data!);
  expect(getAddress(decodedApproval.spender)).toBe(router); expect(decodedApproval.amount).toBe(ATOMS);
  const multicall = routerAbi.decodeFunctionData("multicall", requests.swapRequest.data!);
  expect(multicall.deadline).toBeGreaterThan(BigInt(Math.floor(Date.now() / 1000)));
  expect(multicall.data).toHaveLength(1);
  const swapParams = routerAbi.decodeFunctionData("exactInputSingle", multicall.data[0]).params;
  expect(getAddress(swapParams.tokenIn)).toBe(tokenIn); expect(getAddress(swapParams.tokenOut)).toBe(tokenOut);
  expect(getAddress(swapParams.recipient)).toBe(recipient); expect(swapParams.amountIn).toBe(ATOMS); expect(swapParams.amountOutMinimum).toBe(minimumOut);
  await expectWalletRequest(wallet, approval, owner, "1");
  const operationRow = (requestId: string) => wallet.locator('.evm-activity [data-testid^="evm-operation-"]').filter({ hasText: `Request ${requestId}` });
  const operationHash = async (row: Locator) => { const link = row.locator('a[href*="/tx/"]').first(); await expect(link).toBeVisible({ timeout: 120_000 }); const hash = (await link.getAttribute("href"))?.match(/0x[0-9a-f]{64}/iu)?.[0]; if (!hash) throw new Error("Wallet operation hash missing"); return hash; };
  const checkOperation = async (row: Locator, status: string) => { const button = row.getByRole("button", { name: "Check status", exact: true }); await expect(button).toBeEnabled({ timeout: 120_000 }); await button.click(); await expect(row.locator(`[data-status="${status}"]`)).toBeVisible({ timeout: 120_000 }); };
  let originalHash = "", replacementHash = "", replacementRequest = "";
  try {
    await chain.rpc("evm_setIntervalMining", [0]); await chain.rpc("evm_setAutomine", [false]);
    expect(await modes()).toEqual({ automine: false, interval: null });
    await checkpoint("approval-mining-paused");
    await wallet.getByTestId("evm-review-approve").click();
    await expect(wallet.getByTestId("evm-review")).toHaveCount(0, { timeout: 120_000 });
    await wallet.getByRole("navigation", { name: "Wallet pages" }).getByRole("button", { name: "Activity", exact: true }).click();
    const originalRow = operationRow(approval.requestId); originalHash = await operationHash(originalRow);
    await checkpoint("original-approval-signed", { originalHash });
    await checkOperation(originalRow, "submitted");
    const originalTx = await chain.rpc<{ from: string; to: string; input: string; value: string; nonce: string; blockNumber: string | null; maxFeePerGas: string; maxPriorityFeePerGas: string }>("eth_getTransactionByHash", [originalHash]);
    expect(BigInt(originalTx.nonce)).toBe(before.nonce); expect(originalTx.blockNumber).toBeNull();
    expect(originalTx.from.toLowerCase()).toBe(owner.toLowerCase()); expect(originalTx.to.toLowerCase()).toBe(tokenIn.toLowerCase()); expect(originalTx.input).toBe(approval.data);
    expect(await readToken(tokenIn, "allowance", [owner, router])).toBe(0n);
    await originalRow.getByText("Speed up or cancel", { exact: true }).click();
    await originalRow.getByRole("combobox", { name: "Action", exact: true }).selectOption("speed");
    await originalRow.getByLabel("Maximum fee per gas", { exact: true }).fill((BigInt(originalTx.maxFeePerGas) * 2n + 1n).toString());
    await originalRow.getByLabel("Priority fee per gas", { exact: true }).fill((BigInt(originalTx.maxPriorityFeePerGas) * 2n + 1n).toString());
    await originalRow.getByRole("button", { name: "Review replacement", exact: true }).click();
    await allowEvmInspectionGrantsUntil(page, () => wallet.getByTestId("evm-review").isVisible());
    replacementRequest = (await wallet.getByTestId("evm-review-request-id").textContent())!.trim();
    expect(replacementRequest).not.toBe(approval.requestId);
    await expect(wallet.getByTestId("evm-review")).toContainText("Speed up operation");
    await checkpoint("replacement-awaiting-separate-wallet-decision", { originalTx, replacementRequest });
    await wallet.getByTestId("evm-review-approve").click();
    await expect(wallet.getByTestId("evm-review")).toHaveCount(0, { timeout: 120_000 });
    const replacementRow = operationRow(replacementRequest); replacementHash = await operationHash(replacementRow);
    await checkpoint("replacement-signed", { replacementHash });
    await checkOperation(replacementRow, "submitted");
    const pendingReplacement = await chain.rpc<typeof originalTx>("eth_getTransactionByHash", [replacementHash]);
    expect(replacementHash).not.toBe(originalHash); expect(BigInt(pendingReplacement.nonce)).toBe(before.nonce); expect(pendingReplacement.blockNumber).toBeNull();
    expect(pendingReplacement.input).toBe(approval.data); expect(pendingReplacement.to.toLowerCase()).toBe(tokenIn.toLowerCase()); expect(BigInt(pendingReplacement.value)).toBe(0n);
    expect(BigInt(pendingReplacement.maxFeePerGas)).toBe(BigInt(originalTx.maxFeePerGas) * 2n + 1n); expect(BigInt(pendingReplacement.maxPriorityFeePerGas)).toBe(BigInt(originalTx.maxPriorityFeePerGas) * 2n + 1n);
    await checkpoint("replacement-pending-same-nonce", { pendingReplacement });
  } finally {
    await chain.rpc("evm_setIntervalMining", [0]); await chain.rpc("evm_setAutomine", [originalMining.automine]);
    if (originalMining.interval !== null) await chain.rpc("evm_setIntervalMining", [originalMining.interval]);
    const restored = await modes(); expect(restored).toEqual(originalMining); await checkpoint("approval-mining-restored", { restored });
  }
  const replacementEvidence = await chain.evidence(replacementHash);
  expect(replacementEvidence.nonce).toBe(Number(before.nonce)); expect(Transaction.from(replacementEvidence.raw).data).toBe(approval.data);
  expect(await chain.rpc("eth_getTransactionReceipt", [originalHash])).toBeNull();
  expect(await readToken(tokenIn, "allowance", [owner, router])).toBe(ATOMS);
  await checkOperation(operationRow(replacementRequest), "confirmed"); await checkOperation(operationRow(approval.requestId), "replaced");
  await reconcile(page, card, "Review swap");
  await expect(card).toContainText("Replacement approval: confirmed");
  expect(await transactionHash(card, "Approval")).toBe(originalHash);
  await expect(card.getByRole("link", { name: /^Replacement approval /u })).toHaveAttribute("href", new RegExp(replacementHash));
  await checkpoint("uniswap-adopted-matching-confirmed-replacement", { replacementEvidence, card: await card.textContent() });
  await page.reload(); uniswap = await openUniswap(page, false); card = savedCard(uniswap, requests.id);
  expect(await savedRequests(card)).toEqual(requests); await expect(card).toContainText("Replacement approval: confirmed");
  expect(multicall.deadline).toBeGreaterThan(BigInt(Math.floor(Date.now() / 1000)));
  await card.getByRole("button", { name: "Review swap", exact: true }).click();
  await allowEvmInspectionGrantsUntil(page, () => wallet.getByTestId("evm-review").isVisible());
  await expectWalletRequest(wallet, requests.swapRequest, owner, "1");
  await checkpoint("swap-awaiting-separate-wallet-decision");
  await wallet.getByTestId("evm-review-approve").click();
  await expect(wallet.getByTestId("evm-review")).toHaveCount(0, { timeout: 120_000 });
  await reconcile(page, card, "Receipt: success");
  const swapHash = await transactionHash(card, "Swap"), swapEvidence = await chain.evidence(swapHash);
  expect(swapEvidence.nonce).toBe(Number(before.nonce + 1n)); expect(Transaction.from(swapEvidence.raw).data).toBe(requests.swapRequest.data);
  const actualOutput = await readToken(tokenOut, "balanceOf", [recipient]) - before.output;
  expect(actualOutput).toBeGreaterThanOrEqual(minimumOut); expect(before.input - await readToken(tokenIn, "balanceOf", [owner])).toBe(ATOMS);
  expect(await readToken(tokenOut, "balanceOf", [owner])).toBe(before.accountOutput); expect(await readToken(tokenIn, "allowance", [owner, router])).toBe(0n);
  await page.reload(); uniswap = await openUniswap(page, false); card = savedCard(uniswap, requests.id);
  expect(await savedRequests(card)).toEqual(requests); await expect(card).toContainText("Receipt: success");
  await reconcile(page, card, "Receipt: success");
  expect(await transactionHash(card, "Swap")).toBe(swapHash); expect(await chain.nonce(owner)).toBe(before.nonce + 2n); expect(await chain.rpc<string>("eth_getTransactionCount", [owner, "pending"]).then(BigInt)).toBe(before.nonce + 2n);
  await checkpoint("completed-without-repeating-saved-requests", { requests, minimumOut: minimumOut.toString(), actualOutput: actualOutput.toString(), priceImpactPercent, replacementEvidence, swapEvidence, finalMining: await modes(), txpool: await chain.rpc("txpool_status") });
  await testInfo.attach("approval-replacement-swap-evidence", { body: JSON.stringify(progress, null, 2), contentType: "application/json" });
});

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
  // Successful Quoter, factory and pool reads each include code evidence.
  // The retained final106 trace reached fee/allowance reads at the old 120s
  // cumulative deadline, so only this deterministic read-only phase gets 300s.
  await allowEvmInspectionGrantsUntil(page, async () => await save.isVisible() && await save.isEnabled(), chainId === "1" ? 300_000 : undefined);
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
