import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Char "mo:core/Char";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import AccountIdentifier "../../backend/history/AccountIdentifier";
import AllowanceAccount "../../backend/allowances/Account";
import IcpLegacy "../../backend/allowances/IcpLegacy";
import Icrc103 "../../backend/allowances/Icrc103";
import IcrcTypes "../../backend/icrc1/Types";

func unwrap<T>(result : IcrcTypes.Result<T>) : T {
    switch (result) {
        case (#ok(value)) value;
        case (#err(message)) Runtime.trap(message);
    };
};

func unwrapOption<T>(value : ?T, message : Text) : T {
    switch (value) {
        case (?present) present;
        case null Runtime.trap(message);
    };
};

func isError<T>(result : IcrcTypes.Result<T>) : Bool {
    switch (result) {
        case (#ok(_)) false;
        case (#err(_)) true;
    };
};

func subaccount(lastByte : Nat8) : Blob {
    Blob.fromArray(
        Array.tabulate<Nat8>(
            32,
            func(index) { if (index == 31) lastByte else 0 },
        ),
    );
};

func repeatedText(size : Nat) : Text {
    Text.fromArray(Array.tabulate<Char>(size, func(_) { 'x' }));
};

let owner = Principal.fromText("aaaaa-aa");
let otherOwner = Principal.fromText("2vxsx-fae");
let ledger = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
let zeroSubaccount = subaccount(0);
let firstSubaccount = subaccount(1);
let secondSubaccount = subaccount(2);
let nowNs : Nat64 = 100;

let defaultAccount : IcrcTypes.Account = { owner; subaccount = null };
let explicitZeroAccount : IcrcTypes.Account = {
    owner;
    subaccount = ?zeroSubaccount;
};
let firstSourceSubaccount : IcrcTypes.Account = {
    owner;
    subaccount = ?firstSubaccount;
};
let firstSpender : IcrcTypes.Account = {
    owner = otherOwner;
    subaccount = null;
};
let secondSpender : IcrcTypes.Account = {
    owner = otherOwner;
    subaccount = ?firstSubaccount;
};
let thirdSpender : IcrcTypes.Account = {
    owner = otherOwner;
    subaccount = ?secondSubaccount;
};
let oneBytePrincipal = Principal.fromText("74aaa-ah7");
let twoBytePrincipal = Principal.fromText("ihmrf-7yaaa");
let shorterPrincipalSpender : IcrcTypes.Account = {
    owner = oneBytePrincipal;
    subaccount = null;
};
let longerPrincipalSpender : IcrcTypes.Account = {
    owner = twoBytePrincipal;
    subaccount = null;
};

assert (AllowanceAccount.canonical(defaultAccount) != null);
assert (AllowanceAccount.canonical(explicitZeroAccount) != null);
assert (AllowanceAccount.isDefaultFor(defaultAccount, owner));
assert (AllowanceAccount.isDefaultFor(explicitZeroAccount, owner));
assert (AllowanceAccount.compare(defaultAccount, explicitZeroAccount) == ?#equal);
assert (
    unwrapOption(
        AllowanceAccount.canonical(explicitZeroAccount),
        "zero account did not canonicalize",
    ).subaccount == null
);
assert (
    AllowanceAccount.canonical({ owner; subaccount = ?Blob.fromArray([0]) }) == null
);
let canonicalAnonymous = unwrapOption(
    AllowanceAccount.canonical({
        owner = otherOwner;
        subaccount = ?zeroSubaccount;
    }),
    "anonymous ICRC account did not canonicalize",
);
assert (canonicalAnonymous.owner == otherOwner);
assert (canonicalAnonymous.subaccount == null);
// Motoko compares Principal blobs bytewise, but the reference ICRC ledger's
// Principal order compares byte length before contents.
assert (Principal.compare(oneBytePrincipal, twoBytePrincipal) == #greater);
assert (
    AllowanceAccount.compare(shorterPrincipalSpender, longerPrincipalSpender) ==
    ?#less
);

let initialIcrcScan = Icrc103.startScan();
let firstIcrcRequest = unwrap(
    Icrc103.getAllowancesRequest(ledger, owner, initialIcrcScan, 3),
);
assert (firstIcrcRequest.canister == ledger);
assert (firstIcrcRequest.method == "icrc103_get_allowances");
assert (firstIcrcRequest.cycles == 0);
let firstIcrcArgs = unwrapOption<Icrc103.DraftGetAllowancesArgs>(
    from_candid firstIcrcRequest.args,
    "failed to decode first ICRC-103 request",
);
assert (firstIcrcArgs.take == ?3);
assert (firstIcrcArgs.prev_spender == null);
let requestedSource = unwrapOption(
    firstIcrcArgs.from_account,
    "first ICRC-103 request omitted source",
);
assert (AllowanceAccount.isDefaultFor(requestedSource, owner));

let firstIcrcWire : Icrc103.DraftGetAllowancesResult = #Ok([
    {
        from_account = explicitZeroAccount;
        to_spender = firstSpender;
        allowance = 25;
        expires_at = null;
    },
    {
        from_account = defaultAccount;
        to_spender = secondSpender;
        allowance = 0;
        expires_at = ?200;
    },
    {
        from_account = defaultAccount;
        to_spender = thirdSpender;
        allowance = 10;
        expires_at = ?nowNs;
    },
]);
let firstIcrcPage = unwrap(
    Icrc103.decodeAllowances(
        #ok(to_candid (firstIcrcWire)),
        owner,
        initialIcrcScan,
        3,
        nowNs,
    ),
);
assert (firstIcrcPage.allowances.size() == 1);
assert (firstIcrcPage.allowances[0].allowance == 25);
assert (firstIcrcPage.allowances[0].from_account.subaccount == null);
assert (not firstIcrcPage.complete);
assert (firstIcrcPage.scan.pages == 1);
assert (firstIcrcPage.scan.entries == 3);
let firstIcrcCursor = unwrapOption(
    firstIcrcPage.scan.cursor,
    "nonempty ICRC-103 page omitted cursor",
);
assert (firstIcrcCursor.from_account.subaccount == null);
assert (
    AllowanceAccount.compare(firstIcrcCursor.prev_spender, thirdSpender) ==
    ?#equal
);
let nextIcrcRequest = unwrap(
    Icrc103.getAllowancesRequest(ledger, owner, firstIcrcPage.scan, 3),
);
let nextIcrcArgs = unwrapOption<Icrc103.DraftGetAllowancesArgs>(
    from_candid nextIcrcRequest.args,
    "failed to decode next ICRC-103 request",
);
assert (
    AllowanceAccount.isDefaultFor(
        unwrapOption(nextIcrcArgs.from_account, "missing ICRC cursor source"),
        owner,
    )
);
assert (
    AllowanceAccount.compare(
        unwrapOption(nextIcrcArgs.prev_spender, "missing ICRC spender cursor"),
        thirdSpender,
    ) == ?#equal
);

let crossedIcrcWire : Icrc103.DraftGetAllowancesResult = #Ok([{
    from_account = firstSourceSubaccount;
    to_spender = firstSpender;
    allowance = 40;
    expires_at = null;
}]);
let crossedIcrcPage = unwrap(
    Icrc103.decodeAllowances(
        #ok(to_candid (crossedIcrcWire)),
        owner,
        firstIcrcPage.scan,
        3,
        nowNs,
    ),
);
assert (crossedIcrcPage.complete);
assert (crossedIcrcPage.allowances.size() == 0);
assert (crossedIcrcPage.scan.cursor == null);
assert (
    isError(
        Icrc103.getAllowancesRequest(ledger, owner, crossedIcrcPage.scan, 3)
    )
);

let repeatedIcrcWire : Icrc103.DraftGetAllowancesResult = #Ok([{
    from_account = defaultAccount;
    to_spender = thirdSpender;
    allowance = 1;
    expires_at = null;
}]);
assert (
    isError(
        Icrc103.decodeAllowances(
            #ok(to_candid (repeatedIcrcWire)),
            owner,
            firstIcrcPage.scan,
            3,
            nowNs,
        )
    )
);

let mixedPrincipalIcrcWire : Icrc103.DraftGetAllowancesResult = #Ok([
    {
        from_account = defaultAccount;
        to_spender = shorterPrincipalSpender;
        allowance = 11;
        expires_at = null;
    },
    {
        from_account = defaultAccount;
        to_spender = longerPrincipalSpender;
        allowance = 12;
        expires_at = null;
    },
]);
let mixedPrincipalIcrcPage = unwrap(
    Icrc103.decodeAllowances(
        #ok(to_candid (mixedPrincipalIcrcWire)),
        owner,
        initialIcrcScan,
        2,
        nowNs,
    ),
);
assert (mixedPrincipalIcrcPage.allowances.size() == 2);
let mixedPrincipalCursor = unwrapOption(
    mixedPrincipalIcrcPage.scan.cursor,
    "mixed-principal ICRC page omitted cursor",
);
assert (
    AllowanceAccount.compare(
        mixedPrincipalCursor.prev_spender,
        longerPrincipalSpender,
    ) == ?#equal
);
let reversedPrincipalIcrcWire : Icrc103.DraftGetAllowancesResult = #Ok([
    {
        from_account = defaultAccount;
        to_spender = longerPrincipalSpender;
        allowance = 12;
        expires_at = null;
    },
    {
        from_account = defaultAccount;
        to_spender = shorterPrincipalSpender;
        allowance = 11;
        expires_at = null;
    },
]);
assert (
    isError(
        Icrc103.decodeAllowances(
            #ok(to_candid (reversedPrincipalIcrcWire)),
            owner,
            initialIcrcScan,
            2,
            nowNs,
        )
    )
);

let shorterPrincipalIcrcWire : Icrc103.DraftGetAllowancesResult = #Ok([{
    from_account = defaultAccount;
    to_spender = shorterPrincipalSpender;
    allowance = 11;
    expires_at = null;
}]);
let shorterPrincipalIcrcPage = unwrap(
    Icrc103.decodeAllowances(
        #ok(to_candid (shorterPrincipalIcrcWire)),
        owner,
        initialIcrcScan,
        2,
        nowNs,
    ),
);
let longerPrincipalIcrcWire : Icrc103.DraftGetAllowancesResult = #Ok([{
    from_account = defaultAccount;
    to_spender = longerPrincipalSpender;
    allowance = 12;
    expires_at = null;
}]);
let longerPrincipalIcrcPage = unwrap(
    Icrc103.decodeAllowances(
        #ok(to_candid (longerPrincipalIcrcWire)),
        owner,
        shorterPrincipalIcrcPage.scan,
        2,
        nowNs,
    ),
);
assert (longerPrincipalIcrcPage.allowances.size() == 1);
let longerPrincipalCursor = unwrapOption(
    longerPrincipalIcrcPage.scan.cursor,
    "mixed-principal ICRC continuation omitted cursor",
);
assert (
    AllowanceAccount.compare(
        longerPrincipalCursor.prev_spender,
        longerPrincipalSpender,
    ) == ?#equal
);

let wrongOwnerWire : Icrc103.DraftGetAllowancesResult = #Ok([{
    from_account = { owner = otherOwner; subaccount = null };
    to_spender = firstSpender;
    allowance = 1;
    expires_at = null;
}]);
assert (
    isError(
        Icrc103.decodeAllowances(
            #ok(to_candid (wrongOwnerWire)),
            owner,
            initialIcrcScan,
            3,
            nowNs,
        )
    )
);

let invalidAccountWire : Icrc103.DraftGetAllowancesResult = #Ok([{
    from_account = defaultAccount;
    to_spender = { owner = otherOwner; subaccount = ?Blob.fromArray([1]) };
    allowance = 1;
    expires_at = null;
}]);
assert (
    isError(
        Icrc103.decodeAllowances(
            #ok(to_candid (invalidAccountWire)),
            owner,
            initialIcrcScan,
            3,
            nowNs,
        )
    )
);

let tooManyIcrcWire : Icrc103.DraftGetAllowancesResult = #Ok([
    {
        from_account = defaultAccount;
        to_spender = firstSpender;
        allowance = 1;
        expires_at = null;
    },
    {
        from_account = defaultAccount;
        to_spender = secondSpender;
        allowance = 1;
        expires_at = null;
    },
]);
assert (
    isError(
        Icrc103.decodeAllowances(
            #ok(to_candid (tooManyIcrcWire)),
            owner,
            initialIcrcScan,
            1,
            nowNs,
        )
    )
);

let deniedIcrcWire : Icrc103.DraftGetAllowancesResult = #Err(
    #AccessDenied({ reason = "private" })
);
assert (
    isError(
        Icrc103.decodeAllowances(
            #ok(to_candid (deniedIcrcWire)),
            owner,
            initialIcrcScan,
            3,
            nowNs,
        )
    )
);

let canonicalCursorScan : Icrc103.Scan = {
    cursor = ?{
        from_account = explicitZeroAccount;
        prev_spender = { owner = otherOwner; subaccount = ?zeroSubaccount };
    };
    pages = 1;
    entries = 1;
};
assert (
    not isError(
        Icrc103.getAllowancesRequest(ledger, owner, canonicalCursorScan, 1)
    )
);
let wrongSourceCursorScan : Icrc103.Scan = {
    cursor = ?{
        from_account = firstSourceSubaccount;
        prev_spender = firstSpender;
    };
    pages = 1;
    entries = 1;
};
assert (
    isError(
        Icrc103.getAllowancesRequest(ledger, owner, wrongSourceCursorScan, 1)
    )
);
let pageCappedIcrcScan : Icrc103.Scan = {
    cursor = ?firstIcrcCursor;
    pages = Icrc103.MAX_SCAN_PAGES;
    entries = 1;
};
assert (
    isError(
        Icrc103.getAllowancesRequest(ledger, owner, pageCappedIcrcScan, 1)
    )
);
let entryCappedIcrcScan : Icrc103.Scan = {
    cursor = ?firstIcrcCursor;
    pages = 1;
    entries = Icrc103.MAX_SCAN_ENTRIES;
};
assert (
    isError(
        Icrc103.getAllowancesRequest(ledger, owner, entryCappedIcrcScan, 1)
    )
);

let oversizedIcrcWire : Icrc103.DraftGetAllowancesResult = #Err(#GenericError({
    error_code = 1;
    message = repeatedText(Icrc103.MAX_REPLY_BYTES + 1);
}));
let oversizedIcrcReply = to_candid (oversizedIcrcWire);
assert (oversizedIcrcReply.size() > Icrc103.MAX_REPLY_BYTES);
switch (Icrc103.decodeAllowances(
    #ok(oversizedIcrcReply),
    owner,
    initialIcrcScan,
    3,
    nowNs,
)) {
    case (#err(message)) {
        assert (message == "ICRC-103 allowance reply exceeds the Wallet limit");
    };
    case (#ok(_)) assert false;
};

let icpSource = AccountIdentifier.fromPrincipal(owner);
let icpSpenderOne = unwrapOption(
    AccountIdentifier.fromHex(
        "1c7a48ba6a562aa9eaa2481a9049cdf0433b9738c992d698c31d8abf89cadc79"
    ),
    "invalid first ICP test account identifier",
);
let icpSpenderTwo = unwrapOption(
    AccountIdentifier.fromHex(
        "883eef7c44be51afe4a4420d4df4beff708f3cf2f5de5efcc9f58680bb0f3690"
    ),
    "invalid second ICP test account identifier",
);
assert (Blob.compare(icpSpenderOne, icpSpenderTwo) == #less);
assert (AccountIdentifier.compare(icpSpenderTwo, icpSpenderOne) == ?#less);
assert (
    AccountIdentifier.compare(Blob.fromArray([1]), icpSpenderOne) == null
);

let initialIcpScan = IcpLegacy.startScan();
let firstIcpRequest = unwrap(
    IcpLegacy.getAllowancesRequest(ledger, owner, initialIcpScan, 2),
);
assert (firstIcpRequest.method == "get_allowances");
let firstIcpArgs = unwrapOption<IcpLegacy.LegacyGetAllowancesArgs>(
    from_candid firstIcpRequest.args,
    "failed to decode first ICP allowance request",
);
assert (firstIcpArgs.from_account_id == AccountIdentifier.toHex(icpSource));
assert (firstIcpArgs.prev_spender_id == null);
assert (firstIcpArgs.take == ?2);

let firstIcpWire : [IcpLegacy.LegacyAllowance] = [
    {
        from_account_id = AccountIdentifier.toHex(icpSource);
        to_spender_id = AccountIdentifier.toHex(icpSpenderTwo);
        allowance = { e8s = 90 };
        expires_at = ?nowNs;
    },
    {
        from_account_id = AccountIdentifier.toHex(icpSource);
        to_spender_id = AccountIdentifier.toHex(icpSpenderOne);
        allowance = { e8s = 75 };
        expires_at = null;
    },
];
let firstIcpPage = unwrap(
    IcpLegacy.decodeAllowances(
        #ok(to_candid (firstIcpWire)),
        owner,
        initialIcpScan,
        2,
        nowNs,
    ),
);
let reversedHashIcpWire : [IcpLegacy.LegacyAllowance] = [
    firstIcpWire[1],
    firstIcpWire[0],
];
assert (
    isError(
        IcpLegacy.decodeAllowances(
            #ok(to_candid (reversedHashIcpWire)),
            owner,
            initialIcpScan,
            2,
            nowNs,
        )
    )
);
assert (firstIcpPage.allowances.size() == 1);
assert (firstIcpPage.allowances[0].allowance == 75);
assert (not firstIcpPage.complete);
let firstIcpCursor = unwrapOption(
    firstIcpPage.scan.cursor,
    "nonempty ICP page omitted cursor",
);
assert (firstIcpCursor.from_account_id == icpSource);
assert (firstIcpCursor.prev_spender_id == icpSpenderOne);
assert (
    unwrapOption(
        unwrap(IcpLegacy.findAllowance(firstIcpPage, icpSpenderOne)),
        "active ICP allowance not found",
    ).allowance == 75
);

let lowerHashIcpWire : [IcpLegacy.LegacyAllowance] = [{
    from_account_id = AccountIdentifier.toHex(icpSource);
    to_spender_id = AccountIdentifier.toHex(icpSpenderTwo);
    allowance = { e8s = 80 };
    expires_at = null;
}];
let lowerHashIcpPage = unwrap(
    IcpLegacy.decodeAllowances(
        #ok(to_candid (lowerHashIcpWire)),
        owner,
        initialIcpScan,
        2,
        nowNs,
    ),
);
let higherHashIcpWire : [IcpLegacy.LegacyAllowance] = [{
    from_account_id = AccountIdentifier.toHex(icpSource);
    to_spender_id = AccountIdentifier.toHex(icpSpenderOne);
    allowance = { e8s = 81 };
    expires_at = null;
}];
let higherHashIcpPage = unwrap(
    IcpLegacy.decodeAllowances(
        #ok(to_candid (higherHashIcpWire)),
        owner,
        lowerHashIcpPage.scan,
        2,
        nowNs,
    ),
);
assert (higherHashIcpPage.allowances.size() == 1);

let nextIcpRequest = unwrap(
    IcpLegacy.getAllowancesRequest(ledger, owner, firstIcpPage.scan, 2),
);
let nextIcpArgs = unwrapOption<IcpLegacy.LegacyGetAllowancesArgs>(
    from_candid nextIcpRequest.args,
    "failed to decode next ICP allowance request",
);
assert (
    nextIcpArgs.prev_spender_id ==
    ?AccountIdentifier.toHex(icpSpenderOne)
);
let emptyIcpPage = unwrap(
    IcpLegacy.decodeAllowances(
        #ok(to_candid ([] : [IcpLegacy.LegacyAllowance])),
        owner,
        firstIcpPage.scan,
        2,
        nowNs,
    ),
);
assert (emptyIcpPage.complete);
assert (emptyIcpPage.scan.cursor == null);

let repeatedIcpWire : [IcpLegacy.LegacyAllowance] = [{
    from_account_id = AccountIdentifier.toHex(icpSource);
    to_spender_id = AccountIdentifier.toHex(icpSpenderOne);
    allowance = { e8s = 1 };
    expires_at = null;
}];
assert (
    isError(
        IcpLegacy.decodeAllowances(
            #ok(to_candid (repeatedIcpWire)),
            owner,
            firstIcpPage.scan,
            2,
            nowNs,
        )
    )
);

let wrongIcpSourceWire : [IcpLegacy.LegacyAllowance] = [{
    from_account_id = AccountIdentifier.toHex(icpSpenderOne);
    to_spender_id = AccountIdentifier.toHex(icpSpenderTwo);
    allowance = { e8s = 1 };
    expires_at = null;
}];
assert (
    isError(
        IcpLegacy.decodeAllowances(
            #ok(to_candid (wrongIcpSourceWire)),
            owner,
            initialIcpScan,
            2,
            nowNs,
        )
    )
);
let invalidIcpSpenderWire : [IcpLegacy.LegacyAllowance] = [{
    from_account_id = AccountIdentifier.toHex(icpSource);
    to_spender_id =
        "0c7a48ba6a562aa9eaa2481a9049cdf0433b9738c992d698c31d8abf89cadc79";
    allowance = { e8s = 1 };
    expires_at = null;
}];
assert (
    isError(
        IcpLegacy.decodeAllowances(
            #ok(to_candid (invalidIcpSpenderWire)),
            owner,
            initialIcpScan,
            2,
            nowNs,
        )
    )
);
assert (
    isError(
        IcpLegacy.decodeAllowances(
            #ok(to_candid (firstIcpWire)),
            owner,
            initialIcpScan,
            1,
            nowNs,
        )
    )
);
let oversizedIcpWire : [IcpLegacy.LegacyAllowance] = [{
    from_account_id = repeatedText(IcpLegacy.MAX_REPLY_BYTES + 1);
    to_spender_id = AccountIdentifier.toHex(icpSpenderOne);
    allowance = { e8s = 1 };
    expires_at = null;
}];
let oversizedIcpReply = to_candid (oversizedIcpWire);
assert (oversizedIcpReply.size() > IcpLegacy.MAX_REPLY_BYTES);
switch (IcpLegacy.decodeAllowances(
    #ok(oversizedIcpReply),
    owner,
    initialIcpScan,
    2,
    nowNs,
)) {
    case (#err(message)) {
        assert (message == "ICP allowance reply exceeds the Wallet limit");
    };
    case (#ok(_)) assert false;
};

let removeRequest = unwrap(
    IcpLegacy.removeApprovalRequest(ledger, icpSpenderOne, ?10_000),
);
assert (removeRequest.method == "remove_approval");
let removeArgs = unwrapOption<IcpLegacy.LegacyRemoveApprovalArgs>(
    from_candid removeRequest.args,
    "failed to decode ICP remove-approval request",
);
assert (removeArgs.from_subaccount == null);
assert (removeArgs.spender == icpSpenderOne);
assert (removeArgs.fee == ?10_000);
assert (
    isError(
        IcpLegacy.removeApprovalRequest(ledger, Blob.fromArray([1]), ?10_000)
    )
);

let cappedIcpScan : IcpLegacy.Scan = {
    cursor = ?firstIcpCursor;
    pages = IcpLegacy.MAX_SCAN_PAGES;
    entries = 1;
};
assert (
    isError(
        IcpLegacy.getAllowancesRequest(ledger, owner, cappedIcpScan, 1)
    )
);
let entryCappedIcpScan : IcpLegacy.Scan = {
    cursor = ?firstIcpCursor;
    pages = 1;
    entries = IcpLegacy.MAX_SCAN_ENTRIES;
};
assert (
    isError(
        IcpLegacy.getAllowancesRequest(ledger, owner, entryCappedIcpScan, 1)
    )
);
