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
  assertBytes,
  assertFixedBytes,
  copyBytes,
} from "./canonical.ts";
import {
  FILES_SHA256_BYTES,
  FILES_VAULT_ROOT_BYTES,
} from "./types.ts";
import { zeroBytes } from "./webcrypto.ts";

export const FILES_VETKEY_SLOT = "files_vault";
export const FILES_IBE_SEED_BYTES = 32;
export const FILES_IBE_WRAPPER_BYTES = 168;
export const FILES_TRANSPORT_PUBLIC_KEY_BYTES = 48;
export const FILES_ENCRYPTED_VETKEY_BYTES = 192;
export const FILES_CONTEXT_PUBLIC_KEY_BYTES = 96;
export const FILES_DERIVATION_INPUT_BYTES = 32;

export type FilesVetKeyEnvironmentKey = "key_1" | "test_key_1";

export type FilesVetKeyPublicInfo = Readonly<{
  canisterPrincipal: string;
  canisterPrincipalBytes: Uint8Array;
  slot: typeof FILES_VETKEY_SLOT;
  generation: string;
  suite: "bls12_381_g2";
  keyName: FilesVetKeyEnvironmentKey;
  publicKey: Uint8Array;
  publicFingerprint: Uint8Array;
  derivationInput: Uint8Array;
}>;

export type FilesIbePublicInfo = Readonly<{
  contextPublicKey: Uint8Array;
  effectiveIbeIdentity: Uint8Array;
}>;

export interface FilesIbeAdapter<KeyHandle> {
  wrapRoot(input: {
    target: FilesIbePublicInfo;
    vaultRoot: Uint8Array;
    seed: Uint8Array;
  }): Promise<Uint8Array>;
  unwrapRoot(input: {
    target: FilesIbePublicInfo;
    keyHandle: KeyHandle;
    wrapper: Uint8Array;
  }): Promise<Uint8Array>;
}

export class OfficialFilesIbeAdapter
  implements FilesIbeAdapter<VetKey>
{
  async wrapRoot(input: {
    target: FilesIbePublicInfo;
    vaultRoot: Uint8Array;
    seed: Uint8Array;
  }): Promise<Uint8Array> {
    assertPinnedFilesIbeShape();
    const root = checkedCopy(
      input.vaultRoot,
      FILES_VAULT_ROOT_BYTES,
      "Files vault root",
    );
    const seed = checkedCopy(
      input.seed,
      FILES_IBE_SEED_BYTES,
      "Files IBE seed",
    );
    try {
      const ciphertext = IbeCiphertext.encrypt(
        deserializePublicKey(input.target),
        deserializeIdentity(input.target),
        root,
        IbeSeed.fromBytes(seed),
      ).serialize();
      return checkedCopy(
        ciphertext,
        FILES_IBE_WRAPPER_BYTES,
        "Files vault wrapper",
      );
    } finally {
      zeroBytes(root);
      zeroBytes(seed);
    }
  }

  async unwrapRoot(input: {
    target: FilesIbePublicInfo;
    keyHandle: VetKey;
    wrapper: Uint8Array;
  }): Promise<Uint8Array> {
    assertPinnedFilesIbeShape();
    deserializePublicKey(input.target);
    deserializeIdentity(input.target);
    const wrapper = checkedCopy(
      input.wrapper,
      FILES_IBE_WRAPPER_BYTES,
      "Files vault wrapper",
    );
    try {
      const root = IbeCiphertext.deserialize(wrapper).decrypt(input.keyHandle);
      try {
        return checkedCopy(
          root,
          FILES_VAULT_ROOT_BYTES,
          "Files vault root",
        );
      } finally {
        zeroBytes(root);
      }
    } finally {
      zeroBytes(wrapper);
    }
  }
}

/**
 * One-use holder for the official transport secret. It has no serializer or
 * secret accessor and is consumed before encrypted-key verification begins.
 */
export class FilesVetKeyTransportSession {
  #secret: TransportSecretKey | null;
  readonly #publicKey: Uint8Array;

  private constructor(secret: TransportSecretKey) {
    this.#secret = secret;
    this.#publicKey = checkedCopy(
      secret.publicKeyBytes(),
      FILES_TRANSPORT_PUBLIC_KEY_BYTES,
      "Files transport public key",
    );
  }

  static random(): FilesVetKeyTransportSession {
    return new FilesVetKeyTransportSession(TransportSecretKey.random());
  }

  get consumed(): boolean {
    return this.#secret === null;
  }

  publicKeyBytes(): Uint8Array {
    return this.#publicKey.slice();
  }

  cancel(): void {
    this.#secret = null;
  }

  consume(input: {
    encryptedVetKey: Uint8Array;
    contextPublicKey: Uint8Array;
    derivationInput: Uint8Array;
  }): VetKey {
    const secret = this.#secret;
    if (secret === null) {
      throw new Error("Files transport session was already consumed");
    }
    this.#secret = null;
    const encryptedVetKey = checkedCopy(
      input.encryptedVetKey,
      FILES_ENCRYPTED_VETKEY_BYTES,
      "Encrypted Files VetKey",
    );
    const contextPublicKey = checkedCopy(
      input.contextPublicKey,
      FILES_CONTEXT_PUBLIC_KEY_BYTES,
      "Files context public key",
    );
    const derivationInput = checkedCopy(
      input.derivationInput,
      FILES_DERIVATION_INPUT_BYTES,
      "Files derivation input",
    );
    try {
      return EncryptedVetKey.deserialize(encryptedVetKey).decryptAndVerify(
        secret,
        DerivedPublicKey.deserialize(contextPublicKey),
        derivationInput,
      );
    } finally {
      zeroBytes(encryptedVetKey);
      zeroBytes(contextPublicKey);
      zeroBytes(derivationInput);
    }
  }
}

export function validateFilesVetKeyPublicInfo(
  value: FilesVetKeyPublicInfo,
): FilesVetKeyPublicInfo {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.canisterPrincipal !== "string" ||
    value.canisterPrincipal.length < 3 ||
    value.canisterPrincipal.length > 63 ||
    value.slot !== FILES_VETKEY_SLOT ||
    value.suite !== "bls12_381_g2" ||
    (value.keyName !== "key_1" && value.keyName !== "test_key_1") ||
    !isPositiveCanonicalNat64(value.generation)
  ) {
    throw new Error("Files vetKey public information is incompatible");
  }
  const publicKey = checkedCopy(
    value.publicKey,
    FILES_CONTEXT_PUBLIC_KEY_BYTES,
    "Files context public key",
  );
  const derivationInput = checkedCopy(
    value.derivationInput,
    FILES_DERIVATION_INPUT_BYTES,
    "Files derivation input",
  );
  DerivedPublicKey.deserialize(publicKey);
  IbeIdentity.fromBytes(derivationInput);
  return {
    canisterPrincipal: value.canisterPrincipal,
    canisterPrincipalBytes: validatePrincipalBytes(
      value.canisterPrincipalBytes,
    ),
    slot: FILES_VETKEY_SLOT,
    generation: value.generation,
    suite: "bls12_381_g2",
    keyName: value.keyName,
    publicKey,
    publicFingerprint: checkedCopy(
      value.publicFingerprint,
      FILES_SHA256_BYTES,
      "Files public-key fingerprint",
    ),
    derivationInput,
  };
}

export function filesIbePublicInfo(
  value: FilesVetKeyPublicInfo,
): FilesIbePublicInfo {
  const validated = validateFilesVetKeyPublicInfo(value);
  return {
    contextPublicKey: validated.publicKey,
    effectiveIbeIdentity: validated.derivationInput,
  };
}

export function sameFilesVetKeyBinding(
  left: FilesVetKeyPublicInfo,
  right: FilesVetKeyPublicInfo,
): boolean {
  return (
    left.canisterPrincipal === right.canisterPrincipal &&
    sameBytes(left.canisterPrincipalBytes, right.canisterPrincipalBytes) &&
    left.slot === right.slot &&
    left.generation === right.generation &&
    left.suite === right.suite &&
    left.keyName === right.keyName &&
    sameBytes(left.publicKey, right.publicKey) &&
    sameBytes(left.publicFingerprint, right.publicFingerprint) &&
    sameBytes(left.derivationInput, right.derivationInput)
  );
}

export function assertPinnedFilesIbeShape(): void {
  if (
    IbeCiphertext.ciphertextSize(FILES_VAULT_ROOT_BYTES) !==
      FILES_IBE_WRAPPER_BYTES ||
    IbeCiphertext.plaintextSize(FILES_IBE_WRAPPER_BYTES) !==
      FILES_VAULT_ROOT_BYTES
  ) {
    throw new Error("The pinned Files vetKeys IBE shape is incompatible");
  }
}

export type FilesVetKeyHandle = VetKey;

function deserializePublicKey(
  input: FilesIbePublicInfo,
): DerivedPublicKey {
  const bytes = checkedCopy(
    input.contextPublicKey,
    FILES_CONTEXT_PUBLIC_KEY_BYTES,
    "Files context public key",
  );
  return DerivedPublicKey.deserialize(bytes);
}

function deserializeIdentity(input: FilesIbePublicInfo): IbeIdentity {
  const bytes = checkedCopy(
    input.effectiveIbeIdentity,
    FILES_DERIVATION_INPUT_BYTES,
    "Files derivation input",
  );
  return IbeIdentity.fromBytes(bytes);
}

function checkedCopy(
  value: Uint8Array,
  length: number,
  label: string,
): Uint8Array {
  assertFixedBytes(value, length, label);
  return copyBytes(value);
}

function isPositiveCanonicalNat64(value: string): boolean {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 20 ||
    !/^[1-9][0-9]*$/u.test(value)
  ) {
    return false;
  }
  return BigInt(value) <= 0xffff_ffff_ffff_ffffn;
}

function validatePrincipalBytes(value: Uint8Array): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < 1 ||
    value.byteLength > 29
  ) {
    throw new Error("Files canister principal bytes are invalid");
  }
  return value.slice();
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  assertBytes(left, "Files binding");
  assertBytes(right, "Files binding");
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}
