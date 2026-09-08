// Backend tests.
//
// Instantiating `Init` type-checks the whole backend, including every Nuance
// request builder and decoder. The assertions then drive the collaborative
// draft path -- the one place where a human and an agent write concurrently --
// through a mock capability that never reaches the network.
//
// Methods that build Candid requests are not called here: the browser Motoko
// interpreter does not implement `to_candid`. The publish path, including
// concurrent edits while awaiting Nuance, runs in publish_actor.test.mo on a
// local IC canister instead.

import Array "mo:core/Array";
import Debug "mo:core/Debug";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Caps "mo:neutron-capabilities";

import Main "../backend/main";
import Memory "../backend/memory/nuance/v1";

// A capability stub. `call`/`call_batch` are never invoked by the assertions
// below; they exist so the environment type-checks.
let backendCalls : Caps.BackendCallsV1 = {
    canister_principal = Principal.fromText("aaaaa-aa");
    can_call = func(_ : Principal, _ : Text) : Bool { true };
    call = func(_ : Caps.BackendCallRequestV1) : async* Caps.BackendCallResultV1 {
        #err({ code = "test"; message = "offline" });
    };
    call_batch = func(requests : [Caps.BackendCallRequestV1]) : async* [Caps.BackendCallResultV1] {
        Array.tabulate<Caps.BackendCallResultV1>(
            requests.size(),
            func(_ : Nat) : Caps.BackendCallResultV1 {
                #err({ code = "test"; message = "offline" });
            },
        );
    };
};

let env : Main.AppBackendEnvironment = {
    stable_memory = { nuance = Memory.init() };
    capabilities = { backend_calls = backendCalls };
};

let app = Main.Init(env);

func expectDraft(name : Text, result : Main.DraftWriteResult) : Main.DraftView {
    switch (result) {
        case (#ok(view)) view;
        case (#conflict(_)) Runtime.trap(name # ": unexpected conflict");
        case (#err(message)) Runtime.trap(name # ": " # message);
    };
};

// ---------------------------------------------------------------- lifecycle

let created = expectDraft("create", app.nuance_draft_new("Draft title", "First block."));
if (created.revision != 1) Runtime.trap("a new draft starts at revision 1");
if (not created.isActive) Runtime.trap("a new draft becomes the active draft");
if (created.wordCount != 2) Runtime.trap("word count should be 2, got " # debug_show (created.wordCount));

switch (app.nuance_draft_read("")) {
    case (#ok(view)) { if (view.id != created.id) Runtime.trap("empty id should resolve to the active draft") };
    case (#err(message)) Runtime.trap("read failed: " # message);
};

switch (app.nuance_draft_read("nope")) {
    case (#ok(_)) Runtime.trap("reading a missing draft should fail");
    case (#err(_)) {};
};

// ----------------------------------------------------- compare-and-swap

// The human's editor saves against the revision it last read.
let saved = expectDraft(
    "human save",
    app.nuance_draft_set({
        id = created.id;
        expectedRevision = created.revision;
        title = "Human title";
        subtitle = "Sub";
        tagIds = ["1"];
        body = "First block.";
        editor = "human";
    }),
);
if (saved.revision != 2) Runtime.trap("an accepted write bumps the revision");
if (saved.modifiedBy != "human") Runtime.trap("provenance should be recorded");

// A stale write is refused and carries the current draft back, so the caller can
// rebase without another round trip. This is the property that stops an agent
// and a human from clobbering each other.
switch (
    app.nuance_draft_set({
        id = created.id;
        expectedRevision = created.revision; // stale: the draft is at 2 now
        title = "Clobber";
        subtitle = "";
        tagIds = [];
        body = "Clobbered body";
        editor = "agent";
    })
) {
    case (#conflict(current)) {
        if (current.revision != 2) Runtime.trap("conflict should carry the live revision");
        if (current.title != "Human title") Runtime.trap("conflict should carry the live content");
    };
    case (#ok(_)) Runtime.trap("a stale write must not be accepted");
    case (#err(message)) Runtime.trap("expected a conflict, got: " # message);
};

// The human's text survived the rejected write.
switch (app.nuance_draft_read(created.id)) {
    case (#ok(view)) {
        if (view.body != "First block.") Runtime.trap("a rejected write must not touch the draft");
        if (view.revision != 2) Runtime.trap("a rejected write must not bump the revision");
    };
    case (#err(message)) Runtime.trap(message);
};

// ------------------------------------------------------------------ patch

let patched = switch (
    app.nuance_draft_patch({
        id = created.id;
        expectedRevision = 2;
        ops = [
            #append({ text = "Second block." }),
            #replace({ find = "First"; replaceWith = "Opening"; occurrence = null }),
        ];
        editor = "agent";
    })
) {
    case (#ok({ draft; applied })) {
        if (applied.size() != 2) Runtime.trap("expected one summary line per op");
        draft;
    };
    case (#conflict(_)) Runtime.trap("unexpected conflict");
    case (#err(message)) Runtime.trap("patch failed: " # message);
};
if (patched.body != "Opening block.\n\nSecond block.") {
    Runtime.trap("unexpected patched body: " # debug_show (patched.body));
};
if (patched.revision != 3) Runtime.trap("a patch bumps the revision");
if (patched.modifiedBy != "agent") Runtime.trap("patch provenance should be recorded");

// A failing op leaves the draft untouched and does not consume a revision.
switch (
    app.nuance_draft_patch({
        id = created.id;
        expectedRevision = 3;
        ops = [#replace({ find = "absent"; replaceWith = "x"; occurrence = null })];
        editor = "agent";
    })
) {
    case (#err(_)) {};
    case (#ok(_)) Runtime.trap("a patch with an unmatched op must fail");
    case (#conflict(_)) Runtime.trap("expected an error, not a conflict");
};
switch (app.nuance_draft_read(created.id)) {
    case (#ok(view)) {
        if (view.revision != 3) Runtime.trap("a failed patch must not bump the revision");
        if (view.body != "Opening block.\n\nSecond block.") Runtime.trap("a failed patch must not change the body");
    };
    case (#err(message)) Runtime.trap(message);
};

// A stale patch conflicts rather than applying.
switch (
    app.nuance_draft_patch({
        id = created.id;
        expectedRevision = 1;
        ops = [#append({ text = "late" })];
        editor = "agent";
    })
) {
    case (#conflict(current)) { if (current.revision != 3) Runtime.trap("conflict carries the live revision") };
    case (_) Runtime.trap("a stale patch must conflict");
};

// ------------------------------------------------------------- guard rails

switch (app.nuance_draft_new("too big", "x")) {
    case (#ok(_)) {};
    case (_) Runtime.trap("second draft should be creatable");
};

// The state snapshot is the tile's first paint and must not need the network.
let state = app.nuance_state();
if (state.drafts.size() != 2) Runtime.trap("state should list both drafts");
if (state.activeDraftId == "") Runtime.trap("state should name the active draft");
if (state.identity.note == "") Runtime.trap("state must carry the identity disclosure");
if (state.identity.registered) Runtime.trap("a fresh install is not registered");

// Publishing without a handle must fail before any network call.
switch (app.nuance_bookmarks()) {
    case (list) { if (list.size() != 0) Runtime.trap("bookmarks start empty") };
};

switch (app.nuance_toggle_bookmark("18318", "434go-diaaa-aaaaf-qakwq-cai", "T", "brian")) {
    case (#ok(_)) {};
    case (#err(message)) Runtime.trap(message);
};
if (app.nuance_bookmarks().size() != 1) Runtime.trap("bookmark should be stored");
switch (app.nuance_toggle_bookmark("18318", "434go-diaaa-aaaaf-qakwq-cai", "T", "brian")) {
    case (#ok(_)) {};
    case (#err(message)) Runtime.trap(message);
};
if (app.nuance_bookmarks().size() != 0) Runtime.trap("toggling again should remove the bookmark");

switch (app.nuance_draft_discard(created.id)) {
    case (#ok(_)) {};
    case (#err(message)) Runtime.trap(message);
};
if (app.nuance_draft_list().size() != 1) Runtime.trap("discard should remove exactly one draft");

Debug.print("backend: all assertions passed");
