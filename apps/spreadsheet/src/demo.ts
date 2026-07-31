import {
  createSheet,
  createWorkbook,
  type CellInput,
  type CellStyle,
  type SpreadsheetSheet,
  type SpreadsheetWorkbook,
} from "./model.ts";

/**
 * A deterministic, editable gallery of Spreadsheet v1 workbook state. Actions
 * and lifecycle behavior are exercised by the companion 20-flow browser tour.
 * Loading it is explicit and never writes to Files automatically.
 */
export function createKitchenSinkWorkbook(now = Date.UTC(2026, 6, 14, 12)): SpreadsheetWorkbook {
  const workbook = createWorkbook(now);
  workbook.workbookId = "wb_neutron_spreadsheet_kitchen_sink";
  workbook.metadata = { createdAt: now, updatedAt: now };

  const readMe = createSheet("Read me");
  const sales = createSheet("Sales");
  const summary = createSheet("Summary");
  const inventory = createSheet("Inventory");
  const formats = createSheet("Formats");
  const formulas = createSheet("Formula gallery");
  readMe.id = "sheet_demo_read_me";
  sales.id = "sheet_demo_sales";
  summary.id = "sheet_demo_summary";
  inventory.id = "sheet_demo_inventory";
  formats.id = "sheet_demo_formats";
  formulas.id = "sheet_demo_formula_gallery";
  workbook.sheets = [readMe, sales, summary, inventory, formats, formulas];

  buildReadMe(readMe);
  buildSales(sales);
  buildSummary(summary);
  buildInventory(inventory);
  buildFormats(formats);
  buildFormulaGallery(formulas);
  return workbook;
}

const TITLE: CellStyle = {
  bold: true,
  fillColor: "#183d2e",
  textColor: "#effff6",
};
const HEADER: CellStyle = {
  bold: true,
  fillColor: "#243247",
  textColor: "#f1f6ff",
  alignment: "center",
};
const SUBTLE: CellStyle = { fillColor: "#182230", textColor: "#b9c8da" };
const CURRENCY: CellStyle = { numberFormat: "currency", decimals: 2, alignment: "right" };
const PERCENT: CellStyle = { numberFormat: "percent", decimals: 0, alignment: "right" };
const DATE: CellStyle = { numberFormat: "date", alignment: "center" };

function buildReadMe(sheet: SpreadsheetSheet): void {
  put(sheet, "A1", text("Neutron Spreadsheet — Kitchen Sink"), TITLE);
  put(sheet, "A2", text("An editable static gallery of shipped workbook features. Action and lifecycle behavior is covered by the companion 20-flow tour. Nothing is saved until Save as."), { wrap: true });
  matrix(sheet, "A4", [
    ["Feature", "Try it", "Agent surface"],
    ["Fast cell editing", "Type in A1, use the formula bar, Enter/Tab, or Escape", "workbook_apply / set_cells"],
    ["Formula calculation", "Verify Formula gallery!B4:B24; raw formulas remain editable", "workbook_read returns raw + computed + display"],
    ["Series and formula fill", "Select seeds, extend the range, then Fill down/right", "workbook_apply / fill"],
    ["Formatting", "Verify Formats!B4:C10 for number/date/time, then A12:C12 for alignment, color, bold, italic, and wrap", "workbook_apply / apply_style"],
    ["Tables", "Sales starts filtered to North; clear it to reveal all eight orders, then sort without moving the header", "sort_range / set_filter / clear_filter"],
    ["Workbook structure", "Add, rename, delete sheets and insert/delete rows or columns", "same atomic operations"],
    ["History", "Every workbook edit is one Undo step and can be Redone safely", "history-head protected undo / redo"],
    ["Files", "Save losslessly as .nsheet; export reviewed CSV/XLSX snapshots", "workbook_save + Files binary transport"],
    ["Search", "Find values or raw formulas across all sheets", "workbook_find"],
    ["JavaScript functions", "Intentionally unavailable in v1", "gated by design"],
  ], HEADER);
  sheet.columnWidths = { "0": 180, "1": 420, "2": 330 };
  sheet.rowHeights = { "0": 34, "1": 48 };
}

function buildSales(sheet: SpreadsheetSheet): void {
  matrix(sheet, "A1", [["Date", "Region", "Product", "Units", "Unit price", "Revenue", "Target", "Status"]], HEADER);
  const rows: Array<[number, string, string, number, number, number]> = [
    [46027, "North", "Aurora", 12, 129, 1400],
    [46034, "South", "Beacon", 8, 179, 1500],
    [46041, "North", "Comet", 15, 99, 1350],
    [46048, "West", "Aurora", 10, 129, 1200],
    [46055, "East", "Beacon", 14, 179, 2200],
    [46062, "South", "Comet", 18, 99, 1600],
    [46069, "West", "Beacon", 9, 179, 1550],
    [46076, "East", "Aurora", 16, 129, 1900],
  ];
  rows.forEach(([date, region, product, units, price, target], index) => {
    const row = index + 2;
    put(sheet, `A${row}`, number(date), DATE);
    put(sheet, `B${row}`, text(region));
    put(sheet, `C${row}`, text(product));
    put(sheet, `D${row}`, number(units), { numberFormat: "number", decimals: 0, alignment: "right" });
    put(sheet, `E${row}`, number(price), CURRENCY);
    put(sheet, `F${row}`, formula(`=D${row}*E${row}`), CURRENCY);
    put(sheet, `G${row}`, number(target), CURRENCY);
    put(sheet, `H${row}`, formula(`=IF(F${row}>=G${row},"Hit","Watch")`), { alignment: "center" });
  });
  put(sheet, "C11", text("Totals"), { ...HEADER, alignment: "right" });
  put(sheet, "D11", formula("=SUM(D2:D9)"), { ...HEADER, numberFormat: "number", decimals: 0 });
  put(sheet, "F11", formula("=SUM(F2:F9)"), { ...HEADER, numberFormat: "currency", decimals: 2 });
  put(sheet, "G11", formula("=SUM(G2:G9)"), { ...HEADER, numberFormat: "currency", decimals: 2 });
  sheet.columnWidths = { "0": 116, "1": 100, "2": 120, "3": 82, "4": 110, "5": 120, "6": 110, "7": 92 };
  sheet.filter = { range: "A1:H9", column: 1, equals: "North" };
}

function buildSummary(sheet: SpreadsheetSheet): void {
  put(sheet, "A1", text("Sales dashboard"), TITLE);
  matrix(sheet, "A3", [
    ["Metric", "Live result", "Formula pattern"],
    ["Revenue", "=SUM(Sales!F2:F9)", "SUM across a sheet"],
    ["Average units", "=AVERAGE(Sales!D2:D9)", "AVERAGE range"],
    ["Largest order", "=MAX(Sales!F2:F9)", "MAX range"],
    ["Orders at target", "=COUNTIF(Sales!H2:H9,\"Hit\")", "COUNTIF criterion"],
    ["North revenue", "=SUMIF(Sales!B2:B9,\"North\",Sales!F2:F9)", "SUMIF range + sum range"],
    ["Beacon price", "=XLOOKUP(\"Beacon\",Inventory!A2:A4,Inventory!C2:C4,\"Missing\")", "Cross-sheet XLOOKUP"],
    ["Report day", "=TODAY()", "Volatile date snapshot"],
  ], HEADER);
  for (let row = 4; row <= 10; row += 1) {
    const input = sheet.cells[`B${row}`]?.input;
    const formulaText = input?.kind === "text" ? input.value : "";
    sheet.cells[`B${row}`] = { input: formula(formulaText), style: row === 10 ? DATE : row === 5 || row === 7 ? { numberFormat: "number", decimals: 1 } : CURRENCY };
  }
  put(sheet, "A12", text("Tip"), SUBTLE);
  put(sheet, "B12", text("Change Sales values and this sheet recalculates immediately."), { ...SUBTLE, wrap: true });
  sheet.columnWidths = { "0": 160, "1": 190, "2": 260 };
  sheet.rowHeights = { "0": 34, "11": 44 };
}

function buildInventory(sheet: SpreadsheetSheet): void {
  matrix(sheet, "A1", [["Product", "Category", "List price", "In stock", "Stock value", "Restock?"]], HEADER);
  const rows: Array<[string, string, number, number]> = [
    ["Aurora", "Core", 129, 24],
    ["Beacon", "Plus", 179, 7],
    ["Comet", "Core", 99, 41],
  ];
  rows.forEach(([product, category, price, stock], index) => {
    const row = index + 2;
    put(sheet, `A${row}`, text(product));
    put(sheet, `B${row}`, text(category));
    put(sheet, `C${row}`, number(price), CURRENCY);
    put(sheet, `D${row}`, number(stock), { numberFormat: "number", decimals: 0 });
    put(sheet, `E${row}`, formula(`=C${row}*D${row}`), CURRENCY);
    put(sheet, `F${row}`, formula(`=IF(D${row}<10,"Yes","No")`), { alignment: "center" });
  });
  put(sheet, "A7", text("Lookup example"), SUBTLE);
  put(sheet, "B7", text("Beacon"), SUBTLE);
  put(sheet, "C7", formula("=XLOOKUP(B7,A2:A4,C2:C4,\"Missing\")"), { ...SUBTLE, ...CURRENCY });
  sheet.columnWidths = { "0": 120, "1": 110, "2": 110, "3": 95, "4": 120, "5": 100 };
}

function buildFormats(sheet: SpreadsheetSheet): void {
  put(sheet, "A1", text("Formatting gallery"), TITLE);
  matrix(sheet, "A3", [
    ["Format", "Raw value", "Rendered example", "Notes"],
    ["General", 1234.567, 1234.567, "No forced representation"],
    ["Number", 1234.567, 1234.567, "Two decimals"],
    ["Currency", 1234.5, 1234.5, "Currency snapshot"],
    ["Percent", 0.275, 0.275, "Stored as 0.275"],
    ["Date", 46076, 46076, "Excel-compatible serial"],
    ["Time", 0.6458333333, 0.6458333333, "Fraction of one day"],
    ["Boolean", true, true, "Tagged scalar"],
  ], HEADER);
  put(sheet, "C5", number(1234.567), { numberFormat: "number", decimals: 2, alignment: "right" });
  put(sheet, "C6", number(1234.5), CURRENCY);
  put(sheet, "C7", number(0.275), { ...PERCENT, decimals: 1 });
  put(sheet, "C8", number(46076), DATE);
  put(sheet, "C9", number(0.6458333333), { numberFormat: "time", alignment: "center" });
  put(sheet, "C10", bool(true), { alignment: "center" });
  put(sheet, "A12", text("Bold + centered"), { bold: true, alignment: "center", fillColor: "#284266", textColor: "#f5f8ff" });
  put(sheet, "B12", text("Italic"), { italic: true, textColor: "#f6c768" });
  put(sheet, "C12", text("Wrapped text grows with a custom row height."), { wrap: true, fillColor: "#3a2633", textColor: "#ffdce8" });
  sheet.columnWidths = { "0": 150, "1": 120, "2": 230, "3": 240 };
  sheet.rowHeights = { "0": 34, "11": 56 };
}

function buildFormulaGallery(sheet: SpreadsheetSheet): void {
  put(sheet, "A1", text("Formula gallery"), TITLE);
  matrix(sheet, "A3", [["Function", "Live example", "Purpose"]], HEADER);
  matrix(sheet, "G1", [
    ["Numbers", "Labels", "Lookup values"],
    [10, "Alpha", 100],
    [20, "Beta", 200],
    [30, "Gamma", 300],
  ], HEADER);
  const examples: Array<[string, string, string, CellStyle?]> = [
    ["SUM", "=SUM($G$2:$G$4)", "Add numeric values"],
    ["AVERAGE", "=AVERAGE($G$2:$G$4)", "Arithmetic mean"],
    ["MIN", "=MIN($G$2:$G$4)", "Smallest value"],
    ["MAX", "=MAX($G$2:$G$4)", "Largest value"],
    ["COUNT", "=COUNT($G$2:$G$4)", "Count numeric values"],
    ["COUNTA", "=COUNTA($H$2:$H$4)", "Count nonblank values"],
    ["IF", "=IF($G$2>5,\"yes\",\"no\")", "Conditional result"],
    ["IFERROR", "=IFERROR(1/0,\"handled\")", "Recover from an error"],
    ["ROUND", "=ROUND(10/3,2)", "Round to digits"],
    ["ABS", "=ABS(-7)", "Absolute value"],
    ["COUNTIF", "=COUNTIF($G$2:$G$4,\">15\")", "Count matching values"],
    ["SUMIF", "=SUMIF($H$2:$H$4,\"Beta\",$G$2:$G$4)", "Sum matching values"],
    ["XLOOKUP", "=XLOOKUP(\"Beta\",$H$2:$H$4,$I$2:$I$4,\"missing\")", "Modern lookup"],
    ["VLOOKUP", "=VLOOKUP(\"Beta\",$H$2:$I$4,2,FALSE)", "Table lookup"],
    ["INDEX", "=INDEX($G$2:$G$4,2)", "Value by position"],
    ["MATCH", "=MATCH(20,$G$2:$G$4,0)", "Position of a value"],
    ["TEXTJOIN", "=TEXTJOIN(\" · \",TRUE,$H$2:$H$4)", "Join text"],
    ["DATE", "=DATE(2026,7,14)", "Build a date", DATE],
    ["TODAY", "=TODAY()", "Current date", DATE],
    ["NOW", "=NOW()", "Current time snapshot", { numberFormat: "time" }],
    ["Error example", "=1/0", "Errors stay explicit and inspectable"],
  ];
  examples.forEach(([name, expression, purpose, style], index) => {
    const row = index + 4;
    put(sheet, `A${row}`, text(name), name === "Error example" ? { textColor: "#ff858c" } : undefined);
    put(sheet, `B${row}`, formula(expression), style);
    put(sheet, `C${row}`, text(purpose));
  });
  sheet.columnWidths = { "0": 130, "1": 230, "2": 230, "6": 100, "7": 110, "8": 120 };
  sheet.rowHeights = { "0": 34 };
}

function matrix(sheet: SpreadsheetSheet, start: string, rows: Array<Array<string | number | boolean>>, headerStyle?: CellStyle): void {
  const match = /^([A-Z]+)([1-9][0-9]*)$/.exec(start);
  if (!match) throw new Error(`Invalid demo matrix start ${start}`);
  const startColumn = columnIndex(match[1]!);
  const startRow = Number(match[2]);
  rows.forEach((row, rowOffset) => row.forEach((value, columnOffset) => {
    put(
      sheet,
      `${columnLabel(startColumn + columnOffset)}${startRow + rowOffset}`,
      typeof value === "number" ? number(value) : typeof value === "boolean" ? bool(value) : text(value),
      rowOffset === 0 ? headerStyle : undefined,
    );
  }));
}

function put(sheet: SpreadsheetSheet, address: string, input: CellInput, style?: CellStyle): void {
  sheet.cells[address] = { input, ...(style ? { style: { ...style } } : {}) };
}

function text(value: string): CellInput { return { kind: "text", value }; }
function number(value: number): CellInput { return { kind: "number", value }; }
function bool(value: boolean): CellInput { return { kind: "boolean", value }; }
function formula(value: string): CellInput { return { kind: "formula", formula: value }; }

function columnIndex(label: string): number {
  let result = 0;
  for (const character of label) result = result * 26 + character.charCodeAt(0) - 64;
  return result - 1;
}

function columnLabel(index: number): string {
  let current = index + 1;
  let result = "";
  while (current > 0) {
    const remainder = (current - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    current = Math.floor((current - 1) / 26);
  }
  return result;
}
