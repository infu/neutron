import { build } from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { ResidentSnapshot, ResidentResult } from "../src/resident.ts";

const app = resolve(import.meta.dir, "..");
const output = resolve(app, "../../tmp/hullshift-browser");
await mkdir(output, { recursive: true });
const worker = await build({ entryPoints: [resolve(app, "src/generator_worker.ts")], bundle: true, write: false, format: "iife", platform: "browser", minify: true });
await build({ entryPoints: [resolve(import.meta.dir, "browser_entry.ts")], outfile: resolve(output, "main.js"), bundle: true, format: "esm", platform: "browser", jsx: "automatic", plugins: [
  { name: "test-transport", setup(builder) {
    builder.onResolve({ filter: /^neutron-tools\/app$/ }, () => ({ path: resolve(import.meta.dir, "browser_bridge.ts") }));
    builder.onResolve({ filter: /^hullshift-worker-source$/ }, () => ({ path: "worker", namespace: "test-worker" }));
    builder.onLoad({ filter: /.*/, namespace: "test-worker" }, () => ({ contents: `export default ${JSON.stringify(worker.outputFiles[0]!.text)}`, loader: "js" }));
  } }, sassPlugin(),
] });
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/") return new Response('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hullshift test</title><link rel="stylesheet" href="/main.css"><div id="root"></div><script type="module" src="/main.js"></script></html>', { headers: { "content-type": "text/html" } });
  if (path === "/main.js" || path === "/main.css") return new Response(Bun.file(resolve(output, path.slice(1))));
  return new Response(null, { status: 404 });
} });
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  args: ["--enable-unsafe-swiftshader", ...(process.env.PLAYWRIGHT_CHROMIUM_ARGS?.split(" ").filter(Boolean) ?? [])] });
try {
  const page = await browser.newPage({ viewport: { width: 1120, height: 820 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url.href);
  await expect(page.getByRole("button", { name: "New puzzle" })).toBeVisible();
  await page.screenshot({ path: resolve(output, "home-desktop.png") });
  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => page.evaluate(async ({ name, args }) => {
    const bridge = (window as any).hullshiftTest;
    return bridge.callTool({ name, arguments: { tileId: "browser-test", ...args } });
  }, { name, args });
  const snapshot = () => call<ResidentSnapshot>("hullshift_snapshot");
  // Real worker generation, gameplay, hints and storage through the app tools.
  await page.getByRole("button", { name: "New puzzle" }).click();
  await expect(page.getByText("Park every pod on a glowing bay")).toBeVisible({ timeout: 60000 });
  let state = await snapshot();
  expect(state.activeRun?.level.objective).toBe("cargo");
  expect(state.storage.mode).toBe("persistent");
  const first = state.activeRun!;
  await page.getByRole("button", { name: "Hint", exact: true }).click();
  await expect(page.getByRole("button", { name: "Show me the next push" })).toBeVisible();
  await page.getByRole("button", { name: "Show me the next push" }).click();
  await expect(page.locator(".hs-hint-map")).toBeVisible();
  await page.screenshot({ path: resolve(output, "hint-desktop.png") });
  await page.getByRole("button", { name: "Back to puzzle" }).click();
  state = await snapshot();
  let run = state.activeRun!;
  const firstMove = run.analysis.preferredSolution!.actions[0]!;
  await page.keyboard.press({ N: "ArrowUp", E: "ArrowRight", S: "ArrowDown", W: "ArrowLeft" }[firstMove]);
  await expect.poll(async () => (await snapshot()).activeRun?.statistics.acceptedActions).toBe(1);
  await expect(page.getByRole("button", { name: "Undo move" })).toBeEnabled();
  await page.getByRole("button", { name: "Undo move" }).click();
  expect((await snapshot()).activeRun!.snapshot.state).toEqual(first.snapshot.state);
  await page.screenshot({ path: resolve(output, "board-desktop.png") });
  await page.reload();
  await expect(page.getByText("Park every pod on a glowing bay")).toBeVisible();
  expect((await snapshot()).activeRun!.id).toBe(first.id);
  // Replay the generated route through authoritative tools, including victory.
  run = (await snapshot()).activeRun!;
  for (const direction of run.analysis.preferredSolution!.actions) {
    const result = await call<ResidentResult>("hullshift_run_action", { runId: run.id, expectedRevision: run.revision, direction });
    expect(result.ok).toBe(true);
    run = result.snapshot.activeRun!;
  }
  expect(run.snapshot.outcome.kind).toBe("victory");
  await expect(page.getByRole("dialog", { name: "Puzzle complete" })).toBeVisible();
  await page.screenshot({ path: resolve(output, "victory-desktop.png") });
  await page.getByRole("button", { name: "Try a little harder" }).click();
  await expect.poll(async () => (await snapshot()).activeRun?.identity.difficulty, { timeout: 60000 }).toBe(1);
  expect((await snapshot()).activeRun!.levelHash).not.toBe(first.levelHash);
  await page.setViewportSize({ width: 390, height: 740 });
  await page.screenshot({ path: resolve(output, "board-mobile.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Exit to lobby" }).click();
  await expect(page.getByRole("button", { name: "New puzzle" })).toBeVisible();
  await page.screenshot({ path: resolve(output, "home-mobile.png") });
  expect(errors).toEqual([]);
  console.log(`Hullshift browser checks passed. Screenshots: ${output}`);
  if (process.argv.includes("--preview")) {
    console.log(`Preview server: ${server.url.href}`);
    await new Promise<void>(() => {});
  }
} finally { await browser.close(); server.stop(true); }
