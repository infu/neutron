import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { FilesCryptoWorkerClient } from "../crypto/worker_client.ts";
import { planPrivateBlocks } from "../crypto/private_files.ts";
import {
  FILES_AES_GCM_TAG_BYTES,
  type FilesMetadataBinding,
} from "../crypto/types.ts";
import { FilesBackendAdapter } from "../protocol/backend_adapter.ts";
import { FILES_V2_LIMITS } from "../protocol/constants.ts";
import { filesId128ToKey } from "../protocol/ids.ts";
import type {
  CanonicalNat64,
  FilesBootstrapOkV2,
  FilesId128V2,
  FilesListCursorV2,
  FilesOperationSummaryV2,
  FilesPublicUsageCountersV2,
  FilesPublicUsageLimitsV2,
} from "../protocol/types.ts";
import {
  FilesServiceFault,
  type FilesResidentFilePort,
  type FilesServiceEntry,
  type FilesServiceFile,
  type FilesServiceListPage,
  type FilesServiceMutationResult,
  type FilesServiceRemovePrecondition,
  type FilesServicePublicUsage,
  type FilesServiceStatus,
  type FilesServiceTransfer,
  type FilesServiceWriteResult,
} from "../resident/service_contract.ts";
import type { FilesAuthorityResetReason } from "../resident/authority.ts";
import type { FilesMutateFrameInput } from "./frame_codec.ts";
import {
  filesId128ToBytes,
  incrementFilesRevision,
  randomFilesNodeId,
  randomFilesRequestId,
  sameFilesId,
} from "./ids.ts";
import {
  encodeFilesMetadata,
  validateFilesMetadata,
} from "./metadata.ts";
import {
  canonicalizeFilesPath,
  unicodeScalarCount,
  validateFilesName,
} from "./paths.ts";
import {
  abortFilesStage,
  FilesTransferEngine,
  FilesTransferEngineFault,
} from "./transfer_engine.ts";
import type {
  FilesBackendPort,
  FilesCryptoPort,
  FilesFileMetadata,
  FilesFolderAggregateTransition,
  FilesFolderMetadata,
  FilesFrameNodeSummary,
  FilesNodeRecord,
  FilesNodeTransition,
  FilesPrivateWritePlan,
  FilesTransferControls,
  FilesTransferPhase,
  FilesTransferSource,
  FilesVaultStatus,
  FilesVetKeysPort,
  FilesWriteItem,
  FilesWriteReceipt,
} from "./types.ts";
import {
  FILES_ROOT_ID,
} from "./types.ts";
import {
  FilesVaultEngine,
  FilesVaultEngineFault,
} from "./vault_engine.ts";

const ZERO = "0" as CanonicalNat64;
const UPLOAD_CHUNK_BYTES = FILES_V2_LIMITS.normalPlaintextBlockBytes;
const MAX_ID_COLLISION_ATTEMPTS = 3;
const PRIVATE_PHYSICAL_CAP_BYTES = 134_217_728n;
const MAX_TERMINAL_TRANSFER_ROWS = 128;
const MAX_PRE_CANCELLED_TRANSFERS = 128;
const PRE_CANCEL_TTL_MS = 60_000;
const TRANSFER_ID_PATTERN = /^[A-Za-z0-9_-]{1,96}$/u;
const EMPTY_TRANSFER_SOURCE: FilesTransferSource = Object.freeze({
  size: 0,
  slice: () => new Uint8Array(),
});
const EMPTY_PUBLIC_USAGE: FilesServicePublicUsage = Object.freeze({
  current: zeroPublicCounters(),
  manifestLimits: zeroPublicLimits(),
  effectiveLimits: zeroPublicLimits(),
});

export type FilesResidentCursor =
  | Readonly<{
      mode: "direct";
      backend: FilesListCursorV2;
    }>
  | Readonly<{
      mode: "recursive";
      rootRevision: CanonicalNat64;
      stack: readonly Readonly<{
        path: string;
        nodeId: FilesId128V2;
        structuralRevision: CanonicalNat64;
        backend: FilesListCursorV2 | null;
      }>[];
    }>;

export type DefaultFilesResidentPortDependencies = Readonly<{
  backend?: FilesBackendPort;
  createCrypto?: () => FilesCryptoWorkerClient;
  vetkeys?: FilesVetKeysPort;
}>;

type ResidentRuntime = {
  generation: number;
  crypto: FilesCryptoWorkerClient;
  vault: FilesVaultEngine;
  transfer: FilesTransferEngine;
  unsubscribeLock: () => void;
  committedViewStale: boolean;
  refreshPending: Promise<void> | null;
};

type UploadSession = {
  id: string;
  path: string;
  name: string;
  mediaType: string;
  totalBytes: number;
  hash: ReturnType<typeof nobleSha256.create>;
  hashBytes: number;
  nextHashOrdinal: number;
  digest: Uint8Array | null;
  source: SequentialUploadSource | null;
  nextEncryptOrdinal: number;
  encryptBytes: number;
  controller: AbortController;
  promise: Promise<FilesServiceWriteResult> | null;
  result: FilesServiceWriteResult | null;
  phase: FilesTransferPhase;
  error: string | null;
  runtimeGeneration: number;
};

type TrackedReadSession = {
  id: string;
  label: string;
  totalBytes: number;
  processedBytes: number;
  controller: AbortController;
  detachParentAbort: () => void;
  promise: Promise<FilesServiceFile> | null;
  error: string | null;
};

type TrackedWriteSession = {
  id: string;
  label: string;
  totalBytes: number;
  processedBytes: number;
  controller: AbortController;
  detachParentAbort: () => void;
  promise: Promise<FilesServiceWriteResult> | null;
  error: string | null;
};

type ResidentWriteInput = {
  transferId?: string;
  path: string;
  source: FilesTransferSource;
  contentKind: "text" | "binary";
  mediaType: string;
  ifMatch: string | null;
  ifNoneMatch: boolean;
  createParents: boolean;
};

type UntrackedResidentWriteInput = Omit<ResidentWriteInput, "transferId">;

type RecoveryOperation = Readonly<{
  transferId: string;
  summary: FilesOperationSummaryV2;
}>;

/**
 * Production path-oriented adapter. Construction is deliberately inert:
 * Worker creation and every self-call are deferred until a method is used.
 */
export class DefaultFilesResidentPort
  implements FilesResidentFilePort<FilesResidentCursor> {
  readonly #backend: FilesBackendPort;
  readonly #createCrypto: () => FilesCryptoWorkerClient;
  readonly #vetkeys: FilesVetKeysPort | undefined;
  readonly #lockListeners =
    new Set<(reason?: "inactivity" | "worker_failure") => void>();
  readonly #statusListeners =
    new Set<(
      reason:
        | "inactivity"
        | "worker_failure"
        | "authority_changed"
        | "state_changed",
    ) => void>();
  readonly #uploads = new Map<string, UploadSession>();
  readonly #activeReads = new Map<string, TrackedReadSession>();
  readonly #activeWrites = new Map<string, TrackedWriteSession>();
  readonly #transfers = new Map<string, FilesServiceTransfer>();
  readonly #recoveries = new Map<string, RecoveryOperation>();
  readonly #preCancelled = new Map<string, number>();
  #runtime: ResidentRuntime | null = null;
  #runtimePending: Promise<ResidentRuntime> | null = null;
  #runtimeGeneration = 0;
  #dropping = false;
  #explicitLock = false;
  #lockEpoch = 0n;
  #lockedReason:
    | "inactivity"
    | "explicit"
    | "worker_failure"
    | "authority_changed"
    | null = null;
  #lastBootstrap: FilesBootstrapOkV2 | null = null;

  constructor(dependencies: DefaultFilesResidentPortDependencies = {}) {
    this.#backend = dependencies.backend ?? new FilesBackendAdapter();
    this.#createCrypto =
      dependencies.createCrypto ?? (() => new FilesCryptoWorkerClient());
    this.#vetkeys = dependencies.vetkeys;
  }

  onLock(
    listener: (reason?: "inactivity" | "worker_failure") => void,
  ): () => void {
    this.#lockListeners.add(listener);
    return () => this.#lockListeners.delete(listener);
  }

  onStatusChange(
    listener: (
      reason:
        | "inactivity"
        | "worker_failure"
        | "authority_changed"
        | "state_changed",
    ) => void,
  ): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  async status(): Promise<FilesServiceStatus> {
    const bootstrap = await this.#readBootstrap();
    return this.#renderStatus(bootstrap);
  }

  async initialize(): Promise<FilesServiceStatus> {
    const runtime = await this.#getRuntime();
    await runtime.vault.bootstrap({
      initializeIfAbsent: true,
      unlock: true,
    });
    this.#lockedReason = null;
    const bootstrap = await this.#readBootstrap();
    return this.#renderStatus(bootstrap);
  }

  async unlock(): Promise<FilesServiceStatus> {
    const runtime = await this.#getRuntime();
    if (runtime.vault.status().state === "uninitialized") {
      await runtime.vault.bootstrap({
        initializeIfAbsent: false,
        unlock: false,
      });
    }
    await runtime.vault.unlock();
    this.#lockedReason = null;
    const bootstrap = await this.#readBootstrap();
    return this.#renderStatus(bootstrap);
  }

  async lock(): Promise<FilesServiceStatus> {
    this.#explicitLock = true;
    try {
      this.#clearUploadSessions(new Error("Files vault locked"));
      this.#dropRuntime();
      this.#advanceLockEpoch();
      this.#lockedReason = "explicit";
    } finally {
      this.#explicitLock = false;
    }
    const bootstrap = await this.#readBootstrap();
    return this.#renderStatus(bootstrap);
  }

  async rotate(): Promise<FilesServiceStatus> {
    const runtime = await this.#getRuntime();
    await runtime.vault.bootstrap({
      initializeIfAbsent: false,
      unlock: true,
    });
    this.#lockedReason = null;
    const bootstrap = await this.#readBootstrap();
    return this.#renderStatus(bootstrap);
  }

  async list(input: {
    path: string;
    cursor: FilesResidentCursor | null;
    expectedFolderRevision: CanonicalNat64 | null;
    limit: number;
    recursive: boolean;
    signal?: AbortSignal;
  }): Promise<FilesServiceListPage<FilesResidentCursor>> {
    throwIfAborted(input.signal);
    const runtime = await this.#readyRuntime();
    const canonical = canonicalizeFilesPath(input.path);
    const folder = await runtime.vault.lookupPath(canonical.path);
    this.#assertRuntimeCurrent(runtime);
    if (folder.node.kind !== "folder") {
      throw serviceFault("conflict", "Files path is not a folder");
    }
    if (
      input.expectedFolderRevision !== null &&
      folder.node.structuralRevision !== input.expectedFolderRevision
    ) {
      throw serviceFault("conflict", "Files folder changed during paging");
    }
    if (input.recursive) {
      if (input.cursor !== null && input.cursor.mode !== "recursive") {
        throw serviceFault("invalid", "Files recursive cursor is invalid");
      }
      const cursor =
        input.cursor?.mode === "recursive" ? input.cursor : null;
      const rootRevision = cursor?.rootRevision ??
        folder.node.structuralRevision;
      if (
        rootRevision !== folder.node.structuralRevision ||
        (input.expectedFolderRevision !== null &&
          input.expectedFolderRevision !== rootRevision)
      ) {
        throw serviceFault("conflict", "Files recursive root changed");
      }
      const stack = cursor
        ? cursor.stack.map((frame) => ({ ...frame }))
        : [{
            path: canonical.path,
            nodeId: folder.node.nodeId,
            structuralRevision: folder.node.structuralRevision,
            backend: null,
          }];
      if (stack.length < 1 || stack.length > FILES_V2_LIMITS.treeDepth + 1) {
        throw serviceFault("invalid", "Files recursive cursor depth is invalid");
      }
      const entries: FilesServiceEntry[] = [];
      const knownFolders = new Map<string, FilesNodeRecord>([
        [filesId128ToKey(folder.node.nodeId), folder],
      ]);
      let operations = 0;
      const operationLimit =
        input.limit * 2 + FILES_V2_LIMITS.treeDepth + 1;
      while (
        entries.length < input.limit &&
        stack.length > 0 &&
        operations < operationLimit
      ) {
        throwIfAborted(input.signal);
        const frame = stack[stack.length - 1]!;
        const frameKey = filesId128ToKey(frame.nodeId);
        let currentFolder = knownFolders.get(frameKey);
        if (currentFolder === undefined) {
          currentFolder = await runtime.vault.lookupNode(frame.nodeId);
          this.#assertRuntimeCurrent(runtime);
          knownFolders.set(frameKey, currentFolder);
          operations += 1;
        }
        if (
          currentFolder.node.kind !== "folder" ||
          currentFolder.node.structuralRevision !==
            frame.structuralRevision
        ) {
          throw serviceFault(
            "conflict",
            "Files recursive cursor folder changed",
          );
        }
        const page = await runtime.vault.listFolder(currentFolder, {
          cursor: frame.backend,
          limit: 1,
        });
        this.#assertRuntimeCurrent(runtime);
        operations += 1;
        if (page.items.length > 1) {
          throw serviceFault(
            "incompatible",
            "Files recursive one-child page exceeded its bound",
          );
        }
        if (page.hasMore) {
          if (page.nextCursor === null) {
            throw serviceFault(
              "incompatible",
              "Files recursive page omitted its continuation",
            );
          }
          frame.backend = page.nextCursor;
        } else {
          stack.pop();
        }
        const item = page.items[0];
        if (!item) continue;
        const itemPath = joinPath(frame.path, item.metadata.name);
        entries.push(serviceEntry(itemPath, item));
        if (item.node.kind === "folder") {
          const depth =
            canonicalizeFilesPath(itemPath).segments.length;
          if (depth > FILES_V2_LIMITS.treeDepth) {
            throw serviceFault(
              "incompatible",
              "Files recursive result exceeds maximum depth",
            );
          }
          stack.push({
            path: itemPath,
            nodeId: item.node.nodeId,
            structuralRevision: item.node.structuralRevision,
            backend: null,
          });
          knownFolders.set(filesId128ToKey(item.node.nodeId), item);
        }
      }
      const nextCursor: FilesResidentCursor | null =
        stack.length === 0
          ? null
          : Object.freeze({
              mode: "recursive",
              rootRevision,
              stack: Object.freeze(
                stack.map((frame) => Object.freeze({ ...frame })),
              ),
            });
      return Object.freeze({
        path: canonical.path,
        folderRevision: rootRevision,
        entries: Object.freeze(entries),
        // Recursive traversal has no width scan or stored global count. This
        // is the exact number returned in this page; hasMore/cursor describe
        // the remaining DFS continuation.
        total: entries.length,
        cursor: nextCursor,
        hasMore: nextCursor !== null,
      });
    }
    if (input.cursor !== null && input.cursor.mode !== "direct") {
      throw serviceFault("invalid", "Files direct cursor is invalid");
    }
    const page = await runtime.vault.listFolder(folder, {
      cursor: input.cursor?.mode === "direct"
        ? input.cursor.backend
        : null,
      limit: input.limit,
    });
    this.#assertRuntimeCurrent(runtime);
    const entries = page.items
      .map((item) =>
        serviceEntry(joinPath(canonical.path, item.metadata.name), item)
      )
      .sort(compareServiceEntriesByDecryptedName);
    return Object.freeze({
      path: canonical.path,
      folderRevision: page.structuralRevision,
      entries: Object.freeze(entries),
      total: page.totalChildren,
      cursor:
        page.nextCursor === null
          ? null
          : Object.freeze({ mode: "direct", backend: page.nextCursor }),
      hasMore: page.hasMore,
    });
  }

  async stat(path: string, signal?: AbortSignal): Promise<FilesServiceEntry> {
    throwIfAborted(signal);
    const runtime = await this.#readyRuntime();
    const canonical = canonicalizeFilesPath(path);
    const node = await runtime.vault.lookupPath(canonical.path);
    this.#assertRuntimeCurrent(runtime);
    return serviceEntry(canonical.path, node);
  }

  async read(
    path: string,
    controls: FilesTransferControls & Readonly<{
      transferId?: string;
    }> = {},
  ): Promise<FilesServiceFile> {
    const canonical = canonicalizeFilesPath(path);
    if (controls.transferId === undefined) {
      return this.#readNow(canonical.path, controls);
    }
    const transferId = controls.transferId;
    const label = canonical.segments.at(-1) ?? canonical.path;
    if (!this.#claimTransferId(transferId, label, 0)) {
      throw serviceFault("cancelled", "Files read was cancelled before it started");
    }
    const controller = new AbortController();
    const detachParentAbort = linkAbortSignal(
      controls.signal,
      controller,
    );
    const session: TrackedReadSession = {
      id: transferId,
      label,
      totalBytes: 0,
      processedBytes: 0,
      controller,
      detachParentAbort,
      promise: null,
      error: null,
    };
    this.#activeReads.set(transferId, session);
    this.#recordReadTransfer(session, "queued");
    const operation = this.#executeTrackedRead(
      session,
      canonical.path,
      controls,
    ).finally(() => {
      session.detachParentAbort();
      if (this.#activeReads.get(transferId) === session) {
        this.#activeReads.delete(transferId);
      }
      this.#pruneTerminalTransfers();
    });
    session.promise = operation;
    return operation;
  }

  async #readNow(
    path: string,
    controls: FilesTransferControls = {},
  ): Promise<FilesServiceFile> {
    throwIfAborted(controls.signal);
    const runtime = await this.#readyRuntime();
    const node = await runtime.vault.lookupPath(path);
    this.#assertRuntimeCurrent(runtime);
    if (node.metadata.nodeKind !== "file" || node.content === null) {
      throw serviceFault("not_found", "Files path is not a readable file");
    }
    const result = await runtime.transfer.readPrivate({
      nodeId: node.node.nodeId,
      structuralRevision: node.node.structuralRevision,
      contentId: node.content.contentId,
    }, controls);
    this.#assertRuntimeCurrent(runtime);
    return Object.freeze({
      entry: serviceEntry(path, node) as
        FilesServiceEntry & { type: "file"; byteLength: number },
      bytes: result.bytes,
    });
  }

  async write(
    input: ResidentWriteInput,
    controls: FilesTransferControls = {},
  ): Promise<FilesServiceWriteResult> {
    if (input.transferId !== undefined) {
      const { transferId, ...untracked } = input;
      return this.#writeTracked(transferId, untracked, controls);
    }
    return this.#writeNow(input, controls);
  }

  async #writeNow(
    input: UntrackedResidentWriteInput,
    controls: FilesTransferControls = {},
  ): Promise<FilesServiceWriteResult> {
    const runtime = await this.#readyRuntime();
    const digest = await hashSourceForPlan(
      input.source,
      input.contentKind === "text",
      controls,
    );
    try {
      const canonicalPath = canonicalizeFilesPath(input.path).path;
      const { plan, receipt } = await this.#commitReplayableWrite(
        runtime,
        () => this.#planWrite(runtime, input, digest),
        [digest],
        controls,
      );
      const file = plan.items.find(
        (item) => item.metadata.nodeKind === "file",
      );
      if (!file || file.metadata.nodeKind !== "file") {
        throw serviceFault(
          "incompatible",
          "Files committed write omitted its file plan",
        );
      }
      return committedWriteResult(canonicalPath, file, receipt);
    } finally {
      digest.fill(0);
    }
  }

  #writeTracked(
    transferId: string,
    input: UntrackedResidentWriteInput,
    controls: FilesTransferControls,
  ): Promise<FilesServiceWriteResult> {
    const canonical = canonicalizeFilesPath(input.path);
    const label = canonical.segments.at(-1) ?? canonical.path;
    if (!this.#claimTransferId(transferId, label, input.source.size)) {
      return Promise.reject(
        serviceFault("cancelled", "Files write was cancelled before it started"),
      );
    }
    const controller = new AbortController();
    const detachParentAbort = linkAbortSignal(
      controls.signal,
      controller,
    );
    const session: TrackedWriteSession = {
      id: transferId,
      label,
      totalBytes: input.source.size,
      processedBytes: 0,
      controller,
      detachParentAbort,
      promise: null,
      error: null,
    };
    this.#activeWrites.set(transferId, session);
    this.#recordWriteTransfer(session, "queued");
    const operation = this.#executeTrackedWrite(
      session,
      { ...input, path: canonical.path },
      controls,
    ).finally(() => {
      session.detachParentAbort();
      if (this.#activeWrites.get(transferId) === session) {
        this.#activeWrites.delete(transferId);
      }
      this.#pruneTerminalTransfers();
    });
    session.promise = operation;
    return operation;
  }

  async writeMany(
    input: readonly {
      path: string;
      text: string;
      overwrite: boolean;
      createParents: boolean;
      mediaType: string;
    }[],
    controls: FilesTransferControls = {},
  ): Promise<readonly FilesServiceWriteResult[]> {
    if (input.length < 1 || input.length > 20) {
      throw serviceFault("limit", "Files batch must contain 1 to 20 files");
    }
    const runtime = await this.#readyRuntime();
    const sources = input.map((item) => {
      const bytes = new TextEncoder().encode(item.text);
      return { item, bytes, source: bytesSource(bytes) };
    });
    const digests: Uint8Array[] = [];
    try {
      const total = sources.reduce(
        (sum, item) => sum + item.bytes.byteLength,
        0,
      );
      if (total > 10 * 1024 * 1024) {
        throw serviceFault("limit", "Files batch exceeds 10 MiB");
      }
      const paths = sources.map(({ item }) =>
        canonicalizeFilesPath(item.path).path
      );
      if (new Set(paths).size !== paths.length) {
        throw serviceFault("invalid", "Files batch contains duplicate paths");
      }
      for (const source of sources) {
        digests.push(await hashSourceForPlan(source.source, true, controls));
      }
      const { plan, receipt } = await this.#commitReplayableWrite(
        runtime,
        () => this.#planBatch(runtime, sources, digests, "batch"),
        digests,
        controls,
      );
      const files = plan.items.filter(
        (item): item is typeof item & { metadata: FilesFileMetadata } =>
          item.metadata.nodeKind === "file",
      );
      if (files.length !== paths.length) {
        throw serviceFault(
          "incompatible",
          "Files committed batch omitted its file plan",
        );
      }
      return Object.freeze(
        paths.map((path, index) =>
          committedWriteResult(path, files[index]!, receipt)
        ),
      );
    } finally {
      for (const digest of digests) digest.fill(0);
      for (const source of sources) source.bytes.fill(0);
    }
  }

  async mkdir(
    path: string,
    recursive: boolean,
    signal?: AbortSignal,
  ): Promise<FilesServiceMutationResult> {
    throwIfAborted(signal);
    const runtime = await this.#readyRuntime();
    const canonical = canonicalizeFilesPath(path);
    if (canonical.segments.length === 0) {
      return mutationResult(canonical.path, runtime.vault.status(), 0, false);
    }
    let changed = 0;
    const end = recursive ? canonical.segments.length : 1;
    const start = recursive ? 1 : canonical.segments.length;
    for (let depth = start; depth <= (recursive ? end : start); depth += 1) {
      const next = `/${canonical.segments.slice(0, depth).join("/")}`;
      const existing = await lookupMaybe(runtime.vault, next);
      if (existing) {
        if (existing.node.kind !== "folder") {
          throw serviceFault("conflict", "Files path prefix is a file");
        }
        continue;
      }
      await this.#createFolder(runtime, next);
      changed += 1;
    }
    const node = await runtime.vault.lookupPath(canonical.path);
    return Object.freeze({
      path: canonical.path,
      structuralRevision: node.node.structuralRevision,
      changed,
      cleanupPending: false,
    });
  }

  async move(
    from: string,
    to: string,
    overwrite: boolean,
    signal?: AbortSignal,
  ): Promise<FilesServiceMutationResult> {
    throwIfAborted(signal);
    if (overwrite) {
      throw serviceFault(
        "invalid",
        "Atomic overwrite move is unavailable for this vault version",
      );
    }
    const runtime = await this.#readyRuntime();
    const sourcePath = canonicalizeFilesPath(from);
    const targetPath = canonicalizeFilesPath(to);
    const source = await runtime.vault.lookupPath(sourcePath.path);
    if (await lookupMaybe(runtime.vault, targetPath.path)) {
      throw serviceFault("conflict", "Files move target already exists");
    }
    const targetChain = await pathChain(
      runtime.vault,
      parentPath(targetPath.path),
    );
    const sourceChain = await pathChain(
      runtime.vault,
      parentPath(sourcePath.path),
    );
    const targetParent = targetChain[targetChain.length - 1]!;
    const name = targetPath.segments.at(-1)!;
    const nameTag = await workerNameTag(
      runtime.crypto,
      targetParent.node.nodeId,
      name,
    );
    const now = nowNat64();
    const metadata = renameMetadata(source.metadata, name, now);
    const transition = transitionFromNode(source, {
      proposedParentId: targetParent.node.nodeId,
      proposedNameTag: nameTag,
      declaredNameScalars: unicodeScalarCount(name),
      proposedMaxRelativePathScalars:
        source.node.maxRelativePathScalars -
        unicodeScalarCount(source.metadata.name) +
        unicodeScalarCount(name),
      proposedStructuralRevision:
        incrementFilesRevision(source.node.structuralRevision),
      proposedMetadataRevision:
        incrementFilesRevision(source.node.metadataRevision),
    });
    const encryptedMetadata = await encryptNodeMetadata(
      runtime.crypto,
      transition,
      metadata,
    );
    const requestId = randomFilesRequestId();
    const affectedAncestors = new Map<string, AggregateAccumulator>();
    accumulateAggregateChange(
      affectedAncestors,
      sourceChain,
      0,
      true,
      source.metadata.name,
      source.node.subtreeHeight,
      source.node.maxRelativePathScalars,
    );
    accumulateAggregateChange(
      affectedAncestors,
      targetChain,
      0,
      true,
      name,
      source.node.subtreeHeight,
      source.node.maxRelativePathScalars,
    );
    const mutation: FilesMutateFrameInput = {
      requestId,
      action: sameFilesId(
          source.node.parentId,
          targetParent.node.nodeId,
        )
        ? "rename"
        : "move",
      node: transition,
      encryptedMetadata,
      folderTransitions: finalizeAggregateTransitions(
        affectedAncestors,
      ),
      childIndexTransitions: [
        {
          parentId: source.node.parentId,
          nameTag: source.node.nameTag,
          expectedNodeId: source.node.nodeId,
          proposedNodeId: null,
        },
        {
          parentId: targetParent.node.nodeId,
          nameTag,
          expectedNodeId: null,
          proposedNodeId: source.node.nodeId,
        },
      ],
    };
    const ok = await runtime.transfer.mutate(mutation);
    await runtime.vault.refreshCommittedView();
    return Object.freeze({
      path: targetPath.path,
      structuralRevision: ok.structural_revision,
      changed: 1,
      cleanupPending: false,
    });
  }

  async remove(
    path: string,
    recursive: boolean,
    signal?: AbortSignal,
    precondition?: FilesServiceRemovePrecondition,
  ): Promise<FilesServiceMutationResult> {
    throwIfAborted(signal);
    const runtime = await this.#readyRuntime();
    const canonical = canonicalizeFilesPath(path);
    const node = await runtime.vault.lookupPath(canonical.path);
    if (
      precondition !== undefined &&
      (
        (
          precondition.opaqueNodeIdentity !== undefined &&
          filesId128ToKey(node.node.nodeId) !==
            precondition.opaqueNodeIdentity
        ) ||
        node.node.structuralRevision !== precondition.structuralRevision ||
        (
          precondition.etagSha256 !== null &&
          (
            node.metadata.nodeKind !== "file" ||
            digestHex(node.metadata.plaintextSha256) !==
              precondition.etagSha256
          )
        )
      )
    ) {
      throw serviceFault(
        "conflict",
        "The source changed while it was being moved",
      );
    }
    if (sameFilesId(node.node.nodeId, FILES_ROOT_ID)) {
      throw serviceFault("invalid", "The Files root cannot be removed");
    }
    const parent = await runtime.vault.lookupNode(node.node.parentId);
    const ok = await runtime.transfer.remove({
      request_id: randomFilesRequestId(),
      node_id: node.node.nodeId,
      expected_structural_revision: node.node.structuralRevision,
      expected_parent_id: parent.node.nodeId,
      expected_parent_children_revision: parent.node.childrenRevision,
      recursive,
    }, signal);
    await runtime.vault.refreshCommittedView();
    const updatedParent = await runtime.vault.lookupNode(
      parent.node.nodeId,
    );
    return Object.freeze({
      path: canonical.path,
      structuralRevision: updatedParent.node.structuralRevision,
      changed: ok.reclaimed_entries,
      cleanupPending: cleanupPending(ok.cleanup_state),
    });
  }

  async cancel(transferId: string): Promise<FilesServiceStatus> {
    this.#assertTransferId(transferId);
    const activeRead = this.#activeReads.get(transferId);
    if (activeRead) {
      activeRead.controller.abort();
      try {
        await activeRead.promise;
      } catch {
        // The tracked read records its authoritative terminal phase.
      }
      return this.status();
    }
    const activeWrite = this.#activeWrites.get(transferId);
    if (activeWrite) {
      activeWrite.controller.abort();
      try {
        await activeWrite.promise;
      } catch {
        // The tracked write records its authoritative terminal phase.
      }
      return this.status();
    }
    const session = this.#uploads.get(transferId);
    if (session) {
      session.controller.abort();
      session.source?.fail(new DOMException("Cancelled", "AbortError"));
      if (session.promise !== null) {
        try {
          await session.promise;
        } catch {
          // The exact promise records cancelled, conflicted, uncertain, or
          // failed. A validated committed receipt resolves and wins the race.
        }
        if (session.result !== null) {
          session.phase = session.result.cleanupPending
            ? "cleanup-pending"
            : "committed";
          this.#recordTransfer(session, session.phase);
          this.#uploads.delete(transferId);
          session.hash.destroy();
          session.digest?.fill(0);
          session.digest = null;
          session.source = null;
          this.#pruneTerminalTransfers();
          return this.status();
        }
      }
      session.hash.destroy();
      session.digest?.fill(0);
      session.digest = null;
      session.source = null;
      this.#uploads.delete(transferId);
      this.#setTransfer(Object.freeze({
        id: transferId,
        label: session.name,
        phase: "cancelled",
        processedBytes: Math.max(session.hashBytes, session.encryptBytes),
        totalBytes: session.totalBytes,
        error: null,
      }));
      return this.status();
    }
    const recovery = this.#recoveries.get(transferId);
    if (
      recovery &&
      recovery.summary.stage_id !== null &&
      recovery.summary.target !== null
    ) {
      await abortFilesStage(this.#backend, {
        requestId: recovery.summary.request_id,
        stageId: recovery.summary.stage_id,
      });
      this.#recoveries.delete(transferId);
      this.#transfers.delete(transferId);
      return this.status();
    }
    if (this.#transfers.has(transferId)) {
      return this.status();
    }
    this.#rememberPreCancelled(transferId);
    return this.status();
  }

  async retry(transferId: string): Promise<FilesServiceStatus> {
    const recovery = this.#recoveries.get(transferId);
    if (recovery) {
      throw serviceFault(
        "uncertain",
        "Interrupted private uploads must be aborted and reselected",
      );
    }
    const session = this.#uploads.get(transferId);
    if (!session || session.error === null) {
      throw serviceFault("not_found", "Files transfer is not retryable");
    }
    throw serviceFault(
      "uncertain",
      "Retry requires the original operating-system File handle",
    );
  }

  async beginUpload(input: {
    transferId: string;
    path: string;
    name: string;
    mediaType: string;
    size: number;
    contentKind: "binary";
  }): Promise<Readonly<{ transferId: string; chunkBytes: number }>> {
    if (
      !Number.isSafeInteger(input.size) ||
      input.size < 0 ||
      input.size > FILES_V2_LIMITS.binaryFileBytes
    ) {
      throw serviceFault("limit", "The file does not fit in Files storage");
    }
    validateFilesName(input.name);
    const path = canonicalizeFilesPath(input.path).path;
    if (!this.#claimTransferId(input.transferId, input.name, input.size)) {
      throw serviceFault(
        "cancelled",
        "Files upload was cancelled before it started",
      );
    }
    if (this.#uploads.size >= 1) {
      throw serviceFault("busy", "Another Files upload is active");
    }
    const id = input.transferId;
    const session: UploadSession = {
      id,
      path,
      name: input.name,
      mediaType: input.mediaType,
      totalBytes: input.size,
      hash: nobleSha256.create(),
      hashBytes: 0,
      nextHashOrdinal: 0,
      digest: null,
      source: null,
      nextEncryptOrdinal: 0,
      encryptBytes: 0,
      controller: new AbortController(),
      promise: null,
      result: null,
      phase: "hashing",
      error: null,
      runtimeGeneration: this.#runtimeGeneration,
    };
    this.#uploads.set(id, session);
    this.#recordTransfer(session, "hashing");
    try {
      const runtime = await this.#readyRuntime();
      session.runtimeGeneration = runtime.generation;
      this.#assertRuntimeCurrent(runtime);
      this.#assertUploadCurrent(session);
      return Object.freeze({
        transferId: id,
        chunkBytes: UPLOAD_CHUNK_BYTES,
      });
    } catch (error) {
      if (this.#uploads.get(id) === session) {
        this.#clearUploadSession(
          session,
          error instanceof Error
            ? error
            : new Error("Files upload runtime failed"),
        );
      }
      throw error;
    }
  }

  async uploadChunk(
    input: {
      transferId: string;
      pass: "hash" | "encrypt";
      ordinal: number;
      final: boolean;
      totalBytes: number;
    },
    bytes: ArrayBuffer,
    controls: FilesTransferControls = {},
  ): Promise<Readonly<{
    transferId: string;
    phase: FilesTransferPhase;
    processedBytes: number;
    totalBytes: number;
    committed: boolean;
    readyForUpload: boolean;
    entry: FilesServiceEntry | null;
  }>> {
    const session = this.#uploads.get(input.transferId);
    if (!session) throw serviceFault("not_found", "Files upload expired");
    if (
      !(bytes instanceof ArrayBuffer) ||
      input.totalBytes !== session.totalBytes ||
      bytes.byteLength > UPLOAD_CHUNK_BYTES
    ) {
      throw serviceFault("invalid", "Files upload chunk binding is invalid");
    }
    if (input.pass === "hash") {
      if (
        session.digest !== null ||
        input.ordinal !== session.nextHashOrdinal ||
        session.hashBytes + bytes.byteLength > session.totalBytes ||
        input.final !==
          (session.hashBytes + bytes.byteLength === session.totalBytes)
      ) {
        throw serviceFault("conflict", "Files hash-pass chunk is out of order");
      }
      const incoming = new Uint8Array(bytes);
      session.hash.update(incoming);
      incoming.fill(0);
      session.hashBytes += bytes.byteLength;
      session.nextHashOrdinal += 1;
      if (input.final) {
        session.digest = session.hash.digest();
        session.hash.destroy();
        session.phase = "queued";
      }
      this.#recordTransfer(session, session.phase);
      return uploadResult(session, false, input.final, null);
    }
    if (
      session.digest === null ||
      input.ordinal !== session.nextEncryptOrdinal ||
      session.encryptBytes + bytes.byteLength > session.totalBytes ||
      input.final !==
        (session.encryptBytes + bytes.byteLength === session.totalBytes)
    ) {
      throw serviceFault("conflict", "Files encrypt-pass chunk is out of order");
    }
    session.source ??= controls.deferFinalCommit
      ? new SequentialUploadSource(
        session.totalBytes,
        session.totalBytes,
        session.totalBytes,
      )
      : new SequentialUploadSource(session.totalBytes);
    session.nextEncryptOrdinal += 1;
    session.encryptBytes += bytes.byteLength;
    session.phase = "encrypting";
    const incoming = new Uint8Array(bytes);
    const owned = incoming.slice();
    incoming.fill(0);
    let pushed: Promise<void>;
    try {
      pushed = session.source.push(owned);
    } catch (error) {
      owned.fill(0);
      throw error;
    }
    if (
      session.promise === null &&
      (!controls.deferFinalCommit || input.final)
    ) {
      let runtime: ResidentRuntime;
      try {
        runtime = await this.#readyRuntime();
      } catch (error) {
        this.#clearUploadSession(
          session,
          error instanceof Error
            ? error
            : new Error("Files upload runtime failed"),
        );
        throw error;
      }
      this.#assertRuntimeCurrent(runtime);
      this.#assertUploadCurrent(session);
      const fullPath = uploadPath(session.path, session.name);
      session.promise = this.#writePrehashedUpload(
        runtime,
        fullPath,
        session,
        controls,
      ).then((result) => {
        if (!this.#uploadAuthorityIsCurrent(session)) {
          throw serviceFault(
            "cancelled",
            "Files upload authority changed after private data was committed",
          );
        }
        session.result = result;
        session.phase = result.cleanupPending
          ? "cleanup-pending"
          : "committed";
        session.error = null;
        this.#recordTransfer(session, session.phase);
        return result;
      }).catch((error: unknown) => {
        const cancelled =
          !this.#uploadAuthorityIsCurrent(session) ||
          isTransferCancellation(error, session.controller.signal);
        const effective = cancelled
          ? serviceFault(
              "cancelled",
              "Files upload authority changed while private data was in flight",
            )
          : error;
        session.error = errorMessage(effective);
        session.phase =
          cancelled
            ? "cancelled"
            : isKnownUploadConflict(effective)
              ? "conflicted"
              : transferFailurePhase(effective);
        this.#recordTransfer(session, session.phase);
        throw effective;
      });
      // The final browser chunk observes the original promise. Attach a
      // handler immediately so an early transfer failure is never reported as
      // an unhandled rejection while the second pass is still streaming.
      void session.promise.catch(() => undefined);
    }
    if (input.final && controls.deferFinalCommit) {
      // Backpressure only resolves after the resident consumes this source
      // chunk. Kernel serializes that self-call behind the inbound attachment
      // invocation, so awaiting it here would deadlock before the deferred
      // commit branch below could return.
      void pushed.catch(() => undefined);
      const deferredCommit = session.promise;
      if (deferredCommit === null) {
        throw serviceFault("incompatible", "Files upload commit did not start");
      }
      void deferredCommit.then(
        () => this.#retireDeferredUploadSession(session),
        () => this.#retireDeferredUploadSession(session),
      );
      this.#recordTransfer(session, session.phase);
      return uploadResult(session, false, false, null);
    }
    try {
      await pushed;
      if (!input.final) this.#assertUploadCurrent(session);
    } catch (error) {
      owned.fill(0);
      if (!input.final) throw error;
      // The final source push and the exact backend commit promise race an
      // explicit cancel. Reconcile the commit promise below: a validated
      // committed receipt wins even if cancellation rejected backpressure.
    }
    if (!input.final) {
      this.#recordTransfer(session, session.phase);
      return uploadResult(session, false, false, null);
    }
    const commit = session.promise;
    if (commit === null) {
      throw serviceFault("incompatible", "Files upload commit did not start");
    }
    const result = await commit;
    if (session.result !== null) {
      session.phase = session.result.cleanupPending
        ? "cleanup-pending"
        : "committed";
      this.#recordTransfer(session, session.phase);
      if (this.#uploads.get(session.id) === session) {
        this.#uploads.delete(session.id);
      }
      session.digest?.fill(0);
      session.digest = null;
      session.source = null;
      this.#pruneTerminalTransfers();
      return uploadResult(session, true, false, result.entry);
    }
    this.#assertUploadCurrent(session);
    this.#recordTransfer(session, session.phase);
    this.#uploads.delete(session.id);
    session.digest?.fill(0);
    session.digest = null;
    this.#pruneTerminalTransfers();
    return uploadResult(session, true, false, result.entry);
  }

  #retireDeferredUploadSession(session: UploadSession): void {
    if (this.#uploads.get(session.id) !== session) return;
    this.#uploads.delete(session.id);
    session.digest?.fill(0);
    session.digest = null;
    session.source = null;
    this.#pruneTerminalTransfers();
  }

  clearVolatile(reason?: FilesAuthorityResetReason): void {
    this.#clearUploadSessions(new Error("Files volatile state cleared"));
    this.#clearTrackedSessions();
    this.#recoveries.clear();
    this.#transfers.clear();
    this.#preCancelled.clear();
    this.#dropRuntime();
    const followsUnsolicitedLock =
      (reason === "lock_epoch_changed" &&
        this.#lockedReason === "inactivity") ||
      (reason === "worker_failure" &&
        this.#lockedReason === "worker_failure");
    if (!followsUnsolicitedLock && reason !== "shutdown") {
      this.#advanceLockEpoch();
    }
    if (followsUnsolicitedLock || reason === "shutdown") return;
    this.#lockedReason =
      reason === "worker_failure"
        ? "worker_failure"
        : reason === "lock_epoch_changed"
          ? this.#lockedReason
          : "authority_changed";
    if (reason === "worker_failure") {
      this.#emitStatusChange("worker_failure");
    } else if (reason !== "lock_epoch_changed") {
      this.#emitStatusChange("authority_changed");
    }
  }

  async #getRuntime(): Promise<ResidentRuntime> {
    if (this.#runtime) return this.#runtime;
    if (this.#runtimePending) return this.#runtimePending;
    const generation = this.#runtimeGeneration;
    const pending = Promise.resolve().then(() => {
      const crypto = this.#createCrypto();
      const vault = new FilesVaultEngine({
        backend: this.#backend,
        crypto,
        ...(this.#vetkeys ? { vetkeys: this.#vetkeys } : {}),
      });
      const transfer = new FilesTransferEngine({
        backend: this.#backend,
        crypto,
        vault,
      });
      const runtime: ResidentRuntime = {
        generation,
        crypto,
        vault,
        transfer,
        unsubscribeLock: () => undefined,
        committedViewStale: false,
        refreshPending: null,
      };
      runtime.unsubscribeLock = vault.onLock(() => {
        if (this.#explicitLock || this.#dropping) return;
        queueMicrotask(() => {
          if (this.#runtime !== runtime) return;
          const reason = runtime.crypto.closed
            ? "worker_failure"
            : "inactivity";
          this.#dropRuntime();
          this.#advanceLockEpoch();
          this.#lockedReason = reason;
          for (const listener of this.#lockListeners) {
            try {
              listener(reason);
            } catch {
              // Resident erasure remains authoritative.
            }
          }
          this.#emitStatusChange(reason);
        });
      });
      if (generation !== this.#runtimeGeneration) {
        runtime.unsubscribeLock();
        runtime.transfer.dispose();
        runtime.vault.dispose();
        runtime.crypto.close("Files runtime generation changed");
        throw serviceFault(
          "cancelled",
          "Files authority changed during runtime creation",
        );
      }
      this.#runtime = runtime;
      return runtime;
    }).finally(() => {
      if (this.#runtimePending === pending) this.#runtimePending = null;
    });
    this.#runtimePending = pending;
    return pending;
  }

  async #readyRuntime(): Promise<ResidentRuntime> {
    const runtime = await this.#getRuntime();
    this.#assertRuntimeCurrent(runtime);
    if (runtime.committedViewStale && runtime.refreshPending === null) {
      const pending = runtime.vault.refreshCommittedView().then(() => {
        this.#assertRuntimeCurrent(runtime);
        runtime.committedViewStale = false;
      }).finally(() => {
        if (runtime.refreshPending === pending) {
          runtime.refreshPending = null;
        }
      });
      runtime.refreshPending = pending;
    }
    if (runtime.refreshPending !== null) {
      await runtime.refreshPending;
      this.#assertRuntimeCurrent(runtime);
    }
    const state = runtime.vault.status();
    if (state.state !== "ready") {
      throw serviceFault(
        "needs_user_unlock",
        "Unlock Files in a focused tile before private I/O",
      );
    }
    return runtime;
  }

  #assertRuntimeCurrent(runtime: ResidentRuntime): void {
    if (
      this.#runtime !== runtime ||
      runtime.generation !== this.#runtimeGeneration
    ) {
      throw serviceFault(
        "cancelled",
        "Files authority changed while private I/O was in flight",
      );
    }
  }

  #assertUploadCurrent(session: UploadSession): void {
    if (!this.#uploadIsCurrent(session)) {
      throw serviceFault(
        "cancelled",
        "Files upload authority changed while private data was in flight",
      );
    }
  }

  #uploadIsCurrent(session: UploadSession): boolean {
    return (
      this.#uploadAuthorityIsCurrent(session) &&
      !session.controller.signal.aborted
    );
  }

  #uploadAuthorityIsCurrent(session: UploadSession): boolean {
    return (
      this.#uploads.get(session.id) === session &&
      session.runtimeGeneration === this.#runtimeGeneration
    );
  }

  #clearUploadSessions(error: Error): void {
    for (const session of [...this.#uploads.values()]) {
      this.#clearUploadSession(session, error);
    }
  }

  #clearUploadSession(session: UploadSession, error: Error): void {
    session.controller.abort();
    session.source?.fail(error);
    session.hash.destroy();
    session.digest?.fill(0);
    session.digest = null;
    session.source = null;
    session.result = null;
    this.#uploads.delete(session.id);
    this.#transfers.delete(session.id);
  }

  #clearTrackedSessions(): void {
    for (const session of this.#activeReads.values()) {
      session.controller.abort();
      session.detachParentAbort();
      this.#transfers.delete(session.id);
    }
    this.#activeReads.clear();
    for (const session of this.#activeWrites.values()) {
      session.controller.abort();
      session.detachParentAbort();
      this.#transfers.delete(session.id);
    }
    this.#activeWrites.clear();
  }

  #markCommittedViewStale(runtime: ResidentRuntime): void {
    this.#assertRuntimeCurrent(runtime);
    runtime.committedViewStale = true;
  }

  #dropRuntime(): void {
    this.#clearTrackedSessions();
    this.#runtimeGeneration =
      this.#runtimeGeneration >= Number.MAX_SAFE_INTEGER
        ? 1
        : this.#runtimeGeneration + 1;
    this.#runtimePending = null;
    const runtime = this.#runtime;
    this.#runtime = null;
    if (!runtime || this.#dropping) return;
    this.#dropping = true;
    try {
      runtime.unsubscribeLock();
      runtime.transfer.dispose();
      runtime.vault.dispose();
      runtime.crypto.close();
    } finally {
      this.#dropping = false;
    }
  }

  #advanceLockEpoch(): void {
    this.#lockEpoch =
      this.#lockEpoch >= 0xffff_ffff_ffff_ffffn
        ? 0xffff_ffff_ffff_ffffn
        : this.#lockEpoch + 1n;
  }

  #emitStatusChange(
    reason:
      | "inactivity"
      | "worker_failure"
      | "authority_changed"
      | "state_changed",
  ): void {
    for (const listener of this.#statusListeners) {
      try {
        listener(reason);
      } catch {
        // Resident erasure remains authoritative.
      }
    }
  }

  async #readBootstrap(): Promise<FilesBootstrapOkV2> {
    const outcome = await this.#backend.bootstrap();
    if (outcome.kind === "unsupported") {
      throw serviceFault("incompatible", "Files V2 is unsupported");
    }
    if (outcome.kind === "rejected") {
      throw serviceFault(
        outcome.rejection.reason?.tag === "quota" ? "quota" : "incompatible",
        `Files bootstrap was rejected: ${
          outcome.rejection.reason?.tag ?? "unknown"
        }`,
      );
    }
    if (outcome.value.vault === null) {
      throw serviceFault(
        "incompatible",
        "Files bootstrap returned an unknown vault-state variant",
      );
    }
    this.#lastBootstrap = outcome.value;
    this.#syncRecoveries(outcome.value);
    return outcome.value;
  }

  #syncRecoveries(bootstrap: FilesBootstrapOkV2): void {
    const retained = new Set<string>();
    for (const summary of bootstrap.active_operations) {
      if (
        summary.kind === null ||
        !("private_write" in summary.kind)
      ) {
        throw serviceFault(
          "incompatible",
          "Files active operation returned an unknown kind variant",
        );
      }
      if (summary.stage_id === null || summary.target === null) {
        throw serviceFault(
          "incompatible",
          "Files active operation omitted its recovery authority",
        );
      }
      if (!("private_write" in summary.target)) {
        throw serviceFault(
          "incompatible",
          "Files active operation target changed variant",
        );
      }
      if (
        this.#activeWrites.size > 0 ||
        [...this.#uploads.values()].some((session) =>
          session.promise !== null
        )
      ) {
        // A status refresh may observe the live resident write as a backend
        // stage. Keep the caller's transfer id as the single UI identity;
        // synthesize recovery only after the resident operation disappears.
        continue;
      }
      const requestKey = filesId128ToKey(summary.request_id);
      let existing = [...this.#recoveries.values()].find(
        (value) =>
          filesId128ToKey(value.summary.request_id) === requestKey,
      );
      if (!existing) {
        existing = Object.freeze({
          transferId: filesId128ToKey(randomFilesRequestId()),
          summary,
        });
      } else {
        existing = Object.freeze({ ...existing, summary });
      }
      this.#recoveries.set(existing.transferId, existing);
      retained.add(existing.transferId);
      this.#setTransfer(Object.freeze({
        id: existing.transferId,
        label: "Interrupted private write",
        phase: "checking-outcome",
        processedBytes: 0,
        totalBytes: 0,
        error: null,
      }));
    }
    for (const [id] of this.#recoveries) {
      if (retained.has(id)) continue;
      this.#recoveries.delete(id);
      this.#transfers.delete(id);
    }
  }

  async #renderStatus(
    bootstrap: FilesBootstrapOkV2,
  ): Promise<FilesServiceStatus> {
    const runtimeState = this.#runtime?.vault.status() ?? null;
    const state =
      runtimeState?.state === "ready"
        ? "ready"
        : runtimeState?.state === "unrecoverable"
          ? "unrecoverable"
          : bootstrap.vault !== null && "absent" in bootstrap.vault
            ? "uninitialized"
            : "locked";
    const currentGeneration =
      runtimeState !== null &&
        (runtimeState.state === "ready" || runtimeState.state === "locked")
        ? runtimeState.currentGeneration
        : bootstrap.vault !== null && "present" in bootstrap.vault
          ? bootstrap.vault.present.slot_generation
          : null;
    const previousGeneration =
      runtimeState !== null &&
        (runtimeState.state === "ready" || runtimeState.state === "locked")
        ? runtimeState.previousGeneration
        : null;
    const rotationRequired =
      runtimeState?.state === "locked"
        ? runtimeState.migrationRequired
        : runtimeState?.state === "ready"
          ? !runtimeState.rotationConfirmed
          : false;
    return Object.freeze({
      vault: state,
      lockEpoch: this.#lockEpoch.toString() as CanonicalNat64,
      currentGeneration,
      previousGeneration,
      rotationRequired,
      reason:
        runtimeState?.state === "unrecoverable"
          ? runtimeState.reason
          : state === "locked"
            ? this.#lockedReason
            : null,
      quota: Object.freeze({
        nodes: bootstrap.quota.nodes,
        plaintextBytes:
          bootstrap.quota.committed_private_plaintext_bytes,
        ciphertextBytes: bootstrap.quota.committed_ciphertext_bytes,
        physicalBytes: bootstrap.quota.physical_private_bytes,
        cleanupJobs: bootstrap.quota.cleanup_jobs,
      }),
      publicUsage: publicUsage(bootstrap),
      transfers: Object.freeze([...this.#transfers.values()]),
    });
  }

  async #commitReplayableWrite(
    runtime: ResidentRuntime,
    plan: () => Promise<FilesPrivateWritePlan>,
    digests: readonly Uint8Array[],
    controls: FilesTransferControls,
  ): Promise<Readonly<{
    plan: FilesPrivateWritePlan;
    receipt: FilesWriteReceipt;
  }>> {
    for (
      let attempt = 0;
      attempt < MAX_ID_COLLISION_ATTEMPTS;
      attempt += 1
    ) {
      const candidate = await plan();
      this.#assertRuntimeCurrent(runtime);
      try {
        const receipt = await runtime.transfer.writePrivatePrehashed(
          candidate,
          digests,
          controls,
        );
        this.#assertRuntimeCurrent(runtime);
        this.#markCommittedViewStale(runtime);
        return Object.freeze({ plan: candidate, receipt });
      } catch (error) {
        if (
          !(error instanceof FilesTransferEngineFault) ||
          error.rejectionReason !== "id_collision" ||
          attempt === MAX_ID_COLLISION_ATTEMPTS - 1
        ) {
          throw error;
        }
      }
    }
    throw serviceFault(
      "conflict",
      "Files could not allocate unique write identifiers",
    );
  }

  async #planWrite(
    runtime: ResidentRuntime,
    input: {
      path: string;
      source: FilesTransferSource;
      contentKind: "text" | "binary";
      mediaType: string;
      ifMatch: string | null;
      ifNoneMatch: boolean;
      createParents: boolean;
    },
    digest: Uint8Array,
  ): Promise<FilesPrivateWritePlan> {
    const canonical = canonicalizeFilesPath(input.path);
    if (canonical.segments.length === 0) {
      throw serviceFault("invalid", "The Files root cannot be overwritten");
    }
    if (input.createParents) {
      return this.#planBatch(
        runtime,
        [{
          item: {
            path: canonical.path,
            text: "",
            overwrite: true,
            createParents: true,
            mediaType: input.mediaType,
            contentKind:
              input.contentKind === "text"
                ? "text_v1"
                : "binary_v1",
            ifMatch: input.ifMatch,
            ifNoneMatch: input.ifNoneMatch,
          },
          source: input.source,
        }],
        [digest],
        "single",
      );
    }
    const parent = parentPath(canonical.path);
    const chain = await pathChain(runtime.vault, parent);
    const parentNode = chain[chain.length - 1]!;
    const name = canonical.segments.at(-1)!;
    const existing = await lookupChildMaybe(
      runtime.vault,
      parentNode,
      name,
    );
    if (existing?.node.kind === "folder") {
      throw serviceFault("conflict", "A folder already exists at Files path");
    }
    if (input.ifNoneMatch && existing !== null) {
      throw serviceFault("conflict", "Files path already exists");
    }
    if (
      input.ifMatch !== null &&
      (existing === null ||
        existing.metadata.nodeKind !== "file" ||
        digestHex(existing.metadata.plaintextSha256) !== input.ifMatch)
    ) {
      throw serviceFault("conflict", "Files etag no longer matches");
    }
    const tag = await workerNameTag(
      runtime.crypto,
      parentNode.node.nodeId,
      name,
    );
    const now = nowNat64();
    const metadata = validateFilesMetadata({
      nodeKind: "file",
      name,
      contentKind:
        input.contentKind === "text" ? "text_v1" : "binary_v1",
      mimeType: input.mediaType,
      plaintextBytes: input.source.size,
      plaintextSha256: digest,
      createdAtNs:
        existing?.metadata.createdAtNs ?? now,
      modifiedAtNs: now,
    }) as FilesFileMetadata;
    const transition =
      existing === null
        ? newNodeTransition({
            nodeId: randomFilesNodeId(),
            parentId: parentNode.node.nodeId,
            kind: "file",
            nameTag: tag,
            nameScalars: unicodeScalarCount(name),
            plaintextBytes: input.source.size,
          })
        : transitionFromNode(existing, {
            proposedParentId: parentNode.node.nodeId,
            proposedNameTag: tag,
            declaredNameScalars: unicodeScalarCount(name),
            proposedStructuralRevision:
              incrementFilesRevision(existing.node.structuralRevision),
            proposedMetadataRevision:
              incrementFilesRevision(existing.node.metadataRevision),
            proposedSubtreePlaintextBytes:
              input.source.size.toString() as CanonicalNat64,
          });
    const oldBytes =
      existing?.metadata.nodeKind === "file"
        ? existing.metadata.plaintextBytes
        : 0;
    const delta = input.source.size - oldBytes;
    const folderTransitions = propagateAggregateChange(
      chain,
      delta,
      existing === null,
      name,
      0,
      0,
    );
    const currentQuota = runtime.vault.status().capacity?.privateQuota;
    if (!currentQuota) {
      throw serviceFault("incompatible", "Files quota snapshot is unavailable");
    }
    const geometry = planPrivateBlocks(input.source.size);
    const existingCiphertext =
      existing?.content === null || existing?.content === undefined
        ? 0n
        : BigInt(existing.content.ciphertextBytes);
    const proposedCiphertext =
      BigInt(currentQuota.committedCiphertextBytes) -
      existingCiphertext +
      BigInt(geometry.ciphertextBytes) -
      BigInt(
        existing === null
          ? 0
          : encryptedMetadataBytes(existing.metadata),
      ) +
      BigInt(encryptedMetadataBytes(metadata));
    const proposedPlaintext =
      BigInt(currentQuota.committedPlaintextBytes) + BigInt(delta);
    return Object.freeze({
      intent: existing === null ? "create" : "replace",
      items: Object.freeze([{
        transition,
        metadata,
        source: input.source,
      }]),
      folderTransitions: Object.freeze(folderTransitions),
      childIndexTransitions: Object.freeze(
        existing === null
          ? [{
              parentId: parentNode.node.nodeId,
              nameTag: tag,
              expectedNodeId: null,
              proposedNodeId: transition.nodeId,
            }]
          : [],
      ),
      retiredContents: Object.freeze(
        existing?.content
          ? [{
              nodeId: existing.node.nodeId,
              contentId: existing.content.contentId,
              blockCount: existing.content.blockCount,
              ciphertextBytes: existing.content.ciphertextBytes,
            }]
          : [],
      ),
      quota: Object.freeze({
        expectedNodeCount: currentQuota.nodes,
        proposedNodeCount:
          (BigInt(currentQuota.nodes) +
            (existing === null ? 1n : 0n)).toString() as CanonicalNat64,
        expectedCommittedPlaintextBytes:
          currentQuota.committedPlaintextBytes,
        proposedCommittedPlaintextBytes:
          proposedPlaintext.toString() as CanonicalNat64,
        expectedCommittedCiphertextBytes:
          currentQuota.committedCiphertextBytes,
        proposedCommittedCiphertextBytes:
          proposedCiphertext.toString() as CanonicalNat64,
        // The backend derives and reserves the exact stage/receipt/cleanup
        // peak. Declare the frozen cap as a conservative witness so a valid
        // deep structural plan cannot be rejected because this resident
        // omitted a persisted-row class from a parallel byte estimate.
        grossPeakPhysicalBytes:
          PRIVATE_PHYSICAL_CAP_BYTES.toString() as CanonicalNat64,
      }),
    });
  }

  async #planBatch(
    runtime: ResidentRuntime,
    sources: readonly Readonly<{
      item: Readonly<{
        path: string;
        text: string;
        overwrite: boolean;
        createParents: boolean;
        mediaType: string;
        contentKind?: "text_v1" | "binary_v1";
        ifMatch?: string | null;
        ifNoneMatch?: boolean;
      }>;
      source: FilesTransferSource;
    }>[],
    digests: readonly Uint8Array[],
    mode: "single" | "batch",
  ): Promise<FilesPrivateWritePlan> {
    if (
      (mode === "single" && sources.length !== 1) ||
      (mode === "batch" && (sources.length < 1 || sources.length > 20))
    ) {
      throw serviceFault("invalid", "Files write planner mode is invalid");
    }
    const quota = runtime.vault.status().capacity?.privateQuota;
    if (!quota) {
      throw serviceFault("incompatible", "Files quota snapshot is unavailable");
    }
    type ResolvedFolder = {
      path: string;
      nodeId: FilesId128V2;
      record: FilesNodeRecord | null;
    };
    type VirtualFolder = {
      path: string;
      parentPath: string;
      nodeId: FilesId128V2;
      name: string;
      nameTag: Uint8Array;
      metadata: FilesFolderMetadata;
      transition: FilesNodeTransition | null;
    };
    type PlannedFile = {
      path: string;
      parentPath: string;
      transition: FilesNodeTransition;
      metadata: FilesFileMetadata;
      source: FilesTransferSource;
    };
    type ChildAggregate = {
      name: string;
      height: number;
      maxRelativePathScalars: number;
      plaintextBytes: number;
    };

    const requiredParents = new Map<string, {
      mayCreate: boolean;
      mustExist: boolean;
    }>();
    const canonicalSources = sources.map((source) => {
      const canonical = canonicalizeFilesPath(source.item.path);
      if (canonical.segments.length === 0) {
        throw serviceFault("invalid", "The Files root cannot be overwritten");
      }
      for (let depth = 1; depth < canonical.segments.length; depth += 1) {
        const path = `/${canonical.segments.slice(0, depth).join("/")}`;
        const requirement = requiredParents.get(path) ?? {
          mayCreate: false,
          mustExist: false,
        };
        requirement.mayCreate ||= source.item.createParents;
        requirement.mustExist ||= !source.item.createParents;
        requiredParents.set(path, requirement);
      }
      return { ...source, canonical };
    });
    const root = await runtime.vault.lookupPath("/");
    const resolved = new Map<string, ResolvedFolder>([
      ["/", { path: "/", nodeId: root.node.nodeId, record: root }],
    ]);
    const virtualFolders: VirtualFolder[] = [];
    const parentPaths = [...requiredParents.keys()].sort(
      (left, right) =>
        canonicalizeFilesPath(left).segments.length -
          canonicalizeFilesPath(right).segments.length ||
        left.localeCompare(right),
    );
    for (const path of parentPaths) {
      const parent = resolved.get(parentPath(path));
      if (!parent) {
        throw serviceFault(
          "incompatible",
          "Files atomic parent plan lost its ancestor",
        );
      }
      const name = canonicalizeFilesPath(path).segments.at(-1)!;
      const existing =
        parent.record === null
          ? null
          : await lookupChildMaybe(runtime.vault, parent.record, name);
      if (existing !== null) {
        if (existing.node.kind !== "folder") {
          throw serviceFault(
            "conflict",
            "A Files path prefix is not a folder",
          );
        }
        resolved.set(path, {
          path,
          nodeId: existing.node.nodeId,
          record: existing,
        });
        continue;
      }
      const requirement = requiredParents.get(path)!;
      if (requirement.mustExist || !requirement.mayCreate) {
        throw serviceFault(
          "not_found",
          "A Files batch parent folder does not exist",
        );
      }
      const nameTag = await workerNameTag(
        runtime.crypto,
        parent.nodeId,
        name,
      );
      const now = nowNat64();
      const folder: VirtualFolder = {
        path,
        parentPath: parentPath(path),
        nodeId: randomFilesNodeId(),
        name,
        nameTag,
        metadata: {
          nodeKind: "folder",
          name,
          createdAtNs: now,
          modifiedAtNs: now,
        },
        transition: null,
      };
      virtualFolders.push(folder);
      resolved.set(path, {
        path,
        nodeId: folder.nodeId,
        record: null,
      });
    }

    const childIndexTransitions:
      Array<FilesPrivateWritePlan["childIndexTransitions"][number]> = [];
    const retiredContents:
      Array<FilesPrivateWritePlan["retiredContents"][number]> = [];
    const aggregates = new Map<string, AggregateAccumulator>();
    for (const folder of resolved.values()) {
      if (folder.record !== null) {
        aggregates.set(
          filesId128ToKey(folder.record.node.nodeId),
          folder.record,
        );
      }
    }
    const plannedFiles: PlannedFile[] = [];
    let created = BigInt(virtualFolders.length);
    let plaintextDelta = 0n;
    let ciphertextDelta = 0n;
    let singleIntent: "create" | "replace" | null = null;
    for (let index = 0; index < canonicalSources.length; index += 1) {
      const { item, source, canonical } = canonicalSources[index]!;
      const digest = digests[index]!;
      if (resolved.has(canonical.path)) {
        throw serviceFault(
          "conflict",
          "A folder is also targeted as a batch file",
        );
      }
      const parentPathValue = parentPath(canonical.path);
      const parent = resolved.get(parentPathValue);
      if (!parent) {
        throw serviceFault(
          "not_found",
          "A Files batch parent folder does not exist",
        );
      }
      const name = canonical.segments.at(-1)!;
      const existing =
        parent.record === null
          ? null
          : await lookupChildMaybe(runtime.vault, parent.record, name);
      if (existing?.node.kind === "folder") {
        throw serviceFault("conflict", "A folder exists at a batch path");
      }
      if (mode === "single") {
        singleIntent = existing === null ? "create" : "replace";
      }
      if (!item.overwrite && existing !== null) {
        throw serviceFault("conflict", "A Files batch path already exists");
      }
      if (item.ifNoneMatch === true && existing !== null) {
        throw serviceFault("conflict", "Files path already exists");
      }
      if (
        item.ifMatch !== undefined &&
        item.ifMatch !== null &&
        (existing === null ||
          existing.metadata.nodeKind !== "file" ||
          digestHex(existing.metadata.plaintextSha256) !== item.ifMatch)
      ) {
        throw serviceFault("conflict", "Files etag no longer matches");
      }
      const nameTag = await workerNameTag(
        runtime.crypto,
        parent.nodeId,
        name,
      );
      const now = nowNat64();
      const metadata = validateFilesMetadata({
        nodeKind: "file",
        name,
        contentKind: item.contentKind ?? "text_v1",
        mimeType: item.mediaType,
        plaintextBytes: source.size,
        plaintextSha256: digest,
        createdAtNs: existing?.metadata.createdAtNs ?? now,
        modifiedAtNs: now,
      }) as FilesFileMetadata;
      ciphertextDelta +=
        BigInt(encryptedMetadataBytes(metadata)) -
        BigInt(
          existing === null
            ? 0
            : encryptedMetadataBytes(existing.metadata),
        );
      const transition =
        existing === null
          ? newNodeTransition({
              nodeId: randomFilesNodeId(),
              parentId: parent.nodeId,
              kind: "file",
              nameTag,
              nameScalars: unicodeScalarCount(name),
              plaintextBytes: source.size,
            })
          : transitionFromNode(existing, {
              proposedParentId: parent.nodeId,
              proposedNameTag: nameTag,
              declaredNameScalars: unicodeScalarCount(name),
              proposedStructuralRevision:
                incrementFilesRevision(existing.node.structuralRevision),
              proposedMetadataRevision:
                incrementFilesRevision(existing.node.metadataRevision),
              proposedSubtreePlaintextBytes:
                source.size.toString() as CanonicalNat64,
            });
      plannedFiles.push({
        path: canonical.path,
        parentPath: parentPathValue,
        transition,
        metadata,
        source,
      });
      const oldPlaintext =
        existing?.metadata.nodeKind === "file"
          ? existing.metadata.plaintextBytes
          : 0;
      const delta = source.size - oldPlaintext;
      plaintextDelta += BigInt(delta);
      const geometry = planPrivateBlocks(source.size);
      const oldCiphertext =
        existing?.content === null || existing?.content === undefined
          ? 0n
          : BigInt(existing.content.ciphertextBytes);
      ciphertextDelta += BigInt(geometry.ciphertextBytes) - oldCiphertext;
      if (existing === null) {
        created += 1n;
        childIndexTransitions.push(Object.freeze({
          parentId: parent.nodeId,
          nameTag,
          expectedNodeId: null,
          proposedNodeId: transition.nodeId,
        }));
      } else if (existing.content !== null) {
        retiredContents.push(Object.freeze({
          nodeId: existing.node.nodeId,
          contentId: existing.content.contentId,
          blockCount: existing.content.blockCount,
          ciphertextBytes: existing.content.ciphertextBytes,
        }));
      }
    }

    const children = new Map<string, ChildAggregate[]>();
    const addChild = (path: string, child: ChildAggregate) => {
      const list = children.get(path) ?? [];
      list.push(child);
      children.set(path, list);
    };
    for (const file of plannedFiles) {
      addChild(file.parentPath, {
        name: file.metadata.name,
        height: 0,
        maxRelativePathScalars:
          unicodeScalarCount(file.metadata.name),
        plaintextBytes: file.metadata.plaintextBytes,
      });
    }
    for (const folder of [...virtualFolders].sort(
      (left, right) =>
        canonicalizeFilesPath(right.path).segments.length -
          canonicalizeFilesPath(left.path).segments.length ||
        right.path.localeCompare(left.path),
    )) {
      const direct = children.get(folder.path) ?? [];
      const height = direct.reduce(
        (maximum, child) => Math.max(maximum, child.height + 1),
        0,
      );
      const maxRelativePathScalars = direct.reduce(
        (maximum, child) =>
          Math.max(maximum, child.maxRelativePathScalars),
        0,
      );
      const ownNameScalars = unicodeScalarCount(folder.name);
      const aggregateMaxRelativePathScalars =
        direct.length === 0
          ? ownNameScalars
          : ownNameScalars + 1 + maxRelativePathScalars;
      const plaintextBytes = direct.reduce(
        (total, child) => total + child.plaintextBytes,
        0,
      );
      folder.transition = Object.freeze({
        ...newNodeTransition({
          nodeId: folder.nodeId,
          parentId: resolved.get(folder.parentPath)!.nodeId,
          kind: "folder",
          nameTag: folder.nameTag,
          nameScalars: unicodeScalarCount(folder.name),
          plaintextBytes,
        }),
        proposedSubtreeHeight: height,
        proposedMaxRelativePathScalars:
          aggregateMaxRelativePathScalars,
      });
      addChild(folder.parentPath, {
        name: folder.name,
        height,
        maxRelativePathScalars: aggregateMaxRelativePathScalars,
        plaintextBytes,
      });
    }

    const folderItems: Array<FilesPrivateWritePlan["items"][number]> = [];
    for (const folder of virtualFolders) {
      const transition = folder.transition;
      if (transition === null) {
        throw serviceFault(
          "incompatible",
          "Files atomic folder plan is incomplete",
        );
      }
      folderItems.push(Object.freeze({
        transition,
        metadata: folder.metadata,
        source: EMPTY_TRANSFER_SOURCE,
      }));
      ciphertextDelta +=
        BigInt(encryptedMetadataBytes(folder.metadata));
      childIndexTransitions.push(Object.freeze({
        parentId: transition.proposedParentId,
        nameTag: transition.proposedNameTag,
        expectedNodeId: null,
        proposedNodeId: transition.nodeId,
      }));
    }
    const items = [
      ...folderItems,
      ...plannedFiles.map((file) => Object.freeze({
        transition: file.transition,
        metadata: file.metadata,
        source: file.source,
      })),
    ];
    const folderTransitions = finalizeAggregateTransitions(aggregates);
    const structuralEntries =
      items.length +
      folderTransitions.length +
      childIndexTransitions.length +
      retiredContents.length;
    if (structuralEntries > 64) {
      throw serviceFault(
        "limit",
        "Files atomic batch plan exceeds 64 structural entries",
      );
    }
    return Object.freeze({
      intent:
        mode === "batch"
          ? "batch"
          : singleIntent ??
            (() => {
              throw serviceFault(
                "incompatible",
                "Files single write plan omitted its target",
              );
            })(),
      items: Object.freeze(items),
      folderTransitions: Object.freeze(folderTransitions),
      childIndexTransitions: Object.freeze(childIndexTransitions),
      retiredContents: Object.freeze(retiredContents),
      quota: Object.freeze({
        expectedNodeCount: quota.nodes,
        proposedNodeCount:
          (BigInt(quota.nodes) + created).toString() as CanonicalNat64,
        expectedCommittedPlaintextBytes:
          quota.committedPlaintextBytes,
        proposedCommittedPlaintextBytes:
          (BigInt(quota.committedPlaintextBytes) + plaintextDelta)
            .toString() as CanonicalNat64,
        expectedCommittedCiphertextBytes:
          quota.committedCiphertextBytes,
        proposedCommittedCiphertextBytes:
          (BigInt(quota.committedCiphertextBytes) + ciphertextDelta)
            .toString() as CanonicalNat64,
        // See the single-write path above. Exact physical admission belongs
        // to the backend's canonical accounting function.
        grossPeakPhysicalBytes:
          PRIVATE_PHYSICAL_CAP_BYTES.toString() as CanonicalNat64,
      }),
    });
  }

  async #createFolder(
    runtime: ResidentRuntime,
    path: string,
  ): Promise<void> {
    const canonical = canonicalizeFilesPath(path);
    const parent = parentPath(canonical.path);
    const chain = await pathChain(runtime.vault, parent);
    const parentNode = chain[chain.length - 1]!;
    const name = canonical.segments.at(-1)!;
    const tag = await workerNameTag(
      runtime.crypto,
      parentNode.node.nodeId,
      name,
    );
    const transition = newNodeTransition({
      nodeId: randomFilesNodeId(),
      parentId: parentNode.node.nodeId,
      kind: "folder",
      nameTag: tag,
      nameScalars: unicodeScalarCount(name),
      plaintextBytes: 0,
    });
    const now = nowNat64();
    const metadata: FilesFolderMetadata = {
      nodeKind: "folder",
      name,
      createdAtNs: now,
      modifiedAtNs: now,
    };
    const encryptedMetadata = await encryptNodeMetadata(
      runtime.crypto,
      transition,
      metadata,
    );
    await runtime.transfer.mutate({
      requestId: randomFilesRequestId(),
      action: "create_folder",
      node: transition,
      encryptedMetadata,
      folderTransitions: propagateAggregateChange(
        chain,
        0,
        true,
        name,
        0,
        0,
      ),
      childIndexTransitions: [{
        parentId: parentNode.node.nodeId,
        nameTag: tag,
        expectedNodeId: null,
        proposedNodeId: transition.nodeId,
      }],
    });
    await runtime.vault.refreshCommittedView();
  }

  async #writePrehashedUpload(
    runtime: ResidentRuntime,
    fullPath: string,
    session: UploadSession,
    controls: FilesTransferControls,
  ): Promise<FilesServiceWriteResult> {
    const digest = session.digest;
    const source = session.source;
    if (!digest || !source) {
      throw serviceFault("invalid", "Files upload is not hash-complete");
    }
    try {
      for (
        let attempt = 0;
        attempt < MAX_ID_COLLISION_ATTEMPTS;
        attempt += 1
      ) {
        const plan = await this.#planWrite(runtime, {
          path: fullPath,
          source,
          contentKind: "binary",
          mediaType: session.mediaType,
          ifMatch: null,
          ifNoneMatch: false,
          createParents: true,
        }, digest);
        this.#assertRuntimeCurrent(runtime);
        try {
          const receipt = await runtime.transfer.writePrivatePrehashed(
            plan,
            [digest],
            {
              signal: session.controller.signal,
              onProgress: (progress) => {
                session.phase = progress.phase;
                controls.onProgress?.(progress);
                this.#recordTransfer(session, progress.phase);
              },
            },
          );
          this.#assertRuntimeCurrent(runtime);
          const file = plan.items.find(
            (item): item is typeof item & { metadata: FilesFileMetadata } =>
              item.metadata.nodeKind === "file",
          );
          if (!file) {
            throw serviceFault(
              "incompatible",
              "Files committed upload omitted its file plan",
            );
          }
          this.#markCommittedViewStale(runtime);
          return committedWriteResult(fullPath, file, receipt);
        } catch (error) {
          if (
            !(error instanceof FilesTransferEngineFault) ||
            error.rejectionReason !== "id_collision" ||
            attempt === MAX_ID_COLLISION_ATTEMPTS - 1
          ) {
            throw error;
          }
          source.rewindFirstSlice();
        }
      }
      throw serviceFault(
        "conflict",
        "Files could not allocate unique upload identifiers",
      );
    } finally {
      source.releaseFirstSlice();
    }
  }

  #recordTransfer(
    session: UploadSession,
    phase: FilesTransferPhase,
  ): void {
    if (this.#uploads.get(session.id) !== session) return;
    this.#setTransfer(Object.freeze({
      id: session.id,
      label: session.name,
      phase,
      processedBytes: Math.max(session.hashBytes, session.encryptBytes),
      totalBytes: session.totalBytes,
      error: session.error,
    }));
  }

  async #executeTrackedRead(
    session: TrackedReadSession,
    path: string,
    controls: FilesTransferControls,
  ): Promise<FilesServiceFile> {
    try {
      throwIfAborted(session.controller.signal);
      const result = await this.#readNow(path, {
        signal: session.controller.signal,
        onProgress: (progress) => {
          session.totalBytes = Math.max(
            session.totalBytes,
            progress.plaintextBytes,
          );
          session.processedBytes = Math.max(
            session.processedBytes,
            progress.processedBytes,
          );
          this.#recordReadTransfer(session, progress.phase);
          controls.onProgress?.(progress);
        },
      });
      session.totalBytes = result.entry.byteLength;
      session.processedBytes = result.entry.byteLength;
      session.error = null;
      this.#recordReadTransfer(session, "committed");
      return result;
    } catch (error) {
      const cancelled = isTransferCancellation(
        error,
        session.controller.signal,
      );
      session.error = cancelled ? null : errorMessage(error);
      this.#recordReadTransfer(
        session,
        cancelled ? "cancelled" : transferFailurePhase(error),
      );
      if (cancelled && !isCodedCancellation(error)) {
        throw serviceFault("cancelled", "Files read was cancelled", error);
      }
      throw error;
    }
  }

  async #executeTrackedWrite(
    session: TrackedWriteSession,
    input: UntrackedResidentWriteInput,
    controls: FilesTransferControls,
  ): Promise<FilesServiceWriteResult> {
    try {
      throwIfAborted(session.controller.signal);
      const result = await this.#writeNow(input, {
        signal: session.controller.signal,
        onProgress: (progress) => {
          session.totalBytes = Math.max(
            session.totalBytes,
            progress.plaintextBytes,
          );
          session.processedBytes = Math.max(
            session.processedBytes,
            progress.processedBytes,
          );
          this.#recordWriteTransfer(session, progress.phase);
          controls.onProgress?.(progress);
        },
      });
      session.processedBytes = session.totalBytes;
      session.error = null;
      this.#recordWriteTransfer(
        session,
        result.cleanupPending ? "cleanup-pending" : "committed",
      );
      return result;
    } catch (error) {
      const cancelled = isTransferCancellation(
        error,
        session.controller.signal,
      );
      session.error = cancelled ? null : errorMessage(error);
      this.#recordWriteTransfer(
        session,
        cancelled ? "cancelled" : transferFailurePhase(error),
      );
      if (cancelled && !isCodedCancellation(error)) {
        throw serviceFault("cancelled", "Files write was cancelled", error);
      }
      throw error;
    }
  }

  #recordReadTransfer(
    session: TrackedReadSession,
    phase: FilesTransferPhase,
  ): void {
    if (this.#activeReads.get(session.id) !== session) return;
    this.#setTransfer(Object.freeze({
      id: session.id,
      label: session.label,
      phase,
      processedBytes: session.processedBytes,
      totalBytes: session.totalBytes,
      error: session.error,
    }));
  }

  #recordWriteTransfer(
    session: TrackedWriteSession,
    phase: FilesTransferPhase,
  ): void {
    if (this.#activeWrites.get(session.id) !== session) return;
    this.#setTransfer(Object.freeze({
      id: session.id,
      label: session.label,
      phase,
      processedBytes: session.processedBytes,
      totalBytes: session.totalBytes,
      error: session.error,
    }));
  }

  #assertTransferId(transferId: string): void {
    if (!TRANSFER_ID_PATTERN.test(transferId)) {
      throw serviceFault("invalid", "Files transfer id is invalid");
    }
  }

  #claimTransferId(
    transferId: string,
    label: string,
    totalBytes: number,
  ): boolean {
    this.#assertTransferId(transferId);
    if (this.#consumePreCancelled(transferId)) {
      this.#setTransfer(Object.freeze({
        id: transferId,
        label,
        phase: "cancelled",
        processedBytes: 0,
        totalBytes,
        error: null,
      }));
      return false;
    }
    if (
      this.#activeReads.has(transferId) ||
      this.#activeWrites.has(transferId) ||
      this.#uploads.has(transferId) ||
      this.#recoveries.has(transferId) ||
      this.#transfers.has(transferId)
    ) {
      throw serviceFault("conflict", "Files transfer id is already in use");
    }
    return true;
  }

  #rememberPreCancelled(transferId: string): void {
    const now = Date.now();
    this.#prunePreCancelled(now);
    this.#preCancelled.delete(transferId);
    while (this.#preCancelled.size >= MAX_PRE_CANCELLED_TRANSFERS) {
      const oldest = this.#preCancelled.keys().next().value;
      if (oldest === undefined) break;
      this.#preCancelled.delete(oldest);
    }
    this.#preCancelled.set(transferId, now + PRE_CANCEL_TTL_MS);
  }

  #consumePreCancelled(transferId: string): boolean {
    this.#prunePreCancelled(Date.now());
    return this.#preCancelled.delete(transferId);
  }

  #prunePreCancelled(now: number): void {
    for (const [transferId, expiresAt] of this.#preCancelled) {
      if (expiresAt > now) continue;
      this.#preCancelled.delete(transferId);
    }
  }

  #setTransfer(transfer: FilesServiceTransfer): void {
    this.#transfers.delete(transfer.id);
    this.#transfers.set(transfer.id, transfer);
    this.#pruneTerminalTransfers();
  }

  #pruneTerminalTransfers(): void {
    let terminal = 0;
    for (const [transferId, transfer] of this.#transfers) {
      if (
        isTerminalTransferPhase(transfer.phase) &&
        !this.#transferIsActiveOrRecoverable(transferId)
      ) {
        terminal += 1;
      }
    }
    if (terminal <= MAX_TERMINAL_TRANSFER_ROWS) return;
    for (const [transferId, transfer] of this.#transfers) {
      if (terminal <= MAX_TERMINAL_TRANSFER_ROWS) break;
      if (
        !isTerminalTransferPhase(transfer.phase) ||
        this.#transferIsActiveOrRecoverable(transferId)
      ) {
        continue;
      }
      this.#transfers.delete(transferId);
      terminal -= 1;
    }
  }

  #transferIsActiveOrRecoverable(transferId: string): boolean {
    return (
      this.#activeReads.has(transferId) ||
      this.#activeWrites.has(transferId) ||
      this.#uploads.has(transferId) ||
      this.#recoveries.has(transferId)
    );
  }

}

export function createDefaultFilesResidentPort(): FilesResidentFilePort {
  return new DefaultFilesResidentPort();
}

class SequentialUploadSource implements FilesTransferSource {
  readonly name = "upload";
  readonly type = "application/octet-stream";
  readonly #parts: Uint8Array[] = [];
  #buffered = 0;
  #consumed = 0;
  #waiting: {
    start: number;
    end: number;
    resolve: (value: Uint8Array) => void;
    reject: (error: Error) => void;
  } | null = null;
  readonly #backpressure: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  #failure: Error | null = null;
  #firstSlice: Uint8Array | null = null;
  readonly #maxBufferedBytes: number;
  readonly #backpressureThreshold: number;

  constructor(
    readonly size: number,
    maxBufferedBytes: number =
      FILES_V2_LIMITS.normalPlaintextBlockBytes * 2,
    backpressureThreshold: number =
      FILES_V2_LIMITS.normalPlaintextBlockBytes,
  ) {
    if (
      !Number.isSafeInteger(maxBufferedBytes) ||
      !Number.isSafeInteger(backpressureThreshold) ||
      maxBufferedBytes < 0 ||
      backpressureThreshold < 0 ||
      backpressureThreshold > maxBufferedBytes
    ) {
      throw new Error("Files sequential upload buffer limits are invalid");
    }
    this.#maxBufferedBytes = maxBufferedBytes;
    this.#backpressureThreshold = backpressureThreshold;
  }

  slice(start: number, end: number): Promise<Uint8Array> {
    if (
      this.#failure ||
      this.#waiting !== null ||
      start !== this.#consumed ||
      end < start ||
      end > this.size
    ) {
      return Promise.reject(
        this.#failure ??
          new Error("Files sequential upload source was read out of order"),
      );
    }
    return new Promise((resolve, reject) => {
      this.#waiting = { start, end, resolve, reject };
      this.#drain();
    });
  }

  push(bytes: Uint8Array): Promise<void> {
    if (this.#failure) throw this.#failure;
    if (
      !(bytes instanceof Uint8Array) ||
      this.#consumed + this.#buffered + bytes.byteLength > this.size ||
      this.#buffered + bytes.byteLength > this.#maxBufferedBytes
    ) {
      throw new Error("Files sequential upload buffer is invalid");
    }
    this.#parts.push(bytes);
    this.#buffered += bytes.byteLength;
    this.#drain();
    if (this.#buffered <= this.#backpressureThreshold) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.#backpressure.push({ resolve, reject });
    });
  }

  rewindFirstSlice(): void {
    if (
      this.#failure !== null ||
      this.#waiting !== null ||
      this.#firstSlice === null ||
      this.#consumed !== this.#firstSlice.byteLength ||
      this.#buffered + this.#firstSlice.byteLength >
        Math.max(
          this.#maxBufferedBytes,
          FILES_V2_LIMITS.normalPlaintextBlockBytes * 3,
        )
    ) {
      throw new Error("Files upload cannot replay its first block");
    }
    if (this.#firstSlice.byteLength > 0) {
      this.#parts.unshift(this.#firstSlice.slice());
      this.#buffered += this.#firstSlice.byteLength;
    }
    this.#consumed = 0;
  }

  releaseFirstSlice(): void {
    this.#firstSlice?.fill(0);
    this.#firstSlice = null;
  }

  fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    for (const part of this.#parts) part.fill(0);
    this.#parts.length = 0;
    this.#buffered = 0;
    this.releaseFirstSlice();
    const waiting = this.#waiting;
    this.#waiting = null;
    waiting?.reject(error);
    for (const pending of this.#backpressure.splice(0)) {
      pending.reject(error);
    }
  }

  #drain(): void {
    const waiting = this.#waiting;
    if (!waiting) return;
    const length = waiting.end - waiting.start;
    if (this.#buffered < length) return;
    const output = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const part = this.#parts[0]!;
      const take = Math.min(part.byteLength, length - offset);
      output.set(part.subarray(0, take), offset);
      offset += take;
      this.#buffered -= take;
      if (take === part.byteLength) {
        part.fill(0);
        this.#parts.shift();
      } else {
        const remainder = part.slice(take);
        part.fill(0);
        this.#parts[0] = remainder;
      }
    }
    if (this.#consumed === 0 && this.#firstSlice === null) {
      this.#firstSlice = output.slice();
    }
    this.#consumed += length;
    this.#waiting = null;
    waiting.resolve(output);
    if (this.#buffered <= this.#backpressureThreshold) {
      for (const pending of this.#backpressure.splice(0)) {
        pending.resolve();
      }
    }
  }
}

async function hashSourceForPlan(
  source: FilesTransferSource,
  strictText: boolean,
  controls: FilesTransferControls,
): Promise<Uint8Array> {
  const hash = nobleSha256.create();
  const decoder = strictText
    ? new TextDecoder("utf-8", { fatal: true })
    : null;
  let offset = 0;
  try {
    while (offset < source.size) {
      throwIfAborted(controls.signal);
      const end = Math.min(
        source.size,
        offset + FILES_V2_LIMITS.normalPlaintextBlockBytes,
      );
      const value = await source.slice(offset, end);
      const bytes =
        value instanceof Blob
          ? new Uint8Array(await value.arrayBuffer())
          : value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : value.slice();
      if (bytes.byteLength !== end - offset) {
        bytes.fill(0);
        throw serviceFault("invalid", "Files source changed while hashing");
      }
      hash.update(bytes);
      if (decoder) decoder.decode(bytes, { stream: end !== source.size });
      bytes.fill(0);
      offset = end;
      controls.onProgress?.({
        phase: "hashing",
        plaintextBytes: source.size,
        processedBytes: offset,
        blockIndex: 0,
        blockCount: 1,
      });
    }
    if (source.size === 0 && decoder) decoder.decode();
    return hash.digest();
  } catch (error) {
    if (error instanceof FilesServiceFault) throw error;
    throw serviceFault("invalid", "Files text is not strict UTF-8", error);
  } finally {
    hash.destroy();
  }
}

async function workerNameTag(
  crypto: FilesCryptoPort,
  parentNodeId: FilesId128V2,
  name: string,
): Promise<Uint8Array> {
  const result = await crypto.call({
    type: "name_tag",
    parentNodeId,
    filename: name,
  });
  if (result.type !== "name_tag") {
    throw serviceFault("incompatible", "Files worker omitted a name tag");
  }
  return result.nameTag;
}

async function encryptNodeMetadata(
  crypto: FilesCryptoPort,
  transition: FilesNodeTransition,
  metadata: FilesFolderMetadata | FilesFileMetadata,
): Promise<Uint8Array> {
  const plaintext = encodeFilesMetadata(metadata);
  const binding: FilesMetadataBinding = {
    nodeId: transition.nodeId,
    parentId: transition.proposedParentId,
    nodeKind: transition.requestedKind,
    metadataRevision: transition.proposedMetadataRevision,
    declaredNameScalars: transition.declaredNameScalars,
    nameTag: transition.proposedNameTag,
  };
  const result = await crypto.call({
    type: "encrypt_metadata",
    binding,
    plaintext,
  });
  if (result.type !== "metadata_encrypted") {
    throw serviceFault(
      "incompatible",
      "Files worker omitted encrypted metadata",
    );
  }
  return result.ciphertext;
}

function newNodeTransition(input: {
  nodeId: FilesId128V2;
  parentId: FilesId128V2;
  kind: "folder" | "file";
  nameTag: Uint8Array;
  nameScalars: number;
  plaintextBytes: number;
}): FilesNodeTransition {
  return Object.freeze({
    nodeId: input.nodeId,
    expectedParentId: null,
    proposedParentId: input.parentId,
    requestedKind: input.kind,
    expectedNameTag: null,
    proposedNameTag: input.nameTag,
    declaredNameScalars: input.nameScalars,
    expectedStructuralRevision: null,
    proposedStructuralRevision: "1" as CanonicalNat64,
    expectedMetadataRevision: null,
    proposedMetadataRevision: "1" as CanonicalNat64,
    expectedChildrenRevision: null,
    proposedChildrenRevision: ZERO,
    expectedSubtreeHeight: null,
    proposedSubtreeHeight: 0,
    expectedMaxRelativePathScalars: null,
    proposedMaxRelativePathScalars: input.nameScalars,
    expectedSubtreePlaintextBytes: null,
    proposedSubtreePlaintextBytes:
      input.plaintextBytes.toString() as CanonicalNat64,
  });
}

function transitionFromNode(
  node: FilesNodeRecord,
  proposed: Partial<Readonly<{
    proposedParentId: FilesId128V2;
    proposedNameTag: Uint8Array;
    declaredNameScalars: number;
    proposedStructuralRevision: CanonicalNat64;
    proposedMetadataRevision: CanonicalNat64;
    proposedChildrenRevision: CanonicalNat64;
    proposedSubtreeHeight: number;
    proposedMaxRelativePathScalars: number;
    proposedSubtreePlaintextBytes: CanonicalNat64;
  }>>,
): FilesNodeTransition {
  return Object.freeze({
    nodeId: node.node.nodeId,
    expectedParentId: node.node.parentId,
    proposedParentId:
      proposed.proposedParentId ?? node.node.parentId,
    requestedKind: node.node.kind,
    expectedNameTag: node.node.nameTag,
    proposedNameTag:
      proposed.proposedNameTag ?? node.node.nameTag,
    declaredNameScalars:
      proposed.declaredNameScalars ?? node.node.declaredNameScalars,
    expectedStructuralRevision: node.node.structuralRevision,
    proposedStructuralRevision:
      proposed.proposedStructuralRevision ??
      node.node.structuralRevision,
    expectedMetadataRevision: node.node.metadataRevision,
    proposedMetadataRevision:
      proposed.proposedMetadataRevision ?? node.node.metadataRevision,
    expectedChildrenRevision: node.node.childrenRevision,
    proposedChildrenRevision:
      proposed.proposedChildrenRevision ?? node.node.childrenRevision,
    expectedSubtreeHeight: node.node.subtreeHeight,
    proposedSubtreeHeight:
      proposed.proposedSubtreeHeight ?? node.node.subtreeHeight,
    expectedMaxRelativePathScalars:
      node.node.maxRelativePathScalars,
    proposedMaxRelativePathScalars:
      proposed.proposedMaxRelativePathScalars ??
      node.node.maxRelativePathScalars,
    expectedSubtreePlaintextBytes:
      node.node.subtreePlaintextBytes,
    proposedSubtreePlaintextBytes:
      proposed.proposedSubtreePlaintextBytes ??
      node.node.subtreePlaintextBytes,
  });
}

type AggregateAccumulator = FilesNodeRecord;

function accumulateAggregateChange(
  aggregates: Map<string, AggregateAccumulator>,
  chain: readonly FilesNodeRecord[],
  _plaintextDelta: number,
  _directMembershipChanged: boolean,
  _childName: string,
  _childHeight: number,
  _childMaxRelativePathScalars: number,
): void {
  for (const folder of chain) {
    aggregates.set(filesId128ToKey(folder.node.nodeId), folder);
  }
}

function finalizeAggregateTransitions(
  aggregates: ReadonlyMap<string, AggregateAccumulator>,
): FilesFolderAggregateTransition[] {
  return [...aggregates.values()]
    .sort(compareNodeRecordsById)
    .map(folder => Object.freeze({
      nodeId: folder.node.nodeId,
      expectedStructuralRevision: folder.node.structuralRevision,
      expectedChildrenRevision: folder.node.childrenRevision,
    }));
}

function propagateAggregateChange(
  chain: readonly FilesNodeRecord[],
  plaintextDelta: number,
  directMembershipChanged: boolean,
  childName: string,
  childHeight: number,
  childMaxRelativePathScalars: number,
): FilesFolderAggregateTransition[] {
  const aggregates = new Map<string, AggregateAccumulator>();
  accumulateAggregateChange(
    aggregates,
    chain,
    plaintextDelta,
    directMembershipChanged,
    childName,
    childHeight,
    childMaxRelativePathScalars,
  );
  return finalizeAggregateTransitions(aggregates);
}

function compareNodeRecordsById(
  left: FilesNodeRecord,
  right: FilesNodeRecord,
): number {
  const leftHi = BigInt(left.node.nodeId.hi);
  const rightHi = BigInt(right.node.nodeId.hi);
  if (leftHi < rightHi) return -1;
  if (leftHi > rightHi) return 1;
  const leftLo = BigInt(left.node.nodeId.lo);
  const rightLo = BigInt(right.node.nodeId.lo);
  return leftLo < rightLo ? -1 : leftLo > rightLo ? 1 : 0;
}

async function pathChain(
  vault: FilesVaultEngine,
  path: string,
): Promise<FilesNodeRecord[]> {
  const canonical = canonicalizeFilesPath(path);
  const root = await vault.lookupPath("/");
  const chain: FilesNodeRecord[] = [root];
  let current = root;
  for (const segment of canonical.segments) {
    const next = await vault.lookupChild(current, segment);
    if (next.node.kind !== "folder") {
      throw serviceFault("conflict", "Files path prefix is not a folder");
    }
    chain.push(next);
    current = next;
  }
  return chain;
}

async function lookupMaybe(
  vault: FilesVaultEngine,
  path: string,
): Promise<FilesNodeRecord | null> {
  try {
    return await vault.lookupPath(path);
  } catch (error) {
    if (error instanceof FilesVaultEngineFault && error.code === "not_found") {
      return null;
    }
    throw mapFault(error);
  }
}

async function lookupChildMaybe(
  vault: FilesVaultEngine,
  parent: FilesNodeRecord,
  name: string,
): Promise<FilesNodeRecord | null> {
  try {
    return await vault.lookupChild(parent, name);
  } catch (error) {
    if (error instanceof FilesVaultEngineFault && error.code === "not_found") {
      return null;
    }
    throw mapFault(error);
  }
}

function serviceEntry(
  path: string,
  record: FilesNodeRecord,
): FilesServiceEntry {
  const metadata = record.metadata;
  return Object.freeze({
    path,
    name: metadata.name,
    type: metadata.nodeKind,
    nodeId: null,
    opaqueNodeIdentity: filesId128ToKey(record.node.nodeId),
    contentKind:
      metadata.nodeKind === "file"
        ? metadata.contentKind === "text_v1"
          ? "text"
          : "binary"
        : null,
    byteLength:
      metadata.nodeKind === "file" ? metadata.plaintextBytes : null,
    mediaType: metadata.nodeKind === "file" ? metadata.mimeType : null,
    etagSha256:
      metadata.nodeKind === "file"
        ? digestHex(metadata.plaintextSha256)
        : null,
    createdAtNs: metadata.createdAtNs,
    modifiedAtNs: metadata.modifiedAtNs,
    structuralRevision: record.node.structuralRevision,
    contentId:
      record.content === null
        ? null
        : filesId128ToKey(record.content.contentId),
  });
}

function compareServiceEntriesByDecryptedName(
  left: FilesServiceEntry,
  right: FilesServiceEntry,
): number {
  if (left.type !== right.type) return left.type === "folder" ? -1 : 1;
  return (
    compareCanonicalUnicode(left.name, right.name) ||
    compareCanonicalUnicode(left.path, right.path)
  );
}

function compareCanonicalUnicode(left: string, right: string): number {
  const leftScalars = Array.from(left.normalize("NFC"));
  const rightScalars = Array.from(right.normalize("NFC"));
  const length = Math.min(leftScalars.length, rightScalars.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftScalars[index]!.codePointAt(0)!;
    const rightPoint = rightScalars[index]!.codePointAt(0)!;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
  }
  return leftScalars.length < rightScalars.length
    ? -1
    : leftScalars.length > rightScalars.length
      ? 1
      : 0;
}

function committedWriteResult(
  path: string,
  item: FilesWriteItem,
  receipt: FilesWriteReceipt,
): FilesServiceWriteResult {
  if (item.metadata.nodeKind !== "file") {
    throw serviceFault(
      "incompatible",
      "Files committed receipt target is not a file",
    );
  }
  const committed = receipt.committedNodes.find((node) =>
    sameFilesId(node.node_id, item.transition.nodeId)
  );
  if (
    committed === undefined ||
    committed.content_id === null ||
    committed.structural_revision !==
      item.transition.proposedStructuralRevision ||
    committed.metadata_revision !== item.transition.proposedMetadataRevision
  ) {
    throw serviceFault(
      "incompatible",
      "Files committed receipt changed its file binding",
    );
  }
  const metadata = item.metadata;
  return Object.freeze({
    entry: Object.freeze({
      path,
      name: metadata.name,
      type: "file",
      nodeId: null,
      opaqueNodeIdentity: filesId128ToKey(committed.node_id),
      contentKind:
        metadata.contentKind === "text_v1" ? "text" : "binary",
      byteLength: metadata.plaintextBytes,
      mediaType: metadata.mimeType,
      etagSha256: digestHex(metadata.plaintextSha256),
      createdAtNs: metadata.createdAtNs,
      modifiedAtNs: metadata.modifiedAtNs,
      structuralRevision: committed.structural_revision,
      contentId: filesId128ToKey(committed.content_id),
    }),
    cleanupPending: receipt.cleanupPending,
  });
}

function publicUsage(bootstrap: FilesBootstrapOkV2): FilesServicePublicUsage {
  return Object.freeze({
    current: mapPublicCounters(bootstrap.public_usage.current),
    manifestLimits: mapPublicLimits(
      bootstrap.public_usage.manifest_limits,
    ),
    effectiveLimits: mapPublicLimits(
      bootstrap.public_usage.effective_limits,
    ),
  });
}

function mapPublicCounters(
  value: FilesPublicUsageCountersV2,
): FilesServicePublicUsage["current"] {
  return Object.freeze({
    liveEntries: value.live_entries,
    occupiedEntrySlots: value.occupied_entry_slots,
    committedBodyBytes: value.committed_body_bytes,
    reservedCommittedBodyBytes: value.reserved_committed_body_bytes,
    reservedEntrySlots: value.reserved_entry_slots,
    allocatedBodyBytes: value.allocated_body_bytes,
    chargedMetadataBytes: value.charged_metadata_bytes,
    acceptedStagedBytes: value.accepted_staged_bytes,
    reservedStagedBytes: value.reserved_staged_bytes,
    detachedChargedBytes: value.detached_charged_bytes,
    activeStages: value.active_stages,
    receiptLanes: value.receipt_lanes,
    generalReceiptLanes: value.general_receipt_lanes,
    reservedGeneralReceiptLanes: value.reserved_general_receipt_lanes,
    reservedRevocationLanes: value.reserved_revocation_lanes,
    filledRevocationLanes: value.filled_revocation_lanes,
    receiptNonceIndexes: value.receipt_nonce_indexes,
    receiptExpiryIndexes: value.receipt_expiry_indexes,
    cleanupJobs: value.cleanup_jobs,
  });
}

function mapPublicLimits(
  value: FilesPublicUsageLimitsV2,
): FilesServicePublicUsage["effectiveLimits"] {
  return Object.freeze({
    entries: value.entries,
    committedBytes: value.committed_bytes,
    objectBytes: value.object_bytes,
    stagedBytes: value.staged_bytes,
    pendingStages: value.pending_stages,
    batchOperations: value.batch_operations,
    batchBytes: value.batch_bytes,
    generalReceipts: value.general_receipts,
    revocationLanes: value.revocation_lanes,
  });
}

function zeroPublicCounters(): FilesServicePublicUsage["current"] {
  return mapPublicCounters({
    live_entries: ZERO,
    occupied_entry_slots: ZERO,
    committed_body_bytes: ZERO,
    reserved_committed_body_bytes: ZERO,
    reserved_entry_slots: ZERO,
    allocated_body_bytes: ZERO,
    charged_metadata_bytes: ZERO,
    accepted_staged_bytes: ZERO,
    reserved_staged_bytes: ZERO,
    detached_charged_bytes: ZERO,
    active_stages: ZERO,
    receipt_lanes: ZERO,
    general_receipt_lanes: ZERO,
    reserved_general_receipt_lanes: ZERO,
    reserved_revocation_lanes: ZERO,
    filled_revocation_lanes: ZERO,
    receipt_nonce_indexes: ZERO,
    receipt_expiry_indexes: ZERO,
    cleanup_jobs: ZERO,
  });
}

function zeroPublicLimits(): FilesServicePublicUsage["effectiveLimits"] {
  return mapPublicLimits({
    entries: ZERO,
    committed_bytes: ZERO,
    object_bytes: ZERO,
    staged_bytes: ZERO,
    pending_stages: ZERO,
    batch_operations: ZERO,
    batch_bytes: ZERO,
    general_receipts: ZERO,
    revocation_lanes: ZERO,
  });
}

function uploadResult(
  session: UploadSession,
  committed: boolean,
  readyForUpload: boolean,
  entry: FilesServiceEntry | null,
) {
  return Object.freeze({
    transferId: session.id,
    phase: session.phase,
    processedBytes: Math.max(session.hashBytes, session.encryptBytes),
    totalBytes: session.totalBytes,
    committed,
    readyForUpload,
    entry,
  });
}

function uploadPath(path: string, name: string): string {
  const canonical = canonicalizeFilesPath(path);
  if (canonical.segments.at(-1) === name) return canonical.path;
  return joinPath(canonical.path, name);
}

function parentPath(path: string): string {
  const canonical = canonicalizeFilesPath(path);
  if (canonical.segments.length < 1) {
    throw serviceFault("invalid", "The Files root has no parent");
  }
  return canonical.segments.length === 1
    ? "/"
    : `/${canonical.segments.slice(0, -1).join("/")}`;
}

function joinPath(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

function renameMetadata(
  metadata: FilesNodeRecord["metadata"],
  name: string,
  modifiedAtNs: CanonicalNat64,
): FilesNodeRecord["metadata"] {
  return metadata.nodeKind === "folder"
    ? { ...metadata, name, modifiedAtNs }
    : {
        ...metadata,
        name,
        modifiedAtNs,
        plaintextSha256: metadata.plaintextSha256.slice(),
      };
}

function encryptedMetadataBytes(
  metadata: FilesNodeRecord["metadata"],
): number {
  const plaintext = encodeFilesMetadata(metadata);
  try {
    return plaintext.byteLength + FILES_AES_GCM_TAG_BYTES;
  } finally {
    plaintext.fill(0);
  }
}

function bytesSource(bytes: Uint8Array): FilesTransferSource {
  return {
    size: bytes.byteLength,
    slice: (start, end) => bytes.slice(start, end),
  };
}

function digestHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

function nowNat64(): CanonicalNat64 {
  const value = BigInt(Date.now()) * 1_000_000n;
  return value.toString() as CanonicalNat64;
}

function cleanupPending(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    throw serviceFault(
      "incompatible",
      "Files cleanup state used an unknown variant",
    );
  }
  if ("pending" in value) return true;
  if ("clean" in value) return false;
  throw serviceFault(
    "incompatible",
    "Files cleanup state used an unknown variant",
  );
}

function mutationResult(
  path: string,
  status: FilesVaultStatus,
  changed: number,
  pending: boolean,
): FilesServiceMutationResult {
  return Object.freeze({
    path,
    structuralRevision:
      status.state === "ready" ? status.root.node.structuralRevision : ZERO,
    changed,
    cleanupPending: pending,
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
}

function linkAbortSignal(
  parent: AbortSignal | undefined,
  controller: AbortController,
): () => void {
  if (!parent) return () => undefined;
  const abort = (): void => controller.abort();
  if (parent.aborted) {
    controller.abort();
    return () => undefined;
  }
  parent.addEventListener("abort", abort, { once: true });
  return () => parent.removeEventListener("abort", abort);
}

function isCodedCancellation(error: unknown): boolean {
  return (
    (error instanceof FilesServiceFault ||
      error instanceof FilesVaultEngineFault ||
      error instanceof FilesTransferEngineFault) &&
    error.code === "cancelled"
  );
}

function isTransferCancellation(
  error: unknown,
  signal: AbortSignal,
): boolean {
  if (
    (error instanceof FilesServiceFault ||
      error instanceof FilesVaultEngineFault ||
      error instanceof FilesTransferEngineFault) &&
    error.code !== "cancelled"
  ) {
    return false;
  }
  return (
    signal.aborted ||
    isCodedCancellation(error) ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

function transferFailurePhase(error: unknown): FilesTransferPhase {
  if (isKnownUploadConflict(error)) return "conflicted";
  if (
    (error instanceof FilesServiceFault ||
      error instanceof FilesTransferEngineFault) &&
    error.code === "uncertain"
  ) {
    return "checking-outcome";
  }
  return "failed";
}

function isTerminalTransferPhase(phase: FilesTransferPhase): boolean {
  return (
    phase === "committed" ||
    phase === "cancelled" ||
    phase === "conflicted" ||
    phase === "failed" ||
    phase === "cleanup-pending"
  );
}

function serviceFault(
  code: FilesServiceFault["code"],
  message: string,
  cause?: unknown,
): FilesServiceFault {
  return new FilesServiceFault(
    code,
    message,
    code === "needs_user_unlock"
      ? "Open Files and unlock the vault"
      : "Retry after refreshing Files",
    {},
    cause === undefined ? {} : { cause },
  );
}

function mapFault(error: unknown): FilesServiceFault {
  if (error instanceof FilesServiceFault) return error;
  if (error instanceof FilesVaultEngineFault) {
    return serviceFault(
      error.code === "not_found"
        ? "not_found"
        : error.code === "needs_user_unlock"
          ? "needs_user_unlock"
          : error.code === "conflict"
            ? "conflict"
            : error.code === "incompatible"
              ? "incompatible"
              : error.code === "cancelled"
                ? "cancelled"
                : "vault_unrecoverable",
      error.message,
      error,
    );
  }
  if (error instanceof FilesTransferEngineFault) {
    const code =
      error.code === "corrupt_state"
        ? "incompatible"
        : error.code;
    return serviceFault(code, error.message, error);
  }
  return serviceFault("temporarily_unavailable", errorMessage(error), error);
}

function isKnownUploadConflict(error: unknown): boolean {
  return (
    (error instanceof FilesServiceFault ||
      error instanceof FilesVaultEngineFault ||
      error instanceof FilesTransferEngineFault) &&
    error.code === "conflict"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
