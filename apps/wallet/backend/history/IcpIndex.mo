import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Int "mo:core/Int";
import List "mo:core/List";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Capabilities "../capabilities/Types";
import Memory "../memory/wallet/v1";
import AccountIdentifier "AccountIdentifier";
import Types "Types";

module {
    type Account = { owner : Principal; subaccount : ?Blob };
    type Tokens = { e8s : Nat64 };
    type Timestamp = { timestamp_nanos : Nat64 };

    type Operation = {
        #Approve : {
            fee : Tokens;
            from : Text;
            allowance : Tokens;
            expires_at : ?Timestamp;
            spender : Text;
            expected_allowance : ?Tokens;
        };
        #Burn : { from : Text; amount : Tokens; spender : ?Text };
        #Mint : { to : Text; amount : Tokens };
        #Transfer : {
            to : Text;
            fee : Tokens;
            from : Text;
            amount : Tokens;
            spender : ?Text;
        };
    };

    type Transaction = {
        memo : Nat64;
        icrc1_memo : ?Blob;
        operation : Operation;
        created_at_time : ?Timestamp;
        timestamp : ?Timestamp;
    };

    type TransactionWithId = { id : Nat64; transaction : Transaction };
    type Response = {
        balance : Nat64;
        transactions : [TransactionWithId];
        oldest_tx_id : ?Nat64;
    };
    type Result = { #Ok : Response; #Err : { message : Text } };

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
                let decoded : ?Result = from_candid reply;
                switch (decoded) {
                    case null return #err("ICP index returned an invalid account head");
                    case (?#Err(error)) return #err(error.message);
                    case (?#Ok(value)) value;
                };
            };
        };
        if (response.transactions.size() > 1) {
            return #err("ICP index account head contains more than one transaction");
        };
        let newest = switch (response.transactions.size()) {
            case 0 {
                if (response.oldest_tx_id != null) {
                    return #err("ICP index omitted the newest account transaction");
                };
                null;
            };
            case (_) {
                let value = response.transactions[0].id;
                switch (response.oldest_tx_id) {
                    case (?oldest) if (oldest > value) {
                        return #err("ICP index returned an invalid oldest transaction id");
                    };
                    case (_) {};
                };
                ?Nat64.toNat(value);
            };
        };
        #ok({
            balance = Nat64.toNat(response.balance);
            newest_block_id = newest;
        });
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
                let decoded : ?Result = from_candid reply;
                switch (decoded) {
                    case null return #err("ICP index returned an invalid transaction page");
                    case (?#Err(error)) return #err(error.message);
                    case (?#Ok(value)) value;
                };
            };
        };
        if (response.transactions.size() > 1_000) {
            return #err("ICP index transaction page exceeds the Wallet limit");
        };
        let firstBlockId = if (response.transactions.size() == 0) null else {
            ?Nat64.toNat(response.transactions[0].id);
        };
        if (not Types.capturedHeadMatches(firstBlockId, start, floor, targetTip)) {
            return #err("ICP index transaction page does not begin at the captured account head");
        };

        let walletId = AccountIdentifier.fromPrincipal(owner);
        let transactions = List.empty<Memory.HistoryTransaction>();
        var previous : ?Nat = null;
        var crossedFloor = response.transactions.size() == 0;
        for (item in response.transactions.vals()) {
            let id = Nat64.toNat(item.id);
            switch (start) {
                case (?exclusive) if (id >= exclusive) {
                    return #err("ICP index transaction page overlaps its exclusive cursor");
                };
                case (_) {};
            };
            switch (previous) {
                case (?last) if (id >= last) {
                    return #err("ICP index transaction ids are not strictly descending");
                };
                case (_) {};
            };
            previous := ?id;
            if (id < floor) {
                crossedFloor := true;
            } else if (id >= targetTip) {
                return #err("ICP index returned a transaction beyond the captured tip");
            } else {
                switch (convert(item, walletId)) {
                    case (#err(error)) return #err(error);
                    case (#ok(null)) {};
                    case (#ok(?transaction)) List.add(transactions, transaction);
                };
            };
        };

        let oldest = switch (response.oldest_tx_id) {
            case null null;
            case (?value) ?Nat64.toNat(value);
        };
        let nextCursor = switch (previous) {
            case null null;
            case (?last) {
                if (oldest == ?last) crossedFloor := true;
                if (crossedFloor) null else ?last;
            };
        };
        switch (oldest, previous) {
            case (?oldestId, ?last) if (oldestId > last) {
                return #err("ICP index returned an invalid oldest transaction id");
            };
            case (_) {};
        };
        #ok({
            balance = Nat64.toNat(response.balance);
            transactions = List.toArray(transactions);
            unsupported_block_ids = [];
            oldest_tx_id = oldest;
            next_cursor = nextCursor;
            crossed_floor = crossedFloor;
        });
    };

    func convert(
        item : TransactionWithId,
        wallet : Blob,
    ) : Types.Result<?Memory.HistoryTransaction> {
        let timestamp = switch (item.transaction.timestamp) {
            case (?value) value.timestamp_nanos;
            case null switch (item.transaction.created_at_time) {
                case (?value) value.timestamp_nanos;
                case null (0 : Nat64);
            };
        };
        let memo = switch (item.transaction.icrc1_memo) {
            case (?value) boundedMemo(?value);
            case null ?nat64Blob(item.transaction.memo);
        };
        switch (item.transaction.operation) {
            case (#Mint(value)) {
                let to = switch (parseAddress(value.to)) {
                    case (#err(error)) return #err(error);
                    case (#ok(address)) address;
                };
                if (to != wallet) {
                    return #err("ICP index returned a mint unrelated to the Wallet account");
                };
                #ok(?base(
                    item.id,
                    #mint,
                    timestamp,
                    value.amount.e8s,
                    null,
                    Int.fromNat(Nat64.toNat(value.amount.e8s)),
                    null,
                    ?#icp_account_identifier(to),
                    null,
                    memo,
                ));
            };
            case (#Burn(value)) {
                let from = switch (parseAddress(value.from)) {
                    case (#err(error)) return #err(error);
                    case (#ok(address)) address;
                };
                if (from != wallet) {
                    return #err("ICP index returned a burn unrelated to the Wallet account");
                };
                let spender = switch (value.spender) {
                    case null null;
                    case (?address) switch (parseAddress(address)) {
                        case (#err(error)) return #err(error);
                        case (#ok(parsed)) ?#icp_account_identifier(parsed);
                    };
                };
                #ok(?base(
                    item.id,
                    #burn,
                    timestamp,
                    value.amount.e8s,
                    null,
                    -Int.fromNat(Nat64.toNat(value.amount.e8s)),
                    ?#icp_account_identifier(from),
                    null,
                    spender,
                    memo,
                ));
            };
            case (#Transfer(value)) {
                let from = switch (parseAddress(value.from)) {
                    case (#err(error)) return #err(error);
                    case (#ok(address)) address;
                };
                let to = switch (parseAddress(value.to)) {
                    case (#err(error)) return #err(error);
                    case (#ok(address)) address;
                };
                let fromWallet = from == wallet;
                let toWallet = to == wallet;
                if (not fromWallet and not toWallet) {
                    return #err("ICP index returned a transfer unrelated to the Wallet account");
                };
                let spender = switch (value.spender) {
                    case null null;
                    case (?address) switch (parseAddress(address)) {
                        case (#err(error)) return #err(error);
                        case (#ok(parsed)) ?#icp_account_identifier(parsed);
                    };
                };
                let amount = Nat64.toNat(value.amount.e8s);
                let fee = Nat64.toNat(value.fee.e8s);
                let effect = if (fromWallet and toWallet) {
                    -Int.fromNat(fee);
                } else if (fromWallet) {
                    -Int.fromNat(amount + fee);
                } else Int.fromNat(amount);
                #ok(?base(
                    item.id,
                    #transfer,
                    timestamp,
                    value.amount.e8s,
                    ?value.fee.e8s,
                    effect,
                    ?#icp_account_identifier(from),
                    ?#icp_account_identifier(to),
                    spender,
                    memo,
                ));
            };
            case (#Approve(value)) {
                let from = switch (parseAddress(value.from)) {
                    case (#err(error)) return #err(error);
                    case (#ok(address)) address;
                };
                let spender = switch (parseAddress(value.spender)) {
                    case (#err(error)) return #err(error);
                    case (#ok(address)) address;
                };
                if (from != wallet) {
                    if (spender == wallet) return #ok(null);
                    return #err("ICP index returned an approval unrelated to the Wallet account");
                };
                #ok(?base(
                    item.id,
                    #approve,
                    timestamp,
                    value.allowance.e8s,
                    ?value.fee.e8s,
                    -Int.fromNat(Nat64.toNat(value.fee.e8s)),
                    ?#icp_account_identifier(from),
                    null,
                    ?#icp_account_identifier(spender),
                    memo,
                ));
            };
        };
    };

    func base(
        blockIndex : Nat64,
        operation : Memory.HistoryOperation,
        timestamp : Nat64,
        amount : Nat64,
        fee : ?Nat64,
        effect : Int,
        from : ?Memory.HistoryAddress,
        to : ?Memory.HistoryAddress,
        spender : ?Memory.HistoryAddress,
        memo : ?Blob,
    ) : Memory.HistoryTransaction {
        {
            block_index = Nat64.toNat(blockIndex);
            operation;
            timestamp_ns = timestamp;
            amount = Nat64.toNat(amount);
            fee = switch (fee) { case null null; case (?value) ?Nat64.toNat(value) };
            balance_effect = effect;
            from;
            to;
            spender;
            memo;
            intent = null;
            native = null;
            provenance = #index;
            verification = #pending;
        };
    };

    func parseAddress(value : Text) : Types.Result<Blob> {
        switch (AccountIdentifier.fromHex(value)) {
            case (?blob) #ok(blob);
            case null #err("ICP index returned an invalid account identifier");
        };
    };

    func nat64Blob(value : Nat64) : Blob {
        Blob.fromArray(Array.tabulate<Nat8>(8, func(index) {
            Nat8.fromNat(Nat64.toNat(value >> Nat64.fromNat((7 - index) * 8)) % 256);
        }));
    };

    func boundedMemo(memo : ?Blob) : ?Blob {
        switch (memo) {
            case null null;
            case (?value) {
                if (value.size() <= 256) ?value else {
                    let bytes = Blob.toArray(value);
                    ?Blob.fromArray(Array.tabulate<Nat8>(256, func(index) { bytes[index] }));
                };
            };
        };
    };

    func callError(error : Capabilities.CallError) : Text {
        error.code # ": " # error.message;
    };
};
