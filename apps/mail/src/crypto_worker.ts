import type {
  MailPrivateBody,
  MailPrivateHeader,
} from "./model.ts";
import {
  MAIL_LIMITS,
  validateFingerprint,
  validateFixedBytes,
  validateUnsignedDecimal,
} from "./model.ts";
import type { MailIbePublicKeyInfo, MailLocalCekWrap } from "./crypto.ts";
import { MAIL_HEADER_CIPHERTEXT_BYTES } from "./protocol.ts";
import {
  MailCryptoVault,
  type MailCryptoVaultConfiguration,
  type MailCryptoVaultStatus,
  type MailTransportSession,
} from "./crypto_vault.ts";
import {
  MailVetKeyTransportSession,
  OfficialMailIbeAdapter,
  type MailVetKeyHandle,
} from "./vetkeys_adapter.ts";
import {
  MailVetKeyCache,
  cachePublicInfoToKeyInfo,
  liveGenerationFromPublicInfo,
  validateCachePublicInfo,
  validateCacheScope,
} from "./vetkey_cache.ts";

export type MailWorkerKeyInfo = {
  suite: 1;
  epoch: string;
  fingerprint: Uint8Array;
  contextPublicKey: Uint8Array;
  effectiveIbeIdentity: Uint8Array;
};

export type MailWorkerCacheScope = {
  app: "mail";
  canisterPrincipal: string;
  installationUid: string;
  browserOriginNonce: string;
  browserOriginAuthorityEpoch: string;
};

export type MailWorkerLiveGeneration = {
  epoch: string;
  keyName: "key_1" | "test_key_1";
  publicFingerprint: Uint8Array | null;
};

export type MailWorkerCachePublicInfo = {
  canisterPrincipal: string;
  slot: "mailbox";
  suite: 1;
  keyName: "key_1" | "test_key_1";
  epoch: string;
  publicFingerprint: Uint8Array;
  fingerprint: Uint8Array;
  contextPublicKey: Uint8Array;
  effectiveIbeIdentity: Uint8Array;
};

export type MailWorkerLocalWrap = {
  epoch: string;
  fingerprint: Uint8Array;
  wrappedCek: Uint8Array;
};

export type MailWorkerEncryptedHeader = {
  deliveryKeyEpoch: string;
  recipientKeyFingerprint: Uint8Array;
  messageId: Uint8Array;
  headerNonce: Uint8Array;
  headerCiphertextAndTag: Uint8Array;
};

export type MailWorkerEncryptedSettings = {
  recordId: Uint8Array;
  revision: string;
  localWrap: MailWorkerLocalWrap;
  nonce: Uint8Array;
  ciphertextAndTag: Uint8Array;
};

export type MailWorkerStatus = {
  configured: boolean;
  currentEpoch: string | null;
  previousEpoch: string | null;
  unlockedEpochs: string[];
  currentUnlocked: boolean;
  pendingEpoch: string | null;
  inactivityExpiresAt: number | null;
};

export type MailCryptoWorkerRequest =
  | {
      id: number;
      type: "prepare_cache";
      scope: MailWorkerCacheScope | null;
      current: MailWorkerLiveGeneration;
      previous: MailWorkerLiveGeneration | null;
    }
  | {
      id: number;
      type: "configure";
      scope: MailWorkerCacheScope | null;
      current: MailWorkerCachePublicInfo;
      previous: MailWorkerCachePublicInfo | null;
      inactivityMs?: number;
    }
  | { id: number; type: "begin_unlock"; epoch: string }
  | {
      id: number;
      type: "complete_unlock";
      epoch: string;
      encryptedVetKey: Uint8Array;
    }
  | { id: number; type: "cancel_unlock" }
  | { id: number; type: "reset" }
  | { id: number; type: "lock" }
  | { id: number; type: "clear_cache" }
  | { id: number; type: "status" }
  | {
      id: number;
      type: "encrypt";
      senderPrincipal: string;
      recipientPrincipal: string;
      recipientKey: MailWorkerKeyInfo;
      header: MailPrivateHeader;
      body: MailPrivateBody;
    }
  | {
      id: number;
      type: "decrypt_header";
      senderPrincipal: string;
      recipientPrincipal: string;
      encryptedHeader: MailWorkerEncryptedHeader;
      localWrap: MailWorkerLocalWrap;
    }
  | {
      id: number;
      type: "decrypt";
      senderPrincipal: string;
      recipientPrincipal: string;
      envelope: Uint8Array;
      localWrap: MailWorkerLocalWrap;
    }
  | {
      id: number;
      type: "settings_encrypt";
      selfPrincipal: string;
      senderName: string;
      recordId: Uint8Array;
      revision: string;
    }
  | {
      id: number;
      type: "settings_decrypt";
      selfPrincipal: string;
      encrypted: MailWorkerEncryptedSettings;
    }
  | { id: number; type: "rewrap"; localWrap: MailWorkerLocalWrap };

export type MailCryptoWorkerResult =
  | { type: "status"; status: MailWorkerStatus }
  | {
      type: "cache_prepared";
      current: MailWorkerCachePublicInfo | null;
      previous: MailWorkerCachePublicInfo | null;
      status: MailWorkerStatus;
    }
  | {
      type: "unlock_request";
      epoch: string;
      transportPublicKey: Uint8Array;
      requestNonce: Uint8Array;
      expiresAt: number;
    }
  | {
      type: "encrypted";
      messageId: Uint8Array;
      envelope: Uint8Array;
      senderLocalWrap: MailWorkerLocalWrap;
    }
  | {
      type: "header_decrypted";
      messageId: Uint8Array;
      header: MailPrivateHeader;
    }
  | {
      type: "decrypted";
      messageId: Uint8Array;
      header: MailPrivateHeader;
      body: MailPrivateBody;
    }
  | { type: "settings_encrypted"; encrypted: MailWorkerEncryptedSettings }
  | { type: "settings_decrypted"; senderName: string }
  | { type: "rewrapped"; localWrap: MailWorkerLocalWrap }
  | { type: "cache_cleared" }
  | { type: "cancelled" };

export type MailCryptoWorkerResponse =
  | { id: number; ok: MailCryptoWorkerResult }
  | {
      id: number;
      error: {
        code:
          | "invalid_request"
          | "not_configured"
          | "locked"
          | "busy"
          | "expired"
          | "authentication_failed"
          | "crypto_unavailable";
      };
    };

export type MailCryptoWorkerEvent = {
  event: "inactivity_locked";
};

export type MailCryptoWorkerError = Extract<
  MailCryptoWorkerResponse,
  { error: unknown }
>["error"];

type MailWorkerCachedHandle = Readonly<{
  publicInfo: MailWorkerCachePublicInfo;
  handle: MailVetKeyHandle;
}>;

type MailWorkerCachePort = Readonly<{
  load(
    scope: MailWorkerCacheScope,
    live: MailWorkerLiveGeneration,
  ): Promise<MailWorkerCachedHandle | null>;
  save(
    scope: MailWorkerCacheScope,
    publicInfo: MailWorkerCachePublicInfo,
    handle: MailVetKeyHandle,
  ): Promise<void>;
  prune(
    scope: MailWorkerCacheScope,
    live: readonly MailWorkerLiveGeneration[],
  ): Promise<void>;
  clear(): Promise<void>;
}>;

export class MailCryptoWorkerRuntime {
  readonly #vault: MailCryptoVault<MailVetKeyHandle>;
  readonly #cache: MailWorkerCachePort;
  #configuredScope: MailWorkerCacheScope | null = null;
  #configuredCurrent: MailWorkerCachePublicInfo | null = null;
  #configuredPrevious: MailWorkerCachePublicInfo | null = null;
  #stagedScope: MailWorkerCacheScope | null = null;
  #staged: MailWorkerCachedHandle[] = [];
  #stagingRevision = 0;
  #requestTail: Promise<void> = Promise.resolve();

  constructor(
    onInactivityLock: () => void = () => undefined,
    cache: MailWorkerCachePort = new MailVetKeyCache(),
    sessionFactory: () => MailTransportSession<MailVetKeyHandle> =
      () => MailVetKeyTransportSession.random(),
  ) {
    this.#cache = cache;
    this.#vault = new MailCryptoVault({
      adapter: new OfficialMailIbeAdapter(),
      sessionFactory,
      onInactivityLock,
      onHandleRecovered: (recovered) => this.#persistRecoveredHandle(recovered),
    });
  }

  handle(request: MailCryptoWorkerRequest): Promise<MailCryptoWorkerResult> {
    try {
      assertRequestId(request.id);
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = this.#requestTail.then(() => this.#handleRequest(request));
    this.#requestTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #handleRequest(
    request: MailCryptoWorkerRequest,
  ): Promise<MailCryptoWorkerResult> {
    switch (request.type) {
      case "prepare_cache":
        return this.#prepareCache(request);
      case "configure": {
        const stagedScope = this.#stagedScope;
        const staged = this.#staged;
        this.#invalidateStaged();
        const scope = request.scope === null
          ? null
          : validateCacheScope(request.scope);
        const current = validateCachePublicInfo(
          request.current,
          scope ?? undefined,
        );
        const previous = request.previous === null
          ? null
          : validateCachePublicInfo(request.previous, scope ?? undefined);
        if (
          previous !== null &&
          previous.canisterPrincipal !== current.canisterPrincipal
        ) {
          throw new Error("Mail cached canister binding does not match");
        }
        const configuration: MailCryptoVaultConfiguration = {
          current: parseKeyInfo(cachePublicInfoToKeyInfo(current)),
          previous: previous === null
            ? null
            : parseKeyInfo(cachePublicInfoToKeyInfo(previous)),
          ...(request.inactivityMs === undefined
            ? {}
            : { inactivityMs: request.inactivityMs }),
        };
        this.#vault.configure(configuration);
        this.#configuredScope = scope;
        this.#configuredCurrent = cloneCachePublicInfo(current);
        this.#configuredPrevious = previous === null
          ? null
          : cloneCachePublicInfo(previous);
        if (sameCacheScope(scope, stagedScope)) {
          for (const cached of staged) {
            const configured = this.#configuredInfoForEpoch(cached.publicInfo.epoch);
            if (
              configured === null ||
              !sameCachePublicInfo(configured, cached.publicInfo)
            ) continue;
            try {
              this.#vault.restoreHandle(
                parseKeyInfo(cachePublicInfoToKeyInfo(configured)),
                cached.handle,
              );
            } catch {
              // A staged cache handle is optional and must match exactly.
            }
          }
        }
        if (scope !== null) {
          await this.#pruneCache(scope, [
            liveGenerationFromPublicInfo(current),
            ...(previous === null
              ? []
              : [liveGenerationFromPublicInfo(previous)]),
          ]);
        }
        return {
          type: "status",
          status: serializeStatus(this.#vault.status()),
        };
      }
      case "begin_unlock": {
        const result = this.#vault.beginUnlock(parseEpoch(request.epoch));
        return {
          type: "unlock_request",
          epoch: result.epoch.toString(),
          transportPublicKey: result.transportPublicKey,
          requestNonce: result.requestNonce,
          expiresAt: result.expiresAt,
        };
      }
      case "complete_unlock":
        return {
          type: "status",
          status: serializeStatus(
            await this.#vault.completeUnlock(
              parseEpoch(request.epoch),
              validateFixedBytes(request.encryptedVetKey, 192, "Encrypted VetKey"),
            ),
          ),
        };
      case "cancel_unlock":
        this.#vault.cancelPendingUnlock();
        return { type: "cancelled" };
      case "reset": {
        this.#invalidateStaged();
        this.#configuredScope = null;
        this.#configuredCurrent = null;
        this.#configuredPrevious = null;
        const status = this.#vault.reset();
        return { type: "status", status: serializeStatus(status) };
      }
      case "lock": {
        this.#invalidateStaged();
        const status = this.#vault.lock();
        return { type: "status", status: serializeStatus(status) };
      }
      case "clear_cache":
        this.#invalidateStaged();
        await this.#clearCache();
        return { type: "cache_cleared" };
      case "status":
        return { type: "status", status: serializeStatus(this.#vault.status()) };
      case "encrypt": {
        const encrypted = await this.#vault.encrypt({
          senderPrincipal: request.senderPrincipal,
          recipientPrincipal: request.recipientPrincipal,
          recipientKey: parseKeyInfo(request.recipientKey),
          header: request.header,
          body: request.body,
        });
        return {
          type: "encrypted",
          messageId: encrypted.messageId,
          envelope: encrypted.envelope,
          senderLocalWrap: serializeLocalWrap(encrypted.senderLocalWrap),
        };
      }
      case "decrypt_header": {
        const decrypted = await this.#vault.decryptHeader({
          senderPrincipal: request.senderPrincipal,
          recipientPrincipal: request.recipientPrincipal,
          encryptedHeader: parseEncryptedHeader(request.encryptedHeader),
          localWrap: parseLocalWrap(request.localWrap),
        });
        return {
          type: "header_decrypted",
          messageId: decrypted.messageId,
          header: decrypted.header,
        };
      }
      case "decrypt": {
        const decrypted = await this.#vault.decrypt({
          senderPrincipal: request.senderPrincipal,
          recipientPrincipal: request.recipientPrincipal,
          envelope: request.envelope,
          localWrap: parseLocalWrap(request.localWrap),
        });
        return {
          type: "decrypted",
          messageId: decrypted.messageId,
          header: decrypted.header,
          body: decrypted.body,
        };
      }
      case "settings_encrypt": {
        const encrypted = await this.#vault.encryptSettings({
          selfPrincipal: request.selfPrincipal,
          senderName: request.senderName,
          recordId: validateFixedBytes(
            request.recordId,
            MAIL_LIMITS.messageIdBytes,
            "Mail settings record id",
          ),
          revision: parseEpoch(request.revision),
        });
        return {
          type: "settings_encrypted",
          encrypted: {
            recordId: encrypted.recordId,
            revision: encrypted.revision.toString(),
            localWrap: serializeLocalWrap(encrypted.localWrap),
            nonce: encrypted.nonce,
            ciphertextAndTag: encrypted.ciphertextAndTag,
          },
        };
      }
      case "settings_decrypt": {
        const decrypted = await this.#vault.decryptSettings({
          selfPrincipal: request.selfPrincipal,
          encrypted: parseEncryptedSettings(request.encrypted),
        });
        return { type: "settings_decrypted", senderName: decrypted.senderName };
      }
      case "rewrap":
        return {
          type: "rewrapped",
          localWrap: serializeLocalWrap(
            await this.#vault.rewrap(parseLocalWrap(request.localWrap)),
          ),
        };
    }
  }

  async #prepareCache(
    request: Extract<MailCryptoWorkerRequest, { type: "prepare_cache" }>,
  ): Promise<Extract<MailCryptoWorkerResult, { type: "cache_prepared" }>> {
    const stagingRevision = this.#invalidateStaged();
    const scope = request.scope === null
      ? null
      : validateCacheScope(request.scope);
    const currentLive = parseLiveGeneration(request.current);
    const previousLive = request.previous === null
      ? null
      : parseLiveGeneration(request.previous);
    if (
      previousLive !== null &&
      previousLive.epoch === currentLive.epoch
    ) {
      throw new Error("Current and previous Mail generations must be distinct");
    }
    if (scope === null) {
      return this.#cachePreparedResult(null, null);
    }

    const live = [
      currentLive,
      ...(previousLive === null ? [] : [previousLive]),
    ];
    await this.#pruneCache(scope, live);
    const [current, previous] = await Promise.all([
      this.#loadCache(scope, currentLive),
      previousLive === null
        ? Promise.resolve(null)
        : this.#loadCache(scope, previousLive),
    ]);
    if (stagingRevision !== this.#stagingRevision) {
      return this.#cachePreparedResult(null, null);
    }

    this.#stagedScope = scope;
    for (const cached of [current, previous]) {
      if (cached === null) continue;
      const configured = sameCacheScope(scope, this.#configuredScope)
        ? this.#configuredInfoForEpoch(cached.publicInfo.epoch)
        : null;
      if (
        configured !== null &&
        sameCachePublicInfo(configured, cached.publicInfo)
      ) {
        try {
          this.#vault.restoreHandle(
            parseKeyInfo(cachePublicInfoToKeyInfo(configured)),
            cached.handle,
          );
          continue;
        } catch {
          // Reconfiguration may have raced this optional cache read.
        }
      }
      this.#staged.push(cached);
    }
    return this.#cachePreparedResult(
      current?.publicInfo ?? null,
      previous?.publicInfo ?? null,
    );
  }

  #cachePreparedResult(
    current: MailWorkerCachePublicInfo | null,
    previous: MailWorkerCachePublicInfo | null,
  ): Extract<MailCryptoWorkerResult, { type: "cache_prepared" }> {
    return {
      type: "cache_prepared",
      current: current === null ? null : cloneCachePublicInfo(current),
      previous: previous === null ? null : cloneCachePublicInfo(previous),
      status: serializeStatus(this.#vault.status()),
    };
  }

  #configuredInfoForEpoch(epoch: string): MailWorkerCachePublicInfo | null {
    if (this.#configuredCurrent?.epoch === epoch) return this.#configuredCurrent;
    if (this.#configuredPrevious?.epoch === epoch) return this.#configuredPrevious;
    return null;
  }

  #invalidateStaged(): number {
    this.#stagingRevision += 1;
    this.#stagedScope = null;
    this.#staged = [];
    return this.#stagingRevision;
  }

  async #loadCache(
    scope: MailWorkerCacheScope,
    live: MailWorkerLiveGeneration,
  ): Promise<MailWorkerCachedHandle | null> {
    try {
      return await this.#cache.load(scope, live);
    } catch {
      return null;
    }
  }

  async #pruneCache(
    scope: MailWorkerCacheScope,
    live: readonly MailWorkerLiveGeneration[],
  ): Promise<void> {
    try {
      await this.#cache.prune(scope, live);
    } catch {
      // Persistent recovery is only an optimization.
    }
  }

  async #clearCache(): Promise<void> {
    try {
      await this.#cache.clear();
    } catch {
      // Volatile key erasure remains authoritative.
    }
  }

  async #persistRecoveredHandle(input: {
    key: MailIbePublicKeyInfo;
    handle: MailVetKeyHandle;
  }): Promise<void> {
    const scope = this.#configuredScope;
    const publicInfo = this.#configuredInfoForEpoch(input.key.epoch.toString());
    if (
      scope === null ||
      publicInfo === null ||
      !sameWorkerKeyInfo(
        cachePublicInfoToKeyInfo(publicInfo),
        serializeKeyInfo(input.key),
      )
    ) return;

    try {
      await this.#cache.save(
        scope,
        cloneCachePublicInfo(publicInfo),
        input.handle,
      );
    } catch {
      // A cache write must never turn a successful VetKey recovery into an
      // apparent failure that could trigger another paid derivation.
    }
  }
}

function parseEncryptedSettings(value: MailWorkerEncryptedSettings) {
  if (!value) throw new Error("Invalid encrypted Mail settings");
  if (
    !(value.ciphertextAndTag instanceof Uint8Array) ||
    value.ciphertextAndTag.byteLength < 16 ||
    value.ciphertextAndTag.byteLength > 4_096
  ) throw new Error("Invalid encrypted Mail settings");
  return {
    recordId: validateFixedBytes(
      value.recordId,
      MAIL_LIMITS.messageIdBytes,
      "Mail settings record id",
    ),
    revision: parseEpoch(value.revision),
    localWrap: parseLocalWrap(value.localWrap),
    nonce: validateFixedBytes(value.nonce, MAIL_LIMITS.nonceBytes, "Mail settings nonce"),
    ciphertextAndTag: value.ciphertextAndTag.slice(),
  };
}

function parseKeyInfo(value: MailWorkerKeyInfo): MailIbePublicKeyInfo {
  if (!value || value.suite !== 1) throw new Error("Invalid Mail key information");
  return {
    suite: 1,
    epoch: parseEpoch(value.epoch),
    fingerprint: validateFingerprint(value.fingerprint),
    contextPublicKey: validateFixedBytes(value.contextPublicKey, 96, "Context public key"),
    effectiveIbeIdentity: validateFixedBytes(
      value.effectiveIbeIdentity,
      32,
      "Effective IBE identity",
    ),
  };
}

function parseLiveGeneration(
  value: MailWorkerLiveGeneration,
): MailWorkerLiveGeneration {
  if (
    !value ||
    (value.keyName !== "key_1" && value.keyName !== "test_key_1")
  ) {
    throw new Error("Invalid Mail live key generation");
  }
  const epoch = validateUnsignedDecimal(value.epoch, "Mail live key epoch");
  if (epoch === "0") throw new Error("Invalid Mail live key generation");
  return {
    epoch,
    keyName: value.keyName,
    publicFingerprint: value.publicFingerprint === null
      ? null
      : validateFixedBytes(
          value.publicFingerprint,
          32,
          "Mail live public fingerprint",
        ),
  };
}

function serializeKeyInfo(value: MailIbePublicKeyInfo): MailWorkerKeyInfo {
  return {
    suite: 1,
    epoch: value.epoch.toString(),
    fingerprint: value.fingerprint.slice(),
    contextPublicKey: value.contextPublicKey.slice(),
    effectiveIbeIdentity: value.effectiveIbeIdentity.slice(),
  };
}

function cloneCachePublicInfo(
  value: MailWorkerCachePublicInfo,
): MailWorkerCachePublicInfo {
  return {
    canisterPrincipal: value.canisterPrincipal,
    slot: "mailbox",
    suite: 1,
    keyName: value.keyName,
    epoch: value.epoch,
    publicFingerprint: value.publicFingerprint.slice(),
    fingerprint: value.fingerprint.slice(),
    contextPublicKey: value.contextPublicKey.slice(),
    effectiveIbeIdentity: value.effectiveIbeIdentity.slice(),
  };
}

function sameCacheScope(
  left: MailWorkerCacheScope | null,
  right: MailWorkerCacheScope | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.app === right.app &&
    left.canisterPrincipal === right.canisterPrincipal &&
    left.installationUid === right.installationUid &&
    left.browserOriginNonce === right.browserOriginNonce &&
    left.browserOriginAuthorityEpoch === right.browserOriginAuthorityEpoch
  );
}

function sameCachePublicInfo(
  left: MailWorkerCachePublicInfo,
  right: MailWorkerCachePublicInfo,
): boolean {
  return (
    left.canisterPrincipal === right.canisterPrincipal &&
    left.slot === right.slot &&
    left.suite === right.suite &&
    left.keyName === right.keyName &&
    left.epoch === right.epoch &&
    sameBytes(left.publicFingerprint, right.publicFingerprint) &&
    sameBytes(left.fingerprint, right.fingerprint) &&
    sameBytes(left.contextPublicKey, right.contextPublicKey) &&
    sameBytes(left.effectiveIbeIdentity, right.effectiveIbeIdentity)
  );
}

function sameWorkerKeyInfo(
  left: MailWorkerKeyInfo,
  right: MailWorkerKeyInfo,
): boolean {
  return (
    left.suite === right.suite &&
    left.epoch === right.epoch &&
    sameBytes(left.fingerprint, right.fingerprint) &&
    sameBytes(left.contextPublicKey, right.contextPublicKey) &&
    sameBytes(left.effectiveIbeIdentity, right.effectiveIbeIdentity)
  );
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function parseLocalWrap(value: MailWorkerLocalWrap): MailLocalCekWrap {
  if (!value) throw new Error("Invalid Mail local wrap");
  return {
    epoch: parseEpoch(value.epoch),
    fingerprint: validateFingerprint(value.fingerprint),
    wrappedCek: validateFixedBytes(
      value.wrappedCek,
      MAIL_LIMITS.wrappedCekBytes,
      "Wrapped content key",
    ),
  };
}

function parseEncryptedHeader(value: MailWorkerEncryptedHeader) {
  if (!value) throw new Error("Invalid encrypted Mail header");
  return {
    deliveryKeyEpoch: parseEpoch(value.deliveryKeyEpoch),
    recipientKeyFingerprint: validateFingerprint(value.recipientKeyFingerprint),
    messageId: validateFixedBytes(
      value.messageId,
      MAIL_LIMITS.messageIdBytes,
      "Message id",
    ),
    headerNonce: validateFixedBytes(
      value.headerNonce,
      MAIL_LIMITS.nonceBytes,
      "Header nonce",
    ),
    headerCiphertextAndTag: validateFixedBytes(
      value.headerCiphertextAndTag,
      MAIL_HEADER_CIPHERTEXT_BYTES,
      "Encrypted Mail header",
    ),
  };
}

function serializeLocalWrap(value: MailLocalCekWrap): MailWorkerLocalWrap {
  return {
    epoch: value.epoch.toString(),
    fingerprint: value.fingerprint.slice(),
    wrappedCek: value.wrappedCek.slice(),
  };
}

function serializeStatus(value: MailCryptoVaultStatus): MailWorkerStatus {
  return {
    configured: value.configured,
    currentEpoch: value.currentEpoch?.toString() ?? null,
    previousEpoch: value.previousEpoch?.toString() ?? null,
    unlockedEpochs: value.unlockedEpochs.map(String),
    currentUnlocked: value.currentUnlocked,
    pendingEpoch: value.pendingEpoch?.toString() ?? null,
    inactivityExpiresAt: value.inactivityExpiresAt,
  };
}

function parseEpoch(value: string): bigint {
  return BigInt(validateUnsignedDecimal(value, "Mail key epoch"));
}

function assertRequestId(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0x7fff_ffff) {
    throw new Error("Invalid Mail worker request id");
  }
}

export function classifyMailWorkerError(error: unknown): MailCryptoWorkerError {
  const message = error instanceof Error ? error.message : "";
  if (/already pending|busy/iu.test(message)) return { code: "busy" };
  if (/expired/iu.test(message)) return { code: "expired" };
  if (/not configured|generation is unavailable/iu.test(message)) {
    return { code: "not_configured" };
  }
  if (/locked/iu.test(message)) return { code: "locked" };
  if (/authenticate|decrypt|unwrap/iu.test(message)) {
    return { code: "authentication_failed" };
  }
  if (/invalid|must|outside|distinct|missing|mismatch/iu.test(message)) {
    return { code: "invalid_request" };
  }
  return { code: "crypto_unavailable" };
}

type WorkerScope = {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<MailCryptoWorkerRequest>) => void,
  ): void;
  postMessage(
    message: MailCryptoWorkerResponse | MailCryptoWorkerEvent,
    transfer?: Transferable[],
  ): void;
};

const workerScope = globalThis as unknown as WorkerScope;
if (typeof workerScope.addEventListener === "function" && typeof workerScope.postMessage === "function") {
  const runtime = new MailCryptoWorkerRuntime(() => {
    workerScope.postMessage({ event: "inactivity_locked" });
  });
  workerScope.addEventListener("message", (event) => {
    const id = Number((event.data as { id?: unknown } | null)?.id);
    void runtime.handle(event.data).then(
      (ok) => {
        const response: MailCryptoWorkerResponse = { id, ok };
        workerScope.postMessage(response, transferableBuffers(ok));
      },
      (error) => workerScope.postMessage({ id, error: classifyMailWorkerError(error) }),
    );
  });
}

function transferableBuffers(value: MailCryptoWorkerResult): Transferable[] {
  const buffers = new Set<ArrayBuffer>();
  const visit = (candidate: unknown): void => {
    if (candidate instanceof Uint8Array && candidate.buffer instanceof ArrayBuffer) {
      buffers.add(candidate.buffer);
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (candidate && typeof candidate === "object") {
      for (const item of Object.values(candidate)) visit(item);
    }
  };
  visit(value);
  return [...buffers];
}
