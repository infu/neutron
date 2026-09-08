import { expect, test } from "bun:test";
import { Principal } from "@dfinity/principal";
import {
  messageImage,
  messagePreview,
  messagesFromEvents,
  parseUserSummariesV2,
  pickPrimaryChannel,
  userCanisterId,
} from "../src/oc/view.ts";

const SENDER = "2vxsx-fae"; // a short, real principal; its bytes round-trip via principalText
const senderBytes = (): Uint8Array => Principal.fromText(SENDER).toUint8Array();

test("messagesFromEvents unwraps ChatEvent::Message and skips non-message events", () => {
  // The events list is Vec<EventWrapper<ChatEvent>>: a message is the enum
  // variant { Message: {...} }; system events are other variants — a bare-string
  // unit variant ("Empty") or a data variant ({ ParticipantJoined: {...} }).
  // Reading wrapper.event.content directly (the old bug) skipped every message.
  const events = [
    { index: 5, timestamp: 1000, event: "Empty" },
    { index: 6, timestamp: 2000, event: { ParticipantJoined: { user_id: senderBytes() } } },
    {
      index: 7,
      timestamp: 3000,
      event: {
        Message: {
          message_index: 3,
          message_id: 999n,
          sender: senderBytes(),
          content: { Text: { text: "hello" } },
          edited: true,
        },
      },
    },
  ];
  const out = messagesFromEvents(events, SENDER);
  expect(out.length).toBe(1);
  expect(out[0]!.text).toBe("hello");
  expect(out[0]!.index).toBe(3);
  expect(out[0]!.contentKind).toBe("text");
  expect(out[0]!.messageId).toBe("999");
  expect(out[0]!.timestampMs).toBe(3000);
  expect(out[0]!.mine).toBe(true);
  expect(out[0]!.edited).toBe(true);
});

test("messagePreview reads a bare EventWrapper<Message> (latest_message is NOT a ChatEvent)", () => {
  // Unlike the events list, a summary's latest_message wraps a bare Message, so
  // its fields are read directly — unwrapping a `.Message` here would be wrong.
  const preview = messagePreview({
    index: 1,
    timestamp: 4242,
    event: { message_index: 0, message_id: 1n, sender: senderBytes(), content: { Text: { text: "last" } } },
  });
  expect(preview?.text).toBe("last");
  expect(preview?.timestampMs).toBe(4242);
  expect(preview?.senderId).toBe(SENDER);
});

test("userCanisterId: no-op for a real canister id, derives the holder for an indexed user", () => {
  // A canister id is 8 bytes then the class-tag [0x01, 0x01].
  const canister = Principal.fromUint8Array(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 10, 1, 1])).toText();
  expect(userCanisterId(canister)).toBe(canister);

  // An indexed UserId reuses the leading 8 bytes but overwrites the tag bytes
  // with the index, setting the 0x80 top-bit in the final byte.
  const index = 300;
  const indexed = Principal.fromUint8Array(
    new Uint8Array([0, 0, 0, 0, 0, 0, 0, 10, index & 0xff, 0x80 | (index >> 8)]),
  ).toText();
  expect(indexed).not.toBe(canister);
  expect(userCanisterId(indexed)).toBe(canister);
});

test("messageImage extracts inline thumbnail + full blob url for Image content", () => {
  const canister = Principal.fromUint8Array(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 20, 1, 1])).toText();
  const img = messageImage({
    Image: {
      width: 800,
      height: 600,
      thumbnail_data: "data:image/jpeg;base64,AAAA",
      mime_type: "image/jpeg",
      blob_reference: { canister_id: Principal.fromText(canister).toUint8Array(), blob_id: 42n },
    },
  });
  expect(img).not.toBeNull();
  expect(img!.thumbnailDataUrl).toBe("data:image/jpeg;base64,AAAA");
  expect(img!.fullUrl).toBe(`https://${canister}.raw.icp0.io/files/42`);
  expect(img!.width).toBe(800);
  expect(img!.height).toBe(600);
  // Non-image content yields no image.
  expect(messageImage({ Text: { text: "hi" } })).toBeNull();
});

test("messageImage tolerates a missing blob_reference (thumbnail only)", () => {
  const img = messageImage({
    Image: { width: 1, height: 1, thumbnail_data: "data:image/png;base64,BBBB", mime_type: "image/png", blob_reference: null },
  });
  expect(img!.thumbnailDataUrl).toBe("data:image/png;base64,BBBB");
  expect(img!.fullUrl).toBeNull();
});

test("parseUserSummariesV2 reads user_id + nested stable.{username, display_name, avatar_id}", () => {
  const a = "2vxsx-fae";
  const out = parseUserSummariesV2({
    Success: {
      users: [
        { user_id: Principal.fromText(a).toUint8Array(), stable: { username: "alice", display_name: "Alice A.", avatar_id: 77n } },
        { user_id: Principal.fromText(a).toUint8Array(), stable: { username: "bob", display_name: null } },
      ],
    },
  });
  expect(out.length).toBe(2);
  expect(out[0]!.username).toBe("alice");
  expect(out[0]!.displayName).toBe("Alice A.");
  expect(out[0]!.avatarUrl).toBe(`https://${a}.raw.icp0.io/avatar/77`);
  expect(out[1]!.displayName).toBeNull();
  expect(out[1]!.avatarUrl).toBeNull(); // no avatar_id → no url
});

test("pickPrimaryChannel: most-active by message volume wins (not freshest)", () => {
  const channels = [
    { channel_id: 10, name: "general", metrics: { text_messages: 5 }, latest_message_index: 5 },
    // 'off-topic' has far more messages though 'general' may have a newer one.
    { channel_id: 20, name: "off-topic", metrics: { text_messages: 900, image_messages: 100 }, latest_message_index: 999 },
    { channel_id: 30, name: "quiet", metrics: { text_messages: 2 }, latest_message_index: 2 },
  ];
  expect(pickPrimaryChannel(channels)).toBe(20);
});

test("pickPrimaryChannel: brand-new community (no messages) prefers a 'General' channel", () => {
  const channels = [
    { channel_id: 7, name: "random", metrics: {}, latest_message_index: null },
    { channel_id: 8, name: "General", metrics: {}, latest_message_index: null },
  ];
  expect(pickPrimaryChannel(channels)).toBe(8);
});

test("pickPrimaryChannel: no activity and no 'general' → first channel; empty → null", () => {
  expect(pickPrimaryChannel([{ channel_id: 3, name: "alpha" }, { channel_id: 4, name: "beta" }])).toBe(3);
  expect(pickPrimaryChannel([])).toBeNull();
});
