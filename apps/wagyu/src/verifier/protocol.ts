import { Principal } from "@dfinity/principal";
import {
  assertCertifiedActionRef,
  assertCertifiedPostRefMatchesBody,
  assertLikeActionIdentity,
  assertShareActionIdentity,
  assertTombstoneActionIdentity,
  bytes32,
  decodeLikeActionV1,
  decodeLikeBatchV1,
  decodeLikeHeadV1,
  decodePostBodyV1,
  decodeProfileV1,
  decodeReplyIndexV1,
  decodeShareActionV1,
  decodeTombstoneActionV1,
  equalBytes as protocolEqualBytes,
  type CertifiedActionRefV1,
  type CertifiedHttpProofV1 as ProtocolCertifiedHttpProofV1,
  type CertifiedPostRefV1,
  type CertifiedShareRefV1,
  type ExactDecodedCandidV1,
  type LikeActionV1,
  type LikeBatchV1,
  type LikeHeadV1,
  type PostBodyV1,
  type ProfileV1,
  type ReplyIndexV1,
  type ShareActionV1,
  type TombstoneActionV1,
} from "../protocol/index.ts";
import { equalBytes, requireBytes } from "./bytes.ts";
import {
  confirmProfileAvatarSafety,
  validateLikeHeadSemantics,
  validateLikeSemantics,
  validatePostSemantics,
  validateProfileSemantics,
  validateReplyIndexSemantics,
  validateShareSemantics,
  validateTombstoneSemantics,
  type VerifiedProfileAvatarV1,
} from "./semantics.ts";
import type {
  CertifiedHttpProofV1,
  LikeHeadHighWaterV1,
  MutableFreshnessPolicyV1,
  MutableVerificationGuardV1,
  ProfileHighWaterV1,
  ReplyIndexHighWaterV1,
  SemanticDecoderV1,
} from "./types.ts";
import {
  checkLikeHeadHighWater,
  checkProfileHighWater,
  checkReplyIndexHighWater,
} from "./high_water.ts";

type DecoderContextV1 =
  Parameters<SemanticDecoderV1<unknown>["decodeAndValidate"]>[1];

export interface VerifiedProfileBodyV1 {
  readonly decoded: ExactDecodedCandidV1<ProfileV1>;
  readonly avatar: VerifiedProfileAvatarV1;
}

export interface LikeBatchBindingV1 {
  readonly postAuthor: string;
  readonly postId: Uint8Array;
  readonly postBodyHash: Uint8Array;
  readonly expectedBatchNumber?: bigint;
  readonly expectedPreviousBatchDigest?: Uint8Array | null;
}

export interface ReplyIndexBindingV1 {
  readonly postAuthor: string;
  readonly postId: Uint8Array;
  readonly postBodyHash: Uint8Array;
}

/** Converts the frozen protocol wire shape into the verifier adapter shape. */
export function verifierProofFromProtocol(
  proof: ProtocolCertifiedHttpProofV1,
): CertifiedHttpProofV1 {
  if (proof.certificate_version !== 2) {
    throw new Error("Only protocol certificate_version 2 is supported");
  }
  return {
    certificateVersion: 2,
    certificateCbor: proof.certificate_cbor.slice(),
    witnessCbor: proof.witness_cbor.slice(),
    expressionPathCbor: proof.expression_path_cbor.slice(),
    certificateTimeNs: proof.certificate_time_ns,
  };
}

export const profileV1Decoder: SemanticDecoderV1<VerifiedProfileBodyV1> =
  Object.freeze({
    async decodeAndValidate(
      exactBody: Uint8Array,
      context: DecoderContextV1,
    ): Promise<VerifiedProfileBodyV1> {
      if (context.target.kind !== "profile") {
        throw new Error("Profile decoder received a non-profile target");
      }
      const decoded = decodeProfileV1(exactBody);
      const checked = validateProfileSemantics(decoded.value, {
        networkId: context.networkId,
        node: context.actor,
      });
      return {
        decoded,
        avatar: await confirmProfileAvatarSafety(checked.avatar),
      };
    },
  });

export function postV1Decoder(
  ref: CertifiedPostRefV1,
): SemanticDecoderV1<ExactDecodedCandidV1<PostBodyV1>> {
  return Object.freeze({
    async decodeAndValidate(
      exactBody: Uint8Array,
      context: DecoderContextV1,
    ) {
      requireActionTarget(context.target, "post");
      requireServingPrincipal(ref.author, context.actor, "Post ref author");
      const decoded = decodePostBodyV1(exactBody);
      assertCertifiedPostRefMatchesBody(
        ref,
        decoded,
        bytes32(context.networkId, "trusted network_id"),
      );
      await validatePostSemantics(decoded.value, ref, {
        networkId: context.networkId,
        actor: context.actor,
        exactBody: decoded.exact_bytes,
      });
      return decoded;
    },
  });
}

export function shareV1Decoder(
  ref: CertifiedShareRefV1,
  exactOriginalPostRefCandid: Uint8Array,
): SemanticDecoderV1<ExactDecodedCandidV1<ShareActionV1>> {
  const originalRefBytes = exactOriginalPostRefCandid.slice();
  return Object.freeze({
    async decodeAndValidate(
      exactBody: Uint8Array,
      context: DecoderContextV1,
    ) {
      requireActionTarget(context.target, "share");
      requireServingPrincipal(ref.sharer, context.actor, "Share ref actor");
      const decoded = decodeShareActionV1(exactBody);
      assertShareActionIdentity(
        decoded.value,
        originalRefBytes,
        bytes32(context.networkId, "trusted network_id"),
        Principal.fromText(context.actor),
      );
      await validateShareSemantics(decoded.value, ref, {
        networkId: context.networkId,
        actor: context.actor,
        exactBody: decoded.exact_bytes,
      });
      return decoded;
    },
  });
}

export function likeV1Decoder(
  ref: CertifiedActionRefV1,
): SemanticDecoderV1<ExactDecodedCandidV1<LikeActionV1>> {
  return Object.freeze({
    async decodeAndValidate(
      exactBody: Uint8Array,
      context: DecoderContextV1,
    ) {
      requireActionTarget(context.target, "like");
      const actor = Principal.fromText(context.actor);
      const decoded = decodeLikeActionV1(exactBody);
      assertLikeActionIdentity(
        decoded.value,
        bytes32(context.networkId, "trusted network_id"),
        actor,
      );
      assertCertifiedActionRef(ref, decoded.exact_bytes, actor, "like");
      await validateLikeSemantics(decoded.value, ref, {
        networkId: context.networkId,
        actor: context.actor,
        exactBody: decoded.exact_bytes,
      });
      return decoded;
    },
  });
}

export function tombstoneV1Decoder(
  ref: CertifiedActionRefV1,
): SemanticDecoderV1<ExactDecodedCandidV1<TombstoneActionV1>> {
  return Object.freeze({
    async decodeAndValidate(
      exactBody: Uint8Array,
      context: DecoderContextV1,
    ) {
      requireActionTarget(context.target, "tombstone");
      const actor = Principal.fromText(context.actor);
      const decoded = decodeTombstoneActionV1(exactBody);
      assertTombstoneActionIdentity(
        decoded.value,
        bytes32(context.networkId, "trusted network_id"),
        actor,
      );
      assertCertifiedActionRef(ref, decoded.exact_bytes, actor, "tombstone");
      await validateTombstoneSemantics(decoded.value, ref, {
        networkId: context.networkId,
        actor: context.actor,
        exactBody: decoded.exact_bytes,
      });
      return decoded;
    },
  });
}

export function likeHeadV1Decoder(
  binding: Omit<LikeBatchBindingV1, "expectedBatchNumber" | "expectedPreviousBatchDigest">,
): SemanticDecoderV1<ExactDecodedCandidV1<LikeHeadV1>> {
  return Object.freeze({
    decodeAndValidate(
      exactBody: Uint8Array,
      context: DecoderContextV1,
    ) {
      if (context.target.kind !== "like-head") {
        throw new Error("Like-head decoder received a different target");
      }
      const decoded = decodeLikeHeadV1(exactBody);
      validateLikeHeadSemantics(decoded.value, {
        networkId: context.networkId,
        postAuthor: binding.postAuthor,
        postId: binding.postId,
        postBodyHash: binding.postBodyHash,
      });
      if (!equalBytes(context.target.postId, decoded.value.post_id)) {
        throw new Error("Like-head path post ID does not match its body");
      }
      if (context.actor !== binding.postAuthor) {
        throw new Error("Like-head serving node is not the post author");
      }
      return decoded;
    },
  });
}

export function likeBatchV1Decoder(
  binding: LikeBatchBindingV1,
): SemanticDecoderV1<ExactDecodedCandidV1<LikeBatchV1>> {
  return Object.freeze({
    decodeAndValidate(
      exactBody: Uint8Array,
      context: DecoderContextV1,
    ) {
      if (context.target.kind !== "like-batch") {
        throw new Error("Like-batch decoder received a different target");
      }
      const decoded = decodeLikeBatchV1(exactBody);
      const batch = decoded.value;
      if (
        context.actor !== binding.postAuthor ||
        batch.post_author.toText() !== binding.postAuthor ||
        !equalBytes(batch.network_id, context.networkId) ||
        !equalBytes(batch.post_id, requireBytes(binding.postId, "Post ID", 32)) ||
        !equalBytes(
          batch.post_body_hash,
          requireBytes(binding.postBodyHash, "Post body hash", 32),
        )
      ) {
        throw new Error("Like batch does not bind the expected post/network");
      }
      if (
        binding.expectedBatchNumber !== undefined &&
        batch.batch_number !== binding.expectedBatchNumber
      ) {
        throw new Error("Like batch number does not match the head/chain");
      }
      if (binding.expectedPreviousBatchDigest !== undefined) {
        const actual = batch.previous_batch_digest[0] ?? null;
        const expected = binding.expectedPreviousBatchDigest;
        if (
          (actual === null) !== (expected === null) ||
          (actual !== null && expected !== null && !protocolEqualBytes(actual, expected))
        ) {
          throw new Error("Like batch predecessor digest does not match");
        }
      }
      const expectedReceipts = batch.final_partial
        ? batch.receipts.length >= 1 && batch.receipts.length <= 149
        : batch.receipts.length === 150;
      if (!expectedReceipts) {
        throw new Error("Like batch receipt count/final_partial is invalid");
      }
      if (
        batch.last_accepted_sequence < batch.first_accepted_sequence
      ) {
        throw new Error("Like batch accepted-sequence range is invalid");
      }
      return decoded;
    },
  });
}

export function replyIndexV1Decoder(
  binding: ReplyIndexBindingV1,
): SemanticDecoderV1<ExactDecodedCandidV1<ReplyIndexV1>> {
  return Object.freeze({
    decodeAndValidate(
      exactBody: Uint8Array,
      context: DecoderContextV1,
    ) {
      if (context.target.kind !== "reply-index") {
        throw new Error("Reply-index decoder received a different target");
      }
      const decoded = decodeReplyIndexV1(exactBody);
      validateReplyIndexSemantics(decoded.value, {
        networkId: context.networkId,
        postAuthor: binding.postAuthor,
        postId: binding.postId,
        postBodyHash: binding.postBodyHash,
      });
      if (!equalBytes(context.target.postId, decoded.value.post_id)) {
        throw new Error("Reply-index path post ID does not match its body");
      }
      if (context.actor !== binding.postAuthor) {
        throw new Error("Reply-index serving node is not the post author");
      }
      return decoded;
    },
  });
}

export function profileV1MutableGuard(
  freshness: MutableFreshnessPolicyV1,
  prior: ProfileHighWaterV1 | null,
): MutableVerificationGuardV1<VerifiedProfileBodyV1> {
  return {
    freshness,
    checkHighWater(value, bodyDigest) {
      const profile = value.decoded.value;
      return checkProfileHighWater(prior, {
        profileGeneration: profile.profile_generation,
        revision: profile.revision,
        bodyDigest,
        previousProfileDigest: profile.previous_profile_digest[0] ?? null,
      });
    },
  };
}

export function likeHeadV1MutableGuard(
  freshness: MutableFreshnessPolicyV1,
  prior: LikeHeadHighWaterV1 | null,
): MutableVerificationGuardV1<ExactDecodedCandidV1<LikeHeadV1>> {
  return {
    freshness,
    checkHighWater(value, bodyDigest) {
      const head = value.value;
      return checkLikeHeadHighWater(prior, {
        storeGeneration: head.store_generation,
        revision: head.revision,
        bodyDigest,
        previousHeadHash: head.previous_head_hash[0] ?? null,
      });
    },
  };
}

export function replyIndexV1MutableGuard(
  freshness: MutableFreshnessPolicyV1,
  prior: ReplyIndexHighWaterV1 | null,
): MutableVerificationGuardV1<ExactDecodedCandidV1<ReplyIndexV1>> {
  return {
    freshness,
    checkHighWater(value, bodyDigest) {
      const index = value.value;
      return checkReplyIndexHighWater(prior, {
        storeGeneration: index.store_generation,
        revision: index.revision,
        bodyDigest,
        previousIndexHash: index.previous_index_hash[0] ?? null,
      });
    },
  };
}

function requireActionTarget(
  target: Parameters<SemanticDecoderV1<unknown>["decodeAndValidate"]>[1]["target"],
  kind: "post" | "share" | "like" | "tombstone",
): void {
  if (
    target.kind !== "action" ||
    target.actionKind !== kind
  ) throw new Error(`${kind} decoder received a different action target`);
}

function requireServingPrincipal(
  principal: Principal,
  actor: string,
  label: string,
): void {
  if (principal.toText() !== actor) {
    throw new Error(`${label} does not match the serving node`);
  }
}
