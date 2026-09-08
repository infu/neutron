/// Motoko mirrors of the live ICPSwap Candid types, plus the app-facing records
/// this backend returns to its own frontend.
///
/// Every upstream record is decoded from a raw reply blob with `from_candid`,
/// so field names and types must match the deployed Candid exactly. Candid
/// record subtyping lets us omit upstream fields we never use; it does not let
/// us rename or retype one, and a mismatch decodes as `null` rather than
/// trapping.
///
/// Verified against mainnet on 2026-08-31:
///   SwapFactory 4mmnk-kiaaa-aaaag-qbllq-cai  getPools
///   SwapPool    (per pool, dynamic)          metadata
///   TokenList   k37c6-riaaa-aaaag-qcyza-cai  getList
///   token ledgers (dynamic)                  icrc1_decimals
///
/// The historical analytics tier (NodeIndex, BaseIndex, GlobalIndex and every
/// Storage canister) is stopped on mainnet, and PriceIndex — while still
/// running — has been frozen since 2025-06-12: it reports ICP at $13.05 against
/// a real $2.40. Neither is used here. Prices come from live pool state.
module {

    // ------------------------------------------------------------ SwapFactory

    public type TokenRef = {
        address : Text;
        standard : Text;
    };

    /// `PoolData` from `SwapFactory.getPools`. `canisterId` is a principal
    /// here, unlike every other ICPSwap id, which is text.
    public type PoolData = {
        canisterId : Principal;
        fee : Nat;
        key : Text;
        tickSpacing : Int;
        token0 : TokenRef;
        token1 : TokenRef;
    };

    public type SwapError = {
        #CommonError;
        #InsufficientFunds;
        #InternalError : Text;
        #UnsupportedToken : Text;
    };

    /// `getPools : () -> (variant { ok : vec PoolData; err : Error }) query`
    public type PoolsResult = {
        #ok : [PoolData];
        #err : SwapError;
    };

    // --------------------------------------------------------------- SwapPool

    /// `PoolMetadata` from `SwapPool.metadata`. `maxLiquidityPerTick` and
    /// `nextPositionId` are deliberately omitted: Candid record subtyping drops
    /// them on decode and this app has no use for them.
    public type PoolMetadata = {
        fee : Nat;
        key : Text;
        liquidity : Nat;
        sqrtPriceX96 : Nat;
        tick : Int;
        token0 : TokenRef;
        token1 : TokenRef;
    };

    /// `metadata : () -> (variant { ok : PoolMetadata; err : Error }) query`
    public type PoolMetadataResult = {
        #ok : PoolMetadata;
        #err : SwapError;
    };

    // -------------------------------------------------------------- TokenList

    public type MediaLink = {
        link : Text;
        mediaType : Text;
    };

    /// `TokenMetadata` from the curated on-chain token list. `configs` is
    /// deliberately omitted: it is unused here and dropping it keeps decoding
    /// and the self-call budget smaller.
    public type TokenListEntry = {
        canisterId : Text;
        symbol : Text;
        name : Text;
        decimals : Nat;
        standard : Text;
        fee : Nat;
        totalSupply : Nat;
        introduction : Text;
        mediaLinks : [MediaLink];
        rank : Nat32;
    };

    /// `getList : () -> (variant { ok : vec TokenMetadata; err : text }) query`
    public type TokenListResult = {
        #ok : [TokenListEntry];
        #err : Text;
    };

    // ------------------------------------------------------------ swap wire

    /// `getPool : (GetPoolArgs) -> (variant { ok : PoolData; err : Error }) query`
    public type GetPoolArgs = {
        fee : Nat;
        token0 : TokenRef;
        token1 : TokenRef;
    };

    public type PoolDataResult = {
        #ok : PoolData;
        #err : SwapError;
    };

    /// `quote : (SwapArgs) -> (variant { ok : nat; err : Error }) query`
    /// Amounts cross the wire as decimal text, not as `nat`.
    public type SwapArgs = {
        zeroForOne : Bool;
        amountIn : Text;
        amountOutMinimum : Text;
    };

    /// `depositFromAndSwap : (DepositAndSwapArgs) -> (variant { ok : nat; err : Error })`
    public type DepositAndSwapArgs = {
        zeroForOne : Bool;
        tokenInFee : Nat;
        tokenOutFee : Nat;
        amountIn : Text;
        amountOutMinimum : Text;
    };

    public type NatResult = {
        #ok : Nat;
        #err : SwapError;
    };

    /// `getCachedTokenFee : () -> (record { token0Fee : nat; token1Fee : nat }) query`
    /// The values `depositFromAndSwap` validates our fees against.
    public type CachedTokenFee = {
        token0Fee : Nat;
        token1Fee : Nat;
    };

    /// `getAvailabilityState : () -> (record { available : bool; whiteList : vec principal }) query`
    public type AvailabilityState = {
        available : Bool;
        whiteList : [Principal];
    };

    public type AvailabilityResult = {
        #ok : AvailabilityState;
        #err : SwapError;
    };

    /// `getUserUnusedBalance : (principal) -> (variant { ok : record { balance0 : nat; balance1 : nat }; err : Error }) query`
    public type UnusedBalance = {
        balance0 : Nat;
        balance1 : Nat;
    };

    public type UnusedBalanceResult = {
        #ok : UnusedBalance;
        #err : SwapError;
    };

    /// `withdraw : (record { token : text; fee : nat; amount : nat }) -> (variant { ok : nat; err : Error })`
    public type WithdrawArgs = {
        token : Text;
        fee : Nat;
        amount : Nat;
    };

    // ------------------------------------------------------------- ICRC wire

    public type IcrcAccount = {
        owner : Principal;
        subaccount : ?Blob;
    };

    /// `icrc2_allowance : (record { account : Account; spender : Account }) -> (record { allowance : nat; expires_at : opt nat64 }) query`
    public type AllowanceArgs = {
        account : IcrcAccount;
        spender : IcrcAccount;
    };

    public type Allowance = {
        allowance : Nat;
        expires_at : ?Nat64;
    };

    // --------------------------------------------------------- app-facing API

    public type Result<T> = {
        #ok : T;
        #err : Text;
    };

    /// Where an on-chain price came from, so the UI and agent tools can say so.
    public type QuoteSource = {
        pool : Text;
        quote_address : Text;
        quote_symbol : Text;
        fee_tier : Nat;
        liquidity : Nat;
        /// True when the pool quotes the token against ICP and the USD figure
        /// was obtained by multiplying through the ICP reference price.
        via_icp : Bool;
    };

    /// Project links and verified metadata for one token, present only for the
    /// tokens carried by the on-chain curated list.
    public type TokenProfile = {
        address : Text;
        symbol : Text;
        name : Text;
        standard : Text;
        decimals : Nat;
        fee : Nat;
        total_supply : Nat;
        introduction : Text;
        links : [MediaLink];
        rank : Nat32;
    };

    /// One watchlist row as the backend can see it: an on-chain spot price
    /// derived from live pool state, merged with the owner's watch entry and
    /// locally recorded history. The frontend overlays richer REST analytics.
    public type MarketRow = {
        address : Text;
        symbol : Text;
        name : Text;
        standard : Text;
        decimals : Nat;
        price_usd : Float;
        price_icp : Float;
        quote : ?QuoteSource;
        pool_count : Nat;
        pinned : Bool;
        note : Text;
        added_at : Int;
        verified : Bool;
        sample_count : Nat;
        sparkline : [Float];
    };

    /// One candidate row in the on-chain fallback search.
    public type TokenCandidate = {
        address : Text;
        symbol : Text;
        name : Text;
        standard : Text;
        decimals : Nat;
        pool_count : Nat;
        verified : Bool;
        watched : Bool;
    };

    public type SearchPage = {
        items : [TokenCandidate];
        total : Nat;
        offset : Nat;
        universe : Nat;
        cache_age_seconds : Int;
    };

    public type MarketStatus = {
        last_refresh_at : Int;
        last_refresh_error : ?Text;
        refresh_count : Nat;
        universe_tokens : Nat;
        universe_pools : Nat;
        verified_tokens : Nat;
        icp_price_usd : Float;
        priced_tokens : Nat;
        pending_decimals : Nat;
        cache_age_seconds : Int;
        cache_ready : Bool;
        watchlist_size : Nat;
        history_limit : Nat;
    };

    public type MarketSnapshot = {
        rows : [MarketRow];
        status : MarketStatus;
    };

    public type PoolRow = {
        pool : Text;
        fee_tier : Nat;
        token0_id : Text;
        token0_symbol : Text;
        token1_id : Text;
        token1_symbol : Text;
    };

    /// Mirrors the persisted sample shape so the frontend and the agent tools
    /// see exactly one history record type.
    public type Sample = {
        t : Int;
        price_usd : Float;
        price_icp : Float;
    };

    public type TokenDetail = {
        row : MarketRow;
        profile : ?TokenProfile;
        pools : [PoolRow];
        pool_count : Nat;
        history : [Sample];
        status : MarketStatus;
    };

    public type HistoryPage = {
        address : Text;
        samples : [Sample];
        total : Nat;
        history_limit : Nat;
    };

    public type RefreshReport = {
        refreshed : Bool;
        pools : Nat;
        verified : Nat;
        priced : Nat;
        decimals_resolved : Nat;
        recorded : Nat;
        calls_used : Nat;
        errors : [Text];
        status : MarketStatus;
    };

    public type WatchlistReport = {
        ok : Bool;
        message : Text;
        watchlist_size : Nat;
    };
};
