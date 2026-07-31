import Blob "mo:core/Blob";
import Nat "mo:core/Nat";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";

import Protocol "../protocol/Types";

module {
    // Keep the public notification surface type-identical to the frozen
    // protocol module. These aliases are intentionally not redefinitions.
    public type NotificationKindV1 = Protocol.NotificationKindV1;
    public type NotificationVerificationV1 =
        Protocol.NotificationVerificationV1;
    public type NotificationSummaryV1 = Protocol.NotificationSummaryV1;
    public type NotificationPageRequestV1 =
        Protocol.NotificationPageRequestV1;
    public type NotificationPageV1 = Protocol.NotificationPageV1;
    public type NotificationEvidenceRequestV1 =
        Protocol.NotificationEvidenceRequestV1;
    public type NotificationEvidenceV1 = Protocol.NotificationEvidenceV1;
    public type NoticeRelationV1 = Protocol.NoticeRelationV1;

    public let MAX_SUMMARIES : Nat = 100_000;
    public let MAX_NOTICE_SUMMARIES_PER_ACTOR : Nat = 2_000;
    public let MAX_NOTICE_SUMMARIES_PER_TARGET : Nat = 10_000;

    public type NotificationObjectV1 = {
        target_post_id : Blob;
        target_body_hash : Blob;
        action_id : Blob;
        object_digest : Blob;
        object_length : Nat32;
    };

    // Semantic keys are caller-bound. They are independent of route operation
    // ids, which remain in the paid-ingress receipt ledger.
    public type SemanticKey = {
        #new_follower : {
            acting_node : Principal;
            follower_revision : Nat64;
        };
        #like : {
            acting_node : Principal;
            target_post_id : Blob;
        };
        #notice : {
            acting_node : Principal;
            relation : NoticeRelationV1;
            action_id : Blob;
        };
    };

    public type AppendEvent = {
        #new_follower : {
            follower_revision : Nat64;
        };
        #like : {
            locator : NotificationObjectV1;
            certified_like_receipt_candid : Blob;
        };
        #notice : {
            relation : NoticeRelationV1;
            locator : NotificationObjectV1;
        };
    };

    public type AppendRequest = {
        acting_node : Principal;
        received_at_ns : Nat64;
        event : AppendEvent;
    };

    public type StoredNotification = {
        summary : NotificationSummaryV1;
        // Present exactly for a Like row and absent for every other V1 kind.
        like_evidence : ?Blob;
    };

    public type StoreSnapshot = {
        revision : Nat64;
        last_sequence : Nat64;
        total_count : Nat;
    };

    // The adapter applies every field of AppendCommit as one no-await
    // mutation: row, exact evidence, semantic index, quota indexes, sequence,
    // and revision. This is the notification subsystem's atomic boundary.
    public type AppendCommit = {
        expected : StoreSnapshot;
        stored : StoredNotification;
        semantic_key : SemanticKey;
        revision : Nat64;
    };

    public type ReplaceCommit = {
        expected_revision : Nat64;
        previous : NotificationSummaryV1;
        replacement : NotificationSummaryV1;
        revision : Nat64;
    };

    // Callbacks keep this service independent of managed-memory layout. A
    // callback returning false MUST have made no mutation.
    public type Store = {
        snapshot : () -> StoreSnapshot;
        find_semantic : (SemanticKey) -> ?StoredNotification;
        get : (Nat64) -> ?StoredNotification;
        scan_descending : (?Nat64, Nat) -> [StoredNotification];
        notice_count_for_actor : (Principal) -> Nat;
        notice_count_for_target : (Blob) -> Nat;
        commit_append : (AppendCommit) -> Bool;
        commit_replace : (ReplaceCommit) -> Bool;
    };

    public type Capacity = {
        #total;
        #notice_actor;
        #notice_target;
    };

    public type AppendRejection = {
        #invalid;
        #full : Capacity;
        #sequence_exhausted;
        #stale_state;
    };

    public type AppendAccepted = {
        revision : Nat64;
        summary : NotificationSummaryV1;
    };

    public type Existing = {
        revision : Nat64;
        local_sequence : Nat64;
    };

    public type AppendOutcome = {
        #accepted : AppendAccepted;
        #duplicate : Existing;
        #conflict : Existing;
        #rejected : AppendRejection;
    };

    public type PageError = {
        #invalid_limit;
        #corrupt_state;
    };

    public type PageResult = {
        #ok : NotificationPageV1;
        #err : PageError;
    };

    public type EvidenceError = {
        #corrupt_state;
    };

    public type EvidenceResult = {
        #ok : NotificationEvidenceV1;
        #err : EvidenceError;
    };

    public type VerificationRequest = {
        local_sequence : Nat64;
        verification : NotificationVerificationV1;
    };

    public type MutationError = {
        #not_found;
        #invalid_transition;
        #incompatible;
        #revision_exhausted;
        #stale_state;
        #corrupt_state;
    };

    public type MutationChanged = {
        revision : Nat64;
        summary : NotificationSummaryV1;
    };

    public type MutationOutcome = {
        #changed : MutationChanged;
        #unchanged : MutationChanged;
        #err : MutationError;
    };
};
