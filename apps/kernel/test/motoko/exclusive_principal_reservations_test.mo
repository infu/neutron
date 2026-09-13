import Iter "mo:core/Iter";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Memory "../../backend/backend_calls/Memory";
import Types "../../backend/backend_calls/Types";
import CapabilityTypes "../../backend/capabilities/Types";
import V3 "../../backend/memory/kernel/v3";
import V4 "../../backend/memory/kernel/v4";

let wallet : CapabilityTypes.AppScope = {
    app_id = "wallet";
    installation_uid = 11;
};
let caller : CapabilityTypes.AppScope = {
    app_id = "caller";
    installation_uid = 12;
};
let foreign : CapabilityTypes.AppScope = {
    app_id = "foreign";
    installation_uid = 13;
};
let ledger = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
let other = Principal.fromText("r7inp-6aaaa-aaaaa-aaabq-cai");
let owner = Principal.fromText("aaaaa-aa");
let methods = ["icrc1_transfer", "icrc1_fee", "icrc1_balance_of"];

func fresh() : Types.Memory {
    {
        var next_id = 1;
        reservations = Map.empty<Nat, Types.Reservation>();
    };
};

func snapshot(mem : Types.Memory) : (Nat, [Types.Reservation]) {
    (mem.next_id, Iter.toArray(Map.values(mem.reservations)));
};

func required<T>(value : ?T) : T {
    let ?present = value else Runtime.trap("Expected reservation");
    present;
};

func supportsAll(_scope : CapabilityTypes.AppScope, _kind : Text) : Bool {
    true;
};

// A clean principal reservation protects every method, including read-only
// metadata, while method-wide grants continue to work on other destinations.
// Both grant orders produce the same effective permissions.
for (principalFirst in [true, false].vals()) {
    let mem = fresh();
    assert (Memory.isPristine(mem));
    if (principalFirst) {
        ignore required(Memory.put(mem, wallet, #principal(ledger), owner, 1));
    };
    for (method in methods.vals()) {
        ignore required(Memory.put(mem, caller, #method(method), owner, 2));
    };
    if (not principalFirst) {
        ignore required(Memory.put(mem, wallet, #principal(ledger), owner, 3));
    };
    let before = snapshot(mem);
    for (method in methods.vals()) {
        assert (Memory.allows(mem, wallet, ledger, method));
        assert (not Memory.allows(mem, caller, ledger, method));
        assert (Memory.allows(mem, caller, other, method));
        assert (not Memory.allows(mem, wallet, other, method));
        assert (Memory.put(
            mem, caller, #exact({ principal = ledger; method }), owner, 4,
        ) == null);
        assert (snapshot(mem) == before);
    };
    assert (Memory.allows(mem, wallet, ledger, "future_ledger_method"));
    assert (not Memory.allows(mem, foreign, ledger, "future_ledger_method"));
    let reinstalledWallet : CapabilityTypes.AppScope = {
        app_id = wallet.app_id;
        installation_uid = 99;
    };
    assert (not Memory.allows(mem, reinstalledWallet, ledger, "icrc1_transfer"));
    assert (Memory.put(
        mem, reinstalledWallet, #exact({ principal = ledger; method = "icrc1_transfer" }), owner, 4,
    ) == null);
    assert (snapshot(mem) == before);
};

// Exact/principal collisions reject direct grants and complete action batches
// in either acquisition order. A rejected batch must also undo its releases.
for (principalFirst in [true, false].vals()) {
    let mem = fresh();
    let firstApp = if (principalFirst) wallet else caller;
    let secondApp = if (principalFirst) caller else wallet;
    let principalScope : Types.ReservationScope = #principal(ledger);
    let exactScope : Types.ReservationScope = #exact({
        principal = ledger;
        method = "icrc1_transfer";
    });
    let firstScope = if (principalFirst) principalScope else exactScope;
    let secondScope = if (principalFirst) exactScope else principalScope;
    let retained = required(Memory.put(mem, firstApp, firstScope, owner, 5));
    ignore required(Memory.put(mem, secondApp, #method("retained_status"), owner, 6));
    let before = snapshot(mem);
    assert (Memory.conflicts(mem, secondApp, secondScope));
    assert (Memory.put(mem, secondApp, secondScope, owner, 7) == null);
    assert (snapshot(mem) == before);
    assert (Memory.apply(mem, secondApp, [
        #release(#method("retained_status")),
        #reserve(#exact({ principal = other; method = "new_status" })),
        #reserve(secondScope),
    ], owner, 7) == null);
    assert (snapshot(mem) == before);

    let target : [Types.InstallReservationPlan] = [{
        app_scope = secondApp;
        reservations = [
            #exact({ principal = other; method = "new_status" }),
            secondScope,
        ];
    }];
    assert (not Memory.prepareInstallClaims(mem, target, owner, 8));
    assert (snapshot(mem) == before);
    assert (not Memory.canFinalizeInstallReservations(mem, target, supportsAll, owner, 9));
    assert (snapshot(mem) == before);
    assert (not Memory.finalizeInstallReservations(mem, target, supportsAll, owner, 9));
    assert (snapshot(mem) == before);
    let blockers = Memory.installRecoveryBlockers(mem, target, supportsAll);
    assert (blockers.size() == 1);
    assert (blockers[0].reservation.id == retained.id);
    assert (blockers[0].reason == #scope_conflict);
    assert (snapshot(mem) == before);
    assert (Memory.allows(mem, firstApp, ledger, "icrc1_transfer"));
    assert (Memory.allows(mem, secondApp, other, "retained_status"));
};

// One installed owner may use principal, exact and method scopes together.
// Exercise both target-plan orders, including durable claim finalization.
for (principalFirst in [true, false].vals()) {
    let principalScope : Types.ReservationScope = #principal(ledger);
    let exactScope : Types.ReservationScope = #exact({ principal = ledger; method = "icrc1_fee" });
    let scopes = if (principalFirst) [principalScope, exactScope] else [exactScope, principalScope];
    let direct = fresh();
    for (scope in scopes.vals()) {
        ignore required(Memory.put(direct, wallet, scope, owner, 10));
    };
    ignore required(Memory.put(direct, wallet, #method("icrc1_fee"), owner, 11));
    assert (Memory.listApp(direct, wallet).size() == 3);
    assert (Memory.allows(direct, wallet, ledger, "icrc1_transfer"));
    assert (Memory.allows(direct, wallet, other, "icrc1_fee"));

    let installed = fresh();
    let target : [Types.InstallReservationPlan] = [{ app_scope = wallet; reservations = scopes }];
    assert (Memory.prepareInstallClaims(installed, target, owner, 12));
    assert (not Memory.allows(installed, wallet, ledger, "icrc1_fee"));
    assert (Memory.finalizeInstallReservations(installed, target, supportsAll, owner, 13));
    assert (Memory.listApp(installed, wallet).size() == 2);
    assert (Memory.allows(installed, wallet, ledger, "icrc1_transfer"));
    assert (not Memory.allows(installed, caller, ledger, "icrc1_fee"));
};

// Pending principal claims prevent a competing exact claim without granting
// access before activation. An already-active method grant changes effective
// destinations only when the principal reservation becomes active at commit.
let pending = fresh();
ignore required(Memory.put(pending, caller, #method("icrc1_fee"), owner, 14));
let pendingPlan : [Types.InstallReservationPlan] = [{
    app_scope = wallet;
    reservations = [#principal(ledger)];
}];
assert (Memory.prepareInstallClaims(pending, pendingPlan, owner, 15));
assert (Memory.hasInstallClaims(pending));
assert (Memory.listApp(pending, wallet).size() == 0);
assert (not Memory.ownsPrincipal(pending, wallet, ledger));
assert (not Memory.allows(pending, wallet, ledger, "icrc1_fee"));
assert (not Memory.allows(pending, caller, ledger, "icrc1_transfer"));
assert (Memory.allows(pending, caller, ledger, "icrc1_fee"));
let pendingBefore = snapshot(pending);
assert (Memory.put(pending, caller, #exact({ principal = ledger; method = "icrc1_transfer" }), owner, 16) == null);
assert (Memory.put(pending, caller, #principal(ledger), owner, 16) == null);
assert (Memory.prepareInstallClaims(pending, pendingPlan, owner, 16));
assert (snapshot(pending) == pendingBefore);
assert (Memory.finalizeInstallReservations(pending, pendingPlan, supportsAll, owner, 17));
assert (not Memory.hasInstallClaims(pending));
assert (Memory.ownsPrincipal(pending, wallet, ledger));
assert (Memory.allows(pending, wallet, ledger, "icrc1_transfer"));
assert (not Memory.allows(pending, caller, ledger, "icrc1_fee"));
assert (Memory.allows(pending, caller, other, "icrc1_fee"));

// A historically valid table can contain narrower foreign grants under a
// principal owner. Restore those exact rows through the released schema types;
// authorization must change without rewriting or discarding any stored row.
let legacy : V3.BackendCallsMemory = {
    var next_id = 8;
    reservations = Map.empty<Nat, V3.BackendCallReservation>();
};
Map.add(legacy.reservations, Nat.compare, 1, {
    id = 1; app_scope = wallet; scope = #principal(ledger);
    created_by = owner; created_at = 18 : Nat64;
});
var legacyId = 2;
for (method in methods.vals()) {
    Map.add(legacy.reservations, Nat.compare, legacyId, {
        id = legacyId; app_scope = caller;
        scope = #exact({ principal = ledger; method });
        created_by = owner; created_at = 19 : Nat64;
    });
    legacyId += 1;
    Map.add(legacy.reservations, Nat.compare, legacyId, {
        id = legacyId; app_scope = caller; scope = #method(method);
        created_by = owner; created_at = 20 : Nat64;
    });
    legacyId += 1;
};
let restored : Types.Memory = legacy;
let currentSchema : V4.BackendCallsMemory = restored;
let oldSchemaAgain : V3.BackendCallsMemory = currentSchema;
let legacyBefore = snapshot(oldSchemaAgain);
assert (legacyId == 8);
assert (Memory.list(restored).size() == 7);
for (method in methods.vals()) {
    assert (Memory.allows(restored, wallet, ledger, method));
    assert (not Memory.allows(restored, caller, ledger, method));
    assert (Memory.allows(restored, caller, other, method));
};
assert (snapshot(restored) == legacyBefore);

// Conflicting principal/exact declarations in one target cannot be repaired
// by deleting active rows. Neither plan order offers a recovery candidate or
// commits a partial plan, including when a predecessor has already staged it.
for (principalFirst in [true, false].vals()) {
    let mem = fresh();
    ignore required(Memory.put(mem, foreign, #exact({ principal = ledger; method = "icrc1_transfer" }), owner, 21));
    let principalPlan : Types.InstallReservationPlan = {
        app_scope = wallet;
        reservations = [#principal(ledger)];
    };
    let exactPlan : Types.InstallReservationPlan = {
        app_scope = caller;
        reservations = [#exact({ principal = ledger; method = "icrc1_transfer" })];
    };
    let target = if (principalFirst) [principalPlan, exactPlan] else [exactPlan, principalPlan];
    let before = snapshot(mem);
    assert (not Memory.prepareInstallClaims(mem, target, owner, 22));
    assert (not Memory.canFinalizeInstallReservations(mem, target, supportsAll, owner, 22));
    assert (not Memory.finalizeInstallReservations(mem, target, supportsAll, owner, 22));
    assert (Memory.installRecoveryBlockers(mem, target, supportsAll).size() == 0);
    assert (snapshot(mem) == before);

    let clean = fresh();
    assert (not Memory.prepareInstallClaims(clean, target, owner, 23));
    assert (not Memory.finalizeInstallReservations(clean, target, supportsAll, owner, 23));
    assert (Memory.isPristine(clean));

    // Model inert claims written by the predecessor's old independent-tier
    // policy. Even an exact retry of those rows cannot validate this target.
    for (plan in target.vals()) {
        for (scope in plan.reservations.vals()) {
            let id = clean.next_id;
            Map.add(clean.reservations, Nat.compare, id, {
                id;
                app_scope = { app_id = plan.app_scope.app_id; installation_uid = 0 : Nat64 };
                scope; created_by = owner; created_at = 24 : Nat64;
            });
            clean.next_id += 1;
        };
    };
    let stagedBefore = snapshot(clean);
    assert (Memory.hasInstallClaims(clean));
    assert (not Memory.prepareInstallClaims(clean, target, owner, 25));
    assert (not Memory.canFinalizeInstallReservations(clean, target, supportsAll, owner, 25));
    assert (not Memory.finalizeInstallReservations(clean, target, supportsAll, owner, 25));
    assert (Memory.installRecoveryBlockers(clean, target, supportsAll).size() == 0);
    assert (snapshot(clean) == stagedBefore);
    assert (not Memory.allows(clean, wallet, ledger, "icrc1_transfer"));
    assert (not Memory.allows(clean, caller, ledger, "icrc1_transfer"));
};
