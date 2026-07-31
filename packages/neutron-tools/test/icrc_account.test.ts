import { expect, test } from "bun:test";
import { Principal } from "@icp-sdk/core/principal";
import {
  decodeIcrcAccount,
  encodeIcrcAccount,
} from "../src/icrc_account.ts";

const owner = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
const subaccount = Uint8Array.from([...new Array(31).fill(0), 255]);
const encoded = "ryjl3-tyaaa-aaaaa-aaaba-cai-t5ic6yq.ff";

test("encodes the canonical ICRC textual account checksum", () => {
  expect(encodeIcrcAccount({ owner })).toBe(owner.toText());
  expect(encodeIcrcAccount({ owner, subaccount: new Uint8Array(32) })).toBe(
    owner.toText(),
  );
  expect(encodeIcrcAccount({ owner, subaccount })).toBe(encoded);
});

test("decodes principal-only and subaccount ICRC account text", () => {
  const defaultAccount = decodeIcrcAccount(owner.toText());
  expect(defaultAccount.owner.toText()).toBe(owner.toText());
  expect(defaultAccount.subaccount).toBeUndefined();
  const decoded = decodeIcrcAccount(encoded);
  expect(decoded.owner.toText()).toBe(owner.toText());
  expect(decoded.subaccount).toEqual(subaccount);
});

test("rejects malformed subaccounts and checksums", () => {
  expect(() =>
    encodeIcrcAccount({ owner, subaccount: Uint8Array.from([1]) }),
  ).toThrow("exactly 32 bytes");
  expect(() => decodeIcrcAccount(`${owner.toText()}-aaaaaaa.ff`)).toThrow(
    "checksum",
  );
  expect(() => decodeIcrcAccount(`${owner.toText()}-t5ic6yq.${"ff".repeat(33)}`))
    .toThrow();
});
