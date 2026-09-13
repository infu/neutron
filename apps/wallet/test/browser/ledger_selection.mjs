/** Real Wallet resident/tile registration and SDK transport in Chromium.
 * Only Kernel routing, its approval surface, and backend replies are fixtures.
 * Every network request is intercepted; no ledger or production call occurs. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const out = process.env.WALLET_LEDGER_BROWSER_ARTIFACTS || "/tmp/neutron-wallet-ledger-browser";
const owner = "3rurp-vyaaa-aaaay-aacua-cai";
const ledger = "togwv-zqaaa-aaaal-qr7aa-cai";
const original = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const kernelOrigin = `https://${owner}.icp0.io`;
const appOrigin = `https://awalleta--${owner}.icp0.io`;
const manifest = JSON.parse(await readFile(`${root}/apps/wallet/neutron.json`, "utf8"));
assert.equal(manifest.capabilities.preapproved_self_calls.methods.length, 32);
assert(!manifest.capabilities.preapproved_self_calls.methods.includes("wallet_add_ledger_v1"));
await mkdir(out, { recursive: true });
await build({
  absWorkingDir: root, entryPoints: { resident: "ledger-resident", wallet: "ledger-wallet" },
  outdir: out, bundle: true, platform: "browser", format: "esm", jsx: "automatic", logLevel: "warning",
  plugins: [{ name: "ledger-browser-entry", setup(builder) {
    builder.onResolve({ filter: /^ledger-(resident|wallet)$/ }, ({ path }) => ({ path, namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
      contents: `import '${root}/apps/wallet/src/${path === "ledger-resident" ? "service.ts" : "index.tsx"}'; parent.postMessage({fixtureReady:'${path.slice(7)}'}, '*');`,
      loader: "ts", resolveDir: root,
    }));
    // UI styling is unrelated to the real tile's tool registration under test.
    builder.onLoad({ filter: /\.scss$/ }, () => ({ contents: "", loader: "css" }));
  } }],
});
const bundles = new Map(await Promise.all(["resident", "wallet"].map(async (name) =>
  [`/${name}.js`, await readFile(`${out}/${name}.js`)])));

function kernelFixture({ owner, ledger, original, appOrigin }) {
  const state = window.__ledger = {
    messages: [], selected: [original], reservations: [], mutations: 0, reviews: [],
    presentations: [], judges: [], cancellations: [], errors: [], ready: {}, holdJudge: false,
  };
  const ports = {}, pending = new Map(), requests = new Map(), reviews = new Map(), presentations = new Map();
  let next = 10000;
  const snapshot = () => ({ owner, configured: true, ledgers: state.selected.map((principal, id) => ({ id: String(id), principal })) });
  const reply = (frame, message, ok, error) => ports[frame].postMessage({
    type: message.type === "neutron:self-call:exec" ? "neutron:self-call:response" : "response",
    ...(message.type === "neutron:self-call:exec" ? { version: 1, blobs: [] } : {}),
    id: message.id, ...(error ? { error: { name: "KernelPolicyError", code: "REQUEST_CANCELLED", message: error } } : { ok }),
  });
  function call(frame, name, args, options = {}) {
    const id = ++next;
    const promise = new Promise((resolve) => pending.set(`${frame}:${id}`, resolve));
    const payload = { name, arguments: args, caller: { appId: "agent", endpoint: "app:agent:tile:root", role: "tile", installationUid: "47" } };
    if (options.audience) payload.audience = options.audience;
    if (options.provider) { payload.providerApproval = { capability: "a".repeat(64) }; payload.providerUi = true; }
    const invocation = options.root ? { id: `ledger-invocation-${id}`, rootId: `ledger-root-id-${id}`, capability: "c".repeat(64) } : undefined;
    ports[frame].postMessage({ type: "exec", id, payload: {
      action: "__neutron_msgbus_tools_call", payload,
      ...(invocation ? { context: { invocation } } : {}),
    } });
    return { id, promise, invocation };
  }
  function applySelection(frame, message) {
    if (message.method !== "wallet_add_ledger_v1" || message.args.length !== 1 || message.args[0] !== ledger) throw Error("Unexpected selection mutation");
    state.mutations++;
    if (!state.selected.includes(ledger)) state.selected.push(ledger);
    for (const action of message.actions) {
      if (action.kind !== "reserve" || action.scope.kind !== "principal" || action.scope.principal !== ledger) throw Error("Non-additive or unrelated reservation");
      state.reservations.push({ scopeKind: "principal", principal: action.scope.principal });
    }
    reply(frame, message, { callResult: snapshot() });
  }
  function review(frame, message) {
    state.reviews.push({ frame, message });
    const dialog = document.createElement("dialog"); dialog.open = true;
    const title = document.createElement("h2"); title.textContent = "Kernel fixture: approve Wallet ledger access";
    const exact = document.createElement("pre"); exact.textContent = JSON.stringify({ ledger: message.args[0], actions: message.actions }, null, 2);
    const approve = document.createElement("button"); approve.textContent = "Approve ledger";
    const cancel = document.createElement("button"); cancel.textContent = "Cancel";
    const close = () => { reviews.delete(`${frame}:${message.id}`); dialog.remove(); };
    approve.onclick = () => { close(); applySelection(frame, message); };
    cancel.onclick = () => { close(); reply(frame, message, null, "Owner declined ledger access before dispatch"); };
    dialog.append(title, exact, approve, cancel); document.body.append(dialog);
    reviews.set(`${frame}:${message.id}`, () => { close(); reply(frame, message, null, "Ledger access cancelled before dispatch"); });
  }
  async function receive(frame, message) {
    state.messages.push({ frame, message });
    if (message.type === "response") {
      const resolve = pending.get(`${frame}:${message.id}`);
      if (resolve) { pending.delete(`${frame}:${message.id}`); resolve(message); }
      return;
    }
    if (message.type === "neutron:msgbus:cancel") {
      state.cancellations.push({ frame, id: message.id });
      const key = `${frame}:${message.id}`;
      if (reviews.has(key)) reviews.get(key)();
      else if (presentations.has(key)) ports.wallet.postMessage({ type: "neutron:msgbus:cancel", version: 1, id: presentations.get(key) });
      else if (requests.has(key)) reply(frame, requests.get(key), null, "Review cancelled before approval");
      return;
    }
    requests.set(`${frame}:${message.id}`, message);
    if (message.type === "neutron:self-call:exec") {
      if (message.tool === "backend_calls.request") {
        if (message.context?.invocation) applySelection(frame, message); else review(frame, message);
      } else if (message.method === "wallet_read_v1" && "snapshot" in message.args[0]) reply(frame, message, { snapshot: snapshot() });
      else if (message.method === "wallet_read_v1" && "catalog" in message.args[0]) reply(frame, message, { catalog: [] });
      else if (message.method === "wallet_token_info_v1") {
        if (JSON.stringify(message.args) !== JSON.stringify([{ ledger }])) throw Error("Wrong metadata ledger");
        reply(frame, message, {
          ledger, account: { owner }, token_name: "Test token", token_symbol: "TEST", decimals: "6",
          fee_atoms: "0", balance_atoms: "9007199254740993000000", observed_at_ns: "1788900000000000000",
        });
      } else throw Error(`Unexpected backend method ${message.method}`);
      return;
    }
    if (message.type !== "exec") return;
    const { action, payload } = message.payload;
    if (action === "tools.call" && payload.name === "backend_calls.list") reply(frame, message, { reservations: state.reservations });
    else if (action === "provider_ui.present") {
      state.presentations.push(payload);
      if (payload.tileId !== "wallet" || payload.tool !== "wallet_add_ledger_present_v1" || payload.arguments.ledger !== ledger) throw Error("Unexpected foreground route");
      document.getElementById("wallet").hidden = false;
      const presented = call("wallet", payload.tool, payload.arguments, { audience: "foreground_tile" });
      presentations.set(`${frame}:${message.id}`, presented.id);
      const result = await presented.promise;
      presentations.delete(`${frame}:${message.id}`);
      reply(frame, message, result.ok, result.error?.message);
    } else if (action === "provider_approval.request") {
      state.judges.push({ context: message.payload.context, ...payload });
      if (!message.payload.context?.invocation) throw Error("Root judge lost invocation");
      if (!state.holdJudge) reply(frame, message, { approved: true });
    } else if (action === "app.state.publish" || action === "tray.set_state") reply(frame, message, {});
    else throw Error(`Unexpected Kernel route ${action} ${payload?.name || ""}`);
  }
  addEventListener("message", (event) => {
    const frame = event.data?.fixtureReady;
    if (!["resident", "wallet"].includes(frame) || event.source !== document.getElementById(frame).contentWindow) return;
    const channel = new MessageChannel(); ports[frame] = channel.port1;
    channel.port1.onmessage = ({ data }) => { receive(frame, data).catch((error) => state.errors.push(String(error))); };
    event.source.postMessage({ type: "neutron:msgbus:connect", version: 1, sessionId: "0123456789abcdef0123456789abcdef" }, appOrigin, [channel.port2]);
    state.ready[frame] = true;
  });
  window.__start = (mode) => {
    const request = call("resident", mode === "root-direct" ? "wallet_add_ledger_root_v1" : "wallet_add_ledger_v1", { ledger }, {
      root: mode.startsWith("root"), provider: mode !== "root-direct",
      ...(mode === "root-direct" ? { audience: "agent_root" } : {}),
    });
    state.activeId = request.id; state.invocation = request.invocation; state.result = null;
    request.promise.then((result) => { state.result = result; });
  };
  window.__cancel = () => ports.resident.postMessage({ type: "neutron:msgbus:cancel", version: 1, id: state.activeId });
  window.__list = (frame) => {
    const id = ++next;
    const promise = new Promise((resolve) => pending.set(`${frame}:${id}`, resolve));
    ports[frame].postMessage({ type: "exec", id, payload: { action: "__neutron_msgbus_tools_list", payload: {} } });
    return promise;
  };
}

const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROMIUM_PATH || "/run/current-system/sw/bin/google-chrome-stable", args: ["--no-sandbox"] });
const checks = [], errors = [];
async function open() {
  const page = await browser.newPage(); page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === kernelOrigin) {
      await route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body><script>(${kernelFixture.toString()})(${JSON.stringify({ owner, ledger, original, appOrigin })})</script><iframe id="resident" hidden src="${appOrigin}/app/wallet/resident.html"></iframe><iframe id="wallet" hidden src="${appOrigin}/app/wallet/wallet.html?app=wallet&tile=wallet"></iframe></body></html>` });
    } else if (url.origin === appOrigin && bundles.has(url.pathname)) {
      await route.fulfill({ contentType: "text/javascript", body: bundles.get(url.pathname) });
    } else if (url.origin === appOrigin && /^\/app\/wallet\/(resident|wallet)\.html$/.test(url.pathname)) {
      const name = url.pathname.includes("resident.html") ? "resident" : "wallet";
      await route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body><script type="module" src="/${name}.js"></script></body></html>` });
    } else { errors.push(`Unexpected network request: ${url}`); await route.abort(); }
  });
  await page.goto(kernelOrigin);
  await page.waitForFunction(() => window.__ledger.ready.resident && window.__ledger.ready.wallet);
  return page;
}
async function result(page) {
  await page.waitForFunction(() => window.__ledger.result || window.__ledger.errors.length);
  const state = await page.evaluate(() => window.__ledger);
  assert.deepEqual(state.errors, []); return state;
}
function selectedExactly(state) {
  assert.deepEqual(state.selected, [original, ledger]);
  assert.deepEqual(state.result.ok, {
    ledger, selected: true, alreadySelected: false, metadataError: null,
    tokenInfo: { ledger, account: owner, name: "Test token", symbol: "TEST", decimals: 6,
      feeAtoms: "0", balanceAtoms: "9007199254740993000000", observedAtNs: "1788900000000000000" },
  });
  const mutations = state.messages.filter(({ message }) => message.tool === "backend_calls.request");
  assert.equal(mutations.length, 1); assert.equal(mutations[0].message.actions.length, 1);
  assert.deepEqual(mutations[0].message.args, [ledger]);
}
try {
  const normal = await open();
  const descriptors = await normal.evaluate(async () => ({ resident: await window.__list("resident"), wallet: await window.__list("wallet") }));
  assert(descriptors.resident.ok.some(({ name }) => name === "wallet_add_ledger_v1"));
  assert(descriptors.resident.ok.some(({ name }) => name === "wallet_add_ledger_root_v1"));
  assert(!descriptors.resident.ok.some(({ name }) => name === "wallet_add_ledger_present_v1"));
  assert(descriptors.wallet.ok.some(({ name, annotations }) => name === "wallet_add_ledger_present_v1" && annotations["neutron:audience"] === "foreground_tile"));
  await normal.evaluate(() => window.__start("normal"));
  await normal.getByRole("button", { name: "Approve ledger", exact: true }).waitFor();
  assert.equal(await normal.locator("#wallet").isVisible(), true);
  assert((await normal.locator("dialog pre").innerText()).includes(ledger));
  assert.deepEqual(await normal.evaluate(() => window.__ledger.selected), [original]);
  await normal.getByRole("button", { name: "Approve ledger", exact: true }).click();
  const approved = await result(normal); selectedExactly(approved);
  assert.equal(approved.presentations.length, 1); assert.equal(approved.reviews.length, 1); assert.equal(approved.judges.length, 0);
  assert.equal(approved.reviews[0].frame, "wallet"); assert.equal(approved.reviews[0].message.context, undefined);
  checks.push("Actual resident tools route Normal mode to the actual foreground Wallet registration; one exclusive principal reservation review precedes selection and preserves all atomic metadata.");
  await normal.close();

  for (const mode of ["root-public", "root-direct"]) {
    const page = await open(); await page.evaluate((mode) => window.__start(mode), mode);
    const state = await result(page); selectedExactly(state);
    assert.equal(state.presentations.length, 0); assert.equal(state.reviews.length, 0);
    assert.equal(state.judges.length, mode === "root-public" ? 1 : 0);
    assert.equal(await page.locator("#wallet").isVisible(), false);
    const scopedCalls = state.messages.filter(({ message }) => message.type === "neutron:self-call:exec");
    for (const { message } of scopedCalls) assert.deepEqual(message.context, { invocation: state.invocation });
    if (mode === "root-public") assert.equal(state.judges[0].review.ledger, ledger);
    await page.evaluate((mode) => window.__start(mode), mode);
    const retry = await result(page); assert.equal(retry.result.ok.alreadySelected, true);
    assert.deepEqual(retry.selected, [original, ledger]);
    assert.deepEqual(retry.messages.filter(({ message }) => message.tool === "backend_calls.request").at(-1).message.actions, []);
    checks.push(`${mode}: real private-port invocation remains bound through reads, approval, combined selection, and metadata; no owner presentation; same-ledger retry preserves selection and requests no duplicate access.`);
    await page.close();
  }
  for (const mode of ["normal", "root-public"]) {
    const page = await open();
    await page.evaluate((mode) => { window.__ledger.holdJudge = mode === "root-public"; window.__start(mode); }, mode);
    await page.waitForFunction(() => window.__ledger.reviews.length || window.__ledger.judges.length);
    await page.evaluate(() => window.__cancel());
    const cancelled = await result(page);
    assert(cancelled.result.error); assert.equal(cancelled.mutations, 0);
    assert.deepEqual(cancelled.selected, [original]); assert.deepEqual(cancelled.reservations, []);
    if (mode === "normal") await page.waitForFunction(() => document.querySelector("dialog") === null);
    checks.push(`${mode}: cancellation before approval propagates across the real SDK route and leaves selections/access unchanged.`);
    await page.close();
  }
  assert.deepEqual(errors, []);
  checks.push("Manifest retains its existing 32 preapproved methods; ledger addition uses the reviewed combined route.");
  await writeFile(`${out}/results.json`, JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally { await browser.close(); }
