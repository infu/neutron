import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Text "mo:core/Text";
import Uniswap "../backend/main";
import Journal "../backend/Journal";
import Memory "../backend/memory/uniswap/v1";
import Actions "../backend/Actions";
import ActionMemory "../backend/memory/uniswap_actions/v1";

func ok(result : Journal.Result) : Memory.Swap {
    switch (result) {
        case (#ok(value)) value;
        case (#err(_)) { assert false; loop {} };
    };
};

func rejects(result : Journal.Result) {
    switch (result) {
        case (#err(message)) assert (message != "");
        case (#ok(_)) assert false;
    };
};

// Existing releases retain this immutable V1 journal. The new action journal
// is an independent root: adding it initializes only that root, while the old
// swap records keep their exact request identities and observations.
let fresh = Memory.init();
let freshActions = ActionMemory.init();
assert (Map.size(fresh.swaps) == 0);
assert (Map.size(freshActions.actions) == 0);
assert (Map.size(freshActions.positions) == 0);
let input : Journal.BeginInput = {
    id = "swap-1";
    account_id = "primary";
    chain_id = 42161;
    recipient = "0x0000000000000000000000000000000000000001";
    quote_json = "{\"amountIn\":\"100\",\"minimumOut\":\"90\"}";
    approval_request_id = ?"approval-1";
    approval_request_json = ?"{\"requestId\":\"approval-1\",\"chainId\":42161}";
    swap_request_id = "wallet-swap-1";
    swap_request_json = "{\"requestId\":\"wallet-swap-1\",\"chainId\":42161}";
};
let begun = ok(Journal.begin(fresh, input, 100));
assert (begun.phase == "queued");
assert (begun.revision == 0);
assert (begun.created_at == 100 and begun.updated_at == 100);
assert (begun.approval_operation_json == null and begun.swap_operation_json == null);

// A timeout after writing the intent replays the original journal record,
// including its original timestamps. Changed immutable facts cannot take it.
assert (ok(Journal.begin(fresh, input, 200)) == begun);
rejects(Journal.begin(fresh, { input with account_id = "other" }, 200));
rejects(Journal.begin(fresh, { input with chain_id = 1 }, 200));
rejects(Journal.begin(fresh, { input with recipient = "other" }, 200));
rejects(Journal.begin(fresh, { input with quote_json = "changed" }, 200));
rejects(Journal.begin(fresh, { input with approval_request_id = ?"other" }, 200));
rejects(Journal.begin(fresh, { input with approval_request_json = ?"changed" }, 200));
rejects(Journal.begin(fresh, { input with swap_request_id = "other" }, 200));
rejects(Journal.begin(fresh, { input with swap_request_json = "changed" }, 200));
rejects(Journal.begin(fresh, { input with id = "invalid-1"; approval_request_id = null }, 200));
rejects(Journal.begin(fresh, { input with id = "invalid-2"; approval_request_json = null }, 200));
rejects(Journal.begin(fresh, { input with id = "invalid-3"; approval_request_id = ?input.swap_request_id }, 200));
assert (Map.size(fresh.swaps) == 1);

// Persist dispatch ambiguity before opening the wallet. Restore a new backend
// over the same root as a reload/upgrade would do; no fresh request id appears.
let requestApproval : Journal.UpdateInput = {
    id = input.id;
    expected_revision = 0;
    stage = "approval";
    request_id = "approval-1";
    account_id = "primary";
    chain_id = 42161;
    operation_json = null;
    phase = "approval_requested";
};
let approvalRequested = ok(Journal.update(fresh, requestApproval, 300));
assert (approvalRequested.revision == 1 and approvalRequested.updated_at == 300);
assert (ok(Journal.update(fresh, requestApproval, 350)) == approvalRequested);
let restored : Memory.Mem = fresh;
let app = Uniswap.Init({ stable_memory = { uniswap = restored; uniswap_actions = freshActions } });
assert (app.uniswap_get_v1(input.id) == ?approvalRequested);
assert (app.uniswap_list_v1() == [approvalRequested]);

// Both the stage request and its account/network must match before even an
// otherwise identical operation can be acknowledged.
rejects(Journal.update(fresh, { requestApproval with account_id = "other" }, 400));
rejects(Journal.update(fresh, { requestApproval with chain_id = 1 }, 400));
rejects(Journal.update(fresh, { requestApproval with request_id = "wallet-swap-1" }, 400));
rejects(Journal.update(fresh, { requestApproval with stage = "unknown" }, 400));
let approveDone = {
    requestApproval with
    expected_revision = 1;
    operation_json = ?"{\"requestId\":\"approval-1\",\"status\":\"confirmed\"}";
    phase = "approval_confirmed";
};
let approvalConfirmed = ok(Journal.update(fresh, approveDone, 500));
assert (approvalConfirmed.revision == 2);
assert (ok(Journal.update(fresh, approveDone, 510)) == approvalConfirmed);
// A reply from a stale tab cannot replace a confirmed approval with pending.
rejects(Journal.update(fresh, {
    requestApproval with
    expected_revision = 1;
    operation_json = ?"{\"requestId\":\"approval-1\",\"status\":\"pending\"}";
}, 520));
assert (Journal.get(fresh, input.id) == ?approvalConfirmed);

let requestSwap : Journal.UpdateInput = {
    requestApproval with
    expected_revision = 2;
    stage = "swap";
    request_id = "wallet-swap-1";
    phase = "swap_requested";
};
let swapRequested = ok(Journal.update(fresh, requestSwap, 600));
assert (swapRequested.approval_operation_json == approveDone.operation_json);
assert (swapRequested.swap_operation_json == null);
assert (app.uniswap_get_v1(input.id) == ?swapRequested);
let swapDone = {
    requestSwap with
    expected_revision = 3;
    phase = "completed";
    operation_json = ?"{\"requestId\":\"wallet-swap-1\",\"status\":\"confirmed\",\"txHash\":\"0xabc\"}";
};
let completed = ok(Journal.update(fresh, swapDone, 700));
assert (completed.revision == 4);
assert (completed.created_at == 100 and completed.updated_at == 700);
assert (completed.approval_operation_json == approveDone.operation_json);
assert (completed.swap_operation_json == swapDone.operation_json);
assert (ok(Journal.begin(fresh, input, 800)) == completed);
// An update with no new observation preserves the final receipt.
assert (ok(Journal.update(fresh, { swapDone with operation_json = null }, 800)) == completed);
assert (Uniswap.Init({ stable_memory = { uniswap = restored; uniswap_actions = freshActions } }).uniswap_get_v1(input.id) == ?completed);

// Native input has no ERC20 approval step and cannot be given one later.
let nativeInput = { input with id = "native-swap"; approval_request_id = null; approval_request_json = null };
let nativeSwap = ok(Journal.begin(fresh, nativeInput, 900));
assert (nativeSwap.approval_request_id == null and nativeSwap.approval_operation_json == null);
rejects(Journal.update(fresh, { requestApproval with id = "native-swap" }, 1_000));
rejects(Journal.update(fresh, { requestSwap with id = "missing" }, 1_000));
assert (Map.size(restored.swaps) == 2);

func page(result : Journal.HistoryResult) : Journal.HistoryPage {
    switch (result) {
        case (#ok(value)) value;
        case (#err(_)) { assert false; loop {} };
    };
};

func historyRejects(result : Journal.HistoryResult) {
    switch (result) {
        case (#err(message)) assert (message != "");
        case (#ok(_)) assert false;
    };
};

// A durable history can outgrow the existing self-call metadata transport.
// Retain more than 64 KiB of real quote bodies and fetch all records by cursor
// instead of truncating the root or returning the entire collection at once.
let historyMemory = Memory.init();
let emptyPage = page(Journal.history(historyMemory, { cursor = null; limit = 7 }));
assert (emptyPage.rows == [] and emptyPage.next_cursor == null);
historyRejects(Journal.history(historyMemory, { cursor = null; limit = 0 }));
historyRejects(Journal.history(historyMemory, { cursor = ?"missing"; limit = 7 }));
var payload = "0123456789abcdef";
var repeat = 0;
while (repeat < 7) {
    payload #= payload;
    repeat += 1;
};
func historyId(index : Nat) : Text {
    "history-" # (if (index < 10) "0" else "") # Nat.toText(index);
};
var inserted = 0;
var aggregateQuoteBytes = 0;
while (inserted < 73) {
    let id = historyId(inserted);
    let quoteJson = "{\"retainedQuote\":\"" # payload # "\",\"index\":\"" # id # "\"}";
    ignore ok(Journal.begin(historyMemory, {
        input with
        id;
        quote_json = quoteJson;
        approval_request_id = ?("approval-" # id);
        approval_request_json = ?("{\"requestId\":\"approval-" # id # "\"}");
        swap_request_id = "swap-" # id;
        swap_request_json = "{\"requestId\":\"swap-" # id # "\"}";
    }, 1_000 + inserted / 2));
    aggregateQuoteBytes += Text.encodeUtf8(quoteJson).size();
    inserted += 1;
};
assert (aggregateQuoteBytes > 65_536);
assert (Map.size(historyMemory.swaps) == 73);
let snapshot = Journal.list(historyMemory);
let firstPage = page(Journal.history(historyMemory, { cursor = null; limit = 7 }));
assert (firstPage.rows.size() == 7 and firstPage.next_cursor == ?historyId(66));
var firstIndex = 0;
for (record in firstPage.rows.vals()) {
    assert (record.id == historyId(Nat.sub(72, firstIndex)));
    firstIndex += 1;
};
assert (Journal.list(historyMemory) == snapshot);

// New records appear before the saved cursor. A progress update changes only
// updated_at and revision, so it cannot move the anchor's creation ordering.
let insertedDuringPaging = ok(Journal.begin(historyMemory, {
    input with
    id = "new-during-paging";
    swap_request_id = "new-durable-request";
    swap_request_json = "{\"requestId\":\"new-durable-request\"}";
}, 3_000));
let anchorId = historyId(66);
let updatedAnchor = ok(Journal.update(historyMemory, {
    requestApproval with
    id = anchorId;
    request_id = "approval-" # anchorId;
}, 4_000));
assert (updatedAnchor.created_at == 1_033 and updatedAnchor.updated_at == 4_000);
let historyRestored : Memory.Mem = historyMemory;
let historyApp = Uniswap.Init({ stable_memory = { uniswap = historyRestored; uniswap_actions = freshActions } });
let snapshotAfterInsert = Journal.list(historyRestored);
let visited = Map.empty<Text, Bool>();
for (record in firstPage.rows.vals()) Map.add(visited, Text.compare, record.id, true);
var cursor = firstPage.next_cursor;
var seen = 7;
label remaining loop {
    let current = page(historyApp.uniswap_history_v1({ cursor; limit = 7 }));
    assert (current.rows.size() > 0 and current.rows.size() <= 7);
    for (record in current.rows.vals()) {
        assert (Map.get(visited, Text.compare, record.id) == null);
        assert (record.id == historyId(Nat.sub(72, seen)));
        assert (record.swap_request_id == "swap-" # record.id);
        assert (record.swap_request_json == "{\"requestId\":\"swap-" # record.id # "\"}");
        assert (record.approval_request_id == ?("approval-" # record.id));
        assert (record.phase == "queued" and record.revision == 0);
        Map.add(visited, Text.compare, record.id, true);
        seen += 1;
    };
    cursor := current.next_cursor;
    if (cursor == null) break remaining;
};
assert (seen == 73 and Map.size(visited) == 73);
assert (Map.get(visited, Text.compare, insertedDuringPaging.id) == null);
assert (Journal.list(historyRestored) == snapshotAfterInsert);

assert (Map.size(historyRestored.swaps) == 74);
assert (historyApp.uniswap_get_v1(anchorId) == ?updatedAnchor);
assert (historyApp.uniswap_get_v1("new-during-paging") == ?insertedDuringPaging);
let refreshed = page(historyApp.uniswap_history_v1({ cursor = null; limit = 7 }));
assert (refreshed.rows[0].id == "new-during-paging");
let beyondLast = page(historyApp.uniswap_history_v1({ cursor = ?historyId(0); limit = 7 }));
assert (beyondLast.rows == [] and beyondLast.next_cursor == null);
historyRejects(historyApp.uniswap_history_v1({ cursor = ?"invalid-cursor"; limit = 7 }));
// The caller may request a larger page; paging introduces no history quota or
// fixed page cap. If transport rejects its size, the client can request fewer.
let completeHistory = page(historyApp.uniswap_history_v1({ cursor = null; limit = 1_000 }));
assert (completeHistory.rows.size() == 74 and completeHistory.next_cursor == null);
assert (Journal.list(historyRestored) == snapshotAfterInsert);

func actionOk(result : Actions.Result) : ActionMemory.Action {
    switch (result) {
        case (#ok(value)) value;
        case (#err(_)) { assert false; loop {} };
    };
};

func actionRejects(result : Actions.Result) {
    switch (result) {
        case (#err(message)) assert (message != "");
        case (#ok(_)) assert false;
    };
};

func actionPage(result : Actions.PageResult) : Actions.Page {
    switch (result) {
        case (#ok(value)) value;
        case (#err(_)) { assert false; loop {} };
    };
};

// Upgrading any production release with uniswap@1 keeps its populated root
// while uniswap_actions@1 starts empty. Backend restoration reads both exact
// roots; adding and advancing actions cannot erase old swap progress.
let oldBeforeActions = Journal.list(historyRestored);
assert (actionPage(historyApp.uniswap_action_page_v1({ cursor = null; limit = 10 })).rows == []);
let actionInput : Actions.BeginInput = {
    id = "liquidity-1";
    input_json = "{\"kind\":\"mint\",\"protocol\":\"v4\",\"chainId\":1,\"accountId\":\"primary\",\"caller\":\"agent\"}";
    summary = "{\"title\":\"Add ETH / USDC liquidity\",\"kind\":\"mint\",\"humanOwned\":false}";
    state_json = "{\"steps\":[{\"requestId\":\"approval-liquidity-1\",\"dispatched\":false},{\"requestId\":\"permit-liquidity-1\",\"dispatched\":false},{\"requestId\":\"mint-liquidity-1\",\"dispatched\":false}]}";
    phase = "queued";
};
let actionBegun = actionOk(Actions.begin(freshActions, actionInput, 10_000));
assert (actionBegun.revision == 0 and actionBegun.created_at == 10_000 and actionBegun.updated_at == 10_000);
assert (actionOk(Actions.begin(freshActions, actionInput, 10_100)) == actionBegun);
actionRejects(Actions.begin(freshActions, { actionInput with input_json = "{\"caller\":\"different\"}" }, 10_100));
actionRejects(Actions.begin(freshActions, { actionInput with summary = "Different immutable action" }, 10_100));
actionRejects(Actions.begin(freshActions, { actionInput with id = "" }, 10_100));
assert (Map.size(freshActions.actions) == 1);

let dispatchAction : Actions.UpdateInput = {
    id = actionInput.id;
    expected_revision = 0;
    state_json = "{\"steps\":[{\"requestId\":\"approval-liquidity-1\",\"dispatched\":true,\"operation\":{\"status\":\"prepared\"}},{\"requestId\":\"permit-liquidity-1\",\"dispatched\":false},{\"requestId\":\"mint-liquidity-1\",\"dispatched\":false}]}";
    phase = "approval_requested";
};
let actionDispatched = actionOk(Actions.update(freshActions, dispatchAction, 10_200));
assert (actionDispatched.revision == 1 and actionDispatched.updated_at == 10_200);
assert (actionOk(Actions.update(freshActions, dispatchAction, 10_300)) == actionDispatched);
assert (actionOk(Actions.begin(freshActions, actionInput, 10_400)) == actionDispatched);
actionRejects(Actions.update(freshActions, { dispatchAction with state_json = actionInput.state_json; phase = "queued" }, 10_500));
actionRejects(Actions.update(freshActions, { dispatchAction with expected_revision = 2 }, 10_500));
actionRejects(Actions.update(freshActions, { dispatchAction with expected_revision = 1; state_json = "" }, 10_500));
actionRejects(Actions.update(freshActions, { dispatchAction with id = "missing" }, 10_500));
assert (Actions.get(freshActions, "missing") == null);

let actionsRestored : ActionMemory.Mem = freshActions;
let restoredApp = Uniswap.Init({ stable_memory = { uniswap = historyRestored; uniswap_actions = actionsRestored } });
assert (restoredApp.uniswap_action_get_v1(actionInput.id) == ?actionDispatched);
assert (restoredApp.uniswap_get_v1(anchorId) == ?updatedAnchor);
assert (Journal.list(historyRestored) == oldBeforeActions);

// Authorization failure metadata is an additive field in the existing JSON,
// not a replacement Wallet operation or a new memory schema. A restored app
// retains both the exact denied request and its unresolved execution marker.
let deniedInput = { actionInput with id = "authorization-denied" };
let deniedBegun = actionOk(Actions.begin(actionsRestored, deniedInput, 40_000));
let deniedJson = "{\"version\":1,\"steps\":[{\"request\":{\"requestId\":\"ac916d4c938a9cb9cc72042bcf3f7b01\"},\"dispatched\":true,\"unresolvedDispatch\":true,\"operation\":null,\"evidence\":null,\"authorizationFailure\":{\"requestId\":\"ac916d4c938a9cb9cc72042bcf3f7b01\",\"code\":\"AGENT_CONSENT_DENIED\",\"message\":\"Full range is outside the owner instruction\"}}]}";
let denied = actionOk(Actions.update(actionsRestored, {
    id = deniedInput.id; expected_revision = deniedBegun.revision;
    state_json = deniedJson; phase = "step_0_authorization_denied";
}, 40_100));
let afterDenial = Uniswap.Init({ stable_memory = { uniswap = historyRestored; uniswap_actions = actionsRestored } });
assert (afterDenial.uniswap_action_get_v1(deniedInput.id) == ?denied);
assert (denied.state_json == deniedJson and denied.input_json == deniedInput.input_json);
assert (afterDenial.uniswap_get_v1(anchorId) == ?updatedAnchor);

func positionOk(result : Actions.PositionResult) : ActionMemory.PositionRef {
    switch (result) {
        case (#ok(value)) value;
        case (#err(_)) { assert false; loop {} };
    };
};

let imported : ActionMemory.PositionRef = { chain_id = 1; protocol = "v4"; token_id = "12345678901234567890" };
assert (restoredApp.uniswap_position_refs_v1(1) == []);
assert (positionOk(restoredApp.uniswap_position_track_v1(imported)) == imported);
assert (positionOk(restoredApp.uniswap_position_track_v1(imported)) == imported);
assert (positionOk(restoredApp.uniswap_position_track_v1({ imported with token_id = "00012345678901234567890" })) == imported);
assert (Map.size(actionsRestored.positions) == 1);
let minted = { imported with protocol = "v3"; token_id = "987" };
ignore positionOk(restoredApp.uniswap_position_track_v1(minted));
let otherNetwork = { imported with chain_id = 42161 };
ignore positionOk(restoredApp.uniswap_position_track_v1(otherNetwork));
let positionsRestored = Uniswap.Init({ stable_memory = { uniswap = historyRestored; uniswap_actions = actionsRestored } });
assert (positionsRestored.uniswap_position_refs_v1(1) == [minted, imported]);
assert (positionsRestored.uniswap_position_refs_v1(42161) == [otherNetwork]);
assert (positionsRestored.uniswap_position_refs_v1(10) == []);
assert (positionsRestored.uniswap_action_get_v1(actionInput.id) == ?actionDispatched);
switch (positionsRestored.uniswap_position_track_v1({ imported with protocol = "unknown" })) { case (#err(_)) {}; case (_) assert false };
switch (positionsRestored.uniswap_position_track_v1({ imported with token_id = "-1" })) { case (#err(_)) {}; case (_) assert false };
switch (positionsRestored.uniswap_position_track_v1({ imported with chain_id = 0 })) { case (#err(_)) {}; case (_) assert false };
assert (Map.size(actionsRestored.positions) == 3);
assert (Journal.list(historyRestored) == oldBeforeActions);
let finalAction = {
    dispatchAction with
    expected_revision = 1;
    state_json = "{\"steps\":[{\"requestId\":\"approval-liquidity-1\",\"dispatched\":true,\"operation\":{\"status\":\"confirmed\"}},{\"requestId\":\"permit-liquidity-1\",\"dispatched\":true,\"operation\":{\"status\":\"signed\"}},{\"requestId\":\"mint-liquidity-1\",\"dispatched\":true,\"operation\":{\"status\":\"confirmed\",\"txHash\":\"0xabc\"}}]}";
    phase = "completed";
};
let actionCompleted = actionOk(Actions.update(actionsRestored, finalAction, 10_600));
assert (actionCompleted.revision == 2 and actionCompleted.created_at == 10_000 and actionCompleted.updated_at == 10_600);
assert (actionCompleted.input_json == actionInput.input_json and actionCompleted.summary == actionInput.summary);
assert (actionOk(Actions.update(actionsRestored, finalAction, 10_700)) == actionCompleted);
actionRejects(Actions.update(actionsRestored, dispatchAction, 10_800));
assert (actionOk(Actions.begin(actionsRestored, { actionInput with state_json = "{\"freshPlan\":true}"; phase = "prepared" }, 10_900)) == actionCompleted);
assert (restoredApp.uniswap_action_get_v1(actionInput.id) == ?actionCompleted);

// Large stored plans and receipts never enter the history response. The
// summary type intentionally has neither input_json nor state_json. Exercise
// >64 KiB of retained JSON and a stable cursor while another action arrives.
let actionHistory = ActionMemory.init();
var actionIndex = 0;
var retainedActionBytes = 0;
while (actionIndex < 40) {
    let id = "action-" # (if (actionIndex < 10) "0" else "") # Nat.toText(actionIndex);
    let largeState = "{\"receipt\":\"" # payload # "\"}";
    ignore actionOk(Actions.begin(actionHistory, { actionInput with id; state_json = largeState }, 20_000 + actionIndex / 2));
    retainedActionBytes += Text.encodeUtf8(largeState).size();
    actionIndex += 1;
};
assert (retainedActionBytes > 65_536);
let firstActions = actionPage(Actions.page(actionHistory, { cursor = null; limit = 7 }));
assert (firstActions.rows.size() == 7 and firstActions.rows[0].id == "action-39" and firstActions.next_cursor == ?"action-33");
ignore actionOk(Actions.begin(actionHistory, { actionInput with id = "action-new" }, 30_000));
let changedActionAnchor = actionOk(Actions.update(actionHistory, { dispatchAction with id = "action-33" }, 30_100));
assert (changedActionAnchor.created_at == 20_016);
let nextActions = actionPage(Actions.page(actionHistory, { cursor = firstActions.next_cursor; limit = 100 }));
assert (nextActions.rows.size() == 33 and nextActions.rows[0].id == "action-32" and nextActions.rows[32].id == "action-00");
assert (nextActions.next_cursor == null);
assert (Map.size(actionHistory.actions) == 41);
assert (actionPage(Actions.page(actionHistory, { cursor = null; limit = 100 })).rows.size() == 41);
assert (actionPage(Actions.page(actionHistory, { cursor = ?"action-00"; limit = 7 })).rows == []);
switch (Actions.page(actionHistory, { cursor = ?"missing"; limit = 7 })) { case (#err(_)) {}; case (_) assert false };
switch (Actions.page(actionHistory, { cursor = null; limit = 0 })) { case (#err(_)) {}; case (_) assert false };
assert (Journal.list(historyRestored) == oldBeforeActions);
