// Persistent schema: keep this file immutable after release. Package imports are
// allowed; relative imports are forbidden so app-local types cannot drift.
import Map "mo:core/Map";

module {

    /// One token the owner has chosen to watch. Identity is the token ledger
    /// canister id, kept as text because ICPSwap addresses tokens by text
    /// everywhere except the pool registry.
    public type WatchEntry = {
        address : Text;
        symbol : Text;
        name : Text;
        standard : Text;
        decimals : Nat;
        added_at : Int;
        pinned : Bool;
        note : Text;
    };

    /// The last on-chain spot price this Neutron derived for a token, together
    /// with the pool it came from. Recording the source matters: a price quoted
    /// through ICP carries that pair's error too, and a thin pool is a weaker
    /// quote than a deep one.
    public type Quote = {
        /// Pool key, `<token0>_<token1>_<fee>`.
        pool : Text;
        quote_address : Text;
        quote_symbol : Text;
        fee_tier : Nat;
        liquidity : Nat;
        via_icp : Bool;
        price_usd : Float;
        price_icp : Float;
        /// Seconds since epoch when this quote was read.
        at : Int;
    };

    /// One market sample this Neutron recorded for itself from live pool state.
    /// Keeping our own series means charts and agent tools still have history
    /// when an upstream analytics service prunes, freezes, or disappears.
    public type Sample = {
        /// Seconds since epoch.
        t : Int;
        price_usd : Float;
        price_icp : Float;
    };

    public type Mem = {
        /// Watched tokens keyed by ledger canister id text.
        watchlist : Map.Map<Text, WatchEntry>;
        /// Bounded, oldest-first local history keyed by ledger canister id.
        history : Map.Map<Text, [Sample]>;
        /// Latest derived on-chain quote per token.
        quotes : Map.Map<Text, Quote>;
        /// Ledger decimals read from the token itself. Decimals never change,
        /// so a resolved entry is kept forever and never re-fetched.
        decimals : Map.Map<Text, Nat>;
        /// Seconds since epoch of the last successful upstream refresh.
        var last_refresh_at : Int;
        /// Last refresh failure text, cleared by the next full success.
        var last_refresh_error : ?Text;
        /// Count of successful refreshes since install.
        var refresh_count : Nat;
        /// Maximum samples retained per token.
        var history_limit : Nat;
        /// Last derived USD price of one ICP, from the ICP/ckUSDC pool.
        var icp_price_usd : Float;
    };

    public func init() : Mem {
        {
            watchlist = Map.empty<Text, WatchEntry>();
            history = Map.empty<Text, [Sample]>();
            quotes = Map.empty<Text, Quote>();
            decimals = Map.empty<Text, Nat>();
            var last_refresh_at = 0;
            var last_refresh_error = null;
            var refresh_count = 0;
            var history_limit = 720;
            var icp_price_usd = 0.0;
        };
    };
};
