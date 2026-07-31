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
