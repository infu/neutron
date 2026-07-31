import { expect, test } from "bun:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { createKitchenSinkWorkbook } from "../src/demo.ts";
import { FormulaBatch } from "../src/formula.ts";
import { BrowserXlsxCodec } from "../src/formats/xlsx_adapter.ts";
import { exportXlsx, importXlsx, type XlsxWorkbook } from "../src/formats/xlsx.ts";
import { createWorkbook } from "../src/model.ts";

test("XLSX codec round-trips tagged values, formulas, dates, and basic styles", () => {
  const workbook: XlsxWorkbook = {
    dateSystem: 1904,
    sheets: [
      {
        id: "sheet-1",
        name: "Budget",
        cells: [
          {
            row: 0,
            column: 0,
            input: { kind: "text", value: "=literal" },
            style: { bold: true, fillColor: "#DDEEFF" },
          },
          {
            row: 1,
            column: 0,
            input: { kind: "number", value: 25.5 },
            style: { numberFormat: "$#,##0.00", horizontal: "right" },
          },
          {
            row: 1,
            column: 1,
            input: { kind: "formula", source: "=A2*2", cached: 51 },
          },
          {
            row: 2,
            column: 0,
            input: { kind: "number", value: 45292 },
            style: { numberFormat: "mm-dd-yy" },
          },
          { row: 3, column: 0, input: { kind: "boolean", value: true } },
        ],
      },
    ],
  };

  const bytes = exportXlsx(workbook);
  expect(bytes.byteLength).toBeGreaterThan(500);
  const imported = importXlsx(bytes);
  expect(imported.workbook.dateSystem).toBe(1904);
  expect(imported.workbook.sheets).toHaveLength(1);
  expect(imported.workbook.sheets[0]?.name).toBe("Budget");
  expect(imported.workbook.sheets[0]?.cells).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        row: 0,
        column: 0,
        input: { kind: "text", value: "=literal" },
      }),
      expect.objectContaining({
        row: 1,
        column: 1,
        input: { kind: "formula", source: "=A2*2", cached: 51 },
      }),
      expect.objectContaining({
        row: 2,
        column: 0,
        input: { kind: "number", value: 45292 },
      }),
    ]),
  );
});

test("XLSX round-trip preserves Kitchen Sink formula-cell number formats", async () => {
  const codec = new BrowserXlsxCodec();
  const exported = await codec.export(createKitchenSinkWorkbook(123));
  const imported = await codec.import(exported.data);
  const summary = imported.workbook.sheets.find((sheet) => sheet.name === "Summary")!;

  expect(summary.cells.B4?.style).toEqual({
    numberFormat: "currency",
    decimals: 2,
    alignment: "right",
  });
  expect(new FormulaBatch(imported.workbook, {
    now: Date.UTC(2026, 6, 14, 12),
  }).displayCell(summary.id, "B4")).toBe("$13718.00");

  const formats = imported.workbook.sheets.find((sheet) => sheet.name === "Formats")!;
  expect(formats.cells.C9?.style).toEqual({
    numberFormat: "time",
    alignment: "center",
  });
  expect(new FormulaBatch(imported.workbook).displayCell(formats.id, "C9")).toBe("15:30:00");
});

test("XLSX import keeps literal percent formats and error propagation truthful", async () => {
  const bytes = exportXlsx({
    dateSystem: 1900,
    sheets: [{
      id: "sheet-1",
      name: "Semantics",
      cells: [
        { row: 0, column: 0, input: { kind: "number", value: 25 }, style: { numberFormat: '0"%"' } },
        { row: 1, column: 0, input: { kind: "error", value: "#DIV/0!" } },
        { row: 1, column: 1, input: { kind: "formula", source: "=A2+1" } },
      ],
    }],
  });
  const imported = await new BrowserXlsxCodec().import(bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer);
  const sheet = imported.workbook.sheets[0]!;
  const batch = new FormulaBatch(imported.workbook);

  expect(sheet.cells.A1?.style).toMatchObject({ numberFormat: "number", decimals: 0 });
  expect(batch.displayCell(sheet.id, "A1")).toBe("25");
  expect(sheet.cells.A2?.input).toEqual({ kind: "formula", formula: "=#DIV/0!" });
  expect(batch.displayCell(sheet.id, "A2")).toBe("#DIV/0!");
  expect(batch.displayCell(sheet.id, "B2")).toBe("#DIV/0!");
});

test("XLSX codec rejects malformed archives and unsafe sheet names", () => {
  expect(() => importXlsx(new Uint8Array([1, 2, 3]))).toThrow();
  expect(() =>
    exportXlsx({
      dateSystem: 1900,
      sheets: [{ id: "one", name: "bad/name", cells: [] }],
    }),
  ).toThrow("Invalid sheet name");
});

test("XLSX export reports native metadata that its snapshot format omits", async () => {
  const workbook = createWorkbook();
  workbook.sheets[0]!.filter = { range: "A1:A3", column: 0, nonBlank: true };
  workbook.sheets[0]!.columnWidths = { "0": 144 };
  workbook.sheets[0]!.rowHeights = { "1": 32, "2": 40 };
  const exported = await new BrowserXlsxCodec().export(workbook);
  expect(exported.losses).toEqual({
    filtersDropped: 1,
    columnWidthsDropped: 1,
    rowHeightsDropped: 2,
  });
  expect(exported.warnings).toHaveLength(3);
});

test("XLSX import rejects VBA parts and macro-enabled content types", () => {
  const withVba = syntheticXlsx((files) => {
    files["xl/vbaProject.bin"] = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]);
  });
  expectImportCode(withVba, "XLSX_MACRO");

  const macroEnabled = syntheticXlsx((files) => {
    replaceXmlPart(files, "[Content_Types].xml", (xml) =>
      xml.replace(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
        "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
      )
    );
  });
  expectImportCode(macroEnabled, "XLSX_MACRO");
});

test("XLSX import rejects external workbook parts, relationships, and formulas", () => {
  const withExternalPart = syntheticXlsx((files) => {
    files["xl/externalLinks/externalLink1.xml"] = strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
    );
  });
  expectImportCode(withExternalPart, "XLSX_EXTERNAL_LINK");

  const withExternalRelationship = syntheticXlsx((files) => {
    replaceXmlPart(files, "xl/_rels/workbook.xml.rels", (xml) =>
      xml.replace(
        "</Relationships>",
        '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink" Target="externalLinks/externalLink1.xml"/></Relationships>',
      )
    );
  });
  expectImportCode(withExternalRelationship, "XLSX_EXTERNAL_LINK");

  const withExternalFormula = syntheticXlsx((files) => {
    setWorksheetCells(
      files,
      '<row r="1"><c r="A1"><f>\'[Other.xlsx]Sheet 1\'!A1</f><v>7</v></c></row>',
    );
  });
  expectImportCode(withExternalFormula, "XLSX_EXTERNAL_LINK");
});

test("XLSX import rejects unsupported function families instead of creating live NAME errors", () => {
  for (const formula of [
    "_xlfn.FUTUREVALUE(1)",
    "PRODUCT(2,3)",
    'IF(1=1,"PRODUCT(2,3)",MYSTERY(4))',
  ]) {
    const bytes = syntheticXlsx((files) => {
      setWorksheetCells(
        files,
        `<row r="1"><c r="A1"><f>${formula}</f><v>7</v></c></row>`,
      );
    });
    expectImportCode(bytes, "UNSUPPORTED_FEATURES");
  }
});

test("XLSX import admits functions from the engine's supported inventory", () => {
  const bytes = syntheticXlsx((files) => {
    setWorksheetCells(
      files,
      '<row r="1"><c r="A1"><f>SUM(1,2)</f><v>3</v></c></row>',
    );
  });
  expect(importXlsx(bytes).workbook.sheets[0]!.cells[0]!.input).toEqual({
    kind: "formula",
    source: "=SUM(1,2)",
    cached: 3,
  });
});

test("XLSX import normalizes Excel's compatibility prefix only for supported functions", () => {
  const bytes = syntheticXlsx((files) => {
    setWorksheetCells(
      files,
      '<row r="1"><c r="A1"><f>_xlfn.XLOOKUP(20,B1:B2,C1:C2,"missing")</f><v>200</v></c></row><row r="2"><c r="A2"><f>IF(TRUE,"_xlfn.XLOOKUP(1)",0)</f></c></row>',
    );
  });

  expect(importXlsx(bytes).workbook.sheets[0]!.cells[0]!.input).toEqual({
    kind: "formula",
    source: '=XLOOKUP(20,B1:B2,C1:C2,"missing")',
    cached: 200,
  });
  expect(importXlsx(bytes).workbook.sheets[0]!.cells[1]!.input).toEqual({
    kind: "formula",
    source: '=IF(TRUE,"_xlfn.XLOOKUP(1)",0)',
  });

  const unsupported = syntheticXlsx((files) => {
    setWorksheetCells(
      files,
      '<row r="1"><c r="A1"><f>_xlfn.FUTUREVALUE(1)</f><v>7</v></c></row>',
    );
  });
  expectImportCode(unsupported, "UNSUPPORTED_FEATURES");
});

test("XLSX import warns when worksheet layout and table metadata are dropped", () => {
  const bytes = syntheticXlsx((files) => {
    files["xl/tables/table1.xml"] = strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="Table1" displayName="Table1" ref="A1:A1"/>',
    );
    replaceXmlPart(files, "xl/worksheets/sheet1.xml", (xml) => xml
      .replace(
        '<sheetView workbookViewId="0"/>',
        '<sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView>',
      )
      .replace(
        "<sheetData></sheetData>",
        '<cols><col min="1" max="1" width="20" customWidth="1" hidden="1"/></cols><sheetData><row r="1" ht="30" customHeight="1" hidden="1"></row></sheetData>',
      ));
  });

  const warnings = importXlsx(bytes).warnings;
  expect(warnings.map(({ code }) => code)).toEqual([
    "XLSX_COLUMN_WIDTH",
    "XLSX_FROZEN_PANE",
    "XLSX_HIDDEN_COLUMN",
    "XLSX_HIDDEN_ROW",
    "XLSX_ROW_HEIGHT",
    "XLSX_TABLE",
  ]);
  for (const warning of warnings) expect(warning.count).toBe(1);
  expect(warnings.find(({ code }) => code === "XLSX_COLUMN_WIDTH")?.locations).toEqual([
    "xl/worksheets/sheet1.xml",
  ]);
  expect(warnings.find(({ code }) => code === "XLSX_FROZEN_PANE")?.locations).toEqual([
    "xl/worksheets/sheet1.xml",
  ]);
  expect(warnings.find(({ code }) => code === "XLSX_TABLE")?.locations).toEqual([
    "xl/tables/table1.xml",
  ]);
});

test("XLSX import rejects formula syntax that the live engine cannot preserve", () => {
  for (const formula of ["50%", "NamedRange+1", "Table1[Amount]"]) {
    const bytes = syntheticXlsx((files) => {
      setWorksheetCells(
        files,
        `<row r="1"><c r="A1"><f>${formula}</f><v>7</v></c></row>`,
      );
    });
    expectImportCode(bytes, "UNSUPPORTED_FEATURES");
  }
});

for (const fixture of [
  {
    name: "shared formula masters",
    code: "XLSX_SHARED_FORMULA",
    cells: '<row r="1"><c r="A1"><f t="shared" si="0" ref="A1:A2">1+1</f><v>2</v></c></row>',
  },
  {
    name: "self-closing shared formula followers",
    code: "XLSX_SHARED_FORMULA",
    cells: '<row r="2"><c r="A2"><f t="shared" si="0"/><v>2</v></c></row>',
  },
  {
    name: "array formulas",
    code: "XLSX_ARRAY_FORMULA",
    cells: '<row r="1"><c r="A1"><f t="array" ref="A1:A2">ROW(A1:A2)</f><v>1</v></c></row>',
  },
] as const) {
  test(`XLSX import rejects ${fixture.name}`, () => {
    const bytes = syntheticXlsx((files) => setWorksheetCells(files, fixture.cells));
    expectImportCode(bytes, fixture.code);
  });
}

function syntheticXlsx(
  mutate: (files: Record<string, Uint8Array>) => void,
): Uint8Array {
  const files = unzipSync(exportXlsx({
    dateSystem: 1900,
    sheets: [{ id: "sheet-1", name: "Sheet1", cells: [] }],
  }));
  mutate(files);
  return zipSync(files, { level: 6 });
}

function setWorksheetCells(
  files: Record<string, Uint8Array>,
  cells: string,
): void {
  replaceXmlPart(files, "xl/worksheets/sheet1.xml", (xml) =>
    xml.replace("<sheetData></sheetData>", `<sheetData>${cells}</sheetData>`)
  );
}

function replaceXmlPart(
  files: Record<string, Uint8Array>,
  name: string,
  update: (xml: string) => string,
): void {
  const source = files[name];
  if (!source) throw new Error(`Synthetic XLSX is missing ${name}`);
  const xml = strFromU8(source);
  const next = update(xml);
  if (next === xml) throw new Error(`Synthetic XLSX mutation did not change ${name}`);
  files[name] = strToU8(next);
}

function expectImportCode(bytes: Uint8Array, code: string): void {
  let failure: unknown;
  try {
    importXlsx(bytes);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error & { code?: string }).code).toBe(code);
}
