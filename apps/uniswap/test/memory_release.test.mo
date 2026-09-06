import Map "mo:core/Map";
import Uniswap "../backend/main";
import Journal "../backend/Journal";
import Memory "../backend/memory/uniswap/v1";

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

// This is Uniswap's first release: initialization creates its sole empty root.
// Future releases must keep this v1 source and explicitly test their migration
// or same-schema restoration against the production package.
let fresh = Memory.init();
assert (Map.size(fresh.swaps) == 0);
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
let app = Uniswap.Init({ stable_memory = { uniswap = restored } });
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
assert (Uniswap.Init({ stable_memory = { uniswap = restored } }).uniswap_get_v1(input.id) == ?completed);

// Native input has no ERC20 approval step and cannot be given one later.
let nativeInput = { input with id = "native-swap"; approval_request_id = null; approval_request_json = null };
let nativeSwap = ok(Journal.begin(fresh, nativeInput, 900));
assert (nativeSwap.approval_request_id == null and nativeSwap.approval_operation_json == null);
rejects(Journal.update(fresh, { requestApproval with id = "native-swap" }, 1_000));
rejects(Journal.update(fresh, { requestSwap with id = "missing" }, 1_000));
assert (Map.size(restored.swaps) == 2);
