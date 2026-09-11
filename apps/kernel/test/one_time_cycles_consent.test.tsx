import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { build } from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import { chromium } from "@playwright/test";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const destination = "um5iw-rqaaa-aaaaq-qaaba-cai";
const cycleCall = {
  requestId: "00000000000000000000000000000001",
  canister: destination,
  method: "deposit",
  argsHex: "4449444c0000",
  cyclesAtoms: "50000000000000",
  allowPartial: true,
  balanceAtoms: "55000000000000",
  reserveAtoms: "5000000000000",
  maxCyclesAtoms: "49999990000000",
  requestedCyclesAtoms: "50000000000000",
  selectedCyclesAtoms: "49999990000000",
  remainingCyclesAtoms: "5000000000000",
  callCostAtoms: "10000000",
  usualLimitPerCallAtoms: "1000000000000",
  usualLimitPerDayAtoms: "10000000000000",
};

// Exercise the real React dialog, consent snapshot, callbacks and owner-attention
// store. Only installed-app metadata is a fixture. No financial or remote call
// can leave this browser, including after its consent promise is approved.
test("large cycle spending requires an unchecked acknowledgement for each request and clears consent after the owner's decision", async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { BackendCallRequest } from "./apps/kernel/src/Requests.tsx";
        import { requestBackendCallConsent, useBackendCallConsentStore }
          from "./apps/kernel/src/reducer/backend_calls.ts";
        import { useUiAttentionStore } from "./apps/kernel/src/ui_attention/owner.ts";
        import "./apps/kernel/src/style.scss";
        const fixture = window.fixture = { decisions: [], requestCount: 0 };
        fixture.open = () => {
          const number = ++fixture.requestCount;
          requestBackendCallConsent({
            endpoint: "app:wallet:tile:wallet:instance:one",
            appId: "wallet", source: { role: "tile", tileId: "wallet", instanceId: "one", workspace: 1 },
            actions: [],
            oneTimeCycleCall: { ...${JSON.stringify(cycleCall)}, requestId: String(number).padStart(32, "0") },
          }).then(() => fixture.decisions.push("approved"), () => fixture.decisions.push("rejected"));
        };
        fixture.snapshot = () => ({
          pending: Object.keys(useBackendCallConsentStore.getState().requests).length,
          attention: useUiAttentionStore.getState().active,
          decisions: fixture.decisions,
        });
        function ConsentHost() {
          const requests = useBackendCallConsentStore(state => state.requests);
          const request = Object.values(requests)[0];
          return request ? <BackendCallRequest request={request} uiMode="normal"/> : <div>No pending consent</div>;
        }
        createRoot(document.getElementById("root")).render(<ConsentHost/>);
        fixture.open();
      `,
      sourcefile: "one-time-cycle-consent-fixture.tsx",
      resolveDir: repo,
      loader: "tsx",
    },
    bundle: true,
    write: false,
    outfile: "/tmp/neutron-owner-cycles-consent-fixture.js",
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    target: "chrome120",
    plugins: [{
      name: "installed-app-metadata-fixture",
      setup(builder) {
        builder.onResolve({ filter: /(?:^|\/)reducer\/apps\.ts$/ }, () => ({ path: "apps", namespace: "consent-fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "consent-fixture" }, () => ({
          contents: `import { create } from "zustand"; export const useAppsStore = create(() => ({ list: { wallet: { id: "wallet", name: "Wallet" } } }));`,
          loader: "js",
          resolveDir: repo,
        }));
      },
    }, sassPlugin()],
  });
  const executablePath = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    process.env.CHROMIUM_PATH,
    "/run/current-system/sw/bin/google-chrome-stable",
    chromium.executablePath(),
    "/usr/bin/chromium",
  ].find(value => value && existsSync(value));
  expect(executablePath).toBeDefined();
  const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const origin = "https://aaaaa-aa.localhost:8000";
    await page.route("**/*", route => {
      if (route.request().url() === `${origin}/`) return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
      });
      if (route.request().url() === `${origin}/fixture.js`) return route.fulfill({
        contentType: "text/javascript",
        body: bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text,
      });
      if (route.request().url() === `${origin}/fixture.css`) return route.fulfill({
        contentType: "text/css",
        body: bundle.outputFiles.find(file => file.path.endsWith(".css"))!.text,
      });
      errors.push(`Unexpected network request: ${route.request().url()}`);
      return route.abort();
    });
    await page.goto(`${origin}/`);
    const dialog = page.locator('[data-tid="backend-call-dialog"]');
    const approve = page.locator('[data-tid="backend-call-approve"]');
    const cancel = page.locator('[data-tid="backend-call-reject"]');
    const acknowledgement = dialog.getByRole("checkbox");
    await dialog.waitFor({ timeout: 5_000 }).catch(error => {
      throw new Error(`${String(error)}; browser errors: ${errors.join("; ")}`);
    });
    expect(await dialog.getAttribute("role")).toBe("alertdialog");
    expect(await dialog.getAttribute("class")).toContain("dialog-danger");
    expect(await approve.getAttribute("class")).toContain("btn-danger");
    expect(await approve.isDisabled()).toBe(true);
    expect(await acknowledgement.isChecked()).toBe(false);
    expect(await cancel.evaluate(node => node === document.activeElement)).toBe(true);
    const text = await dialog.innerText();
    expect(text).toContain("Wallet");
    expect(text).toContain(destination);
    expect(text).toContain("deposit");
    expect(text).toMatch(/\b50(?:\.0+)?\s*T(?:CYCLES)?/);
    expect(text).toMatch(/\b55(?:\.0+)?\s*T(?:CYCLES)?/);
    expect(text).toMatch(/\b5(?:\.0+)?\s*T(?:CYCLES)?/);
    expect(await dialog.locator("details[open]").count()).toBe(0);
    expect(await page.evaluate(() => (window as any).fixture.snapshot().decisions)).toEqual([]);
    expect(await dialog.locator(".title").evaluate(node => getComputedStyle(node).color)).toBe("rgb(255, 145, 155)");
    for (const [name, width, height] of [["desktop", 1280, 900], ["mobile", 390, 844]] as const) {
      await page.setViewportSize({ width, height });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      expect(await acknowledgement.isChecked()).toBe(false);
      await page.screenshot({ path: `/tmp/neutron-owner-cycles-consent-${name}.png` });
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    // Pressing Enter while the safe default is focused must cancel, never spend.
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "detached" });
    expect(await page.evaluate(() => (window as any).fixture.snapshot())).toEqual({ pending: 0, attention: null, decisions: ["rejected"] });

    await page.evaluate(() => (window as any).fixture.open());
    await dialog.waitFor();
    expect(await approve.isDisabled()).toBe(true);
    const details = dialog.locator('details[data-tid="consent-technical-details"]');
    await details.locator("summary").click();
    expect(await details.innerText()).toContain(cycleCall.argsHex);
    expect(await details.innerText()).toContain(cycleCall.callCostAtoms);
    await details.locator("summary").click();
    await acknowledgement.check();
    expect(await approve.isEnabled()).toBe(true);
    await acknowledgement.uncheck();
    expect(await approve.isDisabled()).toBe(true);
    await acknowledgement.check();
    await approve.click();
    await dialog.waitFor({ state: "detached" });
    expect(await page.evaluate(() => (window as any).fixture.snapshot())).toEqual({ pending: 0, attention: null, decisions: ["rejected", "approved"] });

    // Approval of one large call is never a persistent app budget increase.
    await page.evaluate(() => (window as any).fixture.open());
    await dialog.waitFor();
    expect(await acknowledgement.isChecked()).toBe(false);
    expect(await approve.isDisabled()).toBe(true);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    expect(await page.evaluate(() => (window as any).fixture.snapshot())).toEqual({ pending: 0, attention: null, decisions: ["rejected", "approved", "rejected"] });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 30_000);
