import { expect, test } from "bun:test";
import { fromBaseUnits, toBaseUnits } from "../src/amount.ts";

test("Max retains all atomic units at ledger precisions above 30", () => {
  for (const decimals of [0, 6, 8, 18, 31, 32, 255]) {
    for (const atoms of [1n, 123456789123456789n, 10n ** BigInt(decimals) + 1n]) {
      expect(toBaseUnits(fromBaseUnits(atoms, decimals), decimals)).toBe(atoms);
    }
  }
  expect(fromBaseUnits(-1n, 6)).toBe("-0.000001");
});

test("invalid precision is not silently converted into another token amount", () => {
  for (const decimals of [-1, 1.5, NaN, Infinity]) {
    expect(toBaseUnits("1", decimals)).toBeNull();
    expect(() => fromBaseUnits(1n, decimals)).toThrow("decimals");
  }
  expect(toBaseUnits("0.0000001", 6)).toBeNull();
});
