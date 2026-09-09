// Run with: bun apps/kernel/test/browser/tile-connection.qualification.mjs
// All browser requests are fulfilled locally. No backend or canister is contacted.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { registryApp } from "../app_registry_fixture.ts";

const repo = fileURLToPath(new URL("../../../..", import.meta.url));
const artifacts = process.env.TILE_CONNECTION_ARTIFACTS || "/tmp/neutron-keep-bus/browser";
const kernelOrigin = "https://ryjl3-tyaaa-aaaaa-aaaba-cai.icp0.io";
const appId = "connection_fixture";
const app = registryApp({ id: appId, tiles: [{ id: "main", title: "Main" }] });
const instance = {
  scope: { appId: appId, installationUid: "1" }, version: app.version,
  deploymentId: "01".repeat(16), capabilityPlanFingerprint: app.capability_plan_fingerprint,
  browserOriginNonce: "01".repeat(16), browserOriginAuthorityEpoch: "1",
  residentFrameSecurity: "credentialless_opaque_v1",
};
await mkdir(artifacts, { recursive: true });

// App installation/Root state is controlled independently of the lifecycle under
// test. The actual frame component, authority checks, frame policy, MessageChannel
// registry and both sides of the SDK remain bundled from production sources.
const stores = `
import { create } from "zustand";
export const useAppsStore = create(() => ({
 list: { ${JSON.stringify(appId)}: ${JSON.stringify(app)} },
 appInstances: { ${JSON.stringify(appId)}: ${JSON.stringify(instance)} },
 runtimeGenerations: {}, browserSurfaceOriginAppIds: [],
 operation: null, pendingInstallRecovery: null, runtimeAuthorityFence: null,
}));
export const isAuthorityPendingState = state => Boolean(state.pendingInstallRecovery ||
 state.runtimeAuthorityFence || (state.operation && ["activating", "cleaning", "complete"].includes(state.operation.phase)));
export const useAgentModeStore = create(() => ({ activeRoot: null }));
`;
const storePlugin = {
  name: "isolated-authority-stores",
  setup(builder) {
    // Optional negative control: compile a retained predecessor without changing
    // the working tree, then require the same continuity assertions to fail.
    if (process.env.TILE_CONNECTION_FRAME_SOURCE) {
      builder.onLoad({ filter: /AppTileFrame\.tsx$/ }, async args => ({
        contents: await readFile(process.env.TILE_CONNECTION_FRAME_SOURCE, "utf8"),
        loader: "tsx", resolveDir: resolve(args.path, ".."),
      }));
    }
    builder.onResolve({ filter: /(?:reducer\/apps|ui_attention\/agent)\.ts$/ }, () => ({ path: "stores", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: stores, loader: "js", resolveDir: repo }));
  },
};
async function bundle(source, filename, plugins = []) {
  const result = await build({
    stdin: { contents: source, sourcefile: filename, resolveDir: repo, loader: "tsx" },
    bundle: true, write: false, platform: "browser", format: "esm", jsx: "automatic",
    target: "chrome120", plugins,
  });
  const output = result.outputFiles[0].text;
  await writeFile(resolve(artifacts, filename.replace(/tsx$/, "js")), output);
  return output;
}
const parentScript = await bundle(`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { AppTileFrame } from "./apps/kernel/src/workspace/AppTileFrame.tsx";
import { useAppsStore, useAgentModeStore } from "./apps/kernel/src/reducer/apps.ts";
import { loadIcRuntimeFixture } from "./apps/kernel/test/runtime_fixture.ts";
import { installFrameEndpointHandshake, listRegisteredEndpoints,
 subscribeEndpointPortMessages, subscribeEndpointPortRetirements } from "./apps/kernel/src/frame_context.ts";
import { execPort } from "./packages/neutron-tools/src/kernel.ts";
import { msgBusLocalActions } from "./packages/neutron-tools/src/protocol.ts";
await loadIcRuntimeFixture();
const adopted = new URL(location.href).searchParams.has("adopted");
useAppsStore.setState({ browserSurfaceOriginAppIds: adopted ? [${JSON.stringify(appId)}] : [] });
installFrameEndpointHandshake();
const root = createRoot(document.getElementById("root"));
const savedFrames = new Map();
const savedPorts = new Map();
const pending = [];
const observations = { dispatches: [], retired: [], toolResults: {}, childResults: [] };
let active = false, mounted = true;
const tile = { id: "visited", appId: ${JSON.stringify(appId)}, tileId: "main", title: "Fixture", path: "index.html", icon: "" };
function render() { flushSync(() => root.render(<>
 <div hidden={!active}>{mounted && <AppTileFrame active={active} tile={tile} workspaceId={1}/>}</div>
 <AppTileFrame active={false} tile={{...tile, id: "unvisited"}} workspaceId={2}/>
</>)); }
function endpoint() { return listRegisteredEndpoints().find(value => value.context.instanceId === "visited"); }
function frame() { return document.querySelector('[data-instance-id="visited"]'); }
function reply(item) {
 item.port.postMessage({ type: "neutron:self-call:response", version: 1, id: item.data.id,
 ok: { method: item.data.method, requestId: item.data.args[0]?.requestId ?? null }, blobs: [] });
}
subscribeEndpointPortMessages(({ endpoint, event }) => {
 if (event.data.type !== "neutron:self-call:exec") return;
 const item = { data: event.data, port: endpoint.port };
 observations.dispatches.push({ method: event.data.method, tool: event.data.tool,
   requestId: event.data.args[0]?.requestId ?? null, sessionId: endpoint.sessionId });
 if (event.data.method.startsWith("held_")) pending.push(item); else reply(item);
});
subscribeEndpointPortRetirements(port => {
 observations.retired.push([...savedPorts].filter(([, value]) => value === port).map(([key]) => key));
});
addEventListener("message", event => {
 if (event.source !== frame()?.contentWindow || event.data?.type !== "fixture:result") return;
 observations.childResults.push(event.data);
});
function tool(key) {
 const port = endpoint()?.port;
 if (!port) throw Error("Fixture endpoint is not connected");
 observations.toolResults[key] = { state: "pending" };
 execPort(port, msgBusLocalActions.toolsCall, { name: "fixture.continue", arguments: { key } }, 10).then(
  value => observations.toolResults[key] = { state: "complete", value },
  error => observations.toolResults[key] = { state: "error", message: error.message });
}
globalThis.fixture = {
 observations, setActive(value) { active = value; render(); },
 setMounted(value) { mounted = value; render(); },
 setRoot(value) { flushSync(() => useAgentModeStore.setState({ activeRoot: value ? { callerEndpointId: "app:connection_fixture:tile:main:instance:visited" } : null })); },
 setFence(value) { flushSync(() => useAppsStore.setState({ runtimeAuthorityFence: value ? "fixture-logout" : null })); },
 replaceAuthority() { flushSync(() => useAppsStore.setState(state => ({ runtimeGenerations: { [tile.appId]: (state.runtimeGenerations[tile.appId] ?? 0) + 1 } }))); },
 remember(key) { savedFrames.set(key, frame()); savedPorts.set(key, endpoint()?.port); },
 snapshot(key) { return { count: document.querySelectorAll("iframe").length,
  endpointCount: listRegisteredEndpoints().length, sessionId: endpoint()?.sessionId ?? null,
  sameFrame: savedFrames.get(key) === frame(), samePort: savedPorts.get(key) === endpoint()?.port,
  hasUnvisited: Boolean(document.querySelector('[data-instance-id="unvisited"]')),
  oldFrameConnected: savedFrames.get(key)?.isConnected ?? false }; },
 release() { for (const item of pending.splice(0)) reply(item); }, tool,
};
render();
`, "parent.tsx", [storePlugin]);
const childScript = await bundle(`
import { installMessageListener, querySelf, updateSelf, exposeTool } from "./packages/neutron-tools/src/app.ts";
const child = globalThis.childFixture = { bootId: crypto.randomUUID(), sessions: [], results: {}, toolStarts: 0 };
addEventListener("message", event => {
 if (event.source === parent && event.data?.type === "neutron:msgbus:connect") child.sessions.push(event.data.sessionId);
});
function capture(key, promise) {
 child.results[key] = { state: "pending" };
 promise.then(value => child.results[key] = { state: "complete", value },
 error => child.results[key] = { state: "error", message: error.message, code: error.code ?? null });
}
child.start = () => {
 capture("read", querySelf("held_read", [], 10));
 capture("write", updateSelf("held_write", [{ requestId: "retained-operation-1" }], 10));
};
child.read = () => querySelf("inactive_read", [], 10);
exposeTool("fixture.continue", { inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false } },
 async (args, context) => { child.toolStarts += 1; const value = await context.kernel.querySelf("held_tool", [{ requestId: args.key }], 10); return { continued: args.key, value }; });
installMessageListener();
`, "child.tsx");
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, process.env.CHROMIUM_PATH,
  "/run/current-system/sw/bin/google-chrome-stable", chromium.executablePath(), "/usr/bin/chromium"]
  .find(value => value && existsSync(value));
assert.ok(executablePath, "A runnable Chromium is required; set PLAYWRIGHT_CHROMIUM_EXECUTABLE");
const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
const results = [];
try {
  for (const adopted of [false, true]) {
    const context = await browser.newContext();
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const requests = [];
    await context.route("**/*", async route => {
      const request = route.request();
      const url = new URL(request.url());
      requests.push({ url: request.url(), method: request.method() });
      const isKernel = url.origin === kernelOrigin;
      if (request.method() !== "GET") return route.abort();
      if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: isKernel ? parentScript : childScript, headers: { "access-control-allow-origin": "*" } });
      if (isKernel && url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>' });
      if (!isKernel && url.pathname === "/app/connection_fixture/index.html") return route.fulfill({ contentType: "text/html", body: '<!doctype html><p>Connection fixture</p><script type="module" src="/fixture.js"></script>', headers: { "access-control-allow-origin": "*" } });
      return route.fulfill({ status: 404, body: "Fixture route not found" });
    });
    try {
      console.log("Starting profile", adopted ? "installation-origin" : "legacy-opaque");
      await page.goto(`${kernelOrigin}/${adopted ? "?adopted" : ""}`);
      await page.waitForFunction(() => Boolean(globalThis.fixture));
      assert.equal((await page.evaluate(() => fixture.snapshot("initial"))).count, 0, "unvisited workspaces stay lazy");
      await page.evaluate(() => fixture.setActive(true));
      await page.waitForFunction(() => fixture.snapshot("initial").sessionId !== null);
      const child = page.frames().find(frame => frame.url().includes("/app/connection_fixture/index.html"));
      assert.ok(child);
      await child.waitForFunction(() => Boolean(globalThis.childFixture));
      const first = await page.evaluate(() => { fixture.remember("first"); return fixture.snapshot("first"); });
      const bootId = await child.evaluate(() => childFixture.bootId);
      assert.equal(first.count, 1);
      assert.equal(first.hasUnvisited, false);
      await child.evaluate(() => childFixture.start());
      await page.evaluate(() => fixture.tool("continue-once"));
      await page.waitForFunction(() => fixture.observations.dispatches.length === 3);
      await page.evaluate(() => fixture.setActive(false));
      const hidden = await page.evaluate(() => fixture.snapshot("first"));
      assert.equal(hidden.sameFrame, true, "workspace switch keeps the mounted iframe");
      assert.equal(hidden.samePort, true, "workspace switch keeps the original private port");
      assert.equal(hidden.sessionId, first.sessionId, "workspace switch keeps the SDK session");
      assert.equal(await child.evaluate(() => childFixture.bootId), bootId);
      assert.deepEqual(await child.evaluate(() => childFixture.read()), { method: "inactive_read", requestId: null }, "new reads work while hidden");
      await page.evaluate(() => fixture.setRoot(true));
      await page.evaluate(() => fixture.setRoot(false));
      assert.equal((await page.evaluate(() => fixture.snapshot("first"))).samePort, true, "ending Root while hidden does not retire the port");
      for (let index = 0; index < 10; index += 1) {
        await page.evaluate(() => fixture.setActive(true));
        await page.evaluate(() => fixture.setActive(false));
      }
      assert.deepEqual(await child.evaluate(() => childFixture.sessions), [first.sessionId]);
      await page.evaluate(() => fixture.release());
      await child.waitForFunction(() => childFixture.results.read.state === "complete" && childFixture.results.write.state === "complete");
      await page.waitForFunction(() => fixture.observations.toolResults["continue-once"].state === "complete");
      assert.equal(await child.evaluate(() => childFixture.toolStarts), 1, "tool continuation was not replayed");
      const dispatches = await page.evaluate(() => fixture.observations.dispatches);
      assert.equal(dispatches.filter(item => item.method === "held_read").length, 1);
      assert.equal(dispatches.filter(item => item.method === "held_write").length, 1, "an interrupted update is never replayed");
      assert.equal(dispatches.find(item => item.method === "held_write").requestId, "retained-operation-1");
      assert.ok(dispatches.every(item => item.sessionId === first.sessionId));
      assert.equal((await page.evaluate(() => fixture.observations.retired)).length, 0);

      // Real teardown remains distinct from visibility. Closing the tile must
      // settle outstanding Kernel tool callbacks as retired, not leave them live.
      await page.evaluate(() => fixture.tool("closed-tile"));
      await page.waitForFunction(() => fixture.observations.dispatches.some(item => item.requestId === "closed-tile"));
      await page.evaluate(() => fixture.setMounted(false));
      await page.waitForFunction(() => fixture.observations.toolResults["closed-tile"].state === "error");
      assert.match(await page.evaluate(() => fixture.observations.toolResults["closed-tile"].message), /retired/);
      const closed = await page.evaluate(() => fixture.snapshot("first"));
      assert.equal(closed.count, 0);
      assert.equal(closed.endpointCount, 0);
      assert.equal(closed.oldFrameConnected, false);
      await page.evaluate(() => { fixture.setActive(true); fixture.setMounted(true); });
      await page.waitForFunction(() => fixture.snapshot("first").sessionId !== null);
      const successor = await page.evaluate(() => { fixture.remember("successor"); return fixture.snapshot("successor"); });
      assert.notEqual(successor.sessionId, first.sessionId);
      await page.evaluate(() => fixture.tool("changed-authority"));
      await page.waitForFunction(() => fixture.observations.dispatches.some(item => item.requestId === "changed-authority"));
      await page.evaluate(() => fixture.setActive(false));
      await page.evaluate(() => fixture.replaceAuthority());
      await page.waitForFunction(() => fixture.observations.toolResults["changed-authority"].state === "error");
      assert.match(await page.evaluate(() => fixture.observations.toolResults["changed-authority"].message), /retired/);
      const replaced = await page.evaluate(() => fixture.snapshot("successor"));
      assert.equal(replaced.count, 0, "an inactive replacement remains lazy");
      assert.equal(replaced.endpointCount, 0);
      assert.equal(replaced.oldFrameConnected, false);
      await page.evaluate(() => fixture.setActive(true));
      await page.waitForFunction(() => fixture.snapshot("successor").sessionId !== null);
      assert.notEqual((await page.evaluate(() => fixture.snapshot("successor"))).sessionId, successor.sessionId);
      await page.evaluate(() => fixture.setFence(true));
      assert.equal((await page.evaluate(() => fixture.snapshot("successor"))).endpointCount, 0, "loss of runtime authority still retires endpoints");
      assert.equal((await page.evaluate(() => fixture.snapshot("successor"))).count, 0);
      assert.deepEqual(errors, []);
      results.push({ profile: adopted ? "installation-origin" : "legacy-opaque", passed: true, requests, observations: await page.evaluate(() => fixture.observations) });
    } catch (error) {
      console.error(JSON.stringify({ errors, requests, state: await page.evaluate(() => globalThis.fixture?.snapshot("first")) }, null, 2));
      throw error;
    } finally {
      await context.tracing.stop({ path: resolve(artifacts, `${adopted ? "installation-origin" : "legacy-opaque"}.zip`) });
      await context.close();
    }
  }
  await writeFile(resolve(artifacts, "results.json"), JSON.stringify(results, null, 2));
  console.log("PASS: opaque and installation-origin tiles retain one iframe/port/session across workspace and Root transitions; pending read/update/tool calls finish once; unvisited/replaced tiles remain lazy; close and authority loss retire ports.");
} finally {
  await browser.close();
}
