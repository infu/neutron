import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  DerivedPublicKey,
  EncryptedVetKey,
  IbeCiphertext,
  TransportSecretKey,
  type VetKey,
} from "@dfinity/vetkeys";
import type {
  VetKeyDeriveResult,
  VetKeyPublicInfo,
} from "neutron-tools/app";
import {
  VETKEY_DEMO_MAX_PLAINTEXT_BYTES,
  createVetKeyDemoEnvelope,
  recoverVetKeyDemoEnvelope,
  type VetKeyDemoDependencies,
  type VetKeyDemoTransport,
} from "../src/vetkey_demo.ts";

type BrowserVector = {
  generations: {
    current: {
      derivationInputHex: string;
      encryptedVetKeyHex: string;
      generation: string;
      publicKeyHex: string;
    };
  };
  transport: {
    secretKeyHex: string;
  };
};

const vectorUrl = new URL(
  "../../vetkeys_fixture_test/test/vectors/vetkeys-browser-current-previous-v1.json",
  import.meta.url,
);

async function loadVector(): Promise<BrowserVector> {
  return JSON.parse(await readFile(vectorUrl, "utf8")) as BrowserVector;
}

function fromHex(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/u.test(value)) throw new Error("Invalid test hex");
  return Uint8Array.from(
    value.match(/../gu)!.map((byte) => Number.parseInt(byte, 16)),
  );
}

function publicInfo(vector: BrowserVector): VetKeyPublicInfo {
  const current = vector.generations.current;
  return {
    canisterPrincipal: "efadq-gl777-77774-aaaba-cai",
    slot: "demo_key",
    generation: current.generation,
    suite: "bls12_381_g2",
    keyName: "test_key_1",
    publicKey: Array.from(fromHex(current.publicKeyHex)),
    publicFingerprint: Array.from({ length: 32 }, (_, index) => index),
    derivationInput: Array.from(fromHex(current.derivationInputHex)),
  };
}

class VectorTransport implements VetKeyDemoTransport<VetKey> {
  #secret: TransportSecretKey | null;
  consumed = 0;
  cancelled = 0;

  constructor(secret: Uint8Array) {
    this.#secret = TransportSecretKey.deserialize(secret);
  }

  publicKeyBytes(): Uint8Array {
    const secret = this.#secret;
    if (!secret) throw new Error("Vector transport is unavailable");
    return secret.publicKeyBytes();
  }

  consume(input: {
    encryptedVetKey: Uint8Array;
    contextPublicKey: Uint8Array;
    derivationInput: Uint8Array;
  }): VetKey {
    const secret = this.#secret;
    if (!secret) throw new Error("Vector transport was already consumed");
    this.#secret = null;
    this.consumed += 1;
    return EncryptedVetKey.deserialize(input.encryptedVetKey).decryptAndVerify(
      secret,
      DerivedPublicKey.deserialize(input.contextPublicKey),
      input.derivationInput,
    );
  }

  cancel(): void {
    this.cancelled += 1;
    this.#secret = null;
  }
}

function dependencies(
  vector: BrowserVector,
  binding: VetKeyPublicInfo,
  transport: VectorTransport,
  overrides: Partial<VetKeyDemoDependencies<VetKey>> = {},
): VetKeyDemoDependencies<VetKey> {
  let approved = false;
  const base: VetKeyDemoDependencies<VetKey> = {
    createTransport: () => transport,
    randomBytes: (length) => new Uint8Array(length).fill(0x5a),
    derive: async (request, options): Promise<VetKeyDeriveResult> => {
      expect(request.slot).toBe(binding.slot);
      expect(request.generation).toBe(binding.generation);
      expect(request.transportPublicKey).toHaveLength(48);
      expect(request.requestNonce).toEqual(new Uint8Array(32).fill(0x5a));
      options.onChallenge({
        type: "challenge",
        challengeId: "vkc_0123456789abcdef0123456789abcdef",
        expiresAt: "18446744073709551615",
      });
      await Promise.resolve();
      expect(approved).toBe(true);
      return {
        encryptedKey: Array.from(fromHex(
          vector.generations.current.encryptedVetKeyHex,
        )),
        publicInfo: binding,
      };
    },
    approve: async (challengeId) => {
      expect(challengeId).toBe("vkc_0123456789abcdef0123456789abcdef");
      approved = true;
    },
    decrypt: (ciphertext, keyHandle) =>
      IbeCiphertext.deserialize(ciphertext).decrypt(keyHandle),
  };
  return { ...base, ...overrides };
}

describe("Kitchen Sink vetKeys round-trip", () => {
  test("encrypts publicly, confirms one challenge, and returns plaintext without key bytes", async () => {
    const vector = await loadVector();
    const binding = publicInfo(vector);
    const transport = new VectorTransport(fromHex(vector.transport.secretKeyHex));
    const message = "Kitchen Sink private round-trip ✓";
    const envelope = createVetKeyDemoEnvelope(binding, message);

    expect(envelope.binding).not.toBe(binding);
    expect(envelope.binding.publicKey).not.toBe(binding.publicKey);
    expect(envelope.plaintextBytes).toBe(new TextEncoder().encode(message).length);
    expect(envelope.ciphertext).toHaveLength(
      IbeCiphertext.ciphertextSize(envelope.plaintextBytes),
    );

    const recovered = await recoverVetKeyDemoEnvelope(
      envelope,
      dependencies(vector, binding, transport),
    );
    expect(recovered).toEqual({
      slot: "demo_key",
      generation: binding.generation,
      publicFingerprint: binding.publicFingerprint
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
      ciphertextBytes: envelope.ciphertext.length,
      plaintextBytes: envelope.plaintextBytes,
      recoveredText: message,
      verified: true,
    });
    expect(Object.keys(recovered).sort()).toEqual([
      "ciphertextBytes",
      "generation",
      "plaintextBytes",
      "publicFingerprint",
      "recoveredText",
      "slot",
      "verified",
    ]);
    const projection = JSON.stringify(recovered);
    expect(projection).not.toContain(vector.transport.secretKeyHex);
    expect(projection).not.toContain(
      vector.generations.current.encryptedVetKeyHex,
    );
    expect(transport.consumed).toBe(1);
    expect(transport.cancelled).toBe(1);
  });

  test("rejects a changed public binding before consuming the encrypted key", async () => {
    const vector = await loadVector();
    const binding = publicInfo(vector);
    const changed = {
      ...binding,
      publicFingerprint: binding.publicFingerprint.map((byte, index) =>
        index === 0 ? byte ^ 1 : byte
      ),
    };
    const transport = new VectorTransport(fromHex(vector.transport.secretKeyHex));
    const envelope = createVetKeyDemoEnvelope(binding, "Binding check");

    await expect(recoverVetKeyDemoEnvelope(
      envelope,
      dependencies(vector, binding, transport, {
        derive: async (_request, options) => {
          options.onChallenge({
            type: "challenge",
            challengeId: "vkc_0123456789abcdef0123456789abcdef",
            expiresAt: "18446744073709551615",
          });
          return {
            encryptedKey: Array.from(fromHex(
              vector.generations.current.encryptedVetKeyHex,
            )),
            publicInfo: changed,
          };
        },
      }),
    )).rejects.toThrow("changed its public slot binding");
    expect(transport.consumed).toBe(0);
    expect(transport.cancelled).toBe(1);
  });

  test("bounds plaintext and rejects modified ciphertext before derivation", async () => {
    const vector = await loadVector();
    const binding = publicInfo(vector);
    expect(() => createVetKeyDemoEnvelope(binding, "")).toThrow("1-512");
    expect(() => createVetKeyDemoEnvelope(
      binding,
      "x".repeat(VETKEY_DEMO_MAX_PLAINTEXT_BYTES + 1),
    )).toThrow("1-512");

    const envelope = createVetKeyDemoEnvelope(binding, "Ciphertext check");
    envelope.ciphertext.pop();
    let created = 0;
    await expect(recoverVetKeyDemoEnvelope(envelope, {
      ...dependencies(
        vector,
        binding,
        new VectorTransport(fromHex(vector.transport.secretKeyHex)),
      ),
      createTransport() {
        created += 1;
        throw new Error("transport should not be created");
      },
    })).rejects.toThrow("Invalid vetKeys demo IBE ciphertext");
    expect(created).toBe(0);
  });
});
