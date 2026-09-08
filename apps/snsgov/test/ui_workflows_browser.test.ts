import { expect, test } from "bun:test";
import { chromium, type Page } from "@playwright/test";
import esbuild from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import { serve } from "bun";
import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Only the data/Kernel boundary is replaced. The real components, formatting,
// event handlers and stylesheet run in Chromium; no governance writes occur.
const boundary = `
  export const calls = globalThis.__uiCalls = [];
  export const pending = globalThis.__uiPending = {};
  export const entry = { canisters: { root: "extk7-gaaaa-aaaaq-aacda-cai",
    governance: "eqsml-lyaaa-aaaaq-aacdq-cai", ledger: "extk7-gaaaa-aaaaq-aacea-cai",
    swap: null, index: null }, liveness: { governance: true, ledger: true },
    metadata: { name: "A DAO with a long descriptive name" }, fetchedAt: 0, lifecycle: "committed" };
  const neuronA = "11".repeat(32), neuronB = "22".repeat(32);
  export const drafts = [
    { id: "1", sns: entry.canisters.root, governance: "dao-a", title: "First draft",
      summary: "First review", url: "", actionKind: "Motion", motionText: "First motion",
      createdBy: "agent", updatedAtSeconds: 1n },
    { id: "2", sns: entry.canisters.root, governance: "dao-b", title: "Second draft",
      summary: "Second review", url: "", actionKind: "Motion", motionText: "Second motion",
      createdBy: "agent", updatedAtSeconds: 2n },
    { id: "3", sns: entry.canisters.root, governance: "dao-b", title: "Ineligible preset",
      summary: "No matching proposer", url: "", actionKind: "Motion", motionText: "Third motion",
      proposer: Uint8Array.from({ length: 32 }, () => 0x11), createdBy: "agent", updatedAtSeconds: 3n },
    { id: "4", sns: entry.canisters.root, governance: "dao-error", title: "Unavailable registration",
      summary: "Read failed", url: "", actionKind: "Motion", motionText: "Fourth motion",
      createdBy: "agent", updatedAtSeconds: 4n }
  ];
  export const listDrafts = async () => drafts;
  export const canPropose = missing => !missing.includes(3);
  export const deleteDraft = async id => { calls.push({ kind: "delete", id }); };
  export const sendDraft = async (draft, neuronId) => {
    calls.push({ kind: "send", id: draft.id, neuronId });
    return { proposalId: 42n, cleanupWarning: "Draft removal failed; do not send it again." };
  };
  export const readHotkey = async () => ({ principal: "aaaaa-aa", canManageNeuron: true });
  export const readRegistration = async governance => {
    if (governance === "dao-error") throw Error("Registration unavailable");
    const id = governance === "dao-b" ? neuronB : neuronA;
    return { found: [{ neuronId: id, readiness: "ready", missing: [] }], ready: 1,
      repairable: [], blocked: [], truncated: false };
  };
  export const describeRegistration = () => "Voting access";
  export const scanForNeurons = async () => [];
  export const relayManageNeuron = async () => { throw Error("Unexpected governance mutation"); };
  export const getProposal = async (_governance, id) => {
    if (id === 2n) await new Promise(resolve => pending.proposal = resolve);
    return { id, title: "Proposal title " + id, summary: "Proposal body " + id,
      status: "open", actionKind: "Motion", createdAtSeconds: 0n, rejectCostE8s: 123456789n, ballots: [] };
  };
  export const listProposals = async () => ({ proposals: [{ id: 1n, title: "Proposal title 1",
    summary: "", url: "", status: "open", actionKind: "Motion", createdAtSeconds: 0n }] });
  export const listNeurons = async (_governance, options) => {
    calls.push({ kind: "neurons", principal: options.ofPrincipal ?? null });
    if (options.ofPrincipal === "slow-principal") await new Promise(resolve => pending.neurons = resolve);
    return { neurons: [{ id: (options.ofPrincipal ? "33" : "44").repeat(32), stakeE8s: 123456789n,
      maturityE8s: 0n, stakedMaturityE8s: 0n, votingPowerMultiplierPercent: 100n,
      createdAtSeconds: 0n, agingSinceSeconds: 0n, permissions: [] }], truncated: false };
  };
  export const listNervousSystemFunctions = async () => { throw Error("Functions unavailable"); };
  export const maxVotingPeriodExtensionSeconds = () => undefined;
  export const uncategorizedFunctions = () => [];
  export const readMode = async () => 1;
  export const readParameters = async () => ({ rejectCostE8s: 123456789n, neuronMinimumStakeE8s: 987654321n });
  export const readTreasuries = async () => ({ tokenE8s: 123456789n, icpE8s: 100000000n });
  export const listSnsCanisters = async () => [{ canisterId: entry.canisters.root, role: "root" }];
  export const readCanistersCycles = async () => {
    calls.push({ kind: "cycles" });
    return [{ canisterId: entry.canisters.root, cycles: 12345678000000000n, status: "running" }];
  };
  export const formatTCycles = () => "12,345.678 T";
  export const requireEntry = async () => entry;
  export const displayName = value => value.metadata.name;
  export const getRegistry = async () => {
    if (globalThis.__provisional) await new Promise(resolve => pending.registry = resolve);
    return { entries: [entry], fetchedAt: 0 };
  };
  export const peekRegistry = () => undefined;
  export const getProvisionalRegistry = async () => globalThis.__provisional
    ? { entries: [{ ...entry, liveness: { governance: false, ledger: false } }], fetchedAt: 0, livenessKnown: false }
    : undefined;
  export const querySelf = async method => method === "snsgov_config" ? { snses: [] } : {};
  export const updateSelf = async () => { throw Error("Unexpected Kernel mutation"); };
  export const copyToClipboard = async () => {};
  export const onTileViewRequest = () => () => {};
`;

async function runBrowser(run: (page: Page) => Promise<void>) {
  const built = await esbuild.build({
    absWorkingDir: appRoot,
    stdin: {
      contents: `
        import { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { DraftsView } from "./src/ui/Drafts";
        import { ProposalsView } from "./src/ui/Proposals";
        import { NeuronsView } from "./src/ui/Neurons";
        import { SnsDetailView } from "./src/ui/SnsDetail";
        import { CanistersView } from "./src/ui/Canisters";
        import { App } from "./src/index";
        import { entry } from "test:boundary";
        import "./src/style.scss";
        function Harness() {
          const [view, setView] = useState({ kind: "drafts", draft: "1" });
          globalThis.__showUi = setView;
          return <main className="nt-app nt-app--fill snsgov-app">
            {view.kind === "drafts" ? <DraftsView focusDraftId={view.draft} onBack={() => {}} />
              : view.kind === "proposals" ? <div className="nt-page"><section className="nt-page-main">
                <ProposalsView entry={entry} initialProposalId={view.id == null ? undefined : BigInt(view.id)} />
                </section></div>
              : view.kind === "neurons" ? <div className="nt-page"><section className="nt-page-main">
                <NeuronsView entry={entry} /></section></div>
              : view.kind === "canisters" ? <div className="nt-page"><section className="nt-page-main">
                <CanistersView rootCanisterId={entry.canisters.root} /></section></div>
              : view.kind === "list" ? <App />
              : <SnsDetailView rootCanisterId={entry.canisters.root} initialTab={view.tab} onBack={() => {}} />}
          </main>;
        }
        createRoot(document.getElementById("fixture")).render(<Harness />);
      `,
      resolveDir: appRoot,
      sourcefile: "ui-workflow-harness.tsx",
      loader: "tsx",
    },
    bundle: true,
    format: "esm",
    jsx: "automatic",
    outdir: "browser-test-dist",
    write: false,
    plugins: [{
      name: "controlled-boundary",
      setup(build) {
        build.onResolve({ filter: /^(?:neutron-tools\/app|test:boundary)$|\/data\/(?:drafts|governance|registration|registry|relay|ledger|root)$/ }, () => ({
          path: "boundary", namespace: "controlled-boundary",
        }));
        build.onLoad({ filter: /.*/, namespace: "controlled-boundary" }, () => ({ contents: boundary, loader: "ts" }));
      },
    }, sassPlugin()],
  });
  const bundle = built.outputFiles!.find(file => file.path.endsWith(".js"))!.text;
  const css = built.outputFiles!.find(file => file.path.endsWith(".css"))!.text;
  const server = serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/bundle.js") return new Response(bundle, { headers: { "content-type": "text/javascript" } });
      return new Response(`<html><head><meta charset="utf-8"><style>html,body{margin:0}</style><style>${css}</style></head><body><div id="fixture"></div><script type="module" src="/bundle.js"></script></body></html>`, { headers: { "content-type": "text/html" } });
    },
  });
  const browser = await chromium.launch({ headless: true, ...await chromiumOptions() });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 800 } });
    const crashes: string[] = [];
    page.on("pageerror", error => crashes.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.port}`);
    await page.getByRole("heading", { name: "First draft", exact: true }).waitFor();
    await run(page);
    expect(crashes).toEqual([]);
  } finally {
    await browser.close();
    server.stop(true);
  }
}

async function show(page: Page, value: object) {
  await page.evaluate(value => (globalThis as any).__showUi(value), value);
}

test("provisional registry rows are not labelled inactive before liveness is known", async () => {
  await runBrowser(async page => {
    await page.evaluate(() => { (globalThis as any).__provisional = true; });
    await show(page, { kind: "list" });
    await page.locator(".snsgov-table--snses tbody tr").waitFor();
    expect(await page.getByText("inactive", { exact: true }).count()).toBe(0);
    expect(await page.getByText("inactive hidden", { exact: false }).count()).toBe(0);
    await page.evaluate(() => (globalThis as any).__uiPending.registry());
    await page.getByRole("button", { name: "Refresh", exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "Refresh", exact: true }).isEnabled()).toBe(true);
  });
}, 120_000);

test("draft retargeting requires reviewing the new draft and selecting its own eligible neuron", async () => {
  await runBrowser(async page => {
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByRole("button", { name: "Confirm — put this on-chain" }).waitFor();
    await show(page, { kind: "drafts", draft: "2" });
    await page.getByRole("heading", { name: "Second draft", exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector<HTMLSelectElement>("#snsgov-proposer")?.value === "22".repeat(32));
    expect(await page.getByRole("button", { name: "Confirm — put this on-chain" }).count()).toBe(0);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByRole("button", { name: "Confirm — put this on-chain" }).click();
    expect(await page.evaluate(() => (globalThis as any).__uiCalls.filter((call: any) => call.kind === "send"))).toEqual([
      { kind: "send", id: "2", neuronId: "22".repeat(32) },
    ]);
    await page.getByText("Draft removal failed; do not send it again.", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "Second draft", exact: true }).count()).toBe(0);

    await show(page, { kind: "drafts", draft: "3" });
    await page.getByRole("heading", { name: "Ineligible preset", exact: true }).waitFor();
    await page.getByLabel("Neuron to propose with").waitFor();
    expect(await page.getByRole("button", { name: "Send", exact: true }).isDisabled()).toBe(true);
    await page.getByLabel("Neuron to propose with").selectOption("22".repeat(32));
    expect(await page.getByRole("button", { name: "Send", exact: true }).isEnabled()).toBe(true);
  });
}, 120_000);

test("an unavailable proposer lookup stops its loading state", async () => {
  await runBrowser(async page => {
    await show(page, { kind: "drafts", draft: "4" });
    await page.getByRole("alert").filter({ hasText: "Registration unavailable" }).waitFor();
    expect(await page.getByRole("status", { name: "Finding neurons that may propose" }).count()).toBe(0);
    expect(await page.getByText("No neuron on this SNS grants", { exact: false }).count()).toBe(0);
  });
}, 120_000);

test("proposal navigation never labels the previous proposal with the new ID and can return to the list", async () => {
  await runBrowser(async page => {
    await show(page, { kind: "proposals", id: "1" });
    await page.getByRole("heading", { name: "Proposal title 1", exact: true }).waitFor();
    await show(page, { kind: "proposals", id: "2" });
    await page.getByRole("heading", { name: "Proposal 2", exact: true }).waitFor();
    expect(await page.getByText("Proposal body 1", { exact: true }).count()).toBe(0);
    await page.evaluate(() => (globalThis as any).__uiPending.proposal());
    await page.getByRole("heading", { name: "Proposal title 2", exact: true }).waitFor();
    await show(page, { kind: "proposals" });
    await page.getByRole("heading", { name: "Proposals", exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "Back to the proposal list" }).count()).toBe(0);
  });
}, 120_000);

test("neuron refresh keeps its applied principal and an old slow filter cannot replace newer results", async () => {
  await runBrowser(async page => {
    await show(page, { kind: "neurons" });
    await page.getByRole("button", { name: "Copy neuron id" }).waitFor();
    const filter = page.getByLabel("Filter by principal", { exact: true });
    await filter.fill("principal-a");
    await page.getByRole("button", { name: "Filter neurons by principal", exact: true }).click();
    await page.waitForFunction(() => (globalThis as any).__uiCalls.some((call: any) => call.principal === "principal-a"));
    await page.getByRole("button", { name: "Refresh neurons", exact: true }).click();
    expect(await page.evaluate(() => (globalThis as any).__uiCalls.at(-1).principal)).toBe("principal-a");
    await filter.fill("slow-principal");
    await filter.press("Enter");
    await page.waitForFunction(() => typeof (globalThis as any).__uiPending.neurons === "function");
    await filter.fill("");
    await filter.press("Enter");
    await page.waitForFunction(() => document.querySelector("tbody th")?.textContent?.startsWith("44444444"));
    await page.evaluate(() => (globalThis as any).__uiPending.neurons());
    await page.waitForTimeout(50);
    expect(await page.locator("tbody th").textContent()).toMatch(/^44444444/);
  });
}, 120_000);

test("narrow and wide screens keep controls accessible and never invent a token scale after metadata failure", async () => {
  await runBrowser(async page => {
    const visibleControls = async () => {
      const overflow = await page.evaluate(() => {
        const width = document.documentElement.clientWidth;
        return {
          width,
          content: document.body.scrollWidth,
          clipped: [...document.querySelectorAll("button, input, select")].filter(element => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && (rect.left < -1 || rect.right > width + 1);
          }).map(element => element.getAttribute("aria-label") ?? element.textContent),
        };
      });
      expect(overflow.content).toBeLessThanOrEqual(overflow.width + 1);
      expect(overflow.clipped).toEqual([]);
    };
    for (const width of [320, 360, 480, 960, 1200]) {
      await page.setViewportSize({ width, height: 800 });
      await show(page, { kind: "detail", tab: "overview" });
      await page.getByRole("heading", { name: "Token", exact: true }).waitFor();
      expect(await page.getByText("123456789 atoms", { exact: true }).count()).toBe(2);
      await visibleControls();
      await show(page, { kind: "detail", tab: "types" });
      await page.getByRole("alert").filter({ hasText: "Proposal types could not be read" }).waitFor();
      for (const view of [{ kind: "drafts", draft: "1" }, { kind: "neurons" }, { kind: "canisters" }, { kind: "proposals", id: "1" }]) {
        await show(page, view);
        await page.waitForTimeout(30);
        await visibleControls();
        if (view.kind === "canisters") {
          await page.getByRole("button", { name: "Read cycles for every canister — an update call the DAO pays for", exact: true }).click();
          await page.getByText("12,345.678 T", { exact: true }).waitFor();
        }
        if (width <= 480 && (view.kind === "neurons" || view.kind === "canisters")) {
          const clippedData = await page.locator("tbody td[data-label]").evaluateAll(cells => cells
            .filter(cell => cell.scrollWidth > cell.clientWidth + 1)
            .map(cell => cell.textContent));
          expect(clippedData).toEqual([]);
        }
        if (process.env.SNSGOV_UI_EVIDENCE_DIR && width === 320) {
          await page.screenshot({ path: join(process.env.SNSGOV_UI_EVIDENCE_DIR, `${view.kind}-320.png`), fullPage: true });
        }
      }
    }
  });
}, 120_000);

async function chromiumOptions(): Promise<{ executablePath?: string }> {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE };
  let store: string[] = [];
  try { store = await readdir("/nix/store"); } catch { /* Fall through to installed browsers. */ }
  const candidates = [
    ...store.filter(name => name.endsWith("-playwright-chromium")).sort().map(name => join("/nix/store", name, "chrome-linux64", "chrome")),
    "/run/current-system/sw/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium",
  ];
  for (const executablePath of candidates) {
    try { await access(executablePath, constants.X_OK); return { executablePath }; } catch { /* Try the next browser. */ }
  }
  return {};
}
