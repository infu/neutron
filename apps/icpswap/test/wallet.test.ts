import { describe, expect, test } from "bun:test";
import { parseTokenInfo, readTokenInfo } from "../src/wallet.ts";

const REPLY = {
  ledger: "ryjl3-tyaaa-aaaaa-aaaba-cai",
  account: "ryjl3-tyaaa-aaaaa-aaaba-cai",
  name: "Internet Computer",
  symbol: "ICP",
  decimals: 8,
  feeAtoms: "10000",
  balanceAtoms: "123456789",
  observedAtNs: "1788000000000000000",
};

describe("parseTokenInfo", () => {
  test("reads the fields a swap depends on", () => {
    const info = parseTokenInfo(REPLY);
    expect(info.decimals).toBe(8);
    expect(info.feeAtoms).toBe(10_000n);
    expect(info.balanceAtoms).toBe(123_456_789n);
    expect(info.symbol).toBe("ICP");
  });

  test("keeps amounts exact beyond Number.MAX_SAFE_INTEGER", () => {
    const info = parseTokenInfo({
      ...REPLY,
      balanceAtoms: "123456789012345678901",
    });
    expect(info.balanceAtoms).toBe(123_456_789_012_345_678_901n);
  });

  test("refuses a reply with no usable decimals", () => {
    // Guessing precision is how an amount silently becomes the wrong amount.
    expect(() => parseTokenInfo({ ...REPLY, decimals: "8" })).toThrow();
    expect(() => parseTokenInfo({ ...REPLY, decimals: 1.5 })).toThrow();
    expect(() => parseTokenInfo(null)).toThrow();
  });

  test("does not treat an unavailable fee or balance as a successful zero observation", () => {
    for (const field of ["feeAtoms", "balanceAtoms", "observedAtNs"] as const) {
      for (const value of ["not-a-number", "", null, -1, "1.1", "01"]) {
        expect(() => parseTokenInfo({ ...REPLY, [field]: value })).toThrow();
      }
    }
    expect(parseTokenInfo({ ...REPLY, feeAtoms: "0", balanceAtoms: "0" }).balanceAtoms).toBe(0n);
  });

  test("requires usable account identity and ledger precision", () => {
    for (const decimals of [-1, 256]) expect(() => parseTokenInfo({ ...REPLY, decimals })).toThrow();
    for (const field of ["ledger", "account", "symbol"] as const) {
      expect(() => parseTokenInfo({ ...REPLY, [field]: "" })).toThrow();
    }
  });

  test("matches the Wallet reply to the requested ledger through the supplied client", async () => {
    const requested: unknown[] = [];
    const client = { callTool: async (call: unknown) => { requested.push(call); return REPLY; } };
    const info = await readTokenInfo(client as never, REPLY.ledger);
    expect(info.ledger).toBe(REPLY.ledger);
    expect(requested).toEqual([{ target: "app:wallet:background", name: "wallet_token_info_v1", arguments: { ledger: REPLY.ledger } }]);
    await expect(readTokenInfo(client as never, "xevnm-gaaaa-aaaar-qafnq-cai")).rejects.toThrow("another ledger");
  });

  test("accepts a missing name", () => {
    expect(parseTokenInfo({ ...REPLY, name: null }).name).toBeNull();
  });
});
