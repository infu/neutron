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
  MAIL_CEK_BYTES,
  MAIL_IBE_SEED_BYTES,
  type MailIbeAdapter,
  type MailIbePublicKeyInfo,
} from "./crypto.ts";
import { MAIL_LIMITS, validateFixedBytes } from "./model.ts";

export const MAIL_TRANSPORT_PUBLIC_KEY_BYTES = 48;
export const MAIL_ENCRYPTED_VETKEY_BYTES = 192;
export const MAIL_CONTEXT_PUBLIC_KEY_BYTES = 96;
export const MAIL_EFFECTIVE_IBE_IDENTITY_BYTES = 32;

/**
 * The only production IBE implementation used by Mail V1.
 *
 * The official library is deliberately kept behind the small `MailIbeAdapter`
 * boundary so callers cannot select a curve, key name, derivation context, or
 * management-canister input. Those values belong to the kernel capability.
 */
export class OfficialMailIbeAdapter implements MailIbeAdapter<VetKey> {
  async wrapCek(input: {
    target: MailIbePublicKeyInfo;
    cek: Uint8Array;
    seed: Uint8Array;
  }): Promise<Uint8Array> {
    assertPinnedCiphertextShape();
    const cek = validateFixedBytes(input.cek, MAIL_CEK_BYTES, "Content-encryption key");
    const seed = validateFixedBytes(input.seed, MAIL_IBE_SEED_BYTES, "IBE seed");
    try {
      const ciphertext = IbeCiphertext.encrypt(
        deserializePublicKey(input.target),
        deserializeIdentity(input.target),
        cek,
        IbeSeed.fromBytes(seed),
      ).serialize();
      return validateFixedBytes(
        ciphertext,
        MAIL_LIMITS.wrappedCekBytes,
        "Wrapped content key",
      );
    } finally {
      zero(cek);
      zero(seed);
    }
  }

  async unwrapCek(input: {
    target: MailIbePublicKeyInfo;
    keyHandle: VetKey;
    wrappedCek: Uint8Array;
  }): Promise<Uint8Array> {
    assertPinnedCiphertextShape();
    // Deserialize the public values as well as the ciphertext. This fails
    // closed on a malformed key-info projection before any plaintext leaves
    // this adapter, even though IBE decryption itself needs only the VetKey.
    deserializePublicKey(input.target);
    deserializeIdentity(input.target);
    const ciphertext = validateFixedBytes(
      input.wrappedCek,
      MAIL_LIMITS.wrappedCekBytes,
      "Wrapped content key",
    );
    const cek = IbeCiphertext.deserialize(ciphertext).decrypt(input.keyHandle);
    try {
      // `validateFixedBytes` returns the owned copy that leaves this adapter.
      // Zero the official-library buffer even on validation failure so a
      // second raw CEK allocation is not retained until garbage collection.
      return validateFixedBytes(cek, MAIL_CEK_BYTES, "Content-encryption key");
    } finally {
      zero(cek);
    }
  }
}

export function validateOfficialMailKeyInfo(
  input: MailIbePublicKeyInfo,
): MailIbePublicKeyInfo {
  if (!input || input.suite !== 1 || typeof input.epoch !== "bigint" || input.epoch < 1n) {
    throw new Error("Mail key information is incompatible");
  }
  const contextPublicKey = validateFixedBytes(
    input.contextPublicKey,
    MAIL_CONTEXT_PUBLIC_KEY_BYTES,
    "Context public key",
  );
  // Parsing validates that the bytes encode a point in the expected group.
  DerivedPublicKey.deserialize(contextPublicKey);
  const effectiveIbeIdentity = validateFixedBytes(
    input.effectiveIbeIdentity,
    MAIL_EFFECTIVE_IBE_IDENTITY_BYTES,
    "Effective IBE identity",
  );
  IbeIdentity.fromBytes(effectiveIbeIdentity);
  return {
    suite: 1,
    epoch: input.epoch,
    fingerprint: validateFixedBytes(
      input.fingerprint,
      MAIL_LIMITS.fingerprintBytes,
      "Key fingerprint",
    ),
    contextPublicKey,
    effectiveIbeIdentity,
  };
}

/**
 * One-use wrapper around the official ephemeral transport secret.
 *
 * It intentionally has no serialization or secret accessor. Consuming it
 * drops Mail's final reference before verification begins, so success and all
 * failures are equally non-retryable. The wrapper must live in the resident
 * crypto worker and must never cross `postMessage`.
 */
export class MailVetKeyTransportSession {
  #secret: TransportSecretKey | null;
  readonly #publicKey: Uint8Array;

  private constructor(secret: TransportSecretKey) {
    const publicKey = secret.publicKeyBytes();
    this.#publicKey = validateFixedBytes(
      publicKey,
      MAIL_TRANSPORT_PUBLIC_KEY_BYTES,
      "Transport public key",
    );
    this.#secret = secret;
  }

  static random(): MailVetKeyTransportSession {
    return new MailVetKeyTransportSession(TransportSecretKey.random());
  }

  publicKeyBytes(): Uint8Array {
    return this.#publicKey.slice();
  }

  get consumed(): boolean {
    return this.#secret === null;
  }

  consume(input: {
    encryptedVetKey: Uint8Array;
    contextPublicKey: Uint8Array;
    effectiveIbeIdentity: Uint8Array;
  }): VetKey {
    const secret = this.#secret;
    if (secret === null) throw new Error("Mail transport session was already consumed");
    this.#secret = null;

    const encryptedVetKey = validateFixedBytes(
      input.encryptedVetKey,
      MAIL_ENCRYPTED_VETKEY_BYTES,
      "Encrypted VetKey",
    );
    const contextPublicKey = validateFixedBytes(
      input.contextPublicKey,
      MAIL_CONTEXT_PUBLIC_KEY_BYTES,
      "Context public key",
    );
    const identity = validateFixedBytes(
      input.effectiveIbeIdentity,
      MAIL_EFFECTIVE_IBE_IDENTITY_BYTES,
      "Effective IBE identity",
    );

    return EncryptedVetKey.deserialize(encryptedVetKey).decryptAndVerify(
      secret,
      DerivedPublicKey.deserialize(contextPublicKey),
      identity,
    );
  }
}

export function assertPinnedCiphertextShape(): void {
  if (IbeCiphertext.ciphertextSize(MAIL_CEK_BYTES) !== MAIL_LIMITS.wrappedCekBytes) {
    throw new Error("The pinned vetKeys IBE ciphertext shape is incompatible with Mail V1");
  }
  if (IbeCiphertext.plaintextSize(MAIL_LIMITS.wrappedCekBytes) !== MAIL_CEK_BYTES) {
    throw new Error("The pinned vetKeys IBE plaintext shape is incompatible with Mail V1");
  }
}

function deserializePublicKey(input: MailIbePublicKeyInfo): DerivedPublicKey {
  const bytes = validateFixedBytes(
    input.contextPublicKey,
    MAIL_CONTEXT_PUBLIC_KEY_BYTES,
    "Context public key",
  );
  return DerivedPublicKey.deserialize(bytes);
}

function deserializeIdentity(input: MailIbePublicKeyInfo): IbeIdentity {
  const bytes = validateFixedBytes(
    input.effectiveIbeIdentity,
    MAIL_EFFECTIVE_IBE_IDENTITY_BYTES,
    "Effective IBE identity",
  );
  return IbeIdentity.fromBytes(bytes);
}

function zero(value: Uint8Array): void {
  value.fill(0);
}

export type MailVetKeyHandle = VetKey;
