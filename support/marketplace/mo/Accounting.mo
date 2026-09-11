// Proprietary marketplace protocol. All rights reserved.
module {
    public type Balance = { available : Nat; reserved : Nat };
    public type Result<T> = { #ok : T; #err : Text };
    public let empty : Balance = { available = 0; reserved = 0 };
    public func credit(balance : Balance, amount : Nat) : Balance {
        { available = balance.available + amount; reserved = balance.reserved };
    };
    public func reserve(balance : Balance, totalDebit : Nat) : Result<Balance> {
        if (totalDebit == 0) return #err("Withdrawal total debit must be positive");
        if (totalDebit > balance.available) return #err("Withdrawal exceeds available earnings");
        #ok({ available = balance.available - totalDebit; reserved = balance.reserved + totalDebit });
    };
    public func consume(balance : Balance, totalDebit : Nat) : Result<Balance> {
        if (totalDebit > balance.reserved) return #err("Withdrawal reservation is missing");
        #ok({ available = balance.available; reserved = balance.reserved - totalDebit });
    };
    // Only a proven no-effect result permits release. An unknown ledger outcome
    // must continue to hold its exact reservation, regardless of elapsed time.
    public func release(balance : Balance, totalDebit : Nat) : Result<Balance> {
        if (totalDebit > balance.reserved) return #err("Withdrawal reservation is missing");
        #ok({ available = balance.available + totalDebit; reserved = balance.reserved - totalDebit });
    };
    public func netPayout(totalDebit : Nat, fee : Nat) : Result<Nat> {
        if (totalDebit <= fee) return #err("Earnings must exceed the transfer fee; smaller credits remain available");
        #ok(totalDebit - fee);
    };
    public func liabilities(balance : Balance) : Nat { balance.available + balance.reserved };
}
