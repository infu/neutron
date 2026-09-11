import Cycles "mo:core/Cycles";
import Int "mo:core/Int";
import Map "mo:core/Map";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Time "mo:core/Time";
import Usage "../../../backend/app_usage/Service";
import UsageTypes "../../../backend/app_usage/Types";
import Backend "../../../backend/backend_calls/Service";
import BackendTypes "../../../backend/backend_calls/Types";
import Raw "../../../backend/backend_calls/Raw";
import Capability "../../../backend/capabilities/Types";
import Memory "../../../backend/memory/kernel_cycle_calls/v1";
import Service "../../../backend/owner_cycle_calls/Service";
import Types "../../../backend/owner_cycle_calls/Types";

// Compiles the production broker, raw transport and new memory root into an
// isolated actor. Reinstalling is never used by this test: install_code upgrade
// restores these roots, and retained requests cannot dispatch a second deposit.
persistent actor class Fixture(initialLedger : Principal, initialOwner : Principal) = Self {
    let ledger = initialLedger;
    let owner = initialOwner;
    let memory = Memory.init();
    let usageMemory = Usage.init();
    let reservations : BackendTypes.Memory = {
        var next_id = 1;
        reservations = Map.empty<Nat, BackendTypes.Reservation>();
    };
    transient let scope : Capability.AppScope = { app_id = "wallet"; installation_uid = 7 };
    transient let self = Principal.fromActor(Self);
    func now() : Nat64 { Nat64.fromNat(Int.abs(Time.now())) };
    func active(candidate : Capability.AppScope) : Bool { candidate == scope };
    transient let usage = Usage.Service(usageMemory, active, now, func() { 0 });
    transient let accounting : UsageTypes.OutgoingCycleAccounting = {
        reserve = usage.reserveOutgoingCycles;
        commit = usage.commitOutgoingDispatch;
        cancel = usage.cancelOutgoingReservation;
        finalize = usage.finalizeOutgoingCycles;
    };
    transient let registry : Capability.RuntimeRegistry = {
        allowed = func(candidate, kind, resource) { active(candidate) and kind == #backend_calls and resource == "default" };
        lease = func(candidate, kind, resource) {
            if (active(candidate) and kind == #backend_calls and resource == "default") ?{ active = func() { true } } else null;
        };
        record = func(_candidate, _kind, _resource, _operation, _outcome) { true };
    };
    transient let broker = Backend.Service(reservations, active, registry, Raw.transport(), accounting);
    broker.configure([{
        app_scope = scope;
        backend_calls = ?{
            reservation_scopes = ["principal"];
            max_concurrency = 2;
            max_cycles_per_call = 100_000_000;
            max_cycles_per_day = 100_000_000;
            install_reservations = [#principal(ledger)];
        };
    }], self);
    transient let service = Service.Service(memory, broker, active, func(caller) { caller == owner }, self, now);

    func request(id : Blob, cycles : Nat, partial : Bool) : Types.Request {
        {
            id; app_scope = scope; allow_partial = partial;
            call = {
                canister = ledger; method = "deposit"; cycles;
                args = to_candid({ to = { owner = self; subaccount = null : ?Blob }; memo = null : ?Blob });
            };
        };
    };
    public query func quote(id : Blob, cycles : Nat, partial : Bool) : async Types.QuoteResult {
        service.quote(request(id, cycles, partial));
    };
    public shared ({ caller }) func execute(id : Blob, cycles : Nat, partial : Bool) : async Types.Result {
        await* service.execute(request(id, cycles, partial), caller);
    };
    public query func status(id : Blob) : async ?Types.Receipt { service.status({ app_scope = scope; id }) };
    public query func balance() : async Nat { Cycles.balance() };
    public query func sequence() : async Nat { memory.next_sequence };
};
