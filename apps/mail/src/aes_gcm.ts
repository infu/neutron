export const MAIL_AES_256_KEY_BYTES = 32;
export const MAIL_AES_GCM_NONCE_BYTES = 12;
export const MAIL_AES_GCM_TAG_BYTES = 16;

export type MailAesGcmKey = {
  key: CryptoKey;
  subtle: SubtleCrypto;
};

/**
 * Import one non-extractable WebCrypto key. Mail's resident uses Neutron's
 * install-approved dedicated app origin so its Blob worker is a secure context.
 * There is deliberately no JavaScript AES or plaintext compatibility fallback.
 * Callers must best-effort erase `raw` as soon as this promise settles.
 */
export async function importMailAesGcmKey(
  raw: Uint8Array,
  usages: readonly ("encrypt" | "decrypt")[],
  subtle: SubtleCrypto | null = availableSubtleCrypto(),
): Promise<MailAesGcmKey> {
  assertBytes(raw, MAIL_AES_256_KEY_BYTES, "AES-256 key");
  if (
    usages.length === 0 ||
    new Set(usages).size !== usages.length ||
    usages.some((usage) => usage !== "encrypt" && usage !== "decrypt")
  ) {
    throw new Error("AES-GCM key usages are invalid");
  }
  if (!subtle) {
    throw new Error("Secure WebCrypto AES-GCM is unavailable");
  }
  const key = await subtle.importKey(
    "raw",
    raw as Uint8Array<ArrayBuffer>,
    { name: "AES-GCM", length: 256 },
    false,
    [...usages],
  );
  if (
    key.extractable ||
    key.type !== "secret" ||
    key.algorithm.name !== "AES-GCM" ||
    (key.algorithm as AesKeyAlgorithm).length !== 256 ||
    !sameUsages(key.usages, usages)
  ) {
    throw new Error("WebCrypto returned an incompatible AES-GCM key");
  }
  return { key, subtle };
}

export async function encryptMailAesGcm(
  key: MailAesGcmKey,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  assertParameters(nonce, aad, plaintext, false);
  return new Uint8Array(await key.subtle.encrypt(
    parameters(nonce, aad),
    key.key,
    plaintext as Uint8Array<ArrayBuffer>,
  ));
}

export async function decryptMailAesGcm(
  key: MailAesGcmKey,
  nonce: Uint8Array,
  aad: Uint8Array,
  ciphertextAndTag: Uint8Array,
): Promise<Uint8Array> {
  assertParameters(nonce, aad, ciphertextAndTag, true);
  return new Uint8Array(await key.subtle.decrypt(
    parameters(nonce, aad),
    key.key,
    ciphertextAndTag as Uint8Array<ArrayBuffer>,
  ));
}

export function requireMailSecureRandom(): Crypto {
  if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== "function") {
    throw new Error("Secure browser randomness is unavailable");
  }
  return globalThis.crypto;
}

function availableSubtleCrypto(): SubtleCrypto | null {
  const subtle = globalThis.crypto?.subtle;
  return subtle &&
      typeof subtle.importKey === "function" &&
      typeof subtle.encrypt === "function" &&
      typeof subtle.decrypt === "function"
    ? subtle
    : null;
}

function parameters(nonce: Uint8Array, aad: Uint8Array): AesGcmParams {
  return {
    name: "AES-GCM",
    iv: nonce as Uint8Array<ArrayBuffer>,
    additionalData: aad as Uint8Array<ArrayBuffer>,
    tagLength: MAIL_AES_GCM_TAG_BYTES * 8,
  };
}

function assertParameters(
  nonce: Uint8Array,
  aad: Uint8Array,
  content: Uint8Array,
  decrypting: boolean,
): void {
  assertBytes(nonce, MAIL_AES_GCM_NONCE_BYTES, "AES-GCM nonce");
  if (!(aad instanceof Uint8Array)) throw new Error("AES-GCM AAD must be bytes");
  if (!(content instanceof Uint8Array)) throw new Error("AES-GCM content must be bytes");
  if (decrypting && content.byteLength < MAIL_AES_GCM_TAG_BYTES) {
    throw new Error("AES-GCM ciphertext is too short");
  }
}

function assertBytes(value: Uint8Array, length: number, label: string): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new Error(`${label} must be ${length} bytes`);
  }
}

function sameUsages(
  actual: readonly KeyUsage[],
  expected: readonly ("encrypt" | "decrypt")[],
): boolean {
  return actual.length === expected.length &&
    expected.every((usage) => actual.includes(usage));
}
