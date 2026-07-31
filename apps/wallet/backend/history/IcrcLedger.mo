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
import Types "Types";

module {
    public let MAX_PAGE_SIZE = 1_000;

    let MAX_ARCHIVED_RANGES = 64;
    let MAX_ARCHIVED_ARGS = 64;
    let MAX_VALUE_DEPTH = 10;
    let MAX_VALUE_NODES = 256;
    let MAX_ARRAY_ITEMS = 64;
    let MAX_MAP_FIELDS = 64;
    let MAX_KEY_SIZE = 64;
    let MAX_TEXT_SIZE = 256;
    let MAX_BLOB_SIZE = 4_096;
    let MAX_MEMO_SIZE = 256;
    let MAX_NAT64 = 18_446_744_073_709_551_615;

    public type Value = {
        #Blob : Blob;
        #Text : Text;
        #Nat : Nat;
        #Int : Int;
        #Array : [Value];
        #Map : [(Text, Value)];
    };

    public type GetBlocksArg = {
        start : Nat;
        length : Nat;
    };

    public type BlockWithId = {
        id : Nat;
        block : Value;
    };

    // The standard response also carries a callback in each archived range.
    // Candid record width subtyping lets Wallet intentionally omit it: invoking
    // that function would bypass the kernel-owned backend-call broker.
    public type ArchivedRange = {
        args : [GetBlocksArg];
    };

    public type GetBlocksReply = {
        log_length : Nat;
        blocks : [BlockWithId];
        archived_blocks : [ArchivedRange];
    };

    public type Page = {
        log_length : Nat;
        transactions : [Memory.HistoryTransaction];
        next_start : Nat;
        complete : Bool;
    };

    type Account = {
        owner : Principal;
        subaccount : ?Blob;
    };

    public func tipRequest(ledger : Principal) : Capabilities.CallRequest {
        let request : [GetBlocksArg] = [{ start = 0; length = 0 }];
        {
            canister = ledger;
            method = "icrc3_get_blocks";
            args = to_candid (request);
            cycles = 0;
        };
    };

    public func pageRequest(
        ledger : Principal,
        start : Nat,
        length : Nat,
    ) : Capabilities.CallRequest {
        let request : [GetBlocksArg] = [{
            start;
            length = Nat.min(length, MAX_PAGE_SIZE);
        }];
        {
            canister = ledger;
            method = "icrc3_get_blocks";
            args = to_candid (request);
            cycles = 0;
        };
    };

    public func decodeTip(result : Capabilities.CallResult) : Types.Result<Nat> {
        let reply = switch (decodeReply(result)) {
            case (#err(error)) return #err(error);
            case (#ok(value)) value;
        };
        if (reply.blocks.size() != 0 or reply.archived_blocks.size() != 0) {
            return #err("ICRC-3 ledger returned data for an empty tip request");
        };
        #ok(reply.log_length);
    };

    // Decode one forward page from a previously captured target. A successful
    // partial result advances only next_start; callers must not commit their
    // checkpoint until complete is true.
    public func decodePage(
        result : Capabilities.CallResult,
        owner : Principal,
        start : Nat,
        length : Nat,
        targetExclusive : Nat,
    ) : Types.Result<Page> {
        if (length == 0) {
            return #err("ICRC-3 history page length is zero");
        };
        if (start >= targetExclusive) {
            return #err("ICRC-3 history page starts at or beyond its captured target");
        };
        let boundedLength = Nat.min(length, MAX_PAGE_SIZE);
        let requestedEnd = Nat.min(start + boundedLength, targetExclusive);
        let reply = switch (decodeReply(result)) {
            case (#err(error)) return #err(error);
            case (#ok(value)) value;
        };
        if (reply.log_length < targetExclusive) {
            return #err("ICRC-3 ledger is behind the captured history target");
        };
        if (reply.blocks.size() > boundedLength) {
            return #err("ICRC-3 ledger returned too many blocks");
        };
        switch (validateArchivedRanges(reply.archived_blocks, start, requestedEnd)) {
            case (#err(error)) return #err(error);
            case (#ok(())) {};
        };
        if (reply.blocks.size() == 0) {
            return #err("ICRC-3 ledger returned no progress for the requested live range");
        };

        let transactions = List.empty<Memory.HistoryTransaction>();
        var expectedId = start;
        for (item in reply.blocks.vals()) {
            if (item.id != expectedId) {
                return #err("ICRC-3 ledger block ids are not contiguous and ascending");
            };
            if (item.id >= requestedEnd) {
                return #err("ICRC-3 ledger returned a block outside the requested range");
            };
            switch (validateValue(item.block, 0)) {
                case (#err(error)) return #err(error);
                case (#ok(_)) {};
            };
            switch (decodeBlock(item.id, item.block, owner)) {
                case (#err(error)) return #err(error);
                case (#ok(null)) {};
                case (#ok(?transaction)) List.add(transactions, transaction);
            };
            expectedId += 1;
        };
        #ok({
            log_length = reply.log_length;
            transactions = List.toArray(transactions);
            next_start = expectedId;
            complete = expectedId >= targetExclusive;
        });
    };

    func decodeReply(
        result : Capabilities.CallResult,
    ) : Types.Result<GetBlocksReply> {
        switch (result) {
            case (#err(error)) #err(error.code # ": " # error.message);
            case (#ok(bytes)) {
                let decoded : ?GetBlocksReply = from_candid bytes;
                switch (decoded) {
                    case null #err("ICRC-3 ledger returned an invalid block response");
                    case (?reply) {
                        if (reply.archived_blocks.size() > MAX_ARCHIVED_RANGES) {
                            #err("ICRC-3 ledger returned too many archived ranges");
                        } else #ok(reply);
                    };
                };
            };
        };
    };

    func validateArchivedRanges(
        ranges : [ArchivedRange],
        requestedStart : Nat,
        requestedEnd : Nat,
    ) : Types.Result<()> {
        var argumentCount = 0;
        for (range in ranges.vals()) {
            if (range.args.size() == 0) {
                return #err("ICRC-3 ledger returned an empty archived range");
            };
            argumentCount += range.args.size();
            if (argumentCount > MAX_ARCHIVED_ARGS) {
                return #err("ICRC-3 ledger returned too many archived range arguments");
            };
            for (argument in range.args.vals()) {
                if (argument.length == 0 or argument.length > MAX_PAGE_SIZE) {
                    return #err("ICRC-3 ledger returned an invalid archived range length");
                };
                let archivedEnd = argument.start + argument.length;
                if (
                    argument.start < requestedStart or
                    archivedEnd > requestedEnd
                ) {
                    return #err("ICRC-3 ledger returned an archived range outside the request");
                };
                if (argument.start < requestedEnd and archivedEnd > requestedStart) {
                    return #err(
                        "Requested ICRC-3 history is archived; configure an index canister"
                    );
                };
            };
        };
        #ok(());
    };

    func validateValue(value : Value, depth : Nat) : Types.Result<Nat> {
        if (depth > MAX_VALUE_DEPTH) {
            return #err("ICRC-3 block value exceeds the Wallet depth limit");
        };
        switch (value) {
            case (#Blob(blob)) {
                if (blob.size() > MAX_BLOB_SIZE) {
                    #err("ICRC-3 block blob exceeds the Wallet size limit");
                } else #ok(1);
            };
            case (#Text(text)) {
                if (text.size() > MAX_TEXT_SIZE) {
                    #err("ICRC-3 block text exceeds the Wallet size limit");
                } else #ok(1);
            };
            case (#Nat(_)) #ok(1);
            case (#Int(_)) #ok(1);
            case (#Array(values)) {
                if (values.size() > MAX_ARRAY_ITEMS) {
                    return #err("ICRC-3 block array exceeds the Wallet item limit");
                };
                validateChildren(values, depth);
            };
            case (#Map(entries)) {
                if (entries.size() > MAX_MAP_FIELDS) {
                    return #err("ICRC-3 block map exceeds the Wallet field limit");
                };
                var position = 0;
                for ((key, _) in entries.vals()) {
                    if (key.size() == 0 or key.size() > MAX_KEY_SIZE) {
                        return #err("ICRC-3 block contains an invalid map key");
                    };
                    var prior = 0;
                    for ((candidate, _) in entries.vals()) {
                        if (prior >= position) break;
                        if (candidate == key) {
                            return #err("ICRC-3 block map contains a duplicate key");
                        };
                        prior += 1;
                    };
                    position += 1;
                };
                let values = Array.map<(Text, Value), Value>(
                    entries,
                    func(entry) { entry.1 },
                );
                validateChildren(values, depth);
            };
        };
    };

    func validateChildren(values : [Value], depth : Nat) : Types.Result<Nat> {
        var nodes = 1;
        for (value in values.vals()) {
            let childNodes = switch (validateValue(value, depth + 1)) {
                case (#err(error)) return #err(error);
                case (#ok(count)) count;
            };
            nodes += childNodes;
            if (nodes > MAX_VALUE_NODES) {
                return #err("ICRC-3 block value exceeds the Wallet node limit");
            };
        };
        #ok(nodes);
    };

    func decodeBlock(
        blockIndex : Nat,
        value : Value,
        owner : Principal,
    ) : Types.Result<?Memory.HistoryTransaction> {
        let block = switch (value) {
            case (#Map(entries)) entries;
            case (_) return #err("ICRC-3 block is not a map");
        };
        // A namespaced ICRC-3 block type defines its own schema. Reject every
        // extension we do not understand before interpreting it as an
        // ICRC-1/2 transaction.
        let namespacedOperation = switch (namespacedBlockType(block)) {
            case (#err(error)) return #err(error);
            case (#ok(value)) value;
        };
        let transaction = switch (requiredMap(block, "tx")) {
            case (#err(error)) return #err(error);
            case (#ok(entries)) entries;
        };
        let operation = switch (namespacedOperation) {
            case (?value) value;
            case null switch (legacyOperation(transaction)) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
        };
        let timestamp = switch (requiredNat(block, "ts")) {
            case (#err(error)) return #err(error);
            case (#ok(value)) {
                if (value > MAX_NAT64) {
                    return #err("ICRC-3 block timestamp exceeds Nat64");
                };
                Nat64.fromNat(value);
            };
        };
        let memo = switch (optionalBlob(transaction, "memo")) {
            case (#err(error)) return #err(error);
            case (#ok(value)) boundedMemo(value);
        };
        let amount = switch (requiredNat(transaction, "amt")) {
            case (#err(error)) return #err(error);
            case (#ok(value)) value;
        };
        let fee = switch (blockFee(block, transaction)) {
            case (#err(error)) return #err(error);
            case (#ok(value)) value;
        };

        switch (operation) {
            case (#mint) {
                let to = switch (requiredAccount(transaction, "to")) {
                    case (#err(error)) return #err(error);
                    case (#ok(value)) value;
                };
                if (not isWallet(to, owner)) return #ok(null);
                let charged = optionNat(fee);
                if (charged > amount) return #err("ICRC-3 mint fee exceeds its amount");
                #ok(?base(
                    blockIndex,
                    #mint,
                    timestamp,
                    amount,
                    fee,
                    Int.fromNat(amount - charged),
                    null,
                    ?address(to),
                    null,
                    memo,
                ));
            };
            case (#burn) {
                let from = switch (requiredAccount(transaction, "from")) {
                    case (#err(error)) return #err(error);
                    case (#ok(value)) value;
                };
                if (not isWallet(from, owner)) return #ok(null);
                let spender = switch (optionalAccount(transaction, "spender")) {
                    case (#err(error)) return #err(error);
                    case (#ok(value)) value;
                };
                #ok(?base(
                    blockIndex,
                    #burn,
                    timestamp,
                    amount,
                    fee,
                    -Int.fromNat(amount + optionNat(fee)),
                    ?address(from),
                    null,
                    mapAddress(spender),
                    memo,
                ));
            };
            case (#transfer) {
                let from = switch (requiredAccount(transaction, "from")) {
                    case (#err(error)) return #err(error);
                    case (#ok(value)) value;
                };
                let to = switch (requiredAccount(transaction, "to")) {
                    case (#err(error)) return #err(error);
                    case (#ok(value)) value;
                };
                let fromWallet = isWallet(from, owner);
                let toWallet = isWallet(to, owner);
                if (not fromWallet and not toWallet) return #ok(null);
                let ?charged = fee else {
                    return #err("ICRC-3 transfer affecting Wallet has no fee");
                };
                let spender = switch (optionalAccount(transaction, "spender")) {
                    case (#err(error)) return #err(error);
                    case (#ok(value)) value;
                };
                let effect = if (fromWallet and toWallet) {
                    -Int.fromNat(charged);
                } else if (fromWallet) {
                    -Int.fromNat(amount + charged);
                } else Int.fromNat(amount);
                #ok(?base(
                    blockIndex,
                    #transfer,
                    timestamp,
                    amount,
                    fee,
                    effect,
                    ?address(from),
                    ?address(to),
                    mapAddress(spender),
                    memo,
                ));
            };
            case (#approve) {
                let from = switch (requiredAccount(transaction, "from")) {
                    case (#err(error)) return #err(error);
                    case (#ok(value)) value;
                };
                let spender = switch (requiredAccount(transaction, "spender")) {
                    case (#err(error)) return #err(error);
                    case (#ok(value)) value;
                };
                if (not isWallet(from, owner)) return #ok(null);
                let ?charged = fee else {
                    return #err("ICRC-3 approval affecting Wallet has no fee");
                };
                #ok(?base(
                    blockIndex,
                    #approve,
                    timestamp,
                    amount,
                    fee,
                    -Int.fromNat(charged),
                    ?address(from),
                    null,
                    ?address(spender),
                    memo,
                ));
            };
        };
    };

    type SupportedOperation = { #mint; #burn; #transfer; #approve };

    func namespacedBlockType(
        block : [(Text, Value)],
    ) : Types.Result<?SupportedOperation> {
        switch (optionalText(block, "btype")) {
            case (#err(error)) return #err(error);
            case (#ok(null)) #ok(null);
            case (#ok(?named)) switch (named) {
                case ("1mint") #ok(?#mint);
                case ("1burn") #ok(?#burn);
                case ("1xfer") #ok(?#transfer);
                case ("2xfer") #ok(?#transfer);
                case ("2approve") #ok(?#approve);
                case (_) #err("Unsupported ICRC-3 block type: " # named);
            };
        };
    };

    // Older ICRC ledgers omitted btype and put an unprefixed operation in tx.
    // Keep that compatibility only when the namespaced block type is absent.
    func legacyOperation(
        transaction : [(Text, Value)],
    ) : Types.Result<SupportedOperation> {
        let operation = switch (optionalText(transaction, "op")) {
            case (#err(error)) return #err(error);
            case (#ok(null)) return #err("ICRC-3 block operation is missing");
            case (#ok(?value)) value;
        };
        switch (operation) {
            case ("mint") #ok(#mint);
            case ("burn") #ok(#burn);
            case ("xfer") #ok(#transfer);
            case ("approve") #ok(#approve);
            case (_) #err("Unsupported legacy ICRC transaction operation: " # operation);
        };
    };

    func blockFee(
        block : [(Text, Value)],
        transaction : [(Text, Value)],
    ) : Types.Result<?Nat> {
        let transactionFee = switch (optionalNat(transaction, "fee")) {
            case (#err(error)) return #err(error);
            case (#ok(value)) value;
        };
        let blockFee = switch (optionalNat(block, "fee")) {
            case (#err(error)) return #err(error);
            case (#ok(value)) value;
        };
        switch (transactionFee, blockFee) {
            case (?_, ?_) #err("ICRC-3 block contains both transaction and effective fees");
            case (?value, null) #ok(?value);
            case (null, ?value) #ok(?value);
            case (null, null) #ok(null);
        };
    };

    func requiredMap(
        entries : [(Text, Value)],
        key : Text,
    ) : Types.Result<[(Text, Value)]> {
        switch (field(entries, key)) {
            case null #err("ICRC-3 block is missing " # key);
            case (?#Map(value)) #ok(value);
            case (?_) #err("ICRC-3 block field has the wrong type: " # key);
        };
    };

    func requiredNat(
        entries : [(Text, Value)],
        key : Text,
    ) : Types.Result<Nat> {
        switch (field(entries, key)) {
            case null #err("ICRC-3 block is missing " # key);
            case (?#Nat(value)) #ok(value);
            case (?_) #err("ICRC-3 block field has the wrong type: " # key);
        };
    };

    func optionalNat(
        entries : [(Text, Value)],
        key : Text,
    ) : Types.Result<?Nat> {
        switch (field(entries, key)) {
            case null #ok(null);
            case (?#Nat(value)) #ok(?value);
            case (?_) #err("ICRC-3 block field has the wrong type: " # key);
        };
    };

    func optionalText(
        entries : [(Text, Value)],
        key : Text,
    ) : Types.Result<?Text> {
        switch (field(entries, key)) {
            case null #ok(null);
            case (?#Text(value)) #ok(?value);
            case (?_) #err("ICRC-3 block field has the wrong type: " # key);
        };
    };

    func optionalBlob(
        entries : [(Text, Value)],
        key : Text,
    ) : Types.Result<?Blob> {
        switch (field(entries, key)) {
            case null #ok(null);
            case (?#Blob(value)) #ok(?value);
            case (?_) #err("ICRC-3 block field has the wrong type: " # key);
        };
    };

    func requiredAccount(
        entries : [(Text, Value)],
        key : Text,
    ) : Types.Result<Account> {
        switch (field(entries, key)) {
            case null #err("ICRC-3 block is missing " # key);
            case (?value) parseAccount(value);
        };
    };

    func optionalAccount(
        entries : [(Text, Value)],
        key : Text,
    ) : Types.Result<?Account> {
        switch (field(entries, key)) {
            case null #ok(null);
            case (?value) switch (parseAccount(value)) {
                case (#err(error)) #err(error);
                case (#ok(account)) #ok(?account);
            };
        };
    };

    func parseAccount(value : Value) : Types.Result<Account> {
        let parts = switch (value) {
            case (#Array(value)) value;
            case (_) return #err("ICRC-3 block contains an invalid account");
        };
        if (parts.size() == 0 or parts.size() > 2) {
            return #err("ICRC-3 block contains an invalid account array");
        };
        let principalBytes = switch (parts[0]) {
            case (#Blob(value)) value;
            case (_) return #err("ICRC-3 account owner is not a blob");
        };
        if (principalBytes.size() > 29) {
            return #err("ICRC-3 account owner is not a valid principal blob");
        };
        let subaccount = if (parts.size() == 1) null else switch (parts[1]) {
            case (#Blob(value)) {
                if (value.size() != 32) {
                    return #err("ICRC-3 account subaccount is not 32 bytes");
                };
                if (isZeroSubaccount(value)) null else ?value;
            };
            case (_) return #err("ICRC-3 account subaccount is not a blob");
        };
        #ok({ owner = Principal.fromBlob(principalBytes); subaccount });
    };

    func field(entries : [(Text, Value)], key : Text) : ?Value {
        for ((candidate, value) in entries.vals()) {
            if (candidate == key) return ?value;
        };
        null;
    };

    func isWallet(account : Account, owner : Principal) : Bool {
        account.owner == owner and account.subaccount == null;
    };

    func isZeroSubaccount(value : Blob) : Bool {
        for (byte in value.vals()) if (byte != 0) return false;
        true;
    };

    func address(account : Account) : Memory.HistoryAddress {
        #icrc(account);
    };

    func mapAddress(account : ?Account) : ?Memory.HistoryAddress {
        switch (account) {
            case null null;
            case (?value) ?address(value);
        };
    };

    func optionNat(value : ?Nat) : Nat {
        switch (value) { case null 0; case (?amount) amount };
    };

    func boundedMemo(value : ?Blob) : ?Blob {
        switch (value) {
            case null null;
            case (?blob) {
                if (blob.size() <= MAX_MEMO_SIZE) ?blob else {
                    let bytes = Blob.toArray(blob);
                    ?Blob.fromArray(Array.tabulate<Nat8>(MAX_MEMO_SIZE, func(index) {
                        bytes[index];
                    }));
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
            memo;
            intent = null;
            native = null;
            provenance = #ledger;
            verification = #pending;
        };
    };
};
