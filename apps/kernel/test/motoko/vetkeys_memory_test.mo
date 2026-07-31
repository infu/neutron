import Blob "mo:core/Blob";
import Array "mo:core/Array";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Memory "../../backend/vetkeys/Memory";
import Namespace "../../backend/vetkeys/Namespace";
import Types "../../backend/vetkeys/Types";

let canister = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
let owner = Principal.fromText("r7inp-6aaaa-aaaaa-aaabq-cai");
let otherOwner = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
let nonce : Blob = "\00\01\02\03\04\05\06\07\08\09\0a\0b\0c\0d\0e\0f\10\11\12\13\14\15\16\17\18\19\1a\1b\1c\1d\1e\1f";

func require<T>(result : Types.Result<T>) : T {
    switch (result) {
        case (#ok(value)) value;
        case (#err(_)) Runtime.trap("Expected successful vetKeys memory result");
    };
};

func appScope(appId : Text) : Types.AppScope {
    { app_id = appId; installation_uid = 1 };
};

func appScopeWithUid(appId : Text, installationUid : Nat64) : Types.AppScope {
    { app_id = appId; installation_uid = installationUid };
};

func reserve(
    mem : Types.Memory,
    appId : Text,
    slotId : Text,
    nonceValue : Blob,
    now : Nat64,
) : Types.SlotSummary {
    reserveForScope(mem, appScope(appId), slotId, nonceValue, now);
};

func reserveForScope(
    mem : Types.Memory,
    scope : Types.AppScope,
    slotId : Text,
    nonceValue : Blob,
    now : Nat64,
) : Types.SlotSummary {
    require(Memory.reserve(mem, {
        scope;
        slot_id = slotId;
        namespace_nonce = nonceValue;
        key_holder = owner;
        key_name = "test_key_1";
        now;
        changed_by = owner;
    }));
};

// The encoding is frozen with externally reproducible SHA-256 golden vectors.
let #ok(namespace) = Namespace.build({
    canister;
    app_id = "mail";
    installation_uid = 1;
    slot_id = "mailbox";
    namespace_nonce = nonce;
    generation = 1;
}) else Runtime.trap("Expected namespace material");
assert (
    namespace.context ==
    "\af\34\20\cd\f7\43\03\8a\89\3a\3a\82\c9\94\48\bf\2c\9e\20\57\a0\92\28\c0\ab\d8\b5\17\49\ff\d5\2c"
);
assert (
    namespace.derivation_input ==
    "\ef\10\7a\40\1c\e7\f4\8d\03\31\c8\28\96\4b\82\39\56\c9\de\3d\14\42\09\87\dd\ad\fb\6e\28\f5\f9\cc"
);

let #ok(otherNamespace) = Namespace.build({
    canister;
    app_id = "other_app";
    installation_uid = 1;
    slot_id = "mailbox";
    namespace_nonce = nonce;
    generation = 1;
}) else Runtime.trap("Expected second namespace material");
assert (
    otherNamespace.context ==
    "\9b\cf\0f\b1\e0\7b\89\56\24\4c\b7\f1\7b\be\68\f9\82\b5\4b\33\6e\34\53\ed\3e\b8\d0\1d\7d\eb\43\f0"
);
assert (otherNamespace.context != namespace.context);

let #ok(rotatedNamespace) = Namespace.build({
    canister;
    app_id = "mail";
    installation_uid = 1;
    slot_id = "mailbox";
    namespace_nonce = nonce;
    generation = 2;
}) else Runtime.trap("Expected rotated namespace material");
assert (
    rotatedNamespace.context ==
    "\a0\23\79\45\cd\3a\b8\07\41\41\53\8a\91\e6\6a\85\3e\1e\3c\04\20\64\d1\29\7f\4d\e0\8f\59\18\5b\44"
);
assert (rotatedNamespace.context != namespace.context);
let #ok(reinstalledNamespace) = Namespace.build({
    canister;
    app_id = "mail";
    installation_uid = 2;
    slot_id = "mailbox";
    namespace_nonce = nonce;
    generation = 1;
}) else Runtime.trap("Expected reinstalled namespace material");
assert (reinstalledNamespace.context != namespace.context);
assert (reinstalledNamespace.derivation_input != namespace.derivation_input);
assert (
    Namespace.build({
        canister;
        app_id = "mail";
        installation_uid = 1;
        slot_id = "mailbox";
        namespace_nonce = "\00";
        generation = 1;
    }) == #err(#invalid_input)
);
assert (
    Namespace.build({
        canister;
        app_id = "mail";
        installation_uid = 0;
        slot_id = "mailbox";
        namespace_nonce = nonce;
        generation = 1;
    }) == #err(#invalid_input)
);

let mem = Memory.init();
let mail = reserve(mem, "mail", "mailbox", nonce, 1);
let other = reserve(mem, "other_app", "mailbox", nonce, 2);
let reinstalledMailScope = appScopeWithUid("mail", 2);
let reinstalledMail = reserveForScope(
    mem,
    reinstalledMailScope,
    "mailbox",
    nonce,
    2,
);
assert (mail.slot_uid != other.slot_uid);
assert (mail.slot_uid != reinstalledMail.slot_uid);
assert (Memory.getByUidForScope(mem, appScope("mail"), other.slot_uid) == null);
assert (Memory.getByUidForScope(mem, appScope("other_app"), mail.slot_uid) == null);
assert (Memory.getByUidForScope(mem, appScope("mail"), reinstalledMail.slot_uid) == null);
assert (Memory.getByUidForScope(mem, reinstalledMailScope, mail.slot_uid) == null);
assert (Memory.listScope(mem, appScope("mail")).size() == 1);
assert (Memory.listScope(mem, appScope("other_app")).size() == 1);
assert (Memory.listScope(mem, reinstalledMailScope).size() == 1);
assert (
    Memory.reserve(mem, {
        scope = appScope("bad_key_app");
        slot_id = "slot";
        namespace_nonce = nonce;
        key_holder = owner;
        key_name = "app_selected_key";
        now = 2;
        changed_by = owner;
    }) == #err(#invalid_key_name)
);

// Reserving an existing app/slot is idempotent and cannot replace its nonce.
let replacementNonce : Blob = "\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff";
let duplicate = reserve(mem, "mail", "mailbox", replacementNonce, 3);
assert (duplicate.slot_uid == mail.slot_uid);
let ?persistedMail = Memory.get(mem, appScope("mail"), "mailbox") else {
    Runtime.trap("Expected persisted Mail slot");
};
assert (persistedMail.namespace_nonce == nonce);

ignore reserve(mem, "mail", "archive", nonce, 4);
ignore reserve(mem, "mail", "search", nonce, 5);
ignore reserve(mem, "mail", "profile", nonce, 6);
assert (
    Memory.reserve(mem, {
        scope = appScope("mail");
        slot_id = "fifth";
        namespace_nonce = nonce;
        key_holder = owner;
        key_name = "test_key_1";
        now = 7;
        changed_by = owner;
    }) == #err(#app_slot_limit)
);

let rotated = require(Memory.rotate(
    mem,
    appScope("mail"),
    "mailbox",
    "test_key_1",
    owner,
    8,
));
assert (rotated.current_generation == 2);
assert (rotated.previous_generation == ?1);
assert (
    Memory.rotate(mem, appScope("mail"), "mailbox", "test_key_1", owner, 9) ==
    #err(#previous_exists)
);
assert (
    Memory.retireGeneration(mem, appScope("mail"), "mailbox", 2, owner, 10) ==
    #err(#current_generation)
);
let retiredPrevious = require(Memory.retireGeneration(
    mem,
    appScope("mail"),
    "mailbox",
    1,
    owner,
    11,
));
assert (retiredPrevious.previous_generation == null);
let rotatedAgain = require(Memory.rotate(
    mem,
    appScope("mail"),
    "mailbox",
    "test_key_1",
    owner,
    12,
));
assert (rotatedAgain.current_generation == 3);
assert (rotatedAgain.previous_generation == ?2);

Memory.suspendIncompatible(
    mem,
    func(scope, slotId) { scope.app_id != "mail" or slotId != "mailbox" },
    owner,
    13,
);
let ?suspended = Memory.get(mem, appScope("mail"), "mailbox") else {
    Runtime.trap("Expected suspended slot");
};
assert (suspended.status == #manifest_suspended);
// Restoring a declaration does not silently re-enable a suspended slot.
Memory.suspendIncompatible(mem, func(_, _) { true }, owner, 14);
let ?stillSuspended = Memory.get(mem, appScope("mail"), "mailbox") else {
    Runtime.trap("Expected retained suspended slot");
};
assert (stillSuspended.status == #manifest_suspended);
let enabled = require(Memory.setStatus(
    mem,
    appScope("mail"),
    "mailbox",
    #enabled,
    owner,
    15,
));
assert (enabled.status == #enabled);

assert (Memory.retireScope(mem, appScope("mail"), owner, 16) == 4);
assert (Memory.listScope(mem, appScope("mail")).size() == 0);
assert (Memory.getByUidForScope(mem, appScope("mail"), mail.slot_uid) == null);
assert (mem.retired_tombstones.size() == 4);

// Sequential install/uninstall churn retains only a bounded compact tail. Slot
// uids still increase monotonically, while new reservations always provide a
// fresh random nonce at the service layer.
var index = 0;
while (index < Memory.MAX_TOMBSTONES + 9) {
    let appId = "temp_" # Nat.toText(index);
    let slot = reserve(mem, appId, "slot", nonce, Nat64.fromNat(20 + index));
    ignore require(Memory.retireSlot(
        mem,
        appScope(appId),
        "slot",
        #app_uninstalled,
        otherOwner,
        Nat64.fromNat(20 + index),
    ));
    assert (Memory.getByUidForScope(mem, appScope(appId), slot.slot_uid) == null);
    index += 1;
};
assert (mem.retired_tombstones.size() == Memory.MAX_TOMBSTONES);
assert (mem.retired_tombstones[0].slot_uid > mail.slot_uid);
assert (mem.next_slot_uid > mem.retired_tombstones[Memory.MAX_TOMBSTONES - 1].slot_uid);
assert (Memory.rebuildIndex(mem));

// Rebuild is transactional: a malformed duplicate index is replaced from the
// authoritative bounded slot map.
Map.add(mem.slot_index_by_scope_and_id, Text.compare, "bogus:index", 999_999);
assert (Memory.rebuildIndex(mem));
assert (Map.get(mem.slot_index_by_scope_and_id, Text.compare, "bogus:index") == null);

let bounded = Memory.init();
var appIndex = 0;
while (appIndex < Memory.MAX_SLOTS_TOTAL / Memory.MAX_SLOTS_PER_APP) {
    var slotIndex = 0;
    while (slotIndex < Memory.MAX_SLOTS_PER_APP) {
        ignore reserve(
            bounded,
            "bounded_" # Nat.toText(appIndex),
            "slot_" # Nat.toText(slotIndex),
            nonce,
            Nat64.fromNat(appIndex * Memory.MAX_SLOTS_PER_APP + slotIndex),
        );
        slotIndex += 1;
    };
    appIndex += 1;
};
assert (Map.size(bounded.slots_by_uid) == Memory.MAX_SLOTS_TOTAL);
assert (
    Memory.reserve(bounded, {
        scope = appScope("overflow_app");
        slot_id = "slot";
        namespace_nonce = nonce;
        key_holder = owner;
        key_name = "test_key_1";
        now = 999;
        changed_by = owner;
    }) == #err(#slot_limit)
);
assert (Memory.rebuildIndex(bounded));

let accountingMem = Memory.init();
let accountingSlot = reserve(accountingMem, "accounting_app", "slot", nonce, 1);
let usedAt : Nat64 = 2;
ignore require(Memory.recordDerivation(
    accountingMem,
    appScope("accounting_app"),
    "slot",
    usedAt,
));
let ?usedSlot = Memory.get(
    accountingMem,
    appScope("accounting_app"),
    "slot",
) else {
    Runtime.trap("Expected accounting slot");
};
assert (usedSlot.total_derivations == 1);
assert (usedSlot.last_used_at == ?usedAt);
assert (Memory.recordCycleSpend(
    accountingMem,
    appScope("accounting_app"),
    accountingSlot.slot_uid,
    50,
));
let ?chargedSlot = Memory.get(accountingMem, appScope("accounting_app"), "slot") else {
    Runtime.trap("Expected charged accounting slot");
};
assert (chargedSlot.approximate_cycle_spend == 50);

// Long-lived administrative counters are fixed to one Nat64-sized decimal
// envelope. They saturate instead of growing stable/Candid replies forever.
Map.add(accountingMem.slots_by_uid, Nat.compare, chargedSlot.slot_uid, {
    chargedSlot with
    total_derivations = Memory.MAX_COUNTER_VALUE - 1;
    approximate_cycle_spend = Memory.MAX_COUNTER_VALUE - 10;
});
ignore require(Memory.recordDerivation(
    accountingMem,
    appScope("accounting_app"),
    "slot",
    usedAt,
));
assert (Memory.recordCycleSpend(
    accountingMem,
    appScope("accounting_app"),
    chargedSlot.slot_uid,
    50,
));
let ?saturatedSlot = Memory.get(
    accountingMem,
    appScope("accounting_app"),
    "slot",
) else {
    Runtime.trap("Expected saturated accounting slot");
};
assert (saturatedSlot.total_derivations == Memory.MAX_COUNTER_VALUE);
assert (saturatedSlot.approximate_cycle_spend == Memory.MAX_COUNTER_VALUE);
assert (Memory.rebuildIndex(accountingMem));

let corruptCounterMemory = Memory.init();
let corruptCounterSlot = reserve(
    corruptCounterMemory,
    "counter_app",
    "slot",
    nonce,
    1,
);
let ?corruptStoredSlot = Memory.get(
    corruptCounterMemory,
    appScope("counter_app"),
    "slot",
) else Runtime.trap("Expected counter slot");
Map.add(
    corruptCounterMemory.slots_by_uid,
    Nat.compare,
    corruptCounterSlot.slot_uid,
    { corruptStoredSlot with total_derivations = Memory.MAX_COUNTER_VALUE + 1 },
);
assert (not Memory.rebuildIndex(corruptCounterMemory));

let lifecycleMem = Memory.init();
let lifecycleSlot = reserve(lifecycleMem, "lifecycle", "slot", nonce, 1);
assert (
    Memory.transfer(
        lifecycleMem,
        appScope("lifecycle"),
        "slot",
        otherOwner,
        owner,
        owner,
        2,
    ) == #err(#owner_required)
);
ignore require(Memory.transfer(
    lifecycleMem,
    appScope("lifecycle"),
    "slot",
    owner,
    otherOwner,
    owner,
    2,
));
let publicKey = Blob.fromArray(Array.tabulate<Nat8>(96, func(_) { 7 }));
let fingerprint = Blob.fromArray(Array.tabulate<Nat8>(32, func(_) { 8 }));
ignore require(Memory.cachePublicKey(
    lifecycleMem,
    appScope("lifecycle"),
    "slot",
    1,
    publicKey,
    fingerprint,
));
assert (
    Memory.cachePublicKey(
        lifecycleMem,
        appScope("lifecycle"),
        "slot",
        1,
        "\00",
        fingerprint,
    ) == #err(#invariant_violation)
);
let ?cached = Memory.generation(lifecycleMem, appScope("lifecycle"), "slot", 1) else {
    Runtime.trap("Expected cached generation");
};
assert (cached.cached_public_key == ?publicKey);
assert (cached.public_fingerprint == ?fingerprint);

var auditIndex = 0;
while (auditIndex < Memory.MAX_AUDIT_ENTRIES + 17) {
    Memory.addAudit(lifecycleMem, {
        at = Nat64.fromNat(auditIndex);
        scope = appScope("lifecycle");
        slot_uid = ?lifecycleSlot.slot_uid;
        slot_id = "slot";
        generation = ?1;
        action = #derive;
        principal = owner;
        outcome = #ok;
    });
    auditIndex += 1;
};
assert (Memory.auditSnapshot(lifecycleMem).size() == Memory.MAX_AUDIT_ENTRIES);
assert (Memory.auditSnapshot(lifecycleMem)[0].at == 17);
assert (Memory.rebuildIndex(lifecycleMem));
