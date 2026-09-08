import { expect, test } from "bun:test";
import {
  formatBasisPoints,
  formatDuration,
  formatPercent,
  formatRewardRate,
  formatTokenAmount,
  formatTokenCompact,
  fromHex,
  parseTokenAmount,
  toHex,
} from "../src/data/format";

// 40 of 54 SNS total supplies exceed Number.MAX_SAFE_INTEGER. Any path that
// touches Number() corrupts them, so this is the load-bearing test in the file.
test("large supplies survive formatting without precision loss", () => {
  const dragginzSupply = 799_984_030_787_530_639n;
  expect(dragginzSupply > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  expect(formatTokenAmount(dragginzSupply, 8, { group: false })).toBe("7999840307.87530639");
  // The naive implementation loses the tail; prove we do not.
  expect(String(Number(dragginzSupply) / 1e8)).not.toBe("7999840307.87530639");
});

test("token amounts format exactly at the ledger's decimals", () => {
  expect(formatTokenAmount(10_000n, 8, { group: false })).toBe("0.0001");
  expect(formatTokenAmount(500_000_000n, 8, { group: false })).toBe("5");
  expect(formatTokenAmount(0n, 8)).toBe("0");
  expect(formatTokenAmount(48_763_325_912_554n, 8, { group: false })).toBe("487633.25912554");
  // Non-8 decimals are real: ckETH is 18, ckUSDC is 6.
  expect(formatTokenAmount(1_000_000_000_000_000_000n, 18, { group: false })).toBe("1");
  expect(formatTokenAmount(1_500_000n, 6, { group: false })).toBe("1.5");
  expect(formatTokenAmount(42n, 0, { group: false })).toBe("42");
});

test("negative amounts keep their sign", () => {
  expect(formatTokenAmount(-10_000n, 8, { group: false })).toBe("-0.0001");
});

test("compact formatting trims to two places for tables", () => {
  expect(formatTokenCompact(48_763_325_912_554n, 8)).toBe("487'633.25");
  expect(formatTokenCompact(0n, 8)).toBe("0");
});

test("parsing rejects excess precision instead of rounding it away", () => {
  expect(parseTokenAmount("0.0001", 8)).toBe(10_000n);
  expect(parseTokenAmount("5", 8)).toBe(500_000_000n);
  expect(parseTokenAmount("7999840307.87530639", 8)).toBe(799_984_030_787_530_639n);
  expect(parseTokenAmount(" 1'234.5 ", 8)).toBe(123_450_000_000n);
  // Nine decimals into an eight-decimal token must fail loudly.
  expect(() => parseTokenAmount("0.000000001", 8)).toThrow(/decimal places/);
  expect(() => parseTokenAmount("abc", 8)).toThrow();
  expect(() => parseTokenAmount("", 8)).toThrow();
});

test("parse and format round-trip", () => {
  for (const value of ["0", "1", "0.0001", "487633.25912554", "7999840307.87530639"]) {
    expect(formatTokenAmount(parseTokenAmount(value, 8), 8, { group: false })).toBe(value);
  }
});

// SNS durations are Julian-based and sit a few hundred seconds off exact
// multiples, so exact-multiple checks fail and flooring is what matches the
// dashboard. Neutrinite's real values are used here.
test("durations floor the way the dashboard renders them", () => {
  expect(formatDuration(2_630_016)).toBe("30 days"); // min dissolve delay to vote
  expect(formatDuration(15_780_096)).toBe("182 days"); // max dissolve delay
  expect(formatDuration(31_557_600)).toBe("1 year"); // max age for age bonus
  expect(formatDuration(378_691_200)).toBe("12 years"); // reward transition
  expect(formatDuration(345_600)).toBe("4 days"); // initial voting period
  expect(formatDuration(86_400)).toBe("1 day");
  expect(formatDuration(0)).toBe("0 seconds");
});

test("percentages and basis points render distinctly", () => {
  expect(formatBasisPoints(200n)).toBe("2%");
  expect(formatBasisPoints(250n)).toBe("2.5%");
  expect(formatPercent(25n)).toBe("25%");
  expect(formatPercent(0n)).toBe("0%");
});

test("reward rate renders like the dashboard", () => {
  expect(
    formatRewardRate({
      initialBasisPoints: 200n,
      finalBasisPoints: 200n,
      transitionSeconds: 378_691_200n,
    }),
  ).toBe("2% to 2% over 12 years");
  expect(formatRewardRate({ initialBasisPoints: undefined, finalBasisPoints: 200n })).toBeNull();
});

test("hex round-trips", () => {
  const bytes = Uint8Array.from([0, 1, 15, 16, 255]);
  expect(toHex(bytes)).toBe("00010f10ff");
  expect(Array.from(fromHex("00010f10ff"))).toEqual(Array.from(bytes));
  expect(Array.from(fromHex("0x00ff"))).toEqual([0, 255]);
  expect(() => fromHex("abc")).toThrow();
  expect(() => fromHex("zz")).toThrow();
});

// The bigint arithmetic below would otherwise throw "Cannot mix BigInt and
// other types", which names neither the offending value nor the caller — and
// took down a whole page render when one field arrived as a number.
test("a non-bigint amount is refused by name", () => {
  expect(() => formatTokenAmount(1 as unknown as bigint, 8)).toThrow(/must be a bigint, got number/);
  expect(() => formatTokenAmount(undefined as unknown as bigint, 8)).toThrow(
    /must be a bigint, got undefined/,
  );
});
