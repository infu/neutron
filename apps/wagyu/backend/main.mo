import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Int "mo:core/Int";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Order "mo:core/Order";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Time "mo:core/Time";

import NeutronCapabilities "mo:neutron-capabilities";

import Planner "./actions/Planner";
import Publication "./actions/Publication";
import ClosingService "./closing/Service";
import ClosingTypes "./closing/Types";
import FanoutPlanner "./fanout/Planner";
import FanoutScheduler "./fanout/Scheduler";
import FeedPromotion "./feed/Promotion";
import FeedService "./feed/Service";
import FeedTypes "./feed/Types";
import FeedVisibility "./feed/Visibility";
import IngressService "./ingress/Service";
import IngressTypes "./ingress/Types";
import LikeAdmission "./likes/Admission";
import LikeSealing "./likes/Sealing";
import PristineMemory "./memory/Pristine";
import Memory "./memory/wagyu/v3";
import NotificationService "./notifications/Service";
import NotificationTypes "./notifications/Types";
import OutboxService "./outbox/Service";
import OutboxTypes "./outbox/Types";
import OwnerBridge "./owner_bridge/Codec";
import OwnerBridgeTypes "./owner_bridge/Types";
import Paging "./paging/Service";
import PublicationJournal "./publication/Journal";
import PublicationReconciliation "./publication/Reconciliation";
import Bounds "./protocol/Bounds";
import Hash "./protocol/Hash";
import Path "./protocol/Path";
import Protocol "./protocol/Types";
import Validation "./protocol/Validation";
import Wire "./protocol/Wire";
import RelationshipService "./relationships/Service";
import RelationshipTypes "./relationships/Types";
import ReplyAdmission "./replies/Admission";
import RetentionService "./retention/Service";
import RetentionTypes "./retention/Types";
import Dispatcher "./transport/Dispatcher";
import TransportTypes "./transport/Types";

module {
    // Public method types are deliberately defined in this module rather than
    // exported as aliases to an imported module. The package schema generator
    // resolves only local public definitions.
    public type EmptyRequestV1 = {};

    public type ActionKindV1 = {
        #post;
        #share;
        #tombstone;
        #like;
    };

    public type CertifiedHttpProofV1 = {
        certificate_version : Nat8;
        certificate_cbor : Blob;
        witness_cbor : Blob;
        expression_path_cbor : Blob;
        certificate_time_ns : Nat64;
    };

    public type ReplyLocatorV1 = {
        author : Principal;
        post_id : Blob;
        body_hash : Blob;
        body_length : Nat32;
        object_digest : Blob;
    };

    public type CertifiedPostRefV1 = {
        author : Principal;
        post_id : Blob;
        body_hash : Blob;
        body_length : Nat32;
        object_digest : Blob;
        proof : CertifiedHttpProofV1;
    };

    public type AvatarMediaTypeV1 = {
        #jpeg;
        #png;
        #webp;
    };

    public type ProfileEditAvatarV1 = {
        media_type : ?AvatarMediaTypeV1;
        width : Nat16;
        height : Nat16;
        bytes : Blob;
    };

    public type ProfileEditRequestV1 = {
        expected_profile_generation : Nat64;
        expected_revision : Nat64;
        display_name : Text;
        description : Text;
        avatar : ?ProfileEditAvatarV1;
    };

    public type ProfileEditRejectionReasonV1 = {
        #invalid;
        #full;
        #low_cycles;
    };

    public type ProfileEditOutcomeV1 = {
        #updated : {
            profile_generation : Nat64;
            revision : Nat64;
            body_digest : Blob;
        };
        #conflict : {
            current_generation : Nat64;
            current_revision : Nat64;
        };
        #rejected : {
            reason : ?ProfileEditRejectionReasonV1;
        };
    };

    public type ProfileEditResultV1 = {
        outcome : ?ProfileEditOutcomeV1;
    };

    public type FeedPageRequestV1 = {
        before_sequence : ?Nat64;
        limit : Nat16;
    };

    public type FeedEventKindV1 = {
        #original;
        #share;
        #tombstone;
    };

    public type VerificationStateV1 = {
        #pending;
        #verified;
        #invalid;
        #unavailable;
    };

    public type FeedCandidateSummaryV1 = {
        candidate_id : Blob;
        local_sequence : Nat64;
        received_at_ns : Nat64;
        immediate_sender : Principal;
        event_kind : ?FeedEventKindV1;
        claimed_author : Principal;
        claimed_post_id : Blob;
        exact_event_candid : Blob;
        verification : ?VerificationStateV1;
    };

    public type FeedPageV1 = {
        revision : Nat64;
        items : [FeedCandidateSummaryV1];
        next_before_sequence : ?Nat64;
    };

    public type DirectedActionSummaryV1 = {
        target_post_id : Blob;
        target_body_hash : Blob;
        action_id : Blob;
        object_digest : Blob;
        object_length : Nat32;
    };

    public type NotificationKindV1 = {
        #new_follower : {
            follower_revision : Nat64;
        };
        #like : DirectedActionSummaryV1;
        #reply : DirectedActionSummaryV1;
        #share : DirectedActionSummaryV1;
    };

    public type NotificationVerificationV1 = {
        #transport_authenticated;
        #pending;
        #verified;
        #invalid;
        #unavailable;
    };

    public type NotificationSummaryV1 = {
        local_sequence : Nat64;
        received_at_ns : Nat64;
        actor_ : Principal;
        kind : ?NotificationKindV1;
        verification : ?NotificationVerificationV1;
        read : Bool;
    };

    public type NotificationPageRequestV1 = {
        before_sequence : ?Nat64;
        limit : Nat16;
    };

    public type NotificationPageV1 = {
        revision : Nat64;
        items : [NotificationSummaryV1];
        next_before_sequence : ?Nat64;
    };

    public type NotificationEvidenceRequestV1 = {
        local_sequence : Nat64;
    };

    public type NotificationEvidenceKindV1 = {
        #like : {
            certified_like_receipt_candid : Blob;
        };
    };

    public type NotificationEvidenceV1 = {
        local_sequence : Nat64;
        found : Bool;
        evidence : ?NotificationEvidenceKindV1;
    };

    public type SendKindV1 = {
        #post;
        #reply;
        #share;
        #tombstone;
    };

    public type SendQuoteRequestV1 = {
        send_kind : ?SendKindV1;
        estimated_object_bytes : Nat32;
        notice_target : ?Principal;
    };

    public type SendQuoteV1 = {
        follower_revision : Nat64;
        registered_follower_count : Nat32;
        eligible_delivery_count : Nat32;
        ineligible_follower_count : Nat32;
        eligible_recipient_preview : [Principal];
        receiver_floor_cycles : Nat;
        author_notice_floor_cycles : Nat;
        estimated_call_and_byte_cycles : Nat;
        estimated_local_publication_cycles : Nat;
        estimated_total_cycles : Nat;
    };

    public type FollowerStateV1 = {
        #active : {
            subscription_id : Blob;
            lease_expires_ns : Nat64;
            delivery_credits : Nat16;
        };
        #inactive : {
            last_subscription_id : Blob;
        };
    };

    public type FollowerHeadV1 = {
        revision : Nat64;
        state : ?FollowerStateV1;
    };

    public type WagyuRejectionReasonV1 = {
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
            reason : ?WagyuRejectionReasonV1;
        };
    };

    public type WagyuRouteResultV1 = {
        outcome : ?WagyuRouteOutcomeV1;
        local_receipt_time_ns : ?Nat64;
        revision : ?Nat64;
        relationship : ?FollowerHeadV1;
    };

    public type UnfollowRouteResultV1 = {
        outcome : ?WagyuRouteOutcomeV1;
        revision : ?Nat64;
    };

    public type WagyuIngressV1 = {
        operation_id : Blob;
        body_candid : Blob;
    };

    public type PauseReasonV1 = {
        #low_cycles;
        #revoked;
        #rate_limited;
        #incompatible;
        #handler_failure;
        #maintenance;
    };

    public type WagyuStatusV1 = {
        node : Principal;
        network_id : Text;
        protocol : Text;
        profile_generation : Nat64;
        profile_revision : Nat64;
        state_revision : Nat64;
        feed_revision : Nat64;
        notification_revision : Nat64;
        relationship_revision : Nat64;
        unread_feed_count : Nat;
        unread_notification_count : Nat;
        outbound_work_pending : Bool;
        outbox_queued_count : Nat;
        outbox_error_count : Nat;
        outbox_paused : Bool;
        pause_reason : ?PauseReasonV1;
        certified_assets_ready : Bool;
        release_gate_message : ?Text;
    };

    public type ProfileViewV1 = {
        node : Principal;
        network_id : Text;
        profile_generation : Nat64;
        revision : Nat64;
        updated_at_ns : Nat64;
        display_name : Text;
        description : Text;
        avatar_present : Bool;
        avatar_media_type : ?AvatarMediaTypeV1;
        avatar_width : ?Nat16;
        avatar_height : ?Nat16;
        protocol : Text;
        compatible : Bool;
    };

    public type RelationshipStateV1 = {
        #registering;
        #active;
        #credit_low;
        #expired;
        #cleanup_pending;
        #incompatible;
        #blocked;
    };

    public type RelationshipSummaryV1 = {
        node : Principal;
        following : Bool;
        follower : Bool;
        following_state : ?RelationshipStateV1;
        follower_state : ?RelationshipStateV1;
        follower_delivery_credits : Nat16;
        follower_lease_expires_ns : ?Nat64;
        following_renewal_requested : Bool;
        following_auto_renew_due : Bool;
        blocked : Bool;
        bond_cycles : Nat;
        protocol : Text;
        compatible : Bool;
    };

    public type RelationshipsV1 = {
        revision : Nat64;
        items : [RelationshipSummaryV1];
        next_before_node : ?Principal;
    };

    public type RelationshipPageRequestV1 = {
        before_node : ?Principal;
        expected_revision : ?Nat64;
        limit : Nat16;
    };

    public type BlockStatusesSelfRequestV1 = {
        nodes : [Principal];
    };

    public type BlockStatusSelfV1 = {
        node : Principal;
        blocked : Bool;
    };

    public type BlockStatusesSelfOutputV1 = {
        relationship_revision : Nat64;
        items : [BlockStatusSelfV1];
    };

    public type NodeRequestV1 = {
        node : Principal;
    };

    public type FollowRequestV1 = {
        node : Principal;
        subscription_id : Blob;
    };

    public type LocalErrorV1 = {
        #not_configured;
        #invalid;
        #conflict;
        #not_found;
        #full;
        #certified_store;
        #proof_invalid;
        #unsupported;
        #busy;
    };

    public type LocalResultV1<T> = {
        #ok : T;
        #err : LocalErrorV1;
    };

    public type RelationshipSummaryLocalResultV1 = {
        #ok : RelationshipSummaryV1;
        #err : LocalErrorV1;
    };

    public type PublishLocalResultV1 = {
        #ok : PublishResultV1;
        #err : LocalErrorV1;
    };

    public type Nat64LocalResultV1 = {
        #ok : Nat64;
        #err : LocalErrorV1;
    };

    public type FeedPageSelfRequestV1 = {
        before_sequence : ?Nat64;
        limit : Nat16;
    };

    public type FeedPageSelfValueV1 = {
        revision : Nat64;
        item_count : Nat16;
        body_bytes : Nat32;
        body_digest_hex : Text;
    };

    public type FeedPageSelfOutputV1 = {
        value : FeedPageSelfValueV1;
        body : Blob;
    };

    public type NotificationPageSelfRequestV1 = {
        before_sequence : ?Nat64;
        limit : Nat16;
    };

    public type NotificationPageSelfValueV1 = {
        revision : Nat64;
        item_count : Nat16;
        body_bytes : Nat32;
        body_digest_hex : Text;
    };

    public type NotificationPageSelfOutputV1 = {
        value : NotificationPageSelfValueV1;
        body : Blob;
    };

    public type NotificationEvidenceSelfRequestV1 = {
        local_sequence : Nat64;
    };

    public type NotificationEvidenceSelfValueV1 = {
        local_sequence : Nat64;
        found : Bool;
        body_bytes : Nat32;
        body_digest_hex : Text;
    };

    public type NotificationEvidenceSelfOutputV1 = {
        value : NotificationEvidenceSelfValueV1;
        body : Blob;
    };

    public type PublishSelfResultV1 = {
        stage : ?PublishStageV1;
        post_id_hex : ?Text;
        action_id_hex : ?Text;
        object_digest_hex : ?Text;
        queued_recipient_count : Nat32;
        queued_notice_count : Nat32;
        accepted_recipient_count : Nat32;
        failed_recipient_count : Nat32;
        message : Text;
    };

    public type PublishSelfLocalResultV1 = {
        #ok : PublishSelfResultV1;
        #err : LocalErrorV1;
    };

    public type FollowSelfRequestV1 = {
        node : Principal;
        subscription_id_hex : Text;
    };

    public type ReplyLocatorSelfV1 = {
        author : Principal;
        post_id_hex : Text;
        body_hash_hex : Text;
        body_length : Nat32;
        object_digest_hex : Text;
    };

    public type PostPrepareSelfRequestV1 = {
        body_markdown : Text;
        nonce_hex : Text;
        reply_to : ?ReplyLocatorSelfV1;
    };

    public type SharePrepareSelfRequestV1 = {
        nonce_hex : ?Text;
        exact_original_post_ref_candid : Blob;
    };

    public type LikePrepareSelfRequestV1 = {
        post_author : Principal;
        post_id_hex : Text;
        post_body_hash_hex : Text;
        post_object_digest_hex : ?Text;
        nonce_hex : Text;
    };

    public type TombstonePrepareSelfRequestV1 = {
        post_id_hex : Text;
        nonce_hex : Text;
    };

    public type FinalizeSelfRequestV1 = {
        action_id_hex : Text;
        object_digest_hex : Text;
        exact_proof_candid : Blob;
    };

    public type FeedPromoteSelfRequestV1 = {
        candidate_id_hex : Text;
        verified_author : Principal;
        verified_post_id_hex : Text;
        verified_body_hash_hex : Text;
        verified_object_digest_hex : Text;
    };

    public type FeedRejectSelfRequestV1 = {
        candidate_id_hex : Text;
        disposition : ?FeedRejectDispositionV1;
    };

    public type NotificationDispositionSelfV1 = {
        #verified;
        #invalid;
        #unavailable;
    };

    public type VerifiedReplySelfV1 = {
        author : Principal;
        post_id_hex : Text;
        body_hash_hex : Text;
        body_length : Nat32;
        object_digest_hex : Text;
        reply_to : ReplyLocatorSelfV1;
    };

    public type NotificationPromoteSelfRequestV1 = {
        local_sequence : Nat64;
        disposition : ?NotificationDispositionSelfV1;
        verified_reply : ?VerifiedReplySelfV1;
    };

    public type LikeSealSelfRequestV1 = {
        post_id_hex : Text;
        final_partial : Bool;
    };

    public type WithdrawalAdvanceSelfRequestV1 = {
        post_id_hex : Text;
        nonce_hex : Text;
    };

    public type PostPublishRequestV1 = {
        body_markdown : Text;
        nonce : Blob;
        reply_to : ?ReplyLocatorV1;
    };

    public type SharePublishRequestV1 = {
        original_post_ref_candid : Blob;
        nonce : ?Blob;
    };

    public type LikePublishRequestV1 = {
        post_author : Principal;
        post_id : Blob;
        post_body_hash : ?Blob;
        body_digest : ?Blob;
        nonce : Blob;
    };

    public type PublishStageV1 = {
        #awaiting_proof;
        #certified_ref_ready;
        #fanout_queued;
        #complete;
        #partial;
        #failed;
        #uncertain;
    };

    public type PublishResultV1 = {
        stage : ?PublishStageV1;
        post_id : ?Blob;
        action_id : ?Blob;
        object_digest : ?Blob;
        queued_recipient_count : Nat32;
        queued_notice_count : Nat32;
        accepted_recipient_count : Nat32;
        failed_recipient_count : Nat32;
        message : Text;
    };

    public type ActionFinalizeRequestV1 = {
        action_kind : ?ActionKindV1;
        action_id : Blob;
        object_digest : Blob;
        proof : CertifiedHttpProofV1;
    };

    public type PostDeleteRequestV1 = {
        post_id : Blob;
        nonce : Blob;
    };

    public type LikeSealRequestV1 = {
        post_id : Blob;
        final_partial : Bool;
    };

    public type FeedPromoteRequestV1 = {
        candidate_id : Blob;
        verified_author : Principal;
        verified_post_id : Blob;
        verified_body_hash : Blob;
        verified_object_digest : Blob;
    };

    public type FeedRejectDispositionV1 = {
        #invalid;
        #unavailable;
    };

    public type FeedRejectRequestV1 = {
        candidate_id : Blob;
        disposition : ?FeedRejectDispositionV1;
    };

    public type NotificationPromoteRequestV1 = {
        local_sequence : Nat64;
        verification : ?NotificationVerificationV1;
    };

    public type NotificationsMarkReadRequestV1 = {
        local_sequences : [Nat64];
    };

    public type AuthoredPageRequestV1 = {
        before_sequence : ?Nat64;
        limit : Nat16;
    };

    // Owner-local, structurally accepted receipts are deliberately separate
    // from browser-verified sealed Like totals.
    public type AuthoredSummaryV1 = {
        sequence : Nat64;
        action_kind : ?ActionKindV1;
        action_id : Text;
        object_digest : Text;
        state : Text;
        created_at_ns : Nat64;
        body_markdown : ?Text;
        body_length : ?Nat32;
        reply_to : ?{
            author : Principal;
            post_id : Text;
        };
        target_post_id : ?Text;
        local_like_view : ?{
            post_body_hash_hex : Text;
            unsealed_receipt_count : Nat16;
            unsealed_liker_ids : [Principal];
        };
    };

    public type AuthoredPageV1 = {
        revision : Nat64;
        items : [AuthoredSummaryV1];
        next_before_sequence : ?Nat64;
    };

    public type OutboxStateV1 = {
        #queued;
        #sending;
        #accepted;
        #duplicate;
        #paused;
        #failed;
        #uncertain;
        #superseded;
    };

    public type OutboxRouteV1 = {
        #follow;
        #unfollow;
        #deliver;
        #like;
        #notice;
    };

    public type FanoutStateV1 = {
        #queued;
        #scanning;
        #sending;
        #complete;
        #partial;
        #paused;
        #failed;
    };

    public type FanoutProgressV1 = {
        job_id : Nat64;
        state : ?FanoutStateV1;
        eligible_recipient_count : Nat32;
        queued_recipient_count : Nat32;
        completed_recipient_count : Nat32;
        terminal_recipient_count : Nat32;
        uncertain_recipient_count : Nat32;
    };

    public type OutboxPageRequestV1 = {
        before_sequence : ?Nat64;
        expected_revision : ?Nat64;
        limit : Nat16;
    };

    public type OutboxPageItemV1 = {
        local_sequence : Nat64;
        recipient : Principal;
        route : ?OutboxRouteV1;
        state : ?OutboxStateV1;
        attempt_count : Nat;
        retryable : Bool;
        next_retry_at_ns : ?Nat64;
        last_error : ?Text;
        created_at_ns : Nat64;
        updated_at_ns : Nat64;
        fanout : ?FanoutProgressV1;
    };

    public type OutboxPageV1 = {
        revision : Nat64;
        items : [OutboxPageItemV1];
        next_before_sequence : ?Nat64;
    };

    public type OutboxDrainRequestV1 = {
        limit : Nat16;
    };

    public type OutboxRetryRequestV1 = {
        local_sequence : Nat64;
    };

    public type OutboxDrainResultV1 = {
        state_revision : Nat64;
        outbox_revision : Nat64;
        attempted : Nat;
        completed : Nat;
        remaining : Nat;
        errors : Nat;
        paused : Bool;
        pause_reason : ?PauseReasonV1;
    };

    public type TaskCapabilities = {
        backend_calls : NeutronCapabilities.BackendCallsV1;
    };

    public type AppBackendEnvironment = {
        installation : {
            network_id : Blob;
        };
        stable_memory : {
            wagyu : Memory.Mem;
        };
        capabilities : {
            backend_calls : NeutronCapabilities.BackendCallsV1;
            deferred_timers : NeutronCapabilities.DeferredTimersV1;
            certified_assets : NeutronCapabilities.CertifiedAssetsV2;
        };
    };

    public class Init(
        env : AppBackendEnvironment,
    ) {
        let mem = env.stable_memory.wagyu;
        let backendCalls = env.capabilities.backend_calls;
        let deferredTimers = env.capabilities.deferred_timers;
        let certifiedAssets = env.capabilities.certified_assets;
        let node = backendCalls.canister_principal;
        let trustedNetworkId = env.installation.network_id;
        let PROTOCOL = "wagyu_v1";
        let RELEASE_GATE =
            "Certified Assets V2 production instruction/heap budgets remain unmeasured.";
        let MAX_INGRESS_RECEIPT_BYTES : Nat = 1_073_741_824;
        let MAX_PUBLICATION_RECEIPT_BYTES : Nat = 67_108_864;
        let MAX_REVOCATION_RECEIPT_BYTES : Nat = 268_435_456;
        let INGRESS_NOTIFICATION_ACCOUNTING_OVERHEAD : Nat = 512;
        let ACCEPTED_LIKE_ACCOUNTING_OVERHEAD : Nat = 512;
        let NOTICE_SEMANTIC_RETAINED_BYTES : Nat = 256;
        let OUTBOUND_SUMMARY_SCAN_LIMIT : Nat = 512;
        let MAX_BLOCK_STATUS_NODES : Nat = 500;
        let LIKE_SEAL_TIMER_KEY = "like_seal";
        let LIKE_SEAL_DELAY_SECONDS : Nat = 60;
        let MAX_LIKE_BATCHES_PER_TIMER : Nat = 8;
        // A cursor page may contain fewer visible rows when local Blocks hide
        // entries, but one query never examines an unbounded retained prefix.
        let MAX_LOCAL_PAGE_ROWS_EXAMINED : Nat = 256;
        type LikePromotionPlan = {
            mutation : IngressTypes.LikeMutation;
            action : Protocol.LikeActionV1;
            notification_sequence : Nat64;
            retention : RetentionTypes.RegistrationPlan;
        };
        type LikePromotionDecision = {
            #accepted : LikePromotionPlan;
            #duplicate;
        };
        type FeedRelayPlan = {
            relay : Memory.TombstoneRelay;
            fanout : Memory.FanoutJob;
        };
        type FeedRelayPlanResult = {
            #none;
            #planned : FeedRelayPlan;
            #blocked;
        };
        type FeedRetentionPlanResult = {
            #none;
            #planned : RetentionTypes.RegistrationPlan;
            #blocked;
        };
        var pendingOutboxMetadata : ?Memory.OutboxMetadata = null;
        var pendingFanoutTarget : ?Memory.FanoutTarget = null;
        var reconciledFollowingOutboxId : ?Nat64 = null;

        public func /*query*/wagyu_status(
            _request : EmptyRequestV1
        ) : WagyuStatusV1 {
            let profile = currentProfile();
            let pause = outboxPause();
            let outbox = outboxWorkSummary();
            let fanout = fanoutWorkSummary();
            {
                node;
                network_id = Path.hexLower(profile.network_id);
                protocol = PROTOCOL;
                profile_generation = profile.profile_generation;
                profile_revision = profile.revision;
                state_revision = mem.state_revision;
                feed_revision = mem.feed_revision;
                notification_revision = mem.notification_revision;
                relationship_revision = mem.relationship_revision;
                unread_feed_count = mem.unread_feed_count;
                unread_notification_count = mem.unread_notification_count;
                outbound_work_pending =
                    outbox.queued > 0 or
                    outbox.saturated or
                    fanout.pending or
                    fanout.saturated;
                outbox_queued_count = outbox.queued;
                outbox_error_count = outbox.errors;
                outbox_paused = pause != null;
                pause_reason = pause;
                certified_assets_ready = certifiedAssetsReady();
                release_gate_message = ?RELEASE_GATE;
            };
        };

        public func /*query*/wagyu_profile(
            _request : EmptyRequestV1
        ) : ProfileViewV1 {
            let profile = currentProfile();
            let (mediaType, width, height) = switch (profile.avatar) {
                case null (null, null, null);
                case (?avatar) (
                    mapAvatarMediaToPublic(avatar.media_type),
                    ?avatar.width,
                    ?avatar.height,
                );
            };
            {
                node = profile.node;
                network_id = Path.hexLower(profile.network_id);
                profile_generation = profile.profile_generation;
                revision = profile.revision;
                updated_at_ns = profile.updated_at_ns;
                display_name = profile.display_name;
                description = profile.description;
                avatar_present = profile.avatar != null;
                avatar_media_type = mediaType;
                avatar_width = width;
                avatar_height = height;
                protocol = PROTOCOL;
                compatible = networkConfigured();
            };
        };

        public func /*query*/wagyu_get_feed_page_v1(
            request : FeedPageRequestV1
        ) : FeedPageV1 {
            if (Nat16.toNat(request.limit) == 0 or Nat16.toNat(request.limit) > 25) {
                Runtime.trap("Feed page limit must be between 1 and 25");
            };
            feedPage(request);
        };

        public func /*query*/wagyu_get_notification_page_v1(
            request : NotificationPageRequestV1
        ) : NotificationPageV1 {
            if (Nat16.toNat(request.limit) == 0 or Nat16.toNat(request.limit) > 50) {
                Runtime.trap("Notification page limit must be between 1 and 50");
            };
            notificationPage(request);
        };

        public func /*query*/wagyu_get_notification_evidence_v1(
            request : NotificationEvidenceRequestV1
        ) : NotificationEvidenceV1 {
            let visible = switch (
                Map.get(
                    mem.notifications,
                    Nat64.compare,
                    request.local_sequence,
                )
            ) {
                case null false;
                case (?summary) {
                    FeedVisibility.allows(
                        summary.actor_,
                        null,
                        false,
                        isBlockedNode,
                    );
                };
            };
            if (not visible) {
                return {
                    local_sequence = request.local_sequence;
                    found = false;
                    evidence = null;
                };
            };
            switch (
                Map.get(
                    mem.notification_evidence,
                    Nat64.compare,
                    request.local_sequence,
                )
            ) {
                case (?#like(value)) {
                    {
                        local_sequence = request.local_sequence;
                        found = true;
                        evidence = ?#like({
                            certified_like_receipt_candid =
                                value.exact_certified_like_receipt_candid;
                        });
                    };
                };
                case null {
                    {
                        local_sequence = request.local_sequence;
                        found = false;
                        evidence = null;
                    };
                };
            };
        };

        public func /*query*/wagyu_get_send_quote_v1(
            request : SendQuoteRequestV1
        ) : SendQuoteV1 {
            sendQuote(request);
        };

        public func /*update*/wagyu_profile_edit_v1(
            request : ProfileEditRequestV1
        ) : ProfileEditResultV1 {
            profileEdit(request);
        };

        public func /*query*/wagyu_relationships(
            request : RelationshipPageRequestV1
        ) : RelationshipsV1 {
            relationshipPage(request);
        };

        public func /*update*/wagyu_follow(
            request : FollowRequestV1
        ) : RelationshipSummaryLocalResultV1 {
            ownerFollow(request);
        };

        public func /*update*/wagyu_unfollow(
            request : NodeRequestV1
        ) : RelationshipSummaryLocalResultV1 {
            ownerUnfollow(request);
        };

        public func /*update*/wagyu_block(
            request : NodeRequestV1
        ) : RelationshipSummaryLocalResultV1 {
            ownerBlock(request.node);
        };

        public func /*update*/wagyu_unblock(
            request : NodeRequestV1
        ) : RelationshipSummaryLocalResultV1 {
            ownerUnblock(request.node);
        };

        public func /*update*/wagyu_post_publish(
            request : PostPublishRequestV1
        ) : PublishLocalResultV1 {
            publishPost(request);
        };

        public func /*update*/wagyu_share_publish(
            request : SharePublishRequestV1
        ) : PublishLocalResultV1 {
            publishShare(request);
        };

        public func /*update*/wagyu_like_publish(
            request : LikePublishRequestV1
        ) : PublishLocalResultV1 {
            publishLike(request);
        };

        public func /*update*/wagyu_action_finalize(
            request : ActionFinalizeRequestV1
        ) : PublishLocalResultV1 {
            finalizeAction(request);
        };

        public func /*update*/wagyu_post_delete(
            request : PostDeleteRequestV1
        ) : PublishLocalResultV1 {
            publishTombstone(request);
        };

        public func /*update*/wagyu_like_seal(
            request : LikeSealRequestV1
        ) : PublishLocalResultV1 {
            sealDueLikeBatch(request);
        };

        public func /*update*/wagyu_withdrawal_advance(
            request : PostDeleteRequestV1
        ) : PublishLocalResultV1 {
            advanceWithdrawal(request);
        };

        public func /*update*/wagyu_feed_promote(
            request : FeedPromoteRequestV1
        ) : Nat64LocalResultV1 {
            promoteFeedCandidate(request);
        };

        public func /*update*/wagyu_feed_reject(
            request : FeedRejectRequestV1
        ) : Nat64LocalResultV1 {
            rejectFeedCandidate(request);
        };

        public func /*update*/wagyu_notification_promote(
            request : NotificationPromoteRequestV1
        ) : async* Nat64LocalResultV1 {
            await* updateNotificationVerificationAndArmLikeSeal(
                request.local_sequence,
                request.verification,
                null,
            );
        };

        public func /*update*/wagyu_notifications_mark_read(
            request : NotificationsMarkReadRequestV1
        ) : Nat64LocalResultV1 {
            markNotificationsRead(request.local_sequences);
        };

        public func /*query*/wagyu_authored_page(
            request : AuthoredPageRequestV1
        ) : AuthoredPageV1 {
            authoredPage(request);
        };

        public func /*query*/wagyu_outbox_page(
            request : OutboxPageRequestV1
        ) : OutboxPageV1 {
            outboxPage(request);
        };

        public func /*update*/wagyu_outbox_drain(
            request : OutboxDrainRequestV1
        ) : async* OutboxDrainResultV1 {
            await* drainOutbox(request.limit, #automatic, backendCalls);
        };

        public func /*update*/wagyu_outbox_retry(
            request : OutboxRetryRequestV1
        ) : async* OutboxDrainResultV1 {
            await* retryOutbox(request.local_sequence, backendCalls);
        };

        public func /*internal*/wagyu_outbox_tick(
            _request : (),
            /*task_capabilities*/ taskCapabilities : TaskCapabilities,
        ) : async* () {
            // The run-on-start task can be Wagyu's first durable call. Bind
            // the trusted installation before the scheduler mutates memory.
            let ?_installation = installationContext() else return;
            let tickTime = nowNs();
            if (mem.scheduler.running) {
                let stale = switch (mem.scheduler.started_at_ns) {
                    case null true;
                    case (?started) {
                        tickTime >= started and
                        tickTime - started >=
                            TransportTypes.UNCERTAIN_RETRY_DELAY_NS;
                    };
                };
                if (not stale) return;
                // A persisted running bit beyond the uncertain window means
                // an upgrade/lost continuation. The bounded drain below
                // recovers old #sending rows as may-have-dispatched.
                mem.scheduler := {
                    mem.scheduler with
                    running = false;
                    started_at_ns = null;
                };
            };
            mem.scheduler := {
                mem.scheduler with
                running = true;
                run_generation = nextRevision(
                    mem.scheduler.run_generation
                );
                started_at_ns = ?tickTime;
            };
            expireOutboxBatch(
                taskCapabilities.backend_calls,
                tickTime,
            );
            sealDueLikeBatches(MAX_LIKE_BATCHES_PER_TIMER);
            ignore cleanupCommittedPublications(
                tickTime,
                RetentionService.MAX_CLEANUP_PAGE,
            );
            ignore revokeOneDueRetainedObject(tickTime);
            ignore RetentionService.Service(retentionState()).cleanup({
                now_ns = tickTime;
                after = null;
                limit = RetentionService.MAX_CLEANUP_PAGE;
            });
            // Advance at most the kernel's own bounded retirement page. This
            // releases immutable slots only after their revocation receipts
            // have aged out; mutable-key revision high-water remains intact.
            ignore certifiedAssets.maintenance_page();
            ignore await* drainOutbox(
                Nat16.fromNat(20),
                #automatic,
                taskCapabilities.backend_calls,
            );
            mem.scheduler := {
                mem.scheduler with
                running = false;
                started_at_ns = null;
            };
        };

        public func /*update*/wagyu_ingress_follow_v1(
            request : WagyuIngressV1,
            /*caller*/ caller : Principal,
        ) : WagyuRouteResultV1 {
            ingressFollow(caller, request);
        };

        public func /*update*/wagyu_ingress_unfollow_v1(
            request : WagyuIngressV1,
            /*caller*/ caller : Principal,
        ) : UnfollowRouteResultV1 {
            let result = ingressUnfollow(caller, request);
            {
                outcome = result.outcome;
                revision = result.revision;
            };
        };

        public func /*update*/wagyu_ingress_deliver_v1(
            request : WagyuIngressV1,
            /*caller*/ caller : Principal,
        ) : WagyuRouteResultV1 {
            ingressDeliver(caller, request);
        };

        public func /*update*/wagyu_ingress_like_v1(
            request : WagyuIngressV1,
            /*caller*/ caller : Principal,
        ) : WagyuRouteResultV1 {
            ingressLike(caller, request);
        };

        public func /*update*/wagyu_ingress_notice_v1(
            request : WagyuIngressV1,
            /*caller*/ caller : Principal,
        ) : WagyuRouteResultV1 {
            ingressNotice(caller, request);
        };

        public func /*query*/wagyu_feed_page_self_v1(
            request : FeedPageSelfRequestV1
        ) : FeedPageSelfOutputV1 {
            let limit = Nat16.toNat(request.limit);
            if (limit == 0 or limit > Bounds.MAX_FEED_PAGE_ITEMS) {
                Runtime.trap("Feed page limit must be between 1 and 25");
            };
            let ?output = OwnerBridge.feedPageOutput(feedPage(request))
            else Runtime.trap(
                "Wagyu feed page bridge invariant failed"
            );
            output;
        };

        public func /*query*/wagyu_notification_page_self_v1(
            request : NotificationPageSelfRequestV1
        ) : NotificationPageSelfOutputV1 {
            let limit = Nat16.toNat(request.limit);
            if (
                limit == 0 or
                limit > Bounds.MAX_NOTIFICATION_PAGE_ITEMS
            ) {
                Runtime.trap(
                    "Notification page limit must be between 1 and 50"
                );
            };
            let ?output = OwnerBridge.notificationPageOutput(
                notificationPage(request)
            ) else Runtime.trap(
                "Wagyu notification page bridge invariant failed"
            );
            output;
        };

        public func /*query*/wagyu_notification_evidence_self_v1(
            request : NotificationEvidenceSelfRequestV1
        ) : NotificationEvidenceSelfOutputV1 {
            let evidence = wagyu_get_notification_evidence_v1(request);
            let ?output = OwnerBridge.notificationEvidenceOutput(evidence)
            else Runtime.trap(
                "Wagyu notification evidence bridge invariant failed"
            );
            output;
        };

        public func /*query*/wagyu_block_statuses_self_v1(
            request : BlockStatusesSelfRequestV1
        ) : BlockStatusesSelfOutputV1 {
            if (
                request.nodes.size() == 0 or
                request.nodes.size() > MAX_BLOCK_STATUS_NODES
            ) Runtime.trap(
                "Block status request must contain between 1 and 500 nodes"
            );
            for (peer in request.nodes.vals()) {
                if (not Principal.isCanister(peer)) {
                    Runtime.trap(
                        "Block status request contains a non-canister principal"
                    );
                };
            };
            {
                relationship_revision = mem.relationship_revision;
                items = Array.map<
                    RelationshipTypes.BlockStatus,
                    BlockStatusSelfV1
                >(
                    RelationshipService.exactBlockStatuses(
                        request.nodes,
                        isBlockedNode,
                    ),
                    func(status) {
                        {
                            node = status.node;
                            blocked = status.blocked;
                        };
                    },
                );
            };
        };

        public func /*update*/wagyu_follow_self_v1(
            request : FollowSelfRequestV1
        ) : RelationshipSummaryLocalResultV1 {
            let ?input = OwnerBridge.follow(request)
            else return #err(#invalid);
            ownerFollow(input);
        };

        public func /*update*/wagyu_auto_renew_self_v1(
            request : NodeRequestV1
        ) : RelationshipSummaryLocalResultV1 {
            ownerAutoRenew(request.node);
        };

        public func /*update*/wagyu_post_prepare_self_v1(
            request : PostPrepareSelfRequestV1
        ) : PublishSelfLocalResultV1 {
            let ?input = OwnerBridge.postPrepare(request)
            else return #err(#invalid);
            bridgePublishResult(publishPost(input));
        };

        public func /*update*/wagyu_share_prepare_self_v1(
            request : SharePrepareSelfRequestV1
        ) : PublishSelfLocalResultV1 {
            let ?input = OwnerBridge.sharePrepare(request)
            else return #err(#invalid);
            bridgePublishResult(publishShare({
                original_post_ref_candid =
                    input.exact_original_post_ref_candid;
                nonce = input.nonce;
            }));
        };

        public func /*update*/wagyu_like_prepare_self_v1(
            request : LikePrepareSelfRequestV1
        ) : PublishSelfLocalResultV1 {
            let ?input = OwnerBridge.likePrepare(request)
            else return #err(#invalid);
            bridgePublishResult(publishLike({
                post_author = input.post_author;
                post_id = input.post_id;
                post_body_hash = ?input.post_body_hash;
                body_digest = input.post_object_digest;
                nonce = input.nonce;
            }));
        };

        public func /*update*/wagyu_tombstone_prepare_self_v1(
            request : TombstonePrepareSelfRequestV1
        ) : PublishSelfLocalResultV1 {
            let ?input = OwnerBridge.tombstonePrepare(request)
            else return #err(#invalid);
            bridgePublishResult(publishTombstone(input));
        };

        public func /*update*/wagyu_post_finalize_self_v1(
            request : FinalizeSelfRequestV1
        ) : PublishSelfLocalResultV1 {
            bridgeFinalize(#post, request);
        };

        public func /*update*/wagyu_share_finalize_self_v1(
            request : FinalizeSelfRequestV1
        ) : PublishSelfLocalResultV1 {
            bridgeFinalize(#share, request);
        };

        public func /*update*/wagyu_like_finalize_self_v1(
            request : FinalizeSelfRequestV1
        ) : PublishSelfLocalResultV1 {
            bridgeFinalize(#like, request);
        };

        public func /*update*/wagyu_tombstone_finalize_self_v1(
            request : FinalizeSelfRequestV1
        ) : PublishSelfLocalResultV1 {
            bridgeFinalize(#tombstone, request);
        };

        public func /*update*/wagyu_feed_promote_self_v1(
            request : FeedPromoteSelfRequestV1
        ) : Nat64LocalResultV1 {
            let ?input = OwnerBridge.feedPromote(request)
            else return #err(#invalid);
            promoteFeedCandidate(input);
        };

        public func /*update*/wagyu_feed_reject_self_v1(
            request : FeedRejectSelfRequestV1
        ) : Nat64LocalResultV1 {
            let ?input = OwnerBridge.feedReject(request)
            else return #err(#invalid);
            rejectFeedCandidate({
                candidate_id = input.candidate_id;
                disposition = ?input.disposition;
            });
        };

        public func /*update*/wagyu_notification_promote_self_v1(
            request : NotificationPromoteSelfRequestV1
        ) : async* Nat64LocalResultV1 {
            let ?input = OwnerBridge.notificationPromote(request)
            else return #err(#invalid);
            let verification : NotificationVerificationV1 = switch (
                input.disposition
            ) {
                case (#verified) #verified;
                case (#invalid) #invalid;
                case (#unavailable) #unavailable;
            };
            await* updateNotificationVerificationAndArmLikeSeal(
                input.local_sequence,
                ?verification,
                input.verified_reply,
            );
        };

        public func /*update*/wagyu_like_seal_self_v1(
            request : LikeSealSelfRequestV1
        ) : PublishSelfLocalResultV1 {
            let ?input = OwnerBridge.likeSeal(request)
            else return #err(#invalid);
            bridgePublishResult(wagyu_like_seal(input));
        };

        public func /*update*/wagyu_withdrawal_advance_self_v1(
            request : WithdrawalAdvanceSelfRequestV1
        ) : PublishSelfLocalResultV1 {
            let ?input = OwnerBridge.withdrawalAdvance(request)
            else return #err(#invalid);
            bridgePublishResult(wagyu_withdrawal_advance(input));
        };

        func bridgeFinalize(
            kind : ActionKindV1,
            request : FinalizeSelfRequestV1,
        ) : PublishSelfLocalResultV1 {
            let protocolKind : Protocol.ActionKindV1 = switch (kind) {
                case (#post) #post;
                case (#share) #share;
                case (#like) #like;
                case (#tombstone) #tombstone;
            };
            let ?input = OwnerBridge.finalize(
                protocolKind,
                request,
            ) else return #err(#invalid);
            let proof : CertifiedHttpProofV1 = {
                certificate_version = input.proof.certificate_version;
                certificate_cbor = input.proof.certificate_cbor;
                witness_cbor = input.proof.witness_cbor;
                expression_path_cbor = input.proof.expression_path_cbor;
                certificate_time_ns = input.proof.certificate_time_ns;
            };
            bridgePublishResult(finalizeAction({
                action_kind = ?kind;
                action_id = input.action_id;
                object_digest = input.object_digest;
                proof;
            }));
        };

        func bridgePublishResult(
            result : LocalResultV1<PublishResultV1>
        ) : PublishSelfLocalResultV1 {
            let ?output = OwnerBridge.publishResult(result)
            else return #err(#invalid);
            output;
        };

        type ActiveInstallation = {
            node : Principal;
            network_id : Blob;
            profile_generation : Nat64;
            activated_at_ns : Nat64;
        };

        func installationContext() : ?ActiveInstallation {
            switch (mem.installation) {
                case (#active(value)) {
                    if (
                        not Principal.equal(value.node, node) or
                        not Blob.equal(value.network_id, trustedNetworkId)
                    ) return null;
                    ?value;
                };
                case (#provisional(_)) null;
                case (#uninitialized) {
                    PristineMemory.assertForBinding(mem);
                    let scope = switch (certifiedAssets.scope_info()) {
                        case (#err(_)) return null;
                        case (#ok(value)) value;
                    };
                    let active : ActiveInstallation = {
                        node;
                        network_id = trustedNetworkId;
                        profile_generation =
                            scope.installation_generation;
                        activated_at_ns = nowNs();
                    };
                    mem.installation := #active(active);
                    for (collection in scope.collections.vals()) {
                        switch (collectionFromText(collection.id)) {
                            case null {};
                            case (?kind) {
                                Map.add(
                                    mem.certified_collections,
                                    Text.compare,
                                    collection.id,
                                    {
                                        collection = kind;
                                        collection_generation =
                                            collection.generation;
                                        object_count = 0;
                                        body_bytes = 0;
                                    },
                                );
                            };
                        };
                    };
                    bumpState();
                    ?active;
                };
            };
        };

        func currentProfile() : Memory.ProfileV1 {
            switch (mem.profile) {
                case (?state) state.value;
                case null {
                    let ?installation = installationContext() else {
                        Runtime.trap(
                            "Wagyu installation context is unavailable"
                        );
                    };
                    switch (
                        Planner.defaultProfile({
                            network_id = installation.network_id;
                            node = installation.node;
                            profile_generation =
                                installation.profile_generation;
                            updated_at_ns = 0;
                            capabilities = null;
                        })
                    ) {
                        case (#ok(plan)) protocolProfileToMemory(plan.value);
                        case (#err(_)) Runtime.trap(
                            "Wagyu could not construct its local default profile"
                        );
                    };
                };
            };
        };

        func networkConfigured() : Bool {
            installationContext() != null;
        };

        func assertTrustedInstallation() {
            if (
                trustedNetworkId.size() != Bounds.HASH_BYTES or
                isZero(trustedNetworkId)
            ) {
                Runtime.trap(
                    "Wagyu requires a trusted 32-byte nonzero installation network ID"
                );
            };
            switch (mem.installation) {
                case (#active(value)) {
                    if (
                        not Principal.equal(value.node, node) or
                        not Blob.equal(value.network_id, trustedNetworkId)
                    ) {
                        Runtime.trap(
                            "Wagyu stable installation identity does not match its trusted installation context"
                        );
                    };
                };
                case (#provisional(_)) {
                    Runtime.trap(
                        "Wagyu provisional network state requires a clean trusted installation"
                    );
                };
                case (#uninitialized) {};
            };
        };

        func profileEdit(
            request : ProfileEditRequestV1,
        ) : ProfileEditResultV1 {
            let ?installation = installationContext() else {
                return { outcome = ?#rejected({ reason = ?#invalid }) };
            };
            let current = mem.profile;
            let currentValue = switch (current) {
                case (?state) state.value;
                case null currentProfile();
            };
            if (
                request.expected_profile_generation !=
                    currentValue.profile_generation or
                request.expected_revision != currentValue.revision
            ) {
                return {
                    outcome = ?#conflict({
                        current_generation =
                            currentValue.profile_generation;
                        current_revision = currentValue.revision;
                    });
                };
            };
            let avatar : ?Protocol.AvatarV1 = switch (request.avatar) {
                case null null;
                case (?value) {
                    ?{
                        media_type = mapAvatarMediaToProtocol(
                            value.media_type
                        );
                        width = value.width;
                        height = value.height;
                        bytes = value.bytes;
                    };
                };
            };
            let previousIdentity : ?Publication.StoredIdentity = switch (
                current
            ) {
                case null null;
                case (?state) {
                    ?{
                        target = memoryTargetToCapability(
                            state.kernel_identity.target
                        );
                        kernel_revision =
                            state.kernel_identity.kernel_revision;
                        content_tag = state.kernel_identity.content_tag;
                        body_bytes = Nat32.toNat(
                            state.kernel_identity.body_length
                        );
                    };
                };
            };
            let updatedAt = nowNs();
            let nonceSeed = switch (current) {
                case null trustedNetworkId;
                case (?state) state.body_digest;
            };
            let publicationNonce = derivedNonce(
                "wagyu.profile-edit-publication.v1",
                nonceSeed,
                Text.encodeUtf8(
                    request.display_name # "\00" #
                    request.description
                ),
            );
            let plan : Planner.ProfileEditPlan = switch (current) {
                case null {
                    let ?generation = collectionGeneration(
                        Publication.PROFILE_COLLECTION
                    ) else return {
                        outcome = ?#rejected({ reason = ?#invalid });
                    };
                    switch (
                        Planner.createProfile({
                            network_id = installation.network_id;
                            node = installation.node;
                            profile_generation =
                                installation.profile_generation;
                            updated_at_ns = updatedAt;
                            display_name = request.display_name;
                            description = request.description;
                            capabilities = null;
                            avatar;
                            profile_collection_generation = generation;
                            publication_nonce = publicationNonce;
                        })
                    ) {
                        case (#err(_)) return {
                            outcome = ?#rejected({ reason = ?#invalid });
                        };
                        case (#ok(value)) value;
                    };
                };
                case (?state) {
                    let ?identity = previousIdentity else {
                        Runtime.trap(
                            "Wagyu profile identity projection failed"
                        );
                    };
                    switch (
                        Planner.prepareProfileEdit({
                            current = memoryProfileToProtocol(state.value);
                            current_body_candid = state.exact_body_candid;
                            current_identity = identity;
                            updated_at_ns = updatedAt;
                            display_name = request.display_name;
                            description = request.description;
                            capabilities = state.value.capabilities;
                            avatar;
                            publication_nonce = publicationNonce;
                        })
                    ) {
                        case (#err(_)) return {
                            outcome = ?#rejected({ reason = ?#invalid });
                        };
                        case (#ok(value)) value;
                    };
                };
            };
            let oldBytes = switch (current) {
                case null 0;
                case (?state) {
                    Nat32.toNat(state.kernel_identity.body_length);
                };
            };
            if (
                (current == null and
                    mem.certified_object_count >=
                        mem.quota_limits.certified_object_count) or
                not canApplyByteReplacement(
                    mem.certified_object_bytes,
                    mem.quota_limits.certified_object_bytes,
                    oldBytes,
                    plan.body_candid.size(),
                )
            ) {
                return {
                    outcome = ?#rejected({ reason = ?#full });
                };
            };
            let mutations = switch (previousIdentity) {
                case null {
                    PublicationJournal.profileCreate({
                        target = plan.target;
                        body_digest = plan.body_digest;
                        body_length = plan.body_candid.size();
                    });
                };
                case (?identity) {
                    PublicationJournal.profileCas({
                        profile = {
                            target = plan.target;
                            body_digest = plan.body_digest;
                            body_length = plan.body_candid.size();
                        };
                        expected_profile = identity;
                    });
                };
            };
            let mutationPlan = switch (mutations) {
                case (#err(_)) {
                    return {
                        outcome = ?#rejected({ reason = ?#invalid });
                    };
                };
                case (#ok(value)) value;
            };
            let ?journal = preparePublicationJournal(
                #positive_batch,
                plan.commit.nonce,
                plan.body_digest,
                mutationPlan,
            ) else {
                return {
                    outcome = ?#rejected({ reason = ?#full });
                };
            };
            let identity = switch (
                certifiedAssets.commit_batch(plan.commit)
            ) {
                case (#err(#low_cycles)) {
                    return {
                        outcome = ?#rejected({ reason = ?#low_cycles });
                    };
                };
                case (#err(#quota or #receipt_full)) {
                    return {
                        outcome = ?#rejected({ reason = ?#full });
                    };
                };
                case (#err(_)) {
                    return {
                        outcome = ?#conflict({
                            current_generation =
                                currentValue.profile_generation;
                            current_revision = currentValue.revision;
                        });
                    };
                };
                case (#ok(receipt)) {
                    switch (Planner.reconcileProfile(plan, receipt)) {
                        case (#err(_)) {
                            return {
                                outcome = ?#rejected({ reason = ?#invalid });
                            };
                        };
                        case (#ok(value)) value;
                    };
                };
            };
            let memoryIdentity = capabilityIdentityToMemory(identity);
            let publicationId = nextPublicationId();
            switch (current) {
                case null {
                    rememberNewCertifiedRecord(
                        memoryIdentity,
                        publicationId,
                        ?"profile",
                        updatedAt,
                    );
                };
                case (?state) {
                    replaceCertifiedRecord(
                        state.kernel_identity,
                        memoryIdentity,
                        publicationId,
                        ?"profile",
                        updatedAt,
                    );
                };
            };
            mem.profile := ?{
                value = protocolProfileToMemory(plan.value);
                exact_body_candid = plan.body_candid;
                body_digest = plan.body_digest;
                kernel_identity = memoryIdentity;
                publication_id = publicationId;
            };
            rememberCommittedPublication(
                publicationId,
                if (current == null) #install_profile else #replace_profile,
                journal,
                [memoryIdentity],
                updatedAt,
            );
            bumpState();
            {
                outcome = ?#updated({
                    profile_generation = plan.value.profile_generation;
                    revision = plan.value.revision;
                    body_digest = plan.body_digest;
                });
            };
        };

        func publishPost(
            request : PostPublishRequestV1
        ) : LocalResultV1<PublishResultV1> {
            if (not networkConfigured()) return #err(#not_configured);
            if (request.nonce.size() != Bounds.NONCE_BYTES) {
                return #err(#invalid);
            };
            let nonceKey = authoredPostNonceStableKey(request.nonce);
            switch (
                Map.get(
                    mem.authored_post_by_nonce,
                    Text.compare,
                    nonceKey,
                )
            ) {
                case null {};
                case (?postKey) {
                    let ?existing = Map.get(
                        mem.authored_posts,
                        Text.compare,
                        postKey,
                    ) else Runtime.trap(
                        "Wagyu authored nonce index points to no post"
                    );
                    if (
                        existing.post_key != postKey or
                        not Blob.equal(existing.body.nonce, request.nonce)
                    ) Runtime.trap(
                        "Wagyu authored nonce index is corrupt"
                    );
                    return #ok(publishResultForPost(existing));
                };
            };
            if (
                mem.authored_post_count + mem.authored_action_count >=
                    mem.quota_limits.authored_record_count
            ) return #err(#full);
            let ?postsGeneration = collectionGeneration(
                Publication.POSTS_COLLECTION
            ) else return #err(#certified_store);
            let ?headsGeneration = collectionGeneration(
                Publication.LIKE_HEADS_COLLECTION
            ) else return #err(#certified_store);
            let sequence = nextRevision(mem.author_sequence);
            let createdAt = nowNs();
            let reply = switch (request.reply_to) {
                case null null;
                case (?value) ?publicReplyToProtocol(value);
            };
            let first = switch (
                Planner.preparePost({
                    network_id = currentProfile().network_id;
                    actor_ = node;
                    author_sequence = sequence;
                    nonce = request.nonce;
                    created_at_ns = createdAt;
                    body_markdown = request.body_markdown;
                    reply_to = reply;
                    posts_generation = postsGeneration;
                    like_heads_generation = headsGeneration;
                    publication_nonce = request.nonce;
                })
            ) {
                case (#err(_)) return #err(#invalid);
                case (#ok(value)) value;
            };
            let publicationNonce = derivedNonce(
                "wagyu.post-publication.v1",
                request.nonce,
                first.object_digest,
            );
            let plan = switch (
                Planner.preparePost({
                    network_id = currentProfile().network_id;
                    actor_ = node;
                    author_sequence = sequence;
                    nonce = request.nonce;
                    created_at_ns = createdAt;
                    body_markdown = request.body_markdown;
                    reply_to = reply;
                    posts_generation = postsGeneration;
                    like_heads_generation = headsGeneration;
                    publication_nonce = publicationNonce;
                })
            ) {
                case (#err(_)) return #err(#invalid);
                case (#ok(value)) value;
            };
            if (
                not quotaBytesAvailable(
                    mem.authored_bytes,
                    0,
                    plan.body_candid.size() +
                        plan.like_head_candid.size() + 768,
                    mem.quota_limits.authored_bytes,
                )
            ) return #err(#full);
            let postKey = postStableKey(plan.post_id);
            let retainedBytes =
                plan.body_candid.size() +
                plan.like_head_candid.size() + 768;
            let retentionExpiresAt = addSaturating(
                createdAt,
                mem.retention.peer_records_ns,
            );
            let ?retention = prepareSingleRetention(
                #authored_post({
                    post_key = postKey;
                    created_at_ns = createdAt;
                    retain_until_ns = retentionExpiresAt;
                    retained_bytes = retainedBytes;
                    author_sequence = sequence;
                    dependents_detached = false;
                })
            ) else return #err(#full);
            let mutations = switch (
                PublicationJournal.postAndInitialHead({
                    post = {
                        target = plan.target;
                        body_digest = plan.object_digest;
                        body_length = plan.body_candid.size();
                    };
                    initial_head = {
                        target = plan.like_head_target;
                        body_digest = plan.like_head_digest;
                        body_length = plan.like_head_candid.size();
                    };
                })
            ) {
                case (#err(_)) return #err(#certified_store);
                case (#ok(value)) value;
            };
            let ?journal = preparePublicationJournal(
                #positive_batch,
                plan.commit.nonce,
                plan.object_digest,
                mutations,
            ) else return #err(#full);
            let receipt = switch (certifiedAssets.commit_batch(plan.commit)) {
                case (#err(#quota or #receipt_full)) return #err(#full);
                case (#err(_)) return #err(#certified_store);
                case (#ok(value)) value;
            };
            let publication = switch (
                Planner.reconcilePost(plan, receipt)
            ) {
                case (#err(_)) return #err(#certified_store);
                case (#ok(value)) value;
            };
            let publicationId = nextPublicationId();
            let postIdentity = capabilityIdentityToMemory(
                publication.post_identity
            );
            let headIdentity = capabilityIdentityToMemory(
                publication.like_head_identity
            );
            let headKey = likeHeadStableKey(plan.post_id);
            let post : Memory.AuthoredPost = {
                post_key = postKey;
                post_id = plan.post_id;
                body_hash = plan.body_hash;
                object_digest = plan.object_digest;
                body_length = Nat32.fromNat(plan.body_candid.size());
                exact_body_candid = plan.body_candid;
                body = protocolPostToMemory(plan.value);
                exact_certified_ref_candid = null;
                object_state = #awaiting_proof({ publication_id = publicationId });
                status = #awaiting_proof;
                like_head_key = headKey;
                created_at_ns = createdAt;
                retention_expires_at_ns = retentionExpiresAt;
                retained_bytes = retainedBytes;
            };
            Map.add(mem.authored_posts, Text.compare, postKey, post);
            Map.add(
                mem.authored_post_by_nonce,
                Text.compare,
                nonceKey,
                postKey,
            );
            Map.add(
                mem.authored_post_order,
                Nat64.compare,
                sequence,
                postKey,
            );
            Map.add(mem.like_heads, Text.compare, headKey, {
                head_key = headKey;
                value = protocolLikeHeadToMemory(plan.like_head);
                exact_body_candid = plan.like_head_candid;
                body_digest = plan.like_head_digest;
                kernel_identity = headIdentity;
                publication_id = publicationId;
            });
            Map.add(
                mem.like_states,
                Text.compare,
                postKey,
                emptyPostLikeState(postKey),
            );
            rememberCertifiedRecord(
                postIdentity,
                publicationId,
                ?postKey,
                createdAt,
            );
            rememberCertifiedRecord(
                headIdentity,
                publicationId,
                ?headKey,
                createdAt,
            );
            rememberCommittedPublication(
                publicationId,
                #post_and_like_head,
                journal,
                [postIdentity, headIdentity],
                createdAt,
            );
            applyRetentionRegistration(retention);
            mem.author_sequence := sequence;
            mem.authored_post_count += 1;
            mem.authored_bytes += retainedBytes;
            bumpState();
            #ok({
                stage = ?#awaiting_proof;
                post_id = ?plan.post_id;
                action_id = ?plan.post_id;
                object_digest = ?plan.object_digest;
                queued_recipient_count = 0;
                queued_notice_count = 0;
                accepted_recipient_count = 0;
                failed_recipient_count = 0;
                message =
                    "The post and initial Like head are certified; capture and finalize its proof.";
            });
        };

        func publishShare(
            request : SharePublishRequestV1
        ) : LocalResultV1<PublishResultV1> {
            if (not networkConfigured()) return #err(#not_configured);
            let ?original = Wire.decodeCertifiedPostRef(
                request.original_post_ref_candid
            ) else return #err(#invalid);
            if (not Validation.certifiedPostRefValue(original)) {
                return #err(#invalid);
            };
            let originalKey = originalPostStableKey(
                original.author,
                original.post_id,
            );
            switch (
                Map.get(
                    mem.shares_by_original_post,
                    Text.compare,
                    originalKey,
                )
            ) {
                case (?actionKey) {
                    let ?existing = Map.get(
                        mem.authored_actions,
                        Text.compare,
                        actionKey,
                    ) else return #err(#conflict);
                    return #ok(publishResultForAction(existing));
                };
                case null {};
            };
            if (
                mem.authored_post_count + mem.authored_action_count >=
                    mem.quota_limits.authored_record_count
            ) return #err(#full);
            let ?generation = collectionGeneration(
                Publication.SHARES_COLLECTION
            ) else return #err(#certified_store);
            let sequence = nextRevision(mem.author_sequence);
            let createdAt = nowNs();
            let seed = switch (request.nonce) {
                case (?value) {
                    if (value.size() != Bounds.NONCE_BYTES) {
                        return #err(#invalid);
                    };
                    value;
                };
                case null {
                    first16(Hash.postRefDigest(
                        request.original_post_ref_candid
                    ));
                };
            };
            let first = switch (
                Planner.prepareShare({
                    network_id = currentProfile().network_id;
                    sharer = node;
                    share_sequence = sequence;
                    issued_at_ns = createdAt;
                    original_post_ref = original;
                    original_post_ref_candid =
                        request.original_post_ref_candid;
                    shares_generation = generation;
                    publication_nonce = seed;
                })
            ) {
                case (#err(_)) return #err(#invalid);
                case (#ok(value)) value;
            };
            let publicationNonce = derivedNonce(
                "wagyu.share-publication.v1",
                seed,
                first.object_digest,
            );
            let plan = switch (
                Planner.prepareShare({
                    network_id = currentProfile().network_id;
                    sharer = node;
                    share_sequence = sequence;
                    issued_at_ns = createdAt;
                    original_post_ref = original;
                    original_post_ref_candid =
                        request.original_post_ref_candid;
                    shares_generation = generation;
                    publication_nonce = publicationNonce;
                })
            ) {
                case (#err(_)) return #err(#invalid);
                case (#ok(value)) value;
            };
            if (
                not quotaBytesAvailable(
                    mem.authored_bytes,
                    0,
                    plan.body_candid.size() +
                        request.original_post_ref_candid.size() + 640,
                    mem.quota_limits.authored_bytes,
                )
            ) return #err(#full);
            let actionKey = actionStableKey(#share, plan.share_id);
            let retainedBytes =
                plan.body_candid.size() +
                request.original_post_ref_candid.size() + 640;
            let retentionExpiresAt = addSaturating(
                createdAt,
                mem.retention.peer_records_ns,
            );
            let ?retention = prepareSingleRetention(
                #authored_action({
                    action_key = actionKey;
                    created_at_ns = createdAt;
                    retain_until_ns = retentionExpiresAt;
                    retained_bytes = retainedBytes;
                    sequence;
                    certified_record_detached = false;
                    kind = #share({
                        original_author = original.author;
                        original_post_id = original.post_id;
                    });
                })
            ) else return #err(#full);
            let mutations = switch (
                PublicationJournal.immutableShare({
                    action = {
                        target = plan.target;
                        body_digest = plan.object_digest;
                        body_length = plan.body_candid.size();
                    };
                })
            ) {
                case (#err(_)) return #err(#certified_store);
                case (#ok(value)) value;
            };
            let ?journal = preparePublicationJournal(
                #positive_batch,
                plan.commit.nonce,
                plan.object_digest,
                mutations,
            ) else return #err(#full);
            let identity = commitImmutableShare(plan);
            let storedIdentity = switch (identity) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            let publicationId = nextPublicationId();
            let action : Memory.AuthoredAction = {
                action_key = actionKey;
                action_id = plan.share_id;
                sequence;
                object_digest = plan.object_digest;
                body_length = Nat32.fromNat(plan.body_candid.size());
                exact_body_candid = plan.body_candid;
                kind = #share({
                    action = protocolShareToMemory(plan.value);
                    exact_original_post_ref_candid =
                        request.original_post_ref_candid;
                    exact_delivery_candid = null;
                });
                object_state = #awaiting_proof({
                    publication_id = publicationId;
                });
                created_at_ns = createdAt;
                retention_expires_at_ns = retentionExpiresAt;
                retained_bytes = retainedBytes;
            };
            Map.add(mem.authored_actions, Text.compare, actionKey, action);
            Map.add(
                mem.authored_action_order,
                Nat64.compare,
                sequence,
                actionKey,
            );
            Map.add(
                mem.shares_by_original_post,
                Text.compare,
                originalKey,
                actionKey,
            );
            rememberCertifiedRecord(
                storedIdentity,
                publicationId,
                ?actionKey,
                createdAt,
            );
            rememberCommittedPublication(
                publicationId,
                #action,
                journal,
                [storedIdentity],
                createdAt,
            );
            applyRetentionRegistration(retention);
            mem.author_sequence := sequence;
            mem.authored_action_count += 1;
            mem.authored_bytes += retainedBytes;
            bumpState();
            #ok({
                stage = ?#awaiting_proof;
                post_id = ?original.post_id;
                action_id = ?plan.share_id;
                object_digest = ?plan.object_digest;
                queued_recipient_count = 0;
                queued_notice_count = 0;
                accepted_recipient_count = 0;
                failed_recipient_count = 0;
                message =
                    "The share action is certified; capture and finalize its proof.";
            });
        };

        func publishLike(
            request : LikePublishRequestV1
        ) : LocalResultV1<PublishResultV1> {
            if (not networkConfigured()) return #err(#not_configured);
            if (
                request.nonce.size() != Bounds.NONCE_BYTES or
                request.post_id.size() != Bounds.HASH_BYTES or
                not Principal.isCanister(request.post_author) or
                Principal.equal(request.post_author, node)
            ) return #err(#invalid);
            let ?bodyHash = requestedPostBodyHash(request) else {
                return #err(#invalid);
            };
            let originalKey = originalPostStableKey(
                request.post_author,
                request.post_id,
            );
            switch (
                Map.get(
                    mem.outgoing_likes_by_post,
                    Text.compare,
                    originalKey,
                )
            ) {
                case (?marker) {
                    let ?actionKey = marker.live_action_key else {
                        return #ok({
                            stage = ?#complete;
                            post_id = ?request.post_id;
                            action_id = ?marker.like_id;
                            object_digest = ?marker.object_digest;
                            queued_recipient_count = 0;
                            queued_notice_count = 0;
                            accepted_recipient_count = 0;
                            failed_recipient_count = 0;
                            message =
                                "This post already has a retained outgoing Like marker; its five-year object has expired.";
                        });
                    };
                    let ?existing = Map.get(
                        mem.authored_actions,
                        Text.compare,
                        actionKey,
                    ) else return #err(#conflict);
                    return #ok(publishResultForAction(existing));
                };
                case null {};
            };
            if (
                mem.authored_post_count + mem.authored_action_count >=
                    mem.quota_limits.authored_record_count
            ) return #err(#full);
            let ?generation = collectionGeneration(
                Publication.LIKES_COLLECTION
            ) else return #err(#certified_store);
            let createdAt = nowNs();
            let sequence = nextRevision(mem.author_sequence);
            let first = switch (
                Planner.prepareLike({
                    network_id = currentProfile().network_id;
                    liker = node;
                    issued_at_ns = createdAt;
                    post_author = request.post_author;
                    post_id = request.post_id;
                    post_body_hash = bodyHash;
                    likes_generation = generation;
                    publication_nonce = request.nonce;
                })
            ) {
                case (#err(_)) return #err(#invalid);
                case (#ok(value)) value;
            };
            let publicationNonce = derivedNonce(
                "wagyu.like-publication.v1",
                request.nonce,
                first.object_digest,
            );
            let plan = switch (
                Planner.prepareLike({
                    network_id = currentProfile().network_id;
                    liker = node;
                    issued_at_ns = createdAt;
                    post_author = request.post_author;
                    post_id = request.post_id;
                    post_body_hash = bodyHash;
                    likes_generation = generation;
                    publication_nonce = publicationNonce;
                })
            ) {
                case (#err(_)) return #err(#invalid);
                case (#ok(value)) value;
            };
            if (
                not quotaBytesAvailable(
                    mem.authored_bytes,
                    0,
                    plan.body_candid.size() + 512,
                    mem.quota_limits.authored_bytes,
                )
            ) return #err(#full);
            let actionKey = actionStableKey(#like, plan.like_id);
            let retainedBytes = plan.body_candid.size() + 512;
            let retentionExpiresAt = addSaturating(
                createdAt,
                mem.retention.likes_ns,
            );
            let ?retention = prepareSingleRetention(
                #authored_action({
                    action_key = actionKey;
                    created_at_ns = createdAt;
                    retain_until_ns = retentionExpiresAt;
                    retained_bytes = retainedBytes;
                    sequence;
                    certified_record_detached = false;
                    kind = #like({
                        post_author = request.post_author;
                        post_id = request.post_id;
                    });
                })
            ) else return #err(#full);
            let mutations = switch (
                PublicationJournal.immutableLike({
                    action = {
                        target = plan.target;
                        body_digest = plan.object_digest;
                        body_length = plan.body_candid.size();
                    };
                })
            ) {
                case (#err(_)) return #err(#certified_store);
                case (#ok(value)) value;
            };
            let ?journal = preparePublicationJournal(
                #positive_batch,
                plan.commit.nonce,
                plan.object_digest,
                mutations,
            ) else return #err(#full);
            let identity = switch (
                certifiedAssets.commit_batch(plan.commit)
            ) {
                case (#err(#quota or #receipt_full)) return #err(#full);
                case (#err(_)) return #err(#certified_store);
                case (#ok(receipt)) {
                    switch (Planner.reconcileLike(plan, receipt)) {
                        case (#err(_)) return #err(#certified_store);
                        case (#ok(value)) {
                            capabilityIdentityToMemory(value);
                        };
                    };
                };
            };
            let publicationId = nextPublicationId();
            let action : Memory.AuthoredAction = {
                action_key = actionKey;
                action_id = plan.like_id;
                sequence;
                object_digest = plan.object_digest;
                body_length = Nat32.fromNat(plan.body_candid.size());
                exact_body_candid = plan.body_candid;
                kind = #like({
                    action = protocolLikeToMemory(plan.value);
                    exact_receipt_candid = null;
                });
                object_state = #awaiting_proof({
                    publication_id = publicationId;
                });
                created_at_ns = createdAt;
                retention_expires_at_ns = retentionExpiresAt;
                retained_bytes = retainedBytes;
            };
            Map.add(mem.authored_actions, Text.compare, actionKey, action);
            Map.add(
                mem.authored_action_order,
                Nat64.compare,
                sequence,
                actionKey,
            );
            Map.add(
                mem.outgoing_likes_by_post,
                Text.compare,
                originalKey,
                {
                    original_post_key = originalKey;
                    like_id = plan.like_id;
                    object_digest = plan.object_digest;
                    live_action_key = ?actionKey;
                    retained_bytes =
                        160 +
                        Text.encodeUtf8(originalKey).size() +
                        plan.like_id.size() +
                        plan.object_digest.size();
                },
            );
            rememberCertifiedRecord(
                identity,
                publicationId,
                ?actionKey,
                createdAt,
            );
            rememberCommittedPublication(
                publicationId,
                #action,
                journal,
                [identity],
                createdAt,
            );
            applyRetentionRegistration(retention);
            mem.author_sequence := sequence;
            mem.authored_action_count += 1;
            mem.authored_bytes += retainedBytes;
            bumpState();
            #ok({
                stage = ?#awaiting_proof;
                post_id = ?request.post_id;
                action_id = ?plan.like_id;
                object_digest = ?plan.object_digest;
                queued_recipient_count = 0;
                queued_notice_count = 0;
                accepted_recipient_count = 0;
                failed_recipient_count = 0;
                message =
                    "The Like action is certified; capture and finalize its proof.";
            });
        };

        func publishTombstone(
            request : PostDeleteRequestV1
        ) : LocalResultV1<PublishResultV1> {
            if (not networkConfigured()) return #err(#not_configured);
            if (
                request.post_id.size() != Bounds.HASH_BYTES or
                request.nonce.size() != Bounds.NONCE_BYTES
            ) return #err(#invalid);
            let postKey = postStableKey(request.post_id);
            let ?post = Map.get(mem.authored_posts, Text.compare, postKey)
            else return #err(#not_found);
            switch (post.status) {
                case (#live) {};
                case (#withdrawal_awaiting_proof(info)) {
                    let ?action = Map.get(
                        mem.authored_actions,
                        Text.compare,
                        info.tombstone_action_key,
                    ) else return #err(#conflict);
                    return #ok(publishResultForAction(action));
                };
                case (_) return #err(#conflict);
            };
            if (
                mem.authored_post_count + mem.authored_action_count >=
                    mem.quota_limits.authored_record_count
            ) return #err(#full);
            let ?generation = collectionGeneration(
                Publication.TOMBSTONES_COLLECTION
            ) else return #err(#certified_store);
            let sequence = nextRevision(mem.author_sequence);
            let createdAt = nowNs();
            let first = switch (
                Planner.prepareTombstone({
                    network_id = currentProfile().network_id;
                    author = node;
                    author_sequence = sequence;
                    issued_at_ns = createdAt;
                    post_id = post.post_id;
                    post_body_hash = post.body_hash;
                    tombstones_generation = generation;
                    publication_nonce = request.nonce;
                })
            ) {
                case (#err(_)) return #err(#invalid);
                case (#ok(value)) value;
            };
            let publicationNonce = derivedNonce(
                "wagyu.tombstone-publication.v1",
                request.nonce,
                first.object_digest,
            );
            let plan = switch (
                Planner.prepareTombstone({
                    network_id = currentProfile().network_id;
                    author = node;
                    author_sequence = sequence;
                    issued_at_ns = createdAt;
                    post_id = post.post_id;
                    post_body_hash = post.body_hash;
                    tombstones_generation = generation;
                    publication_nonce = publicationNonce;
                })
            ) {
                case (#err(_)) return #err(#invalid);
                case (#ok(value)) value;
            };
            if (
                not quotaBytesAvailable(
                    mem.authored_bytes,
                    0,
                    plan.body_candid.size() + 512,
                    mem.quota_limits.authored_bytes,
                )
            ) return #err(#full);
            let actionKey = actionStableKey(
                #tombstone,
                plan.tombstone_id,
            );
            let retainedBytes = plan.body_candid.size() + 512;
            let retentionExpiresAt = addSaturating(
                createdAt,
                mem.retention.peer_records_ns,
            );
            let ?retention = prepareSingleRetention(
                #authored_action({
                    action_key = actionKey;
                    created_at_ns = createdAt;
                    retain_until_ns = retentionExpiresAt;
                    retained_bytes = retainedBytes;
                    sequence;
                    certified_record_detached = false;
                    kind = #tombstone({
                        post_id = post.post_id;
                    });
                })
            ) else return #err(#full);
            let mutations = switch (
                PublicationJournal.immutableTombstone({
                    action = {
                        target = plan.target;
                        body_digest = plan.object_digest;
                        body_length = plan.body_candid.size();
                    };
                })
            ) {
                case (#err(_)) return #err(#certified_store);
                case (#ok(value)) value;
            };
            let ?journal = preparePublicationJournal(
                #positive_batch,
                plan.commit.nonce,
                plan.object_digest,
                mutations,
            ) else return #err(#full);
            let identity = switch (
                certifiedAssets.commit_batch(plan.commit)
            ) {
                case (#err(#quota or #receipt_full)) return #err(#full);
                case (#err(_)) return #err(#certified_store);
                case (#ok(receipt)) {
                    switch (Planner.reconcileTombstone(plan, receipt)) {
                        case (#err(_)) return #err(#certified_store);
                        case (#ok(value)) {
                            capabilityIdentityToMemory(value);
                        };
                    };
                };
            };
            let publicationId = nextPublicationId();
            let action : Memory.AuthoredAction = {
                action_key = actionKey;
                action_id = plan.tombstone_id;
                sequence;
                object_digest = plan.object_digest;
                body_length = Nat32.fromNat(plan.body_candid.size());
                exact_body_candid = plan.body_candid;
                kind = #tombstone({
                    action = protocolTombstoneToMemory(plan.value);
                    exact_tombstone_candid = null;
                });
                object_state = #awaiting_proof({
                    publication_id = publicationId;
                });
                created_at_ns = createdAt;
                retention_expires_at_ns = retentionExpiresAt;
                retained_bytes = retainedBytes;
            };
            Map.add(mem.authored_actions, Text.compare, actionKey, action);
            Map.add(
                mem.authored_action_order,
                Nat64.compare,
                sequence,
                actionKey,
            );
            Map.add(
                mem.tombstones_by_post,
                Text.compare,
                postKey,
                actionKey,
            );
            Map.add(mem.authored_posts, Text.compare, postKey, {
                post with
                status = #withdrawal_awaiting_proof({
                    tombstone_action_key = actionKey;
                });
            });
            rememberCertifiedRecord(
                identity,
                publicationId,
                ?actionKey,
                createdAt,
            );
            rememberCommittedPublication(
                publicationId,
                #action,
                journal,
                [identity],
                createdAt,
            );
            applyRetentionRegistration(retention);
            mem.author_sequence := sequence;
            mem.authored_action_count += 1;
            mem.authored_bytes += retainedBytes;
            bumpState();
            #ok({
                stage = ?#awaiting_proof;
                post_id = ?post.post_id;
                action_id = ?plan.tombstone_id;
                object_digest = ?plan.object_digest;
                queued_recipient_count = 0;
                queued_notice_count = 0;
                accepted_recipient_count = 0;
                failed_recipient_count = 0;
                message =
                    "The tombstone is certified; capture its proof before closing Likes.";
            });
        };

        func finalizeAction(
            request : ActionFinalizeRequestV1
        ) : LocalResultV1<PublishResultV1> {
            if (not networkConfigured()) return #err(#not_configured);
            if (
                request.action_id.size() != Bounds.HASH_BYTES or
                request.object_digest.size() != Bounds.HASH_BYTES
            ) return #err(#invalid);
            let ?kind = request.action_kind else return #err(#unsupported);
            let proof = publicProofToProtocol(request.proof);
            if (not Planner.validProof(proof)) return #err(#proof_invalid);
            let finalizedAt = nowNs();
            switch (kind) {
                case (#post) {
                    let key = postStableKey(request.action_id);
                    let ?post = Map.get(mem.authored_posts, Text.compare, key)
                    else return #err(#not_found);
                    if (
                        not Blob.equal(
                            post.object_digest,
                            request.object_digest,
                        )
                    ) return #err(#conflict);
                    switch (post.object_state) {
                        case (#certified(_)) {
                            switch (
                                ensureCertifiedReplyIndex(
                                    post,
                                    finalizedAt,
                                )
                            ) {
                                case (#ok(_)) {};
                                case (#err(error)) return #err(error);
                            };
                            switch (
                                promoteLocalReplyIndex(
                                    post,
                                    finalizedAt,
                                )
                            ) {
                                case (#ok(_)) {};
                                case (#err(error)) return #err(error);
                            };
                            return #ok(publishResultForPost(post));
                        };
                        case (#awaiting_proof(info)) {
                            let ref : Protocol.CertifiedPostRefV1 = {
                                author = node;
                                post_id = post.post_id;
                                body_hash = post.body_hash;
                                body_length = post.body_length;
                                object_digest = post.object_digest;
                                proof;
                            };
                            let exactRef = Wire.encodeCertifiedPostRef(ref);
                            let nextRetainedBytes =
                                post.retained_bytes + exactRef.size();
                            if (
                                not quotaBytesAvailable(
                                    mem.authored_bytes,
                                    post.retained_bytes,
                                    nextRetainedBytes,
                                    mem.quota_limits.authored_bytes,
                                )
                            ) return #err(#full);
                            let replyNotice = switch (
                                post.body.reply_to
                            ) {
                                case null null;
                                case (?reply) {
                                    if (
                                        Principal.equal(
                                            reply.author,
                                            node,
                                        )
                                    ) {
                                        null;
                                    } else {
                                        let exactBody =
                                            Wire.encodeNoticeBody({
                                                relation = ?#reply;
                                                target_post_id =
                                                    reply.post_id;
                                                target_body_hash =
                                                    reply.body_hash;
                                                actor_action_id =
                                                    post.post_id;
                                                actor_object_digest =
                                                    post.object_digest;
                                                actor_object_length =
                                                    post.body_length;
                                            });
                                        let ?prepared =
                                            prepareDirectActionDispatch(
                                                reply.author,
                                                Bounds.NOTICE_ROUTE,
                                                "wagyu.reply-notice-operation.v1",
                                                post.post_id,
                                                exactBody,
                                                finalizedAt,
                                            ) else {
                                                return #err(#unsupported);
                                            };
                                        if (
                                            not canEnqueueDirectAction(
                                                prepared,
                                                key,
                                                2,
                                            )
                                        ) return #err(#full);
                                        ?prepared;
                                    };
                                };
                            };
                            let localReply = switch (
                                post.body.reply_to
                            ) {
                                case (?reply) {
                                    Principal.equal(reply.author, node);
                                };
                                case null false;
                            };
                            if (localReply) {
                                switch (
                                    prepareFanoutJob(
                                        #original,
                                        key,
                                        exactRef,
                                        finalizedAt,
                                        1,
                                    )
                                ) {
                                    case (#blocked) return #err(#full);
                                    case (#none or #ready(_)) {};
                                };
                            };
                            switch (
                                ensureCertifiedReplyIndex(
                                    post,
                                    finalizedAt,
                                )
                            ) {
                                case (#ok(_)) {};
                                case (#err(error)) return #err(error);
                            };
                            if (localReply) {
                                switch (
                                    promoteLocalReplyIndex(
                                        post,
                                        finalizedAt,
                                    )
                                ) {
                                    case (#ok(_)) {};
                                    case (#err(error)) return #err(error);
                                };
                            };
                            let fanoutCandidates = switch (
                                createFanoutJob(
                                    #original,
                                    key,
                                    exactRef,
                                    finalizedAt,
                                )
                            ) {
                                case (#none) 0;
                                case (#created(count)) count;
                                case (#blocked) {
                                    if (localReply) {
                                        Runtime.trap(
                                            "Wagyu self-reply fanout violated preflight"
                                        );
                                    };
                                    return #err(#full);
                                };
                            };
                            let noticeQueued = switch (replyNotice) {
                                case null false;
                                case (?prepared) {
                                    if (
                                        not enqueueDirectAction(
                                            prepared,
                                            key,
                                        )
                                    ) {
                                        Runtime.trap(
                                            "Wagyu reply Notice enqueue violated preflight"
                                        );
                                    };
                                    true;
                                };
                            };
                            let next : Memory.AuthoredPost = {
                                post with
                                exact_certified_ref_candid = ?exactRef;
                                object_state = #certified({
                                    publication_id = info.publication_id;
                                    finalized_at_ns = finalizedAt;
                                });
                                status = #live;
                                retained_bytes = nextRetainedBytes;
                            };
                            Map.add(
                                mem.authored_posts,
                                Text.compare,
                                key,
                                next,
                            );
                            mem.authored_bytes += exactRef.size();
                            bumpState();
                            return #ok({
                                stage =
                                    if (
                                        fanoutCandidates > 0 or
                                        noticeQueued
                                    ) {
                                        ?#fanout_queued;
                                    }
                                    else ?#complete;
                                post_id = ?post.post_id;
                                action_id = ?post.post_id;
                                object_digest = ?post.object_digest;
                                queued_recipient_count = 0;
                                queued_notice_count =
                                    if (noticeQueued) 1 else 0;
                                accepted_recipient_count = 0;
                                failed_recipient_count = 0;
                                message =
                                    "The certified post reference and every required outbound delivery are durable.";
                            });
                        };
                        case (_) return #err(#conflict);
                    };
                };
                case (#share) {
                    let key = actionStableKey(#share, request.action_id);
                    let ?action = Map.get(
                        mem.authored_actions,
                        Text.compare,
                        key,
                    ) else return #err(#not_found);
                    if (
                        not Blob.equal(
                            action.object_digest,
                            request.object_digest,
                        )
                    ) return #err(#conflict);
                    switch (action.object_state, action.kind) {
                        case (#certified(_), #share(_)) {
                            return #ok(publishResultForAction(action));
                        };
                        case (#awaiting_proof(info), #share(share)) {
                            let ref : Protocol.CertifiedShareRefV1 = {
                                sharer = node;
                                share_id = share.action.share_id;
                                body_length = action.body_length;
                                object_digest = action.object_digest;
                                proof;
                            };
                            let delivery : Protocol.CertifiedShareDeliveryV1 = {
                                original_post_ref_candid =
                                    share.exact_original_post_ref_candid;
                                share_action_candid =
                                    action.exact_body_candid;
                                share_ref = ref;
                            };
                            let exactDelivery =
                                Wire.encodeCertifiedShareDelivery(delivery);
                            let nextRetainedBytes =
                                action.retained_bytes +
                                exactDelivery.size();
                            if (
                                not quotaBytesAvailable(
                                    mem.authored_bytes,
                                    action.retained_bytes,
                                    nextRetainedBytes,
                                    mem.quota_limits.authored_bytes,
                                )
                            ) return #err(#full);
                            let shareNotice =
                                if (
                                    Principal.equal(
                                        share.action.original_author,
                                        node,
                                    )
                                ) {
                                    null;
                                } else {
                                    let exactBody =
                                        Wire.encodeNoticeBody({
                                            relation = ?#share;
                                            target_post_id =
                                                share.action
                                                    .original_post_id;
                                            target_body_hash =
                                                share.action
                                                    .original_body_hash;
                                            actor_action_id =
                                                share.action.share_id;
                                            actor_object_digest =
                                                action.object_digest;
                                            actor_object_length =
                                                action.body_length;
                                        });
                                    let ?prepared =
                                        prepareDirectActionDispatch(
                                            share.action.original_author,
                                            Bounds.NOTICE_ROUTE,
                                            "wagyu.share-notice-operation.v1",
                                            share.action.share_id,
                                            exactBody,
                                            finalizedAt,
                                        ) else {
                                            return #err(#unsupported);
                                        };
                                    if (
                                        not canEnqueueDirectAction(
                                            prepared,
                                            key,
                                            2,
                                        )
                                    ) return #err(#full);
                                    ?prepared;
                                };
                            let fanoutCandidates = switch (
                                createFanoutJob(
                                    #share,
                                    key,
                                    exactDelivery,
                                    finalizedAt,
                                )
                            ) {
                                case (#none) 0;
                                case (#created(count)) count;
                                case (#blocked) return #err(#full);
                            };
                            let noticeQueued = switch (shareNotice) {
                                case null false;
                                case (?prepared) {
                                    if (
                                        not enqueueDirectAction(
                                            prepared,
                                            key,
                                        )
                                    ) {
                                        Runtime.trap(
                                            "Wagyu share Notice enqueue violated preflight"
                                        );
                                    };
                                    true;
                                };
                            };
                            let next : Memory.AuthoredAction = {
                                action with
                                kind = #share({
                                    action = share.action;
                                    exact_original_post_ref_candid =
                                        share.exact_original_post_ref_candid;
                                    exact_delivery_candid = ?exactDelivery;
                                });
                                object_state = #certified({
                                    publication_id = info.publication_id;
                                    finalized_at_ns = finalizedAt;
                                });
                                retained_bytes = nextRetainedBytes;
                            };
                            Map.add(
                                mem.authored_actions,
                                Text.compare,
                                key,
                                next,
                            );
                            mem.authored_bytes +=
                                exactDelivery.size();
                            bumpState();
                            return #ok({
                                stage =
                                    if (
                                        fanoutCandidates > 0 or
                                        noticeQueued
                                    ) {
                                        ?#fanout_queued;
                                    }
                                    else ?#complete;
                                post_id = ?share.action.original_post_id;
                                action_id = ?action.action_id;
                                object_digest = ?action.object_digest;
                                queued_recipient_count = 0;
                                queued_notice_count =
                                    if (noticeQueued) 1 else 0;
                                accepted_recipient_count = 0;
                                failed_recipient_count = 0;
                                message =
                                    "The certified share delivery and every required outbound delivery are durable.";
                            });
                        };
                        case (_) return #err(#conflict);
                    };
                };
                case (#like) {
                    let key = actionStableKey(#like, request.action_id);
                    let ?action = Map.get(
                        mem.authored_actions,
                        Text.compare,
                        key,
                    ) else return #err(#not_found);
                    if (
                        not Blob.equal(
                            action.object_digest,
                            request.object_digest,
                        )
                    ) return #err(#conflict);
                    switch (action.object_state, action.kind) {
                        case (#certified(_), #like(_)) {
                            return #ok(publishResultForAction(action));
                        };
                        case (#awaiting_proof(info), #like(like)) {
                            let ref : Protocol.CertifiedActionRefV1 = {
                                actor_ = node;
                                action_kind = ?#like;
                                object_digest = action.object_digest;
                                body_length = action.body_length;
                                proof_snapshot = proof;
                            };
                            let receipt : Protocol.CertifiedLikeReceiptV1 = {
                                like_action_candid =
                                    action.exact_body_candid;
                                ref;
                            };
                            let exactReceipt =
                                Wire.encodeCertifiedLikeReceipt(receipt);
                            if (
                                exactReceipt.size() >
                                    Bounds.MAX_LIKE_RECEIPT_CANDID_BYTES
                            ) return #err(#invalid);
                            let nextRetainedBytes =
                                action.retained_bytes +
                                exactReceipt.size();
                            if (
                                not quotaBytesAvailable(
                                    mem.authored_bytes,
                                    action.retained_bytes,
                                    nextRetainedBytes,
                                    mem.quota_limits.authored_bytes,
                                )
                            ) return #err(#full);
                            let exactBody = Wire.encodeLikeBody({
                                certified_like_receipt_candid =
                                    exactReceipt;
                            });
                            let ?prepared =
                                prepareDirectActionDispatch(
                                    like.action.post_author,
                                    Bounds.LIKE_ROUTE,
                                    "wagyu.like-dispatch-operation.v1",
                                    like.action.like_id,
                                    exactBody,
                                    finalizedAt,
                                ) else return #err(#unsupported);
                            if (
                                not canEnqueueDirectAction(
                                    prepared,
                                    key,
                                    1,
                                )
                            ) return #err(#full);
                            if (
                                not enqueueDirectAction(
                                    prepared,
                                    key,
                                )
                            ) {
                                Runtime.trap(
                                    "Wagyu Like enqueue violated preflight"
                                );
                            };
                            let next : Memory.AuthoredAction = {
                                action with
                                kind = #like({
                                    action = like.action;
                                    exact_receipt_candid = ?exactReceipt;
                                });
                                object_state = #certified({
                                    publication_id = info.publication_id;
                                    finalized_at_ns = finalizedAt;
                                });
                                retained_bytes = nextRetainedBytes;
                            };
                            Map.add(
                                mem.authored_actions,
                                Text.compare,
                                key,
                                next,
                            );
                            mem.authored_bytes += exactReceipt.size();
                            bumpState();
                            return #ok({
                                stage = ?#fanout_queued;
                                post_id = ?like.action.post_id;
                                action_id = ?action.action_id;
                                object_digest = ?action.object_digest;
                                queued_recipient_count = 1;
                                queued_notice_count = 0;
                                accepted_recipient_count = 0;
                                failed_recipient_count = 0;
                                message =
                                    "The exact certified Like receipt and its outbound delivery are durable.";
                            });
                        };
                        case (_) return #err(#conflict);
                    };
                };
                case (#tombstone) {
                    let key = actionStableKey(
                        #tombstone,
                        request.action_id,
                    );
                    let ?action = Map.get(
                        mem.authored_actions,
                        Text.compare,
                        key,
                    ) else return #err(#not_found);
                    if (
                        not Blob.equal(
                            action.object_digest,
                            request.object_digest,
                        )
                    ) return #err(#conflict);
                    switch (action.object_state, action.kind) {
                        case (#certified(_), #tombstone(_)) {
                            return #ok(publishResultForAction(action));
                        };
                        case (#awaiting_proof(info), #tombstone(tombstone)) {
                            let ref : Protocol.CertifiedActionRefV1 = {
                                actor_ = node;
                                action_kind = ?#tombstone;
                                object_digest = action.object_digest;
                                body_length = action.body_length;
                                proof_snapshot = proof;
                            };
                            let certified : Protocol.CertifiedTombstoneV1 = {
                                tombstone_action_candid =
                                    action.exact_body_candid;
                                ref;
                            };
                            let exact =
                                Wire.encodeCertifiedTombstone(certified);
                            let nextRetainedBytes =
                                action.retained_bytes + exact.size();
                            if (
                                not quotaBytesAvailable(
                                    mem.authored_bytes,
                                    action.retained_bytes,
                                    nextRetainedBytes,
                                    mem.quota_limits.authored_bytes,
                                )
                            ) return #err(#full);
                            let next : Memory.AuthoredAction = {
                                action with
                                kind = #tombstone({
                                    action = tombstone.action;
                                    exact_tombstone_candid = ?exact;
                                });
                                object_state = #certified({
                                    publication_id = info.publication_id;
                                    finalized_at_ns = finalizedAt;
                                });
                                retained_bytes = nextRetainedBytes;
                            };
                            Map.add(
                                mem.authored_actions,
                                Text.compare,
                                key,
                                next,
                            );
                            mem.authored_bytes += exact.size();
                            bumpState();
                            return #ok({
                                stage = ?#certified_ref_ready;
                                post_id = ?tombstone.action.post_id;
                                action_id = ?action.action_id;
                                object_digest = ?action.object_digest;
                                queued_recipient_count = 0;
                                queued_notice_count = 0;
                                accepted_recipient_count = 0;
                                failed_recipient_count = 0;
                                message =
                                    "The certified tombstone is durable; withdrawal closing can advance.";
                            });
                        };
                        case (_) return #err(#conflict);
                    };
                };
            };
        };

        type LikeSealPreflight = {
            publication_id : Nat64;
            batch_key : Text;
            batch_number_key : Text;
            fingerprint : Blob;
            journal : PublicationJournal.Plan;
            retention : RetentionTypes.RegistrationPlan;
        };

        func sealDueLikeBatches(limit : Nat) {
            var sealed = 0;
            while (sealed < limit and sealOneDueLikeBatch()) {
                sealed += 1;
            };
        };

        func sealOneDueLikeBatch() : Bool {
            let after = mem.scheduler.like_seal_after_post_key;
            let entries = switch (after) {
                case null Map.entries(mem.authored_posts);
                case (?cursor) {
                    Map.entriesFrom(
                        mem.authored_posts,
                        Text.compare,
                        cursor,
                    );
                };
            };
            var examined = 0;
            var lastExamined = after;
            label scan for ((postKey, post) in entries) {
                let strictlyAfter = switch (after) {
                    case null true;
                    case (?cursor) postKey != cursor;
                };
                if (not strictlyAfter) continue scan;
                if (examined >= OutboxService.MAX_PLAN_SCAN) break scan;
                examined += 1;
                lastExamined := ?postKey;
                if (post.status == #live) {
                    switch (
                        Map.get(
                            mem.like_states,
                            Text.compare,
                            post.post_key,
                        )
                    ) {
                        case (?state) {
                            if (
                                state.due_segment != null or
                                state.active_segment.receipt_count > 0
                            ) {
                                let openPartial =
                                    state.due_segment == null;
                                let result = sealDueLikeBatch({
                                    post_id = post.post_id;
                                    final_partial = openPartial;
                                });
                                mem.scheduler := {
                                    mem.scheduler with
                                    like_seal_after_post_key = ?postKey;
                                };
                                return switch (result) {
                                    case (#ok(_)) true;
                                    case (#err(_)) false;
                                };
                            };
                        };
                        case null {};
                    };
                };
            };
            mem.scheduler := {
                mem.scheduler with
                like_seal_after_post_key =
                    if (
                        examined < OutboxService.MAX_PLAN_SCAN
                    ) null else lastExamined;
            };
            false;
        };

        func sealDueLikeBatch(
            request : LikeSealRequestV1
        ) : LocalResultV1<PublishResultV1> {
            if (not networkConfigured()) return #err(#not_configured);
            if (request.post_id.size() != Bounds.HASH_BYTES) {
                return #err(#invalid);
            };
            let postKey = postStableKey(request.post_id);
            let ?post = Map.get(
                mem.authored_posts,
                Text.compare,
                postKey,
            ) else return #err(#not_found);
            if (post.status != #live) return #err(#conflict);
            let ?head = Map.get(
                mem.like_heads,
                Text.compare,
                post.like_head_key,
            ) else return #err(#conflict);
            let ?likeState = Map.get(
                mem.like_states,
                Text.compare,
                postKey,
            ) else return #err(#conflict);
            if (
                not head.value.accepting_likes or
                likeState.closing != null
            ) return #err(#conflict);
            let ?segments = memoryLikeSegments(likeState)
            else return #err(#conflict);
            let ?generation = collectionGeneration(
                Publication.LIKE_BATCHES_COLLECTION
            ) else return #err(#certified_store);
            let nonce = derivedNonce(
                "wagyu.like-seal-publication.v1",
                request.post_id,
                head.body_digest,
            );
            let sealInput : LikeSealing.SealInput = {
                    head = memoryLikeHeadState(head);
                    segments;
                    like_batches_generation = generation;
                    publication_nonce = nonce;
                };
            let planResult =
                if (request.final_partial) {
                    LikeSealing.planOpenPartial(sealInput);
                } else {
                    LikeSealing.planDue(sealInput);
                };
            let plan = switch (planResult) {
                case (#err(#nothing_to_seal)) return #err(#not_found);
                case (
                    #err(
                        #counter_exhausted or
                        #object_too_large or
                        #batch_too_large
                    )
                ) return #err(#full);
                case (#err(_)) return #err(#conflict);
                case (#ok(value)) value;
            };
            let sealedAt = nowNs();
            let ?preflight = prepareLikeSealPersistence(
                post,
                head,
                likeState,
                plan,
                sealedAt,
            ) else return #err(#full);
            let publication = switch (
                certifiedAssets.commit_batch(plan.commit)
            ) {
                case (#err(#quota or #receipt_full)) {
                    return #err(#full);
                };
                case (#err(_)) return #err(#certified_store);
                case (#ok(receipt)) {
                    switch (
                        LikeSealing.reconcileSeal(plan, receipt)
                    ) {
                        case (#err(_)) {
                            return #err(#certified_store);
                        };
                        case (#ok(value)) value;
                    };
                };
            };
            commitLikeSealPersistence(
                post,
                head,
                likeState,
                plan,
                publication.batch_identity,
                publication.head_identity,
                preflight,
                sealedAt,
                null,
            );
            #ok({
                stage = ?#complete;
                post_id = ?post.post_id;
                action_id = null;
                object_digest = ?plan.batch_digest;
                queued_recipient_count = 0;
                queued_notice_count = 0;
                accepted_recipient_count = 0;
                failed_recipient_count = 0;
                message =
                    if (request.final_partial) {
                        "One verified partial Like segment was certified and the Like head advanced atomically.";
                    } else {
                        "One full Like segment was certified and the Like head advanced atomically.";
                    };
            });
        };

        func prepareLikeSealPersistence(
            post : Memory.AuthoredPost,
            head : Memory.LikeHeadState,
            likeState : Memory.PostLikeState,
            plan : LikeSealing.SealPlan,
            sealedAt : Nat64,
        ) : ?LikeSealPreflight {
            let verifiedUnsealedCount =
                Nat16.toNat(likeState.active_segment.receipt_count) +
                (
                    switch (likeState.due_segment) {
                        case null 0;
                        case (?segment) {
                            Nat16.toNat(segment.receipt_count);
                        };
                    }
                );
            if (
                mem.state_revision == Nat64.maxValue or
                mem.publication_sequence == Nat64.maxValue or
                mem.retention_sequence == Nat64.maxValue or
                mem.publication_receipt_count >=
                    mem.quota_limits.publication_receipt_count or
                plan.batch.batch_number == Nat64.maxValue or
                plan.batch.batch_number != likeState.next_batch_number or
                plan.batch.batch_number !=
                    head.value.sealed_batch_count or
                plan.batch.previous_batch_digest !=
                    likeState.previous_batch_digest or
                plan.batch.previous_batch_digest !=
                    head.value.latest_batch_digest or
                not Blob.equal(
                    plan.previous_head.exact_body_candid,
                    head.exact_body_candid,
                ) or
                not Blob.equal(
                    plan.previous_head.kernel_identity.content_tag,
                    head.kernel_identity.content_tag,
                ) or
                plan.previous_head.kernel_identity.kernel_revision !=
                    head.kernel_identity.kernel_revision or
                plan.commit.operations.size() != 2 or
                plan.commit.requires_present_after.size() != 1 or
                (
                    plan.mode == #open_partial and
                    likeState.next_segment_number == Nat64.maxValue
                ) or
                verifiedUnsealedCount >
                    Nat16.toNat(
                        likeState.unsealed_receipt_count
                    )
            ) return null;

            let batchKey = sealedLikeBatchStableKey(
                post.post_id,
                plan.batch.batch_number,
            );
            let numberKey = sealedLikeBatchNumberStableKey(
                post.post_id,
                plan.batch.batch_number,
            );
            if (
                Map.get(
                    mem.sealed_like_batches,
                    Text.compare,
                    batchKey,
                ) != null or
                Map.get(
                    mem.sealed_batches_by_post_number,
                    Text.compare,
                    numberKey,
                ) != null
            ) return null;

            let batchTarget = capabilityTargetToMemory(
                plan.batch_target
            );
            let headTarget = capabilityTargetToMemory(
                plan.head_target
            );
            if (
                headTarget != head.kernel_identity.target or
                Map.get(
                    mem.certified_records,
                    Text.compare,
                    certifiedRecordStableKey(batchTarget),
                ) != null or
                not currentCertifiedIdentityMatches(
                    head.kernel_identity,
                    post.like_head_key,
                )
            ) return null;

            let batchBytes = plan.batch_candid.size();
            let oldHeadBytes = Nat32.toNat(
                head.kernel_identity.body_length
            );
            let newHeadBytes = plan.next_head_candid.size();
            if (
                mem.certified_object_count >=
                    mem.quota_limits.certified_object_count or
                not canApplyByteReplacement(
                    mem.certified_object_bytes,
                    mem.quota_limits.certified_object_bytes,
                    oldHeadBytes,
                    newHeadBytes + batchBytes,
                ) or
                not canApplyByteReplacement(
                    mem.authored_bytes,
                    mem.quota_limits.authored_bytes,
                    oldHeadBytes,
                    newHeadBytes,
                ) or
                post.retained_bytes < oldHeadBytes
            ) return null;

            let fingerprint = switch (
                Hash.lpHash(
                    "wagyu.like-batch-and-head-publication.v1",
                    [
                        post.post_id,
                        head.body_digest,
                        plan.batch_digest,
                        plan.next_head_digest,
                    ],
                )
            ) {
                case null return null;
                case (?value) value;
            };
            let mutations = switch (
                PublicationJournal.likeBatchAndHead({
                    batch = {
                        target = plan.batch_target;
                        body_digest = plan.batch_digest;
                        body_length = plan.batch_candid.size();
                    };
                    head = {
                        target = plan.head_target;
                        body_digest = plan.next_head_digest;
                        body_length = plan.next_head_candid.size();
                    };
                    expected_head =
                        plan.previous_head.kernel_identity;
                })
            ) {
                case (#err(_)) return null;
                case (#ok(value)) value;
            };
            let ?journal = preparePublicationJournal(
                #positive_batch,
                plan.commit.nonce,
                fingerprint,
                mutations,
            ) else return null;

            let retainUntil = addSaturating(
                sealedAt,
                mem.retention.likes_ns,
            );
            let retention = switch (
                RetentionService.prepareRegistration(
                    {
                        peer_records_ns =
                            mem.retention.peer_records_ns;
                        likes_ns = mem.retention.likes_ns;
                        rate_window_ns =
                            mem.retention.rate_window_ns;
                    },
                    mem.retention_sequence,
                    #sealed_like_batch({
                        batch_key = batchKey;
                        sealed_at_ns = sealedAt;
                        retain_until_ns = retainUntil;
                        withdrawn_at_ns = null;
                        accounted_bytes = ?batchBytes;
                        post_key = post.post_key;
                        batch_number = plan.batch.batch_number;
                        certified_record_detached = false;
                    }),
                )
            ) {
                case (#err(_)) return null;
                case (#ok(value)) value;
            };
            if (not canApplyRetentionRegistration(retention)) {
                return null;
            };
            ?{
                publication_id = mem.publication_sequence + 1;
                batch_key = batchKey;
                batch_number_key = numberKey;
                fingerprint;
                journal;
                retention;
            };
        };

        func commitLikeSealPersistence(
            post : Memory.AuthoredPost,
            head : Memory.LikeHeadState,
            likeState : Memory.PostLikeState,
            plan : LikeSealing.SealPlan,
            batchCapabilityIdentity :
                NeutronCapabilities.RecordIdentity,
            headCapabilityIdentity :
                NeutronCapabilities.RecordIdentity,
            preflight : LikeSealPreflight,
            sealedAt : Nat64,
            closing : ?{
                action_key : Text;
                state : ClosingTypes.ClosingState;
            },
        ) {
            let batchIdentity = capabilityIdentityToMemory(
                batchCapabilityIdentity
            );
            let headIdentity = capabilityIdentityToMemory(
                headCapabilityIdentity
            );
            let advancesActiveSegment =
                plan.mode == #open_partial;
            let activeSegment = ingressMemoryLikeSegment(
                plan.next_segments.active,
                post.post_id,
                if (advancesActiveSegment) {
                    likeState.next_segment_number;
                } else {
                    likeState.active_segment.segment_number;
                },
            );
            let nextClosing = switch (closing) {
                case null likeState.closing;
                case (?value) {
                    ?memoryLikeClosingState(
                        value.action_key,
                        value.state,
                    );
                };
            };
            let nextLikeState : Memory.PostLikeState = {
                likeState with
                active_segment = activeSegment;
                due_segment = null;
                next_segment_number =
                    if (advancesActiveSegment) {
                        likeState.next_segment_number + 1;
                    } else {
                        likeState.next_segment_number;
                    };
                next_batch_number = plan.batch.batch_number + 1;
                previous_batch_digest = ?plan.batch_digest;
                closing = nextClosing;
                // Pending notification/evidence quarantine remains charged
                // while this verified segment is certified.
                unsealed_receipt_count = Nat16.fromNat(
                    Nat16.toNat(
                        likeState.unsealed_receipt_count
                    ) -
                    (
                        Nat16.toNat(
                            likeState.active_segment.receipt_count
                        ) +
                        (
                            switch (likeState.due_segment) {
                                case null 0;
                                case (?segment) {
                                    Nat16.toNat(
                                        segment.receipt_count
                                    );
                                };
                            }
                        )
                    ) +
                    LikeAdmission.unsealedCount(
                        plan.next_segments
                    )
                );
                unsealed_receipt_bytes =
                    activeSegment.receipt_bytes;
            };
            let retainUntil = addSaturating(
                sealedAt,
                mem.retention.likes_ns,
            );
            Map.add(
                mem.sealed_like_batches,
                Text.compare,
                preflight.batch_key,
                {
                    batch_key = preflight.batch_key;
                    post_key = post.post_key;
                    value = protocolLikeBatchToMemory(plan.batch);
                    exact_body_candid = plan.batch_candid;
                    body_digest = plan.batch_digest;
                    body_length =
                        Nat32.fromNat(plan.batch_candid.size());
                    kernel_identity = batchIdentity;
                    publication_id = preflight.publication_id;
                    sealed_at_ns = sealedAt;
                    retain_until_ns = retainUntil;
                },
            );
            Map.add(
                mem.sealed_batches_by_post_number,
                Text.compare,
                preflight.batch_number_key,
                preflight.batch_key,
            );
            Map.add(
                mem.like_heads,
                Text.compare,
                post.like_head_key,
                {
                    head_key = post.like_head_key;
                    value = protocolLikeHeadToMemory(
                        plan.next_head
                    );
                    exact_body_candid = plan.next_head_candid;
                    body_digest = plan.next_head_digest;
                    kernel_identity = headIdentity;
                    publication_id = preflight.publication_id;
                },
            );
            Map.add(
                mem.like_states,
                Text.compare,
                post.post_key,
                nextLikeState,
            );
            replacePostHeadAccounting(
                post,
                Nat32.toNat(head.kernel_identity.body_length),
                plan.next_head_candid.size(),
                switch (closing) {
                    case null post.status;
                    case (?value) {
                        #withdrawal_closing(
                            memoryWithdrawalClosing(
                                value.action_key,
                                value.state,
                            )
                        );
                    };
                },
            );
            rememberNewCertifiedRecord(
                batchIdentity,
                preflight.publication_id,
                ?preflight.batch_key,
                sealedAt,
            );
            replaceCertifiedRecord(
                head.kernel_identity,
                headIdentity,
                preflight.publication_id,
                ?post.like_head_key,
                sealedAt,
            );
            applyRetentionRegistration(preflight.retention);
            mem.publication_sequence := preflight.publication_id;
            rememberCommittedPublication(
                preflight.publication_id,
                #like_batch_and_head,
                preflight.journal,
                [batchIdentity, headIdentity],
                sealedAt,
            );
            bumpState();
        };

        type HeadStopPreflight = {
            publication_id : Nat64;
            journal : PublicationJournal.Plan;
        };

        type WithdrawalFinalizePreflight = {
            fanout_job_id : ?Nat64;
            eligible_count : Nat;
            retained_bytes : Nat;
            retention : ?RetentionTypes.RegistrationPlan;
        };

        type WithdrawalRetentionAdvance = {
            batch_cursor : ?Nat64;
            receipt_cursor : ?Nat64;
            retention : ?RetentionTypes.RegistrationPlan;
            processed_count : Nat;
        };

        func advanceWithdrawal(
            request : PostDeleteRequestV1
        ) : LocalResultV1<PublishResultV1> {
            if (not networkConfigured()) return #err(#not_configured);
            if (
                request.post_id.size() != Bounds.HASH_BYTES or
                request.nonce.size() != Bounds.NONCE_BYTES
            ) return #err(#invalid);
            let postKey = postStableKey(request.post_id);
            let ?post = Map.get(
                mem.authored_posts,
                Text.compare,
                postKey,
            ) else return #err(#not_found);
            switch (post.status) {
                case (#withdrawal_awaiting_proof(info)) {
                    beginWithdrawalClosing(
                        request,
                        post,
                        info.tombstone_action_key,
                    );
                };
                case (#withdrawal_closing(cursor)) {
                    continueWithdrawalClosing(
                        request,
                        post,
                        cursor,
                    );
                };
                case (#withdrawn(info)) {
                    let ?action = Map.get(
                        mem.authored_actions,
                        Text.compare,
                        info.tombstone_action_key,
                    ) else return #err(#conflict);
                    #ok({
                        stage = ?#complete;
                        post_id = ?post.post_id;
                        action_id = ?action.action_id;
                        object_digest = ?action.object_digest;
                        queued_recipient_count = 0;
                        queued_notice_count = 0;
                        accepted_recipient_count = 0;
                        failed_recipient_count = 0;
                        message =
                            "This post withdrawal is already complete.";
                    });
                };
                case (_) #err(#conflict);
            };
        };

        func beginWithdrawalClosing(
            request : PostDeleteRequestV1,
            post : Memory.AuthoredPost,
            actionKey : Text,
        ) : LocalResultV1<PublishResultV1> {
            let ?action = Map.get(
                mem.authored_actions,
                Text.compare,
                actionKey,
            ) else return #err(#conflict);
            let (
                exactCertifiedTombstone,
                certifiedTombstone,
            ) = switch (action.kind, action.object_state) {
                case (
                    #tombstone(info),
                    #certified(_),
                ) {
                    let ?exact = info.exact_tombstone_candid
                    else return #err(#conflict);
                    let ?decoded = Wire.decodeCertifiedTombstone(
                        exact
                    ) else return #err(#conflict);
                    (exact, decoded);
                };
                case (_) return #err(#conflict);
            };
            let ?tombstoneIdentity = authoredActionCertifiedIdentity(
                action,
                #tombstones,
            ) else return #err(#conflict);
            let ?decodedAction = Wire.decodeTombstoneAction(
                action.exact_body_candid
            ) else return #err(#conflict);
            let rebuildNonce = derivedNonce(
                "wagyu.withdrawal-tombstone-rebuild.v1",
                request.nonce,
                action.object_digest,
            );
            let tombstonePlan = switch (
                Planner.prepareTombstone({
                    network_id = decodedAction.header.network_id;
                    author = decodedAction.header.actor_;
                    author_sequence =
                        decodedAction.author_sequence;
                    issued_at_ns = decodedAction.issued_at_ns;
                    post_id = decodedAction.post_id;
                    post_body_hash =
                        decodedAction.post_body_hash;
                    tombstones_generation =
                        tombstoneIdentity.target.collection_generation;
                    publication_nonce = rebuildNonce;
                })
            ) {
                case (#err(_)) return #err(#conflict);
                case (#ok(value)) value;
            };
            if (
                not Blob.equal(
                    tombstonePlan.body_candid,
                    action.exact_body_candid,
                ) or
                not Blob.equal(
                    tombstonePlan.object_digest,
                    action.object_digest,
                ) or
                not Blob.equal(
                    tombstonePlan.tombstone_id,
                    action.action_id,
                ) or
                capabilityTargetToMemory(tombstonePlan.target) !=
                    tombstoneIdentity.target or
                not Blob.equal(
                    exactCertifiedTombstone,
                    to_candid (certifiedTombstone),
                )
            ) return #err(#conflict);
            let ?head = Map.get(
                mem.like_heads,
                Text.compare,
                post.like_head_key,
            ) else return #err(#conflict);
            let ?likeState = Map.get(
                mem.like_states,
                Text.compare,
                post.post_key,
            ) else return #err(#conflict);
            if (
                not head.value.accepting_likes or
                likeState.closing != null
            ) return #err(#conflict);
            let ?segments = memoryLikeSegments(likeState)
            else return #err(#conflict);
            let startedAt = nowNs();
            let stopNonce = derivedNonce(
                "wagyu.withdrawal-stop-likes.v1",
                request.nonce,
                head.body_digest,
            );
            let start = switch (
                ClosingService.planStart({
                    tombstone_plan = tombstonePlan;
                    proof =
                        certifiedTombstone.ref.proof_snapshot;
                    head = memoryLikeHeadState(head);
                    segments;
                    follower_registration_cutoff =
                        mem.follower_registration_sequence;
                    started_at_ns = startedAt;
                    publication_nonce = stopNonce;
                })
            ) {
                case (#err(_)) return #err(#conflict);
                case (#ok(value)) value;
            };
            if (
                not Blob.equal(
                    start.exact_tombstone_candid,
                    exactCertifiedTombstone,
                )
            ) return #err(#conflict);
            let ?preflight = prepareHeadStopPersistence(
                post,
                head,
                start.stop,
            ) else return #err(#full);
            let reconciled = switch (
                certifiedAssets.commit_batch(start.commit)
            ) {
                case (#err(#quota or #receipt_full)) {
                    return #err(#full);
                };
                case (#err(_)) return #err(#certified_store);
                case (#ok(receipt)) {
                    switch (
                        ClosingService.reconcileStart(
                            start,
                            receipt,
                        )
                    ) {
                        case (#err(_)) {
                            return #err(#certified_store);
                        };
                        case (#ok(value)) value;
                    };
                };
            };
            commitHeadStopPersistence(
                post,
                head,
                likeState,
                actionKey,
                reconciled.closing,
                reconciled.head_identity,
                preflight,
                startedAt,
            );
            #ok({
                stage = ?#certified_ref_ready;
                post_id = ?post.post_id;
                action_id = ?action.action_id;
                object_digest = ?action.object_digest;
                queued_recipient_count = 0;
                queued_notice_count = 0;
                accepted_recipient_count = 0;
                failed_recipient_count = 0;
                message =
                    "Likes are closed at the certified head; bounded Like archival can now advance.";
            });
        };

        func prepareHeadStopPersistence(
            post : Memory.AuthoredPost,
            head : Memory.LikeHeadState,
            stop : LikeSealing.StopPlan,
        ) : ?HeadStopPreflight {
            if (
                mem.state_revision == Nat64.maxValue or
                mem.publication_sequence == Nat64.maxValue or
                not Blob.equal(
                    stop.previous_head.exact_body_candid,
                    head.exact_body_candid,
                ) or
                stop.previous_head.kernel_identity.kernel_revision !=
                    head.kernel_identity.kernel_revision or
                not Blob.equal(
                    stop.previous_head.kernel_identity.content_tag,
                    head.kernel_identity.content_tag,
                ) or
                capabilityTargetToMemory(stop.head_target) !=
                    head.kernel_identity.target or
                stop.commit.operations.size() != 1 or
                stop.commit.requires_present_after.size() != 0 or
                not currentCertifiedIdentityMatches(
                    head.kernel_identity,
                    post.like_head_key,
                )
            ) return null;
            let oldHeadBytes = Nat32.toNat(
                head.kernel_identity.body_length
            );
            let newHeadBytes = stop.next_head_candid.size();
            if (
                post.retained_bytes < oldHeadBytes or
                not canApplyByteReplacement(
                    mem.certified_object_bytes,
                    mem.quota_limits.certified_object_bytes,
                    oldHeadBytes,
                    newHeadBytes,
                ) or
                not canApplyByteReplacement(
                    mem.authored_bytes,
                    mem.quota_limits.authored_bytes,
                    oldHeadBytes,
                    newHeadBytes,
                )
            ) return null;
            let fingerprint = switch (
                Hash.lpHash(
                    "wagyu.stop-likes-publication.v1",
                    [
                        post.post_id,
                        head.body_digest,
                        stop.next_head_digest,
                    ],
                )
            ) {
                case null return null;
                case (?value) value;
            };
            let mutations = switch (
                PublicationJournal.headStop({
                    head = {
                        target = stop.head_target;
                        body_digest = stop.next_head_digest;
                        body_length =
                            stop.next_head_candid.size();
                    };
                    expected_head =
                        stop.previous_head.kernel_identity;
                })
            ) {
                case (#err(_)) return null;
                case (#ok(value)) value;
            };
            let ?journal = preparePublicationJournal(
                #positive_batch,
                stop.commit.nonce,
                fingerprint,
                mutations,
            ) else return null;
            ?{
                publication_id = mem.publication_sequence + 1;
                journal;
            };
        };

        func commitHeadStopPersistence(
            post : Memory.AuthoredPost,
            head : Memory.LikeHeadState,
            likeState : Memory.PostLikeState,
            actionKey : Text,
            closing : ClosingTypes.ClosingState,
            headCapabilityIdentity :
                NeutronCapabilities.RecordIdentity,
            preflight : HeadStopPreflight,
            committedAt : Nat64,
        ) {
            let headIdentity = capabilityIdentityToMemory(
                headCapabilityIdentity
            );
            Map.add(
                mem.like_heads,
                Text.compare,
                post.like_head_key,
                {
                    head_key = post.like_head_key;
                    value = protocolLikeHeadToMemory(
                        closing.head.value
                    );
                    exact_body_candid =
                        closing.head.exact_body_candid;
                    body_digest = Hash.objectDigest(
                        closing.head.exact_body_candid
                    );
                    kernel_identity = headIdentity;
                    publication_id = preflight.publication_id;
                },
            );
            Map.add(
                mem.like_states,
                Text.compare,
                post.post_key,
                {
                    likeState with
                    closing = ?memoryLikeClosingState(
                        actionKey,
                        closing,
                    );
                    // Closing rejects every later promotion. Quarantined
                    // evidence remains in notification retention, but no
                    // longer consumes the post's live Like-admission budget.
                    unsealed_receipt_count = Nat16.fromNat(
                        Nat16.toNat(
                            likeState.active_segment.receipt_count
                        ) +
                        (
                            switch (likeState.due_segment) {
                                case null 0;
                                case (?segment) {
                                    Nat16.toNat(
                                        segment.receipt_count
                                    );
                                };
                            }
                        )
                    );
                },
            );
            replacePostHeadAccounting(
                post,
                Nat32.toNat(head.kernel_identity.body_length),
                closing.head.exact_body_candid.size(),
                #withdrawal_closing(
                    memoryWithdrawalClosing(
                        actionKey,
                        closing,
                    )
                ),
            );
            replaceCertifiedRecord(
                head.kernel_identity,
                headIdentity,
                preflight.publication_id,
                ?post.like_head_key,
                committedAt,
            );
            mem.publication_sequence := preflight.publication_id;
            rememberCommittedPublication(
                preflight.publication_id,
                #stop_likes,
                preflight.journal,
                [headIdentity],
                committedAt,
            );
            bumpState();
        };

        func continueWithdrawalClosing(
            request : PostDeleteRequestV1,
            post : Memory.AuthoredPost,
            cursor : Memory.WithdrawalClosing,
        ) : LocalResultV1<PublishResultV1> {
            if (
                cursor.phase == #ready_for_fanout and
                (
                    cursor.due_batch_number != null or
                    cursor.final_partial_batch_number != null
                )
            ) {
                return advanceWithdrawalRetention(
                    post,
                    cursor,
                    nowNs(),
                );
            };
            let ?closing = reconstructWithdrawalClosing(
                post,
                cursor,
            ) else return #err(#conflict);
            let batchGeneration = switch (closing.phase) {
                case (#ready_for_fanout) (0 : Nat64);
                case (_) {
                    let ?value = collectionGeneration(
                        Publication.LIKE_BATCHES_COLLECTION
                    ) else return #err(#certified_store);
                    value;
                };
            };
            let updatedAt = nowNs();
            let nonce = derivedNonce(
                "wagyu.withdrawal-advance.v1",
                request.nonce,
                Hash.objectDigest(closing.head.exact_body_candid),
            );
            let next = switch (
                ClosingService.planNext({
                    closing;
                    like_batches_generation = batchGeneration;
                    publication_nonce = nonce;
                    updated_at_ns = updatedAt;
                })
            ) {
                case (
                    #err(
                        #already_complete or
                        #invalid_state or
                        #invalid_segments or
                        #invalid_time
                    )
                ) return #err(#conflict);
                case (#err(_)) return #err(#full);
                case (#ok(value)) value;
            };
            switch (next) {
                case (#publish(plan)) {
                    publishWithdrawalLikeBatch(
                        post,
                        cursor.tombstone_action_key,
                        plan,
                        updatedAt,
                    );
                };
                case (#finalize(plan)) {
                    finalizeWithdrawalLocally(
                        post,
                        cursor.tombstone_action_key,
                        plan,
                        updatedAt,
                    );
                };
            };
        };

        func advanceWithdrawalRetention(
            post : Memory.AuthoredPost,
            cursor : Memory.WithdrawalClosing,
            updatedAt : Nat64,
        ) : LocalResultV1<PublishResultV1> {
            let ?advance = prepareWithdrawalRetentionAdvance(
                post,
                cursor,
                updatedAt,
            ) else return #err(#full);
            let ?likeState = Map.get(
                mem.like_states,
                Text.compare,
                post.post_key,
            ) else return #err(#conflict);
            let ?closing = likeState.closing else {
                return #err(#conflict);
            };
            let ?action = Map.get(
                mem.authored_actions,
                Text.compare,
                cursor.tombstone_action_key,
            ) else return #err(#conflict);
            if (
                cursor.phase != #ready_for_fanout or
                closing.phase != #complete or
                closing.tombstone_action_key !=
                    cursor.tombstone_action_key
            ) return #err(#conflict);
            let nextCursor : Memory.WithdrawalClosing = {
                cursor with
                due_batch_number = advance.batch_cursor;
                final_partial_batch_number =
                    advance.receipt_cursor;
                updated_at_ns = updatedAt;
            };
            Map.add(
                mem.authored_posts,
                Text.compare,
                post.post_key,
                {
                    post with
                    status = #withdrawal_closing(nextCursor);
                },
            );
            Map.add(
                mem.like_states,
                Text.compare,
                post.post_key,
                {
                    likeState with
                    closing = ?{
                        closing with
                        updated_at_ns = updatedAt;
                    };
                },
            );
            switch (advance.retention) {
                case null {};
                case (?retention) {
                    applyRetentionRegistration(retention);
                };
            };
            bumpState();
            #ok({
                stage = ?#certified_ref_ready;
                post_id = ?post.post_id;
                action_id = ?action.action_id;
                object_digest = ?action.object_digest;
                queued_recipient_count = 0;
                queued_notice_count = 0;
                accepted_recipient_count = 0;
                failed_recipient_count = 0;
                message =
                    if (
                        advance.batch_cursor == null and
                        advance.receipt_cursor == null
                    ) {
                        "Withdrawal retention indexes are detached from the completed post; final fanout can advance.";
                    } else {
                        "A bounded withdrawal retention page was durably reindexed.";
                    };
            });
        };

        func prepareWithdrawalRetentionAdvance(
            post : Memory.AuthoredPost,
            cursor : Memory.WithdrawalClosing,
            withdrawnAt : Nat64,
        ) : ?WithdrawalRetentionAdvance {
            if (
                cursor.phase != #ready_for_fanout or
                mem.state_revision == Nat64.maxValue
            ) return null;
            let ?head = Map.get(
                mem.like_heads,
                Text.compare,
                post.like_head_key,
            ) else return null;
            let ?likeState = Map.get(
                mem.like_states,
                Text.compare,
                post.post_key,
            ) else return null;
            let acceptedCount = switch (
                Map.get(
                    mem.accepted_like_count_by_post,
                    Text.compare,
                    post.post_key,
                )
            ) {
                case null 0;
                case (?count) count;
            };
            let closingComplete = switch (likeState.closing) {
                case (?closing) closing.phase == #complete;
                case null false;
            };
            // ready_for_fanout is also the durable proof that every promoted
            // Like was sealed. This equality lets the per-post batch walk
            // cover every accepted row without searching the global index.
            if (
                not closingComplete or
                likeState.active_segment.receipt_count != 0 or
                likeState.active_segment.accepted_like_keys.size() != 0 or
                likeState.due_segment != null or
                likeState.unsealed_receipt_count != 0 or
                likeState.unsealed_receipt_bytes != 0 or
                likeState.next_batch_number !=
                    head.value.sealed_batch_count or
                acceptedCount !=
                    Nat64.toNat(head.value.sealed_receipt_count)
            ) return null;

            let requests =
                List.empty<RetentionTypes.RegistrationRequest>();
            var processed = 0;
            var batchCursor : ?Nat64 = null;
            var receiptCursor : ?Nat64 = null;
            switch (
                cursor.due_batch_number,
                cursor.final_partial_batch_number,
            ) {
                case (null, null) {};
                case (?batchNumber, ?receiptOffset) {
                    if (head.value.sealed_batch_count == 0) {
                        if (
                            batchNumber != 0 or
                            receiptOffset != 0 or
                            acceptedCount != 0
                        ) return null;
                    } else {
                        let numberKey =
                            sealedLikeBatchNumberStableKey(
                                post.post_id,
                                batchNumber,
                            );
                        let ?batchKey = Map.get(
                            mem.sealed_batches_by_post_number,
                            Text.compare,
                            numberKey,
                        ) else return null;
                        let ?batch = Map.get(
                            mem.sealed_like_batches,
                            Text.compare,
                            batchKey,
                        ) else return null;
                        let ?exactBatch = Wire.decodeLikeBatch(
                            batch.exact_body_candid
                        ) else return null;
                        if (
                            batch.post_key != post.post_key or
                            batch.value.batch_number != batchNumber or
                            exactBatch.batch_number != batchNumber or
                            not Principal.equal(
                                exactBatch.post_author,
                                node,
                            ) or
                            not Blob.equal(
                                exactBatch.post_id,
                                post.post_id,
                            ) or
                            not Blob.equal(
                                exactBatch.post_body_hash,
                                post.body_hash,
                            ) or
                            exactBatch.receipts.size() !=
                                batch.value.receipts.size() or
                            not Blob.equal(
                                Hash.objectDigest(
                                    batch.exact_body_candid
                                ),
                                batch.body_digest,
                            )
                        ) return null;
                        let ?page = ClosingService.retentionPage(
                            batchNumber,
                            head.value.sealed_batch_count,
                            receiptOffset,
                            exactBatch.receipts.size(),
                            64,
                        ) else return null;
                        var index = page.first_receipt;
                        while (index < page.past_receipt) {
                            let receipt = exactBatch.receipts[index];
                            let acceptedKey = acceptedLikeStableKey(
                                post.post_id,
                                receipt.ref.actor_,
                            );
                            let ?accepted = Map.get(
                                mem.accepted_likes,
                                Text.compare,
                                acceptedKey,
                            ) else return null;
                            let ?acceptedReceipt =
                                Wire.decodeCertifiedLikeReceipt(
                                    accepted
                                        .exact_certified_like_receipt_candid
                                )
                                else return null;
                            let ?notification = Map.get(
                                mem.notifications,
                                Nat64.compare,
                                accepted.notification_sequence,
                            ) else return null;
                            if (
                                accepted.accepted_like_key !=
                                    acceptedKey or
                                accepted.post_key != post.post_key or
                                not Blob.equal(
                                    accepted.post_id,
                                    post.post_id,
                                ) or
                                not Blob.equal(
                                    accepted.post_body_hash,
                                    post.body_hash,
                                ) or
                                not Principal.equal(
                                    accepted.liker,
                                    receipt.ref.actor_,
                                ) or
                                acceptedReceipt != receipt or
                                accepted.accepted_sequence <
                                    exactBatch.first_accepted_sequence or
                                accepted.accepted_sequence >
                                    exactBatch.last_accepted_sequence or
                                not acceptedLikeNotificationVerified(
                                    acceptedKey,
                                    accepted,
                                    notification,
                                )
                            ) return null;
                            processed += 1;
                            if (
                                accepted.retain_until_ns > withdrawnAt
                            ) {
                                let record :
                                    Memory.RetentionRecordRef =
                                    #accepted_like(acceptedKey);
                                List.add(requests, {
                                    view = #accepted_like({
                                        accepted_like_key =
                                            acceptedKey;
                                        accepted_sequence =
                                            accepted.accepted_sequence;
                                        accepted_at_ns =
                                            accepted.accepted_at_ns;
                                        retain_until_ns =
                                            accepted.retain_until_ns;
                                        withdrawn_at_ns =
                                            ?withdrawnAt;
                                        retained_bytes =
                                            accepted.retained_bytes;
                                        post_key =
                                            accepted.post_key;
                                        notification_sequence =
                                            accepted
                                                .notification_sequence;
                                        segment = null;
                                    });
                                    expected_previous =
                                        currentRetentionEntry(record);
                                });
                            };
                            index += 1;
                        };
                        if (page.include_batch) {
                            processed += 1;
                            if (batch.retain_until_ns > withdrawnAt) {
                                let record :
                                    Memory.RetentionRecordRef =
                                    #sealed_like_batch(
                                        batch.batch_key
                                    );
                                List.add(requests, {
                                    view = #sealed_like_batch({
                                        batch_key = batch.batch_key;
                                        sealed_at_ns =
                                            batch.sealed_at_ns;
                                        retain_until_ns =
                                            batch.retain_until_ns;
                                        withdrawn_at_ns =
                                            ?withdrawnAt;
                                        accounted_bytes =
                                            ?Nat32.toNat(
                                                batch.body_length
                                            );
                                        post_key = batch.post_key;
                                        batch_number =
                                            batch.value.batch_number;
                                        certified_record_detached =
                                            false;
                                    });
                                    expected_previous =
                                        currentRetentionEntry(record);
                                });
                            };
                        };
                        switch (page.next) {
                            case null {};
                            case (?next) {
                                batchCursor :=
                                    ?next.batch_number;
                                receiptCursor :=
                                    ?next.receipt_offset;
                            };
                        };
                    };
                };
                case (_) return null;
            };

            let retention = if (List.size(requests) == 0) {
                null;
            } else {
                switch (
                    RetentionService.prepareRegistrations(
                        {
                            peer_records_ns =
                                mem.retention.peer_records_ns;
                            likes_ns = mem.retention.likes_ns;
                            rate_window_ns =
                                mem.retention.rate_window_ns;
                        },
                        mem.retention_sequence,
                        List.toArray(requests),
                    )
                ) {
                    case (#err(_)) return null;
                    case (#ok(value)) {
                        if (
                            not canApplyRetentionRegistration(value)
                        ) return null;
                        ?value;
                    };
                };
            };
            ?{
                batch_cursor = batchCursor;
                receipt_cursor = receiptCursor;
                retention;
                processed_count = processed;
            };
        };

        func publishWithdrawalLikeBatch(
            post : Memory.AuthoredPost,
            actionKey : Text,
            closingPlan : ClosingTypes.SealPlan,
            sealedAt : Nat64,
        ) : LocalResultV1<PublishResultV1> {
            let ?head = Map.get(
                mem.like_heads,
                Text.compare,
                post.like_head_key,
            ) else return #err(#conflict);
            let ?likeState = Map.get(
                mem.like_states,
                Text.compare,
                post.post_key,
            ) else return #err(#conflict);
            let ?preflight = prepareLikeSealPersistence(
                post,
                head,
                likeState,
                closingPlan.sealing,
                sealedAt,
            ) else return #err(#full);
            let reconciled = switch (
                certifiedAssets.commit_batch(closingPlan.commit)
            ) {
                case (#err(#quota or #receipt_full)) {
                    return #err(#full);
                };
                case (#err(_)) return #err(#certified_store);
                case (#ok(receipt)) {
                    switch (
                        ClosingService.reconcileSeal(
                            closingPlan,
                            receipt,
                        )
                    ) {
                        case (#err(_)) {
                            return #err(#certified_store);
                        };
                        case (#ok(value)) value;
                    };
                };
            };
            commitLikeSealPersistence(
                post,
                head,
                likeState,
                closingPlan.sealing,
                reconciled.batch_identity,
                reconciled.head_identity,
                preflight,
                sealedAt,
                ?{
                    action_key = actionKey;
                    state = reconciled.closing;
                },
            );
            #ok({
                stage = ?#certified_ref_ready;
                post_id = ?post.post_id;
                action_id =
                    ?closingPlan.previous.tombstone_id;
                object_digest =
                    ?closingPlan.sealing.batch_digest;
                queued_recipient_count = 0;
                queued_notice_count = 0;
                accepted_recipient_count = 0;
                failed_recipient_count = 0;
                message =
                    "One withdrawal Like segment was certified; the durable closing cursor advanced.";
            });
        };

        func reconstructWithdrawalClosing(
            post : Memory.AuthoredPost,
            cursor : Memory.WithdrawalClosing,
        ) : ?ClosingTypes.ClosingState {
            let ?action = Map.get(
                mem.authored_actions,
                Text.compare,
                cursor.tombstone_action_key,
            ) else return null;
            let exact = switch (action.kind, action.object_state) {
                case (#tombstone(info), #certified(_)) {
                    let ?value = info.exact_tombstone_candid
                    else return null;
                    value;
                };
                case (_) return null;
            };
            let ?certified = Wire.decodeCertifiedTombstone(exact)
            else return null;
            let ?head = Map.get(
                mem.like_heads,
                Text.compare,
                post.like_head_key,
            ) else return null;
            let ?likeState = Map.get(
                mem.like_states,
                Text.compare,
                post.post_key,
            ) else return null;
            let ?segments = memoryLikeSegments(likeState)
            else return null;
            let phase : ClosingTypes.Phase = switch (cursor.phase) {
                case (#stop_likes) return null;
                case (#seal_due) #seal_due;
                case (#seal_final_partial) #seal_final_partial;
                case (#ready_for_fanout) #ready_for_fanout;
            };
            let ?storedClosing = likeState.closing else return null;
            if (
                storedClosing.tombstone_action_key !=
                    cursor.tombstone_action_key or
                storedClosing.started_at_ns != cursor.started_at_ns or
                storedClosing.updated_at_ns != cursor.updated_at_ns or
                not memoryClosingPhaseMatches(
                    storedClosing.phase,
                    phase,
                )
            ) return null;
            ?{
                tombstone_id = action.action_id;
                certified_tombstone = certified;
                exact_tombstone_candid = exact;
                follower_registration_cutoff =
                    cursor.follower_registration_cutoff;
                head = memoryLikeHeadState(head);
                segments;
                phase;
                started_at_ns = cursor.started_at_ns;
                updated_at_ns = cursor.updated_at_ns;
            };
        };

        func memoryWithdrawalClosing(
            actionKey : Text,
            closing : ClosingTypes.ClosingState,
        ) : Memory.WithdrawalClosing {
            let phase : Memory.WithdrawalPhase = switch (
                closing.phase
            ) {
                case (#stop_likes) #stop_likes;
                case (#seal_due) #seal_due;
                case (#seal_final_partial) #seal_final_partial;
                case (#ready_for_fanout or #complete) {
                    #ready_for_fanout;
                };
            };
            let dueBatch = switch (closing.segments.due) {
                case null null;
                case (?_) {
                    ?closing.head.value.sealed_batch_count;
                };
            };
            let finalPartial = if (
                closing.segments.active.size() == 0
            ) {
                null;
            } else {
                switch (closing.segments.due) {
                    case null {
                        ?closing.head.value.sealed_batch_count;
                    };
                    case (?_) {
                        if (
                            closing.head.value.sealed_batch_count ==
                                Nat64.maxValue
                        ) null else {
                            ?(
                                closing.head.value.sealed_batch_count +
                                1
                            );
                        };
                    };
                };
            };
            let ready = closing.phase == #ready_for_fanout;
            {
                tombstone_action_key = actionKey;
                follower_registration_cutoff =
                    closing.follower_registration_cutoff;
                phase;
                // Once archival reaches ready_for_fanout these two otherwise
                // unused cursors drive bounded reindexing of accepted Likes
                // and sealed batches to the earlier withdrawal horizon.
                due_batch_number =
                    if (ready) ?(0 : Nat64) else dueBatch;
                final_partial_batch_number =
                    if (ready) ?(0 : Nat64)
                    else finalPartial;
                started_at_ns = closing.started_at_ns;
                updated_at_ns = closing.updated_at_ns;
            };
        };

        func memoryLikeClosingState(
            actionKey : Text,
            closing : ClosingTypes.ClosingState,
        ) : Memory.LikeClosingState {
            let phase : Memory.LikeClosingPhase = switch (
                closing.phase
            ) {
                case (#stop_likes) #stop_head;
                case (#seal_due) #seal_due;
                case (#seal_final_partial) #seal_final_partial;
                case (#ready_for_fanout or #complete) #complete;
            };
            {
                phase;
                tombstone_action_key = actionKey;
                started_at_ns = closing.started_at_ns;
                updated_at_ns = closing.updated_at_ns;
            };
        };

        func memoryClosingPhaseMatches(
            memory : Memory.LikeClosingPhase,
            closing : ClosingTypes.Phase,
        ) : Bool {
            switch (memory, closing) {
                case (#stop_head, #stop_likes) true;
                case (#seal_due, #seal_due) true;
                case (#seal_final_partial, #seal_final_partial) true;
                case (#complete, #ready_for_fanout or #complete) true;
                case (_) false;
            };
        };

        func authoredActionCertifiedIdentity(
            action : Memory.AuthoredAction,
            collection : Memory.CertifiedCollection,
        ) : ?Memory.KernelRecordIdentity {
            switch (action.object_state) {
                case (#certified(_)) {};
                case (_) return null;
            };
            let ?record = certifiedRecordForLocalObject(
                action.action_key
            ) else return null;
            if (
                record.identity.target.collection != collection or
                not Blob.equal(
                    record.identity.body_digest,
                    action.object_digest,
                ) or
                record.identity.body_length != action.body_length
            ) return null;
            ?record.identity;
        };

        func publicationRecords(
            publication : Memory.CertifiedPublication
        ) : [Memory.KernelRecordIdentity] {
            switch (publication.state) {
                case (#committed(info)) info.records;
                case (_) [];
            };
        };

        func finalizeWithdrawalLocally(
            post : Memory.AuthoredPost,
            actionKey : Text,
            plan : ClosingTypes.LocalFinalizePlan,
            finalizedAt : Nat64,
        ) : LocalResultV1<PublishResultV1> {
            let ?action = Map.get(
                mem.authored_actions,
                Text.compare,
                actionKey,
            ) else return #err(#conflict);
            if (
                not Blob.equal(
                    plan.suppression.post_id,
                    post.post_id,
                ) or
                not Blob.equal(
                    plan.suppression.post_body_hash,
                    post.body_hash,
                ) or
                not Principal.equal(
                    plan.suppression.author,
                    node,
                ) or
                plan.fanout.follower_registration_cutoff !=
                    plan.previous.follower_registration_cutoff or
                not Blob.equal(
                    plan.fanout.exact_event_candid,
                    plan.previous.exact_tombstone_candid,
                )
            ) return #err(#conflict);
            let ?preflight = prepareWithdrawalFinalize(
                plan,
                actionKey,
                finalizedAt,
            ) else return #err(#full);
            let ?likeState = Map.get(
                mem.like_states,
                Text.compare,
                post.post_key,
            ) else return #err(#conflict);
            Map.add(
                mem.authored_posts,
                Text.compare,
                post.post_key,
                {
                    post with
                    status = #withdrawn({
                        tombstone_action_key = actionKey;
                        withdrawn_at_ns = finalizedAt;
                        cleanup_phase = #retained;
                    });
                },
            );
            Map.add(
                mem.like_states,
                Text.compare,
                post.post_key,
                {
                    likeState with
                    closing = ?{
                        phase = #complete;
                        tombstone_action_key = actionKey;
                        started_at_ns =
                            plan.previous.started_at_ns;
                        updated_at_ns = finalizedAt;
                    };
                },
            );
            markPostCertifiedRecordWithdrawn(post, finalizedAt);
            switch (preflight.fanout_job_id) {
                case null {};
                case (?jobId) {
                    Map.add(
                        mem.fanout_jobs,
                        Nat64.compare,
                        jobId,
                        {
                            fanout_job_id = jobId;
                            kind = #tombstone;
                            action_key = actionKey;
                            exact_event_candid =
                                plan.fanout.exact_event_candid;
                            follower_registration_cutoff =
                                plan.fanout
                                    .follower_registration_cutoff;
                            after_registration_sequence = null;
                            state = #queued;
                            eligible_count = (0 : Nat32);
                            queued_count = (0 : Nat32);
                            completed_count = (0 : Nat32);
                            terminal_count = (0 : Nat32);
                            uncertain_count = (0 : Nat32);
                            created_at_ns = finalizedAt;
                            updated_at_ns = finalizedAt;
                            expires_at_ns = addSaturating(
                                finalizedAt,
                                mem.retention.peer_records_ns,
                            );
                            retained_bytes =
                                preflight.retained_bytes;
                        },
                    );
                    Map.add(
                        mem.fanout_target_count_by_job,
                        Nat64.compare,
                        jobId,
                        0,
                    );
                    incrementAuthoredDependency(actionKey);
                    mem.fanout_sequence := jobId;
                    mem.fanout_job_count += 1;
                    mem.fanout_bytes +=
                        preflight.retained_bytes;
                };
            };
            switch (preflight.retention) {
                case null {};
                case (?retention) {
                    applyRetentionRegistration(retention);
                };
            };
            bumpState();
            #ok({
                stage =
                    if (preflight.eligible_count == 0) {
                        ?#complete;
                    } else ?#fanout_queued;
                post_id = ?post.post_id;
                action_id = ?action.action_id;
                object_digest = ?action.object_digest;
                queued_recipient_count = 0;
                queued_notice_count = 0;
                accepted_recipient_count = 0;
                failed_recipient_count = 0;
                message =
                    if (preflight.eligible_count == 0) {
                        "The certified withdrawal is complete; no eligible direct follower required fanout.";
                    } else {
                        "The certified withdrawal is complete and its frozen-cutoff fanout job is durable.";
                    };
            });
        };

        func prepareWithdrawalFinalize(
            plan : ClosingTypes.LocalFinalizePlan,
            actionKey : Text,
            finalizedAt : Nat64,
        ) : ?WithdrawalFinalizePreflight {
            if (
                mem.state_revision == Nat64.maxValue or
                plan.next.phase != #complete
            ) return null;
            // The exact frozen-cutoff eligibility set is discovered by the
            // bounded fanout scanner. Physical active rows are a conservative
            // schema-neutral upper bound for deciding whether to persist it.
            let eligible = mem.active_follower_count;
            if (eligible == 0) {
                return ?{
                    fanout_job_id = null;
                    eligible_count = 0;
                    retained_bytes = 0;
                    retention = null;
                };
            };
            if (
                mem.fanout_sequence == Nat64.maxValue or
                mem.retention_sequence == Nat64.maxValue or
                mem.fanout_job_count >=
                    mem.quota_limits.fanout_job_count
            ) return null;
            let retainedBytes =
                plan.fanout.exact_event_candid.size() + 384;
            if (
                retainedBytes > mem.quota_limits.fanout_bytes or
                mem.fanout_bytes >
                    mem.quota_limits.fanout_bytes - retainedBytes
            ) return null;
            let jobId = mem.fanout_sequence + 1;
            let expires = addSaturating(
                finalizedAt,
                mem.retention.peer_records_ns,
            );
            let retention = switch (
                RetentionService.prepareRegistration(
                    {
                        peer_records_ns =
                            mem.retention.peer_records_ns;
                        likes_ns = mem.retention.likes_ns;
                        rate_window_ns =
                            mem.retention.rate_window_ns;
                    },
                    mem.retention_sequence,
                    #fanout_job({
                        fanout_job_id = jobId;
                        created_at_ns = finalizedAt;
                        expires_at_ns = expires;
                        cleanup_at_ns = expires;
                        retained_bytes = retainedBytes;
                        targets_detached = false;
                    }),
                )
            ) {
                case (#err(_)) return null;
                case (#ok(value)) value;
            };
            if (
                not canApplyRetentionRegistration(retention) or
                Map.get(mem.fanout_jobs, Nat64.compare, jobId) != null or
                Map.get(
                    mem.fanout_target_count_by_job,
                    Nat64.compare,
                    jobId,
                ) != null or
                actionKey.size() == 0
            ) return null;
            ?{
                fanout_job_id = ?jobId;
                eligible_count = eligible;
                retained_bytes = retainedBytes;
                retention = ?retention;
            };
        };

        func markPostCertifiedRecordWithdrawn(
            post : Memory.AuthoredPost,
            withdrawnAt : Nat64,
        ) {
            switch (post.object_state) {
                case (#certified(_)) {};
                case (_) return;
            };
            let ?record = certifiedRecordForLocalObject(post.post_key)
            else return;
            if (
                record.identity.target.collection != #posts or
                not Blob.equal(
                    record.identity.body_digest,
                    post.object_digest,
                )
            ) return;
            Map.add(
                mem.certified_records,
                Text.compare,
                record.record_key,
                {
                    record with
                    withdrawn_at_ns = ?withdrawnAt;
                },
            );
        };

        func commitImmutableShare(
            plan : Planner.SharePlan
        ) : LocalResultV1<Memory.KernelRecordIdentity> {
            switch (certifiedAssets.commit_batch(plan.commit)) {
                case (#err(#quota or #receipt_full)) #err(#full);
                case (#err(_)) #err(#certified_store);
                case (#ok(receipt)) {
                    switch (Planner.reconcileShare(plan, receipt)) {
                        case (#err(_)) #err(#certified_store);
                        case (#ok(value)) {
                            #ok(capabilityIdentityToMemory(value));
                        };
                    };
                };
            };
        };

        func prepareDirectActionDispatch(
            target : Principal,
            route : Text,
            domain : Text,
            actionId : Blob,
            exactBody : Blob,
            createdAt : Nat64,
        ) : ?TransportTypes.PreparedDispatchV1 {
            if (
                not validRemoteNode(target) or
                actionId.size() != Bounds.HASH_BYTES
            ) return null;
            let ?digest = Hash.lpHash(
                domain,
                [
                    currentProfile().network_id,
                    Principal.toBlob(node),
                    Principal.toBlob(target),
                    actionId,
                ],
            ) else return null;
            let bytes = Blob.toArray(digest);
            if (bytes.size() < Bounds.OPERATION_ID_BYTES) return null;
            let operationId = Blob.fromArray(
                Array.tabulate<Nat8>(
                    Bounds.OPERATION_ID_BYTES,
                    func(index) { bytes[index] },
                )
            );
            var nonzero = false;
            for (byte in operationId.vals()) {
                if (byte != 0) nonzero := true;
            };
            if (not nonzero) return null;
            switch (
                Dispatcher.Dispatcher(node, backendCalls).prepare({
                    target;
                    route;
                    operation_id = operationId;
                    exact_body_candid = exactBody;
                    created_at_ns = createdAt;
                })
            ) {
                case (#ok(value)) ?value;
                case (#err(_)) null;
            };
        };

        func directOutboxMetadataBytes(actionKey : Text) : Nat {
            160 + Text.encodeUtf8(actionKey).size();
        };

        func directPreparedRetainedBytes(
            prepared : TransportTypes.PreparedDispatchV1,
            actionKey : Text,
        ) : Nat {
            512 +
            prepared.operation_id.size() +
            prepared.payload_digest.size() +
            prepared.exact_body_candid.size() +
            prepared.exact_ingress_candid.size() +
            prepared.exact_call_args.size() +
            directOutboxMetadataBytes(actionKey);
        };

        func canEnqueueDirectAction(
            prepared : TransportTypes.PreparedDispatchV1,
            actionKey : Text,
            requiredRetentionSlots : Nat64,
        ) : Bool {
            if (
                requiredRetentionSlots == 0 or
                mem.outbox_sequence == Nat64.maxValue or
                mem.outbox_count >= mem.quota_limits.outbox_count or
                mem.state_revision >= Nat64.maxValue - 1 or
                mem.retention_sequence >
                    Nat64.maxValue - requiredRetentionSlots or
                prepared.created_at_ns >
                    Nat64.maxValue -
                        TransportTypes.RETRY_HORIZON_NS
            ) return false;
            let operationKey : Memory.OutboxOperationKey = (
                prepared.target,
                prepared.route,
                prepared.operation_id,
            );
            let retained =
                directPreparedRetainedBytes(prepared, actionKey);
            Map.get(
                mem.outbox_by_operation,
                outboxOperationCompare,
                operationKey,
            ) == null and
            Map.get(
                mem.outbox,
                Nat64.compare,
                mem.outbox_sequence + 1,
            ) == null and
            quotaBytesAvailable(
                mem.outbox_bytes,
                0,
                retained,
                mem.quota_limits.outbox_bytes,
            );
        };

        func enqueueDirectAction(
            prepared : TransportTypes.PreparedDispatchV1,
            actionKey : Text,
        ) : Bool {
            let localId = mem.outbox_sequence + 1;
            pendingOutboxMetadata := ?{
                local_id = localId;
                linked_action_key = ?actionKey;
                fanout_job_id = null;
                follower_registration_sequence = null;
                following_intent_generation = null;
                encoded_renewal_requested = null;
                retained_bytes =
                    directOutboxMetadataBytes(actionKey);
            };
            let result = outboxServiceFor(backendCalls).enqueue(
                {
                    local_id = localId;
                    prepared;
                    delivery_subscription_id = null;
                    encoded_renewal_requested = null;
                },
                prepared.created_at_ns,
            );
            pendingOutboxMetadata := null;
            switch (result) {
                case (#queued(item)) item.local_id == localId;
                case (_) false;
            };
        };

        type FanoutJobCreateResult = {
            #none;
            #created : Nat;
            #blocked;
        };

        type FanoutJobPlan = {
            eligible : Nat;
            job : Memory.FanoutJob;
            retention : RetentionTypes.RegistrationPlan;
        };

        type FanoutJobPrepareResult = {
            #none;
            #ready : FanoutJobPlan;
            #blocked;
        };

        func prepareFanoutJob(
            kind : Memory.FanoutKind,
            actionKey : Text,
            exactEventCandid : Blob,
            createdAt : Nat64,
            stateBumpsBeforeCreate : Nat64,
        ) : FanoutJobPrepareResult {
            // Exact eligibility is established by bounded registration pages.
            // Physically active rows safely upper-bound that set and avoid a
            // publication-time traversal proportional to all followers.
            let eligible = mem.active_follower_count;
            if (eligible == 0) return #none;
            if (stateBumpsBeforeCreate >= Nat64.maxValue) {
                return #blocked;
            };
            let requiredStateHeadroom = stateBumpsBeforeCreate + 1;
            let retainedBytes = exactEventCandid.size() + 384;
            if (
                mem.state_revision >
                    Nat64.maxValue - requiredStateHeadroom or
                mem.fanout_sequence == Nat64.maxValue or
                mem.fanout_job_count >=
                    mem.quota_limits.fanout_job_count or
                not quotaBytesAvailable(
                    mem.fanout_bytes,
                    0,
                    retainedBytes,
                    mem.quota_limits.fanout_bytes,
                )
            ) return #blocked;
            let id = mem.fanout_sequence + 1;
            if (
                Map.get(mem.fanout_jobs, Nat64.compare, id) != null or
                Map.get(
                    mem.fanout_target_count_by_job,
                    Nat64.compare,
                    id,
                ) != null
            ) return #blocked;
            let expiresAt = addSaturating(
                createdAt,
                mem.retention.peer_records_ns,
            );
            let job : Memory.FanoutJob = {
                fanout_job_id = id;
                kind;
                action_key = actionKey;
                exact_event_candid = exactEventCandid;
                follower_registration_cutoff =
                    mem.follower_registration_sequence;
                after_registration_sequence = null;
                state = #queued;
                // No recipient is eligible for this particular job until the
                // bounded frozen-cutoff scan has actually observed it.
                eligible_count = (0 : Nat32);
                queued_count = (0 : Nat32);
                completed_count = (0 : Nat32);
                terminal_count = (0 : Nat32);
                uncertain_count = (0 : Nat32);
                created_at_ns = createdAt;
                updated_at_ns = createdAt;
                expires_at_ns = expiresAt;
                retained_bytes = retainedBytes;
            };
            let retention = switch (
                RetentionService.prepareRegistration(
                    {
                        peer_records_ns =
                            mem.retention.peer_records_ns;
                        likes_ns = mem.retention.likes_ns;
                        rate_window_ns =
                            mem.retention.rate_window_ns;
                    },
                    mem.retention_sequence,
                    #fanout_job({
                        fanout_job_id = id;
                        created_at_ns = createdAt;
                        expires_at_ns = expiresAt;
                        cleanup_at_ns = expiresAt;
                        retained_bytes = retainedBytes;
                        targets_detached = false;
                    }),
                )
            ) {
                case (#err(_)) return #blocked;
                case (#ok(value)) value;
            };
            if (not canApplyRetentionRegistration(retention)) {
                return #blocked;
            };
            #ready({ eligible; job; retention });
        };

        func createFanoutJob(
            kind : Memory.FanoutKind,
            actionKey : Text,
            exactEventCandid : Blob,
            createdAt : Nat64,
        ) : FanoutJobCreateResult {
            let plan = switch (
                prepareFanoutJob(
                    kind,
                    actionKey,
                    exactEventCandid,
                    createdAt,
                    0,
                )
            ) {
                case (#none) return #none;
                case (#blocked) return #blocked;
                case (#ready(value)) value;
            };
            let job = plan.job;
            mem.fanout_sequence := job.fanout_job_id;
            Map.add(
                mem.fanout_jobs,
                Nat64.compare,
                job.fanout_job_id,
                job,
            );
            Map.add(
                mem.fanout_target_count_by_job,
                Nat64.compare,
                job.fanout_job_id,
                0,
            );
            incrementAuthoredDependency(actionKey);
            mem.fanout_job_count += 1;
            mem.fanout_bytes += job.retained_bytes;
            applyRetentionRegistration(plan.retention);
            #created(plan.eligible);
        };

        type FanoutTargetEnqueue = {
            #ready : {
                target : Memory.FanoutTarget;
                created : Bool;
            };
            #blocked;
        };

        func advanceFanoutJobs(
            calls : NeutronCapabilities.BackendCallsV1,
            now : Nat64,
        ) {
            let after = mem.scheduler.fanout_after_job_id;
            let suffixEntries = switch (after) {
                case null Map.entries(mem.fanout_jobs);
                case (?cursor) {
                    Map.entriesFrom(
                        mem.fanout_jobs,
                        Nat64.compare,
                        cursor,
                    );
                };
            };
            let suffix =
                List.empty<FanoutScheduler.Candidate>();
            var suffixCount = 0;
            label collectSuffix for ((jobId, job) in suffixEntries) {
                let strictlyAfter = switch (after) {
                    case null true;
                    case (?cursor) jobId > cursor;
                };
                if (strictlyAfter) {
                    if (
                        suffixCount >=
                        RelationshipService.FANOUT_BATCH_LIMIT
                    ) break collectSuffix;
                    suffixCount += 1;
                };
                List.add(suffix, {
                    job_id = jobId;
                    ready = switch (job.state) {
                        case (#queued or #scanning or #paused) true;
                        case (_) false;
                    };
                });
            };
            let head : ?[FanoutScheduler.Candidate] = switch (after) {
                case null null;
                case (?cursor) {
                    if (
                        suffixCount >=
                        RelationshipService.FANOUT_BATCH_LIMIT
                    ) {
                        null;
                    } else {
                        let values =
                            List.empty<FanoutScheduler.Candidate>();
                        let remaining =
                            RelationshipService.FANOUT_BATCH_LIMIT -
                            suffixCount;
                        var count = 0;
                        label collectHead for (
                            (jobId, job) in Map.entries(mem.fanout_jobs)
                        ) {
                            if (jobId > cursor or count >= remaining) {
                                break collectHead;
                            };
                            List.add(values, {
                                job_id = jobId;
                                ready = switch (job.state) {
                                    case (
                                        #queued or
                                        #scanning or
                                        #paused
                                    ) true;
                                    case (_) false;
                                };
                            });
                            count += 1;
                        };
                        ?List.toArray(values);
                    };
                };
            };
            let selection = FanoutScheduler.selectNextReady({
                after_job_id = after;
                suffix = List.toArray(suffix);
                head;
                scan_limit =
                    RelationshipService.FANOUT_BATCH_LIMIT;
            });
            mem.scheduler := {
                mem.scheduler with
                fanout_after_job_id =
                    selection.next_after_job_id;
            };
            switch (selection.selected_job_id) {
                case null {};
                case (?jobId) {
                    switch (
                        Map.get(mem.fanout_jobs, Nat64.compare, jobId)
                    ) {
                        case null {};
                        case (?job) advanceFanoutJob(job, calls, now);
                    };
                };
            };
        };

        func advanceFanoutJob(
            initial : Memory.FanoutJob,
            calls : NeutronCapabilities.BackendCallsV1,
            now : Nat64,
        ) {
            let current = switch (
                Map.get(
                    mem.fanout_jobs,
                    Nat64.compare,
                    initial.fanout_job_id,
                )
            ) {
                case (?value) value;
                case null return;
            };
            if (
                current.state != #queued and
                current.state != #scanning and
                current.state != #paused
            ) return;
            if (now >= current.expires_at_ns) {
                storeFanoutJob({
                    current with
                    state = #failed;
                    updated_at_ns = now;
                });
                return;
            };
            let page = switch (
                relationships().planFanoutBatch(
                    {
                        follower_revision = mem.follower_revision;
                        cutoff_registration_sequence =
                            current.follower_registration_cutoff;
                        finalized_at_ns = current.created_at_ns;
                    },
                    current.after_registration_sequence,
                    now,
                )
            ) {
                case (#err(_)) {
                    storeFanoutJob({
                        current with
                        state = #paused;
                        updated_at_ns = now;
                    });
                    return;
                };
                case (#ok(value)) value;
            };

            var next = current;
            for (candidate in page.targets.vals()) {
                switch (
                    enqueueFanoutTarget(next, candidate, calls, now)
                ) {
                    case (#blocked) {
                        storeFanoutJob({
                            next with
                            after_registration_sequence =
                                next.after_registration_sequence;
                            state = #paused;
                            updated_at_ns = now;
                        });
                        return;
                    };
                    case (#ready(result)) {
                        let queued = if (result.created) {
                            incrementNat32(next.queued_count);
                        } else ?next.queued_count;
                        let ?nextQueued = queued else {
                            Runtime.trap(
                                "Wagyu fanout queued counter overflow"
                            );
                        };
                        next := {
                            next with
                            after_registration_sequence =
                                ?candidate.registration_sequence;
                            // The registration cutoff freezes membership, but
                            // a row inside that cutoff can become eligible
                            // before it is scanned. Keep the advertised
                            // eligible total as a monotonic high-water mark so
                            // queued recipients can never exceed it.
                            eligible_count =
                                if (nextQueued > next.eligible_count) {
                                    nextQueued;
                                } else next.eligible_count;
                            queued_count = nextQueued;
                            updated_at_ns = now;
                        };
                    };
                };
            };
            let scanCursor = switch (page.next_after_sequence) {
                case null next.after_registration_sequence;
                case (?value) ?value;
            };
            let ?state = FanoutPlanner.jobState(
                page.complete,
                next.queued_count,
                fanoutCounters(next),
            ) else {
                Runtime.trap("Wagyu fanout counters are corrupt");
            };
            storeFanoutJob({
                next with
                after_registration_sequence = scanCursor;
                state = fanoutStateToMemory(state);
                // Once the frozen scan is complete, every eligible target has
                // been durably queued, so the observed count is exact.
                eligible_count =
                    if (page.complete) {
                        next.queued_count;
                    } else next.eligible_count;
                updated_at_ns = now;
            });
        };

        func enqueueFanoutTarget(
            job : Memory.FanoutJob,
            candidate : RelationshipTypes.FanoutTarget,
            calls : NeutronCapabilities.BackendCallsV1,
            now : Nat64,
        ) : FanoutTargetEnqueue {
            let targetKey = FanoutPlanner.targetKey(
                job.fanout_job_id,
                candidate.registration_sequence,
            );
            switch (
                Map.get(mem.fanout_targets, Text.compare, targetKey)
            ) {
                case (?existing) {
                    if (
                        existing.fanout_job_id != job.fanout_job_id or
                        existing.registration_sequence !=
                            candidate.registration_sequence or
                        not Principal.equal(
                            existing.recipient,
                            candidate.node,
                        ) or
                        Map.get(
                            mem.outbox,
                            Nat64.compare,
                            existing.outbox_local_id,
                        ) == null
                    ) return #blocked;
                    return #ready({
                        target = existing;
                        created = false;
                    });
                };
                case null {};
            };
            let targetRetainedBytes =
                192 +
                Text.encodeUtf8(targetKey).size() +
                Principal.toBlob(candidate.node).size();
            if (
                mem.fanout_target_count >=
                    mem.quota_limits.fanout_target_count or
                not quotaBytesAvailable(
                    mem.fanout_bytes,
                    0,
                    targetRetainedBytes,
                    mem.quota_limits.fanout_bytes,
                ) or
                mem.outbox_sequence == Nat64.maxValue or
                mem.outbox_count >= mem.quota_limits.outbox_count
            ) return #blocked;

            let debit = switch (
                relationships().prepareCreditDebit(
                    candidate.node,
                    candidate.subscription_id,
                    now,
                )
            ) {
                case (#err(_)) return #blocked;
                case (#ok(value)) value;
            };
            if (
                debit.mutation.expected_storage_revision !=
                    ?candidate.follower_storage_revision
            ) return #blocked;
            let exactBody = Wire.encodeDeliverBody({
                subscription_id = candidate.subscription_id;
                renewal_requested = debit.renewal_requested;
                event = ?FanoutPlanner.event(
                    fanoutKindToPlanner(job.kind),
                    job.exact_event_candid,
                );
            });
            let ?operationId = FanoutPlanner.operationId(
                currentProfile().network_id,
                job.fanout_job_id,
                job.action_key,
                candidate.node,
                candidate.registration_sequence,
            ) else return #blocked;
            let prepared = switch (
                Dispatcher.Dispatcher(node, calls).prepare({
                    target = candidate.node;
                    route = Bounds.DELIVER_ROUTE;
                    operation_id = operationId;
                    exact_body_candid = exactBody;
                    created_at_ns = job.created_at_ns;
                })
            ) {
                case (#err(_)) return #blocked;
                case (#ok(value)) value;
            };
            let localId = mem.outbox_sequence + 1;
            let metadata : Memory.OutboxMetadata = {
                local_id = localId;
                linked_action_key = ?job.action_key;
                fanout_job_id = ?job.fanout_job_id;
                follower_registration_sequence =
                    ?candidate.registration_sequence;
                following_intent_generation = null;
                encoded_renewal_requested =
                    ?debit.renewal_requested;
                retained_bytes =
                    160 + Text.encodeUtf8(job.action_key).size();
            };
            let target : Memory.FanoutTarget = {
                target_key = targetKey;
                fanout_job_id = job.fanout_job_id;
                recipient = candidate.node;
                registration_sequence =
                    candidate.registration_sequence;
                outbox_local_id = localId;
                expires_at_ns = job.expires_at_ns;
                retained_bytes = targetRetainedBytes;
            };
            pendingOutboxMetadata := ?metadata;
            pendingFanoutTarget := ?target;
            let enqueue = outboxServiceFor(calls).enqueue(
                {
                    local_id = localId;
                    prepared;
                    delivery_subscription_id =
                        ?candidate.subscription_id;
                    encoded_renewal_requested =
                        ?debit.renewal_requested;
                },
                now,
            );
            pendingOutboxMetadata := null;
            pendingFanoutTarget := null;
            let storedLocalId = switch (enqueue) {
                case (#queued(item)) item.local_id;
                // A target is committed atomically with its new outbox row.
                // Finding only the operation is therefore corrupt state, not
                // a partially recoverable enqueue.
                case (#existing(_)) return #blocked;
                case (#err(_)) return #blocked;
            };
            if (storedLocalId != localId) return #blocked;
            let ?storedTarget = Map.get(
                mem.fanout_targets,
                Text.compare,
                targetKey,
            ) else return #blocked;
            if (storedTarget != target) return #blocked;
            #ready({ target = storedTarget; created = true });
        };

        func storeFanoutJob(job : Memory.FanoutJob) {
            Map.add(
                mem.fanout_jobs,
                Nat64.compare,
                job.fanout_job_id,
                job,
            );
            bumpState();
            let targetless = switch (
                Map.get(
                    mem.fanout_target_count_by_job,
                    Nat64.compare,
                    job.fanout_job_id,
                )
            ) {
                case (?count) count == 0;
                case null false;
            };
            if (
                FanoutPlanner.terminalWithoutTargets(
                    job.state,
                    targetless,
                )
            ) {
                reAgeDetachedTerminalRetention(
                    #fanout_job(job.fanout_job_id),
                    job.updated_at_ns,
                );
            };
        };

        func fanoutCounters(
            job : Memory.FanoutJob
        ) : FanoutPlanner.Counters {
            {
                completed = job.completed_count;
                terminal = job.terminal_count;
                uncertain = job.uncertain_count;
            };
        };

        func fanoutKindToPlanner(
            kind : Memory.FanoutKind
        ) : FanoutPlanner.Kind {
            switch (kind) {
                case (#original) #original;
                case (#share) #share;
                case (#tombstone) #tombstone;
                case (#tombstone_relay) #tombstone_relay;
            };
        };

        func fanoutStateToMemory(
            state : FanoutPlanner.State
        ) : Memory.FanoutState {
            switch (state) {
                case (#queued) #queued;
                case (#scanning) #scanning;
                case (#sending) #sending;
                case (#complete) #complete;
                case (#partial) #partial;
                case (#paused) #paused;
                case (#failed) #failed;
            };
        };

        func incrementNat32(value : Nat32) : ?Nat32 {
            if (value == Nat32.maxValue) null else ?(value + 1);
        };

        func rememberCertifiedRecord(
            identity : Memory.KernelRecordIdentity,
            publicationId : Nat64,
            localObjectKey : ?Text,
            createdAt : Nat64,
        ) {
            let key = certifiedRecordStableKey(identity.target);
            let previous = Map.get(
                mem.certified_records,
                Text.compare,
                key,
            );
            if (previous == null) {
                mem.certified_object_count += 1;
                mem.certified_object_bytes +=
                    Nat32.toNat(identity.body_length);
                updateCollectionUsage(
                    identity.target,
                    Nat32.toNat(identity.body_length),
                );
            };
            switch (previous) {
                case null {};
                case (?record) {
                    if (record.local_object_key != localObjectKey) {
                        unlinkCertifiedLocalObject(
                            record.local_object_key,
                            key,
                        );
                    };
                };
            };
            linkCertifiedLocalObject(localObjectKey, key);
            Map.add(mem.certified_records, Text.compare, key, {
                record_key = key;
                identity;
                publication_id = publicationId;
                local_object_key = localObjectKey;
                created_at_ns = createdAt;
                withdrawn_at_ns = null;
            });
        };

        func publicationNonceStableKey(
            domain : Memory.PublicationDomain,
            nonce : Blob,
        ) : Text {
            let tag = switch (domain) {
                case (#stage) "stage";
                case (#positive_batch) "positive";
                case (#revocation) "revocation";
            };
            "publication:" # tag # ":" # Path.hexLower(nonce);
        };

        func preparePublicationJournal(
            domain : Memory.PublicationDomain,
            nonce : Blob,
            fingerprint : Blob,
            mutations : [Memory.PublicationMutation],
        ) : ?PublicationJournal.Plan {
            if (not publicationDomainMatches(domain, mutations)) {
                return null;
            };
            let nonceKey = publicationNonceStableKey(domain, nonce);
            if (
                Map.get(
                    mem.publication_by_nonce,
                    Text.compare,
                    nonceKey,
                ) != null
            ) return null;
            let capacity = switch (domain) {
                case (#revocation) {
                    {
                        current_receipt_count =
                            mem.revocation_receipt_count;
                        receipt_count_limit =
                            mem.quota_limits.certified_object_count;
                        current_retained_bytes =
                            mem.revocation_receipt_bytes;
                        retained_bytes_limit =
                            MAX_REVOCATION_RECEIPT_BYTES;
                    };
                };
                case (#stage or #positive_batch) {
                    {
                        current_receipt_count =
                            mem.publication_receipt_count;
                        receipt_count_limit =
                            mem.quota_limits.publication_receipt_count;
                        current_retained_bytes =
                            mem.publication_receipt_bytes;
                        retained_bytes_limit =
                            MAX_PUBLICATION_RECEIPT_BYTES;
                    };
                };
            };
            switch (
                PublicationJournal.validate({
                    request_nonce = nonce;
                    request_fingerprint = fingerprint;
                    mutations;
                    capacity;
                })
            ) {
                case (#err(_)) null;
                case (#ok(value)) ?value;
            };
        };

        func publicationDomainMatches(
            domain : Memory.PublicationDomain,
            mutations : [Memory.PublicationMutation],
        ) : Bool {
            if (mutations.size() == 0) return false;
            switch (domain) {
                case (#revocation) {
                    if (mutations.size() != 1) return false;
                    switch (mutations[0]) {
                        case (#delete(_)) true;
                        case (_) false;
                    };
                };
                case (#stage or #positive_batch) {
                    for (mutation in mutations.vals()) {
                        switch (mutation) {
                            case (#put(_)) {};
                            case (_) return false;
                        };
                    };
                    true;
                };
            };
        };

        func rememberCommittedPublication(
            publicationId : Nat64,
            kind : Memory.PublicationKind,
            journal : PublicationJournal.Plan,
            records : [Memory.KernelRecordIdentity],
            createdAt : Nat64,
        ) {
            if (
                publicationId == 0 or
                mem.publication_receipt_count >=
                    mem.quota_limits.publication_receipt_count or
                journal.retained_bytes >
                    MAX_PUBLICATION_RECEIPT_BYTES or
                mem.publication_receipt_bytes >
                    MAX_PUBLICATION_RECEIPT_BYTES -
                    journal.retained_bytes or
                Map.get(
                    mem.publications,
                    Nat64.compare,
                    publicationId,
                ) != null or
                Map.get(
                    mem.publication_by_nonce,
                    Text.compare,
                    publicationNonceStableKey(
                        #positive_batch,
                        journal.request_nonce,
                    ),
                ) != null or
                not committedRecordsMatchJournal(
                    records,
                    journal.mutations,
                )
            ) {
                Runtime.trap(
                    "Wagyu publication journal preflight was violated"
                );
            };
            let reconcileUntil = addSaturating(
                createdAt,
                mem.retention.publication_receipts_ns,
            );
            Map.add(mem.publications, Nat64.compare, publicationId, {
                publication_id = publicationId;
                kind;
                domain = #positive_batch;
                request_nonce = journal.request_nonce;
                request_fingerprint = journal.request_fingerprint;
                mutations = journal.mutations;
                state = #committed({
                    committed_at_ns = createdAt;
                    records;
                });
                created_at_ns = createdAt;
                updated_at_ns = createdAt;
                reconcile_until_ns = reconcileUntil;
                retained_bytes = journal.retained_bytes;
            });
            Map.add(
                mem.publication_by_nonce,
                Text.compare,
                publicationNonceStableKey(
                    #positive_batch,
                    journal.request_nonce,
                ),
                publicationId,
            );
            for (mutation in journal.mutations.vals()) {
                Map.add(
                    mem.publication_by_target,
                    Text.compare,
                    certifiedRecordStableKey(
                        publicationMutationTarget(mutation)
                    ),
                    publicationId,
                );
            };
            Map.add(
                mem.publication_reconcile_order,
                orderedTimeCompare,
                (reconcileUntil, publicationId),
                publicationId,
            );
            mem.publication_receipt_count += 1;
            mem.publication_receipt_bytes += journal.retained_bytes;
        };

        func rememberCommittedRevocation(
            publicationId : Nat64,
            journal : PublicationJournal.Plan,
            expected : Memory.KernelRecordIdentity,
            committedAt : Nat64,
        ) {
            let validMutation = if (journal.mutations.size() != 1) {
                false;
            } else {
                switch (journal.mutations[0]) {
                    case (#delete(value)) {
                        value.target == expected.target and
                        value.expected == expected;
                    };
                    case (_) false;
                };
            };
            if (
                not validMutation or
                publicationId == 0 or
                mem.revocation_receipt_count >=
                    mem.quota_limits.certified_object_count or
                journal.retained_bytes >
                    MAX_REVOCATION_RECEIPT_BYTES or
                mem.revocation_receipt_bytes >
                    MAX_REVOCATION_RECEIPT_BYTES -
                    journal.retained_bytes or
                Map.get(
                    mem.publications,
                    Nat64.compare,
                    publicationId,
                ) != null or
                Map.get(
                    mem.publication_by_nonce,
                    Text.compare,
                    publicationNonceStableKey(
                        #revocation,
                        journal.request_nonce,
                    ),
                ) != null
            ) Runtime.trap(
                "Wagyu revocation journal preflight was violated"
            );
            let reconcileUntil = addSaturating(
                committedAt,
                mem.retention.publication_receipts_ns,
            );
            Map.add(mem.publications, Nat64.compare, publicationId, {
                publication_id = publicationId;
                kind = #delete_record;
                domain = #revocation;
                request_nonce = journal.request_nonce;
                request_fingerprint = journal.request_fingerprint;
                mutations = journal.mutations;
                state = #committed({
                    committed_at_ns = committedAt;
                    records = [];
                });
                created_at_ns = committedAt;
                updated_at_ns = committedAt;
                reconcile_until_ns = reconcileUntil;
                retained_bytes = journal.retained_bytes;
            });
            Map.add(
                mem.publication_by_nonce,
                Text.compare,
                publicationNonceStableKey(
                    #revocation,
                    journal.request_nonce,
                ),
                publicationId,
            );
            Map.add(
                mem.publication_by_target,
                Text.compare,
                certifiedRecordStableKey(expected.target),
                publicationId,
            );
            Map.add(
                mem.publication_reconcile_order,
                orderedTimeCompare,
                (reconcileUntil, publicationId),
                publicationId,
            );
            mem.revocation_receipt_count += 1;
            mem.revocation_receipt_bytes += journal.retained_bytes;
        };

        func publicationTargetsReconciled(
            journal : Memory.CertifiedPublication
        ) : Bool {
            for (mutation in journal.mutations.vals()) {
                if (
                    not certifiedTargetReconciled(
                        publicationMutationTarget(mutation)
                    )
                ) return false;
            };
            true;
        };

        // After a nonce receipt expires, current kernel state—not absence of a
        // receipt—is authoritative. Reconcile against the latest durable
        // Wagyu mirror so a later profile/head replacement or revocation can
        // safely supersede the journal being retired.
        func certifiedTargetReconciled(
            target : Memory.CertifiedTarget
        ) : Bool {
            let capabilityTarget = memoryTargetToCapability(target);
            let status = switch (
                certifiedAssets.record_status(capabilityTarget)
            ) {
                case (#err(_)) return false;
                case (#ok(value)) value;
            };
            let key = certifiedRecordStableKey(target);
            let current = switch (
                Map.get(mem.certified_records, Text.compare, key)
            ) {
                case (?record) {
                    if (
                        record.record_key != key or
                        record.identity.target != target
                    ) return false;
                    ?record.identity;
                };
                case null null;
            };
            let observed : PublicationReconciliation.ObservedStatus =
                switch (status) {
                    case (#present(identity)) {
                        #present(
                            capabilityIdentityToMemory(identity)
                        );
                    };
                    case (#absent(value)) {
                        #absent(value.collection_generation);
                    };
                    case (#recently_deleted(identity)) {
                        #recently_deleted(
                            capabilityTargetToMemory(identity.target)
                        );
                    };
                    case (#deleted_high_water(identity)) {
                        #deleted_high_water(
                            capabilityTargetToMemory(identity.target)
                        );
                    };
                };
            PublicationReconciliation.matches(
                target,
                current,
                observed,
            );
        };

        // Kernel publication receipts are retained for the full 24-hour
        // window, then status-reconciled and released in a bounded ordered
        // page. Status errors leave every journal/index/counter unchanged.
        // Certified object identities outlive positive journals.
        func cleanupCommittedPublications(
            now : Nat64,
            limit : Nat,
        ) : Nat {
            if (limit == 0) return 0;
            let dueKeys = List.empty<Memory.OrderedTimeKey>();
            label collect for (
                (key, _) in Map.entries(mem.publication_reconcile_order)
            ) {
                if (key.0 > now or List.size(dueKeys) >= limit) {
                    break collect;
                };
                List.add(dueKeys, key);
            };

            var removed = 0;
            var changed = false;
            for (key in List.values(dueKeys)) {
                let indexedId = Map.get(
                    mem.publication_reconcile_order,
                    orderedTimeCompare,
                    key,
                );
                switch (indexedId) {
                    case null {};
                    case (?publicationId) {
                        let publication = Map.get(
                            mem.publications,
                            Nat64.compare,
                            publicationId,
                        );
                        switch (publication) {
                            case null {
                                Map.remove(
                                    mem.publication_reconcile_order,
                                    orderedTimeCompare,
                                    key,
                                );
                                changed := true;
                            };
                            case (?journal) {
                                if (
                                    publicationId != key.1 or
                                    journal.publication_id != publicationId or
                                    journal.reconcile_until_ns != key.0
                                ) {
                                    Map.remove(
                                        mem.publication_reconcile_order,
                                        orderedTimeCompare,
                                        key,
                                    );
                                    changed := true;
                                } else {
                                    let terminal = switch (journal.state) {
                                        case (#committed(_)) true;
                                        case (#failed(_)) true;
                                        case (_) false;
                                    };
                                    if (
                                        terminal and
                                        journal.reconcile_until_ns <= now and
                                        publicationTargetsReconciled(journal)
                                    ) {
                                        switch (journal.domain) {
                                            case (#revocation) {
                                                if (
                                                    mem.revocation_receipt_count ==
                                                        0 or
                                                    mem.revocation_receipt_bytes <
                                                        journal.retained_bytes
                                                ) Runtime.trap(
                                                    "Wagyu revocation journal accounting is inconsistent"
                                                );
                                            };
                                            case (
                                                #stage or #positive_batch
                                            ) {
                                                if (
                                                    mem.publication_receipt_count ==
                                                        0 or
                                                    mem.publication_receipt_bytes <
                                                        journal.retained_bytes
                                                ) Runtime.trap(
                                                    "Wagyu publication journal accounting is inconsistent"
                                                );
                                            };
                                        };
                                        let nonceKey =
                                            publicationNonceStableKey(
                                                journal.domain,
                                                journal.request_nonce,
                                            );
                                        if (
                                            Map.get(
                                                mem.publication_by_nonce,
                                                Text.compare,
                                                nonceKey,
                                            ) == ?publicationId
                                        ) {
                                            Map.remove(
                                                mem.publication_by_nonce,
                                                Text.compare,
                                                nonceKey,
                                            );
                                        };
                                        for (
                                            mutation in
                                                journal.mutations.vals()
                                        ) {
                                            let targetKey =
                                                certifiedRecordStableKey(
                                                    publicationMutationTarget(
                                                        mutation
                                                    )
                                                );
                                            if (
                                                Map.get(
                                                    mem.publication_by_target,
                                                    Text.compare,
                                                    targetKey,
                                                ) == ?publicationId
                                            ) {
                                                Map.remove(
                                                    mem.publication_by_target,
                                                    Text.compare,
                                                    targetKey,
                                                );
                                            };
                                        };
                                        Map.remove(
                                            mem.publication_reconcile_order,
                                            orderedTimeCompare,
                                            key,
                                        );
                                        Map.remove(
                                            mem.publications,
                                            Nat64.compare,
                                            publicationId,
                                        );
                                        switch (journal.domain) {
                                            case (#revocation) {
                                                mem.revocation_receipt_count -=
                                                    1;
                                                mem.revocation_receipt_bytes -=
                                                    journal.retained_bytes;
                                            };
                                            case (
                                                #stage or #positive_batch
                                            ) {
                                                mem.publication_receipt_count -=
                                                    1;
                                                mem.publication_receipt_bytes -=
                                                    journal.retained_bytes;
                                            };
                                        };
                                        removed += 1;
                                        changed := true;
                                    };
                                };
                            };
                        };
                    };
                };
            };
            if (changed) bumpState();
            removed;
        };

        func publicationMutationTarget(
            mutation : Memory.PublicationMutation
        ) : Memory.CertifiedTarget {
            switch (mutation) {
                case (#put(value)) value.target;
                case (#delete(value)) value.target;
            };
        };

        func committedRecordsMatchJournal(
            records : [Memory.KernelRecordIdentity],
            mutations : [Memory.PublicationMutation],
        ) : Bool {
            var putCount = 0;
            for (mutation in mutations.vals()) {
                switch (mutation) {
                    case (#delete(_)) return false;
                    case (#put(value)) {
                        putCount += 1;
                        var matched = false;
                        for (record in records.vals()) {
                            if (
                                certifiedRecordStableKey(record.target) ==
                                    certifiedRecordStableKey(value.target) and
                                Blob.equal(
                                    record.body_digest,
                                    value.body_digest,
                                ) and
                                record.body_length == value.body_length
                            ) matched := true;
                        };
                        if (not matched) return false;
                    };
                };
            };
            putCount == records.size();
        };

        func updateCollectionUsage(
            target : Memory.CertifiedTarget,
            addedBytes : Nat,
        ) {
            let id = collectionText(target.collection);
            let current = switch (
                Map.get(mem.certified_collections, Text.compare, id)
            ) {
                case (?value) value;
                case null {
                    {
                        collection = target.collection;
                        collection_generation =
                            target.collection_generation;
                        object_count = 0;
                        body_bytes = 0;
                    };
                };
            };
            Map.add(mem.certified_collections, Text.compare, id, {
                current with
                collection_generation = target.collection_generation;
                object_count = current.object_count + 1;
                body_bytes = current.body_bytes + addedBytes;
            });
        };

        func collectionGeneration(id : Text) : ?Nat64 {
            switch (
                Map.get(mem.certified_collections, Text.compare, id)
            ) {
                case (?value) ?value.collection_generation;
                case null {
                    switch (certifiedAssets.scope_info()) {
                        case (#err(_)) null;
                        case (#ok(scope)) {
                            for (collection in scope.collections.vals()) {
                                if (collection.id == id) {
                                    return ?collection.generation;
                                };
                            };
                            null;
                        };
                    };
                };
            };
        };

        func canApplyByteReplacement(
            current : Nat,
            limit : Nat,
            removed : Nat,
            added : Nat,
        ) : Bool {
            if (current < removed) return false;
            let retained = current - removed;
            added <= limit and retained <= limit - added;
        };

        func currentCertifiedIdentityMatches(
            expected : Memory.KernelRecordIdentity,
            localObjectKey : Text,
        ) : Bool {
            let key = certifiedRecordStableKey(expected.target);
            let ?record = Map.get(
                mem.certified_records,
                Text.compare,
                key,
            ) else return false;
            record.local_object_key == ?localObjectKey and
            record.identity == expected;
        };

        func certifiedRecordForLocalObject(
            localObjectKey : Text
        ) : ?Memory.CertifiedRecord {
            let ?recordKey = Map.get(
                mem.certified_record_by_local_object,
                Text.compare,
                localObjectKey,
            ) else return null;
            let ?record = Map.get(
                mem.certified_records,
                Text.compare,
                recordKey,
            ) else return null;
            if (
                record.record_key != recordKey or
                record.local_object_key != ?localObjectKey
            ) return null;
            ?record;
        };

        func linkCertifiedLocalObject(
            localObjectKey : ?Text,
            recordKey : Text,
        ) {
            switch (localObjectKey) {
                case null {};
                case (?key) {
                    switch (
                        Map.get(
                            mem.certified_record_by_local_object,
                            Text.compare,
                            key,
                        )
                    ) {
                        case null {};
                        case (?current) {
                            if (current != recordKey) {
                                Runtime.trap(
                                    "Wagyu local certified-object index is occupied"
                                );
                            };
                        };
                    };
                    Map.add(
                        mem.certified_record_by_local_object,
                        Text.compare,
                        key,
                        recordKey,
                    );
                };
            };
        };

        func unlinkCertifiedLocalObject(
            localObjectKey : ?Text,
            recordKey : Text,
        ) {
            switch (localObjectKey) {
                case null {};
                case (?key) {
                    if (
                        Map.get(
                            mem.certified_record_by_local_object,
                            Text.compare,
                            key,
                        ) == ?recordKey
                    ) {
                        Map.remove(
                            mem.certified_record_by_local_object,
                            Text.compare,
                            key,
                        );
                    };
                };
            };
        };

        func incrementAuthoredDependency(actionKey : Text) {
            if (actionKey.size() == 0) {
                Runtime.trap(
                    "Wagyu cannot index an empty authored dependency"
                );
            };
            let current = switch (
                Map.get(
                    mem.authored_dependency_count_by_key,
                    Text.compare,
                    actionKey,
                )
            ) {
                case null 0;
                case (?value) value;
            };
            Map.add(
                mem.authored_dependency_count_by_key,
                Text.compare,
                actionKey,
                current + 1,
            );
        };

        func decrementAuthoredDependency(actionKey : Text) {
            let ?current = Map.get(
                mem.authored_dependency_count_by_key,
                Text.compare,
                actionKey,
            ) else Runtime.trap(
                "Wagyu authored dependency count disappeared"
            );
            if (current == 0) {
                Runtime.trap(
                    "Wagyu authored dependency count underflow"
                );
            };
            if (current == 1) {
                Map.remove(
                    mem.authored_dependency_count_by_key,
                    Text.compare,
                    actionKey,
                );
            } else {
                Map.add(
                    mem.authored_dependency_count_by_key,
                    Text.compare,
                    actionKey,
                    current - 1,
                );
            };
        };

        func incrementAcceptedLikePostCount(postKey : Text) {
            let current = switch (
                Map.get(
                    mem.accepted_like_count_by_post,
                    Text.compare,
                    postKey,
                )
            ) {
                case null 0;
                case (?value) value;
            };
            Map.add(
                mem.accepted_like_count_by_post,
                Text.compare,
                postKey,
                current + 1,
            );
        };

        func decrementAcceptedLikePostCount(postKey : Text) {
            let ?current = Map.get(
                mem.accepted_like_count_by_post,
                Text.compare,
                postKey,
            ) else Runtime.trap(
                "Wagyu accepted-Like post count disappeared"
            );
            if (current == 0) {
                Runtime.trap(
                    "Wagyu accepted-Like post count underflow"
                );
            };
            if (current == 1) {
                Map.remove(
                    mem.accepted_like_count_by_post,
                    Text.compare,
                    postKey,
                );
            } else {
                Map.add(
                    mem.accepted_like_count_by_post,
                    Text.compare,
                    postKey,
                    current - 1,
                );
            };
        };

        func removeRevokedCertifiedRecord(
            record : Memory.CertifiedRecord
        ) {
            let bytes = Nat32.toNat(record.identity.body_length);
            let ?current = Map.get(
                mem.certified_records,
                Text.compare,
                record.record_key,
            ) else Runtime.trap(
                "Wagyu revoked certified record disappeared"
            );
            if (
                current != record or
                certifiedRecordStableKey(record.identity.target) !=
                    record.record_key or
                mem.certified_object_count == 0 or
                mem.certified_object_bytes < bytes
            ) Runtime.trap(
                "Wagyu revoked certified record accounting is corrupt"
            );
            switch (record.local_object_key) {
                case null {};
                case (?localKey) {
                    if (
                        Map.get(
                            mem.certified_record_by_local_object,
                            Text.compare,
                            localKey,
                        ) != ?record.record_key
                    ) Runtime.trap(
                        "Wagyu local certified-record index is corrupt"
                    );
                };
            };
            let collectionKey = collectionText(
                record.identity.target.collection
            );
            let ?collection = Map.get(
                mem.certified_collections,
                Text.compare,
                collectionKey,
            ) else Runtime.trap(
                "Wagyu certified collection accounting disappeared"
            );
            if (
                collection.collection_generation !=
                    record.identity.target.collection_generation or
                collection.object_count == 0 or
                collection.body_bytes < bytes
            ) Runtime.trap(
                "Wagyu certified collection accounting is corrupt"
            );
            unlinkCertifiedLocalObject(
                record.local_object_key,
                record.record_key,
            );
            Map.remove(
                mem.certified_records,
                Text.compare,
                record.record_key,
            );
            Map.add(
                mem.certified_collections,
                Text.compare,
                collectionKey,
                {
                    collection with
                    object_count = collection.object_count - 1;
                    body_bytes = collection.body_bytes - bytes;
                },
            );
            mem.certified_object_count -= 1;
            mem.certified_object_bytes -= bytes;
        };

        func rememberNewCertifiedRecord(
            identity : Memory.KernelRecordIdentity,
            publicationId : Nat64,
            localObjectKey : ?Text,
            createdAt : Nat64,
        ) {
            let key = certifiedRecordStableKey(identity.target);
            if (
                Map.get(mem.certified_records, Text.compare, key) != null
            ) Runtime.trap(
                "Wagyu certified-record insert violated its preflight"
            );
            mem.certified_object_count += 1;
            mem.certified_object_bytes +=
                Nat32.toNat(identity.body_length);
            updateCollectionUsage(
                identity.target,
                Nat32.toNat(identity.body_length),
            );
            linkCertifiedLocalObject(localObjectKey, key);
            Map.add(mem.certified_records, Text.compare, key, {
                record_key = key;
                identity;
                publication_id = publicationId;
                local_object_key = localObjectKey;
                created_at_ns = createdAt;
                withdrawn_at_ns = null;
            });
        };

        func replaceCertifiedRecord(
            expected : Memory.KernelRecordIdentity,
            identity : Memory.KernelRecordIdentity,
            publicationId : Nat64,
            localObjectKey : ?Text,
            _updatedAt : Nat64,
        ) {
            if (expected.target != identity.target) {
                Runtime.trap(
                    "Wagyu certified-record replacement changed target"
                );
            };
            let key = certifiedRecordStableKey(expected.target);
            let ?current = Map.get(
                mem.certified_records,
                Text.compare,
                key,
            ) else Runtime.trap(
                "Wagyu certified-record replacement lost its row"
            );
            if (current.identity != expected) {
                Runtime.trap(
                    "Wagyu certified-record replacement lost its CAS mirror"
                );
            };
            if (current.local_object_key != localObjectKey) {
                unlinkCertifiedLocalObject(
                    current.local_object_key,
                    key,
                );
            };
            linkCertifiedLocalObject(localObjectKey, key);
            let oldBytes = Nat32.toNat(expected.body_length);
            let newBytes = Nat32.toNat(identity.body_length);
            mem.certified_object_bytes :=
                replaceByteCount(
                    mem.certified_object_bytes,
                    oldBytes,
                    newBytes,
                );
            let collectionKey = collectionText(
                expected.target.collection
            );
            let ?collection = Map.get(
                mem.certified_collections,
                Text.compare,
                collectionKey,
            ) else Runtime.trap(
                "Wagyu certified collection accounting disappeared"
            );
            if (
                collection.collection_generation !=
                    expected.target.collection_generation or
                collection.body_bytes < oldBytes
            ) Runtime.trap(
                "Wagyu certified collection accounting is inconsistent"
            );
            Map.add(
                mem.certified_collections,
                Text.compare,
                collectionKey,
                {
                    collection with
                    body_bytes = replaceByteCount(
                        collection.body_bytes,
                        oldBytes,
                        newBytes,
                    );
                },
            );
            Map.add(mem.certified_records, Text.compare, key, {
                current with
                identity;
                publication_id = publicationId;
                local_object_key = localObjectKey;
            });
        };

        func replacePostHeadAccounting(
            post : Memory.AuthoredPost,
            oldHeadBytes : Nat,
            newHeadBytes : Nat,
            status : Memory.AuthoredPostStatus,
        ) {
            if (
                post.retained_bytes < oldHeadBytes or
                mem.authored_bytes < oldHeadBytes
            ) Runtime.trap(
                "Wagyu authored/head accounting violated its preflight"
            );
            let nextRetained = replaceByteCount(
                post.retained_bytes,
                oldHeadBytes,
                newHeadBytes,
            );
            mem.authored_bytes := replaceByteCount(
                mem.authored_bytes,
                oldHeadBytes,
                newHeadBytes,
            );
            Map.add(
                mem.authored_posts,
                Text.compare,
                post.post_key,
                {
                    post with
                    status;
                    retained_bytes = nextRetained;
                },
            );
        };

        func replaceByteCount(
            current : Nat,
            removed : Nat,
            added : Nat,
        ) : Nat {
            if (current < removed) {
                Runtime.trap(
                    "Wagyu byte accounting underflowed"
                );
            };
            current - removed + added;
        };

        func sealedLikeBatchStableKey(
            postId : Blob,
            batchNumber : Nat64,
        ) : Text {
            "sealed-like-batch:" # Path.hexLower(postId) # ":" #
            Nat64.toText(batchNumber);
        };

        func sealedLikeBatchNumberStableKey(
            postId : Blob,
            batchNumber : Nat64,
        ) : Text {
            "sealed-like-batch-number:" # Path.hexLower(postId) # ":" #
            Nat64.toText(batchNumber);
        };

        func emptyPostLikeState(postKey : Text) : Memory.PostLikeState {
            {
                post_key = postKey;
                active_segment = {
                    segment_number = 0;
                    first_accepted_sequence = null;
                    last_accepted_sequence = null;
                    accepted_like_keys = [];
                    receipt_count = 0;
                    receipt_bytes = 0;
                };
                due_segment = null;
                next_segment_number = 1;
                next_batch_number = 0;
                retired_batch_prefix = 0;
                previous_batch_digest = null;
                closing = null;
                structurally_accepted_count = 0;
                unsealed_receipt_count = 0;
                unsealed_receipt_bytes = 0;
            };
        };

        func isBlockedNode(node : Principal) : Bool {
            Map.get(mem.blocks, Principal.compare, node) != null;
        };

        func feedPage(request : FeedPageRequestV1) : FeedPageV1 {
            let limit = Nat16.toNat(request.limit);
            let result = List.empty<FeedCandidateSummaryV1>();
            var totalBytes = 0;
            var examined = 0;
            var lastExamined : ?Nat64 = null;
            var hasMore = false;
            let entries = switch (request.before_sequence) {
                case null Map.reverseEntries(mem.feed_order);
                case (?before) {
                    Map.reverseEntriesFrom(
                        mem.feed_order,
                        Nat64.compare,
                        before,
                    );
                };
            };
            label collect for ((sequence, key) in entries) {
                switch (request.before_sequence) {
                    case (?before) if (sequence >= before) {
                        continue collect;
                    };
                    case (_) {};
                };
                if (
                    List.size(result) == limit or
                    examined == MAX_LOCAL_PAGE_ROWS_EXAMINED
                ) {
                    hasMore := true;
                    break collect;
                };
                examined += 1;
                let ?candidate = Map.get(
                    mem.feed_candidates,
                    Text.compare,
                    key,
                ) else {
                    lastExamined := ?sequence;
                    continue collect;
                };
                if (candidate.local_sequence != sequence) {
                    Runtime.trap(
                        "Wagyu feed order state invariant failed"
                    );
                };
                if (
                    not FeedVisibility.allows(
                        candidate.immediate_sender,
                        ?candidate.claimed_author,
                        candidate.event_kind == ?#tombstone,
                        isBlockedNode,
                    )
                ) {
                    lastExamined := ?sequence;
                    continue collect;
                };
                if (
                    totalBytes + candidate.exact_event_candid.size() >
                        Bounds.MAX_FEED_PAGE_EVENT_BYTES
                ) {
                    if (List.size(result) == 0) {
                        Runtime.trap(
                            "Wagyu feed candidate exceeds page bounds"
                        );
                    };
                    hasMore := true;
                    break collect;
                };
                List.add(result, {
                    candidate_id = candidate.candidate_id;
                    local_sequence = candidate.local_sequence;
                    received_at_ns = candidate.received_at_ns;
                    immediate_sender = candidate.immediate_sender;
                    event_kind = mapFeedKindToPublic(
                        candidate.event_kind
                    );
                    claimed_author = candidate.claimed_author;
                    claimed_post_id = candidate.claimed_post_id;
                    exact_event_candid = candidate.exact_event_candid;
                    verification = mapFeedVerificationToPublic(
                        candidate.verification
                    );
                });
                totalBytes += candidate.exact_event_candid.size();
                lastExamined := ?sequence;
            };
            {
                revision = mem.feed_revision;
                items = List.toArray(result);
                next_before_sequence =
                    if (hasMore) lastExamined else null;
            };
        };

        func notificationPage(
            request : NotificationPageRequestV1
        ) : NotificationPageV1 {
            let limit = Nat16.toNat(request.limit);
            let result = List.empty<NotificationSummaryV1>();
            var examined = 0;
            var lastExamined : ?Nat64 = null;
            var hasMore = false;
            let entries = switch (request.before_sequence) {
                case null Map.reverseEntries(mem.notification_order);
                case (?before) {
                    Map.reverseEntriesFrom(
                        mem.notification_order,
                        Nat64.compare,
                        before,
                    );
                };
            };
            label collect for ((sequence, _) in entries) {
                if (
                    request.before_sequence == ?sequence or
                    (
                        switch (request.before_sequence) {
                            case null false;
                            case (?before) sequence >= before;
                        }
                    )
                ) continue collect;
                if (
                    List.size(result) == limit or
                    examined == MAX_LOCAL_PAGE_ROWS_EXAMINED
                ) {
                    hasMore := true;
                    break collect;
                };
                examined += 1;
                switch (
                    Map.get(mem.notifications, Nat64.compare, sequence)
                ) {
                    case null {
                        lastExamined := ?sequence;
                    };
                    case (?summary) {
                        if (
                            not FeedVisibility.allows(
                                summary.actor_,
                                null,
                                false,
                                isBlockedNode,
                            )
                        ) {
                            lastExamined := ?sequence;
                            continue collect;
                        };
                        List.add(result, notificationToPublic(summary));
                        lastExamined := ?sequence;
                    };
                };
            };
            {
                revision = mem.notification_revision;
                items = List.toArray(result);
                next_before_sequence =
                    if (hasMore) lastExamined else null;
            };
        };

        func ingressFeedStore() : FeedTypes.Store {
            {
                snapshot = func() : FeedTypes.StoreSnapshot {
                    {
                        revision = mem.feed_revision;
                        last_sequence = mem.feed_sequence;
                        candidate_count = mem.candidate_count;
                        candidate_bytes = mem.candidate_bytes;
                        verified_feed_count = mem.verified_feed_count;
                    };
                };
                count_for_sender = func(sender : Principal) : Nat {
                    switch (
                        Map.get(
                            mem.candidate_pressure_by_sender,
                            Principal.compare,
                            sender,
                        )
                    ) {
                        case null 0;
                        case (?value) value.candidate_count;
                    };
                };
                find_candidate = func(
                    candidateId : Blob
                ) : ?FeedTypes.StoredCandidate {
                    let key = candidateStableKey(candidateId);
                    let ?value = Map.get(
                        mem.feed_candidates,
                        Text.compare,
                        key,
                    ) else return null;
                    feedCandidateView(value);
                };
                find_transport = func(
                    key : FeedTypes.TransportKey
                ) : ?FeedTypes.TransportBinding {
                    let receiptKey = ingressReceiptKey(
                        key.immediate_sender,
                        #deliver,
                        key.operation_id,
                    );
                    let ?receipt = Map.get(
                        mem.ingress_receipts,
                        Text.compare,
                        receiptKey,
                    ) else return null;
                    let ?candidateId = Hash.feedCandidateId(
                        key.immediate_sender,
                        key.operation_id,
                        receipt.payload_digest,
                    ) else return null;
                    let candidateKey = candidateStableKey(candidateId);
                    let ?candidate = Map.get(
                        mem.feed_candidates,
                        Text.compare,
                        candidateKey,
                    ) else return null;
                    ?{
                        key;
                        payload_digest = receipt.payload_digest;
                        candidate_id = candidateId;
                        candidate_key = candidateKey;
                        accepted_revision = switch (
                            receipt.result.revision
                        ) {
                            case null candidate.local_sequence;
                            case (?revision) revision;
                        };
                    };
                };
                find_canonical = func(
                    key : FeedTypes.CanonicalKey
                ) : ?FeedTypes.CanonicalRecord {
                    feedCanonicalView(key);
                };
                find_canonical_slot = func(
                    author : Principal,
                    postId : Blob,
                ) : [FeedTypes.CanonicalRecord] {
                    let slotKey = feedPostSlotStableKey(author, postId);
                    let ?feedKey = Map.get(
                        mem.verified_feed_by_post_slot,
                        Text.compare,
                        slotKey,
                    ) else return [];
                    let ?value = Map.get(
                        mem.verified_feed,
                        Text.compare,
                        feedKey,
                    ) else Runtime.trap(
                        "Wagyu verified feed slot index is dangling"
                    );
                    if (
                        value.feed_key != feedKey or
                        not Principal.equal(value.locator.author, author) or
                        not Blob.equal(value.locator.post_id, postId)
                    ) Runtime.trap(
                        "Wagyu verified feed slot index is corrupt"
                    );
                    let key : FeedTypes.CanonicalKey = {
                        author = value.locator.author;
                        post_id = value.locator.post_id;
                        body_hash = value.locator.body_hash;
                    };
                    let ?record = feedCanonicalView(key) else Runtime.trap(
                        "Wagyu verified feed slot cannot be decoded"
                    );
                    [record];
                };
                find_attribution = func(
                    key : FeedTypes.CanonicalKey,
                    sharer : Principal,
                ) : ?FeedTypes.ShareAttribution {
                    let ?value = Map.get(
                        mem.share_attributions,
                        Text.compare,
                        feedAttributionStableKey(key, sharer),
                    ) else return null;
                    shareAttributionView(key, value);
                };
                attribution_count = func(
                    key : FeedTypes.CanonicalKey
                ) : Nat {
                    var count = 0;
                    let feedKey = feedCanonicalStableKey(key);
                    let prefix = "attribution:" # feedKey # ":";
                    label rows for (
                        (storedKey, value) in Map.entriesFrom(
                            mem.share_attributions,
                            Text.compare,
                            prefix,
                        )
                    ) {
                        if (value.feed_key != feedKey) break rows;
                        if (
                            storedKey != value.attribution_key or
                            storedKey !=
                                feedAttributionStableKeyForFeed(
                                    value.feed_key,
                                    value.sharer,
                                )
                        ) Runtime.trap(
                            "Wagyu feed attribution index is corrupt"
                        );
                        count += 1;
                        if (
                            count >
                                FeedTypes.MAX_RECEIVED_VIA
                        ) break rows;
                    };
                    count;
                };
                find_suppression = func(
                    key : FeedTypes.CanonicalKey
                ) : ?FeedTypes.SuppressionRecord {
                    let ?value = Map.get(
                        mem.suppressions,
                        Text.compare,
                        feedCanonicalStableKey(key),
                    ) else return null;
                    suppressionView(key, value);
                };
                scan_claimed_slot = func(
                    author : Principal,
                    postId : Blob,
                ) : [FeedTypes.StoredCandidate] {
                    let slotKey = feedPostSlotStableKey(author, postId);
                    let candidateKeys = switch (
                        Map.get(
                            mem.feed_candidates_by_claimed_slot,
                            Text.compare,
                            slotKey,
                        )
                    ) {
                        case null return [];
                        case (?value) value;
                    };
                    if (
                        candidateKeys.size() >
                            FeedTypes.MAX_CANDIDATES_PER_CLAIMED_SLOT
                    ) Runtime.trap(
                        "Wagyu claimed feed slot exceeds its fixed cap"
                    );
                    let values = List.empty<FeedTypes.StoredCandidate>();
                    for (candidateKey in candidateKeys.vals()) {
                        let ?value = Map.get(
                            mem.feed_candidates,
                            Text.compare,
                            candidateKey,
                        ) else Runtime.trap(
                            "Wagyu claimed feed slot index is dangling"
                        );
                        if (
                            not Principal.equal(
                                value.claimed_author,
                                author,
                            ) or
                            not Blob.equal(value.claimed_post_id, postId)
                        ) Runtime.trap(
                            "Wagyu claimed feed slot index is corrupt"
                        );
                        let ?candidate = feedCandidateView(value)
                        else Runtime.trap(
                            "Wagyu claimed feed slot row cannot be decoded"
                        );
                        List.add(values, candidate);
                    };
                    List.toArray(values);
                };
                scan_descending = func(
                    before : ?Nat64,
                    limit : Nat,
                ) : [FeedTypes.StoredCandidate] {
                    let rows = List.empty<FeedTypes.StoredCandidate>();
                    let entries = switch (before) {
                        case null Map.reverseEntries(mem.feed_order);
                        case (?cursor) {
                            Map.reverseEntriesFrom(
                                mem.feed_order,
                                Nat64.compare,
                                cursor,
                            );
                        };
                    };
                    label collect for ((sequence, key) in entries) {
                        switch (before) {
                            case (?cursor) if (sequence >= cursor) {
                                continue collect;
                            };
                            case (_) {};
                        };
                        if (List.size(rows) == limit) break collect;
                        let ?value = Map.get(
                            mem.feed_candidates,
                            Text.compare,
                            key,
                        ) else continue collect;
                        let ?candidate = feedCandidateView(value)
                        else continue collect;
                        List.add(rows, candidate);
                    };
                    List.toArray(rows);
                };
                commit_admission = func(_) { false };
                commit_promotion = func(_) { false };
                commit_verification = func(_) { false };
            };
        };

        // Ingress execution uses the read-only adapter above while it builds a
        // larger receipt/domain commit. Owner-authorized verification uses the
        // same views with only the two feed mutation callbacks enabled, so it
        // cannot accidentally make paid ingress planning side-effectful.
        func promotionFeedStore() : FeedTypes.Store {
            let base = ingressFeedStore();
            {
                base with
                commit_promotion = commitFeedPromotion;
                commit_verification = commitFeedVerification;
            };
        };

        func candidateStableKey(candidateId : Blob) : Text {
            "candidate:" # Path.hexLower(candidateId);
        };

        func feedPostSlotStableKey(
            author : Principal,
            postId : Blob,
        ) : Text {
            "feed-slot:" # Principal.toText(author) # ":" #
            Path.hexLower(postId);
        };

        func feedCanonicalStableKey(
            key : FeedTypes.CanonicalKey
        ) : Text {
            "feed:" # Principal.toText(key.author) # ":" #
            Path.hexLower(key.post_id) # ":" #
            Path.hexLower(key.body_hash);
        };

        func feedCandidateView(
            value : Memory.FeedCandidate
        ) : ?FeedTypes.StoredCandidate {
            let eventKind = switch (value.event_kind) {
                case null return null;
                case (?#original) #original;
                case (?#share) #share;
                case (?#tombstone) #tombstone;
            };
            let ?claimedBodyHash = value.claimed_body_hash else {
                return null;
            };
            let verification = switch (value.verification) {
                case null return null;
                case (?#pending) #pending;
                case (?#verified) #verified;
                case (?#invalid) #invalid;
                case (?#unavailable) #unavailable;
            };
            ?{
                candidate_key = value.candidate_key;
                candidate_id = value.candidate_id;
                route_receipt_key = value.route_receipt_key;
                operation_id = value.operation_id;
                payload_digest = value.payload_digest;
                subscription_id = value.subscription_id;
                local_sequence = value.local_sequence;
                received_at_ns = value.received_at_ns;
                immediate_sender = value.immediate_sender;
                event_kind = eventKind;
                claimed_author = value.claimed_author;
                claimed_post_id = value.claimed_post_id;
                claimed_body_hash = claimedBodyHash;
                exact_event_candid = value.exact_event_candid;
                verification;
                retain_until_ns = value.retain_until_ns;
                retained_bytes = value.retained_bytes;
            };
        };

        func feedCanonicalView(
            key : FeedTypes.CanonicalKey
        ) : ?FeedTypes.CanonicalRecord {
            let stableKey = feedCanonicalStableKey(key);
            let ?value = Map.get(
                mem.verified_feed,
                Text.compare,
                stableKey,
            ) else return null;
            let ?firstCandidate = Map.get(
                mem.feed_candidates,
                Text.compare,
                value.first_candidate_key,
            ) else return null;
            let directCandidateId = switch (
                value.direct_candidate_key
            ) {
                case null null;
                case (?candidateKey) {
                    switch (
                        Map.get(
                            mem.feed_candidates,
                            Text.compare,
                            candidateKey,
                        )
                    ) {
                        case null null;
                        case (?candidate) ?candidate.candidate_id;
                    };
                };
            };
            ?{
                key;
                post = {
                    key;
                    body_length = value.locator.body_length;
                    object_digest = value.locator.object_digest;
                    exact_certified_post_ref_candid =
                        value.locator.exact_certified_post_ref_candid;
                    certified_ref = memoryPostRefToProtocol(
                        value.locator.certified_ref
                    );
                };
                first_candidate_id = firstCandidate.candidate_id;
                first_local_sequence = value.first_local_sequence;
                latest_local_sequence = value.latest_local_sequence;
                direct_candidate_id = directCandidateId;
                status = switch (value.status) {
                    case (#active) #active;
                    case (#withdrawn(info)) #withdrawn(info);
                };
                created_at_ns = value.created_at_ns;
                updated_at_ns = value.updated_at_ns;
            };
        };

        func shareAttributionView(
            key : FeedTypes.CanonicalKey,
            value : Memory.ShareAttribution,
        ) : ?FeedTypes.ShareAttribution {
            let ?candidate = Map.get(
                mem.feed_candidates,
                Text.compare,
                value.candidate_key,
            ) else return null;
            ?{
                key;
                sharer = value.sharer;
                share_id = value.share_id;
                share_object_digest = value.share_object_digest;
                candidate_id = candidate.candidate_id;
                exact_share_action_candid =
                    value.exact_share_action_candid;
                exact_share_ref_candid = value.exact_share_ref_candid;
                verified_at_ns = value.verified_at_ns;
            };
        };

        func suppressionView(
            key : FeedTypes.CanonicalKey,
            value : Memory.SuppressionRecord,
        ) : ?FeedTypes.SuppressionRecord {
            let ?candidateKey = value.source_candidate_key else return null;
            let ?candidate = Map.get(
                mem.feed_candidates,
                Text.compare,
                candidateKey,
            ) else return null;
            ?{
                key;
                tombstone_id = value.tombstone_id;
                exact_tombstone_candid = value.exact_tombstone_candid;
                source_candidate_id = candidate.candidate_id;
                suppressed_at_ns = value.suppressed_at_ns;
                retain_until_ns = value.retain_until_ns;
            };
        };

        func ingressNotificationStore() : NotificationTypes.Store {
            {
                snapshot = func() : NotificationTypes.StoreSnapshot {
                    {
                        revision = mem.notification_revision;
                        last_sequence = mem.notification_sequence;
                        // Notification.Service has no byte-accounting view.
                        // Surface a full snapshot when even the smallest
                        // notification cannot fit so Follow can take its
                        // best-effort notification path before commit.
                        total_count =
                            if (
                                mem.notification_bytes +
                                    INGRESS_NOTIFICATION_ACCOUNTING_OVERHEAD >
                                    mem.quota_limits.notification_bytes
                            ) {
                                NotificationTypes.MAX_SUMMARIES;
                            } else mem.notification_count;
                    };
                };
                find_semantic = func(
                    semantic : NotificationTypes.SemanticKey
                ) : ?NotificationTypes.StoredNotification {
                    let stableKey =
                        notificationSemanticStableKey(semantic);
                    let ?sequence = Map.get(
                        mem.notification_by_semantic,
                        Text.compare,
                        stableKey,
                    ) else return null;
                    notificationStoredView(sequence);
                };
                get = notificationStoredView;
                scan_descending = func(
                    before : ?Nat64,
                    limit : Nat,
                ) : [NotificationTypes.StoredNotification] {
                    let rows =
                        List.empty<NotificationTypes.StoredNotification>();
                    let entries = switch (before) {
                        case null Map.reverseEntries(mem.notification_order);
                        case (?cursor) {
                            Map.reverseEntriesFrom(
                                mem.notification_order,
                                Nat64.compare,
                                cursor,
                            );
                        };
                    };
                    label collect for ((sequence, _) in entries) {
                        switch (before) {
                            case (?cursor) if (sequence >= cursor) {
                                continue collect;
                            };
                            case (_) {};
                        };
                        if (List.size(rows) == limit) break collect;
                        switch (notificationStoredView(sequence)) {
                            case null {};
                            case (?stored) List.add(rows, stored);
                        };
                    };
                    List.toArray(rows);
                };
                notice_count_for_actor = func(
                    actingNode : Principal
                ) : Nat {
                    switch (
                        Map.get(
                            mem.notice_pressure_by_caller,
                            Principal.compare,
                            actingNode,
                        )
                    ) {
                        case null 0;
                        case (?value) value.retained_count;
                    };
                };
                notice_count_for_target = func(postId : Blob) : Nat {
                    switch (
                        Map.get(
                            mem.notice_count_by_target,
                            Text.compare,
                            postStableKey(postId),
                        )
                    ) {
                        case null 0;
                        case (?count) count;
                    };
                };
                commit_append = func(_) { false };
                commit_replace = func(_) { false };
            };
        };

        func promotionNotificationStore() : NotificationTypes.Store {
            let base = ingressNotificationStore();
            {
                base with commit_replace = commitNotificationReplacement
            };
        };

        func promotionLikeNotificationStore() :
            NotificationTypes.Store {
            let base = ingressNotificationStore();
            {
                base with
                commit_replace = commitLikeNotificationReplacement
            };
        };

        func notificationSemanticStableKey(
            semantic : NotificationTypes.SemanticKey
        ) : Text {
            switch (semantic) {
                case (#new_follower(value)) {
                    "notification:new-follower:" #
                    Principal.toText(value.acting_node) # ":" #
                    Nat64.toText(value.follower_revision);
                };
                case (#like(value)) {
                    "notification:like:" #
                    Principal.toText(value.acting_node) # ":" #
                    Path.hexLower(value.target_post_id);
                };
                case (#notice(value)) {
                    "notification:notice:" #
                    Principal.toText(value.acting_node) # ":" #
                    (
                        switch (value.relation) {
                            case (#reply) "reply";
                            case (#share) "share";
                        }
                    ) # ":" # Path.hexLower(value.action_id);
                };
            };
        };

        func notificationStoredView(
            sequence : Nat64
        ) : ?NotificationTypes.StoredNotification {
            let ?value = Map.get(
                mem.notifications,
                Nat64.compare,
                sequence,
            ) else return null;
            let summary : Protocol.NotificationSummaryV1 = {
                local_sequence = value.local_sequence;
                received_at_ns = value.received_at_ns;
                actor_ = value.actor_;
                kind = switch (value.kind) {
                    case null null;
                    case (?#new_follower(info)) {
                        ?#new_follower(info);
                    };
                    case (?#like(info)) ?#like(info);
                    case (?#reply(info)) ?#reply(info);
                    case (?#share(info)) ?#share(info);
                };
                verification = switch (value.verification) {
                    case null null;
                    case (?#transport_authenticated) {
                        ?#transport_authenticated;
                    };
                    case (?#pending) ?#pending;
                    case (?#verified) ?#verified;
                    case (?#invalid) ?#invalid;
                    case (?#unavailable) ?#unavailable;
                };
                read = value.read;
            };
            let evidence = switch (
                Map.get(
                    mem.notification_evidence,
                    Nat64.compare,
                    sequence,
                )
            ) {
                case (?#like(info)) {
                    ?info.exact_certified_like_receipt_candid;
                };
                case null null;
            };
            ?{
                summary;
                like_evidence = evidence;
            };
        };

        func commitFeedVerification(
            mutation : FeedTypes.VerificationCommit
        ) : Bool {
            if (
                mutation.expected_revision != mem.feed_revision or
                mutation.expected_revision == Nat64.maxValue or
                mutation.revision != mutation.expected_revision + 1 or
                mem.state_revision == Nat64.maxValue
            ) return false;
            let previous = mutation.candidate.previous;
            let replacement = mutation.candidate.replacement;
            if (
                previous.candidate_key != replacement.candidate_key or
                replacement != {
                    previous with verification = replacement.verification
                }
            ) return false;
            let ?stored = Map.get(
                mem.feed_candidates,
                Text.compare,
                previous.candidate_key,
            ) else return false;
            if (feedCandidateView(stored) != ?previous) return false;
            if (replacement.verification == #invalid) {
                let record : Memory.RetentionRecordRef =
                    #feed_candidate(previous.candidate_key);
                let ?entry = currentRetentionEntry(record)
                    else return false;
                let view = switch (inspectRetentionEntry(entry)) {
                    case (#record(value)) value;
                    case (_) return false;
                };
                let #feed_candidate(candidateView) = view
                    else return false;
                if (
                    candidateView.candidate_key !=
                        previous.candidate_key or
                    not candidateView.dependents_detached or
                    not canDeleteRetentionPrimary(view)
                ) return false;
                let decrement = retentionCounterDelta(view);
                if (not canSubtractRetentionCounters(decrement)) {
                    return false;
                };
                applyRetentionPrimaryDeletion(view);
                Map.remove(
                    mem.retention_order,
                    retentionIndexCompare,
                    entry.key,
                );
                Map.remove(
                    mem.retention_current,
                    Text.compare,
                    RetentionService.canonicalKey(record),
                );
                subtractRetentionCounters(decrement);
                mem.feed_revision := mutation.revision;
                mem.state_revision += 1;
                return true;
            };
            Map.add(
                mem.feed_candidates,
                Text.compare,
                previous.candidate_key,
                {
                    stored with
                    verification = ?replacement.verification;
                },
            );
            mem.feed_revision := mutation.revision;
            mem.state_revision += 1;
            true;
        };

        func commitFeedPromotion(
            mutation : FeedTypes.PromotionCommit
        ) : Bool {
            if (
                mutation.expected != ingressFeedStore().snapshot() or
                mutation.expected.revision == Nat64.maxValue or
                mutation.revision != mutation.expected.revision + 1 or
                mutation.candidates.size() == 0 or
                mem.state_revision == Nat64.maxValue
            ) return false;

            let candidateKeys = List.empty<Text>();
            for (change in mutation.candidates.vals()) {
                let previous = change.previous;
                let replacement = change.replacement;
                if (
                    previous.candidate_key != replacement.candidate_key or
                    replacement != {
                        previous with
                        verification = replacement.verification;
                    } or
                    textListContains(
                        candidateKeys,
                        previous.candidate_key,
                    )
                ) return false;
                let ?stored = Map.get(
                    mem.feed_candidates,
                    Text.compare,
                    previous.candidate_key,
                ) else return false;
                if (feedCandidateView(stored) != ?previous) return false;
                List.add(candidateKeys, previous.candidate_key);
            };

            let canonicalRow = switch (mutation.canonical) {
                case null null;
                case (?change) {
                    let replacementFeedKey =
                        feedCanonicalStableKey(change.replacement.key);
                    let slotKey = feedPostSlotStableKey(
                        change.replacement.key.author,
                        change.replacement.key.post_id,
                    );
                    if (
                        feedCanonicalView(change.replacement.key) !=
                            change.previous
                    ) return false;
                    switch (change.previous) {
                        case null {
                            if (
                                Map.get(
                                    mem.verified_feed,
                                    Text.compare,
                                    replacementFeedKey,
                                ) != null or
                                Map.get(
                                    mem.verified_feed_by_post_slot,
                                    Text.compare,
                                    slotKey,
                                ) != null
                            ) return false;
                        };
                        case (?previous) {
                            if (
                                feedPostSlotStableKey(
                                    previous.key.author,
                                    previous.key.post_id,
                                ) != slotKey or
                                Map.get(
                                    mem.verified_feed_by_post_slot,
                                    Text.compare,
                                    slotKey,
                                ) != ?replacementFeedKey
                            ) return false;
                        };
                    };
                    let ?row = feedCanonicalMemory(
                        change.replacement
                    ) else return false;
                    ?row;
                };
            };

            let attributionRow = switch (mutation.attribution) {
                case null null;
                case (?attribution) {
                    if (
                        ingressFeedStore().find_attribution(
                            attribution.key,
                            attribution.sharer,
                        ) != null
                    ) return false;
                    let row = feedAttributionMemory(attribution);
                    if (
                        Map.get(
                            mem.share_attributions,
                            Text.compare,
                            row.attribution_key,
                        ) != null
                    ) return false;
                    ?row;
                };
            };

            let suppressionRow = switch (mutation.suppression) {
                case null null;
                case (?change) {
                    if (
                        ingressFeedStore().find_suppression(
                            change.replacement.key
                        ) != change.previous
                    ) return false;
                    let ?row = feedSuppressionMemory(
                        change.replacement
                    ) else return false;
                    ?row;
                };
            };

            let targetKey : ?FeedTypes.CanonicalKey = switch (
                mutation.suppression,
                mutation.candidates[0].previous,
            ) {
                case (?change, _) ?change.replacement.key;
                case (null, primary) {
                    if (mutation.hide_sequences.size() == 0) null
                    else ?{
                        author = primary.claimed_author;
                        post_id = primary.claimed_post_id;
                        body_hash = primary.claimed_body_hash;
                    };
                };
            };
            let hidden = List.empty<(Nat64, Text)>();
            for (sequence in mutation.hide_sequences.vals()) {
                if (sequence == 0) return false;
                let candidateKey = switch (
                    Map.get(mem.feed_order, Nat64.compare, sequence)
                ) {
                    case (?key) key;
                    case null {
                        var replacementKey : ?Text = null;
                        for (change in mutation.candidates.vals()) {
                            if (
                                change.previous.local_sequence == sequence
                            ) {
                                if (replacementKey != null) return false;
                                replacementKey :=
                                    ?change.previous.candidate_key;
                            };
                        };
                        let ?key = replacementKey else return false;
                        key;
                    };
                };
                let ?candidate = Map.get(
                    mem.feed_candidates,
                    Text.compare,
                    candidateKey,
                ) else return false;
                if (candidate.local_sequence != sequence) return false;
                let ?key = targetKey else return false;
                if (
                    candidate.event_kind == ?#tombstone or
                    not Principal.equal(
                        candidate.claimed_author,
                        key.author,
                    ) or
                    not Blob.equal(
                        candidate.claimed_post_id,
                        key.post_id,
                    ) or
                    candidate.claimed_body_hash != ?key.body_hash or
                    textPairListContains(
                        hidden,
                        sequence,
                        candidateKey,
                    )
                ) return false;
                switch (
                    Map.get(mem.feed_order, Nat64.compare, sequence)
                ) {
                    case (?storedKey) {
                        if (storedKey != candidate.candidate_key) {
                            return false;
                        };
                    };
                    case null {
                        if (
                            Map.get(
                                mem.unread_feed_candidates,
                                Text.compare,
                                candidate.candidate_key,
                            ) != null
                        ) return false;
                    };
                };
                List.add(hidden, (sequence, candidateKey));
            };

            let relayResult = switch (
                mutation.suppression,
                suppressionRow,
            ) {
                case (?change, ?row) {
                    switch (change.previous) {
                        case null {
                            planFeedTombstoneRelay(
                                change.replacement.key,
                                row,
                            );
                        };
                        case (?_) #none;
                    };
                };
                case (_) #none;
            };
            let relayPlan = switch (relayResult) {
                case (#none) null;
                case (#planned(plan)) ?plan;
                case (#blocked) return false;
            };

            if (
                not feedPromotionQuotaAvailable(
                    mutation,
                    canonicalRow,
                    attributionRow,
                    suppressionRow,
                    relayPlan,
                )
            ) return false;
            let retentionResult = feedPromotionRetentionPlan(
                mutation,
                canonicalRow,
                attributionRow,
                suppressionRow,
                relayPlan,
            );
            let retention = switch (retentionResult) {
                case (#none) null;
                case (#planned(plan)) {
                    if (not canApplyRetentionRegistration(plan)) {
                        return false;
                    };
                    ?plan;
                };
                case (#blocked) return false;
            };

            for (change in mutation.candidates.vals()) {
                let ?stored = Map.get(
                    mem.feed_candidates,
                    Text.compare,
                    change.previous.candidate_key,
                ) else Runtime.trap(
                    "Wagyu feed promotion preflight invariant failed"
                );
                Map.add(
                    mem.feed_candidates,
                    Text.compare,
                    change.previous.candidate_key,
                    {
                        stored with
                        verification =
                            ?change.replacement.verification;
                    },
                );
            };
            switch (canonicalRow) {
                case null {};
                case (?row) applyFeedCanonicalRow(row);
            };
            switch (attributionRow) {
                case null {};
                case (?row) {
                    Map.add(
                        mem.share_attributions,
                        Text.compare,
                        row.attribution_key,
                        row,
                    );
                    mem.share_attribution_count += 1;
                    mem.share_attribution_bytes += row.retained_bytes;
                };
            };
            switch (suppressionRow) {
                case null {};
                case (?row) applyFeedSuppressionRow(row);
            };
            for ((sequence, candidateKey) in List.values(hidden)) {
                if (
                    Map.get(mem.feed_order, Nat64.compare, sequence) !=
                        null
                ) {
                    Map.remove(mem.feed_order, Nat64.compare, sequence);
                    if (
                        Map.get(
                            mem.unread_feed_candidates,
                            Text.compare,
                            candidateKey,
                        ) != null
                    ) {
                        Map.remove(
                            mem.unread_feed_candidates,
                            Text.compare,
                            candidateKey,
                        );
                        mem.unread_feed_count -= 1;
                    };
                };
            };
            switch (relayPlan) {
                case null {};
                case (?plan) {
                    Map.add(
                        mem.fanout_jobs,
                        Nat64.compare,
                        plan.fanout.fanout_job_id,
                        plan.fanout,
                    );
                    Map.add(
                        mem.fanout_target_count_by_job,
                        Nat64.compare,
                        plan.fanout.fanout_job_id,
                        0,
                    );
                    incrementAuthoredDependency(
                        plan.fanout.action_key
                    );
                    Map.add(
                        mem.tombstone_relays,
                        Text.compare,
                        plan.relay.relay_key,
                        plan.relay,
                    );
                    mem.fanout_sequence :=
                        plan.fanout.fanout_job_id;
                    mem.fanout_job_count += 1;
                    mem.fanout_bytes +=
                        plan.fanout.retained_bytes;
                    mem.tombstone_relay_count += 1;
                    mem.tombstone_relay_bytes +=
                        plan.relay.retained_bytes;
                };
            };
            switch (retention) {
                case null {};
                case (?plan) applyRetentionRegistration(plan);
            };
            mem.feed_revision := mutation.revision;
            mem.state_revision += 1;
            true;
        };

        func commitNotificationReplacement(
            mutation : NotificationTypes.ReplaceCommit
        ) : Bool {
            let ?stored = prepareNotificationReplacement(
                mutation,
                1,
            ) else return false;
            applyNotificationReplacement(mutation, stored);
            true;
        };

        func prepareNotificationReplacement(
            mutation : NotificationTypes.ReplaceCommit,
            requiredStateHeadroom : Nat64,
        ) : ?Memory.NotificationSummary {
            if (
                mutation.expected_revision !=
                    mem.notification_revision or
                mutation.expected_revision == Nat64.maxValue or
                mutation.revision != mutation.expected_revision + 1 or
                mutation.previous.local_sequence !=
                    mutation.replacement.local_sequence or
                mutation.replacement != {
                    mutation.previous with
                    verification = mutation.replacement.verification;
                } or
                requiredStateHeadroom == 0 or
                mem.state_revision >
                    Nat64.maxValue - requiredStateHeadroom
            ) return null;
            let sequence = mutation.previous.local_sequence;
            let ?stored = Map.get(
                mem.notifications,
                Nat64.compare,
                sequence,
            ) else return null;
            let ?current = notificationStoredView(sequence)
            else return null;
            if (current.summary != mutation.previous) return null;
            ?stored;
        };

        func applyNotificationReplacement(
            mutation : NotificationTypes.ReplaceCommit,
            stored : Memory.NotificationSummary,
        ) {
            let sequence = mutation.previous.local_sequence;
            Map.add(
                mem.notifications,
                Nat64.compare,
                sequence,
                {
                    stored with
                    received_at_ns =
                        mutation.replacement.received_at_ns;
                    actor_ = mutation.replacement.actor_;
                    kind = protocolNotificationKindToMemory(
                        mutation.replacement.kind
                    );
                    verification =
                        protocolNotificationVerificationToMemory(
                            mutation.replacement.verification
                        );
                    read = mutation.replacement.read;
                },
            );
            mem.notification_revision := mutation.revision;
            mem.state_revision += 1;
        };

        func commitReplyNotificationReplacement(
            mutation : NotificationTypes.ReplaceCommit,
            next : NotificationTypes.NotificationVerificationV1,
            verifiedReply : ?OwnerBridgeTypes.VerifiedReplyInputV1,
            committedAt : Nat64,
        ) : LocalResultV1<()> {
            let ?stored = prepareNotificationReplacement(
                mutation,
                2,
            ) else return #err(#busy);
            if (mutation.replacement.verification != ?next) {
                return #err(#busy);
            };
            switch (
                applyReplyIndexVerification(
                    mutation.previous,
                    next,
                    verifiedReply,
                    committedAt,
                )
            ) {
                case (#ok(_)) {};
                case (#err(error)) return #err(error);
            };
            applyNotificationReplacement(mutation, stored);
            #ok(());
        };

        func commitLikeNotificationReplacement(
            mutation : NotificationTypes.ReplaceCommit
        ) : Bool {
            if (
                mutation.expected_revision !=
                    mem.notification_revision or
                mutation.expected_revision == Nat64.maxValue or
                mutation.revision != mutation.expected_revision + 1 or
                mutation.previous.local_sequence !=
                    mutation.replacement.local_sequence or
                mutation.replacement != {
                    mutation.previous with
                    verification = mutation.replacement.verification;
                } or
                mem.state_revision == Nat64.maxValue
            ) return false;
            let sequence = mutation.previous.local_sequence;
            let ?stored = Map.get(
                mem.notifications,
                Nat64.compare,
                sequence,
            ) else return false;
            let ?current = notificationStoredView(sequence)
                else return false;
            if (
                current.summary != mutation.previous or
                (
                    switch (mutation.previous.kind) {
                        case (?#like(_)) false;
                        case (_) true;
                    }
                )
            ) return false;

            if (mutation.replacement.verification == ?#invalid) {
                let record : Memory.RetentionRecordRef =
                    #notification(sequence);
                let ?entry = currentRetentionEntry(record)
                    else return false;
                let view = switch (inspectRetentionEntry(entry)) {
                    case (#record(value)) value;
                    case (_) return false;
                };
                let #notification(notificationView) = view
                    else return false;
                if (
                    notificationView.local_sequence != sequence or
                    not canDeleteRetentionPrimary(view)
                ) return false;
                let decrement = retentionCounterDelta(view);
                if (not canSubtractRetentionCounters(decrement)) {
                    return false;
                };
                applyRetentionPrimaryDeletion(view);
                Map.remove(
                    mem.retention_order,
                    retentionIndexCompare,
                    entry.key,
                );
                Map.remove(
                    mem.retention_current,
                    Text.compare,
                    RetentionService.canonicalKey(record),
                );
                subtractRetentionCounters(decrement);
                mem.notification_revision := mutation.revision;
                mem.state_revision += 1;
                return true;
            };

            if (mutation.replacement.verification != ?#verified) {
                return commitNotificationReplacement(mutation);
            };
            let ?promotion = prepareLikePromotion(current)
                else return false;
            switch (promotion) {
                case (#duplicate) {};
                case (#accepted(plan)) {
                    applyPromotedLike(
                        plan.mutation,
                        plan.action,
                        plan.notification_sequence,
                    );
                    applyRetentionRegistration(plan.retention);
                };
            };
            Map.add(
                mem.notifications,
                Nat64.compare,
                sequence,
                {
                    stored with
                    verification = ?#verified;
                },
            );
            mem.notification_revision := mutation.revision;
            mem.state_revision += 1;
            true;
        };

        func prepareLikePromotion(
            stored : NotificationTypes.StoredNotification
        ) : ?LikePromotionDecision {
            let summary = stored.summary;
            let ?#like(info) = summary.kind else return null;
            let ?evidence = stored.like_evidence else return null;
            let ?receipt = Wire.decodeCertifiedLikeReceipt(evidence)
                else return null;
            let ?action = Wire.decodeLikeAction(
                receipt.like_action_candid
            ) else return null;
            let acceptedKey = acceptedLikeStableKey(
                info.target_post_id,
                summary.actor_,
            );
            let evidenceMatches = switch (
                Map.get(
                    mem.notification_evidence,
                    Nat64.compare,
                    summary.local_sequence,
                )
            ) {
                case (?#like(value)) {
                    value.accepted_like_key == acceptedKey and
                    Blob.equal(
                        value.exact_certified_like_receipt_candid,
                        evidence,
                    );
                };
                case null false;
            };
            if (not evidenceMatches) return null;

            switch (
                Map.get(
                    mem.accepted_likes,
                    Text.compare,
                    acceptedKey,
                )
            ) {
                case (?accepted) {
                    if (
                        accepted.notification_sequence ==
                            summary.local_sequence and
                        Principal.equal(
                            accepted.liker,
                            summary.actor_,
                        ) and
                        Blob.equal(accepted.post_id, info.target_post_id) and
                        Blob.equal(
                            accepted.post_body_hash,
                            info.target_body_hash,
                        ) and
                        Blob.equal(accepted.like_id, info.action_id) and
                        Blob.equal(
                            accepted.object_digest,
                            info.object_digest,
                        ) and
                        accepted.body_length == info.object_length and
                        Blob.equal(
                            accepted.exact_like_action_candid,
                            receipt.like_action_candid,
                        ) and
                        Blob.equal(
                            accepted.exact_certified_like_receipt_candid,
                            evidence,
                        )
                    ) return ?#duplicate;
                    return null;
                };
                case null {};
            };

            let ?target = ingressLikeTarget(
                info.target_post_id,
                summary.actor_,
            ) else return null;
            let decision = LikeAdmission.admit({
                caller = summary.actor_;
                network_id = currentProfile().network_id;
                post_author = target.post_author;
                post_id = target.post_id;
                post_body_hash = target.post_body_hash;
                action;
                receipt;
                exact_receipt_candid = evidence;
                accepted_at_ns = summary.received_at_ns;
                next_accepted_sequence =
                    target.next_accepted_sequence;
                existing_receipt_digest =
                    target.existing_receipt_digest;
                segments = target.segments;
                accepting_likes = target.accepting_likes;
                blocked = false;
            });
            let admitted = switch (decision) {
                case (#accepted(value)) value;
                case (_) return null;
            };
            let ?likeState = Map.get(
                mem.like_states,
                Text.compare,
                target.post_key,
            ) else return null;
            let verifiedBefore =
                LikeAdmission.unsealedCount(target.segments);
            let retainedBytes =
                evidence.size() +
                receipt.like_action_candid.size() +
                ACCEPTED_LIKE_ACCOUNTING_OVERHEAD;
            let rollover = admitted.seal_due;
            if (
                not Blob.equal(info.target_body_hash, target.post_body_hash) or
                not Blob.equal(info.action_id, action.like_id) or
                not Blob.equal(
                    info.object_digest,
                    receipt.ref.object_digest,
                ) or
                info.object_length != receipt.ref.body_length or
                Nat16.toNat(target.unsealed_receipt_count) <=
                    verifiedBefore or
                LikeAdmission.unsealedCount(admitted.segments) >
                    Nat16.toNat(target.unsealed_receipt_count) or
                (
                    rollover and
                    likeState.next_segment_number == Nat64.maxValue
                ) or
                mem.accepted_like_count >=
                    mem.quota_limits.reaction_receipt_count or
                mem.accepted_like_bytes + retainedBytes >
                    mem.quota_limits.reaction_receipt_bytes or
                Map.get(
                    mem.accepted_likes_by_sequence,
                    Nat64.compare,
                    admitted.accepted.accepted_sequence,
                ) != null
            ) return null;
            let retainUntil = addSaturating(
                summary.received_at_ns,
                mem.retention.likes_ns,
            );
            let mutation : IngressTypes.LikeMutation = {
                post_key = target.post_key;
                expected_next_accepted_sequence =
                    target.next_accepted_sequence;
                expected_existing_receipt_digest =
                    target.existing_receipt_digest;
                expected_segments = target.segments;
                accepted = admitted.accepted;
                replacement_next_accepted_sequence =
                    admitted.next_accepted_sequence;
                replacement_segments = admitted.segments;
                seal_due = admitted.seal_due;
                retain_until_ns = retainUntil;
                retained_bytes = retainedBytes;
            };
            let retention = switch (
                RetentionService.prepareRegistration(
                    {
                        peer_records_ns =
                            mem.retention.peer_records_ns;
                        likes_ns = mem.retention.likes_ns;
                        rate_window_ns =
                            mem.retention.rate_window_ns;
                    },
                    mem.retention_sequence,
                    #accepted_like({
                        accepted_like_key = acceptedKey;
                        accepted_sequence =
                            admitted.accepted.accepted_sequence;
                        accepted_at_ns =
                            admitted.accepted.accepted_at_ns;
                        retain_until_ns = retainUntil;
                        withdrawn_at_ns = null;
                        retained_bytes = retainedBytes;
                        post_key = target.post_key;
                        notification_sequence =
                            summary.local_sequence;
                        segment = ?{
                            segment_number =
                                likeState.active_segment.segment_number;
                            lane =
                                if (rollover) #due else #active;
                        };
                    }),
                )
            ) {
                case (#ok(value)) value;
                case (#err(_)) return null;
            };
            if (not canApplyRetentionRegistration(retention)) {
                return null;
            };
            ?#accepted({
                mutation;
                action;
                notification_sequence = summary.local_sequence;
                retention;
            });
        };

        func feedCanonicalMemory(
            value : FeedTypes.CanonicalRecord
        ) : ?Memory.VerifiedFeedRecord {
            let feedKey = feedCanonicalStableKey(value.key);
            let firstCandidateKey =
                candidateStableKey(value.first_candidate_id);
            if (
                Map.get(
                    mem.feed_candidates,
                    Text.compare,
                    firstCandidateKey,
                ) == null
            ) return null;
            let directCandidateKey = switch (
                value.direct_candidate_id
            ) {
                case null null;
                case (?candidateId) {
                    let key = candidateStableKey(candidateId);
                    if (
                        Map.get(
                            mem.feed_candidates,
                            Text.compare,
                            key,
                        ) == null
                    ) return null;
                    ?key;
                };
            };
            let minimumRetainUntil = addSaturating(
                value.created_at_ns,
                mem.retention.peer_records_ns,
            );
            let retainUntil = switch (
                Map.get(mem.verified_feed, Text.compare, feedKey)
            ) {
                case null minimumRetainUntil;
                case (?existing) {
                    Nat64.max(
                        existing.retain_until_ns,
                        minimumRetainUntil,
                    );
                };
            };
            ?{
                feed_key = feedKey;
                locator = {
                    author = value.key.author;
                    post_id = value.key.post_id;
                    body_hash = value.key.body_hash;
                    body_length = value.post.body_length;
                    object_digest = value.post.object_digest;
                    exact_certified_post_ref_candid =
                        value.post.exact_certified_post_ref_candid;
                    certified_ref = protocolPostRefToMemory(
                        value.post.certified_ref
                    );
                };
                first_candidate_key = firstCandidateKey;
                first_local_sequence = value.first_local_sequence;
                latest_local_sequence = value.latest_local_sequence;
                direct_candidate_key = directCandidateKey;
                status = switch (value.status) {
                    case (#active) #active;
                    case (#withdrawn(info)) {
                        #withdrawn({
                            tombstone_id = info.tombstone_id;
                            exact_tombstone_candid =
                                info.exact_tombstone_candid;
                            withdrawn_at_ns =
                                info.withdrawn_at_ns;
                        });
                    };
                };
                created_at_ns = value.created_at_ns;
                updated_at_ns = value.updated_at_ns;
                retain_until_ns = retainUntil;
                retained_bytes = verifiedFeedRetainedBytes(value);
            };
        };

        func feedAttributionMemory(
            value : FeedTypes.ShareAttribution
        ) : Memory.ShareAttribution {
            let feedKey = feedCanonicalStableKey(value.key);
            {
                attribution_key =
                    feedAttributionStableKey(value.key, value.sharer);
                feed_key = feedKey;
                sharer = value.sharer;
                share_id = value.share_id;
                share_object_digest = value.share_object_digest;
                candidate_key = candidateStableKey(value.candidate_id);
                exact_share_action_candid =
                    value.exact_share_action_candid;
                exact_share_ref_candid =
                    value.exact_share_ref_candid;
                verified_at_ns = value.verified_at_ns;
                retain_until_ns = addSaturating(
                    value.verified_at_ns,
                    mem.retention.peer_records_ns,
                );
                retained_bytes =
                    value.exact_share_action_candid.size() +
                    value.exact_share_ref_candid.size() + 384;
            };
        };

        func feedSuppressionMemory(
            value : FeedTypes.SuppressionRecord
        ) : ?Memory.SuppressionRecord {
            let candidateKey =
                candidateStableKey(value.source_candidate_id);
            if (
                Map.get(
                    mem.feed_candidates,
                    Text.compare,
                    candidateKey,
                ) == null
            ) return null;
            ?{
                suppression_key = feedCanonicalStableKey(value.key);
                author = value.key.author;
                post_id = value.key.post_id;
                body_hash = value.key.body_hash;
                tombstone_id = value.tombstone_id;
                exact_tombstone_candid =
                    value.exact_tombstone_candid;
                source_candidate_key = ?candidateKey;
                suppressed_at_ns = value.suppressed_at_ns;
                retain_until_ns = value.retain_until_ns;
                retained_bytes =
                    value.exact_tombstone_candid.size() + 384;
            };
        };

        func verifiedFeedRetainedBytes(
            value : FeedTypes.CanonicalRecord
        ) : Nat {
            value.post.exact_certified_post_ref_candid.size() + 640 +
            (
                switch (value.status) {
                    case (#active) 0;
                    case (#withdrawn(info)) {
                        info.exact_tombstone_candid.size();
                    };
                }
            );
        };

        func feedAttributionStableKey(
            key : FeedTypes.CanonicalKey,
            sharer : Principal,
        ) : Text {
            feedAttributionStableKeyForFeed(
                feedCanonicalStableKey(key),
                sharer,
            );
        };

        func feedAttributionStableKeyForFeed(
            feedKey : Text,
            sharer : Principal,
        ) : Text {
            "attribution:" # feedKey # ":" #
            Principal.toText(sharer);
        };

        // Attribution keys are ordered as attribution:<feed-key>:<sharer>.
        // One lower-bound lookup therefore proves whether the fixed-length
        // canonical feed key owns any live attribution without a full scan.
        func feedHasAttribution(feedKey : Text) : ?Bool {
            let prefix = "attribution:" # feedKey # ":";
            let entries = Map.entriesFrom(
                mem.share_attributions,
                Text.compare,
                prefix,
            );
            let ?(key, row) = entries.next() else return ?false;
            if (
                key != row.attribution_key or
                key !=
                    feedAttributionStableKeyForFeed(
                        row.feed_key,
                        row.sharer,
                    )
            ) return null;
            ?(row.feed_key == feedKey);
        };

        func feedRelayStableKey(
            tombstoneId : Blob,
            localShareId : Blob,
        ) : Text {
            "tombstone-relay:" # Path.hexLower(tombstoneId) # ":" #
            Path.hexLower(localShareId);
        };

        func planFeedTombstoneRelay(
            key : FeedTypes.CanonicalKey,
            suppression : Memory.SuppressionRecord,
        ) : FeedRelayPlanResult {
            let originalKey = originalPostStableKey(
                key.author,
                key.post_id,
            );
            let actionKey = switch (
                Map.get(
                    mem.shares_by_original_post,
                    Text.compare,
                    originalKey,
                )
            ) {
                case null return #none;
                case (?value) value;
            };
            let ?action = Map.get(
                mem.authored_actions,
                Text.compare,
                actionKey,
            ) else return #blocked;
            let share = switch (action.kind) {
                case (#share(value)) value;
                case (_) return #blocked;
            };
            switch (action.object_state, share.exact_delivery_candid) {
                case (#certified(_), ?_) {};
                case (_) return #none;
            };
            if (
                not Principal.equal(
                    share.action.original_author,
                    key.author,
                ) or
                not Blob.equal(
                    share.action.original_post_id,
                    key.post_id,
                ) or
                not Blob.equal(
                    share.action.original_body_hash,
                    key.body_hash,
                )
            ) return #blocked;
            let relayKey = feedRelayStableKey(
                suppression.tombstone_id,
                share.action.share_id,
            );
            if (
                Map.get(
                    mem.tombstone_relays,
                    Text.compare,
                    relayKey,
                ) != null
            ) return #none;
            // The bounded job scan resolves blocks, pauses, expiry, credits,
            // and the frozen cutoff. This counter is only its safe upper
            // bound at durable job admission.
            let eligible = mem.active_follower_count;
            if (eligible == 0) return #none;
            if (
                mem.fanout_sequence == Nat64.maxValue or
                mem.fanout_job_count >=
                    mem.quota_limits.fanout_job_count or
                mem.tombstone_relay_count >=
                    mem.quota_limits.tombstone_relay_count
            ) return #blocked;
            let fanoutBytes =
                suppression.exact_tombstone_candid.size() + 384;
            let relayBytes = 256;
            if (
                not quotaBytesAvailable(
                    mem.fanout_bytes,
                    0,
                    fanoutBytes,
                    mem.quota_limits.fanout_bytes,
                ) or
                not quotaBytesAvailable(
                    mem.tombstone_relay_bytes,
                    0,
                    relayBytes,
                    mem.quota_limits.tombstone_relay_bytes,
                )
            ) return #blocked;
            let fanoutId = mem.fanout_sequence + 1;
            if (
                Map.get(
                    mem.fanout_jobs,
                    Nat64.compare,
                    fanoutId,
                ) != null or
                Map.get(
                    mem.fanout_target_count_by_job,
                    Nat64.compare,
                    fanoutId,
                ) != null
            ) return #blocked;
            #planned({
                relay = {
                    relay_key = relayKey;
                    tombstone_id = suppression.tombstone_id;
                    local_share_id = share.action.share_id;
                    fanout_job_id = fanoutId;
                    created_at_ns = suppression.suppressed_at_ns;
                    retain_until_ns = suppression.retain_until_ns;
                    retained_bytes = relayBytes;
                };
                fanout = {
                    fanout_job_id = fanoutId;
                    kind = #tombstone_relay;
                    action_key = actionKey;
                    exact_event_candid =
                        suppression.exact_tombstone_candid;
                    follower_registration_cutoff =
                        mem.follower_registration_sequence;
                    after_registration_sequence = null;
                    state = #queued;
                    eligible_count = (0 : Nat32);
                    queued_count = (0 : Nat32);
                    completed_count = (0 : Nat32);
                    terminal_count = (0 : Nat32);
                    uncertain_count = (0 : Nat32);
                    created_at_ns = suppression.suppressed_at_ns;
                    updated_at_ns = suppression.suppressed_at_ns;
                    expires_at_ns = suppression.retain_until_ns;
                    retained_bytes = fanoutBytes;
                };
            });
        };

        func feedPromotionQuotaAvailable(
            _mutation : FeedTypes.PromotionCommit,
            canonical : ?Memory.VerifiedFeedRecord,
            attribution : ?Memory.ShareAttribution,
            suppression : ?Memory.SuppressionRecord,
            relay : ?FeedRelayPlan,
        ) : Bool {
            switch (canonical) {
                case null {};
                case (?row) {
                    let previous = Map.get(
                        mem.verified_feed,
                        Text.compare,
                        row.feed_key,
                    );
                    if (
                        previous == null and
                        mem.verified_feed_count >=
                            mem.quota_limits.verified_feed_count
                    ) return false;
                    let previousBytes = switch (previous) {
                        case null 0;
                        case (?value) value.retained_bytes;
                    };
                    if (
                        not quotaBytesAvailable(
                            mem.verified_feed_bytes,
                            previousBytes,
                            row.retained_bytes,
                            mem.quota_limits.verified_feed_bytes,
                        )
                    ) return false;
                };
            };
            switch (attribution) {
                case null {};
                case (?row) {
                    if (
                        mem.share_attribution_count >=
                            mem.quota_limits.share_attribution_count or
                        not quotaBytesAvailable(
                            mem.share_attribution_bytes,
                            0,
                            row.retained_bytes,
                            mem.quota_limits.share_attribution_bytes,
                        )
                    ) return false;
                };
            };
            switch (suppression) {
                case null {};
                case (?row) {
                    let previous = Map.get(
                        mem.suppressions,
                        Text.compare,
                        row.suppression_key,
                    );
                    if (
                        previous == null and
                        mem.suppression_count >=
                            mem.quota_limits.suppression_count
                    ) return false;
                    let previousBytes = switch (previous) {
                        case null 0;
                        case (?value) value.retained_bytes;
                    };
                    if (
                        not quotaBytesAvailable(
                            mem.suppression_bytes,
                            previousBytes,
                            row.retained_bytes,
                            mem.quota_limits.suppression_bytes,
                        )
                    ) return false;
                };
            };
            switch (relay) {
                case null {};
                case (?plan) {
                    if (
                        mem.tombstone_relay_count >=
                            mem.quota_limits.tombstone_relay_count or
                        mem.fanout_job_count >=
                            mem.quota_limits.fanout_job_count or
                        not quotaBytesAvailable(
                            mem.tombstone_relay_bytes,
                            0,
                            plan.relay.retained_bytes,
                            mem.quota_limits.tombstone_relay_bytes,
                        ) or
                        not quotaBytesAvailable(
                            mem.fanout_bytes,
                            0,
                            plan.fanout.retained_bytes,
                            mem.quota_limits.fanout_bytes,
                        )
                    ) return false;
                };
            };
            true;
        };

        func quotaBytesAvailable(
            current : Nat,
            previous : Nat,
            replacement : Nat,
            limit : Nat,
        ) : Bool {
            current >= previous and
            replacement <= limit and
            current - previous <= limit - replacement;
        };

        func applyFeedCanonicalRow(
            row : Memory.VerifiedFeedRecord
        ) {
            let slotKey = feedPostSlotStableKey(
                row.locator.author,
                row.locator.post_id,
            );
            let previous = Map.get(
                mem.verified_feed,
                Text.compare,
                row.feed_key,
            );
            switch (
                previous,
                Map.get(
                    mem.verified_feed_by_post_slot,
                    Text.compare,
                    slotKey,
                ),
            ) {
                case (null, null) {};
                case (?_, ?indexed) {
                    if (indexed != row.feed_key) Runtime.trap(
                        "Wagyu verified feed slot changed during promotion"
                    );
                };
                case (_) Runtime.trap(
                    "Wagyu verified feed slot index changed during promotion"
                );
            };
            let previousBytes = switch (previous) {
                case null 0;
                case (?value) value.retained_bytes;
            };
            Map.add(
                mem.verified_feed,
                Text.compare,
                row.feed_key,
                row,
            );
            Map.add(
                mem.verified_feed_by_post_slot,
                Text.compare,
                slotKey,
                row.feed_key,
            );
            if (previous == null) mem.verified_feed_count += 1;
            mem.verified_feed_bytes :=
                mem.verified_feed_bytes - previousBytes +
                row.retained_bytes;
        };

        func applyFeedSuppressionRow(
            row : Memory.SuppressionRecord
        ) {
            let previous = Map.get(
                mem.suppressions,
                Text.compare,
                row.suppression_key,
            );
            let previousBytes = switch (previous) {
                case null 0;
                case (?value) value.retained_bytes;
            };
            Map.add(
                mem.suppressions,
                Text.compare,
                row.suppression_key,
                row,
            );
            if (previous == null) mem.suppression_count += 1;
            mem.suppression_bytes :=
                mem.suppression_bytes - previousBytes +
                row.retained_bytes;
        };

        func feedPromotionRetentionPlan(
            mutation : FeedTypes.PromotionCommit,
            canonical : ?Memory.VerifiedFeedRecord,
            attribution : ?Memory.ShareAttribution,
            suppression : ?Memory.SuppressionRecord,
            relay : ?FeedRelayPlan,
        ) : FeedRetentionPlanResult {
            let requests =
                List.empty<RetentionTypes.RegistrationRequest>();
            let candidateKeys = List.empty<Text>();
            switch (canonical) {
                case null {};
                case (?row) {
                    addUniqueText(
                        candidateKeys,
                        row.first_candidate_key,
                    );
                    switch (row.direct_candidate_key) {
                        case null {};
                        case (?key) addUniqueText(candidateKeys, key);
                    };
                };
            };
            switch (attribution) {
                case null {};
                case (?row) {
                    addUniqueText(candidateKeys, row.candidate_key);
                };
            };
            switch (suppression) {
                case null {};
                case (?row) {
                    switch (row.source_candidate_key) {
                        case null {};
                        case (?key) addUniqueText(candidateKeys, key);
                    };
                };
            };

            for (candidateKey in List.values(candidateKeys)) {
                let ?candidate = Map.get(
                    mem.feed_candidates,
                    Text.compare,
                    candidateKey,
                ) else return #blocked;
                let record : Memory.RetentionRecordRef =
                    #feed_candidate(candidateKey);
                List.add(requests, {
                    view = #feed_candidate({
                        candidate_key = candidateKey;
                        received_at_ns = candidate.received_at_ns;
                        retain_until_ns = candidate.retain_until_ns;
                        retained_bytes = candidate.retained_bytes;
                        local_sequence = candidate.local_sequence;
                        immediate_sender = candidate.immediate_sender;
                        unread =
                            Map.get(
                                mem.unread_feed_candidates,
                                Text.compare,
                                candidateKey,
                            ) != null and
                            not nat64ArrayContains(
                                mutation.hide_sequences,
                                candidate.local_sequence,
                            );
                        dependents_detached = false;
                    });
                    expected_previous =
                        currentRetentionEntry(record);
                });
            };

            switch (canonical) {
                case null {};
                case (?row) {
                    var hasDependents =
                        Map.get(
                            mem.suppressions,
                            Text.compare,
                            row.feed_key,
                        ) != null;
                    if (not hasDependents) {
                        let ?hasAttribution =
                            feedHasAttribution(row.feed_key)
                        else return #blocked;
                        hasDependents := hasAttribution;
                    };
                    switch (attribution) {
                        case (?value) if (
                            value.feed_key == row.feed_key
                        ) hasDependents := true;
                        case (_) {};
                    };
                    switch (suppression) {
                        case (?value) if (
                            value.suppression_key == row.feed_key
                        ) hasDependents := true;
                        case (_) {};
                    };
                    let record : Memory.RetentionRecordRef =
                        #verified_feed(row.feed_key);
                    List.add(requests, {
                        view = #verified_feed({
                            feed_key = row.feed_key;
                            created_at_ns = row.created_at_ns;
                            retain_until_ns = row.retain_until_ns;
                            retained_bytes = row.retained_bytes;
                            dependents_detached = not hasDependents;
                        });
                        expected_previous =
                            currentRetentionEntry(record);
                    });
                };
            };
            switch (attribution) {
                case null {};
                case (?row) {
                    let record : Memory.RetentionRecordRef =
                        #share_attribution(row.attribution_key);
                    List.add(requests, {
                        view = #share_attribution({
                            attribution_key = row.attribution_key;
                            verified_at_ns = row.verified_at_ns;
                            retain_until_ns = row.retain_until_ns;
                            retained_bytes = row.retained_bytes;
                            feed_key = row.feed_key;
                            candidate_key = row.candidate_key;
                        });
                        expected_previous =
                            currentRetentionEntry(record);
                    });
                };
            };
            switch (suppression) {
                case null {};
                case (?row) {
                    let record : Memory.RetentionRecordRef =
                        #suppression(row.suppression_key);
                    List.add(requests, {
                        view = #suppression({
                            suppression_key = row.suppression_key;
                            suppressed_at_ns = row.suppressed_at_ns;
                            retain_until_ns = row.retain_until_ns;
                            retained_bytes = row.retained_bytes;
                            source_candidate_key =
                                row.source_candidate_key;
                        });
                        expected_previous =
                            currentRetentionEntry(record);
                    });
                };
            };
            switch (relay) {
                case null {};
                case (?plan) {
                    let relayRecord : Memory.RetentionRecordRef =
                        #tombstone_relay(plan.relay.relay_key);
                    List.add(requests, {
                        view = #tombstone_relay({
                            relay_key = plan.relay.relay_key;
                            created_at_ns =
                                plan.relay.created_at_ns;
                            retain_until_ns =
                                plan.relay.retain_until_ns;
                            retained_bytes =
                                plan.relay.retained_bytes;
                            fanout_job_id =
                                plan.relay.fanout_job_id;
                            fanout_detached = false;
                        });
                        expected_previous =
                            currentRetentionEntry(relayRecord);
                    });
                    let fanoutRecord : Memory.RetentionRecordRef =
                        #fanout_job(plan.fanout.fanout_job_id);
                    List.add(requests, {
                        view = #fanout_job({
                            fanout_job_id =
                                plan.fanout.fanout_job_id;
                            created_at_ns =
                                plan.fanout.created_at_ns;
                            expires_at_ns =
                                plan.fanout.expires_at_ns;
                            cleanup_at_ns =
                                plan.fanout.expires_at_ns;
                            retained_bytes =
                                plan.fanout.retained_bytes;
                            targets_detached = false;
                        });
                        expected_previous =
                            currentRetentionEntry(fanoutRecord);
                    });
                };
            };
            if (List.size(requests) == 0) return #none;
            switch (
                RetentionService.prepareRegistrations(
                    {
                        peer_records_ns =
                            mem.retention.peer_records_ns;
                        likes_ns = mem.retention.likes_ns;
                        rate_window_ns =
                            mem.retention.rate_window_ns;
                    },
                    mem.retention_sequence,
                    List.toArray(requests),
                )
            ) {
                case (#ok(plan)) #planned(plan);
                case (#err(_)) #blocked;
            };
        };

        func textListContains(
            values : List.List<Text>,
            target : Text,
        ) : Bool {
            for (value in List.values(values)) {
                if (value == target) return true;
            };
            false;
        };

        func textArrayContains(values : [Text], target : Text) : Bool {
            for (value in values.vals()) {
                if (value == target) return true;
            };
            false;
        };

        func textArrayOccurrences(values : [Text], target : Text) : Nat {
            var count = 0;
            for (value in values.vals()) {
                if (value == target) count += 1;
            };
            count;
        };

        func removeFeedCandidateClaimedSlotIndex(
            row : Memory.FeedCandidate
        ) {
            let slotKey = feedPostSlotStableKey(
                row.claimed_author,
                row.claimed_post_id,
            );
            let ?current = Map.get(
                mem.feed_candidates_by_claimed_slot,
                Text.compare,
                slotKey,
            ) else Runtime.trap(
                "Wagyu claimed feed slot disappeared during cleanup"
            );
            if (
                textArrayOccurrences(current, row.candidate_key) != 1
            ) Runtime.trap(
                "Wagyu claimed feed slot is corrupt during cleanup"
            );
            let retained = Array.filter<Text>(
                current,
                func(key) { key != row.candidate_key },
            );
            if (retained.size() == 0) {
                Map.remove(
                    mem.feed_candidates_by_claimed_slot,
                    Text.compare,
                    slotKey,
                );
            } else {
                Map.add(
                    mem.feed_candidates_by_claimed_slot,
                    Text.compare,
                    slotKey,
                    retained,
                );
            };
        };

        func textPairListContains(
            values : List.List<(Nat64, Text)>,
            sequence : Nat64,
            key : Text,
        ) : Bool {
            for ((currentSequence, currentKey) in List.values(values)) {
                if (
                    currentSequence == sequence or
                    currentKey == key
                ) return true;
            };
            false;
        };

        func addUniqueText(
            values : List.List<Text>,
            value : Text,
        ) {
            if (not textListContains(values, value)) {
                List.add(values, value);
            };
        };

        func nat64ArrayContains(
            values : [Nat64],
            target : Nat64,
        ) : Bool {
            for (value in values.vals()) {
                if (value == target) return true;
            };
            false;
        };

        func ingressState() : IngressTypes.State {
            {
                receipt = func(
                    key : IngressTypes.ReceiptKey
                ) : ?IngressTypes.Receipt {
                    let stableKey = ingressReceiptStableKey(key);
                    let ?value = Map.get(
                        mem.ingress_receipts,
                        Text.compare,
                        stableKey,
                    ) else return null;
                    let storedRoute =
                        memoryRouteToIngress(value.route);
                    let storedResult =
                        memoryRouteToProtocol(value.result);
                    if (
                        value.receipt_key != stableKey or
                        not Principal.equal(
                            value.caller,
                            key.caller,
                        ) or
                        storedRoute != key.route or
                        not Blob.equal(
                            value.operation_id,
                            key.operation_id,
                        ) or
                        not Blob.equal(
                            value.exact_result_candid,
                            IngressService.encodeRouteResult(
                                storedRoute,
                                storedResult,
                            ),
                        )
                    ) return null;
                    ?{
                        key = {
                            caller = value.caller;
                            route = storedRoute;
                            operation_id = value.operation_id;
                        };
                        stable_key = value.receipt_key;
                        payload_digest = value.payload_digest;
                        result = storedResult;
                        exact_result_candid =
                            value.exact_result_candid;
                        received_at_ns = value.received_at_ns;
                        retain_until_ns = value.retain_until_ns;
                        retained_bytes = value.retained_bytes;
                    };
                };
                receipt_stable_key = ingressReceiptStableKey;
                candidate_stable_key = candidateStableKey;
                rate_window = func(
                    caller : Principal,
                    route : IngressTypes.Route,
                ) : ?IngressTypes.RateWindow {
                    let stableKey = ingressRateWindowStableKey(
                        caller,
                        route,
                    );
                    let ?value = Map.get(
                        mem.caller_rate_windows,
                        Text.compare,
                        stableKey,
                    ) else return null;
                    ?memoryRateWindowToIngress(value);
                };
                rate_window_stable_key =
                    ingressRateWindowStableKey;
                relationships = relationshipState();
                feed = ingressFeedStore();
                notifications = ingressNotificationStore();
                like_target = ingressLikeTarget;
                authored_post_target = ingressAuthoredPostTarget;
                preflight = canCommitIngress;
                commit_atomic = commitIngressAtomic;
            };
        };

        func ingressReceiptStableKey(
            key : IngressTypes.ReceiptKey
        ) : Text {
            ingressReceiptKey(
                key.caller,
                ingressRouteToMemory(key.route),
                key.operation_id,
            );
        };

        func ingressRateWindowStableKey(
            caller : Principal,
            route : IngressTypes.Route,
        ) : Text {
            "rate:" # Principal.toText(caller) # ":" #
            ingressRouteText(route);
        };

        func ingressRouteText(route : IngressTypes.Route) : Text {
            switch (route) {
                case (#follow) "follow";
                case (#unfollow) "unfollow";
                case (#deliver) "deliver";
                case (#like) "like";
                case (#notice) "notice";
            };
        };

        func ingressRouteToMemory(
            route : IngressTypes.Route
        ) : Memory.IngressRoute {
            switch (route) {
                case (#follow) #follow;
                case (#unfollow) #unfollow;
                case (#deliver) #deliver;
                case (#like) #like;
                case (#notice) #notice;
            };
        };

        func memoryRouteToIngress(
            route : Memory.IngressRoute
        ) : IngressTypes.Route {
            switch (route) {
                case (#follow) #follow;
                case (#unfollow) #unfollow;
                case (#deliver) #deliver;
                case (#like) #like;
                case (#notice) #notice;
            };
        };

        func memoryRateWindowToIngress(
            value : Memory.CallerRateWindow
        ) : IngressTypes.RateWindow {
            {
                caller = value.caller;
                route = memoryRouteToIngress(value.route);
                window_started_at_ns = value.window_started_at_ns;
                accepted_count = value.accepted_count;
                semantic_notice_count = value.semantic_notice_count;
                expires_at_ns = value.expires_at_ns;
                retained_bytes = value.retained_bytes;
            };
        };

        func ingressLikeTarget(
            postId : Blob,
            liker : Principal,
        ) : ?IngressTypes.LikeTarget {
            let postKey = postStableKey(postId);
            let ?post = Map.get(
                mem.authored_posts,
                Text.compare,
                postKey,
            ) else return null;
            switch (
                post.object_state,
                post.exact_certified_ref_candid,
            ) {
                case (#certified(_), ?_) {};
                case (_) return null;
            };
            let ?head = Map.get(
                mem.like_heads,
                Text.compare,
                post.like_head_key,
            ) else return null;
            let ?likeState = Map.get(
                mem.like_states,
                Text.compare,
                postKey,
            ) else return null;
            let ?segments = memoryLikeSegments(likeState)
            else return null;
            let nextAccepted =
                if (mem.accepted_like_sequence == Nat64.maxValue) {
                    Nat64.maxValue;
                } else {
                    mem.accepted_like_sequence + 1;
                };
            let existingDigest = switch (
                Map.get(
                    mem.accepted_likes,
                    Text.compare,
                    acceptedLikeStableKey(postId, liker),
                )
            ) {
                case null null;
                case (?value) {
                    ?Hash.sha256(
                        value.exact_certified_like_receipt_candid
                    );
                };
            };
            let live = switch (post.status) {
                case (#live) true;
                case (_) false;
            };
            ?{
                post_key = postKey;
                post_author = node;
                post_id = post.post_id;
                post_body_hash = post.body_hash;
                accepting_likes =
                    live and head.value.accepting_likes;
                unsealed_receipt_count =
                    likeState.unsealed_receipt_count;
                unsealed_receipt_limit =
                    mem.quota_limits.unsealed_receipts_per_post;
                next_accepted_sequence = nextAccepted;
                existing_receipt_digest = existingDigest;
                segments;
            };
        };

        func ingressAuthoredPostTarget(
            postId : Blob
        ) : ?IngressTypes.AuthoredPostTarget {
            let postKey = postStableKey(postId);
            let ?post = Map.get(
                mem.authored_posts,
                Text.compare,
                postKey,
            ) else return null;
            let live = switch (
                post.status,
                post.object_state,
                post.exact_certified_ref_candid,
            ) {
                case (#live, #certified(_), ?_) true;
                case (_) false;
            };
            ?{
                post_key = postKey;
                post_author = node;
                post_id = post.post_id;
                post_body_hash = post.body_hash;
                live;
            };
        };

        func memoryLikeSegments(
            value : Memory.PostLikeState
        ) : ?LikeAdmission.Segments {
            let ?active = memoryLikeSegment(value.active_segment)
            else return null;
            let due = switch (value.due_segment) {
                case null null;
                case (?segment) {
                    let ?rows = memoryLikeSegment(segment)
                    else return null;
                    ?rows;
                };
            };
            ?{ due; active };
        };

        func memoryLikeSegment(
            value : Memory.LikeSegment
        ) : ?[LikeAdmission.AcceptedLike] {
            let rows = List.empty<LikeAdmission.AcceptedLike>();
            for (key in value.accepted_like_keys.vals()) {
                let ?stored = Map.get(
                    mem.accepted_likes,
                    Text.compare,
                    key,
                ) else return null;
                let ?notification = Map.get(
                    mem.notifications,
                    Nat64.compare,
                    stored.notification_sequence,
                ) else return null;
                if (
                    not acceptedLikeNotificationVerified(
                        key,
                        stored,
                        notification,
                    )
                ) return null;
                let ?receipt = Wire.decodeCertifiedLikeReceipt(
                    stored.exact_certified_like_receipt_candid
                ) else return null;
                if (
                    not Blob.equal(
                        receipt.like_action_candid,
                        stored.exact_like_action_candid,
                    )
                ) return null;
                List.add(rows, {
                    accepted_sequence = stored.accepted_sequence;
                    accepted_at_ns = stored.accepted_at_ns;
                    liker = stored.liker;
                    like_id = stored.like_id;
                    receipt;
                    exact_receipt_candid =
                        stored.exact_certified_like_receipt_candid;
                    receipt_digest = Hash.sha256(
                        stored.exact_certified_like_receipt_candid
                    );
                });
            };
            let result = List.toArray(rows);
            if (
                result.size() != Nat16.toNat(value.receipt_count)
            ) return null;
            ?result;
        };

        func acceptedLikeNotificationVerified(
            acceptedKey : Text,
            accepted : Memory.AcceptedLike,
            notification : Memory.NotificationSummary,
        ) : Bool {
            switch (
                notification.kind,
                notification.verification,
                Map.get(
                    mem.notification_evidence,
                    Nat64.compare,
                    accepted.notification_sequence,
                ),
            ) {
                case (
                    ?#like(info),
                    ?#verified,
                    ?#like(evidence),
                ) {
                    notification.local_sequence ==
                        accepted.notification_sequence and
                    Principal.equal(
                        notification.actor_,
                        accepted.liker,
                    ) and
                    Blob.equal(
                        info.target_post_id,
                        accepted.post_id,
                    ) and
                    Blob.equal(
                        info.target_body_hash,
                        accepted.post_body_hash,
                    ) and
                    Blob.equal(info.action_id, accepted.like_id) and
                    Blob.equal(
                        info.object_digest,
                        accepted.object_digest,
                    ) and
                    info.object_length == accepted.body_length and
                    evidence.accepted_like_key == acceptedKey and
                    Blob.equal(
                        evidence.exact_certified_like_receipt_candid,
                        accepted.exact_certified_like_receipt_candid,
                    );
                };
                case (_) false;
            };
        };

        func acceptedLikeStableKey(
            postId : Blob,
            liker : Principal,
        ) : Text {
            "accepted-like:" # Path.hexLower(postId) # ":" #
            Principal.toText(liker);
        };

        func canCommitIngress(
            plan : IngressTypes.CommitPlan
        ) : Bool {
            if (
                mem.state_revision == Nat64.maxValue or
                not IngressService.validCommitPlanAccounting(plan) or
                not validIngressDomainShape(plan) or
                not canCommitIngressReceipt(plan.receipt) or
                not canCommitIngressRate(plan.rate) or
                not canCommitIngressFollower(
                    plan.domain.follower,
                    plan.domain.notification,
                    plan.receipt.received_at_ns,
                ) or
                not canCommitIngressFollowing(
                    plan.domain.following,
                    plan.receipt,
                ) or
                not canCommitIngressFeed(
                    plan.domain.feed,
                    plan.receipt,
                ) or
                not canCommitIngressNotification(
                    plan.domain.notification,
                    plan.domain.like,
                    plan.rate,
                ) or
                not canCommitIngressLike(
                    plan.domain.like,
                    plan.domain.notification,
                )
            ) return false;
            let ?retention = ingressRetentionPlan(plan)
            else return false;
            canApplyRetentionRegistration(retention);
        };

        func validIngressDomainShape(
            plan : IngressTypes.CommitPlan
        ) : Bool {
            let domain = plan.domain;
            switch (plan.rate) {
                case (?rate) {
                    if (
                        rate.replacement.route !=
                            plan.receipt.key.route or
                        not Principal.equal(
                            rate.replacement.caller,
                            plan.receipt.key.caller,
                        )
                    ) return false;
                };
                case null {};
            };
            if (ingressDomainEmpty(domain)) return true;
            switch (plan.receipt.key.route) {
                case (#follow) {
                    let ?follower = domain.follower
                        else return false;
                    Principal.equal(
                        follower.node,
                        plan.receipt.key.caller,
                    ) and
                    domain.following == null and
                    domain.feed == null and
                    domain.like == null;
                };
                case (#unfollow) {
                    let ?follower = domain.follower
                        else return false;
                    Principal.equal(
                        follower.node,
                        plan.receipt.key.caller,
                    ) and
                    domain.following == null and
                    domain.feed == null and
                    domain.notification == null and
                    domain.like == null;
                };
                case (#deliver) {
                    let ?following = domain.following
                        else return false;
                    let ?feed = domain.feed else return false;
                    Principal.equal(
                        following.node,
                        plan.receipt.key.caller,
                    ) and
                    Principal.equal(
                        feed.candidate.immediate_sender,
                        plan.receipt.key.caller,
                    ) and
                    domain.follower == null and
                    domain.notification == null and
                    domain.like == null;
                };
                case (#like) {
                    let ?notification = domain.notification
                        else return false;
                    Principal.equal(
                        notification.append.stored.summary.actor_,
                        plan.receipt.key.caller,
                    ) and
                    domain.follower == null and
                    domain.following == null and
                    domain.feed == null and
                    // Certified Like evidence remains quarantined in its
                    // pending notification until the owner browser verifies
                    // it. Ingress must not mutate AcceptedLike or sealable
                    // segments.
                    domain.like == null;
                };
                case (#notice) {
                    let ?notification = domain.notification
                        else return false;
                    Principal.equal(
                        notification.append.stored.summary.actor_,
                        plan.receipt.key.caller,
                    ) and
                    domain.follower == null and
                    domain.following == null and
                    domain.feed == null and
                    domain.like == null;
                };
            };
        };

        func ingressDomainEmpty(
            domain : IngressTypes.DomainMutation
        ) : Bool {
            domain.follower == null and
            domain.following == null and
            domain.feed == null and
            domain.notification == null and
            domain.like == null;
        };

        func canCommitIngressFollowing(
            change : ?RelationshipTypes.FollowingMutation,
            receipt : IngressTypes.Receipt,
        ) : Bool {
            let ?mutation = change else return true;
            if (receipt.key.route != #deliver) return false;
            let ?expected = mutation.expected_storage_revision
                else return false;
            let ?current = Map.get(
                mem.following,
                Principal.compare,
                mutation.node,
            ) else return false;
            let next = mutation.next_row;
            Principal.equal(mutation.node, next.node) and
            Principal.equal(receipt.key.caller, next.node) and
            current.storage_revision == expected and
            expected != Nat64.maxValue and
            next.storage_revision == expected + 1 and
            next.intent_generation == current.intent_generation and
            next.intent == current.intent and
            next.last_remote_revision == current.last_remote_revision and
            next.locally_verified_delivery_count ==
                followingView(current).locally_verified_delivery_count and
            // A delivery may only persist the sticky renewal hint. It must
            // not rewrite locally derived delivery accounting or the
            // timestamp of the paid Follow state.
            next.updated_at_ns == current.updated_at_ns and
            mem.relationship_revision != Nat64.maxValue;
        };

        func canCommitIngressReceipt(
            value : IngressTypes.Receipt
        ) : Bool {
            let expectedKey = ingressReceiptStableKey(value.key);
            let exact = IngressService.encodeRouteResult(
                value.key.route,
                value.result,
            );
            let maximum = Bounds.routeById(
                ingressRouteToBounds(value.key.route)
            ).max_response_bytes;
            value.stable_key == expectedKey and
            value.key.operation_id.size() == Bounds.OPERATION_ID_BYTES and
            value.payload_digest.size() == Bounds.HASH_BYTES and
            exact.size() > 0 and exact.size() <= maximum and
            Blob.equal(exact, value.exact_result_candid) and
            value.retained_bytes > 0 and
            Map.get(
                mem.ingress_receipts,
                Text.compare,
                expectedKey,
            ) == null and
            mem.ingress_receipt_count <
                mem.quota_limits.ingress_receipt_count and
            mem.ingress_receipt_bytes + value.retained_bytes <=
                MAX_INGRESS_RECEIPT_BYTES;
        };

        func ingressRouteToBounds(
            route : IngressTypes.Route
        ) : Bounds.RouteIdV1 {
            switch (route) {
                case (#follow) #follow;
                case (#unfollow) #unfollow;
                case (#deliver) #deliver;
                case (#like) #like;
                case (#notice) #notice;
            };
        };

        func canCommitIngressRate(
            change : ?IngressTypes.RateMutation
        ) : Bool {
            let ?mutation = change else return true;
            if (
                mutation.stable_key != ingressRateWindowStableKey(
                    mutation.replacement.caller,
                    mutation.replacement.route,
                ) or
                mutation.replacement.retained_bytes == 0 or
                mutation.replacement.window_started_at_ns >
                    mutation.replacement.expires_at_ns or
                mutation.replacement.expires_at_ns -
                    mutation.replacement.window_started_at_ns !=
                    IngressService.HOUR_NS
            ) return false;
            let current = switch (
                Map.get(
                    mem.caller_rate_windows,
                    Text.compare,
                    mutation.stable_key,
                )
            ) {
                case null null;
                case (?value) ?memoryRateWindowToIngress(value);
            };
            if (current != mutation.expected) return false;
            let currentBytes = switch (current) {
                case null 0;
                case (?value) value.retained_bytes;
            };
            if (
                current == null and
                mem.caller_rate_window_count >=
                    mem.quota_limits.caller_rate_window_count
            ) return false;
            if (
                mutation.replacement.retained_bytes > currentBytes and
                mem.caller_rate_window_bytes +
                    (
                        mutation.replacement.retained_bytes -
                        currentBytes
                    ) >
                    mem.quota_limits.caller_rate_window_bytes
            ) return false;
            true;
        };

        func canCommitIngressFollower(
            change : ?RelationshipTypes.FollowerMutation,
            notification : ?IngressTypes.NotificationMutation,
            receivedAt : Nat64,
        ) : Bool {
            switch (change) {
                case null {
                    switch (notification) {
                        case (?value) {
                            switch (value.append.semantic_key) {
                                case (#new_follower(_)) return false;
                                case (_) {};
                            };
                        };
                        case null {};
                    };
                    true;
                };
                case (?mutation) {
                    let core = {
                        mutation with
                        new_follower_summary = null;
                    };
                    if (not canCommitFollowerMutation(core)) {
                        return false;
                    };
                    switch (
                        mutation.new_follower_summary,
                        notification,
                    ) {
                        case (null, null) true;
                        case (?summary, ?notice) {
                            let stored = notice.append.stored.summary;
                            let semantic = notice.append.semantic_key;
                            Principal.equal(summary.node, mutation.node) and
                            summary.received_at_ns == receivedAt and
                            summary.resulting_revision ==
                                mutation.next_row.head_revision and
                            Principal.equal(
                                stored.actor_,
                                mutation.node,
                            ) and
                            stored.received_at_ns == receivedAt and
                            stored.kind == ?#new_follower({
                                follower_revision =
                                    mutation.next_row.head_revision;
                            }) and
                            semantic == #new_follower({
                                acting_node = mutation.node;
                                follower_revision =
                                    mutation.next_row.head_revision;
                            });
                        };
                        case (_) false;
                    };
                };
            };
        };

        func canCommitIngressFeed(
            change : ?FeedTypes.AdmissionCommit,
            receipt : IngressTypes.Receipt,
        ) : Bool {
            let ?mutation = change else return true;
            let candidate = mutation.candidate;
            let transport = mutation.transport;
            let claimedSlot = switch (
                Map.get(
                    mem.feed_candidates_by_claimed_slot,
                    Text.compare,
                    feedPostSlotStableKey(
                        candidate.claimed_author,
                        candidate.claimed_post_id,
                    ),
                )
            ) {
                case null [];
                case (?value) value;
            };
            if (
                mutation.expected != ingressFeedStore().snapshot() or
                mutation.revision != mutation.expected.revision + 1 or
                candidate.local_sequence !=
                    mutation.expected.last_sequence + 1 or
                candidate.candidate_key !=
                    candidateStableKey(candidate.candidate_id) or
                candidate.retained_bytes == 0 or
                candidate.exact_event_candid.size() == 0 or
                candidate.exact_event_candid.size() >
                    FeedTypes.MAX_DELIVERY_EVENT_BYTES or
                receipt.key.route != #deliver or
                not Principal.equal(
                    receipt.key.caller,
                    candidate.immediate_sender,
                ) or
                not Blob.equal(
                    receipt.key.operation_id,
                    candidate.operation_id,
                ) or
                not Blob.equal(
                    receipt.payload_digest,
                    candidate.payload_digest,
                ) or
                receipt.stable_key != candidate.route_receipt_key or
                not Principal.equal(
                    transport.key.immediate_sender,
                    candidate.immediate_sender,
                ) or
                not Blob.equal(
                    transport.key.operation_id,
                    candidate.operation_id,
                ) or
                not Blob.equal(
                    transport.payload_digest,
                    candidate.payload_digest,
                ) or
                not Blob.equal(
                    transport.candidate_id,
                    candidate.candidate_id,
                ) or
                transport.candidate_key != candidate.candidate_key or
                transport.accepted_revision != mutation.revision or
                Map.get(
                    mem.feed_candidates,
                    Text.compare,
                    candidate.candidate_key,
                ) != null or
                Map.get(
                    mem.feed_order,
                    Nat64.compare,
                    candidate.local_sequence,
                ) != null or
                mem.candidate_count >=
                    mem.quota_limits.candidate_count or
                mem.candidate_bytes + candidate.retained_bytes >
                    mem.quota_limits.candidate_bytes or
                ingressFeedStore().count_for_sender(
                    candidate.immediate_sender
                ) >= mem.quota_limits.candidates_per_sender or
                claimedSlot.size() >=
                    FeedTypes.MAX_CANDIDATES_PER_CLAIMED_SLOT or
                textArrayContains(
                    claimedSlot,
                    candidate.candidate_key,
                )
            ) return false;
            true;
        };

        func canCommitIngressNotification(
            change : ?IngressTypes.NotificationMutation,
            like : ?IngressTypes.LikeMutation,
            rate : ?IngressTypes.RateMutation,
        ) : Bool {
            let ?mutation = change else return like == null;
            let append = mutation.append;
            let summary = append.stored.summary;
            let evidenceBytes = switch (append.stored.like_evidence) {
                case null 0;
                case (?value) value.size();
            };
            if (
                append.expected != ingressNotificationStore().snapshot() or
                append.revision != append.expected.revision + 1 or
                summary.local_sequence !=
                    append.expected.last_sequence + 1 or
                summary.local_sequence == 0 or
                summary.kind == null or
                summary.verification == null or
                summary.read or
                mutation.retained_bytes !=
                    evidenceBytes +
                    INGRESS_NOTIFICATION_ACCOUNTING_OVERHEAD or
                Map.get(
                    mem.notification_by_semantic,
                    Text.compare,
                    notificationSemanticStableKey(
                        append.semantic_key
                    ),
                ) != null or
                Map.get(
                    mem.notifications,
                    Nat64.compare,
                    summary.local_sequence,
                ) != null or
                Map.get(
                    mem.notification_evidence,
                    Nat64.compare,
                    summary.local_sequence,
                ) != null or
                mem.notification_count >=
                    mem.quota_limits.notification_count or
                mem.notification_bytes + mutation.retained_bytes >
                    mem.quota_limits.notification_bytes
            ) return false;
            switch (append.semantic_key, summary.kind) {
                case (
                    #new_follower(key),
                    ?#new_follower(info),
                ) {
                    append.stored.like_evidence == null and
                    Principal.equal(key.acting_node, summary.actor_) and
                    key.follower_revision ==
                        info.follower_revision and
                    summary.verification ==
                        ?#transport_authenticated;
                };
                case (#like(key), ?#like(info)) {
                    let ?evidence = append.stored.like_evidence
                        else return false;
                    let ?receipt =
                        Wire.decodeCertifiedLikeReceipt(evidence)
                        else return false;
                    let ?action = Wire.decodeLikeAction(
                        receipt.like_action_candid
                    ) else return false;
                    let ?target = ingressLikeTarget(
                        info.target_post_id,
                        summary.actor_,
                    ) else return false;
                    let ?likeState = Map.get(
                        mem.like_states,
                        Text.compare,
                        target.post_key,
                    ) else return false;
                    let receiptValid = switch (
                        LikeAdmission.validateReceipt({
                            caller = summary.actor_;
                            network_id =
                                currentProfile().network_id;
                            post_author = target.post_author;
                            post_id = target.post_id;
                            post_body_hash =
                                target.post_body_hash;
                            action;
                            receipt;
                            exact_receipt_candid = evidence;
                        })
                    ) {
                        case (#ok(_)) true;
                        case (#err(_)) false;
                    };
                    like == null and
                    receiptValid and
                    target.accepting_likes and
                    likeState.structurally_accepted_count !=
                        Nat64.maxValue and
                    target.existing_receipt_digest == null and
                    Nat16.toNat(target.unsealed_receipt_count) <
                        Nat16.toNat(target.unsealed_receipt_limit) and
                    Principal.equal(key.acting_node, summary.actor_) and
                    Blob.equal(
                        key.target_post_id,
                        info.target_post_id,
                    ) and
                    Blob.equal(
                        action.like_id,
                        info.action_id,
                    ) and
                    Blob.equal(
                        receipt.ref.object_digest,
                        info.object_digest,
                    ) and
                    receipt.ref.body_length ==
                        info.object_length and
                    summary.verification == ?#pending;
                };
                case (#notice(key), ?#reply(info)) {
                    canCommitNoticeNotification(
                        key,
                        #reply,
                        info,
                        summary,
                        append.stored.like_evidence,
                        rate,
                    );
                };
                case (#notice(key), ?#share(info)) {
                    canCommitNoticeNotification(
                        key,
                        #share,
                        info,
                        summary,
                        append.stored.like_evidence,
                        rate,
                    );
                };
                case (_) false;
            };
        };

        func canCommitNoticeNotification(
            key : {
                acting_node : Principal;
                relation : Protocol.NoticeRelationV1;
                action_id : Blob;
            },
            relation : Protocol.NoticeRelationV1,
            info : DirectedActionSummaryV1,
            summary : Protocol.NotificationSummaryV1,
            evidence : ?Blob,
            rate : ?IngressTypes.RateMutation,
        ) : Bool {
            let ?rateMutation = rate else return false;
            let targetKey = postStableKey(info.target_post_id);
            evidence == null and
            key.relation == relation and
            Principal.equal(key.acting_node, summary.actor_) and
            Blob.equal(key.action_id, info.action_id) and
            summary.verification == ?#pending and
            Map.get(
                mem.notice_semantics,
                Text.compare,
                notificationSemanticStableKey(#notice(key)),
            ) == null and
            ingressNotificationStore().notice_count_for_actor(
                summary.actor_
            ) < mem.quota_limits.notices_per_caller and
            ingressNotificationStore().notice_count_for_target(
                info.target_post_id
            ) < mem.quota_limits.notices_per_target_post and
            rateMutation.replacement.route == #notice and
            Principal.equal(
                rateMutation.replacement.caller,
                summary.actor_,
            ) and
            rateMutation.replacement.semantic_notice_count <=
                mem.quota_limits.notice_semantics_per_caller_hour and
            targetKey.size() > 0;
        };

        func canCommitIngressLike(
            change : ?IngressTypes.LikeMutation,
            notification : ?IngressTypes.NotificationMutation,
        ) : Bool {
            let ?mutation = change else return true;
            let ?post = Map.get(
                mem.authored_posts,
                Text.compare,
                mutation.post_key,
            ) else return false;
            let ?target = ingressLikeTarget(
                post.post_id,
                mutation.accepted.liker,
            ) else return false;
            canCommitIngressLikeAgainst(
                mutation,
                notification,
                target,
                post.post_id,
            );
        };

        func canCommitIngressLikeAgainst(
            mutation : IngressTypes.LikeMutation,
            notification : ?IngressTypes.NotificationMutation,
            target : IngressTypes.LikeTarget,
            postId : Blob,
        ) : Bool {
            let acceptedKey = acceptedLikeStableKey(
                postId,
                mutation.accepted.liker,
            );
            let ?notice = notification else return false;
            let ?likeState = Map.get(
                mem.like_states,
                Text.compare,
                mutation.post_key,
            ) else return false;
            let ?action = Wire.decodeLikeAction(
                mutation.accepted.receipt.like_action_candid
            ) else return false;
            let validTransition = switch (
                LikeAdmission.admit({
                    caller = mutation.accepted.liker;
                    network_id = action.header.network_id;
                    post_author = target.post_author;
                    post_id = target.post_id;
                    post_body_hash = target.post_body_hash;
                    action;
                    receipt = mutation.accepted.receipt;
                    exact_receipt_candid =
                        mutation.accepted.exact_receipt_candid;
                    accepted_at_ns =
                        mutation.accepted.accepted_at_ns;
                    next_accepted_sequence =
                        mutation.expected_next_accepted_sequence;
                    existing_receipt_digest =
                        mutation.expected_existing_receipt_digest;
                    segments = mutation.expected_segments;
                    accepting_likes = target.accepting_likes;
                    blocked = false;
                })
            ) {
                case (#accepted(value)) {
                    value.accepted == mutation.accepted and
                    value.segments ==
                        mutation.replacement_segments and
                    value.next_accepted_sequence ==
                        mutation.replacement_next_accepted_sequence and
                    value.seal_due == mutation.seal_due;
                };
                case (_) false;
            };
            let rollover = switch (
                mutation.expected_segments.due,
                mutation.replacement_segments.due,
            ) {
                case (null, ?_) {
                    mutation.replacement_segments.active.size() == 0;
                };
                case (_) false;
            };
            target.post_key == mutation.post_key and
            validTransition and
            target.next_accepted_sequence ==
                mutation.expected_next_accepted_sequence and
            target.existing_receipt_digest ==
                mutation.expected_existing_receipt_digest and
            target.segments == mutation.expected_segments and
            mutation.accepted.accepted_sequence ==
                mutation.expected_next_accepted_sequence and
            mutation.replacement_next_accepted_sequence ==
                mutation.accepted.accepted_sequence + 1 and
            mem.accepted_like_sequence + 1 ==
                mutation.accepted.accepted_sequence and
            Map.get(
                mem.accepted_likes,
                Text.compare,
                acceptedKey,
            ) == null and
            Map.get(
                mem.accepted_likes_by_sequence,
                Nat64.compare,
                mutation.accepted.accepted_sequence,
            ) == null and
            Blob.equal(action.like_id, mutation.accepted.like_id) and
            Principal.equal(action.header.actor_, mutation.accepted.liker) and
            Blob.equal(action.post_id, postId) and
            Blob.equal(
                mutation.accepted.receipt.ref.object_digest,
                Hash.objectDigest(
                    mutation.accepted.receipt.like_action_candid
                ),
            ) and
            mutation.seal_due == rollover and
            (
                not rollover or
                likeState.next_segment_number != Nat64.maxValue
            ) and
            likeState.structurally_accepted_count != Nat64.maxValue and
            mem.accepted_like_count <
                mem.quota_limits.reaction_receipt_count and
            mem.accepted_like_bytes + mutation.retained_bytes <=
                mem.quota_limits.reaction_receipt_bytes and
            LikeAdmission.unsealedCount(
                mutation.replacement_segments
            ) <= Nat16.toNat(
                mem.quota_limits.unsealed_receipts_per_post
            ) and
            notice.append.stored.summary.local_sequence ==
                mem.notification_sequence + 1 and
            likeState.unsealed_receipt_count ==
                Nat16.fromNat(
                    LikeAdmission.unsealedCount(
                        mutation.expected_segments
                    )
                );
        };

        func ingressRetentionPlan(
            plan : IngressTypes.CommitPlan
        ) : ?RetentionTypes.RegistrationPlan {
            let requests =
                List.empty<RetentionTypes.RegistrationRequest>();

            let receiptRef : Memory.RetentionRecordRef =
                #ingress_receipt(plan.receipt.stable_key);
            List.add(requests, {
                view = #ingress_receipt({
                    receipt_key = plan.receipt.stable_key;
                    route = ingressRouteToMemory(
                        plan.receipt.key.route
                    );
                    received_at_ns = plan.receipt.received_at_ns;
                    retain_until_ns = plan.receipt.retain_until_ns;
                    retained_bytes = plan.receipt.retained_bytes;
                    domain_dependency_detached =
                        plan.domain.feed == null;
                });
                expected_previous =
                    currentRetentionEntry(receiptRef);
            });

            switch (plan.rate) {
                case null {};
                case (?mutation) {
                    let record : Memory.RetentionRecordRef =
                        #caller_rate_window(mutation.stable_key);
                    List.add(requests, {
                        view = #caller_rate_window({
                            window_key = mutation.stable_key;
                            window_started_at_ns =
                                mutation.replacement.window_started_at_ns;
                            expires_at_ns =
                                mutation.replacement.expires_at_ns;
                            retained_bytes =
                                mutation.replacement.retained_bytes;
                        });
                        expected_previous =
                            currentRetentionEntry(record);
                    });
                };
            };

            switch (plan.domain.follower) {
                case null {};
                case (?mutation) {
                    let row = mutation.next_row;
                    let retainUntil = addSaturating(
                        row.funded_at_ns,
                        mem.retention.peer_records_ns,
                    );
                    let record : Memory.RetentionRecordRef =
                        #follower(row.node);
                    List.add(requests, {
                        view = #follower({
                            node = row.node;
                            funded_at_ns = row.funded_at_ns;
                            retain_until_ns = retainUntil;
                            retained_bytes = followerRetainedBytes(row);
                            registration_sequence =
                                row.registration_sequence;
                            active = isActiveFollowerRow(row);
                            charges_detached =
                                row.outstanding_delivery_charges == 0;
                        });
                        expected_previous =
                            currentRetentionEntry(record);
                    });
                };
            };

            switch (plan.domain.feed) {
                case null {};
                case (?mutation) {
                    let candidate = mutation.candidate;
                    let record : Memory.RetentionRecordRef =
                        #feed_candidate(candidate.candidate_key);
                    List.add(requests, {
                        view = #feed_candidate({
                            candidate_key = candidate.candidate_key;
                            received_at_ns = candidate.received_at_ns;
                            retain_until_ns =
                                candidate.retain_until_ns;
                            retained_bytes =
                                candidate.retained_bytes;
                            local_sequence =
                                candidate.local_sequence;
                            immediate_sender =
                                candidate.immediate_sender;
                            unread = mutation.visible;
                            // No canonical/attribution dependency exists at
                            // initial quarantine admission.
                            dependents_detached = true;
                        });
                        expected_previous =
                            currentRetentionEntry(record);
                    });
                };
            };

            switch (plan.domain.notification) {
                case null {};
                case (?mutation) {
                    let append = mutation.append;
                    let summary = append.stored.summary;
                    let semanticKey = notificationSemanticStableKey(
                        append.semantic_key
                    );
                    let noticeTarget = switch (summary.kind) {
                        case (?#reply(info)) {
                            ?postStableKey(info.target_post_id);
                        };
                        case (?#share(info)) {
                            ?postStableKey(info.target_post_id);
                        };
                        case (_) null;
                    };
                    let notificationRef : Memory.RetentionRecordRef =
                        #notification(summary.local_sequence);
                    List.add(requests, {
                        view = #notification({
                            local_sequence = summary.local_sequence;
                            received_at_ns = summary.received_at_ns;
                            retain_until_ns =
                                mutation.retain_until_ns;
                            retained_bytes =
                                mutation.retained_bytes;
                            semantic_key = semanticKey;
                            actor_ = summary.actor_;
                            unread = not summary.read;
                            has_evidence =
                                append.stored.like_evidence != null;
                            notice_target_key = noticeTarget;
                            notice_semantic_detached =
                                noticeTarget == null;
                        });
                        expected_previous =
                            currentRetentionEntry(notificationRef);
                    });
                    switch (
                        append.semantic_key,
                        summary.kind,
                    ) {
                        case (
                            #notice(key),
                            ?#reply(info),
                        ) {
                            let record : Memory.RetentionRecordRef =
                                #notice_semantic(semanticKey);
                            List.add(requests, {
                                view = #notice_semantic({
                                    semantic_key = semanticKey;
                                    received_at_ns =
                                        summary.received_at_ns;
                                    retain_until_ns =
                                        mutation.retain_until_ns;
                                    accounted_bytes =
                                        ?NOTICE_SEMANTIC_RETAINED_BYTES;
                                    notification_sequence =
                                        summary.local_sequence;
                                    actor_ = summary.actor_;
                                    target_post_key =
                                        postStableKey(
                                            info.target_post_id
                                        );
                                });
                                expected_previous =
                                    currentRetentionEntry(record);
                            });
                        };
                        case (
                            #notice(key),
                            ?#share(info),
                        ) {
                            let record : Memory.RetentionRecordRef =
                                #notice_semantic(semanticKey);
                            List.add(requests, {
                                view = #notice_semantic({
                                    semantic_key = semanticKey;
                                    received_at_ns =
                                        summary.received_at_ns;
                                    retain_until_ns =
                                        mutation.retain_until_ns;
                                    accounted_bytes =
                                        ?NOTICE_SEMANTIC_RETAINED_BYTES;
                                    notification_sequence =
                                        summary.local_sequence;
                                    actor_ = summary.actor_;
                                    target_post_key =
                                        postStableKey(
                                            info.target_post_id
                                        );
                                });
                                expected_previous =
                                    currentRetentionEntry(record);
                            });
                        };
                        case (_) {};
                    };
                };
            };

            switch (
                plan.domain.like,
                plan.domain.notification,
            ) {
                case (?mutation, ?notification) {
                    let accepted = mutation.accepted;
                    let ?action = Wire.decodeLikeAction(
                        accepted.receipt.like_action_candid
                    ) else return null;
                    let acceptedKey = acceptedLikeStableKey(
                        action.post_id,
                        accepted.liker,
                    );
                    let ?likeState = Map.get(
                        mem.like_states,
                        Text.compare,
                        mutation.post_key,
                    ) else return null;
                    let lane = if (mutation.seal_due) {
                        #due;
                    } else {
                        #active;
                    };
                    let record : Memory.RetentionRecordRef =
                        #accepted_like(acceptedKey);
                    List.add(requests, {
                        view = #accepted_like({
                            accepted_like_key = acceptedKey;
                            accepted_sequence =
                                accepted.accepted_sequence;
                            accepted_at_ns = accepted.accepted_at_ns;
                            retain_until_ns =
                                mutation.retain_until_ns;
                            withdrawn_at_ns = null;
                            retained_bytes =
                                mutation.retained_bytes;
                            post_key = mutation.post_key;
                            notification_sequence =
                                notification.append.stored.summary
                                    .local_sequence;
                            segment = ?{
                                segment_number =
                                    likeState.active_segment
                                        .segment_number;
                                lane;
                            };
                        });
                        expected_previous =
                            currentRetentionEntry(record);
                    });
                };
                case (null, _) {};
                case (_) return null;
            };

            let result = RetentionService.prepareRegistrations(
                {
                    peer_records_ns =
                        mem.retention.peer_records_ns;
                    likes_ns = mem.retention.likes_ns;
                    rate_window_ns =
                        mem.retention.rate_window_ns;
                },
                mem.retention_sequence,
                List.toArray(requests),
            );
            switch (result) {
                case (#ok(value)) ?value;
                case (#err(_)) null;
            };
        };

        func currentRetentionEntry(
            record : Memory.RetentionRecordRef
        ) : ?RetentionTypes.Entry {
            let currentKey = RetentionService.canonicalKey(record);
            let ?indexKey = Map.get(
                mem.retention_current,
                Text.compare,
                currentKey,
            ) else return null;
            let ?stored = Map.get(
                mem.retention_order,
                retentionIndexCompare,
                indexKey,
            ) else return null;
            if (
                RetentionService.canonicalKey(stored) != currentKey
            ) return null;
            ?{ key = indexKey; record = stored };
        };

        func canApplyRetentionRegistration(
            plan : RetentionTypes.RegistrationPlan
        ) : Bool {
            if (
                plan.expected_sequence != mem.retention_sequence or
                plan.changes.size() == 0 or
                Nat64.fromNat(plan.changes.size()) >
                    Nat64.maxValue - plan.expected_sequence or
                plan.next_sequence !=
                    plan.expected_sequence +
                        Nat64.fromNat(plan.changes.size())
            ) return false;
            var expectedSuffix = plan.expected_sequence;
            for (change in plan.changes.vals()) {
                expectedSuffix += 1;
                let canonical = RetentionService.canonicalKey(
                    change.record
                );
                if (
                    change.current_key != canonical or
                    change.replacement.key.1 !=
                        RetentionService.domain(change.record) or
                    change.replacement.key.2 != expectedSuffix or
                    RetentionService.canonicalKey(
                        change.replacement.record
                    ) != canonical or
                    Map.get(
                        mem.retention_order,
                        retentionIndexCompare,
                        change.replacement.key,
                    ) != null
                ) return false;
                let pointer = Map.get(
                    mem.retention_current,
                    Text.compare,
                    canonical,
                );
                switch (change.expected_previous, pointer) {
                    case (null, null) {};
                    case (?previous, ?indexKey) {
                        if (indexKey != previous.key) return false;
                        let ?stored = Map.get(
                            mem.retention_order,
                            retentionIndexCompare,
                            indexKey,
                        ) else return false;
                        if (
                            RetentionService.canonicalKey(stored) !=
                                canonical or
                            RetentionService.canonicalKey(
                                previous.record
                            ) != canonical
                        ) return false;
                    };
                    case (_) return false;
                };
            };
            true;
        };

        func applyRetentionRegistration(
            plan : RetentionTypes.RegistrationPlan
        ) {
            for (change in plan.changes.vals()) {
                switch (change.expected_previous) {
                    case null {};
                    case (?previous) {
                        Map.remove(
                            mem.retention_order,
                            retentionIndexCompare,
                            previous.key,
                        );
                    };
                };
                Map.add(
                    mem.retention_order,
                    retentionIndexCompare,
                    change.replacement.key,
                    change.replacement.record,
                );
                Map.add(
                    mem.retention_current,
                    Text.compare,
                    change.current_key,
                    change.replacement.key,
                );
            };
            mem.retention_sequence := plan.next_sequence;
        };

        func reAgeDetachedTerminalRetention(
            record : Memory.RetentionRecordRef,
            detachedAt : Nat64,
        ) {
            let ?cleanupAt = RetentionService.terminalCleanupAt(
                detachedAt
            ) else return;
            let ?current = currentRetentionEntry(record) else return;
            let view : RetentionTypes.RecordView = switch (
                inspectRetentionEntry(current)
            ) {
                case (#record(#outbox(value))) {
                    if (
                        value.pending_credit_charge != null or
                        not value.links_detached
                    ) return;
                    #outbox({ value with cleanup_at_ns = cleanupAt });
                };
                case (#record(#fanout_job(value))) {
                    if (not value.targets_detached) return;
                    #fanout_job({
                        value with cleanup_at_ns = cleanupAt
                    });
                };
                case (#record(#fanout_target(value))) {
                    if (not value.outbox_detached) return;
                    #fanout_target({
                        value with cleanup_at_ns = cleanupAt
                    });
                };
                case (_) return;
            };
            if (current.key.0 == cleanupAt) return;
            let result = RetentionService.prepareRegistrations(
                {
                    peer_records_ns =
                        mem.retention.peer_records_ns;
                    likes_ns = mem.retention.likes_ns;
                    rate_window_ns =
                        mem.retention.rate_window_ns;
                },
                mem.retention_sequence,
                [{ view; expected_previous = ?current }],
            );
            switch (result) {
                case (#err(_)) {};
                case (#ok(plan)) {
                    if (canApplyRetentionRegistration(plan)) {
                        applyRetentionRegistration(plan);
                    };
                };
            };
        };

        func commitIngressAtomic(
            plan : IngressTypes.CommitPlan
        ) : Bool {
            if (not canCommitIngress(plan)) return false;
            let ?retention = ingressRetentionPlan(plan)
                else return false;
            if (not canApplyRetentionRegistration(retention)) {
                return false;
            };
            applyIngressReceipt(plan.receipt);
            switch (plan.rate) {
                case null {};
                case (?mutation) applyIngressRate(mutation);
            };
            switch (plan.domain.follower) {
                case null {};
                case (?mutation) {
                    applyIngressFollower(
                        mutation,
                        plan.receipt.received_at_ns,
                    );
                };
            };
            switch (plan.domain.following) {
                case null {};
                case (?mutation) applyIngressFollowing(mutation);
            };
            switch (plan.domain.feed) {
                case null {};
                case (?mutation) applyIngressFeed(mutation);
            };
            switch (plan.domain.notification) {
                case null {};
                case (?mutation) {
                    applyIngressNotification(
                        mutation,
                        plan.domain.like,
                        plan.rate,
                    );
                };
            };
            applyRetentionRegistration(retention);
            if (
                plan.domain.follower != null or
                plan.domain.following != null
            ) {
                mem.relationship_revision += 1;
            };
            mem.state_revision += 1;
            true;
        };

        func applyIngressReceipt(
            receipt : IngressTypes.Receipt
        ) {
            Map.add(
                mem.ingress_receipts,
                Text.compare,
                receipt.stable_key,
                {
                    receipt_key = receipt.stable_key;
                    caller = receipt.key.caller;
                    route = ingressRouteToMemory(receipt.key.route);
                    operation_id = receipt.key.operation_id;
                    payload_digest = receipt.payload_digest;
                    result = protocolRouteToMemory(receipt.result);
                    exact_result_candid =
                        receipt.exact_result_candid;
                    received_at_ns = receipt.received_at_ns;
                    retain_until_ns = receipt.retain_until_ns;
                    retained_bytes = receipt.retained_bytes;
                },
            );
            mem.ingress_receipt_count += 1;
            mem.ingress_receipt_bytes += receipt.retained_bytes;
        };

        func applyIngressRate(
            mutation : IngressTypes.RateMutation
        ) {
            let current = Map.get(
                mem.caller_rate_windows,
                Text.compare,
                mutation.stable_key,
            );
            let previousBytes = switch (current) {
                case null 0;
                case (?value) value.retained_bytes;
            };
            let replacement = mutation.replacement;
            Map.add(
                mem.caller_rate_windows,
                Text.compare,
                mutation.stable_key,
                {
                    caller = replacement.caller;
                    route = ingressRouteToMemory(
                        replacement.route
                    );
                    window_started_at_ns =
                        replacement.window_started_at_ns;
                    accepted_count = replacement.accepted_count;
                    semantic_notice_count =
                        replacement.semantic_notice_count;
                    expires_at_ns = replacement.expires_at_ns;
                    retained_bytes = replacement.retained_bytes;
                },
            );
            if (current == null) {
                mem.caller_rate_window_count += 1;
            };
            if (replacement.retained_bytes >= previousBytes) {
                mem.caller_rate_window_bytes +=
                    replacement.retained_bytes - previousBytes;
            } else {
                mem.caller_rate_window_bytes -=
                    previousBytes - replacement.retained_bytes;
            };
        };

        func applyIngressFollower(
            mutation : RelationshipTypes.FollowerMutation,
            receivedAt : Nat64,
        ) {
            let current = Map.get(
                mem.followers,
                Principal.compare,
                mutation.node,
            );
            let row = mutation.next_row;
            let retainedBytes = followerRetainedBytes(row);
            let previousBytes = switch (current) {
                case null 0;
                case (?value) value.retained_bytes;
            };
            let wasActive = switch (current) {
                case null false;
                case (?value) isActiveFollowerRecord(value);
            };
            let active = isActiveFollowerRow(row);
            switch (current) {
                case null {
                    mem.follower_head_count += 1;
                };
                case (?previous) {
                    if (
                        previous.registration_sequence !=
                            row.registration_sequence
                    ) {
                        Map.remove(
                            mem.followers_by_registration,
                            Nat64.compare,
                            previous.registration_sequence,
                        );
                    };
                };
            };
            Map.add(
                mem.followers,
                Principal.compare,
                mutation.node,
                {
                    node = row.node;
                    head_revision = row.head_revision;
                    storage_revision = row.storage_revision;
                    state = row.state;
                    registration_sequence =
                        row.registration_sequence;
                    delivery_pause = row.delivery_pause;
                    outstanding_delivery_charges =
                        row.outstanding_delivery_charges;
                    funded_at_ns = row.funded_at_ns;
                    created_at_ns = switch (current) {
                        case null receivedAt;
                        case (?previous) previous.created_at_ns;
                    };
                    updated_at_ns = receivedAt;
                    retain_until_ns = addSaturating(
                        row.funded_at_ns,
                        mem.retention.peer_records_ns,
                    );
                    retained_bytes = retainedBytes;
                },
            );
            Map.add(
                mem.followers_by_registration,
                Nat64.compare,
                row.registration_sequence,
                row.node,
            );
            if (retainedBytes >= previousBytes) {
                mem.follower_head_bytes +=
                    retainedBytes - previousBytes;
            } else {
                mem.follower_head_bytes -=
                    previousBytes - retainedBytes;
            };
            if (active and not wasActive) {
                mem.active_follower_count += 1;
            } else if (wasActive and not active) {
                mem.active_follower_count -= 1;
            };
            mem.follower_revision :=
                mutation.next_counters.follower_revision;
            mem.follower_registration_sequence :=
                mutation.next_counters.max_registration_sequence;
        };

        func applyIngressFollowing(
            mutation : RelationshipTypes.FollowingMutation
        ) {
            let current = Map.get(
                mem.following,
                Principal.compare,
                mutation.node,
            );
            let row = mutation.next_row;
            Map.add(
                mem.following,
                Principal.compare,
                mutation.node,
                {
                    node = row.node;
                    intent_generation = row.intent_generation;
                    storage_revision = row.storage_revision;
                    intent = row.intent;
                    last_remote_revision =
                        row.last_remote_revision;
                    renewal_requested = row.renewal_requested;
                    updated_at_ns = row.updated_at_ns;
                    pending_outbox_local_id = switch (current) {
                        case null null;
                        case (?value) {
                            value.pending_outbox_local_id;
                        };
                    };
                    created_at_ns = switch (current) {
                        case null row.updated_at_ns;
                        case (?value) value.created_at_ns;
                    };
                },
            );
        };

        func applyIngressFeed(
            mutation : FeedTypes.AdmissionCommit
        ) {
            let candidate = mutation.candidate;
            let slotKey = feedPostSlotStableKey(
                candidate.claimed_author,
                candidate.claimed_post_id,
            );
            let slot = switch (
                Map.get(
                    mem.feed_candidates_by_claimed_slot,
                    Text.compare,
                    slotKey,
                )
            ) {
                case null [];
                case (?value) value;
            };
            Map.add(
                mem.feed_candidates,
                Text.compare,
                candidate.candidate_key,
                {
                    candidate_key = candidate.candidate_key;
                    candidate_id = candidate.candidate_id;
                    local_sequence = candidate.local_sequence;
                    received_at_ns = candidate.received_at_ns;
                    immediate_sender =
                        candidate.immediate_sender;
                    route_receipt_key =
                        candidate.route_receipt_key;
                    operation_id = candidate.operation_id;
                    payload_digest = candidate.payload_digest;
                    subscription_id = candidate.subscription_id;
                    event_kind = ?candidate.event_kind;
                    claimed_author = candidate.claimed_author;
                    claimed_post_id = candidate.claimed_post_id;
                    claimed_body_hash =
                        ?candidate.claimed_body_hash;
                    exact_event_candid =
                        candidate.exact_event_candid;
                    verification = ?candidate.verification;
                    read = false;
                    retain_until_ns = candidate.retain_until_ns;
                    retained_bytes = candidate.retained_bytes;
                },
            );
            Map.add(
                mem.feed_candidates_by_claimed_slot,
                Text.compare,
                slotKey,
                Array.concat<Text>(slot, [candidate.candidate_key]),
            );
            if (mutation.visible) {
                Map.add(
                    mem.feed_order,
                    Nat64.compare,
                    candidate.local_sequence,
                    candidate.candidate_key,
                );
                Map.add(
                    mem.unread_feed_candidates,
                    Text.compare,
                    candidate.candidate_key,
                    (),
                );
                mem.unread_feed_count += 1;
            };
            let pressure = switch (
                Map.get(
                    mem.candidate_pressure_by_sender,
                    Principal.compare,
                    candidate.immediate_sender,
                )
            ) {
                case null {
                    {
                        sender = candidate.immediate_sender;
                        candidate_count = 1;
                        retained_bytes =
                            candidate.retained_bytes;
                    };
                };
                case (?current) {
                    {
                        current with
                        candidate_count =
                            current.candidate_count + 1;
                        retained_bytes =
                            current.retained_bytes +
                                candidate.retained_bytes;
                    };
                };
            };
            Map.add(
                mem.candidate_pressure_by_sender,
                Principal.compare,
                candidate.immediate_sender,
                pressure,
            );
            mem.feed_sequence := candidate.local_sequence;
            mem.feed_revision := mutation.revision;
            mem.candidate_count += 1;
            mem.candidate_bytes += candidate.retained_bytes;
        };

        func applyIngressNotification(
            mutation : IngressTypes.NotificationMutation,
            like : ?IngressTypes.LikeMutation,
            rate : ?IngressTypes.RateMutation,
        ) {
            let append = mutation.append;
            let summary = append.stored.summary;
            let semanticKey = notificationSemanticStableKey(
                append.semantic_key
            );
            Map.add(
                mem.notifications,
                Nat64.compare,
                summary.local_sequence,
                {
                    local_sequence = summary.local_sequence;
                    received_at_ns = summary.received_at_ns;
                    actor_ = summary.actor_;
                    kind = protocolNotificationKindToMemory(
                        summary.kind
                    );
                    verification =
                        protocolNotificationVerificationToMemory(
                            summary.verification
                        );
                    read = summary.read;
                    semantic_key = semanticKey;
                    retain_until_ns = mutation.retain_until_ns;
                    retained_bytes = mutation.retained_bytes;
                },
            );
            Map.add(
                mem.notification_order,
                Nat64.compare,
                summary.local_sequence,
                (),
            );
            Map.add(
                mem.notification_by_semantic,
                Text.compare,
                semanticKey,
                summary.local_sequence,
            );
            if (not summary.read) {
                Map.add(
                    mem.unread_notifications,
                    Nat64.compare,
                    summary.local_sequence,
                    (),
                );
                mem.unread_notification_count += 1;
            };
            switch (append.stored.like_evidence, summary.kind) {
                case (?evidence, ?#like(info)) {
                    let targetPostId = switch (summary.kind) {
                        case (?#like(info)) info.target_post_id;
                        case (_) Blob.fromArray([]);
                    };
                    let acceptedKey = acceptedLikeStableKey(
                        targetPostId,
                        summary.actor_,
                    );
                    Map.add(
                        mem.notification_evidence,
                        Nat64.compare,
                        summary.local_sequence,
                        #like({
                            accepted_like_key = acceptedKey;
                            exact_certified_like_receipt_candid =
                                evidence;
                        }),
                    );
                    let postKey = postStableKey(info.target_post_id);
                    let ?current = Map.get(
                        mem.like_states,
                        Text.compare,
                        postKey,
                    ) else Runtime.trap(
                        "Wagyu quarantined Like state disappeared after preflight"
                    );
                    Map.add(
                        mem.like_states,
                        Text.compare,
                        postKey,
                        {
                            current with
                            structurally_accepted_count =
                                current.structurally_accepted_count + 1;
                            unsealed_receipt_count = Nat16.fromNat(
                                Nat16.toNat(
                                    current.unsealed_receipt_count
                                ) + 1
                            );
                        },
                    );
                };
                case (_) {};
            };
            switch (append.semantic_key, summary.kind) {
                case (#notice(key), ?#reply(info)) {
                    applyIngressNoticeSemantic(
                        key,
                        #reply,
                        info,
                        summary,
                        mutation,
                        rate,
                    );
                };
                case (#notice(key), ?#share(info)) {
                    applyIngressNoticeSemantic(
                        key,
                        #share,
                        info,
                        summary,
                        mutation,
                        rate,
                    );
                };
                case (_) {};
            };
            mem.notification_sequence := summary.local_sequence;
            mem.notification_revision := append.revision;
            mem.notification_count += 1;
            mem.notification_bytes += mutation.retained_bytes;
        };

        func applyIngressNoticeSemantic(
            key : {
                acting_node : Principal;
                relation : Protocol.NoticeRelationV1;
                action_id : Blob;
            },
            relation : Protocol.NoticeRelationV1,
            info : DirectedActionSummaryV1,
            summary : Protocol.NotificationSummaryV1,
            mutation : IngressTypes.NotificationMutation,
            rate : ?IngressTypes.RateMutation,
        ) {
            let semanticKey = notificationSemanticStableKey(
                #notice(key)
            );
            let targetKey = postStableKey(info.target_post_id);
            Map.add(
                mem.notice_semantics,
                Text.compare,
                semanticKey,
                {
                    semantic_key = semanticKey;
                    actor_ = summary.actor_;
                    relation = relation;
                    action_id = info.action_id;
                    target_post_id = info.target_post_id;
                    target_body_hash = info.target_body_hash;
                    object_digest = info.object_digest;
                    object_length = info.object_length;
                    notification_sequence =
                        summary.local_sequence;
                    retain_until_ns =
                        mutation.retain_until_ns;
                },
            );
            let rateWindow = switch (rate) {
                case null null;
                case (?value) ?value.replacement;
            };
            let pressure = switch (
                Map.get(
                    mem.notice_pressure_by_caller,
                    Principal.compare,
                    summary.actor_,
                )
            ) {
                case null {
                    {
                        retained_count = 1;
                        retained_bytes =
                            NOTICE_SEMANTIC_RETAINED_BYTES;
                        hourly_window_started_at_ns = switch (
                            rateWindow
                        ) {
                            case null summary.received_at_ns;
                            case (?value) {
                                value.window_started_at_ns;
                            };
                        };
                        hourly_new_count = switch (rateWindow) {
                            case null (1 : Nat32);
                            case (?value) {
                                value.semantic_notice_count;
                            };
                        };
                    };
                };
                case (?current) {
                    {
                        retained_count =
                            current.retained_count + 1;
                        retained_bytes =
                            current.retained_bytes +
                                NOTICE_SEMANTIC_RETAINED_BYTES;
                        hourly_window_started_at_ns = switch (
                            rateWindow
                        ) {
                            case null {
                                current.hourly_window_started_at_ns;
                            };
                            case (?value) {
                                value.window_started_at_ns;
                            };
                        };
                        hourly_new_count = switch (rateWindow) {
                            case null current.hourly_new_count;
                            case (?value) {
                                value.semantic_notice_count;
                            };
                        };
                    };
                };
            };
            Map.add(
                mem.notice_pressure_by_caller,
                Principal.compare,
                summary.actor_,
                pressure,
            );
            let targetCount = switch (
                Map.get(
                    mem.notice_count_by_target,
                    Text.compare,
                    targetKey,
                )
            ) {
                case null 0;
                case (?value) value;
            };
            Map.add(
                mem.notice_count_by_target,
                Text.compare,
                targetKey,
                targetCount + 1,
            );
        };

        func applyPromotedLike(
            mutation : IngressTypes.LikeMutation,
            action : Protocol.LikeActionV1,
            notificationSequence : Nat64,
        ) {
            let accepted = mutation.accepted;
            let acceptedKey = acceptedLikeStableKey(
                action.post_id,
                accepted.liker,
            );
            Map.add(
                mem.accepted_likes,
                Text.compare,
                acceptedKey,
                {
                    accepted_like_key = acceptedKey;
                    accepted_sequence =
                        accepted.accepted_sequence;
                    accepted_at_ns = accepted.accepted_at_ns;
                    post_key = mutation.post_key;
                    post_id = action.post_id;
                    post_body_hash = action.post_body_hash;
                    liker = accepted.liker;
                    like_id = accepted.like_id;
                    like_action = protocolLikeToMemory(action);
                    exact_like_action_candid =
                        accepted.receipt.like_action_candid;
                    certified_ref = protocolActionRefToMemory(
                        accepted.receipt.ref
                    );
                    exact_certified_like_receipt_candid =
                        accepted.exact_receipt_candid;
                    object_digest =
                        accepted.receipt.ref.object_digest;
                    body_length = accepted.receipt.ref.body_length;
                    notification_sequence = notificationSequence;
                    retain_until_ns = mutation.retain_until_ns;
                    retained_bytes = mutation.retained_bytes;
                },
            );
            Map.add(
                mem.accepted_likes_by_sequence,
                Nat64.compare,
                accepted.accepted_sequence,
                acceptedKey,
            );
            incrementAcceptedLikePostCount(mutation.post_key);
            let ?current = Map.get(
                mem.like_states,
                Text.compare,
                mutation.post_key,
            ) else Runtime.trap(
                "Wagyu ingress Like state disappeared after preflight"
            );
            let rollover = mutation.seal_due;
            let dueSegment = switch (
                mutation.replacement_segments.due
            ) {
                case null null;
                case (?rows) {
                    let number = switch (current.due_segment) {
                        case null {
                            current.active_segment.segment_number;
                        };
                        case (?segment) segment.segment_number;
                    };
                    ?ingressMemoryLikeSegment(
                        rows,
                        action.post_id,
                        number,
                    );
                };
            };
            let activeNumber = if (rollover) {
                current.next_segment_number;
            } else {
                current.active_segment.segment_number;
            };
            let activeSegment = ingressMemoryLikeSegment(
                mutation.replacement_segments.active,
                action.post_id,
                activeNumber,
            );
            let unsealedBytes =
                activeSegment.receipt_bytes +
                (
                    switch (dueSegment) {
                        case null 0;
                        case (?segment) segment.receipt_bytes;
                    }
                );
            Map.add(
                mem.like_states,
                Text.compare,
                mutation.post_key,
                {
                    current with
                    active_segment = activeSegment;
                    due_segment = dueSegment;
                    next_segment_number =
                        if (rollover) {
                            current.next_segment_number + 1;
                        } else {
                            current.next_segment_number;
                        };
                    // Quarantine already charged this receipt and counted its
                    // structural admission. Promotion only makes it sealable.
                    unsealed_receipt_count =
                        current.unsealed_receipt_count;
                    unsealed_receipt_bytes = unsealedBytes;
                },
            );
            mem.accepted_like_sequence :=
                accepted.accepted_sequence;
            mem.accepted_like_count += 1;
            mem.accepted_like_bytes += mutation.retained_bytes;
        };

        func ingressMemoryLikeSegment(
            rows : [LikeAdmission.AcceptedLike],
            postId : Blob,
            segmentNumber : Nat64,
        ) : Memory.LikeSegment {
            let keys = List.empty<Text>();
            var bytes = 0;
            for (row in rows.vals()) {
                List.add(
                    keys,
                    acceptedLikeStableKey(postId, row.liker),
                );
                bytes += row.exact_receipt_candid.size();
            };
            {
                segment_number = segmentNumber;
                first_accepted_sequence =
                    if (rows.size() == 0) null
                    else ?rows[0].accepted_sequence;
                last_accepted_sequence =
                    if (rows.size() == 0) null
                    else ?rows[rows.size() - 1].accepted_sequence;
                accepted_like_keys = List.toArray(keys);
                receipt_count = Nat16.fromNat(rows.size());
                receipt_bytes = bytes;
            };
        };

        func followerView(
            value : Memory.FollowerRecord
        ) : RelationshipTypes.FollowerRow {
            {
                node = value.node;
                head_revision = value.head_revision;
                storage_revision = value.storage_revision;
                state = value.state;
                registration_sequence = value.registration_sequence;
                delivery_pause = value.delivery_pause;
                outstanding_delivery_charges =
                    value.outstanding_delivery_charges;
                funded_at_ns = value.funded_at_ns;
            };
        };

        func followingView(
            value : Memory.FollowingRecord
        ) : RelationshipTypes.FollowingRow {
            {
                node = value.node;
                intent_generation = value.intent_generation;
                storage_revision = value.storage_revision;
                intent = value.intent;
                last_remote_revision = value.last_remote_revision;
                renewal_requested = value.renewal_requested;
                locally_verified_delivery_count = switch (
                    Map.get(
                        mem.locally_verified_delivery_counts,
                        Principal.compare,
                        value.node,
                    )
                ) {
                    case null 0;
                    case (?count) count;
                };
                updated_at_ns = value.updated_at_ns;
            };
        };

        func relationshipState() : RelationshipTypes.State {
            {
                follower = func(
                    peer : Principal
                ) : ?RelationshipTypes.FollowerRow {
                    switch (
                        Map.get(mem.followers, Principal.compare, peer)
                    ) {
                        case null null;
                        case (?value) ?followerView(value);
                    };
                };
                followers = func() : [RelationshipTypes.FollowerRow] {
                    let values =
                        List.empty<RelationshipTypes.FollowerRow>();
                    for ((_, value) in Map.entries(mem.followers)) {
                        List.add(values, followerView(value));
                    };
                    List.toArray(values);
                };
                followers_by_registration = func(
                    afterSequence : ?Nat64,
                    limit : Nat,
                ) : ?[RelationshipTypes.FollowerRow] {
                    if (limit == 0) return ?[];
                    let values =
                        List.empty<RelationshipTypes.FollowerRow>();
                    let entries = switch (afterSequence) {
                        case null {
                            Map.entries(mem.followers_by_registration);
                        };
                        case (?cursor) {
                            Map.entriesFrom(
                                mem.followers_by_registration,
                                Nat64.compare,
                                cursor,
                            );
                        };
                    };
                    var count = 0;
                    label collect for ((sequence, peer) in entries) {
                        let strictlyAfter = switch (afterSequence) {
                            case null true;
                            case (?cursor) sequence > cursor;
                        };
                        if (strictlyAfter) {
                            if (count >= limit) break collect;
                            let ?row = Map.get(
                                mem.followers,
                                Principal.compare,
                                peer,
                            ) else return null;
                            if (
                                row.registration_sequence != sequence or
                                not Principal.equal(row.node, peer)
                            ) return null;
                            List.add(values, followerView(row));
                            count += 1;
                        };
                    };
                    ?List.toArray(values);
                };
                active_follower_count = func() : Nat {
                    mem.active_follower_count;
                };
                follower_counters =
                    func() : RelationshipTypes.FollowerCounters {
                        {
                            follower_revision = mem.follower_revision;
                            max_registration_sequence =
                                mem.follower_registration_sequence;
                        };
                    };
                commit_follower = commitFollowerMutation;
                following = func(
                    peer : Principal
                ) : ?RelationshipTypes.FollowingRow {
                    switch (
                        Map.get(mem.following, Principal.compare, peer)
                    ) {
                        case null null;
                        case (?value) ?followingView(value);
                    };
                };
                following_count = func() : Nat {
                    mem.following_count;
                };
                commit_following = commitFollowingMutation;
                block = func(
                    peer : Principal
                ) : ?RelationshipTypes.BlockRow {
                    Map.get(mem.blocks, Principal.compare, peer);
                };
                block_count = func() : Nat { mem.block_count };
                commit_block = commitBlockMutation;
            };
        };

        func relationshipEstimator() : RelationshipTypes.CostEstimator {
            {
                call_and_byte_cycles = func(
                    input : RelationshipTypes.CostEstimateInput
                ) : ?Nat {
                    let calls =
                        Nat32.toNat(input.delivery_count) +
                        Nat32.toNat(input.notice_count);
                    ?(
                        calls * (
                            260_000 +
                            Nat32.toNat(input.estimated_object_bytes)
                        )
                    );
                };
                local_publication_cycles = func(
                    input : RelationshipTypes.CostEstimateInput
                ) : ?Nat {
                    ?(
                        1_000_000 +
                        Nat32.toNat(input.estimated_object_bytes) * 20
                    );
                };
            };
        };

        func relationships() : RelationshipService.Service {
            RelationshipService.Service(
                relationshipState(),
                node,
                relationshipEstimator(),
            );
        };

        func commitFollowingMutation(
            mutation : RelationshipTypes.FollowingMutation
        ) : Bool {
            if (not canCommitFollowingMutation(mutation)) return false;
            applyFollowingMutation(mutation, false);
            mem.relationship_revision += 1;
            mem.state_revision += 1;
            true;
        };

        func canCommitFollowingMutation(
            mutation : RelationshipTypes.FollowingMutation
        ) : Bool {
            if (
                not Principal.equal(mutation.node, mutation.next_row.node) or
                not RelationshipService.validFollowingRow(
                    mutation.next_row
                ) or
                mem.state_revision == Nat64.maxValue or
                mem.relationship_revision == Nat64.maxValue
            ) return false;
            let current = Map.get(
                mem.following,
                Principal.compare,
                mutation.node,
            );
            switch (current, mutation.expected_storage_revision) {
                case (null, null) {
                    if (
                        not RelationshipService
                            .followingIntentOccupiesCapacity(
                                mutation.next_row.intent
                            )
                    ) return false;
                };
                case (?value, ?expected) {
                    if (value.storage_revision != expected) return false;
                };
                case (_) return false;
            };
            let currentOccupied = switch (current) {
                case null false;
                case (?row) {
                    RelationshipService.followingIntentOccupiesCapacity(
                        row.intent
                    );
                };
            };
            let nextOccupied =
                RelationshipService.followingIntentOccupiesCapacity(
                    mutation.next_row.intent
                );
            switch (
                RelationshipService.followingCountAfterMutation(
                    mem.following_count,
                    currentOccupied,
                    nextOccupied,
                    mem.quota_limits.following_count,
                )
            ) {
                case null return false;
                case (?_) {};
            };
            true;
        };

        func applyFollowingMutation(
            mutation : RelationshipTypes.FollowingMutation,
            detachPendingOutbox : Bool,
        ) {
            let current = Map.get(
                mem.following,
                Principal.compare,
                mutation.node,
            );
            let currentOccupied = switch (current) {
                case null false;
                case (?row) {
                    RelationshipService.followingIntentOccupiesCapacity(
                        row.intent
                    );
                };
            };
            let nextOccupied =
                RelationshipService.followingIntentOccupiesCapacity(
                    mutation.next_row.intent
                );
            let ?nextOccupiedCount =
                RelationshipService.followingCountAfterMutation(
                    mem.following_count,
                    currentOccupied,
                    nextOccupied,
                    mem.quota_limits.following_count,
                ) else Runtime.trap(
                    "Following occupancy changed after commit preflight"
                );
            let stored : Memory.FollowingRecord = {
                node = mutation.next_row.node;
                intent_generation = mutation.next_row.intent_generation;
                storage_revision = mutation.next_row.storage_revision;
                intent = mutation.next_row.intent;
                last_remote_revision =
                    mutation.next_row.last_remote_revision;
                renewal_requested =
                    mutation.next_row.renewal_requested;
                updated_at_ns = mutation.next_row.updated_at_ns;
                pending_outbox_local_id = if (detachPendingOutbox) {
                    null;
                } else {
                    switch (pendingOutboxMetadata) {
                        case (?metadata) {
                            switch (
                                metadata.following_intent_generation
                            ) {
                                case (?generation) {
                                    if (
                                        generation ==
                                        mutation.next_row.intent_generation
                                    ) ?metadata.local_id else null;
                                };
                                case null null;
                            };
                        };
                        case null {
                            switch (current) {
                                case null null;
                                case (?value) {
                                    switch (
                                        reconciledFollowingOutboxId
                                    ) {
                                        case (?localId) {
                                            if (
                                                value.pending_outbox_local_id ==
                                                ?localId
                                            ) null else
                                            value.pending_outbox_local_id;
                                        };
                                        case null {
                                            value.pending_outbox_local_id;
                                        };
                                    };
                                };
                            };
                        };
                    };
                };
                created_at_ns = switch (current) {
                    case null mutation.next_row.updated_at_ns;
                    case (?value) value.created_at_ns;
                };
            };
            Map.add(
                mem.following,
                Principal.compare,
                mutation.node,
                stored,
            );
            if (
                mutation.next_row.locally_verified_delivery_count == 0
            ) {
                Map.remove(
                    mem.locally_verified_delivery_counts,
                    Principal.compare,
                    mutation.node,
                );
            } else {
                Map.add(
                    mem.locally_verified_delivery_counts,
                    Principal.compare,
                    mutation.node,
                    mutation.next_row.locally_verified_delivery_count,
                );
            };
            mem.following_count := nextOccupiedCount;
        };

        func commitFollowerMutation(
            mutation : RelationshipTypes.FollowerMutation
        ) : Bool {
            if (not canCommitFollowerMutation(mutation)) return false;
            applyFollowerMutation(mutation);
            if (mem.relationship_revision == Nat64.maxValue) return false;
            if (mem.state_revision == Nat64.maxValue) return false;
            mem.relationship_revision += 1;
            mem.state_revision += 1;
            true;
        };

        func canCommitFollowerMutation(
            mutation : RelationshipTypes.FollowerMutation
        ) : Bool {
            if (
                not Principal.equal(mutation.node, mutation.next_row.node) or
                mem.follower_revision !=
                    mutation.expected_counters.follower_revision or
                mem.follower_registration_sequence !=
                    mutation.expected_counters.max_registration_sequence or
                mem.relationship_revision == Nat64.maxValue or
                mem.state_revision == Nat64.maxValue
            ) return false;
            let current = Map.get(
                mem.followers,
                Principal.compare,
                mutation.node,
            );
            switch (current, mutation.expected_storage_revision) {
                case (null, null) {
                    if (
                        mem.follower_head_count >=
                            mem.quota_limits.follower_head_count
                    ) return false;
                };
                case (?value, ?expected) {
                    if (value.storage_revision != expected) return false;
                };
                case (_) return false;
            };
            if (
                mutation.next_row.registration_sequence == 0 or
                mutation.next_row.registration_sequence >
                    mutation.next_counters.max_registration_sequence
            ) return false;
            switch (
                Map.get(
                    mem.followers_by_registration,
                    Nat64.compare,
                    mutation.next_row.registration_sequence,
                )
            ) {
                case (?peer) {
                    if (not Principal.equal(peer, mutation.node)) {
                        return false;
                    };
                };
                case null {};
            };
            let nextBytes = followerRetainedBytes(mutation.next_row);
            let currentBytes = switch (current) {
                case null 0;
                case (?value) value.retained_bytes;
            };
            if (
                nextBytes > currentBytes and
                mem.follower_head_bytes + (nextBytes - currentBytes) >
                    mem.quota_limits.follower_head_bytes
            ) return false;
            let activeDelta = (
                isActiveFollowerRow(mutation.next_row),
                switch (current) {
                    case null false;
                    case (?value) isActiveFollowerRecord(value);
                },
            );
            switch (activeDelta) {
                case (true, false) {
                    if (
                        mem.active_follower_count >=
                            mem.quota_limits.active_follower_count
                    ) return false;
                };
                case (_) {};
            };
            switch (mutation.new_follower_summary) {
                case null {};
                case (?summary) {
                    if (
                        not Principal.equal(summary.node, mutation.node) or
                        mem.notification_count >=
                            mem.quota_limits.notification_count or
                        mem.notification_sequence == Nat64.maxValue or
                        mem.notification_revision == Nat64.maxValue
                    ) return false;
                    let retained = newFollowerNotificationBytes(summary);
                    if (
                        mem.notification_bytes + retained >
                            mem.quota_limits.notification_bytes
                    ) return false;
                    if (
                        Map.get(
                            mem.notification_by_semantic,
                            Text.compare,
                            newFollowerSemanticKey(summary),
                        ) != null
                    ) return false;
                };
            };
            true;
        };

        func applyFollowerMutation(
            mutation : RelationshipTypes.FollowerMutation
        ) {
            let current = Map.get(
                mem.followers,
                Principal.compare,
                mutation.node,
            );
            let nextBytes = followerRetainedBytes(mutation.next_row);
            let currentBytes = switch (current) {
                case null 0;
                case (?value) value.retained_bytes;
            };
            let wasActive = switch (current) {
                case null false;
                case (?value) isActiveFollowerRecord(value);
            };
            let isActive = isActiveFollowerRow(mutation.next_row);
            switch (current) {
                case (?value) {
                    if (
                        value.registration_sequence !=
                            mutation.next_row.registration_sequence
                    ) {
                        Map.remove(
                            mem.followers_by_registration,
                            Nat64.compare,
                            value.registration_sequence,
                        );
                    };
                };
                case null {
                    mem.follower_head_count += 1;
                };
            };
            let updatedAt = switch (mutation.new_follower_summary) {
                case (?summary) summary.received_at_ns;
                case null nowNs();
            };
            let stored : Memory.FollowerRecord = {
                node = mutation.next_row.node;
                head_revision = mutation.next_row.head_revision;
                storage_revision = mutation.next_row.storage_revision;
                state = mutation.next_row.state;
                registration_sequence =
                    mutation.next_row.registration_sequence;
                delivery_pause = mutation.next_row.delivery_pause;
                outstanding_delivery_charges =
                    mutation.next_row.outstanding_delivery_charges;
                funded_at_ns = mutation.next_row.funded_at_ns;
                created_at_ns = switch (current) {
                    case null updatedAt;
                    case (?value) value.created_at_ns;
                };
                updated_at_ns = updatedAt;
                retain_until_ns = addSaturating(
                    mutation.next_row.funded_at_ns,
                    mem.retention.peer_records_ns,
                );
                retained_bytes = nextBytes;
            };
            Map.add(
                mem.followers,
                Principal.compare,
                mutation.node,
                stored,
            );
            Map.add(
                mem.followers_by_registration,
                Nat64.compare,
                mutation.next_row.registration_sequence,
                mutation.node,
            );
            if (nextBytes >= currentBytes) {
                mem.follower_head_bytes += nextBytes - currentBytes;
            } else {
                mem.follower_head_bytes -= currentBytes - nextBytes;
            };
            if (isActive and not wasActive) {
                mem.active_follower_count += 1;
            } else if (wasActive and not isActive) {
                mem.active_follower_count -= 1;
            };
            mem.follower_revision :=
                mutation.next_counters.follower_revision;
            mem.follower_registration_sequence :=
                mutation.next_counters.max_registration_sequence;
            switch (mutation.new_follower_summary) {
                case null {};
                case (?summary) appendNewFollowerNotification(summary);
            };
        };

        func followerRetainedBytes(
            row : RelationshipTypes.FollowerRow
        ) : Nat {
            let subscriptionBytes = switch (row.state) {
                case (#active(value)) value.subscription_id.size();
                case (#inactive(value)) value.last_subscription_id.size();
            };
            256 + subscriptionBytes;
        };

        func isActiveFollowerRow(
            row : RelationshipTypes.FollowerRow
        ) : Bool {
            switch (row.state) {
                case (#active(_)) true;
                case (#inactive(_)) false;
            };
        };

        func isActiveFollowerRecord(
            row : Memory.FollowerRecord
        ) : Bool {
            switch (row.state) {
                case (#active(_)) true;
                case (#inactive(_)) false;
            };
        };

        func newFollowerSemanticKey(
            summary : RelationshipTypes.NewFollowerSummary
        ) : Text {
            "notification:new-follower:" #
            Principal.toText(summary.node) # ":" #
            Nat64.toText(summary.resulting_revision);
        };

        func newFollowerNotificationBytes(
            _summary : RelationshipTypes.NewFollowerSummary
        ) : Nat {
            INGRESS_NOTIFICATION_ACCOUNTING_OVERHEAD;
        };

        func appendNewFollowerNotification(
            summary : RelationshipTypes.NewFollowerSummary
        ) {
            let sequence = mem.notification_sequence + 1;
            let semanticKey = newFollowerSemanticKey(summary);
            let retained = newFollowerNotificationBytes(summary);
            let notification : Memory.NotificationSummary = {
                local_sequence = sequence;
                received_at_ns = summary.received_at_ns;
                actor_ = summary.node;
                kind = ?#new_follower({
                    follower_revision = summary.resulting_revision;
                });
                verification = ?#transport_authenticated;
                read = false;
                semantic_key = semanticKey;
                retain_until_ns = addSaturating(
                    summary.received_at_ns,
                    mem.retention.peer_records_ns,
                );
                retained_bytes = retained;
            };
            Map.add(
                mem.notifications,
                Nat64.compare,
                sequence,
                notification,
            );
            Map.add(
                mem.notification_order,
                Nat64.compare,
                sequence,
                (),
            );
            Map.add(
                mem.notification_by_semantic,
                Text.compare,
                semanticKey,
                sequence,
            );
            Map.add(
                mem.unread_notifications,
                Nat64.compare,
                sequence,
                (),
            );
            mem.notification_sequence := sequence;
            mem.notification_revision += 1;
            mem.notification_count += 1;
            mem.notification_bytes += retained;
            mem.unread_notification_count += 1;
        };

        func commitBlockMutation(
            mutation : RelationshipTypes.BlockMutation
        ) : Bool {
            if (
                mem.follower_revision !=
                    mutation.expected_counters.follower_revision or
                mem.follower_registration_sequence !=
                    mutation.expected_counters.max_registration_sequence or
                mutation.expected_counters.follower_revision ==
                    Nat64.maxValue or
                mutation.next_counters.follower_revision !=
                    mutation.expected_counters.follower_revision + 1 or
                mutation.next_counters.max_registration_sequence !=
                    mutation.expected_counters.max_registration_sequence or
                mem.relationship_revision == Nat64.maxValue or
                mem.state_revision == Nat64.maxValue
            ) return false;
            let current = Map.get(
                mem.blocks,
                Principal.compare,
                mutation.node,
            );
            switch (current, mutation.expected_storage_revision) {
                case (null, null) {
                    switch (mutation.next_row) {
                        case (?next) {
                            if (
                                next.storage_revision != 1 or
                                mem.block_count >=
                                    mem.quota_limits.block_count
                            ) return false;
                        };
                        case null return false;
                    };
                };
                case (?value, ?expected) {
                    if (value.storage_revision != expected) return false;
                    switch (mutation.next_row) {
                        case (?next) {
                            if (next != value) return false;
                        };
                        case null {};
                    };
                };
                case (_) return false;
            };
            switch (mutation.next_row) {
                case (?next) {
                    if (
                        not Principal.equal(next.node, mutation.node) or
                        next.storage_revision == 0
                    ) return false;
                };
                case null {};
            };
            if (
                mutation.next_row == null and (
                    mutation.follower_mutation != null or
                    mutation.following_mutation != null
                )
            ) return false;
            switch (mutation.follower_mutation) {
                case null {};
                case (?change) {
                    if (
                        not Principal.equal(change.node, mutation.node) or
                        change.expected_counters !=
                            mutation.expected_counters or
                        change.next_counters != mutation.next_counters or
                        change.new_follower_summary != null or
                        not validBlockFollowerClosure(change) or
                        not canCommitFollowerMutation(change)
                    ) return false;
                };
            };
            switch (mutation.following_mutation) {
                case null {};
                case (?change) {
                    if (
                        not Principal.equal(change.node, mutation.node) or
                        not validBlockFollowingClosure(change) or
                        not canCommitFollowingMutation(change)
                    ) return false;
                };
            };
            switch (mutation.next_row) {
                case null {
                    Map.remove(
                        mem.blocks,
                        Principal.compare,
                        mutation.node,
                    );
                    if (current != null) mem.block_count -= 1;
                };
                case (?next) {
                    Map.add(
                        mem.blocks,
                        Principal.compare,
                        mutation.node,
                        next,
                    );
                    if (current == null) mem.block_count += 1;
                };
            };
            switch (mutation.following_mutation) {
                case (?change) applyFollowingMutation(change, true);
                case null {};
            };
            switch (mutation.follower_mutation) {
                case (?change) applyFollowerMutation(change);
                case null {};
            };
            mem.follower_revision :=
                mutation.next_counters.follower_revision;
            mem.follower_registration_sequence :=
                mutation.next_counters.max_registration_sequence;
            mem.relationship_revision += 1;
            mem.state_revision += 1;
            true;
        };

        func validBlockFollowingClosure(
            mutation : RelationshipTypes.FollowingMutation
        ) : Bool {
            let ?current = Map.get(
                mem.following,
                Principal.compare,
                mutation.node,
            ) else return false;
            if (
                mutation.expected_storage_revision !=
                    ?current.storage_revision or
                current.storage_revision == Nat64.maxValue or
                mutation.next_row.storage_revision !=
                    current.storage_revision + 1 or
                mutation.next_row.intent_generation !=
                    current.intent_generation + 1 or
                mutation.next_row.last_remote_revision !=
                    current.last_remote_revision or
                mutation.next_row.renewal_requested or
                mutation.next_row.locally_verified_delivery_count != 0 or
                mutation.next_row.updated_at_ns < current.updated_at_ns
            ) return false;
            switch (current.intent, mutation.next_row.intent) {
                case (#on(before), #off(after)) {
                    Blob.equal(
                        before.subscription_id,
                        after.last_subscription_id,
                    );
                };
                case (#off(before), #off(after)) {
                    current.renewal_requested and
                    Blob.equal(
                        before.last_subscription_id,
                        after.last_subscription_id,
                    );
                };
                case (_) false;
            };
        };

        func validBlockFollowerClosure(
            mutation : RelationshipTypes.FollowerMutation
        ) : Bool {
            let ?current = Map.get(
                mem.followers,
                Principal.compare,
                mutation.node,
            ) else return false;
            if (
                mutation.expected_storage_revision !=
                    ?current.storage_revision or
                current.storage_revision == Nat64.maxValue or
                mutation.next_row.storage_revision !=
                    current.storage_revision + 1 or
                mutation.next_row.registration_sequence !=
                    current.registration_sequence or
                mutation.next_row.funded_at_ns != current.funded_at_ns or
                mutation.next_row.delivery_pause != null or
                mutation.next_row.outstanding_delivery_charges != 0 or
                mem.follower_head_bytes < current.retained_bytes
            ) return false;
            switch (current.state, mutation.next_row.state) {
                case (#active(before), #inactive(after)) {
                    current.head_revision != Nat64.maxValue and
                    mem.active_follower_count > 0 and
                    mutation.next_row.head_revision ==
                        current.head_revision + 1 and
                    Blob.equal(
                        before.subscription_id,
                        after.last_subscription_id,
                    );
                };
                case (#inactive(before), #inactive(after)) {
                    mutation.next_row.head_revision ==
                        current.head_revision and
                    Blob.equal(
                        before.last_subscription_id,
                        after.last_subscription_id,
                    );
                };
                case (_) false;
            };
        };

        func sendQuote(request : SendQuoteRequestV1) : SendQuoteV1 {
            let result = relationships().getSendQuote(
                {
                    send_kind = switch (request.send_kind) {
                        case null null;
                        case (?#post) ?#post;
                        case (?#reply) ?#reply;
                        case (?#share) ?#share;
                        case (?#tombstone) ?#tombstone;
                    };
                    estimated_object_bytes = request.estimated_object_bytes;
                    notice_target = request.notice_target;
                },
                nowNs(),
            );
            let #ok(value) = result else {
                Runtime.trap("The Wagyu send quote request is unavailable");
            };
            value;
        };

        func relationshipPage(
            request : RelationshipPageRequestV1
        ) : RelationshipsV1 {
            let limit = Nat16.toNat(request.limit);
            if (limit == 0 or limit > Paging.MAX_PAGE_SIZE) {
                Runtime.trap(
                    "Relationship page limit must be between 1 and 50"
                );
            };
            switch (request.expected_revision) {
                case (?expected) {
                    if (expected != mem.relationship_revision) {
                        Runtime.trap(
                            "Relationship page revision changed"
                        );
                    };
                };
                case null {};
            };
            let page = Paging.descendingPrincipalUnion(
                mem.following,
                mem.followers,
                mem.blocks,
                request.before_node,
                limit,
            );
            let values = List.empty<RelationshipSummaryV1>();
            for (peer in page.nodes.vals()) {
                List.add(values, relationshipSummary(peer));
            };
            {
                revision = mem.relationship_revision;
                items = List.toArray(values);
                next_before_node = page.next_before;
            };
        };

        func ownerFollow(
            request : FollowRequestV1
        ) : LocalResultV1<RelationshipSummaryV1> {
            if (
                not networkConfigured() or
                not validRemoteNode(request.node) or
                not Validation.subscriptionId(request.subscription_id) or
                isZero(request.subscription_id)
            ) return #err(if (networkConfigured()) #invalid else #not_configured);
            if (Map.get(mem.blocks, Principal.compare, request.node) != null) {
                return #err(#conflict);
            };
            let now = nowNs();
            let current = Map.get(
                mem.following,
                Principal.compare,
                request.node,
            );
            let subscription = switch (current) {
                case (?current) {
                    switch (current.intent) {
                        case (#on(active)) {
                            if (active.status == #registering) {
                                return #ok(relationshipSummary(request.node));
                            };
                            // Renewal always preserves the established
                            // subscription identity. Browser-generated fresh
                            // randomness must not turn a renewal into a
                            // conflicting replacement subscription.
                            active.subscription_id;
                        };
                        case (#off(_)) request.subscription_id;
                    };
                };
                case null request.subscription_id;
            };
            if (
                mem.outbox_count >= mem.quota_limits.outbox_count or
                mem.outbox_sequence == Nat64.maxValue
            ) return #err(#full);
            let expectedGeneration = switch (current) {
                case null 0;
                case (?value) value.intent_generation;
            };
            let nextGeneration = expectedGeneration + 1;
            let remoteRevision = switch (current) {
                case null (0 : Nat64);
                case (?value) {
                    switch (value.last_remote_revision) {
                        case null (0 : Nat64);
                        case (?revision) revision;
                    };
                };
            };
            let body = Wire.encodeFollowBody({
                expected_revision = remoteRevision;
                subscription_id = subscription;
            });
            let ?prepared = prepareOwnerDispatch(
                request.node,
                Bounds.FOLLOW_ROUTE,
                "wagyu.owner-follow-operation.v1",
                subscription,
                nextGeneration,
                body,
                now,
            ) else return #err(#unsupported);
            let localId = mem.outbox_sequence + 1;
            pendingOutboxMetadata := ?{
                local_id = localId;
                linked_action_key = null;
                fanout_job_id = null;
                follower_registration_sequence = null;
                following_intent_generation = ?nextGeneration;
                encoded_renewal_requested = null;
                retained_bytes = 128;
            };
            let started = relationships().beginFollowing(
                {
                    node = request.node;
                    expected_intent_generation = expectedGeneration;
                    subscription_id = subscription;
                },
                now,
            );
            switch (started) {
                case (#err(error)) {
                    pendingOutboxMetadata := null;
                    return mapFollowingError(error);
                };
                case (#ok(_)) {};
            };
            let enqueue = outboxServiceFor(backendCalls).enqueue(
                {
                    local_id = localId;
                    prepared;
                    delivery_subscription_id = null;
                    encoded_renewal_requested = null;
                },
                now,
            );
            pendingOutboxMetadata := null;
            switch (enqueue) {
                case (#queued(_)) {};
                case (#existing(_)) {
                    Runtime.trap("Wagyu owner Follow operation collided");
                };
                case (#err(_)) {
                    Runtime.trap("Wagyu owner Follow enqueue invariant failed");
                };
            };
            #ok(relationshipSummary(request.node));
        };

        func ownerAutoRenew(
            peer : Principal
        ) : LocalResultV1<RelationshipSummaryV1> {
            let summary = relationshipSummary(peer);
            if (not summary.following_auto_renew_due) {
                return #ok(summary);
            };
            let ?current = Map.get(
                mem.following,
                Principal.compare,
                peer,
            ) else return #ok(summary);
            let subscription = switch (current.intent) {
                case (#off(_)) return #ok(summary);
                case (#on(on)) on.subscription_id;
            };
            ownerFollow({
                node = peer;
                subscription_id = subscription;
            });
        };

        func ownerUnfollow(
            request : NodeRequestV1
        ) : LocalResultV1<RelationshipSummaryV1> {
            if (not networkConfigured()) return #err(#not_configured);
            let ?current = Map.get(
                mem.following,
                Principal.compare,
                request.node,
            ) else return #err(#not_found);
            let subscription = switch (current.intent) {
                case (#off(_)) return #ok(relationshipSummary(request.node));
                case (#on(value)) value.subscription_id;
            };
            if (
                mem.outbox_count >= mem.quota_limits.outbox_count or
                mem.outbox_sequence == Nat64.maxValue
            ) return #err(#full);
            let now = nowNs();
            let nextGeneration = current.intent_generation + 1;
            let expectedRemoteRevision = switch (
                current.last_remote_revision
            ) {
                case null (0 : Nat64);
                case (?value) value;
            };
            let body = Wire.encodeUnfollowBody({
                expected_revision = expectedRemoteRevision;
                subscription_id = subscription;
            });
            let ?prepared = prepareOwnerDispatch(
                request.node,
                Bounds.UNFOLLOW_ROUTE,
                "wagyu.owner-unfollow-operation.v1",
                subscription,
                nextGeneration,
                body,
                now,
            ) else return #err(#unsupported);
            let localId = mem.outbox_sequence + 1;
            pendingOutboxMetadata := ?{
                local_id = localId;
                linked_action_key = null;
                fanout_job_id = null;
                follower_registration_sequence = null;
                following_intent_generation = ?nextGeneration;
                encoded_renewal_requested = null;
                retained_bytes = 128;
            };
            switch (
                relationships().endFollowing(
                    {
                        node = request.node;
                        expected_intent_generation =
                            current.intent_generation;
                    },
                    now,
                )
            ) {
                case (#err(error)) {
                    pendingOutboxMetadata := null;
                    return mapFollowingError(error);
                };
                case (#ok(_)) {};
            };
            let enqueue = outboxServiceFor(backendCalls).enqueue(
                {
                    local_id = localId;
                    prepared;
                    delivery_subscription_id = null;
                    encoded_renewal_requested = null;
                },
                now,
            );
            pendingOutboxMetadata := null;
            switch (enqueue) {
                case (#queued(_)) {};
                case (_) {
                    Runtime.trap(
                        "Wagyu owner Unfollow enqueue invariant failed"
                    );
                };
            };
            #ok(relationshipSummary(request.node));
        };

        func ownerBlock(
            peer : Principal
        ) : LocalResultV1<RelationshipSummaryV1> {
            if (not networkConfigured()) return #err(#not_configured);
            switch (relationships().block(peer, nowNs())) {
                case (#changed or #unchanged) {
                    #ok(relationshipSummary(peer));
                };
                case (#err(#invalid_request or #self_call)) #err(#invalid);
                case (#err(#full)) #err(#full);
                case (#err(_)) #err(#conflict);
            };
        };

        func ownerUnblock(
            peer : Principal
        ) : LocalResultV1<RelationshipSummaryV1> {
            if (not networkConfigured()) return #err(#not_configured);
            switch (relationships().unblock(peer)) {
                case (#changed or #unchanged) {
                    #ok(relationshipSummary(peer));
                };
                case (#err(#invalid_request or #self_call)) #err(#invalid);
                case (#err(#full)) #err(#full);
                case (#err(_)) #err(#conflict);
            };
        };

        func prepareOwnerDispatch(
            target : Principal,
            route : Text,
            domain : Text,
            subscriptionId : Blob,
            intentGeneration : Nat,
            exactBody : Blob,
            createdAt : Nat64,
        ) : ?TransportTypes.PreparedDispatchV1 {
            let ?digest = Hash.lpHash(
                domain,
                [
                    Principal.toBlob(target),
                    subscriptionId,
                    Text.encodeUtf8(Nat.toText(intentGeneration)),
                ],
            ) else return null;
            let bytes = Blob.toArray(digest);
            if (bytes.size() < Bounds.OPERATION_ID_BYTES) return null;
            let operationId = Blob.fromArray(
                Array.tabulate<Nat8>(
                    Bounds.OPERATION_ID_BYTES,
                    func(index) { bytes[index] },
                )
            );
            if (isZero(operationId)) return null;
            switch (
                Dispatcher.Dispatcher(node, backendCalls).prepare({
                    target;
                    route;
                    operation_id = operationId;
                    exact_body_candid = exactBody;
                    created_at_ns = createdAt;
                })
            ) {
                case (#ok(prepared)) ?prepared;
                case (#err(_)) null;
            };
        };

        func mapFollowingError(
            error : RelationshipTypes.FollowingError
        ) : LocalResultV1<RelationshipSummaryV1> {
            switch (error) {
                case (#invalid_request or #self_call) #err(#invalid);
                case (#blocked or #conflict(_)) #err(#conflict);
                case (#full) #err(#full);
                case (#not_found) #err(#not_found);
                case (_) #err(#busy);
            };
        };

        func relationshipSummary(peer : Principal) : RelationshipSummaryV1 {
            let following = Map.get(mem.following, Principal.compare, peer);
            let follower = Map.get(mem.followers, Principal.compare, peer);
            let blocked = Map.get(mem.blocks, Principal.compare, peer) != null;
            let at = nowNs();
            let (credits, lease) = switch (follower) {
                case (?value) {
                    switch (value.state) {
                        case (#active(active)) (
                            active.delivery_credits,
                            ?active.lease_expires_ns,
                        );
                        case (_) ((0 : Nat16), null);
                    };
                };
                case null ((0 : Nat16), null);
            };
            let followingState : ?RelationshipStateV1 = switch (following) {
                case null null;
                case (?value) {
                    if (blocked) {
                        ?#blocked;
                    } else {
                        switch (value.intent) {
                            case (#off(_)) ?#expired;
                            case (#on(active)) {
                                switch (active.status) {
                                    case (#registering) ?#registering;
                                    case (#active) ?#active;
                                    case (#uncertain or #conflicted) {
                                        ?#cleanup_pending;
                                    };
                                    case (#incompatible) ?#incompatible;
                                };
                            };
                        };
                    };
                };
            };
            let followerState : ?RelationshipStateV1 = switch (follower) {
                case null null;
                case (?value) {
                    if (blocked) {
                        ?#blocked;
                    } else {
                        switch (value.state) {
                            case (#inactive(_)) ?#expired;
                            case (#active(active)) {
                                switch (value.delivery_pause) {
                                    case (?#blocked) ?#blocked;
                                    case (?#incompatible) ?#incompatible;
                                    case (?#not_following) ?#expired;
                                    case null {
                                        if (active.lease_expires_ns <= at) {
                                            ?#expired;
                                        } else if (
                                            active.delivery_credits == 0
                                        ) {
                                            ?#credit_low;
                                        } else ?#active;
                                    };
                                };
                            };
                        };
                    };
                };
            };
            let compatible =
                followingState != ?#incompatible and
                followerState != ?#incompatible;
            let actionableRenewalDue = switch (following) {
                case null false;
                case (?value) {
                    RelationshipService.followingAutoRenewActionable(
                        followingView(value),
                        at,
                        blocked,
                        compatible,
                    );
                };
            };
            let autoRenewDue =
                followingState == ?#active and
                actionableRenewalDue;
            {
                node = peer;
                following = switch (following) {
                    case (?value) {
                        switch (value.intent) {
                            case (#on(_)) true;
                            case (#off(_)) false;
                        };
                    };
                    case null false;
                };
                follower = switch (follower) {
                    case (?value) {
                        switch (value.state) {
                            case (#active(_)) true;
                            case (_) false;
                        };
                    };
                    case null false;
                };
                following_state = followingState;
                follower_state = followerState;
                follower_delivery_credits = credits;
                follower_lease_expires_ns = lease;
                following_renewal_requested = switch (following) {
                    case null false;
                    case (?value) value.renewal_requested;
                };
                following_auto_renew_due = autoRenewDue;
                blocked;
                bond_cycles = Bounds.FOLLOW.required_cycles;
                protocol = PROTOCOL;
                compatible;
            };
        };

        func promoteFeedCandidate(
            request : FeedPromoteRequestV1
        ) : LocalResultV1<Nat64> {
            if (not networkConfigured()) return #err(#not_configured);
            if (
                not Validation.blob32(request.candidate_id) or
                not Principal.isCanister(request.verified_author) or
                not Validation.blob32(request.verified_post_id) or
                not Validation.blob32(request.verified_body_hash) or
                not Validation.blob32(request.verified_object_digest)
            ) return #err(#invalid);
            let store = promotionFeedStore();
            let ?candidate = store.find_candidate(request.candidate_id)
            else return #err(#not_found);
            if (
                not FeedVisibility.allows(
                    candidate.immediate_sender,
                    ?request.verified_author,
                    candidate.event_kind == #tombstone,
                    isBlockedNode,
                )
            ) return #err(#conflict);
            let verifiedAt = nowNs();
            let prepared = FeedPromotion.prepare(
                currentProfile().network_id,
                candidate,
                {
                    author = request.verified_author;
                    post_id = request.verified_post_id;
                    body_hash = request.verified_body_hash;
                    object_digest = request.verified_object_digest;
                },
                verifiedAt,
                addSaturating(
                    verifiedAt,
                    mem.retention.peer_records_ns,
                ),
            );
            let plan = switch (prepared) {
                case (#ok(value)) value;
                case (#err(#invalid)) return #err(#invalid);
                case (#err(#mismatch)) return #err(#conflict);
                case (#err(#incompatible)) return #err(#unsupported);
            };
            let service = FeedService.Service(store);
            let outcome = switch (plan) {
                case (#delivery(value)) {
                    service.promoteDelivery(value);
                };
                case (#tombstone(value)) {
                    service.promoteTombstone(value);
                };
            };
            if (candidate.verification != #verified) {
                switch (outcome) {
                    case (
                        #promoted(_) or
                        #merged(_) or
                        #suppressed(_) or
                        #duplicate(_)
                    ) {
                        switch (
                            relationships()
                                .recordLocallyVerifiedDelivery(
                                    candidate.immediate_sender,
                                    candidate.subscription_id,
                                )
                        ) {
                            case (#changed(_) or #unchanged) {
                                // The same owner-authorized update that
                                // durably verifies a delivery also queues the
                                // count-based renewal as soon as it is due.
                                // A transient full outbox is retried by the
                                // next verified promotion.
                                ignore ownerAutoRenew(
                                    candidate.immediate_sender
                                );
                            };
                            // There is no await between the candidate read,
                            // feed commit, and relationship commit. A failed
                            // accounting commit therefore indicates corrupt
                            // or exhausted local state; trap so this entire
                            // update, including the feed promotion, rolls
                            // back atomically.
                            case (#err(_)) {
                                Runtime.trap(
                                    "Wagyu could not commit verified delivery accounting"
                                );
                            };
                        };
                    };
                    case (#quarantined(_) or #err(_)) {};
                };
            };
            feedPromotionResult(outcome);
        };

        func rejectFeedCandidate(
            request : FeedRejectRequestV1
        ) : LocalResultV1<Nat64> {
            let next = switch (request.disposition) {
                case (?#invalid) (#invalid : FeedTypes.VerificationStateV1);
                case (?#unavailable) #unavailable;
                case null return #err(#invalid);
            };
            if (request.candidate_id.size() != Bounds.HASH_BYTES) {
                return #err(#invalid);
            };
            let outcome = FeedService.Service(
                promotionFeedStore()
            ).markVerification({
                candidate_id = request.candidate_id;
                verification = next;
            });
            feedVerificationResult(outcome);
        };

        func updateNotificationVerification(
            sequence : Nat64,
            requested : ?NotificationVerificationV1,
            verifiedReply : ?OwnerBridgeTypes.VerifiedReplyInputV1,
        ) : LocalResultV1<Nat64> {
            let next : NotificationTypes.NotificationVerificationV1 =
                switch (requested) {
                case (?#verified) #verified;
                case (?#invalid) #invalid;
                case (?#unavailable) #unavailable;
                case (?#pending or ?#transport_authenticated) {
                    return #err(#invalid);
                };
                case null return #err(#invalid);
            };
            let ?stored = ingressNotificationStore().get(sequence)
                else return #err(#not_found);
            if (next == #verified) {
                if (
                    not FeedVisibility.allows(
                        stored.summary.actor_,
                        null,
                        false,
                        isBlockedNode,
                    )
                ) return #err(#conflict);
            };
            switch (stored.summary.kind) {
                case (?#like(_)) {
                    if (verifiedReply != null) return #err(#invalid);
                    return notificationMutationResult(
                        NotificationService.setVerification(
                            promotionLikeNotificationStore(),
                            {
                                local_sequence = sequence;
                                verification = next;
                            },
                        )
                    );
                };
                case (?#reply(_)) {
                    return updateReplyNotificationVerification(
                        stored,
                        next,
                        verifiedReply,
                    );
                };
                case (_) {
                    if (verifiedReply != null) return #err(#invalid);
                };
            };
            let outcome = NotificationService.setVerification(
                promotionNotificationStore(),
                {
                    local_sequence = sequence;
                    verification = next;
                },
            );
            notificationMutationResult(outcome);
        };

        func updateNotificationVerificationAndArmLikeSeal(
            sequence : Nat64,
            requested : ?NotificationVerificationV1,
            verifiedReply : ?OwnerBridgeTypes.VerifiedReplyInputV1,
        ) : async* LocalResultV1<Nat64> {
            let shouldArm = requested == ?#verified and
                isLikeNotification(sequence);
            let result = updateNotificationVerification(
                sequence,
                requested,
                verifiedReply,
            );
            switch (result) {
                case (#ok(_)) if (shouldArm) {
                    ignore await* deferredTimers.arm({
                        key = LIKE_SEAL_TIMER_KEY;
                        delay_seconds = LIKE_SEAL_DELAY_SECONDS;
                        callback = runDeferredLikeSeal;
                    });
                };
                case (_) {};
            };
            result;
        };

        func runDeferredLikeSeal() {
            sealDueLikeBatches(MAX_LIKE_BATCHES_PER_TIMER);
        };

        func isLikeNotification(sequence : Nat64) : Bool {
            switch (notificationStoredView(sequence)) {
                case (?stored) {
                    switch (stored.summary.kind) {
                        case (?#like(_)) true;
                        case (_) false;
                    };
                };
                case null false;
            };
        };

        func updateReplyNotificationVerification(
            stored : NotificationTypes.StoredNotification,
            next : NotificationTypes.NotificationVerificationV1,
            verifiedReply : ?OwnerBridgeTypes.VerifiedReplyInputV1,
        ) : LocalResultV1<Nat64> {
            switch (next, verifiedReply) {
                case (#verified, ?_) {};
                case (#verified, null) return #err(#invalid);
                case (#invalid or #unavailable, null) {};
                case (#invalid or #unavailable, ?_) {
                    return #err(#invalid);
                };
                case (#pending or #transport_authenticated, _) {
                    return #err(#invalid);
                };
            };
            let committedAt = nowNs();
            var commitError : ?LocalErrorV1 = null;
            let base = ingressNotificationStore();
            let outcome = NotificationService.setVerification(
                {
                    base with
                    commit_replace = func(mutation) {
                        switch (
                            commitReplyNotificationReplacement(
                                mutation,
                                next,
                                verifiedReply,
                                committedAt,
                            )
                        ) {
                            case (#ok(_)) true;
                            case (#err(error)) {
                                commitError := ?error;
                                false;
                            };
                        };
                    };
                },
                {
                    local_sequence =
                        stored.summary.local_sequence;
                    verification = next;
                },
            );
            switch (outcome) {
                case (#changed(value)) #ok(value.revision);
                case (#unchanged(value)) {
                    switch (
                        applyReplyIndexVerification(
                            stored.summary,
                            next,
                            verifiedReply,
                            committedAt,
                        )
                    ) {
                        case (#ok(_)) #ok(value.revision);
                        case (#err(error)) #err(error);
                    };
                };
                case (#err(#stale_state)) {
                    switch (commitError) {
                        case null #err(#busy);
                        case (?error) #err(error);
                    };
                };
                case (#err(#not_found)) #err(#not_found);
                case (#err(#revision_exhausted)) #err(#full);
                case (
                    #err(
                        #invalid_transition or
                        #incompatible or
                        #corrupt_state
                    )
                ) #err(#conflict);
            };
        };

        func feedPromotionResult(
            outcome : FeedTypes.PromotionOutcome
        ) : LocalResultV1<Nat64> {
            switch (outcome) {
                case (#promoted(value) or #merged(value) or
                    #suppressed(value) or #duplicate(value)) {
                    #ok(value.revision);
                };
                case (#quarantined(_)) #err(#conflict);
                case (#err(#invalid)) #err(#invalid);
                case (#err(#not_found)) #err(#not_found);
                case (#err(#full(_))) #err(#full);
                case (#err(#invalid_transition or #equivocation)) {
                    #err(#conflict);
                };
                case (#err(#revision_exhausted)) #err(#full);
                case (#err(#stale_state)) #err(#busy);
                case (#err(#corrupt_state)) #err(#conflict);
            };
        };

        func feedVerificationResult(
            outcome : FeedTypes.VerificationOutcome
        ) : LocalResultV1<Nat64> {
            switch (outcome) {
                case (#changed(value) or #unchanged(value)) {
                    #ok(value.revision);
                };
                case (#err(#invalid)) #err(#invalid);
                case (#err(#not_found)) #err(#not_found);
                case (#err(#invalid_transition or #corrupt_state)) {
                    #err(#conflict);
                };
                case (#err(#revision_exhausted)) #err(#full);
                case (#err(#stale_state)) #err(#busy);
            };
        };

        func notificationMutationResult(
            outcome : NotificationTypes.MutationOutcome
        ) : LocalResultV1<Nat64> {
            switch (outcome) {
                case (#changed(value) or #unchanged(value)) {
                    #ok(value.revision);
                };
                case (#err(#not_found)) #err(#not_found);
                case (#err(#invalid_transition or #incompatible or
                    #corrupt_state)) #err(#conflict);
                case (#err(#revision_exhausted)) #err(#full);
                case (#err(#stale_state)) #err(#busy);
            };
        };

        func markNotificationsRead(
            sequences : [Nat64]
        ) : LocalResultV1<Nat64> {
            if (sequences.size() > 50) return #err(#invalid);
            var changed = false;
            for (sequence in sequences.vals()) {
                switch (
                    Map.get(mem.notifications, Nat64.compare, sequence)
                ) {
                    case (?summary) {
                        if (not summary.read) {
                            Map.add(mem.notifications, Nat64.compare, sequence, {
                                summary with read = true;
                            });
                            Map.remove(
                                mem.unread_notifications,
                                Nat64.compare,
                                sequence,
                            );
                            if (mem.unread_notification_count > 0) {
                                mem.unread_notification_count -= 1;
                            };
                            changed := true;
                        };
                    };
                    case null {};
                };
            };
            if (changed) {
                mem.notification_revision := nextRevision(
                    mem.notification_revision
                );
                bumpState();
            };
            #ok(mem.notification_revision);
        };

        func authoredPage(
            request : AuthoredPageRequestV1
        ) : AuthoredPageV1 {
            let limit = Nat16.toNat(request.limit);
            if (limit == 0 or limit > 50) {
                Runtime.trap("Authored page limit must be between 1 and 50");
            };
            let values = List.empty<AuthoredSummaryV1>();
            let postEntries = switch (request.before_sequence) {
                case null Map.reverseEntries(mem.authored_post_order);
                case (?cursor) {
                    Map.reverseEntriesFrom(
                        mem.authored_post_order,
                        Nat64.compare,
                        cursor,
                    );
                };
            };
            let actionEntries = switch (request.before_sequence) {
                case null Map.reverseEntries(mem.authored_action_order);
                case (?cursor) {
                    Map.reverseEntriesFrom(
                        mem.authored_action_order,
                        Nat64.compare,
                        cursor,
                    );
                };
            };
            var nextPost = postEntries.next();
            var nextAction = actionEntries.next();
            var lastSequence : ?Nat64 = null;
            label page while (List.size(values) < limit) {
                let usePost = switch (nextPost, nextAction) {
                    case (null, null) break page;
                    case (?_, null) true;
                    case (null, ?_) false;
                    case (?((postSequence, _)), ?((actionSequence, _))) {
                        postSequence > actionSequence;
                    };
                };
                if (usePost) {
                    let ?((sequence, postKey)) = nextPost
                    else Runtime.trap("Authored post index is corrupt");
                    let ?post = Map.get(
                        mem.authored_posts,
                        Text.compare,
                        postKey,
                    ) else Runtime.trap("Authored post index is corrupt");
                    if (post.body.author_sequence != sequence) {
                        Runtime.trap("Authored post sequence is corrupt");
                    };
                    List.add(values, {
                        sequence;
                        action_kind = ?#post;
                        action_id = Path.hexLower(post.post_id);
                        object_digest = Path.hexLower(post.object_digest);
                        state = authoredPostState(post);
                        created_at_ns = post.created_at_ns;
                        body_markdown = ?post.body.body_markdown;
                        body_length = ?post.body_length;
                        reply_to = switch (post.body.reply_to) {
                            case null null;
                            case (?reply) {
                                ?{
                                    author = reply.author;
                                    post_id = Path.hexLower(reply.post_id);
                                };
                            };
                        };
                        target_post_id = null;
                        local_like_view = ?authoredLocalLikeView(post);
                    });
                    lastSequence := ?sequence;
                    nextPost := postEntries.next();
                } else {
                    let ?((sequence, actionKey)) = nextAction
                    else Runtime.trap("Authored action index is corrupt");
                    let ?action = Map.get(
                        mem.authored_actions,
                        Text.compare,
                        actionKey,
                    ) else Runtime.trap("Authored action index is corrupt");
                    if (action.sequence != sequence) {
                        Runtime.trap("Authored action sequence is corrupt");
                    };
                    List.add(values, {
                        sequence;
                        action_kind = ?authoredActionKind(action.kind);
                        action_id = Path.hexLower(action.action_id);
                        object_digest = Path.hexLower(
                            action.object_digest
                        );
                        state = authoredActionState(action);
                        created_at_ns = action.created_at_ns;
                        body_markdown = null;
                        body_length = null;
                        reply_to = null;
                        target_post_id = ?authoredActionTargetPostId(
                            action.kind
                        );
                        local_like_view = null;
                    });
                    lastSequence := ?sequence;
                    nextAction := actionEntries.next();
                };
            };
            let hasMore = switch (nextPost, nextAction) {
                case (null, null) false;
                case (_) true;
            };
            {
                revision = mem.state_revision;
                items = List.toArray(values);
                next_before_sequence =
                    if (hasMore) lastSequence else null;
            };
        };

        func authoredLocalLikeView(
            post : Memory.AuthoredPost
        ) : {
            post_body_hash_hex : Text;
            unsealed_receipt_count : Nat16;
            unsealed_liker_ids : [Principal];
        } {
            let ?state = Map.get(
                mem.like_states,
                Text.compare,
                post.post_key,
            ) else Runtime.trap(
                "Authored post Like state is missing"
            );
            if (state.post_key != post.post_key) {
                Runtime.trap("Authored post Like state is corrupt");
            };
            let activeCount = Nat16.toNat(
                state.active_segment.receipt_count
            );
            if (
                activeCount !=
                    state.active_segment.accepted_like_keys.size()
            ) Runtime.trap("Active Like segment count is corrupt");
            let dueCount = switch (state.due_segment) {
                case null 0;
                case (?segment) {
                    let count = Nat16.toNat(segment.receipt_count);
                    if (count != segment.accepted_like_keys.size()) {
                        Runtime.trap("Due Like segment count is corrupt");
                    };
                    count;
                };
            };
            let total = activeCount + dueCount;
            if (
                total >
                    Nat16.toNat(
                        mem.quota_limits.unsealed_receipts_per_post
                    ) or
                total > Nat16.toNat(state.unsealed_receipt_count)
            ) Runtime.trap(
                "Authored post unsealed Like accounting is corrupt"
            );
            let likerIds = List.empty<Principal>();
            var inspectedLikers = 0;
            func appendLikers(segment : Memory.LikeSegment) {
                for (acceptedKey in segment.accepted_like_keys.vals()) {
                    let ?accepted = Map.get(
                        mem.accepted_likes,
                        Text.compare,
                        acceptedKey,
                    ) else Runtime.trap(
                        "Unsealed Like receipt is missing"
                    );
                    if (accepted.post_key != post.post_key) {
                        Runtime.trap(
                            "Unsealed Like receipt targets another post"
                        );
                    };
                    inspectedLikers += 1;
                    let browserVerified = switch (
                        Map.get(
                            mem.notifications,
                            Nat64.compare,
                            accepted.notification_sequence,
                        ),
                        Map.get(
                            mem.notification_evidence,
                            Nat64.compare,
                            accepted.notification_sequence,
                        ),
                    ) {
                        case (
                            ?notification,
                            ?#like(evidence),
                        ) {
                            notification.verification == ?#verified and
                            Principal.equal(
                                notification.actor_,
                                accepted.liker,
                            ) and
                            (
                                switch (notification.kind) {
                                    case (?#like(info)) {
                                        Blob.equal(
                                            info.target_post_id,
                                            accepted.post_id,
                                        ) and
                                        Blob.equal(
                                            info.target_body_hash,
                                            accepted.post_body_hash,
                                        ) and
                                        Blob.equal(
                                            info.action_id,
                                            accepted.like_id,
                                        ) and
                                        Blob.equal(
                                            info.object_digest,
                                            accepted.object_digest,
                                        ) and
                                        info.object_length ==
                                            accepted.body_length;
                                    };
                                    case (_) false;
                                }
                            ) and
                            evidence.accepted_like_key == acceptedKey and
                            Blob.equal(
                                evidence
                                    .exact_certified_like_receipt_candid,
                                accepted
                                    .exact_certified_like_receipt_candid,
                            );
                        };
                        case (_) false;
                    };
                    if (
                        browserVerified and
                        FeedVisibility.allows(
                            accepted.liker,
                            null,
                            false,
                            isBlockedNode,
                        )
                    ) {
                        List.add(likerIds, accepted.liker);
                    };
                };
            };
            switch (state.due_segment) {
                case (?segment) appendLikers(segment);
                case null {};
            };
            appendLikers(state.active_segment);
            if (inspectedLikers != total) {
                Runtime.trap(
                    "Authored post unsealed Like identities are corrupt"
                );
            };
            let visibleTotal = List.size(likerIds);
            {
                post_body_hash_hex = Path.hexLower(post.body_hash);
                unsealed_receipt_count =
                    Nat16.fromNat(visibleTotal);
                unsealed_liker_ids = List.toArray(likerIds);
            };
        };

        func outboxState() : OutboxTypes.State {
            {
                item = func(localId : Nat64) : ?OutboxTypes.Item {
                    Map.get(mem.outbox, Nat64.compare, localId);
                };
                find_operation = func(
                    target : Principal,
                    route : Text,
                    operationId : Blob,
                ) : ?OutboxTypes.Item {
                    let ?localId = Map.get(
                        mem.outbox_by_operation,
                        outboxOperationCompare,
                        (target, route, operationId),
                    ) else return null;
                    Map.get(mem.outbox, Nat64.compare, localId);
                };
                count = func() : Nat { mem.outbox_count };
                page_after = func(
                    after : ?Nat64,
                    limit : Nat,
                ) : [OutboxTypes.Item] {
                    let values = List.empty<OutboxTypes.Item>();
                    label collect for (
                        (localId, item) in Map.entries(mem.outbox)
                    ) {
                        let includeEntry = switch (after) {
                            case null true;
                            case (?cursor) localId > cursor;
                        };
                        if (includeEntry) {
                            List.add(values, item);
                            if (List.size(values) >= limit) break collect;
                        };
                    };
                    List.toArray(values);
                };
                due_page = func(
                    afterLocalId : ?Nat64,
                    limit : Nat,
                ) : ?OutboxTypes.DueIndexPage {
                    var afterKey : ?OutboxTypes.DueIndexKey = null;
                    switch (afterLocalId) {
                        case null {};
                        case (?localId) {
                            switch (
                                Map.get(
                                    mem.outbox,
                                    Nat64.compare,
                                    localId,
                                )
                            ) {
                                case null {};
                                case (?row) {
                                    switch (row.next_attempt_at_ns) {
                                        case null {};
                                        case (?retryAt) {
                                            let key = (retryAt, localId);
                                            if (
                                                Map.get(
                                                    mem.outbox_by_retry_time,
                                                    orderedTimeCompare,
                                                    key,
                                                ) != ?localId
                                            ) return null;
                                            afterKey := ?key;
                                        };
                                    };
                                };
                            };
                        };
                    };
                    let source = switch (afterKey) {
                        case null {
                            Map.entries(mem.outbox_by_retry_time);
                        };
                        case (?cursor) {
                            Map.entriesFrom(
                                mem.outbox_by_retry_time,
                                orderedTimeCompare,
                                cursor,
                            );
                        };
                    };
                    let values =
                        List.empty<OutboxTypes.DueIndexEntry>();
                    var count = 0;
                    label collect for ((key, localId) in source) {
                        let strictlyAfter = switch (afterKey) {
                            case null true;
                            case (?cursor) {
                                key.0 > cursor.0 or
                                (
                                    key.0 == cursor.0 and
                                    key.1 > cursor.1
                                );
                            };
                        };
                        if (strictlyAfter) {
                            if (count >= limit) break collect;
                            if (key.1 != localId) return null;
                            let ?item = Map.get(
                                mem.outbox,
                                Nat64.compare,
                                localId,
                            ) else return null;
                            if (
                                item.local_id != localId or
                                item.next_attempt_at_ns != ?key.0
                            ) return null;
                            List.add(values, { key; item });
                            count += 1;
                        };
                    };
                    ?{
                        after_key = afterKey;
                        entries = List.toArray(values);
                    };
                };
                control = func() : OutboxTypes.Control {
                    mem.outbox_control;
                };
                commit = commitOutboxMutation;
                commit_control = commitOutboxControl;
            };
        };

        func outboxServiceFor(
            calls : NeutronCapabilities.BackendCallsV1
        ) : OutboxService.Service {
            let transport = Dispatcher.Dispatcher(node, calls);
            OutboxService.Service(
                outboxState(),
                relationships().creditPlanner(),
                transport.validPrepared,
            );
        };

        func outboxOperationCompare(
            left : Memory.OutboxOperationKey,
            right : Memory.OutboxOperationKey,
        ) : Order.Order {
            switch (Principal.compare(left.0, right.0)) {
                case (#equal) {
                    switch (Text.compare(left.1, right.1)) {
                        case (#equal) Blob.compare(left.2, right.2);
                        case (order) order;
                    };
                };
                case (order) order;
            };
        };

        func orderedTimeCompare(
            left : Memory.OrderedTimeKey,
            right : Memory.OrderedTimeKey,
        ) : Order.Order {
            switch (Nat64.compare(left.0, right.0)) {
                case (#equal) Nat64.compare(left.1, right.1);
                case (order) order;
            };
        };

        func retentionIndexCompare(
            left : Memory.RetentionIndexKey,
            right : Memory.RetentionIndexKey,
        ) : Order.Order {
            switch (Nat64.compare(left.0, right.0)) {
                case (#equal) {
                    switch (Nat8.compare(left.1, right.1)) {
                        case (#equal) Nat64.compare(left.2, right.2);
                        case (order) order;
                    };
                };
                case (order) order;
            };
        };

        // Retention maintenance is deliberately driven from the same bounded
        // task that drains the outbox. The expiry map is ordered by
        // (time, domain, suffix), so entriesFrom plus one lookahead never
        // scans more than the requested page and one row.
        func prepareSingleRetention(
            view : RetentionTypes.RecordView
        ) : ?RetentionTypes.RegistrationPlan {
            switch (
                RetentionService.prepareRegistration(
                    {
                        peer_records_ns =
                            mem.retention.peer_records_ns;
                        likes_ns = mem.retention.likes_ns;
                        rate_window_ns =
                            mem.retention.rate_window_ns;
                    },
                    mem.retention_sequence,
                    view,
                )
            ) {
                case (#err(_)) null;
                case (#ok(value)) {
                    if (canApplyRetentionRegistration(value)) {
                        ?value;
                    } else null;
                };
            };
        };

        type CertifiedRevocationPreflight = {
            record : Memory.CertifiedRecord;
            journal : PublicationJournal.Plan;
        };

        func prepareCertifiedRevocation(
            record : Memory.CertifiedRecord,
            localObjectKey : Text,
        ) : ?CertifiedRevocationPreflight {
            if (
                record.identity.target.collection == #profile or
                record.local_object_key != ?localObjectKey or
                record.identity.kernel_revision == Nat64.maxValue or
                certifiedRecordForLocalObject(localObjectKey) !=
                    ?record
            ) return null;
            let mutations = switch (
                PublicationJournal.deleteRecord(record.identity)
            ) {
                case (#err(_)) return null;
                case (#ok(value)) value;
            };
            let nonce = derivedNonce(
                "wagyu.certified-revocation-nonce.v1",
                Text.encodeUtf8(localObjectKey),
                record.identity.content_tag,
            );
            let fingerprint = switch (
                Hash.lpHash(
                    "wagyu.certified-revocation-fingerprint.v1",
                    [
                        to_candid (record.identity.target),
                        to_candid (record.identity.kernel_revision),
                        record.identity.content_tag,
                    ],
                )
            ) {
                case null return null;
                case (?value) value;
            };
            let ?journal = preparePublicationJournal(
                #revocation,
                nonce,
                fingerprint,
                mutations,
            ) else return null;
            ?{ record; journal };
        };

        func commitCertifiedRevocation(
            preflight : CertifiedRevocationPreflight,
            committedAt : Nat64,
        ) : Bool {
            let expected = preflight.record.identity;
            let receipt = switch (
                certifiedAssets.commit_batch({
                    nonce = preflight.journal.request_nonce;
                    operations = [
                        #delete({
                            target =
                                memoryTargetToCapability(expected.target);
                            condition = {
                                revision = expected.kernel_revision;
                                content_tag = expected.content_tag;
                            };
                        }),
                    ];
                    requires_present_after = [];
                })
            ) {
                case (#err(_)) return false;
                case (#ok(value)) value;
            };
            let ?_deleted = committedDeletion(receipt, expected)
            else Runtime.trap(
                "Wagyu kernel returned an invalid revocation receipt"
            );
            let publicationId = nextPublicationId();
            rememberCommittedRevocation(
                publicationId,
                preflight.journal,
                expected,
                committedAt,
            );
            removeRevokedCertifiedRecord(preflight.record);
            true;
        };

        func retentionState() : RetentionTypes.State {
            {
                policy = func() : RetentionTypes.Policy {
                    {
                        peer_records_ns =
                            mem.retention.peer_records_ns;
                        likes_ns = mem.retention.likes_ns;
                        rate_window_ns =
                            mem.retention.rate_window_ns;
                    };
                };
                retention_sequence = func() : Nat64 {
                    mem.retention_sequence;
                };
                cleanup_epoch = func() : Nat64 {
                    mem.cleanup_epoch;
                };
                current = currentRetentionEntry;
                page_expired = retentionExpiredPage;
                inspect = inspectRetentionEntry;
                commit_cleanup = commitRetentionCleanup;
            };
        };

        func revokeOneDueRetainedObject(now : Nat64) : Bool {
            var scanned = 0;
            label entries for (
                (indexKey, record) in Map.entries(mem.retention_order)
            ) {
                if (
                    indexKey.0 > now or
                    scanned >= RetentionService.MAX_CLEANUP_PAGE
                ) break entries;
                scanned += 1;
                let isCurrent = switch (
                    currentRetentionEntry(record)
                ) {
                    case null false;
                    case (?entry) entry.key == indexKey;
                };
                if (isCurrent) {
                    switch (record) {
                        case (#authored_post(postKey)) {
                            if (
                                revokeDueAuthoredPost(
                                    postKey,
                                    indexKey,
                                    now,
                                )
                            ) return true;
                        };
                        case (#authored_action(actionKey)) {
                            if (
                                revokeDueAuthoredAction(
                                    actionKey,
                                    indexKey,
                                    now,
                                )
                            ) return true;
                        };
                        case (#sealed_like_batch(batchKey)) {
                            if (
                                revokeDueSealedLikeBatch(
                                    batchKey,
                                    indexKey,
                                    now,
                                )
                            ) return true;
                        };
                        case (_) {};
                    };
                };
            };
            false;
        };

        // Certified Assets permits one conditional delete per revocation
        // batch. A withdrawn post therefore retires its optional ReplyIndex,
        // head, post, and tombstone over durable phases; the final phase only
        // removes local rows after every certified deletion and dependent
        // retention row is complete.
        func revokeDueAuthoredPost(
            postKey : Text,
            retentionKey : Memory.RetentionIndexKey,
            now : Nat64,
        ) : Bool {
            let ?post = Map.get(
                mem.authored_posts,
                Text.compare,
                postKey,
            ) else return false;
            if (
                post.post_key != postKey or
                post.retention_expires_at_ns > now or
                Map.get(
                    mem.authored_post_order,
                    Nat64.compare,
                    post.body.author_sequence,
                ) != ?postKey
            ) return false;
            let info = switch (post.status) {
                case (#withdrawn(value)) value;
                case (_) return false;
            };
            let retentionRecord : Memory.RetentionRecordRef =
                #authored_post(postKey);
            let ?currentRetention = currentRetentionEntry(
                retentionRecord
            ) else return false;
            if (currentRetention.key != retentionKey) return false;

            switch (info.cleanup_phase) {
                case (#retained) {
                    let indexKey = replyIndexStableKey(post.post_id);
                    switch (
                        Map.get(
                            mem.reply_indexes,
                            Text.compare,
                            indexKey,
                        )
                    ) {
                        case (?index) {
                            let indexTarget =
                                index.kernel_identity.target;
                            let targetsPost = switch (
                                indexTarget.key
                            ) {
                                case (#post_id(postId)) {
                                    Blob.equal(postId, post.post_id)
                                };
                                case (_) false;
                            };
                            if (
                                index.index_key != indexKey or
                                not targetsPost or
                                not Principal.equal(
                                    index.value.post_author,
                                    node,
                                ) or
                                not Blob.equal(
                                    index.value.post_id,
                                    post.post_id,
                                ) or
                                not Blob.equal(
                                    index.value.post_body_hash,
                                    post.body_hash,
                                ) or
                                index.value.store_generation !=
                                    indexTarget.collection_generation or
                                Nat32.toNat(
                                    index.kernel_identity.body_length
                                ) != index.exact_body_candid.size() or
                                not Blob.equal(
                                    Hash.objectDigest(
                                        index.exact_body_candid
                                    ),
                                    index.body_digest,
                                ) or
                                not Blob.equal(
                                    index.kernel_identity.body_digest,
                                    index.body_digest,
                                )
                            ) return false;
                            let ?record =
                                certifiedRecordForLocalObject(indexKey)
                                else return false;
                            if (
                                record.identity.target.collection !=
                                    #reply_indexes or
                                record.identity !=
                                    index.kernel_identity or
                                record.publication_id !=
                                    index.publication_id
                            ) return false;
                            let ?revocation =
                                prepareCertifiedRevocation(
                                    record,
                                    indexKey,
                                )
                                else return false;
                            if (
                                not commitCertifiedRevocation(
                                    revocation,
                                    now,
                                )
                            ) return false;
                            Map.remove(
                                mem.reply_indexes,
                                Text.compare,
                                indexKey,
                            );
                            bumpState();
                            return true;
                        };
                        case null {
                            if (
                                certifiedRecordForLocalObject(indexKey) !=
                                    null
                            ) return false;
                        };
                    };
                    let ?head = Map.get(
                        mem.like_heads,
                        Text.compare,
                        post.like_head_key,
                    ) else return false;
                    if (
                        head.head_key != post.like_head_key or
                        Nat32.toNat(
                            head.kernel_identity.body_length
                        ) != head.exact_body_candid.size() or
                        head.exact_body_candid.size() >
                            post.retained_bytes or
                        mem.authored_bytes <
                            head.exact_body_candid.size()
                    ) return false;
                    let ?record = certifiedRecordForLocalObject(
                        post.like_head_key
                    ) else return false;
                    if (
                        record.identity.target.collection != #like_heads or
                        record.identity != head.kernel_identity or
                        not Blob.equal(
                            record.identity.body_digest,
                            head.body_digest,
                        )
                    ) return false;
                    let ?revocation = prepareCertifiedRevocation(
                        record,
                        post.like_head_key,
                    ) else return false;
                    if (not commitCertifiedRevocation(revocation, now)) {
                        return false;
                    };
                    Map.remove(
                        mem.like_heads,
                        Text.compare,
                        post.like_head_key,
                    );
                    Map.add(
                        mem.authored_posts,
                        Text.compare,
                        postKey,
                        {
                            post with
                            status = #withdrawn({
                                info with
                                cleanup_phase = #head_revoked;
                            });
                            retained_bytes =
                                post.retained_bytes -
                                    head.exact_body_candid.size();
                        },
                    );
                    mem.authored_bytes -=
                        head.exact_body_candid.size();
                    bumpState();
                    true;
                };
                case (#head_revoked) {
                    if (
                        Map.get(
                            mem.like_heads,
                            Text.compare,
                            post.like_head_key,
                        ) != null or
                        Map.get(
                            mem.accepted_like_count_by_post,
                            Text.compare,
                            postKey,
                        ) != null
                    ) return false;
                    let ?likeState = Map.get(
                        mem.like_states,
                        Text.compare,
                        postKey,
                    ) else return false;
                    if (
                        likeState.active_segment.receipt_count != 0 or
                        likeState.active_segment.accepted_like_keys.size() !=
                            0 or
                        likeState.due_segment != null or
                        likeState.unsealed_receipt_count != 0 or
                        likeState.unsealed_receipt_bytes != 0 or
                        likeState.retired_batch_prefix !=
                            likeState.next_batch_number
                    ) return false;
                    let ?record = certifiedRecordForLocalObject(postKey)
                    else return false;
                    if (
                        record.identity.target.collection != #posts or
                        not Blob.equal(
                            record.identity.body_digest,
                            post.object_digest,
                        ) or
                        record.identity.body_length != post.body_length
                    ) return false;
                    let ?revocation = prepareCertifiedRevocation(
                        record,
                        postKey,
                    ) else return false;
                    if (not commitCertifiedRevocation(revocation, now)) {
                        return false;
                    };
                    Map.add(
                        mem.authored_posts,
                        Text.compare,
                        postKey,
                        {
                            post with
                            status = #withdrawn({
                                info with
                                cleanup_phase = #post_revoked;
                            });
                        },
                    );
                    bumpState();
                    true;
                };
                case (#post_revoked) {
                    let actionKey = info.tombstone_action_key;
                    let ?action = Map.get(
                        mem.authored_actions,
                        Text.compare,
                        actionKey,
                    ) else return false;
                    if (
                        action.action_key != actionKey or
                        action.retention_expires_at_ns > now or
                        Map.get(
                            mem.authored_action_order,
                            Nat64.compare,
                            action.sequence,
                        ) != ?actionKey or
                        Map.get(
                            mem.tombstones_by_post,
                            Text.compare,
                            postKey,
                        ) != ?actionKey or
                        Map.get(
                            mem.authored_dependency_count_by_key,
                            Text.compare,
                            actionKey,
                        ) != null or
                        mem.authored_action_count == 0 or
                        mem.authored_bytes < action.retained_bytes
                    ) return false;
                    switch (action.kind) {
                        case (#tombstone(value)) {
                            if (
                                not Blob.equal(
                                    value.action.post_id,
                                    post.post_id,
                                )
                            ) return false;
                        };
                        case (_) return false;
                    };
                    let actionRetention :
                        Memory.RetentionRecordRef =
                        #authored_action(actionKey);
                    let ?currentActionRetention =
                        currentRetentionEntry(actionRetention)
                        else return false;
                    let ?record = certifiedRecordForLocalObject(actionKey)
                    else return false;
                    if (
                        record.identity.target.collection != #tombstones or
                        not Blob.equal(
                            record.identity.body_digest,
                            action.object_digest,
                        ) or
                        record.identity.body_length != action.body_length
                    ) return false;
                    let ?revocation = prepareCertifiedRevocation(
                        record,
                        actionKey,
                    ) else return false;
                    if (not commitCertifiedRevocation(revocation, now)) {
                        return false;
                    };
                    Map.remove(
                        mem.authored_actions,
                        Text.compare,
                        actionKey,
                    );
                    Map.remove(
                        mem.authored_action_order,
                        Nat64.compare,
                        action.sequence,
                    );
                    Map.remove(
                        mem.tombstones_by_post,
                        Text.compare,
                        postKey,
                    );
                    removeCurrentRetention(
                        actionRetention,
                        currentActionRetention.key,
                    );
                    Map.add(
                        mem.authored_posts,
                        Text.compare,
                        postKey,
                        {
                            post with
                            status = #withdrawn({
                                info with
                                cleanup_phase =
                                    #tombstone_revoked;
                            });
                        },
                    );
                    mem.authored_action_count -= 1;
                    mem.authored_bytes -= action.retained_bytes;
                    bumpState();
                    true;
                };
                case (#tombstone_revoked) {
                    if (
                        mem.authored_post_count == 0 or
                        mem.authored_bytes < post.retained_bytes or
                        Map.get(
                            mem.like_heads,
                            Text.compare,
                            post.like_head_key,
                        ) != null or
                        Map.get(
                            mem.accepted_like_count_by_post,
                            Text.compare,
                            postKey,
                        ) != null or
                        Map.get(
                            mem.authored_actions,
                            Text.compare,
                            info.tombstone_action_key,
                        ) != null or
                        Map.get(
                            mem.tombstones_by_post,
                            Text.compare,
                            postKey,
                        ) != null or
                        certifiedRecordForLocalObject(postKey) != null or
                        Map.get(
                            mem.reply_indexes,
                            Text.compare,
                            replyIndexStableKey(post.post_id),
                        ) != null or
                        certifiedRecordForLocalObject(
                            replyIndexStableKey(post.post_id)
                        ) != null
                    ) return false;
                    let ?likeState = Map.get(
                        mem.like_states,
                        Text.compare,
                        postKey,
                    ) else return false;
                    if (
                        likeState.retired_batch_prefix !=
                            likeState.next_batch_number
                    ) return false;
                    let nonceKey = authoredPostNonceStableKey(
                        post.body.nonce
                    );
                    if (
                        Map.get(
                            mem.authored_post_by_nonce,
                            Text.compare,
                            nonceKey,
                        ) != ?postKey
                    ) return false;
                    Map.remove(
                        mem.authored_posts,
                        Text.compare,
                        postKey,
                    );
                    Map.remove(
                        mem.authored_post_by_nonce,
                        Text.compare,
                        nonceKey,
                    );
                    Map.remove(
                        mem.authored_post_order,
                        Nat64.compare,
                        post.body.author_sequence,
                    );
                    Map.remove(
                        mem.like_states,
                        Text.compare,
                        postKey,
                    );
                    removeCurrentRetention(
                        retentionRecord,
                        retentionKey,
                    );
                    mem.authored_post_count -= 1;
                    mem.authored_bytes -= post.retained_bytes;
                    bumpState();
                    true;
                };
            };
        };

        func revokeDueAuthoredAction(
            actionKey : Text,
            retentionKey : Memory.RetentionIndexKey,
            now : Nat64,
        ) : Bool {
            let ?action = Map.get(
                mem.authored_actions,
                Text.compare,
                actionKey,
            ) else return false;
            if (
                action.action_key != actionKey or
                action.retention_expires_at_ns > now or
                Map.get(
                    mem.authored_action_order,
                    Nat64.compare,
                    action.sequence,
                ) != ?actionKey or
                Map.get(
                    mem.authored_dependency_count_by_key,
                    Text.compare,
                    actionKey,
                ) != null
            ) return false;
            let expectedCollection = switch (action.kind) {
                case (#share(info)) {
                    if (
                        Map.get(
                            mem.shares_by_original_post,
                            Text.compare,
                            originalPostStableKey(
                                info.action.original_author,
                                info.action.original_post_id,
                            ),
                        ) != ?actionKey
                    ) return false;
                    #shares;
                };
                case (#like(info)) {
                    let markerKey = originalPostStableKey(
                        info.action.post_author,
                        info.action.post_id,
                    );
                    let ?marker = Map.get(
                        mem.outgoing_likes_by_post,
                        Text.compare,
                        markerKey,
                    ) else return false;
                    if (
                        marker.original_post_key != markerKey or
                        marker.live_action_key != ?actionKey or
                        not Blob.equal(
                            marker.like_id,
                            action.action_id,
                        ) or
                        not Blob.equal(
                            marker.object_digest,
                            action.object_digest,
                        ) or
                        marker.retained_bytes >
                            action.retained_bytes
                    ) return false;
                    #likes;
                };
                // A tombstone remains the post's durable withdrawal anchor
                // until the authored post itself completes phased cleanup.
                case (#tombstone(_)) return false;
            };
            if (
                mem.authored_action_count == 0 or
                mem.authored_bytes < action.retained_bytes
            ) return false;
            let ?record = certifiedRecordForLocalObject(actionKey)
            else return false;
            if (
                record.identity.target.collection != expectedCollection or
                not Blob.equal(
                    record.identity.body_digest,
                    action.object_digest,
                ) or
                record.identity.body_length != action.body_length
            ) return false;
            let retentionRecord : Memory.RetentionRecordRef =
                #authored_action(actionKey);
            let ?currentRetention = currentRetentionEntry(
                retentionRecord
            ) else return false;
            if (currentRetention.key != retentionKey) return false;
            let ?revocation = prepareCertifiedRevocation(
                record,
                actionKey,
            ) else return false;
            if (not commitCertifiedRevocation(revocation, now)) {
                return false;
            };
            Map.remove(
                mem.authored_actions,
                Text.compare,
                actionKey,
            );
            Map.remove(
                mem.authored_action_order,
                Nat64.compare,
                action.sequence,
            );
            switch (action.kind) {
                case (#share(info)) {
                    Map.remove(
                        mem.shares_by_original_post,
                        Text.compare,
                        originalPostStableKey(
                            info.action.original_author,
                            info.action.original_post_id,
                        ),
                    );
                    mem.authored_action_count -= 1;
                    mem.authored_bytes -= action.retained_bytes;
                };
                case (#like(info)) {
                    let markerKey = originalPostStableKey(
                        info.action.post_author,
                        info.action.post_id,
                    );
                    let ?marker = Map.get(
                        mem.outgoing_likes_by_post,
                        Text.compare,
                        markerKey,
                    ) else Runtime.trap(
                        "Wagyu outgoing Like marker disappeared"
                    );
                    Map.add(
                        mem.outgoing_likes_by_post,
                        Text.compare,
                        markerKey,
                        {
                            marker with
                            live_action_key = null;
                        },
                    );
                    mem.authored_bytes -=
                        action.retained_bytes -
                            marker.retained_bytes;
                };
                case (#tombstone(_)) Runtime.trap(
                    "Wagyu tombstone escaped retention preflight"
                );
            };
            removeCurrentRetention(
                retentionRecord,
                retentionKey,
            );
            bumpState();
            true;
        };

        func revokeDueSealedLikeBatch(
            batchKey : Text,
            retentionKey : Memory.RetentionIndexKey,
            now : Nat64,
        ) : Bool {
            let ?batch = Map.get(
                mem.sealed_like_batches,
                Text.compare,
                batchKey,
            ) else return false;
            if (
                batch.batch_key != batchKey or
                batch.value.batch_number == Nat64.maxValue
            ) return false;
            let ?post = Map.get(
                mem.authored_posts,
                Text.compare,
                batch.post_key,
            ) else return false;
            let eligibleAt = switch (post.status) {
                case (#withdrawn(info)) {
                    if (
                        info.withdrawn_at_ns <
                            batch.retain_until_ns
                    ) info.withdrawn_at_ns
                    else batch.retain_until_ns;
                };
                case (_) batch.retain_until_ns;
            };
            if (eligibleAt > now) return false;
            let numberKey = sealedLikeBatchNumberStableKey(
                post.post_id,
                batch.value.batch_number,
            );
            if (
                Map.get(
                    mem.sealed_batches_by_post_number,
                    Text.compare,
                    numberKey,
                ) != ?batchKey
            ) return false;
            let ?likeState = Map.get(
                mem.like_states,
                Text.compare,
                batch.post_key,
            ) else return false;
            if (
                likeState.retired_batch_prefix !=
                    batch.value.batch_number or
                likeState.retired_batch_prefix >=
                    likeState.next_batch_number
            ) return false;
            let ?record = certifiedRecordForLocalObject(batchKey)
            else return false;
            if (
                record.identity.target.collection != #like_batches or
                record.identity != batch.kernel_identity or
                not Blob.equal(
                    record.identity.body_digest,
                    batch.body_digest,
                ) or
                record.identity.body_length != batch.body_length
            ) return false;
            let retentionRecord : Memory.RetentionRecordRef =
                #sealed_like_batch(batchKey);
            let ?currentRetention = currentRetentionEntry(
                retentionRecord
            ) else return false;
            if (currentRetention.key != retentionKey) return false;
            let ?revocation = prepareCertifiedRevocation(
                record,
                batchKey,
            ) else return false;
            if (not commitCertifiedRevocation(revocation, now)) {
                return false;
            };
            Map.remove(
                mem.sealed_like_batches,
                Text.compare,
                batchKey,
            );
            Map.remove(
                mem.sealed_batches_by_post_number,
                Text.compare,
                numberKey,
            );
            Map.add(
                mem.like_states,
                Text.compare,
                batch.post_key,
                {
                    likeState with
                    retired_batch_prefix =
                        likeState.retired_batch_prefix + 1;
                },
            );
            removeCurrentRetention(
                retentionRecord,
                retentionKey,
            );
            bumpState();
            true;
        };

        func removeCurrentRetention(
            record : Memory.RetentionRecordRef,
            indexKey : Memory.RetentionIndexKey,
        ) {
            let canonical = RetentionService.canonicalKey(record);
            if (
                Map.get(
                    mem.retention_current,
                    Text.compare,
                    canonical,
                ) != ?indexKey or
                Map.get(
                    mem.retention_order,
                    retentionIndexCompare,
                    indexKey,
                ) != ?record
            ) Runtime.trap(
                "Wagyu retention pointer changed during revocation"
            );
            Map.remove(
                mem.retention_current,
                Text.compare,
                canonical,
            );
            Map.remove(
                mem.retention_order,
                retentionIndexCompare,
                indexKey,
            );
        };

        func retentionExpiredPage(
            after : ?Memory.RetentionIndexKey,
            now : Nat64,
            limit : Nat,
        ) : RetentionTypes.ExpiredPage {
            let rows = List.empty<RetentionTypes.Entry>();
            var complete = true;
            let entries = switch (after) {
                case null Map.entries(mem.retention_order);
                case (?cursor) {
                    Map.entriesFrom(
                        mem.retention_order,
                        retentionIndexCompare,
                        cursor,
                    );
                };
            };
            label collect for ((key, record) in entries) {
                let strictlyAfter = switch (after) {
                    case null true;
                    case (?cursor) {
                        retentionIndexCompare(cursor, key) == #less;
                    };
                };
                if (strictlyAfter) {
                    if (key.0 > now) break collect;
                    if (List.size(rows) == limit) {
                        complete := false;
                        break collect;
                    };
                    List.add(rows, { key; record });
                };
            };
            {
                entries = List.toArray(rows);
                complete;
            };
        };

        // Primary rows with unbounded or incompletely represented reverse
        // dependencies are never guessed safe. Missing primaries still permit
        // their dangling expiry row to be removed.
        func inspectRetentionEntry(
            entry : RetentionTypes.Entry
        ) : RetentionTypes.Inspection {
            switch (entry.record) {
                case (#follower(peer)) {
                    let ?row = Map.get(
                        mem.followers,
                        Principal.compare,
                        peer,
                    ) else return #missing;
                    // An expired/inactive/paused/blocked row cannot be selected
                    // by any current or later fanout cursor. Already queued
                    // deliveries are covered by outstanding_delivery_charges.
                    if (
                        followerEligibleForFanoutAt(
                            row,
                            entry.key.0,
                        )
                    ) return #held(#protected_dependency);
                    switch (
                        Map.get(
                            mem.followers_by_registration,
                            Nat64.compare,
                            row.registration_sequence,
                        )
                    ) {
                        case (?indexed) {
                            if (not Principal.equal(indexed, peer)) {
                                return #held(#missing_cascade);
                            };
                        };
                        case null return #held(#missing_cascade);
                    };
                    #record(#follower({
                        node = row.node;
                        funded_at_ns = row.funded_at_ns;
                        retain_until_ns = row.retain_until_ns;
                        retained_bytes = row.retained_bytes;
                        registration_sequence =
                            row.registration_sequence;
                        active = isActiveFollowerRecord(row);
                        charges_detached =
                            row.outstanding_delivery_charges == 0;
                    }));
                };
                case (#ingress_receipt(key)) {
                    let ?row = Map.get(
                        mem.ingress_receipts,
                        Text.compare,
                        key,
                    ) else return #missing;
                    let dependencyDetached = switch (row.route) {
                        case (#deliver) {
                            let ?candidateId = Hash.feedCandidateId(
                                row.caller,
                                row.operation_id,
                                row.payload_digest,
                            ) else return #held(#missing_cascade);
                            let candidateKey =
                                candidateStableKey(candidateId);
                            switch (
                                Map.get(
                                    mem.feed_candidates,
                                    Text.compare,
                                    candidateKey,
                                )
                            ) {
                                case null true;
                                case (?candidate) {
                                    if (
                                        candidate.route_receipt_key !=
                                            row.receipt_key or
                                        not Principal.equal(
                                            candidate.immediate_sender,
                                            row.caller,
                                        ) or
                                        not Blob.equal(
                                            candidate.operation_id,
                                            row.operation_id,
                                        ) or
                                        not Blob.equal(
                                            candidate.payload_digest,
                                            row.payload_digest,
                                        )
                                    ) return #held(#missing_cascade);
                                    false;
                                };
                            };
                        };
                        case (_) true;
                    };
                    #record(#ingress_receipt({
                        receipt_key = row.receipt_key;
                        route = row.route;
                        received_at_ns = row.received_at_ns;
                        retain_until_ns = row.retain_until_ns;
                        retained_bytes = row.retained_bytes;
                        domain_dependency_detached =
                            dependencyDetached;
                    }));
                };
                case (#caller_rate_window(key)) {
                    let ?row = Map.get(
                        mem.caller_rate_windows,
                        Text.compare,
                        key,
                    ) else return #missing;
                    #record(#caller_rate_window({
                        window_key = key;
                        window_started_at_ns =
                            row.window_started_at_ns;
                        expires_at_ns = row.expires_at_ns;
                        retained_bytes = row.retained_bytes;
                    }));
                };
                case (#notification(sequence)) {
                    let ?row = Map.get(
                        mem.notifications,
                        Nat64.compare,
                        sequence,
                    ) else return #missing;
                    if (
                        Map.get(
                            mem.notification_order,
                            Nat64.compare,
                            sequence,
                        ) == null or
                        Map.get(
                            mem.notification_by_semantic,
                            Text.compare,
                            row.semantic_key,
                        ) != ?sequence or
                        (
                            Map.get(
                                mem.unread_notifications,
                                Nat64.compare,
                                sequence,
                            ) != null
                        ) != (not row.read)
                    ) return #held(#missing_cascade);
                    let noticeTarget = switch (row.kind) {
                        case (?#reply(info)) {
                            ?postStableKey(info.target_post_id);
                        };
                        case (?#share(info)) {
                            ?postStableKey(info.target_post_id);
                        };
                        case (_) null;
                    };
                    #record(#notification({
                        local_sequence = row.local_sequence;
                        received_at_ns = row.received_at_ns;
                        retain_until_ns = row.retain_until_ns;
                        retained_bytes = row.retained_bytes;
                        semantic_key = row.semantic_key;
                        actor_ = row.actor_;
                        unread = not row.read;
                        has_evidence =
                            Map.get(
                                mem.notification_evidence,
                                Nat64.compare,
                                sequence,
                            ) != null;
                        notice_target_key = noticeTarget;
                        notice_semantic_detached =
                            Map.get(
                                mem.notice_semantics,
                                Text.compare,
                                row.semantic_key,
                            ) == null and
                            not notificationAcceptedLikeAttached(
                                sequence
                            );
                    }));
                };
                case (#accepted_like(key)) {
                    let ?row = Map.get(
                        mem.accepted_likes,
                        Text.compare,
                        key,
                    ) else return #missing;
                    if (
                        Map.get(
                            mem.accepted_likes_by_sequence,
                            Nat64.compare,
                            row.accepted_sequence,
                        ) != ?key
                    ) return #held(#missing_cascade);
                    // Notification evidence is the only remaining direct
                    // app-local consumer after a receipt leaves both bounded
                    // unsealed segments. Let notification cleanup detach it
                    // first.
                    if (
                        Map.get(
                            mem.notifications,
                            Nat64.compare,
                            row.notification_sequence,
                        ) != null or
                        Map.get(
                            mem.notification_evidence,
                            Nat64.compare,
                            row.notification_sequence,
                        ) != null
                    ) return #held(#protected_dependency);
                    #record(#accepted_like({
                        accepted_like_key = row.accepted_like_key;
                        accepted_sequence = row.accepted_sequence;
                        accepted_at_ns = row.accepted_at_ns;
                        retain_until_ns = row.retain_until_ns;
                        withdrawn_at_ns =
                            acceptedLikeWithdrawalTime(row.post_key);
                        retained_bytes = row.retained_bytes;
                        post_key = row.post_key;
                        notification_sequence =
                            row.notification_sequence;
                        segment = acceptedLikeSegment(row);
                    }));
                };
                case (#authored_post(key)) {
                    if (
                        Map.get(
                            mem.authored_posts,
                            Text.compare,
                            key,
                        ) == null
                    ) #missing else #held(#adapter_refused);
                };
                case (#authored_action(key)) {
                    if (
                        Map.get(
                            mem.authored_actions,
                            Text.compare,
                            key,
                        ) == null
                    ) #missing else #held(#adapter_refused);
                };
                case (#feed_candidate(key)) {
                    let ?row = Map.get(
                        mem.feed_candidates,
                        Text.compare,
                        key,
                    ) else return #missing;
                    let ?expectedId = Hash.feedCandidateId(
                        row.immediate_sender,
                        row.operation_id,
                        row.payload_digest,
                    ) else return #held(#missing_cascade);
                    if (
                        row.candidate_key != key or
                        not Blob.equal(
                            row.candidate_id,
                            expectedId,
                        ) or
                        candidateStableKey(expectedId) != key
                    ) return #held(#missing_cascade);
                    let visible = switch (
                        Map.get(
                            mem.feed_order,
                            Nat64.compare,
                            row.local_sequence,
                        )
                    ) {
                        case null false;
                        case (?storedKey) {
                            if (storedKey != key) {
                                return #held(#missing_cascade);
                            };
                            true;
                        };
                    };
                    let unread =
                        Map.get(
                            mem.unread_feed_candidates,
                            Text.compare,
                            key,
                        ) != null;
                    if (visible != unread) {
                        return #held(#missing_cascade);
                    };
                    let ?claimedSlot = Map.get(
                        mem.feed_candidates_by_claimed_slot,
                        Text.compare,
                        feedPostSlotStableKey(
                            row.claimed_author,
                            row.claimed_post_id,
                        ),
                    ) else return #held(#missing_cascade);
                    if (
                        claimedSlot.size() >
                            FeedTypes.MAX_CANDIDATES_PER_CLAIMED_SLOT or
                        textArrayOccurrences(
                            claimedSlot,
                            row.candidate_key,
                        ) != 1
                    ) return #held(#missing_cascade);
                    let ?pressure = Map.get(
                        mem.candidate_pressure_by_sender,
                        Principal.compare,
                        row.immediate_sender,
                    ) else return #held(#missing_cascade);
                    if (
                        not Principal.equal(
                            pressure.sender,
                            row.immediate_sender,
                        ) or
                        pressure.candidate_count == 0 or
                        pressure.retained_bytes <
                            row.retained_bytes or
                        (
                            pressure.candidate_count == 1 and
                            pressure.retained_bytes !=
                                row.retained_bytes
                        ) or
                        (
                            pressure.candidate_count > 1 and
                            pressure.retained_bytes ==
                                row.retained_bytes
                        )
                    ) return #held(#missing_cascade);
                    let ?attached = feedCandidateAttached(row)
                        else return #held(#missing_cascade);
                    #record(#feed_candidate({
                        candidate_key = row.candidate_key;
                        received_at_ns = row.received_at_ns;
                        retain_until_ns = row.retain_until_ns;
                        retained_bytes = row.retained_bytes;
                        local_sequence = row.local_sequence;
                        immediate_sender = row.immediate_sender;
                        unread;
                        dependents_detached = not attached;
                    }));
                };
                case (#verified_feed(key)) {
                    let ?row = Map.get(
                        mem.verified_feed,
                        Text.compare,
                        key,
                    ) else return #missing;
                    if (row.feed_key != key) {
                        return #held(#missing_cascade);
                    };
                    if (
                        Map.get(
                            mem.verified_feed_by_post_slot,
                            Text.compare,
                            feedPostSlotStableKey(
                                row.locator.author,
                                row.locator.post_id,
                            ),
                        ) != ?key
                    ) return #held(#missing_cascade);
                    let suppressionAttached = switch (
                        Map.get(
                            mem.suppressions,
                            Text.compare,
                            key,
                        )
                    ) {
                        case null false;
                        case (?suppression) {
                            if (suppression.suppression_key != key) {
                                return #held(#missing_cascade);
                            };
                            true;
                        };
                    };
                    let ?attributionAttached =
                        feedHasAttribution(key)
                    else return #held(#missing_cascade);
                    #record(#verified_feed({
                        feed_key = row.feed_key;
                        created_at_ns = row.created_at_ns;
                        retain_until_ns = row.retain_until_ns;
                        retained_bytes = row.retained_bytes;
                        dependents_detached =
                            not suppressionAttached and
                            not attributionAttached;
                    }));
                };
                case (#share_attribution(key)) {
                    let ?row = Map.get(
                        mem.share_attributions,
                        Text.compare,
                        key,
                    ) else return #missing;
                    if (
                        row.attribution_key != key or
                        key !=
                            feedAttributionStableKeyForFeed(
                                row.feed_key,
                                row.sharer,
                            )
                    ) return #held(#missing_cascade);
                    #record(#share_attribution({
                        attribution_key = row.attribution_key;
                        verified_at_ns = row.verified_at_ns;
                        retain_until_ns = row.retain_until_ns;
                        retained_bytes = row.retained_bytes;
                        feed_key = row.feed_key;
                        candidate_key = row.candidate_key;
                    }));
                };
                case (#suppression(key)) {
                    let ?row = Map.get(
                        mem.suppressions,
                        Text.compare,
                        key,
                    ) else return #missing;
                    if (row.suppression_key != key) {
                        return #held(#missing_cascade);
                    };
                    #record(#suppression({
                        suppression_key = row.suppression_key;
                        suppressed_at_ns = row.suppressed_at_ns;
                        retain_until_ns = row.retain_until_ns;
                        retained_bytes = row.retained_bytes;
                        source_candidate_key =
                            row.source_candidate_key;
                    }));
                };
                case (#tombstone_relay(key)) {
                    let ?row = Map.get(
                        mem.tombstone_relays,
                        Text.compare,
                        key,
                    ) else return #missing;
                    if (row.relay_key != key) {
                        return #held(#missing_cascade);
                    };
                    #record(#tombstone_relay({
                        relay_key = row.relay_key;
                        created_at_ns = row.created_at_ns;
                        retain_until_ns = row.retain_until_ns;
                        retained_bytes = row.retained_bytes;
                        fanout_job_id = row.fanout_job_id;
                        fanout_detached =
                            Map.get(
                                mem.fanout_jobs,
                                Nat64.compare,
                                row.fanout_job_id,
                            ) == null;
                    }));
                };
                case (#notice_semantic(key)) {
                    let ?row = Map.get(
                        mem.notice_semantics,
                        Text.compare,
                        key,
                    ) else return #missing;
                    let ?notification = Map.get(
                        mem.notifications,
                        Nat64.compare,
                        row.notification_sequence,
                    ) else return #held(#missing_cascade);
                    if (
                        row.semantic_key != key or
                        notification.semantic_key != key or
                        not Principal.equal(
                            notification.actor_,
                            row.actor_,
                        ) or
                        not noticeSemanticMatchesNotification(
                            row,
                            notification,
                        )
                    ) return #held(#missing_cascade);
                    let ?pressure = Map.get(
                        mem.notice_pressure_by_caller,
                        Principal.compare,
                        row.actor_,
                    ) else return #held(#missing_cascade);
                    let targetKey =
                        postStableKey(row.target_post_id);
                    let ?targetCount = Map.get(
                        mem.notice_count_by_target,
                        Text.compare,
                        targetKey,
                    ) else return #held(#missing_cascade);
                    if (
                        pressure.retained_count == 0 or
                        pressure.retained_bytes !=
                            pressure.retained_count *
                                NOTICE_SEMANTIC_RETAINED_BYTES or
                        targetCount == 0
                    ) return #held(#missing_cascade);
                    #record(#notice_semantic({
                        semantic_key = row.semantic_key;
                        received_at_ns =
                            notification.received_at_ns;
                        retain_until_ns = row.retain_until_ns;
                        accounted_bytes =
                            ?NOTICE_SEMANTIC_RETAINED_BYTES;
                        notification_sequence =
                            row.notification_sequence;
                        actor_ = row.actor_;
                        target_post_key = targetKey;
                    }));
                };
                case (#sealed_like_batch(key)) {
                    if (
                        Map.get(
                            mem.sealed_like_batches,
                            Text.compare,
                            key,
                        ) == null
                    ) #missing else #held(#adapter_refused);
                };
                case (#outbox(localId)) {
                    let ?row = Map.get(
                        mem.outbox,
                        Nat64.compare,
                        localId,
                    ) else return #missing;
                    let ?metadata = Map.get(
                        mem.outbox_metadata,
                        Nat64.compare,
                        localId,
                    ) else return #held(#missing_cascade);
                    if (
                        row.local_id != localId or
                        metadata.local_id != localId or
                        row.attempt_prepared or
                        row.pending_credit_charge != null
                    ) return #held(#protected_dependency);
                    switch (row.state) {
                        case (
                            #accepted or
                            #duplicate or
                            #superseded
                        ) {};
                        case (_) return #held(#protected_dependency);
                    };
                    let operationKey : Memory.OutboxOperationKey = (
                        row.prepared.target,
                        row.prepared.route,
                        row.prepared.operation_id,
                    );
                    if (
                        Map.get(
                            mem.outbox_by_operation,
                            outboxOperationCompare,
                            operationKey,
                        ) != ?localId
                    ) return #held(#missing_cascade);
                    let retryKey = switch (row.next_attempt_at_ns) {
                        case null null;
                        case (?at) ?(at, localId);
                    };
                    switch (retryKey) {
                        case null {};
                        case (?key) {
                            if (
                                Map.get(
                                    mem.outbox_by_retry_time,
                                    orderedTimeCompare,
                                    key,
                                ) != ?localId
                            ) return #held(#missing_cascade);
                        };
                    };
                    switch (
                        metadata.fanout_job_id,
                        metadata.follower_registration_sequence,
                    ) {
                        case (null, null) {};
                        case (?jobId, ?registrationSequence) {
                            let targetKey = FanoutPlanner.targetKey(
                                jobId,
                                registrationSequence,
                            );
                            let ?target = Map.get(
                                mem.fanout_targets,
                                Text.compare,
                                targetKey,
                            ) else return #held(#missing_cascade);
                            if (
                                target.outbox_local_id != localId or
                                target.fanout_job_id != jobId or
                                target.registration_sequence !=
                                    registrationSequence
                            ) return #held(#missing_cascade);
                        };
                        case (_) return #held(#missing_cascade);
                    };
                    #record(#outbox({
                        local_id = localId;
                        created_at_ns = row.created_at_ns;
                        retry_expires_at_ns =
                            row.retry_expires_at_ns;
                        cleanup_at_ns = entry.key.0;
                        retained_bytes =
                            outboxRetainedBytes(row) +
                            metadata.retained_bytes;
                        operation_key = operationKey;
                        retry_index_key = retryKey;
                        pending_credit_charge =
                            row.pending_credit_charge;
                        links_detached =
                            outboxFollowingLinkDetached(
                                row,
                                metadata,
                            );
                    }));
                };
                case (#fanout_job(jobId)) {
                    let ?row = Map.get(
                        mem.fanout_jobs,
                        Nat64.compare,
                        jobId,
                    ) else return #missing;
                    let ?targetCount = Map.get(
                        mem.fanout_target_count_by_job,
                        Nat64.compare,
                        jobId,
                    ) else return #held(#missing_cascade);
                    if (row.fanout_job_id != jobId) {
                        return #held(#missing_cascade);
                    };
                    switch (row.state) {
                        case (#complete or #partial or #failed) {};
                        case (_) return #held(#protected_dependency);
                    };
                    #record(#fanout_job({
                        fanout_job_id = row.fanout_job_id;
                        created_at_ns = row.created_at_ns;
                        expires_at_ns = row.expires_at_ns;
                        cleanup_at_ns = entry.key.0;
                        retained_bytes = row.retained_bytes;
                        targets_detached = targetCount == 0;
                    }));
                };
                case (#fanout_target(key)) {
                    let ?row = Map.get(
                        mem.fanout_targets,
                        Text.compare,
                        key,
                    ) else return #missing;
                    let ?job = Map.get(
                        mem.fanout_jobs,
                        Nat64.compare,
                        row.fanout_job_id,
                    ) else return #held(#missing_cascade);
                    let ?targetCount = Map.get(
                        mem.fanout_target_count_by_job,
                        Nat64.compare,
                        row.fanout_job_id,
                    ) else return #held(#missing_cascade);
                    if (
                        row.target_key != key or
                        key !=
                            FanoutPlanner.targetKey(
                                row.fanout_job_id,
                                row.registration_sequence,
                            ) or
                        row.expires_at_ns != job.expires_at_ns or
                        targetCount == 0
                    ) return #held(#missing_cascade);
                    let outboxDetached = switch (
                        Map.get(
                            mem.outbox,
                            Nat64.compare,
                            row.outbox_local_id,
                        )
                    ) {
                        case null true;
                        case (?_) {
                            let ?metadata = Map.get(
                                mem.outbox_metadata,
                                Nat64.compare,
                                row.outbox_local_id,
                            ) else return #held(#missing_cascade);
                            if (
                                metadata.fanout_job_id !=
                                    ?row.fanout_job_id or
                                metadata.follower_registration_sequence !=
                                    ?row.registration_sequence
                            ) return #held(#missing_cascade);
                            false;
                        };
                    };
                    #record(#fanout_target({
                        target_key = row.target_key;
                        fanout_job_id = row.fanout_job_id;
                        outbox_local_id = row.outbox_local_id;
                        created_at_ns = job.created_at_ns;
                        expires_at_ns = row.expires_at_ns;
                        cleanup_at_ns = entry.key.0;
                        retained_bytes = row.retained_bytes;
                        outbox_detached = outboxDetached;
                    }));
                };
            };
        };

        func outboxFollowingLinkDetached(
            row : Memory.OutboxItem,
            metadata : Memory.OutboxMetadata,
        ) : Bool {
            if (metadata.following_intent_generation == null) return true;
            let ?following = Map.get(
                mem.following,
                Principal.compare,
                row.prepared.target,
            ) else return true;
            following.pending_outbox_local_id != ?row.local_id;
        };

        func followerEligibleForFanoutAt(
            row : Memory.FollowerRecord,
            at : Nat64,
        ) : Bool {
            if (
                row.delivery_pause != null or
                Map.get(
                    mem.blocks,
                    Principal.compare,
                    row.node,
                ) != null
            ) return false;
            switch (row.state) {
                case (#inactive(_)) false;
                case (#active(active)) {
                    active.lease_expires_ns > at and
                    active.delivery_credits > 0;
                };
            };
        };

        // Promotion stores every candidate dependency at a deterministic key:
        // the canonical feed key, canonical+sharer attribution key, or that
        // same canonical key in the suppression map. This makes inspection
        // constant-map-lookups rather than an unbounded reverse scan.
        func feedCandidateAttached(
            row : Memory.FeedCandidate
        ) : ?Bool {
            let ?bodyHash = row.claimed_body_hash else return null;
            let key : FeedTypes.CanonicalKey = {
                author = row.claimed_author;
                post_id = row.claimed_post_id;
                body_hash = bodyHash;
            };
            let feedKey = feedCanonicalStableKey(key);
            var attached = false;
            switch (
                Map.get(
                    mem.verified_feed,
                    Text.compare,
                    feedKey,
                )
            ) {
                case null {};
                case (?canonical) {
                    if (
                        canonical.feed_key != feedKey or
                        not Principal.equal(
                            canonical.locator.author,
                            key.author,
                        ) or
                        not Blob.equal(
                            canonical.locator.post_id,
                            key.post_id,
                        ) or
                        not Blob.equal(
                            canonical.locator.body_hash,
                            key.body_hash,
                        )
                    ) return null;
                    if (
                        canonical.first_candidate_key ==
                            row.candidate_key or
                        canonical.direct_candidate_key ==
                            ?row.candidate_key
                    ) attached := true;
                };
            };
            let attributionKey = feedAttributionStableKey(
                key,
                row.immediate_sender,
            );
            switch (
                Map.get(
                    mem.share_attributions,
                    Text.compare,
                    attributionKey,
                )
            ) {
                case null {};
                case (?attribution) {
                    if (
                        attribution.attribution_key !=
                            attributionKey or
                        attribution.feed_key != feedKey or
                        not Principal.equal(
                            attribution.sharer,
                            row.immediate_sender,
                        )
                    ) return null;
                    if (
                        attribution.candidate_key ==
                            row.candidate_key
                    ) attached := true;
                };
            };
            switch (
                Map.get(
                    mem.suppressions,
                    Text.compare,
                    feedKey,
                )
            ) {
                case null {};
                case (?suppression) {
                    if (
                        suppression.suppression_key != feedKey or
                        not Principal.equal(
                            suppression.author,
                            key.author,
                        ) or
                        not Blob.equal(
                            suppression.post_id,
                            key.post_id,
                        ) or
                        not Blob.equal(
                            suppression.body_hash,
                            key.body_hash,
                        )
                    ) return null;
                    if (
                        suppression.source_candidate_key ==
                            ?row.candidate_key
                    ) attached := true;
                };
            };
            ?attached;
        };

        func noticeSemanticMatchesNotification(
            semantic : Memory.NoticeSemanticReceipt,
            notification : Memory.NotificationSummary,
        ) : Bool {
            if (
                notification.local_sequence !=
                    semantic.notification_sequence or
                notification.retain_until_ns !=
                    semantic.retain_until_ns
            ) return false;
            let relation : Protocol.NoticeRelationV1 = switch (
                semantic.relation
            ) {
                case (#reply) #reply;
                case (#share) #share;
            };
            if (
                notificationSemanticStableKey(#notice({
                    acting_node = semantic.actor_;
                    relation;
                    action_id = semantic.action_id;
                })) != semantic.semantic_key
            ) return false;
            let info = switch (
                semantic.relation,
                notification.kind,
            ) {
                case (#reply, ?#reply(value)) value;
                case (#share, ?#share(value)) value;
                case (_) return false;
            };
            Blob.equal(
                info.target_post_id,
                semantic.target_post_id,
            ) and
            Blob.equal(
                info.target_body_hash,
                semantic.target_body_hash,
            ) and
            Blob.equal(info.action_id, semantic.action_id) and
            Blob.equal(
                info.object_digest,
                semantic.object_digest,
            ) and
            info.object_length == semantic.object_length;
        };

        func acceptedLikeWithdrawalTime(
            postKey : Text
        ) : ?Nat64 {
            let ?post = Map.get(
                mem.authored_posts,
                Text.compare,
                postKey,
            ) else return null;
            switch (post.status) {
                case (#withdrawn(info)) ?info.withdrawn_at_ns;
                case (_) null;
            };
        };

        func notificationAcceptedLikeAttached(
            sequence : Nat64
        ) : Bool {
            let ?#like(evidence) = Map.get(
                mem.notification_evidence,
                Nat64.compare,
                sequence,
            ) else return false;
            let ?accepted = Map.get(
                mem.accepted_likes,
                Text.compare,
                evidence.accepted_like_key,
            ) else return false;
            accepted.notification_sequence == sequence and
            acceptedLikeSegment(accepted) != null;
        };

        func acceptedLikeSegment(
            row : Memory.AcceptedLike
        ) : ?{
            segment_number : Nat64;
            lane : { #active; #due };
        } {
            let ?state = Map.get(
                mem.like_states,
                Text.compare,
                row.post_key,
            ) else return null;
            if (
                likeSegmentContains(
                    state.active_segment,
                    row.accepted_like_key,
                )
            ) {
                return ?{
                    segment_number =
                        state.active_segment.segment_number;
                    lane = #active;
                };
            };
            switch (state.due_segment) {
                case null null;
                case (?segment) {
                    if (
                        likeSegmentContains(
                            segment,
                            row.accepted_like_key,
                        )
                    ) {
                        ?{
                            segment_number = segment.segment_number;
                            lane = #due;
                        };
                    } else null;
                };
            };
        };

        func likeSegmentContains(
            segment : Memory.LikeSegment,
            acceptedKey : Text,
        ) : Bool {
            for (key in segment.accepted_like_keys.vals()) {
                if (key == acceptedKey) return true;
            };
            false;
        };

        // This is a strict two-pass CAS. Every primary/secondary row,
        // reverse pointer, expiry row, replacement suffix, and aggregate
        // counter decrement is checked before the first mutation.
        func commitRetentionCleanup(
            plan : RetentionTypes.CleanupPlan
        ) : Bool {
            let ?decrement = preflightRetentionCleanup(plan)
                else return false;
            let newlyDetached =
                List.empty<Memory.RetentionRecordRef>();
            for (mutation in plan.mutations.vals()) {
                switch (mutation) {
                    case (#delete_record(value)) {
                        switch (value.expected) {
                            case (#outbox(outbox)) {
                                switch (
                                    Map.get(
                                        mem.outbox_metadata,
                                        Nat64.compare,
                                        outbox.local_id,
                                    )
                                ) {
                                    case (?metadata) {
                                        switch (
                                            metadata.fanout_job_id,
                                            metadata
                                                .follower_registration_sequence,
                                        ) {
                                            case (
                                                ?jobId,
                                                ?registrationSequence,
                                            ) {
                                                List.add(
                                                    newlyDetached,
                                                    #fanout_target(
                                                        FanoutPlanner
                                                            .targetKey(
                                                                jobId,
                                                                registrationSequence,
                                                            )
                                                    ),
                                                );
                                            };
                                            case (_) {};
                                        };
                                    };
                                    case null {};
                                };
                            };
                            case (#fanout_target(target)) {
                                List.add(
                                    newlyDetached,
                                    #fanout_job(
                                        target.fanout_job_id
                                    ),
                                );
                            };
                            case (_) {};
                        };
                        applyRetentionPrimaryDeletion(value.expected);
                        Map.remove(
                            mem.retention_order,
                            retentionIndexCompare,
                            value.entry.key,
                        );
                        Map.remove(
                            mem.retention_current,
                            Text.compare,
                            RetentionService.canonicalKey(
                                value.entry.record
                            ),
                        );
                    };
                    case (#delete_index_only(value)) {
                        Map.remove(
                            mem.retention_order,
                            retentionIndexCompare,
                            value.entry.key,
                        );
                        if (value.reason == #missing_record) {
                            Map.remove(
                                mem.retention_current,
                                Text.compare,
                                RetentionService.canonicalKey(
                                    value.entry.record
                                ),
                            );
                        };
                    };
                    case (#defer(value)) {
                        Map.remove(
                            mem.retention_order,
                            retentionIndexCompare,
                            value.entry.key,
                        );
                        Map.add(
                            mem.retention_order,
                            retentionIndexCompare,
                            value.replacement.key,
                            value.replacement.record,
                        );
                        Map.add(
                            mem.retention_current,
                            Text.compare,
                            RetentionService.canonicalKey(
                                value.entry.record
                            ),
                            value.replacement.key,
                        );
                    };
                };
            };
            subtractRetentionCounters(decrement);
            if (decrement.follower_head_count > 0) {
                mem.follower_revision += 1;
                mem.relationship_revision += 1;
            };
            if (
                decrement.candidate_count > 0 or
                decrement.verified_feed_count > 0 or
                decrement.share_attribution_count > 0 or
                decrement.suppression_count > 0
            ) {
                mem.feed_revision += 1;
            };
            if (decrement.notification_count > 0) {
                mem.notification_revision += 1;
            };
            mem.cleanup_epoch := plan.next_cleanup_epoch;
            mem.retention_sequence :=
                plan.next_retention_sequence;
            mem.state_revision += 1;
            for (record in List.values(newlyDetached)) {
                reAgeDetachedTerminalRetention(
                    record,
                    plan.now_ns,
                );
            };
            true;
        };

        func preflightRetentionCleanup(
            plan : RetentionTypes.CleanupPlan
        ) : ?RetentionTypes.CounterDelta {
            if (
                plan.mutations.size() == 0 or
                plan.mutations.size() >
                    RetentionService.MAX_CLEANUP_PAGE or
                plan.expected_cleanup_epoch != mem.cleanup_epoch or
                plan.expected_retention_sequence !=
                    mem.retention_sequence or
                plan.expected_cleanup_epoch == Nat64.maxValue or
                plan.next_cleanup_epoch !=
                    plan.expected_cleanup_epoch + 1 or
                plan.next_retention_sequence <
                    plan.expected_retention_sequence or
                mem.state_revision == Nat64.maxValue
            ) return null;

            var nextDeferredSequence =
                plan.expected_retention_sequence;
            var decrement = emptyRetentionCounterDelta();

            for (mutation in plan.mutations.vals()) {
                let entry = retentionMutationEntry(mutation);
                if (
                    entry.key.2 == 0 or
                    entry.key.0 > plan.now_ns or
                    entry.key.1 !=
                        RetentionService.domain(entry.record) or
                    not retentionIndexContains(entry) or
                    retentionMutationOccurrence(
                        plan.mutations,
                        entry.key,
                    ) != 1
                ) return null;

                switch (mutation) {
                    case (#delete_record(value)) {
                        if (
                            not retentionCurrentMatches(entry) or
                            not retentionDeletionMatchesLive(value) or
                            not canDeleteRetentionPrimary(
                                value.expected
                            )
                        ) return null;
                        let expectedDelta =
                            retentionCounterDelta(value.expected);
                        if (value.decrement != expectedDelta) {
                            return null;
                        };
                        decrement := addRetentionCounterDelta(
                            decrement,
                            expectedDelta,
                        );
                    };
                    case (#delete_index_only(value)) {
                        switch (value.reason) {
                            case (#superseded) {
                                if (retentionCurrentMatches(entry)) {
                                    return null;
                                };
                            };
                            case (#missing_record) {
                                if (
                                    not retentionCurrentMatches(entry) or
                                    inspectRetentionEntry(entry) !=
                                        #missing
                                ) return null;
                            };
                        };
                    };
                    case (#defer(value)) {
                        let ?expected =
                            expectedRetentionDeferral(
                                entry,
                                plan.now_ns,
                            ) else return null;
                        if (
                            value.reason != expected.0 or
                            value.replacement.key.0 != expected.1 or
                            value.replacement.key.1 != entry.key.1 or
                            RetentionService.canonicalKey(
                                value.replacement.record
                            ) !=
                                RetentionService.canonicalKey(
                                    entry.record
                                ) or
                            not retentionCurrentMatches(entry) or
                            nextDeferredSequence ==
                                Nat64.maxValue
                        ) return null;
                        nextDeferredSequence += 1;
                        if (
                            value.replacement.key.2 !=
                                nextDeferredSequence or
                            Map.get(
                                mem.retention_order,
                                retentionIndexCompare,
                                value.replacement.key,
                            ) != null or
                            retentionReplacementOccurrence(
                                plan.mutations,
                                value.replacement.key,
                            ) != 1
                        ) return null;
                    };
                };
            };

            if (
                plan.next_retention_sequence !=
                    nextDeferredSequence or
                not canSubtractRetentionCounters(decrement) or
                (
                    decrement.follower_head_count > 0 and
                    (
                        mem.follower_revision == Nat64.maxValue or
                        mem.relationship_revision == Nat64.maxValue
                    )
                ) or
                (
                    (
                        decrement.candidate_count > 0 or
                        decrement.verified_feed_count > 0 or
                        decrement.share_attribution_count > 0 or
                        decrement.suppression_count > 0
                    ) and
                    mem.feed_revision == Nat64.maxValue
                ) or
                (
                    decrement.notification_count > 0 and
                    mem.notification_revision == Nat64.maxValue
                )
            ) return null;
            ?decrement;
        };

        func retentionMutationEntry(
            mutation : RetentionTypes.CleanupMutation
        ) : RetentionTypes.Entry {
            switch (mutation) {
                case (#delete_record(value)) value.entry;
                case (#delete_index_only(value)) value.entry;
                case (#defer(value)) value.entry;
            };
        };

        func retentionMutationOccurrence(
            mutations : [RetentionTypes.CleanupMutation],
            key : Memory.RetentionIndexKey,
        ) : Nat {
            var count = 0;
            for (mutation in mutations.vals()) {
                if (retentionMutationEntry(mutation).key == key) {
                    count += 1;
                };
            };
            count;
        };

        func retentionReplacementOccurrence(
            mutations : [RetentionTypes.CleanupMutation],
            key : Memory.RetentionIndexKey,
        ) : Nat {
            var count = 0;
            for (mutation in mutations.vals()) {
                switch (mutation) {
                    case (#defer(value)) {
                        if (value.replacement.key == key) {
                            count += 1;
                        };
                    };
                    case (_) {};
                };
            };
            count;
        };

        func retentionIndexContains(
            entry : RetentionTypes.Entry
        ) : Bool {
            let ?stored = Map.get(
                mem.retention_order,
                retentionIndexCompare,
                entry.key,
            ) else return false;
            RetentionService.canonicalKey(stored) ==
                RetentionService.canonicalKey(entry.record);
        };

        func retentionCurrentMatches(
            entry : RetentionTypes.Entry
        ) : Bool {
            let ?current = currentRetentionEntry(entry.record)
                else return false;
            current.key == entry.key and
            RetentionService.canonicalKey(current.record) ==
                RetentionService.canonicalKey(entry.record);
        };

        func retentionDeletionMatchesLive(
            value : {
                entry : RetentionTypes.Entry;
                expected : RetentionTypes.RecordView;
                decrement : RetentionTypes.CounterDelta;
            }
        ) : Bool {
            switch (inspectRetentionEntry(value.entry)) {
                case (#record(current)) current == value.expected;
                case (_) false;
            };
        };

        func expectedRetentionDeferral(
            entry : RetentionTypes.Entry,
            now : Nat64,
        ) : ?(RetentionTypes.HoldReason, Nat64) {
            switch (inspectRetentionEntry(entry)) {
                case (#missing) null;
                case (#held(reason)) {
                    if (
                        now >
                            Nat64.maxValue -
                                RetentionService.MAINTENANCE_RETRY_NS
                    ) return null;
                    ?(
                        reason,
                        now +
                            RetentionService.MAINTENANCE_RETRY_NS,
                    );
                };
                case (#record(view)) {
                    let due = retentionNextCleanupAt(view);
                    if (due > now) return ?(#not_due, due);
                    let ?reason = retentionProtectedReason(view)
                        else return null;
                    if (
                        now >
                            Nat64.maxValue -
                                RetentionService.MAINTENANCE_RETRY_NS
                    ) return null;
                    ?(
                        reason,
                        now +
                            RetentionService.MAINTENANCE_RETRY_NS,
                    );
                };
            };
        };

        func retentionNextCleanupAt(
            view : RetentionTypes.RecordView
        ) : Nat64 {
            switch (view) {
                case (#follower(value)) value.retain_until_ns;
                case (#authored_post(value)) value.retain_until_ns;
                case (#authored_action(value)) value.retain_until_ns;
                case (#feed_candidate(value)) value.retain_until_ns;
                case (#verified_feed(value)) value.retain_until_ns;
                case (#share_attribution(value)) {
                    value.retain_until_ns;
                };
                case (#suppression(value)) value.retain_until_ns;
                case (#tombstone_relay(value)) {
                    value.retain_until_ns;
                };
                case (#notification(value)) value.retain_until_ns;
                case (#notice_semantic(value)) {
                    value.retain_until_ns;
                };
                case (#accepted_like(value)) {
                    switch (value.withdrawn_at_ns) {
                        case null value.retain_until_ns;
                        case (?time) time;
                    };
                };
                case (#sealed_like_batch(value)) {
                    switch (value.withdrawn_at_ns) {
                        case null value.retain_until_ns;
                        case (?time) time;
                    };
                };
                case (#ingress_receipt(value)) {
                    value.retain_until_ns;
                };
                case (#caller_rate_window(value)) {
                    value.expires_at_ns;
                };
                case (#outbox(value)) value.cleanup_at_ns;
                case (#fanout_job(value)) value.cleanup_at_ns;
                case (#fanout_target(value)) value.cleanup_at_ns;
            };
        };

        func retentionProtectedReason(
            view : RetentionTypes.RecordView
        ) : ?RetentionTypes.HoldReason {
            switch (view) {
                case (#follower(value)) {
                    if (value.charges_detached) null
                    else ?#protected_dependency;
                };
                case (#notification(value)) {
                    if (value.notice_semantic_detached) null
                    else ?#protected_dependency;
                };
                case (#feed_candidate(value)) {
                    if (value.dependents_detached) null
                    else ?#protected_dependency;
                };
                case (#verified_feed(value)) {
                    if (value.dependents_detached) null
                    else ?#protected_dependency;
                };
                case (#share_attribution(_)) null;
                case (#suppression(_)) null;
                case (#tombstone_relay(value)) {
                    if (value.fanout_detached) null
                    else ?#protected_dependency;
                };
                case (#notice_semantic(value)) {
                    if (value.accounted_bytes == null) {
                        ?#missing_accounting;
                    } else null;
                };
                case (#accepted_like(value)) {
                    if (value.segment == null) null
                    else ?#protected_dependency;
                };
                case (#ingress_receipt(value)) {
                    if (value.domain_dependency_detached) null
                    else ?#protected_dependency;
                };
                case (#caller_rate_window(_)) null;
                case (#outbox(value)) {
                    if (
                        value.pending_credit_charge == null and
                        value.links_detached
                    ) null else ?#protected_dependency;
                };
                case (#fanout_job(value)) {
                    if (value.targets_detached) null
                    else ?#protected_dependency;
                };
                case (#fanout_target(value)) {
                    if (value.outbox_detached) null
                    else ?#protected_dependency;
                };
                // Present rows in every other domain are surfaced as
                // #held(#adapter_refused) by inspectRetentionEntry.
                case (_) ?#adapter_refused;
            };
        };

        func canDeleteRetentionPrimary(
            view : RetentionTypes.RecordView
        ) : Bool {
            switch (view) {
                case (#follower(value)) {
                    value.charges_detached and
                    (
                        switch (
                            Map.get(
                                mem.followers,
                                Principal.compare,
                                value.node,
                            )
                        ) {
                            case (?row) {
                                not followerEligibleForFanoutAt(
                                    row,
                                    value.retain_until_ns,
                                );
                            };
                            case null false;
                        }
                    ) and
                    (
                        switch (
                            Map.get(
                                mem.followers_by_registration,
                                Nat64.compare,
                                value.registration_sequence,
                            )
                        ) {
                            case (?peer) {
                                Principal.equal(peer, value.node);
                            };
                            case null false;
                        }
                    );
                };
                case (#ingress_receipt(value)) {
                    value.domain_dependency_detached;
                };
                case (#caller_rate_window(_)) true;
                case (#feed_candidate(value)) {
                    value.dependents_detached and
                    (
                        switch (
                            Map.get(
                                mem.feed_candidates,
                                Text.compare,
                                value.candidate_key,
                            )
                        ) {
                            case (?row) {
                                feedCandidateAttached(row) == ?false;
                            };
                            case null false;
                        }
                    );
                };
                case (#verified_feed(value)) {
                    value.dependents_detached and
                    Map.get(
                        mem.verified_feed,
                        Text.compare,
                        value.feed_key,
                    ) != null and
                    Map.get(
                        mem.suppressions,
                        Text.compare,
                        value.feed_key,
                    ) == null and
                    feedHasAttribution(value.feed_key) == ?false;
                };
                case (#share_attribution(value)) {
                    switch (
                        Map.get(
                            mem.share_attributions,
                            Text.compare,
                            value.attribution_key,
                        )
                    ) {
                        case (?row) {
                            row.attribution_key ==
                                value.attribution_key and
                            row.feed_key == value.feed_key and
                            row.candidate_key ==
                                value.candidate_key;
                        };
                        case null false;
                    };
                };
                case (#suppression(value)) {
                    switch (
                        Map.get(
                            mem.suppressions,
                            Text.compare,
                            value.suppression_key,
                        )
                    ) {
                        case (?row) {
                            row.suppression_key ==
                                value.suppression_key and
                            row.source_candidate_key ==
                                value.source_candidate_key;
                        };
                        case null false;
                    };
                };
                case (#tombstone_relay(value)) {
                    value.fanout_detached and
                    Map.get(
                        mem.tombstone_relays,
                        Text.compare,
                        value.relay_key,
                    ) != null and
                    Map.get(
                        mem.fanout_jobs,
                        Nat64.compare,
                        value.fanout_job_id,
                    ) == null;
                };
                case (#notification(value)) {
                    value.notice_semantic_detached and
                    Map.get(
                        mem.notice_semantics,
                        Text.compare,
                        value.semantic_key,
                    ) == null and
                    (
                        switch (
                            Map.get(
                                mem.notifications,
                                Nat64.compare,
                                value.local_sequence,
                            )
                        ) {
                            case (?row) {
                                switch (row.kind) {
                                    case (?#new_follower(_)) true;
                                    case (?#like(_)) true;
                                    case (?#reply(_)) true;
                                    case (?#share(_)) true;
                                    case (_) false;
                                };
                            };
                            case null false;
                        }
                    );
                };
                case (#notice_semantic(value)) {
                    value.accounted_bytes ==
                        ?NOTICE_SEMANTIC_RETAINED_BYTES and
                    Map.get(
                        mem.notice_semantics,
                        Text.compare,
                        value.semantic_key,
                    ) != null and
                    Map.get(
                        mem.notifications,
                        Nat64.compare,
                        value.notification_sequence,
                    ) != null;
                };
                case (#accepted_like(value)) {
                    value.segment == null and
                    (
                        switch (
                            Map.get(
                                mem.accepted_like_count_by_post,
                                Text.compare,
                                value.post_key,
                            )
                        ) {
                            case (?count) count > 0;
                            case null false;
                        }
                    ) and
                    Map.get(
                        mem.notifications,
                        Nat64.compare,
                        value.notification_sequence,
                    ) == null and
                    Map.get(
                        mem.notification_evidence,
                        Nat64.compare,
                        value.notification_sequence,
                    ) == null and
                    Map.get(
                        mem.accepted_likes_by_sequence,
                        Nat64.compare,
                        value.accepted_sequence,
                    ) == ?value.accepted_like_key;
                };
                case (#outbox(value)) {
                    value.pending_credit_charge == null and
                    value.links_detached and
                    Map.get(
                        mem.outbox_by_operation,
                        outboxOperationCompare,
                        value.operation_key,
                    ) == ?value.local_id and
                    (
                        switch (value.retry_index_key) {
                            case null true;
                            case (?key) {
                                Map.get(
                                    mem.outbox_by_retry_time,
                                    orderedTimeCompare,
                                    key,
                                ) == ?value.local_id;
                            };
                        }
                    ) and
                    (
                        switch (
                            Map.get(
                                mem.outbox,
                                Nat64.compare,
                                value.local_id,
                            )
                        ) {
                            case (?row) {
                                not row.attempt_prepared and
                                row.pending_credit_charge == null and
                                (
                                    row.state == #accepted or
                                    row.state == #duplicate or
                                    row.state == #superseded
                                ) and
                                (
                                    switch (
                                        Map.get(
                                            mem.outbox_metadata,
                                            Nat64.compare,
                                            value.local_id,
                                        )
                                    ) {
                                        case (?metadata) {
                                            outboxFollowingLinkDetached(
                                                row,
                                                metadata,
                                            );
                                        };
                                        case null false;
                                    }
                                );
                            };
                            case null false;
                        }
                    );
                };
                case (#fanout_target(value)) {
                    value.outbox_detached and
                    Map.get(
                        mem.outbox,
                        Nat64.compare,
                        value.outbox_local_id,
                    ) == null and
                    (
                        switch (
                            Map.get(
                                mem.fanout_target_count_by_job,
                                Nat64.compare,
                                value.fanout_job_id,
                            )
                        ) {
                            case (?count) count > 0;
                            case null false;
                        }
                    ) and
                    Map.get(
                        mem.fanout_targets,
                        Text.compare,
                        value.target_key,
                    ) != null;
                };
                case (#fanout_job(value)) {
                    value.targets_detached and
                    Map.get(
                        mem.fanout_target_count_by_job,
                        Nat64.compare,
                        value.fanout_job_id,
                    ) == ?0 and
                    (
                        switch (
                            Map.get(
                                mem.fanout_jobs,
                                Nat64.compare,
                                value.fanout_job_id,
                            )
                        ) {
                            case (?job) {
                                job.state == #complete or
                                job.state == #partial or
                                job.state == #failed;
                            };
                            case null false;
                        }
                    );
                };
                case (_) false;
            };
        };

        func applyRetentionPrimaryDeletion(
            view : RetentionTypes.RecordView
        ) {
            switch (view) {
                case (#follower(value)) {
                    Map.remove(
                        mem.followers,
                        Principal.compare,
                        value.node,
                    );
                    Map.remove(
                        mem.followers_by_registration,
                        Nat64.compare,
                        value.registration_sequence,
                    );
                };
                case (#ingress_receipt(value)) {
                    Map.remove(
                        mem.ingress_receipts,
                        Text.compare,
                        value.receipt_key,
                    );
                };
                case (#caller_rate_window(value)) {
                    Map.remove(
                        mem.caller_rate_windows,
                        Text.compare,
                        value.window_key,
                    );
                };
                case (#feed_candidate(value)) {
                    let ?candidate = Map.get(
                        mem.feed_candidates,
                        Text.compare,
                        value.candidate_key,
                    ) else Runtime.trap(
                        "Wagyu retention candidate disappeared"
                    );
                    let ?pressure = Map.get(
                        mem.candidate_pressure_by_sender,
                        Principal.compare,
                        value.immediate_sender,
                    ) else Runtime.trap(
                        "Wagyu retention candidate pressure disappeared"
                    );
                    if (pressure.candidate_count == 1) {
                        Map.remove(
                            mem.candidate_pressure_by_sender,
                            Principal.compare,
                            value.immediate_sender,
                        );
                    } else {
                        Map.add(
                            mem.candidate_pressure_by_sender,
                            Principal.compare,
                            value.immediate_sender,
                            {
                                pressure with
                                candidate_count =
                                    pressure.candidate_count - 1;
                                retained_bytes =
                                    pressure.retained_bytes -
                                        value.retained_bytes;
                            },
                        );
                    };
                    removeFeedCandidateClaimedSlotIndex(candidate);
                    Map.remove(
                        mem.feed_candidates,
                        Text.compare,
                        value.candidate_key,
                    );
                    Map.remove(
                        mem.feed_order,
                        Nat64.compare,
                        value.local_sequence,
                    );
                    Map.remove(
                        mem.unread_feed_candidates,
                        Text.compare,
                        value.candidate_key,
                    );
                };
                case (#verified_feed(value)) {
                    let ?row = Map.get(
                        mem.verified_feed,
                        Text.compare,
                        value.feed_key,
                    ) else Runtime.trap(
                        "Wagyu verified feed disappeared during cleanup"
                    );
                    let slotKey = feedPostSlotStableKey(
                        row.locator.author,
                        row.locator.post_id,
                    );
                    if (
                        Map.get(
                            mem.verified_feed_by_post_slot,
                            Text.compare,
                            slotKey,
                        ) != ?value.feed_key
                    ) Runtime.trap(
                        "Wagyu verified feed slot disappeared during cleanup"
                    );
                    Map.remove(
                        mem.verified_feed,
                        Text.compare,
                        value.feed_key,
                    );
                    Map.remove(
                        mem.verified_feed_by_post_slot,
                        Text.compare,
                        slotKey,
                    );
                };
                case (#share_attribution(value)) {
                    Map.remove(
                        mem.share_attributions,
                        Text.compare,
                        value.attribution_key,
                    );
                };
                case (#suppression(value)) {
                    Map.remove(
                        mem.suppressions,
                        Text.compare,
                        value.suppression_key,
                    );
                };
                case (#tombstone_relay(value)) {
                    Map.remove(
                        mem.tombstone_relays,
                        Text.compare,
                        value.relay_key,
                    );
                };
                case (#notification(value)) {
                    releasePendingLikeReservation(
                        value.local_sequence
                    );
                    Map.remove(
                        mem.notifications,
                        Nat64.compare,
                        value.local_sequence,
                    );
                    Map.remove(
                        mem.notification_order,
                        Nat64.compare,
                        value.local_sequence,
                    );
                    Map.remove(
                        mem.notification_by_semantic,
                        Text.compare,
                        value.semantic_key,
                    );
                    Map.remove(
                        mem.unread_notifications,
                        Nat64.compare,
                        value.local_sequence,
                    );
                    Map.remove(
                        mem.notification_evidence,
                        Nat64.compare,
                        value.local_sequence,
                    );
                };
                case (#notice_semantic(value)) {
                    let ?pressure = Map.get(
                        mem.notice_pressure_by_caller,
                        Principal.compare,
                        value.actor_,
                    ) else Runtime.trap(
                        "Wagyu retention notice pressure disappeared"
                    );
                    if (pressure.retained_count == 1) {
                        Map.remove(
                            mem.notice_pressure_by_caller,
                            Principal.compare,
                            value.actor_,
                        );
                    } else {
                        Map.add(
                            mem.notice_pressure_by_caller,
                            Principal.compare,
                            value.actor_,
                            {
                                pressure with
                                retained_count =
                                    pressure.retained_count - 1;
                                retained_bytes =
                                    pressure.retained_bytes -
                                        NOTICE_SEMANTIC_RETAINED_BYTES;
                            },
                        );
                    };
                    let ?targetCount = Map.get(
                        mem.notice_count_by_target,
                        Text.compare,
                        value.target_post_key,
                    ) else Runtime.trap(
                        "Wagyu retention notice target disappeared"
                    );
                    if (targetCount == 1) {
                        Map.remove(
                            mem.notice_count_by_target,
                            Text.compare,
                            value.target_post_key,
                        );
                    } else {
                        Map.add(
                            mem.notice_count_by_target,
                            Text.compare,
                            value.target_post_key,
                            targetCount - 1,
                        );
                    };
                    Map.remove(
                        mem.notice_semantics,
                        Text.compare,
                        value.semantic_key,
                    );
                };
                case (#accepted_like(value)) {
                    decrementAcceptedLikePostCount(value.post_key);
                    Map.remove(
                        mem.accepted_likes,
                        Text.compare,
                        value.accepted_like_key,
                    );
                    Map.remove(
                        mem.accepted_likes_by_sequence,
                        Nat64.compare,
                        value.accepted_sequence,
                    );
                };
                case (#outbox(value)) {
                    let ?metadata = Map.get(
                        mem.outbox_metadata,
                        Nat64.compare,
                        value.local_id,
                    ) else Runtime.trap(
                        "Wagyu outbox metadata disappeared during cleanup"
                    );
                    switch (metadata.linked_action_key) {
                        case null {};
                        case (?actionKey) {
                            decrementAuthoredDependency(actionKey);
                        };
                    };
                    Map.remove(
                        mem.outbox,
                        Nat64.compare,
                        value.local_id,
                    );
                    Map.remove(
                        mem.outbox_metadata,
                        Nat64.compare,
                        value.local_id,
                    );
                    Map.remove(
                        mem.outbox_by_operation,
                        outboxOperationCompare,
                        value.operation_key,
                    );
                    switch (value.retry_index_key) {
                        case null {};
                        case (?key) {
                            Map.remove(
                                mem.outbox_by_retry_time,
                                orderedTimeCompare,
                                key,
                            );
                        };
                    };
                };
                case (#fanout_target(value)) {
                    let ?count = Map.get(
                        mem.fanout_target_count_by_job,
                        Nat64.compare,
                        value.fanout_job_id,
                    ) else Runtime.trap(
                        "Wagyu fanout target count disappeared"
                    );
                    if (count == 0) {
                        Runtime.trap(
                            "Wagyu fanout target count underflow"
                        );
                    };
                    Map.remove(
                        mem.fanout_targets,
                        Text.compare,
                        value.target_key,
                    );
                    Map.add(
                        mem.fanout_target_count_by_job,
                        Nat64.compare,
                        value.fanout_job_id,
                        count - 1,
                    );
                };
                case (#fanout_job(value)) {
                    let ?job = Map.get(
                        mem.fanout_jobs,
                        Nat64.compare,
                        value.fanout_job_id,
                    ) else Runtime.trap(
                        "Wagyu fanout job disappeared during cleanup"
                    );
                    decrementAuthoredDependency(job.action_key);
                    Map.remove(
                        mem.fanout_jobs,
                        Nat64.compare,
                        value.fanout_job_id,
                    );
                    Map.remove(
                        mem.fanout_target_count_by_job,
                        Nat64.compare,
                        value.fanout_job_id,
                    );
                };
                case (_) Runtime.trap(
                    "Wagyu retention deletion escaped preflight"
                );
            };
        };

        func releasePendingLikeReservation(sequence : Nat64) {
            let ?notification = Map.get(
                mem.notifications,
                Nat64.compare,
                sequence,
            ) else return;
            let targetPostId = switch (
                notification.kind,
                notification.verification,
            ) {
                case (?#like(info), ?#pending or ?#unavailable) {
                    info.target_post_id;
                };
                case (_) return;
            };
            let ?#like(evidence) = Map.get(
                mem.notification_evidence,
                Nat64.compare,
                sequence,
            ) else return;
            // A promoted (including legacy pre-quarantine) Like owns its
            // AcceptedLike row; only evidence-only quarantine releases one
            // unit here.
            if (
                Map.get(
                    mem.accepted_likes,
                    Text.compare,
                    evidence.accepted_like_key,
                ) != null
            ) return;
            let postKey = postStableKey(targetPostId);
            let ?state = Map.get(
                mem.like_states,
                Text.compare,
                postKey,
            ) else return;
            let verifiedCount =
                Nat16.toNat(state.active_segment.receipt_count) +
                (
                    switch (state.due_segment) {
                        case null 0;
                        case (?segment) {
                            Nat16.toNat(segment.receipt_count);
                        };
                    }
                );
            let total = Nat16.toNat(state.unsealed_receipt_count);
            if (total <= verifiedCount) return;
            Map.add(
                mem.like_states,
                Text.compare,
                postKey,
                {
                    state with
                    unsealed_receipt_count =
                        Nat16.fromNat(total - 1);
                },
            );
        };

        func emptyRetentionCounterDelta() : RetentionTypes.CounterDelta {
            {
                follower_head_count = 0;
                follower_head_bytes = 0;
                active_follower_count = 0;
                authored_post_count = 0;
                authored_action_count = 0;
                authored_bytes = 0;
                candidate_count = 0;
                candidate_bytes = 0;
                unread_feed_count = 0;
                verified_feed_count = 0;
                verified_feed_bytes = 0;
                share_attribution_count = 0;
                share_attribution_bytes = 0;
                suppression_count = 0;
                suppression_bytes = 0;
                tombstone_relay_count = 0;
                tombstone_relay_bytes = 0;
                notification_count = 0;
                notification_bytes = 0;
                unread_notification_count = 0;
                accepted_like_count = 0;
                accepted_like_bytes = 0;
                ingress_receipt_count = 0;
                ingress_receipt_bytes = 0;
                caller_rate_window_count = 0;
                caller_rate_window_bytes = 0;
                outbox_count = 0;
                outbox_bytes = 0;
                fanout_job_count = 0;
                fanout_target_count = 0;
                fanout_bytes = 0;
            };
        };

        func retentionCounterDelta(
            view : RetentionTypes.RecordView
        ) : RetentionTypes.CounterDelta {
            let empty = emptyRetentionCounterDelta();
            switch (view) {
                case (#follower(value)) {
                    {
                        empty with
                        follower_head_count = 1;
                        follower_head_bytes =
                            value.retained_bytes;
                        active_follower_count =
                            if (value.active) 1 else 0;
                    };
                };
                case (#feed_candidate(value)) {
                    {
                        empty with
                        candidate_count = 1;
                        candidate_bytes = value.retained_bytes;
                        unread_feed_count =
                            if (value.unread) 1 else 0;
                    };
                };
                case (#verified_feed(value)) {
                    {
                        empty with
                        verified_feed_count = 1;
                        verified_feed_bytes =
                            value.retained_bytes;
                    };
                };
                case (#share_attribution(value)) {
                    {
                        empty with
                        share_attribution_count = 1;
                        share_attribution_bytes =
                            value.retained_bytes;
                    };
                };
                case (#suppression(value)) {
                    {
                        empty with
                        suppression_count = 1;
                        suppression_bytes =
                            value.retained_bytes;
                    };
                };
                case (#tombstone_relay(value)) {
                    {
                        empty with
                        tombstone_relay_count = 1;
                        tombstone_relay_bytes =
                            value.retained_bytes;
                    };
                };
                case (#notification(value)) {
                    {
                        empty with
                        notification_count = 1;
                        notification_bytes =
                            value.retained_bytes;
                        unread_notification_count =
                            if (value.unread) 1 else 0;
                    };
                };
                case (#accepted_like(value)) {
                    {
                        empty with
                        accepted_like_count = 1;
                        accepted_like_bytes =
                            value.retained_bytes;
                    };
                };
                case (#ingress_receipt(value)) {
                    {
                        empty with
                        ingress_receipt_count = 1;
                        ingress_receipt_bytes =
                            value.retained_bytes;
                    };
                };
                case (#caller_rate_window(value)) {
                    {
                        empty with
                        caller_rate_window_count = 1;
                        caller_rate_window_bytes =
                            value.retained_bytes;
                    };
                };
                case (#outbox(value)) {
                    {
                        empty with
                        outbox_count = 1;
                        outbox_bytes = value.retained_bytes;
                    };
                };
                case (#fanout_job(value)) {
                    {
                        empty with
                        fanout_job_count = 1;
                        fanout_bytes = value.retained_bytes;
                    };
                };
                case (#fanout_target(value)) {
                    {
                        empty with
                        fanout_target_count = 1;
                        fanout_bytes = value.retained_bytes;
                    };
                };
                case (_) empty;
            };
        };

        func addRetentionCounterDelta(
            left : RetentionTypes.CounterDelta,
            right : RetentionTypes.CounterDelta,
        ) : RetentionTypes.CounterDelta {
            {
                follower_head_count =
                    left.follower_head_count +
                    right.follower_head_count;
                follower_head_bytes =
                    left.follower_head_bytes +
                    right.follower_head_bytes;
                active_follower_count =
                    left.active_follower_count +
                    right.active_follower_count;
                authored_post_count =
                    left.authored_post_count +
                    right.authored_post_count;
                authored_action_count =
                    left.authored_action_count +
                    right.authored_action_count;
                authored_bytes =
                    left.authored_bytes + right.authored_bytes;
                candidate_count =
                    left.candidate_count + right.candidate_count;
                candidate_bytes =
                    left.candidate_bytes + right.candidate_bytes;
                unread_feed_count =
                    left.unread_feed_count +
                    right.unread_feed_count;
                verified_feed_count =
                    left.verified_feed_count +
                    right.verified_feed_count;
                verified_feed_bytes =
                    left.verified_feed_bytes +
                    right.verified_feed_bytes;
                share_attribution_count =
                    left.share_attribution_count +
                    right.share_attribution_count;
                share_attribution_bytes =
                    left.share_attribution_bytes +
                    right.share_attribution_bytes;
                suppression_count =
                    left.suppression_count +
                    right.suppression_count;
                suppression_bytes =
                    left.suppression_bytes +
                    right.suppression_bytes;
                tombstone_relay_count =
                    left.tombstone_relay_count +
                    right.tombstone_relay_count;
                tombstone_relay_bytes =
                    left.tombstone_relay_bytes +
                    right.tombstone_relay_bytes;
                notification_count =
                    left.notification_count +
                    right.notification_count;
                notification_bytes =
                    left.notification_bytes +
                    right.notification_bytes;
                unread_notification_count =
                    left.unread_notification_count +
                    right.unread_notification_count;
                accepted_like_count =
                    left.accepted_like_count +
                    right.accepted_like_count;
                accepted_like_bytes =
                    left.accepted_like_bytes +
                    right.accepted_like_bytes;
                ingress_receipt_count =
                    left.ingress_receipt_count +
                    right.ingress_receipt_count;
                ingress_receipt_bytes =
                    left.ingress_receipt_bytes +
                    right.ingress_receipt_bytes;
                caller_rate_window_count =
                    left.caller_rate_window_count +
                    right.caller_rate_window_count;
                caller_rate_window_bytes =
                    left.caller_rate_window_bytes +
                    right.caller_rate_window_bytes;
                outbox_count =
                    left.outbox_count + right.outbox_count;
                outbox_bytes =
                    left.outbox_bytes + right.outbox_bytes;
                fanout_job_count =
                    left.fanout_job_count +
                    right.fanout_job_count;
                fanout_target_count =
                    left.fanout_target_count +
                    right.fanout_target_count;
                fanout_bytes =
                    left.fanout_bytes + right.fanout_bytes;
            };
        };

        func canSubtractRetentionCounters(
            value : RetentionTypes.CounterDelta
        ) : Bool {
            mem.follower_head_count >= value.follower_head_count and
            mem.follower_head_bytes >= value.follower_head_bytes and
            mem.active_follower_count >=
                value.active_follower_count and
            mem.authored_post_count >= value.authored_post_count and
            mem.authored_action_count >= value.authored_action_count and
            mem.authored_bytes >= value.authored_bytes and
            mem.candidate_count >= value.candidate_count and
            mem.candidate_bytes >= value.candidate_bytes and
            mem.unread_feed_count >= value.unread_feed_count and
            mem.verified_feed_count >= value.verified_feed_count and
            mem.verified_feed_bytes >= value.verified_feed_bytes and
            mem.share_attribution_count >=
                value.share_attribution_count and
            mem.share_attribution_bytes >=
                value.share_attribution_bytes and
            mem.suppression_count >= value.suppression_count and
            mem.suppression_bytes >= value.suppression_bytes and
            mem.tombstone_relay_count >=
                value.tombstone_relay_count and
            mem.tombstone_relay_bytes >=
                value.tombstone_relay_bytes and
            mem.notification_count >= value.notification_count and
            mem.notification_bytes >= value.notification_bytes and
            mem.unread_notification_count >=
                value.unread_notification_count and
            mem.accepted_like_count >= value.accepted_like_count and
            mem.accepted_like_bytes >= value.accepted_like_bytes and
            mem.ingress_receipt_count >=
                value.ingress_receipt_count and
            mem.ingress_receipt_bytes >=
                value.ingress_receipt_bytes and
            mem.caller_rate_window_count >=
                value.caller_rate_window_count and
            mem.caller_rate_window_bytes >=
                value.caller_rate_window_bytes and
            mem.outbox_count >= value.outbox_count and
            mem.outbox_bytes >= value.outbox_bytes and
            mem.fanout_job_count >= value.fanout_job_count and
            mem.fanout_target_count >= value.fanout_target_count and
            mem.fanout_bytes >= value.fanout_bytes;
        };

        func subtractRetentionCounters(
            value : RetentionTypes.CounterDelta
        ) {
            mem.follower_head_count -= value.follower_head_count;
            mem.follower_head_bytes -= value.follower_head_bytes;
            mem.active_follower_count -= value.active_follower_count;
            mem.authored_post_count -= value.authored_post_count;
            mem.authored_action_count -= value.authored_action_count;
            mem.authored_bytes -= value.authored_bytes;
            mem.candidate_count -= value.candidate_count;
            mem.candidate_bytes -= value.candidate_bytes;
            mem.unread_feed_count -= value.unread_feed_count;
            mem.verified_feed_count -= value.verified_feed_count;
            mem.verified_feed_bytes -= value.verified_feed_bytes;
            mem.share_attribution_count -=
                value.share_attribution_count;
            mem.share_attribution_bytes -=
                value.share_attribution_bytes;
            mem.suppression_count -= value.suppression_count;
            mem.suppression_bytes -= value.suppression_bytes;
            mem.tombstone_relay_count -=
                value.tombstone_relay_count;
            mem.tombstone_relay_bytes -=
                value.tombstone_relay_bytes;
            mem.notification_count -= value.notification_count;
            mem.notification_bytes -= value.notification_bytes;
            mem.unread_notification_count -=
                value.unread_notification_count;
            mem.accepted_like_count -= value.accepted_like_count;
            mem.accepted_like_bytes -= value.accepted_like_bytes;
            mem.ingress_receipt_count -=
                value.ingress_receipt_count;
            mem.ingress_receipt_bytes -=
                value.ingress_receipt_bytes;
            mem.caller_rate_window_count -=
                value.caller_rate_window_count;
            mem.caller_rate_window_bytes -=
                value.caller_rate_window_bytes;
            mem.outbox_count -= value.outbox_count;
            mem.outbox_bytes -= value.outbox_bytes;
            mem.fanout_job_count -= value.fanout_job_count;
            mem.fanout_target_count -= value.fanout_target_count;
            mem.fanout_bytes -= value.fanout_bytes;
        };

        func commitOutboxMutation(
            mutation : OutboxTypes.Mutation
        ) : Bool {
            if (
                mutation.local_id == 0 or
                mutation.next_item.local_id != mutation.local_id or
                mem.state_revision == Nat64.maxValue
            ) return false;
            let current = Map.get(
                mem.outbox,
                Nat64.compare,
                mutation.local_id,
            );
            switch (current, mutation.expected_storage_revision) {
                case (null, null) {
                    if (
                        mem.outbox_sequence == Nat64.maxValue or
                        mutation.local_id != mem.outbox_sequence + 1 or
                        mem.outbox_count >= mem.quota_limits.outbox_count
                    ) return false;
                    let ?metadata = pendingOutboxMetadata else return false;
                    if (metadata.local_id != mutation.local_id) return false;
                };
                case (?value, ?expected) {
                    if (pendingFanoutTarget != null) return false;
                    if (
                        value.storage_revision != expected or
                        not Dispatcher.exactRetryMatches(
                            value.prepared,
                            mutation.next_item.prepared,
                        )
                    ) return false;
                    if (
                        Map.get(
                            mem.outbox_metadata,
                            Nat64.compare,
                            mutation.local_id,
                        ) == null
                    ) return false;
                };
                case (_) return false;
            };
            let operationKey : Memory.OutboxOperationKey = (
                mutation.next_item.prepared.target,
                mutation.next_item.prepared.route,
                mutation.next_item.prepared.operation_id,
            );
            switch (
                Map.get(
                    mem.outbox_by_operation,
                    outboxOperationCompare,
                    operationKey,
                )
            ) {
                case null {
                    if (current != null) return false;
                };
                case (?localId) {
                    if (localId != mutation.local_id) return false;
                };
            };
            switch (mutation.follower_mutation) {
                case null {};
                case (?followerMutation) {
                    let ?existingFollower = Map.get(
                        mem.followers,
                        Principal.compare,
                        followerMutation.node,
                    ) else return false;
                    if (
                        followerMutation.new_follower_summary != null or
                        followerMutation.next_row.registration_sequence !=
                            existingFollower.registration_sequence or
                        not canCommitFollowerMutation(followerMutation)
                    ) return false;
                };
            };
            switch (mutation.control_mutation) {
                case null {};
                case (?controlMutation) {
                    if (
                        mem.outbox_control.revision !=
                            controlMutation.expected_revision
                    ) return false;
                };
            };
            let oldBytes = switch (current) {
                case null 0;
                case (?value) {
                    let ?metadata = Map.get(
                        mem.outbox_metadata,
                        Nat64.compare,
                        mutation.local_id,
                    ) else return false;
                    outboxRetainedBytes(value) +
                    metadata.retained_bytes;
                };
            };
            let nextMetadataBytes = switch (current) {
                case null {
                    let ?metadata = pendingOutboxMetadata else {
                        return false;
                    };
                    metadata.retained_bytes;
                };
                case (?_) {
                    let ?metadata = Map.get(
                        mem.outbox_metadata,
                        Nat64.compare,
                        mutation.local_id,
                    ) else return false;
                    metadata.retained_bytes;
                };
            };
            let newBytes =
                outboxRetainedBytes(mutation.next_item) +
                nextMetadataBytes;
            if (
                newBytes > oldBytes and
                mem.outbox_bytes + (newBytes - oldBytes) >
                    mem.quota_limits.outbox_bytes
            ) return false;
            let retention = switch (current) {
                case (?_) null;
                case null {
                    let ?metadata = pendingOutboxMetadata else {
                        return false;
                    };
                    let requests =
                        List.empty<
                            RetentionTypes.RegistrationRequest
                        >();
                    List.add(requests, {
                        view = #outbox({
                            local_id = mutation.local_id;
                            created_at_ns =
                                mutation.next_item.created_at_ns;
                            retry_expires_at_ns =
                                mutation.next_item.retry_expires_at_ns;
                            cleanup_at_ns =
                                mutation.next_item.retry_expires_at_ns;
                            retained_bytes = newBytes;
                            operation_key = operationKey;
                            retry_index_key = switch (
                                mutation.next_item.next_attempt_at_ns
                            ) {
                                case null null;
                                case (?at) {
                                    ?(at, mutation.local_id);
                                };
                            };
                            pending_credit_charge =
                                mutation.next_item
                                    .pending_credit_charge;
                            links_detached = false;
                        });
                        expected_previous = null;
                    });
                    switch (pendingFanoutTarget) {
                        case null {};
                        case (?target) {
                            let ?job = Map.get(
                                mem.fanout_jobs,
                                Nat64.compare,
                                target.fanout_job_id,
                            ) else return false;
                            let ?jobTargetCount = Map.get(
                                mem.fanout_target_count_by_job,
                                Nat64.compare,
                                target.fanout_job_id,
                            ) else return false;
                            if (
                                target.outbox_local_id !=
                                    mutation.local_id or
                                target.target_key !=
                                    FanoutPlanner.targetKey(
                                        target.fanout_job_id,
                                        target.registration_sequence,
                                    ) or
                                target.expires_at_ns !=
                                    job.expires_at_ns or
                                metadata.fanout_job_id !=
                                    ?target.fanout_job_id or
                                metadata.follower_registration_sequence !=
                                    ?target.registration_sequence or
                                metadata.linked_action_key !=
                                    ?job.action_key or
                                not Principal.equal(
                                    target.recipient,
                                    mutation.next_item.prepared.target,
                                ) or
                                Map.get(
                                    mem.fanout_targets,
                                    Text.compare,
                                    target.target_key,
                                ) != null or
                                mem.fanout_target_count >=
                                    mem.quota_limits
                                        .fanout_target_count or
                                jobTargetCount >=
                                    mem.quota_limits
                                        .fanout_target_count or
                                not quotaBytesAvailable(
                                    mem.fanout_bytes,
                                    0,
                                    target.retained_bytes,
                                    mem.quota_limits.fanout_bytes,
                                )
                            ) return false;
                            List.add(requests, {
                                view = #fanout_target({
                                    target_key = target.target_key;
                                    fanout_job_id =
                                        target.fanout_job_id;
                                    outbox_local_id =
                                        target.outbox_local_id;
                                    created_at_ns =
                                        job.created_at_ns;
                                    expires_at_ns =
                                        target.expires_at_ns;
                                    cleanup_at_ns =
                                        target.expires_at_ns;
                                    retained_bytes =
                                        target.retained_bytes;
                                    outbox_detached = false;
                                });
                                expected_previous = null;
                            });
                        };
                    };
                    let result = RetentionService.prepareRegistrations(
                        {
                            peer_records_ns =
                                mem.retention.peer_records_ns;
                            likes_ns = mem.retention.likes_ns;
                            rate_window_ns =
                                mem.retention.rate_window_ns;
                        },
                        mem.retention_sequence,
                        List.toArray(requests),
                    );
                    let plan = switch (result) {
                        case (#err(_)) return false;
                        case (#ok(value)) value;
                    };
                    if (not canApplyRetentionRegistration(plan)) {
                        return false;
                    };
                    ?plan;
                };
            };

            switch (current) {
                case null {};
                case (?value) {
                    if (
                        mem.scheduler.outbox_after_sequence ==
                            ?mutation.local_id and
                        value.next_attempt_at_ns !=
                            mutation.next_item.next_attempt_at_ns
                    ) {
                        // The durable cursor names an entry in the
                        // retry-time index. If that entry moves, resolving
                        // the same local ID on the next run could skip older
                        // due keys. Restarting at the ordered head is safe.
                        mem.scheduler := {
                            mem.scheduler with
                            outbox_after_sequence = null;
                        };
                    };
                    switch (value.next_attempt_at_ns) {
                        case null {};
                        case (?retryAt) {
                            Map.remove(
                                mem.outbox_by_retry_time,
                                orderedTimeCompare,
                                (retryAt, value.local_id),
                            );
                        };
                    };
                };
            };
            Map.add(
                mem.outbox,
                Nat64.compare,
                mutation.local_id,
                mutation.next_item,
            );
            Map.add(
                mem.outbox_by_operation,
                outboxOperationCompare,
                operationKey,
                mutation.local_id,
            );
            switch (mutation.next_item.next_attempt_at_ns) {
                case null {};
                case (?retryAt) {
                    Map.add(
                        mem.outbox_by_retry_time,
                        orderedTimeCompare,
                        (retryAt, mutation.local_id),
                        mutation.local_id,
                    );
                };
            };
            switch (current) {
                case null {
                    let ?metadata = pendingOutboxMetadata else {
                        Runtime.trap("Wagyu outbox metadata disappeared");
                    };
                    Map.add(
                        mem.outbox_metadata,
                        Nat64.compare,
                        mutation.local_id,
                        metadata,
                    );
                    switch (metadata.linked_action_key) {
                        case null {};
                        case (?actionKey) {
                            incrementAuthoredDependency(actionKey);
                        };
                    };
                    switch (pendingFanoutTarget) {
                        case null {};
                        case (?target) {
                            let ?jobTargetCount = Map.get(
                                mem.fanout_target_count_by_job,
                                Nat64.compare,
                                target.fanout_job_id,
                            ) else Runtime.trap(
                                "Wagyu fanout target count disappeared"
                            );
                            Map.add(
                                mem.fanout_targets,
                                Text.compare,
                                target.target_key,
                                target,
                            );
                            Map.add(
                                mem.fanout_target_count_by_job,
                                Nat64.compare,
                                target.fanout_job_id,
                                jobTargetCount + 1,
                            );
                            mem.fanout_target_count += 1;
                            mem.fanout_bytes +=
                                target.retained_bytes;
                        };
                    };
                    mem.outbox_count += 1;
                    mem.outbox_sequence := mutation.local_id;
                };
                case (?_) {};
            };
            if (newBytes >= oldBytes) {
                mem.outbox_bytes += newBytes - oldBytes;
            } else {
                mem.outbox_bytes -= oldBytes - newBytes;
            };
            switch (mutation.follower_mutation) {
                case null {};
                case (?followerMutation) {
                    applyFollowerMutation(followerMutation);
                    mem.relationship_revision += 1;
                };
            };
            switch (mutation.control_mutation) {
                case null {};
                case (?controlMutation) {
                    mem.outbox_control := controlMutation.next;
                };
            };
            switch (retention) {
                case null {};
                case (?plan) applyRetentionRegistration(plan);
            };
            mem.state_revision += 1;
            true;
        };

        func commitOutboxControl(
            mutation : OutboxTypes.ControlMutation
        ) : Bool {
            if (
                mem.outbox_control.revision != mutation.expected_revision or
                mem.state_revision == Nat64.maxValue
            ) return false;
            mem.outbox_control := mutation.next;
            mem.state_revision += 1;
            true;
        };

        func outboxRetainedBytes(item : OutboxTypes.Item) : Nat {
            var bytes =
                512 +
                item.prepared.operation_id.size() +
                item.prepared.payload_digest.size() +
                item.prepared.exact_body_candid.size() +
                item.prepared.exact_ingress_candid.size() +
                item.prepared.exact_call_args.size();
            switch (item.last_result) {
                case null {};
                case (?result) {
                    switch (result.exact_route_result_candid) {
                        case null {};
                        case (?exact) bytes += exact.size();
                    };
                    switch (result.code) {
                        case null {};
                        case (?code) bytes += Text.encodeUtf8(code).size();
                    };
                    switch (result.detail) {
                        case null {};
                        case (?detail) {
                            bytes += Text.encodeUtf8(detail).size();
                        };
                    };
                };
            };
            bytes;
        };

        func outboxPage(request : OutboxPageRequestV1) : OutboxPageV1 {
            let limit = Nat16.toNat(request.limit);
            if (limit == 0 or limit > Paging.MAX_PAGE_SIZE) {
                Runtime.trap("Outbox page limit must be between 1 and 50");
            };
            switch (request.expected_revision) {
                case (?expected) {
                    if (expected != mem.state_revision) {
                        Runtime.trap("Outbox page revision changed");
                    };
                };
                case null {};
            };
            let page = Paging.descendingNat64(
                mem.outbox,
                request.before_sequence,
                limit,
            );
            let values = List.empty<OutboxPageItemV1>();
            for ((_, item) in page.entries.vals()) {
                List.add(values, outboxItemToPublic(item));
            };
            {
                revision = mem.state_revision;
                items = List.toArray(values);
                next_before_sequence = page.next_before;
            };
        };

        func drainOutbox(
            requestedLimit : Nat16,
            mode : OutboxTypes.DrainMode,
            calls : NeutronCapabilities.BackendCallsV1,
        ) : async* OutboxDrainResultV1 {
            let limit = Nat16.toNat(requestedLimit);
            if (limit == 0 or limit > OutboxService.MAX_BATCH) {
                Runtime.trap("Outbox drain limit must be between 1 and 20");
            };
            let now = nowNs();
            recoverStaleSendingBatch(calls, now);
            advanceFanoutJobs(calls, now);
            let service = outboxServiceFor(calls);
            let cursor = switch (mode) {
                case (#owner) null;
                case (#automatic) mem.scheduler.outbox_after_sequence;
            };
            let plan = switch (
                service.planBatch({
                    after_local_id = cursor;
                    mode;
                    now_ns = now;
                })
            ) {
                case (#err(_)) return outboxDrainSummary(0, 0);
                case (#ok(value)) value;
            };
            switch (mode) {
                case (#owner) {};
                case (#automatic) {
                    mem.scheduler := {
                        mem.scheduler with
                        outbox_after_sequence =
                            if (plan.complete) null
                            else plan.next_after_local_id;
                    };
                };
            };
            let starts = List.empty<OutboxTypes.StartDispatch>();
            for (localId in plan.local_ids.vals()) {
                if (List.size(starts) < limit) {
                    let before = service.get(localId);
                    let authorized = switch (mode, before) {
                        case (#automatic, ?item) {
                            followDispatchAuthorized(
                                localId,
                                item,
                                #automatic,
                            );
                        };
                        case (_) true;
                    };
                    if (not authorized) {
                        switch (service.supersede(localId, now)) {
                            case (#ok(item)) {
                                let previous = switch (before) {
                                    case (?value) value.state;
                                    case null #queued;
                                };
                                reconcileFinishedOutbox(
                                    localId,
                                    previous,
                                    item,
                                    now,
                                );
                            };
                            case (#err(_)) {};
                        };
                    } else {
                        switch (service.beginDispatch(localId, mode, now)) {
                            case (#dispatch(start)) {
                                switch (before) {
                                    case null {};
                                    case (?item) {
                                        reconcileFanoutOutboxTransition(
                                            localId,
                                            item.state,
                                            #sending,
                                            now,
                                        );
                                    };
                                };
                                List.add(starts, start);
                            };
                            case (#err(_)) {};
                        };
                    };
                };
            };
            let batch = List.toArray(starts);
            if (batch.size() == 0) return outboxDrainSummary(0, 0);
            await* dispatchOutboxBatch(batch, calls);
        };

        func retryOutbox(
            localId : Nat64,
            calls : NeutronCapabilities.BackendCallsV1,
        ) : async* OutboxDrainResultV1 {
            let service = outboxServiceFor(calls);
            switch (mem.outbox_control.pause) {
                case null {};
                case (?_) {
                    ignore service.resumeNode(
                        mem.outbox_control.revision
                    );
                };
            };
            let ?item = service.get(localId) else {
                return outboxDrainSummary(0, 0);
            };
            let now = nowNs();
            if (
                not followDispatchAuthorized(
                    localId,
                    item,
                    #owner,
                )
            ) {
                switch (service.supersede(localId, now)) {
                    case (#ok(next)) {
                        reconcileFinishedOutbox(
                            localId,
                            item.state,
                            next,
                            now,
                        );
                    };
                    case (#err(_)) {};
                };
                return outboxDrainSummary(0, 0);
            };
            switch (item.state) {
                case (#paused or #failed or #uncertain) {
                    let allowed = switch (item.retry_permission) {
                        case (#manual or #local_state_change) true;
                        case (_) false;
                    };
                    let due = switch (item.next_attempt_at_ns) {
                        case null true;
                        case (?at) at <= now;
                    };
                    if (allowed and due) {
                        switch (service.resumeItem(localId, now)) {
                            case (#ok(next)) {
                                reconcileFanoutOutboxTransition(
                                    localId,
                                    item.state,
                                    next.state,
                                    now,
                                );
                            };
                            case (#err(_)) {};
                        };
                    };
                };
                case (_) {};
            };
            let before = service.get(localId);
            let start = switch (
                service.beginDispatch(localId, #owner, now)
            ) {
                case (#err(_)) return outboxDrainSummary(0, 0);
                case (#dispatch(value)) value;
            };
            switch (before) {
                case null {};
                case (?value) {
                    reconcileFanoutOutboxTransition(
                        localId,
                        value.state,
                        #sending,
                        now,
                    );
                };
            };
            await* dispatchOutboxBatch([start], calls);
        };

        func dispatchOutboxBatch(
            starts : [OutboxTypes.StartDispatch],
            calls : NeutronCapabilities.BackendCallsV1,
        ) : async* OutboxDrainResultV1 {
            if (
                starts.size() == 0 or
                starts.size() > OutboxService.MAX_BATCH
            ) return outboxDrainSummary(0, 0);
            let transport = Dispatcher.Dispatcher(node, calls);
            let prepared = Array.map<
                OutboxTypes.StartDispatch,
                TransportTypes.PreparedDispatchV1
            >(starts, func(start) { start.prepared });
            let dispatchedAt = nowNs();
            let batchResult = await* transport.callBatch(
                prepared,
                dispatchedAt,
            );
            let service = outboxServiceFor(calls);
            var completed = 0;
            switch (batchResult) {
                case (#err(_)) {
                    for (start in starts.vals()) {
                        let recoveredAt = nowNs();
                        switch (
                            service.recoverSending(
                                start.local_id,
                                recoveredAt,
                            )
                        ) {
                            case (#ok(item)) {
                                reconcileFinishedOutbox(
                                    start.local_id,
                                    #sending,
                                    item,
                                    recoveredAt,
                                );
                            };
                            case (#err(_)) {};
                        };
                    };
                };
                case (#ok(results)) {
                    if (results.size() != starts.size()) {
                        for (start in starts.vals()) {
                            let recoveredAt = nowNs();
                            switch (
                                service.recoverSending(
                                    start.local_id,
                                    recoveredAt,
                                )
                            ) {
                                case (#ok(item)) {
                                    reconcileFinishedOutbox(
                                        start.local_id,
                                        #sending,
                                        item,
                                        recoveredAt,
                                    );
                                };
                                case (#err(_)) {};
                            };
                        };
                    } else {
                        let callbackTime = nowNs();
                        var index = 0;
                        while (index < starts.size()) {
                            switch (
                                service.finishDispatch({
                                    local_id = starts[index].local_id;
                                    attempt_no = starts[index].attempt_no;
                                    result = results[index];
                                    callback_time_ns = callbackTime;
                                    jitter = OutboxService.retryJitter(
                                        starts[index].prepared,
                                        starts[index].attempt_no,
                                    );
                                })
                            ) {
                                case (#ok(item)) {
                                    reconcileFinishedOutbox(
                                        starts[index].local_id,
                                        #sending,
                                        item,
                                        callbackTime,
                                    );
                                    switch (item.state) {
                                        case (#accepted or #duplicate) {
                                            completed += 1;
                                        };
                                        case (_) {};
                                    };
                                };
                                case (#err(_)) {};
                            };
                            index += 1;
                        };
                    };
                };
            };
            outboxDrainSummary(starts.size(), completed);
        };

        func recoverStaleSendingBatch(
            calls : NeutronCapabilities.BackendCallsV1,
            now : Nat64,
        ) {
            let service = outboxServiceFor(calls);
            var examined = 0;
            var recovered = 0;
            let after = mem.scheduler.outbox_after_sequence;
            let entries = switch (after) {
                case null Map.entries(mem.outbox);
                case (?cursor) {
                    Map.entriesFrom(
                        mem.outbox,
                        Nat64.compare,
                        cursor,
                    );
                };
            };
            label scan for ((localId, item) in entries) {
                let strictlyAfter = switch (after) {
                    case null true;
                    case (?cursor) localId > cursor;
                };
                if (strictlyAfter) {
                    if (
                        examined >= OutboxService.MAX_PLAN_SCAN or
                        recovered >= OutboxService.MAX_BATCH
                    ) break scan;
                    examined += 1;
                    if (
                        item.state == #sending and
                        now >= item.updated_at_ns and
                        now - item.updated_at_ns >=
                            TransportTypes.UNCERTAIN_RETRY_DELAY_NS
                    ) {
                        switch (service.recoverSending(localId, now)) {
                            case (#ok(next)) {
                                reconcileFinishedOutbox(
                                    localId,
                                    #sending,
                                    next,
                                    now,
                                );
                                recovered += 1;
                            };
                            case (#err(_)) {};
                        };
                    };
                };
            };
        };

        // Expiry is an outbox state transition, not a raw retention delete:
        // it must first reconcile a prepared delivery charge and every
        // following/fanout pointer. The ordered local-id scan is bounded; as
        // terminal rows are cleaned, later rows naturally enter the window.
        func expireOutboxBatch(
            calls : NeutronCapabilities.BackendCallsV1,
            now : Nat64,
        ) {
            let service = outboxServiceFor(calls);
            var examined = 0;
            var transitioned = 0;
            label scan for ((localId, snapshot) in Map.entries(mem.outbox)) {
                if (
                    examined >= OutboxService.MAX_PLAN_SCAN or
                    transitioned >= OutboxService.MAX_BATCH
                ) break scan;
                examined += 1;

                var current = snapshot;
                if (
                    current.state == #sending and
                    now >= current.updated_at_ns and
                    now - current.updated_at_ns >=
                        TransportTypes.UNCERTAIN_RETRY_DELAY_NS
                ) {
                    switch (service.recoverSending(localId, now)) {
                        case (#ok(next)) {
                            reconcileFinishedOutbox(
                                localId,
                                #sending,
                                next,
                                now,
                            );
                            current := next;
                            transitioned += 1;
                        };
                        case (#err(_)) {};
                    };
                };

                if (
                    transitioned < OutboxService.MAX_BATCH and
                    now >= current.retry_expires_at_ns
                ) {
                    switch (current.state) {
                        case (
                            #queued or
                            #paused or
                            #failed or
                            #uncertain
                        ) {
                            switch (service.supersede(localId, now)) {
                                case (#ok(next)) {
                                    reconcileFinishedOutbox(
                                        localId,
                                        current.state,
                                        next,
                                        now,
                                    );
                                    transitioned += 1;
                                };
                                case (#err(_)) {};
                            };
                        };
                        case (_) {};
                    };
                };
            };
        };

        func reconcileFinishedOutbox(
            localId : Nat64,
            previous : OutboxTypes.StateV1,
            item : OutboxTypes.Item,
            at : Nat64,
        ) {
            reconcileFanoutOutboxTransition(
                localId,
                previous,
                item.state,
                at,
            );
            reconcileFollowingDispatch(localId, item, at);
            reAgeDetachedTerminalRetention(#outbox(localId), at);
        };

        func reconcileFanoutOutboxTransition(
            localId : Nat64,
            previous : OutboxTypes.StateV1,
            nextState : OutboxTypes.StateV1,
            at : Nat64,
        ) {
            let ?metadata = Map.get(
                mem.outbox_metadata,
                Nat64.compare,
                localId,
            ) else return;
            let ?jobId = metadata.fanout_job_id else return;
            let ?job = Map.get(
                mem.fanout_jobs,
                Nat64.compare,
                jobId,
            ) else {
                Runtime.trap("Wagyu fanout outbox lost its job");
            };
            let ?counters = FanoutPlanner.transition(
                fanoutCounters(job),
                previous,
                nextState,
            ) else {
                Runtime.trap("Wagyu fanout transition counters are corrupt");
            };
            let scanComplete = switch (job.state) {
                case (#queued or #scanning or #paused) false;
                case (#sending or #complete or #partial or #failed) true;
            };
            let ?state = FanoutPlanner.jobState(
                scanComplete,
                job.queued_count,
                counters,
            ) else {
                Runtime.trap("Wagyu fanout completion counters are corrupt");
            };
            let memoryState = fanoutStateToMemory(state);
            if (
                counters.completed == job.completed_count and
                counters.terminal == job.terminal_count and
                counters.uncertain == job.uncertain_count and
                memoryState == job.state
            ) return;
            storeFanoutJob({
                job with
                state = memoryState;
                completed_count = counters.completed;
                terminal_count = counters.terminal;
                uncertain_count = counters.uncertain;
                updated_at_ns = at;
            });
        };

        func reconcileFollowingDispatch(
            localId : Nat64,
            item : OutboxTypes.Item,
            at : Nat64,
        ) {
            // A definitely pre-dispatch failure can leave this exact
            // operation queued or paused for a later retry. No remote result
            // exists yet, so retain the generation/outbox link.
            let definitelyNotDispatched = switch (item.last_result) {
                case null false;
                case (?result) result.certainty == #not_dispatched;
            };
            if (item.state == #queued or definitelyNotDispatched) return;
            if (
                item.prepared.route != Bounds.FOLLOW_ROUTE and
                item.prepared.route != Bounds.UNFOLLOW_ROUTE
            ) return;
            let ?metadata = Map.get(
                mem.outbox_metadata,
                Nat64.compare,
                localId,
            ) else return;
            let ?intentGeneration =
                metadata.following_intent_generation else return;
            let subscription = if (
                item.prepared.route == Bounds.FOLLOW_ROUTE
            ) {
                let ?body = Wire.decodeFollowBody(
                    item.prepared.exact_body_candid
                ) else return;
                body.subscription_id;
            } else {
                let ?body = Wire.decodeUnfollowBody(
                    item.prepared.exact_body_candid
                ) else return;
                body.subscription_id;
            };
            let remote = remoteFollowingResult(item);
            reconciledFollowingOutboxId := ?localId;
            ignore relationships().applyRemoteFollowResult(
                item.prepared.target,
                intentGeneration,
                subscription,
                remote,
                at,
            );
            reconciledFollowingOutboxId := null;
            clearFollowingOutboxLink(
                item.prepared.target,
                intentGeneration,
                localId,
            );
        };

        func followDispatchAuthorized(
            localId : Nat64,
            item : OutboxTypes.Item,
            mode : { #automatic; #owner },
        ) : Bool {
            if (item.prepared.route != Bounds.FOLLOW_ROUTE) return true;
            let ?metadata = Map.get(
                mem.outbox_metadata,
                Nat64.compare,
                localId,
            ) else return false;
            let ?intentGeneration =
                metadata.following_intent_generation else return false;
            let ?following = Map.get(
                mem.following,
                Principal.compare,
                item.prepared.target,
            ) else return false;
            let ?body = Wire.decodeFollowBody(
                item.prepared.exact_body_candid
            ) else return false;
            let allowDetachedUncertain = switch (mode) {
                case (#automatic) false;
                case (#owner) {
                    switch (item.last_result) {
                        case null false;
                        case (?result) {
                            result.certainty ==
                                #may_have_dispatched;
                        };
                    };
                };
            };
            RelationshipService.followDispatchAuthorized(
                followingView(following),
                intentGeneration,
                body.subscription_id,
                following.pending_outbox_local_id == ?localId,
                following.pending_outbox_local_id == null,
                allowDetachedUncertain,
                Map.get(
                    mem.blocks,
                    Principal.compare,
                    item.prepared.target,
                ) != null,
            );
        };

        func remoteFollowingResult(
            item : OutboxTypes.Item
        ) : RelationshipTypes.RemoteFollowResult {
            let revision = switch (item.last_result) {
                case null null;
                case (?result) {
                    switch (result.route_result) {
                        case null null;
                        case (?routeResult) {
                            switch (routeResult.revision) {
                                case (?value) ?value;
                                case null {
                                    switch (routeResult.relationship) {
                                        case null null;
                                        case (?head) ?head.revision;
                                    };
                                };
                            };
                        };
                    };
                };
            };
            switch (item.state) {
                case (#accepted) {
                    switch (revision, item.last_attempt_at_ns) {
                        case (?value, ?paidAnchor) {
                            #accepted({
                                revision = value;
                                paid_anchor_ns = paidAnchor;
                            });
                        };
                        case (_) #uncertain(revision);
                    };
                };
                case (#duplicate) {
                    switch (revision, item.last_attempt_at_ns) {
                        case (?value, ?paidAnchor) {
                            #duplicate({
                                revision = value;
                                paid_anchor_ns = paidAnchor;
                            });
                        };
                        case (_) #uncertain(revision);
                    };
                };
                case (_) {
                    switch (item.last_result) {
                        case (?result) {
                            switch (result.outcome) {
                                case (#route_rejected(#conflict)) {
                                    switch (revision) {
                                        case (?value) {
                                            #revision_conflict(value);
                                        };
                                        case null #uncertain(null);
                                    };
                                };
                                case (
                                    #route_rejected(#incompatible)
                                ) #incompatible(revision);
                                case (_) #uncertain(revision);
                            };
                        };
                        case null #uncertain(null);
                    };
                };
            };
        };

        func clearFollowingOutboxLink(
            peer : Principal,
            intentGeneration : Nat,
            localId : Nat64,
        ) {
            let ?current = Map.get(
                mem.following,
                Principal.compare,
                peer,
            ) else return;
            if (
                current.intent_generation != intentGeneration or
                current.pending_outbox_local_id != ?localId
            ) return;
            Map.add(
                mem.following,
                Principal.compare,
                peer,
                {
                    current with
                    pending_outbox_local_id = null;
                },
            );
            bumpState();
        };

        func outboxDrainSummary(
            attempted : Nat,
            completed : Nat,
        ) : OutboxDrainResultV1 {
            let pause = outboxPause();
            let outbox = outboxWorkSummary();
            {
                state_revision = mem.state_revision;
                outbox_revision = mem.outbox_control.revision;
                attempted;
                completed;
                remaining = outbox.queued;
                errors = outbox.errors;
                paused = pause != null;
                pause_reason = pause;
            };
        };

        func ingressFollow(
            caller : Principal,
            request : WagyuIngressV1,
        ) : WagyuRouteResultV1 {
            executeIngress(caller, #follow, request);
        };

        func ingressUnfollow(
            caller : Principal,
            request : WagyuIngressV1,
        ) : WagyuRouteResultV1 {
            executeIngress(caller, #unfollow, request);
        };

        func ingressDeliver(
            caller : Principal,
            request : WagyuIngressV1,
        ) : WagyuRouteResultV1 {
            executeIngress(caller, #deliver, request);
        };

        func ingressLike(
            caller : Principal,
            request : WagyuIngressV1,
        ) : WagyuRouteResultV1 {
            executeIngress(caller, #like, request);
        };

        func ingressNotice(
            caller : Principal,
            request : WagyuIngressV1,
        ) : WagyuRouteResultV1 {
            executeIngress(caller, #notice, request);
        };

        // Every published post owns a certified mutable reply index, including
        // the empty state. Creating it before fanout means a reader never has
        // to interpret an uncertified HTTP 404 as proof of zero replies.
        func ensureCertifiedReplyIndex(
            post : Memory.AuthoredPost,
            committedAt : Nat64,
        ) : LocalResultV1<Bool> {
            let indexKey = replyIndexStableKey(post.post_id);
            switch (
                Map.get(
                    mem.reply_indexes,
                    Text.compare,
                    indexKey,
                )
            ) {
                case (?_) #ok(false);
                case null {
                    writeCertifiedReplyIndex(
                        post,
                        indexKey,
                        null,
                        [],
                        post.post_id,
                        committedAt,
                    );
                };
            };
        };

        func promoteLocalReplyIndex(
            post : Memory.AuthoredPost,
            receivedAt : Nat64,
        ) : LocalResultV1<Bool> {
            let replyTo = switch (post.body.reply_to) {
                case null return #ok(false);
                case (?value) {
                    if (not Principal.equal(value.author, node)) {
                        return #ok(false);
                    };
                    value;
                };
            };
            promoteVerifiedReplyIndex(
                {
                    author = node;
                    post_id = post.post_id;
                    body_hash = post.body_hash;
                    body_length = post.body_length;
                    object_digest = post.object_digest;
                    reply_to = replyTo;
                },
                null,
                receivedAt,
            );
        };

        func applyReplyIndexVerification(
            summary : Protocol.NotificationSummaryV1,
            next : NotificationTypes.NotificationVerificationV1,
            verifiedReply : ?OwnerBridgeTypes.VerifiedReplyInputV1,
            committedAt : Nat64,
        ) : LocalResultV1<Bool> {
            switch (next) {
                case (#verified) {
                    let ?verified = verifiedReply
                        else return #err(#invalid);
                    promoteVerifiedReplyIndex(
                        verified,
                        ?summary,
                        summary.received_at_ns,
                    );
                };
                case (#invalid) {
                    if (verifiedReply != null) return #err(#invalid);
                    removeCertifiedReplyIndexEntry(
                        summary,
                        committedAt,
                    );
                };
                case (#unavailable) {
                    if (verifiedReply != null) return #err(#invalid);
                    #ok(false);
                };
                case (#pending or #transport_authenticated) {
                    #err(#invalid);
                };
            };
        };

        func promoteVerifiedReplyIndex(
            verified : OwnerBridgeTypes.VerifiedReplyInputV1,
            notification : ?Protocol.NotificationSummaryV1,
            receivedAt : Nat64,
        ) : LocalResultV1<Bool> {
            if (
                not Principal.isCanister(verified.author) or
                verified.post_id.size() != Bounds.HASH_BYTES or
                verified.body_hash.size() != Bounds.HASH_BYTES or
                verified.object_digest.size() != Bounds.HASH_BYTES or
                not Bounds.bodyLengthWithin(verified.body_length, #post) or
                not Validation.replyTo(verified.reply_to) or
                not Principal.equal(verified.reply_to.author, node) or
                isBlockedNode(verified.author)
            ) return #err(#invalid);
            let ?derivedPostId = Hash.postId(
                currentProfile().network_id,
                verified.author,
                verified.body_hash,
            ) else return #err(#invalid);
            if (not Blob.equal(derivedPostId, verified.post_id)) {
                return #err(#conflict);
            };
            switch (notification) {
                case null {
                    if (not Principal.equal(verified.author, node)) {
                        return #err(#invalid);
                    };
                };
                case (?summary) {
                    if (
                        not Principal.equal(
                            summary.actor_,
                            verified.author,
                        )
                    ) return #err(#conflict);
                    let ?kind = summary.kind else return #err(#conflict);
                    switch (kind) {
                        case (#reply(locator)) {
                            if (
                                not Blob.equal(
                                    locator.target_post_id,
                                    verified.reply_to.post_id,
                                ) or
                                not Blob.equal(
                                    locator.target_body_hash,
                                    verified.reply_to.body_hash,
                                ) or
                                not Blob.equal(
                                    locator.action_id,
                                    verified.post_id,
                                ) or
                                not Blob.equal(
                                    locator.object_digest,
                                    verified.object_digest,
                                ) or
                                locator.object_length !=
                                    verified.body_length
                            ) return #err(#conflict);
                        };
                        case (_) return #err(#conflict);
                    };
                };
            };

            let parentKey = postStableKey(verified.reply_to.post_id);
            let ?parent = Map.get(
                mem.authored_posts,
                Text.compare,
                parentKey,
            ) else return #err(#not_found);
            if (
                parent.status != #live or
                not Blob.equal(
                    parent.body_hash,
                    verified.reply_to.body_hash,
                ) or
                parent.body_length != verified.reply_to.body_length or
                not Blob.equal(
                    parent.object_digest,
                    verified.reply_to.object_digest,
                )
            ) return #err(#conflict);

            let indexKey = replyIndexStableKey(parent.post_id);
            let previous = Map.get(
                mem.reply_indexes,
                Text.compare,
                indexKey,
            );
            let oldReplies : [Protocol.ReplyIndexEntryV1] = switch (
                previous
            ) {
                case null [];
                case (?current) {
                    Array.map<Memory.ReplyIndexEntryV1, Protocol.ReplyIndexEntryV1>(
                        current.value.replies,
                        memoryReplyIndexEntryToProtocol,
                    );
                };
            };
            let replies = switch (
                ReplyAdmission.promote(
                    oldReplies,
                    {
                        author = verified.author;
                        post_id = verified.post_id;
                        object_digest = verified.object_digest;
                        object_length = verified.body_length;
                        received_at_ns = receivedAt;
                    },
                )
            ) {
                case (#duplicate) return #ok(false);
                case (#conflict) return #err(#conflict);
                case (#terminal_unindexed) return #ok(false);
                case (#invalid) return #err(#invalid);
                case (#append(value)) value;
            };
            writeCertifiedReplyIndex(
                parent,
                indexKey,
                previous,
                replies,
                verified.post_id,
                receivedAt,
            );
        };

        func removeCertifiedReplyIndexEntry(
            summary : Protocol.NotificationSummaryV1,
            removedAt : Nat64,
        ) : LocalResultV1<Bool> {
            let ?kind = summary.kind else return #ok(false);
            let locator = switch (kind) {
                case (#reply(value)) value;
                case (_) return #ok(false);
            };
            let parentKey = postStableKey(locator.target_post_id);
            let ?parent = Map.get(
                mem.authored_posts,
                Text.compare,
                parentKey,
            ) else return #ok(false);
            let indexKey = replyIndexStableKey(parent.post_id);
            let ?previous = Map.get(
                mem.reply_indexes,
                Text.compare,
                indexKey,
            ) else return #ok(false);
            let oldReplies = Array.map<
                Memory.ReplyIndexEntryV1,
                Protocol.ReplyIndexEntryV1
            >(
                previous.value.replies,
                memoryReplyIndexEntryToProtocol,
            );
            let replies = switch (
                ReplyAdmission.remove(
                    oldReplies,
                    summary.actor_,
                    locator.action_id,
                )
            ) {
                case (#unchanged) return #ok(false);
                case (#removed(value)) value;
            };
            writeCertifiedReplyIndex(
                parent,
                indexKey,
                ?previous,
                replies,
                locator.action_id,
                removedAt,
            );
        };

        func writeCertifiedReplyIndex(
            post : Memory.AuthoredPost,
            indexKey : Text,
            previous : ?Memory.ReplyIndexState,
            replies : [Protocol.ReplyIndexEntryV1],
            nonceSeed : Blob,
            committedAt : Nat64,
        ) : LocalResultV1<Bool> {
            let ?generation = collectionGeneration(
                Publication.REPLY_INDEXES_COLLECTION
            ) else return #err(#certified_store);
            let revision : Nat64 = switch (previous) {
                case null 1;
                case (?current) {
                    if (current.value.revision == Nat64.maxValue) {
                        return #err(#full);
                    };
                    current.value.revision + 1;
                };
            };
            let value : Protocol.ReplyIndexV1 = {
                network_id = currentProfile().network_id;
                post_author = node;
                post_id = post.post_id;
                post_body_hash = post.body_hash;
                store_generation = generation;
                revision;
                previous_index_hash = switch (previous) {
                    case null null;
                    case (?current) ?current.body_digest;
                };
                replies;
            };
            let bodyCandid = to_candid (value);
            if (
                bodyCandid.size() == 0 or
                bodyCandid.size() > Bounds.MAX_REPLY_INDEX_BYTES
            ) return #err(#full);
            let bodyDigest = Hash.objectDigest(bodyCandid);
            let target = Publication.replyIndexTarget(
                generation,
                post.post_id,
            );
            let expected : ?Publication.StoredIdentity = switch (previous) {
                case null null;
                case (?current) {
                    ?memoryKernelIdentityToStored(
                        current.kernel_identity
                    );
                };
            };
            let oldBytes = switch (previous) {
                case null 0;
                case (?current) {
                    Nat32.toNat(current.kernel_identity.body_length);
                };
            };
            if (
                (previous == null and
                    mem.certified_object_count >=
                        mem.quota_limits.certified_object_count) or
                mem.state_revision == Nat64.maxValue or
                not canApplyByteReplacement(
                    mem.certified_object_bytes,
                    mem.quota_limits.certified_object_bytes,
                    oldBytes,
                    bodyCandid.size(),
                )
            ) return #err(#full);
            let mutations = switch (
                PublicationJournal.replyIndex({
                    index = {
                        target;
                        body_digest = bodyDigest;
                        body_length = bodyCandid.size();
                    };
                    expected_index = expected;
                })
            ) {
                case (#err(_)) return #err(#certified_store);
                case (#ok(value)) value;
            };
            let nonce = derivedNonce(
                "wagyu.reply-index-publication.v1",
                nonceSeed,
                bodyDigest,
            );
            let ?journal = preparePublicationJournal(
                #positive_batch,
                nonce,
                bodyDigest,
                mutations,
            ) else return #err(#full);
            let condition : NeutronCapabilities.Condition = switch (
                expected
            ) {
                case null #absent;
                case (?identity) Publication.cas(identity);
            };
            let receipt = switch (
                certifiedAssets.commit_batch({
                    nonce;
                    operations = [
                        Publication.put(
                            target,
                            condition,
                            #inline(bodyCandid),
                        ),
                    ];
                    requires_present_after = [];
                })
            ) {
                case (#err(#quota or #receipt_full)) {
                    return #err(#full);
                };
                case (#err(_)) return #err(#certified_store);
                case (#ok(value)) value;
            };
            let ?capabilityIdentity = Publication.committedAt(
                receipt,
                0,
                target,
                bodyDigest,
                bodyCandid.size(),
            ) else Runtime.trap(
                "Kernel returned an invalid Wagyu reply-index receipt"
            );
            let identity = capabilityIdentityToMemory(
                capabilityIdentity
            );
            let publicationId = nextPublicationId();
            switch (previous) {
                case null {
                    rememberNewCertifiedRecord(
                        identity,
                        publicationId,
                        ?indexKey,
                        committedAt,
                    );
                };
                case (?current) {
                    replaceCertifiedRecord(
                        current.kernel_identity,
                        identity,
                        publicationId,
                        ?indexKey,
                        committedAt,
                    );
                };
            };
            Map.add(mem.reply_indexes, Text.compare, indexKey, {
                index_key = indexKey;
                value = protocolReplyIndexToMemory(value);
                exact_body_candid = bodyCandid;
                body_digest = bodyDigest;
                kernel_identity = identity;
                publication_id = publicationId;
            });
            rememberCommittedPublication(
                publicationId,
                #replace_reply_index,
                journal,
                [identity],
                committedAt,
            );
            bumpState();
            #ok(true);
        };

        func executeIngress(
            caller : Principal,
            route : IngressTypes.Route,
            request : WagyuIngressV1,
        ) : WagyuRouteResultV1 {
            let response = IngressService.execute(
                ingressState(),
                {
                    route;
                    caller;
                    exact_ingress_candid = to_candid (request);
                    network_id = currentProfile().network_id;
                    self_node = node;
                    now_ns = nowNs();
                },
            );
            response.result;
        };

        func capabilityIdentityToMemory(
            identity : NeutronCapabilities.RecordIdentity
        ) : Memory.KernelRecordIdentity {
            {
                target = capabilityTargetToMemory(identity.target);
                kernel_revision = identity.kernel_revision;
                content_tag = identity.content_tag;
                body_digest = identity.content_tag;
                body_length = Nat32.fromNat(identity.body_bytes);
            };
        };

        func capabilityTargetToMemory(
            target : NeutronCapabilities.Target
        ) : Memory.CertifiedTarget {
            let collection = switch (collectionFromText(target.collection)) {
                case (?value) value;
                case null Runtime.trap(
                    "Kernel returned an undeclared Wagyu collection"
                );
            };
            let key : Memory.CertifiedTargetKey = switch (target.locator) {
                case (#body_sha256(value)) #digest(value.digest);
                case (#key32(value)) #post_id(value.key);
                case (#exact_path) #profile;
                case (#publication(_)) Runtime.trap(
                    "Kernel returned an invalid Wagyu collection locator"
                );
            };
            {
                collection;
                collection_generation = target.collection_generation;
                key;
            };
        };

        func memoryTargetToCapability(
            target : Memory.CertifiedTarget
        ) : NeutronCapabilities.Target {
            let locator : NeutronCapabilities.Locator = switch (target.key) {
                case (#digest(value)) #body_sha256({ digest = value });
                case (#post_id(value)) #key32({ key = value });
                case (#profile) #exact_path;
            };
            {
                collection = collectionText(target.collection);
                collection_generation = target.collection_generation;
                locator;
            };
        };

        func collectionFromText(
            value : Text
        ) : ?Memory.CertifiedCollection {
            if (value == Publication.POSTS_COLLECTION) return ?#posts;
            if (value == Publication.SHARES_COLLECTION) return ?#shares;
            if (value == Publication.TOMBSTONES_COLLECTION) {
                return ?#tombstones;
            };
            if (value == Publication.LIKES_COLLECTION) return ?#likes;
            if (value == Publication.LIKE_BATCHES_COLLECTION) {
                return ?#like_batches;
            };
            if (value == Publication.LIKE_HEADS_COLLECTION) {
                return ?#like_heads;
            };
            if (value == Publication.REPLY_INDEXES_COLLECTION) {
                return ?#reply_indexes;
            };
            if (value == Publication.PROFILE_COLLECTION) return ?#profile;
            null;
        };

        func collectionText(
            value : Memory.CertifiedCollection
        ) : Text {
            switch (value) {
                case (#posts) Publication.POSTS_COLLECTION;
                case (#shares) Publication.SHARES_COLLECTION;
                case (#tombstones) Publication.TOMBSTONES_COLLECTION;
                case (#likes) Publication.LIKES_COLLECTION;
                case (#like_batches) Publication.LIKE_BATCHES_COLLECTION;
                case (#like_heads) Publication.LIKE_HEADS_COLLECTION;
                case (#reply_indexes) Publication.REPLY_INDEXES_COLLECTION;
                case (#profile) Publication.PROFILE_COLLECTION;
            };
        };

        func committedIdentity(
            receipt : NeutronCapabilities.BatchReceipt,
            index : Nat,
            target : NeutronCapabilities.Target,
            digest : Blob,
        ) : ?NeutronCapabilities.RecordIdentity {
            if (index >= receipt.operations.size()) return null;
            switch (receipt.operations[index]) {
                case (#delete(_)) null;
                case (#put(value)) {
                    let identity = value.lifecycle.committed;
                    if (
                        Nat32.toNat(value.request_index) != index or
                        not Publication.sameTarget(identity.target, target) or
                        not Blob.equal(identity.content_tag, digest)
                    ) return null;
                    ?identity;
                };
            };
        };

        func committedDeletion(
            receipt : NeutronCapabilities.BatchReceipt,
            expected : Memory.KernelRecordIdentity,
        ) : ?NeutronCapabilities.DeletedIdentity {
            if (
                receipt.operations.size() != 1 or
                expected.kernel_revision == Nat64.maxValue
            ) return null;
            switch (receipt.operations[0]) {
                case (#put(_)) null;
                case (#delete(value)) {
                    let identity = value.identity;
                    if (
                        value.request_index != 0 or
                        not Publication.sameTarget(
                            identity.target,
                            memoryTargetToCapability(expected.target),
                        ) or
                        identity.kernel_revision !=
                            expected.kernel_revision + 1 or
                        not Blob.equal(
                            identity.prior_content_tag,
                            expected.content_tag,
                        )
                    ) return null;
                    ?identity;
                };
            };
        };

        func certifiedAssetsReady() : Bool {
            switch (certifiedAssets.scope_info()) {
                case (#ok(_)) true;
                case (#err(_)) false;
            };
        };

        func protocolProfileToMemory(
            value : Protocol.ProfileV1
        ) : Memory.ProfileV1 {
            {
                network_id = value.network_id;
                node = value.node;
                profile_generation = value.profile_generation;
                revision = value.revision;
                updated_at_ns = value.updated_at_ns;
                previous_profile_digest = value.previous_profile_digest;
                display_name = value.display_name;
                description = value.description;
                capabilities = value.capabilities;
                avatar = protocolAvatarToMemory(value.avatar);
            };
        };

        func memoryProfileToProtocol(
            value : Memory.ProfileV1
        ) : Protocol.ProfileV1 {
            {
                network_id = value.network_id;
                node = value.node;
                profile_generation = value.profile_generation;
                revision = value.revision;
                updated_at_ns = value.updated_at_ns;
                previous_profile_digest = value.previous_profile_digest;
                display_name = value.display_name;
                description = value.description;
                capabilities = value.capabilities;
                avatar = profileAvatarToProtocol(value.avatar);
            };
        };

        func protocolAvatarToMemory(
            value : ?Protocol.AvatarV1
        ) : ?Memory.ProfileAvatarV1 {
            switch (value) {
                case null null;
                case (?avatar) {
                    ?{
                        media_type = switch (avatar.media_type) {
                            case null null;
                            case (?#jpeg) ?#jpeg;
                            case (?#png) ?#png;
                            case (?#webp) ?#webp;
                        };
                        width = avatar.width;
                        height = avatar.height;
                        bytes = avatar.bytes;
                    };
                };
            };
        };

        func profileAvatarToProtocol(
            value : ?Memory.ProfileAvatarV1
        ) : ?Protocol.AvatarV1 {
            switch (value) {
                case null null;
                case (?avatar) {
                    ?{
                        media_type = switch (avatar.media_type) {
                            case null null;
                            case (?#jpeg) ?#jpeg;
                            case (?#png) ?#png;
                            case (?#webp) ?#webp;
                        };
                        width = avatar.width;
                        height = avatar.height;
                        bytes = avatar.bytes;
                    };
                };
            };
        };

        func mapAvatarMediaToProtocol(
            value : ?AvatarMediaTypeV1
        ) : ?Protocol.AvatarMediaTypeV1 {
            switch (value) {
                case null null;
                case (?#jpeg) ?#jpeg;
                case (?#png) ?#png;
                case (?#webp) ?#webp;
            };
        };

        func mapAvatarMediaToPublic(
            value : ?Memory.ProfileMediaType
        ) : ?AvatarMediaTypeV1 {
            switch (value) {
                case null null;
                case (?#jpeg) ?#jpeg;
                case (?#png) ?#png;
                case (?#webp) ?#webp;
            };
        };

        func mapFeedKindToPublic(
            value : ?Memory.FeedEventKind
        ) : ?FeedEventKindV1 {
            switch (value) {
                case null null;
                case (?#original) ?#original;
                case (?#share) ?#share;
                case (?#tombstone) ?#tombstone;
            };
        };

        func mapFeedVerificationToPublic(
            value : ?Memory.FeedVerification
        ) : ?VerificationStateV1 {
            switch (value) {
                case null null;
                case (?#pending) ?#pending;
                case (?#verified) ?#verified;
                case (?#invalid) ?#invalid;
                case (?#unavailable) ?#unavailable;
            };
        };

        func notificationToPublic(
            value : Memory.NotificationSummary
        ) : NotificationSummaryV1 {
            {
                local_sequence = value.local_sequence;
                received_at_ns = value.received_at_ns;
                actor_ = value.actor_;
                kind = switch (value.kind) {
                    case null null;
                    case (?#new_follower(info)) {
                        ?#new_follower({
                            follower_revision = info.follower_revision;
                        });
                    };
                    case (?#like(info)) ?#like(notificationAction(info));
                    case (?#reply(info)) ?#reply(notificationAction(info));
                    case (?#share(info)) ?#share(notificationAction(info));
                };
                verification = switch (value.verification) {
                    case null null;
                    case (?#transport_authenticated) {
                        ?#transport_authenticated;
                    };
                    case (?#pending) ?#pending;
                    case (?#verified) ?#verified;
                    case (?#invalid) ?#invalid;
                    case (?#unavailable) ?#unavailable;
                };
                read = value.read;
            };
        };

        func notificationAction(
            value : Memory.NotificationAction
        ) : DirectedActionSummaryV1 {
            {
                target_post_id = value.target_post_id;
                target_body_hash = value.target_body_hash;
                action_id = value.action_id;
                object_digest = value.object_digest;
                object_length = value.object_length;
            };
        };

        func outboxItemToPublic(
            value : Memory.OutboxItem
        ) : OutboxPageItemV1 {
            let state : ?OutboxStateV1 = switch (value.state) {
                case (#queued) ?#queued;
                case (#sending) ?#sending;
                case (#accepted) ?#accepted;
                case (#duplicate) ?#duplicate;
                case (#paused) ?#paused;
                case (#failed) ?#failed;
                case (#uncertain) ?#uncertain;
                case (#superseded) ?#superseded;
            };
            let retryable = switch (value.retry_permission) {
                case (#none) false;
                case (_) true;
            };
            let lastError = switch (value.last_result) {
                case null null;
                case (?result) {
                    switch (result.detail, result.code) {
                        case (?detail, _) ?detail;
                        case (null, ?code) ?code;
                        case (null, null) null;
                    };
                };
            };
            {
                local_sequence = value.local_id;
                recipient = value.prepared.target;
                route = outboxRouteToPublic(value.prepared.route);
                state;
                attempt_count = Nat32.toNat(value.attempt_no);
                retryable;
                next_retry_at_ns = value.next_attempt_at_ns;
                last_error = lastError;
                created_at_ns = value.created_at_ns;
                updated_at_ns = value.updated_at_ns;
                fanout = outboxFanoutProgress(value.local_id);
            };
        };

        func outboxRouteToPublic(route : Text) : ?OutboxRouteV1 {
            if (route == Bounds.FOLLOW_ROUTE) return ?#follow;
            if (route == Bounds.UNFOLLOW_ROUTE) return ?#unfollow;
            if (route == Bounds.DELIVER_ROUTE) return ?#deliver;
            if (route == Bounds.LIKE_ROUTE) return ?#like;
            if (route == Bounds.NOTICE_ROUTE) return ?#notice;
            null;
        };

        func outboxFanoutProgress(
            localId : Nat64
        ) : ?FanoutProgressV1 {
            let ?metadata = Map.get(
                mem.outbox_metadata,
                Nat64.compare,
                localId,
            ) else Runtime.trap("Wagyu outbox metadata is missing");
            let ?jobId = metadata.fanout_job_id else return null;
            let ?job = Map.get(
                mem.fanout_jobs,
                Nat64.compare,
                jobId,
            ) else Runtime.trap("Wagyu fanout job is missing");
            let state : ?FanoutStateV1 = switch (job.state) {
                case (#queued) ?#queued;
                case (#scanning) ?#scanning;
                case (#sending) ?#sending;
                case (#complete) ?#complete;
                case (#partial) ?#partial;
                case (#paused) ?#paused;
                case (#failed) ?#failed;
            };
            ?{
                job_id = job.fanout_job_id;
                state;
                eligible_recipient_count =
                    if (job.queued_count > job.eligible_count) {
                        job.queued_count;
                    } else job.eligible_count;
                queued_recipient_count = job.queued_count;
                completed_recipient_count = job.completed_count;
                terminal_recipient_count = job.terminal_count;
                uncertain_recipient_count = job.uncertain_count;
            };
        };

        func outboxPause() : ?PauseReasonV1 {
            switch (mem.outbox_control.pause) {
                case (?#low_cycles) ?#low_cycles;
                case (?#authority_revoked) ?#revoked;
                case null null;
            };
        };

        func outboxWorkSummary() : {
            queued : Nat;
            errors : Nat;
            saturated : Bool;
        } {
            var queued = 0;
            var errors = 0;
            var inspected = 0;
            label scan for ((_, value) in Map.entries(mem.outbox)) {
                if (inspected >= OUTBOUND_SUMMARY_SCAN_LIMIT) {
                    break scan;
                };
                inspected += 1;
                switch (value.state) {
                    case (#queued or #sending) queued += 1;
                    case (#paused or #failed or #uncertain) {
                        errors += 1;
                    };
                    case (_) {};
                };
            };
            {
                queued;
                errors;
                saturated = Map.size(mem.outbox) > inspected;
            };
        };

        func fanoutWorkSummary() : {
            pending : Bool;
            saturated : Bool;
        } {
            var inspected = 0;
            var pending = false;
            label scan for ((_, value) in Map.entries(mem.fanout_jobs)) {
                if (inspected >= OUTBOUND_SUMMARY_SCAN_LIMIT) {
                    break scan;
                };
                inspected += 1;
                switch (value.state) {
                    case (#queued or #scanning or #paused) {
                        pending := true;
                    };
                    case (_) {};
                };
            };
            {
                pending;
                saturated =
                    Map.size(mem.fanout_jobs) > inspected;
            };
        };

        func rejected(
            reason : WagyuRejectionReasonV1,
            time : Nat64,
        ) : WagyuRouteResultV1 {
            {
                outcome = ?#rejected({ reason = ?reason });
                local_receipt_time_ns = ?time;
                revision = null;
                relationship = null;
            };
        };

        func protocolRouteToMemory(
            value : Protocol.WagyuRouteResultV1
        ) : Memory.WagyuRouteResultV1 {
            {
                outcome = switch (value.outcome) {
                    case null null;
                    case (?#accepted) ?#accepted;
                    case (?#duplicate) ?#duplicate;
                    case (?#rejected(info)) {
                        ?#rejected({
                            reason = switch (info.reason) {
                                case null null;
                                case (?#invalid) ?#invalid;
                                case (?#blocked) ?#blocked;
                                case (?#not_following) ?#not_following;
                                case (?#unknown_post) ?#unknown_post;
                                case (?#expired) ?#expired;
                                case (?#full) ?#full;
                                case (?#conflict) ?#conflict;
                                case (?#incompatible) ?#incompatible;
                            };
                        });
                    };
                };
                local_receipt_time_ns =
                    value.local_receipt_time_ns;
                revision = value.revision;
                relationship = switch (value.relationship) {
                    case null null;
                    case (?head) {
                        ?{
                            revision = head.revision;
                            state = switch (head.state) {
                                case null null;
                                case (?#active(active)) {
                                    ?#active(active);
                                };
                                case (?#inactive(inactive)) {
                                    ?#inactive(inactive);
                                };
                            };
                        };
                    };
                };
            };
        };

        func memoryRouteToProtocol(
            value : Memory.WagyuRouteResultV1
        ) : Protocol.WagyuRouteResultV1 {
            {
                outcome = switch (value.outcome) {
                    case null null;
                    case (?#accepted) ?#accepted;
                    case (?#duplicate) ?#duplicate;
                    case (?#rejected(info)) {
                        ?#rejected({
                            reason = switch (info.reason) {
                                case null null;
                                case (?#invalid) ?#invalid;
                                case (?#blocked) ?#blocked;
                                case (?#not_following) ?#not_following;
                                case (?#unknown_post) ?#unknown_post;
                                case (?#expired) ?#expired;
                                case (?#full) ?#full;
                                case (?#conflict) ?#conflict;
                                case (?#incompatible) ?#incompatible;
                            };
                        });
                    };
                };
                local_receipt_time_ns =
                    value.local_receipt_time_ns;
                revision = value.revision;
                relationship = switch (value.relationship) {
                    case null null;
                    case (?head) {
                        ?{
                            revision = head.revision;
                            state = switch (head.state) {
                                case null null;
                                case (?#active(active)) {
                                    ?#active(active);
                                };
                                case (?#inactive(inactive)) {
                                    ?#inactive(inactive);
                                };
                            };
                        };
                    };
                };
            };
        };

        func protocolNotificationKindToMemory(
            value : ?Protocol.NotificationKindV1
        ) : ?Memory.NotificationKind {
            switch (value) {
                case null null;
                case (?#new_follower(info)) {
                    ?#new_follower(info);
                };
                case (?#like(info)) ?#like(info);
                case (?#reply(info)) ?#reply(info);
                case (?#share(info)) ?#share(info);
            };
        };

        func protocolNotificationVerificationToMemory(
            value : ?Protocol.NotificationVerificationV1
        ) : ?Memory.NotificationVerification {
            switch (value) {
                case null null;
                case (?#transport_authenticated) {
                    ?#transport_authenticated;
                };
                case (?#pending) ?#pending;
                case (?#verified) ?#verified;
                case (?#invalid) ?#invalid;
                case (?#unavailable) ?#unavailable;
            };
        };

        func publicRouteToMemory(
            value : WagyuRouteResultV1
        ) : Memory.WagyuRouteResultV1 {
            {
                outcome = switch (value.outcome) {
                    case null null;
                    case (?#accepted) ?#accepted;
                    case (?#duplicate) ?#duplicate;
                    case (?#rejected(info)) {
                        ?#rejected({
                            reason = switch (info.reason) {
                                case null null;
                                case (?reason) ?publicRejectionToMemory(reason);
                            };
                        });
                    };
                };
                local_receipt_time_ns = value.local_receipt_time_ns;
                revision = value.revision;
                relationship = switch (value.relationship) {
                    case null null;
                    case (?head) ?publicFollowerHeadToMemory(head);
                };
            };
        };

        func memoryRouteToPublic(
            value : Memory.WagyuRouteResultV1
        ) : WagyuRouteResultV1 {
            {
                outcome = switch (value.outcome) {
                    case null null;
                    case (?#accepted) ?#accepted;
                    case (?#duplicate) ?#duplicate;
                    case (?#rejected(info)) {
                        ?#rejected({
                            reason = switch (info.reason) {
                                case null null;
                                case (?reason) ?memoryRejectionToPublic(reason);
                            };
                        });
                    };
                };
                local_receipt_time_ns = value.local_receipt_time_ns;
                revision = value.revision;
                relationship = switch (value.relationship) {
                    case null null;
                    case (?head) ?memoryFollowerHeadToPublic(head);
                };
            };
        };

        func publicRejectionToMemory(
            value : WagyuRejectionReasonV1
        ) : Memory.RouteRejectionReason {
            switch (value) {
                case (#invalid) #invalid;
                case (#blocked) #blocked;
                case (#not_following) #not_following;
                case (#unknown_post) #unknown_post;
                case (#expired) #expired;
                case (#full) #full;
                case (#conflict) #conflict;
                case (#incompatible) #incompatible;
            };
        };

        func memoryRejectionToPublic(
            value : Memory.RouteRejectionReason
        ) : WagyuRejectionReasonV1 {
            switch (value) {
                case (#invalid) #invalid;
                case (#blocked) #blocked;
                case (#not_following) #not_following;
                case (#unknown_post) #unknown_post;
                case (#expired) #expired;
                case (#full) #full;
                case (#conflict) #conflict;
                case (#incompatible) #incompatible;
            };
        };

        func publicFollowerHeadToMemory(
            value : FollowerHeadV1
        ) : Memory.FollowerHeadV1 {
            {
                revision = value.revision;
                state = switch (value.state) {
                    case null null;
                    case (?#active(active)) {
                        ?#active({
                            subscription_id = active.subscription_id;
                            lease_expires_ns = active.lease_expires_ns;
                            delivery_credits = active.delivery_credits;
                        });
                    };
                    case (?#inactive(inactive)) {
                        ?#inactive({
                            last_subscription_id =
                                inactive.last_subscription_id;
                        });
                    };
                };
            };
        };

        func memoryFollowerHeadToPublic(
            value : Memory.FollowerHeadV1
        ) : FollowerHeadV1 {
            {
                revision = value.revision;
                state = switch (value.state) {
                    case null null;
                    case (?#active(active)) {
                        ?#active({
                            subscription_id = active.subscription_id;
                            lease_expires_ns = active.lease_expires_ns;
                            delivery_credits = active.delivery_credits;
                        });
                    };
                    case (?#inactive(inactive)) {
                        ?#inactive({
                            last_subscription_id =
                                inactive.last_subscription_id;
                        });
                    };
                };
            };
        };

        func ingressReceiptKey(
            caller : Principal,
            route : Memory.IngressRoute,
            operationId : Blob,
        ) : Text {
            Principal.toText(caller) # ":" # routeText(route) # ":" #
            Path.hexLower(operationId);
        };

        func routeText(value : Memory.IngressRoute) : Text {
            switch (value) {
                case (#follow) "follow";
                case (#unfollow) "unfollow";
                case (#deliver) "deliver";
                case (#like) "like";
                case (#notice) "notice";
            };
        };

        func authoredPostState(value : Memory.AuthoredPost) : Text {
            switch (value.status) {
                case (#awaiting_proof) "awaiting_proof";
                case (#live) "live";
                case (#withdrawal_awaiting_proof(_)) {
                    "withdrawal_awaiting_proof";
                };
                case (#withdrawal_closing(_)) "withdrawal_closing";
                case (#withdrawn(_)) "withdrawn";
            };
        };

        func authoredActionKind(
            value : Memory.AuthoredActionKind
        ) : ActionKindV1 {
            switch (value) {
                case (#share(_)) #share;
                case (#like(_)) #like;
                case (#tombstone(_)) #tombstone;
            };
        };

        func authoredActionTargetPostId(
            value : Memory.AuthoredActionKind
        ) : Text {
            Path.hexLower(
                switch (value) {
                    case (#share(info)) info.action.original_post_id;
                    case (#like(info)) info.action.post_id;
                    case (#tombstone(info)) info.action.post_id;
                }
            );
        };

        func authoredActionState(
            value : Memory.AuthoredAction
        ) : Text {
            switch (value.object_state) {
                case (#awaiting_publication(_)) "awaiting_publication";
                case (#awaiting_proof(_)) "awaiting_proof";
                case (#certified(_)) "certified";
                case (#reconciling(_)) "uncertain";
                case (#failed(_)) "failed";
            };
        };

        func publishResultForPost(
            value : Memory.AuthoredPost
        ) : PublishResultV1 {
            let stage : PublishStageV1 = switch (value.object_state) {
                case (#awaiting_publication(_) or #awaiting_proof(_)) {
                    #awaiting_proof;
                };
                case (#certified(_)) {
                    switch (value.status) {
                        case (#live) #complete;
                        case (_) #certified_ref_ready;
                    };
                };
                case (#reconciling(_)) #uncertain;
                case (#failed(_)) #failed;
            };
            {
                stage = ?stage;
                post_id = ?value.post_id;
                action_id = ?value.post_id;
                object_digest = ?value.object_digest;
                queued_recipient_count = 0;
                queued_notice_count = 0;
                accepted_recipient_count = 0;
                failed_recipient_count = 0;
                message = "This exact owner action already exists.";
            };
        };

        func publishResultForAction(
            value : Memory.AuthoredAction
        ) : PublishResultV1 {
            let stage : PublishStageV1 = switch (value.object_state) {
                case (#awaiting_publication(_) or #awaiting_proof(_)) {
                    #awaiting_proof;
                };
                case (#certified(_)) #certified_ref_ready;
                case (#reconciling(_)) #uncertain;
                case (#failed(_)) #failed;
            };
            let postId = switch (value.kind) {
                case (#share(info)) ?info.action.original_post_id;
                case (#like(info)) ?info.action.post_id;
                case (#tombstone(info)) ?info.action.post_id;
            };
            {
                stage = ?stage;
                post_id = postId;
                action_id = ?value.action_id;
                object_digest = ?value.object_digest;
                queued_recipient_count = 0;
                queued_notice_count = 0;
                accepted_recipient_count = 0;
                failed_recipient_count = 0;
                message = "This exact owner action already exists.";
            };
        };

        func publicReplyToProtocol(
            value : ReplyLocatorV1
        ) : Protocol.ReplyToV1 {
            {
                author = value.author;
                post_id = value.post_id;
                body_hash = value.body_hash;
                body_length = value.body_length;
                object_digest = value.object_digest;
            };
        };

        func protocolPostToMemory(
            value : Protocol.PostBodyV1
        ) : Memory.PostBodyV1 {
            {
                header = protocolHeaderToMemory(value.header);
                author_sequence = value.author_sequence;
                nonce = value.nonce;
                created_at_ns = value.created_at_ns;
                body_markdown = value.body_markdown;
                reply_to = switch (value.reply_to) {
                    case null null;
                    case (?reply) {
                        ?{
                            author = reply.author;
                            post_id = reply.post_id;
                            body_hash = reply.body_hash;
                            body_length = reply.body_length;
                            object_digest = reply.object_digest;
                        };
                    };
                };
            };
        };

        func protocolHeaderToMemory(
            value : Protocol.ActionHeaderV1
        ) : Memory.ActionHeaderV1 {
            {
                network_id = value.network_id;
                actor_ = value.actor_;
                action_kind = switch (value.action_kind) {
                    case null null;
                    case (?#post) ?#post;
                    case (?#share) ?#share;
                    case (?#tombstone) ?#tombstone;
                    case (?#like) ?#like;
                };
            };
        };

        func protocolShareToMemory(
            value : Protocol.ShareActionV1
        ) : Memory.ShareActionV1 {
            {
                header = protocolHeaderToMemory(value.header);
                share_id = value.share_id;
                share_sequence = value.share_sequence;
                issued_at_ns = value.issued_at_ns;
                original_author = value.original_author;
                original_post_id = value.original_post_id;
                original_body_hash = value.original_body_hash;
                post_ref_digest = value.post_ref_digest;
            };
        };

        func protocolLikeToMemory(
            value : Protocol.LikeActionV1
        ) : Memory.LikeActionV1 {
            {
                header = protocolHeaderToMemory(value.header);
                like_id = value.like_id;
                issued_at_ns = value.issued_at_ns;
                post_author = value.post_author;
                post_id = value.post_id;
                post_body_hash = value.post_body_hash;
            };
        };

        func protocolTombstoneToMemory(
            value : Protocol.TombstoneActionV1
        ) : Memory.TombstoneActionV1 {
            {
                header = protocolHeaderToMemory(value.header);
                tombstone_id = value.tombstone_id;
                author_sequence = value.author_sequence;
                issued_at_ns = value.issued_at_ns;
                post_id = value.post_id;
                post_body_hash = value.post_body_hash;
            };
        };

        func protocolLikeHeadToMemory(
            value : Protocol.LikeHeadV1
        ) : Memory.LikeHeadV1 {
            {
                network_id = value.network_id;
                post_author = value.post_author;
                post_id = value.post_id;
                post_body_hash = value.post_body_hash;
                store_generation = value.store_generation;
                revision = value.revision;
                previous_head_hash = value.previous_head_hash;
                latest_batch_number = value.latest_batch_number;
                latest_batch_digest = value.latest_batch_digest;
                sealed_batch_count = value.sealed_batch_count;
                sealed_receipt_count = value.sealed_receipt_count;
                accepting_likes = value.accepting_likes;
            };
        };

        func memoryReplyIndexEntryToProtocol(
            value : Memory.ReplyIndexEntryV1
        ) : Protocol.ReplyIndexEntryV1 {
            {
                author = value.author;
                post_id = value.post_id;
                object_digest = value.object_digest;
                object_length = value.object_length;
                received_at_ns = value.received_at_ns;
            };
        };

        func protocolReplyIndexToMemory(
            value : Protocol.ReplyIndexV1
        ) : Memory.ReplyIndexV1 {
            {
                network_id = value.network_id;
                post_author = value.post_author;
                post_id = value.post_id;
                post_body_hash = value.post_body_hash;
                store_generation = value.store_generation;
                revision = value.revision;
                previous_index_hash = value.previous_index_hash;
                replies = Array.map<
                    Protocol.ReplyIndexEntryV1,
                    Memory.ReplyIndexEntryV1
                >(value.replies, func(reply) {
                    {
                        author = reply.author;
                        post_id = reply.post_id;
                        object_digest = reply.object_digest;
                        object_length = reply.object_length;
                        received_at_ns = reply.received_at_ns;
                    };
                });
            };
        };

        func memoryKernelIdentityToStored(
            value : Memory.KernelRecordIdentity
        ) : Publication.StoredIdentity {
            {
                target = memoryTargetToCapability(value.target);
                kernel_revision = value.kernel_revision;
                content_tag = value.content_tag;
                body_bytes = Nat32.toNat(value.body_length);
            };
        };

        func memoryLikeHeadToProtocol(
            value : Memory.LikeHeadV1
        ) : Protocol.LikeHeadV1 {
            {
                network_id = value.network_id;
                post_author = value.post_author;
                post_id = value.post_id;
                post_body_hash = value.post_body_hash;
                store_generation = value.store_generation;
                revision = value.revision;
                previous_head_hash = value.previous_head_hash;
                latest_batch_number = value.latest_batch_number;
                latest_batch_digest = value.latest_batch_digest;
                sealed_batch_count = value.sealed_batch_count;
                sealed_receipt_count = value.sealed_receipt_count;
                accepting_likes = value.accepting_likes;
            };
        };

        func memoryLikeHeadState(
            value : Memory.LikeHeadState
        ) : LikeSealing.HeadState {
            {
                value = memoryLikeHeadToProtocol(value.value);
                exact_body_candid = value.exact_body_candid;
                kernel_identity = {
                    target = memoryTargetToCapability(
                        value.kernel_identity.target
                    );
                    kernel_revision =
                        value.kernel_identity.kernel_revision;
                    content_tag =
                        value.kernel_identity.content_tag;
                    body_bytes = Nat32.toNat(
                        value.kernel_identity.body_length
                    );
                };
            };
        };

        func protocolLikeBatchToMemory(
            value : Protocol.LikeBatchV1
        ) : Memory.LikeBatchV1 {
            {
                network_id = value.network_id;
                post_author = value.post_author;
                post_id = value.post_id;
                post_body_hash = value.post_body_hash;
                batch_number = value.batch_number;
                previous_batch_digest =
                    value.previous_batch_digest;
                first_accepted_sequence =
                    value.first_accepted_sequence;
                last_accepted_sequence =
                    value.last_accepted_sequence;
                final_partial = value.final_partial;
                receipts = Array.map<
                    Protocol.CertifiedLikeReceiptV1,
                    Memory.CertifiedLikeReceiptV1
                >(value.receipts, func(receipt) {
                    {
                        like_action_candid =
                            receipt.like_action_candid;
                        ref = protocolActionRefToMemory(
                            receipt.ref
                        );
                    };
                });
            };
        };

        func publicProofToProtocol(
            value : CertifiedHttpProofV1
        ) : Protocol.CertifiedHttpProofV1 {
            {
                certificate_version = value.certificate_version;
                certificate_cbor = value.certificate_cbor;
                witness_cbor = value.witness_cbor;
                expression_path_cbor = value.expression_path_cbor;
                certificate_time_ns = value.certificate_time_ns;
            };
        };

        func protocolProofToMemory(
            value : Protocol.CertifiedHttpProofV1
        ) : Memory.CertifiedHttpProofV1 {
            {
                certificate_version = value.certificate_version;
                certificate_cbor = value.certificate_cbor;
                witness_cbor = value.witness_cbor;
                expression_path_cbor = value.expression_path_cbor;
                certificate_time_ns = value.certificate_time_ns;
            };
        };

        func memoryProofToProtocol(
            value : Memory.CertifiedHttpProofV1
        ) : Protocol.CertifiedHttpProofV1 {
            {
                certificate_version = value.certificate_version;
                certificate_cbor = value.certificate_cbor;
                witness_cbor = value.witness_cbor;
                expression_path_cbor = value.expression_path_cbor;
                certificate_time_ns = value.certificate_time_ns;
            };
        };

        func memoryPostRefToProtocol(
            value : Memory.CertifiedPostRefV1
        ) : Protocol.CertifiedPostRefV1 {
            {
                author = value.author;
                post_id = value.post_id;
                body_hash = value.body_hash;
                body_length = value.body_length;
                object_digest = value.object_digest;
                proof = memoryProofToProtocol(value.proof);
            };
        };

        func protocolPostRefToMemory(
            value : Protocol.CertifiedPostRefV1
        ) : Memory.CertifiedPostRefV1 {
            {
                author = value.author;
                post_id = value.post_id;
                body_hash = value.body_hash;
                body_length = value.body_length;
                object_digest = value.object_digest;
                proof = protocolProofToMemory(value.proof);
            };
        };

        func protocolShareRefToMemory(
            value : Protocol.CertifiedShareRefV1
        ) : Memory.CertifiedShareRefV1 {
            {
                sharer = value.sharer;
                share_id = value.share_id;
                body_length = value.body_length;
                object_digest = value.object_digest;
                proof = protocolProofToMemory(value.proof);
            };
        };

        func protocolActionRefToMemory(
            value : Protocol.CertifiedActionRefV1
        ) : Memory.CertifiedActionRefV1 {
            {
                actor_ = value.actor_;
                action_kind = switch (value.action_kind) {
                    case null null;
                    case (?#post) ?#post;
                    case (?#share) ?#share;
                    case (?#tombstone) ?#tombstone;
                    case (?#like) ?#like;
                };
                object_digest = value.object_digest;
                body_length = value.body_length;
                proof_snapshot = protocolProofToMemory(value.proof_snapshot);
            };
        };

        func requestedPostBodyHash(
            request : LikePublishRequestV1
        ) : ?Blob {
            switch (request.post_body_hash, request.body_digest) {
                case (?left, ?right) {
                    if (
                        left.size() == Bounds.HASH_BYTES and
                        right.size() == Bounds.HASH_BYTES
                    ) ?left else null;
                };
                case (?value, null) {
                    if (value.size() == Bounds.HASH_BYTES) ?value else null;
                };
                case (null, ?value) {
                    if (value.size() == Bounds.HASH_BYTES) ?value else null;
                };
                case (null, null) null;
            };
        };

        func postStableKey(postId : Blob) : Text {
            "post:" # Path.hexLower(postId);
        };

        func authoredPostNonceStableKey(nonce : Blob) : Text {
            "post-nonce:" # Path.hexLower(nonce);
        };

        func likeHeadStableKey(postId : Blob) : Text {
            "like-head:" # Path.hexLower(postId);
        };

        func replyIndexStableKey(postId : Blob) : Text {
            "reply-index:" # Path.hexLower(postId);
        };

        func actionStableKey(kind : ActionKindV1, actionId : Blob) : Text {
            "action:" # publicActionKindText(kind) # ":" #
            Path.hexLower(actionId);
        };

        func originalPostStableKey(
            author : Principal,
            postId : Blob,
        ) : Text {
            "original:" # Principal.toText(author) # ":" #
            Path.hexLower(postId);
        };

        func certifiedRecordStableKey(
            target : Memory.CertifiedTarget
        ) : Text {
            let key = switch (target.key) {
                case (#digest(value)) "digest:" # Path.hexLower(value);
                case (#post_id(value)) "post-id:" # Path.hexLower(value);
                case (#profile) "profile";
            };
            collectionText(target.collection) # ":" #
            Nat.toText(Nat64.toNat(target.collection_generation)) # ":" # key;
        };

        func publicActionKindText(value : ActionKindV1) : Text {
            switch (value) {
                case (#post) "post";
                case (#share) "share";
                case (#tombstone) "tombstone";
                case (#like) "like";
            };
        };

        func first16(value : Blob) : Blob {
            if (value.size() < Bounds.NONCE_BYTES) {
                Runtime.trap("Wagyu digest is too short for nonce derivation");
            };
            let bytes = Blob.toArray(value);
            Blob.fromArray(Array.tabulate<Nat8>(
                Bounds.NONCE_BYTES,
                func(index) { bytes[index] },
            ));
        };

        func derivedNonce(
            domain : Text,
            first : Blob,
            second : Blob,
        ) : Blob {
            let digest = switch (Hash.lpHash(domain, [first, second])) {
                case (?value) value;
                case null Runtime.trap("Wagyu nonce derivation failed");
            };
            let bytes = Blob.toArray(digest);
            Blob.fromArray(Array.tabulate<Nat8>(16, func(index) {
                bytes[index];
            }));
        };

        func nextPublicationId() : Nat64 {
            mem.publication_sequence := nextRevision(
                mem.publication_sequence
            );
            mem.publication_sequence;
        };

        func bumpState() {
            mem.state_revision := nextRevision(mem.state_revision);
        };

        func nextRevision(value : Nat64) : Nat64 {
            if (value == Nat64.maxValue) {
                Runtime.trap("Wagyu revision space is exhausted");
            };
            value + 1;
        };

        func nowNs() : Nat64 {
            Nat64.fromNat(Int.abs(Time.now()));
        };

        func addSaturating(left : Nat64, right : Nat64) : Nat64 {
            if (Nat64.maxValue - left < right) Nat64.maxValue
            else left + right;
        };

        func validRemoteNode(value : Principal) : Bool {
            Principal.isCanister(value) and not Principal.equal(value, node);
        };

        func isZero(value : Blob) : Bool {
            if (value.size() != Bounds.HASH_BYTES) return false;
            for (byte in value.vals()) {
                if (byte != 0) return false;
            };
            true;
        };

        func boundedNat32(value : Nat) : Nat32 {
            if (value > 4_294_967_295) Nat32.maxValue
            else Nat32.fromNat(value);
        };

        func belowCursor(value : Nat64, before : ?Nat64) : Bool {
            switch (before) {
                case null true;
                case (?cursor) value < cursor;
            };
        };

        if (
            trustedNetworkId.size() != Bounds.HASH_BYTES or
            isZero(trustedNetworkId)
        ) {
            Runtime.trap(
                "Wagyu requires a trusted 32-byte nonzero installation network ID"
            );
        };
        assertTrustedInstallation();
    };
/*---NEUTRON GENERATED BEGIN---*/

public type wagyu_status_Input = (_request : EmptyRequestV1);
public type wagyu_status_Output = WagyuStatusV1;

public type wagyu_profile_Input = (_request : EmptyRequestV1);
public type wagyu_profile_Output = ProfileViewV1;

public type wagyu_get_feed_page_v1_Input = (request : FeedPageRequestV1);
public type wagyu_get_feed_page_v1_Output = FeedPageV1;

public type wagyu_get_notification_page_v1_Input = (request : NotificationPageRequestV1);
public type wagyu_get_notification_page_v1_Output = NotificationPageV1;

public type wagyu_get_notification_evidence_v1_Input = (request : NotificationEvidenceRequestV1);
public type wagyu_get_notification_evidence_v1_Output = NotificationEvidenceV1;

public type wagyu_get_send_quote_v1_Input = (request : SendQuoteRequestV1);
public type wagyu_get_send_quote_v1_Output = SendQuoteV1;

public type wagyu_profile_edit_v1_Input = (request : ProfileEditRequestV1);
public type wagyu_profile_edit_v1_Output = ProfileEditResultV1;

public type wagyu_relationships_Input = (request : RelationshipPageRequestV1);
public type wagyu_relationships_Output = RelationshipsV1;

public type wagyu_follow_Input = (request : FollowRequestV1);
public type wagyu_follow_Output = RelationshipSummaryLocalResultV1;

public type wagyu_unfollow_Input = (request : NodeRequestV1);
public type wagyu_unfollow_Output = RelationshipSummaryLocalResultV1;

public type wagyu_block_Input = (request : NodeRequestV1);
public type wagyu_block_Output = RelationshipSummaryLocalResultV1;

public type wagyu_unblock_Input = (request : NodeRequestV1);
public type wagyu_unblock_Output = RelationshipSummaryLocalResultV1;

public type wagyu_post_publish_Input = (request : PostPublishRequestV1);
public type wagyu_post_publish_Output = PublishLocalResultV1;

public type wagyu_share_publish_Input = (request : SharePublishRequestV1);
public type wagyu_share_publish_Output = PublishLocalResultV1;

public type wagyu_like_publish_Input = (request : LikePublishRequestV1);
public type wagyu_like_publish_Output = PublishLocalResultV1;

public type wagyu_action_finalize_Input = (request : ActionFinalizeRequestV1);
public type wagyu_action_finalize_Output = PublishLocalResultV1;

public type wagyu_post_delete_Input = (request : PostDeleteRequestV1);
public type wagyu_post_delete_Output = PublishLocalResultV1;

public type wagyu_like_seal_Input = (request : LikeSealRequestV1);
public type wagyu_like_seal_Output = PublishLocalResultV1;

public type wagyu_withdrawal_advance_Input = (request : PostDeleteRequestV1);
public type wagyu_withdrawal_advance_Output = PublishLocalResultV1;

public type wagyu_feed_promote_Input = (request : FeedPromoteRequestV1);
public type wagyu_feed_promote_Output = Nat64LocalResultV1;

public type wagyu_feed_reject_Input = (request : FeedRejectRequestV1);
public type wagyu_feed_reject_Output = Nat64LocalResultV1;

public type wagyu_notification_promote_Input = (request : NotificationPromoteRequestV1);
public type wagyu_notification_promote_Output = Nat64LocalResultV1;

public type wagyu_notifications_mark_read_Input = (request : NotificationsMarkReadRequestV1);
public type wagyu_notifications_mark_read_Output = Nat64LocalResultV1;

public type wagyu_authored_page_Input = (request : AuthoredPageRequestV1);
public type wagyu_authored_page_Output = AuthoredPageV1;

public type wagyu_outbox_page_Input = (request : OutboxPageRequestV1);
public type wagyu_outbox_page_Output = OutboxPageV1;

public type wagyu_outbox_drain_Input = (request : OutboxDrainRequestV1);
public type wagyu_outbox_drain_Output = OutboxDrainResultV1;

public type wagyu_outbox_retry_Input = (request : OutboxRetryRequestV1);
public type wagyu_outbox_retry_Output = OutboxDrainResultV1;

public type wagyu_outbox_tick_Input = (_request : ());
public type wagyu_outbox_tick_Output = ();

public type wagyu_ingress_follow_v1_Input = (request : WagyuIngressV1);
public type wagyu_ingress_follow_v1_Output = WagyuRouteResultV1;

public type wagyu_ingress_unfollow_v1_Input = (request : WagyuIngressV1);
public type wagyu_ingress_unfollow_v1_Output = UnfollowRouteResultV1;

public type wagyu_ingress_deliver_v1_Input = (request : WagyuIngressV1);
public type wagyu_ingress_deliver_v1_Output = WagyuRouteResultV1;

public type wagyu_ingress_like_v1_Input = (request : WagyuIngressV1);
public type wagyu_ingress_like_v1_Output = WagyuRouteResultV1;

public type wagyu_ingress_notice_v1_Input = (request : WagyuIngressV1);
public type wagyu_ingress_notice_v1_Output = WagyuRouteResultV1;

public type wagyu_feed_page_self_v1_Input = (request : FeedPageSelfRequestV1);
public type wagyu_feed_page_self_v1_Output = FeedPageSelfOutputV1;

public type wagyu_notification_page_self_v1_Input = (request : NotificationPageSelfRequestV1);
public type wagyu_notification_page_self_v1_Output = NotificationPageSelfOutputV1;

public type wagyu_notification_evidence_self_v1_Input = (request : NotificationEvidenceSelfRequestV1);
public type wagyu_notification_evidence_self_v1_Output = NotificationEvidenceSelfOutputV1;

public type wagyu_block_statuses_self_v1_Input = (request : BlockStatusesSelfRequestV1);
public type wagyu_block_statuses_self_v1_Output = BlockStatusesSelfOutputV1;

public type wagyu_follow_self_v1_Input = (request : FollowSelfRequestV1);
public type wagyu_follow_self_v1_Output = RelationshipSummaryLocalResultV1;

public type wagyu_auto_renew_self_v1_Input = (request : NodeRequestV1);
public type wagyu_auto_renew_self_v1_Output = RelationshipSummaryLocalResultV1;

public type wagyu_post_prepare_self_v1_Input = (request : PostPrepareSelfRequestV1);
public type wagyu_post_prepare_self_v1_Output = PublishSelfLocalResultV1;

public type wagyu_share_prepare_self_v1_Input = (request : SharePrepareSelfRequestV1);
public type wagyu_share_prepare_self_v1_Output = PublishSelfLocalResultV1;

public type wagyu_like_prepare_self_v1_Input = (request : LikePrepareSelfRequestV1);
public type wagyu_like_prepare_self_v1_Output = PublishSelfLocalResultV1;

public type wagyu_tombstone_prepare_self_v1_Input = (request : TombstonePrepareSelfRequestV1);
public type wagyu_tombstone_prepare_self_v1_Output = PublishSelfLocalResultV1;

public type wagyu_post_finalize_self_v1_Input = (request : FinalizeSelfRequestV1);
public type wagyu_post_finalize_self_v1_Output = PublishSelfLocalResultV1;

public type wagyu_share_finalize_self_v1_Input = (request : FinalizeSelfRequestV1);
public type wagyu_share_finalize_self_v1_Output = PublishSelfLocalResultV1;

public type wagyu_like_finalize_self_v1_Input = (request : FinalizeSelfRequestV1);
public type wagyu_like_finalize_self_v1_Output = PublishSelfLocalResultV1;

public type wagyu_tombstone_finalize_self_v1_Input = (request : FinalizeSelfRequestV1);
public type wagyu_tombstone_finalize_self_v1_Output = PublishSelfLocalResultV1;

public type wagyu_feed_promote_self_v1_Input = (request : FeedPromoteSelfRequestV1);
public type wagyu_feed_promote_self_v1_Output = Nat64LocalResultV1;

public type wagyu_feed_reject_self_v1_Input = (request : FeedRejectSelfRequestV1);
public type wagyu_feed_reject_self_v1_Output = Nat64LocalResultV1;

public type wagyu_notification_promote_self_v1_Input = (request : NotificationPromoteSelfRequestV1);
public type wagyu_notification_promote_self_v1_Output = Nat64LocalResultV1;

public type wagyu_like_seal_self_v1_Input = (request : LikeSealSelfRequestV1);
public type wagyu_like_seal_self_v1_Output = PublishSelfLocalResultV1;

public type wagyu_withdrawal_advance_self_v1_Input = (request : WithdrawalAdvanceSelfRequestV1);
public type wagyu_withdrawal_advance_self_v1_Output = PublishSelfLocalResultV1;

/*---NEUTRON GENERATED END---*/
};
