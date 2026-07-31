import Blob "mo:core/Blob";
import Nat "mo:core/Nat";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Text "mo:core/Text";

import Protocol "../protocol/Types";

module {
    // Keep the public feed surface type-identical to the frozen protocol
    // module. These aliases are intentionally not wire-type redefinitions.
    public type FeedPageRequestV1 = Protocol.FeedPageRequestV1;
    public type FeedEventKindV1 = Protocol.FeedEventKindV1;
    public type VerificationStateV1 = Protocol.VerificationStateV1;
    public type FeedCandidateSummaryV1 = Protocol.FeedCandidateSummaryV1;
    public type FeedPageV1 = Protocol.FeedPageV1;

    public let MAX_CANDIDATES : Nat = 100_000;
    public let MAX_CANDIDATES_PER_SENDER : Nat = 10_000;
    // One untrusted semantic post slot may never make promotion materialize
    // work proportional to the global candidate store.
    public let MAX_CANDIDATES_PER_CLAIMED_SLOT : Nat = 64;
    public let MAX_CANDIDATE_BYTES : Nat = 1_073_741_824;
    // Mirrors the frozen wagyu_v1:deliver request ceiling.
    public let MAX_DELIVERY_EVENT_BYTES : Nat = 16_384;
    public let MAX_ACCOUNTED_OVERHEAD_BYTES : Nat = 4_096;
    public let MAX_VERIFIED_FEED_RECORDS : Nat = 100_000;
    public let MAX_RECEIVED_VIA : Nat = 32;

    // Hashing and stable-text key construction live in the protocol/adapter
    // layer. The feed service treats these values as opaque and verifies only
    // their frozen lengths and their binding to retained records.
    // Trusted internal plan, never a public Candid input. The route wrapper
    // supplies received_at_ns from the backend clock and retain_until_ns from
    // the frozen peer-retention policy after paid-ingress validation.
    public type CandidateAdmission = {
        candidate_key : Text;
        candidate_id : Blob;
        route_receipt_key : Text;
        operation_id : Blob;
        payload_digest : Blob;
        subscription_id : Blob;
        received_at_ns : Nat64;
        immediate_sender : Principal;
        event_kind : FeedEventKindV1;
        claimed_author : Principal;
        claimed_post_id : Blob;
        claimed_body_hash : Blob;
        exact_event_candid : Blob;
        retain_until_ns : Nat64;
        retained_bytes : Nat;
    };

    public type StoredCandidate = {
        candidate_key : Text;
        candidate_id : Blob;
        route_receipt_key : Text;
        operation_id : Blob;
        payload_digest : Blob;
        subscription_id : Blob;
        local_sequence : Nat64;
        received_at_ns : Nat64;
        immediate_sender : Principal;
        event_kind : FeedEventKindV1;
        claimed_author : Principal;
        claimed_post_id : Blob;
        claimed_body_hash : Blob;
        exact_event_candid : Blob;
        verification : VerificationStateV1;
        retain_until_ns : Nat64;
        retained_bytes : Nat;
    };

    public type TransportKey = {
        immediate_sender : Principal;
        operation_id : Blob;
    };

    public type TransportBinding = {
        key : TransportKey;
        payload_digest : Blob;
        candidate_id : Blob;
        candidate_key : Text;
        // Frozen at first admission so a direct service replay cannot expose
        // a later feed revision. The outer ingress receipt remains the
        // authoritative exact encoded route result.
        accepted_revision : Nat64;
    };

    // The canonical feed identity includes the body hash. Unverified claimed
    // (author, post_id) values can therefore never reserve or poison this key.
    public type CanonicalKey = {
        author : Principal;
        post_id : Blob;
        body_hash : Blob;
    };

    public type VerifiedPost = {
        key : CanonicalKey;
        body_length : Nat32;
        object_digest : Blob;
        exact_certified_post_ref_candid : Blob;
        certified_ref : Protocol.CertifiedPostRefV1;
    };

    public type VerifiedShare = {
        sharer : Principal;
        share_id : Blob;
        share_object_digest : Blob;
        // The delivery package and embedded original ref are retained exactly;
        // promotion never reconstructs either from decoded fields.
        exact_delivery_candid : Blob;
        exact_original_post_ref_candid : Blob;
        exact_share_action_candid : Blob;
        exact_share_ref_candid : Blob;
    };

    public type CanonicalStatus = {
        #active;
        #withdrawn : {
            tombstone_id : Blob;
            exact_tombstone_candid : Blob;
            withdrawn_at_ns : Nat64;
        };
    };

    public type CanonicalRecord = {
        key : CanonicalKey;
        post : VerifiedPost;
        first_candidate_id : Blob;
        first_local_sequence : Nat64;
        latest_local_sequence : Nat64;
        direct_candidate_id : ?Blob;
        status : CanonicalStatus;
        created_at_ns : Nat64;
        updated_at_ns : Nat64;
    };

    public type ShareAttribution = {
        key : CanonicalKey;
        sharer : Principal;
        share_id : Blob;
        share_object_digest : Blob;
        candidate_id : Blob;
        exact_share_action_candid : Blob;
        exact_share_ref_candid : Blob;
        verified_at_ns : Nat64;
    };

    public type SuppressionRecord = {
        key : CanonicalKey;
        tombstone_id : Blob;
        exact_tombstone_candid : Blob;
        source_candidate_id : Blob;
        suppressed_at_ns : Nat64;
        retain_until_ns : Nat64;
    };

    // candidate_bytes includes every retained candidate/index allocation.
    // The adapter also owns quota accounting for canonical/attribution copies;
    // it MUST reject commit_promotion atomically when those app-wide managed
    // memory quotas cannot cover a proposed copy.
    public type StoreSnapshot = {
        revision : Nat64;
        last_sequence : Nat64;
        candidate_count : Nat;
        candidate_bytes : Nat;
        verified_feed_count : Nat;
    };

    public type AdmissionCommit = {
        expected : StoreSnapshot;
        candidate : StoredCandidate;
        transport : TransportBinding;
        // False retains dedupe/evidence but omits the sequence from the
        // visible feed-order index because an exact suppression already wins.
        visible : Bool;
        revision : Nat64;
    };

    public type CandidateReplacement = {
        previous : StoredCandidate;
        replacement : StoredCandidate;
    };

    public type CanonicalReplacement = {
        previous : ?CanonicalRecord;
        replacement : CanonicalRecord;
    };

    public type SuppressionReplacement = {
        previous : ?SuppressionRecord;
        replacement : SuppressionRecord;
    };

    // A promotion commit is one no-await atomic boundary. Removing a sequence
    // from page order does not delete its candidate or transport binding; the
    // paid-ingress replay record remains available for its retention horizon.
    public type PromotionCommit = {
        expected : StoreSnapshot;
        candidates : [CandidateReplacement];
        canonical : ?CanonicalReplacement;
        attribution : ?ShareAttribution;
        suppression : ?SuppressionReplacement;
        hide_sequences : [Nat64];
        revision : Nat64;
    };

    public type VerificationCommit = {
        expected_revision : Nat64;
        candidate : CandidateReplacement;
        revision : Nat64;
    };

    // Callbacks keep this state machine independent of managed-memory layout.
    // A commit callback returning false MUST have made no mutation.
    // commit_verification MUST physically discard the candidate, its visible
    // indexes, retention row, and quota charge when the replacement state is
    // #invalid. The transport receipt remains as bounded replay evidence.
    //
    // scan_descending returns visible candidates only, strictly newest first
    // and strictly below before_sequence when it is non-null. Hidden
    // candidates remain addressable through find_candidate.
    //
    // scan_claimed_slot returns the complete slot, never an attacker-selected
    // prefix. Its absolute bound is MAX_CANDIDATES_PER_CLAIMED_SLOT;
    // commit_promotion applies every returned replacement as one no-await
    // mutation.
    //
    // When a PromotionCommit adds a suppression, commit_promotion MUST also,
    // in that same outer mutation, inspect the adapter-owned verified local
    // share index and queue/dedupe the exact tombstone relay by
    // (tombstone_id, local_share_id) before returning true. Outbox allocation
    // remains adapter-owned because this pure feed module allocates no job ids.
    public type Store = {
        snapshot : () -> StoreSnapshot;
        count_for_sender : (Principal) -> Nat;
        find_candidate : (Blob) -> ?StoredCandidate;
        find_transport : (TransportKey) -> ?TransportBinding;
        find_canonical : (CanonicalKey) -> ?CanonicalRecord;
        find_canonical_slot : (Principal, Blob) -> [CanonicalRecord];
        find_attribution : (CanonicalKey, Principal) -> ?ShareAttribution;
        attribution_count : (CanonicalKey) -> Nat;
        find_suppression : (CanonicalKey) -> ?SuppressionRecord;
        scan_claimed_slot : (Principal, Blob) -> [StoredCandidate];
        scan_descending : (?Nat64, Nat) -> [StoredCandidate];
        commit_admission : (AdmissionCommit) -> Bool;
        commit_promotion : (PromotionCommit) -> Bool;
        commit_verification : (VerificationCommit) -> Bool;
    };

    public type Capacity = {
        #total_count;
        #total_bytes;
        #sender_count;
        #claimed_slot;
        #verified_feed;
    };

    public type AdmissionRejection = {
        #invalid;
        #full : Capacity;
        #sequence_exhausted;
        #revision_exhausted;
        #stale_state;
        #corrupt_state;
    };

    public type AdmissionAccepted = {
        candidate_id : Blob;
        local_sequence : Nat64;
        revision : Nat64;
    };

    public type ExistingCandidate = {
        candidate_id : Blob;
        local_sequence : Nat64;
        revision : Nat64;
    };

    public type AdmissionOutcome = {
        #accepted : AdmissionAccepted;
        #duplicate : ExistingCandidate;
        #conflict : ExistingCandidate;
        #rejected : AdmissionRejection;
    };

    public type PageError = {
        #invalid_limit;
        #corrupt_state;
    };

    public type PageResult = {
        #ok : FeedPageV1;
        #err : PageError;
    };

    // Trusted internal plans assembled by an owner-authorized wrapper after
    // frontend verification. verified_at_ns is injected from the backend
    // clock; it is never copied from owner Candid.
    public type PromoteDeliveryRequest = {
        candidate_id : Blob;
        post : VerifiedPost;
        share : ?VerifiedShare;
        verified_at_ns : Nat64;
    };

    public type PromoteTombstoneRequest = {
        candidate_id : Blob;
        key : CanonicalKey;
        tombstone_id : Blob;
        exact_tombstone_candid : Blob;
        verified_at_ns : Nat64;
        retain_until_ns : Nat64;
    };

    public type PromotionChanged = {
        candidate_id : Blob;
        revision : Nat64;
        canonical : ?CanonicalRecord;
    };

    public type PromotionError = {
        #invalid;
        #not_found;
        #invalid_transition;
        #equivocation;
        #full : Capacity;
        #revision_exhausted;
        #stale_state;
        #corrupt_state;
    };

    public type PromotionOutcome = {
        #promoted : PromotionChanged;
        #merged : PromotionChanged;
        #suppressed : PromotionChanged;
        #quarantined : PromotionChanged;
        #duplicate : PromotionChanged;
        #err : PromotionError;
    };

    public type VerificationRequest = {
        candidate_id : Blob;
        verification : VerificationStateV1;
    };

    public type VerificationChanged = {
        candidate_id : Blob;
        revision : Nat64;
        verification : VerificationStateV1;
    };

    public type VerificationError = {
        #invalid;
        #not_found;
        #invalid_transition;
        #revision_exhausted;
        #stale_state;
        #corrupt_state;
    };

    public type VerificationOutcome = {
        #changed : VerificationChanged;
        #unchanged : VerificationChanged;
        #err : VerificationError;
    };
};
