import Array "mo:core/Array";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Refund "../../backend/transfers/Refund";

persistent actor {
public func run() : async () {
    let minter = Principal.fromText("sv3dd-oaaaa-aaaar-qacoa-cai");
    let owner = Principal.fromText("aaaaa-aa");
    let ledger = Principal.fromText("xevnm-gaaaa-aaaar-qafnq-cai");
    let burn : Nat = 100;
    // This is the full official error variant, not a test-only narrowed wire.
    type LedgerError = {
        #InsufficientFunds : { balance : Nat; failed_burn_amount : Nat; token_symbol : Text; ledger_id : Principal };
        #InsufficientAllowance : { allowance : Nat; failed_burn_amount : Nat; token_symbol : Text; ledger_id : Principal };
        #AmountTooLow : { minimum_burn_amount : Nat; failed_burn_amount : Nat; token_symbol : Text; ledger_id : Principal };
        #TemporarilyUnavailable : Text;
    };
    type WithdrawalResult = {
        #Ok : { cketh_block_index : Nat; ckerc20_block_index : Nat };
        #Err : {
            #TokenNotSupported : { supported_tokens : [{ ckerc20_token_symbol : Text; erc20_contract_address : Text; ledger_canister_id : Principal }] };
            #RecipientAddressBlocked : { address : Text };
            #CkEthLedgerError : { error : LedgerError };
            #CkErc20LedgerError : { cketh_block_index : Nat; error : LedgerError };
            #TemporarilyUnavailable : Text;
        };
    };
    let partial : WithdrawalResult = #Err(#CkErc20LedgerError({ cketh_block_index = burn; error = #TemporarilyUnavailable("asset ledger unavailable") }));
    assert Refund.partialBurn(to_candid (partial)) == ?burn;
    assert Refund.partialFailure(to_candid (partial)) == ?{ withdrawal_id = burn; asset_burn_unresolved = true };
    let insufficientFunds : WithdrawalResult = #Err(#CkErc20LedgerError({ cketh_block_index = burn; error = #InsufficientFunds({ balance = 0; failed_burn_amount = 50; token_symbol = "ckUSDC"; ledger_id = ledger }) }));
    assert Refund.partialFailure(to_candid (insufficientFunds)) == ?{ withdrawal_id = burn; asset_burn_unresolved = false };
    let insufficientAllowance : WithdrawalResult = #Err(#CkErc20LedgerError({ cketh_block_index = burn; error = #InsufficientAllowance({ allowance = 0; failed_burn_amount = 50; token_symbol = "ckUSDC"; ledger_id = ledger }) }));
    assert Refund.partialFailure(to_candid (insufficientAllowance)) == ?{ withdrawal_id = burn; asset_burn_unresolved = false };
    let amountTooLow : WithdrawalResult = #Err(#CkErc20LedgerError({ cketh_block_index = burn; error = #AmountTooLow({ minimum_burn_amount = 50; failed_burn_amount = 10; token_symbol = "ckUSDC"; ledger_id = ledger }) }));
    assert Refund.partialFailure(to_candid (amountTooLow)) == ?{ withdrawal_id = burn; asset_burn_unresolved = false };
    let unknownError : { #Err : { #CkErc20LedgerError : { cketh_block_index : Nat; error : { #FutureError : Text } } } } = #Err(#CkErc20LedgerError({ cketh_block_index = burn; error = #FutureError("future protocol") }));
    assert Refund.partialFailure(to_candid (unknownError)) == ?{ withdrawal_id = burn; asset_burn_unresolved = true };
    let malformedError : { #Err : { #CkErc20LedgerError : { cketh_block_index : Nat; error : { #InsufficientFunds : Text } } } } = #Err(#CkErc20LedgerError({ cketh_block_index = burn; error = #InsufficientFunds("wrong payload") }));
    // A malformed nested error cannot discard the otherwise valid gas-burn ID
    // or turn a failed decode into proof that the asset debit never happened.
    assert Refund.partialFailure(to_candid (malformedError)) == ?{ withdrawal_id = burn; asset_burn_unresolved = true };
    let success : WithdrawalResult = #Ok({ cketh_block_index = burn; ckerc20_block_index = 200 });
    assert Refund.partialBurn(to_candid (success)) == null;
    assert Refund.partialFailure(to_candid (success)) == null;
    let beforeBurn : WithdrawalResult = #Err(#CkEthLedgerError({ error = #TemporarilyUnavailable("gas ledger unavailable") }));
    assert Refund.partialBurn(to_candid (beforeBurn)) == null;
    assert Refund.partialFailure(to_candid (beforeBurn)) == null;
    let invalid : WithdrawalResult = #Err(#RecipientAddressBlocked({ address = "blocked" }));
    assert Refund.partialBurn(to_candid (invalid)) == null;
    assert Refund.partialBurn(to_candid ("wrong type")) == null;
    assert Refund.partialFailure(to_candid ("wrong type")) == null;
    let malformedId : { #Err : { #CkErc20LedgerError : { cketh_block_index : Text; error : LedgerError } } } = #Err(#CkErc20LedgerError({ cketh_block_index = "not a block"; error = #TemporarilyUnavailable("unknown") }));
    assert Refund.partialFailure(to_candid (malformedId)) == null;

    type Payload = {
        #FailedErc20WithdrawalRequest : Refund.Scheduled;
        #ReimbursedEthWithdrawal : { withdrawal_id : Nat; reimbursed_amount : Nat; reimbursed_in_block : Nat; transaction_hash : ?Text };
        #ReimbursedErc20Withdrawal : { withdrawal_id : Nat; burn_in_block : Nat; reimbursed_in_block : Nat; ledger_id : Principal; reimbursed_amount : Nat; transaction_hash : ?Text };
        #QuarantinedReimbursement : { index : {
            #CkEth : { ledger_burn_index : Nat };
            #CkErc20 : { cketh_ledger_burn_index : Nat; ledger_id : Principal; ckerc20_ledger_burn_index : Nat };
        } };
        #UnrelatedFutureEvent : { arbitrary_field : [Text] };
    };
    type Event = { timestamp : Nat64; payload : Payload };
    func event(payload : Payload) : Event { { timestamp = 42; payload } };
    func inspect(events : [Event], total : Nat64, start : Nat64) : Refund.Scan {
        switch (Refund.inspect(#ok(to_candid ({ events; total_event_count = total })), burn, start)) {
            case (#ok(value)) value;
            case (#err(error)) Runtime.trap(error);
        };
    };
    func rejected(result : Refund.Result<Refund.Scan>) : Bool {
        switch (result) { case (#err(_)) true; case (_) false };
    };
    let call = Refund.request(minter, 52);
    assert call.canister == minter and call.method == "get_events" and call.cycles == 0;
    assert (from_candid call.args : ?{ start : Nat64; length : Nat64 }) == ?{ start = 52; length = 100 };
    assert Refund.pageSize == 100;
    let tailCall = Refund.tailRequest(minter);
    assert tailCall.canister == minter and tailCall.method == "get_events" and tailCall.cycles == 0;
    assert (from_candid tailCall.args : ?{ start : Nat64; length : Nat64 }) == ?{ start = 0; length = 0 };
    assert Refund.tail(#ok(to_candid ({ events = [] : [Event]; total_event_count = 750 : Nat64 }))) == ?750;
    assert Refund.tail(#ok(to_candid ({ total_event_count = 0 : Nat64 }))) == ?0;
    assert Refund.tail(#err({ code = "rejected"; message = "unavailable" })) == null;
    assert Refund.tail(#ok(to_candid ("wrong type"))) == null;
    assert Refund.tail(#ok(to_candid ({ total_event_count = "wrong type" }))) == null;

    let unrelated = event(#UnrelatedFutureEvent({ arbitrary_field = ["unrelated"] }));
    let scheduled = event(#FailedErc20WithdrawalRequest({ withdrawal_id = burn; reimbursed_amount = 5_000; to = owner; to_subaccount = null }));
    let refund = event(#ReimbursedEthWithdrawal({ withdrawal_id = burn; reimbursed_amount = 5_000; reimbursed_in_block = 700; transaction_hash = null }));
    let otherRefund = event(#ReimbursedEthWithdrawal({ withdrawal_id = burn + 1; reimbursed_amount = 5_000; reimbursed_in_block = 701; transaction_hash = null }));

    // Same amount and timestamp never identify a refund for another burn.
    let first = inspect([unrelated, otherRefund], 5, 0);
    assert first == { start = 0; next = 2; total_event_count = 5; exhausted = false; evidence = null; evidence_index = null };
    let queued = inspect([scheduled], 5, first.next);
    assert queued.next == 3 and not queued.exhausted;
    assert queued.evidence == ?#scheduled({ withdrawal_id = burn; reimbursed_amount = 5_000; to = owner; to_subaccount = null });
    assert queued.evidence_index == ?2;
    let found = inspect([unrelated, refund], 5, queued.next);
    assert found.exhausted and found.next == 5;
    assert found.evidence == ?#reimbursed({ withdrawal_id = burn; reimbursed_amount = 5_000; reimbursed_in_block = 700 });
    assert found.evidence_index == ?4;

    // The successful event alone is burn-correlated proof; no amount or time
    // heuristic and no preceding schedule event is required to establish it.
    assert inspect([refund], 901, 900).evidence == found.evidence;
    assert inspect([refund], 901, 900).evidence_index == ?900;
    let exhausted = inspect([unrelated], 901, 900);
    assert exhausted.exhausted and exhausted.evidence == null;
    assert inspect([], 901, 901).evidence == null;
    assert inspect([refund], 902, 901).evidence == found.evidence;

    let quarantine = event(#QuarantinedReimbursement({ index = #CkEth({ ledger_burn_index = burn }) }));
    assert inspect([quarantine], 1, 0).evidence == ?#quarantined({ withdrawal_id = burn });
    assert inspect([unrelated, quarantine], 902, 900).evidence_index == ?901;
    let otherQuarantine = event(#QuarantinedReimbursement({ index = #CkEth({ ledger_burn_index = burn + 1 }) }));
    assert inspect([otherQuarantine], 1, 0).evidence == null;
    let erc20Quarantine = event(#QuarantinedReimbursement({ index = #CkErc20({ cketh_ledger_burn_index = burn; ledger_id = ledger; ckerc20_ledger_burn_index = 200 }) }));
    assert inspect([erc20Quarantine], 1, 0).evidence == null;
    let erc20Refund = event(#ReimbursedErc20Withdrawal({ withdrawal_id = burn; burn_in_block = 200; reimbursed_in_block = 700; ledger_id = ledger; reimbursed_amount = 5_000; transaction_hash = null }));
    assert inspect([erc20Refund], 1, 0).evidence == null;
    let transactionRefund = event(#ReimbursedEthWithdrawal({ withdrawal_id = burn; reimbursed_amount = 5_000; reimbursed_in_block = 700; transaction_hash = ?"0xfailed" }));
    assert inspect([transactionRefund], 1, 0).evidence == ?#unexpected_transaction("0xfailed");
    assert inspect([transactionRefund], 1, 0).evidence_index == ?0;
    // A later exact reimbursement can resolve an earlier quarantine/schedule.
    assert inspect([scheduled, quarantine, refund], 3, 0).evidence == found.evidence;
    assert inspect([scheduled, quarantine, refund], 3, 0).evidence_index == ?2;

    // The cursor advances by actual response length, including future events,
    // rather than by the requested protocol page length.
    let fullPage = inspect(Array.tabulate<Event>(100, func(_) { unrelated }), 1_000, 500);
    assert fullPage.next == 600 and not fullPage.exhausted;
    assert inspect([refund], 1_000, 600).next == 601;
    assert rejected(Refund.inspect(#err({ code = "rejected"; message = "unavailable" }), burn, 0));
    assert rejected(Refund.inspect(#ok(to_candid ("wrong type")), burn, 0));
    assert rejected(Refund.inspect(#ok(to_candid ({ events = [refund]; total_event_count = 0 : Nat64 })), burn, 0));
    assert rejected(Refund.inspect(#ok(to_candid ({ events = [] : [Event]; total_event_count = 3 : Nat64 })), burn, 4));
    assert rejected(Refund.inspect(#ok(to_candid ({ events = [] : [Event]; total_event_count = 3 : Nat64 })), burn, 0));
    let maximum : Nat64 = 18_446_744_073_709_551_615;
    assert rejected(Refund.inspect(#ok(to_candid ({ events = [refund]; total_event_count = maximum })), burn, maximum));
    assert inspect([], maximum, maximum).next == maximum;
};
};
