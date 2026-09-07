import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Text "mo:core/Text";
import Curve "../backend/main";
import Memory "../backend/memory/curve/v1";

func ok(result : Curve.ResultV1) : Curve.OperationV1 {
    switch (result) { case (#ok(value)) value; case (#err(_)) { assert false; loop {} } };
};
func reject(result : Curve.ResultV1) { switch (result) { case (#err(message)) assert (message != ""); case (_) assert false } };
func page(result : Curve.PageResultV1) : Curve.PageV1 {
    switch (result) { case (#ok(value)) value; case (#err(_)) { assert false; loop {} } };
};
let memory = Memory.init();
assert (Map.size(memory.operations) == 0 and Map.size(memory.pools) == 0);
let app = Curve.Init({ stable_memory = { curve = memory } });
assert (app.curve_get_v1("missing") == null);
assert (page(app.curve_page_v1({ cursor = null; limit = 10 })).rows == []);
let input : Curve.BeginV1 = {
    id = "root-0"; root_id = "root-0";
    input_json = "{\"chainId\":\"42161\",\"amount\":\"10000000000000000000001\",\"caller\":\"agent/17\"}";
    summary = "Add liquidity";
    state_json = "{\"requestId\":\"original-request\",\"dispatched\":false}";
    phase = "ready";
};
let begun = ok(app.curve_begin_v1(input));
assert (begun.revision == 0);
assert (ok(app.curve_begin_v1(input)) == begun);
reject(app.curve_begin_v1({ input with root_id = "another-root" }));
reject(app.curve_begin_v1({ input with input_json = "different caller" }));
reject(app.curve_begin_v1({ input with summary = "different summary" }));
let update : Curve.UpdateV1 = {
    id = input.id; expected_revision = 0;
    state_json = "{\"requestId\":\"original-request\",\"dispatched\":true,\"unresolved\":true,\"approved\":\"0x1234\"}";
    phase = "requested";
};
let pending = ok(app.curve_update_v1(update));
assert (pending.revision == 1 and pending.input_json == input.input_json);
assert (ok(app.curve_update_v1(update)) == pending);
reject(app.curve_update_v1({ update with state_json = input.state_json }));
reject(app.curve_update_v1({ update with expected_revision = 2 }));
let restored = Curve.Init({ stable_memory = { curve = memory } });
assert (restored.curve_get_v1(input.id) == ?pending);
assert (ok(restored.curve_begin_v1({ input with state_json = "new plan"; phase = "ready" })) == pending);
let completed = ok(restored.curve_update_v1({ update with expected_revision = 1; state_json = "{\"requestId\":\"original-request\",\"receipt\":\"matching-success\"}"; phase = "complete" }));
assert (completed.created_at == begun.created_at and completed.revision == 2);
assert (Curve.Init({ stable_memory = { curve = memory } }).curve_get_v1(input.id) == ?completed);
let pool : Curve.PoolV1 = { chain_id = 42161; address = "0xABCDEF"; family = "stable-ng" };
ignore restored.curve_track_pool_v1(pool);
ignore restored.curve_track_pool_v1({ pool with address = "0xabcdef" });
assert (Map.size(memory.pools) == 1);
assert (Curve.Init({ stable_memory = { curve = memory } }).curve_tracked_pools_v1(42161) == [{ pool with address = "0xabcdef" }]);
assert (restored.curve_tracked_pools_v1(1) == []);
// Renewed attempts remain attached to their original root, while history pages
// exclude large bodies without deleting any operation or pending identity.
ignore ok(restored.curve_begin_v1({ input with id = "child-1" }));
assert (page(restored.curve_page_v1({ cursor = null; limit = 10 })).rows.size() == 1);
var payload = "0123456789abcdef";
var repeat = 0;
while (repeat < 8) { payload #= payload; repeat += 1 };
var i = 0;
while (i < 40) {
    let id = "history-" # Nat.toText(i);
    ignore ok(restored.curve_begin_v1({ input with id; root_id = id; state_json = payload }));
    i += 1;
};
assert (Map.size(memory.operations) == 42);
let visited = Map.empty<Text, Bool>();
var cursor : ?Text = null;
label pages loop {
    let next = page(restored.curve_page_v1({ cursor; limit = 7 }));
    for (row in next.rows.vals()) { assert (Map.get(visited, Text.compare, row.id) == null); Map.add(visited, Text.compare, row.id, true) };
    cursor := next.next_cursor;
    if (cursor == null) break pages;
};
assert (Map.size(visited) == 41 and Map.size(memory.operations) == 42);
assert (Map.get(visited, Text.compare, "child-1") == null);
switch (restored.curve_page_v1({ cursor = ?"absent"; limit = 1 })) { case (#err(_)) {}; case (_) assert false };
switch (restored.curve_page_v1({ cursor = null; limit = 0 })) { case (#err(_)) {}; case (_) assert false };
