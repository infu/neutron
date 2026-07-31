import Caps "mo:neutron-capabilities";
import CapabilityTypes "../capabilities/Types";

module {
    public type Declaration = {};

    public type AppDeclaration = {
        app_scope : CapabilityTypes.AppScope;
        randomness : ?Declaration;
    };

    public type Error = Caps.RandomnessErrorV1;
    public type Result = Caps.RandomnessResultV1;

    // One call returns exactly one fresh 256-bit consensus entropy value.
    // Apps can expand that seed locally when they need many random draws.
    public type Capability = Caps.RandomnessV1;

    public type AdapterResult = {
        #ok : Blob;
        #err;
    };

    public type Adapter = {
        random : () -> async AdapterResult;
        cycle_balance : () -> Nat;
    };
};
