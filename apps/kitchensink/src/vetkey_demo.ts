import {
  DerivedPublicKey,
  EncryptedVetKey,
  IbeCiphertext,
  IbeIdentity,
  IbeSeed,
  TransportSecretKey,
  type VetKey,
} from "@dfinity/vetkeys";
import {
  approveVetKeyDerivation,
  deriveVetKey,
  type VetKeyDeriveOptions,
  type VetKeyDeriveRequest,
  type VetKeyDeriveResult,
  type VetKeyPublicInfo,
} from "neutron-tools/app";

const TRANSPORT_PUBLIC_KEY_BYTES = 48;
const REQUEST_NONCE_BYTES = 32;
const ENCRYPTED_VETKEY_BYTES = 192;
const CONTEXT_PUBLIC_KEY_BYTES = 96;
const DERIVATION_INPUT_BYTES = 32;
const PUBLIC_FINGERPRINT_BYTES = 32;
const MAX_U64 = 18_446_744_073_709_551_615n;

export const VETKEY_DEMO_MAX_PLAINTEXT_BYTES = 512;

export type VetKeyDemoEnvelope = {
  binding: VetKeyPublicInfo;
  ciphertext: number[];
  plaintextBytes: number;
};

export type VetKeyDemoRecovery = {
  slot: string;
  generation: string;
  publicFingerprint: string;
  ciphertextBytes: number;
  plaintextBytes: number;
  recoveredText: string;
  verified: true;
};

export interface VetKeyDemoTransport<KeyHandle> {
  publicKeyBytes(): Uint8Array;
  consume(input: {
    encryptedVetKey: Uint8Array;
    contextPublicKey: Uint8Array;
    derivationInput: Uint8Array;
  }): KeyHandle;
  cancel(): void;
}

export type VetKeyDemoDependencies<KeyHandle> = {
  createTransport(): VetKeyDemoTransport<KeyHandle>;
  randomBytes(length: number): Uint8Array;
  derive(
    request: VetKeyDeriveRequest,
    options: VetKeyDeriveOptions,
  ): Promise<VetKeyDeriveResult>;
  approve(challengeId: string): Promise<void>;
  decrypt(ciphertext: Uint8Array, keyHandle: KeyHandle): Uint8Array;
};

class OfficialOneUseTransport implements VetKeyDemoTransport<VetKey> {
  #secret: TransportSecretKey | null;
  readonly #publicKey: Uint8Array;

  constructor() {
    this.#secret = TransportSecretKey.random();
    this.#publicKey = fixedBytes(
      this.#secret.publicKeyBytes(),
      TRANSPORT_PUBLIC_KEY_BYTES,
      "transport public key",
    );
  }

  publicKeyBytes(): Uint8Array {
    return this.#publicKey.slice();
  }

  consume(input: {
    encryptedVetKey: Uint8Array;
    contextPublicKey: Uint8Array;
    derivationInput: Uint8Array;
  }): VetKey {
    const secret = this.#secret;
    if (secret === null) throw new Error("The demo transport was already consumed");
    // Remove the final reusable reference before verification, so failure is
    // just as non-retryable as success.
    this.#secret = null;
    return EncryptedVetKey.deserialize(
      fixedBytes(
        input.encryptedVetKey,
        ENCRYPTED_VETKEY_BYTES,
        "encrypted VetKey",
      ),
    ).decryptAndVerify(
      secret,
      DerivedPublicKey.deserialize(
        fixedBytes(
          input.contextPublicKey,
          CONTEXT_PUBLIC_KEY_BYTES,
          "context public key",
        ),
      ),
      fixedBytes(
        input.derivationInput,
        DERIVATION_INPUT_BYTES,
        "derivation input",
      ),
    );
  }

  cancel(): void {
    this.#secret = null;
  }
}

const officialDependencies: VetKeyDemoDependencies<VetKey> = {
  createTransport: () => new OfficialOneUseTransport(),
  randomBytes(length) {
    const output = new Uint8Array(length);
    crypto.getRandomValues(output);
    return output;
  },
  derive: deriveVetKey,
  approve: (challengeId) => approveVetKeyDerivation({ challengeId }),
  decrypt: (ciphertext, keyHandle) =>
    IbeCiphertext.deserialize(ciphertext).decrypt(keyHandle),
};

/**
 * Encrypt a short local fixture using only the slot's public information.
 * The returned envelope contains ciphertext and public binding metadata only.
 */
export function createVetKeyDemoEnvelope(
  publicInfo: VetKeyPublicInfo,
  message: string,
): VetKeyDemoEnvelope {
  const binding = clonePublicInfo(publicInfo);
  if (typeof message !== "string") throw new Error("Invalid demo message");
  const plaintext = new TextEncoder().encode(message);
  if (
    plaintext.byteLength < 1 ||
    plaintext.byteLength > VETKEY_DEMO_MAX_PLAINTEXT_BYTES
  ) {
    throw new Error(
      `The demo message must be 1-${VETKEY_DEMO_MAX_PLAINTEXT_BYTES} UTF-8 bytes`,
    );
  }
  try {
    const ciphertext = IbeCiphertext.encrypt(
      DerivedPublicKey.deserialize(Uint8Array.from(binding.publicKey)),
      IbeIdentity.fromBytes(Uint8Array.from(binding.derivationInput)),
      plaintext,
      IbeSeed.random(),
    ).serialize();
    const expectedLength = IbeCiphertext.ciphertextSize(plaintext.byteLength);
    if (ciphertext.byteLength !== expectedLength) {
      throw new Error("The vetKeys library returned an unexpected ciphertext size");
    }
    return {
      binding,
      ciphertext: Array.from(ciphertext),
      plaintextBytes: plaintext.byteLength,
    };
  } finally {
    plaintext.fill(0);
  }
}

/**
 * Recover the envelope's exact generation through Neutron's source-bound
 * challenge protocol, verify the encrypted VetKey, and decrypt locally.
 * No transport secret, encrypted VetKey, or raw VetKey bytes leave this call.
 */
export async function recoverVetKeyDemoEnvelope<KeyHandle = VetKey>(
  envelope: VetKeyDemoEnvelope,
  dependencies?: VetKeyDemoDependencies<KeyHandle>,
): Promise<VetKeyDemoRecovery> {
  const normalized = normalizeEnvelope(envelope);
  // Reject malformed public points and ciphertext encodings before asking the
  // kernel to spend a derivation dispatch.
  DerivedPublicKey.deserialize(Uint8Array.from(normalized.binding.publicKey));
  IbeCiphertext.deserialize(Uint8Array.from(normalized.ciphertext));
  const deps = (dependencies ?? officialDependencies) as VetKeyDemoDependencies<KeyHandle>;
  const transport = deps.createTransport();
  let requestNonce: Uint8Array | null = null;
  let encryptedVetKey: Uint8Array | null = null;
  let recovered: Uint8Array | null = null;

  try {
    const transportPublicKey = fixedBytes(
      transport.publicKeyBytes(),
      TRANSPORT_PUBLIC_KEY_BYTES,
      "transport public key",
    );
    requestNonce = fixedBytes(
      deps.randomBytes(REQUEST_NONCE_BYTES),
      REQUEST_NONCE_BYTES,
      "request nonce",
    );

    let challengeCount = 0;
    let approval: Promise<void> | null = null;
    let rejectApprovalFailure!: (reason: Error) => void;
    const approvalFailure = new Promise<never>((_resolve, reject) => {
      rejectApprovalFailure = reject;
    });
    const derivation = deps.derive(
      {
        slot: normalized.binding.slot,
        generation: normalized.binding.generation,
        transportPublicKey,
        requestNonce,
      },
      {
        timeout: 90,
        onChallenge(challenge) {
          challengeCount += 1;
          if (challengeCount !== 1) {
            rejectApprovalFailure(
              new Error("The demo received an invalid derivation challenge sequence"),
            );
            return;
          }
          try {
            approval = deps.approve(challenge.challengeId);
            void approval.catch((reason) => {
              rejectApprovalFailure(asError(reason, "VetKey confirmation failed"));
            });
          } catch (reason) {
            rejectApprovalFailure(asError(reason, "VetKey confirmation failed"));
          }
        },
      },
    );
    // The race owns the first outcome; this handler also prevents a late
    // broker rejection becoming unobserved after a failed confirmation.
    void derivation.catch(() => undefined);
    const result = await Promise.race([derivation, approvalFailure]);
    if (challengeCount !== 1 || approval === null) {
      throw new Error("The demo received an invalid derivation challenge sequence");
    }
    await approval;

    const returnedBinding = clonePublicInfo(result.publicInfo);
    if (!samePublicBinding(returnedBinding, normalized.binding)) {
      throw new Error("The derived key response changed its public slot binding");
    }
    encryptedVetKey = fixedBytes(
      result.encryptedKey,
      ENCRYPTED_VETKEY_BYTES,
      "encrypted VetKey",
    );
    const keyHandle = transport.consume({
      encryptedVetKey,
      contextPublicKey: Uint8Array.from(normalized.binding.publicKey),
      derivationInput: Uint8Array.from(normalized.binding.derivationInput),
    });
    recovered = fixedBytes(
      deps.decrypt(Uint8Array.from(normalized.ciphertext), keyHandle),
      normalized.plaintextBytes,
      "recovered plaintext",
    );
    const recoveredText = new TextDecoder("utf-8", { fatal: true }).decode(recovered);
    if (new TextEncoder().encode(recoveredText).byteLength !== normalized.plaintextBytes) {
      throw new Error("The recovered demo text is not canonical UTF-8");
    }
    return {
      slot: normalized.binding.slot,
      generation: normalized.binding.generation,
      publicFingerprint: hex(normalized.binding.publicFingerprint),
      ciphertextBytes: normalized.ciphertext.length,
      plaintextBytes: normalized.plaintextBytes,
      recoveredText,
      verified: true,
    };
  } finally {
    transport.cancel();
    requestNonce?.fill(0);
    encryptedVetKey?.fill(0);
    recovered?.fill(0);
  }
}

function normalizeEnvelope(value: VetKeyDemoEnvelope): VetKeyDemoEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid vetKeys demo envelope");
  }
  const binding = clonePublicInfo(value.binding);
  if (
    !Number.isSafeInteger(value.plaintextBytes) ||
    value.plaintextBytes < 1 ||
    value.plaintextBytes > VETKEY_DEMO_MAX_PLAINTEXT_BYTES
  ) {
    throw new Error("Invalid vetKeys demo plaintext size");
  }
  const ciphertext = fixedBytes(
    value.ciphertext,
    IbeCiphertext.ciphertextSize(value.plaintextBytes),
    "IBE ciphertext",
  );
  return {
    binding,
    ciphertext: Array.from(ciphertext),
    plaintextBytes: value.plaintextBytes,
  };
}

function clonePublicInfo(value: VetKeyPublicInfo): VetKeyPublicInfo {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.canisterPrincipal !== "string" ||
    value.canisterPrincipal.length < 3 ||
    value.canisterPrincipal.length > 80 ||
    typeof value.slot !== "string" ||
    !/^[a-z][a-z0-9_]{0,39}$/u.test(value.slot) ||
    !canonicalGeneration(value.generation) ||
    value.suite !== "bls12_381_g2" ||
    (value.keyName !== "key_1" && value.keyName !== "test_key_1")
  ) {
    throw new Error("Invalid vetKeys demo public binding");
  }
  return {
    canisterPrincipal: value.canisterPrincipal,
    slot: value.slot,
    generation: value.generation,
    suite: value.suite,
    keyName: value.keyName,
    publicKey: Array.from(fixedBytes(
      value.publicKey,
      CONTEXT_PUBLIC_KEY_BYTES,
      "context public key",
    )),
    publicFingerprint: Array.from(fixedBytes(
      value.publicFingerprint,
      PUBLIC_FINGERPRINT_BYTES,
      "public fingerprint",
    )),
    derivationInput: Array.from(fixedBytes(
      value.derivationInput,
      DERIVATION_INPUT_BYTES,
      "derivation input",
    )),
  };
}

function samePublicBinding(
  left: VetKeyPublicInfo,
  right: VetKeyPublicInfo,
): boolean {
  return (
    left.canisterPrincipal === right.canisterPrincipal &&
    left.slot === right.slot &&
    left.generation === right.generation &&
    left.suite === right.suite &&
    left.keyName === right.keyName &&
    sameBytes(left.publicKey, right.publicKey) &&
    sameBytes(left.publicFingerprint, right.publicFingerprint) &&
    sameBytes(left.derivationInput, right.derivationInput)
  );
}

function canonicalGeneration(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/u.test(value)) {
    return false;
  }
  return BigInt(value) <= MAX_U64;
}

function fixedBytes(
  value: ArrayLike<unknown>,
  length: number,
  label: string,
): Uint8Array {
  const bytes = Array.from(value);
  if (
    bytes.length !== length ||
    bytes.some((byte) =>
      typeof byte !== "number" ||
      !Number.isInteger(byte) ||
      byte < 0 ||
      byte > 255
    )
  ) {
    throw new Error(`Invalid vetKeys demo ${label}`);
  }
  return Uint8Array.from(bytes as number[]);
}

function sameBytes(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function hex(bytes: readonly number[]): string {
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function asError(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback);
}
