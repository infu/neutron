// Persistent schema: keep this file immutable after release. Package imports are
// allowed; relative imports are forbidden so app-local types cannot drift.
//
// The Taggr account *is* an Ed25519 key: Taggr identifies users by caller
// principal, so whatever signs the calls owns the account. Holding that key
// only in a browser origin meant clearing site data destroyed the account —
// Taggr's own principal-change flow needs the old key to authorise a move. So
// the key lives here, in this app's own stable memory, and the browser keeps a
// cache of it rather than the original.
//
// `secret_key` is the raw 32-byte Ed25519 seed. The public key and the
// principal are derived from it, so there is nothing else to keep.

module {
    public type Mem = {
        // The 32-byte Ed25519 secret key, or null before first use.
        var secret_key : ?Blob;
        // The deployment and hostname this installation reads under, so a
        // restored browser comes back to the same view and not just the same
        // account. A null domain follows the deployment's canonical domain.
        var canister_id : ?Text;
        var domain : ?Text;
        var created_at : Int;
        var updated_at : Int;
        // Changes on every write, so a caller can tell one apart from a retry.
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
