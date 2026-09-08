/// ICPSwap app backend: durable market preferences and saved financial intents.
/// Browser market/position reads go directly to public ICPSwap services. Calls
/// that must act as this Neutron use the existing backend_calls capability.
/// The registry and token fee observations are transient; released memory
/// schemas and all unresolved financial operation identities remain durable.
import Array "mo:core/Array";
import Float "mo:core/Float";
import Int "mo:core/Int";
import Iter "mo:core/Iter";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Time "mo:core/Time";
import NeutronCapabilities "mo:neutron-capabilities";
import Client "./icpswap/Client";
import Market "./icpswap/Market";
import Types "./icpswap/Types";
import Memory "./memory/icpswap/v1";
import Swap "./icpswap/Swap";
import SwapMemory "./memory/icpswap_swap/v1";
import Actions "./icpswap/Actions";
import ActionsMemory "./memory/icpswap_actions/v1";
import Liquidity "./icpswap/Liquidity";
import SwapActions "./icpswap/SwapActions";
import ProtocolReply "./icpswap/ProtocolReply";

module {

    public type AppBackendEnvironment = {
        stable_memory : {
            icpswap : Memory.Mem;
            icpswap_swap : SwapMemory.Mem;
            icpswap_actions : ActionsMemory.Mem;
        };
        capabilities : {
            backend_calls : NeutronCapabilities.BackendCallsV1;
        };
    };

    /// Invocation-scoped resources handed to a scheduled callback. This is
    /// deliberately separate from the long-lived backend environment.
    public type TaskCapabilities = {
        backend_calls : NeutronCapabilities.BackendCallsV1;
    };

    // ---------------------------------------------------------- wire types
    //
    // Public app methods must name types this module declares, because the
    // package schema generator resolves `public type` aliases from this file
    // alone. They mirror the app-facing records in `icpswap/Types.mo`; Motoko
    // is structurally typed, so the compiler rejects any drift between the two
    // at the point where a value crosses from `Market` into a method result.

    public type ActionEffectView = {
        key : Text; canister : Text; method : Text; state : Text;
        error : Text; dispatched_at : Int; completed_at : ?Int;
        result_nat : ?Nat; result_amount0 : ?Nat; result_amount1 : ?Nat;
    };
    public type ActionOperation = {
        id : Text; input_json : Text; plan_json : Text; funding_json : Text;
        state : Text; detail : Text; result_json : Text; revision : Nat;
        created_at : Int; updated_at : Int; effects : [ActionEffectView];
    };
    public type ActionBeginRequest = {
        id : Text; input_json : Text; plan_json : Text; funding_json : Text;
    };
    public type ActionUpdateRequest = {
        id : Text; expected_revision : Nat; state : Text; detail : Text;
        result_json : Text; funding_json : Text;
    };

    public type ActionResult = { #ok : ActionOperation; #err : Text };
    public type LiquidityTokenRef = { address : Text; standard : Text };
    public type LiquidityPoolData = { canisterId : Principal; fee : Nat; key : Text; tickSpacing : Int; token0 : LiquidityTokenRef; token1 : LiquidityTokenRef };
    public type LiquidityRequest = {
        pool : Text; kind : Text; position_id : ?Nat; tick_lower : Int; tick_upper : Int;
        amount0 : Nat; amount1 : Nat; liquidity : Nat; withdraw_token : Text; withdraw_amount : Nat;
    };
    public type LiquidityPosition = {
        id : Nat; tick_lower : Int; tick_upper : Int; liquidity : Nat;
        amount0 : Nat; amount1 : Nat; fees0 : Nat; fees1 : Nat;
        fees_current : Bool; error : Text;
    };
    public type LiquidityQueueItem = {
        transaction_id : Nat; token : Text; amount : Nat; fee : Nat; recipient : Text;
    };
    public type LiquidityTransaction = {
        id : Nat; kind : Text; state : Text; token : ?Text; amount : Nat; error : Text;
        unused_reserved : Bool; support_required : Bool;
    };
    public type LiquidityPoolView = {
        pool : Text; key : Text; owner : Text; token0 : LiquidityTokenRef; token1 : LiquidityTokenRef;
        fee : Nat; tick_spacing : Int; tick : Int; sqrt_price_x96 : Nat; liquidity : Nat;
        fee0 : Nat; fee1 : Nat; available : Bool; unused0 : Nat; unused1 : Nat;
        queued0 : Nat; queued1 : Nat; positions : [LiquidityPosition]; queue : [LiquidityQueueItem];
        reserved0 : Nat; reserved1 : Nat; transactions : [LiquidityTransaction];
        protocol_diagnostics : Text; observed_at : Int;
    };
    public type LiquidityPlan = {
        request : LiquidityRequest; pool : Text; owner : Text; token0 : LiquidityTokenRef; token1 : LiquidityTokenRef;
        fee : Nat; tick_spacing : Int; tick : Int; sqrt_price_x96 : Nat;
        fee0 : Nat; fee1 : Nat; funding0 : Nat; funding1 : Nat;
        expected_amount0 : Nat; expected_amount1 : Nat; expected_liquidity : Nat;
        unused0 : Nat; unused1 : Nat; baseline_positions : [LiquidityPosition]; observed_at : Int;
        price_protection : Bool; detail : Text;
    };
    public type LiquidityPrepareRequest = { id : Text; input_json : Text; request : LiquidityRequest };
    public type LiquidityExecuteRequest = { id : Text; expected_revision : Nat };
    public type LiquidityPrepared = { operation : ActionOperation; plan : LiquidityPlan };
    public type LiquidityReconciliation = { operation : ActionOperation; plan : LiquidityPlan; pool : LiquidityPoolView };

    public type LiquidityPoolViewResult = { #ok : LiquidityPoolView; #err : Text };
    public type LiquidityPlanResult = { #ok : LiquidityPlan; #err : Text };
    public type LiquidityPreparedResult = { #ok : LiquidityPrepared; #err : Text };
    public type LiquidityReconciliationResult = { #ok : LiquidityReconciliation; #err : Text };
    public type LiquidityPoolsResult = { #ok : [LiquidityPoolData]; #err : Text };

    // ------------------------------------------------------------ swap wire

    public type TokenInfoRequest = {
        address : Text;
        decimals : Nat;
        fee : Nat;
    };

    public type SwapQuote = {
        pool : Text;
        pool_key : Text;
        fee_tier : Nat;
        input_address : Text;
        output_address : Text;
        decimals_in : Nat;
        decimals_out : Nat;
        zero_for_one : Bool;
        amount_in : Nat;
        quoted_out : Nat;
        amount_out_minimum : Nat;
        expected_out : Nat;
        token_in_fee : Nat;
        token_out_fee : Nat;
        funding_amount : Nat;
        total_debit : Nat;
        price_impact : Float;
        warn : Bool;
        slippage : Nat;
        funding_ledger : Text;
        funding_spender : Text;
        at : Int;
    };

    public type SwapQuoteResult = {
        #ok : SwapQuote;
        #err : Text;
    };

    public type SwapExecuteRequest = {
        request_id : Text;
        input_address : Text;
        output_address : Text;
        amount_in : Nat;
        slippage : Nat;
    };

    public type ActionEffectSummary = {
        key : Text; canister : Text; method : Text; state : Text; error : Text;
        dispatched_at : Int; completed_at : ?Int;
    };
    public type ActionSummary = {
        id : Text; input_json : Text; state : Text; detail : Text; revision : Nat;
        created_at : Int; updated_at : Int; effects : [ActionEffectSummary];
    };
    public type ActionPageRequest = { cursor : ?Text; limit : Nat };
    public type ActionPage = { items : [ActionSummary]; next_cursor : ?Text };
    public type ActionPageResult = { #ok : ActionPage; #err : Text };

    public type PreparedAction = { #swap : SwapPrepared; #liquidity : LiquidityPrepared; #recovery : RecoveryPrepared };

    public type RecoveryPrepareRequest = { id : Text; input_json : Text; source_id : Text; token_index : Nat };
    public type RecoveryPlan = {
        source_id : Text; token_index : Nat; pool : Text; owner : Text; token : LiquidityTokenRef;
        gross_amount : Nat; fee : Nat; credit_amount : Nat; observed_at : Int;
    };
    public type RecoveryPrepared = { operation : ActionOperation; plan : RecoveryPlan };
    public type RecoveryPreparedResult = { #ok : RecoveryPrepared; #err : Text };

    public type SwapPrepareRequest = { id : Text; input_json : Text; request : SwapExecuteRequest };
    public type SwapActionExecuteRequest = { id : Text; expected_revision : Nat };
    public type SwapPrepared = { operation : ActionOperation; plan : SwapQuote; receipt : ?SwapReceipt };
    public type SwapPreparedResult = { #ok : SwapPrepared; #err : Text };

    public type SwapReceipt = {
        request_id : Text;
        state : Text;
        pool : Text;
        input_address : Text;
        output_address : Text;
        amount_in : Nat;
        amount_out_minimum : Nat;
        swapped_out : Nat;
        received_out : Nat;
        detail : Text;
        needs_funding : Bool;
        funding_ledger : Text;
        funding_spender : Text;
        funding_amount : Nat;
        at : Int;
    };

    public type SwapJournalEntry = {
        request_id : Text;
        pool : Text;
        pool_key : Text;
        input_address : Text;
        output_address : Text;
        input_symbol : Text;
        output_symbol : Text;
        amount_in : Nat;
        amount_out_minimum : Nat;
        quoted_out : Nat;
        swapped_out : Nat;
        token_in_fee : Nat;
        token_out_fee : Nat;
        slippage : Nat;
        state : Text;
        funding_status : Text;
        funding_block : Text;
        detail : Text;
        started_at : Int;
        updated_at : Int;
    };

    public type SwapJournalPage = {
        entries : [SwapJournalEntry];
        total : Nat;
        completed : Nat;
        slippage : Nat;
    };

    public type SwapRecovery = {
        pool : Text;
        unused_input : Nat;
        unused_output : Nat;
        input_balance : Nat;
        output_balance : Nat;
        withdrawn : Nat;
        detail : Text;
    };

    public type SwapRecoveryResult = {
        #ok : SwapRecovery;
        #err : Text;
    };

    public type MediaLink = {
        link : Text;
        mediaType : Text;
    };

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

    public type QuoteSource = {
        pool : Text;
        quote_address : Text;
        quote_symbol : Text;
        fee_tier : Nat;
        liquidity : Nat;
        via_icp : Bool;
    };

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

    public type AddRequest = {
        address : Text;
        symbol : Text;
        name : Text;
        standard : Text;
        decimals : Nat;
    };

    public type MarketRequest = {
        sort : Text;
        ascending : Bool;
    };

    public type SearchRequest = {
        term : Text;
        offset : Nat;
        limit : Nat;
    };

    public type HistoryRequest = {
        address : Text;
        limit : Nat;
    };

    public type NoteRequest = {
        address : Text;
        note : Text;
    };

    public type PinRequest = {
        address : Text;
        pinned : Bool;
    };

    /// A refresh is only rerun on demand when the cache is older than this.
    let MIN_REFRESH_GAP_SECONDS : Int = 30;

    /// Two samples closer together than this replace each other, so manual
    /// refreshes cannot flood the recorded series.
    let MIN_SAMPLE_GAP_SECONDS : Int = 1_800;

    /// Concurrency of one broker batch. The manifest caps this too; keeping the
    /// same number here makes the call budget arithmetic below explicit.
    let BATCH_SIZE : Nat = 20;

    /// Ledger decimal lookups admitted per refresh. Decimals never change, so a
    /// resolved token is never re-read and a large new watchlist simply fills in
    /// over the first few refreshes rather than blowing one call budget.

    public class Init(env : AppBackendEnvironment) {
        let mem = env.stable_memory.icpswap;
        let calls = env.capabilities.backend_calls;
        let actionJournal = Actions.Journal(env.stable_memory.icpswap_actions, Time.now, func(id : Text) : Bool { Map.containsKey(env.stable_memory.icpswap_swap.records, Text.compare, id) });
        let liquidityService = Liquidity.Service(calls, actionJournal, Time.now);
        public func /*update*/icpswap_swap_prepare_v1(request : SwapPrepareRequest) : async* SwapPreparedResult { if (Map.containsKey(env.stable_memory.icpswap_swap.records, Text.compare, request.id)) return #err("This ID is a retained legacy swap. Use legacy swap history and recovery; do not repeat its financial intent."); await* swapService.prepare(request) };
        public func /*update*/icpswap_swap_execute_v1(request : SwapActionExecuteRequest) : async* SwapPreparedResult { if (Map.containsKey(env.stable_memory.icpswap_swap.records, Text.compare, request.id)) return #err("This ID is a retained legacy swap. Use legacy swap history and recovery; do not repeat its financial intent."); await* swapService.execute(request) };

        public func /*update*/icpswap_liquidity_recover_prepare(request : RecoveryPrepareRequest) : async* RecoveryPreparedResult { if (Map.containsKey(env.stable_memory.icpswap_swap.records, Text.compare, request.id)) return #err("This ID is a retained legacy swap. Use legacy swap history and recovery; do not repeat its financial intent."); await* liquidityService.recoveryPrepare(request) };
        public func /*update*/icpswap_liquidity_recover_execute(request : LiquidityExecuteRequest) : async* RecoveryPreparedResult { if (Map.containsKey(env.stable_memory.icpswap_swap.records, Text.compare, request.id)) return #err("This ID is a retained legacy swap. Use legacy swap history and recovery; do not repeat its financial intent."); await* liquidityService.recoveryExecute(request) };
        public func /*query*/icpswap_action_status(id : Text) : ?PreparedAction {
            switch (swapService.status(id)) { case (?value) return ?#swap(value); case null {} };
            switch (liquidityService.status(id)) { case (?value) return ?#liquidity(value); case null {} };
            switch (liquidityService.recoveryStatus(id)) { case (?value) ?#recovery(value); case null null };
        };
        public func /*query*/icpswap_account() : Text { Principal.toText(calls.canister_principal) };
        public func /*query*/icpswap_action_page(request : ActionPageRequest) : ActionPageResult { actionJournal.page(request) };
        public func /*query*/icpswap_action_get(id : Text) : ?ActionOperation { actionJournal.get(id) };
        public func /*update*/icpswap_action_update(request : ActionUpdateRequest) : ActionResult { actionJournal.update(request) };
        public func /*update*/icpswap_liquidity_pool(pool : Text) : async* LiquidityPoolViewResult { await* liquidityService.pool(pool) };
        public func /*update*/icpswap_liquidity_preview(request : LiquidityRequest) : async* LiquidityPlanResult { await* liquidityService.preview(request) };
        public func /*update*/icpswap_liquidity_prepare(request : LiquidityPrepareRequest) : async* LiquidityPreparedResult { if (Map.containsKey(env.stable_memory.icpswap_swap.records, Text.compare, request.id)) return #err("This ID is a retained legacy swap. Use legacy swap history and recovery; do not repeat its financial intent."); await* liquidityService.prepare(request) };
        public func /*update*/icpswap_liquidity_execute(request : LiquidityExecuteRequest) : async* LiquidityPreparedResult { if (Map.containsKey(env.stable_memory.icpswap_swap.records, Text.compare, request.id)) return #err("This ID is a retained legacy swap. Use legacy swap history and recovery; do not repeat its financial intent."); await* liquidityService.execute(request) };
        public func /*update*/icpswap_liquidity_reconcile(id : Text) : async* LiquidityReconciliationResult { await* liquidityService.reconcile(id) };

        // ------------------------------------------------ transient universe

        var universePools : [Types.PoolData] = [];
        var universeVerified : [Types.TokenListEntry] = [];
        var verifiedLookup = Map.empty<Text, Types.TokenListEntry>();
        var poolCountLookup = Map.empty<Text, Nat>();
        var tokenUniverse = Map.empty<Text, Text>();
        var cacheReady = false;
        var cacheFilledAt : Int = 0;

        // ------------------------------------------------------------ helpers

        func nowSeconds() : Int {
            Time.now() / 1_000_000_000;
        };

        func cacheAge(now : Int) : Int {
            Market.secondsSince(cacheFilledAt, now);
        };

        func pendingDecimals() : Nat {
            var pending = 0;
            for (entry in Map.values(mem.watchlist)) {
                if (not Map.containsKey(mem.decimals, Text.compare, entry.address)) {
                    pending += 1;
                };
            };
            pending;
        };

        func status(now : Int) : MarketStatus {
            {
                last_refresh_at = mem.last_refresh_at;
                last_refresh_error = mem.last_refresh_error;
                refresh_count = mem.refresh_count;
                universe_tokens = Map.size(tokenUniverse);
                universe_pools = universePools.size();
                verified_tokens = universeVerified.size();
                icp_price_usd = mem.icp_price_usd;
                priced_tokens = Map.size(mem.quotes);
                pending_decimals = pendingDecimals();
                cache_age_seconds = cacheAge(now);
                cache_ready = cacheReady;
                watchlist_size = Map.size(mem.watchlist);
                history_limit = mem.history_limit;
            };
        };

        func samplesFor(address : Text) : [Memory.Sample] {
            switch (Map.get(mem.history, Text.compare, address)) {
                case (?series) series;
                case null [];
            };
        };

        /// Best known display symbol for any token: the curated list first, then
        /// a watch entry the owner supplied, then a shortened ledger id.
        func symbolFor(address : Text) : Text {
            switch (Map.get(verifiedLookup, Text.compare, address)) {
                case (?entry) if (entry.symbol != "") { return entry.symbol };
                case null {};
            };
            switch (Map.get(mem.watchlist, Text.compare, address)) {
                case (?entry) if (entry.symbol != "") { return entry.symbol };
                case null {};
            };
            Market.clampText(address, 12);
        };

        func rowFor(entry : Memory.WatchEntry) : MarketRow {
            let decimals = switch (Map.get(mem.decimals, Text.compare, entry.address)) {
                case (?value) value;
                case null entry.decimals;
            };
            Market.buildRow({
                entry = { entry with decimals };
                verified = Map.get(verifiedLookup, Text.compare, entry.address);
                quote = Map.get(mem.quotes, Text.compare, entry.address);
                pool_count = Market.lookupNat(poolCountLookup, entry.address);
                samples = samplesFor(entry.address);
            });
        };

        func parseSortKey(value : Text) : Market.SortKey {
            switch (Market.lower(value)) {
                case ("symbol") #symbol;
                case ("pools") #pools;
                case ("added") #added;
                case (_) #price;
            };
        };

        func watchedEntries() : [Memory.WatchEntry] {
            Iter.toArray(Map.values(mem.watchlist));
        };

        func report(ok : Bool, message : Text) : WatchlistReport {
            {
                ok;
                message;
                watchlist_size = Map.size(mem.watchlist);
            };
        };

        /// Reject anything that cannot be a canister id before it reaches
        /// storage. This is display and lookup data, never authority, but a
        /// bounded well-formed key keeps the map and every response predictable.
        func normalizeAddress(value : Text) : ?Text {
            let trimmed = Market.clampText(value, Market.MAX_ADDRESS_CHARS);
            if (trimmed.size() < 5) return null;
            for (character in trimmed.chars()) {
                let ok = (character >= 'a' and character <= 'z') or (character >= '0' and character <= '9') or character == '-';
                if (not ok) return null;
            };
            ?trimmed;
        };

        // ------------------------------------------------------------ refresh

        func rebuildIndexes() {
            verifiedLookup := Market.verifiedIndex(universeVerified);
            poolCountLookup := Market.poolCountIndex(universePools);
            tokenUniverse := Market.tokenUniverse(universePools);
        };

        func decimalsFor(address : Text) : ?Nat {
            switch (Map.get(mem.decimals, Text.compare, address)) {
                case (?value) ?value;
                case null {
                    // The curated list is an acceptable second source: it is
                    // on-chain, and it saves a ledger round trip.
                    switch (Map.get(verifiedLookup, Text.compare, address)) {
                        case (?entry) ?entry.decimals;
                        case null {
                            // The reviewed quote references carry fixed
                            // decimals so the very first refresh can price.
                            switch (Market.quoteTokenFor(address)) {
                                case (?quote) ?quote.decimals;
                                case null null;
                            };
                        };
                    };
                };
            };
        };

        type QuoteTarget = {
            address : Text;
            choice : Market.QuoteChoice;
            base_decimals : Nat;
        };

        /// Build the list of pools to read this refresh. ICP always leads, so
        /// its price is known before any ICP-quoted token is converted.
        func quoteTargets(addresses : [Text]) : [QuoteTarget] {
            let targets = List.empty<QuoteTarget>();
            let seen = Map.empty<Text, Bool>();
            func push(address : Text) {
                if (Map.containsKey(seen, Text.compare, address)) return;
                let ?decimals = decimalsFor(address) else return;
                let ?choice = Market.chooseQuotePool(universePools, address) else return;
                Map.add(seen, Text.compare, address, true);
                List.add(targets, { address; choice; base_decimals = decimals });
            };
            push(Market.ICP_LEDGER);
            for (address in addresses.vals()) push(address);
            List.toArray(targets);
        };

        func recordQuote(
            address : Text,
            derived : Market.DerivedPrice,
            now : Int,
        ) {
            ignore Map.insert(
                mem.quotes,
                Text.compare,
                address,
                {
                    pool = derived.source.pool;
                    quote_address = derived.source.quote_address;
                    quote_symbol = derived.source.quote_symbol;
                    fee_tier = derived.source.fee_tier;
                    liquidity = derived.source.liquidity;
                    via_icp = derived.source.via_icp;
                    price_usd = Market.finiteOrZero(derived.price_usd);
                    price_icp = Market.finiteOrZero(derived.price_icp);
                    at = now;
                },
            );
        };

        /// Append one history sample per watched token quoted in this run.
        func recordSamples(now : Int) : Nat {
            var recorded = 0;
            for (entry in Map.values(mem.watchlist)) {
                switch (Map.get(mem.quotes, Text.compare, entry.address)) {
                    case null {};
                    case (?quote) {
                        if (quote.at == now and quote.price_usd > 0.0) {
                            let sample : Memory.Sample = {
                                t = now;
                                price_usd = quote.price_usd;
                                price_icp = quote.price_icp;
                            };
                            ignore Map.insert(
                                mem.history,
                                Text.compare,
                                entry.address,
                                Market.appendSample(
                                    samplesFor(entry.address),
                                    sample,
                                    mem.history_limit,
                                    MIN_SAMPLE_GAP_SECONDS,
                                ),
                            );
                            recorded += 1;
                        };
                    };
                };
            };
            recorded;
        };

        func failedRefresh(
            now : Int,
            used : Nat,
            errors : [Text],
        ) : RefreshReport {
            {
                refreshed = false;
                pools = universePools.size();
                verified = universeVerified.size();
                priced = 0;
                decimals_resolved = 0;
                recorded = 0;
                calls_used = used;
                errors;
                status = status(now);
            };
        };

        /// One refresh cycle.
        ///
        /// Phase 1 reads the pool registry and the curated token list. Phase 2
        /// resolves any missing ledger decimals. Phase 3 reads the chosen pool
        /// for each watched token and squares its `sqrtPriceX96`. Every phase is
        /// dispatched in concurrent batches and every failure is recorded rather
        /// than trapping, so one bad upstream cannot stall the schedule.
        func refresh(
            backendCalls : NeutronCapabilities.BackendCallsV1,
            now : Int,
            callBudget : Nat,
        ) : async* RefreshReport {
            let errors = List.empty<Text>();
            var used = 0;

            // --- phase 1: registry -------------------------------------------
            let registry = await* backendCalls.call_batch([
                Client.poolsRequest(Client.swapFactoryPrincipal()),
                Client.tokenListRequest(Client.tokenListPrincipal()),
            ]);
            used += 2;
            var registryOk = false;
            if (registry.size() == 2) {
                switch (Client.decodePools(registry[0])) {
                    case (#err(message)) List.add(errors, message);
                    case (#ok(pools)) {
                        universePools := pools;
                        registryOk := true;
                    };
                };
                switch (Client.decodeTokenList(registry[1])) {
                    case (#err(message)) List.add(errors, message);
                    case (#ok(entries)) universeVerified := entries;
                };
            } else {
                List.add(errors, "pool registry: unexpected batch size");
            };
            rebuildIndexes();

            if (not registryOk) {
                let errorList = List.toArray(errors);
                mem.last_refresh_error := ?Market.clampText(
                    Text.join(errorList.vals(), "; "),
                    600,
                );
                return failedRefresh(now, used, errorList);
            };

            // Ledger facts — decimals and fees — come from the Wallet, which
            // owns token ledgers. They are pushed in by `icpswap_set_token_info`
            // and cached forever, because they do not change. A token whose
            // facts have never been pushed simply reports no price rather than
            // one derived from a guessed precision.
            let resolved = 0;

            // --- phase 3: pool state -----------------------------------------
            let watched = Array.map<Memory.WatchEntry, Text>(
                watchedEntries(),
                func(entry) = entry.address,
            );
            let targets = quoteTargets(watched);
            var priced = 0;
            var cursor = 0;
            label pricing while (cursor < targets.size()) {
                if (used >= callBudget) {
                    List.add(errors, "priced tokens truncated by the call budget");
                    break pricing;
                };
                let remaining = Nat.min(BATCH_SIZE, callBudget - used);
                let size = Nat.min(remaining, targets.size() - cursor);
                if (size == 0) break pricing;
                let slice = Array.tabulate<Client.CallRequest>(
                    size,
                    func(index) = Client.poolMetadataRequest(
                        targets[cursor + index].choice.pool.canisterId
                    ),
                );
                let replies = await* backendCalls.call_batch(slice);
                used += size;
                var index = 0;
                while (index < size and index < replies.size()) {
                    let target = targets[cursor + index];
                    switch (Client.decodePoolMetadata(replies[index])) {
                        case (#err(message)) List.add(errors, message);
                        case (#ok(metadata)) {
                            let derived = Market.derivePrice({
                                metadata;
                                base = target.address;
                                base_decimals = target.base_decimals;
                                quote = target.choice.quote;
                                icp_price_usd = mem.icp_price_usd;
                            });
                            switch (derived) {
                                case null {
                                    List.add(
                                        errors,
                                        "no usable quote for " # target.address,
                                    );
                                };
                                case (?value) {
                                    // ICP leads the target list, so updating the
                                    // reference here lets every later
                                    // ICP-quoted token convert in this same run.
                                    if (target.address == Market.ICP_LEDGER) {
                                        mem.icp_price_usd := Market.finiteOrZero(
                                            value.price_usd
                                        );
                                    };
                                    recordQuote(target.address, value, now);
                                    priced += 1;
                                };
                            };
                        };
                    };
                    index += 1;
                };
                cursor += size;
            };

            cacheReady := true;
            cacheFilledAt := now;
            mem.last_refresh_at := now;
            mem.refresh_count += 1;
            let recorded = recordSamples(now);
            let errorList = List.toArray(errors);
            mem.last_refresh_error := if (errorList.size() == 0) null else ?Market.clampText(
                Text.join(errorList.vals(), "; "),
                600,
            );

            {
                refreshed = true;
                pools = universePools.size();
                verified = universeVerified.size();
                priced;
                decimals_resolved = resolved;
                recorded;
                calls_used = used;
                errors = errorList;
                status = status(now);
            };
        };

        // ------------------------------------------------------------ queries

        public func /*query*/icpswap_status() : MarketStatus {
            status(nowSeconds());
        };

        public func /*query*/icpswap_market(
            request : MarketRequest
        ) : MarketSnapshot {
            let now = nowSeconds();
            let rows = Array.map<Memory.WatchEntry, MarketRow>(
                watchedEntries(),
                rowFor,
            );
            {
                rows = Market.sortRows(
                    rows,
                    parseSortKey(request.sort),
                    request.ascending,
                );
                status = status(now);
            };
        };

        public func /*query*/icpswap_search(
            request : SearchRequest
        ) : SearchPage {
            let now = nowSeconds();
            Market.searchCandidates({
                universe = tokenUniverse;
                verified = verifiedLookup;
                pool_counts = poolCountLookup;
                watched = func(address) = Map.containsKey(
                    mem.watchlist,
                    Text.compare,
                    address,
                );
                term = request.term;
                offset = request.offset;
                limit = request.limit;
                cache_age_seconds = cacheAge(now);
            });
        };

        public func /*query*/icpswap_token(address : Text) : ?TokenDetail {
            let now = nowSeconds();
            let ?normalized = normalizeAddress(address) else return null;
            let ?entry = Map.get(mem.watchlist, Text.compare, normalized) else {
                return null;
            };
            let (pools, poolCount) = Market.poolsForToken(
                universePools,
                normalized,
                symbolFor,
                Market.MAX_DETAIL_POOLS,
            );
            ?{
                row = rowFor(entry);
                profile = switch (Map.get(verifiedLookup, Text.compare, normalized)) {
                    case (?value) ?Market.profileOf(value);
                    case null null;
                };
                pools;
                pool_count = poolCount;
                history = Market.toPublicSamples(
                    Market.recentSamples(samplesFor(normalized), 120)
                );
                status = status(now);
            };
        };

        public func /*query*/icpswap_history(
            request : HistoryRequest
        ) : HistoryPage {
            let normalized = switch (normalizeAddress(request.address)) {
                case (?value) value;
                case null "";
            };
            let series = samplesFor(normalized);
            {
                address = normalized;
                samples = Market.toPublicSamples(
                    Market.recentSamples(series, request.limit)
                );
                total = series.size();
                history_limit = mem.history_limit;
            };
        };

        // ------------------------------------------------------------ updates

        public func /*update*/icpswap_refresh(force : Bool) : async* RefreshReport {
            let now = nowSeconds();
            if (
                not force and cacheReady and cacheAge(now) >= 0 and cacheAge(now) < MIN_REFRESH_GAP_SECONDS
            ) {
                return {
                    refreshed = false;
                    pools = universePools.size();
                    verified = universeVerified.size();
                    priced = 0;
                    decimals_resolved = 0;
                    recorded = 0;
                    calls_used = 0;
                    errors = ["cache is already current"];
                    status = status(now);
                };
            };
            // A foreground refresh is bounded by the watchlist ceiling rather
            // than a scheduled task's budget: two registry reads, and one pool
            // read per watched token plus the ICP reference.
            await* refresh(calls, now, 2 + Market.MAX_WATCHLIST + 1);
        };

        public func /*update*/icpswap_add(
            request : AddRequest
        ) : WatchlistReport {
            let ?address = normalizeAddress(request.address) else {
                return report(false, "That does not look like a token ledger id");
            };
            if (Map.containsKey(mem.watchlist, Text.compare, address)) {
                return report(true, "Already on the watchlist");
            };
            if (Map.size(mem.watchlist) >= Market.MAX_WATCHLIST) {
                return report(
                    false,
                    "Watchlist is full; remove a token before adding another",
                );
            };
            let verified = Map.get(verifiedLookup, Text.compare, address);
            let entry : Memory.WatchEntry = {
                address;
                symbol = switch (verified) {
                    case (?value) Market.clampText(value.symbol, Market.MAX_SYMBOL_CHARS);
                    case null Market.clampText(request.symbol, Market.MAX_SYMBOL_CHARS);
                };
                name = switch (verified) {
                    case (?value) Market.clampText(value.name, Market.MAX_NAME_CHARS);
                    case null Market.clampText(request.name, Market.MAX_NAME_CHARS);
                };
                standard = switch (verified) {
                    case (?value) Market.clampText(value.standard, Market.MAX_STANDARD_CHARS);
                    case null Market.clampText(request.standard, Market.MAX_STANDARD_CHARS);
                };
                decimals = switch (verified) {
                    case (?value) value.decimals;
                    case null Nat.min(request.decimals, 30);
                };
                added_at = nowSeconds();
                pinned = false;
                note = "";
            };
            Map.add(mem.watchlist, Text.compare, address, entry);
            report(true, "Added to the watchlist");
        };

        public func /*update*/icpswap_remove(address : Text) : WatchlistReport {
            let ?normalized = normalizeAddress(address) else {
                return report(false, "That does not look like a token ledger id");
            };
            switch (Map.take(mem.watchlist, Text.compare, normalized)) {
                case null report(false, "That token is not on the watchlist");
                case (?_) {
                    // History is kept: re-adding the token restores its series.
                    report(true, "Removed from the watchlist");
                };
            };
        };

        public func /*update*/icpswap_forget(address : Text) : WatchlistReport {
            let ?normalized = normalizeAddress(address) else {
                return report(false, "That does not look like a token ledger id");
            };
            Map.remove(mem.watchlist, Text.compare, normalized);
            Map.remove(mem.history, Text.compare, normalized);
            Map.remove(mem.quotes, Text.compare, normalized);
            report(true, "Removed the token and its recorded history");
        };

        public func /*update*/icpswap_set_pinned(
            request : PinRequest
        ) : WatchlistReport {
            let ?normalized = normalizeAddress(request.address) else {
                return report(false, "That does not look like a token ledger id");
            };
            switch (Map.get(mem.watchlist, Text.compare, normalized)) {
                case null report(false, "That token is not on the watchlist");
                case (?entry) {
                    ignore Map.insert(
                        mem.watchlist,
                        Text.compare,
                        normalized,
                        { entry with pinned = request.pinned },
                    );
                    report(true, if (request.pinned) "Pinned" else "Unpinned");
                };
            };
        };

        public func /*update*/icpswap_set_note(
            request : NoteRequest
        ) : WatchlistReport {
            let ?normalized = normalizeAddress(request.address) else {
                return report(false, "That does not look like a token ledger id");
            };
            switch (Map.get(mem.watchlist, Text.compare, normalized)) {
                case null report(false, "That token is not on the watchlist");
                case (?entry) {
                    ignore Map.insert(
                        mem.watchlist,
                        Text.compare,
                        normalized,
                        {
                            entry with note = Market.clampText(
                                request.note,
                                Market.MAX_NOTE_CHARS,
                            )
                        },
                    );
                    report(true, "Note saved");
                };
            };
        };

        // ------------------------------------------------------------- swap
        //
        // The swap plane deliberately holds no ledger authority. This Neutron
        // can price a swap and instruct a pool, but it cannot move a token:
        // the input is pulled by the pool itself, under an allowance the Wallet
        // granted after one owner decision, and the output is returned by the
        // pool to this canister's own account.

        let swapMem = env.stable_memory.icpswap_swap;
        // Wallet fees are refreshable observations, not released memory.
        let tokenFees = Map.empty<Text, Nat>();

        func stateText(state : SwapMemory.SwapState) : Text {
            switch (state) {
                case (#planned) "planned";
                case (#funded) "funded";
                case (#swapped) "swapped";
                case (#settled) "settled";
                case (#refunded) "refunded";
                case (#failed) "failed";
                case (#ambiguous) "ambiguous";
            };
        };

        func journalEntry(record : SwapMemory.SwapRecord) : SwapJournalEntry {
            {
                request_id = record.request_id;
                pool = record.pool;
                pool_key = record.pool_key;
                input_address = record.input_address;
                output_address = record.output_address;
                input_symbol = record.input_symbol;
                output_symbol = record.output_symbol;
                amount_in = record.amount_in;
                amount_out_minimum = record.amount_out_minimum;
                quoted_out = record.quoted_out;
                swapped_out = record.swapped_out;
                token_in_fee = record.token_in_fee;
                token_out_fee = record.token_out_fee;
                slippage = record.slippage;
                state = stateText(record.state);
                funding_status = record.funding_status;
                funding_block = record.funding_block;
                detail = record.detail;
                started_at = record.started_at;
                updated_at = record.updated_at;
            };
        };

        /// Record a swap attempt before anything irreversible happens, so a
        /// lost reply leaves evidence rather than a gap.
        func rememberSwap(record : SwapMemory.SwapRecord) {
            if (not Map.containsKey(swapMem.records, Text.compare, record.request_id)) {
                swapMem.order := Array.concat(swapMem.order, [record.request_id]);
            };
            Map.add(swapMem.records, Text.compare, record.request_id, record);
            // Keep dispatch identities even after completion. Removing an ID
            // would turn a delayed retry into another value-moving operation.
            // Released `limit` remains a display default, not record eviction.
        };

        func updateSwap(
            request_id : Text,
            state : SwapMemory.SwapState,
            detail : Text,
            swapped_out : Nat,
        ) {
            switch (Map.get(swapMem.records, Text.compare, request_id)) {
                case null {};
                case (?record) {
                    Map.add(
                        swapMem.records,
                        Text.compare,
                        request_id,
                        {
                            record with
                            state;
                            detail;
                            swapped_out;
                            updated_at = nowSeconds();
                        },
                    );
                };
            };
        };

        /// Resolve the pool for a pair across every fee tier and keep the one
        /// that quotes best. ICPSwap's own app only ever asks the 0.3% tier;
        /// asking all three costs two extra cheap reads and can only improve
        /// the price the owner gets.
        func resolvePool(
            backendCalls : NeutronCapabilities.BackendCallsV1,
            input : Text,
            output : Text,
            amount_in : Nat,
        ) : async* Types.Result<{ pool : Types.PoolData; quoted : Nat }> {
            let factory = Client.swapFactoryPrincipal();
            let lookups = Array.tabulate<Client.CallRequest>(
                Swap.FEE_TIERS.size(),
                func(index) {
                    Client.poolForPairRequest(
                        factory,
                        input,
                        output,
                        Swap.FEE_TIERS[index],
                    );
                },
            );
            let found = await* backendCalls.call_batch(lookups);
            let pools = List.empty<Types.PoolData>();
            for (reply in found.vals()) {
                switch (Client.decodePoolForPair(reply)) {
                    case (#err(_)) {};
                    case (#ok(pool)) List.add(pools, pool);
                };
            };
            if (List.size(pools) == 0) {
                return #err("No ICPSwap pool trades that pair.");
            };

            let candidates = List.toArray(pools);
            let quotes = await* backendCalls.call_batch(
                Array.tabulate<Client.CallRequest>(
                    candidates.size(),
                    func(index) {
                        let pool = candidates[index];
                        Client.quoteRequest(
                            pool.canisterId,
                            Swap.zeroForOne(input, pool.token0.address),
                            amount_in,
                        );
                    },
                )
            );

            var best : ?{ pool : Types.PoolData; quoted : Nat } = null;
            for (index in candidates.keys()) {
                if (index < quotes.size()) {
                    switch (Client.decodeQuote(quotes[index])) {
                        case (#err(_)) {};
                        case (#ok(quoted)) {
                            if (quoted > 0) {
                                let better = switch (best) {
                                    case null true;
                                    case (?current) quoted > current.quoted;
                                };
                                if (better) {
                                    best := ?{ pool = candidates[index]; quoted };
                                };
                            };
                        };
                    };
                };
            };
            switch (best) {
                case null {
                    // Every pool answered, none could price it. The pool
                    // returns `ok 0` for dust and rejects an oversized amount
                    // outright, so both look like this.
                    #err("No pool could price that amount. Try a different size.");
                };
                case (?value) #ok(value);
            };
        };

        /// Price a swap and report exactly what it would cost and guarantee.
        ///
        /// Everything the caller needs to decide is computed here from live
        /// state; the frontend never supplies a quote back to `execute`.
        func quoteSwap(
            backendCalls : NeutronCapabilities.BackendCallsV1,
            input : Text,
            output : Text,
            amount_in : Nat,
            slippage : Nat,
        ) : async* SwapQuoteResult {
            let inputAddress = Market.lower(input);
            let outputAddress = Market.lower(output);
            if (inputAddress == outputAddress) {
                return #err(Swap.describeRejection(#same_token));
            };
            if (amount_in == 0) return #err(Swap.describeRejection(#amount_zero));

            let resolved = switch (await* resolvePool(backendCalls, inputAddress, outputAddress, amount_in)) {
                case (#err(message)) return #err(message);
                case (#ok(value)) value;
            };
            let pool = resolved.pool;
            let inputToken = if (pool.token0.address == inputAddress) pool.token0 else pool.token1;
            if (inputToken.address != inputAddress or inputToken.standard != "ICRC2") {
                return #err("This swap funding route requires an ICRC2 input token; the factory pool reports an unsupported input standard.");
            };
            let poolId = pool.canisterId;

            // Three reads, all on the pool itself. Token ledgers belong to
            // the Wallet, so there is deliberately no `icrc1_fee` cross-check
            // and no allowance read here.
            let details = await* backendCalls.call_batch([
                Client.cachedTokenFeeRequest(poolId),
                Client.availabilityRequest(poolId),
                Client.poolMetadataRequest(poolId),
            ]);
            if (details.size() < 3) return #err("Pool did not answer.");

            let cached = switch (Client.decodeCachedTokenFee(details[0])) {
                case (#err(message)) return #err(message);
                case (#ok(value)) value;
            };
            switch (Client.decodeAvailability(details[1])) {
                case (#err(message)) return #err(message);
                case (#ok(state)) {
                    var accessible = state.available;
                    for (owner in state.whiteList.vals()) {
                        if (owner == backendCalls.canister_principal) accessible := true;
                    };
                    if (not accessible) {
                        return #err("This pool is closed to new swaps for this Neutron.");
                    };
                };
            };
            let sqrtPrice = switch (Client.decodePoolMetadata(details[2])) {
                case (#err(_)) 0;
                case (#ok(metadata)) metadata.sqrtPriceX96;
            };
            // Decimals are only used for price impact, which is advisory.
            // A token whose decimals this Neutron has not read yet gets no
            // impact figure rather than one computed from a guess.
            let decimalsIn = switch (decimalsFor(inputAddress)) {
                case (?value) value;
                case null 0;
            };
            let decimalsOut = switch (decimalsFor(outputAddress)) {
                case (?value) value;
                case null 0;
            };
            let impactUsable = decimalsIn > 0 and decimalsOut > 0;
            let planned = Swap.plan(
                {
                    input_address = inputAddress;
                    output_address = outputAddress;
                    amount_in;
                    slippage;
                },
                {
                    token0_address = pool.token0.address;
                    token1_address = pool.token1.address;
                    cached_fee0 = cached.token0Fee;
                    cached_fee1 = cached.token1Fee;
                    // Whatever the Wallet last reported for these ledgers. When
                    // present, a disagreement with the pool's cache refuses the
                    // swap before anything is sent; when absent, the pool's
                    // cache is trusted and a stale one surfaces as a ledger
                    // BadFee inside the swap, with funds untouched either way.
                    live_fee_in = Map.get(tokenFees, Text.compare, inputAddress);
                    live_fee_out = Map.get(tokenFees, Text.compare, outputAddress);
                    quoted_out = resolved.quoted;
                    sqrt_price_x96 = if (impactUsable) sqrtPrice else 0;
                    decimals_in = decimalsIn;
                    decimals_out = decimalsOut;
                },
            );
            switch (planned) {
                case (#err(message)) #err(message);
                case (#ok(value)) {
                    #ok({
                        pool = Principal.toText(poolId);
                        pool_key = pool.key;
                        fee_tier = pool.fee;
                        input_address = inputAddress;
                        output_address = outputAddress;
                        decimals_in = decimalsIn;
                        decimals_out = decimalsOut;
                        zero_for_one = value.zero_for_one;
                        amount_in = value.amount_in;
                        quoted_out = value.quoted_out;
                        amount_out_minimum = value.amount_out_minimum;
                        expected_out = value.expected_out;
                        token_in_fee = value.token_in_fee;
                        token_out_fee = value.token_out_fee;
                        funding_amount = value.funding_amount;
                        total_debit = value.total_debit;
                        price_impact = value.price_impact;
                        warn = value.warn;
                        slippage;
                        funding_ledger = inputAddress;
                        funding_spender = Principal.toText(poolId);
                        at = nowSeconds();
                    });
                };
            };
        };

        /// Price one swap. Safe to call as often as the UI needs; it moves
        /// nothing and grants nothing.
        let swapService = SwapActions.Service(calls, actionJournal, func(request : SwapExecuteRequest) : async* SwapQuoteResult {
            await* quoteSwap(calls, request.input_address, request.output_address, request.amount_in, Swap.normalizeSlippage(?request.slippage));
        }, Time.now);

        public func /*update*/icpswap_swap_quote(
            request : SwapExecuteRequest
        ) : async* SwapQuoteResult {
            await* quoteSwap(
                calls,
                request.input_address,
                request.output_address,
                request.amount_in,
                Swap.normalizeSlippage(?request.slippage),
            );
        };

        /// Compatibility entrypoint for installed callers. New clients save a
        /// reviewed quote through the actions API before Wallet funding. Legacy
        /// request IDs are retained and never cause a second pool dispatch.
        public func /*update*/icpswap_swap_execute(
            request : SwapExecuteRequest
        ) : async* SwapReceipt {
            let slippage = Swap.normalizeSlippage(?request.slippage);
            let at = nowSeconds();
            func refuse(detail : Text) : SwapReceipt = {
                request_id = request.request_id; state = "failed"; pool = "";
                input_address = request.input_address; output_address = request.output_address;
                amount_in = request.amount_in; amount_out_minimum = 0;
                swapped_out = 0; received_out = 0; detail; needs_funding = false;
                funding_ledger = ""; funding_spender = ""; funding_amount = 0; at;
            };
            func retained(record : SwapMemory.SwapRecord) : SwapReceipt {
                let unresolved = record.state == #planned or record.state == #funded or record.state == #ambiguous;
                let detail = if (unresolved) {
                    "This legacy request was already saved and its outcome may be unresolved. It will not be sent again. " # record.detail;
                } else if (record.state == #swapped) {
                    "The swap succeeded and ICPSwap scheduled its output transfer. Wallet receipt is not confirmed by the pool reply. " # record.detail;
                } else record.detail;
                {
                    request_id = record.request_id; state = if (unresolved) "ambiguous" else stateText(record.state);
                    pool = record.pool; input_address = record.input_address; output_address = record.output_address;
                    amount_in = record.amount_in; amount_out_minimum = record.amount_out_minimum;
                    swapped_out = record.swapped_out;
                    received_out = if (record.state == #settled and record.swapped_out > record.token_out_fee) record.swapped_out - record.token_out_fee else 0;
                    detail; needs_funding = false; funding_ledger = record.input_address;
                    funding_spender = record.pool; funding_amount = record.amount_in; at = record.updated_at;
                };
            };
            func prior() : ?SwapReceipt {
                if (actionJournal.raw(request.request_id) != null) {
                    return ?refuse("This request ID belongs to a current saved action. Continue or reconcile that action; the legacy endpoint will not send it again.");
                };
                switch (Map.get(swapMem.records, Text.compare, request.request_id)) {
                    case null null;
                    case (?record) {
                        if (record.input_address != Market.lower(request.input_address) or
                            record.output_address != Market.lower(request.output_address) or
                            record.amount_in != request.amount_in or record.slippage != slippage) {
                            ?refuse("This request ID already belongs to another saved swap intent.");
                        } else ?retained(record);
                    };
                };
            };
            if (request.request_id == "") return refuse("A retained request ID is required.");
            switch (prior()) { case (?receipt) return receipt; case null {} };
            let quote = switch (await* quoteSwap(calls, request.input_address, request.output_address, request.amount_in, slippage)) {
                case (#err(message)) return refuse(message); case (#ok(value)) value;
            };
            // Another request can complete while the quote is being read.
            switch (prior()) { case (?receipt) return receipt; case null {} };
            rememberSwap({
                request_id = request.request_id; pool = quote.pool; pool_key = quote.pool_key;
                input_address = quote.input_address; output_address = quote.output_address;
                input_symbol = symbolFor(quote.input_address); output_symbol = symbolFor(quote.output_address);
                amount_in = quote.amount_in; amount_out_minimum = quote.amount_out_minimum;
                quoted_out = quote.quoted_out; swapped_out = 0; token_in_fee = quote.token_in_fee;
                token_out_fee = quote.token_out_fee; slippage; state = #ambiguous;
                funding_status = "protocol_requested"; funding_block = "";
                detail = "The exact pool request was saved before dispatch. Do not repeat it while its outcome is unknown.";
                started_at = at; updated_at = at;
            });
            let replies = try {
                await* calls.call_batch([Client.depositFromAndSwapRequest(
                    Principal.fromText(quote.pool), quote.zero_for_one, quote.amount_in,
                    quote.amount_out_minimum, quote.token_in_fee, quote.token_out_fee,
                )]);
            } catch (_) {
                updateSwap(request.request_id, #ambiguous, "The pool call was interrupted. Its result is unknown and it will not be repeated.", 0);
                return switch (prior()) { case (?receipt) receipt; case null refuse("Saved swap unavailable.") };
            };
            if (replies.size() != 1) {
                updateSwap(request.request_id, #ambiguous, "The pool did not provide one confirmed reply. Keep this request ID and inspect pool settlement.", 0);
            } else {
                switch (replies[0]) {
                    case (#err(error)) {
                        // Transport text is not a decoded protocol rejection,
                        // even when it contains words like InsufficientFunds.
                        updateSwap(request.request_id, #ambiguous, "The broker did not confirm the pool outcome: " # error.code # ": " # error.message, 0);
                    };
                    case (#ok(bytes)) {
                        switch (ProtocolReply.decodeNat(bytes)) {
                            case (#unknown(message)) updateSwap(request.request_id, #ambiguous,
                                "The pool reply could not be decoded: " # message # "; the saved swap will not be repeated.", 0);
                            case (#ok(gross)) {
                                swapMem.completed += 1;
                                updateSwap(request.request_id, #swapped, "Output withdrawal remains subject to protocol settlement.", gross);
                            };
                            case (#rejected(message)) {
                                let uncertain = Swap.classifyFailure(message) == #ambiguous;
                                updateSwap(request.request_id, if (uncertain) #ambiguous else #failed,
                                    message # (if (uncertain) ". Input or refund settlement may remain unresolved. Do not repeat this request."
                                               else ". This request stopped before a confirmed input transfer. Review retained allowance before preparing a new intent."), 0);
                            };
                        };
                    };
                };
            };
            switch (prior()) { case (?receipt) receipt; case null refuse("Saved swap unavailable.") };
        };

        /// Record what the Wallet reports about a token.
        ///
        /// Token ledgers belong to the Wallet, so this app never reads one. The
        /// resident passes on what the Wallet already knows — decimals, and the
        /// fee in force. Fees are refreshed in a transient cache, including zero.
        /// Without this a token still prices from ICPSwap's own curated list;
        /// with it, an uncurated token prices too.
        public func /*update*/icpswap_set_token_info(
            request : TokenInfoRequest
        ) : Bool {
            let address = Market.lower(request.address);
            if (address == "" or request.decimals > 32) return false;
            ignore Map.insert(mem.decimals, Text.compare, address, request.decimals);
            ignore Map.insert(tokenFees, Text.compare, address, request.fee);
            true;
        };

        /// Every swap this Neutron has attempted, newest first.
        public func /*query*/icpswap_swap_journal(limit : Nat) : SwapJournalPage {
            let bounded = if (limit == 0 or limit > 100) 100 else limit;
            let total = swapMem.order.size();
            let entries = List.empty<SwapJournalEntry>();
            var index = total;
            while (index > 0 and List.size(entries) < bounded) {
                index -= 1;
                switch (Map.get(swapMem.records, Text.compare, swapMem.order[index])) {
                    case null {};
                    case (?record) List.add(entries, journalEntry(record));
                };
            };
            {
                entries = List.toArray(entries);
                total;
                completed = swapMem.completed;
                slippage = swapMem.slippage;
            };
        };

        /// The slippage the owner has chosen, in thousandths of a percent.
        public func /*update*/icpswap_set_slippage(value : Nat) : Nat {
            swapMem.slippage := Swap.normalizeSlippage(?value);
            swapMem.slippage;
        };

        /// Legacy read-only observation. The historical input/output fields
        /// represent canonical pool token0/token1 balances, respectively.
        /// Queued withdrawals can still reserve these credits; use the current
        /// liquidity recovery view before preparing a separate withdrawal.
        public func /*update*/icpswap_swap_recover(
            pool : Text
        ) : async* SwapRecoveryResult {
            let poolId = switch (Principal.fromText(pool)) { case (value) value };
            let unusedReplies = await* calls.call_batch([
                Client.unusedBalanceRequest(poolId, calls.canister_principal)
            ]);
            if (unusedReplies.size() == 0) return #err("The pool did not reply.");
            let unused = switch (Client.decodeUnusedBalance(unusedReplies[0])) {
                case (#err(message)) return #err(message);
                case (#ok(value)) value;
            };
            #ok({
                pool;
                unused_input = unused.balance0;
                unused_output = unused.balance1;
                input_balance = 0;
                output_balance = 0;
                withdrawn = 0;
                detail = if (unused.balance0 == 0 and unused.balance1 == 0) {
                    "No unused token0/token1 balance was observed. This does not establish withdrawal settlement.";
                } else {
                    "Observed unused_input is canonical token0 and unused_output is token1. Check current payout reservations before withdrawing through ICPSwap liquidity management.";
                };
            });
        };

        // ---------------------------------------------------- scheduled work

        /// Runs on the manifest schedule even with no browser open. Failures are
        /// recorded in status and retried on the next interval rather than
        /// trapping, so one upstream outage cannot stall the schedule. The
        /// budget matches the manifest's `max_backend_calls`.
        public func /*internal*/icpswap_snapshot_tick(
            (),
            /*task_capabilities*/ taskCapabilities : TaskCapabilities,
        ) : async* () {
            ignore await* refresh(taskCapabilities.backend_calls, nowSeconds(), 100);
        };
    };


/*---NEUTRON GENERATED BEGIN---*/

public type icpswap_swap_prepare_v1_Input = (request : SwapPrepareRequest);
public type icpswap_swap_prepare_v1_Output = SwapPreparedResult;

public type icpswap_swap_execute_v1_Input = (request : SwapActionExecuteRequest);
public type icpswap_swap_execute_v1_Output = SwapPreparedResult;

public type icpswap_liquidity_recover_prepare_Input = (request : RecoveryPrepareRequest);
public type icpswap_liquidity_recover_prepare_Output = RecoveryPreparedResult;

public type icpswap_liquidity_recover_execute_Input = (request : LiquidityExecuteRequest);
public type icpswap_liquidity_recover_execute_Output = RecoveryPreparedResult;

public type icpswap_action_status_Input = (id : Text);
public type icpswap_action_status_Output = ?PreparedAction;

public type icpswap_account_Input = ();
public type icpswap_account_Output = Text;

public type icpswap_action_page_Input = (request : ActionPageRequest);
public type icpswap_action_page_Output = ActionPageResult;

public type icpswap_action_get_Input = (id : Text);
public type icpswap_action_get_Output = ?ActionOperation;

public type icpswap_action_update_Input = (request : ActionUpdateRequest);
public type icpswap_action_update_Output = ActionResult;

public type icpswap_liquidity_pool_Input = (pool : Text);
public type icpswap_liquidity_pool_Output = LiquidityPoolViewResult;

public type icpswap_liquidity_preview_Input = (request : LiquidityRequest);
public type icpswap_liquidity_preview_Output = LiquidityPlanResult;

public type icpswap_liquidity_prepare_Input = (request : LiquidityPrepareRequest);
public type icpswap_liquidity_prepare_Output = LiquidityPreparedResult;

public type icpswap_liquidity_execute_Input = (request : LiquidityExecuteRequest);
public type icpswap_liquidity_execute_Output = LiquidityPreparedResult;

public type icpswap_liquidity_reconcile_Input = (id : Text);
public type icpswap_liquidity_reconcile_Output = LiquidityReconciliationResult;

public type icpswap_status_Input = ();
public type icpswap_status_Output = MarketStatus;

public type icpswap_market_Input = (request : MarketRequest);
public type icpswap_market_Output = MarketSnapshot;

public type icpswap_search_Input = (request : SearchRequest);
public type icpswap_search_Output = SearchPage;

public type icpswap_token_Input = (address : Text);
public type icpswap_token_Output = ?TokenDetail;

public type icpswap_history_Input = (request : HistoryRequest);
public type icpswap_history_Output = HistoryPage;

public type icpswap_refresh_Input = (force : Bool);
public type icpswap_refresh_Output = RefreshReport;

public type icpswap_add_Input = (request : AddRequest);
public type icpswap_add_Output = WatchlistReport;

public type icpswap_remove_Input = (address : Text);
public type icpswap_remove_Output = WatchlistReport;

public type icpswap_forget_Input = (address : Text);
public type icpswap_forget_Output = WatchlistReport;

public type icpswap_set_pinned_Input = (request : PinRequest);
public type icpswap_set_pinned_Output = WatchlistReport;

public type icpswap_set_note_Input = (request : NoteRequest);
public type icpswap_set_note_Output = WatchlistReport;

public type icpswap_swap_quote_Input = (request : SwapExecuteRequest);
public type icpswap_swap_quote_Output = SwapQuoteResult;

public type icpswap_swap_execute_Input = (request : SwapExecuteRequest);
public type icpswap_swap_execute_Output = SwapReceipt;

public type icpswap_set_token_info_Input = (request : TokenInfoRequest);
public type icpswap_set_token_info_Output = Bool;

public type icpswap_swap_journal_Input = (limit : Nat);
public type icpswap_swap_journal_Output = SwapJournalPage;

public type icpswap_set_slippage_Input = (value : Nat);
public type icpswap_set_slippage_Output = Nat;

public type icpswap_swap_recover_Input = (pool : Text);
public type icpswap_swap_recover_Output = SwapRecoveryResult;

public type icpswap_snapshot_tick_Input = (());
public type icpswap_snapshot_tick_Output = ();

/*---NEUTRON GENERATED END---*/
}
