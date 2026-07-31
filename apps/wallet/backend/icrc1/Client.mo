import Capabilities "../capabilities/Types";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Types "Types";

module {
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

    public func transferRequest(
        ledger : Principal,
        destination : Types.Account,
        amount : Nat,
        fee : Nat,
        createdAt : Nat64,
    ) : Capabilities.CallRequest {
        let args : Types.TransferArg = {
            from_subaccount = null;
            to = destination;
            amount;
            fee = ?fee;
            memo = null;
            created_at_time = ?createdAt;
        };
        {
            canister = ledger;
            method = "icrc1_transfer";
            args = to_candid (args);
            cycles = 0;
        };
    };

    public func approveRequest(
        ledger : Principal,
        spender : Principal,
        amount : Nat,
        fee : Nat,
        createdAt : Nat64,
        expiresAt : Nat64,
    ) : Capabilities.CallRequest {
        let args : Types.ApproveArg = {
            from_subaccount = null;
            spender = { owner = spender; subaccount = null };
            amount;
            expected_allowance = null;
            expires_at = ?expiresAt;
            fee = ?fee;
            memo = null;
            created_at_time = ?createdAt;
        };
        {
            canister = ledger;
            method = "icrc2_approve";
            args = to_candid (args);
            cycles = 0;
        };
    };

    public func decodeMetadata(
        result : Capabilities.CallResult,
    ) : Types.Result<Types.Metadata> {
        switch (result) {
            case (#err(error)) #err(error.code # ": " # error.message);
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
            case (#err(error)) #err(error.code # ": " # error.message);
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

    public func decodeTransfer(
        result : Capabilities.CallResult,
    ) : Types.Result<Types.TransferResult> {
        switch (result) {
            case (#err(error)) #err(error.code # ": " # error.message);
            case (#ok(reply)) {
                let decoded : ?Types.TransferResult = from_candid reply;
                switch (decoded) {
                    case (?transfer) #ok(transfer);
                    case null #err("Ledger returned an unexpected transfer result");
                };
            };
        };
    };

    public func decodeApprove(
        result : Capabilities.CallResult,
    ) : Types.Result<Types.ApproveResult> {
        switch (result) {
            case (#err(error)) #err(error.code # ": " # error.message);
            case (#ok(reply)) {
                let decoded : ?Types.ApproveResult = from_candid reply;
                switch (decoded) {
                    case (?approval) #ok(approval);
                    case null #err("Ledger returned an unexpected approval result");
                };
            };
        };
    };

    public func transferErrorText(error : Types.TransferError) : Text {
        switch (error) {
            case (#BadFee(value)) {
                "Ledger fee changed to " # Nat.toText(value.expected_fee);
            };
            case (#BadBurn(value)) {
                "Amount is below the minimum burn amount " #
                Nat.toText(value.min_burn_amount);
            };
            case (#InsufficientFunds(value)) {
                "Insufficient funds; current balance is " # Nat.toText(value.balance);
            };
            case (#TooOld) "Transfer request is too old";
            case (#CreatedInFuture(value)) {
                "Transfer timestamp is ahead of ledger time " #
                Nat64.toText(value.ledger_time);
            };
            case (#TemporarilyUnavailable) "Ledger is temporarily unavailable";
            case (#Duplicate(value)) {
                "Transfer was already recorded in block " # Nat.toText(value.duplicate_of);
            };
            case (#GenericError(value)) {
                "Ledger error " # Nat.toText(value.error_code) # ": " # value.message;
            };
        };
    };

    public func approveErrorText(error : Types.ApproveError) : Text {
        switch (error) {
            case (#BadFee(value)) {
                "Ledger approval fee changed to " # Nat.toText(value.expected_fee);
            };
            case (#InsufficientFunds(value)) {
                "Insufficient funds for approval; current balance is " #
                Nat.toText(value.balance);
            };
            case (#AllowanceChanged(value)) {
                "Ledger allowance changed to " # Nat.toText(value.current_allowance);
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
                Nat.toText(value.duplicate_of);
            };
            case (#TemporarilyUnavailable) "Ledger is temporarily unavailable";
            case (#GenericError(value)) {
                "Ledger error " # Nat.toText(value.error_code) # ": " # value.message;
            };
        };
    };

    func decodeNat(
        result : Capabilities.CallResult,
        valueLabel : Text,
    ) : Types.Result<Nat> {
        switch (result) {
            case (#err(error)) #err(error.code # ": " # error.message);
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
