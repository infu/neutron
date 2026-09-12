import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Capabilities "mo:neutron-capabilities";
import App "../backend/main";
import Config "../backend/config";
import Memory "../backend/memory/state/v1";

let owner = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
let protocol = Principal.fromText(Config.PROTOCOL_CANISTER);
var sent : [Capabilities.BackendCallRequestV1] = [];
var callResult : Capabilities.BackendCallResultV1 = #ok("protocol reply");
let broker : Capabilities.BackendCallsV1 = {
    canister_principal = owner;
    can_call = func(_canister : Principal, _method : Text) : Bool { true };
    call = func(request : Capabilities.BackendCallRequestV1) : async* Capabilities.BackendCallResultV1 {
        sent := [request];
        callResult;
    };
    call_batch = func(_requests : [Capabilities.BackendCallRequestV1]) : async* [Capabilities.BackendCallResultV1] {
        assert false;
        [];
    };
};

let memory = Memory.init();
assert memory.seed == null;
assert Map.size(memory.drafts) == 0;
let app = App.Init({ stable_memory = { state = memory }; capabilities = { backend_calls = broker } });
assert app.feedback_state(()) == { seed = null; owner };
assert app.feedback_draft("missing") == null;
assert app.feedback_drafts({ cursor = null; limit = 10 }) == { items = []; nextCursor = null };

// Concurrent initializers must converge on the first persisted identity.
switch (app.feedback_initialize("short")) { case (#err(_)) {}; case (_) assert false };
assert app.feedback_state(()).seed == null;
let seed : Blob = "01234567890123456789012345678901";
switch (app.feedback_initialize(seed)) {
    case (#ok(state)) assert state == { seed = ?seed; owner };
    case (_) assert false;
};
switch (app.feedback_initialize("11234567890123456789012345678901")) {
    case (#ok(state)) assert state.seed == ?seed;
    case (_) assert false;
};

// Retrying the same intent is safe; changing its payload never overwrites it.
let intent = { id = "create-1"; value = "{\"body\":\"An issue\"}" : Blob };
assert app.feedback_save_draft(intent) == #ok("create-1");
assert app.feedback_save_draft(intent) == #ok("create-1");
switch (app.feedback_save_draft({ id = intent.id; value = "replacement" })) {
    case (#err(_)) {};
    case (_) assert false;
};
switch (app.feedback_save_draft({ id = "bad-utf8"; value = Blob.fromArray([255]) })) {
    case (#err(_)) {};
    case (_) assert false;
};
assert app.feedback_draft(intent.id) == ?intent.value;
assert app.feedback_draft("bad-utf8") == null;
assert Map.size(memory.drafts) == 1;

// Reconstruct the app over the installed root, as a code-only upgrade does.
let restored = App.Init({ stable_memory = { state = memory }; capabilities = { backend_calls = broker } });
assert restored.feedback_state(()) == { seed = ?seed; owner };
assert restored.feedback_draft(intent.id) == ?intent.value;
assert Map.size(memory.drafts) == 1;
assert restored.feedback_drafts({ cursor = null; limit = 10 }) == { items = [intent]; nextCursor = null };
let cleanMemory = Memory.init();
let clean = App.Init({ stable_memory = { state = cleanMemory }; capabilities = { backend_calls = broker } });
assert clean.feedback_state(()).seed == null;
assert clean.feedback_draft(intent.id) == null;

await async {
    // All application mutations use exactly the package's pinned canister,
    // with opaque Candid bytes preserved and no cycle transfer.
    for (method in ["read_delegate_set", "thread_create", "reply", "moderation_reply", "mark_read", "issue_status_set"].values()) {
        assert App.allowed(method);
        sent := [];
        let args : Blob = "\44\49\44\4c\00\00";
        assert (await* restored.feedback_call({ method; args })) == #ok("protocol reply");
        assert sent.size() == 1;
        assert sent[0] == { canister = protocol; method; args; cycles = 0 };
    };

    // Reads, arbitrary calls and administrator role management do not enter
    // the backend broker; moderator permissions stay enforced by the protocol.
    for (method in ["moderator_set", "session", "thread_get", "my_threads", "icrc1_transfer", "thread_create ", ""].values()) {
        assert not App.allowed(method);
        sent := [];
        switch (await* restored.feedback_call({ method; args = "" })) {
            case (#err(_)) {};
            case (_) assert false;
        };
        assert sent.size() == 0;
    };

    callResult := #err({ code = "denied"; message = "Protocol access disabled" });
    assert (await* restored.feedback_call({ method = "reply"; args = "" })) == #err("denied: Protocol access disabled");
    assert restored.feedback_state(()).seed == ?seed;
    assert restored.feedback_draft(intent.id) == ?intent.value;
};

// Completing a different payload must not remove an unresolved operation.
switch (restored.feedback_complete_draft({ id = intent.id; value = "different request" })) {
    case (#err(_)) {};
    case (_) assert false;
};
assert restored.feedback_draft(intent.id) == ?intent.value;
switch (restored.feedback_complete_draft({ id = intent.id; value = Blob.fromArray([255]) })) {
    case (#err(_)) {};
    case (_) assert false;
};
assert restored.feedback_draft(intent.id) == ?intent.value;
assert restored.feedback_complete_draft(intent) == #ok(intent.id);
assert restored.feedback_draft(intent.id) == null;
assert Map.size(memory.drafts) == 0;
assert restored.feedback_complete_draft(intent) == #ok(intent.id);
let afterCompletion = App.Init({ stable_memory = { state = memory }; capabilities = { backend_calls = broker } });
assert afterCompletion.feedback_draft(intent.id) == null;
assert afterCompletion.feedback_state(()).seed == ?seed;
assert afterCompletion.feedback_drafts({ cursor = null; limit = 10 }) == { items = []; nextCursor = null };

// Pending intents remain discoverable across app restoration, in a stable
// order with an exclusive cursor, including when its previous row is removed.
let first : App.Draft = { id = "request-a"; value = "first" };
let second : App.Draft = { id = "request-b"; value = "second" };
let third : App.Draft = { id = "request-c"; value = "third" };
assert afterCompletion.feedback_save_draft(third) == #ok(third.id);
assert afterCompletion.feedback_save_draft(first) == #ok(first.id);
assert afterCompletion.feedback_save_draft(second) == #ok(second.id);
let pendingRestored = App.Init({ stable_memory = { state = memory }; capabilities = { backend_calls = broker } });
assert pendingRestored.feedback_drafts({ cursor = null; limit = 2 }) == { items = [first, second]; nextCursor = ?second.id };
assert pendingRestored.feedback_drafts({ cursor = ?second.id; limit = 2 }) == { items = [third]; nextCursor = null };
assert pendingRestored.feedback_drafts({ cursor = ?third.id; limit = 2 }) == { items = []; nextCursor = null };
assert pendingRestored.feedback_drafts({ cursor = ?"request-bb"; limit = 2 }) == { items = [third]; nextCursor = null };
assert pendingRestored.feedback_drafts({ cursor = null; limit = 0 }).items == [];
assert pendingRestored.feedback_drafts({ cursor = null; limit = 100 }) == { items = [first, second, third]; nextCursor = null };
assert pendingRestored.feedback_complete_draft(second) == #ok(second.id);
assert pendingRestored.feedback_drafts({ cursor = ?second.id; limit = 2 }) == { items = [third]; nextCursor = null };
assert pendingRestored.feedback_drafts({ cursor = null; limit = 1 }) == { items = [first]; nextCursor = ?first.id };
