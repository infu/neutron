import Capabilities "../capabilities/Types";
import FundingDisplay "../funding/Display";
import Nat64 "mo:core/Nat64";
import Types "Types";

module {
    public let MAX_EXECUTION_REPLY_BYTES : Nat = 16_384;

    public type ExecutionReceipt = {
        block_index : Nat;
        duplicate : Bool;
    };

    // A broker failure after dispatch or a malformed successful reply cannot
    // prove whether the ledger committed the update. Callers with durable
    // arguments can reconcile or replay the exact operation; they must not
    // synthesize fresh arguments after #unknown.
    public type ExecutionResult = {
        #ok : ExecutionReceipt;
        #rejected : Text;
        #unknown : Text;
    };

    public func metadataRequest(ledger : Principal) : Capabilities.CallRequest {
        {
            canister = ledger;
            method = "icrc1_metadata";
            args = to_candid ();
            cycles = 0;
        };
    };

    public func balanceRequest(
        ledger : Principal,
        owner : Principal,
    ) : Capabilities.CallRequest {
        let account : Types.Account = {
            owner;
            subaccount = null;
        };
        {
            canister = ledger;
            method = "icrc1_balance_of";
            args = to_candid (account);
            cycles = 0;
        };
    };

    public func feeRequest(ledger : Principal) : Capabilities.CallRequest {
        {
            canister = ledger;
            method = "icrc1_fee";
            args = to_candid ();
            cycles = 0;
        };
    };

    public func allowanceRequest(
        ledger : Principal,
        account : Types.Account,
        spender : Types.Account,
    ) : Capabilities.CallRequest {
        let args : Types.AllowanceArgs = { account; spender };
        {
            canister = ledger;
            method = "icrc2_allowance";
            args = to_candid (args);
            cycles = 0;
        };
    };

    public func transferCandidRequest(
        ledger : Principal,
        args : Blob,
    ) : Capabilities.CallRequest {
        {
            canister = ledger;
            method = "icrc1_transfer";
            args;
            cycles = 0;
        };
    };

    public func approveCandidRequest(
        ledger : Principal,
        args : Blob,
    ) : Capabilities.CallRequest {
        {
            canister = ledger;
            method = "icrc2_approve";
            args;
            cycles = 0;
        };
    };

    public func executeTransfer(
        calls : Capabilities.BackendCalls,
        ledger : Principal,
        args : Types.TransferArg,
    ) : async* ExecutionResult {
        await* executeTransferCandid(calls, ledger, to_candid (args));
    };

    public func executeTransferCandid(
        calls : Capabilities.BackendCalls,
        ledger : Principal,
        args : Blob,
    ) : async* ExecutionResult {
        classifyTransferResult(await* calls.call(transferCandidRequest(ledger, args)));
    };

    public func classifyTransferResult(
        result : Capabilities.CallResult,
    ) : ExecutionResult {
        switch (result) {
            case (#err(error)) callFailure(error);
            case (#ok(reply)) {
                if (reply.size() > MAX_EXECUTION_REPLY_BYTES) {
                    return #unknown(
                        "Ledger transfer reply exceeds the Wallet limit after dispatch"
                    );
                };
                let decoded : ?Types.TransferResult = from_candid reply;
                switch (decoded) {
                    case (?#Ok(blockIndex)) #ok({
                        block_index = blockIndex;
                        duplicate = false;
                    });
                    case (?#Err(#Duplicate(value))) #ok({
                        block_index = value.duplicate_of;
                        duplicate = true;
                    });
                    case (?#Err(error)) #rejected(transferErrorText(error));
                    case null #unknown(
                        "Ledger returned an unexpected transfer result after dispatch",
                    );
                };
            };
        };
    };

    public func executeApprove(
        calls : Capabilities.BackendCalls,
        ledger : Principal,
        args : Types.ApproveArg,
    ) : async* ExecutionResult {
        await* executeApproveCandid(calls, ledger, to_candid (args));
    };

    public func executeApproveCandid(
        calls : Capabilities.BackendCalls,
        ledger : Principal,
        args : Blob,
    ) : async* ExecutionResult {
        classifyApproveResult(await* calls.call(approveCandidRequest(ledger, args)));
    };

    public func classifyApproveResult(
        result : Capabilities.CallResult,
    ) : ExecutionResult {
        switch (result) {
            case (#err(error)) callFailure(error);
            case (#ok(reply)) {
                if (reply.size() > MAX_EXECUTION_REPLY_BYTES) {
                    return #unknown(
                        "Ledger approval reply exceeds the Wallet limit after dispatch"
                    );
                };
                let decoded : ?Types.ApproveResult = from_candid reply;
                switch (decoded) {
                    case (?#Ok(blockIndex)) #ok({
                        block_index = blockIndex;
                        duplicate = false;
                    });
                    case (?#Err(#Duplicate(value))) #ok({
                        block_index = value.duplicate_of;
                        duplicate = true;
                    });
                    case (?#Err(error)) #rejected(approveErrorText(error));
                    case null #unknown(
                        "Ledger returned an unexpected approval result after dispatch",
                    );
                };
            };
        };
    };

    public func decodeMetadata(
        result : Capabilities.CallResult,
    ) : Types.Result<Types.Metadata> {
        switch (result) {
            case (#err(error)) #err(FundingDisplay.callError(error.code, error.message));
            case (#ok(reply)) {
                let decoded : ?Types.Metadata = from_candid reply;
                switch (decoded) {
                    case (?metadata) #ok(metadata);
                    case null #err("Ledger returned unexpected metadata");
                };
            };
        };
    };

    public func decodeBalance(
        result : Capabilities.CallResult,
    ) : Types.Result<Nat> {
        switch (result) {
            case (#err(error)) #err(FundingDisplay.callError(error.code, error.message));
            case (#ok(reply)) {
                let decoded : ?Nat = from_candid reply;
                switch (decoded) {
                    case (?balance) #ok(balance);
                    case null #err("Ledger returned an unexpected balance");
                };
            };
        };
    };

    public func decodeFee(result : Capabilities.CallResult) : Types.Result<Nat> {
        decodeNat(result, "fee");
    };

    public func decodeAllowance(
        result : Capabilities.CallResult,
    ) : Types.Result<Types.Allowance> {
        switch (result) {
            case (#err(error)) #err(FundingDisplay.callError(error.code, error.message));
            case (#ok(reply)) {
                let decoded : ?Types.Allowance = from_candid reply;
                switch (decoded) {
                    case (?allowance) #ok(allowance);
                    case null #err("Ledger returned an unexpected allowance");
                };
            };
        };
    };

    public func transferErrorText(error : Types.TransferError) : Text {
        switch (error) {
            case (#BadFee(value)) {
                "Ledger fee changed to " # FundingDisplay.natText(value.expected_fee);
            };
            case (#BadBurn(value)) {
                "Amount is below the minimum burn amount " #
                FundingDisplay.natText(value.min_burn_amount);
            };
            case (#InsufficientFunds(value)) {
                "Insufficient funds; current balance is " # FundingDisplay.natText(value.balance);
            };
            case (#TooOld) "Transfer request is too old";
            case (#CreatedInFuture(value)) {
                "Transfer timestamp is ahead of ledger time " #
                Nat64.toText(value.ledger_time);
            };
            case (#TemporarilyUnavailable) "Ledger is temporarily unavailable";
            case (#Duplicate(value)) {
                "Transfer was already recorded in block " # FundingDisplay.natText(value.duplicate_of);
            };
            case (#GenericError(value)) {
                "Ledger error " # FundingDisplay.natText(value.error_code) # ": " #
                FundingDisplay.prefix(value.message, FundingDisplay.MAX_ERROR_MESSAGE_CHARS);
            };
        };
    };

    public func approveErrorText(error : Types.ApproveError) : Text {
        switch (error) {
            case (#BadFee(value)) {
                "Ledger approval fee changed to " # FundingDisplay.natText(value.expected_fee);
            };
            case (#InsufficientFunds(value)) {
                "Insufficient funds for approval; current balance is " #
                FundingDisplay.natText(value.balance);
            };
            case (#AllowanceChanged(value)) {
                "Ledger allowance changed to " # FundingDisplay.natText(value.current_allowance);
            };
            case (#Expired(value)) {
                "Approval expired at ledger time " # Nat64.toText(value.ledger_time);
            };
            case (#TooOld) "Approval request is too old";
            case (#CreatedInFuture(value)) {
                "Approval timestamp is ahead of ledger time " #
                Nat64.toText(value.ledger_time);
            };
            case (#Duplicate(value)) {
                "Approval was already recorded in block " #
                FundingDisplay.natText(value.duplicate_of);
            };
            case (#TemporarilyUnavailable) "Ledger is temporarily unavailable";
            case (#GenericError(value)) {
                "Ledger error " # FundingDisplay.natText(value.error_code) # ": " #
                FundingDisplay.prefix(value.message, FundingDisplay.MAX_ERROR_MESSAGE_CHARS);
            };
        };
    };

    func callFailure(error : Capabilities.CallError) : ExecutionResult {
        let message = FundingDisplay.callError(error.code, error.message);
        switch (error.code) {
            // These failures are produced before the broker creates the remote
            // future. A later provider review may prepare a new command after
            // the underlying permission or resource issue is resolved.
            case ("concurrency_limit") #rejected(message);
            case ("scheduled_budget_exhausted") #rejected(message);
            case ("low_cycles") #rejected(message);
            case ("cycles_daily_limit") #rejected(message);
            case ("capability_revoked") #rejected(message);
            case ("capability_disabled") #rejected(message);
            case ("capability_missing") #rejected(message);
            case ("not_reserved") #rejected(message);
            case ("invocation_expired") #rejected(message);
            case ("target_blocked") #rejected(message);
            case ("invalid_method") #rejected(message);
            case ("argument_limit") #rejected(message);
            case ("cycles_per_call_limit") #rejected(message);
            case ("batch_limit") #rejected(message);
            // Known post-dispatch errors, raw IC rejections, internal broker
            // failures, and future unknown codes all fail conservatively.
            case (_) #unknown(message);
        };
    };

    func decodeNat(
        result : Capabilities.CallResult,
        valueLabel : Text,
    ) : Types.Result<Nat> {
        switch (result) {
            case (#err(error)) #err(FundingDisplay.callError(error.code, error.message));
            case (#ok(reply)) {
                let decoded : ?Nat = from_candid reply;
                switch (decoded) {
                    case (?value) #ok(value);
                    case null #err("Ledger returned an unexpected " # valueLabel);
                };
            };
        };
    };
};
