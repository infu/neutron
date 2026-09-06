import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, test, type FrameLocator, type Locator, type Page } from "@playwright/test";
import { getAddress, Interface, Transaction } from "ethers";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
import { resolveLocalNeutronRuntime } from "../../packages/neutron-provision/src/local_session.ts";
import { allowEvmInspectionGrantsUntil } from "./fixtures/evm-wallet-browser.ts";
import { createEvmNetworkFixture } from "./fixtures/evm-wallet-network.ts";
import { inspectEvmAnvilFixture } from "./fixtures/evm-wallet-anvil.ts";
import type { LocalEvmChain } from "./fixtures/evm-wallet-chain.ts";

// Run alone in a reserved fixture window: automining and the chain-key account
// nonce are shared with the other EVM qualification specs. No public node can
// pass the dedicated deployment, loopback, chain and Anvil checks below.
test.describe.configure({ retries: 0, mode: "serial" });
test.skip(
  path.basename(process.env.NEUTRON_NDEPLOY_CONFIG ?? "") !== "evm-wallet-local.ndeploy.json",
  "Requires the dedicated disposable EVM Wallet PocketIC/Anvil deployment",
);

const WALLET_FRAME = 'iframe[data-app-id="evm_wallet"][data-tile-id="evm_wallet"]';
const TOKEN_ABI = new Interface([
  "function approve(address spender,uint256 amount) returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function mint(address owner,uint256 amount)",
]);
const TOKENS = 10n * 10n ** 18n;
const ALLOWANCE = 7n * 10n ** 18n;
type Receipt = { transactionHash: string; status: string; blockNumber: string; blockHash: string; contractAddress?: string };
type RpcTransaction = { hash: string; from: string; to: string; input: string; value: string; nonce: string; maxFeePerGas: string; maxPriorityFeePerGas: string; blockNumber: string | null };
type MiningMode = { automine: boolean; interval: number | null };

test("a confirmed approval speed-up remains discoverable and Wallet revocation clears the live allowance", async ({ page }, testInfo) => {
  test.setTimeout(720_000);
  const selected = process.env.NEUTRON_EVM_ALLOWANCE_CHAIN_ID ?? "42161";
  if (selected !== "1" && selected !== "42161") throw new Error("Allowance qualification requires chain 1 or 42161");
  const progress: Record<string, unknown> = { chainId: selected, stages: [] };
  async function checkpoint(stage: string, fields: Record<string, unknown> = {}) {
    Object.assign(progress, fields);
    (progress.stages as unknown[]).push({ stage, observedAt: new Date().toISOString() });
    const file = testInfo.outputPath("effect-checkpoints.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(progress, null, 2) + "\n");
  }
  await checkpoint("preflight");
  const network = await createEvmNetworkFixture(selected);
  expect(network.nodeKind).toBe("anvil");
  const chain = network.chain;
  const node = await chain.rpc<{ forkConfig?: { forkUrl?: unknown; forkBlockNumber?: unknown } }>("anvil_nodeInfo");
  expect(node.forkConfig?.forkUrl == null && node.forkConfig?.forkBlockNumber == null).toBe(true);
  // The dedicated chain42161 owner launches with --block-time 1. That is
  // interval mining, for which anvil_getAutomine correctly returns false.
  // Inspect verifies its binary, PID, socket, exact launch args and unforked
  // nodeInfo. Mining mode is queried separately: nodeInfo does not expose it.
  const ownedFixture = selected === "42161" ? await inspectEvmAnvilFixture() : null;
  if (ownedFixture) expect(network.rpcUrl).toBe(ownedFixture.owner.rpcUrl);
  const originalMining = await miningMode(chain);
  expect(originalMining).toEqual(selected === "42161"
    ? { automine: false, interval: 1 }
    : { automine: true, interval: null });
  await checkpoint("mining-mode-verified", { originalMining, fixtureOwner: ownedFixture?.owner ?? null });

  async function restoreMining(): Promise<void> {
    if (ownedFixture) {
      const current = await inspectEvmAnvilFixture();
      expect(current.owner.processIdentity).toBe(ownedFixture.owner.processIdentity);
    }
    // Anvil v1.7.1 setIntervalMining selects a whole mining mode. Clear it,
    // restore instant mining if originally enabled, then restore the owned
    // interval if present. The getters verify the final mode exactly.
    await chain.rpc("evm_setIntervalMining", [0]);
    await chain.rpc("evm_setAutomine", [originalMining.automine]);
    if (originalMining.interval !== null) await chain.rpc("evm_setIntervalMining", [originalMining.interval]);
    expect(await miningMode(chain)).toEqual(originalMining);
  }

  let wallet = await openWallet(page, selected);
  const owner = getAddress((await wallet.getByTestId("evm-account-address").textContent())!.trim());
  await checkpoint("wallet-account-read", { owner, originalMining });
  await network.fund(owner);
  const { token, deploymentHash, mintHash } = await deployToken(chain, owner);
  await checkpoint("token-deployed-and-minted", { token, deploymentHash, mintHash });
  const spender = getAddress(`0x${randomBytes(20).toString("hex")}`);
  const approvalData = TOKEN_ABI.encodeFunctionData("approve", [spender, ALLOWANCE]);
  const revokeData = TOKEN_ABI.encodeFunctionData("approve", [spender, 0n]);
  const nonceBefore = await chain.nonce(owner);
  await checkpoint("allowance-fixture-ready", { spender, nonceBefore: nonceBefore.toString() });
  expect(await tokenRead(chain, token, "allowance", [owner, spender])).toBe(0n);
  expect(await tokenRead(chain, token, "balanceOf", [owner])).toBe(TOKENS);

  let miningPaused = false;
  try {
    // Mark restoration necessary before the first mutation so a lost response
    // from either mining-control request cannot skip cleanup.
    miningPaused = true;
    await checkpoint("mining-pause-requested");
    await chain.rpc("evm_setIntervalMining", [0]);
    await chain.rpc("evm_setAutomine", [false]);
    expect(await miningMode(chain)).toEqual({ automine: false, interval: null });
    await checkpoint("automining-paused");
    await walletTab(wallet, "Send").click();
    await wallet.getByTestId("evm-send-to").fill(token);
    await wallet.getByTestId("evm-send-amount").fill("0");
    await wallet.getByLabel("Include contract calldata", { exact: true }).check();
    await wallet.getByRole("textbox", { name: "Exact calldata", exact: true }).fill(approvalData);
    await wallet.getByTestId("evm-send-review").click();
    await waitForReview(page, wallet);
    const originalRequest = (await wallet.getByTestId("evm-review-request-id").textContent())!.trim();
    expect(originalRequest).toMatch(/^[0-9a-f]{32}$/u);
    await checkpoint("original-awaiting-approval", { originalRequest });
    await expect(wallet.getByTestId("evm-review-token-balance")).toHaveText(`${TOKENS} atomic units`);
    await expect(wallet.getByTestId("evm-review-token-allowance")).toHaveText("0 atomic units");
    await expect(wallet.getByTestId("evm-review-allowance-change")).toHaveText(`Increase by ${ALLOWANCE} atomic units`);
    await wallet.getByTestId("evm-review-approve").click();
    await expect(wallet.getByTestId("evm-review")).toHaveCount(0, { timeout: 120_000 });

    await walletTab(wallet, "Activity").click();
    let originalRow = operationRow(wallet, originalRequest);
    await expect(originalRow.locator('[data-status="submitted"]')).toBeVisible({ timeout: 120_000 });
    const originalHash = await transactionHash(originalRow);
    await checkpoint("original-signed-and-submitted", { originalHash });
    const originalTx = await chain.rpc<RpcTransaction>("eth_getTransactionByHash", [originalHash]);
    expect(originalTx.from.toLowerCase()).toBe(owner.toLowerCase());
    expect(originalTx.to.toLowerCase()).toBe(token.toLowerCase());
    expect(originalTx.input.toLowerCase()).toBe(approvalData.toLowerCase());
    expect(BigInt(originalTx.nonce)).toBe(nonceBefore);
    expect(originalTx.blockNumber).toBeNull();
    expect(await chain.rpc("eth_getTransactionReceipt", [originalHash])).toBeNull();
    expect(await tokenRead(chain, token, "allowance", [owner, spender])).toBe(0n);
    await walletTab(wallet, "Approvals").click();
    await expect(approvalRow(wallet, token, spender)).toHaveCount(0);

    await walletTab(wallet, "Activity").click();
    originalRow = operationRow(wallet, originalRequest);
    await originalRow.getByText("Speed up or cancel", { exact: true }).click();
    await originalRow.getByRole("combobox", { name: "Action", exact: true }).selectOption("speed");
    await originalRow.getByLabel("Maximum fee per gas", { exact: true }).fill((BigInt(originalTx.maxFeePerGas) * 2n + 1n).toString());
    await originalRow.getByLabel("Priority fee per gas", { exact: true }).fill((BigInt(originalTx.maxPriorityFeePerGas) * 2n + 1n).toString());
    await originalRow.getByRole("button", { name: "Review replacement", exact: true }).click();
    await waitForReview(page, wallet);
    const replacementRequest = (await wallet.getByTestId("evm-review-request-id").textContent())!.trim();
    expect(replacementRequest).not.toBe(originalRequest);
    await checkpoint("replacement-awaiting-approval", { replacementRequest });
    await expect(wallet.getByTestId("evm-review")).toContainText("Speed up operation");
    await expect(wallet.getByTestId("evm-review")).toContainText(token);
    await expect(wallet.getByTestId("evm-review-token-allowance")).toHaveText("0 atomic units");
    await expect(wallet.getByTestId("evm-review-allowance-change")).toHaveText(`Increase by ${ALLOWANCE} atomic units`);
    await wallet.getByTestId("evm-review-approve").click();
    await expect(wallet.getByTestId("evm-review")).toHaveCount(0, { timeout: 120_000 });
    const replacementRow = operationRow(wallet, replacementRequest);
    await expect(replacementRow.locator('[data-status="submitted"]')).toBeVisible({ timeout: 120_000 });
    const replacementHash = await transactionHash(replacementRow);
    await checkpoint("replacement-signed-and-submitted", { replacementHash });
    expect(replacementHash).not.toBe(originalHash);
    const pendingReplacement = await chain.rpc<RpcTransaction>("eth_getTransactionByHash", [replacementHash]);
    expect(BigInt(pendingReplacement.nonce)).toBe(nonceBefore);
    expect(pendingReplacement.to.toLowerCase()).toBe(token.toLowerCase());
    expect(pendingReplacement.input.toLowerCase()).toBe(approvalData.toLowerCase());
    expect(BigInt(pendingReplacement.value)).toBe(0n);
    expect(pendingReplacement.blockNumber).toBeNull();
    await walletTab(wallet, "Approvals").click();
    await expect(approvalRow(wallet, token, spender)).toHaveCount(0);

    await chain.rpc("evm_mine");
    const replacementReceipt = await canonicalReceipt(chain, replacementHash);
    await checkpoint("replacement-canonical-receipt", { replacementReceipt });
    expect(await chain.rpc("eth_getTransactionReceipt", [originalHash])).toBeNull();
    const replacementEvidence = await chain.evidence(replacementHash);
    expect(replacementEvidence.from.toLowerCase()).toBe(owner.toLowerCase());
    expect(replacementEvidence.nonce).toBe(Number(nonceBefore));
    expect(Transaction.from(replacementEvidence.raw).data.toLowerCase()).toBe(approvalData.toLowerCase());
    expect(await chain.nonce(owner)).toBe(nonceBefore + 1n);
    expect(await tokenRead(chain, token, "allowance", [owner, spender])).toBe(ALLOWANCE);
    await walletTab(wallet, "Activity").click();
    await checkOperation(operationRow(wallet, replacementRequest), "confirmed");
    await checkOperation(operationRow(wallet, originalRequest), "replaced");

    // Reload proves discovery comes from durable Wallet history, including the
    // replacement's resolved transaction, rather than a live Send form.
    await page.reload();
    wallet = await openWallet(page, selected, false);
    await walletTab(wallet, "Approvals").click();
    let known = approvalRow(wallet, token, spender);
    await expect(known).toHaveCount(1);
    await known.getByRole("button", { name: "Check allowance", exact: true }).click();
    await expect(known).toContainText(`Observed allowance: ${ALLOWANCE} atomic units`, { timeout: 120_000 });
    await expect(known).toContainText(`Block ${BigInt(replacementReceipt.blockNumber)}`);
    expect(await tokenRead(chain, token, "allowance", [owner, spender])).toBe(ALLOWANCE);
    await testInfo.attach("replacement-approval-discovered", { body: await page.screenshot(), contentType: "image/png" });

    await restoreMining();
    miningPaused = false;
    await checkpoint("automining-restored");
    await known.getByRole("button", { name: "Review revocation", exact: true }).click();
    await waitForReview(page, wallet);
    const revocationRequest = (await wallet.getByTestId("evm-review-request-id").textContent())!.trim();
    expect([originalRequest, replacementRequest]).not.toContain(revocationRequest);
    await checkpoint("revocation-awaiting-approval", { revocationRequest });
    await expect(wallet.getByTestId("evm-review-token-balance")).toHaveText(`${TOKENS} atomic units`);
    await expect(wallet.getByTestId("evm-review-token-allowance")).toHaveText(`${ALLOWANCE} atomic units`);
    await expect(wallet.getByTestId("evm-review-allowance-change")).toHaveText(`Decrease by ${ALLOWANCE} atomic units`);
    await expect(wallet.getByTestId("evm-review")).toContainText(revokeData);
    await wallet.getByTestId("evm-review-token-refresh").click();
    await expect(wallet.getByTestId("evm-review-token-refresh")).toBeEnabled({ timeout: 120_000 });
    await expect(wallet.getByTestId("evm-review-token-allowance")).toHaveText(`${ALLOWANCE} atomic units`);
    await expect(wallet.getByTestId("evm-review-allowance-change")).toHaveText(`Decrease by ${ALLOWANCE} atomic units`);
    await testInfo.attach("wallet-revocation-review", { body: await page.screenshot(), contentType: "image/png" });
    await wallet.getByTestId("evm-review-approve").click();
    await expect(wallet.getByTestId("evm-review")).toHaveCount(0, { timeout: 120_000 });
    await walletTab(wallet, "Activity").click();
    const revocationRow = operationRow(wallet, revocationRequest);
    const revocationHash = await transactionHash(revocationRow);
    await checkpoint("revocation-signed-and-submitted", { revocationHash });
    const revocationReceipt = await canonicalReceipt(chain, revocationHash);
    await checkpoint("revocation-canonical-receipt", { revocationReceipt });
    await checkOperation(revocationRow, "confirmed");
    const revocationEvidence = await chain.evidence(revocationHash);
    expect(revocationEvidence.from.toLowerCase()).toBe(owner.toLowerCase());
    expect(revocationEvidence.to.toLowerCase()).toBe(token.toLowerCase());
    expect(revocationEvidence.nonce).toBe(Number(nonceBefore + 1n));
    expect(Transaction.from(revocationEvidence.raw).data.toLowerCase()).toBe(revokeData.toLowerCase());
    expect(await chain.nonce(owner)).toBe(nonceBefore + 2n);
    expect(await tokenRead(chain, token, "allowance", [owner, spender])).toBe(0n);
    expect(await tokenRead(chain, token, "balanceOf", [owner])).toBe(TOKENS);
    await checkpoint("verified-zero-allowance", { finalAllowance: "0", tokenBalance: TOKENS.toString() });
    await walletTab(wallet, "Approvals").click();
    known = approvalRow(wallet, token, spender);
    await expect(known).toHaveCount(1);
    await known.getByRole("button", { name: "Check allowance", exact: true }).click();
    await expect(known).toContainText("Observed allowance: 0 atomic units", { timeout: 120_000 });
    const observedBlock = (await known.textContent())?.match(/\bBlock ([0-9]+)\b/u)?.[1];
    if (!observedBlock) throw new Error("Wallet allowance observation has no block number");
    expect(BigInt(observedBlock)).toBeGreaterThanOrEqual(BigInt(revocationReceipt.blockNumber));
    const observedBlockTag = `0x${BigInt(observedBlock).toString(16)}`;
    const observedAllowance = await tokenRead(chain, token, "allowance", [owner, spender], observedBlockTag);
    expect(observedAllowance).toBe(0n);
    const observedBlockEvidence = await chain.rpc<{ number: string; hash: string }>("eth_getBlockByNumber", [observedBlockTag, false]);
    expect(BigInt(observedBlockEvidence.number)).toBe(BigInt(observedBlock));
    await checkpoint("verified-ui-observation-block", { observedBlock, observedBlockEvidence, observedAllowance: observedAllowance.toString() });
    await testInfo.attach("wallet-zero-allowance", { body: await page.screenshot(), contentType: "image/png" });
    await testInfo.attach("replacement-and-revocation-chain-evidence", {
      body: JSON.stringify({ chainId: selected, owner, token, spender, deploymentHash, mintHash, originalMining, nonceBefore: nonceBefore.toString(), originalRequest, originalHash, originalTx, replacementRequest, replacementHash, pendingReplacement, replacementReceipt, replacementEvidence, revocationRequest, revocationHash, revocationReceipt, revocationEvidence, observedBlock, observedBlockEvidence, observedAllowance: observedAllowance.toString(), finalAllowance: "0", tokenBalance: TOKENS.toString() }, null, 2),
      contentType: "application/json",
    });
  } finally {
    if (miningPaused) {
      await restoreMining();
      await checkpoint("automining-restored-after-interruption");
    }
  }
});

function walletTab(wallet: FrameLocator, name: string): Locator {
  return wallet.getByRole("navigation", { name: "Wallet pages" }).getByRole("button", { name, exact: true });
}
function operationRow(wallet: FrameLocator, requestId: string): Locator {
  return wallet.locator('.evm-activity [data-testid^="evm-operation-"]').filter({ hasText: `Request ${requestId}` });
}
function approvalRow(wallet: FrameLocator, token: string, spender: string): Locator {
  return wallet.locator(".evm-operation").filter({ hasText: `Token ${getAddress(token)}` }).filter({ hasText: `Spender ${getAddress(spender)}` });
}
async function waitForReview(page: Page, wallet: FrameLocator): Promise<void> {
  await allowEvmInspectionGrantsUntil(page, () => wallet.getByTestId("evm-review").isVisible());
  await expect(wallet.getByTestId("evm-review-approve")).toBeEnabled({ timeout: 120_000 });
}
async function transactionHash(row: Locator): Promise<string> {
  const link = row.locator('a[href*="/tx/"]').first();
  await expect(link).toBeVisible({ timeout: 120_000 });
  const hash = (await link.getAttribute("href"))?.match(/0x[0-9a-f]{64}/iu)?.[0];
  if (!hash) throw new Error("Wallet operation has no transaction hash");
  return hash;
}
async function checkOperation(row: Locator, status: string): Promise<void> {
  const check = row.getByRole("button", { name: "Check status", exact: true });
  await expect(check).toBeEnabled({ timeout: 120_000 });
  await check.click();
  await expect(row.locator(`[data-status="${status}"]`)).toBeVisible({ timeout: 120_000 });
}
async function openWallet(page: Page, chainId: string, navigate = true): Promise<FrameLocator> {
  const runtime = resolveLocalNeutronRuntime();
  if (navigate) await page.goto(localCanisterOrigin(runtime.canisterId, runtime.gatewayUrl));
  await page.waitForFunction(() => typeof (window as typeof window & { __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: unknown }).__NEUTRON_PLAYWRIGHT_LOGIN_AS__ === "function");
  const principal = await page.evaluate(async (seed) => {
    const login = (window as typeof window & { __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: (seed: number) => Promise<string> }).__NEUTRON_PLAYWRIGHT_LOGIN_AS__;
    if (!login) throw new Error("The local-only Kernel login hook is unavailable");
    return login(seed);
  }, runtime.developerIdentitySeed);
  expect(principal).toBe(runtime.developerIdentityPrincipal);
  await expect(page.locator('[data-tid="auth-error"]')).toHaveCount(0);
  await expect(page.locator('[data-tid="app-background-frame"][data-app-id="evm_wallet"]')).toHaveAttribute("data-resident-launch", "ready", { timeout: 120_000 });
  if (await page.locator(WALLET_FRAME).count() === 0) {
    await page.locator('[data-tid="launcher-open"]').click();
    await page.locator('[data-tid="launcher-tile-evm_wallet-evm_wallet"]').click();
  }
  const wallet = page.frameLocator(WALLET_FRAME);
  await expect(wallet.getByTestId("evm-account-address")).toHaveText(/^0x[0-9a-f]{40}$/iu, { timeout: 120_000 });
  await wallet.getByTestId("evm-network-select").selectOption(chainId);
  return wallet;
}
async function canonicalReceipt(chain: LocalEvmChain, hash: string): Promise<Receipt> {
  let receipt: Receipt | null = null;
  await expect.poll(async () => {
    receipt = await chain.rpc<Receipt | null>("eth_getTransactionReceipt", [hash]);
    return receipt !== null;
  }, { timeout: 120_000 }).toBe(true);
  const result = receipt as unknown as Receipt;
  expect(result.transactionHash.toLowerCase()).toBe(hash.toLowerCase());
  expect(BigInt(result.status)).toBe(1n);
  const block = await chain.rpc<{ hash: string }>("eth_getBlockByNumber", [result.blockNumber, false]);
  expect(block.hash.toLowerCase()).toBe(result.blockHash.toLowerCase());
  return result;
}
async function miningMode(chain: LocalEvmChain): Promise<MiningMode> {
  const [automine, interval] = await Promise.all([
    chain.rpc<boolean>("anvil_getAutomine"),
    chain.rpc<number | null>("anvil_getIntervalMining"),
  ]);
  expect(typeof automine).toBe("boolean");
  expect(interval === null || (Number.isSafeInteger(interval) && interval > 0)).toBe(true);
  return { automine, interval };
}
async function tokenRead(chain: LocalEvmChain, token: string, method: "allowance" | "balanceOf", args: string[], block = "latest"): Promise<bigint> {
  const raw = await chain.rpc<string>("eth_call", [{ to: token, data: TOKEN_ABI.encodeFunctionData(method, args) }, block]);
  return BigInt(TOKEN_ABI.decodeFunctionResult(method, raw)[0]);
}
async function deployToken(chain: LocalEvmChain, owner: string): Promise<{ token: string; deploymentHash: string; mintHash: string }> {
  const dependencies = process.env.NEUTRON_UNISWAP_FIXTURE_DEPS;
  if (!dependencies) throw new Error("Set NEUTRON_UNISWAP_FIXTURE_DEPS to the installed pinned Solidity fixture dependencies");
  const require = createRequire(path.join(dependencies, "package.json"));
  const solc = require("solc") as { version(): string; compile(input: string): string };
  expect(solc.version()).toMatch(/^0\.8\.24\b/u);
  const source = await readFile(new URL("../../apps/uniswap/test/fixtures/Tokens.sol", import.meta.url), "utf8");
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity", sources: { "Tokens.sol": { content: source } },
    settings: { evmVersion: "paris", optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "Token": ["evm.bytecode.object", "evm.deployedBytecode.object"] } } },
  }))) as { errors?: { severity: string; formattedMessage: string }[]; contracts: Record<string, Record<string, { evm: { bytecode: { object: string }; deployedBytecode: { object: string } } }>> };
  expect(output.errors?.filter((error) => error.severity === "error") ?? []).toEqual([]);
  const artifact = output.contracts["Tokens.sol"]!["Token"]!;
  const accounts = await chain.rpc<string[]>("eth_accounts");
  expect(accounts.length).toBeGreaterThan(0);
  const deployer = getAddress(accounts.at(-1)!);
  const deploymentHash = await chain.rpc<string>("eth_sendTransaction", [{ from: deployer, data: `0x${artifact.evm.bytecode.object}`, gas: "0x4c4b40" }]);
  const deployment = await canonicalReceipt(chain, deploymentHash);
  const token = getAddress(deployment.contractAddress!);
  expect((await chain.rpc<string>("eth_getCode", [token, "latest"])).toLowerCase()).toBe(`0x${artifact.evm.deployedBytecode.object}`.toLowerCase());
  const mintHash = await chain.rpc<string>("eth_sendTransaction", [{ from: deployer, to: token, data: TOKEN_ABI.encodeFunctionData("mint", [owner, TOKENS]), gas: "0x493e0" }]);
  await canonicalReceipt(chain, mintHash);
  return { token, deploymentHash, mintHash };
}
