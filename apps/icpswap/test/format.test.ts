import { describe, expect, test } from "bun:test";
import {
  formatCompact,
  formatDate,
  formatFeeTier,
  formatIcp,
  formatNumber,
  formatPercent,
  formatPrice,
  formatRelative,
  formatTokenAmount,
  formatUsdCompact,
  shortPrincipal,
  toEpochMs,
  tokenInitials,
  trendOf,
} from "../src/format.ts";


describe("formatCompact", () => {
  test("scales magnitudes", () => {
    expect(formatCompact(1_234)).toBe("1.23K");
    expect(formatCompact(1_234_567)).toBe("1.23M");
    expect(formatCompact(2_500_000_000)).toBe("2.5B");
    expect(formatCompact(3_400_000_000_000)).toBe("3.4T");
  });

  test("groups small values and drops trailing zeros", () => {
    expect(formatCompact(999)).toBe("999");
    expect(formatCompact(12.5)).toBe("12.5");
    expect(formatCompact(0)).toBe("0");
  });

  test("keeps the sign", () => {
    expect(formatCompact(-1_500)).toBe("-1.5K");
  });

  test("rejects non-finite input", () => {
    expect(formatCompact(Number.NaN)).toBe("-");
    expect(formatCompact(Number.POSITIVE_INFINITY)).toBe("-");
  });
});

describe("formatUsdCompact", () => {
  test("prefixes the currency symbol", () => {
    expect(formatUsdCompact(1_234_567)).toBe("$1.23M");
    expect(formatUsdCompact(0)).toBe("$0");
    expect(formatUsdCompact(-2_000)).toBe("-$2K");
  });
});

describe("formatPrice", () => {
  test("keeps small prices readable", () => {
    expect(formatPrice(0.00000123)).toBe("$0.00000123");
    expect(formatPrice(0.0005)).toBe("$0.0005");
    expect(formatPrice(0.5)).toBe("$0.5");
    expect(formatPrice(12.3456789)).toBe("$12.3457");
    expect(formatPrice(12345.6789)).toBe("$12,345.68");
  });

  test("handles zero and invalid values", () => {
    expect(formatPrice(0)).toBe("$0.00");
    expect(formatPrice(Number.NaN)).toBe("-");
  });
});

describe("formatPercent", () => {
  test("signs the value", () => {
    expect(formatPercent(4.25)).toBe("+4.25%");
    expect(formatPercent(-0.8)).toBe("-0.8%");
    expect(formatPercent(0)).toBe("0%");
  });
});

describe("trendOf", () => {
  test("classifies direction", () => {
    expect(trendOf(1)).toBe("up");
    expect(trendOf(-1)).toBe("down");
    expect(trendOf(0)).toBe("flat");
    expect(trendOf(undefined)).toBe("flat");
  });
});

describe("formatFeeTier", () => {
  test("converts hundredths of a basis point to percent", () => {
    expect(formatFeeTier(3000)).toBe("0.3%");
    expect(formatFeeTier(500)).toBe("0.05%");
    expect(formatFeeTier(100)).toBe("0.01%");
  });
});

describe("shortPrincipal", () => {
  test("elides the middle of long ids", () => {
    expect(shortPrincipal("ryjl3-tyaaa-aaaaa-aaaba-cai")).toBe("ryjl3…cai");
  });

  test("keeps short values intact", () => {
    expect(shortPrincipal("aaaaa-aa")).toBe("aaaaa-aa");
  });
});

describe("toEpochMs", () => {
  test("normalizes units", () => {
    expect(toEpochMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(toEpochMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(toEpochMs(1_700_000_000_000_000_000)).toBe(1_700_000_000_000);
    expect(toEpochMs(0)).toBe(0);
  });
});

describe("date helpers", () => {
  test("formats an ISO day", () => {
    expect(formatDate(1_700_000_000)).toBe("2023-11-14");
  });

  test("formats a relative age", () => {
    const now = 1_700_000_000_000;
    expect(formatRelative(1_699_999_970, now)).toBe("30s ago");
    expect(formatRelative(1_699_996_400, now)).toBe("1h ago");
    expect(formatRelative(1_699_800_000, now)).toBe("2d ago");
  });
});

describe("formatTokenAmount", () => {
  test("scales by decimals", () => {
    expect(formatTokenAmount(123_456_789n, 8)).toBe("1.234568");
    expect(formatTokenAmount(1_000_000, 6)).toBe("1");
  });
});

describe("formatNumber", () => {
  test("groups thousands", () => {
    expect(formatNumber(1234567.891, 2)).toBe("1,234,567.89");
    expect(formatNumber(42, 0)).toBe("42");
  });
});

describe("token monogram initials", () => {
  test("keeps chain-key tokens distinguishable", () => {
    expect(tokenInitials("ckBTC", "a")).toBe("BTC");
    expect(tokenInitials("ckETH", "a")).toBe("ETH");
    expect(tokenInitials("ckUSDC", "a")).toBe("USDC");
    expect(tokenInitials("ckUSDT", "a")).toBe("USDT");
  });

  test("handles plain and wrapped symbols", () => {
    expect(tokenInitials("ICP", "a")).toBe("ICP");
    expect(tokenInitials("CHAT", "a")).toBe("CHAT");
    expect(tokenInitials("wICP", "a")).toBe("ICP");
    expect(tokenInitials("Windoge98", "a")).toBe("WIND");
  });

  test("falls back to the ledger id and then a placeholder", () => {
    expect(tokenInitials("", "ryjl3-tyaaa")).toBe("RYJL");
    expect(tokenInitials("", "")).toBe("?");
    expect(tokenInitials("---", "")).toBe("?");
  });
});

describe("formatIcp", () => {
  test("drops needless precision on a large quote", () => {
    // ckBTC is about 32,891 ICP; eight decimals there is noise.
    expect(formatIcp(32891.22792643)).toBe("32,891.23 ICP");
  });

  test("keeps four decimals around unity", () => {
    expect(formatIcp(1.23456789)).toBe("1.2346 ICP");
  });

  test("keeps enough digits for a microcap quote", () => {
    expect(formatIcp(0.00000123)).toBe("0.00000123 ICP");
  });

  test("handles zero and unusable values", () => {
    expect(formatIcp(0)).toBe("0 ICP");
    expect(formatIcp(Number.NaN)).toBe("-");
  });

  test("keeps the sign", () => {
    expect(formatIcp(-2.5)).toBe("-2.5 ICP");
  });
});
