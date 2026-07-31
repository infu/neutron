import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import type {
  CanonicalNat64,
  FilesCleanupStateV2,
  FilesCommittedNodeV2,
  FilesId128V2,
  FilesOperationStateV2,
  FilesOperationStatusOkV2,
  FilesOperationTargetV2,
  FilesRejectionReasonV2,
  FilesRemoveRequestV2,
} from "../protocol/types.ts";
import { filesId128ToKey } from "../protocol/ids.ts";
import { FILES_V2_LIMITS } from "../protocol/constants.ts";
import { equalBytes } from "../crypto/canonical.ts";
import {
  planPrivateBlocks,
} from "../crypto/private_files.ts";
import type {
  FilesContentBlockBinding,
  FilesMetadataBinding,
} from "../crypto/types.ts";
import type {
  FilesCryptoWorkerResult,
} from "../crypto/worker_protocol.ts";
import {
  assertFilesMetadataBinding,
  assertStrictUtf8Text,
  decodeFilesMetadata,
  encodeFilesMetadata,
  validateFilesMetadata,
} from "./metadata.ts";
import {
  assertFilesReadBinding,
  decodeFilesReadFrame,
  encodeFilesMutateFrame,
  encodeFilesWriteContinuationFrame,
  encodeFilesWriteFirstFrame,
  filesWriteBlockKey,
  planFilesPrivateWrite,
  type FilesMutateFrameInput,
  type FilesPreparedWriteNode,
  type FilesPrivateWriteLayout,
  type FilesWriteFrameLayout,
} from "./frame_codec.ts";
import {
  filesDigestToBytes,
  filesId128ToBytes,
  randomFilesId128,
  randomFilesRequestId,
  sameFilesId,
} from "./ids.ts";
import type {
  FilesBackendPort,
  FilesCryptoPort,
  FilesFileMetadata,
  FilesPrivateWritePlan,
  FilesReadRequest,
  FilesReadResult,
  FilesTransferControls,
  FilesTransferProgress,
  FilesTransferSource,
  FilesWriteReceipt,
} from "./types.ts";
import type { FilesVaultEngine } from "./vault_engine.ts";

const MAX_TRANSPORT_ATTEMPTS = 3;
const RETRY_BASE_MS = 100;

type SecondPassVerifier = {
  hasher: ReturnType<typeof nobleSha256.create>;
  processed: number;
  expectedBytes: number;
  expectedDigest: Uint8Array;
  verified: boolean;
};

export type FilesTransferEngineDependencies = Readonly<{
  backend: FilesBackendPort;
  crypto: FilesCryptoPort;
  vault: FilesVaultEngine;
  randomBytes?: (length: number) => Uint8Array;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}>;

export class FilesTransferEngineFault extends Error {
  readonly rejectionReason: FilesRejectionReasonV2 | null;

  constructor(
    readonly code:
      | "needs_user_unlock"
      | "invalid"
      | "not_found"
      | "conflict"
      | "quota"
      | "busy"
      | "incompatible"
      | "corrupt_state"
      | "cancelled"
      | "uncertain",
    message: string = code,
    options?: ErrorOptions & Readonly<{
      rejectionReason?: FilesRejectionReasonV2 | null;
    }>,
  ) {
    super(message, options);
    this.name = "FilesTransferEngineFault";
    this.rejectionReason = options?.rejectionReason ?? null;
  }
}

export type FilesStageAbortInput = Readonly<{
  requestId: FilesId128V2;
  stageId: CanonicalNat64;
}>;

/**
 * Abort an exact persisted stage without constructing or unlocking the
 * private crypto runtime. Reconciliation binds every authority field because
 * a lost abort reply must not be confused with another stage owned by the
 * same request lane.
 */
export async function abortFilesStage(
  backend: FilesBackendPort,
  input: FilesStageAbortInput,
): Promise<void> {
  const request = {
    request_id: input.requestId,
    stage_id: input.stageId,
  } as const;
  const target: FilesOperationTargetV2 = {
    abort: {
      stage_id: input.stageId,
    },
  };
  try {
    const outcome = await backend.abort(request);
    validateAbortReceipt(
      expectOutcome(outcome, "Files abort"),
      input.requestId,
      input.stageId,
    );
  } catch (error) {
    if (isKnownTransferFault(error)) throw error;
    let outcome;
    try {
      outcome = await backend.operationStatus({
        request_id: input.requestId,
        target,
      });
    } catch (statusError) {
      throw new FilesTransferEngineFault(
        "uncertain",
        "Files abort outcome remains uncertain",
        { cause: statusError ?? error },
      );
    }
    const status = expectOutcome(outcome, "Files abort status");
    validateOperationStatusEcho(status, input.requestId, target);
    if (status.state === null) {
      throw new FilesTransferEngineFault(
        "incompatible",
        "Files abort status omitted its state",
      );
    }
    if (!("committed" in status.state)) {
      throw terminalOrUncertain("Files abort", status.state, error);
    }
    const detail = status.state.committed.detail;
    if (detail === null || !("abort" in detail)) {
      throw new FilesTransferEngineFault(
        "incompatible",
        "Files abort reconciliation omitted its exact receipt",
      );
    }
    validateAbortReceipt(
      detail.abort,
      input.requestId,
      input.stageId,
    );
  }
}

export class FilesTransferEngine {
  readonly #backend: FilesBackendPort;
  readonly #crypto: FilesCryptoPort;
  readonly #vault: FilesVaultEngine;
  readonly #randomBytes:
    | ((length: number) => Uint8Array)
    | undefined;
  readonly #wait: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly #activeControllers = new Set<AbortController>();
  readonly #unsubscribeLock: () => void;

  constructor(dependencies: FilesTransferEngineDependencies) {
    this.#backend = dependencies.backend;
    this.#crypto = dependencies.crypto;
    this.#vault = dependencies.vault;
    this.#randomBytes = dependencies.randomBytes;
    this.#wait = dependencies.wait ?? waitWithSignal;
    this.#unsubscribeLock = dependencies.vault.onLock(() => {
      for (const controller of this.#activeControllers) controller.abort();
      this.#activeControllers.clear();
    });
  }

  dispose(): void {
    this.#unsubscribeLock();
    for (const controller of this.#activeControllers) controller.abort();
    this.#activeControllers.clear();
  }

  async writePrivate(
    plan: FilesPrivateWritePlan,
    controls: FilesTransferControls = {},
  ): Promise<FilesWriteReceipt> {
    return this.#writePrivate(plan, controls, null);
  }

  async writePrivatePrehashed(
    plan: FilesPrivateWritePlan,
    prehashedDigests: readonly Uint8Array[],
    controls: FilesTransferControls = {},
  ): Promise<FilesWriteReceipt> {
    return this.#writePrivate(plan, controls, prehashedDigests);
  }

  async #writePrivate(
    plan: FilesPrivateWritePlan,
    controls: FilesTransferControls,
    prehashedDigests: readonly Uint8Array[] | null,
  ): Promise<FilesWriteReceipt> {
    this.#requireReady();
    validatePrivateWritePlan(plan);
    if (
      prehashedDigests !== null &&
      prehashedDigests.length !==
        plan.items.filter((item) => item.metadata.nodeKind === "file").length
    ) {
      throw new FilesTransferEngineFault(
        "invalid",
        "Files prehashed source count does not match the write plan",
      );
    }
    const operation = this.#operationSignal(controls.signal);
    const requestId = randomFilesRequestId(this.#randomBytes);
    let secondPass: readonly (SecondPassVerifier | null)[] = [];
    let stageId: CanonicalNat64 | null = null;
    try {
      const prepared = await this.#prepareWriteNodes(
        plan,
        controls,
        operation.signal,
        prehashedDigests,
      );
      const layout = planFilesPrivateWrite(plan.intent, prepared);
      secondPass = plan.items.map((item) =>
        item.metadata.nodeKind === "folder"
          ? null
          : {
              hasher: nobleSha256.create(),
              processed: 0,
              expectedBytes: item.source.size,
              expectedDigest: item.metadata.plaintextSha256.slice(),
              verified: false,
            }
      );
      let committedNodes: FilesCommittedNodeV2[] = [];
      let cleanupPending = false;
      for (const frameLayout of layout.frames) {
        throwIfAborted(operation.signal);
        const ciphertext = await this.#encryptFrameBlocks(
          layout,
          frameLayout,
          plan,
          controls,
          operation.signal,
          secondPass,
        );
        const exactFrame =
          frameLayout.frameOrdinal === 0
            ? encodeFilesWriteFirstFrame({
                requestId,
                layout,
                folderTransitions: plan.folderTransitions,
                childIndexTransitions: plan.childIndexTransitions,
                retiredContents: plan.retiredContents,
                quota: plan.quota,
                ciphertextBlocks: ciphertext,
              })
            : encodeFilesWriteContinuationFrame({
                requestId,
                stageId: requireStageId(stageId),
                layout,
                frameOrdinal: frameLayout.frameOrdinal,
                ciphertextBlocks: ciphertext,
              });
        for (const value of ciphertext.values()) value.fill(0);
        const retained = await this.#retainRetryFrame(
          requestId,
          frameLayout.frameOrdinal,
          exactFrame,
        );
        emitProgress(controls, {
          phase: "uploading",
          plaintextBytes: totalPlaintext(plan),
          processedBytes: plaintextThroughFrame(layout, frameLayout),
          blockIndex: lastBlockOrdinal(layout, frameLayout),
          blockCount: totalBlocks(layout),
        });
        let acknowledged = false;
        try {
          const acknowledgement = await this.#sendPrivateFrame({
            requestId,
            plan,
            layout,
            frameLayout,
            stageId,
            retainedFingerprint: retained,
            signal: operation.signal,
            controls,
            retainStageId: (retainedStageId) => {
              stageId = retainedStageId;
            },
          });
          stageId = acknowledgement.stageId;
          committedNodes = acknowledgement.committedNodes;
          cleanupPending = acknowledgement.cleanupPending;
          acknowledged = true;
        } finally {
          if (acknowledged) {
            await this.#releaseRetryFrame(
              requestId,
              frameLayout.frameOrdinal,
            ).catch(() => undefined);
          }
        }
      }
      validateCommittedNodes(committedNodes, plan, layout);
      const firstPlannedFile = plan.items.find(
        (item) => item.metadata.nodeKind === "file",
      );
      const first =
        firstPlannedFile === undefined
          ? null
          : committedNodes.find((node) =>
              sameFilesId(
                node.node_id,
                firstPlannedFile.transition.nodeId,
              )
            ) ?? null;
      const receipt: FilesWriteReceipt = Object.freeze({
        requestId,
        committedNodes: Object.freeze(committedNodes.slice()),
        nodeId: first?.node_id ?? null,
        contentId: first?.content_id ?? null,
        structuralRevision: first?.structural_revision ?? null,
        cleanupPending,
      });
      emitProgress(controls, {
        phase: cleanupPending ? "cleanup-pending" : "committed",
        plaintextBytes: totalPlaintext(plan),
        processedBytes: totalPlaintext(plan),
        blockIndex: totalBlocks(layout) - 1,
        blockCount: totalBlocks(layout),
      });
      return receipt;
    } catch (error) {
      if (
        stageId !== null &&
        !(
          error instanceof FilesTransferEngineFault &&
          error.code === "uncertain"
        )
      ) {
        await this.abort({
          requestId,
          stageId,
        }).catch(() => undefined);
      }
      emitTerminalFailure(controls, error, totalPlaintext(plan));
      throw error;
    } finally {
      for (const verifier of secondPass) {
        if (verifier === null) continue;
        verifier.hasher.destroy();
        verifier.expectedDigest.fill(0);
      }
      operation.dispose();
    }
  }

  async readPrivate(
    request: FilesReadRequest,
    controls: FilesTransferControls = {},
  ): Promise<FilesReadResult> {
    this.#requireReady();
    const operation = this.#operationSignal(controls.signal);
    try {
      const result = await this.#readVerified(
        request,
        controls,
        operation.signal,
        true,
      );
      if (result.bytes === null) {
        throw new FilesTransferEngineFault("corrupt_state");
      }
      emitProgress(controls, {
        phase: "committed",
        plaintextBytes: result.metadata.plaintextBytes,
        processedBytes: result.metadata.plaintextBytes,
        blockIndex: result.content.blockCount - 1,
        blockCount: result.content.blockCount,
      });
      return Object.freeze({
        metadata: result.metadata,
        bytes: result.bytes,
        node: result.node,
        content: result.content,
      });
    } catch (error) {
      emitTerminalFailure(controls, error, 0);
      throw error;
    } finally {
      operation.dispose();
    }
  }

  async mutate(input: FilesMutateFrameInput): Promise<
    Awaited<ReturnType<FilesBackendPort["mutate"]>> extends
      infer Outcome
      ? Outcome extends { kind: "ok"; value: infer Value }
        ? Value
        : never
      : never
  > {
    this.#requireReady();
    const frame = encodeFilesMutateFrame(input);
    const target: FilesOperationTargetV2 = {
      mutation: { node_id: input.node.nodeId },
    };
    try {
      const outcome = await this.#backend.mutate(
        {
          request_id: input.requestId,
          action: { [input.action]: null } as
            | { create_folder: null }
            | { rename: null }
            | { move: null },
          body_bytes: frame.byteLength,
          body: frame.slice(),
        },
      );
      const ok = expectOutcome(outcome, "Files mutation");
      validateMutationReceipt(ok, input);
      return ok as never;
    } catch (error) {
      if (isKnownTransferFault(error)) throw error;
      const status = await this.#reconcileExactStatus(
        input.requestId,
        target,
        "Files mutation",
        error,
      );
      if (!("committed" in status.state)) {
        throw terminalOrUncertain("Files mutation", status.state, error);
      }
      const detail = status.state.committed.detail;
      if (detail === null || !("mutation" in detail)) {
        throw new FilesTransferEngineFault(
          "incompatible",
          "Files mutation reconciliation omitted its exact receipt",
        );
      }
      validateMutationReceipt(detail.mutation, input);
      return detail.mutation as never;
    }
  }

  async remove(
    request: FilesRemoveRequestV2,
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<FilesBackendPort["remove"]>> extends
    infer Outcome
    ? Outcome extends { kind: "ok"; value: infer Value }
      ? Value
      : never
    : never> {
    throwIfAborted(signal);
    if (request.node_id.hi === "0" && request.node_id.lo === "0") {
      throw new FilesTransferEngineFault(
        "invalid",
        "The Files root cannot be removed",
      );
    }
    const target: FilesOperationTargetV2 = {
      remove: { node_id: request.node_id },
    };
    try {
      const outcome = await this.#backend.remove(request);
      const ok = expectOutcome(outcome, "Files remove");
      validateRemoveReceipt(ok, request);
      return ok as never;
    } catch (error) {
      if (isKnownTransferFault(error)) throw error;
      const status = await this.#reconcileExactStatus(
        request.request_id,
        target,
        "Files remove",
        error,
      );
      if (!("committed" in status.state)) {
        throw terminalOrUncertain("Files remove", status.state, error);
      }
      const detail = status.state.committed.detail;
      if (detail === null || !("remove" in detail)) {
        throw new FilesTransferEngineFault(
          "incompatible",
          "Files remove reconciliation omitted its exact receipt",
        );
      }
      validateRemoveReceipt(detail.remove, request);
      return detail.remove as never;
    }
  }

  async abort(input: FilesStageAbortInput): Promise<void> {
    await abortFilesStage(this.#backend, input);
    for (let ordinal = 0; ordinal < 9; ordinal += 1) {
      await this.#releaseRetryFrame(
        input.requestId,
        ordinal,
      ).catch(() => undefined);
    }
  }

  async cleanup(signal?: AbortSignal): Promise<
    Awaited<ReturnType<FilesBackendPort["cleanup"]>> extends
      infer Outcome
      ? Outcome extends { kind: "ok"; value: infer Value }
        ? Value
        : never
      : never
  > {
    throwIfAborted(signal);
    return expectOutcome(
      await this.#backend.cleanup({}),
      "Files cleanup",
    ) as never;
  }

  async reconcilePrivateWrite(
    requestId: FilesId128V2,
    nodes: readonly Readonly<{
      nodeId: FilesId128V2;
      contentId: FilesId128V2 | null;
    }>[],
  ): Promise<FilesOperationStateV2 | null> {
    const canonicalNodes = nodes.map((node) => ({
      node_id: node.nodeId,
      content_id: node.contentId,
    })).sort((left, right) => compareIds(left.node_id, right.node_id));
    const outcome = await this.#backend.operationStatus({
      request_id: requestId,
      target: {
        private_write: {
          nodes: canonicalNodes,
        },
      },
    });
    const ok = expectOutcome(outcome, "Files operation status");
    const target: FilesOperationTargetV2 = {
      private_write: {
        nodes: canonicalNodes,
      },
    };
    validateOperationStatusEcho(ok, requestId, target);
    if (ok.state === null) {
      throw new FilesTransferEngineFault(
        "incompatible",
        "Files operation status omitted its state",
      );
    }
    return ok.state;
  }

  async #reconcileExactStatus(
    requestId: FilesId128V2,
    target: FilesOperationTargetV2,
    label: string,
    cause: unknown,
  ): Promise<
    FilesOperationStatusOkV2 & { state: FilesOperationStateV2 }
  > {
    let outcome;
    try {
      outcome = await this.#backend.operationStatus({
        request_id: requestId,
        target,
      });
    } catch (statusError) {
      throw new FilesTransferEngineFault(
        "uncertain",
        `${label} outcome remains uncertain`,
        { cause: statusError ?? cause },
      );
    }
    const ok = expectOutcome(outcome, `${label} status`);
    validateOperationStatusEcho(ok, requestId, target);
    if (ok.state === null) {
      throw new FilesTransferEngineFault(
        "incompatible",
        `${label} status omitted its state`,
      );
    }
    return ok as FilesOperationStatusOkV2 & {
      state: FilesOperationStateV2;
    };
  }

  async #prepareWriteNodes(
    plan: FilesPrivateWritePlan,
    controls: FilesTransferControls,
    signal: AbortSignal,
    prehashedDigests: readonly Uint8Array[] | null,
  ): Promise<FilesPreparedWriteNode[]> {
    const prepared: FilesPreparedWriteNode[] = [];
    let processed = 0;
    let digestIndex = 0;
    for (let itemIndex = 0; itemIndex < plan.items.length; itemIndex += 1) {
      const item = plan.items[itemIndex]!;
      throwIfAborted(signal);
      const metadata = validateFilesMetadata(item.metadata);
      if (metadata.nodeKind !== item.transition.requestedKind) {
        throw new FilesTransferEngineFault(
          "invalid",
          "Files write metadata does not match its source",
        );
      }
      const tag = expectWorker(
        await this.#crypto.call({
          type: "name_tag",
          parentNodeId: item.transition.proposedParentId,
          filename: metadata.name,
        }),
        "name_tag",
      );
      if (!equalBytes(tag.nameTag, item.transition.proposedNameTag)) {
        throw new FilesTransferEngineFault(
          "invalid",
          "Files proposed name tag is not canonical",
        );
      }
      const metadataPlaintext = encodeFilesMetadata(metadata);
      let metadataEncrypted;
      try {
        metadataEncrypted = expectWorker(
          await this.#crypto.call({
            type: "encrypt_metadata",
            binding: metadataBinding(item.transition),
            plaintext: metadataPlaintext,
          }),
          "metadata_encrypted",
        );
        throwIfAborted(signal);
      } finally {
        // The real crypto worker takes ownership of this exact standalone
        // buffer. A successful postMessage transfer detaches the caller's
        // view, while a pre-transfer failure leaves it attached and still
        // needs local erasure.
        if (metadataPlaintext.byteLength > 0) {
          metadataPlaintext.fill(0);
        }
      }
      if (metadata.nodeKind === "folder") {
        if (item.source.size !== 0) {
          throw new FilesTransferEngineFault(
            "invalid",
            "Files folder write unexpectedly carried content",
          );
        }
        prepared.push(Object.freeze({
          transition: item.transition,
          encryptedMetadata: metadataEncrypted.ciphertext,
          content: null,
        }));
        continue;
      }
      if (
        metadata.plaintextBytes !== item.source.size
      ) {
        throw new FilesTransferEngineFault(
          "invalid",
          "Files write metadata does not match its source",
        );
      }
      const hash =
        prehashedDigests === null
          ? await hashSource(
              item.source,
              metadata.contentKind === "text_v1",
              signal,
              (bytes) => {
                emitProgress(controls, {
                  phase: "hashing",
                  plaintextBytes: totalPlaintext(plan),
                  processedBytes: processed + bytes,
                  blockIndex: 0,
                  blockCount: 1,
                });
              },
            )
          : prehashedDigests[digestIndex++]!.slice();
      processed += item.source.size;
      if (!equalBytes(hash, metadata.plaintextSha256)) {
        hash.fill(0);
        throw new FilesTransferEngineFault(
          "invalid",
          "Files source SHA-256 does not match its metadata",
        );
      }
      hash.fill(0);
      const contentId =
        item.contentId ?? randomFilesId128(this.#randomBytes);
      const content = expectWorker(
        await this.#crypto.call({
          type: "create_content_cipher",
          binding: {
            nodeId: item.transition.nodeId,
            contentId,
          },
        }),
        "content_cipher_ready",
      );
      if (content.wrappedKey === null) {
        throw new FilesTransferEngineFault("corrupt_state");
      }
      await this.#crypto.call({
        type: "release_content_cipher",
        handle: content.handle,
      });
      const geometry = planPrivateBlocks(item.source.size);
      prepared.push(Object.freeze({
        transition: item.transition,
        encryptedMetadata: metadataEncrypted.ciphertext,
        content: Object.freeze({
          contentId,
          wrappedContentKey: content.wrappedKey,
          plaintextBlockLengths: geometry.plaintextBlockLengths,
          ciphertextBlockLengths: geometry.ciphertextBlockLengths,
        }),
      }));
    }
    return prepared;
  }

  async #encryptFrameBlocks(
    layout: FilesPrivateWriteLayout,
    frame: FilesWriteFrameLayout,
    plan: FilesPrivateWritePlan,
    controls: FilesTransferControls,
    signal: AbortSignal,
    secondPass: readonly (SecondPassVerifier | null)[],
  ): Promise<Map<string, Uint8Array>> {
    const output = new Map<string, Uint8Array>();
    for (const block of frame.blocks) {
      throwIfAborted(signal);
      const nodeIndex = layout.nodes.findIndex((candidate) =>
        candidate.content !== null &&
        sameFilesId(candidate.content.contentId, block.contentId)
      );
      const node = layout.nodes[nodeIndex];
      const item = plan.items[nodeIndex];
      if (
        !node ||
        node.content === null ||
        !item
      ) {
        throw new FilesTransferEngineFault("corrupt_state");
      }
      const lengths = node.content.plaintextBlockLengths;
      const start = lengths.slice(0, block.blockIndex)
        .reduce((sum, length) => sum + length, 0);
      const plaintextLength = lengths[block.blockIndex];
      if (plaintextLength === undefined) {
        throw new FilesTransferEngineFault("corrupt_state");
      }
      const plaintext = await readSourceSlice(
        item.source,
        start,
        start + plaintextLength,
      );
      if (plaintext.byteLength !== plaintextLength) {
        throw new FilesTransferEngineFault(
          "invalid",
          "Files source changed while it was being uploaded",
        );
      }
      const verifier = secondPass[nodeIndex];
      if (verifier === null || verifier === undefined || verifier.verified) {
        plaintext.fill(0);
        throw new FilesTransferEngineFault("corrupt_state");
      }
      verifier.hasher.update(plaintext);
      verifier.processed += plaintext.byteLength;
      if (block.blockIndex === lengths.length - 1) {
        const digest = verifier.hasher.digest();
        verifier.verified = true;
        const changed =
          verifier.processed !== verifier.expectedBytes ||
          !equalBytes(digest, verifier.expectedDigest);
        digest.fill(0);
        if (changed) {
          plaintext.fill(0);
          throw new FilesTransferEngineFault(
            "invalid",
            "Files source changed between hashing and encryption",
          );
        }
      }
      const opened = expectWorker(
        await this.#crypto.call({
          type: "open_content_cipher",
          binding: {
            nodeId: item.transition.nodeId,
            contentId: block.contentId,
          },
          wrappedKey: node.content.wrappedContentKey,
        }),
        "content_cipher_ready",
      );
      try {
        const encrypted = expectWorker(
          await this.#crypto.call({
            type: "encrypt_content_block",
            handle: opened.handle,
            binding: {
              nodeId: item.transition.nodeId,
              contentId: block.contentId,
              blockIndex: block.blockIndex,
              totalBlockCount: lengths.length,
              plaintextBlockLength: plaintextLength,
            },
            plaintext,
          }),
          "content_block_encrypted",
        );
        if (encrypted.ciphertext.byteLength !== block.ciphertextBytes) {
          throw new FilesTransferEngineFault("corrupt_state");
        }
        output.set(
          filesWriteBlockKey(block.contentId, block.blockIndex),
          encrypted.ciphertext,
        );
      } finally {
        await this.#crypto.call({
          type: "release_content_cipher",
          handle: opened.handle,
        }).catch(() => undefined);
      }
      emitProgress(controls, {
        phase: "encrypting",
        plaintextBytes: totalPlaintext(plan),
        processedBytes: start + plaintextLength,
        blockIndex: block.blockIndex,
        blockCount: lengths.length,
      });
    }
    return output;
  }

  async #retainRetryFrame(
    requestId: FilesId128V2,
    frameOrdinal: number,
    frame: Uint8Array,
  ): Promise<Uint8Array> {
    const retained = expectWorker(
      await this.#crypto.call({
        type: "retain_retry_frame",
        operationId: filesId128ToKey(requestId),
        frameOrdinal,
        frame,
      }),
      "retry_frame_retained",
    );
    return retained.fingerprint;
  }

  async #releaseRetryFrame(
    requestId: FilesId128V2,
    frameOrdinal: number,
  ): Promise<void> {
    expectWorker(
      await this.#crypto.call({
        type: "release_retry_frame",
        operationId: filesId128ToKey(requestId),
        frameOrdinal,
      }),
      "retry_frame_released",
    );
  }

  async #exportRetryFrame(
    requestId: FilesId128V2,
    frameOrdinal: number,
    fingerprint: Uint8Array,
  ): Promise<Uint8Array> {
    const exported = expectWorker(
      await this.#crypto.call({
        type: "export_retry_frame",
        operationId: filesId128ToKey(requestId),
        frameOrdinal,
      }),
      "retry_frame_exported",
    );
    if (!equalBytes(exported.fingerprint, fingerprint)) {
      throw new FilesTransferEngineFault(
        "corrupt_state",
        "Files retry-frame fingerprint changed",
      );
    }
    return exported.frame;
  }

  async #sendPrivateFrame(input: {
    requestId: FilesId128V2;
    plan: FilesPrivateWritePlan;
    layout: FilesPrivateWriteLayout;
    frameLayout: FilesWriteFrameLayout;
    stageId: CanonicalNat64 | null;
    retainedFingerprint: Uint8Array;
    signal: AbortSignal;
    controls: FilesTransferControls;
    retainStageId: (stageId: CanonicalNat64) => void;
  }): Promise<{
    stageId: CanonicalNat64 | null;
    committedNodes: FilesCommittedNodeV2[];
    cleanupPending: boolean;
  }> {
    const targetNodes = input.layout.nodes.map((node) => ({
      node_id: node.transition.nodeId,
      content_id: node.content?.contentId ?? null,
    })).sort((left, right) => compareIds(left.node_id, right.node_id));
    const final =
      input.frameLayout.frameOrdinal === input.layout.frames.length - 1;
    let stageId = input.stageId;
    for (let attempt = 0; attempt < MAX_TRANSPORT_ATTEMPTS; attempt += 1) {
      throwIfAborted(input.signal);
      const exactFrame = await this.#exportRetryFrame(
        input.requestId,
        input.frameLayout.frameOrdinal,
        input.retainedFingerprint,
      );
      try {
        const outcome = await this.#backend.writeBlock(
          {
            request_id: input.requestId,
            stage_id: stageId,
            frame_ordinal: input.frameLayout.frameOrdinal,
            final,
            body_bytes: exactFrame.byteLength,
            body: exactFrame.slice(),
          },
        );
        const ok = expectOutcome(outcome, "Files private write");
        validateWriteAck(
          ok,
          input.requestId,
          input.frameLayout.frameOrdinal,
          input.layout,
          stageId,
        );
        stageId = ok.stage_id;
        if (!final) {
          if (stageId === null) {
            throw new FilesTransferEngineFault(
              "corrupt_state",
              "Files accepted write omitted its exact stage",
            );
          }
          input.retainStageId(stageId);
          // Retain the newly allocated exact stage before observing a
          // concurrent cancellation so the outer operation can abort it.
          // A fully validated final acknowledgement is already committed and
          // therefore wins the cancellation race.
          throwIfAborted(input.signal);
        }
        return {
          stageId: final ? null : stageId,
          committedNodes: ok.committed_nodes,
          cleanupPending: cleanupIsPending(ok.cleanup_state),
        };
      } catch (error) {
        if (isKnownTransferFault(error)) throw error;
        emitProgress(input.controls, {
          phase: "checking-outcome",
          plaintextBytes: totalPlaintext(input.plan),
          processedBytes:
            plaintextThroughFrame(input.layout, input.frameLayout),
          blockIndex: lastBlockOrdinal(
            input.layout,
            input.frameLayout,
          ),
          blockCount: totalBlocks(input.layout),
        });
        const statusTarget: FilesOperationTargetV2 = {
          private_write: {
            nodes: targetNodes,
          },
        };
        const status = await this.#backend.operationStatus({
          request_id: input.requestId,
          target: statusTarget,
        }).catch(() => null);
        if (status !== null) {
          const statusOk = expectOutcome(
            status,
            "Files private-write status",
          );
          validateOperationStatusEcho(
            statusOk,
            input.requestId,
            statusTarget,
          );
          if (statusOk.state === null) {
            throw new FilesTransferEngineFault(
              "incompatible",
              "Files private-write status omitted its state",
            );
          }
          const reconciled = reconcilePrivateState(
            statusOk.state,
            input.layout,
            input.frameLayout,
            input.requestId,
            stageId,
          );
          if (reconciled.kind === "committed") {
            return {
              stageId: null,
              committedNodes: reconciled.nodes,
              cleanupPending:
                cleanupIsPending(statusOk.cleanup_state),
            };
          }
          if (reconciled.kind === "accepted") {
            if (reconciled.stageId === null) {
              throw new FilesTransferEngineFault(
                "corrupt_state",
                "Files accepted write omitted its exact stage",
              );
            }
            stageId = reconciled.stageId;
            input.retainStageId(stageId);
            throwIfAborted(input.signal);
            return {
              stageId,
              committedNodes: [],
              cleanupPending:
                cleanupIsPending(statusOk.cleanup_state),
            };
          }
          if (reconciled.kind === "terminal") {
            throwIfAborted(input.signal);
            throw new FilesTransferEngineFault(
              "conflict",
              "Files write stage is no longer active",
            );
          }
          stageId = reconciled.stageId ?? stageId;
          if (stageId !== null) input.retainStageId(stageId);
        }
        throwIfAborted(input.signal);
        if (attempt === MAX_TRANSPORT_ATTEMPTS - 1) {
          throw new FilesTransferEngineFault(
            "uncertain",
            "Files write outcome remains uncertain",
            { cause: error },
          );
        }
        await this.#wait(
          RETRY_BASE_MS * 2 ** attempt,
          input.signal,
        );
      } finally {
        exactFrame.fill(0);
      }
    }
    throw new FilesTransferEngineFault("uncertain");
  }

  async #readVerified(
    request: FilesReadRequest,
    controls: FilesTransferControls,
    signal: AbortSignal,
    collect: boolean,
    consume?: (input: {
      plaintext: Uint8Array;
      index: number;
      blockCount: number;
      metadata: FilesFileMetadata;
    }) => Promise<void>,
  ): Promise<{
    metadata: FilesFileMetadata;
    bytes: Uint8Array | null;
    node: import("./types.ts").FilesFrameNodeSummary;
    content: import("./types.ts").FilesFrameContentSummary;
  }> {
    throwIfAborted(signal);
    const firstOutcome = await this.#backend.readChunk({
      node_id: request.nodeId,
      structural_revision: request.structuralRevision,
      content_id: request.contentId,
      index: 0,
    });
    throwIfAborted(signal);
    const firstOuter = expectReadOutcome(firstOutcome, "Files read");
    const first = decodeFilesReadFrame(firstOutcome.body);
    assertFilesReadBinding(firstOuter, first.control);
    if (
      first.control.kind !== "first" ||
      !sameFilesId(first.control.node.nodeId, request.nodeId) ||
      !sameFilesId(first.control.content.contentId, request.contentId) ||
      first.control.node.structuralRevision !== request.structuralRevision ||
      first.control.node.kind !== "file"
    ) {
      throw new FilesTransferEngineFault(
        "corrupt_state",
        "Files first read frame has the wrong identity",
      );
    }
    const metadata = await this.#decryptFileMetadata(
      first.control.node,
      first.control.encryptedMetadata,
    );
    const geometry = planPrivateBlocks(metadata.plaintextBytes);
    if (
      first.control.content.blockCount !==
        geometry.plaintextBlockLengths.length ||
      first.control.content.ciphertextBytes !==
        geometry.ciphertextBytes.toString()
    ) {
      throw new FilesTransferEngineFault(
        "corrupt_state",
        "Files read geometry does not match encrypted metadata",
      );
    }
    const opened = expectWorker(
      await this.#crypto.call({
        type: "open_content_cipher",
        binding: {
          nodeId: request.nodeId,
          contentId: request.contentId,
        },
        wrappedKey: first.control.wrappedContentKey,
      }),
      "content_cipher_ready",
    );
    const hash = nobleSha256.create();
    const output = collect
      ? new Uint8Array(metadata.plaintextBytes)
      : null;
    let outputOffset = 0;
    try {
      for (
        let index = 0;
        index < geometry.plaintextBlockLengths.length;
        index += 1
      ) {
        throwIfAborted(signal);
        let ciphertext: Uint8Array;
        if (index === 0) {
          ciphertext = first.control.ciphertextBlock;
        } else {
          const nextOutcome = await this.#backend.readChunk({
            node_id: request.nodeId,
            structural_revision: request.structuralRevision,
            content_id: request.contentId,
            index,
          });
          throwIfAborted(signal);
          const nextOuter = expectReadOutcome(
            nextOutcome,
            "Files read continuation",
          );
          const next = decodeFilesReadFrame(nextOutcome.body);
          assertFilesReadBinding(nextOuter, next.control);
          if (
            next.control.kind !== "continuation" ||
            !sameFilesId(next.control.nodeId, request.nodeId) ||
            !sameFilesId(next.control.contentId, request.contentId) ||
            next.control.structuralRevision !==
              request.structuralRevision ||
            next.control.metadataRevision !==
              first.control.node.metadataRevision ||
            next.control.index !== index ||
            next.control.blockCount !==
              geometry.plaintextBlockLengths.length ||
            next.control.ciphertextTotalBytes !==
              geometry.ciphertextBytes.toString() ||
            next.control.ciphertextBlockBytes !==
              geometry.ciphertextBlockLengths[index]
          ) {
            throw new FilesTransferEngineFault(
              "corrupt_state",
              "Files continuation frame changed version",
            );
          }
          ciphertext = next.control.ciphertextBlock;
        }
        const plaintextLength =
          geometry.plaintextBlockLengths[index]!;
        if (ciphertext.byteLength !== plaintextLength + 16) {
          throw new FilesTransferEngineFault(
            "corrupt_state",
            "Files ciphertext block has the wrong length",
          );
        }
        const decrypted = expectWorker(
          await this.#crypto.call({
            type: "decrypt_content_block",
            handle: opened.handle,
            binding: {
              nodeId: request.nodeId,
              contentId: request.contentId,
              blockIndex: index,
              totalBlockCount:
                geometry.plaintextBlockLengths.length,
              plaintextBlockLength: plaintextLength,
            },
            ciphertext: ciphertext.slice(),
          }),
          "content_block_decrypted",
        );
        throwIfAborted(signal);
        if (decrypted.plaintext.byteLength !== plaintextLength) {
          throw new FilesTransferEngineFault("corrupt_state");
        }
        hash.update(decrypted.plaintext);
        if (output) output.set(decrypted.plaintext, outputOffset);
        outputOffset += decrypted.plaintext.byteLength;
        const final =
          index === geometry.plaintextBlockLengths.length - 1;
        if (final) {
          const digest = hash.digest();
          try {
            if (
              outputOffset !== metadata.plaintextBytes ||
              !equalBytes(digest, metadata.plaintextSha256)
            ) {
              output?.fill(0);
              throw new FilesTransferEngineFault(
                "corrupt_state",
                "Files plaintext length or SHA-256 does not match metadata",
              );
            }
          } finally {
            digest.fill(0);
          }
        }
        try {
          if (consume) {
            await consume({
              plaintext: decrypted.plaintext,
              index,
              blockCount:
                geometry.plaintextBlockLengths.length,
              metadata,
            });
            throwIfAborted(signal);
          }
          emitProgress(controls, {
            phase: collect ? "downloading" : "decrypting",
            plaintextBytes: metadata.plaintextBytes,
            processedBytes: outputOffset,
            blockIndex: index,
            blockCount: geometry.plaintextBlockLengths.length,
          });
        } finally {
          decrypted.plaintext.fill(0);
        }
      }
      if (metadata.contentKind === "text_v1" && output) {
        assertStrictUtf8Text(output);
      }
      return {
        metadata,
        bytes: output,
        node: first.control.node,
        content: first.control.content,
      };
    } catch (error) {
      output?.fill(0);
      throw error;
    } finally {
      await this.#crypto.call({
        type: "release_content_cipher",
        handle: opened.handle,
      }).catch(() => undefined);
      hash.destroy();
    }
  }

  async #decryptFileMetadata(
    node: import("./types.ts").FilesFrameNodeSummary,
    ciphertext: Uint8Array,
  ): Promise<FilesFileMetadata> {
    const binding: FilesMetadataBinding = {
      nodeId: node.nodeId,
      parentId: node.parentId,
      nodeKind: node.kind,
      metadataRevision: node.metadataRevision,
      declaredNameScalars: node.declaredNameScalars,
      nameTag: node.nameTag,
    };
    const result = expectWorker(
      await this.#crypto.call({
        type: "decrypt_metadata",
        binding,
        ciphertext: ciphertext.slice(),
      }),
      "metadata_decrypted",
    );
    try {
      const metadata = decodeFilesMetadata(result.plaintext);
      assertFilesMetadataBinding(metadata, {
        nodeKind: node.kind,
        declaredNameScalars: node.declaredNameScalars,
        root: false,
      });
      if (metadata.nodeKind !== "file") {
        throw new FilesTransferEngineFault("corrupt_state");
      }
      const nameTag = expectWorker(
        await this.#crypto.call({
          type: "name_tag",
          parentNodeId: node.parentId,
          filename: metadata.name,
        }),
        "name_tag",
      );
      if (!equalBytes(nameTag.nameTag, node.nameTag)) {
        throw new FilesTransferEngineFault("corrupt_state");
      }
      return metadata;
    } finally {
      result.plaintext.fill(0);
    }
  }

  #requireReady(): void {
    if (this.#vault.status().state !== "ready") {
      throw new FilesTransferEngineFault("needs_user_unlock");
    }
  }

  #operationSignal(parent?: AbortSignal): {
    signal: AbortSignal;
    dispose(): void;
  } {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (parent?.aborted) controller.abort();
    else parent?.addEventListener("abort", abort, { once: true });
    this.#activeControllers.add(controller);
    return {
      signal: controller.signal,
      dispose: () => {
        parent?.removeEventListener("abort", abort);
        this.#activeControllers.delete(controller);
      },
    };
  }
}

function validatePrivateWritePlan(plan: FilesPrivateWritePlan): void {
  if (!plan || !Array.isArray(plan.items) || plan.items.length < 1) {
    throw new FilesTransferEngineFault("invalid", "Files write plan is empty");
  }
  const files = plan.items.filter(
    (item): item is typeof item & { metadata: FilesFileMetadata } =>
      item.metadata.nodeKind === "file",
  );
  if (
    (plan.intent === "batch" &&
      (plan.items.length > 64 ||
        files.length < 1 ||
        files.length > 20 ||
        totalPlaintext(plan) > 10_485_760 ||
        plan.items.some(
          (item) =>
            item.metadata.nodeKind === "file"
              ? (files.length > 1 &&
                  item.metadata.contentKind !== "text_v1") ||
                item.transition.requestedKind !== "file"
              : item.source.size !== 0 ||
                item.transition.requestedKind !== "folder",
        ))) ||
    (plan.intent !== "batch" &&
      (plan.items.length > 64 ||
        files.length !== 1 ||
        totalPlaintext(plan) > FILES_V2_LIMITS.binaryFileBytes ||
        plan.items.some(
          (item) =>
            item.metadata.nodeKind === "file"
              ? item.transition.requestedKind !== "file"
              : item.source.size !== 0 ||
                item.transition.requestedKind !== "folder",
        ))) ||
    plan.items.some(
      (item) =>
        !Number.isSafeInteger(item.source.size) ||
        item.source.size < 0 ||
        item.source.size > FILES_V2_LIMITS.binaryFileBytes,
    ) ||
    plan.folderTransitions.length +
        plan.childIndexTransitions.length +
        plan.items.length +
        plan.retiredContents.length >
      64
  ) {
    throw new FilesTransferEngineFault(
      "invalid",
      "Files write plan exceeds its structural or size bound",
    );
  }
  const targets = new Set(
    plan.items.map((item) => filesId128ToKey(item.transition.nodeId)),
  );
  if (targets.size !== plan.items.length) {
    throw new FilesTransferEngineFault(
      "invalid",
      "Files batch contains duplicate targets",
    );
  }
}

function metadataBinding(
  transition: import("./types.ts").FilesNodeTransition,
): FilesMetadataBinding {
  return {
    nodeId: transition.nodeId,
    parentId: transition.proposedParentId,
    nodeKind: transition.requestedKind,
    metadataRevision: transition.proposedMetadataRevision,
    declaredNameScalars: transition.declaredNameScalars,
    nameTag: transition.proposedNameTag,
  };
}

async function hashSource(
  source: FilesTransferSource,
  strictText: boolean,
  signal: AbortSignal,
  progress: (processed: number) => void,
): Promise<Uint8Array> {
  const hasher = nobleSha256.create();
  const decoder = strictText
    ? new TextDecoder("utf-8", { fatal: true })
    : null;
  let offset = 0;
  try {
    while (offset < source.size) {
      throwIfAborted(signal);
      const end = Math.min(
        source.size,
        offset + FILES_V2_LIMITS.normalPlaintextBlockBytes,
      );
      const chunk = await readSourceSlice(source, offset, end);
      try {
        if (chunk.byteLength !== end - offset) {
          throw new FilesTransferEngineFault(
            "invalid",
            "Files source changed while hashing",
          );
        }
        hasher.update(chunk);
        if (decoder) {
          try {
            decoder.decode(chunk, { stream: end !== source.size });
          } catch {
            throw new FilesTransferEngineFault(
              "invalid",
              "Files text source is not strict UTF-8",
            );
          }
        }
      } finally {
        chunk.fill(0);
      }
      offset = end;
      progress(offset);
    }
    if (source.size === 0 && decoder) decoder.decode();
    return hasher.digest();
  } finally {
    hasher.destroy();
  }
}

async function readSourceSlice(
  source: FilesTransferSource,
  start: number,
  end: number,
): Promise<Uint8Array> {
  const value = await source.slice(start, end);
  if (value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value.slice();
  throw new FilesTransferEngineFault(
    "invalid",
    "Files source returned an invalid slice",
  );
}

function reconcilePrivateState(
  state: FilesOperationStateV2,
  layout: FilesPrivateWriteLayout,
  frame: FilesWriteFrameLayout,
  requestId: FilesId128V2,
  expectedStageId: CanonicalNat64 | null,
):
  | { kind: "committed"; nodes: FilesCommittedNodeV2[] }
  | { kind: "accepted"; stageId: CanonicalNat64 | null }
  | { kind: "active"; stageId: CanonicalNat64 | null }
  | { kind: "terminal" } {
  if ("committed" in state) {
    const detail = state.committed.detail;
    if (detail === null || !("private_write" in detail)) {
      throw new FilesTransferEngineFault(
        "incompatible",
        "Files private-write reconciliation omitted its exact receipt",
      );
    }
    validateWriteAck(
      detail.private_write,
      requestId,
      frame.frameOrdinal,
      layout,
      expectedStageId,
    );
    return {
      kind: "committed",
      nodes: detail.private_write.committed_nodes,
    };
  }
  if ("active" in state) {
    validateFrameMapping(state.active.frame_block_mapping, layout);
    const stageId = state.active.stage_id;
    const validMask = (1 << layout.frames.length) - 1;
    const priorMask = (1 << frame.frameOrdinal) - 1;
    if (
      stageId === null ||
      (expectedStageId !== null && stageId !== expectedStageId) ||
      (state.active.accepted_frames_bitmap & ~validMask) !== 0 ||
      (state.active.accepted_frames_bitmap & priorMask) !== priorMask
    ) {
      throw new FilesTransferEngineFault(
        "corrupt_state",
        "Files private-write stage changed its exact progress binding",
      );
    }
    const accepted =
      (state.active.accepted_frames_bitmap &
        (1 << frame.frameOrdinal)) !==
      0;
    return accepted
      ? { kind: "accepted", stageId }
      : { kind: "active", stageId };
  }
  return { kind: "terminal" };
}

function validateFrameMapping(
  actual: readonly {
    frame_ordinal: number;
    content_id: FilesId128V2;
    block_index: number;
  }[],
  layout: FilesPrivateWriteLayout,
): void {
  const expected = layout.frames.flatMap((frame) =>
    frame.blocks.map((block) => ({
      frameOrdinal: frame.frameOrdinal,
      contentId: block.contentId,
      blockIndex: block.blockIndex,
    }))
  );
  if (
    actual.length !== expected.length ||
    actual.some((entry, index) => {
      const wanted = expected[index]!;
      return (
        entry.frame_ordinal !== wanted.frameOrdinal ||
        !sameFilesId(entry.content_id, wanted.contentId) ||
        entry.block_index !== wanted.blockIndex
      );
    })
  ) {
    throw new FilesTransferEngineFault(
      "corrupt_state",
      "Files write stage mapping changed",
    );
  }
}

function validateWriteAck(
  ok: {
    request_id: FilesId128V2;
    stage_id: CanonicalNat64 | null;
    frame_ordinal: number;
    accepted_frames_bitmap: number;
    committed_nodes: readonly FilesCommittedNodeV2[];
  },
  requestId: FilesId128V2,
  frameOrdinal: number,
  layout: FilesPrivateWriteLayout,
  expectedStageId: CanonicalNat64 | null,
): void {
  const final = frameOrdinal === layout.frames.length - 1;
  const expectedBitmap = (1 << (frameOrdinal + 1)) - 1;
  const stageMatches =
    ok.stage_id !== null &&
    (expectedStageId === null || ok.stage_id === expectedStageId);
  if (
    !sameFilesId(ok.request_id, requestId) ||
    !stageMatches ||
    ok.frame_ordinal !== frameOrdinal ||
    ok.accepted_frames_bitmap !== expectedBitmap ||
    (final
      ? ok.committed_nodes.length !== layout.nodes.length
      : ok.committed_nodes.length !== 0)
  ) {
    throw new FilesTransferEngineFault(
      "corrupt_state",
      "Files write acknowledgement changed identity",
    );
  }
}

function validateMutationReceipt(
  ok: {
    request_id: FilesId128V2;
    node_id: FilesId128V2;
    parent_id: FilesId128V2;
    structural_revision: CanonicalNat64;
    metadata_revision: CanonicalNat64;
  },
  input: FilesMutateFrameInput,
): void {
  if (
    !sameFilesId(ok.request_id, input.requestId) ||
    !sameFilesId(ok.node_id, input.node.nodeId) ||
    !sameFilesId(ok.parent_id, input.node.proposedParentId) ||
    ok.structural_revision !== input.node.proposedStructuralRevision ||
    ok.metadata_revision !== input.node.proposedMetadataRevision
  ) {
    throw new FilesTransferEngineFault(
      "corrupt_state",
      "Files mutation receipt changed its exact binding",
    );
  }
}

function validateRemoveReceipt(
  ok: {
    request_id: FilesId128V2;
    node_id: FilesId128V2;
    cleanup_state: FilesCleanupStateV2 | null;
  },
  request: FilesRemoveRequestV2,
): void {
  if (
    !sameFilesId(ok.request_id, request.request_id) ||
    !sameFilesId(ok.node_id, request.node_id)
  ) {
    throw new FilesTransferEngineFault(
      "corrupt_state",
      "Files remove receipt changed its exact binding",
    );
  }
  cleanupIsPending(ok.cleanup_state);
}

function validateAbortReceipt(
  ok: {
    request_id: FilesId128V2;
    stage_id: CanonicalNat64;
    cleanup_state: FilesCleanupStateV2 | null;
  },
  requestId: FilesId128V2,
  stageId: CanonicalNat64,
): void {
  if (
    !sameFilesId(ok.request_id, requestId) ||
    ok.stage_id !== stageId
  ) {
    throw new FilesTransferEngineFault(
      "corrupt_state",
      "Files abort receipt changed its exact binding",
    );
  }
  cleanupIsPending(ok.cleanup_state);
}

function validateOperationStatusEcho(
  ok: FilesOperationStatusOkV2,
  requestId: FilesId128V2,
  target: FilesOperationTargetV2,
): void {
  if (
    !sameFilesId(ok.request_id, requestId) ||
    ok.target === null ||
    !sameOperationTarget(ok.target, target)
  ) {
    throw new FilesTransferEngineFault(
      "corrupt_state",
      "Files operation status changed its request target",
    );
  }
}

function sameOperationTarget(
  left: FilesOperationTargetV2,
  right: FilesOperationTargetV2,
): boolean {
  if ("vault" in left && "vault" in right) {
    return left.vault.expected_record_revision ===
      right.vault.expected_record_revision;
  }
  if ("private_write" in left && "private_write" in right) {
    return (
      left.private_write.nodes.length === right.private_write.nodes.length &&
      left.private_write.nodes.every((node, index) => {
        const expected = right.private_write.nodes[index]!;
        return (
          sameFilesId(node.node_id, expected.node_id) &&
          sameOptionalId(node.content_id, expected.content_id)
        );
      })
    );
  }
  if ("mutation" in left && "mutation" in right) {
    return sameFilesId(left.mutation.node_id, right.mutation.node_id);
  }
  if ("remove" in left && "remove" in right) {
    return sameFilesId(left.remove.node_id, right.remove.node_id);
  }
  if ("abort" in left && "abort" in right) {
    return left.abort.stage_id === right.abort.stage_id;
  }
  return false;
}

function sameOptionalId(
  left: FilesId128V2 | null,
  right: FilesId128V2 | null,
): boolean {
  return left === null || right === null
    ? left === right
    : sameFilesId(left, right);
}

function terminalOrUncertain(
  label: string,
  state: FilesOperationStateV2,
  cause: unknown,
): FilesTransferEngineFault {
  if (
    "aborted" in state ||
    "expired" in state ||
    "superseded" in state
  ) {
    return new FilesTransferEngineFault(
      "conflict",
      `${label} is terminal without the requested commit`,
      { cause },
    );
  }
  return new FilesTransferEngineFault(
    "uncertain",
    `${label} outcome remains uncertain`,
    { cause },
  );
}

function validateCommittedNodes(
  committed: readonly FilesCommittedNodeV2[],
  plan: FilesPrivateWritePlan,
  layout: FilesPrivateWriteLayout,
): void {
  if (committed.length !== plan.items.length) {
    throw new FilesTransferEngineFault(
      "corrupt_state",
      "Files write receipt omitted committed nodes",
    );
  }
  const expected = plan.items.map((item, index) => ({
    item,
    prepared: layout.nodes[index]!,
  })).sort((left, right) =>
    compareIds(
      left.item.transition.nodeId,
      right.item.transition.nodeId,
    )
  );
  for (let index = 0; index < committed.length; index += 1) {
    const receipt = committed[index]!;
    const { item, prepared } = expected[index]!;
    const contentMatches =
      prepared.content === null
        ? receipt.content_id === null
        : receipt.content_id !== null &&
          sameFilesId(
            receipt.content_id,
            prepared.content.contentId,
          );
    if (
      !sameFilesId(receipt.node_id, item.transition.nodeId) ||
      !contentMatches ||
      receipt.structural_revision !==
        item.transition.proposedStructuralRevision ||
      receipt.metadata_revision !==
        item.transition.proposedMetadataRevision
    ) {
      throw new FilesTransferEngineFault(
        "corrupt_state",
        "Files write receipt does not match its plan",
      );
    }
  }
}

function cleanupIsPending(value: FilesCleanupStateV2 | null): boolean {
  if (value === null) {
    throw new FilesTransferEngineFault(
      "incompatible",
      "Files cleanup state used an unknown variant",
    );
  }
  if ("pending" in value) return true;
  if ("clean" in value) return false;
  throw new FilesTransferEngineFault(
    "incompatible",
    "Files cleanup state used an unknown variant",
  );
}

function totalPlaintext(plan: FilesPrivateWritePlan): number {
  return plan.items.reduce(
    (sum, item) =>
      sum +
      (item.metadata.nodeKind === "file" ? item.source.size : 0),
    0,
  );
}

function totalBlocks(layout: FilesPrivateWriteLayout): number {
  return layout.frames.reduce((sum, frame) => sum + frame.blocks.length, 0);
}

function plaintextThroughFrame(
  layout: FilesPrivateWriteLayout,
  through: FilesWriteFrameLayout,
): number {
  let total = 0;
  for (const frame of layout.frames) {
    for (const block of frame.blocks) {
      const node = layout.nodes.find((candidate) =>
        candidate.content !== null &&
        sameFilesId(candidate.content.contentId, block.contentId)
      )!;
      if (node.content === null) {
        throw new FilesTransferEngineFault("corrupt_state");
      }
      total += node.content.plaintextBlockLengths[block.blockIndex]!;
    }
    if (frame.frameOrdinal === through.frameOrdinal) break;
  }
  return total;
}

function lastBlockOrdinal(
  layout: FilesPrivateWriteLayout,
  through: FilesWriteFrameLayout,
): number {
  let ordinal = -1;
  for (const frame of layout.frames) {
    ordinal += frame.blocks.length;
    if (frame.frameOrdinal === through.frameOrdinal) break;
  }
  return ordinal;
}

function requireStageId(
  value: CanonicalNat64 | null,
): CanonicalNat64 {
  if (value === null) {
    throw new FilesTransferEngineFault(
      "corrupt_state",
      "Files write stage id is missing",
    );
  }
  return value;
}

function expectWorker<
  Type extends FilesCryptoWorkerResult["type"],
>(
  result: FilesCryptoWorkerResult,
  type: Type,
): Extract<FilesCryptoWorkerResult, { type: Type }> {
  if (result.type !== type) {
    throw new FilesTransferEngineFault(
      "corrupt_state",
      `Files worker returned ${result.type} instead of ${type}`,
    );
  }
  return result as Extract<FilesCryptoWorkerResult, { type: Type }>;
}

function expectOutcome<
  Value extends import("neutron-tools/app").JsonValue,
>(
  outcome:
    | { kind: "ok"; value: Value }
    | {
        kind: "rejected";
        rejection: import("../protocol/types.ts").FilesRejectedV2;
      }
    | { kind: "unsupported" },
  label: string,
): Value {
  if (outcome.kind === "ok") return outcome.value;
  if (outcome.kind === "unsupported") {
    throw new FilesTransferEngineFault(
      "incompatible",
      `${label} is unsupported`,
    );
  }
  const reason = outcome.rejection.reason?.tag;
  const code =
    reason === "quota"
      ? "quota"
      : reason === "busy"
        ? "busy"
        : reason === "not_found"
          ? "not_found"
          : reason === "incompatible" ||
              reason === "not_ready" ||
              reason === null
            ? "incompatible"
            : reason === "corrupt_state"
              ? "corrupt_state"
              : "conflict";
  throw new FilesTransferEngineFault(
    code,
    `${label} was rejected: ${reason ?? "unknown"}`,
    { rejectionReason: reason ?? null },
  );
}

function expectReadOutcome(
  outcome: Awaited<ReturnType<FilesBackendPort["readChunk"]>>,
  label: string,
): Extract<typeof outcome, { kind: "ok" }>["value"] {
  if (outcome.kind === "ok") return outcome.value;
  if (outcome.kind === "unsupported") {
    throw new FilesTransferEngineFault("incompatible");
  }
  throw new FilesTransferEngineFault(
    outcome.reason === "not_found" ? "not_found" : "conflict",
    `${label} was rejected: ${outcome.reason ?? "unknown"}`,
  );
}

function isKnownTransferFault(
  value: unknown,
): value is FilesTransferEngineFault {
  return value instanceof FilesTransferEngineFault;
}

function emitProgress(
  controls: FilesTransferControls,
  progress: FilesTransferProgress,
): void {
  try {
    controls.onProgress?.(Object.freeze(progress));
  } catch {
    // Progress observers never alter the transfer.
  }
}

function emitTerminalFailure(
  controls: FilesTransferControls,
  error: unknown,
  totalBytes: number,
): void {
  emitProgress(controls, {
    phase:
      error instanceof FilesTransferEngineFault &&
        error.code === "cancelled"
        ? "cancelled"
        : error instanceof FilesTransferEngineFault &&
            error.code === "conflict"
          ? "conflicted"
          : "failed",
    plaintextBytes: totalBytes,
    processedBytes: 0,
    blockIndex: 0,
    blockCount: 1,
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new FilesTransferEngineFault("cancelled");
  }
}

async function waitWithSignal(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new FilesTransferEngineFault("cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function compareIds(left: FilesId128V2, right: FilesId128V2): number {
  const leftHi = BigInt(left.hi);
  const rightHi = BigInt(right.hi);
  if (leftHi < rightHi) return -1;
  if (leftHi > rightHi) return 1;
  const leftLo = BigInt(left.lo);
  const rightLo = BigInt(right.lo);
  return leftLo < rightLo ? -1 : leftLo > rightLo ? 1 : 0;
}
