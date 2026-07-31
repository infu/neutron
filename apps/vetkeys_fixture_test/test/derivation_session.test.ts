import { describe, expect, test } from "bun:test";
import type { VetKeyPublicInfo } from "neutron-tools/app";
import {
  EphemeralDerivationSession,
  type OneUseTransport,
} from "../src/derivation_session";

const bytes = (length: number, value: number): number[] =>
  Array.from({ length }, () => value);

function publicInfo(): VetKeyPublicInfo {
  return {
    canisterPrincipal: "aaaaa-aa",
    slot: "mailbox",
    generation: "1",
    suite: "bls12_381_g2",
    keyName: "test_key_1",
    publicKey: bytes(96, 4),
    publicFingerprint: bytes(32, 5),
    derivationInput: bytes(32, 6),
  };
}

class FakeTransport implements OneUseTransport {
  consumed = 0;
  fail = false;

  publicKeyBytes(): Uint8Array {
    return Uint8Array.from(bytes(48, 3));
  }

  consume(input: {
    encryptedVetKey: Uint8Array;
    contextPublicKey: Uint8Array;
    derivationInput: Uint8Array;
  }): object {
    this.consumed += 1;
    expect(input.encryptedVetKey).toHaveLength(192);
    expect(input.contextPublicKey).toHaveLength(96);
    expect(input.derivationInput).toHaveLength(32);
    if (this.fail) throw new Error("verification failed");
    return Object.freeze({ opaque: true });
  }
}

describe("ephemeral fixture derivation", () => {
  test("keeps transport and verified key handles opaque", () => {
    const transport = new FakeTransport();
    const session = new EphemeralDerivationSession({
      createTransport: () => transport,
      randomBytes: (length) => Uint8Array.from(bytes(length, 7)),
    });
    const request = session.begin();
    expect(request).toEqual({
      transportPublicKey: Uint8Array.from(bytes(48, 3)),
      requestNonce: Uint8Array.from(bytes(32, 7)),
    });
    expect(session.pending).toBe(true);
    expect(session.verified).toBe(false);
    expect(session).not.toHaveProperty("keyHandle");
    expect(session).not.toHaveProperty("serialize");

    session.complete(bytes(192, 8), publicInfo());
    expect(transport.consumed).toBe(1);
    expect(session.pending).toBe(false);
    expect(session.verified).toBe(true);

    session.clear();
    expect(session.verified).toBe(false);
    expect(session.pending).toBe(false);
  });

  test("makes failed verification non-retryable", () => {
    const transport = new FakeTransport();
    transport.fail = true;
    const session = new EphemeralDerivationSession({
      createTransport: () => transport,
      randomBytes: (length) => new Uint8Array(length),
    });
    session.begin();
    expect(() => session.complete(bytes(192, 1), publicInfo())).toThrow(
      "verification failed",
    );
    expect(session.pending).toBe(false);
    expect(session.verified).toBe(false);
    expect(() => session.complete(bytes(192, 1), publicInfo())).toThrow(
      "No fixture derivation is pending",
    );
  });

  test("rejects overlap and malformed random input", () => {
    const session = new EphemeralDerivationSession({
      createTransport: () => new FakeTransport(),
      randomBytes: (length) => new Uint8Array(length),
    });
    session.begin();
    expect(() => session.begin()).toThrow("already pending");
    session.cancel();
    expect(session.pending).toBe(false);

    const malformed = new EphemeralDerivationSession({
      createTransport: () => new FakeTransport(),
      randomBytes: () => new Uint8Array(31),
    });
    expect(() => malformed.begin()).toThrow("Invalid fixture request nonce");
    expect(malformed.pending).toBe(false);
  });
});
