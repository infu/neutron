import { Principal } from "@dfinity/principal";
import {
  DerivedPublicKey,
  VetKey,
  verifyBlsSignature,
} from "@dfinity/vetkeys";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  BROWSER_SECRET_CACHE_MAX_TTL_MS,
  createBrowserSecretCache,
  type BrowserSecretCache,
  type BrowserSecretCacheKey,
} from "neutron-tools/browser_secret_cache";
import { validateFixedBytes, validateUnsignedDecimal } from "./model.ts";
import { computeMailKeyFingerprint, principalBytes } from "./protocol.ts";
import {
  MAIL_CONTEXT_PUBLIC_KEY_BYTES,
  MAIL_EFFECTIVE_IBE_IDENTITY_BYTES,
} from "./vetkeys_adapter.ts";
import type {
  MailWorkerCachePublicInfo,
  MailWorkerCacheScope,
  MailWorkerKeyInfo,
  MailWorkerLiveGeneration,
} from "./crypto_worker.ts";

export const MAIL_VETKEY_CACHE_TTL_MS = BROWSER_SECRET_CACHE_MAX_TTL_MS;

const CACHE_ID_PREFIX = "mail.vetkey.mailbox.";
const CACHE_BINDING_DOMAIN = new TextEncoder().encode(
  "neutron.mail.vetkey-cache.binding.v1",
);
const CACHE_PAYLOAD_VERSION = 1;
const MAIL_VETKEY_BYTES = 48;
const PUBLIC_FINGERPRINT_BYTES = 32;
const BROWSER_ORIGIN_NONCE_BYTES = 16;

type CachedVetKey = Readonly<{
  publicInfo: MailWorkerCachePublicInfo;
  handle: VetKey;
}>;

export class MailVetKeyCache {
  readonly #cache: BrowserSecretCache;
  readonly #now: () => number;

  constructor(
    cache: BrowserSecretCache = createBrowserSecretCache(),
    now: () => number = Date.now,
  ) {
    this.#cache = cache;
    this.#now = now;
  }

  async load(
    scope: MailWorkerCacheScope,
    live: MailWorkerLiveGeneration,
  ): Promise<CachedVetKey | null> {
    const key = cacheKey(scope, live);
    if (key === null) return null;
    const secret = await this.#cache.get(key);
    if (secret === null) return null;
    try {
      return decodeCachedVetKey(secret, scope, live);
    } catch {
      return null;
    } finally {
      secret.fill(0);
    }
  }

  async save(
    scope: MailWorkerCacheScope,
    publicInfo: MailWorkerCachePublicInfo,
    handle: VetKey,
  ): Promise<void> {
    const normalized = validateCachePublicInfo(publicInfo, scope);
    const live = liveGenerationFromPublicInfo(normalized);
    const key = cacheKey(scope, live);
    if (key === null) return;
    const secret = encodeCachedVetKey(normalized, handle);
    try {
      const now = this.#now();
      if (!Number.isSafeInteger(now) || now < 0) return;
      await this.#cache.put({
        ...key,
        secret,
        expiresAtMs: now + MAIL_VETKEY_CACHE_TTL_MS,
      });
    } finally {
      secret.fill(0);
    }
  }

  async prune(
    scope: MailWorkerCacheScope,
    live: readonly MailWorkerLiveGeneration[],
  ): Promise<void> {
    // An unknown fingerprint cannot produce the exact authenticated binding
    // needed by the origin-global helper allowlist. Preserve records until
    // public information fills that gap; known generations may still load
    // independently in the meantime.
    if (live.some((generation) => generation.publicFingerprint === null)) {
      return;
    }
    const keep = live
      .map((generation) => cacheKey(scope, generation))
      .filter((value): value is BrowserSecretCacheKey => value !== null);
    await this.#cache.prune(keep);
  }

  async clear(): Promise<void> {
    await this.#cache.prune([]);
  }

  close(): void {
    this.#cache.close();
  }
}

export function liveGenerationFromPublicInfo(
  input: MailWorkerCachePublicInfo,
): MailWorkerLiveGeneration {
  return {
    epoch: input.epoch,
    keyName: input.keyName,
    publicFingerprint: input.publicFingerprint.slice(),
  };
}

export function validateCachePublicInfo(
  input: MailWorkerCachePublicInfo,
  expectedScope?: MailWorkerCacheScope,
): MailWorkerCachePublicInfo {
  if (!input || input.slot !== "mailbox" || input.suite !== 1) {
    throw new Error("Mail cached public information is incompatible");
  }
  const epoch = validateUnsignedDecimal(input.epoch, "Mail cached key epoch");
  if (epoch === "0") throw new Error("Mail cached key epoch is invalid");
  if (input.keyName !== "key_1" && input.keyName !== "test_key_1") {
    throw new Error("Mail cached key name is invalid");
  }
  const canisterPrincipal = canonicalCanisterPrincipal(input.canisterPrincipal);
  if (
    expectedScope !== undefined &&
    canisterPrincipal !== validateCacheScope(expectedScope).canisterPrincipal
  ) {
    throw new Error("Mail cached canister binding changed");
  }
  const contextPublicKey = validateFixedBytes(
    input.contextPublicKey,
    MAIL_CONTEXT_PUBLIC_KEY_BYTES,
    "Mail cached context public key",
  );
  const effectiveIbeIdentity = validateFixedBytes(
    input.effectiveIbeIdentity,
    MAIL_EFFECTIVE_IBE_IDENTITY_BYTES,
    "Mail cached IBE identity",
  );
  const publicFingerprint = validateFixedBytes(
    input.publicFingerprint,
    PUBLIC_FINGERPRINT_BYTES,
    "Mail cached public fingerprint",
  );
  if (!sameBytes(publicFingerprint, sha256(contextPublicKey))) {
    throw new Error("Mail cached public fingerprint is invalid");
  }
  DerivedPublicKey.deserialize(contextPublicKey);
  const fingerprint = computeMailKeyFingerprint({
    suite: 1,
    epoch: BigInt(epoch),
    contextPublicKey,
    effectiveIbeIdentity,
  });
  if (!sameBytes(fingerprint, input.fingerprint)) {
    throw new Error("Mail cached key fingerprint changed");
  }
  return {
    canisterPrincipal,
    slot: "mailbox",
    suite: 1,
    keyName: input.keyName,
    epoch,
    publicFingerprint,
    fingerprint,
    contextPublicKey,
    effectiveIbeIdentity,
  };
}

export function validateCacheScope(
  input: MailWorkerCacheScope,
): MailWorkerCacheScope {
  if (!input || input.app !== "mail") {
    throw new Error("Mail cache scope is invalid");
  }
  const installationUid = positiveNat64(input.installationUid, "installation uid");
  const browserOriginAuthorityEpoch = positiveNat64(
    input.browserOriginAuthorityEpoch,
    "browser-origin authority epoch",
  );
  if (!/^[a-f0-9]{32}$/u.test(input.browserOriginNonce)) {
    throw new Error("Mail browser-origin nonce is invalid");
  }
  return {
    app: "mail",
    canisterPrincipal: canonicalCanisterPrincipal(input.canisterPrincipal),
    installationUid,
    browserOriginNonce: input.browserOriginNonce,
    browserOriginAuthorityEpoch,
  };
}

function cacheKey(
  rawScope: MailWorkerCacheScope,
  rawLive: MailWorkerLiveGeneration,
): BrowserSecretCacheKey | null {
  let scope: MailWorkerCacheScope;
  let live: MailWorkerLiveGeneration;
  try {
    scope = validateCacheScope(rawScope);
    live = validateLiveGeneration(rawLive);
  } catch {
    return null;
  }
  if (live.publicFingerprint === null) return null;
  const principal = principalBytes(scope.canisterPrincipal);
  const nonce = hexBytes(scope.browserOriginNonce);
  const output = new Uint8Array(
    4 + CACHE_BINDING_DOMAIN.byteLength +
      1 + principal.byteLength +
      8 +
      BROWSER_ORIGIN_NONCE_BYTES +
      8 +
      8 +
      1 +
      PUBLIC_FINGERPRINT_BYTES,
  );
  const view = new DataView(output.buffer);
  let offset = 0;
  view.setUint32(offset, CACHE_BINDING_DOMAIN.byteLength, false);
  offset += 4;
  output.set(CACHE_BINDING_DOMAIN, offset);
  offset += CACHE_BINDING_DOMAIN.byteLength;
  output[offset++] = principal.byteLength;
  output.set(principal, offset);
  offset += principal.byteLength;
  view.setBigUint64(offset, BigInt(scope.installationUid), false);
  offset += 8;
  output.set(nonce, offset);
  offset += BROWSER_ORIGIN_NONCE_BYTES;
  view.setBigUint64(offset, BigInt(scope.browserOriginAuthorityEpoch), false);
  offset += 8;
  view.setBigUint64(offset, BigInt(live.epoch), false);
  offset += 8;
  output[offset++] = keyNameCode(live.keyName);
  output.set(live.publicFingerprint, offset);
  return {
    id: `${CACHE_ID_PREFIX}${live.epoch}`,
    binding: output,
  };
}

function encodeCachedVetKey(
  publicInfo: MailWorkerCachePublicInfo,
  handle: VetKey,
): Uint8Array {
  const principal = principalBytes(publicInfo.canisterPrincipal);
  const serialized = handle.serialize().slice();
  try {
    if (serialized.byteLength !== MAIL_VETKEY_BYTES) {
      throw new Error("Mail VetKey serialization is invalid");
    }
    const derivedPublicKey = DerivedPublicKey.deserialize(publicInfo.contextPublicKey);
    if (
      !verifyBlsSignature(
        derivedPublicKey,
        publicInfo.effectiveIbeIdentity,
        serialized,
      )
    ) {
      throw new Error("Mail VetKey signature is invalid");
    }
    const output = new Uint8Array(
      1 +
        1 +
        8 +
        1 + principal.byteLength +
        PUBLIC_FINGERPRINT_BYTES +
        MAIL_CONTEXT_PUBLIC_KEY_BYTES +
        MAIL_EFFECTIVE_IBE_IDENTITY_BYTES +
        MAIL_VETKEY_BYTES,
    );
    const view = new DataView(output.buffer);
    let offset = 0;
    output[offset++] = CACHE_PAYLOAD_VERSION;
    output[offset++] = keyNameCode(publicInfo.keyName);
    view.setBigUint64(offset, BigInt(publicInfo.epoch), false);
    offset += 8;
    output[offset++] = principal.byteLength;
    output.set(principal, offset);
    offset += principal.byteLength;
    output.set(publicInfo.publicFingerprint, offset);
    offset += PUBLIC_FINGERPRINT_BYTES;
    output.set(publicInfo.contextPublicKey, offset);
    offset += MAIL_CONTEXT_PUBLIC_KEY_BYTES;
    output.set(publicInfo.effectiveIbeIdentity, offset);
    offset += MAIL_EFFECTIVE_IBE_IDENTITY_BYTES;
    output.set(serialized, offset);
    return output;
  } finally {
    // `VetKey.serialize()` returns the library's live backing bytes in 0.4.0,
    // so only its defensive copy may be erased.
    serialized.fill(0);
  }
}

function decodeCachedVetKey(
  payload: Uint8Array,
  scope: MailWorkerCacheScope,
  live: MailWorkerLiveGeneration,
): CachedVetKey {
  const minimum =
    1 + 1 + 8 + 1 + 1 +
    PUBLIC_FINGERPRINT_BYTES +
    MAIL_CONTEXT_PUBLIC_KEY_BYTES +
    MAIL_EFFECTIVE_IBE_IDENTITY_BYTES +
    MAIL_VETKEY_BYTES;
  if (payload.byteLength < minimum) {
    throw new Error("Mail VetKey cache payload is truncated");
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let offset = 0;
  if (payload[offset++] !== CACHE_PAYLOAD_VERSION) {
    throw new Error("Mail VetKey cache payload version is invalid");
  }
  const keyName = keyNameFromCode(payload[offset++]!);
  const epoch = view.getBigUint64(offset, false).toString();
  offset += 8;
  const principalLength = payload[offset++]!;
  const expectedLength =
    minimum - 1 + principalLength;
  if (
    principalLength < 1 ||
    principalLength > 29 ||
    payload.byteLength !== expectedLength
  ) {
    throw new Error("Mail VetKey cache principal is invalid");
  }
  const canisterPrincipal = Principal.fromUint8Array(
    payload.slice(offset, offset + principalLength),
  ).toText();
  offset += principalLength;
  const publicFingerprint = payload.slice(
    offset,
    offset + PUBLIC_FINGERPRINT_BYTES,
  );
  offset += PUBLIC_FINGERPRINT_BYTES;
  const contextPublicKey = payload.slice(
    offset,
    offset + MAIL_CONTEXT_PUBLIC_KEY_BYTES,
  );
  offset += MAIL_CONTEXT_PUBLIC_KEY_BYTES;
  const effectiveIbeIdentity = payload.slice(
    offset,
    offset + MAIL_EFFECTIVE_IBE_IDENTITY_BYTES,
  );
  offset += MAIL_EFFECTIVE_IBE_IDENTITY_BYTES;
  const serialized = payload.subarray(offset, offset + MAIL_VETKEY_BYTES);
  const publicInfo = validateCachePublicInfo({
    canisterPrincipal,
    slot: "mailbox",
    suite: 1,
    keyName,
    epoch,
    publicFingerprint,
    contextPublicKey,
    effectiveIbeIdentity,
    fingerprint: computeMailKeyFingerprint({
      suite: 1,
      epoch: BigInt(epoch),
      contextPublicKey,
      effectiveIbeIdentity,
    }),
  }, scope);
  const normalizedLive = validateLiveGeneration(live);
  if (
    normalizedLive.publicFingerprint === null ||
    normalizedLive.epoch !== publicInfo.epoch ||
    normalizedLive.keyName !== publicInfo.keyName ||
    !sameBytes(normalizedLive.publicFingerprint, publicInfo.publicFingerprint)
  ) {
    throw new Error("Mail VetKey cache lifecycle binding changed");
  }
  const derivedPublicKey = DerivedPublicKey.deserialize(publicInfo.contextPublicKey);
  if (
    !verifyBlsSignature(
      derivedPublicKey,
      publicInfo.effectiveIbeIdentity,
      serialized,
    )
  ) {
    throw new Error("Mail cached VetKey signature is invalid");
  }
  return {
    publicInfo,
    handle: VetKey.deserialize(serialized),
  };
}

function validateLiveGeneration(
  input: MailWorkerLiveGeneration,
): MailWorkerLiveGeneration {
  if (!input || (input.keyName !== "key_1" && input.keyName !== "test_key_1")) {
    throw new Error("Mail live key generation is invalid");
  }
  const epoch = validateUnsignedDecimal(input.epoch, "Mail live key epoch");
  if (epoch === "0") throw new Error("Mail live key epoch is invalid");
  return {
    epoch,
    keyName: input.keyName,
    publicFingerprint: input.publicFingerprint === null
      ? null
      : validateFixedBytes(
          input.publicFingerprint,
          PUBLIC_FINGERPRINT_BYTES,
          "Mail live public fingerprint",
        ),
  };
}

function keyNameCode(value: "key_1" | "test_key_1"): number {
  return value === "key_1" ? 1 : 2;
}

function keyNameFromCode(value: number): "key_1" | "test_key_1" {
  if (value === 1) return "key_1";
  if (value === 2) return "test_key_1";
  throw new Error("Mail cached key name is invalid");
}

function positiveNat64(value: unknown, label: string): string {
  const normalized = validateUnsignedDecimal(value, `Mail ${label}`);
  if (normalized === "0") throw new Error(`Mail ${label} is invalid`);
  return normalized;
}

function canonicalCanisterPrincipal(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Mail cached canister principal is invalid");
  }
  const parsed = Principal.fromText(value);
  const bytes = parsed.toUint8Array();
  if (
    parsed.toText() !== value ||
    bytes.byteLength < 1 ||
    bytes.byteLength > 29 ||
    bytes[bytes.byteLength - 1] !== 1
  ) {
    throw new Error("Mail cached canister principal is invalid");
  }
  return value;
}

function hexBytes(value: string): Uint8Array {
  const output = new Uint8Array(value.length / 2);
  for (let index = 0; index < output.byteLength; index += 1) {
    output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

export function cachePublicInfoToKeyInfo(
  value: MailWorkerCachePublicInfo,
): MailWorkerKeyInfo {
  return {
    suite: 1,
    epoch: value.epoch,
    fingerprint: value.fingerprint.slice(),
    contextPublicKey: value.contextPublicKey.slice(),
    effectiveIbeIdentity: value.effectiveIbeIdentity.slice(),
  };
}
