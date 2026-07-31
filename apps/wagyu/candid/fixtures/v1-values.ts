import { Principal } from "@dfinity/principal";
import {
  bytes16,
  bytes32,
  deriveFeedCandidateId,
  deriveLikeId,
  deriveNetworkId,
  deriveObjectDigest,
  derivePayloadDigest,
  derivePostBodyHash,
  derivePostId,
  derivePostRefDigest,
  deriveShareId,
  deriveTombstoneId,
  encodeCertifiedLikeReceiptV1,
  encodeCertifiedPostRefV1,
  encodeLikeActionV1,
  encodePostBodyV1,
  encodeShareActionV1,
  encodeTombstoneActionV1,
  encodeWagyuPackage,
  type WagyuPackageTypeMap,
} from "../../src/protocol/index.ts";

export const GOLDEN_ACTOR_A = Principal.fromText(
  "rrkah-fqaaa-aaaaa-aaaaq-cai",
);
export const GOLDEN_ACTOR_B = Principal.fromText(
  "ryjl3-tyaaa-aaaaa-aaaba-cai",
);

/** @dfinity/agent's frozen mainnet IC root SPKI DER bytes. */
export const GOLDEN_MAINNET_ROOT_DER = hex(
  "308182301d060d2b0601040182dc7c0503010201060c2b0601040182dc7c05030201036100814c0e6ec71fab583b08bd81373c255c3c371b2e84863c98a4f1e08b74235d14fb5d9c0cd546d9685f913a0c0b2cc5341583bf4b4392e467db96d65b9bb4cb717112f8472e0d5a4d14505ffd7484b01291091c5f87b98883463f98091a0baaae",
);

export const GOLDEN_NETWORK_ID = deriveNetworkId(GOLDEN_MAINNET_ROOT_DER);

const NONCE = bytes16(
  Uint8Array.from({ length: 16 }, (_, index) => index),
);
const OPERATION_ID = bytes16(
  Uint8Array.from({ length: 16 }, (_, index) => 0xf0 + index),
);
const ZERO32 = bytes32(new Uint8Array(32));
const ONE32 = bytes32(new Uint8Array(32).fill(1));

export function buildDefaultProfileValue(): WagyuPackageTypeMap["ProfileV1"] {
  return {
    network_id: GOLDEN_NETWORK_ID,
    node: GOLDEN_ACTOR_A,
    profile_generation: 2n,
    revision: 0n,
    updated_at_ns: 1_725_000_000_000_000_000n,
    previous_profile_digest: [],
    display_name: "",
    description: "",
    capabilities: [],
    avatar: [],
  };
}

export function buildGoldenPackageValues(): WagyuPackageTypeMap {
  const proof = {
    certificate_version: 2,
    certificate_cbor: Uint8Array.of(0xa1, 0x01, 0x02),
    witness_cbor: Uint8Array.of(0x82, 0x01, 0x00),
    expression_path_cbor: Uint8Array.of(0x81, 0x40),
    certificate_time_ns: 1_725_000_000_000_000_000n,
  };

  const post: WagyuPackageTypeMap["PostBodyV1"] = {
    header: {
      network_id: GOLDEN_NETWORK_ID,
      actor: GOLDEN_ACTOR_A,
      action_kind: [{ post: null }] as [{ post: null }],
    },
    author_sequence: 7n,
    nonce: NONCE,
    created_at_ns: 1_725_000_000_000_000_123n,
    body_markdown: "Hello, Wagyu!\n\nExact bytes matter.",
    reply_to: [],
  };
  const postBytes = encodePostBodyV1(post);
  const bodyHash = derivePostBodyHash(postBytes);
  const postId = derivePostId(GOLDEN_NETWORK_ID, GOLDEN_ACTOR_A, bodyHash);
  const postDigest = deriveObjectDigest(postBytes);
  const postRef = {
    author: GOLDEN_ACTOR_A,
    post_id: postId,
    body_hash: bodyHash,
    body_length: postBytes.byteLength,
    object_digest: postDigest,
    proof,
  };
  const postRefBytes = encodeCertifiedPostRefV1(postRef);

  const shareId = deriveShareId(
    GOLDEN_NETWORK_ID,
    GOLDEN_ACTOR_B,
    GOLDEN_ACTOR_A,
    postId,
  );
  const share = {
    header: {
      network_id: GOLDEN_NETWORK_ID,
      actor: GOLDEN_ACTOR_B,
      action_kind: [{ share: null }] as [{ share: null }],
    },
    share_id: shareId,
    share_sequence: 3n,
    issued_at_ns: 1_725_000_000_100_000_000n,
    original_author: GOLDEN_ACTOR_A,
    original_post_id: postId,
    original_body_hash: bodyHash,
    post_ref_digest: derivePostRefDigest(postRefBytes),
  };
  const shareBytes = encodeShareActionV1(share);
  const shareDigest = deriveObjectDigest(shareBytes);
  const shareRef = {
    sharer: GOLDEN_ACTOR_B,
    share_id: shareId,
    body_length: shareBytes.byteLength,
    object_digest: shareDigest,
    proof,
  };

  const likeId = deriveLikeId(
    GOLDEN_NETWORK_ID,
    GOLDEN_ACTOR_B,
    GOLDEN_ACTOR_A,
    postId,
  );
  const like = {
    header: {
      network_id: GOLDEN_NETWORK_ID,
      actor: GOLDEN_ACTOR_B,
      action_kind: [{ like: null }] as [{ like: null }],
    },
    like_id: likeId,
    issued_at_ns: 1_725_000_000_200_000_000n,
    post_author: GOLDEN_ACTOR_A,
    post_id: postId,
    post_body_hash: bodyHash,
  };
  const likeBytes = encodeLikeActionV1(like);
  const likeRef = {
    actor: GOLDEN_ACTOR_B,
    action_kind: [{ like: null }] as [{ like: null }],
    object_digest: deriveObjectDigest(likeBytes),
    body_length: likeBytes.byteLength,
    proof_snapshot: proof,
  };
  const likeReceipt = {
    like_action_candid: likeBytes,
    ref: likeRef,
  };
  const likeReceiptBytes = encodeCertifiedLikeReceiptV1(likeReceipt);

  const tombstoneId = deriveTombstoneId(
    GOLDEN_NETWORK_ID,
    GOLDEN_ACTOR_A,
    postId,
    8n,
  );
  const tombstone = {
    header: {
      network_id: GOLDEN_NETWORK_ID,
      actor: GOLDEN_ACTOR_A,
      action_kind: [{ tombstone: null }] as [{ tombstone: null }],
    },
    tombstone_id: tombstoneId,
    author_sequence: 8n,
    issued_at_ns: 1_725_000_000_300_000_000n,
    post_id: postId,
    post_body_hash: bodyHash,
  };
  const tombstoneBytes = encodeTombstoneActionV1(tombstone);
  const tombstoneRef = {
    actor: GOLDEN_ACTOR_A,
    action_kind: [{ tombstone: null }] as [{ tombstone: null }],
    object_digest: deriveObjectDigest(tombstoneBytes),
    body_length: tombstoneBytes.byteLength,
    proof_snapshot: proof,
  };

  const deliver: WagyuPackageTypeMap["DeliverBodyV1"] = {
    subscription_id: NONCE,
    renewal_requested: true,
    event: [{ original: postRefBytes }],
  };
  const deliverBodyBytes = encodeWagyuPackage("DeliverBodyV1", deliver);
  const ingress: WagyuPackageTypeMap["WagyuIngressV1"] = {
    operation_id: OPERATION_ID,
    body_candid: deliverBodyBytes,
  };
  const ingressBytes = encodeWagyuPackage("WagyuIngressV1", ingress);
  const payloadDigest = derivePayloadDigest(deliverBodyBytes);
  const directedSummary = {
    target_post_id: postId,
    target_body_hash: bodyHash,
    action_id: shareId,
    object_digest: shareDigest,
    object_length: shareBytes.byteLength,
  };
  const routeResult: WagyuPackageTypeMap["WagyuRouteResultV1"] = {
    outcome: [{ accepted: null }],
    local_receipt_time_ns: [1_725_000_002_000_000_000n],
    revision: [1n],
    relationship: [],
  };
  const routeResultBytes = encodeWagyuPackage(
    "WagyuRouteResultV1",
    routeResult,
  );
  const likeBatch: WagyuPackageTypeMap["LikeBatchV1"] = {
    network_id: GOLDEN_NETWORK_ID,
    post_author: GOLDEN_ACTOR_A,
    post_id: postId,
    post_body_hash: bodyHash,
    batch_number: 1n,
    previous_batch_digest: [],
    first_accepted_sequence: 12n,
    last_accepted_sequence: 12n,
    final_partial: true,
    receipts: [likeReceipt],
  };
  const likeBatchDigest = deriveObjectDigest(
    encodeWagyuPackage("LikeBatchV1", likeBatch),
  );

  return {
    ActionHeaderV1: post.header,
    PostBodyV1: post,
    ReplyIndexV1: {
      network_id: GOLDEN_NETWORK_ID,
      post_author: GOLDEN_ACTOR_A,
      post_id: postId,
      post_body_hash: bodyHash,
      store_generation: 10n,
      revision: 1n,
      previous_index_hash: [],
      replies: [
        {
          author: GOLDEN_ACTOR_B,
          post_id: shareId,
          object_digest: shareDigest,
          object_length: shareBytes.byteLength,
          received_at_ns: 1_725_000_000_150_000_000n,
        },
      ],
    },
    CertifiedHttpProofV1: proof,
    CertifiedActionRefV1: likeRef,
    CertifiedPostRefV1: postRef,
    ShareActionV1: share,
    CertifiedShareRefV1: shareRef,
    CertifiedShareDeliveryV1: {
      original_post_ref_candid: postRefBytes,
      share_action_candid: shareBytes,
      share_ref: shareRef,
    },
    LikeActionV1: like,
    CertifiedLikeReceiptV1: likeReceipt,
    ProfileV1: {
      network_id: GOLDEN_NETWORK_ID,
      node: GOLDEN_ACTOR_A,
      profile_generation: 2n,
      revision: 4n,
      updated_at_ns: 1_725_000_001_000_000_000n,
      previous_profile_digest: [ONE32],
      display_name: "Ada Wagyu",
      description: "A deterministic Wagyu V1 profile.",
      capabilities: [["wagyu_v1:fixtures"]],
      avatar: [
        {
          media_type: [{ png: null }],
          width: 1,
          height: 1,
          bytes: Uint8Array.of(
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
          ),
        },
      ],
    },
    TombstoneActionV1: tombstone,
    CertifiedTombstoneV1: {
      tombstone_action_candid: tombstoneBytes,
      ref: tombstoneRef,
    },
    LikeBatchV1: likeBatch,
    LikeHeadV1: {
      network_id: GOLDEN_NETWORK_ID,
      post_author: GOLDEN_ACTOR_A,
      post_id: postId,
      post_body_hash: bodyHash,
      store_generation: 9n,
      revision: 1n,
      previous_head_hash: [ZERO32],
      latest_batch_number: [1n],
      latest_batch_digest: [likeBatchDigest],
      sealed_batch_count: 1n,
      sealed_receipt_count: 1n,
      accepting_likes: false,
    },
    PublicIngressRequestV1: {
      method: "deliver",
      payload: ingressBytes,
    },
    PublicIngressResultV1: { ok: routeResultBytes },
    WagyuIngressV1: ingress,
    FollowBodyV1: {
      expected_revision: 0n,
      subscription_id: NONCE,
    },
    UnfollowBodyV1: {
      expected_revision: 1n,
      subscription_id: NONCE,
    },
    DeliverBodyV1: deliver,
    LikeBodyV1: {
      certified_like_receipt_candid: likeReceiptBytes,
    },
    NoticeBodyV1: {
      relation: [{ share: null }],
      target_post_id: postId,
      target_body_hash: bodyHash,
      actor_action_id: shareId,
      actor_object_digest: shareDigest,
      actor_object_length: shareBytes.byteLength,
    },
    FollowerHeadV1: {
      revision: 1n,
      state: [
        {
          active: {
            subscription_id: NONCE,
            lease_expires_ns: 3_456_000_000_000_000n,
            delivery_credits: 32,
          },
        },
      ],
    },
    WagyuRouteResultV1: routeResult,
    FeedPageRequestV1: { before_sequence: [], limit: 25 },
    FeedCandidateSummaryV1: {
      candidate_id: deriveFeedCandidateId(
        GOLDEN_ACTOR_A,
        OPERATION_ID,
        payloadDigest,
      ),
      local_sequence: 15n,
      received_at_ns: 1_725_000_003_000_000_000n,
      immediate_sender: GOLDEN_ACTOR_A,
      event_kind: [{ original: null }],
      claimed_author: GOLDEN_ACTOR_A,
      claimed_post_id: postId,
      exact_event_candid: postRefBytes,
      verification: [{ pending: null }],
    },
    FeedPageV1: {
      revision: 6n,
      items: [],
      next_before_sequence: [],
    },
    NotificationSummaryV1: {
      local_sequence: 22n,
      received_at_ns: 1_725_000_004_000_000_000n,
      actor: GOLDEN_ACTOR_B,
      kind: [{ share: directedSummary }],
      verification: [{ pending: null }],
      read: false,
    },
    NotificationPageRequestV1: { before_sequence: [], limit: 50 },
    NotificationPageV1: {
      revision: 3n,
      items: [],
      next_before_sequence: [],
    },
    NotificationEvidenceRequestV1: { local_sequence: 22n },
    NotificationEvidenceV1: {
      local_sequence: 22n,
      found: true,
      evidence: [
        {
          like: {
            certified_like_receipt_candid: likeReceiptBytes,
          },
        },
      ],
    },
    SendQuoteRequestV1: {
      send_kind: [{ post: null }],
      estimated_object_bytes: postBytes.byteLength,
      notice_target: [],
    },
    SendQuoteV1: {
      follower_revision: 12n,
      registered_follower_count: 10,
      eligible_delivery_count: 8,
      ineligible_follower_count: 2,
      eligible_recipient_preview: [GOLDEN_ACTOR_A, GOLDEN_ACTOR_B],
      receiver_floor_cycles: 1_600_000_000n,
      author_notice_floor_cycles: 0n,
      estimated_call_and_byte_cycles: 25_000_000n,
      estimated_local_publication_cycles: 75_000_000n,
      estimated_total_cycles: 1_700_000_000n,
    },
    ProfileEditRequestV1: {
      expected_profile_generation: 2n,
      expected_revision: 4n,
      display_name: "Ada Wagyu",
      description: "A deterministic Wagyu V1 profile.",
      avatar: [
        {
          media_type: [{ png: null }],
          width: 1,
          height: 1,
          bytes: Uint8Array.of(0x89, 0x50, 0x4e, 0x47),
        },
      ],
    },
    ProfileEditResultV1: {
      outcome: [
        {
          updated: {
            profile_generation: 2n,
            revision: 5n,
            body_digest: ONE32,
          },
        },
      ],
    },
  };
}

function hex(value: string): Uint8Array {
  if (value.length % 2 !== 0) throw new Error("invalid fixture hex");
  return Uint8Array.from(
    { length: value.length / 2 },
    (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  );
}
