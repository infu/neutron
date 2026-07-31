import { IDL } from "@dfinity/candid";
import type { IDL as CandidIDL } from "@dfinity/candid";
import { idlFactory as generatedWagyuOwnerSelfCallIdlFactory } from "../../candid/generated/wagyu-owner-self-calls-v1.did.js";
import { idlFactory as generatedWagyuServiceIdlFactory } from "../../candid/generated/wagyu-v1.did.js";
export type { _SERVICE as WagyuOwnerSelfCallService } from "../../candid/generated/wagyu-owner-self-calls-v1.did.js";

export interface WagyuIdlTypes {
  ActionKindV1: CandidIDL.Type;
  ActionHeaderV1: CandidIDL.Type;
  ReplyLocatorV1: CandidIDL.Type;
  PostBodyV1: CandidIDL.Type;
  ReplyIndexEntryV1: CandidIDL.Type;
  ReplyIndexV1: CandidIDL.Type;
  CertifiedHttpProofV1: CandidIDL.Type;
  CertifiedActionRefV1: CandidIDL.Type;
  CertifiedPostRefV1: CandidIDL.Type;
  ShareActionV1: CandidIDL.Type;
  CertifiedShareRefV1: CandidIDL.Type;
  CertifiedShareDeliveryV1: CandidIDL.Type;
  LikeActionV1: CandidIDL.Type;
  CertifiedLikeReceiptV1: CandidIDL.Type;
  ProfileAvatarMediaTypeV1: CandidIDL.Type;
  ProfileAvatarV1: CandidIDL.Type;
  ProfileV1: CandidIDL.Type;
  TombstoneActionV1: CandidIDL.Type;
  CertifiedTombstoneV1: CandidIDL.Type;
  LikeBatchV1: CandidIDL.Type;
  LikeHeadV1: CandidIDL.Type;
  PublicIngressRequestV1: CandidIDL.Type;
  PublicIngressErrorV1: CandidIDL.Type;
  PublicIngressResultV1: CandidIDL.Type;
  WagyuIngressV1: CandidIDL.Type;
  FollowBodyV1: CandidIDL.Type;
  UnfollowBodyV1: CandidIDL.Type;
  DeliveryEventV1: CandidIDL.Type;
  DeliverBodyV1: CandidIDL.Type;
  LikeBodyV1: CandidIDL.Type;
  NoticeRelationV1: CandidIDL.Type;
  NoticeBodyV1: CandidIDL.Type;
  FollowerStateV1: CandidIDL.Type;
  FollowerHeadV1: CandidIDL.Type;
  RelationshipStateV1: CandidIDL.Type;
  RelationshipSummaryV1: CandidIDL.Type;
  RelationshipsV1: CandidIDL.Type;
  RelationshipPageRequestV1: CandidIDL.Type;
  NodeRequestV1: CandidIDL.Type;
  FollowRequestV1: CandidIDL.Type;
  WagyuRejectionReasonV1: CandidIDL.Type;
  WagyuRouteOutcomeV1: CandidIDL.Type;
  WagyuRouteResultV1: CandidIDL.Type;
  FeedPageRequestV1: CandidIDL.Type;
  FeedEventKindV1: CandidIDL.Type;
  VerificationStateV1: CandidIDL.Type;
  FeedCandidateSummaryV1: CandidIDL.Type;
  FeedPageV1: CandidIDL.Type;
  NotificationKindV1: CandidIDL.Type;
  NotificationVerificationV1: CandidIDL.Type;
  NotificationSummaryV1: CandidIDL.Type;
  NotificationPageRequestV1: CandidIDL.Type;
  NotificationPageV1: CandidIDL.Type;
  NotificationEvidenceRequestV1: CandidIDL.Type;
  NotificationEvidenceKindV1: CandidIDL.Type;
  NotificationEvidenceV1: CandidIDL.Type;
  SendKindV1: CandidIDL.Type;
  SendQuoteRequestV1: CandidIDL.Type;
  SendQuoteV1: CandidIDL.Type;
  ProfileEditAvatarV1: CandidIDL.Type;
  ProfileEditRequestV1: CandidIDL.Type;
  ProfileEditRejectionReasonV1: CandidIDL.Type;
  ProfileEditOutcomeV1: CandidIDL.Type;
  ProfileEditResultV1: CandidIDL.Type;
}

export function createWagyuIdlTypes(
  candid: typeof IDL,
): WagyuIdlTypes {
  const Blob = candid.Vec(candid.Nat8);
  const Unit = candid.Null;

  const ActionKindV1 = candid.Variant({
    post: Unit,
    share: Unit,
    tombstone: Unit,
    like: Unit,
  });
  const ActionHeaderV1 = candid.Record({
    network_id: Blob,
    actor: candid.Principal,
    action_kind: candid.Opt(ActionKindV1),
  });
  const ReplyLocatorV1 = candid.Record({
    author: candid.Principal,
    post_id: Blob,
    body_hash: Blob,
    body_length: candid.Nat32,
    object_digest: Blob,
  });
  const PostBodyV1 = candid.Record({
    header: ActionHeaderV1,
    author_sequence: candid.Nat64,
    nonce: Blob,
    created_at_ns: candid.Nat64,
    body_markdown: candid.Text,
    reply_to: candid.Opt(ReplyLocatorV1),
  });
  const ReplyIndexEntryV1 = candid.Record({
    author: candid.Principal,
    post_id: Blob,
    object_digest: Blob,
    object_length: candid.Nat32,
    received_at_ns: candid.Nat64,
  });
  const ReplyIndexV1 = candid.Record({
    network_id: Blob,
    post_author: candid.Principal,
    post_id: Blob,
    post_body_hash: Blob,
    store_generation: candid.Nat64,
    revision: candid.Nat64,
    previous_index_hash: candid.Opt(Blob),
    replies: candid.Vec(ReplyIndexEntryV1),
  });
  const CertifiedHttpProofV1 = candid.Record({
    certificate_version: candid.Nat8,
    certificate_cbor: Blob,
    witness_cbor: Blob,
    expression_path_cbor: Blob,
    certificate_time_ns: candid.Nat64,
  });
  const CertifiedActionRefV1 = candid.Record({
    actor: candid.Principal,
    action_kind: candid.Opt(ActionKindV1),
    object_digest: Blob,
    body_length: candid.Nat32,
    proof_snapshot: CertifiedHttpProofV1,
  });
  const CertifiedPostRefV1 = candid.Record({
    author: candid.Principal,
    post_id: Blob,
    body_hash: Blob,
    body_length: candid.Nat32,
    object_digest: Blob,
    proof: CertifiedHttpProofV1,
  });
  const ShareActionV1 = candid.Record({
    header: ActionHeaderV1,
    share_id: Blob,
    share_sequence: candid.Nat64,
    issued_at_ns: candid.Nat64,
    original_author: candid.Principal,
    original_post_id: Blob,
    original_body_hash: Blob,
    post_ref_digest: Blob,
  });
  const CertifiedShareRefV1 = candid.Record({
    sharer: candid.Principal,
    share_id: Blob,
    body_length: candid.Nat32,
    object_digest: Blob,
    proof: CertifiedHttpProofV1,
  });
  const CertifiedShareDeliveryV1 = candid.Record({
    original_post_ref_candid: Blob,
    share_action_candid: Blob,
    share_ref: CertifiedShareRefV1,
  });
  const LikeActionV1 = candid.Record({
    header: ActionHeaderV1,
    like_id: Blob,
    issued_at_ns: candid.Nat64,
    post_author: candid.Principal,
    post_id: Blob,
    post_body_hash: Blob,
  });
  const CertifiedLikeReceiptV1 = candid.Record({
    like_action_candid: Blob,
    ref: CertifiedActionRefV1,
  });
  const ProfileAvatarMediaTypeV1 = candid.Variant({
    jpeg: Unit,
    png: Unit,
    webp: Unit,
  });
  const ProfileAvatarV1 = candid.Record({
    media_type: candid.Opt(ProfileAvatarMediaTypeV1),
    width: candid.Nat16,
    height: candid.Nat16,
    bytes: Blob,
  });
  const ProfileV1 = candid.Record({
    network_id: Blob,
    node: candid.Principal,
    profile_generation: candid.Nat64,
    revision: candid.Nat64,
    updated_at_ns: candid.Nat64,
    previous_profile_digest: candid.Opt(Blob),
    display_name: candid.Text,
    description: candid.Text,
    capabilities: candid.Opt(candid.Vec(candid.Text)),
    avatar: candid.Opt(ProfileAvatarV1),
  });
  const TombstoneActionV1 = candid.Record({
    header: ActionHeaderV1,
    tombstone_id: Blob,
    author_sequence: candid.Nat64,
    issued_at_ns: candid.Nat64,
    post_id: Blob,
    post_body_hash: Blob,
  });
  const CertifiedTombstoneV1 = candid.Record({
    tombstone_action_candid: Blob,
    ref: CertifiedActionRefV1,
  });
  const LikeBatchV1 = candid.Record({
    network_id: Blob,
    post_author: candid.Principal,
    post_id: Blob,
    post_body_hash: Blob,
    batch_number: candid.Nat64,
    previous_batch_digest: candid.Opt(Blob),
    first_accepted_sequence: candid.Nat64,
    last_accepted_sequence: candid.Nat64,
    final_partial: candid.Bool,
    receipts: candid.Vec(CertifiedLikeReceiptV1),
  });
  const LikeHeadV1 = candid.Record({
    network_id: Blob,
    post_author: candid.Principal,
    post_id: Blob,
    post_body_hash: Blob,
    store_generation: candid.Nat64,
    revision: candid.Nat64,
    previous_head_hash: candid.Opt(Blob),
    latest_batch_number: candid.Opt(candid.Nat64),
    latest_batch_digest: candid.Opt(Blob),
    sealed_batch_count: candid.Nat64,
    sealed_receipt_count: candid.Nat64,
    accepting_likes: candid.Bool,
  });
  const PublicIngressRequestV1 = candid.Record({
    method: candid.Text,
    payload: Blob,
  });
  const PublicIngressErrorV1 = candid.Variant({
    bad_request: Unit,
    not_found: Unit,
    too_large: Unit,
    unauthorized: Unit,
    rate_limited: Unit,
    busy: Unit,
    low_cycles: Unit,
    revoked: Unit,
    revoked_after_dispatch: Unit,
    handler_failed: Unit,
  });
  const PublicIngressResultV1 = candid.Variant({
    ok: Blob,
    err: PublicIngressErrorV1,
  });
  const WagyuIngressV1 = candid.Record({
    operation_id: Blob,
    body_candid: Blob,
  });
  const FollowBodyV1 = candid.Record({
    expected_revision: candid.Nat64,
    subscription_id: Blob,
  });
  const UnfollowBodyV1 = candid.Record({
    expected_revision: candid.Nat64,
    subscription_id: Blob,
  });
  const DeliveryEventV1 = candid.Variant({
    original: Blob,
    share: Blob,
    tombstone: Blob,
  });
  const DeliverBodyV1 = candid.Record({
    subscription_id: Blob,
    renewal_requested: candid.Bool,
    event: candid.Opt(DeliveryEventV1),
  });
  const LikeBodyV1 = candid.Record({
    certified_like_receipt_candid: Blob,
  });
  const NoticeRelationV1 = candid.Variant({
    reply: Unit,
    share: Unit,
  });
  const NoticeBodyV1 = candid.Record({
    relation: candid.Opt(NoticeRelationV1),
    target_post_id: Blob,
    target_body_hash: Blob,
    actor_action_id: Blob,
    actor_object_digest: Blob,
    actor_object_length: candid.Nat32,
  });
  const FollowerStateV1 = candid.Variant({
    active: candid.Record({
      subscription_id: Blob,
      lease_expires_ns: candid.Nat64,
      delivery_credits: candid.Nat16,
    }),
    inactive: candid.Record({
      last_subscription_id: Blob,
    }),
  });
  const FollowerHeadV1 = candid.Record({
    revision: candid.Nat64,
    state: candid.Opt(FollowerStateV1),
  });
  const RelationshipStateV1 = candid.Variant({
    registering: Unit,
    active: Unit,
    credit_low: Unit,
    expired: Unit,
    cleanup_pending: Unit,
    incompatible: Unit,
    blocked: Unit,
  });
  const RelationshipSummaryV1 = candid.Record({
    node: candid.Principal,
    following: candid.Bool,
    follower: candid.Bool,
    following_state: candid.Opt(RelationshipStateV1),
    follower_state: candid.Opt(RelationshipStateV1),
    follower_delivery_credits: candid.Nat16,
    follower_lease_expires_ns: candid.Opt(candid.Nat64),
    following_renewal_requested: candid.Bool,
    following_auto_renew_due: candid.Bool,
    blocked: candid.Bool,
    bond_cycles: candid.Nat,
    protocol: candid.Text,
    compatible: candid.Bool,
  });
  const RelationshipsV1 = candid.Record({
    revision: candid.Nat64,
    items: candid.Vec(RelationshipSummaryV1),
    next_before_node: candid.Opt(candid.Principal),
  });
  const RelationshipPageRequestV1 = candid.Record({
    before_node: candid.Opt(candid.Principal),
    expected_revision: candid.Opt(candid.Nat64),
    limit: candid.Nat16,
  });
  const NodeRequestV1 = candid.Record({
    node: candid.Principal,
  });
  const FollowRequestV1 = candid.Record({
    node: candid.Principal,
    subscription_id: Blob,
  });
  const WagyuRejectionReasonV1 = candid.Variant({
    invalid: Unit,
    blocked: Unit,
    not_following: Unit,
    unknown_post: Unit,
    expired: Unit,
    full: Unit,
    conflict: Unit,
    incompatible: Unit,
  });
  const WagyuRouteOutcomeV1 = candid.Variant({
    accepted: Unit,
    duplicate: Unit,
    rejected: candid.Record({
      reason: candid.Opt(WagyuRejectionReasonV1),
    }),
  });
  const WagyuRouteResultV1 = candid.Record({
    outcome: candid.Opt(WagyuRouteOutcomeV1),
    local_receipt_time_ns: candid.Opt(candid.Nat64),
    revision: candid.Opt(candid.Nat64),
    relationship: candid.Opt(FollowerHeadV1),
  });
  const FeedPageRequestV1 = candid.Record({
    before_sequence: candid.Opt(candid.Nat64),
    limit: candid.Nat16,
  });
  const FeedEventKindV1 = candid.Variant({
    original: Unit,
    share: Unit,
    tombstone: Unit,
  });
  const VerificationStateV1 = candid.Variant({
    pending: Unit,
    verified: Unit,
    invalid: Unit,
    unavailable: Unit,
  });
  const FeedCandidateSummaryV1 = candid.Record({
    candidate_id: Blob,
    local_sequence: candid.Nat64,
    received_at_ns: candid.Nat64,
    immediate_sender: candid.Principal,
    event_kind: candid.Opt(FeedEventKindV1),
    claimed_author: candid.Principal,
    claimed_post_id: Blob,
    exact_event_candid: Blob,
    verification: candid.Opt(VerificationStateV1),
  });
  const FeedPageV1 = candid.Record({
    revision: candid.Nat64,
    items: candid.Vec(FeedCandidateSummaryV1),
    next_before_sequence: candid.Opt(candid.Nat64),
  });
  const DirectedActionSummaryV1 = candid.Record({
    target_post_id: Blob,
    target_body_hash: Blob,
    action_id: Blob,
    object_digest: Blob,
    object_length: candid.Nat32,
  });
  const NotificationKindV1 = candid.Variant({
    new_follower: candid.Record({
      follower_revision: candid.Nat64,
    }),
    like: DirectedActionSummaryV1,
    reply: DirectedActionSummaryV1,
    share: DirectedActionSummaryV1,
  });
  const NotificationVerificationV1 = candid.Variant({
    transport_authenticated: Unit,
    pending: Unit,
    verified: Unit,
    invalid: Unit,
    unavailable: Unit,
  });
  const NotificationSummaryV1 = candid.Record({
    local_sequence: candid.Nat64,
    received_at_ns: candid.Nat64,
    actor: candid.Principal,
    kind: candid.Opt(NotificationKindV1),
    verification: candid.Opt(NotificationVerificationV1),
    read: candid.Bool,
  });
  const NotificationPageRequestV1 = candid.Record({
    before_sequence: candid.Opt(candid.Nat64),
    limit: candid.Nat16,
  });
  const NotificationPageV1 = candid.Record({
    revision: candid.Nat64,
    items: candid.Vec(NotificationSummaryV1),
    next_before_sequence: candid.Opt(candid.Nat64),
  });
  const NotificationEvidenceRequestV1 = candid.Record({
    local_sequence: candid.Nat64,
  });
  const NotificationEvidenceKindV1 = candid.Variant({
    like: candid.Record({
      certified_like_receipt_candid: Blob,
    }),
  });
  const NotificationEvidenceV1 = candid.Record({
    local_sequence: candid.Nat64,
    found: candid.Bool,
    evidence: candid.Opt(NotificationEvidenceKindV1),
  });
  const SendKindV1 = candid.Variant({
    post: Unit,
    reply: Unit,
    share: Unit,
    tombstone: Unit,
  });
  const SendQuoteRequestV1 = candid.Record({
    send_kind: candid.Opt(SendKindV1),
    estimated_object_bytes: candid.Nat32,
    notice_target: candid.Opt(candid.Principal),
  });
  const SendQuoteV1 = candid.Record({
    follower_revision: candid.Nat64,
    registered_follower_count: candid.Nat32,
    eligible_delivery_count: candid.Nat32,
    ineligible_follower_count: candid.Nat32,
    eligible_recipient_preview: candid.Vec(candid.Principal),
    receiver_floor_cycles: candid.Nat,
    author_notice_floor_cycles: candid.Nat,
    estimated_call_and_byte_cycles: candid.Nat,
    estimated_local_publication_cycles: candid.Nat,
    estimated_total_cycles: candid.Nat,
  });
  const ProfileEditAvatarV1 = candid.Record({
    media_type: candid.Opt(ProfileAvatarMediaTypeV1),
    width: candid.Nat16,
    height: candid.Nat16,
    bytes: Blob,
  });
  const ProfileEditRequestV1 = candid.Record({
    expected_profile_generation: candid.Nat64,
    expected_revision: candid.Nat64,
    display_name: candid.Text,
    description: candid.Text,
    avatar: candid.Opt(ProfileEditAvatarV1),
  });
  const ProfileEditRejectionReasonV1 = candid.Variant({
    invalid: Unit,
    full: Unit,
    low_cycles: Unit,
  });
  const ProfileEditOutcomeV1 = candid.Variant({
    updated: candid.Record({
      profile_generation: candid.Nat64,
      revision: candid.Nat64,
      body_digest: Blob,
    }),
    conflict: candid.Record({
      current_generation: candid.Nat64,
      current_revision: candid.Nat64,
    }),
    rejected: candid.Record({
      reason: candid.Opt(ProfileEditRejectionReasonV1),
    }),
  });
  const ProfileEditResultV1 = candid.Record({
    outcome: candid.Opt(ProfileEditOutcomeV1),
  });

  return {
    ActionKindV1,
    ActionHeaderV1,
    ReplyLocatorV1,
    PostBodyV1,
    ReplyIndexEntryV1,
    ReplyIndexV1,
    CertifiedHttpProofV1,
    CertifiedActionRefV1,
    CertifiedPostRefV1,
    ShareActionV1,
    CertifiedShareRefV1,
    CertifiedShareDeliveryV1,
    LikeActionV1,
    CertifiedLikeReceiptV1,
    ProfileAvatarMediaTypeV1,
    ProfileAvatarV1,
    ProfileV1,
    TombstoneActionV1,
    CertifiedTombstoneV1,
    LikeBatchV1,
    LikeHeadV1,
    PublicIngressRequestV1,
    PublicIngressErrorV1,
    PublicIngressResultV1,
    WagyuIngressV1,
    FollowBodyV1,
    UnfollowBodyV1,
    DeliveryEventV1,
    DeliverBodyV1,
    LikeBodyV1,
    NoticeRelationV1,
    NoticeBodyV1,
    FollowerStateV1,
    FollowerHeadV1,
    RelationshipStateV1,
    RelationshipSummaryV1,
    RelationshipsV1,
    RelationshipPageRequestV1,
    NodeRequestV1,
    FollowRequestV1,
    WagyuRejectionReasonV1,
    WagyuRouteOutcomeV1,
    WagyuRouteResultV1,
    FeedPageRequestV1,
    FeedEventKindV1,
    VerificationStateV1,
    FeedCandidateSummaryV1,
    FeedPageV1,
    NotificationKindV1,
    NotificationVerificationV1,
    NotificationSummaryV1,
    NotificationPageRequestV1,
    NotificationPageV1,
    NotificationEvidenceRequestV1,
    NotificationEvidenceKindV1,
    NotificationEvidenceV1,
    SendKindV1,
    SendQuoteRequestV1,
    SendQuoteV1,
    ProfileEditAvatarV1,
    ProfileEditRequestV1,
    ProfileEditRejectionReasonV1,
    ProfileEditOutcomeV1,
    ProfileEditResultV1,
  };
}

export const WAGYU_IDL = Object.freeze(createWagyuIdlTypes(IDL));

/**
 * Generated directly from candid/wagyu-v1.did by didc. Keeping the service
 * factory generated makes the checked DID the single source of truth for the
 * actor ABI; createWagyuIdlTypes remains the stricter codec registry.
 */
export const wagyuServiceIdlFactory = generatedWagyuServiceIdlFactory;

/**
 * Generated API-1 owner-call surface. The owner bridge itself uses the
 * kernel's querySelf/updateSelf transport; this factory is the exact Candid
 * contract used for ABI review and structural parity tests.
 */
export const wagyuOwnerSelfCallIdlFactory =
  generatedWagyuOwnerSelfCallIdlFactory;

/** Conventional @dfinity/agent generated-binding export name. */
export const idlFactory = wagyuServiceIdlFactory;
