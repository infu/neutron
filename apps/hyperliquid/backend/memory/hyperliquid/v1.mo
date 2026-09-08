// Persistent funding and public trading-key lifecycle journal. Browser trading
// secrets stay in the resident surface; never write raw private keys here.
// Keep this module immutable after its first release.
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
    public type Mem = { operations : Map.Map<Text, Operation> };
    public func init() : Mem = { operations = Map.empty() };
};
