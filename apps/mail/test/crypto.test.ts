import { expect, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  MailCryptoError,
  decryptPrivateMailHeaderV1,
  decryptPrivateMailV1,
  encryptPrivateMailV1,
  rewrapMailLocalCek,
  type MailIbeAdapter,
  type MailIbePublicKeyInfo,
} from "../src/crypto.ts";
import {
  MAIL_ENVELOPE_OFFSETS,
  computeMailKeyFingerprint,
  decodeMailEnvelopeV1,
} from "../src/protocol.ts";

const SENDER = "un4fu-tqaaa-aaaab-qadjq-cai";
const RECIPIENT = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const OTHER = "mxzaz-hqaaa-aaaar-qaada-cai";

test("production crypto fails closed when no IBE adapter is installed", async () => {
  const sender = keyFixture("sender", 2n);
  const recipient = keyFixture("recipient", 7n);
  await expect(
    encryptPrivateMailV1({
      senderPrincipal: SENDER,
      recipientPrincipal: RECIPIENT,
      senderKey: sender.info,
      recipientKey: recipient.info,
      header: header(),
      body: body(),
    }),
  ).rejects.toMatchObject({ code: "IBE_UNAVAILABLE" });
});

test("recipient and sender independently unwrap one CEK and decrypt the same private content", async () => {
  const adapter = new DeterministicTestIbeAdapter();
  const sender = keyFixture("sender", 2n);
  const recipient = keyFixture("recipient", 7n);
  const encrypted = await encryptPrivateMailV1({
    senderPrincipal: SENDER,
    recipientPrincipal: RECIPIENT,
    senderKey: sender.info,
    recipientKey: recipient.info,
    header: header(),
    body: body(),
    adapter,
  });

  const envelope = decodeMailEnvelopeV1(encrypted.envelope);
  expect(encrypted.messageId).toEqual(envelope.messageId);
  expect(envelope.deliveryKeyEpoch).toBe(recipient.info.epoch);
  expect(envelope.recipientKeyFingerprint).toEqual(recipient.info.fingerprint);
  expect(encrypted.senderLocalWrap.epoch).toBe(sender.info.epoch);
  expect(encrypted.senderLocalWrap.fingerprint).toEqual(sender.info.fingerprint);

  const received = await decryptPrivateMailV1({
    senderPrincipal: SENDER,
    recipientPrincipal: RECIPIENT,
    envelope: encrypted.envelope,
    localKey: recipient.info,
    keyHandle: recipient.handle,
    adapter,
  });
  const sent = await decryptPrivateMailV1({
    senderPrincipal: SENDER,
    recipientPrincipal: RECIPIENT,
    envelope: encrypted.envelope,
    localKey: sender.info,
    localWrap: encrypted.senderLocalWrap,
    keyHandle: sender.handle,
    adapter,
  });
  expect(received).toEqual(sent);
  expect(received.header).toEqual(header());
  expect(received.body).toEqual(body());

  expect(adapter.wrapCalls).toHaveLength(2);
  expect(adapter.wrapCalls[0]!.cek).toEqual(adapter.wrapCalls[1]!.cek);
  expect(adapter.wrapCalls[0]!.seed).not.toEqual(adapter.wrapCalls[1]!.seed);
  expect(adapter.wrapCalls[0]!.seed).not.toEqual(adapter.wrapCalls[0]!.cek);
  expect(adapter.wrapCalls[1]!.seed).not.toEqual(adapter.wrapCalls[1]!.cek);
  for (const reference of adapter.borrowedInputs) {
    expect(reference.cek.every((byte) => byte === 0)).toBe(true);
    expect(reference.seed.every((byte) => byte === 0)).toBe(true);
  }
  expect(envelope.headerNonce).not.toEqual(envelope.bodyNonce);
  expect(envelope.messageId.slice(0, 12)).not.toEqual(envelope.headerNonce);

  const wireText = new TextDecoder().decode(encrypted.envelope);
  expect(wireText).not.toContain("Quarterly plan");
  expect(wireText).not.toContain("private body marker");
});

test("list projection authenticates the fixed header without fetching a body", async () => {
  const setup = await encryptedFixture();
  const envelope = decodeMailEnvelopeV1(setup.encrypted.envelope);
  const input = {
    senderPrincipal: SENDER,
    recipientPrincipal: RECIPIENT,
    encryptedHeader: {
      deliveryKeyEpoch: envelope.deliveryKeyEpoch,
      recipientKeyFingerprint: envelope.recipientKeyFingerprint,
      messageId: envelope.messageId,
      headerNonce: envelope.headerNonce,
      headerCiphertextAndTag: envelope.headerCiphertextAndTag,
    },
    localKey: setup.recipient.info,
    localWrap: {
      epoch: envelope.deliveryKeyEpoch,
      fingerprint: envelope.recipientKeyFingerprint,
      wrappedCek: envelope.recipientWrappedCek,
    },
    keyHandle: setup.recipient.handle,
    adapter: setup.adapter,
  };

  await expect(decryptPrivateMailHeaderV1(input)).resolves.toEqual({
    messageId: envelope.messageId,
    header: header(),
  });

  const tampered = {
    ...input,
    encryptedHeader: {
      ...input.encryptedHeader,
      headerCiphertextAndTag: input.encryptedHeader.headerCiphertextAndTag.slice(),
    },
  };
  tampered.encryptedHeader.headerCiphertextAndTag[20] =
    tampered.encryptedHeader.headerCiphertextAndTag[20]! ^ 1;
  await expect(decryptPrivateMailHeaderV1(tampered)).rejects.toMatchObject({
    code: "AUTHENTICATION_FAILED",
  });
});

test("AES-GCM rejects header tampering, body tampering, and wrong authenticated principals", async () => {
  const setup = await encryptedFixture();
  const headerTampered = setup.encrypted.envelope.slice();
  const headerIndex = MAIL_ENVELOPE_OFFSETS.headerCiphertextAndTag + 20;
  headerTampered[headerIndex] = headerTampered[headerIndex]! ^ 1;
  await expectRecipientFailure(setup, headerTampered, SENDER, "AUTHENTICATION_FAILED");

  const bodyTampered = setup.encrypted.envelope.slice();
  const bodyIndex = MAIL_ENVELOPE_OFFSETS.bodyCiphertextAndTag + 20;
  bodyTampered[bodyIndex] = bodyTampered[bodyIndex]! ^ 1;
  await expectRecipientFailure(setup, bodyTampered, SENDER, "AUTHENTICATION_FAILED");

  await expectRecipientFailure(
    setup,
    setup.encrypted.envelope,
    OTHER,
    "AUTHENTICATION_FAILED",
  );
});

test("recipient and sender wraps cannot be substituted or opened by the wrong key handle", async () => {
  const setup = await encryptedFixture();

  await expect(
    decryptPrivateMailV1({
      senderPrincipal: SENDER,
      recipientPrincipal: RECIPIENT,
      envelope: setup.encrypted.envelope,
      localKey: setup.sender.info,
      keyHandle: setup.sender.handle,
      adapter: setup.adapter,
    }),
  ).rejects.toMatchObject({ code: "INVALID_KEY_INFO" });

  await expect(
    decryptPrivateMailV1({
      senderPrincipal: SENDER,
      recipientPrincipal: RECIPIENT,
      envelope: setup.encrypted.envelope,
      localKey: setup.recipient.info,
      localWrap: setup.encrypted.senderLocalWrap,
      keyHandle: setup.recipient.handle,
      adapter: setup.adapter,
    }),
  ).rejects.toMatchObject({ code: "INVALID_KEY_INFO" });

  await expect(
    decryptPrivateMailV1({
      senderPrincipal: SENDER,
      recipientPrincipal: RECIPIENT,
      envelope: setup.encrypted.envelope,
      localKey: setup.recipient.info,
      keyHandle: setup.sender.handle,
      adapter: setup.adapter,
    }),
  ).rejects.toMatchObject({ code: "KEY_UNWRAP_FAILED" });
});

test("key information fingerprint is checked before wrapping or unwrapping", async () => {
  const adapter = new DeterministicTestIbeAdapter();
  const sender = keyFixture("sender", 2n);
  const recipient = keyFixture("recipient", 7n);
  const corruptRecipient = {
    ...recipient.info,
    fingerprint: recipient.info.fingerprint.slice(),
  };
  corruptRecipient.fingerprint[0] = corruptRecipient.fingerprint[0]! ^ 1;
  await expect(
    encryptPrivateMailV1({
      senderPrincipal: SENDER,
      recipientPrincipal: RECIPIENT,
      senderKey: sender.info,
      recipientKey: corruptRecipient,
      header: header(),
      body: body(),
      adapter,
    }),
  ).rejects.toMatchObject({ code: "INVALID_KEY_INFO" });
  expect(adapter.wrapCalls).toHaveLength(0);
});

test("rotation rewraps only the local CEK metadata and remains decryptable", async () => {
  const setup = await encryptedFixture();
  const next = keyFixture("recipient-next", 8n);
  const beforeEnvelope = setup.encrypted.envelope.slice();
  const original = decodeMailEnvelopeV1(beforeEnvelope);

  const replacement = await rewrapMailLocalCek({
    oldKey: setup.recipient.info,
    newKey: next.info,
    oldKeyHandle: setup.recipient.handle,
    localWrap: {
      epoch: original.deliveryKeyEpoch,
      fingerprint: original.recipientKeyFingerprint,
      wrappedCek: original.recipientWrappedCek,
    },
    adapter: setup.adapter,
  });

  expect(replacement.epoch).toBe(8n);
  expect(replacement.fingerprint).toEqual(next.info.fingerprint);
  expect(setup.encrypted.envelope).toEqual(beforeEnvelope);
  const decrypted = await decryptPrivateMailV1({
    senderPrincipal: SENDER,
    recipientPrincipal: RECIPIENT,
    envelope: setup.encrypted.envelope,
    localKey: next.info,
    localWrap: replacement,
    keyHandle: next.handle,
    adapter: setup.adapter,
  });
  expect(decrypted.header).toEqual(header());
  expect(decrypted.body).toEqual(body());
});

test("rotation rejects a mismatched old wrap before producing a replacement", async () => {
  const setup = await encryptedFixture();
  const next = keyFixture("recipient-next", 8n);
  const wrong = keyFixture("wrong", 9n);
  await expect(rewrapMailLocalCek({
    oldKey: setup.recipient.info,
    newKey: next.info,
    oldKeyHandle: setup.recipient.handle,
    localWrap: {
      ...setup.encrypted.senderLocalWrap,
      fingerprint: wrong.info.fingerprint,
    },
    adapter: setup.adapter,
  })).rejects.toMatchObject({ code: "INVALID_KEY_INFO" });
});

type TestKeyHandle = {
  contextPublicKey: Uint8Array;
  effectiveIbeIdentity: Uint8Array;
};

class DeterministicTestIbeAdapter implements MailIbeAdapter<TestKeyHandle> {
  readonly wrapCalls: Array<{
    target: MailIbePublicKeyInfo;
    cek: Uint8Array;
    seed: Uint8Array;
  }> = [];
  readonly borrowedInputs: Array<{ cek: Uint8Array; seed: Uint8Array }> = [];

  async wrapCek(input: {
    target: MailIbePublicKeyInfo;
    cek: Uint8Array;
    seed: Uint8Array;
  }): Promise<Uint8Array> {
    if (input.cek.byteLength !== 32 || input.seed.byteLength !== 32) {
      throw new Error("test adapter input length");
    }
    this.borrowedInputs.push({ cek: input.cek, seed: input.seed });
    this.wrapCalls.push({
      target: copyInfo(input.target),
      cek: input.cek.slice(),
      seed: input.seed.slice(),
    });
    const mask = digest(
      text("mail-test-mask"),
      input.target.contextPublicKey,
      input.target.effectiveIbeIdentity,
      input.seed,
    );
    const masked = xor(input.cek, mask);
    const tag = digest(
      text("mail-test-tag"),
      input.target.contextPublicKey,
      input.target.effectiveIbeIdentity,
      input.seed,
      masked,
      input.target.fingerprint,
    );
    const filler = concat(tag, mask).slice(0, 40);
    return concat(
      input.seed,
      masked,
      input.target.fingerprint,
      tag,
      filler,
    );
  }

  async unwrapCek(input: {
    target: MailIbePublicKeyInfo;
    keyHandle: TestKeyHandle;
    wrappedCek: Uint8Array;
  }): Promise<Uint8Array> {
    if (
      !same(input.keyHandle.contextPublicKey, input.target.contextPublicKey) ||
      !same(input.keyHandle.effectiveIbeIdentity, input.target.effectiveIbeIdentity) ||
      input.wrappedCek.byteLength !== 168
    ) {
      throw new Error("wrong test key");
    }
    const seed = input.wrappedCek.slice(0, 32);
    const masked = input.wrappedCek.slice(32, 64);
    const fingerprint = input.wrappedCek.slice(64, 96);
    const tag = input.wrappedCek.slice(96, 128);
    const expectedTag = digest(
      text("mail-test-tag"),
      input.target.contextPublicKey,
      input.target.effectiveIbeIdentity,
      seed,
      masked,
      input.target.fingerprint,
    );
    if (!same(fingerprint, input.target.fingerprint) || !same(tag, expectedTag)) {
      throw new Error("invalid test wrap");
    }
    const mask = digest(
      text("mail-test-mask"),
      input.target.contextPublicKey,
      input.target.effectiveIbeIdentity,
      seed,
    );
    return xor(masked, mask);
  }
}

function keyFixture(label: string, epoch: bigint): {
  info: MailIbePublicKeyInfo;
  handle: TestKeyHandle;
} {
  const contextPublicKey = digest(text(`public:${label}`));
  const effectiveIbeIdentity = digest(text(`identity:${label}`));
  const info: MailIbePublicKeyInfo = {
    suite: 1,
    epoch,
    contextPublicKey,
    effectiveIbeIdentity,
    fingerprint: computeMailKeyFingerprint({
      epoch,
      contextPublicKey,
      effectiveIbeIdentity,
    }),
  };
  return {
    info,
    handle: {
      contextPublicKey: contextPublicKey.slice(),
      effectiveIbeIdentity: effectiveIbeIdentity.slice(),
    },
  };
}

async function encryptedFixture() {
  const adapter = new DeterministicTestIbeAdapter();
  const sender = keyFixture("sender", 2n);
  const recipient = keyFixture("recipient", 7n);
  const encrypted = await encryptPrivateMailV1({
    senderPrincipal: SENDER,
    recipientPrincipal: RECIPIENT,
    senderKey: sender.info,
    recipientKey: recipient.info,
    header: header(),
    body: body(),
    adapter,
  });
  return { adapter, sender, recipient, encrypted };
}

async function expectRecipientFailure(
  setup: Awaited<ReturnType<typeof encryptedFixture>>,
  envelope: Uint8Array,
  senderPrincipal: string,
  code: string,
): Promise<void> {
  await expect(
    decryptPrivateMailV1({
      senderPrincipal,
      recipientPrincipal: RECIPIENT,
      envelope,
      localKey: setup.recipient.info,
      keyHandle: setup.recipient.handle,
      adapter: setup.adapter,
    }),
  ).rejects.toMatchObject({ code });
}

function header() {
  return {
    contentSchema: 1 as const,
    claimedSenderName: "Ada",
    subject: "Quarterly plan",
    senderCreatedAtNs: "123456789",
    inReplyTo: null,
  };
}

function body() {
  return {
    contentSchema: 1 as const,
    bodyMarkdown: "A private body marker with [a link](https://example.com).",
  };
}

function copyInfo(value: MailIbePublicKeyInfo): MailIbePublicKeyInfo {
  return {
    suite: value.suite,
    epoch: value.epoch,
    fingerprint: value.fingerprint.slice(),
    contextPublicKey: value.contextPublicKey.slice(),
    effectiveIbeIdentity: value.effectiveIbeIdentity.slice(),
  };
}

function digest(...values: Uint8Array[]): Uint8Array {
  return sha256(concat(...values));
}

function concat(...values: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((sum, value) => sum + value.byteLength, 0));
  let cursor = 0;
  for (const value of values) {
    output.set(value, cursor);
    cursor += value.byteLength;
  }
  return output;
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function xor(left: Uint8Array, right: Uint8Array): Uint8Array {
  return Uint8Array.from(left, (value, index) => value ^ right[index]!);
}

function same(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
