import Map "59d991367413199580f31df1021c41cd6aafb1ad1580824a58e45ca6e5d1f9f2";
module {
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
    public type Quote = {
        pool : Text;
        quote_address : Text;
        quote_symbol : Text;
        fee_tier : Nat;
        liquidity : Nat;
        via_icp : Bool;
        price_usd : Float;
        price_icp : Float;
        at : Int;
    };
    public type Sample = {
        t : Int;
        price_usd : Float;
        price_icp : Float;
    };
    public type Mem = {
        watchlist : Map.Map<Text, WatchEntry>;
        history : Map.Map<Text, [Sample]>;
        quotes : Map.Map<Text, Quote>;
        decimals : Map.Map<Text, Nat>;
        var last_refresh_at : Int;
        var last_refresh_error : ?Text;
        var refresh_count : Nat;
        var history_limit : Nat;
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
