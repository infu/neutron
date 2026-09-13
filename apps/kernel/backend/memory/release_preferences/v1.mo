// Persistent schema: keep this file immutable after release.
module {
    public type Mem = {
        var beta_enabled : Bool;
        var revision : Nat;
    };

    public func init() : Mem {
        {
            var beta_enabled = false;
            var revision = 0;
        };
    };
};
