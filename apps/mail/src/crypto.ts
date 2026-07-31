import {
  decodeMailPrivateBodyV1,
  decodeMailPrivateHeaderV1,
  encodeMailPrivateBodyV1,
  encodeMailPrivateHeaderV1,
} from "./content_codec.ts";
import {
  decryptMailAesGcm,
  encryptMailAesGcm,
  importMailAesGcmKey,
  requireMailSecureRandom,
  type MailAesGcmKey,
} from "./aes_gcm.ts";
import {
  MAIL_CIPHER_SUITE,
  MAIL_LIMITS,
  type MailPrivateBody,
  type MailPrivateHeader,
  validateFingerprint,
  validateFixedBytes,
  validateNonzeroFixedBytes,
} from "./model.ts";
import {
  MAIL_BODY_CIPHERTEXT_BUCKETS,
  MAIL_HEADER_CIPHERTEXT_BYTES,
  buildMailSectionAad,
  computeMailKeyFingerprint,
  decodeMailEnvelopeV1,
  encodeMailEnvelopeV1,
  padBodySection,
  padHeaderSection,
  principalBytes,
  unpadBodySection,
  unpadHeaderSection,
  type MailEnvelopeV1,
} from "./protocol.ts";

export const MAIL_CEK_BYTES = 32;
export const MAIL_IBE_SEED_BYTES = 32;
export const MAIL_AES_TAG_BITS = 128;

export type MailIbePublicKeyInfo = {
  suite: 1;
  epoch: bigint;
  fingerprint: Uint8Array;
  contextPublicKey: Uint8Array;
  effectiveIbeIdentity: Uint8Array;
};

export type MailLocalCekWrap = {
  epoch: bigint;
  fingerprint: Uint8Array;
  wrappedCek: Uint8Array;
};

/**
 * Boundary implemented later by the pinned official vetKeys package.
 *
 * `KeyHandle` is adapter-owned, opaque to Mail, and must represent a verified
 * browser-memory key. Implementations must not retain `cek` or expose it in
 * errors/logs. There is intentionally no built-in implementation or fallback.
 */
export interface MailIbeAdapter<KeyHandle = unknown> {
  wrapCek(input: {
    target: MailIbePublicKeyInfo;
    cek: Uint8Array;
    seed: Uint8Array;
  }): Promise<Uint8Array>;

  unwrapCek(input: {
    target: MailIbePublicKeyInfo;
    keyHandle: KeyHandle;
    wrappedCek: Uint8Array;
  }): Promise<Uint8Array>;
}

export type EncryptPrivateMailV1Input = {
  senderPrincipal: string;
  recipientPrincipal: string;
  recipientKey: MailIbePublicKeyInfo;
  senderKey: MailIbePublicKeyInfo;
  header: MailPrivateHeader;
  body: MailPrivateBody;
  adapter?: MailIbeAdapter;
};

export type EncryptedPrivateMailV1 = {
  messageId: Uint8Array;
  envelope: Uint8Array;
  senderLocalWrap: MailLocalCekWrap;
};

export type DecryptPrivateMailV1Input<KeyHandle = unknown> = {
  senderPrincipal: string;
  recipientPrincipal: string;
  envelope: Uint8Array;
  localKey: MailIbePublicKeyInfo;
  keyHandle: KeyHandle;
  localWrap?: MailLocalCekWrap;
  adapter?: MailIbeAdapter<KeyHandle>;
};

export type DecryptedPrivateMailV1 = {
  messageId: Uint8Array;
  header: MailPrivateHeader;
  body: MailPrivateBody;
};

/**
 * The authenticated fields needed to decrypt a list-row header without
 * fetching the (potentially 36 KiB) encrypted body. This is deliberately not
 * an alternate wire format: every field is copied from the canonical backend
 * envelope projection and the same V1 AAD is reconstructed below.
 */
export type MailEncryptedHeaderV1 = {
  deliveryKeyEpoch: bigint;
  recipientKeyFingerprint: Uint8Array;
  messageId: Uint8Array;
  headerNonce: Uint8Array;
  headerCiphertextAndTag: Uint8Array;
};

export type DecryptPrivateMailHeaderV1Input<KeyHandle = unknown> = {
  senderPrincipal: string;
  recipientPrincipal: string;
  encryptedHeader: MailEncryptedHeaderV1;
  localKey: MailIbePublicKeyInfo;
  keyHandle: KeyHandle;
  localWrap: MailLocalCekWrap;
  adapter?: MailIbeAdapter<KeyHandle>;
};

export type DecryptedPrivateMailHeaderV1 = {
  messageId: Uint8Array;
  header: MailPrivateHeader;
};

export type RewrapMailLocalCekInput<KeyHandle = unknown> = {
  oldKey: MailIbePublicKeyInfo;
  newKey: MailIbePublicKeyInfo;
  oldKeyHandle: KeyHandle;
  localWrap: MailLocalCekWrap;
  adapter?: MailIbeAdapter<KeyHandle>;
};

export type MailCryptoErrorCode =
  | "IBE_UNAVAILABLE"
  | "CRYPTO_UNAVAILABLE"
  | "INVALID_KEY_INFO"
  | "INVALID_RECIPIENT"
  | "INVALID_ENVELOPE"
  | "KEY_WRAP_FAILED"
  | "KEY_UNWRAP_FAILED"
  | "AUTHENTICATION_FAILED";

export class MailCryptoError extends Error {
  constructor(
    public readonly code: MailCryptoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MailCryptoError";
  }
}

export async function encryptPrivateMailV1(
  input: EncryptPrivateMailV1Input,
): Promise<EncryptedPrivateMailV1> {
  const adapter = requireAdapter(input.adapter);
  const cryptoApi = requireCrypto();
  const senderPrincipal = principalBytes(input.senderPrincipal);
  const recipientPrincipal = principalBytes(input.recipientPrincipal);
  if (equalBytes(senderPrincipal, recipientPrincipal)) {
    throw new MailCryptoError("INVALID_RECIPIENT", "Mail V1 does not support self-mail");
  }
  const recipientKey = normalizeKeyInfo(input.recipientKey);
  const senderKey = normalizeKeyInfo(input.senderKey);
  const headerCbor = encodeMailPrivateHeaderV1(input.header);
  const bodyCbor = encodeMailPrivateBodyV1(input.body);

  const cek = randomBytes(cryptoApi, MAIL_CEK_BYTES);
  const recipientCek = cek.slice();
  const senderCek = cek.slice();
  const messageId = randomBytes(cryptoApi, MAIL_LIMITS.messageIdBytes);
  const headerNonce = randomBytes(cryptoApi, MAIL_LIMITS.nonceBytes);
  const bodyNonce = randomDistinctBytes(
    cryptoApi,
    MAIL_LIMITS.nonceBytes,
    [headerNonce],
  );
  const recipientSeed = randomDistinctBytes(
    cryptoApi,
    MAIL_IBE_SEED_BYTES,
    [cek],
  );
  const senderSeed = randomDistinctBytes(
    cryptoApi,
    MAIL_IBE_SEED_BYTES,
    [cek, recipientSeed],
  );

  try {
    const aesKey = await importAesKey(cek, ["encrypt"]);
    const headerPadded = padHeaderSection(headerCbor);
    const bodyPadded = padBodySection(bodyCbor);
    const headerAad = buildMailSectionAad({
      senderPrincipal,
      recipientPrincipal,
      deliveryKeyEpoch: recipientKey.epoch,
      recipientKeyFingerprint: recipientKey.fingerprint,
      messageId,
      section: "header",
    });
    const bodyAad = buildMailSectionAad({
      senderPrincipal,
      recipientPrincipal,
      deliveryKeyEpoch: recipientKey.epoch,
      recipientKeyFingerprint: recipientKey.fingerprint,
      messageId,
      section: "body",
    });

    let recipientWrappedCek: Uint8Array;
    let senderWrappedCek: Uint8Array;
    try {
      const wrapped = await Promise.all([
        adapter.wrapCek({
          target: recipientKey,
          cek: recipientCek,
          seed: recipientSeed,
        }),
        adapter.wrapCek({
          target: senderKey,
          cek: senderCek,
          seed: senderSeed,
        }),
      ]);
      recipientWrappedCek = validateWrappedCek(wrapped[0]);
      senderWrappedCek = validateWrappedCek(wrapped[1]);
    } catch {
      throw new MailCryptoError("KEY_WRAP_FAILED", "Mail content key could not be wrapped");
    } finally {
      // Once both IBE operations settle, only their ciphertext wraps and the
      // non-extractable WebCrypto handle are needed for the remaining work.
      zero(recipientCek);
      zero(senderCek);
      zero(recipientSeed);
      zero(senderSeed);
    }

    let headerCiphertextAndTag: Uint8Array;
    let bodyCiphertextAndTag: Uint8Array;
    try {
      [headerCiphertextAndTag, bodyCiphertextAndTag] = await Promise.all([
        aesEncrypt(aesKey, headerNonce, headerAad, headerPadded),
        aesEncrypt(aesKey, bodyNonce, bodyAad, bodyPadded),
      ]);
    } catch {
      throw new MailCryptoError(
        "AUTHENTICATION_FAILED",
        "Mail content encryption failed",
      );
    }
    if (
      headerCiphertextAndTag.byteLength !== MAIL_HEADER_CIPHERTEXT_BYTES ||
      !MAIL_BODY_CIPHERTEXT_BUCKETS.includes(bodyCiphertextAndTag.byteLength)
    ) {
      throw new MailCryptoError(
        "AUTHENTICATION_FAILED",
        "Mail encryption returned a noncanonical ciphertext size",
      );
    }

    const envelope: MailEnvelopeV1 = {
      version: 1,
      suite: MAIL_CIPHER_SUITE,
      deliveryKeyEpoch: recipientKey.epoch,
      recipientKeyFingerprint: recipientKey.fingerprint,
      messageId,
      recipientWrappedCek,
      headerNonce,
      headerCiphertextAndTag,
      bodyNonce,
      bodyCiphertextAndTag,
    };
    return {
      messageId: messageId.slice(),
      envelope: encodeMailEnvelopeV1(envelope),
      senderLocalWrap: {
        epoch: senderKey.epoch,
        fingerprint: senderKey.fingerprint.slice(),
        wrappedCek: senderWrappedCek.slice(),
      },
    };
  } finally {
    zero(cek);
    zero(recipientCek);
    zero(senderCek);
    zero(recipientSeed);
    zero(senderSeed);
  }
}

export async function decryptPrivateMailV1<KeyHandle>(
  input: DecryptPrivateMailV1Input<KeyHandle>,
): Promise<DecryptedPrivateMailV1> {
  const adapter = requireAdapter(input.adapter);
  const localKey = normalizeKeyInfo(input.localKey);
  let envelope: MailEnvelopeV1;
  try {
    envelope = decodeMailEnvelopeV1(input.envelope);
  } catch {
    throw new MailCryptoError("INVALID_ENVELOPE", "Mail envelope is invalid");
  }

  const localWrap = input.localWrap
    ? normalizeLocalWrap(input.localWrap)
    : {
        epoch: envelope.deliveryKeyEpoch,
        fingerprint: envelope.recipientKeyFingerprint,
        wrappedCek: envelope.recipientWrappedCek,
      };
  if (
    localWrap.epoch !== localKey.epoch ||
    !equalBytes(localWrap.fingerprint, localKey.fingerprint)
  ) {
    throw new MailCryptoError("INVALID_KEY_INFO", "Mail local key generation does not match its wrap");
  }

  let cek: Uint8Array;
  try {
    cek = await adapter.unwrapCek({
      target: localKey,
      keyHandle: input.keyHandle,
      wrappedCek: localWrap.wrappedCek,
    });
    cek = validateFixedBytes(cek, MAIL_CEK_BYTES, "Content-encryption key");
  } catch {
    throw new MailCryptoError("KEY_UNWRAP_FAILED", "Mail content key could not be unwrapped");
  }

  try {
    const aesKey = await importAesKey(cek, ["decrypt"]);
    const headerAad = buildMailSectionAad({
      senderPrincipal: input.senderPrincipal,
      recipientPrincipal: input.recipientPrincipal,
      deliveryKeyEpoch: envelope.deliveryKeyEpoch,
      recipientKeyFingerprint: envelope.recipientKeyFingerprint,
      messageId: envelope.messageId,
      section: "header",
    });
    const bodyAad = buildMailSectionAad({
      senderPrincipal: input.senderPrincipal,
      recipientPrincipal: input.recipientPrincipal,
      deliveryKeyEpoch: envelope.deliveryKeyEpoch,
      recipientKeyFingerprint: envelope.recipientKeyFingerprint,
      messageId: envelope.messageId,
      section: "body",
    });
    try {
      const [headerPadded, bodyPadded] = await Promise.all([
        aesDecrypt(
          aesKey,
          envelope.headerNonce,
          headerAad,
          envelope.headerCiphertextAndTag,
        ),
        aesDecrypt(
          aesKey,
          envelope.bodyNonce,
          bodyAad,
          envelope.bodyCiphertextAndTag,
        ),
      ]);
      // No field is exposed before both sections authenticate, unpad, validate,
      // and decode completely.
      const header = decodeMailPrivateHeaderV1(unpadHeaderSection(headerPadded));
      const body = decodeMailPrivateBodyV1(unpadBodySection(bodyPadded));
      return { messageId: envelope.messageId.slice(), header, body };
    } catch {
      throw new MailCryptoError(
        "AUTHENTICATION_FAILED",
        "This message could not be authenticated or decrypted",
      );
    }
  } finally {
    zero(cek);
  }
}

/**
 * Authenticate and decrypt only the fixed-size private header used by Inbox,
 * Sent, and Outbox rows. Body ciphertext never enters this operation. No
 * header field is returned until the CEK wrap, V1 AAD, AES tag, deterministic
 * padding, and canonical CBOR all validate.
 */
export async function decryptPrivateMailHeaderV1<KeyHandle>(
  input: DecryptPrivateMailHeaderV1Input<KeyHandle>,
): Promise<DecryptedPrivateMailHeaderV1> {
  const adapter = requireAdapter(input.adapter);
  const localKey = normalizeKeyInfo(input.localKey);
  const localWrap = normalizeLocalWrap(input.localWrap);
  let header: MailEncryptedHeaderV1;
  try {
    header = normalizeEncryptedHeader(input.encryptedHeader);
    // Parse both principals before unwrapping so malformed AAD identities fail
    // without touching a key handle.
    principalBytes(input.senderPrincipal);
    principalBytes(input.recipientPrincipal);
  } catch {
    throw new MailCryptoError("INVALID_ENVELOPE", "Mail encrypted header is invalid");
  }
  if (
    localWrap.epoch !== localKey.epoch ||
    !equalBytes(localWrap.fingerprint, localKey.fingerprint)
  ) {
    throw new MailCryptoError(
      "INVALID_KEY_INFO",
      "Mail local key generation does not match its wrap",
    );
  }

  let cek: Uint8Array;
  try {
    cek = validateFixedBytes(
      await adapter.unwrapCek({
        target: localKey,
        keyHandle: input.keyHandle,
        wrappedCek: localWrap.wrappedCek,
      }),
      MAIL_CEK_BYTES,
      "Content-encryption key",
    );
  } catch {
    throw new MailCryptoError("KEY_UNWRAP_FAILED", "Mail content key could not be unwrapped");
  }

  try {
    const aesKey = await importAesKey(cek, ["decrypt"]);
    const aad = buildMailSectionAad({
      senderPrincipal: input.senderPrincipal,
      recipientPrincipal: input.recipientPrincipal,
      deliveryKeyEpoch: header.deliveryKeyEpoch,
      recipientKeyFingerprint: header.recipientKeyFingerprint,
      messageId: header.messageId,
      section: "header",
    });
    try {
      const padded = await aesDecrypt(
        aesKey,
        header.headerNonce,
        aad,
        header.headerCiphertextAndTag,
      );
      return {
        messageId: header.messageId.slice(),
        header: decodeMailPrivateHeaderV1(unpadHeaderSection(padded)),
      };
    } catch {
      throw new MailCryptoError(
        "AUTHENTICATION_FAILED",
        "This message could not be authenticated or decrypted",
      );
    }
  } finally {
    zero(cek);
  }
}

/**
 * Rewrap one retained record's CEK during current/previous rotation.
 *
 * The authenticated delivery fields and AES ciphertext are deliberately not
 * arguments, so this operation cannot mutate or re-encrypt message content.
 * Only the storage-local IBE wrap changes.
 */
export async function rewrapMailLocalCek<KeyHandle>(
  input: RewrapMailLocalCekInput<KeyHandle>,
): Promise<MailLocalCekWrap> {
  const adapter = requireAdapter(input.adapter);
  const cryptoApi = requireCrypto();
  const oldKey = normalizeKeyInfo(input.oldKey);
  const newKey = normalizeKeyInfo(input.newKey);
  const oldWrap = normalizeLocalWrap(input.localWrap);
  if (
    oldWrap.epoch !== oldKey.epoch ||
    !equalBytes(oldWrap.fingerprint, oldKey.fingerprint)
  ) {
    throw new MailCryptoError(
      "INVALID_KEY_INFO",
      "Mail local key generation does not match its wrap",
    );
  }
  if (
    oldKey.epoch === newKey.epoch ||
    equalBytes(oldKey.fingerprint, newKey.fingerprint)
  ) {
    throw new MailCryptoError(
      "INVALID_KEY_INFO",
      "Mail rotation requires a distinct new key generation",
    );
  }

  let cek: Uint8Array | null = null;
  const seed = randomBytes(cryptoApi, MAIL_IBE_SEED_BYTES);
  try {
    try {
      cek = validateFixedBytes(
        await adapter.unwrapCek({
          target: oldKey,
          keyHandle: input.oldKeyHandle,
          wrappedCek: oldWrap.wrappedCek,
        }),
        MAIL_CEK_BYTES,
        "Content-encryption key",
      );
    } catch {
      throw new MailCryptoError(
        "KEY_UNWRAP_FAILED",
        "Mail content key could not be unwrapped for rotation",
      );
    }

    try {
      const wrappedCek = validateWrappedCek(
        await adapter.wrapCek({ target: newKey, cek, seed }),
      );
      return {
        epoch: newKey.epoch,
        fingerprint: newKey.fingerprint.slice(),
        wrappedCek,
      };
    } catch {
      throw new MailCryptoError(
        "KEY_WRAP_FAILED",
        "Mail content key could not be wrapped for the new generation",
      );
    }
  } finally {
    if (cek !== null) zero(cek);
    zero(seed);
  }
}

function normalizeKeyInfo(input: MailIbePublicKeyInfo): MailIbePublicKeyInfo {
  if (!input || input.suite !== MAIL_CIPHER_SUITE) {
    throw new MailCryptoError("INVALID_KEY_INFO", "Mail key information is incompatible");
  }
  if (typeof input.epoch !== "bigint" || input.epoch < 1n || input.epoch > (1n << 64n) - 1n) {
    throw new MailCryptoError("INVALID_KEY_INFO", "Mail key epoch is invalid");
  }
  let fingerprint: Uint8Array;
  let expected: Uint8Array;
  try {
    fingerprint = validateFingerprint(input.fingerprint);
    expected = computeMailKeyFingerprint({
      suite: input.suite,
      epoch: input.epoch,
      contextPublicKey: input.contextPublicKey,
      effectiveIbeIdentity: input.effectiveIbeIdentity,
    });
  } catch {
    throw new MailCryptoError("INVALID_KEY_INFO", "Mail key information is invalid");
  }
  if (!equalBytes(fingerprint, expected)) {
    throw new MailCryptoError("INVALID_KEY_INFO", "Mail key fingerprint does not match its public information");
  }
  return {
    suite: MAIL_CIPHER_SUITE,
    epoch: input.epoch,
    fingerprint,
    contextPublicKey: input.contextPublicKey.slice(),
    effectiveIbeIdentity: input.effectiveIbeIdentity.slice(),
  };
}

function normalizeLocalWrap(input: MailLocalCekWrap): MailLocalCekWrap {
  if (!input || typeof input.epoch !== "bigint" || input.epoch < 1n) {
    throw new MailCryptoError("INVALID_KEY_INFO", "Mail local key wrap is invalid");
  }
  try {
    return {
      epoch: input.epoch,
      fingerprint: validateFingerprint(input.fingerprint),
      wrappedCek: validateWrappedCek(input.wrappedCek),
    };
  } catch {
    throw new MailCryptoError("INVALID_KEY_INFO", "Mail local key wrap is invalid");
  }
}

function normalizeEncryptedHeader(input: MailEncryptedHeaderV1): MailEncryptedHeaderV1 {
  if (
    !input ||
    typeof input.deliveryKeyEpoch !== "bigint" ||
    input.deliveryKeyEpoch < 1n ||
    input.deliveryKeyEpoch > (1n << 64n) - 1n
  ) {
    throw new MailCryptoError("INVALID_ENVELOPE", "Mail delivery key epoch is invalid");
  }
  return {
    deliveryKeyEpoch: input.deliveryKeyEpoch,
    recipientKeyFingerprint: validateFingerprint(input.recipientKeyFingerprint),
    messageId: validateNonzeroFixedBytes(
      input.messageId,
      MAIL_LIMITS.messageIdBytes,
      "Message id",
    ),
    headerNonce: validateFixedBytes(
      input.headerNonce,
      MAIL_LIMITS.nonceBytes,
      "Header nonce",
    ),
    headerCiphertextAndTag: validateFixedBytes(
      input.headerCiphertextAndTag,
      MAIL_HEADER_CIPHERTEXT_BYTES,
      "Encrypted Mail header",
    ),
  };
}

function validateWrappedCek(value: Uint8Array): Uint8Array {
  return validateNonzeroFixedBytes(value, MAIL_LIMITS.wrappedCekBytes, "Wrapped content key");
}

function requireAdapter<KeyHandle>(
  adapter: MailIbeAdapter<KeyHandle> | undefined,
): MailIbeAdapter<KeyHandle> {
  if (
    !adapter ||
    typeof adapter.wrapCek !== "function" ||
    typeof adapter.unwrapCek !== "function"
  ) {
    throw new MailCryptoError(
      "IBE_UNAVAILABLE",
      "Private Mail encryption is unavailable without the vetKeys adapter",
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

function randomBytes(cryptoApi: Crypto, length: number): Uint8Array {
  const output = new Uint8Array(length);
  cryptoApi.getRandomValues(output as Uint8Array<ArrayBuffer>);
  return output;
}

function randomDistinctBytes(
  cryptoApi: Crypto,
  length: number,
  prior: readonly Uint8Array[],
): Uint8Array {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = randomBytes(cryptoApi, length);
    if (!prior.some((value) => value.byteLength === length && equalBytes(value, candidate))) {
      return candidate;
    }
    zero(candidate);
  }
  throw new MailCryptoError("CRYPTO_UNAVAILABLE", "CSPRNG repeated a Mail value");
}

async function importAesKey(
  raw: Uint8Array,
  usages: KeyUsage[],
): Promise<MailAesGcmKey> {
  try {
    return await importMailAesGcmKey(raw, usages as ("encrypt" | "decrypt")[]);
  } catch {
    throw new MailCryptoError(
      "CRYPTO_UNAVAILABLE",
      "Secure WebCrypto AES-GCM is unavailable",
    );
  } finally {
    // The imported key is non-extractable. Keep the raw CEK alive only until
    // WebCrypto has either accepted or rejected the import.
    zero(raw);
  }
}

async function aesEncrypt(
  key: MailAesGcmKey,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  return encryptMailAesGcm(key, nonce, aad, plaintext);
}

async function aesDecrypt(
  key: MailAesGcmKey,
  nonce: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  return decryptMailAesGcm(key, nonce, aad, ciphertext);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function zero(value: Uint8Array): void {
  try {
    value.fill(0);
  } catch {
    // Best effort only; JavaScript cannot promise erasure from engine copies.
  }
}
