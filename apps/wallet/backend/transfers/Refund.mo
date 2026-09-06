import Nat64 "mo:core/Nat64";
import Capabilities "../capabilities/Types";

module {
    // ckETH minter, pinned public contract and reimbursement implementation:
    // https://github.com/dfinity/ic/blob/065e28175a3e34a258a07524e37c4666972a1125/rs/ethereum/cketh/minter/cketh_minter.did#L710
    // https://github.com/dfinity/ic/blob/065e28175a3e34a258a07524e37c4666972a1125/rs/ethereum/cketh/minter/src/withdraw.rs#L104
    // A failed ckERC20 burn has no normal withdrawal transaction. Its ckETH
    // reimbursement is indexed by the exact ckETH burn from the original reply.
    // The event is emitted only after the ckETH ledger reports a successful mint.
    public type Reimbursed = {
        withdrawal_id : Nat;
        reimbursed_amount : Nat;
        reimbursed_in_block : Nat;
    };
    public type Scheduled = {
        withdrawal_id : Nat;
        reimbursed_amount : Nat;
        to : Principal;
        to_subaccount : ?Blob;
    };
    public type Evidence = {
        #scheduled : Scheduled;
        #quarantined : { withdrawal_id : Nat };
        #reimbursed : Reimbursed;
        #unexpected_transaction : Text;
    };
    public type Scan = {
        start : Nat64;
        next : Nat64;
        total_event_count : Nat64;
        exhausted : Bool;
        evidence : ?Evidence;
        evidence_index : ?Nat64;
    };
    public type PartialFailure = { withdrawal_id : Nat; asset_burn_unresolved : Bool };
    public type Result<T> = { #ok : T; #err : Text };
    public let pageSize : Nat64 = 100;

    // Optional projections use Candid's opt rule to ignore unrelated and future
    // variants. Known refund fields remain typed; an unknown event is no proof.
    type LedgerError = {
        #InsufficientFunds : { balance : Nat; failed_burn_amount : Nat; token_symbol : Text; ledger_id : Principal };
        #InsufficientAllowance : { allowance : Nat; failed_burn_amount : Nat; token_symbol : Text; ledger_id : Principal };
        #AmountTooLow : { minimum_burn_amount : Nat; failed_burn_amount : Nat; token_symbol : Text; ledger_id : Principal };
        #TemporarilyUnavailable : Text;
    };
    type PartialResult = {
        #Ok : { cketh_block_index : Nat; ckerc20_block_index : Nat };
        #Err : ?{ #CkErc20LedgerError : { cketh_block_index : Nat; error : ?LedgerError } };
    };
    type ReimbursementIndex = {
        #CkEth : { ledger_burn_index : Nat };
        #CkErc20 : {
            cketh_ledger_burn_index : Nat;
            ledger_id : Principal;
            ckerc20_ledger_burn_index : Nat;
        };
    };
    type Payload = {
        #FailedErc20WithdrawalRequest : Scheduled;
        #ReimbursedEthWithdrawal : {
            withdrawal_id : Nat;
            reimbursed_amount : Nat;
            reimbursed_in_block : Nat;
            transaction_hash : ?Text;
        };
        #QuarantinedReimbursement : { index : ?ReimbursementIndex };
    };
    type Events = {
        events : [{ timestamp : Nat64; payload : ?Payload }];
        total_event_count : Nat64;
    };

    public func partialBurn(reply : Blob) : ?Nat {
        switch (partialFailure(reply)) {
            case (?value) ?value.withdrawal_id;
            case null null;
        };
    };

    public func partialFailure(reply : Blob) : ?PartialFailure {
        switch (from_candid reply : ?PartialResult) {
            case (?#Err(?#CkErc20LedgerError(value))) ?{
                withdrawal_id = value.cketh_block_index;
                // TemporarilyUnavailable also represents transport/decoding
                // failures in ledger_client.rs. Refunding the gas cannot prove
                // that the original asset burn failed. Unknown error payloads
                // retain the known gas burn and the same unresolved outcome.
                asset_burn_unresolved = switch (value.error) {
                    case (?#InsufficientFunds(_) or ?#InsufficientAllowance(_) or ?#AmountTooLow(_)) false;
                    case (_) true;
                };
            };
            case (_) null;
        };
    };

    public func request(minter : Principal, start : Nat64) : Capabilities.CallRequest {
        // 100 is the minter's MAX_EVENTS_PER_RESPONSE, not a Wallet scan limit.
        // Callers can continue paging until they find evidence; after reaching
        // the current end, the same cursor sees any later reimbursement event.
        { canister = minter; method = "get_events"; args = to_candid ({ start; length = pageSize }); cycles = 0 };
    };

    public func tailRequest(minter : Principal) : Capabilities.CallRequest {
        { canister = minter; method = "get_events"; args = to_candid ({ start = 0 : Nat64; length = 0 : Nat64 }); cycles = 0 };
    };

    public func tail(result : Capabilities.CallResult) : ?Nat64 {
        switch (result) {
            case (#err(_)) null;
            case (#ok(reply)) switch (from_candid reply : ?{ total_event_count : Nat64 }) {
                case null null;
                case (?value) ?value.total_event_count;
            };
        };
    };

    // Call only against the minter saved with the original partial-burn reply.
    // Each invocation inspects one page. Losing a caller's optional scan cursor
    // merely restarts read-only scanning at zero; it never repeats a withdrawal.
    public func inspect(result : Capabilities.CallResult, withdrawalId : Nat, start : Nat64) : Result<Scan> {
        let page = switch (result) {
            case (#err(error)) return #err("Could not check the ckETH reimbursement: " # error.code # ": " # error.message);
            case (#ok(reply)) switch (from_candid reply : ?Events) {
                case null return #err("The minter returned unrecognized reimbursement events.");
                case (?value) value;
            };
        };
        let next = Nat64.toNat(start) + page.events.size();
        if (start > page.total_event_count or next > Nat64.toNat(page.total_event_count)) {
            return #err("The minter returned an inconsistent reimbursement event range.");
        };
        if (page.events.size() == 0 and start < page.total_event_count) {
            return #err("The minter returned no events before the end of its reimbursement log. Retry this page.");
        };
        var evidence : ?Evidence = null;
        var evidence_index : ?Nat64 = null;
        var offset : Nat = 0;
        for (event in page.events.vals()) {
            let index = Nat64.fromNat(Nat64.toNat(start) + offset);
            switch (event.payload) {
                case (?#FailedErc20WithdrawalRequest(value)) {
                    if (value.withdrawal_id == withdrawalId) {
                        evidence := ?#scheduled(value);
                        evidence_index := ?index;
                    };
                };
                case (?#QuarantinedReimbursement(value)) switch (value.index) {
                    case (?#CkEth(burn)) {
                        if (burn.ledger_burn_index == withdrawalId) {
                            evidence := ?#quarantined({ withdrawal_id = withdrawalId });
                            evidence_index := ?index;
                        };
                    };
                    case (_) {};
                };
                case (?#ReimbursedEthWithdrawal(value)) {
                    if (value.withdrawal_id == withdrawalId) {
                        evidence := switch (value.transaction_hash) {
                            case null ?#reimbursed({ withdrawal_id = value.withdrawal_id; reimbursed_amount = value.reimbursed_amount; reimbursed_in_block = value.reimbursed_in_block });
                            case (?hash) ?#unexpected_transaction(hash);
                        };
                        evidence_index := ?index;
                    };
                };
                case (_) {};
            };
            offset += 1;
        };
        #ok({ start; next = Nat64.fromNat(next); total_event_count = page.total_event_count; exhausted = next == Nat64.toNat(page.total_event_count); evidence; evidence_index });
    };
};
