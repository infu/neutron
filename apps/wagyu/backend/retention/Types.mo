import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";

import Memory "../memory/wagyu/v3";

module {
    public type IndexKey = Memory.RetentionIndexKey;
    public type RecordRef = Memory.RetentionRecordRef;
    public type OrderedTimeKey = Memory.OrderedTimeKey;
    public type StableKey = Memory.StableKey;

    public type Policy = {
        peer_records_ns : Nat64;
        likes_ns : Nat64;
        rate_window_ns : Nat64;
    };

    public type Entry = {
        key : IndexKey;
        record : RecordRef;
    };

    // Every view contains the exact information an adapter needs to remove
    // its primary row, all secondary indexes, and its managed-memory charge.
    // The cleanup service derives counter deltas from these fields; callers
    // cannot supply an arbitrary decrement.
    public type RecordView = {
        #follower : {
            node : Principal;
            // Receiver-clock time of the last funded follow/renewal. Local
            // pause/credit bookkeeping is not allowed to move this anchor.
            funded_at_ns : Nat64;
            retain_until_ns : Nat64;
            retained_bytes : Nat;
            registration_sequence : Nat64;
            active : Bool;
            charges_detached : Bool;
        };
        #authored_post : {
            post_key : Text;
            created_at_ns : Nat64;
            retain_until_ns : Nat64;
            retained_bytes : Nat;
            author_sequence : Nat64;
            dependents_detached : Bool;
        };
        #authored_action : {
            action_key : Text;
            created_at_ns : Nat64;
            retain_until_ns : Nat64;
            retained_bytes : Nat;
            sequence : Nat64;
            certified_record_detached : Bool;
            kind : {
                #share : {
                    original_author : Principal;
                    original_post_id : Blob;
                };
                #like : {
                    post_author : Principal;
                    post_id : Blob;
                };
                #tombstone : {
                    post_id : Blob;
                };
            };
        };
        #feed_candidate : {
            candidate_key : Text;
            received_at_ns : Nat64;
            retain_until_ns : Nat64;
            retained_bytes : Nat;
            local_sequence : Nat64;
            immediate_sender : Principal;
            unread : Bool;
            dependents_detached : Bool;
        };
        #verified_feed : {
            feed_key : Text;
            created_at_ns : Nat64;
            retain_until_ns : Nat64;
            retained_bytes : Nat;
            dependents_detached : Bool;
        };
        #share_attribution : {
            attribution_key : Text;
            verified_at_ns : Nat64;
            retain_until_ns : Nat64;
            retained_bytes : Nat;
            feed_key : Text;
            candidate_key : Text;
        };
        #suppression : {
            suppression_key : Text;
            suppressed_at_ns : Nat64;
            retain_until_ns : Nat64;
            retained_bytes : Nat;
            source_candidate_key : ?Text;
        };
        #tombstone_relay : {
            relay_key : Text;
            created_at_ns : Nat64;
            retain_until_ns : Nat64;
            retained_bytes : Nat;
            fanout_job_id : Nat64;
            fanout_detached : Bool;
        };
        #notification : {
            local_sequence : Nat64;
            received_at_ns : Nat64;
            retain_until_ns : Nat64;
            retained_bytes : Nat;
            semantic_key : Text;
            actor_ : Principal;
            unread : Bool;
            has_evidence : Bool;
            notice_target_key : ?Text;
            notice_semantic_detached : Bool;
        };
        #notice_semantic : {
            semantic_key : Text;
            // NoticeSemanticReceipt does not persist its receipt time in V1;
            // the adapter must join the referenced notification and provide
            // its receiver-clock time before this row is indexable.
            received_at_ns : Nat64;
            retain_until_ns : Nat64;
            // V1 has no standalone global byte counter for this map. The
            // adapter must nevertheless provide the exact charged amount used
            // by NoticePressure so that its secondary accounting is removed.
            accounted_bytes : ?Nat;
            notification_sequence : Nat64;
            actor_ : Principal;
            target_post_key : Text;
        };
        #accepted_like : {
            accepted_like_key : Text;
            accepted_sequence : Nat64;
            accepted_at_ns : Nat64;
            retain_until_ns : Nat64;
            // When present, this is the local original post's completed
            // withdrawal time. Cleanup may occur at the earlier of this time
            // and the funded five-year horizon.
            withdrawn_at_ns : ?Nat64;
            retained_bytes : Nat;
            post_key : Text;
            notification_sequence : Nat64;
            segment : ?{
                segment_number : Nat64;
                lane : { #active; #due };
            };
        };
        #sealed_like_batch : {
            batch_key : Text;
            sealed_at_ns : Nat64;
            retain_until_ns : Nat64;
            withdrawn_at_ns : ?Nat64;
            // The V1 row has no app-local retained_bytes field. The adapter
            // must join its certified record/accounting before deletion.
            accounted_bytes : ?Nat;
            post_key : Text;
            batch_number : Nat64;
            certified_record_detached : Bool;
        };
        #ingress_receipt : {
            receipt_key : Text;
            route : Memory.IngressRoute;
            received_at_ns : Nat64;
            retain_until_ns : Nat64;
            retained_bytes : Nat;
            domain_dependency_detached : Bool;
        };
        #caller_rate_window : {
            window_key : Text;
            window_started_at_ns : Nat64;
            expires_at_ns : Nat64;
            retained_bytes : Nat;
        };
        #outbox : {
            local_id : Nat64;
            created_at_ns : Nat64;
            retry_expires_at_ns : Nat64;
            // Normally the retry horizon. A fully reconciled terminal row
            // may instead be reindexed to its shorter cleanup deadline
            // without changing the frozen V2 primary-row shape.
            cleanup_at_ns : Nat64;
            retained_bytes : Nat;
            operation_key : Memory.OutboxOperationKey;
            retry_index_key : ?OrderedTimeKey;
            pending_credit_charge : ?Memory.CreditCharge;
            links_detached : Bool;
        };
        #fanout_job : {
            fanout_job_id : Nat64;
            created_at_ns : Nat64;
            expires_at_ns : Nat64;
            cleanup_at_ns : Nat64;
            retained_bytes : Nat;
            targets_detached : Bool;
        };
        #fanout_target : {
            target_key : Text;
            fanout_job_id : Nat64;
            outbox_local_id : Nat64;
            // FanoutTarget persists only its expiry in V1. The adapter must
            // join the owning job's receiver-clock creation time.
            created_at_ns : Nat64;
            expires_at_ns : Nat64;
            cleanup_at_ns : Nat64;
            retained_bytes : Nat;
            outbox_detached : Bool;
        };
    };

    public type CounterDelta = {
        follower_head_count : Nat;
        follower_head_bytes : Nat;
        active_follower_count : Nat;
        authored_post_count : Nat;
        authored_action_count : Nat;
        authored_bytes : Nat;
        candidate_count : Nat;
        candidate_bytes : Nat;
        unread_feed_count : Nat;
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
        unread_notification_count : Nat;
        accepted_like_count : Nat;
        accepted_like_bytes : Nat;
        ingress_receipt_count : Nat;
        ingress_receipt_bytes : Nat;
        caller_rate_window_count : Nat;
        caller_rate_window_bytes : Nat;
        outbox_count : Nat;
        outbox_bytes : Nat;
        fanout_job_count : Nat;
        fanout_target_count : Nat;
        fanout_bytes : Nat;
    };

    public type RegistrationRequest = {
        view : RecordView;
        expected_previous : ?Entry;
    };

    public type RegistrationChange = {
        current_key : StableKey;
        record : RecordRef;
        expected_previous : ?Entry;
        replacement : Entry;
    };

    public type RegistrationPlan = {
        expected_sequence : Nat64;
        next_sequence : Nat64;
        changes : [RegistrationChange];
    };

    public type RegistrationError = {
        #invalid_record;
        #invalid_horizon;
        #sequence_exhausted;
        #state_conflict;
    };

    public type RegistrationResult = {
        #ok : RegistrationPlan;
        #err : RegistrationError;
    };

    public type HoldReason = {
        #missing_accounting;
        #missing_cascade;
        #protected_dependency;
        #not_due;
        #adapter_refused;
    };

    public type Inspection = {
        #record : RecordView;
        // A dangling expiry entry can be removed without changing counters.
        #missing;
        // The primary row and its expiry entry remain untouched.
        #held : HoldReason;
    };

    public type IndexOnlyReason = {
        #missing_record;
        // The row was renewed/rescheduled and this is its stale old key.
        #superseded;
    };

    public type CleanupMutation = {
        #delete_record : {
            entry : Entry;
            expected : RecordView;
            decrement : CounterDelta;
        };
        #delete_index_only : {
            entry : Entry;
            reason : IndexOnlyReason;
        };
        // The row is retained, while its due index is moved forward so one
        // incomplete/protected row cannot starve every later expiry page.
        #defer : {
            entry : Entry;
            replacement : Entry;
            reason : HoldReason;
        };
    };

    public type HeldEntry = {
        entry : Entry;
        reason : HoldReason;
    };

    public type ExpiredPage = {
        entries : [Entry];
        // True means no expired entry exists after the returned page.
        complete : Bool;
    };

    public type CleanupRequest = {
        now_ns : Nat64;
        after : ?IndexKey;
        limit : Nat;
    };

    public type CleanupPlan = {
        expected_cleanup_epoch : Nat64;
        next_cleanup_epoch : Nat64;
        expected_retention_sequence : Nat64;
        next_retention_sequence : Nat64;
        now_ns : Nat64;
        mutations : [CleanupMutation];
        held : [HeldEntry];
        scanned : Nat;
        next_after : ?IndexKey;
        complete : Bool;
    };

    public type CleanupError = {
        #invalid_request;
        #invalid_policy;
        #corrupt_index;
        #corrupt_record;
        #cleanup_epoch_exhausted;
        #retention_sequence_exhausted;
        #state_conflict;
        #nothing_to_commit;
    };

    public type CleanupPlanResult = {
        #ok : CleanupPlan;
        #err : CleanupError;
    };

    public type CleanupCommitResult = {
        #ok : {
            deleted_records : Nat;
            deleted_indexes : Nat;
            deferred_records : Nat;
            held_records : Nat;
            next_after : ?IndexKey;
            complete : Bool;
        };
        #err : CleanupError;
    };

    // The page callback must read only retention_order, the sole expiry
    // index. inspect may join primary/secondary maps but must not mutate.
    //
    // `current` resolves memory.retention_current and then requires the
    // referenced retention_order row to contain the same RecordRef.
    //
    // commit_cleanup is a no-await atomic boundary. It rechecks the global
    // sequence, cleanup epoch, reverse pointer, primary row, every cascade,
    // and counter underflow before changing anything. A false result means
    // that no sequence, epoch, row, index, or counter was changed.
    public type State = {
        policy : () -> Policy;
        retention_sequence : () -> Nat64;
        cleanup_epoch : () -> Nat64;
        current : RecordRef -> ?Entry;
        page_expired : (?IndexKey, Nat64, Nat) -> ExpiredPage;
        inspect : Entry -> Inspection;
        commit_cleanup : CleanupPlan -> Bool;
    };
};
