import {
  formatCellAddress,
  iterateRange,
  parseCellAddress,
  parseRange,
  rangeSize,
  type CellAddress,
} from "./address.ts";
import { SPREADSHEET_LIMITS } from "./constants.ts";
import {
  BLANK,
  type CellRecord,
  type ComputedCell,
  type FormulaErrorCode,
  type SpreadsheetSheet,
  type SpreadsheetWorkbook,
  requireSheet,
} from "./model.ts";

type Scalar = string | number | boolean | null;
type ErrorValue = { error: FormulaErrorCode; message: string };
type RangeValue = {
  range: Array<Scalar | ErrorValue>;
  rows: number;
  columns: number;
  sheet: SpreadsheetSheet;
  start: CellAddress;
};
type ReferenceValue = {
  referenceValue: Scalar | ErrorValue;
  sheet: SpreadsheetSheet;
  address: CellAddress;
};
type FormulaValue = Scalar | ErrorValue | RangeValue | ReferenceValue;
type Token =
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "identifier"; value: string }
  | { type: "reference"; address: string; sheet?: string }
  | { type: "error"; code: FormulaErrorCode }
  | { type: "operator"; value: string }
  | { type: "punctuation"; value: "(" | ")" | "," | ":" }
  | { type: "eof" };

const ERROR = {
  div0: (): ErrorValue => ({ error: "#DIV/0!", message: "Division by zero" }),
  value: (message = "The formula received an incompatible value"): ErrorValue => ({ error: "#VALUE!", message }),
  ref: (message = "The formula refers to an invalid cell"): ErrorValue => ({ error: "#REF!", message }),
  name: (name: string): ErrorValue => ({ error: "#NAME?", message: `Unknown function or name '${name}'` }),
  num: (message = "Invalid numeric result"): ErrorValue => ({ error: "#NUM!", message }),
  na: (message = "No matching value was found"): ErrorValue => ({ error: "#N/A", message }),
  cycle: (): ErrorValue => ({ error: "#CYCLE!", message: "Circular reference" }),
};

export type FormulaBatchOptions = { now?: number };

/**
 * The formula functions this engine can calculate without compatibility loss.
 * Format importers use this same inventory so they cannot admit a function that
 * the live workbook would immediately turn into #NAME?.
 */
export const SUPPORTED_FORMULA_FUNCTIONS = [
  "SUM",
  "AVERAGE",
  "MIN",
  "MAX",
  "COUNT",
  "COUNTA",
  "IF",
  "IFERROR",
  "ROUND",
  "ABS",
  "COUNTIF",
  "SUMIF",
  "XLOOKUP",
  "VLOOKUP",
  "INDEX",
  "MATCH",
  "TEXTJOIN",
  "DATE",
  "TODAY",
  "NOW",
] as const;

const supportedFormulaFunctionSet = new Set<string>(SUPPORTED_FORMULA_FUNCTIONS);

export type SupportedFormulaFunction = (typeof SUPPORTED_FORMULA_FUNCTIONS)[number];
export type FormulaFunctionArity = Readonly<{
  min: number;
  max: number;
  message?: string;
}>;

/**
 * Keep every supported function's callable shape in one place. The parser and
 * evaluator both use this table so an imported formula cannot pass validation
 * and then be interpreted with silently missing or discarded arguments.
 */
export const FORMULA_FUNCTION_ARITIES: Record<SupportedFormulaFunction, FormulaFunctionArity> = {
  SUM: { min: 1, max: 255 },
  AVERAGE: { min: 1, max: 255 },
  MIN: { min: 1, max: 255 },
  MAX: { min: 1, max: 255 },
  COUNT: { min: 1, max: 255 },
  COUNTA: { min: 1, max: 255 },
  IF: { min: 2, max: 3 },
  IFERROR: { min: 2, max: 2 },
  ROUND: { min: 2, max: 2 },
  ABS: { min: 1, max: 1 },
  COUNTIF: { min: 2, max: 2 },
  SUMIF: { min: 2, max: 3 },
  XLOOKUP: { min: 3, max: 6, message: "XLOOKUP requires 3 to 6 arguments" },
  VLOOKUP: { min: 4, max: 4, message: "VLOOKUP requires 4 arguments with FALSE for exact matching" },
  INDEX: { min: 2, max: 3 },
  MATCH: { min: 3, max: 3, message: "MATCH requires 3 arguments with explicit exact match mode 0" },
  TEXTJOIN: { min: 3, max: 254 },
  DATE: { min: 3, max: 3 },
  TODAY: { min: 0, max: 0 },
  NOW: { min: 0, max: 0 },
};

function formulaFunctionArityError(name: SupportedFormulaFunction, count: number): ErrorValue | null {
  const arity = FORMULA_FUNCTION_ARITIES[name];
  if (count >= arity.min && count <= arity.max) return null;
  if (arity.message) return ERROR.value(arity.message);
  if (arity.min === arity.max) {
    if (arity.min === 0) return ERROR.value(`${name} requires no arguments`);
    return ERROR.value(`${name} requires ${arity.min} ${arity.min === 1 ? "argument" : "arguments"}`);
  }
  return ERROR.value(`${name} requires ${arity.min} to ${arity.max} arguments`);
}

export function findUnsupportedFormulaFunctions(source: string): string[] {
  const unsupported = new Set<string>();
  let index = source.startsWith("=") ? 1 : 0;
  while (index < source.length) {
    const character = source[index]!;
    if (character === '"') {
      index = skipFormulaQuotedValue(source, index, '"');
      continue;
    }
    if (character === "'") {
      index = skipFormulaQuotedValue(source, index, "'");
      continue;
    }
    if (!/[A-Za-z_]/u.test(character)) {
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    while (index < source.length && /[A-Za-z0-9_.]/u.test(source[index]!)) index += 1;
    const name = source.slice(start, index).toUpperCase();
    let following = index;
    while (following < source.length && /\s/u.test(source[following]!)) following += 1;
    if (source[following] === "(" && !supportedFormulaFunctionSet.has(name)) unsupported.add(name);
  }
  return [...unsupported].sort((left, right) => left.localeCompare(right));
}

/**
 * Parse a formula using the live engine grammar without resolving cells or
 * calculating function results. Importers use this to reject syntax that the
 * workbook cannot preserve as a live formula.
 */
export function validateFormulaSyntax(source: string): void {
  if (!source.startsWith("=")) throw new Error("A formula must start with '='");
  new FormulaParser(source.slice(1), { syntaxOnly: true }).parse();
}

function skipFormulaQuotedValue(source: string, start: number, quote: '"' | "'"): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] !== quote) {
      index += 1;
      continue;
    }
    if (source[index + 1] === quote) {
      index += 2;
      continue;
    }
    return index + 1;
  }
  return index;
}

export class FormulaBatch {
  private readonly cache = new Map<string, ComputedCell>();
  private readonly evaluating = new Set<string>();
  private readonly now: number;
  private evaluatedReferences = 0;
  private evaluatedCells = 0;
  private evaluationDepth = 0;

  constructor(
    private readonly workbook: SpreadsheetWorkbook,
    options: FormulaBatchOptions = {},
  ) {
    this.now = options.now ?? Date.now();
  }

  evaluateCell(sheetIdOrName: string, address: string): ComputedCell {
    const sheet = requireSheet(this.workbook, sheetIdOrName);
    const normalized = formatCellAddress(parseCellAddress(address));
    const key = `${sheet.id}:${normalized}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    if (this.evaluating.has(key)) return { kind: "error", code: "#CYCLE!", message: "Circular reference" };
    if (this.evaluatedCells >= SPREADSHEET_LIMITS.maxTouchedCells) {
      return { kind: "error", code: "#NUM!", message: "Formula calculation cell limit exceeded" };
    }
    if (this.evaluationDepth >= 512) {
      return { kind: "error", code: "#NUM!", message: "Formula dependency depth limit exceeded" };
    }
    this.evaluatedCells += 1;
    this.evaluationDepth += 1;
    this.evaluating.add(key);
    let result: ComputedCell;
    try {
      const record = sheet.cells[normalized];
      result = this.evaluateRecord(sheet, record);
    } finally {
      this.evaluating.delete(key);
      this.evaluationDepth -= 1;
    }
    this.cache.set(key, result);
    return result;
  }

  displayCell(sheetIdOrName: string, address: string): string {
    const sheet = requireSheet(this.workbook, sheetIdOrName);
    const record = sheet.cells[formatCellAddress(parseCellAddress(address))];
    return formatComputed(
      this.evaluateCell(sheet.id, address),
      record,
      this.workbook.calculation.dateSystem,
    );
  }

  private evaluateRecord(sheet: SpreadsheetSheet, record: CellRecord | undefined): ComputedCell {
    const input = record?.input ?? BLANK;
    switch (input.kind) {
      case "blank": return { kind: "blank", value: null };
      case "text": return { kind: "value", value: input.value };
      case "number": return { kind: "value", value: input.value };
      case "boolean": return { kind: "value", value: input.value };
      case "formula": {
        try {
          const parser = new FormulaParser(input.formula.slice(1), {
            workbook: this.workbook,
            currentSheet: sheet,
            resolve: (targetSheet, address) => this.evaluateCell(targetSheet.id, address),
            consumeReferences: (count) => {
              if (this.evaluatedReferences + count > SPREADSHEET_LIMITS.maxTouchedCells) return false;
              this.evaluatedReferences += count;
              return true;
            },
            now: this.now,
          });
          const parsed = parser.parse();
          const result = isReference(parsed) ? parsed.referenceValue : parsed;
          if (isRange(result)) return { kind: "error", code: "#VALUE!", message: "A range cannot be a cell result" };
          if (isError(result)) return { kind: "error", code: result.error, message: result.message };
          if (result === null) return { kind: "blank", value: null };
          if (typeof result === "number" && !Number.isFinite(result)) {
            return { kind: "error", code: "#NUM!", message: "Formula result is not finite" };
          }
          return { kind: "value", value: result };
        } catch (error) {
          return {
            kind: "error",
            code: "#VALUE!",
            message: error instanceof Error ? error.message : "Invalid formula",
          };
        }
      }
    }
  }
}

type EvaluationParserContext = {
  syntaxOnly?: false;
  workbook: SpreadsheetWorkbook;
  currentSheet: SpreadsheetSheet;
  resolve(sheet: SpreadsheetSheet, address: string): ComputedCell;
  consumeReferences(count: number): boolean;
  now: number;
};

type ParserContext = EvaluationParserContext | { syntaxOnly: true };

class FormulaParser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(source: string, private readonly context: ParserContext) {
    this.tokens = tokenize(source);
  }

  parse(): FormulaValue {
    const value = this.comparison();
    if (this.peek().type !== "eof") throw new Error("Unexpected token at end of formula");
    return value;
  }

  private comparison(): FormulaValue {
    let left = this.concatenation();
    while (this.isOperator("=", "<>", "<", ">", "<=", ">=")) {
      const operator = (this.take() as Extract<Token, { type: "operator" }>).value;
      const right = this.concatenation();
      left = compareValues(left, right, operator);
    }
    return left;
  }

  private concatenation(): FormulaValue {
    let left = this.additive();
    while (this.isOperator("&")) {
      this.take();
      const right = this.additive();
      if (isRange(left) || isRange(right)) return ERROR.value("Cannot concatenate a range");
      const leftScalar = scalar(left);
      const rightScalar = scalar(right);
      if (isError(leftScalar)) return leftScalar;
      if (isError(rightScalar)) return rightScalar;
      left = `${displayScalar(leftScalar)}${displayScalar(rightScalar)}`;
    }
    return left;
  }

  private additive(): FormulaValue {
    let left = this.multiplicative();
    while (this.isOperator("+", "-")) {
      const operator = (this.take() as Extract<Token, { type: "operator" }>).value;
      left = numericBinary(left, this.multiplicative(), operator);
    }
    return left;
  }

  private multiplicative(): FormulaValue {
    let left = this.unary();
    while (this.isOperator("*", "/")) {
      const operator = (this.take() as Extract<Token, { type: "operator" }>).value;
      left = numericBinary(left, this.unary(), operator);
    }
    return left;
  }

  private power(): FormulaValue {
    let left = this.primary();
    if (this.isOperator("^")) {
      this.take();
      left = numericBinary(left, this.unary(), "^");
    }
    return left;
  }

  private unary(): FormulaValue {
    if (this.isOperator("+", "-")) {
      const operator = (this.take() as Extract<Token, { type: "operator" }>).value;
      const value = this.unary();
      const numeric = toNumber(value);
      if (isError(numeric)) return numeric;
      return operator === "-" ? -numeric : numeric;
    }
    return this.power();
  }

  private primary(): FormulaValue {
    const token = this.take();
    if (token.type === "number" || token.type === "string") return token.value;
    if (token.type === "error") return errorLiteral(token.code);
    if (token.type === "reference") {
      if (this.isPunctuation(":")) {
        this.take();
        const end = this.take();
        if (end.type !== "reference") throw new Error("A range must end with a cell reference");
        return this.resolveRange(token, end);
      }
      return this.resolveReference(token);
    }
    if (token.type === "identifier") {
      const upper = token.value.toUpperCase();
      if (upper === "TRUE") return true;
      if (upper === "FALSE") return false;
      if (!this.isPunctuation("(")) {
        if (this.context.syntaxOnly) {
          throw new Error(`Named references are not supported: '${token.value}'`);
        }
        return ERROR.name(token.value);
      }
      this.take();
      const args: FormulaValue[] = [];
      if (!this.isPunctuation(")")) {
        while (true) {
          args.push(this.comparison());
          if (!this.isPunctuation(",")) break;
          this.take();
        }
      }
      this.expectPunctuation(")");
      if (this.context.syntaxOnly) {
        if (!supportedFormulaFunctionSet.has(upper)) throw new Error(`Unknown function '${token.value}'`);
        const arityError = formulaFunctionArityError(upper as SupportedFormulaFunction, args.length);
        if (arityError) throw new Error(arityError.message);
        return null;
      }
      return callFunction(upper, args, this.context);
    }
    if (token.type === "punctuation" && token.value === "(") {
      const value = this.comparison();
      this.expectPunctuation(")");
      return value;
    }
    throw new Error("Expected a value, reference, or function");
  }

  private resolveReference(reference: Extract<Token, { type: "reference" }>): FormulaValue {
    if (this.context.syntaxOnly) return null;
    if (!this.context.consumeReferences(1)) return ERROR.num("Formula calculation reference limit exceeded");
    let sheet: SpreadsheetSheet;
    try {
      sheet = reference.sheet ? requireSheet(this.context.workbook, reference.sheet) : this.context.currentSheet;
    } catch {
      return ERROR.ref(`Sheet '${reference.sheet}' does not exist`);
    }
    return {
      referenceValue: computedToFormulaValue(this.context.resolve(sheet, reference.address)),
      sheet,
      address: parseCellAddress(reference.address),
    };
  }

  private resolveRange(
    start: Extract<Token, { type: "reference" }>,
    end: Extract<Token, { type: "reference" }>,
  ): FormulaValue {
    if (start.sheet && end.sheet && start.sheet.toLowerCase() !== end.sheet.toLowerCase()) {
      return ERROR.ref("A range cannot span sheets");
    }
    const parsedRange = parseRange(`${start.address}:${end.address}`);
    const size = rangeSize(parsedRange);
    if (this.context.syntaxOnly) return null;
    let sheet: SpreadsheetSheet;
    try {
      sheet = start.sheet || end.sheet
        ? requireSheet(this.context.workbook, start.sheet ?? end.sheet!)
        : this.context.currentSheet;
    } catch {
      return ERROR.ref("Range sheet does not exist");
    }
    if (!this.context.consumeReferences(size.cells)) return ERROR.num("Formula calculation reference limit exceeded");
    const values: Array<Scalar | ErrorValue> = [];
    for (const address of iterateRange(parsedRange)) {
      values.push(computedToFormulaValue(this.context.resolve(sheet, formatCellAddress(address))) as Scalar | ErrorValue);
    }
    return {
      range: values,
      rows: size.rows,
      columns: size.columns,
      sheet,
      start: parsedRange.start,
    };
  }

  private expectPunctuation(value: ")"): void {
    if (!this.isPunctuation(value)) throw new Error(`Expected '${value}'`);
    this.take();
  }

  private isPunctuation(value: Token extends never ? never : "(" | ")" | "," | ":"): boolean {
    const token = this.peek();
    return token.type === "punctuation" && token.value === value;
  }

  private isOperator(...values: string[]): boolean {
    const token = this.peek();
    return token.type === "operator" && values.includes(token.value);
  }

  private peek(): Token { return this.tokens[this.index] ?? { type: "eof" }; }
  private take(): Token { return this.tokens[this.index++] ?? { type: "eof" }; }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index]!;
    if (/\s/.test(character)) { index += 1; continue; }
    if (character === '"') {
      let value = "";
      index += 1;
      let closed = false;
      while (index < source.length) {
        if (source[index] === '"') {
          if (source[index + 1] === '"') { value += '"'; index += 2; continue; }
          index += 1;
          closed = true;
          break;
        }
        value += source[index++];
      }
      if (!closed) throw new Error("Unterminated string");
      tokens.push({ type: "string", value });
      continue;
    }
    if (character === "#") {
      const match = /^(#DIV\/0!|#VALUE!|#REF!|#NAME\?|#NUM!|#N\/A|#CYCLE!)/i.exec(source.slice(index));
      if (!match) throw new Error("Unknown formula error literal");
      tokens.push({ type: "error", code: match[1]!.toUpperCase() as FormulaErrorCode });
      index += match[1]!.length;
      continue;
    }
    if (character === "'") {
      let name = "";
      index += 1;
      let closed = false;
      while (index < source.length) {
        if (source[index] === "'") {
          if (source[index + 1] === "'") { name += "'"; index += 2; continue; }
          index += 1;
          closed = true;
          break;
        }
        name += source[index++];
      }
      if (!closed || source[index] !== "!") throw new Error("Invalid quoted sheet reference");
      index += 1;
      const reference = readCellReference(source, index);
      if (!reference) throw new Error("Expected a cell after sheet name");
      tokens.push({ type: "reference", sheet: name, address: reference.address });
      index = reference.end;
      continue;
    }
    const reference = readCellReference(source, index);
    if (reference && isLexicalBoundary(source[index - 1], source[reference.end])) {
      tokens.push({ type: "reference", address: reference.address });
      index = reference.end;
      continue;
    }
    const number = /^(?:\d+\.?\d*|\.\d+)(?:[Ee][+-]?\d+)?/.exec(source.slice(index));
    if (number) {
      const value = Number(number[0]);
      if (!Number.isFinite(value)) throw new Error("Invalid number");
      tokens.push({ type: "number", value });
      index += number[0].length;
      continue;
    }
    const identifier = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(source.slice(index));
    if (identifier) {
      const name = identifier[0];
      const afterName = index + name.length;
      if (source[afterName] === "!") {
        const sheetReference = readCellReference(source, afterName + 1);
        if (!sheetReference) throw new Error("Expected a cell after sheet name");
        tokens.push({ type: "reference", sheet: name, address: sheetReference.address });
        index = sheetReference.end;
      } else {
        tokens.push({ type: "identifier", value: name });
        index = afterName;
      }
      continue;
    }
    const two = source.slice(index, index + 2);
    if (["<=", ">=", "<>"].includes(two)) {
      tokens.push({ type: "operator", value: two });
      index += 2;
      continue;
    }
    if (["+", "-", "*", "/", "^", "&", "=", "<", ">"].includes(character)) {
      tokens.push({ type: "operator", value: character });
      index += 1;
      continue;
    }
    if (["(", ")", ",", ":"].includes(character)) {
      tokens.push({ type: "punctuation", value: character as "(" | ")" | "," | ":" });
      index += 1;
      continue;
    }
    throw new Error(`Unexpected character '${character}'`);
  }
  tokens.push({ type: "eof" });
  return tokens;
}

function errorLiteral(code: FormulaErrorCode): ErrorValue {
  switch (code) {
    case "#DIV/0!": return ERROR.div0();
    case "#VALUE!": return ERROR.value();
    case "#REF!": return ERROR.ref();
    case "#NAME?": return ERROR.name("error literal");
    case "#NUM!": return ERROR.num();
    case "#N/A": return ERROR.na();
    case "#CYCLE!": return ERROR.cycle();
  }
}

function readCellReference(source: string, index: number): { address: string; end: number } | null {
  const match = /^\$?[A-Za-z]{1,3}\$?[1-9][0-9]*/.exec(source.slice(index));
  return match ? { address: match[0]!.replaceAll("$", "").toUpperCase(), end: index + match[0]!.length } : null;
}

function isLexicalBoundary(before: string | undefined, after: string | undefined): boolean {
  return (!before || !/[A-Za-z0-9_.]/.test(before)) && (!after || !/[A-Za-z0-9_]/.test(after));
}

function callFunction(name: string, args: FormulaValue[], context: EvaluationParserContext): FormulaValue {
  if (!supportedFormulaFunctionSet.has(name)) return ERROR.name(name);
  const arityError = formulaFunctionArityError(name as SupportedFormulaFunction, args.length);
  if (arityError) return arityError;
  const all = flatten(args);
  switch (name) {
    case "SUM": return aggregate(numericArguments(args), (values) => values.reduce((sum, value) => sum + value, 0));
    case "AVERAGE": return aggregate(numericArguments(args), (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : ERROR.div0());
    case "MIN": return aggregate(numericArguments(args), (values) => values.length ? Math.min(...values) : 0);
    case "MAX": return aggregate(numericArguments(args), (values) => values.length ? Math.max(...values) : 0);
    case "COUNT": return countFunction(args);
    case "COUNTA": return all.filter((value) => value !== null).length;
    case "IF": {
      const condition = scalar(args[0] ?? null);
      if (isError(condition)) return condition;
      return truthy(condition) ? (args[1] ?? true) : (args[2] ?? false);
    }
    case "IFERROR": return isError(scalar(args[0] ?? null)) ? (args[1] ?? "") : (args[0] ?? null);
    case "ROUND": {
      const value = toNumber(args[0] ?? null);
      const digits = toNumber(args[1] ?? 0);
      if (isError(value)) return value;
      if (isError(digits)) return digits;
      return roundHalfAwayFromZero(value, digits);
    }
    case "ABS": {
      const value = toNumber(args[0] ?? null);
      return isError(value) ? value : Math.abs(value);
    }
    case "COUNTIF": return countIf(args[0], args[1]);
    case "SUMIF": return sumIf(args[0], args[1], args[2], context);
    case "XLOOKUP": return xlookup(args);
    case "VLOOKUP": return vlookup(args);
    case "INDEX": return indexFunction(args);
    case "MATCH": return matchFunction(args);
    case "TEXTJOIN": return textJoin(args);
    case "DATE": return dateFunction(args, context.workbook.calculation.dateSystem);
    case "TODAY": return excelSerialAt(context.now, context.workbook.calculation.dateSystem, false);
    case "NOW": return excelSerialAt(context.now, context.workbook.calculation.dateSystem, true);
    default: return ERROR.name(name);
  }
}

function aggregate(values: number[] | ErrorValue, fn: (values: number[]) => FormulaValue): FormulaValue {
  return isError(values) ? values : finiteOrError(fn(values));
}

/**
 * Spreadsheet aggregate functions distinguish values supplied directly from
 * values found through a cell/range reference. Direct logical values and
 * numeric text are coerced; referenced logical/text values are ignored.
 */
function numericArguments(args: FormulaValue[]): number[] | ErrorValue {
  const result: number[] = [];
  for (const argument of args) {
    if (isRange(argument)) {
      for (const value of argument.range) {
        if (isError(value)) return value;
        if (typeof value === "number") result.push(value);
      }
      continue;
    }
    if (isReference(argument)) {
      const value = argument.referenceValue;
      if (isError(value)) return value;
      if (typeof value === "number") result.push(value);
      continue;
    }
    if (isError(argument)) return argument;
    if (typeof argument === "number") {
      result.push(argument);
    } else if (typeof argument === "boolean") {
      result.push(argument ? 1 : 0);
    } else if (typeof argument === "string" && argument.trim() !== "") {
      const converted = Number(argument);
      if (!Number.isFinite(converted)) return ERROR.value(`'${argument}' is not numeric`);
      result.push(converted);
    }
  }
  return result;
}

function roundHalfAwayFromZero(value: number, digits: number): FormulaValue {
  const factor = 10 ** Math.trunc(digits);
  if (!Number.isFinite(factor) || factor === 0) return ERROR.num("ROUND digits are outside the supported range");
  const scaled = value * factor;
  if (!Number.isFinite(scaled)) return ERROR.num();
  const magnitude = Math.abs(scaled);
  const tolerance = Number.EPSILON * Math.max(1, magnitude);
  const rounded = Math.floor(magnitude + 0.5 + tolerance);
  return finiteOrError(Math.sign(scaled) * rounded / factor);
}

function numericBinary(left: FormulaValue, right: FormulaValue, operator: string): FormulaValue {
  const a = toNumber(left);
  if (isError(a)) return a;
  const b = toNumber(right);
  if (isError(b)) return b;
  if (operator === "/" && b === 0) return ERROR.div0();
  const result = operator === "+" ? a + b : operator === "-" ? a - b : operator === "*" ? a * b : operator === "/" ? a / b : a ** b;
  return finiteOrError(result);
}

function compareValues(left: FormulaValue, right: FormulaValue, operator: string): FormulaValue {
  const a = scalar(left);
  const b = scalar(right);
  if (isError(a)) return a;
  if (isError(b)) return b;
  const comparableA = comparisonValue(a, b);
  const comparableB = comparisonValue(b, a);
  switch (operator) {
    case "=": return comparableA === comparableB;
    case "<>": return comparableA !== comparableB;
    case "<": return comparableA < comparableB;
    case ">": return comparableA > comparableB;
    case "<=": return comparableA <= comparableB;
    case ">=": return comparableA >= comparableB;
    default: return false;
  }
}

function comparisonValue(value: Scalar, other: Scalar): string | number | boolean {
  if (value === null) {
    if (typeof other === "string") return "";
    if (typeof other === "boolean") return false;
    return 0;
  }
  return typeof value === "string" ? value.toLocaleLowerCase("en-US") : value;
}

function toNumber(value: FormulaValue): number | ErrorValue {
  const single = scalar(value);
  if (isError(single)) return single;
  if (single === null || single === "") return 0;
  if (typeof single === "number") return single;
  if (typeof single === "boolean") return single ? 1 : 0;
  const converted = Number(single);
  return Number.isFinite(converted) ? converted : ERROR.value(`'${single}' is not numeric`);
}

function scalar(value: FormulaValue): Scalar | ErrorValue {
  if (isRange(value)) return ERROR.value("Expected one value, received a range");
  return isReference(value) ? value.referenceValue : value;
}

function flatten(values: FormulaValue[]): Array<Scalar | ErrorValue> {
  return values.flatMap((value) => {
    if (isRange(value)) return value.range;
    return [isReference(value) ? value.referenceValue : value];
  });
}

function finiteOrError(value: FormulaValue): FormulaValue {
  return typeof value === "number" && !Number.isFinite(value) ? ERROR.num() : value;
}

function isError(value: unknown): value is ErrorValue {
  return Boolean(value && typeof value === "object" && "error" in value);
}

function isRange(value: unknown): value is RangeValue {
  return Boolean(value && typeof value === "object" && "range" in value);
}

function isReference(value: unknown): value is ReferenceValue {
  return Boolean(value && typeof value === "object" && "referenceValue" in value);
}

function computedToFormulaValue(value: ComputedCell): Scalar | ErrorValue {
  return value.kind === "error" ? { error: value.code, message: value.message } : value.value;
}

function displayScalar(value: Scalar): string {
  if (value === null) return "";
  if (value === true) return "TRUE";
  if (value === false) return "FALSE";
  return String(value);
}

function truthy(value: Scalar): boolean {
  return value !== null && value !== false && value !== 0 && value !== "";
}

function countIf(range: FormulaValue | undefined, criterion: FormulaValue | undefined): FormulaValue {
  const values = flatten([range ?? null]);
  const expected = scalar(criterion ?? null);
  if (isError(expected)) return expected;
  return values.filter((value) => !isError(value) && matchesCriterion(value, expected)).length;
}

function sumIf(
  range: FormulaValue | undefined,
  criterion: FormulaValue | undefined,
  sumRange: FormulaValue | undefined,
  context: EvaluationParserContext,
): FormulaValue {
  if (isError(range)) return range;
  const values = isRange(range)
    ? { values: range.range, rows: range.rows, columns: range.columns }
    : { values: [isReference(range) ? range.referenceValue : (range ?? null)], rows: 1, columns: 1 };
  const expected = scalar(criterion ?? null);
  if (isError(expected)) return expected;

  const alignedSource = sumRange === undefined || isRange(sumRange) || isReference(sumRange)
    ? sumRange
    : null;
  if (sumRange !== undefined && alignedSource === null && values.values.length > 1) {
    return ERROR.value("SUMIF sum_range must be a cell or range reference");
  }
  if (alignedSource !== undefined && alignedSource !== null) {
    const anchor = isRange(alignedSource) ? alignedSource.start : alignedSource.address;
    if (
      anchor.row + values.rows > SPREADSHEET_LIMITS.maxRows
      || anchor.column + values.columns > SPREADSHEET_LIMITS.maxColumns
    ) {
      return ERROR.ref("SUMIF aligned sum range is outside the sheet");
    }
  }

  let total = 0;
  for (let index = 0; index < values.values.length; index += 1) {
    const value = values.values[index]!;
    if (isError(value) || !matchesCriterion(value, expected)) continue;

    const rowOffset = Math.floor(index / values.columns);
    const columnOffset = index % values.columns;
    let sum: Scalar | ErrorValue;
    if (sumRange === undefined) {
      sum = value;
    } else if (alignedSource === null || alignedSource === undefined) {
      sum = scalar(sumRange);
    } else {
      sum = alignedSumIfValue(alignedSource, rowOffset, columnOffset, context);
    }
    if (isError(sum)) return sum;
    if (typeof sum === "number") total += sum;
  }
  return total;
}

/**
 * SUMIF treats sum_range as an anchor. Its shape does not change which cells
 * are summed: the criteria range's rows and columns are projected from the
 * supplied sum range's top-left cell.
 */
function alignedSumIfValue(
  source: RangeValue | ReferenceValue,
  rowOffset: number,
  columnOffset: number,
  context: EvaluationParserContext,
): Scalar | ErrorValue {
  if (isRange(source) && rowOffset < source.rows && columnOffset < source.columns) {
    return source.range[rowOffset * source.columns + columnOffset]!;
  }
  if (isReference(source) && rowOffset === 0 && columnOffset === 0) return source.referenceValue;

  if (!context.consumeReferences(1)) return ERROR.num("Formula calculation reference limit exceeded");
  const anchor = isRange(source) ? source.start : source.address;
  const address = formatCellAddress({
    row: anchor.row + rowOffset,
    column: anchor.column + columnOffset,
  });
  return computedToFormulaValue(context.resolve(source.sheet, address));
}

function matchesCriterion(value: Scalar, criterion: Scalar): boolean {
  if (typeof criterion === "string") {
    const match = /^(<=|>=|<>|=|<|>)(.*)$/.exec(criterion);
    if (match) {
      const operator = match[1]!;
      const targetText = match[2]!;
      const wildcard = operator === "=" || operator === "<>"
        ? wildcardCriterionPattern(targetText)
        : null;
      if (wildcard) {
        const matched = typeof value === "string" && wildcard.test(value);
        return operator === "=" ? matched : value !== null && !matched;
      }
      const target = /^-?(?:\d+\.?\d*|\.\d+)$/.test(targetText) ? Number(targetText) : targetText;
      return compareValues(value, target, match[1]!) === true;
    }
    const wildcard = wildcardCriterionPattern(criterion);
    if (wildcard) return typeof value === "string" && wildcard.test(value);
  }
  return compareValues(value, criterion, "=") === true;
}

/**
 * Compile spreadsheet criteria wildcards. `*` matches zero or more
 * characters, `?` matches exactly one, and `~` escapes `*`, `?`, or itself.
 * A null return means the criterion contains no wildcard syntax and should use
 * normal scalar comparison instead.
 */
function wildcardCriterionPattern(criterion: string): RegExp | null {
  let source = "^";
  let usesWildcardSyntax = false;
  for (let index = 0; index < criterion.length; index += 1) {
    const character = criterion[index]!;
    const escaped = criterion[index + 1];
    if (character === "~" && (escaped === "*" || escaped === "?" || escaped === "~")) {
      source += escapeRegExp(escaped);
      usesWildcardSyntax = true;
      index += 1;
    } else if (character === "*") {
      source += ".*";
      usesWildcardSyntax = true;
    } else if (character === "?") {
      source += ".";
      usesWildcardSyntax = true;
    } else {
      source += escapeRegExp(character);
    }
  }
  return usesWildcardSyntax ? new RegExp(`${source}$`, "isu") : null;
}

function xlookup(args: FormulaValue[]): FormulaValue {
  const matchMode = toNumber(args[4] ?? 0);
  const searchMode = toNumber(args[5] ?? 1);
  if (isError(matchMode)) return matchMode;
  if (isError(searchMode)) return searchMode;
  if (matchMode !== 0) return ERROR.value("XLOOKUP supports only exact match mode 0");
  if (searchMode !== 1) return ERROR.value("XLOOKUP supports only forward search mode 1");
  const needle = scalar(args[0] ?? null);
  if (isError(needle)) return needle;
  const lookup = flatten([args[1] ?? null]);
  const returns = flatten([args[2] ?? null]);
  if (lookup.length !== returns.length) return ERROR.value("XLOOKUP arrays must have equal size");
  const index = lookup.findIndex((value) => !isError(value) && compareValues(value, needle, "=") === true);
  return index < 0 ? (args[3] ?? ERROR.na()) : returns[index]!;
}

function vlookup(args: FormulaValue[]): FormulaValue {
  const needle = scalar(args[0] ?? null);
  const table = args[1];
  const columnNumber = toNumber(args[2] ?? 1);
  // Excel defaults an omitted range_lookup argument to approximate matching.
  // Reject that mode rather than silently changing it to exact matching.
  const approximate = scalar(args[3] ?? true);
  if (isError(needle)) return needle;
  if (isError(columnNumber)) return columnNumber;
  if (isError(approximate)) return approximate;
  if (!isRange(table)) return ERROR.value("VLOOKUP requires a table range");
  if (truthy(approximate)) return ERROR.value("VLOOKUP approximate match is not supported");
  const targetColumn = Math.trunc(columnNumber);
  if (targetColumn < 1) return ERROR.value("VLOOKUP column number must be at least 1");
  if (targetColumn > table.columns) return ERROR.ref("VLOOKUP column is outside the table range");
  for (let index = 0; index < table.range.length; index += table.columns) {
    const candidate = table.range[index]!;
    if (!isError(candidate) && compareValues(candidate, needle, "=") === true) {
      return table.range[index + targetColumn - 1]!;
    }
  }
  return ERROR.na();
}

function indexFunction(args: FormulaValue[]): FormulaValue {
  const source = args[0] ?? null;
  const rowNumber = toNumber(args[1] ?? 1);
  const columnNumber = toNumber(args[2] ?? 1);
  if (isError(rowNumber)) return rowNumber;
  if (isError(columnNumber)) return columnNumber;
  const row = Math.trunc(rowNumber);
  const column = Math.trunc(columnNumber);
  const rows = isRange(source) ? source.rows : 1;
  const columns = isRange(source) ? source.columns : 1;
  if (row < 1 || column < 1 || row > rows || column > columns) {
    return ERROR.ref("INDEX is outside the range");
  }
  const values = isRange(source) ? source.range : [source];
  return values[(row - 1) * columns + column - 1] ?? ERROR.ref("INDEX is outside the range");
}

function matchFunction(args: FormulaValue[]): FormulaValue {
  const matchMode = toNumber(args[2] ?? null);
  if (isError(matchMode)) return matchMode;
  if (matchMode !== 0) return ERROR.value("MATCH supports only exact match mode 0");
  const needle = scalar(args[0] ?? null);
  if (isError(needle)) return needle;
  const values = flatten([args[1] ?? null]);
  const index = values.findIndex((value) => !isError(value) && compareValues(value, needle, "=") === true);
  return index < 0 ? ERROR.na() : index + 1;
}

function countFunction(args: FormulaValue[]): FormulaValue {
  let count = 0;
  for (const argument of args) {
    if (isRange(argument)) {
      count += argument.range.filter((value) => typeof value === "number").length;
    } else if (isReference(argument)) {
      if (typeof argument.referenceValue === "number") count += 1;
    } else if (isError(argument)) {
      return argument;
    } else if (typeof argument === "number" || typeof argument === "boolean") {
      count += 1;
    } else if (typeof argument === "string" && argument.trim() !== "" && Number.isFinite(Number(argument))) {
      count += 1;
    }
  }
  return count;
}

function textJoin(args: FormulaValue[]): FormulaValue {
  const delimiter = scalar(args[0] ?? "");
  const ignoreEmpty = scalar(args[1] ?? true);
  if (isError(delimiter)) return delimiter;
  if (isError(ignoreEmpty)) return ignoreEmpty;
  const values = flatten(args.slice(2));
  const error = values.find(isError);
  if (error) return error;
  return (values as Scalar[])
    .filter((value) => !ignoreEmpty || (value !== null && value !== ""))
    .map(displayScalar)
    .join(displayScalar(delimiter));
}

function dateFunction(args: FormulaValue[], dateSystem: 1900 | 1904): FormulaValue {
  const year = toNumber(args[0] ?? 0);
  const month = toNumber(args[1] ?? 0);
  const day = toNumber(args[2] ?? 0);
  if (isError(year)) return year;
  if (isError(month)) return month;
  if (isError(day)) return day;
  const timestamp = Date.UTC(Math.trunc(year), Math.trunc(month) - 1, Math.trunc(day));
  return excelSerialAt(timestamp, dateSystem, false);
}

function excelSerialAt(timestamp: number, dateSystem: 1900 | 1904, includeTime: boolean): number {
  const dayMilliseconds = 86_400_000;
  const instant = includeTime ? timestamp : Math.floor(timestamp / dayMilliseconds) * dayMilliseconds;
  const epoch = dateSystem === 1900 ? Date.UTC(1899, 11, 31) : Date.UTC(1904, 0, 1);
  let serial = (instant - epoch) / dayMilliseconds;
  if (dateSystem === 1900 && serial >= 60) serial += 1; // Preserve Excel's fictitious 1900-02-29 slot.
  return serial;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function formatComputed(
  computed: ComputedCell,
  record?: CellRecord,
  dateSystem: 1900 | 1904 = 1900,
): string {
  if (computed.kind === "error") return computed.code;
  if (computed.kind === "blank") return "";
  const value = computed.value;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "string") return value;
  const style = record?.style;
  const decimals = style?.decimals;
  switch (style?.numberFormat) {
    case "percent": return `${(value * 100).toFixed(decimals ?? 0)}%`;
    case "currency": return `$${value.toFixed(decimals ?? 2)}`;
    case "number": return decimals === undefined ? String(value) : value.toFixed(decimals);
    case "date": return formatExcelDate(value, false, dateSystem);
    case "time": return formatExcelDate(value, true, dateSystem);
    default: return String(value);
  }
}

function formatExcelDate(serial: number, timeOnly: boolean, dateSystem: 1900 | 1904): string {
  const wholeDays = Math.floor(serial);
  const fraction = ((serial % 1) + 1) % 1;
  if (timeOnly) {
    const seconds = Math.round(fraction * 86_400) % 86_400;
    return `${String(Math.floor(seconds / 3_600)).padStart(2, "0")}:${String(Math.floor((seconds % 3_600) / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }
  if (dateSystem === 1900 && wholeDays === 60) return "1900-02-29";
  const epoch = dateSystem === 1900 ? Date.UTC(1899, 11, 31) : Date.UTC(1904, 0, 1);
  const adjusted = dateSystem === 1900 && wholeDays > 60 ? wholeDays - 1 : wholeDays;
  return new Date(epoch + adjusted * 86_400_000).toISOString().slice(0, 10);
}
