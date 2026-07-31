import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";
import Runtime "mo:core/Runtime";
import AppUsageTypes "../../backend/app_usage/Types";
import CapabilityTypes "../../backend/capabilities/Types";
import Service "../../backend/randomness/Service";
import Types "../../backend/randomness/Types";

var reservedCycleCalls : Nat = 0;
var committedCycleCalls : Nat = 0;
var adapterDispatchCalls : Nat = 0;

func bytes(size : Nat, seed : Nat8) : Blob {
    Blob.fromArray(Array.tabulate<Nat8>(size, func(index) {
        seed +% Nat8.fromNat(index);
    }));
};

class FakeAdapter() {
    public var calls : Nat = 0;
    public var balance : Nat = Service.MIN_REMAINING_CYCLES + 1;
    public var next : Blob = bytes(Service.ENTROPY_BYTES, 1);
    public var fail : Bool = false;
    public var before_reply : ?(() -> async ()) = null;

    public func value() : Types.Adapter {
        {
            cycle_balance = func() { balance };
            random = func() : async Types.AdapterResult {
                // The service must reserve and commit before the adapter's
                // async body starts at the await/dispatch point.
                assert (reservedCycleCalls == adapterDispatchCalls + 1);
                assert (committedCycleCalls == adapterDispatchCalls + 1);
                adapterDispatchCalls += 1;
                calls += 1;
                switch (before_reply) {
                    case (?callback) {
                        before_reply := null;
                        await callback();
                    };
                    case null {};
                };
                if (fail) #err else #ok(next);
            };
        };
    };
};

class FakeRegistry() {
    public var enabled = true;
    public var epoch : Nat = 0;
    public var records : Nat = 0;
    public var last : ?CapabilityTypes.CapabilityOutcome = null;

    public func setEnabled(value : Bool) : () {
        enabled := value;
        epoch += 1;
    };

    public func value() : CapabilityTypes.RuntimeRegistry {
        {
            allowed = func(
                _scope : CapabilityTypes.AppScope,
                kind : CapabilityTypes.CapabilityKind,
                resource : Text,
            ) : Bool {
                enabled and kind == #randomness and resource == "default";
            };
            lease = func(
                scope : CapabilityTypes.AppScope,
                kind : CapabilityTypes.CapabilityKind,
                resource : Text,
            ) : ?CapabilityTypes.RuntimeLease {
                if (
                    not enabled or
                    kind != #randomness or
                    resource != "default"
                ) return null;
                let capturedEpoch = epoch;
                ?{
                    active = func() : Bool {
                        enabled and epoch == capturedEpoch;
                    };
                };
            };
            record = func(
                _scope : CapabilityTypes.AppScope,
                _kind : CapabilityTypes.CapabilityKind,
                _resource : Text,
                _operation : Text,
                outcome : CapabilityTypes.CapabilityOutcome,
            ) : Bool {
                records += 1;
                last := ?outcome;
                true;
            };
        };
    };
};

class FakeCycleAccounting() {
    public var reserve_calls : Nat = 0;
    public var commit_calls : Nat = 0;
    public var cancel_calls : Nat = 0;
    public var finalize_calls : Nat = 0;
    public var last_attached : Nat = 1;
    public var last_call_count : Nat = 0;
    var next_id : Nat = 1;

    public func value() : AppUsageTypes.OutgoingCycleAccounting {
        {
            reserve = func(
                appScope : CapabilityTypes.AppScope,
                attached : Nat,
                dailyLimit : ?Nat,
                callCount : Nat,
            ) : ?AppUsageTypes.OutgoingCycleReservation {
                assert (attached == 0);
                assert (dailyLimit == null);
                assert (callCount == 1);
                reservedCycleCalls += 1;
                reserve_calls += 1;
                last_attached := attached;
                last_call_count := callCount;
                let id = next_id;
                next_id += 1;
                ?{
                    id;
                    scope = appScope;
                    day = 0;
                    attached;
                    daily_budgeted = false;
                    call_count = callCount;
                };
            };
            commit = func(
                reservation : AppUsageTypes.OutgoingCycleReservation,
            ) : Bool {
                assert (reservation.attached == 0);
                assert (reservation.call_count == 1);
                // The future has been produced without starting its async
                // body; commit remains immediately before the first await.
                assert (reservedCycleCalls == committedCycleCalls + 1);
                assert (adapterDispatchCalls == committedCycleCalls);
                committedCycleCalls += 1;
                commit_calls += 1;
                true;
            };
            cancel = func(
                reservation : AppUsageTypes.OutgoingCycleReservation,
            ) : () {
                assert (reservation.attached == 0);
                cancel_calls += 1;
            };
            finalize = func(
                reservation : AppUsageTypes.OutgoingCycleReservation,
                charged : Nat,
            ) : () {
                assert (reservation.attached == 0);
                assert (charged == 0);
                finalize_calls += 1;
            };
        };
    };
};

func scope(appId : Text, installationUid : Nat64) : CapabilityTypes.AppScope {
    { app_id = appId; installation_uid = installationUid };
};

func declaration(
    appScope : CapabilityTypes.AppScope,
) : Types.AppDeclaration {
    {
        app_scope = appScope;
        randomness = ?{};
    };
};

func expectOk(result : Types.Result) : Blob {
    switch (result) {
        case (#ok(value)) value;
        case (#err(_)) Runtime.trap("Expected randomness result");
    };
};

func expectError(result : Types.Result, expected : Types.Error) : () {
    switch (result) {
        case (#err(actual)) assert (actual == expected);
        case (#ok(_)) Runtime.trap("Expected randomness error");
    };
};

let app = scope("dice_app", 1);
let fake = FakeAdapter();
let registry = FakeRegistry();
let accounting = FakeCycleAccounting();
var active = true;
let service = Service.Service(
    fake.value(),
    func(candidate) { active and candidate == app },
    registry.value(),
    accounting.value(),
);
service.configure([declaration(app)]);
let capability = service.capability(app);

let first = expectOk(await* capability.fresh_bytes());
assert (first.size() == Service.ENTROPY_BYTES);
ignore expectOk(await* capability.fresh_bytes());
ignore expectOk(await* capability.fresh_bytes());
assert (fake.calls == 3);
assert (
    accounting.reserve_calls == 3 and
    accounting.commit_calls == 3 and
    accounting.finalize_calls == 3 and
    accounting.cancel_calls == 0 and
    accounting.last_attached == 0 and
    accounting.last_call_count == 1
);

fake.balance := Service.MIN_REMAINING_CYCLES - 1;
expectError(await* capability.fresh_bytes(), #low_cycles);
assert (fake.calls == 3);
assert (accounting.reserve_calls == 3 and accounting.commit_calls == 3);

fake.balance := Service.MIN_REMAINING_CYCLES + 1;
fake.next := bytes(Service.ENTROPY_BYTES - 1, 2);
expectError(await* capability.fresh_bytes(), #management_failure);
assert (fake.calls == 4);
assert (
    accounting.reserve_calls == 4 and
    accounting.commit_calls == 4 and
    accounting.finalize_calls == 4
);

fake.next := bytes(Service.ENTROPY_BYTES, 3);
fake.fail := true;
expectError(await* capability.fresh_bytes(), #management_failure);
assert (fake.calls == 5);
assert (
    accounting.reserve_calls == 5 and
    accounting.commit_calls == 5 and
    accounting.finalize_calls == 5
);

fake.fail := false;
fake.next := bytes(Service.ENTROPY_BYTES, 3);
fake.before_reply := ?(func() : async () {
    expectError(await* service.freshBytes(app), #busy);
});
ignore expectOk(await* capability.fresh_bytes());
assert (fake.calls == 6);
assert (
    accounting.reserve_calls == 6 and
    accounting.commit_calls == 6 and
    accounting.finalize_calls == 6
);

fake.before_reply := ?(func() : async () { active := false });
expectError(await* capability.fresh_bytes(), #source_gone);
assert (fake.calls == 7);
assert (
    accounting.reserve_calls == 7 and
    accounting.commit_calls == 7 and
    accounting.finalize_calls == 7
);
expectError(await* service.freshBytes(scope("dice_app", 2)), #source_gone);
assert (accounting.reserve_calls == 7 and accounting.commit_calls == 7);

// Generic disable is checked again after the management await, and paid
// entropy is discarded instead of being returned to a revoked installation.
active := true;
registry.setEnabled(true);
fake.before_reply := ?(func() : async () {
    registry.setEnabled(false);
    registry.setEnabled(true);
});
expectError(await* capability.fresh_bytes(), #source_gone);
assert (fake.calls == 8);
assert (
    accounting.reserve_calls == 8 and
    accounting.commit_calls == 8 and
    accounting.finalize_calls == 8 and
    accounting.cancel_calls == 0
);
assert (registry.enabled);
assert (registry.last == ?#revoked);
