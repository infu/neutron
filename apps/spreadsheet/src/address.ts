import { SPREADSHEET_LIMITS } from "./constants.ts";

export type CellAddress = { row: number; column: number };
export type CellRange = { start: CellAddress; end: CellAddress };

export type FormulaCellReference = {
  address: CellAddress;
  columnAbsolute: boolean;
  rowAbsolute: boolean;
  /** Decoded sheet name. Omitted references use the formula cell's sheet. */
  sheet?: string;
  /** Original quoted or unquoted sheet spelling, including neither `!` nor cell. */
  sheetToken?: string;
};

export type FormulaReferenceExpression = {
  start: FormulaCellReference;
  end?: FormulaCellReference;
};

export type StructuralFormulaChange = {
  axis: "row" | "column";
  kind: "insert" | "delete";
  index: number;
  count: number;
  currentSheetName: string;
  targetSheetName: string;
};

const CELL_PATTERN = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]*)$/;

export function columnName(column: number): string {
  if (!Number.isInteger(column) || column < 0 || column >= SPREADSHEET_LIMITS.maxColumns) {
    throw new SpreadsheetAddressError("INVALID_ADDRESS", `Column is outside 1-${SPREADSHEET_LIMITS.maxColumns}`);
  }
  let value = column + 1;
  let name = "";
  while (value > 0) {
    const digit = (value - 1) % 26;
    name = String.fromCharCode(65 + digit) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

export function columnIndex(name: string): number {
  if (!/^[A-Za-z]{1,3}$/.test(name)) {
    throw new SpreadsheetAddressError("INVALID_ADDRESS", `Invalid column '${name}'`);
  }
  let value = 0;
  for (const character of name.toUpperCase()) {
    value = value * 26 + character.charCodeAt(0) - 64;
  }
  const index = value - 1;
  if (index >= SPREADSHEET_LIMITS.maxColumns) {
    throw new SpreadsheetAddressError("INVALID_ADDRESS", `Column '${name}' exceeds the workbook limit`);
  }
  return index;
}

export function parseCellAddress(value: string): CellAddress {
  const match = CELL_PATTERN.exec(value.trim());
  if (!match) throw new SpreadsheetAddressError("INVALID_ADDRESS", `Invalid cell address '${value}'`);
  const row = Number(match[2]) - 1;
  const column = columnIndex(match[1]!);
  if (row >= SPREADSHEET_LIMITS.maxRows) {
    throw new SpreadsheetAddressError("INVALID_ADDRESS", `Row exceeds ${SPREADSHEET_LIMITS.maxRows}`);
  }
  return { row, column };
}

export function formatCellAddress(address: CellAddress): string {
  assertAddress(address);
  return `${columnName(address.column)}${address.row + 1}`;
}

export function parseRange(value: string): CellRange {
  const parts = value.trim().split(":");
  if (parts.length > 2 || !parts[0]) {
    throw new SpreadsheetAddressError("INVALID_RANGE", `Invalid range '${value}'`);
  }
  const first = parseCellAddress(parts[0]);
  const second = parts[1] ? parseCellAddress(parts[1]) : first;
  return normalizeRange({ start: first, end: second });
}

export function formatRange(range: CellRange): string {
  const normalized = normalizeRange(range);
  const start = formatCellAddress(normalized.start);
  const end = formatCellAddress(normalized.end);
  return start === end ? start : `${start}:${end}`;
}

export function normalizeRange(range: CellRange): CellRange {
  assertAddress(range.start);
  assertAddress(range.end);
  return {
    start: {
      row: Math.min(range.start.row, range.end.row),
      column: Math.min(range.start.column, range.end.column),
    },
    end: {
      row: Math.max(range.start.row, range.end.row),
      column: Math.max(range.start.column, range.end.column),
    },
  };
}

export function rangeSize(range: CellRange): { rows: number; columns: number; cells: number } {
  const normalized = normalizeRange(range);
  const rows = normalized.end.row - normalized.start.row + 1;
  const columns = normalized.end.column - normalized.start.column + 1;
  return { rows, columns, cells: rows * columns };
}

export function* iterateRange(range: CellRange): Generator<CellAddress> {
  const normalized = normalizeRange(range);
  for (let row = normalized.start.row; row <= normalized.end.row; row += 1) {
    for (let column = normalized.start.column; column <= normalized.end.column; column += 1) {
      yield { row, column };
    }
  }
}

export function offsetAddress(address: CellAddress, rows: number, columns: number): CellAddress {
  const result = { row: address.row + rows, column: address.column + columns };
  assertAddress(result);
  return result;
}

/** Translate relative A1 references outside double-quoted formula strings. */
export function translateFormula(formula: string, rowDelta: number, columnDelta: number): string {
  return rewriteFormulaReferences(formula, (expression) => {
    const shifted = mapExpression(expression, (reference) => ({
      ...reference,
      address: {
        row: reference.address.row + (reference.rowAbsolute ? 0 : rowDelta),
        column: reference.address.column + (reference.columnAbsolute ? 0 : columnDelta),
      },
    }));
    return expressionInBounds(shifted) ? shifted : "#REF!";
  });
}

/**
 * Rewrites A1 cell/range expressions without touching quoted string literals.
 * The callback returns null to preserve the original spelling, an expression to
 * render it, or `#REF!` when no valid rectangular reference remains.
 */
export function rewriteFormulaReferences(
  formula: string,
  rewrite: (expression: FormulaReferenceExpression) => FormulaReferenceExpression | "#REF!" | null,
): string {
  if (!formula.startsWith("=")) return formula;
  let output = "";
  let index = 0;
  let doubleQuoted = false;
  while (index < formula.length) {
    const character = formula[index]!;
    if (character === '"') {
      output += character;
      if (doubleQuoted && formula[index + 1] === '"') {
        output += '"';
        index += 2;
        continue;
      }
      doubleQuoted = !doubleQuoted;
      index += 1;
      continue;
    }
    if (!doubleQuoted) {
      const parsed = readFormulaExpression(formula, index);
      if (parsed) {
        const replacement = rewrite(parsed.expression);
        output += replacement === null
          ? formula.slice(index, parsed.end)
          : replacement === "#REF!"
            ? replacement
            : formatFormulaExpression(replacement);
        index = parsed.end;
        continue;
      }
    }
    output += character;
    index += 1;
  }
  return output;
}

/** Update references affected by inserting/deleting rows or columns. */
export function translateFormulaStructure(formula: string, change: StructuralFormulaChange): string {
  return rewriteFormulaReferences(formula, (expression) => {
    const rangeSheet = expression.start.sheet ?? expression.end?.sheet ?? change.currentSheetName;
    if (expression.end && expression.start.sheet && expression.end.sheet && !sameSheet(expression.start.sheet, expression.end.sheet)) {
      return null;
    }
    if (!sameSheet(rangeSheet, change.targetSheetName)) return null;
    if (!expression.end) {
      const shifted = shiftReference(expression.start, change);
      return shifted ? { start: shifted } : "#REF!";
    }
    const startValue = change.axis === "row" ? expression.start.address.row : expression.start.address.column;
    const endValue = change.axis === "row" ? expression.end.address.row : expression.end.address.column;
    const interval = shiftStructuralInterval(startValue, endValue, change);
    if (!interval) return "#REF!";
    const start = cloneFormulaReference(expression.start);
    const end = cloneFormulaReference(expression.end);
    if (change.axis === "row") {
      start.address.row = interval[0];
      end.address.row = interval[1];
    } else {
      start.address.column = interval[0];
      end.address.column = interval[1];
    }
    return expressionInBounds({ start, end }) ? { start, end } : "#REF!";
  });
}

/** Keep explicit cross-sheet references valid when a sheet is renamed. */
export function renameFormulaSheetReferences(formula: string, oldName: string, newName: string): string {
  return rewriteFormulaReferences(formula, (expression) => {
    let changed = false;
    const replace = (reference: FormulaCellReference): FormulaCellReference => {
      if (!reference.sheet || !sameSheet(reference.sheet, oldName)) return cloneFormulaReference(reference);
      changed = true;
      return { ...cloneFormulaReference(reference), sheet: newName, sheetToken: formatSheetToken(newName) };
    };
    const rewritten: FormulaReferenceExpression = {
      start: replace(expression.start),
      ...(expression.end ? { end: replace(expression.end) } : {}),
    };
    return changed ? rewritten : null;
  });
}

function readFormulaExpression(source: string, index: number): { expression: FormulaReferenceExpression; end: number } | null {
  if (!isReferenceBoundary(source[index - 1], undefined)) return null;
  const start = readFormulaReference(source, index);
  if (!start) return null;
  let endIndex = start.end;
  let end: FormulaCellReference | undefined;
  const colon = /^\s*:\s*/.exec(source.slice(endIndex));
  if (colon) {
    const candidate = readFormulaReference(source, endIndex + colon[0].length);
    if (candidate) {
      end = candidate.reference;
      endIndex = candidate.end;
    }
  }
  if (!isReferenceBoundary(undefined, source[endIndex])) return null;
  return { expression: { start: start.reference, ...(end ? { end } : {}) }, end: endIndex };
}

function readFormulaReference(source: string, index: number): { reference: FormulaCellReference; end: number } | null {
  const match = /^(?:(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_.]*))!)?(\$?)([A-Za-z]{1,3})(\$?)([1-9][0-9]*)/.exec(source.slice(index));
  if (!match) return null;
  let column: number;
  const row = Number(match[6]) - 1;
  try {
    column = columnIndex(match[4]!);
  } catch {
    return null;
  }
  if (row >= SPREADSHEET_LIMITS.maxRows) return null;
  const sheet = match[1] !== undefined ? match[1].replaceAll("''", "'") : match[2];
  const sheetToken = match[1] !== undefined ? `'${match[1]}'` : match[2];
  return {
    reference: {
      address: { row, column },
      columnAbsolute: match[3] === "$",
      rowAbsolute: match[5] === "$",
      ...(sheet !== undefined ? { sheet, sheetToken } : {}),
    },
    end: index + match[0].length,
  };
}

function formatFormulaExpression(expression: FormulaReferenceExpression): string {
  const format = (reference: FormulaCellReference) => {
    const sheet = reference.sheet === undefined
      ? ""
      : `${reference.sheetToken ?? formatSheetToken(reference.sheet)}!`;
    return `${sheet}${reference.columnAbsolute ? "$" : ""}${columnName(reference.address.column)}${reference.rowAbsolute ? "$" : ""}${reference.address.row + 1}`;
  };
  return expression.end ? `${format(expression.start)}:${format(expression.end)}` : format(expression.start);
}

function formatSheetToken(name: string): string {
  const canRemainBare = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !CELL_PATTERN.test(name);
  return canRemainBare ? name : `'${name.replaceAll("'", "''")}'`;
}

function mapExpression(
  expression: FormulaReferenceExpression,
  map: (reference: FormulaCellReference) => FormulaCellReference,
): FormulaReferenceExpression {
  return {
    start: map(cloneFormulaReference(expression.start)),
    ...(expression.end ? { end: map(cloneFormulaReference(expression.end)) } : {}),
  };
}

function cloneFormulaReference(reference: FormulaCellReference): FormulaCellReference {
  return { ...reference, address: { ...reference.address } };
}

function expressionInBounds(expression: FormulaReferenceExpression): boolean {
  return referenceInBounds(expression.start) && (!expression.end || referenceInBounds(expression.end));
}

function referenceInBounds(reference: FormulaCellReference): boolean {
  return reference.address.row >= 0 && reference.address.row < SPREADSHEET_LIMITS.maxRows &&
    reference.address.column >= 0 && reference.address.column < SPREADSHEET_LIMITS.maxColumns;
}

function shiftReference(reference: FormulaCellReference, change: StructuralFormulaChange): FormulaCellReference | null {
  const next = cloneFormulaReference(reference);
  const value = change.axis === "row" ? next.address.row : next.address.column;
  const shifted = shiftStructuralValue(value, change);
  if (shifted === null) return null;
  if (change.axis === "row") next.address.row = shifted;
  else next.address.column = shifted;
  return referenceInBounds(next) ? next : null;
}

function shiftStructuralValue(value: number, change: StructuralFormulaChange): number | null {
  if (change.kind === "insert") return value >= change.index ? value + change.count : value;
  const last = change.index + change.count - 1;
  if (value < change.index) return value;
  if (value <= last) return null;
  return value - change.count;
}

function shiftStructuralInterval(start: number, end: number, change: StructuralFormulaChange): [number, number] | null {
  const forward = start <= end;
  const low = Math.min(start, end);
  const high = Math.max(start, end);
  let nextLow: number;
  let nextHigh: number;
  if (change.kind === "insert") {
    nextLow = low >= change.index ? low + change.count : low;
    nextHigh = high >= change.index ? high + change.count : high;
  } else {
    const deletedLast = change.index + change.count - 1;
    if (low >= change.index && high <= deletedLast) return null;
    nextLow = low < change.index ? low : change.index;
    nextHigh = high > deletedLast ? high - change.count : change.index - 1;
  }
  return forward ? [nextLow, nextHigh] : [nextHigh, nextLow];
}

function sameSheet(left: string, right: string): boolean {
  return left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US");
}

function isReferenceBoundary(before: string | undefined, after: string | undefined): boolean {
  return (!before || !/[A-Za-z0-9_.]/.test(before)) && (!after || !/[A-Za-z0-9_]/.test(after));
}

function assertAddress(address: CellAddress): void {
  if (
    !Number.isInteger(address.row) ||
    !Number.isInteger(address.column) ||
    address.row < 0 ||
    address.column < 0 ||
    address.row >= SPREADSHEET_LIMITS.maxRows ||
    address.column >= SPREADSHEET_LIMITS.maxColumns
  ) {
    throw new SpreadsheetAddressError("INVALID_ADDRESS", "Cell address is outside workbook limits");
  }
}

export class SpreadsheetAddressError extends Error {
  constructor(readonly code: "INVALID_ADDRESS" | "INVALID_RANGE", message: string) {
    super(message);
    this.name = "SpreadsheetAddressError";
  }
}
