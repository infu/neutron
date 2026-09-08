/** Real chart component, browser geometry and keyboard input; no network data. */
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
const out = await mkdtemp(join(process.env.ICPSWAP_CHART_ARTIFACTS || tmpdir(), "icpswap-chart-"));
const fixture = `
  import React, {useState} from 'react';
  import {createRoot} from 'react-dom/client';
  import {Chart} from '${root}/apps/icpswap/src/chart.tsx';
  import '${root}/apps/icpswap/src/style.scss';
  const candles = [10, 20, 40].map(t => ({t, open:t-1, high:t+2, low:t-2, close:t}));
  function Fixture() {
    const [long, setLong] = useState(false); window.setLong = setLong;
    return <div className="nt-app ics-app" style={{width:'100%',padding:12,boxSizing:'border-box'}}>
      <Chart points={[]} candles={candles} bars={[{t:40,v:30},{t:10,v:10}]}
        formatTime={t=>'T'+t} formatValue={v=>long ? v.toFixed(2)+' price units' : '$'+v.toFixed(2)}
        formatBar={v=>v+' USD'} valueLabel="Price" height={280}/>
    </div>;
  }
  createRoot(document.getElementById('root')).render(<Fixture/>);
`;
await build({
  absWorkingDir: root, stdin: { contents: fixture, loader: "tsx", resolveDir: root },
  outfile: join(out, "main.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
  plugins: [sassPlugin()], logLevel: "warning",
});
const server = createServer(async (req, res) => {
  const file = req.url === "/main.js" ? "main.js" : req.url === "/main.css" ? "main.css" : null;
  res.setHeader("Content-Type", file === "main.js" ? "text/javascript" : file ? "text/css" : "text/html");
  res.end(file ? await readFile(join(out, file)) : '<!doctype html><html><head><link rel="stylesheet" href="/main.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/main.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || "/run/current-system/sw/bin/google-chrome-stable", args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 360, height: 720 } });
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.route("**/*", route => route.request().url().startsWith("http://127.0.0.1:") ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const chart = page.getByRole("img", { name: "Price candlestick chart, 3 observations" });
  await chart.waitFor();
  await chart.focus();
  const time = page.locator(".ics-chart-tooltip-time");
  await page.waitForFunction(() => document.querySelector(".ics-chart-tooltip-time")?.textContent === "T40");
  await chart.press("ArrowLeft");
  assert.equal(await time.innerText(), "T20");
  assert.equal(await page.locator(".ics-chart-tooltip").innerText().then(text => text.includes("USD")), false);
  await chart.press("Home");
  assert.equal(await time.innerText(), "T10");
  assert.match(await page.locator(".ics-chart-tooltip").innerText(), /10 USD/);
  await chart.press("ArrowLeft");
  assert.equal(await time.innerText(), "T10");
  await chart.press("End");
  assert.equal(await time.innerText(), "T40");
  await chart.press("Escape");
  assert.equal(await time.count(), 0);

  // A formatter changing the left-axis gutter must move both plotted marks and
  // pointer lookup. This reproduces the stale xAt/handleMove dependency bug.
  await page.evaluate(() => window.setLong(true));
  await page.waitForFunction(() => !document.querySelector(".ics-chart-latest-label")?.textContent.startsWith("$"));
  for (const width of [320, 960, 360]) {
    await page.setViewportSize({ width, height: 720 });
    await page.waitForFunction(() => Math.abs(document.querySelector("svg").getBoundingClientRect().width - Number(document.querySelector("svg").getAttribute("width"))) < 1);
    const wick = page.locator(".ics-candle-wick").nth(1);
    const box = await wick.boundingBox();
    await page.mouse.move(box.x, box.y + box.height / 2);
    await page.waitForFunction(() => document.querySelector(".ics-chart-tooltip-time")?.textContent === "T20");
    const tooltip = await page.locator(".ics-chart-tooltip").boundingBox();
    assert(tooltip.x >= 0 && tooltip.x + tooltip.width <= width, `tooltip fits ${width}px tile: ${JSON.stringify(tooltip)}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  }
  const touchAction = await chart.evaluate(node => getComputedStyle(node).touchAction);
  assert(touchAction.includes("pan-y"), `chart allows vertical touch scrolling, got ${touchAction}`);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(out, "chart-360.png") });
  await writeFile(join(out, "results.json"), JSON.stringify({ checks: ["keyboard inspection and dismissal", "missing volume bucket stays missing", "pointer lookup tracks changing axis gutter", "320/360/960px resize and tooltip bounds", "touch scrolling allowed"], errors }, null, 2));
  console.log(`Chart browser checks passed; artifacts: ${out}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
