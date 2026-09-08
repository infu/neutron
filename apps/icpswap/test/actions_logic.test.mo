import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Actions "../backend/icpswap/Actions";
import Memory "../backend/memory/icpswap_actions/v1";
import Liquidity "../backend/icpswap/Liquidity";

func ok<T>(value : Actions.Result<T>) : T {
    switch (value) { case (#ok(v)) v; case (#err(e)) Runtime.trap(e) };
};
func fails<T>(value : Actions.Result<T>) {
    switch (value) { case (#err(_)) {}; case (#ok(_)) Runtime.trap("Expected a rejected state transition") };
};
let memory = Memory.init();
assert Map.size(memory.operations) == 0;
var time = 1;
let journal = Actions.Journal(memory, func() : Int { time += 1; time }, func(_ : Text) : Bool { false });
let initial = { id = "same-id"; input_json = "exact intent"; plan_json = "exact plan"; funding_json = "old unsent funding" };
let created = ok(journal.begin(initial));
assert created.state == "prepared" and created.revision == 0;
assert ok(journal.begin(initial)) == created;
fails(journal.begin({ initial with input_json = "another intent" }));
fails(journal.begin({ initial with plan_json = "another plan" }));
assert Map.size(memory.operations) == 1;
let fresh = ok(journal.update({ id = created.id; expected_revision = 0; state = "prepared";
    funding_json = "renewed unsent funding"; detail = "reviewed a new expiry"; result_json = "" }));
assert fresh.revision == 1;
fails(journal.update({ id = created.id; expected_revision = 0; state = "prepared";
    funding_json = "stale"; detail = ""; result_json = "" }));
let requested = ok(journal.update({ id = created.id; expected_revision = fresh.revision; state = "funding_requested";
    funding_json = fresh.funding_json; detail = "before Wallet"; result_json = "exact Wallet request marker" }));
fails(journal.update({ id = created.id; expected_revision = requested.revision; state = "funded";
    funding_json = "replaced after dispatch"; detail = ""; result_json = "" }));
fails(journal.update({ id = created.id; expected_revision = requested.revision; state = "prepared";
    funding_json = requested.funding_json; detail = ""; result_json = "" }));
let funded = ok(journal.update({ id = created.id; expected_revision = requested.revision; state = "funded";
    funding_json = requested.funding_json; detail = "Wallet confirmed original request"; result_json = "exact Wallet funding receipts" }));
let pool = Principal.fromText("mohjv-bqaaa-aaaag-qjyia-cai");
let request = { canister = pool; method = "depositFrom"; args = Blob.fromArray([1, 2, 3]); cycles = 0 };
let dispatched = ok(journal.dispatch(created.id, funded.revision, "deposit0", request));
assert dispatched.state == "execution_requested" and dispatched.effects.size() == 1;
let restored = Actions.Journal(memory, func() : Int { 100 }, func(_ : Text) : Bool { false });
let ?raw = restored.raw(created.id) else Runtime.trap("Operation lost across restore");
assert raw.effects[0].args == request.args and raw.effects[0].state == "requested";
assert raw.funding_json == "renewed unsent funding" and raw.result_json == "exact Wallet funding receipts";
fails(restored.dispatch(created.id, raw.revision, "deposit0", request));
fails(restored.dispatch(created.id, raw.revision, "mint", { request with method = "mint" }));
let uncertain = ok(restored.finish(created.id, "deposit0", "uncertain", null, "Lost ledger reply"));
fails(restored.dispatch(created.id, uncertain.revision, "deposit0", request));
fails(restored.update({ id = created.id; expected_revision = uncertain.revision; state = "funded";
    funding_json = uncertain.funding_json; detail = "pretend recovery"; result_json = "" }));
fails(restored.finish(created.id, "deposit0", "succeeded", null, "late second reply"));
assert (ok(restored.mark(created.id, "uncertain", "retained diagnostics", ""))).result_json == "exact Wallet funding receipts";

// Successful prerequisites can advance once; a restored executor cannot
// rewrite the original funding identity or replay a completed dispatch.
let success = ok(restored.begin({ initial with id = "success"; funding_json = "" }));
let first = ok(restored.dispatch(success.id, success.revision, "deposit0", request));
assert first.effects[0].state == "requested";
let done = ok(restored.finish(success.id, "deposit0", "succeeded", null, ""));
fails(restored.dispatch(success.id, done.revision, "deposit0", request));
let second = ok(restored.dispatch(success.id, done.revision, "mint", { request with method = "mint" }));
assert second.effects.size() == 2;
let rejected = ok(restored.finish(success.id, "mint", "failed", null, "Pool rejected mint; unused deposits remain"));
assert rejected.state == "stopped";
fails(restored.dispatch(success.id, rejected.revision, "mint-again", { request with method = "mint" }));
assert restored.list().size() == 2;
// Importing the service also type-checks all async protocol paths in the
// browser compiler; the companion actor test exercises real Candid replies.
ignore Liquidity.Service;
