import Blob "mo:core/Blob";
import Order "mo:core/Order";
import Principal "mo:core/Principal";
import IcrcTypes "../icrc1/Types";

module {
    let ZERO_SUBACCOUNT : Blob = "\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00";

    public func canonical(account : IcrcTypes.Account) : ?IcrcTypes.Account {
        switch (account.subaccount) {
            case null ?account;
            case (?subaccount) {
                if (subaccount.size() != 32) return null;
                ?{
                    owner = account.owner;
                    subaccount = if (subaccount == ZERO_SUBACCOUNT) null else ?subaccount;
                };
            };
        };
    };

    public func isDefaultFor(
        account : IcrcTypes.Account,
        owner : Principal,
    ) : Bool {
        if (account.owner != owner) return false;
        switch (account.subaccount) {
            case null true;
            case (?subaccount) subaccount.size() == 32 and subaccount == ZERO_SUBACCOUNT;
        };
    };

    public func compare(
        left : IcrcTypes.Account,
        right : IcrcTypes.Account,
    ) : ?Order.Order {
        let ?leftSubaccount = effectiveSubaccount(left.subaccount) else return null;
        let ?rightSubaccount = effectiveSubaccount(right.subaccount) else return null;
        switch (ledgerPrincipalCompare(left.owner, right.owner)) {
            case (#equal) ?Blob.compare(leftSubaccount, rightSubaccount);
            case (order) ?order;
        };
    };

    public func comparePair(
        leftFrom : IcrcTypes.Account,
        leftSpender : IcrcTypes.Account,
        rightFrom : IcrcTypes.Account,
        rightSpender : IcrcTypes.Account,
    ) : ?Order.Order {
        switch (compare(leftFrom, rightFrom)) {
            case null null;
            case (?#equal) compare(leftSpender, rightSpender);
            case (?order) ?order;
        };
    };

    func effectiveSubaccount(subaccount : ?Blob) : ?Blob {
        switch (subaccount) {
            case null ?ZERO_SUBACCOUNT;
            case (?value) {
                if (value.size() == 32) ?value else null;
            };
        };
    };

    // The reference ICRC ledger orders candid Principals by their in-memory
    // `Principal` value: byte length first, then bytes. Motoko's native
    // Principal comparison is a raw bytewise comparison and differs whenever
    // principal lengths differ, so it cannot validate an ICRC-103 cursor.
    func ledgerPrincipalCompare(left : Principal, right : Principal) : Order.Order {
        let leftBytes = Principal.toBlob(left);
        let rightBytes = Principal.toBlob(right);
        if (leftBytes.size() < rightBytes.size()) return #less;
        if (leftBytes.size() > rightBytes.size()) return #greater;
        Blob.compare(leftBytes, rightBytes);
    };

};
