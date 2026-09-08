/// Pure market logic: deriving spot prices from live pool state, choosing which
/// pool to quote a token against, indexing the pool registry, building app rows,
/// ranking, searching, paginating, and maintaining the bounded local history.
///
/// Nothing here performs a canister call or touches a capability handle, so the
/// whole module is exercised directly by the Motoko release tests.
import Array "mo:core/Array";
import Char "mo:core/Char";
import Float "mo:core/Float";
import Int "mo:core/Int";
import Iter "mo:core/Iter";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Order "mo:core/Order";
import Text "mo:core/Text";
import Memory "../memory/icpswap/v1";
import Types "./Types";

module {

    public type SortKey = {
        #symbol;
        #price;
        #pools;
        #added;
    };

    /// Number of sparkline points published with each market row.
    public let SPARKLINE_POINTS : Nat = 24;

    /// Hard ceiling on watched tokens. Keeps one scheduled refresh inside its
    /// backend-call budget and every self-call response inside the kernel's
    /// container-element budget.
    public let MAX_WATCHLIST : Nat = 60;

    /// Hard ceiling on rows returned by one search page.
    public let MAX_PAGE : Nat = 50;

    /// Hard ceiling on pool rows returned with a token detail.
    public let MAX_DETAIL_POOLS : Nat = 40;

    /// Hard ceiling on history samples returned by one call.
    public let MAX_HISTORY_PAGE : Nat = 400;

    /// Bounds on owner- or frontend-supplied display text.
    public let MAX_SYMBOL_CHARS : Nat = 32;
    public let MAX_NAME_CHARS : Nat = 96;
    public let MAX_NOTE_CHARS : Nat = 280;
    public let MAX_STANDARD_CHARS : Nat = 32;
    public let MAX_ADDRESS_CHARS : Nat = 80;

    /// 2^96, the fixed-point scale ICPSwap pools use for `sqrtPriceX96`.
    public let Q96 : Float = 79_228_162_514_264_337_593_543_950_336.0;

    public let ICP_LEDGER : Text = "ryjl3-tyaaa-aaaaa-aaaba-cai";
    public let CKUSDC_LEDGER : Text = "xevnm-gaaaa-aaaar-qafnq-cai";
    public let CKUSDT_LEDGER : Text = "cngnf-vqaaa-aaaar-qag4q-cai";

    /// A token this app can quote against, with its decimals fixed as a
    /// reviewed constant so the very first refresh needs no extra lookup.
    public type QuoteToken = {
        address : Text;
        symbol : Text;
        decimals : Nat;
        /// Lower ranks win when a token trades against several references.
        rank : Nat;
        /// True when the reference is a US-dollar stablecoin, so a pool price
        /// against it is already a USD price.
        usd : Bool;
    };

    /// Preference order: a dollar stablecoin beats ICP, because quoting through
    /// ICP compounds that pair's own pricing error.
    public let QUOTE_TOKENS : [QuoteToken] = [
        {
            address = CKUSDC_LEDGER;
            symbol = "ckUSDC";
            decimals = 6;
            rank = 0;
            usd = true;
        },
        {
            address = CKUSDT_LEDGER;
            symbol = "ckUSDT";
            decimals = 6;
            rank = 1;
            usd = true;
        },
        {
            address = ICP_LEDGER;
            symbol = "ICP";
            decimals = 8;
            rank = 2;
            usd = false;
        },
    ];

    public func quoteTokenFor(address : Text) : ?QuoteToken {
        for (quote in QUOTE_TOKENS.vals()) {
            if (quote.address == address) return ?quote;
        };
        null;
    };

    // ------------------------------------------------------------------ text

    public func lower(value : Text) : Text {
        Text.map(
            value,
            func(character : Char) : Char {
                if (character >= 'A' and character <= 'Z') {
                    Char.fromNat32(Char.toNat32(character) + 32);
                } else character;
            },
        );
    };

    /// Trim and hard-bound untrusted display text.
    public func clampText(value : Text, maxChars : Nat) : Text {
        let trimmed = Text.trim(value, #predicate(func(c : Char) : Bool = c == ' ' or c == '\n' or c == '\t' or c == '\r'));
        if (trimmed.size() <= maxChars) return trimmed;
        Text.fromIter(Iter.take(trimmed.chars(), maxChars));
    };

    /// Case-insensitive substring match over a token's symbol, name, and id.
    public func matchesQuery(
        needle : Text,
        symbol : Text,
        name : Text,
        address : Text,
    ) : Bool {
        if (needle == "") return true;
        let pattern = #text(needle);
        Text.contains(lower(symbol), pattern) or Text.contains(lower(name), pattern) or Text.contains(lower(address), pattern);
    };

    // ------------------------------------------------------------ price math

    /// Price of `token0` expressed in `token1`, from a pool's `sqrtPriceX96`.
    ///
    /// The pool stores sqrt(price) in Q64.96 fixed point over raw base units,
    /// so squaring it and correcting for the decimal difference gives the human
    /// price. Returns 0 for a pool that has never been initialised.
    public func priceFromSqrt(
        sqrtPriceX96 : Nat,
        decimals0 : Nat,
        decimals1 : Nat,
    ) : Float {
        if (sqrtPriceX96 == 0) return 0.0;
        let ratio = Float.fromInt(sqrtPriceX96) / Q96;
        let scaled = ratio * ratio * Float.pow(10.0, Float.fromInt(decimals0 - decimals1));
        if (Float.isNaN(scaled) or scaled < 0.0) 0.0 else scaled;
    };

    public type PriceInputs = {
        metadata : Types.PoolMetadata;
        base : Text;
        base_decimals : Nat;
        quote : QuoteToken;
        /// USD price of one ICP, used only when the quote token is ICP.
        icp_price_usd : Float;
    };

    public type DerivedPrice = {
        price_usd : Float;
        price_icp : Float;
        source : Types.QuoteSource;
    };

    /// Turn one pool's live state into a USD (and ICP) price for `base`.
    ///
    /// Returns `null` when the pool does not actually contain the pair, when it
    /// is uninitialised, or when an ICP-quoted token has no ICP reference price
    /// yet — never a fabricated number.
    public func derivePrice(inputs : PriceInputs) : ?DerivedPrice {
        let metadata = inputs.metadata;
        let base = inputs.base;
        let quote = inputs.quote;
        let baseIsToken0 = metadata.token0.address == base and metadata.token1.address == quote.address;
        let baseIsToken1 = metadata.token1.address == base and metadata.token0.address == quote.address;
        if (not baseIsToken0 and not baseIsToken1) return null;

        let (decimals0, decimals1) = if (baseIsToken0) {
            (inputs.base_decimals, quote.decimals);
        } else (quote.decimals, inputs.base_decimals);

        let token0InToken1 = priceFromSqrt(metadata.sqrtPriceX96, decimals0, decimals1);
        if (token0InToken1 <= 0.0) return null;

        let priceInQuote = if (baseIsToken0) token0InToken1 else 1.0 / token0InToken1;
        if (priceInQuote <= 0.0 or Float.isNaN(priceInQuote)) return null;

        let (priceUsd, priceIcp) = if (quote.usd) {
            let icp = if (inputs.icp_price_usd > 0.0) priceInQuote / inputs.icp_price_usd else 0.0;
            (priceInQuote, icp);
        } else {
            if (inputs.icp_price_usd <= 0.0) return null;
            (priceInQuote * inputs.icp_price_usd, priceInQuote);
        };

        ?{
            price_usd = priceUsd;
            price_icp = priceIcp;
            source = {
                pool = metadata.key;
                quote_address = quote.address;
                quote_symbol = quote.symbol;
                fee_tier = metadata.fee;
                liquidity = metadata.liquidity;
                via_icp = not quote.usd;
            };
        };
    };

    // -------------------------------------------------------------- indexing

    public func verifiedIndex(
        entries : [Types.TokenListEntry]
    ) : Map.Map<Text, Types.TokenListEntry> {
        let index = Map.empty<Text, Types.TokenListEntry>();
        for (entry in entries.vals()) {
            Map.add(index, Text.compare, entry.canisterId, entry);
        };
        index;
    };

    /// Number of pools each token is a side of.
    public func poolCountIndex(pools : [Types.PoolData]) : Map.Map<Text, Nat> {
        let index = Map.empty<Text, Nat>();
        for (pool in pools.vals()) {
            for (side in [pool.token0.address, pool.token1.address].vals()) {
                let existing = switch (Map.get(index, Text.compare, side)) {
                    case (?current) current;
                    case null 0;
                };
                ignore Map.insert(index, Text.compare, side, existing + 1);
            };
        };
        index;
    };

    /// Every token that appears in at least one pool, with its declared
    /// standard. This is the tradeable on-chain universe.
    public func tokenUniverse(pools : [Types.PoolData]) : Map.Map<Text, Text> {
        let index = Map.empty<Text, Text>();
        for (pool in pools.vals()) {
            for (side in [pool.token0, pool.token1].vals()) {
                if (not Map.containsKey(index, Text.compare, side.address)) {
                    Map.add(
                        index,
                        Text.compare,
                        side.address,
                        clampText(side.standard, MAX_STANDARD_CHARS),
                    );
                };
            };
        };
        index;
    };

    public type QuoteChoice = {
        pool : Types.PoolData;
        quote : QuoteToken;
    };

    /// Pick the pool this app will quote `address` against.
    ///
    /// Preference is the reference rank first (dollars before ICP), then the
    /// lowest fee tier, then the pool key, so the choice is deterministic and
    /// does not flap between refreshes.
    public func chooseQuotePool(
        pools : [Types.PoolData],
        address : Text,
    ) : ?QuoteChoice {
        var best : ?QuoteChoice = null;
        for (pool in pools.vals()) {
            let other = if (pool.token0.address == address) {
                ?pool.token1.address;
            } else if (pool.token1.address == address) {
                ?pool.token0.address;
            } else null;
            switch (other) {
                case null {};
                case (?counterparty) {
                    switch (quoteTokenFor(counterparty)) {
                        case null {};
                        case (?quote) {
                            let candidate : QuoteChoice = { pool; quote };
                            best := switch (best) {
                                case null ?candidate;
                                case (?current) {
                                    if (betterQuote(candidate, current)) ?candidate else ?current;
                                };
                            };
                        };
                    };
                };
            };
        };
        best;
    };

    func betterQuote(candidate : QuoteChoice, current : QuoteChoice) : Bool {
        if (candidate.quote.rank != current.quote.rank) {
            return candidate.quote.rank < current.quote.rank;
        };
        if (candidate.pool.fee != current.pool.fee) {
            return candidate.pool.fee < current.pool.fee;
        };
        Text.compare(candidate.pool.key, current.pool.key) == #less;
    };

    /// Pools that include `address`, bounded for the self-call response budget.
    public func poolsForToken(
        pools : [Types.PoolData],
        address : Text,
        symbolFor : (Text) -> Text,
        limit : Nat,
    ) : ([Types.PoolRow], Nat) {
        let selected = Array.filter<Types.PoolData>(
            pools,
            func(pool) = pool.token0.address == address or pool.token1.address == address,
        );
        let ordered = Array.sort<Types.PoolData>(
            selected,
            func(left, right) {
                if (left.fee != right.fee) return Nat.compare(left.fee, right.fee);
                Text.compare(left.key, right.key);
            },
        );
        let capped = Nat.min(Nat.min(limit, MAX_DETAIL_POOLS), ordered.size());
        let rows = Array.tabulate<Types.PoolRow>(
            capped,
            func(index) {
                let pool = ordered[index];
                {
                    pool = pool.key;
                    fee_tier = pool.fee;
                    token0_id = pool.token0.address;
                    token0_symbol = symbolFor(pool.token0.address);
                    token1_id = pool.token1.address;
                    token1_symbol = symbolFor(pool.token1.address);
                };
            },
        );
        (rows, ordered.size());
    };

    public func lookupNat(index : Map.Map<Text, Nat>, key : Text) : Nat {
        switch (Map.get(index, Text.compare, key)) {
            case (?value) value;
            case null 0;
        };
    };

    // ------------------------------------------------------------- sparkline

    /// Evenly downsample the local price history to a fixed-width sparkline.
    public func sparkline(samples : [Memory.Sample]) : [Float] {
        let total = samples.size();
        if (total == 0) return [];
        if (total <= SPARKLINE_POINTS) {
            return Array.map<Memory.Sample, Float>(
                samples,
                func(sample) = sample.price_usd,
            );
        };
        Array.tabulate<Float>(
            SPARKLINE_POINTS,
            func(step) {
                let position = (step * (total - 1)) / (SPARKLINE_POINTS - 1);
                samples[position].price_usd;
            },
        );
    };

    // ---------------------------------------------------------------- profile

    public func profileOf(entry : Types.TokenListEntry) : Types.TokenProfile {
        {
            address = entry.canisterId;
            symbol = clampText(entry.symbol, MAX_SYMBOL_CHARS);
            name = clampText(entry.name, MAX_NAME_CHARS);
            standard = clampText(entry.standard, MAX_STANDARD_CHARS);
            decimals = entry.decimals;
            fee = entry.fee;
            total_supply = entry.totalSupply;
            introduction = clampText(entry.introduction, 400);
            links = entry.mediaLinks;
            rank = entry.rank;
        };
    };

    // ------------------------------------------------------------------ rows

    public type RowInputs = {
        entry : Memory.WatchEntry;
        verified : ?Types.TokenListEntry;
        quote : ?Memory.Quote;
        pool_count : Nat;
        samples : [Memory.Sample];
    };

    func preferred(candidate : Text, fallback : Text) : Text {
        if (candidate == "") fallback else candidate;
    };

    public func buildRow(inputs : RowInputs) : Types.MarketRow {
        let entry = inputs.entry;
        {
            address = entry.address;
            symbol = switch (inputs.verified) {
                case (?value) clampText(preferred(value.symbol, entry.symbol), MAX_SYMBOL_CHARS);
                case null entry.symbol;
            };
            name = switch (inputs.verified) {
                case (?value) clampText(preferred(value.name, entry.name), MAX_NAME_CHARS);
                case null entry.name;
            };
            standard = switch (inputs.verified) {
                case (?value) clampText(preferred(value.standard, entry.standard), MAX_STANDARD_CHARS);
                case null entry.standard;
            };
            decimals = entry.decimals;
            price_usd = switch (inputs.quote) {
                case (?value) value.price_usd;
                case null 0.0;
            };
            price_icp = switch (inputs.quote) {
                case (?value) value.price_icp;
                case null 0.0;
            };
            quote = switch (inputs.quote) {
                case (?value) ?{
                    pool = value.pool;
                    quote_address = value.quote_address;
                    quote_symbol = value.quote_symbol;
                    fee_tier = value.fee_tier;
                    liquidity = value.liquidity;
                    via_icp = value.via_icp;
                };
                case null null;
            };
            pool_count = inputs.pool_count;
            pinned = entry.pinned;
            note = entry.note;
            added_at = entry.added_at;
            verified = inputs.verified != null;
            sample_count = inputs.samples.size();
            sparkline = sparkline(inputs.samples);
        };
    };

    // --------------------------------------------------------------- sorting

    func compareFloatDesc(left : Float, right : Float) : Order.Order {
        if (left > right) #less else if (left < right) #greater else #equal;
    };

    func compareIntDesc(left : Int, right : Int) : Order.Order {
        if (left > right) #less else if (left < right) #greater else #equal;
    };

    func compareNatDesc(left : Nat, right : Nat) : Order.Order {
        if (left > right) #less else if (left < right) #greater else #equal;
    };

    func rowOrder(
        key : SortKey,
        left : Types.MarketRow,
        right : Types.MarketRow,
    ) : Order.Order {
        switch (key) {
            case (#symbol) Text.compare(lower(left.symbol), lower(right.symbol));
            case (#price) compareFloatDesc(left.price_usd, right.price_usd);
            case (#pools) compareNatDesc(left.pool_count, right.pool_count);
            case (#added) compareIntDesc(left.added_at, right.added_at);
        };
    };

    func flip(order : Order.Order) : Order.Order {
        switch (order) {
            case (#less) #greater;
            case (#greater) #less;
            case (#equal) #equal;
        };
    };

    /// Pinned rows always lead, then the requested ordering, then symbol so the
    /// table never reshuffles between equal values.
    public func sortRows(
        rows : [Types.MarketRow],
        key : SortKey,
        ascending : Bool,
    ) : [Types.MarketRow] {
        Array.sort<Types.MarketRow>(
            rows,
            func(left, right) {
                if (left.pinned != right.pinned) {
                    return if (left.pinned) #less else #greater;
                };
                let primary = rowOrder(key, left, right);
                let directed = if (ascending) flip(primary) else primary;
                switch (directed) {
                    case (#equal) Text.compare(lower(left.symbol), lower(right.symbol));
                    case (other) other;
                };
            },
        );
    };

    // -------------------------------------------------------------- searching

    /// Rank an exact symbol or ledger match above a prefix match above a loose
    /// match, so typing "ICP" surfaces ICP rather than an unrelated token that
    /// merely contains those letters.
    func relevance(needle : Text, candidate : Types.TokenCandidate) : Nat {
        if (needle == "") return 3;
        let symbol = lower(candidate.symbol);
        if (symbol == needle or lower(candidate.address) == needle) return 0;
        if (Text.startsWith(symbol, #text(needle))) return 1;
        if (Text.contains(symbol, #text(needle))) return 2;
        3;
    };

    public type SearchInputs = {
        universe : Map.Map<Text, Text>;
        verified : Map.Map<Text, Types.TokenListEntry>;
        pool_counts : Map.Map<Text, Nat>;
        watched : (Text) -> Bool;
        term : Text;
        offset : Nat;
        limit : Nat;
        cache_age_seconds : Int;
    };

    public func searchCandidates(inputs : SearchInputs) : Types.SearchPage {
        let needle = lower(clampText(inputs.term, 64));
        let matched = Array.filterMap<(Text, Text), Types.TokenCandidate>(
            Iter.toArray(Map.entries(inputs.universe)),
            func((address, standard)) {
                let verified = Map.get(inputs.verified, Text.compare, address);
                let symbol = switch (verified) {
                    case (?value) clampText(value.symbol, MAX_SYMBOL_CHARS);
                    case null "";
                };
                let name = switch (verified) {
                    case (?value) clampText(value.name, MAX_NAME_CHARS);
                    case null "";
                };
                if (not matchesQuery(needle, symbol, name, address)) return null;
                ?{
                    address;
                    symbol;
                    name;
                    standard = switch (verified) {
                        case (?value) clampText(value.standard, MAX_STANDARD_CHARS);
                        case null standard;
                    };
                    decimals = switch (verified) {
                        case (?value) value.decimals;
                        case null 0;
                    };
                    pool_count = lookupNat(inputs.pool_counts, address);
                    verified = verified != null;
                    watched = inputs.watched(address);
                };
            },
        );
        let ranked = Array.sort<Types.TokenCandidate>(
            matched,
            func(left, right) {
                let leftScore = relevance(needle, left);
                let rightScore = relevance(needle, right);
                if (leftScore != rightScore) return Nat.compare(leftScore, rightScore);
                // A curated listing and deeper pool coverage both signal a real
                // market; fall back to the ledger id so the order is stable.
                if (left.verified != right.verified) {
                    return if (left.verified) #less else #greater;
                };
                if (left.pool_count != right.pool_count) {
                    return compareNatDesc(left.pool_count, right.pool_count);
                };
                Text.compare(left.address, right.address);
            },
        );
        let total = ranked.size();
        let start = Nat.min(inputs.offset, total);
        let count = Nat.min(Nat.min(inputs.limit, MAX_PAGE), total - start);
        {
            items = Array.sliceToArray(ranked, start, start + count);
            total;
            offset = start;
            universe = Map.size(inputs.universe);
            cache_age_seconds = inputs.cache_age_seconds;
        };
    };

    // ---------------------------------------------------------------- history

    /// Append one sample, keeping the series oldest-first and bounded. A sample
    /// closer than `minGapSeconds` to the newest one replaces it, so a burst of
    /// manual refreshes cannot flood the series.
    public func appendSample(
        existing : [Memory.Sample],
        sample : Memory.Sample,
        limit : Nat,
        minGapSeconds : Int,
    ) : [Memory.Sample] {
        let size = existing.size();
        let bounded = Nat.max(1, limit);
        if (size == 0) return [sample];
        let newest = existing[size - 1];
        if (sample.t - newest.t < minGapSeconds) {
            return Array.tabulate<Memory.Sample>(
                size,
                func(index) = if (index == size - 1) sample else existing[index],
            );
        };
        if (size < bounded) {
            return Array.tabulate<Memory.Sample>(
                size + 1,
                func(index) = if (index == size) sample else existing[index],
            );
        };
        // Drop the oldest samples so the series never exceeds the limit.
        let drop = (size + 1) - bounded;
        Array.tabulate<Memory.Sample>(
            bounded,
            func(index) = if (index == bounded - 1) sample else existing[index + drop],
        );
    };

    /// Trim a series to its most recent `count` samples.
    public func recentSamples(samples : [Memory.Sample], count : Nat) : [Memory.Sample] {
        let bounded = Nat.min(count, MAX_HISTORY_PAGE);
        let size = samples.size();
        if (size <= bounded) return samples;
        Array.sliceToArray(samples, size - bounded, size);
    };

    public func toPublicSamples(samples : [Memory.Sample]) : [Types.Sample] {
        Array.map<Memory.Sample, Types.Sample>(
            samples,
            func(sample) = {
                t = sample.t;
                price_usd = sample.price_usd;
                price_icp = sample.price_icp;
            },
        );
    };

    // ---------------------------------------------------------------- helpers

    public func finiteOrZero(value : Float) : Float {
        if (Float.isNaN(value)) 0.0 else value;
    };

    public func secondsSince(from : Int, now : Int) : Int {
        if (from <= 0) -1 else Int.max(0, now - from);
    };
};
