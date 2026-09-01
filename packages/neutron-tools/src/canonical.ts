/**
 * Compare text by Unicode scalar value, independent of the host locale.
 *
 * Capability plans and install journals cross JavaScript and Motoko trust
 * boundaries. Locale collation is unsuitable there: the same input can sort
 * differently on two browsers, while Motoko `Text.compare` has one lexical
 * order. All current identifiers are ASCII, and this scalar ordering also
 * gives future Unicode text one deterministic order.
 */
export function compareCanonicalText(left: string, right: string): number {
  const leftScalars = left[Symbol.iterator]();
  const rightScalars = right[Symbol.iterator]();
  while (true) {
    const leftNext = leftScalars.next();
    const rightNext = rightScalars.next();
    if (leftNext.done || rightNext.done) {
      if (leftNext.done === rightNext.done) return 0;
      return leftNext.done ? -1 : 1;
    }
    const leftCodePoint = leftNext.value.codePointAt(0)!;
    const rightCodePoint = rightNext.value.codePointAt(0)!;
    if (leftCodePoint < rightCodePoint) return -1;
    if (leftCodePoint > rightCodePoint) return 1;
  }
}

/** Serialize an already-validated JSON value with deterministic object-key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean") return String(value);
  if (typeof value === "string" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new Error("Canonical JSON input must be JSON-compatible");
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(compareCanonicalText)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
