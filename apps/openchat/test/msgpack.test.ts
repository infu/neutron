import { expect, test } from "bun:test";
import { decodeMsgpack, encodeMsgpack } from "../src/oc/msgpack.ts";
import { randomMessageId } from "../src/oc/clients.ts";

// These lock in the wire conventions our client relies on to be byte-compatible
// with OpenChat's rmp_serde(.with_struct_map().with_large_ints_as_strings())
// canisters: name-keyed struct maps, externally-tagged enums, raw byte fields,
// u64 ids as bigint, and omission of None (null/undefined) fields.

test("structs round-trip as name-keyed maps", () => {
  const value = { username: "ada", forwarding: false, block_level_markdown: false };
  expect(decodeMsgpack<typeof value>(encodeMsgpack(value))).toEqual(value);
});

test("externally-tagged enum content round-trips", () => {
  const content = { Text: { text: "hello world" } };
  expect(decodeMsgpack<typeof content>(encodeMsgpack(content))).toEqual(content);
});

test("byte fields round-trip as Uint8Array (principals, keys)", () => {
  const bytes = new Uint8Array([1, 2, 3, 250, 255, 0]);
  const decoded = decodeMsgpack<{ recipient: Uint8Array }>(encodeMsgpack({ recipient: bytes }));
  expect(decoded.recipient).toBeInstanceOf(Uint8Array);
  expect(Array.from(decoded.recipient)).toEqual(Array.from(bytes));
});

test("u64 message ids survive as exact bigints", () => {
  const messageId = randomMessageId();
  expect(typeof messageId).toBe("bigint");
  const decoded = decodeMsgpack<{ message_id: bigint }>(encodeMsgpack({ message_id: messageId }));
  expect(BigInt(decoded.message_id as unknown as string | number | bigint)).toBe(messageId);
});

test("None fields travel as msgpack nil (serde reads them as Option::None)", () => {
  // We send null for optional (serde Option) fields; on the wire that is a
  // msgpack nil, which rmp_serde decodes to None just like an omitted field.
  const decoded = decodeMsgpack<Record<string, unknown>>(
    encodeMsgpack({ text: "hi", thread_root_message_index: null, replies_to: null }),
  );
  expect(decoded.text).toBe("hi");
  expect(decoded.thread_root_message_index).toBeNull();
  expect(decoded.replies_to).toBeNull();
});

test("set_avatar args round-trip: bigint id + serde_bytes data as msgpack bin", () => {
  const data = new Uint8Array([255, 216, 255, 0, 1, 2, 3]); // JPEG-ish bytes
  const args = { avatar: { id: 4242n, mime_type: "image/jpeg", data } };
  const out = decodeMsgpack<typeof args>(encodeMsgpack(args));
  expect(out.avatar.id).toBe(4242n); // bigint preserved (Document.id: u128)
  expect(out.avatar.mime_type).toBe("image/jpeg");
  expect(out.avatar.data).toBeInstanceOf(Uint8Array); // serde_bytes = msgpack bin
  expect(Array.from(out.avatar.data)).toEqual(Array.from(data));
});
