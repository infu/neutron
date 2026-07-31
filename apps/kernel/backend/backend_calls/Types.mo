import Map "mo:core/Map";
import Caps "mo:neutron-capabilities";
import AppUsageTypes "../app_usage/Types";
import CapabilityTypes "../capabilities/Types";

module {
    public type ReservationScope = {
        #exact : { principal : Principal; method : Text };
        #principal : Principal;
        #method : Text;
    };

    public type Reservation = {
        id : Nat;
        app_scope : CapabilityTypes.AppScope;
        scope : ReservationScope;
        created_at : Nat64;
        created_by : Principal;
    };

    public type Memory = {
        var next_id : Nat;
        reservations : Map.Map<Nat, Reservation>;
    };

    public type BackendCallsDeclaration = {
        reservation_scopes : [Text];
        max_concurrency : Nat;
        max_cycles_per_call : Nat;
        max_cycles_per_day : Nat;
        install_reservations : [ReservationScope];
    };

    // Internal normalized plan derived from BackendCallsDeclaration. This is
    // not a second compiler initializer or public install ABI.
    public type InstallReservationPlan = {
        app_scope : CapabilityTypes.AppScope;
        reservations : [ReservationScope];
    };

    public type InstallReservationsPrepareApp = {
        app_id : Text;
        reservations : [ReservationScope];
    };

    public type InstallReservationsPrepareInput = {
        deployment_id : Text;
        apps : [InstallReservationsPrepareApp];
    };

    public type AppCapabilitiesDeclaration = {
        app_scope : CapabilityTypes.AppScope;
        backend_calls : ?BackendCallsDeclaration;
    };

    public type CallRequest = Caps.BackendCallRequestV1;
    public type CallError = Caps.BackendCallErrorV1;
    public type CallResult = Caps.BackendCallResultV1;
    public type Capability = Caps.BackendCallsV1;
    public type OutgoingCycleReservation = AppUsageTypes.OutgoingCycleReservation;
    public type OutgoingCycleAccounting = AppUsageTypes.OutgoingCycleAccounting;

    // Kernel-internal transport. App code receives only `Capability`; it can
    // never obtain this record, observe the canister balance, or attach cycles
    // without the broker's declaration and daily-budget checks.
    public type TransportSuccess = {
        reply : Blob;
        charged_cycles : Nat;
    };

    public type TransportFailure = {
        message : Text;
        charged_cycles : Nat;
    };

    public type TransportResult = {
        #ok : TransportSuccess;
        #err : TransportFailure;
    };

    public type Transport = {
        cycle_balance : () -> Nat;
        call_cost : (Text, Nat) -> Nat;
        call : CallRequest -> async TransportResult;
    };

    public type ReservationSummary = {
        id : Nat;
        app_id : Text;
        installation_uid : Nat64;
        scope_kind : Text;
        principal : ?Principal;
        method : ?Text;
        created_at : Nat64;
        created_by : Principal;
    };

    public type PendingReservationBlockerReason = {
        #scope_conflict;
        #app_capacity;
        #global_capacity;
    };

    public type PendingReservationBlocker = {
        reservation : ReservationSummary;
        reason : PendingReservationBlockerReason;
    };

    public type ReservationAction = {
        #reserve : ReservationScope;
        #release : ReservationScope;
    };

    public type ReservationApplyInput = {
        app_id : Text;
        actions : [ReservationAction];
    };
};
