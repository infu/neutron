import {
  approveVetKeyDerivation,
  deriveVetKey,
  getVetKeyPublicKey,
  isVetKeysError,
  listVetKeys,
  type JsonObject,
  type MsgBusCallerContext,
  type VetKeyDeriveChallenge,
  type VetKeyDeriveResult,
  type VetKeyPublicInfo,
  type VetKeySlotSummary,
} from "neutron-tools/app";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  getMailCryptoStatus,
  type MailBackendCryptoProgress,
} from "./backend.ts";
import { computeMailKeyFingerprint } from "./protocol.ts";
import type {
  MailCryptoWorkerClient,
} from "./crypto_worker_client.ts";
import { MAIL_MAX_INACTIVITY_MS } from "./crypto_vault.ts";
import type {
  MailCryptoWorkerResult,
  MailWorkerCachePublicInfo,
  MailWorkerLiveGeneration,
  MailWorkerStatus,
} from "./crypto_worker.ts";
import {
  MAIL_CONTEXT_PUBLIC_KEY_BYTES,
  MAIL_EFFECTIVE_IBE_IDENTITY_BYTES,
  MAIL_ENCRYPTED_VETKEY_BYTES,
  MAIL_TRANSPORT_PUBLIC_KEY_BYTES,
} from "./vetkeys_adapter.ts";
import { validateFixedBytes, validateUnsignedDecimal } from "./model.ts";

export const MAIL_VETKEY_SLOT = "mailbox";
export const MAIL_CRYPTO_SESSION_TOOL = "mail_crypto_session";
export const MAIL_DERIVE_TIMEOUT_SECONDS = 65;

export function assertMailCryptoTileCaller(
  caller: MsgBusCallerContext | undefined,
): void {
  if (caller?.appId !== "mail" || caller.role !== "tile") {
    throw new Error("Mail crypto sessions are available only to a Mail tile");
  }
}

export function assertMailCryptoTrayCaller(
  caller: MsgBusCallerContext | undefined,
): void {
  if (caller?.appId !== "mail" || caller.role !== "tray") {
    throw new Error("Mail tray projections are available only to the Mail tray");
  }
}

export type MailCryptoSessionSnapshot = JsonObject & {
  version: 1;
  lockState: "not_configured" | "locked" | "unlocked";
  currentEpoch: string | null;
  previousEpoch: string | null;
  currentUnlocked: boolean;
  previousUnlocked: boolean;
  inactivityExpiresAt: string | null;
};

export type MailCryptoGeneration = "current" | "previous";

export type MailCryptoStatusPort = Pick<
  MailCryptoResidentSession,
  "status" | "statusLocal"
>;

export type MailCryptoSessionErrorCode =
  | "not_configured"
  | "owner_required"
  | "challenge_expired"
  | "busy"
  | "low_cycles"
  | "capability_changed"
  | "unavailable";

export type MailCryptoReadyResult =
  | (JsonObject & {
      ok: true;
      session: MailCryptoSessionSnapshot;
    })
  | (JsonObject & {
      ok: false;
      error: JsonObject & {
        code: MailCryptoSessionErrorCode;
        retryAfterSeconds: string | null;
      };
    });

type MailCryptoWorkerPort = Pick<
  MailCryptoWorkerClient,
  | "configure"
  | "prepareCache"
  | "beginUnlock"
  | "completeUnlock"
  | "cancelUnlock"
  | "clearCache"
  | "reset"
  | "lock"
  | "status"
>;

export type MailCryptoResidentDependencies = {
  getBackendStatus: () => Promise<MailBackendCryptoProgress | null>;
  listSlots: () => Promise<{ slots: VetKeySlotSummary[] }>;
  getPublicKey: (request: {
    slot: string;
    generation: string;
  }) => Promise<VetKeyPublicInfo>;
  derive: (
    request: {
      slot: string;
      generation: string;
      transportPublicKey: Uint8Array;
      requestNonce: Uint8Array;
    },
    options: {
      timeout: number;
      onChallenge: (challenge: VetKeyDeriveChallenge) => void;
    },
  ) => Promise<VetKeyDeriveResult>;
  approve?: (challengeId: string) => Promise<void>;
  withRecoveryLock?: <Result>(
    name: string,
    operation: () => Promise<Result>,
  ) => Promise<Result>;
};

type PublicBinding = {
  current: VetKeyPublicInfo;
  previous: VetKeyPublicInfo | null;
};

const defaultDependencies: MailCryptoResidentDependencies = {
  getBackendStatus: getMailCryptoStatus,
  listSlots: listVetKeys,
  getPublicKey: getVetKeyPublicKey,
  derive: deriveVetKey,
  approve: (challengeId) => approveVetKeyDerivation({ challengeId }),
};

/**
 * Background-only coordinator. Public slot information may live here, while
 * transport secrets and derived VetKeys stay inside the dedicated worker.
 */
export class MailCryptoResidentSession {
  readonly #worker: MailCryptoWorkerPort;
  readonly #dependencies: MailCryptoResidentDependencies;
  #binding: PublicBinding | null = null;
  #persistentCacheRetired = false;
  #syncing: Promise<MailCryptoSessionSnapshot> | null = null;
  readonly #recovering = new Map<string, Promise<MailCryptoReadyResult>>();
  readonly #bindingChangeListeners = new Set<() => void>();

  constructor(
    worker: MailCryptoWorkerPort,
    dependencies: MailCryptoResidentDependencies = defaultDependencies,
  ) {
    this.#worker = worker;
    this.#dependencies = dependencies;
  }

  sync(): Promise<MailCryptoSessionSnapshot> {
    if (this.#syncing) return this.#syncing;
    const operation = this.#syncNow().finally(() => {
      if (this.#syncing === operation) this.#syncing = null;
    });
    this.#syncing = operation;
    return operation;
  }

  async status(): Promise<MailCryptoSessionSnapshot> {
    return this.ensureCurrentAndPrevious();
  }

  /** Plaintext/cache owners subscribe here; transitions fire before key mutation. */
  onBindingChange(listener: () => void): () => void {
    this.#bindingChangeListeners.add(listener);
    return () => this.#bindingChangeListeners.delete(listener);
  }

  /**
   * Invocation-safe readiness check. The expected lifecycle state comes from
   * that invocation's scoped backend transport, while the resident recovers
   * its own app-isolated key through the kernel's private source-bound path.
   */
  async statusLocal(
    expected: MailBackendCryptoProgress | null,
  ): Promise<MailCryptoSessionSnapshot> {
    if (expected === null) {
      const snapshot = await this.sync();
      if (snapshot.lockState === "not_configured") return snapshot;
      await this.#resetForLocalMismatch();
      throw new MailCryptoSessionFault("capability_changed");
    }
    const session = await this.ensureCurrentAndPrevious();
    if (
      !sameBindingEpochs(this.#binding, expected) ||
      session.currentEpoch !== expected.currentEpoch ||
      session.previousEpoch !== expected.previousEpoch
    ) {
      await this.#resetForLocalMismatch();
      throw new MailCryptoSessionFault("capability_changed");
    }
    return session;
  }

  /**
   * Scoped status projection that may restore an authenticated worker cache,
   * but never starts a paid VetKey derivation. Polling `mail_status` must stay
   * observational.
   */
  async observeLocal(
    expected: MailBackendCryptoProgress | null,
  ): Promise<MailCryptoSessionSnapshot> {
    const session = await this.sync();
    if (expected === null) {
      if (session.lockState === "not_configured") return session;
      await this.#resetForLocalMismatch();
      throw new MailCryptoSessionFault("capability_changed");
    }
    if (
      !sameBindingEpochs(this.#binding, expected) ||
      session.currentEpoch !== expected.currentEpoch ||
      session.previousEpoch !== expected.previousEpoch
    ) {
      await this.#resetForLocalMismatch();
      throw new MailCryptoSessionFault("capability_changed");
    }
    return session;
  }

  /** Recover a configured generation without exposing a key or a consent UI. */
  ensureGeneration(
    generation: MailCryptoGeneration = "current",
  ): Promise<MailCryptoReadyResult> {
    const key = generation;
    const pending = this.#recovering.get(key);
    if (pending) return pending;
    const operation = this.#ensureGenerationNow(generation).finally(() => {
      if (this.#recovering.get(key) === operation) this.#recovering.delete(key);
    });
    this.#recovering.set(key, operation);
    return operation;
  }

  async ensureCurrentAndPrevious(): Promise<MailCryptoSessionSnapshot> {
    try {
      return await this.#ensureCurrentAndPreviousOnce();
    } catch (error) {
      // Rotation and previous retirement replace the public binding while an
      // older recovery may still be completing. That attempt fails closed;
      // one fresh pass then binds only to the newly validated lifecycle.
      if (
        !(error instanceof MailCryptoSessionFault) ||
        error.code !== "capability_changed"
      ) throw error;
      return this.#ensureCurrentAndPreviousOnce();
    }
  }

  async #ensureCurrentAndPreviousOnce(): Promise<MailCryptoSessionSnapshot> {
    const current = await this.ensureGeneration("current");
    if (!current.ok) {
      if (current.error.code === "not_configured") {
        return snapshotFromWorker(
          expectWorkerResult(await this.#worker.status(), "status").status,
        );
      }
      throw new MailCryptoSessionFault(current.error.code);
    }
    if (current.session.previousEpoch === null) return current.session;
    const previous = await this.ensureGeneration("previous");
    if (!previous.ok) {
      throw new MailCryptoSessionFault(previous.error.code);
    }
    return previous.session;
  }

  async #ensureGenerationNow(
    generation: MailCryptoGeneration,
  ): Promise<MailCryptoReadyResult> {
    try {
      const session = await this.sync();
      if (session.lockState === "not_configured" || !this.#binding) {
        return readyFailure("not_configured");
      }
      if (
        (generation === "current" && session.currentUnlocked) ||
        (generation === "previous" && session.previousUnlocked)
      ) return { ok: true, session };

      const expectedBinding = this.#binding;
      const requestedInfo = generation === "current"
        ? expectedBinding.current
        : expectedBinding.previous;
      if (requestedInfo === null) {
        return readyFailure("capability_changed");
      }
      const epoch = requestedInfo.generation;
      const withRecoveryLock =
        this.#dependencies.withRecoveryLock ?? withDefaultMailRecoveryLock;
      return await withRecoveryLock(
        mailRecoveryLockName(requestedInfo),
        async () => {
          // Another resident may have completed and cached this generation
          // while this one waited. Re-read the live lifecycle and the
          // worker-only cache under the same origin-wide lock before paying.
          const refreshed = await this.sync();
          if (
            this.#binding !== expectedBinding ||
            refreshed.currentEpoch !== expectedBinding.current.generation ||
            refreshed.previousEpoch !== (expectedBinding.previous?.generation ?? null)
          ) throw new MailCryptoSessionFault("capability_changed");
          if (
            (generation === "current" && refreshed.currentUnlocked) ||
            (generation === "previous" && refreshed.previousUnlocked)
          ) return { ok: true, session: refreshed };

          const begin = expectWorkerResult(
            await this.#worker.beginUnlock(epoch),
            "unlock_request",
          );
          if (begin.epoch !== epoch) throw new Error("Mail worker epoch changed");
          const transportPublicKey = validateFixedBytes(
            begin.transportPublicKey,
            MAIL_TRANSPORT_PUBLIC_KEY_BYTES,
            "Mail transport public key",
          );
          const requestNonce = validateFixedBytes(
            begin.requestNonce,
            MAIL_EFFECTIVE_IBE_IDENTITY_BYTES,
            "Mail unlock nonce",
          );

          let rejectApproval!: (error: unknown) => void;
          const approvalFailure = new Promise<never>((_resolve, reject) => {
            rejectApproval = reject;
          });
          const approve = this.#dependencies.approve ?? defaultDependencies.approve!;
          const derivation = this.#dependencies.derive(
            {
              slot: MAIL_VETKEY_SLOT,
              generation: epoch,
              transportPublicKey,
              requestNonce,
            },
            {
              timeout: MAIL_DERIVE_TIMEOUT_SECONDS,
              onChallenge(challenge) {
                let parsed: VetKeyDeriveChallenge;
                try {
                  parsed = parseChallenge(challenge);
                } catch (error) {
                  rejectApproval(error);
                  return;
                }
                void approve(parsed.challengeId).catch(rejectApproval);
              },
            },
          );
          const derived = await Promise.race([derivation, approvalFailure]);
          assertSamePublicInfo(derived.publicInfo, requestedInfo);
          await this.#assertBindingStillMatches(expectedBinding);
          const completed = expectWorkerResult(
            await this.#worker.completeUnlock(
              epoch,
              validateNumberBytes(
                derived.encryptedKey,
                MAIL_ENCRYPTED_VETKEY_BYTES,
                "Encrypted Mail VetKey",
              ),
            ),
            "status",
          );
          const snapshot = snapshotFromWorker(completed.status);
          if (
            snapshot.currentEpoch !== expectedBinding.current.generation ||
            snapshot.previousEpoch !== (expectedBinding.previous?.generation ?? null) ||
            (generation === "current" ? !snapshot.currentUnlocked : !snapshot.previousUnlocked)
          ) {
            throw new Error(`Mail worker did not recover the ${generation} generation`);
          }
          await this.#assertBindingStillMatches(expectedBinding);
          const confirmed = await this.sync();
          if (
            confirmed.currentEpoch !== expectedBinding.current.generation ||
            confirmed.previousEpoch !== (expectedBinding.previous?.generation ?? null) ||
            (generation === "current" ? !confirmed.currentUnlocked : !confirmed.previousUnlocked)
          ) throw new MailCryptoSessionFault("capability_changed");
          return { ok: true, session: confirmed };
        },
      );
    } catch (error) {
      await this.#cancelPendingUnlock();
      const code = classifySessionError(error);
      if (code === "capability_changed") {
        try {
          await this.sync();
        } catch {
          if (this.#binding !== null) this.#notifyBindingChange();
          this.#binding = null;
          await this.#worker.reset().catch(() => undefined);
        }
      }
      return readyFailure(code);
    }
  }

  async #syncNow(): Promise<MailCryptoSessionSnapshot> {
    const backend = await this.#dependencies.getBackendStatus();
    if (backend === null) {
      if (this.#binding !== null) this.#notifyBindingChange();
      this.#binding = null;
      const reset = expectWorkerResult(await this.#worker.reset(), "status");
      if (!this.#persistentCacheRetired) {
        await this.#worker.clearCache();
        this.#persistentCacheRetired = true;
      }
      return snapshotFromWorker(reset.status);
    }

    const slots = await this.#dependencies.listSlots();
    const slot = slots.slots.find((candidate) => candidate.slot === MAIL_VETKEY_SLOT);
    if (!slot || !compatibleSlot(slot, backend)) {
      const retirePersistentCache = !slot || slot.status !== "enabled";
      if (this.#binding !== null) this.#notifyBindingChange();
      this.#binding = null;
      await this.#worker.reset();
      if (retirePersistentCache && !this.#persistentCacheRetired) {
        await this.#worker.clearCache();
        this.#persistentCacheRetired = true;
      }
      throw new MailCryptoSessionFault("capability_changed");
    }
    const currentLive = liveGeneration(slot, backend.currentEpoch, "current");
    const previousLive = backend.previousEpoch === null
      ? null
      : liveGeneration(slot, backend.previousEpoch, "previous");
    this.#persistentCacheRetired = false;

    if (sameBindingEpochs(this.#binding, backend)) {
      if (!publicBindingMatchesLive(this.#binding!, currentLive, previousLive)) {
        this.#notifyBindingChange();
        this.#binding = null;
        await this.#worker.reset();
        throw new MailCryptoSessionFault("capability_changed");
      }
      const local = expectWorkerResult(await this.#worker.status(), "status").status;
      if (
        local.currentUnlocked &&
        (previousLive === null ||
          local.unlockedEpochs.includes(previousLive.epoch))
      ) {
        if (
          !publicBindingMatchesLive(
            this.#binding!,
            currentLive,
            previousLive,
          )
        ) {
          await this.#resetForLocalMismatch();
          throw new MailCryptoSessionFault("capability_changed");
        }
        return snapshotFromWorker(local);
      }
      const cached = await this.#prepareCache(currentLive, previousLive);
      if (cached === null) return snapshotFromWorker(local);
      if (cached.current !== null) {
        assertSamePublicInfo(
          workerCacheInfoToPublic(cached.current),
          this.#binding!.current,
        );
      }
      if (cached.previous !== null) {
        if (this.#binding!.previous === null) {
          throw new MailCryptoSessionFault("capability_changed");
        }
        assertSamePublicInfo(
          workerCacheInfoToPublic(cached.previous),
          this.#binding!.previous,
        );
      }
      const snapshot = snapshotFromWorker(cached.status);
      if (
        cached.status.unlockedEpochs.some(
          (epoch) => !local.unlockedEpochs.includes(epoch),
        )
      ) {
        await this.#revalidateCacheRestore(this.#binding!);
      }
      return snapshot;
    }

    if (this.#binding !== null) {
      // Erase handles and resident plaintext before any await that fetches or
      // configures a replacement holder/generation binding.
      this.#notifyBindingChange();
      this.#binding = null;
      await this.#worker.reset();
    }

    const cached = await this.#prepareCache(currentLive, previousLive);
    const [current, previous] = await Promise.all([
      cached?.current
        ? Promise.resolve(workerCacheInfoToPublic(cached.current))
        : this.#dependencies.getPublicKey({
            slot: MAIL_VETKEY_SLOT,
            generation: backend.currentEpoch,
          }),
      backend.previousEpoch === null
        ? Promise.resolve(null)
        : cached?.previous
          ? Promise.resolve(workerCacheInfoToPublic(cached.previous))
          : this.#dependencies.getPublicKey({
              slot: MAIL_VETKEY_SLOT,
              generation: backend.previousEpoch,
            }),
    ]);
    const currentWorkerInfo = publicInfoToWorker(current, currentLive);
    const previousWorkerInfo = previous === null || previousLive === null
      ? null
      : publicInfoToWorker(previous, previousLive);
    const configured = expectWorkerResult(
      await this.#worker.configure({
        current: currentWorkerInfo,
        previous: previousWorkerInfo,
        // Keep one recovered handle for the longest bounded worker interval.
        // If it expires, the next operation recovers it automatically.
        inactivityMs: MAIL_MAX_INACTIVITY_MS,
      }),
      "status",
    );
    const nextBinding = { current, previous };
    this.#binding = nextBinding;
    const snapshot = snapshotFromWorker(configured.status);
    if (configured.status.unlockedEpochs.length > 0) {
      await this.#revalidateCacheRestore(nextBinding);
    }
    return snapshot;
  }

  async #prepareCache(
    current: MailWorkerLiveGeneration,
    previous: MailWorkerLiveGeneration | null,
  ): Promise<Extract<MailCryptoWorkerResult, { type: "cache_prepared" }> | null> {
    return expectWorkerResult(
      await this.#worker.prepareCache({ current, previous }),
      "cache_prepared",
    );
  }

  async #cancelPendingUnlock(): Promise<void> {
    try {
      await this.#worker.cancelUnlock();
    } catch {
      // The failed/expired transport session is one-use and the worker may
      // already have consumed it. Cancellation is best-effort cleanup only.
    }
  }

  async #assertBindingStillMatches(expected: PublicBinding): Promise<void> {
    const [backend, slots] = await Promise.all([
      this.#dependencies.getBackendStatus(),
      this.#dependencies.listSlots(),
    ]);
    const slot = slots.slots.find((candidate) => candidate.slot === MAIL_VETKEY_SLOT);
    if (
      backend === null ||
      !slot ||
      !compatibleSlot(slot, backend) ||
      !sameBindingEpochs(expected, backend) ||
      this.#binding !== expected
    ) {
      throw new MailCryptoSessionFault("capability_changed");
    }
    const currentLive = liveGeneration(slot, backend.currentEpoch, "current");
    const previousLive = backend.previousEpoch === null
      ? null
      : liveGeneration(slot, backend.previousEpoch, "previous");
    if (!publicBindingMatchesLive(expected, currentLive, previousLive)) {
      throw new MailCryptoSessionFault("capability_changed");
    }
  }

  async #revalidateCacheRestore(expected: PublicBinding): Promise<void> {
    try {
      await this.#assertBindingStillMatches(expected);
    } catch (error) {
      if (this.#binding === expected) {
        this.#notifyBindingChange();
        this.#binding = null;
      }
      await this.#worker.reset().catch(() => undefined);
      throw error;
    }
  }

  async #resetForLocalMismatch(): Promise<void> {
    this.#notifyBindingChange();
    this.#binding = null;
    await this.#worker.reset();
  }

  #notifyBindingChange(): void {
    for (const listener of this.#bindingChangeListeners) {
      try {
        listener();
      } catch {
        // Key erasure and binding replacement remain authoritative.
      }
    }
  }
}

class MailCryptoSessionFault extends Error {
  constructor(readonly code: MailCryptoSessionErrorCode) {
    super(code);
    this.name = "MailCryptoSessionFault";
  }
}

function compatibleSlot(
  slot: VetKeySlotSummary,
  backend: MailBackendCryptoProgress,
): boolean {
  return (
    slot.status === "enabled" &&
    slot.currentGeneration === backend.currentEpoch &&
    slot.previousGeneration === backend.previousEpoch &&
    slot.generations.some(
      (generation) =>
        generation.generation === backend.currentEpoch &&
        generation.status === "current",
    ) &&
    (backend.previousEpoch === null ||
      slot.generations.some(
        (generation) =>
          generation.generation === backend.previousEpoch &&
          generation.status === "previous",
      ))
  );
}

function sameBindingEpochs(
  binding: PublicBinding | null,
  backend: MailBackendCryptoProgress,
): boolean {
  return (
    binding !== null &&
    binding.current.generation === backend.currentEpoch &&
    (binding.previous?.generation ?? null) === backend.previousEpoch
  );
}

function publicInfoToWorker(
  info: VetKeyPublicInfo,
  live: MailWorkerLiveGeneration,
): MailWorkerCachePublicInfo {
  if (
    info.slot !== MAIL_VETKEY_SLOT ||
    info.suite !== "bls12_381_g2" ||
    info.generation !== live.epoch ||
    info.keyName !== live.keyName
  ) {
    throw new MailCryptoSessionFault("capability_changed");
  }
  const epoch = validateUnsignedDecimal(info.generation, "Mail key epoch");
  if (epoch === "0") throw new MailCryptoSessionFault("capability_changed");
  const contextPublicKey = validateNumberBytes(
    info.publicKey,
    MAIL_CONTEXT_PUBLIC_KEY_BYTES,
    "Mail context public key",
  );
  const effectiveIbeIdentity = validateNumberBytes(
    info.derivationInput,
    MAIL_EFFECTIVE_IBE_IDENTITY_BYTES,
    "Mail IBE identity",
  );
  const publicFingerprint = validateNumberBytes(
    info.publicFingerprint,
    32,
    "Mail public fingerprint",
  );
  if (
    !sameBytes(publicFingerprint, sha256(contextPublicKey)) ||
    (live.publicFingerprint !== null &&
      !sameBytes(publicFingerprint, live.publicFingerprint))
  ) {
    throw new MailCryptoSessionFault("capability_changed");
  }
  return {
    canisterPrincipal: info.canisterPrincipal,
    slot: "mailbox",
    suite: 1,
    keyName: info.keyName,
    epoch,
    publicFingerprint,
    fingerprint: computeMailKeyFingerprint({
      suite: 1,
      epoch: BigInt(epoch),
      contextPublicKey,
      effectiveIbeIdentity,
    }),
    contextPublicKey,
    effectiveIbeIdentity,
  };
}

function workerCacheInfoToPublic(
  info: MailWorkerCachePublicInfo,
): VetKeyPublicInfo {
  return {
    canisterPrincipal: info.canisterPrincipal,
    slot: info.slot,
    generation: info.epoch,
    suite: "bls12_381_g2",
    keyName: info.keyName,
    publicKey: [...info.contextPublicKey],
    publicFingerprint: [...info.publicFingerprint],
    derivationInput: [...info.effectiveIbeIdentity],
  };
}

function liveGeneration(
  slot: VetKeySlotSummary,
  epoch: string,
  status: "current" | "previous",
): MailWorkerLiveGeneration {
  const generation = slot.generations.find(
    (candidate) =>
      candidate.generation === epoch &&
      candidate.status === status,
  );
  if (!generation) throw new MailCryptoSessionFault("capability_changed");
  return {
    epoch,
    keyName: generation.keyName,
    publicFingerprint: generation.publicFingerprint === null
      ? null
      : validateNumberBytes(
          generation.publicFingerprint,
          32,
          "Mail live public fingerprint",
        ),
  };
}

function publicBindingMatchesLive(
  binding: PublicBinding,
  current: MailWorkerLiveGeneration,
  previous: MailWorkerLiveGeneration | null,
): boolean {
  return publicInfoMatchesLive(binding.current, current) &&
    (binding.previous === null
      ? previous === null
      : previous !== null && publicInfoMatchesLive(binding.previous, previous));
}

function publicInfoMatchesLive(
  info: VetKeyPublicInfo,
  live: MailWorkerLiveGeneration,
): boolean {
  return info.generation === live.epoch &&
    info.keyName === live.keyName &&
    live.publicFingerprint !== null &&
    sameNumbers(info.publicFingerprint, live.publicFingerprint);
}

function snapshotFromWorker(status: MailWorkerStatus): MailCryptoSessionSnapshot {
  if (!status.configured) {
    if (
      status.currentEpoch !== null ||
      status.previousEpoch !== null ||
      status.currentUnlocked ||
      status.unlockedEpochs.length !== 0 ||
      status.pendingEpoch !== null ||
      status.inactivityExpiresAt !== null
    ) {
      throw new Error("Mail worker returned an invalid unconfigured state");
    }
    return {
      version: 1,
      lockState: "not_configured",
      currentEpoch: null,
      previousEpoch: null,
      currentUnlocked: false,
      previousUnlocked: false,
      inactivityExpiresAt: null,
    };
  }
  if (status.currentEpoch === null) {
    throw new Error("Mail worker omitted its current generation");
  }
  const currentEpoch = workerEpoch(status.currentEpoch, "Mail worker current generation");
  const previousEpoch = status.previousEpoch === null
    ? null
    : workerEpoch(status.previousEpoch, "Mail worker previous generation");
  if (previousEpoch === currentEpoch || status.unlockedEpochs.length > 2) {
    throw new Error("Mail worker returned invalid generations");
  }
  const allowed = new Set([currentEpoch, ...(previousEpoch === null ? [] : [previousEpoch])]);
  const unlockedEpochs = status.unlockedEpochs.map((epoch) =>
    workerEpoch(epoch, "Mail worker unlocked generation")
  );
  if (
    new Set(unlockedEpochs).size !== unlockedEpochs.length ||
    unlockedEpochs.some((epoch) => !allowed.has(epoch)) ||
    status.currentUnlocked !== unlockedEpochs.includes(currentEpoch) ||
    (status.pendingEpoch !== null && !allowed.has(
      workerEpoch(status.pendingEpoch, "Mail worker pending generation"),
    )) ||
    (status.inactivityExpiresAt === null) !== (unlockedEpochs.length === 0) ||
    (status.inactivityExpiresAt !== null &&
      (!Number.isSafeInteger(status.inactivityExpiresAt) || status.inactivityExpiresAt < 0))
  ) {
    throw new Error("Mail worker returned an invalid key state");
  }
  return {
    version: 1,
    lockState: status.currentUnlocked ? "unlocked" : "locked",
    currentEpoch,
    previousEpoch: previousEpoch,
    currentUnlocked: status.currentUnlocked,
    previousUnlocked: previousEpoch !== null && unlockedEpochs.includes(previousEpoch),
    inactivityExpiresAt:
      status.inactivityExpiresAt === null
        ? null
        : String(status.inactivityExpiresAt),
  };
}

function workerEpoch(value: string, label: string): string {
  const epoch = validateUnsignedDecimal(value, label);
  if (epoch === "0") throw new Error(`${label} is invalid`);
  return epoch;
}

function parseChallenge(
  challenge: VetKeyDeriveChallenge,
): VetKeyDeriveChallenge {
  const id = challenge.challengeId;
  if (
    challenge.type !== "challenge" ||
    typeof id !== "string" ||
    !/^[A-Za-z0-9_-]{16,160}$/u.test(id)
  ) {
    throw new Error("Invalid Mail key recovery challenge");
  }
  return {
    type: "challenge",
    challengeId: id,
    expiresAt: validateUnsignedDecimal(
      challenge.expiresAt,
      "Mail key recovery expiry",
      BigInt(Number.MAX_SAFE_INTEGER),
    ),
  };
}

function validateNumberBytes(
  value: readonly number[],
  length: number,
  label: string,
): Uint8Array {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    value.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return Uint8Array.from(value);
}

function assertSamePublicInfo(
  actual: VetKeyPublicInfo,
  expected: VetKeyPublicInfo,
): void {
  if (
    actual.canisterPrincipal !== expected.canisterPrincipal ||
    actual.slot !== expected.slot ||
    actual.generation !== expected.generation ||
    actual.suite !== expected.suite ||
    actual.keyName !== expected.keyName ||
    !sameNumbers(actual.publicKey, expected.publicKey) ||
    !sameNumbers(actual.publicFingerprint, expected.publicFingerprint) ||
    !sameNumbers(actual.derivationInput, expected.derivationInput)
  ) {
    throw new MailCryptoSessionFault("capability_changed");
  }
}

function sameNumbers(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index]);
}

function mailRecoveryLockName(info: VetKeyPublicInfo): string {
  const fingerprint = validateNumberBytes(
    info.publicFingerprint,
    32,
    "Mail recovery lock fingerprint",
  );
  return `neutron-mail-vetkey-recovery-v1:${info.generation}:${hex(fingerprint)}`;
}

async function withDefaultMailRecoveryLock<Result>(
  name: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks || typeof locks.request !== "function") return operation();
  return locks.request(name, { mode: "exclusive" }, operation);
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function expectWorkerResult<T extends MailCryptoWorkerResult["type"]>(
  result: MailCryptoWorkerResult,
  type: T,
): Extract<MailCryptoWorkerResult, { type: T }> {
  if (result.type !== type) throw new Error("Mail worker returned an unexpected result");
  return result as Extract<MailCryptoWorkerResult, { type: T }>;
}

function classifySessionError(error: unknown): MailCryptoSessionErrorCode {
  if (error instanceof MailCryptoSessionFault) return error.code;
  if (isVetKeysError(error)) {
    switch (error.code) {
      case "owner_required":
        return "owner_required";
      case "challenge_expired":
      case "challenge_consumed":
        return "challenge_expired";
      case "busy":
        return "busy";
      case "low_cycles":
        return "low_cycles";
      case "disabled":
      case "manifest_suspended":
      case "generation_unavailable":
      case "not_reserved":
      case "not_declared":
      case "source_gone":
        return "capability_changed";
      default:
        return "unavailable";
    }
  }
  const message = error instanceof Error ? error.message : "";
  if (/expired|timed out/iu.test(message)) return "challenge_expired";
  if (/busy|pending|rate limit/iu.test(message)) return "busy";
  if (/owner|holder/iu.test(message)) return "owner_required";
  return "unavailable";
}

function readyFailure(code: MailCryptoSessionErrorCode): MailCryptoReadyResult {
  return {
    ok: false,
    error: {
      code,
      retryAfterSeconds: null,
    },
  };
}
