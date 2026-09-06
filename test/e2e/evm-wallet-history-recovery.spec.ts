import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Actor, type HttpAgent } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
import { createKernelActor, localIdentityFromSeed } from "../../packages/neutron-provision/src/kernel.ts";
import { resolveLocalNeutronRuntime } from "../../packages/neutron-provision/src/local_session.ts";
import { createLocalEvmChain } from "./fixtures/evm-wallet-chain.ts";

test.describe.configure({ retries: 0 });
test.skip(path.basename(process.env.NEUTRON_NDEPLOY_CONFIG ?? "") !== "evm-wallet-local.ndeploy.json", "Requires the dedicated local fixture and coordinator's chain1 status-recovery window");
const FRAME = 'iframe[data-app-id="evm_wallet"][data-tile-id="evm_wallet"]';
const REQUEST = "3d5d22f4832cf63640b997c62bf8b5b7";
const HASH = "0xeb9fe0a37a31404751663b65f0af3f79016b3354e2f274b58792fe1ee4f70b20";
const DEPLOYMENT = "c4b89b6fe632613a6dccab85444e5240";
const PIN_SHA = "79e8bf5fb7d85674466949f15978c05d43c3879e18332ac08cb52d918b4a0723";
const EVIDENCE = path.resolve(".neutron/release-receipts/evm-wallet-completion-2026-09-06/browser-history-recovery-final-342-106");
type Entry = { operation_id: bigint; request_id: string; chain_id: bigint; status: string; address: string; transaction_hash: [] | [string]; receipt_json: [] | [string] };
type TraceEntry = { frame: string; payload: { type: string; method: string; tool: string; args: unknown[] } };
const encode = (value: unknown): string => JSON.stringify(value, (_key, entry: unknown) => typeof entry === "bigint" ? entry.toString() : entry, 2) + "\n";
const sha = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

test("all durable history pages survive reload and the existing mined operation reconciles without a new nonce", async ({ page, request }, testInfo) => {
  test.setTimeout(360_000);
  await mkdir(EVIDENCE, { recursive: true });
  const pinBytes = await readFile(path.resolve(EVIDENCE, "../installed-final-candidates.json"));
  expect(sha(pinBytes)).toBe(PIN_SHA);
  const pins = JSON.parse(pinBytes.toString()) as { deploymentId: string; canisterId: string; installed: { id: string; version: number; sha256: string }[] };
  expect(pins.deploymentId).toBe(DEPLOYMENT);
  for (const [id, version, file] of [["kernel", 342, "apps/kernel/kernel.v0.3.42.neutron"], ["evm_wallet", 106, "apps/evm_wallet/evm_wallet.v0.1.6.neutron"]] as const) {
    const pin = pins.installed.find((entry) => entry.id === id)!;
    expect(pin.version).toBe(version);
    expect(sha(await readFile(file))).toBe(pin.sha256);
  }
  const runtime = resolveLocalNeutronRuntime();
  expect(runtime.canisterId).toBe(pins.canisterId);
  const journalBefore = await readFile(runtime.sessionPath);
  const kernel = await createKernelActor({ canisterId: runtime.canisterId, host: runtime.gatewayUrl, identity: localIdentityFromSeed(runtime.developerIdentitySeed), fetchRootKey: true });
  const installedBefore = await kernel.kernel_runtime_info();
  expect(installedBefore.deployment_id).toBe(DEPLOYMENT);
  expect(installedBefore.apps.find((entry) => entry.scope.app_id === "kernel")?.version).toBe(342n);
  expect(installedBefore.apps.find((entry) => entry.scope.app_id === "evm_wallet")?.version).toBe(106n);
  const agent = Actor.agentOf(kernel) as HttpAgent;
  const origin = localCanisterOrigin(runtime.canisterId, runtime.gatewayUrl);
  const registryResponse = await request.get(new URL("/system/apps.json", origin).href);
  expect(registryResponse.ok()).toBe(true);
  expect(registryResponse.headers()["ic-certificate"]).toBeTruthy();
  const registry = await registryResponse.json() as Record<string, { version: number; functions: { name: string; type: string; candid_name: string }[] }>;
  expect(registry.evm_wallet?.version).toBe(106);
  const fn = registry.evm_wallet!.functions.find((entry) => entry.name === "evm_wallet_history_v1")!;
  expect(fn.type).toBe("query");
  const historyType = IDL.Variant({ ok: IDL.Record({ total: IDL.Nat, operations: IDL.Vec(IDL.Record({ operation_id: IDL.Nat, request_id: IDL.Text, chain_id: IDL.Nat, status: IDL.Text, address: IDL.Text, transaction_hash: IDL.Opt(IDL.Text), receipt_json: IDL.Opt(IDL.Text) })) }), err: IDL.Text });
  async function backendHistory(label: string): Promise<{ total: bigint; operations: Entry[] }> {
    const response = await agent.query(runtime.canisterId, { methodName: fn.candid_name, arg: new Uint8Array(IDL.encode([IDL.Record({ offset: IDL.Nat, limit: IDL.Nat })], [{ offset: 0n, limit: 100_000n }])) });
    if (response.status !== "replied") throw new Error(`History query rejected: ${response.reject_message}`);
    const raw = new Uint8Array(response.reply.arg);
    const result = IDL.decode([historyType], raw)[0] as { ok?: { total: bigint; operations: Entry[] }; err?: string };
    if (!result.ok) throw new Error(result.err ?? "History query has no result");
    expect(BigInt(result.ok.operations.length)).toBe(result.ok.total);
    await writeFile(path.join(EVIDENCE, `${label}.json`), encode({ method: fn.candid_name, replySha256: sha(raw), ...result.ok }));
    return result.ok;
  }
  const before = await backendHistory("backend-before");
  expect(before.total).toBeGreaterThanOrEqual(25n);
  const operation = before.operations.find((entry) => entry.operation_id === 22n)!;
  expect(operation.request_id).toBe(REQUEST);
  expect(operation.chain_id).toBe(1n);
  expect(operation.status).toBe("unknown");
  expect(operation.transaction_hash).toEqual([HASH]);
  const chain = await createLocalEvmChain();
  async function nonces() { return { latest: await chain.rpc<string>("eth_getTransactionCount", [operation.address, "latest"]), pending: await chain.rpc<string>("eth_getTransactionCount", [operation.address, "pending"]) }; }
  const nonceBefore = await nonces();
  expect(BigInt(nonceBefore.latest)).toBe(11n);
  expect(BigInt(nonceBefore.pending)).toBe(11n);
  const canonicalBefore = await chain.evidence(HASH);
  const receiptBefore = await chain.rpc<{ blockNumber: string; blockHash: string; status: string }>("eth_getTransactionReceipt", [HASH]);
  expect((await chain.rpc<{ hash: string }>("eth_getBlockByNumber", [receiptBefore.blockNumber, false])).hash.toLowerCase()).toBe(receiptBefore.blockHash.toLowerCase());
  expect(BigInt(receiptBefore.status)).toBe(1n);
  const transport: TraceEntry[] = [];
  await page.exposeBinding("__EVM_HISTORY_CAPTURE__", ({ frame }, payload: TraceEntry["payload"]) => { transport.push({ frame: frame.url(), payload }); });
  await page.addInitScript(() => {
    if (!location.pathname.startsWith("/app/evm_wallet/")) return;
    const original = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (...args: Parameters<typeof original>) {
      const payload = args[0];
      if (payload?.type === "neutron:self-call:exec") {
        const capture = (window as typeof window & { __EVM_HISTORY_CAPTURE__?: (value: unknown) => Promise<void> }).__EVM_HISTORY_CAPTURE__;
        if (capture) void capture(structuredClone(payload));
      }
      return Reflect.apply(original, this, args);
    };
  });
  const expectedIds = before.operations.map((entry) => entry.operation_id.toString());
  try {
    let wallet = await openWallet(page, origin, runtime.developerIdentitySeed);
    const first = await loadAllHistory(wallet, expectedIds);
    await writeFile(path.join(EVIDENCE, "ui-before-reload.json"), encode(first));
    await testInfo.attach("history-all-pages", { body: await page.screenshot(), contentType: "image/png" });
    await page.reload();
    wallet = await openWallet(page, origin, runtime.developerIdentitySeed, false);
    const reloaded = await loadAllHistory(wallet, expectedIds);
    await writeFile(path.join(EVIDENCE, "ui-after-reload.json"), encode(reloaded));
    const row = wallet.getByTestId("evm-operation-22");
    await expect(row).toContainText(`Request ${REQUEST}`);
    await expect(row.locator('[data-status="unknown"]')).toBeVisible();
    await row.getByRole("button", { name: "Check status", exact: true }).click();
    await expect(row.locator('[data-status="confirmed"]')).toBeVisible({ timeout: 120_000 });
    await loadAllHistory(wallet, expectedIds);
    await expect(wallet.locator('.evm-app > [role="alert"]')).toHaveCount(0);
    await expect(wallet.getByTestId("evm-review")).toHaveCount(0);
    const after = await backendHistory("backend-after");
    expect(after.operations.map((entry) => entry.operation_id.toString())).toEqual(expectedIds);
    expect(after.operations.map((entry) => entry.request_id)).toEqual(before.operations.map((entry) => entry.request_id));
    const reconciled = after.operations.find((entry) => entry.operation_id === 22n)!;
    expect(reconciled.status).toBe("confirmed");
    expect(reconciled.transaction_hash).toEqual([HASH]);
    const receipt = JSON.parse(reconciled.receipt_json[0]!);
    expect(receipt.transactionHash.toLowerCase()).toBe(HASH);
    expect(BigInt(receipt.status)).toBe(1n);
    expect(receipt.blockHash.toLowerCase()).toBe(receiptBefore.blockHash.toLowerCase());
    const nonceAfter = await nonces();
    expect(nonceAfter).toEqual(nonceBefore);
    const canonicalAfter = await chain.evidence(HASH);
    expect(canonicalAfter).toEqual(canonicalBefore);
    const installedAfter = await kernel.kernel_runtime_info();
    expect(installedAfter.deployment_id).toBe(DEPLOYMENT);
    expect(sha(await readFile(runtime.sessionPath))).toBe(sha(journalBefore));
    const allowed = ["evm_wallet_snapshot_v1", "evm_wallet_history_v1", "evm_wallet_balances_v1", "evm_wallet_status_v1"];
    expect(transport.length).toBeGreaterThan(0);
    expect(transport.filter((entry) => !allowed.includes(entry.payload.method))).toEqual([]);
    const statusCalls = transport.filter((entry) => entry.payload.method === "evm_wallet_status_v1");
    expect(statusCalls).toHaveLength(1);
    expect(statusCalls[0]?.payload.args[0]).toMatchObject({ identity: { request_id: REQUEST }, refresh: true });
    await page.screenshot({ path: path.join(EVIDENCE, "history-operation22-confirmed.png"), fullPage: true });
    const result = { schema: "neutron-evm-history-status-recovery-v1", observedAt: new Date().toISOString(), deploymentId: DEPLOYMENT, installedProofSha256: PIN_SHA, installed: pins.installed, total: before.total, beforeStatus: operation.status, afterStatus: reconciled.status, operationId: "22", requestId: REQUEST, transactionHash: HASH, first, reloaded, nonceBefore, nonceAfter, canonicalBefore, canonicalAfter, statusCallCount: statusCalls.length, effects: "Only existing operation status reconciliation; no prepare, execute, signing, new request, fund or mining calls", provisioningJournalUnchanged: true };
    await writeFile(path.join(EVIDENCE, "result.json"), encode(result));
    await testInfo.attach("history-recovery-result", { path: path.join(EVIDENCE, "result.json"), contentType: "application/json" });
  } finally {
    await writeFile(path.join(EVIDENCE, "wallet-self-call-transport.json"), encode(transport));
    await writeFile(path.join(EVIDENCE, "nonce-postflight.json"), encode(await nonces()));
  }
});

async function loadAllHistory(wallet: FrameLocator, expectedIds: string[]): Promise<{ ids: string[]; pageSizes: number[] }> {
  await wallet.getByRole("navigation", { name: "Wallet pages" }).getByRole("button", { name: "Activity", exact: true }).click();
  const rows = wallet.locator('.evm-activity [data-testid^="evm-operation-"]');
  await expect(rows.first()).toBeVisible({ timeout: 120_000 });
  const pageSizes = [await rows.count()];
  for (;;) {
    const more = wallet.getByRole("button", { name: "Load more", exact: true });
    if (!await more.isVisible()) break;
    const count = await rows.count();
    await more.click();
    await expect.poll(() => rows.count(), { timeout: 120_000 }).toBeGreaterThan(count);
    await expect(wallet.locator('.evm-app > [role="alert"]')).toHaveCount(0);
    pageSizes.push(await rows.count());
  }
  const ids = (await rows.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-testid")!.replace("evm-operation-", ""))));
  expect(ids).toEqual(expectedIds);
  expect(new Set(ids).size).toBe(ids.length);
  await expect(wallet.locator('.evm-app > [role="alert"]')).toHaveCount(0);
  return { ids, pageSizes };
}
async function openWallet(page: Page, origin: string, seed: number, navigate = true): Promise<FrameLocator> {
  if (navigate) await page.goto(origin);
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
  await expect(wallet.getByTestId("evm-account-address")).toHaveText(/^0x[0-9a-f]{40}$/iu, { timeout: 120_000 });
  return wallet;
}
