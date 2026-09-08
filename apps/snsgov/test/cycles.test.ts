/**
 * Cycles arithmetic and the cost of asking for it.
 *
 * A balance routinely exceeds `Number.MAX_SAFE_INTEGER` by three orders of
 * magnitude — Neutrinite's governance canister alone holds ~1.5e14 — so the
 * conversion to TCycles is integer maths throughout. Dividing as a float would
 * quietly drop real digits.
 */

import { expect, test } from "bun:test";
import { formatTCycles } from "../src/data/root";

const T = 1_000_000_000_000n;

test("whole trillions render without a fraction", () => {
  expect(formatTCycles(0n)).toBe("0T");
  expect(formatTCycles(T)).toBe("1T");
  expect(formatTCycles(93n * T)).toBe("93T");
});

test("fractions are truncated, not rounded, and trailing zeros trimmed", () => {
  // 93.951... — the real root balance measured on mainnet.
  expect(formatTCycles(93_951_889_123_456n)).toBe("93.951T");
  expect(formatTCycles(T + T / 2n)).toBe("1.5T");
  expect(formatTCycles(T + T / 1000n)).toBe("1.001T");
  // Below the last kept digit disappears rather than rounding up.
  expect(formatTCycles(T + T / 10_000n)).toBe("1T");
});

// The whole reason this is not `Number(cycles) / 1e12`.
test("a balance past Number.MAX_SAFE_INTEGER keeps every digit", () => {
  const huge = 7_272_755_123_456_789_012n;
  expect(Number(huge) > Number.MAX_SAFE_INTEGER).toBe(true);
  expect(formatTCycles(huge)).toBe("7272755.123T");
  expect(formatTCycles(huge, 0)).toBe("7272755T");
});

test("a negative balance keeps its sign", () => {
  expect(formatTCycles(-T)).toBe("-1T");
});
