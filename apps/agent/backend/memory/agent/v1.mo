// Persistent schema: keep this file immutable after release. Package imports are
// allowed; relative imports are forbidden so app-local types cannot drift.
module {
    public type Mem = { var installed : Bool };

    public func init() : Mem {
        { var installed = true };
    };
};
