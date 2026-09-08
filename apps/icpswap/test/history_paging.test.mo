import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Actions "../backend/icpswap/Actions";
import Memory "../backend/memory/icpswap_actions/v1";

func ok<T>(value : Actions.Result<T>) : T {
    switch (value) { case (#ok(v)) v; case (#err(e)) Runtime.trap(e) };
};
func fails<T>(value : Actions.Result<T>) {
    switch (value) { case (#err(_)) {}; case (#ok(_)) Runtime.trap("Expected invalid page to fail") };
};
let memory = Memory.init();
let journal = Actions.Journal(memory, func() : Int { 1_000_000 }, func(_) { false });
let large = Text.join(Array.tabulate<Text>(10_000, func(_) { "x" }).vals(), "");
let pool = Principal.fromText("mohjv-bqaaa-aaaag-qjyia-cai");
func saved(index : Nat) : Memory.Operation = {
    id = "operation-" # Nat.toText(index);
    input_json = "{\"version\":1,\"kind\":\"liquidity\",\"input\":{\"kind\":\"mint\",\"pool\":\"mohjv-bqaaa-aaaag-qjyia-cai\",\"amount0\":\"9007199254740993\"}}";
    plan_json = large; plan_blob = Blob.fromArray([1, 2, 3]); funding_json = large;
    state = "uncertain"; detail = "Lost protocol reply; preserve original funding and dispatch.";
    result_json = large; revision = 9007199254740993;
    created_at = index / 3; updated_at = index / 3;
    effects = [{ key = "deposit0"; canister = pool; method = "deposit";
        args = Blob.fromArray([1, 2, 3]); state = "uncertain"; reply = null;
        error = "The original request is uncertain; do not repeat it.";
        dispatched_at = index; completed_at = null }];
};
for (index in Nat.range(0, 173)) {
    let value = saved(index);
    Map.add(memory.operations, Text.compare, value.id, value);
};
assert large.size() * 3 * Map.size(memory.operations) > 65_536;
let before = Map.get(memory.operations, Text.compare, "operation-4");
let first = ok(journal.page({ cursor = null; limit = 50 }));
assert first.items.size() == 50;
assert first.items[0].id == "operation-171";
assert first.items[1].id == "operation-172";
assert first.items[0].effects[0].canister == Principal.toText(pool);
assert first.items[0].effects[0].state == "uncertain";
assert first.items[0].revision == 9007199254740993;

// Concurrent progress and newer actions cannot move the cursor or displace
// older results, because ordering uses immutable created time and ID.
let ?old = Map.get(memory.operations, Text.compare, "operation-4") else Runtime.trap("Missing fixture");
ignore journal.mark(old.id, "stopped", old.detail, "");
let newer = { saved(999) with created_at = 1_000_001; updated_at = 1_000_001 };
Map.add(memory.operations, Text.compare, newer.id, newer);
let seen = Map.empty<Text, Bool>();
for (item in first.items.vals()) { Map.add(seen, Text.compare, item.id, true) };
var cursor = first.next_cursor;
var count = first.items.size();
var pages = 1;
label rest loop {
    switch (cursor) {
        case null { break rest };
        case (?_) {
            let page = ok(journal.page({ cursor; limit = 50 }));
            assert page.items.size() > 0 and page.items.size() <= 50;
            for (item in page.items.vals()) {
                assert Map.get(seen, Text.compare, item.id) == null;
                assert item.id != newer.id;
                Map.add(seen, Text.compare, item.id, true);
            };
            count += page.items.size();
            pages += 1;
            cursor := page.next_cursor;
        };
    };
};
assert count == 173 and pages == 4;
assert (ok(journal.page({ cursor = null; limit = 500 }))).items.size() == 174;
assert (ok(journal.page({ cursor = null; limit = 174 }))).next_cursor == null;
let ?after = Map.get(memory.operations, Text.compare, "operation-4") else Runtime.trap("Paging removed a retained action");
assert after.funding_json == old.funding_json and after.plan_blob == old.plan_blob and after.result_json == old.result_json;
assert before != null;
fails(journal.page({ cursor = ?"unknown"; limit = 20 }));
fails(journal.page({ cursor = null; limit = 0 }));
let empty = Actions.Journal(Memory.init(), func() : Int { 0 }, func(_) { false });
assert ok(empty.page({ cursor = null; limit = 20 })) == { items = []; next_cursor = null };
