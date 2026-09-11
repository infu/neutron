/** Real Activity screen and SDK transport. Only Kernel/backend replies are
 * fixtures; every request is intercepted and no financial call is allowed. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const out = process.env.WALLET_ACTIVITY_BROWSER_ARTIFACTS || "/tmp/neutron-wallet-activity-browser";
const owner = "3rurp-vyaaa-aaaay-aacua-cai", ledger = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const kernelOrigin = `https://${owner}.icp0.io`, appOrigin = `https://awalleta--${owner}.icp0.io`;
await mkdir(out, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ["activity-fixture"], outfile: `${out}/main.js`,
  bundle: true, platform: "browser", format: "esm", jsx: "automatic", logLevel: "warning",
  plugins: [{ name: "activity-entry", setup(builder) {
    builder.onResolve({ filter: /^activity-fixture$/ }, () => ({ path: "entry", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ loader: "ts", resolveDir: root,
      contents: `import '${root}/apps/wallet/src/main.tsx'; parent.postMessage({fixtureReady:true}, '*');` }));
    builder.onLoad({ filter: /\.scss$/ }, () => ({ contents: "", loader: "css" }));
  } }],
});
const bundle = await readFile(`${out}/main.js`);

function kernelFixture({ owner, ledger, appOrigin }) {
  const state = window.__activity = { calls: [], errors: [], statusUnavailable: true };
  const logo = "data:image/svg+xml;base64," + btoa("<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12'><circle cx='6' cy='6' r='6' fill='purple'/></svg>");
  const records = Array.from({ length: 65 }, (_, index) => ({ transaction: {
    ledger, symbol: "ICP", decimals: "8", value: {
      block_index: String(1000 - index), operation: { transfer: null }, timestamp_ns: "1788900000000000000",
      amount: "123456789", fee: "10000", balance_effect: "123456789", provenance: { index: null }, verification: { verified: null },
    },
  } }));
  function result(message) {
    const { method, args } = message;
    if (method === "wallet_read_v1" && "snapshot" in args[0]) return { snapshot: { owner, configured: true,
      ledgers: [{ id: "1", principal: ledger, symbol: "ICP", name: "Internet Computer", decimals: "8", balance: "123456789", fee: "10000", logo }] } };
    if (method === "wallet_read_v1" && "catalog" in args[0]) return { catalog: [] };
    if (method === "wallet_transfers_pending_v2") return [];
    if (method === "wallet_history_status") {
      if (state.statusUnavailable) throw Error("History index temporarily unavailable");
      return { running: false, ledgers: [] };
    }
    if (method === "wallet_history_page") {
      const request = args[0];
      if (request.include_logos !== false) throw Error("Activity must omit repeated artwork before transport");
      // Transport-size boundary is exercised with the real Kernel encoder in
      // history_transport.test.ts; here the private port delivers that error.
      if (Number(request.limit) > 20) throw Error("Self-call result exceeds the metadata byte limit");
      const start = request.before ? records.findIndex(row => row.transaction.value.block_index === request.before.id) + 1 : 0;
      if (request.before && start === 0) throw Error("Lost history cursor");
      const rows = records.slice(start, start + Number(request.limit));
      const hasMore = start + rows.length < records.length;
      return { records: rows, has_more: hasMore, inspected: String(rows.length),
        ...(hasMore ? { next: { timestamp_ns: "1788900000000000000", ledger, kind_order: 0, id: rows.at(-1).transaction.value.block_index } } : {}) };
    }
    throw Error(`Unexpected backend request: ${method}`);
  }
  addEventListener("message", event => {
    const frame = document.getElementById("wallet");
    if (!event.data?.fixtureReady || event.source !== frame.contentWindow) return;
    const channel = new MessageChannel();
    channel.port1.onmessage = ({ data: message }) => {
      state.calls.push(message);
      try {
        if (message.type !== "neutron:self-call:exec") throw Error(`Unexpected Kernel route: ${message.type}`);
        let ok, error;
        try { ok = result(message); }
        catch (reason) { error = { name: "Error", message: reason.message }; }
        channel.port1.postMessage({ type: "neutron:self-call:response", version: 1, id: message.id, ...(error ? { error } : { ok, blobs: [] }) });
      } catch (error) { state.errors.push(String(error)); }
    };
    event.source.postMessage({ type: "neutron:msgbus:connect", version: 1,
      sessionId: "0123456789abcdef0123456789abcdef" }, appOrigin, [channel.port2]);
  });
}

const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROMIUM_PATH || "/run/current-system/sw/bin/google-chrome-stable", args: ["--no-sandbox"] });
const errors = [], checks = [];
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", error => errors.push(String(error)));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === kernelOrigin) await route.fulfill({ contentType: "text/html", body:
      `<!doctype html><html><body><script>(${kernelFixture.toString()})(${JSON.stringify({ owner, ledger, appOrigin })})</script><iframe id="wallet" style="width:420px;height:900px" src="${appOrigin}/app/wallet/index.html?app=wallet&tile=wallet"></iframe></body></html>` });
    else if (url.origin === appOrigin && url.pathname === "/main.js") await route.fulfill({ contentType: "text/javascript", body: bundle });
    else if (url.origin === appOrigin && url.pathname === "/app/wallet/index.html") await route.fulfill({ contentType: "text/html", body:
      '<!doctype html><html><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>' });
    else { errors.push(`Unexpected network request: ${url}`); await route.abort(); }
  });
  await page.goto(kernelOrigin);
  const wallet = page.frameLocator("#wallet");
  await wallet.getByRole("button", { name: "Activity", exact: true }).click();
  await wallet.locator(".wallet-activity-entry").nth(19).waitFor();
  assert.equal(await wallet.locator(".wallet-activity-entry").count(), 20);
  assert((await wallet.getByRole("alert").innerText()).includes("Activity sync details unavailable"));
  assert(!(await wallet.locator("body").innerText()).includes("metadata byte limit"));
  const artwork = await wallet.locator(".wallet-activity-row img").evaluateAll(images => images.map(image => ({ src: image.src, complete: image.complete, width: image.naturalWidth })));
  assert.equal(artwork.length, 20); assert(artwork.every(image => image.src.startsWith("data:image/svg+xml;base64,") && image.complete && image.width === 12));
  checks.push("Activity recovers privately delivered page-size errors, reuses token artwork, and keeps loaded records visible when status fails.");

  await page.evaluate(() => window.__activity.statusUnavailable = false);
  for (const count of [40, 60, 65]) {
    await wallet.getByRole("button", { name: "Load more", exact: true }).click();
    await wallet.locator(".wallet-activity-entry").nth(count - 1).waitFor();
    assert.equal(await wallet.locator(".wallet-activity-entry").count(), count);
  }
  assert.equal(await wallet.getByRole("button", { name: "Load more", exact: true }).count(), 0);
  assert.equal(await wallet.getByRole("alert").count(), 0);
  await wallet.locator(".wallet-activity-row").last().click();
  assert((await wallet.locator(".wallet-activity-entry").last().innerText()).includes("936"));
  const state = await page.evaluate(() => window.__activity);
  assert.deepEqual(state.errors, []);
  const requests = state.calls.filter(call => call.method === "wallet_history_page").map(call => call.args[0]);
  assert.deepEqual(requests.map(request => [request.limit, request.before?.id ?? null]),
    [["40", null], ["20", null], ["40", "981"], ["20", "981"], ["40", "961"], ["20", "961"], ["40", "941"], ["20", "941"]]);
  assert(state.calls.every(call => ["wallet_read_v1", "wallet_transfers_pending_v2", "wallet_history_page", "wallet_history_status"].includes(call.method)));
  checks.push("Load more reaches all 65 records through exact cursors, exposes the oldest block, clears recovered status errors, and makes only read calls.");
  assert.deepEqual(errors, []);
  await writeFile(`${out}/results.json`, JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  const pages = await Promise.all(browser.contexts().flatMap(context => context.pages()).map(async page => ({
    state: await page.evaluate(() => window.__activity),
    frames: await Promise.all(page.frames().map(async frame => ({ url: frame.url(), body: await frame.locator("body").innerText() }))),
  })));
  await writeFile(`${out}/failure.json`, JSON.stringify({ error: String(error), errors, pages }, null, 2));
  throw error;
} finally { await browser.close(); }
