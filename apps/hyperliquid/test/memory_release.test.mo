import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Text "mo:core/Text";
import Hyperliquid "../backend/main";
import Memory "../backend/memory/hyperliquid/v1";

func ok(result : Hyperliquid.ResultV1) : Hyperliquid.OperationV1 {
    switch (result) { case (#ok(value)) value; case (#err(_)) { assert false; loop {} } };
};
func reject(result : Hyperliquid.ResultV1) { switch (result) { case (#err(message)) assert (message != ""); case (_) assert false } };
func page(result : Hyperliquid.PageResultV1) : Hyperliquid.PageV1 {
    switch (result) { case (#ok(value)) value; case (#err(_)) { assert false; loop {} } };
};
let memory = Memory.init();
assert (Map.size(memory.operations) == 0);
let app = Hyperliquid.Init({ stable_memory = { hyperliquid = memory } });
assert (app.hyperliquid_get_v1("missing") == null);
assert (page(app.hyperliquid_page_v1({ cursor = null; limit = 10 })).rows == []);
let input : Hyperliquid.BeginV1 = {
    id = "root-0"; root_id = "root-0";
    input_json = "{\"chainId\":\"1\",\"amount\":\"1000000001\",\"caller\":\"agent/17\",\"environment\":\"mainnet\"}";
    summary = "Deposit USDC";
    state_json = "{\"requestId\":\"original-request\",\"dispatched\":false}";
    phase = "ready";
};
let begun = ok(app.hyperliquid_begin_v1(input));
assert (begun.revision == 0);
assert (ok(app.hyperliquid_begin_v1(input)) == begun);
reject(app.hyperliquid_begin_v1({ input with id = "" }));
reject(app.hyperliquid_begin_v1({ input with id = "incomplete"; state_json = "" }));
reject(app.hyperliquid_begin_v1({ input with root_id = "another-root" }));
reject(app.hyperliquid_begin_v1({ input with input_json = "different caller" }));
reject(app.hyperliquid_begin_v1({ input with summary = "different summary" }));
let update : Hyperliquid.UpdateV1 = {
    id = input.id; expected_revision = 0;
    state_json = "{\"requestId\":\"original-request\",\"dispatched\":true,\"unresolved\":true,\"sourceTransactionHash\":\"0x1234\",\"messageNonce\":\"10000000000000000000001\"}";
    phase = "attestation_pending";
};
let pending = ok(app.hyperliquid_update_v1(update));
assert (pending.revision == 1 and pending.input_json == input.input_json);
assert (ok(app.hyperliquid_update_v1(update)) == pending);
reject(app.hyperliquid_update_v1({ update with state_json = input.state_json }));
reject(app.hyperliquid_update_v1({ update with expected_revision = 2 }));
let restored = Hyperliquid.Init({ stable_memory = { hyperliquid = memory } });
assert (restored.hyperliquid_get_v1(input.id) == ?pending);
assert (ok(restored.hyperliquid_begin_v1({ input with state_json = "new plan"; phase = "ready" })) == pending);
let completed = ok(restored.hyperliquid_update_v1({ update with expected_revision = 1; state_json = "{\"requestId\":\"original-request\",\"receipt\":\"matching-success\"}"; phase = "complete" }));
assert (completed.created_at == begun.created_at and completed.revision == 2);
assert (Hyperliquid.Init({ stable_memory = { hyperliquid = memory } }).hyperliquid_get_v1(input.id) == ?completed);
// Renewed attempts remain attached to their original root, while history pages
// exclude large bodies without deleting any operation or pending identity.
ignore ok(restored.hyperliquid_begin_v1({ input with id = "child-1" }));
assert (page(restored.hyperliquid_page_v1({ cursor = null; limit = 10 })).rows.size() == 1);
var payload = "0123456789abcdef";
var repeat = 0;
while (repeat < 8) { payload #= payload; repeat += 1 };
var i = 0;
while (i < 40) {
    let id = "history-" # Nat.toText(i);
    ignore ok(restored.hyperliquid_begin_v1({ input with id; root_id = id; state_json = payload }));
    i += 1;
};
assert (Map.size(memory.operations) == 42);
let visited = Map.empty<Text, Bool>();
var cursor : ?Text = null;
label pages loop {
    let next = page(restored.hyperliquid_page_v1({ cursor; limit = 7 }));
    for (row in next.rows.vals()) { assert (Map.get(visited, Text.compare, row.id) == null); Map.add(visited, Text.compare, row.id, true) };
    cursor := next.next_cursor;
    if (cursor == null) break pages;
};
assert (Map.size(visited) == 41 and Map.size(memory.operations) == 42);
assert (Map.get(visited, Text.compare, "child-1") == null);
switch (restored.hyperliquid_page_v1({ cursor = ?"absent"; limit = 1 })) { case (#err(_)) {}; case (_) assert false };
switch (restored.hyperliquid_page_v1({ cursor = null; limit = 0 })) { case (#err(_)) {}; case (_) assert false };
