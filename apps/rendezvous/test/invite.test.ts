import { describe, expect, test } from "bun:test";
import { decodeAddress, decodeInvite, encodeAddress, encodeInvite, resolvePeer } from "../src/invite";
const invite = { host: "aaaaa-aa", negotiationId: Uint8Array.from({ length: 16 }, (_, i) => i), capability: Uint8Array.from({ length: 16 }, (_, i) => 255 - i), expiresAtNs: "1900000000000000000" };
describe("Rendezvous invite v1", () => {
  test("has a stable canonical round trip", () => { const encoded = encodeInvite(invite); expect(encodeInvite(decodeInvite(encoded))).toBe(encoded); expect(encoded).toStartWith("rv1.aaaaa-aa."); });
  test.each(["", "rv2.aaaaa-aa.00.00.1", " rv1.aaaaa-aa.00000000000000000000000000000000.ffffffffffffffffffffffffffffffff.1", "rv1.bad!.00000000000000000000000000000000.ffffffffffffffffffffffffffffffff.1", "rv1.aaaaa-aa.0000.ffffffffffffffffffffffffffffffff.1", `rv1.aaaaa-aa.${"00".repeat(16)}.${"ff".repeat(16)}.01`])("rejects malformed/noncanonical %s", (value) => expect(() => decodeInvite(value)).toThrow());
});

describe("Rendezvous sharing address", () => {
  test("round-trips a Neutron principal and remains distinct from a protocol invite", () => {
    const encoded = encodeAddress({ host: "mzsit-hx777-77775-qaaba-cai" });
    expect(encoded).toStartWith("RVC1-");
    expect(decodeAddress(encoded).host).toBe("mzsit-hx777-77775-qaaba-cai");
    expect(resolvePeer(encoded)).toBe("mzsit-hx777-77775-qaaba-cai");
    expect(resolvePeer("aaaaa-aa")).toBe("aaaaa-aa");
  });
  test("rejects damaged, noncanonical, and unrelated values", () => {
    for (const value of ["", "RVC1-", "RVC1-%%%%", "RVC2-eyJ2IjoxLCJoIjoiYWFhYWEtYWEifQ", "not a principal"]) expect(() => resolvePeer(value)).toThrow();
  });
});
