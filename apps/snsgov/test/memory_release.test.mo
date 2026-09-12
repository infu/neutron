import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import NeutronCapabilities "mo:neutron-capabilities";
import SnsGov "../backend/main";
import Memory "../backend/memory/snsgov/v1";
import OperationsMemory "../backend/memory/snsgov_operations/v1";

// A stub broker. The relay is never dispatched here — an `async*` call needs an
// async context a Motoko program does not have — but constructing it type-checks
// the whole capability wiring, and the allowlist gate that decides whether the
// relay may dispatch at all is exercised directly below.
let stubBroker : NeutronCapabilities.BackendCallsV1 = {
    canister_principal = Principal.fromText("aaaaa-aa");
    can_call = func(_ : Principal, _ : Text) : Bool { true };
    call = func(_ : NeutronCapabilities.BackendCallRequestV1) : async* NeutronCapabilities.BackendCallResultV1 {
        #err({ code = "stub"; message = "not dispatched in tests" });
    };
    call_batch = func(_ : [NeutronCapabilities.BackendCallRequestV1]) : async* [NeutronCapabilities.BackendCallResultV1] {
        [];
    };
};

// This test compiles `backend/main.mo` against the released v1 schema, so it is
// the type check for the whole backend as well as a behavioural test.

let mem = Memory.init();
let operationMem = OperationsMemory.init();
assert (Map.size(mem.snses) == 0);
assert (Map.size(mem.audit) == 0);
assert (Map.size(mem.drafts) == 0);
assert (mem.max_audit_rows == 1_000);

let app = SnsGov.Init({
    stable_memory = { snsgov = mem; snsgov_operations = operationMem };
    capabilities = { backend_calls = stubBroker };
});

let neutrinite = Principal.fromText("extk7-gaaaa-aaaaq-aacda-cai");
let governance = Principal.fromText("eqsml-lyaaa-aaaaq-aacdq-cai");
let other = Principal.fromText("zqfso-syaaa-aaaaq-aaafq-cai");

// ---- Allowlist ------------------------------------------------------------

// An SNS the owner has not admitted authorizes nothing.
assert (app.snsgov_allowed(neutrinite, false) == null);

assert (
    app.snsgov_sns_upsert({
        sns = neutrinite;
        governance;
        voting_enabled = true;
        agent_voting_enabled = false;
        label_text = "Neutrinite";
    }) == #ok
);

// Admitted for the user, but agent voting defaults off and must stay off until
// the owner turns it on explicitly.
assert (app.snsgov_allowed(neutrinite, false) == ?governance);
assert (app.snsgov_allowed(neutrinite, true) == null);

assert (
    app.snsgov_sns_upsert({
        sns = neutrinite;
        governance;
        voting_enabled = true;
        agent_voting_enabled = true;
        label_text = "Neutrinite";
    }) == #ok
);
assert (app.snsgov_allowed(neutrinite, true) == ?governance);

// Disabling voting revokes both paths at once.
assert (
    app.snsgov_sns_upsert({
        sns = neutrinite;
        governance;
        voting_enabled = false;
        agent_voting_enabled = true;
        label_text = "Neutrinite";
    }) == #ok
);
assert (app.snsgov_allowed(neutrinite, false) == null);
assert (app.snsgov_allowed(neutrinite, true) == null);

// Repointing an admitted SNS at a different governance canister is a change of
// authority, not an edit, and must be refused.
switch (
    app.snsgov_sns_upsert({
        sns = neutrinite;
        governance = other;
        voting_enabled = true;
        agent_voting_enabled = false;
        label_text = "Neutrinite";
    })
) {
    case (#err(_)) {};
    case (#ok) assert false;
};

// Removal is clean and idempotently reported.
assert (app.snsgov_sns_remove(neutrinite) == #ok);
switch (app.snsgov_sns_remove(neutrinite)) {
    case (#err(_)) {};
    case (#ok) assert false;
};

// ---- Audit ----------------------------------------------------------------

func record(n : Nat) : Nat {
    app.snsgov_audit_append({
        sns = neutrinite;
        governance;
        kind = "vote";
        proposal_id = ?42;
        initiator = "agent";
        vote = ?1;
        neurons_attempted = n;
        neurons_succeeded = n;
        note = "";
    });
};

var i = 0;
while (i < 5) { ignore record(i); i += 1 };

let newest = app.snsgov_audit({ before = null; limit = 2 });
assert (newest.total == 5);
assert (newest.rows.size() == 2);
// Newest first.
assert (newest.rows[0].seq == 4);
assert (newest.rows[1].seq == 3);
assert (newest.next_before == ?3);

let page2 = app.snsgov_audit({ before = newest.next_before; limit = 2 });
assert (page2.rows.size() == 2);
assert (page2.rows[0].seq == 2);
assert (page2.rows[1].seq == 1);

let page3 = app.snsgov_audit({ before = page2.next_before; limit = 2 });
assert (page3.rows.size() == 1);
assert (page3.rows[0].seq == 0);
// The oldest row exists, so no continuation may be advertised.
assert (page3.next_before == null);

// Trimming drops the oldest rows and keeps the newest.
assert (app.snsgov_set_max_audit_rows(3) == #ok);
let trimmed = app.snsgov_audit({ before = null; limit = 10 });
assert (trimmed.total == 3);
assert (trimmed.rows[0].seq == 4);
assert (trimmed.rows[2].seq == 2);

switch (app.snsgov_set_max_audit_rows(0)) {
    case (#err(_)) {};
    case (#ok) assert false;
};

// ---- Drafts ---------------------------------------------------------------

let saved = app.snsgov_draft_save({
    id = null;
    sns = neutrinite;
    governance;
    title = "Adopt the thing";
    summary = "A motion.";
    url = "";
    action_kind = "Motion";
    payload = null;
    function_id = null;
    rendering = null;
    proposer = null;
    created_by = "agent";
});
let draftId = switch (saved) { case (#ok(id)) id; case (#err(_)) { assert false; 0 } };

assert (app.snsgov_drafts(()).size() == 1);
assert (app.snsgov_drafts(())[0].title == "Adopt the thing");

// Updating in place keeps the id and does not create a second draft.
switch (
    app.snsgov_draft_save({
        id = ?draftId;
        sns = neutrinite;
        governance;
        title = "Adopt the other thing";
        summary = "A motion.";
        url = "";
        action_kind = "Motion";
        payload = null;
        function_id = null;
        rendering = null;
        proposer = null;
        created_by = "agent";
    })
) {
    case (#ok(id)) assert (id == draftId);
    case (#err(_)) assert false;
};
assert (app.snsgov_drafts(()).size() == 1);
assert (app.snsgov_drafts(())[0].title == "Adopt the other thing");

// An existing draft's immutable destination cannot silently disagree with the
// update request. Refuse the edit and preserve the original content/target.
switch (app.snsgov_draft_save({
    id = ?draftId;
    sns = other;
    governance;
    title = "A different DAO's proposal";
    summary = "wrong target";
    url = "";
    action_kind = "Motion";
    payload = null;
    function_id = null;
    rendering = null;
    proposer = null;
    created_by = "user";
})) {
    case (#err(_)) {};
    case (#ok(_)) assert false;
};
assert (app.snsgov_drafts(())[0].sns == neutrinite);
assert (app.snsgov_drafts(())[0].title == "Adopt the other thing");

// Reopening over the same managed root retains a populated draft and counters.
let withDraft = SnsGov.Init({ stable_memory = { snsgov = mem; snsgov_operations = operationMem }; capabilities = { backend_calls = stubBroker } });
assert (withDraft.snsgov_drafts(())[0].id == draftId);
assert (withDraft.snsgov_drafts(())[0].title == "Adopt the other thing");
assert (withDraft.snsgov_config(()).max_audit_rows == 3);
assert (mem.draft_seq == draftId + 1);

// An empty title is not a submittable proposal, so it is not a valid draft.
switch (
    app.snsgov_draft_save({
        id = null;
        sns = neutrinite;
        governance;
        title = "";
        summary = "";
        url = "";
        action_kind = "Motion";
        payload = null;
        function_id = null;
        rendering = null;
        proposer = null;
        created_by = "user";
    })
) {
    case (#err(_)) {};
    case (#ok(_)) assert false;
};

// A neuron id is exactly 32 bytes; anything else would fail at the SNS.
switch (
    app.snsgov_draft_save({
        id = null;
        sns = neutrinite;
        governance;
        title = "Bad proposer";
        summary = "";
        url = "";
        action_kind = "Motion";
        payload = null;
        function_id = null;
        rendering = null;
        proposer = ?"\00\01\02";
        created_by = "user";
    })
) {
    case (#err(_)) {};
    case (#ok(_)) assert false;
};

assert (app.snsgov_draft_delete(draftId) == #ok);
assert (app.snsgov_drafts(()).size() == 0);

// ---- Retained-root behaviour ----------------------------------------------

// Rebuilding the app runtime over the retained root must observe the existing
// state; init() must not replace it.
assert (
    app.snsgov_sns_upsert({
        sns = neutrinite;
        governance;
        voting_enabled = true;
        agent_voting_enabled = false;
        label_text = "Neutrinite";
    }) == #ok
);
let restored = SnsGov.Init({
    stable_memory = { snsgov = mem; snsgov_operations = operationMem };
    capabilities = { backend_calls = stubBroker };
});
assert (restored.snsgov_allowed(neutrinite, false) == ?governance);
assert (restored.snsgov_config(()).snses.size() == 1);
assert (restored.snsgov_config(()).audit_rows == 3);

// ---- Relay gate -----------------------------------------------------------
//
// The relay derives its target from the allowlist, never from the caller. These
// assertions cover the decision that gates every signed write.

// The hotkey view reports the principal that will sign, and whether the owner
// has granted the reservation yet.
let hotkey = restored.snsgov_hotkey(());
assert (hotkey.principal == Principal.fromText("aaaaa-aa"));
assert (hotkey.can_manage_neuron == true);

// Agent voting is off for this SNS, so a user action is allowed and an agent
// action is refused against the very same entry.
assert (restored.snsgov_allowed(neutrinite, false) == ?governance);
assert (restored.snsgov_allowed(neutrinite, true) == null);

// Turning agent voting on opens the agent path without widening anything else.
assert (
    restored.snsgov_sns_upsert({
        sns = neutrinite;
        governance;
        voting_enabled = true;
        agent_voting_enabled = true;
        label_text = "Neutrinite";
    }) == #ok
);
assert (restored.snsgov_allowed(neutrinite, true) == ?governance);

// An SNS that was never admitted authorizes nothing, for either initiator.
let stranger = Principal.fromText("2jvtu-yqaaa-aaaaq-aaama-cai");
assert (restored.snsgov_allowed(stranger, false) == null);
assert (restored.snsgov_allowed(stranger, true) == null);

// ---- Independent durable operation root ----------------------------------

assert (restored.snsgov_operation_get("missing") == null);
assert (restored.snsgov_operation_list({ before = null; limit = 10 }).total == 0);
let prepared : SnsGov.OperationPrepare = {
    operation_id = "stake-001";
    kind = ?"stake";
    title = ?"Stake \"SNS\" tokens";
    sns = neutrinite;
    governance;
    input_json = "{\"kind\":\"stake\",\"nonce\":\"12\"}";
    review_json = "{\"title\":\"Stake \\\"SNS\\\" tokens\",\"amount\":\"100000000\"}";
    initiator = "user";
    state_json = "{}";
    steps = [{ step_id = "claim"; method = null; args = "DIDL\00\00" }];
};
switch (restored.snsgov_operation_prepare(prepared)) {
    case (#ok(operation)) {
        assert (operation.revision == 0);
        assert (operation.seq == 0);
        assert (operation.steps[0].status == "prepared");
        assert (operation.steps[0].method == "manage_neuron");
        assert (operation.steps[0].reply == null);
    };
    case (#err(_)) assert false;
};
switch (restored.snsgov_operation_update({ operation_id = "stake-001"; expected_revision = 0; state_json = "{\"fundedBlock\":\"345\"}" })) {
    case (#ok(operation)) assert (operation.revision == 1);
    case (#err(_)) assert false;
};
// Duplicate preparation matches the ORIGINAL state; it cannot erase the
// receipt or return an obsolete version of the record.
switch (restored.snsgov_operation_prepare(prepared)) {
    case (#ok(operation)) {
        assert (operation.revision == 1);
        assert (operation.state_json == "{\"fundedBlock\":\"345\"}");
    };
    case (#err(_)) assert false;
};
switch (restored.snsgov_operation_update({ operation_id = "stake-001"; expected_revision = 0; state_json = "{}" })) {
    case (#err(_)) {};
    case (#ok(_)) assert false;
};
switch (restored.snsgov_operation_prepare({ prepared with steps = [{ step_id = "claim"; method = null; args = "different bytes" }] })) {
    case (#err(_)) {};
    case (#ok(_)) assert false;
};
switch (restored.snsgov_operation_prepare({ prepared with operation_id = "second"; steps = [{ step_id = "claim"; method = null; args = "one" }, { step_id = "claim"; method = null; args = "two" }] })) {
    case (#err(_)) {};
    case (#ok(_)) assert false;
};
ignore restored.snsgov_operation_prepare({ prepared with operation_id = "second" });
let recentOperations = restored.snsgov_operation_list({ before = null; limit = 1 });
assert (recentOperations.total == 2);
assert (recentOperations.rows[0].operation_id == "second");
assert (recentOperations.rows[0].kind == "stake");
assert (recentOperations.rows[0].title == "Stake \"SNS\" tokens");
assert (recentOperations.next_before == ?1);
let olderOperations = restored.snsgov_operation_list({ before = recentOperations.next_before; limit = 1 });
assert (olderOperations.rows[0].operation_id == "stake-001");
assert (olderOperations.next_before == null);

// Readable labels are immutable typed metadata. Opaque JSON is retained and
// never parsed while listing history, including unsupported/malformed values.
for ((kind, title) in [(null, null), (?"", ?"")].vals()) {
    let id = if (kind == null) "summary-missing" else "summary-empty";
    ignore restored.snsgov_operation_prepare({ prepared with operation_id = id; kind; title; input_json = "not json"; review_json = "\\ud83d" });
    let row = restored.snsgov_operation_list({ before = null; limit = 1 }).rows[0];
    assert (row.operation_id == id);
    assert (row.kind == "operation");
    assert (row.title == "SNS operation");
};
switch (restored.snsgov_operation_prepare({ prepared with kind = ?"topup" })) {
    case (#err(_)) {}; case (#ok(_)) assert false;
};
switch (restored.snsgov_operation_prepare({ prepared with title = ?"Changed review label" })) {
    case (#err(_)) {}; case (#ok(_)) assert false;
};

let restoredJournal = SnsGov.Init({
    stable_memory = { snsgov = mem; snsgov_operations = operationMem };
    capabilities = { backend_calls = stubBroker };
});
switch (restoredJournal.snsgov_operation_get("stake-001")) {
    case (?operation) {
        assert (operation.state_json == "{\"fundedBlock\":\"345\"}");
        assert (operation.input_json == prepared.input_json);
        assert (operation.review_json == prepared.review_json);
        assert (operation.steps[0].args == prepared.steps[0].args);
        assert (operation.revision == 1);
    };
    case null assert false;
};
assert (restoredJournal.snsgov_config(()).audit_rows == 3);
assert (restoredJournal.snsgov_allowed(neutrinite, true) == ?governance);

// Optional method retains compatibility for manage_neuron callers while the
// other public SNS governance operations retain their exact reviewed method.
for (method in ["fail_stuck_upgrade_in_progress", "reset_timers", "get_maturity_modulation"].vals()) {
    let request : SnsGov.OperationPrepare = { prepared with operation_id = method; steps = [{ step_id = "governance"; method = ?method; args = "DIDL\00\00" }] };
    switch (restoredJournal.snsgov_operation_prepare(request)) {
        case (#ok(operation)) assert (operation.steps[0].method == method);
        case (#err(_)) assert false;
    };
    switch (restoredJournal.snsgov_operation_prepare({ request with steps = [{ step_id = "governance"; method = null; args = "DIDL\00\00" }] })) {
        case (#err(_)) {};
        case (#ok(_)) assert false;
    };
};
switch (restoredJournal.snsgov_operation_prepare({ prepared with operation_id = "unsupported"; steps = [{ step_id = "call"; method = ?"unrelated_method"; args = "DIDL\00\00" }] })) {
    case (#err(_)) {};
    case (#ok(_)) assert false;
};
