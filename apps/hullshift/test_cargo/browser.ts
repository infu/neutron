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
  await expect(page.getByText("Fill every mint bay with a cargo pod")).toBeVisible({ timeout: 60000 });
  let state = await snapshot();
  expect(state.activeRun?.level.objective).toBe("freight");
  expect(state.storage.mode).toBe("persistent");
  const first = state.activeRun!;
  await page.getByRole("button", { name: "Hint", exact: true }).click();
  await expect(page.getByRole("button", { name: "Show me the next step" })).toBeVisible();
  await page.getByRole("button", { name: "Show me the next step" }).click();
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
  await expect(page.getByText("Fill every mint bay with a cargo pod")).toBeVisible();
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
  // The full-spectrum board exposes all six systems and explains each one.
  state = await snapshot();
  await call("hullshift_generation_start", { expectedServiceRevision: state.serviceRevision, seed: "000000000000007b", difficulty: 7 });
  await expect.poll(async () => (await snapshot()).activeRun?.identity.difficulty, { timeout: 60000 }).toBe(7);
  await expect(page.locator(".hs-system-buttons button")).toHaveCount(6);
  for (const name of ["Pressure plate", "Toggle relay", "Reactor docking", "Powered bridge", "Cracked floor", "Disposal chute"]) {
    const button = page.getByRole("button", { name, exact: true });
    if (await button.getAttribute("aria-pressed") !== "true") await button.click();
    await expect(page.locator(".hs-system-rule")).toBeVisible();
  }
  await page.screenshot({ path: resolve(output, "six-systems-mobile.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Status and explanation panels must not cover one another on a small tile.
  const boxes = await page.locator(".hs-bay-progress, .hs-deck-systems, .hullshift-board-stage").evaluateAll((elements) => elements.map((e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }));
  expect(boxes[0]!.bottom).toBeLessThanOrEqual(boxes[1]!.top);
  expect(boxes[1]!.bottom).toBeLessThanOrEqual(boxes[2]!.top);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: resolve(output, "six-systems-desktop.png") });
  await page.getByRole("button", { name: "Mission menu" }).click();
  await page.getByRole("button", { name: "How to play" }).click();
  await expect(page.locator('[data-help-model="plate"]')).toBeVisible();
  await expect(page.locator('[data-help-model="gate"]')).toHaveCount(0);
  await page.screenshot({ path: resolve(output, "systems-help-desktop.png") });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Exit to lobby" }).click();
  await page.getByText("Have a puzzle code?").click();
  await page.getByLabel("Puzzle code", { exact: true }).fill("HS1-G5-D2-Sffffffffabcd1234-Cc0cc2865");
  await page.getByRole("button", { name: "Play this puzzle" }).click();
  await expect.poll(async () => (await snapshot()).activeRun?.shareCode, { timeout: 60000 }).toBe("HS1-G5-D2-Sffffffffabcd1234-Cc0cc2865");
  expect((await snapshot()).activeRun!.levelHash).toBe("e82f13df94aa38b0a745a0c663f568f7af548992e4c1515f457ed1861f80d84f");
  expect(errors).toEqual([]);
  console.log(`Hullshift browser checks passed. Screenshots: ${output}`);
  if (process.argv.includes("--preview")) {
    console.log(`Preview server: ${server.url.href}`);
    await new Promise<void>(() => {});
  }
} finally { await browser.close(); server.stop(true); }
