import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Int "mo:core/Int";
import List "mo:core/List";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Capabilities "../capabilities/Types";
import Memory "../memory/wallet/v1";
import Types "Types";

module {
    public type Account = {
        owner : Principal;
        subaccount : ?Blob;
    };

    type Transfer = {
        to : Account;
        fee : ?Nat;
        from : Account;
        memo : ?Blob;
        created_at_time : ?Nat64;
        amount : Nat;
        spender : ?Account;
    };

    type Mint = {
        to : Account;
        memo : ?Blob;
        created_at_time : ?Nat64;
        amount : Nat;
        fee : ?Nat;
    };

    type Burn = {
        from : Account;
        memo : ?Blob;
        created_at_time : ?Nat64;
        amount : Nat;
        spender : ?Account;
        fee : ?Nat;
    };

    type Approve = {
        fee : ?Nat;
        from : Account;
        memo : ?Blob;
        created_at_time : ?Nat64;
        amount : Nat;
        expected_allowance : ?Nat;
        expires_at : ?Nat64;
        spender : Account;
    };

    type Transaction = {
        burn : ?Burn;
        kind : Text;
        mint : ?Mint;
        approve : ?Approve;
        timestamp : Nat64;
        transfer : ?Transfer;
    };

    type TransactionWithId = {
        id : Nat;
        transaction : Transaction;
    };

    type GetTransactions = {
        balance : Nat;
        transactions : [TransactionWithId];
        oldest_tx_id : ?Nat;
    };

    type GetTransactionsResult = {
        #Ok : GetTransactions;
        #Err : { message : Text };
    };

    public func pageRequest(
        index : Principal,
        owner : Principal,
        start : ?Nat,
        maxResults : Nat,
    ) : Capabilities.CallRequest {
        {
            canister = index;
            method = "get_account_transactions";
            args = to_candid ({
                account = { owner; subaccount = null : ?Blob };
                start;
                max_results = maxResults;
            });
            cycles = 0;
        };
    };

    public func decodeHead(
        result : Capabilities.CallResult,
    ) : Types.Result<Types.AccountHead> {
        let response = switch (result) {
            case (#err(error)) return #err(callError(error));
            case (#ok(reply)) {
                let decoded : ?GetTransactionsResult = from_candid reply;
                switch (decoded) {
                    case null return #err("Index returned an invalid account head");
                    case (?#Err(error)) return #err(error.message);
                    case (?#Ok(value)) value;
                };
            };
        };
        if (response.transactions.size() > 1) {
            return #err("Index account head contains more than one transaction");
        };
        let newest = switch (response.transactions.size()) {
            case 0 {
                if (response.oldest_tx_id != null) {
                    return #err("Index omitted the newest account transaction");
                };
                null;
            };
            case (_) {
                let value = response.transactions[0].id;
                switch (response.oldest_tx_id) {
                    case (?oldest) if (oldest > value) {
                        return #err("Index returned an invalid oldest transaction id");
                    };
                    case (_) {};
                };
                ?value;
            };
        };
        #ok({ balance = response.balance; newest_block_id = newest });
    };

    public func decodePage(
        result : Capabilities.CallResult,
        owner : Principal,
        start : ?Nat,
        floor : Nat,
        targetTip : Nat,
    ) : Types.Result<Types.IndexedPage> {
        let response = switch (result) {
            case (#err(error)) return #err(callError(error));
            case (#ok(reply)) {
                let decoded : ?GetTransactionsResult = from_candid reply;
                switch (decoded) {
                    case null return #err("Index returned an invalid transaction page");
                    case (?#Err(error)) return #err(error.message);
                    case (?#Ok(value)) value;
                };
            };
        };
        if (response.transactions.size() > 1_000) {
            return #err("Index transaction page exceeds the Wallet limit");
        };
        let firstBlockId = if (response.transactions.size() == 0) null else {
            ?response.transactions[0].id;
        };
        if (not Types.capturedHeadMatches(firstBlockId, start, floor, targetTip)) {
            return #err("Index transaction page does not begin at the captured account head");
        };
        if (response.transactions.size() == 0 and targetTip > floor) {
            return #err("Index transaction page made no progress");
        };

        let transactions = List.empty<Memory.HistoryTransaction>();
        let unsupported = List.empty<Nat>();
        var previous : ?Nat = null;
        var crossedFloor = response.transactions.size() == 0;
        for (item in response.transactions.vals()) {
            switch (start) {
                case (?exclusive) if (item.id >= exclusive) {
                    return #err("Index transaction page overlaps its exclusive cursor");
                };
                case (_) {};
            };
            switch (previous) {
                case (?last) if (item.id >= last) {
                    return #err("Index transaction ids are not strictly descending");
                };
                case (_) {};
            };
            previous := ?item.id;
            if (item.id < floor) {
                crossedFloor := true;
            } else if (item.id >= targetTip) {
                return #err("Index returned a transaction beyond the captured ledger tip");
            } else {
                switch (convert(item, owner)) {
                    case (#err(error)) return #err(error);
                    case (#ok(null)) {
                        return #err("Index returned a transaction unrelated to the Wallet account");
                    };
                    case (#ok(?(transaction, isUnsupported))) {
                        List.add(transactions, transaction);
                        if (isUnsupported) List.add(unsupported, item.id);
                    };
                };
            };
        };

        let nextCursor = switch (previous) {
            case null null;
            case (?last) {
                if (response.oldest_tx_id == ?last) crossedFloor := true;
                if (crossedFloor) null else ?last;
            };
        };
        switch (response.oldest_tx_id, previous) {
            case (?oldest, ?last) if (oldest > last) {
                return #err("Index returned an invalid oldest transaction id");
            };
            case (_) {};
        };
        #ok({
            balance = response.balance;
            transactions = List.toArray(transactions);
            unsupported_block_ids = List.toArray(unsupported);
            oldest_tx_id = response.oldest_tx_id;
            next_cursor = nextCursor;
            crossed_floor = crossedFloor;
        });
    };

    func convert(
        item : TransactionWithId,
        owner : Principal,
    ) : Types.Result<?(Memory.HistoryTransaction, Bool)> {
        let transaction = item.transaction;
        let operationCount = optionCount(transaction.transfer) +
            optionCount(transaction.mint) + optionCount(transaction.burn) +
            optionCount(transaction.approve);
        if (operationCount != 1) {
            return #err("Index transaction has an invalid operation shape");
        };
        switch (transaction.transfer) {
            case (?value) {
                if (
                    not validAccount(value.from) or
                    not validAccount(value.to) or
                    not validOptionalAccount(value.spender)
                ) return #err("Index transfer contains an invalid ICRC account");
                let fromWallet = isWallet(value.from, owner);
                let toWallet = isWallet(value.to, owner);
                if (not fromWallet and not toWallet) return #ok(null);
                let fee = switch (value.fee) { case null 0; case (?amount) amount };
                let effect = if (fromWallet and toWallet) {
                    -Int.fromNat(fee);
                } else if (fromWallet) {
                    -Int.fromNat(value.amount + fee);
                } else {
                    Int.fromNat(value.amount);
                };
                #ok(?(base(
                    item.id,
                    #transfer,
                    transaction.timestamp,
                    value.amount,
                    value.fee,
                    effect,
                    ?address(value.from),
                    ?address(value.to),
                    switch (value.spender) { case null null; case (?v) ?address(v) },
                    value.memo,
                ), false));
            };
            case null switch (transaction.mint) {
                case (?value) {
                    if (not validAccount(value.to)) {
                        return #err("Index mint contains an invalid ICRC account");
                    };
                    if (not isWallet(value.to, owner)) return #ok(null);
                    let fee = switch (value.fee) { case null 0; case (?amount) amount };
                    if (fee > value.amount) {
                        return #err("Mint fee exceeds its amount");
                    };
                    #ok(?(base(
                        item.id,
                        #mint,
                        transaction.timestamp,
                        value.amount,
                        value.fee,
                        Int.fromNat(value.amount - fee),
                        null,
                        ?address(value.to),
                        null,
                        value.memo,
                    ), false));
                };
                case null switch (transaction.burn) {
                    case (?value) {
                        if (
                            not validAccount(value.from) or
                            not validOptionalAccount(value.spender)
                        ) return #err("Index burn contains an invalid ICRC account");
                        if (not isWallet(value.from, owner)) return #ok(null);
                        let fee = switch (value.fee) { case null 0; case (?amount) amount };
                        #ok(?(base(
                            item.id,
                            #burn,
                            transaction.timestamp,
                            value.amount,
                            value.fee,
                            -Int.fromNat(value.amount + fee),
                            ?address(value.from),
                            null,
                            switch (value.spender) { case null null; case (?v) ?address(v) },
                            value.memo,
                        ), false));
                    };
                    case null switch (transaction.approve) {
                        case (?value) {
                            if (
                                not validAccount(value.from) or
                                not validAccount(value.spender)
                            ) return #err("Index approval contains an invalid ICRC account");
                            if (not isWallet(value.from, owner)) return #ok(null);
                            let unsupported = value.fee == null;
                            let fee = switch (value.fee) { case null 0; case (?amount) amount };
                            #ok(?(base(
                                item.id,
                                #approve,
                                transaction.timestamp,
                                value.amount,
                                value.fee,
                                -Int.fromNat(fee),
                                ?address(value.from),
                                null,
                                ?address(value.spender),
                                value.memo,
                            ), unsupported));
                        };
                        case null #err("Index transaction operation is missing");
                    };
                };
            };
        };
    };

    func base(
        blockIndex : Nat,
        operation : Memory.HistoryOperation,
        timestamp : Nat64,
        amount : Nat,
        fee : ?Nat,
        effect : Int,
        from : ?Memory.HistoryAddress,
        to : ?Memory.HistoryAddress,
        spender : ?Memory.HistoryAddress,
        memo : ?Blob,
    ) : Memory.HistoryTransaction {
        {
            block_index = blockIndex;
            operation;
            timestamp_ns = timestamp;
            amount;
            fee;
            balance_effect = effect;
            from;
            to;
            spender;
            memo = boundedMemo(memo);
            intent = null;
            native = null;
            provenance = #index;
            verification = #pending;
        };
    };

    func isWallet(account : Account, owner : Principal) : Bool {
        account.owner == owner and isDefaultSubaccount(account.subaccount);
    };

    func validAccount(account : Account) : Bool {
        switch (account.subaccount) {
            case null true;
            case (?value) value.size() == 32;
        };
    };

    func validOptionalAccount(account : ?Account) : Bool {
        switch (account) {
            case null true;
            case (?value) validAccount(value);
        };
    };

    func isDefaultSubaccount(subaccount : ?Blob) : Bool {
        switch (subaccount) {
            case null true;
            case (?value) {
                if (value.size() != 32) return false;
                for (byte in value.vals()) if (byte != 0) return false;
                true;
            };
        };
    };

    func address(account : Account) : Memory.HistoryAddress {
        #icrc({
            owner = account.owner;
            subaccount = if (isDefaultSubaccount(account.subaccount)) null else account.subaccount;
        });
    };

    func boundedMemo(memo : ?Blob) : ?Blob {
        switch (memo) {
            case null null;
            case (?value) {
                if (value.size() <= 256) ?value else {
                    let bytes = Blob.toArray(value);
                    ?Blob.fromArray(Array.tabulate<Nat8>(256, func(index) {
                        bytes[index];
                    }));
                };
            };
        };
    };

    func optionCount<T>(value : ?T) : Nat {
        switch (value) { case null 0; case (?_) 1 };
    };

    func callError(error : Capabilities.CallError) : Text {
        error.code # ": " # error.message;
    };
};
