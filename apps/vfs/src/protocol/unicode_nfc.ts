import {
  UNICODE_ASSIGNED_RANGE_COUNT,
  UNICODE_ASSIGNED_RANGES_BASE64,
  UNICODE_COMBINING_CLASS_RANGE_COUNT,
  UNICODE_COMBINING_CLASS_RANGES_BASE64,
  UNICODE_COMPOSITION_COUNT,
  UNICODE_COMPOSITIONS_BASE64,
  UNICODE_DECOMPOSITION_COUNT,
  UNICODE_DECOMPOSITION_INDEX_BASE64,
  UNICODE_DECOMPOSITION_POOL_BASE64,
  UNICODE_LICENSE_NOTICE,
  UNICODE_MAX_CANONICAL_DECOMPOSITION,
  UNICODE_NFC_VERSION,
  UNICODE_QUICK_CHECK_RANGE_COUNT,
  UNICODE_QUICK_CHECK_RANGES_BASE64,
} from "./unicode_nfc_data.generated.ts";

export {
  UNICODE_LICENSE_NOTICE,
  UNICODE_MAX_CANONICAL_DECOMPOSITION,
  UNICODE_NFC_VERSION,
};

const S_BASE = 0xac00;
const L_BASE = 0x1100;
const V_BASE = 0x1161;
const T_BASE = 0x11a7;
const L_COUNT = 19;
const V_COUNT = 21;
const T_COUNT = 28;
const N_COUNT = 588;
const S_COUNT = 11_172;

const assignedRanges = decodeBase64(UNICODE_ASSIGNED_RANGES_BASE64);
const combiningClassRanges = decodeBase64(
  UNICODE_COMBINING_CLASS_RANGES_BASE64,
);
const decompositionIndex = decodeBase64(
  UNICODE_DECOMPOSITION_INDEX_BASE64,
);
const decompositionPool = decodeBase64(
  UNICODE_DECOMPOSITION_POOL_BASE64,
);
const compositions = decodeBase64(UNICODE_COMPOSITIONS_BASE64);
const quickCheckRanges = decodeBase64(
  UNICODE_QUICK_CHECK_RANGES_BASE64,
);

/**
 * Normalize a well-formed string with Unicode 16.0 NFC, rejecting scalars
 * that were unassigned in Unicode 16.0. This is independent of the host
 * browser/JavaScript engine's Unicode tables.
 */
export function normalizeUnicode16Npss(value: string): string | null {
  const scalars = assignedScalars(value);
  if (scalars === null) return null;

  let needsNormalization = false;
  let lastCombiningClass = 0;
  for (const scalar of scalars) {
    const combiningClass = canonicalCombiningClass(scalar);
    if (
      combiningClass !== 0 &&
      lastCombiningClass > combiningClass
    ) {
      needsNormalization = true;
    }
    if (quickCheck(scalar) !== 0) needsNormalization = true;
    lastCombiningClass = combiningClass;
  }
  if (!needsNormalization) return value;

  const decomposed: number[] = [];
  for (const scalar of scalars) {
    if (isHangulSyllable(scalar)) {
      const syllableIndex = scalar - S_BASE;
      appendCanonicalOrdered(
        decomposed,
        L_BASE + Math.floor(syllableIndex / N_COUNT),
      );
      appendCanonicalOrdered(
        decomposed,
        V_BASE + Math.floor((syllableIndex % N_COUNT) / T_COUNT),
      );
      const trailingIndex = syllableIndex % T_COUNT;
      if (trailingIndex !== 0) {
        appendCanonicalOrdered(decomposed, T_BASE + trailingIndex);
      }
      continue;
    }
    const decomposition = canonicalDecomposition(scalar);
    if (decomposition === null) {
      appendCanonicalOrdered(decomposed, scalar);
      continue;
    }
    const [offset, length] = decomposition;
    for (let index = 0; index < length; index += 1) {
      appendCanonicalOrdered(
        decomposed,
        u24(decompositionPool, (offset + index) * 3),
      );
    }
  }

  const composed: number[] = [];
  let starterIndex: number | undefined;
  lastCombiningClass = 0;
  for (const scalar of decomposed) {
    const combiningClass = canonicalCombiningClass(scalar);
    let consumed = false;
    if (
      starterIndex !== undefined &&
      (lastCombiningClass === 0 ||
        lastCombiningClass < combiningClass)
    ) {
      const combined = compose(composed[starterIndex]!, scalar);
      if (combined !== undefined) {
        composed[starterIndex] = combined;
        consumed = true;
      }
    }
    if (!consumed) {
      composed.push(scalar);
      if (combiningClass === 0) {
        starterIndex = composed.length - 1;
        lastCombiningClass = 0;
      } else {
        lastCombiningClass = combiningClass;
      }
    }
  }
  return scalarsToText(composed);
}

/** True only for exact Unicode 16.0 NFC made entirely of assigned scalars. */
export function isUnicode16Npss(value: string): boolean {
  return normalizeUnicode16Npss(value) === value;
}

export function isUnicode16Control(scalar: number): boolean {
  return (
    scalar <= 0x1f ||
    (scalar >= 0x7f && scalar <= 0x9f)
  );
}

// Unicode White_Space is explicit so edge-name grammar does not depend on
// browser/compiler property tables.
export function isUnicode16WhiteSpace(scalar: number): boolean {
  return (
    (scalar >= 0x09 && scalar <= 0x0d) ||
    scalar === 0x20 ||
    scalar === 0x85 ||
    scalar === 0xa0 ||
    scalar === 0x1680 ||
    (scalar >= 0x2000 && scalar <= 0x200a) ||
    (scalar >= 0x2028 && scalar <= 0x2029) ||
    scalar === 0x202f ||
    scalar === 0x205f ||
    scalar === 0x3000
  );
}

function assignedScalars(value: string): number[] | null {
  const scalars: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    let scalar: number;
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(index + 1);
      if (!(second >= 0xdc00 && second <= 0xdfff)) return null;
      scalar =
        0x10000 +
        ((first - 0xd800) << 10) +
        (second - 0xdc00);
      index += 1;
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      return null;
    } else {
      scalar = first;
    }
    if (!isAssigned(scalar)) return null;
    scalars.push(scalar);
  }
  return scalars;
}

function scalarsToText(scalars: readonly number[]): string {
  let output = "";
  const chunkSize = 1_024;
  for (let offset = 0; offset < scalars.length; offset += chunkSize) {
    output += String.fromCodePoint(
      ...scalars.slice(offset, offset + chunkSize),
    );
  }
  return output;
}

function appendCanonicalOrdered(output: number[], scalar: number): void {
  const combiningClass = canonicalCombiningClass(scalar);
  let insertion = output.length;
  while (combiningClass !== 0 && insertion > 0) {
    const previousClass = canonicalCombiningClass(output[insertion - 1]!);
    if (
      previousClass === 0 ||
      previousClass <= combiningClass
    ) {
      break;
    }
    insertion -= 1;
  }
  output.splice(insertion, 0, scalar);
}

function canonicalCombiningClass(scalar: number): number {
  const offset = rangeRecord(
    combiningClassRanges,
    UNICODE_COMBINING_CLASS_RANGE_COUNT,
    7,
    scalar,
  );
  return offset === null ? 0 : combiningClassRanges[offset + 6]!;
}

function quickCheck(scalar: number): number {
  const offset = rangeRecord(
    quickCheckRanges,
    UNICODE_QUICK_CHECK_RANGE_COUNT,
    7,
    scalar,
  );
  return offset === null ? 0 : quickCheckRanges[offset + 6]!;
}

function isAssigned(scalar: number): boolean {
  return (
    rangeRecord(
      assignedRanges,
      UNICODE_ASSIGNED_RANGE_COUNT,
      6,
      scalar,
    ) !== null
  );
}

function canonicalDecomposition(
  scalar: number,
): readonly [offset: number, length: number] | null {
  let low = 0;
  let high = UNICODE_DECOMPOSITION_COUNT;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const offset = middle * 6;
    const candidate = u24(decompositionIndex, offset);
    if (scalar < candidate) {
      high = middle;
    } else if (scalar > candidate) {
      low = middle + 1;
    } else {
      return [
        u16(decompositionIndex, offset + 3),
        decompositionIndex[offset + 5]!,
      ];
    }
  }
  return null;
}

function compose(first: number, second: number): number | undefined {
  if (
    first >= L_BASE && first < L_BASE + L_COUNT &&
    second >= V_BASE && second < V_BASE + V_COUNT
  ) {
    return (
      S_BASE +
      (first - L_BASE) * N_COUNT +
      (second - V_BASE) * T_COUNT
    );
  }
  if (
    isHangulSyllable(first) &&
    (first - S_BASE) % T_COUNT === 0 &&
    second > T_BASE &&
    second < T_BASE + T_COUNT
  ) {
    return first + second - T_BASE;
  }

  let low = 0;
  let high = UNICODE_COMPOSITION_COUNT;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const offset = middle * 9;
    const candidateFirst = u24(compositions, offset);
    const candidateSecond = u24(compositions, offset + 3);
    if (
      first < candidateFirst ||
      (first === candidateFirst && second < candidateSecond)
    ) {
      high = middle;
    } else if (
      first > candidateFirst ||
      (first === candidateFirst && second > candidateSecond)
    ) {
      low = middle + 1;
    } else {
      return u24(compositions, offset + 6);
    }
  }
  return undefined;
}

function rangeRecord(
  data: Uint8Array,
  count: number,
  width: number,
  scalar: number,
): number | null {
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const offset = middle * width;
    const first = u24(data, offset);
    const last = u24(data, offset + 3);
    if (scalar < first) {
      high = middle;
    } else if (scalar > last) {
      low = middle + 1;
    } else {
      return offset;
    }
  }
  return null;
}

function isHangulSyllable(scalar: number): boolean {
  return scalar >= S_BASE && scalar < S_BASE + S_COUNT;
}

function u16(data: Uint8Array, offset: number): number {
  return data[offset]! * 0x100 + data[offset + 1]!;
}

function u24(data: Uint8Array, offset: number): number {
  return (
    data[offset]! * 0x10000 +
    data[offset + 1]! * 0x100 +
    data[offset + 2]!
  );
}

function decodeBase64(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }
  return output;
}
