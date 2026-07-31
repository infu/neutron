import { expect, test } from "bun:test";
import {
  MAIL_BODY_CIPHERTEXT_BUCKETS,
  MAIL_BODY_PLAINTEXT_BUCKETS,
  MAIL_ENVELOPE_OFFSETS,
  MAIL_ENVELOPE_PREFIX_BYTES,
  MAIL_ENVELOPE_SIZES,
  MAIL_HEADER_PLAINTEXT_BYTES,
  MAIL_MAX_ENVELOPE_BYTES,
  MailProtocolError,
  buildMailSectionAad,
  computeMailKeyFingerprint,
  decodeMailEnvelopeV1,
  encodeMailEnvelopeV1,
  padBodySection,
  padHeaderSection,
  unpadBodySection,
  unpadHeaderSection,
  type MailEnvelopeV1,
} from "../src/protocol.ts";

test("envelope layout and total sizes are frozen", () => {
  expect(MAIL_ENVELOPE_OFFSETS).toEqual({
    version: 0,
    suite: 1,
    deliveryKeyEpoch: 3,
    recipientKeyFingerprint: 11,
    messageId: 43,
    recipientWrappedCek: 59,
    headerNonce: 227,
    headerCiphertextAndTag: 239,
    bodyNonce: 2303,
    bodyCiphertextLength: 2315,
    bodyCiphertextAndTag: 2319,
  });
  expect(MAIL_ENVELOPE_PREFIX_BYTES).toBe(2319);
  expect(MAIL_BODY_CIPHERTEXT_BUCKETS).toEqual([1040, 4112, 16400, 36880]);
  expect(MAIL_ENVELOPE_SIZES).toEqual([3359, 6431, 18719, 39199]);
  expect(MAIL_MAX_ENVELOPE_BYTES).toBe(39199);
});

test("envelope round trips with an explicit u32 body length and no trailing data", () => {
  for (const bodyLength of MAIL_BODY_CIPHERTEXT_BUCKETS) {
    const source = fixture(bodyLength);
    const encoded = encodeMailEnvelopeV1(source);
    expect(encoded.byteLength).toBe(MAIL_ENVELOPE_PREFIX_BYTES + bodyLength);
    expect(new DataView(encoded.buffer).getUint32(MAIL_ENVELOPE_OFFSETS.bodyCiphertextLength, false)).toBe(bodyLength);
    expect(decodeMailEnvelopeV1(encoded)).toEqual(source);
  }
});

test("envelope rejects altered fixed fields, declared lengths, trailing bytes, and nonce reuse", () => {
  const encoded = encodeMailEnvelopeV1(fixture(MAIL_BODY_CIPHERTEXT_BUCKETS[0]!));
  const wrongVersion = encoded.slice();
  wrongVersion[0] = 2;
  expect(() => decodeMailEnvelopeV1(wrongVersion)).toThrow("version");

  const wrongSuite = encoded.slice();
  wrongSuite[2] = 2;
  expect(() => decodeMailEnvelopeV1(wrongSuite)).toThrow("suite");

  const wrongLength = encoded.slice();
  new DataView(wrongLength.buffer).setUint32(
    MAIL_ENVELOPE_OFFSETS.bodyCiphertextLength,
    MAIL_BODY_CIPHERTEXT_BUCKETS[1]!,
    false,
  );
  expect(() => decodeMailEnvelopeV1(wrongLength)).toThrow("length");

  expect(() => decodeMailEnvelopeV1(Uint8Array.from([...encoded, 0]))).toThrow(
    MailProtocolError,
  );

  const repeatedNonce = encoded.slice();
  repeatedNonce.set(
    repeatedNonce.slice(
      MAIL_ENVELOPE_OFFSETS.headerNonce,
      MAIL_ENVELOPE_OFFSETS.headerNonce + 12,
    ),
    MAIL_ENVELOPE_OFFSETS.bodyNonce,
  );
  expect(() => decodeMailEnvelopeV1(repeatedNonce)).toThrow("nonces");

  for (const [offset, length] of [
    [MAIL_ENVELOPE_OFFSETS.recipientKeyFingerprint, 32],
    [MAIL_ENVELOPE_OFFSETS.messageId, 16],
    [MAIL_ENVELOPE_OFFSETS.recipientWrappedCek, 168],
  ] as const) {
    const allZero = encoded.slice();
    allZero.fill(0, offset, offset + length);
    expect(() => decodeMailEnvelopeV1(allZero)).toThrow("zero");
  }

  const zeroMessageId = fixture(MAIL_BODY_CIPHERTEXT_BUCKETS[0]!);
  zeroMessageId.messageId.fill(0);
  expect(() => encodeMailEnvelopeV1(zeroMessageId)).toThrow("zero");
});

test("AAD and public key fingerprint have frozen vectors", () => {
  const aad = buildMailSectionAad({
    senderPrincipal: "un4fu-tqaaa-aaaab-qadjq-cai",
    recipientPrincipal: "ryjl3-tyaaa-aaaaa-aaaba-cai",
    deliveryKeyEpoch: 7n,
    recipientKeyFingerprint: sequence(32, 0x20),
    messageId: sequence(16, 0x60),
    section: "header",
  });
  expect(hex(aad)).toBe(
    "186e657574726f6e2d6d61696c2d656e76656c6f70652d76310100010a00000000003000d301010a000000000000000201010000000000000007202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f606162636465666768696a6b6c6d6e6f01",
  );

  const fingerprint = computeMailKeyFingerprint({
    epoch: 7n,
    contextPublicKey: Uint8Array.of(1, 2, 3),
    effectiveIbeIdentity: Uint8Array.of(4, 5),
  });
  expect(hex(fingerprint)).toBe(
    "eae4fa65817817e37718cc3c9e26992534bd7d93f4bea52a692ad30f4fd2c660",
  );
});

test("padding selects canonical buckets and rejects invalid containers", () => {
  const fill = (target: Uint8Array) => target.fill(0xa5);
  const headerPayload = Uint8Array.of(1, 2, 3);
  const header = padHeaderSection(headerPayload, fill);
  expect(header.byteLength).toBe(MAIL_HEADER_PLAINTEXT_BYTES);
  expect(unpadHeaderSection(header)).toEqual(headerPayload);
  expect(header.at(-1)).toBe(0xa5);

  for (const [payloadLength, bucket] of [
    [0, MAIL_BODY_PLAINTEXT_BUCKETS[0]],
    [1019, MAIL_BODY_PLAINTEXT_BUCKETS[0]],
    [1020, MAIL_BODY_PLAINTEXT_BUCKETS[1]],
  ] as const) {
    const padded = padBodySection(new Uint8Array(payloadLength), fill);
    expect(padded.byteLength).toBe(bucket);
    expect(unpadBodySection(padded)).toHaveLength(payloadLength);
  }

  const wrongVersion = header.slice();
  wrongVersion[0] = 2;
  expect(() => unpadHeaderSection(wrongVersion)).toThrow("padding");
  const impossibleLength = header.slice();
  new DataView(impossibleLength.buffer).setUint32(1, MAIL_HEADER_PLAINTEXT_BYTES, false);
  expect(() => unpadHeaderSection(impossibleLength)).toThrow("length");
  expect(() => unpadBodySection(new Uint8Array(2_048))).toThrow("noncanonical");
});

function fixture(bodyLength: number): MailEnvelopeV1 {
  return {
    version: 1,
    suite: 1,
    deliveryKeyEpoch: 7n,
    recipientKeyFingerprint: sequence(32, 1),
    messageId: sequence(16, 40),
    recipientWrappedCek: sequence(168, 60),
    headerNonce: sequence(12, 90),
    headerCiphertextAndTag: sequence(2064, 110),
    bodyNonce: sequence(12, 130),
    bodyCiphertextAndTag: sequence(bodyLength, 150),
  };
}

function sequence(length: number, start: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (start + index) & 0xff);
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
