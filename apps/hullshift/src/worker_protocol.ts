import type { GeneratedLevel, GenerationProgress } from "./generator.ts";
import type { LevelDefinition } from "./model.ts";
import type { AnalysisReport } from "./solver.ts";

export const WORKER_PROTOCOL_VERSION = 1 as const;
export const MAX_WORKER_MESSAGE_BYTES = 512 * 1024;

const JOB_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;
const SEED_PATTERN = /^[0-9a-f]{16}$/;
const ERROR_CODES = new Set([
  "invalid_request",
  "generation_failed",
  "analysis_failed",
  "protocol_error",
]);
const PROGRESS_STAGES = new Set([
  "starting",
  "analysis-enumeration",
  "analysis-winning-set",
  "analysis-optimal-solution",
  "analysis-milestones",
  "analysis-complete",
  "complete",
]);

export type SerializedAnalysis = Omit<AnalysisReport, "winningStateKeys"> & {
  readonly winningStateKeys: readonly string[];
};

export type SerializedGeneratedLevel = Omit<GeneratedLevel, "analysis"> & {
  readonly analysis: SerializedAnalysis;
};

export type WorkerRequest =
  | {
      readonly protocol: typeof WORKER_PROTOCOL_VERSION;
      readonly type: "generate";
      readonly jobId: string;
      readonly seed: string;
      readonly difficulty: number;
    }
  | {
      readonly protocol: typeof WORKER_PROTOCOL_VERSION;
      readonly type: "analyze";
      readonly jobId: string;
      readonly level: LevelDefinition;
    }
  | {
      readonly protocol: typeof WORKER_PROTOCOL_VERSION;
      readonly type: "cancel";
      readonly jobId: string;
    };

export type WorkerResponse =
  | {
      readonly protocol: typeof WORKER_PROTOCOL_VERSION;
      readonly type: "ready";
    }
  | {
      readonly protocol: typeof WORKER_PROTOCOL_VERSION;
      readonly type: "progress";
      readonly jobId: string;
      readonly progress: GenerationProgress;
    }
  | {
      readonly protocol: typeof WORKER_PROTOCOL_VERSION;
      readonly type: "generated";
      readonly jobId: string;
      readonly result: SerializedGeneratedLevel;
    }
  | {
      readonly protocol: typeof WORKER_PROTOCOL_VERSION;
      readonly type: "analyzed";
      readonly jobId: string;
      readonly analysis: SerializedAnalysis;
    }
  | {
      readonly protocol: typeof WORKER_PROTOCOL_VERSION;
      readonly type: "cancelled";
      readonly jobId: string;
    }
  | {
      readonly protocol: typeof WORKER_PROTOCOL_VERSION;
      readonly type: "error";
      readonly jobId: string;
      readonly code: "invalid_request" | "generation_failed" | "analysis_failed" | "protocol_error";
      readonly message: string;
    };

export function serializeAnalysis(analysis: AnalysisReport): SerializedAnalysis {
  const winningStateKeys = [...analysis.winningStateKeys].sort();
  const winningIndex = new Map(winningStateKeys.map((key, index) => [key, index]));
  return {
    ...analysis,
    fatalFrontier: analysis.fatalFrontier.map((entry) => {
      const index = winningIndex.get(entry.stateKey);
      return index === undefined
        ? entry
        : { ...entry, stateKey: `${FATAL_INDEX_MARKER}${index.toString(36)}` };
    }),
    winningStateKeys: frontCodeStateKeys(winningStateKeys),
  };
}

/** Restore the resident-facing canonical keys from the compact wire form. */
export function deserializeAnalysis(analysis: SerializedAnalysis): SerializedAnalysis {
  const winningStateKeys = decodeFrontCodedStateKeys(analysis.winningStateKeys);
  if (winningStateKeys === null) throw new Error("Hullshift worker returned an invalid winning-state index");
  const fatalFrontier = expandFatalFrontier(analysis.fatalFrontier, winningStateKeys);
  if (fatalFrontier === null) throw new Error("Hullshift worker returned an invalid fatal-frontier index");
  return {
    ...analysis,
    ...(fatalFrontier === undefined ? {} : { fatalFrontier }),
    winningStateKeys,
  };
}

/** JSON wire size used for both inbound and outbound hard caps. */
export function workerMessageBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string"
      ? new TextEncoder().encode(json).byteLength
      : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function isWorkerRequest(value: unknown): value is WorkerRequest {
  if (workerMessageBytes(value) > MAX_WORKER_MESSAGE_BYTES || !isRecord(value)) return false;
  if (
    value.protocol !== WORKER_PROTOCOL_VERSION ||
    typeof value.type !== "string" ||
    typeof value.jobId !== "string" ||
    !JOB_ID_PATTERN.test(value.jobId)
  ) {
    return false;
  }
  if (value.type === "cancel") {
    return hasExactKeys(value, ["protocol", "type", "jobId"]);
  }
  if (value.type === "generate") {
    return (
      hasExactKeys(value, ["protocol", "type", "jobId", "seed", "difficulty"]) &&
      typeof value.seed === "string" &&
      SEED_PATTERN.test(value.seed) &&
      Number.isInteger(value.difficulty) &&
      (value.difficulty as number) >= 0 &&
      (value.difficulty as number) <= 8
    );
  }
  if (value.type === "analyze") {
    return (
      hasExactKeys(value, ["protocol", "type", "jobId", "level"]) &&
      isRecord(value.level)
    );
  }
  return false;
}

export function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (workerMessageBytes(value) > MAX_WORKER_MESSAGE_BYTES || !isRecord(value)) return false;
  if (value.protocol !== WORKER_PROTOCOL_VERSION || typeof value.type !== "string") return false;
  if (value.type === "ready") {
    return hasExactKeys(value, ["protocol", "type"]);
  }
  if (typeof value.jobId !== "string" || !JOB_ID_PATTERN.test(value.jobId)) return false;
  if (value.type === "cancelled") {
    return hasExactKeys(value, ["protocol", "type", "jobId"]);
  }
  if (value.type === "progress") {
    return (
      hasExactKeys(value, ["protocol", "type", "jobId", "progress"]) &&
      isProgress(value.progress)
    );
  }
  if (value.type === "error") {
    return (
      hasExactKeys(value, ["protocol", "type", "jobId", "code", "message"]) &&
      typeof value.code === "string" &&
      ERROR_CODES.has(value.code) &&
      typeof value.message === "string" &&
      value.message.length <= 500
    );
  }
  if (value.type === "generated") {
    return (
      hasExactKeys(value, ["protocol", "type", "jobId", "result"]) &&
      isRecord(value.result) &&
      isRecord(value.result.level) &&
      isSerializedAnalysis(value.result.analysis)
    );
  }
  if (value.type === "analyzed") {
    return (
      hasExactKeys(value, ["protocol", "type", "jobId", "analysis"]) &&
      isSerializedAnalysis(value.analysis)
    );
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isProgress(value: unknown): value is GenerationProgress {
  if (!isRecord(value)) return false;
  const expected = value.detail === undefined
    ? ["stage", "completed", "total"]
    : ["stage", "completed", "total", "detail"];
  return (
    hasExactKeys(value, expected) &&
    typeof value.stage === "string" &&
    PROGRESS_STAGES.has(value.stage) &&
    Number.isSafeInteger(value.completed) &&
    (value.completed as number) >= 0 &&
    Number.isSafeInteger(value.total) &&
    (value.total as number) >= 0 &&
    (value.detail === undefined ||
      (typeof value.detail === "string" && value.detail.length <= 500))
  );
}

function isSerializedAnalysis(value: unknown): value is SerializedAnalysis {
  if (!isRecord(value) || !Array.isArray(value.winningStateKeys)) return false;
  const winningStateKeys = decodeFrontCodedStateKeys(value.winningStateKeys);
  return winningStateKeys !== null
    && expandFatalFrontier(value.fatalFrontier, winningStateKeys) !== null;
}

const FRONT_CODE_MARKER = "!hullshift-front-code-v2";
const LEGACY_FRONT_CODE_MARKER = "!hullshift-front-code-v1";
const FATAL_INDEX_MARKER = "!";
const DICTIONARY_TOKEN = /^!([0-9a-z]+)$/;

/**
 * Sorted canonical states share their player/object prefixes heavily. Front
 * coding keeps the exact keys while avoiding thousands of repetitions on the
 * worker wire; the client expands them before resident code sees the report.
 */
function frontCodeStateKeys(keys: readonly string[]): readonly string[] {
  const parsed: unknown[] = [];
  const strings = new Set<string>();
  try {
    for (const key of keys) {
      const value: unknown = JSON.parse(key);
      parsed.push(value);
      collectStrings(value, strings);
    }
  } catch {
    return frontCodeStrings(keys, [LEGACY_FRONT_CODE_MARKER]);
  }
  const dictionary = [...strings].sort();
  const indexByString = new Map(dictionary.map((value, index) => [value, index]));
  const tokenized = parsed.map((value) => JSON.stringify(tokenizeStrings(value, indexByString)));
  return frontCodeStrings(tokenized, [FRONT_CODE_MARKER, JSON.stringify(dictionary)]);
}

function frontCodeStrings(
  values: readonly string[],
  header: readonly string[],
): readonly string[] {
  const encoded = [...header];
  let previous = "";
  for (const value of values) {
    let prefixLength = 0;
    const sharedLimit = Math.min(previous.length, value.length);
    while (prefixLength < sharedLimit
      && previous.charCodeAt(prefixLength) === value.charCodeAt(prefixLength)) {
      prefixLength += 1;
    }
    encoded.push(`${prefixLength.toString(36)}:${value.slice(prefixLength)}`);
    previous = value;
  }
  return Object.freeze(encoded);
}

function decodeFrontCodedStateKeys(value: readonly unknown[]): readonly string[] | null {
  if (value.length === 0) return Object.freeze([]);
  if (value[0] !== FRONT_CODE_MARKER && value[0] !== LEGACY_FRONT_CODE_MARKER) {
    return value.every((key) => (
      typeof key === "string" && key.length > 0 && key.length <= MAX_WORKER_MESSAGE_BYTES
    ))
      ? Object.freeze([...(value as readonly string[])])
      : null;
  }

  if (value[0] === LEGACY_FRONT_CODE_MARKER) {
    const decoded = decodeFrontCodedStrings(value, 1);
    return decoded === null ? null : Object.freeze(decoded);
  }

  if (typeof value[1] !== "string") return null;
  let dictionary: unknown;
  try {
    dictionary = JSON.parse(value[1]);
  } catch {
    return null;
  }
  if (!Array.isArray(dictionary) || !dictionary.every((entry) => typeof entry === "string")) {
    return null;
  }
  const tokenized = decodeFrontCodedStrings(value, 2);
  if (tokenized === null) return null;
  const decoded: string[] = [];
  try {
    for (const key of tokenized) {
      const restored = restoreStrings(JSON.parse(key), dictionary);
      if (restored === INVALID_DICTIONARY_VALUE) return null;
      decoded.push(JSON.stringify(restored));
    }
  } catch {
    return null;
  }
  return Object.freeze(decoded);
}

function decodeFrontCodedStrings(value: readonly unknown[], start: number): string[] | null {
  const decoded: string[] = [];
  let previous = "";
  for (let index = start; index < value.length; index += 1) {
    const entry = value[index];
    if (typeof entry !== "string" || entry.length > MAX_WORKER_MESSAGE_BYTES) return null;
    const separator = entry.indexOf(":");
    if (separator < 1) return null;
    const prefixText = entry.slice(0, separator);
    if (!/^[0-9a-z]+$/.test(prefixText)) return null;
    const prefixLength = Number.parseInt(prefixText, 36);
    if (!Number.isSafeInteger(prefixLength) || prefixLength > previous.length) return null;
    const key = previous.slice(0, prefixLength) + entry.slice(separator + 1);
    if (key.length === 0 || key.length > MAX_WORKER_MESSAGE_BYTES) return null;
    decoded.push(key);
    previous = key;
  }
  return decoded;
}

function collectStrings(value: unknown, strings: Set<string>): void {
  if (typeof value === "string") {
    strings.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) collectStrings(child, strings);
  }
}

function tokenizeStrings(value: unknown, indexByString: ReadonlyMap<string, number>): unknown {
  if (typeof value === "string") {
    const index = indexByString.get(value);
    if (index === undefined) throw new Error("Missing Hullshift state dictionary entry");
    return `${FATAL_INDEX_MARKER}${index.toString(36)}`;
  }
  if (Array.isArray(value)) return value.map((child) => tokenizeStrings(child, indexByString));
  return value;
}

const INVALID_DICTIONARY_VALUE = Symbol("invalid-dictionary-value");

function restoreStrings(value: unknown, dictionary: readonly string[]): unknown {
  if (typeof value === "string") {
    const match = DICTIONARY_TOKEN.exec(value);
    if (match === null) return INVALID_DICTIONARY_VALUE;
    const index = Number.parseInt(match[1]!, 36);
    return Number.isSafeInteger(index) && index < dictionary.length
      ? dictionary[index]
      : INVALID_DICTIONARY_VALUE;
  }
  if (Array.isArray(value)) {
    const restored: unknown[] = [];
    for (const child of value) {
      const decoded = restoreStrings(child, dictionary);
      if (decoded === INVALID_DICTIONARY_VALUE) return INVALID_DICTIONARY_VALUE;
      restored.push(decoded);
    }
    return restored;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  return INVALID_DICTIONARY_VALUE;
}

function expandFatalFrontier(
  value: unknown,
  winningStateKeys: readonly string[],
): SerializedAnalysis["fatalFrontier"] | undefined | null {
  // Minimal test doubles written before compact transport may omit this field.
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const expanded = [] as AnalysisReport["fatalFrontier"][number][];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.stateKey !== "string") return null;
    if (!entry.stateKey.startsWith(FATAL_INDEX_MARKER)) {
      expanded.push(entry as unknown as AnalysisReport["fatalFrontier"][number]);
      continue;
    }
    const match = DICTIONARY_TOKEN.exec(entry.stateKey);
    if (match === null) return null;
    const index = Number.parseInt(match[1]!, 36);
    const stateKey = winningStateKeys[index];
    if (stateKey === undefined) return null;
    expanded.push({ ...entry, stateKey } as unknown as AnalysisReport["fatalFrontier"][number]);
  }
  return Object.freeze(expanded);
}
