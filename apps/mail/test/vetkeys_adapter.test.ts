import { describe, expect, test } from "bun:test";
import {
  DerivedPublicKey,
  IbeCiphertext,
  VetKey,
  augmentedHashToG1,
} from "@dfinity/vetkeys";
import { bls12_381 } from "@noble/curves/bls12-381.js";
import { computeMailKeyFingerprint } from "../src/protocol.ts";
import {
  MAIL_CEK_BYTES,
  type MailIbePublicKeyInfo,
} from "../src/crypto.ts";
import {
  MAIL_EFFECTIVE_IBE_IDENTITY_BYTES,
  MAIL_TRANSPORT_PUBLIC_KEY_BYTES,
  MailVetKeyTransportSession,
  OfficialMailIbeAdapter,
  assertPinnedCiphertextShape,
} from "../src/vetkeys_adapter.ts";

describe("official vetKeys Mail adapter", () => {
  test("freezes the official V1 32-byte CEK to 168-byte IBE shape", () => {
    expect(() => assertPinnedCiphertextShape()).not.toThrow();
    expect(IbeCiphertext.ciphertextSize(MAIL_CEK_BYTES)).toBe(168);
    expect(IbeCiphertext.plaintextSize(168)).toBe(MAIL_CEK_BYTES);
  });

  test("wraps and unwraps one CEK with the official IBE implementation", async () => {
    const secretScalar = 0x5a17n;
    const publicPoint = bls12_381.G2.Point.BASE.multiply(secretScalar);
    const derivedPublicKey = new DerivedPublicKey(publicPoint);
    const identity = bytes(MAIL_EFFECTIVE_IBE_IDENTITY_BYTES, 0x41);
    const signaturePoint = augmentedHashToG1(derivedPublicKey, identity).multiply(secretScalar);
    const vetKey = new VetKey(signaturePoint);
    const contextPublicKey = derivedPublicKey.publicKeyBytes();
    const info: MailIbePublicKeyInfo = {
      suite: 1,
      epoch: 7n,
      contextPublicKey,
      effectiveIbeIdentity: identity,
      fingerprint: computeMailKeyFingerprint({
        suite: 1,
        epoch: 7n,
        contextPublicKey,
        effectiveIbeIdentity: identity,
      }),
    };
    const cek = bytes(MAIL_CEK_BYTES, 0x81);
    const adapter = new OfficialMailIbeAdapter();

    const wrapped = await adapter.wrapCek({
      target: info,
      cek,
      seed: bytes(32, 0xb2),
    });
    const recovered = await adapter.unwrapCek({
      target: info,
      keyHandle: vetKey,
      wrappedCek: wrapped,
    });

    expect(wrapped).toHaveLength(168);
    expect(recovered).toEqual(cek);
  });

  test("transport sessions expose only a public key and are consumed on failure", () => {
    const session = MailVetKeyTransportSession.random();
    const publicKey = session.publicKeyBytes();
    expect(publicKey).toHaveLength(MAIL_TRANSPORT_PUBLIC_KEY_BYTES);
    publicKey.fill(0);
    expect(session.publicKeyBytes().some((byte) => byte !== 0)).toBe(true);

    expect(() => session.consume({
      encryptedVetKey: new Uint8Array(192),
      contextPublicKey: new Uint8Array(96),
      effectiveIbeIdentity: new Uint8Array(32),
    })).toThrow();
    expect(session.consumed).toBe(true);
    expect(() => session.consume({
      encryptedVetKey: new Uint8Array(192),
      contextPublicKey: new Uint8Array(96),
      effectiveIbeIdentity: new Uint8Array(32),
    })).toThrow("already consumed");
  });
});

function bytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (seed + index * 17) & 0xff);
}
