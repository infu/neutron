import { formatCellAddress, parseCellAddress } from "../address.ts";
import type { XlsxCodecPort } from "../file_ports.ts";
import { FormulaBatch } from "../formula.ts";
import {
  createSheet,
  createWorkbook,
  type CellInput,
  type CellStyle,
  type SpreadsheetWorkbook,
} from "../model.ts";
import {
  exportXlsx,
  importXlsx,
  type XlsxCellStyle,
  type XlsxInput,
  type XlsxScalar,
  type XlsxWorkbook,
} from "./xlsx.ts";

export class BrowserXlsxCodec implements XlsxCodecPort {
  async import(data: ArrayBuffer): Promise<{
    workbook: SpreadsheetWorkbook;
    warnings: string[];
  }> {
    const result = importXlsx(data);
    const workbook = createWorkbook();
    workbook.calculation.dateSystem = result.workbook.dateSystem;
    workbook.sheets = result.workbook.sheets.map((source) => {
      const sheet = createSheet(source.name);
      for (const cell of source.cells) {
        const address = formatCellAddress({ row: cell.row, column: cell.column });
        sheet.cells[address] = {
          input: importInput(cell.input),
          ...(cell.style ? { style: importStyle(cell.style) } : {}),
        };
      }
      return sheet;
    });
    workbook.metadata.updatedAt = Date.now();
    return {
      workbook,
      warnings: result.warnings.map(
        (warning) =>
          `${warning.code} (${warning.count})${
            warning.locations.length > 0
              ? ` at ${warning.locations.slice(0, 3).join(", ")}`
              : ""
          }`,
      ),
    };
  }

  async export(workbook: SpreadsheetWorkbook): Promise<{
    data: ArrayBuffer;
    warnings: string[];
    losses: Record<string, number>;
  }> {
    const batch = new FormulaBatch(workbook);
    const data: XlsxWorkbook = {
      dateSystem: workbook.calculation.dateSystem,
      sheets: workbook.sheets.map((sheet) => ({
        id: sheet.id,
        name: sheet.name,
        cells: Object.entries(sheet.cells).map(([address, record]) => {
          const parsed = parseCellAddress(address);
          return {
            row: parsed.row,
            column: parsed.column,
            input: exportInput(
              record.input,
              computedScalar(batch.evaluateCell(sheet.id, address)),
            ),
            ...(record.style ? { style: exportStyle(record.style) } : {}),
          };
        }),
      })),
    };
    const bytes = exportXlsx(data);
    const losses = {
      filtersDropped: workbook.sheets.filter((sheet) => sheet.filter !== undefined).length,
      columnWidthsDropped: workbook.sheets.reduce(
        (count, sheet) => count + Object.keys(sheet.columnWidths ?? {}).length,
        0,
      ),
      rowHeightsDropped: workbook.sheets.reduce(
        (count, sheet) => count + Object.keys(sheet.rowHeights ?? {}).length,
        0,
      ),
    };
    const warnings = Object.entries(losses)
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => `XLSX snapshot omitted ${count} ${kind}.`);
    return {
      data: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
      warnings,
      losses,
    };
  }
}

function importInput(input: XlsxInput): CellInput {
  switch (input.kind) {
    case "blank":
      return { kind: "blank" };
    case "text":
      return { kind: "text", value: input.value };
    case "number":
      return { kind: "number", value: input.value };
    case "boolean":
      return { kind: "boolean", value: input.value };
    case "error":
      // Native cells do not have an error-literal input tag. The formula
      // grammar does, so preserve the error's propagation semantics instead
      // of silently turning it into harmless text.
      return { kind: "formula", formula: `=${input.value}` };
    case "formula":
      return { kind: "formula", formula: input.source };
  }
}

function exportInput(input: CellInput, cached?: XlsxScalar): XlsxInput {
  switch (input.kind) {
    case "blank":
      return { kind: "blank" };
    case "text":
      return { kind: "text", value: input.value };
    case "number":
      return { kind: "number", value: input.value };
    case "boolean":
      return { kind: "boolean", value: input.value };
    case "formula":
      return {
        kind: "formula",
        source: input.formula,
        ...(cached !== undefined ? { cached } : {}),
      };
  }
}

function computedScalar(
  computed: ReturnType<FormulaBatch["evaluateCell"]>,
): XlsxScalar | undefined {
  if (computed.kind === "error") return undefined;
  return computed.value;
}

function importStyle(style: XlsxCellStyle): CellStyle {
  const number = classifyNumberFormat(style.numberFormat);
  return {
    ...number,
    ...(style.bold ? { bold: true } : {}),
    ...(style.italic ? { italic: true } : {}),
    ...(style.textColor ? { textColor: style.textColor } : {}),
    ...(style.fillColor ? { fillColor: style.fillColor } : {}),
    ...(style.horizontal ? { alignment: style.horizontal } : {}),
    ...(style.wrap ? { wrap: true } : {}),
  };
}

function exportStyle(style: CellStyle): XlsxCellStyle {
  return {
    ...(style.numberFormat
      ? { numberFormat: numberFormatCode(style.numberFormat, style.decimals) }
      : {}),
    ...(style.bold ? { bold: true } : {}),
    ...(style.italic ? { italic: true } : {}),
    ...(style.textColor ? { textColor: style.textColor } : {}),
    ...(style.fillColor ? { fillColor: style.fillColor } : {}),
    ...(style.alignment ? { horizontal: style.alignment } : {}),
    ...(style.wrap ? { wrap: true } : {}),
  };
}

function classifyNumberFormat(
  source: string | undefined,
): Pick<CellStyle, "numberFormat" | "decimals"> {
  if (!source || source === "General") return { numberFormat: "general" };
  const normalized = source.toLocaleLowerCase("en-US");
  const decimals = decimalPlaces(source);
  const stripped = normalized
    .replace(/"[^"]*"/gu, "")
    .replace(/\\./gu, "")
    .replace(/\[([hms]+)\]/gu, "$1")
    .replace(/\[[^\]]*\]/gu, "");
  if (stripped.includes("%")) return { numberFormat: "percent", decimals };
  if (/[$€£¥]/u.test(stripped)) return { numberFormat: "currency", decimals };
  // Minutes share Excel's `m` token with months. A time marker (`h`/`s`)
  // disambiguates time-only formats, while `y`/`d` makes a date or datetime.
  if (/[yd]/u.test(stripped)) return { numberFormat: "date" };
  if (/[hs]/u.test(stripped)) return { numberFormat: "time" };
  if (/m/u.test(stripped)) return { numberFormat: "date" };
  return { numberFormat: "number", decimals };
}

function decimalPlaces(source: string): number {
  const match = source.match(/\.([0#]+)/u);
  return Math.min(match?.[1]?.length ?? 0, 12);
}

function numberFormatCode(
  format: NonNullable<CellStyle["numberFormat"]>,
  decimals = format === "number" || format === "currency" ? 2 : 0,
): string {
  const fraction = decimals > 0 ? `.${"0".repeat(decimals)}` : "";
  switch (format) {
    case "general":
      return "General";
    case "number":
      return `#,##0${fraction}`;
    case "currency":
      return `$#,##0${fraction}`;
    case "percent":
      return `0${fraction}%`;
    case "date":
      return "yyyy-mm-dd";
    case "time":
      return "hh:mm:ss";
  }
}
