import { describe, expect, test } from "bun:test";
import { normalizeToolDescriptor, validateToolResult } from "neutron-tools/app";
import { formatPoolAmount, parsePoolComposition, poolCompositionOutputSchema } from "../src/pool_composition.ts";

const reportedPool = {
  poolId: "f3cfb-liaaa-aaaar-qcaja-cai",
  token0LedgerId: "6ehy3-xyaaa-aaaaj-qsdrq-cai",
  token0Symbol: "AETH",
  token0LiquidityAmount: "9.00000138",
  token0Price: "23373791.661271749618854400",
  token1LedgerId: "ryjl3-tyaaa-aaaaa-aaaba-cai",
  token1Symbol: "ICP",
  token1LiquidityAmount: "0.09449168",
  token1Price: "2.420858615560198000",
  tvlUSD: "210364157.478783520000000000",
};

describe("reported pool composition", () => {
  test("exposes the actual reported token quantities behind a huge TVL", () => {
    const composition = parsePoolComposition(reportedPool);
    expect(composition.token0).toEqual({
      ledger_id: reportedPool.token0LedgerId, symbol: "AETH",
      amount_tokens: "9.00000138", amount_available: true,
      amount_atoms: null, decimals: null,
      reported_price_usd: "23373791.661271749618854400",
    });
    expect(composition.token1.amount_tokens).toBe("0.09449168");
    expect(composition.reported_tvl_usd).toBe("210364157.478783520000000000");
    expect(composition.source).toBe("icpswap-info-api");
    expect(composition.snapshot_time).toBeNull();
    expect(composition.note).toContain("not verified custody balances or executable trade depth");
  });

  test("a tiny paired quantity survives without guessing token decimals or atomic units", () => {
    const composition = parsePoolComposition({ ...reportedPool,
      token0LiquidityAmount: "99822760.50857113", token1LiquidityAmount: "0.00000016",
    });
    expect(composition.token0.amount_tokens).toBe("99822760.50857113");
    expect(composition.token1.amount_tokens).toBe("0.00000016");
    expect(composition.token1.amount_available).toBe(true);
    expect(composition.token1.decimals).toBeNull();
    expect(composition.token1.amount_atoms).toBeNull();
  });

  test("preserves precision beyond JS numbers without using TVL to infer missing amounts", () => {
    const composition = parsePoolComposition({ ...reportedPool,
      token0LiquidityAmount: "123456789012345678901234567890.0000000000000000001",
      token1LiquidityAmount: null,
    });
    expect(composition.token0.amount_tokens).toBe("123456789012345678901234567890.0000000000000000001");
    expect(composition.token1.amount_tokens).toBeNull();
    expect(composition.token1.amount_available).toBe(false);
    expect(composition.reported_tvl_usd).toBe(reportedPool.tvlUSD);
  });

  test("distinguishes known zero from unknown, invalid, negative and inexact numeric fields", () => {
    const zero = parsePoolComposition({ token0LiquidityAmount: "0.00000000", token1LiquidityAmount: 0 });
    expect(zero.token0.amount_available).toBe(true);
    expect(zero.token0.amount_tokens).toBe("0.00000000");
    expect(zero.token1.amount_tokens).toBe("0");
    for (const value of [undefined, null, "", " ", "-1", "NaN", "1e-8", 0.1, Number.MAX_SAFE_INTEGER + 1, Infinity, {}, []]) {
      const composition = parsePoolComposition({ token0LiquidityAmount: value });
      expect(composition.token0.amount_tokens).toBeNull();
      expect(composition.token0.amount_available).toBe(false);
    }
  });

  test("validates available and unavailable responses through the real tool schema", () => {
    const descriptor = normalizeToolDescriptor({ name: "pool_composition", inputSchema: { type: "object" }, outputSchema: poolCompositionOutputSchema });
    expect(() => validateToolResult(descriptor, parsePoolComposition(reportedPool))).not.toThrow();
    expect(() => validateToolResult(descriptor, parsePoolComposition(null))).not.toThrow();
    const invalid = parsePoolComposition(reportedPool);
    expect(() => validateToolResult(descriptor, { ...invalid, token0: { ...invalid.token0, decimals: 0 } })).toThrow();
    expect(() => validateToolResult(descriptor, { ...invalid, token1: { ...invalid.token1, amount_tokens: 0.09449168 } })).toThrow();
  });
});

describe("pool token quantity display", () => {
  test("keeps the tiny quoted side visible instead of rounding it to zero", () => {
    expect(formatPoolAmount("0.00000016")).toBe("0.00000016");
    expect(formatPoolAmount("0.00000002")).toBe("0.00000002");
    expect(formatPoolAmount("0.09449168")).toBe("0.094491");
    expect(formatPoolAmount("0.000000000000000000123456789")).toBe("1.23456e-19");
  });

  test("compacts large amounts without losing magnitude or overflowing through Number", () => {
    expect(formatPoolAmount("99822760.50857113")).toBe("99.82M");
    expect(formatPoolAmount("999999999999999999999999999999999999999999.1")).toBe("9.99999e+41");
    expect(formatPoolAmount("1234567890123.45")).toBe("1.23T");
    expect(formatPoolAmount("1000")).toBe("1K");
    expect(formatPoolAmount("999.5")).toBe("999.5");
  });

  test("retains zero and unavailable as different displays and normalizes leading zeros", () => {
    expect(formatPoolAmount("000.0000")).toBe("0");
    expect(formatPoolAmount("000009.00000138")).toBe("9.000001");
    expect(formatPoolAmount("0000000.00000016")).toBe("0.00000016");
    expect(formatPoolAmount(null)).toBe("Unavailable");
    expect(formatPoolAmount("NaN")).toBe("Unavailable");
  });
});
