import Blob "mo:core/Blob";

import Caps "mo:neutron-capabilities";

import Planner "../actions/Planner";
import Publication "../actions/Publication";
import Admission "../likes/Admission";
import Sealing "../likes/Sealing";
import Protocol "../protocol/Types";

module {
    // `#stop_likes` exists only on a prepared StartPlan. A durable
    // ClosingState is returned only after the kernel receipt for that CAS has
    // been validated, so application state can never claim Likes are closed
    // ahead of the certified head.
    public type Phase = {
        #stop_likes;
        #seal_due;
        #seal_final_partial;
        #ready_for_fanout;
        #complete;
    };

    public type Error = {
        #invalid_tombstone;
        #invalid_post_binding;
        #invalid_segments;
        #invalid_state;
        #invalid_time;
        #already_complete;
        #planner : Planner.Error;
        #sealing : Sealing.Error;
    };

    public type Result<T> = {
        #ok : T;
        #err : Error;
    };

    public type StartInput = {
        // This is the same immutable plan whose object publication has
        // already succeeded. Planner.finalizeTombstone binds the supplied
        // proof to these exact frozen bytes.
        tombstone_plan : Planner.TombstonePlan;
        proof : Protocol.CertifiedHttpProofV1;
        head : Sealing.HeadState;
        segments : Admission.Segments;
        follower_registration_cutoff : Nat64;
        started_at_ns : Nat64;
        publication_nonce : Blob;
    };

    public type StartPlan = {
        phase : Phase;
        tombstone_plan : Planner.TombstonePlan;
        certified_tombstone : Protocol.CertifiedTombstoneV1;
        exact_tombstone_candid : Blob;
        follower_registration_cutoff : Nat64;
        segments : Admission.Segments;
        started_at_ns : Nat64;
        stop : Sealing.StopPlan;
        // Main passes this value directly to the kernel publication commit.
        // Keeping the exact nonce and bytes makes a retained plan resumable
        // through the kernel's idempotent publication receipt.
        commit : Caps.CommitBatchInput;
    };

    public type ClosingState = {
        tombstone_id : Blob;
        certified_tombstone : Protocol.CertifiedTombstoneV1;
        exact_tombstone_candid : Blob;
        follower_registration_cutoff : Nat64;
        head : Sealing.HeadState;
        segments : Admission.Segments;
        phase : Phase;
        started_at_ns : Nat64;
        updated_at_ns : Nat64;
    };

    public type StartReconciliation = {
        closing : ClosingState;
        head_identity : Caps.RecordIdentity;
    };

    public type AdvanceInput = {
        closing : ClosingState;
        like_batches_generation : Nat64;
        publication_nonce : Blob;
        updated_at_ns : Nat64;
    };

    public type SealPlan = {
        previous : ClosingState;
        sealing : Sealing.SealPlan;
        updated_at_ns : Nat64;
        // Main passes this value directly to the kernel publication commit.
        commit : Caps.CommitBatchInput;
    };

    public type SuppressionPlan = {
        author : Principal;
        post_id : Blob;
        post_body_hash : Blob;
        tombstone_id : Blob;
        exact_tombstone_candid : Blob;
        withdrawn_at_ns : Nat64;
    };

    public type FanoutPlan = {
        tombstone_id : Blob;
        exact_event_candid : Blob;
        follower_registration_cutoff : Nat64;
        created_at_ns : Nat64;
    };

    // There is no kernel operation and no remote call in this plan. Main
    // applies authored-row withdrawal, local timeline suppression, and
    // creation of every direct-follower fanout job/target in one infallible
    // local mutation before any outbox await.
    public type LocalFinalizePlan = {
        previous : ClosingState;
        suppression : SuppressionPlan;
        fanout : FanoutPlan;
        next : ClosingState;
    };

    public type AdvancePlan = {
        #publish : SealPlan;
        #finalize : LocalFinalizePlan;
    };

    public type SealReconciliation = {
        closing : ClosingState;
        batch_identity : Caps.RecordIdentity;
        head_identity : Caps.RecordIdentity;
    };

    // A small runtime adapter shape for callers that want to pass the
    // Certified Assets capability method as a synchronous callback. The
    // orchestrator itself stays pure and never invokes it.
    public type CommitCallback = (
        Caps.CommitBatchInput
    ) -> Caps.CommitBatchResult;

    public func storedHead(
        value : Protocol.LikeHeadV1,
        exactBodyCandid : Blob,
        identity : Caps.RecordIdentity,
    ) : Sealing.HeadState {
        {
            value;
            exact_body_candid = exactBodyCandid;
            kernel_identity = Publication.stored(identity);
        };
    };
};
