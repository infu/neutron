import Blob "mo:core/Blob";
import List "mo:core/List";
import Nat64 "mo:core/Nat64";
import Capabilities "../capabilities/Types";
import FundingDisplay "../funding/Display";
import AccountIdentifier "../history/AccountIdentifier";
import IcrcTypes "../icrc1/Types";
import Pagination "Pagination";

module {
    public type LegacyTokens = { e8s : Nat64 };

    public type LegacyGetAllowancesArgs = {
        from_account_id : Text;
        prev_spender_id : ?Text;
        take : ?Nat64;
    };

    public type LegacyAllowance = {
        from_account_id : Text;
        to_spender_id : Text;
        allowance : LegacyTokens;
        expires_at : ?Nat64;
    };

    public type LegacyRemoveApprovalArgs = {
        from_subaccount : ?Blob;
        spender : Blob;
        fee : ?Nat;
    };

    public type Cursor = {
        from_account_id : Blob;
        prev_spender_id : Blob;
    };

    public type Allowance = {
        from_account_id : Blob;
        to_spender_id : Blob;
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
    public let MAX_UPDATE_REPLY_BYTES : Nat = 16_384;

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
        let effectivePageSize = switch (Pagination.effectiveTake(
            "ICP allowance",
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
        let source = AccountIdentifier.fromPrincipal(owner);
        let args : LegacyGetAllowancesArgs = {
            from_account_id = AccountIdentifier.toHex(source);
            prev_spender_id = switch (cursor) {
                case null null;
                case (?value) ?AccountIdentifier.toHex(value.prev_spender_id);
            };
            take = ?Nat64.fromNat(effectivePageSize);
        };
        #ok({
            canister = ledger;
            method = "get_allowances";
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
            "ICP allowance",
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
            return #err("ICP allowance reply exceeds the Wallet limit");
        };
        let decoded : ?[LegacyAllowance] = from_candid reply;
        let wireAllowances = switch (decoded) {
            case null return #err("Ledger returned an unexpected ICP allowance result");
            case (?value) value;
        };
        if (wireAllowances.size() > effectivePageSize) {
            return #err("Ledger returned more ICP allowances than requested");
        };
        if (scan.entries + wireAllowances.size() > MAX_SCAN_ENTRIES) {
            return #err("ICP allowance scan exceeds the Wallet entry limit");
        };

        let expectedSource = AccountIdentifier.fromPrincipal(owner);
        let exposed = List.empty<Allowance>();
        var previous = cursor;
        for (wireAllowance in wireAllowances.vals()) {
            let fromAccount = switch (AccountIdentifier.fromHex(wireAllowance.from_account_id)) {
                case null return #err("Ledger returned an invalid ICP source account identifier");
                case (?value) value;
            };
            let spender = switch (AccountIdentifier.fromHex(wireAllowance.to_spender_id)) {
                case null return #err("Ledger returned an invalid ICP spender account identifier");
                case (?value) value;
            };
            if (fromAccount != expectedSource) {
                return #err("Ledger returned an ICP allowance for another source account");
            };
            switch (previous) {
                case null {};
                case (?prior) {
                    if (
                        comparePair(
                            prior.from_account_id,
                            prior.prev_spender_id,
                            fromAccount,
                            spender,
                        ) != #less
                    ) {
                        return #err("Ledger returned a non-progressing ICP allowance cursor");
                    };
                };
            };
            previous := ?{
                from_account_id = fromAccount;
                prev_spender_id = spender;
            };

            let active = switch (wireAllowance.expires_at) {
                case null true;
                case (?expiresAt) expiresAt > nowNs;
            };
            if (wireAllowance.allowance.e8s > 0 and active) {
                List.add(exposed, {
                    from_account_id = fromAccount;
                    to_spender_id = spender;
                    allowance = Nat64.toNat(wireAllowance.allowance.e8s);
                    expires_at = wireAllowance.expires_at;
                });
            };
        };

        // `max_take_allowances` is ledger-configured and is not exposed by this
        // legacy endpoint. An empty follow-up page is the only portable end
        // signal when the previous reply stayed within the exact source.
        let complete = wireAllowances.size() == 0;
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
        spender : Blob,
    ) : IcrcTypes.Result<?Allowance> {
        if (not AccountIdentifier.isValid(spender)) {
            return #err("Invalid ICP spender account identifier");
        };
        for (allowance in page.allowances.vals()) {
            if (allowance.to_spender_id == spender) return #ok(?allowance);
        };
        #ok(null);
    };

    public func removeApprovalRequest(
        ledger : Principal,
        spender : Blob,
        fee : ?Nat,
    ) : IcrcTypes.Result<Capabilities.CallRequest> {
        if (not AccountIdentifier.isValid(spender)) {
            return #err("Invalid ICP spender account identifier");
        };
        let args : LegacyRemoveApprovalArgs = {
            from_subaccount = null;
            spender;
            fee;
        };
        #ok({
            canister = ledger;
            method = "remove_approval";
            args = to_candid (args);
            cycles = 0;
        });
    };

    // `remove_approval` has no idempotency timestamp or expected-allowance CAS.
    // A broker error or malformed successful reply is an unknown outcome;
    // callers must list this spender again before deciding whether another
    // fee-bearing attempt is safe.
    public func decodeRemoveApproval(
        result : Capabilities.CallResult,
    ) : IcrcTypes.Result<IcrcTypes.ApproveResult> {
        let reply = switch (result) {
            case (#err(error)) {
                return #err(FundingDisplay.callError(error.code, error.message));
            };
            case (#ok(value)) value;
        };
        if (reply.size() > MAX_UPDATE_REPLY_BYTES) {
            return #err("ICP remove-approval reply exceeds the Wallet limit");
        };
        let decoded : ?IcrcTypes.ApproveResult = from_candid reply;
        switch (decoded) {
            case null #err("Ledger returned an unexpected ICP remove-approval result");
            case (?value) #ok(value);
        };
    };

    func canonicalCursor(
        owner : Principal,
        cursor : ?Cursor,
    ) : IcrcTypes.Result<?Cursor> {
        switch (cursor) {
            case null #ok(null);
            case (?value) {
                if (
                    not AccountIdentifier.isValid(value.from_account_id) or
                    value.from_account_id != AccountIdentifier.fromPrincipal(owner)
                ) {
                    return #err("ICP allowance cursor is not the Wallet default account");
                };
                if (not AccountIdentifier.isValid(value.prev_spender_id)) {
                    return #err("Invalid ICP allowance cursor spender");
                };
                #ok(?value);
            };
        };
    };

    func comparePair(
        leftFrom : Blob,
        leftSpender : Blob,
        rightFrom : Blob,
        rightSpender : Blob,
    ) : { #less; #equal; #greater } {
        switch (Blob.compare(leftFrom, rightFrom)) {
            case (#equal) Blob.compare(leftSpender, rightSpender);
            case (order) order;
        };
    };
};
