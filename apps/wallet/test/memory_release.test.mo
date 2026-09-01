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
