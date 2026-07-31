import type { JsonObject, JsonValue } from "neutron-tools/app";
import { FILES_V2_LIMITS } from "./constants.ts";
import {
  FilesProtocolValueError,
  parseCanonicalNat64,
  parseFilesId128,
  parseNat32,
} from "./ids.ts";
import type {
  FilesOutcomeV2,
  FilesReadChunkOkV2,
  FilesReadChunkOutcomeV2,
  FilesReadChunkRejectionCodeV2,
  FilesReadChunkRequestV2,
  FilesRejectedV2,
  FilesRejectionReasonV2,
} from "./types.ts";

const REJECTION_REASONS = new Set<FilesRejectionReasonV2>([
  "not_ready",
  "invalid_request",
  "not_found",
  "not_file",
  "not_folder",
  "invalid_index",
  "already_exists",
  "stale_revision",
  "stale_content",
  "cursor_stale",
  "id_collision",
  "batch_structure_limit",
  "conflict",
  "quota",
  "busy",
  "aborted",
  "expired",
  "superseded",
  "temporarily_unavailable",
  "incompatible",
  "corrupt_state",
]);

export function assertNormalizedRequest(
  value: unknown,
  label = "Files request",
): asserts value is JsonObject {
  assertPlainObject(value, label);
  const counters = { depth: 0, elements: 0 };
  validateJsonValue(value, label, 0, counters);
  const encoded = JSON.stringify(value);
  if (
    new TextEncoder().encode(encoded).byteLength >
    FILES_V2_LIMITS.normalizedValueBytes
  ) {
    throw new FilesProtocolValueError(
      "FILES_REQUEST_TOO_LARGE",
      `${label} exceeds the normalized value bound`,
    );
  }
}

export function parseFilesOutcome(
  value: unknown,
  label = "Files response",
): FilesOutcomeV2 {
  const response = normalizeBoundedResponse(value, label);
  if (!Object.prototype.hasOwnProperty.call(response, "outcome")) {
    // The unified self-call projector omits an absent Candid option when it is
    // nested in a record. Treat that representation exactly like the legacy
    // explicit null projection.
    return Object.freeze({ kind: "unsupported" });
  }
  const outcome = response.outcome;
  if (outcome === null) return Object.freeze({ kind: "unsupported" });
  const variant = singleVariant(outcome, `${label}.outcome`);
  if (variant.tag === "ok") {
    return Object.freeze({
      kind: "ok",
      value: normalizeCandidJsonValue(
        variant.value,
        `${label}.outcome.ok`,
      ),
    });
  }
  if (variant.tag === "rejected") {
    return Object.freeze({
      kind: "rejected",
      rejection: parseRejection(variant.value, `${label}.outcome.rejected`),
    });
  }
  throw invalidResponse(`${label}.outcome contains an unsupported normalized tag`);
}

export function encodeFilesReadChunkRequest(
  request: FilesReadChunkRequestV2,
): JsonObject {
  const encoded: JsonObject = {
    node_id: {
      hi: parseCanonicalNat64(request.node_id.hi, "node_id.hi"),
      lo: parseCanonicalNat64(request.node_id.lo, "node_id.lo"),
    },
    structural_revision: parseCanonicalNat64(
      request.structural_revision,
      "structural_revision",
    ),
    content_id: {
      hi: parseCanonicalNat64(request.content_id.hi, "content_id.hi"),
      lo: parseCanonicalNat64(request.content_id.lo, "content_id.lo"),
    },
    index: parseNat32(request.index, "index"),
  };
  assertNormalizedRequest(encoded, "Read chunk request");
  return encoded;
}

export function parseFilesReadChunkResponse(
  value: unknown,
  body: ArrayBuffer,
): FilesReadChunkOutcomeV2 {
  if (!(body instanceof ArrayBuffer)) {
    throw invalidResponse("Read chunk body is not an ArrayBuffer");
  }
  const response = normalizeBoundedResponse(value, "Read chunk response");
  if (!Object.prototype.hasOwnProperty.call(response, "outcome")) {
    return Object.freeze({
      kind: "unsupported",
      body: emptyBody(),
    });
  }
  if (response.outcome === null) {
    return Object.freeze({
      kind: "unsupported",
      body: emptyBody(),
    });
  }
  const outcome = singleVariant(response.outcome, "Read chunk outcome");
  if (outcome.tag === "rejected") {
    const rejection = parseRejection(outcome.value, "Read chunk rejection");
    const reason = rejection.reason?.tag ?? null;
    return Object.freeze({
      kind: "rejected",
      reason: reason as FilesReadChunkRejectionCodeV2 | null,
      retryAfterNs: rejection.retryAfterNs,
      body: emptyBody(),
    });
  }
  if (outcome.tag !== "ok") {
    throw invalidResponse("Read chunk outcome contains an unknown normalized tag");
  }
  const ok = requireRecord(outcome.value, "Read chunk success");
  const frameKindVariant =
    ok.frame_kind === undefined || ok.frame_kind === null
      ? null
      : singleVariant(ok.frame_kind, "Read chunk frame kind");
  if (
    frameKindVariant === null ||
    (frameKindVariant.tag !== "first" &&
      frameKindVariant.tag !== "continuation")
  ) {
    return Object.freeze({
      kind: "unsupported",
      body: emptyBody(),
    });
  }
  const parsed: FilesReadChunkOkV2 = Object.freeze({
    nodeId: parseFilesId128(ok.node_id, "Read chunk node_id"),
    structuralRevision: parseCanonicalNat64(
      ok.structural_revision,
      "Read chunk structural_revision",
    ),
    metadataRevision: parseCanonicalNat64(
      ok.metadata_revision,
      "Read chunk metadata_revision",
    ),
    contentId: parseFilesId128(ok.content_id, "Read chunk content_id"),
    index: parseNat32(ok.index, "Read chunk index"),
    blockCount: parseNat32(ok.block_count, "Read chunk block_count"),
    ciphertextBlockBytes: parseNat32(
      ok.ciphertext_block_bytes,
      "Read chunk ciphertext_block_bytes",
    ),
    ciphertextTotalBytes: parseCanonicalNat64(
      ok.ciphertext_total_bytes,
      "Read chunk ciphertext_total_bytes",
    ),
    frameKind: frameKindVariant.tag,
  });
  if (parsed.blockCount < 1 || parsed.index >= parsed.blockCount) {
    throw invalidResponse("Read chunk index/count binding is invalid");
  }
  // The attachment is the complete FilesFrameV2, not the raw ciphertext
  // block. In particular, index zero also carries encrypted metadata and the
  // wrapped content key. The inner frame decoder owns the correlated proof
  // that its raw ciphertext slice is exactly ciphertextBlockBytes.
  if (
    body.byteLength === 0 ||
    body.byteLength > FILES_V2_METHOD_READ_BODY_MAX
  ) {
    throw invalidResponse("Read chunk frame body is empty or exceeds its bound");
  }
  return Object.freeze({
    kind: "ok",
    value: parsed,
    body,
  });
}

export function parseRejection(
  value: unknown,
  label = "Files rejection",
): FilesRejectedV2 {
  const rejection = requireRecord(value, label);
  let reason: FilesRejectedV2["reason"] = null;
  if (rejection.reason !== undefined && rejection.reason !== null) {
    const variant = singleVariant(rejection.reason, `${label}.reason`);
    if (!REJECTION_REASONS.has(variant.tag as FilesRejectionReasonV2)) {
      throw invalidResponse(`${label}.reason contains an unsupported normalized tag`);
    }
    const normalizedValue = normalizeCandidJsonValue(
      variant.value,
      `${label}.reason.${variant.tag}`,
    );
    reason = Object.freeze({
      tag: variant.tag as FilesRejectionReasonV2,
      value: normalizedValue,
    });
  }
  const retryAfterNs =
    rejection.retry_after_ns === undefined || rejection.retry_after_ns === null
      ? null
      : parseCanonicalNat64(rejection.retry_after_ns, `${label}.retry_after_ns`);
  return Object.freeze({
    reason,
    retryAfterNs,
    raw: rejection as JsonObject,
  });
}

export function bodyForSuccessfulOutcome(
  outcome: FilesOutcomeV2,
  body: ArrayBuffer,
): ArrayBuffer {
  if (!(body instanceof ArrayBuffer)) {
    throw invalidResponse("Files attachment body is not an ArrayBuffer");
  }
  return outcome.kind === "ok" ? body : emptyBody();
}

export function requireRecord(
  value: unknown,
  label: string,
): Record<string, JsonValue> {
  assertPlainObject(value, label);
  return value as Record<string, JsonValue>;
}

export function singleVariant(
  value: unknown,
  label: string,
): { tag: string; value: unknown } {
  const record = requireRecord(value, label);
  const keys = Object.keys(record);
  if (keys.length !== 1) {
    throw invalidResponse(`${label} must contain exactly one variant tag`);
  }
  const tag = keys[0]!;
  return { tag, value: record[tag] };
}

export function assertJsonValue(value: unknown, label: string): asserts value is JsonValue {
  const counters = { depth: 0, elements: 0 };
  validateJsonValue(value, label, 0, counters);
}

export function normalizeCandidJsonValue(
  value: unknown,
  label = "Candid value",
): JsonValue {
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw invalidResponse(`${label} contains a negative bigint`);
    }
    return value.toString();
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw invalidResponse(`${label} contains a non-finite number`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      normalizeCandidJsonValue(item, `${label}[${index}]`)
    );
  }
  assertPlainObject(value, label);
  const normalized: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    normalized[key] = normalizeCandidJsonValue(item, `${label}.${key}`);
  }
  assertJsonValue(normalized, label);
  return normalized;
}

const FILES_V2_METHOD_READ_BODY_MAX = 1_900_000;

function normalizeBoundedResponse(
  value: unknown,
  label: string,
): Record<string, JsonValue> {
  const counters = { depth: 0, elements: 0 };
  validateJsonValue(value, label, 0, counters, true);
  const normalized = normalizeCandidJsonValue(value, label);
  const response = requireRecord(normalized, label);
  if (
    new TextEncoder().encode(JSON.stringify(response)).byteLength >
    FILES_V2_LIMITS.normalizedValueBytes
  ) {
    throw new FilesProtocolValueError(
      "FILES_RESPONSE_TOO_LARGE",
      `${label} exceeds the normalized value bound`,
    );
  }
  return response;
}

function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalidResponse(`${label} must be a plain object`);
  }
}

function validateJsonValue(
  value: unknown,
  label: string,
  depth: number,
  counters: { depth: number; elements: number },
  allowBigInt = false,
): void {
  if (depth > FILES_V2_LIMITS.candidDepth) {
    throw new FilesProtocolValueError(
      "FILES_JSON_DEPTH",
      `${label} exceeds the normalized depth bound`,
    );
  }
  counters.depth = Math.max(counters.depth, depth);
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (allowBigInt && typeof value === "bigint")
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw invalidResponse(`${label} contains a non-finite number`);
    }
    return;
  }
  if (Array.isArray(value)) {
    counters.elements += value.length;
    assertElementBound(counters.elements, label);
    value.forEach((item, index) =>
      validateJsonValue(
        item,
        `${label}[${index}]`,
        depth + 1,
        counters,
        allowBigInt,
      )
    );
    return;
  }
  assertPlainObject(value, label);
  const entries = Object.entries(value);
  counters.elements += entries.length;
  assertElementBound(counters.elements, label);
  for (const [key, item] of entries) {
    validateJsonValue(
      item,
      `${label}.${key}`,
      depth + 1,
      counters,
      allowBigInt,
    );
  }
}

function assertElementBound(elements: number, label: string): void {
  if (elements > FILES_V2_LIMITS.candidDecodedElements) {
    throw new FilesProtocolValueError(
      "FILES_JSON_ELEMENTS",
      `${label} exceeds the normalized element bound`,
    );
  }
}

function invalidResponse(message: string): FilesProtocolValueError {
  return new FilesProtocolValueError("FILES_INVALID_RESPONSE", message);
}

function emptyBody(): ArrayBuffer {
  return new ArrayBuffer(0);
}
