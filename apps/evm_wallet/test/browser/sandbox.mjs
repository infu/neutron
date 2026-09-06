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
const output = option("--output-dir") ?? await mkdtemp(join(tmpdir(), "neutron-evm-wallet-sandbox-"));
await mkdir(output, { recursive: true });
const mock = await readFile(join(here, "mock_app.ts"), "utf8");
const sourceHashes = {};
sourceHashes["test/browser/mock_app.ts"] = createHash("sha256").update(mock).digest("hex");
sourceHashes["test/browser/rpc_fixture.ts"] = createHash("sha256").update(await readFile(join(here, "rpc_fixture.ts"))).digest("hex");
const historyCapture = JSON.parse(await readFile(join(here, "../fixtures/history-25-operations.json"), "utf8"));
const normalizedHistory = historyCapture.normalized;
assert(normalizedHistory?.operations?.length === 25, "Captured history fixture must provide 25 normalized operations");
const kernelCodecPath = join(root, "apps/kernel/src/self_calls.ts");
sourceHashes["kernel/self_calls.ts"] = createHash("sha256").update(await readFile(kernelCodecPath)).digest("hex");
const bootstrap = `import { encodeSelfCallResult } from ${JSON.stringify(kernelCodecPath)};
import ${JSON.stringify(join(here, "rpc_fixture.ts"))};
window.__evmKernelEncodeSelfCallResult = encodeSelfCallResult;
window.__evmCapturedHistory = ${JSON.stringify(normalizedHistory)};
await import(${JSON.stringify(join(source, "main.tsx"))});`;
await build({
  absWorkingDir: root, entryPoints: ["sandbox-qualification-entry"], outfile: join(output, "main.js"),
  bundle: true, platform: "browser", format: "esm", jsx: "automatic", logLevel: "warning",
  plugins: [{ name: "sandbox-qualification", setup(builder) {
    builder.onResolve({ filter: /^sandbox-qualification-entry$/ }, () => ({ path: "entry", namespace: "bootstrap" }));
    builder.onLoad({ filter: /.*/, namespace: "bootstrap" }, () => ({ contents: bootstrap, loader: "js", resolveDir: root }));
    builder.onResolve({ filter: /^neutron-tools\/app$/ }, () => ({ path: "app", namespace: "fixture" }));
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
  await frame.locator("nav").getByRole("button", { name: form === "send" ? "Send" : form === "sign" ? "Sign" : form === "replacement" ? "Activity" : "Settings", exact: true }).click();
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
    assert.equal(await frame.evaluate(() => window.__evmSandbox.toolCalls.filter((call) => !["evm_accounts_v1", "evm_balances_v1", "evm_operation_status_v1"].includes(call.name)).length), 1, `${label}: duplicate public tool invocation`);
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
  assert((await dialog.textContent()).includes("Token amount: 1.25 USDC"));
  assert((await dialog.textContent()).includes("Loading saved token observations"));
  const approve = frame.getByTestId("evm-review-approve");
  assert.equal(await approve.isVisible(), true);
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
  assert((await frame.locator("main").textContent()).includes("submitted"));
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
  assert.deepEqual(attempts.filter((attempt) => attempt.accepted).flatMap((attempt) => attempt.operationIds), expectedIds);
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
let failure = null;
try {
  if (!historyOnly) for (const width of [1440, 375]) for (const form of ["send", "sign", "replacement", "token"]) for (const action of ["click", "enter"]) await runCase(width, form, action);
  if (!historyOnly) for (const width of [1440, 375]) await runDelayedTokenSend(width);
  for (const width of [1440, 375]) for (const rowCount of [25, 50]) await runHistoryCase(width, rowCount);
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
