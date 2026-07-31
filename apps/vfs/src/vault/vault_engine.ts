import { Principal } from "@dfinity/principal";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import type {
  VetKeyPublicInfo,
  VetKeySlotSummary,
} from "neutron-tools/app";
import type {
  CanonicalNat64,
  FilesBootstrapOkV2,
  FilesId128V2,
  FilesListCursorV2,
  FilesNodeBindingV2,
} from "../protocol/types.ts";
import {
  FILES_VETKEY_SLOT,
  type FilesVetKeyPublicInfo,
} from "../crypto/vetkeys.ts";
import type {
  FilesCommittedVault,
  FilesMetadataBinding,
} from "../crypto/types.ts";
import { equalBytes } from "../crypto/canonical.ts";
import type {
  FilesCryptoWorkerResult,
  FilesVaultPublicCacheDescriptor,
} from "../crypto/worker_protocol.ts";
import { DEFAULT_FILES_VETKEYS_PORT } from "./browser_ports.ts";
import {
  assertFilesMetadataBinding,
  decodeFilesMetadata,
  encodeFilesMetadata,
} from "./metadata.ts";
import {
  canonicalizeFilesPath,
  type CanonicalFilesPath,
} from "./paths.ts";
import {
  bytesToFilesDigest,
  filesDigestToBytes,
  incrementFilesRevision,
  randomFilesRequestId,
  sameFilesDigest,
  sameFilesId,
} from "./ids.ts";
import {
  decodeFilesListFrame,
  decodeFilesLookupFrame,
  decodeFilesVaultReadFrame,
  encodeFilesVaultWriteFrame,
} from "./frame_codec.ts";
import type {
  FilesBackendPort,
  FilesCapacitySnapshot,
  FilesPublicCapacityDimension,
  FilesCryptoPort,
  FilesListPage,
  FilesNodeRecord,
  FilesPrivateMetadata,
  FilesVaultRecord,
  FilesVaultStatus,
  FilesVetKeysPort,
} from "./types.ts";
import {
  FILES_ROOT_ID,
  FILES_VAULT_FORMAT,
} from "./types.ts";
import { FilesMetadataLru } from "../resident/metadata_lru.ts";
import {
  filesNodeEnvelopeMatches,
  type FilesNodeEnvelopeCompleteness,
} from "./node_envelope.ts";

const DERIVE_TIMEOUT_SECONDS = 65;

export type FilesVaultEngineDependencies = Readonly<{
  backend: FilesBackendPort;
  crypto: FilesCryptoPort;
  vetkeys?: FilesVetKeysPort;
  nowNs?: () => bigint;
  randomBytes?: (length: number) => Uint8Array;
  withUnlockLock?: FilesVaultUnlockLock;
}>;

export type FilesVaultUnlockLock = <Result>(
  operation: () => Promise<Result>,
) => Promise<Result>;

export type FilesVaultBootstrapOptions = Readonly<{
  initializeIfAbsent?: boolean;
  unlock?: boolean;
}>;

export class FilesVaultEngineFault extends Error {
  constructor(
    readonly code:
      | "not_initialized"
      | "not_found"
      | "needs_user_unlock"
      | "capability_changed"
      | "unrecoverable"
      | "conflict"
      | "incompatible"
      | "corrupt_state"
      | "cancelled",
    message: string = code,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FilesVaultEngineFault";
  }
}

type FilesVaultBindings = {
  slot: VetKeySlotSummary;
  current: FilesVetKeyPublicInfo;
  previous: FilesVetKeyPublicInfo | null;
};

/**
 * Volatile coordinator for the committed Files vault.
 *
 * Raw VetKeys, the vault root, HKDF keys, and content keys never enter this
 * class. They remain behind FilesCryptoPort in the dedicated worker.
 */
export class FilesVaultEngine {
  readonly #backend: FilesBackendPort;
  readonly #crypto: FilesCryptoPort;
  readonly #vetkeys: FilesVetKeysPort;
  readonly #nowNs: () => bigint;
  readonly #randomBytes:
    | ((length: number) => Uint8Array)
    | undefined;
  readonly #withUnlockLock: FilesVaultUnlockLock;
  readonly #metadataCache =
    new FilesMetadataLru<string, FilesPrivateMetadata>();
  #status: FilesVaultStatus = Object.freeze({
    state: "uninitialized",
    capacity: null,
  });
  #bootstrapPending: Promise<FilesVaultStatus> | null = null;
  #unlockPending: Promise<FilesVaultStatus> | null = null;
  #committedViewRefreshPending:
    | Promise<Extract<FilesVaultStatus, { state: "ready" }>>
    | null = null;
  #lifecycleSerial: Promise<void> = Promise.resolve();
  #bindings: FilesVaultBindings | null = null;
  readonly #lockListeners = new Set<() => void>();
  readonly #unsubscribeInactivity: (() => void) | null;

  constructor(dependencies: FilesVaultEngineDependencies) {
    this.#backend = dependencies.backend;
    this.#crypto = dependencies.crypto;
    this.#vetkeys = dependencies.vetkeys ?? DEFAULT_FILES_VETKEYS_PORT;
    this.#nowNs =
      dependencies.nowNs ??
      (() => BigInt(Date.now()) * 1_000_000n);
    this.#randomBytes = dependencies.randomBytes;
    this.#withUnlockLock =
      dependencies.withUnlockLock ?? withNativeFilesVaultUnlockLock;
    this.#unsubscribeInactivity =
      dependencies.crypto.onInactivityLock?.(() => {
        this.#markWorkerLocked();
      }) ?? null;
  }

  status(): FilesVaultStatus {
    return this.#status;
  }

  onLock(listener: () => void): () => void {
    this.#lockListeners.add(listener);
    return () => this.#lockListeners.delete(listener);
  }

  dispose(): void {
    this.#unsubscribeInactivity?.();
    this.#lockListeners.clear();
    this.#metadataCache.clear();
  }

  bootstrap(
    options: FilesVaultBootstrapOptions = {},
  ): Promise<FilesVaultStatus> {
    if (this.#bootstrapPending) return this.#bootstrapPending;
    const operation = this.#enqueueLifecycle(
      () => this.#bootstrapNow(options),
    ).finally(() => {
      if (this.#bootstrapPending === operation) {
        this.#bootstrapPending = null;
      }
    });
    this.#bootstrapPending = operation;
    return operation;
  }

  unlock(): Promise<FilesVaultStatus> {
    if (this.#status.state === "ready") return Promise.resolve(this.#status);
    if (this.#unlockPending) return this.#unlockPending;
    const operation = this.#enqueueLifecycle(() => this.#unlockNow())
      .catch(async (error: unknown) => {
        await this.#fenceWorkerAfterFailure();
        throw error;
      })
      .finally(() => {
        if (this.#unlockPending === operation) this.#unlockPending = null;
      });
    this.#unlockPending = operation;
    return operation;
  }

  async lock(): Promise<FilesVaultStatus> {
    return this.#enqueueLifecycle(() => this.#lockNow());
  }

  async #lockNow(): Promise<FilesVaultStatus> {
    const result = expectWorker(
      await this.#crypto.call({ type: "lock" }),
      "status",
    );
    if (this.#status.state === "ready") {
      this.#status = Object.freeze({
        state: "locked",
        capacity: this.#status.capacity,
        record: this.#status.record,
        currentGeneration: this.#status.currentGeneration,
        previousGeneration: this.#status.previousGeneration,
        migrationRequired:
          this.#status.record.slotGeneration !==
          this.#status.currentGeneration,
      });
    }
    if (result.status.unlocked) {
      throw new FilesVaultEngineFault(
        "corrupt_state",
        "Files worker remained unlocked",
      );
    }
    this.#notifyLock();
    return this.#status;
  }

  async refreshCommittedView(): Promise<
    Extract<FilesVaultStatus, { state: "ready" }>
  > {
    if (this.#committedViewRefreshPending) {
      return this.#committedViewRefreshPending;
    }
    const previous = this.#requireReady();
    this.#metadataCache.clear();
    const operation = this.#enqueueLifecycle(
      () => this.#refreshCommittedViewNow(previous),
    ).finally(() => {
      if (this.#committedViewRefreshPending === operation) {
        this.#committedViewRefreshPending = null;
      }
    });
    this.#committedViewRefreshPending = operation;
    return operation;
  }

  async #refreshCommittedViewNow(
    previous: Extract<FilesVaultStatus, { state: "ready" }>,
  ): Promise<
    Extract<FilesVaultStatus, { state: "ready" }>
  > {
    try {
      const bootstrap = await this.#backend.bootstrap();
      const ok = expectOutcome(bootstrap, "Files refresh");
      if (ok.vault === null || vaultIsAbsent(ok)) {
        throw new FilesVaultEngineFault(
          "corrupt_state",
          "The committed Files vault disappeared",
        );
      }
      const { record, bindings } =
        await this.#recordFromBootstrap(ok, bootstrap.body);
      if (
        record.format !== previous.record.format ||
        !equalBytes(record.context.vaultId, previous.record.context.vaultId) ||
        !equalBytes(
          record.context.vaultSalt,
          previous.record.context.vaultSalt,
        ) ||
        !equalBytes(
          record.rootCommitment,
          previous.record.rootCommitment,
        )
      ) {
        throw new FilesVaultEngineFault(
          "capability_changed",
          "Files refresh changed the vault identity",
        );
      }
      const workerStatus = expectWorker(
        await this.#crypto.call({ type: "status" }),
        "status",
      );
      if (!workerStatus.status.unlocked) {
        throw new FilesVaultEngineFault("needs_user_unlock");
      }
      const root = await this.#lookupCommittedRoot(record);
      this.#status = Object.freeze({
        state: "ready",
        capacity: deriveCapacity(ok),
        record,
        root,
        currentGeneration:
          bindings.current.generation as CanonicalNat64,
        previousGeneration:
          bindings.slot.previousGeneration as CanonicalNat64 | null,
        rotationConfirmed:
          record.slotGeneration === bindings.current.generation,
      });
      return this.#status;
    } catch (error) {
      await this.#fenceWorkerAfterFailure();
      throw error;
    }
  }

  async lookupPath(pathInput: string): Promise<FilesNodeRecord> {
    const path = canonicalizeFilesPath(pathInput);
    const ready = this.#requireReady();
    if (path.segments.length === 0) return ready.root;
    let current = ready.root;
    for (const segment of path.segments) {
      current = await this.lookupChild(current, segment);
    }
    return current;
  }

  async lookupChild(
    parent: FilesNodeRecord,
    name: string,
  ): Promise<FilesNodeRecord> {
    this.#requireReady();
    if (parent.node.kind !== "folder") {
      throw new FilesVaultEngineFault(
        "conflict",
        "Files path traverses through a file",
      );
    }
    const nameTagResult = expectWorker(
      await this.#crypto.call({
        type: "name_tag",
        parentNodeId: parent.node.nodeId,
        filename: name,
      }),
      "name_tag",
    );
    const outcome = await this.#backend.lookup(
      {
        locator: {
          child: {
            parent_id: parent.node.nodeId,
            expected_children_revision: parent.node.childrenRevision,
          },
        },
        body: nameTagResult.nameTag.slice(),
      },
    );
    const child = await this.#decodeLookupOutcome(
      outcome,
      parent.node.nodeId,
      nameTagResult.nameTag,
    );
    if (child.metadata.name !== name) {
      throw new FilesVaultEngineFault(
        "corrupt_state",
        "Files child lookup returned a different private name",
      );
    }
    return child;
  }

  async lookupNode(nodeId: FilesId128V2): Promise<FilesNodeRecord> {
    this.#requireReady();
    const outcome = await this.#backend.lookup(
      {
        locator: { node: { node_id: nodeId } },
        body: new Uint8Array(),
      },
    );
    return this.#decodeLookupOutcome(outcome, null, null);
  }

  async listFolder(
    folder: FilesNodeRecord,
    options: Readonly<{
      cursor?: FilesListCursorV2 | null;
      limit?: number;
    }> = {},
  ): Promise<FilesListPage> {
    this.#requireReady();
    if (folder.node.kind !== "folder") {
      throw new FilesVaultEngineFault("conflict", "Files node is not a folder");
    }
    const outcome = await this.#backend.list({
      parent_id: folder.node.nodeId,
      expected_structural_revision: folder.node.structuralRevision,
      cursor: options.cursor ?? null,
      limit: options.limit ?? 100,
    });
    const ok = expectOutcome(outcome, "Files list");
    const frame = decodeFilesListFrame(outcome.body);
    if (
      !sameFilesId(ok.parent_id, frame.control.parentId) ||
      !sameFilesId(ok.parent_id, folder.node.nodeId) ||
      ok.structural_revision !== frame.control.structuralRevision ||
      ok.structural_revision !== folder.node.structuralRevision ||
      ok.children_revision !== frame.control.childrenRevision ||
      ok.children_revision !== folder.node.childrenRevision ||
      ok.loaded_count !== frame.control.items.length ||
      ok.has_more !== (frame.control.nextCursor !== null) ||
      !sameListCursor(ok.next_cursor, frame.control.nextCursor)
    ) {
      throw new FilesVaultEngineFault(
        "corrupt_state",
        "Files list frame does not match its outer binding",
      );
    }
    const items: FilesNodeRecord[] = [];
    for (const item of frame.control.items) {
      if (!sameFilesId(item.node.parentId, folder.node.nodeId)) {
        throw new FilesVaultEngineFault(
          "corrupt_state",
          "Files list returned a child from another folder",
        );
      }
      items.push(await this.#decryptNode(
        item.node,
        item.content,
        item.encryptedMetadata,
        null,
        "summary",
      ));
    }
    return Object.freeze({
      parentId: frame.control.parentId,
      structuralRevision: frame.control.structuralRevision,
      childrenRevision: frame.control.childrenRevision,
      items: Object.freeze(items),
      totalChildren: ok.total_children,
      hasMore: ok.has_more,
      nextCursor: ok.next_cursor,
    });
  }

  async #bootstrapNow(
    options: FilesVaultBootstrapOptions,
  ): Promise<FilesVaultStatus> {
    // A refresh is an authority/binding checkpoint. Never retain a previously
    // unlocked key while replacing the resident's committed view.
    // Mark the view unavailable before yielding so private operations cannot
    // race the deliberate worker lock. This lifecycle checkpoint is not an
    // inactivity event and must not cause the resident to destroy its runtime.
    this.#setWorkerLockedStatus();
    await this.#crypto.call({ type: "lock" });
    const initializeIfAbsent = options.initializeIfAbsent ?? true;
    const shouldUnlock = options.unlock ?? false;
    const bootstrap = await this.#backend.bootstrap();
    const ok = expectOutcome(bootstrap, "Files bootstrap");
    if (ok.vault === null) {
      throw new FilesVaultEngineFault(
        "incompatible",
        "Files bootstrap returned an unknown vault-state variant",
      );
    }
    const absent = vaultIsAbsent(ok);
    if (absent) {
      if (bootstrap.body.byteLength !== 0) {
        throw new FilesVaultEngineFault(
          "corrupt_state",
          "Absent Files vault returned a body",
        );
      }
      await this.#crypto.call({ type: "reset" });
      this.#bindings = null;
      this.#status = Object.freeze({
        state: "uninitialized",
        capacity: deriveCapacity(ok),
      });
      if (!initializeIfAbsent) return this.#status;
      return this.#initializeRace();
    }
    const { record, bindings } =
      await this.#recordFromBootstrap(ok, bootstrap.body);
    const migrationRequired =
      record.slotGeneration !== bindings.current.generation;
    this.#status = Object.freeze({
      state: "locked",
      capacity: deriveCapacity(ok),
      record,
      currentGeneration:
        bindings.current.generation as CanonicalNat64,
      previousGeneration:
        bindings.slot.previousGeneration as CanonicalNat64 | null,
      migrationRequired,
    });
    return shouldUnlock ? this.#unlockNow() : this.#status;
  }

  async #initializeRace(): Promise<FilesVaultStatus> {
    const bindings = await this.#ensureInitializationBindings();
    const initialized = expectWorker(
      await this.#crypto.call({
        type: "initialize_vault",
        neutronCanisterPrincipalBytes:
          bindings.current.canisterPrincipalBytes.slice(),
      }),
      "vault_initialized",
    );
    const now = this.#nowNs();
    if (now < 0n || now > 0xffff_ffff_ffff_ffffn) {
      await this.#crypto.call({ type: "lock" });
      throw new FilesVaultEngineFault(
        "corrupt_state",
        "Files clock is outside Nat64",
      );
    }
    const nowNs = now.toString() as CanonicalNat64;
    const metadataPlaintext = encodeFilesMetadata({
      nodeKind: "folder",
      name: "",
      createdAtNs: nowNs,
      modifiedAtNs: nowNs,
    });
    const encrypted = expectWorker(
      await this.#crypto.call({
        type: "encrypt_metadata",
        binding: rootMetadataBinding("1"),
        plaintext: metadataPlaintext,
      }),
      "metadata_encrypted",
    );
    const requestId = randomFilesRequestId(this.#randomBytes);
    const frame = encodeFilesVaultWriteFrame({
      requestId,
      expectedRecordRevision: null,
      proposedRecordRevision: "1" as CanonicalNat64,
      operation: "initialize",
      format: FILES_VAULT_FORMAT,
      vaultId: initialized.vault.context.vaultId,
      vaultSalt: initialized.vault.context.vaultSalt,
      slotGeneration:
        bindings.current.generation as CanonicalNat64,
      publicKeyFingerprint:
        initialized.vault.wrapper.publicKeyFingerprint,
      rootCommitment: initialized.vault.rootCommitment,
      rootStructuralRevision: "1" as CanonicalNat64,
      rootMetadataRevision: "1" as CanonicalNat64,
      rootChildrenRevision: "0" as CanonicalNat64,
      wrapperCiphertext: initialized.vault.wrapper.ciphertext,
      encryptedRootMetadata: encrypted.ciphertext,
    });
    try {
      const outcome = await this.#backend.vaultWrite(
        {
          request_id: requestId,
          operation: { initialize: null },
          expected_record_revision: null,
          proposed_record_revision: "1" as CanonicalNat64,
          body_bytes: frame.byteLength,
          body: frame.slice(),
        },
      );
      if (outcome.kind === "rejected") {
        const reason = outcome.rejection.reason?.tag;
        if (
          reason !== "already_exists" &&
          reason !== "stale_revision" &&
          reason !== "conflict"
        ) {
          throw rejectedFault("Files vault initialization", outcome);
        }
      } else if (outcome.kind === "unsupported") {
        throw new FilesVaultEngineFault(
          "incompatible",
          "Files vault initialization is unsupported",
        );
      }
    } catch (error) {
      const reconciled = await this.#reconcileVaultMutation(
        requestId,
        null,
        "1" as CanonicalNat64,
      ).catch(() => false);
      if (!reconciled) {
        await this.#crypto.call({ type: "lock" }).catch(() => undefined);
        throw error;
      }
    }
    try {
      // Whether this endpoint won or lost the CAS, only the committed record
      // is authoritative. Keep the candidate worker-local only until that
      // record has been read back and matched; no uncommitted root enters
      // persistence.
      const readback = await this.#backend.bootstrap();
      const readbackOk = expectOutcome(
        readback,
        "Files initialization readback",
      );
      if (vaultIsAbsent(readbackOk)) {
        throw new FilesVaultEngineFault(
          "corrupt_state",
          "Files initialization did not produce a committed vault",
        );
      }
      const {
        record,
        bindings: committedBindings,
      } = await this.#recordFromBootstrap(readbackOk, readback.body);
      const committedCandidate = await this.#crypto.call({
        type: "commit_vault_cache",
        vault: committedVault(record),
      }).then(
        (result) => result.type === "vault_cache_committed" ? result : null,
        () => null,
      );
      if (
        committedCandidate?.status.unlocked === true &&
        committedCandidate.status.unlockedGeneration ===
          record.slotGeneration &&
        record.slotGeneration === committedBindings.current.generation
      ) {
        const root = await this.#lookupCommittedRoot(record);
        this.#status = Object.freeze({
          state: "ready",
          capacity: deriveCapacity(readbackOk),
          record,
          root,
          currentGeneration:
            committedBindings.current.generation as CanonicalNat64,
          previousGeneration:
            committedBindings.slot.previousGeneration as
              | CanonicalNat64
              | null,
          rotationConfirmed: true,
        });
        return this.#status;
      }
      this.#status = Object.freeze({
        state: "locked",
        capacity: deriveCapacity(readbackOk),
        record,
        currentGeneration:
          committedBindings.current.generation as CanonicalNat64,
        previousGeneration:
          committedBindings.slot.previousGeneration as
            | CanonicalNat64
            | null,
        migrationRequired:
          record.slotGeneration !==
          committedBindings.current.generation,
      });
      try {
        return await this.#unlockNow();
      } catch (error) {
        await this.#fenceWorkerAfterFailure();
        throw error;
      }
    } catch (error) {
      await this.#crypto.call({ type: "lock" }).catch(() => undefined);
      throw error;
    }
  }

  async #unlockNow(): Promise<FilesVaultStatus> {
    if (this.#status.state === "uninitialized") {
      const bootstrapped = await this.#bootstrapNow({
        initializeIfAbsent: false,
        unlock: false,
      });
      if (bootstrapped.state === "uninitialized") {
        throw new FilesVaultEngineFault("not_initialized");
      }
    }
    if (this.#status.state === "ready") return this.#status;
    if (this.#status.state !== "locked") {
      throw new FilesVaultEngineFault("unrecoverable");
    }
    let record = this.#status.record;
    let capacity = this.#status.capacity;
    let bindings =
      this.#bindings ??
      await this.#configureBindings(record.slotGeneration);
    let rotationCommitted = false;
    if (record.slotGeneration !== bindings.current.generation) {
      if (
        bindings.previous === null ||
        bindings.previous.generation !== record.slotGeneration
      ) {
        this.#status = Object.freeze({
          state: "unrecoverable",
          capacity,
          record,
          reason: "The committed Files wrapper generation is unavailable",
        });
        throw new FilesVaultEngineFault("unrecoverable");
      }
      const previousUnlock = await this.#unlockRecord(
        record,
        record.slotGeneration,
        bindings.current.generation,
      );
      if (previousUnlock.rewrapped === null) {
        throw new FilesVaultEngineFault(
          "corrupt_state",
          "Files worker did not return the requested rewrap",
        );
      }
      const requestId = randomFilesRequestId(this.#randomBytes);
      const proposedRevision =
        incrementFilesRevision(record.recordRevision);
      const frame = encodeFilesVaultWriteFrame({
        requestId,
        expectedRecordRevision: record.recordRevision,
        proposedRecordRevision: proposedRevision,
        operation: "rewrap",
        format: record.format,
        vaultId: record.context.vaultId,
        vaultSalt: record.context.vaultSalt,
        slotGeneration:
          bindings.current.generation as CanonicalNat64,
        publicKeyFingerprint:
          previousUnlock.rewrapped.publicKeyFingerprint,
        rootCommitment: record.rootCommitment,
        wrapperCiphertext: previousUnlock.rewrapped.ciphertext,
      });
      try {
        const outcome = await this.#backend.vaultWrite(
          {
            request_id: requestId,
            operation: { rewrap: null },
            expected_record_revision: record.recordRevision,
            proposed_record_revision: proposedRevision,
            body_bytes: frame.byteLength,
            body: frame.slice(),
          },
        );
        if (outcome.kind === "rejected") {
          const reason = outcome.rejection.reason?.tag;
          if (reason !== "stale_revision" && reason !== "conflict") {
            throw rejectedFault("Files vault rotation", outcome);
          }
        } else if (outcome.kind === "unsupported") {
          throw new FilesVaultEngineFault("incompatible");
        }
      } catch (error) {
        const reconciled = await this.#reconcileVaultMutation(
          requestId,
          record.recordRevision,
          proposedRevision,
        ).catch(() => false);
        if (!reconciled) throw error;
      }
      const readback = await this.#backend.bootstrap();
      const readbackOk = expectOutcome(readback, "Files rotation readback");
      capacity = deriveCapacity(readbackOk);
      ({
        record,
        bindings,
      } = await this.#recordFromBootstrap(readbackOk, readback.body));
      if (record.slotGeneration !== bindings.current.generation) {
        this.#status = Object.freeze({
          state: "locked",
          capacity,
          record,
          currentGeneration:
            bindings.current.generation as CanonicalNat64,
          previousGeneration:
            bindings.slot.previousGeneration as CanonicalNat64 | null,
          migrationRequired: true,
        });
        throw new FilesVaultEngineFault(
          "conflict",
          "Files vault migration requires a fresh retry",
        );
      }
      const committedRotation = await this.#crypto.call({
        type: "commit_vault_cache",
        vault: committedVault(record),
      }).then(
        (result) => result.type === "vault_cache_committed" ? result : null,
        () => null,
      );
      rotationCommitted =
        committedRotation?.status.unlocked === true &&
        committedRotation.status.unlockedGeneration ===
          bindings.current.generation;
    }
    if (!rotationCommitted) {
      await this.#crypto.call({ type: "lock" });
      const currentUnlock = await this.#unlockRecord(
        record,
        bindings.current.generation,
      );
      if (currentUnlock.rewrapped !== null) {
        throw new FilesVaultEngineFault(
          "corrupt_state",
          "Current Files unlock unexpectedly returned a rewrap",
        );
      }
      bindings = this.#bindings ?? bindings;
    }
    const root = await this.#lookupCommittedRoot(record);
    this.#status = Object.freeze({
      state: "ready",
      capacity,
      record,
      root,
      currentGeneration:
        bindings.current.generation as CanonicalNat64,
      previousGeneration:
        bindings.slot.previousGeneration as CanonicalNat64 | null,
      rotationConfirmed: true,
    });
    return this.#status;
  }

  async #unlockRecord(
    record: FilesVaultRecord,
    generation: string,
    rewrapToGeneration?: string,
  ): Promise<
    Extract<FilesCryptoWorkerResult, { type: "vault_unlocked" }>
  > {
    return this.#withUnlockLock(
      () => this.#unlockRecordWithLock(
        record,
        generation,
        rewrapToGeneration,
      ),
    );
  }

  async #unlockRecordWithLock(
    record: FilesVaultRecord,
    generation: string,
    rewrapToGeneration?: string,
  ): Promise<
    Extract<FilesCryptoWorkerResult, { type: "vault_unlocked" }>
  > {
    // The lock may have queued behind another tab. Re-read the authoritative
    // slot inside it so a disable, retirement, or rotation cannot be bypassed
    // by a cache hit based on the pre-wait snapshot.
    const bindings = await this.#configureBindings(
      record.slotGeneration,
      vaultPublicCacheDescriptor(record),
    );
    const liveShapeMatches =
      rewrapToGeneration === undefined
        ? generation === bindings.current.generation
        : generation === bindings.previous?.generation &&
          rewrapToGeneration === bindings.current.generation;
    if (!liveShapeMatches) {
      throw new FilesVaultEngineFault(
        "conflict",
        "Files key generation changed while waiting to unlock",
      );
    }
    const publicInfo =
      bindings.current.generation === generation
        ? bindings.current
        : bindings.previous?.generation === generation
          ? bindings.previous
          : null;
    if (!publicInfo) throw new FilesVaultEngineFault("unrecoverable");
    const begin = await this.#crypto.call({
      type: "begin_unlock",
      generation,
      vault: committedVault(record),
      ...(rewrapToGeneration === undefined
        ? {}
        : { rewrapToGeneration }),
    });
    if (begin.type === "vault_unlocked") return begin;
    if (begin.type !== "unlock_request") {
      throw new FilesVaultEngineFault(
        "corrupt_state",
        "Files worker omitted an unlock request",
      );
    }
    let rejectApproval!: (reason: unknown) => void;
    const approvalFailure = new Promise<never>((_resolve, reject) => {
      rejectApproval = reject;
    });
    try {
      const derivation = this.#vetkeys.derive(
        {
          slot: FILES_VETKEY_SLOT,
          generation,
          transportPublicKey: begin.transportPublicKey,
          requestNonce: begin.requestNonce,
        },
        {
          timeout: DERIVE_TIMEOUT_SECONDS,
          onChallenge: (challenge) => {
            if (
              !challenge ||
              challenge.type !== "challenge" ||
              typeof challenge.challengeId !== "string"
            ) {
              rejectApproval(
                new FilesVaultEngineFault("capability_changed"),
              );
              return;
            }
            void this.#vetkeys.approve(challenge.challengeId)
              .catch(rejectApproval);
          },
        },
      );
      const derived = await Promise.race([
        derivation,
        approvalFailure,
      ]);
      assertSamePublicInfo(derived.publicInfo, publicInfo);
      const encryptedVetKey = Uint8Array.from(derived.encryptedKey);
      if (encryptedVetKey.byteLength !== 192) {
        throw new FilesVaultEngineFault("capability_changed");
      }
      return expectWorker(
        await this.#crypto.call({
          type: "complete_unlock",
          generation,
          encryptedVetKey,
          vault: committedVault(record),
          ...(rewrapToGeneration === undefined
            ? {}
            : { rewrapToGeneration }),
        }),
        "vault_unlocked",
      );
    } catch (error) {
      await this.#crypto.call({ type: "cancel_unlock" })
        .catch(() => undefined);
      throw error;
    }
  }

  async #recordFromBootstrap(
    ok: FilesBootstrapOkV2,
    body: ArrayBuffer,
  ): Promise<{
    record: FilesVaultRecord;
    bindings: FilesVaultBindings;
  }> {
    if (ok.vault === null || !("present" in ok.vault)) {
      throw new FilesVaultEngineFault(
        "incompatible",
        "Files bootstrap returned an unknown vault-state variant",
      );
    }
    if (body.byteLength < 1) {
      throw new FilesVaultEngineFault(
        "corrupt_state",
        "Files bootstrap omitted its committed vault",
      );
    }
    const frame = decodeFilesVaultReadFrame(body);
    const outer = ok.vault.present;
    if (
      outer.format !== frame.control.format ||
      outer.record_revision !== frame.control.recordRevision ||
      outer.slot_generation !== frame.control.slotGeneration ||
      outer.wrapper_frame_bytes !== body.byteLength ||
      !sameFilesDigest(
        outer.public_key_fingerprint,
        bytesToFilesDigest(frame.control.publicKeyFingerprint),
      )
    ) {
      throw new FilesVaultEngineFault(
        "corrupt_state",
        "Files vault frame does not match its outer binding",
      );
    }
    if (frame.control.format !== FILES_VAULT_FORMAT) {
      throw new FilesVaultEngineFault(
        "incompatible",
        "Files vault format is unsupported",
      );
    }
    const bindings = await this.#configureBindings(
      frame.control.slotGeneration,
      {
        generation: frame.control.slotGeneration,
        publicKeyFingerprint:
          frame.control.publicKeyFingerprint.slice(),
        vaultId: frame.control.vaultId.slice(),
        vaultSalt: frame.control.vaultSalt.slice(),
        rootCommitment: frame.control.rootCommitment.slice(),
        wrapperCiphertext:
          frame.control.wrapperCiphertext.slice(),
      },
    );
    const workerInfo =
      bindings.current.generation === frame.control.slotGeneration
        ? bindings.current
        : bindings.previous?.generation === frame.control.slotGeneration
          ? bindings.previous
          : null;
    if (
      workerInfo === null ||
      !equalBytes(
        workerInfo.publicFingerprint,
        frame.control.publicKeyFingerprint,
      )
    ) {
      throw new FilesVaultEngineFault(
        "capability_changed",
        "Files vault fingerprint no longer matches its slot",
      );
    }
    const record = Object.freeze({
      format: frame.control.format,
      recordRevision: frame.control.recordRevision,
      slotGeneration: frame.control.slotGeneration,
      context: Object.freeze({
        neutronCanisterPrincipalBytes:
          workerInfo.canisterPrincipalBytes.slice(),
        vaultId: frame.control.vaultId.slice(),
        vaultSalt: frame.control.vaultSalt.slice(),
      }),
      publicKeyFingerprint:
        frame.control.publicKeyFingerprint.slice(),
      rootCommitment: frame.control.rootCommitment.slice(),
      rootStructuralRevision:
        frame.control.rootStructuralRevision,
      rootMetadataRevision: frame.control.rootMetadataRevision,
      rootChildrenRevision: frame.control.rootChildrenRevision,
      wrapperCiphertext: frame.control.wrapperCiphertext.slice(),
      encryptedRootMetadata:
        frame.control.encryptedRootMetadata.slice(),
    });
    return { record, bindings };
  }

  async #configureBindings(
    committedGeneration: string,
    cachedVault?: Omit<
      FilesVaultPublicCacheDescriptor,
      "keyName"
    >,
  ): Promise<FilesVaultBindings> {
    const listed = await this.#vetkeys.list();
    const slot = listed.slots.find(
      (candidate) => candidate.slot === FILES_VETKEY_SLOT,
    );
    if (
      !slot ||
      slot.status !== "enabled" ||
      (committedGeneration !== slot.currentGeneration &&
        committedGeneration !== slot.previousGeneration)
    ) {
      await this.#crypto.call({ type: "reset" });
      this.#bindings = null;
      throw new FilesVaultEngineFault("unrecoverable");
    }
    const summaryFor = (generation: string) =>
      slot.generations.find(
        (candidate) => candidate.generation === generation,
      ) ?? null;
    const committedSummary = summaryFor(committedGeneration);
    if (committedSummary === null) {
      throw new FilesVaultEngineFault("capability_changed");
    }
    const committedFingerprint =
      committedSummary.publicFingerprint === null
        ? null
        : Uint8Array.from(committedSummary.publicFingerprint);
    if (
      cachedVault !== undefined &&
      cachedVault.generation !== committedGeneration
    ) {
      throw new FilesVaultEngineFault("capability_changed");
    }
    if (
      cachedVault !== undefined &&
      committedFingerprint !== null &&
      !equalBytes(
        committedFingerprint,
        cachedVault.publicKeyFingerprint,
      )
    ) {
      throw new FilesVaultEngineFault("capability_changed");
    }
    let cachedCommitted: FilesVetKeyPublicInfo | null = null;
    if (
      cachedVault !== undefined &&
      committedFingerprint !== null
    ) {
      const cached = expectWorker(
        await this.#crypto.call({
          type: "load_cached_public_info",
          vault: {
            ...cachedVault,
            keyName: committedSummary.keyName,
          },
        }),
        "cached_public_info",
      );
      cachedCommitted = cached.publicInfo;
    }
    const reusable = (
      candidate: FilesVetKeyPublicInfo | null | undefined,
      generation: string,
    ): FilesVetKeyPublicInfo | null => {
      if (candidate?.generation !== generation) return null;
      const summary = summaryFor(generation);
      if (
        summary === null ||
        candidate.keyName !== summary.keyName ||
        (summary.publicFingerprint !== null &&
          !equalBytes(
            candidate.publicFingerprint,
            Uint8Array.from(summary.publicFingerprint),
          ))
      ) return null;
      return candidate;
    };
    const getPublic = async (
      generation: string,
    ): Promise<FilesVetKeyPublicInfo> => {
      const workerInfo = publicInfoToWorker(
        await this.#vetkeys.publicKey({
          slot: FILES_VETKEY_SLOT,
          generation,
        }),
      );
      if (reusable(workerInfo, generation) === null) {
        throw new FilesVaultEngineFault("capability_changed");
      }
      return workerInfo;
    };
    const existing = this.#bindings;
    const current =
      committedGeneration === slot.currentGeneration &&
        cachedCommitted !== null
        ? cachedCommitted
        : reusable(existing?.current, slot.currentGeneration) ??
          await getPublic(slot.currentGeneration);
    const previous =
      slot.previousGeneration === null
        ? null
        : committedGeneration === slot.previousGeneration
          ? cachedCommitted ??
            reusable(existing?.previous, slot.previousGeneration) ??
            await getPublic(slot.previousGeneration)
          : reusable(existing?.previous, slot.previousGeneration);
    if (
      current.generation !== slot.currentGeneration ||
      (previous !== null &&
        previous.generation !== slot.previousGeneration)
    ) {
      throw new FilesVaultEngineFault("capability_changed");
    }
    expectWorker(
      await this.#crypto.call({
        type: "configure",
        current,
        previous,
        inactivityMs: null,
      }),
      "status",
    );
    const bindings = { slot, current, previous };
    this.#bindings = bindings;
    return bindings;
  }

  async #ensureInitializationBindings(): Promise<
    FilesVaultBindings
  > {
    const listed = await this.#vetkeys.list();
    const slot = listed.slots.find(
      (candidate) => candidate.slot === FILES_VETKEY_SLOT,
    ) ?? null;
    if (
      !slot ||
      slot.slot !== FILES_VETKEY_SLOT ||
      slot.status !== "enabled"
    ) {
      throw new FilesVaultEngineFault(
        "capability_changed",
        "Files private key slot is unavailable",
      );
    }
    const current = publicInfoToWorker(
      await this.#vetkeys.publicKey({
        slot: FILES_VETKEY_SLOT,
        generation: slot.currentGeneration,
      }),
    );
    const previous =
      slot.previousGeneration === null
        ? null
        : publicInfoToWorker(
            await this.#vetkeys.publicKey({
              slot: FILES_VETKEY_SLOT,
              generation: slot.previousGeneration,
            }),
          );
    if (
      current.generation !== slot.currentGeneration ||
      (previous !== null &&
        previous.generation !== slot.previousGeneration)
    ) {
      throw new FilesVaultEngineFault("capability_changed");
    }
    expectWorker(
      await this.#crypto.call({
        type: "configure",
        current,
        previous,
        inactivityMs: null,
      }),
      "status",
    );
    const bindings = { slot, current, previous };
    this.#bindings = bindings;
    return bindings;
  }

  async #lookupCommittedRoot(
    record: FilesVaultRecord,
  ): Promise<FilesNodeRecord> {
    const outcome = await this.#backend.lookup(
      {
        locator: { node: { node_id: FILES_ROOT_ID } },
        body: new Uint8Array(),
      },
    );
    const ok = expectOutcome(outcome, "Files root lookup");
    const frame = decodeFilesLookupFrame(outcome.body);
    if (
      !sameNodeOuterBinding(
        ok.node,
        frame.control.node,
        frame.control.encryptedMetadata.byteLength,
      ) ||
      ok.content !== null ||
      frame.control.content !== null ||
      frame.control.wrappedContentKey !== null ||
      !sameFilesId(frame.control.node.nodeId, FILES_ROOT_ID) ||
      frame.control.node.structuralRevision !==
        record.rootStructuralRevision ||
      frame.control.node.metadataRevision !== record.rootMetadataRevision ||
      frame.control.node.childrenRevision !== record.rootChildrenRevision ||
      !equalBytes(
        frame.control.encryptedMetadata,
        record.encryptedRootMetadata,
      )
    ) {
      throw new FilesVaultEngineFault(
        "corrupt_state",
        "Files root lookup does not match the committed vault",
      );
    }
    return this.#decryptNode(
      frame.control.node,
      null,
      frame.control.encryptedMetadata,
      null,
      "complete",
    );
  }

  async #decodeLookupOutcome(
    outcome: Awaited<ReturnType<FilesBackendPort["lookup"]>>,
    expectedParentId: FilesId128V2 | null,
    expectedNameTag: Uint8Array | null,
  ): Promise<FilesNodeRecord> {
    const ok = expectOutcome(outcome, "Files lookup");
    const frame = decodeFilesLookupFrame(outcome.body);
    if (
      !sameNodeOuterBinding(
        ok.node,
        frame.control.node,
        frame.control.encryptedMetadata.byteLength,
      ) ||
      !sameContentOuterBinding(ok.content, frame.control.content) ||
      (expectedParentId !== null &&
        !sameFilesId(frame.control.node.parentId, expectedParentId)) ||
      (expectedNameTag !== null &&
        !equalBytes(frame.control.node.nameTag, expectedNameTag))
    ) {
      throw new FilesVaultEngineFault(
        "corrupt_state",
        "Files lookup frame does not match its binding",
      );
    }
    return this.#decryptNode(
      frame.control.node,
      frame.control.content,
      frame.control.encryptedMetadata,
      frame.control.wrappedContentKey,
      "complete",
    );
  }

  async #decryptNode(
    node: FilesNodeRecord["node"],
    content: FilesNodeRecord["content"],
    encryptedMetadata: Uint8Array,
    wrappedContentKey: Uint8Array | null,
    completeness: FilesNodeEnvelopeCompleteness,
  ): Promise<FilesNodeRecord> {
    if (
      !filesNodeEnvelopeMatches(
        node.kind,
        content,
        wrappedContentKey,
        completeness,
      )
    ) {
      throw new FilesVaultEngineFault(
        "corrupt_state",
        "Files content envelope does not match its node",
      );
    }
    const binding: FilesMetadataBinding = {
      nodeId: node.nodeId,
      parentId: node.parentId,
      nodeKind: node.kind,
      metadataRevision: node.metadataRevision,
      declaredNameScalars: node.declaredNameScalars,
      nameTag: node.nameTag,
    };
    const cacheKey = metadataCacheKey(binding, encryptedMetadata);
    let metadata = this.#metadataCache.get(cacheKey);
    let metadataBytes = 0;
    if (metadata === undefined) {
      const decrypted = expectWorker(
        await this.#crypto.call({
          type: "decrypt_metadata",
          binding,
          ciphertext: encryptedMetadata.slice(),
        }),
        "metadata_decrypted",
      );
      try {
        metadataBytes = decrypted.plaintext.byteLength;
        metadata = decodeFilesMetadata(decrypted.plaintext);
      } finally {
        decrypted.plaintext.fill(0);
      }
    }
    const root =
      node.nodeId.hi === "0" && node.nodeId.lo === "0";
    assertFilesMetadataBinding(metadata, {
      nodeKind: node.kind,
      declaredNameScalars: node.declaredNameScalars,
      root,
    });
    if (!root) {
      const tag = expectWorker(
        await this.#crypto.call({
          type: "name_tag",
          parentNodeId: node.parentId,
          filename: metadata.name,
        }),
        "name_tag",
      );
      if (!equalBytes(tag.nameTag, node.nameTag)) {
        throw new FilesVaultEngineFault(
          "corrupt_state",
          "Files private name does not match its blind tag",
        );
      }
    }
    if (!this.#metadataCache.has(cacheKey)) {
      this.#metadataCache.set(cacheKey, metadata, metadataBytes);
    }
    return Object.freeze({
      node,
      content,
      metadata,
      wrappedContentKey,
    });
  }

  async #reconcileVaultMutation(
    requestId: FilesId128V2,
    expectedRecordRevision: CanonicalNat64 | null,
    proposedRecordRevision: CanonicalNat64,
  ): Promise<boolean> {
    const outcome = await this.#backend.operationStatus({
      request_id: requestId,
      target: {
        vault: {
          expected_record_revision: expectedRecordRevision,
        },
      },
    });
    if (
      outcome.kind !== "ok" ||
      outcome.value.state === null ||
      !sameFilesId(outcome.value.request_id, requestId) ||
      outcome.value.target === null ||
      !("vault" in outcome.value.target) ||
      outcome.value.target.vault.expected_record_revision !==
        expectedRecordRevision
    ) {
      return false;
    }
    if (!("committed" in outcome.value.state)) return false;
    const detail = outcome.value.state.committed.detail;
    if (detail === null || !("vault" in detail)) {
      throw new FilesVaultEngineFault(
        "incompatible",
        "Files vault reconciliation omitted its exact receipt",
      );
    }
    return (
      sameFilesId(detail.vault.request_id, requestId) &&
      detail.vault.record_revision === proposedRecordRevision &&
      detail.vault.initialized === (expectedRecordRevision === null)
    );
  }

  #requireReady(): Extract<FilesVaultStatus, { state: "ready" }> {
    if (this.#committedViewRefreshPending !== null) {
      throw new FilesVaultEngineFault(
        "conflict",
        "Files is refreshing its committed view",
      );
    }
    if (this.#status.state !== "ready") {
      throw new FilesVaultEngineFault("needs_user_unlock");
    }
    return this.#status;
  }

  #markWorkerLocked(): void {
    this.#setWorkerLockedStatus();
    this.#notifyLock();
  }

  #setWorkerLockedStatus(): void {
    this.#metadataCache.clear();
    if (this.#status.state === "ready") {
      this.#status = Object.freeze({
        state: "locked",
        capacity: this.#status.capacity,
        record: this.#status.record,
        currentGeneration: this.#status.currentGeneration,
        previousGeneration: this.#status.previousGeneration,
        migrationRequired:
          this.#status.record.slotGeneration !==
          this.#status.currentGeneration,
      });
    }
  }

  async #fenceWorkerAfterFailure(): Promise<void> {
    await this.#crypto.call({ type: "lock" }).catch(() => undefined);
    this.#markWorkerLocked();
  }

  #enqueueLifecycle<Result>(
    operation: () => Result | Promise<Result>,
  ): Promise<Result> {
    const next = this.#lifecycleSerial.then(operation, operation);
    this.#lifecycleSerial = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  #notifyLock(): void {
    for (const listener of this.#lockListeners) {
      try {
        listener();
      } catch {
        // The worker's erased-key state is authoritative.
      }
    }
  }
}

function expectWorker<
  Type extends FilesCryptoWorkerResult["type"],
>(
  result: FilesCryptoWorkerResult,
  type: Type,
): Extract<FilesCryptoWorkerResult, { type: Type }> {
  if (result.type !== type) {
    throw new FilesVaultEngineFault(
      "corrupt_state",
      `Files worker returned ${result.type} instead of ${type}`,
    );
  }
  return result as Extract<FilesCryptoWorkerResult, { type: Type }>;
}

function expectOutcome<
  Value extends import("neutron-tools/app").JsonValue,
>(
  outcome: {
    kind: "ok";
    value: Value;
  } | {
    kind: "rejected";
    rejection: import("../protocol/types.ts").FilesRejectedV2;
  } | {
    kind: "unsupported";
  },
  label: string,
): Value {
  if (outcome.kind === "ok") return outcome.value;
  if (outcome.kind === "unsupported") {
    throw new FilesVaultEngineFault(
      "incompatible",
      `${label} is unsupported`,
    );
  }
  throw rejectedFault(label, outcome);
}

function rejectedFault(
  label: string,
  outcome: {
    kind: "rejected";
    rejection: import("../protocol/types.ts").FilesRejectedV2;
  },
): FilesVaultEngineFault {
  const reason = outcome.rejection.reason?.tag ?? "incompatible";
  const code =
    reason === "corrupt_state"
      ? "corrupt_state"
      : reason === "not_found"
        ? "not_found"
      : reason === "incompatible" || reason === "not_ready"
        ? "incompatible"
        : reason === "conflict" ||
            reason === "stale_revision" ||
            reason === "already_exists"
          ? "conflict"
          : "conflict";
  return new FilesVaultEngineFault(
    code,
    `${label} was rejected: ${reason}`,
  );
}

function vaultIsAbsent(ok: FilesBootstrapOkV2): boolean {
  return ok.vault !== null && "absent" in ok.vault;
}

function deriveCapacity(ok: FilesBootstrapOkV2): FilesCapacitySnapshot {
  const current = ok.public_usage.current;
  const limits = ok.public_usage.effective_limits;
  const meters = {
    rolling_entries: capacityMeter(
      addCapacityNat64(
        current.occupied_entry_slots,
        current.reserved_entry_slots,
      ),
      limits.entries,
    ),
    committed_bytes: capacityMeter(
      addCapacityNat64(
        current.committed_body_bytes,
        current.reserved_committed_body_bytes,
      ),
      limits.committed_bytes,
    ),
    staged_bytes: capacityMeter(
      addCapacityNat64(
        current.accepted_staged_bytes,
        current.reserved_staged_bytes,
      ),
      limits.staged_bytes,
    ),
    pending_stages: capacityMeter(
      current.active_stages,
      limits.pending_stages,
    ),
    rolling_general_receipts: capacityMeter(
      addCapacityNat64(
        current.general_receipt_lanes,
        current.reserved_general_receipt_lanes,
      ),
      limits.general_receipts,
    ),
    revocation_lanes: capacityMeter(
      addCapacityNat64(
        current.reserved_revocation_lanes,
        current.filled_revocation_lanes,
      ),
      limits.revocation_lanes,
    ),
  } as const;
  const dimensions = Object.keys(meters) as FilesPublicCapacityDimension[];
  let limiting = dimensions[0]!;
  for (const dimension of dimensions.slice(1)) {
    if (meterRatioGreater(meters[dimension], meters[limiting])) {
      limiting = dimension;
    }
  }
  return Object.freeze({
    privateQuota: Object.freeze({
      nodes: ok.quota.nodes,
      committedPlaintextBytes:
        ok.quota.committed_private_plaintext_bytes,
      committedCiphertextBytes:
        ok.quota.committed_ciphertext_bytes,
      stagedCiphertextBytes: ok.quota.staged_ciphertext_bytes,
      physicalBytes: ok.quota.physical_private_bytes,
      cleanupJobs: ok.quota.cleanup_jobs,
    }),
    public: Object.freeze({
      rollingEntries: meters.rolling_entries,
      committedBytes: meters.committed_bytes,
      stagedBytes: meters.staged_bytes,
      pendingStages: meters.pending_stages,
      rollingGeneralReceipts:
        meters.rolling_general_receipts,
      revocationLanes: meters.revocation_lanes,
      maxObjectBytes: limits.object_bytes,
      maxBatchOperations: limits.batch_operations,
      maxBatchBytes: limits.batch_bytes,
      limiting: Object.freeze({
        dimension: limiting,
        utilizationBasisPoints:
          meters[limiting].utilizationBasisPoints,
      }),
    }),
  });
}

function capacityMeter(
  usedInput: CanonicalNat64,
  limitInput: CanonicalNat64,
) {
  const used = BigInt(usedInput);
  const limit = BigInt(limitInput);
  const remaining = used >= limit ? 0n : limit - used;
  const ratio =
    limit === 0n
      ? used === 0n
        ? 0n
        : BigInt(Number.MAX_SAFE_INTEGER)
      : (used * 10_000n) / limit;
  return Object.freeze({
    used: usedInput,
    limit: limitInput,
    remaining: remaining.toString() as CanonicalNat64,
    utilizationBasisPoints: Number(
      ratio > BigInt(Number.MAX_SAFE_INTEGER)
        ? BigInt(Number.MAX_SAFE_INTEGER)
        : ratio,
    ),
  });
}

function addCapacityNat64(
  leftInput: CanonicalNat64,
  rightInput: CanonicalNat64,
): CanonicalNat64 {
  const sum = BigInt(leftInput) + BigInt(rightInput);
  if (sum > 0xffff_ffff_ffff_ffffn) {
    throw new FilesVaultEngineFault(
      "corrupt_state",
      "Files public capacity counters overflow Nat64",
    );
  }
  return sum.toString() as CanonicalNat64;
}

function meterRatioGreater(
  left: { used: CanonicalNat64; limit: CanonicalNat64 },
  right: { used: CanonicalNat64; limit: CanonicalNat64 },
): boolean {
  const leftUsed = BigInt(left.used);
  const leftLimit = BigInt(left.limit);
  const rightUsed = BigInt(right.used);
  const rightLimit = BigInt(right.limit);
  if (leftLimit === 0n || rightLimit === 0n) {
    if (leftLimit === 0n && rightLimit === 0n) {
      return leftUsed > rightUsed;
    }
    return leftLimit === 0n && leftUsed > 0n;
  }
  return leftUsed * rightLimit > rightUsed * leftLimit;
}

function rootMetadataBinding(
  revision: string,
): FilesMetadataBinding {
  return {
    nodeId: FILES_ROOT_ID,
    parentId: FILES_ROOT_ID,
    nodeKind: "folder",
    metadataRevision: revision,
    declaredNameScalars: 0,
    nameTag: new Uint8Array(32),
  };
}

function publicInfoToWorker(
  info: VetKeyPublicInfo,
): FilesVetKeyPublicInfo {
  if (
    info.slot !== FILES_VETKEY_SLOT ||
    info.suite !== "bls12_381_g2" ||
    (info.keyName !== "key_1" && info.keyName !== "test_key_1") ||
    !/^[1-9][0-9]{0,19}$/u.test(info.generation) ||
    BigInt(info.generation) > 0xffff_ffff_ffff_ffffn
  ) {
    throw new FilesVaultEngineFault("capability_changed");
  }
  const principal = Principal.fromText(info.canisterPrincipal);
  const principalBytes = principal.toUint8Array();
  const publicKey = Uint8Array.from(info.publicKey);
  const publicFingerprint = Uint8Array.from(info.publicFingerprint);
  const derivationInput = Uint8Array.from(info.derivationInput);
  if (
    principalBytes.byteLength < 1 ||
    principalBytes.byteLength > 29 ||
    publicKey.byteLength !== 96 ||
    publicFingerprint.byteLength !== 32 ||
    derivationInput.byteLength !== 32
  ) {
    throw new FilesVaultEngineFault("capability_changed");
  }
  return {
    canisterPrincipal: info.canisterPrincipal,
    canisterPrincipalBytes: principalBytes,
    slot: FILES_VETKEY_SLOT,
    generation: info.generation,
    suite: "bls12_381_g2",
    keyName: info.keyName,
    publicKey,
    publicFingerprint,
    derivationInput,
  };
}

function assertSamePublicInfo(
  actual: VetKeyPublicInfo,
  expected: FilesVetKeyPublicInfo,
): void {
  const normalized = publicInfoToWorker(actual);
  if (
    normalized.canisterPrincipal !== expected.canisterPrincipal ||
    normalized.generation !== expected.generation ||
    normalized.keyName !== expected.keyName ||
    !equalBytes(normalized.publicKey, expected.publicKey) ||
    !equalBytes(
      normalized.publicFingerprint,
      expected.publicFingerprint,
    ) ||
    !equalBytes(
      normalized.derivationInput,
      expected.derivationInput,
    )
  ) {
    throw new FilesVaultEngineFault("capability_changed");
  }
}

function committedVault(record: FilesVaultRecord): FilesCommittedVault {
  return {
    context: {
      neutronCanisterPrincipalBytes:
        record.context.neutronCanisterPrincipalBytes.slice(),
      vaultId: record.context.vaultId.slice(),
      vaultSalt: record.context.vaultSalt.slice(),
    },
    rootCommitment: record.rootCommitment.slice(),
    wrapper: {
      generation: record.slotGeneration,
      publicKeyFingerprint: record.publicKeyFingerprint.slice(),
      ciphertext: record.wrapperCiphertext.slice(),
    },
  };
}

function vaultPublicCacheDescriptor(
  record: FilesVaultRecord,
): Omit<FilesVaultPublicCacheDescriptor, "keyName"> {
  return {
    generation: record.slotGeneration,
    publicKeyFingerprint: record.publicKeyFingerprint.slice(),
    vaultId: record.context.vaultId.slice(),
    vaultSalt: record.context.vaultSalt.slice(),
    rootCommitment: record.rootCommitment.slice(),
    wrapperCiphertext: record.wrapperCiphertext.slice(),
  };
}

async function withNativeFilesVaultUnlockLock<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  const locks =
    typeof navigator === "undefined"
      ? undefined
      : navigator.locks;
  if (!locks || typeof locks.request !== "function") {
    return operation();
  }
  return locks.request(
    "neutron:files:vault-unlock:v1",
    { mode: "exclusive" },
    operation,
  );
}

function sameListCursor(
  left: FilesListCursorV2 | null,
  right: FilesListCursorV2 | null,
): boolean {
  return (
    (left === null && right === null) ||
    (left !== null &&
      right !== null &&
      sameFilesId(left.parent_id, right.parent_id) &&
      left.children_revision === right.children_revision &&
      sameFilesDigest(left.last_name_tag, right.last_name_tag))
  );
}

function sameNodeOuterBinding(
  outer: FilesNodeBindingV2,
  inner: FilesNodeRecord["node"],
  encryptedMetadataBytes: number,
): boolean {
  const kind =
    outer.kind === null
      ? null
      : "folder" in outer.kind
        ? "folder"
        : "file" in outer.kind
          ? "file"
          : null;
  return (
    kind === inner.kind &&
    sameFilesId(outer.node_id, inner.nodeId) &&
    sameFilesId(outer.parent_id, inner.parentId) &&
    outer.structural_revision === inner.structuralRevision &&
    outer.metadata_revision === inner.metadataRevision &&
    outer.children_revision === inner.childrenRevision &&
    outer.declared_name_scalars === inner.declaredNameScalars &&
    outer.subtree_height === inner.subtreeHeight &&
    outer.max_relative_path_scalars ===
      inner.maxRelativePathScalars &&
    outer.subtree_plaintext_bytes === inner.subtreePlaintextBytes &&
    outer.encrypted_metadata_bytes === encryptedMetadataBytes &&
    outer.active
  );
}

function sameContentOuterBinding(
  outer: import("../protocol/types.ts").FilesContentDescriptorV2 | null,
  inner: FilesNodeRecord["content"],
): boolean {
  if (outer === null || inner === null) return outer === null && inner === null;
  return (
    sameFilesId(outer.content_id, inner.contentId) &&
    outer.block_count === inner.blockCount &&
    outer.ciphertext_bytes === inner.ciphertextBytes &&
    outer.crypto_profile !== null &&
    "aes_256_gcm_files_v2" in outer.crypto_profile
  );
}

function metadataCacheKey(
  binding: FilesMetadataBinding,
  encryptedMetadata: Uint8Array,
): string {
  const ciphertextHash = nobleSha256(encryptedMetadata);
  try {
    return [
      binding.nodeId.hi,
      binding.nodeId.lo,
      binding.parentId.hi,
      binding.parentId.lo,
      binding.nodeKind,
      binding.metadataRevision,
      binding.declaredNameScalars.toString(),
      hexBytes(binding.nameTag),
      hexBytes(ciphertextHash),
    ].join(":");
  } finally {
    ciphertextHash.fill(0);
  }
}

function hexBytes(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) {
    output += byte.toString(16).padStart(2, "0");
  }
  return output;
}

export type { CanonicalFilesPath, FilesPrivateMetadata };
