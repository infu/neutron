import { expect, test } from "bun:test";
import { columnName } from "../src/address.ts";
import { SPREADSHEET_LIMITS } from "../src/constants.ts";
import { WorkbookEngine } from "../src/engine.ts";
import { createSheet, createWorkbook } from "../src/model.ts";

function engineAndSheet() {
  const engine = new WorkbookEngine(createWorkbook(100));
  return { engine, sheetId: engine.status().sheets[0]!.id };
}

test("atomic commands use revisions, command ids, and one-step undo/redo", () => {
  const { engine, sheetId } = engineAndSheet();
  const result = engine.apply({
    expectedRevision: 0,
    commandId: "seed",
    actor: "agent",
    operations: [{
      type: "set_cells",
      sheetId,
      start: "A1",
      values: [[{ kind: "number", value: 1 }], [{ kind: "number", value: 3 }]],
    }],
  });
  expect(result).toMatchObject({ revision: 1, previousRevision: 0, touchedCells: 2 });
  expect(engine.readRange(sheetId, "A1:A2").cells.map((cell) => cell.display)).toEqual(["1", "3"]);
  expect(() => engine.apply({ expectedRevision: 0, commandId: "stale", operations: [{ type: "clear", sheetId, range: "A1" }] })).toThrow("current revision is 1");

  const undone = engine.undo(1, "undo-1", result.historyId!);
  expect(undone.revision).toBe(2);
  expect(engine.readRange(sheetId, "A1:A2").cells.map((cell) => cell.display)).toEqual(["", ""]);
  engine.redo(2, "redo-1", result.historyId!);
  expect(engine.readRange(sheetId, "A1:A2").cells.map((cell) => cell.display)).toEqual(["1", "3"]);
});

test("a repeated command id returns the prior result without applying twice", () => {
  const { engine, sheetId } = engineAndSheet();
  const request = {
    expectedRevision: 0,
    commandId: "once",
    operations: [{ type: "set_cells" as const, sheetId, start: "A1", values: [[{ kind: "number" as const, value: 4 }]] }],
  };
  const first = engine.apply(request);
  const second = engine.apply(request);
  expect(second).toEqual(first);
  expect(engine.getRevision()).toBe(1);
  expect(() => engine.apply({ ...request, expectedRevision: 1 })).toThrow("already used for a different command");
});

test("history command identity includes the expected revision", () => {
  const { engine, sheetId } = engineAndSheet();
  const edit = engine.apply({
    expectedRevision: 0,
    commandId: "history-seed",
    operations: [{ type: "set_cells", sheetId, start: "A1", values: [[{ kind: "number", value: 4 }]] }],
  });
  const first = engine.undo(1, "undo-once", edit.historyId!);
  expect(engine.undo(1, "undo-once", edit.historyId!)).toEqual(first);
  expect(() => engine.undo(2, "undo-once", edit.historyId!)).toThrow("already used differently");
});

test("history evicts oldest snapshots to the shared byte bound", () => {
  const workbook = createWorkbook(100);
  const sheet = workbook.sheets[0]!;
  const largeText = "x".repeat(SPREADSHEET_LIMITS.maxTextLength);
  for (let column = 0; column < 96; column += 1) {
    sheet.cells[`${columnName(column)}1`] = { input: { kind: "text", value: largeText } };
  }
  const engine = new WorkbookEngine(workbook);
  for (let edit = 1; edit <= 3; edit += 1) {
    engine.apply({
      expectedRevision: edit - 1,
      commandId: `byte-history-${edit}`,
      operations: [{ type: "set_cells", sheetId: sheet.id, start: `A${edit + 1}`, values: [[
        { kind: "number", value: edit },
      ]] }],
    });
  }
  expect(engine.status().history).toMatchObject({ entries: 2, maxBytes: SPREADSHEET_LIMITS.maxUndoBytes });
  expect(engine.status().history.bytes).toBeLessThanOrEqual(SPREADSHEET_LIMITS.maxUndoBytes);

  const third = engine.status().undoHistoryId!;
  engine.undo(3, "undo-byte-3", third);
  const second = engine.status().undoHistoryId!;
  engine.undo(4, "undo-byte-2", second);
  expect(engine.status().history.entries).toBe(2);
  expect(() => engine.undo(5, "undo-byte-1", engine.status().undoHistoryId ?? undefined)).toThrow("Nothing to undo");
  expect(engine.readRange(sheet.id, "A2:A4").cells.map((cell) => cell.display)).toEqual(["1", "", ""]);
});

test("one mutation larger than the undo byte budget is rejected before commit", () => {
  const workbook = createWorkbook(100);
  const sheet = workbook.sheets[0]!;
  const largeText = "y".repeat(SPREADSHEET_LIMITS.maxTextLength);
  for (let column = 0; column < 270; column += 1) {
    sheet.cells[`${columnName(column)}1`] = { input: { kind: "text", value: largeText } };
  }
  const engine = new WorkbookEngine(workbook);
  expect(() => engine.apply({
    expectedRevision: 0,
    commandId: "oversized-undo-dry-run",
    dryRun: true,
    operations: [{ type: "set_cells", sheetId: sheet.id, start: "A2", values: [[
      { kind: "number", value: 1 },
    ]] }],
  })).toThrow("too large to retain its required undo entry");
  expect(() => engine.apply({
    expectedRevision: 0,
    commandId: "oversized-undo-entry",
    operations: [{ type: "set_cells", sheetId: sheet.id, start: "A2", values: [[
      { kind: "number", value: 1 },
    ]] }],
  })).toThrow("too large to retain its required undo entry");
  expect(engine.getRevision()).toBe(0);
  expect(engine.status()).toMatchObject({ canUndo: false, canRedo: false });
  expect(engine.status().history).toMatchObject({ entries: 0, bytes: 0 });
  expect(engine.readRange(sheet.id, "A2").cells[0]!.raw).toEqual({ kind: "blank" });
});

test("dimension override limits keep status bounded and reject growth atomically", () => {
  const workbook = createWorkbook();
  const sheet = workbook.sheets[0]!;
  sheet.rowHeights = Object.fromEntries(
    Array.from({ length: SPREADSHEET_LIMITS.maxDimensionOverrides }, (_, row) => [String(row), 24]),
  );
  const engine = new WorkbookEngine(workbook);
  expect(new TextEncoder().encode(JSON.stringify(engine.status())).byteLength).toBeLessThan(1024 * 1024);
  expect(() => engine.apply({
    expectedRevision: 0,
    commandId: "dimension-limit",
    operations: [{ type: "resize_column", sheetId: sheet.id, column: 0, width: 120 }],
  })).toThrow("custom row/column sizes");
  expect(engine.getRevision()).toBe(0);
  expect(engine.status().sheets[0]!.columnWidths).toEqual({});
});

test("history also evicts to the 100-entry count bound and keeps undo/redo coherent", () => {
  const { engine, sheetId } = engineAndSheet();
  for (let edit = 1; edit <= SPREADSHEET_LIMITS.maxUndoEntries + 1; edit += 1) {
    engine.apply({
      expectedRevision: edit - 1,
      commandId: `count-history-${edit}`,
      operations: [{ type: "set_cells", sheetId, start: "A1", values: [[
        { kind: "number", value: edit },
      ]] }],
    });
  }
  for (let undo = 0; undo < SPREADSHEET_LIMITS.maxUndoEntries; undo += 1) {
    engine.undo(
      SPREADSHEET_LIMITS.maxUndoEntries + 1 + undo,
      `count-undo-${undo}`,
      engine.status().undoHistoryId!,
    );
  }
  expect(engine.readRange(sheetId, "A1").cells[0]!.display).toBe("1");
  expect(engine.status().history).toMatchObject({ entries: SPREADSHEET_LIMITS.maxUndoEntries });
  expect(() => engine.undo(
    SPREADSHEET_LIMITS.maxUndoEntries * 2 + 1,
    "count-undo-evicted",
    engine.status().undoHistoryId ?? undefined,
  )).toThrow("Nothing to undo");
  engine.redo(
    SPREADSHEET_LIMITS.maxUndoEntries * 2 + 1,
    "count-redo",
    engine.status().redoHistoryId!,
  );
  expect(engine.readRange(sheetId, "A1").cells[0]!.display).toBe("2");
});

test("fill extends number series and translates relative formulas", () => {
  const { engine, sheetId } = engineAndSheet();
  engine.apply({
    expectedRevision: 0,
    commandId: "seed",
    operations: [{
      type: "set_cells", sheetId, start: "A1",
      values: [
        [{ kind: "number", value: 1 }, { kind: "formula", formula: "=A1*10" }],
        [{ kind: "number", value: 3 }, { kind: "formula", formula: "=A2*10" }],
      ],
    }],
  });
  engine.apply({
    expectedRevision: 1,
    commandId: "fill-numbers",
    operations: [{ type: "fill", sheetId, sourceRange: "A1:A2", targetRange: "A1:A5", mode: "auto" }],
  });
  engine.apply({
    expectedRevision: 2,
    commandId: "fill-formulas",
    operations: [{ type: "fill", sheetId, sourceRange: "B1", targetRange: "B1:B5", mode: "copy" }],
  });
  expect(engine.readRange(sheetId, "A1:B5").cells.map((cell) => cell.display)).toEqual([
    "1", "10", "3", "30", "5", "50", "7", "70", "9", "90",
  ]);
});

test("auto fill preserves irregular numeric seeds and repeats them instead of inventing a line", () => {
  const { engine, sheetId } = engineAndSheet();
  engine.apply({
    expectedRevision: 0,
    commandId: "irregular-seed",
    operations: [{
      type: "set_cells",
      sheetId,
      start: "A1",
      values: [[{ kind: "number", value: 1 }], [{ kind: "number", value: 2 }], [{ kind: "number", value: 4 }]],
    }],
  });
  const result = engine.apply({
    expectedRevision: 1,
    commandId: "fill-irregular-seed",
    operations: [{ type: "fill", sheetId, sourceRange: "A1:A3", targetRange: "A1:A5", mode: "auto" }],
  });

  expect(result.resolved[0]?.strategy).toBe("repeat");
  expect(engine.readRange(sheetId, "A1:A5").cells.map((cell) => cell.display)).toEqual(["1", "2", "4", "1", "2"]);
});

test("auto fill recognizes a floating-point series with a consistent step", () => {
  const { engine, sheetId } = engineAndSheet();
  engine.apply({
    expectedRevision: 0,
    commandId: "decimal-seed",
    operations: [{
      type: "set_cells",
      sheetId,
      start: "A1",
      values: [[{ kind: "number", value: 0.1 }], [{ kind: "number", value: 0.2 }], [{ kind: "number", value: 0.3 }]],
    }],
  });
  const result = engine.apply({
    expectedRevision: 1,
    commandId: "fill-decimal-seed",
    operations: [{ type: "fill", sheetId, sourceRange: "A1:A3", targetRange: "A1:A4", mode: "auto" }],
  });

  expect(result.resolved[0]?.strategy).toBe("linear");
  const filled = engine.readRange(sheetId, "A4").cells[0]!.raw;
  expect(filled.kind).toBe("number");
  if (filled.kind !== "number") throw new Error("Expected a numeric fill result");
  expect(filled.value).toBeCloseTo(0.4);
});

test("explicit linear fill requires at least two numeric seed cells", () => {
  const { engine, sheetId } = engineAndSheet();
  engine.apply({
    expectedRevision: 0,
    commandId: "linear-invalid-seeds",
    operations: [{
      type: "set_cells",
      sheetId,
      start: "A1",
      values: [[{ kind: "number", value: 1 }], [{ kind: "text", value: "two" }]],
    }],
  });
  expect(() => engine.apply({
    expectedRevision: 1,
    commandId: "linear-single-seed",
    operations: [{ type: "fill", sheetId, sourceRange: "A1", targetRange: "A1:A4", mode: "linear" }],
  })).toThrow("Linear fill requires at least two numeric seed cells");
  expect(() => engine.apply({
    expectedRevision: 1,
    commandId: "linear-mixed-seed",
    operations: [{ type: "fill", sheetId, sourceRange: "A1:A2", targetRange: "A1:A4", mode: "linear" }],
  })).toThrow("Linear fill requires at least two numeric seed cells");
  expect(engine.getRevision()).toBe(1);
  expect(engine.readRange(sheetId, "A1:A4").cells.map((cell) => cell.display)).toEqual(["1", "two", "", ""]);
});

test("one-dimensional fill rejects transposing a seed onto the other axis", () => {
  const engine = new WorkbookEngine(createWorkbook());
  const sheetId = engine.status().sheets[0]!.id;
  engine.apply({
    expectedRevision: 0,
    commandId: "cross-axis-seeds",
    operations: [{
      type: "set_cells",
      sheetId,
      start: "A1",
      values: [
        [{ kind: "number", value: 1 }, { kind: "number", value: 2 }],
        [{ kind: "number", value: 3 }, { kind: "number", value: 4 }],
      ],
    }],
  });

  expect(() => engine.apply({
    expectedRevision: 1,
    commandId: "vertical-to-horizontal",
    operations: [{ type: "fill", sheetId, sourceRange: "A1:A2", targetRange: "C1:E1", mode: "auto" }],
  })).toThrow(/same axis/i);
  expect(() => engine.apply({
    expectedRevision: 1,
    commandId: "horizontal-to-vertical",
    operations: [{ type: "fill", sheetId, sourceRange: "A1:B1", targetRange: "C2:C4", mode: "auto" }],
  })).toThrow(/same axis/i);
  expect(engine.status().revision).toBe(1);
  expect(engine.readRange(sheetId, "C1:E4").cells.every((cell) => cell.raw.kind === "blank")).toBe(true);
});

test("Fill Down copies a full source row across a rectangular selection", () => {
  const { engine, sheetId } = engineAndSheet();
  engine.apply({
    expectedRevision: 0,
    commandId: "row-seed",
    operations: [{ type: "set_cells", sheetId, start: "A1", values: [[
      { kind: "number", value: 2 },
      { kind: "formula", formula: "=A1*5" },
    ]] }],
  });
  const result = engine.apply({
    expectedRevision: 1,
    commandId: "fill-down",
    operations: [{ type: "fill", sheetId, sourceRange: "A1:B1", targetRange: "A1:B3", mode: "auto" }],
  });
  expect(result.resolved[0]?.strategy).toBe("repeat");
  expect(engine.readRange(sheetId, "A1:B3").cells.map((cell) => cell.display)).toEqual([
    "2", "10", "2", "10", "2", "10",
  ]);
});

test("sheet changes, style, stable sort, find, and paged reads share the command path", () => {
  const { engine, sheetId } = engineAndSheet();
  engine.apply({
    expectedRevision: 0,
    commandId: "table",
    operations: [
      { type: "set_cells", sheetId, start: "A1", values: [
        [{ kind: "text", value: "b" }, { kind: "number", value: 2 }],
        [{ kind: "text", value: "a" }, { kind: "number", value: 1 }],
      ] },
      { type: "apply_style", sheetId, range: "A1:B1", style: { bold: true } },
      { type: "add_sheet", name: "Notes" },
    ],
  });
  engine.apply({ expectedRevision: 1, commandId: "sort", operations: [{ type: "sort_range", sheetId, range: "A1:B2", keyColumn: 0, direction: "ascending", hasHeader: false }] });
  expect(engine.readRange(sheetId, "A1:B2").cells.map((cell) => cell.display)).toEqual(["a", "1", "b", "2"]);
  expect(engine.find("b").matches).toHaveLength(1);
  const page = engine.readRange(sheetId, "A1:B2", { limit: 2 });
  expect(page.cells).toHaveLength(2);
  expect(engine.readRange(sheetId, "A1:B2", { cursor: page.nextCursor! }).cells).toHaveLength(2);
  expect(engine.status().sheets.map((sheet) => sheet.name)).toEqual(["Sheet1", "Notes"]);
});

test("find responses stop at the message byte budget", () => {
  const engine = new WorkbookEngine(createWorkbook());
  const sheetId = engine.status().sheets[0]!.id;
  const large = `needle-${"x".repeat(32_000)}`;
  engine.apply({
    expectedRevision: 0,
    commandId: "large-find-fixture",
    operations: [{
      type: "set_cells",
      sheetId,
      start: "A1",
      values: [
        [{ kind: "text", value: large }],
        [{ kind: "text", value: large }],
      ],
    }],
  });
  const found = engine.find("needle", { limit: 500 });
  expect(found.matches).toHaveLength(1);
  expect(found.truncated).toBe(true);
  expect(found.nextCursor).toBeTruthy();
  expect(new TextEncoder().encode(JSON.stringify(found)).byteLength).toBeLessThanOrEqual(SPREADSHEET_LIMITS.maxReadBytes);
  const second = engine.find("needle", { cursor: found.nextCursor!, limit: 500 });
  expect(second.matches.map((match) => match.address)).toEqual(["A2"]);
  expect(second.nextCursor).toBeNull();
  expect(second.truncated).toBe(false);
  expect(new TextEncoder().encode(JSON.stringify(second)).byteLength).toBeLessThanOrEqual(SPREADSHEET_LIMITS.maxReadBytes);
});

test("find paginates a deterministic populated-cell sequence without duplicates or omissions", () => {
  const workbook = createWorkbook();
  const firstSheet = workbook.sheets[0]!;
  firstSheet.cells.B2 = { input: { kind: "text", value: "needle four" } };
  firstSheet.cells.C1 = { input: { kind: "text", value: "needle two" } };
  firstSheet.cells.A1 = { input: { kind: "text", value: "needle one" } };
  const secondSheet = createSheet("Second");
  secondSheet.cells.D3 = { input: { kind: "text", value: "needle six" } };
  secondSheet.cells.B1 = { input: { kind: "text", value: "needle five" } };
  workbook.sheets.push(secondSheet);
  const engine = new WorkbookEngine(workbook);

  const first = engine.find("needle", { limit: 2 });
  const second = engine.find("needle", { cursor: first.nextCursor!, limit: 1 });
  const third = engine.find("needle", { cursor: second.nextCursor!, limit: 10 });
  const matches = [...first.matches, ...second.matches, ...third.matches];

  expect([first, second, third].map((page) => page.workbookId)).toEqual([
    engine.status().workbookId,
    engine.status().workbookId,
    engine.status().workbookId,
  ]);

  expect(matches.map((match) => `${match.sheetName}!${match.address}`)).toEqual([
    "Sheet1!A1",
    "Sheet1!C1",
    "Sheet1!B2",
    "Second!B1",
    "Second!D3",
  ]);
  expect(new Set(matches.map((match) => `${match.sheetId}:${match.address}`)).size).toBe(matches.length);
  expect([first, second, third].map((page) => page.truncated)).toEqual([true, true, false]);
  expect([first, second, third].map((page) => page.nextCursor !== null)).toEqual([true, true, false]);
});

test("find cursors bind revision, workbook query, and search options and reject tampering", () => {
  const workbook = createWorkbook();
  const firstSheet = workbook.sheets[0]!;
  firstSheet.cells.A1 = { input: { kind: "text", value: "needle" } };
  firstSheet.cells.A2 = { input: { kind: "text", value: "needle" } };
  const secondSheet = createSheet("Second");
  secondSheet.cells.A1 = { input: { kind: "text", value: "needle" } };
  workbook.sheets.push(secondSheet);
  const engine = new WorkbookEngine(workbook);
  const first = engine.find("needle", { limit: 1 });
  const cursor = first.nextCursor!;

  expect(() => engine.find("different", { cursor })).toThrow("does not match");
  expect(() => engine.find("needle", { cursor, sheetId: firstSheet.id })).toThrow("does not match");
  expect(() => engine.find("needle", { cursor, formulas: true })).toThrow("does not match");
  expect(() => engine.find("needle", { cursor, caseSensitive: true })).toThrow("does not match");
  const replacement = cursor.endsWith("0") ? "1" : "0";
  expect(() => engine.find("needle", { cursor: `${cursor.slice(0, -1)}${replacement}` })).toThrow("tampered");

  engine.apply({
    expectedRevision: 0,
    commandId: "stale-find-cursor",
    operations: [{ type: "set_cells", sheetId: firstSheet.id, start: "A3", values: [[{ kind: "text", value: "needle" }]] }],
  });
  expect(() => engine.find("needle", { cursor })).toThrow("does not match this revision");
});

test("large atomic ranges and formula ranges are rejected before iteration", () => {
  const { engine, sheetId } = engineAndSheet();
  expect(() => engine.apply({
    expectedRevision: 0,
    commandId: "too-large",
    operations: [{ type: "clear", sheetId, range: "A1:ALL100" }],
  })).toThrow("cannot touch more than 50000 cells");
  engine.apply({
    expectedRevision: 0,
    commandId: "formula-budget",
    operations: [{ type: "set_cells", sheetId, start: "A1", values: [[
      { kind: "formula", formula: "=SUM(A1:ALL100000)" },
    ]] }],
  });
  expect(engine.readRange(sheetId, "A1").cells[0]!.computed).toMatchObject({ kind: "error", code: "#NUM!" });
});

test("paged reads bind opaque cursors to workbook identity and never exceed the byte bound", () => {
  const workbook = createWorkbook();
  workbook.sheets[0]!.id = "sheet.with.dots";
  const engine = new WorkbookEngine(workbook);
  const sheetId = workbook.sheets[0]!.id;
  engine.apply({
    expectedRevision: 0,
    commandId: "cursor-data",
    operations: [{ type: "set_cells", sheetId, start: "A1", values: [[
      { kind: "text", value: "one" }, { kind: "text", value: "two" },
    ]] }],
  });
  const first = engine.readRange(sheetId, "A1:B1", { limit: 1 });
  expect(first.workbookId).toBe(workbook.workbookId);
  expect(first.nextCursor).toBeTruthy();
  expect(engine.readRange(sheetId, "A1:B1", { cursor: first.nextCursor! }).cells[0]!.display).toBe("two");
  engine.replace(createWorkbook());
  expect(() => engine.readRange(engine.status().sheets[0]!.id, "A1:B1", { cursor: first.nextCursor! })).toThrow("does not match");

  const large = new WorkbookEngine(createWorkbook());
  const largeSheet = large.status().sheets[0]!.id;
  large.apply({
    expectedRevision: 0,
    commandId: "large-cell",
    operations: [{ type: "set_cells", sheetId: largeSheet, start: "A1", values: [[
      { kind: "text", value: "x".repeat(32_768) },
    ]] }],
  });
  expect(() => large.readRange(largeSheet, "A1")).toThrow("cannot fit");
});

test("sparse reads omit absent blanks while paging every requested position", () => {
  const { engine, sheetId } = engineAndSheet();
  engine.apply({
    expectedRevision: 0,
    commandId: "sparse-viewport",
    operations: [
      { type: "set_cells", sheetId, start: "A1", values: [[{ kind: "text", value: "first" }]] },
      { type: "apply_style", sheetId, range: "T50", style: { bold: true } },
    ],
  });

  expect(engine.readRange(sheetId, "A1:T50").cells).toHaveLength(1_000);
  const pages = [];
  let cursor: string | undefined;
  do {
    const page = engine.readRange(sheetId, "A1:T50", {
      includeBlanks: false,
      limit: 400,
      ...(cursor ? { cursor } : {}),
    });
    pages.push(page);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  expect(pages).toHaveLength(3);
  expect(pages.flatMap((page) => page.cells).map((cell) => cell.address)).toEqual(["A1", "T50"]);
  expect(pages.flatMap((page) => page.cells)[1]).toMatchObject({
    address: "T50",
    raw: { kind: "blank" },
    display: "",
    style: { bold: true },
  });
  for (const page of pages) {
    expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(SPREADSHEET_LIMITS.maxReadBytes);
  }
});

test("copy range snapshots overlaps, translates mixed references, and supports computed values", () => {
  const { engine, sheetId } = engineAndSheet();
  engine.apply({
    expectedRevision: 0,
    commandId: "copy-seed",
    operations: [{ type: "set_cells", sheetId, start: "A1", values: [[
      { kind: "number", value: 2 },
      { kind: "formula", formula: "=A1+$A$1+A$1+$A1" },
    ]] }],
  });
  engine.apply({
    expectedRevision: 1,
    commandId: "copy-all",
    operations: [{ type: "copy_range", sheetId, sourceRange: "A1:B1", destination: "C3", mode: "all" }],
  });
  expect(engine.readRange(sheetId, "D3").cells[0]!.raw).toEqual({
    kind: "formula",
    formula: "=C3+$A$1+C$1+$A3",
  });

  engine.apply({
    expectedRevision: 2,
    commandId: "style-target",
    operations: [{ type: "apply_style", sheetId, range: "E1", style: { bold: true } }],
  });
  engine.apply({
    expectedRevision: 3,
    commandId: "copy-values",
    operations: [{ type: "copy_range", sheetId, sourceRange: "B1", destination: "E1", mode: "values" }],
  });
  expect(engine.readRange(sheetId, "E1").cells[0]).toMatchObject({
    raw: { kind: "number", value: 8 },
    style: { bold: true },
  });

  engine.apply({
    expectedRevision: 4,
    commandId: "error-seed",
    operations: [{ type: "set_cells", sheetId, start: "A5", values: [[
      { kind: "formula", formula: "=1/0" },
    ]] }],
  });
  engine.apply({
    expectedRevision: 5,
    commandId: "copy-error-value",
    operations: [{ type: "copy_range", sheetId, sourceRange: "A5", destination: "B5", mode: "values" }],
  });
  engine.apply({
    expectedRevision: 6,
    commandId: "iferror-pasted-value",
    operations: [{ type: "set_cells", sheetId, start: "C5", values: [[
      { kind: "formula", formula: '=IFERROR(B5,"handled")' },
    ]] }],
  });
  expect(engine.readRange(sheetId, "B5:C5").cells).toMatchObject([
    { raw: { kind: "formula", formula: "=#DIV/0!" }, display: "#DIV/0!" },
    { display: "handled" },
  ]);
});

test("move range is overlap-safe and retargets formulas that point at moved cells", () => {
  const { engine, sheetId } = engineAndSheet();
  engine.apply({
    expectedRevision: 0,
    commandId: "move-seed",
    operations: [{ type: "set_cells", sheetId, start: "A1", values: [[
      { kind: "number", value: 2 },
      { kind: "number", value: 3 },
      { kind: "blank" },
      { kind: "formula", formula: "=B1" },
    ]] }],
  });
  engine.apply({
    expectedRevision: 1,
    commandId: "overlap-move",
    operations: [{ type: "move_range", sheetId, sourceRange: "A1:B1", destination: "B1" }],
  });
  expect(engine.readRange(sheetId, "A1:D1").cells.map((cell) => cell.display)).toEqual(["", "2", "3", "3"]);
  expect(engine.readRange(sheetId, "D1").cells[0]!.raw).toEqual({ kind: "formula", formula: "=C1" });

  engine.apply({
    expectedRevision: 2,
    commandId: "formula-seed",
    operations: [{ type: "set_cells", sheetId, start: "A3", values: [[
      { kind: "number", value: 10 },
      { kind: "formula", formula: "=$A$3+1" },
    ]] }],
  });
  engine.apply({
    expectedRevision: 3,
    commandId: "formula-move",
    operations: [{ type: "move_range", sheetId, sourceRange: "A3:B3", destination: "B4" }],
  });
  expect(engine.readRange(sheetId, "C4").cells[0]).toMatchObject({
    raw: { kind: "formula", formula: "=$B$4+1" },
    display: "11",
  });
});

test("moving a formula preserves precedents outside the moved range", () => {
  const { engine, sheetId } = engineAndSheet();
  engine.apply({
    expectedRevision: 0,
    commandId: "move-external-precedent-seed",
    operations: [{ type: "set_cells", sheetId, start: "A1", values: [[
      { kind: "number", value: 7 },
      { kind: "formula", formula: "=A1+$A$1" },
    ]] }],
  });
  engine.apply({
    expectedRevision: 1,
    commandId: "move-external-precedent",
    operations: [{ type: "move_range", sheetId, sourceRange: "B1", destination: "C2" }],
  });
  expect(engine.readRange(sheetId, "C2").cells[0]).toMatchObject({
    raw: { kind: "formula", formula: "=A1+$A$1" },
    display: "14",
  });
});

test("move rejects non-contiguous formula range retargeting without partial mutation", () => {
  const { engine, sheetId } = engineAndSheet();
  engine.apply({
    expectedRevision: 0,
    commandId: "partial-range-seed",
    operations: [{ type: "set_cells", sheetId, start: "A1", values: [
      [{ kind: "number", value: 1 }, { kind: "blank" }, { kind: "formula", formula: "=SUM(A1:A3)" }],
      [{ kind: "number", value: 2 }, { kind: "blank" }, { kind: "blank" }],
      [{ kind: "number", value: 3 }, { kind: "blank" }, { kind: "blank" }],
    ] }],
  });
  expect(() => engine.apply({
    expectedRevision: 1,
    commandId: "partial-range-move",
    operations: [{ type: "move_range", sheetId, sourceRange: "A2", destination: "B2" }],
  })).toThrow("only partially overlaps");
  expect(engine.getRevision()).toBe(1);
  expect(engine.readRange(sheetId, "A1:C3").cells.map((cell) => cell.display)).toEqual([
    "1", "", "6", "2", "", "", "3", "", "",
  ]);
});

test("row and column structure changes shift sparse data, metadata, and cross-sheet formulas", () => {
  const workbook = createWorkbook(100);
  const sheet = workbook.sheets[0]!;
  sheet.name = "Data";
  sheet.cells.A1 = { input: { kind: "number", value: 1 } };
  sheet.cells.A2 = { input: { kind: "number", value: 2 } };
  sheet.cells.B2 = { input: { kind: "formula", formula: "=A2+$A$2" } };
  sheet.rowHeights = { "1": 30 };
  sheet.columnWidths = { "1": 80 };
  const summary = createSheet("Summary");
  summary.cells.A1 = { input: { kind: "formula", formula: "=SUM(Data!A1:A2)" } };
  workbook.sheets.push(summary);
  const engine = new WorkbookEngine(workbook);

  engine.apply({
    expectedRevision: 0,
    commandId: "insert-row",
    operations: [{ type: "insert_rows", sheetId: sheet.id, startRow: 1, count: 1 }],
  });
  expect(engine.readRange(sheet.id, "A1:B3").cells.map((cell) => cell.display)).toEqual(["1", "", "", "", "2", "4"]);
  expect(engine.readRange(sheet.id, "B3").cells[0]!.raw).toEqual({ kind: "formula", formula: "=A3+$A$3" });
  expect(engine.readRange(summary.id, "A1").cells[0]).toMatchObject({
    raw: { kind: "formula", formula: "=SUM(Data!A1:A3)" },
    display: "3",
  });
  expect(engine.snapshot().workbook.sheets[0]!.rowHeights).toEqual({ "2": 30 });

  engine.apply({
    expectedRevision: 1,
    commandId: "delete-row",
    operations: [{ type: "delete_rows", sheetId: sheet.id, startRow: 0, count: 1 }],
  });
  expect(engine.readRange(summary.id, "A1").cells[0]).toMatchObject({
    raw: { kind: "formula", formula: "=SUM(Data!A1:A2)" },
    display: "2",
  });
  expect(engine.snapshot().workbook.sheets[0]!.rowHeights).toEqual({ "1": 30 });

  engine.apply({
    expectedRevision: 2,
    commandId: "insert-column",
    operations: [{ type: "insert_columns", sheetId: sheet.id, startColumn: 0, count: 1 }],
  });
  expect(engine.readRange(sheet.id, "C2").cells[0]!.raw).toEqual({ kind: "formula", formula: "=B2+$B$2" });
  expect(engine.snapshot().workbook.sheets[0]!.columnWidths).toEqual({ "2": 80 });
  engine.apply({
    expectedRevision: 3,
    commandId: "delete-column",
    operations: [{ type: "delete_columns", sheetId: sheet.id, startColumn: 0, count: 1 }],
  });
  expect(engine.readRange(sheet.id, "B2").cells[0]!.raw).toEqual({ kind: "formula", formula: "=A2+$A$2" });
});

test("deleting a directly referenced cell produces a real REF error", () => {
  const { engine, sheetId } = engineAndSheet();
  engine.apply({
    expectedRevision: 0,
    commandId: "ref-seed",
    operations: [{ type: "set_cells", sheetId, start: "A1", values: [[
      { kind: "number", value: 1 },
      { kind: "formula", formula: "=A1" },
    ]] }],
  });
  engine.apply({
    expectedRevision: 1,
    commandId: "delete-ref",
    operations: [{ type: "delete_columns", sheetId, startColumn: 0, count: 1 }],
  });
  expect(engine.readRange(sheetId, "A1").cells[0]).toMatchObject({
    raw: { kind: "formula", formula: "=#REF!" },
    computed: { kind: "error", code: "#REF!" },
  });
});

test("renaming a sheet rewrites quoted cross-sheet cell and range references", () => {
  const workbook = createWorkbook(100);
  const sales = workbook.sheets[0]!;
  sales.name = "Sales Data";
  sales.cells.A1 = { input: { kind: "number", value: 4 } };
  sales.cells.A2 = { input: { kind: "number", value: 6 } };
  const summary = createSheet("Summary");
  summary.cells.A1 = { input: { kind: "formula", formula: "=SUM('Sales Data'!A1:A2)" } };
  workbook.sheets.push(summary);
  const engine = new WorkbookEngine(workbook);
  engine.apply({
    expectedRevision: 0,
    commandId: "rename-data",
    operations: [{ type: "rename_sheet", sheetId: sales.id, name: "2026 Sales" }],
  });
  expect(engine.readRange(summary.id, "A1").cells[0]).toMatchObject({
    raw: { kind: "formula", formula: "=SUM('2026 Sales'!A1:A2)" },
    display: "10",
  });
});

test("deleting a sheet permanently invalidates explicit references", () => {
  const workbook = createWorkbook(100);
  const data = workbook.sheets[0]!;
  data.name = "Data 2026";
  data.cells.A1 = { input: { kind: "number", value: 4 } };
  const summary = createSheet("Summary");
  summary.cells.A1 = { input: { kind: "formula", formula: "='Data 2026'!A1" } };
  summary.cells.A2 = { input: { kind: "formula", formula: "=SUM('Data 2026'!A1:A2)" } };
  workbook.sheets.push(summary);
  const engine = new WorkbookEngine(workbook);

  const deleted = engine.apply({
    expectedRevision: 0,
    commandId: "delete-data",
    operations: [{ type: "delete_sheet", sheetId: data.id }],
  });
  expect(deleted.touchedCells).toBe(3);
  expect(engine.readRange(summary.id, "A1:A2").cells.map((cell) => cell.raw)).toEqual([
    { kind: "formula", formula: "=#REF!" },
    { kind: "formula", formula: "=SUM(#REF!)" },
  ]);

  engine.apply({
    expectedRevision: 1,
    commandId: "recreate-data",
    operations: [{ type: "add_sheet", name: "Data 2026" }],
  });
  const replacement = engine.status().sheets.find((sheet) => sheet.name === "Data 2026")!;
  engine.apply({
    expectedRevision: 2,
    commandId: "replacement-value",
    operations: [{ type: "set_cells", sheetId: replacement.id, start: "A1", values: [[{ kind: "number", value: 99 }]] }],
  });
  expect(engine.readRange(summary.id, "A1:A2").cells.map((cell) => cell.display)).toEqual(["#REF!", "#REF!"]);
});

test("sorting translates relative and mixed references with their source rows", () => {
  const { engine, sheetId } = engineAndSheet();
  engine.apply({
    expectedRevision: 0,
    commandId: "formula-sort-seed",
    operations: [{ type: "set_cells", sheetId, start: "A1", values: [
      [{ kind: "number", value: 2 }, { kind: "formula", formula: "=A1+$A1+A$1+$A$1" }],
      [{ kind: "number", value: 1 }, { kind: "formula", formula: "=A2+$A2+A$1+$A$1" }],
    ] }],
  });
  engine.apply({
    expectedRevision: 1,
    commandId: "formula-sort",
    operations: [{ type: "sort_range", sheetId, range: "A1:B2", keyColumn: 0, direction: "ascending", hasHeader: false }],
  });
  expect(engine.readRange(sheetId, "A1:B2").cells.map((cell) => cell.display)).toEqual(["1", "4", "2", "6"]);
  expect(engine.readRange(sheetId, "B1:B2").cells.map((cell) => cell.raw)).toEqual([
    { kind: "formula", formula: "=A1+$A1+A$1+$A$1" },
    { kind: "formula", formula: "=A2+$A2+A$1+$A$1" },
  ]);
});

test("sorting keeps blank keys last in both directions", () => {
  const { engine, sheetId } = engineAndSheet();
  engine.apply({
    expectedRevision: 0,
    commandId: "blank-sort-seed",
    operations: [{ type: "set_cells", sheetId, start: "A1", values: [
      [{ kind: "number", value: 2 }, { kind: "text", value: "two" }],
      [{ kind: "blank" }, { kind: "text", value: "blank" }],
      [{ kind: "number", value: 1 }, { kind: "text", value: "one" }],
    ] }],
  });
  engine.apply({
    expectedRevision: 1,
    commandId: "blank-sort-ascending",
    operations: [{ type: "sort_range", sheetId, range: "A1:B3", keyColumn: 0, direction: "ascending", hasHeader: false }],
  });
  expect(engine.readRange(sheetId, "B1:B3").cells.map((cell) => cell.display)).toEqual(["one", "two", "blank"]);
  engine.apply({
    expectedRevision: 2,
    commandId: "blank-sort-descending",
    operations: [{ type: "sort_range", sheetId, range: "A1:B3", keyColumn: 0, direction: "descending", hasHeader: false }],
  });
  expect(engine.readRange(sheetId, "B1:B3").cells.map((cell) => cell.display)).toEqual(["two", "one", "blank"]);
});

test("header-aware sorting never moves the first row", () => {
  const engine = new WorkbookEngine(createWorkbook());
  const sheetId = engine.status().sheets[0]!.id;
  engine.apply({
    expectedRevision: 0,
    commandId: "header-table",
    operations: [{ type: "set_cells", sheetId, start: "A1", values: [
      [{ kind: "text", value: "Key" }, { kind: "text", value: "Name" }],
      [{ kind: "number", value: 2 }, { kind: "text", value: "second" }],
      [{ kind: "number", value: 1 }, { kind: "text", value: "first" }],
    ] }],
  });
  const result = engine.apply({
    expectedRevision: 1,
    commandId: "sort-with-header",
    operations: [{ type: "sort_range", sheetId, range: "A1:B3", keyColumn: 0, direction: "ascending", hasHeader: true }],
  });
  expect(result.touchedCells).toBe(4);
  expect(engine.readRange(sheetId, "A1:B3").cells.map((cell) => cell.display)).toEqual([
    "Key", "Name", "1", "first", "2", "second",
  ]);
});

test("filtered bulk edits and structural shifts fail atomically", () => {
  const { engine, sheetId } = engineAndSheet();
  engine.apply({
    expectedRevision: 0,
    commandId: "filter",
    operations: [{ type: "set_filter", sheetId, filter: { range: "A1:B5", column: 0, nonBlank: true } }],
  });
  expect(() => engine.apply({
    expectedRevision: 1,
    commandId: "filtered-copy",
    operations: [{ type: "copy_range", sheetId, sourceRange: "A1", destination: "D1" }],
  })).toThrow("clear the filter first");
  expect(() => engine.apply({
    expectedRevision: 1,
    commandId: "filtered-rows",
    operations: [{ type: "insert_rows", sheetId, startRow: 2, count: 1 }],
  })).toThrow("clear the filter first");
  expect(engine.getRevision()).toBe(1);
});

test("filters derive header-aware hidden rows from computed display values", () => {
  const { engine, sheetId } = engineAndSheet();
  engine.apply({
    expectedRevision: 0,
    commandId: "filter-table",
    operations: [{ type: "set_cells", sheetId, start: "A1", values: [
      [{ kind: "text", value: "Status" }, { kind: "text", value: "Source" }],
      [{ kind: "text", value: "keep" }, { kind: "text", value: "visible" }],
      [{ kind: "text", value: "hide" }, { kind: "text", value: "hidden" }],
      [{ kind: "formula", formula: "=B4" }, { kind: "text", value: "keep" }],
      [{ kind: "blank" }, { kind: "text", value: "blank" }],
    ] }],
  });
  engine.apply({
    expectedRevision: 1,
    commandId: "filter-equals",
    operations: [{ type: "set_filter", sheetId, filter: { range: "A1:B5", column: 0, equals: "keep" } }],
  });

  expect(engine.status().sheets[0]).toMatchObject({
    filter: { range: "A1:B5", column: 0, equals: "keep" },
    hiddenRowCount: 2,
  });
  const filtered = engine.readRange(sheetId, "A1:B5");
  expect(filtered.cells).toHaveLength(10);
  expect(filtered.hiddenRows).toEqual([3, 5]);
  const firstPage = engine.readRange(sheetId, "A1:A5", { limit: 2 });
  expect(firstPage.hiddenRows).toEqual([]);
  const secondPage = engine.readRange(sheetId, "A1:A5", { cursor: firstPage.nextCursor!, limit: 2 });
  expect(secondPage.hiddenRows).toEqual([3]);

  engine.apply({
    expectedRevision: 2,
    commandId: "visible-filter-edit",
    operations: [{ type: "set_cells", sheetId, start: "C2", values: [[{ kind: "text", value: "allowed" }]] }],
  });
  expect(() => engine.apply({
    expectedRevision: 3,
    commandId: "hidden-filter-edit",
    operations: [{ type: "set_cells", sheetId, start: "C3", values: [[{ kind: "text", value: "blocked" }]] }],
  })).toThrow("hidden row");
  expect(() => engine.apply({
    expectedRevision: 3,
    commandId: "filter-header-edit",
    operations: [{ type: "clear", sheetId, range: "A1" }],
  })).toThrow("filter header");

  engine.apply({
    expectedRevision: 3,
    commandId: "clear-filter",
    operations: [{ type: "clear_filter", sheetId }],
  });
  expect(engine.status().sheets[0]).toMatchObject({ filter: null, hiddenRowCount: 0 });
  expect(engine.readRange(sheetId, "A1:B5").hiddenRows).toEqual([]);

  engine.apply({
    expectedRevision: 4,
    commandId: "filter-nonblank",
    operations: [{ type: "set_filter", sheetId, filter: { range: "A1:B5", column: 0, nonBlank: true } }],
  });
  expect(engine.readRange(sheetId, "A1:B5").hiddenRows).toEqual([5]);
});

test("sort dynamically reapplies the active filter to the reordered rows", () => {
  const { engine, sheetId } = engineAndSheet();
  engine.apply({
    expectedRevision: 0,
    commandId: "sortable-filter-table",
    operations: [
      { type: "set_cells", sheetId, start: "A1", values: [
        [{ kind: "text", value: "Rank" }, { kind: "text", value: "Status" }],
        [{ kind: "number", value: 2 }, { kind: "text", value: "hide" }],
        [{ kind: "number", value: 1 }, { kind: "text", value: "keep" }],
        [{ kind: "number", value: 3 }, { kind: "text", value: "keep" }],
      ] },
      { type: "set_filter", sheetId, filter: { range: "A1:B4", column: 1, equals: "keep" } },
    ],
  });
  expect(engine.readRange(sheetId, "A1:B4").hiddenRows).toEqual([2]);

  engine.apply({
    expectedRevision: 1,
    commandId: "sort-filtered-data",
    operations: [{ type: "sort_range", sheetId, range: "A2:B4", keyColumn: 0, direction: "ascending", hasHeader: false }],
  });
  expect(engine.readRange(sheetId, "A1:B4")).toMatchObject({ hiddenRows: [3] });
  expect(engine.status().sheets[0]!.hiddenRowCount).toBe(1);
});

test("filters require exactly one useful predicate", () => {
  const { engine, sheetId } = engineAndSheet();
  const invalid = [
    { range: "A1:B3", column: 0 },
    { range: "A1:B3", column: 0, equals: "x", nonBlank: true },
    { range: "A1:B3", column: 0, nonBlank: false },
    { range: "A1:B3", column: 2, equals: "x" },
  ];
  invalid.forEach((filter, index) => {
    expect(() => engine.apply({
      expectedRevision: 0,
      commandId: `invalid-filter-${index}`,
      operations: [{ type: "set_filter", sheetId, filter: filter as never }],
    })).toThrow();
  });
  expect(engine.getRevision()).toBe(0);

  engine.apply({
    expectedRevision: 0,
    commandId: "valid-nonblank-filter",
    operations: [{ type: "set_filter", sheetId, filter: { range: "B4:A1", column: 0, nonBlank: true } }],
  });
  expect(engine.status().sheets[0]!.filter).toEqual({ range: "A1:B4", column: 0, nonBlank: true });
});

test("a 100k-row sparse filter derives its hidden count without materializing row state", () => {
  const { engine, sheetId } = engineAndSheet();
  engine.apply({
    expectedRevision: 0,
    commandId: "large-sparse-filter",
    operations: [{ type: "set_filter", sheetId, filter: { range: "A1:A100000", column: 0, nonBlank: true } }],
  });
  expect(engine.status().sheets[0]).toMatchObject({ hiddenRowCount: 99_999 });
  const page = engine.readRange(sheetId, "A1:A100000", { limit: 3 });
  expect(page.hiddenRows).toEqual([2, 3]);
});

test("semantic no-ops do not create revisions or undo entries", () => {
  const { engine, sheetId } = engineAndSheet();
  const result = engine.apply({
    expectedRevision: 0,
    commandId: "clear-empty",
    operations: [{ type: "clear", sheetId, range: "A1:B2" }],
  });
  expect(result).toMatchObject({ revision: 0, previousRevision: 0, historyId: null, noChange: true });
  expect(engine.status()).toMatchObject({ canUndo: false, canRedo: false });
  expect(engine.apply({
    expectedRevision: 0,
    commandId: "clear-empty",
    operations: [{ type: "clear", sheetId, range: "A1:B2" }],
  })).toEqual(result);
});

test("move union and insertion overflow enforce command and sheet bounds", () => {
  const { engine, sheetId } = engineAndSheet();
  expect(() => engine.apply({
    expectedRevision: 0,
    commandId: "large-move",
    operations: [{ type: "move_range", sheetId, sourceRange: "A1:ALL50", destination: "A51" }],
  })).toThrow("cannot touch more than 50000 cells");

  engine.apply({
    expectedRevision: 0,
    commandId: "bottom-cell",
    operations: [{ type: "set_cells", sheetId, start: "A100000", values: [[{ kind: "number", value: 1 }]] }],
  });
  expect(() => engine.apply({
    expectedRevision: 1,
    commandId: "overflow-insert",
    operations: [{ type: "insert_rows", sheetId, startRow: 99_999, count: 1 }],
  })).toThrow("beyond the sheet limit");
});
