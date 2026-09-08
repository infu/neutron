import Principal "mo:core/Principal";
import Map "mo:core/Map";
import Text "mo:core/Text";
import Market "../backend/icpswap/Market";
import Memory "../backend/memory/icpswap/v1";
import Types "../backend/icpswap/Types";

let ICP = Market.ICP_LEDGER;
let CKUSDC = Market.CKUSDC_LEDGER;
let CKUSDT = Market.CKUSDT_LEDGER;

func pool(t0 : Text, t1 : Text, fee : Nat, id : Text) : Types.PoolData {
    {
        canisterId = Principal.fromText("aaaaa-aa");
        fee;
        key = t0 # "_" # t1 # "_" # id;
        tickSpacing = 60;
        token0 = { address = t0; standard = "ICRC2" };
        token1 = { address = t1; standard = "ICRC2" };
    };
};

func verified(id : Text, symbol : Text, name : Text, decimals : Nat) : Types.TokenListEntry {
    {
        canisterId = id;
        symbol;
        name;
        decimals;
        standard = "ICRC2";
        fee = 10_000;
        totalSupply = 1_000;
        introduction = "  demo token  ";
        mediaLinks = [{ link = "https://example.test"; mediaType = "Website" }];
        rank = 3;
    };
};

// --- text helpers ----------------------------------------------------------
assert (Market.lower("ckBTC") == "ckbtc");
assert (Market.clampText("  padded  ", 32) == "padded");
assert (Market.clampText("abcdef", 3) == "abc");
assert (Market.matchesQuery("btc", "ckBTC", "Chain key Bitcoin", "mxzaz-hq"));
assert (Market.matchesQuery("mxzaz", "ckBTC", "Chain key Bitcoin", "mxzaz-hq"));
assert (not Market.matchesQuery("zzz", "ckBTC", "Chain key Bitcoin", "mxzaz-hq"));
assert (Market.matchesQuery("", "A", "B", "C"));

// --- quote reference table -------------------------------------------------
switch (Market.quoteTokenFor(CKUSDC)) {
    case null assert false;
    case (?quote) {
        assert (quote.decimals == 6);
        assert quote.usd;
        assert (quote.rank == 0);
    };
};
switch (Market.quoteTokenFor(ICP)) {
    case null assert false;
    case (?quote) {
        assert (quote.decimals == 8);
        assert (not quote.usd);
    };
};
assert (Market.quoteTokenFor("aaaaa-aa") == null);

// --- price math ------------------------------------------------------------
// Real ICP/ckUSDC pool state read from mainnet on 2026-08-31. The public REST
// API reported $2.396 for ICP at the same moment.
let ICP_USDC_SQRT : Nat = 12_277_588_773_922_894_909_248_192_137;
let icpPrice = Market.priceFromSqrt(ICP_USDC_SQRT, 8, 6);
assert (icpPrice > 2.39 and icpPrice < 2.41);
// An uninitialised pool must never produce a price.
assert (Market.priceFromSqrt(0, 8, 6) == 0.0);

let icpUsdcMeta : Types.PoolMetadata = {
    fee = 3000;
    key = ICP # "_" # CKUSDC # "_3000";
    liquidity = 9_103_193_490_111;
    sqrtPriceX96 = ICP_USDC_SQRT;
    tick = -37_293;
    token0 = { address = ICP; standard = "ICRC2" };
    token1 = { address = CKUSDC; standard = "ICRC2" };
};

// The base token is token0 and the quote is a dollar stablecoin.
switch (
    Market.derivePrice({
        metadata = icpUsdcMeta;
        base = ICP;
        base_decimals = 8;
        quote = { address = CKUSDC; symbol = "ckUSDC"; decimals = 6; rank = 0; usd = true };
        icp_price_usd = 0.0;
    })
) {
    case null assert false;
    case (?derived) {
        assert (derived.price_usd > 2.39 and derived.price_usd < 2.41);
        // Without an ICP reference the ICP-denominated figure stays absent.
        assert (derived.price_icp == 0.0);
        assert (not derived.source.via_icp);
        assert (derived.source.quote_symbol == "ckUSDC");
        assert (derived.source.fee_tier == 3000);
        assert (derived.source.liquidity == 9_103_193_490_111);
    };
};

// Quoting ckUSDC against ICP inverts the pool price.
switch (
    Market.derivePrice({
        metadata = icpUsdcMeta;
        base = CKUSDC;
        base_decimals = 6;
        quote = { address = ICP; symbol = "ICP"; decimals = 8; rank = 2; usd = false };
        icp_price_usd = 2.4;
    })
) {
    case null assert false;
    case (?derived) {
        // 1 ckUSDC is about 1/2.4 ICP, and about one dollar.
        assert (derived.price_icp > 0.41 and derived.price_icp < 0.42);
        assert (derived.price_usd > 0.99 and derived.price_usd < 1.01);
        assert derived.source.via_icp;
    };
};

// An ICP-quoted token cannot be priced in USD before the ICP reference exists.
assert (
    Market.derivePrice({
        metadata = icpUsdcMeta;
        base = CKUSDC;
        base_decimals = 6;
        quote = { address = ICP; symbol = "ICP"; decimals = 8; rank = 2; usd = false };
        icp_price_usd = 0.0;
    }) == null
);

// A pool that does not contain the pair must never yield a price.
assert (
    Market.derivePrice({
        metadata = icpUsdcMeta;
        base = "zzzzz-zz";
        base_decimals = 8;
        quote = { address = CKUSDC; symbol = "ckUSDC"; decimals = 6; rank = 0; usd = true };
        icp_price_usd = 2.4;
    }) == null
);

// An uninitialised pool must never yield a price.
assert (
    Market.derivePrice({
        metadata = { icpUsdcMeta with sqrtPriceX96 = 0 };
        base = ICP;
        base_decimals = 8;
        quote = { address = CKUSDC; symbol = "ckUSDC"; decimals = 6; rank = 0; usd = true };
        icp_price_usd = 2.4;
    }) == null
);

// --- pool registry indexes -------------------------------------------------
let pools = [
    pool("aaa", ICP, 3000, "3000"),
    pool("aaa", CKUSDC, 3000, "3000"),
    pool("aaa", CKUSDT, 500, "500"),
    pool("bbb", "ccc", 3000, "3000"),
];

let counts = Market.poolCountIndex(pools);
assert (Map.get(counts, Text.compare, "aaa") == ?3);
assert (Map.get(counts, Text.compare, ICP) == ?1);
assert (Map.get(counts, Text.compare, "ccc") == ?1);

let universe = Market.tokenUniverse(pools);
assert (Map.size(universe) == 6);
assert (Map.get(universe, Text.compare, "aaa") == ?"ICRC2");

// A dollar reference wins over ICP even when the ICP pool is listed first.
switch (Market.chooseQuotePool(pools, "aaa")) {
    case null assert false;
    case (?choice) {
        assert (choice.quote.address == CKUSDC);
        assert (choice.quote.rank == 0);
    };
};
// With only ICP available, ICP is chosen.
switch (Market.chooseQuotePool([pool("ddd", ICP, 3000, "3000")], "ddd")) {
    case null assert false;
    case (?choice) assert (choice.quote.address == ICP);
};
// Among equal-rank references the lower fee tier wins.
switch (
    Market.chooseQuotePool(
        [pool("eee", CKUSDC, 3000, "hi"), pool("eee", CKUSDC, 500, "lo")],
        "eee",
    )
) {
    case null assert false;
    case (?choice) assert (choice.pool.fee == 500);
};
// A token with no reference pool has no quote at all.
assert (Market.chooseQuotePool(pools, "bbb") == null);
assert (Market.chooseQuotePool(pools, "not-listed") == null);

// --- pools for a token -----------------------------------------------------
let (rows, total) = Market.poolsForToken(pools, "aaa", func(id) = id, 10);
assert (total == 3);
assert (rows.size() == 3);
assert (rows[0].fee_tier == 500);
let (capped, stillTotal) = Market.poolsForToken(pools, "aaa", func(id) = id, 1);
assert (capped.size() == 1);
assert (stillTotal == 3);

// --- search ----------------------------------------------------------------
let verifiedMap = Market.verifiedIndex([
    verified("aaa", "ICP", "Internet Computer", 8),
    verified("bbb", "WICP", "Wrapped ICP", 8),
]);
let page = Market.searchCandidates({
    universe;
    verified = verifiedMap;
    pool_counts = counts;
    watched = func(address) = address == "bbb";
    term = "icp";
    offset = 0;
    limit = 10;
    cache_age_seconds = 5;
});
assert (page.cache_age_seconds == 5);
assert (page.universe == 6);
assert (page.total == 2);
// The exact symbol match leads, ahead of the loose one.
assert (page.items[0].symbol == "ICP");
assert (page.items[0].pool_count == 3);
assert (page.items[0].verified);
assert (page.items[1].symbol == "WICP");
assert (page.items[1].watched);

// An empty term lists the whole universe, curated entries first.
let all = Market.searchCandidates({
    universe;
    verified = verifiedMap;
    pool_counts = counts;
    watched = func(_) = false;
    term = "";
    offset = 0;
    limit = 50;
    cache_age_seconds = 0;
});
assert (all.total == 6);
assert (all.items[0].verified);

// Pagination clamps to the page ceiling and reports the true total.
let paged = Market.searchCandidates({
    universe;
    verified = verifiedMap;
    pool_counts = counts;
    watched = func(_) = false;
    term = "";
    offset = 5;
    limit = 50;
    cache_age_seconds = 0;
});
assert (paged.items.size() == 1);
assert (paged.offset == 5);
assert (paged.total == 6);

// --- history ---------------------------------------------------------------
let base : Memory.Sample = { t = 100; price_usd = 1.0; price_icp = 0.4 };
let one = Market.appendSample([], base, 3, 60);
assert (one.size() == 1);
let two = Market.appendSample(one, { base with t = 200; price_usd = 2.0 }, 3, 60);
assert (two.size() == 2);
// Inside the minimum gap the newest sample is replaced, not appended.
let replaced = Market.appendSample(two, { base with t = 210; price_usd = 9.0 }, 3, 60);
assert (replaced.size() == 2);
assert (replaced[1].price_usd == 9.0);
let three = Market.appendSample(replaced, { base with t = 300; price_usd = 3.0 }, 3, 60);
assert (three.size() == 3);
// At the limit the oldest sample is evicted.
let evicted = Market.appendSample(three, { base with t = 400; price_usd = 4.0 }, 3, 60);
assert (evicted.size() == 3);
assert (evicted[0].price_usd == 9.0);
assert (evicted[2].price_usd == 4.0);

let recent = Market.recentSamples(evicted, 2);
assert (recent.size() == 2);
assert (recent[0].price_usd == 3.0);
assert (Market.recentSamples(evicted, 99).size() == 3);
assert (Market.toPublicSamples(evicted).size() == 3);

// --- sparkline -------------------------------------------------------------
let series = [
    { base with t = 1; price_usd = 1.0 },
    { base with t = 2; price_usd = 2.0 },
    { base with t = 3; price_usd = 3.0 },
];
let spark = Market.sparkline(series);
assert (spark.size() == 3);
assert (spark[0] == 1.0);
assert (spark[2] == 3.0);
assert (Market.sparkline([]).size() == 0);

// --- rows and ordering -----------------------------------------------------
let entry : Memory.WatchEntry = {
    address = "aaa";
    symbol = "fallback";
    name = "fallback name";
    standard = "";
    decimals = 8;
    added_at = 10;
    pinned = false;
    note = "note";
};
let quote : Memory.Quote = {
    pool = "aaa_" # CKUSDC # "_3000";
    quote_address = CKUSDC;
    quote_symbol = "ckUSDC";
    fee_tier = 3000;
    liquidity = 1_234;
    via_icp = false;
    price_usd = 5.0;
    price_icp = 2.0;
    at = 100;
};
let rowA = Market.buildRow({
    entry;
    verified = ?verified("aaa", "ICP", "Internet Computer", 8);
    quote = ?quote;
    pool_count = 3;
    samples = series;
});
// Curated metadata wins over the stored fallback.
assert (rowA.symbol == "ICP");
assert (rowA.name == "Internet Computer");
assert (rowA.standard == "ICRC2");
assert (rowA.price_usd == 5.0);
assert (rowA.sparkline.size() == 3);
assert (rowA.sample_count == 3);
assert rowA.verified;
switch (rowA.quote) {
    case null assert false;
    case (?source) {
        assert (source.quote_symbol == "ckUSDC");
        assert (not source.via_icp);
    };
};

// A token with no quote yet reports no price rather than a fabricated one.
let rowB = Market.buildRow({
    entry = { entry with address = "bbb"; symbol = "ZZZ"; pinned = true };
    verified = null;
    quote = null;
    pool_count = 1;
    samples = [];
});
assert (rowB.price_usd == 0.0);
assert (rowB.quote == null);
assert (not rowB.verified);

// Pinned rows lead regardless of the sort key.
let sorted = Market.sortRows([rowA, rowB], #price, false);
assert (sorted[0].symbol == "ZZZ");
let unpinned = Market.sortRows([rowA, { rowB with pinned = false }], #price, false);
assert (unpinned[0].symbol == "ICP");
let ascending = Market.sortRows([rowA, { rowB with pinned = false }], #price, true);
assert (ascending[0].symbol == "ZZZ");
let bySymbol = Market.sortRows([rowA, { rowB with pinned = false }], #symbol, false);
assert (bySymbol[0].symbol == "ICP");
let byPools = Market.sortRows([{ rowB with pinned = false }, rowA], #pools, false);
assert (byPools[0].symbol == "ICP");

// --- profile ---------------------------------------------------------------
let profile = Market.profileOf(verified("bbb", "ICP", "Internet Computer", 8));
assert (profile.symbol == "ICP");
assert (profile.introduction == "demo token");
assert (profile.links.size() == 1);
assert (profile.rank == 3);

// --- misc ------------------------------------------------------------------
assert (Market.secondsSince(0, 100) == -1);
assert (Market.secondsSince(40, 100) == 60);
assert (Market.finiteOrZero(1.5) == 1.5);
assert (Market.lookupNat(counts, "missing") == 0);
assert (Market.MAX_WATCHLIST == 60);
