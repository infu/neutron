import Blob "mo:core/Blob";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Text "mo:core/Text";

import ProtocolTypes "../protocol/Types";

module {
    // The compiler owns this physical method and captures the app/protocol
    // identity in it. A caller may select only one of the five logical route
    // names inside the PublicIngressRequestV1 argument.
    public let PHYSICAL_METHOD : Text = "app_wagyu__wagyu_v1_update";
    public let MAX_BATCH_CALLS : Nat = 20;

    public let SECOND_NS : Nat64 = 1_000_000_000;
    public let MINUTE_NS : Nat64 = 60_000_000_000;
    public let DAY_NS : Nat64 = 86_400_000_000_000;
    public let RETRY_HORIZON_NS : Nat64 = 34_560_000_000_000_000;
    public let UNCERTAIN_RETRY_DELAY_NS : Nat64 = 300_000_000_000;
    public let LIKE_FULL_RETRY_DELAY_NS : Nat64 = MINUTE_NS;
    public let BUSY_RETRY_DELAY_NS : Nat64 = 30_000_000_000;
    public let BUSY_RETRY_JITTER_NS : Nat64 = 30_000_000_000;
    public let RATE_LIMIT_RETRY_DELAY_NS : Nat64 = 300_000_000_000;
    public let RATE_LIMIT_RETRY_JITTER_NS : Nat64 = 300_000_000_000;

    // This structural port deliberately mirrors neutron-capabilities without
    // importing it. Main adapts the compiler-injected capability directly,
    // while tests can provide a small deterministic fake.
    public type BackendCallRequestV1 = {
        canister : Principal;
        method : Text;
        args : Blob;
        cycles : Nat;
    };

    public type BackendCallErrorV1 = {
        code : Text;
        message : Text;
    };

    public type BackendCallResultV1 = {
        #ok : Blob;
        #err : BackendCallErrorV1;
    };

    public type BackendCallPort = {
        can_call : (Principal, Text) -> Bool;
        call : BackendCallRequestV1 -> async* BackendCallResultV1;
        call_batch : [BackendCallRequestV1] -> async* [BackendCallResultV1];
    };

    public type PrepareInputV1 = {
        target : Principal;
        route : Text;
        operation_id : Blob;
        // These are the already-frozen route-specific Candid bytes. The
        // dispatcher never accepts a decoded body for a retry.
        exact_body_candid : Blob;
        created_at_ns : Nat64;
    };

    public type PreparedDispatchV1 = {
        target : Principal;
        route : Text;
        operation_id : Blob;
        payload_digest : Blob;
        exact_body_candid : Blob;
        exact_ingress_candid : Blob;
        exact_call_args : Blob;
        cycles : Nat;
        maximum_response_bytes : Nat;
        created_at_ns : Nat64;
    };

    public type PrepareErrorV1 = {
        #invalid_route;
        #invalid_operation_id;
        #invalid_body_candid;
        #self_call;
        #request_too_large;
        #not_reserved;
        #invalid_prepared_call;
    };

    public type PrepareResultV1 = {
        #ok : PreparedDispatchV1;
        #err : PrepareErrorV1;
    };

    public type DispatchCertaintyV1 = {
        // The broker or the remote public-ingress admission rejected before
        // the Wagyu handler could run. A caller may restore a delivery credit.
        #not_dispatched;
        // The remote handler may have committed. Never restore a credit or
        // synthesize a new operation id from this result.
        #may_have_dispatched;
        // A well-formed Wagyu semantic result was received.
        #semantic;
    };

    public type DispatchOutcomeV1 = {
        #accepted;
        #duplicate;
        #route_rejected : ProtocolTypes.RouteRejectionReasonV1;
        #busy;
        #rate_limited;
        #low_cycles;
        #revoked;
        #handler_failure;
        #uncertain;
        #unsupported;
        #pre_dispatch_failure;
    };

    public type RetryPolicyV1 = {
        #complete;
        #terminal;
        #delayed : {
            minimum_delay_ns : Nat64;
            jitter_window_ns : Nat64;
        };
        #pause;
        #manual : {
            minimum_delay_ns : Nat64;
        };
    };

    public type DispatchResultV1 = {
        outcome : DispatchOutcomeV1;
        certainty : DispatchCertaintyV1;
        retry : RetryPolicyV1;
        // Present only after an exact current-V1 route result decoded.
        route_result : ?ProtocolTypes.WagyuRouteResultV1;
        // The exact inner reply is retained for diagnostics and never
        // reconstructed from route_result.
        exact_route_result_candid : ?Blob;
        // Bounded transport diagnostic, never a protocol decision input.
        code : ?Text;
        detail : ?Text;
    };

    public type BatchDispatchResultV1 = {
        #ok : [DispatchResultV1];
        #err : {
            #empty;
            #too_large;
            #invalid_prepared_call;
        };
    };
};
