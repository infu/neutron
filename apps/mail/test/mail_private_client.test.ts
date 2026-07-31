import { expect, test } from "bun:test";
import { parseMailPrivateMessage } from "../src/mail_private_client.ts";

test("strict private message parsing projects the exact row before validating its body", () => {
  const value = privateMessage();
  const parsed = parseMailPrivateMessage(value);
  expect(parsed.localId).toBe("1");
  expect(parsed.decryption.state).toBe("ready");
  if (parsed.decryption.state !== "ready") throw new Error("Expected ready private Mail");
  expect(parsed.decryption.header.subject).toBe("Private subject");
  expect(parsed.bodyMarkdown).toBe("Private **body**");
});

test("private message parsing still rejects body/decryption contradictions and extra fields", () => {
  expect(() => parseMailPrivateMessage({
    ...privateMessage(),
    decryption: { state: "corrupt" },
  })).toThrow("Invalid private Mail response");
  expect(() => parseMailPrivateMessage({
    ...privateMessage(),
    unexpectedPlaintext: "must not cross the tool schema",
  })).toThrow("Invalid private Mail message");
});

function privateMessage(): Record<string, unknown> {
  return {
    folder: "inbox",
    localId: "1",
    messageId: "0123456789abcdef0123456789abcdef",
    peerPrincipal: "exguj-k3777-77774-aaaca-cai",
    currentContact: { status: "not_in_contacts" },
    timestampNs: "1",
    read: false,
    deliveryStatus: null,
    replyContextLabel: null,
    decryption: {
      state: "ready",
      header: {
        claimedSenderName: "Encrypted Ada",
        subject: "Private subject",
        senderCreatedAtNs: "1",
        inReplyTo: null,
      },
    },
    bodyMarkdown: "Private **body**",
  };
}
