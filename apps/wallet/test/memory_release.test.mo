import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Order "mo:core/Order";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import HistoryStore "../backend/history/Store";
import Memory "../backend/memory/wallet/v1";
import CommandMemory "../backend/memory/wallet_commands/v1";
import BridgeMemory "../backend/memory/wallet_bridge/v1";
import ReplacementMemory "../backend/memory/wallet_bridge_replacements/v1";
import TransferMemory "../backend/memory/wallet_transfers/v1";
import BridgeJournal "../backend/bridge/Journal";
import TransferJournal "../backend/transfers/Journal";
import BridgeCapabilities "../backend/capabilities/Types";

// Fresh installs use the released v1 defaults.
let fresh = Memory.init();
assert (fresh.next_id == 1);
assert (Map.size(fresh.ledgers) == 0);
assert (Map.size(fresh.activity_order) == 0);
assert (fresh.metadata_epoch == 0);
assert (fresh.balance_epoch == 0);
assert (fresh.native_epoch == 0);
assert not fresh.configured;

// The independent command journal starts empty without rewriting Wallet v1.
let freshCommands = CommandMemory.init();
assert (Map.size(freshCommands.commands) == 0);

func compareCommandKeys(
    left : CommandMemory.CommandKey,
    right : CommandMemory.CommandKey,
) : Order.Order {
    switch (Text.compare(left.caller_app_id, right.caller_app_id)) {
        case (#equal) Blob.compare(left.request_id, right.request_id);
        case (order) order;
    };
};

let commandKey : CommandMemory.CommandKey = {
    caller_app_id = "swap";
    request_id = Blob.fromArray(Array.repeat<Nat8>(0x2a, 16));
};
let spender : CommandMemory.Account = {
    owner = Principal.fromText("aaaaa-aa");
    subaccount = ?Blob.fromArray(Array.repeat<Nat8>(1, 32));
};
let preparedCommand : CommandMemory.Command = {
    caller = {
        endpoint = "app:swap:tile";
        app_id = "swap";
        role = ?"tile";
        agent_mode = false;
    };
    ledger = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
    operation = #approve({
        spender;
        amount = 1_000_000;
        expected_allowance = 0;
        expected_expires_at = null;
        expires_at = 20_000;
    });
    intent = Blob.fromArray([0x44, 0x49, 0x44, 0x4c]);
    prepared_at = 10_000;
    valid_until = 15_000;
    retain_until = 30_000;
    review = {
        token_name = ?"Internet Computer";
        token_symbol = "ICP";
        decimals = 8;
        fee = 10_000;
        transfer_fee = ?10_000;
        current_allowance = ?0;
        current_expires_at = null;
        allowance = ?1_010_000;
        total_debit = 1_020_000;
        expires_at = ?20_000;
    };
    var call_args : ?Blob = null;
    var updated_at : Int = 10_000;
    var status : CommandMemory.Status = #prepared;
};
Map.add(
    freshCommands.commands,
    compareCommandKeys,
    commandKey,
    preparedCommand,
);
assert (Map.size(freshCommands.commands) == 1);

let storedCommand = switch (Map.get(
    freshCommands.commands,
    compareCommandKeys,
    commandKey,
)) {
    case (?value) value;
    case null Runtime.trap("Prepared command was not stored");
};
assert (storedCommand.status == #prepared);
let exactArgs = Blob.fromArray([0x44, 0x49, 0x44, 0x4c, 0x00]);
storedCommand.call_args := ?exactArgs;
storedCommand.updated_at := 10_100;
storedCommand.status := #pending({
    attempts = 1;
    started_at = 10_100;
    last_error = null;
});
// A dispatched command keeps its exact arguments in pending state; passing the
// preparation deadline must not turn an unknown ledger outcome into rejection.
assert (storedCommand.call_args == ?exactArgs);
switch (storedCommand.status) {
    case (#pending(value)) assert (value.attempts == 1);
    case (_) assert false;
};
// A ledger call may settle after valid_until. Its retained terminal receipt is
// still the idempotent replay result rather than an expiry error.
storedCommand.updated_at := 20_000;
storedCommand.status := #succeeded({
    block_index = ?99;
    duplicate = true;
    completed_at = 20_000;
});
switch (storedCommand.status) {
    case (#succeeded(receipt)) {
        assert (receipt.block_index == ?99 and receipt.duplicate);
    };
    case (_) assert false;
};

// All executable/revocable methods are closed variants. A definite rejection
// is likewise a retained terminal result that replays after valid_until.
let closedOperations : [CommandMemory.Operation] = [
    #transfer({ to = spender; amount = 50; memo = null }),
    #approve({
        spender;
        amount = 50;
        expected_allowance = 0;
        expected_expires_at = null;
        expires_at = 20_000;
    }),
    #revoke({
        spender = #icrc(spender);
        expected_allowance = 50;
        expected_expires_at = ?20_000;
    }),
    #revoke({
        spender = #icp_account_identifier(
            Blob.fromArray(Array.repeat<Nat8>(4, 32))
        );
        expected_allowance = 50;
        expected_expires_at = null;
    }),
];
assert (closedOperations.size() == 4);
let rejected : CommandMemory.Status = #rejected({
    code = "allowance_changed";
    message = "Allowance changed before dispatch";
    at = 20_100;
});
switch (rejected) {
    case (#rejected(error)) assert (error.code == "allowance_changed");
    case (_) assert false;
};

// Wallet 0.3.2 already runs v1. The archive transition test proves later
// production releases keep that root, so retain both root counters and a
// representative nested ledger/history record.
let ledgerPrincipal = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
let ledger : Memory.Ledger = {
    id = 7;
    principal = ledgerPrincipal;
    name = ?"Internet Computer";
    symbol = ?"ICP";
    decimals = ?8;
    fee = ?10_000;
    logo = null;
    balance = ?123_456_789;
    metadata_updated_at = ?100;
    balance_updated_at = ?200;
    metadata_error = null;
    balance_error = null;
    native_address = null;
    native_address_updated_at = null;
    native_address_error = null;
    native_refresh_updated_at = null;
    native_refresh_error = null;
    native_deposit_progress = null;
    enabled = true;
    history = HistoryStore.emptyHistory(#unavailable);
};
fresh.next_id := 8;
fresh.metadata_epoch := 11;
fresh.balance_epoch := 12;
fresh.native_epoch := 13;
fresh.configured := true;
Map.add(fresh.ledgers, Principal.compare, ledgerPrincipal, ledger);

let restored : Memory.Mem = fresh;
assert (restored.next_id == 8);
assert (restored.metadata_epoch == 11);
assert (restored.balance_epoch == 12);
assert (restored.native_epoch == 13);
assert restored.configured;
switch (Map.get(restored.ledgers, Principal.compare, ledgerPrincipal)) {
    case (?retained) {
        assert (retained.id == 7 and retained.symbol == ?"ICP");
        assert (retained.balance == ?123_456_789 and retained.enabled);
        assert (retained.history.state == #idle);
    };
    case null assert false;
};

// The EVM integration adds independent roots. Neither initializer mutates the
// previously released wallet or wallet_commands data above.
let freshBridges = BridgeMemory.init();
let freshTransfers = TransferMemory.init();
let freshReplacements = ReplacementMemory.init();
assert (Map.size(freshBridges.intents) == 0);
assert (Map.size(freshTransfers.commands) == 0);
assert (Map.size(freshReplacements.replacements) == 0);
assert (restored.next_id == 8 and restored.configured);
assert (Map.size(freshCommands.commands) == 1);

let bridgeId = Blob.fromArray(Array.repeat<Nat8>(0x31, 16));
let evmBridgeId = Blob.fromArray(Array.repeat<Nat8>(0x32, 16));
let ckUsdcLedger = Principal.fromText("xevnm-gaaaa-aaaar-qafnq-cai");
let ckEthLedger = Principal.fromText("ss2fx-dyaaa-aaaar-qacoq-cai");
let ckEthMinter = Principal.fromText("sv3dd-oaaaa-aaaar-qacoa-cai");
let ethereumHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
let resetHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
let approvalHash = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
let evmApprovalHash = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
let bridgeIntent : BridgeMemory.Intent = {
    id = bridgeId;
    quote = {
        chain_id = 1;
        ledger = ckUsdcLedger;
        minter = ckEthMinter;
        helper_address = "0x1111111111111111111111111111111111111111";
        helper_mode = #subaccount;
        minter_address = "0x2222222222222222222222222222222222222222";
        token_address = ?"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
        recipient = Principal.fromText("aaaaa-aa");
        principal_word = "0x0000000000000000000000000000000000000000000000000000000000000000";
        subaccount_word = "0x0000000000000000000000000000000000000000000000000000000000000000";
    };
    source = #external;
    account = "0x3333333333333333333333333333333333333333";
    amount = 123_456;
    subaccount = null;
    steps = [
        { kind = #reset_approval; state = #confirmed; operation_id = null; transaction_hash = ?resetHash; error = null },
        { kind = #approval; state = #confirmed; operation_id = null; transaction_hash = ?approvalHash; error = null },
        { kind = #deposit; state = #unknown; operation_id = null; transaction_hash = null; error = ?"Browser disconnected before returning the deposit hash" },
    ];
    revision = 7;
    created_at = 10_000;
    updated_at = 10_100;
    event_cursor = 1_234;
    accepted_deposit = null;
    mint = null;
    error = null;
};
Map.add(freshBridges.intents, Blob.compare, bridgeId, bridgeIntent);
let evmIntent : BridgeMemory.Intent = {
    bridgeIntent with
    id = evmBridgeId;
    source = #evm_agent({ app_id = "agent"; installation_uid = "original-agent-installation" });
    steps = [
        { kind = #reset_approval; state = #ready; operation_id = null; transaction_hash = null; error = null },
        { kind = #approval; state = #confirmed; operation_id = ?"retained-approval-id"; transaction_hash = ?evmApprovalHash; error = null },
        { kind = #deposit; state = #confirmed; operation_id = ?"retained-deposit-id"; transaction_hash = ?ethereumHash; error = null },
    ];
    revision = 11;
    event_cursor = 1_240;
    accepted_deposit = ?{ log_index = 4; block_number = 19_000_000; event_index = 1_236 };
    mint = ?{ ledger_block_index = 8_765; event_index = 1_239; verified_ledger = false };
    error = ?"Index has not yet returned the exact mint block";
};
Map.add(freshBridges.intents, Blob.compare, evmBridgeId, evmIntent);

let noCalls : BridgeCapabilities.BackendCalls = {
    canister_principal = Principal.fromText("aaaaa-aa");
    can_call = func(_ : Principal, _ : Text) : Bool { false };
    call = func(_ : BridgeCapabilities.CallRequest) : async* BridgeCapabilities.CallResult { Runtime.trap("Restoring a memory root must not make a backend call") };
    call_batch = func(_ : [BridgeCapabilities.CallRequest]) : async* [BridgeCapabilities.CallResult] { Runtime.trap("Restoring a memory root must not make a backend batch call") };
};
let retainedBridges : BridgeMemory.Mem = freshBridges;
// Released bridge hashes remain the original effect identity. The independent
// sidecar retains the proven replacement chain without rewriting that schema.
let replacementHash = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
let replacementTip = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
let retainedAncestry : [ReplacementMemory.Entry] = [
    { step = #deposit; original_transaction_hash = ethereumHash; previous_transaction_hash = ethereumHash; transaction_hash = replacementHash; recorded_at = 10_200 },
    { step = #deposit; original_transaction_hash = ethereumHash; previous_transaction_hash = replacementHash; transaction_hash = replacementTip; recorded_at = 10_300 },
];
Map.add(freshReplacements.replacements, Blob.compare, evmBridgeId, retainedAncestry);
let retainedReplacementRoot : ReplacementMemory.Mem = freshReplacements;
let restoredBridgeService = BridgeJournal.ServiceWithReplacements(retainedBridges, retainedReplacementRoot, noCalls);
assert (Map.size(retainedReplacementRoot.replacements) == 1);
assert (Map.get(retainedReplacementRoot.replacements, Blob.compare, evmBridgeId) == ?retainedAncestry);
assert (restoredBridgeService.effectiveHash(evmBridgeId, #deposit) == ?replacementTip);
assert (restoredBridgeService.effectiveHash(evmBridgeId, #approval) == ?evmApprovalHash);
assert (restoredBridgeService.effectiveHash(bridgeId, #deposit) == null);
switch (restoredBridgeService.status(bridgeId)) {
    case (#ok(intent)) {
        assert (intent == bridgeIntent);
        assert (intent.steps[0].state == #confirmed and intent.steps[1].state == #confirmed);
        assert (intent.steps[2].state == #unknown and intent.steps[2].transaction_hash == null);
        assert (intent.event_cursor == 1_234 and intent.revision == 7);
    };
    case (#err(_)) assert false;
};
switch (restoredBridgeService.status(evmBridgeId)) {
    case (#ok(intent)) {
        assert (intent == evmIntent);
        assert (intent.steps[2].operation_id == ?"retained-deposit-id");
        assert (intent.source == #evm_agent({ app_id = "agent"; installation_uid = "original-agent-installation" }));
        assert (intent.mint == ?{ ledger_block_index = 8_765; event_index = 1_239; verified_ledger = false });
    };
    case (#err(_)) assert false;
};
assert (restoredBridgeService.list({ ledger = null; after = null; limit = 10 }).records.size() == 2);
// The service keeps the restored root, not an initialized replacement or copy.
Map.add(retainedBridges.intents, Blob.compare, bridgeId, { bridgeIntent with revision = 8 });
switch (restoredBridgeService.status(bridgeId)) {
    case (#ok(intent)) assert (intent.revision == 8);
    case (#err(_)) assert false;
};
assert (Map.size(freshBridges.intents) == 2);

// Superseded and current hashes still belong to the original intent after
// restoration. Another saved unknown external intent cannot claim any of them.
for (claimedHash in [ethereumHash, replacementHash, replacementTip].vals()) {
    switch (restoredBridgeService.recordStep({ id = bridgeId; revision = 8; step = #deposit; state = #confirmed; transaction_hash = ?claimedHash; error = null })) {
        case (#err(error)) assert (Text.contains(error, #text("already recorded")));
        case (#ok(_)) assert false;
    };
};
// The instantiated service reads the retained sidecar itself. A fresh root or
// a copied snapshot would miss this later proven edge.
let newestReplacement = "0x1212121212121212121212121212121212121212121212121212121212121212";
let newestEntry : ReplacementMemory.Entry = {
    step = #deposit; original_transaction_hash = ethereumHash;
    previous_transaction_hash = replacementTip; transaction_hash = newestReplacement;
    recorded_at = 10_400;
};
Map.add(retainedReplacementRoot.replacements, Blob.compare, evmBridgeId, Array.concat(retainedAncestry, [newestEntry]));
assert (restoredBridgeService.effectiveHash(evmBridgeId, #deposit) == ?newestReplacement);
assert (Map.get(freshReplacements.replacements, Blob.compare, evmBridgeId) == ?Array.concat(retainedAncestry, [newestEntry]));
assert (Map.size(ReplacementMemory.init().replacements) == 0);
assert (Map.size(retainedReplacementRoot.replacements) == 1);

// Preserve each completed approval and the exact arguments of an ambiguous
// minter call, including a separately tracked origin-network settlement state.
let withdrawalId = Blob.fromArray(Array.repeat<Nat8>(0x41, 16));
let exactApprovalArgs = Blob.fromArray([0x44, 0x49, 0x44, 0x4c, 0x01, 0x2a]);
let exactWithdrawalArgs = Blob.fromArray([0x44, 0x49, 0x44, 0x4c, 0x02, 0x2b]);
let approvalReply = Blob.fromArray([0x44, 0x49, 0x44, 0x4c, 0x03, 0x2c]);
let withdrawal : TransferMemory.Command = {
    request_id = withdrawalId;
    intent = Blob.fromArray([0x10, 0x20, 0x30]);
    resolved = Blob.fromArray([0x40, 0x50, 0x60]);
    created_at = 10_000;
    ledger = ckUsdcLedger;
    native = true;
    minter = ?ckEthMinter;
    allowance_ledgers = [ckUsdcLedger, ckEthLedger];
    var updated_at = 10_300;
    var status = #pending;
    var acknowledged = false;
    var last_error = ?"Minter reply lost after approval completed";
    var settlement = ?{ checked_at = 10_300; status = #unknown("Origin-network payment is unresolved") };
    var calls = [
        { canister = ckUsdcLedger; method = "icrc2_approve"; args = exactApprovalArgs; cycles = 0; var outcome = #reply(approvalReply) },
        { canister = ckEthMinter; method = "withdraw_erc20"; args = exactWithdrawalArgs; cycles = 0; var outcome = #unknown("Reply lost") },
    ];
};
Map.add(freshTransfers.commands, Blob.compare, withdrawalId, withdrawal);
let retainedTransfers : TransferMemory.Mem = freshTransfers;
let retainedWithdrawal = switch (Map.get(retainedTransfers.commands, Blob.compare, withdrawalId)) {
    case (?command) command;
    case null Runtime.trap("Pending withdrawal was lost during restoration");
};
assert (retainedWithdrawal.request_id == withdrawalId and retainedWithdrawal.created_at == 10_000);
assert (retainedWithdrawal.intent == Blob.fromArray([0x10, 0x20, 0x30]));
assert (retainedWithdrawal.resolved == Blob.fromArray([0x40, 0x50, 0x60]));
assert (retainedWithdrawal.status == #pending);
assert not retainedWithdrawal.acknowledged;
assert (retainedWithdrawal.allowance_ledgers == [ckUsdcLedger, ckEthLedger]);
assert (retainedWithdrawal.calls[0].args == exactApprovalArgs and retainedWithdrawal.calls[0].outcome == #reply(approvalReply));
assert (retainedWithdrawal.calls[1].args == exactWithdrawalArgs and retainedWithdrawal.calls[1].outcome == #unknown("Reply lost"));
assert (retainedWithdrawal.settlement == ?{ checked_at = 10_300; status = #unknown("Origin-network payment is unresolved") });
assert TransferJournal.hasUnresolved(retainedWithdrawal);
assert TransferJournal.minterDispatched(retainedWithdrawal);
let restoredReplay = TransferJournal.Replay(retainedWithdrawal, noCalls);
assert restoredReplay.dispatched();
// Changes through the restored reference still update the original root.
retainedWithdrawal.settlement := ?{ checked_at = 10_400; status = #submitted({ transaction_hash = ethereumHash; message = "Awaiting Ethereum confirmation" }) };
assert (withdrawal.settlement == retainedWithdrawal.settlement);
retainedWithdrawal.acknowledged := true;
assert withdrawal.acknowledged;
assert (Map.size(freshTransfers.commands) == 1);
assert (restored.next_id == 8 and Map.size(freshCommands.commands) == 1);

// Fresh funding timestamps remain unique across app reinitialization without
// changing released command schemas or business memos.
let allocatorMemory = TransferMemory.init();
assert allocatorMemory.last_funding_created_at == 0;
allocatorMemory.last_funding_created_at := 1_800_000_000_000_000_012;
let restoredAllocator : TransferMemory.Mem = allocatorMemory;
assert restoredAllocator.last_funding_created_at == 1_800_000_000_000_000_012;
restoredAllocator.last_funding_created_at += 1;
assert allocatorMemory.last_funding_created_at == 1_800_000_000_000_000_013;
