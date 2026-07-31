import { expect, test } from "bun:test";
import { SPREADSHEET_LIMITS } from "../src/constants.ts";
import {
  FORMULA_CATEGORIES,
  FORMULA_FUNCTION_GUIDES,
  WORKBOOK_HELP_TOPICS,
  WORKBOOK_OPERATION_NAMES,
  formulaHintForDraft,
  getWorkbookHelp,
} from "../src/help.ts";
import {
  FORMULA_FUNCTION_ARITIES,
  SUPPORTED_FORMULA_FUNCTIONS,
  validateFormulaSyntax,
} from "../src/formula.ts";

test("formula help is exhaustive, syntax-valid, and derived from live arities", () => {
  expect(FORMULA_FUNCTION_GUIDES.map((guide) => guide.name)).toEqual([...SUPPORTED_FORMULA_FUNCTIONS]);
  expect(new Set(FORMULA_FUNCTION_GUIDES.map((guide) => guide.name)).size).toBe(SUPPORTED_FORMULA_FUNCTIONS.length);
  for (const guide of FORMULA_FUNCTION_GUIDES) {
    expect(guide.minimumArguments).toBe(FORMULA_FUNCTION_ARITIES[guide.name].min);
    expect(guide.maximumArguments).toBe(FORMULA_FUNCTION_ARITIES[guide.name].max);
    expect(FORMULA_CATEGORIES).toContain(guide.category);
    expect(() => validateFormulaSyntax(guide.example)).not.toThrow();
  }
  expect(FORMULA_FUNCTION_ARITIES.VLOOKUP).toMatchObject({ min: 4, max: 4 });
  expect(FORMULA_FUNCTION_GUIDES.find((guide) => guide.name === "VLOOKUP")?.syntax).toContain("FALSE");
});

test("workbook help covers capabilities and searches formula names, purposes, and notes", () => {
  const overview = getWorkbookHelp({});
  expect(overview).toMatchObject({ version: 1, topic: "overview", functions: [] });
  expect(overview.sections.flatMap((section) => section.items).join(" ")).toContain("workbook_status");

  const lookups = getWorkbookHelp({ topic: "functions", category: "lookup" });
  expect(lookups.functions.map((guide) => guide.name)).toEqual(["XLOOKUP", "VLOOKUP", "INDEX", "MATCH"]);
  expect(getWorkbookHelp({ topic: "functions", query: "wildcard" }).functions.map((guide) => guide.name)).toEqual(["COUNTIF", "SUMIF"]);
  expect(getWorkbookHelp({ topic: "functions", query: "date" }).functions.map((guide) => guide.name)).toEqual(["DATE", "TODAY", "NOW"]);

  const one = getWorkbookHelp({ topic: "function", functionName: "xlookup" });
  expect(one.functions).toHaveLength(1);
  expect(one.functions[0]).toMatchObject({ name: "XLOOKUP", minimumArguments: 3, maximumArguments: 6 });
  expect(one.functions[0]!.notes.join(" ")).toContain("exact match mode 0");
  expect(getWorkbookHelp({ topic: "function", functionName: "eval" })).toMatchObject({ functions: [], topic: "function" });

  const errors = getWorkbookHelp({ topic: "errors" }).sections.flatMap((section) => section.items).join(" ");
  for (const code of ["#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#CYCLE!"]) expect(errors).toContain(code);
  expect(new Set(WORKBOOK_OPERATION_NAMES).size).toBe(WORKBOOK_OPERATION_NAMES.length);
  expect(new Set(WORKBOOK_HELP_TOPICS).size).toBe(WORKBOOK_HELP_TOPICS.length);

  const maximumResponseBytes = new TextEncoder().encode(JSON.stringify(getWorkbookHelp({ topic: "functions" }))).byteLength;
  expect(maximumResponseBytes).toBeLessThan(SPREADSHEET_LIMITS.maxReadBytes);
});

test("contextual formula hints understand nesting and ignore function-like quoted text", () => {
  expect(formulaHintForDraft("=")).toContain("Click or drag cells");
  expect(formulaHintForDraft("=SUM(")).toContain("SUM(number1");
  expect(formulaHintForDraft("=SUM((A1+")).toContain("SUM(number1");
  expect(formulaHintForDraft('=IF(A1,"SUM(",XLOOKUP(')).toContain("XLOOKUP(value");
  expect(formulaHintForDraft("=FOO(")).toContain("FOO is not supported");
  expect(formulaHintForDraft("plain text")).toBe("Formulas begin with =");
});
