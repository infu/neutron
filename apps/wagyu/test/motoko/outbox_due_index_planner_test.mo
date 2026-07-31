import Array "mo:core/Array";
import Nat64 "mo:core/Nat64";
import Runtime "mo:core/Runtime";

import Planner "../../backend/outbox/DueIndexPlanner";
import OutboxService "../../backend/outbox/Service";

assert (Planner.MAX_BATCH == OutboxService.MAX_BATCH);
assert (Planner.MAX_SCAN == OutboxService.MAX_PLAN_SCAN);
assert (Planner.MAX_PAGE == Planner.MAX_SCAN + 1);

func entry(
    dueAt : Nat64,
    localId : Nat64,
    ready : Bool,
) : Planner.Entry {
    {
        key = (dueAt, localId);
        ready;
    };
};

// A full scan of due but ineligible rows advances to an exclusive cursor;
// the automatic row immediately behind them is reached on the next page.
let blockedPage = Array.tabulate<Planner.Entry>(
    Planner.MAX_PAGE,
    func(index : Nat) : Planner.Entry {
        entry(10, Nat64.fromNat(index + 1), index == Planner.MAX_SCAN);
    },
);
let blockedPlan = switch (Planner.plan(blockedPage, null, 10)) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("bounded due-index page was rejected");
};
assert (blockedPlan.local_ids == []);
assert (blockedPlan.scanned == Planner.MAX_SCAN);
assert (blockedPlan.next_after == ?((10 : Nat64), (200 : Nat64)));
assert (not blockedPlan.complete);

let tailPlan = switch (
    Planner.plan(
        [blockedPage[Planner.MAX_SCAN]],
        blockedPlan.next_after,
        10,
    )
) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("exclusive due-index continuation failed");
};
assert (tailPlan.local_ids == [(201 : Nat64)]);
assert (tailPlan.scanned == 1);
assert (tailPlan.next_after == ?((10 : Nat64), (201 : Nat64)));
assert (tailPlan.complete);

// Batch limiting advances exactly through the twentieth selected key.
let readyPage = Array.tabulate<Planner.Entry>(
    21,
    func(index : Nat) : Planner.Entry {
        entry(20, Nat64.fromNat(index + 1), true);
    },
);
let readyPlan = switch (Planner.plan(readyPage, null, 20)) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("ready due-index page was rejected");
};
assert (
    readyPlan.local_ids ==
    Array.tabulate<Nat64>(20, func(index : Nat) : Nat64 {
        Nat64.fromNat(index + 1);
    })
);
assert (readyPlan.scanned == Planner.MAX_BATCH);
assert (readyPlan.next_after == ?((20 : Nat64), (20 : Nat64)));
assert (not readyPlan.complete);

// The first future key proves that no later key is due, and is not consumed.
let futurePlan = switch (
    Planner.plan([entry(31, 1, true)], null, 30)
) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("future due-index key was rejected");
};
assert (futurePlan.local_ids == []);
assert (futurePlan.scanned == 0);
assert (futurePlan.next_after == null);
assert (futurePlan.complete);

switch (
    Planner.plan(
        [entry(10, 2, true), entry(10, 1, true)],
        null,
        10,
    )
) {
    case (#err(#corrupt_page)) {};
    case (_) Runtime.trap("unordered due-index page was accepted");
};
switch (
    Planner.plan(
        [entry(10, 2, true)],
        ?((10 : Nat64), (2 : Nat64)),
        10,
    )
) {
    case (#err(#corrupt_page)) {};
    case (_) Runtime.trap("non-exclusive due-index page was accepted");
};
switch (
    Planner.plan(
        Array.tabulate<Planner.Entry>(
            Planner.MAX_PAGE + 1,
            func(index : Nat) : Planner.Entry {
                entry(10, Nat64.fromNat(index + 1), false);
            },
        ),
        null,
        10,
    )
) {
    case (#err(#corrupt_page)) {};
    case (_) Runtime.trap("oversized due-index page was accepted");
};
