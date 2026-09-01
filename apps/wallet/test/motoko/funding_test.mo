import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Char "mo:core/Char";
import Map "mo:core/Map";
import Nat8 "mo:core/Nat8";
import Order "mo:core/Order";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import FundingDisplay "../../backend/funding/Display";
import FundingJournal "../../backend/funding/Journal";
import Icrc "../../backend/icrc1/Client";
import CommandMemory "../../backend/memory/wallet_commands/v1";

let ledger = Principal.fromText("mxzaz-hqaaa-aaaar-qaada-cai");
let otherLedger = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
let spender = Blob.fromArray(Array.tabulate<Nat8>(32, func(index) {
    if (index == 31) 1 else 0;
}));
let otherSpender = Blob.fromArray(Array.tabulate<Nat8>(32, func(index) {
    if (index == 31) 2 else 0;
}));

func key(appId : Text, byte : Nat8) : CommandMemory.CommandKey {
    {
        caller_app_id = appId;
        request_id = Blob.fromArray(Array.tabulate<Nat8>(16, func(_) { byte }));
    };
};

func compareKey(
    left : CommandMemory.CommandKey,
    right : CommandMemory.CommandKey,
) : Order.Order {
    switch (Text.compare(left.caller_app_id, right.caller_app_id)) {
        case (#equal) Blob.compare(left.request_id, right.request_id);
        case (order) order;
    };
};

func command(
    appId : Text,
    targetLedger : Principal,
    targetSpender : Blob,
    expectedAllowance : Nat,
    expectedExpiresAt : ?Nat64,
    status : CommandMemory.Status,
) : CommandMemory.Command {
    let callArgs : ?Blob = switch (status) {
        case (#prepared) null;
        case (_) ?Blob.fromArray([1]);
    };
    {
        caller = {
            endpoint = "swap";
            app_id = appId;
            role = null;
            agent_mode = false;
        };
        ledger = targetLedger;
        operation = #revoke({
            spender = #icp_account_identifier(targetSpender);
            expected_allowance = expectedAllowance;
            expected_expires_at = expectedExpiresAt;
        });
        intent = Blob.fromArray([]);
        prepared_at = 0;
        valid_until = 1_000;
        retain_until = 2_000;
        review = {
            token_name = ?"Internet Computer";
            token_symbol = "ICP";
            decimals = 8;
            fee = 10_000;
            transfer_fee = null;
            current_allowance = ?expectedAllowance;
            current_expires_at = expectedExpiresAt;
            allowance = ?0;
            total_debit = 10_000;
            expires_at = null;
        };
        var call_args : ?Blob = callArgs;
        var updated_at : Int = 0;
        var status : CommandMemory.Status = status;
    };
};

func caller(appId : Text) : CommandMemory.Caller {
    {
        endpoint = "swap";
        app_id = appId;
        role = null;
        agent_mode = false;
    };
};

let commands = Map.empty<CommandMemory.CommandKey, CommandMemory.Command>();
let pendingKey = key("swap", 1);
Map.add(
    commands,
    compareKey,
    pendingKey,
    command("swap", ledger, spender, 500, ?900, #pending({
        attempts = 1;
        started_at = 0;
        last_error = null;
    })),
);
Map.add(
    commands,
    compareKey,
    key("swap", 2),
    command("swap", otherLedger, spender, 500, ?900, #prepared),
);
Map.add(
    commands,
    compareKey,
    key("swap", 3),
    command("swap", otherLedger, spender, 500, ?900, #succeeded({
        block_index = ?1;
        duplicate = false;
        completed_at = 0;
    })),
);
Map.add(
    commands,
    compareKey,
    key("other", 4),
    command("other", otherLedger, spender, 500, ?900, #prepared),
);

// Per-caller quota counts every unresolved command, not retained terminals.
assert (FundingJournal.activeCommandCount(commands, "swap") == 2);
assert (FundingJournal.activeCommandCount(commands, "other") == 1);

// Capacity cleanup must retain terminal request IDs through retain_until so a
// retry replays its result instead of becoming a second value-moving command.
let retainedTerminals = Map.empty<CommandMemory.CommandKey, CommandMemory.Command>();
let retainedSuccessKey = key("swap", 7);
let retainedRejectedKey = key("swap", 8);
Map.add(
    retainedTerminals,
    compareKey,
    retainedSuccessKey,
    command("swap", ledger, spender, 500, ?900, #succeeded({
        block_index = ?1;
        duplicate = false;
        completed_at = 0;
    })),
);
Map.add(
    retainedTerminals,
    compareKey,
    retainedRejectedKey,
    command("swap", ledger, spender, 500, ?900, #rejected({
        code = "owner_rejected";
        message = "rejected";
        at = 0;
    })),
);
assert (
    FundingJournal.pruneExpiredCommands(
        retainedTerminals,
        compareKey,
        1_001,
        64,
    ) == 0
);
switch (Map.get(retainedTerminals, compareKey, retainedSuccessKey)) {
    case (?command) switch (command.status) {
        case (#succeeded(_)) {};
        case (_) assert false;
    };
    case null assert false;
};
switch (Map.get(retainedTerminals, compareKey, retainedRejectedKey)) {
    case (?command) switch (command.status) {
        case (#rejected(_)) {};
        case (_) assert false;
    };
    case null assert false;
};
assert (
    FundingJournal.pruneExpiredCommands(
        retainedTerminals,
        compareKey,
        2_000,
        64,
    ) == 2
);
assert (Map.size(retainedTerminals) == 0);

// An owner acceptance while another Wallet call is active is still journaled
// as pending. The same request can later dispatch without becoming reviewable
// or rejectable again.
let acceptedWhileBusy = command("swap", ledger, spender, 500, ?900, #prepared);
switch (FundingJournal.acceptForExecution(acceptedWhileBusy, true, 1_100)) {
    case (#waiting) {};
    case (#dispatch) assert false;
};
switch (acceptedWhileBusy.status) {
    case (#pending(value)) {
        assert (value.attempts == 1);
        assert (value.started_at == 1_100);
    };
    case (_) assert false;
};
switch (FundingJournal.acceptForExecution(acceptedWhileBusy, false, 1_200)) {
    case (#dispatch) {};
    case (#waiting) assert false;
};
switch (acceptedWhileBusy.status) {
    case (#pending(value)) {
        assert (value.attempts == 2);
        assert (value.started_at == 1_100);
    };
    case (_) assert false;
};

// A fresh request ID with the exact original facts resumes the durable pending
// legacy removal rather than admitting another fee-bearing remove_approval.
switch (FundingJournal.activeIcpRevoke(
    commands,
    caller("swap"),
    ledger,
    spender,
    500,
    ?900,
    500,
)) {
    case (#resume(value)) assert (value.key == pendingKey);
    case (_) assert false;
};

// A recreated/changed allowance and another app remain fenced by the same
// unresolved ledger+spender removal; neither can obtain a fresh command.
switch (FundingJournal.activeIcpRevoke(
    commands,
    caller("swap"),
    ledger,
    spender,
    501,
    ?901,
    500,
)) {
    case (#blocked) {};
    case (_) assert false;
};
switch (FundingJournal.activeIcpRevoke(
    commands,
    caller("other"),
    ledger,
    spender,
    500,
    ?900,
    500,
)) {
    case (#blocked) {};
    case (_) assert false;
};
switch (FundingJournal.activeIcpRevoke(
    commands,
    caller("swap"),
    ledger,
    otherSpender,
    500,
    ?900,
    500,
)) {
    case (#none) {};
    case (_) assert false;
};

// A prepared legacy revoke already owns the ledger+spender admission slot.
// A concurrent fresh ID resumes it after its preparation await, while changed
// facts stay blocked and an expired never-dispatched command no longer fences.
let preparedCommands = Map.empty<CommandMemory.CommandKey, CommandMemory.Command>();
let preparedKey = key("swap", 5);
Map.add(
    preparedCommands,
    compareKey,
    preparedKey,
    command("swap", ledger, spender, 500, ?900, #prepared),
);
switch (FundingJournal.activeIcpRevoke(
    preparedCommands,
    caller("swap"),
    ledger,
    spender,
    500,
    ?900,
    500,
)) {
    case (#resume(value)) assert (value.key == preparedKey);
    case (_) assert false;
};
switch (FundingJournal.activeIcpRevoke(
    preparedCommands,
    caller("swap"),
    ledger,
    spender,
    501,
    ?900,
    500,
)) {
    case (#blocked) {};
    case (_) assert false;
};
switch (FundingJournal.activeIcpRevoke(
    preparedCommands,
    caller("swap"),
    ledger,
    spender,
    500,
    ?900,
    1_001,
)) {
    case (#none) {};
    case (_) assert false;
};

func pendingCommands() : Map.Map<CommandMemory.CommandKey, CommandMemory.Command> {
    let values = Map.empty<CommandMemory.CommandKey, CommandMemory.Command>();
    Map.add(
        values,
        compareKey,
        key("swap", 6),
        command("swap", ledger, spender, 500, ?900, #pending({
            attempts = 1;
            started_at = 0;
            last_error = null;
        })),
    );
    values;
};

// A complete empty first page proves the frozen pending removal succeeded.
let emptyScanCommands = pendingCommands();
let emptyScanCandidates = FundingJournal.snapshotPendingIcpRevokes(
    emptyScanCommands,
    ledger,
);
assert (emptyScanCandidates.size() == 1);
assert (FundingJournal.reconcileIcpCompleteScan(
    emptyScanCandidates,
    ledger,
    700,
) == 1);
assert (FundingJournal.activeCommandCount(emptyScanCommands, "swap") == 0);

// Seeing the spender anywhere in a complete scan keeps the unknown command
// pending. Seeing only another spender before the final empty follow-up proves
// the removed-last case and safely completes it.
let presentCommands = pendingCommands();
let presentCandidates = FundingJournal.snapshotPendingIcpRevokes(
    presentCommands,
    ledger,
);
FundingJournal.noteIcpSpender(presentCandidates, spender);
assert (FundingJournal.reconcileIcpCompleteScan(
    presentCandidates,
    ledger,
    701,
) == 0);
assert (FundingJournal.activeCommandCount(presentCommands, "swap") == 1);

let removedLastCommands = pendingCommands();
let removedLastCandidates = FundingJournal.snapshotPendingIcpRevokes(
    removedLastCommands,
    ledger,
);
FundingJournal.noteIcpSpender(removedLastCandidates, otherSpender);
assert (FundingJournal.reconcileIcpCompleteScan(
    removedLastCandidates,
    ledger,
    702,
) == 1);

// Never-dispatched work is ineligible, and a terminal interleaving always wins.
let unfrozenCommands = pendingCommands();
let unfrozen = switch (Map.get(unfrozenCommands, compareKey, key("swap", 6))) {
    case (?value) value;
    case null Runtime.trap("missing test command");
};
unfrozen.call_args := null;
assert (FundingJournal.snapshotPendingIcpRevokes(
    unfrozenCommands,
    ledger,
).size() == 0);

let interleavedCommands = pendingCommands();
let interleavedCandidates = FundingJournal.snapshotPendingIcpRevokes(
    interleavedCommands,
    ledger,
);
let interleaved = switch (Map.get(
    interleavedCommands,
    compareKey,
    key("swap", 6),
)) {
    case (?value) value;
    case null Runtime.trap("missing test command");
};
interleaved.status := #rejected({ code = "definite"; message = "definite"; at = 0 });
assert (FundingJournal.reconcileIcpCompleteScan(
    interleavedCandidates,
    ledger,
    703,
) == 0);

var eightyDigitNat = 1;
var digit = 1;
while (digit < FundingDisplay.MAX_NAT_DIGITS) {
    eightyDigitNat *= 10;
    digit += 1;
};
assert (FundingDisplay.nat(eightyDigitNat));
assert (not FundingDisplay.nat(eightyDigitNat * 10));
assert (
    FundingDisplay.natText(eightyDigitNat * 10) ==
    "<value exceeds Wallet display limit>"
);

var oversizedError = "";
var errorCharacter = 0;
while (errorCharacter < 1_024) {
    oversizedError := oversizedError # "x";
    errorCharacter += 1;
};
let boundedLedgerError = Icrc.transferErrorText(#GenericError({
    error_code = eightyDigitNat * 10;
    message = oversizedError;
}));
assert (
    boundedLedgerError.size() <=
    16 + 36 + 2 + FundingDisplay.MAX_ERROR_MESSAGE_CHARS
);

assert (FundingDisplay.safeLabel(
    "Internet Computer",
    FundingDisplay.MAX_TOKEN_NAME_BYTES,
    true,
));
assert (FundingDisplay.safeLabel(
    "ICP",
    FundingDisplay.MAX_TOKEN_SYMBOL_BYTES,
    false,
));
assert (not FundingDisplay.safeLabel("", FundingDisplay.MAX_TOKEN_NAME_BYTES, true));
assert (not FundingDisplay.safeLabel(" ICP", FundingDisplay.MAX_TOKEN_NAME_BYTES, true));
assert (not FundingDisplay.safeLabel("ICP ", FundingDisplay.MAX_TOKEN_NAME_BYTES, true));
assert (not FundingDisplay.safeLabel("I CP", FundingDisplay.MAX_TOKEN_SYMBOL_BYTES, false));
assert (not FundingDisplay.safeLabel(
    Text.fromArray(['I', Char.fromNat32(0x202E), 'P']),
    FundingDisplay.MAX_TOKEN_SYMBOL_BYTES,
    false,
));
assert (not FundingDisplay.safeLabel(
    Text.fromArray(['I', Char.fromNat32(0x200B), 'P']),
    FundingDisplay.MAX_TOKEN_SYMBOL_BYTES,
    false,
));
var oversizedName = "";
var nameByte = 0;
while (nameByte <= FundingDisplay.MAX_TOKEN_NAME_BYTES) {
    oversizedName := oversizedName # "A";
    nameByte += 1;
};
assert (not FundingDisplay.safeLabel(
    oversizedName,
    FundingDisplay.MAX_TOKEN_NAME_BYTES,
    true,
));
