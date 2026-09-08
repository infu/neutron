import { describe, expect, test } from "bun:test";
import JSBI from "jsbi";
import { Price, Token } from "@uniswap/sdk-core";
import {
  maxLiquidityForAmounts, priceToClosestTick, SqrtPriceMath, TickMath,
} from "@uniswap/v3-sdk";
import {
  amountsForLiquidity, getSqrtRatioAtTick, liquidityForAmounts, MAX_TICK,
  MIN_TICK, priceToTick, Q96, tickToPrice, usableTickRange,
} from "../src/liquidity_math";

const integer = (value: bigint) => JSBI.BigInt(value.toString());
const atom = (value: JSBI) => BigInt(value.toString());
const token = (address: number, decimals: number) => new Token(
  1, `0x${address.toString(16).padStart(40, "0")}`, decimals,
);
const fraction = (decimal: string): [bigint, bigint] => {
  const [whole = "", part = ""] = decimal.split(".");
  return [BigInt(`${whole || "0"}${part}`), 10n ** BigInt(part.length)];
};

describe("ICPSwap Q96 liquidity arithmetic", () => {
  test("tick ratios match the independent SDK across extremes and both signs", () => {
    const ticks = [MIN_TICK, MIN_TICK + 1, -600000, -35226, -60, -1, 0, 1, 60, 198146, 600000, MAX_TICK - 1, MAX_TICK];
    for (let i = 0; i < 100; i++) ticks.push(MIN_TICK + Math.floor(i * (MAX_TICK - MIN_TICK) / 99));
    for (const tick of ticks) {
      expect(getSqrtRatioAtTick(tick)).toBe(atom(TickMath.getSqrtRatioAtTick(tick)));
    }
  });

  test("full ranges preserve mathematical rounding of negative ticks", () => {
    expect(usableTickRange(10)).toEqual({ lower: -887270, upper: 887270 });
    expect(usableTickRange(60)).toEqual({ lower: -887220, upper: 887220 });
    expect(usableTickRange(200)).toEqual({ lower: -887200, upper: 887200 });
    expect(usableTickRange(1)).toEqual({ lower: MIN_TICK, upper: MAX_TICK });
  });

  test("mint liquidity and round-up consumption agree with protocol-equivalent SDK mode", () => {
    const cases = [
      // Live ICP / ckUSDC pool orientation and mixed-decimal atom budgets.
      { tick: -35226, lower: -35520, upper: -34920, amount0: 100000000n, amount1: 3000000n },
      { tick: 198146, lower: 198040, upper: 198240, amount0: 700000n, amount1: 300000000000000n },
      { tick: -120, lower: -60, upper: 60, amount0: 12345678901234567890n, amount1: 0n },
      { tick: 120, lower: -60, upper: 60, amount0: 0n, amount1: 12345678901234567890n },
      { tick: 0, lower: 0, upper: 60, amount0: 1234567n, amount1: 0n },
      { tick: 60, lower: 0, upper: 60, amount0: 0n, amount1: 1234567n },
      { tick: 0, lower: -887220, upper: 887220, amount0: 9007199254740993000n, amount1: 2345678901234567890n },
    ];
    for (let i = 0; i < 50; i++) {
      const lower = -50000 + i * 1800;
      cases.push({ tick: lower + 240, lower, upper: lower + 600, amount0: 9345793457n + BigInt(i), amount1: 945734590345345n + BigInt(i) });
    }
    for (const c of cases) {
      const p = getSqrtRatioAtTick(c.tick);
      const a = getSqrtRatioAtTick(c.lower);
      const b = getSqrtRatioAtTick(c.upper);
      const actual = liquidityForAmounts(p, a, b, c.amount0, c.amount1);
      const expected = maxLiquidityForAmounts(integer(p), integer(a), integer(b), integer(c.amount0), integer(c.amount1), false);
      expect(actual).toBe(atom(expected));
      expect(liquidityForAmounts(p, b, a, c.amount0, c.amount1)).toBe(actual);
      for (const roundUp of [false, true]) {
        const amounts = amountsForLiquidity(p, a, b, actual, roundUp);
        const expected0 = p >= b ? 0n : atom(SqrtPriceMath.getAmount0Delta(integer(p <= a ? a : p), integer(b), expected, roundUp));
        const expected1 = p <= a ? 0n : atom(SqrtPriceMath.getAmount1Delta(integer(a), integer(p >= b ? b : p), expected, roundUp));
        expect(amounts).toEqual({ amount0: expected0, amount1: expected1 });
        expect(amounts.amount0 <= c.amount0).toBe(true);
        expect(amounts.amount1 <= c.amount1).toBe(true);
      }
    }
  });

  test("token0 intermediate rounding matches ICPSwap rather than full-precision SDK mode", () => {
    const a = getSqrtRatioAtTick(-887220);
    const b = getSqrtRatioAtTick(-887160);
    const amount = 10n ** 36n;
    const actual = liquidityForAmounts(a, a, b, amount, 0n);
    const routerMode = atom(maxLiquidityForAmounts(integer(a), integer(a), integer(b), integer(amount), integer(0n), false));
    const fullPrecision = atom(maxLiquidityForAmounts(integer(a), integer(a), integer(b), integer(amount), integer(0n), true));
    expect(actual).toBe(routerMode);
    expect(actual).toBe(0n);
    expect(fullPrecision > actual).toBe(true);
  });

  test("removal previews round down while mint consumption rounds up", () => {
    const a = getSqrtRatioAtTick(-60);
    const b = getSqrtRatioAtTick(60);
    expect(amountsForLiquidity(Q96, a, b, 1n)).toEqual({ amount0: 0n, amount1: 0n });
    expect(amountsForLiquidity(Q96, a, b, 1n, true)).toEqual({ amount0: 1n, amount1: 1n });
    expect(amountsForLiquidity(Q96, a, b, 0n, true)).toEqual({ amount0: 0n, amount1: 0n });
  });

  test("rejects invalid wire values and uint128 liquidity overflow", () => {
    for (const tick of [MIN_TICK - 1, MAX_TICK + 1, NaN, 0.5, Infinity]) expect(() => getSqrtRatioAtTick(tick)).toThrow();
    for (const spacing of [0, -1, 0.5, NaN, Infinity, MAX_TICK + 1]) expect(() => usableTickRange(spacing)).toThrow();
    expect(() => liquidityForAmounts(Q96, Q96, Q96, 1n, 1n)).toThrow();
    expect(() => liquidityForAmounts(0n, 1n, 2n, 1n, 1n)).toThrow();
    expect(() => liquidityForAmounts(Q96, Q96 - 1n, Q96 + 1n, -1n, 1n)).toThrow();
    expect(() => liquidityForAmounts(Q96, Q96 - 1n, Q96 + 1n, 1n << 256n, 1n)).toThrow();
    expect(() => liquidityForAmounts(Q96, Q96 - 1n, Q96 + 1n, 1n << 128n, 1n << 128n)).toThrow("Liquidity");
    expect(() => amountsForLiquidity(Q96, Q96 - 1n, Q96 + 1n, 1n << 128n)).toThrow("Liquidity");
  });
});

describe("decimal price and aligned ticks", () => {
  test("price strings represent the exact SDK Q96 ratio without floating point", () => {
    for (const tick of [MIN_TICK, -35226, -1, 0, 1, 198146, MAX_TICK]) {
      for (const [decimals0, decimals1] of [[8, 6], [6, 18], [18, 6], [0, 255], [255, 0]]) {
        const [n, d] = fraction(tickToPrice(tick, decimals0!, decimals1!));
        const q = atom(TickMath.getSqrtRatioAtTick(tick));
        expect(n * (Q96 * Q96) * (10n ** BigInt(decimals1!))).toBe(d * q * q * (10n ** BigInt(decimals0!)));
      }
    }
    expect(tickToPrice(0, 8, 6)).toBe("100");
    expect(tickToPrice(0, 6, 18)).toBe("0.000000000001");
  });

  test("decimal inputs agree with SDK price-to-tick and align outward in both signs", () => {
    for (const [price, decimals0, decimals1] of [
      ["1", 18, 18], ["1.01", 18, 18], ["0.99", 18, 18],
      ["2.400000000000000001", 8, 6], ["2483.07", 18, 6],
      ["0.000000000000000000009007199254740993", 6, 18],
    ] as const) {
      const [numerator, denominator] = fraction(price);
      const sdkPrice = new Price(token(1, decimals0), token(2, decimals1), (denominator * 10n ** BigInt(decimals0)).toString(), (numerator * 10n ** BigInt(decimals1)).toString());
      const tick = priceToClosestTick(sdkPrice);
      for (const spacing of [10, 60, 200]) {
        expect(priceToTick(price, decimals0, decimals1, spacing, "down")).toBe(Math.floor(tick / spacing) * spacing);
        const exact = price === "1" && decimals0 === decimals1;
        expect(priceToTick(price, decimals0, decimals1, spacing, "up")).toBe(Math.ceil((exact ? tick : tick + 1) / spacing) * spacing || 0);
      }
    }
    expect(priceToTick("0.99", 18, 18, 10, "down")).toBe(-110);
    expect(priceToTick("0.99", 18, 18, 10, "up")).toBe(-100);
  });

  test("exact aligned boundaries round-trip including minimum and maximum ticks", () => {
    for (const spacing of [1, 10, 60, 200]) {
      const range = usableTickRange(spacing);
      for (const tick of [range.lower, -spacing, 0, spacing, range.upper]) {
        for (const [d0, d1] of [[8, 6], [6, 18], [255, 0]]) {
          const price = tickToPrice(tick, d0!, d1!);
          expect(priceToTick(price, d0!, d1!, spacing, "down")).toBe(tick);
          expect(priceToTick(price, d0!, d1!, spacing, "up")).toBe(tick);
        }
      }
    }
  });

  test("invalid/outside prices fail instead of silently changing the requested bounds", () => {
    for (const price of ["0", "-1", "NaN", "Infinity", "1e-3", " 1", "1.2.3", ""]) {
      expect(() => priceToTick(price, 8, 6, 60, "down")).toThrow();
    }
    expect(() => priceToTick("0.00000000000000000000000000000000000000000000001", 0, 0, 60, "down")).toThrow();
    expect(() => priceToTick(tickToPrice(MIN_TICK, 8, 6), 8, 6, 60, "down")).toThrow("usable tick");
    expect(() => priceToTick(tickToPrice(MAX_TICK, 8, 6), 8, 6, 60, "up")).toThrow("usable tick");
    expect(() => tickToPrice(0, 256, 8)).toThrow("nat8");
    expect(() => tickToPrice(0, -1, 8)).toThrow("nat8");
  });
});
