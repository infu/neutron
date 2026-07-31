import { Principal } from "@dfinity/principal";
import {
  assertActionHeader,
  bytes32,
  decodeCertifiedPostRefV1,
  decodeCertifiedShareDeliveryV1,
  decodeCertifiedTombstoneV1,
  decodePostBodyV1,
  derivePostIdentity,
  equalBytes,
  lowerHex,
  type CertifiedActionRefV1,
  type CertifiedPostRefV1,
  type ExactDecodedCandidV1,
  type LikeActionV1,
  type LikeBatchV1,
  type PostBodyV1,
} from "../protocol/index.ts";
import {
  deriveGatewayUrl,
  likeBatchV1Decoder,
  likeHeadV1Decoder,
  likeHeadV1MutableGuard,
  likeV1Decoder,
  postV1Decoder,
  profileV1Decoder,
  profileV1MutableGuard,
  replyIndexV1Decoder,
  replyIndexV1MutableGuard,
  sha256,
  shareV1Decoder,
  tombstoneV1Decoder,
  verifierProofFromProtocol,
  WAGYU_VERIFIER_VERSION,
  type FetchAndVerifyRequestV1,
  type LikeHeadHighWaterV1,
  type ProfileHighWaterV1,
  type ReplyIndexHighWaterV1,
  type VerificationFailureV1,
  type VerificationResultV1,
  type WagyuVerifierV1,
} from "../verifier/index.ts";
import type { WagyuImmutableResponseCacheV1 } from "./response_cache.ts";
import {
  likeHeadHighWaterKey,
  profileHighWaterKey,
  replyIndexHighWaterKey,
  shareEdgeEvidenceKey,
  type StoredHighWaterV1,
  type WagyuVerificationStoreV1,
} from "./storage.ts";
import {
  WAGYU_LIKE_CHAIN_LIMIT,
  WAGYU_LIKE_RECEIPT_CONCURRENCY,
  WAGYU_THREAD_REPLY_LIMIT,
  WAGYU_VERIFICATION_WORKER_PROTOCOL,
  WAGYU_WORKER_MAX_FEED_EVENT_BYTES,
  WAGYU_WORKER_MAX_SHARE_EDGE_BYTES,
  type VerifiedFeedValueV1,
  type VerifiedLikePackageValueV1,
  type VerifiedLikeReceiptValueV1,
  type VerifiedLikesValueV1,
  type VerifiedProfileValueV1,
  type VerifiedThreadReplyValueV1,
  type VerifiedThreadValueV1,
  type VerifyFeedTaskV1,
  type VerifyLikesTaskV1,
  type VerifyProfileTaskV1,
  type VerifyThreadTaskV1,
  type WagyuWorkerResultV1,
  type WagyuWorkerTaskV1,
} from "./types.ts";

const NAT64_MAX = 0xffff_ffff_ffff_ffffn;
const LIKE_CONTINUATION_TTL_NS = 10n * 60n * 1_000_000_000n;
const MAX_LIKE_CONTINUATIONS = 64;
const LIKE_CONTINUATION_BYTES = 32;

export interface WagyuVerificationEngineDependenciesV1 {
  readonly verifier: WagyuVerifierV1;
  readonly storage: WagyuVerificationStoreV1;
  readonly immutableResponses?: WagyuImmutableResponseCacheV1;
  readonly nowNs?: () => bigint;
  readonly randomBytes?: (length: number) => Uint8Array;
}

type RawReceiptResult = {
  readonly id: string;
  readonly actorNodeId: string;
  readonly state: "verified" | "invalid" | "unavailable";
  readonly code: string | null;
  readonly proofFingerprint: string;
};

type CachedShareEdgeEvidence = {
  readonly schema: typeof WAGYU_VERIFICATION_WORKER_PROTOCOL;
  readonly verifierVersion: typeof WAGYU_VERIFIER_VERSION;
  readonly networkId: string;
  readonly immediateSender: string;
  readonly originalAuthor: string;
  readonly postId: string;
  readonly bodyHash: string;
  readonly exactEventBytes: Uint8Array;
};

type LikeHeadSnapshot = {
  readonly storeGeneration: string;
  readonly revision: string;
  readonly bodyDigest: string;
  readonly acceptingLikes: boolean;
  readonly sealedBatchCount: string;
  readonly sealedReceiptCount: string;
};

type LikeContinuationState = {
  readonly postAuthor: string;
  readonly postId: string;
  readonly postBodyHash: string;
  readonly head: LikeHeadSnapshot;
  readonly nextBatchDigest: Uint8Array;
  readonly nextBatchNumber: bigint;
  readonly seenDigests: ReadonlySet<string>;
  readonly seenLikers: ReadonlySet<string>;
  readonly newerFirstAcceptedSequence: bigint | null;
  readonly remainingReceiptCount: bigint;
  readonly expiresAtNs: bigint;
};

type LikeTraversalStart = {
  readonly head: LikeHeadSnapshot;
  readonly nextBatchDigest: Uint8Array | null;
  readonly nextBatchNumber: bigint | null;
  readonly seenDigests: ReadonlySet<string>;
  readonly seenLikers: ReadonlySet<string>;
  readonly newerFirstAcceptedSequence: bigint | null;
  readonly remainingReceiptCount: bigint;
};

type CompletedLikeContinuation = {
  readonly postAuthor: string;
  readonly postId: string;
  readonly postBodyHash: string;
  readonly result: VerifiedLikesValueV1;
  readonly expiresAtNs: bigint;
};

export class WagyuVerificationEngineV1 {
  private readonly verifier: WagyuVerifierV1;
  private readonly storage: WagyuVerificationStoreV1;
  private readonly immutableResponses:
    | WagyuImmutableResponseCacheV1
    | undefined;
  private readonly nowNs: () => bigint;
  private readonly randomBytes: (length: number) => Uint8Array;
  private readonly networkIdHex: string;
  private readonly mutableQueue = new KeyedSerialQueue();
  private readonly likeContinuations = new Map<string, LikeContinuationState>();
  private readonly completedLikeContinuations =
    new Map<string, CompletedLikeContinuation>();
  private readonly activeLikeContinuations = new Set<string>();

  constructor(dependencies: WagyuVerificationEngineDependenciesV1) {
    this.verifier = dependencies.verifier;
    this.storage = dependencies.storage;
    this.immutableResponses = dependencies.immutableResponses;
    this.nowNs = dependencies.nowNs ??
      (() => BigInt(Date.now()) * 1_000_000n);
    this.randomBytes = dependencies.randomBytes ?? secureRandomBytes;
    this.networkIdHex = lowerHex(requireBytes32(
      this.verifier.networkId,
      "Worker verifier network ID",
    ));
  }

  get trustedNetworkIdHex(): string {
    return this.networkIdHex;
  }

  async execute(
    task: WagyuWorkerTaskV1,
    signal: AbortSignal,
  ): Promise<WagyuWorkerResultV1<unknown>> {
    try {
      throwIfAborted(signal);
      if (!isRecord(task) || typeof task.kind !== "string") {
        return invalid("invalid_worker_task", "Worker task is malformed");
      }
      switch (task.kind) {
        case "profile":
          return await this.verifyProfile(task, signal);
        case "feed":
          return await this.verifyFeed(task, signal);
        case "thread":
          return await this.verifyThread(task, signal);
        case "likes":
          return await this.verifyLikes(task, signal);
        default:
          return invalid("invalid_worker_task", "Worker task kind is unknown");
      }
    } catch (error) {
      if (error instanceof WorkerInterruptionError) {
        return unavailable(error.code, error.message);
      }
      return unavailable(
        "worker_execution_failed",
        boundedError(error, "Verification Worker execution failed"),
      );
    }
  }

  private async verifyProfile(
    task: VerifyProfileTaskV1,
    signal: AbortSignal,
  ): Promise<WagyuWorkerResultV1<VerifiedProfileValueV1>> {
    let nodeId: string;
    try {
      nodeId = boundedNodeId(task.nodeId, "Profile node");
    } catch (error) {
      return invalidError("invalid_profile_task", error);
    }
    const key = profileHighWaterKey(this.networkIdHex, nodeId);
    return this.mutableQueue.run(key, signal, async () => {
      const stored = await this.storage.getHighWater(key);
      const prior = storedProfileHighWater(stored);
      const result = await this.fetchAndVerify({
        actor: nodeId,
        target: { kind: "profile" },
        decoder: profileV1Decoder,
        mutable: profileV1MutableGuard(
          { nowNs: this.nowNs() },
          prior,
        ),
      }, signal);
      if (result.state !== "verified") return result;

      const profile = result.value.decoded.value;
      const avatar = result.value.avatar.state === "verified"
        ? {
            mediaType: result.value.avatar.mediaType,
            width: result.value.avatar.width,
            height: result.value.avatar.height,
            bytes: result.value.avatar.bytes.slice(),
          }
        : null;
      const value: VerifiedProfileValueV1 = {
        nodeId,
        profileGeneration: profile.profile_generation.toString(),
        revision: profile.revision.toString(),
        bodyDigest: lowerHex(result.bodyDigest),
        displayName: profile.display_name,
        description: profile.description,
        capabilities: [...(profile.capabilities[0] ?? [])],
        updatedAtNs: profile.updated_at_ns.toString(),
        certificateTimeNs: result.certificateTimeNs.toString(),
        highWater: result.highWater ?? "advance",
        avatar,
      };
      // This write is part of the serialized security decision. A store that
      // cannot retain its in-session high-water must not release the value.
      await this.storage.putHighWater(key, {
        kind: "profile",
        profileGeneration: value.profileGeneration,
        revision: value.revision,
        bodyDigest: result.bodyDigest.slice(),
      });
      return verified(value);
    });
  }

  private async verifyFeed(
    task: VerifyFeedTaskV1,
    signal: AbortSignal,
  ): Promise<WagyuWorkerResultV1<VerifiedFeedValueV1>> {
    let eventBytes: Uint8Array;
    let immediateSender: string;
    try {
      assertCandidateId(task.candidateId);
      immediateSender = boundedNodeId(
        task.immediateSender,
        "Immediate sender",
      );
      if (
        task.eventKind !== "original" &&
        task.eventKind !== "share" &&
        task.eventKind !== "tombstone"
      ) {
        throw new Error("Feed event kind is unsupported");
      }
      eventBytes = requireBoundedBytes(
        task.exactEventBytes,
        "Feed event",
        1,
        WAGYU_WORKER_MAX_FEED_EVENT_BYTES,
      );
    } catch (error) {
      return invalidError("invalid_feed_task", error);
    }

    try {
      if (task.eventKind === "original") {
        const ref = decodeCertifiedPostRefV1(eventBytes).value;
        const actor = ref.author.toText();
        if (actor !== immediateSender) {
          return invalid(
            "feed_sender_mismatch",
            "Original post author is not the immediate sender",
          );
        }
        const post = await this.verifyPost(ref, signal);
        if (post.state !== "verified") return post;
        return verified(
          await this.feedPostValue(task, post.value, ref, null, signal),
        );
      }

      if (task.eventKind === "share") {
        const delivery = decodeCertifiedShareDeliveryV1(eventBytes).value;
        const originalRefDecoded = decodeCertifiedPostRefV1(
          delivery.original_post_ref_candid,
        );
        const originalRef = originalRefDecoded.value;
        const sharer = delivery.share_ref.sharer.toText();
        if (sharer !== immediateSender) {
          return invalid(
            "feed_sender_mismatch",
            "Share actor is not the immediate sender",
          );
        }
        const post = await this.verifyPost(originalRef, signal);
        if (post.state !== "verified") return post;
        const share = await abortable(
          this.verifier.verifyPortable({
            actor: sharer,
            target: {
              kind: "action",
              actionKind: "share",
              digest: delivery.share_ref.object_digest,
            },
            body: delivery.share_action_candid,
            proof: verifierProofFromProtocol(delivery.share_ref.proof),
            decoder: shareV1Decoder(
              delivery.share_ref,
              originalRefDecoded.exact_bytes,
            ),
          }),
          signal,
        );
        if (share.state !== "verified") return share;
        const action = share.value.value;
        if (
          action.original_author.toText() !== originalRef.author.toText() ||
          !equalBytes(action.original_post_id, originalRef.post_id) ||
          !equalBytes(action.original_body_hash, originalRef.body_hash)
        ) {
          return invalid(
            "share_original_mismatch",
            "Share action does not bind the verified original post",
          );
        }
        const value = await this.feedPostValue(
          task,
          post.value,
          originalRef,
          sharer,
          signal,
        );
        if (eventBytes.byteLength <= WAGYU_WORKER_MAX_SHARE_EDGE_BYTES) {
          const originalAuthor = originalRef.author.toText();
          const postId = lowerHex(originalRef.post_id);
          const bodyHash = lowerHex(originalRef.body_hash);
          await optionalWrite(() =>
            this.storage.putVerifiedResult<CachedShareEdgeEvidence>(
              shareEdgeEvidenceKey(
                this.networkIdHex,
                sharer,
                originalAuthor,
                postId,
                bodyHash,
              ),
              {
                schema: WAGYU_VERIFICATION_WORKER_PROTOCOL,
                verifierVersion: WAGYU_VERIFIER_VERSION,
                networkId: this.networkIdHex,
                immediateSender: sharer,
                originalAuthor,
                postId,
                bodyHash,
                exactEventBytes: eventBytes.slice(),
              },
            )
          );
        }
        return verified(value);
      }

      const tombstone = decodeCertifiedTombstoneV1(eventBytes).value;
      const actor = tombstone.ref.actor.toText();
      const proof = await abortable(
        this.verifier.verifyPortable({
          actor,
          target: {
            kind: "action",
            actionKind: "tombstone",
            digest: tombstone.ref.object_digest,
          },
          body: tombstone.tombstone_action_candid,
          proof: verifierProofFromProtocol(tombstone.ref.proof_snapshot),
          decoder: tombstoneV1Decoder(tombstone.ref),
        }),
        signal,
      );
      if (proof.state !== "verified") return proof;
      const action = proof.value.value;
      if (actor !== immediateSender) {
        const expected = {
          immediateSender,
          originalAuthor: actor,
          postId: action.post_id,
          bodyHash: action.post_body_hash,
        };
        const edge = task.verifiedShareEdge;
        const shareEvidence = edge === undefined
          ? await this.verifyStoredShareEdge(expected, signal)
          : await this.verifyProvidedShareEdge(edge, expected, signal);
        if (shareEvidence.state !== "verified") return shareEvidence;
      }
      return verified({
        candidateId: task.candidateId,
        eventKind: "tombstone",
        authorNodeId: actor,
        sharedByNodeId: actor === immediateSender ? null : immediateSender,
        postId: lowerHex(action.post_id),
        bodyHash: lowerHex(action.post_body_hash),
        objectDigest: lowerHex(tombstone.ref.object_digest),
        bodyLength: tombstone.tombstone_action_candid.byteLength,
        bodyMarkdown: null,
        actionTimeNs: action.issued_at_ns.toString(),
        replyTo: null,
      });
    } catch (error) {
      if (error instanceof WorkerInterruptionError) throw error;
      return invalidError("invalid_feed_evidence", error);
    }
  }

  private async verifyStoredShareEdge(
    expected: {
      readonly immediateSender: string;
      readonly originalAuthor: string;
      readonly postId: Uint8Array;
      readonly bodyHash: Uint8Array;
    },
    signal: AbortSignal,
  ): Promise<WagyuWorkerResultV1<true>> {
    const postId = lowerHex(requireBytes32(
      expected.postId,
      "Relayed tombstone post ID",
    ));
    const bodyHash = lowerHex(requireBytes32(
      expected.bodyHash,
      "Relayed tombstone body hash",
    ));
    const key = shareEdgeEvidenceKey(
      this.networkIdHex,
      expected.immediateSender,
      expected.originalAuthor,
      postId,
      bodyHash,
    );
    const storedValue = await optionalRead(() =>
      this.storage.getVerifiedResult<unknown>(key)
    );
    if (storedValue === null) {
      return unavailable(
        "share_edge_unavailable",
        "The exact verified share edge is not available in rebuildable cache",
      );
    }

    let stored: CachedShareEdgeEvidence;
    try {
      stored = parseCachedShareEdgeEvidence(storedValue, {
        networkId: this.networkIdHex,
        immediateSender: expected.immediateSender,
        originalAuthor: expected.originalAuthor,
        postId,
        bodyHash,
      });
    } catch (error) {
      return invalidError("invalid_cached_share_edge", error);
    }

    return this.verifyExactShareEdge(
      stored.exactEventBytes,
      expected,
      signal,
      "cached",
    );
  }

  private async verifyProvidedShareEdge(
    edge: NonNullable<VerifyFeedTaskV1["verifiedShareEdge"]>,
    expected: {
      readonly immediateSender: string;
      readonly originalAuthor: string;
      readonly postId: Uint8Array;
      readonly bodyHash: Uint8Array;
    },
    signal: AbortSignal,
  ): Promise<WagyuWorkerResultV1<true>> {
    try {
      if (
        boundedNodeId(edge.immediateSender, "Share-edge sender") !==
          expected.immediateSender ||
        boundedNodeId(edge.originalAuthor, "Share-edge author") !==
          expected.originalAuthor ||
        !equalBytes(
          requireBytes32(edge.postId, "Share-edge post ID"),
          expected.postId,
        ) ||
        !equalBytes(
          requireBytes32(edge.bodyHash, "Share-edge body hash"),
          expected.bodyHash,
        )
      ) {
        return invalid(
          "unproven_tombstone_relay",
          "Relayed tombstone does not match the provided share evidence",
        );
      }
      return this.verifyExactShareEdge(
        requireBoundedBytes(
          edge.exactShareDeliveryBytes,
          "Provided share edge",
          1,
          WAGYU_WORKER_MAX_SHARE_EDGE_BYTES,
        ),
        expected,
        signal,
        "provided",
      );
    } catch (error) {
      return invalidError("invalid_provided_share_edge", error);
    }
  }

  private async verifyExactShareEdge(
    exactEventBytes: Uint8Array,
    expected: {
      readonly immediateSender: string;
      readonly originalAuthor: string;
      readonly postId: Uint8Array;
      readonly bodyHash: Uint8Array;
    },
    signal: AbortSignal,
    source: "cached" | "provided",
  ): Promise<WagyuWorkerResultV1<true>> {
    const invalidCode = source === "cached"
      ? "invalid_cached_share_edge"
      : "invalid_provided_share_edge";
    try {
      const delivery = decodeCertifiedShareDeliveryV1(
        requireBoundedBytes(
          exactEventBytes,
          source === "cached" ? "Cached share edge" : "Provided share edge",
          1,
          WAGYU_WORKER_MAX_SHARE_EDGE_BYTES,
        ),
      ).value;
      const originalRefDecoded = decodeCertifiedPostRefV1(
        delivery.original_post_ref_candid,
      );
      const originalRef = originalRefDecoded.value;
      if (
        delivery.share_ref.sharer.toText() !== expected.immediateSender ||
        originalRef.author.toText() !== expected.originalAuthor ||
        !equalBytes(originalRef.post_id, expected.postId) ||
        !equalBytes(originalRef.body_hash, expected.bodyHash)
      ) {
        return invalid(
          source === "cached"
            ? "cached_share_edge_mismatch"
            : "provided_share_edge_mismatch",
          `${
            source === "cached" ? "Cached" : "Provided"
          } share evidence does not bind the relayed tombstone`,
        );
      }
      const share = await abortable(
        this.verifier.verifyPortable({
          actor: expected.immediateSender,
          target: {
            kind: "action",
            actionKind: "share",
            digest: delivery.share_ref.object_digest,
          },
          body: delivery.share_action_candid,
          proof: verifierProofFromProtocol(delivery.share_ref.proof),
          decoder: shareV1Decoder(
            delivery.share_ref,
            originalRefDecoded.exact_bytes,
          ),
        }),
        signal,
      );
      if (share.state !== "verified") return share;
      const action = share.value.value;
      if (
        action.original_author.toText() !== expected.originalAuthor ||
        !equalBytes(action.original_post_id, expected.postId) ||
        !equalBytes(action.original_body_hash, expected.bodyHash)
      ) {
        return invalid(
          "cached_share_action_mismatch",
          "Cached share action does not bind the relayed tombstone",
        );
      }
      return verified(true);
    } catch (error) {
      if (error instanceof WorkerInterruptionError) throw error;
      return invalidError(invalidCode, error);
    }
  }

  private async verifyPost(
    ref: CertifiedPostRefV1,
    signal: AbortSignal,
  ): Promise<VerificationResultV1<ExactDecodedCandidV1<PostBodyV1>>> {
    const actor = ref.author.toText();
    const target = {
      kind: "action" as const,
      actionKind: "post" as const,
      digest: ref.object_digest,
    };
    const live = await this.fetchAndVerify({
      actor,
      target,
      decoder: postV1Decoder(ref),
    }, signal);
    if (live.state !== "verified") return live;
    const portable = await abortable(
      this.verifier.verifyPortable({
        actor,
        target,
        body: live.body,
        proof: verifierProofFromProtocol(ref.proof),
        decoder: postV1Decoder(ref),
      }),
      signal,
    );
    return portable.state === "verified" ? live : portable;
  }

  private async feedPostValue(
    task: VerifyFeedTaskV1,
    post: ExactDecodedCandidV1<PostBodyV1>,
    ref: CertifiedPostRefV1,
    sharedByNodeId: string | null,
    signal: AbortSignal,
  ): Promise<VerifiedFeedValueV1> {
    const reply = post.value.reply_to[0];
    let replyTo: VerifiedFeedValueV1["replyTo"] = null;
    if (reply !== undefined) {
      const parentRef: CertifiedPostRefV1 = {
        author: reply.author,
        post_id: reply.post_id,
        body_hash: reply.body_hash,
        body_length: reply.body_length,
        object_digest: reply.object_digest,
        // Reply locators deliberately carry no detached proof. This placeholder
        // is never read: the parent is accepted only from a fresh live certified
        // response at its content-addressed path below.
        proof: {
          certificate_version: 2,
          certificate_cbor: new Uint8Array(),
          witness_cbor: new Uint8Array(),
          expression_path_cbor: new Uint8Array(),
          certificate_time_ns: 0n,
        },
      };
      const parent = await this.fetchAndVerify({
        actor: reply.author.toText(),
        target: {
          kind: "action",
          actionKind: "post",
          digest: reply.object_digest,
        },
        decoder: postV1Decoder(parentRef),
      }, signal);
      const common = {
        authorNodeId: reply.author.toText(),
        postId: lowerHex(reply.post_id),
        bodyHash: lowerHex(reply.body_hash),
        objectDigest: lowerHex(reply.object_digest),
        bodyLength: reply.body_length,
      };
      replyTo = parent.state === "verified"
        ? {
            ...common,
            state: "verified",
            code: null,
            bodyMarkdown: parent.value.value.body_markdown,
          }
        : {
            ...common,
            state: parent.state,
            code: parent.code,
            bodyMarkdown: null,
          };
    }
    return {
      candidateId: task.candidateId,
      eventKind: sharedByNodeId === null ? "original" : "share",
      authorNodeId: ref.author.toText(),
      sharedByNodeId,
      postId: lowerHex(ref.post_id),
      bodyHash: lowerHex(ref.body_hash),
      objectDigest: lowerHex(ref.object_digest),
      bodyLength: ref.body_length,
      bodyMarkdown: post.value.body_markdown,
      actionTimeNs: post.value.created_at_ns.toString(),
      replyTo,
    };
  }

  private async verifyThread(
    task: VerifyThreadTaskV1,
    signal: AbortSignal,
  ): Promise<WagyuWorkerResultV1<VerifiedThreadValueV1>> {
    let postAuthor: string;
    let postId: Uint8Array;
    let postBodyHash: Uint8Array;
    let postObjectDigest: Uint8Array;
    let postBodyLength: number;
    let summaryOnly: boolean;
    try {
      postAuthor = boundedNodeId(task.postAuthor, "Post author");
      postId = requireBytes32(task.postId, "Post ID");
      postBodyHash = requireBytes32(task.postBodyHash, "Post body hash");
      postObjectDigest = requireBytes32(
        task.postObjectDigest,
        "Post object digest",
      );
      postBodyLength = task.postBodyLength;
      summaryOnly = task.summaryOnly ?? false;
      if (
        !Number.isSafeInteger(postBodyLength) ||
        postBodyLength < 1 ||
        postBodyLength > 1_044_480 ||
        (
          task.summaryOnly !== undefined &&
          typeof task.summaryOnly !== "boolean"
        )
      ) throw new Error("Post body length is invalid");
    } catch (error) {
      return invalidError("invalid_thread_task", error);
    }
    const postIdHex = lowerHex(postId);
    const highWaterKey = replyIndexHighWaterKey(
      this.networkIdHex,
      postAuthor,
      postIdHex,
    );
    return this.mutableQueue.run(highWaterKey, signal, async () => {
      const stored = await this.storage.getHighWater(highWaterKey);
      const prior = storedReplyIndexHighWater(stored);
      const result = await this.fetchAndVerify({
        actor: postAuthor,
        target: { kind: "reply-index", postId },
        decoder: replyIndexV1Decoder({
          postAuthor,
          postId,
          postBodyHash,
        }),
        mutable: replyIndexV1MutableGuard(
          { nowNs: this.nowNs() },
          prior,
        ),
      }, signal);
      if (result.state !== "verified") {
        // A missing HTTP object is not proof of an empty conversation. The
        // peer, gateway, or Wagyu mount can be temporarily unavailable.
        return result;
      }

      const index = result.value.value;
      await this.storage.putHighWater(highWaterKey, {
        kind: "reply-index",
        storeGeneration: index.store_generation.toString(),
        revision: index.revision.toString(),
        bodyDigest: result.bodyDigest.slice(),
      });
      const replyCount = index.replies.length;
      if (summaryOnly) {
        return verified({
          postAuthor,
          postId: postIdHex,
          postBodyHash: lowerHex(postBodyHash),
          replyCount,
          index: {
            storeGeneration: index.store_generation.toString(),
            revision: index.revision.toString(),
            bodyDigest: lowerHex(result.bodyDigest),
          },
          replies: [],
        });
      }
      const firstVisibleReply = Math.max(
        0,
        index.replies.length - WAGYU_THREAD_REPLY_LIMIT,
      );
      const replies = await mapBounded(
        index.replies.slice(firstVisibleReply),
        WAGYU_LIKE_RECEIPT_CONCURRENCY,
        async (entry): Promise<VerifiedThreadReplyValueV1> => {
          const authorNodeId = entry.author.toText();
          const entryPostId = lowerHex(entry.post_id);
          const entryObjectDigest = lowerHex(entry.object_digest);
          const base = {
            authorNodeId,
            postId: entryPostId,
            objectDigest: entryObjectDigest,
            bodyLength: entry.object_length,
            receivedAtNs: entry.received_at_ns.toString(),
          };
          const reply = await this.fetchAndVerify({
            actor: authorNodeId,
            target: {
              kind: "action",
              actionKind: "post",
              digest: entry.object_digest,
            },
            decoder: {
              decodeAndValidate: (exactBody, context) => {
                const decoded = decodePostBodyV1(exactBody);
                assertActionHeader(
                  decoded.value.header,
                  bytes32(context.networkId, "trusted network_id"),
                  Principal.fromText(authorNodeId),
                  "post",
                );
                const identity = derivePostIdentity(decoded);
                const parent = decoded.value.reply_to[0];
                if (
                  context.actor !== authorNodeId ||
                  !equalBytes(identity.post_id, entry.post_id) ||
                  !equalBytes(
                    identity.object_digest,
                    entry.object_digest,
                  ) ||
                  identity.body_length !== entry.object_length ||
                  !parent ||
                  parent.author.toText() !== postAuthor ||
                  !equalBytes(parent.post_id, postId) ||
                  !equalBytes(parent.body_hash, postBodyHash) ||
                  !equalBytes(parent.object_digest, postObjectDigest) ||
                  parent.body_length !== postBodyLength
                ) {
                  throw new Error(
                    "Indexed reply does not bind the selected parent",
                  );
                }
                return decoded;
              },
            },
          }, signal);
          if (reply.state !== "verified") {
            return {
              ...base,
              state: reply.state,
              code: reply.code,
              bodyHash: null,
              bodyMarkdown: null,
              createdAtNs: null,
            };
          }
          const identity = derivePostIdentity(reply.value);
          return {
            ...base,
            state: "verified",
            code: null,
            bodyHash: lowerHex(identity.body_hash),
            bodyMarkdown: reply.value.value.body_markdown,
            createdAtNs: reply.value.value.created_at_ns.toString(),
          };
        },
        signal,
      );
      return verified({
        postAuthor,
        postId: postIdHex,
        postBodyHash: lowerHex(postBodyHash),
        replyCount,
        index: {
          storeGeneration: index.store_generation.toString(),
          revision: index.revision.toString(),
          bodyDigest: lowerHex(result.bodyDigest),
        },
        replies,
      });
    });
  }

  private async verifyLikes(
    task: VerifyLikesTaskV1,
    signal: AbortSignal,
  ): Promise<WagyuWorkerResultV1<VerifiedLikesValueV1>> {
    let postAuthor: string;
    let postId: Uint8Array;
    let postBodyHash: Uint8Array;
    let inputContinuation: string | null;
    try {
      postAuthor = boundedNodeId(task.postAuthor, "Post author");
      postId = requireBytes32(task.postId, "Post ID");
      postBodyHash = requireBytes32(task.postBodyHash, "Post body hash");
      inputContinuation = task.continuation === undefined
        ? null
        : likeContinuationToken(task.continuation);
    } catch (error) {
      return invalidError("invalid_likes_task", error);
    }
    const postIdHex = lowerHex(postId);
    const bodyHashHex = lowerHex(postBodyHash);
    let start: LikeTraversalStart;
    if (inputContinuation === null) {
      const highWaterKey = likeHeadHighWaterKey(
        this.networkIdHex,
        postAuthor,
        postIdHex,
      );
      const initial = await this.mutableQueue.run(
        highWaterKey,
        signal,
        async (): Promise<WagyuWorkerResultV1<LikeTraversalStart>> => {
          const stored = await this.storage.getHighWater(highWaterKey);
          const prior = storedLikeHeadHighWater(stored);
          const head = await this.fetchAndVerify({
            actor: postAuthor,
            target: { kind: "like-head", postId },
            decoder: likeHeadV1Decoder({
              postAuthor,
              postId,
              postBodyHash,
            }),
            mutable: likeHeadV1MutableGuard(
              { nowNs: this.nowNs() },
              prior,
            ),
          }, signal);
          if (head.state !== "verified") return head;

          const headValue = head.value.value;
          await this.storage.putHighWater(highWaterKey, {
            kind: "like-head",
            storeGeneration: headValue.store_generation.toString(),
            revision: headValue.revision.toString(),
            bodyDigest: head.bodyDigest.slice(),
          });
          return verified({
            head: {
              storeGeneration: headValue.store_generation.toString(),
              revision: headValue.revision.toString(),
              bodyDigest: lowerHex(head.bodyDigest),
              acceptingLikes: headValue.accepting_likes,
              sealedBatchCount: headValue.sealed_batch_count.toString(),
              sealedReceiptCount: headValue.sealed_receipt_count.toString(),
            },
            nextBatchDigest:
              headValue.latest_batch_digest[0]?.slice() ?? null,
            nextBatchNumber: headValue.latest_batch_number[0] ?? null,
            seenDigests: new Set<string>(),
            seenLikers: new Set<string>(),
            newerFirstAcceptedSequence: null,
            remainingReceiptCount: headValue.sealed_receipt_count,
          });
        },
      );
      if (initial.state !== "verified") return initial;
      start = initial.value;
    } else {
      const now = this.nowNs();
      this.pruneLikeContinuations(now);
      const completed =
        this.completedLikeContinuations.get(inputContinuation);
      if (completed !== undefined) {
        if (
          completed.postAuthor !== postAuthor ||
          completed.postId !== postIdHex ||
          completed.postBodyHash !== bodyHashHex
        ) {
          return invalid(
            "like_continuation_mismatch",
            "The Like continuation is bound to another post",
          );
        }
        return verified(structuredClone(completed.result));
      }
      const stored = this.likeContinuations.get(inputContinuation);
      if (stored === undefined || stored.expiresAtNs <= now) {
        this.likeContinuations.delete(inputContinuation);
        return unavailable(
          "like_continuation_unavailable",
          "The Like continuation expired or belongs to another Worker instance",
        );
      }
      if (
        stored.postAuthor !== postAuthor ||
        stored.postId !== postIdHex ||
        stored.postBodyHash !== bodyHashHex
      ) {
        return invalid(
          "like_continuation_mismatch",
          "The Like continuation is bound to another post",
        );
      }
      if (this.activeLikeContinuations.has(inputContinuation)) {
        return unavailable(
          "like_continuation_busy",
          "The Like continuation is already being used",
        );
      }
      this.activeLikeContinuations.add(inputContinuation);
      start = {
        head: stored.head,
        nextBatchDigest: stored.nextBatchDigest.slice(),
        nextBatchNumber: stored.nextBatchNumber,
        seenDigests: new Set(stored.seenDigests),
        seenLikers: new Set(stored.seenLikers),
        newerFirstAcceptedSequence: stored.newerFirstAcceptedSequence,
        remainingReceiptCount: stored.remainingReceiptCount,
      };
    }

    try {
      return await this.verifyLikePage(
        {
          postAuthor,
          postId,
          postIdHex,
          postBodyHash,
          bodyHashHex,
          start,
          inputContinuation,
        },
        signal,
      );
    } finally {
      if (inputContinuation !== null) {
        this.activeLikeContinuations.delete(inputContinuation);
      }
    }
  }

  private async verifyLikePage(
    input: {
      readonly postAuthor: string;
      readonly postId: Uint8Array;
      readonly postIdHex: string;
      readonly postBodyHash: Uint8Array;
      readonly bodyHashHex: string;
      readonly start: LikeTraversalStart;
      readonly inputContinuation: string | null;
    },
    signal: AbortSignal,
  ): Promise<WagyuWorkerResultV1<VerifiedLikesValueV1>> {
    const {
      postAuthor,
      postId,
      postIdHex,
      postBodyHash,
      bodyHashHex,
      start,
      inputContinuation,
    } = input;
    const packages: VerifiedLikePackageValueV1[] = [];
    const seenDigests = new Set(start.seenDigests);
    const seenLikers = new Set(start.seenLikers);
    let digest: Uint8Array | null =
      start.nextBatchDigest?.slice() ?? null;
    let batchNumber = start.nextBatchNumber;
    let newerFirstAcceptedSequence =
      start.newerFirstAcceptedSequence;
    let remainingReceiptCount = start.remainingReceiptCount;
    let invalidCount = 0;
    let unavailableCount = 0;
    let verifiedCount = 0;
    let visited = 0;

    while (
      digest !== null &&
      batchNumber !== null &&
      visited < WAGYU_LIKE_CHAIN_LIMIT
    ) {
      throwIfAborted(signal);
      const digestHex = lowerHex(digest);
      if (seenDigests.has(digestHex)) {
        packages.push(failedPackage(
          digestHex,
          batchNumber,
          "invalid",
          "like_batch_cycle",
        ));
        invalidCount += 1;
        digest = null;
        break;
      }

      // CacheStorage may reuse the exact immutable response bytes, but every
      // traversal reruns certificate, package, and receipt verification.
      // A shaped derived summary is never verification authority.
      const batch = await this.fetchAndVerify({
        actor: postAuthor,
        target: { kind: "like-batch", digest },
        decoder: likeBatchV1Decoder({
          postAuthor,
          postId,
          postBodyHash,
          expectedBatchNumber: batchNumber,
        }),
      }, signal);
      if (batch.state !== "verified") {
        packages.push(failedPackage(
          digestHex,
          batchNumber,
          batch.state,
          batch.code,
        ));
        if (batch.state === "invalid") invalidCount += 1;
        else {
          unavailableCount += 1;
          // Keep this exact position in the continuation so a transient
          // failure cannot silently skip an unverified package.
        }
        if (batch.state === "invalid") digest = null;
        break;
      }
      const structural = validateBatchLink(batch.value.value, batchNumber);
      if (structural !== null) {
        packages.push(failedPackage(
          digestHex,
          batchNumber,
          "invalid",
          structural,
        ));
        invalidCount += 1;
        digest = null;
        break;
      }
      const receipts = await this.verifyReceiptPool(
        batch.value.value,
        postAuthor,
        postId,
        postBodyHash,
        digestHex,
        signal,
      );
      const unavailableReceipts = receipts.filter(
        (receipt) => receipt.state === "unavailable",
      ).length;
      if (unavailableReceipts > 0) {
        packages.push(failedPackage(
          digestHex,
          batchNumber,
          "unavailable",
          "like_receipt_unavailable",
        ));
        unavailableCount += unavailableReceipts;
        // Do not apply a partial duplicate classification. Retry starts at
        // this exact batch with the pre-batch liker set.
        break;
      }
      const summary = {
        previousBatchDigest:
          batch.value.value.previous_batch_digest[0] === undefined
            ? null
            : lowerHex(batch.value.value.previous_batch_digest[0]),
        firstAcceptedSequence:
          batch.value.value.first_accepted_sequence.toString(),
        lastAcceptedSequence:
          batch.value.value.last_accepted_sequence.toString(),
        receipts,
      };
      const cacheState: VerifiedLikePackageValueV1["cache"] = "verified-now";

      const firstAcceptedSequence = storedNat64(
        summary.firstAcceptedSequence,
      );
      const lastAcceptedSequence = storedNat64(
        summary.lastAcceptedSequence,
      );
      const chainError = validateBatchAgainstHeadAndSuccessor(
        {
          batchNumber,
          firstAcceptedSequence,
          lastAcceptedSequence,
          receiptCount: summary.receipts.length,
        },
        start.head,
        newerFirstAcceptedSequence,
        remainingReceiptCount,
      );
      if (chainError !== null) {
        packages.push(failedPackage(
          digestHex,
          batchNumber,
          "invalid",
          chainError,
        ));
        invalidCount += 1;
        digest = null;
        break;
      }

      seenDigests.add(digestHex);
      const displayed = applyDuplicateRule(summary.receipts, seenLikers);
      for (const receipt of displayed) {
        if (receipt.state === "verified") verifiedCount += 1;
        else if (receipt.state === "invalid") invalidCount += 1;
        else unavailableCount += 1;
      }
      packages.push({
        batchDigest: digestHex,
        batchNumber: batchNumber.toString(),
        state: "verified",
        code: null,
        receipts: displayed,
        cache: cacheState,
      });
      digest =
        summary.previousBatchDigest === null
          ? null
          : hexBytes32(summary.previousBatchDigest, "Cached predecessor digest");
      newerFirstAcceptedSequence = firstAcceptedSequence;
      remainingReceiptCount -= BigInt(summary.receipts.length);
      batchNumber = batchNumber === 0n ? null : batchNumber - 1n;
      visited += 1;
    }

    const continuation =
      digest !== null && batchNumber !== null
        ? this.issueLikeContinuation({
            postAuthor,
            postId: postIdHex,
            postBodyHash: bodyHashHex,
            head: start.head,
            nextBatchDigest: digest,
            nextBatchNumber: batchNumber,
            seenDigests,
            seenLikers,
            newerFirstAcceptedSequence,
            remainingReceiptCount,
            expiresAtNs: boundedAdd(
              this.nowNs(),
              LIKE_CONTINUATION_TTL_NS,
            ),
          })
        : null;
    const value: VerifiedLikesValueV1 = {
      postAuthor,
      postId: postIdHex,
      postBodyHash: bodyHashHex,
      // The head's cumulative receipt count is an author assertion used only
      // to validate the immutable chain. It is deliberately not released as
      // a verified UI count; callers count receipts only after each package
      // and nested proof succeeds.
      head: {
        storeGeneration: start.head.storeGeneration,
        revision: start.head.revision,
        bodyDigest: start.head.bodyDigest,
        acceptingLikes: start.head.acceptingLikes,
        sealedBatchCount: start.head.sealedBatchCount,
      },
      packages,
      verifiedIncluded: verifiedCount,
      invalid: invalidCount,
      unavailable: unavailableCount,
      truncated: continuation !== null,
      continuation,
    };
    if (inputContinuation !== null) {
      // Retain the exact result briefly so a lost response can replay without
      // reclassifying duplicates or advancing the immutable snapshot twice.
      this.likeContinuations.delete(inputContinuation);
      this.completedLikeContinuations.set(inputContinuation, {
        postAuthor,
        postId: postIdHex,
        postBodyHash: bodyHashHex,
        result: structuredClone(value),
        expiresAtNs: boundedAdd(this.nowNs(), LIKE_CONTINUATION_TTL_NS),
      });
      this.enforceLikeContinuationLimit();
    }
    return verified(value);
  }

  private issueLikeContinuation(state: LikeContinuationState): string {
    this.pruneLikeContinuations(this.nowNs());
    let token: string | null = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = lowerHex(requireRandomBytes(
        this.randomBytes(LIKE_CONTINUATION_BYTES),
        LIKE_CONTINUATION_BYTES,
      ));
      if (
        !this.likeContinuations.has(candidate) &&
        !this.completedLikeContinuations.has(candidate)
      ) {
        token = candidate;
        break;
      }
    }
    if (token === null) {
      throw new Error("Could not allocate a unique Like continuation");
    }
    this.likeContinuations.set(token, {
      ...state,
      nextBatchDigest: state.nextBatchDigest.slice(),
      seenDigests: new Set(state.seenDigests),
      seenLikers: new Set(state.seenLikers),
    });
    this.enforceLikeContinuationLimit();
    return token;
  }

  private pruneLikeContinuations(nowNs: bigint): void {
    for (const [token, state] of this.likeContinuations) {
      if (
        state.expiresAtNs <= nowNs &&
        !this.activeLikeContinuations.has(token)
      ) {
        this.likeContinuations.delete(token);
      }
    }
    for (const [token, state] of this.completedLikeContinuations) {
      if (state.expiresAtNs <= nowNs) {
        this.completedLikeContinuations.delete(token);
      }
    }
  }

  private enforceLikeContinuationLimit(): void {
    while (
      this.likeContinuations.size +
        this.completedLikeContinuations.size >
          MAX_LIKE_CONTINUATIONS
    ) {
      const completed = this.completedLikeContinuations.keys().next();
      if (!completed.done) {
        this.completedLikeContinuations.delete(completed.value);
        continue;
      }
      let removed = false;
      for (const token of this.likeContinuations.keys()) {
        if (!this.activeLikeContinuations.has(token)) {
          this.likeContinuations.delete(token);
          removed = true;
          break;
        }
      }
      if (!removed) {
        throw new Error("Like continuation capacity is exhausted");
      }
    }
  }

  private async verifyReceiptPool(
    batch: LikeBatchV1,
    postAuthor: string,
    postId: Uint8Array,
    postBodyHash: Uint8Array,
    batchDigestHex: string,
    signal: AbortSignal,
  ): Promise<RawReceiptResult[]> {
    if (batch.receipts.length < 1 || batch.receipts.length > 150) {
      throw new Error("Like batch exceeds the bounded receipt count");
    }
    return mapBounded(
      batch.receipts,
      WAGYU_LIKE_RECEIPT_CONCURRENCY,
      async (receipt, index) => {
        throwIfAborted(signal);
        const actor = receipt.ref.actor.toText();
        const fingerprint = await proofFingerprint(
          receipt.ref,
          receipt.like_action_candid,
        );
        const result = await abortable(
          this.verifier.verifyPortable({
            actor,
            target: {
              kind: "action",
              actionKind: "like",
              digest: receipt.ref.object_digest,
            },
            body: receipt.like_action_candid,
            proof: verifierProofFromProtocol(receipt.ref.proof_snapshot),
            decoder: likeV1Decoder(receipt.ref),
          }),
          signal,
        );
        const base = {
          id: `${batchDigestHex}:${index}`,
          actorNodeId: actor,
          proofFingerprint: fingerprint,
        };
        if (result.state !== "verified") {
          return {
            ...base,
            state: result.state,
            code: result.code,
          };
        }
        const action: LikeActionV1 = result.value.value;
        if (
          action.post_author.toText() !== postAuthor ||
          !equalBytes(action.post_id, postId) ||
          !equalBytes(action.post_body_hash, postBodyHash)
        ) {
          return {
            ...base,
            state: "invalid",
            code: "like_target_mismatch",
          };
        }
        return {
          ...base,
          state: "verified",
          code: null,
        };
      },
      signal,
    );
  }

  private async fetchAndVerify<T>(
    request: FetchAndVerifyRequestV1<T>,
    signal: AbortSignal,
  ): Promise<VerificationResultV1<T>> {
    throwIfAborted(signal);
    const immutable =
      request.target.kind === "action" ||
      request.target.kind === "like-batch";
    const url = immutable
      ? deriveGatewayUrl(
          this.verifier.gateway,
          request.actor,
          request.target,
        ).href
      : null;
    let committed = false;
    try {
      const result = await abortable(
        this.verifier.fetchAndVerify({
          ...request,
          signal,
        }),
        signal,
      );
      if (url !== null && this.immutableResponses !== undefined) {
        if (result.state === "verified") {
          await this.immutableResponses.commit(url);
          committed = true;
        }
      }
      return result;
    } finally {
      if (
        url !== null &&
        this.immutableResponses !== undefined &&
        !committed
      ) {
        this.immutableResponses.discard(url);
      }
    }
  }
}

function storedProfileHighWater(
  value: StoredHighWaterV1 | null,
): ProfileHighWaterV1 | null {
  try {
    if (value === null || value.kind !== "profile") return null;
    return {
      profileGeneration: storedNat64(value.profileGeneration),
      revision: storedNat64(value.revision),
      bodyDigest: requireBytes32(value.bodyDigest, "Stored profile digest"),
    };
  } catch {
    return null;
  }
}

function storedLikeHeadHighWater(
  value: StoredHighWaterV1 | null,
): LikeHeadHighWaterV1 | null {
  try {
    if (value === null || value.kind !== "like-head") return null;
    return {
      storeGeneration: storedNat64(value.storeGeneration),
      revision: storedNat64(value.revision),
      bodyDigest: requireBytes32(value.bodyDigest, "Stored head digest"),
    };
  } catch {
    return null;
  }
}

function storedReplyIndexHighWater(
  value: StoredHighWaterV1 | null,
): ReplyIndexHighWaterV1 | null {
  try {
    if (value === null || value.kind !== "reply-index") return null;
    return {
      storeGeneration: storedNat64(value.storeGeneration),
      revision: storedNat64(value.revision),
      bodyDigest: requireBytes32(
        value.bodyDigest,
        "Stored reply-index digest",
      ),
    };
  } catch {
    return null;
  }
}

function parseCachedShareEdgeEvidence(
  value: unknown,
  expected: {
    readonly networkId: string;
    readonly immediateSender: string;
    readonly originalAuthor: string;
    readonly postId: string;
    readonly bodyHash: string;
  },
): CachedShareEdgeEvidence {
  if (
    !isRecord(value) ||
    value.schema !== WAGYU_VERIFICATION_WORKER_PROTOCOL ||
    value.verifierVersion !== WAGYU_VERIFIER_VERSION ||
    value.networkId !== expected.networkId ||
    value.immediateSender !== expected.immediateSender ||
    value.originalAuthor !== expected.originalAuthor ||
    value.postId !== expected.postId ||
    value.bodyHash !== expected.bodyHash ||
    !(value.exactEventBytes instanceof Uint8Array) ||
    value.exactEventBytes.byteLength === 0 ||
    value.exactEventBytes.byteLength > WAGYU_WORKER_MAX_SHARE_EDGE_BYTES
  ) {
    throw new Error("Cached share-edge evidence is invalid");
  }
  return {
    schema: WAGYU_VERIFICATION_WORKER_PROTOCOL,
    verifierVersion: WAGYU_VERIFIER_VERSION,
    networkId: value.networkId,
    immediateSender: value.immediateSender,
    originalAuthor: value.originalAuthor,
    postId: value.postId,
    bodyHash: value.bodyHash,
    exactEventBytes: value.exactEventBytes.slice(),
  };
}

function validateBatchLink(
  batch: LikeBatchV1,
  expectedNumber: bigint,
): string | null {
  if (batch.batch_number !== expectedNumber) return "like_batch_number_mismatch";
  const previous = batch.previous_batch_digest[0] ?? null;
  if (expectedNumber === 0n && previous !== null) {
    return "like_batch_genesis_predecessor";
  }
  if (expectedNumber > 0n && previous === null) {
    return "like_batch_missing_predecessor";
  }
  return null;
}

function validateBatchAgainstHeadAndSuccessor(
  batch: {
    readonly batchNumber: bigint;
    readonly firstAcceptedSequence: bigint;
    readonly lastAcceptedSequence: bigint;
    readonly receiptCount: number;
  },
  head: LikeHeadSnapshot,
  newerFirstAcceptedSequence: bigint | null,
  remainingReceiptCount: bigint,
): string | null {
  // In V101 the frozen final_partial field is a package-size marker. A
  // verified 1-149 receipt package may appear anywhere in an open immutable
  // chain, so only the codec's size invariant applies.
  if (
    newerFirstAcceptedSequence === null &&
    batch.batchNumber + 1n !== storedNat64(head.sealedBatchCount)
  ) {
    return "like_sealed_batch_count_mismatch";
  }
  if (
    newerFirstAcceptedSequence !== null &&
    batch.lastAcceptedSequence >= newerFirstAcceptedSequence
  ) {
    return "like_batch_sequence_order";
  }
  const receiptCount = BigInt(batch.receiptCount);
  if (
    receiptCount > remainingReceiptCount ||
    (batch.batchNumber === 0n && receiptCount !== remainingReceiptCount) ||
    (batch.batchNumber > 0n && receiptCount >= remainingReceiptCount)
  ) {
    return "like_sealed_receipt_count_mismatch";
  }
  return null;
}

function applyDuplicateRule(
  receipts: readonly RawReceiptResult[],
  seenLikers: Set<string>,
): VerifiedLikeReceiptValueV1[] {
  return receipts.map((receipt) => {
    if (receipt.state !== "verified") {
      return {
        id: receipt.id,
        actorNodeId: receipt.actorNodeId,
        state: receipt.state,
        code: receipt.code,
      };
    }
    if (seenLikers.has(receipt.actorNodeId)) {
      return {
        id: receipt.id,
        actorNodeId: receipt.actorNodeId,
        state: "invalid",
        code: "duplicate_liker",
      };
    }
    seenLikers.add(receipt.actorNodeId);
    return {
      id: receipt.id,
      actorNodeId: receipt.actorNodeId,
      state: "verified",
      code: null,
    };
  });
}

function failedPackage(
  digest: string,
  batchNumber: bigint,
  state: "invalid" | "unavailable",
  code: string,
): VerifiedLikePackageValueV1 {
  return {
    batchDigest: digest,
    batchNumber: batchNumber.toString(),
    state,
    code,
    receipts: [],
    cache: "verified-now",
  };
}

async function proofFingerprint(
  ref: CertifiedActionRefV1,
  exactBody: Uint8Array,
): Promise<string> {
  const proof = ref.proof_snapshot;
  const pieces = [
    exactBody,
    proof.certificate_cbor,
    proof.witness_cbor,
    proof.expression_path_cbor,
  ];
  const size = pieces.reduce((total, piece) => total + 4 + piece.byteLength, 0);
  const framed = new Uint8Array(size);
  const view = new DataView(framed.buffer);
  let offset = 0;
  for (const piece of pieces) {
    view.setUint32(offset, piece.byteLength, false);
    offset += 4;
    framed.set(piece, offset);
    offset += piece.byteLength;
  }
  return lowerHex(await sha256(framed));
}

async function mapBounded<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T, index: number) => Promise<R>,
  signal: AbortSignal,
): Promise<R[]> {
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > WAGYU_LIKE_RECEIPT_CONCURRENCY
  ) {
    throw new Error("Worker concurrency bound is invalid");
  }
  const results = new Array<R>(values.length);
  let cursor = 0;
  const run = async () => {
    while (true) {
      throwIfAborted(signal);
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      results[index] = await map(values[index]!, index);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      () => run(),
    ),
  );
  return results;
}

function assertCandidateId(value: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("Feed candidate ID is invalid");
  }
}

function boundedNodeId(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 5 ||
    value.length > 128 ||
    !/^[a-z0-9-]+$/u.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireBoundedBytes(
  value: Uint8Array,
  label: string,
  minimum: number,
  maximum: number,
): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < minimum ||
    value.byteLength > maximum
  ) {
    throw new Error(`${label} byte length is invalid`);
  }
  return value.slice();
}

function requireBytes32(value: Uint8Array, label: string): Uint8Array {
  return requireBoundedBytes(value, label, 32, 32);
}

function assertHex32(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} is not lowercase hex`);
  }
  return value;
}

function hexBytes32(value: string, label: string): Uint8Array {
  assertHex32(value, label);
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(
      value.slice(index * 2, index * 2 + 2),
      16,
    );
  }
  return bytes;
}

function storedNat64(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,19})$/u.test(value)
  ) {
    throw new Error("Stored Nat64 is malformed");
  }
  const parsed = BigInt(value);
  if (parsed > NAT64_MAX) throw new Error("Stored Nat64 is out of range");
  return parsed;
}

function likeContinuationToken(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error("Like continuation is malformed");
  }
  return value;
}

function requireRandomBytes(
  value: Uint8Array,
  expectedLength: number,
): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength !== expectedLength
  ) {
    throw new Error("Worker random source returned invalid bytes");
  }
  return value;
}

function secureRandomBytes(length: number): Uint8Array {
  if (
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > 64 ||
    globalThis.crypto?.getRandomValues === undefined
  ) {
    throw new Error("A secure Worker random source is unavailable");
  }
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

function boundedAdd(value: bigint, increment: bigint): bigint {
  if (
    value < 0n ||
    value > NAT64_MAX ||
    increment < 0n ||
    increment > NAT64_MAX
  ) {
    throw new Error("Worker nanosecond clock is out of range");
  }
  return value > NAT64_MAX - increment ? NAT64_MAX : value + increment;
}

async function optionalRead<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

async function optionalWrite(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch {
    // Browser persistence is rebuildable and never changes verification truth.
  }
}

class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(
    key: string,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    void tail.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    try {
      await abortable(previous, signal);
      throwIfAborted(signal);
      return await operation();
    } finally {
      release();
    }
  }
}

async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(interruption(signal));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw interruption(signal);
}

function interruption(signal: AbortSignal): WorkerInterruptionError {
  const timeout = signal.reason === "timeout";
  return new WorkerInterruptionError(
    timeout ? "worker_timeout" : "worker_cancelled",
    timeout
      ? "Verification exceeded its bounded Worker deadline"
      : "Verification was cancelled",
  );
}

class WorkerInterruptionError extends Error {
  constructor(
    readonly code: "worker_timeout" | "worker_cancelled",
    message: string,
  ) {
    super(message);
    this.name = "WorkerInterruptionError";
  }
}

function verified<T>(value: T): WagyuWorkerResultV1<T> {
  return { state: "verified", value };
}

function invalid(
  code: string,
  reason: string,
): Extract<WagyuWorkerResultV1<never>, { state: "invalid" }> {
  return { state: "invalid", code, reason };
}

function invalidError(
  code: string,
  error: unknown,
): Extract<WagyuWorkerResultV1<never>, { state: "invalid" }> {
  return invalid(code, boundedError(error, "Invalid Wagyu verification data"));
}

function unavailable(
  code: string,
  reason: string,
): Extract<WagyuWorkerResultV1<never>, { state: "unavailable" }> {
  return { state: "unavailable", code, reason };
}

function boundedError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  return message.length > 512 ? `${message.slice(0, 509)}...` : message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
