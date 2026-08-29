// Persistent schema: keep this file immutable after release. Package imports are
// allowed; relative imports are forbidden so app-local types cannot drift.
import Map "mo:core/Map";

module {
    public type Script = {
        id : Nat64;
        revision : Nat64;
        name : Text;
        description : ?Text;
        // Exact UTF-8 JavaScript bytes use a Candid blob sidecar instead of the
        // private self-call JSON metadata budget.
        source_utf8 : Blob;
        source_sha256 : Blob;
        source_bytes : Nat32;
        created_at_ns : Nat64;
        updated_at_ns : Nat64;
    };

    public type Mem = {
        var next_script_id : Nat64;
        var library_revision : Nat64;
        var total_source_bytes : Nat64;
        scripts : Map.Map<Nat64, Script>;
    };

    public func init() : Mem {
        {
            var next_script_id = 1;
            var library_revision = 0;
            var total_source_bytes = 0;
            scripts = Map.empty<Nat64, Script>();
        };
    };
};
