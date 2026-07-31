import { SPREADSHEET_LIMITS } from "./constants.ts";
import {
  FORMULA_FUNCTION_ARITIES,
  SUPPORTED_FORMULA_FUNCTIONS,
  type SupportedFormulaFunction,
} from "./formula.ts";

export const WORKBOOK_HELP_TOPICS = [
  "overview",
  "formulas",
  "functions",
  "function",
  "errors",
  "operations",
  "files",
  "concurrency",
] as const;

export const FORMULA_CATEGORIES = [
  "aggregate",
  "logical",
  "math",
  "conditional",
  "lookup",
  "text",
  "date-time",
] as const;

export const WORKBOOK_OPERATION_NAMES = [
  "set_cells", "clear", "fill", "copy_range", "move_range",
  "insert_rows", "delete_rows", "insert_columns", "delete_columns",
  "apply_style", "add_sheet", "rename_sheet", "delete_sheet",
  "resize_column", "resize_row", "sort_range", "set_filter", "clear_filter",
] as const;

export type WorkbookHelpTopic = (typeof WORKBOOK_HELP_TOPICS)[number];
export type FormulaCategory = (typeof FORMULA_CATEGORIES)[number];

export type FormulaFunctionHelp = {
  name: SupportedFormulaFunction;
  category: FormulaCategory;
  syntax: string;
  summary: string;
  example: string;
  minimumArguments: number;
  maximumArguments: number;
  notes: string[];
};

export type WorkbookHelpSection = { heading: string; items: string[] };

export type WorkbookHelpResult = {
  version: 1;
  topic: WorkbookHelpTopic;
  title: string;
  summary: string;
  sections: WorkbookHelpSection[];
  functions: FormulaFunctionHelp[];
  relatedTopics: WorkbookHelpTopic[];
};

export type WorkbookHelpRequest =
  | { topic?: "overview" }
  | { topic: Exclude<WorkbookHelpTopic, "overview" | "functions" | "function"> }
  | { topic: "functions"; query?: string; category?: FormulaCategory }
  | { topic: "function"; functionName: string };

type FormulaGuideSeed = Omit<FormulaFunctionHelp, "name" | "minimumArguments" | "maximumArguments">;

const FORMULA_GUIDE_DETAILS: Record<SupportedFormulaFunction, FormulaGuideSeed> = {
  SUM: {
    category: "aggregate", syntax: "SUM(number1, [number2], ...)", summary: "Adds numbers and referenced numeric cells.",
    example: "=SUM(B2:B10)", notes: ["Referenced text and logical values are ignored; referenced errors propagate."],
  },
  AVERAGE: {
    category: "aggregate", syntax: "AVERAGE(number1, [number2], ...)", summary: "Returns the arithmetic mean of numeric arguments.",
    example: "=AVERAGE(B2:B10)", notes: ["Returns #DIV/0! when no numeric value is present."],
  },
  MIN: {
    category: "aggregate", syntax: "MIN(number1, [number2], ...)", summary: "Returns the smallest numeric value.",
    example: "=MIN(B2:B10)", notes: ["Returns 0 when no numeric value is present."],
  },
  MAX: {
    category: "aggregate", syntax: "MAX(number1, [number2], ...)", summary: "Returns the largest numeric value.",
    example: "=MAX(B2:B10)", notes: ["Returns 0 when no numeric value is present."],
  },
  COUNT: {
    category: "aggregate", syntax: "COUNT(value1, [value2], ...)", summary: "Counts numeric values.",
    example: "=COUNT(B2:B10)", notes: ["Numeric text and logical literals count when supplied directly, but referenced text and logical cells do not."],
  },
  COUNTA: {
    category: "aggregate", syntax: "COUNTA(value1, [value2], ...)", summary: "Counts nonblank values, including errors.",
    example: "=COUNTA(A2:A10)", notes: ["Empty text is a value; a truly blank cell is not."],
  },
  IF: {
    category: "logical", syntax: "IF(condition, value_if_true, [value_if_false])", summary: "Chooses a result based on a condition.",
    example: "=IF(C2>=100,\"Target\",\"Below\")", notes: ["The omitted false result defaults to FALSE."],
  },
  IFERROR: {
    category: "logical", syntax: "IFERROR(value, fallback)", summary: "Returns a fallback when the first argument is an error.",
    example: "=IFERROR(A2/B2,0)", notes: ["Use it when an error is expected and has a meaningful replacement."],
  },
  ROUND: {
    category: "math", syntax: "ROUND(number, digits)", summary: "Rounds using spreadsheet half-away-from-zero behavior.",
    example: "=ROUND(B2,2)", notes: ["Negative digits round to positions left of the decimal point."],
  },
  ABS: {
    category: "math", syntax: "ABS(number)", summary: "Returns the absolute value of a number.",
    example: "=ABS(B2)", notes: [],
  },
  COUNTIF: {
    category: "conditional", syntax: "COUNTIF(range, criterion)", summary: "Counts cells matching one criterion.",
    example: "=COUNTIF(B2:B20,\">=100\")", notes: ["Text criteria support * and ? wildcards; ~ escapes *, ?, or ~."],
  },
  SUMIF: {
    category: "conditional", syntax: "SUMIF(range, criterion, [sum_range])", summary: "Sums aligned values whose criteria cells match.",
    example: "=SUMIF(A2:A20,\"East\",B2:B20)", notes: ["sum_range is aligned from its top-left cell over the criteria range dimensions.", "Criteria support the same wildcards as COUNTIF."],
  },
  XLOOKUP: {
    category: "lookup", syntax: "XLOOKUP(value, lookup_array, return_array, [if_not_found], [match_mode], [search_mode])", summary: "Finds an exact value and returns the aligned result.",
    example: "=XLOOKUP(E2,A2:A20,B2:B20,\"Not found\",0,1)", notes: ["Only exact match mode 0 and forward search mode 1 are supported.", "Lookup and return arrays must have equal size."],
  },
  VLOOKUP: {
    category: "lookup", syntax: "VLOOKUP(value, table, column_number, FALSE)", summary: "Finds an exact value in a table's first column.",
    example: "=VLOOKUP(E2,A2:C20,3,FALSE)", notes: ["Exact matching is required: the fourth argument must be present and FALSE; approximate matching is not supported."],
  },
  INDEX: {
    category: "lookup", syntax: "INDEX(range, row_number, [column_number])", summary: "Returns a value at a one-based row and column within a range.",
    example: "=INDEX(A2:C20,3,2)", notes: ["The column defaults to 1."],
  },
  MATCH: {
    category: "lookup", syntax: "MATCH(value, lookup_array, 0)", summary: "Returns the one-based position of an exact match.",
    example: "=MATCH(E2,A2:A20,0)", notes: ["The third argument is required and must be exact match mode 0."],
  },
  TEXTJOIN: {
    category: "text", syntax: "TEXTJOIN(delimiter, ignore_empty, text1, [text2], ...)", summary: "Joins values using one delimiter.",
    example: "=TEXTJOIN(\", \",TRUE,A2:A5)", notes: ["Errors in joined values propagate."],
  },
  DATE: {
    category: "date-time", syntax: "DATE(year, month, day)", summary: "Builds a spreadsheet date serial in the workbook date system.",
    example: "=DATE(2026,7,14)", notes: ["Apply the Date number format to display a calendar date."],
  },
  TODAY: {
    category: "date-time", syntax: "TODAY()", summary: "Returns the current UTC date as a spreadsheet serial.",
    example: "=TODAY()", notes: ["Apply the Date number format to display a calendar date."],
  },
  NOW: {
    category: "date-time", syntax: "NOW()", summary: "Returns the current UTC date and time as a spreadsheet serial.",
    example: "=NOW()", notes: ["Apply the Date or Time number format to control its display."],
  },
};

export const FORMULA_FUNCTION_GUIDES: FormulaFunctionHelp[] = SUPPORTED_FORMULA_FUNCTIONS.map((name) => ({
  name,
  ...FORMULA_GUIDE_DETAILS[name],
  minimumArguments: FORMULA_FUNCTION_ARITIES[name].min,
  maximumArguments: FORMULA_FUNCTION_ARITIES[name].max,
}));

const STATIC_HELP: Record<Exclude<WorkbookHelpTopic, "functions" | "function">, Omit<WorkbookHelpResult, "version" | "topic" | "functions">> = {
  overview: {
    title: "Spreadsheet capabilities",
    summary: "A revisioned, agent-first workbook shared by the human tile and agent tools.",
    sections: [
      { heading: "Typical agent workflow", items: [
        "Call workbook_status to get workbookId, revision, sheets, history heads, formats, and limits.",
        "Call workbook_read for the exact range you need; follow nextCursor and require an unchanged workbookId and revision on every page.",
        "Call workbook_apply with expectedRevision, a unique commandId, and one atomic operation batch, then read back the result.",
      ] },
      { heading: "What it supports", items: [
        "Tagged text, numbers, booleans, blanks, formulas, styles, sheets, fill, copy/move, structure, sorting, filters, sizing, and bounded undo/redo.",
        "Lossless .nsheet files plus reviewed XLSX and CSV imports/exports through Files.",
        "JavaScript formula functions are disabled; use only the published built-in formula catalog.",
      ] },
    ],
    relatedTopics: ["operations", "formulas", "files", "concurrency"],
  },
  formulas: {
    title: "Formula language",
    summary: "Formulas use an Excel-like A1 grammar and only the explicitly published built-in functions.",
    sections: [
      { heading: "Syntax", items: [
        "Start every formula with = and separate function arguments with commas.",
        "Use A1 cells, A1:B10 ranges, $A$1/$A1/A$1 absolute forms, Sales!B2 cross-sheet references, and quoted references such as 'Q1 Sales'!B2.",
        "Operators: +, -, *, /, ^, &, =, <>, <, <=, >, >=. Parentheses control precedence; strings use double quotes and double a quote inside text.",
        "Agents write formulas as tagged cell input, for example {\"kind\":\"formula\",\"formula\":\"=SUM(A2:B2)\"}, inside the rectangular values matrix of set_cells.",
      ] },
      { heading: "Human editor", items: [
        "Type =, then click a cell or drag a range to insert a reference without leaving the formula origin.",
        "Press F4 after pointing to cycle relative and absolute reference forms. Enter or Tab commits; Escape cancels.",
      ] },
      { heading: "Limits", items: [
        `A formula can contain at most ${SPREADSHEET_LIMITS.maxFormulaLength.toLocaleString("en-US")} characters. Calculation depth and referenced-cell work are bounded and return #NUM! when exceeded.`,
        "Unknown functions are rejected on import and evaluate as #NAME? rather than silently producing a guessed result.",
        "Named ranges, table/structured references, percent literals, array formulas, external workbook links, and JavaScript custom functions are not supported in v1.",
      ] },
    ],
    relatedTopics: ["functions", "errors"],
  },
  errors: {
    title: "Formula errors",
    summary: "Errors are typed values that propagate through formulas unless a function such as IFERROR handles them.",
    sections: [
      { heading: "Codes", items: [
        "#DIV/0!: division by zero or an average with no numeric inputs.",
        "#VALUE!: incompatible value, unsupported function mode, or wrong argument count.",
        "#REF!: invalid/deleted cell, sheet, range, or out-of-range lookup result.",
        "#NAME?: unknown function or name. Use workbook_help topic functions to inspect the supported catalog.",
        "#NUM!: non-finite result or calculation/resource limit exceeded.",
        "#N/A: exact lookup found no match. Supply XLOOKUP's if_not_found argument or handle it with IFERROR when appropriate.",
        "#CYCLE!: the formula depends on itself through one or more cells.",
      ] },
    ],
    relatedTopics: ["formulas", "functions"],
  },
  operations: {
    title: "Workbook operations",
    summary: "workbook_apply accepts explicit, atomic operation batches guarded by the current revision.",
    sections: [
      { heading: "Cells and ranges", items: ["set_cells, clear, fill, copy_range, move_range, apply_style"] },
      { heading: "Structure and sheets", items: ["insert_rows, delete_rows, insert_columns, delete_columns, add_sheet, rename_sheet, delete_sheet"] },
      { heading: "Layout and data", items: ["resize_column, resize_row, sort_range, set_filter, clear_filter"] },
      { heading: "Safety", items: [
        `One command may contain at most ${SPREADSHEET_LIMITS.maxOperations} operations and touch at most ${SPREADSHEET_LIMITS.maxTouchedCells.toLocaleString("en-US")} cells.`,
        "Use dryRun for validation when needed. Undo/redo require the current history head returned by workbook_status.",
      ] },
    ],
    relatedTopics: ["overview", "concurrency"],
  },
  files: {
    title: "Files and formats",
    summary: ".nsheet is the only lossless editable save format; XLSX and CSV are import/export snapshots.",
    sections: [
      { heading: "Lossless work", items: [
        "Use workbook_session open and workbook_save native for .nsheet. Native saves retain formulas, tagged values, styles, sheets, filters, and layout metadata.",
        "Files reads and writes are bound to path, media type, byte length, and SHA-256 etag through Neutron's delegated binary transport.",
      ] },
      { heading: "Snapshots", items: [
        "XLSX and CSV exports require preflight review and create a new file; they never replace the native save destination.",
        "CSV contains computed values only and cannot preserve formulas, styles, multiple sheets, or workbook metadata.",
        "XLSX preserves supported formulas and common styles but reports unsupported/lost features explicitly.",
      ] },
    ],
    relatedTopics: ["overview", "formulas"],
  },
  concurrency: {
    title: "Concurrency and paging",
    summary: "Every mutation is optimistic, revision-checked, idempotent, and atomic.",
    sections: [
      { heading: "Mutation rules", items: [
        "Read workbook_status immediately before a write and pass its revision as expectedRevision.",
        "Give each logical command a unique commandId. Retrying the identical commandId is safe; reusing it for different work is rejected.",
        "On REVISION_CONFLICT, reread status and affected cells, reconcile intent, and issue a new command rather than blindly retrying stale arguments.",
      ] },
      { heading: "Snapshot reads", items: [
        "Every workbook_read and workbook_find page returns workbookId and revision. Discard accumulated pages and restart if either changes.",
        "Dense workbook_read is the compatibility default; includeBlanks false is available for sparse consumers while cursors still advance over every scanned position.",
      ] },
    ],
    relatedTopics: ["overview", "operations"],
  },
};

export function getWorkbookHelp(request: WorkbookHelpRequest): WorkbookHelpResult {
  const topic = request.topic ?? "overview";
  if (topic === "functions") {
    const functionRequest = request as Extract<WorkbookHelpRequest, { topic: "functions" }>;
    const query = functionRequest.query?.trim().toLocaleUpperCase("en-US") ?? "";
    const functions = FORMULA_FUNCTION_GUIDES.filter((guide) => {
      if (functionRequest.category && guide.category !== functionRequest.category) return false;
      if (!query) return true;
      return [guide.name, guide.category, guide.syntax, guide.summary, guide.example, ...guide.notes]
        .some((value) => value.toLocaleUpperCase("en-US").includes(query));
    });
    return {
      version: 1,
      topic: "functions",
      title: "Formula function catalog",
      summary: `${functions.length} of ${FORMULA_FUNCTION_GUIDES.length} supported functions match this request.`,
      sections: [{ heading: "Search", items: [
        query ? `Query: ${query}` : "No name or text filter applied.",
        functionRequest.category ? `Category: ${functionRequest.category}` : "All categories included.",
      ] }],
      functions,
      relatedTopics: ["formulas", "errors"],
    };
  }
  if (topic === "function") {
    const functionRequest = request as Extract<WorkbookHelpRequest, { topic: "function" }>;
    const name = functionRequest.functionName.trim().toLocaleUpperCase("en-US");
    const guide = FORMULA_FUNCTION_GUIDES.find((candidate) => candidate.name === name);
    return {
      version: 1,
      topic: "function",
      title: guide ? `${guide.name} formula help` : `${name || "Unknown"} is not supported`,
      summary: guide?.summary ?? "Use topic functions to search the complete supported catalog; do not write an unsupported function into the workbook.",
      sections: guide ? [] : [{ heading: "Next step", items: ["Call workbook_help with topic functions and an optional query or category."] }],
      functions: guide ? [guide] : [],
      relatedTopics: ["functions", "formulas", "errors"],
    };
  }
  const help = STATIC_HELP[topic];
  return { version: 1, topic, ...help, functions: [] };
}

export function formulaHintForDraft(draft: string): string {
  const value = draft.trim();
  if (value === "=") return "Click or drag cells to add references · F4 locks a reference · Enter accepts · Esc cancels";
  if (!value.startsWith("=")) return "Formulas begin with =";
  const activeName = activeFormulaFunctionName(value);
  if (!activeName) return "Use A1 references, commas between arguments, and F1 for formula help";
  const guide = FORMULA_FUNCTION_GUIDES.find((candidate) => candidate.name === activeName);
  return guide
    ? `${guide.syntax} — ${guide.summary}`
    : `${activeName} is not supported · Open Formula help to see available functions`;
}

function activeFormulaFunctionName(source: string): string | null {
  const stack: Array<string | null> = [];
  for (let index = 1; index < source.length;) {
    const character = source[index]!;
    if (character === '"') {
      index += 1;
      while (index < source.length) {
        if (source[index] !== '"') { index += 1; continue; }
        if (source[index + 1] === '"') { index += 2; continue; }
        index += 1;
        break;
      }
      continue;
    }
    if (character === "'") {
      index += 1;
      while (index < source.length) {
        if (source[index] !== "'") { index += 1; continue; }
        if (source[index + 1] === "'") { index += 2; continue; }
        index += 1;
        break;
      }
      continue;
    }
    const identifier = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(source.slice(index));
    if (identifier) {
      const name = identifier[0]!.toLocaleUpperCase("en-US");
      index += identifier[0]!.length;
      while (/\s/.test(source[index] ?? "")) index += 1;
      if (source[index] === "(") {
        stack.push(name);
        index += 1;
      }
      continue;
    }
    if (character === "(") stack.push(null);
    else if (character === ")") stack.pop();
    index += 1;
  }
  return [...stack].reverse().find((name): name is string => name !== null) ?? null;
}
