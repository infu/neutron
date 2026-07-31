import type { Principal } from "@dfinity/principal";

declare const wagyuBytes16Brand: unique symbol;
declare const wagyuBytes32Brand: unique symbol;
declare const wagyuExactCandidBrand: unique symbol;

/** Runtime length checks, not distinct Candid scalar types. */
export type WagyuBytes16 = Uint8Array & {
  readonly [wagyuBytes16Brand]: true;
};

/** Runtime length checks, not distinct Candid scalar types. */
export type WagyuBytes32 = Uint8Array & {
  readonly [wagyuBytes32Brand]: true;
};

/** A copy of the exact received Candid message, never a re-encoding. */
export type WagyuExactCandidBytes = Uint8Array & {
  readonly [wagyuExactCandidBrand]: true;
};

export type WagyuBlob = Uint8Array;
export type CandidOpt<T> = [] | [T];
export type CandidUnitVariant<Tag extends string> = Readonly<Record<Tag, null>>;

export type ActionKindV1 =
  | CandidUnitVariant<"post">
  | CandidUnitVariant<"share">
  | CandidUnitVariant<"tombstone">
  | CandidUnitVariant<"like">;

export interface ActionHeaderV1 {
  network_id: WagyuBytes32;
  actor: Principal;
  action_kind: CandidOpt<ActionKindV1>;
}

export interface ReplyLocatorV1 {
  author: Principal;
  post_id: WagyuBytes32;
  body_hash: WagyuBytes32;
  body_length: number;
  object_digest: WagyuBytes32;
}

export interface PostBodyV1 {
  header: ActionHeaderV1;
  author_sequence: bigint;
  nonce: WagyuBytes16;
  created_at_ns: bigint;
  body_markdown: string;
  reply_to: CandidOpt<ReplyLocatorV1>;
}

export interface ReplyIndexEntryV1 {
  author: Principal;
  post_id: WagyuBytes32;
  object_digest: WagyuBytes32;
  object_length: number;
  received_at_ns: bigint;
}

export interface ReplyIndexV1 {
  network_id: WagyuBytes32;
  post_author: Principal;
  post_id: WagyuBytes32;
  post_body_hash: WagyuBytes32;
  store_generation: bigint;
  revision: bigint;
  previous_index_hash: CandidOpt<WagyuBytes32>;
  replies: readonly ReplyIndexEntryV1[];
}

export interface CertifiedHttpProofV1 {
  certificate_version: number;
  certificate_cbor: WagyuBlob;
  witness_cbor: WagyuBlob;
  expression_path_cbor: WagyuBlob;
  certificate_time_ns: bigint;
}

export interface CertifiedActionRefV1 {
  actor: Principal;
  action_kind: CandidOpt<ActionKindV1>;
  object_digest: WagyuBytes32;
  body_length: number;
  proof_snapshot: CertifiedHttpProofV1;
}

export interface CertifiedPostRefV1 {
  author: Principal;
  post_id: WagyuBytes32;
  body_hash: WagyuBytes32;
  body_length: number;
  object_digest: WagyuBytes32;
  proof: CertifiedHttpProofV1;
}

export interface ShareActionV1 {
  header: ActionHeaderV1;
  share_id: WagyuBytes32;
  share_sequence: bigint;
  issued_at_ns: bigint;
  original_author: Principal;
  original_post_id: WagyuBytes32;
  original_body_hash: WagyuBytes32;
  post_ref_digest: WagyuBytes32;
}

export interface CertifiedShareRefV1 {
  sharer: Principal;
  share_id: WagyuBytes32;
  body_length: number;
  object_digest: WagyuBytes32;
  proof: CertifiedHttpProofV1;
}

export interface CertifiedShareDeliveryV1 {
  /** Exact received CertifiedPostRefV1 Candid bytes. */
  original_post_ref_candid: WagyuExactCandidBytes;
  /** Exact received ShareActionV1 Candid bytes. */
  share_action_candid: WagyuExactCandidBytes;
  share_ref: CertifiedShareRefV1;
}

export interface LikeActionV1 {
  header: ActionHeaderV1;
  like_id: WagyuBytes32;
  issued_at_ns: bigint;
  post_author: Principal;
  post_id: WagyuBytes32;
  post_body_hash: WagyuBytes32;
}

export interface CertifiedLikeReceiptV1 {
  /** Exact received LikeActionV1 Candid bytes. */
  like_action_candid: WagyuExactCandidBytes;
  ref: CertifiedActionRefV1;
}

export type ProfileAvatarMediaTypeV1 =
  | CandidUnitVariant<"jpeg">
  | CandidUnitVariant<"png">
  | CandidUnitVariant<"webp">;

export interface ProfileAvatarV1 {
  media_type: CandidOpt<ProfileAvatarMediaTypeV1>;
  width: number;
  height: number;
  bytes: WagyuBlob;
}

export interface ProfileV1 {
  network_id: WagyuBytes32;
  node: Principal;
  profile_generation: bigint;
  revision: bigint;
  updated_at_ns: bigint;
  previous_profile_digest: CandidOpt<WagyuBytes32>;
  display_name: string;
  description: string;
  capabilities: CandidOpt<string[]>;
  avatar: CandidOpt<ProfileAvatarV1>;
}

export interface TombstoneActionV1 {
  header: ActionHeaderV1;
  tombstone_id: WagyuBytes32;
  author_sequence: bigint;
  issued_at_ns: bigint;
  post_id: WagyuBytes32;
  post_body_hash: WagyuBytes32;
}

export interface CertifiedTombstoneV1 {
  /** Exact received TombstoneActionV1 Candid bytes. */
  tombstone_action_candid: WagyuExactCandidBytes;
  ref: CertifiedActionRefV1;
}

export interface LikeBatchV1 {
  network_id: WagyuBytes32;
  post_author: Principal;
  post_id: WagyuBytes32;
  post_body_hash: WagyuBytes32;
  batch_number: bigint;
  previous_batch_digest: CandidOpt<WagyuBytes32>;
  first_accepted_sequence: bigint;
  last_accepted_sequence: bigint;
  final_partial: boolean;
  receipts: CertifiedLikeReceiptV1[];
}

export interface LikeHeadV1 {
  network_id: WagyuBytes32;
  post_author: Principal;
  post_id: WagyuBytes32;
  post_body_hash: WagyuBytes32;
  store_generation: bigint;
  revision: bigint;
  previous_head_hash: CandidOpt<WagyuBytes32>;
  latest_batch_number: CandidOpt<bigint>;
  latest_batch_digest: CandidOpt<WagyuBytes32>;
  sealed_batch_count: bigint;
  sealed_receipt_count: bigint;
  accepting_likes: boolean;
}

export interface PublicIngressRequestV1 {
  method: string;
  payload: WagyuExactCandidBytes;
}

export type PublicIngressErrorV1 =
  | CandidUnitVariant<"bad_request">
  | CandidUnitVariant<"not_found">
  | CandidUnitVariant<"too_large">
  | CandidUnitVariant<"unauthorized">
  | CandidUnitVariant<"rate_limited">
  | CandidUnitVariant<"busy">
  | CandidUnitVariant<"low_cycles">
  | CandidUnitVariant<"revoked">
  | CandidUnitVariant<"revoked_after_dispatch">
  | CandidUnitVariant<"handler_failed">;

export type PublicIngressResultV1 =
  | Readonly<{ ok: WagyuExactCandidBytes }>
  | Readonly<{ err: PublicIngressErrorV1 }>;

export interface WagyuIngressV1 {
  operation_id: WagyuBytes16;
  /** Exact route-specific inner Candid bytes. */
  body_candid: WagyuExactCandidBytes;
}

export interface FollowBodyV1 {
  expected_revision: bigint;
  subscription_id: WagyuBytes16;
}

export interface UnfollowBodyV1 {
  expected_revision: bigint;
  subscription_id: WagyuBytes16;
}

export type DeliveryEventV1 =
  | Readonly<{ original: WagyuExactCandidBytes }>
  | Readonly<{ share: WagyuExactCandidBytes }>
  | Readonly<{ tombstone: WagyuExactCandidBytes }>;

export interface DeliverBodyV1 {
  subscription_id: WagyuBytes16;
  renewal_requested: boolean;
  event: CandidOpt<DeliveryEventV1>;
}

export interface LikeBodyV1 {
  certified_like_receipt_candid: WagyuExactCandidBytes;
}

export type NoticeRelationV1 =
  | CandidUnitVariant<"reply">
  | CandidUnitVariant<"share">;

export interface NoticeBodyV1 {
  relation: CandidOpt<NoticeRelationV1>;
  target_post_id: WagyuBytes32;
  target_body_hash: WagyuBytes32;
  actor_action_id: WagyuBytes32;
  actor_object_digest: WagyuBytes32;
  actor_object_length: number;
}

export interface FollowerActiveV1 {
  subscription_id: WagyuBytes16;
  lease_expires_ns: bigint;
  delivery_credits: number;
}

export interface FollowerInactiveV1 {
  last_subscription_id: WagyuBytes16;
}

export type FollowerStateV1 =
  | Readonly<{ active: FollowerActiveV1 }>
  | Readonly<{ inactive: FollowerInactiveV1 }>;

export interface FollowerHeadV1 {
  revision: bigint;
  state: CandidOpt<FollowerStateV1>;
}

export type RelationshipStateV1 =
  | CandidUnitVariant<"registering">
  | CandidUnitVariant<"active">
  | CandidUnitVariant<"credit_low">
  | CandidUnitVariant<"expired">
  | CandidUnitVariant<"cleanup_pending">
  | CandidUnitVariant<"incompatible">
  | CandidUnitVariant<"blocked">;

/**
 * One directional relationship row. Following fields describe this node's
 * outbound subscription; follower fields describe the peer's inbound
 * subscription and delivery credit held here.
 */
export interface RelationshipSummaryV1 {
  node: Principal;
  following: boolean;
  follower: boolean;
  following_state: CandidOpt<RelationshipStateV1>;
  follower_state: CandidOpt<RelationshipStateV1>;
  follower_delivery_credits: number;
  follower_lease_expires_ns: CandidOpt<bigint>;
  following_renewal_requested: boolean;
  following_auto_renew_due: boolean;
  blocked: boolean;
  bond_cycles: bigint;
  protocol: string;
  compatible: boolean;
}

export interface RelationshipsV1 {
  revision: bigint;
  items: RelationshipSummaryV1[];
  next_before_node: CandidOpt<Principal>;
}

export interface RelationshipPageRequestV1 {
  before_node: CandidOpt<Principal>;
  expected_revision: CandidOpt<bigint>;
  limit: number;
}

export interface NodeRequestV1 {
  node: Principal;
}

export interface FollowRequestV1 {
  node: Principal;
  subscription_id: WagyuBytes16;
}

export type WagyuRejectionReasonV1 =
  | CandidUnitVariant<"invalid">
  | CandidUnitVariant<"blocked">
  | CandidUnitVariant<"not_following">
  | CandidUnitVariant<"unknown_post">
  | CandidUnitVariant<"expired">
  | CandidUnitVariant<"full">
  | CandidUnitVariant<"conflict">
  | CandidUnitVariant<"incompatible">;

export type WagyuRouteOutcomeV1 =
  | CandidUnitVariant<"accepted">
  | CandidUnitVariant<"duplicate">
  | Readonly<{
      rejected: {
        reason: CandidOpt<WagyuRejectionReasonV1>;
      };
    }>;

export interface WagyuRouteResultV1 {
  outcome: CandidOpt<WagyuRouteOutcomeV1>;
  local_receipt_time_ns: CandidOpt<bigint>;
  revision: CandidOpt<bigint>;
  relationship: CandidOpt<FollowerHeadV1>;
}

export interface FeedPageRequestV1 {
  before_sequence: CandidOpt<bigint>;
  limit: number;
}

export type FeedEventKindV1 =
  | CandidUnitVariant<"original">
  | CandidUnitVariant<"share">
  | CandidUnitVariant<"tombstone">;

export type VerificationStateV1 =
  | CandidUnitVariant<"pending">
  | CandidUnitVariant<"verified">
  | CandidUnitVariant<"invalid">
  | CandidUnitVariant<"unavailable">;

export interface FeedCandidateSummaryV1 {
  candidate_id: WagyuBytes32;
  local_sequence: bigint;
  received_at_ns: bigint;
  immediate_sender: Principal;
  event_kind: CandidOpt<FeedEventKindV1>;
  claimed_author: Principal;
  claimed_post_id: WagyuBytes32;
  /** Exact received event package bytes. */
  exact_event_candid: WagyuExactCandidBytes;
  verification: CandidOpt<VerificationStateV1>;
}

export interface FeedPageV1 {
  revision: bigint;
  items: FeedCandidateSummaryV1[];
  next_before_sequence: CandidOpt<bigint>;
}

export type NotificationKindV1 =
  | Readonly<{ new_follower: { follower_revision: bigint } }>
  | Readonly<{
      like: {
        target_post_id: WagyuBytes32;
        target_body_hash: WagyuBytes32;
        action_id: WagyuBytes32;
        object_digest: WagyuBytes32;
        object_length: number;
      };
    }>
  | Readonly<{
      reply: {
        target_post_id: WagyuBytes32;
        target_body_hash: WagyuBytes32;
        action_id: WagyuBytes32;
        object_digest: WagyuBytes32;
        object_length: number;
      };
    }>
  | Readonly<{
      share: {
        target_post_id: WagyuBytes32;
        target_body_hash: WagyuBytes32;
        action_id: WagyuBytes32;
        object_digest: WagyuBytes32;
        object_length: number;
      };
    }>;

export type NotificationVerificationV1 =
  | CandidUnitVariant<"transport_authenticated">
  | CandidUnitVariant<"pending">
  | CandidUnitVariant<"verified">
  | CandidUnitVariant<"invalid">
  | CandidUnitVariant<"unavailable">;

export interface NotificationSummaryV1 {
  local_sequence: bigint;
  received_at_ns: bigint;
  actor: Principal;
  kind: CandidOpt<NotificationKindV1>;
  verification: CandidOpt<NotificationVerificationV1>;
  read: boolean;
}

export interface NotificationPageRequestV1 {
  before_sequence: CandidOpt<bigint>;
  limit: number;
}

export interface NotificationPageV1 {
  revision: bigint;
  items: NotificationSummaryV1[];
  next_before_sequence: CandidOpt<bigint>;
}

export interface NotificationEvidenceRequestV1 {
  local_sequence: bigint;
}

export type NotificationEvidenceKindV1 = Readonly<{
  like: {
    /** Exact stored CertifiedLikeReceiptV1 bytes. */
    certified_like_receipt_candid: WagyuExactCandidBytes;
  };
}>;

export interface NotificationEvidenceV1 {
  local_sequence: bigint;
  found: boolean;
  evidence: CandidOpt<NotificationEvidenceKindV1>;
}

export type SendKindV1 =
  | CandidUnitVariant<"post">
  | CandidUnitVariant<"reply">
  | CandidUnitVariant<"share">
  | CandidUnitVariant<"tombstone">;

export interface SendQuoteRequestV1 {
  send_kind: CandidOpt<SendKindV1>;
  estimated_object_bytes: number;
  notice_target: CandidOpt<Principal>;
}

export interface SendQuoteV1 {
  follower_revision: bigint;
  registered_follower_count: number;
  eligible_delivery_count: number;
  ineligible_follower_count: number;
  /** Authoritative bounded preview from the follower eligibility ledger. */
  eligible_recipient_preview: Principal[];
  receiver_floor_cycles: bigint;
  author_notice_floor_cycles: bigint;
  estimated_call_and_byte_cycles: bigint;
  estimated_local_publication_cycles: bigint;
  estimated_total_cycles: bigint;
}

export interface ProfileEditAvatarV1 {
  media_type: CandidOpt<ProfileAvatarMediaTypeV1>;
  width: number;
  height: number;
  bytes: WagyuBlob;
}

export interface ProfileEditRequestV1 {
  expected_profile_generation: bigint;
  expected_revision: bigint;
  display_name: string;
  description: string;
  avatar: CandidOpt<ProfileEditAvatarV1>;
}

export type ProfileEditRejectionReasonV1 =
  | CandidUnitVariant<"invalid">
  | CandidUnitVariant<"full">
  | CandidUnitVariant<"low_cycles">;

export type ProfileEditOutcomeV1 =
  | Readonly<{
      updated: {
        profile_generation: bigint;
        revision: bigint;
        body_digest: WagyuBytes32;
      };
    }>
  | Readonly<{
      conflict: {
        current_generation: bigint;
        current_revision: bigint;
      };
    }>
  | Readonly<{
      rejected: {
        reason: CandidOpt<ProfileEditRejectionReasonV1>;
      };
    }>;

export interface ProfileEditResultV1 {
  outcome: CandidOpt<ProfileEditOutcomeV1>;
}

export interface ExactDecodedCandidV1<T> {
  /** An owned copy of the exact message supplied to the decoder. */
  exact_bytes: WagyuExactCandidBytes;
  /** SHA-256 over exact_bytes, computed before Candid decoding. */
  object_digest: WagyuBytes32;
  value: T;
}
