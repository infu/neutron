import {
  isJsonObject,
  type ScopedKernelClient,
  type SelfCallObject,
  type SelfCallValue,
} from "neutron-tools/app";
import {
  boundedError,
  isUnicodeScalarText,
  sha256Hex,
  stringBytes,
  unicodeScalarLength,
} from "./json.ts";
import { BLAST_LIMITS } from "./limits.ts";

export const BLAST_SCRIPT_METHODS = Object.freeze({
  list: "blast_scripts_list_v1",
  get: "blast_script_get_v1",
  save: "blast_script_save_v1",
  delete: "blast_script_delete_v1",
} as const);

const MAX_SCRIPTS = 128;
const MAX_SCRIPT_PAGE = 10;
const MAX_SCRIPT_NAME_SCALARS = 120;
const MAX_SCRIPT_NAME_BYTES = 480;
const MAX_DESCRIPTION_BYTES = 1_024;
const MAX_LIBRARY_SOURCE_BYTES = 16 * 1_024 * 1_024;
const MAX_NAT32 = 4_294_967_295n;
const MAX_NAT64 = 18_446_744_073_709_551_615n;
const SCRIPT_QUERY_TIMEOUT_SECONDS = 30;
const SCRIPT_UPDATE_TIMEOUT_SECONDS = 45;
const NAT_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/u;
const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });

export type SavedScriptCursor = Readonly<{
  afterId: string;
  libraryRevision: string;
}>;

export type SavedScriptSummary = Readonly<{
  id: string;
  revision: string;
  name: string;
  description: string | null;
  sourceDigest: string;
  sourceBytes: number;
  createdAtNs: string;
  updatedAtNs: string;
}>;

export type SavedScript = SavedScriptSummary &
  Readonly<{
    source: string;
  }>;

export type SavedScriptPage = Readonly<{
  libraryRevision: string;
  scripts: readonly SavedScriptSummary[];
  total: number;
  totalSourceBytes: number;
  nextCursor: SavedScriptCursor | null;
}>;

export type SaveScriptInput = Readonly<{
  id?: string | null;
  expectedRevision?: string | null;
  name: string;
  description?: string | null;
  source: string;
}>;

export type SaveScriptResult = Readonly<{
  libraryRevision: string;
  totalSourceBytes: number;
  script: SavedScriptSummary;
}>;

export type DeleteScriptResult = Readonly<{
  id: string;
  deletedRevision: string;
  sourceDigest: string;
  libraryRevision: string;
  totalSourceBytes: number;
}>;

export type BlastScriptRejectionCode =
  | "invalid_request"
  | "invalid_name"
  | "invalid_description"
  | "invalid_source"
  | "not_found"
  | "revision_conflict"
  | "cursor_stale"
  | "script_limit"
  | "capacity_exhausted"
  | "clock_regressed"
  | "corrupt_state";

export class BlastScriptRejectionError extends Error {
  constructor(
    readonly code: BlastScriptRejectionCode,
    readonly detail: Readonly<Record<string, string>> | null = null,
  ) {
    super(rejectionMessage(code, detail));
    this.name = "BlastScriptRejectionError";
  }
}

export class BlastScriptsBackendError extends Error {
  constructor(
    readonly operation: "list" | "get" | "save" | "delete",
    cause: unknown,
  ) {
    super(`Saved-script ${operation} failed: ${boundedError(cause)}`, { cause });
    this.name = "BlastScriptsBackendError";
  }
}

/**
 * Create the saved-script adapter for one routed tool invocation. There is no
 * global-bus fallback: using the handler's scoped client preserves Agent
 * provenance for every exact preapproved v1 self call.
 */
export function createBlastScriptsBackend(kernel: ScopedKernelClient) {
  const query = (method: string, args: SelfCallValue[]) =>
    kernel.querySelf<SelfCallValue>(
      method,
      args,
      SCRIPT_QUERY_TIMEOUT_SECONDS,
    );
  const update = (method: string, args: SelfCallValue[]) =>
    kernel.updateSelf<SelfCallValue>(
      method,
      args,
      SCRIPT_UPDATE_TIMEOUT_SECONDS,
    );

  return Object.freeze({
    async list(
      request: Readonly<{
        cursor?: SavedScriptCursor | null;
        limit?: number;
      }> = {},
    ): Promise<SavedScriptPage> {
      const limit = boundedWholeNumber(
        request.limit ?? MAX_SCRIPT_PAGE,
        "script page limit",
        MAX_SCRIPT_PAGE,
        1,
      );
      const cursor = request.cursor ?? null;
      const encodedCursor = cursor === null ? null : encodeCursor(cursor);
      try {
        const page = parseListResponse(
          await query(BLAST_SCRIPT_METHODS.list, [
            {
              ...(encodedCursor === null ? {} : { cursor: encodedCursor }),
              limit: String(limit),
            },
          ]),
        );
        if (page.scripts.length > limit) {
          throw new Error("Saved-script page exceeds its requested limit");
        }
        if (
          cursor !== null &&
          page.libraryRevision !== cursor.libraryRevision
        ) {
          throw new Error("Saved-script page changed its cursor revision");
        }
        return page;
      } catch (error) {
        throw backendError("list", error);
      }
    },

    async get(id: string): Promise<SavedScript | null> {
      const scriptId = requiredPositiveNat64(id, "script id");
      try {
        const script = await parseGetResponse(
          await query(BLAST_SCRIPT_METHODS.get, [{ id: scriptId }]),
        );
        if (script.id !== scriptId) {
          throw new Error("Saved-script response id does not match the request");
        }
        return script;
      } catch (error) {
        if (
          error instanceof BlastScriptRejectionError &&
          error.code === "not_found"
        ) {
          return null;
        }
        throw backendError("get", error);
      }
    },

    async save(input: SaveScriptInput): Promise<SaveScriptResult> {
      const encoded = encodeSaveScriptInput(input);
      try {
        const result = parseSaveResponse(
          await update(BLAST_SCRIPT_METHODS.save, [encoded]),
        );
        const requestedId = input.id ?? null;
        if (requestedId !== null && result.script.id !== requestedId) {
          throw new Error("Saved-script response id does not match the request");
        }
        if (input.expectedRevision !== undefined && input.expectedRevision !== null) {
          const expected = BigInt(
            requiredPositiveNat64(input.expectedRevision, "expected revision"),
          );
          if (BigInt(result.script.revision) !== expected + 1n) {
            throw new Error("Saved-script response revision is not the CAS successor");
          }
        } else if (requestedId === null && result.script.revision !== "1") {
          throw new Error("New saved-script response has an invalid revision");
        }
        const requestedDescription = input.description ?? null;
        if (
          result.script.name !== input.name ||
          result.script.description !== requestedDescription ||
          result.script.sourceBytes !== stringBytes(input.source) ||
          result.script.sourceDigest !== (await sha256Hex(input.source))
        ) {
          throw new Error("Saved-script response does not match the submitted script");
        }
        if (result.totalSourceBytes < result.script.sourceBytes) {
          throw new Error("Saved-script source total is invalid");
        }
        return result;
      } catch (error) {
        throw backendError("save", error);
      }
    },

    async delete(
      id: string,
      expectedRevision: string,
    ): Promise<DeleteScriptResult> {
      const scriptId = requiredPositiveNat64(id, "script id");
      const revision = requiredPositiveNat64(
        expectedRevision,
        "expected revision",
      );
      try {
        const result = parseDeleteResponse(
          await update(BLAST_SCRIPT_METHODS.delete, [
            { id: scriptId, expected_revision: revision },
          ]),
        );
        if (result.id !== scriptId || result.deletedRevision !== revision) {
          throw new Error("Deleted-script response does not match the request");
        }
        return result;
      } catch (error) {
        throw backendError("delete", error);
      }
    },
  });
}

export function encodeSaveScriptInput(input: SaveScriptInput): SelfCallObject {
  const id =
    input.id === undefined || input.id === null
      ? null
      : requiredPositiveNat64(input.id, "script id");
  const expectedRevision =
    input.expectedRevision === undefined || input.expectedRevision === null
      ? null
      : requiredPositiveNat64(input.expectedRevision, "expected revision");
  if (id === null && expectedRevision !== null) {
    throw new Error("A new script cannot have an expected revision");
  }
  if (id !== null && expectedRevision === null) {
    throw new Error("An existing script requires an expected revision");
  }

  const name = validateName(input.name);
  const description = validateDescription(input.description);
  if (
    typeof input.source !== "string" ||
    !isUnicodeScalarText(input.source)
  ) {
    throw new Error("Invalid script source");
  }
  const sourceUtf8 = encoder.encode(input.source);
  if (
    sourceUtf8.byteLength === 0 ||
    sourceUtf8.byteLength > BLAST_LIMITS.scriptSourceBytes
  ) {
    throw new Error("Invalid script source");
  }

  return {
    ...(id === null ? {} : { id }),
    ...(expectedRevision === null
      ? {}
      : { expected_revision: expectedRevision }),
    name,
    ...(description === null ? {} : { description }),
    source_utf8: sourceUtf8,
  };
}

export function parseListResponse(value: unknown): SavedScriptPage {
  return parseOutcome(value, "saved-script list response", parseSavedScriptPage);
}

export async function parseGetResponse(value: unknown): Promise<SavedScript> {
  return parseOutcomeAsync(value, "saved-script get response", parseSavedScript);
}

export function parseSaveResponse(value: unknown): SaveScriptResult {
  return parseOutcome(value, "saved-script save response", (success) => {
    const record = requiredRecord(success, "saved-script save success");
    assertExactKeys(
      record,
      ["library_revision", "total_source_bytes", "script"],
      [],
      "saved-script save success",
    );
    return Object.freeze({
      libraryRevision: requiredNat64(
        record.library_revision,
        "library revision",
      ),
      totalSourceBytes: boundedNatNumber(
        record.total_source_bytes,
        "total script source bytes",
        MAX_LIBRARY_SOURCE_BYTES,
      ),
      script: parseSavedScriptSummary(record.script),
    });
  });
}

export function parseDeleteResponse(value: unknown): DeleteScriptResult {
  return parseOutcome(value, "saved-script delete response", (success) => {
    const record = requiredRecord(success, "saved-script delete success");
    assertExactKeys(
      record,
      [
        "id",
        "deleted_revision",
        "source_sha256",
        "library_revision",
        "total_source_bytes",
      ],
      [],
      "saved-script delete success",
    );
    return Object.freeze({
      id: requiredPositiveNat64(record.id, "script id"),
      deletedRevision: requiredPositiveNat64(
        record.deleted_revision,
        "deleted revision",
      ),
      sourceDigest: parseDigest(record.source_sha256),
      libraryRevision: requiredNat64(
        record.library_revision,
        "library revision",
      ),
      totalSourceBytes: boundedNatNumber(
        record.total_source_bytes,
        "total script source bytes",
        MAX_LIBRARY_SOURCE_BYTES,
      ),
    });
  });
}

export function parseSavedScriptPage(value: unknown): SavedScriptPage {
  const record = requiredRecord(value, "saved-script page");
  assertExactKeys(
    record,
    ["library_revision", "scripts", "total", "total_source_bytes"],
    ["next_cursor"],
    "saved-script page",
  );
  if (!Array.isArray(record.scripts) || record.scripts.length > MAX_SCRIPT_PAGE) {
    throw new Error("Invalid saved-script summaries");
  }
  const total = boundedNatNumber(record.total, "saved-script total", MAX_SCRIPTS);
  const scripts = record.scripts.map(parseSavedScriptSummary);
  if (scripts.length > total) throw new Error("Saved-script page total is invalid");
  const ids = new Set(scripts.map(({ id }) => id));
  if (ids.size !== scripts.length) {
    throw new Error("Saved-script page contains duplicate ids");
  }
  for (let index = 1; index < scripts.length; index += 1) {
    if (BigInt(scripts[index - 1]!.id) >= BigInt(scripts[index]!.id)) {
      throw new Error("Saved-script page is not ordered by id");
    }
  }
  const libraryRevision = requiredNat64(
    record.library_revision,
    "library revision",
  );
  const nextCursor = parseOptionalCursor(record.next_cursor);
  if (
    nextCursor !== null &&
    (scripts.length === 0 ||
      nextCursor.afterId !== scripts.at(-1)!.id ||
      nextCursor.libraryRevision !== libraryRevision)
  ) {
    throw new Error("Saved-script continuation cursor is invalid");
  }
  const totalSourceBytes = boundedNatNumber(
    record.total_source_bytes,
    "total script source bytes",
    MAX_LIBRARY_SOURCE_BYTES,
  );
  if (
    scripts.reduce((sum, script) => sum + script.sourceBytes, 0) >
    totalSourceBytes
  ) {
    throw new Error("Saved-script source total is invalid");
  }
  return Object.freeze({
    libraryRevision,
    scripts: Object.freeze(scripts),
    total,
    totalSourceBytes,
    nextCursor,
  });
}

export function parseSavedScriptSummary(value: unknown): SavedScriptSummary {
  const record = requiredRecord(value, "saved-script summary");
  assertExactKeys(
    record,
    [
      "id",
      "revision",
      "name",
      "source_sha256",
      "source_bytes",
      "created_at_ns",
      "updated_at_ns",
    ],
    ["description"],
    "saved-script summary",
  );
  const createdAtNs = requiredPositiveNat64(
    record.created_at_ns,
    "script creation time",
  );
  const updatedAtNs = requiredPositiveNat64(
    record.updated_at_ns,
    "script update time",
  );
  if (BigInt(updatedAtNs) < BigInt(createdAtNs)) {
    throw new Error("Saved-script update time precedes its creation time");
  }
  return Object.freeze({
    id: requiredPositiveNat64(record.id, "script id"),
    revision: requiredPositiveNat64(record.revision, "script revision"),
    name: validateName(requiredString(record.name, "script name")),
    description: parseDescription(record.description),
    sourceDigest: parseDigest(record.source_sha256),
    sourceBytes: boundedNatNumber(
      record.source_bytes,
      "script source bytes",
      BLAST_LIMITS.scriptSourceBytes,
      1,
      MAX_NAT32,
    ),
    createdAtNs,
    updatedAtNs,
  });
}

export async function parseSavedScript(value: unknown): Promise<SavedScript> {
  const record = requiredRecord(value, "saved script");
  assertExactKeys(
    record,
    [
      "id",
      "revision",
      "name",
      "source_utf8",
      "source_sha256",
      "source_bytes",
      "created_at_ns",
      "updated_at_ns",
    ],
    ["description"],
    "saved script",
  );
  const summary = parseSavedScriptSummary({
    id: record.id,
    revision: record.revision,
    name: record.name,
    ...(Object.hasOwn(record, "description")
      ? { description: record.description as SelfCallValue }
      : {}),
    source_sha256: record.source_sha256,
    source_bytes: record.source_bytes,
    created_at_ns: record.created_at_ns,
    updated_at_ns: record.updated_at_ns,
  });
  if (!(record.source_utf8 instanceof Uint8Array)) {
    throw new Error("Invalid saved-script source blob");
  }
  const sourceBytes = Uint8Array.from(record.source_utf8);
  if (
    sourceBytes.byteLength !== summary.sourceBytes ||
    sourceBytes.byteLength === 0 ||
    sourceBytes.byteLength > BLAST_LIMITS.scriptSourceBytes
  ) {
    throw new Error("Saved-script source byte count is invalid");
  }
  let source: string;
  try {
    source = fatalDecoder.decode(sourceBytes);
  } catch (cause) {
    throw new Error("Saved-script source is not valid UTF-8", { cause });
  }
  if (stringBytes(source) !== sourceBytes.byteLength) {
    throw new Error("Saved-script source UTF-8 did not round trip");
  }
  if ((await sha256Hex(source)) !== summary.sourceDigest) {
    throw new Error("Saved-script source digest is invalid");
  }
  return Object.freeze({ ...summary, source });
}

export function parseScriptRejection(value: unknown): BlastScriptRejectionError {
  const variant = requiredRecord(value, "saved-script rejection");
  const entries = Object.entries(variant);
  if (entries.length !== 1) throw new Error("Invalid saved-script rejection");
  const [code, detail] = entries[0]!;
  switch (code) {
    case "revision_conflict": {
      const record = requiredRecord(detail, "revision conflict");
      assertExactKeys(
        record,
        ["expected", "actual"],
        [],
        "revision conflict",
      );
      return new BlastScriptRejectionError(code, {
        expected: requiredPositiveNat64(record.expected, "expected revision"),
        actual: requiredPositiveNat64(record.actual, "actual revision"),
      });
    }
    case "cursor_stale": {
      const record = requiredRecord(detail, "stale cursor");
      assertExactKeys(
        record,
        ["expected_library_revision", "actual_library_revision"],
        [],
        "stale cursor",
      );
      return new BlastScriptRejectionError(code, {
        expectedLibraryRevision: requiredNat64(
          record.expected_library_revision,
          "expected library revision",
        ),
        actualLibraryRevision: requiredNat64(
          record.actual_library_revision,
          "actual library revision",
        ),
      });
    }
    case "invalid_request":
    case "invalid_name":
    case "invalid_description":
    case "invalid_source":
    case "not_found":
    case "script_limit":
    case "capacity_exhausted":
    case "clock_regressed":
    case "corrupt_state":
      if (detail !== null) throw new Error("Invalid saved-script rejection detail");
      return new BlastScriptRejectionError(code);
    default:
      throw new Error("Unknown saved-script rejection");
  }
}

function parseOutcome<T>(
  value: unknown,
  label: string,
  parseSuccess: (value: unknown) => T,
): T {
  const outcome = requiredOutcome(value, label);
  if (Object.hasOwn(outcome, "rejected")) {
    throw parseScriptRejection(outcome.rejected);
  }
  return parseSuccess(outcome.ok);
}

async function parseOutcomeAsync<T>(
  value: unknown,
  label: string,
  parseSuccess: (value: unknown) => Promise<T>,
): Promise<T> {
  const outcome = requiredOutcome(value, label);
  if (Object.hasOwn(outcome, "rejected")) {
    throw parseScriptRejection(outcome.rejected);
  }
  return parseSuccess(outcome.ok);
}

function requiredOutcome(
  value: unknown,
  label: string,
): SelfCallObject & ({ ok: SelfCallValue } | { rejected: SelfCallValue }) {
  const response = requiredRecord(value, label);
  assertExactKeys(response, ["outcome"], [], label);
  const outcome = requiredRecord(response.outcome, `${label} outcome`);
  const keys = Object.keys(outcome);
  if (
    keys.length !== 1 ||
    (keys[0] !== "ok" && keys[0] !== "rejected")
  ) {
    throw new Error(`Invalid ${label} outcome`);
  }
  return outcome as SelfCallObject &
    ({ ok: SelfCallValue } | { rejected: SelfCallValue });
}

function encodeCursor(cursor: SavedScriptCursor): SelfCallObject {
  return {
    after_id: requiredPositiveNat64(cursor.afterId, "cursor script id"),
    library_revision: requiredNat64(
      cursor.libraryRevision,
      "cursor library revision",
    ),
  };
}

function parseOptionalCursor(value: unknown): SavedScriptCursor | null {
  if (value === undefined || value === null) return null;
  const record = requiredRecord(value, "saved-script cursor");
  assertExactKeys(
    record,
    ["after_id", "library_revision"],
    [],
    "saved-script cursor",
  );
  return Object.freeze({
    afterId: requiredPositiveNat64(record.after_id, "cursor script id"),
    libraryRevision: requiredNat64(
      record.library_revision,
      "cursor library revision",
    ),
  });
}

function backendError(
  operation: "list" | "get" | "save" | "delete",
  error: unknown,
): BlastScriptRejectionError | BlastScriptsBackendError {
  if (error instanceof BlastScriptRejectionError) return error;
  return error instanceof BlastScriptsBackendError
    ? error
    : new BlastScriptsBackendError(operation, error);
}

function requiredRecord(value: unknown, label: string): SelfCallObject {
  if (!isJsonObject(value)) throw new Error(`Invalid ${label}`);
  return value as SelfCallObject;
}

function assertExactKeys(
  record: SelfCallObject,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(record);
  if (
    keys.some((key) => !allowed.has(key)) ||
    required.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new Error(`Invalid ${label} fields`);
  }
}

function validateName(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !isUnicodeScalarText(value) ||
    unicodeScalarLength(value) > MAX_SCRIPT_NAME_SCALARS ||
    stringBytes(value) > MAX_SCRIPT_NAME_BYTES ||
    value !== value.trim() ||
    hasUnsafeMetadataControls(value)
  ) {
    throw new Error("Invalid script name");
  }
  return value;
}

function validateDescription(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !isUnicodeScalarText(value) ||
    stringBytes(value) > MAX_DESCRIPTION_BYTES ||
    value !== value.trim() ||
    hasUnsafeMetadataControls(value)
  ) {
    throw new Error("Invalid script description");
  }
  return value;
}

function parseDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return validateDescription(requiredString(value, "script description"));
}

function hasUnsafeMetadataControls(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x206f) ||
      code === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

function parseDigest(value: unknown): string {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new Error("Invalid saved-script source digest");
  }
  return [...value]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
  return value;
}

function requiredNat64(value: unknown, label: string): string {
  const text =
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : requiredString(value, label);
  if (!NAT_PATTERN.test(text) || BigInt(text) > MAX_NAT64) {
    throw new Error(`Invalid ${label}`);
  }
  return text;
}

function requiredPositiveNat64(value: unknown, label: string): string {
  const text = requiredNat64(value, label);
  if (text === "0") throw new Error(`Invalid ${label}`);
  return text;
}

function boundedNatNumber(
  value: unknown,
  label: string,
  maximum: number,
  minimum = 0,
  candidMaximum: bigint = MAX_NAT64,
): number {
  const text = requiredNat64(value, label);
  const exact = BigInt(text);
  if (exact > candidMaximum) throw new Error(`Invalid ${label}`);
  const parsed = Number(exact);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return parsed;
}

function boundedWholeNumber(
  value: number,
  label: string,
  maximum: number,
  minimum = 0,
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function rejectionMessage(
  code: BlastScriptRejectionCode,
  detail: Readonly<Record<string, string>> | null,
): string {
  switch (code) {
    case "revision_conflict":
      return `Saved-script revision conflict (expected ${detail?.expected ?? "?"}, actual ${detail?.actual ?? "?"})`;
    case "cursor_stale":
      return `Saved-script cursor is stale (expected library revision ${detail?.expectedLibraryRevision ?? "?"}, actual ${detail?.actualLibraryRevision ?? "?"})`;
    case "invalid_request":
      return "Saved-script request is invalid";
    case "invalid_name":
      return "Saved-script name is invalid";
    case "invalid_description":
      return "Saved-script description is invalid";
    case "invalid_source":
      return "Saved-script source is invalid";
    case "not_found":
      return "Saved script was not found";
    case "script_limit":
      return "Saved-script count limit reached";
    case "capacity_exhausted":
      return "Saved-script counter capacity is exhausted";
    case "clock_regressed":
      return "Saved-script clock regressed";
    case "corrupt_state":
      return "Saved-script state failed its integrity check";
  }
}
