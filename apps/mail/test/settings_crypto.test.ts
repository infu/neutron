import { describe, expect, test } from "bun:test";
import type { MailIbeAdapter, MailIbePublicKeyInfo } from "../src/crypto.ts";
import { computeMailKeyFingerprint } from "../src/protocol.ts";
import {
  buildMailSettingsAad,
  decodeMailSettingsContentV1,
  decryptMailSettingsV1,
  encodeMailSettingsContentV1,
  encryptMailSettingsV1,
} from "../src/settings_crypto.ts";

const SELF = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const OTHER = "un4fu-tqaaa-aaaab-qadjq-cai";

describe("encrypted Mail sender settings", () => {
  test("uses deterministic canonical CBOR for only the bounded sender name", () => {
    const encoded = encodeMailSettingsContentV1("Ada");
    expect(hex(encoded)).toBe("a201010263416461");
    expect(decodeMailSettingsContentV1(encoded)).toBe("Ada");
    expect(() => decodeMailSettingsContentV1(Uint8Array.of(
      0xa2, 0x01, 0x01, 0x02, 0x78, 0x03, 0x41, 0x64, 0x61,
    ))).toThrow();
    expect(() => decodeMailSettingsContentV1(Uint8Array.of(
      0xa2, 0x01, 0x01, 0x02, 0x63, 0x41, 0x64, 0x61, 0x00,
    ))).toThrow();
  });

  test("round trips through a distinct self/principal/revision authenticated domain", async () => {
    const key = keyFixture(7n);
    const adapter = new TestAdapter();
    const encrypted = await encryptMailSettingsV1({
      selfPrincipal: SELF,
      senderName: "Private Ada",
      recordId: bytes(16, 0x31),
      revision: 2n,
      localKey: key,
      adapter,
    });

    expect(new TextDecoder().decode(encrypted.ciphertextAndTag)).not.toContain("Private Ada");
    await expect(decryptMailSettingsV1({
      selfPrincipal: SELF,
      encrypted,
      localKey: key,
      keyHandle: true,
      adapter,
    })).resolves.toEqual({ senderName: "Private Ada" });

    await expect(decryptMailSettingsV1({
      selfPrincipal: OTHER,
      encrypted,
      localKey: key,
      keyHandle: true,
      adapter,
    })).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    await expect(decryptMailSettingsV1({
      selfPrincipal: SELF,
      encrypted: { ...encrypted, revision: 3n },
      localKey: key,
      keyHandle: true,
      adapter,
    })).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  test("AAD has a frozen unambiguous vector", () => {
    expect(hex(buildMailSettingsAad(SELF, bytes(16, 0x11), 1n))).toBe(
      "186e657574726f6e2d6d61696c2d73657474696e67732d76310a00000000000000020101111111111111111111111111111111110000000000000001",
    );
  });
});

class TestAdapter implements MailIbeAdapter<unknown> {
  async wrapCek(input: { cek: Uint8Array; seed: Uint8Array }): Promise<Uint8Array> {
    const result = new Uint8Array(168);
    result.set(input.cek, 0);
    result.set(input.seed, 32);
    result.fill(0x71, 64);
    return result;
  }

  async unwrapCek(input: { keyHandle: unknown; wrappedCek: Uint8Array }): Promise<Uint8Array> {
    if (input.keyHandle !== true || input.wrappedCek.byteLength !== 168) throw new Error("wrong key");
    return input.wrappedCek.slice(0, 32);
  }
}

function keyFixture(epoch: bigint): MailIbePublicKeyInfo {
  const contextPublicKey = bytes(96, 0x41);
  const effectiveIbeIdentity = bytes(32, 0x51);
  return {
    suite: 1,
    epoch,
    contextPublicKey,
    effectiveIbeIdentity,
    fingerprint: computeMailKeyFingerprint({
      suite: 1,
      epoch,
      contextPublicKey,
      effectiveIbeIdentity,
    }),
  };
}

function bytes(length: number, value: number): Uint8Array {
  return new Uint8Array(length).fill(value);
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
