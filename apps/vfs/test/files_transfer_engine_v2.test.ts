import { describe, expect, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  FilesCryptoWorkerRequestWithoutId,
  FilesCryptoWorkerResult,
} from "../src/crypto/worker_protocol.ts";
import { planPrivateBlocks } from "../src/crypto/private_files.ts";
import { FILES_V2_LIMITS } from "../src/protocol/constants.ts";
import type {
  CanonicalNat64,
  FilesId128V2,
  FilesOperationStatusRequestV2,
  FilesReadChunkRequestV2,
  FilesWriteBlockRequestV2,
} from "../src/protocol/types.ts";
import {
  planFilesPrivateWrite,
  type FilesPreparedWriteNode,
} from "../src/vault/frame_codec.ts";
import { encodeFilesMetadata } from "../src/vault/metadata.ts";
import {
  FilesTransferEngine,
} from "../src/vault/transfer_engine.ts";
import type {
  FilesBackendPort,
  FilesCryptoPort,
  FilesPrivateWritePlan,
  FilesReadRequest,
  FilesTransferSource,
  FilesWriteItem,
} from "../src/vault/types.ts";
import type { FilesVaultEngine } from "../src/vault/vault_engine.ts";

const ZERO = nat(0);
const ROOT_ID = id(0);

describe("Files V2 real transfer engine", () => {
  test("one-block and maximum 36-block private writes make exactly one call per frame", async () => {
    const one = transferHarness(plan("create", [3]));
    const oneReceipt = await one.engine.writePrivatePrehashed(
      one.plan,
      one.digests,
    );
    expect(oneReceipt.nodeId).toEqual(one.plan.items[0]!.transition.nodeId);
    expect(one.backend.writeRequests.map((request) =>
      request.frame_ordinal
    )).toEqual([0]);
    expect(one.backend.operationStatusRequests).toEqual([]);

    const maximum = transferHarness(
      plan("create", [FILES_V2_LIMITS.binaryFileBytes]),
    );
    await maximum.engine.writePrivatePrehashed(
      maximum.plan,
      maximum.digests,
    );
    expect(maximum.backend.writeRequests).toHaveLength(36);
    expect(maximum.backend.writeRequests.map((request) =>
      request.frame_ordinal
    )).toEqual(new Array(36).fill(0).map((_, index) => index));
    expect(maximum.backend.writeRequests.every((request, index) =>
      request.final === (index === 35)
    )).toBe(true);
  });

  test("private writes tolerate ownership transfer of worker input buffers", async () => {
    const harness = transferHarness(plan("create", [3]), {
      detachWorkerInputs: true,
    });

    await expect(
      harness.engine.writePrivatePrehashed(
        harness.plan,
        harness.digests,
      ),
    ).resolves.toMatchObject({
      nodeId: harness.plan.items[0]!.transition.nodeId,
    });
    expect(harness.backend.writeRequests).toHaveLength(1);
  });

  test("maximum twenty-file text batch is packed into exactly seven bounded calls", async () => {
    const perFile = 512 * 1024;
    const harness = transferHarness(
      plan("batch", new Array(20).fill(perFile)),
    );
    await harness.engine.writePrivatePrehashed(
      harness.plan,
      harness.digests,
    );
    expect(harness.backend.writeRequests).toHaveLength(7);
    expect(harness.backend.writeRequests.map((request) =>
      request.frame_ordinal
    )).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(
      harness.backend.writeRequests.every((request) =>
        request.body_bytes <= 1_900_000
      ),
    ).toBe(true);
    expect(harness.backend.writeRequests.at(-1)?.final).toBe(true);
  });

  test("a lost non-final reply reconciles status before advancing and never resends the accepted frame", async () => {
    const size = FILES_V2_LIMITS.normalPlaintextBlockBytes + 1;
    const harness = transferHarness(plan("create", [size]), {
      loseReplyForFrame: 0,
    });
    await harness.engine.writePrivatePrehashed(
      harness.plan,
      harness.digests,
    );
    expect(harness.backend.events).toEqual([
      "write:0",
      "status",
      "write:1",
    ]);
    expect(harness.backend.writeRequests.map((request) =>
      request.frame_ordinal
    )).toEqual([0, 1]);
    expect(harness.backend.operationStatusRequests).toHaveLength(1);
  });

  test("a validated final private-write success wins a concurrent cancellation", async () => {
    const harness = transferHarness(plan("create", [3]));
    const entered = deferred();
    const release = deferred();
    const writeBlock = harness.backend.writeBlock.bind(harness.backend);
    harness.backend.writeBlock = async (request) => {
      const outcome = await writeBlock(request);
      entered.resolve();
      await release.promise;
      return outcome;
    };
    const controller = new AbortController();
    const writing = harness.engine.writePrivatePrehashed(
      harness.plan,
      harness.digests,
      { signal: controller.signal },
    );
    await entered.promise;
    expect(harness.backend.liveWrite).toBe(true);
    controller.abort();
    release.resolve();

    const receipt = await writing;
    expect(receipt.nodeId).toEqual(
      harness.plan.items[0]!.transition.nodeId,
    );
    expect(receipt.committedNodes).toEqual(
      harness.backend.committedNodes(),
    );
    expect(harness.backend.aborts).toEqual([]);
    expect(harness.backend.activeWrite).toBe(false);
    expect(harness.backend.liveWrite).toBe(true);
  });

  test("a lost final private-write reply reconciles its exact committed receipt before observing cancellation", async () => {
    const size = FILES_V2_LIMITS.normalPlaintextBlockBytes + 1;
    const harness = transferHarness(plan("create", [size]), {
      loseReplyForFrame: 1,
    });
    const statusEntered = deferred();
    const releaseStatus = deferred();
    const backend = harness.backend as FilesBackendPort;
    backend.operationStatus = async (request) => {
      harness.backend.operationStatusRequests.push(request);
      harness.backend.events.push("status");
      statusEntered.resolve();
      await releaseStatus.promise;
      const finalRequest = harness.backend.writeRequests.at(-1)!;
      return {
        kind: "ok" as const,
        value: {
          request_id: request.request_id,
          target: request.target,
          state: {
            committed: {
              detail: {
                private_write: {
                  request_id: finalRequest.request_id,
                  stage_id: nat(400),
                  frame_ordinal: finalRequest.frame_ordinal,
                  accepted_frames_bitmap:
                    (1 << (finalRequest.frame_ordinal + 1)) - 1,
                  committed_nodes: harness.backend.committedNodes(),
                  cleanup_state: { clean: null } as const,
                },
              },
            },
          },
          cleanup_state: { clean: null } as const,
        },
      };
    };
    const controller = new AbortController();
    const writing = harness.engine.writePrivatePrehashed(
      harness.plan,
      harness.digests,
      { signal: controller.signal },
    );
    await statusEntered.promise;
    expect(harness.backend.liveWrite).toBe(true);
    controller.abort();
    releaseStatus.resolve();

    const receipt = await writing;
    expect(receipt.committedNodes).toEqual(
      harness.backend.committedNodes(),
    );
    expect(harness.backend.events).toEqual([
      "write:0",
      "write:1",
      "status",
    ]);
    expect(harness.backend.aborts).toEqual([]);
    expect(harness.backend.activeWrite).toBe(false);
    expect(harness.backend.liveWrite).toBe(true);
  });

  test("cancelling an accepted non-final private frame retains and aborts its exact stage without a live write", async () => {
    const size = FILES_V2_LIMITS.normalPlaintextBlockBytes + 1;
    const harness = transferHarness(plan("create", [size]));
    const entered = deferred();
    const release = deferred();
    const writeBlock = harness.backend.writeBlock.bind(harness.backend);
    harness.backend.writeBlock = async (request) => {
      const outcome = await writeBlock(request);
      if (!request.final) {
        entered.resolve();
        await release.promise;
      }
      return outcome;
    };
    const controller = new AbortController();
    const writing = harness.engine.writePrivatePrehashed(
      harness.plan,
      harness.digests,
      { signal: controller.signal },
    );
    await entered.promise;
    expect(harness.backend.activeWrite).toBe(true);
    expect(harness.backend.liveWrite).toBe(false);
    controller.abort();
    release.resolve();

    await expect(writing).rejects.toMatchObject({ code: "cancelled" });
    expect(harness.backend.writeRequests.map((request) =>
      request.frame_ordinal
    )).toEqual([0]);
    expect(harness.backend.aborts).toEqual([{
      request_id: harness.backend.writeRequests[0]!.request_id,
      stage_id: nat(400),
    }]);
    expect(harness.backend.activeWrite).toBe(false);
    expect(harness.backend.liveWrite).toBe(false);
  });

  test("lost-reply reconciliation rejects a status response that changes the exact target", async () => {
    const size = FILES_V2_LIMITS.normalPlaintextBlockBytes + 1;
    const harness = transferHarness(plan("create", [size]), {
      loseReplyForFrame: 0,
      wrongStatusTarget: true,
    });
    await expect(harness.engine.writePrivatePrehashed(
      harness.plan,
      harness.digests,
    )).rejects.toMatchObject({
      code: "corrupt_state",
      message: "Files operation status changed its request target",
    });
    expect(harness.backend.events).toEqual(["write:0", "status"]);
    expect(harness.backend.writeRequests).toHaveLength(1);
  });

  test("source change before the final frame aborts the exact active private stage", async () => {
    const size = FILES_V2_LIMITS.binaryFileBytes;
    const base = plan("create", [size]);
    const changing = changingSource(size);
    const original = requireFileItem(base.plan.items[0]!);
    const changedPlan: FilesPrivateWritePlan = {
      ...base.plan,
      items: [{
        ...original,
        source: changing,
      }],
    };
    const harness = transferHarness(
      { plan: changedPlan, digests: base.digests },
    );
    await expect(harness.engine.writePrivate(changedPlan)).rejects
      .toMatchObject({
        code: "invalid",
        message: "Files source changed between hashing and encryption",
      });
    expect(harness.backend.writeRequests.map((request) =>
      request.frame_ordinal
    )).toEqual(new Array(35).fill(0).map((_, index) => index));
    expect(harness.backend.aborts).toEqual([{
      request_id: harness.backend.writeRequests[0]!.request_id,
      stage_id: nat(400),
    }]);
  });

  test("one-block and maximum 36-block reads make exactly one call per ciphertext block", async () => {
    const one = readHarness(3);
    const oneResult = await one.engine.readPrivate(one.request);
    expect(one.backend.readRequests).toHaveLength(1);
    expect(one.backend.readRequests[0]?.index).toBe(0);
    expect([...oneResult.bytes]).toEqual([0, 0, 0]);

    const maximum = readHarness(FILES_V2_LIMITS.binaryFileBytes);
    const maximumResult = await maximum.engine.readPrivate(maximum.request);
    expect(maximum.backend.readRequests).toHaveLength(36);
    expect(maximum.backend.readRequests.map((request) => request.index))
      .toEqual(new Array(36).fill(0).map((_, index) => index));
    expect(maximumResult.bytes.byteLength).toBe(
      FILES_V2_LIMITS.binaryFileBytes,
    );
    expect(maximumResult.metadata.plaintextSha256).toEqual(
      zeroDigest(FILES_V2_LIMITS.binaryFileBytes),
    );
  });
});

type PlanFixture = Readonly<{
  plan: FilesPrivateWritePlan;
  digests: readonly Uint8Array[];
}>;

type TransferHarnessOptions = Readonly<{
  loseReplyForFrame?: number;
  wrongStatusTarget?: boolean;
  detachWorkerInputs?: boolean;
}>;

function transferHarness(
  fixture: PlanFixture,
  options: TransferHarnessOptions = {},
) {
  const crypto = new TransferCrypto(options.detachWorkerInputs === true);
  const backend = new TransferBackend(fixture.plan, crypto, options);
  const engine = new FilesTransferEngine({
    backend,
    crypto,
    vault: readyVault(),
    randomBytes: deterministicRandom(),
    wait: async () => undefined,
  });
  return {
    engine,
    backend,
    crypto,
    plan: fixture.plan,
    digests: fixture.digests,
  };
}

function plan(
  intent: "create" | "batch",
  sizes: readonly number[],
): PlanFixture {
  const digests = sizes.map(zeroDigest);
  const items = sizes.map((size, index) => {
    const name = `file-${index}.txt`;
    return Object.freeze({
      transition: Object.freeze({
        nodeId: id(index + 1),
        expectedParentId: null,
        proposedParentId: ROOT_ID,
        requestedKind: "file" as const,
        expectedNameTag: null,
        proposedNameTag: nameTag(name),
        declaredNameScalars: name.length,
        expectedStructuralRevision: null,
        proposedStructuralRevision: nat(1),
        expectedMetadataRevision: null,
        proposedMetadataRevision: nat(1),
        expectedChildrenRevision: null,
        proposedChildrenRevision: ZERO,
        expectedSubtreeHeight: null,
        proposedSubtreeHeight: 0,
        expectedMaxRelativePathScalars: null,
        proposedMaxRelativePathScalars: 0,
        expectedSubtreePlaintextBytes: null,
        proposedSubtreePlaintextBytes: nat(size),
      }),
      metadata: Object.freeze({
        nodeKind: "file" as const,
        name,
        contentKind:
          intent === "batch" ? "text_v1" as const : "binary_v1" as const,
        mimeType:
          intent === "batch"
            ? "text/plain"
            : "application/octet-stream",
        plaintextBytes: size,
        plaintextSha256: digests[index]!.slice(),
        createdAtNs: nat(1),
        modifiedAtNs: nat(1),
      }),
      source: zeroSource(size),
    });
  });
  const plaintext = sizes.reduce((total, size) => total + size, 0);
  const ciphertext = sizes.reduce(
    (total, size) => total + planPrivateBlocks(size).ciphertextBytes,
    0,
  );
  return Object.freeze({
    plan: Object.freeze({
      intent,
      items: Object.freeze(items),
      folderTransitions: Object.freeze([]),
      childIndexTransitions: Object.freeze([]),
      retiredContents: Object.freeze([]),
      quota: Object.freeze({
        expectedNodeCount: ZERO,
        proposedNodeCount: nat(sizes.length),
        expectedCommittedPlaintextBytes: ZERO,
        proposedCommittedPlaintextBytes: nat(plaintext),
        expectedCommittedCiphertextBytes: ZERO,
        proposedCommittedCiphertextBytes: nat(ciphertext),
        grossPeakPhysicalBytes: nat(ciphertext + 1_000_000),
      }),
    }),
    digests: Object.freeze(digests),
  });
}

class TransferCrypto implements FilesCryptoPort {
  readonly contents: {
    nodeId: FilesId128V2;
    contentId: FilesId128V2;
  }[] = [];
  readonly encryptedMetadata: Uint8Array[] = [];
  readonly retryFrames = new Map<
    string,
    { frame: Uint8Array; fingerprint: Uint8Array }
  >();

  constructor(readonly detachWorkerInputs = false) {}

  async call(
    request: FilesCryptoWorkerRequestWithoutId,
  ): Promise<FilesCryptoWorkerResult> {
    switch (request.type) {
      case "name_tag":
        return { type: "name_tag", nameTag: nameTag(request.filename) };
      case "encrypt_metadata": {
        const ciphertext = request.plaintext.slice();
        this.encryptedMetadata.push(ciphertext.slice());
        this.#detach(request.plaintext);
        return { type: "metadata_encrypted", ciphertext };
      }
      case "decrypt_metadata":
        return {
          type: "metadata_decrypted",
          plaintext: request.ciphertext.slice(),
        };
      case "create_content_cipher":
        this.contents.push({
          nodeId: protocolId(request.binding.nodeId),
          contentId: protocolId(request.binding.contentId),
        });
        return {
          type: "content_cipher_ready",
          handle: key(request.binding.contentId),
          wrappedKey: bytes(48, 0x41),
        };
      case "open_content_cipher":
        return {
          type: "content_cipher_ready",
          handle: key(request.binding.contentId),
          wrappedKey: null,
        };
      case "release_content_cipher":
        return { type: "content_cipher_released" };
      case "encrypt_content_block": {
        const ciphertext = new Uint8Array(
          request.plaintext.byteLength + 16,
        );
        ciphertext.set(request.plaintext);
        ciphertext.fill(0xa5, request.plaintext.byteLength);
        this.#detach(request.plaintext);
        return { type: "content_block_encrypted", ciphertext };
      }
      case "decrypt_content_block":
        return {
          type: "content_block_decrypted",
          plaintext: request.ciphertext.slice(0, -16),
        };
      case "retain_retry_frame": {
        const fingerprint = sha256(request.frame);
        this.retryFrames.set(
          `${request.operationId}:${request.frameOrdinal}`,
          { frame: request.frame.slice(), fingerprint },
        );
        this.#detach(request.frame);
        return {
          type: "retry_frame_retained",
          fingerprint: fingerprint.slice(),
        };
      }
      case "export_retry_frame": {
        const retained = this.retryFrames.get(
          `${request.operationId}:${request.frameOrdinal}`,
        );
        if (!retained) throw new Error("retry frame is absent");
        return {
          type: "retry_frame_exported",
          frame: retained.frame.slice(),
          fingerprint: retained.fingerprint.slice(),
        };
      }
      case "release_retry_frame":
        this.retryFrames.delete(
          `${request.operationId}:${request.frameOrdinal}`,
        );
        return { type: "retry_frame_released" };
      default:
        throw new Error(`Unexpected transfer crypto call: ${request.type}`);
    }
  }

  #detach(value: Uint8Array): void {
    if (!this.detachWorkerInputs) return;
    structuredClone(value, { transfer: [value.buffer] });
  }
}

class TransferBackend implements FilesBackendPort {
  readonly writeRequests: FilesWriteBlockRequestV2[] = [];
  readonly operationStatusRequests: FilesOperationStatusRequestV2[] = [];
  readonly events: string[] = [];
  readonly aborts: Parameters<FilesBackendPort["abort"]>[0][] = [];
  activeWrite = false;
  liveWrite = false;
  #lost = false;

  constructor(
    readonly plan: FilesPrivateWritePlan,
    readonly crypto: TransferCrypto,
    readonly options: TransferHarnessOptions,
  ) {}

  async writeBlock(request: FilesWriteBlockRequestV2) {
    this.writeRequests.push(request);
    this.events.push(`write:${request.frame_ordinal}`);
    this.activeWrite = !request.final;
    this.liveWrite = request.final;
    if (
      this.options.loseReplyForFrame === request.frame_ordinal &&
      !this.#lost
    ) {
      this.#lost = true;
      throw new Error("synthetic lost reply");
    }
    return {
      kind: "ok" as const,
      value: {
        request_id: request.request_id,
        stage_id: nat(400),
        frame_ordinal: request.frame_ordinal,
        accepted_frames_bitmap:
          (1 << (request.frame_ordinal + 1)) - 1,
        committed_nodes: request.final ? this.committedNodes() : [],
        cleanup_state: { clean: null } as const,
      },
    };
  }

  async operationStatus(request: FilesOperationStatusRequestV2) {
    this.operationStatusRequests.push(request);
    this.events.push("status");
    const lost = this.options.loseReplyForFrame ?? 0;
    const layout = this.layout();
    return {
      kind: "ok" as const,
      value: {
        request_id: request.request_id,
        target: this.options.wrongStatusTarget ? null : request.target,
        state: {
          active: {
            stage_id: nat(400),
            accepted_frames_bitmap: 1 << lost,
            frame_block_mapping: layout.frames.flatMap((frame) =>
              frame.blocks.map((block) => ({
                frame_ordinal: frame.frameOrdinal,
                content_id: block.contentId,
                block_index: block.blockIndex,
              }))
            ),
            staged_bytes: nat(
              layout.frames[lost]?.rawPayloadBytes ?? 0,
            ),
            expires_at_ns: nat(9_999_999),
          },
        },
        cleanup_state: { clean: null } as const,
      },
    };
  }

  async abort(request: Parameters<FilesBackendPort["abort"]>[0]) {
    this.aborts.push(request);
    this.activeWrite = false;
    return {
      kind: "ok" as const,
      value: {
        request_id: request.request_id,
        stage_id: request.stage_id,
        aborted: true,
        cleanup_state: { clean: null } as const,
      },
    };
  }

  committedNodes() {
    return this.plan.items.map((candidate, index) => {
      const item = requireFileItem(candidate);
      return {
        node_id: item.transition.nodeId,
        content_id: this.crypto.contents[index]!.contentId,
        structural_revision: item.transition.proposedStructuralRevision,
        metadata_revision: item.transition.proposedMetadataRevision,
      };
    });
  }

  layout() {
    const prepared: FilesPreparedWriteNode[] = this.plan.items.map(
      (candidate, index) => {
        const item = requireFileItem(candidate);
        const geometry = planPrivateBlocks(item.source.size);
        return {
          transition: item.transition,
          encryptedMetadata: this.crypto.encryptedMetadata[index]!,
          content: {
            contentId: this.crypto.contents[index]!.contentId,
            wrappedContentKey: bytes(48, 0x41),
            plaintextBlockLengths: geometry.plaintextBlockLengths,
            ciphertextBlockLengths: geometry.ciphertextBlockLengths,
          },
        };
      },
    );
    return planFilesPrivateWrite(this.plan.intent, prepared);
  }

  bootstrap = unsupportedAttachment;
  list = unsupportedAttachment;
  lookup = unsupportedAttachmentWithBody;
  readChunk = unsupportedRead;
  vaultWrite = unsupported;
  mutate = unsupported;
  remove = unsupported;
  cleanup = unsupported;
}

function readHarness(size: number) {
  const crypto = new TransferCrypto();
  const backend = new ReadBackend(size);
  const engine = new FilesTransferEngine({
    backend,
    crypto,
    vault: readyVault({
      node: backend.node,
      content: {
        contentId: backend.contentId,
        blockCount: backend.geometry.plaintextBlockLengths.length,
        ciphertextBytes: nat(backend.geometry.ciphertextBytes),
        cryptoProfile: "aes_256_gcm_files_v2",
      },
      metadata: backend.metadata,
      wrappedContentKey: bytes(48, 0x41),
    }),
  });
  return { engine, backend, request: backend.request };
}

class ReadBackend implements FilesBackendPort {
  readonly nodeId = id(501);
  readonly contentId = id(502);
  readonly request: FilesReadRequest = Object.freeze({
    nodeId: this.nodeId,
    structuralRevision: nat(7),
    contentId: this.contentId,
  });
  readonly readRequests: FilesReadChunkRequestV2[] = [];
  readonly geometry;
  readonly metadata;
  readonly encryptedMetadata;
  readonly node;

  constructor(readonly size: number) {
    this.geometry = planPrivateBlocks(size);
    this.metadata = Object.freeze({
      nodeKind: "file" as const,
      name: "read.bin",
      contentKind: "binary_v1" as const,
      mimeType: "application/octet-stream",
      plaintextBytes: size,
      plaintextSha256: zeroDigest(size),
      createdAtNs: nat(1),
      modifiedAtNs: nat(2),
    });
    this.encryptedMetadata = encodeFilesMetadata(this.metadata);
    this.node = Object.freeze({
      nodeId: this.nodeId,
      parentId: ROOT_ID,
      kind: "file" as const,
      nameTag: nameTag(this.metadata.name),
      declaredNameScalars: this.metadata.name.length,
      structuralRevision: this.request.structuralRevision,
      metadataRevision: nat(3),
      childrenRevision: ZERO,
      subtreeHeight: 0,
      maxRelativePathScalars: 0,
      subtreePlaintextBytes: nat(size),
    });
  }

  async readChunk(request: FilesReadChunkRequestV2) {
    this.readRequests.push(request);
    const plaintextLength =
      this.geometry.plaintextBlockLengths[request.index]!;
    const ciphertext = new Uint8Array(plaintextLength + 16);
    ciphertext.fill(0xa5, plaintextLength);
    const body =
      request.index === 0
        ? readFirstFrame({
            node: this.node,
            contentId: this.contentId,
            blockCount: this.geometry.plaintextBlockLengths.length,
            ciphertextBytes: this.geometry.ciphertextBytes,
            encryptedMetadata: this.encryptedMetadata,
            wrappedKey: bytes(48, 0x41),
            ciphertext,
          })
        : readContinuationFrame({
            node: this.node,
            contentId: this.contentId,
            blockCount: this.geometry.plaintextBlockLengths.length,
            ciphertextBytes: this.geometry.ciphertextBytes,
            index: request.index,
            ciphertext,
          });
    return {
      kind: "ok" as const,
      value: {
        nodeId: this.nodeId,
        structuralRevision: this.node.structuralRevision,
        metadataRevision: this.node.metadataRevision,
        contentId: this.contentId,
        index: request.index,
        blockCount: this.geometry.plaintextBlockLengths.length,
        ciphertextBlockBytes: ciphertext.byteLength,
        ciphertextTotalBytes: nat(this.geometry.ciphertextBytes),
        frameKind: request.index === 0
          ? "first" as const
          : "continuation" as const,
      },
      body,
    };
  }

  bootstrap = unsupportedAttachment;
  list = unsupportedAttachment;
  lookup = unsupportedAttachmentWithBody;
  vaultWrite = unsupported;
  writeBlock = unsupported;
  mutate = unsupported;
  remove = unsupported;
  abort = unsupported;
  cleanup = unsupported;
  operationStatus = unsupported;
}

function readyVault(
  record?: Readonly<{
    node: ReadBackend["node"];
    content: {
      contentId: FilesId128V2;
      blockCount: number;
      ciphertextBytes: CanonicalNat64;
      cryptoProfile: "aes_256_gcm_files_v2";
    };
    metadata: ReadBackend["metadata"];
    wrappedContentKey: Uint8Array;
  }>,
): FilesVaultEngine {
  return {
    status: () => ({ state: "ready" }),
    onLock: () => () => undefined,
    lookupNode: async () => {
      if (record === undefined) {
        throw new Error("Synthetic Files vault has no lookup record");
      }
      return record;
    },
  } as unknown as FilesVaultEngine;
}

function zeroSource(size: number): FilesTransferSource {
  return Object.freeze({
    size,
    slice(start: number, end: number) {
      return new Uint8Array(end - start);
    },
  });
}

function requireFileItem(
  item: FilesWriteItem,
): Extract<FilesWriteItem, { source: FilesTransferSource }> {
  if (item.source === null || item.metadata.nodeKind !== "file") {
    throw new Error("Synthetic transfer plan expected a file item");
  }
  return item as Extract<FilesWriteItem, { source: FilesTransferSource }>;
}

function changingSource(size: number): FilesTransferSource {
  const hashCalls = Math.ceil(
    size / FILES_V2_LIMITS.normalPlaintextBlockBytes,
  );
  let calls = 0;
  return Object.freeze({
    size,
    slice(start: number, end: number) {
      calls += 1;
      const output = new Uint8Array(end - start);
      if (calls > hashCalls + 8) output.fill(1);
      return output;
    },
  });
}

function zeroDigest(size: number): Uint8Array {
  const hash = sha256.create();
  let remaining = size;
  const chunk = new Uint8Array(
    Math.min(FILES_V2_LIMITS.normalPlaintextBlockBytes, size),
  );
  while (remaining > 0) {
    const length = Math.min(chunk.byteLength, remaining);
    hash.update(chunk.subarray(0, length));
    remaining -= length;
  }
  return hash.digest();
}

function nameTag(name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`files-name:${name}`));
}

function deterministicRandom(): (length: number) => Uint8Array {
  let invocation = 1n;
  return (length) => {
    const output = new Uint8Array(length);
    const view = new DataView(output.buffer);
    if (length >= 8) view.setBigUint64(0, invocation, false);
    for (let index = 8; index < length; index += 1) {
      output[index] = (Number(invocation) + index) & 0xff;
    }
    invocation += 1n;
    return output;
  };
}

function deferred(): Readonly<{
  promise: Promise<void>;
  resolve(): void;
}> {
  let resolve = (): void => {
    throw new Error("Files test deferred was not initialized");
  };
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return Object.freeze({ promise, resolve: () => resolve() });
}

function key(value: Readonly<{ hi: string; lo: string }>): string {
  return `${value.hi}:${value.lo}`;
}

function protocolId(
  value: Readonly<{ hi: string; lo: string }>,
): FilesId128V2 {
  return Object.freeze({
    hi: value.hi as CanonicalNat64,
    lo: value.lo as CanonicalNat64,
  });
}

async function unsupported() {
  return { kind: "unsupported" as const };
}

async function unsupportedAttachment() {
  return { kind: "unsupported" as const, body: new ArrayBuffer(0) };
}

async function unsupportedAttachmentWithBody(
  _request: unknown,
) {
  return { kind: "unsupported" as const, body: new ArrayBuffer(0) };
}

async function unsupportedRead() {
  return { kind: "unsupported" as const, body: new ArrayBuffer(0) };
}

function readFirstFrame(input: {
  node: ReadBackend["node"];
  contentId: FilesId128V2;
  blockCount: number;
  ciphertextBytes: number;
  encryptedMetadata: Uint8Array;
  wrappedKey: Uint8Array;
  ciphertext: Uint8Array;
}): ArrayBuffer {
  const payload = concatenate(
    input.encryptedMetadata,
    input.wrappedKey,
    input.ciphertext,
  );
  const metadataOffset = 0;
  const wrappedOffset = input.encryptedMetadata.byteLength;
  const ciphertextOffset = wrappedOffset + input.wrappedKey.byteLength;
  return didcFrame(
    "ReadBlockFrameControlV2",
    `record { frame = opt variant { first = record {
      node = ${nodeText(input.node)};
      content = ${
        contentText(
          input.contentId,
          input.blockCount,
          input.ciphertextBytes,
        )
      };
      encrypted_metadata = ${
        sliceText(metadataOffset, input.encryptedMetadata.byteLength)
      };
      wrapped_content_key = ${
        sliceText(wrappedOffset, input.wrappedKey.byteLength)
      };
      index = 0 : nat32;
      ciphertext_block = ${
        sliceText(ciphertextOffset, input.ciphertext.byteLength)
      };
      raw_payload_bytes = ${payload.byteLength} : nat32
    } } }`,
    payload,
  );
}

function readContinuationFrame(input: {
  node: ReadBackend["node"];
  contentId: FilesId128V2;
  blockCount: number;
  ciphertextBytes: number;
  index: number;
  ciphertext: Uint8Array;
}): ArrayBuffer {
  return didcFrame(
    "ReadBlockFrameControlV2",
    `record { frame = opt variant { continuation = record {
      node_id = ${idText(input.node.nodeId)};
      structural_revision = ${input.node.structuralRevision} : nat64;
      metadata_revision = ${input.node.metadataRevision} : nat64;
      content_id = ${idText(input.contentId)};
      index = ${input.index} : nat32;
      block_count = ${input.blockCount} : nat32;
      ciphertext_block_bytes = ${input.ciphertext.byteLength} : nat32;
      ciphertext_total_bytes = ${input.ciphertextBytes} : nat64;
      ciphertext_block = ${sliceText(0, input.ciphertext.byteLength)};
      raw_payload_bytes = ${input.ciphertext.byteLength} : nat32
    } } }`,
    input.ciphertext,
  );
}

function didcFrame(
  type: string,
  control: string,
  payload: Uint8Array,
): ArrayBuffer {
  const result = spawnSync(
    "didc",
    [
      "encode",
      "--defs",
      fileURLToPath(
        new URL("../candid/files-v2-frames.did", import.meta.url),
      ),
      "--types",
      `(${type})`,
      `(${control})`,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      [result.stdout, result.stderr].filter(Boolean).join("\n"),
    );
  }
  const encoded = hexBytes(result.stdout.trim());
  const exact = new Uint8Array(4 + encoded.byteLength + payload.byteLength);
  new DataView(exact.buffer).setUint32(0, encoded.byteLength, false);
  exact.set(encoded, 4);
  exact.set(payload, 4 + encoded.byteLength);
  return exact.buffer;
}

function nodeText(node: ReadBackend["node"]): string {
  return `record {
    node_id = ${idText(node.nodeId)};
    parent_id = ${idText(node.parentId)};
    kind = opt variant { file };
    name_tag = ${digestText(node.nameTag)};
    declared_name_scalars = ${node.declaredNameScalars} : nat16;
    structural_revision = ${node.structuralRevision} : nat64;
    metadata_revision = ${node.metadataRevision} : nat64;
    children_revision = ${node.childrenRevision} : nat64;
    subtree_height = ${node.subtreeHeight} : nat8;
    max_relative_path_scalars = ${node.maxRelativePathScalars} : nat16;
    subtree_plaintext_bytes = ${node.subtreePlaintextBytes} : nat64
  }`;
}

function contentText(
  contentId: FilesId128V2,
  blockCount: number,
  ciphertextBytes: number,
): string {
  return `record {
    content_id = ${idText(contentId)};
    block_count = ${blockCount} : nat32;
    ciphertext_bytes = ${ciphertextBytes} : nat64;
    crypto_profile = opt variant { aes_256_gcm_files_v2 }
  }`;
}

function idText(value: FilesId128V2): string {
  return `record { hi = ${value.hi} : nat64; lo = ${value.lo} : nat64 }`;
}

function digestText(value: Uint8Array): string {
  const view = new DataView(
    value.buffer,
    value.byteOffset,
    value.byteLength,
  );
  return `record {
    a = ${view.getBigUint64(0, false)} : nat64;
    b = ${view.getBigUint64(8, false)} : nat64;
    c = ${view.getBigUint64(16, false)} : nat64;
    d = ${view.getBigUint64(24, false)} : nat64
  }`;
}

function sliceText(offset: number, length: number): string {
  return `record { offset = ${offset} : nat32; length = ${length} : nat32 }`;
}

function hexBytes(value: string): Uint8Array {
  const normalized = value.replace(/\s+/gu, "");
  if (normalized.length % 2 !== 0 || /[^0-9a-f]/iu.test(normalized)) {
    throw new Error("didc returned non-hex control bytes");
  }
  const output = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(
      normalized.slice(index * 2, index * 2 + 2),
      16,
    );
  }
  return output;
}

function concatenate(...values: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    values.reduce((total, value) => total + value.byteLength, 0),
  );
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.byteLength;
  }
  return output;
}

function nat(value: number | bigint): CanonicalNat64 {
  return BigInt(value).toString() as CanonicalNat64;
}

function id(value: number): FilesId128V2 {
  return Object.freeze({ hi: ZERO, lo: nat(value) });
}

function bytes(length: number, fill: number): Uint8Array {
  return new Uint8Array(length).fill(fill);
}
