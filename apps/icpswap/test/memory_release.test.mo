import Principal "mo:core/Principal";
import Map "mo:core/Map";
import Text "mo:core/Text";
import Caps "mo:neutron-capabilities";
import App "../backend/main";
import Memory "../backend/memory/icpswap/v1";
import SwapMemory "../backend/memory/icpswap_swap/v1";
import ActionsMemory "../backend/memory/icpswap_actions/v1";

// A backend-call stub. The Motoko interpreter used by this harness cannot
// evaluate `to_candid`, so tests never dispatch; the stub exists so `Init` can
// be constructed and every synchronous method type-checked and exercised.
let stubCalls : Caps.BackendCallsV1 = {
    canister_principal = Principal.fromText("aaaaa-aa");
    owns_principal = func(_ : Principal) : Bool { false };
    can_call = func(_ : Principal, _ : Text) : Bool = false;
    call = func(_ : Caps.BackendCallRequestV1) : async* Caps.BackendCallResultV1 {
        #err({ code = "stub"; message = "calls are not dispatched in tests" });
    };
    call_batch = func(
        _ : [Caps.BackendCallRequestV1]
    ) : async* [Caps.BackendCallResultV1] { [] };
};

func environment(mem : Memory.Mem) : App.AppBackendEnvironment {
    {
        stable_memory = { icpswap = mem; icpswap_swap = SwapMemory.init(); icpswap_actions = ActionsMemory.init() };
        capabilities = { backend_calls = stubCalls };
    };
};

// --- clean initialization uses the released v1 defaults ---------------------
let memory = Memory.init();
assert (Map.size(memory.watchlist) == 0);
assert (Map.size(memory.history) == 0);
assert (Map.size(memory.quotes) == 0);
assert (Map.size(memory.decimals) == 0);
assert (memory.last_refresh_at == 0);
assert (memory.refresh_count == 0);
assert (memory.history_limit == 720);
assert (memory.icp_price_usd == 0.0);

let app = App.Init(environment(memory));

let emptyStatus = app.icpswap_status();
assert (emptyStatus.watchlist_size == 0);
assert (emptyStatus.universe_tokens == 0);
assert (not emptyStatus.cache_ready);
assert (emptyStatus.history_limit == 720);

let emptyMarket = app.icpswap_market({ sort = "price"; ascending = false });
assert (emptyMarket.rows.size() == 0);
assert (emptyStatus.priced_tokens == 0);
assert (emptyStatus.pending_decimals == 0);

// --- watchlist mutations ---------------------------------------------------
let bad = app.icpswap_add({
    address = "NOT A CANISTER";
    symbol = "X";
    name = "X";
    standard = "ICRC1";
    decimals = 8;
});
assert (not bad.ok);
assert (bad.watchlist_size == 0);

let added = app.icpswap_add({
    address = "ryjl3-tyaaa-aaaaa-aaaba-cai";
    symbol = "ICP";
    name = "Internet Computer";
    standard = "ICRC2";
    decimals = 8;
});
assert (added.ok);
assert (added.watchlist_size == 1);
assert (Map.size(memory.watchlist) == 1);

// Adding the same token twice is idempotent, not an error.
let again = app.icpswap_add({
    address = "ryjl3-tyaaa-aaaaa-aaaba-cai";
    symbol = "ICP";
    name = "Internet Computer";
    standard = "ICRC2";
    decimals = 8;
});
assert (again.ok);
assert (again.watchlist_size == 1);

let second = app.icpswap_add({
    address = "mxzaz-hqaaa-aaaar-qaada-cai";
    symbol = "ckBTC";
    name = "ckBTC";
    standard = "ICRC2";
    decimals = 8;
});
assert (second.ok);
assert (second.watchlist_size == 2);

// Pinning reorders the market table ahead of the sort key.
let pinned = app.icpswap_set_pinned({
    address = "mxzaz-hqaaa-aaaar-qaada-cai";
    pinned = true;
});
assert (pinned.ok);
let ordered = app.icpswap_market({ sort = "symbol"; ascending = true });
assert (ordered.rows.size() == 2);
assert (ordered.rows[0].symbol == "ckBTC");
assert (ordered.rows[0].pinned);
// Nothing has been priced, so no row may claim a price.
assert (ordered.rows[0].price_usd == 0.0);
assert (ordered.rows[0].quote == null);

// Notes are stored and bounded.
let noted = app.icpswap_set_note({
    address = "ryjl3-tyaaa-aaaaa-aaaba-cai";
    note = "  core network asset  ";
});
assert (noted.ok);
let withNote = app.icpswap_token("ryjl3-tyaaa-aaaaa-aaaba-cai");
switch (withNote) {
    case null assert false;
    case (?detail) {
        assert (detail.row.note == "core network asset");
        assert (detail.row.symbol == "ICP");
        assert (detail.pools.size() == 0);
        assert (detail.history.size() == 0);
        assert (detail.profile == null);
        assert (detail.row.price_usd == 0.0);
    };
};

// An unwatched token has no detail.
assert (app.icpswap_token("aaaaa-aa") == null);
assert (app.icpswap_token("!!!") == null);

// Search over an empty universe is well formed.
let search = app.icpswap_search({ term = "icp"; offset = 0; limit = 10 });
assert (search.items.size() == 0);
assert (search.total == 0);
assert (search.universe == 0);

// History for a watched token starts empty and reports its cap.
let history = app.icpswap_history({
    address = "ryjl3-tyaaa-aaaaa-aaaba-cai";
    limit = 50;
});
assert (history.samples.size() == 0);
assert (history.total == 0);
assert (history.history_limit == 720);

// Removing keeps recorded history; forgetting clears it.
ignore Map.insert(
    memory.history,
    Text.compare,
    "mxzaz-hqaaa-aaaar-qaada-cai",
    [{ t = 1; price_usd = 1.0; price_icp = 1.0 }],
);
let removed = app.icpswap_remove("mxzaz-hqaaa-aaaar-qaada-cai");
assert (removed.ok);
assert (removed.watchlist_size == 1);
assert (Map.containsKey(memory.history, Text.compare, "mxzaz-hqaaa-aaaar-qaada-cai"));

let forgotten = app.icpswap_forget("mxzaz-hqaaa-aaaar-qaada-cai");
assert (forgotten.ok);
assert (not Map.containsKey(memory.history, Text.compare, "mxzaz-hqaaa-aaaar-qaada-cai"));

// Resolved ledger decimals survive a watchlist change: they never expire.
ignore Map.insert(memory.decimals, Text.compare, "ryjl3-tyaaa-aaaaa-aaaba-cai", 8);
switch (app.icpswap_market({ sort = "price"; ascending = false }).rows[0].decimals) {
    case (8) {};
    case (_) assert false;
};

// --- a state-preserving upgrade restores the retained root ------------------
let restored = App.Init(environment(memory));
let restoredMarket = restored.icpswap_market({
    sort = "price";
    ascending = false;
});
assert (restoredMarket.rows.size() == 1);
assert (restoredMarket.rows[0].address == "ryjl3-tyaaa-aaaaa-aaaba-cai");
assert (restoredMarket.rows[0].note == "core network asset");
// The derived universe cache is intentionally not persisted.
assert (not restored.icpswap_status().cache_ready);

// Both released roots survive a code-only successor with representative data.
// Swap identities and ambiguous records are recovery evidence and must not be
// replaced by fresh initialization just because the app moved repositories.
let swapMemory = SwapMemory.init();
assert (Map.size(swapMemory.records) == 0);
assert (swapMemory.order == []);
assert (swapMemory.limit == 100);
assert (swapMemory.slippage == 500);
assert (swapMemory.completed == 0);

let swapStates : [(Text, SwapMemory.SwapState)] = [
    ("00000000000000000000000000000001", #planned),
    ("00000000000000000000000000000002", #funded),
    ("00000000000000000000000000000003", #swapped),
    ("00000000000000000000000000000004", #settled),
    ("00000000000000000000000000000005", #refunded),
    ("00000000000000000000000000000006", #failed),
    ("00000000000000000000000000000007", #ambiguous),
];
for ((id, state) in swapStates.vals()) {
    let record : SwapMemory.SwapRecord = {
        request_id = id;
        pool = "4mmnk-kiaaa-aaaag-qbllq-cai";
        pool_key = "input_output_3000";
        input_address = "xevnm-gaaaa-aaaar-qafnq-cai";
        output_address = "ryjl3-tyaaa-aaaaa-aaaba-cai";
        input_symbol = "ckUSDC";
        output_symbol = "ICP";
        amount_in = 1_000_000;
        amount_out_minimum = 9_007_199_254_740_993;
        quoted_out = 9_007_199_254_740_999;
        swapped_out = 9_007_199_254_740_997;
        token_in_fee = 10_000;
        token_out_fee = 10_000;
        slippage = 321;
        state;
        funding_status = "transferred";
        funding_block = "779646";
        detail = "Original funding request: reconcile this identity, do not replace it.";
        started_at = 1_788_881_933;
        updated_at = 1_788_882_000;
    };
    Map.add(swapMemory.records, Text.compare, id, record);
};
swapMemory.order := ["00000000000000000000000000000001", "00000000000000000000000000000002", "00000000000000000000000000000003", "00000000000000000000000000000004", "00000000000000000000000000000005", "00000000000000000000000000000006", "00000000000000000000000000000007"];
swapMemory.limit := 73;
swapMemory.slippage := 321;
swapMemory.completed := 19;

let retainedQuote : Memory.Quote = {
    pool = "input_output_3000";
    quote_address = "xevnm-gaaaa-aaaar-qafnq-cai";
    quote_symbol = "ckUSDC";
    fee_tier = 3_000;
    liquidity = 9_007_199_254_740_993;
    via_icp = false;
    price_usd = 4.57;
    price_icp = 1.0;
    at = 1_788_882_001;
};
let retainedSamples : [Memory.Sample] = [
    { t = 1_788_881_999; price_usd = 4.55; price_icp = 1.0 },
    { t = 1_788_882_001; price_usd = 4.57; price_icp = 1.0 },
];
Map.add(memory.quotes, Text.compare, "ryjl3-tyaaa-aaaaa-aaaba-cai", retainedQuote);
Map.add(memory.history, Text.compare, "ryjl3-tyaaa-aaaaa-aaaba-cai", retainedSamples);
memory.last_refresh_at := 1_788_882_001;
memory.last_refresh_error := ?"One upstream observation was unavailable.";
memory.refresh_count := 7;
memory.history_limit := 193;
memory.icp_price_usd := 4.57;

let swapEnvironment = {
    stable_memory = { icpswap = memory; icpswap_swap = swapMemory; icpswap_actions = ActionsMemory.init() };
    capabilities = { backend_calls = stubCalls };
};
let retainedApp = App.Init(swapEnvironment);
let retainedJournal = retainedApp.icpswap_swap_journal(50);
assert (retainedJournal.completed == 19);
assert (retainedJournal.slippage == 321);
assert (retainedJournal.entries.size() == 7);
assert (retainedJournal.entries[0].request_id == "00000000000000000000000000000007");
assert (retainedJournal.entries[0].state == "ambiguous");
assert (retainedJournal.entries[0].detail == "Original funding request: reconcile this identity, do not replace it.");
assert (retainedJournal.entries[0].funding_block == "779646");
assert (retainedJournal.entries[0].amount_out_minimum == 9_007_199_254_740_993);
for ((id, state) in swapStates.vals()) {
    switch (Map.get(swapMemory.records, Text.compare, id)) {
        case null assert false;
        case (?record) {
            assert (record.state == state);
            assert (record.request_id == id);
            assert (record.amount_in == 1_000_000);
            assert (record.quoted_out == 9_007_199_254_740_999);
            assert (record.swapped_out == 9_007_199_254_740_997);
            assert (record.funding_status == "transferred");
            assert (record.started_at == 1_788_881_933);
            assert (record.updated_at == 1_788_882_000);
        };
    };
};
assert (swapMemory.order == ["00000000000000000000000000000001", "00000000000000000000000000000002", "00000000000000000000000000000003", "00000000000000000000000000000004", "00000000000000000000000000000005", "00000000000000000000000000000006", "00000000000000000000000000000007"]);
assert (swapMemory.limit == 73);
let retainedAgain = App.Init(swapEnvironment);
assert (retainedAgain.icpswap_swap_journal(50) == retainedJournal);
assert (retainedAgain.icpswap_market({ sort = "price"; ascending = false }).rows[0].note == "core network asset");

assert (Map.get(memory.quotes, Text.compare, "ryjl3-tyaaa-aaaaa-aaaba-cai") == ?retainedQuote);
assert (Map.get(memory.history, Text.compare, "ryjl3-tyaaa-aaaaa-aaaba-cai") == ?retainedSamples);
assert (memory.last_refresh_at == 1_788_882_001);
assert (memory.last_refresh_error == ?"One upstream observation was unavailable.");
assert (memory.refresh_count == 7);
assert (memory.history_limit == 193);
assert (memory.icp_price_usd == 4.57);
