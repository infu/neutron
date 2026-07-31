module {
    public type DeliveryPause = {
        #blocked;
        #not_following;
        #incompatible;
    };

    public type ActiveFollower = {
        subscription_id : Blob;
        lease_expires_ns : Nat64;
        delivery_credits : Nat16;
    };

    public type FollowerState = {
        #active : ActiveFollower;
        #inactive : {
            last_subscription_id : Blob;
        };
    };

    // `head_revision` is the peer-visible Follow/Unfollow CAS revision.
    // `storage_revision` also changes for local credit and pause bookkeeping.
    // Keeping those revisions separate prevents a delivery attempt from
    // spuriously conflicting with a paid relationship CAS.
    public type FollowerRow = {
        node : Principal;
        head_revision : Nat64;
        storage_revision : Nat64;
        state : FollowerState;
        registration_sequence : Nat64;
        // Receiver-clock time of the most recent accepted paid Follow CAS.
        // This is the retention anchor and changes only when that paid CAS
        // grants another credit tranche and lease.
        funded_at_ns : Nat64;
        delivery_pause : ?DeliveryPause;
        // A debit is moved here until the broker establishes whether the call
        // was dispatched. Renewals include this value in the 128-credit cap,
        // so a definite pre-dispatch result can always restore its credit.
        outstanding_delivery_charges : Nat16;
    };

    public type FollowerHead = {
        revision : Nat64;
        state : FollowerState;
    };

    public type FollowerCounters = {
        // Changes whenever eligibility or an exposed credit balance changes.
        follower_revision : Nat64;
        // Monotonic cutoff used by frozen fanout jobs.
        max_registration_sequence : Nat64;
    };

    public type NewFollowerSummary = {
        node : Principal;
        resulting_revision : Nat64;
        received_at_ns : Nat64;
    };

    public type FollowerMutation = {
        node : Principal;
        // `null` means that the row must still be absent.
        expected_storage_revision : ?Nat64;
        expected_counters : FollowerCounters;
        next_row : FollowerRow;
        next_counters : FollowerCounters;
        new_follower_summary : ?NewFollowerSummary;
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
            subscription_id : Blob;
            status : FollowingStatus;
        };
        #off : {
            last_subscription_id : Blob;
        };
    };

    public type FollowingRow = {
        node : Principal;
        // Local-only, arbitrary precision generation. A stale async result is
        // never allowed to turn an #off intent back on.
        intent_generation : Nat;
        storage_revision : Nat64;
        intent : FollowingIntent;
        last_remote_revision : ?Nat64;
        // Latest receiver-clock-ordered Deliver hint for the active
        // subscription. Exact route replay never rewrites it.
        renewal_requested : Bool;
        // Local-only, saturating count of first durable browser-verified
        // Delivery promotions for the current subscription since the last
        // acknowledged paid Follow. Peer ingress cannot write this field.
        locally_verified_delivery_count : Nat16;
        updated_at_ns : Nat64;
    };

    public type FollowingMutation = {
        node : Principal;
        expected_storage_revision : ?Nat64;
        next_row : FollowingRow;
    };

    public type BlockRow = {
        node : Principal;
        storage_revision : Nat64;
        blocked_at_ns : Nat64;
    };

    public type BlockStatus = {
        node : Principal;
        blocked : Bool;
    };

    public type BlockMutation = {
        node : Principal;
        expected_storage_revision : ?Nat64;
        expected_counters : FollowerCounters;
        next_row : ?BlockRow;
        next_counters : FollowerCounters;
        // Blocking is one relationship transaction: it may also close the
        // two directional rows without deleting their replay fences.
        follower_mutation : ?FollowerMutation;
        following_mutation : ?FollowingMutation;
    };

    // All commit operations must be atomic. A false result means the expected
    // row/counters no longer matched or the backing store could not commit;
    // implementations must not partially apply a mutation.
    public type State = {
        follower : Principal -> ?FollowerRow;
        followers : () -> [FollowerRow];
        // Registration-ordered, exclusive of `after_sequence`, and bounded
        // by `limit`. Null reports a broken registration index join.
        followers_by_registration :
            (?Nat64, Nat) -> ?[FollowerRow];
        // Exact count of physically active follower rows. Expired active
        // leases remain included until bounded retention cleanup removes
        // them, so this is a conservative admission/quote upper bound.
        active_follower_count : () -> Nat;
        follower_counters : () -> FollowerCounters;
        commit_follower : FollowerMutation -> Bool;

        following : Principal -> ?FollowingRow;
        // Exact count of Following rows whose local intent is #on. This is
        // maintained transactionally with the row mutation so Follow
        // admission never has to materialize the full relationship set.
        following_count : () -> Nat;
        commit_following : FollowingMutation -> Bool;

        block : Principal -> ?BlockRow;
        block_count : () -> Nat;
        commit_block : BlockMutation -> Bool;
    };

    public type FollowRequest = {
        expected_revision : Nat64;
        subscription_id : Blob;
    };

    public type FollowAccepted = {
        head : FollowerHead;
        activation : Bool;
    };

    public type FollowError = {
        #invalid_request;
        #self_call;
        #blocked;
        #conflict : ?FollowerHead;
        #full;
        #credit_cap;
        #clock_overflow;
        #revision_overflow;
        #corrupt_state;
        #state_conflict;
    };

    public type FollowResult = {
        #accepted : FollowAccepted;
        #err : FollowError;
    };

    public type UnfollowResult = {
        #accepted : FollowerHead;
        #err : FollowError;
    };

    public type BeginFollowingRequest = {
        node : Principal;
        expected_intent_generation : Nat;
        subscription_id : Blob;
    };

    public type EndFollowingRequest = {
        node : Principal;
        expected_intent_generation : Nat;
    };

    public type FollowingCommand = {
        node : Principal;
        intent_generation : Nat;
        subscription_id : Blob;
        last_remote_revision : ?Nat64;
    };

    public type FollowingError = {
        #invalid_request;
        #self_call;
        #blocked;
        #conflict : ?FollowingRow;
        #full;
        #not_found;
        #revision_overflow;
        #corrupt_state;
        #state_conflict;
    };

    public type FollowingResult = {
        #ok : FollowingRow;
        #err : FollowingError;
    };

    public type VerifiedDeliveryCountResult = {
        #changed : FollowingRow;
        #unchanged;
        #err : {
            #revision_overflow;
            #corrupt_state;
            #state_conflict;
        };
    };

    public type RemoteFollowResult = {
        #accepted : {
            revision : Nat64;
            paid_anchor_ns : Nat64;
        };
        #duplicate : {
            revision : Nat64;
            paid_anchor_ns : Nat64;
        };
        #revision_conflict : Nat64;
        #incompatible : ?Nat64;
        #uncertain : ?Nat64;
    };

    public type DeliveryAdmission = {
        #allowed;
        #invalid_request;
        #self_call;
        #blocked;
        #not_following;
        #subscription_mismatch;
        #incompatible;
        #corrupt_state;
    };

    public type BlockError = {
        #invalid_request;
        #self_call;
        #full;
        #revision_overflow;
        #corrupt_state;
        #state_conflict;
    };

    public type BlockResult = {
        #changed;
        #unchanged;
        #err : BlockError;
    };

    public type FollowerPauseResult = {
        #changed : FollowerRow;
        #unchanged : FollowerRow;
        #err : {
            #not_found;
            #inactive;
            #revision_overflow;
            #corrupt_state;
            #state_conflict;
        };
    };

    public type Eligibility = {
        registered : Bool;
        eligible : Bool;
        reason : ?{
            #expired;
            #no_credit;
            #blocked;
            #paused;
        };
    };

    public type FanoutSnapshot = {
        follower_revision : Nat64;
        cutoff_registration_sequence : Nat64;
        finalized_at_ns : Nat64;
    };

    public type FanoutTarget = {
        node : Principal;
        subscription_id : Blob;
        registration_sequence : Nat64;
        follower_storage_revision : Nat64;
    };

    public type FanoutPage = {
        snapshot : FanoutSnapshot;
        targets : [FanoutTarget];
        next_after_sequence : ?Nat64;
        complete : Bool;
    };

    public type FanoutError = {
        #invalid_cursor;
        #corrupt_state;
    };

    public type FanoutSnapshotResult = {
        #ok : FanoutSnapshot;
        #err : FanoutError;
    };

    public type FanoutResult = {
        #ok : FanoutPage;
        #err : FanoutError;
    };

    public type SendKind = {
        #post;
        #reply;
        #share;
        #tombstone;
    };

    public type SendQuoteRequest = {
        // Kept optional to preserve the V1 "unknown tag => unsupported"
        // boundary when this value is surfaced through Candid.
        send_kind : ?SendKind;
        estimated_object_bytes : Nat32;
        notice_target : ?Principal;
    };

    public type CostEstimateInput = {
        send_kind : SendKind;
        estimated_object_bytes : Nat32;
        delivery_count : Nat32;
        notice_count : Nat32;
    };

    public type CostEstimator = {
        call_and_byte_cycles : CostEstimateInput -> ?Nat;
        local_publication_cycles : CostEstimateInput -> ?Nat;
    };

    public type SendQuote = {
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

    public type SendQuoteError = {
        #invalid_request;
        #unsupported;
        #corrupt_state;
        #estimate_unavailable;
    };

    public type SendQuoteResult = {
        #ok : SendQuote;
        #err : SendQuoteError;
    };

    public type CreditCharge = {
        follower : Principal;
        subscription_id : Blob;
    };

    public type CreditDebitPlan = {
        mutation : FollowerMutation;
        charge : CreditCharge;
        renewal_requested : Bool;
    };

    public type CreditDebitError = {
        #invalid_request;
        #not_found;
        #ineligible;
        #no_credit;
        #revision_overflow;
        #corrupt_state;
    };

    public type CreditDebitResult = {
        #ok : CreditDebitPlan;
        #err : CreditDebitError;
    };

    public type CreditDisposition = {
        #consume;
        #restore;
    };

    public type CreditFinishRequest = {
        charge : CreditCharge;
        disposition : CreditDisposition;
        pause : ?DeliveryPause;
    };

    public type CreditFinishPlan = {
        // A missing mutation means that an old charge was already made
        // irrelevant by Unfollow/re-follow. It must not touch the new row.
        mutation : ?FollowerMutation;
    };

    public type CreditFinishError = {
        #invalid_request;
        #revision_overflow;
        #corrupt_state;
    };

    public type CreditFinishResult = {
        #ok : CreditFinishPlan;
        #err : CreditFinishError;
    };

    // Narrow view consumed by the outbox. The outbox state adapter applies a
    // returned follower mutation atomically with its item transition.
    public type CreditPlanner = {
        prepare_debit : (Principal, Blob, Nat64) -> CreditDebitResult;
        prepare_finish : CreditFinishRequest -> CreditFinishResult;
    };
};
