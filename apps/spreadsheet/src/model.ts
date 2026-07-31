import { formatCellAddress, formatRange, parseCellAddress, parseRange } from "./address.ts";
import { NATIVE_FORMAT, NATIVE_VERSION, SPREADSHEET_LIMITS } from "./constants.ts";

export type BlankInput = { kind: "blank" };
export type TextInput = { kind: "text"; value: string };
export type NumberInput = { kind: "number"; value: number };
export type BooleanInput = { kind: "boolean"; value: boolean };
export type FormulaInput = { kind: "formula"; formula: string };
export type CellInput = BlankInput | TextInput | NumberInput | BooleanInput | FormulaInput;

export const BLANK: BlankInput = Object.freeze({ kind: "blank" });

export type HorizontalAlignment = "left" | "center" | "right";
export type CellStyle = {
  numberFormat?: "general" | "number" | "currency" | "percent" | "date" | "time";
  decimals?: number;
  bold?: boolean;
  italic?: boolean;
  textColor?: string;
  fillColor?: string;
  alignment?: HorizontalAlignment;
  wrap?: boolean;
};

export type CellRecord = {
  input: CellInput;
  style?: CellStyle;
};

type SheetFilterBase = {
  range: string;
  column: number;
};

export type SheetFilter =
  | (SheetFilterBase & { equals: string; nonBlank?: never })
  | (SheetFilterBase & { nonBlank: true; equals?: never });

export type SpreadsheetSheet = {
  id: string;
  name: string;
  cells: Record<string, CellRecord>;
  columnWidths?: Record<string, number>;
  rowHeights?: Record<string, number>;
  filter?: SheetFilter;
};

export type SpreadsheetWorkbook = {
  format: typeof NATIVE_FORMAT;
  version: typeof NATIVE_VERSION;
  workbookId: string;
  calculation: {
    language: "enUS";
    dateSystem: 1900 | 1904;
    timeZone: string;
  };
  sheets: SpreadsheetSheet[];
  /** Reserved native tables keep version 1 forward-compatible with gated features. */
  styles: CellStyle[];
  javascriptFunctions: [];
  metadata: { createdAt: number; updatedAt: number };
};

export type CellValue = number | string | boolean | null;
export type FormulaErrorCode =
  | "#DIV/0!"
  | "#VALUE!"
  | "#REF!"
  | "#NAME?"
  | "#NUM!"
  | "#N/A"
  | "#CYCLE!";

export type ComputedCell =
  | { kind: "blank"; value: null }
  | { kind: "value"; value: string | number | boolean }
  | { kind: "error"; code: FormulaErrorCode; message: string };

export function createWorkbook(now = Date.now()): SpreadsheetWorkbook {
  return {
    format: NATIVE_FORMAT,
    version: NATIVE_VERSION,
    workbookId: createId("wb"),
    calculation: { language: "enUS", dateSystem: 1900, timeZone: "UTC" },
    sheets: [createSheet("Sheet1")],
    styles: [],
    javascriptFunctions: [],
    metadata: { createdAt: now, updatedAt: now },
  };
}

export function createSheet(name: string): SpreadsheetSheet {
  return { id: createId("sheet"), name: normalizeSheetName(name), cells: {} };
}

export function cloneWorkbook(workbook: SpreadsheetWorkbook): SpreadsheetWorkbook {
  return structuredClone(workbook);
}

export function createId(prefix: string): string {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return `${prefix}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function normalizeSheetName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 31 || /[\\/*?:[\]]/.test(trimmed)) {
    throw new WorkbookModelError("INVALID_SHEET_NAME", "Sheet names must be 1-31 characters and omit \\ / * ? : [ ]");
  }
  return trimmed;
}

export function assertUniqueSheetName(workbook: SpreadsheetWorkbook, name: string, exceptId?: string): void {
  const normalized = normalizeSheetName(name).toLocaleLowerCase("en-US");
  if (workbook.sheets.some((sheet) => sheet.id !== exceptId && sheet.name.toLocaleLowerCase("en-US") === normalized)) {
    throw new WorkbookModelError("DUPLICATE_SHEET_NAME", `A sheet named '${name}' already exists`);
  }
}

export function normalizeSheetFilter(value: unknown): SheetFilter {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkbookModelError("INVALID_FILTER", "Filter must be an object");
  }
  const candidate = value as Record<string, unknown>;
  const hasEquals = Object.hasOwn(candidate, "equals");
  const hasNonBlank = Object.hasOwn(candidate, "nonBlank");
  const allowed = new Set(["range", "column", hasEquals ? "equals" : "nonBlank"]);
  if (
    hasEquals === hasNonBlank ||
    Object.keys(candidate).some((key) => !allowed.has(key)) ||
    typeof candidate.range !== "string" ||
    !Number.isInteger(candidate.column)
  ) {
    throw new WorkbookModelError("INVALID_FILTER", "Filter requires range, column, and exactly one predicate");
  }
  const range = parseRange(candidate.range);
  const column = candidate.column as number;
  if (column < range.start.column || column > range.end.column) {
    throw new WorkbookModelError("INVALID_FILTER", "Filter column must be inside its range");
  }
  const normalizedRange = formatRange(range);
  if (hasEquals) {
    if (typeof candidate.equals !== "string" || candidate.equals.length > SPREADSHEET_LIMITS.maxTextLength) {
      throw new WorkbookModelError("INVALID_FILTER", "Filter equals predicate must be a string");
    }
    return { range: normalizedRange, column, equals: candidate.equals };
  }
  if (candidate.nonBlank !== true) {
    throw new WorkbookModelError("INVALID_FILTER", "Filter nonBlank predicate must be true");
  }
  return { range: normalizedRange, column, nonBlank: true };
}

export function requireSheet(workbook: SpreadsheetWorkbook, sheetIdOrName: string): SpreadsheetSheet {
  const lowered = sheetIdOrName.toLocaleLowerCase("en-US");
  const sheet = workbook.sheets.find(
    (candidate) => candidate.id === sheetIdOrName || candidate.name.toLocaleLowerCase("en-US") === lowered,
  );
  if (!sheet) throw new WorkbookModelError("SHEET_NOT_FOUND", `Sheet '${sheetIdOrName}' does not exist`);
  return sheet;
}

export function getCell(sheet: SpreadsheetSheet, address: string): CellRecord | undefined {
  return sheet.cells[formatCellAddress(parseCellAddress(address))];
}

export function setCell(sheet: SpreadsheetSheet, address: string, record: CellRecord): void {
  const key = formatCellAddress(parseCellAddress(address));
  assertCellRecord(record);
  if (record.input.kind === "blank" && !record.style) delete sheet.cells[key];
  else sheet.cells[key] = cloneCellRecord(record);
}

export function cloneCellRecord(record: CellRecord): CellRecord {
  return {
    input: { ...record.input } as CellInput,
    ...(record.style ? { style: { ...record.style } } : {}),
  };
}

export function rawInputFromText(raw: string): CellInput {
  if (raw === "") return BLANK;
  if (raw.startsWith("'")) return { kind: "text", value: raw.slice(1) };
  if (raw.startsWith("=")) {
    if (raw.length > SPREADSHEET_LIMITS.maxFormulaLength) {
      throw new WorkbookModelError("LIMIT", "Formula is too long");
    }
    return { kind: "formula", formula: raw };
  }
  if (/^(true|false)$/i.test(raw)) return { kind: "boolean", value: raw.toLowerCase() === "true" };
  const numericText = raw.trim();
  if (
    /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[Ee][+-]?\d+)?$/.test(numericText) &&
    !isLeadingZeroIdentifier(numericText) &&
    significantDigitCount(numericText) <= 15
  ) {
    const value = Number(raw);
    if (Number.isFinite(value)) return { kind: "number", value };
  }
  if (raw.length > SPREADSHEET_LIMITS.maxTextLength) {
    throw new WorkbookModelError("LIMIT", "Cell text is too long");
  }
  return { kind: "text", value: raw };
}

function isLeadingZeroIdentifier(value: string): boolean {
  const unsigned = value.replace(/^[+-]/, "");
  const mantissa = unsigned.split(/[Ee]/, 1)[0]!;
  return /^0\d+$/.test(mantissa);
}

function significantDigitCount(value: string): number {
  const mantissa = value.replace(/^[+-]/, "").split(/[Ee]/, 1)[0]!;
  const digits = mantissa.replace(".", "").replace(/^0+/, "");
  return digits.length;
}

export function rawInputToText(input: CellInput): string {
  switch (input.kind) {
    case "blank": return "";
    case "text": return input.value;
    case "number": return String(input.value);
    case "boolean": return input.value ? "TRUE" : "FALSE";
    case "formula": return input.formula;
  }
}

export function assertCellInput(input: unknown): asserts input is CellInput {
  if (!input || typeof input !== "object") throw new WorkbookModelError("INVALID_CELL", "Cell input must be tagged");
  const candidate = input as Record<string, unknown>;
  switch (candidate.kind) {
    case "blank": return;
    case "text":
      if (typeof candidate.value === "string" && candidate.value.length <= SPREADSHEET_LIMITS.maxTextLength) return;
      break;
    case "number":
      if (typeof candidate.value === "number" && Number.isFinite(candidate.value)) return;
      break;
    case "boolean":
      if (typeof candidate.value === "boolean") return;
      break;
    case "formula":
      if (
        typeof candidate.formula === "string" &&
        candidate.formula.startsWith("=") &&
        candidate.formula.length <= SPREADSHEET_LIMITS.maxFormulaLength
      ) return;
      break;
  }
  throw new WorkbookModelError("INVALID_CELL", "Invalid tagged cell input");
}

export function assertCellRecord(record: unknown): asserts record is CellRecord {
  if (!record || typeof record !== "object") throw new WorkbookModelError("INVALID_CELL", "Cell record must be an object");
  assertCellInput((record as CellRecord).input);
  const style = (record as CellRecord).style;
  if (style !== undefined) assertCellStyle(style);
}

export function assertCellStyle(style: unknown): asserts style is CellStyle {
  if (!style || typeof style !== "object" || Array.isArray(style)) {
    throw new WorkbookModelError("INVALID_STYLE", "Style must be an object");
  }
  const value = style as Record<string, unknown>;
  const allowed = new Set(["numberFormat", "decimals", "bold", "italic", "textColor", "fillColor", "alignment", "wrap"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new WorkbookModelError("INVALID_STYLE", "Style has unsupported properties");
  if (value.decimals !== undefined && (!Number.isInteger(value.decimals) || (value.decimals as number) < 0 || (value.decimals as number) > 12)) {
    throw new WorkbookModelError("INVALID_STYLE", "decimals must be between 0 and 12");
  }
  for (const field of ["bold", "italic", "wrap"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") throw new WorkbookModelError("INVALID_STYLE", `${field} must be boolean`);
  }
  for (const field of ["textColor", "fillColor"] as const) {
    if (value[field] !== undefined && (typeof value[field] !== "string" || !/^#[0-9a-f]{6}$/i.test(value[field] as string))) {
      throw new WorkbookModelError("INVALID_STYLE", `${field} must be a six-digit hex color`);
    }
  }
  if (value.numberFormat !== undefined && !["general", "number", "currency", "percent", "date", "time"].includes(value.numberFormat as string)) {
    throw new WorkbookModelError("INVALID_STYLE", "Unsupported number format");
  }
  if (value.alignment !== undefined && !["left", "center", "right"].includes(value.alignment as string)) {
    throw new WorkbookModelError("INVALID_STYLE", "Unsupported alignment");
  }
}

export function usedRange(sheet: SpreadsheetSheet): string | null {
  const addresses = Object.keys(sheet.cells);
  if (addresses.length === 0) return null;
  let minRow = Infinity;
  let minColumn = Infinity;
  let maxRow = 0;
  let maxColumn = 0;
  for (const address of addresses) {
    const parsed = parseCellAddress(address);
    minRow = Math.min(minRow, parsed.row);
    minColumn = Math.min(minColumn, parsed.column);
    maxRow = Math.max(maxRow, parsed.row);
    maxColumn = Math.max(maxColumn, parsed.column);
  }
  const first = formatCellAddress({ row: minRow, column: minColumn });
  const last = formatCellAddress({ row: maxRow, column: maxColumn });
  return first === last ? first : `${first}:${last}`;
}

export class WorkbookModelError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WorkbookModelError";
  }
}
