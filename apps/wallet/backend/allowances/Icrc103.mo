import List "mo:core/List";
import Capabilities "../capabilities/Types";
import FundingDisplay "../funding/Display";
import IcrcTypes "../icrc1/Types";
import Account "Account";
import Pagination "Pagination";

module {
    // ICRC-103 is still a draft. Keep its wire records in this adapter instead
    // of adding them to the accepted ICRC-1/2 types used by the rest of Wallet.
    public type DraftGetAllowancesArgs = {
        from_account : ?IcrcTypes.Account;
        prev_spender : ?IcrcTypes.Account;
        take : ?Nat;
    };

    public type DraftAllowance = {
        from_account : IcrcTypes.Account;
        to_spender : IcrcTypes.Account;
        allowance : Nat;
        expires_at : ?Nat64;
    };

    public type DraftGetAllowancesError = {
        #AccessDenied : { reason : Text };
        #GenericError : { error_code : Nat; message : Text };
    };

    public type DraftGetAllowancesResult = {
        #Ok : [DraftAllowance];
        #Err : DraftGetAllowancesError;
    };

    // Both fields are required by ICRC-103 pagination. `from_account` is not
    // merely a filter: it is the first half of the ordered pair cursor.
    public type Cursor = {
        from_account : IcrcTypes.Account;
        prev_spender : IcrcTypes.Account;
    };

    public type Allowance = {
        from_account : IcrcTypes.Account;
        to_spender : IcrcTypes.Account;
        allowance : Nat;
        expires_at : ?Nat64;
    };

    public type Scan = Pagination.Scan<Cursor>;

    public type Page = {
        allowances : [Allowance];
        scan : Scan;
        complete : Bool;
    };

    public let DEFAULT_TAKE : Nat = 100;
    public let MAX_PAGE_ENTRIES : Nat = 500;
    public let MAX_SCAN_PAGES : Nat = 32;
    public let MAX_SCAN_ENTRIES : Nat = 4_096;
    public let MAX_REPLY_BYTES : Nat = 262_144;

    let limits : Pagination.Limits = {
        max_page_entries = MAX_PAGE_ENTRIES;
        max_scan_pages = MAX_SCAN_PAGES;
        max_scan_entries = MAX_SCAN_ENTRIES;
    };

    public func startScan() : Scan {
        Pagination.start<Cursor>();
    };

    public func getAllowancesRequest(
        ledger : Principal,
        owner : Principal,
        scan : Scan,
        take : Nat,
    ) : IcrcTypes.Result<Capabilities.CallRequest> {
        let effectiveTake = switch (Pagination.effectiveTake(
            "ICRC-103 allowance",
            scan,
            take,
            limits,
        )) {
            case (#ok(value)) value;
            case (#err(message)) return #err(message);
        };
        let cursor = switch (canonicalCursor(owner, scan.cursor)) {
            case (#ok(value)) value;
            case (#err(message)) return #err(message);
        };
        let args : DraftGetAllowancesArgs = switch (cursor) {
            case null {
                {
                    from_account = ?defaultAccount(owner);
                    prev_spender = null;
                    take = ?effectiveTake;
                };
            };
            case (?value) {
                {
                    from_account = ?value.from_account;
                    prev_spender = ?value.prev_spender;
                    take = ?effectiveTake;
                };
            };
        };
        #ok({
            canister = ledger;
            method = "icrc103_get_allowances";
            args = to_candid (args);
            cycles = 0;
        });
    };

    public func decodeAllowances(
        result : Capabilities.CallResult,
        owner : Principal,
        scan : Scan,
        take : Nat,
        nowNs : Nat64,
    ) : IcrcTypes.Result<Page> {
        let effectivePageSize = switch (Pagination.effectiveTake(
            "ICRC-103 allowance",
            scan,
            take,
            limits,
        )) {
            case (#ok(value)) value;
            case (#err(message)) return #err(message);
        };
        let cursor = switch (canonicalCursor(owner, scan.cursor)) {
            case (#ok(value)) value;
            case (#err(message)) return #err(message);
        };
        let reply = switch (result) {
            case (#err(error)) {
                return #err(FundingDisplay.callError(error.code, error.message));
            };
            case (#ok(value)) value;
        };
        if (reply.size() > MAX_REPLY_BYTES) {
            return #err("ICRC-103 allowance reply exceeds the Wallet limit");
        };
        let decoded : ?DraftGetAllowancesResult = from_candid reply;
        let wireAllowances = switch (decoded) {
            case null return #err("Ledger returned an unexpected ICRC-103 allowance result");
            case (?#Err(#AccessDenied(error))) {
                return #err(
                    "Ledger denied allowance access: " # FundingDisplay.prefix(
                        error.reason,
                        FundingDisplay.MAX_ERROR_MESSAGE_CHARS,
                    )
                );
            };
            case (?#Err(#GenericError(error))) {
                return #err(
                    "Ledger allowance error " # FundingDisplay.natText(error.error_code) #
                    ": " # FundingDisplay.prefix(
                        error.message,
                        FundingDisplay.MAX_ERROR_MESSAGE_CHARS,
                    )
                );
            };
            case (?#Ok(value)) value;
        };
        if (wireAllowances.size() > effectivePageSize) {
            return #err("Ledger returned more ICRC-103 allowances than requested");
        };
        if (scan.entries + wireAllowances.size() > MAX_SCAN_ENTRIES) {
            return #err("ICRC-103 allowance scan exceeds the Wallet entry limit");
        };

        let exposed = List.empty<Allowance>();
        var previous = cursor;
        var crossedDefaultAccount = false;
        for (wireAllowance in wireAllowances.vals()) {
            let fromAccount = switch (Account.canonical(wireAllowance.from_account)) {
                case null return #err("Ledger returned an invalid ICRC-103 source account");
                case (?value) value;
            };
            let spender = switch (Account.canonical(wireAllowance.to_spender)) {
                case null return #err("Ledger returned an invalid ICRC-103 spender account");
                case (?value) value;
            };
            if (fromAccount.owner != owner) {
                return #err("Ledger returned an ICRC-103 allowance for another owner");
            };
            switch (previous) {
                case null {};
                case (?prior) {
                    if (
                        Account.comparePair(
                            prior.from_account,
                            prior.prev_spender,
                            fromAccount,
                            spender,
                        ) != ?#less
                    ) {
                        return #err("Ledger returned a non-progressing ICRC-103 cursor");
                    };
                };
            };
            previous := ?{
                from_account = fromAccount;
                prev_spender = spender;
            };

            if (Account.isDefaultFor(fromAccount, owner)) {
                if (crossedDefaultAccount) {
                    return #err("Ledger returned out-of-order ICRC-103 source accounts");
                };
                let active = switch (wireAllowance.expires_at) {
                    case null true;
                    case (?expiresAt) expiresAt > nowNs;
                };
                if (wireAllowance.allowance > 0 and active) {
                    List.add(exposed, {
                        from_account = fromAccount;
                        to_spender = spender;
                        allowance = wireAllowance.allowance;
                        expires_at = wireAllowance.expires_at;
                    });
                };
            } else {
                crossedDefaultAccount := true;
            };
        };

        // The draft allows an implementation-specific maximum below `take`.
        // Without trustworthy metadata, only an empty page (or crossing into a
        // later source subaccount) proves the exact default account is complete.
        let complete = wireAllowances.size() == 0 or crossedDefaultAccount;
        #ok({
            allowances = List.toArray(exposed);
            complete;
            scan = {
                cursor = if (complete) null else previous;
                pages = scan.pages + 1;
                entries = scan.entries + wireAllowances.size();
            };
        });
    };

    public func findAllowance(
        page : Page,
        spender : IcrcTypes.Account,
    ) : IcrcTypes.Result<?Allowance> {
        let canonicalSpender = switch (Account.canonical(spender)) {
            case null return #err("Invalid ICRC-103 spender account");
            case (?value) value;
        };
        for (allowance in page.allowances.vals()) {
            if (Account.compare(allowance.to_spender, canonicalSpender) == ?#equal) {
                return #ok(?allowance);
            };
        };
        #ok(null);
    };

    func defaultAccount(owner : Principal) : IcrcTypes.Account {
        {
            owner;
            subaccount = null;
        };
    };

    func canonicalCursor(
        owner : Principal,
        cursor : ?Cursor,
    ) : IcrcTypes.Result<?Cursor> {
        switch (cursor) {
            case null #ok(null);
            case (?value) {
                let fromAccount = switch (Account.canonical(value.from_account)) {
                    case null return #err("Invalid ICRC-103 cursor source account");
                    case (?account) account;
                };
                let spender = switch (Account.canonical(value.prev_spender)) {
                    case null return #err("Invalid ICRC-103 cursor spender account");
                    case (?account) account;
                };
                if (not Account.isDefaultFor(fromAccount, owner)) {
                    return #err("ICRC-103 cursor is not the Wallet default account");
                };
                #ok(?{
                    from_account = fromAccount;
                    prev_spender = spender;
                });
            };
        };
    };

};
