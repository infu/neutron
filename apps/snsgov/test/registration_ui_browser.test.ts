/** Real UI regression coverage with only network and resident tools replaced. */
import { expect, test } from "bun:test";
import { chromium, type Page } from "@playwright/test";
import esbuild from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import { serve } from "bun";
import { constants } from "node:fs";
import { access, mkdir, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
interface Row { sns: string; governance: string; voting_enabled: boolean; agent_voting_enabled: boolean; label_text: string }
interface Fixture {
  rows: Row[]; readError: boolean; upsertError: string | null; calls: { method: string; args: unknown[] }[];
  changed: number; failedGovernance: string[]; permissions: number[]; grantable: number[]; invokeError: boolean;
  outcome: "completed" | "rejected" | "pending"; cycleError: boolean;
}
declare global { interface Window { __registrationTest: Fixture } }
const existing: Row = { sns: "root-a", governance: "governance-a", voting_enabled: false, agent_voting_enabled: true, label_text: "My DAO label" };
const principal = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const longId = "f7crg-kabae-waaiy-aaaaa-aaaaa-aaaaa-aaaaa-aaaaa-aaaaa-aaaaa-aaaaa-aae";

async function buildHarness() {
  const modules: Record<string, string> = {
    kernel: `
      export async function querySelf(method, args) {
        const state = window.__registrationTest;
        state.calls.push({ method, args });
        if (state.readError) throw new Error("Config query unavailable");
        if (method === "snsgov_config") return { snses: state.rows.map(row => ({ ...row })) };
        return { principal: "${principal}", can_manage_neuron: true };
      }
      export async function updateSelf(method, args) {
        const state = window.__registrationTest;
        state.calls.push({ method, args });
        if (state.upsertError) throw new Error(state.upsertError);
        if (method === "snsgov_sns_remove") { state.rows = state.rows.filter(row => row.sns !== args[0]); return {}; }
        const index = state.rows.findIndex(row => row.sns === args[0].sns);
        if (index < 0) state.rows.push(args[0]); else state.rows[index] = args[0];
        return {};
      }
      export async function copyToClipboard() {}
    `,
    relay: `
      import { querySelf } from "neutron-tools/app";
      export async function readHotkey() {
        const value = await querySelf("snsgov_hotkey", [null]);
        return { principal: value.principal, canManageNeuron: value.can_manage_neuron };
      }
    `,
    governance: `
      export async function listAllNeurons(governance) {
        const state = window.__registrationTest;
        state.calls.push({ method: "listAllNeurons", args: [governance] });
        if (state.failedGovernance.includes(governance)) throw new Error("Neuron reads unavailable for " + governance);
        return { neurons: [{ id: "00".repeat(32), permissions: [{ principal: "${principal}", permissions: state.permissions }] }], truncated: false, failures: [] };
      }
      export async function readParameters() { return { neuronGrantablePermissions: window.__registrationTest.grantable }; }
    `,
    actions_client: `
      let next = 0;
      export function operationId() { return "operation-" + (++next); }
      export async function invoke(method, args) {
        const state = window.__registrationTest;
        state.calls.push({ method, args: [args] });
        if (state.invokeError) throw new Error("Reply interrupted");
        return { operationId: args.operationId, status: state.outcome,
          message: state.outcome === "rejected" ? "Governance refused the grant" : undefined,
          outcomes: [{ stepId: "command", outcome: { ok: state.outcome === "completed", errorMessage: state.outcome === "rejected" ? "Governance refused the grant" : undefined } }] };
      }
    `,
    registry: `
      export async function getRegistry() { return { entries: ["a", "b"].map(id => ({ label: "DAO " + id, liveness: { governance: true }, canisters: { root: "root-" + id, governance: "governance-" + id } })) }; }
      export function displayName(entry) { return entry.label; }
    `,
    root: `
      export async function listSnsCanisters() { return [{ canisterId: "${longId}", role: "governance" }, { canisterId: "root-a", role: "root" }]; }
      export async function readCanistersCycles() {
        const state = window.__registrationTest;
        state.calls.push({ method: "readCanistersCycles", args: [] });
        if (state.cycleError) throw new Error("Cycle read unavailable");
        return [{ canisterId: "${longId}", cycles: 12000000000000n, status: "running", memorySize: 1234n }, { canisterId: "root-a" }];
      }
      export function formatTCycles(value) { return String(value / 1000000000000n) + "T"; }
    `,
  };
  const built = await esbuild.build({
    absWorkingDir: appRoot,
    stdin: { contents: `
      import { createElement } from "react";
      import { createRoot } from "react-dom/client";
      import { SetupView } from "./src/ui/Setup";
      import { RegistrationButton } from "./src/ui/Registration";
      import { CanistersView } from "./src/ui/Canisters";
      import "./src/style.scss";
      const container = document.createElement("main");
      container.className = "nt-app nt-app--fill snsgov-app";
      document.body.appendChild(container);
      const shell = document.createElement("div");
      shell.className = "snsgov-shell";
      container.appendChild(shell);
      createRoot(shell).render(location.pathname === "/setup" ? createElement(SetupView, { onBack() {} })
        : location.pathname === "/canisters" ? createElement(CanistersView, { rootCanisterId: "root-a" })
        : createElement(RegistrationButton, { target: { rootCanisterId: "root-a", governanceCanisterId: "governance-a", label: "DAO a" }, onChanged() { window.__registrationTest.changed += 1; } }));
    `, loader: "tsx", resolveDir: appRoot },
    bundle: true, format: "iife", jsx: "automatic", platform: "browser", write: false, outdir: "browser-test-dist",
    plugins: [{ name: "registration-fixture", setup(build) {
      build.onResolve({ filter: /^neutron-tools\/app$/ }, () => ({ path: "kernel", namespace: "fixture" }));
      for (const name of ["relay", "registry", "governance", "actions_client", "root"]) {
        build.onResolve({ filter: new RegExp("/(?:data/)?" + name + "$") }, () => ({ path: name, namespace: "fixture" }));
      }
      build.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({ contents: modules[path]!, loader: "ts" }));
    } }, sassPlugin()],
  });
  return { script: built.outputFiles.find(file => file.path.endsWith(".js"))!.text, css: built.outputFiles.find(file => file.path.endsWith(".css"))!.text };
}

async function runBrowser(run: (page: Page, url: string) => Promise<void>) {
  const bundle = await buildHarness();
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/bundle.js") return new Response(bundle.script, { headers: { "content-type": "text/javascript" } });
    if (new URL(request.url).pathname === "/sandbox") return new Response(
      '<!doctype html><html><body style="margin:0"><iframe title="SNS Gov settings" sandbox="allow-scripts allow-same-origin" src="/setup" style="display:block;border:0;width:320px;height:800px"></iframe></body></html>',
      { headers: { "content-type": "text/html" } },
    );
    return new Response(`<!doctype html><html><head><style>html,body{margin:0}${bundle.css}</style></head><body><script src="/bundle.js"></script></body></html>`, { headers: { "content-type": "text/html" } });
  } });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true, timeout: 15_000, ...(await chromiumOptions()) });
    const page = await browser.newPage({ viewport: { width: 320, height: 800 } });
    page.setDefaultTimeout(8_000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    await prepare(page);
    await run(page, `http://127.0.0.1:${server.port}`);
    expect(errors).toEqual([]);
  } finally { server.stop(true); await browser?.close(); }
}

async function prepare(page: Page) {
  await page.addInitScript(row => {
    window.__registrationTest = { rows: [row], readError: false, upsertError: null, calls: [], changed: 0,
      failedGovernance: [], permissions: [10], grantable: [3, 4], invokeError: false, outcome: "rejected", cycleError: false };
  }, existing);
}
function mutations(page: Page) { return page.evaluate(() => window.__registrationTest.calls.filter(call => call.method === "snsgov_sns_upsert")); }
async function openAccess(page: Page) { await page.locator("summary").filter({ hasText: /Voting access/ }).click(); }

async function chromiumOptions(): Promise<{ executablePath?: string }> {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE };
  for (const executablePath of ["/run/current-system/sw/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium"]) {
    try { await access(executablePath, constants.X_OK); return { executablePath }; } catch {}
  }
  const entries = await readdir("/nix/store").catch(() => []);
  for (const entry of entries.filter(name => /-chromium-\d/.test(name))) {
    const executablePath = `/nix/store/${entry}/bin/chromium`;
    try { await access(executablePath, constants.X_OK); return { executablePath }; } catch {}
  }
  return {};
}

test("Voting access opens without writes; explicit actions preserve preferences and use the resident grant tool", async () => {
  await runBrowser(async (page, url) => {
    await page.goto(`${url}/registration`);
    await openAccess(page);
    await page.getByRole("button", { name: "Connect DAO a", exact: true }).waitFor();
    expect(await mutations(page)).toHaveLength(0);
    expect(await page.evaluate(() => window.__registrationTest.calls.some(call => call.method === "sns_manage_neuron_v1"))).toBe(false);
    await page.getByRole("button", { name: "Connect DAO a", exact: true }).click();
    await page.getByText("This community is connected.", { exact: false }).waitFor();
    const writes = await mutations(page);
    expect(writes).toHaveLength(1);
    expect((writes[0]!.args[0] as Row).agent_voting_enabled).toBe(true);
    expect((writes[0]!.args[0] as Row).label_text).toBe("My DAO label");
    await page.locator("summary").filter({ hasText: /Neuron permissions/ }).click();
    await page.getByRole("button", { name: "Add SubmitProposal and Vote", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Governance refused the grant" }).waitFor();
    const grants = await page.evaluate(() => window.__registrationTest.calls.filter(call => call.method === "sns_manage_neuron_v1"));
    expect(grants).toHaveLength(1);
    expect(grants[0]!.args[0]).toEqual({ operationId: "operation-1", rootCanisterId: "root-a", neuronId: "00".repeat(32),
      command: { AddNeuronPermissions: { principal_id: principal, permissions_to_add: { permissions: [3, 4] } } } });
    expect(await page.evaluate(() => window.__registrationTest.changed)).toBe(2);
  });
}, 40_000);

test("supporting actions work in a narrow sandboxed iframe without form permission", async () => {
  await runBrowser(async (page, url) => {
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.goto(`${url}/sandbox`);
    expect(await page.locator("iframe").getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    const frame = page.frame({ url: `${url}/setup` })!;
    await frame.getByRole("heading", { name: "Connections & settings", exact: true }).waitFor();
    expect(await frame.evaluate(() => innerWidth)).toBe(320);
    const connection = frame.getByRole("checkbox", { name: "Connection for My DAO label", exact: true });
    await connection.click();
    await frame.getByText("Connected", { exact: true }).waitFor();
    const writes = await frame.evaluate(() => window.__registrationTest.calls.filter(call => call.method === "snsgov_sns_upsert"));
    expect(writes).toHaveLength(1);
    expect(writes[0]!.args[0]).toEqual({ ...existing, voting_enabled: true });

    expect(await frame.getByRole("checkbox", { name: "Legacy agent voting for My DAO label", exact: true }).count()).toBe(0);
    const compatibility = frame.locator("summary").filter({ hasText: /Legacy relay compatibility/ });
    await compatibility.focus();
    await compatibility.press("Enter");
    expect(await frame.getByRole("checkbox", { name: "Legacy agent voting for My DAO label", exact: true }).isChecked()).toBe(true);
    const help = frame.getByRole("button", { name: "About legacy agent voting in My DAO label", exact: true });
    await help.focus();
    await help.press("Space");
    await frame.getByRole("tooltip").waitFor();
    const bounds = await frame.getByRole("tooltip").evaluate(element => ({ left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right }));
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(320);
    await help.press("Escape");
    expect(await frame.getByRole("tooltip").count()).toBe(0);
    expect(await help.evaluate(element => document.activeElement === element)).toBe(true);

    await frame.goto(`${url}/canisters`);
    await frame.getByRole("button", { name: "Read cycles", exact: true }).waitFor();
    expect(await frame.evaluate(() => window.__registrationTest.calls.filter(call => call.method === "readCanistersCycles" || call.method === "sns_governance_recovery_v1"))).toHaveLength(0);
    await frame.getByRole("button", { name: "Read cycles", exact: true }).click();
    await frame.getByText("12T across 1 canister with a known balance", { exact: false }).waitFor();
    const maintenance = frame.locator("summary").filter({ hasText: /Governance maintenance/ });
    await maintenance.focus();
    await maintenance.press("Enter");
    expect(await frame.evaluate(() => window.__registrationTest.calls.filter(call => call.method === "sns_governance_recovery_v1"))).toHaveLength(0);
    await frame.getByRole("button", { name: "Check stuck upgrade", exact: true }).click();
    await frame.getByText("Check stuck upgrade: rejected.", { exact: true }).waitFor();
    const recovery = await frame.evaluate(() => window.__registrationTest.calls.filter(call => call.method === "sns_governance_recovery_v1"));
    expect(recovery).toHaveLength(1);
    expect(recovery[0]!.args[0]).toEqual({ operationId: "operation-1", rootCanisterId: "root-a", method: "fail_stuck_upgrade_in_progress" });
    expect(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}, 40_000);

test("Vote-only access is counted separately and interrupted grants retain the saved operation", async () => {
  await runBrowser(async (page, url) => {
    await page.goto(`${url}/registration`);
    await page.evaluate(() => { const state = window.__registrationTest; state.permissions = [4]; state.rows[0]!.voting_enabled = true; });
    await openAccess(page);
    await page.getByText("1 neuron can vote · 0 can propose.", { exact: true }).waitFor();
    await page.evaluate(() => { const state = window.__registrationTest; state.permissions = [10]; state.grantable = [4]; state.invokeError = true; });
    await page.getByRole("button", { name: "Refresh access", exact: true }).click();
    await page.locator("summary").filter({ hasText: /Neuron permissions/ }).click();
    await page.getByRole("button", { name: "Add Vote", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Reply interrupted" }).waitFor();
    expect(await page.getByRole("button", { name: "Add Vote", exact: true }).count()).toBe(0);
    await page.evaluate(() => { window.__registrationTest.invokeError = false; window.__registrationTest.outcome = "completed"; });
    await page.getByRole("button", { name: "Check saved status", exact: true }).click();
    await page.getByText("Permission change confirmed.", { exact: true }).waitFor();
    const calls = await page.evaluate(() => window.__registrationTest.calls.filter(call => call.method.startsWith("sns_")));
    expect(calls.map(call => call.method)).toEqual(["sns_manage_neuron_v1", "sns_operation_status_v1"]);
    expect(calls[1]!.args[0]).toEqual({ operationId: "operation-1" });
  });
}, 40_000);

test("Failed access reads retry without writes and refresh failures preserve existing access", async () => {
  await runBrowser(async (page, url) => {
    await page.goto(`${url}/registration`);
    await page.evaluate(() => { window.__registrationTest.readError = true; });
    await openAccess(page);
    await page.getByRole("alert").filter({ hasText: "Config query unavailable" }).waitFor();
    await page.evaluate(() => { window.__registrationTest.readError = false; });
    await page.getByRole("button", { name: "Refresh access", exact: true }).click();
    await page.getByRole("button", { name: "Connect DAO a", exact: true }).waitFor();
    await page.evaluate(() => { window.__registrationTest.readError = true; });
    await page.getByRole("button", { name: "Refresh access", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Config query unavailable" }).waitFor();
    expect(await page.getByRole("button", { name: "Connect DAO a", exact: true }).isVisible()).toBe(true);
    expect(await mutations(page)).toHaveLength(0);
  });
}, 40_000);

test("Neuron scan reports partial reads, retries failed communities only, and stops refused bulk connections", async () => {
  await runBrowser(async (page, url) => {
    await page.goto(`${url}/setup`);
    await page.getByRole("button", { name: "Find my neurons", exact: true }).waitFor();
    await page.evaluate(() => { window.__registrationTest.failedGovernance = ["governance-b"]; });
    await page.getByRole("button", { name: "Find my neurons", exact: true }).click();
    await page.getByText("Some community reads failed.", { exact: false }).waitFor();
    expect(await page.getByRole("list", { name: "Discovered neurons" }).getByText("DAO a", { exact: true }).isVisible()).toBe(true);
    await page.evaluate(() => { window.__registrationTest.failedGovernance = []; });
    await page.getByRole("button", { name: "Retry failed communities", exact: true }).click();
    await page.getByRole("button", { name: "Connect 2 communities", exact: true }).waitFor();
    const scans = await page.evaluate(() => window.__registrationTest.calls.filter(call => call.method === "listAllNeurons").map(call => call.args[0]));
    expect(scans).toEqual(["governance-a", "governance-b", "governance-b"]);
    await page.evaluate(() => { window.__registrationTest.upsertError = "Owner refused registration"; });
    await page.getByRole("button", { name: "Connect 2 communities", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Owner refused registration" }).waitFor();
    expect(await mutations(page)).toHaveLength(1);
    await page.evaluate(() => { window.__registrationTest.upsertError = null; });
    await page.getByRole("button", { name: "Connect 2 communities", exact: true }).click();
    await page.getByRole("checkbox", { name: "Connection for DAO b", exact: true }).waitFor();
    const writes = await mutations(page);
    expect(writes).toHaveLength(3);
    expect((writes[1]!.args[0] as Row).agent_voting_enabled).toBe(true);
    expect((writes[1]!.args[0] as Row).label_text).toBe("My DAO label");
    expect((writes[2]!.args[0] as Row).agent_voting_enabled).toBe(false);
    expect(await page.getByRole("alert").count()).toBe(0);
  });
}, 40_000);

test("Canister IDs wrap; cycles reads are explicit, report unknown balances, and preserve prior results on failure", async () => {
  await runBrowser(async (page, url) => {
    await page.goto(`${url}/canisters`);
    await page.getByRole("button", { name: "Read cycles", exact: true }).waitFor();
    expect(await page.evaluate(() => window.__registrationTest.calls.filter(call => call.method === "readCanistersCycles"))).toHaveLength(0);
    expect(await page.getByText(longId, { exact: true }).textContent()).toBe(longId);
    const geometry = await page.getByText(longId, { exact: true }).evaluate(element => ({ width: element.getBoundingClientRect().width, scroll: element.scrollWidth, client: element.clientWidth }));
    expect(geometry.width).toBeGreaterThan(120);
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
    await page.getByRole("button", { name: "Read cycles", exact: true }).click();
    await page.getByText("Balances are unavailable for 1 canister.", { exact: false }).waitFor();
    await page.getByText("12T across 1 canister with a known balance", { exact: false }).waitFor();
    await page.evaluate(() => { window.__registrationTest.cycleError = true; });
    await page.getByRole("button", { name: "Refresh cycles", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Cycle read unavailable" }).waitFor();
    expect(await page.getByText("12T across 1 canister with a known balance", { exact: false }).isVisible()).toBe(true);
    await page.locator("summary").filter({ hasText: /Governance maintenance/ }).click();
    expect(await page.evaluate(() => window.__registrationTest.calls.some(call => call.method === "sns_governance_recovery_v1"))).toBe(false);
    await page.getByRole("button", { name: "Check stuck upgrade", exact: true }).click();
    const calls = await page.evaluate(() => window.__registrationTest.calls.filter(call => call.method === "sns_governance_recovery_v1"));
    expect(calls[0]!.args[0]).toEqual({ operationId: "operation-1", rootCanisterId: "root-a", method: "fail_stuck_upgrade_in_progress" });
  });
}, 40_000);

test("Settings recovers a failed initial read, and an all-failed scan never claims the account is empty", async () => {
  await runBrowser(async (page, url) => {
    await page.addInitScript(() => { window.__registrationTest.readError = true; });
    await page.goto(`${url}/setup`);
    await page.getByRole("alert").filter({ hasText: "Config query unavailable" }).first().waitFor();
    expect(await page.getByRole("button", { name: "Find my neurons", exact: true }).isDisabled()).toBe(true);
    await page.evaluate(() => { window.__registrationTest.readError = false; });
    await page.getByRole("button", { name: "Refresh settings", exact: true }).click();
    await page.getByRole("checkbox", { name: "Connection for My DAO label", exact: true }).waitFor();
    expect(await page.getByRole("alert").count()).toBe(0);
    expect(await mutations(page)).toHaveLength(0);
    expect(await page.getByRole("checkbox", { name: "Legacy agent voting for My DAO label", exact: true }).count()).toBe(0);
    await page.locator("summary").filter({ hasText: /Legacy relay compatibility/ }).click();
    const legacy = page.getByRole("checkbox", { name: "Legacy agent voting for My DAO label", exact: true });
    expect(await legacy.isChecked()).toBe(true);
    expect(await page.getByText("Current tools follow Kernel mode and owner reviews.", { exact: false }).isVisible()).toBe(true);
    const labelWidths = await page.locator(".snsgov-setting-toggle > span").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width));
    expect(labelWidths.every(width => width > 35)).toBe(true);
    await page.evaluate(() => { window.__registrationTest.failedGovernance = ["governance-a", "governance-b"]; });
    await page.getByRole("button", { name: "Find my neurons", exact: true }).click();
    await page.getByText("No neurons found in the available results. Retry the failed communities to finish checking.", { exact: true }).waitFor();
    expect(await page.getByText("No connected neurons found.", { exact: false }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "Retry failed communities", exact: true }).isVisible()).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}, 40_000);

if (process.env.SNSGOV_UI_EVIDENCE_DIR) test("supporting screens retain visual evidence at narrow and wide widths", async () => {
  const directory = resolve(process.env.SNSGOV_UI_EVIDENCE_DIR!);
  await mkdir(directory, { recursive: true });
  await runBrowser(async (page, url) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const width of [320, 960]) {
      await page.setViewportSize({ width, height: width === 320 ? 800 : 700 });
      await page.goto(`${url}/setup`);
      await page.getByRole("button", { name: "Find my neurons", exact: true }).click();
      await page.getByRole("list", { name: "Discovered neurons" }).waitFor();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: resolve(directory, `settings-${width}.png`), fullPage: true });
      await page.locator("summary").filter({ hasText: /Voting access/ }).first().click();
      await page.getByRole("button", { name: "Connect My DAO label", exact: true }).waitFor();
      await page.locator("summary").filter({ hasText: /Neuron permissions/ }).first().click();
      await page.screenshot({ path: resolve(directory, `voting-access-${width}.png`), fullPage: true });
      await page.goto(`${url}/canisters`);
      await page.getByRole("button", { name: "Read cycles", exact: true }).click();
      await page.getByText("12T across 1 canister with a known balance", { exact: false }).waitFor();
      await page.screenshot({ path: resolve(directory, `canisters-${width}.png`), fullPage: true });
      await page.locator("summary").filter({ hasText: /Governance maintenance/ }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: resolve(directory, `governance-maintenance-${width}.png`), fullPage: true });
    }
  });
}, 40_000);
