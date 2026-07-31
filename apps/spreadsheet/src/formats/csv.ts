import { formatCellAddress, iterateRange, parseRange, rangeSize } from "../address.ts";
import { SPREADSHEET_LIMITS } from "../constants.ts";
import { FormulaBatch } from "../formula.ts";
import {
  type CellInput,
  type CellRecord,
  type SpreadsheetWorkbook,
  createWorkbook,
  rawInputFromText,
  requireSheet,
  usedRange,
} from "../model.ts";

export type CsvTypingPolicy = "text" | "conservative";
export type CsvInjectionPolicy = "exact" | "safe";

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; }
        else {
          quoted = false;
          closedQuote = true;
        }
      } else field += character;
      continue;
    }
    if (closedQuote && character !== "," && character !== "\r" && character !== "\n") {
      throw new CsvFormatError("INVALID_CSV", "Only a delimiter or line ending may follow a closing quote");
    }
    if (character === '"') {
      if (field !== "") throw new CsvFormatError("INVALID_CSV", "A quoted field must start immediately after a delimiter");
      quoted = true;
      closedQuote = false;
    } else if (character === ",") {
      row.push(field);
      field = "";
      closedQuote = false;
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      closedQuote = false;
    } else field += character;
  }
  if (quoted) throw new CsvFormatError("INVALID_CSV", "Unterminated quoted field");
  if (field !== "" || row.length > 0 || closedQuote || text.length === 0) {
    row.push(field);
    rows.push(row);
  }
  const columns = Math.max(0, ...rows.map((candidate) => candidate.length));
  if (rows.length > SPREADSHEET_LIMITS.maxRows || columns > SPREADSHEET_LIMITS.maxColumns || rows.length * columns > SPREADSHEET_LIMITS.maxCells) {
    throw new CsvFormatError("IMPORT_LIMIT", "CSV exceeds workbook limits");
  }
  return rows;
}

export function decodeCsv(bytes: Uint8Array | ArrayBuffer): string[][] {
  try {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (view.byteLength > SPREADSHEET_LIMITS.maxNativeBytes) {
      throw new CsvFormatError("IMPORT_LIMIT", `CSV exceeds ${SPREADSHEET_LIMITS.maxNativeBytes} bytes`);
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(view);
    return parseCsv(text.startsWith("\ufeff") ? text.slice(1) : text);
  } catch (error) {
    if (error instanceof CsvFormatError) throw error;
    throw new CsvFormatError("INVALID_CSV", "CSV must be valid UTF-8");
  }
}

export function importCsv(
  bytes: Uint8Array | ArrayBuffer,
  options: { sheetName?: string; typing?: CsvTypingPolicy; now?: number } = {},
): SpreadsheetWorkbook {
  const rows = decodeCsv(bytes);
  const workbook = createWorkbook(options.now);
  const sheet = workbook.sheets[0]!;
  sheet.name = options.sheetName?.trim() || "Sheet1";
  rows.forEach((row, rowIndex) => row.forEach((field, columnIndex) => {
    const input: CellInput = options.typing === "conservative" ? conservativeInput(field) : { kind: "text", value: field };
    if (input.kind !== "blank") sheet.cells[formatCellAddress({ row: rowIndex, column: columnIndex })] = { input };
  }));
  return workbook;
}

export function exportCsv(
  workbook: SpreadsheetWorkbook,
  sheetId: string,
  options: { range?: string; injectionPolicy: CsvInjectionPolicy; bom?: boolean } = { injectionPolicy: "exact" },
): { bytes: Uint8Array; transformed: number; formulaCells: number; errorCells: number; range: string } {
  const sheet = requireSheet(workbook, sheetId);
  const rangeValue = options.range ?? usedRange(sheet) ?? "A1";
  const range = parseRange(rangeValue);
  const size = rangeSize(range);
  if (size.cells > SPREADSHEET_LIMITS.maxCells) {
    throw new CsvFormatError("EXPORT_LIMIT", `CSV export cannot exceed ${SPREADSHEET_LIMITS.maxCells} cells`);
  }
  const batch = new FormulaBatch(workbook);
  const lines: string[] = [];
  let currentRow = range.start.row;
  let row: string[] = [];
  let rowBytes = 0;
  let outputBytes = options.bom ? 3 : 0;
  let transformed = 0;
  let formulaCells = 0;
  let errorCells = 0;
  const finishRow = (): void => {
    const line = row.join(",");
    const lineBytes = new TextEncoder().encode(line).byteLength + 2;
    if (outputBytes + lineBytes > SPREADSHEET_LIMITS.maxNativeBytes) {
      throw new CsvFormatError("EXPORT_LIMIT", `CSV export exceeds ${SPREADSHEET_LIMITS.maxNativeBytes} bytes`);
    }
    lines.push(line);
    outputBytes += lineBytes;
    row = [];
    rowBytes = 0;
  };
  for (const address of iterateRange(range)) {
    if (address.row !== currentRow) {
      finishRow();
      currentRow = address.row;
    }
    const key = formatCellAddress(address);
    const record = sheet.cells[key];
    if (record?.input.kind === "formula") formulaCells += 1;
    const computed = batch.evaluateCell(sheet.id, key);
    let value = csvScalar(computed, record, workbook.calculation.dateSystem);
    if (computed.kind === "error") errorCells += 1;
    if (options.injectionPolicy === "safe" && isDangerousCsvText(value, computed.kind === "value" && typeof computed.value === "string")) {
      value = `'${value}`;
      transformed += 1;
    }
    const encoded = quoteCsv(value);
    const fieldBytes = new TextEncoder().encode(encoded).byteLength + (row.length > 0 ? 1 : 0);
    if (outputBytes + rowBytes + fieldBytes + 2 > SPREADSHEET_LIMITS.maxNativeBytes) {
      throw new CsvFormatError("EXPORT_LIMIT", `CSV export exceeds ${SPREADSHEET_LIMITS.maxNativeBytes} bytes`);
    }
    row.push(encoded);
    rowBytes += fieldBytes;
  }
  finishRow();
  const output = `${options.bom ? "\ufeff" : ""}${lines.join("\r\n")}\r\n`;
  const bytes = new TextEncoder().encode(output);
  if (bytes.byteLength !== outputBytes || bytes.byteLength > SPREADSHEET_LIMITS.maxNativeBytes) {
    throw new CsvFormatError("EXPORT_LIMIT", "CSV export size accounting failed");
  }
  return { bytes, transformed, formulaCells, errorCells, range: rangeValue };
}

function conservativeInput(value: string): CellInput {
  if (value === "") return { kind: "text", value: "" };
  if (value.startsWith("=") || value.startsWith("+") || value.startsWith("@") || /^0\d+/.test(value) || /^\d{16,}$/.test(value)) {
    return { kind: "text", value };
  }
  return rawInputFromText(value);
}

function quoteCsv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function csvScalar(
  computed: ReturnType<FormulaBatch["evaluateCell"]>,
  record: CellRecord | undefined,
  dateSystem: 1900 | 1904,
): string {
  if (computed.kind === "error") return computed.code;
  if (computed.kind === "blank") return "";
  if (typeof computed.value === "string") return computed.value;
  if (typeof computed.value === "boolean") return computed.value ? "TRUE" : "FALSE";
  if (record?.style?.numberFormat === "date") return excelSerialText(computed.value, dateSystem, false);
  if (record?.style?.numberFormat === "time") return excelSerialText(computed.value, dateSystem, true);
  return String(computed.value);
}

function excelSerialText(serial: number, dateSystem: 1900 | 1904, timeOnly: boolean): string {
  const wholeDays = Math.floor(serial);
  const fraction = ((serial % 1) + 1) % 1;
  if (timeOnly) {
    const seconds = Math.round(fraction * 86_400) % 86_400;
    const hours = Math.floor(seconds / 3_600);
    const minutes = Math.floor((seconds % 3_600) / 60);
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }
  if (dateSystem === 1900 && wholeDays === 60) return "1900-02-29";
  const epoch = dateSystem === 1900 ? Date.UTC(1899, 11, 31) : Date.UTC(1904, 0, 1);
  const adjustedDays = dateSystem === 1900 && wholeDays > 60 ? wholeDays - 1 : wholeDays;
  return new Date(epoch + adjustedDays * 86_400_000).toISOString().slice(0, 10);
}

function isDangerousCsvText(value: string, isText: boolean): boolean {
  return isText && /^[=+\-@\t\r]/.test(value);
}

export class CsvFormatError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CsvFormatError";
  }
}
