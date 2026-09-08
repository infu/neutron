import { describe, expect, test } from "bun:test";
import { formatLiquidityAmount, formatLiquidityUsd, liquidityPairValue, liquidityRangeProgress, liquidityUsdValue } from "../src/liquidity_display.ts";

describe("position valuation display", () => {
  test("values actual atomic principal and requires every nonzero leg to be priced", () => {
    const icp = liquidityUsdValue("9686761", { decimals: 8, priceUsd: 2.92 });
    const usdc = liquidityUsdValue("299999", { decimals: 6, priceUsd: 1 });
    expect(icp).toBeCloseTo(0.2828534212, 12);
    expect(liquidityPairValue([icp, usdc])).toBeCloseTo(0.5828524212, 12);
    for (const priceUsd of [null, undefined, 0, -1, NaN, Infinity]) {
      expect(liquidityUsdValue("299999", { decimals: 6, ...(priceUsd === undefined ? {} : { priceUsd }) })).toBeNull();
    }
    expect(liquidityUsdValue("1", { decimals: null, priceUsd: 2 })).toBeNull();
    expect(liquidityPairValue([icp, null])).toBeNull();
    expect(liquidityUsdValue("0", { decimals: null })).toBe(0);
    expect(liquidityUsdValue(null, { decimals: 8, priceUsd: 2.92 })).toBeNull();
    expect(liquidityPairValue([Number.MAX_VALUE, Number.MAX_VALUE])).toBeNull();
  });

  test("small earned fees never round down to a displayed zero", () => {
    expect(formatLiquidityAmount("1", 8)).toBe("<0.000001");
    expect(formatLiquidityAmount("100", 8)).toBe("0.000001");
    expect(formatLiquidityAmount("0", 8)).toBe("0");
    expect(formatLiquidityAmount("1234567891011", 8)).toBe("12,345.67891");
    expect(formatLiquidityAmount("3", 0)).toBe("3");
    expect(formatLiquidityAmount(null, 6)).toBe("Unavailable");
    expect(formatLiquidityAmount("35", null)).toBe("35 atoms");
    expect(formatLiquidityUsd(0.000001)).toBe("<$0.01");
    expect(formatLiquidityUsd(-0.000001)).toBe("-<$0.01");
    expect(formatLiquidityUsd(0)).toBe("$0.00");
    expect(formatLiquidityUsd(null)).toBe("—");
  });

  test("current price marker uses price distance and clamps prices outside the range", () => {
    const lower = -35460, upper = -35100, tick = -35280;
    const price = (tick: number) => Math.pow(1.0001, tick);
    expect(liquidityRangeProgress(lower, upper, tick)).toBeCloseTo((price(tick) - price(lower)) / (price(upper) - price(lower)), 10);
    expect(liquidityRangeProgress(lower, upper, lower)).toBe(0);
    expect(liquidityRangeProgress(lower, upper, upper + 1)).toBe(1);
    expect(liquidityRangeProgress(lower, upper, null)).toBeNull();
    expect(liquidityRangeProgress(upper, lower, tick)).toBeNull();
    expect(Number.isFinite(liquidityRangeProgress(-887272, 887272, 0)!)).toBe(true);
  });
});
