// Persistent schema. Keep this module immutable after its first release.
import Map "mo:core/Map";

module {
    public type Operation = {
        id : Text;
        root_id : Text;
        input_json : Text;
        summary : Text;
        state_json : Text;
        phase : Text;
        revision : Nat;
        created_at : Int;
        updated_at : Int;
    };
    public type Pool = { chain_id : Nat; address : Text; family : Text };
    public type Mem = {
        operations : Map.Map<Text, Operation>;
        pools : Map.Map<Text, Pool>;
    };
    public func init() : Mem = { operations = Map.empty(); pools = Map.empty() };
};
