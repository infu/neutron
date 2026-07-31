import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Text "mo:core/Text";
import CapabilityScope "../capabilities/Scope";
import Types "Types";

module {
    public let WINDOW_DAYS : Nat64 = 30;

    let DAY_NANOS : Nat64 = 86_400_000_000_000;
    let MAX_NAT64 : Nat64 = 18_446_744_073_709_551_615;
    // Current 13-node fixed ingress-reception and inter-canister
    // request/response costs. Per-byte transmission and response-callback
    // execution are deliberately omitted, making this a stable low-side
    // estimate.
    public let INGRESS_MESSAGE_BASE_CYCLES : Nat = 1_200_000;
    public let INTERCANISTER_CALL_BASE_CYCLES : Nat = 260_000;

    public func init() : Types.Memory {
        {
            by_scope = Map.empty<Text, Types.AppUsage>();
            var last_seen_at = 0;
            var next_outgoing_cycle_reservation_id = 1;
        };
    };

    // `instructionCounter` must be IC performance counter 1 in production.
    // Counter 1 spans awaits in this call context while excluding nested calls.
    public class Service(
        mem : Types.Memory,
        scopeActive : Types.AppScope -> Bool,
        nowNanos : () -> Nat64,
        instructionCounter : () -> Nat64,
    ) {
        // Runtime-only canonical records make commit/cancel/finalize
        // idempotent and reject a modified token that happens to reuse an
        // active id. An upgrade destroys old continuations, leaving a
        // committed dispatch's already-recorded attachment and call base
        // conservatively unresolved rather than inventing a refund.
        let outgoingReservations = Map.empty<Nat, {
            reservation : Types.OutgoingCycleReservation;
            var committed : Bool;
        }>();

        public func beginInstructions(
            scope : Types.AppScope,
            fixedMessageCycles : Nat,
        ) : Types.InstructionMeasurement {
            assert (
                fixedMessageCycles == 0 or
                fixedMessageCycles == INGRESS_MESSAGE_BASE_CYCLES or
                fixedMessageCycles == INTERCANISTER_CALL_BASE_CYCLES
            );
            recordFixedMessageCycles(scope, fixedMessageCycles);
            {
                scope;
                started_at = instructionCounter();
            };
        };

        public func finishInstructions(
            measurement : Types.InstructionMeasurement,
        ) : () {
            // Read first so bookkeeping is not attributed to the application.
            let finishedAt = instructionCounter();
            if (
                finishedAt < measurement.started_at or
                not scopeActive(measurement.scope)
            ) return;

            let day = effectiveNow() / DAY_NANOS;
            let delta = finishedAt - measurement.started_at;
            let usage = getOrCreate(measurement.scope);
            if (not CapabilityScope.equal(usage.scope, measurement.scope)) return;

            usage.lifetime_instructions := saturatingAdd64(
                usage.lifetime_instructions,
                delta,
            );
            usage.lifetime_executions := saturatingAdd64(
                usage.lifetime_executions,
                1,
            );
            let prior = dayUsage(usage.days, day);
            Map.add(usage.days, Nat64.compare, day, {
                prior with
                instructions = saturatingAdd64(prior.instructions, delta);
                executions = saturatingAdd64(prior.executions, 1);
            });
            prune(usage.days, day);
        };

        // Reserve only the app-authored transfer. The fixed call base is added
        // separately by commitOutgoingDispatch immediately before the first
        // remote await. This lets a known pre-dispatch failure cancel cleanly
        // without inventing a call cost.
        public func reserveOutgoingCycles(
            scope : Types.AppScope,
            attached : Nat,
            dailyLimit : ?Nat,
            callCount : Nat,
        ) : ?Types.OutgoingCycleReservation {
            assert (callCount > 0);
            if (not scopeActive(scope)) return null;
            let day = effectiveNow() / DAY_NANOS;
            let usage = getOrCreate(scope);
            if (not CapabilityScope.equal(usage.scope, scope)) return null;
            let prior = dayUsage(usage.days, day);
            let used = netCycles(
                prior.backend_cycles_attached,
                prior.backend_cycles_refunded,
            );
            switch (dailyLimit) {
                case (?limit) {
                    if (
                        used > limit or
                        attached > Nat.sub(limit, used)
                    ) return null;
                };
                case null {};
            };

            usage.lifetime_outgoing_cycles_attached += attached;
            Map.add(usage.days, Nat64.compare, day, {
                prior with
                outgoing_cycles_attached =
                    prior.outgoing_cycles_attached + attached;
                backend_cycles_attached = switch (dailyLimit) {
                    case (?_) prior.backend_cycles_attached + attached;
                    case null prior.backend_cycles_attached;
                };
            });
            prune(usage.days, day);

            let id = mem.next_outgoing_cycle_reservation_id;
            mem.next_outgoing_cycle_reservation_id += 1;
            let reservation = {
                id;
                scope;
                day;
                attached;
                daily_budgeted = dailyLimit != null;
                call_count = callCount;
            };
            Map.add(
                outgoingReservations,
                Nat.compare,
                id,
                {
                    reservation;
                    var committed = false;
                },
            );
            ?reservation;
        };

        // Commit exactly once at the dispatch boundary. The base is a platform
        // messaging cost, not part of an app-authored transfer allowance.
        public func commitOutgoingDispatch(
            reservation : Types.OutgoingCycleReservation,
        ) : Bool {
            let ?active = Map.get(
                outgoingReservations,
                Nat.compare,
                reservation.id,
            ) else return false;
            if (
                active.committed or
                not sameReservation(active.reservation, reservation) or
                not scopeActive(reservation.scope)
            ) return false;

            let scopeKey = CapabilityScope.key(reservation.scope);
            let ?usage = Map.get(mem.by_scope, Text.compare, scopeKey) else {
                return false;
            };
            if (not CapabilityScope.equal(usage.scope, reservation.scope)) {
                return false;
            };
            let ?prior = Map.get(
                usage.days,
                Nat64.compare,
                reservation.day,
            ) else return false;
            let callBaseCycles =
                INTERCANISTER_CALL_BASE_CYCLES * reservation.call_count;
            usage.lifetime_outgoing_cycles_attached += callBaseCycles;
            Map.add(usage.days, Nat64.compare, reservation.day, {
                prior with
                outgoing_cycles_attached =
                    prior.outgoing_cycles_attached + callBaseCycles;
            });
            active.committed := true;
            true;
        };

        public func cancelOutgoingReservation(
            reservation : Types.OutgoingCycleReservation,
        ) : () {
            let ?active = Map.get(
                outgoingReservations,
                Nat.compare,
                reservation.id,
            ) else return;
            if (
                active.committed or
                not sameReservation(active.reservation, reservation)
            ) return;
            ignore Map.delete(
                outgoingReservations,
                Nat.compare,
                reservation.id,
            );
            refundOutgoingAttachment(
                active.reservation,
                active.reservation.attached,
            );
        };

        public func finalizeOutgoingCycles(
            reservation : Types.OutgoingCycleReservation,
            charged : Nat,
        ) : () {
            // Only a committed dispatch can finalize. Remove first so duplicate
            // or forged finalization is a no-op.
            let ?active = Map.get(
                outgoingReservations,
                Nat.compare,
                reservation.id,
            ) else return;
            if (
                not active.committed or
                not sameReservation(active.reservation, reservation)
            ) return;
            ignore Map.delete(
                outgoingReservations,
                Nat.compare,
                reservation.id,
            );
            let canonical = active.reservation;
            let boundedCharge = Nat.min(charged, canonical.attached);
            let requestedRefund = Nat.sub(canonical.attached, boundedCharge);
            refundOutgoingAttachment(canonical, requestedRefund);
        };

        func refundOutgoingAttachment(
            reservation : Types.OutgoingCycleReservation,
            requestedRefund : Nat,
        ) : () {
            if (
                requestedRefund == 0 or
                not scopeActive(reservation.scope)
            ) return;
            let scopeKey = CapabilityScope.key(reservation.scope);
            let ?usage = Map.get(mem.by_scope, Text.compare, scopeKey) else return;
            if (not CapabilityScope.equal(usage.scope, reservation.scope)) return;
            let lifetimeOutstanding = netCycles(
                usage.lifetime_outgoing_cycles_attached,
                usage.lifetime_outgoing_cycles_refunded,
            );
            let refund = Nat.min(requestedRefund, lifetimeOutstanding);
            usage.lifetime_outgoing_cycles_refunded += refund;
            switch (Map.get(usage.days, Nat64.compare, reservation.day)) {
                case null {};
                case (?prior) {
                    let dayRefund = Nat.min(
                        refund,
                        netCycles(
                            prior.outgoing_cycles_attached,
                            prior.outgoing_cycles_refunded,
                        ),
                    );
                    let backendRefund = if (reservation.daily_budgeted) {
                        Nat.min(
                            refund,
                            netCycles(
                                prior.backend_cycles_attached,
                                prior.backend_cycles_refunded,
                            ),
                        );
                    } else 0;
                    Map.add(usage.days, Nat64.compare, reservation.day, {
                        prior with
                        outgoing_cycles_refunded =
                            prior.outgoing_cycles_refunded + dayRefund;
                        backend_cycles_refunded =
                            prior.backend_cycles_refunded + backendRefund;
                    });
                };
            };
        };

        // Attribute cycles that the kernel has accepted from a paid public
        // update to the exact receiving app installation. This is deliberately
        // independent from outgoing/cost telemetry: accepted cycles are app
        // revenue, not a negative cost.
        public func recordIncomingCycles(
            scope : Types.AppScope,
            cycles : Nat,
        ) : () {
            if (cycles == 0 or not scopeActive(scope)) return;
            let day = effectiveNow() / DAY_NANOS;
            let usage = getOrCreate(scope);
            if (not CapabilityScope.equal(usage.scope, scope)) return;
            let prior = dayUsage(usage.days, day);
            usage.lifetime_incoming_cycles_accepted += cycles;
            Map.add(usage.days, Nat64.compare, day, {
                prior with
                incoming_cycles_accepted =
                    prior.incoming_cycles_accepted + cycles;
            });
            prune(usage.days, day);
        };

        public func snapshot() : Types.SnapshotV2 {
            let observed = nowNanos();
            let timestamp = if (observed > mem.last_seen_at) observed else mem.last_seen_at;
            let currentDay = timestamp / DAY_NANOS;
            let firstDay = windowStart(currentDay);
            let apps = List.empty<Types.AppSnapshotV2>();

            for ((_, usage) in Map.entries(mem.by_scope)) {
                if (scopeActive(usage.scope)) {
                    let days = List.empty<Types.DaySnapshotV2>();
                    var windowInstructions : Nat64 = 0;
                    var windowExecutions : Nat64 = 0;
                    var windowOutgoingCycles : Nat = 0;
                    var windowIncomingCyclesAccepted : Nat = 0;
                    for ((day, value) in Map.entries(usage.days)) {
                        if (day >= firstDay and day <= currentDay) {
                            let outgoing = netCycles(
                                value.outgoing_cycles_attached,
                                value.outgoing_cycles_refunded,
                            );
                            List.add(days, {
                                day;
                                instructions = value.instructions;
                                executions = value.executions;
                                outgoing_cycles = outgoing;
                                incoming_cycles_accepted = value.incoming_cycles_accepted;
                            });
                            windowInstructions := saturatingAdd64(
                                windowInstructions,
                                value.instructions,
                            );
                            windowExecutions := saturatingAdd64(
                                windowExecutions,
                                value.executions,
                            );
                            windowOutgoingCycles += outgoing;
                            windowIncomingCyclesAccepted +=
                                value.incoming_cycles_accepted;
                        };
                    };
                    List.add(apps, {
                        app_id = usage.scope.app_id;
                        installation_uid = usage.scope.installation_uid;
                        lifetime_instructions = usage.lifetime_instructions;
                        lifetime_executions = usage.lifetime_executions;
                        lifetime_outgoing_cycles = netCycles(
                            usage.lifetime_outgoing_cycles_attached,
                            usage.lifetime_outgoing_cycles_refunded,
                        );
                        lifetime_incoming_cycles_accepted =
                            usage.lifetime_incoming_cycles_accepted;
                        window_instructions = windowInstructions;
                        window_executions = windowExecutions;
                        window_outgoing_cycles = windowOutgoingCycles;
                        window_incoming_cycles_accepted =
                            windowIncomingCyclesAccepted;
                        days = List.toArray(days);
                    });
                };
            };

            {
                snapshot_version = 2;
                current_day = currentDay;
                apps = List.toArray(apps);
            };
        };

        public func removeScopes(scopes : [Types.AppScope]) : () {
            for (scope in scopes.vals()) {
                ignore Map.delete(
                    mem.by_scope,
                    Text.compare,
                    CapabilityScope.key(scope),
                );
            };
        };

        func getOrCreate(scope : Types.AppScope) : Types.AppUsage {
            let scopeKey = CapabilityScope.key(scope);
            switch (Map.get(mem.by_scope, Text.compare, scopeKey)) {
                case (?current) current;
                case null {
                    let created : Types.AppUsage = {
                        scope;
                        days = Map.empty<Nat64, Types.DayUsage>();
                        var lifetime_instructions = 0;
                        var lifetime_executions = 0;
                        var lifetime_outgoing_cycles_attached = 0;
                        var lifetime_outgoing_cycles_refunded = 0;
                        var lifetime_incoming_cycles_accepted = 0;
                    };
                    Map.add(mem.by_scope, Text.compare, scopeKey, created);
                    created;
                };
            };
        };

        // The non-instruction cost bucket also retains non-refundable ingress
        // reception and timer self-call bases so Settings can compute one
        // low-side estimate.
        func recordFixedMessageCycles(
            scope : Types.AppScope,
            cycles : Nat,
        ) : () {
            if (cycles == 0 or not scopeActive(scope)) return;
            let day = effectiveNow() / DAY_NANOS;
            let usage = getOrCreate(scope);
            if (not CapabilityScope.equal(usage.scope, scope)) return;
            let prior = dayUsage(usage.days, day);
            usage.lifetime_outgoing_cycles_attached += cycles;
            Map.add(usage.days, Nat64.compare, day, {
                prior with
                outgoing_cycles_attached =
                    prior.outgoing_cycles_attached + cycles;
            });
            prune(usage.days, day);
        };

        func effectiveNow() : Nat64 {
            let observed = nowNanos();
            if (observed > mem.last_seen_at) mem.last_seen_at := observed;
            mem.last_seen_at;
        };
    };

    func dayUsage(
        days : Map.Map<Nat64, Types.DayUsage>,
        day : Nat64,
    ) : Types.DayUsage {
        switch (Map.get(days, Nat64.compare, day)) {
            case (?current) current;
            case null {
                {
                    day;
                    instructions = 0;
                    executions = 0;
                    outgoing_cycles_attached = 0;
                    outgoing_cycles_refunded = 0;
                    backend_cycles_attached = 0;
                    backend_cycles_refunded = 0;
                    incoming_cycles_accepted = 0;
                };
            };
        };
    };

    func prune(days : Map.Map<Nat64, Types.DayUsage>, currentDay : Nat64) : () {
        let firstDay = windowStart(currentDay);
        let stale = List.empty<Nat64>();
        for ((day, _) in Map.entries(days)) {
            if (day < firstDay or day > currentDay) List.add(stale, day);
        };
        for (day in List.values(stale)) {
            ignore Map.delete(days, Nat64.compare, day);
        };
    };

    func windowStart(currentDay : Nat64) : Nat64 {
        if (currentDay >= WINDOW_DAYS - 1) {
            currentDay - (WINDOW_DAYS - 1);
        } else 0;
    };

    func netCycles(attached : Nat, refunded : Nat) : Nat {
        if (refunded >= attached) 0 else attached - refunded;
    };

    func sameReservation(
        left : Types.OutgoingCycleReservation,
        right : Types.OutgoingCycleReservation,
    ) : Bool {
        left.id == right.id and
        CapabilityScope.equal(left.scope, right.scope) and
        left.day == right.day and
        left.attached == right.attached and
        left.daily_budgeted == right.daily_budgeted and
        left.call_count == right.call_count;
    };

    func saturatingAdd64(left : Nat64, right : Nat64) : Nat64 {
        if (right > MAX_NAT64 - left) MAX_NAT64 else left + right;
    };

};
