import {
  decryptPrivateMailHeaderV1,
  decryptPrivateMailV1,
  encryptPrivateMailV1,
  rewrapMailLocalCek,
  type DecryptPrivateMailHeaderV1Input,
  type DecryptPrivateMailV1Input,
  type DecryptedPrivateMailHeaderV1,
  type DecryptedPrivateMailV1,
  type EncryptPrivateMailV1Input,
  type EncryptedPrivateMailV1,
  type MailIbeAdapter,
  type MailIbePublicKeyInfo,
  type MailLocalCekWrap,
} from "./crypto.ts";
import { computeMailKeyFingerprint } from "./protocol.ts";
import {
  MAIL_EFFECTIVE_IBE_IDENTITY_BYTES,
  MAIL_ENCRYPTED_VETKEY_BYTES,
  MAIL_TRANSPORT_PUBLIC_KEY_BYTES,
  type MailVetKeyTransportSession,
  validateOfficialMailKeyInfo,
} from "./vetkeys_adapter.ts";
import { MAIL_LIMITS, validateFixedBytes } from "./model.ts";
import {
  decryptMailSettingsV1,
  encryptMailSettingsV1,
  type MailEncryptedSettingsV1,
} from "./settings_crypto.ts";

export const MAIL_UNLOCK_CHALLENGE_MS = 60_000;
export const MAIL_DEFAULT_INACTIVITY_MS = 15 * 60_000;
export const MAIL_MIN_INACTIVITY_MS = 60_000;
export const MAIL_MAX_INACTIVITY_MS = 60 * 60_000;

export interface MailTransportSession<KeyHandle> {
  publicKeyBytes(): Uint8Array;
  readonly consumed: boolean;
  consume(input: {
    encryptedVetKey: Uint8Array;
    contextPublicKey: Uint8Array;
    effectiveIbeIdentity: Uint8Array;
  }): KeyHandle;
}

export type MailCryptoVaultConfiguration = {
  current: MailIbePublicKeyInfo;
  previous: MailIbePublicKeyInfo | null;
  inactivityMs?: number;
};

export type MailCryptoVaultStatus = {
  configured: boolean;
  currentEpoch: bigint | null;
  previousEpoch: bigint | null;
  unlockedEpochs: bigint[];
  currentUnlocked: boolean;
  pendingEpoch: bigint | null;
  inactivityExpiresAt: number | null;
};

export type MailCryptoVaultRecoveredHandle<KeyHandle> = Readonly<{
  key: MailIbePublicKeyInfo;
  handle: KeyHandle;
}>;

type PendingUnlock<KeyHandle> = {
  epoch: bigint;
  session: MailTransportSession<KeyHandle>;
  expiresAt: number;
};

/**
 * Volatile key owner used only inside Mail's resident crypto worker.
 *
 * Its recovery and restore hooks are worker-only and never reach postMessage.
 * Public worker responses can contain only transport public bytes, bounded
 * ciphertext, or explicitly requested plaintext projections.
 */
export class MailCryptoVault<KeyHandle> {
  readonly #adapter: MailIbeAdapter<KeyHandle>;
  readonly #sessionFactory: () => MailTransportSession<KeyHandle>;
  readonly #now: () => number;
  readonly #randomBytes: (length: number) => Uint8Array;
  readonly #schedule: (callback: () => void, delayMs: number) => unknown;
  readonly #cancel: (handle: unknown) => void;
  readonly #onInactivityLock: () => void;
  readonly #onHandleRecovered: (
    recovered: MailCryptoVaultRecoveredHandle<KeyHandle>,
  ) => Promise<void>;
  #current: MailIbePublicKeyInfo | null = null;
  #previous: MailIbePublicKeyInfo | null = null;
  #handles = new Map<bigint, KeyHandle>();
  #pending: PendingUnlock<KeyHandle> | null = null;
  #inactivityMs = MAIL_DEFAULT_INACTIVITY_MS;
  #inactivityExpiresAt: number | null = null;
  #deadlineHandle: unknown = null;

  constructor(input: {
    adapter: MailIbeAdapter<KeyHandle>;
    sessionFactory: () => MailTransportSession<KeyHandle>;
    now?: () => number;
    randomBytes?: (length: number) => Uint8Array;
    schedule?: (callback: () => void, delayMs: number) => unknown;
    cancel?: (handle: unknown) => void;
    onInactivityLock?: () => void;
    onHandleRecovered?: (
      recovered: MailCryptoVaultRecoveredHandle<KeyHandle>,
    ) => Promise<void>;
  }) {
    this.#adapter = input.adapter;
    this.#sessionFactory = input.sessionFactory;
    this.#now = input.now ?? Date.now;
    this.#randomBytes = input.randomBytes ?? secureRandomBytes;
    this.#schedule = input.schedule ?? scheduleUnrefTimeout;
    this.#cancel = input.cancel ?? ((handle) => clearTimeout(
      handle as ReturnType<typeof setTimeout>,
    ));
    this.#onInactivityLock = input.onInactivityLock ?? (() => undefined);
    this.#onHandleRecovered = input.onHandleRecovered ??
      (() => Promise.resolve());
  }

  configure(input: MailCryptoVaultConfiguration): MailCryptoVaultStatus {
    const current = normalizeKeyInfo(input.current);
    const previous = input.previous === null ? null : normalizeKeyInfo(input.previous);
    if (previous && previous.epoch === current.epoch) {
      throw new Error("Current and previous Mail generations must be distinct");
    }
    const inactivityMs = input.inactivityMs ?? this.#inactivityMs;
    if (
      !Number.isSafeInteger(inactivityMs) ||
      inactivityMs < MAIL_MIN_INACTIVITY_MS ||
      inactivityMs > MAIL_MAX_INACTIVITY_MS
    ) {
      throw new Error("Mail inactivity timeout is outside its bound");
    }

    const next = new Map<bigint, MailIbePublicKeyInfo>([[current.epoch, current]]);
    if (previous) next.set(previous.epoch, previous);
    for (const [epoch] of this.#handles) {
      const previous = this.#keyForEpoch(epoch);
      const replacement = next.get(epoch);
      if (!previous || !replacement || !sameKeyInfo(previous, replacement)) {
        this.#handles.delete(epoch);
      }
    }
    if (this.#pending && !next.has(this.#pending.epoch)) this.#pending = null;
    this.#current = current;
    this.#previous = previous;
    this.#inactivityMs = inactivityMs;
    if (this.#handles.size === 0) this.#inactivityExpiresAt = null;
    this.#scheduleDeadline();
    return this.status();
  }

  beginUnlock(epoch: bigint): {
    epoch: bigint;
    transportPublicKey: Uint8Array;
    requestNonce: Uint8Array;
    expiresAt: number;
  } {
    this.#expire();
    if (this.#pending !== null) throw new Error("A Mail unlock request is already pending");
    const key = this.#requireConfiguredKey(epoch);
    // Touch parsing here so malformed public information never creates a
    // transport challenge.
    validateOfficialMailKeyInfo(key);
    const session = this.#sessionFactory();
    const transportPublicKey = validateFixedBytes(
      session.publicKeyBytes(),
      MAIL_TRANSPORT_PUBLIC_KEY_BYTES,
      "Transport public key",
    );
    const requestNonce = validateFixedBytes(
      this.#randomBytes(MAIL_EFFECTIVE_IBE_IDENTITY_BYTES),
      MAIL_EFFECTIVE_IBE_IDENTITY_BYTES,
      "Unlock request nonce",
    );
    const expiresAt = this.#now() + MAIL_UNLOCK_CHALLENGE_MS;
    this.#pending = { epoch, session, expiresAt };
    this.#scheduleDeadline();
    return { epoch, transportPublicKey, requestNonce, expiresAt };
  }

  async completeUnlock(
    epoch: bigint,
    encryptedVetKey: Uint8Array,
  ): Promise<MailCryptoVaultStatus> {
    const pending = this.#pending;
    this.#pending = null;
    if (!pending || pending.epoch !== epoch) throw new Error("Mail unlock challenge is missing");
    if (pending.expiresAt <= this.#now()) throw new Error("Mail unlock challenge expired");
    const key = this.#requireConfiguredKey(epoch);
    const handle = pending.session.consume({
      encryptedVetKey: validateFixedBytes(
        encryptedVetKey,
        MAIL_ENCRYPTED_VETKEY_BYTES,
        "Encrypted VetKey",
      ),
      contextPublicKey: key.contextPublicKey,
      effectiveIbeIdentity: key.effectiveIbeIdentity,
    });
    this.#handles.set(epoch, handle);
    this.#touch();
    try {
      await this.#onHandleRecovered({ key, handle });
    } catch {
      // Durable recovery is optional; the verified volatile handle is already
      // installed and must not be reported as a failed paid derivation.
    }
    return this.status();
  }

  /**
   * Restore a handle only when its complete public information is exactly the
   * generation currently configured in this vault.
   */
  restoreHandle(
    rawKey: MailIbePublicKeyInfo,
    handle: KeyHandle,
  ): MailCryptoVaultStatus {
    this.#expire();
    const key = normalizeKeyInfo(rawKey);
    const configured = this.#requireConfiguredKey(key.epoch);
    if (!sameKeyInfo(configured, key)) {
      throw new Error("Mail restored key information does not match");
    }
    this.#handles.set(key.epoch, handle);
    this.#touch();
    return this.status();
  }

  cancelPendingUnlock(): void {
    this.#pending = null;
    this.#scheduleDeadline();
  }

  reset(): MailCryptoVaultStatus {
    this.#handles.clear();
    this.#pending = null;
    this.#current = null;
    this.#previous = null;
    this.#inactivityExpiresAt = null;
    this.#cancelDeadline();
    return this.status();
  }

  lock(): MailCryptoVaultStatus {
    this.#handles.clear();
    this.#pending = null;
    this.#inactivityExpiresAt = null;
    this.#cancelDeadline();
    return this.status();
  }

  status(): MailCryptoVaultStatus {
    this.#expire();
    const currentEpoch = this.#current?.epoch ?? null;
    return {
      configured: this.#current !== null,
      currentEpoch,
      previousEpoch: this.#previous?.epoch ?? null,
      unlockedEpochs: [...this.#handles.keys()].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0
      ),
      currentUnlocked: currentEpoch !== null && this.#handles.has(currentEpoch),
      pendingEpoch: this.#pending?.epoch ?? null,
      inactivityExpiresAt: this.#inactivityExpiresAt,
    };
  }

  async encrypt(
    input: Omit<EncryptPrivateMailV1Input, "senderKey" | "adapter">,
  ): Promise<EncryptedPrivateMailV1> {
    this.#expire();
    const current = this.#requireCurrentUnlocked();
    const result = await encryptPrivateMailV1({
      ...input,
      senderKey: current,
      adapter: this.#adapter,
    });
    this.#touch();
    return result;
  }

  async decrypt(
    input: Omit<DecryptPrivateMailV1Input<KeyHandle>, "localKey" | "keyHandle" | "adapter">,
  ): Promise<DecryptedPrivateMailV1> {
    this.#expire();
    if (!input.localWrap) throw new Error("Mail worker requires an exact local CEK wrap");
    const epoch = input.localWrap.epoch;
    const key = this.#requireConfiguredKey(epoch);
    const handle = this.#handles.get(epoch);
    if (!handle) throw new Error("The required Mail generation is locked");
    const result = await decryptPrivateMailV1({
      ...input,
      localKey: key,
      keyHandle: handle,
      adapter: this.#adapter,
    });
    this.#touch();
    return result;
  }

  async decryptHeader(
    input: Omit<
      DecryptPrivateMailHeaderV1Input<KeyHandle>,
      "localKey" | "keyHandle" | "adapter"
    >,
  ): Promise<DecryptedPrivateMailHeaderV1> {
    this.#expire();
    const epoch = input.localWrap.epoch;
    const key = this.#requireConfiguredKey(epoch);
    const handle = this.#handles.get(epoch);
    if (!handle) throw new Error("The required Mail generation is locked");
    const result = await decryptPrivateMailHeaderV1({
      ...input,
      localKey: key,
      keyHandle: handle,
      adapter: this.#adapter,
    });
    this.#touch();
    return result;
  }

  async rewrap(localWrap: MailLocalCekWrap): Promise<MailLocalCekWrap> {
    this.#expire();
    const current = this.#requireCurrentUnlocked();
    const oldKey = this.#requireConfiguredKey(localWrap.epoch);
    const oldKeyHandle = this.#handles.get(oldKey.epoch);
    if (!oldKeyHandle) throw new Error("The previous Mail generation is locked");
    const result = await rewrapMailLocalCek({
      oldKey,
      newKey: current,
      oldKeyHandle,
      localWrap,
      adapter: this.#adapter,
    });
    this.#touch();
    return result;
  }

  async encryptSettings(input: {
    selfPrincipal: string;
    senderName: string;
    recordId: Uint8Array;
    revision: bigint;
  }): Promise<MailEncryptedSettingsV1> {
    this.#expire();
    const current = this.#requireCurrentUnlocked();
    const result = await encryptMailSettingsV1({
      ...input,
      localKey: current,
      adapter: this.#adapter,
    });
    this.#touch();
    return result;
  }

  async decryptSettings(input: {
    selfPrincipal: string;
    encrypted: MailEncryptedSettingsV1;
  }): Promise<{ senderName: string }> {
    this.#expire();
    const epoch = input.encrypted.localWrap.epoch;
    const key = this.#requireConfiguredKey(epoch);
    const handle = this.#handles.get(epoch);
    if (!handle) throw new Error("The required Mail settings generation is locked");
    const result = await decryptMailSettingsV1({
      ...input,
      localKey: key,
      keyHandle: handle,
      adapter: this.#adapter,
    });
    this.#touch();
    return result;
  }

  #requireCurrentUnlocked(): MailIbePublicKeyInfo {
    const current = this.#current;
    if (!current || !this.#handles.has(current.epoch)) {
      throw new Error("Private Mail is locked");
    }
    return current;
  }

  #requireConfiguredKey(epoch: bigint): MailIbePublicKeyInfo {
    const key = this.#keyForEpoch(epoch);
    if (!key) throw new Error("Mail key generation is unavailable");
    return key;
  }

  #keyForEpoch(epoch: bigint): MailIbePublicKeyInfo | null {
    if (this.#current?.epoch === epoch) return this.#current;
    if (this.#previous?.epoch === epoch) return this.#previous;
    return null;
  }

  #touch(): void {
    if (this.#handles.size > 0) {
      this.#inactivityExpiresAt = this.#now() + this.#inactivityMs;
    }
    this.#scheduleDeadline();
  }

  #expire(): void {
    const now = this.#now();
    if (this.#pending && this.#pending.expiresAt <= now) this.#pending = null;
    if (this.#inactivityExpiresAt !== null && this.#inactivityExpiresAt <= now) {
      const hadHandles = this.#handles.size > 0;
      this.#handles.clear();
      this.#pending = null;
      this.#inactivityExpiresAt = null;
      if (hadHandles) {
        try {
          this.#onInactivityLock();
        } catch {
          // Key erasure is authoritative even if a cache-cleanup hint fails.
        }
      }
    }
    this.#scheduleDeadline();
  }

  #scheduleDeadline(): void {
    this.#cancelDeadline();
    const deadlines = [
      this.#pending?.expiresAt ?? null,
      this.#inactivityExpiresAt,
    ].filter((value): value is number => value !== null);
    if (deadlines.length === 0) return;
    const deadline = Math.min(...deadlines);
    const delay = Math.max(0, deadline - this.#now());
    this.#deadlineHandle = this.#schedule(() => {
      this.#deadlineHandle = null;
      this.#expire();
    }, delay);
  }

  #cancelDeadline(): void {
    if (this.#deadlineHandle === null) return;
    this.#cancel(this.#deadlineHandle);
    this.#deadlineHandle = null;
  }
}

function normalizeKeyInfo(input: MailIbePublicKeyInfo): MailIbePublicKeyInfo {
  const key = validateOfficialMailKeyInfo(input);
  const fingerprint = computeMailKeyFingerprint({
    suite: key.suite,
    epoch: key.epoch,
    contextPublicKey: key.contextPublicKey,
    effectiveIbeIdentity: key.effectiveIbeIdentity,
  });
  if (!sameBytes(fingerprint, key.fingerprint)) {
    throw new Error("Mail key fingerprint does not match its public information");
  }
  return { ...key, fingerprint };
}

function sameKeyInfo(left: MailIbePublicKeyInfo, right: MailIbePublicKeyInfo): boolean {
  return (
    left.suite === right.suite &&
    left.epoch === right.epoch &&
    sameBytes(left.fingerprint, right.fingerprint) &&
    sameBytes(left.contextPublicKey, right.contextPublicKey) &&
    sameBytes(left.effectiveIbeIdentity, right.effectiveIbeIdentity)
  );
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

function secureRandomBytes(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 1 || !globalThis.crypto?.getRandomValues) {
    throw new Error("Secure randomness is unavailable");
  }
  const output = new Uint8Array(length);
  globalThis.crypto.getRandomValues(output);
  return output;
}

function scheduleUnrefTimeout(callback: () => void, delayMs: number): unknown {
  const handle = setTimeout(callback, delayMs);
  if (typeof handle === "object" && handle !== null && "unref" in handle) {
    (handle as { unref?: () => void }).unref?.();
  }
  return handle;
}

// Compile-time assertion that the concrete official session implements the
// worker-only interface without exporting its secret type.
const _officialSessionShape: MailTransportSession<unknown> | null =
  null as MailVetKeyTransportSession | null;
void _officialSessionShape;
