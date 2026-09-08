import { describe, expect, test } from "bun:test";
import {
  REQUEST_ID_PATTERN,
  commandIdFor,
  createFundingRequest,
  createRequestId,
  isTerminal,
  parseFundingResult,
  parseFundingRequest,
  requestFunding,
  succeeded,
} from "../src/funding.ts";

const NOW = 1_788_000_000_000;
const POOL = "mohjv-bqaaa-aaaag-qjyia-cai";
const ICP = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const ID = "0123456789abcdef0123456789abcdef";

function request(overrides: Partial<Parameters<typeof createFundingRequest>[0]> = {}) {
  return createFundingRequest({
    requestId: ID,
    ledger: ICP,
    spender: POOL,
    amountAtoms: "100000000",
    nowMs: NOW,
    ...overrides,
  });
}

describe("createRequestId", () => {
  test("is 32 lowercase hex characters, as the Wallet requires", () => {
    expect(createRequestId((bytes) => bytes.fill(0xab))).toBe("ab".repeat(16));
    expect(REQUEST_ID_PATTERN.test(createRequestId((b) => b.fill(1)))).toBe(true);
  });
});

describe("createFundingRequest", () => {
  test("asks for an allowance naming the pool as spender", () => {
    const value = request();
    expect(value.route.kind).toBe("allowance");
    expect(value.route.spender).toBe(POOL);
    expect(value.ledger).toBe(ICP);
  });

  test("sends the bare amount — Wallet adds the transfer fee itself", () => {
    // Approving only `amountIn` would be short by one fee under ICRC-2; the
    // Wallet computes `amount + fee`, so padding here would over-approve.
    expect(request({ amountAtoms: "100000000" }).amountAtoms).toBe("100000000");
  });

  test("stays inside the Wallet's ten-minute ceilings", () => {
    const value = request();
    const nowNs = BigInt(NOW) * 1_000_000n;
    const validity = BigInt(value.validUntilNs) - nowNs;
    const allowance = BigInt(value.route.expiresAtNs) - nowNs;
    const ceiling = 600_000_000_000n;
    expect(validity).toBeLessThanOrEqual(ceiling);
    expect(allowance).toBeLessThanOrEqual(ceiling);
    // The Wallet also requires expiry >= request validity.
    expect(allowance).toBeGreaterThanOrEqual(validity);
  });

  test("expresses times in nanoseconds", () => {
    expect(BigInt(request().validUntilNs) % 1_000_000n).toBe(0n);
  });

  test("refuses a malformed request id", () => {
    expect(() => request({ requestId: "nope" })).toThrow();
    expect(() => request({ requestId: ID.toUpperCase() })).toThrow();
  });

  test("refuses a zero or non-integer amount", () => {
    expect(() => request({ amountAtoms: "0" })).toThrow();
    expect(() => request({ amountAtoms: "1.5" })).toThrow();
    expect(() => request({ amountAtoms: "" })).toThrow();
  });

  test("refuses a missing ledger or spender", () => {
    expect(() => request({ ledger: "" })).toThrow();
    expect(() => request({ spender: "" })).toThrow();
  });
});

describe("retained funding requests", () => {
  test("replay preserves exact deadline and allowance expiry after reopening", async () => {
    const original = request();
    const saved = JSON.stringify(original);
    const restored = parseFundingRequest(JSON.parse(saved));
    const calls: unknown[] = [];
    const client = { callTool: async (call: unknown) => {
      calls.push(call);
      return { status: "pending", commandId: `icpswap:${ID}`, blockIndex: null, duplicate: null, message: "Awaiting reply" };
    } };
    await requestFunding(client as never, original);
    await requestFunding(client as never, restored);
    expect(calls[0]).toEqual(calls[1]);
    expect(JSON.stringify(restored)).toBe(saved);
  });

  test("never invents missing persisted request fields", () => {
    expect(() => parseFundingRequest({ ...request(), validUntilNs: null })).toThrow();
    expect(() => parseFundingRequest({ ...request(), route: { kind: "allowance", spender: POOL, expiresAtNs: "1" } })).toThrow();
  });
});

describe("parseFundingResult", () => {
  const reply = (status: string) => ({
    status,
    commandId: `icpswap:${ID}`,
    blockIndex: "42",
    duplicate: false,
    message: null,
  });

  test("accepts every status the Wallet schema allows", () => {
    for (const status of ["transferred", "approved", "pending", "rejected"]) {
      expect(parseFundingResult(reply(status)).status).toBe(status as never);
    }
  });

  test("does not accept another request's result as funding approval", () => {
    expect(() => parseFundingResult(reply("approved"), "ff".repeat(16))).toThrow("another funding request");
    expect(() => parseFundingResult({ ...reply("approved"), commandId: "" })).toThrow();
    expect(() => parseFundingResult({ ...reply("approved"), blockIndex: "invalid" })).toThrow();
  });

  test("rejects a status outside the schema, including revoked", () => {
    // `revoked` exists in the Wallet's TS type but not in its output schema.
    expect(() => parseFundingResult(reply("revoked"))).toThrow();
    expect(() => parseFundingResult(reply("nonsense"))).toThrow();
    expect(() => parseFundingResult(null)).toThrow();
  });
});

describe("result interpretation", () => {
  const of = (status: string) =>
    parseFundingResult({
      status,
      commandId: `icpswap:${ID}`,
      blockIndex: null,
      duplicate: null,
      message: null,
    });

  test("pending is not terminal — the same id must be reused", () => {
    expect(isTerminal(of("pending"))).toBe(false);
    expect(isTerminal(of("approved"))).toBe(true);
    expect(isTerminal(of("rejected"))).toBe(true);
  });

  test("only approved means the allowance exists", () => {
    expect(succeeded(of("approved"))).toBe(true);
    expect(succeeded(of("rejected"))).toBe(false);
    expect(succeeded(of("pending"))).toBe(false);
  });

  test("commandId is scoped to the calling app", () => {
    expect(commandIdFor("icpswap", ID)).toBe(`icpswap:${ID}`);
  });
});

// The amount parser lives with the panel but is pure; a rounding or precision
// slip here is the difference between swapping 1 ICP and swapping 100,000,000.
import { describeAmountProblem, slippageLabel, toBaseUnits } from "../src/amount.ts";

describe("toBaseUnits", () => {
  test("scales by the token's decimals", () => {
    expect(toBaseUnits("1", 8)).toBe(100_000_000n);
    expect(toBaseUnits("0.001", 8)).toBe(100_000n);
    expect(toBaseUnits("2.5", 6)).toBe(2_500_000n);
    expect(toBaseUnits("0.000001", 6)).toBe(1n);
  });

  test("refuses more precision than the token has", () => {
    // Truncating here would silently swap a different amount than typed.
    expect(toBaseUnits("0.001", 2)).toBeNull();
    expect(toBaseUnits("1.5", 0)).toBeNull();
  });

  test("refuses zero and junk", () => {
    expect(toBaseUnits("0", 8)).toBeNull();
    expect(toBaseUnits("0.00000000", 8)).toBeNull();
    expect(toBaseUnits("", 8)).toBeNull();
    expect(toBaseUnits("abc", 8)).toBeNull();
    expect(toBaseUnits("-1", 8)).toBeNull();
    expect(toBaseUnits("1e8", 8)).toBeNull();
  });

  test("handles a bare fraction and a bare integer", () => {
    expect(toBaseUnits(".5", 8)).toBe(50_000_000n);
    expect(toBaseUnits("7", 0)).toBe(7n);
  });

  test("stays exact far beyond Number.MAX_SAFE_INTEGER", () => {
    expect(toBaseUnits("123456789.12345678", 8)).toBe(12_345_678_912_345_678n);
  });
});

describe("slippageLabel", () => {
  test("renders thousandths of a percent as a percentage", () => {
    expect(slippageLabel(500)).toBe("0.5%");
    expect(slippageLabel(100)).toBe("0.1%");
    expect(slippageLabel(5000)).toBe("5%");
  });
});

describe("describeAmountProblem", () => {
  test("says nothing when the amount is usable or empty", () => {
    expect(describeAmountProblem("1.5", 8, "ICP")).toBeNull();
    expect(describeAmountProblem("", 8, "ICP")).toBeNull();
  });

  test("explains a precision limit rather than failing silently", () => {
    expect(describeAmountProblem("0.001", 2, "ckUSDC")).toContain("2 decimal places");
  });

  test("explains unknown decimals, the case that reads as a dead form", () => {
    expect(describeAmountProblem("0.001", 0, "ckBTC")).toContain("no known decimal places");
  });

  test("explains a zero amount", () => {
    expect(describeAmountProblem("0", 8, "ICP")).toContain("greater than zero");
  });
});

import { fromBaseUnits } from "../src/amount.ts";

describe("fromBaseUnits", () => {
  test("round-trips through toBaseUnits without losing a unit", () => {
    // The Max button depends on this exactly: one atom over the balance fails
    // the swap, one atom short leaves dust that can never be recovered.
    for (const [value, decimals] of [
      [99_980_000n, 8],
      [1n, 8],
      [123_456_789_012_345_678n, 8],
      [7n, 0],
      [1_000_000n, 6],
    ] as const) {
      const text = fromBaseUnits(value, decimals);
      expect(toBaseUnits(text, decimals), `${text} @ ${decimals}`).toBe(value);
    }
  });

  test("trims trailing zeros but keeps the whole part", () => {
    expect(fromBaseUnits(100_000_000n, 8)).toBe("1");
    expect(fromBaseUnits(150_000_000n, 8)).toBe("1.5");
    expect(fromBaseUnits(1n, 8)).toBe("0.00000001");
  });

  test("handles zero decimals and zero value", () => {
    expect(fromBaseUnits(42n, 0)).toBe("42");
    expect(fromBaseUnits(0n, 8)).toBe("0");
  });
});
