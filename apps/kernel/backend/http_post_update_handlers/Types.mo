import Map "mo:core/Map";
import Queue "mo:core/Queue";
import Public "mo:neutron-capabilities";
import CapabilityTypes "../capabilities/Types";
import RouteNamespace "../http_routes/Namespace";

module {
    public type AppScope = CapabilityTypes.AppScope;
    // API-1 POST routes remain independent from the hard-cut API-2 certified
    // store declaration. The compiler projects exactly one route API into the
    // corresponding local configuration field.
    public type MountDeclaration = {
        id : Text;
        surface : Text;
        prefix : ?Text;
        methods : [Text];
        mode : Text;
        max_request_bytes : Nat;
        max_response_bytes : Nat;
        handler : ?Text;
        max_calls_per_hour : ?Nat;
        forward_headers : [Text];
    };
    public type RoutesDeclaration = {
        api : Nat;
        mounts : [MountDeclaration];
    };
    public type AppDeclaration = {
        app_scope : AppScope;
        http_routes : ?RoutesDeclaration;
    };

    public type HandlerRequestV1 = Public.HttpPostUpdateHandlerRequestV1;
    public type HandlerResponseV1 = Public.HttpPostUpdateHandlerResponseV1;

    public type DispatchV1 = {
        request : HandlerRequestV1;
        key_hash : Blob;
        request_hash : Blob;
        mount_fingerprint : Text;
        authority_epoch : Nat64;
    };

    public type HandlerV1 = shared DispatchV1 -> async HandlerResponseV1;
    public type HandlerRegistration = {
        app_scope : AppScope;
        mount_id : Text;
        handler : HandlerV1;
    };

    public type RateCounter = {
        window_started_at : Nat64;
        accepted : Nat;
    };

    public type CommittedMount = {
        scope : AppScope;
        id : Text;
        surface : RouteNamespace.Surface;
        prefix : Text;
        max_request_bytes : Nat;
        max_response_bytes : Nat;
        max_calls_per_hour : Nat;
        forward_headers : [Text];
        fingerprint : Text;
        authority_epoch : Nat64;
    };

    public type ReplayState = {
        #pending;
        #completed : HandlerResponseV1;
        #failed_unknown;
    };

    public type Replay = {
        scope : AppScope;
        mount_id : Text;
        mount_fingerprint : Text;
        authority_epoch : Nat64;
        key_hash : Blob;
        request_hash : Blob;
        accepted_at : Nat64;
        reserved_response_bytes : Nat;
        state : ReplayState;
    };

    public type Memory = {
        mounts : Map.Map<Text, CommittedMount>;
        rates_by_mount : Map.Map<Text, RateCounter>;
        rates_by_scope : Map.Map<Text, RateCounter>;
        var global_rate : RateCounter;
        replays : Map.Map<Blob, Replay>;
        replay_entries_by_scope : Map.Map<Text, Nat>;
        replay_reserved_bytes_by_scope : Map.Map<Text, Nat>;
        pending_by_mount : Map.Map<Text, Nat>;
        pending_by_scope : Map.Map<Text, Nat>;
        replay_order : Queue.Queue<Blob>;
        var replay_reserved_bytes : Nat;
        var pending : Nat;
        var last_seen_at : Nat64;
    };

    public type Error = {
        #bad_request;
        #not_found;
        #method_not_allowed;
        #too_large;
        #conflict;
        #pending;
        #failed_unknown;
        #rate_limited;
        #capacity_exceeded;
        #busy;
        #low_cycles;
        #revoked;
        #handler_failed;
    };

    public type Result = {
        #ok : HandlerResponseV1;
        #err : Error;
    };
};
