import type { JsonObject, JsonValue } from "neutron-tools/protocol";
import { BLAST_LIMITS, BLAST_STORED_V1_JSON_LIMITS } from "./limits.ts";

const encoder = new TextEncoder();
const LONE_SURROGATE_PATTERN = /[\uD800-\uDFFF]/u;
export const BLAST_METHOD_CONTROL_PATTERN_SOURCE = "[\\u0000-\\u001f\\u007f]";
const METHOD_CONTROL_PATTERN = new RegExp(
  BLAST_METHOD_CONTROL_PATTERN_SOURCE,
  "u",
);
const ERROR_REPLACEMENT_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\uD800-\uDFFF]/u;

/** True only when a JavaScript string consists of Unicode scalar values. */
export function isUnicodeScalarText(value: string): boolean {
  return !LONE_SURROGATE_PATTERN.test(value);
}

/** Count Unicode scalar values rather than UTF-16 code units. */
export function unicodeScalarLength(value: string): number {
  return Array.from(value).length;
}

/** Validate one exact Candid method name without trimming or normalization. */
export function requiredBlastMethodName(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !isUnicodeScalarText(value) ||
    unicodeScalarLength(value) > BLAST_LIMITS.canisterMethodCharacters ||
    METHOD_CONTROL_PATTERN.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidJson(label: string): never {
  throw new Error(`${label} must be JSON-compatible`);
}

type ValidationFrame =
  | { kind: "value"; value: unknown; depth: number }
  | { kind: "leave"; value: object };

function inspectBlastJson(
  value: unknown,
  label: string,
  maximumDepth: number,
  maximumNodes: number,
): number {
  const ancestors = new WeakSet<object>();
  const stack: ValidationFrame[] = [{ kind: "value", value, depth: 0 }];
  let nodes = 1;

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === "leave") {
      ancestors.delete(frame.value);
      continue;
    }
    if (frame.depth > maximumDepth) {
      throw new Error(`${label} is nested too deeply`);
    }

    const current = frame.value;
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return invalidJson(label);
      continue;
    }
    if (typeof current !== "object" || current === null) {
      return invalidJson(label);
    }

    const isArray = Array.isArray(current);
    if (
      (isArray && Object.getPrototypeOf(current) !== Array.prototype) ||
      (!isArray && !isPlainObject(current))
    ) {
      return invalidJson(label);
    }
    if (ancestors.has(current) || "toJSON" in current) {
      return invalidJson(label);
    }

    const keys = Reflect.ownKeys(current);
    const descriptors = Object.getOwnPropertyDescriptors(current) as Record<
      string,
      PropertyDescriptor | undefined
    >;
    const children: unknown[] = [];

    if (isArray) {
      const length = current.length;
      if (keys.length !== length + 1) return invalidJson(label);
      const lengthDescriptor = descriptors.length;
      if (
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        lengthDescriptor.enumerable
      ) {
        return invalidJson(label);
      }
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          !descriptor.enumerable
        ) {
          return invalidJson(label);
        }
        children.push(descriptor.value);
      }
    } else {
      for (const key of keys) {
        if (typeof key !== "string" || key === "toJSON") {
          return invalidJson(label);
        }
        const descriptor = descriptors[key];
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          !descriptor.enumerable
        ) {
          return invalidJson(label);
        }
        children.push(descriptor.value);
      }
    }

    if (children.length > maximumNodes - nodes) {
      throw new Error(`${label} contains too many values`);
    }
    nodes += children.length;
    ancestors.add(current);
    stack.push({ kind: "leave", value: current });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({
        kind: "value",
        value: children[index],
        depth: frame.depth + 1,
      });
    }
  }
  return nodes;
}

function validateBlastJson(
  value: unknown,
  label: string,
  maximumDepth: number,
  maximumNodes: number,
): asserts value is JsonValue {
  inspectBlastJson(value, label, maximumDepth, maximumNodes);
}

export function jsonBytes(value: JsonValue): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

export function stringBytes(value: string): number {
  return encoder.encode(value).byteLength;
}

export function assertBoundedBlastJson(
  value: unknown,
  label: string,
  maxBytes: number,
): asserts value is JsonValue {
  boundedBlastJsonBytes(value, label, maxBytes);
}

/** Validate an immutable browser-local schema-v1 value written by v0.1.0. */
export function assertBoundedBlastStoredV1Json(
  value: unknown,
  label: string,
  maxBytes: number,
): asserts value is JsonValue {
  boundedBlastJsonBytesWithLimits(
    value,
    label,
    maxBytes,
    BLAST_STORED_V1_JSON_LIMITS.depth,
    BLAST_STORED_V1_JSON_LIMITS.nodes,
  );
}

/** Count nodes while validating one immutable browser-local schema-v1 value. */
export function blastStoredV1JsonNodeCount(
  value: unknown,
  label: string,
): number {
  return inspectBlastJson(
    value,
    label,
    BLAST_STORED_V1_JSON_LIMITS.depth,
    BLAST_STORED_V1_JSON_LIMITS.nodes,
  );
}

/**
 * Validate a protocol envelope around an already independently bounded value.
 * The small structural reserve prevents Blast's own object/array wrappers from
 * making an otherwise valid maximum-depth or maximum-node value unreachable.
 */
export function assertBoundedBlastJsonEnvelope(
  value: unknown,
  label: string,
  maxBytes: number,
): asserts value is JsonValue {
  boundedBlastJsonBytes(value, label, maxBytes, {
    additionalDepth: BLAST_LIMITS.jsonEnvelopeDepth,
    additionalNodes: BLAST_LIMITS.jsonEnvelopeNodes,
  });
}

/** Validate a protocol envelope containing one retained schema-v1 value. */
export function assertBoundedBlastStoredV1JsonEnvelope(
  value: unknown,
  label: string,
  maxBytes: number,
): asserts value is JsonValue {
  boundedBlastJsonBytesWithLimits(
    value,
    label,
    maxBytes,
    BLAST_STORED_V1_JSON_LIMITS.depth + BLAST_LIMITS.jsonEnvelopeDepth,
    BLAST_STORED_V1_JSON_LIMITS.nodes + BLAST_LIMITS.jsonEnvelopeNodes,
  );
}

/** Validate Blast's complete JSON budget and return its one computed size. */
export function boundedBlastJsonBytes(
  value: unknown,
  label: string,
  maxBytes: number,
  allowance: Readonly<{
    additionalDepth: number;
    additionalNodes: number;
  }> = { additionalDepth: 0, additionalNodes: 0 },
): number {
  return boundedBlastJsonBytesWithLimits(
    value,
    label,
    maxBytes,
    BLAST_LIMITS.jsonDepth + allowance.additionalDepth,
    BLAST_LIMITS.jsonNodes + allowance.additionalNodes,
  );
}

function boundedBlastJsonBytesWithLimits(
  value: unknown,
  label: string,
  maxBytes: number,
  maximumDepth: number,
  maximumNodes: number,
): number {
  validateBlastJson(value, label, maximumDepth, maximumNodes);
  const bytes = jsonBytes(value);
  if (bytes > maxBytes) throw new Error(`${label} is too large`);
  return bytes;
}

export function requiredObject(value: unknown, label: string): JsonObject {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  validateBlastJson(
    value,
    label,
    BLAST_LIMITS.jsonDepth,
    BLAST_LIMITS.jsonNodes,
  );
  return value as JsonObject;
}

export function requiredString(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function naturalNumber(
  value: unknown,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  ) {
    throw new Error(`${label} must be a bounded non-negative integer`);
  }
  return value;
}

export function boundedError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const scalars = Array.from(raw, (scalar) =>
    ERROR_REPLACEMENT_PATTERN.test(scalar) ? "�" : scalar,
  );
  return scalars.length <= 1_000
    ? scalars.join("")
    : `${scalars.slice(0, 997).join("")}...`;
}

/** Normalize an untrusted error without letting its coercion strand a caller. */
export function boundedErrorOr(error: unknown, fallback: string): string {
  try {
    return boundedError(error);
  } catch {
    return fallback;
  }
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function randomId(prefix: string): string {
  const random = new Uint8Array(16);
  crypto.getRandomValues(random);
  return `${prefix}_${[...random]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
