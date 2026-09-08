import { expect, test } from "bun:test";
import { Principal } from "@dfinity/principal";
import {
  decodeIcrcAccount,
  encodeIcrcAccount,
  icpTreasuryAccount,
  isDefaultSubaccount,
  snsTreasuryAccount,
} from "../src/data/accounts";
import { toHex } from "../src/data/format";

const NEUTRINITE_GOVERNANCE = "eqsml-lyaaa-aaaaq-aacdq-cai";
const SAMPLE_OWNER = "k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae";

function subaccount(lastByte: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes[31] = lastByte;
  return bytes;
}

// The vectors below were cross-checked against @icp-sdk/canisters/ledger/icrc
// (the official implementation): 12/12 encodings matched, and its decoder
// accepts ours. A checksum bug here sends tokens to the wrong account, so this
// is deliberately pinned to exact strings rather than round-trip-only.
test("ICRC-1 textual encoding matches the official implementation", () => {
  const owner = Principal.fromText(SAMPLE_OWNER);

  // Default subaccount collapses to the bare principal.
  expect(encodeIcrcAccount({ owner })).toBe(SAMPLE_OWNER);
  expect(encodeIcrcAccount({ owner, subaccount: new Uint8Array(32) })).toBe(SAMPLE_OWNER);

  expect(encodeIcrcAccount({ owner, subaccount: subaccount(1) })).toBe(
    `${SAMPLE_OWNER}-6cc627i.1`,
  );
});

test("ICRC-1 textual accounts round-trip", () => {
  const owner = Principal.fromText(NEUTRINITE_GOVERNANCE);
  for (const sub of [undefined, subaccount(1), subaccount(255), Uint8Array.from({ length: 32 }, (_, i) => i)]) {
    const account = sub === undefined ? { owner } : { owner, subaccount: sub };
    const decoded = decodeIcrcAccount(encodeIcrcAccount(account));
    expect(decoded.owner.toText()).toBe(NEUTRINITE_GOVERNANCE);
    if (sub === undefined || isDefaultSubaccount(sub)) {
      expect(decoded.subaccount).toBeUndefined();
    } else {
      expect(toHex(decoded.subaccount as Uint8Array)).toBe(toHex(sub));
    }
  }
});

test("a bare principal parses as the default subaccount", () => {
  const decoded = decodeIcrcAccount(NEUTRINITE_GOVERNANCE);
  expect(decoded.owner.toText()).toBe(NEUTRINITE_GOVERNANCE);
  expect(decoded.subaccount).toBeUndefined();
});

test("a corrupted checksum is rejected rather than silently accepted", () => {
  const owner = Principal.fromText(SAMPLE_OWNER);
  const good = encodeIcrcAccount({ owner, subaccount: subaccount(1) });
  const bad = good.replace("-6cc627i.", "-6cc627a.");
  expect(bad).not.toBe(good);
  expect(() => decodeIcrcAccount(bad)).toThrow(/checksum/i);
});

test("malformed textual accounts are rejected", () => {
  expect(() => decodeIcrcAccount("")).toThrow();
  // Leading zeros in the subaccount are not canonical.
  expect(() => decodeIcrcAccount(`${SAMPLE_OWNER}-6cc627i.01`)).toThrow();
  // Missing checksum segment.
  expect(() => decodeIcrcAccount(`${SAMPLE_OWNER}.1`)).toThrow();
});

// Verified against mainnet: this subaccount reproduces Neutrinite's NTN
// treasury balance, and matches what governance's own get_metrics reports.
test("SNS treasury subaccount derivation matches mainnet", async () => {
  const account = await snsTreasuryAccount(NEUTRINITE_GOVERNANCE);
  expect(account.owner.toText()).toBe(NEUTRINITE_GOVERNANCE);
  expect(toHex(account.subaccount as Uint8Array)).toBe(
    "61474b071a860b279575c954ce5f3598f4f863f8c6f450860cd3c3114316ef2d",
  );
});

// governance's icp_treasury_subaccount() returns None. Deriving one here would
// read a zero balance and look like a bug rather than a wrong account.
test("ICP treasury uses the default subaccount, not a derived one", () => {
  const account = icpTreasuryAccount(NEUTRINITE_GOVERNANCE);
  expect(account.owner.toText()).toBe(NEUTRINITE_GOVERNANCE);
  expect(account.subaccount).toBeUndefined();
});
