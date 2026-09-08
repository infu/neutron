/** Real ReviewHost, native dialog and retained handlers. Only tool registration
 * is mocked; caller validation and all dialog lifecycle code are production. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const out = await mkdtemp(join(process.env.ICPSWAP_REVIEW_ARTIFACTS || tmpdir(), "icpswap-review-"));
const fixture = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {ReviewHost} from '${root}/apps/icpswap/src/review.tsx';
  import '${root}/apps/icpswap/src/style.scss';
  const root = createRoot(document.getElementById('root'));
  root.render(<div className="nt-app ics-app"><button id="launch">Prepare action</button><ReviewHost/></div>);
  window.reviewState = {}; window.reviewControllers = {};
  window.startReview = (id, name, context = {}, review = {title:'Review swap', amount:'1000000'}) => {
    const controller = new AbortController(); window.reviewControllers[id] = controller;
    if (context.alreadyAborted) controller.abort();
    const actualContext = {
      caller:{appId:'icpswap',installationUid:'42',role:'background',endpoint:'app:icpswap:background'},
      reportProgress:() => {throw new Error('Unexpected progress call');},
      kernel:new Proxy({}, {get:() => {throw new Error('Unexpected Kernel call');}}),
      signal:controller.signal, ...context,
    };
    window.reviewState[id] = {settlements:0};
    let reply;
    try { reply = window.reviewMethods.get(name).handler({reviewJson:JSON.stringify(review)}, actualContext); }
    catch (error) { reply = Promise.reject(error); }
    Promise.resolve(reply).then(
      result => {window.reviewState[id].settlements++; window.reviewState[id].result = result;},
      error => {window.reviewState[id].settlements++; window.reviewState[id].error = String(error);},
    );
  };
  window.unmountReviews = () => root.unmount();
`;
await build({
  absWorkingDir: root, stdin: { contents: fixture, loader: "tsx", resolveDir: root },
  outfile: join(out, "main.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic", logLevel: "warning",
  plugins: [sassPlugin(), { name: "review-registration", setup(builder) {
    builder.onResolve({ filter: /^neutron-tools\/app$/ }, () => ({ path: "review-registration", namespace: "review-registration" }));
    builder.onLoad({ filter: /.*/, namespace: "review-registration" }, () => ({ contents: `
      globalThis.reviewMethods = new Map();
      export function exposeTool(name, definition, handler) {globalThis.reviewMethods.set(name, {definition, handler});}
    `, loader: "js" }));
  } }],
});
const server = createServer(async (req, res) => {
  const file = req.url === "/main.js" ? "main.js" : req.url === "/main.css" ? "main.css" : null;
  res.setHeader("Content-Type", file === "main.js" ? "text/javascript" : file ? "text/css" : "text/html");
  res.end(file ? await readFile(join(out, file)) : '<!doctype html><html><head><link rel="stylesheet" href="/main.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/main.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
const checks = [];
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || "/run/current-system/sw/bin/google-chrome-stable", args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 360, height: 720 } });
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.route("**/*", route => route.request().url().startsWith("http://127.0.0.1:") ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator("#launch").waitFor();
  const start = (id, name = "icpswap_owner_review_v1", context = {}, review) => page.evaluate(({ id, name, context, review }) => window.startReview(id, name, context, review), { id, name, context, review });
  const result = async (id) => {
    await page.waitForFunction(id => window.reviewState[id]?.settlements > 0, id);
    return page.evaluate(id => window.reviewState[id], id);
  };
  const assertOutcome = async (id, approved) => assert.deepEqual(await result(id), { settlements: 1, result: { approved } });
  const noDialog = () => page.waitForFunction(() => document.querySelector("dialog") === null);

  const methods = await page.evaluate(() => [...window.reviewMethods].map(([name, { definition }]) => ({ name, definition })));
  assert.deepEqual(methods.map(method => method.name).sort(), ["icpswap_owner_review_v1", "icpswap_review_v1"]);
  for (const { definition } of methods) {
    assert.deepEqual(definition.inputSchema, { type: "object", properties: { reviewJson: { type: "string" } }, required: ["reviewJson"], additionalProperties: false });
    assert.deepEqual(definition.outputSchema, { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"], additionalProperties: false });
    assert.equal(definition.annotations["neutron:visibility"], "same_app");
  }
  assert.equal(methods.find(method => method.name === "icpswap_review_v1").definition.annotations["neutron:audience"], "foreground_tile");
  checks.push("Both registered review methods retain exact closed input and approval output schemas.");

  const rejected = [
    ["missing-caller", "icpswap_owner_review_v1", { caller: null }, /authenticated caller/],
    ["bad-installation", "icpswap_owner_review_v1", { caller: { appId: "icpswap", installationUid: "01", role: "background", endpoint: "app:icpswap:background" } }, /authenticated caller/],
    ["wrong-owner-app", "icpswap_owner_review_v1", { caller: { appId: "wallet", installationUid: "42", role: "background", endpoint: "app:icpswap:background" } }, /resident service/],
    ["wrong-owner-role", "icpswap_owner_review_v1", { caller: { appId: "icpswap", installationUid: "42", role: "tile", endpoint: "app:icpswap:background" } }, /resident service/],
    ["wrong-owner-endpoint", "icpswap_owner_review_v1", { caller: { appId: "icpswap", installationUid: "42", role: "background", endpoint: "app:wallet:background" } }, /resident service/],
    ["owner-agent-mode", "icpswap_owner_review_v1", { agentMode: true }, /Kernel approval callback/],
    ["foreground-agent-mode", "icpswap_review_v1", { agentMode: true, audience: "foreground_tile" }, /Kernel approval callback/],
    ["no-foreground", "icpswap_review_v1", {}, /foreground presentation/],
    ["background-audience", "icpswap_review_v1", { audience: "background" }, /foreground presentation/],
  ];
  for (const [id, name, context, expected] of rejected) {
    await start(id, name, context);
    assert.match((await result(id)).error, expected);
    await noDialog();
  }
  for (const [id, invalid] of [["array-review", []], ["null-review", null], ["scalar-review", "Approve"]]) {
    await start(id, "icpswap_owner_review_v1", {}, invalid);
    assert.match((await result(id)).error, /prepared review is invalid/);
    await noDialog();
  }
  checks.push("Unauthenticated, root-agent, wrong resident, nonforeground and malformed review attempts cannot open a dialog.");

  await page.locator("#launch").focus();
  await start("approve", "icpswap_owner_review_v1", {}, { title: "Supply ckUSDC / ICP", kind: "mint", amount0: "1000000", funding: [{ token: "ckUSDC", amount: "1000000" }], details: ["Only the saved intent will be approved."] });
  const nativeDialog = page.getByRole("dialog", { name: "Supply ckUSDC / ICP" });
  await nativeDialog.waitFor();
  assert.equal(await nativeDialog.evaluate(node => node.open && node.matches(":modal")), true);
  assert.match(await nativeDialog.innerText(), /Token 0 maximum/);
  assert.match(await nativeDialog.innerText(), /Funding steps/);
  assert.match(await nativeDialog.innerText(), /Only the saved intent/);
  await page.getByText("Exact prepared action", { exact: true }).click();
  assert.deepEqual(JSON.parse(await page.locator(".ics-review-raw").innerText()), { title: "Supply ckUSDC / ICP", kind: "mint", amount0: "1000000", funding: [{ token: "ckUSDC", amount: "1000000" }], details: ["Only the saved intent will be approved."] });
  // Multiple DOM events retain the same captured finish callback; only its
  // first resolution counts, including native close dispatched after approve.
  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find(node => node.textContent === "Approve action");
    const dialog = document.querySelector("dialog");
    button.click(); button.click(); dialog.close();
  });
  await assertOutcome("approve", true);
  await noDialog();
  assert.equal(await page.evaluate(() => document.activeElement.id), "launch");
  checks.push("Authentic resident review is a native modal with structured and exact details; approval settles once and restores focus.");

  await start("foreground", "icpswap_review_v1", { audience: "foreground_tile", agentMode: false });
  await page.getByRole("dialog").waitFor();
  await page.getByRole("button", { name: "Approve action", exact: true }).click();
  await assertOutcome("foreground", true);
  await noDialog();
  checks.push("Kernel-attested normal foreground review can be accepted.");

  for (const dismissal of ["escape", "close-button", "native-close", "decline", "abort"]) {
    await page.locator("#launch").focus();
    await start(dismissal);
    await page.getByRole("dialog").waitFor();
    if (dismissal === "escape") await page.keyboard.press("Escape");
    if (dismissal === "close-button") await page.getByRole("button", { name: "Close review", exact: true }).click();
    if (dismissal === "native-close") await page.evaluate(() => document.querySelector("dialog").close());
    if (dismissal === "decline") await page.getByRole("button", { name: "Decline", exact: true }).click();
    if (dismissal === "abort") await page.evaluate(() => window.reviewControllers.abort.abort());
    await assertOutcome(dismissal, false);
    await noDialog();
    assert.equal(await page.evaluate(() => document.activeElement.id), "launch");
  }
  await start("already-aborted", "icpswap_owner_review_v1", { alreadyAborted: true });
  await assertOutcome("already-aborted", false);
  await noDialog();
  checks.push("Escape, close button, native close, Decline, active abort and already-aborted requests all resolve false.");

  await page.locator("#launch").focus();
  await page.evaluate(() => {
    window.startReview("queue-first", "icpswap_owner_review_v1", {}, { title: "First prepared action" });
    window.startReview("queue-second", "icpswap_owner_review_v1", {}, { title: "Second prepared action" });
    window.startReview("queue-aborted", "icpswap_owner_review_v1", {}, { title: "Aborted queued action" });
  });
  await page.getByRole("dialog", { name: "First prepared action" }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 1);
  await page.evaluate(() => window.reviewControllers["queue-aborted"].abort());
  await assertOutcome("queue-aborted", false);
  await page.getByRole("button", { name: "Approve action", exact: true }).click();
  await assertOutcome("queue-first", true);
  await page.getByRole("dialog", { name: "Second prepared action" }).waitFor();
  assert.equal((await page.evaluate(() => window.reviewState["queue-second"])).settlements, 0);
  await page.getByRole("button", { name: "Decline", exact: true }).click();
  await assertOutcome("queue-second", false);
  await noDialog();
  assert.equal(await page.evaluate(() => document.activeElement.id), "launch");
  checks.push("Queued reviews remain FIFO; aborting a queued review does not affect the active review, and final focus returns to the launcher.");

  await start("long", "icpswap_owner_review_v1", {}, {
    title: "Provide liquidity · ckUSDC / ICP", operationId: "a".repeat(128), pool: "b".repeat(250),
    funding: Array.from({ length: 8 }, (_, index) => ({ token: `Token ${index}`, amount: "1000000000000000000000000000", account: "c".repeat(150) })),
    details: Array.from({ length: 30 }, (_, index) => `Prepared detail ${index}: ${"d".repeat(160)}`),
  });
  await page.getByRole("dialog").waitFor();
  const geometry = await page.evaluate(() => {
    const dialog = document.querySelector("dialog"), content = document.querySelector(".ics-review-content"), footer = document.querySelector(".ics-review-layout > footer");
    return { dialog: dialog.getBoundingClientRect().toJSON(), footer: footer.getBoundingClientRect().toJSON(), outerOverflow: document.documentElement.scrollWidth > innerWidth, dialogOverflow: dialog.scrollWidth > dialog.clientWidth, contentOverflow: content.scrollWidth > content.clientWidth, scrollable: content.scrollHeight > content.clientHeight };
  });
  assert.equal(geometry.outerOverflow, false);
  assert.equal(geometry.dialogOverflow, false);
  assert.equal(geometry.contentOverflow, false);
  assert.equal(geometry.scrollable, true);
  assert(geometry.dialog.x >= 0 && geometry.dialog.right <= 360);
  assert(geometry.footer.y >= 0 && geometry.footer.bottom <= 720);
  await page.screenshot({ path: join(out, "review-360.png") });
  await page.getByRole("button", { name: "Decline", exact: true }).click();
  await assertOutcome("long", false);
  await noDialog();
  checks.push("A long structured review fits a 360px tile, scrolls internally and keeps the decision footer reachable.");

  await page.evaluate(() => {
    window.startReview("pagehide-active", "icpswap_owner_review_v1");
    window.startReview("pagehide-queued", "icpswap_owner_review_v1");
  });
  await page.getByRole("dialog").waitFor();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  await assertOutcome("pagehide-active", false);
  await assertOutcome("pagehide-queued", false);
  await noDialog();
  await page.evaluate(() => {
    window.startReview("unmount-active", "icpswap_owner_review_v1");
    window.startReview("unmount-queued", "icpswap_owner_review_v1");
  });
  await page.getByRole("dialog").waitFor();
  await page.evaluate(() => window.unmountReviews());
  await assertOutcome("unmount-active", false);
  await assertOutcome("unmount-queued", false);
  checks.push("Page hide and host unmount decline all active and queued reviews without retaining pending approvals.");

  assert.deepEqual(errors, []);
  await writeFile(join(out, "results.json"), JSON.stringify({ checks, errors }, null, 2));
  console.log(`Review browser checks passed; artifacts: ${out}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
