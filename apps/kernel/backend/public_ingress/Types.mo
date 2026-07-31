import Map "mo:core/Map";
import CapabilityTypes "../capabilities/Types";

module {
    public type AppScope = CapabilityTypes.AppScope;

    public type RouteMode = { #query_; #update_ };
    public type CallerPolicy = { #any; #authenticated; #canister };
    public type UpdateOrigin = {
        #authenticated_ingress;
        #canister_call;
    };

    public type RouteDeclaration = {
        protocol : Text;
        id : Text;
        handler : Text;
        mode : RouteMode;
        caller : CallerPolicy;
        max_request_bytes : Nat;
        max_response_bytes : Nat;
        max_calls_per_hour : ?Nat;
        max_calls_per_caller_per_hour : ?Nat;
        required_cycles : ?Nat;
        fingerprint : Text;
    };

    public type RoutesDeclaration = {
        routes : [RouteDeclaration];
    };

    public type AppDeclaration = {
        app_scope : AppScope;
        public_ingress : ?RoutesDeclaration;
    };

    // The app and protocol are captured by the compiler-generated physical
    // endpoint. Callers can select only a declared local method and payload.
    public type RequestV1 = {
        method : Text;
        payload : Blob;
    };

    public type ErrorV1 = {
        #bad_request;
        #not_found;
        #too_large;
        #unauthorized;
        #rate_limited;
        #busy;
        #low_cycles;
        #revoked;
        #revoked_after_dispatch;
        #handler_failed;
    };

    public type ResultV1 = {
        #ok : Blob;
        #err : ErrorV1;
    };

    // This context is kernel-created. In particular, the caller is always the
    // real caller of the generic physical endpoint, never a payload field.
    public type HandlerRequestV1 = {
        caller : Principal;
        payload : Blob;
    };

    // Canister-paid public update handlers may reserve some of the caller's
    // still-unaccepted cycles. Authenticated ingress routes do not receive this
    // capability. The kernel performs actual acceptance only after the trusted
    // synchronous handler has completed successfully.
    public type PublicIngressCyclesV1 = {
        available : () -> Nat;
        request : Nat -> ();
    };

    public type DispatchV1 = {
        dispatch_id : Nat64;
        app_scope : AppScope;
        protocol : Text;
        method : Text;
        request : HandlerRequestV1;
        request_hash : Blob;
        route_fingerprint : Text;
        authority_epoch : Nat64;
    };

    public type QueryHandlerV1 = HandlerRequestV1 -> Blob;
    public type UpdateHandlerV1 = shared DispatchV1 -> async Blob;
    public type HandlerRegistrationV1 = {
        app_scope : AppScope;
        protocol : Text;
        method : Text;
        handler : {
            #query_ : QueryHandlerV1;
            #update_ : UpdateHandlerV1;
        };
    };

    public type RateCounter = {
        window_started_at : Nat64;
        accepted : Nat;
    };

    public type CommittedRoute = {
        scope : AppScope;
        protocol : Text;
        id : Text;
        handler : Text;
        mode : RouteMode;
        caller : CallerPolicy;
        max_request_bytes : Nat;
        max_response_bytes : Nat;
        max_calls_per_hour : ?Nat;
        required_cycles : ?Nat;
        fingerprint : Text;
        authority_epoch : Nat64;
    };

    public type PendingState = {
        #waiting;
        #completed : Blob;
    };

    public type PendingDispatch = {
        dispatch_id : Nat64;
        scope : AppScope;
        protocol : Text;
        method : Text;
        request_hash : Blob;
        route_fingerprint : Text;
        authority_epoch : Nat64;
        accepted_at : Nat64;
        additional_cycles_available : Nat;
        additional_cycles_requested : Nat;
        state : PendingState;
    };

    public type Memory = {
        routes : Map.Map<Text, CommittedRoute>;
        rates_by_route : Map.Map<Text, RateCounter>;
        rates_by_scope : Map.Map<Text, RateCounter>;
        var global_rate : RateCounter;
        pending : Map.Map<Nat64, PendingDispatch>;
        pending_by_route : Map.Map<Text, Nat>;
        pending_by_scope : Map.Map<Text, Nat>;
        var pending_count : Nat;
        var next_dispatch_id : Nat64;
        var last_seen_at : Nat64;
    };
}
