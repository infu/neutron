import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Memory "../backend/memory/state/v1";
import App "../backend/main";
import Capabilities "mo:neutron-capabilities";

let owner = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
let broker : Capabilities.BackendCallsV1 = {
    canister_principal = owner;
    can_call = func(_canister : Principal, _method : Text) : Bool { true };
    call = func(_request : Capabilities.BackendCallRequestV1) : async* Capabilities.BackendCallResultV1 { #err({ code = "test"; message = "No network" }) };
    call_batch = func(_requests : [Capabilities.BackendCallRequestV1]) : async* [Capabilities.BackendCallResultV1] { [] };
};
let memory = Memory.init();
let app = App.Init({ stable_memory = { state = memory }; capabilities = { backend_calls = broker } });
let production = Principal.fromText("sj2r4-haaaa-aaaay-aadgq-cai");
assert app.marketplace_state(()).canister == ?production;
assert app.marketplace_state(()).host == "https://icp-api.io";
assert app.marketplace_state(()).revision == 1;
assert app.marketplace_state(()).seed == null;
switch (app.marketplace_initialize(Blob.fromArray([1, 2]))) { case (#err(_)) {}; case (_) assert false };
let seed : Blob = "01234567890123456789012345678901";
ignore app.marketplace_initialize(seed);
ignore app.marketplace_initialize("11234567890123456789012345678901");
assert app.marketplace_state(()).seed == ?seed;
ignore app.marketplace_save_draft({ id = "purchase-1"; value = "original" });
switch (app.marketplace_save_draft({ id = "purchase-1"; value = "replacement" })) { case (#err(_)) {}; case (_) assert false };
assert app.marketplace_draft("purchase-1") == ?"original";
let restored = App.Init({ stable_memory = { state = memory }; capabilities = { backend_calls = broker } });
assert restored.marketplace_state(()).seed == ?seed;
assert restored.marketplace_state(()).canister == ?production;
assert restored.marketplace_state(()).revision == 2;
assert restored.marketplace_draft("purchase-1") == ?"original";
assert restored.marketplace_drafts({ cursor = null; limit = 1 }).items.size() == 1;
ignore app.marketplace_save_draft({ id = "purchase-2"; value = "second" });
let firstPage = restored.marketplace_drafts({ cursor = null; limit = 1 });
assert firstPage.nextCursor == ?"purchase-1";
let secondPage = restored.marketplace_drafts({ cursor = firstPage.nextCursor; limit = 1 });
assert secondPage.items[0].id == "purchase-2";
assert secondPage.items[0].value == "second";
assert secondPage.nextCursor == null;
// Revisions preserve the previous bytes and compare the exact expected value.
switch (restored.marketplace_revise_draft({ id = "purchase-1"; expected = "wrong"; value = "changed"; revision = "revision-1" })) { case (#err(_)) {}; case (_) assert false };
assert restored.marketplace_draft("purchase-1") == ?"original";
ignore restored.marketplace_revise_draft({ id = "purchase-1"; expected = "original"; value = "changed"; revision = "revision-1" });
assert restored.marketplace_draft("purchase-1") == ?"changed";
assert restored.marketplace_draft("history:purchase-1:revision-1") == ?"original";
ignore restored.marketplace_revise_draft({ id = "purchase-1"; expected = "original"; value = "changed"; revision = "revision-1" });
switch (restored.marketplace_revise_draft({ id = "purchase-1"; expected = "original"; value = "competing"; revision = "revision-2" })) { case (#err(_)) {}; case (_) assert false };
assert restored.marketplace_draft("purchase-1") == ?"changed";
let restoredRevision = App.Init({ stable_memory = { state = memory }; capabilities = { backend_calls = broker } });
assert restoredRevision.marketplace_draft("history:purchase-1:revision-1") == ?"original";
// The existing v1 root stores opaque draft bytes. New optional installation
// diagnostics preserve older drafts and their revision history on restoration.
let originalInstall : Blob = "{\"version\":1,\"setupUrl\":null}";
let unavailableInstall : Blob = "{\"version\":1,\"setupUrl\":null,\"unavailableReason\":\"Saved release retired\"}";
ignore restoredRevision.marketplace_save_draft({ id = "installation-1"; value = originalInstall });
ignore restoredRevision.marketplace_revise_draft({ id = "installation-1"; expected = originalInstall; value = unavailableInstall; revision = "retirement" });
let restoredInstall = App.Init({ stable_memory = { state = memory }; capabilities = { backend_calls = broker } });
assert restoredInstall.marketplace_draft("installation-1") == ?unavailableInstall;
assert restoredInstall.marketplace_draft("history:installation-1:retirement") == ?originalInstall;
// Restore the released v1 root before it had a deployed default. Adopt only
// the missing configuration; retain the read identity and opaque journal.
let unconfigured = Memory.init();
unconfigured.seed := ?seed;
unconfigured.revision := 8;
Map.add(unconfigured.drafts, Text.compare, "legacy-request", "legacy-data");
let adopted = App.Init({ stable_memory = { state = unconfigured }; capabilities = { backend_calls = broker } });
assert adopted.marketplace_state(()).canister == ?production;
assert adopted.marketplace_state(()).seed == ?seed;
assert adopted.marketplace_state(()).revision == 9;
assert adopted.marketplace_draft("legacy-request") == ?"legacy-data";
let adoptedAgain = App.Init({ stable_memory = { state = unconfigured }; capabilities = { backend_calls = broker } });
assert adoptedAgain.marketplace_state(()).revision == 9;
// A deliberately configured local or alternate protocol remains selected
// across initialization and upgrade, with its exact host and revision.
ignore adopted.marketplace_configure({ canister = owner; host = "http://127.0.0.1:4943" });
let custom = App.Init({ stable_memory = { state = unconfigured }; capabilities = { backend_calls = broker } });
assert custom.marketplace_state(()).canister == ?owner;
assert custom.marketplace_state(()).host == "http://127.0.0.1:4943";
assert custom.marketplace_state(()).revision == 10;
assert custom.marketplace_state(()).seed == ?seed;
assert custom.marketplace_draft("legacy-request") == ?"legacy-data";
assert App.allowed("purchase");
assert App.allowed("ethereum_prepare");
assert App.allowed("ethereum_verify");
assert App.allowed("ethereum_settle");
assert App.allowed("ethereum_cancel");
assert not App.allowed("ethereum_status");
assert not App.allowed("ethereum_history");
assert not App.allowed("icrc1_transfer");
assert not App.allowed("catalog");
