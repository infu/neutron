import {
  lp,
  metadataRecordKeyInput,
  contentRecordKeyInput,
  assertBytes,
  assertFixedBytes,
} from "./canonical.ts";
import {
  FILES_AES_GCM_NONCE_BYTES,
  FILES_AES_GCM_TAG_BYTES,
  FILES_SHA256_BYTES,
  FILES_VAULT_ROOT_BYTES,
  type FilesContentBinding,
  type FilesId128,
} from "./types.ts";

export type FilesAesGcmKey = Readonly<{
  key: CryptoKey;
  subtle: SubtleCrypto;
}>;

export type FilesHmacKey = Readonly<{
  key: CryptoKey;
  subtle: SubtleCrypto;
}>;

export type FilesVaultKeys = Readonly<{
  context: Uint8Array;
  nameIndexKey: FilesHmacKey;
  metadataKey: FilesHmacKey;
  contentWrapKey: FilesHmacKey;
  subtle: SubtleCrypto;
}>;

export function requireFilesSubtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (
    !subtle ||
    typeof subtle.importKey !== "function" ||
    typeof subtle.deriveKey !== "function" ||
    typeof subtle.digest !== "function" ||
    typeof subtle.sign !== "function" ||
    typeof subtle.encrypt !== "function" ||
    typeof subtle.decrypt !== "function"
  ) {
    throw new Error("Secure WebCrypto is unavailable");
  }
  return subtle;
}

export function requireFilesSecureRandom(): Crypto {
  if (
    !globalThis.crypto ||
    typeof globalThis.crypto.getRandomValues !== "function"
  ) {
    throw new Error("Secure browser randomness is unavailable");
  }
  return globalThis.crypto;
}

export function secureRandomBytes(
  length: number,
  crypto = requireFilesSecureRandom(),
): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 1 || length > 65_536) {
    throw new Error("Files random byte length is invalid");
  }
  const output = new Uint8Array(length);
  crypto.getRandomValues(output);
  return output;
}

export async function sha256(
  value: Uint8Array,
  subtle = requireFilesSubtleCrypto(),
): Promise<Uint8Array> {
  assertBytes(value, "Files SHA-256 input");
  const digest = new Uint8Array(await subtle.digest(
    "SHA-256",
    value as Uint8Array<ArrayBuffer>,
  ));
  assertFixedBytes(digest, FILES_SHA256_BYTES, "Files SHA-256 digest");
  return digest;
}

export async function deriveVaultKeys(
  vaultRoot: Uint8Array,
  context: Uint8Array,
  subtle = requireFilesSubtleCrypto(),
): Promise<FilesVaultKeys> {
  assertFixedBytes(vaultRoot, FILES_VAULT_ROOT_BYTES, "Files vault root");
  assertBytes(context, "Files vault context");
  const base = await subtle.importKey(
    "raw",
    vaultRoot as Uint8Array<ArrayBuffer>,
    "HKDF",
    false,
    ["deriveKey"],
  );
  assertSecretKey(base, "HKDF", false, ["deriveKey"]);
  const salt = await sha256(context, subtle);
  try {
    const [nameIndexKey, metadataKey, contentWrapKey] = await Promise.all([
      deriveHmacKey(base, salt, lp("name-index"), subtle),
      deriveHmacKey(base, salt, lp("metadata"), subtle),
      deriveHmacKey(base, salt, lp("content-wrap"), subtle),
    ]);
    return {
      context: context.slice(),
      nameIndexKey,
      metadataKey,
      contentWrapKey,
      subtle,
    };
  } finally {
    zeroBytes(salt);
  }
}

export async function hmacSha256(
  key: FilesHmacKey,
  value: Uint8Array,
): Promise<Uint8Array> {
  assertHmacKey(key);
  assertBytes(value, "Files HMAC input");
  const signature = new Uint8Array(await key.subtle.sign(
    "HMAC",
    key.key,
    value as Uint8Array<ArrayBuffer>,
  ));
  assertFixedBytes(signature, FILES_SHA256_BYTES, "Files HMAC output");
  return signature;
}

export async function deriveMetadataRecordKey(
  keys: FilesVaultKeys,
  nodeId: FilesId128,
  metadataRevision: string,
): Promise<FilesAesGcmKey> {
  const raw = await hmacSha256(
    keys.metadataKey,
    metadataRecordKeyInput(nodeId, metadataRevision),
  );
  try {
    return await importAesGcmKey(raw, ["encrypt", "decrypt"], keys.subtle);
  } finally {
    zeroBytes(raw);
  }
}

export async function deriveContentRecordWrapKey(
  keys: FilesVaultKeys,
  binding: FilesContentBinding,
): Promise<FilesAesGcmKey> {
  const raw = await hmacSha256(
    keys.contentWrapKey,
    contentRecordKeyInput(binding),
  );
  try {
    return await importAesGcmKey(raw, ["encrypt", "decrypt"], keys.subtle);
  } finally {
    zeroBytes(raw);
  }
}

export async function importAesGcmKey(
  raw: Uint8Array,
  usages: readonly ("encrypt" | "decrypt")[],
  subtle = requireFilesSubtleCrypto(),
): Promise<FilesAesGcmKey> {
  assertFixedBytes(raw, 32, "Files AES-256 key");
  assertAesUsages(usages);
  const key = await subtle.importKey(
    "raw",
    raw as Uint8Array<ArrayBuffer>,
    { name: "AES-GCM", length: 256 },
    false,
    [...usages],
  );
  assertSecretKey(key, "AES-GCM", false, usages);
  if ((key.algorithm as AesKeyAlgorithm).length !== 256) {
    throw new Error("WebCrypto returned an incompatible Files AES key");
  }
  return { key, subtle };
}

export async function encryptAesGcm(
  key: FilesAesGcmKey,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  assertAesKey(key, "encrypt");
  assertFixedBytes(nonce, FILES_AES_GCM_NONCE_BYTES, "Files AES-GCM nonce");
  assertBytes(aad, "Files AES-GCM AAD");
  assertBytes(plaintext, "Files AES-GCM plaintext");
  return new Uint8Array(await key.subtle.encrypt(
    aesParameters(nonce, aad),
    key.key,
    plaintext as Uint8Array<ArrayBuffer>,
  ));
}

export async function decryptAesGcm(
  key: FilesAesGcmKey,
  nonce: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  assertAesKey(key, "decrypt");
  assertFixedBytes(nonce, FILES_AES_GCM_NONCE_BYTES, "Files AES-GCM nonce");
  assertBytes(aad, "Files AES-GCM AAD");
  assertBytes(ciphertext, "Files AES-GCM ciphertext");
  if (ciphertext.byteLength < FILES_AES_GCM_TAG_BYTES) {
    throw new Error("Files AES-GCM ciphertext is too short");
  }
  return new Uint8Array(await key.subtle.decrypt(
    aesParameters(nonce, aad),
    key.key,
    ciphertext as Uint8Array<ArrayBuffer>,
  ));
}

export function zeroBytes(value: Uint8Array): void {
  if (value instanceof Uint8Array) value.fill(0);
}

async function deriveHmacKey(
  base: CryptoKey,
  salt: Uint8Array,
  info: Uint8Array,
  subtle: SubtleCrypto,
): Promise<FilesHmacKey> {
  const key = await subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt as Uint8Array<ArrayBuffer>,
      info: info as Uint8Array<ArrayBuffer>,
    },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  assertSecretKey(key, "HMAC", false, ["sign"]);
  const algorithm = key.algorithm as HmacKeyAlgorithm;
  if (algorithm.hash.name !== "SHA-256" || algorithm.length !== 256) {
    throw new Error("WebCrypto returned an incompatible Files HMAC key");
  }
  return { key, subtle };
}

function aesParameters(
  nonce: Uint8Array,
  aad: Uint8Array,
): AesGcmParams {
  return {
    name: "AES-GCM",
    iv: nonce as Uint8Array<ArrayBuffer>,
    additionalData: aad as Uint8Array<ArrayBuffer>,
    tagLength: FILES_AES_GCM_TAG_BYTES * 8,
  };
}

function assertAesKey(
  value: FilesAesGcmKey,
  usage: "encrypt" | "decrypt",
): void {
  if (!value || !value.subtle || !value.key.usages.includes(usage)) {
    throw new Error(`Files AES key cannot ${usage}`);
  }
  assertSecretKey(value.key, "AES-GCM", false, value.key.usages);
}

function assertHmacKey(value: FilesHmacKey): void {
  if (!value || !value.subtle) throw new Error("Files HMAC key is invalid");
  assertSecretKey(value.key, "HMAC", false, ["sign"]);
}

function assertSecretKey(
  key: CryptoKey,
  algorithm: string,
  extractable: boolean,
  usages: readonly KeyUsage[],
): void {
  if (
    !key ||
    key.type !== "secret" ||
    key.extractable !== extractable ||
    key.algorithm.name !== algorithm ||
    !sameUsages(key.usages, usages)
  ) {
    throw new Error(`WebCrypto returned an incompatible ${algorithm} key`);
  }
}

function assertAesUsages(
  usages: readonly ("encrypt" | "decrypt")[],
): void {
  if (
    usages.length < 1 ||
    usages.length > 2 ||
    new Set(usages).size !== usages.length ||
    usages.some((usage) => usage !== "encrypt" && usage !== "decrypt")
  ) {
    throw new Error("Files AES key usages are invalid");
  }
}

function sameUsages(
  actual: readonly KeyUsage[],
  expected: readonly KeyUsage[],
): boolean {
  return actual.length === expected.length &&
    expected.every((usage) => actual.includes(usage));
}
