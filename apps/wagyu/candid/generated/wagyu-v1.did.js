export const idlFactory = ({ IDL }) => {
  const PublicIngressRequestV1 = IDL.Record({
    'method' : IDL.Text,
    'payload' : IDL.Vec(IDL.Nat8),
  });
  const PublicIngressErrorV1 = IDL.Variant({
    'revoked_after_dispatch' : IDL.Null,
    'bad_request' : IDL.Null,
    'low_cycles' : IDL.Null,
    'revoked' : IDL.Null,
    'rate_limited' : IDL.Null,
    'busy' : IDL.Null,
    'handler_failed' : IDL.Null,
    'not_found' : IDL.Null,
    'unauthorized' : IDL.Null,
    'too_large' : IDL.Null,
  });
  const PublicIngressResultV1 = IDL.Variant({
    'ok' : IDL.Vec(IDL.Nat8),
    'err' : PublicIngressErrorV1,
  });
  const FeedPageRequestV1 = IDL.Record({
    'limit' : IDL.Nat16,
    'before_sequence' : IDL.Opt(IDL.Nat64),
  });
  const Blob32 = IDL.Vec(IDL.Nat8);
  const VerificationStateV1 = IDL.Variant({
    'verified' : IDL.Null,
    'pending' : IDL.Null,
    'invalid' : IDL.Null,
    'unavailable' : IDL.Null,
  });
  const FeedEventKindV1 = IDL.Variant({
    'share' : IDL.Null,
    'tombstone' : IDL.Null,
    'original' : IDL.Null,
  });
  const FeedCandidateSummaryV1 = IDL.Record({
    'received_at_ns' : IDL.Nat64,
    'claimed_post_id' : Blob32,
    'exact_event_candid' : IDL.Vec(IDL.Nat8),
    'claimed_author' : IDL.Principal,
    'candidate_id' : Blob32,
    'verification' : IDL.Opt(VerificationStateV1),
    'event_kind' : IDL.Opt(FeedEventKindV1),
    'local_sequence' : IDL.Nat64,
    'immediate_sender' : IDL.Principal,
  });
  const FeedPageV1 = IDL.Record({
    'next_before_sequence' : IDL.Opt(IDL.Nat64),
    'items' : IDL.Vec(FeedCandidateSummaryV1),
    'revision' : IDL.Nat64,
  });
  const NotificationEvidenceRequestV1 = IDL.Record({
    'local_sequence' : IDL.Nat64,
  });
  const NotificationEvidenceKindV1 = IDL.Variant({
    'like' : IDL.Record({
      'certified_like_receipt_candid' : IDL.Vec(IDL.Nat8),
    }),
  });
  const NotificationEvidenceV1 = IDL.Record({
    'found' : IDL.Bool,
    'evidence' : IDL.Opt(NotificationEvidenceKindV1),
    'local_sequence' : IDL.Nat64,
  });
  const NotificationPageRequestV1 = IDL.Record({
    'limit' : IDL.Nat16,
    'before_sequence' : IDL.Opt(IDL.Nat64),
  });
  const DirectedActionSummaryV1 = IDL.Record({
    'action_id' : Blob32,
    'object_length' : IDL.Nat32,
    'object_digest' : Blob32,
    'target_body_hash' : Blob32,
    'target_post_id' : Blob32,
  });
  const NotificationKindV1 = IDL.Variant({
    'new_follower' : IDL.Record({ 'follower_revision' : IDL.Nat64 }),
    'like' : DirectedActionSummaryV1,
    'share' : DirectedActionSummaryV1,
    'reply' : DirectedActionSummaryV1,
  });
  const NotificationVerificationV1 = IDL.Variant({
    'verified' : IDL.Null,
    'pending' : IDL.Null,
    'invalid' : IDL.Null,
    'transport_authenticated' : IDL.Null,
    'unavailable' : IDL.Null,
  });
  const NotificationSummaryV1 = IDL.Record({
    'actor' : IDL.Principal,
    'kind' : IDL.Opt(NotificationKindV1),
    'read' : IDL.Bool,
    'received_at_ns' : IDL.Nat64,
    'verification' : IDL.Opt(NotificationVerificationV1),
    'local_sequence' : IDL.Nat64,
  });
  const NotificationPageV1 = IDL.Record({
    'next_before_sequence' : IDL.Opt(IDL.Nat64),
    'items' : IDL.Vec(NotificationSummaryV1),
    'revision' : IDL.Nat64,
  });
  const SendKindV1 = IDL.Variant({
    'post' : IDL.Null,
    'share' : IDL.Null,
    'tombstone' : IDL.Null,
    'reply' : IDL.Null,
  });
  const SendQuoteRequestV1 = IDL.Record({
    'send_kind' : IDL.Opt(SendKindV1),
    'estimated_object_bytes' : IDL.Nat32,
    'notice_target' : IDL.Opt(IDL.Principal),
  });
  const SendQuoteV1 = IDL.Record({
    'author_notice_floor_cycles' : IDL.Nat,
    'receiver_floor_cycles' : IDL.Nat,
    'ineligible_follower_count' : IDL.Nat32,
    'eligible_delivery_count' : IDL.Nat32,
    'estimated_call_and_byte_cycles' : IDL.Nat,
    'estimated_local_publication_cycles' : IDL.Nat,
    'eligible_recipient_preview' : IDL.Vec(IDL.Principal),
    'follower_revision' : IDL.Nat64,
    'registered_follower_count' : IDL.Nat32,
    'estimated_total_cycles' : IDL.Nat,
  });
  const ProfileAvatarMediaTypeV1 = IDL.Variant({
    'png' : IDL.Null,
    'jpeg' : IDL.Null,
    'webp' : IDL.Null,
  });
  const ProfileEditAvatarV1 = IDL.Record({
    'height' : IDL.Nat16,
    'media_type' : IDL.Opt(ProfileAvatarMediaTypeV1),
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
      'body_digest' : Blob32,
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
  return IDL.Service({
    'app_wagyu__wagyu_v1_update' : IDL.Func(
        [PublicIngressRequestV1],
        [PublicIngressResultV1],
        [],
      ),
    'wagyu_get_feed_page_v1' : IDL.Func(
        [FeedPageRequestV1],
        [FeedPageV1],
        ['query'],
      ),
    'wagyu_get_notification_evidence_v1' : IDL.Func(
        [NotificationEvidenceRequestV1],
        [NotificationEvidenceV1],
        ['query'],
      ),
    'wagyu_get_notification_page_v1' : IDL.Func(
        [NotificationPageRequestV1],
        [NotificationPageV1],
        ['query'],
      ),
    'wagyu_get_send_quote_v1' : IDL.Func(
        [SendQuoteRequestV1],
        [SendQuoteV1],
        ['query'],
      ),
    'wagyu_profile_edit_v1' : IDL.Func(
        [ProfileEditRequestV1],
        [ProfileEditResultV1],
        [],
      ),
  });
};
export const init = ({ IDL }) => { return []; };
