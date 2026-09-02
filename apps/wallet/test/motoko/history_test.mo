import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Capabilities "../../backend/capabilities/Types";
import AccountIdentifier "../../backend/history/AccountIdentifier";
import IcpIndex "../../backend/history/IcpIndex";
import IcrcIndex "../../backend/history/IcrcIndex";
import IcrcLedger "../../backend/history/IcrcLedger";
import Reconcile "../../backend/history/Reconcile";
import Store "../../backend/history/Store";
import HistoryTypes "../../backend/history/Types";
import Memory "../../backend/memory/wallet/v1";
import Wallet "../../backend/main";

// Keep the scheduled history capability plumbing in the Motoko compile graph.

let vectors : [(Text, Text)] = [
    (
        "aaaaa-aa",
        "2d0e897f7e862d2b57d9bc9ea5c65f9a24ac6c074575f47898314b8d6cb0929d",
    ),
    (
        "ryjl3-tyaaa-aaaaa-aaaba-cai",
        "883eef7c44be51afe4a4420d4df4beff708f3cf2f5de5efcc9f58680bb0f3690",
    ),
    (
        "mxzaz-hqaaa-aaaar-qaada-cai",
        "eff69ed8f9fc03ceba97e6f4e1a9d1a32641fcd49aba96922c51a7dca91a4c6e",
    ),
    (
        "2vxsx-fae",
        "1c7a48ba6a562aa9eaa2481a9049cdf0433b9738c992d698c31d8abf89cadc79",
    ),
];

for ((principalText, expected) in vectors.vals()) {
    let actual = AccountIdentifier.toHex(
        AccountIdentifier.fromPrincipal(Principal.fromText(principalText)),
    );
    assert (actual == expected);
    switch (AccountIdentifier.fromHex(expected)) {
        case null assert false;
        case (?decoded) assert (AccountIdentifier.toHex(decoded) == expected);
    };
};

assert (
    AccountIdentifier.fromHex(
        "0d0e897f7e862d2b57d9bc9ea5c65f9a24ac6c074575f47898314b8d6cb0929d"
    ) == null
);
assert (AccountIdentifier.fromHex("abcd") == null);

let zeroSubaccount = Blob.fromArray(Array.tabulate<Nat8>(32, func(_) { 0 }));
assert (
    AccountIdentifier.fromAccount(Principal.fromText("2vxsx-fae"), null) ==
    ?AccountIdentifier.fromPrincipal(Principal.fromText("2vxsx-fae"))
);
assert (
    AccountIdentifier.fromAccount(Principal.fromText("2vxsx-fae"), ?zeroSubaccount) ==
    ?AccountIdentifier.fromPrincipal(Principal.fromText("2vxsx-fae"))
);
let nonzeroSubaccount = Blob.fromArray(
    Array.tabulate<Nat8>(32, func(index) { if (index == 31) 1 else 0 }),
);
let nonzeroAccountIdentifier = switch (AccountIdentifier.fromAccount(
    Principal.fromText("2vxsx-fae"),
    ?nonzeroSubaccount,
)) {
    case (?value) value;
    case null {
        assert false;
        Blob.fromArray([]);
    };
};
assert (
    AccountIdentifier.toHex(nonzeroAccountIdentifier) ==
    "b8fab0be4ad596a3739ab93e7316a8647ee72e167709441da49ce9171828629d"
);
assert (
    AccountIdentifier.fromAccount(
        Principal.fromText("2vxsx-fae"),
        ?Blob.fromArray([1]),
    ) == null
);

let quietLedger = Reconcile.accountAnchor({
    balance = 25;
    newest_block_id = ?80;
});
assert (quietLedger.tip_exclusive == 81);
assert (quietLedger.balance == 25);

let accountAdvanced = Reconcile.accountAnchor({
    balance = 30;
    newest_block_id = ?105;
});
assert (accountAdvanced.tip_exclusive == 106);
assert (accountAdvanced.balance == 30);

let emptyAccount = Reconcile.accountAnchor({
    balance = 0;
    newest_block_id = null;
});
assert (emptyAccount.tip_exclusive == 0);

assert (Reconcile.boundedScanCursor(null, 106) == ?106);
assert (Reconcile.boundedScanCursor(?75, 106) == ?75);
assert (HistoryTypes.capturedHeadMatches(?105, ?106, 80, 106));
assert (not HistoryTypes.capturedHeadMatches(null, ?106, 80, 106));
assert (not HistoryTypes.capturedHeadMatches(?104, ?106, 80, 106));
assert (HistoryTypes.capturedHeadMatches(?74, ?75, 40, 106));
assert (HistoryTypes.capturedHeadMatches(null, ?80, 80, 80));

let emptyIcpContinuation : Capabilities.CallResult = #ok(to_candid (#Ok({
    balance = (25 : Nat64);
    transactions = ([] : [None]);
    oldest_tx_id = ?(10 : Nat64);
})));
assert (switch (IcpIndex.decodePage(
    emptyIcpContinuation,
    Principal.fromText("aaaaa-aa"),
    ?75,
    40,
    106,
)) {
    case (#err(error)) error == "ICP index transaction page made no progress";
    case (#ok(_)) false;
});

let emptyIcrcContinuation : Capabilities.CallResult = #ok(to_candid (#Ok({
    balance = (25 : Nat);
    transactions = ([] : [None]);
    oldest_tx_id = ?(10 : Nat);
})));
assert (switch (IcrcIndex.decodePage(
    emptyIcrcContinuation,
    Principal.fromText("aaaaa-aa"),
    ?75,
    40,
    106,
)) {
    case (#err(error)) error == "Index transaction page made no progress";
    case (#ok(_)) false;
});

let walletPrincipal = Principal.fromText("aaaaa-aa");
let otherPrincipal = Principal.fromText("2vxsx-fae");
let icpLedger = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
let ckbtcLedger = Principal.fromText("mxzaz-hqaaa-aaaar-qaada-cai");
let ckethLedger = Principal.fromText("ss2fx-dyaaa-aaaar-qacoq-cai");
let ckerc20Ledger = Principal.fromText("xevnm-gaaaa-aaaar-qafnq-cai");
let ckethMinter = Principal.fromText("sv3dd-oaaaa-aaaar-qacoa-cai");
let gasBlockIndex = 501;
let assetBlockIndex = 701;
let ethereumIntent : Memory.TransferIntent = {
    contact_id = 1;
    address_id = 2;
    contact_name = "Ethereum recipient";
    address_label = ?"Main";
    network = "ethereum_mainnet";
    destination = "0x1111111111111111111111111111111111111111";
    native = true;
};
let gasNative : Memory.NativeHistoryContext = {
    network = "ethereum_mainnet";
    transaction_id = null;
    output_index = null;
    related_ledger = ?ckerc20Ledger;
    related_block_index = ?assetBlockIndex;
};
let assetNative : Memory.NativeHistoryContext = {
    network = "ethereum_mainnet";
    transaction_id = null;
    output_index = null;
    related_ledger = ?ckethLedger;
    related_block_index = ?gasBlockIndex;
};
let walletAddress : Memory.HistoryAddress = #icrc({
    owner = walletPrincipal;
    subaccount = null;
});
let minterAddress : Memory.HistoryAddress = #icrc({
    owner = ckethMinter;
    subaccount = null;
});
func reconciles(
    ledger : Principal,
    pending : Memory.HistoryTransaction,
    canonical : Memory.HistoryTransaction,
    related : ?Memory.HistoryTransaction,
) : Bool {
    Reconcile.pendingMatches(ledger, walletPrincipal, pending, canonical, related);
};
assert (
    Reconcile.historyAddress(icpLedger, {
        owner = otherPrincipal;
        subaccount = null;
    }) == #icp_account_identifier(AccountIdentifier.fromPrincipal(otherPrincipal))
);
assert (
    Reconcile.historyAddress(ckbtcLedger, {
        owner = otherPrincipal;
        subaccount = null;
    }) == #icrc({ owner = otherPrincipal; subaccount = null })
);

let pendingIcpTransfer : Memory.HistoryTransaction = {
    block_index = 400;
    operation = #transfer;
    timestamp_ns = 1;
    amount = 1_000_000;
    fee = ?10_000;
    balance_effect = -1_010_000;
    from = ?walletAddress;
    to = ?#icrc({ owner = otherPrincipal; subaccount = null });
    spender = null;
    memo = null;
    intent = null;
    native = null;
    provenance = #local_pending;
    verification = #pending;
};
let canonicalIcpTransfer : Memory.HistoryTransaction = {
    pendingIcpTransfer with
    from = ?#icp_account_identifier(AccountIdentifier.fromPrincipal(walletPrincipal));
    to = ?#icp_account_identifier(AccountIdentifier.fromPrincipal(otherPrincipal));
    provenance = #index;
};
assert (reconciles(icpLedger, pendingIcpTransfer, canonicalIcpTransfer, null));
assert (not reconciles(ckbtcLedger, pendingIcpTransfer, canonicalIcpTransfer, null));
let wrongIcpDestination = {
    canonicalIcpTransfer with
    to = ?#icp_account_identifier(AccountIdentifier.fromPrincipal(walletPrincipal));
};
assert (not reconciles(icpLedger, pendingIcpTransfer, wrongIcpDestination, null));
let pendingSubaccountTransfer = {
    pendingIcpTransfer with
    to = ?#icrc({ owner = otherPrincipal; subaccount = ?nonzeroSubaccount });
};
let canonicalSubaccountTransfer = {
    canonicalIcpTransfer with
    to = ?#icp_account_identifier(nonzeroAccountIdentifier);
};
assert (reconciles(icpLedger, pendingSubaccountTransfer, canonicalSubaccountTransfer, null));
let wrongSubaccountIdentifier = switch (AccountIdentifier.fromAccount(
    otherPrincipal,
    ?Blob.fromArray(Array.tabulate<Nat8>(32, func(index) {
        if (index == 31) 2 else 0;
    })),
)) {
    case (?value) value;
    case null {
        assert false;
        Blob.fromArray([]);
    };
};
let wrongSubaccountTransfer = {
    canonicalSubaccountTransfer with
    to = ?#icp_account_identifier(wrongSubaccountIdentifier);
};
assert (not reconciles(icpLedger, pendingSubaccountTransfer, wrongSubaccountTransfer, null));

let legacyMemo = Blob.fromArray([0, 0, 0, 0, 0, 0, 0, 7]);
let nativeBurnMemo = Blob.fromArray([217, 217, 247, 161, 0, 1]);
let pendingApproval : Memory.HistoryTransaction = {
    pendingIcpTransfer with
    block_index = 450;
    operation = #approve;
    amount = 500;
    fee = ?10;
    balance_effect = -10;
    to = null;
    spender = ?#icrc({ owner = otherPrincipal; subaccount = null });
};
let canonicalApproval : Memory.HistoryTransaction = {
    pendingApproval with
    from = ?#icp_account_identifier(AccountIdentifier.fromPrincipal(walletPrincipal));
    spender = ?#icp_account_identifier(AccountIdentifier.fromPrincipal(otherPrincipal));
    memo = ?legacyMemo;
    provenance = #index;
};

// Approval reconciliation is exact. The sole memo exception is a null local
// memo against the legacy Nat64 memo synthesized by the ICP index.
assert (reconciles(icpLedger, pendingApproval, canonicalApproval, null));
let approvalConflicts : [Memory.HistoryTransaction] = [
    { canonicalApproval with block_index = 451 },
    { canonicalApproval with operation = #transfer },
    { canonicalApproval with amount = 501 },
    { canonicalApproval with fee = ?11 },
    { canonicalApproval with balance_effect = -11 },
    { canonicalApproval with from = ?#icp_account_identifier(
        AccountIdentifier.fromPrincipal(otherPrincipal)
    ) },
    { canonicalApproval with to = ?walletAddress },
    { canonicalApproval with spender = ?#icp_account_identifier(
        AccountIdentifier.fromPrincipal(walletPrincipal)
    ) },
    { canonicalApproval with provenance = #local_pending },
    { canonicalApproval with provenance = #ledger },
    { canonicalApproval with memo = ?Blob.fromArray([7]) },
];
for (conflict in approvalConflicts.vals()) {
    assert (not reconciles(icpLedger, pendingApproval, conflict, null));
};
assert (not reconciles(
    icpLedger,
    { pendingApproval with provenance = #index },
    canonicalApproval,
    null,
));

let transferConflicts : [Memory.HistoryTransaction] = [
    { canonicalIcpTransfer with block_index = 401 },
    { canonicalIcpTransfer with operation = #approve },
    { canonicalIcpTransfer with amount = 1_000_001 },
    { canonicalIcpTransfer with fee = ?10_001 },
    { canonicalIcpTransfer with balance_effect = -1_010_001 },
    { canonicalIcpTransfer with from = ?#icp_account_identifier(
        AccountIdentifier.fromPrincipal(otherPrincipal)
    ) },
    { canonicalIcpTransfer with spender = ?#icp_account_identifier(
        AccountIdentifier.fromPrincipal(otherPrincipal)
    ) },
    { canonicalIcpTransfer with provenance = #local_pending },
    { canonicalIcpTransfer with memo = ?Blob.fromArray([7]) },
];
for (conflict in transferConflicts.vals()) {
    assert (not reconciles(icpLedger, pendingIcpTransfer, conflict, null));
};

// ICRC-3 permits a 1xfer block to include the source account as its spender.
// Accept that direct-transfer representation, but never a third-party spender.
let canonicalIcrcTransfer = {
    pendingIcpTransfer with provenance = #index
};
assert (reconciles(ckbtcLedger, pendingIcpTransfer, canonicalIcrcTransfer, null));
assert (reconciles(
    ckbtcLedger,
    pendingIcpTransfer,
    { canonicalIcrcTransfer with spender = canonicalIcrcTransfer.from },
    null,
));
assert (not reconciles(
    ckbtcLedger,
    pendingIcpTransfer,
    { canonicalIcrcTransfer with spender = ?#icrc({
        owner = otherPrincipal;
        subaccount = null;
    }) },
    null,
));

// Canonical self-transfers affect the Wallet by the fee only. Keep released
// local receipts with the old amount-plus-fee effect reconcilable.
let pendingSelfTransfer = {
    pendingIcpTransfer with to = ?walletAddress
};
let canonicalSelfTransfer = {
    canonicalIcpTransfer with
    to = ?#icp_account_identifier(AccountIdentifier.fromPrincipal(walletPrincipal));
    balance_effect = -10_000;
};
assert (reconciles(icpLedger, pendingSelfTransfer, canonicalSelfTransfer, null));
assert (not reconciles(
    icpLedger,
    pendingSelfTransfer,
    { canonicalSelfTransfer with balance_effect = -1_010_000 },
    null,
));

let staleGasQuote = 100;
let canonicalGasAmount = 125;
let pendingGasBurn : Memory.HistoryTransaction = {
    block_index = gasBlockIndex;
    operation = #burn;
    timestamp_ns = 1;
    amount = staleGasQuote;
    fee = null;
    balance_effect = -staleGasQuote;
    from = ?walletAddress;
    to = null;
    spender = null;
    memo = null;
    intent = ?ethereumIntent;
    native = ?gasNative;
    provenance = #local_pending;
    verification = #pending;
};
let relatedAssetBurn : Memory.HistoryTransaction = {
    pendingGasBurn with
    block_index = assetBlockIndex;
    amount = 1_000_000;
    balance_effect = -1_000_000;
    native = ?assetNative;
};
let canonicalGasBurn : Memory.HistoryTransaction = {
    pendingGasBurn with
    amount = canonicalGasAmount;
    balance_effect = -canonicalGasAmount;
    spender = ?minterAddress;
    memo = ?nativeBurnMemo;
    intent = null;
    native = null;
    provenance = #index;
};

// The queried ckETH quote is not sent to withdraw_erc20. The canonical minter
// burn wins even when a refreshed fee is greater than that stale quote.
assert (canonicalGasAmount > staleGasQuote);
assert (reconciles(ckethLedger, pendingGasBurn, canonicalGasBurn, ?relatedAssetBurn));
assert (reconciles(
    ckethLedger,
    { pendingGasBurn with memo = ?nativeBurnMemo },
    canonicalGasBurn,
    ?relatedAssetBurn,
));
assert (not reconciles(
    ckethLedger,
    { pendingGasBurn with memo = ?Blob.fromArray([9]) },
    canonicalGasBurn,
    ?relatedAssetBurn,
));

let exactGasBurn = {
    canonicalGasBurn with
    amount = staleGasQuote;
    balance_effect = -staleGasQuote;
};
assert (not reconciles(ckethLedger, pendingGasBurn, exactGasBurn, null));
assert (reconciles(ckethLedger, pendingGasBurn, exactGasBurn, ?relatedAssetBurn));

let brokenReverseNative = {
    assetNative with related_block_index = ?(gasBlockIndex + 1)
};
let brokenReverseRecord = {
    relatedAssetBurn with native = ?brokenReverseNative
};
assert (not reconciles(ckethLedger, pendingGasBurn, canonicalGasBurn, ?brokenReverseRecord));

let differentIntent = {
    ethereumIntent with destination = "0x2222222222222222222222222222222222222222"
};
let wrongIntentRecord = {
    relatedAssetBurn with intent = ?differentIntent
};
assert (not reconciles(ckethLedger, pendingGasBurn, canonicalGasBurn, ?wrongIntentRecord));
assert (not reconciles(ckerc20Ledger, pendingGasBurn, canonicalGasBurn, ?relatedAssetBurn));

// Native-burn indexes may omit the spender; a reported spender must be the
// catalogued minter.
let canonicalAssetBurn : Memory.HistoryTransaction = {
    relatedAssetBurn with
    spender = ?minterAddress;
    memo = ?nativeBurnMemo;
    intent = null;
    native = null;
    provenance = #index;
};
assert (reconciles(ckerc20Ledger, relatedAssetBurn, canonicalAssetBurn, null));
assert (reconciles(
    ckerc20Ledger,
    { relatedAssetBurn with memo = ?nativeBurnMemo },
    canonicalAssetBurn,
    null,
));
assert (not reconciles(
    ckerc20Ledger,
    { relatedAssetBurn with memo = ?Blob.fromArray([9]) },
    canonicalAssetBurn,
    null,
));
assert (reconciles(
    ckerc20Ledger,
    relatedAssetBurn,
    { canonicalAssetBurn with spender = null },
    null,
));
assert (not reconciles(
    ckerc20Ledger,
    relatedAssetBurn,
    { canonicalAssetBurn with spender = ?walletAddress },
    null,
));

let wrongSpender = {
    canonicalGasBurn with spender = ?walletAddress
};
assert (not reconciles(ckethLedger, pendingGasBurn, wrongSpender, ?relatedAssetBurn));
let wrongFrom = {
    canonicalGasBurn with from = ?#icrc({ owner = otherPrincipal; subaccount = null })
};
assert (not reconciles(ckethLedger, pendingGasBurn, wrongFrom, ?relatedAssetBurn));
let nonNullDestination = {
    canonicalGasBurn with to = ?walletAddress
};
assert (not reconciles(ckethLedger, pendingGasBurn, nonNullDestination, ?relatedAssetBurn));
let nonNullFee = {
    canonicalGasBurn with fee = ?1
};
assert (not reconciles(ckethLedger, pendingGasBurn, nonNullFee, ?relatedAssetBurn));
let zeroAmount = {
    canonicalGasBurn with amount = 0; balance_effect = 0
};
assert (not reconciles(ckethLedger, pendingGasBurn, zeroAmount, ?relatedAssetBurn));
let wrongBalanceEffect = {
    canonicalGasBurn with balance_effect = -(canonicalGasAmount + 1)
};
assert (not reconciles(ckethLedger, pendingGasBurn, wrongBalanceEffect, ?relatedAssetBurn));
assert (not reconciles(
    ckethLedger,
    { pendingGasBurn with balance_effect = -(staleGasQuote + 1) },
    canonicalGasBurn,
    ?relatedAssetBurn,
));

let directCkethBurn = {
    pendingGasBurn with native = ?{
        gasNative with
        related_ledger = null;
        related_block_index = null;
    }
};
assert (not reconciles(ckethLedger, directCkethBurn, canonicalGasBurn, null));

func testLedger(id : Nat, principal : Principal) : Memory.Ledger {
    {
        id;
        principal;
        name = null;
        symbol = null;
        decimals = null;
        fee = null;
        balance = null;
        metadata_updated_at = null;
        balance_updated_at = null;
        metadata_error = null;
        balance_error = null;
        native_address = null;
        native_address_updated_at = null;
        native_address_error = null;
        native_refresh_updated_at = null;
        native_refresh_error = null;
        native_deposit_progress = null;
        logo = null;
        enabled = true;
        history = Store.emptyHistory(#unavailable);
    };
};

func resultOk(result : HistoryTypes.Result<()>) : Bool {
    switch (result) { case (#ok(())) true; case (#err(_)) false };
};

func transactionAt(
    ledger : Memory.Ledger,
    blockIndex : Nat,
) : Memory.HistoryTransaction {
    switch (Map.get(ledger.history.transactions, Nat.compare, blockIndex)) {
        case (?transaction) transaction;
        case null {
            assert false;
            pendingIcpTransfer;
        };
    };
};

let historyMem = Memory.init();
let icpHistoryLedger = testLedger(1, icpLedger);
let ckbtcHistoryLedger = testLedger(2, ckbtcLedger);
let ckerc20HistoryLedger = testLedger(3, ckerc20Ledger);
let ckethHistoryLedger = testLedger(4, ckethLedger);
Map.add(historyMem.ledgers, Principal.compare, icpLedger, icpHistoryLedger);
Map.add(historyMem.ledgers, Principal.compare, ckbtcLedger, ckbtcHistoryLedger);
Map.add(historyMem.ledgers, Principal.compare, ckerc20Ledger, ckerc20HistoryLedger);
Map.add(historyMem.ledgers, Principal.compare, ckethLedger, ckethHistoryLedger);
let historyCalls : Capabilities.BackendCalls = {
    canister_principal = walletPrincipal;
    can_call = func(_canister : Principal, _method : Text) : Bool { false };
    call = func(_request : Capabilities.CallRequest) : async* Capabilities.CallResult {
        #err({ code = "unused"; message = "unused" });
    };
    call_batch = func(
        _requests : [Capabilities.CallRequest]
    ) : async* [Capabilities.CallResult] { [] };
};
let history = Reconcile.Service(historyMem, historyCalls);
let otherAddress : Memory.HistoryAddress = #icrc({
    owner = otherPrincipal;
    subaccount = null;
});
let transferIntent : Memory.TransferIntent = {
    ethereumIntent with
    network = "internet_computer";
    destination = Principal.toText(otherPrincipal);
    native = false;
};
let authoritativeTransfer : Memory.HistoryTransaction = {
    block_index = 800;
    operation = #transfer;
    timestamp_ns = 88;
    amount = 1_000;
    fee = ?10;
    balance_effect = -1_010;
    from = ?walletAddress;
    to = ?otherAddress;
    spender = null;
    memo = ?legacyMemo;
    intent = null;
    native = null;
    provenance = #index;
    verification = #verified;
};

func recordAuthoritativeTransfer(memo : ?Blob) : HistoryTypes.Result<()> {
    history.recordTransfer(
        ckbtcLedger,
        authoritativeTransfer.block_index,
        #transfer,
        authoritativeTransfer.amount,
        authoritativeTransfer.fee,
        ?otherAddress,
        memo,
        ?transferIntent,
        null,
    );
};

// An ICRC local null memo is not a wildcard.
assert (Store.putTransaction(historyMem, ckbtcLedger, authoritativeTransfer));
assert (not resultOk(recordAuthoritativeTransfer(null)));
assert (transactionAt(ckbtcHistoryLedger, 800) == authoritativeTransfer);

// A matching receipt may enrich local intent, but every canonical ledger field
// (including memo and spender) remains authoritative.
assert resultOk(recordAuthoritativeTransfer(?legacyMemo));
let enrichedTransfer = transactionAt(ckbtcHistoryLedger, 800);
assert (enrichedTransfer == {
    authoritativeTransfer with intent = ?transferIntent
});

func expectTransferConflict(conflict : Memory.HistoryTransaction) : () {
    assert (Store.putTransaction(historyMem, ckbtcLedger, conflict));
    assert (not resultOk(recordAuthoritativeTransfer(?legacyMemo)));
    assert (transactionAt(ckbtcHistoryLedger, 800) == conflict);
};
for (conflict in [
    { authoritativeTransfer with operation = #approve },
    { authoritativeTransfer with amount = 1_001 },
    { authoritativeTransfer with from = ?otherAddress },
    { authoritativeTransfer with to = ?walletAddress },
    { authoritativeTransfer with spender = ?otherAddress },
    { authoritativeTransfer with fee = ?11 },
    { authoritativeTransfer with balance_effect = -1_011 },
    { authoritativeTransfer with memo = ?Blob.fromArray([9]) },
].vals()) {
    expectTransferConflict(conflict);
};

let authoritativeSelfTransfer = {
    canonicalSelfTransfer with block_index = 803; verification = #verified
};
assert (Store.putTransaction(historyMem, icpLedger, authoritativeSelfTransfer));
assert resultOk(history.recordTransfer(
    icpLedger,
    803,
    #transfer,
    pendingSelfTransfer.amount,
    pendingSelfTransfer.fee,
    ?walletAddress,
    null,
    null,
    null,
));
assert (transactionAt(icpHistoryLedger, 803) == authoritativeSelfTransfer);

// A duplicate receipt recorded after an upgrade must also accept the released
// local self-transfer effect while keeping every other receipt field exact.
let legacyLocalSelfTransfer = {
    pendingSelfTransfer with block_index = 805
};
func recordLegacySelfTransferDuplicate() : HistoryTypes.Result<()> {
    history.recordTransfer(
        icpLedger,
        805,
        #transfer,
        legacyLocalSelfTransfer.amount,
        legacyLocalSelfTransfer.fee,
        ?walletAddress,
        null,
        null,
        null,
    );
};
assert (Store.putTransaction(historyMem, icpLedger, legacyLocalSelfTransfer));
assert resultOk(recordLegacySelfTransferDuplicate());
assert (transactionAt(icpHistoryLedger, 805) == legacyLocalSelfTransfer);

func expectLegacySelfTransferConflict(
    conflict : Memory.HistoryTransaction,
) : () {
    assert (Store.putTransaction(historyMem, icpLedger, conflict));
    assert (not resultOk(recordLegacySelfTransferDuplicate()));
    assert (transactionAt(icpHistoryLedger, 805) == conflict);
};
for (conflict in [
    { legacyLocalSelfTransfer with operation = #approve },
    { legacyLocalSelfTransfer with amount = legacyLocalSelfTransfer.amount + 1 },
    { legacyLocalSelfTransfer with fee = ?10_001 },
    { legacyLocalSelfTransfer with balance_effect = -1_010_001 },
    { legacyLocalSelfTransfer with from = ?otherAddress },
    { legacyLocalSelfTransfer with to = ?otherAddress },
    { legacyLocalSelfTransfer with spender = ?otherAddress },
    { legacyLocalSelfTransfer with memo = ?Blob.fromArray([9]) },
].vals()) {
    expectLegacySelfTransferConflict(conflict);
};

let authoritativeApproval : Memory.HistoryTransaction = {
    authoritativeTransfer with
    block_index = 801;
    operation = #approve;
    amount = 500;
    fee = ?10;
    balance_effect = -10;
    to = null;
    spender = ?otherAddress;
};
func recordAuthoritativeApproval() : HistoryTypes.Result<()> {
    history.recordApproval(
        ckbtcLedger,
        authoritativeApproval.block_index,
        authoritativeApproval.amount,
        10,
        otherAddress,
        ?legacyMemo,
    );
};
assert (Store.putTransaction(historyMem, ckbtcLedger, authoritativeApproval));
assert resultOk(recordAuthoritativeApproval());
assert (transactionAt(ckbtcHistoryLedger, 801) == authoritativeApproval);

func expectApprovalConflict(conflict : Memory.HistoryTransaction) : () {
    assert (Store.putTransaction(historyMem, ckbtcLedger, conflict));
    assert (not resultOk(recordAuthoritativeApproval()));
    assert (transactionAt(ckbtcHistoryLedger, 801) == conflict);
};
for (conflict in [
    { authoritativeApproval with operation = #transfer },
    { authoritativeApproval with amount = 501 },
    { authoritativeApproval with from = ?otherAddress },
    { authoritativeApproval with to = ?walletAddress },
    { authoritativeApproval with spender = ?walletAddress },
    { authoritativeApproval with fee = ?11 },
    { authoritativeApproval with balance_effect = -11 },
    { authoritativeApproval with memo = ?Blob.fromArray([9]) },
].vals()) {
    expectApprovalConflict(conflict);
};

// The narrow legacy ICP memo exception applies in the collision path too and
// does not replace the index's canonical account-identifier or memo fields.
let authoritativeIcpApproval = {
    canonicalApproval with
    block_index = 802;
    verification = #verified;
};
assert (Store.putTransaction(historyMem, icpLedger, authoritativeIcpApproval));
assert resultOk(history.recordApproval(
    icpLedger,
    802,
    authoritativeIcpApproval.amount,
    10,
    otherAddress,
    null,
));
assert (transactionAt(icpHistoryLedger, 802) == authoritativeIcpApproval);

// Native burns validate the catalog minter but preserve its canonical spender
// while adding Wallet-only intent/native correlation metadata.
assert (Store.putTransaction(historyMem, ckerc20Ledger, canonicalAssetBurn));
assert resultOk(history.recordTransfer(
    ckerc20Ledger,
    assetBlockIndex,
    #burn,
    canonicalAssetBurn.amount,
    null,
    null,
    null,
    ?ethereumIntent,
    ?assetNative,
));
let enrichedBurn = transactionAt(ckerc20HistoryLedger, assetBlockIndex);
assert (enrichedBurn.spender == canonicalAssetBurn.spender);
assert (enrichedBurn.memo == canonicalAssetBurn.memo);
assert (enrichedBurn.intent == ?ethereumIntent);
assert (enrichedBurn.native == ?assetNative);
assert (not resultOk(history.recordTransfer(
    ckerc20Ledger,
    assetBlockIndex,
    #burn,
    canonicalAssetBurn.amount,
    null,
    null,
    null,
    ?ethereumIntent,
    ?{ assetNative with related_block_index = ?(gasBlockIndex + 1) },
)));
assert (transactionAt(ckerc20HistoryLedger, assetBlockIndex) == enrichedBurn);

// The minter also generates the ckETH gas-burn memo. Accept it as unknown to
// Wallet while preserving every authoritative field during collision merge.
assert (Store.putTransaction(historyMem, ckethLedger, canonicalGasBurn));
assert resultOk(history.recordTransfer(
    ckethLedger,
    gasBlockIndex,
    #burn,
    pendingGasBurn.amount,
    null,
    null,
    null,
    ?ethereumIntent,
    ?gasNative,
));
let enrichedGasBurn = transactionAt(ckethHistoryLedger, gasBlockIndex);
assert (enrichedGasBurn.memo == ?nativeBurnMemo);
assert (enrichedGasBurn.spender == canonicalGasBurn.spender);
assert (enrichedGasBurn.amount == canonicalGasBurn.amount);
assert (enrichedGasBurn.intent == ?ethereumIntent);
assert (enrichedGasBurn.native == ?gasNative);

let authoritativeMint : Memory.HistoryTransaction = {
    authoritativeTransfer with
    block_index = 804;
    operation = #mint;
    amount = 75;
    fee = null;
    balance_effect = 75;
    from = null;
    to = ?walletAddress;
    memo = ?legacyMemo;
};
assert (Store.putTransaction(historyMem, ckbtcLedger, authoritativeMint));
history.recordNativeMint(ckbtcLedger, 804, 75, assetNative);
assert (transactionAt(ckbtcHistoryLedger, 804) == {
    authoritativeMint with native = ?assetNative
});
func expectMintConflict(conflict : Memory.HistoryTransaction) : () {
    assert (Store.putTransaction(historyMem, ckbtcLedger, conflict));
    history.recordNativeMint(ckbtcLedger, 804, 75, assetNative);
    assert (transactionAt(ckbtcHistoryLedger, 804) == conflict);
};
for (conflict in [
    { authoritativeMint with operation = #transfer },
    { authoritativeMint with amount = 76 },
    { authoritativeMint with fee = ?1 },
    { authoritativeMint with balance_effect = 74 },
    { authoritativeMint with from = ?otherAddress },
    { authoritativeMint with to = ?otherAddress },
    { authoritativeMint with spender = ?otherAddress },
    { authoritativeMint with native = ?{
        assetNative with related_block_index = ?(gasBlockIndex + 1)
    } },
].vals()) {
    expectMintConflict(conflict);
};

func icrcAccount(owner : Principal, subaccount : ?Blob) : IcrcLedger.Value {
    #Array(switch (subaccount) {
        case null [#Blob(Principal.toBlob(owner))];
        case (?value) [#Blob(Principal.toBlob(owner)), #Blob(value)];
    });
};

func icrcReply(
    logLength : Nat,
    blocks : [IcrcLedger.BlockWithId],
    archived : [IcrcLedger.ArchivedRange],
) : { #ok : Blob; #err : { code : Text; message : Text } } {
    #ok(to_candid ({
        log_length = logLength;
        blocks;
        archived_blocks = archived;
    } : IcrcLedger.GetBlocksReply));
};

let rawTipRequest = IcrcLedger.tipRequest(ckbtcLedger);
assert (rawTipRequest.canister == ckbtcLedger);
assert (rawTipRequest.method == "icrc3_get_blocks");
let decodedTipArgs : ?[IcrcLedger.GetBlocksArg] = from_candid rawTipRequest.args;
assert (decodedTipArgs == ?[{ start = 0; length = 0 }]);
assert (IcrcLedger.decodeTip(icrcReply(44, [], [])) == #ok(44));

let boundedRawPage = IcrcLedger.pageRequest(ckbtcLedger, 10, 4_000);
let decodedPageArgs : ?[IcrcLedger.GetBlocksArg] = from_candid boundedRawPage.args;
assert (decodedPageArgs == ?[{ start = 10; length = IcrcLedger.MAX_PAGE_SIZE }]);

let rawBlocks : [IcrcLedger.BlockWithId] = [
    {
        id = 10;
        block = #Map([
            ("btype", #Text("1mint")),
            ("ts", #Nat(100)),
            ("tx", #Map([
                ("amt", #Nat(75)),
                ("to", icrcAccount(walletPrincipal, ?zeroSubaccount)),
            ])),
        ]);
    },
    {
        id = 11;
        block = #Map([
            ("fee", #Nat(2)),
            ("ts", #Nat(101)),
            ("tx", #Map([
                ("amt", #Nat(50)),
                ("from", icrcAccount(walletPrincipal, null)),
                ("op", #Text("xfer")),
                ("to", icrcAccount(otherPrincipal, null)),
            ])),
        ]);
    },
    {
        id = 12;
        block = #Map([
            ("btype", #Text("1burn")),
            ("ts", #Nat(102)),
            ("tx", #Map([
                ("amt", #Nat(5)),
                ("from", icrcAccount(otherPrincipal, null)),
            ])),
        ]);
    },
];

let rawPage = switch (IcrcLedger.decodePage(
    icrcReply(20, rawBlocks, []),
    walletPrincipal,
    10,
    3,
    13,
)) {
    case (#ok(value)) value;
    case (#err(_)) {
        assert false;
        { log_length = 0; transactions = []; next_start = 0; complete = false };
    };
};
assert (rawPage.log_length == 20);
assert (rawPage.next_start == 13);
assert rawPage.complete;
assert (rawPage.transactions.size() == 2);
let rawMint = rawPage.transactions[0];
assert (rawMint.block_index == 10);
assert (rawMint.operation == #mint);
assert (rawMint.amount == 75);
assert (rawMint.balance_effect == 75);
assert (rawMint.to == ?#icrc({ owner = walletPrincipal; subaccount = null }));
assert (rawMint.provenance == #ledger);
let rawTransfer = rawPage.transactions[1];
assert (rawTransfer.block_index == 11);
assert (rawTransfer.operation == #transfer);
assert (rawTransfer.fee == ?2);
assert (rawTransfer.balance_effect == -52);
assert (rawTransfer.provenance == #ledger);

let partialRawPage = switch (IcrcLedger.decodePage(
    icrcReply(20, [rawBlocks[0], rawBlocks[1]], []),
    walletPrincipal,
    10,
    3,
    13,
)) {
    case (#ok(value)) value;
    case (#err(_)) {
        assert false;
        { log_length = 0; transactions = []; next_start = 0; complete = true };
    };
};
assert (partialRawPage.next_start == 12);
assert (not partialRawPage.complete);

let remainingOperationBlocks : [IcrcLedger.BlockWithId] = [
    {
        id = 30;
        block = #Map([
            ("btype", #Text("1burn")),
            ("ts", #Nat(200)),
            ("tx", #Map([
                ("amt", #Nat(20)),
                ("fee", #Nat(3)),
                ("from", icrcAccount(walletPrincipal, null)),
            ])),
        ]);
    },
    {
        id = 31;
        block = #Map([
            ("btype", #Text("2approve")),
            ("fee", #Nat(4)),
            ("ts", #Nat(201)),
            ("tx", #Map([
                ("amt", #Nat(999)),
                ("from", icrcAccount(walletPrincipal, null)),
                ("spender", icrcAccount(otherPrincipal, null)),
            ])),
        ]);
    },
    {
        id = 32;
        block = #Map([
            ("btype", #Text("2xfer")),
            ("fee", #Nat(1)),
            ("ts", #Nat(202)),
            ("tx", #Map([
                ("amt", #Nat(9)),
                ("from", icrcAccount(otherPrincipal, null)),
                ("spender", icrcAccount(otherPrincipal, null)),
                ("to", icrcAccount(walletPrincipal, null)),
            ])),
        ]);
    },
];
let remainingOperations = switch (IcrcLedger.decodePage(
    icrcReply(33, remainingOperationBlocks, []),
    walletPrincipal,
    30,
    3,
    33,
)) {
    case (#ok(value)) value.transactions;
    case (#err(_)) {
        assert false;
        [];
    };
};
assert (remainingOperations.size() == 3);
assert (remainingOperations[0].operation == #burn);
assert (remainingOperations[0].fee == ?3);
assert (remainingOperations[0].balance_effect == -23);
assert (remainingOperations[1].operation == #approve);
assert (remainingOperations[1].fee == ?4);
assert (remainingOperations[1].balance_effect == -4);
assert (remainingOperations[2].operation == #transfer);
assert (remainingOperations[2].balance_effect == 9);

assert (switch (IcrcLedger.decodePage(
    icrcReply(20, [], [{ args = [{ start = 10; length = 2 }] }]),
    walletPrincipal,
    10,
    2,
    12,
)) {
    case (#err(_)) true;
    case (#ok(_)) false;
});

let unknownWalletBlock : IcrcLedger.BlockWithId = {
    id = 10;
    block = #Map([
        ("btype", #Text("99unknown")),
        ("ts", #Nat(100)),
        ("tx", #Map([
            ("amt", #Nat(1)),
            ("from", icrcAccount(walletPrincipal, null)),
        ])),
    ]);
};
assert (switch (IcrcLedger.decodePage(
    icrcReply(11, [unknownWalletBlock], []),
    walletPrincipal,
    10,
    1,
    11,
)) {
    case (#err(_)) true;
    case (#ok(_)) false;
});

// A valid extension block has an extension-defined schema, so it must be
// rejected by btype before Wallet assumes the presence of ICRC-1/2 tx fields.
let unrelatedExtensionBlock : IcrcLedger.BlockWithId = {
    id = 10;
    block = #Map([
        ("btype", #Text("99extension")),
        ("ts", #Nat(100)),
        ("99payload", #Map([("message", #Text("unrelated"))])),
    ]);
};
assert (switch (IcrcLedger.decodePage(
    icrcReply(11, [unrelatedExtensionBlock], []),
    walletPrincipal,
    10,
    1,
    11,
)) {
    case (#err(error)) error == "Unsupported ICRC-3 block type: 99extension";
    case (#ok(_)) false;
});

var tooDeep : IcrcLedger.Value = #Nat(0);
var depth = 0;
while (depth < 12) {
    tooDeep := #Array([tooDeep]);
    depth += 1;
};
assert (switch (IcrcLedger.decodePage(
    icrcReply(11, [{ id = 10; block = tooDeep }], []),
    walletPrincipal,
    10,
    1,
    11,
)) {
    case (#err(_)) true;
    case (#ok(_)) false;
});

let gateCheckpoint : Memory.HistoryCheckpoint = {
    tip_exclusive = 40;
    balance = 25;
    checked_at = 0;
};
assert (not Reconcile.balanceNeedsHistory(null, ?gateCheckpoint, 25));
assert (Reconcile.balanceNeedsHistory(null, ?gateCheckpoint, 26));
assert (Reconcile.balanceNeedsHistory(null, null, 25));
let stagedScan : Memory.HistoryScan = {
    index = ckbtcLedger;
    from_tip_exclusive = 40;
    target_tip_exclusive = 41;
    previous_balance = 25;
    target_balance = 26;
    cursor = ?41;
    candidates = Map.empty<Nat, Memory.HistoryTransaction>();
    unsupported_block_ids = [];
    page_count = 0;
    started_at = 0;
    config_epoch = 0;
};
assert (Reconcile.balanceNeedsHistory(?stagedScan, ?gateCheckpoint, 25));

switch (Reconcile.historyRoute(ckbtcLedger)) {
    case (#index(route)) {
        assert (route.principal == Principal.fromText("n5wcd-faaaa-aaaar-qaaea-cai"));
        assert (route.kind == #icrc);
    };
    case (_) assert false;
};
switch (Reconcile.historyRoute(Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai"))) {
    case (#icrc3_ledger) {};
    case (_) assert false;
};
assert (Reconcile.exactBalanceDelta(100, 150, 50));
assert (Reconcile.exactBalanceDelta(150, 100, -50));
assert (not Reconcile.exactBalanceDelta(100, 150, 49));
