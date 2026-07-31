import { expect, test } from "bun:test";
import {
  FormulaBatch,
  SUPPORTED_FORMULA_FUNCTIONS,
  findUnsupportedFormulaFunctions,
  validateFormulaSyntax,
} from "../src/formula.ts";
import { createSheet, createWorkbook, type CellInput } from "../src/model.ts";

function put(input: CellInput, address: string, workbook = createWorkbook()) {
  workbook.sheets[0]!.cells[address] = { input };
  return workbook;
}

test("formula batch calculates arithmetic, ranges, common functions, and references", () => {
  const workbook = createWorkbook(100);
  const sheet = workbook.sheets[0]!;
  sheet.cells.A1 = { input: { kind: "number", value: 10 } };
  sheet.cells.A2 = { input: { kind: "number", value: 20 } };
  sheet.cells.B1 = { input: { kind: "formula", formula: "=SUM(A1:A2)*2" } };
  sheet.cells.B2 = { input: { kind: "formula", formula: "=IF(B1=60,\"yes\",\"no\")" } };
  sheet.cells.B3 = { input: { kind: "formula", formula: "=COUNTIF(A1:A2,\">15\")" } };
  const other = createSheet("Rates");
  other.cells.A1 = { input: { kind: "number", value: 1.5 } };
  sheet.cells.B4 = { input: { kind: "formula", formula: "='Rates'!A1*A1" } };
  workbook.sheets.push(other);

  const batch = new FormulaBatch(workbook, { now: Date.UTC(2024, 0, 2, 12) });
  expect(batch.evaluateCell(sheet.id, "B1")).toEqual({ kind: "value", value: 60 });
  expect(batch.evaluateCell(sheet.id, "B2")).toEqual({ kind: "value", value: "yes" });
  expect(batch.evaluateCell(sheet.id, "B3")).toEqual({ kind: "value", value: 1 });
  expect(batch.evaluateCell(sheet.id, "B4")).toEqual({ kind: "value", value: 15 });
});

test("formula errors are explicit and cycles are bounded", () => {
  const workbook = put({ kind: "formula", formula: "=1/0" }, "A1");
  workbook.sheets[0]!.cells.A2 = { input: { kind: "formula", formula: "=A3" } };
  workbook.sheets[0]!.cells.A3 = { input: { kind: "formula", formula: "=A2" } };
  const batch = new FormulaBatch(workbook);
  expect(batch.evaluateCell(workbook.sheets[0]!.id, "A1")).toMatchObject({ kind: "error", code: "#DIV/0!" });
  expect(batch.evaluateCell(workbook.sheets[0]!.id, "A2")).toMatchObject({ kind: "error", code: "#CYCLE!" });
  expect(batch.evaluateCell(workbook.sheets[0]!.id, "Z99")).toEqual({ kind: "blank", value: null });
});

test("COUNT ignores errors in ranges while COUNTA counts them as nonblank", () => {
  const workbook = createWorkbook();
  const sheet = workbook.sheets[0]!;
  sheet.cells.A1 = { input: { kind: "number", value: 1 } };
  sheet.cells.A2 = { input: { kind: "formula", formula: "=1/0" } };
  sheet.cells.B1 = { input: { kind: "formula", formula: "=COUNT(A1:A2)" } };
  sheet.cells.B2 = { input: { kind: "formula", formula: "=COUNTA(A1:A2)" } };
  sheet.cells.B3 = { input: { kind: "formula", formula: "=COUNT(A2)" } };
  sheet.cells.B4 = { input: { kind: "formula", formula: "=COUNT(1/0)" } };

  const batch = new FormulaBatch(workbook);
  expect(batch.evaluateCell(sheet.id, "B1")).toEqual({ kind: "value", value: 1 });
  expect(batch.evaluateCell(sheet.id, "B2")).toEqual({ kind: "value", value: 2 });
  expect(batch.evaluateCell(sheet.id, "B3")).toEqual({ kind: "value", value: 0 });
  expect(batch.evaluateCell(sheet.id, "B4")).toMatchObject({ kind: "error", code: "#DIV/0!" });
});

test("aggregates distinguish direct literals from referenced values and blanks compare by context", () => {
  const workbook = createWorkbook();
  const sheet = workbook.sheets[0]!;
  sheet.cells.A2 = { input: { kind: "boolean", value: true } };
  sheet.cells.A3 = { input: { kind: "formula", formula: '=""' } };

  const cases: Array<[string, string, Record<string, unknown>]> = [
    ["B1", '=A1=""', { kind: "value", value: true }],
    ["B2", "=A1=0", { kind: "value", value: true }],
    ["B3", "=A1=FALSE", { kind: "value", value: true }],
    ["B4", "=SUM(A2:A2)", { kind: "value", value: 0 }],
    ["B5", "=SUM(A2)", { kind: "value", value: 0 }],
    ["B6", "=AVERAGE(A2:A2)", { kind: "error", code: "#DIV/0!" }],
    ["B7", "=MIN(A2:A2)", { kind: "value", value: 0 }],
    ["B8", "=MAX(A2:A2)", { kind: "value", value: 0 }],
    ["B9", "=COUNT(A2:A2)", { kind: "value", value: 0 }],
    ["B10", "=COUNT(A2)", { kind: "value", value: 0 }],
    ["B11", "=COUNTA(A3)", { kind: "value", value: 1 }],
    ["B12", "=COUNTA(A1)", { kind: "value", value: 0 }],
    ["B13", '=SUM("5",15,TRUE)', { kind: "value", value: 21 }],
    ["B14", '=COUNT("1",TRUE)', { kind: "value", value: 2 }],
    ["B15", '=A1&"x"', { kind: "value", value: "x" }],
  ];
  for (const [address, formula] of cases) {
    sheet.cells[address] = { input: { kind: "formula", formula } };
  }

  const batch = new FormulaBatch(workbook);
  for (const [address, , expected] of cases) {
    expect(batch.evaluateCell(sheet.id, address)).toMatchObject(expected);
  }
});

test("COUNTIF and SUMIF support question/star wildcards and tilde escaping", () => {
  const workbook = createWorkbook();
  const sheet = workbook.sheets[0]!;
  const criteriaValues: Array<CellInput> = [
    { kind: "text", value: "cat" },
    { kind: "text", value: "cot" },
    { kind: "text", value: "c?t" },
    { kind: "text", value: "c*t" },
    { kind: "text", value: "~" },
    { kind: "text", value: "?" },
    { kind: "text", value: "*" },
    { kind: "text", value: "cart" },
    { kind: "number", value: 7 },
    { kind: "blank" },
  ];
  criteriaValues.forEach((input, index) => {
    sheet.cells[`A${index + 1}`] = { input };
    sheet.cells[`B${index + 1}`] = { input: { kind: "number", value: index + 1 } };
  });

  const cases: Array<[string, number]> = [
    ['=COUNTIF(A1:A10,"?")', 3],
    ['=COUNTIF(A1:A10,"*")', 8],
    ['=COUNTIF(A1:A10,"~?")', 1],
    ['=COUNTIF(A1:A10,"~*")', 1],
    ['=COUNTIF(A1:A10,"~~")', 1],
    ['=COUNTIF(A1:A10,"c?t")', 4],
    ['=SUMIF(A1:A10,"?",B1:B10)', 18],
    ['=SUMIF(A1:A10,"*",B1:B10)', 36],
    ['=SUMIF(A1:A10,"~?",B1:B10)', 6],
    ['=SUMIF(A1:A10,"~*",B1:B10)', 7],
    ['=SUMIF(A1:A10,"~~",B1:B10)', 5],
    ['=SUMIF(A1:A10,"c?t",B1:B10)', 10],
  ];
  cases.forEach(([formula], index) => {
    sheet.cells[`D${index + 1}`] = { input: { kind: "formula", formula } };
  });

  const batch = new FormulaBatch(workbook);
  cases.forEach(([, expected], index) => {
    expect(batch.evaluateCell(sheet.id, `D${index + 1}`)).toEqual({ kind: "value", value: expected });
  });
});

test("SUMIF aligns sum_range from its top-left over the criteria dimensions", () => {
  const workbook = createWorkbook();
  const sheet = workbook.sheets[0]!;
  for (const [address, value] of [
    ["A1", "cat"], ["A2", "dog"],
    ["D1", "a"], ["E1", "b"], ["D2", "c"], ["E2", "d"],
    ["J1", "skip"], ["J2", "take"],
    ["M1", "a"], ["M2", "b"], ["O1", "a"], ["P1", "b"],
  ] as const) {
    sheet.cells[address] = { input: { kind: "text", value } };
  }
  for (const [address, value] of [
    ["B1", 10], ["B2", 20],
    ["G1", 1], ["G2", 2], ["G3", 100], ["G4", 200], ["H1", 3], ["H2", 4],
    ["K2", 5],
  ] as const) {
    sheet.cells[address] = { input: { kind: "number", value } };
  }
  sheet.cells.B3 = { input: { kind: "formula", formula: "=1/0" } };
  sheet.cells.K1 = { input: { kind: "formula", formula: "=1/0" } };

  const cases: Array<[string, string, Record<string, unknown>]> = [
    ["C1", '=SUMIF(A1:A2,"*",B1:B3)', { kind: "value", value: 30 }],
    ["C2", '=SUMIF(A1:A2,"*",B1:B1)', { kind: "value", value: 30 }],
    ["I1", '=SUMIF(D1:E2,"*",G1:G4)', { kind: "value", value: 10 }],
    ["L1", '=SUMIF(J1:J2,"take",K1:K2)', { kind: "value", value: 5 }],
    ["L2", '=SUMIF(J1:J2,"skip",K1:K2)', { kind: "error", code: "#DIV/0!" }],
    ["N1", '=SUMIF(M1:M2,"*",B100000)', { kind: "error", code: "#REF!" }],
    ["Q1", '=SUMIF(O1:P1,"*",ALL1)', { kind: "error", code: "#REF!" }],
  ];
  for (const [address, formula] of cases) {
    sheet.cells[address] = { input: { kind: "formula", formula } };
  }

  expect(() => validateFormulaSyntax('=SUMIF(A1:A2,"*",B1:B3)')).not.toThrow();
  const batch = new FormulaBatch(workbook);
  for (const [address, , expected] of cases) {
    expect(batch.evaluateCell(sheet.id, address)).toMatchObject(expected);
  }
});

test("MATCH and XLOOKUP reject unsupported modes and arity", () => {
  const workbook = createWorkbook();
  const sheet = workbook.sheets[0]!;
  for (const [address, value] of [["A1", 10], ["A2", 20], ["A3", 30], ["C1", 100], ["C2", 200], ["C3", 300]] as const) {
    sheet.cells[address] = { input: { kind: "number", value } };
  }
  const formulas = [
    "=MATCH(20,A1:A3,0)",
    "=MATCH(25,A1:A3)",
    "=MATCH(25,A1:A3,1)",
    '=XLOOKUP(20,A1:A3,C1:C3,"none",0,1)',
    '=XLOOKUP(25,A1:A3,C1:C3,"none",1)',
    '=XLOOKUP(20,A1:A3,C1:C3,"none",0,-1)',
    '=XLOOKUP(20,A1:A3,C1:C3,"none",0,1,"extra")',
  ];
  formulas.forEach((formula, index) => {
    sheet.cells[`E${index + 1}`] = { input: { kind: "formula", formula } };
  });

  const batch = new FormulaBatch(workbook);
  expect(batch.evaluateCell(sheet.id, "E1")).toEqual({ kind: "value", value: 2 });
  expect(batch.evaluateCell(sheet.id, "E2")).toMatchObject({ kind: "error", code: "#VALUE!" });
  expect(batch.evaluateCell(sheet.id, "E3")).toMatchObject({ kind: "error", code: "#VALUE!" });
  expect(batch.evaluateCell(sheet.id, "E4")).toEqual({ kind: "value", value: 200 });
  expect(batch.evaluateCell(sheet.id, "E5")).toMatchObject({ kind: "error", code: "#VALUE!" });
  expect(batch.evaluateCell(sheet.id, "E6")).toMatchObject({ kind: "error", code: "#VALUE!" });
  expect(batch.evaluateCell(sheet.id, "E7")).toMatchObject({ kind: "error", code: "#VALUE!" });
});

test("ROUND uses spreadsheet half-away-from-zero semantics", () => {
  const workbook = createWorkbook();
  const sheet = workbook.sheets[0]!;
  const formulas = ["=ROUND(-1.5,0)", "=ROUND(1.5,0)", "=ROUND(-1.25,1)", "=ROUND(1.005,2)"];
  formulas.forEach((formula, index) => {
    sheet.cells[`A${index + 1}`] = { input: { kind: "formula", formula } };
  });

  const batch = new FormulaBatch(workbook);
  expect(formulas.map((_, index) => batch.evaluateCell(sheet.id, `A${index + 1}`))).toEqual([
    { kind: "value", value: -2 },
    { kind: "value", value: 2 },
    { kind: "value", value: -1.3 },
    { kind: "value", value: 1.01 },
  ]);
});

test("INDEX preserves two-dimensional coordinates and VLOOKUP supports exact arbitrary-width tables", () => {
  const workbook = createWorkbook();
  const sheet = workbook.sheets[0]!;
  const values: Array<[string, CellInput]> = [
    ["A1", { kind: "text", value: "Alpha" }], ["B1", { kind: "number", value: 10 }], ["C1", { kind: "number", value: 11 }],
    ["A2", { kind: "text", value: "Beta" }], ["B2", { kind: "number", value: 20 }], ["C2", { kind: "number", value: 21 }],
    ["A3", { kind: "text", value: "Gamma" }], ["B3", { kind: "number", value: 30 }], ["C3", { kind: "number", value: 31 }],
    ["E1", { kind: "formula", formula: '=VLOOKUP("Beta",A1:C3,3,FALSE)' }],
    ["E2", { kind: "formula", formula: "=INDEX(A1:C3,2,3)" }],
    ["E3", { kind: "formula", formula: "=INDEX(A1:C3,3,2)" }],
    ["E4", { kind: "formula", formula: '=VLOOKUP("Beta",A1:C3,3,TRUE)' }],
    ["E5", { kind: "formula", formula: '=VLOOKUP("Beta",A1:C3,3)' }],
  ];
  for (const [address, input] of values) sheet.cells[address] = { input };

  const batch = new FormulaBatch(workbook);
  expect(batch.evaluateCell(sheet.id, "E1")).toEqual({ kind: "value", value: 21 });
  expect(batch.evaluateCell(sheet.id, "E2")).toEqual({ kind: "value", value: 21 });
  expect(batch.evaluateCell(sheet.id, "E3")).toEqual({ kind: "value", value: 30 });
  expect(batch.evaluateCell(sheet.id, "E4")).toMatchObject({
    kind: "error",
    code: "#VALUE!",
    message: "VLOOKUP approximate match is not supported",
  });
  expect(batch.evaluateCell(sheet.id, "E5")).toMatchObject({
    kind: "error",
    code: "#VALUE!",
    message: "VLOOKUP requires 4 arguments with FALSE for exact matching",
  });
});

test("exponentiation binds tighter than unary signs and remains right-associative", () => {
  const workbook = createWorkbook();
  const sheet = workbook.sheets[0]!;
  const formulas = ["=-2^2", "=(-2)^2", "=2^-2", "=-2^-2", "=2^3^2"];
  formulas.forEach((formula, index) => {
    sheet.cells[`A${index + 1}`] = { input: { kind: "formula", formula } };
  });
  const batch = new FormulaBatch(workbook);
  expect(formulas.map((_, index) => batch.evaluateCell(sheet.id, `A${index + 1}`))).toEqual([
    { kind: "value", value: -4 },
    { kind: "value", value: 4 },
    { kind: "value", value: 0.25 },
    { kind: "value", value: -0.25 },
    { kind: "value", value: 512 },
  ]);
});

test("the exported formula inventory drives unsupported-function detection", () => {
  expect(SUPPORTED_FORMULA_FUNCTIONS).toContain("SUM");
  expect(SUPPORTED_FORMULA_FUNCTIONS).toContain("XLOOKUP");
  expect(new Set(SUPPORTED_FORMULA_FUNCTIONS).size).toBe(SUPPORTED_FORMULA_FUNCTIONS.length);
  expect(findUnsupportedFormulaFunctions(
    '=IF(SUM(A1:A2)>0,"PRODUCT(1) in text",PRODUCT(2,Mystery(3)))',
  )).toEqual(["MYSTERY", "PRODUCT"]);
  expect(findUnsupportedFormulaFunctions("='PRODUCT(1)'!A1+SUM(1)")).toEqual([]);
});

test("formula syntax validation uses the live grammar without evaluating cells", () => {
  expect(() => validateFormulaSyntax("=SUM('Missing sheet'!A1:B2)+ROUND(1.25,1)")).not.toThrow();
  expect(() => validateFormulaSyntax("=50%")).toThrow("Unexpected character '%'");
  expect(() => validateFormulaSyntax("=NamedRange+1")).toThrow("Named references are not supported");
  expect(() => validateFormulaSyntax("=Table1[Amount]")).toThrow();
});

test("every supported function enforces its declared argument-count boundaries", () => {
  const repeated = (count: number) => Array.from({ length: count }, () => "1").join(",");
  const signatureCases: Array<{
    name: (typeof SUPPORTED_FORMULA_FUNCTIONS)[number];
    valid: string[];
    invalid: string[];
  }> = [
    { name: "SUM", valid: ["=SUM(1)", `=SUM(${repeated(255)})`], invalid: ["=SUM()", `=SUM(${repeated(256)})`] },
    { name: "AVERAGE", valid: ["=AVERAGE(1)", `=AVERAGE(${repeated(255)})`], invalid: ["=AVERAGE()", `=AVERAGE(${repeated(256)})`] },
    { name: "MIN", valid: ["=MIN(1)", `=MIN(${repeated(255)})`], invalid: ["=MIN()", `=MIN(${repeated(256)})`] },
    { name: "MAX", valid: ["=MAX(1)", `=MAX(${repeated(255)})`], invalid: ["=MAX()", `=MAX(${repeated(256)})`] },
    { name: "COUNT", valid: ["=COUNT(1)", `=COUNT(${repeated(255)})`], invalid: ["=COUNT()", `=COUNT(${repeated(256)})`] },
    { name: "COUNTA", valid: ["=COUNTA(1)", `=COUNTA(${repeated(255)})`], invalid: ["=COUNTA()", `=COUNTA(${repeated(256)})`] },
    { name: "IF", valid: ["=IF(TRUE,1)", "=IF(TRUE,1,0)"], invalid: ["=IF(TRUE)", "=IF(TRUE,1,0,2)"] },
    { name: "IFERROR", valid: ["=IFERROR(1,0)"], invalid: ["=IFERROR(1)", "=IFERROR(1,0,2)"] },
    { name: "ROUND", valid: ["=ROUND(1.25,1)"], invalid: ["=ROUND(1.25)", "=ROUND(1.25,1,2)"] },
    { name: "ABS", valid: ["=ABS(-1)"], invalid: ["=ABS()", "=ABS(-1,2)"] },
    { name: "COUNTIF", valid: ["=COUNTIF(A1:A1,1)"], invalid: ["=COUNTIF(A1:A1)", "=COUNTIF(A1:A1,1,2)"] },
    { name: "SUMIF", valid: ["=SUMIF(A1:A1,1)", "=SUMIF(A1:A1,1,B1:B1)"], invalid: ["=SUMIF(A1:A1)", "=SUMIF(A1:A1,1,B1:B1,2)"] },
    { name: "XLOOKUP", valid: ["=XLOOKUP(1,A1:A1,B1:B1)", "=XLOOKUP(1,A1:A1,B1:B1,0,0,1)"], invalid: ["=XLOOKUP(1,A1:A1)", "=XLOOKUP(1,A1:A1,B1:B1,0,0,1,2)"] },
    { name: "VLOOKUP", valid: ["=VLOOKUP(1,A1:B1,2,FALSE)"], invalid: ["=VLOOKUP(1,A1:B1)", "=VLOOKUP(1,A1:B1,2)", "=VLOOKUP(1,A1:B1,2,FALSE,1)"] },
    { name: "INDEX", valid: ["=INDEX(A1:B1,1)", "=INDEX(A1:B1,1,2)"], invalid: ["=INDEX(A1:B1)", "=INDEX(A1:B1,1,2,3)"] },
    { name: "MATCH", valid: ["=MATCH(1,A1:A1,0)"], invalid: ["=MATCH(1,A1:A1)", "=MATCH(1,A1:A1,0,1)"] },
    { name: "TEXTJOIN", valid: ['=TEXTJOIN(",",TRUE,1)', `=TEXTJOIN(",",TRUE,${repeated(252)})`], invalid: ['=TEXTJOIN(",",TRUE)', `=TEXTJOIN(",",TRUE,${repeated(253)})`] },
    { name: "DATE", valid: ["=DATE(2024,1,1)"], invalid: ["=DATE(2024,1)", "=DATE(2024,1,1,1)"] },
    { name: "TODAY", valid: ["=TODAY()"], invalid: ["=TODAY(1)"] },
    { name: "NOW", valid: ["=NOW()"], invalid: ["=NOW(1)"] },
  ];

  expect(signatureCases.map(({ name }) => name)).toEqual([...SUPPORTED_FORMULA_FUNCTIONS]);
  for (const { valid, invalid } of signatureCases) {
    for (const formula of valid) expect(() => validateFormulaSyntax(formula)).not.toThrow();
    for (const formula of invalid) expect(() => validateFormulaSyntax(formula)).toThrow("requires");
  }

  const workbook = createWorkbook();
  const sheet = workbook.sheets[0]!;
  const invalidFormulas = signatureCases.flatMap(({ name, invalid }) => invalid.map((formula) => ({ name, formula })));
  invalidFormulas.forEach(({ formula }, index) => {
    sheet.cells[`Z${index + 1}`] = { input: { kind: "formula", formula } };
  });
  const batch = new FormulaBatch(workbook);
  invalidFormulas.forEach(({ name }, index) => {
    expect(batch.evaluateCell(sheet.id, `Z${index + 1}`)).toMatchObject({
      kind: "error",
      code: "#VALUE!",
      message: expect.stringContaining(`${name} requires`),
    });
  });
});

test("formula evaluation caps deep scalar chains before the JavaScript stack overflows", () => {
  const workbook = createWorkbook();
  const sheet = workbook.sheets[0]!;
  for (let row = 1; row < 600; row += 1) {
    sheet.cells[`A${row}`] = { input: { kind: "formula", formula: `=A${row + 1}` } };
  }
  sheet.cells.A600 = { input: { kind: "number", value: 1 } };
  expect(new FormulaBatch(workbook).evaluateCell(sheet.id, "A1")).toMatchObject({
    kind: "error",
    code: "#NUM!",
    message: "Formula dependency depth limit exceeded",
  });
});

test("date display honors both Excel date systems and the serial-60 compatibility slot", () => {
  const workbook = createWorkbook();
  const sheet = workbook.sheets[0]!;
  sheet.cells.A1 = { input: { kind: "number", value: 60 }, style: { numberFormat: "date" } };
  expect(new FormulaBatch(workbook).displayCell(sheet.id, "A1")).toBe("1900-02-29");
  workbook.calculation.dateSystem = 1904;
  sheet.cells.A1 = { input: { kind: "number", value: 0 }, style: { numberFormat: "date" } };
  expect(new FormulaBatch(workbook).displayCell(sheet.id, "A1")).toBe("1904-01-01");
});
