// Persistent schema: keep this file immutable after release. Package imports are
// allowed; relative imports are forbidden so app-local types cannot drift.
import Map "mo:core/Map";

module {
    public type Action = {
        id : Text;
        input_json : Text;
        summary : Text;
        state_json : Text;
        phase : Text;
        revision : Nat;
        created_at : Int;
        updated_at : Int;
    };

    public type PositionRef = {
        chain_id : Nat;
        protocol : Text;
        token_id : Text;
    };

    public type Mem = {
        actions : Map.Map<Text, Action>;
        positions : Map.Map<Text, PositionRef>;
    };

    public func init() : Mem {
        {
            actions = Map.empty<Text, Action>();
            positions = Map.empty<Text, PositionRef>();
        };
    };
};
