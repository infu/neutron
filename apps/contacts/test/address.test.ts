import { describe, expect, test } from "bun:test";
import { createBase58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { Principal } from "@dfinity/principal";
import {
  normalizeBitcoin,
  normalizeDogecoin,
  normalizeEthereum,
  normalizeInternetComputer,
  normalizeNeutron,
  normalizeSolana,
} from "../src/address.ts";

describe("Neutron addresses", () => {
  const canister = "ryjl3-tyaaa-aaaaa-aaaba-cai";

  test("canonicalizes a canister principal and rejects self", () => {
    expect(normalizeNeutron(` ${canister} `)).toEqual({
      network: "neutron",
      principal: canister,
    });
    expect(() => normalizeNeutron(canister, canister)).toThrow("not this one");
  });

  test("rejects non-canister and malformed principals", () => {
    const user = Principal.selfAuthenticating(new Uint8Array([1, 2, 3])).toText();
    for (const value of ["not-a-principal", "2vxsx-fae", "aaaaa-aa", user]) {
      expect(() => normalizeNeutron(value)).toThrow();
    }
  });
});

describe("Bitcoin mainnet addresses", () => {
  test("accepts Base58, BIP-173 v0, and BIP-350 v1 vectors", () => {
    expect(normalizeBitcoin("1BoatSLRHtKNngkdXEeobR76b53LETtpyT")).toBe(
      "1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
    );
    expect(normalizeBitcoin("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy")).toBe(
      "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy",
    );
    expect(normalizeBitcoin("BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4")).toBe(
      "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    );
    expect(
      normalizeBitcoin(
        "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3",
      ),
    ).toBe(
      "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3",
    );
    expect(
      normalizeBitcoin(
        "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
      ),
    ).toBe(
      "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
    );
  });

  test("rejects wrong networks, checksums, versions, and mixed case", () => {
    for (const value of [
      "tc1qw508d6qejxtdg4y5r3zarvary0c5xw7kg3g4ty",
      "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5",
      "tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq47Zagq",
      "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd",
      "1BoatSLRHtKNngkdXEeobR76b53LETtpyU",
    ]) {
      expect(() => normalizeBitcoin(value)).toThrow();
    }
  });
});

test("Dogecoin requires a valid mainnet Base58Check prefix", () => {
  const coder = createBase58check(sha256);
  const p2pkh = coder.encode(Uint8Array.from([30, ...new Uint8Array(20).fill(7)]));
  const p2sh = coder.encode(Uint8Array.from([22, ...new Uint8Array(20).fill(9)]));
  const bitcoin = coder.encode(Uint8Array.from([0, ...new Uint8Array(20).fill(7)]));
  expect(normalizeDogecoin(p2pkh)).toBe(p2pkh);
  expect(normalizeDogecoin(p2sh)).toBe(p2sh);
  expect(() => normalizeDogecoin(bitcoin)).toThrow("Dogecoin mainnet");
});

test("Ethereum verifies and emits EIP-55 checksum casing", () => {
  expect(normalizeEthereum("0x52908400098527886e0f7030069857d2e4169ee7")).toBe(
    "0x52908400098527886E0F7030069857D2E4169EE7",
  );
  expect(normalizeEthereum("0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359")).toBe(
    "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
  );
  expect(() =>
    normalizeEthereum("0xfb6916095ca1df60bB79Ce92cE3Ea74c37c5d359"),
  ).toThrow("EIP-55");
  expect(() => normalizeEthereum(`0x${"0".repeat(40)}`)).toThrow("zero address");
});

test("Solana requires one canonical 32-byte Base58 key", () => {
  expect(normalizeSolana("11111111111111111111111111111111")).toBe(
    "11111111111111111111111111111111",
  );
  expect(() => normalizeSolana("1111111111111111111111111111111")).toThrow(
    "32 bytes",
  );
  expect(() => normalizeSolana("0OIl")).toThrow("Base58");
});

test("IC accounts use canonical ICRC textual encoding", () => {
  expect(normalizeInternetComputer(" ryjl3-tyaaa-aaaaa-aaaba-cai ")).toEqual({
    network: "internet_computer",
    account: "ryjl3-tyaaa-aaaaa-aaaba-cai",
  });
  expect(
    normalizeInternetComputer("ryjl3-tyaaa-aaaaa-aaaba-cai-t5ic6yq.ff"),
  ).toEqual({
    network: "internet_computer",
    account: "ryjl3-tyaaa-aaaaa-aaaba-cai-t5ic6yq.ff",
  });
  expect(() => normalizeInternetComputer("2vxsx-fae")).toThrow("Anonymous");
  expect(() => normalizeInternetComputer("ryjl3-tyaaa-aaaaa-aaaba-cai-bad.ff"))
    .toThrow("ICRC");
});
