export const SPREADSHEET_LIMITS = {
  maxSheets: 50,
  maxRows: 100_000,
  maxColumns: 1_000,
  maxCells: 250_000,
  maxStyles: 4_096,
  // Keeps workbook_status safely below the Neutron message-bus ceiling while
  // still allowing extensive sparse row/column customization.
  maxDimensionOverrides: 20_000,
  maxOperations: 100,
  maxTouchedCells: 50_000,
  maxReadCells: 10_000,
  maxReadBytes: 96 * 1024,
  maxUndoEntries: 100,
  maxUndoBytes: 16 * 1024 * 1024,
  maxIdempotencyEntries: 256,
  maxFormulaLength: 8_192,
  maxTextLength: 32_768,
  maxNativeBytes: 16 * 1024 * 1024,
} as const;

export const NATIVE_FORMAT = "neutron.spreadsheet";
export const NATIVE_VERSION = 1;
export const NATIVE_MIME = "application/vnd.neutron.spreadsheet+json";
export const STATE_TOPIC = "workbook";
