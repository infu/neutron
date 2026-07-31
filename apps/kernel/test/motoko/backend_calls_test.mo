import Principal "mo:core/Principal";
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Error "mo:core/Error";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Runtime "mo:core/Runtime";
import AppUsageTypes "../../backend/app_usage/Types";
import Memory "../../backend/backend_calls/Memory";
import Service "../../backend/backend_calls/Service";
import Types "../../backend/backend_calls/Types";
import CapabilityTypes "../../backend/capabilities/Types";

let appA : CapabilityTypes.AppScope = {
    app_id = "wallet";
    installation_uid = 1;
};
let appB : CapabilityTypes.AppScope = {
    app_id = "other_app";
    installation_uid = 2;
};
let ledger = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
let other = Principal.fromText("r7inp-6aaaa-aaaaa-aaabq-cai");
let owner = Principal.fromText("aaaaa-aa");
let mem : Types.Memory = {
    var next_id = 1;
    reservations = Map.empty<Nat, Types.Reservation>();
};
assert (Service.cycleDeclarationValid(0, 0));
assert (Service.cycleDeclarationValid(
    Service.MAX_CYCLES_PER_CALL,
    Service.MAX_CYCLES_PER_DAY,
));
assert (not Service.cycleDeclarationValid(1, 0));
assert (not Service.cycleDeclarationValid(Service.MAX_CYCLES_PER_CALL + 1, Service.MAX_CYCLES_PER_DAY));
assert (not Service.cycleDeclarationValid(Service.MAX_CYCLES_PER_CALL, Service.MAX_CYCLES_PER_DAY + 1));
assert (Service.cycleBalanceAvailable(
    Service.MIN_REMAINING_CYCLES + 15,
    10,
    5,
));
assert (not Service.cycleBalanceAvailable(
    Service.MIN_REMAINING_CYCLES + 14,
    10,
    5,
));
assert (Service.boundedCharge(4, 10) == 4);
assert (Service.boundedCharge(11, 10) == 10);

func require(value : ?Types.ReservationSummary) : Types.ReservationSummary {
    switch (value) {
        case (?reservation) reservation;
        case null Runtime.trap("Expected reservation");
    };
};

func supportsEveryReservation(
    _appScope : CapabilityTypes.AppScope,
    _scopeKind : Text,
) : Bool {
    true;
};

let principalGrant = require(Memory.put(mem, appA, #principal(ledger), owner, 1));
let sameGrant = require(Memory.put(mem, appA, #principal(ledger), owner, 2));
assert (principalGrant.id == sameGrant.id);
assert (Map.size(mem.reservations) == 1);
assert (Memory.allows(mem, appA, ledger, "icrc1_balance_of"));
assert (not Memory.allows(mem, appA, other, "icrc1_balance_of"));
assert (not Memory.allows(mem, appB, ledger, "icrc1_balance_of"));
let appAReinstall : CapabilityTypes.AppScope = {
    app_id = "wallet";
    installation_uid = 99;
};
assert (not Memory.allows(mem, appAReinstall, ledger, "icrc1_balance_of"));
// Same authored id is not ownership. A later reinstall cannot acquire or use
// an old installation's reservation until committed cleanup releases it.
assert (Memory.put(
    mem,
    appAReinstall,
    #principal(ledger),
    owner,
    2,
) == null);

let methodGrant = require(Memory.put(mem, appA, #method("status"), owner, 3));
assert (Memory.allows(mem, appA, other, "status"));
assert (not Memory.allows(mem, appA, other, "transfer"));

let exactGrant = require(Memory.put(
    mem,
    appB,
    #exact({ principal = other; method = "read" }),
    owner,
    4,
));
assert (Memory.allows(mem, appB, other, "read"));
assert (not Memory.allows(mem, appB, other, "write"));

Memory.removeIncompatible(
    mem,
    func(appId, scope) {
        appId == appA and scope == "principal";
    },
);
assert (Map.size(mem.reservations) == 1);
assert (Map.get(mem.reservations, Nat.compare, principalGrant.id) != null);
assert (not Memory.remove(mem, methodGrant.id));
assert (not Memory.remove(mem, exactGrant.id));

Memory.removeAppScope(mem, appA);
assert (Map.size(mem.reservations) == 0);

var taskALive = true;
var taskBLive = true;
let taskA = Service.ScheduledBudget("task_a", 2, {
    active = func() : Bool { taskALive };
});
let taskB = Service.ScheduledBudget("task_b", 1, {
    active = func() : Bool { taskBLive };
});
assert (taskA.consume(1));
assert (taskA.available() == 1);
assert (taskB.available() == 1);
assert (taskB.consume(1));
assert (taskB.available() == 0);
assert (not taskB.consume(1));
assert (taskA.consume(1));
assert (taskA.available() == 0);

// A retained task handle dies with its invocation lease and cannot be revived.
var retainedOpen = true;
let retained = Service.ScheduledBudget("retained", 2, {
    active = func() : Bool { retainedOpen };
});
retainedOpen := false;
assert (not retained.active());
assert (not retained.consume(1));
assert (retained.available() == 2);

let reply : Types.CallResult = #ok(Blob.fromArray([1, 2, 3]));
taskBLive := false;
switch (Service.enforcePostDispatch(?taskB, true, reply)) {
    case (#err(error)) {
        assert (error.code == "invocation_revoked_after_dispatch");
    };
    case (#ok(_)) Runtime.trap("Revoked invocation leaked reply bytes");
};
switch (Service.enforcePostDispatch(null, false, reply)) {
    case (#err(error)) assert (error.code == "revoked_after_dispatch");
    case (#ok(_)) Runtime.trap("Revoked app scope leaked reply bytes");
};

assert (Service.capabilityOutcome([reply]) == #ok);
assert (Service.capabilityOutcome([
    #err({ code = "not_reserved"; message = "denied" })
]) == #denied);
assert (Service.capabilityOutcome([
    #err({ code = "scheduled_budget_exhausted"; message = "limited" })
]) == #denied);
assert (Service.capabilityOutcome([
    #err({ code = "concurrency_limit"; message = "busy" })
]) == #busy);
assert (Service.capabilityOutcome([
    #err({ code = "call_rejected"; message = "failed" })
]) == #failed);
// Revocation dominates a mixed batch because any already-dispatched remote
// mutation has an explicitly unknown outcome and no reply bytes may escape.
assert (Service.capabilityOutcome([
    #err({ code = "call_rejected"; message = "failed" }),
    #err({ code = "revoked_after_dispatch"; message = "revoked" }),
]) == #revoked);

let ?initialBatch = Memory.apply(
    mem,
    appA,
    [
        #reserve(#principal(ledger)),
        #reserve(#exact({ principal = other; method = "read" })),
    ],
    owner,
    5,
) else Runtime.trap("Expected initial batch");
assert (initialBatch.size() == 2);
assert (Memory.allows(mem, appA, ledger, "future_method"));

let ?replacementBatch = Memory.apply(
    mem,
    appA,
    [
        #reserve(#principal(other)),
        #release(#principal(ledger)),
    ],
    owner,
    6,
) else Runtime.trap("Expected replacement batch");
assert (replacementBatch.size() == 2);
assert (not Memory.allows(mem, appA, ledger, "future_method"));
assert (Memory.allows(mem, appA, other, "future_method"));
assert (Memory.allows(mem, appA, other, "read"));

// Reservations are exclusive ownership at each point. Whole-canister
// ownership wins over a global method, and a global method wins over an exact
// point. Lower tiers remain dormant and become effective when the higher tier
// is released.
let ownership : Types.Memory = {
    var next_id = 1;
    reservations = Map.empty<Nat, Types.Reservation>();
};
let mail : CapabilityTypes.AppScope = {
    app_id = "mail";
    installation_uid = 3;
};
let files : CapabilityTypes.AppScope = {
    app_id = "files";
    installation_uid = 4;
};
let mailMethod = require(Memory.put(
    ownership,
    mail,
    #method("mail_receive_v1"),
    owner,
    10,
));
let filesExact = require(Memory.put(
    ownership,
    files,
    #exact({ principal = other; method = "mail_receive_v1" }),
    owner,
    11,
));
assert (Memory.allows(ownership, mail, other, "mail_receive_v1"));
assert (not Memory.allows(ownership, files, other, "mail_receive_v1"));

let filesCanister = require(Memory.put(
    ownership,
    files,
    #principal(ledger),
    owner,
    12,
));
assert (Memory.allows(ownership, files, ledger, "mail_receive_v1"));
assert (not Memory.allows(ownership, mail, ledger, "mail_receive_v1"));
assert (Memory.allows(ownership, mail, other, "mail_receive_v1"));

// Same-app reserve is idempotent; another app cannot become a second owner at
// the same tier.
let sameMailMethod = require(Memory.put(
    ownership,
    mail,
    #method("mail_receive_v1"),
    owner,
    13,
));
assert (sameMailMethod.id == mailMethod.id);
assert (Memory.put(
    ownership,
    appB,
    #method("mail_receive_v1"),
    owner,
    14,
) == null);
assert (Memory.put(
    ownership,
    appB,
    #principal(ledger),
    owner,
    14,
) == null);
assert (Memory.put(
    ownership,
    appA,
    #exact({ principal = other; method = "mail_receive_v1" }),
    owner,
    14,
) == null);

// A conflicting action makes the whole release-first batch fail without
// committing an otherwise-valid reservation.
let beforeAtomic = Map.size(ownership.reservations);
let beforeAtomicNextId = ownership.next_id;
switch (Memory.apply(
    ownership,
    appB,
    [
        #reserve(#principal(other)),
        #reserve(#method("mail_receive_v1")),
    ],
    owner,
    15,
)) {
    case null {};
    case (?_) Runtime.trap("Conflicting batch must fail");
};
assert (Map.size(ownership.reservations) == beforeAtomic);
assert (ownership.next_id == beforeAtomicNextId);
assert (not Memory.allows(ownership, appB, other, "unrelated"));

// Duplicate owners are ambiguous and deny every app. Removing one
// owner restores deterministic ownership without choosing by map order.
let duplicateConflict : Types.Reservation = {
    id = ownership.next_id;
    app_scope = appB;
    scope = #method("mail_receive_v1");
    created_at = 16;
    created_by = owner;
};
ownership.next_id += 1;
Map.add(
    ownership.reservations,
    Nat.compare,
    duplicateConflict.id,
    duplicateConflict,
);
assert (not Memory.allows(ownership, mail, other, "mail_receive_v1"));
assert (not Memory.allows(ownership, appB, other, "mail_receive_v1"));
assert (Memory.remove(ownership, duplicateConflict.id));
assert (Memory.allows(ownership, mail, other, "mail_receive_v1"));

assert (Memory.remove(ownership, filesCanister.id));
assert (not Memory.allows(ownership, files, ledger, "mail_receive_v1"));
assert (Memory.allows(ownership, mail, ledger, "mail_receive_v1"));
assert (Memory.remove(ownership, mailMethod.id));
assert (Memory.allows(ownership, files, other, "mail_receive_v1"));
assert (not Memory.allows(ownership, mail, other, "mail_receive_v1"));
assert (Memory.remove(ownership, filesExact.id));

// Install defaults are first persisted as inert uid-zero claims. They reserve
// the conflict and capacity slots without becoming visible or callable before
// the target deployment commits.
let freshClaimMem : Types.Memory = {
    var next_id = 1;
    reservations = Map.empty<Nat, Types.Reservation>();
};
let freshTarget : CapabilityTypes.AppScope = {
    app_id = "fresh_app";
    installation_uid = 10;
};
let freshPlan : [Types.InstallReservationPlan] = [{
    app_scope = freshTarget;
    reservations = [
        #principal(other),
        #method("fresh_status"),
    ];
}];
assert (Memory.prepareInstallClaims(freshClaimMem, freshPlan, owner, 20));
assert (Memory.hasInstallClaims(freshClaimMem));
assert (Map.size(freshClaimMem.reservations) == 2);
assert (Memory.list(freshClaimMem).size() == 0);
assert (Memory.listApp(freshClaimMem, freshTarget).size() == 0);
assert (not Memory.allows(
    freshClaimMem,
    freshTarget,
    other,
    "anything",
));
assert (not Memory.allows(
    freshClaimMem,
    freshTarget,
    ledger,
    "fresh_status",
));

// Retrying after a lost response recognizes the exact durable claim set and
// must neither allocate a new id nor duplicate a claim.
let freshClaimNextId = freshClaimMem.next_id;
assert (Memory.prepareInstallClaims(freshClaimMem, freshPlan, ledger, 21));
assert (freshClaimMem.next_id == freshClaimNextId);
assert (Map.size(freshClaimMem.reservations) == 2);

assert (Memory.finalizeInstallReservations(
    freshClaimMem,
    freshPlan,
    supportsEveryReservation,
    owner,
    22,
));
assert (not Memory.hasInstallClaims(freshClaimMem));
assert (Memory.list(freshClaimMem).size() == 2);
assert (Memory.allows(freshClaimMem, freshTarget, other, "anything"));
assert (Memory.allows(freshClaimMem, freshTarget, ledger, "fresh_status"));
let ?committedFreshPrincipal = Map.get(
    freshClaimMem.reservations,
    Nat.compare,
    1,
) else Runtime.trap("Committed install reservation missing");
assert (committedFreshPrincipal.created_by == owner);
assert (committedFreshPrincipal.created_at == 20);

// The compiled target is authoritative. A stale predecessor may claim "foo",
// but finalization grants only the target's "bar" declaration. An omitted
// claim is repaired from the frozen active table when capacity permits.
let mismatchedClaimMem : Types.Memory = {
    var next_id = 1;
    reservations = Map.empty<Nat, Types.Reservation>();
};
assert (Memory.prepareInstallClaims(
    mismatchedClaimMem,
    [{
        app_scope = freshTarget;
        reservations = [#method("stale_foo")];
    }],
    owner,
    22,
));
let authoritativePlan : [Types.InstallReservationPlan] = [{
    app_scope = freshTarget;
    reservations = [#method("compiled_bar")];
}];
assert (Memory.finalizeInstallReservations(
    mismatchedClaimMem,
    authoritativePlan,
    supportsEveryReservation,
    owner,
    23,
));
assert (not Memory.hasInstallClaims(mismatchedClaimMem));
assert (not Memory.allows(
    mismatchedClaimMem,
    freshTarget,
    ledger,
    "stale_foo",
));
assert (Memory.allows(
    mismatchedClaimMem,
    freshTarget,
    ledger,
    "compiled_bar",
));

// An active owner in an unrelated app rejects the whole preparation without
// leaving a partial claim or consuming an id.
let installConflictMem : Types.Memory = {
    var next_id = 1;
    reservations = Map.empty<Nat, Types.Reservation>();
};
ignore require(Memory.put(
    installConflictMem,
    appB,
    #principal(other),
    owner,
    22,
));
let installConflictSize = Map.size(installConflictMem.reservations);
let installConflictNextId = installConflictMem.next_id;
assert (not Memory.prepareInstallClaims(
    installConflictMem,
    [{
        app_scope = appAReinstall;
        reservations = [#principal(other)];
    }],
    owner,
    23,
));
assert (not Memory.hasInstallClaims(installConflictMem));
assert (Map.size(installConflictMem.reservations) == installConflictSize);
assert (installConflictMem.next_id == installConflictNextId);

// A target-authoritative mismatch that discovers a reservation retained by
// the compiled target returns blocked without consuming claims. Explicit owner
// release makes retry resolvable without trapping or controller rollback.
let blockerId = Memory.list(installConflictMem)[0].id;
let conflictRecoveryPlan : [Types.InstallReservationPlan] = [{
    app_scope = appAReinstall;
    reservations = [#principal(other)];
}];
let conflictRecoveryBlockers = Memory.installRecoveryBlockers(
    installConflictMem,
    conflictRecoveryPlan,
    supportsEveryReservation,
);
assert (conflictRecoveryBlockers.size() == 1);
assert (conflictRecoveryBlockers[0].reservation.id == blockerId);
switch (conflictRecoveryBlockers[0].reason) {
    case (#scope_conflict) {};
    case (_) Runtime.trap("Expected an exact-scope recovery blocker");
};
assert (not Memory.finalizeInstallReservations(
    installConflictMem,
    conflictRecoveryPlan,
    supportsEveryReservation,
    owner,
    24,
));
assert (Map.size(installConflictMem.reservations) == 1);
assert (Memory.removeActive(installConflictMem, blockerId));
assert (
    Memory.installRecoveryBlockers(
        installConflictMem,
        conflictRecoveryPlan,
        supportsEveryReservation,
    ).size() == 0
);
assert (Memory.finalizeInstallReservations(
    installConflictMem,
    conflictRecoveryPlan,
    supportsEveryReservation,
    owner,
    25,
));
assert (Memory.allows(
    installConflictMem,
    appAReinstall,
    other,
    "recovered",
));

// A reservation absent from the compiled target cannot block that target.
// Readiness and blocker inspection normalize only a private clone; finalization
// atomically retires the stale conflict and materializes the target default.
let retiredConflictMem : Types.Memory = {
    var next_id = 1;
    reservations = Map.empty<Nat, Types.Reservation>();
};
let retiredConflict = require(Memory.put(
    retiredConflictMem,
    appB,
    #principal(other),
    owner,
    25,
));
let retiredConflictPlan : [Types.InstallReservationPlan] = [{
    app_scope = appAReinstall;
    reservations = [#principal(other)];
}];
func supportsRetiredConflictTarget(
    appScope : CapabilityTypes.AppScope,
    scopeKind : Text,
) : Bool {
    appScope == appAReinstall and scopeKind == "principal";
};
let retiredConflictNextId = retiredConflictMem.next_id;
assert (
    Memory.installRecoveryBlockers(
        retiredConflictMem,
        retiredConflictPlan,
        supportsRetiredConflictTarget,
    ).size() == 0
);
assert (Map.size(retiredConflictMem.reservations) == 1);
assert (
    Map.get(
        retiredConflictMem.reservations,
        Nat.compare,
        retiredConflict.id,
    ) != null
);
assert (Memory.canFinalizeInstallReservations(
    retiredConflictMem,
    retiredConflictPlan,
    supportsRetiredConflictTarget,
    owner,
    25,
));
assert (retiredConflictMem.next_id == retiredConflictNextId);
assert (Map.size(retiredConflictMem.reservations) == 1);
assert (Memory.allows(
    retiredConflictMem,
    appB,
    other,
    "still_read_only",
));
assert (not Memory.allows(
    retiredConflictMem,
    appAReinstall,
    other,
    "still_read_only",
));
assert (Memory.finalizeInstallReservations(
    retiredConflictMem,
    retiredConflictPlan,
    supportsRetiredConflictTarget,
    owner,
    25,
));
assert (
    Map.get(
        retiredConflictMem.reservations,
        Nat.compare,
        retiredConflict.id,
    ) == null
);
assert (Map.size(retiredConflictMem.reservations) == 1);
assert (not Memory.allows(
    retiredConflictMem,
    appB,
    other,
    "retired",
));
assert (Memory.allows(
    retiredConflictMem,
    appAReinstall,
    other,
    "materialized",
));

// Recovery must not delete a real grant when the authoritative target itself
// is impossible. These shapes can arise only when the compiled declaration
// differs from the predecessor-supplied preparation plan.
let duplicateTargetScopeMem : Types.Memory = {
    var next_id = 1;
    reservations = Map.empty<Nat, Types.Reservation>();
};
ignore require(Memory.put(
    duplicateTargetScopeMem,
    appB,
    #method("duplicate_target_scope"),
    owner,
    25,
));
assert (
    Memory.installRecoveryBlockers(
        duplicateTargetScopeMem,
        [
            {
                app_scope = appA;
                reservations = [#method("duplicate_target_scope")];
            },
            {
                app_scope = {
                    app_id = "third_app";
                    installation_uid = 3;
                };
                reservations = [#method("duplicate_target_scope")];
            },
        ],
        supportsEveryReservation,
    ).size() == 0
);
assert (Map.size(duplicateTargetScopeMem.reservations) == 1);

let duplicateTargetAppMem : Types.Memory = {
    var next_id = 1;
    reservations = Map.empty<Nat, Types.Reservation>();
};
ignore require(Memory.put(
    duplicateTargetAppMem,
    appB,
    #method("duplicate_target_app_conflict"),
    owner,
    25,
));
assert (
    Memory.installRecoveryBlockers(
        duplicateTargetAppMem,
        [
            {
                app_scope = appA;
                reservations = [#method("duplicate_target_app_conflict")];
            },
            {
                app_scope = appAReinstall;
                reservations = [#method("duplicate_target_app_other")];
            },
        ],
        supportsEveryReservation,
    ).size() == 0
);
assert (Map.size(duplicateTargetAppMem.reservations) == 1);

let overCapacityTargetMem : Types.Memory = {
    var next_id = 1;
    reservations = Map.empty<Nat, Types.Reservation>();
};
ignore require(Memory.put(
    overCapacityTargetMem,
    appB,
    #method("global_capacity_unrelated"),
    owner,
    25,
));
let overCapacityTargetPlans =
    Array.tabulate<Types.InstallReservationPlan>(
        33,
        func(appIndex : Nat) : Types.InstallReservationPlan {
            {
                app_scope = {
                    app_id = "over_capacity_" # Nat.toText(appIndex);
                    installation_uid = 123;
                };
                reservations = Array.tabulate<Types.ReservationScope>(
                    64,
                    func(scopeIndex : Nat) : Types.ReservationScope {
                        #method(
                            "over_capacity_" # Nat.toText(appIndex) # "_" #
                            Nat.toText(scopeIndex)
                        );
                    },
                );
            };
        },
    );
assert (
    Memory.installRecoveryBlockers(
        overCapacityTargetMem,
        overCapacityTargetPlans,
        supportsEveryReservation,
    ).size() == 0
);
assert (Map.size(overCapacityTargetMem.reservations) == 1);

// Duplicate owners are a fail-closed conflict regardless of map
// iteration order. Neither preflight nor authoritative finalization may pick
// one row and report a usable default.
let duplicateOwnerMem : Types.Memory = {
    var next_id = 3;
    reservations = Map.empty<Nat, Types.Reservation>();
};
Map.add(duplicateOwnerMem.reservations, Nat.compare, 1, {
    id = 1;
    app_scope = appA;
    scope = #method("duplicate_owner");
    created_at = 1 : Nat64;
    created_by = owner;
});
Map.add(duplicateOwnerMem.reservations, Nat.compare, 2, {
    id = 2;
    app_scope = appB;
    scope = #method("duplicate_owner");
    created_at = 2 : Nat64;
    created_by = owner;
});
let duplicatePlan : [Types.InstallReservationPlan] = [{
    app_scope = appA;
    reservations = [#method("duplicate_owner")];
}];
assert (not Memory.prepareInstallClaims(
    duplicateOwnerMem,
    duplicatePlan,
    owner,
    26,
));
assert (not Memory.finalizeInstallReservations(
    duplicateOwnerMem,
    duplicatePlan,
    supportsEveryReservation,
    owner,
    26,
));
assert (Map.size(duplicateOwnerMem.reservations) == 2);
assert (not Memory.allows(
    duplicateOwnerMem,
    appA,
    ledger,
    "duplicate_owner",
));

// A reservation held by the same logical app is credited to its replacement.
// The temporary claim is inert, and commit transfers the original grant and
// metadata to the new installation scope without storing a second grant.
let creditedMem : Types.Memory = {
    var next_id = 1;
    reservations = Map.empty<Nat, Types.Reservation>();
};
let creditedGrant = require(Memory.put(
    creditedMem,
    appA,
    #principal(ledger),
    owner,
    24,
));
assert (Memory.prepareInstallClaims(
    creditedMem,
    [{
        app_scope = appAReinstall;
        reservations = [#principal(ledger)];
    }],
    owner,
    25,
));
assert (Map.size(creditedMem.reservations) == 2);
assert (Memory.list(creditedMem).size() == 1);
assert (Memory.allows(creditedMem, appA, ledger, "read"));
assert (not Memory.allows(creditedMem, appAReinstall, ledger, "read"));
let creditedNextIdBeforeReadiness = creditedMem.next_id;
assert (Memory.canFinalizeInstallReservations(
    creditedMem,
    [{
        app_scope = appAReinstall;
        reservations = [#principal(ledger)];
    }],
    supportsEveryReservation,
    owner,
    26,
));
// Readiness must leave both the active predecessor grant and the inert claim
// byte-for-byte observable as before; only the lifecycle commit materializes.
assert (creditedMem.next_id == creditedNextIdBeforeReadiness);
assert (Map.size(creditedMem.reservations) == 2);
assert (Memory.hasInstallClaims(creditedMem));
assert (Memory.list(creditedMem).size() == 1);
assert (Memory.allows(creditedMem, appA, ledger, "read"));
assert (not Memory.allows(creditedMem, appAReinstall, ledger, "read"));
assert (Memory.finalizeInstallReservations(
    creditedMem,
    [{
        app_scope = appAReinstall;
        reservations = [#principal(ledger)];
    }],
    supportsEveryReservation,
    owner,
    26,
));
assert (Map.size(creditedMem.reservations) == 1);
assert (not Memory.hasInstallClaims(creditedMem));
assert (not Memory.allows(creditedMem, appA, ledger, "read"));
assert (Memory.allows(creditedMem, appAReinstall, ledger, "read"));
let ?transferredGrant = Map.get(
    creditedMem.reservations,
    Nat.compare,
    creditedGrant.id,
) else Runtime.trap("Credited install reservation missing");
assert (transferredGrant.app_scope == appAReinstall);
assert (transferredGrant.created_by == owner);
assert (transferredGrant.created_at == 24);

// A changed retry must fail atomically while retaining the original claims.
// Duplicate scopes are malformed even on a fresh preparation.
let retryMem : Types.Memory = {
    var next_id = 1;
    reservations = Map.empty<Nat, Types.Reservation>();
};
let retryPlan : [Types.InstallReservationPlan] = [{
    app_scope = freshTarget;
    reservations = [#method("retry_original")];
}];
assert (Memory.prepareInstallClaims(retryMem, retryPlan, owner, 26));
let retryNextId = retryMem.next_id;
assert (not Memory.prepareInstallClaims(
    retryMem,
    [{
        app_scope = freshTarget;
        reservations = [#method("retry_changed")];
    }],
    owner,
    27,
));
assert (not Memory.prepareInstallClaims(retryMem, [], owner, 27));
assert (retryMem.next_id == retryNextId);
assert (Map.size(retryMem.reservations) == 1);
Memory.removeInstallClaims(retryMem);
assert (not Memory.hasInstallClaims(retryMem));
assert (Map.size(retryMem.reservations) == 0);
assert (not Memory.prepareInstallClaims(
    retryMem,
    [{
        app_scope = freshTarget;
        reservations = [
            #method("duplicate"),
            #method("duplicate"),
        ];
    }],
    owner,
    28,
));
assert (not Memory.hasInstallClaims(retryMem));
assert (Map.size(retryMem.reservations) == 0);
assert (retryMem.next_id == retryNextId);

// Abort cleanup removes only inert install claims and preserves active grants.
let abortClaimMem : Types.Memory = {
    var next_id = 1;
    reservations = Map.empty<Nat, Types.Reservation>();
};
let abortActive = require(Memory.put(
    abortClaimMem,
    appB,
    #method("abort_active"),
    owner,
    29,
));
assert (Memory.prepareInstallClaims(
    abortClaimMem,
    [{
        app_scope = appAReinstall;
        reservations = [#principal(other)];
    }],
    owner,
    30,
));
let abortNextId = abortClaimMem.next_id;
assert (Memory.hasInstallClaims(abortClaimMem));
Memory.removeInstallClaims(abortClaimMem);
assert (not Memory.hasInstallClaims(abortClaimMem));
assert (abortClaimMem.next_id == abortNextId);
assert (Map.size(abortClaimMem.reservations) == 1);
assert (
    Map.get(abortClaimMem.reservations, Nat.compare, abortActive.id) != null
);
assert (Memory.allows(
    abortClaimMem,
    appB,
    other,
    "abort_active",
));

// Preparation accounts for the app's final active total, not the uid-zero
// claim bucket. A full app cannot sneak in a 257th reservation through install.
let appCapacityMem : Types.Memory = {
    var next_id = 1;
    reservations = Map.empty<Nat, Types.Reservation>();
};
let appCapacityScope : CapabilityTypes.AppScope = {
    app_id = "capacity_app";
    installation_uid = 31;
};
var appCapacityIndex = 0;
while (appCapacityIndex < 256) {
    ignore require(Memory.put(
        appCapacityMem,
        appCapacityScope,
        #method("capacity_" # Nat.toText(appCapacityIndex)),
        owner,
        31,
    ));
    appCapacityIndex += 1;
};
let appCapacityNextId = appCapacityMem.next_id;
assert (not Memory.prepareInstallClaims(
    appCapacityMem,
    [{
        app_scope = appCapacityScope;
        reservations = [#method("capacity_overflow")];
    }],
    owner,
    32,
));
assert (not Memory.hasInstallClaims(appCapacityMem));
assert (appCapacityMem.next_id == appCapacityNextId);
assert (Map.size(appCapacityMem.reservations) == 256);

// Unsupported predecessor scope kinds are retired in the same atomic commit,
// so they cannot create a false per-app capacity blocker for the target.
let projectedCapacityPlan : [Types.InstallReservationPlan] = [{
    app_scope = appCapacityScope;
    reservations = [#principal(other)];
}];
func supportsProjectedCapacity(
    appScope : CapabilityTypes.AppScope,
    scopeKind : Text,
) : Bool {
    appScope == appCapacityScope and scopeKind == "principal";
};
assert (
    Memory.installRecoveryBlockers(
        appCapacityMem,
        projectedCapacityPlan,
        supportsProjectedCapacity,
    ).size() == 0
);
assert (Memory.canFinalizeInstallReservations(
    appCapacityMem,
    projectedCapacityPlan,
    supportsProjectedCapacity,
    owner,
    32,
));
assert (appCapacityMem.next_id == appCapacityNextId);
assert (Map.size(appCapacityMem.reservations) == 256);
assert (Memory.finalizeInstallReservations(
    appCapacityMem,
    projectedCapacityPlan,
    supportsProjectedCapacity,
    owner,
    32,
));
assert (Map.size(appCapacityMem.reservations) == 1);
assert (Memory.allows(
    appCapacityMem,
    appCapacityScope,
    other,
    "capacity_recovered",
));

// Fill the global table directly with valid, non-claim rows so this boundary
// remains cheap to exercise. The 2,049th active slot is rejected atomically.
let globalCapacityMem : Types.Memory = {
    var next_id = 1;
    reservations = Map.empty<Nat, Types.Reservation>();
};
var globalCapacityIndex = 0;
while (globalCapacityIndex < 2_048) {
    let id = globalCapacityIndex + 1;
    let reservation : Types.Reservation = {
        id;
        app_scope = {
            app_id = "global_" # Nat.toText(globalCapacityIndex / 256);
            installation_uid = 32;
        };
        scope = #method("global_" # Nat.toText(globalCapacityIndex));
        created_at = 32;
        created_by = owner;
    };
    Map.add(
        globalCapacityMem.reservations,
        Nat.compare,
        id,
        reservation,
    );
    globalCapacityIndex += 1;
};
globalCapacityMem.next_id := 2_049;
assert (not Memory.prepareInstallClaims(
    globalCapacityMem,
    [{
        app_scope = {
            app_id = "global_overflow";
            installation_uid = 33;
        };
        reservations = [#method("global_overflow")];
    }],
    owner,
    33,
));
assert (not Memory.hasInstallClaims(globalCapacityMem));
assert (globalCapacityMem.next_id == 2_049);
assert (Map.size(globalCapacityMem.reservations) == 2_048);

// The broker reserves a whole approved batch before creating any remote
// future, forwards the exact attached amount to each transport call, and
// finalizes the one aggregate reservation with bounded net charges.
let callMem : Types.Memory = {
    var next_id = 1;
    reservations = Map.empty<Nat, Types.Reservation>();
};
var transportBalance = Service.MIN_REMAINING_CYCLES + 1_000;
var transportCalls = 0;
var transportedCycles = 0;
var transportThrows = false;
var denyCycleReservation = false;
var cycleReservations = 0;
var reservedCycles = 0;
var reservedDailyLimit : ?Nat = null;
var reservedCallCount = 0;
var cycleCommits = 0;
var cycleCancellations = 0;
var cycleFinalizations = 0;
var finalizedCycles = 0;
let transport : Types.Transport = {
    cycle_balance = func() { transportBalance };
    call_cost = func(_method, _argumentBytes) { 2 };
    call = func(request : Types.CallRequest) : async Types.TransportResult {
        // Creating a Motoko future does not dispatch it. Its body must not
        // execute until the aggregate reservation has committed exactly once.
        assert (cycleCommits == cycleReservations);
        transportCalls += 1;
        transportedCycles += request.cycles;
        if (transportThrows) throw Error.reject("unexpected transport failure");
        #ok({
            reply = request.args;
            charged_cycles = if (request.method == "first") 1 else 3;
        });
    };
};
let registry : CapabilityTypes.RuntimeRegistry = {
    allowed = func(_scope, kind, resource) {
        kind == #backend_calls and resource == "default";
    };
    lease = func(_scope, kind, resource) {
        if (kind != #backend_calls or resource != "default") return null;
        ?{ active = func() { true } };
    };
    record = func(_scope, _kind, _resource, _operation, _outcome) { true };
};
func reserveCycles(
    scope : CapabilityTypes.AppScope,
    attached : Nat,
    dailyLimit : ?Nat,
    callCount : Nat,
) : ?AppUsageTypes.OutgoingCycleReservation {
    if (denyCycleReservation) return null;
    cycleReservations += 1;
    reservedCycles := attached;
    reservedDailyLimit := dailyLimit;
    reservedCallCount := callCount;
    ?{
        id = cycleReservations;
        scope;
        day = 0;
        attached;
        call_count = callCount;
        daily_budgeted = dailyLimit != null;
    };
};
func commitCycles(
    reservation : AppUsageTypes.OutgoingCycleReservation,
) : Bool {
    assert (reservation.id == cycleReservations);
    assert (cycleCommits + 1 == cycleReservations);
    cycleCommits += 1;
    true;
};
func cancelCycles(
    _reservation : AppUsageTypes.OutgoingCycleReservation,
) : () {
    cycleCancellations += 1;
};
func finalizeCycles(
    _reservation : AppUsageTypes.OutgoingCycleReservation,
    charged : Nat,
) : () {
    cycleFinalizations += 1;
    finalizedCycles := charged;
};
let outgoingCycleAccounting : AppUsageTypes.OutgoingCycleAccounting = {
    reserve = reserveCycles;
    commit = commitCycles;
    cancel = cancelCycles;
    finalize = finalizeCycles;
};

// Updating an app without backend-call authority has no reservation work.
// Its changed AppScope must therefore remain commit-ready instead of being
// mistaken for a missing backend-call declaration.
let filesScope : CapabilityTypes.AppScope = {
    app_id = "files";
    installation_uid = 3;
};
let noBackendCallsMem : Types.Memory = {
    var next_id = 1;
    reservations = Map.empty<Nat, Types.Reservation>();
};
let noBackendCallsBroker = Service.Service(
    noBackendCallsMem,
    func(_scope) { false },
    registry,
    transport,
    outgoingCycleAccounting,
);
noBackendCallsBroker.configure([{
    app_scope = filesScope;
    backend_calls = null;
}], ledger);
assert (noBackendCallsBroker.canFinalizeInstallReservations(
    [filesScope],
    owner,
    ledger,
));
assert (noBackendCallsBroker.finalizeInstallReservations(
    [filesScope],
    owner,
    ledger,
));
let capabilityFreeMem : Types.Memory = {
    var next_id = 1;
    reservations = Map.empty<Nat, Types.Reservation>();
};
let capabilityFreeBroker = Service.Service(
    capabilityFreeMem,
    func(_scope) { false },
    registry,
    transport,
    outgoingCycleAccounting,
);
capabilityFreeBroker.configure([], ledger);
assert (capabilityFreeBroker.canFinalizeInstallReservations(
    [filesScope],
    owner,
    ledger,
));

var callScopeActive = false;
let broker = Service.Service(
    callMem,
    func(scope) { callScopeActive and scope == appA },
    registry,
    transport,
    outgoingCycleAccounting,
);
let declaration : Types.AppCapabilitiesDeclaration = {
    app_scope = appA;
    backend_calls = ?{
        reservation_scopes = ["principal"];
        max_concurrency = 2;
        max_cycles_per_call = 10;
        max_cycles_per_day = 12;
        install_reservations = [#principal(other)];
    };
};
// A pending browser target has no active scope, so configuration leaves its
// reviewed defaults inert until predecessor claims are finalized at commit.
broker.configure([declaration], ledger);
assert (not broker.canFinalizeInstallReservations(
    [appAReinstall],
    owner,
    ledger,
));
let brokerInstallPlan : [Types.InstallReservationsPrepareApp] = [{
    app_id = appA.app_id;
    reservations = [#principal(other)];
}];
broker.prepareInstallReservations(
    brokerInstallPlan,
    [appA],
    [appA],
    owner,
    ledger,
);
assert (broker.reservations().size() == 0);
assert (not Memory.allows(callMem, appA, other, "first"));
let installReservationNextId = callMem.next_id;
broker.prepareInstallReservations(
    brokerInstallPlan,
    [appA],
    [appA],
    owner,
    ledger,
);
assert (callMem.next_id == installReservationNextId);
assert (Memory.hasInstallClaims(callMem));
assert (broker.canFinalizeInstallReservations([appA], owner, ledger));
assert (callMem.next_id == installReservationNextId);
assert (Memory.hasInstallClaims(callMem));
assert (broker.reservations().size() == 0);
assert (not Memory.allows(callMem, appA, other, "first"));
assert (broker.finalizeInstallReservations([appA], owner, ledger));
callScopeActive := true;
assert (Memory.allows(callMem, appA, other, "first"));
let canisterActor : actor {} = actor (Principal.toText(ledger));
let callCapability = broker.capability(appA, canisterActor);

switch (await* callCapability.call({
    canister = other;
    method = "first";
    args = "too_expensive";
    cycles = 11;
})) {
    case (#err(error)) assert (error.code == "cycles_per_call_limit");
    case (#ok(_)) Runtime.trap("Per-call cycle ceiling was bypassed");
};
assert (transportCalls == 0 and cycleReservations == 0);

transportBalance := Service.MIN_REMAINING_CYCLES + 13;
let belowFloor = await* callCapability.call_batch([
    { canister = other; method = "first"; args = "one"; cycles = 4 },
    { canister = other; method = "second"; args = "two"; cycles = 6 },
]);
for (result in belowFloor.vals()) {
    switch (result) {
        case (#err(error)) assert (error.code == "low_cycles");
        case (#ok(_)) Runtime.trap("Below-floor batch was dispatched");
    };
};
assert (transportCalls == 0 and cycleReservations == 0);

transportBalance := Service.MIN_REMAINING_CYCLES + 14;
let batch = await* callCapability.call_batch([
    { canister = other; method = "first"; args = "one"; cycles = 4 },
    { canister = other; method = "second"; args = "two"; cycles = 6 },
]);
assert (batch.size() == 2);
for (result in batch.vals()) {
    switch (result) {
        case (#ok(_)) {};
        case (#err(_)) Runtime.trap("Expected batch dispatch success");
    };
};
assert (transportCalls == 2 and transportedCycles == 10);
assert (cycleReservations == 1 and reservedCycles == 10);
assert (reservedDailyLimit == ?12);
assert (reservedCallCount == 2);
assert (cycleCommits == 1);
assert (cycleCancellations == 0);
assert (cycleFinalizations == 1 and finalizedCycles == 4);

denyCycleReservation := true;
let mixedDenied = await* callCapability.call_batch([
    { canister = other; method = "first"; args = "static"; cycles = 11 },
    { canister = other; method = "second"; args = "daily"; cycles = 1 },
]);
switch (mixedDenied[0]) {
    case (#err(error)) assert (error.code == "cycles_per_call_limit");
    case (#ok(_)) Runtime.trap("Mixed batch lost its static policy error");
};
switch (mixedDenied[1]) {
    case (#err(error)) assert (error.code == "cycles_daily_limit");
    case (#ok(_)) Runtime.trap("Daily cycle ceiling was bypassed");
};
assert (transportCalls == 2 and cycleFinalizations == 1);

denyCycleReservation := false;
transportThrows := true;
let finalizationsBeforeThrow = cycleFinalizations;
switch (await* callCapability.call({
    canister = other;
    method = "first";
    args = "throw";
    cycles = 5;
})) {
    case (#err(error)) assert (error.code == "call_rejected");
    case (#ok(_)) Runtime.trap("Unexpected transport throw became success");
};
assert (cycleCommits == cycleReservations);
assert (cycleCancellations == 0);
assert (cycleFinalizations == finalizationsBeforeThrow + 1);
assert (finalizedCycles == 5);

// An unrelated app commit passes no wallet scope. It must not restore an
// install default that the owner deliberately revoked after installation.
assert (Memory.removeReservationScope(
    callMem,
    appA,
    #principal(other),
));
broker.prepareInstallReservations(
    brokerInstallPlan,
    [appA],
    [],
    owner,
    ledger,
);
assert (not Memory.hasInstallClaims(callMem));
assert (broker.finalizeInstallReservations([], owner, ledger));
assert (not Memory.allows(callMem, appA, other, "first"));

// Reconstructing transient declarations over committed memory must not
// resurrect a default that its owner revoked. Existing compatible user grants
// remain untouched.
ignore require(Memory.put(
    callMem,
    appA,
    #principal(ledger),
    owner,
    30,
));
let reconstructedBroker = Service.Service(
    callMem,
    func(scope) { scope == appA },
    registry,
    transport,
    outgoingCycleAccounting,
);
reconstructedBroker.configure([declaration], ledger);
assert (not Memory.allows(callMem, appA, other, "first"));
assert (Memory.allows(callMem, appA, ledger, "first"));

// A clean reinstall has no predecessor journal. Its exact compiled defaults
// materialize synchronously from the same declaration.
let freshDefaultMem : Types.Memory = {
    var next_id = 1;
    reservations = Map.empty<Nat, Types.Reservation>();
};
let freshDefaultBroker = Service.Service(
    freshDefaultMem,
    func(scope) { scope == appA },
    registry,
    transport,
    outgoingCycleAccounting,
);
freshDefaultBroker.configure([declaration], ledger);
assert (Memory.allows(
    freshDefaultMem,
    appA,
    other,
    "fresh_default",
));

// Pending recovery accepts only the authoritative candidate derived from the
// compiled target declaration. An unrelated saved grant remains untouchable.
let recoveryMem : Types.Memory = {
    var next_id = 1;
    reservations = Map.empty<Nat, Types.Reservation>();
};
let recoveryConflict = require(Memory.put(
    recoveryMem,
    appB,
    #principal(other),
    owner,
    32,
));
let recoveryUnrelated = require(Memory.put(
    recoveryMem,
    appB,
    #method("unrelated_saved_access"),
    owner,
    33,
));
let recoveryBroker = Service.Service(
    recoveryMem,
    func(scope) { scope == appA or scope == appB },
    registry,
    transport,
    outgoingCycleAccounting,
);
let retainedRecoveryDeclaration : Types.AppCapabilitiesDeclaration = {
    app_scope = appB;
    backend_calls = ?{
        reservation_scopes = ["principal", "method"];
        max_concurrency = 1;
        max_cycles_per_call = 0;
        max_cycles_per_day = 0;
        install_reservations = [];
    };
};
recoveryBroker.configure(
    [declaration, retainedRecoveryDeclaration],
    ledger,
);
let authoritativeBlockers =
    recoveryBroker.pendingInstallReservationBlockers([appA], ledger);
assert (authoritativeBlockers.size() == 1);
assert (
    authoritativeBlockers[0].reservation.id ==
    recoveryConflict.id
);
assert (not recoveryBroker.releasePendingReservation(
    [appA],
    ledger,
    recoveryUnrelated.id,
));
assert (Memory.allows(
    recoveryMem,
    appB,
    ledger,
    "unrelated_saved_access",
));
assert (recoveryBroker.releasePendingReservation(
    [appA],
    ledger,
    recoveryConflict.id,
));
assert (
    recoveryBroker.pendingInstallReservationBlockers(
        [appA],
        ledger,
    ).size() == 0
);
assert (recoveryBroker.canFinalizeInstallReservations(
    [appA],
    owner,
    ledger,
));
