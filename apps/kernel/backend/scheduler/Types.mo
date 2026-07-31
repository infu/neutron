import CapabilityTypes "../capabilities/Types";

module {
    public type DeferredTimerPhaseV1 = {
        #waiting;
        #running;
    };

    public type DeferredTimerStatusV1 = {
        due_at_ns : Nat64;
        phase : DeferredTimerPhaseV1;
    };

    public type DeferredTimerErrorV1 = {
        #invalid;
        #full;
        #source_gone;
    };

    public type DeferredTimerArmInputV1 = {
        key : Text;
        delay_seconds : Nat;
        callback : () -> ();
    };

    public type DeferredTimerArmResultV1 = {
        #armed : DeferredTimerStatusV1;
        #already_armed : DeferredTimerStatusV1;
        #err : DeferredTimerErrorV1;
    };

    // Baseline app-scoped one-shot scheduling. The kernel retains the native
    // timer id; app code receives only its own bounded logical key.
    public type DeferredTimersV1 = {
        arm : DeferredTimerArmInputV1 -> async* DeferredTimerArmResultV1;
        status : Text -> ?DeferredTimerStatusV1;
    };

    // Read-only invocation liveness. Generated kernel wiring receives this
    // view and app code receives only handles whose operations consult it.
    public type InvocationLease = {
        active : () -> Bool;
    };

    public type Task = {
        app_scope : CapabilityTypes.AppScope;
        id : Text;
        method : Text;
        interval_seconds : Nat;
        run_on_start : Bool;
        max_backend_calls : Nat;
        callback : InvocationLease -> async ();
    };

    public type Summary = {
        app_id : Text;
        installation_uid : Nat64;
        id : Text;
        method : Text;
        interval_seconds : Nat;
        run_on_start : Bool;
        max_backend_calls : Nat;
        enabled : Bool;
        running : Bool;
    };
};
