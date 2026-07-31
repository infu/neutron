import Map "mo:core/Map";
import CapabilityTypes "../capabilities/Types";

module {
    public type AppScope = CapabilityTypes.AppScope;

    // One sparse UTC calendar-day bucket. "Outgoing" totals contain retained
    // explicit transfers plus non-refundable low-side ingress reception,
    // brokered-call, and timer self-call bases. Accepted incoming cycles are
    // tracked separately: they are revenue attributed to the receiving app,
    // not a reduction of its measured costs. Backend attached/refunded values
    // remain transfer-only so an observed refund reopens the app-authored
    // daily allowance.
    public type DayUsage = {
        day : Nat64;
        instructions : Nat64;
        executions : Nat64;
        outgoing_cycles_attached : Nat;
        outgoing_cycles_refunded : Nat;
        backend_cycles_attached : Nat;
        backend_cycles_refunded : Nat;
        incoming_cycles_accepted : Nat;
    };

    public type AppUsage = {
        scope : AppScope;
        days : Map.Map<Nat64, DayUsage>;
        var lifetime_instructions : Nat64;
        var lifetime_executions : Nat64;
        var lifetime_outgoing_cycles_attached : Nat;
        var lifetime_outgoing_cycles_refunded : Nat;
        var lifetime_incoming_cycles_accepted : Nat;
    };

    public type Memory = {
        by_scope : Map.Map<Text, AppUsage>;
        var last_seen_at : Nat64;
        var next_outgoing_cycle_reservation_id : Nat;
    };

    // Compiler-generated wrappers create and consume this token. It is never
    // delivered in an application's capability object.
    public type InstructionMeasurement = {
        scope : AppScope;
        started_at : Nat64;
    };

    // Kernel brokers reserve explicit transfer headroom before their first
    // await. Immediately before dispatch they commit the reservation, which
    // adds one fixed 13-node outgoing-call base per represented call. A known
    // pre-dispatch failure cancels the reservation without a call base; a
    // committed dispatch finalizes the explicit attached-minus-refunded charge
    // observed in its callback.
    public type OutgoingCycleReservation = {
        id : Nat;
        scope : AppScope;
        day : Nat64;
        attached : Nat;
        daily_budgeted : Bool;
        call_count : Nat;
    };

    public type OutgoingCycleAccounting = {
        reserve : (
            AppScope,
            Nat,
            ?Nat,
            Nat,
        ) -> ?OutgoingCycleReservation;
        commit : OutgoingCycleReservation -> Bool;
        cancel : OutgoingCycleReservation -> ();
        finalize : (OutgoingCycleReservation, Nat) -> ();
    };

    public type DaySnapshotV2 = {
        day : Nat64;
        instructions : Nat64;
        executions : Nat64;
        outgoing_cycles : Nat;
        incoming_cycles_accepted : Nat;
    };

    public type AppSnapshotV2 = {
        app_id : Text;
        installation_uid : Nat64;
        lifetime_instructions : Nat64;
        lifetime_executions : Nat64;
        lifetime_outgoing_cycles : Nat;
        lifetime_incoming_cycles_accepted : Nat;
        window_instructions : Nat64;
        window_executions : Nat64;
        window_outgoing_cycles : Nat;
        window_incoming_cycles_accepted : Nat;
        days : [DaySnapshotV2];
    };

    public type SnapshotV2 = {
        snapshot_version : Nat;
        current_day : Nat64;
        apps : [AppSnapshotV2];
    };
};
