import Blob "mo:core/Blob";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Text "mo:core/Text";

import Feed "../feed/Types";
import Likes "../likes/Admission";
import Notifications "../notifications/Types";
import Protocol "../protocol/Types";
import Relationships "../relationships/Types";

module {
    public type Route = {
        #follow;
        #unfollow;
        #deliver;
        #like;
        #notice;
    };

    public type Request = {
        route : Route;
        caller : Principal;
        // Exact kernel PublicIngressRequestV1.payload bytes. The service
        // decodes only the outer WagyuIngressV1 envelope before hashing its
        // still-opaque body_candid.
        exact_ingress_candid : Blob;
        network_id : Blob;
        self_node : Principal;
        now_ns : Nat64;
    };

    public type ReceiptKey = {
        caller : Principal;
        route : Route;
        operation_id : Blob;
    };

    public type Receipt = {
        key : ReceiptKey;
        stable_key : Text;
        payload_digest : Blob;
        result : Protocol.WagyuRouteResultV1;
        exact_result_candid : Blob;
        received_at_ns : Nat64;
        retain_until_ns : Nat64;
        retained_bytes : Nat;
    };

    // Windows are rolling from the first admitted operation after the prior
    // window expires. They are receiver-clock values only.
    public type RateWindow = {
        caller : Principal;
        route : Route;
        window_started_at_ns : Nat64;
        accepted_count : Nat32;
        // Used only by Notice. It counts newly retained semantic actions, not
        // operation-id retries or semantic duplicates.
        semantic_notice_count : Nat32;
        expires_at_ns : Nat64;
        retained_bytes : Nat;
    };

    public type RateMutation = {
        stable_key : Text;
        expected : ?RateWindow;
        replacement : RateWindow;
    };

    public type NotificationMutation = {
        append : Notifications.AppendCommit;
        retain_until_ns : Nat64;
        retained_bytes : Nat;
    };

    public type LikeTarget = {
        post_key : Text;
        post_author : Principal;
        post_id : Blob;
        post_body_hash : Blob;
        accepting_likes : Bool;
        // Includes structurally accepted notification/evidence rows that have
        // not yet passed owner-browser verification, plus verified receipts
        // that have not yet been sealed.
        unsealed_receipt_count : Nat16;
        unsealed_receipt_limit : Nat16;
        next_accepted_sequence : Nat64;
        existing_receipt_digest : ?Blob;
        segments : Likes.Segments;
    };

    public type LikeMutation = {
        post_key : Text;
        expected_next_accepted_sequence : Nat64;
        expected_existing_receipt_digest : ?Blob;
        expected_segments : Likes.Segments;
        accepted : Likes.AcceptedLike;
        replacement_next_accepted_sequence : Nat64;
        replacement_segments : Likes.Segments;
        seal_due : Bool;
        retain_until_ns : Nat64;
        retained_bytes : Nat;
    };

    public type AuthoredPostTarget = {
        post_key : Text;
        post_author : Principal;
        post_id : Blob;
        post_body_hash : Blob;
        // False covers an awaiting-proof, withdrawing, withdrawn, or otherwise
        // no-longer-recognized target without exposing its private lifecycle.
        live : Bool;
    };

    // One explicit no-await unit. A domain mutation can include both a primary
    // mutation and the notification it creates (Follow activation or Like).
    // The adapter MUST apply every present field and the receipt atomically,
    // or apply none of them.
    public type DomainMutation = {
        follower : ?Relationships.FollowerMutation;
        // A fresh accepted Deliver CAS-updates the receiver's local Following
        // row with the exact renewal_requested bit. Route replay and semantic
        // rejection leave it absent.
        following : ?Relationships.FollowingMutation;
        feed : ?Feed.AdmissionCommit;
        notification : ?NotificationMutation;
        like : ?LikeMutation;
    };

    public type CommitPlan = {
        receipt : Receipt;
        rate : ?RateMutation;
        domain : DomainMutation;
    };

    // All service stores passed here are read views. Ingress replaces their
    // commit callbacks with capture-only callbacks before invoking the
    // existing state machines.
    //
    // preflight MUST be read-only. execute() first preflights the two bounded
    // receipt+rate-only fallback plans, then the complete domain plan. This
    // makes a domain allocation refusal replayable as #full and a later CAS
    // refusal replayable as #conflict. Once a fallback preflight succeeds,
    // the adapter MUST keep it committable for the remainder of this
    // synchronous no-await execution.
    //
    // commit_atomic MUST recheck all expected snapshots/revisions and either
    // commit the complete CommitPlan or make no change. Neither callback may
    // await. Returning false after partial mutation violates this interface.
    public type State = {
        receipt : ReceiptKey -> ?Receipt;
        receipt_stable_key : ReceiptKey -> Text;
        candidate_stable_key : Blob -> Text;
        rate_window : (Principal, Route) -> ?RateWindow;
        rate_window_stable_key : (Principal, Route) -> Text;

        relationships : Relationships.State;
        feed : Feed.Store;
        notifications : Notifications.Store;

        like_target : (Blob, Principal) -> ?LikeTarget;
        authored_post_target : Blob -> ?AuthoredPostTarget;

        preflight : CommitPlan -> Bool;
        commit_atomic : CommitPlan -> Bool;
    };

    public type Response = {
        result : Protocol.WagyuRouteResultV1;
        exact_result_candid : Blob;
        // True only when this response came from a previously stored receipt.
        replayed : Bool;
        // True only when this invocation atomically stored its new receipt.
        committed : Bool;
    };

    // The frozen Unfollow response ceiling is 128 bytes, while encoding the
    // complete WagyuRouteResultV1 record type table takes at least 183 bytes.
    // Candid record-width subtyping lets this exact narrow record decode as
    // WagyuRouteResultV1: both omitted fields are optional and therefore
    // decode as null. Physical Unfollow wrappers must emit this subtype (or
    // return Response.exact_result_candid through the kernel transport).
    public type UnfollowRouteResultV1 = {
        outcome : ?Protocol.RouteOutcomeV1;
        revision : ?Nat64;
    };

    public type PlanOutcome = {
        #ready : CommitPlan;
        #replay : Receipt;
        // An outer envelope that cannot expose a valid operation id cannot be
        // receipted. A reused operation id with a different digest also leaves
        // the original receipt untouched.
        #immediate : Response;
    };
};
