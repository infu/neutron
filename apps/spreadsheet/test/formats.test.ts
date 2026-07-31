import { expect, test } from "bun:test";
import { exportCsv, importCsv, parseCsv } from "../src/formats/csv.ts";
import { SPREADSHEET_LIMITS } from "../src/constants.ts";
import { decodeNativeWorkbook, encodeNativeWorkbook } from "../src/formats/native.ts";
import { createWorkbook } from "../src/model.ts";

test("native format losslessly preserves tagged inputs, styles, sheets, and date system", () => {
  const workbook = createWorkbook(10);
  workbook.calculation.dateSystem = 1904;
  workbook.sheets[0]!.cells.A1 = { input: { kind: "text", value: "=literal" }, style: { bold: true, fillColor: "#112233" } };
  workbook.sheets[0]!.cells.A2 = { input: { kind: "formula", formula: "=1+1" } };
  workbook.sheets[0]!.cells.A3 = { input: { kind: "text", value: "" } };
  const decoded = decodeNativeWorkbook(encodeNativeWorkbook(workbook));
  expect(decoded).toEqual(workbook);
  expect(decoded.sheets[0]!.cells.A3!.input).toEqual({ kind: "text", value: "" });
});

test("native decoder rejects unknown fields, non-finite numbers, and malformed utf-8", () => {
  const workbook = createWorkbook();
  expect(() => decodeNativeWorkbook(new TextEncoder().encode(JSON.stringify({ ...workbook, unexpected: true })))).toThrow();
  workbook.sheets[0]!.cells.A1 = { input: { kind: "number", value: Number.NaN } };
  expect(() => encodeNativeWorkbook(workbook)).toThrow();
  expect(() => decodeNativeWorkbook(new Uint8Array([0xff]))).toThrow("UTF-8");
});

test("native dimension overrides are explicitly bounded for transport-safe status", () => {
  const workbook = createWorkbook();
  workbook.sheets[0]!.rowHeights = Object.fromEntries(
    Array.from({ length: SPREADSHEET_LIMITS.maxDimensionOverrides }, (_, row) => [String(row), 24]),
  );
  expect(() => encodeNativeWorkbook(workbook)).not.toThrow();
  workbook.sheets[0]!.rowHeights![String(SPREADSHEET_LIMITS.maxDimensionOverrides)] = 24;
  expect(() => encodeNativeWorkbook(workbook)).toThrow("custom row/column sizes");
});

test("native filters require exact keys, a canonical range, and one useful predicate", () => {
  const workbook = createWorkbook();
  workbook.sheets[0]!.filter = { range: "A1:B4", column: 0, equals: "ready" };
  expect(decodeNativeWorkbook(encodeNativeWorkbook(workbook)).sheets[0]!.filter).toEqual({
    range: "A1:B4",
    column: 0,
    equals: "ready",
  });

  const invalid = [
    { range: "A1:B4", column: 0 },
    { range: "A1:B4", column: 0, equals: "ready", nonBlank: true },
    { range: "A1:B4", column: 0, nonBlank: false },
    { range: "A1:B4", column: 0, equals: "ready", extra: true },
    { range: "B4:A1", column: 0, equals: "ready" },
  ];
  for (const filter of invalid) {
    const candidate = createWorkbook() as unknown as { sheets: Array<{ filter?: unknown }> };
    candidate.sheets[0]!.filter = filter;
    expect(() => encodeNativeWorkbook(candidate as never)).toThrow("Invalid filter");
  }
});

test("CSV parser handles RFC quoting and import treats formula-like fields as text", () => {
  expect(parseCsv('name,note\r\nAda,"hello, ""world"""\r\n')).toEqual([
    ["name", "note"], ["Ada", 'hello, "world"'],
  ]);
  const workbook = importCsv(new TextEncoder().encode("code,value\r\n00123,=2+2\r\n"));
  expect(workbook.sheets[0]!.cells.A2!.input).toEqual({ kind: "text", value: "00123" });
  expect(workbook.sheets[0]!.cells.B2!.input).toEqual({ kind: "text", value: "=2+2" });
});

test("strict CSV parsing rejects every character after a closing quote except a delimiter or line ending", () => {
  expect(() => parseCsv('"value"junk,rest')).toThrow("Only a delimiter or line ending may follow a closing quote");
  expect(() => parseCsv('"value" ,rest')).toThrow("Only a delimiter or line ending may follow a closing quote");
  expect(() => parseCsv('"value"\t,rest')).toThrow("Only a delimiter or line ending may follow a closing quote");
  expect(parseCsv('"",next\r\n')).toEqual([["", "next"]]);
  expect(parseCsv('""')).toEqual([[""]]);
});

test("CSV export writes computed formula values and opt-in injection hardening", () => {
  const workbook = createWorkbook();
  const sheet = workbook.sheets[0]!;
  sheet.cells.A1 = { input: { kind: "number", value: 2 } };
  sheet.cells.B1 = { input: { kind: "formula", formula: "=A1*3" } };
  sheet.cells.A2 = { input: { kind: "text", value: "=cmd" } };
  const result = exportCsv(workbook, sheet.id, { injectionPolicy: "safe" });
  expect(new TextDecoder().decode(result.bytes)).toBe("2,6\r\n'=cmd,\r\n");
  expect(result).toMatchObject({ formulaCells: 1, transformed: 1, errorCells: 0 });
});

test("CSV export uses canonical numbers instead of formatted currency and percent display", () => {
  const workbook = createWorkbook();
  const sheet = workbook.sheets[0]!;
  sheet.cells.A1 = { input: { kind: "number", value: 0.25 }, style: { numberFormat: "percent", decimals: 0 } };
  sheet.cells.B1 = { input: { kind: "number", value: 12.5 }, style: { numberFormat: "currency", decimals: 2 } };
  sheet.cells.C1 = { input: { kind: "number", value: 60 }, style: { numberFormat: "date" } };
  const result = exportCsv(workbook, sheet.id, { injectionPolicy: "exact" });
  expect(new TextDecoder().decode(result.bytes)).toBe("0.25,12.5,1900-02-29\r\n");
});

test("CSV export rejects an explicit range beyond the bounded workbook contract", () => {
  const workbook = createWorkbook();
  expect(() => exportCsv(workbook, workbook.sheets[0]!.id, {
    range: "A1:ALL100000",
    injectionPolicy: "exact",
  })).toThrow("cannot exceed 250000 cells");
});
