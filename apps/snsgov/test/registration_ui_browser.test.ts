/** Regression tests for registration refusals and existing owner preferences. */
import { expect, test } from "bun:test";
import { chromium, type Page } from "@playwright/test";
import esbuild from "esbuild";
import { serve } from "bun";
import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Row {
  sns: string;
  governance: string;
  voting_enabled: boolean;
  agent_voting_enabled: boolean;
  label_text: string;
}
interface Fixture {
  rows: Row[];
  readError: boolean;
  upsertError: string | null;
  calls: { method: string; args: unknown[] }[];
  changed: number;
}
declare global {
  interface Window {
    __registrationTest: Fixture;
  }
}

const existing: Row = {
  sns: "root-a",
  governance: "governance-a",
  voting_enabled: false,
  agent_voting_enabled: true,
  label_text: "My DAO label",
};

async function buildHarness() {
  const modules: Record<string, string> = {
    kernel: `
      export async function querySelf(method, args) {
        const state = window.__registrationTest;
        state.calls.push({ method, args });
        if (state.readError) throw new Error("Config query unavailable");
        if (method === "snsgov_config") return { snses: state.rows.map(row => ({ ...row })) };
        return { principal: "aaaaa-aa", can_manage_neuron: true };
      }
      export async function updateSelf(method, args) {
        const state = window.__registrationTest;
        state.calls.push({ method, args });
        if (state.upsertError) throw new Error(state.upsertError);
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
      export async function relayManageNeuron(args) {
        window.__registrationTest.calls.push({ method: "relayManageNeuron", args: [args] });
        return { ok: false, errorMessage: "Governance refused the grant" };
      }
    `,
    governance: `
      export async function listNeurons() {
        return {
          neurons: [{ id: "00".repeat(32), permissions: [{ principal: "aaaaa-aa", permissions: [10] }] }],
          truncated: false,
        };
      }
    `,
    registry: `
      export async function getRegistry() {
        return { entries: ["a", "b"].map(id => ({
          label: "DAO " + id,
          liveness: { governance: true },
          canisters: { root: "root-" + id, governance: "governance-" + id },
        })) };
      }
      export function displayName(entry) { return entry.label; }
    `,
  };
  const built = await esbuild.build({
    absWorkingDir: appRoot,
    stdin: {
      contents: `
        import { createElement } from "react";
        import { createRoot } from "react-dom/client";
        import { SetupView } from "./src/ui/Setup";
        import { RegistrationButton } from "./src/ui/Registration";
        const container = document.createElement("main");
        document.body.appendChild(container);
        createRoot(container).render(location.pathname === "/setup"
          ? createElement(SetupView, { onBack() {} })
          : createElement(RegistrationButton, {
              target: { rootCanisterId: "root-a", governanceCanisterId: "governance-a", label: "DAO a" },
              onChanged() { window.__registrationTest.changed += 1; },
            }));
      `,
      loader: "tsx",
      resolveDir: appRoot,
    },
    bundle: true,
    format: "iife",
    jsx: "automatic",
    platform: "browser",
    write: false,
    plugins: [{
      name: "registration-transport-fixture",
      setup(build) {
        build.onResolve({ filter: /^neutron-tools\/app$/ }, () => ({ path: "kernel", namespace: "fixture" }));
        for (const name of ["relay", "registry", "governance"]) {
          build.onResolve({ filter: new RegExp("/(?:data/)?" + name + "$") }, () => ({ path: name, namespace: "fixture" }));
        }
        build.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({ contents: modules[path]!, loader: "ts" }));
      },
    }],
  });
  return built.outputFiles[0]!.text;
}

async function prepare(page: Page, readError = false) {
  // Fail at the stalled interaction, with Playwright's locator diagnostics,
  // instead of letting Bun's enclosing timeout hide the failing step.
  page.setDefaultTimeout(15_000);
  await page.addInitScript(({ row, fail }) => {
    window.__registrationTest = { rows: [row], readError: fail, upsertError: null, calls: [], changed: 0 };
  }, { row: existing, fail: readError });
}

function mutations(page: Page) {
  return page.evaluate(() => window.__registrationTest.calls.filter(call => call.method === "snsgov_sns_upsert"));
}

async function chromiumOptions(): Promise<{ executablePath?: string }> {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
    return { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE };
  }
  for (const executablePath of [
    "/run/current-system/sw/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ]) {
    try {
      await access(executablePath, constants.X_OK);
      return { executablePath };
    } catch {
      // Try the Nix wrapper or Playwright's installed browser below.
    }
  }
  const entries = await readdir("/nix/store").catch(() => []);
  for (const entry of entries.filter(name => /-chromium-\d/.test(name))) {
    const executablePath = `/nix/store/${entry}/bin/chromium`;
    try {
      await access(executablePath, constants.X_OK);
      return { executablePath };
    } catch {
      // A standard Playwright installation supplies its own browser below.
    }
  }
  return {};
}

test("registration retains grant failures and existing agent voting preference; closed read errors remain retryable", async () => {
  const bundle = await buildHarness();
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/bundle.js") return new Response(bundle, { headers: { "content-type": "text/javascript" } });
    return new Response('<!doctype html><html><body><script src="/bundle.js"></script></body></html>', { headers: { "content-type": "text/html" } });
  } });
  const browser = await chromium.launch({ headless: true, ...(await chromiumOptions()) });
  try {
    const page = await browser.newPage();
    await prepare(page);
    await page.goto(`http://127.0.0.1:${server.port}/registration`);
    await page.getByRole("button", { name: /click to allow voting/ }).click();
    await page.getByRole("alert").waitFor();
    expect(await page.getByRole("alert").textContent()).toContain("Governance refused the grant");
    expect(await page.evaluate(() => window.__registrationTest.changed)).toBe(1);
    const writes = await mutations(page);
    expect(writes).toHaveLength(1);
    expect((writes[0]!.args[0] as Row).agent_voting_enabled).toBe(true);
    expect(await page.evaluate(() => window.__registrationTest.calls.filter(call => call.method === "relayManageNeuron").length)).toBe(1);
    await page.close();

    const retry = await browser.newPage();
    await prepare(retry, true);
    await retry.goto(`http://127.0.0.1:${server.port}/registration`);
    await retry.getByRole("alert").waitFor();
    await retry.getByRole("button", { name: "Close", exact: true }).click();
    await retry.evaluate(() => { window.__registrationTest.readError = false; });
    await retry.getByRole("button", { name: "Retry checking your neurons", exact: true }).click();
    await retry.getByRole("button", { name: /click to allow voting/ }).waitFor();
    expect(await retry.getByRole("alert").count()).toBe(0);
    expect(await mutations(retry)).toHaveLength(0);
  } finally {
    await browser.close();
    server.stop(true);
  }
}, 60_000);

test("Setup stops a refused bulk registration, preserves saved preferences, and recovers from a failed initial read", async () => {
  const bundle = await buildHarness();
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/bundle.js") return new Response(bundle, { headers: { "content-type": "text/javascript" } });
    return new Response('<!doctype html><html><body><script src="/bundle.js"></script></body></html>', { headers: { "content-type": "text/html" } });
  } });
  const browser = await chromium.launch({ headless: true, ...(await chromiumOptions()) });
  try {
    const page = await browser.newPage();
    await prepare(page);
    await page.goto(`http://127.0.0.1:${server.port}/setup`);
    await page.getByRole("button", { name: "Scan every SNS for neurons that name your principal", exact: true }).click();
    await page.evaluate(() => { window.__registrationTest.upsertError = "Owner refused registration"; });
    await page.getByRole("button", { name: "Allow voting for 2 SNSes", exact: true }).click();
    await page.getByRole("alert").waitFor();
    expect(await page.getByRole("alert").textContent()).toContain("Owner refused registration");
    expect(await mutations(page)).toHaveLength(1);
    await page.evaluate(() => { window.__registrationTest.upsertError = null; });
    await page.getByRole("button", { name: "Allow voting for 2 SNSes", exact: true }).click();
    await page.getByRole("button", { name: "All allowed", exact: true }).waitFor();
    const writes = await mutations(page);
    expect(writes).toHaveLength(3);
    expect((writes[1]!.args[0] as Row).agent_voting_enabled).toBe(true);
    expect((writes[1]!.args[0] as Row).label_text).toBe("My DAO label");
    expect((writes[2]!.args[0] as Row).agent_voting_enabled).toBe(false);
    expect(await page.getByRole("alert").count()).toBe(0);
    await page.close();

    const retry = await browser.newPage();
    await prepare(retry, true);
    await retry.goto(`http://127.0.0.1:${server.port}/setup`);
    await retry.getByRole("alert").waitFor();
    expect(await retry.locator('[aria-busy="true"]').count()).toBe(0);
    await retry.evaluate(() => { window.__registrationTest.readError = false; });
    await retry.getByRole("button", { name: "Refresh setup", exact: true }).click();
    await retry.getByRole("checkbox", { name: "Allow agent voting for My DAO label", exact: true }).waitFor();
    expect(await retry.getByRole("alert").count()).toBe(0);
    expect(await mutations(retry)).toHaveLength(0);
  } finally {
    await browser.close();
    server.stop(true);
  }
}, 60_000);
