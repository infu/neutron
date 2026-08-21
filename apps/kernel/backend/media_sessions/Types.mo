import Blob "mo:core/Blob";
import Map "mo:core/Map";
import CapabilityTypes "../capabilities/Types";

module {
    public type Feature = { #camera; #microphone };
    public type Declaration = {
        entrypoint : Text;
        features : [Feature];
        max_duration_seconds : Nat;
    };
    public type AppDeclaration = {
        app_scope : CapabilityTypes.AppScope;
        media_sessions : ?Declaration;
    };
    public type LeaseState = { #active; #revoked; #expired };
    public type Lease = {
        session_id : Text;
        scope : CapabilityTypes.AppScope;
        app_version : Nat;
        plan_fingerprint : Text;
        request_id : Text;
        origin_nonce : Text;
        features : [Feature];
        created_at : Nat64;
        expires_at : Nat64;
        authority_epoch : Nat64;
        state : LeaseState;
    };
    public type Memory = {
        var next_session_id : Nat64;
        var authority_epoch : Nat64;
        var active_session_id : ?Text;
        leases : Map.Map<Text, Lease>;
    };
    public type BeginInput = {
        app_id : Text;
        request_id : Text;
        features : [Feature];
        duration_seconds : Nat;
    };
    public type LeaseView = {
        session_id : Text;
        app_id : Text;
        installation_uid : Nat64;
        app_version : Nat;
        plan_fingerprint : Text;
        origin_nonce : Text;
        entrypoint : Text;
        features : [Feature];
        created_at : Nat64;
        expires_at : Nat64;
        authority_epoch : Nat64;
    };
    public type BeginError = {
        #invalid_request;
        #undeclared;
        #disabled;
        #busy;
        #randomness_failed;
        #asset_unavailable;
    };
    public type BeginResult = { #ok : LeaseView; #err : BeginError };
    public type CloseResult = { #ok; #not_found; #denied };
    public type AdapterResult = { #ok : Blob; #err };
    public type Adapter = { random : () -> async AdapterResult };
}
