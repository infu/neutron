import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type FrameLocator, type Locator, type Page } from "@playwright/test";
import { getAddress, Interface, Transaction } from "ethers";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
import { createKernelActor, localIdentityFromSeed } from "../../packages/neutron-provision/src/kernel.ts";
import { resolveLocalNeutronRuntime } from "../../packages/neutron-provision/src/local_session.ts";
import { allowEvmInspectionGrantsUntil } from "./fixtures/evm-wallet-browser.ts";
import { inspectEvmAnvilFixture } from "./fixtures/evm-wallet-anvil.ts";
import { createLocalEvmChain, type LocalEvmChain } from "./fixtures/evm-wallet-chain.ts";

// Fixture-specific continuation of one already mined approval. Run only during
// the coordinator's chain42161 window. No funding, deployment or mining changes.
// If interrupted after revocation approval, reconcile the checkpointed request
// instead of rerunning this test and creating another request.
test.describe.configure({ retries: 0, mode: "serial" });
test.skip(path.basename(process.env.NEUTRON_NDEPLOY_CONFIG ?? "") !== "evm-wallet-local.ndeploy.json", "Requires the dedicated local fixture and a reserved allowance recovery window");

const FRAME = 'iframe[data-app-id="evm_wallet"][data-tile-id="evm_wallet"]';
const OWNER = "0xd646499bA961Ecdfb989d4b716A4A5E3fb7abd56";
const TOKEN = "0x067c804bb006836469379D4A2A69a81803bd1F45";
const SPENDER = "0xEb4F9946985F6D0b1d28481b8f5B1543d85011fE";
const ORIGINAL_REQUEST = "e684525dadd08e5e84d04a3fbc14156c";
const ORIGINAL_HASH = "0x3032768ec5203cde01a39220c5aa0eff28b6be997b25c4f646a29836b63afd95";
const DEPLOYMENT = "c4b89b6fe632613a6dccab85444e5240";
const ALLOWANCE = 7n * 10n ** 18n, BALANCE = 10n * 10n ** 18n;
const ABI = new Interface([
  "function approve(address spender,uint256 amount) returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
]);
type Receipt = { transactionHash: string; status: string; blockNumber: string; blockHash: string };
const json = (value: unknown): string => JSON.stringify(value, (_key, entry: unknown) => typeof entry === "bigint" ? entry.toString() : entry, 2) + "\n";

test("recover the second mined approval and revoke its allowance once through Wallet review", async ({ page }, testInfo) => {
  test.setTimeout(480_000);
  const progress: Record<string, unknown> = { chainId: "42161", owner: OWNER, token: TOKEN, spender: SPENDER, originalRequest: ORIGINAL_REQUEST, originalHash: ORIGINAL_HASH, stages: [] };
  async function checkpoint(stage: string, fields: Record<string, unknown> = {}) {
    Object.assign(progress, fields);
    (progress.stages as unknown[]).push({ stage, observedAt: new Date().toISOString() });
    await mkdir(testInfo.outputDir, { recursive: true });
    await writeFile(testInfo.outputPath("effect-checkpoints.json"), json(progress));
  }
  await checkpoint("preflight");
  const fixture = await inspectEvmAnvilFixture();
  const chain = await createLocalEvmChain({ chainId: "42161", rpcUrl: fixture.owner.rpcUrl });
  expect(await chain.rpc("anvil_getAutomine")).toBe(false);
  expect(await chain.rpc("anvil_getIntervalMining")).toBe(1);
  const runtime = resolveLocalNeutronRuntime();
  const kernel = await createKernelActor({ canisterId: runtime.canisterId, host: runtime.gatewayUrl, identity: localIdentityFromSeed(runtime.developerIdentitySeed), fetchRootKey: true });
  const installed = await kernel.kernel_runtime_info();
  expect(installed.deployment_id).toBe(DEPLOYMENT);
  expect(installed.apps.find((entry) => entry.scope.app_id === "kernel")?.version).toBe(342n);
  expect(installed.apps.find((entry) => entry.scope.app_id === "evm_wallet")?.version).toBe(106n);
  const pinsBytes = await readFile(".neutron/release-receipts/evm-wallet-completion-2026-09-06/installed-final-candidates.json");
  const pins = JSON.parse(pinsBytes.toString()) as { deploymentId: string; installed: { id: string; version: number; sha256: string }[] };
  expect(pins.deploymentId).toBe(DEPLOYMENT);
  const archive = await readFile("apps/evm_wallet/evm_wallet.v0.1.6.neutron");
  expect(createHash("sha256").update(archive).digest("hex")).toBe(pins.installed.find((entry) => entry.id === "evm_wallet")!.sha256);
  const nonceBefore = await nonces(chain);
  expect(nonceBefore).toEqual({ latest: "9", pending: "9" });
  const originalReceipt = await canonicalReceipt(chain, ORIGINAL_HASH);
  const originalEvidence = await chain.evidence(ORIGINAL_HASH);
  expect(originalEvidence.from.toLowerCase()).toBe(OWNER.toLowerCase());
  expect(originalEvidence.to.toLowerCase()).toBe(TOKEN.toLowerCase());
  expect(originalEvidence.nonce).toBe(8);
  expect(Transaction.from(originalEvidence.raw).data.toLowerCase()).toBe(ABI.encodeFunctionData("approve", [SPENDER, ALLOWANCE]).toLowerCase());
  expect(await tokenRead(chain, "allowance", [OWNER, SPENDER])).toBe(ALLOWANCE);
  expect(await tokenRead(chain, "balanceOf", [OWNER])).toBe(BALANCE);
  await checkpoint("existing-approval-verified", { deploymentId: DEPLOYMENT, installed: pins.installed, installedProofSha256: createHash("sha256").update(pinsBytes).digest("hex"), nonceBefore, originalReceipt, originalEvidence, fixtureOwner: fixture.owner });

  try {
    const wallet = await openWallet(page, runtime.developerIdentitySeed, localCanisterOrigin(runtime.canisterId, runtime.gatewayUrl));
    let original = await findOperation(wallet, ORIGINAL_REQUEST);
    await expect(original.locator(`a[href$="${ORIGINAL_HASH}"]`)).toBeVisible();
    await original.getByRole("button", { name: "Check status", exact: true }).click();
    await expect(original.locator('[data-status="confirmed"]')).toBeVisible({ timeout: 120_000 });
    expect(await nonces(chain)).toEqual(nonceBefore);
    await checkpoint("existing-approval-confirmed-in-wallet");
    await tab(wallet, "Approvals").click();
    let known = approvalRow(wallet);
    await expect(known).toHaveCount(1);
    await known.getByRole("button", { name: "Check allowance", exact: true }).click();
    await expect(known).toContainText(`Observed allowance: ${ALLOWANCE} atomic units`, { timeout: 120_000 });
    const beforeObservation = await checkObservedAllowance(chain, known, ALLOWANCE, BigInt(originalReceipt.blockNumber));
    await checkpoint("observed-existing-allowance", { beforeObservation });

    const revokeData = ABI.encodeFunctionData("approve", [SPENDER, 0n]);
    await known.getByRole("button", { name: "Review revocation", exact: true }).click();
    await allowEvmInspectionGrantsUntil(page, () => wallet.getByTestId("evm-review").isVisible());
    const review = wallet.getByTestId("evm-review");
    const revocationRequest = (await wallet.getByTestId("evm-review-request-id").textContent())!.trim();
    expect(revocationRequest).toMatch(/^[0-9a-f]{32}$/u);
    expect(revocationRequest).not.toBe(ORIGINAL_REQUEST);
    await checkpoint("revocation-prepared-not-approved", { revocationRequest, revocationIntent: { accountId: "main", chainId: "42161", requestId: revocationRequest, to: TOKEN, valueWei: "0", data: revokeData }, expectedAddress: OWNER });
    await expect(review).toContainText(getAddress(TOKEN));
    await expect(review).toContainText(getAddress(SPENDER));
    await expect(review).toContainText(revokeData);
    await expect(wallet.getByTestId("evm-review-token-balance")).toHaveText(`${BALANCE} atomic units`);
    await expect(wallet.getByTestId("evm-review-token-allowance")).toHaveText(`${ALLOWANCE} atomic units`);
    await expect(wallet.getByTestId("evm-review-allowance-change")).toHaveText(`Decrease by ${ALLOWANCE} atomic units`);
    await wallet.getByTestId("evm-review-token-refresh").click();
    await expect(wallet.getByTestId("evm-review-token-refresh")).toBeEnabled({ timeout: 120_000 });
    await expect(wallet.getByTestId("evm-review-token-allowance")).toHaveText(`${ALLOWANCE} atomic units`);
    await expect(wallet.getByTestId("evm-review-allowance-change")).toHaveText(`Decrease by ${ALLOWANCE} atomic units`);
    await expect(wallet.getByTestId("evm-review-request-id")).toHaveText(revocationRequest);
    await expect(wallet.getByTestId("evm-review-approve")).toBeEnabled();
    await testInfo.attach("refreshed-revocation-review", { body: await page.screenshot(), contentType: "image/png" });
    await checkpoint("revocation-approval-attempted", { revocationApprovalAttempted: true });
    await wallet.getByTestId("evm-review-approve").click();
    await expect(review).toHaveCount(0, { timeout: 120_000 });

    // Unknown is an honest response while the fixture receipt catches up. Find
    // the stored hash without requiring submitted, then reconcile that hash.
    const revocation = await findOperation(wallet, revocationRequest);
    const link = revocation.locator('a[href*="/tx/"]').first();
    await expect(link).toBeVisible({ timeout: 120_000 });
    const revocationHash = (await link.getAttribute("href"))?.match(/0x[0-9a-f]{64}/iu)?.[0];
    if (!revocationHash) throw new Error("The prepared revocation has no saved transaction hash; recover its checkpointed request");
    await checkpoint("revocation-hash-observed", { revocationHash });
    const revocationReceipt = await canonicalReceipt(chain, revocationHash);
    await checkpoint("revocation-canonical-receipt", { revocationReceipt });
    await revocation.getByRole("button", { name: "Check status", exact: true }).click();
    await expect(revocation.locator('[data-status="confirmed"]')).toBeVisible({ timeout: 120_000 });
    const evidence = await chain.evidence(revocationHash);
    expect(evidence.chainId).toBe("42161");
    expect(evidence.from.toLowerCase()).toBe(OWNER.toLowerCase());
    expect(evidence.to.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(evidence.nonce).toBe(9);
    expect(evidence.valueWei).toBe("0");
    expect(Transaction.from(evidence.raw).data.toLowerCase()).toBe(revokeData.toLowerCase());
    expect(await nonces(chain)).toEqual({ latest: "10", pending: "10" });
    expect(await tokenRead(chain, "allowance", [OWNER, SPENDER])).toBe(0n);
    expect(await tokenRead(chain, "balanceOf", [OWNER])).toBe(BALANCE);
    await tab(wallet, "Approvals").click();
    known = approvalRow(wallet);
    await expect(known).toHaveCount(1);
    await known.getByRole("button", { name: "Check allowance", exact: true }).click();
    await expect(known).toContainText("Observed allowance: 0 atomic units", { timeout: 120_000 });
    const observation = await checkObservedAllowance(chain, known, 0n, BigInt(revocationReceipt.blockNumber));
    await expect(wallet.locator('.evm-app > [role="alert"]')).toHaveCount(0);
    await checkpoint("revocation-complete-zero-allowance", { revocationEvidence: evidence, finalObservation: observation, nonceAfter: await nonces(chain), finalAllowance: "0", tokenBalance: BALANCE.toString() });
    await testInfo.attach("zero-allowance-after-recovery", { body: await page.screenshot(), contentType: "image/png" });
    await testInfo.attach("allowance-recovery-evidence", { path: testInfo.outputPath("effect-checkpoints.json"), contentType: "application/json" });
  } finally {
    await checkpoint("postflight", { noncePostflight: await nonces(chain), allowancePostflight: (await tokenRead(chain, "allowance", [OWNER, SPENDER])).toString(), autominePostflight: await chain.rpc("anvil_getAutomine"), intervalPostflight: await chain.rpc("anvil_getIntervalMining") });
  }
});

async function nonces(chain: LocalEvmChain) {
  const [latest, pending] = await Promise.all([chain.rpc<string>("eth_getTransactionCount", [OWNER, "latest"]), chain.rpc<string>("eth_getTransactionCount", [OWNER, "pending"])]);
  return { latest: BigInt(latest).toString(), pending: BigInt(pending).toString() };
}
async function tokenRead(chain: LocalEvmChain, method: "allowance" | "balanceOf", args: string[], block = "latest"): Promise<bigint> {
  const raw = await chain.rpc<string>("eth_call", [{ to: TOKEN, data: ABI.encodeFunctionData(method, args) }, block]);
  return BigInt(ABI.decodeFunctionResult(method, raw)[0]);
}
async function canonicalReceipt(chain: LocalEvmChain, hash: string): Promise<Receipt> {
  let receipt: Receipt | null = null;
  await expect.poll(async () => { receipt = await chain.rpc<Receipt | null>("eth_getTransactionReceipt", [hash]); return receipt !== null; }, { timeout: 120_000 }).toBe(true);
  const value = receipt as unknown as Receipt;
  expect(value.transactionHash.toLowerCase()).toBe(hash.toLowerCase());
  expect(BigInt(value.status)).toBe(1n);
  const block = await chain.rpc<{ hash: string }>("eth_getBlockByNumber", [value.blockNumber, false]);
  expect(block.hash.toLowerCase()).toBe(value.blockHash.toLowerCase());
  return value;
}
async function checkObservedAllowance(chain: LocalEvmChain, row: Locator, expected: bigint, minimumBlock: bigint) {
  const blockNumber = (await row.locator("p").filter({ hasText: /^Block [0-9]+/u }).innerText()).match(/^Block ([0-9]+)\b/u)?.[1];
  if (!blockNumber) throw new Error("The UI allowance observation has no block");
  expect(BigInt(blockNumber)).toBeGreaterThanOrEqual(minimumBlock);
  const tag = `0x${BigInt(blockNumber).toString(16)}`;
  expect(await tokenRead(chain, "allowance", [OWNER, SPENDER], tag)).toBe(expected);
  const block = await chain.rpc<{ hash: string; number: string }>("eth_getBlockByNumber", [tag, false]);
  expect(BigInt(block.number)).toBe(BigInt(blockNumber));
  return { blockNumber, blockHash: block.hash, allowance: expected.toString() };
}
function tab(wallet: FrameLocator, name: string) { return wallet.getByRole("navigation", { name: "Wallet pages" }).getByRole("button", { name, exact: true }); }
function approvalRow(wallet: FrameLocator) { return wallet.locator(".evm-operation").filter({ hasText: `Token ${getAddress(TOKEN)}` }).filter({ hasText: `Spender ${getAddress(SPENDER)}` }); }
async function findOperation(wallet: FrameLocator, requestId: string): Promise<Locator> {
  await tab(wallet, "Activity").click();
  const rows = wallet.locator('.evm-activity [data-testid^="evm-operation-"]');
  await expect(rows.first()).toBeVisible({ timeout: 120_000 });
  const row = rows.filter({ hasText: `Request ${requestId}` });
  for (;;) {
    if (await row.count()) return row;
    const more = wallet.getByRole("button", { name: "Load more", exact: true });
    if (!await more.isVisible()) throw new Error(`Saved request ${requestId} was not found in Wallet activity`);
    const count = await rows.count();
    await more.click();
    await expect.poll(() => rows.count(), { timeout: 120_000 }).toBeGreaterThan(count);
  }
}
async function openWallet(page: Page, seed: number, origin: string): Promise<FrameLocator> {
  await page.goto(origin);
  await page.waitForFunction(() => typeof (window as typeof window & { __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: unknown }).__NEUTRON_PLAYWRIGHT_LOGIN_AS__ === "function");
  await page.evaluate(async (value) => {
    const login = (window as typeof window & { __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: (seed: number) => Promise<string> }).__NEUTRON_PLAYWRIGHT_LOGIN_AS__;
    if (!login) throw new Error("Local-only login hook unavailable");
    await login(value);
  }, seed);
  await expect(page.locator('[data-tid="app-background-frame"][data-app-id="evm_wallet"]')).toHaveAttribute("data-resident-launch", "ready", { timeout: 120_000 });
  if (await page.locator(FRAME).count() === 0) {
    await page.locator('[data-tid="launcher-open"]').click();
    await page.locator('[data-tid="launcher-tile-evm_wallet-evm_wallet"]').click();
  }
  const wallet = page.frameLocator(FRAME);
  await expect(wallet.getByTestId("evm-account-address")).toHaveText(new RegExp(`^${OWNER}$`, "iu"), { timeout: 120_000 });
  await wallet.getByTestId("evm-network-select").selectOption("42161");
  return wallet;
}
