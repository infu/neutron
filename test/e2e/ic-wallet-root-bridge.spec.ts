import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import esbuild from "esbuild";
import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
import { resolveLocalNeutronRuntime, type LocalNeutronRuntime } from "../../packages/neutron-provision/src/local_session.ts";
import type { BridgeIntent } from "../../apps/wallet/src/bridge.ts";
import { createLocalEvmChain } from "./fixtures/evm-wallet-chain.ts";
import { createIcWalletBridgeFixture } from "./fixtures/ic-wallet-bridge.ts";
import { expectNoEvmKernelDialogs, startEvmKernelDialogAudit } from "./fixtures/evm-wallet-browser.ts";

// Only this deterministic Kitchen Sink caller is intercepted. The installed
// Kernel, both Wallets, their signer, the official helper/minter and ledger are
// the actual artifacts and protocols under qualification.
test.describe.configure({ retries: 0 });
test.skip(path.basename(process.env.NEUTRON_NDEPLOY_CONFIG ?? "") !== "evm-wallet-local.ndeploy.json", "Requires the isolated full-protocol EVM Wallet runtime");
const tile = 'iframe[data-app-id="kitchensink"][data-tile-id="main"]';
const amount = 20_000_000_000_000_000n;

test("only the direct root can execute a durable IC bridge and reconcile its exact mint after reload", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  const build = await esbuild.build({ entryPoints: [fileURLToPath(new URL("./fixtures/ic-wallet-root-bridge-harness.ts", import.meta.url))], bundle: true, write: false, platform: "browser", format: "esm", target: "es2022" });
  await page.route(/\/app\/kitchensink\/(?:main|service)\.js(?:\?.*)?$/u, (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: build.outputFiles[0]!.text }));
  const runtime = resolveLocalNeutronRuntime();
  const protocol = await createIcWalletBridgeFixture(runtime);
  const chain = await createLocalEvmChain();
  let kitchen = await openHarness(page, runtime);
  await enableAgent(page, kitchen);
  await kitchen.locator('[data-tid="inspect"]').click();
  const accounts = JSON.parse(await result(kitchen, "inspect", "success")) as { accounts: { accountId: string; address: string }[] };
  const address = accounts.accounts.find((entry) => entry.accountId === "main")!.address;
  await chain.fund(address);
  const before = { nonce: await chain.nonce(address), balance: await protocol.ckethBalance(runtime.canisterId) };
  const openTiles = { wallet: await page.locator('iframe[data-app-id="wallet"][data-tile-id="wallet"]').count(), evm: await page.locator('iframe[data-app-id="evm_wallet"][data-tile-id="evm_wallet"]').count() };
  await startEvmKernelDialogAudit(page);
  for (const action of ["human", "nested"] as const) {
    await kitchen.getByLabel("Bridge request ID").fill(randomBytes(16).toString("hex"));
    await kitchen.locator(`[data-tid="${action}"]`).click();
    expect(await result(kitchen, action, "error")).toContain("wallet_bridge_prepare_root_v1");
    expect(await chain.nonce(address)).toBe(before.nonce);
    expect(await protocol.ckethBalance(runtime.canisterId)).toBe(before.balance);
  }
  const id = randomBytes(16).toString("hex");
  await kitchen.getByLabel("Bridge request ID").fill(id);
  await page.locator('[data-tid="launcher-open"]').focus();
  await kitchen.locator('[data-tid="direct"]').evaluate((button: HTMLButtonElement) => button.click());
  const executed = JSON.parse(await result(kitchen, "direct", "success")) as { prepared: BridgeIntent; operation: { transactionHash: string }; attachment: BridgeIntent };
  const hash = executed.operation.transactionHash;
  expect(hash).toMatch(/^0x[0-9a-f]{64}$/iu);
  expect(executed.prepared.source).toMatchObject({ appId: "kitchensink", installationUid: expect.any(String) });
  expect(executed.attachment.steps.find((step) => step.kind === "deposit")).toMatchObject({ transactionHash: hash });
  const saved = await protocol.walletBridge(id);
  expect(saved.source).toEqual(executed.prepared.source);
  expect(saved.amount).toBe(String(amount));
  expect(await chain.nonce(address)).toBe(before.nonce + 1n);
  await expectNoEvmKernelDialogs(page);
  await expect(page.locator('iframe[data-app-id="wallet"][data-tile-id="wallet"]')).toHaveCount(openTiles.wallet);
  await expect(page.locator('iframe[data-app-id="evm_wallet"][data-tile-id="evm_wallet"]')).toHaveCount(openTiles.evm);

  // A new caller endpoint retains the installation identity. Re-entering the
  // root with the same bridge ID reconciles the original request/hash.
  await page.reload();
  kitchen = await openHarness(page, runtime, false);
  await enableAgent(page, kitchen);
  await kitchen.getByLabel("Bridge request ID").fill(id);
  await kitchen.locator('[data-tid="direct"]').click();
  const resumed = JSON.parse(await result(kitchen, "direct", "success")) as { prepared: BridgeIntent; next: { request: unknown } };
  expect(resumed.prepared.source).toEqual(saved.source);
  expect(resumed.next.request).toBeNull();
  expect(await chain.nonce(address)).toBe(before.nonce + 1n);
  const mint = await protocol.advanceUntilMint(hash);
  expect(mint.accepted).toMatchObject({ transactionHash: hash, amount: String(amount), recipient: runtime.canisterId });
  expect(mint.ledgerBlock).toMatchObject({ kind: "mint", amount: String(amount), recipient: runtime.canisterId });
  await kitchen.locator('[data-tid="refresh"]').click();
  const reconciled = JSON.parse(await result(kitchen, "refresh", "success")) as BridgeIntent;
  expect(reconciled.mint).toMatchObject({ verifiedLedger: true, ledgerBlockIndex: mint.minted.ledgerBlockIndex });
  expect(await protocol.ckethBalance(runtime.canisterId)).toBe(before.balance + amount);
  expect(await chain.nonce(address)).toBe(before.nonce + 1n);
  const evidencePath = testInfo.outputPath("root-bridge-protocol-evidence.json");
  await writeFile(evidencePath, JSON.stringify({ id, address, before, executed, resumed, mint, reconciled }, (_key, value) => typeof value === "bigint" ? String(value) : value, 2));
  await testInfo.attach("root-bridge-protocol-evidence", { path: evidencePath, contentType: "application/json" });
});

async function result(frame: FrameLocator, action: string, status: "success" | "error"): Promise<string> {
  const output = frame.locator('[data-tid="ic-bridge-root-result"]');
  await expect(output).toHaveAttribute("data-action", action, { timeout: 180_000 });
  await expect.poll(() => output.getAttribute("data-status"), { timeout: 180_000 }).not.toBe("pending");
  const text = await output.innerText();
  expect(await output.getAttribute("data-status"), text).toBe(status);
  return text;
}
async function openHarness(page: Page, runtime: LocalNeutronRuntime, navigate = true): Promise<FrameLocator> {
  if (navigate) await page.goto(localCanisterOrigin(runtime.canisterId, runtime.gatewayUrl));
  await page.waitForFunction(() => typeof (window as typeof window & { __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: unknown }).__NEUTRON_PLAYWRIGHT_LOGIN_AS__ === "function");
  expect(await page.evaluate(async (seed) => {
    const login = (window as typeof window & { __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: (seed: number) => Promise<string> }).__NEUTRON_PLAYWRIGHT_LOGIN_AS__!;
    return login(seed);
  }, runtime.developerIdentitySeed)).toBe(runtime.developerIdentityPrincipal);
  for (const appId of ["wallet", "evm_wallet", "kitchensink"]) await expect(page.locator(`[data-tid="app-background-frame"][data-app-id="${appId}"]`)).toHaveAttribute("data-resident-launch", "ready", { timeout: 120_000 });
  if (!await page.locator(tile).count()) {
    await page.locator('[data-tid="launcher-open"]').click();
    await page.locator('[data-tid="launcher-tile-kitchensink-main"]').click();
  }
  const frame = page.frameLocator(tile);
  await expect(frame.locator('[data-tid="ic-bridge-root-harness"]')).toBeVisible();
  return frame;
}

async function enableAgent(page: Page, kitchen: FrameLocator): Promise<void> {
  await page.locator(tile).focus();
  await kitchen.locator('[data-tid="enable"]').click();
  const grant = page.locator('[data-tid="agent-grant-dialog"]');
  await expect.poll(async () => await grant.isVisible() || await page.locator('[data-tid="agent-mode-indicator"]').isVisible(), { timeout: 30_000 }).toBe(true);
  if (await grant.isVisible()) {
    await expect(grant).toContainText("capability_agent_demo");
    await grant.locator('[data-tid="agent-grant-approve"]').click();
  }
  await result(kitchen, "enable", "success");
  await expect(page.locator('[data-tid="agent-mode-indicator"]')).toBeVisible();
}
