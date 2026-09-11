import { expect, test } from "bun:test";
import { chromium, type Browser } from "@playwright/test";
import esbuild from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import { serve } from "bun";
import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function browserOptions() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE };
  const store = await readdir("/nix/store").catch(() => []);
  const candidates = [
    ...store.filter(name => name.endsWith("-playwright-chromium")).sort().map(name => join("/nix/store", name, "chrome-linux64", "chrome")),
    "/run/current-system/sw/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium",
  ];
  for (const executablePath of candidates) {
    try { await access(executablePath, constants.X_OK); return { executablePath }; } catch { /* Next available browser. */ }
  }
  return {};
}

test("SNS exact review works in a narrow sandboxed iframe and aborts without approving", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = await esbuild.build({
    stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { ReviewHost } from './src/ui/ReviewHost';
      const caller={appId:'snsgov',installationUid:'17',role:'background',endpoint:'app:snsgov:background'};
      globalThis.results=[];
      globalThis.startReview=()=>{
        globalThis.controller=new AbortController();
        globalThis.reviewPromise=globalThis.tools.sns_owner_review_v1({reviewJson:JSON.stringify({
          title:'Stake 12.5 DAO',snsName:'Example DAO',
          summary:'This Neutron will control the new neuron.',
          fields:[{label:'Dissolve delay',value:'6 months'},{label:'Amount',value:'12.5 DAO'}],
          warnings:['Unlocking takes six months after you start dissolving.'],
          exactArgs:'ab'.repeat(1000)
        })},{caller,agentMode:false,signal:globalThis.controller.signal}).then(r=>globalThis.results.push(r),e=>globalThis.results.push({error:e.message}));
      };
      createRoot(document.getElementById('root')).render(<main className='nt-app'><button type='button' onClick={()=>globalThis.startReview()}>Stake tokens</button><ReviewHost /></main>);
    `, resolveDir: root, sourcefile: "review-fixture.tsx", loader: "tsx" },
    bundle: true, format: "esm", jsx: "automatic", outdir: "review-fixture", write: false,
    plugins: [{ name: "review-boundary", setup(build) {
      build.onResolve({ filter: /^neutron-tools\/app$/ }, () => ({ path: "sdk", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ loader: "js", contents: "globalThis.tools={};export const exposeTool=(name,descriptor,handler)=>{globalThis.tools[name]=handler};" }));
    } }, sassPlugin()],
  });
  const js = result.outputFiles!.find((file) => file.path.endsWith(".js"))!.text;
  const css = result.outputFiles!.find((file) => file.path.endsWith(".css"))!.text;
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/bundle.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
    const html = path === "/frame" ? `<style>html,body{margin:0;background:#080b0f;color:white}*{box-sizing:border-box}${css}</style><div id="root"></div><script type="module" src="/bundle.js"></script>`
      : '<iframe title="SNS tile" sandbox="allow-scripts allow-same-origin" src="/frame" style="width:320px;height:650px;border:0"></iframe>';
    return new Response(html, { headers: { "content-type": "text/html" } });
  } });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true, timeout: 15_000, ...await browserOptions() });
    const page = await browser.newPage({ viewport: { width: 400, height: 700 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}`);
    const frame = page.frameLocator('iframe');
    await frame.getByRole("button", { name: "Stake tokens" }).click();
    await frame.getByRole("dialog").waitFor();
    expect(await frame.getByText("Advanced details", { exact: true }).evaluate((node) => node.parentElement?.hasAttribute("open"))).toBe(false);
    const box = await frame.getByRole("dialog").boundingBox();
    expect(box!.width).toBeLessThanOrEqual(320);
    await frame.getByRole("button", { name: "Cancel", exact: true }).click();
    const child = page.frames().find((candidate) => candidate.url().endsWith("/frame"))!;
    expect(await child.evaluate(() => (globalThis as any).results)).toEqual([{ approved: false }]);
    await frame.getByRole("button", { name: "Stake tokens" }).click();
    await frame.getByRole("button", { name: "Approve", exact: true }).click();
    expect(await child.evaluate(() => (globalThis as any).results)).toEqual([{ approved: false }, { approved: true }]);
    await frame.getByRole("button", { name: "Stake tokens" }).click();
    await frame.getByRole("dialog").waitFor();
    await child.evaluate(() => (globalThis as any).controller.abort(new Error("Owner stopped the agent")));
    await frame.getByRole("dialog").waitFor({ state: "detached" });
    expect(await child.evaluate(() => (globalThis as any).results)).toEqual([{ approved: false }, { approved: true }, { error: "Owner stopped the agent" }]);
    expect(await frame.getByRole("button", { name: "Stake tokens" }).evaluate((node) => document.activeElement === node)).toBe(true);
    expect(errors).toEqual([]);
  } finally { try { await browser?.close(); } finally { server.stop(true); } }
}, 60_000);
