import {
  exposeTool,
  publishAppStateChange,
  type JsonObject,
  type JsonValue,
  type MsgBusEndpointId,
  type MsgBusToolContext,
} from "neutron-tools/app";
import { SPREADSHEET_LIMITS, STATE_TOPIC } from "./constants.ts";
import { NATIVE_MIME } from "./constants.ts";
import type { ApplyRequest, WorkbookOperation } from "./engine.ts";
import { exposeAttachmentTool } from "./attachment_transport.ts";
import { BrowserXlsxCodec } from "./formats/xlsx_adapter.ts";
import { SUPPORTED_FORMULA_FUNCTIONS } from "./formula.ts";
import {
  FORMULA_CATEGORIES,
  WORKBOOK_HELP_TOPICS,
  WORKBOOK_OPERATION_NAMES,
  getWorkbookHelp,
  type WorkbookHelpRequest,
} from "./help.ts";
import { NeutronFilesPort } from "./neutron_files_port.ts";
import { SessionError, WorkbookSession } from "./session.ts";
import { commandActorForCaller, requireHistoryId } from "./tool_policy.ts";

const revisionSchema: JsonObject = { type: "integer", minimum: 0 };
const commandIdSchema: JsonObject = { type: "string", minLength: 1, maxLength: 128 };
const sheetIdSchema: JsonObject = { type: "string", minLength: 1, maxLength: 128 };
const rangeSchema: JsonObject = {
  type: "string",
  minLength: 2,
  maxLength: 32,
  // The tool transport deliberately rejects regex grouping/backreferences.
  // This bounded lexical filter stays linear; parseRange performs the exact
  // A1/range validation in the command engine.
  pattern: "^[A-Za-z0-9$:]+$",
};
const cellAddressSchema: JsonObject = {
  type: "string",
  minLength: 2,
  maxLength: 16,
  pattern: "^\\$?[A-Za-z]{1,3}\\$?[1-9][0-9]*$",
};
const cellInputSchema: JsonObject = {
  oneOf: [
    objectSchema(["kind"], { kind: { const: "blank" } }),
    objectSchema(["kind", "value"], { kind: { const: "text" }, value: { type: "string", maxLength: SPREADSHEET_LIMITS.maxTextLength } }),
    objectSchema(["kind", "value"], { kind: { const: "number" }, value: { type: "number" } }),
    objectSchema(["kind", "value"], { kind: { const: "boolean" }, value: { type: "boolean" } }),
    objectSchema(["kind", "formula"], { kind: { const: "formula" }, formula: { type: "string", minLength: 2, maxLength: SPREADSHEET_LIMITS.maxFormulaLength, pattern: "^=" } }),
  ],
};
const styleSchema: JsonObject = objectSchema([], {
  numberFormat: { type: "string", enum: ["general", "number", "currency", "percent", "date", "time"] },
  decimals: { type: "integer", minimum: 0, maximum: 12 },
  bold: { type: "boolean" },
  italic: { type: "boolean" },
  textColor: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
  fillColor: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
  alignment: { type: "string", enum: ["left", "center", "right"] },
  wrap: { type: "boolean" },
});
const filterSchema: JsonObject = {
  oneOf: [
    objectSchema(["range", "column", "equals"], {
      range: rangeSchema,
      column: { type: "integer", minimum: 0, maximum: SPREADSHEET_LIMITS.maxColumns - 1 },
      equals: { type: "string", maxLength: SPREADSHEET_LIMITS.maxTextLength },
    }),
    objectSchema(["range", "column", "nonBlank"], {
      range: rangeSchema,
      column: { type: "integer", minimum: 0, maximum: SPREADSHEET_LIMITS.maxColumns - 1 },
      nonBlank: { const: true },
    }),
  ],
};
const operationSchema: JsonObject = {
  oneOf: [
    objectSchema(["type", "sheetId", "start", "values"], {
      type: { const: "set_cells" }, sheetId: sheetIdSchema, start: cellAddressSchema,
      values: { type: "array", minItems: 1, maxItems: SPREADSHEET_LIMITS.maxTouchedCells, items: { type: "array", minItems: 1, items: cellInputSchema } },
    }),
    objectSchema(["type", "sheetId", "range"], {
      type: { const: "clear" }, sheetId: sheetIdSchema, range: rangeSchema, contents: { type: "boolean" }, styles: { type: "boolean" },
    }),
    objectSchema(["type", "sheetId", "sourceRange", "targetRange"], {
      type: { const: "fill" }, sheetId: sheetIdSchema, sourceRange: rangeSchema, targetRange: rangeSchema,
      mode: { type: "string", enum: ["auto", "copy", "linear", "repeat"] },
    }),
    objectSchema(["type", "sheetId", "sourceRange", "destination"], {
      type: { const: "copy_range" }, sheetId: sheetIdSchema, sourceRange: rangeSchema, destination: cellAddressSchema,
      mode: { type: "string", enum: ["all", "values"] },
    }),
    objectSchema(["type", "sheetId", "sourceRange", "destination"], {
      type: { const: "move_range" }, sheetId: sheetIdSchema, sourceRange: rangeSchema, destination: cellAddressSchema,
    }),
    objectSchema(["type", "sheetId", "startRow", "count"], {
      type: { const: "insert_rows" }, sheetId: sheetIdSchema,
      startRow: { type: "integer", minimum: 0, maximum: SPREADSHEET_LIMITS.maxRows - 1 },
      count: { type: "integer", minimum: 1, maximum: SPREADSHEET_LIMITS.maxRows },
    }),
    objectSchema(["type", "sheetId", "startRow", "count"], {
      type: { const: "delete_rows" }, sheetId: sheetIdSchema,
      startRow: { type: "integer", minimum: 0, maximum: SPREADSHEET_LIMITS.maxRows - 1 },
      count: { type: "integer", minimum: 1, maximum: SPREADSHEET_LIMITS.maxRows },
    }),
    objectSchema(["type", "sheetId", "startColumn", "count"], {
      type: { const: "insert_columns" }, sheetId: sheetIdSchema,
      startColumn: { type: "integer", minimum: 0, maximum: SPREADSHEET_LIMITS.maxColumns - 1 },
      count: { type: "integer", minimum: 1, maximum: SPREADSHEET_LIMITS.maxColumns },
    }),
    objectSchema(["type", "sheetId", "startColumn", "count"], {
      type: { const: "delete_columns" }, sheetId: sheetIdSchema,
      startColumn: { type: "integer", minimum: 0, maximum: SPREADSHEET_LIMITS.maxColumns - 1 },
      count: { type: "integer", minimum: 1, maximum: SPREADSHEET_LIMITS.maxColumns },
    }),
    objectSchema(["type", "sheetId", "range", "style"], {
      type: { const: "apply_style" }, sheetId: sheetIdSchema, range: rangeSchema, style: styleSchema,
    }),
    objectSchema(["type", "name"], { type: { const: "add_sheet" }, name: { type: "string", minLength: 1, maxLength: 31 } }),
    objectSchema(["type", "sheetId", "name"], { type: { const: "rename_sheet" }, sheetId: sheetIdSchema, name: { type: "string", minLength: 1, maxLength: 31 } }),
    objectSchema(["type", "sheetId"], { type: { const: "delete_sheet" }, sheetId: sheetIdSchema }),
    objectSchema(["type", "sheetId", "column", "width"], {
      type: { const: "resize_column" }, sheetId: sheetIdSchema, column: { type: "integer", minimum: 0, maximum: SPREADSHEET_LIMITS.maxColumns - 1 }, width: { type: ["number", "null"], minimum: 24, maximum: 600 },
    }),
    objectSchema(["type", "sheetId", "row", "height"], {
      type: { const: "resize_row" }, sheetId: sheetIdSchema, row: { type: "integer", minimum: 0, maximum: SPREADSHEET_LIMITS.maxRows - 1 }, height: { type: ["number", "null"], minimum: 18, maximum: 300 },
    }),
    objectSchema(["type", "sheetId", "range", "keyColumn", "direction", "hasHeader"], {
      type: { const: "sort_range" }, sheetId: sheetIdSchema, range: rangeSchema, keyColumn: { type: "integer", minimum: 0, maximum: SPREADSHEET_LIMITS.maxColumns - 1 }, direction: { type: "string", enum: ["ascending", "descending"] }, hasHeader: { type: "boolean" },
    }),
    objectSchema(["type", "sheetId", "filter"], {
      type: { const: "set_filter" }, sheetId: sheetIdSchema,
      filter: filterSchema,
    }),
    objectSchema(["type", "sheetId"], { type: { const: "clear_filter" }, sheetId: sheetIdSchema }),
  ],
};

const operationsSchema: JsonObject = {
  type: "array",
  minItems: 1,
  maxItems: SPREADSHEET_LIMITS.maxOperations,
  items: operationSchema,
};

const workbookSessionInputSchema: JsonObject = {
  oneOf: [
    objectSchema(["action", "expectedRevision", "commandId"], {
      action: { const: "new" },
      expectedRevision: revisionSchema,
      commandId: commandIdSchema,
      discardDirty: { type: "boolean" },
    }),
    objectSchema(["action", "expectedRevision", "commandId"], {
      action: { const: "demo" },
      expectedRevision: revisionSchema,
      commandId: commandIdSchema,
      discardDirty: { type: "boolean" },
    }),
    objectSchema(["action", "expectedRevision", "commandId", "path"], {
      action: { const: "open" },
      expectedRevision: revisionSchema,
      commandId: commandIdSchema,
      path: { type: "string", minLength: 1, maxLength: 240 },
      discardDirty: { type: "boolean" },
      csvTyping: { type: "string", enum: ["text", "conservative"] },
    }),
    objectSchema(["action", "expectedRevision", "commandId"], {
      action: { const: "recover" },
      expectedRevision: revisionSchema,
      commandId: commandIdSchema,
      discardDirty: { type: "boolean" },
    }),
    objectSchema(["action", "expectedRevision", "commandId"], {
      action: { const: "discard_recovery" },
      expectedRevision: revisionSchema,
      commandId: commandIdSchema,
    }),
  ],
};

const workbookApplyInputSchema: JsonObject = {
  oneOf: [
    objectSchema(["action", "expectedRevision", "commandId", "operations"], {
      action: { const: "apply" },
      expectedRevision: revisionSchema,
      commandId: commandIdSchema,
      operations: operationsSchema,
      dryRun: { type: "boolean" },
    }),
    objectSchema(["action", "expectedRevision", "commandId", "expectedHistoryId"], {
      action: { const: "undo" },
      expectedRevision: revisionSchema,
      commandId: commandIdSchema,
      expectedHistoryId: { type: "string", minLength: 1, maxLength: 200 },
    }),
    objectSchema(["action", "expectedRevision", "commandId", "expectedHistoryId"], {
      action: { const: "redo" },
      expectedRevision: revisionSchema,
      commandId: commandIdSchema,
      expectedHistoryId: { type: "string", minLength: 1, maxLength: 200 },
    }),
  ],
};

const workbookHelpInputSchema: JsonObject = {
  oneOf: [
    objectSchema([], {}),
    ...(["overview", "formulas", "errors", "operations", "files", "concurrency"] as const).map((topic) =>
      objectSchema(["topic"], { topic: { const: topic } })),
    objectSchema(["topic"], {
      topic: { const: "functions" },
      query: { type: "string", minLength: 1, maxLength: 80 },
      category: { type: "string", enum: [...FORMULA_CATEGORIES] },
    }),
    objectSchema(["topic", "functionName"], {
      topic: { const: "function" },
      functionName: { type: "string", minLength: 1, maxLength: 64 },
    }),
  ],
};

const saveBaseProperties = {
  expectedRevision: revisionSchema,
  commandId: commandIdSchema,
  path: { type: "string", minLength: 1, maxLength: 240 },
} satisfies Record<string, JsonValue>;
const csvExportProperties = {
  ...saveBaseProperties,
  format: { const: "csv" },
  sheetId: sheetIdSchema,
  range: rangeSchema,
  csvInjectionPolicy: { type: "string", enum: ["exact", "safe"] },
  bom: { type: "boolean" },
} satisfies Record<string, JsonValue>;

const workbookSaveInputSchema: JsonObject = {
  oneOf: [
    objectSchema(["action", "expectedRevision", "commandId"], {
      action: { const: "native" },
      ...saveBaseProperties,
    }),
    objectSchema(["action", "expectedRevision", "commandId", "format", "path"], {
      action: { const: "export_preflight" },
      ...saveBaseProperties,
      format: { const: "xlsx" },
    }),
    objectSchema(
      ["action", "expectedRevision", "commandId", "format", "path", "sheetId", "csvInjectionPolicy"],
      { action: { const: "export_preflight" }, ...csvExportProperties },
    ),
    objectSchema(["action", "expectedRevision", "commandId", "format", "path", "preflightToken"], {
      action: { const: "export_commit" },
      ...saveBaseProperties,
      format: { const: "xlsx" },
      preflightToken: { type: "string", minLength: 16, maxLength: 128 },
    }),
    objectSchema(
      ["action", "expectedRevision", "commandId", "format", "path", "sheetId", "csvInjectionPolicy", "preflightToken"],
      {
        action: { const: "export_commit" },
        ...csvExportProperties,
        preflightToken: { type: "string", minLength: 16, maxLength: 128 },
      },
    ),
  ],
};

const FORMULA_SIGNATURES = {
  MATCH: {
    minimumArguments: 3,
    maximumArguments: 3,
    matchType: { argumentIndex: 3, required: true, supportedValues: [0] },
  },
  XLOOKUP: {
    minimumArguments: 3,
    maximumArguments: 6,
    matchMode: { argumentIndex: 5, required: false, defaultValue: 0, supportedValues: [0] },
    searchMode: { argumentIndex: 6, required: false, defaultValue: 1, supportedValues: [1] },
  },
  VLOOKUP: {
    minimumArguments: 4,
    maximumArguments: 4,
    rangeLookup: { argumentIndex: 4, required: true, supportedValues: [false] },
  },
} as const;

export const WORKBOOK_CAPABILITIES = {
  version: 1,
  operations: [...WORKBOOK_OPERATION_NAMES],
  formulaFunctions: [...SUPPORTED_FORMULA_FUNCTIONS],
  formulaSignatures: FORMULA_SIGNATURES,
  javascriptFunctions: false,
  losslessFormat: "nsheet",
  snapshotFormats: ["xlsx", "csv"],
  csvInjectionPolicies: ["exact", "safe"],
  limits: { ...SPREADSHEET_LIMITS },
  concurrency: {
    optimisticRevision: true,
    idempotentCommandIds: true,
    historyHeadRequired: true,
    atomicOperationBatches: true,
  },
} as const;

const nullableRevisionSchema: JsonObject = { type: ["integer", "null"], minimum: 0 };
const nullableStringSchema: JsonObject = { type: ["string", "null"] };
const stringArraySchema: JsonObject = { type: "array", items: { type: "string" } };
const numericRecordSchema: JsonObject = { type: "object", additionalProperties: { type: "number" } };
const binaryFileMetadataSchema: JsonObject = objectSchema(
  ["path", "mediaType", "byteLength", "etag"],
  {
    path: { type: "string", minLength: 1 },
    mediaType: { type: "string", minLength: 1 },
    byteLength: { type: "integer", minimum: 0 },
    etag: { type: "string" },
    updatedAt: { type: "number" },
  },
);
const sheetStatusSchema: JsonObject = objectSchema(
  ["id", "name", "usedRange", "cellCount", "filter", "hiddenRowCount", "columnWidths", "rowHeights"],
  {
    id: sheetIdSchema,
    name: { type: "string", minLength: 1, maxLength: 31 },
    usedRange: { oneOf: [{ type: "null" }, rangeSchema] },
    cellCount: { type: "integer", minimum: 0, maximum: SPREADSHEET_LIMITS.maxCells },
    filter: { oneOf: [{ type: "null" }, filterSchema] },
    hiddenRowCount: { type: "integer", minimum: 0, maximum: SPREADSHEET_LIMITS.maxRows },
    columnWidths: { type: "object", additionalProperties: { type: "number", minimum: 24, maximum: 600 } },
    rowHeights: { type: "object", additionalProperties: { type: "number", minimum: 18, maximum: 300 } },
  },
);
const historyStatusSchema: JsonObject = objectSchema(["entries", "bytes", "maxEntries", "maxBytes"], {
  entries: { type: "integer", minimum: 0, maximum: SPREADSHEET_LIMITS.maxUndoEntries },
  bytes: { type: "integer", minimum: 0, maximum: SPREADSHEET_LIMITS.maxUndoBytes },
  maxEntries: { const: SPREADSHEET_LIMITS.maxUndoEntries },
  maxBytes: { const: SPREADSHEET_LIMITS.maxUndoBytes },
});
const nativeSourceSchema: JsonObject = objectSchema(["path", "etag", "mediaType"], {
  path: { type: "string", minLength: 1 },
  etag: { type: "string" },
  mediaType: { type: "string" },
});
const importProvenanceSchema: JsonObject = objectSchema(["path", "etag", "format", "warnings"], {
  path: { type: "string", minLength: 1 },
  etag: { type: "string" },
  format: { type: "string", enum: ["csv", "xlsx"] },
  warnings: stringArraySchema,
});
const recoveryStatusSchema: JsonObject = objectSchema(
  ["available", "pending", "savedAt", "revision", "degraded", "error"],
  {
    available: { type: "boolean" },
    pending: { type: "boolean" },
    savedAt: { type: ["number", "null"] },
    revision: nullableRevisionSchema,
    degraded: { type: "boolean" },
    error: nullableStringSchema,
  },
);
const sessionStatusRequired = [
  "revision", "workbookId", "sheets", "canUndo", "canRedo", "undoHistoryId", "redoHistoryId",
  "history", "dirty", "lastSavedRevision", "nativeSource", "importProvenance", "recovery", "saving",
];
const sessionStatusProperties: Record<string, JsonValue> = {
  revision: revisionSchema,
  workbookId: { type: "string", minLength: 1, maxLength: 128 },
  sheets: { type: "array", maxItems: SPREADSHEET_LIMITS.maxSheets, items: sheetStatusSchema },
  canUndo: { type: "boolean" },
  canRedo: { type: "boolean" },
  undoHistoryId: nullableStringSchema,
  redoHistoryId: nullableStringSchema,
  history: historyStatusSchema,
  dirty: { type: "boolean" },
  lastSavedRevision: nullableRevisionSchema,
  nativeSource: { oneOf: [{ type: "null" }, nativeSourceSchema] },
  importProvenance: { oneOf: [{ type: "null" }, importProvenanceSchema] },
  recovery: recoveryStatusSchema,
  saving: { type: "boolean" },
};
const sessionStatusSchema: JsonObject = objectSchema(sessionStatusRequired, sessionStatusProperties);
const capabilitiesSchema: JsonObject = objectSchema(
  ["version", "operations", "formulaFunctions", "formulaSignatures", "javascriptFunctions", "losslessFormat", "snapshotFormats", "csvInjectionPolicies", "limits", "concurrency"],
  {
    version: { const: 1 },
    operations: {
      type: "array",
      minItems: WORKBOOK_OPERATION_NAMES.length,
      maxItems: WORKBOOK_OPERATION_NAMES.length,
      uniqueItems: true,
      items: { type: "string", enum: [...WORKBOOK_OPERATION_NAMES] },
    },
    formulaFunctions: {
      type: "array",
      minItems: SUPPORTED_FORMULA_FUNCTIONS.length,
      maxItems: SUPPORTED_FORMULA_FUNCTIONS.length,
      uniqueItems: true,
      items: { type: "string", enum: [...SUPPORTED_FORMULA_FUNCTIONS] },
    },
    formulaSignatures: objectSchema(["MATCH", "XLOOKUP", "VLOOKUP"], {
      MATCH: objectSchema(["minimumArguments", "maximumArguments", "matchType"], {
        minimumArguments: { const: 3 },
        maximumArguments: { const: 3 },
        matchType: objectSchema(["argumentIndex", "required", "supportedValues"], {
          argumentIndex: { const: 3 },
          required: { const: true },
          supportedValues: { type: "array", minItems: 1, maxItems: 1, items: { const: 0 } },
        }),
      }),
      XLOOKUP: objectSchema(["minimumArguments", "maximumArguments", "matchMode", "searchMode"], {
        minimumArguments: { const: 3 },
        maximumArguments: { const: 6 },
        matchMode: objectSchema(["argumentIndex", "required", "defaultValue", "supportedValues"], {
          argumentIndex: { const: 5 },
          required: { const: false },
          defaultValue: { const: 0 },
          supportedValues: { type: "array", minItems: 1, maxItems: 1, items: { const: 0 } },
        }),
        searchMode: objectSchema(["argumentIndex", "required", "defaultValue", "supportedValues"], {
          argumentIndex: { const: 6 },
          required: { const: false },
          defaultValue: { const: 1 },
          supportedValues: { type: "array", minItems: 1, maxItems: 1, items: { const: 1 } },
        }),
      }),
      VLOOKUP: objectSchema(["minimumArguments", "maximumArguments", "rangeLookup"], {
        minimumArguments: { const: 4 },
        maximumArguments: { const: 4 },
        rangeLookup: objectSchema(["argumentIndex", "required", "supportedValues"], {
          argumentIndex: { const: 4 },
          required: { const: true },
          supportedValues: { type: "array", minItems: 1, maxItems: 1, items: { const: false } },
        }),
      }),
    }),
    javascriptFunctions: { const: false },
    losslessFormat: { const: "nsheet" },
    snapshotFormats: { type: "array", minItems: 2, maxItems: 2, uniqueItems: true, items: { type: "string", enum: ["xlsx", "csv"] } },
    csvInjectionPolicies: { type: "array", minItems: 2, maxItems: 2, uniqueItems: true, items: { type: "string", enum: ["exact", "safe"] } },
    limits: objectSchema(
      ["maxSheets", "maxRows", "maxColumns", "maxCells", "maxStyles", "maxDimensionOverrides", "maxOperations", "maxTouchedCells", "maxReadCells", "maxReadBytes", "maxUndoEntries", "maxUndoBytes", "maxIdempotencyEntries", "maxFormulaLength", "maxTextLength", "maxNativeBytes"],
      {
        maxSheets: { const: SPREADSHEET_LIMITS.maxSheets },
        maxRows: { const: SPREADSHEET_LIMITS.maxRows },
        maxColumns: { const: SPREADSHEET_LIMITS.maxColumns },
        maxCells: { const: SPREADSHEET_LIMITS.maxCells },
        maxStyles: { const: SPREADSHEET_LIMITS.maxStyles },
        maxDimensionOverrides: { const: SPREADSHEET_LIMITS.maxDimensionOverrides },
        maxOperations: { const: SPREADSHEET_LIMITS.maxOperations },
        maxTouchedCells: { const: SPREADSHEET_LIMITS.maxTouchedCells },
        maxReadCells: { const: SPREADSHEET_LIMITS.maxReadCells },
        maxReadBytes: { const: SPREADSHEET_LIMITS.maxReadBytes },
        maxUndoEntries: { const: SPREADSHEET_LIMITS.maxUndoEntries },
        maxUndoBytes: { const: SPREADSHEET_LIMITS.maxUndoBytes },
        maxIdempotencyEntries: { const: SPREADSHEET_LIMITS.maxIdempotencyEntries },
        maxFormulaLength: { const: SPREADSHEET_LIMITS.maxFormulaLength },
        maxTextLength: { const: SPREADSHEET_LIMITS.maxTextLength },
        maxNativeBytes: { const: SPREADSHEET_LIMITS.maxNativeBytes },
      },
    ),
    concurrency: objectSchema(
      ["optimisticRevision", "idempotentCommandIds", "historyHeadRequired", "atomicOperationBatches"],
      {
        optimisticRevision: { const: true },
        idempotentCommandIds: { const: true },
        historyHeadRequired: { const: true },
        atomicOperationBatches: { const: true },
      },
    ),
  },
);
const workbookStatusOutputSchema: JsonObject = objectSchema(
  [...sessionStatusRequired, "capabilities"],
  { ...sessionStatusProperties, capabilities: capabilitiesSchema },
);
const sessionMutationRequired = [...sessionStatusRequired, "commandId", "previousRevision"];
const sessionMutationProperties: Record<string, JsonValue> = {
  ...sessionStatusProperties,
  commandId: commandIdSchema,
  previousRevision: revisionSchema,
};
const sessionMutationOutputSchema: JsonObject = {
  oneOf: [
    objectSchema(sessionMutationRequired, sessionMutationProperties),
    objectSchema([...sessionMutationRequired, "recoveryDisposition"], {
      ...sessionMutationProperties,
      recoveryDisposition: {
        type: "string",
        enum: ["source_exact", "source_changed", "source_deleted", "no_source"],
      },
    }),
  ],
};
const computedCellSchema: JsonObject = {
  oneOf: [
    objectSchema(["kind", "value"], { kind: { const: "blank" }, value: { type: "null" } }),
    objectSchema(["kind", "value"], { kind: { const: "value" }, value: { type: ["string", "number", "boolean"] } }),
    objectSchema(["kind", "code", "message"], {
      kind: { const: "error" },
      code: { type: "string", enum: ["#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#CYCLE!"] },
      message: { type: "string" },
    }),
  ],
};
const readCellSchema: JsonObject = objectSchema(["address", "raw", "computed", "display"], {
  address: cellAddressSchema,
  raw: cellInputSchema,
  computed: computedCellSchema,
  display: { type: "string" },
  style: styleSchema,
});
const workbookReadOutputSchema: JsonObject = objectSchema(
  ["workbookId", "sheetId", "sheetName", "range", "revision", "cells", "hiddenRows", "nextCursor"],
  {
    workbookId: { type: "string", minLength: 1, maxLength: 128 },
    sheetId: sheetIdSchema,
    sheetName: { type: "string", minLength: 1, maxLength: 31 },
    range: rangeSchema,
    revision: revisionSchema,
    cells: { type: "array", maxItems: SPREADSHEET_LIMITS.maxReadCells, items: readCellSchema },
    hiddenRows: {
      type: "array",
      maxItems: SPREADSHEET_LIMITS.maxReadCells,
      items: { type: "integer", minimum: 1, maximum: SPREADSHEET_LIMITS.maxRows },
    },
    nextCursor: { type: ["string", "null"], maxLength: 1_024 },
  },
);
const workbookFindOutputSchema: JsonObject = objectSchema(["workbookId", "revision", "matches", "truncated", "nextCursor"], {
  workbookId: { type: "string", minLength: 1, maxLength: 128 },
  revision: revisionSchema,
  matches: {
    type: "array",
    maxItems: 500,
    items: objectSchema(["sheetId", "sheetName", "address", "raw", "display"], {
      sheetId: sheetIdSchema,
      sheetName: { type: "string", minLength: 1, maxLength: 31 },
      address: cellAddressSchema,
      raw: { type: "string" },
      display: { type: "string" },
    }),
  },
  truncated: { type: "boolean" },
  nextCursor: { type: ["string", "null"], maxLength: 128 },
});
const formulaFunctionHelpSchema: JsonObject = objectSchema(
  ["name", "category", "syntax", "summary", "example", "minimumArguments", "maximumArguments", "notes"],
  {
    name: { type: "string", enum: [...SUPPORTED_FORMULA_FUNCTIONS] },
    category: { type: "string", enum: [...FORMULA_CATEGORIES] },
    syntax: { type: "string", minLength: 1, maxLength: 240 },
    summary: { type: "string", minLength: 1, maxLength: 240 },
    example: { type: "string", minLength: 2, maxLength: SPREADSHEET_LIMITS.maxFormulaLength, pattern: "^=" },
    minimumArguments: { type: "integer", minimum: 0, maximum: 255 },
    maximumArguments: { type: "integer", minimum: 0, maximum: 255 },
    notes: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 320 } },
  },
);
const workbookHelpOutputSchema: JsonObject = objectSchema(
  ["version", "topic", "title", "summary", "sections", "functions", "relatedTopics"],
  {
    version: { const: 1 },
    topic: { type: "string", enum: [...WORKBOOK_HELP_TOPICS] },
    title: { type: "string", minLength: 1, maxLength: 120 },
    summary: { type: "string", minLength: 1, maxLength: 320 },
    sections: {
      type: "array",
      maxItems: 16,
      items: objectSchema(["heading", "items"], {
        heading: { type: "string", minLength: 1, maxLength: 120 },
        items: { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 640 } },
      }),
    },
    functions: { type: "array", maxItems: SUPPORTED_FORMULA_FUNCTIONS.length, items: formulaFunctionHelpSchema },
    relatedTopics: {
      type: "array",
      maxItems: WORKBOOK_HELP_TOPICS.length,
      uniqueItems: true,
      items: { type: "string", enum: [...WORKBOOK_HELP_TOPICS] },
    },
  },
);
const resolvedOperationSchema: JsonObject = objectSchema(["type"], {
  type: { type: "string", enum: [...WORKBOOK_OPERATION_NAMES] },
  range: rangeSchema,
  sourceRange: rangeSchema,
  destinationRange: rangeSchema,
  strategy: { type: "string", enum: ["auto", "copy", "linear", "repeat"] },
  mode: { type: "string", enum: ["all", "values"] },
});
const applyResultSchema: JsonObject = objectSchema(
  ["commandId", "revision", "previousRevision", "historyId", "touchedCells", "operationCount", "dryRun", "noChange", "resolved"],
  {
    commandId: commandIdSchema,
    revision: revisionSchema,
    previousRevision: revisionSchema,
    historyId: { type: ["string", "null"] },
    touchedCells: { type: "integer", minimum: 0, maximum: SPREADSHEET_LIMITS.maxTouchedCells },
    operationCount: { type: "integer", minimum: 1, maximum: SPREADSHEET_LIMITS.maxOperations },
    dryRun: { type: "boolean" },
    noChange: { type: "boolean" },
    resolved: { type: "array", minItems: 1, maxItems: SPREADSHEET_LIMITS.maxOperations, items: resolvedOperationSchema },
  },
);
const historyResultSchema: JsonObject = objectSchema(
  ["commandId", "revision", "previousRevision", "historyId", "action"],
  {
    commandId: commandIdSchema,
    revision: revisionSchema,
    previousRevision: revisionSchema,
    historyId: { type: "string", minLength: 1 },
    action: { type: "string", enum: ["undo", "redo"] },
  },
);
const workbookApplyOutputSchema: JsonObject = { oneOf: [applyResultSchema, historyResultSchema] };
const warningsSchema: JsonObject = { type: "array", items: { type: "string" } };
const nativeSaveResultSchema: JsonObject = objectSchema(
  ["action", "commandId", "revision", "savedRevision", "dirty", "file"],
  {
    action: { const: "native" },
    commandId: commandIdSchema,
    revision: revisionSchema,
    savedRevision: revisionSchema,
    dirty: { type: "boolean" },
    file: binaryFileMetadataSchema,
  },
);
const exportPreflightResultSchema: JsonObject = objectSchema(
  ["action", "commandId", "revision", "format", "path", "preflightToken", "expiresAt", "byteLength", "warnings", "losses"],
  {
    action: { const: "export_preflight" },
    commandId: commandIdSchema,
    revision: revisionSchema,
    format: { type: "string", enum: ["xlsx", "csv"] },
    path: { type: "string", minLength: 1 },
    preflightToken: { type: "string", minLength: 16, maxLength: 128 },
    expiresAt: { type: "number" },
    byteLength: { type: "integer", minimum: 0, maximum: SPREADSHEET_LIMITS.maxNativeBytes },
    warnings: warningsSchema,
    losses: numericRecordSchema,
  },
);
const exportCommitResultSchema: JsonObject = objectSchema(
  ["action", "commandId", "revision", "format", "file", "warnings", "losses"],
  {
    action: { const: "export_commit" },
    commandId: commandIdSchema,
    revision: revisionSchema,
    format: { type: "string", enum: ["xlsx", "csv"] },
    file: binaryFileMetadataSchema,
    warnings: warningsSchema,
    losses: numericRecordSchema,
  },
);
const workbookSaveOutputSchema: JsonObject = {
  oneOf: [nativeSaveResultSchema, exportPreflightResultSchema, exportCommitResultSchema],
};

export const SPREADSHEET_TOOL_OUTPUT_SCHEMAS = {
  workbook_help: workbookHelpOutputSchema,
  workbook_status: workbookStatusOutputSchema,
  workbook_session: sessionMutationOutputSchema,
  workbook_read: workbookReadOutputSchema,
  workbook_find: workbookFindOutputSchema,
  workbook_apply: workbookApplyOutputSchema,
  workbook_save: workbookSaveOutputSchema,
  workbook_accept_file: sessionStatusSchema,
} satisfies Record<string, JsonObject>;

const sessionPromise = WorkbookSession.open({
  files: new NeutronFilesPort(),
  xlsx: new BrowserXlsxCodec(),
});
void sessionPromise.catch((error) => console.error("[Spreadsheet] failed to start", error));
void sessionPromise.then((session) => session.subscribe((status) => {
  void publishAppStateChange(STATE_TOPIC, status.revision).catch(() => {});
}));

exposeTool(
  "workbook_help",
  {
    title: "Get Spreadsheet Help",
    description: "Get concise, structured documentation about Spreadsheet capabilities, formula syntax and supported functions, formula errors, operations, Files formats, and revision-safe agent workflows. Call with no arguments for the overview; this reads static help and never inspects or changes the workbook.",
    inputSchema: workbookHelpInputSchema,
    outputSchema: SPREADSHEET_TOOL_OUTPUT_SCHEMAS.workbook_help,
    annotations: { "neutron:effects": ["read"] },
  },
  async (args, context) => {
    throwIfContextAborted(context.signal);
    const topic = optionalEnum(args.topic, WORKBOOK_HELP_TOPICS) ?? "overview";
    let request: WorkbookHelpRequest;
    if (topic === "functions") {
      const query = optionalString(args.query);
      const category = optionalEnum(args.category, FORMULA_CATEGORIES);
      request = {
        topic,
        ...(query !== undefined ? { query } : {}),
        ...(category !== undefined ? { category } : {}),
      };
    } else if (topic === "function") {
      request = { topic, functionName: requiredString(args.functionName, "functionName") };
    } else {
      request = { topic } as WorkbookHelpRequest;
    }
    return asJson(getWorkbookHelp(request));
  },
);

exposeTool(
  "workbook_status",
  {
    title: "Inspect Workbook",
    description: "Get workbook revision, sheets, used ranges, active filters and hidden-row counts, source, dirty/recovery state, undo/redo heads, and the machine-readable capability/limit contract.",
    inputSchema: objectSchema([], {}),
    outputSchema: SPREADSHEET_TOOL_OUTPUT_SCHEMAS.workbook_status,
    annotations: { "neutron:effects": ["read"] },
  },
  async (_args, context) => {
    throwIfContextAborted(context.signal);
    const session = await sessionPromise;
    throwIfContextAborted(context.signal);
    return asJson({ ...session.status(), capabilities: WORKBOOK_CAPABILITIES });
  },
);

exposeTool(
  "workbook_session",
  {
    title: "Manage Workbook Session",
    description: "Create, open, load the static Kitchen Sink feature gallery, recover, or discard recovery with revision and command-id conflict protection. Replacing dirty work requires discardDirty true.",
    inputSchema: workbookSessionInputSchema,
    outputSchema: SPREADSHEET_TOOL_OUTPUT_SCHEMAS.workbook_session,
    annotations: { "neutron:effects": ["read", "write"] },
  },
  async (args, context) => {
    throwIfContextAborted(context.signal);
    const session = await sessionPromise;
    throwIfContextAborted(context.signal);
    const action = requiredString(args.action, "action");
    const expectedRevision = requiredInteger(args.expectedRevision, "expectedRevision");
    const commandId = requiredString(args.commandId, "commandId");
    if (action === "new") {
      const discardDirty = optionalBoolean(args.discardDirty);
      return asJson(await session.newWorkbook({
        expectedRevision,
        commandId,
        ...(discardDirty !== undefined ? { discardDirty } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      }));
    }
    if (action === "demo") {
      const discardDirty = optionalBoolean(args.discardDirty);
      return asJson(await session.loadDemo({
        expectedRevision,
        commandId,
        ...(discardDirty !== undefined ? { discardDirty } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      }));
    }
    if (action === "recover") {
      const discardDirty = optionalBoolean(args.discardDirty);
      return asJson(await session.recoverDraft({
        expectedRevision,
        commandId,
        ...(discardDirty !== undefined ? { discardDirty } : {}),
        getDelegationToken: () => requestAttachmentDelegation(context),
        ...(context.signal ? { signal: context.signal } : {}),
      }));
    }
    if (action === "discard_recovery") return asJson(await session.discardRecovery({
      expectedRevision,
      commandId,
      ...(context.signal ? { signal: context.signal } : {}),
    }));
    if (action === "open") {
      const discardDirty = optionalBoolean(args.discardDirty);
      const csvTyping = optionalEnum(args.csvTyping, ["text", "conservative"] as const);
      return asJson(await session.openPath(requiredString(args.path, "path"), {
        expectedRevision,
        commandId,
        ...(discardDirty !== undefined ? { discardDirty } : {}),
        ...(csvTyping !== undefined ? { csvTyping } : {}),
        getDelegationToken: () => requestAttachmentDelegation(context),
        ...(context.signal ? { signal: context.signal } : {}),
      }));
    }
    throw new Error("action is invalid");
  },
);

exposeTool(
  "workbook_read",
  {
    title: "Read Workbook Range",
    description: "Read an explicit sheet/range as tagged raw, computed, display, and optional style values. By default blank positions are included; set includeBlanks false for sparse rendering while still following nextCursor across every scanned position. Follow nextCursor for bounded pages and require the same workbookId + revision on every page.",
    inputSchema: objectSchema(["sheetId", "range"], {
      sheetId: sheetIdSchema, range: rangeSchema,
      cursor: { type: "string", maxLength: 1_024 },
      limit: { type: "integer", minimum: 1, maximum: SPREADSHEET_LIMITS.maxReadCells },
      includeBlanks: { type: "boolean" },
    }),
    outputSchema: SPREADSHEET_TOOL_OUTPUT_SCHEMAS.workbook_read,
    annotations: { "neutron:effects": ["read"] },
  },
  async (args, context) => {
    throwIfContextAborted(context.signal);
    const cursor = optionalString(args.cursor);
    const limit = optionalInteger(args.limit);
    const includeBlanks = optionalBoolean(args.includeBlanks);
    const session = await sessionPromise;
    throwIfContextAborted(context.signal);
    return asJson(session.readRange(
      requiredString(args.sheetId, "sheetId"),
      requiredString(args.range, "range"),
      {
        ...(cursor !== undefined ? { cursor } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(includeBlanks !== undefined ? { includeBlanks } : {}),
      },
    ));
  },
);

exposeTool(
  "workbook_find",
  {
    title: "Find Workbook Values",
    description: "Find display values or raw formulas without changing the workbook. Follow nextCursor for bounded pages and require the same workbookId + revision on every page.",
    inputSchema: objectSchema(["query"], {
      query: { type: "string", maxLength: 1_024 }, sheetId: sheetIdSchema,
      formulas: { type: "boolean" }, caseSensitive: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: 500 },
      cursor: { type: "string", maxLength: 128 },
    }),
    outputSchema: SPREADSHEET_TOOL_OUTPUT_SCHEMAS.workbook_find,
    annotations: { "neutron:effects": ["read"] },
  },
  async (args, context) => {
    throwIfContextAborted(context.signal);
    const sheetId = optionalString(args.sheetId);
    const formulas = optionalBoolean(args.formulas);
    const caseSensitive = optionalBoolean(args.caseSensitive);
    const limit = optionalInteger(args.limit);
    const cursor = optionalString(args.cursor);
    const session = await sessionPromise;
    throwIfContextAborted(context.signal);
    return asJson(session.find(requiredString(args.query, "query", true), {
      ...(sheetId !== undefined ? { sheetId } : {}),
      ...(formulas !== undefined ? { formulas } : {}),
      ...(caseSensitive !== undefined ? { caseSensitive } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    }));
  },
);

exposeTool(
  "workbook_apply",
  {
    title: "Apply Workbook Command",
    description: "Dry-run or atomically apply explicit operations, or undo/redo the named current history head. Uses revision and command-id conflict protection.",
    inputSchema: workbookApplyInputSchema,
    outputSchema: SPREADSHEET_TOOL_OUTPUT_SCHEMAS.workbook_apply,
    annotations: { "neutron:effects": ["write"] },
  },
  async (args, context) => {
    throwIfContextAborted(context.signal);
    const session = await sessionPromise;
    throwIfContextAborted(context.signal);
    const action = requiredString(args.action, "action");
    const revision = requiredInteger(args.expectedRevision, "expectedRevision");
    const commandId = requiredString(args.commandId, "commandId");
    const historyId = requireHistoryId(action, optionalString(args.expectedHistoryId));
    if (action === "undo") return asJson(await session.undo(revision, commandId, historyId!, context.signal));
    if (action === "redo") return asJson(await session.redo(revision, commandId, historyId!, context.signal));
    if (action !== "apply") throw new Error("action is invalid");
    const operations = requiredObjectArray(args.operations, "operations") as unknown as WorkbookOperation[];
    const dryRun = optionalBoolean(args.dryRun);
    const actor = commandActorForCaller(context.caller);
    const request: ApplyRequest = {
      expectedRevision: revision,
      commandId,
      operations,
      actor,
      ...(dryRun !== undefined ? { dryRun } : {}),
    };
    return asJson(await session.apply(request, context.signal));
  },
);

exposeTool(
  "workbook_save",
  {
    title: "Save or Export Workbook",
    description: "Save lossless .nsheet, or preflight then commit a new XLSX/CSV snapshot. Export commit must echo the token and exact options; exports never mark clean or replace a file.",
    inputSchema: workbookSaveInputSchema,
    outputSchema: SPREADSHEET_TOOL_OUTPUT_SCHEMAS.workbook_save,
    annotations: { "neutron:effects": ["write"] },
  },
  async (args, context) => {
    throwIfContextAborted(context.signal);
    const session = await sessionPromise;
    throwIfContextAborted(context.signal);
    const action = requiredString(args.action, "action");
    const expectedRevision = requiredInteger(args.expectedRevision, "expectedRevision");
    const commandId = requiredString(args.commandId, "commandId");
    if (action === "native") {
      const path = optionalString(args.path);
      return asJson(await session.saveNative({
        expectedRevision,
        commandId,
        ...(path !== undefined ? { path } : {}),
        getDelegationToken: () => requestAttachmentDelegation(context),
        ...(context.signal ? { signal: context.signal } : {}),
      }));
    }
    if (action !== "export_preflight" && action !== "export_commit") throw new Error("action is invalid");
    const format = optionalEnum(args.format, ["xlsx", "csv"] as const);
    if (!format) {
      if (action === "export_commit") throw new SessionError("PREFLIGHT_STALE", "Export commit must echo the preflight format");
      throw new Error("format is required for export actions");
    }
    const path = optionalString(args.path);
    if (!path) {
      if (action === "export_commit") throw new SessionError("PREFLIGHT_STALE", "Export commit must echo the preflight path");
      throw new Error("path is required for export actions");
    }
    const sheetId = optionalString(args.sheetId);
    const range = optionalString(args.range);
    const csvInjectionPolicy = optionalEnum(args.csvInjectionPolicy, ["exact", "safe"] as const);
    const bom = optionalBoolean(args.bom);
    const exportOptions = {
      expectedRevision,
      commandId,
      format,
      path,
      ...(sheetId !== undefined ? { sheetId } : {}),
      ...(range !== undefined ? { range } : {}),
      ...(csvInjectionPolicy !== undefined ? { csvInjectionPolicy } : {}),
      ...(bom !== undefined ? { bom } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
    };
    if (action === "export_preflight") return asJson(await session.preflightExport(exportOptions));
    const preflightToken = optionalString(args.preflightToken);
    if (!preflightToken) throw new SessionError("PREFLIGHT_STALE", "Export commit requires its preflight token");
    return asJson(await session.commitExport({
      ...exportOptions,
      preflightToken,
      getDelegationToken: () => requestAttachmentDelegation(context),
    }));
  },
);

exposeAttachmentTool(
  "workbook_accept_file",
  {
    title: "Open File in Spreadsheet",
    description: "Files-only binary handoff for .nsheet, .xlsx, and .csv. Refuses to replace a dirty workbook.",
    inputSchema: objectSchema(["path", "mediaType", "etag"], {
      path: { type: "string", minLength: 1, maxLength: 240 },
      mediaType: { type: "string", minLength: 3, maxLength: 160 },
      etag: { type: "string", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" },
    }),
    outputSchema: SPREADSHEET_TOOL_OUTPUT_SCHEMAS.workbook_accept_file,
    annotations: { "neutron:effects": ["read", "write"] },
    attachments: {
      version: 1,
      input: {
        name: "file",
        mediaTypes: [
          NATIVE_MIME,
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "text/csv",
          "application/octet-stream",
        ],
        maxBytes: 16 * 1024 * 1024,
        required: true,
      },
    },
  },
  async (args, attachments, context) => {
    if (context.caller?.appId !== "files" || context.caller.role !== "tile") {
      const error = new Error("workbook_accept_file is restricted to the Files tile");
      Object.defineProperty(error, "code", { value: "CALLER_NOT_ALLOWED", enumerable: true });
      throw error;
    }
    const path = requiredString(args.path, "path");
    if (!/\.(?:nsheet|xlsx|csv)$/i.test(path)) {
      throw new SessionError("FILE_HANDOFF_INVALID", "Files may hand off only .nsheet, .xlsx, or .csv files");
    }
    const attachment = attachments[0]!;
    return {
      value: asJson(await (await sessionPromise).acceptFile({
        path,
        mediaType: requiredString(args.mediaType, "mediaType"),
        etag: requiredString(args.etag, "etag"),
        attachmentMediaType: attachment.mediaType,
        byteLength: attachment.byteLength,
        data: attachment.data,
      })),
      attachments: [],
    };
  },
);

function objectSchema(required: string[], properties: Record<string, JsonValue>): JsonObject {
  return { type: "object", required, properties, additionalProperties: false };
}

function requiredString(value: JsonValue | undefined, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value)) throw new Error(`${name} must be a${allowEmpty ? "" : " non-empty"} string`);
  return value;
}

function optionalString(value: JsonValue | undefined): string | undefined {
  return value === undefined ? undefined : requiredString(value, "value", true);
}

function optionalBoolean(value: JsonValue | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error("Expected a boolean");
  return value;
}

function optionalInteger(value: JsonValue | undefined): number | undefined {
  if (value === undefined) return undefined;
  return requiredInteger(value, "value");
}

function requiredInteger(value: JsonValue | undefined, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${name} must be a non-negative integer`);
  return value as number;
}

function optionalEnum<T extends string>(value: JsonValue | undefined, options: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !options.includes(value as T)) throw new Error(`Expected one of ${options.join(", ")}`);
  return value as T;
}

function requiredObjectArray(value: JsonValue | undefined, name: string): JsonObject[] {
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) throw new Error(`${name} must be an array of objects`);
  return value as JsonObject[];
}

function asJson(value: unknown): JsonValue { return value as JsonValue; }

export async function requestAttachmentDelegation(context: MsgBusToolContext): Promise<string | undefined> {
  throwIfContextAborted(context.signal);
  let response: JsonValue;
  try {
    response = await context.kernel.callTool({
      target: "kernel" as MsgBusEndpointId,
      name: "attachments.delegate",
      arguments: {},
    }, 5);
  } catch (error) {
    // Scoped kernel policy and cancellation errors are part of the public
    // machine-readable contract. Only a genuinely uncoded bridge failure is
    // translated to the local delegation-required capability error.
    if (serviceErrorCode(error) !== undefined || isAbortError(error)) throw error;
    throwIfContextAborted(context.signal);
    // This app and its binary transport ship with the delegation bridge.
    // Missing/failed delegation must never become an unscoped Files call.
    const required = new Error("The kernel could not delegate this invocation to binary Files I/O");
    Object.defineProperty(required, "code", { value: "ATTACHMENT_DELEGATION_REQUIRED", enumerable: true });
    throw required;
  }
  throwIfContextAborted(context.signal);
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("Kernel returned an invalid attachment delegation response");
  }
  const token = response.token;
  const expiresAt = response.expiresAt;
  if (token === null && expiresAt === null) {
    return undefined;
  }
  if (typeof token !== "string" || !token || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    throw new Error("Kernel returned an invalid attachment delegation token");
  }
  if (expiresAt <= Date.now()) throw new Error("Kernel attachment delegation token is already expired");
  return token;
}

function throwIfContextAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason: unknown = signal.reason;
  if (serviceErrorCode(reason) !== undefined) throw reason;
  throw new SessionError("REQUEST_CANCELLED", "Spreadsheet operation was cancelled");
}

function serviceErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 && code.length <= 80 ? code : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
