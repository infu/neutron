/**
 * Actual React + provider + SDK inside the production allow-scripts-only sandbox.
 * Only the Kernel bridge/projected backend is mocked; no funds or real signer.
 * Run: node apps/evm_wallet/test/browser/sandbox.mjs
 * Optional: --output-dir PATH, --source-dir PATH (historical src tree for regression proof).
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const source = join(root, "apps/evm_wallet/src");
const option = (name) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  if (!process.argv[index + 1]) throw new Error(`Missing value for ${name}`);
  return resolve(process.argv[index + 1]);
};
const historicalSource = option("--source-dir");
const historyOnly = process.argv.includes("--history-only");
const pricesOnly = process.argv.includes("--prices-only");
const decodersOnly = process.argv.includes("--decoders-only");
const approvalsOnly = process.argv.includes("--approvals-only");
const output = option("--output-dir") ?? await mkdtemp(join(tmpdir(), "neutron-evm-wallet-sandbox-"));
await mkdir(output, { recursive: true });
const mock = await readFile(join(here, "mock_app.ts"), "utf8");
const sourceHashes = {};
sourceHashes["test/browser/mock_app.ts"] = createHash("sha256").update(mock).digest("hex");
sourceHashes["test/browser/rpc_fixture.ts"] = createHash("sha256").update(await readFile(join(here, "rpc_fixture.ts"))).digest("hex");
const historyCapture = JSON.parse(await readFile(join(here, "../fixtures/history-25-operations.json"), "utf8"));
const normalizedHistory = historyCapture.normalized;
const backendSchemaJson = await readFile(join(root, "apps/evm_wallet/dist/schema.json"), "utf8");
const backendSchemas = JSON.parse(backendSchemaJson).methods;
sourceHashes["dist/schema.json"] = createHash("sha256").update(backendSchemaJson).digest("hex");
assert(normalizedHistory?.operations?.length === 25, "Captured history fixture must provide 25 normalized operations");
const kernelCodecPath = join(root, "apps/kernel/src/self_calls.ts");
sourceHashes["kernel/self_calls.ts"] = createHash("sha256").update(await readFile(kernelCodecPath)).digest("hex");
const bootstrap = `import { encodeSelfCallResult } from ${JSON.stringify(kernelCodecPath)};
import ${JSON.stringify(join(here, "rpc_fixture.ts"))};
window.__evmKernelEncodeSelfCallResult = encodeSelfCallResult;
window.__evmCapturedHistory = ${JSON.stringify(normalizedHistory)};
window.__evmBackendSchemas = ${JSON.stringify(backendSchemas)};
await import(${JSON.stringify(join(source, "main.tsx"))});`;
await build({
  absWorkingDir: root, entryPoints: ["sandbox-qualification-entry"], outfile: join(output, "main.js"),
  bundle: true, platform: "browser", format: "esm", jsx: "automatic", logLevel: "warning",
  plugins: [{ name: "sandbox-qualification", setup(builder) {
    builder.onResolve({ filter: /^sandbox-qualification-entry$/ }, () => ({ path: "entry", namespace: "bootstrap" }));
    builder.onLoad({ filter: /.*/, namespace: "bootstrap" }, () => ({ contents: bootstrap, loader: "js", resolveDir: root }));
    builder.onResolve({ filter: /^neutron-tools\/app$/ }, () => ({ path: "app", namespace: "fixture" }));
    builder.onResolve({ filter: /app_entry\.ts$/ }, ({ path, resolveDir }) => resolve(resolveDir, path) === join(root, "packages/neutron-tools/src/app_entry.ts") ? { path: "app", namespace: "fixture" } : undefined);
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: mock, loader: "ts", resolveDir: here }));
    builder.onLoad({ filter: /\.(ts|tsx)$/ }, async ({ path }) => {
      if (!path.startsWith(source + "/")) return;
      const name = relative(source, path);
      const contents = await readFile(historicalSource ? join(historicalSource, name) : path, "utf8");
      sourceHashes[name] = createHash("sha256").update(contents).digest("hex");
      return { contents, loader: path.endsWith(".tsx") ? "tsx" : "ts", resolveDir: dirname(path) };
    });
  } }, sassPlugin()],
});
const hostHtml = '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><iframe title="EVM Wallet" sandbox="allow-scripts" src="/app" style="display:block;border:0;width:100vw;height:100vh"></iframe></body></html>';
const appHtml = '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/main.css"></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>';
const server = createServer(async (request, response) => {
  // Module scripts requested by an opaque-origin iframe need a CORS response.
  response.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/" || url.pathname === "/app") {
      response.setHeader("Content-Type", "text/html");
      response.end(url.pathname === "/" ? hostHtml.replace('src="/app"', 'src="/app' + url.search + '"') : appHtml); return;
    }
    if (request.url === "/favicon.ico") { response.writeHead(204); response.end(); return; }
    const files = {
      "/main.js": [join(output, "main.js"), "application/javascript"],
      "/main.css": [join(output, "main.css"), "text/css"],
      "/static/icon.svg": [join(root, "apps/evm_wallet/public/static/icon.svg"), "image/svg+xml"],
    };
    const file = files[request.url];
    if (!file) { response.writeHead(404); response.end(); return; }
    response.setHeader("Content-Type", file[1]); response.end(await readFile(file[0]));
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
let executablePath = process.env.EVM_BROWSER_CHROMIUM;
if (!executablePath) {
  const systemChrome = "/run/current-system/sw/bin/google-chrome-stable";
  try { await access(systemChrome); executablePath = systemChrome; } catch { /* Use Playwright's installed Chromium. */ }
}
const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true, args: ["--no-sandbox"] });
const checks = [], screenshots = [], browserErrors = [], consoleMessages = [];
const methods = { prepare: "evm_wallet_prepare_browser_v1", reject: "evm_wallet_reject_v1", execute: "evm_wallet_execute_v1", token: "evm_wallet_asset_set_v1" };
const typedJson = '{"types":{"EIP712Domain":[],"Permit":[{"name":"amount","type":"uint256"}]},"primaryType":"Permit","domain":{},"message":{"amount":9007199254740993}}';
let activePage, activeLabel;
const tick = (frame) => frame.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const calls = (frame, method) => frame.evaluate((method) => window.__evmSandbox.calls.filter((call) => call.method === method), method);
async function assertNoEffects(frame, label) {
  assert.equal((await calls(frame, methods.prepare)).length, 0, `${label}: invalid input prepared a request`);
  assert.equal((await calls(frame, methods.token)).length, 0, `${label}: invalid input saved a token`);
  assert.equal((await calls(frame, methods.execute)).length, 0, `${label}: executed without approval`);
}
async function runCase(width, form, action) {
  const label = `${width}-${form}-${action}`;
  activeLabel = label;
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  activePage = page;
  page.on("pageerror", (error) => browserErrors.push({ label, error: String(error) }));
  page.on("console", (message) => {
    if (message.type() === "error" || /sandbox|submission/i.test(message.text())) consoleMessages.push({ label, type: message.type(), text: message.text() });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  assert.equal(await page.locator("iframe").getAttribute("sandbox"), "allow-scripts");
  const frame = page.frames().find((candidate) => candidate.url().endsWith("/app"));
  assert(frame, `${label}: sandbox frame missing`);
  await frame.getByTestId("evm-account-address").filter({ hasText: "0x2222222222222222222222222222222222222222" }).waitFor();
  const restrictions = await frame.evaluate(() => {
    const denied = (action) => { try { action(); return false; } catch (error) { return error.name === "SecurityError"; } };
    return { opaqueOrigin: self.origin === "null", parentDenied: denied(() => parent.document), localStorageDenied: denied(() => localStorage), indexedDBDenied: denied(() => indexedDB.open("qualification")) };
  });
  assert.deepEqual(restrictions, { opaqueOrigin: true, parentDenied: true, localStorageDenied: true, indexedDBDenied: true });
  await frame.locator("nav").getByRole("button", { name: form === "send" ? "Send" : form === "sign" ? "Settings" : form === "replacement" ? "Activity" : "Settings", exact: true }).click();
  if (form === "sign") await frame.getByRole("button", { name: "Sign a message", exact: true }).click();
  let button, input;
  if (form === "send") {
    button = frame.getByTestId("evm-send-review"); input = frame.getByTestId("evm-send-amount");
    await button.click(); await tick(frame); await assertNoEffects(frame, label);
    assert.equal(await frame.getByTestId("evm-send-to").evaluate((element) => element.validity.valueMissing), true);
    await frame.getByTestId("evm-send-to").fill("0x4444444444444444444444444444444444444444");
    await input.fill("0.001");
  } else if (form === "sign") {
    button = frame.getByTestId("evm-sign-review"); input = frame.getByTestId("evm-sign-content");
    await button.click(); await tick(frame); await assertNoEffects(frame, label);
    assert.equal(await input.evaluate((element) => element.validity.valueMissing), true);
    if (action === "enter") await frame.getByTestId("evm-sign-mode").selectOption("typed_data");
    const content = action === "enter" ? typedJson : "Sign this exact message";
    await input.fill(content); await input.press("End"); await input.press("Enter");
    assert.equal(await input.inputValue(), content + "\n", `${label}: textarea Enter did not insert only a newline`);
    await assertNoEffects(frame, label);
  } else if (form === "replacement") {
    const operation = frame.getByTestId("evm-operation-100");
    await operation.getByText("Speed up or cancel", { exact: true }).click();
    button = operation.getByRole("button", { name: "Review replacement", exact: true });
    input = operation.getByLabel("Maximum fee per gas", { exact: true });
    await input.fill(""); await button.click(); await tick(frame); await assertNoEffects(frame, label);
    await input.fill("25000000000");
    await operation.getByLabel("Priority fee per gas", { exact: true }).fill("1500000000");
  } else {
    button = frame.getByRole("button", { name: "Save selected token", exact: true });
    input = frame.getByLabel("Decimals", { exact: true });
    await button.click(); await tick(frame); await assertNoEffects(frame, label);
    await frame.getByLabel("Token contract", { exact: true }).fill("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    await frame.getByLabel("Display symbol", { exact: true }).fill("USDC");
    await input.fill("6");
  }
  const pendingMethod = form === "token" ? methods.token : methods.prepare;
  await frame.evaluate((method) => window.__evmSandbox.hold(method), pendingMethod);
  // Keep the actual controls for a same-task duplicate activation burst, even
  // when a pending signature replaces its form with its saved request panel.
  await button.evaluate((element) => { window.__pendingButton = element; });
  await input.evaluate((element) => { window.__pendingInput = element; });
  if (action === "click") await button.click();
  else if (form === "sign") { await button.focus(); await button.press("Enter"); }
  else await input.press("Enter");
  await frame.waitForFunction((method) => window.__evmSandbox.calls.some((call) => call.method === method), pendingMethod, { timeout: 2000 }).catch(async (error) => {
    const uiErrors = await frame.locator(".evm-error").allTextContents();
    throw new Error(`${label}: action did not reach ${pendingMethod}. UI errors: ${JSON.stringify(uiErrors)}. ${error.message}`);
  });
  await frame.evaluate(() => {
    window.__pendingButton.click(); window.__pendingButton.click();
    for (const repeat of [false, false, true]) window.__pendingInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, repeat }));
    for (const button of document.querySelectorAll("button:disabled")) button.click();
  });
  await tick(frame);
  assert.equal((await calls(frame, pendingMethod)).length, 1, `${label}: duplicate action while pending`);
  assert.equal(await frame.getByRole("dialog").count(), 0, `${label}: review appeared before prepare finished`);
  if (form !== "token") {
    await frame.getByTestId("evm-preparing-review").waitFor();
    assert((await frame.getByTestId("evm-preparing-review").textContent()).includes("Your approval is required before signing"));
  }
  assert.equal((await calls(frame, methods.execute)).length, 0);
  await frame.evaluate((method) => window.__evmSandbox.release(method), pendingMethod);
  const prepared = (await calls(frame, pendingMethod))[0];
  if (form === "token") {
    await frame.getByLabel("Token contract", { exact: true }).waitFor();
    await frame.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent === "Save selected token" && !button.disabled));
    assert.deepEqual(prepared.args, [{ chain_id: "1", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: "6" }]);
    assert.equal(await frame.getByLabel("Token contract", { exact: true }).inputValue(), "");
    assert.equal((await calls(frame, methods.token)).length, 1);
  } else {
    await frame.getByRole("dialog").waitFor();
    assert.match(prepared.args[0].request.identity.request_id, /^[0-9a-f]{32}$/);
    assert.equal(prepared.args[0].request.identity.caller.app_id, "evm_wallet");
    assert.equal(prepared.args[0].request.identity.caller.installation_uid, "12");
    const routing = await frame.evaluate(() => window.__evmSandbox.routing);
    assert.equal(routing.length, 2, `${label}: owner request must traverse resident handler and owner tile`);
    assert.equal(routing[0].leg, "tile_to_resident");
    assert.equal(routing[0].caller.role, "tile");
    assert.equal(routing[0].caller.endpoint, "app:evm_wallet:tile:evm_wallet:instance:browser-qualification");
    assert.equal(routing[1].leg, "resident_to_owner");
    assert.equal(routing[1].target, routing[0].caller.endpoint);
    assert.equal(routing[1].caller.endpoint, "app:evm_wallet:background");
    assert.equal(routing[1].caller.installationUid, "12");
    assert.equal(routing[1].caller.role, "background");
    assert(routing.every((leg) => !leg.hasPresenter && !leg.hasAudience), `${label}: synthesized presenter or foreground audience`);
    const intent = prepared.args[0].request.intent;
    if (form === "send") assert.deepEqual(intent.operation.transaction, { to: "0x4444444444444444444444444444444444444444", value: "1000000000000000", data: "0x", access_list: [] });
    if (form === "replacement") assert.deepEqual(intent.operation.replacement, { operation_id: "100", cancel: false, max_fee_per_gas: "25000000000", max_priority_fee_per_gas: "1500000000" });
    if (form === "sign" && action === "enter") {
      assert.equal(intent.operation.typed_data.json, typedJson + "\n");
      assert.equal(await frame.getByRole("dialog").locator("pre").textContent(), typedJson + "\n");
    }
    assert.equal((await calls(frame, methods.execute)).length, 0, `${label}: execute occurred before review`);
    const image = `${label}.png`; await page.screenshot({ path: join(output, image), fullPage: true }); screenshots.push(image);
    await frame.getByTestId("evm-review-decline").click();
    await frame.getByRole("dialog").waitFor({ state: "hidden" });
    const rejected = await calls(frame, methods.reject);
    assert.equal(rejected.length, 1); assert.equal(rejected[0].args[0].identity.request_id, prepared.args[0].request.identity.request_id);
    assert.equal((await calls(frame, methods.execute)).length, 0, `${label}: decline executed an effect`);
    const effectTools = ["evm_send_transaction_v1", "evm_sign_message_v1", "evm_sign_typed_data_v1", "evm_replace_transaction_v1"];
    assert.equal(await frame.evaluate((names) => window.__evmSandbox.toolCalls.filter((call) => names.includes(call.name)).length, effectTools), 1, `${label}: duplicate public effect invocation`);
  }
  assert.deepEqual(await frame.locator(".evm-error").allTextContents(), [], `${label}: UI error`);
  const geometry = await frame.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert(geometry.scrollWidth <= geometry.width, `${label}: horizontal overflow`);
  checks.push({ label, restrictions, invalidInputPreventsAction: true, actionCount: 1, duplicatePendingActionCount: 0, executedEffects: 0, residentHandlerExercised: form !== "token", synthesizedPresenter: false, geometry });
  await page.close(); activePage = null;
}
async function runDelayedTokenSend(width) {
  const label = `${width}-token-send-delayed-review`;
  activeLabel = label;
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  activePage = page;
  page.on("pageerror", (error) => browserErrors.push({ label, error: String(error) }));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const frame = page.frames().find((candidate) => candidate.url().endsWith("/app"));
  assert(frame, `${label}: sandbox frame missing`);
  await frame.getByTestId("evm-account-address").filter({ hasText: "0x2222222222222222222222222222222222222222" }).waitFor();
  await frame.locator("nav").getByRole("button", { name: "Send", exact: true }).click();
  await frame.getByTestId("evm-send-asset").selectOption("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
  await frame.getByTestId("evm-send-to").fill("0x4444444444444444444444444444444444444444");
  await frame.getByTestId("evm-send-amount").fill("1.25");
  await frame.evaluate(() => {
    window.__evmRpcFixture.hold("eth_getBlockByNumber");
    window.__evmSandbox.hold("evm_wallet_review_evidence_v1");
    window.__evmSandbox.hold("evm_wallet_execute_v1");
  });
  await frame.getByTestId("evm-send-review").click();
  const preparation = frame.getByTestId("evm-preparing-review");
  await preparation.waitFor();
  assert((await preparation.textContent()).includes("1.25 USDC to 0x4444444444444444444444444444444444444444"));
  assert.equal((await calls(frame, methods.execute)).length, 0);
  // Keep the backend unresolved while checking that preparation remains visible.
  await frame.waitForFunction(() => /[1-9][0-9]*s elapsed/.test(document.querySelector('[data-testid="evm-preparing-review"]')?.textContent ?? ""));
  await frame.evaluate(() => window.__evmRpcFixture.release("eth_getBlockByNumber"));
  const dialog = frame.getByRole("dialog");
  await dialog.waitFor();
  assert.equal(await preparation.count(), 0);
  assert((await dialog.textContent()).includes("1.25 USDC"));
  assert((await dialog.textContent()).includes("Checking token balance and allowance"));
  const approve = frame.getByTestId("evm-review-approve");
  assert.equal(await approve.isVisible(), true);
  assert.equal(await frame.getByTestId("evm-review-pro-details").getAttribute("open"), null, "Technical details start collapsed");
  assert.equal(await frame.getByTestId("evm-review-request-id").isVisible(), false, "Request metadata is hidden from the main confirmation");
  assert.equal(await approve.isDisabled(), true, "Do not approve while the review is loading");
  assert.equal((await calls(frame, methods.execute)).length, 0);
  await frame.evaluate(() => window.__evmSandbox.release("evm_wallet_review_evidence_v1"));
  await frame.waitForFunction(() => !document.querySelector('[data-testid="evm-review-approve"]')?.disabled);
  const approvePosition = await approve.boundingBox();
  assert(approvePosition && approvePosition.y >= 0 && approvePosition.y + approvePosition.height <= 900, `${label}: approval must be visible without scrolling the review`);
  const reviewImage = `${label}.png`; await page.screenshot({ path: join(output, reviewImage), fullPage: true }); screenshots.push(reviewImage);
  const prepared = (await calls(frame, methods.prepare))[0];
  assert.equal(await frame.getByTestId("evm-review-request-id").textContent(), prepared.args[0].request.identity.request_id);
  await approve.click();
  await frame.waitForFunction(() => window.__evmSandbox.calls.some((call) => call.method === "evm_wallet_execute_v1"));
  assert.equal(await dialog.isVisible(), true, "Keep the exact review visible while execution is unresolved");
  await approve.evaluate((button) => { button.click(); button.click(); });
  assert.equal((await calls(frame, methods.execute)).length, 1);
  const executed = (await calls(frame, methods.execute))[0];
  assert.equal(executed.args[0].identity.request_id, prepared.args[0].request.identity.request_id);
  assert.equal(executed.args[0].review_revision, "1");
  await frame.evaluate(() => window.__evmSandbox.release("evm_wallet_execute_v1"));
  await dialog.waitFor({ state: "hidden" });
  assert((await frame.locator("main").textContent()).includes("Waiting for the network to confirm"));
  const rpcCalls = await frame.evaluate(() => window.__evmRpcFixture.calls);
  assert.equal(rpcCalls.filter((call) => call.method === "eth_sendRawTransaction").length, 1);
  assert(rpcCalls.some((call) => call.method === "eth_estimateGas"));
  assert.equal((await calls(frame, "evm_wallet_prepare_v1")).length, 0);
  assert.equal((await calls(frame, "evm_wallet_balances_v1")).length, 0);
  assert.equal((await calls(frame, methods.prepare)).length, 1);
  assert.equal((await calls(frame, methods.execute)).length, 1);
  assert.equal(await frame.locator(".evm-error").count(), 0);
  const geometry = await frame.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert(geometry.scrollWidth <= geometry.width);
  checks.push({ label, preparationImmediatelyVisible: true, tokenAmountAndRecipient: true, reviewVisibleBeforeSavedEvidenceCompletes: true, approvalRequired: true, approvalVisibleWithoutScrolling: true, sameRequestAndReviewRevision: true, explicitExecuteCount: 1, duplicateExecuteCount: 0, browserRpcMethods: rpcCalls.map((call) => call.method), broadcastCount: 1, legacyOutcallMethods: 0, geometry });
  await page.close(); activePage = null;
}
async function runHistoryCase(width, rowCount) {
  const label = `${width}-history-${rowCount}`;
  activeLabel = label;
  const page = await browser.newPage({ viewport: { width, height: 900 } }); activePage = page;
  page.on("pageerror", (error) => browserErrors.push({ label, error: String(error) }));
  await page.goto(`http://127.0.0.1:${server.address().port}/?history=${rowCount}`);
  assert.equal(await page.locator("iframe").getAttribute("sandbox"), "allow-scripts");
  const frame = page.frames().find((candidate) => candidate.url().includes("/app?history="));
  assert(frame, `${label}: sandbox frame missing`);
  await frame.getByTestId("evm-account-address").filter({ hasText: "0x2222222222222222222222222222222222222222" }).waitFor();
  await frame.locator("nav").getByRole("button", { name: "Activity", exact: true }).click();
  await frame.waitForFunction(() => document.querySelector(".evm-error") || document.querySelector("[data-testid^=evm-operation-]"));
  assert.equal(await frame.locator(".evm-error").count(), 0, `${label}: initial history page surfaced an error`);
  const rows = frame.locator("[data-testid^=evm-operation-]");
  const firstCount = await rows.count();
  assert(firstCount > 0 && firstCount < rowCount, `${label}: initial metadata-constrained page did not load`);
  let loadMoreActions = 0;
  while (await frame.getByRole("button", { name: "Load more", exact: true }).count()) {
    const previousCount = await rows.count();
    await frame.getByRole("button", { name: "Load more", exact: true }).click(); loadMoreActions++;
    await frame.waitForFunction((previous) => document.querySelector(".evm-error") || document.querySelectorAll("[data-testid^=evm-operation-]").length > previous, previousCount);
    assert.equal(await frame.locator(".evm-error").count(), 0, `${label}: Load more surfaced an error`);
    assert(loadMoreActions <= rowCount, `${label}: pagination did not finish`);
  }
  const expectedIds = await frame.evaluate(() => window.__evmSandbox.expectedHistoryIds);
  const actualIds = await rows.evaluateAll((elements) => elements.map((element) => element.dataset.testid.slice("evm-operation-".length)));
  assert.equal(actualIds.length, rowCount); assert.equal(new Set(actualIds).size, rowCount);
  assert.deepEqual(actualIds, expectedIds, `${label}: history records were skipped, duplicated, or reordered`);
  const attempts = await frame.evaluate(() => window.__evmSandbox.historyAttempts);
  assert.equal(attempts[0].offset, 0); assert.equal(attempts[0].limit, 40); assert.equal(attempts[0].accepted, false);
  assert(attempts[0].metadataBytes > 64 * 1024);
  if (rowCount === 25) assert.equal(attempts[0].metadataBytes, historyCapture.metadataBytes, "Captured history metadata bytes drifted");
  for (let index = 0; index < attempts.length; index++) {
    const attempt = attempts[index];
    if (attempt.accepted) { assert(attempt.metadataBytes <= 64 * 1024); continue; }
    const next = attempts[index + 1]; assert(next, `${label}: no retry after rejected page`);
    assert.equal(next.offset, attempt.offset, `${label}: rejected page advanced the offset`);
    assert.equal(next.limit, Math.max(1, Math.floor(attempt.limit / 2)), `${label}: rejected page did not shrink`);
  }
  if (rowCount > 25) assert(attempts.some((attempt) => attempt.offset > 0 && !attempt.accepted), `${label}: Load more retry path was not exercised`);
  // Focus and pending-transaction polling may refresh an already loaded page.
  // Rendered rows above must still contain each operation exactly once.
  assert.deepEqual([...new Set(attempts.filter((attempt) => attempt.accepted).flatMap((attempt) => attempt.operationIds))], expectedIds);
  assert.equal(await frame.getByTestId("evm-account-address").textContent(), "0x2222222222222222222222222222222222222222");
  assert((await frame.locator(".evm-account-balance").textContent()).includes("1.234567890123456789"));
  assert.equal((await calls(frame, methods.execute)).length, 0);
  assert.equal((await calls(frame, methods.prepare)).length, 0);
  const geometry = await frame.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert(geometry.scrollWidth <= geometry.width, `${label}: history horizontal overflow`);
  const lastPageImage = `${label}-last-page.png`; await page.screenshot({ path: join(output, lastPageImage), fullPage: true }); screenshots.push(lastPageImage);
  await frame.evaluate(() => scrollTo(0, 0));
  const image = `${label}.png`; await page.screenshot({ path: join(output, image), fullPage: true }); screenshots.push(image);
  checks.push({ label, rowCount, firstCount, loadMoreActions, attempts, noDuplicates: true, allRowsDiscoverable: true, accountAndBalanceIntact: true, executedEffects: 0, geometry });
  await page.close(); activePage = null;
}
async function runHistoryRefreshCase(width) {
  const label = `${width}-history-refresh-95`;
  activeLabel = label;
  const page = await browser.newPage({ viewport: { width, height: 900 } }); activePage = page;
  page.on("pageerror", (error) => browserErrors.push({ label, error: String(error) }));
  await page.goto(`http://127.0.0.1:${server.address().port}/?history=95`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/app?history="));
  assert(frame, `${label}: sandbox frame missing`);
  await frame.getByTestId("evm-account-address").filter({ hasText: "0x2222222222222222222222222222222222222222" }).waitFor();
  await frame.locator("nav").getByRole("button", { name: "Activity", exact: true }).click();
  const rows = frame.locator("[data-testid^=evm-operation-]");
  await rows.first().waitFor();
  const firstCount = await rows.count();
  await frame.getByRole("button", { name: "Load more", exact: true }).click();
  await frame.waitForFunction((count) => document.querySelectorAll("[data-testid^=evm-operation-]").length > count, firstCount);
  const loadedCount = await rows.count();
  assert(loadedCount > firstCount && loadedCount < 95);
  const older = (await frame.evaluate(() => window.__evmSandbox.historySnapshot())).slice(firstCount, loadedCount).find((row) => row.status === "unknown");
  assert(older, "Fixture must include an older pending operation");
  const olderRow = frame.getByTestId(`evm-operation-${older.operation_id}`);
  assert.match(await olderRow.textContent(), /network result is not confirmed yet/);
  await frame.evaluate((id) => window.__evmSandbox.setHistoryStatus(id, "confirmed", "finalized"), older.operation_id);
  await frame.getByRole("button", { name: /Refresh wallet$/ }).click();
  await olderRow.locator(".evm-status").filter({ hasText: "Confirmed" }).waitFor();
  assert.equal(await rows.count(), loadedCount, "Refreshing an older operation collapsed the loaded window");

  await frame.evaluate(() => window.__evmSandbox.prependHistory(45));
  await frame.getByRole("button", { name: /Refresh wallet$/ }).click();
  await frame.waitForFunction(() => {
    const expected = window.__evmSandbox.historySnapshot();
    const visible = [...document.querySelectorAll("[data-testid^=evm-operation-]")].map((element) => element.dataset.testid.slice("evm-operation-".length));
    return visible.every((id, index) => id === expected[index].operation_id);
  });
  assert((await rows.count()) >= loadedCount, "New requests collapsed the loaded window");

  // Capture a Load more reply, then publish another window's update before that
  // reply completes. The common loader must refresh again before settling.
  const beforeConcurrent = await rows.count();
  await frame.evaluate(() => window.__evmSandbox.hold("evm_wallet_history_v1"));
  const beforeAttempts = (await frame.evaluate(() => window.__evmSandbox.historyAttempts)).length;
  await frame.getByRole("button", { name: "Load more", exact: true }).click();
  await frame.waitForFunction((count) => window.__evmSandbox.historyAttempts.length > count, beforeAttempts);
  await frame.evaluate(async () => {
    window.__evmSandbox.prependHistory(3);
    await window.__evmSandbox.publishAppStateChange("evm_wallet", Date.now());
    window.__evmSandbox.release("evm_wallet_history_v1");
  });
  await frame.waitForFunction((count) => {
    const expected = window.__evmSandbox.historySnapshot();
    const visible = [...document.querySelectorAll("[data-testid^=evm-operation-]")].map((element) => element.dataset.testid.slice("evm-operation-".length));
    return visible.length > count && visible.every((id, index) => id === expected[index].operation_id);
  }, beforeConcurrent);
  while (await frame.getByRole("button", { name: "Load more", exact: true }).count()) {
    const previousCount = await rows.count();
    await frame.getByRole("button", { name: "Load more", exact: true }).click();
    await frame.waitForFunction((count) => document.querySelectorAll("[data-testid^=evm-operation-]").length > count, previousCount);
  }
  const expectedIds = (await frame.evaluate(() => window.__evmSandbox.historySnapshot())).map((row) => row.operation_id);
  const actualIds = await rows.evaluateAll((elements) => elements.map((element) => element.dataset.testid.slice("evm-operation-".length)));
  assert.equal(actualIds.length, 143);
  assert.deepEqual(actualIds, expectedIds, "Refresh and Load more lost, duplicated, or reordered operations");
  assert.equal(new Set(actualIds).size, 143);
  assert.equal(await frame.locator(".evm-error").count(), 0);
  assert.equal((await calls(frame, methods.execute)).length, 0);
  const geometry = await frame.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert(geometry.scrollWidth <= geometry.width);
  await frame.evaluate(() => scrollTo(0, 0));
  const screenshot = `${label}.png`; await page.screenshot({ path: join(output, screenshot), fullPage: true }); screenshots.push(screenshot);
  checks.push({ label, firstCount, loadedCount, oldPendingStatusUpdated: true, insertedRequests: 48, contiguousRefreshAndLoadMore: true,
    concurrentRefreshAndLoadMore: true, finalRows: actualIds.length, noDuplicates: true, executedEffects: 0, geometry });
  await page.close(); activePage = null;
}
async function runApprovalsCase(width) {
  const label = `${width}-approval-revocation`;
  activeLabel = label;
  const page = await browser.newPage({ viewport: { width, height: 900 } }); activePage = page;
  page.on("pageerror", (error) => browserErrors.push({ label, error: String(error) }));
  await page.goto(`http://127.0.0.1:${server.address().port}/?approvals=1`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/app?approvals="));
  assert(frame);
  await frame.getByTestId("evm-account-address").filter({ hasText: "0x2222222222222222222222222222222222222222" }).waitFor();
  await frame.locator("nav").getByRole("button", { name: "Settings", exact: true }).click();
  await frame.getByRole("button", { name: "Manage token approvals", exact: true }).click();
  await frame.getByRole("heading", { name: "Known token approvals", exact: true }).waitFor();
  const token = "0x9999999999999999999999999999999999999999";
  const reviewRevocation = frame.getByRole("button", { name: "Review revocation", exact: true });
  await reviewRevocation.waitFor();
  for (const result of [{ error: "Contract has no allowance function" }, "0x", "0x01", `0x${"0".repeat(128)}`]) {
    await frame.evaluate(({ token, result }) => window.__evmRpcFixture.setAllowanceResult(token, result), { token, result });
    await reviewRevocation.click();
    await frame.locator(".evm-error").waitFor();
    assert.match(await frame.locator(".evm-error").textContent(), /allowance|Contract has no allowance function/);
    assert.equal((await calls(frame, methods.prepare)).length, 0, "An unsupported allowance opened a transaction request");
    assert.equal(await frame.getByRole("dialog").count(), 0);
    assert.equal(await frame.evaluate(() => window.__evmSandbox.toolCalls.filter((call) => call.name === "evm_send_transaction_v1").length), 0);
  }
  const allowance = `0x${123n.toString(16).padStart(64, "0")}`;
  await frame.evaluate(({ token, allowance }) => window.__evmRpcFixture.setAllowanceResult(token, allowance), { token, allowance });
  await reviewRevocation.click();
  const dialog = frame.getByRole("dialog");
  await dialog.getByTestId("evm-review-approve").waitFor();
  assert.equal(await frame.locator(".evm-error").count(), 0);
  const prepared = await calls(frame, methods.prepare);
  assert.equal(prepared.length, 1, "A valid allowance must create exactly one review request");
  const transaction = prepared[0].args[0].request.intent.operation.transaction;
  const expectedData = `0x095ea7b3${"0".repeat(24)}${"44".repeat(20)}${"0".repeat(64)}`;
  assert.equal(transaction.to.toLowerCase(), token);
  assert.equal(transaction.data.toLowerCase(), expectedData);
  assert.equal(transaction.value, "0");
  assert.equal((await calls(frame, methods.execute)).length, 0, "Opening a revocation review signed without owner approval");
  assert.match(await frame.locator(".evm-operation").textContent(), /Observed allowance: 123 atomic units/);
  const geometry = await frame.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert(geometry.scrollWidth <= geometry.width);
  const screenshot = `${label}.png`; await page.screenshot({ path: join(output, screenshot), fullPage: true }); screenshots.push(screenshot);
  checks.push({ label, unknownContractAllowanceChecked: true, rejectedReplies: 4, unsupportedRepliesNeverPrepare: true,
    validReplyOpensExactZeroApproval: true, explicitReviewCount: 1, executedEffects: 0, geometry });
  await page.close(); activePage = null;
}
async function runUsdCase(width, available) {
  const label = `${width}-usd-${available ? "available" : "unavailable"}`;
  activeLabel = label;
  const page = await browser.newPage({ viewport: { width, height: 900 } }); activePage = page;
  page.on("pageerror", (error) => browserErrors.push({ label, error: String(error) }));
  await page.goto(`http://127.0.0.1:${server.address().port}/?usd=${available ? "available" : "unavailable"}`);
  const frame = page.frames().find((candidate) => candidate.url().includes("/app?usd="));
  assert(frame, `${label}: sandbox frame missing`);
  await frame.getByTestId("evm-account-address").filter({ hasText: "0x2222222222222222222222222222222222222222" }).waitFor();
  await frame.getByRole("button", { name: "Assets", exact: true }).click();
  await frame.waitForFunction(() => window.__evmSandbox.toolCalls.some((call) => call.name === "evm_wallet_prices_v1"));
  await tick(frame);
  assert.equal((await frame.getByTestId("evm-native-usd").textContent()).trim(), available ? "≈ $3,703.70" : "—");
  if (available) {
    assert.match(await frame.getByTestId("evm-native-usd").getAttribute("title"), /defillama/i);
    assert.match(await frame.getByTestId("evm-tracked-usd").textContent(), /Priced token total/);
    const usdc = frame.locator(".evm-asset").filter({ hasText: "USDC" }).first();
    assert.equal((await usdc.locator(".evm-usd").textContent()).trim(), "≈ $99.70");
    const image = `${label}-assets.png`; await page.screenshot({ path: join(output, image), fullPage: true }); screenshots.push(image);
    // A network switch must clear the prior account valuation before its
    // replacement balance arrives, even when the price cache is warm.
    await frame.evaluate(() => window.__evmSandbox.hold("balances_read"));
    await frame.getByTestId("evm-network-select").selectOption("42161");
    assert.equal((await frame.getByTestId("evm-native-usd").textContent()).trim(), "—");
    assert.match(await frame.locator(".evm-account-balance").textContent(), /—/);
    await frame.getByTestId("evm-network-select").selectOption("1");
    await frame.evaluate(() => window.__evmSandbox.release("balances_read"));
  }
  await frame.getByRole("button", { name: "Send", exact: true }).last().click();
  await frame.getByTestId("evm-send-amount").fill("0.001");
  assert.equal((await frame.getByTestId("evm-send-usd").textContent()).trim(), available ? "≈ $3.00" : "—");
  await frame.getByTestId("evm-send-asset").selectOption("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
  await frame.getByTestId("evm-send-amount").fill("3");
  await frame.getByTestId("evm-send-to").fill("0x4444444444444444444444444444444444444444");
  assert.equal((await frame.getByTestId("evm-send-usd").textContent()).trim(), available ? "≈ $2.99" : "—");
  await frame.getByTestId("evm-send-review").click();
  await frame.getByRole("dialog").waitFor();
  assert.equal((await frame.getByTestId("evm-review-usd").textContent()).trim(), available ? "≈ $2.99" : "—");
  assert.equal((await frame.getByTestId("evm-review-fee-usd").textContent()).trim(), available ? "≈ $3.90" : "—");
  assert.equal((await calls(frame, methods.prepare)).length, 1, `${label}: USD availability must not block preparation`);
  assert.equal((await calls(frame, methods.execute)).length, 0, `${label}: price display must not execute`);
  const geometry = await frame.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert(geometry.scrollWidth <= geometry.width, `${label}: USD display horizontal overflow`);
  const image = `${label}-review.png`; await page.screenshot({ path: join(output, image), fullPage: true }); screenshots.push(image);
  checks.push({ label, nativeAndTokenUsd: available, inputAndReviewUsd: available, feeUsd: available, missingPriceDoesNotBlock: !available, networkChangeClearsValuation: available, executedEffects: 0, geometry });
  await page.close(); activePage = null;
}
const decoderPack = {
  format: 1, id: "qualification-vault", version: "1", name: "Qualification Vault", description: "Deposit into the selected fixture vault.",
  source: "https://example.invalid/never-fetch-this-source-label",
  deployments: [{ chainId: "1", address: "0x6666666666666666666666666666666666666666" }],
  functions: [{ signature: "function deposit(address asset,uint256 amount,address receiver)", title: "Deposit into Qualification Vault", value: "zero",
    fields: [{ path: "args.1", label: "Deposit amount", format: "tokenAmount", tokenPath: "args.0", role: "amount" }, { path: "args.2", label: "Position beneficiary", format: "address", role: "party" }] }],
};
async function runDecoderCase(width) {
  const label = `${width}-extensible-decoders-readable-activity`;
  activeLabel = label;
  const page = await browser.newPage({ viewport: { width, height: 1000 } }); activePage = page;
  page.on("pageerror", (error) => browserErrors.push({ label, error: String(error) }));
  await page.goto(`http://127.0.0.1:${server.address().port}/?decoders=1`);
  let frame = page.frames().find((candidate) => candidate.url().includes("/app?decoders="));
  assert(frame, `${label}: sandbox frame missing`);
  const ready = async () => frame.getByTestId("evm-account-address").filter({ hasText: "0x2222222222222222222222222222222222222222" }).waitFor();
  const nav = async (name) => frame.locator("nav").getByRole("button", { name, exact: true }).click();
  const row = (id) => frame.getByTestId(`evm-operation-${id}`);
  const saved = async () => frame.evaluate(() => window.__evmSandbox.decoderSnapshot());
  const geometry = async (context) => {
    const size = await frame.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert(size.scrollWidth <= size.width, `${label}: horizontal overflow in ${context}`);
    return size;
  };
  const capture = async (name) => {
    const image = `${label}-${name}.png`;
    await page.screenshot({ path: join(output, image), fullPage: true }); screenshots.push(image);
  };
  await ready(); await nav("Activity");
  await row(201).getByText("Contract interaction", { exact: true }).waitFor();
  const originalHistory = await frame.evaluate(() => window.__evmSandbox.operationSnapshot());
  const rawHistory = (history) => history.map(({ operation_id, request_id, intent, prepared_transaction }) => ({ operation_id, request_id, intent, prepared_transaction }));
  await row(204).getByText("7.65432109 NEW", { exact: true }).waitFor();
  assert.match(await row(205).textContent(), /123456789 atomic units/);
  assert.match(await row(202).textContent(), /Entire outstanding USDC debt/);
  assert.equal(await row(203).getByTestId("evm-activity-amount").locator("strong").textContent(), "123456789012345678901234567890123456789012345678901.234567 USDC");
  assert.equal(await row(203).getByTestId("evm-activity-amount").locator(".evm-address").count(), 0, "A long amount was incorrectly shortened like an address");
  assert.match(await row(207).textContent(), /Swap tokens/);
  assert.match(await row(207).textContent(), /Minimum received0\.995 USDC/);
  assert.match(await row(207).textContent(), /Waiting for the network to confirm|network result is not confirmed yet/);
  assert.match(await row(208).textContent(), /Swap through Curve/);
  assert.match(await row(208).textContent(), /Minimum received0\.995 USDC/);
  assert.match(await row(208).textContent(), /revert|fail|did not complete/i);
  await row(208).getByText("Details", { exact: true }).click();
  assert.match(await row(208).textContent(), /0x5555555555555555555555555555555555555555/);
  assert.match(await row(208).locator(".evm-activity-calldata").textContent(), /^0x/);
  await geometry("built-in activity");
  await frame.evaluate(() => scrollTo(0, 0)); await capture("activity-before-import");

  await nav("Settings");
  await frame.getByRole("button", { name: "Import decoder pack", exact: true }).click();
  await frame.getByRole("textbox", { name: "Or paste its JSON", exact: true }).fill(JSON.stringify({ ...decoderPack, functions: [{ ...decoderPack.functions[0], fields: [{ path: "args.__proto__", label: "Fake", format: "integer" }] }] }));
  await frame.getByRole("button", { name: "Preview pack", exact: true }).click();
  await frame.getByRole("alert").filter({ hasText: "Invalid decoder pack" }).waitFor();
  assert.deepEqual(await saved(), [], "Malformed pack persisted");
  assert.equal((await calls(frame, "evm_wallet_decoder_set_v1")).length, 0, "Malformed preview called backend set");
  const raw = JSON.stringify(decoderPack, null, 2);
  await frame.getByRole("textbox", { name: "Or paste its JSON", exact: true }).fill(raw);
  await frame.getByRole("button", { name: "Preview pack", exact: true }).click();
  const preview = frame.locator(".evm-decoder-preview");
  await preview.getByRole("heading", { name: decoderPack.name, exact: true }).waitFor();
  assert.equal(await preview.getByRole("heading", { name: decoderPack.name, exact: true }).evaluate((element) => document.activeElement === element), true, "Preview did not focus its heading");
  assert.equal((await calls(frame, "evm_wallet_decoder_set_v1")).length, 0, "Preview persisted before owner installed");
  assert.match(await preview.textContent(), /Chain 1/);
  assert.match(await preview.textContent(), /0x6666666666666666666666666666666666666666/);
  assert.equal(await preview.locator("a").count(), 0, "Unverified source became a fetched or active resource");
  await geometry("pack preview"); await capture("settings-preview");
  await frame.getByRole("button", { name: "Install decoder pack", exact: true }).click();
  await frame.getByRole("checkbox", { name: `Enable ${decoderPack.name}`, exact: true }).waitFor();
  await frame.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent.trim() === "Import decoder pack" && !button.disabled));
  assert.equal((await saved()).length, 1);
  assert.equal((await saved())[0].document_json, raw);
  const digest = createHash("sha256").update(raw).digest("hex");
  assert.equal((await saved())[0].sha256, digest);
  await frame.locator(".evm-decoder-record").getByText("Pack details", { exact: true }).click();
  await frame.locator(".evm-decoder-record").getByText(digest, { exact: true }).waitFor({ state: "visible" });
  assert.match(await frame.locator(".evm-decoder-record").textContent(), new RegExp(digest));
  await geometry("installed pack"); await capture("settings-installed");
  await frame.getByRole("button", { name: "Import decoder pack", exact: true }).click();
  await frame.getByRole("textbox", { name: "Or paste its JSON", exact: true }).fill(JSON.stringify({ ...decoderPack, description: "Changed bytes at the same version" }));
  await frame.getByRole("button", { name: "Preview pack", exact: true }).click();
  await frame.locator(".evm-decoder-preview").getByText(/already saved with different JSON content/).waitFor();
  assert.equal((await calls(frame, "evm_wallet_decoder_set_v1")).length, 1, "Changed same-version preview attempted persistence");
  await frame.getByRole("button", { name: "Cancel import", exact: true }).click();

  await nav("Activity");
  await row(201).getByText("Deposit into Qualification Vault", { exact: true }).waitFor();
  await row(201).getByText("1.23456789 NEW", { exact: true }).waitFor();
  assert.match(await row(201).getByTestId("evm-decoder-caption").textContent(), /Qualification Vault · v1/);
  await row(201).getByText("Details", { exact: true }).click();
  assert.match(await row(201).textContent(), new RegExp(digest));
  assert.equal(await row(201).locator(".evm-activity-calldata").textContent(), originalHistory.find((operation) => operation.operation_id === "201").prepared_transaction.data);
  await geometry("decoded existing activity"); await frame.evaluate(() => scrollTo(0, 0)); await capture("activity-imported");
  await row(209).getByRole("button", { name: "Continue", exact: true }).click();
  const review = frame.getByRole("dialog");
  await review.getByRole("heading", { name: "Deposit into Qualification Vault", exact: true }).waitFor();
  await review.getByText("2.22222222 NEW", { exact: true }).waitFor();
  assert.equal((await calls(frame, methods.execute)).length, 0);
  await geometry("imported transaction review"); await capture("review-imported");
  // Reload reconstructs the UI and decoder cache from the durable backend
  // fixture's exact records; no localStorage or saved React state is available.
  const persisted = await saved();
  await page.addInitScript((packs) => { window.__evmDecoderInitialPacks = packs; }, persisted);
  await page.reload();
  frame = page.frames().find((candidate) => candidate.url().includes("/app?decoders="));
  await ready(); await nav("Activity");
  await row(201).getByText("1.23456789 NEW", { exact: true }).waitFor();
  assert.deepEqual(await saved(), persisted, "Reload changed saved decoder definitions");

  // A different Wallet tile changes the same durable pack. The already-open
  // Activity and Settings must both discard their cached decoder inventory.
  await frame.evaluate((id) => window.__evmSandbox.setDecoderEnabled(id, false), decoderPack.id);
  await row(201).getByText("Contract interaction", { exact: true }).waitFor();
  await nav("Settings");
  assert.equal(await frame.getByRole("checkbox", { name: `Enable ${decoderPack.name}`, exact: true }).isChecked(), false);
  await frame.evaluate((id) => window.__evmSandbox.setDecoderEnabled(id, true), decoderPack.id);
  await frame.waitForFunction(() => document.querySelector('.evm-decoder-record input[type="checkbox"]')?.checked === true);

  await nav("Settings");
  await frame.getByRole("checkbox", { name: `Enable ${decoderPack.name}`, exact: true }).uncheck();
  await frame.waitForFunction(() => window.__evmSandbox.decoderSnapshot().every((pack) => !pack.enabled));
  await nav("Activity");
  await row(201).getByText("Contract interaction", { exact: true }).waitFor();
  assert.deepEqual(rawHistory(await frame.evaluate(() => window.__evmSandbox.operationSnapshot())), rawHistory(originalHistory), "Toggling a decoder mutated raw operation history");
  await nav("Settings");
  await frame.getByRole("checkbox", { name: `Enable ${decoderPack.name}`, exact: true }).check();
  await frame.waitForFunction(() => window.__evmSandbox.decoderSnapshot().every((pack) => pack.enabled));
  // A second independent definition must never silently win by import order.
  const second = { ...decoderPack, id: "qualification-vault-alternative", name: "Alternative Vault Explanation", functions: [{ ...decoderPack.functions[0], title: "Conflicting deposit title" }] };
  await frame.getByRole("button", { name: "Import decoder pack", exact: true }).click();
  await frame.getByLabel("Choose a JSON decoder pack", { exact: true }).setInputFiles({ name: "alternative-decoder.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(second)) });
  await frame.locator(".evm-decoder-preview").getByRole("heading", { name: second.name, exact: true }).waitFor();
  assert.equal((await saved()).length, 1, "Selecting a JSON file installed without preview approval");
  await frame.getByRole("button", { name: "Install decoder pack", exact: true }).click();
  await frame.getByRole("checkbox", { name: `Enable ${second.name}`, exact: true }).waitFor();
  await nav("Activity");
  await row(201).getByTestId("evm-decoder-warning").filter({ hasText: "Multiple enabled decoder packs" }).waitFor();
  await row(201).getByText("Contract interaction", { exact: true }).waitFor();
  assert.match(await row(201).getByTestId("evm-decoder-warning").textContent(), /Qualification Vault, Alternative Vault Explanation/);
  await capture("activity-conflict");

  await nav("Settings");
  await frame.getByRole("button", { name: `Remove ${second.name}`, exact: true }).click();
  await frame.getByRole("checkbox", { name: `Enable ${second.name}`, exact: true }).waitFor({ state: "hidden" });
  const approval = { ...decoderPack, id: "qualification-approval", name: "Misleading Approval Labels", deployments: [{ chainId: "1", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" }],
    functions: [{ signature: "function approve(address spender,uint256 amount)", title: "Receive free money", value: "zero", fields: [{ path: "args.1", label: "Claim amount", format: "tokenAmount", tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", role: "amount" }] }] };
  await frame.getByRole("button", { name: "Import decoder pack", exact: true }).click();
  await frame.getByRole("textbox", { name: "Or paste its JSON", exact: true }).fill(JSON.stringify(approval));
  await frame.getByRole("button", { name: "Preview pack", exact: true }).click();
  await frame.getByRole("button", { name: "Install decoder pack", exact: true }).click();
  await frame.getByRole("checkbox", { name: `Enable ${approval.name}`, exact: true }).waitFor();
  await nav("Activity");
  await row(206).getByText("Approve USDC", { exact: true }).waitFor();
  assert.equal(await row(206).getByText("Receive free money", { exact: true }).count(), 0, "Imported labels overrode core ERC20 approval meaning");
  assert.match(await row(206).textContent(), /123 USDC/);
  await nav("Settings");
  await frame.getByRole("button", { name: `Remove ${decoderPack.name}`, exact: true }).click();
  await frame.getByRole("checkbox", { name: `Enable ${decoderPack.name}`, exact: true }).waitFor({ state: "hidden" });
  await nav("Activity");
  await row(201).getByText("Contract interaction", { exact: true }).waitFor();
  assert.deepEqual(rawHistory(await frame.evaluate(() => window.__evmSandbox.operationSnapshot())), rawHistory(originalHistory), "Removing a decoder mutated raw operation history");
  const rpcCalls = await frame.evaluate(() => window.__evmRpcFixture.calls);
  const metadata = rpcCalls.filter((call) => call.method === "eth_call" && ["0x313ce567", "0x95d89b41"].includes(call.params[0].data));
  assert(metadata.some((call) => call.params[0].to.toLowerCase() === "0x7777777777777777777777777777777777777777" && call.params[0].data === "0x313ce567"));
  assert(metadata.some((call) => call.params[0].to.toLowerCase() === "0x8888888888888888888888888888888888888888" && call.params[0].data === "0x95d89b41"));
  await frame.evaluate(() => window.__evmRpcFixture.setTokenMetadata("0x8888888888888888888888888888888888888888", 8, "RECOVERED"));
  await frame.getByRole("button", { name: /Refresh wallet$/ }).click();
  await row(205).getByText("1.23456789 RECOVERED", { exact: true }).waitFor();
  assert.equal((await calls(frame, methods.execute)).length, 0);
  assert.equal((await calls(frame, methods.prepare)).length, 0);
  assert.equal((await calls(frame, methods.token)).length, 0, "Presentation metadata was persisted as an owned token");
  checks.push({ label, actualBackendSchemas: true, malformedPackNoPersistence: true, ownerPreviewBeforeInstall: true, importedNewProtocolWithoutWalletCode: true,
    readableHistoricalTransactions: 9, importedReviewMatchesActivity: true, exactFullRepaymentAndLongAmounts: true, importedProvenanceAndSha256: true,
    rpcMetadataDecimalsAndSymbol: true, unavailableMetadataRetainsAtomicUnits: true, reloadRestoresPack: true, sameVersionChangeRequiresHigherVersion: true, toggleAndRemovalRetainRawHistory: true,
    conflictingPacksFallBack: true, importedApprovalCannotOverrideCore: true, pendingAndRevertedKeepMinimumSemantics: true, executedEffects: 0, geometry: await geometry("final history") });
  await page.close(); activePage = null;
}
let failure = null;
try {
  if (!historyOnly && !pricesOnly && !decodersOnly && !approvalsOnly) for (const width of [1440, 375]) for (const form of ["send", "sign", "replacement", "token"]) for (const action of ["click", "enter"]) await runCase(width, form, action);
  if (!historyOnly && !pricesOnly && !decodersOnly && !approvalsOnly) for (const width of [1440, 375]) await runDelayedTokenSend(width);
  if (!pricesOnly && !decodersOnly && !approvalsOnly) for (const width of [1440, 375]) for (const rowCount of [25, 50]) await runHistoryCase(width, rowCount);
  if (!pricesOnly && !decodersOnly && !approvalsOnly) for (const width of [1440, 375]) await runHistoryRefreshCase(width);
  if (!historyOnly && !decodersOnly && !approvalsOnly) for (const width of [700, 375]) await runUsdCase(width, true);
  if (!historyOnly && !decodersOnly && !approvalsOnly) await runUsdCase(375, false);
  if (!historyOnly && !pricesOnly && !approvalsOnly) for (const width of [1440, 360]) await runDecoderCase(width);
  if (!historyOnly && !pricesOnly && !decodersOnly) for (const width of [1440, 375]) await runApprovalsCase(width);
  assert.deepEqual(browserErrors, [], "Browser runtime errors");
  assert.equal(consoleMessages.filter((message) => /blocked form submission|allow-forms/i.test(message.text)).length, 0, "Native form submission attempted inside sandbox");
} catch (error) {
  failure = { label: activeLabel, message: error.message, stack: error.stack };
  if (activePage) await activePage.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => undefined);
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise((done) => server.close(done));
}
const report = {
  passed: failure === null, scope: "Actual React/provider/browser RPC/SDK in allow-scripts-only opaque-origin iframe; actual descriptor validation and browser JSON-RPC encoding; mocked HTTP responses, Kernel bridge, durable backend replies and signed bytes; actual Kernel metadata encoder for captured history pagination; no network, real canister, real signing or on-chain proof",
  sourceDirectory: historicalSource ?? source, sourceHashes, checks, screenshots, browserErrors, consoleMessages, failure,
};
await writeFile(join(output, "results.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: report.passed, checks: checks.length, output, failure }, null, 2));
if (failure) process.exitCode = 1;
