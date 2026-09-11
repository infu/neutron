// Persistent operation journal. Keep this released schema immutable.
// This root is independent of the original snsgov v1 configuration and drafts.
import Map "mo:core/Map";

module {
    public type StepStatus = {
        #prepared;
        #dispatching;
        #replied : Blob;
        #unknown : Text;
    };

    public type Step = {
        step_id : Text;
        method : Text;
        args : Blob;
        var status : StepStatus;
        var attempted_at_seconds : ?Nat64;
        var finished_at_seconds : ?Nat64;
    };

    public type Operation = {
        operation_id : Text;
        kind : Text;
        title : Text;
        seq : Nat;
        sns : Principal;
        governance : Principal;
        input_json : Text;
        review_json : Text;
        initiator : Text;
        // Duplicate preparation compares the original value, even after a
        // Wallet receipt or other orchestration evidence has been recorded.
        initial_state_json : Text;
        var state_json : Text;
        var revision : Nat;
        steps : [Step];
        created_at_seconds : Nat64;
        var updated_at_seconds : Nat64;
    };

    public type Mem = {
        operations : Map.Map<Text, Operation>;
        sequence : Map.Map<Nat, Text>;
        var next_seq : Nat;
    };

    public func init() : Mem {
        {
            operations = Map.empty<Text, Operation>();
            sequence = Map.empty<Nat, Text>();
            var next_seq = 0;
        };
    };
};
