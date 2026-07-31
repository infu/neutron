import { expect, test } from "bun:test";
import {
  listExposedTools,
  validateToolArguments,
  validateToolResult,
  type JsonObject,
  type JsonValue,
  type MsgBusToolDescriptor,
  type MsgBusToolContext,
} from "neutron-tools/app";
import type { ApplyResult, HistoryResult, ReadRangeResult } from "../src/engine.ts";
import {
  requestAttachmentDelegation,
  WORKBOOK_CAPABILITIES,
} from "../src/service.ts";
import { getWorkbookHelp } from "../src/help.ts";
import type {
  ExportCommitResult,
  ExportPreflightResult,
  NativeSaveResult,
  RecoveryResult,
  SessionMutationResult,
  SessionStatus,
} from "../src/session.ts";

const status: SessionStatus = {
  revision: 4,
  workbookId: "wb_contract",
  sheets: [{
    id: "sheet_contract",
    name: "Sheet1",
    usedRange: "A1:C3",
    cellCount: 3,
    filter: { range: "A1:C3", column: 0, equals: "North" },
    hiddenRowCount: 1,
    columnWidths: { 0: 120 },
    rowHeights: { 1: 28 },
  }],
  canUndo: true,
  canRedo: false,
  undoHistoryId: "history_4",
  redoHistoryId: null,
  history: {
    entries: 1,
    bytes: 512,
    maxEntries: 100,
    maxBytes: 16 * 1024 * 1024,
  },
  dirty: true,
  lastSavedRevision: null,
  nativeSource: null,
  importProvenance: {
    path: "/Imports/book.xlsx",
    etag: "xlsx-etag",
    format: "xlsx",
    warnings: ["Unsupported workbook metadata was omitted."],
  },
  recovery: {
    available: true,
    pending: false,
    savedAt: 1_000,
    revision: 4,
    degraded: false,
    error: null,
  },
  saving: false,
};

function descriptor(name: string): MsgBusToolDescriptor {
  const result = listExposedTools().find((candidate) => candidate.name === name);
  if (!result) throw new Error(`Missing descriptor ${name}`);
  return result;
}

function validate(name: string, result: unknown): void {
  validateToolResult(descriptor(name), result as JsonValue);
}

function validateArguments(name: string, args: JsonObject): void {
  validateToolArguments(descriptor(name), args);
}

test("Spreadsheet publishes closed action-discriminated input schemas", () => {
  const mutation = { expectedRevision: 4, commandId: "contract-command" };
  const setCell: JsonObject = {
    type: "set_cells",
    sheetId: "sheet_contract",
    start: "A1",
    values: [[{ kind: "number", value: 1 }]],
  };
  const headerSort: JsonObject = {
    type: "sort_range",
    sheetId: "sheet_contract",
    range: "A1:C3",
    keyColumn: 0,
    direction: "ascending",
    hasHeader: true,
  };

  for (const args of [
    {},
    { topic: "overview" },
    { topic: "formulas" },
    { topic: "functions" },
    { topic: "functions", query: "lookup", category: "lookup" },
    { topic: "function", functionName: "XLOOKUP" },
    { topic: "errors" },
    { topic: "operations" },
    { topic: "files" },
    { topic: "concurrency" },
  ]) validateArguments("workbook_help", args as JsonObject);

  validateArguments("workbook_read", {
    sheetId: "sheet_contract",
    range: "A1:T50",
    limit: 1_000,
    includeBlanks: false,
  });

  for (const args of [
    { action: "new", ...mutation },
    { action: "demo", ...mutation, discardDirty: true },
    { action: "open", ...mutation, path: "/Documents/book.csv", csvTyping: "text" },
    { action: "recover", ...mutation, discardDirty: true },
    { action: "discard_recovery", ...mutation },
  ]) validateArguments("workbook_session", args);

  validateArguments("workbook_accept_file", {
    path: "/Documents/book.csv",
    mediaType: "text/csv",
    etag: "a".repeat(64),
  });

  for (const args of [
    { action: "apply", ...mutation, operations: [setCell] },
    { action: "apply", ...mutation, operations: [headerSort] },
    { action: "apply", ...mutation, operations: [setCell], dryRun: true },
    { action: "undo", ...mutation, expectedHistoryId: "history:4:contract" },
    { action: "redo", ...mutation, expectedHistoryId: "history:4:contract" },
  ]) validateArguments("workbook_apply", args as JsonObject);

  for (const args of [
    { action: "native", ...mutation },
    { action: "native", ...mutation, path: "/Documents/book.nsheet" },
    { action: "export_preflight", ...mutation, format: "xlsx", path: "/Exports/book.xlsx" },
    {
      action: "export_preflight", ...mutation, format: "csv", path: "/Exports/book.csv",
      sheetId: "sheet_contract", csvInjectionPolicy: "safe", range: "A1:C3", bom: true,
    },
    {
      action: "export_commit", ...mutation, format: "xlsx", path: "/Exports/book.xlsx",
      preflightToken: "preflight-token-1234",
    },
    {
      action: "export_commit", ...mutation, format: "csv", path: "/Exports/book.csv",
      sheetId: "sheet_contract", csvInjectionPolicy: "exact", preflightToken: "preflight-token-1234",
    },
  ]) validateArguments("workbook_save", args);
});

test("Spreadsheet input schemas reject missing and action-irrelevant fields", () => {
  const mutation = { expectedRevision: 4, commandId: "contract-command" };
  const setCell: JsonObject = {
    type: "set_cells",
    sheetId: "sheet_contract",
    start: "A1",
    values: [[{ kind: "number", value: 1 }]],
  };
  const invalid: Array<[string, JsonObject]> = [
    ["workbook_help", { topic: "unknown" }],
    ["workbook_help", { topic: "functions", query: "" }],
    ["workbook_help", { topic: "functions", category: "unknown" }],
    ["workbook_help", { topic: "function" }],
    ["workbook_help", { topic: "overview", functionName: "SUM" }],
    ["workbook_read", { sheetId: "sheet_contract", range: "A1:T50", includeBlanks: "no" }],
    ["workbook_session", { action: "open", ...mutation }],
    ["workbook_session", { action: "new", ...mutation, path: "/ignored.nsheet" }],
    ["workbook_session", { action: "discard_recovery", ...mutation, discardDirty: true }],
    ["workbook_accept_file", {
      path: "/Documents/book.csv", mediaType: "text/csv", etag: "not-a-sha256-etag",
    }],
    ["workbook_accept_file", {
      path: "/Documents/book.csv", mediaType: "text/csv", etag: "A".repeat(64),
    }],
    ["workbook_apply", { action: "apply", ...mutation }],
    ["workbook_apply", { action: "apply", ...mutation, operations: [setCell], expectedHistoryId: "ignored" }],
    ["workbook_apply", { action: "undo", ...mutation }],
    ["workbook_apply", { action: "undo", ...mutation, expectedHistoryId: "history", operations: [setCell] }],
    ["workbook_apply", { action: "apply", ...mutation, operations: [{
      type: "sort_range", sheetId: "sheet_contract", range: "A1:C3", keyColumn: 0, direction: "ascending",
    }] }],
    ["workbook_save", { action: "native", ...mutation, format: "csv" }],
    ["workbook_save", { action: "export_preflight", ...mutation, format: "xlsx" }],
    ["workbook_save", { action: "export_preflight", ...mutation, format: "xlsx", path: "/book.xlsx", bom: true }],
    ["workbook_save", { action: "export_preflight", ...mutation, format: "csv", path: "/book.csv" }],
    ["workbook_save", {
      action: "export_commit", ...mutation, format: "xlsx", path: "/book.xlsx",
    }],
    ["workbook_save", {
      action: "export_commit", ...mutation, format: "csv", path: "/book.csv",
      sheetId: "sheet_contract", csvInjectionPolicy: "safe", preflightToken: "preflight-token-1234",
      range: "A1:A2", unexpected: true,
    }],
  ];

  for (const [name, args] of invalid) {
    expect(() => validateArguments(name, args)).toThrow("Invalid arguments");
  }
});

test("Spreadsheet publishes a truthful closed schema for every public successful result", () => {
  expect(listExposedTools().map((tool) => tool.name).sort()).toEqual([
    "workbook_accept_file",
    "workbook_apply",
    "workbook_find",
    "workbook_help",
    "workbook_read",
    "workbook_save",
    "workbook_session",
    "workbook_status",
  ]);
  for (const tool of listExposedTools()) expect(tool.outputSchema).toBeDefined();

  validate("workbook_help", getWorkbookHelp({}));
  validate("workbook_help", getWorkbookHelp({ topic: "formulas" }));
  validate("workbook_help", getWorkbookHelp({ topic: "functions" }));
  validate("workbook_help", getWorkbookHelp({ topic: "functions", query: "lookup", category: "lookup" }));
  validate("workbook_help", getWorkbookHelp({ topic: "function", functionName: "SUM" }));
  validate("workbook_help", getWorkbookHelp({ topic: "function", functionName: "EVAL" }));

  validate("workbook_status", { ...status, capabilities: WORKBOOK_CAPABILITIES });

  const sessionMutation: SessionMutationResult = {
    ...status,
    commandId: "session-new-1",
    previousRevision: 3,
  };
  const recovery: RecoveryResult = {
    ...status,
    commandId: "session-recover-1",
    previousRevision: 3,
    recoveryDisposition: "source_changed",
  };
  validate("workbook_session", sessionMutation);
  validate("workbook_session", recovery);
  validate("workbook_accept_file", status);

  const read: ReadRangeResult = {
    workbookId: "wb_contract",
    sheetId: "sheet_contract",
    sheetName: "Sheet1",
    range: "A1:C1",
    revision: 4,
    cells: [
      {
        address: "A1",
        raw: { kind: "blank" },
        computed: { kind: "blank", value: null },
        display: "",
      },
      {
        address: "B1",
        raw: { kind: "number", value: 42 },
        computed: { kind: "value", value: 42 },
        display: "42.00",
        style: { numberFormat: "number", decimals: 2, bold: true },
      },
      {
        address: "C1",
        raw: { kind: "formula", formula: "=1/0" },
        computed: { kind: "error", code: "#DIV/0!", message: "Division by zero" },
        display: "#DIV/0!",
      },
    ],
    hiddenRows: [1],
    nextCursor: "cursor-page-2",
  };
  validate("workbook_read", read);
  validate("workbook_find", {
    workbookId: "wb_contract",
    revision: 4,
    matches: [{
      sheetId: "sheet_contract",
      sheetName: "Sheet1",
      address: "C1",
      raw: "=1/0",
      display: "#DIV/0!",
    }],
    truncated: false,
    nextCursor: null,
  });

  const apply: ApplyResult = {
    commandId: "apply-1",
    revision: 5,
    previousRevision: 4,
    historyId: "history_5",
    touchedCells: 3,
    operationCount: 1,
    dryRun: false,
    noChange: false,
    resolved: [{
      type: "fill",
      sourceRange: "A1:A2",
      destinationRange: "A3:A5",
      strategy: "linear",
    }],
  };
  const history: HistoryResult = {
    commandId: "undo-1",
    revision: 6,
    previousRevision: 5,
    historyId: "history_5",
    action: "undo",
  };
  validate("workbook_apply", apply);
  validate("workbook_apply", history);

  const nativeSave: NativeSaveResult = {
    action: "native",
    commandId: "save-native-1",
    revision: 6,
    savedRevision: 6,
    dirty: false,
    file: {
      path: "/Documents/book.nsheet",
      mediaType: "application/vnd.neutron.spreadsheet+json",
      byteLength: 2_048,
      etag: "native-etag",
      updatedAt: 2_000,
    },
  };
  const preflight: ExportPreflightResult = {
    action: "export_preflight",
    commandId: "export-preflight-1",
    revision: 6,
    format: "xlsx",
    path: "/Documents/book.xlsx",
    preflightToken: "ep1_1234567890123456",
    expiresAt: 3_000,
    byteLength: 4_096,
    warnings: ["Static values replace unsupported workbook metadata."],
    losses: { unsupportedMetadata: 1 },
  };
  const commit: ExportCommitResult = {
    action: "export_commit",
    commandId: "export-commit-1",
    revision: 6,
    format: "xlsx",
    file: {
      path: "/Documents/book.xlsx",
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      byteLength: 4_096,
      etag: "xlsx-export-etag",
    },
    warnings: preflight.warnings,
    losses: preflight.losses,
  };
  validate("workbook_save", nativeSave);
  validate("workbook_save", preflight);
  validate("workbook_save", commit);
});

test("Spreadsheet result schemas reject undocumented fields and partial variants", () => {
  expect(() => validate("workbook_status", {
    ...status,
    capabilities: WORKBOOK_CAPABILITIES,
    undocumented: true,
  })).toThrow("Invalid result");
  expect(() => validate("workbook_save", {
    action: "native",
    commandId: "partial-save",
    revision: 4,
  })).toThrow("Invalid result");
  expect(() => validate("workbook_read", {
    workbookId: "wb_contract",
    sheetId: "sheet_contract",
    sheetName: "Sheet1",
    range: "A1:A1",
    revision: 4,
    cells: [{
      address: "A1",
      raw: { kind: "blank" },
      computed: { kind: "mystery", value: null },
      display: "",
    }],
    hiddenRows: [],
    nextCursor: null,
  })).toThrow("Invalid result");
});

test("attachment delegation preserves coded policy errors and cancellation", async () => {
  const policyError = codedError("AGENT_CONSENT_DENIED");
  const policyContext = delegationContext(async () => { throw policyError; });
  let caught: unknown;
  try {
    await requestAttachmentDelegation(policyContext);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(policyError);

  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await expect(requestAttachmentDelegation(delegationContext(async () => {
    calls += 1;
    return { token: null, expiresAt: null };
  }, controller.signal))).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  expect(calls).toBe(0);

  await expect(requestAttachmentDelegation(delegationContext(async () => {
    throw new Error("bridge unavailable");
  }))).rejects.toMatchObject({ code: "ATTACHMENT_DELEGATION_REQUIRED" });
});

function delegationContext(
  callTool: (...args: unknown[]) => Promise<JsonValue>,
  signal?: AbortSignal,
): MsgBusToolContext {
  return {
    reportProgress() {},
    kernel: { callTool } as unknown as MsgBusToolContext["kernel"],
    ...(signal ? { signal } : {}),
  };
}

function codedError(code: string): Error {
  const error = new Error(code);
  Object.defineProperty(error, "code", { enumerable: true, value: code });
  return error;
}
