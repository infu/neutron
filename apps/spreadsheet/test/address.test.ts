import { expect, test } from "bun:test";
import {
  columnIndex,
  columnName,
  formatRange,
  parseCellAddress,
  parseRange,
  renameFormulaSheetReferences,
  translateFormula,
  translateFormulaStructure,
} from "../src/address.ts";

test("A1 addresses and normalized ranges round-trip", () => {
  expect(columnName(0)).toBe("A");
  expect(columnName(25)).toBe("Z");
  expect(columnName(26)).toBe("AA");
  expect(columnIndex("ALL")).toBe(999);
  expect(parseCellAddress("$b$12")).toEqual({ row: 11, column: 1 });
  expect(formatRange(parseRange("D8:B2"))).toBe("B2:D8");
});

test("formula translation moves relative references and preserves absolutes and strings", () => {
  expect(translateFormula("=A1+$B1+C$2+$D$4", 2, 3)).toBe("=D3+$B3+F$2+$D$4");
  expect(translateFormula("=SUM('Q 1'!A1:B2)+\"A1 stays text\"", 1, 1)).toBe(
    "=SUM('Q 1'!B2:C3)+\"A1 stays text\"",
  );
  expect(translateFormula("=A1", -1, 0)).toBe("=#REF!");
});

test("structural formula translation contracts ranges and preserves dollar markers", () => {
  expect(translateFormulaStructure("=SUM($A$1:$A$10)", {
    axis: "row", kind: "delete", index: 0, count: 1,
    currentSheetName: "Data", targetSheetName: "Data",
  })).toBe("=SUM($A$1:$A$9)");
  expect(translateFormulaStructure("=SUM(Data!A1:A10)", {
    axis: "row", kind: "insert", index: 4, count: 2,
    currentSheetName: "Summary", targetSheetName: "Data",
  })).toBe("=SUM(Data!A1:A12)");
  expect(translateFormulaStructure("=A2+Other!A2+\"A2\"", {
    axis: "row", kind: "delete", index: 1, count: 1,
    currentSheetName: "Data", targetSheetName: "Data",
  })).toBe("=#REF!+Other!A2+\"A2\"");
});

test("sheet rename rewriting handles escaped quoted names", () => {
  expect(renameFormulaSheetReferences("='O''Brien'!$A1+\"O'Brien!A1\"", "O'Brien", "2026 Plan")).toBe(
    "='2026 Plan'!$A1+\"O'Brien!A1\"",
  );
});
