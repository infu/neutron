import { expect, test } from "bun:test";
import {
  MailContentCodecError,
  decodeMailPrivateBodyV1,
  decodeMailPrivateHeaderV1,
  encodeMailPrivateBodyV1,
  encodeMailPrivateHeaderV1,
} from "../src/content_codec.ts";

test("header V1 has a frozen deterministic CBOR vector", () => {
  const encoded = encodeMailPrivateHeaderV1({
    contentSchema: 1,
    claimedSenderName: "Ada",
    subject: "Hi",
    senderCreatedAtNs: "24",
    inReplyTo: null,
  });
  expect(hex(encoded)).toBe("a5010102634164610362486904181805f6");
  expect(decodeMailPrivateHeaderV1(encoded)).toEqual({
    contentSchema: 1,
    claimedSenderName: "Ada",
    subject: "Hi",
    senderCreatedAtNs: "24",
    inReplyTo: null,
  });
});

test("header reply id round trips as exact bytes", () => {
  const reply = Uint8Array.from({ length: 16 }, (_, index) => index);
  const encoded = encodeMailPrivateHeaderV1({
    contentSchema: 1,
    claimedSenderName: "Sender",
    subject: "Reply",
    senderCreatedAtNs: "18446744073709551615",
    inReplyTo: reply,
  });
  expect(decodeMailPrivateHeaderV1(encoded).inReplyTo).toEqual(reply);
});

test("body V1 has a frozen deterministic CBOR vector and preserves Markdown", () => {
  const encoded = encodeMailPrivateBodyV1({
    contentSchema: 1,
    bodyMarkdown: "Hi",
  });
  expect(hex(encoded)).toBe("a2010102624869");
  expect(decodeMailPrivateBodyV1(encoded)).toEqual({
    contentSchema: 1,
    bodyMarkdown: "Hi",
  });
});

test("decoder rejects noncanonical, indefinite, duplicate, malformed, and trailing CBOR", () => {
  const validBody = encodeMailPrivateBodyV1({ contentSchema: 1, bodyMarkdown: "x" });
  const cases = [
    // Map length 2, key 1 encoded with ai=24 even though it fits inline.
    bytes("a2180101026178"),
    // Indefinite map.
    bytes("bf0101026178ff"),
    // Duplicate key 1 where key 2 is required.
    bytes("a20101016178"),
    // Text declares one byte containing invalid UTF-8.
    bytes("a201010261ff"),
    // Valid body followed by an extra null.
    Uint8Array.from([...validBody, 0xf6]),
  ];
  for (const encoded of cases) {
    expect(() => decodeMailPrivateBodyV1(encoded)).toThrow(MailContentCodecError);
  }
});

test("decoder rejects wrong schema and wrong map shape", () => {
  expect(() => decodeMailPrivateBodyV1(bytes("a20102026178"))).toThrow("schema");
  expect(() => decodeMailPrivateHeaderV1(bytes("a10101"))).toThrow("map");
});

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}
