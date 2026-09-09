import { describe, expect, test } from "bun:test";
import { amountAtPercent, percentForAmount, spendableBalance } from "../src/amount_allocation.ts";

describe("exact swap balance sizing", () => {
  test("reserves both ledger fees and exhausts neither a dust balance nor gas-independent token principal", () => {
    expect(spendableBalance(1_300_000_000n, 10_000n)).toBe(1_299_980_000n);
    expect(spendableBalance(20_000n, 10_000n)).toBe(0n);
    expect(spendableBalance(10_000n, 10_000n)).toBe(0n);
    expect(spendableBalance(0n, 10_000n)).toBe(0n);
  });
  test("every percentage stays within exact balances larger than Number can represent", () => {
    const max = spendableBalance(98765432109876543210987654321n, 10_000n);
    for (let percentage = 0; percentage <= 100; percentage++) {
      const atoms = amountAtPercent(max, percentage);
      expect(atoms * 100n <= max * BigInt(percentage)).toBe(true);
      expect((atoms + 1n) * 100n > max * BigInt(percentage)).toBe(true);
      expect(percentForAmount(atoms, max)).toBe(percentage);
    }
    expect(amountAtPercent(max, 100)).toBe(max);
    expect(amountAtPercent(max, 0)).toBe(0n);
  });
  test("odd and tiny balances round in atoms, while manual over-budget amounts clamp the thumb", () => {
    expect(amountAtPercent(101n, 50)).toBe(50n);
    expect(percentForAmount(50n, 101n)).toBe(50);
    expect(amountAtPercent(3n, 50)).toBe(1n);
    expect(amountAtPercent(3n, 0)).toBe(0n);
    expect(percentForAmount(4n, 3n)).toBe(100);
    expect(percentForAmount(null, null)).toBe(0);
    expect(percentForAmount(1n, 0n)).toBe(0);
  });
});
