// Persistent schema: keep this file immutable after release. Package imports are
// allowed; relative imports are forbidden so app-local types cannot drift.
import Map "mo:core/Map";

module {
    public type Swap = {
        id : Text;
        account_id : Text;
        chain_id : Nat;
        recipient : Text;
        quote_json : Text;
        approval_request_id : ?Text;
        approval_request_json : ?Text;
        swap_request_id : Text;
        swap_request_json : Text;
        approval_operation_json : ?Text;
        swap_operation_json : ?Text;
        phase : Text;
        revision : Nat;
        created_at : Int;
        updated_at : Int;
    };

    public type Mem = {
        swaps : Map.Map<Text, Swap>;
    };

    public func init() : Mem {
        { swaps = Map.empty<Text, Swap>() };
    };
};
