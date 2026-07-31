import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Text "mo:core/Text";

import RelationshipTypes "../relationships/Types";
import TransportTypes "../transport/Types";

module {
    public type StateV1 = {
        #queued;
        #sending;
        #accepted;
        #duplicate;
        #paused;
        #failed;
        #uncertain;
        #superseded;
    };

    public type RetryPermission = {
        #none;
        #automatic;
        #manual;
        #local_state_change;
    };

    public type NodePause = {
        #low_cycles;
        #authority_revoked;
    };

    public type Control = {
        revision : Nat64;
        pause : ?NodePause;
    };

    public type Item = {
        local_id : Nat64;
        storage_revision : Nat64;
        prepared : TransportTypes.PreparedDispatchV1;
        created_at_ns : Nat64;
        retry_expires_at_ns : Nat64;
        updated_at_ns : Nat64;
        attempt_no : Nat32;
        // True means this exact attempt (and its delivery credit, if any) was
        // durably prepared but has not yet received a dispatch result.
        attempt_prepared : Bool;
        state : StateV1;
        retry_permission : RetryPermission;
        next_attempt_at_ns : ?Nat64;
        // Historical field name: this is frozen at the first durable
        // dispatch start. Exact retries never move the paid-operation anchor.
        last_attempt_at_ns : ?Nat64;
        automatic_retry_count : Nat16;
        delivery_subscription_id : ?Blob;
        pending_credit_charge : ?RelationshipTypes.CreditCharge;
        last_result : ?TransportTypes.DispatchResultV1;
    };

    public type ControlMutation = {
        expected_revision : Nat64;
        next : Control;
    };

    public type Mutation = {
        local_id : Nat64;
        // `null` means that the item must still be absent.
        expected_storage_revision : ?Nat64;
        next_item : Item;
        follower_mutation : ?RelationshipTypes.FollowerMutation;
        control_mutation : ?ControlMutation;
    };

    public type DueIndexKey = (Nat64, Nat64);

    public type DueIndexEntry = {
        key : DueIndexKey;
        item : Item;
    };

    public type DueIndexPage = {
        // The authoritative ordered key resolved from the durable local-ID
        // scheduler cursor. Null means the cursor row left the due index and
        // the adapter restarted from its head.
        after_key : ?DueIndexKey;
        entries : [DueIndexEntry];
    };

    // The adapter must apply the item, follower, and control portions of one
    // mutation atomically. False means no portion was committed.
    public type State = {
        item : Nat64 -> ?Item;
        find_operation : (Principal, Text, Blob) -> ?Item;
        count : () -> Nat;
        // Ordered strictly by local_id and exclusive of `after`.
        page_after : (?Nat64, Nat) -> [Item];
        // Ordered strictly by (next_attempt_at_ns, local_id), exclusive of the
        // resolved cursor, with one bounded lookahead supplied by the caller.
        due_page : (?Nat64, Nat) -> ?DueIndexPage;
        control : () -> Control;
        commit : Mutation -> Bool;
        commit_control : ControlMutation -> Bool;
    };

    public type EnqueueRequest = {
        local_id : Nat64;
        prepared : TransportTypes.PreparedDispatchV1;
        // Present exactly for `wagyu_v1:deliver`. The payload must already
        // contain the returned renewal_requested bit before commit.
        delivery_subscription_id : ?Blob;
        encoded_renewal_requested : ?Bool;
    };

    public type EnqueueError = {
        #invalid_request;
        #operation_conflict;
        #full;
        #expired;
        #clock_overflow;
        #revision_overflow;
        #credit_unavailable : RelationshipTypes.CreditDebitError;
        #corrupt_state;
        #state_conflict;
    };

    public type EnqueueResult = {
        #queued : Item;
        #existing : Item;
        #err : EnqueueError;
    };

    public type DrainMode = {
        #automatic;
        #owner;
    };

    public type PlanRequest = {
        after_local_id : ?Nat64;
        mode : DrainMode;
        now_ns : Nat64;
    };

    public type BatchPlan = {
        local_ids : [Nat64];
        next_after_local_id : ?Nat64;
        complete : Bool;
    };

    public type PlanError = {
        #node_paused : NodePause;
        #invalid_cursor;
        #corrupt_state;
    };

    public type PlanResult = {
        #ok : BatchPlan;
        #err : PlanError;
    };

    public type PageResult = {
        #ok : [Item];
        #err : {
            #invalid_request;
            #corrupt_state;
        };
    };

    public type StartDispatch = {
        local_id : Nat64;
        attempt_no : Nat32;
        prepared : TransportTypes.PreparedDispatchV1;
    };

    public type TransitionError = {
        #invalid_request;
        #not_found;
        #not_ready;
        #in_flight;
        #node_paused : NodePause;
        #expired;
        #attempt_mismatch;
        #retry_not_allowed;
        #revision_overflow;
        #clock_overflow;
        #credit_unavailable : RelationshipTypes.CreditDebitError;
        #credit_reconciliation : RelationshipTypes.CreditFinishError;
        #corrupt_state;
        #state_conflict;
    };

    public type StartResult = {
        #dispatch : StartDispatch;
        #err : TransitionError;
    };

    public type FinishRequest = {
        local_id : Nat64;
        attempt_no : Nat32;
        result : TransportTypes.DispatchResultV1;
        callback_time_ns : Nat64;
        // Locally generated entropy reduced into the transport-provided
        // jitter window. It is never taken from a peer timestamp.
        jitter : Nat64;
    };

    public type FinishResult = {
        #ok : Item;
        #err : TransitionError;
    };

    public type RemoteDispatchAdapter = {
        valid_prepared : TransportTypes.PreparedDispatchV1 -> Bool;
        call_batch : (
            [TransportTypes.PreparedDispatchV1],
            Nat64,
        ) -> async* TransportTypes.BatchDispatchResultV1;
    };
};
