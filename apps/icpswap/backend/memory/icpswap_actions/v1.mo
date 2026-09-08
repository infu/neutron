// New persistent root. Once released, this module is immutable history.
import Map "mo:core/Map";
module {
    public type Effect = {
        key : Text;
        canister : Principal;
        method : Text;
        args : Blob;
        state : Text;
        reply : ?Blob;
        error : Text;
        dispatched_at : Int;
        completed_at : ?Int;
    };
    public type Operation = {
        id : Text;
        input_json : Text;
        plan_json : Text;
        plan_blob : Blob;
        funding_json : Text;
        state : Text;
        detail : Text;
        result_json : Text;
        revision : Nat;
        created_at : Int;
        updated_at : Int;
        effects : [Effect];
    };
    public type Mem = { operations : Map.Map<Text, Operation> };
    public func init() : Mem = { operations = Map.empty() };
};
