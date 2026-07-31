import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { kernelParentOriginFromAppUrl } from "neutron-tools/src/runtime.js";
import {
  FilesPlainBackendAdapter,
  FilesPlainBackendError,
  FilesPlainBackendProtocolError,
  type FilesPlainCursor,
  type FilesPlainEntry,
  type FilesPlainList,
  type FilesPlainSpace,
  type FilesPlainWriteInput,
  type FilesPlainWriteMoveSource,
  type FilesPlainWriteResult,
} from "../protocol/plain_backend_adapter.ts";
import type { CanonicalNat64 } from "../protocol/types.ts";
import {
  FILES_V2_LIMITS,
} from "../protocol/constants.ts";
import type {
  FilesTransferControls,
  FilesTransferPhase,
  FilesTransferSource,
} from "../vault/types.ts";
import {
  FILES_SERVICE_LIMITS,
  FilesServiceFault,
  type FilesResidentFilePort,
  type FilesServiceEntry,
  type FilesServiceFile,
  type FilesServiceListPage,
  type FilesServiceMoveSource,
  type FilesServiceMutationResult,
  type FilesServiceRemovePrecondition,
  type FilesServiceStatus,
  type FilesServiceTransfer,
  type FilesServiceWriteResult,
} from "./service_contract.ts";
import {
  parseFilesRootedPath,
  sharedPresentationForPath,
} from "./storage_roots.ts";
import {
  isCanonicalPlainFilesName,
  isCanonicalPlainFilesPath,
  normalizePlainFilesPath,
} from "../protocol/plain_paths.ts";
import type { FilesAuthorityResetReason } from "./authority.ts";

const ZERO = "0" as CanonicalNat64;
const PLAIN_BLOCK_BYTES = FILES_V2_LIMITS.normalPlaintextBlockBytes;
const PLAIN_FILE_BYTES = FILES_V2_LIMITS.binaryFileBytes;
const PLAIN_PATH_BYTES = 1_024;
const MAX_PLAIN_BLOCKS = 36;
const MAX_TERMINAL_TRANSFERS = 128;
const MAX_ACTIVE_PLAIN_UPLOADS = 1;
const MAX_DEFERRED_RESIDENT_BYTES = PLAIN_FILE_BYTES;
const PLAIN_UPLOAD_INACTIVITY_MS = 120_000;

type PlainTransferDisposition = "active" | "cancelled" | "cleared";

type PlainTrackedTransfer = {
  transferId: string;
  requestId: string;
  path: string;
  space: FilesPlainSpace;
  relativePath: string;
  name: string;
  totalBytes: number;
  stageId: CanonicalNat64 | null;
  result: FilesServiceEntry | null;
  phase: FilesTransferPhase;
  error: string | null;
  disposition: PlainTransferDisposition;
};

type PlainUploadSession = PlainTrackedTransfer & {
  contentKind: "text" | "binary";
  mediaType: string;
  blockCount: number;
  hash: ReturnType<typeof nobleSha256.create>;
  hashBytes: number;
  nextHashOrdinal: number;
  digestHex: string | null;
  uploadHash: ReturnType<typeof nobleSha256.create>;
  uploadHashBytes: number;
  nextUploadOrdinal: number;
  uploadMode: "direct" | "deferred" | null;
  deferredBodies: Array<Uint8Array | null> | null;
  deferredBufferedBytes: number;
  deferredCommit: Promise<void> | null;
  inactivityEpoch: number;
  cancelInactivityTimer: (() => void) | null;
  beginNonce: Uint8Array;
  commitNonce: Uint8Array;
  deleteNonce: Uint8Array;
};

type PlainWriteSession = PlainTrackedTransfer & {
  contentKind: "text" | "binary";
  mediaType: string;
  etagSha256: string | null;
  processedBytes: number;
};

type PlainWriteExpectation = Readonly<{
  space: FilesPlainSpace;
  relativePath: string;
  contentKind: "text" | "binary";
  mediaType: string;
  totalBytes: number;
  etagSha256: string;
  expectedNodeId: CanonicalNat64 | null;
  expectedRevision: CanonicalNat64 | null;
  ifNoneMatch: boolean;
  moveSource: FilesPlainWriteMoveSource | null;
}>;

type PlainOperationFence = Readonly<{
  epoch: number;
  authoritySignal: AbortSignal;
}>;

export type DefaultFilesPlainPortDependencies = Readonly<{
  backend?: FilesPlainBackendAdapter;
  fetchPublic?: typeof fetch;
  publicBaseUrl?: () => string;
  uploadInactivityMs?: number;
  maxDeferredResidentBytes?: number;
  scheduleUploadTimer?: (
    callback: () => void,
    delayMs: number,
  ) => () => void;
}>;

export class DefaultFilesPlainPort
  implements FilesResidentFilePort<FilesPlainCursor> {
  readonly #backend: FilesPlainBackendAdapter;
  readonly #fetchPublic: typeof fetch;
  readonly #publicBaseUrl: () => string;
  readonly #uploadInactivityMs: number;
  readonly #maxDeferredResidentBytes: number;
  readonly #scheduleUploadTimer: (
    callback: () => void,
    delayMs: number,
  ) => () => void;
  readonly #uploads = new Map<string, PlainUploadSession>();
  readonly #writes = new Map<string, PlainWriteSession>();
  readonly #transfers = new Map<string, FilesServiceTransfer>();
  #authorityEpoch = 0;
  #authorityController = new AbortController();
  #deferredResidentBytes = 0;
  readonly #transferOwners = new Map<string, PlainTrackedTransfer>();
  readonly #statusListeners = new Set<(
    reason:
      | "inactivity"
      | "worker_failure"
      | "authority_changed"
      | "state_changed",
  ) => void>();

  constructor(dependencies: DefaultFilesPlainPortDependencies = {}) {
    this.#backend = dependencies.backend ?? new FilesPlainBackendAdapter();
    this.#fetchPublic = dependencies.fetchPublic ?? globalThis.fetch.bind(globalThis);
    this.#uploadInactivityMs =
      dependencies.uploadInactivityMs ?? PLAIN_UPLOAD_INACTIVITY_MS;
    this.#maxDeferredResidentBytes =
      dependencies.maxDeferredResidentBytes ??
      MAX_DEFERRED_RESIDENT_BYTES;
    this.#scheduleUploadTimer =
      dependencies.scheduleUploadTimer ?? schedulePlainUploadTimer;
    if (
      !Number.isSafeInteger(this.#uploadInactivityMs) ||
      this.#uploadInactivityMs < 1 ||
      this.#uploadInactivityMs > PLAIN_UPLOAD_INACTIVITY_MS
    ) {
      throw new TypeError("Files upload inactivity must be a positive integer");
    }
    if (
      !Number.isSafeInteger(this.#maxDeferredResidentBytes) ||
      this.#maxDeferredResidentBytes < 0 ||
      this.#maxDeferredResidentBytes > MAX_DEFERRED_RESIDENT_BYTES
    ) {
      throw new TypeError("Files deferred upload capacity is invalid");
    }
    this.#publicBaseUrl =
      dependencies.publicBaseUrl ??
      (() => {
        if (typeof location === "undefined") {
          throw new Error("Files public URLs require a browser origin");
        }
        return filesCanonicalPublicOrigin(location.href);
      });
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

  status(): Promise<FilesServiceStatus> {
    return Promise.resolve({
      vault: "ready",
      lockEpoch: ZERO,
      currentGeneration: null,
      previousGeneration: null,
      rotationRequired: false,
      reason: null,
      quota: {
        nodes: ZERO,
        plaintextBytes: ZERO,
        ciphertextBytes: ZERO,
        physicalBytes: ZERO,
        cleanupJobs: 0,
      },
      publicUsage: emptyPublicUsage(),
      transfers: [...this.#transfers.values()],
    });
  }

  async initialize(): Promise<FilesServiceStatus> {
    // Startup cleanup is bounded. Every mutating backend endpoint also reaps
    // a small number opportunistically, so a transient cleanup failure does
    // not make Workspace or Shared unavailable.
    await this.#backend.cleanup({
      requestId: randomHex(16),
      limit: 3,
    }).catch(() => undefined);
    return this.status();
  }

  unlock(): Promise<FilesServiceStatus> {
    return this.status();
  }

  lock(): Promise<FilesServiceStatus> {
    return this.status();
  }

  rotate(): Promise<FilesServiceStatus> {
    return this.status();
  }

  async list(input: {
    path: string;
    cursor: FilesPlainCursor | null;
    expectedFolderRevision: CanonicalNat64 | null;
    limit: number;
    recursive: boolean;
    signal?: AbortSignal;
  }): Promise<FilesServiceListPage<FilesPlainCursor>> {
    const fence = this.#captureOperationFence(input.signal);
    if (input.recursive) {
      throw new FilesServiceFault(
        "invalid",
        "Plain folders are listed one level at a time",
        "Expand folders as needed",
      );
    }
    const location = plainLocation(input.path);
    try {
      const page = await this.#awaitFencedQuery(
        this.#backend.list({
          space: location.space,
          path: location.relativePath,
          cursor: input.cursor,
          limit: input.limit,
        }),
        fence,
        input.signal,
      );
      assertPlainListResponse(
        location.space,
        location.relativePath,
        input.cursor,
        input.limit,
        page,
      );
      if (
        input.expectedFolderRevision !== null &&
        page.revision !== input.expectedFolderRevision
      ) {
        throw conflict("The folder changed while it was being listed");
      }
      this.#assertOperationFence(fence, input.signal);
      return {
        path: location.path,
        folderRevision: page.revision,
        entries: page.entries.map((entry) =>
          serviceEntry(location.space, entry)
        ),
        total: page.total,
        cursor: page.cursor,
        hasMore: page.hasMore,
      };
    } catch (error) {
      throw serviceError(error);
    }
  }

  async stat(
    path: string,
    signal?: AbortSignal,
  ): Promise<FilesServiceEntry> {
    const fence = this.#captureOperationFence(signal);
    const location = plainLocation(path);
    try {
      const entry = await this.#awaitFencedQuery(
        this.#backend.stat({
          space: location.space,
          path: location.relativePath,
        }),
        fence,
        signal,
      );
      assertPlainEntryResponse(
        location.space,
        entry,
        location.relativePath,
      );
      this.#assertOperationFence(fence, signal);
      return serviceEntry(location.space, entry);
    } catch (error) {
      throw serviceError(error);
    }
  }

  async read(
    path: string,
    controls: FilesTransferControls &
      Readonly<{ transferId?: string }> = {},
  ): Promise<FilesServiceFile> {
    const fence = this.#captureOperationFence(controls.signal);
    const location = plainLocation(path);
    const linkedSignals =
      location.space === "shared"
        ? linkPlainOperationSignals(
            controls.signal,
            fence.authoritySignal,
          )
        : null;
    let bytes: Uint8Array | null = null;
    try {
      const entry = await this.stat(path, controls.signal);
      this.#assertOperationFence(fence, controls.signal);
      assertReadableEntry(entry, location.space);
      let publicResponse: Response | null = null;
      if (location.space === "shared") {
        const publicUrl = exactCertifiedShareUrl(
          entry.publicUrl,
          entry.path,
          this.#publicBaseUrl(),
        );
        publicResponse = await this.#awaitFencedQuery(
          this.#fetchPublic(publicUrl, {
            method: "GET",
            credentials: "omit",
            cache: "no-store",
            redirect: "error",
            signal: linkedSignals!.signal,
          }),
          fence,
          controls.signal,
          discardPublicResponse,
        );
        if (!publicResponse.ok) {
          throw new FilesServiceFault(
            "temporarily_unavailable",
            `The shared file returned HTTP ${publicResponse.status}`,
            "Try again",
          );
        }
        if (
          publicResponse.redirected ||
          (publicResponse.url !== "" &&
            publicResponse.url !== publicUrl.href)
        ) {
          throw integrityFault(
            "The shared-file response changed its address",
          );
        }
        assertPublicContentLength(publicResponse, entry.byteLength);
      }
      bytes = new Uint8Array(entry.byteLength);
      const digest = nobleSha256.create();
      let loaded = 0;
      if (location.space === "shared") {
        if (publicResponse === null) {
          throw integrityFault("The shared file response was unavailable");
        }
        loaded = await readPublicBody(
          publicResponse,
          bytes,
          digest,
          entry.byteLength,
          {
            ...controls,
            signal: linkedSignals!.signal,
          },
        );
      } else {
        const blockCount = canonicalReadBlockCount(entry.byteLength);
        for (let ordinal = 0; ordinal < blockCount; ordinal += 1) {
          this.#assertOperationFence(fence, controls.signal);
          const chunk = await this.#awaitFencedQuery(
            this.#backend.readChunk({
              space: location.space,
              path: location.relativePath,
              blockIndex: ordinal,
            }),
            fence,
            controls.signal,
            discardPlainReadChunk,
          );
          try {
            const chunkEntry = serviceEntry(location.space, chunk.entry);
            if (
              chunk.blockIndex !== ordinal ||
              chunk.blockCount !== blockCount ||
              !sameReadableSnapshot(entry, chunkEntry)
            ) {
              throw integrityFault(
                "The stored file changed while it was being read",
              );
            }
            const expectedBytes =
              ordinal + 1 === blockCount
                ? entry.byteLength - ordinal * PLAIN_BLOCK_BYTES
                : PLAIN_BLOCK_BYTES;
            if (
              chunk.body.byteLength !== expectedBytes ||
              chunk.body.byteLength > PLAIN_BLOCK_BYTES ||
              loaded + chunk.body.byteLength > bytes.byteLength
            ) {
              throw integrityFault(
                "The stored file returned an invalid data block",
              );
            }
            bytes.set(chunk.body, loaded);
            digest.update(chunk.body);
            loaded += chunk.body.byteLength;
          } finally {
            chunk.body.fill(0);
          }
          controls.onProgress?.({
            phase: "downloading",
            plaintextBytes: entry.byteLength,
            processedBytes: loaded,
            blockIndex: ordinal,
            blockCount,
          });
          this.#assertOperationFence(fence, controls.signal);
        }
      }
      if (
        loaded !== entry.byteLength ||
        hex(digest.digest()) !== entry.etagSha256
      ) {
        throw integrityFault("Files could not verify the stored bytes");
      }
      this.#assertOperationFence(fence, controls.signal);
      return {
        entry,
        bytes,
      };
    } catch (error) {
      bytes?.fill(0);
      this.#assertOperationFence(fence, controls.signal);
      throw serviceError(error);
    } finally {
      linkedSignals?.dispose();
    }
  }

  async write(
    input: {
      transferId?: string;
      path: string;
      source: FilesTransferSource;
      contentKind: "text" | "binary";
      mediaType: string;
      ifMatch: string | null;
      ifNoneMatch: boolean;
      createParents: boolean;
      moveSource?: FilesServiceMoveSource;
    },
    controls: FilesTransferControls = {},
  ): Promise<FilesServiceWriteResult> {
    const location = plainLocation(input.path);
    const effectiveContentKind = plainContentKind(
      location,
      input.contentKind,
    );
    const moveSource = plainWriteMoveSource(input.moveSource, location);
    validatePlainSize(input.source.size);
    if (input.ifMatch !== null && input.ifNoneMatch) {
      throw new FilesServiceFault(
        "invalid",
        "A write cannot require both an existing and a new destination",
        "Refresh the folder and try again",
      );
    }
    const resolveUnconditionalDestination =
      input.ifMatch === null &&
      !input.ifNoneMatch &&
      moveSource === null;
    const blockCount = canonicalBlockCount(input.source.size);
    const requestId = randomHex(16);
    const tokens = writeTokens();
    let tracked: PlainWriteSession | null = null;
    if (input.transferId !== undefined) {
      if (
        this.#uploads.has(input.transferId) ||
        this.#writes.has(input.transferId)
      ) {
        throw new FilesServiceFault(
          "conflict",
          "This transfer already exists",
          "Wait for it to finish",
        );
      }
      tracked = {
        transferId: input.transferId,
        requestId,
        path: location.path,
        space: location.space,
        relativePath: location.relativePath,
        name: input.source.name ?? safePublicName(location.path),
        totalBytes: input.source.size,
        stageId: null,
        result: null,
        phase: "hashing",
        error: null,
        disposition: "active",
        contentKind: effectiveContentKind,
        mediaType: input.mediaType,
        etagSha256: null,
        processedBytes: 0,
      };
      this.#writes.set(tracked.transferId, tracked);
      this.#transferOwners.set(tracked.transferId, tracked);
      this.#setTransfer(tracked, "hashing", 0, null);
    }

    let replacement: FilesServiceEntry | null = null;
    try {
      if (input.ifMatch !== null || resolveUnconditionalDestination) {
        try {
          replacement = await this.stat(input.path, controls.signal);
        } catch (error) {
          if (
            !resolveUnconditionalDestination ||
            !(error instanceof FilesServiceFault) ||
            error.code !== "not_found"
          ) {
            throw error;
          }
        }
      }
      this.#assertTrackedWriteActive(tracked);
      if (
        replacement !== null &&
        (
          replacement.type !== "file" ||
          replacement.etagSha256 === null ||
          (
            input.ifMatch !== null &&
            replacement.etagSha256 !== input.ifMatch
          )
        )
      ) {
        throw conflict("The destination changed before it could be replaced");
      }
    } catch (error) {
      if (tracked !== null) {
        throw await this.#failWrite(tracked, error);
      }
      throw error;
    }
    const effectiveIfMatch =
      replacement?.etagSha256 ?? input.ifMatch;
    const effectiveIfNoneMatch =
      replacement === null
        ? input.ifNoneMatch || resolveUnconditionalDestination
        : false;

    let stageId: CanonicalNat64 | null = null;
    let result: FilesPlainWriteResult | null = null;
    let etagSha256: string | null = null;
    let finalAttempted = false;
    let uploadDigest:
      | ReturnType<typeof nobleSha256.create>
      | null = null;
    let uploadBytes = 0;
    try {
      const digest = nobleSha256.create();
      try {
        for (let ordinal = 0; ordinal < blockCount; ordinal += 1) {
          throwIfAborted(controls.signal);
          const bytes = await sourceBlock(input.source, ordinal);
          try {
            this.#assertTrackedWriteActive(tracked);
            digest.update(bytes);
          } finally {
            bytes.fill(0);
          }
          const processedBytes = Math.min(
            input.source.size,
            (ordinal + 1) * PLAIN_BLOCK_BYTES,
          );
          if (tracked !== null) {
            tracked.processedBytes = processedBytes;
            this.#setTransfer(tracked, "hashing", processedBytes, null);
          }
          controls.onProgress?.({
            phase: "hashing",
            plaintextBytes: input.source.size,
            processedBytes,
            blockIndex: ordinal,
            blockCount,
          });
        }
        etagSha256 = digestHexAndWipe(digest);
      } finally {
        destroyHashQuietly(digest);
      }
      if (tracked !== null) tracked.etagSha256 = etagSha256;
      const expectation: PlainWriteExpectation = {
        space: location.space,
        relativePath: location.relativePath,
        contentKind: effectiveContentKind,
        mediaType: input.mediaType,
        totalBytes: input.source.size,
        etagSha256,
        expectedNodeId:
          replacement === null ? null : requirePlainNodeId(replacement),
        expectedRevision: replacement?.structuralRevision ?? null,
        ifNoneMatch: effectiveIfNoneMatch,
        moveSource,
      };

      uploadDigest = nobleSha256.create();
      for (let ordinal = 0; ordinal < blockCount; ordinal += 1) {
        throwIfAborted(controls.signal);
        this.#assertTrackedWriteActive(tracked);
        const bytes = await sourceBlock(input.source, ordinal);
        finalAttempted = ordinal + 1 === blockCount;
        const requestedStageId = stageId;
        try {
          const currentUploadDigest = uploadDigest;
          if (currentUploadDigest === null) {
            throw integrityFault("Files lost its upload verification state");
          }
          currentUploadDigest.update(bytes);
          uploadBytes += bytes.byteLength;
          if (finalAttempted) {
            const uploadEtagSha256 =
              digestHexAndWipe(currentUploadDigest);
            uploadDigest = null;
            if (
              uploadBytes !== input.source.size ||
              uploadEtagSha256 !== etagSha256
            ) {
              throw uploadSourceChangedFault();
            }
          }
          result = await this.#writeBlockWithReplay({
            requestId,
            space: location.space,
            path: location.relativePath,
            stageId,
            blockIndex: ordinal,
            blockCount,
            totalBytes: input.source.size,
            contentKind: effectiveContentKind,
            mediaType: input.mediaType,
            etagSha256,
            presentation: presentation(
              location.space,
              location.path,
              effectiveContentKind,
            ),
            ifMatch: effectiveIfMatch,
            expectedNodeId: expectation.expectedNodeId,
            expectedRevision: expectation.expectedRevision,
            ifNoneMatch: effectiveIfNoneMatch,
            createParents: input.createParents,
            final: finalAttempted,
            safeName:
              location.space === "shared"
                ? safePublicName(location.path)
                : null,
            beginNonce:
              location.space === "shared" && ordinal === 0
                ? tokens.beginNonce
                : null,
            commitNonce:
              location.space === "shared" && finalAttempted
                ? tokens.commitNonce
                : null,
            deleteNonce:
              location.space === "shared" && finalAttempted
                ? tokens.deleteNonce
                : null,
            moveSource,
            body: bytes,
          }, true, () =>
            !controls.signal?.aborted &&
            (tracked === null || this.#transferIsActive(tracked))
          );
          try {
            assertPlainWriteResult(
              result,
              finalAttempted,
              expectation,
              requestedStageId,
            );
          } catch (error) {
            stageId = requestedStageId ?? result.stageId;
            if (tracked !== null) tracked.stageId = stageId;
            throw error;
          }
        } finally {
          bytes.fill(0);
        }
        stageId = result.stageId;
        if (tracked !== null) {
          tracked.stageId = stageId;
          if (!this.#transferIsActive(tracked)) {
            if (
              finalAttempted &&
              result.committed &&
              result.entry !== null
            ) {
              return this.#completeWrite(
                tracked,
                result.entry,
                location.space,
              );
            }
            await this.#abortKnownStage(tracked);
            throw cancelledUploadFault();
          }
        }
        const processedBytes = Math.min(
          input.source.size,
          (ordinal + 1) * PLAIN_BLOCK_BYTES,
        );
        if (tracked !== null) {
          tracked.processedBytes = processedBytes;
          tracked.phase = "uploading";
          this.#setTransfer(tracked, "uploading", processedBytes, null);
        }
        controls.onProgress?.({
          phase: "uploading",
          plaintextBytes: input.source.size,
          processedBytes,
          blockIndex: ordinal,
          blockCount,
        });
      }
      if (!result?.committed || result.entry === null) {
        const reconciled = await this.#reconcileStoredFile({
          ...expectation,
        });
        if (reconciled !== null) {
          return this.#completeWrite(tracked, reconciled, location.space);
        }
        throw uncertainPlainWriteFault();
      }
      return this.#completeWrite(
        tracked,
        assertPlainWriteEntry(expectation, result.entry),
        location.space,
      );
    } catch (error) {
      let effectiveError = error;
      if (
        finalAttempted &&
        etagSha256 !== null &&
        isAmbiguousUploadFailure(error)
      ) {
        const reconciled = await this.#reconcileStoredFile({
          space: location.space,
          relativePath: location.relativePath,
          contentKind: effectiveContentKind,
          mediaType: input.mediaType,
          totalBytes: input.source.size,
          etagSha256,
          expectedNodeId:
            replacement === null ? null : requirePlainNodeId(replacement),
          expectedRevision: replacement?.structuralRevision ?? null,
          ifNoneMatch: effectiveIfNoneMatch,
          moveSource,
        });
        if (reconciled !== null) {
          return this.#completeWrite(tracked, reconciled, location.space);
        }
        effectiveError = uncertainPlainWriteFault();
      }
      if (tracked !== null) {
        const effective = await this.#failWrite(tracked, effectiveError);
        throw effective;
      }
      await this.#abortStage(requestId, location.space, stageId);
      throw serviceError(effectiveError);
    } finally {
      if (uploadDigest !== null) destroyHashQuietly(uploadDigest);
    }
  }

  async writeMany(
    input: readonly {
      path: string;
      text: string;
      overwrite: boolean;
      createParents: boolean;
      mediaType: string;
    }[],
    controls?: FilesTransferControls,
  ): Promise<readonly FilesServiceWriteResult[]> {
    const encoder = new TextEncoder();
    const output: FilesServiceWriteResult[] = [];
    for (const item of input) {
      const bytes = encoder.encode(item.text);
      const ifMatch = item.overwrite
        ? (await this.stat(item.path, controls?.signal)).etagSha256
        : null;
      if (item.overwrite && ifMatch === null) {
        throw conflict("Only an existing file can be replaced");
      }
      output.push(
        await this.write(
          {
            path: item.path,
            source: byteSource(bytes, item.path, item.mediaType),
            contentKind: "text",
            mediaType: item.mediaType,
            ifMatch,
            ifNoneMatch: !item.overwrite,
            createParents: item.createParents,
          },
          controls,
        ),
      );
    }
    return output;
  }

  async mkdir(
    path: string,
    recursive: boolean,
    signal?: AbortSignal,
  ): Promise<FilesServiceMutationResult> {
    throwIfAborted(signal);
    const location = plainLocation(path);
    try {
      const result = await this.#backend.mkdir({
        requestId: randomHex(16),
        space: location.space,
        path: location.relativePath,
        recursive,
      });
      assertPlainMutationPath(
        location.space,
        result.path,
        location.relativePath,
      );
      return mutationResult(location.space, result);
    } catch (error) {
      throw serviceError(error);
    }
  }

  async move(
    from: string,
    to: string,
    overwrite: boolean,
    signal?: AbortSignal,
  ): Promise<FilesServiceMutationResult> {
    throwIfAborted(signal);
    const source = plainLocation(from);
    const destination = plainLocation(to);
    if (source.space !== destination.space) {
      throw new FilesServiceFault(
        "invalid",
        "Plain backend moves must stay in one Files root",
        "Use the Files root-aware move operation",
      );
    }
    const expected = await this.stat(from, signal);
    try {
      const result = await this.#backend.move({
        requestId: randomHex(16),
        space: source.space,
        from: source.relativePath,
        to: destination.relativePath,
        overwrite,
        expectedNodeId: requirePlainNodeId(expected),
        expectedRevision: expected.structuralRevision,
        ifMatch: expected.etagSha256,
      });
      assertPlainMutationPath(
        destination.space,
        result.path,
        destination.relativePath,
      );
      return mutationResult(source.space, result);
    } catch (error) {
      throw serviceError(error);
    }
  }

  async remove(
    path: string,
    recursive: boolean,
    signal?: AbortSignal,
    precondition?: FilesServiceRemovePrecondition,
  ): Promise<FilesServiceMutationResult> {
    const location = plainLocation(path);
    let entry = await this.stat(path, signal);
    if (
      precondition !== undefined &&
      (
        entry.nodeId !== precondition.nodeId ||
        entry.structuralRevision !== precondition.structuralRevision ||
        entry.etagSha256 !== precondition.etagSha256
      )
    ) {
      throw conflict("The source changed while it was being moved");
    }
    if (recursive && entry.type === "folder") {
      const originalFolder = entry;
      const originalNodeId = requirePlainNodeId(originalFolder);
      // Removing a page changes the folder revision, so an old continuation
      // cannot safely be reused. Drain the first page until the folder is
      // empty instead.
      while (true) {
        const beforeList = await this.stat(path, signal);
        assertSamePlainFolderIdentity(
          originalFolder,
          originalNodeId,
          beforeList,
        );
        const page = await this.list({
          path,
          cursor: null,
          expectedFolderRevision: beforeList.structuralRevision,
          limit: 200,
          recursive: false,
          ...(signal ? { signal } : {}),
        });
        const afterList = await this.stat(path, signal);
        assertSamePlainFolderIdentity(
          originalFolder,
          originalNodeId,
          afterList,
        );
        if (afterList.structuralRevision !== page.folderRevision) {
          throw conflict(
            "The folder changed while it was being removed",
          );
        }
        if (page.entries.length === 0) break;
        for (const child of page.entries) {
          await this.remove(
            child.path,
            true,
            signal,
            {
              nodeId: child.nodeId,
              structuralRevision: child.structuralRevision,
              etagSha256: child.etagSha256,
            },
          );
        }
      }
      entry = await this.stat(path, signal);
      assertSamePlainFolderIdentity(
        originalFolder,
        originalNodeId,
        entry,
      );
    }
    const expectedNodeId =
      recursive && entry.type === "folder"
        ? entry.nodeId
        : precondition?.nodeId ?? entry.nodeId;
    if (expectedNodeId === null) {
      throw integrityFault("Files returned a plaintext item without an identity");
    }
    throwIfAborted(signal);
    try {
      const result = await this.#backend.remove({
        requestId: randomHex(16),
        space: location.space,
        path: location.relativePath,
        recursive: false,
        expectedNodeId,
        expectedRevision:
          recursive && entry.type === "folder"
            ? entry.structuralRevision
            : precondition?.structuralRevision ?? entry.structuralRevision,
        ifMatch:
          recursive && entry.type === "folder"
            ? entry.etagSha256
            : precondition?.etagSha256 ?? entry.etagSha256,
        deleteNonce:
          location.space === "shared" && entry.type === "file"
            ? randomBytes(16)
            : null,
      });
      assertPlainMutationPath(
        location.space,
        result.path,
        location.relativePath,
      );
      return mutationResult(location.space, result);
    } catch (error) {
      throw serviceError(error);
    }
  }

  async cancel(transferId: string): Promise<FilesServiceStatus> {
    const transfer =
      this.#uploads.get(transferId) ?? this.#writes.get(transferId);
    if (transfer) {
      this.#uploads.delete(transferId);
      this.#writes.delete(transferId);
      transfer.disposition = "cancelled";
      transfer.phase = "cancelled";
      transfer.error = null;
      if (isPlainUploadSession(transfer)) {
        this.#wipeUploadBuffers(transfer);
      }
      this.#setTransfer(
        transfer,
        "cancelled",
        trackedProcessedBytes(transfer),
        null,
      );
      await this.#abortKnownStage(transfer);
    }
    return this.status();
  }

  retry(): Promise<FilesServiceStatus> {
    return this.status();
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
      this.#uploads.has(input.transferId) ||
      this.#writes.has(input.transferId)
    ) {
      throw new FilesServiceFault(
        "conflict",
        "This upload already exists",
        "Wait for it to finish",
      );
    }
    if (
      this.#uploads.size >= MAX_ACTIVE_PLAIN_UPLOADS ||
      this.#deferredResidentBytes > 0
    ) {
      throw new FilesServiceFault(
        "temporarily_unavailable",
        "Another file is already being prepared",
        "Wait for it to finish",
      );
    }
    validatePlainSize(input.size);
    const location = plainLocation(input.path);
    const tokens = writeTokens();
    const session: PlainUploadSession = {
      transferId: input.transferId,
      requestId: randomHex(16),
      path: location.path,
      space: location.space,
      relativePath: location.relativePath,
      name: input.name,
      contentKind: plainContentKind(location, "binary"),
      mediaType: input.mediaType,
      totalBytes: input.size,
      blockCount: canonicalBlockCount(input.size),
      hash: nobleSha256.create(),
      hashBytes: 0,
      nextHashOrdinal: 0,
      digestHex: null,
      uploadHash: nobleSha256.create(),
      uploadHashBytes: 0,
      nextUploadOrdinal: 0,
      uploadMode: null,
      deferredBodies: null,
      deferredBufferedBytes: 0,
      deferredCommit: null,
      inactivityEpoch: 0,
      cancelInactivityTimer: null,
      stageId: null,
      ...tokens,
      result: null,
      phase: "hashing",
      error: null,
      disposition: "active",
    };
    this.#uploads.set(input.transferId, session);
    this.#transferOwners.set(input.transferId, session);
    this.#setTransfer(session, "hashing", 0, null);
    this.#armUploadInactivity(session);
    return {
      transferId: input.transferId,
      chunkBytes: PLAIN_BLOCK_BYTES,
    };
  }

  async uploadChunk(
    input: {
      transferId: string;
      pass: "hash" | "encrypt";
      ordinal: number;
      final: boolean;
      totalBytes: number;
    },
    data: ArrayBuffer,
    controls: FilesTransferControls = {},
  ) {
    const session = this.#uploads.get(input.transferId);
    if (!session) {
      throw new FilesServiceFault(
        "not_found",
        "This upload is no longer active",
        "Start the upload again",
      );
    }
    throwIfAborted(controls.signal);
    this.#disarmUploadInactivity(session);
    const bytes = new Uint8Array(data);
    try {
      return await this.#handleUploadChunk(session, input, bytes, controls);
    } finally {
      bytes.fill(0);
      if (
        this.#uploads.get(session.transferId) === session &&
        session.deferredCommit === null
      ) {
        this.#armUploadInactivity(session);
      }
    }
  }

  async #handleUploadChunk(
    session: PlainUploadSession,
    input: {
      transferId: string;
      pass: "hash" | "encrypt";
      ordinal: number;
      final: boolean;
      totalBytes: number;
    },
    bytes: Uint8Array,
    controls: FilesTransferControls,
  ) {
    validateUploadChunk(session, input, bytes);
    if (input.pass === "hash") {
      session.hash.update(bytes);
      session.hashBytes += bytes.byteLength;
      session.nextHashOrdinal += 1;
      if (input.final) {
        session.digestHex = digestHexAndWipe(session.hash);
      }
      this.#setTransfer(session, "hashing", session.hashBytes, null);
      return uploadResult(session, false, input.final, null);
    }
    if (session.digestHex === null) {
      throw new FilesServiceFault(
        "invalid",
        "Upload content must be verified before it is stored",
        "Restart the upload",
      );
    }
    const requestedMode = controls.deferFinalCommit ? "deferred" : "direct";
    session.uploadMode ??= requestedMode;
    if (session.uploadMode !== requestedMode) {
      throw new FilesServiceFault(
        "conflict",
        "Upload delivery mode changed while the upload was active",
        "Start the upload again",
      );
    }
    session.uploadHash.update(bytes);
    session.uploadHashBytes += bytes.byteLength;
    if (input.final) {
      const uploadDigestHex = digestHexAndWipe(session.uploadHash);
      if (
        session.uploadHashBytes !== session.totalBytes ||
        uploadDigestHex !== session.digestHex
      ) {
        const effective = await this.#failUpload(
          session,
          uploadSourceChangedFault(),
        );
        throw effective;
      }
    }
    if (requestedMode === "deferred") {
      return this.#acceptDeferredUploadChunk(session, input, bytes);
    }

    let result: FilesPlainWriteResult;
    const requestedStageId = session.stageId;
    try {
      result = await this.#writeUploadBlock(
        session,
        input.ordinal,
        input.final,
        bytes,
        controls.signal,
      );
      try {
        assertPlainWriteResult(
          result,
          input.final,
          uploadWriteExpectation(session),
          requestedStageId,
        );
      } catch (error) {
        session.stageId = requestedStageId ?? result.stageId;
        throw error;
      }
    } catch (error) {
      let effectiveError = error;
      if (input.final && isAmbiguousUploadFailure(error)) {
        const reconciled = await this.#reconcileUpload(session);
        if (reconciled !== null) {
          if (!this.#completeUpload(session, reconciled)) {
            throw cancelledUploadFault();
          }
          return uploadResult(session, true, false, session.result);
        }
        effectiveError = uncertainPlainUploadFault();
      }
      const effective = await this.#failUpload(session, effectiveError);
      throw effective;
    }
    session.stageId = result.stageId;
    if (!this.#transferIsActive(session)) {
      if (input.final && result.committed && result.entry !== null) {
        if (!this.#completeUpload(session, result.entry)) {
          throw cancelledUploadFault();
        }
        return uploadResult(session, true, false, session.result);
      }
      await this.#abortKnownStage(session);
      throw cancelledUploadFault();
    }
    session.nextUploadOrdinal += 1;
    session.phase = "uploading";
    this.#setTransfer(
      session,
      "uploading",
      Math.min(
        session.totalBytes,
        session.nextUploadOrdinal * PLAIN_BLOCK_BYTES,
      ),
      null,
    );
    if (input.final) {
      if (!result.committed || result.entry === null) {
        const reconciled = await this.#reconcileUpload(session);
        if (reconciled !== null) {
          if (!this.#completeUpload(session, reconciled)) {
            throw cancelledUploadFault();
          }
          return uploadResult(session, true, false, session.result);
        }
        const effective = await this.#failUpload(
          session,
          uncertainPlainUploadFault(),
        );
        throw effective;
      }
      if (!this.#completeUpload(session, result.entry)) {
        throw cancelledUploadFault();
      }
      return uploadResult(session, true, false, session.result);
    }
    return uploadResult(session, false, false, null);
  }

  #captureOperationFence(signal?: AbortSignal): PlainOperationFence {
    throwIfAborted(signal);
    return {
      epoch: this.#authorityEpoch,
      authoritySignal: this.#authorityController.signal,
    };
  }

  #assertOperationFence(
    fence: PlainOperationFence,
    signal?: AbortSignal,
  ): void {
    throwIfAborted(signal);
    if (
      fence.epoch !== this.#authorityEpoch ||
      fence.authoritySignal.aborted
    ) {
      throw plainAuthorityChangedFault();
    }
  }

  #awaitFencedQuery<T>(
    pending: Promise<T>,
    fence: PlainOperationFence,
    signal?: AbortSignal,
    discard?: (value: T) => void,
  ): Promise<T> {
    this.#assertOperationFence(fence, signal);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        signal?.removeEventListener("abort", onUserAbort);
        fence.authoritySignal.removeEventListener(
          "abort",
          onAuthorityAbort,
        );
      };
      const rejectOnce = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onUserAbort = (): void =>
        rejectOnce(new DOMException("Cancelled", "AbortError"));
      const onAuthorityAbort = (): void =>
        rejectOnce(plainAuthorityChangedFault());
      signal?.addEventListener("abort", onUserAbort, { once: true });
      fence.authoritySignal.addEventListener(
        "abort",
        onAuthorityAbort,
        { once: true },
      );
      pending.then(
        (value) => {
          if (settled) {
            try {
              discard?.(value);
            } catch {
              // Discarding a late response is best-effort except for byte
              // erasure, whose callbacks are non-throwing typed-array fills.
            }
            return;
          }
          try {
            this.#assertOperationFence(fence, signal);
          } catch (error) {
            settled = true;
            cleanup();
            try {
              discard?.(value);
            } catch {
              // See the late-response discard note above.
            }
            reject(error);
            return;
          }
          settled = true;
          cleanup();
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      );
    });
  }

  clearVolatile(_reason?: FilesAuthorityResetReason): void {
    this.#authorityEpoch += 1;
    this.#authorityController.abort();
    this.#authorityController = new AbortController();
    const active = [
      ...this.#uploads.values(),
      ...this.#writes.values(),
    ];
    this.#uploads.clear();
    this.#writes.clear();
    this.#transfers.clear();
    this.#transferOwners.clear();
    for (const transfer of active) {
      transfer.disposition = "cleared";
      transfer.phase = "cancelled";
      transfer.error = null;
      if (isPlainUploadSession(transfer)) {
        this.#wipeUploadBuffers(transfer);
      }
      void this.#abortKnownStage(transfer);
    }
  }

  async #acceptDeferredUploadChunk(
    session: PlainUploadSession,
    input: {
      ordinal: number;
      final: boolean;
    },
    bytes: Uint8Array,
  ) {
    if (
      bytes.byteLength >
        this.#maxDeferredResidentBytes - this.#deferredResidentBytes
    ) {
      const effective = await this.#failUpload(
        session,
        deferredUploadCapacityFault(),
      );
      throw effective;
    }
    session.deferredBodies ??=
      Array.from({ length: session.blockCount }, () => null);
    let owned: Uint8Array;
    try {
      owned = bytes.slice();
    } catch {
      const effective = await this.#failUpload(
        session,
        deferredUploadCapacityFault(),
      );
      throw effective;
    }
    session.deferredBodies[input.ordinal] = owned;
    session.deferredBufferedBytes += owned.byteLength;
    this.#deferredResidentBytes += owned.byteLength;
    session.nextUploadOrdinal += 1;
    session.phase = "uploading";
    this.#setTransfer(
      session,
      "uploading",
      acceptedUploadBytes(session),
      null,
    );
    if (input.final) {
      this.#scheduleDeferredCommit(session);
    }
    return uploadResult(session, false, false, null);
  }

  #scheduleDeferredCommit(session: PlainUploadSession): void {
    if (session.deferredCommit !== null) {
      throw new FilesServiceFault(
        "conflict",
        "This upload is already being finished",
        "Wait for it to finish",
      );
    }
    this.#disarmUploadInactivity(session);
    // Attachment handlers and resident self-updates share one serialized
    // Kernel lane. A timer yields past the inbound handler's promise chain;
    // starting the updates in this stack (or awaiting them) deadlocks it.
    session.deferredCommit = afterInboundAttachmentHandler()
      .then(() => this.#commitDeferredUpload(session));
    void session.deferredCommit.catch(() => undefined);
  }

  async #commitDeferredUpload(session: PlainUploadSession): Promise<void> {
    let finalResult: FilesPlainWriteResult | null = null;
    let finalAttempted = false;
    try {
      for (let ordinal = 0; ordinal < session.blockCount; ordinal += 1) {
        if (!this.#transferIsActive(session)) {
          await this.#abortKnownStage(session);
          return;
        }
        const body = session.deferredBodies?.[ordinal] ?? null;
        if (body === null) {
          throw new FilesServiceFault(
            "incompatible",
            "Files lost an accepted upload chunk",
            "Start the upload again",
          );
        }
        session.deferredBodies![ordinal] = null;
        const outbound = body;
        finalAttempted = ordinal + 1 === session.blockCount;
        const requestedStageId = session.stageId;
        try {
          finalResult = await this.#writeUploadBlock(
            session,
            ordinal,
            finalAttempted,
            outbound,
          );
          try {
            assertPlainWriteResult(
              finalResult,
              finalAttempted,
              uploadWriteExpectation(session),
              requestedStageId,
            );
          } catch (error) {
            session.stageId = requestedStageId ?? finalResult.stageId;
            throw error;
          }
        } finally {
          // updateSelf owns this exact view until its promise settles.
          outbound.fill(0);
          this.#releaseDeferredBytes(session, outbound.byteLength);
        }
        session.stageId = finalResult.stageId;
        if (!this.#transferIsActive(session)) {
          if (
            finalAttempted &&
            finalResult.committed &&
            finalResult.entry !== null
          ) {
            this.#completeUpload(session, finalResult.entry);
            return;
          }
          await this.#abortKnownStage(session);
          return;
        }
      }
      if (!finalResult?.committed || finalResult.entry === null) {
        const reconciled = await this.#reconcileUpload(session);
        if (reconciled !== null) {
          this.#completeUpload(session, reconciled);
          return;
        }
        throw uncertainPlainUploadFault();
      }
      this.#completeUpload(session, finalResult.entry);
    } catch (error) {
      let effectiveError = error;
      if (finalAttempted && isAmbiguousUploadFailure(error)) {
        const reconciled = await this.#reconcileUpload(session);
        if (reconciled !== null) {
          this.#completeUpload(session, reconciled);
          return;
        }
        effectiveError = uncertainPlainUploadFault();
      }
      if (!this.#transferIsActive(session)) {
        await this.#abortKnownStage(session);
        return;
      }
      await this.#failUpload(session, effectiveError);
    } finally {
      this.#wipeUploadBuffers(session);
      session.deferredCommit = null;
    }
  }

  #completeUpload(
    session: PlainUploadSession,
    entry: FilesPlainEntry,
  ): boolean {
    session.phase = "committed";
    session.error = null;
    if (this.#uploads.get(session.transferId) === session) {
      this.#uploads.delete(session.transferId);
    }
    this.#wipeUploadBuffers(session);
    if (session.disposition === "cleared") {
      session.result = null;
      this.#emitStateChange();
      return false;
    }
    session.result = serviceEntry(session.space, entry);
    this.#setTransfer(
      session,
      "committed",
      session.totalBytes,
      null,
    );
    if (
      session.uploadMode === "deferred" ||
      session.disposition !== "active"
    ) {
      this.#emitStateChange();
    }
    return true;
  }

  async #reconcileUpload(
    session: PlainUploadSession,
  ): Promise<FilesPlainEntry | null> {
    if (session.digestHex === null) return null;
    return this.#reconcileStoredFile({
      space: session.space,
      relativePath: session.relativePath,
      contentKind: session.contentKind,
      mediaType: session.mediaType,
      totalBytes: session.totalBytes,
      etagSha256: session.digestHex,
      expectedNodeId: null,
      expectedRevision: null,
      ifNoneMatch: true,
      moveSource: null,
    });
  }

  #assertTrackedWriteActive(session: PlainWriteSession | null): void {
    if (session !== null && !this.#transferIsActive(session)) {
      throw cancelledUploadFault();
    }
  }

  #completeWrite(
    session: PlainWriteSession | null,
    entry: FilesPlainEntry,
    space: FilesPlainSpace,
  ): FilesServiceWriteResult {
    if (session !== null) {
      session.phase = "committed";
      session.error = null;
      session.processedBytes = session.totalBytes;
      if (this.#writes.get(session.transferId) === session) {
        this.#writes.delete(session.transferId);
      }
      if (session.disposition === "cleared") {
        session.result = null;
        this.#emitStateChange();
        throw cancelledUploadFault();
      }
    }
    const stored = serviceEntry(space, entry);
    if (session !== null) {
      session.result = stored;
      this.#setTransfer(
        session,
        "committed",
        session.totalBytes,
        null,
      );
      if (session.disposition !== "active") {
        this.#emitStateChange();
      }
    }
    return {
      entry: stored as FilesServiceWriteResult["entry"],
      cleanupPending: false,
    };
  }

  async #failWrite(
    session: PlainWriteSession,
    error: unknown,
  ): Promise<Error> {
    const effective = serviceError(error);
    if (!this.#transferIsActive(session)) {
      await this.#abortKnownStage(session);
      return cancelledUploadFault();
    }
    this.#writes.delete(session.transferId);
    session.error = effective.message;
    session.phase = uploadFailurePhase(effective);
    this.#setTransfer(
      session,
      session.phase,
      session.processedBytes,
      session.error,
    );
    await this.#abortKnownStage(session);
    return effective;
  }

  async #reconcileStoredFile(
    input: PlainWriteExpectation,
  ): Promise<FilesPlainEntry | null> {
    let entry: FilesPlainEntry;
    try {
      entry = await this.#backend.stat({
        space: input.space,
        path: input.relativePath,
      });
    } catch {
      return null;
    }
    assertPlainEntryResponse(input.space, entry, input.relativePath);
    if (!plainWriteEntryMatches(input, entry)) return null;
    if (input.moveSource !== null) {
      try {
        await this.#backend.stat({
          space: input.space,
          path: input.moveSource.path,
        });
        return null;
      } catch (error) {
        if (
          !(error instanceof FilesPlainBackendError) ||
          error.reason !== "not_found"
        ) {
          return null;
        }
      }
    }
    return entry;
  }

  #writeUploadBlock(
    session: PlainUploadSession,
    ordinal: number,
    final: boolean,
    body: Uint8Array,
    signal?: AbortSignal,
  ): Promise<FilesPlainWriteResult> {
    return this.#writeBlockWithReplay({
      requestId: session.requestId,
      space: session.space,
      path: session.relativePath,
      stageId: session.stageId,
      blockIndex: ordinal,
      blockCount: session.blockCount,
      totalBytes: session.totalBytes,
      contentKind: session.contentKind,
      mediaType: session.mediaType,
      etagSha256: session.digestHex!,
      presentation: presentation(
        session.space,
        session.path,
        session.contentKind,
      ),
      ifMatch: null,
      expectedNodeId: null,
      expectedRevision: null,
      ifNoneMatch: true,
      createParents: true,
      final,
      safeName:
        session.space === "shared" ? safePublicName(session.path) : null,
      beginNonce:
        session.space === "shared" && ordinal === 0
          ? session.beginNonce
          : null,
      commitNonce:
        session.space === "shared" && final
          ? session.commitNonce
          : null,
      deleteNonce:
        session.space === "shared" && final
          ? session.deleteNonce
          : null,
      moveSource: null,
      body,
    }, true, () =>
      !signal?.aborted && this.#transferIsActive(session)
    );
  }

  async #writeBlockWithReplay(
    input: FilesPlainWriteInput,
    replayUnknownFailure: boolean,
    replayStillAuthorized: () => boolean,
  ): Promise<FilesPlainWriteResult> {
    try {
      return await this.#backend.writeBlock(input);
    } catch (error) {
      if (
        !replayUnknownFailure ||
        !isAmbiguousUploadFailure(error) ||
        !replayStillAuthorized()
      ) {
        throw error;
      }
      return this.#backend.writeBlock(input);
    }
  }

  async #failUpload(
    session: PlainUploadSession,
    error: unknown,
  ): Promise<Error> {
    const effective = serviceError(error);
    if (!this.#transferIsActive(session)) {
      this.#wipeUploadBuffers(session);
      await this.#abortKnownStage(session);
      return cancelledUploadFault();
    }
    this.#uploads.delete(session.transferId);
    session.error =
      effective instanceof Error ? effective.message : String(effective);
    session.phase = uploadFailurePhase(effective);
    this.#wipeUploadBuffers(session);
    this.#setTransfer(
      session,
      session.phase,
      acceptedUploadBytes(session),
      session.error,
    );
    await this.#abortKnownStage(session);
    if (session.uploadMode === "deferred") {
      this.#emitStateChange();
    }
    return effective;
  }

  #transferIsActive(session: PlainTrackedTransfer): boolean {
    return (
      this.#uploads.get(session.transferId) === session ||
      this.#writes.get(session.transferId) === session
    );
  }

  async #abortKnownStage(session: PlainTrackedTransfer): Promise<void> {
    await this.#abortStage(
      session.requestId,
      session.space,
      session.stageId,
    );
  }

  async #abortStage(
    requestId: string,
    space: FilesPlainSpace,
    stageId: CanonicalNat64 | null,
  ): Promise<void> {
    try {
      await this.#backend.abort({
        requestId,
        space,
        stageId,
      });
    } catch {
      // Stage expiry, concurrent abort, and cleanup outages do not restore
      // ownership of the wiped upload session.
    }
  }

  #armUploadInactivity(session: PlainUploadSession): void {
    this.#disarmUploadInactivity(session);
    const epoch = ++session.inactivityEpoch;
    session.cancelInactivityTimer = this.#scheduleUploadTimer(() => {
      if (
        session.inactivityEpoch !== epoch ||
        this.#uploads.get(session.transferId) !== session ||
        this.#transferOwners.get(session.transferId) !== session ||
        session.deferredCommit !== null
      ) {
        return;
      }
      session.cancelInactivityTimer = null;
      session.inactivityEpoch += 1;
      void this.#expireUpload(session);
    }, this.#uploadInactivityMs);
  }

  #disarmUploadInactivity(session: PlainUploadSession): void {
    session.inactivityEpoch += 1;
    const cancel = session.cancelInactivityTimer;
    session.cancelInactivityTimer = null;
    cancel?.();
  }

  async #expireUpload(session: PlainUploadSession): Promise<void> {
    const deferred = session.uploadMode === "deferred";
    await this.#failUpload(session, inactiveUploadFault());
    if (!deferred) this.#emitStateChange();
  }

  #releaseDeferredBytes(
    session: PlainUploadSession,
    byteLength: number,
  ): void {
    session.deferredBufferedBytes = Math.max(
      0,
      session.deferredBufferedBytes - byteLength,
    );
    this.#deferredResidentBytes = Math.max(
      0,
      this.#deferredResidentBytes - byteLength,
    );
  }

  #wipeUploadBuffers(session: PlainUploadSession): void {
    this.#disarmUploadInactivity(session);
    destroyHashQuietly(session.hash);
    destroyHashQuietly(session.uploadHash);
    if (session.deferredBodies !== null) {
      for (const body of session.deferredBodies) {
        if (body !== null) {
          body.fill(0);
          this.#releaseDeferredBytes(session, body.byteLength);
        }
      }
      session.deferredBodies = null;
    }
  }

  #setTransfer(
    session: PlainTrackedTransfer,
    phase: FilesTransferPhase,
    processedBytes: number,
    error: string | null,
  ): void {
    if (this.#transferOwners.get(session.transferId) !== session) return;
    this.#transfers.delete(session.transferId);
    this.#transfers.set(session.transferId, {
      id: session.transferId,
      label: session.name,
      phase,
      processedBytes,
      totalBytes: session.totalBytes,
      error,
    });
    const terminalIds = [...this.#transfers.keys()].filter(
      (transferId) =>
        !this.#uploads.has(transferId) &&
        !this.#writes.has(transferId),
    );
    while (terminalIds.length > MAX_TERMINAL_TRANSFERS) {
      const oldest = terminalIds.shift();
      if (oldest !== undefined) {
        this.#transfers.delete(oldest);
        this.#transferOwners.delete(oldest);
      }
    }
  }

  #emitStateChange(): void {
    for (const listener of this.#statusListeners) {
      try {
        listener("state_changed");
      } catch {
        // One observer cannot suppress the authoritative resident hint.
      }
    }
  }
}

function plainLocation(path: string): {
  path: string;
  space: FilesPlainSpace;
  relativePath: string;
} {
  let canonical: string;
  try {
    canonical = normalizePlainFilesPath(path).path;
  } catch {
    throw new FilesServiceFault(
      "invalid",
      "Plain storage path is invalid",
      "Choose a valid Shared or Workspace path",
    );
  }
  const rooted = parseFilesRootedPath(canonical);
  if (
    rooted === null ||
    rooted.storageClass === "vault"
  ) {
    throw new FilesServiceFault(
      "invalid",
      "Plain storage accepts only Shared or Workspace paths",
      "Choose Shared or Workspace",
    );
  }
  return {
    path: rooted.path,
    space: rooted.storageClass,
    relativePath: rooted.relativePath,
  };
}

function plainWriteMoveSource(
  source: FilesServiceMoveSource | undefined,
  destination: ReturnType<typeof plainLocation>,
): FilesPlainWriteMoveSource | null {
  if (source === undefined) return null;
  const location = plainLocation(source.path);
  if (
    destination.space !== "shared" ||
    location.space !== "shared" ||
    location.relativePath === destination.relativePath
  ) {
    throw new FilesServiceFault(
      "invalid",
      "Only a Shared file rename can finish as one publication move",
      "Choose another destination",
    );
  }
  return {
    path: location.relativePath,
    expectedNodeId: source.nodeId,
    expectedRevision: source.structuralRevision,
    ifMatch: source.etagSha256,
  };
}

function assertPlainListResponse(
  space: FilesPlainSpace,
  parentPath: string,
  requestedCursor: FilesPlainCursor | null,
  requestedLimit: number,
  page: FilesPlainList,
): void {
  if (
    !Number.isSafeInteger(requestedLimit) ||
    requestedLimit < 1 ||
    requestedLimit > FILES_V2_LIMITS.directChildPageMaximum ||
    !Number.isSafeInteger(page.total) ||
    page.total < 0 ||
    page.entries.length > requestedLimit ||
    page.entries.length > FILES_V2_LIMITS.directChildPageMaximum ||
    page.total > FILES_V2_LIMITS.nodes ||
    page.total < page.entries.length ||
    (requestedCursor !== null &&
      requestedCursor.seen + page.entries.length > page.total) ||
    page.hasMore !== (page.cursor !== null) ||
    (page.hasMore && page.entries.length === 0) ||
    (page.hasMore &&
      (requestedCursor?.seen ?? 0) + page.entries.length >= page.total) ||
    (requestedCursor !== null && page.entries.length === 0) ||
    (!page.hasMore &&
      (requestedCursor?.seen ?? 0) + page.entries.length !== page.total)
  ) {
    throw integrityFault("Files returned an inconsistent folder page");
  }
  if (
    requestedCursor !== null &&
    (
      !validPlainName(requestedCursor.after) ||
      requestedCursor.parentNodeId === ZERO ||
      requestedCursor.revision !== page.revision ||
      !Number.isSafeInteger(requestedCursor.seen) ||
      requestedCursor.seen < 1 ||
      !Number.isSafeInteger(requestedCursor.total) ||
      requestedCursor.total < 1 ||
      requestedCursor.seen >= requestedCursor.total ||
      requestedCursor.total !== page.total
    )
  ) {
    throw integrityFault("Files returned a folder page for a stale cursor");
  }
  const names = new Set<string>();
  const nodeIds = new Set<CanonicalNat64>();
  let previousName = requestedCursor?.after ?? null;
  for (const entry of page.entries) {
    const expectedPath = joinPlainChildPath(parentPath, entry.name);
    assertPlainEntryResponse(space, entry, expectedPath);
    if (
      names.has(entry.name) ||
      nodeIds.has(entry.nodeId) ||
      (previousName !== null &&
        comparePlainNames(previousName, entry.name) >= 0)
    ) {
      throw integrityFault(
        "Files returned duplicate or out-of-order folder items",
      );
    }
    names.add(entry.name);
    nodeIds.add(entry.nodeId);
    previousName = entry.name;
  }
  if (page.cursor !== null) {
    const last = page.entries.at(-1);
    if (
      last === undefined ||
      page.cursor.after !== last.name ||
      page.cursor.revision !== page.revision ||
      page.cursor.parentNodeId === ZERO ||
      page.cursor.seen !==
        (requestedCursor?.seen ?? 0) + page.entries.length ||
      page.cursor.total !== page.total ||
      (requestedCursor !== null &&
        page.cursor.parentNodeId !== requestedCursor.parentNodeId)
    ) {
      throw integrityFault(
        "Files returned an inconsistent folder continuation",
      );
    }
  }
}

function assertPlainEntryResponse(
  space: FilesPlainSpace,
  entry: FilesPlainEntry,
  expectedPath: string,
): void {
  const expectedName =
    expectedPath === "/"
      ? ""
      : expectedPath.slice(expectedPath.lastIndexOf("/") + 1);
  if (
    entry.nodeId === ZERO ||
    entry.path !== expectedPath ||
    !validPlainPath(space, entry.path) ||
    entry.name !== expectedName ||
    (expectedPath !== "/" && !validPlainName(entry.name))
  ) {
    throw integrityFault("Files returned an item from another folder");
  }
  if (entry.type === "folder") {
    if (
      entry.contentKind !== null ||
      entry.byteLength !== null ||
      entry.mediaType !== null ||
      entry.etagSha256 !== null ||
      entry.relativeUrl !== null
    ) {
      throw integrityFault("Files returned invalid folder details");
    }
    return;
  }
  if (
    entry.contentKind === null ||
    entry.byteLength === null ||
    entry.mediaType === null ||
    entry.etagSha256 === null ||
    !Number.isSafeInteger(entry.byteLength) ||
    entry.byteLength < 0 ||
    entry.byteLength > PLAIN_FILE_BYTES ||
    !validPlainMediaType(entry.mediaType) ||
    !/^[a-f0-9]{64}$/u.test(entry.etagSha256) ||
    (
      space === "workspace"
        ? entry.relativeUrl !== null
        : !isExactPlainSharedRelativeUrl(entry.relativeUrl, entry.path)
    )
  ) {
    throw integrityFault("Files returned invalid stored-file details");
  }
}

function uploadWriteExpectation(
  session: PlainUploadSession,
): PlainWriteExpectation {
  if (session.digestHex === null) {
    throw integrityFault("Files could not verify the upload receipt");
  }
  return {
    space: session.space,
    relativePath: session.relativePath,
    contentKind: session.contentKind,
    mediaType: session.mediaType,
    totalBytes: session.totalBytes,
    etagSha256: session.digestHex,
    expectedNodeId: null,
    expectedRevision: null,
    ifNoneMatch: true,
    moveSource: null,
  };
}

function assertPlainWriteResult(
  result: FilesPlainWriteResult,
  final: boolean,
  expectation: PlainWriteExpectation,
  requestedStageId: CanonicalNat64 | null,
): void {
  if (
    (!final && (result.committed || result.entry !== null)) ||
    (result.committed !== (result.entry !== null)) ||
    (result.committed && result.stageId !== null) ||
    (
      !result.committed &&
      (
        result.stageId === null ||
        result.stageId === ZERO ||
        (
          requestedStageId !== null &&
          result.stageId !== requestedStageId
        )
      )
    )
  ) {
    throw integrityFault("Files returned an inconsistent write receipt");
  }
  if (result.entry !== null) {
    assertPlainWriteEntry(expectation, result.entry);
  }
}

function assertPlainWriteEntry(
  expectation: PlainWriteExpectation,
  entry: FilesPlainEntry,
): FilesPlainEntry {
  assertPlainEntryResponse(
    expectation.space,
    entry,
    expectation.relativePath,
  );
  if (!plainWriteEntryMatches(expectation, entry)) {
    throw integrityFault("Files returned a receipt for another write");
  }
  return entry;
}

function plainWriteEntryMatches(
  expectation: PlainWriteExpectation,
  entry: FilesPlainEntry,
): boolean {
  if (
    entry.type !== "file" ||
    entry.contentKind !== expectation.contentKind ||
    entry.byteLength !== expectation.totalBytes ||
    entry.mediaType !== expectation.mediaType ||
    entry.etagSha256 !== expectation.etagSha256 ||
    ((expectation.expectedNodeId === null) !==
      (expectation.expectedRevision === null)) ||
    (expectation.moveSource !== null &&
      expectation.expectedNodeId !== null)
  ) {
    return false;
  }
  const expectedIdentity =
    expectation.moveSource ??
    (expectation.expectedNodeId === null ||
        expectation.expectedRevision === null
      ? null
      : {
          expectedNodeId: expectation.expectedNodeId,
          expectedRevision: expectation.expectedRevision,
        });
  if (expectedIdentity !== null) {
    const nextRevision = incrementCanonicalNat64(
      expectedIdentity.expectedRevision,
    );
    return (
      nextRevision !== null &&
      entry.nodeId === expectedIdentity.expectedNodeId &&
      entry.revision === nextRevision
    );
  }
  return !expectation.ifNoneMatch || entry.revision === "1";
}

function incrementCanonicalNat64(
  value: CanonicalNat64,
): CanonicalNat64 | null {
  const next = BigInt(value) + 1n;
  return next > 18_446_744_073_709_551_615n
    ? null
    : next.toString() as CanonicalNat64;
}

function assertPlainMutationPath(
  space: FilesPlainSpace,
  actualPath: string,
  expectedPath: string,
): void {
  if (
    actualPath !== expectedPath ||
    !validPlainPath(space, actualPath)
  ) {
    throw integrityFault("Files returned a receipt for another change");
  }
}

function assertSamePlainFolderIdentity(
  original: FilesServiceEntry,
  originalNodeId: CanonicalNat64,
  current: FilesServiceEntry,
): void {
  if (
    original.type !== "folder" ||
    current.type !== "folder" ||
    current.nodeId !== originalNodeId ||
    current.createdAtNs !== original.createdAtNs
  ) {
    throw conflict("The folder changed while it was being removed");
  }
}

function joinPlainChildPath(parentPath: string, name: string): string {
  return parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
}

function validPlainName(value: string): boolean {
  return isCanonicalPlainFilesName(value);
}

function validPlainPath(
  space: FilesPlainSpace,
  value: string,
): boolean {
  if (
    value === "" ||
    utf8Length(value) > PLAIN_PATH_BYTES ||
    !value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes("//") ||
    (value !== "/" && value.endsWith("/")) ||
    !isCanonicalPlainFilesPath(value) ||
    [...value].length >
      (
        space === "shared"
          ? FILES_V2_LIMITS.sharedRelativePathScalars
          : FILES_V2_LIMITS.workspaceRelativePathScalars
      )
  ) {
    return false;
  }
  const segments = value.split("/").filter(Boolean);
  return (
    segments.length <= FILES_V2_LIMITS.treeDepth &&
    segments.every(validPlainName)
  );
}

function validPlainMediaType(value: string): boolean {
  const bytes = new TextEncoder().encode(value);
  return (
    bytes.byteLength <= FILES_SERVICE_LIMITS.mediaTypeBytes &&
    bytes.every((byte) => byte >= 32 && byte <= 126)
  );
}

function comparePlainNames(left: string, right: string): number {
  const leftScalars = [...left];
  const rightScalars = [...right];
  const common = Math.min(leftScalars.length, rightScalars.length);
  for (let index = 0; index < common; index += 1) {
    const leftCodePoint = leftScalars[index]!.codePointAt(0)!;
    const rightCodePoint = rightScalars[index]!.codePointAt(0)!;
    if (leftCodePoint !== rightCodePoint) {
      return leftCodePoint < rightCodePoint ? -1 : 1;
    }
  }
  return leftScalars.length === rightScalars.length
    ? 0
    : leftScalars.length < rightScalars.length
      ? -1
      : 1;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function serviceEntry(
  space: FilesPlainSpace,
  entry: FilesPlainEntry,
): FilesServiceEntry {
  const root = space === "shared" ? "/Shared" : "/Workspace";
  return {
    nodeId: entry.nodeId,
    path: entry.path === "/" ? root : `${root}${entry.path}`,
    name: entry.name,
    type: entry.type,
    storageClass: space,
    contentKind: entry.contentKind,
    byteLength: entry.byteLength,
    mediaType: entry.mediaType,
    etagSha256: entry.etagSha256,
    publicUrl: entry.relativeUrl,
    createdAtNs: entry.createdAtNs,
    modifiedAtNs: entry.modifiedAtNs,
    structuralRevision: entry.revision,
    contentId: null,
  };
}

function requirePlainNodeId(entry: FilesServiceEntry): CanonicalNat64 {
  if (entry.nodeId === null) {
    throw integrityFault("Files returned a plaintext item without an identity");
  }
  return entry.nodeId;
}

type ReadablePlainEntry = FilesServiceEntry & Readonly<{
  type: "file";
  contentKind: "text" | "binary";
  byteLength: number;
  mediaType: string;
  etagSha256: string;
}>;

function assertReadableEntry(
  entry: FilesServiceEntry,
  space: FilesPlainSpace,
): asserts entry is ReadablePlainEntry {
  if (entry.type !== "file") {
    throw new FilesServiceFault(
      "not_found",
      "This path is not a file",
      "Choose a file",
    );
  }
  if (
    entry.nodeId === null ||
    entry.contentKind === null ||
    entry.byteLength === null ||
    entry.mediaType === null ||
    entry.etagSha256 === null ||
    !/^[a-f0-9]{64}$/u.test(entry.etagSha256) ||
    !Number.isSafeInteger(entry.byteLength) ||
    entry.byteLength < 0 ||
    entry.byteLength > PLAIN_FILE_BYTES ||
    (space === "workspace" && (entry.publicUrl ?? null) !== null)
  ) {
    throw integrityFault("Files returned invalid stored-file details");
  }
}

function sameReadableSnapshot(
  expected: ReadablePlainEntry,
  actual: FilesServiceEntry,
): boolean {
  return (
    actual.type === "file" &&
    actual.nodeId === expected.nodeId &&
    actual.path === expected.path &&
    actual.name === expected.name &&
    actual.storageClass === expected.storageClass &&
    actual.contentKind === expected.contentKind &&
    actual.byteLength === expected.byteLength &&
    actual.mediaType === expected.mediaType &&
    actual.etagSha256 === expected.etagSha256 &&
    (actual.publicUrl ?? null) === (expected.publicUrl ?? null) &&
    actual.createdAtNs === expected.createdAtNs &&
    actual.modifiedAtNs === expected.modifiedAtNs &&
    actual.structuralRevision === expected.structuralRevision &&
    actual.contentId === expected.contentId
  );
}

function canonicalReadBlockCount(totalBytes: number): number {
  const blockCount = Math.max(
    1,
    Math.ceil(totalBytes / PLAIN_BLOCK_BYTES),
  );
  if (blockCount < 1 || blockCount > MAX_PLAIN_BLOCKS) {
    throw integrityFault("Files returned an invalid stored-file size");
  }
  return blockCount;
}

export function filesCanonicalPublicOrigin(href: string): string {
  const origin = kernelParentOriginFromAppUrl(href);
  if (origin === null) {
    throw new Error(
      "Files public URLs require the verified Kernel canister origin",
    );
  }
  return origin;
}

function exactCertifiedShareUrl(
  relativeUrl: string | null | undefined,
  path: string,
  publicBaseUrl: string,
): URL {
  if (!relativeUrl) {
    throw new FilesServiceFault(
      "temporarily_unavailable",
      "The public link is still being prepared",
      "Try again in a moment",
    );
  }
  let base: URL;
  try {
    base = new URL(publicBaseUrl);
  } catch {
    throw integrityFault("Files could not validate the public-file address");
  }
  if (
    !isExactPlainSharedRelativeUrl(relativeUrl, path) ||
    (base.protocol !== "http:" && base.protocol !== "https:") ||
    base.origin === "null"
  ) {
    throw integrityFault("Files returned an invalid public-file address");
  }
  const target = new URL(relativeUrl, base.origin);
  if (
    target.origin !== base.origin ||
    target.pathname !== relativeUrl ||
    target.search !== "" ||
    target.hash !== "" ||
    target.href !== `${base.origin}${relativeUrl}`
  ) {
    throw integrityFault("Files returned an invalid public-file address");
  }
  return target;
}

function isExactPlainSharedRelativeUrl(
  value: string | null | undefined,
  path: string,
): value is string {
  if (value === null || value === undefined) return false;
  const match = value.match(
    /^\/app\/files\/_route\/shares\/[0-9a-f]{64}\/([A-Za-z0-9._-]{1,100})$/u,
  );
  return (
    match !== null &&
    match[1] !== "." &&
    match[1] !== ".." &&
    match[1] === safePublicName(path)
  );
}

async function readPublicBody(
  response: Response,
  output: Uint8Array,
  digest: ReturnType<typeof nobleSha256.create>,
  expectedBytes: number,
  controls: FilesTransferControls,
): Promise<number> {
  assertPublicContentLength(response, expectedBytes);
  const body = response.body;
  if (body === null) {
    if (expectedBytes === 0) return 0;
    throw integrityFault("The shared file response omitted its body");
  }
  const reader = body.getReader();
  const blockCount = canonicalReadBlockCount(expectedBytes);
  let loaded = 0;
  try {
    while (true) {
      throwIfAborted(controls.signal);
      const next = await awaitSignalFenced(
        reader.read(),
        controls.signal,
        (late) => {
          if (!late.done) late.value.fill(0);
        },
      );
      if (next.done) break;
      const chunk = next.value;
      try {
        if (
          !(chunk instanceof Uint8Array) ||
          loaded + chunk.byteLength > expectedBytes ||
          loaded + chunk.byteLength > PLAIN_FILE_BYTES
        ) {
          throw integrityFault("The shared file returned too much data");
        }
        output.set(chunk, loaded);
        digest.update(chunk);
        loaded += chunk.byteLength;
      } finally {
        if (chunk instanceof Uint8Array) chunk.fill(0);
      }
      controls.onProgress?.({
        phase: "downloading",
        plaintextBytes: expectedBytes,
        processedBytes: loaded,
        blockIndex: Math.min(
          blockCount - 1,
          Math.floor(Math.max(0, loaded - 1) / PLAIN_BLOCK_BYTES),
        ),
        blockCount,
      });
    }
  } catch (error) {
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      // The linked abort already fenced the response body.
    }
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A pending cancelled read owns no data that can be returned.
    }
  }
  return loaded;
}

function assertPublicContentLength(
  response: Response,
  expectedBytes: number,
): void {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (
      !/^(0|[1-9][0-9]*)$/u.test(contentLength) ||
      contentLength.length > 20
    ) {
      throw integrityFault(
        "The shared file returned an invalid Content-Length",
      );
    }
    const declared = BigInt(contentLength);
    if (
      declared > BigInt(PLAIN_FILE_BYTES) ||
      declared !== BigInt(expectedBytes)
    ) {
      throw integrityFault(
        "The shared file returned an unexpected Content-Length",
      );
    }
  }
}

function integrityFault(message: string): FilesServiceFault {
  return new FilesServiceFault(
    "incompatible",
    message,
    "Retry after refreshing the folder",
  );
}

function plainAuthorityChangedFault(): FilesServiceFault {
  return new FilesServiceFault(
    "cancelled",
    "Files authority changed while data was in flight",
    "Try again",
  );
}

function discardPlainReadChunk(value: { body: Uint8Array }): void {
  value.body.fill(0);
}

function discardPublicResponse(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // A locked or already-consumed response has no reusable body to expose.
  }
}

function linkPlainOperationSignals(
  userSignal: AbortSignal | undefined,
  authoritySignal: AbortSignal,
): Readonly<{
  signal: AbortSignal;
  dispose: () => void;
}> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const sources = userSignal
    ? [userSignal, authoritySignal]
    : [authoritySignal];
  for (const source of sources) {
    if (source.aborted) {
      controller.abort();
      break;
    }
    source.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const source of sources) {
        source.removeEventListener("abort", abort);
      }
    },
  };
}

function awaitSignalFenced<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
  discard?: (value: T) => void,
): Promise<T> {
  if (!signal) return pending;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("Cancelled", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        if (settled) {
          try {
            discard?.(value);
          } catch {
            // A failed best-effort discard cannot revive an aborted read.
          }
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function mutationResult(
  space: FilesPlainSpace,
  result: {
    path: string;
    revision: CanonicalNat64;
    changed: number;
  },
): FilesServiceMutationResult {
  const root = space === "shared" ? "/Shared" : "/Workspace";
  return {
    path: result.path === "/" ? root : `${root}${result.path}`,
    structuralRevision: result.revision,
    changed: result.changed,
    cleanupPending: false,
  };
}

function presentation(
  space: FilesPlainSpace,
  path: string,
  _contentKind: "text" | "binary",
): "inline_text" | "attachment" | null {
  if (space !== "shared") return null;
  // Public behavior is a property of the filename, including files uploaded
  // through the binary/chunked browser path.
  return sharedPresentationForPath(path);
}

function plainContentKind(
  location: ReturnType<typeof plainLocation>,
  requested: "text" | "binary",
): "text" | "binary" {
  if (location.space !== "shared") return requested;
  return sharedPresentationForPath(location.path) === "inline_text"
    ? "text"
    : "binary";
}

function validatePlainSize(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > PLAIN_FILE_BYTES
  ) {
    throw new FilesServiceFault(
      "limit",
      "Files can store up to 64 MiB in one file",
      "Choose a smaller file",
    );
  }
}

function canonicalBlockCount(totalBytes: number): number {
  const count = Math.max(1, Math.ceil(totalBytes / PLAIN_BLOCK_BYTES));
  if (count > MAX_PLAIN_BLOCKS) {
    throw new FilesServiceFault(
      "limit",
      "This file needs too many storage blocks",
      "Choose a smaller file",
    );
  }
  return count;
}

async function sourceBlock(
  source: FilesTransferSource,
  ordinal: number,
): Promise<Uint8Array> {
  const start = ordinal * PLAIN_BLOCK_BYTES;
  const end = Math.min(source.size, start + PLAIN_BLOCK_BYTES);
  const value = await source.slice(start, end);
  const bytes =
    value instanceof Blob
      ? new Uint8Array(await value.arrayBuffer())
      : value instanceof Uint8Array
        ? value.slice()
        : new Uint8Array(value.slice(0));
  if (bytes.byteLength !== end - start) {
    throw new FilesServiceFault(
      "invalid",
      "The upload source changed while Files was reading it",
      "Start the upload again",
    );
  }
  return bytes;
}

function validateUploadChunk(
  session: PlainUploadSession,
  input: {
    pass: "hash" | "encrypt";
    ordinal: number;
    final: boolean;
    totalBytes: number;
  },
  bytes: Uint8Array,
): void {
  const expectedOrdinal =
    input.pass === "hash"
      ? session.nextHashOrdinal
      : session.nextUploadOrdinal;
  const expectedBytes =
    input.ordinal + 1 === session.blockCount
      ? session.totalBytes - input.ordinal * PLAIN_BLOCK_BYTES
      : PLAIN_BLOCK_BYTES;
  if (
    input.totalBytes !== session.totalBytes ||
    input.ordinal !== expectedOrdinal ||
    input.final !== (input.ordinal + 1 === session.blockCount) ||
    bytes.byteLength !== expectedBytes
  ) {
    throw new FilesServiceFault(
      "invalid",
      "Upload chunks arrived out of order",
      "Start the upload again",
    );
  }
}

function uploadResult(
  session: PlainUploadSession,
  committed: boolean,
  readyForUpload: boolean,
  entry: FilesServiceEntry | null,
) {
  return {
    transferId: session.transferId,
    phase: session.phase,
    processedBytes:
      session.phase === "hashing"
        ? session.hashBytes
        : Math.min(
            session.totalBytes,
            session.nextUploadOrdinal * PLAIN_BLOCK_BYTES,
          ),
    totalBytes: session.totalBytes,
    committed,
    readyForUpload,
    entry,
  };
}

function acceptedUploadBytes(session: PlainUploadSession): number {
  return session.digestHex === null
    ? session.hashBytes
    : Math.min(
        session.totalBytes,
        session.nextUploadOrdinal * PLAIN_BLOCK_BYTES,
      );
}

function isPlainUploadSession(
  session: PlainTrackedTransfer,
): session is PlainUploadSession {
  return "uploadMode" in session;
}

function trackedProcessedBytes(session: PlainTrackedTransfer): number {
  return isPlainUploadSession(session)
    ? acceptedUploadBytes(session)
    : (session as PlainWriteSession).processedBytes;
}

function isAmbiguousUploadFailure(error: unknown): boolean {
  if (error instanceof FilesPlainBackendError) return false;
  if (error instanceof FilesServiceFault) {
    return (
      error.code === "uncertain" ||
      error.code === "temporarily_unavailable"
    );
  }
  return !(
    error instanceof DOMException &&
    error.name === "AbortError"
  );
}

function uploadFailurePhase(error: unknown): FilesTransferPhase {
  return error instanceof FilesServiceFault && error.code === "conflict"
    ? "conflicted"
    : "failed";
}

function cancelledUploadFault(): FilesServiceFault {
  return new FilesServiceFault(
    "cancelled",
    "This upload was cancelled",
    "Start the upload again",
  );
}

function uploadSourceChangedFault(): FilesServiceFault {
  return new FilesServiceFault(
    "invalid",
    "The file changed while it was being uploaded",
    "Start the upload again",
  );
}

function deferredUploadCapacityFault(): FilesServiceFault {
  return new FilesServiceFault(
    "temporarily_unavailable",
    "Files is already holding another upload",
    "Wait for it to finish",
  );
}

function inactiveUploadFault(): FilesServiceFault {
  return new FilesServiceFault(
    "cancelled",
    "This upload expired while it was waiting",
    "Start the upload again",
  );
}

function uncertainPlainWriteFault(): FilesServiceFault {
  return new FilesServiceFault(
    "uncertain",
    "Files may still be finishing this write",
    "Refresh the destination folder before retrying",
  );
}

function uncertainPlainUploadFault(): FilesServiceFault {
  return new FilesServiceFault(
    "uncertain",
    "Files may still be finishing this upload",
    "Refresh the destination folder before retrying",
  );
}

function afterInboundAttachmentHandler(): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, 0);
  });
}

function schedulePlainUploadTimer(
  callback: () => void,
  delayMs: number,
): () => void {
  const timer = globalThis.setTimeout(callback, delayMs);
  (
    timer as unknown as Readonly<{ unref?: () => void }>
  ).unref?.();
  return () => globalThis.clearTimeout(timer);
}

function serviceError(error: unknown): Error {
  if (error instanceof FilesPlainBackendProtocolError) {
    return integrityFault("Files could not verify its stored data");
  }
  if (!(error instanceof FilesPlainBackendError)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  switch (error.reason) {
    case "not_found":
      return new FilesServiceFault(
        "not_found",
        "The file or folder no longer exists",
        "Refresh the folder",
      );
    case "already_exists":
    case "stale_revision":
    case "stale_content":
    case "conflict":
      return conflict("The file or folder already exists or changed");
    case "not_file":
    case "not_folder":
      return new FilesServiceFault(
        "not_found",
        "The file or folder is no longer available",
        "Refresh the folder",
      );
    case "cursor_stale":
      return new FilesServiceFault(
        "cursor_expired",
        "The folder changed while it was being listed",
        "Refresh the folder",
      );
    case "quota":
      return new FilesServiceFault(
        "quota",
        "This Files root is out of storage space",
        "Remove files and try again",
      );
    case "busy":
    case "not_ready":
    case "temporarily_unavailable":
      return new FilesServiceFault(
        "temporarily_unavailable",
        "Files is busy finishing another change",
        "Try again in a moment",
      );
    case "corrupt_state":
    case "incompatible":
      return integrityFault("Files could not verify its stored data");
    default:
      return new FilesServiceFault(
        "invalid",
        `Files rejected this change (${error.reason})`,
        "Refresh and try again",
      );
  }
}

function conflict(message: string): FilesServiceFault {
  return new FilesServiceFault(
    "conflict",
    message,
    "Choose another name or refresh the folder",
  );
}

function emptyPublicUsage(): FilesServiceStatus["publicUsage"] {
  const counters = {
    liveEntries: ZERO,
    occupiedEntrySlots: ZERO,
    committedBodyBytes: ZERO,
    reservedCommittedBodyBytes: ZERO,
    reservedEntrySlots: ZERO,
    allocatedBodyBytes: ZERO,
    chargedMetadataBytes: ZERO,
    acceptedStagedBytes: ZERO,
    reservedStagedBytes: ZERO,
    detachedChargedBytes: ZERO,
    activeStages: ZERO,
    receiptLanes: ZERO,
    generalReceiptLanes: ZERO,
    reservedGeneralReceiptLanes: ZERO,
    reservedRevocationLanes: ZERO,
    filledRevocationLanes: ZERO,
    receiptNonceIndexes: ZERO,
    receiptExpiryIndexes: ZERO,
    cleanupJobs: ZERO,
  };
  const limits = {
    entries: ZERO,
    committedBytes: ZERO,
    objectBytes: ZERO,
    stagedBytes: ZERO,
    pendingStages: ZERO,
    batchOperations: ZERO,
    batchBytes: ZERO,
    generalReceipts: ZERO,
    revocationLanes: ZERO,
  };
  return {
    current: counters,
    manifestLimits: limits,
    effectiveLimits: limits,
  };
}

function byteSource(
  bytes: Uint8Array,
  name: string,
  type: string,
): FilesTransferSource {
  return {
    size: bytes.byteLength,
    name,
    type,
    slice(start, end) {
      return bytes.slice(start, end);
    },
  };
}

function writeTokens() {
  return {
    beginNonce: randomBytes(16),
    commitNonce: randomBytes(16),
    deleteNonce: randomBytes(16),
  };
}

function randomBytes(length: number): Uint8Array {
  const output = new Uint8Array(length);
  globalThis.crypto.getRandomValues(output);
  return output;
}

function randomHex(length: number): string {
  return hex(randomBytes(length));
}

function hex(bytes: Uint8Array): string {
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function digestHexAndWipe(
  digest: ReturnType<typeof nobleSha256.create>,
): string {
  const bytes = digest.digest();
  try {
    return hex(bytes);
  } finally {
    bytes.fill(0);
  }
}

function destroyHashQuietly(
  digest: ReturnType<typeof nobleSha256.create>,
): void {
  try {
    digest.destroy();
  } catch {
    // Finalized and already-destroyed hash state is still wiped.
  }
}

function safePublicName(path: string): string {
  const raw = path.split("/").at(-1) ?? "file";
  const safe = raw
    .normalize("NFC")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 100);
  return safe && safe !== "." && safe !== ".." ? safe : "file";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
}
