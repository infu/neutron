import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  SUPPORTED_FORMULA_FUNCTIONS,
  findUnsupportedFormulaFunctions,
  validateFormulaSyntax,
} from "../formula.ts";

export const XLSX_LIMITS = {
  maxArchiveBytes: 16 * 1024 * 1024,
  maxEntries: 512,
  maxExpandedBytes: 64 * 1024 * 1024,
  maxPartBytes: 32 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxSheets: 50,
  maxCells: 250_000,
  maxTextBytes: 256 * 1024,
  maxFormulaLength: 8_192,
  maxStyles: 4_096,
} as const;

export type XlsxScalar = string | number | boolean | null;

export type XlsxInput =
  | { kind: "blank" }
  | { kind: "text"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "error"; value: string }
  | { kind: "formula"; source: string; cached?: XlsxScalar };

export type XlsxCellStyle = {
  numberFormat?: string;
  bold?: boolean;
  italic?: boolean;
  textColor?: string;
  fillColor?: string;
  horizontal?: "left" | "center" | "right";
  wrap?: boolean;
};

export type XlsxCell = {
  row: number;
  column: number;
  input: XlsxInput;
  style?: XlsxCellStyle;
};

export type XlsxSheet = {
  id: string;
  name: string;
  cells: XlsxCell[];
};

export type XlsxWorkbook = {
  dateSystem: 1900 | 1904;
  sheets: XlsxSheet[];
};

export type XlsxCompatibilityWarning = {
  code: string;
  count: number;
  locations: string[];
};

export type XlsxImportResult = {
  workbook: XlsxWorkbook;
  warnings: XlsxCompatibilityWarning[];
};

type ZipEntryInfo = {
  name: string;
  compressedBytes: number;
  expandedBytes: number;
};

type ParsedStyleTable = {
  cellStyles: XlsxCellStyle[];
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const supportedFormulaFunctionSet = new Set<string>(SUPPORTED_FORMULA_FUNCTIONS);

const BUILTIN_NUMBER_FORMATS = new Map<number, string>([
  [0, "General"],
  [1, "0"],
  [2, "0.00"],
  [3, "#,##0"],
  [4, "#,##0.00"],
  [9, "0%"],
  [10, "0.00%"],
  [14, "mm-dd-yy"],
  [15, "d-mmm-yy"],
  [16, "d-mmm"],
  [17, "mmm-yy"],
  [18, "h:mm AM/PM"],
  [19, "h:mm:ss AM/PM"],
  [20, "h:mm"],
  [21, "h:mm:ss"],
  [22, "m/d/yy h:mm"],
  [49, "@"],
]);

export function importXlsx(input: ArrayBuffer | Uint8Array): XlsxImportResult {
  const bytes = asBytes(input);
  const directory = inspectZipDirectory(bytes);
  const files = unzipSync(bytes);
  validateExpandedFiles(directory, files);

  const workbookXml = requiredXml(files, "xl/workbook.xml");
  const relationshipsXml = requiredXml(
    files,
    "xl/_rels/workbook.xml.rels",
  );
  assertNoForbiddenWorkbookFeatures(files, workbookXml, relationshipsXml);
  const relationTargets = parseRelationships(relationshipsXml);
  const sharedStrings = files["xl/sharedStrings.xml"]
    ? parseSharedStrings(decodeXml(files["xl/sharedStrings.xml"]!))
    : [];
  const styles = files["xl/styles.xml"]
    ? parseStyleTable(decodeXml(files["xl/styles.xml"]!))
    : { cellStyles: [] };

  const warningMap = new Map<
    string,
    { count: number; locations: Set<string> }
  >();
  const warn = (code: string, location?: string): void => {
    const current = warningMap.get(code) ?? {
      count: 0,
      locations: new Set<string>(),
    };
    current.count += 1;
    if (location && current.locations.size < 20) current.locations.add(location);
    warningMap.set(code, current);
  };

  scanUnsupportedParts(files, workbookXml, warn);
  const dateSystem: 1900 | 1904 =
    /<workbookPr\b[^>]*\bdate1904="(?:1|true)"/iu.test(workbookXml)
      ? 1904
      : 1900;
  const sheetRecords = parseWorkbookSheets(workbookXml);
  if (sheetRecords.length === 0) throw xlsxError("XLSX_NO_SHEETS");
  if (sheetRecords.length > XLSX_LIMITS.maxSheets) {
    throw xlsxError(
      "XLSX_LIMIT",
      `Workbook exceeds ${XLSX_LIMITS.maxSheets} sheets`,
    );
  }

  let totalCells = 0;
  const sheets = sheetRecords.map((record, index): XlsxSheet => {
    if (record.state && record.state !== "visible") {
      warn("XLSX_HIDDEN_SHEET", record.name);
    }
    const target = relationTargets.get(record.relationshipId);
    if (!target) {
      throw xlsxError(
        "XLSX_RELATIONSHIP",
        `Missing worksheet relationship for ${record.name}`,
      );
    }
    const part = resolveWorkbookTarget(target);
    const xml = requiredXml(files, part);
    const cells = parseWorksheet(
      xml,
      record.name,
      sharedStrings,
      styles,
      warn,
    );
    totalCells += cells.length;
    if (totalCells > XLSX_LIMITS.maxCells) {
      throw xlsxError(
        "XLSX_LIMIT",
        `Workbook exceeds ${XLSX_LIMITS.maxCells} populated cells`,
      );
    }
    return {
      id: `sheet-${index + 1}`,
      name: record.name,
      cells,
    };
  });

  return {
    workbook: { dateSystem, sheets },
    warnings: [...warningMap.entries()]
      .map(([code, value]) => ({
        code,
        count: value.count,
        locations: [...value.locations],
      }))
      .sort((left, right) => left.code.localeCompare(right.code)),
  };
}

export function exportXlsx(workbook: XlsxWorkbook): Uint8Array {
  validateExportWorkbook(workbook);
  const styleBundle = buildStyleXml(workbook);
  const sheetFiles: Record<string, Uint8Array> = {};
  const sheetRelationships: string[] = [];
  const sheetElements: string[] = [];
  const contentOverrides: string[] = [];

  workbook.sheets.forEach((sheet, index) => {
    const number = index + 1;
    const part = `xl/worksheets/sheet${number}.xml`;
    sheetFiles[part] = strToU8(
      buildWorksheetXml(sheet, styleBundle.styleIndexes),
    );
    sheetElements.push(
      `<sheet name="${escapeXml(sheet.name)}" sheetId="${number}" r:id="rId${number}"/>`,
    );
    sheetRelationships.push(
      `<Relationship Id="rId${number}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${number}.xml"/>`,
    );
    contentOverrides.push(
      `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    );
  });

  const stylesRelationshipId = workbook.sheets.length + 1;
  sheetRelationships.push(
    `<Relationship Id="rId${stylesRelationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
  );

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      xmlDocument(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${contentOverrides.join("")}</Types>`,
      ),
    ),
    "_rels/.rels": strToU8(
      xmlDocument(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      ),
    ),
    "xl/workbook.xml": strToU8(
      xmlDocument(
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="${workbook.dateSystem === 1904 ? "1" : "0"}"/><sheets>${sheetElements.join("")}</sheets><calcPr calcId="191029" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>`,
      ),
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      xmlDocument(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRelationships.join("")}</Relationships>`,
      ),
    ),
    "xl/styles.xml": strToU8(styleBundle.xml),
    ...sheetFiles,
  };

  const zipped = zipSync(files, { level: 6 });
  if (zipped.byteLength > XLSX_LIMITS.maxArchiveBytes) {
    throw xlsxError(
      "XLSX_LIMIT",
      `Export exceeds ${XLSX_LIMITS.maxArchiveBytes} bytes`,
    );
  }
  return zipped;
}

function inspectZipDirectory(bytes: Uint8Array): ZipEntryInfo[] {
  if (bytes.byteLength === 0 || bytes.byteLength > XLSX_LIMITS.maxArchiveBytes) {
    throw xlsxError("XLSX_LIMIT", "XLSX archive size is outside the allowed range");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimum = Math.max(0, bytes.byteLength - 65_557);
  let eocd = -1;
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw xlsxError("XLSX_ZIP", "ZIP directory is missing");
  const disk = view.getUint16(eocd + 4, true);
  const directoryDisk = view.getUint16(eocd + 6, true);
  const entries = view.getUint16(eocd + 10, true);
  const directoryBytes = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (
    disk !== 0 ||
    directoryDisk !== 0 ||
    entries === 0xffff ||
    directoryOffset + directoryBytes > eocd
  ) {
    throw xlsxError("XLSX_ZIP", "ZIP64 and multi-disk archives are unsupported");
  }
  if (entries === 0 || entries > XLSX_LIMITS.maxEntries) {
    throw xlsxError(
      "XLSX_LIMIT",
      `Archive has ${entries} entries; limit is ${XLSX_LIMITS.maxEntries}`,
    );
  }

  let offset = directoryOffset;
  let expandedTotal = 0;
  const names = new Set<string>();
  const result: ZipEntryInfo[] = [];
  for (let index = 0; index < entries; index += 1) {
    if (
      offset + 46 > eocd ||
      view.getUint32(offset, true) !== 0x02014b50
    ) {
      throw xlsxError("XLSX_ZIP", "ZIP central directory is malformed");
    }
    const flags = view.getUint16(offset + 8, true);
    const compression = view.getUint16(offset + 10, true);
    const compressedBytes = view.getUint32(offset + 20, true);
    const expandedBytes = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > eocd) throw xlsxError("XLSX_ZIP", "ZIP entry is truncated");
    if ((flags & 1) !== 0) throw xlsxError("XLSX_ENCRYPTED");
    if (compression !== 0 && compression !== 8) {
      throw xlsxError("XLSX_ZIP", `Unsupported ZIP method ${compression}`);
    }
    const name = textDecoder.decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );
    validatePartName(name);
    if (names.has(name)) throw xlsxError("XLSX_ZIP", "Duplicate ZIP part");
    names.add(name);
    if (expandedBytes > XLSX_LIMITS.maxPartBytes) {
      throw xlsxError("XLSX_LIMIT", `Part is too large: ${name}`);
    }
    expandedTotal += expandedBytes;
    if (expandedTotal > XLSX_LIMITS.maxExpandedBytes) {
      throw xlsxError("XLSX_LIMIT", "Expanded workbook is too large");
    }
    if (
      expandedBytes > 1024 * 1024 &&
      compressedBytes > 0 &&
      expandedBytes / compressedBytes > XLSX_LIMITS.maxCompressionRatio
    ) {
      throw xlsxError("XLSX_LIMIT", `Suspicious compression ratio: ${name}`);
    }
    result.push({ name, compressedBytes, expandedBytes });
    offset = end;
  }
  return result;
}

function validateExpandedFiles(
  directory: ZipEntryInfo[],
  files: Record<string, Uint8Array>,
): void {
  const byName = new Map(directory.map((entry) => [entry.name, entry]));
  for (const [name, bytes] of Object.entries(files)) {
    const metadata = byName.get(name);
    if (!metadata || metadata.expandedBytes !== bytes.byteLength) {
      throw xlsxError("XLSX_ZIP", `Expanded part mismatch: ${name}`);
    }
  }
}

function validatePartName(name: string): void {
  if (
    !name ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.split("/").some((part) => part === "..") ||
    /[\u0000-\u001f\u007f]/u.test(name)
  ) {
    throw xlsxError("XLSX_ZIP", "Unsafe ZIP part name");
  }
}

function parseWorkbookSheets(xml: string): Array<{
  name: string;
  relationshipId: string;
  state?: string;
}> {
  const result: Array<{
    name: string;
    relationshipId: string;
    state?: string;
  }> = [];
  for (const match of xml.matchAll(/<sheet\b([^>]*)\/?>/giu)) {
    const attributes = parseAttributes(match[1] ?? "");
    const name = attributes.get("name");
    const relationshipId = attributes.get("r:id");
    if (!name || !relationshipId) continue;
    result.push({
      name,
      relationshipId,
      ...(attributes.get("state") ? { state: attributes.get("state")! } : {}),
    });
  }
  return result;
}

function parseRelationships(xml: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?>/giu)) {
    const attributes = parseAttributes(match[1] ?? "");
    const id = attributes.get("Id");
    const target = attributes.get("Target");
    if (id && target) result.set(id, target);
  }
  return result;
}

function resolveWorkbookTarget(target: string): string {
  const raw = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  const resolved: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  return resolved.join("/");
}

function parseSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/giu)].map((match) =>
    collectTextNodes(match[1] ?? ""),
  );
}

function parseStyleTable(xml: string): ParsedStyleTable {
  const customFormats = new Map<number, string>();
  for (const match of xml.matchAll(/<numFmt\b([^>]*)\/?>/giu)) {
    const attributes = parseAttributes(match[1] ?? "");
    const id = Number(attributes.get("numFmtId"));
    const code = attributes.get("formatCode");
    if (Number.isSafeInteger(id) && code) customFormats.set(id, code);
  }

  const fonts = parseSectionBlocks(xml, "fonts", "font").map((block) => ({
    bold: /<b\b/iu.test(block),
    italic: /<i\b/iu.test(block),
    textColor: parseColor(block),
  }));
  const fills = parseSectionBlocks(xml, "fills", "fill").map((block) =>
    parseColor(block),
  );
  const xfs = parseSectionBlocks(xml, "cellXfs", "xf");
  if (xfs.length > XLSX_LIMITS.maxStyles) {
    throw xlsxError("XLSX_LIMIT", "Workbook has too many styles");
  }
  const cellStyles = xfs.map((block): XlsxCellStyle => {
    const open = block.match(/^<xf\b([^>]*)/iu)?.[1] ?? "";
    const attributes = parseAttributes(open);
    const numberFormatId = Number(attributes.get("numFmtId") ?? 0);
    const fontId = Number(attributes.get("fontId") ?? 0);
    const fillId = Number(attributes.get("fillId") ?? 0);
    const alignmentSource = block.match(/<alignment\b([^>]*)\/?>/iu)?.[1];
    const alignment = alignmentSource
      ? parseAttributes(alignmentSource)
      : new Map<string, string>();
    const font = fonts[fontId];
    const fillColor = fills[fillId];
    const numberFormat =
      customFormats.get(numberFormatId) ??
      BUILTIN_NUMBER_FORMATS.get(numberFormatId);
    const horizontal = alignment.get("horizontal");
    return compactStyle({
      ...(numberFormat ? { numberFormat } : {}),
      ...(font?.bold ? { bold: true } : {}),
      ...(font?.italic ? { italic: true } : {}),
      ...(font?.textColor ? { textColor: font.textColor } : {}),
      ...(fillColor ? { fillColor } : {}),
      ...(horizontal === "left" ||
      horizontal === "center" ||
      horizontal === "right"
        ? { horizontal }
        : {}),
      ...(alignment.get("wrapText") === "1" ||
      alignment.get("wrapText") === "true"
        ? { wrap: true }
        : {}),
    });
  });
  return { cellStyles };
}

function parseWorksheet(
  xml: string,
  sheetName: string,
  sharedStrings: string[],
  styles: ParsedStyleTable,
  warn: (code: string, location?: string) => void,
): XlsxCell[] {
  const result: XlsxCell[] = [];
  for (const match of xml.matchAll(
    /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/giu,
  )) {
    const attributes = parseAttributes(match[1] ?? "");
    const reference = attributes.get("r");
    if (!reference) continue;
    const address = parseCellReference(reference);
    if (!address) {
      warn("XLSX_INVALID_CELL", `${sheetName}!${reference}`);
      continue;
    }
    const location = `${sheetName}!${reference}`;
    const body = match[2] ?? "";
    const styleIndex = Number(attributes.get("s") ?? 0);
    const style =
      Number.isSafeInteger(styleIndex) && styleIndex >= 0
        ? styles.cellStyles[styleIndex]
        : undefined;
    const formulaMatch = body.match(
      /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/iu,
    );
    let input: XlsxInput;
    if (formulaMatch) {
      const formulaAttributes = parseAttributes(formulaMatch[1] ?? "");
      const formulaKind = caseInsensitiveAttribute(formulaAttributes, "t")
        ?.toLocaleLowerCase("en-US");
      if (formulaKind === "array") {
        throw xlsxError(
          "XLSX_ARRAY_FORMULA",
          `Array formulas require an explicit flatten policy: ${location}`,
        );
      }
      if (formulaKind === "shared") {
        throw xlsxError(
          "XLSX_SHARED_FORMULA",
          `Shared formulas require expansion before import: ${location}`,
        );
      }
      if (formulaMatch[2] === undefined) {
        throw xlsxError(
          "XLSX_FORMULA",
          `Formula source is missing: ${location}`,
        );
      }
      const encodedSource = `=${decodeXmlText(formulaMatch[2] ?? "")}`;
      if (encodedSource.length > XLSX_LIMITS.maxFormulaLength) {
        throw xlsxError("XLSX_LIMIT", `Formula is too long: ${location}`);
      }
      const source = normalizeSupportedCompatibilityFunctions(encodedSource);
      if (hasExternalWorkbookFormulaReference(source)) {
        throw xlsxError(
          "XLSX_EXTERNAL_LINK",
          `External workbook formula links are not supported: ${location}`,
        );
      }
      const unsupportedFunctions = findUnsupportedFormulaFunctions(source);
      if (unsupportedFunctions.length > 0) {
        throw xlsxError(
          "UNSUPPORTED_FEATURES",
          `Unsupported XLSX formula function${unsupportedFunctions.length === 1 ? "" : "s"} ${unsupportedFunctions.join(", ")} require an explicit flatten policy: ${location}`,
        );
      }
      try {
        validateFormulaSyntax(source);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Invalid formula syntax";
        throw xlsxError(
          "UNSUPPORTED_FEATURES",
          `Unsupported XLSX formula syntax requires an explicit flatten policy: ${location} (${detail})`,
        );
      }
      const cached = parseCachedValue(body, attributes.get("t"));
      input = {
        kind: "formula",
        source,
        ...(cached !== undefined ? { cached } : {}),
      };
    } else {
      input = parseCellInput(body, attributes.get("t"), sharedStrings, location);
    }
    result.push({
      row: address.row,
      column: address.column,
      input,
      ...(style && Object.keys(style).length > 0 ? { style } : {}),
    });
  }
  return result;
}

function parseCellInput(
  body: string,
  type: string | undefined,
  sharedStrings: string[],
  location: string,
): XlsxInput {
  if (type === "inlineStr") {
    return checkedTextInput(collectTextNodes(body), location);
  }
  const raw = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/iu)?.[1];
  if (raw === undefined) return { kind: "blank" };
  const value = decodeXmlText(raw);
  if (type === "s") {
    const index = Number(value);
    if (!Number.isSafeInteger(index) || sharedStrings[index] === undefined) {
      throw xlsxError("XLSX_SHARED_STRING", `Invalid shared string: ${location}`);
    }
    return checkedTextInput(sharedStrings[index]!, location);
  }
  if (type === "str") return checkedTextInput(value, location);
  if (type === "b") return { kind: "boolean", value: value === "1" };
  if (type === "e") return { kind: "error", value };
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return checkedTextInput(value, location);
  }
  return { kind: "number", value: number };
}

function parseCachedValue(
  body: string,
  type: string | undefined,
): XlsxScalar | undefined {
  const raw = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/iu)?.[1];
  if (raw === undefined) return undefined;
  const value = decodeXmlText(raw);
  if (type === "str") return value;
  if (type === "b") return value === "1";
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
}

function checkedTextInput(value: string, location: string): XlsxInput {
  if (textEncoder.encode(value).byteLength > XLSX_LIMITS.maxTextBytes) {
    throw xlsxError("XLSX_LIMIT", `Cell text is too long: ${location}`);
  }
  return { kind: "text", value };
}

function hasExternalWorkbookFormulaReference(source: string): boolean {
  const quoted = /'(?:[^']|'')*\[[^\]\r\n]+\](?:[^']|'')*'!/u;
  const unquoted = /(?:^|[=+\-*/^&(,<>\s])\[[^\]\r\n]+\][A-Za-z0-9_.]+!/u;
  return quoted.test(source) || unquoted.test(source);
}

/**
 * Excel writes newer worksheet functions with an `_xlfn.` compatibility
 * prefix. Remove it only for functions this evaluator already supports; an
 * unknown prefixed function remains unknown and follows the explicit import
 * rejection path below. Quoted formula text and sheet names stay untouched.
 */
function normalizeSupportedCompatibilityFunctions(source: string): string {
  let output = "";
  let index = 0;
  while (index < source.length) {
    const character = source[index]!;
    if (character === '"' || character === "'") {
      const quote = character;
      output += quote;
      index += 1;
      while (index < source.length) {
        const quoted = source[index]!;
        output += quoted;
        index += 1;
        if (quoted !== quote) continue;
        if (source[index] === quote) {
          output += quote;
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    const boundary = index === 0 || !/[A-Za-z0-9_.]/u.test(source[index - 1]!);
    const match = boundary
      ? /^_xlfn\.([A-Za-z_][A-Za-z0-9_.]*)/iu.exec(source.slice(index))
      : null;
    if (match) {
      let following = index + match[0].length;
      while (following < source.length && /\s/u.test(source[following]!)) following += 1;
      const name = match[1]!.toUpperCase();
      if (source[following] === "(" && supportedFormulaFunctionSet.has(name)) {
        output += name;
        index += match[0].length;
        continue;
      }
    }
    output += character;
    index += 1;
  }
  return output;
}

function assertNoForbiddenWorkbookFeatures(
  files: Record<string, Uint8Array>,
  workbookXml: string,
  workbookRelationshipsXml: string,
): void {
  const names = Object.keys(files);
  const macroPart = names.find((name) =>
    /(?:^|\/)vbaProject(?:Signature)?\.bin$/iu.test(name) ||
    /^xl\/macrosheets\//iu.test(name)
  );
  if (macroPart) {
    throw xlsxError(
      "XLSX_MACRO",
      `Macro-enabled/VBA workbooks are not supported: ${macroPart}`,
    );
  }

  const externalPart = names.find((name) => /^xl\/externalLinks\//iu.test(name));
  if (externalPart) {
    throw xlsxError(
      "XLSX_EXTERNAL_LINK",
      `External workbook links are not supported: ${externalPart}`,
    );
  }

  const contentTypes = files["[Content_Types].xml"]
    ? decodeXml(files["[Content_Types].xml"]!)
    : "";
  if (/macroEnabled|vbaProject|macroSheet/iu.test(contentTypes)) {
    throw xlsxError(
      "XLSX_MACRO",
      "Macro-enabled/VBA workbook content types are not supported",
    );
  }
  if (/<externalReferences\b/iu.test(workbookXml)) {
    throw xlsxError(
      "XLSX_EXTERNAL_LINK",
      "External workbook references are not supported",
    );
  }

  for (const name of names) {
    if (!name.endsWith(".rels")) continue;
    const relationships = name === "xl/_rels/workbook.xml.rels"
      ? workbookRelationshipsXml
      : decodeXml(files[name]!);
    if (/\/relationships\/vbaProject(?=["'\s>])/iu.test(relationships)) {
      throw xlsxError(
        "XLSX_MACRO",
        `VBA relationships are not supported: ${name}`,
      );
    }
    if (/\/relationships\/externalLink(?:Path)?(?=["'\s>])/iu.test(relationships)) {
      throw xlsxError(
        "XLSX_EXTERNAL_LINK",
        `External workbook relationships are not supported: ${name}`,
      );
    }
  }

  for (const name of names) {
    if (!/^xl\/worksheets\/[^/]+\.xml$/iu.test(name)) continue;
    const xml = decodeXml(files[name]!);
    for (const match of xml.matchAll(/<f\b([^>]*)>/giu)) {
      const attributes = parseAttributes(match[1] ?? "");
      const kind = caseInsensitiveAttribute(attributes, "t")
        ?.toLocaleLowerCase("en-US");
      if (kind === "shared") {
        throw xlsxError(
          "XLSX_SHARED_FORMULA",
          `Shared formulas require expansion before import: ${name}`,
        );
      }
      if (kind === "array") {
        throw xlsxError(
          "XLSX_ARRAY_FORMULA",
          `Array formulas require an explicit flatten policy: ${name}`,
        );
      }
    }
  }
}

function scanUnsupportedParts(
  files: Record<string, Uint8Array>,
  workbookXml: string,
  warn: (code: string, location?: string) => void,
): void {
  const rules: Array<[RegExp, string]> = [
    [/^xl\/charts\//u, "XLSX_CHART"],
    [/^xl\/pivot/u, "XLSX_PIVOT"],
    [/^xl\/drawings\//u, "XLSX_DRAWING"],
    [/^xl\/comments/u, "XLSX_COMMENT"],
    [/^xl\/tables\//u, "XLSX_TABLE"],
  ];
  for (const name of Object.keys(files)) {
    for (const [pattern, code] of rules) {
      if (pattern.test(name)) warn(code, name);
    }
  }
  const workbookRules: Array<[RegExp, string]> = [
    [/<definedNames\b/iu, "XLSX_DEFINED_NAME"],
  ];
  for (const [pattern, code] of workbookRules) {
    if (pattern.test(workbookXml)) warn(code, "workbook");
  }
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.startsWith("xl/worksheets/") || !name.endsWith(".xml")) continue;
    const xml = decodeXml(bytes);
    const sheetRules: Array<[RegExp, string]> = [
      [/<mergeCells\b/iu, "XLSX_MERGED_CELLS"],
      [/<conditionalFormatting\b/iu, "XLSX_CONDITIONAL_FORMATTING"],
      [/<dataValidations\b/iu, "XLSX_DATA_VALIDATION"],
      [/<hyperlinks\b/iu, "XLSX_HYPERLINK"],
      [/<sheetProtection\b/iu, "XLSX_PROTECTION"],
      [/<autoFilter\b/iu, "XLSX_FILTER"],
      [/<col\b[^>]*\bwidth\s*=\s*["'][^"']+["']/iu, "XLSX_COLUMN_WIDTH"],
      [/<pane\b[^>]*\bstate\s*=\s*["'](?:frozen|frozenSplit)["']/iu, "XLSX_FROZEN_PANE"],
      [/<col\b[^>]*\bhidden\s*=\s*["'](?:1|true)["']/iu, "XLSX_HIDDEN_COLUMN"],
      [/<row\b[^>]*\bhidden\s*=\s*["'](?:1|true)["']/iu, "XLSX_HIDDEN_ROW"],
      [/<row\b[^>]*\b(?:customHeight\s*=\s*["'](?:1|true)["']|ht\s*=\s*["'][^"']+["'])/iu, "XLSX_ROW_HEIGHT"],
    ];
    for (const [pattern, code] of sheetRules) {
      if (pattern.test(xml)) warn(code, name);
    }
  }
}

function buildStyleXml(workbook: XlsxWorkbook): {
  xml: string;
  styleIndexes: Map<string, number>;
} {
  const styles = new Map<string, XlsxCellStyle>();
  for (const sheet of workbook.sheets) {
    for (const cell of sheet.cells) {
      if (!cell.style || Object.keys(cell.style).length === 0) continue;
      styles.set(styleKey(cell.style), compactStyle(cell.style));
    }
  }
  if (styles.size > XLSX_LIMITS.maxStyles) {
    throw xlsxError("XLSX_LIMIT", "Workbook has too many styles");
  }
  const entries = [...styles.entries()];
  const styleIndexes = new Map(
    entries.map(([key], index) => [key, index + 1]),
  );
  const customNumberFormats = new Map<string, number>();
  let nextNumberFormat = 164;
  for (const [, style] of entries) {
    const format = style.numberFormat;
    if (
      format &&
      ![...BUILTIN_NUMBER_FORMATS.values()].includes(format) &&
      !customNumberFormats.has(format)
    ) {
      customNumberFormats.set(format, nextNumberFormat++);
    }
  }
  const builtinByCode = new Map(
    [...BUILTIN_NUMBER_FORMATS].map(([id, code]) => [code, id]),
  );
  const numberFormats = [...customNumberFormats]
    .map(
      ([code, id]) =>
        `<numFmt numFmtId="${id}" formatCode="${escapeXml(code)}"/>`,
    )
    .join("");
  const fonts = [
    '<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>',
    ...entries.map(([, style]) =>
      `<font>${style.bold ? "<b/>" : ""}${style.italic ? "<i/>" : ""}<sz val="11"/>${style.textColor ? `<color rgb="FF${normalizeColor(style.textColor).slice(1)}"/>` : '<color theme="1"/>'}<name val="Calibri"/><family val="2"/></font>`,
    ),
  ];
  const fills = [
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
  ];
  const fillIds = new Map<string, number>();
  for (const [, style] of entries) {
    if (!style.fillColor) continue;
    const color = normalizeColor(style.fillColor);
    if (!fillIds.has(color)) {
      fillIds.set(color, fills.length);
      fills.push(
        `<fill><patternFill patternType="solid"><fgColor rgb="FF${color.slice(1)}"/><bgColor indexed="64"/></patternFill></fill>`,
      );
    }
  }
  const xfs = [
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    ...entries.map(([, style], index) => {
      const numberFormatId = style.numberFormat
        ? (builtinByCode.get(style.numberFormat) ??
          customNumberFormats.get(style.numberFormat) ??
          0)
        : 0;
      const alignment =
        style.horizontal || style.wrap
          ? `<alignment${style.horizontal ? ` horizontal="${style.horizontal}"` : ""}${style.wrap ? ' wrapText="1"' : ""}/>`
          : "";
      return `<xf numFmtId="${numberFormatId}" fontId="${index + 1}" fillId="${style.fillColor ? fillIds.get(normalizeColor(style.fillColor)) : 0}" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"${alignment ? ' applyAlignment="1"' : ""}>${alignment}</xf>`;
    }),
  ];
  const xml = xmlDocument(
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${numberFormats ? `<numFmts count="${customNumberFormats.size}">${numberFormats}</numFmts>` : ""}<fonts count="${fonts.length}">${fonts.join("")}</fonts><fills count="${fills.length}">${fills.join("")}</fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  );
  return { xml, styleIndexes };
}

function buildWorksheetXml(
  sheet: XlsxSheet,
  styleIndexes: Map<string, number>,
): string {
  const rows = new Map<number, XlsxCell[]>();
  let maxRow = 0;
  let maxColumn = 0;
  for (const cell of sheet.cells) {
    validateCell(cell);
    const list = rows.get(cell.row) ?? [];
    list.push(cell);
    rows.set(cell.row, list);
    maxRow = Math.max(maxRow, cell.row);
    maxColumn = Math.max(maxColumn, cell.column);
  }
  const rowXml = [...rows.entries()]
    .sort(([left], [right]) => left - right)
    .map(([row, cells]) => {
      const value = cells
        .sort((left, right) => left.column - right.column)
        .map((cell) => buildCellXml(cell, styleIndexes))
        .join("");
      return `<row r="${row + 1}">${value}</row>`;
    })
    .join("");
  const dimension =
    rows.size === 0
      ? "A1"
      : `A1:${formatCellReference(maxRow, maxColumn)}`;
  return xmlDocument(
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${dimension}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData>${rowXml}</sheetData></worksheet>`,
  );
}

function buildCellXml(
  cell: XlsxCell,
  styleIndexes: Map<string, number>,
): string {
  const reference = formatCellReference(cell.row, cell.column);
  const style = cell.style
    ? styleIndexes.get(styleKey(compactStyle(cell.style)))
    : undefined;
  const styleAttribute = style ? ` s="${style}"` : "";
  switch (cell.input.kind) {
    case "blank":
      return `<c r="${reference}"${styleAttribute}/>`;
    case "text":
      return `<c r="${reference}" t="inlineStr"${styleAttribute}><is><t${needsPreserveSpace(cell.input.value) ? ' xml:space="preserve"' : ""}>${escapeXml(cell.input.value)}</t></is></c>`;
    case "number":
      return `<c r="${reference}"${styleAttribute}><v>${cell.input.value}</v></c>`;
    case "boolean":
      return `<c r="${reference}" t="b"${styleAttribute}><v>${cell.input.value ? 1 : 0}</v></c>`;
    case "error":
      return `<c r="${reference}" t="e"${styleAttribute}><v>${escapeXml(cell.input.value)}</v></c>`;
    case "formula": {
      const source = cell.input.source.startsWith("=")
        ? cell.input.source.slice(1)
        : cell.input.source;
      const cached = buildCachedValue(cell.input.cached);
      return `<c r="${reference}"${cached.typeAttribute}${styleAttribute}><f>${escapeXml(source)}</f>${cached.xml}</c>`;
    }
  }
}

function buildCachedValue(value: XlsxScalar | undefined): {
  typeAttribute: string;
  xml: string;
} {
  if (value === undefined || value === null) {
    return { typeAttribute: "", xml: "" };
  }
  if (typeof value === "string") {
    return {
      typeAttribute: ' t="str"',
      xml: `<v>${escapeXml(value)}</v>`,
    };
  }
  if (typeof value === "boolean") {
    return {
      typeAttribute: ' t="b"',
      xml: `<v>${value ? 1 : 0}</v>`,
    };
  }
  return { typeAttribute: "", xml: `<v>${value}</v>` };
}

function validateExportWorkbook(workbook: XlsxWorkbook): void {
  if (workbook.dateSystem !== 1900 && workbook.dateSystem !== 1904) {
    throw xlsxError("XLSX_DATE_SYSTEM");
  }
  if (
    workbook.sheets.length === 0 ||
    workbook.sheets.length > XLSX_LIMITS.maxSheets
  ) {
    throw xlsxError("XLSX_LIMIT", "Workbook sheet count is invalid");
  }
  const names = new Set<string>();
  let cells = 0;
  for (const sheet of workbook.sheets) {
    validateSheetName(sheet.name);
    const key = sheet.name.toLocaleLowerCase("en-US");
    if (names.has(key)) throw xlsxError("XLSX_SHEET_NAME");
    names.add(key);
    cells += sheet.cells.length;
    if (cells > XLSX_LIMITS.maxCells) {
      throw xlsxError("XLSX_LIMIT", "Workbook has too many cells");
    }
    for (const cell of sheet.cells) validateCell(cell);
  }
}

function validateCell(cell: XlsxCell): void {
  if (
    !Number.isSafeInteger(cell.row) ||
    cell.row < 0 ||
    cell.row >= 1_048_576 ||
    !Number.isSafeInteger(cell.column) ||
    cell.column < 0 ||
    cell.column >= 16_384
  ) {
    throw xlsxError("XLSX_CELL_ADDRESS");
  }
  if (cell.input.kind === "number" && !Number.isFinite(cell.input.value)) {
    throw xlsxError("XLSX_NUMBER");
  }
  if (
    cell.input.kind === "formula" &&
    cell.input.source.length > XLSX_LIMITS.maxFormulaLength
  ) {
    throw xlsxError("XLSX_LIMIT", "Formula is too long");
  }
  if (
    cell.input.kind === "text" &&
    textEncoder.encode(cell.input.value).byteLength > XLSX_LIMITS.maxTextBytes
  ) {
    throw xlsxError("XLSX_LIMIT", "Cell text is too long");
  }
}

function validateSheetName(name: string): void {
  if (
    !name ||
    name.length > 31 ||
    /[\\/*?:[\]]/u.test(name) ||
    name.startsWith("'") ||
    name.endsWith("'")
  ) {
    throw xlsxError("XLSX_SHEET_NAME", `Invalid sheet name: ${name}`);
  }
}

function parseCellReference(
  reference: string,
): { row: number; column: number } | null {
  const match = /^([A-Z]{1,4})([1-9]\d*)$/u.exec(reference.toUpperCase());
  if (!match) return null;
  const row = Number(match[2]) - 1;
  let column = 0;
  for (const character of match[1]!) {
    column = column * 26 + character.charCodeAt(0) - 64;
  }
  column -= 1;
  if (row < 0 || row >= 1_048_576 || column < 0 || column >= 16_384) {
    return null;
  }
  return { row, column };
}

function formatCellReference(row: number, column: number): string {
  let current = column + 1;
  let letters = "";
  while (current > 0) {
    const remainder = (current - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    current = Math.floor((current - 1) / 26);
  }
  return `${letters}${row + 1}`;
}

function parseAttributes(source: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of source.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/gu)) {
    result.set(match[1]!, decodeXmlText(match[2]!));
  }
  return result;
}

function caseInsensitiveAttribute(
  attributes: Map<string, string>,
  name: string,
): string | undefined {
  const expected = name.toLocaleLowerCase("en-US");
  for (const [key, value] of attributes) {
    if (key.toLocaleLowerCase("en-US") === expected) return value;
  }
  return undefined;
}

function parseSectionBlocks(
  xml: string,
  sectionName: string,
  childName: string,
): string[] {
  const section = xml.match(
    new RegExp(
      `<${sectionName}\\b[^>]*>([\\s\\S]*?)<\\/${sectionName}>`,
      "iu",
    ),
  )?.[1];
  if (!section) return [];
  return [
    ...section.matchAll(
      new RegExp(
        `<${childName}\\b[^>]*?\\/>|<${childName}\\b[^>]*>[\\s\\S]*?<\\/${childName}>`,
        "giu",
      ),
    ),
  ].map((match) => match[0]);
}

function parseColor(source: string): string | undefined {
  const match = source.match(/<(?:color|fgColor)\b([^>]*)\/?>/iu);
  if (!match) return undefined;
  const attributes = parseAttributes(match[1] ?? "");
  const rgb = attributes.get("rgb");
  if (!rgb || !/^[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(rgb)) return undefined;
  const value = rgb.length === 8 ? rgb.slice(2) : rgb;
  return `#${value.toUpperCase()}`;
}

function collectTextNodes(source: string): string {
  return [...source.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/giu)]
    .map((match) => decodeXmlText(match[1] ?? ""))
    .join("");
}

function requiredXml(
  files: Record<string, Uint8Array>,
  name: string,
): string {
  const value = files[name];
  if (!value) throw xlsxError("XLSX_PART_MISSING", `Missing ${name}`);
  return decodeXml(value);
}

function decodeXml(value: Uint8Array): string {
  try {
    return strFromU8(value);
  } catch {
    throw xlsxError("XLSX_ENCODING");
  }
}

function decodeXmlText(value: string): string {
  return value.replace(
    /&(?:#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/giu,
    (entity) => {
      if (entity === "&amp;") return "&";
      if (entity === "&lt;") return "<";
      if (entity === "&gt;") return ">";
      if (entity === "&quot;") return '"';
      if (entity === "&apos;") return "'";
      const hexadecimal = entity.startsWith("&#x");
      const number = Number.parseInt(
        entity.slice(hexadecimal ? 3 : 2, -1),
        hexadecimal ? 16 : 10,
      );
      return Number.isFinite(number) ? String.fromCodePoint(number) : entity;
    },
  );
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function xmlDocument(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`;
}

function compactStyle(style: XlsxCellStyle): XlsxCellStyle {
  return {
    ...(style.numberFormat ? { numberFormat: style.numberFormat } : {}),
    ...(style.bold ? { bold: true } : {}),
    ...(style.italic ? { italic: true } : {}),
    ...(style.textColor ? { textColor: normalizeColor(style.textColor) } : {}),
    ...(style.fillColor ? { fillColor: normalizeColor(style.fillColor) } : {}),
    ...(style.horizontal ? { horizontal: style.horizontal } : {}),
    ...(style.wrap ? { wrap: true } : {}),
  };
}

function styleKey(style: XlsxCellStyle): string {
  const compact = compactStyle(style);
  return JSON.stringify([
    compact.numberFormat ?? "",
    compact.bold ?? false,
    compact.italic ?? false,
    compact.textColor ?? "",
    compact.fillColor ?? "",
    compact.horizontal ?? "",
    compact.wrap ?? false,
  ]);
}

function normalizeColor(value: string): string {
  const source = value.trim().toUpperCase();
  return /^#[0-9A-F]{6}$/u.test(source) ? source : "#000000";
}

function needsPreserveSpace(value: string): boolean {
  return value !== value.trim() || /\s{2}/u.test(value);
}

function asBytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array
    ? value
    : new Uint8Array(value);
}

function xlsxError(code: string, message = code): Error {
  const error = new Error(message);
  Object.defineProperty(error, "code", {
    configurable: true,
    enumerable: true,
    value: code,
  });
  return error;
}
