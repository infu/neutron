/** Actual app entry in the production opaque-origin iframe; review calls are local captures. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const output = process.env.KITCHENSINK_BROWSER_OUTPUT || join(root, "support/marketplace/.private/iframe-forms-release/kitchensink/browser");
await mkdir(output, { recursive: true });
const sdk = join(root, "packages/neutron-tools/src/app_entry.ts");
const sourceHashes = {};
const fixture = `
  export * from ${JSON.stringify(sdk)};
  window.fixture = { reviews: [], pending: [], reads: 0, finish() { this.pending.shift()?.('Review closed in fixture'); } };
  export const loadNeutronCanisterId = async () => 'aaaaa-aa';
  export const loadTileContext = () => ({ app: 'kitchensink', tile: 'main', instance: 'test', workspace: 0 });
  export const exposeTool = () => () => {};
  export const removeExposedTool = () => {};
  export const createCanisterClient = () => ({ callDialog(method, args, timeout) {
    if (method !== 'save_profile') throw Error('Unexpected mutation review: ' + method);
    window.fixture.reviews.push({ method, args, timeout });
    return new Promise(resolve => window.fixture.pending.push(resolve));
  }});
  export const querySelf = async method => {
    if (method !== 'read_profile') throw Error('Unexpected read: ' + method);
    window.fixture.reads++;
    return 'Name: Stored profile\\nEmail: stored@example.test\\nSubscribed: false\\nNotes: Read locally';
  };
`;
await build({
  absWorkingDir: root, entryPoints: [join(root, "apps/kitchensink/src/index.tsx")],
  outfile: join(output, "main.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic", logLevel: "warning",
  plugins: [sassPlugin(), { name: "kernel-review-fixture", setup(builder) {
    builder.onResolve({ filter: /^neutron-tools\/app$/ }, () => ({ path: "app", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: fixture, loader: "js", resolveDir: root }));
    builder.onLoad({ filter: /apps\/kitchensink\/src\/.*\.(ts|tsx)$/ }, async ({ path }) => {
      const contents = await readFile(path, "utf8");
      sourceHashes[path.slice(root.length)] = createHash("sha256").update(contents).digest("hex");
      return { contents, loader: path.endsWith(".tsx") ? "tsx" : "ts" };
    });
  }}],
});
const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const file = req.url === "/main.js" ? "main.js" : req.url === "/main.css" ? "main.css" : null;
  res.setHeader("Content-Type", file === "main.js" ? "text/javascript" : file ? "text/css" : "text/html");
  if (file) res.end(await readFile(join(output, file)));
  else if (req.url === "/app") res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/main.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/main.js"></script></body></html>');
  else res.end('<!doctype html><iframe title="Kitchen Sink" sandbox="allow-scripts" src="/app#memory" style="border:0;width:100vw;height:100vh"></iframe>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
const errors = [], messages = [], checks = [];
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || "/run/current-system/sw/bin/google-chrome-stable", args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 400, height: 1000 } });
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(String(error)));
  page.on("console", message => messages.push(message.text()));
  await page.route("**/*", route => route.request().url().startsWith("http://127.0.0.1:") ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const frame = page.frames().find(frame => frame.parentFrame());
  assert(frame);
  const name = frame.getByRole("textbox", { name: /^Name/ });
  const email = frame.getByRole("textbox", { name: /^Email/ });
  const notes = frame.getByRole("textbox", { name: /^Notes/ });
  const save = frame.getByRole("button", { name: "Review save in kernel", exact: true });
  const read = frame.getByRole("button", { name: "Read into form", exact: true });
  await name.waitFor();
  assert.equal(await frame.getByRole("form", { name: "Durable profile" }).count(), 1);
  assert.equal(await frame.locator("form").count(), 0);
  assert.equal(await frame.evaluate(() => window.origin), "null");
  await save.click();
  await frame.waitForFunction(() => window.fixture.reviews.length === 1);
  assert.deepEqual(await frame.evaluate(() => window.fixture.reviews[0]), {
    method: "save_profile", args: [["Ada Lovelace", "ada@example.test", "Stored in Kitchen Sink's managed memory root.", true]], timeout: 60,
  });
  assert.equal(await save.isDisabled(), true);
  assert.equal(await read.isDisabled(), true);
  await name.press("Enter");
  assert.equal(await frame.evaluate(() => window.fixture.reviews.length), 1);
  await frame.evaluate(() => window.fixture.finish());
  await frame.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Review save in kernel')?.disabled);
  checks.push("Explicit click opens one review; busy state blocks repeated Enter and read");

  await name.fill("");
  assert.equal(await save.isDisabled(), true);
  await name.press("Enter");
  await name.fill("Typed name");
  await email.fill("invalid");
  assert.equal(await save.isDisabled(), true);
  await email.press("Enter");
  await email.fill("a@b..test");
  await save.click();
  assert.equal(await frame.evaluate(() => window.fixture.reviews.length), 1, "Native email constraints are retained without native submission");
  await email.fill("typed@example.test");
  await notes.fill("First line");
  await notes.press("End");
  await notes.press("Enter");
  await notes.type("Second line");
  assert.equal(await notes.inputValue(), "First line\nSecond line");
  assert.equal(await frame.evaluate(() => window.fixture.reviews.length), 1);
  checks.push("Invalid names/emails do not review; textarea Enter retains newlines");

  await email.press("Shift+Enter");
  await email.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await email.dispatchEvent("keydown", { key: "Enter", code: "Enter", repeat: true });
  assert.equal(await frame.evaluate(() => window.fixture.reviews.length), 1);
  await email.press("Enter");
  await frame.waitForFunction(() => window.fixture.reviews.length === 2);
  assert.deepEqual(await frame.evaluate(() => window.fixture.reviews[1].args), [["Typed name", "typed@example.test", "First line\nSecond line", true]]);
  await frame.evaluate(() => window.fixture.finish());
  await read.click();
  assert.equal(await name.inputValue(), "Stored profile");
  assert.equal(await frame.evaluate(() => window.fixture.reads), 1);
  checks.push("Plain text-field Enter reviews current inputs; modified/composing/repeated Enter does not; read still works");
  await page.screenshot({ path: join(output, "profile-400.png"), fullPage: true });
  assert.deepEqual(errors, []);
  assert.equal(messages.filter(text => /blocked form submission|allow-forms/i.test(text)).length, 0);
  checks.push("Actual entry renders in allow-scripts-only iframe without native submission warnings or external calls");
  await writeFile(join(output, "results.json"), JSON.stringify({ passed: true, checks, errors, messages, sourceHashes }, null, 2) + "\n");
  console.log(JSON.stringify({ passed: true, checks: checks.length, output }));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
