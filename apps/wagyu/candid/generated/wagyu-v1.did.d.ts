import type { Principal } from '@dfinity/principal';
import type { ActorMethod } from '@dfinity/agent';
import type { IDL } from '@dfinity/candid';

export interface ActionHeaderV1 {
  'actor' : Principal,
  'action_kind' : [] | [ActionKindV1],
  'network_id' : Blob32,
}
export type ActionKindV1 = { 'like' : null } |
  { 'post' : null } |
  { 'share' : null } |
  { 'tombstone' : null };
export type Blob16 = Uint8Array | number[];
export type Blob32 = Uint8Array | number[];
export interface CertifiedActionRefV1 {
  'actor' : Principal,
  'body_length' : number,
  'action_kind' : [] | [ActionKindV1],
  'object_digest' : Blob32,
  'proof_snapshot' : CertifiedHttpProofV1,
}
export interface CertifiedHttpProofV1 {
  'expression_path_cbor' : Uint8Array | number[],
  'witness_cbor' : Uint8Array | number[],
  'certificate_version' : number,
  'certificate_cbor' : Uint8Array | number[],
  'certificate_time_ns' : bigint,
}
export interface CertifiedLikeReceiptV1 {
  'ref' : CertifiedActionRefV1,
  'like_action_candid' : Uint8Array | number[],
}
export interface CertifiedPostRefV1 {
  'post_id' : Blob32,
  'body_hash' : Blob32,
  'body_length' : number,
  'object_digest' : Blob32,
  'author' : Principal,
  'proof' : CertifiedHttpProofV1,
}
export interface CertifiedShareDeliveryV1 {
  'share_action_candid' : Uint8Array | number[],
  'original_post_ref_candid' : Uint8Array | number[],
  'share_ref' : CertifiedShareRefV1,
}
export interface CertifiedShareRefV1 {
  'sharer' : Principal,
  'body_length' : number,
  'object_digest' : Blob32,
  'share_id' : Blob32,
  'proof' : CertifiedHttpProofV1,
}
export interface CertifiedTombstoneV1 {
  'ref' : CertifiedActionRefV1,
  'tombstone_action_candid' : Uint8Array | number[],
}
export interface DeliverBodyV1 {
  'subscription_id' : Blob16,
  'event' : [] | [DeliveryEventV1],
  'renewal_requested' : boolean,
}
export type DeliveryEventV1 = { 'share' : Uint8Array | number[] } |
  { 'tombstone' : Uint8Array | number[] } |
  { 'original' : Uint8Array | number[] };
export interface DirectedActionSummaryV1 {
  'action_id' : Blob32,
  'object_length' : number,
  'object_digest' : Blob32,
  'target_body_hash' : Blob32,
  'target_post_id' : Blob32,
}
export interface FeedCandidateSummaryV1 {
  'received_at_ns' : bigint,
  'claimed_post_id' : Blob32,
  'exact_event_candid' : Uint8Array | number[],
  'claimed_author' : Principal,
  'candidate_id' : Blob32,
  'verification' : [] | [VerificationStateV1],
  'event_kind' : [] | [FeedEventKindV1],
  'local_sequence' : bigint,
  'immediate_sender' : Principal,
}
export type FeedEventKindV1 = { 'share' : null } |
  { 'tombstone' : null } |
  { 'original' : null };
export interface FeedPageRequestV1 {
  'limit' : number,
  'before_sequence' : [] | [bigint],
}
export interface FeedPageV1 {
  'next_before_sequence' : [] | [bigint],
  'items' : Array<FeedCandidateSummaryV1>,
  'revision' : bigint,
}
export interface FollowBodyV1 {
  'subscription_id' : Blob16,
  'expected_revision' : bigint,
}
export interface FollowerHeadV1 {
  'state' : [] | [FollowerStateV1],
  'revision' : bigint,
}
export type FollowerStateV1 = {
    'active' : {
      'delivery_credits' : number,
      'subscription_id' : Blob16,
      'lease_expires_ns' : bigint,
    }
  } |
  { 'inactive' : { 'last_subscription_id' : Blob16 } };
export interface LikeActionV1 {
  'post_id' : Blob32,
  'post_author' : Principal,
  'like_id' : Blob32,
  'issued_at_ns' : bigint,
  'post_body_hash' : Blob32,
  'header' : ActionHeaderV1,
}
export interface LikeBatchV1 {
  'batch_number' : bigint,
  'post_id' : Blob32,
  'final_partial' : boolean,
  'last_accepted_sequence' : bigint,
  'post_author' : Principal,
  'previous_batch_digest' : [] | [Blob32],
  'network_id' : Blob32,
  'post_body_hash' : Blob32,
  'first_accepted_sequence' : bigint,
  'receipts' : Array<CertifiedLikeReceiptV1>,
}
export interface LikeBodyV1 {
  'certified_like_receipt_candid' : Uint8Array | number[],
}
export interface LikeHeadV1 {
  'latest_batch_number' : [] | [bigint],
  'post_id' : Blob32,
  'latest_batch_digest' : [] | [Blob32],
  'post_author' : Principal,
  'network_id' : Blob32,
  'accepting_likes' : boolean,
  'store_generation' : bigint,
  'sealed_receipt_count' : bigint,
  'sealed_batch_count' : bigint,
  'revision' : bigint,
  'post_body_hash' : Blob32,
  'previous_head_hash' : [] | [Blob32],
}
export interface NoticeBodyV1 {
  'relation' : [] | [NoticeRelationV1],
  'target_body_hash' : Blob32,
  'actor_object_length' : number,
  'target_post_id' : Blob32,
  'actor_object_digest' : Blob32,
  'actor_action_id' : Blob32,
}
export type NoticeRelationV1 = { 'share' : null } |
  { 'reply' : null };
export type NotificationEvidenceKindV1 = {
    'like' : { 'certified_like_receipt_candid' : Uint8Array | number[] }
  };
export interface NotificationEvidenceRequestV1 { 'local_sequence' : bigint }
export interface NotificationEvidenceV1 {
  'found' : boolean,
  'evidence' : [] | [NotificationEvidenceKindV1],
  'local_sequence' : bigint,
}
export type NotificationKindV1 = {
    'new_follower' : { 'follower_revision' : bigint }
  } |
  { 'like' : DirectedActionSummaryV1 } |
  { 'share' : DirectedActionSummaryV1 } |
  { 'reply' : DirectedActionSummaryV1 };
export interface NotificationPageRequestV1 {
  'limit' : number,
  'before_sequence' : [] | [bigint],
}
export interface NotificationPageV1 {
  'next_before_sequence' : [] | [bigint],
  'items' : Array<NotificationSummaryV1>,
  'revision' : bigint,
}
export interface NotificationSummaryV1 {
  'actor' : Principal,
  'kind' : [] | [NotificationKindV1],
  'read' : boolean,
  'received_at_ns' : bigint,
  'verification' : [] | [NotificationVerificationV1],
  'local_sequence' : bigint,
}
export type NotificationVerificationV1 = { 'verified' : null } |
  { 'pending' : null } |
  { 'invalid' : null } |
  { 'transport_authenticated' : null } |
  { 'unavailable' : null };
export interface PostBodyV1 {
  'reply_to' : [] | [ReplyLocatorV1],
  'body_markdown' : string,
  'author_sequence' : bigint,
  'created_at_ns' : bigint,
  'nonce' : Blob16,
  'header' : ActionHeaderV1,
}
export type ProfileAvatarMediaTypeV1 = { 'png' : null } |
  { 'jpeg' : null } |
  { 'webp' : null };
export interface ProfileAvatarV1 {
  'height' : number,
  'media_type' : [] | [ProfileAvatarMediaTypeV1],
  'bytes' : Uint8Array | number[],
  'width' : number,
}
export interface ProfileEditAvatarV1 {
  'height' : number,
  'media_type' : [] | [ProfileAvatarMediaTypeV1],
  'bytes' : Uint8Array | number[],
  'width' : number,
}
export type ProfileEditOutcomeV1 = {
    'conflict' : { 'current_revision' : bigint, 'current_generation' : bigint }
  } |
  {
    'updated' : {
      'body_digest' : Blob32,
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
export interface ProfileV1 {
  'capabilities' : [] | [Array<string>],
  'node' : Principal,
  'description' : string,
  'updated_at_ns' : bigint,
  'network_id' : Blob32,
  'profile_generation' : bigint,
  'display_name' : string,
  'previous_profile_digest' : [] | [Blob32],
  'revision' : bigint,
  'avatar' : [] | [ProfileAvatarV1],
}
export type PublicIngressErrorV1 = { 'revoked_after_dispatch' : null } |
  { 'bad_request' : null } |
  { 'low_cycles' : null } |
  { 'revoked' : null } |
  { 'rate_limited' : null } |
  { 'busy' : null } |
  { 'handler_failed' : null } |
  { 'not_found' : null } |
  { 'unauthorized' : null } |
  { 'too_large' : null };
export interface PublicIngressRequestV1 {
  'method' : string,
  'payload' : Uint8Array | number[],
}
export type PublicIngressResultV1 = { 'ok' : Uint8Array | number[] } |
  { 'err' : PublicIngressErrorV1 };
export interface ReplyLocatorV1 {
  'post_id' : Blob32,
  'body_hash' : Blob32,
  'body_length' : number,
  'object_digest' : Blob32,
  'author' : Principal,
}
export type SendKindV1 = { 'post' : null } |
  { 'share' : null } |
  { 'tombstone' : null } |
  { 'reply' : null };
export interface SendQuoteRequestV1 {
  'send_kind' : [] | [SendKindV1],
  'estimated_object_bytes' : number,
  'notice_target' : [] | [Principal],
}
export interface SendQuoteV1 {
  'author_notice_floor_cycles' : bigint,
  'receiver_floor_cycles' : bigint,
  'ineligible_follower_count' : number,
  'eligible_delivery_count' : number,
  'estimated_call_and_byte_cycles' : bigint,
  'estimated_local_publication_cycles' : bigint,
  'eligible_recipient_preview' : Array<Principal>,
  'follower_revision' : bigint,
  'registered_follower_count' : number,
  'estimated_total_cycles' : bigint,
}
export interface ShareActionV1 {
  'original_post_id' : Blob32,
  'share_sequence' : bigint,
  'share_id' : Blob32,
  'post_ref_digest' : Blob32,
  'original_body_hash' : Blob32,
  'issued_at_ns' : bigint,
  'original_author' : Principal,
  'header' : ActionHeaderV1,
}
export interface TombstoneActionV1 {
  'post_id' : Blob32,
  'author_sequence' : bigint,
  'issued_at_ns' : bigint,
  'tombstone_id' : Blob32,
  'post_body_hash' : Blob32,
  'header' : ActionHeaderV1,
}
export interface UnfollowBodyV1 {
  'subscription_id' : Blob16,
  'expected_revision' : bigint,
}
export type VerificationStateV1 = { 'verified' : null } |
  { 'pending' : null } |
  { 'invalid' : null } |
  { 'unavailable' : null };
export interface WagyuIngressV1 {
  'body_candid' : Uint8Array | number[],
  'operation_id' : Blob16,
}
export type WagyuRejectionReasonV1 = { 'not_following' : null } |
  { 'conflict' : null } |
  { 'expired' : null } |
  { 'invalid' : null } |
  { 'full' : null } |
  { 'blocked' : null } |
  { 'unknown_post' : null } |
  { 'incompatible' : null };
export type WagyuRouteOutcomeV1 = { 'duplicate' : null } |
  { 'rejected' : { 'reason' : [] | [WagyuRejectionReasonV1] } } |
  { 'accepted' : null };
export interface WagyuRouteResultV1 {
  'local_receipt_time_ns' : [] | [bigint],
  'relationship' : [] | [FollowerHeadV1],
  'revision' : [] | [bigint],
  'outcome' : [] | [WagyuRouteOutcomeV1],
}
export interface _SERVICE {
  'app_wagyu__wagyu_v1_update' : ActorMethod<
    [PublicIngressRequestV1],
    PublicIngressResultV1
  >,
  'wagyu_get_feed_page_v1' : ActorMethod<[FeedPageRequestV1], FeedPageV1>,
  'wagyu_get_notification_evidence_v1' : ActorMethod<
    [NotificationEvidenceRequestV1],
    NotificationEvidenceV1
  >,
  'wagyu_get_notification_page_v1' : ActorMethod<
    [NotificationPageRequestV1],
    NotificationPageV1
  >,
  'wagyu_get_send_quote_v1' : ActorMethod<[SendQuoteRequestV1], SendQuoteV1>,
  'wagyu_profile_edit_v1' : ActorMethod<
    [ProfileEditRequestV1],
    ProfileEditResultV1
  >,
}
export declare const idlFactory: IDL.InterfaceFactory;
export declare const init: (args: { IDL: typeof IDL }) => IDL.Type[];
