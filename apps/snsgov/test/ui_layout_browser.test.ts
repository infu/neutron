/**
 * Layout contract for the tile.
 *
 * Every assertion here corresponds to something that was actually wrong in a
 * shipped build, so each one is a regression guard rather than a restatement of
 * the stylesheet:
 *
 *   - content sat flush against the frame edge (no gutter),
 *   - the table wrapper was a scroll container on both axes, so the wheel could
 *     not scroll the page while the pointer was over the table — which is most
 *     of the page,
 *   - `white-space: nowrap` on every cell made long text spill across its
 *     neighbours into overlapping runs of text,
 *   - the modifier classes lost a specificity fight with `.snsgov-table th, td`
 *     and silently stopped applying,
 *   - the loading placeholder was a large filled panel,
 *   - `<form>` elements cannot submit at all inside a Neutron app frame.
 *
 * It drives the real compiled stylesheet against fixture markup, so it needs no
 * network and cannot flake on mainnet latency. Fixture drift is covered
 * separately by the source-contract test at the bottom.
 */

import { expect, test } from "bun:test";
import { chromium } from "@playwright/test";
import esbuild from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import { serve } from "bun";
import { constants } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

declare global {
  // Counted inside the page by the loop harness's Kernel stub.
  // eslint-disable-next-line no-var
  var __calls: string[];
  // The tile's own view listeners, so a test can drive navigation the way the
  // Kernel does.
  // eslint-disable-next-line no-var
  var __viewListeners: Set<(view: string) => void>;
}

/** The app's real stylesheet, design system and all. */
async function compileStyles(): Promise<string> {
  const built = await esbuild.build({
    absWorkingDir: appRoot,
    entryPoints: ["src/style.scss"],
    bundle: true,
    minify: false,
    outdir: "browser-test-dist",
    platform: "browser",
    plugins: [sassPlugin()],
    write: false,
  });
  const css = built.outputFiles?.find((file) => file.path.endsWith(".css"))?.text;
  if (!css) throw new Error("style.scss produced no CSS");
  return css;
}

/**
 * Fixture rows carry deliberately hostile content: an unbroken 60-character
 * name, a long principal, and a two-part amount that must never break between
 * its number and its symbol.
 */
function fixtureHtml(css: string): string {
  const rows = Array.from({ length: 24 }, (_, index) => {
    const n = String(index).padStart(2, "0");
    return `<tr class="snsgov-row">
      <th scope="row"><code class="nt-code">000EE49F${n}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA5BA558</code></th>
      <td class="snsgov-num">18'212.27 ALICE</td>
      <td class="snsgov-nowrap">dissolving &rarr; 2025-01-24</td>
      <td><ul class="snsgov-principals"><li>sfe5p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-7qe full control</li></ul></td>
      <td class="snsgov-row-actions"><button class="nt-icon-button" type="button">c</button></td>
    </tr>`;
  }).join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>snsgov layout</title>
<style>html,body{margin:0}</style><style>${css}</style></head><body>
<main class="nt-app nt-app--fill snsgov-app"><div class="nt-page">
  <header class="nt-page-header snsgov-toolbar">
    <div class="snsgov-search"><input class="nt-input" aria-label="Search"></div>
  </header>
  <section class="nt-page-main">
    <div aria-busy="true" class="snsgov-pending" role="status" id="fixture-pending">
      <span class="snsgov-spinner"></span>
    </div>
    <div class="nt-cluster snsgov-toolbar-actions">
      <span class="snsgov-anchor">
        <button class="nt-icon-button" type="button">n</button>
        <div class="nt-panel snsgov-panel" id="fixture-panel">
          Neurons that name your principal but withhold voting need a grant you make yourself.
        </div>
      </span>
    </div>
    <div class="nt-table-wrap">
      <table class="nt-table snsgov-table snsgov-table--snses" id="fixture-snses">
        <thead><tr>
          <th scope="col">Name</th>
          <th scope="col">Symbol</th>
          <th scope="col">Description</th>
        </tr></thead>
        <tbody>
          <tr class="snsgov-row">
            <th scope="row"><span class="snsgov-name"><span class="snsgov-logo snsgov-logo--fallback">BD</span><button class="snsgov-link" type="button">BOOM DAO</button></span></th>
            <td>BOOM</td>
            <td class="snsgov-desc">BOOM DAO is an all-in-one web3 game platform and protocol running fully on-chain, offering a launchpad, a world engine, and a suite of tools for studios of every size.</td>
          </tr>
          <tr class="snsgov-row">
            <th scope="row"><span class="snsgov-name"><span class="snsgov-logo snsgov-logo--fallback">DD</span><button class="snsgov-link" type="button">Delulu DAO</button></span></th>
            <td>TENDY</td>
            <td class="snsgov-desc">A rude chicken</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="nt-table-wrap">
      <table class="nt-table snsgov-table snsgov-table--neurons" id="fixture-neurons">
        <thead><tr>
          <th scope="col">Neuron</th>
          <th class="snsgov-num" scope="col">Stake</th>
          <th class="snsgov-nowrap" scope="col">Dissolve</th>
          <th scope="col">Principals</th>
          <th scope="col"><span class="nt-sr-only">Actions</span></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>
</div></main></body></html>`;
}

test(
  "the tile keeps its gutter, never traps the wheel, and never spills a cell",
  async () => {
    const css = await compileStyles();
    const html = fixtureHtml(css);

    const server = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
    });

    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      browser = await chromium.launch({ headless: true, ...(await chromiumOptions()) });
      const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
      await page.goto(`http://127.0.0.1:${server.port}`);
      await page.locator("#fixture-neurons tbody tr").first().waitFor();

      // --- Gutter: nothing touches the frame edge --------------------------
      const gutters = await page.evaluate(() => {
        const main = document.querySelector(".nt-page-main")!;
        const header = document.querySelector(".nt-page-header")!;
        const firstCell = document.querySelector("#fixture-neurons tbody th")!;
        return {
          mainLeft: parseFloat(getComputedStyle(main).paddingLeft),
          mainRight: parseFloat(getComputedStyle(main).paddingRight),
          headerLeft: parseFloat(getComputedStyle(header).paddingLeft),
          cellLeft: firstCell.getBoundingClientRect().left,
        };
      });
      expect(gutters.mainLeft).toBeGreaterThanOrEqual(12);
      expect(gutters.mainRight).toBeGreaterThanOrEqual(12);
      expect(gutters.headerLeft).toBeGreaterThanOrEqual(12);
      expect(gutters.cellLeft).toBeGreaterThanOrEqual(12);

      // --- The wheel belongs to the page ----------------------------------
      // The wrapper must not be a scroll container on EITHER axis. A horizontal
      // one is enough to break scrolling on a trackpad, and `overflow-y:
      // visible` is not a fix — the spec promotes it to `auto` whenever the
      // other axis is not visible/clip.
      const wrap = await page.evaluate(() => {
        const style = getComputedStyle(document.querySelector(".nt-table-wrap")!);
        return { x: style.overflowX, y: style.overflowY };
      });
      expect(wrap.y).toBe("visible");
      expect(wrap.x).toBe("visible");

      const box = (await page.locator("#fixture-neurons").boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + Math.min(120, box.height / 2));

      // A trackpad sends both axes at once. Testing deltaY alone is what let a
      // horizontal scroll container swallow real two-finger gestures while this
      // test stayed green.
      for (const [dx, dy] of [
        [0, 400],
        [40, 400],
        [-60, 300],
      ] as const) {
        await page.evaluate(() => window.scrollTo(0, 0));
        const before = await page.evaluate(() => window.scrollY);
        await page.mouse.wheel(dx, dy);
        await page.waitForFunction((y) => window.scrollY > y, before, { timeout: 5_000 });
        expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(before);
      }
      await page.evaluate(() => window.scrollTo(0, 0));

      // --- No cell overlaps a neighbour, and none spills visibly -----------
      const spill = await page.evaluate(() => {
        const overlaps: string[] = [];
        for (const row of document.querySelectorAll("#fixture-neurons tbody tr")) {
          const cells = [...row.children].map((cell) => cell.getBoundingClientRect());
          for (let i = 1; i < cells.length; i += 1) {
            if (cells[i - 1]!.right > cells[i]!.left + 1) overlaps.push(row.className || "row");
          }
        }
        const visible: string[] = [];
        for (const cell of document.querySelectorAll("td, th")) {
          const style = getComputedStyle(cell);
          if (cell.scrollWidth > cell.clientWidth + 2 && style.overflow === "visible") {
            visible.push((cell.textContent ?? "").trim().slice(0, 24));
          }
        }
        return { overlaps, visible };
      });
      expect(spill.overlaps).toEqual([]);
      expect(spill.visible).toEqual([]);

      // --- Modifier classes must out-specify the base cell rule ------------
      // `.snsgov-table th, td { white-space: normal }` is (0,2,1); an unscoped
      // `.snsgov-num` is (0,1,0) and loses, breaking "18'212.27" onto its own
      // line from "ALICE".
      const modifiers = await page.evaluate(() => ({
        num: getComputedStyle(document.querySelector("#fixture-neurons .snsgov-num")!).whiteSpace,
        nowrap: getComputedStyle(document.querySelector("#fixture-neurons .snsgov-nowrap")!).whiteSpace,
        actions: getComputedStyle(document.querySelector("#fixture-neurons .snsgov-row-actions")!).whiteSpace,
      }));
      expect(modifiers.num).toBe("nowrap");
      expect(modifiers.nowrap).toBe("nowrap");
      expect(modifiers.actions).toBe("nowrap");

      // Uniform row heights: a wrapped cell makes the table visibly ragged.
      const heights = await page.evaluate(() =>
        [...document.querySelectorAll("#fixture-neurons tbody tr")].map((row) =>
          Math.round(row.getBoundingClientRect().height),
        ),
      );
      expect(new Set(heights).size).toBe(1);

      // --- Busy is a small spinner that moves nothing ----------------------
      // Loading happens constantly; an indicator that takes a row shoves the
      // content it is loading down and snaps it back every single time.
      const pending = await page.evaluate(() => {
        const node = document.querySelector("#fixture-pending")!;
        const style = getComputedStyle(node);
        const spinner = node.querySelector(".snsgov-spinner")!;
        return {
          position: style.position,
          background: style.backgroundColor,
          border: style.borderTopWidth,
          // The laid-out width, not the bounding rect: the element spins, and a
          // rotated square measures up to √2 times its own size.
          spinner: parseFloat(getComputedStyle(spinner).width),
        };
      });
      // Out of flow, so showing or hiding it can move nothing.
      expect(pending.position).toBe("absolute");
      expect(pending.background).toBe("rgba(0, 0, 0, 0)");
      expect(parseFloat(pending.border)).toBe(0);
      // Small: an icon, not a panel.
      expect(pending.spinner).toBeLessThanOrEqual(16);

      // Prove it: toggling it must not shift the table by a pixel.
      const shift = await page.evaluate(() => {
        const table = document.querySelector("#fixture-neurons")!;
        const node = document.querySelector<HTMLElement>("#fixture-pending")!;
        const before = table.getBoundingClientRect().top;
        node.hidden = true;
        const without = table.getBoundingClientRect().top;
        node.hidden = false;
        return { before, without };
      });
      expect(shift.without).toBe(shift.before);


      // --- Rows are the click target, and look like it ---------------------
      // Hitting a 14px run of text to open a row is a needless miss-target, and
      // a row that opens something must say so before it is clicked.
      const rowStyle = await page.evaluate(() => {
        const row = document.querySelector<HTMLElement>("#fixture-neurons tr.snsgov-row")!;
        const base = getComputedStyle(row).backgroundColor;
        const header = document.querySelector<HTMLElement>("#fixture-neurons th[scope='row']")!;
        const cell = document.querySelector<HTMLElement>("#fixture-neurons td")!;
        return {
          cursor: getComputedStyle(row).cursor,
          base,
          headerFont: getComputedStyle(header).fontFamily,
          cellFont: getComputedStyle(cell).fontFamily,
          // A cell that paints its own background covers the row's hover and
          // leaves a seam where the first column ends.
          headerBg: getComputedStyle(header).backgroundColor,
          cellBg: getComputedStyle(cell).backgroundColor,
          headerTransform: getComputedStyle(header).textTransform,
          labelTransform: getComputedStyle(document.querySelector("#fixture-neurons thead th")!).textTransform,
        };
      });
      expect(rowStyle.cursor).toBe("pointer");
      // The design system uppercases every `th`, which is right for a column
      // label and wrong for a row header: these carry DAO names, proposal-type
      // names, and hex neuron ids that must read as they copy.
      expect(rowStyle.headerTransform).toBe("none");
      expect(rowStyle.labelTransform).toBe("uppercase");
      expect(rowStyle.headerBg).toBe("rgba(0, 0, 0, 0)");
      expect(rowStyle.cellBg).toBe("rgba(0, 0, 0, 0)");
      // The row header carries the name — it must not be a different typeface
      // from the rest of the row.
      expect(rowStyle.headerFont).toBe(rowStyle.cellFont);

      const rowBox = (await page.locator("#fixture-neurons tr.snsgov-row").first().boundingBox())!;
      await page.mouse.move(rowBox.x + rowBox.width * 0.8, rowBox.y + rowBox.height / 2);
      await page.waitForTimeout(120);
      const hovered = await page.evaluate(
        () =>
          getComputedStyle(document.querySelector<HTMLElement>("#fixture-neurons tr.snsgov-row")!)
            .backgroundColor,
      );
      expect(hovered).not.toBe(rowStyle.base);

      // --- Nothing drifts while content is loading -------------------------
      // `.nt-page-main` and `.nt-section` are grids the page stretches; with the
      // default `align-content` their few loading-state rows share out the
      // slack, which floated the tab strip into the middle of the tile and
      // snapped it back when content arrived.
      const packing = await page.evaluate(() => ({
        main: getComputedStyle(document.querySelector(".nt-page-main")!).alignContent,
      }));
      expect(packing.main).toBe("start");

      // --- A popover is not a flex child -----------------------------------
      // Rendered inside the header's action cluster it collapsed to icon width
      // and wrapped one character per line.
      const panel = (await page.locator("#fixture-panel").boundingBox())!;
      expect(panel.width).toBeGreaterThan(200);

      // --- The SNS list is one line per row --------------------------------
      // A wrapped description turns a 40-row list into a wall, so every cell in
      // that table is single-line and long text is cut with an ellipsis.
      const list = await page.evaluate(() => {
        const rows = [...document.querySelectorAll<HTMLElement>("#fixture-snses tbody tr")];
        const heights = rows.map((row) => Math.round(row.getBoundingClientRect().height));
        const desc = document.querySelector<HTMLElement>("#fixture-snses .snsgov-desc")!;
        const style = getComputedStyle(desc);
        return {
          uniqueHeights: [...new Set(heights)],
          whiteSpace: style.whiteSpace,
          overflow: style.overflow,
          textOverflow: style.textOverflow,
          // The long description must actually be cut, not merely fit.
          clipped: desc.scrollWidth > desc.clientWidth,
        };
      });
      // A long description and a three-word one must produce the same row.
      expect(list.uniqueHeights.length).toBe(1);
      expect(list.whiteSpace).toBe("nowrap");
      expect(list.textOverflow).toBe("ellipsis");
      expect(list.overflow).toBe("hidden");
      expect(list.clipped).toBe(true);
      // --- The page itself never scrolls sideways --------------------------
      const horizontal = await page.evaluate(() => ({
        body: document.body.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(horizontal.body).toBeLessThanOrEqual(horizontal.client + 1);
    } finally {
      await browser?.close();
      server.stop(true);
    }
  },
  120_000,
);

/**
 * The Setup screen, rendered with the Kernel stubbed.
 *
 * The reported bug was concrete: the SNS picker took ~99% of the row and shoved
 * its "Add" button onto three lines. The picker is gone now — the screen leads
 * with a scan instead — but the underlying rule (a field beside a button must
 * not starve it) still governs every control row here, so it is asserted
 * directly rather than trusted.
 */
test(
  "Setup renders with the Kernel stubbed and never starves a button beside a field",
  async () => {
    const built = await esbuild.build({
      absWorkingDir: appRoot,
      stdin: {
        contents: `
          import { createElement } from "react";
          import { createRoot } from "react-dom/client";
          import { SetupView } from "./src/ui/Setup";
          import "./src/style.scss";
          const root = document.createElement("main");
          root.className = "nt-app nt-app--fill snsgov-app";
          document.body.appendChild(root);
          createRoot(root).render(createElement(SetupView, { onBack: () => {} }));
        `,
        loader: "ts",
        resolveDir: appRoot,
        sourcefile: "setup-harness.ts",
      },
      bundle: true,
      format: "iife",
      jsx: "automatic",
      outdir: "browser-test-dist",
      platform: "browser",
      plugins: [stubKernelPlugin(), sassPlugin()],
      write: false,
    });
    const bundle = built.outputFiles?.find((file) => file.path.endsWith(".js"))?.text;
    const styles = built.outputFiles?.find((file) => file.path.endsWith(".css"))?.text;
    if (!bundle) throw new Error("Setup harness produced no bundle");

    const server = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/bundle.js") {
          return new Response(bundle, {
            headers: { "content-type": "text/javascript; charset=utf-8" },
          });
        }
        return new Response(
          `<!doctype html><html><head><meta charset="utf-8"><title>Setup</title>` +
            `<style>html,body{margin:0}</style><style>${styles ?? ""}</style></head>` +
            `<body><script src="/bundle.js"></script></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      },
    });

    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      browser = await chromium.launch({ headless: true, ...(await chromiumOptions()) });
      const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
      const errors: string[] = [];
      page.on("console", (entry) => {
        if (entry.type() === "error") errors.push(entry.text());
      });
      // Seeded before any script runs: a reload would discard state set with
      // `evaluate` after load, and the stub initialises itself on first use.
      await page.addInitScript(() => {
        window.__snsgovStub = {
          hotkey: { principal: "rrkah-fqaaa-aaaaa-aaaaq-cai", can_manage_neuron: true },
          snses: [
            {
              sns: "extk7-gaaaa-aaaaq-aacda-cai",
              governance: "eqsml-lyaaa-aaaaq-aacdq-cai",
              voting_enabled: true,
              agent_voting_enabled: false,
              label_text: "Neutrinite",
            },
          ],
          calls: [],
        };
      });
      await page.goto(`http://127.0.0.1:${server.port}`);
      await page.getByRole("heading", { name: "Allowlisted SNSes" }).waitFor({ timeout: 20_000 });

      // The principal must be readable in full. Addressed by role, because the
      // copy button deliberately shares the field's accessible name.
      const shown = await page
        .getByRole("textbox", { name: "Your voting principal" })
        .inputValue();
      expect(shown).toBe("rrkah-fqaaa-aaaaa-aaaaq-cai");

      // Every button sharing a row with a field keeps its natural width and
      // stays on one line. This is the reported "smashed onto 3 lines" bug.
      const crushed = await page.evaluate(() => {
        const bad: { text: string; width: number; height: number }[] = [];
        for (const row of document.querySelectorAll(".snsgov-filter, .snsgov-copyfield")) {
          for (const button of row.querySelectorAll("button")) {
            const box = button.getBoundingClientRect();
            const lineHeight = parseFloat(getComputedStyle(button).lineHeight) || 16;
            if (box.width < 24 || box.height > lineHeight * 2.6) {
              bad.push({
                text: (button.textContent ?? "").trim().slice(0, 20),
                width: Math.round(box.width),
                height: Math.round(box.height),
              });
            }
          }
        }
        return bad;
      });
      expect(crushed).toEqual([]);

      const overflow = await page.evaluate(() => ({
        body: document.body.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(overflow.body).toBeLessThanOrEqual(overflow.client + 1);

      // Toggling agent voting must reach the backend as an upsert.
      await page.getByLabel("Allow agent voting for Neutrinite").check();
      await page.waitForFunction(() =>
        window.__snsgovStub.calls.some((call) => call.method === "snsgov_sns_upsert"),
      );

      expect(errors.filter((text) => !text.includes("favicon"))).toEqual([]);
    } finally {
      await browser?.close();
      server.stop(true);
    }
  },
  180_000,
);

/**
 * No screen may re-render in a loop.
 *
 * A callback prop that a parent re-creates each render, listed in a
 * `useCallback` dependency array that an effect then depends on, produces an
 * endless load/clear/load cycle: the effect fires, the callback runs, the parent
 * re-renders, the callback identity changes, the effect fires again. It is
 * invisible in a unit test and unusable in practice, so it is measured here:
 * every screen must settle to zero Kernel calls once loaded.
 */
test(
  "no screen re-renders in a loop",
  async () => {
    const built = await buildLoopHarness();
    const server = serveHarness(built);

    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      browser = await chromium.launch({ headless: true, ...(await chromiumOptions()) });
      const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
      const crashes: string[] = [];
      page.on("pageerror", (error) => crashes.push(String(error).slice(0, 200)));
      await page.goto(`http://127.0.0.1:${server.port}`);
      await page.locator("table tbody tr").first().waitFor({ timeout: 30_000 });

      // Driven through the DOM: a looping page never satisfies Playwright's
      // actionability wait, so a click would time out rather than report why.
      const settles = async (label: string) => {
        const before = await page.evaluate(() => globalThis.__calls.length);
        await page.waitForTimeout(1500);
        const after = await page.evaluate(() => globalThis.__calls.length);
        if (after !== before) {
          throw new Error(`${label} kept calling the Kernel: +${after - before} in 1.5s`);
        }
      };

      await settles("the SNS list");

      await page.evaluate(() => document.querySelector<HTMLElement>(".snsgov-link")?.click());
      await page.waitForTimeout(1200);
      await settles("the SNS detail");

      await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('[role="tab"]')]
          .find((tab) => /Proposals/.test(tab.textContent ?? ""))
          ?.click(),
      );
      await page.waitForTimeout(1200);
      await settles("the proposals tab");

      await page.evaluate(() =>
        document.querySelector<HTMLElement>('[aria-label="Back to the SNS list"]')?.click(),
      );
      await page.waitForTimeout(600);
      await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>("button")]
          .find((button) => /waiting for you to review/.test(button.getAttribute("aria-label") ?? ""))
          ?.click(),
      );
      await page.waitForTimeout(1200);
      await settles("the drafts list");

      await page.evaluate(() => document.querySelector<HTMLElement>(".snsgov-link")?.click());
      await page.waitForTimeout(1200);
      await settles("the draft review");

      expect(crashes).toEqual([]);
    } finally {
      await browser?.close();
      server.stop(true);
    }
  },
  180_000,
);

/**
 * An agent asking the tile to show a page must actually land there.
 *
 * The view string is the only contract between the service and the tile, and a
 * string the tile does not recognise is silently ignored — the agent reports a
 * navigation that never happened. Driven here through the same listener the
 * Kernel calls.
 */
test(
  "an agent can navigate the tile to a page",
  async () => {
    const built = await buildLoopHarness();
    const server = serveHarness(built);
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      browser = await chromium.launch({ headless: true, ...(await chromiumOptions()) });
      const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
      await page.goto(`http://127.0.0.1:${server.port}`);
      await page.locator("table tbody tr").first().waitFor({ timeout: 30_000 });

      const send = async (view: string) => {
        await page.evaluate((value) => {
          for (const listener of globalThis.__viewListeners) listener(value);
        }, view);
        await page.waitForTimeout(700);
      };

      await send("sns/extk7-gaaaa-aaaaq-aacda-cai/canisters");
      expect(await page.locator(".snsgov-detail-title").textContent()).toBe("Neutrinite");
      expect(
        await page.locator('[role="tab"][aria-selected="true"]').textContent(),
      ).toBe("Canisters");

      await send("sns/extk7-gaaaa-aaaaq-aacda-cai");
      expect(
        await page.locator('[role="tab"][aria-selected="true"]').textContent(),
      ).toBe("Overview");

      await send("drafts");
      expect(await page.getByRole("heading", { name: "Drafts" }).count()).toBe(1);

      await send("setup");
      expect(await page.getByRole("heading", { name: "Setup" }).count()).toBe(1);

      await send("list");
      await page.locator("table tbody tr").first().waitFor();

      // An unrecognised string must leave the tile exactly where it was, not
      // strand it on a blank screen.
      await send("sns/not-a-canister/proposals/x");
      await page.locator("table tbody tr").first().waitFor();
    } finally {
      await browser?.close();
      server.stop(true);
    }
  },
  180_000,
);

test("no view renders a form, which a Neutron app frame cannot submit", async () => {
  // App frames are sandboxed `allow-scripts allow-same-origin`; without
  // `allow-forms` any submit is blocked with a console error and the handler
  // never runs. Buttons must be `type="button"` with explicit onClick.
  const sources = await tsxSources();
  const offenders = sources.filter(([, text]) => /<form[\s>]/.test(text)).map(([path]) => path);
  expect(offenders).toEqual([]);
});

test("every table is wrapped and sized, so the fixture above stays honest", async () => {
  const sources = await tsxSources();
  const css = await compileStyles();

  for (const [path, text] of sources) {
    for (const match of text.matchAll(/<table\s+className="([^"]+)"/g)) {
      const classes = match[1]!;
      if (!classes.includes("snsgov-table")) {
        throw new Error(`${path}: <table> without the snsgov-table base class`);
      }
      // A table outside `.nt-table-wrap` has no horizontal scroller, so a
      // narrow tile clips it with no way to reach the rest.
      const before = text.slice(0, match.index);
      if (!before.slice(-400).includes("nt-table-wrap")) {
        throw new Error(`${path}: <table> is not inside a .nt-table-wrap`);
      }
      // `table-layout: fixed` without explicit widths lets one long value
      // starve every other column, so each table needs its own modifier.
      const modifier = /snsgov-table--([a-z]+)/.exec(classes)?.[1];
      if (!modifier) throw new Error(`${path}: <table> has no snsgov-table--* width modifier`);
      if (!css.includes(`.snsgov-table--${modifier}`)) {
        throw new Error(`${path}: snsgov-table--${modifier} has no column widths in style.scss`);
      }
    }
  }
});


/** Redirect `neutron-tools/app` to the stub, from wherever it is imported. */
function stubKernelPlugin(): esbuild.Plugin {
  return {
    name: "stub-neutron-app",
    setup(build) {
      build.onResolve({ filter: /^neutron-tools\/app$/ }, () => ({
        path: join(appRoot, "test/stubs/neutron_app.ts"),
      }));
    },
  };
}


/** The whole tile, with the Kernel and registry stubbed. Shared by the
 * loop test and the navigation test so there is one harness to keep working. */
async function buildLoopHarness(): Promise<{ bundle: string; styles: string }> {
  const kernelStub = `
    globalThis.__calls = [];
    export const querySelf = async (m) => {
      globalThis.__calls.push(m);
      if (m === "snsgov_drafts") return [{ id: "7", sns: "extk7-gaaaa-aaaaq-aacda-cai",
        governance: "eqsml-lyaaa-aaaaq-aacdq-cai", title: "A draft", summary: "s", url: "",
        action_kind: "Motion", payload: new TextEncoder().encode("m"), created_by: "agent",
        updated_at_seconds: "1756700000" }];
      if (m === "snsgov_hotkey") return { principal: "aaaaa-aa", can_manage_neuron: true };
      if (m === "snsgov_config") return { snses: [], audit_rows: "0", max_audit_rows: "1000" };
      return {};
    };
    export const updateSelf = async (m) => { globalThis.__calls.push(m); return null; };
    export const copyToClipboard = async () => {};
    export const openAppTile = async () => ({});
    globalThis.__viewListeners = new Set();
    export const onTileViewRequest = (fn) => {
      globalThis.__viewListeners.add(fn);
      return () => globalThis.__viewListeners.delete(fn);
    };
    export const exposeTool = () => {};
  `;
  const dataStub = `
    export const ENTRY = { canisters: { root: "extk7-gaaaa-aaaaq-aacda-cai",
      governance: "eqsml-lyaaa-aaaaq-aacdq-cai", ledger: "extk7-gaaaa-aaaaq-aacea-cai",
      swap: null, index: null }, liveness: { governance: true, ledger: true },
      metadata: { name: "Neutrinite" },
      token: { symbol: "NTN", decimals: 8, totalSupply: 100000000n, fee: 10000n, name: "NTN" },
      lifecycle: {}, fetchedAt: 0 };
    export const getRegistry = async () => { globalThis.__calls.push("getRegistry"); return { entries: [ENTRY], fetchedAt: 0 }; };
    export const requireEntry = async () => { globalThis.__calls.push("requireEntry"); return ENTRY; };
    export const peekRegistry = () => undefined;
    export const getProvisionalRegistry = async () => undefined;
    export const displayName = () => "Neutrinite";
  `;
  const built = await esbuild.build({
    absWorkingDir: appRoot,
    stdin: {
      contents: `
        import { createElement } from "react";
        import { createRoot } from "react-dom/client";
        import { App } from "./src/index";
        const el = document.createElement("div");
        el.id = "root";
        document.body.appendChild(el);
        createRoot(el).render(createElement(App));
      `,
      loader: "ts",
      resolveDir: appRoot,
      sourcefile: "loop-harness.ts",
    },
    bundle: true,
    format: "esm",
    jsx: "automatic",
    outdir: "browser-test-dist",
    platform: "browser",
    write: false,
    plugins: [
      {
        name: "stub-data",
        setup(build) {
          build.onResolve({ filter: /^neutron-tools\/app$/ }, () => ({
            path: "stub:kernel",
            namespace: "loopstub",
          }));
          build.onResolve({ filter: /\/data\/registry$/ }, () => ({
            path: "stub:registry",
            namespace: "loopstub",
          }));
          build.onLoad({ filter: /.*/, namespace: "loopstub" }, (args) => ({
            contents: args.path === "stub:kernel" ? kernelStub : dataStub,
            loader: "ts",
            resolveDir: appRoot,
          }));
        },
      },
      sassPlugin(),
    ],
  });
  const bundle = built.outputFiles?.find((file) => file.path.endsWith(".js"))?.text;
  const styles = built.outputFiles?.find((file) => file.path.endsWith(".css"))?.text ?? "";
  if (!bundle) throw new Error("loop harness produced no bundle");


  if (!bundle) throw new Error("loop harness produced no bundle");
  return { bundle, styles: styles ?? "" };
}

function serveHarness({ bundle, styles }: { bundle: string; styles: string }) {
  return serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/bundle.js") {
        return new Response(bundle, {
          headers: { "content-type": "text/javascript; charset=utf-8" },
        });
      }
      return new Response(
        `<!doctype html><html><head><meta charset="utf-8"><title>Harness</title>` +
          `<style>html,body{margin:0}</style><style>${styles}</style></head>` +
          `<body><script type="module" src="/bundle.js"></script></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
}

async function tsxSources(): Promise<[string, string][]> {
  const dirs = [join(appRoot, "src"), join(appRoot, "src", "ui")];
  const out: [string, string][] = [];
  for (const dir of dirs) {
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".tsx")) continue;
      const path = join(dir, name);
      out.push([path.slice(appRoot.length + 1), await readFile(path, "utf8")]);
    }
  }
  return out;
}

async function chromiumOptions(): Promise<{ executablePath?: string }> {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
    return { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE };
  }
  if (process.platform !== "linux") return {};
  let entries: string[];
  try {
    entries = await readdir("/nix/store");
  } catch {
    return {};
  }
  for (const entry of entries.filter((name) => name.endsWith("-playwright-chromium")).sort()) {
    const candidate = join("/nix/store", entry, "chrome-linux64", "chrome");
    try {
      await access(candidate, constants.X_OK);
      return { executablePath: candidate };
    } catch {
      // Try the next exact Playwright Chromium wrapper.
    }
  }
  // Playwright's own download needs system libraries that are not always
  // present; a system Chrome renders the same engine for a layout check.
  for (const candidate of [
    "/run/current-system/sw/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ]) {
    try {
      await access(candidate, constants.X_OK);
      return { executablePath: candidate };
    } catch {
      // Fall through to the next candidate.
    }
  }
  return {};
}
