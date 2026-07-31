import { formatCellAddress, parseCellAddress } from "../address.ts";
import { NATIVE_FORMAT, NATIVE_VERSION, SPREADSHEET_LIMITS } from "../constants.ts";
import {
  type SpreadsheetWorkbook,
  assertCellRecord,
  assertCellStyle,
  assertUniqueSheetName,
  cloneWorkbook,
  normalizeSheetFilter,
  normalizeSheetName,
} from "../model.ts";

const encoder = new TextEncoder();

export function encodeNativeWorkbook(workbook: SpreadsheetWorkbook): Uint8Array {
  validateNativeWorkbook(workbook);
  const bytes = encoder.encode(JSON.stringify(workbook));
  if (bytes.byteLength > SPREADSHEET_LIMITS.maxNativeBytes) {
    throw new NativeFormatError("IMPORT_LIMIT", `Native workbook exceeds ${SPREADSHEET_LIMITS.maxNativeBytes} bytes`);
  }
  return bytes;
}

export function decodeNativeWorkbook(bytes: Uint8Array | ArrayBuffer): SpreadsheetWorkbook {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.byteLength > SPREADSHEET_LIMITS.maxNativeBytes) {
    throw new NativeFormatError("IMPORT_LIMIT", `Native workbook exceeds ${SPREADSHEET_LIMITS.maxNativeBytes} bytes`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(view);
  } catch {
    throw new NativeFormatError("INVALID_NATIVE", "Native workbook is not valid UTF-8");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new NativeFormatError("INVALID_NATIVE", "Native workbook is not valid JSON");
  }
  validateNativeWorkbook(value);
  return cloneWorkbook(value);
}

export function validateNativeWorkbook(value: unknown): asserts value is SpreadsheetWorkbook {
  if (!isRecord(value)) throw new NativeFormatError("INVALID_NATIVE", "Workbook root must be an object");
  requireExactKeys(value, ["format", "version", "workbookId", "calculation", "sheets", "styles", "javascriptFunctions", "metadata"]);
  if (value.format !== NATIVE_FORMAT || value.version !== NATIVE_VERSION) {
    throw new NativeFormatError("UNSUPPORTED_FORMAT", "Unsupported native workbook format or version");
  }
  if (typeof value.workbookId !== "string" || !/^[A-Za-z][A-Za-z0-9_.:-]{7,127}$/u.test(value.workbookId)) {
    throw new NativeFormatError("INVALID_NATIVE", "Invalid workbook id");
  }
  if (!isRecord(value.calculation)) throw new NativeFormatError("INVALID_NATIVE", "Missing calculation settings");
  requireExactKeys(value.calculation, ["language", "dateSystem", "timeZone"]);
  if (value.calculation.language !== "enUS" || ![1900, 1904].includes(value.calculation.dateSystem as number) || typeof value.calculation.timeZone !== "string") {
    throw new NativeFormatError("INVALID_NATIVE", "Unsupported calculation settings");
  }
  if (!Array.isArray(value.sheets) || value.sheets.length < 1 || value.sheets.length > SPREADSHEET_LIMITS.maxSheets) {
    throw new NativeFormatError("IMPORT_LIMIT", `Workbook must have 1-${SPREADSHEET_LIMITS.maxSheets} sheets`);
  }
  const ids = new Set<string>();
  let cells = 0;
  let dimensionOverrides = 0;
  for (const sheetValue of value.sheets) {
    if (!isRecord(sheetValue)) throw new NativeFormatError("INVALID_NATIVE", "Sheet must be an object");
    const allowedSheetKeys = new Set(["id", "name", "cells", "columnWidths", "rowHeights", "filter"]);
    if (Object.keys(sheetValue).some((key) => !allowedSheetKeys.has(key))) throw new NativeFormatError("INVALID_NATIVE", "Sheet has unknown fields");
    if (typeof sheetValue.id !== "string" || !/^[A-Za-z][A-Za-z0-9_.:-]{7,127}$/u.test(sheetValue.id) || ids.has(sheetValue.id)) {
      throw new NativeFormatError("INVALID_NATIVE", "Sheet ids must be unique stable identifiers");
    }
    ids.add(sheetValue.id);
    if (typeof sheetValue.name !== "string" || normalizeSheetName(sheetValue.name) !== sheetValue.name) throw new NativeFormatError("INVALID_NATIVE", "Invalid sheet name");
    if (!isRecord(sheetValue.cells)) throw new NativeFormatError("INVALID_NATIVE", "Sheet cells must be sparse address records");
    for (const [address, record] of Object.entries(sheetValue.cells)) {
      if (formatCellAddress(parseCellAddress(address)) !== address) throw new NativeFormatError("INVALID_NATIVE", `Cell address '${address}' is not canonical`);
      assertCellRecord(record);
      cells += 1;
      if (cells > SPREADSHEET_LIMITS.maxCells) throw new NativeFormatError("IMPORT_LIMIT", "Workbook has too many stored cells");
    }
    validateNumericMap(sheetValue.columnWidths, 0, SPREADSHEET_LIMITS.maxColumns - 1, 24, 600, "column width");
    validateNumericMap(sheetValue.rowHeights, 0, SPREADSHEET_LIMITS.maxRows - 1, 18, 300, "row height");
    dimensionOverrides += Object.keys(sheetValue.columnWidths ?? {}).length + Object.keys(sheetValue.rowHeights ?? {}).length;
    if (dimensionOverrides > SPREADSHEET_LIMITS.maxDimensionOverrides) {
      throw new NativeFormatError("IMPORT_LIMIT", `Workbook exceeds ${SPREADSHEET_LIMITS.maxDimensionOverrides} custom row/column sizes`);
    }
    const filterValue = sheetValue.filter;
    if (filterValue !== undefined) {
      try {
        const normalized = normalizeSheetFilter(filterValue);
        if (!isRecord(filterValue) || normalized.range !== filterValue.range) {
          throw new Error("Filter range is not canonical");
        }
      } catch {
        throw new NativeFormatError("INVALID_NATIVE", "Invalid filter");
      }
    }
  }
  const workbook = value as unknown as SpreadsheetWorkbook;
  for (const sheet of workbook.sheets) assertUniqueSheetName(workbook, sheet.name, sheet.id);
  if (!Array.isArray(value.styles) || value.styles.length > SPREADSHEET_LIMITS.maxStyles) {
    throw new NativeFormatError("IMPORT_LIMIT", `Workbook exceeds ${SPREADSHEET_LIMITS.maxStyles} shared styles`);
  }
  for (const style of value.styles) {
    // Reserved for style-id migration; validate now so files cannot smuggle unknown state.
    assertCellStyle(style);
  }
  if (!Array.isArray(value.javascriptFunctions) || value.javascriptFunctions.length !== 0) {
    throw new NativeFormatError("UNSUPPORTED_FEATURES", "JavaScript functions are gated and unavailable in this build");
  }
  if (!isRecord(value.metadata) || !Number.isFinite(value.metadata.createdAt) || !Number.isFinite(value.metadata.updatedAt)) {
    throw new NativeFormatError("INVALID_NATIVE", "Invalid workbook metadata");
  }
  requireExactKeys(value.metadata, ["createdAt", "updatedAt"]);
}

function validateNumericMap(value: unknown, minKey: number, maxKey: number, min: number, max: number, label: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new NativeFormatError("INVALID_NATIVE", `Invalid ${label} map`);
  for (const [key, size] of Object.entries(value)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < minKey || index > maxKey || typeof size !== "number" || !Number.isFinite(size) || size < min || size > max) {
      throw new NativeFormatError("INVALID_NATIVE", `Invalid ${label}`);
    }
  }
}

function requireExactKeys(value: Record<string, unknown>, keys: string[]): void {
  const expected = new Set(keys);
  if (keys.some((key) => !(key in value)) || Object.keys(value).some((key) => !expected.has(key))) {
    throw new NativeFormatError("INVALID_NATIVE", "Native object fields do not match version 1");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export class NativeFormatError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "NativeFormatError";
  }
}
