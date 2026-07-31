import {
  formatCellAddress,
  formatRange,
  iterateRange,
  normalizeRange,
  offsetAddress,
  parseCellAddress,
  parseRange,
  rangeSize,
  renameFormulaSheetReferences,
  rewriteFormulaReferences,
  translateFormula,
  translateFormulaStructure,
  type CellAddress,
  type CellRange,
  type FormulaCellReference,
  type FormulaReferenceExpression,
} from "./address.ts";
import { SPREADSHEET_LIMITS } from "./constants.ts";
import { FormulaBatch, formatComputed } from "./formula.ts";
import {
  BLANK,
  type CellInput,
  type CellRecord,
  type CellStyle,
  type SheetFilter,
  type SpreadsheetSheet,
  type SpreadsheetWorkbook,
  assertCellInput,
  assertCellStyle,
  assertUniqueSheetName,
  cloneCellRecord,
  cloneWorkbook,
  createId,
  createSheet,
  createWorkbook,
  normalizeSheetFilter,
  normalizeSheetName,
  rawInputToText,
  requireSheet,
  usedRange,
} from "./model.ts";

const UTF8_ENCODER = new TextEncoder();

export type CommandActor = "human" | "agent" | "system";
export type FillMode = "auto" | "copy" | "linear" | "repeat";
export type CopyMode = "all" | "values";

export type WorkbookOperation =
  | { type: "set_cells"; sheetId: string; start: string; values: CellInput[][] }
  | { type: "clear"; sheetId: string; range: string; contents?: boolean; styles?: boolean }
  | { type: "fill"; sheetId: string; sourceRange: string; targetRange: string; mode?: FillMode }
  | { type: "copy_range"; sheetId: string; sourceRange: string; destination: string; mode?: CopyMode }
  | { type: "move_range"; sheetId: string; sourceRange: string; destination: string }
  | { type: "insert_rows"; sheetId: string; startRow: number; count: number }
  | { type: "delete_rows"; sheetId: string; startRow: number; count: number }
  | { type: "insert_columns"; sheetId: string; startColumn: number; count: number }
  | { type: "delete_columns"; sheetId: string; startColumn: number; count: number }
  | { type: "apply_style"; sheetId: string; range: string; style: CellStyle }
  | { type: "add_sheet"; name: string }
  | { type: "rename_sheet"; sheetId: string; name: string }
  | { type: "delete_sheet"; sheetId: string }
  | { type: "resize_column"; sheetId: string; column: number; width: number | null }
  | { type: "resize_row"; sheetId: string; row: number; height: number | null }
  | { type: "sort_range"; sheetId: string; range: string; keyColumn: number; direction: "ascending" | "descending"; hasHeader: boolean }
  | { type: "set_filter"; sheetId: string; filter: SheetFilter }
  | { type: "clear_filter"; sheetId: string };

export type ApplyRequest = {
  expectedRevision: number;
  commandId: string;
  operations: WorkbookOperation[];
  actor?: CommandActor;
  dryRun?: boolean;
};

export type ApplyResult = {
  commandId: string;
  revision: number;
  previousRevision: number;
  historyId: string | null;
  touchedCells: number;
  operationCount: number;
  dryRun: boolean;
  noChange: boolean;
  resolved: Array<{
    type: WorkbookOperation["type"];
    range?: string;
    sourceRange?: string;
    destinationRange?: string;
    strategy?: FillMode;
    mode?: CopyMode;
  }>;
};

export type HistoryResult = {
  commandId: string;
  revision: number;
  previousRevision: number;
  historyId: string;
  action: "undo" | "redo";
};

export type ReadCellResult = {
  address: string;
  raw: CellInput;
  computed: ReturnType<FormulaBatch["evaluateCell"]>;
  display: string;
  style?: CellStyle;
};

export type ReadRangeResult = {
  workbookId: string;
  sheetId: string;
  sheetName: string;
  range: string;
  revision: number;
  cells: ReadCellResult[];
  /** One-based spreadsheet row numbers represented by this page and hidden by the active filter. */
  hiddenRows: number[];
  nextCursor: string | null;
};

export type FindOptions = {
  sheetId?: string;
  formulas?: boolean;
  caseSensitive?: boolean;
  limit?: number;
  cursor?: string;
};

export type FindResult = {
  workbookId: string;
  revision: number;
  matches: Array<{ sheetId: string; sheetName: string; address: string; raw: string; display: string }>;
  /** Retained for compatibility; always equivalent to nextCursor !== null. */
  truncated: boolean;
  nextCursor: string | null;
};

type FindCursorState = {
  workbookId: string;
  revision: number;
  query: string;
  sheetId: string | null;
  formulas: boolean;
  caseSensitive: boolean;
  offset: number;
};

type HistoryEntry = {
  id: string;
  commandId: string;
  actor: CommandActor;
  before: SpreadsheetWorkbook;
  after: SpreadsheetWorkbook;
  byteLength: number;
};

export class WorkbookEngine {
  private revision = 0;
  private workbook: SpreadsheetWorkbook;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private historyBytes = 0;
  private completed = new Map<string, ApplyResult | HistoryResult>();
  private completedFingerprints = new Map<string, string>();
  private findCursors = new Map<string, FindCursorState>();

  constructor(workbook: SpreadsheetWorkbook = createWorkbook()) {
    this.workbook = cloneWorkbook(workbook);
  }

  getRevision(): number { return this.revision; }

  snapshot(): { workbook: SpreadsheetWorkbook; revision: number } {
    return { workbook: cloneWorkbook(this.workbook), revision: this.revision };
  }

  replace(workbook: SpreadsheetWorkbook, recoveredRevision?: number): void {
    if (recoveredRevision !== undefined && (!Number.isSafeInteger(recoveredRevision) || recoveredRevision < 0)) {
      throw new WorkbookEngineError("INVALID_REVISION", "Revision must be a non-negative safe integer");
    }
    this.workbook = cloneWorkbook(workbook);
    this.revision = Math.max(this.revision + 1, recoveredRevision ?? 0);
    this.undoStack = [];
    this.redoStack = [];
    this.historyBytes = 0;
    this.completed.clear();
    this.completedFingerprints.clear();
  }

  status(): {
    revision: number;
    workbookId: string;
    sheets: Array<{
      id: string;
      name: string;
      usedRange: string | null;
      cellCount: number;
      filter: SheetFilter | null;
      hiddenRowCount: number;
      columnWidths: Record<string, number>;
      rowHeights: Record<string, number>;
    }>;
    canUndo: boolean;
    canRedo: boolean;
    undoHistoryId: string | null;
    redoHistoryId: string | null;
    history: { entries: number; bytes: number; maxEntries: number; maxBytes: number };
  } {
    return {
      revision: this.revision,
      workbookId: this.workbook.workbookId,
      sheets: this.workbook.sheets.map((sheet) => ({
        id: sheet.id,
        name: sheet.name,
        usedRange: usedRange(sheet),
        cellCount: Object.keys(sheet.cells).length,
        filter: sheet.filter ? structuredClone(sheet.filter) : null,
        hiddenRowCount: countFilterHiddenRows(this.workbook, sheet),
        columnWidths: { ...sheet.columnWidths },
        rowHeights: { ...sheet.rowHeights },
      })),
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      undoHistoryId: this.undoStack.at(-1)?.id ?? null,
      redoHistoryId: this.redoStack.at(-1)?.id ?? null,
      history: {
        entries: this.undoStack.length + this.redoStack.length,
        bytes: this.historyBytes,
        maxEntries: SPREADSHEET_LIMITS.maxUndoEntries,
        maxBytes: SPREADSHEET_LIMITS.maxUndoBytes,
      },
    };
  }

  apply(request: ApplyRequest): ApplyResult {
    if (!request.commandId || request.commandId.length > 128) throw new WorkbookEngineError("INVALID_COMMAND", "commandId is required and at most 128 characters");
    const fingerprint = JSON.stringify({
      command: "apply",
      commandId: request.commandId,
      expectedRevision: request.expectedRevision,
      operations: request.operations,
      actor: request.actor ?? "human",
      dryRun: request.dryRun === true,
    });
    const prior = this.completed.get(request.commandId);
    if (prior) {
      if (!("operationCount" in prior) || this.completedFingerprints.get(request.commandId) !== fingerprint) {
        throw new WorkbookEngineError("COMMAND_ID_REUSED", "Command id was already used for a different command");
      }
      return structuredClone(prior);
    }
    validateCommandEnvelope(request, this.revision);

    const candidate = cloneWorkbook(this.workbook);
    let touchedCells = 0;
    const resolved: ApplyResult["resolved"] = [];
    for (const operation of request.operations) {
      const result = applyOperation(candidate, operation);
      touchedCells += result.touchedCells;
      if (touchedCells > SPREADSHEET_LIMITS.maxTouchedCells) {
        throw new WorkbookEngineError("LIMIT", `A command cannot touch more than ${SPREADSHEET_LIMITS.maxTouchedCells} cells`);
      }
      resolved.push({ type: operation.type, ...result.resolved });
    }
    assertWorkbookResourceLimits(candidate);
    const previousRevision = this.revision;
    const noChange = workbooksEqual(candidate, this.workbook);
    const result: ApplyResult = {
      commandId: request.commandId,
      revision: request.dryRun || noChange ? this.revision : this.revision + 1,
      previousRevision,
      historyId: request.dryRun || noChange ? null : historyId(request.commandId, this.revision + 1),
      touchedCells,
      operationCount: request.operations.length,
      dryRun: request.dryRun === true,
      noChange,
      resolved,
    };
    if (noChange) {
      if (request.dryRun) return result;
      this.remember(request.commandId, result, fingerprint);
      return structuredClone(result);
    }

    candidate.metadata.updatedAt = Date.now();
    const historyPayload: Omit<HistoryEntry, "byteLength"> = {
      id: historyId(request.commandId, this.revision + 1),
      commandId: request.commandId,
      actor: request.actor ?? "human",
      // Applied workbooks are immutable snapshots: every later command starts
      // from a fresh candidate clone and history restoration also clones its
      // target. Retaining these two owned snapshots avoids two redundant full
      // workbook clones on every edit without exposing mutable state.
      before: this.workbook,
      after: candidate,
    };
    const entry = createHistoryEntry(historyPayload);
    if (entry.byteLength > SPREADSHEET_LIMITS.maxUndoBytes) {
      throw new WorkbookEngineError(
        "UNDO_LIMIT",
        "This edit is too large to retain its required undo entry",
        { entryBytes: entry.byteLength, maxUndoBytes: SPREADSHEET_LIMITS.maxUndoBytes },
      );
    }
    if (request.dryRun) return result;
    const retainedUndo = retainBoundedHistory([...this.undoStack, entry]);
    this.workbook = candidate;
    this.revision += 1;
    this.undoStack = retainedUndo.entries;
    this.redoStack = [];
    this.historyBytes = retainedUndo.bytes;
    this.remember(request.commandId, result, fingerprint);
    return structuredClone(result);
  }

  undo(expectedRevision: number, commandId: string, expectedHistoryId?: string): HistoryResult {
    return this.historyAction("undo", expectedRevision, commandId, expectedHistoryId);
  }

  redo(expectedRevision: number, commandId: string, expectedHistoryId?: string): HistoryResult {
    return this.historyAction("redo", expectedRevision, commandId, expectedHistoryId);
  }

  readRange(
    sheetId: string,
    rangeValue: string,
    options: { cursor?: string; limit?: number; maxBytes?: number; includeBlanks?: boolean } = {},
  ): ReadRangeResult {
    const sheet = requireSheet(this.workbook, sheetId);
    const range = parseRange(rangeValue);
    const size = rangeSize(range);
    const normalizedRange = formatRange(range);
    const offset = decodeCursor(options.cursor, this.workbook.workbookId, this.revision, sheet.id, normalizedRange);
    const limit = Math.min(options.limit ?? SPREADSHEET_LIMITS.maxReadCells, SPREADSHEET_LIMITS.maxReadCells);
    const maxBytes = Math.min(options.maxBytes ?? SPREADSHEET_LIMITS.maxReadBytes, SPREADSHEET_LIMITS.maxReadBytes);
    const includeBlanks = options.includeBlanks !== false;
    if (offset > size.cells) throw new WorkbookEngineError("INVALID_CURSOR", "Read cursor is outside the range");
    const batch = new FormulaBatch(this.workbook);
    const cells: ReadCellResult[] = [];
    const hiddenRows: number[] = [];
    const includedHiddenRows = new Set<number>();
    const rowVisibility = new Map<number, boolean>();
    let nextOffset: number | null = null;
    let scannedCells = 0;
    let cellsPayloadBytes = 0;
    let hiddenRowsPayloadBytes = 0;
    const columns = size.columns;
    // `cells` and `hiddenRows` are the only growing parts of the response.
    // Account for each serialized item once instead of stringifying the full,
    // ever-growing page for every candidate cell (quadratic work at 1,000
    // viewport cells). `nextCursor` is adjusted exactly below per candidate.
    const emptyPageBytes = encodedByteLength({
      workbookId: this.workbook.workbookId,
      sheetId: sheet.id,
      sheetName: sheet.name,
      range: normalizedRange,
      revision: this.revision,
      cells: [],
      hiddenRows: [],
      nextCursor: null,
    });
    if (emptyPageBytes > maxBytes) {
      throw new WorkbookEngineError("RESULT_LIMIT", "Workbook range metadata cannot fit in a bounded workbook_read page", { maxBytes });
    }
    for (let index = offset; index < size.cells; index += 1) {
      // In sparse mode, limit the number of range positions scanned rather
      // than only returned records. This keeps huge empty reads bounded while
      // cursors still advance over the entire requested range.
      if (scannedCells >= limit) { nextOffset = index; break; }
      const address = {
        row: range.start.row + Math.floor(index / columns),
        column: range.start.column + index % columns,
      };
      const key = formatCellAddress(address);
      const record = sheet.cells[key];
      const includeCell = includeBlanks || record !== undefined;
      const cell: ReadCellResult | null = includeCell
        ? {
            address: key,
            raw: record?.input ? structuredClone(record.input) : BLANK,
            computed: batch.evaluateCell(sheet.id, key),
            display: batch.displayCell(sheet.id, key),
            ...(record?.style ? { style: { ...record.style } } : {}),
          }
        : null;
      let rowHidden = rowVisibility.get(address.row);
      if (rowHidden === undefined) {
        rowHidden = isFilterRowHidden(this.workbook, sheet, address.row, batch);
        rowVisibility.set(address.row, rowHidden);
      }
      const spreadsheetRow = address.row + 1;
      const addHiddenRow = rowHidden && !includedHiddenRows.has(spreadsheetRow);
      const cursor = index + 1 < size.cells
        ? encodeCursor(this.workbook.workbookId, this.revision, sheet.id, normalizedRange, index + 1)
        : null;
      const candidateCellsPayloadBytes = cell
        ? cellsPayloadBytes + (cells.length > 0 ? 1 : 0) + encodedByteLength(cell)
        : cellsPayloadBytes;
      const candidateHiddenRowsPayloadBytes = addHiddenRow
        ? hiddenRowsPayloadBytes + (hiddenRows.length > 0 ? 1 : 0) + String(spreadsheetRow).length
        : hiddenRowsPayloadBytes;
      const cursorBytesDelta = cursor === null ? 0 : encodedByteLength(cursor) - 4;
      if (emptyPageBytes + candidateCellsPayloadBytes + candidateHiddenRowsPayloadBytes + cursorBytesDelta > maxBytes) {
        if (cells.length === 0 && hiddenRows.length === 0) {
          throw new WorkbookEngineError("RESULT_LIMIT", `Cell ${key} cannot fit in a bounded workbook_read page`, { address: key, maxBytes });
        }
        nextOffset = index;
        break;
      }
      scannedCells += 1;
      if (cell) {
        cells.push(cell);
        cellsPayloadBytes = candidateCellsPayloadBytes;
      }
      if (addHiddenRow) {
        hiddenRows.push(spreadsheetRow);
        includedHiddenRows.add(spreadsheetRow);
        hiddenRowsPayloadBytes = candidateHiddenRowsPayloadBytes;
      }
    }
    return {
      workbookId: this.workbook.workbookId,
      sheetId: sheet.id,
      sheetName: sheet.name,
      range: normalizedRange,
      revision: this.revision,
      cells,
      hiddenRows,
      nextCursor: nextOffset === null
        ? null
        : encodeCursor(this.workbook.workbookId, this.revision, sheet.id, normalizedRange, nextOffset),
    };
  }

  find(query: string, options: FindOptions = {}): FindResult {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const sheetId = options.sheetId ?? null;
    const formulas = options.formulas === true;
    const caseSensitive = options.caseSensitive === true;
    const needle = caseSensitive ? query : query.toLocaleLowerCase("en-US");
    const sheets = sheetId === null ? this.workbook.sheets : [requireSheet(this.workbook, sheetId)];
    const binding: Omit<FindCursorState, "offset"> = {
      workbookId: this.workbook.workbookId,
      revision: this.revision,
      query,
      sheetId,
      formulas,
      caseSensitive,
    };
    const offset = this.resolveFindCursor(options.cursor, binding);
    const orderedSheets = sheets.map((sheet) => ({ sheet, addresses: Object.keys(sheet.cells).sort(compareAddresses) }));
    const populatedCellCount = orderedSheets.reduce((sum, entry) => sum + entry.addresses.length, 0);
    if (options.cursor && offset >= populatedCellCount) {
      throw new WorkbookEngineError("INVALID_CURSOR", "Find cursor is outside the populated-cell sequence");
    }
    const batch = new FormulaBatch(this.workbook);
    const matches: FindResult["matches"] = [];
    let sequenceIndex = 0;
    let nextOffset: number | null = null;
    outer: for (const { sheet, addresses } of orderedSheets) {
      for (const address of addresses) {
        const currentOffset = sequenceIndex;
        sequenceIndex += 1;
        if (currentOffset < offset) continue;
        const record = sheet.cells[address]!;
        const raw = rawInputToText(record.input);
        const display = batch.displayCell(sheet.id, address);
        const haystack = formulas ? raw : display;
        const comparable = caseSensitive ? haystack : haystack.toLocaleLowerCase("en-US");
        if (comparable.includes(needle)) {
          if (matches.length >= limit) { nextOffset = currentOffset; break outer; }
          const match = { sheetId: sheet.id, sheetName: sheet.name, address, raw, display };
          const hasRemainingCells = currentOffset + 1 < populatedCellCount;
          const candidate = {
            workbookId: this.workbook.workbookId,
            revision: this.revision,
            matches: [...matches, match],
            truncated: hasRemainingCells,
            nextCursor: hasRemainingCells ? FIND_CURSOR_PLACEHOLDER : null,
          };
          if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength > SPREADSHEET_LIMITS.maxReadBytes) {
            if (matches.length === 0) {
              throw new WorkbookEngineError("RESULT_LIMIT", `Match ${sheet.name}!${address} cannot fit in a bounded workbook_find response`, {
                sheetId: sheet.id,
                address,
                maxBytes: SPREADSHEET_LIMITS.maxReadBytes,
              });
            }
            nextOffset = currentOffset;
            break outer;
          }
          matches.push(match);
        }
      }
    }
    const nextCursor = nextOffset === null ? null : this.issueFindCursor(binding, nextOffset);
    return { workbookId: this.workbook.workbookId, revision: this.revision, matches, truncated: nextCursor !== null, nextCursor };
  }

  private resolveFindCursor(cursor: string | undefined, binding: Omit<FindCursorState, "offset">): number {
    if (!cursor) return 0;
    const state = this.findCursors.get(cursor);
    if (!state) throw new WorkbookEngineError("INVALID_CURSOR", "Find cursor is malformed, expired, or tampered");
    if (
      state.workbookId !== binding.workbookId ||
      state.revision !== binding.revision ||
      state.query !== binding.query ||
      state.sheetId !== binding.sheetId ||
      state.formulas !== binding.formulas ||
      state.caseSensitive !== binding.caseSensitive
    ) {
      throw new WorkbookEngineError("INVALID_CURSOR", "Find cursor does not match this revision and query");
    }
    return state.offset;
  }

  private issueFindCursor(binding: Omit<FindCursorState, "offset">, offset: number): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const cursor = createId("find_cursor");
      if (this.findCursors.has(cursor)) continue;
      while (this.findCursors.size >= MAX_FIND_CURSORS) {
        const oldest = this.findCursors.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.findCursors.delete(oldest);
      }
      this.findCursors.set(cursor, { ...binding, offset });
      return cursor;
    }
    throw new WorkbookEngineError("CURSOR_UNAVAILABLE", "Could not allocate a workbook_find cursor");
  }

  private historyAction(action: "undo" | "redo", expectedRevision: number, commandId: string, expectedHistoryId?: string): HistoryResult {
    if (!commandId) throw new WorkbookEngineError("INVALID_COMMAND", "commandId is required");
    const fingerprint = JSON.stringify({
      command: "history",
      commandId,
      action,
      expectedRevision,
      expectedHistoryId: expectedHistoryId ?? null,
    });
    const prior = this.completed.get(commandId);
    if (prior) {
      if (!("action" in prior) || prior.action !== action || this.completedFingerprints.get(commandId) !== fingerprint) {
        throw new WorkbookEngineError("COMMAND_ID_REUSED", "Command id was already used differently");
      }
      return structuredClone(prior);
    }
    if (expectedRevision !== this.revision) throw revisionConflict(expectedRevision, this.revision);
    const source = action === "undo" ? this.undoStack : this.redoStack;
    const target = action === "undo" ? this.redoStack : this.undoStack;
    const entry = source.at(-1);
    if (!entry) throw new WorkbookEngineError("NO_HISTORY", `Nothing to ${action}`);
    if (expectedHistoryId && expectedHistoryId !== entry.id) {
      throw new WorkbookEngineError("HISTORY_CONFLICT", `The top ${action} entry changed`, { actualHistoryId: entry.id });
    }
    source.pop();
    target.push(entry);
    this.workbook = cloneWorkbook(action === "undo" ? entry.before : entry.after);
    this.workbook.metadata.updatedAt = Date.now();
    const previousRevision = this.revision;
    this.revision += 1;
    const result: HistoryResult = { commandId, revision: this.revision, previousRevision, historyId: entry.id, action };
    this.remember(commandId, result, fingerprint);
    return structuredClone(result);
  }

  private remember(commandId: string, result: ApplyResult | HistoryResult, fingerprint: string): void {
    this.completed.set(commandId, structuredClone(result));
    this.completedFingerprints.set(commandId, fingerprint);
    while (this.completed.size > SPREADSHEET_LIMITS.maxIdempotencyEntries) {
      const oldest = this.completed.keys().next().value!;
      this.completed.delete(oldest);
      this.completedFingerprints.delete(oldest);
    }
  }
}

function retainBoundedHistory(entries: HistoryEntry[]): { entries: HistoryEntry[]; bytes: number } {
  const retained = [...entries];
  let bytes = retained.reduce((total, entry) => total + entry.byteLength, 0);
  while (
    retained.length > SPREADSHEET_LIMITS.maxUndoEntries ||
    bytes > SPREADSHEET_LIMITS.maxUndoBytes
  ) {
    const evicted = retained.shift();
    if (!evicted) break;
    bytes -= evicted.byteLength;
  }
  return { entries: retained, bytes };
}

function createHistoryEntry(payload: Omit<HistoryEntry, "byteLength">): HistoryEntry {
  // Only the decimal digit count of `byteLength` can change after measuring
  // the zero-valued entry. Solve that tiny fixed point arithmetically so large
  // before/after snapshots are serialized once rather than two or three times.
  const withoutLengthDigits = encodedByteLength({ ...payload, byteLength: 0 }) - 1;
  let byteLength = withoutLengthDigits + 1;
  while (true) {
    const next = withoutLengthDigits + String(byteLength).length;
    if (next === byteLength) return { ...payload, byteLength };
    byteLength = next;
  }
}

function encodedByteLength(value: unknown): number {
  return UTF8_ENCODER.encode(JSON.stringify(value)).byteLength;
}

function applyOperation(workbook: SpreadsheetWorkbook, operation: WorkbookOperation): {
  touchedCells: number;
  resolved?: {
    range?: string;
    sourceRange?: string;
    destinationRange?: string;
    strategy?: FillMode;
    mode?: CopyMode;
  };
} {
  switch (operation.type) {
    case "set_cells": return setCells(workbook, operation);
    case "clear": return clearCells(workbook, operation);
    case "fill": return fillCells(workbook, operation);
    case "copy_range": return copyRange(workbook, operation);
    case "move_range": return moveRange(workbook, operation);
    case "insert_rows": return changeStructure(workbook, operation, "row", "insert");
    case "delete_rows": return changeStructure(workbook, operation, "row", "delete");
    case "insert_columns": return changeStructure(workbook, operation, "column", "insert");
    case "delete_columns": return changeStructure(workbook, operation, "column", "delete");
    case "apply_style": return applyStyle(workbook, operation);
    case "add_sheet": {
      if (workbook.sheets.length >= SPREADSHEET_LIMITS.maxSheets) throw new WorkbookEngineError("LIMIT", "Workbook has the maximum number of sheets");
      assertUniqueSheetName(workbook, operation.name);
      workbook.sheets.push(createSheet(operation.name));
      return { touchedCells: 0 };
    }
    case "rename_sheet": {
      const sheet = requireSheet(workbook, operation.sheetId);
      assertUniqueSheetName(workbook, operation.name, sheet.id);
      const oldName = sheet.name;
      const newName = normalizeSheetName(operation.name);
      sheet.name = newName;
      return { touchedCells: rewriteRenamedSheetReferences(workbook, oldName, newName) };
    }
    case "delete_sheet": {
      if (workbook.sheets.length === 1) throw new WorkbookEngineError("LAST_SHEET", "The last sheet cannot be deleted");
      const index = workbook.sheets.findIndex((sheet) => sheet.id === operation.sheetId);
      if (index < 0) throw new WorkbookEngineError("SHEET_NOT_FOUND", "Sheet does not exist");
      const deletedSheet = workbook.sheets[index]!;
      const touchedCells = invalidateDeletedSheetReferences(
        workbook,
        deletedSheet.id,
        deletedSheet.name,
        Object.keys(deletedSheet.cells).length,
      );
      workbook.sheets.splice(index, 1);
      return { touchedCells };
    }
    case "resize_column": {
      const sheet = requireSheet(workbook, operation.sheetId);
      if (!Number.isInteger(operation.column) || operation.column < 0 || operation.column >= SPREADSHEET_LIMITS.maxColumns) throw new WorkbookEngineError("INVALID_COLUMN", "Invalid column");
      if (operation.width !== null && (!Number.isFinite(operation.width) || operation.width < 24 || operation.width > 600)) throw new WorkbookEngineError("INVALID_SIZE", "Column width must be 24-600 pixels");
      sheet.columnWidths ??= {};
      if (operation.width === null) delete sheet.columnWidths[String(operation.column)];
      else sheet.columnWidths[String(operation.column)] = operation.width;
      return { touchedCells: 0 };
    }
    case "resize_row": {
      const sheet = requireSheet(workbook, operation.sheetId);
      if (!Number.isInteger(operation.row) || operation.row < 0 || operation.row >= SPREADSHEET_LIMITS.maxRows) throw new WorkbookEngineError("INVALID_ROW", "Invalid row");
      if (operation.height !== null && (!Number.isFinite(operation.height) || operation.height < 18 || operation.height > 300)) throw new WorkbookEngineError("INVALID_SIZE", "Row height must be 18-300 pixels");
      sheet.rowHeights ??= {};
      if (operation.height === null) delete sheet.rowHeights[String(operation.row)];
      else sheet.rowHeights[String(operation.row)] = operation.height;
      return { touchedCells: 0 };
    }
    case "sort_range": return sortRange(workbook, operation);
    case "set_filter": {
      const sheet = requireSheet(workbook, operation.sheetId);
      sheet.filter = normalizeSheetFilter(operation.filter);
      return { touchedCells: 0, resolved: { range: sheet.filter.range } };
    }
    case "clear_filter": {
      delete requireSheet(workbook, operation.sheetId).filter;
      return { touchedCells: 0 };
    }
  }
}

function setCells(workbook: SpreadsheetWorkbook, operation: Extract<WorkbookOperation, { type: "set_cells" }>) {
  const sheet = requireSheet(workbook, operation.sheetId);
  if (!Array.isArray(operation.values) || operation.values.length === 0 || operation.values.some((row) => !Array.isArray(row) || row.length === 0)) {
    throw new WorkbookEngineError("INVALID_MATRIX", "values must be a non-empty rectangular matrix");
  }
  const columns = operation.values[0]!.length;
  if (operation.values.some((row) => row.length !== columns)) throw new WorkbookEngineError("INVALID_MATRIX", "values matrix must be rectangular");
  const start = parseCellAddress(operation.start);
  const end = offsetAddress(start, operation.values.length - 1, columns - 1);
  const range = { start, end };
  assertAtomicRange(range, "set cells");
  assertFilterSafe(workbook, sheet, [range], "Set cells");
  for (let row = 0; row < operation.values.length; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const input = operation.values[row]![column]!;
      assertCellInput(input);
      const address = formatCellAddress(offsetAddress(start, row, column));
      const existing = sheet.cells[address];
      if (input.kind === "blank" && !existing?.style) delete sheet.cells[address];
      else sheet.cells[address] = { input: structuredClone(input), ...(existing?.style ? { style: { ...existing.style } } : {}) };
    }
  }
  return { touchedCells: rangeSize(range).cells, resolved: { range: formatRange(range) } };
}

function clearCells(workbook: SpreadsheetWorkbook, operation: Extract<WorkbookOperation, { type: "clear" }>) {
  const sheet = requireSheet(workbook, operation.sheetId);
  const range = parseRange(operation.range);
  assertAtomicRange(range, "clear");
  assertFilterSafe(workbook, sheet, [range], "Clear");
  const clearContents = operation.contents !== false;
  const clearStyles = operation.styles === true;
  for (const address of iterateRange(range)) {
    const key = formatCellAddress(address);
    const existing = sheet.cells[key];
    if (!existing) continue;
    const input = clearContents ? BLANK : existing.input;
    const style = clearStyles ? undefined : existing.style;
    if (input.kind === "blank" && !style) delete sheet.cells[key];
    else sheet.cells[key] = { input: structuredClone(input), ...(style ? { style: { ...style } } : {}) };
  }
  return { touchedCells: rangeSize(range).cells, resolved: { range: formatRange(range) } };
}

function fillCells(workbook: SpreadsheetWorkbook, operation: Extract<WorkbookOperation, { type: "fill" }>) {
  const sheet = requireSheet(workbook, operation.sheetId);
  const source = parseRange(operation.sourceRange);
  const target = parseRange(operation.targetRange);
  const sourceSize = rangeSize(source);
  const targetSize = rangeSize(target);
  assertAtomicRange(source, "fill source");
  assertAtomicRange(target, "fill target");
  assertFilterSafe(workbook, sheet, [source, target], "Fill");
  if (sourceSize.rows > 1 && sourceSize.columns > 1) throw new WorkbookEngineError("INVALID_FILL", "Fill seed must be one row or one column");
  if (
    (sourceSize.rows > 1 && targetSize.rows === 1 && targetSize.columns > 1) ||
    (sourceSize.columns > 1 && targetSize.columns === 1 && targetSize.rows > 1)
  ) {
    throw new WorkbookEngineError("INVALID_FILL", "Fill seed and one-dimensional target must use the same axis");
  }
  const verticalBlock = sourceSize.rows === 1 && targetSize.rows > 1 && sourceSize.columns === targetSize.columns;
  const horizontalBlock = sourceSize.columns === 1 && targetSize.columns > 1 && sourceSize.rows === targetSize.rows;
  if (targetSize.rows > 1 && targetSize.columns > 1 && !verticalBlock && !horizontalBlock) {
    throw new WorkbookEngineError("INVALID_FILL", "A block fill seed must cover the full source row or column");
  }
  const sourceAddresses = Array.from(iterateRange(source));
  const seed = sourceAddresses.map((address) => cloneCellRecord(sheet.cells[formatCellAddress(address)] ?? { input: BLANK }));
  const requested = operation.mode ?? "auto";
  const strategy: FillMode = requested === "auto"
    ? (verticalBlock || horizontalBlock ? "repeat" : inferFillMode(seed))
    : requested;
  const linearStep = strategy === "linear" ? numericFillStep(seed) : null;
  if (strategy === "linear" && linearStep === null) {
    throw new WorkbookEngineError("INVALID_FILL", "Linear fill requires at least two numeric seed cells");
  }
  if (strategy === "linear" && (verticalBlock || horizontalBlock)) {
    throw new WorkbookEngineError("INVALID_FILL", "Linear fill requires a one-dimensional target");
  }
  const targetAddresses = Array.from(iterateRange(target));
  for (let index = 0; index < targetAddresses.length; index += 1) {
    const destination = targetAddresses[index]!;
    if (addressInRange(destination, source)) continue;
    const sourceIndex = sourceIndexFor(destination, source, seed.length, index);
    const sourceAddress = sourceAddresses[sourceIndex]!;
    const sourceRecord = seed[sourceIndex]!;
    let input = structuredClone(sourceRecord.input);
    if (strategy === "linear") {
      const vertical = sourceSize.rows > 1 || targetSize.rows > 1;
      const position = vertical ? destination.row - source.start.row : destination.column - source.start.column;
      const value = (seed[0]!.input as Extract<CellInput, { kind: "number" }>).value + linearStep! * position;
      if (!Number.isFinite(value)) throw new WorkbookEngineError("INVALID_FILL", "Linear fill produced a non-finite number");
      input = { kind: "number", value };
    } else if (input.kind === "formula") {
      input.formula = translateFormula(input.formula, destination.row - sourceAddress.row, destination.column - sourceAddress.column);
    }
    const key = formatCellAddress(destination);
    if (input.kind === "blank" && !sourceRecord.style) delete sheet.cells[key];
    else sheet.cells[key] = { input, ...(sourceRecord.style ? { style: { ...sourceRecord.style } } : {}) };
  }
  return { touchedCells: targetSize.cells, resolved: { range: formatRange(target), strategy } };
}

function copyRange(workbook: SpreadsheetWorkbook, operation: Extract<WorkbookOperation, { type: "copy_range" }>) {
  const sheet = requireSheet(workbook, operation.sheetId);
  const source = parseRange(operation.sourceRange);
  const size = rangeSize(source);
  const destinationStart = parseCellAddress(operation.destination);
  const destination = { start: destinationStart, end: offsetAddress(destinationStart, size.rows - 1, size.columns - 1) };
  const mode = operation.mode ?? "all";
  if (mode !== "all" && mode !== "values") throw new WorkbookEngineError("INVALID_COPY", "Copy mode must be 'all' or 'values'");
  assertAtomicRange(source, "copy source");
  assertAtomicRange(destination, "copy destination");
  assertFilterSafe(workbook, sheet, [source, destination], "Copy");

  const batch = mode === "values" ? new FormulaBatch(workbook) : null;
  const snapshot = Array.from(iterateRange(source), (address) => {
    const key = formatCellAddress(address);
    const record = sheet.cells[key];
    return {
      source: address,
      record: record ? cloneCellRecord(record) : undefined,
      value: batch ? computedToInput(batch.evaluateCell(sheet.id, key)) : undefined,
    };
  });
  for (const entry of snapshot) {
    const destinationAddress = {
      row: destination.start.row + entry.source.row - source.start.row,
      column: destination.start.column + entry.source.column - source.start.column,
    };
    const key = formatCellAddress(destinationAddress);
    if (mode === "values") {
      const existingStyle = sheet.cells[key]?.style;
      const input = structuredClone(entry.value!);
      if (input.kind === "blank" && !existingStyle) delete sheet.cells[key];
      else sheet.cells[key] = { input, ...(existingStyle ? { style: { ...existingStyle } } : {}) };
      continue;
    }
    if (!entry.record) {
      delete sheet.cells[key];
      continue;
    }
    const record = cloneCellRecord(entry.record);
    if (record.input.kind === "formula") {
      record.input.formula = translateFormula(
        record.input.formula,
        destinationAddress.row - entry.source.row,
        destinationAddress.column - entry.source.column,
      );
    }
    sheet.cells[key] = record;
  }
  return {
    touchedCells: size.cells,
    resolved: {
      range: formatRange(destination),
      sourceRange: formatRange(source),
      destinationRange: formatRange(destination),
      mode,
    },
  };
}

function moveRange(workbook: SpreadsheetWorkbook, operation: Extract<WorkbookOperation, { type: "move_range" }>) {
  const sheet = requireSheet(workbook, operation.sheetId);
  const source = parseRange(operation.sourceRange);
  const size = rangeSize(source);
  const destinationStart = parseCellAddress(operation.destination);
  const destination = { start: destinationStart, end: offsetAddress(destinationStart, size.rows - 1, size.columns - 1) };
  assertAtomicRange(source, "move source");
  assertAtomicRange(destination, "move destination");
  assertFilterSafe(workbook, sheet, [source, destination], "Move");
  const logicalTouched = rangeUnionSize(source, destination);
  if (logicalTouched > SPREADSHEET_LIMITS.maxTouchedCells) {
    throw new WorkbookEngineError("LIMIT", `Move cannot touch more than ${SPREADSHEET_LIMITS.maxTouchedCells} cells`);
  }
  const resolved = {
    range: formatRange(destination),
    sourceRange: formatRange(source),
    destinationRange: formatRange(destination),
  };
  if (sameRange(source, destination)) return { touchedCells: 0, resolved };

  const rowDelta = destination.start.row - source.start.row;
  const columnDelta = destination.start.column - source.start.column;
  const snapshot = Array.from(iterateRange(source), (address) => {
    const record = sheet.cells[formatCellAddress(address)];
    if (!record) return { source: address, record: undefined };
    const cloned = cloneCellRecord(record);
    if (cloned.input.kind === "formula") {
      cloned.input.formula = rewriteMovedCellFormula(
        cloned.input.formula,
        sheet.name,
        source,
        rowDelta,
        columnDelta,
      );
    }
    return { source: address, record: cloned };
  });

  for (const address of iterateRange(source)) delete sheet.cells[formatCellAddress(address)];
  for (const entry of snapshot) {
    const destinationAddress = {
      row: entry.source.row + rowDelta,
      column: entry.source.column + columnDelta,
    };
    const key = formatCellAddress(destinationAddress);
    if (entry.record) sheet.cells[key] = entry.record;
    else delete sheet.cells[key];
  }

  let touchedCells = logicalTouched;
  for (const candidateSheet of workbook.sheets) {
    for (const [address, record] of Object.entries(candidateSheet.cells)) {
      if (candidateSheet.id === sheet.id && addressInRange(parseCellAddress(address), destination)) continue;
      if (record.input.kind !== "formula") continue;
      const rewritten = retargetMovedReferences(record.input.formula, candidateSheet.name, sheet.name, source, rowDelta, columnDelta);
      if (rewritten === record.input.formula) continue;
      record.input.formula = rewritten;
      touchedCells += 1;
      if (touchedCells > SPREADSHEET_LIMITS.maxTouchedCells) {
        throw new WorkbookEngineError("LIMIT", `Move cannot touch more than ${SPREADSHEET_LIMITS.maxTouchedCells} cells`);
      }
    }
  }
  return { touchedCells, resolved };
}

type StructuralOperation = Extract<WorkbookOperation,
  { type: "insert_rows" | "delete_rows" | "insert_columns" | "delete_columns" }>;

function changeStructure(
  workbook: SpreadsheetWorkbook,
  operation: StructuralOperation,
  axis: "row" | "column",
  kind: "insert" | "delete",
) {
  const sheet = requireSheet(workbook, operation.sheetId);
  const index = "startRow" in operation ? operation.startRow : operation.startColumn;
  const count = operation.count;
  const limit = axis === "row" ? SPREADSHEET_LIMITS.maxRows : SPREADSHEET_LIMITS.maxColumns;
  if (!Number.isInteger(index) || index < 0 || index >= limit) {
    throw new WorkbookEngineError(axis === "row" ? "INVALID_ROW" : "INVALID_COLUMN", `Invalid ${axis} start`);
  }
  if (!Number.isInteger(count) || count < 1 || count > limit - index) {
    throw new WorkbookEngineError("INVALID_COUNT", `${axis} count must be a positive integer within the sheet limit`);
  }
  assertStructuralFilterSafe(sheet, axis, index, `${kind === "insert" ? "Insert" : "Delete"} ${axis}s`);
  if (kind === "insert") assertInsertCapacity(sheet, axis, index, count, limit);

  const touched = new Set<string>();
  const markTouched = (sheetId: string, address: string) => {
    touched.add(`${sheetId}:${address}`);
    if (touched.size > SPREADSHEET_LIMITS.maxTouchedCells) {
      throw new WorkbookEngineError("LIMIT", `Structural changes cannot touch more than ${SPREADSHEET_LIMITS.maxTouchedCells} cells`);
    }
  };
  for (const candidateSheet of workbook.sheets) {
    for (const [address, record] of Object.entries(candidateSheet.cells)) {
      if (record.input.kind !== "formula") continue;
      const rewritten = translateFormulaStructure(record.input.formula, {
        axis,
        kind,
        index,
        count,
        currentSheetName: candidateSheet.name,
        targetSheetName: sheet.name,
      });
      if (rewritten === record.input.formula) continue;
      record.input.formula = rewritten;
      markTouched(candidateSheet.id, address);
    }
  }

  const nextCells: SpreadsheetSheet["cells"] = {};
  const deletedLast = index + count - 1;
  for (const [address, record] of Object.entries(sheet.cells)) {
    const parsed = parseCellAddress(address);
    const coordinate = axis === "row" ? parsed.row : parsed.column;
    if (coordinate < index) {
      nextCells[address] = record;
      continue;
    }
    markTouched(sheet.id, address);
    if (kind === "delete" && coordinate <= deletedLast) continue;
    const shifted = kind === "insert" ? coordinate + count : coordinate - count;
    const nextAddress = axis === "row"
      ? { row: shifted, column: parsed.column }
      : { row: parsed.row, column: shifted };
    nextCells[formatCellAddress(nextAddress)] = record;
  }
  sheet.cells = nextCells;
  if (axis === "row" && sheet.rowHeights) sheet.rowHeights = shiftSparseMetadata(sheet.rowHeights, index, count, kind);
  if (axis === "column" && sheet.columnWidths) sheet.columnWidths = shiftSparseMetadata(sheet.columnWidths, index, count, kind);
  return { touchedCells: touched.size };
}

function sourceIndexFor(destination: CellAddress, source: CellRange, length: number, fallback: number): number {
  if (length === 1) return 0;
  const sourceSize = rangeSize(source);
  const position = sourceSize.rows > 1 ? destination.row - source.start.row : sourceSize.columns > 1 ? destination.column - source.start.column : fallback;
  return ((position % length) + length) % length;
}

function inferFillMode(seed: CellRecord[]): FillMode {
  return hasConsistentNumericStep(seed) ? "linear" : seed.length === 1 ? "copy" : "repeat";
}

function numericFillStep(seed: CellRecord[]): number | null {
  if (seed.length < 2 || !seed.every((record) => record.input.kind === "number")) return null;
  const second = seed[1]!.input as Extract<CellInput, { kind: "number" }>;
  const first = seed[0]!.input as Extract<CellInput, { kind: "number" }>;
  const step = second.value - first.value;
  return Number.isFinite(step) ? step : null;
}

function hasConsistentNumericStep(seed: CellRecord[]): boolean {
  const step = numericFillStep(seed);
  if (step === null) return false;
  for (let index = 2; index < seed.length; index += 1) {
    const current = seed[index]!.input as Extract<CellInput, { kind: "number" }>;
    const previous = seed[index - 1]!.input as Extract<CellInput, { kind: "number" }>;
    const actual = current.value - previous.value;
    const tolerance = Number.EPSILON * 16 * Math.max(1, Math.abs(step), Math.abs(actual));
    if (!Number.isFinite(actual) || Math.abs(actual - step) > tolerance) return false;
  }
  return true;
}

function applyStyle(workbook: SpreadsheetWorkbook, operation: Extract<WorkbookOperation, { type: "apply_style" }>) {
  const sheet = requireSheet(workbook, operation.sheetId);
  const range = parseRange(operation.range);
  assertAtomicRange(range, "apply style");
  assertFilterSafe(workbook, sheet, [range], "Apply style");
  assertCellStyle(operation.style);
  for (const address of iterateRange(range)) {
    const key = formatCellAddress(address);
    const existing = sheet.cells[key] ?? { input: BLANK };
    sheet.cells[key] = { input: structuredClone(existing.input), style: { ...existing.style, ...operation.style } };
  }
  return { touchedCells: rangeSize(range).cells, resolved: { range: formatRange(range) } };
}

function sortRange(workbook: SpreadsheetWorkbook, operation: Extract<WorkbookOperation, { type: "sort_range" }>) {
  const sheet = requireSheet(workbook, operation.sheetId);
  const range = parseRange(operation.range);
  assertAtomicRange(range, "sort");
  if (operation.keyColumn < range.start.column || operation.keyColumn > range.end.column) throw new WorkbookEngineError("INVALID_SORT", "Sort key must be inside range");
  if (typeof operation.hasHeader !== "boolean") throw new WorkbookEngineError("INVALID_SORT", "Sort must state whether the selection has a header row");
  const firstDataRow = range.start.row + (operation.hasHeader ? 1 : 0);
  if (firstDataRow > range.end.row) throw new WorkbookEngineError("INVALID_SORT", "A header-aware sort requires at least one data row");
  const batch = new FormulaBatch(workbook);
  const rows: Array<{ original: number; key: unknown; records: Array<CellRecord | undefined> }> = [];
  for (let row = firstDataRow; row <= range.end.row; row += 1) {
    const address = formatCellAddress({ row, column: operation.keyColumn });
    const computed = batch.evaluateCell(sheet.id, address);
    const key = computed.kind === "error" ? computed.code : computed.value;
    const records: Array<CellRecord | undefined> = [];
    for (let column = range.start.column; column <= range.end.column; column += 1) {
      const record = sheet.cells[formatCellAddress({ row, column })];
      records.push(record ? cloneCellRecord(record) : undefined);
    }
    rows.push({ original: row, key, records });
  }
  rows.sort((left, right) => {
    const leftBlank = left.key === null || left.key === "";
    const rightBlank = right.key === null || right.key === "";
    // Spreadsheet sorts conventionally keep blanks after populated values in
    // both directions. Do not invert this placement for descending order.
    if (leftBlank !== rightBlank) return leftBlank ? 1 : -1;
    const compared = compareSortKeys(left.key, right.key);
    return (operation.direction === "ascending" ? compared : -compared) || left.original - right.original;
  });
  rows.forEach((source, rowOffset) => {
    const destinationRow = firstDataRow + rowOffset;
    source.records.forEach((record, columnOffset) => {
      const key = formatCellAddress({ row: destinationRow, column: range.start.column + columnOffset });
      if (record?.input.kind === "formula" && destinationRow !== source.original) {
        record.input.formula = translateFormula(record.input.formula, destinationRow - source.original, 0);
      }
      if (record) sheet.cells[key] = record;
      else delete sheet.cells[key];
    });
  });
  return {
    touchedCells: (range.end.row - firstDataRow + 1) * (range.end.column - range.start.column + 1),
    resolved: { range: formatRange(range) },
  };
}

function compareSortKeys(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === null || left === "") return 1;
  if (right === null || right === "") return -1;
  const rank = (value: unknown) => typeof value === "number" ? 0 : typeof value === "string" && value.startsWith("#") ? 3 : typeof value === "string" ? 1 : 2;
  const rankDifference = rank(left) - rank(right);
  if (rankDifference) return rankDifference;
  if (typeof left === "string" && typeof right === "string") return left.localeCompare(right, "en-US", { numeric: true, sensitivity: "base" });
  return String(left) < String(right) ? -1 : 1;
}

function computedToInput(computed: ReturnType<FormulaBatch["evaluateCell"]>): CellInput {
  if (computed.kind === "blank") return BLANK;
  // Paste Values must preserve an error as an error. Storing the display text
  // would make downstream IFERROR/IFNA formulas treat it as ordinary text.
  if (computed.kind === "error") return { kind: "formula", formula: `=${computed.code}` };
  if (typeof computed.value === "number") return { kind: "number", value: computed.value };
  if (typeof computed.value === "boolean") return { kind: "boolean", value: computed.value };
  return { kind: "text", value: computed.value };
}

function rewriteMovedCellFormula(
  formula: string,
  currentSheetName: string,
  source: CellRange,
  rowDelta: number,
  columnDelta: number,
): string {
  // Moving a formula preserves precedents outside the moved range. Only
  // references to cells that move with the source are retargeted; copy/fill is
  // the operation that translates unrelated relative references.
  return rewriteMoveFormula(formula, currentSheetName, currentSheetName, source, rowDelta, columnDelta, false);
}

function retargetMovedReferences(
  formula: string,
  currentSheetName: string,
  targetSheetName: string,
  source: CellRange,
  rowDelta: number,
  columnDelta: number,
): string {
  return rewriteMoveFormula(formula, currentSheetName, targetSheetName, source, rowDelta, columnDelta, false);
}

function rewriteMoveFormula(
  formula: string,
  currentSheetName: string,
  targetSheetName: string,
  source: CellRange,
  rowDelta: number,
  columnDelta: number,
  translateRelativeOutsideSource: boolean,
): string {
  return rewriteFormulaReferences(formula, (expression) => {
    if (expression.end && expression.start.sheet && expression.end.sheet && !sameSheetName(expression.start.sheet, expression.end.sheet)) {
      return null;
    }
    const expressionSheet = expression.start.sheet ?? expression.end?.sheet ?? currentSheetName;
    const pointsAtTarget = sameSheetName(expressionSheet, targetSheetName);
    if (pointsAtTarget && expression.end) {
      const referencedRange = normalizeRange({ start: expression.start.address, end: expression.end.address });
      if (rangesIntersect(referencedRange, source) && !rangeContains(source, referencedRange)) {
        throw new WorkbookEngineError(
          "UNSUPPORTED_MOVE_REFERENCE",
          "Move cannot preserve a formula range that only partially overlaps the source",
          { sourceRange: formatRange(source), referenceRange: formatRange(referencedRange) },
        );
      }
    }
    let invalid = false;
    const rewrite = (reference: FormulaCellReference): FormulaCellReference => {
      const next = { ...reference, address: { ...reference.address } };
      if (pointsAtTarget && addressInRange(reference.address, source)) {
        next.address.row += rowDelta;
        next.address.column += columnDelta;
      } else if (translateRelativeOutsideSource) {
        if (!reference.rowAbsolute) next.address.row += rowDelta;
        if (!reference.columnAbsolute) next.address.column += columnDelta;
      }
      if (
        next.address.row < 0 || next.address.row >= SPREADSHEET_LIMITS.maxRows ||
        next.address.column < 0 || next.address.column >= SPREADSHEET_LIMITS.maxColumns
      ) invalid = true;
      return next;
    };
    const result: FormulaReferenceExpression = {
      start: rewrite(expression.start),
      ...(expression.end ? { end: rewrite(expression.end) } : {}),
    };
    return invalid ? "#REF!" : result;
  });
}

function rewriteRenamedSheetReferences(workbook: SpreadsheetWorkbook, oldName: string, newName: string): number {
  if (oldName === newName) return 0;
  let touched = 0;
  for (const sheet of workbook.sheets) {
    for (const record of Object.values(sheet.cells)) {
      if (record.input.kind !== "formula") continue;
      const rewritten = renameFormulaSheetReferences(record.input.formula, oldName, newName);
      if (rewritten === record.input.formula) continue;
      record.input.formula = rewritten;
      touched += 1;
      if (touched > SPREADSHEET_LIMITS.maxTouchedCells) {
        throw new WorkbookEngineError("LIMIT", `Rename cannot rewrite more than ${SPREADSHEET_LIMITS.maxTouchedCells} formula cells`);
      }
    }
  }
  return touched;
}

function invalidateDeletedSheetReferences(
  workbook: SpreadsheetWorkbook,
  deletedSheetId: string,
  deletedSheetName: string,
  deletedCellCount: number,
): number {
  if (deletedCellCount > SPREADSHEET_LIMITS.maxTouchedCells) {
    throw new WorkbookEngineError(
      "LIMIT",
      `Delete sheet cannot touch more than ${SPREADSHEET_LIMITS.maxTouchedCells} cells`,
    );
  }
  let touched = deletedCellCount;
  for (const sheet of workbook.sheets) {
    if (sheet.id === deletedSheetId) continue;
    for (const record of Object.values(sheet.cells)) {
      if (record.input.kind !== "formula") continue;
      const rewritten = rewriteFormulaReferences(record.input.formula, (expression) => {
        const references = expression.end ? [expression.start, expression.end] : [expression.start];
        return references.some(
          (reference) => reference.sheet !== undefined && sameSheetName(reference.sheet, deletedSheetName),
        )
          ? "#REF!"
          : null;
      });
      if (rewritten === record.input.formula) continue;
      touched += 1;
      if (touched > SPREADSHEET_LIMITS.maxTouchedCells) {
        throw new WorkbookEngineError(
          "LIMIT",
          `Delete sheet cannot touch more than ${SPREADSHEET_LIMITS.maxTouchedCells} cells`,
        );
      }
      record.input.formula = rewritten;
    }
  }
  return touched;
}

function assertFilterSafe(
  workbook: SpreadsheetWorkbook,
  sheet: SpreadsheetSheet,
  ranges: CellRange[],
  operation: string,
): void {
  if (!sheet.filter) return;
  const filterRange = parseRange(sheet.filter.range);
  const batch = new FormulaBatch(workbook);
  for (const range of ranges) {
    const touchesFilterHeader =
      range.start.row <= filterRange.start.row && range.end.row >= filterRange.start.row &&
      range.start.column <= filterRange.end.column && range.end.column >= filterRange.start.column;
    if (touchesFilterHeader) throw filteredRangeError(operation, filterRange, filterRange.start.row);
    const firstDataRow = Math.max(range.start.row, filterRange.start.row + 1);
    const lastDataRow = Math.min(range.end.row, filterRange.end.row);
    for (let row = firstDataRow; row <= lastDataRow; row += 1) {
      if (isFilterRowHidden(workbook, sheet, row, batch)) throw filteredRangeError(operation, filterRange, row);
    }
  }
}

function filteredRangeError(operation: string, filterRange: CellRange, row: number): WorkbookEngineError {
  return new WorkbookEngineError(
    "FILTERED_RANGE",
    `${operation} cannot span an active filter header or hidden row; clear the filter first`,
    { filterRange: formatRange(filterRange), row: row + 1 },
  );
}

function countFilterHiddenRows(workbook: SpreadsheetWorkbook, sheet: SpreadsheetSheet): number {
  if (!sheet.filter) return 0;
  const filterRange = parseRange(sheet.filter.range);
  const dataRowCount = Math.max(0, filterRange.end.row - filterRange.start.row);
  if (dataRowCount === 0) return 0;
  const defaultHidden = !filterMatches(sheet.filter, "");
  let hidden = defaultHidden ? dataRowCount : 0;
  const batch = new FormulaBatch(workbook);
  for (const [address, record] of Object.entries(sheet.cells)) {
    const parsed = parseCellAddress(address);
    if (
      parsed.column !== sheet.filter.column ||
      parsed.row <= filterRange.start.row ||
      parsed.row > filterRange.end.row
    ) continue;
    const actualHidden = !filterMatches(
      sheet.filter,
      filterCellDisplay(workbook, sheet, parsed.row, batch, record),
    );
    if (actualHidden !== defaultHidden) hidden += actualHidden ? 1 : -1;
  }
  return hidden;
}

function isFilterRowHidden(
  workbook: SpreadsheetWorkbook,
  sheet: SpreadsheetSheet,
  row: number,
  batch: FormulaBatch,
): boolean {
  if (!sheet.filter) return false;
  const range = parseRange(sheet.filter.range);
  if (row <= range.start.row || row > range.end.row) return false;
  return !filterMatches(sheet.filter, filterCellDisplay(workbook, sheet, row, batch));
}

function filterMatches(filter: SheetFilter, display: string): boolean {
  return "equals" in filter ? display === filter.equals : display !== "";
}

function filterCellDisplay(
  workbook: SpreadsheetWorkbook,
  sheet: SpreadsheetSheet,
  row: number,
  batch: FormulaBatch,
  knownRecord?: CellRecord,
): string {
  const address = formatCellAddress({ row, column: sheet.filter!.column });
  const record = knownRecord ?? sheet.cells[address];
  if (!record) return "";
  if (record.input.kind === "formula") return batch.displayCell(sheet.id, address);
  switch (record.input.kind) {
    case "blank": return "";
    case "text": return record.input.value;
    case "number": return formatComputed(
      { kind: "value", value: record.input.value },
      record,
      workbook.calculation.dateSystem,
    );
    case "boolean": return record.input.value ? "TRUE" : "FALSE";
  }
}

function assertStructuralFilterSafe(sheet: SpreadsheetSheet, axis: "row" | "column", index: number, operation: string): void {
  if (!sheet.filter) return;
  const filterRange = parseRange(sheet.filter.range);
  const filterEnd = axis === "row" ? filterRange.end.row : filterRange.end.column;
  if (index > filterEnd) return;
  throw new WorkbookEngineError(
    "FILTERED_RANGE",
    `${operation} would shift an active filtered range; clear the filter first`,
    { filterRange: formatRange(filterRange) },
  );
}

function assertInsertCapacity(
  sheet: SpreadsheetSheet,
  axis: "row" | "column",
  index: number,
  count: number,
  limit: number,
): void {
  for (const address of Object.keys(sheet.cells)) {
    const parsed = parseCellAddress(address);
    const coordinate = axis === "row" ? parsed.row : parsed.column;
    if (coordinate >= index && coordinate + count >= limit) {
      throw new WorkbookEngineError("SHEET_LIMIT", `Insert would push populated ${axis}s beyond the sheet limit`, { address });
    }
  }
  const metadata = axis === "row" ? sheet.rowHeights : sheet.columnWidths;
  for (const key of Object.keys(metadata ?? {})) {
    const coordinate = Number(key);
    if (Number.isInteger(coordinate) && coordinate >= index && coordinate + count >= limit) {
      throw new WorkbookEngineError("SHEET_LIMIT", `Insert would push sized ${axis}s beyond the sheet limit`);
    }
  }
}

function shiftSparseMetadata(
  metadata: Record<string, number>,
  index: number,
  count: number,
  kind: "insert" | "delete",
): Record<string, number> {
  const result: Record<string, number> = {};
  const deletedLast = index + count - 1;
  for (const [key, value] of Object.entries(metadata)) {
    const coordinate = Number(key);
    if (!Number.isInteger(coordinate) || coordinate < 0) continue;
    if (coordinate < index) result[String(coordinate)] = value;
    else if (kind === "insert") result[String(coordinate + count)] = value;
    else if (coordinate > deletedLast) result[String(coordinate - count)] = value;
  }
  return result;
}

function addressInRange(address: CellAddress, range: CellRange): boolean {
  return address.row >= range.start.row && address.row <= range.end.row &&
    address.column >= range.start.column && address.column <= range.end.column;
}

function rangesIntersect(left: CellRange, right: CellRange): boolean {
  return left.start.row <= right.end.row && left.end.row >= right.start.row &&
    left.start.column <= right.end.column && left.end.column >= right.start.column;
}

function rangeContains(outer: CellRange, inner: CellRange): boolean {
  return outer.start.row <= inner.start.row && outer.end.row >= inner.end.row &&
    outer.start.column <= inner.start.column && outer.end.column >= inner.end.column;
}

function rangeUnionSize(left: CellRange, right: CellRange): number {
  const intersectionRows = Math.max(0, Math.min(left.end.row, right.end.row) - Math.max(left.start.row, right.start.row) + 1);
  const intersectionColumns = Math.max(0, Math.min(left.end.column, right.end.column) - Math.max(left.start.column, right.start.column) + 1);
  return rangeSize(left).cells + rangeSize(right).cells - intersectionRows * intersectionColumns;
}

function sameRange(left: CellRange, right: CellRange): boolean {
  return left.start.row === right.start.row && left.start.column === right.start.column &&
    left.end.row === right.end.row && left.end.column === right.end.column;
}

function sameSheetName(left: string, right: string): boolean {
  return left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US");
}

function workbooksEqual(left: SpreadsheetWorkbook, right: SpreadsheetWorkbook): boolean {
  return deepEqual(left, right);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => deepEqual(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.hasOwn(rightRecord, key) && deepEqual(leftRecord[key], rightRecord[key]));
}

function validateCommandEnvelope(request: ApplyRequest, revision: number): void {
  if (!request.commandId || request.commandId.length > 128) throw new WorkbookEngineError("INVALID_COMMAND", "commandId is required and at most 128 characters");
  if (request.expectedRevision !== revision) throw revisionConflict(request.expectedRevision, revision);
  if (!Array.isArray(request.operations) || request.operations.length === 0 || request.operations.length > SPREADSHEET_LIMITS.maxOperations) {
    throw new WorkbookEngineError("INVALID_COMMAND", `operations must contain 1-${SPREADSHEET_LIMITS.maxOperations} commands`);
  }
}

function assertWorkbookResourceLimits(workbook: SpreadsheetWorkbook): void {
  const cells = workbook.sheets.reduce((sum, sheet) => sum + Object.keys(sheet.cells).length, 0);
  if (cells > SPREADSHEET_LIMITS.maxCells) throw new WorkbookEngineError("LIMIT", `Workbook exceeds ${SPREADSHEET_LIMITS.maxCells} stored cells`);
  const dimensions = workbook.sheets.reduce(
    (sum, sheet) => sum + Object.keys(sheet.columnWidths ?? {}).length + Object.keys(sheet.rowHeights ?? {}).length,
    0,
  );
  if (dimensions > SPREADSHEET_LIMITS.maxDimensionOverrides) {
    throw new WorkbookEngineError(
      "LIMIT",
      `Workbook exceeds ${SPREADSHEET_LIMITS.maxDimensionOverrides} custom row/column sizes`,
    );
  }
}

function revisionConflict(expected: number, actual: number): WorkbookEngineError {
  return new WorkbookEngineError("REVISION_CONFLICT", `Expected revision ${expected}, current revision is ${actual}`, { expectedRevision: expected, actualRevision: actual });
}

function historyId(commandId: string, revision: number): string {
  return `history:${revision}:${commandId}`;
}

function compareAddresses(left: string, right: string): number {
  const a = parseCellAddress(left);
  const b = parseCellAddress(right);
  return a.row - b.row || a.column - b.column;
}

const MAX_FIND_CURSORS = 256;
const FIND_CURSOR_PLACEHOLDER = `find_cursor_${"0".repeat(32)}`;

function encodeCursor(workbookId: string, revision: number, sheetId: string, range: string, offset: number): string {
  const bytes = UTF8_ENCODER.encode(JSON.stringify({ version: 1, workbookId, revision, sheetId, range, offset }));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeCursor(cursor: string | undefined, workbookId: string, revision: number, sheetId: string, range: string): number {
  if (!cursor) return 0;
  let value: unknown;
  try {
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(cursor.length / 4) * 4, "=");
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new WorkbookEngineError("INVALID_CURSOR", "Read cursor is malformed");
  }
  if (
    !value || typeof value !== "object" ||
    (value as Record<string, unknown>).version !== 1 ||
    (value as Record<string, unknown>).workbookId !== workbookId ||
    (value as Record<string, unknown>).revision !== revision ||
    (value as Record<string, unknown>).sheetId !== sheetId ||
    (value as Record<string, unknown>).range !== range ||
    !Number.isSafeInteger((value as Record<string, unknown>).offset) ||
    ((value as Record<string, unknown>).offset as number) < 0
  ) {
    throw new WorkbookEngineError("INVALID_CURSOR", "Cursor does not match this revision and query");
  }
  return (value as { offset: number }).offset;
}

function assertAtomicRange(range: CellRange, operation: string): void {
  const size = rangeSize(range);
  if (size.cells > SPREADSHEET_LIMITS.maxTouchedCells) {
    throw new WorkbookEngineError(
      "LIMIT",
      `${operation} cannot touch more than ${SPREADSHEET_LIMITS.maxTouchedCells} cells`,
      { range: formatRange(range), touchedCells: size.cells },
    );
  }
}

export class WorkbookEngineError extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "WorkbookEngineError";
  }
}
