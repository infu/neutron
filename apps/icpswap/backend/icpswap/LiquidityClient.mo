/// ICPSwap liquidity wire contracts. All calls use the existing backend broker.
/// Transport failures and malformed success replies remain unknown outcomes.
/// A decoded pool error is a protocol reply, not proof that no effect occurred:
/// funding methods can return errors after an uncertain ledger call.
import Nat "mo:core/Nat";
import Array "mo:core/Array";
import Types "./Types";
import ProtocolReply "./ProtocolReply";
import NeutronCapabilities "mo:neutron-capabilities";

module {
    public type CallRequest = NeutronCapabilities.BackendCallRequestV1;
    public type CallResult = NeutronCapabilities.BackendCallResultV1;
    /// #rejected means the pool returned its Candid #err variant. It does not
    /// assert retry safety or absence of effects; callers reconcile according
    /// to the particular method's funding/mutation/withdrawal semantics.
    public type Outcome<T> = { #ok : T; #rejected : Text; #unknown : Text };
    public type PoolResult<T> = { #ok : T; #err : Types.SwapError };

    public type Position = {
        tickLower : Int;
        tickUpper : Int;
        liquidity : Nat;
        tokensOwed0 : Nat;
        tokensOwed1 : Nat;
    };
    public type PositionWithId = {
        id : Nat;
        tickLower : Int;
        tickUpper : Int;
        liquidity : Nat;
        tokensOwed0 : Nat;
        tokensOwed1 : Nat;
    };
    public type Amounts = { amount0 : Nat; amount1 : Nat };
    public type Account = { owner : Principal; subaccount : ?Blob };
    public type TransactionToken = { address : Principal; standard : Text };

    public type WithdrawQueueItem = {
        txIndex : Nat;
        caller : Principal;
        token : Types.TokenRef;
        amount : Nat;
        fee : Nat;
        from : Account;
        to : Account;
        memo : ?Blob;
    };
    public type WithdrawQueue = {
        items : [WithdrawQueueItem];
        token0TotalAmount : Nat;
        token1TotalAmount : Nat;
    };

    /// This is the union of every status present in the deployed pool's
    /// transaction variants. A wider decoder variant accepts narrower wire
    /// variants without dropping unrelated pending owner operations.
    public type Status = {
        #Created;
        #Completed;
        #Failed;
        #CreditCompleted;
        #TransferCompleted;
        #DepositCreditCompleted;
        #DepositTransferCompleted;
        #PreSwapCompleted;
        #SwapCompleted;
        #WithdrawCreditCompleted;
        #LimitOrderDeleted;
    };
    public type Transfer = {
        token : Principal;
        amount : Nat;
        fee : Nat;
        from : Account;
        to : Account;
        index : Nat;
        memo : ?Blob;
        standard : Text;
    };
    public type TransferInfo = {
        transfer : Transfer;
        status : Status;
        err : ?Text;
    };
    public type RefundInfo = {
        transfer : Transfer;
        relatedIndex : Nat;
        status : Status;
        err : ?Text;
    };
    public type LiquidityInfo = {
        positionId : Nat;
        token0 : TransactionToken;
        token1 : TransactionToken;
        amount0 : Nat;
        amount1 : Nat;
        liquidity : Nat;
        status : Status;
        err : ?Text;
    };
    public type ClaimInfo = {
        positionId : Nat;
        token0 : TransactionToken;
        token1 : TransactionToken;
        amount0 : Nat;
        amount1 : Nat;
        status : Status;
        err : ?Text;
    };
    public type PositionActionInfo = {
        positionId : Nat;
        status : Status;
        err : ?Text;
    };
    public type SwapInfo = {
        tokenIn : TransactionToken;
        tokenOut : TransactionToken;
        amountIn : Nat;
        amountOut : Nat;
        status : Status;
        err : ?Text;
    };
    public type OneStepSwapInfo = {
        deposit : TransferInfo;
        swap : SwapInfo;
        withdraw : TransferInfo;
        status : Status;
        err : ?Text;
    };
    /// Keep all labels from the deployed Action variant. Record subtyping
    /// drops unused fields; a partial variant would reject unrelated actions.
    public type Action = {
        #AddLimitOrder : PositionActionInfo;
        #AddLiquidity : LiquidityInfo;
        #Claim : ClaimInfo;
        #DecreaseLiquidity : LiquidityInfo;
        #Deposit : TransferInfo;
        #ExecuteLimitOrder : PositionActionInfo;
        #OneStepSwap : OneStepSwapInfo;
        #Refund : RefundInfo;
        #RemoveLimitOrder : PositionActionInfo;
        #Swap : SwapInfo;
        #TransferPosition : PositionActionInfo;
        #Withdraw : TransferInfo;
    };
    public type Transaction = {
        id : Nat;
        timestamp : Int;
        owner : Principal;
        canisterId : Principal;
        action : Action;
    };
    public type TransactionSummary = {
        id : Nat;
        kind : Text;
        state : Text;
        token : ?Principal;
        amount : Nat;
        error : Text;
        unused_reserved : Bool;
        support_required : Bool;
    };

    public func statusText(status : Status) : Text {
        switch (status) {
            case (#Created) "Created";
            case (#Completed) "Completed";
            case (#Failed) "Failed";
            case (#CreditCompleted) "CreditCompleted";
            case (#TransferCompleted) "TransferCompleted";
            case (#DepositCreditCompleted) "DepositCreditCompleted";
            case (#DepositTransferCompleted) "DepositTransferCompleted";
            case (#PreSwapCompleted) "PreSwapCompleted";
            case (#SwapCompleted) "SwapCompleted";
            case (#WithdrawCreditCompleted) "WithdrawCreditCompleted";
            case (#LimitOrderDeleted) "LimitOrderDeleted";
        };
    };

    func errorText(error : ?Text) : Text {
        switch (error) { case (?value) value; case null "" };
    };

    /// Reservations describe funds still present in the observed unused
    /// balance but promised to an already queued/in-flight protocol effect.
    /// CreditCompleted means the pool already debited that balance. Do not
    /// subtract the queue total again in addition to these reservations.
    public func summarizeTransaction(transaction : Transaction) : TransactionSummary {
        func summary(kind : Text, status : Status, token : ?Principal, amount : Nat, error : ?Text, reserved : Bool, supportRequired : Bool) : TransactionSummary {
            {
                id = transaction.id;
                kind;
                state = statusText(status);
                token;
                amount;
                error = errorText(error);
                unused_reserved = reserved;
                support_required = supportRequired;
            };
        };
        switch (transaction.action) {
            case (#Withdraw(info)) summary(
                "Withdraw", info.status, ?info.transfer.token, info.transfer.amount, info.err,
                info.status == #Created and info.transfer.amount > info.transfer.fee,
                info.status == #Failed,
            );
            case (#Refund(info)) summary(
                "Refund", info.status, ?info.transfer.token, info.transfer.amount, info.err, false,
                info.status == #Failed,
            );
            case (#Deposit(info)) summary("Deposit", info.status, ?info.transfer.token, info.transfer.amount, info.err, false, false);
            case (#OneStepSwap(info)) {
                let output = info.swap.status == #Completed;
                let reserved = if (output) {
                    info.status == #SwapCompleted and info.withdraw.status == #Created and info.swap.amountOut > info.withdraw.transfer.fee;
                } else {
                    info.deposit.status == #Completed and (info.status == #DepositCreditCompleted or info.status == #PreSwapCompleted);
                };
                let error = switch (info.withdraw.err) {
                    case (?message) ?message;
                    case null info.err;
                };
                summary(
                    "OneStepSwap", info.status,
                    ?(if (output) info.swap.tokenOut.address else info.swap.tokenIn.address),
                    if (output) info.swap.amountOut else info.deposit.transfer.amount,
                    error, reserved, output and info.withdraw.status == #Failed,
                );
            };
            case (#AddLiquidity(info)) summary("AddLiquidity", info.status, null, 0, info.err, false, false);
            case (#DecreaseLiquidity(info)) summary("DecreaseLiquidity", info.status, null, 0, info.err, false, false);
            case (#Claim(info)) summary("Claim", info.status, null, 0, info.err, false, false);
            case (#Swap(info)) summary("Swap", info.status, ?info.tokenIn.address, info.amountIn, info.err, false, false);
            case (#AddLimitOrder(info)) summary("AddLimitOrder", info.status, null, 0, info.err, false, false);
            case (#ExecuteLimitOrder(info)) summary("ExecuteLimitOrder", info.status, null, 0, info.err, false, false);
            case (#RemoveLimitOrder(info)) summary("RemoveLimitOrder", info.status, null, 0, info.err, false, false);
            case (#TransferPosition(info)) summary("TransferPosition", info.status, null, 0, info.err, false, false);
        };
    };

    public func summarizeTransactions(transactions : [(Nat, Transaction)]) : [TransactionSummary] {
        Array.map<(Nat, Transaction), TransactionSummary>(transactions, func((_, transaction)) { summarizeTransaction(transaction) });
    };

    /// Application amounts are Nat; the request builders encode the exact
    /// decimal Text fields required by the pool's Candid interface.
    public type MintArgs = {
        token0 : Text;
        token1 : Text;
        fee : Nat;
        tickLower : Int;
        tickUpper : Int;
        amount0Desired : Nat;
        amount1Desired : Nat;
    };

    func request(pool : Principal, method : Text, args : Blob) : CallRequest {
        { canister = pool; method; args; cycles = 0 };
    };

    public func positionsRequest(pool : Principal, owner : Principal) : CallRequest {
        request(pool, "getUserPositionsByPrincipal", to_candid (owner));
    };
    public func positionRequest(pool : Principal, positionId : Nat) : CallRequest {
        request(pool, "getUserPosition", to_candid (positionId));
    };
    public func withdrawQueueRequest(pool : Principal) : CallRequest {
        // This query uses msg.caller; the broker preserves Neutron ownership.
        request(pool, "getUserWithdrawQueue", to_candid ());
    };
    public func transactionsRequest(pool : Principal, owner : Principal) : CallRequest {
        request(pool, "getTransactionsByOwner", to_candid (owner));
    };
    public func mintRequest(pool : Principal, args : MintArgs) : CallRequest {
        request(pool, "mint", to_candid ({
            token0 = args.token0;
            token1 = args.token1;
            fee = args.fee;
            tickLower = args.tickLower;
            tickUpper = args.tickUpper;
            amount0Desired = Nat.toText(args.amount0Desired);
            amount1Desired = Nat.toText(args.amount1Desired);
        }));
    };
    public func increaseRequest(pool : Principal, positionId : Nat, amount0 : Nat, amount1 : Nat) : CallRequest {
        request(pool, "increaseLiquidity", to_candid ({
            positionId;
            amount0Desired = Nat.toText(amount0);
            amount1Desired = Nat.toText(amount1);
        }));
    };
    public func decreaseRequest(pool : Principal, positionId : Nat, liquidity : Nat) : CallRequest {
        request(pool, "decreaseLiquidity", to_candid ({ positionId; liquidity = Nat.toText(liquidity) }));
    };
    public func claimRequest(pool : Principal, positionId : Nat) : CallRequest {
        request(pool, "claim", to_candid ({ positionId }));
    };
    public func depositRequest(pool : Principal, token : Text, amount : Nat, fee : Nat) : CallRequest {
        request(pool, "deposit", to_candid ({ token; amount; fee }));
    };
    public func depositFromRequest(pool : Principal, token : Text, amount : Nat, fee : Nat) : CallRequest {
        request(pool, "depositFrom", to_candid ({ token; amount; fee }));
    };
    public func withdrawRequest(pool : Principal, token : Text, amount : Nat, fee : Nat) : CallRequest {
        request(pool, "withdraw", to_candid ({ token; amount; fee }));
    };

    func describeError(error : Types.SwapError) : Text {
        switch (error) {
            case (#CommonError) "common error";
            case (#InsufficientFunds) "insufficient funds";
            case (#InternalError(message)) "internal error: " # message;
            case (#UnsupportedToken(message)) "unsupported token: " # message;
        };
    };

    func decode<T>(context : Text, result : CallResult, parse : Blob -> ?PoolResult<T>) : Outcome<T> {
        switch (result) {
            case (#err(error)) #unknown(context # ": " # error.code # ": " # error.message);
            case (#ok(bytes)) {
                switch (parse(bytes)) {
                    case null #unknown(context # ": unexpected reply shape");
                    case (?(#err(error))) #rejected(context # ": " # describeError(error));
                    case (?(#ok(value))) #ok(value);
                };
            };
        };
    };

    public func decodePositions(result : CallResult) : Outcome<[PositionWithId]> {
        decode<[PositionWithId]>("positions", result, func(bytes : Blob) : ?PoolResult<[PositionWithId]> { from_candid bytes });
    };
    public func decodePosition(result : CallResult) : Outcome<Position> {
        decode<Position>("position", result, func(bytes : Blob) : ?PoolResult<Position> { from_candid bytes });
    };
    public func decodeWithdrawQueue(result : CallResult) : Outcome<WithdrawQueue> {
        decode<WithdrawQueue>("withdrawal queue", result, func(bytes : Blob) : ?PoolResult<WithdrawQueue> { from_candid bytes });
    };
    public func decodeTransactions(result : CallResult) : Outcome<[(Nat, Transaction)]> {
        decode<[(Nat, Transaction)]>("pool transactions", result, func(bytes : Blob) : ?PoolResult<[(Nat, Transaction)]> { from_candid bytes });
    };
    public func decodeNat(result : CallResult) : Outcome<Nat> {
        switch (result) {
            case (#err(error)) #unknown("pool operation: " # error.code # ": " # error.message);
            case (#ok(bytes)) ProtocolReply.decodeNat(bytes);
        };
    };
    public func decodeAmounts(result : CallResult) : Outcome<Amounts> {
        switch (result) {
            case (#err(error)) #unknown("liquidity payout: " # error.code # ": " # error.message);
            case (#ok(bytes)) ProtocolReply.decodeAmounts(bytes);
        };
    };
}
