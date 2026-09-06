import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Capabilities "../../backend/capabilities/Types";
import Catalog "../../backend/Catalog";
import Withdrawals "../../backend/chainkey/Withdrawals";
import Icrc "../../backend/icrc1/Client";
import IcrcTypes "../../backend/icrc1/Types";
import Memory "../../backend/memory/wallet_transfers/v1";
import Journal "../../backend/transfers/Journal";
import Settlement "../../backend/transfers/Settlement";

persistent actor {
public func run() : async () {

let wallet = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
let ledger = Principal.fromText("xevnm-gaaaa-aaaar-qafnq-cai");
let gasLedger = Principal.fromText("ss2fx-dyaaa-aaaar-qacoq-cai");
let minter = Principal.fromText("sv3dd-oaaaa-aaaar-qacoa-cai");
let otherMinter = Principal.fromText("mqygn-kiaaa-aaaar-qaadq-cai");
let address = "0x1111111111111111111111111111111111111111";
let createdAt : Nat64 = 1_000;
let requestId = Blob.fromArray([1, 2, 3]);

func command(id : Blob, native : Bool) : Memory.Command {
    {
        request_id = id;
        intent = to_candid ("unchanged owner intent");
        resolved = to_candid ("unchanged destination and amount");
        created_at = createdAt;
        ledger;
        native;
        minter = if (native) ?minter else null;
        allowance_ledgers = if (native) [ledger, gasLedger] else [];
        var updated_at = 0;
        var status = #pending;
        var last_error = null;
        var settlement = null;
        var acknowledged = false;
        var calls = [];
    };
};

type ExpectedCall = {
    request : Capabilities.CallRequest;
    result : Capabilities.CallResult;
};

class Script(command : Memory.Command, expected : [ExpectedCall]) {
    public var count = 0;

    func call(request : Capabilities.CallRequest) : async* Capabilities.CallResult {
        assert (count < expected.size());
        let value = expected[count];
        assert (request == value.request);
        // The exact dispatch is already durable before the remote call yields.
        var found = false;
        for (saved in command.calls.vals()) {
            if (saved.canister == request.canister and saved.method == request.method and
                saved.args == request.args and saved.cycles == request.cycles) {
                switch (saved.outcome) {
                    case (#started) { found := true };
                    case (_) {};
                };
            };
        };
        assert found;
        count += 1;
        value.result;
    };

    public let calls : Capabilities.BackendCalls = {
        canister_principal = wallet;
        can_call = func(_canister : Principal, _method : Text) : Bool { true };
        call;
        call_batch = func(requests : [Capabilities.CallRequest]) : async* [Capabilities.CallResult] {
            var results : [Capabilities.CallResult] = [];
            for (request in requests.vals()) {
                results := Array.concat(results, [await* call(request)]);
            };
            results;
        };
    };
};

class QuoteScript(expected : [ExpectedCall]) {
    public var count = 0;

    func permitted(method : Text) : Bool {
        method == "icrc1_fee" or method == "icrc1_balance_of" or method == "eip_1559_transaction_price";
    };

    func call(request : Capabilities.CallRequest) : async* Capabilities.CallResult {
        // A quote has no authority to approve an allowance or submit a burn.
        // Fail even if an accidental effect happens to appear in a fixture.
        assert (permitted(request.method));
        assert (request.cycles == 0);
        assert (count < expected.size());
        let value = expected[count];
        assert (request == value.request);
        count += 1;
        value.result;
    };

    public let calls : Capabilities.BackendCalls = {
        canister_principal = wallet;
        can_call = func(_canister : Principal, method : Text) : Bool { permitted(method) };
        call;
        call_batch = func(requests : [Capabilities.CallRequest]) : async* [Capabilities.CallResult] {
            var results : [Capabilities.CallResult] = [];
            for (request in requests.vals()) {
                results := Array.concat(results, [await* call(request)]);
            };
            results;
        };
    };
};

func unknown(result : Icrc.ExecutionResult) : Bool {
    switch (result) { case (#unknown(_)) true; case (_) false };
};

func isUnknownStep(step : Memory.Step) : Bool {
    switch (step.outcome) { case (#unknown(_)) true; case (_) false };
};

func approveRequest(target : Principal, amount : Nat, fee : Nat) : Capabilities.CallRequest {
    let args : IcrcTypes.ApproveArg = {
        from_subaccount = null;
        spender = { owner = minter; subaccount = null };
        amount;
        expected_allowance = null;
        expires_at = ?(createdAt + 600_000_000_000);
        fee = ?fee;
        memo = null;
        created_at_time = ?createdAt;
    };
    Icrc.approveCandidRequest(target, to_candid (args));
};

let transferArgs : IcrcTypes.TransferArg = {
    from_subaccount = null;
    to = { owner = minter; subaccount = null };
    amount = 1_000_000;
    fee = ?10;
    memo = ?requestId;
    created_at_time = ?createdAt;
};
let transferRequest = Icrc.transferCandidRequest(ledger, to_candid (transferArgs));
let lostReply : Capabilities.CallResult = #err({ code = "timeout"; message = "reply lost after acceptance" });
let duplicateTransfer : IcrcTypes.TransferResult = #Err(#Duplicate({ duplicate_of = 81 }));

// Acceptance followed by a lost reply must preserve memo, timestamp, fee and
// every other byte. Duplicate supplies the original receipt, never a new send.
let transfer = command(requestId, false);
let lostTransfer = Script(transfer, [{ request = transferRequest; result = lostReply }]);
let firstTransfer = Journal.Replay(transfer, lostTransfer.calls);
assert (unknown(await* Icrc.executeTransfer(firstTransfer.backend_calls, ledger, transferArgs)));
assert (firstTransfer.hasUnknown() and firstTransfer.dispatched());
assert (transfer.calls.size() == 1 and isUnknownStep(transfer.calls[0]));
assert (transfer.calls[0].args == to_candid (transferArgs));
assert (transfer.status == #pending and transfer.last_error != null);
let transferRetryScript = Script(transfer, [{ request = transferRequest; result = #ok(to_candid (duplicateTransfer)) }]);
let transferRetry = Journal.Replay(transfer, transferRetryScript.calls);
switch (await* Icrc.executeTransfer(transferRetry.backend_calls, ledger, transferArgs)) {
    case (#ok(receipt)) { assert (receipt.block_index == 81 and receipt.duplicate) };
    case (_) assert false;
};
assert (not transferRetry.hasUnknown());
assert (transferRetryScript.count == 1 and transfer.calls.size() == 1);
let completedTransferScript = Script(transfer, []);
let completedTransfer = Journal.Replay(transfer, completedTransferScript.calls);
switch (await* Icrc.executeTransfer(completedTransfer.backend_calls, ledger, transferArgs)) {
    case (#ok(receipt)) assert (receipt.block_index == 81);
    case (_) assert false;
};
assert (completedTransferScript.count == 0);
assert (not Journal.hasUnresolved(transfer));
assert (not Journal.minterDispatched(transfer));
transfer.calls[0].outcome := #started;
assert (Journal.hasUnresolved(transfer));
let interruptedTransferScript = Script(transfer, [{ request = transferRequest; result = #ok(to_candid (duplicateTransfer)) }]);
let interruptedTransfer = Journal.Replay(transfer, interruptedTransferScript.calls);
switch (await* Icrc.executeTransfer(interruptedTransfer.backend_calls, ledger, transferArgs)) {
    case (#ok(receipt)) assert (receipt.block_index == 81 and receipt.duplicate);
    case (_) assert false;
};
assert (interruptedTransferScript.count == 1 and not Journal.hasUnresolved(transfer));

// Expiration of the deduplication window cannot turn an earlier unknown send
// into a definite rejection that invites sending the funds a second time.
let tooOldTransfer = command(Blob.fromArray([2]), false);
let lostTooOldScript = Script(tooOldTransfer, [{ request = transferRequest; result = lostReply }]);
let lostTooOld = Journal.Replay(tooOldTransfer, lostTooOldScript.calls);
assert (unknown(await* Icrc.executeTransfer(lostTooOld.backend_calls, ledger, transferArgs)));
let tooOld : IcrcTypes.TransferResult = #Err(#TooOld);
let tooOldRetryScript = Script(tooOldTransfer, [{ request = transferRequest; result = #ok(to_candid (tooOld)) }]);
let tooOldRetry = Journal.Replay(tooOldTransfer, tooOldRetryScript.calls);
assert (unknown(await* Icrc.executeTransfer(tooOldRetry.backend_calls, ledger, transferArgs)));
assert (tooOldRetry.hasUnknown() and isUnknownStep(tooOldTransfer.calls[0]));
assert (tooOldTransfer.status == #pending);

// A malformed successful transport reply is equally ambiguous. Changed retry
// arguments are rejected locally; no replacement dispatch can escape the journal.
let malformedTransfer = command(Blob.fromArray([3]), false);
let malformedScript = Script(malformedTransfer, [{ request = transferRequest; result = #ok(to_candid ("wrong wire type")) }]);
let malformed = Journal.Replay(malformedTransfer, malformedScript.calls);
assert (unknown(await* Icrc.executeTransfer(malformed.backend_calls, ledger, transferArgs)));
assert (malformed.hasUnknown() and isUnknownStep(malformedTransfer.calls[0]));
let changedScript = Script(malformedTransfer, []);
let changed = Journal.Replay(malformedTransfer, changedScript.calls);
assert (unknown(await* Icrc.executeTransfer(changed.backend_calls, ledger, { transferArgs with created_at_time = ?2_000 })));
assert (changedScript.count == 0 and malformedTransfer.calls[0].args == transferRequest.args);

// A definite first ledger rejection remains replayable without dispatching,
// and is not incorrectly presented as a possibly successful transfer.
let rejectedTransfer = command(Blob.fromArray([4]), false);
let insufficient : IcrcTypes.TransferResult = #Err(#InsufficientFunds({ balance = 5 }));
let rejectedScript = Script(rejectedTransfer, [{ request = transferRequest; result = #ok(to_candid (insufficient)) }]);
let rejected = Journal.Replay(rejectedTransfer, rejectedScript.calls);
switch (await* Icrc.executeTransfer(rejected.backend_calls, ledger, transferArgs)) {
    case (#rejected(_)) {};
    case (_) assert false;
};
assert (not rejected.hasUnknown());
let rejectedRetryScript = Script(rejectedTransfer, []);
let rejectedRetry = Journal.Replay(rejectedTransfer, rejectedRetryScript.calls);
switch (await* Icrc.executeTransfer(rejectedRetry.backend_calls, ledger, transferArgs)) {
    case (#rejected(_)) {};
    case (_) assert false;
};
assert (rejectedRetryScript.count == 0);

let ethRoute : Catalog.NativeRoute = #cketh({ minter = Principal.toText(minter) });
let ethApproval = approveRequest(gasLedger, 1_010, 10);
let ethWithdrawal : Capabilities.CallRequest = {
    canister = minter;
    method = "withdraw_eth";
    args = to_candid ({ recipient = address; amount = 1_000 : Nat; from_subaccount = null : ?Blob });
    cycles = 0;
};
let approvalOk : IcrcTypes.ApproveResult = #Ok(82);
func validDestination() : Withdrawals.Result<()> { #ok(()) };

// Minter withdrawal methods have no request-id deduplication. A reply lost
// after approval and dispatch must never cause another withdrawal, even after
// recreating Replay as happens when the browser reconnects or the app upgrades.
let eth = command(Blob.fromArray([5]), true);
let ethScript = Script(eth, [
    { request = ethApproval; result = #ok(to_candid (approvalOk)) },
    { request = ethWithdrawal; result = lostReply },
]);
let ethFirst = Journal.Replay(eth, ethScript.calls);
switch (await* Withdrawals.withdraw(ethRoute, gasLedger, address, 1_000, 10, createdAt, ethFirst.backend_calls, validDestination)) {
    case (#err(_)) {};
    case (#ok(_)) assert false;
};
assert (ethScript.count == 2 and ethFirst.hasUnknown());
let ethRetryScript = Script(eth, []);
let ethRetry = Journal.Replay(eth, ethRetryScript.calls);
switch (await* Withdrawals.withdraw(ethRoute, gasLedger, address, 1_000, 10, createdAt, ethRetry.backend_calls, validDestination)) {
    case (#err(_)) {};
    case (#ok(_)) assert false;
};
assert (ethRetryScript.count == 0 and ethRetry.hasUnknown());
assert (eth.calls.size() == 2);

// An upgrade can interrupt the final dispatch before any result is saved.
// The last existing #started entry must be treated just like #unknown.
eth.calls[1].outcome := #started;
let interruptedScript = Script(eth, []);
let interrupted = Journal.Replay(eth, interruptedScript.calls);
switch (await* Withdrawals.withdraw(ethRoute, gasLedger, address, 1_000, 10, createdAt, interrupted.backend_calls, validDestination)) {
    case (#err(_)) {};
    case (#ok(_)) assert false;
};
assert (interruptedScript.count == 0 and interrupted.hasUnknown());
assert (Journal.hasUnresolved(eth) and Journal.minterDispatched(eth));

// A malformed minter reply still means the remote update was dispatched.
// Keep the original bytes for reconciliation; reloading cannot send it again.
let malformedEth = command(Blob.fromArray([7]), true);
let malformedEthScript = Script(malformedEth, [
    { request = ethApproval; result = #ok(to_candid (approvalOk)) },
    { request = ethWithdrawal; result = #ok(to_candid ("unexpected result")) },
]);
let malformedEthFirst = Journal.Replay(malformedEth, malformedEthScript.calls);
switch (await* Withdrawals.withdraw(ethRoute, gasLedger, address, 1_000, 10, createdAt, malformedEthFirst.backend_calls, validDestination)) {
    case (#err(_)) {};
    case (#ok(_)) assert false;
};
assert (malformedEthFirst.hasUnknown() and Journal.hasUnresolved(malformedEth));
assert (Journal.minterDispatched(malformedEth));
switch (malformedEth.calls[1].outcome) {
    case (#reply(reply)) assert (reply == to_candid ("unexpected result"));
    case (_) assert false;
};
let malformedEthRetryScript = Script(malformedEth, []);
let malformedEthRetry = Journal.Replay(malformedEth, malformedEthRetryScript.calls);
switch (await* Withdrawals.withdraw(ethRoute, gasLedger, address, 1_000, 10, createdAt, malformedEthRetry.backend_calls, validDestination)) {
    case (#err(_)) {};
    case (#ok(_)) assert false;
};
assert (malformedEthRetryScript.count == 0 and malformedEthRetry.hasUnknown());

// A complete minter rejection is definite and stays cached.
let rejectedEthWire : { #Err : { #AmountTooLow : { min_withdrawal_amount : Nat } } } = #Err(#AmountTooLow({ min_withdrawal_amount = 9_000 }));
let rejectedEth = command(Blob.fromArray([8]), true);
let rejectedEthScript = Script(rejectedEth, [{ request = ethWithdrawal; result = #ok(to_candid (rejectedEthWire)) }]);
let rejectedEthFirst = Journal.Replay(rejectedEth, rejectedEthScript.calls);
switch (await* rejectedEthFirst.backend_calls.call(ethWithdrawal)) {
    case (#ok(reply)) assert (reply == to_candid (rejectedEthWire));
    case (#err(_)) assert false;
};
assert (not rejectedEthFirst.hasUnknown() and not Journal.hasUnresolved(rejectedEth));
let solReceipt : { #Ok : { block_index : Nat64 } } = #Ok({ block_index = 99 });
let alreadyProcessing : { #Err : { #AlreadyProcessing } } = #Err(#AlreadyProcessing);
assert (not Withdrawals.replyNeedsReconciliation("withdraw", to_candid (solReceipt)));
assert (not Withdrawals.replyNeedsReconciliation("withdraw", to_candid (alreadyProcessing)));

// BTC, DOGE and SOL guard AlreadyProcessing before this invocation burns.
// Exercise each complete approval/withdrawal protocol, not only its decoder:
// approval already paid its fee, but the refused withdrawal is definite and
// both replies stay cached. A separate earlier unknown minter call remains
// unknown and is never dispatched again to obtain this refusal.
let guardedRoutes : [{ id : Blob; prior_id : Blob; temporary_id : Blob; route : Catalog.NativeRoute; method : Text; symbol : Text; destination : Text }] = [
    {
        id = Blob.fromArray([40]); prior_id = Blob.fromArray([41]);
        temporary_id = Blob.fromArray([46]);
        route = #ckbtc({ minter = Principal.toText(minter) });
        method = "retrieve_btc_with_approval"; symbol = "ckBTC";
        destination = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";
    },
    {
        id = Blob.fromArray([42]); prior_id = Blob.fromArray([43]);
        temporary_id = Blob.fromArray([47]);
        route = #ckdoge({ minter = Principal.toText(minter) });
        method = "retrieve_doge_with_approval"; symbol = "ckDOGE";
        destination = "D5bJ6V7acpTgNVqiU5GPkJGEhsMi43xniX";
    },
    {
        id = Blob.fromArray([44]); prior_id = Blob.fromArray([45]);
        temporary_id = Blob.fromArray([48]);
        route = #cksol({ minter = Principal.toText(minter) });
        method = "withdraw"; symbol = "ckSOL";
        destination = "11111111111111111111111111111111";
    },
];
for (fixture in guardedRoutes.vals()) {
    let approval = approveRequest(ledger, 1_010, 10);
    let withdrawal : Capabilities.CallRequest = {
        canister = minter;
        method = fixture.method;
        args = to_candid ({ address = fixture.destination; amount = 1_000 : Nat64; from_subaccount = null : ?Blob });
        cycles = 0;
    };
    let prior = command(fixture.prior_id, true);
    let priorScript = Script(prior, [
        { request = approval; result = #ok(to_candid (approvalOk)) },
        { request = withdrawal; result = lostReply },
    ]);
    let priorReplay = Journal.Replay(prior, priorScript.calls);
    switch (await* Withdrawals.withdraw(fixture.route, ledger, fixture.destination, 1_000, 10, createdAt, priorReplay.backend_calls, validDestination)) {
        case (#err(_)) {};
        case (#ok(_)) assert false;
    };
    assert (priorScript.count == 2 and priorReplay.hasUnknown());
    assert (Journal.hasUnresolved(prior) and isUnknownStep(prior.calls[1]));

    // The upstream minter maps a ledger response decode failure into a typed
    // TemporarilyUnavailable reply even if the ledger committed the burn.
    // Model that verified path with a simulated burn before the mapped reply:
    // keep the complete reply and never send a new approval or minter call.
    let temporary = command(fixture.temporary_id, true);
    let temporaryMessage = if (fixture.method == "withdraw") {
        "Failed to burn tokens: The inter-canister call response could not be decoded";
    } else {
        "cannot enqueue a burn transaction: candid decode failed (reject_code = 5)";
    };
    let temporaryReply : { #Err : { #TemporarilyUnavailable : Text } } = #Err(#TemporarilyUnavailable(temporaryMessage));
    let temporaryScript = Script(temporary, [
        { request = approval; result = #ok(to_candid (approvalOk)) },
        { request = withdrawal; result = #ok(to_candid (temporaryReply)) },
    ]);
    var simulatedBurnedAmount = 0;
    let burnThenReplyCalls : Capabilities.BackendCalls = {
        temporaryScript.calls with
        call = func(request : Capabilities.CallRequest) : async* Capabilities.CallResult {
            if (request.method == fixture.method) simulatedBurnedAmount += 1_000;
            await* temporaryScript.calls.call(request);
        };
    };
    let temporaryReplay = Journal.Replay(temporary, burnThenReplyCalls);
    assert ((await* Withdrawals.withdraw(fixture.route, ledger, fixture.destination, 1_000, 10, createdAt, temporaryReplay.backend_calls, validDestination)) == #err(temporaryMessage));
    assert (temporaryScript.count == 2 and simulatedBurnedAmount == 1_000);
    assert (temporaryReplay.hasUnknown() and Journal.hasUnresolved(temporary));
    assert (temporary.status == #pending and temporary.calls.size() == 2);
    assert (temporary.calls[0].outcome == #reply(to_candid (approvalOk)));
    assert (temporary.calls[1].outcome == #reply(to_candid (temporaryReply)));
    assert (Withdrawals.replyNeedsReconciliation(fixture.method, to_candid (temporaryReply)));
    let temporaryRetryScript = Script(temporary, []);
    let temporaryRetry = Journal.Replay(temporary, temporaryRetryScript.calls);
    assert ((await* Withdrawals.withdraw(fixture.route, ledger, fixture.destination, 1_000, 10, createdAt, temporaryRetry.backend_calls, validDestination)) == #err(temporaryMessage));
    assert (temporaryRetryScript.count == 0 and simulatedBurnedAmount == 1_000);
    assert (temporaryRetry.hasUnknown() and Journal.hasUnresolved(temporary));
    assert (temporary.calls[1].args == withdrawal.args);
    assert (temporary.calls[1].outcome == #reply(to_candid (temporaryReply)));

    let refused = command(fixture.id, true);
    let refusedScript = Script(refused, [
        { request = approval; result = #ok(to_candid (approvalOk)) },
        { request = withdrawal; result = #ok(to_candid (alreadyProcessing)) },
    ]);
    let refusedReplay = Journal.Replay(refused, refusedScript.calls);
    let refusal = fixture.symbol # " minter is already processing a withdrawal";
    assert ((await* Withdrawals.withdraw(fixture.route, ledger, fixture.destination, 1_000, 10, createdAt, refusedReplay.backend_calls, validDestination)) == #err(refusal));
    assert (refusedScript.count == 2 and refused.calls.size() == 2);
    assert (not refusedReplay.hasUnknown() and not Journal.hasUnresolved(refused));
    assert (refused.calls[0].outcome == #reply(to_candid (approvalOk)));
    assert (refused.calls[1].outcome == #reply(to_candid (alreadyProcessing)));
    assert (not Withdrawals.replyNeedsReconciliation(fixture.method, to_candid (alreadyProcessing)));

    let cachedScript = Script(refused, []);
    let cachedReplay = Journal.Replay(refused, cachedScript.calls);
    assert ((await* Withdrawals.withdraw(fixture.route, ledger, fixture.destination, 1_000, 10, createdAt, cachedReplay.backend_calls, validDestination)) == #err(refusal));
    assert (cachedScript.count == 0 and not cachedReplay.hasUnknown());
    assert (Journal.hasUnresolved(temporary) and temporary.status == #pending);

    let unknownRetryScript = Script(prior, []);
    let unknownRetry = Journal.Replay(prior, unknownRetryScript.calls);
    switch (await* Withdrawals.withdraw(fixture.route, ledger, fixture.destination, 1_000, 10, createdAt, unknownRetry.backend_calls, validDestination)) {
        case (#err(error)) assert (Text.contains(error, #text("not repeated")));
        case (#ok(_)) assert false;
    };
    assert (unknownRetryScript.count == 0 and unknownRetry.hasUnknown());
    assert (Journal.hasUnresolved(prior) and isUnknownStep(prior.calls[1]));
    assert (prior.calls[1].args == withdrawal.args);
};

// Exercise the real ckERC20 withdrawal workflow. The token approval succeeds
// before the gas approval reply is lost. The retry must keep the original gas
// quote and fee, replay only exact gas approval bytes, then withdraw once.
let ercRoute : Catalog.NativeRoute = #ckerc20({
    minter = Principal.toText(minter);
    contract = "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    cketh_ledger = Principal.toText(gasLedger);
});
let priceRequest : Capabilities.CallRequest = {
    canister = minter;
    method = "eip_1559_transaction_price";
    args = to_candid (?{ ckerc20_ledger_id = ledger });
    cycles = 0;
};
let price = {
    gas_limit = 100 : Nat;
    max_fee_per_gas = 2 : Nat;
    max_priority_fee_per_gas = 1 : Nat;
    max_transaction_fee = 200 : Nat;
    timestamp = ?createdAt;
};
let gasFee = 20 : Nat;
let tokenApproval = approveRequest(ledger, 1_010, 10);
let gasApproval = approveRequest(gasLedger, price.max_transaction_fee + gasFee, gasFee);
let ercWithdrawal : Capabilities.CallRequest = {
    canister = minter;
    method = "withdraw_erc20";
    args = to_candid ({
        amount = 1_000 : Nat;
        ckerc20_ledger_id = ledger;
        recipient = address;
        from_cketh_subaccount = null : ?Blob;
        from_ckerc20_subaccount = null : ?Blob;
    });
    cycles = 0;
};
let erc = command(Blob.fromArray([6]), true);
let ercFirstScript = Script(erc, [
    { request = priceRequest; result = #ok(to_candid (price)) },
    { request = Icrc.feeRequest(gasLedger); result = #ok(to_candid (gasFee)) },
    { request = tokenApproval; result = #ok(to_candid (approvalOk)) },
    { request = gasApproval; result = lostReply },
]);
let ercFirst = Journal.Replay(erc, ercFirstScript.calls);
switch (await* Withdrawals.withdraw(ercRoute, ledger, address, 1_000, 10, createdAt, ercFirst.backend_calls, validDestination)) {
    case (#err(_)) {};
    case (#ok(_)) assert false;
};
assert (ercFirstScript.count == 4 and ercFirst.hasUnknown());
assert (erc.calls.size() == 4 and erc.calls[3].args == gasApproval.args);
let duplicateApproval : IcrcTypes.ApproveResult = #Err(#Duplicate({ duplicate_of = 83 }));
let ercReceipt : { #Ok : { cketh_block_index : Nat; ckerc20_block_index : Nat } } = #Ok({ cketh_block_index = 91; ckerc20_block_index = 92 });
let ercRetryScript = Script(erc, [
    { request = gasApproval; result = #ok(to_candid (duplicateApproval)) },
    { request = ercWithdrawal; result = #ok(to_candid (ercReceipt)) },
]);
let ercRetry = Journal.Replay(erc, ercRetryScript.calls);
switch (await* Withdrawals.withdraw(ercRoute, ledger, address, 1_000, 10, createdAt, ercRetry.backend_calls, validDestination)) {
    case (#ok(receipt)) {
        assert (receipt.asset_burn.ledger == ledger and receipt.asset_burn.block_index == 92);
        let gas = switch (receipt.gas_burn) {
            case (?value) value;
            case null Runtime.trap("Missing gas burn receipt");
        };
        assert (gas.ledger == gasLedger and gas.block_index == 91 and gas.amount == 200);
    };
    case (#err(_)) assert false;
};
assert (ercRetryScript.count == 2 and not ercRetry.hasUnknown());
assert (erc.calls.size() == 5 and erc.calls[3].args == gasApproval.args);
let ercCompletedScript = Script(erc, []);
let ercCompleted = Journal.Replay(erc, ercCompletedScript.calls);
switch (await* Withdrawals.withdraw(ercRoute, ledger, address, 1_000, 10, createdAt, ercCompleted.backend_calls, validDestination)) {
    case (#ok(receipt)) assert (receipt.asset_burn.block_index == 92);
    case (#err(_)) assert false;
};
assert (ercCompletedScript.count == 0);
assert (not Journal.hasUnresolved(erc) and Journal.minterDispatched(erc));

// The V2 native path supplies the durable command ID to both approval memos.
// Two equal withdrawals at the same IC timestamp must not collapse into the
// same deduplicated token or gas approval after the first allowance is spent.
func approvalWithMemo(request : Capabilities.CallRequest, id : Blob) : Capabilities.CallRequest {
    let ?args : ?IcrcTypes.ApproveArg = from_candid request.args else Runtime.trap("Invalid approval fixture");
    { request with args = to_candid ({ args with memo = ?id }) };
};
let nativeIdOne = Blob.fromArray([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
let nativeIdTwo = Blob.fromArray([2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
assert (approvalWithMemo(tokenApproval, nativeIdOne).args != approvalWithMemo(tokenApproval, nativeIdTwo).args);
assert (approvalWithMemo(gasApproval, nativeIdOne).args != approvalWithMemo(gasApproval, nativeIdTwo).args);
for (id in [nativeIdOne, nativeIdTwo].vals()) {
    let nativeCommand = command(id, true);
    let nativeScript = Script(nativeCommand, [
        { request = priceRequest; result = #ok(to_candid (price)) },
        { request = Icrc.feeRequest(gasLedger); result = #ok(to_candid (gasFee)) },
        { request = approvalWithMemo(tokenApproval, id); result = #ok(to_candid (approvalOk)) },
        { request = approvalWithMemo(gasApproval, id); result = #ok(to_candid (approvalOk)) },
        { request = ercWithdrawal; result = #ok(to_candid (ercReceipt)) },
    ]);
    let nativeReplay = Journal.Replay(nativeCommand, nativeScript.calls);
    switch (await* Withdrawals.withdrawWithMemo(ercRoute, ledger, address, 1_000, 10, createdAt, nativeReplay.backend_calls, validDestination, ?id)) {
        case (#ok(_)) {};
        case (#err(_)) assert false;
    };
    assert (nativeScript.count == 5 and not nativeReplay.hasUnknown());
};

// Cost discovery only reads current fees, balances and the minter gas price.
// Burns to the minting account have no transfer fee: the wallet pays one
// approval fee per ledger, not a second fee for either burn.
func quoteReads(assetBalance : Nat, gasBalance : Nat) : [ExpectedCall] {
    [
        { request = Icrc.feeRequest(ledger); result = #ok(to_candid (10 : Nat)) },
        { request = Icrc.balanceRequest(ledger, wallet); result = #ok(to_candid (assetBalance)) },
        { request = priceRequest; result = #ok(to_candid (price)) },
        { request = Icrc.feeRequest(gasLedger); result = #ok(to_candid (gasFee)) },
        { request = Icrc.balanceRequest(gasLedger, wallet); result = #ok(to_candid (gasBalance)) },
    ];
};
func quoted(result : Withdrawals.Result<Withdrawals.Quote>) : Withdrawals.Quote {
    switch (result) { case (#ok(value)) value; case (#err(message)) Runtime.trap(message) };
};
func quotedGas(value : Withdrawals.Quote) : Withdrawals.GasQuote {
    switch (value.gas) { case (?gas) gas; case null Runtime.trap("Missing ckETH gas quote") };
};
let quoteScript = QuoteScript(quoteReads(1_010, 220));
let withdrawalQuote = quoted(await* Withdrawals.quote(ercRoute, ledger, ?1_000, quoteScript.calls));
assert (quoteScript.count == 5);
assert (withdrawalQuote.ledger == ledger and withdrawalQuote.minter == minter);
assert (withdrawalQuote.amount == ?1_000 and withdrawalQuote.asset_fee == 10);
assert (withdrawalQuote.asset_allowance == ?1_000 and withdrawalQuote.asset_total_debit == ?1_010);
assert (withdrawalQuote.asset_balance == 1_010 and withdrawalQuote.asset_sufficient == ?true);
let gasQuote = quotedGas(withdrawalQuote);
assert (gasQuote.ledger == gasLedger and gasQuote.budget == 200 and gasQuote.ledger_fee == 20);
assert (gasQuote.allowance == 200);
assert (gasQuote.total_debit == 220 and gasQuote.balance == 220 and gasQuote.sufficient);
assert (withdrawalQuote.authorization == {
    asset_fee = 10;
    gas = ?{ ledger = gasLedger; minter; budget = 200; ledger_fee = 20 };
});

let insufficientGasScript = QuoteScript(quoteReads(1_010, 219));
let insufficientGasQuote = quoted(await* Withdrawals.quote(ercRoute, ledger, ?1_000, insufficientGasScript.calls));
assert (insufficientGasScript.count == 5);
assert (insufficientGasQuote.asset_sufficient == ?true);
assert (not quotedGas(insufficientGasQuote).sufficient);
assert (quotedGas(insufficientGasQuote).total_debit == 220);
let insufficientAssetScript = QuoteScript(quoteReads(1_009, 220));
let insufficientAssetQuote = quoted(await* Withdrawals.quote(ercRoute, ledger, ?1_000, insufficientAssetScript.calls));
assert (insufficientAssetQuote.asset_sufficient == ?false and quotedGas(insufficientAssetQuote).sufficient);

// Gas remains useful before an amount is entered, while amount-dependent
// asset allowance/debit/sufficiency stay absent instead of looking like zero.
let amountlessScript = QuoteScript(quoteReads(1_010, 220));
let amountlessQuote = quoted(await* Withdrawals.quote(ercRoute, ledger, null, amountlessScript.calls));
assert (amountlessScript.count == 5 and amountlessQuote.amount == null);
assert (amountlessQuote.asset_allowance == null and amountlessQuote.asset_total_debit == null);
assert (amountlessQuote.asset_sufficient == null and quotedGas(amountlessQuote).total_debit == 220);

let ethQuoteScript = QuoteScript([
    { request = Icrc.feeRequest(gasLedger); result = #ok(to_candid (gasFee)) },
    { request = Icrc.balanceRequest(gasLedger, wallet); result = #ok(to_candid (1_020 : Nat)) },
]);
let ethQuote = quoted(await* Withdrawals.quote(ethRoute, gasLedger, ?1_000, ethQuoteScript.calls));
assert (ethQuoteScript.count == 2 and ethQuote.gas == null);
assert (ethQuote.asset_total_debit == ?1_020 and ethQuote.asset_sufficient == ?true);
assert (ethQuote.authorization == { asset_fee = 20; gas = null });

// Every read can fail. Stop at that read and return the failure without
// producing a success quote or attempting a financial operation.
let successfulQuoteReads = quoteReads(1_010, 220);
for (failure in [0, 1, 2, 3, 4].vals()) {
    let expected = Array.tabulate<ExpectedCall>(failure + 1, func(index) {
        let original = successfulQuoteReads[index];
        if (index == failure) ({ original with result = lostReply }) else original;
    });
    let failedQuoteScript = QuoteScript(expected);
    switch (await* Withdrawals.quote(ercRoute, ledger, ?1_000, failedQuoteScript.calls)) {
        case (#err(message)) assert (Text.contains(message, #text("reply lost")));
        case (#ok(_)) assert false;
    };
    assert (failedQuoteScript.count == failure + 1);
};
let malformedPriceScript = QuoteScript([
    successfulQuoteReads[0], successfulQuoteReads[1],
    { request = priceRequest; result = #ok(to_candid ("unexpected price reply")) },
]);
switch (await* Withdrawals.quote(ercRoute, ledger, ?1_000, malformedPriceScript.calls)) {
    case (#err(_)) {};
    case (#ok(_)) assert false;
};
assert (malformedPriceScript.count == 3);

// A quote authorizes the reviewed costs. Changed asset or gas costs must
// fail before even the first allowance is approved.
let changedAssetFeeScript = QuoteScript([]);
switch (await* Withdrawals.withdrawReviewed(ercRoute, ledger, address, 1_000, 11, createdAt, changedAssetFeeScript.calls, validDestination, ?nativeIdOne, ?withdrawalQuote.authorization)) {
    case (#err(message)) assert (Text.contains(message, #text("costs changed")));
    case (#ok(_)) assert false;
};
assert (changedAssetFeeScript.count == 0);
for ((currentBudget, currentFee) in [(300, 20), (200, 21)].vals()) {
    let changedGasScript = QuoteScript([
        { request = priceRequest; result = #ok(to_candid ({ price with max_transaction_fee = currentBudget })) },
        { request = Icrc.feeRequest(gasLedger); result = #ok(to_candid (currentFee : Nat)) },
    ]);
    switch (await* Withdrawals.withdrawReviewed(ercRoute, ledger, address, 1_000, 10, createdAt, changedGasScript.calls, validDestination, ?nativeIdOne, ?withdrawalQuote.authorization)) {
        case (#err(message)) assert (Text.contains(message, #text("costs changed")));
        case (#ok(_)) assert false;
    };
    assert (changedGasScript.count == 2);
};
let missingGasReviewScript = QuoteScript([]);
switch (await* Withdrawals.withdrawReviewed(ercRoute, ledger, address, 1_000, 10, createdAt, missingGasReviewScript.calls, validDestination, ?nativeIdOne, ?{ asset_fee = 10; gas = null })) {
    case (#err(message)) assert (Text.contains(message, #text("gas quote")));
    case (#ok(_)) assert false;
};
assert (missingGasReviewScript.count == 0);

// Execution caps the actual approvals at the reviewed burn amounts. The
// minter recalculates gas after the approvals; zero burn fees mean adding
// fee headroom would otherwise permit spending beyond the reviewed budget.
let reviewedCommand = command(nativeIdOne, true);
let reviewedScript = Script(reviewedCommand, [
    { request = priceRequest; result = #ok(to_candid (price)) },
    { request = Icrc.feeRequest(gasLedger); result = #ok(to_candid (gasFee)) },
    { request = approvalWithMemo(approveRequest(ledger, 1_000, 10), nativeIdOne); result = #ok(to_candid (approvalOk)) },
    { request = approvalWithMemo(approveRequest(gasLedger, 200, 20), nativeIdOne); result = #ok(to_candid (approvalOk)) },
    { request = ercWithdrawal; result = #ok(to_candid (ercReceipt)) },
]);
let reviewedReplay = Journal.Replay(reviewedCommand, reviewedScript.calls);
switch (await* Withdrawals.withdrawReviewed(ercRoute, ledger, address, 1_000, 10, createdAt, reviewedReplay.backend_calls, validDestination, ?nativeIdOne, ?withdrawalQuote.authorization)) {
    case (#ok(_)) {};
    case (#err(_)) assert false;
};
assert (reviewedScript.count == 5 and not reviewedReplay.hasUnknown());

// ckERC20 may burn ckETH successfully before rejecting the token burn. The
// returned gas block is evidence of a partial effect, not a safe fresh retry.
let partialErcWire : {
    #Err : { #CkErc20LedgerError : { cketh_block_index : Nat; error : { #TemporarilyUnavailable : Text } } };
} = #Err(#CkErc20LedgerError({ cketh_block_index = 100; error = #TemporarilyUnavailable("token ledger unavailable") }));
let partialErc = command(Blob.fromArray([9]), true);
let partialErcScript = Script(partialErc, [
    { request = priceRequest; result = #ok(to_candid (price)) },
    { request = Icrc.feeRequest(gasLedger); result = #ok(to_candid (gasFee)) },
    { request = tokenApproval; result = #ok(to_candid (approvalOk)) },
    { request = gasApproval; result = #ok(to_candid (duplicateApproval)) },
    { request = ercWithdrawal; result = #ok(to_candid (partialErcWire)) },
]);
let partialErcFirst = Journal.Replay(partialErc, partialErcScript.calls);
switch (await* Withdrawals.withdraw(ercRoute, ledger, address, 1_000, 10, createdAt, partialErcFirst.backend_calls, validDestination)) {
    case (#err(message)) { assert (Text.contains(message, #text("100"))) };
    case (#ok(_)) assert false;
};
assert (partialErcFirst.hasUnknown() and Journal.hasUnresolved(partialErc));
switch (partialErc.calls[4].outcome) {
    case (#reply(reply)) assert (reply == to_candid (partialErcWire));
    case (_) assert false;
};
let partialErcRetryScript = Script(partialErc, []);
let partialErcRetry = Journal.Replay(partialErc, partialErcRetryScript.calls);
switch (await* Withdrawals.withdraw(ercRoute, ledger, address, 1_000, 10, createdAt, partialErcRetry.backend_calls, validDestination)) {
    case (#err(message)) { assert (Text.contains(message, #text("100"))) };
    case (#ok(_)) assert false;
};
assert (partialErcRetryScript.count == 0 and partialErcRetry.hasUnknown());

// Allowance admission is shared across requests and survives loss of the
// browser. Both ckERC20 and ckETH gas allowances stay reserved until terminal.
let memory = Memory.init();
assert (Map.size(memory.commands) == 0);
Map.add(memory.commands, Blob.compare, erc.request_id, erc);
assert (Journal.allowanceReserved(memory, ledger, minter, null));
assert (Journal.allowanceReserved(memory, gasLedger, minter, null));
assert (not Journal.allowanceReserved(memory, ledger, otherMinter, null));
assert (not Journal.allowanceReserved(memory, wallet, minter, null));
assert (not Journal.allowanceReserved(memory, ledger, minter, ?erc.request_id));
assert (Journal.pendingNativeConflict(memory, minter, null));
assert (not Journal.pendingNativeConflict(memory, minter, ?erc.request_id));
assert (not Journal.pendingNativeConflict(memory, otherMinter, null));
erc.status := #succeeded(to_candid (ercReceipt));
assert (not Journal.allowanceReserved(memory, ledger, minter, null));
assert (not Journal.allowanceReserved(memory, gasLedger, minter, null));
assert (not Journal.pendingNativeConflict(memory, minter, null));
// A ledger burn receipt is distinct from a finalized Ethereum payout. Exercise
// the public minter's actual Candid wire variants, including reverted payouts
// waiting for reimbursement and unknown future statuses.
let settlementRequest = Settlement.request(minter, 91);
assert (settlementRequest.canister == minter);
assert (settlementRequest.method == "retrieve_eth_status" and settlementRequest.cycles == 0);
let decodedWithdrawalId : ?Nat64 = from_candid settlementRequest.args;
assert (decodedWithdrawalId == ?91);
assert (Settlement.MAX_WITHDRAWAL_ID == 18_446_744_073_709_551_615);
type RemoteSettlement = {
    #NotFound;
    #Pending;
    #TxCreated;
    #TxSent : { transaction_hash : Text };
    #TxFinalized : {
        #Success : { transaction_hash : Text; effective_transaction_fee : ?Nat };
        #PendingReimbursement : { transaction_hash : Text };
        #Reimbursed : { transaction_hash : Text; reimbursed_amount : Nat; reimbursed_in_block : Nat };
    };
};
let transactionHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
func settlement(value : RemoteSettlement) : Settlement.Status {
    Settlement.classify(#ok(to_candid (value)));
};
for (wire in ([#Pending, #TxCreated] : [RemoteSettlement]).vals()) {
    switch (settlement(wire)) {
        case (#pending(message)) assert (message.size() > 0);
        case (_) assert false;
    };
};
switch (settlement(#NotFound)) {
    case (#unknown(_)) {};
    case (_) assert false;
};
switch (settlement(#TxSent({ transaction_hash = transactionHash }))) {
    case (#submitted(value)) assert (value.transaction_hash == transactionHash);
    case (_) assert false;
};
for (fee in ([null, ?42] : [?Nat]).vals()) {
    switch (settlement(#TxFinalized(#Success({ transaction_hash = transactionHash; effective_transaction_fee = fee })))) {
        case (#confirmed(value)) assert (value.transaction_hash == transactionHash);
        case (_) assert false;
    };
};
switch (settlement(#TxFinalized(#PendingReimbursement({ transaction_hash = transactionHash })))) {
    case (#pending(message)) {
        assert (Text.contains(message, #text(transactionHash)));
        assert (Text.contains(message, #text("failed")));
        assert (Text.contains(message, #text("pending")));
    };
    case (_) assert false;
};
switch (settlement(#TxFinalized(#Reimbursed({ transaction_hash = transactionHash; reimbursed_amount = 1_234; reimbursed_in_block = 567 })))) {
    case (#failed(message)) {
        assert (Text.contains(message, #text(transactionHash)));
        assert (Text.contains(message, #text("1234")));
        assert (Text.contains(message, #text("567")));
    };
    case (_) assert false;
};
let futureStatus : { #FutureStatus : Text } = #FutureStatus("not yet supported");
for (result in ([lostReply, #ok(to_candid ("malformed status")), #ok(to_candid (futureStatus))] : [Capabilities.CallResult]).vals()) {
    switch (Settlement.classify(result)) {
        case (#unknown(_)) {};
        case (_) assert false;
    };
};
Map.add(memory.commands, Blob.compare, eth.request_id, eth);
assert (Journal.allowanceReserved(memory, gasLedger, minter, null));
eth.status := #rejected("definite rejection after reconciliation");
assert (not Journal.allowanceReserved(memory, gasLedger, minter, null));
assert (not Journal.pendingNativeConflict(memory, minter, null));
};
};
