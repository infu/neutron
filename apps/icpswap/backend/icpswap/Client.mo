/// Request builders and reply decoders for the live ICPSwap canisters.
///
/// Every outbound message goes through the kernel-owned `backend_calls` broker,
/// so this module only shapes Candid argument blobs and validates replies. It
/// holds no capability handle, no cycles primitive, and no actor reference.
///
/// Price comes from live pool state — `SwapFactory.getPools` to find the pool,
/// `SwapPool.metadata` to read its `sqrtPriceX96` — because the ICPSwap
/// analytics tier is stopped and its surviving `PriceIndex` has been frozen
/// since 2025-06-12.
///
/// Every canister named here is an ICPSwap canister. Token ledgers belong to
/// the Wallet: this module has no way to read a balance, a fee, an allowance,
/// or even a token's decimals, let alone move a token. Ledger facts arrive
/// from the Wallet through `icpswap_set_token_info`.
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Types "./Types";
import ProtocolReply "./ProtocolReply";
import NeutronCapabilities "mo:neutron-capabilities";

module {

    public type CallRequest = NeutronCapabilities.BackendCallRequestV1;
    public type CallResult = NeutronCapabilities.BackendCallResultV1;

    /// ICPSwap v3 pool registry.
    public let SWAP_FACTORY : Text = "4mmnk-kiaaa-aaaag-qbllq-cai";

    /// ICPSwap curated token list: verified symbol, decimals, standard, links.
    public let TOKEN_LIST : Text = "k37c6-riaaa-aaaag-qcyza-cai";

    /// Method names called on canisters that are discovered at runtime and so
    /// cannot be named by an exact reservation.
    public let POOL_METADATA_METHOD : Text = "metadata";
    public let POOL_QUOTE_METHOD : Text = "quote";
    public let POOL_CACHED_FEE_METHOD : Text = "getCachedTokenFee";
    public let POOL_AVAILABILITY_METHOD : Text = "getAvailabilityState";
    public let POOL_SWAP_METHOD : Text = "depositFromAndSwap";
    public let POOL_UNUSED_METHOD : Text = "getUserUnusedBalance";

    public func swapFactoryPrincipal() : Principal {
        Principal.fromText(SWAP_FACTORY);
    };

    public func tokenListPrincipal() : Principal {
        Principal.fromText(TOKEN_LIST);
    };

    /// Upper bounds applied to untrusted upstream replies so one hostile or
    /// broken canister cannot exhaust this Neutron's memory.
    public let MAX_POOLS : Nat = 16_000;
    public let MAX_VERIFIED : Nat = 2_000;

    func failure(context : Text, result : CallResult) : ?Text {
        switch (result) {
            case (#err(error)) ?(context # ": " # error.code # ": " # error.message);
            case (#ok(_)) null;
        };
    };

    func bytesOf(result : CallResult) : ?Blob {
        switch (result) {
            case (#ok(bytes)) ?bytes;
            case (#err(_)) null;
        };
    };

    func describeSwapError(error : Types.SwapError) : Text {
        switch (error) {
            case (#CommonError) "common error";
            case (#InsufficientFunds) "insufficient funds";
            case (#InternalError(message)) "internal error: " # message;
            case (#UnsupportedToken(message)) "unsupported token: " # message;
        };
    };

    // ----------------------------------------------------------- pool registry

    public func poolsRequest(factory : Principal) : CallRequest {
        {
            canister = factory;
            method = "getPools";
            args = to_candid ();
            cycles = 0;
        };
    };

    public func decodePools(result : CallResult) : Types.Result<[Types.PoolData]> {
        switch (failure("pool registry", result)) {
            case (?message) return #err(message);
            case null {};
        };
        let bytes = switch (bytesOf(result)) {
            case (?value) value;
            case null return #err("pool registry: empty reply");
        };
        let decoded : ?Types.PoolsResult = from_candid bytes;
        switch (decoded) {
            case null #err("pool registry: unexpected reply shape");
            case (?(#err(error))) #err("pool registry: " # describeSwapError(error));
            case (?(#ok(pools))) {
                if (pools.size() > MAX_POOLS) {
                    #err("pool registry: upstream returned too many pools");
                } else #ok(pools);
            };
        };
    };

    // -------------------------------------------------------------- pool state

    public func poolMetadataRequest(pool : Principal) : CallRequest {
        {
            canister = pool;
            method = POOL_METADATA_METHOD;
            args = to_candid ();
            cycles = 0;
        };
    };

    public func decodePoolMetadata(
        result : CallResult
    ) : Types.Result<Types.PoolMetadata> {
        switch (failure("pool state", result)) {
            case (?message) return #err(message);
            case null {};
        };
        let bytes = switch (bytesOf(result)) {
            case (?value) value;
            case null return #err("pool state: empty reply");
        };
        let decoded : ?Types.PoolMetadataResult = from_candid bytes;
        switch (decoded) {
            case null #err("pool state: unexpected reply shape");
            case (?(#err(error))) #err("pool state: " # describeSwapError(error));
            case (?(#ok(metadata))) #ok(metadata);
        };
    };

    // -------------------------------------------------- curated token list

    public func tokenListRequest(tokenList : Principal) : CallRequest {
        {
            canister = tokenList;
            method = "getList";
            args = to_candid ();
            cycles = 0;
        };
    };

    public func decodeTokenList(
        result : CallResult
    ) : Types.Result<[Types.TokenListEntry]> {
        switch (failure("token list", result)) {
            case (?message) return #err(message);
            case null {};
        };
        let bytes = switch (bytesOf(result)) {
            case (?value) value;
            case null return #err("token list: empty reply");
        };
        let decoded : ?Types.TokenListResult = from_candid bytes;
        switch (decoded) {
            case null #err("token list: unexpected reply shape");
            case (?(#err(message))) #err("token list: " # message);
            case (?(#ok(entries))) {
                if (entries.size() > MAX_VERIFIED) {
                    #err("token list: upstream returned too many entries");
                } else #ok(entries);
            };
        };
    };

    // ------------------------------------------------------------------ swap

    /// Resolve one pool by pair and fee tier.
    ///
    /// The factory keys on the sorted addresses, so argument order and the
    /// declared standards do not matter; it echoes back the canonical
    /// `token0`/`token1` with their true standards, which is what the swap
    /// direction must be derived from.
    public func poolForPairRequest(
        factory : Principal,
        token0 : Text,
        token1 : Text,
        fee : Nat,
    ) : CallRequest {
        let args : Types.GetPoolArgs = {
            fee;
            token0 = { address = token0; standard = "ICRC2" };
            token1 = { address = token1; standard = "ICRC2" };
        };
        {
            canister = factory;
            method = "getPool";
            args = to_candid (args);
            cycles = 0;
        };
    };

    public func decodePoolForPair(result : CallResult) : Types.Result<Types.PoolData> {
        switch (failure("pool lookup", result)) {
            case (?message) return #err(message);
            case null {};
        };
        let bytes = switch (bytesOf(result)) {
            case (?value) value;
            case null return #err("pool lookup: empty reply");
        };
        let decoded : ?Types.PoolDataResult = from_candid bytes;
        switch (decoded) {
            case null #err("pool lookup: unexpected reply shape");
            case (?(#err(error))) #err("pool lookup: " # describeSwapError(error));
            case (?(#ok(pool))) #ok(pool);
        };
    };

    /// Price a swap. A cheap query on the pool, but note three behaviours the
    /// caller must handle rather than this decoder: dust returns `ok 0`, an
    /// oversized amount exceeds the query instruction limit and rejects, and
    /// `amountOutMinimum` is ignored entirely.
    public func quoteRequest(
        pool : Principal,
        zeroForOne : Bool,
        amountIn : Nat,
    ) : CallRequest {
        let args : Types.SwapArgs = {
            zeroForOne;
            amountIn = Nat.toText(amountIn);
            amountOutMinimum = "0";
        };
        {
            canister = pool;
            method = POOL_QUOTE_METHOD;
            args = to_candid (args);
            cycles = 0;
        };
    };

    public func decodeQuote(result : CallResult) : Types.Result<Nat> {
        decodeNatResult("quote", result);
    };

    /// The pool's cached ledger fees — the values `depositFromAndSwap`
    /// validates our arguments against.
    public func cachedTokenFeeRequest(pool : Principal) : CallRequest {
        {
            canister = pool;
            method = POOL_CACHED_FEE_METHOD;
            args = to_candid ();
            cycles = 0;
        };
    };

    public func decodeCachedTokenFee(
        result : CallResult
    ) : Types.Result<Types.CachedTokenFee> {
        switch (failure("pool fee cache", result)) {
            case (?message) return #err(message);
            case null {};
        };
        let bytes = switch (bytesOf(result)) {
            case (?value) value;
            case null return #err("pool fee cache: empty reply");
        };
        let decoded : ?Types.CachedTokenFee = from_candid bytes;
        switch (decoded) {
            case null #err("pool fee cache: unexpected reply shape");
            case (?fees) #ok(fees);
        };
    };

    /// Whether the pool is open to us at all. A closed or whitelisted pool
    /// must be reported before a swap is offered, not after it fails.
    public func availabilityRequest(pool : Principal) : CallRequest {
        {
            canister = pool;
            method = POOL_AVAILABILITY_METHOD;
            args = to_candid ();
            cycles = 0;
        };
    };

    public func decodeAvailability(
        result : CallResult
    ) : Types.Result<Types.AvailabilityState> {
        switch (failure("pool availability", result)) {
            case (?message) return #err(message);
            case null {};
        };
        let bytes = switch (bytesOf(result)) {
            case (?value) value;
            case null return #err("pool availability: empty reply");
        };
        let direct : ?Types.AvailabilityState = from_candid bytes;
        switch (direct) {
            case (?state) return #ok(state);
            case null {};
        };
        let wrapped : ?Types.AvailabilityResult = from_candid bytes;
        switch (wrapped) {
            case null #err("pool availability: unexpected reply shape");
            case (?(#err(error))) {
                #err("pool availability: " # describeSwapError(error));
            };
            case (?(#ok(state))) #ok(state);
        };
    };

    /// Deposit, swap and enqueue the withdrawal in one call.
    ///
    /// The fees are not advisory: the pool rejects unless they equal its own
    /// cache, and then hands the same numbers to the ledger, which rejects a
    /// mismatch of its own. They must agree with both.
    public func depositFromAndSwapRequest(
        pool : Principal,
        zeroForOne : Bool,
        amountIn : Nat,
        amountOutMinimum : Nat,
        tokenInFee : Nat,
        tokenOutFee : Nat,
    ) : CallRequest {
        let args : Types.DepositAndSwapArgs = {
            zeroForOne;
            tokenInFee;
            tokenOutFee;
            amountIn = Nat.toText(amountIn);
            amountOutMinimum = Nat.toText(amountOutMinimum);
        };
        {
            canister = pool;
            method = POOL_SWAP_METHOD;
            args = to_candid (args);
            cycles = 0;
        };
    };

    /// The swap amount, gross of the output ledger fee that the withdrawal
    /// then pays.
    public func decodeSwap(result : CallResult) : Types.Result<Nat> {
        decodeNatResult("swap", result);
    };

    // ------------------------------------------------------------- recovery

    public func unusedBalanceRequest(
        pool : Principal,
        account : Principal,
    ) : CallRequest {
        {
            canister = pool;
            method = POOL_UNUSED_METHOD;
            args = to_candid (account);
            cycles = 0;
        };
    };

    public func decodeUnusedBalance(
        result : CallResult
    ) : Types.Result<Types.UnusedBalance> {
        switch (failure("unused balance", result)) {
            case (?message) return #err(message);
            case null {};
        };
        let bytes = switch (bytesOf(result)) {
            case (?value) value;
            case null return #err("unused balance: empty reply");
        };
        let decoded : ?Types.UnusedBalanceResult = from_candid bytes;
        switch (decoded) {
            case null #err("unused balance: unexpected reply shape");
            case (?(#err(error))) #err("unused balance: " # describeSwapError(error));
            case (?(#ok(balance))) #ok(balance);
        };
    };

    // --------------------------------------------------------------- shared

    func decodeNatResult(context : Text, result : CallResult) : Types.Result<Nat> {
        switch (failure(context, result)) {
            case (?message) return #err(message);
            case null {};
        };
        let bytes = switch (bytesOf(result)) {
            case (?value) value;
            case null return #err(context # ": empty reply");
        };
        switch (ProtocolReply.decodeNat(bytes)) {
            case (#unknown(message)) #err(context # ": " # message);
            case (#rejected(message)) #err(context # ": " # message);
            case (#ok(value)) #ok(value);
        };
    };

}
