// Persistent schema v1: immutable after its first production release.
import Map "mo:core/Map";
module {
    public type AppScope = { app_id : Text; installation_uid : Nat64 };
    public type Call = { canister : Principal; method : Text; args : Blob; cycles : Nat };
    public type Request = { id : Blob; app_scope : AppScope; call : Call; allow_partial : Bool };
    public type Error = { code : Text; message : Text };
    public type Result = { #ok : Blob; #err : Error };
    public type Receipt = {
        request : Request;
        sequence : Nat;
        created_at : Nat64;
        updated_at : Nat64;
        dispatched : Bool;
        actual_cycles : Nat;
        result : ?Result;
        charged_cycles : ?Nat;
    };
    public type ScopeReceipts = {
        by_id : Map.Map<Blob, Receipt>;
        by_sequence : Map.Map<Nat, Blob>;
    };
    public type Mem = {
        var next_sequence : Nat;
        by_scope : Map.Map<Text, ScopeReceipts>;
    };
    public func init() : Mem { { var next_sequence = 1; by_scope = Map.empty<Text, ScopeReceipts>() } };
};
