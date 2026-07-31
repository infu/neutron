import type { Principal } from '@dfinity/principal';
import type { ActorMethod } from '@dfinity/agent';
import type { IDL } from '@dfinity/candid';

export type AvatarMediaTypeV1 = { 'png' : null } |
  { 'jpeg' : null } |
  { 'webp' : null };
export interface BlockStatusSelfV1 { 'blocked' : boolean, 'node' : Principal }
export interface BlockStatusesSelfOutputV1 {
  'relationship_revision' : bigint,
  'items' : Array<BlockStatusSelfV1>,
}
export interface BlockStatusesSelfRequestV1 { 'nodes' : Array<Principal> }
export interface FeedPageSelfOutputV1 {
  'value' : FeedPageSelfValueV1,
  'body' : Uint8Array | number[],
}
export interface FeedPageSelfRequestV1 {
  'limit' : number,
  'before_sequence' : [] | [bigint],
}
export interface FeedPageSelfValueV1 {
  'body_digest_hex' : string,
  'body_bytes' : number,
  'revision' : bigint,
  'item_count' : number,
}
export interface FeedPromoteSelfRequestV1 {
  'verified_author' : Principal,
  'verified_body_hash_hex' : string,
  'verified_post_id_hex' : string,
  'verified_object_digest_hex' : string,
  'candidate_id_hex' : string,
}
export type FeedRejectDispositionV1 = { 'invalid' : null } |
  { 'unavailable' : null };
export interface FeedRejectSelfRequestV1 {
  'disposition' : [] | [FeedRejectDispositionV1],
  'candidate_id_hex' : string,
}
export interface FinalizeSelfRequestV1 {
  'object_digest_hex' : string,
  'action_id_hex' : string,
  'exact_proof_candid' : Uint8Array | number[],
}
export interface FollowSelfRequestV1 {
  'node' : Principal,
  'subscription_id_hex' : string,
}
export interface LikePrepareSelfRequestV1 {
  'nonce_hex' : string,
  'post_author' : Principal,
  'post_id_hex' : string,
  'post_object_digest_hex' : [] | [string],
  'post_body_hash_hex' : string,
}
export interface LikeSealSelfRequestV1 {
  'final_partial' : boolean,
  'post_id_hex' : string,
}
export type LocalErrorV1 = { 'not_configured' : null } |
  { 'conflict' : null } |
  { 'invalid' : null } |
  { 'busy' : null } |
  { 'full' : null } |
  { 'not_found' : null } |
  { 'proof_invalid' : null } |
  { 'certified_store' : null } |
  { 'unsupported' : null };
export type Nat64LocalResultV1 = { 'ok' : bigint } |
  { 'err' : LocalErrorV1 };
export interface NodeRequestV1 { 'node' : Principal }
export type NotificationDispositionSelfV1 = { 'verified' : null } |
  { 'invalid' : null } |
  { 'unavailable' : null };
export interface NotificationEvidenceSelfOutputV1 {
  'value' : NotificationEvidenceSelfValueV1,
  'body' : Uint8Array | number[],
}
export interface NotificationEvidenceSelfRequestV1 { 'local_sequence' : bigint }
export interface NotificationEvidenceSelfValueV1 {
  'found' : boolean,
  'body_digest_hex' : string,
  'body_bytes' : number,
  'local_sequence' : bigint,
}
export interface NotificationPageSelfOutputV1 {
  'value' : NotificationPageSelfValueV1,
  'body' : Uint8Array | number[],
}
export interface NotificationPageSelfRequestV1 {
  'limit' : number,
  'before_sequence' : [] | [bigint],
}
export interface NotificationPageSelfValueV1 {
  'body_digest_hex' : string,
  'body_bytes' : number,
  'revision' : bigint,
  'item_count' : number,
}
export interface NotificationPromoteSelfRequestV1 {
  'verified_reply' : [] | [VerifiedReplySelfV1],
  'disposition' : [] | [NotificationDispositionSelfV1],
  'local_sequence' : bigint,
}
export interface PostPrepareSelfRequestV1 {
  'reply_to' : [] | [ReplyLocatorSelfV1],
  'body_markdown' : string,
  'nonce_hex' : string,
}
export interface ProfileEditAvatarV1 {
  'height' : number,
  'media_type' : [] | [AvatarMediaTypeV1],
  'bytes' : Uint8Array | number[],
  'width' : number,
}
export type ProfileEditOutcomeV1 = {
    'conflict' : { 'current_revision' : bigint, 'current_generation' : bigint }
  } |
  {
    'updated' : {
      'body_digest' : Uint8Array | number[],
      'profile_generation' : bigint,
      'revision' : bigint,
    }
  } |
  { 'rejected' : { 'reason' : [] | [ProfileEditRejectionReasonV1] } };
export type ProfileEditRejectionReasonV1 = { 'low_cycles' : null } |
  { 'invalid' : null } |
  { 'full' : null };
export interface ProfileEditRequestV1 {
  'expected_profile_generation' : bigint,
  'description' : string,
  'display_name' : string,
  'expected_revision' : bigint,
  'avatar' : [] | [ProfileEditAvatarV1],
}
export interface ProfileEditResultV1 { 'outcome' : [] | [ProfileEditOutcomeV1] }
export type PublishSelfLocalResultV1 = { 'ok' : PublishSelfResultV1 } |
  { 'err' : LocalErrorV1 };
export interface PublishSelfResultV1 {
  'queued_recipient_count' : number,
  'object_digest_hex' : [] | [string],
  'action_id_hex' : [] | [string],
  'stage' : [] | [PublishStageV1],
  'accepted_recipient_count' : number,
  'message' : string,
  'queued_notice_count' : number,
  'post_id_hex' : [] | [string],
  'failed_recipient_count' : number,
}
export type PublishStageV1 = { 'fanout_queued' : null } |
  { 'uncertain' : null } |
  { 'complete' : null } |
  { 'certified_ref_ready' : null } |
  { 'awaiting_proof' : null } |
  { 'failed' : null } |
  { 'partial' : null };
export type RelationshipStateV1 = { 'active' : null } |
  { 'registering' : null } |
  { 'cleanup_pending' : null } |
  { 'credit_low' : null } |
  { 'expired' : null } |
  { 'blocked' : null } |
  { 'incompatible' : null };
export type RelationshipSummaryLocalResultV1 = {
    'ok' : RelationshipSummaryV1
  } |
  { 'err' : LocalErrorV1 };
export interface RelationshipSummaryV1 {
  'protocol' : string,
  'following_auto_renew_due' : boolean,
  'follower_delivery_credits' : number,
  'compatible' : boolean,
  'blocked' : boolean,
  'node' : Principal,
  'follower' : boolean,
  'following_state' : [] | [RelationshipStateV1],
  'following_renewal_requested' : boolean,
  'follower_lease_expires_ns' : [] | [bigint],
  'bond_cycles' : bigint,
  'following' : boolean,
  'follower_state' : [] | [RelationshipStateV1],
}
export interface ReplyLocatorSelfV1 {
  'object_digest_hex' : string,
  'body_length' : number,
  'author' : Principal,
  'post_id_hex' : string,
  'body_hash_hex' : string,
}
export interface SharePrepareSelfRequestV1 {
  'nonce_hex' : [] | [string],
  'exact_original_post_ref_candid' : Uint8Array | number[],
}
export interface TombstonePrepareSelfRequestV1 {
  'nonce_hex' : string,
  'post_id_hex' : string,
}
export interface VerifiedReplySelfV1 {
  'reply_to' : ReplyLocatorSelfV1,
  'object_digest_hex' : string,
  'body_length' : number,
  'author' : Principal,
  'post_id_hex' : string,
  'body_hash_hex' : string,
}
export interface WithdrawalAdvanceSelfRequestV1 {
  'nonce_hex' : string,
  'post_id_hex' : string,
}
export interface _SERVICE {
  'wagyu_auto_renew_self_v1' : ActorMethod<
    [NodeRequestV1],
    RelationshipSummaryLocalResultV1
  >,
  'wagyu_block_statuses_self_v1' : ActorMethod<
    [BlockStatusesSelfRequestV1],
    BlockStatusesSelfOutputV1
  >,
  'wagyu_feed_page_self_v1' : ActorMethod<
    [FeedPageSelfRequestV1],
    FeedPageSelfOutputV1
  >,
  'wagyu_feed_promote_self_v1' : ActorMethod<
    [FeedPromoteSelfRequestV1],
    Nat64LocalResultV1
  >,
  'wagyu_feed_reject_self_v1' : ActorMethod<
    [FeedRejectSelfRequestV1],
    Nat64LocalResultV1
  >,
  'wagyu_follow_self_v1' : ActorMethod<
    [FollowSelfRequestV1],
    RelationshipSummaryLocalResultV1
  >,
  'wagyu_like_finalize_self_v1' : ActorMethod<
    [FinalizeSelfRequestV1],
    PublishSelfLocalResultV1
  >,
  'wagyu_like_prepare_self_v1' : ActorMethod<
    [LikePrepareSelfRequestV1],
    PublishSelfLocalResultV1
  >,
  'wagyu_like_seal_self_v1' : ActorMethod<
    [LikeSealSelfRequestV1],
    PublishSelfLocalResultV1
  >,
  'wagyu_notification_evidence_self_v1' : ActorMethod<
    [NotificationEvidenceSelfRequestV1],
    NotificationEvidenceSelfOutputV1
  >,
  'wagyu_notification_page_self_v1' : ActorMethod<
    [NotificationPageSelfRequestV1],
    NotificationPageSelfOutputV1
  >,
  'wagyu_notification_promote_self_v1' : ActorMethod<
    [NotificationPromoteSelfRequestV1],
    Nat64LocalResultV1
  >,
  'wagyu_post_finalize_self_v1' : ActorMethod<
    [FinalizeSelfRequestV1],
    PublishSelfLocalResultV1
  >,
  'wagyu_post_prepare_self_v1' : ActorMethod<
    [PostPrepareSelfRequestV1],
    PublishSelfLocalResultV1
  >,
  'wagyu_profile_edit_v1' : ActorMethod<
    [ProfileEditRequestV1],
    ProfileEditResultV1
  >,
  'wagyu_share_finalize_self_v1' : ActorMethod<
    [FinalizeSelfRequestV1],
    PublishSelfLocalResultV1
  >,
  'wagyu_share_prepare_self_v1' : ActorMethod<
    [SharePrepareSelfRequestV1],
    PublishSelfLocalResultV1
  >,
  'wagyu_tombstone_finalize_self_v1' : ActorMethod<
    [FinalizeSelfRequestV1],
    PublishSelfLocalResultV1
  >,
  'wagyu_tombstone_prepare_self_v1' : ActorMethod<
    [TombstonePrepareSelfRequestV1],
    PublishSelfLocalResultV1
  >,
  'wagyu_withdrawal_advance_self_v1' : ActorMethod<
    [WithdrawalAdvanceSelfRequestV1],
    PublishSelfLocalResultV1
  >,
}
export declare const idlFactory: IDL.InterfaceFactory;
export declare const init: (args: { IDL: typeof IDL }) => IDL.Type[];
