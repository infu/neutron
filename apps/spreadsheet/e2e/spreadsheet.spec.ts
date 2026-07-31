import { expect, test, type ConsoleMessage, type Page, type Request, type Response } from "@playwright/test";
import {
  approveFilesTool,
  applySystemOperations,
  callSpreadsheetTool,
  editCell,
  goTo,
  openFilesTile,
  openSpreadsheet,
  selectRange,
  uniquePath,
  waitIdle,
  workbookStatus,
  type SpreadsheetHarness,
} from "./harness.ts";

const harnesses = new WeakMap<Page, SpreadsheetHarness>();
const surfaceFailures = new WeakMap<Page, SurfaceFailure[]>();

test.describe("Spreadsheet — 20 release user flows", () => {
  test.beforeEach(async ({ page }) => {
    surfaceFailures.set(page, monitorSpreadsheetSurface(page));
    harnesses.set(page, await openSpreadsheet(page));
  });

  test.afterEach(async ({ page }) => {
    await drainSpreadsheetEvents(page);
    expect(
      surfaceFailures.get(page) ?? [],
      "The Spreadsheet frames must not throw, log console errors, fail requests, or return HTTP errors",
    ).toEqual([]);
  });

  test("01 launch a clean workbook", async ({ page }) => {
    const { sheet, frame } = harness(page);
    await expect(page.locator('[data-tid="app-background-frame"][data-app-id="spreadsheet"]')).toHaveCount(1);
    await expect(page.locator('iframe[data-app-id="spreadsheet"][data-tile-id="workbook"]')).toHaveCount(1);
    const sheetFooter = sheet.locator("footer.sheet-strip");
    const footer = sheet.getByRole("tablist", { name: "Workbook sheets" });
    const activeTab = sheet.getByRole("tab", { name: "Sheet1" });
    await expect(sheetFooter).toBeVisible();
    await expect(footer).toBeVisible();
    expect(await sheetFooter.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(32);
    expect(await sheetFooter.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(36);
    await expect(activeTab).toHaveAttribute("aria-selected", "true");
    await expect(activeTab).toHaveAttribute("tabindex", "0");
    expect(await footer.locator(":scope > *").evaluateAll((elements) => elements.every((element) => element.getAttribute("role") === "tab"))).toBe(true);
    await expect(activeTab).toBeInViewport({ ratio: 1 });
    expect(await activeTab.evaluate((element) => {
      const tab = element.getBoundingClientRect();
      const strip = element.closest('[role="tablist"]')?.getBoundingClientRect();
      return Boolean(strip)
        && tab.top >= strip!.top
        && tab.bottom <= strip!.bottom
        && tab.left >= 0
        && tab.right <= window.innerWidth
        && tab.top >= 0
        && tab.bottom <= window.innerHeight;
    })).toBe(true);
    expect(await sheet.locator("html").evaluate((element) => ({
      horizontal: element.scrollWidth - element.clientWidth,
      vertical: element.scrollHeight - element.clientHeight,
    }))).toEqual({ horizontal: 0, vertical: 0 });
    const workbookPath = sheet.locator('[data-tid="spreadsheet-workbook-path"]');
    await expect(workbookPath).toBeVisible();
    expect(await workbookPath.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(0);
    await expect(workbookPath.locator("svg")).toHaveCount(1);
    const addSheet = sheet.getByRole("button", { name: "Add sheet" });
    await expect(addSheet.locator("svg")).toHaveCount(1);
    await expect(addSheet).not.toContainText("+");
    const sheetActions = sheet.getByRole("button", { name: "Sheet actions" });
    await expect(sheetActions.locator("svg")).toHaveCount(1);
    await expect(sheet.locator('[data-address="A1"]')).toHaveText("");
    const saveCommand = sheet.getByRole("button", { name: "Save", exact: true });
    await expect(saveCommand).toBeVisible();
    await expect(saveCommand).toBeEnabled();
    await expect(saveCommand).toHaveAttribute("data-state", "new");
    await expect(sheet.locator('[data-tid="spreadsheet-save-state"]')).toHaveCount(0);
    await expect(sheet.getByRole("alert")).toHaveCount(0);
    for (const name of ["Save", "Undo", "Redo", "Copy", "Paste"]) {
      const command = sheet.getByRole("button", { name, exact: true }).first();
      await expect(command).toBeVisible();
      await expect(command).toHaveAttribute("title", /.+/);
      await expect(command.locator("svg")).toHaveCount(1);
      await expect(command.locator("svg")).toHaveAttribute("aria-hidden", "true");
      expect(await command.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return Math.min(rect.width, rect.height);
      })).toBeGreaterThanOrEqual(28);
    }
    const status = await workbookStatus(page);
    expect(status.capabilities).toMatchObject({
      version: 1,
      javascriptFunctions: false,
      losslessFormat: "nsheet",
      snapshotFormats: ["xlsx", "csv"],
      concurrency: {
        optimisticRevision: true,
        idempotentCommandIds: true,
        historyHeadRequired: true,
        atomicOperationBatches: true,
      },
    });
    expect(status.capabilities.operations).toContain("sort_range");
    expect(status.capabilities.formulaFunctions).toContain("XLOOKUP");

    for (const viewport of [
      { width: 1440, height: 240 },
      { width: 320, height: 480 },
      { width: 240, height: 480 },
    ]) {
      await page.setViewportSize(viewport);
      // Browser/device-pixel rounding can report 0.99994 for a geometrically
      // complete iframe. A 99% threshold still rejects the real clipped-tile
      // failure this assertion was added for without waiting forever on a
      // sub-pixel edge.
      await expect(frame).toBeInViewport({ ratio: 0.99 });
      await expect(footer).toBeVisible();
      // At the 240px kernel layout the outer iframe is fractionally clipped
      // and scales the intersection ratio of controls sitting at its bottom
      // edge. The explicit inner-frame rectangle check below remains the
      // authoritative no-clipping assertion for the footer itself.
      await expect(activeTab).toBeInViewport({ ratio: 0.9 });
      await expect(workbookPath).toBeVisible();
      expect(await workbookPath.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(0);
      expect(await sheet.locator("html").evaluate((element) => ({
        horizontal: element.scrollWidth - element.clientWidth,
        vertical: element.scrollHeight - element.clientHeight,
      }))).toEqual({ horizontal: 0, vertical: 0 });
      const summaries = sheet.locator(".toolbar-menu > summary");
      await expect(summaries).toHaveCount(4);
      expect(await summaries.evaluateAll((elements) => elements.every((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight;
      })), `${viewport.width}×${viewport.height} command summaries must fit the tile`).toBe(true);
      await expect(saveCommand).toBeVisible();
      expect(await saveCommand.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight;
      }), `${viewport.width}×${viewport.height} save command must fit the tile`).toBe(true);

      for (const label of [
        "File and demo commands",
        "More edit commands",
        "More formatting commands",
        "Data and structure commands",
      ]) {
        const summary = sheet.locator(`summary[aria-label="${label}"]`);
        await summary.click();
        const panel = sheet.locator(`details:has(> summary[aria-label="${label}"]) > .toolbar-menu-panel`);
        await expect(panel).toBeVisible();
        expect(await panel.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0
            && rect.left >= 0 && rect.right <= window.innerWidth
            && rect.top >= 0 && rect.bottom <= window.innerHeight;
        }), `${label} panel must fit ${viewport.width}×${viewport.height}`).toBe(true);
        await page.keyboard.press("Escape");
        await expect(summary).toBeFocused();
        await expect(sheet.locator(".toolbar-menu[open]")).toHaveCount(0);
      }

      await sheetActions.click();
      const sheetPanel = sheet.locator(".sheet-menu-panel");
      await expect(sheetPanel).toBeVisible();
      expect(await sheetPanel.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0
          && rect.left >= 0 && rect.right <= window.innerWidth
          && rect.top >= 0 && rect.bottom <= window.innerHeight;
      }), `Sheet actions must fit ${viewport.width}×${viewport.height}`).toBe(true);
      await page.keyboard.press("Escape");
      await expect(sheetActions).toBeFocused();
      await expect(sheet.locator(".sheet-menu[open]")).toHaveCount(0);

      const formulaHelpButton = sheet.getByRole("button", { name: "Formula help" });
      await formulaHelpButton.click();
      const formulaHelp = sheet.getByRole("dialog", { name: "Formula help" });
      await expect(formulaHelp).toBeVisible();
      const formulaHelpSearch = formulaHelp.getByLabel("Find a function");
      await expect(formulaHelpSearch).toBeFocused();
      expect(await formulaHelpSearch.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0
          && rect.left >= 0 && rect.right <= window.innerWidth
          && rect.top >= 0 && rect.bottom <= window.innerHeight;
      }), `Formula search must be initially visible at ${viewport.width}×${viewport.height}`).toBe(true);
      expect(await formulaHelp.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0
          && rect.left >= 0 && rect.right <= window.innerWidth
          && rect.top >= 0 && rect.bottom <= window.innerHeight;
      }), `Formula help must fit ${viewport.width}×${viewport.height}`).toBe(true);
      await page.keyboard.press("Escape");
      await expect(formulaHelpButton).toBeFocused();
      await expect(sheet.locator(".formula-help-menu[open]")).toHaveCount(0);
    }
  });

  test("02 edit, commit, move, and cancel", async ({ page }) => {
    const app = harness(page);
    await app.sheet.locator('[data-address="A1"]').click();
    await page.keyboard.type("hello", { delay: 30 });
    await app.sheet.getByLabel("Raw input for A1").press("Enter");
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveText("hello");
    await expect(app.sheet.locator('[data-address="A2"]')).toBeFocused();

    await editCell(app, "A2", "42", "Tab");
    await expect(app.sheet.locator('[data-address="B2"]')).toBeFocused();
    await app.sheet.locator('[data-address="B2"]').dblclick();
    await app.sheet.getByLabel("Raw input for B2").fill("cancel me");
    await app.sheet.getByLabel("Raw input for B2").press("Escape");
    await expect(app.sheet.locator('[data-address="B2"]')).toHaveText("");
    await expect(app.sheet.getByRole("button", { name: "Save", exact: true })).toHaveAttribute("data-state", "dirty");

    await editCell(app, "B1", "3");
    await editCell(app, "C1", "4");
    const beforePointing = await workbookStatus(page);
    await app.sheet.locator('[data-address="D1"]').click();
    await app.sheet.getByRole("button", { name: "Start formula" }).click();
    const formulaEditor = app.sheet.getByLabel("Raw input for D1");
    await expect(formulaEditor).toHaveValue("=");
    await expect(app.sheet.getByRole("separator", { name: "Resize column A", exact: true })).toHaveAttribute("aria-disabled", "true");
    await expect(app.sheet.locator('[data-tid="spreadsheet-formula-hint"]')).toContainText("Click or drag cells");
    await formulaEditor.press("F1");
    const formulaHelp = app.sheet.getByRole("dialog", { name: "Formula help" });
    await expect(formulaHelp).toBeVisible();
    const formulaSearch = formulaHelp.getByLabel("Find a function");
    await expect(formulaSearch).toBeFocused();
    await expect(formulaEditor).toHaveValue("=");
    await expect(app.sheet.getByLabel("Go to cell address")).toHaveValue("D1");
    await expect(app.sheet.locator('[data-address="D1"]')).toHaveClass(/active/);
    expect((await workbookStatus(page)).revision).toBe(beforePointing.revision);
    await formulaSearch.fill("lookup");
    await expect(formulaHelp.locator('[data-formula-function="XLOOKUP"]')).toBeVisible();
    await expect(formulaHelp.locator('[data-formula-function="VLOOKUP"]')).toContainText("FALSE");
    await expect(formulaHelp.locator('[data-formula-function="SUM"]')).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(formulaHelp).toHaveCount(0);
    await expect(formulaEditor).toBeFocused();
    await expect(formulaEditor).toHaveValue("=");
    expect((await workbookStatus(page)).revision).toBe(beforePointing.revision);
    await app.sheet.locator('[data-address="B1"]').click();
    await expect(formulaEditor).toHaveValue("=B1");
    await expect(formulaEditor).toBeFocused();
    await expect(app.sheet.getByLabel("Go to cell address")).toHaveValue("D1");
    await expect(app.sheet.locator('[data-address="D1"]')).toHaveClass(/active/);
    await expect(app.sheet.locator('[data-address="B1"]')).toHaveClass(/formula-reference/);
    expect((await workbookStatus(page)).revision).toBe(beforePointing.revision);

    // Repointing before typing an operator replaces the current token.
    await app.sheet.locator('[data-address="C1"]').click();
    await expect(formulaEditor).toHaveValue("=C1");
    await formulaEditor.press("F4");
    await expect(formulaEditor).toHaveValue("=$C$1");
    await formulaEditor.type("+");
    await app.sheet.locator('[data-address="B1"]').click();
    await expect(formulaEditor).toHaveValue("=$C$1+B1");
    await expect(formulaEditor).toBeFocused();
    expect((await workbookStatus(page)).revision).toBe(beforePointing.revision);
    await formulaEditor.press("Enter");
    await waitIdle(app.sheet);
    await expect(app.sheet.getByRole("separator", { name: "Resize column A", exact: true })).toHaveAttribute("aria-disabled", "false");
    await expect(app.sheet.locator('[data-address="D1"]')).toHaveText("7");
    await expectRaw(app, "D1", "=$C$1+B1");
    expect((await workbookStatus(page)).revision).toBe(beforePointing.revision + 1);

    const beforeCancelledRange = await workbookStatus(page);
    await app.sheet.locator('[data-address="D2"]').click();
    await app.sheet.getByRole("button", { name: "Start formula" }).click();
    const rangeEditor = app.sheet.getByLabel("Raw input for D2");
    await rangeEditor.type("SUM(");
    await expect(app.sheet.locator('[data-tid="spreadsheet-formula-hint"]')).toContainText("SUM(number1");
    await dragFormulaReference(app, "B1", "C1");
    await expect(rangeEditor).toHaveValue("=SUM(B1:C1");
    await rangeEditor.type(")");
    await rangeEditor.press("Escape");
    await expect(app.sheet.locator('[data-address="D2"]')).toHaveText("");
    await expect(app.sheet.locator('[data-address="D2"]')).toBeFocused();
    expect((await workbookStatus(page)).revision).toBe(beforeCancelledRange.revision);

    // A changed draft committed by clicking another cell must not make the
    // tile wait on a dense 1,000-cell reread before it can move focus. This is
    // deliberately generous for loaded CI, while still catching the former
    // 0.9–1.0 second quadratic workbook_read stall.
    await app.sheet.locator('[data-address="A3"]').dblclick();
    await app.sheet.getByLabel("Raw input for A3").fill("responsive");
    const clickAwayStarted = await app.sheet.locator("body").evaluate(() => performance.now());
    await app.sheet.locator('[data-address="B3"]').click();
    await expect(app.sheet.locator('[data-address="B3"]')).toBeFocused({ timeout: 500 });
    const clickAwayMs = await app.sheet.locator("body").evaluate((_, started) => performance.now() - started, clickAwayStarted);
    expect(clickAwayMs, "changed edit → clicked-cell focus latency").toBeLessThan(500);
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="A3"]')).toHaveText("responsive");
    await expect(app.sheet.getByRole("alert")).toHaveCount(0);
  });

  test("03 calculate formulas and expose raw and error state", async ({ page }) => {
    const app = harness(page);
    await editCell(app, "A1", "10");
    await editCell(app, "A2", "20");
    await editCell(app, "A3", "30");
    await editCell(app, "B1", "=SUM(A1:A3)");
    await editCell(app, "B2", "=1/0");
    await expect(app.sheet.locator('[data-address="B1"]')).toHaveText("60");
    await expect(app.sheet.locator('[data-address="B2"]')).toHaveText("#DIV/0!");
    await expect(app.sheet.locator('[data-address="B2"]')).toHaveAttribute("aria-label", /Division by zero/);
    await editCell(app, "C1", "=COUNT(A1:A2,B2:B2)");
    await editCell(app, "C2", "=COUNTA(A1:A2,B2:B2)");
    await editCell(app, "C3", "=MATCH(20,A1:A3,1)");
    const formulaStatus = await workbookStatus(page);
    await applySystemOperations(page, [{
      type: "set_cells",
      sheetId: formulaStatus.sheets[0].id,
      start: "A4",
      values: [[{ kind: "boolean", value: true }]],
    }, {
      type: "set_cells",
      sheetId: formulaStatus.sheets[0].id,
      start: "E1",
      values: [
        [{ kind: "text", value: "cat" }, { kind: "number", value: 2 }],
        [{ kind: "text", value: "cot" }, { kind: "number", value: 3 }],
        [{ kind: "text", value: "c?t" }, { kind: "number", value: 5 }],
        [{ kind: "text", value: "c*t" }, { kind: "number", value: 7 }],
      ],
    }]);
    await waitForCell(app, "A4", "TRUE");
    await waitForCell(app, "E4", "c*t");
    await editCell(app, "D1", "=SUM(A4:A4)");
    await editCell(app, "D2", '=SUM("5",15,TRUE)');
    await editCell(app, "D3", "=ABS(1,2)");
    await editCell(app, "D4", '=A5=""');
    await editCell(app, "G1", '=COUNTIF(E1:E4,"c?t")');
    await editCell(app, "G2", '=COUNTIF(E1:E4,"c~?t")');
    await editCell(app, "G3", '=SUMIF(E1:E4,"c*t",F1:F4)');
    await editCell(app, "G4", '=SUMIF(E1:E4,"c~*t",F1:F4)');
    await expect(app.sheet.locator('[data-address="C1"]')).toHaveText("2");
    await expect(app.sheet.locator('[data-address="C2"]')).toHaveText("3");
    await expect(app.sheet.locator('[data-address="C3"]')).toHaveText("#VALUE!");
    await expect(app.sheet.locator('[data-address="D1"]')).toHaveText("0");
    await expect(app.sheet.locator('[data-address="D2"]')).toHaveText("21");
    await expect(app.sheet.locator('[data-address="D3"]')).toHaveText("#VALUE!");
    await expect(app.sheet.locator('[data-address="D4"]')).toHaveText("TRUE");
    await expect(app.sheet.locator('[data-address="G1"]')).toHaveText("4");
    await expect(app.sheet.locator('[data-address="G2"]')).toHaveText("1");
    await expect(app.sheet.locator('[data-address="G3"]')).toHaveText("17");
    await expect(app.sheet.locator('[data-address="G4"]')).toHaveText("7");
    await editCell(app, "A1", "15");
    await expect(app.sheet.locator('[data-address="B1"]')).toHaveText("65");
    await app.sheet.locator('[data-address="B1"]').click();
    await expect(app.sheet.getByLabel("Raw input for B1")).toHaveValue("=SUM(A1:A3)");
  });

  test("04 select and clear a range", async ({ page }) => {
    const app = harness(page);
    const status = await workbookStatus(page);
    await applySystemOperations(page, [{
      type: "set_cells", sheetId: status.sheets[0].id, start: "A1",
      values: Array.from({ length: 3 }, (_, row) => Array.from({ length: 3 }, (_, column) => ({ kind: "number", value: row * 3 + column + 1 }))),
    }]);
    await waitForCell(app, "C3", "9");
    await selectRange(app, "A1", "C3");
    await expect(app.sheet.locator('[data-tid="spreadsheet-selection-summary"]')).toContainText("A1:C3 · Count 9 · Sum 45 · Avg 5");
    await page.keyboard.press("Shift+ArrowDown");
    await expect(app.sheet.locator('[data-tid="spreadsheet-selection-summary"]')).toContainText("A1:C4");
    await page.keyboard.press("Delete");
    await waitIdle(app.sheet);
    for (const address of ["A1", "B1", "C1", "A2", "B2", "C2", "A3", "B3", "C3"]) {
      await expect(app.sheet.locator(`[data-address="${address}"]`)).toHaveText("");
    }
  });

  test("05 copy and paste translated formulas", async ({ page }) => {
    const app = harness(page);
    await editCell(app, "A1", "10");
    await editCell(app, "B1", "=A1*2");
    await app.sheet.locator('[data-address="B1"]').click();
    await app.sheet.getByRole("button", { name: "Bold" }).click();
    await waitIdle(app.sheet);
    await selectRange(app, "A1", "B1");
    await app.sheet.getByRole("button", { name: "Copy" }).click();
    await goTo(app, "D1");
    await page.keyboard.press("Control+V");
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="D1"]')).toHaveText("10");
    await expect(app.sheet.locator('[data-address="E1"]')).toHaveText("20");
    await app.sheet.locator('[data-address="E1"]').click();
    await expect(app.sheet.getByLabel("Raw input for E1")).toHaveValue("=D1*2");
    await expect(app.sheet.locator('[data-address="E1"]')).toHaveCSS("font-weight", "700");
  });

  test("06 paste values and external TSV", async ({ page }) => {
    const app = harness(page);
    await editCell(app, "A1", "2");
    await editCell(app, "B1", "=A1*3");
    await app.sheet.locator('[data-address="D1"]').click();
    await app.sheet.getByRole("button", { name: "Bold" }).click();
    await app.sheet.locator('[data-address="B1"]').click();
    await app.sheet.getByRole("button", { name: "Copy" }).click();
    await goTo(app, "D1");
    await clickToolbarCommand(app, "More edit commands", "Paste values");
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="D1"]')).toHaveText("6");
    await expectRaw(app, "D1", "6");
    await app.sheet.locator('[data-address="D1"]').click();
    await expect(app.sheet.getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "true");

    await editCell(app, "F1", "=1/0");
    await app.sheet.locator('[data-address="F1"]').click();
    await app.sheet.getByRole("button", { name: "Copy" }).click();
    await goTo(app, "H1");
    await clickToolbarCommand(app, "More edit commands", "Paste values");
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="H1"]')).toHaveText("#DIV/0!");
    await expectRaw(app, "H1", "=#DIV/0!");
    await editCell(app, "I1", '=IFERROR(H1,"handled")');
    await expect(app.sheet.locator('[data-address="I1"]')).toHaveText("handled");

    await goTo(app, "A5");
    await app.sheet.getByRole("grid", { name: "Spreadsheet grid" }).evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.setData("text/plain", 'alpha\t"two\nlines"\n"tab\tinside"\t"say ""hi"""');
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: transfer }));
    });
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="A5"]')).toHaveText("alpha");
    await expect(app.sheet.locator('[data-address="B5"]')).toHaveText("two\nlines");
    await expect(app.sheet.locator('[data-address="A6"]')).toHaveText("tab\tinside");
    await expect(app.sheet.locator('[data-address="B6"]')).toHaveText('say "hi"');
  });

  test("07 fill down and right", async ({ page }) => {
    const app = harness(page);
    await editCell(app, "A1", "5");
    await editCell(app, "B1", "=A1*2");
    await selectRange(app, "A1", "B5");
    await clickToolbarCommand(app, "Data and structure commands", "Fill down");
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="A5"]')).toHaveText("5");
    await expect(app.sheet.locator('[data-address="B5"]')).toHaveText("10");
    await app.sheet.locator('[data-address="B5"]').click();
    await expect(app.sheet.getByLabel("Raw input for B5")).toHaveValue("=A5*2");

    await editCell(app, "A7", "2");
    await selectRange(app, "A7", "E7");
    await clickToolbarCommand(app, "Data and structure commands", "Fill right");
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="E7"]')).toHaveText("2");
  });

  test("08 drag, cancel, commit, and undo a numeric fill series", async ({ page }) => {
    const app = harness(page);
    await editCell(app, "A1", "1");
    await editCell(app, "A2", "2");
    await selectRange(app, "A1", "A2");
    const revisionBeforeDrag = (await workbookStatus(page)).revision;

    await beginFillPreview(app, "A1:A2", "A5");
    await page.keyboard.press("Escape");
    await expect(app.sheet.getByRole("status").filter({ hasText: "Fill preview" })).toHaveCount(0);
    await page.mouse.up();
    await waitIdle(app.sheet);
    expect((await workbookStatus(page)).revision).toBe(revisionBeforeDrag);
    await expect(app.sheet.locator('[data-address="A3"]')).toHaveText("");

    await beginFillPreview(app, "A1:A2", "A5");
    await page.keyboard.down("Alt");
    await expect(app.sheet.getByRole("status").filter({ hasText: "Fill preview" })).toHaveCount(0);
    await page.mouse.up();
    await page.keyboard.up("Alt");
    await waitIdle(app.sheet);
    expect((await workbookStatus(page)).revision).toBe(revisionBeforeDrag);

    await beginFillPreview(app, "A1:A2", "A5");
    await page.mouse.up();
    await waitForCell(app, "A5", "5");
    expect((await workbookStatus(page)).revision).toBe(revisionBeforeDrag + 1);
    await expect(app.sheet.locator('[data-address="A3"]')).toHaveText("3");
    await expect(app.sheet.locator('[data-address="A5"]')).toHaveText("5");

    await app.sheet.getByRole("button", { name: "Undo" }).click();
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveText("1");
    await expect(app.sheet.locator('[data-address="A2"]')).toHaveText("2");
    await expect(app.sheet.locator('[data-address="A3"]')).toHaveText("");
    await expect(app.sheet.locator('[data-address="A5"]')).toHaveText("");

    await editCell(app, "A3", "4");
    await selectRange(app, "A1", "A3");
    await beginFillPreview(app, "A1:A3", "A5");
    await page.mouse.up();
    await waitForCell(app, "A5", "2");
    await expect(app.sheet.locator('[data-address="A3"]')).toHaveText("4");
    await expect(app.sheet.locator('[data-address="A4"]')).toHaveText("1");
  });

  test("09 undo, redo, and divergent history", async ({ page }) => {
    const app = harness(page);
    await editCell(app, "A1", "first");
    await app.sheet.getByRole("button", { name: "Bold" }).click();
    await waitIdle(app.sheet);
    await app.sheet.getByRole("button", { name: "Undo" }).click();
    await waitIdle(app.sheet);
    await expect(app.sheet.getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "false");
    await app.sheet.getByRole("button", { name: "Undo" }).click();
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveText("");
    await app.sheet.getByRole("button", { name: "Redo" }).click();
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveText("first");
    await editCell(app, "A2", "diverged");
    await expect(app.sheet.getByRole("button", { name: "Redo" })).toBeDisabled();
  });

  test("10 format a selection", async ({ page }) => {
    const app = harness(page);
    await editCell(app, "A1", "0.25");
    await app.sheet.locator('[data-address="A1"]').click();
    await app.sheet.getByRole("button", { name: "Bold" }).click();
    await waitIdle(app.sheet);
    await clickToolbarCommand(app, "More formatting commands", "Italic");
    await waitIdle(app.sheet);
    await clickToolbarCommand(app, "More formatting commands", "Wrap text");
    await waitIdle(app.sheet);
    await clickToolbarCommand(app, "More formatting commands", "Increase decimals");
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveText("0.3");
    await clickToolbarCommand(app, "More formatting commands", "Decrease decimals");
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveText("0");
    await openToolbarMenu(app, "More formatting commands");
    await app.sheet.getByLabel("Number format").selectOption("percent");
    await waitIdle(app.sheet);
    await openToolbarMenu(app, "More formatting commands");
    await app.sheet.getByLabel("Horizontal alignment").selectOption("center");
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveText("25%");
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveCSS("font-weight", "700");
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveCSS("font-style", "italic");
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveCSS("text-align", "center");
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveCSS("white-space", "normal");
    await openToolbarMenu(app, "More formatting commands");
    await expect(app.sheet.getByRole("button", { name: "Wrap text" })).toHaveAttribute("aria-pressed", "true");

    await clickToolbarCommand(app, "More formatting commands", "Increase decimals");
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveText("25.0%");
    await clickToolbarCommand(app, "More formatting commands", "Decrease decimals");
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveText("25%");

    await setToolbarColor(app, "Text color", "#123456");
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveCSS("color", "rgb(18, 52, 86)");
    await setToolbarColor(app, "Fill color", "#654321");
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveCSS("background-color", "rgb(101, 67, 33)");
    await expect(app.sheet.getByLabel("Raw input for A1")).toHaveValue("0.25");

    await clickToolbarCommand(app, "More formatting commands", "Clear formatting");
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveText("0.25");
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveCSS("font-weight", "400");
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveCSS("font-style", "normal");
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveCSS("white-space", "nowrap");
    await expect(app.sheet.getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "false");
    await openToolbarMenu(app, "More formatting commands");
    await expect(app.sheet.getByRole("button", { name: "Wrap text" })).toHaveAttribute("aria-pressed", "false");
    await expect(app.sheet.getByLabel("Text color")).toHaveValue("#e8edf5");
    await expect(app.sheet.getByLabel("Fill color")).toHaveValue("#0d1016");
    await expect(app.sheet.getByLabel("Raw input for A1")).toHaveValue("0.25");
  });

  test("11 manage sheets and cross-sheet formulas", async ({ page }) => {
    const app = harness(page);
    await editCell(app, "A1", "7");
    await app.sheet.getByRole("button", { name: "Add sheet" }).click();
    let dialog = app.sheet.getByRole("dialog", { name: "Add sheet" });
    await dialog.getByLabel("Sheet name").fill("Data Set");
    await dialog.getByRole("button", { name: "Add sheet" }).click();
    await waitIdle(app.sheet);
    const firstSheetTab = app.sheet.getByRole("tab", { name: "Sheet1" });
    await firstSheetTab.focus();
    await firstSheetTab.press("ArrowRight");
    await waitIdle(app.sheet);
    await expect(app.sheet.getByRole("tab", { name: "Data Set" })).toBeFocused();
    await expect(app.sheet.getByRole("tab", { name: "Data Set" })).toHaveAttribute("aria-selected", "true");
    await editCell(app, "A1", "11");
    await app.sheet.getByRole("tab", { name: "Sheet1" }).click();
    await editCell(app, "B1", "='Data Set'!A1");
    await expect(app.sheet.locator('[data-address="B1"]')).toHaveText("11");
    await app.sheet.getByRole("tab", { name: "Data Set" }).click();
    await clickSheetAction(app, "Rename current sheet");
    dialog = app.sheet.getByRole("dialog", { name: "Rename sheet" });
    await dialog.getByLabel("Sheet name").fill("Inputs");
    await dialog.getByRole("button", { name: "Rename sheet" }).click();
    await waitIdle(app.sheet);
    await app.sheet.getByRole("tab", { name: "Sheet1" }).click();
    await app.sheet.locator('[data-address="B1"]').click();
    await expect(app.sheet.getByLabel("Raw input for B1")).toHaveValue("=Inputs!A1");
    await app.sheet.getByRole("tab", { name: "Inputs" }).click();
    await clickSheetAction(app, "Delete current sheet");
    dialog = app.sheet.getByRole("dialog", { name: "Delete sheet" });
    await dialog.getByRole("button", { name: "Delete sheet" }).click();
    await waitIdle(app.sheet);
    await expect(app.sheet.getByRole("tab", { name: "Inputs" })).toHaveCount(0);
    await expect(app.sheet.locator('[data-address="B1"]')).toHaveText("#REF!");
    await expectRaw(app, "B1", "=#REF!");
  });

  test("12 insert, delete, and resize rows and columns", async ({ page }) => {
    const app = harness(page);
    await editCell(app, "A1", "1");
    await editCell(app, "A2", "2");
    await editCell(app, "B1", "=A2");
    await app.sheet.locator('[data-address="A2"]').click();
    await clickToolbarCommand(app, "Data and structure commands", "Insert row");
    await waitIdle(app.sheet);
    await expectRaw(app, "B1", "=A3");
    await expect(app.sheet.locator('[data-address="B1"]')).toHaveText("2");
    await app.sheet.locator('[data-address="A2"]').click();
    await clickToolbarCommand(app, "Data and structure commands", "Delete row");
    await waitIdle(app.sheet);
    await expectRaw(app, "B1", "=A2");
    await expect(app.sheet.locator('[data-address="B1"]')).toHaveText("2");
    await app.sheet.locator('[data-address="A1"]').click();
    await clickToolbarCommand(app, "Data and structure commands", "Insert column");
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="B1"]')).toHaveText("1");
    await expectRaw(app, "C1", "=B2");
    await expect(app.sheet.locator('[data-address="C1"]')).toHaveText("2");
    await app.sheet.locator('[data-address="A1"]').click();
    await clickToolbarCommand(app, "Data and structure commands", "Delete column");
    await waitIdle(app.sheet);
    await expectRaw(app, "B1", "=A2");
    await expect(app.sheet.locator('[data-address="B1"]')).toHaveText("2");

    await app.sheet.locator('[data-address="B2"]').click();
    const selectionBeforeResize = await app.sheet.locator('[data-tid="spreadsheet-selection-summary"]').textContent();
    const beforeColumnDrag = await workbookStatus(page);
    const columnDrag = await beginHeaderResize(app, "column", "A", -100);
    expect(columnDrag.size).toBe(24);
    expect(Math.round(await cellDimension(app, "A1", "width"))).toBe(24);
    await expect(app.sheet.getByLabel("Go to cell address")).toHaveValue("B2");
    await expect(app.sheet.locator('.column-header[aria-colindex="1"]')).toHaveAttribute("aria-selected", "false");
    await expect(app.sheet.locator('[data-tid="spreadsheet-selection-summary"]')).toHaveText(selectionBeforeResize ?? "");
    expect((await workbookStatus(page)).revision).toBe(beforeColumnDrag.revision);
    await page.mouse.up();
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-tid="spreadsheet-dimension-resize-status"]')).toBeHidden();
    const afterColumnDrag = await workbookStatus(page);
    expect(afterColumnDrag.revision).toBe(beforeColumnDrag.revision + 1);
    expect(afterColumnDrag.sheets[0].columnWidths["0"]).toBe(24);

    const beforeCancelledDrag = await workbookStatus(page);
    await beginHeaderResize(app, "column", "A", 40);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(app.sheet.locator('[data-tid="spreadsheet-dimension-resize-status"]')).toBeHidden();
    expect(Math.round(await cellDimension(app, "A1", "width"))).toBe(24);
    expect((await workbookStatus(page)).revision).toBe(beforeCancelledDrag.revision);

    const beforeRowDrag = await workbookStatus(page);
    const rowDrag = await beginHeaderResize(app, "row", "1", 12);
    expect(rowDrag.size).toBe(40);
    expect(Math.round(await cellDimension(app, "A1", "height"))).toBe(40);
    await expect(app.sheet.getByLabel("Go to cell address")).toHaveValue("B2");
    await expect(app.sheet.locator('.row-header[data-grid-row="0"]')).toHaveAttribute("aria-selected", "false");
    expect((await workbookStatus(page)).revision).toBe(beforeRowDrag.revision);
    await page.mouse.up();
    await waitIdle(app.sheet);
    const afterRowDrag = await workbookStatus(page);
    expect(afterRowDrag.revision).toBe(beforeRowDrag.revision + 1);
    expect(afterRowDrag.sheets[0].rowHeights["0"]).toBe(40);

    await app.sheet.locator('[data-address="A1"]').click();
    await clickToolbarCommand(app, "Data and structure commands", "Column width…");
    let dialog = app.sheet.getByRole("dialog", { name: "Resize column A" });
    await dialog.getByLabel("Size in pixels").fill("180");
    await dialog.getByRole("button", { name: "Apply size" }).click();
    await waitIdle(app.sheet);
    expect(await app.sheet.locator('[data-address="A1"]').evaluate((element) => Math.round(element.getBoundingClientRect().width))).toBe(180);
    await clickToolbarCommand(app, "Data and structure commands", "Row height…");
    dialog = app.sheet.getByRole("dialog", { name: "Resize row 1" });
    await dialog.getByLabel("Size in pixels").fill("48");
    await dialog.getByRole("button", { name: "Apply size" }).click();
    await waitIdle(app.sheet);
    expect(await app.sheet.locator('[data-address="A1"]').evaluate((element) => Math.round(element.getBoundingClientRect().height))).toBe(48);
  });

  test("13 navigate offscreen and preserve focus", async ({ page }) => {
    const app = harness(page);
    await goTo(app, "BC250");
    await expect(app.sheet.getByLabel("Go to cell address")).toHaveValue("BC250");
    await expect(app.sheet.getByTitle("Visible grid window")).toContainText("AS225:BL274");
    await app.sheet.getByLabel("Previous 50 rows").click();
    await waitIdle(app.sheet);
    await expect(app.sheet.getByLabel("Go to cell address")).toHaveValue("BC200");
    await page.keyboard.press("Shift+Enter");
    await expect(app.sheet.getByLabel("Go to cell address")).toHaveValue("BC199");
    await page.keyboard.press("F6");
    await expect(app.sheet.getByRole("tab", { name: "Sheet1" })).toBeFocused();
    await page.keyboard.press("F6");
    await expect(app.sheet.locator('summary[aria-label="File and demo commands"]')).toBeFocused();
    await page.keyboard.press("F6");
    await expect(app.sheet.getByLabel("Raw input for BC199")).toBeFocused();
    await page.keyboard.press("F6");
    await expect(app.sheet.locator('[data-address="BC199"]')).toBeFocused();
    await page.keyboard.press("Shift+F6");
    await expect(app.sheet.getByLabel("Raw input for BC199")).toBeFocused();
    await page.keyboard.press("Shift+F6");
    await expect(app.sheet.locator('summary[aria-label="File and demo commands"]')).toBeFocused();
    await page.keyboard.press("Shift+F6");
    await expect(app.sheet.getByRole("tab", { name: "Sheet1" })).toBeFocused();
    await page.keyboard.press("Shift+F6");
    await expect(app.sheet.locator('[data-address="BC199"]')).toBeFocused();

    const formatSummary = app.sheet.locator('summary[aria-label="More formatting commands"]');
    await formatSummary.focus();
    await formatSummary.press("Enter");
    await expect(app.sheet.locator(".toolbar-menu[open]")).toHaveCount(1);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Escape");
    await expect(formatSummary).toBeFocused();
    await expect(app.sheet.locator(".toolbar-menu[open]")).toHaveCount(0);

    await goTo(app, "A1");
    await page.keyboard.press("Control+Space");
    await expect(app.sheet.locator('[data-tid="spreadsheet-selection-summary"]')).toHaveText("A1:A100000 · Metrics unavailable outside loaded grid");
    await app.sheet.locator('[data-address="A1"]').click();
    await page.keyboard.press("Shift+Space");
    await expect(app.sheet.locator('[data-tid="spreadsheet-selection-summary"]')).toHaveText("A1:ALL1 · Metrics unavailable outside loaded grid");
  });

  test("14 sort stable table data", async ({ page }) => {
    const app = harness(page);
    const status = await workbookStatus(page);
    await applySystemOperations(page, [{ type: "set_cells", sheetId: status.sheets[0].id, start: "A1", values: [
      [{ kind: "text", value: "Key" }, { kind: "text", value: "Name" }],
      [{ kind: "number", value: 2 }, { kind: "text", value: "second" }],
      [{ kind: "number", value: 1 }, { kind: "text", value: "first-a" }],
      [{ kind: "number", value: 1 }, { kind: "text", value: "first-b" }],
      [{ kind: "blank" }, { kind: "text", value: "blank-key" }],
    ] }]);
    await waitForCell(app, "B5", "blank-key");
    await selectRange(app, "B2", "A5");
    await clickToolbarCommand(app, "Data and structure commands", "Sort A–Z");
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="B2"]')).toHaveText("first-a");
    await expect(app.sheet.locator('[data-address="B3"]')).toHaveText("first-b");
    await clickToolbarCommand(app, "Data and structure commands", "Sort Z–A");
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="B2"]')).toHaveText("second");
    await expect(app.sheet.locator('[data-address="B5"]')).toHaveText("blank-key");

    await selectRange(app, "B5", "A1");
    const dataMenu = app.sheet.locator('summary[aria-label="Data and structure commands"]');
    await dataMenu.click();
    await app.sheet.getByLabel("Selection has header row").check();
    await app.sheet.getByRole("button", { name: "Sort A–Z" }).click();
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveText("Key");
    await expect(app.sheet.locator('[data-address="B1"]')).toHaveText("Name");
    await expect(app.sheet.locator('[data-address="B2"]')).toHaveText("first-a");
    await expect(app.sheet.locator('[data-address="B5"]')).toHaveText("blank-key");
  });

  test("15 filter and clear safely", async ({ page }) => {
    const app = harness(page);
    const status = await workbookStatus(page);
    await applySystemOperations(page, [{ type: "set_cells", sheetId: status.sheets[0].id, start: "A1", values: [
      [{ kind: "text", value: "Item" }, { kind: "text", value: "Region" }],
      [{ kind: "text", value: "A" }, { kind: "text", value: "North" }],
      [{ kind: "text", value: "B" }, { kind: "text", value: "South" }],
      [{ kind: "text", value: "C" }, { kind: "text", value: "North" }],
      [{ kind: "text", value: "D" }, { kind: "blank" }],
    ] }]);
    await waitForCell(app, "A5", "D");
    await expect(app.sheet.locator('[data-address="B5"]')).toHaveText("");
    await selectRange(app, "A1", "B5");
    await clickToolbarCommand(app, "Data and structure commands", "Filter…");
    let dialog = app.sheet.getByRole("dialog", { name: "Filter selected range" });
    await dialog.getByLabel("Text to match exactly").fill("North");
    await dialog.getByRole("button", { name: "Apply filter" }).click();
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-tid="spreadsheet-filter-state"]')).toHaveAttribute("aria-label", /2 rows hidden/u);
    await expect(app.sheet.locator('[data-address="A3"]')).toHaveCount(0);
    await expect(app.sheet.locator('[data-address="A5"]')).toHaveCount(0);
    await clickToolbarCommand(app, "Data and structure commands", "Clear filter");
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="A3"]')).toHaveText("B");
    await expect(app.sheet.locator('[data-address="A5"]')).toHaveText("D");

    await selectRange(app, "A1", "B5");
    await clickToolbarCommand(app, "Data and structure commands", "Filter…");
    dialog = app.sheet.getByRole("dialog", { name: "Filter selected range" });
    await dialog.getByRole("radio", { name: "Not blank" }).check();
    await dialog.getByRole("button", { name: "Apply filter" }).click();
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-tid="spreadsheet-filter-state"]')).toHaveAttribute("aria-label", /1 row hidden/u);
    await expect(app.sheet.locator('[data-address="A3"]')).toHaveText("B");
    await expect(app.sheet.locator('[data-address="A5"]')).toHaveCount(0);
  });

  test("16 find and cut-move a range", async ({ page }) => {
    const app = harness(page);
    await editCell(app, "A1", "Needle");
    await editCell(app, "B1", "=A1&\" found\"");
    const findStatus = await workbookStatus(page);
    const directRead = await callSpreadsheetTool(page, "workbook_read", {
      sheetId: findStatus.sheets[0].id,
      range: "A1:B1",
      limit: 1,
    }) as any;
    expect(directRead).toMatchObject({
      workbookId: findStatus.workbookId,
      revision: findStatus.revision,
      sheetId: findStatus.sheets[0].id,
      range: "A1:B1",
    });
    expect(directRead.cells).toHaveLength(1);
    const firstFindPage = await callSpreadsheetTool(page, "workbook_find", { query: "Needle", limit: 1 }) as any;
    expect(firstFindPage).toMatchObject({ workbookId: findStatus.workbookId, revision: findStatus.revision });
    expect(firstFindPage.matches).toHaveLength(1);
    expect(firstFindPage.truncated).toBe(true);
    expect(typeof firstFindPage.nextCursor).toBe("string");
    const secondFindPage = await callSpreadsheetTool(page, "workbook_find", {
      query: "Needle",
      limit: 1,
      cursor: firstFindPage.nextCursor,
    }) as any;
    expect(secondFindPage).toMatchObject({ workbookId: findStatus.workbookId, revision: findStatus.revision });
    expect([secondFindPage.workbookId, secondFindPage.revision]).toEqual([firstFindPage.workbookId, firstFindPage.revision]);
    expect(secondFindPage.matches).toHaveLength(1);
    expect(secondFindPage.matches[0].address).not.toBe(firstFindPage.matches[0].address);
    expect(secondFindPage).toMatchObject({ truncated: false, nextCursor: null });
    await clickToolbarCommand(app, "More edit commands", "Find…");
    const dialog = app.sheet.getByRole("dialog", { name: "Find in workbook" });
    await dialog.getByLabel("Find").fill("Needle");
    await dialog.getByRole("button", { name: "Find", exact: true }).click();
    await expect(dialog.getByRole("button", { name: /Sheet1!A1/ })).toBeVisible();
    await dialog.getByRole("button", { name: /Sheet1!A1/ }).click();
    await expect(app.sheet.locator('[data-address="A1"]')).toBeFocused();

    await selectRange(app, "A1", "B1");
    await clickToolbarCommand(app, "More edit commands", "Cut");
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveClass(/cut-source/);
    await goTo(app, "A3");
    await app.sheet.getByRole("button", { name: "Paste", exact: true }).click();
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveText("");
    await expectRaw(app, "B1", "");
    await expect(app.sheet.locator('[data-address="A3"]')).toHaveText("Needle");
    await expect(app.sheet.locator('[data-address="B3"]')).toHaveText("Needle found");
    await expectRaw(app, "B3", '=A3&" found"');
  });

  test("17 native save and reopen through Files", async ({ page }) => {
    const app = harness(page);
    const path = uniquePath("nsheet");
    await editCell(app, "A1", "lossless");
    await editCell(app, "B1", "=A1&\" workbook\"");
    await app.sheet.locator('[data-address="B1"]').click();
    await app.sheet.getByRole("button", { name: "Bold" }).click();
    await clickToolbarCommand(app, "File and demo commands", "Save as…");
    let dialog = app.sheet.getByRole("dialog", { name: "Save as native workbook" });
    await dialog.getByLabel("Files path").fill(path);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await approveFilesTool(page, "writeBinary");
    await waitIdle(app.sheet);
    const saveCommand = app.sheet.getByRole("button", { name: "Save", exact: true });
    await expect(saveCommand).toHaveAttribute("data-state", "saved");
    await expect(saveCommand).toBeDisabled();
    await expect(app.sheet.locator('[data-tid="spreadsheet-save-state"]')).toHaveCount(0);
    await expectWorkbookPath(app, path);

    await editCell(app, "A1", "latest");
    await expect(app.sheet.locator('[data-address="B1"]')).toHaveText("latest workbook");
    await expect(saveCommand).toHaveAttribute("data-state", "dirty");
    await expect(saveCommand).toBeEnabled();
    await saveCommand.click();
    await waitIdle(app.sheet);
    await expect(saveCommand).toHaveAttribute("data-state", "saved");
    await expect(saveCommand).toBeDisabled();
    await expectWorkbookPath(app, path);

    await clickToolbarCommand(app, "File and demo commands", "New workbook");
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveText("");
    const files = await openFilesTile(page);
    const e2eFolder = files.locator('[role="treeitem"][data-path="/e2e"]');
    await expect(e2eFolder).toBeVisible();
    if (await e2eFolder.getAttribute("aria-expanded") !== "true") await e2eFolder.click();
    const savedFile = files.locator(`[role="treeitem"][data-path="${path}"]`);
    await expect(savedFile).toBeVisible();
    await savedFile.click();
    const openInSpreadsheet = files.locator('button[aria-label="Open in Spreadsheet"]');
    await expect(openInSpreadsheet).toBeEnabled();

    // Prove user denial is non-destructive before approving the real
    // Files-tile -> Spreadsheet attachment handoff.
    await openInSpreadsheet.click();
    let permission = page.locator('[data-tid="frontend-tool-dialog"]');
    await expect(permission).toContainText("files/tile");
    await expect(permission).toContainText("app:spreadsheet:background");
    await expect(permission).toContainText("workbook_accept_file");
    await page.locator('[data-tid="frontend-tool-reject"]').click();
    await expect(files.getByRole("alert")).toBeVisible();
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveText("");
    await files.getByLabel("Dismiss error").click();

    // A Files handoff intentionally refuses a dirty Spreadsheet target rather
    // than presenting a destructive replacement choice inside the caller.
    await editCell(app, "C1", "keep this dirty workbook");
    const dirtyTarget = await workbookStatus(page);
    expect(dirtyTarget.dirty).toBe(true);

    // Kernel deliberately pauses a rejecting app's owner-attention requests
    // for ten seconds so it cannot immediately reprompt the user. Keep a full
    // second of scheduling margin instead of racing the cooldown boundary.
    await page.waitForTimeout(11_000);
    await openInSpreadsheet.click();
    permission = page.locator('[data-tid="frontend-tool-dialog"]');
    await expect(permission).toContainText("files/tile");
    await expect(permission).toContainText("app:spreadsheet:background");
    await expect(permission).toContainText("workbook_accept_file");
    await page.locator('[data-tid="frontend-tool-approve-session"]').click();
    await expect(permission).toHaveCount(0);
    await expect(files.getByRole("alert")).toContainText("Save or explicitly discard the current workbook before replacing it");
    await expect(app.sheet.locator('[data-address="C1"]')).toHaveText("keep this dirty workbook");
    const refusedTarget = await workbookStatus(page);
    expect(refusedTarget).toMatchObject({
      workbookId: dirtyTarget.workbookId,
      revision: dirtyTarget.revision,
      dirty: true,
    });
    await files.getByLabel("Dismiss error").click();

    // The handoff has no destructive bypass. Exercise the Spreadsheet's
    // explicit replacement Cancel path, prove it is non-destructive, then
    // explicitly discard and retry the same Files command.
    await clickToolbarCommand(app, "File and demo commands", "New workbook");
    dialog = app.sheet.getByRole("dialog", { name: "Create new workbook" });
    await expect(dialog).toContainText("Cancel keeps your current work");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(app.sheet.locator('[data-address="C1"]')).toHaveText("keep this dirty workbook");
    const cancelledReplacement = await workbookStatus(page);
    expect(cancelledReplacement).toMatchObject({
      workbookId: dirtyTarget.workbookId,
      revision: dirtyTarget.revision,
      dirty: true,
    });

    await clickToolbarCommand(app, "File and demo commands", "New workbook");
    dialog = app.sheet.getByRole("dialog", { name: "Create new workbook" });
    await dialog.getByRole("button", { name: "Create new workbook" }).click();
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="C1"]')).toHaveText("");
    const discardedTarget = await workbookStatus(page);
    expect(discardedTarget.dirty).toBe(false);
    expect(discardedTarget.workbookId).not.toBe(dirtyTarget.workbookId);

    // The previous handoff focused the existing Spreadsheet tile. Neutron
    // admits app-requested tile focus at most once every two seconds, so a
    // successful user retry must occur after that independent focus window.
    await page.waitForTimeout(2_100);
    await openInSpreadsheet.click();
    await expect(permission).toHaveCount(0);
    // The handoff performs an app-focus request, a binary read, and an
    // attachment-backed Spreadsheet call. Wait for that user action itself to
    // settle before starting the tile-refresh deadline; under a loaded full
    // suite it can legitimately consume most of the ordinary assertion window.
    // Poll authoritative resident state instead of racing Files' intentionally
    // ephemeral Working indicator, which can appear and disappear between two
    // Playwright frames on a fast handoff.
    await expect.poll(async () => (await workbookStatus(page)).nativeSource?.path, { timeout: 60_000 }).toBe(path);
    await expect(files.getByRole("alert")).toHaveCount(0);
    const reopenedStatus = await workbookStatus(page);
    expect(reopenedStatus.nativeSource?.path).toBe(path);
    expect(reopenedStatus.workbookId).not.toBe(discardedTarget.workbookId);
    await waitForCell(app, "B1", "latest workbook");
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveText("latest");
    await expect(app.sheet.locator('[data-address="B1"]')).toHaveCSS("font-weight", "700");
    await expectWorkbookPath(app, path);
  });

  test("18 CSV export safety and import", async ({ page }) => {
    const app = harness(page);
    const path = uniquePath("csv");
    const status = await workbookStatus(page);
    await applySystemOperations(page, [{
      type: "set_cells",
      sheetId: status.sheets[0].id,
      start: "A1",
      values: [
        [{ kind: "text", value: "=2+3" }, { kind: "number", value: 2 }],
        [{ kind: "text", value: "+SUM(A1:A9)" }, { kind: "formula", formula: "=B1*3" }],
        [{ kind: "text", value: "-10+20" }, { kind: "blank" }],
        [{ kind: "text", value: "@cmd" }, { kind: "blank" }],
      ],
    }]);
    await waitForCell(app, "A4", "@cmd");
    await expectRaw(app, "A1", "=2+3");
    await expect(app.sheet.locator('[data-address="A1"]')).not.toHaveAttribute("aria-label", /formula/i);
    await selectRange(app, "A1", "B4");
    await clickToolbarCommand(app, "File and demo commands", "Export current sheet as CSV…");
    let dialog = app.sheet.getByRole("dialog", { name: "Export CSV snapshot" });
    await dialog.getByLabel("New Files destination").fill(path);
    await dialog.getByRole("radio", { name: "Add an apostrophe for safer spreadsheet opening" }).check();
    await dialog.getByRole("button", { name: "Run export preflight" }).click();
    dialog = app.sheet.getByRole("dialog", { name: "Review CSV export" });
    await expect(dialog).toContainText("CSV is a values-only snapshot");
    await expect(dialog).toContainText("formulaCellsFlattened: 1");
    await expect(dialog).toContainText("textCellsHardened: 4");
    await dialog.getByRole("button", { name: "Create CSV snapshot" }).click();
    await approveFilesTool(page, "writeBinary");
    await waitIdle(app.sheet);
    await expect(app.sheet.getByRole("button", { name: "Save", exact: true })).toHaveAttribute("data-state", "dirty");
    await expect(app.sheet.locator('[data-tid="spreadsheet-save-state"]')).toHaveCount(0);

    await clickToolbarCommand(app, "File and demo commands", "New workbook");
    dialog = app.sheet.getByRole("dialog", { name: "Create new workbook" });
    await dialog.getByRole("button", { name: "Create new workbook" }).click();
    await waitIdle(app.sheet);
    await clickToolbarCommand(app, "File and demo commands", "Open from Files…");
    dialog = app.sheet.getByRole("dialog", { name: "Open workbook from Files" });
    await dialog.getByLabel("Files path").fill(path);
    await dialog.getByRole("button", { name: "Open file" }).click();
    await approveFilesTool(page, "readBinary");
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveText("'=2+3");
    await expect(app.sheet.locator('[data-address="A2"]')).toHaveText("'+SUM(A1:A9)");
    await expect(app.sheet.locator('[data-address="A3"]')).toHaveText("'-10+20");
    await expect(app.sheet.locator('[data-address="A4"]')).toHaveText("'@cmd");
    await expect(app.sheet.locator('[data-address="B2"]')).toHaveText("6");
    await expectRaw(app, "A1", "'=2+3");
    await expect(app.sheet.locator('[data-address="A1"]')).not.toHaveAttribute("aria-label", /formula/i);
    await expectRaw(app, "B2", "6");
  });

  test("19 XLSX export and import round-trip", async ({ page }) => {
    const app = harness(page);
    const path = uniquePath("xlsx");
    await clickToolbarCommand(app, "File and demo commands", "Kitchen Sink demo");
    let dialog = app.sheet.getByRole("dialog", { name: "Load Kitchen Sink workbook" });
    await dialog.getByRole("button", { name: "Load Kitchen Sink" }).click();
    await waitIdle(app.sheet);
    await expectKitchenSinkTabs(app);
    const demoStatus = await workbookStatus(page);
    expect(demoStatus.workbookId).toBe("wb_neutron_spreadsheet_kitchen_sink");

    await app.sheet.getByRole("tab", { name: "Read me" }).click();
    await expectCellDimensions(app, "A1", 180, 34);
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveCSS("font-weight", "700");
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveCSS("background-color", "rgb(24, 61, 46)");

    await app.sheet.getByRole("tab", { name: "Sales" }).click();
    await waitIdle(app.sheet);
    await expect(app.sheet.getByRole("tab", { name: "Sales" })).toHaveAttribute("aria-selected", "true");
    await expect(app.sheet.locator('[data-tid="spreadsheet-filter-state"]')).toBeVisible();
    await expect(app.sheet.locator('[data-tid="spreadsheet-filter-state"]')).toHaveAttribute("aria-label", /6 rows hidden/u);
    await expect(app.sheet.locator('[data-address="A3"]')).toHaveCount(0);
    await expect(app.sheet.locator('[data-address="F2"]')).toHaveText("$1548.00");
    await expectRaw(app, "F2", "=D2*E2");

    await app.sheet.getByRole("tab", { name: "Summary" }).click();
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="B4"]')).toHaveText("$13718.00");
    await expectRaw(app, "B4", "=SUM(Sales!F2:F9)");
    await expect(app.sheet.locator('[data-address="B9"]')).toHaveText("$179.00");
    await expectRaw(app, "B9", '=XLOOKUP("Beacon",Inventory!A2:A4,Inventory!C2:C4,"Missing")');

    await app.sheet.getByRole("tab", { name: "Inventory" }).click();
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="E2"]')).toHaveText("$3096.00");
    await expect(app.sheet.locator('[data-address="F3"]')).toHaveText("Yes");
    await expect(app.sheet.locator('[data-address="C7"]')).toHaveText("$179.00");
    await expectRaw(app, "C7", '=XLOOKUP(B7,A2:A4,C2:C4,"Missing")');

    await app.sheet.getByRole("tab", { name: "Formula gallery" }).click();
    await waitIdle(app.sheet);
    const formulaGallery: ReadonlyArray<readonly [string, string, string | RegExp]> = [
      ["SUM", "=SUM($G$2:$G$4)", "60"],
      ["AVERAGE", "=AVERAGE($G$2:$G$4)", "20"],
      ["MIN", "=MIN($G$2:$G$4)", "10"],
      ["MAX", "=MAX($G$2:$G$4)", "30"],
      ["COUNT", "=COUNT($G$2:$G$4)", "3"],
      ["COUNTA", "=COUNTA($H$2:$H$4)", "3"],
      ["IF", '=IF($G$2>5,"yes","no")', "yes"],
      ["IFERROR", '=IFERROR(1/0,"handled")', "handled"],
      ["ROUND", "=ROUND(10/3,2)", "3.33"],
      ["ABS", "=ABS(-7)", "7"],
      ["COUNTIF", '=COUNTIF($G$2:$G$4,">15")', "2"],
      ["SUMIF", '=SUMIF($H$2:$H$4,"Beta",$G$2:$G$4)', "20"],
      ["XLOOKUP", '=XLOOKUP("Beta",$H$2:$H$4,$I$2:$I$4,"missing")', "200"],
      ["VLOOKUP", '=VLOOKUP("Beta",$H$2:$I$4,2,FALSE)', "200"],
      ["INDEX", "=INDEX($G$2:$G$4,2)", "20"],
      ["MATCH", "=MATCH(20,$G$2:$G$4,0)", "2"],
      ["TEXTJOIN", '=TEXTJOIN(" · ",TRUE,$H$2:$H$4)', "Alpha · Beta · Gamma"],
      ["DATE", "=DATE(2026,7,14)", "2026-07-14"],
      ["TODAY", "=TODAY()", /^\d{4}-\d{2}-\d{2}$/u],
      ["NOW", "=NOW()", /^\d{2}:\d{2}:\d{2}$/u],
      ["Error example", "=1/0", "#DIV/0!"],
    ];

    const beforeHelp = await workbookStatus(page);
    const overviewHelp = await callSpreadsheetTool(page, "workbook_help", {}) as any;
    expect(overviewHelp).toMatchObject({ version: 1, topic: "overview" });
    expect(JSON.stringify(overviewHelp.sections)).toContain("workbook_apply");
    const formulaHelp = await callSpreadsheetTool(page, "workbook_help", { topic: "formulas" }) as any;
    expect(formulaHelp.sections.flatMap((section: { items: string[] }) => section.items).join(" ")).toContain('{"kind":"formula"');
    expect(JSON.stringify(formulaHelp.sections)).toContain("JavaScript");
    const functionHelp = await callSpreadsheetTool(page, "workbook_help", { topic: "functions" }) as any;
    expect(functionHelp.functions.map((guide: { name: string }) => guide.name)).toEqual(
      formulaGallery.slice(0, -1).map(([name]) => name),
    );
    const vlookupHelp = await callSpreadsheetTool(page, "workbook_help", { topic: "function", functionName: "vlookup" }) as any;
    expect(vlookupHelp.functions).toHaveLength(1);
    expect(vlookupHelp.functions[0]).toMatchObject({ name: "VLOOKUP", minimumArguments: 4, maximumArguments: 4 });
    expect(vlookupHelp.functions[0].example).toContain("FALSE");
    expect(vlookupHelp.functions[0].notes.join(" ")).toMatch(/exact/i);
    expect((await workbookStatus(page)).revision).toBe(beforeHelp.revision);

    expect(formulaGallery.slice(0, -1).map(([name]) => name)).toEqual(demoStatus.capabilities.formulaFunctions);
    for (const [index, [name, formula, display]] of formulaGallery.entries()) {
      const row = index + 4;
      await expect(app.sheet.locator(`[data-address="A${row}"]`)).toHaveText(name);
      await expect(app.sheet.locator(`[data-address="B${row}"]`)).toHaveText(display);
      await expectRaw(app, `B${row}`, formula);
    }

    await app.sheet.getByRole("tab", { name: "Formats" }).click();
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="C9"]')).toHaveText("15:30:00");
    await expectRaw(app, "C9", "0.6458333333");
    await expect(app.sheet.locator('[data-address="C9"]')).toHaveCSS("text-align", "center");
    await expectCellDimensions(app, "C12", 230, 56);
    await expect(app.sheet.locator('[data-address="C12"]')).toHaveCSS("white-space", "normal");

    await clickToolbarCommand(app, "File and demo commands", "Export workbook as XLSX…");
    dialog = app.sheet.getByRole("dialog", { name: "Export XLSX snapshot" });
    await dialog.getByLabel("New Files destination").fill(path);
    await dialog.getByRole("button", { name: "Run export preflight" }).click();
    dialog = app.sheet.getByRole("dialog", { name: "Review XLSX export" });
    await expect(dialog).toContainText("XLSX snapshot omitted 1 filtersDropped");
    await expect(dialog).toContainText("XLSX snapshot omitted 30 columnWidthsDropped");
    await expect(dialog).toContainText("XLSX snapshot omitted 7 rowHeightsDropped");
    await expect(dialog).toContainText("filtersDropped: 1");
    await expect(dialog).toContainText("columnWidthsDropped: 30");
    await expect(dialog).toContainText("rowHeightsDropped: 7");
    await dialog.getByRole("button", { name: "Create XLSX snapshot" }).click();
    await approveFilesTool(page, "writeBinary");
    await waitIdle(app.sheet);

    await clickToolbarCommand(app, "File and demo commands", "New workbook");
    dialog = app.sheet.getByRole("dialog", { name: "Create new workbook" });
    await dialog.getByRole("button", { name: "Create new workbook" }).click();
    await waitIdle(app.sheet);
    await clickToolbarCommand(app, "File and demo commands", "Open from Files…");
    dialog = app.sheet.getByRole("dialog", { name: "Open workbook from Files" });
    await dialog.getByLabel("Files path").fill(path);
    await dialog.getByRole("button", { name: "Open file" }).click();
    await approveFilesTool(page, "readBinary");
    await waitIdle(app.sheet);
    await expectKitchenSinkTabs(app);

    await app.sheet.getByRole("tab", { name: "Sales" }).click();
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-tid="spreadsheet-filter-state"]')).toHaveCount(0);
    await expect(app.sheet.locator('[data-address="F2"]')).toHaveText("$1548.00");
    await expectRaw(app, "F2", "=D2*E2");

    await app.sheet.getByRole("tab", { name: "Summary" }).click();
    await expect(app.sheet.locator('[data-address="B4"]')).toHaveText("$13718.00");
    await expectRaw(app, "B4", "=SUM(Sales!F2:F9)");
    await expect(app.sheet.locator('[data-address="B4"]')).toHaveCSS("text-align", "right");

    await app.sheet.getByRole("tab", { name: "Inventory" }).click();
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="E2"]')).toHaveText("$3096.00");
    await expect(app.sheet.locator('[data-address="C7"]')).toHaveText("$179.00");

    await app.sheet.getByRole("tab", { name: "Formula gallery" }).click();
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="B17"]')).toHaveText("200");
    await expect(app.sheet.locator('[data-address="B24"]')).toHaveText("#DIV/0!");

    await app.sheet.getByRole("tab", { name: "Formats" }).click();
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="C9"]')).toHaveText("15:30:00");
    await expectRaw(app, "C9", "0.6458333333");
    await expect(app.sheet.locator('[data-address="C9"]')).toHaveCSS("text-align", "center");

    await app.sheet.getByRole("tab", { name: "Read me" }).click();
    await waitIdle(app.sheet);
    await expectCellDimensions(app, "A1", 96, 28);
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveCSS("background-color", "rgb(24, 61, 46)");
  });

  test("20 concurrent updates and resident recovery preserve human work", async ({ page }) => {
    const app = harness(page);
    await editCell(app, "A1", "original");
    await app.sheet.locator('[data-address="A1"]').dblclick();
    const editor = app.sheet.getByLabel("Raw input for A1");
    await editor.fill("my draft");
    let status = await workbookStatus(page);
    const staleRevision = status.revision;
    await applySystemOperations(page, [{
      type: "set_cells", sheetId: status.sheets[0].id, start: "A1",
      values: [[{ kind: "text", value: "external value" }]],
    }]);

    const staleError = await callSpreadsheetTool(page, "workbook_apply", {
      action: "apply",
      expectedRevision: staleRevision,
      commandId: `e2e-stale-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
      operations: [{
        type: "set_cells",
        sheetId: status.sheets[0].id,
        start: "D1",
        values: [[{ kind: "text", value: "must be rejected" }]],
      }],
    }).then(() => null, (error: unknown) => error);
    expect(staleError).toBeInstanceOf(Error);
    expect(String(staleError)).toMatch(/REVISION_CONFLICT|current revision/i);
    expect((await workbookStatus(page)).revision).toBe(staleRevision + 1);
    await expect(app.sheet.locator('[data-address="D1"]')).toHaveText("");

    await expect(app.sheet.locator('[data-tid="spreadsheet-notice"]')).toContainText("Your draft is preserved");
    await expect(editor).toHaveValue("my draft");
    await editor.press("Enter");
    let dialog = app.sheet.getByRole("dialog", { name: "This cell changed while you were editing" });
    await expect(dialog).toContainText("external value");
    await dialog.getByRole("button", { name: "Reapply my draft" }).click();
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveText("my draft");

    await app.sheet.locator('[data-address="B1"]').dblclick();
    await app.sheet.getByLabel("Raw input for B1").fill("other-cell draft");
    status = await workbookStatus(page);
    await applySystemOperations(page, [{
      type: "set_cells", sheetId: status.sheets[0].id, start: "C1",
      values: [[{ kind: "text", value: "external elsewhere" }]],
    }]);
    await waitForCell(app, "C1", "external elsewhere");
    await app.sheet.getByLabel("Raw input for B1").press("Enter");
    await waitIdle(app.sheet);
    await expect(app.sheet.locator('[data-address="B1"]')).toHaveText("other-cell draft");
    await expect(app.sheet.locator('[data-address="C1"]')).toHaveText("external elsewhere");
    await expect(app.sheet.getByRole("dialog")).toHaveCount(0);

    // A resident restart creates a fresh live workbook whose revision may be
    // lower than the tile's last observed revision. The tile must recognize
    // the new workbook identity, surface the durable local checkpoint, and
    // restore it only after the human explicitly chooses recovery.
    await editCell(app, "D1", "resident recovery");
    const beforeRestart = await workbookStatus(page);
    await restartSpreadsheetResident(page);

    const recovery = app.sheet.getByRole("alertdialog", { name: "Recovery draft found" });
    await expect(recovery).toBeVisible({ timeout: 20_000 });
    await expect(recovery).toContainText("A newer local draft is waiting");
    await recovery.getByRole("button", { name: "Recover draft" }).click();
    await waitForCell(app, "D1", "resident recovery");
    const recovered = await workbookStatus(page);
    expect(recovered.recovery.pending).toBe(false);
    expect(recovered.workbookId).toBe(beforeRestart.workbookId);
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveText("my draft");
    await expect(app.sheet.locator('[data-address="B1"]')).toHaveText("other-cell draft");
    await expect(app.sheet.locator('[data-address="C1"]')).toHaveText("external elsewhere");

    // Exercise the other explicit recovery choice without adding a 21st flow.
    // Discard keeps the restarted resident's fresh workbook and removes the
    // checkpoint instead of silently restoring it.
    await editCell(app, "D2", "discard this checkpoint");
    await restartSpreadsheetResident(page);
    const discardRecovery = app.sheet.getByRole("alertdialog", { name: "Recovery draft found" });
    await expect(discardRecovery).toBeVisible({ timeout: 20_000 });
    await expect(app.sheet.getByRole("grid", { name: "Spreadsheet grid" })).toHaveAttribute("aria-disabled", "true");
    const discardButton = discardRecovery.getByRole("button", { name: "Discard recovery draft" });
    await expect(discardButton).toBeFocused();
    await discardButton.click();
    await waitForCell(app, "D2", "");
    const discarded = await workbookStatus(page);
    expect(discarded.recovery.pending).toBe(false);
    expect(discarded.workbookId).not.toBe(recovered.workbookId);
    await expect(app.sheet.locator('[data-address="A1"]')).toHaveText("");
  });
});

function harness(page: Page): SpreadsheetHarness {
  const value = harnesses.get(page);
  if (!value) throw new Error("Spreadsheet harness was not initialized");
  return value;
}

async function waitForCell(app: SpreadsheetHarness, address: string, value: string): Promise<void> {
  await expect.poll(async () => app.sheet.locator(`[data-address="${address}"]`).textContent()).toBe(value);
}

async function drainSpreadsheetEvents(page: Page): Promise<void> {
  if (page.isClosed()) return;
  await page.evaluate(() => new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    window.setTimeout(finish, 75);
    requestAnimationFrame(() => requestAnimationFrame(finish));
  })).catch(() => undefined);
  if (!page.isClosed()) await page.waitForTimeout(0);
}

async function restartSpreadsheetResident(page: Page): Promise<void> {
  await page
    .frameLocator('[data-tid="app-background-frame"][data-app-id="spreadsheet"]')
    .locator("body")
    .evaluate(() => window.location.reload())
    .catch(() => undefined);
}

type SurfaceFailure = {
  source: "pageerror" | "console.error" | "requestfailed" | "http";
  detail: string;
};

type ToolbarMenuName =
  | "File and demo commands"
  | "More edit commands"
  | "More formatting commands"
  | "Data and structure commands";

function monitorSpreadsheetSurface(page: Page): SurfaceFailure[] {
  const failures: SurfaceFailure[] = [];
  page.on("pageerror", (error) => {
    const detail = error.stack || error.message;
    if (isSpreadsheetDiagnostic(detail)) failures.push({ source: "pageerror", detail });
  });
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() !== "error") return;
    const location = message.location();
    if (isSpreadsheetUrl(location.url) || (!location.url && /^\[Spreadsheet\]/u.test(message.text()))) {
      failures.push({
        source: "console.error",
        detail: `${message.text()}${location.url ? ` (${location.url}:${location.lineNumber ?? 0})` : ""}`,
      });
    }
  });
  page.on("requestfailed", (request: Request) => {
    if (isSpreadsheetRequest(request)) {
      failures.push({
        source: "requestfailed",
        detail: `${request.method()} ${request.url()} — ${request.failure()?.errorText ?? "unknown failure"}`,
      });
    }
  });
  page.on("response", (response: Response) => {
    if (response.status() >= 400 && isSpreadsheetRequest(response.request())) {
      failures.push({
        source: "http",
        detail: `${response.status()} ${response.request().method()} ${response.url()}`,
      });
    }
  });
  return failures;
}

function isSpreadsheetRequest(request: Request): boolean {
  if (isSpreadsheetUrl(request.url())) return true;
  try {
    return isSpreadsheetUrl(request.frame().url());
  } catch {
    return false;
  }
}

function isSpreadsheetDiagnostic(detail: string): boolean {
  return /(?:\/app\/spreadsheet\/|aspreadsheeta--)/iu.test(detail);
}

function isSpreadsheetUrl(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.pathname.includes("/app/spreadsheet/")
      || parsed.searchParams.get("app") === "spreadsheet"
      || parsed.hostname.startsWith("aspreadsheeta--");
  } catch {
    return isSpreadsheetDiagnostic(url);
  }
}

async function openToolbarMenu(app: SpreadsheetHarness, name: ToolbarMenuName): Promise<void> {
  const summary = app.sheet.locator(`summary[aria-label="${name}"]`);
  const details = summary.locator("xpath=..");
  if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open))) await summary.click();
  await expect(details).toHaveAttribute("open", "");
}

async function clickToolbarCommand(
  app: SpreadsheetHarness,
  menu: ToolbarMenuName,
  command: string,
): Promise<void> {
  await openToolbarMenu(app, menu);
  const panel = app.sheet.locator(`details:has(> summary[aria-label="${menu}"]) > .toolbar-menu-panel`);
  const button = panel.getByRole("button", { name: command, exact: true });
  await expect(button).toBeVisible();
  await button.click();
}

async function clickSheetAction(
  app: SpreadsheetHarness,
  command: "Rename current sheet" | "Delete current sheet",
): Promise<void> {
  const summary = app.sheet.getByRole("button", { name: "Sheet actions" });
  const menu = app.sheet.locator(".sheet-menu");
  if (!(await menu.evaluate((element) => (element as HTMLDetailsElement).open))) await summary.click();
  const button = app.sheet.locator(".sheet-menu-panel").getByRole("button", { name: command, exact: true });
  await expect(button).toBeVisible();
  await button.click();
}

async function setToolbarColor(
  app: SpreadsheetHarness,
  name: "Text color" | "Fill color",
  value: string,
): Promise<void> {
  await openToolbarMenu(app, "More formatting commands");
  const control = app.sheet.getByLabel(name);
  await control.evaluate((element, nextValue) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) throw new Error("The native color input value setter is unavailable");
    setter.call(element, nextValue);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
  await waitIdle(app.sheet);
  await expect(control).toHaveValue(value.toLocaleLowerCase("en-US"));
}

async function beginFillPreview(app: SpreadsheetHarness, source: string, target: string): Promise<void> {
  const handle = app.sheet.getByRole("button", { name: `Drag to fill from ${source}` });
  const handleBox = await handle.boundingBox();
  const targetBox = await app.sheet.locator(`[data-address="${target}"]`).boundingBox();
  if (!handleBox || !targetBox) throw new Error(`Fill drag targets ${source} → ${target} are unavailable`);
  await app.page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await app.page.mouse.down();
  await app.page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 6 });
  await expect(app.sheet.getByRole("status").filter({ hasText: `Fill preview ${source.split(":")[0]}:${target}` })).toBeVisible();
}

async function dragFormulaReference(app: SpreadsheetHarness, source: string, target: string): Promise<void> {
  const sourceCell = app.sheet.locator(`[data-address="${source}"]`);
  const targetCell = app.sheet.locator(`[data-address="${target}"]`);
  const sourceBox = await sourceCell.boundingBox();
  const targetBox = await targetCell.boundingBox();
  if (!sourceBox || !targetBox) throw new Error(`Formula reference targets ${source} → ${target} are unavailable`);
  await app.page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await app.page.mouse.down();
  await app.page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 6 });
  await app.page.mouse.up();
}

async function beginHeaderResize(
  app: SpreadsheetHarness,
  axis: "column" | "row",
  label: string,
  delta: number,
): Promise<{ start: number; size: number }> {
  const handle = app.sheet.getByRole("separator", { name: `Resize ${axis} ${label}`, exact: true });
  const header = handle.locator("xpath=..");
  const handleBox = await handle.boundingBox();
  if (!handleBox) throw new Error(`Resize handle for ${axis} ${label} is unavailable`);
  const start = Math.round(await header.evaluate((element, resizeAxis) => {
    const rect = element.getBoundingClientRect();
    return resizeAxis === "column" ? rect.width : rect.height;
  }, axis));
  const minimum = axis === "column" ? 24 : 18;
  const maximum = axis === "column" ? 600 : 300;
  const size = Math.max(minimum, Math.min(maximum, start + delta));
  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  await app.page.mouse.move(startX, startY);
  await app.page.mouse.down();
  await app.page.mouse.move(startX + (axis === "column" ? delta : 0), startY + (axis === "row" ? delta : 0), { steps: 8 });
  const readout = app.sheet.locator('[data-tid="spreadsheet-dimension-resize-status"]');
  await expect(readout).toBeVisible();
  await expect(readout).toHaveText(axis === "column" ? `${label} · ${size} px` : `Row ${label} · ${size} px`);
  await expect(handle).toHaveAttribute("aria-valuenow", String(size));
  return { start, size };
}

async function cellDimension(
  app: SpreadsheetHarness,
  address: string,
  axis: "width" | "height",
): Promise<number> {
  return app.sheet.locator(`[data-address="${address}"]`).evaluate((element, dimension) => element.getBoundingClientRect()[dimension], axis);
}

async function expectRaw(app: SpreadsheetHarness, address: string, raw: string): Promise<void> {
  await app.sheet.locator(`[data-address="${address}"]`).click();
  await expect(app.sheet.getByLabel(`Raw input for ${address}`)).toHaveValue(raw);
}

async function expectWorkbookPath(app: SpreadsheetHarness, path: string): Promise<void> {
  const indicator = app.sheet.locator('[data-tid="spreadsheet-workbook-path"]');
  await expect(indicator).toHaveText(path.split("/").at(-1) ?? path);
  await expect(indicator).toHaveAttribute("title", path);
  await expect(indicator).toHaveAttribute("aria-label", `Workbook ${path}`);
}

async function expectKitchenSinkTabs(app: SpreadsheetHarness): Promise<void> {
  const names = ["Read me", "Sales", "Summary", "Inventory", "Formats", "Formula gallery"];
  await expect(app.sheet.getByRole("tab")).toHaveCount(names.length);
  for (const name of names) await expect(app.sheet.getByRole("tab", { name, exact: true })).toBeVisible();
}

async function expectCellDimensions(
  app: SpreadsheetHarness,
  address: string,
  width: number,
  height: number,
): Promise<void> {
  expect(await app.sheet.locator(`[data-address="${address}"]`).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { width: Math.round(rect.width), height: Math.round(rect.height) };
  })).toEqual({ width, height });
}
