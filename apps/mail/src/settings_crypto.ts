import {
  MAIL_AES_TAG_BITS,
  MAIL_CEK_BYTES,
  MAIL_IBE_SEED_BYTES,
  MailCryptoError,
  type MailIbeAdapter,
  type MailIbePublicKeyInfo,
  type MailLocalCekWrap,
} from "./crypto.ts";
import {
  decryptMailAesGcm,
  encryptMailAesGcm,
  importMailAesGcmKey,
  requireMailSecureRandom,
} from "./aes_gcm.ts";
import {
  MAIL_LIMITS,
  validateClaimedSenderName,
  validateFingerprint,
  validateFixedBytes,
  validateNonzeroFixedBytes,
} from "./model.ts";
import { computeMailKeyFingerprint, principalBytes } from "./protocol.ts";

export const MAIL_SETTINGS_AAD_DOMAIN = "neutron-mail-settings-v1";
export const MAIL_SETTINGS_RECORD_ID_BYTES = 16;
export const MAIL_SETTINGS_CIPHERTEXT_MAX_BYTES = 4_096;

export type MailEncryptedSettingsV1 = {
  recordId: Uint8Array;
  revision: bigint;
  localWrap: MailLocalCekWrap;
  nonce: Uint8Array;
  ciphertextAndTag: Uint8Array;
};

export type EncryptMailSettingsV1Input = {
  selfPrincipal: string;
  senderName: string;
  recordId: Uint8Array;
  revision: bigint;
  localKey: MailIbePublicKeyInfo;
  adapter?: MailIbeAdapter;
};

export type DecryptMailSettingsV1Input<KeyHandle> = {
  selfPrincipal: string;
  encrypted: MailEncryptedSettingsV1;
  localKey: MailIbePublicKeyInfo;
  keyHandle: KeyHandle;
  adapter?: MailIbeAdapter<KeyHandle>;
};

/** Encrypt the local sender profile with a fresh CEK, nonce, and IBE wrap. */
export async function encryptMailSettingsV1(
  input: EncryptMailSettingsV1Input,
): Promise<MailEncryptedSettingsV1> {
  const cryptoApi = requireCrypto();
  const adapter = requireAdapter(input.adapter);
  const key = normalizeKey(input.localKey);
  const recordId = validateNonzeroFixedBytes(
    input.recordId,
    MAIL_SETTINGS_RECORD_ID_BYTES,
    "Mail settings record id",
  );
  const revision = validateRevision(input.revision);
  const plaintext = encodeMailSettingsContentV1(input.senderName);
  const nonce = randomNonzeroBytes(cryptoApi, MAIL_LIMITS.nonceBytes);
  const cek = randomNonzeroBytes(cryptoApi, MAIL_CEK_BYTES);
  const wrapCek = cek.slice();
  const seed = randomNonzeroBytes(cryptoApi, MAIL_IBE_SEED_BYTES);

  try {
    let wrappedCek: Uint8Array;
    try {
      wrappedCek = validateNonzeroFixedBytes(
        await adapter.wrapCek({ target: key, cek: wrapCek, seed }),
        MAIL_LIMITS.wrappedCekBytes,
        "Mail settings wrapped content key",
      );
    } catch {
      throw new MailCryptoError(
        "KEY_WRAP_FAILED",
        "Mail settings content key could not be wrapped",
      );
    } finally {
      zero(wrapCek);
      zero(seed);
    }

    try {
      const aesKey = await importSettingsAesKey(cek, ["encrypt"]);
      const ciphertextAndTag = await encryptMailAesGcm(
        aesKey,
        nonce,
        buildMailSettingsAad(input.selfPrincipal, recordId, revision),
        plaintext,
      );
      if (
        ciphertextAndTag.byteLength < MAIL_AES_TAG_BITS / 8 ||
        ciphertextAndTag.byteLength > MAIL_SETTINGS_CIPHERTEXT_MAX_BYTES
      ) {
        throw new Error("noncanonical settings ciphertext");
      }
      return {
        recordId,
        revision,
        localWrap: {
          epoch: key.epoch,
          fingerprint: key.fingerprint.slice(),
          wrappedCek,
        },
        nonce,
        ciphertextAndTag,
      };
    } catch (error) {
      if (error instanceof MailCryptoError) throw error;
      throw new MailCryptoError(
        "AUTHENTICATION_FAILED",
        "Mail settings encryption failed",
      );
    }
  } finally {
    zero(cek);
    zero(wrapCek);
    zero(seed);
    zero(plaintext);
  }
}

/** Authenticate the complete settings record before returning its sender name. */
export async function decryptMailSettingsV1<KeyHandle>(
  input: DecryptMailSettingsV1Input<KeyHandle>,
): Promise<{ senderName: string }> {
  const adapter = requireAdapter(input.adapter);
  const key = normalizeKey(input.localKey);
  const encrypted = normalizeEncrypted(input.encrypted);
  if (
    encrypted.localWrap.epoch !== key.epoch ||
    !sameBytes(encrypted.localWrap.fingerprint, key.fingerprint)
  ) {
    throw new MailCryptoError(
      "INVALID_KEY_INFO",
      "Mail settings key generation does not match its wrap",
    );
  }

  let cek: Uint8Array;
  try {
    cek = validateFixedBytes(
      await adapter.unwrapCek({
        target: key,
        keyHandle: input.keyHandle,
        wrappedCek: encrypted.localWrap.wrappedCek,
      }),
      MAIL_CEK_BYTES,
      "Mail settings content key",
    );
  } catch {
    throw new MailCryptoError(
      "KEY_UNWRAP_FAILED",
      "Mail settings content key could not be unwrapped",
    );
  }

  try {
    const aesKey = await importSettingsAesKey(cek, ["decrypt"]);
    const plaintext = await decryptMailAesGcm(
      aesKey,
      encrypted.nonce,
      buildMailSettingsAad(
        input.selfPrincipal,
        encrypted.recordId,
        encrypted.revision,
      ),
      encrypted.ciphertextAndTag,
    );
    try {
      return { senderName: decodeMailSettingsContentV1(plaintext) };
    } finally {
      zero(plaintext);
    }
  } catch (error) {
    if (error instanceof MailCryptoError && error.code === "CRYPTO_UNAVAILABLE") {
      throw error;
    }
    throw new MailCryptoError(
      "AUTHENTICATION_FAILED",
      "Mail settings could not be authenticated or decrypted",
    );
  } finally {
    zero(cek);
  }
}

/** Deterministic CBOR: { 1: schema = 1, 2: sender_name }. */
export function encodeMailSettingsContentV1(senderName: unknown): Uint8Array {
  const name = validateClaimedSenderName(senderName);
  const text = new TextEncoder().encode(name);
  return concat(Uint8Array.of(0xa2, 0x01, 0x01, 0x02), encodeTextHead(text.byteLength), text);
}

export function decodeMailSettingsContentV1(value: Uint8Array): string {
  if (!(value instanceof Uint8Array) || value.byteLength < 6) invalidSettings();
  let cursor = 0;
  if (
    value[cursor++] !== 0xa2 ||
    value[cursor++] !== 0x01 ||
    value[cursor++] !== 0x01 ||
    value[cursor++] !== 0x02
  ) invalidSettings();
  const [length, next] = decodeTextHead(value, cursor);
  cursor = next;
  if (cursor + length !== value.byteLength) invalidSettings();
  let name: string;
  try {
    name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      value.subarray(cursor),
    );
    return validateClaimedSenderName(name);
  } catch {
    return invalidSettings();
  }
}

export function buildMailSettingsAad(
  selfPrincipal: string,
  recordId: Uint8Array,
  revision: bigint,
): Uint8Array {
  const domain = new TextEncoder().encode(MAIL_SETTINGS_AAD_DOMAIN);
  const principal = principalBytes(selfPrincipal);
  const id = validateNonzeroFixedBytes(
    recordId,
    MAIL_SETTINGS_RECORD_ID_BYTES,
    "Mail settings record id",
  );
  if (domain.byteLength > 255 || principal.byteLength > 255) {
    throw new MailCryptoError("INVALID_RECIPIENT", "Mail settings principal is invalid");
  }
  const output = new Uint8Array(1 + domain.byteLength + 1 + principal.byteLength + 16 + 8);
  let cursor = 0;
  output[cursor++] = domain.byteLength;
  output.set(domain, cursor);
  cursor += domain.byteLength;
  output[cursor++] = principal.byteLength;
  output.set(principal, cursor);
  cursor += principal.byteLength;
  output.set(id, cursor);
  cursor += id.byteLength;
  new DataView(output.buffer).setBigUint64(cursor, validateRevision(revision), false);
  return output;
}

function normalizeEncrypted(value: MailEncryptedSettingsV1): MailEncryptedSettingsV1 {
  if (!value) invalidSettings();
  const ciphertextAndTag = value.ciphertextAndTag;
  if (
    !(ciphertextAndTag instanceof Uint8Array) ||
    ciphertextAndTag.byteLength < MAIL_AES_TAG_BITS / 8 ||
    ciphertextAndTag.byteLength > MAIL_SETTINGS_CIPHERTEXT_MAX_BYTES ||
    ciphertextAndTag.every((byte) => byte === 0)
  ) invalidSettings();
  return {
    recordId: validateNonzeroFixedBytes(
      value.recordId,
      MAIL_SETTINGS_RECORD_ID_BYTES,
      "Mail settings record id",
    ),
    revision: validateRevision(value.revision),
    localWrap: {
      epoch: validateRevision(value.localWrap.epoch),
      fingerprint: validateFingerprint(value.localWrap.fingerprint),
      wrappedCek: validateNonzeroFixedBytes(
        value.localWrap.wrappedCek,
        MAIL_LIMITS.wrappedCekBytes,
        "Mail settings wrapped content key",
      ),
    },
    nonce: validateNonzeroFixedBytes(
      value.nonce,
      MAIL_LIMITS.nonceBytes,
      "Mail settings nonce",
    ),
    ciphertextAndTag: ciphertextAndTag.slice(),
  };
}

function normalizeKey(value: MailIbePublicKeyInfo): MailIbePublicKeyInfo {
  if (!value || value.suite !== 1) {
    throw new MailCryptoError("INVALID_KEY_INFO", "Mail settings key is incompatible");
  }
  const epoch = validateRevision(value.epoch);
  const fingerprint = validateFingerprint(value.fingerprint);
  const expected = computeMailKeyFingerprint({
    suite: 1,
    epoch,
    contextPublicKey: value.contextPublicKey,
    effectiveIbeIdentity: value.effectiveIbeIdentity,
  });
  if (!sameBytes(fingerprint, expected)) {
    throw new MailCryptoError(
      "INVALID_KEY_INFO",
      "Mail settings key fingerprint is invalid",
    );
  }
  return {
    suite: 1,
    epoch,
    fingerprint,
    contextPublicKey: value.contextPublicKey.slice(),
    effectiveIbeIdentity: value.effectiveIbeIdentity.slice(),
  };
}

function validateRevision(value: bigint): bigint {
  if (typeof value !== "bigint" || value < 1n || value > (1n << 64n) - 1n) {
    throw new MailCryptoError("INVALID_ENVELOPE", "Mail settings revision is invalid");
  }
  return value;
}

function encodeTextHead(length: number): Uint8Array {
  if (length < 24) return Uint8Array.of(0x60 + length);
  if (length <= 0xff) return Uint8Array.of(0x78, length);
  if (length <= 0xffff) return Uint8Array.of(0x79, length >>> 8, length & 0xff);
  throw new MailCryptoError("INVALID_ENVELOPE", "Mail settings name is too large");
}

function decodeTextHead(value: Uint8Array, cursor: number): [number, number] {
  const first = value[cursor++];
  if (first === undefined || first < 0x60 || first > 0x79) invalidSettings();
  const additional = first & 0x1f;
  if (additional < 24) return [additional, cursor];
  if (additional === 24) {
    const length = value[cursor++];
    if (length === undefined || length < 24) invalidSettings();
    return [length, cursor];
  }
  if (additional === 25) {
    if (cursor + 2 > value.byteLength) invalidSettings();
    const length = new DataView(value.buffer, value.byteOffset + cursor, 2).getUint16(0, false);
    if (length <= 0xff) invalidSettings();
    return [length, cursor + 2];
  }
  return invalidSettings();
}

function requireAdapter<KeyHandle>(
  adapter: MailIbeAdapter<KeyHandle> | undefined,
): MailIbeAdapter<KeyHandle> {
  if (!adapter || typeof adapter.wrapCek !== "function" || typeof adapter.unwrapCek !== "function") {
    throw new MailCryptoError(
      "IBE_UNAVAILABLE",
      "Private Mail settings require the vetKeys adapter",
    );
  }
  return adapter;
}

function requireCrypto(): Crypto {
  try {
    return requireMailSecureRandom();
  } catch {
    throw new MailCryptoError("CRYPTO_UNAVAILABLE", "Browser cryptography is unavailable");
  }
}

function randomNonzeroBytes(cryptoApi: Crypto, length: number): Uint8Array {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const value = new Uint8Array(length);
    cryptoApi.getRandomValues(value);
    if (value.some((byte) => byte !== 0)) return value;
  }
  throw new MailCryptoError("CRYPTO_UNAVAILABLE", "CSPRNG repeated a Mail settings value");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let cursor = 0;
  for (const part of parts) {
    result.set(part, cursor);
    cursor += part.byteLength;
  }
  return result;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function zero(value: Uint8Array): void {
  value.fill(0);
}

async function importSettingsAesKey(
  raw: Uint8Array,
  usages: readonly ("encrypt" | "decrypt")[],
) {
  try {
    return await importMailAesGcmKey(raw, usages);
  } catch {
    throw new MailCryptoError(
      "CRYPTO_UNAVAILABLE",
      "Secure WebCrypto AES-GCM is unavailable",
    );
  } finally {
    // Retain only the browser-owned, non-extractable key handle once import
    // settles. JavaScript erasure remains best effort by platform definition.
    zero(raw);
  }
}

function invalidSettings(): never {
  throw new MailCryptoError("INVALID_ENVELOPE", "Encrypted Mail settings are invalid");
}
