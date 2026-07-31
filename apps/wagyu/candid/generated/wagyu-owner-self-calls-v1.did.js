export const idlFactory = ({ IDL }) => {
  const NodeRequestV1 = IDL.Record({ 'node' : IDL.Principal });
  const RelationshipStateV1 = IDL.Variant({
    'active' : IDL.Null,
    'registering' : IDL.Null,
    'cleanup_pending' : IDL.Null,
    'credit_low' : IDL.Null,
    'expired' : IDL.Null,
    'blocked' : IDL.Null,
    'incompatible' : IDL.Null,
  });
  const RelationshipSummaryV1 = IDL.Record({
    'protocol' : IDL.Text,
    'following_auto_renew_due' : IDL.Bool,
    'follower_delivery_credits' : IDL.Nat16,
    'compatible' : IDL.Bool,
    'blocked' : IDL.Bool,
    'node' : IDL.Principal,
    'follower' : IDL.Bool,
    'following_state' : IDL.Opt(RelationshipStateV1),
    'following_renewal_requested' : IDL.Bool,
    'follower_lease_expires_ns' : IDL.Opt(IDL.Nat64),
    'bond_cycles' : IDL.Nat,
    'following' : IDL.Bool,
    'follower_state' : IDL.Opt(RelationshipStateV1),
  });
  const LocalErrorV1 = IDL.Variant({
    'not_configured' : IDL.Null,
    'conflict' : IDL.Null,
    'invalid' : IDL.Null,
    'busy' : IDL.Null,
    'full' : IDL.Null,
    'not_found' : IDL.Null,
    'proof_invalid' : IDL.Null,
    'certified_store' : IDL.Null,
    'unsupported' : IDL.Null,
  });
  const RelationshipSummaryLocalResultV1 = IDL.Variant({
    'ok' : RelationshipSummaryV1,
    'err' : LocalErrorV1,
  });
  const BlockStatusesSelfRequestV1 = IDL.Record({
    'nodes' : IDL.Vec(IDL.Principal),
  });
  const BlockStatusSelfV1 = IDL.Record({
    'blocked' : IDL.Bool,
    'node' : IDL.Principal,
  });
  const BlockStatusesSelfOutputV1 = IDL.Record({
    'relationship_revision' : IDL.Nat64,
    'items' : IDL.Vec(BlockStatusSelfV1),
  });
  const FeedPageSelfRequestV1 = IDL.Record({
    'limit' : IDL.Nat16,
    'before_sequence' : IDL.Opt(IDL.Nat64),
  });
  const FeedPageSelfValueV1 = IDL.Record({
    'body_digest_hex' : IDL.Text,
    'body_bytes' : IDL.Nat32,
    'revision' : IDL.Nat64,
    'item_count' : IDL.Nat16,
  });
  const FeedPageSelfOutputV1 = IDL.Record({
    'value' : FeedPageSelfValueV1,
    'body' : IDL.Vec(IDL.Nat8),
  });
  const FeedPromoteSelfRequestV1 = IDL.Record({
    'verified_author' : IDL.Principal,
    'verified_body_hash_hex' : IDL.Text,
    'verified_post_id_hex' : IDL.Text,
    'verified_object_digest_hex' : IDL.Text,
    'candidate_id_hex' : IDL.Text,
  });
  const Nat64LocalResultV1 = IDL.Variant({
    'ok' : IDL.Nat64,
    'err' : LocalErrorV1,
  });
  const FeedRejectDispositionV1 = IDL.Variant({
    'invalid' : IDL.Null,
    'unavailable' : IDL.Null,
  });
  const FeedRejectSelfRequestV1 = IDL.Record({
    'disposition' : IDL.Opt(FeedRejectDispositionV1),
    'candidate_id_hex' : IDL.Text,
  });
  const FollowSelfRequestV1 = IDL.Record({
    'node' : IDL.Principal,
    'subscription_id_hex' : IDL.Text,
  });
  const FinalizeSelfRequestV1 = IDL.Record({
    'object_digest_hex' : IDL.Text,
    'action_id_hex' : IDL.Text,
    'exact_proof_candid' : IDL.Vec(IDL.Nat8),
  });
  const PublishStageV1 = IDL.Variant({
    'fanout_queued' : IDL.Null,
    'uncertain' : IDL.Null,
    'complete' : IDL.Null,
    'certified_ref_ready' : IDL.Null,
    'awaiting_proof' : IDL.Null,
    'failed' : IDL.Null,
    'partial' : IDL.Null,
  });
  const PublishSelfResultV1 = IDL.Record({
    'queued_recipient_count' : IDL.Nat32,
    'object_digest_hex' : IDL.Opt(IDL.Text),
    'action_id_hex' : IDL.Opt(IDL.Text),
    'stage' : IDL.Opt(PublishStageV1),
    'accepted_recipient_count' : IDL.Nat32,
    'message' : IDL.Text,
    'queued_notice_count' : IDL.Nat32,
    'post_id_hex' : IDL.Opt(IDL.Text),
    'failed_recipient_count' : IDL.Nat32,
  });
  const PublishSelfLocalResultV1 = IDL.Variant({
    'ok' : PublishSelfResultV1,
    'err' : LocalErrorV1,
  });
  const LikePrepareSelfRequestV1 = IDL.Record({
    'nonce_hex' : IDL.Text,
    'post_author' : IDL.Principal,
    'post_id_hex' : IDL.Text,
    'post_object_digest_hex' : IDL.Opt(IDL.Text),
    'post_body_hash_hex' : IDL.Text,
  });
  const LikeSealSelfRequestV1 = IDL.Record({
    'final_partial' : IDL.Bool,
    'post_id_hex' : IDL.Text,
  });
  const NotificationEvidenceSelfRequestV1 = IDL.Record({
    'local_sequence' : IDL.Nat64,
  });
  const NotificationEvidenceSelfValueV1 = IDL.Record({
    'found' : IDL.Bool,
    'body_digest_hex' : IDL.Text,
    'body_bytes' : IDL.Nat32,
    'local_sequence' : IDL.Nat64,
  });
  const NotificationEvidenceSelfOutputV1 = IDL.Record({
    'value' : NotificationEvidenceSelfValueV1,
    'body' : IDL.Vec(IDL.Nat8),
  });
  const NotificationPageSelfRequestV1 = IDL.Record({
    'limit' : IDL.Nat16,
    'before_sequence' : IDL.Opt(IDL.Nat64),
  });
  const NotificationPageSelfValueV1 = IDL.Record({
    'body_digest_hex' : IDL.Text,
    'body_bytes' : IDL.Nat32,
    'revision' : IDL.Nat64,
    'item_count' : IDL.Nat16,
  });
  const NotificationPageSelfOutputV1 = IDL.Record({
    'value' : NotificationPageSelfValueV1,
    'body' : IDL.Vec(IDL.Nat8),
  });
  const ReplyLocatorSelfV1 = IDL.Record({
    'object_digest_hex' : IDL.Text,
    'body_length' : IDL.Nat32,
    'author' : IDL.Principal,
    'post_id_hex' : IDL.Text,
    'body_hash_hex' : IDL.Text,
  });
  const VerifiedReplySelfV1 = IDL.Record({
    'reply_to' : ReplyLocatorSelfV1,
    'object_digest_hex' : IDL.Text,
    'body_length' : IDL.Nat32,
    'author' : IDL.Principal,
    'post_id_hex' : IDL.Text,
    'body_hash_hex' : IDL.Text,
  });
  const NotificationDispositionSelfV1 = IDL.Variant({
    'verified' : IDL.Null,
    'invalid' : IDL.Null,
    'unavailable' : IDL.Null,
  });
  const NotificationPromoteSelfRequestV1 = IDL.Record({
    'verified_reply' : IDL.Opt(VerifiedReplySelfV1),
    'disposition' : IDL.Opt(NotificationDispositionSelfV1),
    'local_sequence' : IDL.Nat64,
  });
  const PostPrepareSelfRequestV1 = IDL.Record({
    'reply_to' : IDL.Opt(ReplyLocatorSelfV1),
    'body_markdown' : IDL.Text,
    'nonce_hex' : IDL.Text,
  });
  const AvatarMediaTypeV1 = IDL.Variant({
    'png' : IDL.Null,
    'jpeg' : IDL.Null,
    'webp' : IDL.Null,
  });
  const ProfileEditAvatarV1 = IDL.Record({
    'height' : IDL.Nat16,
    'media_type' : IDL.Opt(AvatarMediaTypeV1),
    'bytes' : IDL.Vec(IDL.Nat8),
    'width' : IDL.Nat16,
  });
  const ProfileEditRequestV1 = IDL.Record({
    'expected_profile_generation' : IDL.Nat64,
    'description' : IDL.Text,
    'display_name' : IDL.Text,
    'expected_revision' : IDL.Nat64,
    'avatar' : IDL.Opt(ProfileEditAvatarV1),
  });
  const ProfileEditRejectionReasonV1 = IDL.Variant({
    'low_cycles' : IDL.Null,
    'invalid' : IDL.Null,
    'full' : IDL.Null,
  });
  const ProfileEditOutcomeV1 = IDL.Variant({
    'conflict' : IDL.Record({
      'current_revision' : IDL.Nat64,
      'current_generation' : IDL.Nat64,
    }),
    'updated' : IDL.Record({
      'body_digest' : IDL.Vec(IDL.Nat8),
      'profile_generation' : IDL.Nat64,
      'revision' : IDL.Nat64,
    }),
    'rejected' : IDL.Record({
      'reason' : IDL.Opt(ProfileEditRejectionReasonV1),
    }),
  });
  const ProfileEditResultV1 = IDL.Record({
    'outcome' : IDL.Opt(ProfileEditOutcomeV1),
  });
  const SharePrepareSelfRequestV1 = IDL.Record({
    'nonce_hex' : IDL.Opt(IDL.Text),
    'exact_original_post_ref_candid' : IDL.Vec(IDL.Nat8),
  });
  const TombstonePrepareSelfRequestV1 = IDL.Record({
    'nonce_hex' : IDL.Text,
    'post_id_hex' : IDL.Text,
  });
  const WithdrawalAdvanceSelfRequestV1 = IDL.Record({
    'nonce_hex' : IDL.Text,
    'post_id_hex' : IDL.Text,
  });
  return IDL.Service({
    'wagyu_auto_renew_self_v1' : IDL.Func(
        [NodeRequestV1],
        [RelationshipSummaryLocalResultV1],
        [],
      ),
    'wagyu_block_statuses_self_v1' : IDL.Func(
        [BlockStatusesSelfRequestV1],
        [BlockStatusesSelfOutputV1],
        ['query'],
      ),
    'wagyu_feed_page_self_v1' : IDL.Func(
        [FeedPageSelfRequestV1],
        [FeedPageSelfOutputV1],
        ['query'],
      ),
    'wagyu_feed_promote_self_v1' : IDL.Func(
        [FeedPromoteSelfRequestV1],
        [Nat64LocalResultV1],
        [],
      ),
    'wagyu_feed_reject_self_v1' : IDL.Func(
        [FeedRejectSelfRequestV1],
        [Nat64LocalResultV1],
        [],
      ),
    'wagyu_follow_self_v1' : IDL.Func(
        [FollowSelfRequestV1],
        [RelationshipSummaryLocalResultV1],
        [],
      ),
    'wagyu_like_finalize_self_v1' : IDL.Func(
        [FinalizeSelfRequestV1],
        [PublishSelfLocalResultV1],
        [],
      ),
    'wagyu_like_prepare_self_v1' : IDL.Func(
        [LikePrepareSelfRequestV1],
        [PublishSelfLocalResultV1],
        [],
      ),
    'wagyu_like_seal_self_v1' : IDL.Func(
        [LikeSealSelfRequestV1],
        [PublishSelfLocalResultV1],
        [],
      ),
    'wagyu_notification_evidence_self_v1' : IDL.Func(
        [NotificationEvidenceSelfRequestV1],
        [NotificationEvidenceSelfOutputV1],
        ['query'],
      ),
    'wagyu_notification_page_self_v1' : IDL.Func(
        [NotificationPageSelfRequestV1],
        [NotificationPageSelfOutputV1],
        ['query'],
      ),
    'wagyu_notification_promote_self_v1' : IDL.Func(
        [NotificationPromoteSelfRequestV1],
        [Nat64LocalResultV1],
        [],
      ),
    'wagyu_post_finalize_self_v1' : IDL.Func(
        [FinalizeSelfRequestV1],
        [PublishSelfLocalResultV1],
        [],
      ),
    'wagyu_post_prepare_self_v1' : IDL.Func(
        [PostPrepareSelfRequestV1],
        [PublishSelfLocalResultV1],
        [],
      ),
    'wagyu_profile_edit_v1' : IDL.Func(
        [ProfileEditRequestV1],
        [ProfileEditResultV1],
        [],
      ),
    'wagyu_share_finalize_self_v1' : IDL.Func(
        [FinalizeSelfRequestV1],
        [PublishSelfLocalResultV1],
        [],
      ),
    'wagyu_share_prepare_self_v1' : IDL.Func(
        [SharePrepareSelfRequestV1],
        [PublishSelfLocalResultV1],
        [],
      ),
    'wagyu_tombstone_finalize_self_v1' : IDL.Func(
        [FinalizeSelfRequestV1],
        [PublishSelfLocalResultV1],
        [],
      ),
    'wagyu_tombstone_prepare_self_v1' : IDL.Func(
        [TombstonePrepareSelfRequestV1],
        [PublishSelfLocalResultV1],
        [],
      ),
    'wagyu_withdrawal_advance_self_v1' : IDL.Func(
        [WithdrawalAdvanceSelfRequestV1],
        [PublishSelfLocalResultV1],
        [],
      ),
  });
};
export const init = ({ IDL }) => { return []; };
