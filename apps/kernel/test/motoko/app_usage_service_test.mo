import Map "mo:core/Map";
import Nat64 "mo:core/Nat64";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import CapabilityScope "../../backend/capabilities/Scope";
import Service "../../backend/app_usage/Service";
import Types "../../backend/app_usage/Types";

let DAY_NANOS : Nat64 = 86_400_000_000_000;
let MAX_NAT64 : Nat64 = 18_446_744_073_709_551_615;
let LARGE_CYCLE_TOTAL : Nat =
    340_282_366_920_938_463_463_374_607_431_768_211_455;

let alpha : Types.AppScope = { app_id = "alpha_app"; installation_uid = 11 };
let beta : Types.AppScope = { app_id = "beta_app"; installation_uid = 12 };
let gamma : Types.AppScope = { app_id = "gamma_app"; installation_uid = 13 };

var alphaActive = true;
var betaActive = true;
var gammaActive = true;
func scopeActive(scope : Types.AppScope) : Bool {
    (CapabilityScope.equal(scope, alpha) and alphaActive) or
    (CapabilityScope.equal(scope, beta) and betaActive) or
    (CapabilityScope.equal(scope, gamma) and gammaActive);
};

var currentDay : Nat64 = 100;
var counter : Nat64 = 100;
let mem = Service.init();
let service = Service.Service(
    mem,
    scopeActive,
    func() : Nat64 { currentDay * DAY_NANOS },
    func() : Nat64 { counter },
);

func measureWithFixedMessageCycles(
    scope : Types.AppScope,
    instructions : Nat64,
    fixedMessageCycles : Nat,
) : () {
    let measurement = service.beginInstructions(scope, fixedMessageCycles);
    counter += instructions;
    service.finishInstructions(measurement);
};

func measure(scope : Types.AppScope, instructions : Nat64) : () {
    measureWithFixedMessageCycles(scope, instructions, 0);
};

// Instructions aggregate into the same exact-installation/day spine used by
// outgoing-cycle telemetry.
measure(alpha, 250);
measure(alpha, 50);
let first = service.snapshot();
assert (first.snapshot_version == 2);
assert (first.current_day == 100);
assert (first.apps.size() == 1);
assert (first.apps[0].app_id == "alpha_app");
assert (first.apps[0].installation_uid == 11);
assert (first.apps[0].lifetime_instructions == 300);
assert (first.apps[0].lifetime_executions == 2);
assert (first.apps[0].lifetime_outgoing_cycles == 0);
assert (first.apps[0].lifetime_incoming_cycles_accepted == 0);
assert (first.apps[0].window_instructions == 300);
assert (first.apps[0].window_executions == 2);
assert (first.apps[0].window_outgoing_cycles == 0);
assert (first.apps[0].window_incoming_cycles_accepted == 0);
assert (first.apps[0].days == [{
    day = 100;
    instructions = 300;
    executions = 2;
    outgoing_cycles = 0;
    incoming_cycles_accepted = 0;
}]);

// Accepted payment is attributed independently from measured costs.
service.recordIncomingCycles(alpha, 123);
service.recordIncomingCycles(alpha, 0);
let afterIncome = service.snapshot().apps[0];
assert (afterIncome.lifetime_incoming_cycles_accepted == 123);
assert (afterIncome.window_incoming_cycles_accepted == 123);
assert (afterIncome.days[0].incoming_cycles_accepted == 123);
assert (afterIncome.lifetime_outgoing_cycles == 0);

// Kernel-priced brokers contribute explicit transfers plus one 260k low-side
// 13-node call base, but that base never consumes the caller-selected
// backend-call daily allowance.
let ?https = service.reserveOutgoingCycles(alpha, 80, null, 1) else Runtime.trap("reserve HTTPS");
let ?raw = service.reserveOutgoingCycles(alpha, 60, ?100, 1) else Runtime.trap("reserve raw");
assert (service.snapshot().apps[0].lifetime_outgoing_cycles == 140);

// A known pre-dispatch failure cancels only the explicit reservation. It
// records no call base and immediately reopens daily transfer headroom.
let ?cancelled = service.reserveOutgoingCycles(alpha, 40, ?100, 1) else Runtime.trap("reserve cancellation");
assert (service.reserveOutgoingCycles(alpha, 1, ?100, 1) == null);
service.cancelOutgoingReservation(cancelled);
service.cancelOutgoingReservation(cancelled);
assert (not service.commitOutgoingDispatch(cancelled));
assert (service.snapshot().apps[0].lifetime_outgoing_cycles == 140);
let ?reopenedAfterCancel = service.reserveOutgoingCycles(alpha, 40, ?100, 1) else Runtime.trap("cancellation did not reopen daily headroom");
service.cancelOutgoingReservation(reopenedAfterCancel);
assert (service.reserveOutgoingCycles(alpha, 50, ?100, 1) == null);

// Observed refunds reopen raw-call daily headroom. Finalization records net
// charged cycles and duplicate finalization cannot credit the refund twice.
let forgedRaw = { raw with call_count = 2 };
assert (not service.commitOutgoingDispatch(forgedRaw));
service.cancelOutgoingReservation(forgedRaw);
assert (service.commitOutgoingDispatch(raw));
assert (not service.commitOutgoingDispatch(raw));
service.cancelOutgoingReservation(raw);
service.finalizeOutgoingCycles(raw, 20);
let ?rawAfterRefund = service.reserveOutgoingCycles(alpha, 50, ?100, 1) else Runtime.trap("reserve after refund");
assert (service.commitOutgoingDispatch(https));
service.finalizeOutgoingCycles(https, 30);
assert (service.commitOutgoingDispatch(rawAfterRefund));
let afterCharges = service.snapshot().apps[0];
assert (afterCharges.lifetime_outgoing_cycles == 780_100); // Three call bases + 20 + 50 unresolved + 30
service.finalizeOutgoingCycles(https, 0);
assert (service.snapshot().apps[0].lifetime_outgoing_cycles == 780_100);
service.finalizeOutgoingCycles(rawAfterRefund, 10);
assert (service.snapshot().apps[0].lifetime_outgoing_cycles == 780_060);

// Zero attachment remains valid and still incurs the low-side call base.
let ?zero = service.reserveOutgoingCycles(alpha, 0, ?100, 1) else Runtime.trap("reserve zero");
assert (service.commitOutgoingDispatch(zero));
service.finalizeOutgoingCycles(zero, 999);
assert (service.snapshot().apps[0].lifetime_outgoing_cycles == 1_040_060);

// One aggregate reservation may dispatch several raw calls. Every dispatch
// contributes its own fixed base even when the aggregate attachment is zero.
let ?batch = service.reserveOutgoingCycles(alpha, 0, null, 3) else Runtime.trap("reserve batch");
assert (service.commitOutgoingDispatch(batch));
service.finalizeOutgoingCycles(batch, 0);
assert (service.snapshot().apps[0].lifetime_outgoing_cycles == 1_820_060);

// An inactive exact scope is neither counted nor returned.
betaActive := false;
measure(beta, 99);
service.recordIncomingCycles(beta, 99);
assert (service.reserveOutgoingCycles(beta, 1, null, 1) == null);
switch (Map.get(mem.by_scope, Text.compare, CapabilityScope.key(beta))) {
    case null {};
    case (?_) assert false;
};
betaActive := true;
measureWithFixedMessageCycles(
    beta,
    5,
    Service.INGRESS_MESSAGE_BASE_CYCLES,
);
measureWithFixedMessageCycles(
    beta,
    7,
    Service.INTERCANISTER_CALL_BASE_CYCLES,
);
service.recordIncomingCycles(beta, 77);
assert (service.snapshot().apps.size() == 2);
let ?betaUsage = Map.get(
    mem.by_scope,
    Text.compare,
    CapabilityScope.key(beta),
) else Runtime.trap("Missing beta app usage");
assert (betaUsage.lifetime_instructions == 12);
assert (betaUsage.lifetime_executions == 2);
assert (betaUsage.lifetime_outgoing_cycles_attached == 1_460_000);
assert (betaUsage.lifetime_incoming_cycles_accepted == 77);

// A performance-counter regression cannot become a wrapped delta.
let invalid = service.beginInstructions(alpha, 0);
counter := invalid.started_at - 1;
service.finishInstructions(invalid);
counter := invalid.started_at;
assert (service.snapshot().apps[0].lifetime_executions == 2);

// Thirty-one later days prune sparse daily data but retain lifetime totals.
var offset : Nat64 = 1;
while (offset <= 31) {
    currentDay := 100 + offset;
    measure(alpha, 1);
    offset += 1;
};
let ?alphaUsage = Map.get(
    mem.by_scope,
    Text.compare,
    CapabilityScope.key(alpha),
) else Runtime.trap("Missing alpha app usage");
assert (Map.size(alphaUsage.days) == 30);
assert (Map.get(alphaUsage.days, Nat64.compare, (101 : Nat64)) == null);
assert (Map.get(alphaUsage.days, Nat64.compare, (102 : Nat64)) != null);
let rolled = service.snapshot();
assert (rolled.current_day == 131);
assert (rolled.apps[0].lifetime_instructions == 331);
assert (rolled.apps[0].lifetime_executions == 33);
assert (rolled.apps[0].lifetime_outgoing_cycles == 1_820_060);
assert (rolled.apps[0].lifetime_incoming_cycles_accepted == 123);
assert (rolled.apps[0].window_instructions == 30);
assert (rolled.apps[0].window_executions == 30);
assert (rolled.apps[0].window_outgoing_cycles == 0);
assert (rolled.apps[0].window_incoming_cycles_accepted == 0);
assert (rolled.apps[0].days.size() == 30);
assert (rolled.apps[0].days[0].day == 102);
assert (rolled.apps[0].days[29].day == 131);

// A refund observed after its dispatch-day bucket was pruned still reduces the
// lifetime total. Only the absent daily bucket is intentionally not recreated.
currentDay := 132;
let ?longCall = service.reserveOutgoingCycles(alpha, 90, ?100, 1) else Runtime.trap("reserve long call");
assert (service.commitOutgoingDispatch(longCall));
currentDay := 163;
measure(alpha, 1);
assert (Map.get(alphaUsage.days, Nat64.compare, (132 : Nat64)) == null);
service.finalizeOutgoingCycles(longCall, 25);
assert (service.snapshot().apps[0].lifetime_outgoing_cycles == 2_080_085);

// Backward time is clamped to the latest replicated day.
currentDay := 150;
measure(alpha, 7);
let clamped = service.snapshot();
assert (clamped.current_day == 163);
assert (clamped.apps[0].days[clamped.apps[0].days.size() - 1].day == 163);

// Nat64 instruction/execution totals saturate instead of trapping. Cycle
// totals use exact unbounded Nat arithmetic, even above the former 2^128 cap.
let gammaDays = Map.empty<Nat64, Types.DayUsage>();
Map.add(gammaDays, Nat64.compare, (163 : Nat64), ({
    day = (163 : Nat64);
    instructions = MAX_NAT64 - 2;
    executions = MAX_NAT64;
    outgoing_cycles_attached = LARGE_CYCLE_TOTAL - 2;
    outgoing_cycles_refunded = LARGE_CYCLE_TOTAL - 4;
    backend_cycles_attached = 0;
    backend_cycles_refunded = 0;
    incoming_cycles_accepted = LARGE_CYCLE_TOTAL - 2;
} : Types.DayUsage));
Map.add(mem.by_scope, Text.compare, CapabilityScope.key(gamma), {
    scope = gamma;
    days = gammaDays;
    var lifetime_instructions = MAX_NAT64 - 2;
    var lifetime_executions = MAX_NAT64;
    var lifetime_outgoing_cycles_attached = LARGE_CYCLE_TOTAL - 2;
    var lifetime_outgoing_cycles_refunded = LARGE_CYCLE_TOTAL - 4;
    var lifetime_incoming_cycles_accepted = LARGE_CYCLE_TOTAL - 2;
});
measureWithFixedMessageCycles(
    gamma,
    10,
    Service.INGRESS_MESSAGE_BASE_CYCLES,
);
service.recordIncomingCycles(gamma, 10);
let saturated = service.snapshot();
assert (saturated.apps[2].lifetime_instructions == MAX_NAT64);
assert (saturated.apps[2].lifetime_executions == MAX_NAT64);
assert (saturated.apps[2].days[0].instructions == MAX_NAT64);
assert (saturated.apps[2].days[0].executions == MAX_NAT64);
assert (saturated.apps[2].lifetime_outgoing_cycles == 1_200_002);
assert (saturated.apps[2].days[0].outgoing_cycles == 1_200_002);
assert (
    saturated.apps[2].lifetime_incoming_cycles_accepted ==
    LARGE_CYCLE_TOTAL + 8
);
assert (
    saturated.apps[2].days[0].incoming_cycles_accepted ==
    LARGE_CYCLE_TOTAL + 8
);

// Uninstall removes the exact ledger, and an in-flight finalizer cannot
// recreate it or affect another installation.
let ?removed = service.reserveOutgoingCycles(beta, 10, null, 1) else Runtime.trap("reserve removed scope");
assert (service.commitOutgoingDispatch(removed));
service.removeScopes([beta, gamma]);
betaActive := false;
service.finalizeOutgoingCycles(removed, 10);
let cleaned = service.snapshot();
assert (cleaned.apps.size() == 1);
assert (cleaned.apps[0].app_id == "alpha_app");
