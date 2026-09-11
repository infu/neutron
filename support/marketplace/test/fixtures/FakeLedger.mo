import Array "mo:core/Array";
import Error "mo:core/Error";
import Int "mo:core/Int";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Time "mo:core/Time";

// PocketIC-only, deterministic ICRC-1/2 fixture. Its public credit/configuration
// endpoints are intentional test controls, not production ledger functionality.
persistent actor class FakeLedger(init : { symbol : Text; decimals : Nat8; fee : Nat }) = self {
    public type Account = { owner : Principal; subaccount : ?Blob };
    public type Value = { #Nat : Nat; #Int : Int; #Text : Text; #Blob : Blob };
    public type TransferArgs = {
        from_subaccount : ?Blob; to : Account; amount : Nat; fee : ?Nat;
        memo : ?Blob; created_at_time : ?Nat64;
    };
    public type TransferFromArgs = {
        spender_subaccount : ?Blob; from : Account; to : Account; amount : Nat;
        fee : ?Nat; memo : ?Blob; created_at_time : ?Nat64;
    };
    public type ApproveArgs = {
        from_subaccount : ?Blob; spender : Account; amount : Nat;
        expected_allowance : ?Nat; expires_at : ?Nat64; fee : ?Nat;
        memo : ?Blob; created_at_time : ?Nat64;
    };
    public type TransferError = {
        #BadFee : { expected_fee : Nat }; #BadBurn : { min_burn_amount : Nat };
        #InsufficientFunds : { balance : Nat }; #TooOld;
        #CreatedInFuture : { ledger_time : Nat64 }; #Duplicate : { duplicate_of : Nat };
        #TemporarilyUnavailable; #GenericError : { error_code : Nat; message : Text };
    };
    public type TransferFromError = TransferError or { #InsufficientAllowance : { allowance : Nat } };
    public type ApproveError = {
        #BadFee : { expected_fee : Nat }; #InsufficientFunds : { balance : Nat };
        #AllowanceChanged : { current_allowance : Nat }; #Expired : { ledger_time : Nat64 };
        #TooOld; #CreatedInFuture : { ledger_time : Nat64 };
        #Duplicate : { duplicate_of : Nat }; #TemporarilyUnavailable;
        #GenericError : { error_code : Nat; message : Text };
    };
    public type Allowance = { allowance : Nat; expires_at : ?Nat64 };
    public type Behavior = {
        #normal; #reject : Text; #temporary; #commitThenReject : Text;
        #hold : Principal; #transferError : TransferError;
        #transferFromError : TransferFromError; #approveError : ApproveError;
    };
    public type Transaction = {
        index : Nat; kind : { #approve; #transfer; #transferFrom };
        from : Account; to : ?Account; spender : ?Account;
        amount : Nat; fee : Nat; memo : ?Blob; created_at_time : ?Nat64;
        timestamp : Nat64;
    };
    type Balance = { account : Account; amount : Nat };
    type Permission = { account : Account; spender : Account; value : Allowance };
    type Duplicate = { key : Blob; index : Nat };
    type TimeError = { #TooOld; #CreatedInFuture : { ledger_time : Nat64 } };

    var fee = init.fee;
    var balances : [Balance] = [];
    var allowances : [Permission] = [];
    var history : [Transaction] = [];
    var dedup : [Duplicate] = [];
    var script : [Behavior] = [];
    var scriptIndex : Nat = 0;
    var transferCalls : Nat = 0;
    var transferFromCalls : Nat = 0;
    var approveCalls : Nat = 0;
    var totalSupply : Nat = 0;
    var transactionWindowNs : Nat64 = 86_400_000_000_000;
    var permittedDriftNs : Nat64 = 60_000_000_000;

    func now() : Nat64 { Nat.toNat64(Int.abs(Time.now())) };
    func canonical(account : Account) : Account {
        let subaccount = switch (account.subaccount) {
            case (?bytes) {
                if (bytes == Array.toBlob(Array.repeat<Nat8>(0, 32))) null else ?bytes
            };
            case null null;
        };
        { owner = account.owner; subaccount }
    };
    func equal(a : Account, b : Account) : Bool { canonical(a) == canonical(b) };
    func valid(account : Account) : Bool {
        switch (account.subaccount) { case null true; case (?bytes) bytes.size() == 32 }
    };
    func balance(account : Account) : Nat {
        switch (Array.find<Balance>(balances, func(value) { equal(account, value.account) })) {
            case null 0;
            case (?value) value.amount;
        }
    };
    func setBalance(account : Account, amount : Nat) {
        balances := Array.concat<Balance>(
            Array.filter<Balance>(balances, func(value) { not equal(account, value.account) }),
            [{ account = canonical(account); amount }],
        )
    };
    func allowance(account : Account, spender : Account) : Allowance {
        switch (Array.find<Permission>(allowances, func(value) { equal(value.account, account) and equal(value.spender, spender) })) {
            case null { { allowance = 0; expires_at = null } };
            case (?value) {
                switch (value.value.expires_at) {
                    case (?expiry) {
                        if (expiry <= now()) return { allowance = 0; expires_at = ?expiry }
                    };
                    case null {};
                };
                value.value
            };
        }
    };
    func setAllowance(account : Account, spender : Account, value : Allowance) {
        allowances := Array.concat<Permission>(
            Array.filter<Permission>(allowances, func(old) { not (equal(old.account, account) and equal(old.spender, spender)) }),
            [{ account = canonical(account); spender = canonical(spender); value }],
        )
    };
    func timeError(created : ?Nat64) : ?TimeError {
        let ledgerTime = now();
        switch (created) {
            case null null;
            case (?timestamp) {
                // Nat widening keeps boundary tests from overflowing Nat64.
                if (Nat64.toNat(timestamp) > Nat64.toNat(ledgerTime) + Nat64.toNat(permittedDriftNs)) {
                    ?#CreatedInFuture({ ledger_time = ledgerTime })
                } else if (Nat64.toNat(timestamp) + Nat64.toNat(transactionWindowNs) < Nat64.toNat(ledgerTime)) {
                    ?#TooOld
                } else null
            };
        }
    };
    func duplicate(key : Blob, created : ?Nat64) : ?Nat {
        if (created == null) return null;
        switch (Array.find<Duplicate>(dedup, func(value) { value.key == key })) {
            case null null;
            case (?value) ?value.index;
        }
    };
    func nextBehavior() : Behavior {
        if (scriptIndex >= script.size()) return #normal;
        let value = script[scriptIndex];
        scriptIndex += 1;
        value
    };
    func addTransaction(value : Transaction, key : Blob) {
        history := Array.concat<Transaction>(history, [value]);
        if (value.created_at_time != null) dedup := Array.concat<Duplicate>(dedup, [{ key; index = value.index }]);
    };
    func move(from : Account, to : Account, amount : Nat, chargedFee : Nat) {
        setBalance(from, balance(from) - amount - chargedFee);
        setBalance(to, balance(to) + amount);
        totalSupply -= chargedFee;
    };
    func before(value : Behavior) : async () {
        switch (value) {
            case (#reject(message)) throw Error.reject(message);
            case (#hold(gate)) {
                let waiter : actor { wait : shared () -> async () } = actor (Principal.toText(gate));
                await waiter.wait()
            };
            case _ {};
        }
    };
    func after(value : Behavior) : async () {
        switch (value) {
            case (#commitThenReject(message)) {
                // The await commits balances, allowance, history and dedup before
                // the rejection. An identical retry must return Duplicate.
                await self.checkpoint();
                throw Error.reject(message)
            };
            case _ {};
        }
    };

    public shared func checkpoint() : async () {};
    public shared func credit(account : Account, amount : Nat) : async () {
        assert valid(account);
        setBalance(account, balance(account) + amount);
        totalSupply += amount;
    };
    public shared func setFee(value : Nat) : async () { fee := value };
    public shared func setScript(values : [Behavior]) : async () { script := values; scriptIndex := 0 };
    public shared func setTimeRules(windowNs : Nat64, driftNs : Nat64) : async () {
        transactionWindowNs := windowNs;
        permittedDriftNs := driftNs;
    };
    public shared query func stats() : async {
        transferCalls : Nat; transferFromCalls : Nat; approveCalls : Nat;
        appliedTransactions : Nat; remainingScript : Nat;
    } {
        { transferCalls; transferFromCalls; approveCalls; appliedTransactions = history.size(); remainingScript = script.size() - scriptIndex }
    };
    public shared query func transactions() : async [Transaction] { history };
    public shared query func icrc1_name() : async Text { "Test " # init.symbol };
    public shared query func icrc1_symbol() : async Text { init.symbol };
    public shared query func icrc1_decimals() : async Nat8 { init.decimals };
    public shared query func icrc1_fee() : async Nat { fee };
    public shared query func icrc1_total_supply() : async Nat { totalSupply };
    public shared query func icrc1_minting_account() : async ?Account { null };
    public shared query func icrc1_balance_of(account : Account) : async Nat { balance(account) };
    public shared query func icrc1_metadata() : async [(Text, Value)] {
        [("icrc1:name", #Text("Test " # init.symbol)), ("icrc1:symbol", #Text(init.symbol)),
         ("icrc1:decimals", #Nat(Nat8.toNat(init.decimals))), ("icrc1:fee", #Nat(fee))]
    };
    public shared query func icrc1_supported_standards() : async [{ name : Text; url : Text }] {
        [{ name = "ICRC-1"; url = "https://github.com/dfinity/ICRC-1/tree/main/standards/ICRC-1" },
         { name = "ICRC-2"; url = "https://github.com/dfinity/ICRC-1/tree/main/standards/ICRC-2" }]
    };
    public shared query func icrc2_allowance(args : { account : Account; spender : Account }) : async Allowance {
        allowance(args.account, args.spender)
    };

    public shared ({ caller }) func icrc1_transfer(args : TransferArgs) : async { #Ok : Nat; #Err : TransferError } {
        transferCalls += 1;
        let behavior = nextBehavior();
        await before(behavior);
        switch (behavior) {
            case (#temporary) return #Err(#TemporarilyUnavailable);
            case (#transferError(value)) return #Err(value);
            case _ {};
        };
        let from = { owner = caller; subaccount = args.from_subaccount };
        if (not valid(from) or not valid(args.to)) return #Err(#GenericError({ error_code = 1; message = "Subaccounts must be 32 bytes" }));
        switch (timeError(args.created_at_time)) { case (?error) return #Err(error); case null {} };
        let key = to_candid ("icrc1_transfer", caller, args);
        switch (duplicate(key, args.created_at_time)) { case (?index) return #Err(#Duplicate({ duplicate_of = index })); case null {} };
        switch (args.fee) { case (?value) { if (value != fee) return #Err(#BadFee({ expected_fee = fee })) }; case null {} };
        let available = balance(from);
        if (available < args.amount + fee) return #Err(#InsufficientFunds({ balance = available }));
        let index = history.size();
        move(from, args.to, args.amount, fee);
        addTransaction({ index; kind = #transfer; from; to = ?args.to; spender = null; amount = args.amount; fee; memo = args.memo; created_at_time = args.created_at_time; timestamp = now() }, key);
        await after(behavior);
        #Ok(index)
    };

    public shared ({ caller }) func icrc2_transfer_from(args : TransferFromArgs) : async { #Ok : Nat; #Err : TransferFromError } {
        transferFromCalls += 1;
        let behavior = nextBehavior();
        await before(behavior);
        switch (behavior) {
            case (#temporary) return #Err(#TemporarilyUnavailable);
            case (#transferFromError(value)) return #Err(value);
            case (#transferError(value)) return #Err(value);
            case _ {};
        };
        let spender = { owner = caller; subaccount = args.spender_subaccount };
        if (not valid(args.from) or not valid(args.to) or not valid(spender)) return #Err(#GenericError({ error_code = 1; message = "Subaccounts must be 32 bytes" }));
        switch (timeError(args.created_at_time)) { case (?error) return #Err(error); case null {} };
        let key = to_candid ("icrc2_transfer_from", caller, args);
        switch (duplicate(key, args.created_at_time)) { case (?index) return #Err(#Duplicate({ duplicate_of = index })); case null {} };
        switch (args.fee) { case (?value) { if (value != fee) return #Err(#BadFee({ expected_fee = fee })) }; case null {} };
        let available = balance(args.from);
        if (available < args.amount + fee) return #Err(#InsufficientFunds({ balance = available }));
        let permission = allowance(args.from, spender);
        if (permission.allowance < args.amount + fee) return #Err(#InsufficientAllowance({ allowance = permission.allowance }));
        let index = history.size();
        setAllowance(args.from, spender, { allowance = permission.allowance - args.amount - fee; expires_at = permission.expires_at });
        move(args.from, args.to, args.amount, fee);
        addTransaction({ index; kind = #transferFrom; from = args.from; to = ?args.to; spender = ?spender; amount = args.amount; fee; memo = args.memo; created_at_time = args.created_at_time; timestamp = now() }, key);
        await after(behavior);
        #Ok(index)
    };

    public shared ({ caller }) func icrc2_approve(args : ApproveArgs) : async { #Ok : Nat; #Err : ApproveError } {
        approveCalls += 1;
        let behavior = nextBehavior();
        await before(behavior);
        switch (behavior) {
            case (#temporary) return #Err(#TemporarilyUnavailable);
            case (#approveError(value)) return #Err(value);
            case _ {};
        };
        let from = { owner = caller; subaccount = args.from_subaccount };
        if (not valid(from) or not valid(args.spender)) return #Err(#GenericError({ error_code = 1; message = "Subaccounts must be 32 bytes" }));
        switch (timeError(args.created_at_time)) { case (?error) return #Err(error); case null {} };
        let key = to_candid ("icrc2_approve", caller, args);
        switch (duplicate(key, args.created_at_time)) { case (?index) return #Err(#Duplicate({ duplicate_of = index })); case null {} };
        switch (args.fee) { case (?value) { if (value != fee) return #Err(#BadFee({ expected_fee = fee })) }; case null {} };
        switch (args.expires_at) { case (?expiry) { if (expiry <= now()) return #Err(#Expired({ ledger_time = now() })) }; case null {} };
        let current = allowance(from, args.spender).allowance;
        switch (args.expected_allowance) { case (?expected) { if (expected != current) return #Err(#AllowanceChanged({ current_allowance = current })) }; case null {} };
        let available = balance(from);
        if (available < fee) return #Err(#InsufficientFunds({ balance = available }));
        let index = history.size();
        setBalance(from, available - fee);
        totalSupply -= fee;
        setAllowance(from, args.spender, { allowance = args.amount; expires_at = args.expires_at });
        addTransaction({ index; kind = #approve; from; to = null; spender = ?args.spender; amount = args.amount; fee; memo = args.memo; created_at_time = args.created_at_time; timestamp = now() }, key);
        await after(behavior);
        #Ok(index)
    };
};
