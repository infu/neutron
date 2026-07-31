import { expect, test } from "bun:test";
import { createKitchenSinkWorkbook } from "../src/demo.ts";
import { FormulaBatch, SUPPORTED_FORMULA_FUNCTIONS } from "../src/formula.ts";
import { decodeNativeWorkbook, encodeNativeWorkbook, validateNativeWorkbook } from "../src/formats/native.ts";

test("Kitchen Sink workbook is deterministic, lossless, and exercises the supported feature set", () => {
  const first = createKitchenSinkWorkbook(123);
  const second = createKitchenSinkWorkbook(123);
  expect(first).toEqual(second);
  expect(first.sheets.map((sheet) => sheet.name)).toEqual([
    "Read me",
    "Sales",
    "Summary",
    "Inventory",
    "Formats",
    "Formula gallery",
  ]);
  expect(first.sheets.find((sheet) => sheet.name === "Sales")?.filter).toEqual({
    range: "A1:H9",
    column: 1,
    equals: "North",
  });
  expect(first.sheets.some((sheet) => Object.keys(sheet.columnWidths ?? {}).length > 0)).toBe(true);
  expect(first.sheets.some((sheet) => Object.keys(sheet.rowHeights ?? {}).length > 0)).toBe(true);
  expect(first.sheets.flatMap((sheet) => Object.values(sheet.cells)).some((cell) => cell.style?.wrap)).toBe(true);
  expect(first.sheets.flatMap((sheet) => Object.values(sheet.cells)).some((cell) => cell.style?.italic)).toBe(true);

  const readMe = first.sheets.find((sheet) => sheet.name === "Read me")!;
  expect(readMe.cells.B8?.input).toEqual({
    kind: "text",
    value: "Verify Formats!B4:C10 for number/date/time, then A12:C12 for alignment, color, bold, italic, and wrap",
  });
  expect(readMe.cells.B11?.input).toEqual({
    kind: "text",
    value: "Every workbook edit is one Undo step and can be Redone safely",
  });

  const formats = first.sheets.find((sheet) => sheet.name === "Formats")!;
  for (let row = 4; row <= 10; row += 1) {
    expect(formats.cells[`B${row}`]).toBeDefined();
    expect(formats.cells[`C${row}`]).toBeDefined();
  }
  expect(formats.cells.A12?.style).toMatchObject({ bold: true, alignment: "center" });
  expect(formats.cells.B12?.style).toMatchObject({ italic: true });
  expect(formats.cells.C12?.style).toMatchObject({ wrap: true });

  const gallery = first.sheets.find((sheet) => sheet.name === "Formula gallery")!;
  const galleryNames = Object.entries(gallery.cells)
    .filter(([address]) => /^A(?:[4-9]|1[0-9]|2[0-4])$/.test(address))
    .map(([, cell]) => cell.input.kind === "text" ? cell.input.value : "");
  for (const name of SUPPORTED_FORMULA_FUNCTIONS) expect(galleryNames).toContain(name);
  expect(gallery.cells.B23?.style?.numberFormat).toBe("time");

  const summary = first.sheets.find((sheet) => sheet.name === "Summary")!;
  expect(new FormulaBatch(first, { now: Date.UTC(2026, 6, 14, 12) }).displayCell(summary.id, "B4")).toBe("$13718.00");
  expect(() => validateNativeWorkbook(first)).not.toThrow();
  expect(decodeNativeWorkbook(encodeNativeWorkbook(first))).toEqual(first);
});
