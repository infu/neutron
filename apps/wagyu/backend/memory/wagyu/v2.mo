// Persistent schema: keep this file immutable after release. Package imports
// are allowed; relative imports are forbidden so app-local types cannot drift.
//
// This schema contains durable application data only. Kernel capabilities,
// actors, callbacks, comparators, and other runtime values must never be added
// to it. Fixed-size Blob requirements are enforced by the Wagyu protocol
// codecs; Candid has no distinct fixed-length Blob type.
import Map "mo:core/Map";

module {
    public type StableKey = Text;
    public type Digest256 = Blob;
    public type Nonce128 = Blob;
    public type OperationId = Blob;
    public type SubscriptionId = Blob;
    public type TimestampNs = Nat64;

    // The second word makes otherwise equal expiration/retry times unique.
    public type OrderedTimeKey = (Nat64, Nat64);
    // Domain prevents two record classes with the same local sequence from
    // colliding in the shared bounded-retention cleanup index.
    public type RetentionIndexKey = (Nat64, Nat8, Nat64);
    public type OutboxOperationKey = (Principal, Text, Blob);

    public type ActionKind = {
        #post;
        #share;
        #tombstone;
        #like;
    };

    public type ActionHeaderV1 = {
        network_id : Digest256;
        actor_ : Principal;
        action_kind : ?ActionKind;
    };

    public type CertifiedHttpProofV1 = {
        certificate_version : Nat8;
        certificate_cbor : Blob;
        witness_cbor : Blob;
        expression_path_cbor : Blob;
        certificate_time_ns : TimestampNs;
    };

    public type CertifiedActionRefV1 = {
        actor_ : Principal;
        action_kind : ?ActionKind;
        object_digest : Digest256;
        body_length : Nat32;
        proof_snapshot : CertifiedHttpProofV1;
    };

    public type ReplyLocatorV1 = {
        author : Principal;
        post_id : Digest256;
        body_hash : Digest256;
        body_length : Nat32;
        object_digest : Digest256;
    };

    public type PostBodyV1 = {
        header : ActionHeaderV1;
        author_sequence : Nat64;
        nonce : Nonce128;
        created_at_ns : TimestampNs;
        body_markdown : Text;
        reply_to : ?ReplyLocatorV1;
    };

    public type ReplyIndexEntryV1 = {
        author : Principal;
        post_id : Digest256;
        object_digest : Digest256;
        object_length : Nat32;
        received_at_ns : TimestampNs;
    };

    public type ReplyIndexV1 = {
        network_id : Digest256;
        post_author : Principal;
        post_id : Digest256;
        post_body_hash : Digest256;
        store_generation : Nat64;
        revision : Nat64;
        previous_index_hash : ?Digest256;
        replies : [ReplyIndexEntryV1];
    };

    public type CertifiedPostRefV1 = {
        author : Principal;
        post_id : Digest256;
        body_hash : Digest256;
        body_length : Nat32;
        object_digest : Digest256;
        proof : CertifiedHttpProofV1;
    };

    public type ShareActionV1 = {
        header : ActionHeaderV1;
        share_id : Digest256;
        share_sequence : Nat64;
        issued_at_ns : TimestampNs;
        original_author : Principal;
        original_post_id : Digest256;
        original_body_hash : Digest256;
        post_ref_digest : Digest256;
    };

    public type CertifiedShareRefV1 = {
        sharer : Principal;
        share_id : Digest256;
        body_length : Nat32;
        object_digest : Digest256;
        proof : CertifiedHttpProofV1;
    };

    public type CertifiedShareDeliveryV1 = {
        original_post_ref_candid : Blob;
        share_action_candid : Blob;
        share_ref : CertifiedShareRefV1;
    };

    public type LikeActionV1 = {
        header : ActionHeaderV1;
        like_id : Digest256;
        issued_at_ns : TimestampNs;
        post_author : Principal;
        post_id : Digest256;
        post_body_hash : Digest256;
    };

    public type CertifiedLikeReceiptV1 = {
        like_action_candid : Blob;
        ref : CertifiedActionRefV1;
    };

    public type ProfileMediaType = {
        #jpeg;
        #png;
        #webp;
    };

    public type ProfileAvatarV1 = {
        media_type : ?ProfileMediaType;
        width : Nat16;
        height : Nat16;
        bytes : Blob;
    };

    public type ProfileV1 = {
        network_id : Digest256;
        node : Principal;
        profile_generation : Nat64;
        revision : Nat64;
        updated_at_ns : TimestampNs;
        previous_profile_digest : ?Digest256;
        display_name : Text;
        description : Text;
        capabilities : ?[Text];
        avatar : ?ProfileAvatarV1;
    };

    public type TombstoneActionV1 = {
        header : ActionHeaderV1;
        tombstone_id : Digest256;
        author_sequence : Nat64;
        issued_at_ns : TimestampNs;
        post_id : Digest256;
        post_body_hash : Digest256;
    };

    public type CertifiedTombstoneV1 = {
        tombstone_action_candid : Blob;
        ref : CertifiedActionRefV1;
    };

    public type LikeBatchV1 = {
        network_id : Digest256;
        post_author : Principal;
        post_id : Digest256;
        post_body_hash : Digest256;
        batch_number : Nat64;
        previous_batch_digest : ?Digest256;
        first_accepted_sequence : Nat64;
        last_accepted_sequence : Nat64;
        final_partial : Bool;
        receipts : [CertifiedLikeReceiptV1];
    };

    public type LikeHeadV1 = {
        network_id : Digest256;
        post_author : Principal;
        post_id : Digest256;
        post_body_hash : Digest256;
        store_generation : Nat64;
        revision : Nat64;
        previous_head_hash : ?Digest256;
        latest_batch_number : ?Nat64;
        latest_batch_digest : ?Digest256;
        sealed_batch_count : Nat64;
        sealed_receipt_count : Nat64;
        accepting_likes : Bool;
    };

    public type FollowerStateV1 = {
        #active : {
            subscription_id : SubscriptionId;
            lease_expires_ns : TimestampNs;
            delivery_credits : Nat16;
        };
        #inactive : {
            last_subscription_id : SubscriptionId;
        };
    };

    public type FollowerHeadV1 = {
        revision : Nat64;
        state : ?FollowerStateV1;
    };

    // These are app-owned mirrors of opaque kernel publication identities.
    // They are intentionally not capability-package types.
    public type CertifiedCollection = {
        #posts;
        #shares;
        #tombstones;
        #likes;
        #like_batches;
        #like_heads;
        #reply_indexes;
        #profile;
    };

    public type CertifiedTargetKey = {
        #digest : Digest256;
        #post_id : Digest256;
        #profile;
    };

    public type CertifiedTarget = {
        collection : CertifiedCollection;
        collection_generation : Nat64;
        key : CertifiedTargetKey;
    };

    public type KernelRecordIdentity = {
        target : CertifiedTarget;
        kernel_revision : Nat64;
        content_tag : Blob;
        body_digest : Digest256;
        body_length : Nat32;
    };

    public type CertifiedDependency = {
        target : CertifiedTarget;
        body_digest : Digest256;
    };

    public type PublicationMutation = {
        #put : {
            target : CertifiedTarget;
            body_digest : Digest256;
            body_length : Nat32;
            expected : ?KernelRecordIdentity;
            requires_present_after : ?CertifiedDependency;
        };
        #delete : {
            target : CertifiedTarget;
            expected : KernelRecordIdentity;
        };
    };

    public type PublicationDomain = {
        #stage;
        #positive_batch;
        #revocation;
    };

    public type PublicationKind = {
        #install_profile;
        #replace_profile;
        #replace_reply_index;
        #post_and_like_head;
        #action;
        #like_batch_and_head;
        #stop_likes;
        #delete_record;
    };

    public type PublicationStage = {
        stage_id : Nat64;
        request_nonce : Nonce128;
        request_fingerprint : Digest256;
        target_collection : CertifiedCollection;
        collection_generation : Nat64;
        expected_body_length : Nat32;
        block_count : Nat8;
        next_block_index : Nat8;
        raw_digest : ?Digest256;
        computed_target : ?CertifiedTarget;
        started_at_ns : TimestampNs;
        expires_at_ns : TimestampNs;
    };

    public type PublicationFailure = {
        #invalid;
        #conflict;
        #stale_scope;
        #stale_generation;
        #quota;
        #low_cycles;
        #aborted;
        #expired;
        #unknown;
    };

    public type PublicationState = {
        #prepared;
        #staging : PublicationStage;
        #submitted : {
            submitted_at_ns : TimestampNs;
            receipt_expires_at_ns : TimestampNs;
        };
        #reconcile_status : {
            status_requested_at_ns : ?TimestampNs;
            attempt_count : Nat32;
        };
        #committed : {
            committed_at_ns : TimestampNs;
            records : [KernelRecordIdentity];
        };
        #failed : {
            reason : PublicationFailure;
            failed_at_ns : TimestampNs;
        };
    };

    public type CertifiedPublication = {
        publication_id : Nat64;
        kind : PublicationKind;
        domain : PublicationDomain;
        request_nonce : Nonce128;
        request_fingerprint : Digest256;
        mutations : [PublicationMutation];
        state : PublicationState;
        created_at_ns : TimestampNs;
        updated_at_ns : TimestampNs;
        reconcile_until_ns : TimestampNs;
        retained_bytes : Nat;
    };

    public type CertifiedRecord = {
        record_key : StableKey;
        identity : KernelRecordIdentity;
        publication_id : Nat64;
        local_object_key : ?StableKey;
        created_at_ns : TimestampNs;
        withdrawn_at_ns : ?TimestampNs;
    };

    public type CertifiedCollectionState = {
        collection : CertifiedCollection;
        collection_generation : Nat64;
        object_count : Nat;
        body_bytes : Nat;
    };

    public type InstallationState = {
        #uninitialized;
        #provisional : {
            node : Principal;
            network_id : Digest256;
            profile_generation : Nat64;
        };
        #active : {
            node : Principal;
            network_id : Digest256;
            profile_generation : Nat64;
            activated_at_ns : TimestampNs;
        };
    };

    public type ProfileState = {
        value : ProfileV1;
        exact_body_candid : Blob;
        body_digest : Digest256;
        kernel_identity : KernelRecordIdentity;
        publication_id : Nat64;
    };

    public type AuthoredObjectState = {
        #awaiting_publication : {
            publication_id : Nat64;
        };
        #awaiting_proof : {
            publication_id : Nat64;
        };
        #certified : {
            publication_id : Nat64;
            finalized_at_ns : TimestampNs;
        };
        #reconciling : {
            publication_id : Nat64;
        };
        #failed : {
            publication_id : Nat64;
            reason : PublicationFailure;
        };
    };

    public type WithdrawalPhase = {
        #stop_likes;
        #seal_due;
        #seal_final_partial;
        #ready_for_fanout;
    };

    public type WithdrawalClosing = {
        tombstone_action_key : StableKey;
        follower_registration_cutoff : Nat64;
        phase : WithdrawalPhase;
        due_batch_number : ?Nat64;
        final_partial_batch_number : ?Nat64;
        started_at_ns : TimestampNs;
        updated_at_ns : TimestampNs;
    };

    public type AuthoredPostStatus = {
        #awaiting_proof;
        #live;
        #withdrawal_awaiting_proof : {
            tombstone_action_key : StableKey;
        };
        #withdrawal_closing : WithdrawalClosing;
        #withdrawn : {
            tombstone_action_key : StableKey;
            withdrawn_at_ns : TimestampNs;
            cleanup_phase : {
                #retained;
                #head_revoked;
                #post_revoked;
                #tombstone_revoked;
            };
        };
    };

    public type AuthoredPost = {
        post_key : StableKey;
        post_id : Digest256;
        body_hash : Digest256;
        object_digest : Digest256;
        body_length : Nat32;
        exact_body_candid : Blob;
        body : PostBodyV1;
        exact_certified_ref_candid : ?Blob;
        object_state : AuthoredObjectState;
        status : AuthoredPostStatus;
        like_head_key : StableKey;
        created_at_ns : TimestampNs;
        retention_expires_at_ns : TimestampNs;
        retained_bytes : Nat;
    };

    public type AuthoredActionKind = {
        #share : {
            action : ShareActionV1;
            exact_original_post_ref_candid : Blob;
            exact_delivery_candid : ?Blob;
        };
        #like : {
            action : LikeActionV1;
            exact_receipt_candid : ?Blob;
        };
        #tombstone : {
            action : TombstoneActionV1;
            exact_tombstone_candid : ?Blob;
        };
    };

    public type AuthoredAction = {
        action_key : StableKey;
        action_id : Digest256;
        sequence : Nat64;
        object_digest : Digest256;
        body_length : Nat32;
        exact_body_candid : Blob;
        kind : AuthoredActionKind;
        object_state : AuthoredObjectState;
        created_at_ns : TimestampNs;
        retention_expires_at_ns : TimestampNs;
        retained_bytes : Nat;
    };

    public type OutgoingLikeMarker = {
        original_post_key : StableKey;
        like_id : Digest256;
        object_digest : Digest256;
        live_action_key : ?StableKey;
        retained_bytes : Nat;
    };

    public type FollowingStatus = {
        #registering;
        #active;
        #uncertain;
        #conflicted;
        #incompatible;
    };

    public type FollowingIntent = {
        #on : {
            subscription_id : SubscriptionId;
            status : FollowingStatus;
        };
        #off : {
            last_subscription_id : SubscriptionId;
        };
    };

    public type FollowingRecord = {
        node : Principal;
        intent_generation : Nat;
        storage_revision : Nat64;
        intent : FollowingIntent;
        last_remote_revision : ?Nat64;
        renewal_requested : Bool;
        updated_at_ns : TimestampNs;
        pending_outbox_local_id : ?Nat64;
        created_at_ns : TimestampNs;
    };

    public type DeliveryPause = {
        #blocked;
        #not_following;
        #incompatible;
    };

    public type FollowerRecord = {
        node : Principal;
        head_revision : Nat64;
        storage_revision : Nat64;
        state : FollowerStateV1;
        registration_sequence : Nat64;
        delivery_pause : ?DeliveryPause;
        outstanding_delivery_charges : Nat16;
        // Receiver-clock time of the last accepted paid Follow renewal.
        // Credit, pause, block, and dispatch bookkeeping must preserve it.
        funded_at_ns : TimestampNs;
        created_at_ns : TimestampNs;
        updated_at_ns : TimestampNs;
        retain_until_ns : TimestampNs;
        retained_bytes : Nat;
    };

    public type FollowerCounters = {
        follower_revision : Nat64;
        max_registration_sequence : Nat64;
    };

    public type BlockRecord = {
        node : Principal;
        storage_revision : Nat64;
        blocked_at_ns : TimestampNs;
    };

    public type IngressRoute = {
        #follow;
        #unfollow;
        #deliver;
        #like;
        #notice;
    };

    public type RouteRejectionReason = {
        #invalid;
        #blocked;
        #not_following;
        #unknown_post;
        #expired;
        #full;
        #conflict;
        #incompatible;
    };

    public type WagyuRouteOutcomeV1 = {
        #accepted;
        #duplicate;
        #rejected : {
            reason : ?RouteRejectionReason;
        };
    };

    public type WagyuRouteResultV1 = {
        outcome : ?WagyuRouteOutcomeV1;
        local_receipt_time_ns : ?TimestampNs;
        revision : ?Nat64;
        relationship : ?FollowerHeadV1;
    };

    public type IngressReceipt = {
        receipt_key : StableKey;
        caller : Principal;
        route : IngressRoute;
        operation_id : OperationId;
        payload_digest : Digest256;
        result : WagyuRouteResultV1;
        exact_result_candid : Blob;
        received_at_ns : TimestampNs;
        retain_until_ns : TimestampNs;
        retained_bytes : Nat;
    };

    public type CallerRateWindow = {
        caller : Principal;
        route : IngressRoute;
        window_started_at_ns : TimestampNs;
        accepted_count : Nat32;
        semantic_notice_count : Nat32;
        expires_at_ns : TimestampNs;
        retained_bytes : Nat;
    };

    public type FeedEventKind = {
        #original;
        #share;
        #tombstone;
    };

    public type FeedVerification = {
        #pending;
        #verified;
        #invalid;
        #unavailable;
    };

    public type FeedCandidate = {
        candidate_key : StableKey;
        candidate_id : Digest256;
        local_sequence : Nat64;
        received_at_ns : TimestampNs;
        immediate_sender : Principal;
        route_receipt_key : StableKey;
        operation_id : OperationId;
        payload_digest : Digest256;
        subscription_id : SubscriptionId;
        event_kind : ?FeedEventKind;
        claimed_author : Principal;
        claimed_post_id : Digest256;
        claimed_body_hash : ?Digest256;
        exact_event_candid : Blob;
        verification : ?FeedVerification;
        read : Bool;
        retain_until_ns : TimestampNs;
        retained_bytes : Nat;
    };

    public type FeedPostLocator = {
        author : Principal;
        post_id : Digest256;
        body_hash : Digest256;
        body_length : Nat32;
        object_digest : Digest256;
        exact_certified_post_ref_candid : Blob;
        certified_ref : CertifiedPostRefV1;
    };

    public type VerifiedFeedStatus = {
        #active;
        #withdrawn : {
            tombstone_id : Digest256;
            exact_tombstone_candid : Blob;
            withdrawn_at_ns : TimestampNs;
        };
    };

    public type VerifiedFeedRecord = {
        feed_key : StableKey;
        locator : FeedPostLocator;
        first_candidate_key : StableKey;
        first_local_sequence : Nat64;
        latest_local_sequence : Nat64;
        direct_candidate_key : ?StableKey;
        status : VerifiedFeedStatus;
        created_at_ns : TimestampNs;
        updated_at_ns : TimestampNs;
        retain_until_ns : TimestampNs;
        retained_bytes : Nat;
    };

    public type ShareAttribution = {
        attribution_key : StableKey;
        feed_key : StableKey;
        sharer : Principal;
        share_id : Digest256;
        share_object_digest : Digest256;
        candidate_key : StableKey;
        exact_share_action_candid : Blob;
        exact_share_ref_candid : Blob;
        verified_at_ns : TimestampNs;
        retain_until_ns : TimestampNs;
        retained_bytes : Nat;
    };

    public type SuppressionRecord = {
        suppression_key : StableKey;
        author : Principal;
        post_id : Digest256;
        body_hash : Digest256;
        tombstone_id : Digest256;
        exact_tombstone_candid : Blob;
        source_candidate_key : ?StableKey;
        suppressed_at_ns : TimestampNs;
        retain_until_ns : TimestampNs;
        retained_bytes : Nat;
    };

    public type TombstoneRelay = {
        relay_key : StableKey;
        tombstone_id : Digest256;
        local_share_id : Digest256;
        fanout_job_id : Nat64;
        created_at_ns : TimestampNs;
        retain_until_ns : TimestampNs;
        retained_bytes : Nat;
    };

    public type RetentionRecordRef = {
        #follower : Principal;
        #authored_post : StableKey;
        #authored_action : StableKey;
        #feed_candidate : StableKey;
        #verified_feed : StableKey;
        #share_attribution : StableKey;
        #suppression : StableKey;
        #tombstone_relay : StableKey;
        #notification : Nat64;
        #notice_semantic : StableKey;
        #accepted_like : StableKey;
        #sealed_like_batch : StableKey;
        #ingress_receipt : StableKey;
        #caller_rate_window : StableKey;
        #outbox : Nat64;
        #fanout_job : Nat64;
        #fanout_target : StableKey;
    };

    public type CandidatePressure = {
        sender : Principal;
        candidate_count : Nat;
        retained_bytes : Nat;
    };

    public type NotificationRelation = {
        #reply;
        #share;
    };

    public type NotificationAction = {
        target_post_id : Digest256;
        target_body_hash : Digest256;
        action_id : Digest256;
        object_digest : Digest256;
        object_length : Nat32;
    };

    public type NotificationKind = {
        #new_follower : {
            follower_revision : Nat64;
        };
        #like : NotificationAction;
        #reply : NotificationAction;
        #share : NotificationAction;
    };

    public type NotificationVerification = {
        #transport_authenticated;
        #pending;
        #verified;
        #invalid;
        #unavailable;
    };

    public type NotificationSummary = {
        local_sequence : Nat64;
        received_at_ns : TimestampNs;
        actor_ : Principal;
        kind : ?NotificationKind;
        verification : ?NotificationVerification;
        read : Bool;
        semantic_key : StableKey;
        retain_until_ns : TimestampNs;
        retained_bytes : Nat;
    };

    public type NotificationEvidence = {
        #like : {
            accepted_like_key : StableKey;
            exact_certified_like_receipt_candid : Blob;
        };
    };

    public type NoticeSemanticReceipt = {
        semantic_key : StableKey;
        actor_ : Principal;
        relation : NotificationRelation;
        action_id : Digest256;
        target_post_id : Digest256;
        target_body_hash : Digest256;
        object_digest : Digest256;
        object_length : Nat32;
        notification_sequence : Nat64;
        retain_until_ns : TimestampNs;
    };

    public type NoticePressure = {
        retained_count : Nat;
        retained_bytes : Nat;
        hourly_window_started_at_ns : TimestampNs;
        hourly_new_count : Nat32;
    };

    public type AcceptedLike = {
        accepted_like_key : StableKey;
        accepted_sequence : Nat64;
        accepted_at_ns : TimestampNs;
        post_key : StableKey;
        post_id : Digest256;
        post_body_hash : Digest256;
        liker : Principal;
        like_id : Digest256;
        like_action : LikeActionV1;
        exact_like_action_candid : Blob;
        certified_ref : CertifiedActionRefV1;
        exact_certified_like_receipt_candid : Blob;
        object_digest : Digest256;
        body_length : Nat32;
        notification_sequence : Nat64;
        retain_until_ns : TimestampNs;
        retained_bytes : Nat;
    };

    public type LikeSegment = {
        segment_number : Nat64;
        first_accepted_sequence : ?Nat64;
        last_accepted_sequence : ?Nat64;
        accepted_like_keys : [StableKey];
        receipt_count : Nat16;
        receipt_bytes : Nat;
    };

    public type LikeClosingPhase = {
        #stop_head;
        #seal_due;
        #seal_final_partial;
        #complete;
    };

    public type LikeClosingState = {
        phase : LikeClosingPhase;
        tombstone_action_key : StableKey;
        started_at_ns : TimestampNs;
        updated_at_ns : TimestampNs;
    };

    public type PostLikeState = {
        post_key : StableKey;
        active_segment : LikeSegment;
        due_segment : ?LikeSegment;
        next_segment_number : Nat64;
        next_batch_number : Nat64;
        retired_batch_prefix : Nat64;
        previous_batch_digest : ?Digest256;
        closing : ?LikeClosingState;
        structurally_accepted_count : Nat64;
        unsealed_receipt_count : Nat16;
        unsealed_receipt_bytes : Nat;
    };

    public type LikeHeadState = {
        head_key : StableKey;
        value : LikeHeadV1;
        exact_body_candid : Blob;
        body_digest : Digest256;
        kernel_identity : KernelRecordIdentity;
        publication_id : Nat64;
    };

    public type ReplyIndexState = {
        index_key : StableKey;
        value : ReplyIndexV1;
        exact_body_candid : Blob;
        body_digest : Digest256;
        kernel_identity : KernelRecordIdentity;
        publication_id : Nat64;
    };

    public type SealedLikeBatch = {
        batch_key : StableKey;
        post_key : StableKey;
        value : LikeBatchV1;
        exact_body_candid : Blob;
        body_digest : Digest256;
        body_length : Nat32;
        kernel_identity : KernelRecordIdentity;
        publication_id : Nat64;
        sealed_at_ns : TimestampNs;
        retain_until_ns : TimestampNs;
    };

    public type OutboundRoute = {
        #follow;
        #unfollow;
        #deliver;
        #like;
        #notice;
    };

    public type PreparedDispatchV1 = {
        target : Principal;
        route : Text;
        operation_id : OperationId;
        payload_digest : Digest256;
        exact_body_candid : Blob;
        exact_ingress_candid : Blob;
        exact_call_args : Blob;
        cycles : Nat;
        maximum_response_bytes : Nat;
        created_at_ns : TimestampNs;
    };

    public type DispatchCertaintyV1 = {
        #not_dispatched;
        #may_have_dispatched;
        #semantic;
    };

    public type DispatchOutcomeV1 = {
        #accepted;
        #duplicate;
        #route_rejected : RouteRejectionReason;
        #busy;
        #rate_limited;
        #low_cycles;
        #revoked;
        #handler_failure;
        #uncertain;
        #unsupported;
        #pre_dispatch_failure;
    };

    public type DispatchRetryPolicyV1 = {
        #complete;
        #terminal;
        #delayed : {
            minimum_delay_ns : TimestampNs;
            jitter_window_ns : TimestampNs;
        };
        #pause;
        #manual : {
            minimum_delay_ns : TimestampNs;
        };
    };

    public type DispatchResultV1 = {
        outcome : DispatchOutcomeV1;
        certainty : DispatchCertaintyV1;
        retry : DispatchRetryPolicyV1;
        route_result : ?WagyuRouteResultV1;
        exact_route_result_candid : ?Blob;
        code : ?Text;
        detail : ?Text;
    };

    public type OutboxState = {
        #queued;
        #sending;
        #accepted;
        #duplicate;
        #paused;
        #failed;
        #uncertain;
        #superseded;
    };

    public type OutboxRetryPermission = {
        #none;
        #automatic;
        #manual;
        #local_state_change;
    };

    public type OutboxNodePause = {
        #low_cycles;
        #authority_revoked;
    };

    public type OutboxControl = {
        revision : Nat64;
        pause : ?OutboxNodePause;
    };

    public type CreditCharge = {
        follower : Principal;
        subscription_id : SubscriptionId;
    };

    public type OutboxItem = {
        local_id : Nat64;
        storage_revision : Nat64;
        prepared : PreparedDispatchV1;
        created_at_ns : TimestampNs;
        retry_expires_at_ns : TimestampNs;
        updated_at_ns : TimestampNs;
        attempt_no : Nat32;
        attempt_prepared : Bool;
        state : OutboxState;
        retry_permission : OutboxRetryPermission;
        next_attempt_at_ns : ?TimestampNs;
        last_attempt_at_ns : ?TimestampNs;
        automatic_retry_count : Nat16;
        delivery_subscription_id : ?SubscriptionId;
        pending_credit_charge : ?CreditCharge;
        last_result : ?DispatchResultV1;
    };

    // The outbox service never rewrites this app-owned linkage. Keeping it in
    // a parallel map makes OutboxItem structurally identical in both
    // directions to backend/outbox/Types.mo Item.
    public type OutboxMetadata = {
        local_id : Nat64;
        linked_action_key : ?StableKey;
        fanout_job_id : ?Nat64;
        follower_registration_sequence : ?Nat64;
        following_intent_generation : ?Nat;
        encoded_renewal_requested : ?Bool;
        retained_bytes : Nat;
    };

    public type FanoutKind = {
        #original;
        #share;
        #tombstone;
        #tombstone_relay;
    };

    public type FanoutState = {
        #queued;
        #scanning;
        #sending;
        #complete;
        #partial;
        #paused;
        #failed;
    };

    public type FanoutJob = {
        fanout_job_id : Nat64;
        kind : FanoutKind;
        action_key : StableKey;
        exact_event_candid : Blob;
        follower_registration_cutoff : Nat64;
        after_registration_sequence : ?Nat64;
        state : FanoutState;
        eligible_count : Nat32;
        queued_count : Nat32;
        completed_count : Nat32;
        terminal_count : Nat32;
        uncertain_count : Nat32;
        created_at_ns : TimestampNs;
        updated_at_ns : TimestampNs;
        expires_at_ns : TimestampNs;
        retained_bytes : Nat;
    };

    public type FanoutTarget = {
        target_key : StableKey;
        fanout_job_id : Nat64;
        recipient : Principal;
        registration_sequence : Nat64;
        outbox_local_id : Nat64;
        expires_at_ns : TimestampNs;
        retained_bytes : Nat;
    };

    public type SchedulerState = {
        running : Bool;
        run_generation : Nat64;
        started_at_ns : ?TimestampNs;
        outbox_after_sequence : ?Nat64;
        fanout_after_job_id : ?Nat64;
        like_seal_after_post_key : ?StableKey;
    };

    public type QuotaLimits = {
        following_count : Nat;
        follower_head_count : Nat;
        follower_head_bytes : Nat;
        active_follower_count : Nat;
        block_count : Nat;
        authored_record_count : Nat;
        authored_bytes : Nat;
        candidate_count : Nat;
        candidate_bytes : Nat;
        candidates_per_sender : Nat;
        verified_feed_count : Nat;
        verified_feed_bytes : Nat;
        share_attribution_count : Nat;
        share_attribution_bytes : Nat;
        suppression_count : Nat;
        suppression_bytes : Nat;
        tombstone_relay_count : Nat;
        tombstone_relay_bytes : Nat;
        notification_count : Nat;
        notification_bytes : Nat;
        notices_per_caller : Nat;
        notices_per_target_post : Nat;
        notice_semantics_per_caller_hour : Nat32;
        reaction_receipt_count : Nat;
        reaction_receipt_bytes : Nat;
        unsealed_receipts_per_post : Nat16;
        outbox_count : Nat;
        outbox_bytes : Nat;
        caller_rate_window_count : Nat;
        caller_rate_window_bytes : Nat;
        fanout_job_count : Nat;
        fanout_target_count : Nat;
        fanout_bytes : Nat;
        ingress_receipt_count : Nat;
        certified_object_count : Nat;
        certified_object_bytes : Nat;
        publication_receipt_count : Nat;
    };

    public type ProtocolLimits = {
        profile_body_bytes : Nat32;
        profile_avatar_bytes : Nat32;
        post_body_bytes : Nat32;
        immutable_action_bytes : Nat32;
        like_batch_bytes : Nat32;
        like_head_bytes : Nat32;
        reply_index_bytes : Nat32;
        proof_snapshot_bytes : Nat32;
        certified_like_receipt_bytes : Nat32;
        delivery_request_bytes : Nat32;
        publication_batch_objects : Nat8;
        publication_batch_bytes : Nat32;
        staged_block_bytes : Nat32;
        staged_block_count : Nat8;
        like_batch_receipts : Nat16;
        active_like_receipts : Nat16;
        fanout_call_batch : Nat8;
    };

    public type RetentionPolicy = {
        peer_records_ns : Nat64;
        likes_ns : Nat64;
        rate_window_ns : Nat64;
        publication_receipts_ns : Nat64;
        uncertain_retry_delay_ns : Nat64;
    };

    public type Mem = {
        var installation : InstallationState;
        var profile : ?ProfileState;
        var quota_limits : QuotaLimits;
        var protocol_limits : ProtocolLimits;
        var retention : RetentionPolicy;

        // Zero means no value has been allocated yet. Allocation increments
        // before assignment; wire fixtures, not this storage convention,
        // determine any externally visible sequence semantics.
        var state_revision : Nat64;
        var relationship_revision : Nat64;
        // These two fields are the exact durable FollowerCounters projection
        // used by the relationship/outbox atomic commit adapter.
        var follower_revision : Nat64;
        var feed_revision : Nat64;
        var notification_revision : Nat64;
        var author_sequence : Nat64;
        var feed_sequence : Nat64;
        var notification_sequence : Nat64;
        var outbox_sequence : Nat64;
        var accepted_like_sequence : Nat64;
        var follower_registration_sequence : Nat64;
        var fanout_sequence : Nat64;
        var publication_sequence : Nat64;
        // Collision-free suffix for the shared retention_order index. This is
        // monotonic for the lifetime of the memory schema and MUST NOT be
        // derived from a live-row count because cleanup decreases counts.
        var retention_sequence : Nat64;
        var cleanup_epoch : Nat64;

        following : Map.Map<Principal, FollowingRecord>;
        followers : Map.Map<Principal, FollowerRecord>;
        followers_by_registration : Map.Map<Nat64, Principal>;
        blocks : Map.Map<Principal, BlockRecord>;

        authored_posts : Map.Map<StableKey, AuthoredPost>;
        authored_post_order : Map.Map<Nat64, StableKey>;
        authored_actions : Map.Map<StableKey, AuthoredAction>;
        authored_action_order : Map.Map<Nat64, StableKey>;
        shares_by_original_post : Map.Map<StableKey, StableKey>;
        outgoing_likes_by_post :
            Map.Map<StableKey, OutgoingLikeMarker>;
        tombstones_by_post : Map.Map<StableKey, StableKey>;

        feed_candidates : Map.Map<StableKey, FeedCandidate>;
        feed_order : Map.Map<Nat64, StableKey>;
        unread_feed_candidates : Map.Map<StableKey, ()>;
        candidate_pressure_by_sender : Map.Map<Principal, CandidatePressure>;
        verified_feed : Map.Map<StableKey, VerifiedFeedRecord>;
        share_attributions : Map.Map<StableKey, ShareAttribution>;
        suppressions : Map.Map<StableKey, SuppressionRecord>;
        tombstone_relays : Map.Map<StableKey, TombstoneRelay>;

        notifications : Map.Map<Nat64, NotificationSummary>;
        notification_order : Map.Map<Nat64, ()>;
        notification_evidence : Map.Map<Nat64, NotificationEvidence>;
        notification_by_semantic : Map.Map<StableKey, Nat64>;
        unread_notifications : Map.Map<Nat64, ()>;
        notice_semantics : Map.Map<StableKey, NoticeSemanticReceipt>;
        notice_pressure_by_caller : Map.Map<Principal, NoticePressure>;
        notice_count_by_target : Map.Map<StableKey, Nat>;

        accepted_likes : Map.Map<StableKey, AcceptedLike>;
        accepted_likes_by_sequence : Map.Map<Nat64, StableKey>;
        // Exact O(1) guard used by phased authored-post revocation. A key is
        // absent iff every retained accepted-Like row for that post is gone.
        accepted_like_count_by_post : Map.Map<StableKey, Nat>;
        like_states : Map.Map<StableKey, PostLikeState>;
        like_heads : Map.Map<StableKey, LikeHeadState>;
        reply_indexes : Map.Map<StableKey, ReplyIndexState>;
        sealed_like_batches : Map.Map<StableKey, SealedLikeBatch>;
        sealed_batches_by_post_number : Map.Map<StableKey, StableKey>;

        ingress_receipts : Map.Map<StableKey, IngressReceipt>;
        caller_rate_windows : Map.Map<StableKey, CallerRateWindow>;

        outbox : Map.Map<Nat64, OutboxItem>;
        outbox_metadata : Map.Map<Nat64, OutboxMetadata>;
        outbox_by_retry_time : Map.Map<OrderedTimeKey, Nat64>;
        outbox_by_operation : Map.Map<OutboxOperationKey, Nat64>;
        var outbox_control : OutboxControl;
        fanout_jobs : Map.Map<Nat64, FanoutJob>;
        fanout_targets : Map.Map<StableKey, FanoutTarget>;
        // Exact bounded proof that a terminal fanout job no longer owns any
        // target rows. Every job has one entry, including zero-target jobs.
        fanout_target_count_by_job : Map.Map<Nat64, Nat>;
        // Exact bounded reverse proof that no durable outbox or fanout job
        // still references an authored object key.
        authored_dependency_count_by_key : Map.Map<StableKey, Nat>;
        var scheduler : SchedulerState;

        certified_collections : Map.Map<StableKey, CertifiedCollectionState>;
        certified_records : Map.Map<StableKey, CertifiedRecord>;
        certified_record_by_local_object : Map.Map<StableKey, StableKey>;
        publications : Map.Map<Nat64, CertifiedPublication>;
        publication_by_nonce : Map.Map<StableKey, Nat64>;
        publication_by_target : Map.Map<StableKey, Nat64>;
        publication_reconcile_order : Map.Map<OrderedTimeKey, Nat64>;
        var active_stage_publication : ?Nat64;
        retention_order : Map.Map<RetentionIndexKey, RetentionRecordRef>;
        // Canonical app-internal RetentionRecordRef key -> the one current
        // cleanup index key. Renew/register replaces both maps atomically;
        // this prevents route-rate renewals from accumulating stale entries.
        retention_current : Map.Map<StableKey, RetentionIndexKey>;

        var following_count : Nat;
        var follower_head_count : Nat;
        var follower_head_bytes : Nat;
        var active_follower_count : Nat;
        var block_count : Nat;
        var authored_post_count : Nat;
        var authored_action_count : Nat;
        var authored_bytes : Nat;
        var candidate_count : Nat;
        var candidate_bytes : Nat;
        var verified_feed_count : Nat;
        var verified_feed_bytes : Nat;
        var share_attribution_count : Nat;
        var share_attribution_bytes : Nat;
        var suppression_count : Nat;
        var suppression_bytes : Nat;
        var tombstone_relay_count : Nat;
        var tombstone_relay_bytes : Nat;
        var unread_feed_count : Nat;
        var notification_count : Nat;
        var notification_bytes : Nat;
        var unread_notification_count : Nat;
        var accepted_like_count : Nat;
        var accepted_like_bytes : Nat;
        var outbox_count : Nat;
        var outbox_bytes : Nat;
        var caller_rate_window_count : Nat;
        var caller_rate_window_bytes : Nat;
        var fanout_job_count : Nat;
        var fanout_target_count : Nat;
        var fanout_bytes : Nat;
        var ingress_receipt_count : Nat;
        var ingress_receipt_bytes : Nat;
        var certified_object_count : Nat;
        var certified_object_bytes : Nat;
        var publication_receipt_count : Nat;
        var publication_receipt_bytes : Nat;
        // One-target delete receipts occupy the kernel's per-record
        // revocation lane, never the 4,096-entry positive-publication lane.
        var revocation_receipt_count : Nat;
        var revocation_receipt_bytes : Nat;
    };

    public func init() : Mem {
        {
            var installation = #uninitialized;
            var profile = null;
            var quota_limits = {
                following_count = 5_000;
                follower_head_count = 100_000;
                follower_head_bytes = 67_108_864;
                active_follower_count = 10_000;
                block_count = 10_000;
                authored_record_count = 100_000;
                authored_bytes = 1_073_741_824;
                candidate_count = 100_000;
                candidate_bytes = 1_073_741_824;
                candidates_per_sender = 10_000;
                verified_feed_count = 100_000;
                verified_feed_bytes = 1_073_741_824;
                share_attribution_count = 100_000;
                share_attribution_bytes = 1_073_741_824;
                suppression_count = 100_000;
                suppression_bytes = 1_073_741_824;
                tombstone_relay_count = 100_000;
                tombstone_relay_bytes = 67_108_864;
                notification_count = 100_000;
                notification_bytes = 1_073_741_824;
                notices_per_caller = 2_000;
                notices_per_target_post = 10_000;
                notice_semantics_per_caller_hour = 60;
                reaction_receipt_count = 100_000;
                reaction_receipt_bytes = 1_073_741_824;
                unsealed_receipts_per_post = 299;
                outbox_count = 100_000;
                outbox_bytes = 1_073_741_824;
                caller_rate_window_count = 100_000;
                caller_rate_window_bytes = 67_108_864;
                fanout_job_count = 100_000;
                fanout_target_count = 100_000;
                fanout_bytes = 1_073_741_824;
                ingress_receipt_count = 500_000;
                certified_object_count = 100_000;
                certified_object_bytes = 1_073_741_824;
                publication_receipt_count = 4_096;
            };
            var protocol_limits = {
                profile_body_bytes = 266_240;
                profile_avatar_bytes = 262_144;
                post_body_bytes = 1_044_480;
                immutable_action_bytes = 1_048_576;
                like_batch_bytes = 983_040;
                like_head_bytes = 4_096;
                reply_index_bytes = 1_044_480;
                proof_snapshot_bytes = 5_500;
                certified_like_receipt_bytes = 6_000;
                delivery_request_bytes = 16_384;
                publication_batch_objects = 16;
                publication_batch_bytes = 1_048_576;
                staged_block_bytes = 65_536;
                staged_block_count = 16;
                like_batch_receipts = 150;
                active_like_receipts = 149;
                fanout_call_batch = 20;
            };
            var retention = {
                // 400 days.
                peer_records_ns = 34_560_000_000_000_000;
                // Five 365-day years. A future calendar-based policy belongs
                // in a new memory schema rather than changing this value.
                likes_ns = 157_680_000_000_000_000;
                rate_window_ns = 3_600_000_000_000;
                publication_receipts_ns = 86_400_000_000_000;
                uncertain_retry_delay_ns = 300_000_000_000;
            };

            var state_revision = 0;
            var relationship_revision = 0;
            var follower_revision = 0;
            var feed_revision = 0;
            var notification_revision = 0;
            var author_sequence = 0;
            var feed_sequence = 0;
            var notification_sequence = 0;
            var outbox_sequence = 0;
            var accepted_like_sequence = 0;
            var follower_registration_sequence = 0;
            var fanout_sequence = 0;
            var publication_sequence = 0;
            var retention_sequence = 0;
            var cleanup_epoch = 0;

            following = Map.empty<Principal, FollowingRecord>();
            followers = Map.empty<Principal, FollowerRecord>();
            followers_by_registration = Map.empty<Nat64, Principal>();
            blocks = Map.empty<Principal, BlockRecord>();

            authored_posts = Map.empty<StableKey, AuthoredPost>();
            authored_post_order = Map.empty<Nat64, StableKey>();
            authored_actions = Map.empty<StableKey, AuthoredAction>();
            authored_action_order = Map.empty<Nat64, StableKey>();
            shares_by_original_post = Map.empty<StableKey, StableKey>();
            outgoing_likes_by_post =
                Map.empty<StableKey, OutgoingLikeMarker>();
            tombstones_by_post = Map.empty<StableKey, StableKey>();

            feed_candidates = Map.empty<StableKey, FeedCandidate>();
            feed_order = Map.empty<Nat64, StableKey>();
            unread_feed_candidates = Map.empty<StableKey, ()>();
            candidate_pressure_by_sender =
                Map.empty<Principal, CandidatePressure>();
            verified_feed = Map.empty<StableKey, VerifiedFeedRecord>();
            share_attributions = Map.empty<StableKey, ShareAttribution>();
            suppressions = Map.empty<StableKey, SuppressionRecord>();
            tombstone_relays = Map.empty<StableKey, TombstoneRelay>();

            notifications = Map.empty<Nat64, NotificationSummary>();
            notification_order = Map.empty<Nat64, ()>();
            notification_evidence = Map.empty<Nat64, NotificationEvidence>();
            notification_by_semantic = Map.empty<StableKey, Nat64>();
            unread_notifications = Map.empty<Nat64, ()>();
            notice_semantics = Map.empty<StableKey, NoticeSemanticReceipt>();
            notice_pressure_by_caller =
                Map.empty<Principal, NoticePressure>();
            notice_count_by_target = Map.empty<StableKey, Nat>();

            accepted_likes = Map.empty<StableKey, AcceptedLike>();
            accepted_likes_by_sequence = Map.empty<Nat64, StableKey>();
            accepted_like_count_by_post = Map.empty<StableKey, Nat>();
            like_states = Map.empty<StableKey, PostLikeState>();
            like_heads = Map.empty<StableKey, LikeHeadState>();
            reply_indexes = Map.empty<StableKey, ReplyIndexState>();
            sealed_like_batches = Map.empty<StableKey, SealedLikeBatch>();
            sealed_batches_by_post_number =
                Map.empty<StableKey, StableKey>();

            ingress_receipts = Map.empty<StableKey, IngressReceipt>();
            caller_rate_windows = Map.empty<StableKey, CallerRateWindow>();

            outbox = Map.empty<Nat64, OutboxItem>();
            outbox_metadata = Map.empty<Nat64, OutboxMetadata>();
            outbox_by_retry_time = Map.empty<OrderedTimeKey, Nat64>();
            outbox_by_operation = Map.empty<OutboxOperationKey, Nat64>();
            var outbox_control = {
                revision = 0;
                pause = null;
            };
            fanout_jobs = Map.empty<Nat64, FanoutJob>();
            fanout_targets = Map.empty<StableKey, FanoutTarget>();
            fanout_target_count_by_job = Map.empty<Nat64, Nat>();
            authored_dependency_count_by_key =
                Map.empty<StableKey, Nat>();
            var scheduler = {
                running = false;
                run_generation = 0;
                started_at_ns = null;
                outbox_after_sequence = null;
                fanout_after_job_id = null;
                like_seal_after_post_key = null;
            };

            certified_collections =
                Map.empty<StableKey, CertifiedCollectionState>();
            certified_records = Map.empty<StableKey, CertifiedRecord>();
            certified_record_by_local_object =
                Map.empty<StableKey, StableKey>();
            publications = Map.empty<Nat64, CertifiedPublication>();
            publication_by_nonce = Map.empty<StableKey, Nat64>();
            publication_by_target = Map.empty<StableKey, Nat64>();
            publication_reconcile_order =
                Map.empty<OrderedTimeKey, Nat64>();
            var active_stage_publication = null;
            retention_order =
                Map.empty<RetentionIndexKey, RetentionRecordRef>();
            retention_current =
                Map.empty<StableKey, RetentionIndexKey>();

            var following_count = 0;
            var follower_head_count = 0;
            var follower_head_bytes = 0;
            var active_follower_count = 0;
            var block_count = 0;
            var authored_post_count = 0;
            var authored_action_count = 0;
            var authored_bytes = 0;
            var candidate_count = 0;
            var candidate_bytes = 0;
            var verified_feed_count = 0;
            var verified_feed_bytes = 0;
            var share_attribution_count = 0;
            var share_attribution_bytes = 0;
            var suppression_count = 0;
            var suppression_bytes = 0;
            var tombstone_relay_count = 0;
            var tombstone_relay_bytes = 0;
            var unread_feed_count = 0;
            var notification_count = 0;
            var notification_bytes = 0;
            var unread_notification_count = 0;
            var accepted_like_count = 0;
            var accepted_like_bytes = 0;
            var outbox_count = 0;
            var outbox_bytes = 0;
            var caller_rate_window_count = 0;
            var caller_rate_window_bytes = 0;
            var fanout_job_count = 0;
            var fanout_target_count = 0;
            var fanout_bytes = 0;
            var ingress_receipt_count = 0;
            var ingress_receipt_bytes = 0;
            var certified_object_count = 0;
            var certified_object_bytes = 0;
            var publication_receipt_count = 0;
            var publication_receipt_bytes = 0;
            var revocation_receipt_count = 0;
            var revocation_receipt_bytes = 0;
        };
    };
};
