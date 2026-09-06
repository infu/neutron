// Verify the exact IC block named by the matched minter mint event. A balance
// increase (or an incoming transfer at another block) proves no deposit.
import Blob "mo:core/Blob";
import Principal "mo:core/Principal";
import Capabilities "../capabilities/Types";
import Catalog "../Catalog";
import Memory "../memory/wallet_bridge/v1";
import Types "Types";
module {
    public type Value = { #Blob : Blob; #Text : Text; #Nat : Nat; #Int : Int; #Array : [Value]; #Map : [(Text, Value)] };
    public type Reply = {
        blocks : [{ id : Nat; block : Value }];
        archived_blocks : [{ args : [{ start : Nat; length : Nat }] }];
    };
    public func request(intent : Memory.Intent, block : Nat) : Capabilities.CallRequest {
        let args : [{ start : Nat; length : Nat }] = [{ start = block; length = 1 }];
        { canister = intent.quote.ledger; method = "icrc3_get_blocks"; args = to_candid (args); cycles = 0 };
    };
    public func verify(result : Capabilities.CallResult, intent : Memory.Intent, block : Nat) : Types.Result<()> {
        let reply = switch (result) {
            case (#err(error)) return #err(error.code # ": " # error.message);
            case (#ok(bytes)) switch (from_candid bytes : ?Reply) {
                case null return #err("The IC ledger returned an invalid mint block response");
                case (?value) value;
            };
        };
        if (reply.blocks.size() != 1 or reply.blocks[0].id != block) {
            return #err("The matched mint block is not in the ledger's live range; mint remains unverified");
        };
        let fields = switch (reply.blocks[0].block) { case (#Map(value)) value; case (_) return #err("Invalid IC mint block") };
        let transaction = switch (field(fields, "tx")) { case (?#Map(value)) value; case (_) return #err("IC mint block has no transaction") };
        let isMint = switch (field(fields, "btype")) {
            case (?#Text("1mint")) true;
            case null field(transaction, "op") == ?#Text("mint");
            case (_) false;
        };
        if (not isMint) return #err("The minter's block is not a mint transaction");
        if (field(transaction, "amt") != ?#Nat(intent.amount)) return #err("IC mint amount does not match this deposit");
        let account = switch (field(transaction, "to")) { case (?#Array(value)) value; case (_) return #err("IC mint has no recipient") };
        if (account.size() == 0 or account.size() > 2 or account[0] != #Blob(Principal.toBlob(intent.quote.recipient))) {
            return #err("IC mint recipient does not match this deposit");
        };
        let subaccount = if (account.size() == 1) null else switch (account[1]) {
            case (#Blob(value)) ?value;
            case (_) return #err("IC mint has an invalid subaccount");
        };
        if (not sameSubaccount(subaccount, intent.subaccount)) return #err("IC mint subaccount does not match this deposit");
        #ok(());
    };
    public type IndexReply = {
        #Ok : { transactions : [{ id : Nat; transaction : {
            kind : Text;
            mint : ?{ amount : Nat; to : { owner : Principal; subaccount : ?Blob } };
        } }] };
        #Err : { message : Text };
    };
    public func isArchived(result : Capabilities.CallResult, block : Nat) : Bool {
        let reply = switch (result) {
            case (#err(_)) return false;
            case (#ok(bytes)) switch (from_candid bytes : ?Reply) { case null return false; case (?value) value };
        };
        if (reply.blocks.size() != 0) return false;
        for (archive in reply.archived_blocks.vals()) for (arg in archive.args.vals()) {
            if (arg.start <= block and block < arg.start + arg.length) return true;
        };
        false;
    };
    // The catalog's ledger-specific index retains transactions after ledger
    // archival. Query the exact block exclusively from its following ID, then
    // require the returned ID/kind/amount/account. No arbitrary archive callback
    // receives Wallet authority, and an index that is behind stays unresolved.
    public func indexRequest(intent : Memory.Intent, block : Nat) : ?Capabilities.CallRequest {
        let index = switch (Catalog.find(intent.quote.ledger)) {
            case null return null;
            case (?ledger) switch (ledger.index) { case null return null; case (?value) Principal.fromText(value) };
        };
        let args = {
            account = { owner = intent.quote.recipient; subaccount = intent.subaccount };
            start = ?(block + 1);
            max_results = 1 : Nat;
        };
        ?{ canister = index; method = "get_account_transactions"; args = to_candid (args); cycles = 0 };
    };
    public func verifyIndex(result : Capabilities.CallResult, intent : Memory.Intent, block : Nat) : Types.Result<()> {
        let transactions = switch (result) {
            case (#err(error)) return #err(error.code # ": " # error.message);
            case (#ok(bytes)) switch (from_candid bytes : ?IndexReply) {
                case null return #err("The IC index returned an invalid mint response");
                case (?#Err(error)) return #err(error.message);
                case (?#Ok(value)) value.transactions;
            };
        };
        if (transactions.size() != 1 or transactions[0].id != block) return #err("The index has not returned the exact matched mint block");
        let transaction = transactions[0].transaction;
        if (transaction.kind != "mint") return #err("The matched indexed transaction is not a mint");
        switch (transaction.mint) {
            case null #err("The matched indexed mint has no mint details");
            case (?mint) {
                if (mint.amount != intent.amount or mint.to.owner != intent.quote.recipient or not sameSubaccount(mint.to.subaccount, intent.subaccount)) {
                    #err("Indexed mint amount or recipient does not match this deposit");
                } else #ok(());
            };
        };
    };
    public func sameSubaccount(left : ?Blob, right : ?Blob) : Bool { canonicalSubaccount(left) == canonicalSubaccount(right) };
    func canonicalSubaccount(value : ?Blob) : ?Blob {
        switch (value) {
            case null null;
            case (?bytes) {
                if (bytes.size() != 32) return ?bytes;
                for (byte in bytes.values()) if (byte != 0) return ?bytes;
                null;
            };
        };
    };
    func field(fields : [(Text, Value)], key : Text) : ?Value {
        var result : ?Value = null;
        for ((name, value) in fields.vals()) if (name == key) {
            // Reject duplicate keys rather than accepting ambiguous encoding.
            if (result != null) return null;
            result := ?value;
        };
        result;
    };
};
