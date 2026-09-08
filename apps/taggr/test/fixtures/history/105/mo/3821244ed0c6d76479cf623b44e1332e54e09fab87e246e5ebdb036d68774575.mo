module {
    public type Mem = {
        var secret_key : ?Blob;
        var canister_id : ?Text;
        var domain : ?Text;
        var created_at : Int;
        var updated_at : Int;
        var revision : Nat;
    };
    public func init() : Mem {
        {
            var secret_key = null;
            var canister_id = null;
            var domain = null;
            var created_at = 0;
            var updated_at = 0;
            var revision = 0;
        };
    };
};
