import { describe, expect, test } from "bun:test";
import {
  DerivedPublicKey,
  IbeCiphertext,
  VetKey,
  augmentedHashToG1,
} from "@dfinity/vetkeys";
import { bls12_381 } from "@noble/curves/bls12-381.js";
import {
  FILES_CONTEXT_PUBLIC_KEY_BYTES,
  FILES_DERIVATION_INPUT_BYTES,
  FILES_IBE_WRAPPER_BYTES,
  FILES_TRANSPORT_PUBLIC_KEY_BYTES,
  FilesVetKeyTransportSession,
  OfficialFilesIbeAdapter,
  assertPinnedFilesIbeShape,
  sameFilesVetKeyBinding,
  validateFilesVetKeyPublicInfo,
  type FilesIbePublicInfo,
  type FilesVetKeyPublicInfo,
} from "../src/crypto/vetkeys.ts";
import { sha256 } from "../src/crypto/webcrypto.ts";

describe("official Files vetKeys adapter", () => {
  test("freezes the 32-byte vault root to the 168-byte IBE shape", () => {
    expect(() => assertPinnedFilesIbeShape()).not.toThrow();
    expect(IbeCiphertext.ciphertextSize(32)).toBe(FILES_IBE_WRAPPER_BYTES);
    expect(IbeCiphertext.plaintextSize(FILES_IBE_WRAPPER_BYTES)).toBe(32);
  });

  test("wraps and unwraps an exact vault root without exposing the key handle", async () => {
    const fixture = keyFixture(0x5a17n, 0x41);
    const adapter = new OfficialFilesIbeAdapter();
    const root = bytes(32, 0x81);
    const seed = bytes(32, 0xb2);
    const wrapped = await adapter.wrapRoot({
      target: fixture.info,
      vaultRoot: root,
      seed,
    });
    const recovered = await adapter.unwrapRoot({
      target: fixture.info,
      keyHandle: fixture.handle,
      wrapper: wrapped,
    });

    expect(wrapped).toHaveLength(168);
    expect(recovered).toEqual(root);
    expect(root).toEqual(bytes(32, 0x81));
    expect(seed).toEqual(bytes(32, 0xb2));

    const changed = wrapped.slice();
    changed[17] = changed[17]! ^ 1;
    await expect(
      adapter.unwrapRoot({
        target: fixture.info,
        keyHandle: fixture.handle,
        wrapper: changed,
      }),
    ).rejects.toThrow();
  });

  test("consumes one-use transport state before verification", () => {
    const session = FilesVetKeyTransportSession.random();
    const publicKey = session.publicKeyBytes();
    expect(publicKey).toHaveLength(FILES_TRANSPORT_PUBLIC_KEY_BYTES);
    publicKey.fill(0);
    expect(session.publicKeyBytes().some((byte) => byte !== 0)).toBe(true);

    expect(() =>
      session.consume({
        encryptedVetKey: new Uint8Array(192),
        contextPublicKey: new Uint8Array(96),
        derivationInput: new Uint8Array(32),
      }),
    ).toThrow();
    expect(session.consumed).toBe(true);
    expect(() =>
      session.consume({
        encryptedVetKey: new Uint8Array(192),
        contextPublicKey: new Uint8Array(96),
        derivationInput: new Uint8Array(32),
      }),
    ).toThrow("already consumed");
  });

  test("validates and compares the complete Files binding", async () => {
    const fixture = keyFixture(0x7a19n, 0x51);
    const publicInfo: FilesVetKeyPublicInfo = {
      canisterPrincipal: "un4fu-tqaaa-aaaab-qadjq-cai",
      canisterPrincipalBytes: Uint8Array.of(1, 2, 3, 4),
      slot: "files_vault",
      generation: "7",
      suite: "bls12_381_g2",
      keyName: "test_key_1",
      publicKey: fixture.info.contextPublicKey,
      publicFingerprint: await sha256(fixture.info.contextPublicKey),
      derivationInput: fixture.info.effectiveIbeIdentity,
    };
    const validated = validateFilesVetKeyPublicInfo(publicInfo);
    expect(validated.publicKey).toHaveLength(
      FILES_CONTEXT_PUBLIC_KEY_BYTES,
    );
    expect(validated.derivationInput).toHaveLength(
      FILES_DERIVATION_INPUT_BYTES,
    );
    expect(sameFilesVetKeyBinding(validated, publicInfo)).toBe(true);
    expect(
      sameFilesVetKeyBinding(validated, {
        ...publicInfo,
        keyName: "key_1",
      }),
    ).toBe(false);
    expect(
      sameFilesVetKeyBinding(validated, {
        ...publicInfo,
        canisterPrincipalBytes: Uint8Array.of(1, 2, 3, 5),
      }),
    ).toBe(false);
  });
});

function keyFixture(
  secretScalar: bigint,
  identitySeed: number,
): {
  info: FilesIbePublicInfo;
  handle: VetKey;
} {
  const publicPoint = bls12_381.G2.Point.BASE.multiply(secretScalar);
  const publicKey = new DerivedPublicKey(publicPoint);
  const identity = bytes(32, identitySeed);
  const handle = new VetKey(
    augmentedHashToG1(publicKey, identity).multiply(secretScalar),
  );
  return {
    handle,
    info: {
      contextPublicKey: publicKey.publicKeyBytes(),
      effectiveIbeIdentity: identity,
    },
  };
}

function bytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from(
    { length },
    (_value, index) => (seed + index * 17) & 0xff,
  );
}
