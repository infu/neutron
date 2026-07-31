import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";

import Planner "../../backend/fanout/OrderedFollowerPlanner";
import RelationshipService "../../backend/relationships/Service";
import Types "../../backend/relationships/Types";

assert (Planner.BATCH_LIMIT == RelationshipService.FANOUT_BATCH_LIMIT);
assert (Planner.MAX_PAGE == Planner.BATCH_LIMIT + 1);

func node(sequence : Nat64) : Principal {
    Principal.fromBlob(
        Blob.fromArray([42, Nat8.fromNat(Nat64.toNat(sequence)), 1])
    );
};

func target(sequence : Nat64) : Types.FanoutTarget {
    {
        node = node(sequence);
        subscription_id = Blob.fromArray(
            Array.repeat<Nat8>(
                Nat8.fromNat((Nat64.toNat(sequence) % 254) + 1),
                RelationshipService.SUBSCRIPTION_ID_BYTES,
            )
        );
        registration_sequence = sequence;
        follower_storage_revision = sequence;
    };
};

func page(first : Nat, last : Nat) : [Planner.Entry] {
    Array.tabulate<Planner.Entry>(
        last - first + 1,
        func(index : Nat) : Planner.Entry {
            let sequence = Nat64.fromNat(first + index);
            {
                registration_sequence = sequence;
                target = if (sequence > 25) {
                    ?target(sequence);
                } else null;
            };
        },
    );
};

let snapshot : Types.FanoutSnapshot = {
    follower_revision = 45;
    cutoff_registration_sequence = 45;
    finalized_at_ns = 100;
};

let first = switch (Planner.plan(snapshot, null, page(1, 21))) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("first ordered follower page failed");
};
assert (first.targets == []);
assert (first.next_after_sequence == ?(20 : Nat64));
assert (not first.complete);

let second = switch (
    Planner.plan(snapshot, first.next_after_sequence, page(21, 41))
) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("second ordered follower page failed");
};
assert (second.targets.size() == 15);
assert (second.targets[0].registration_sequence == 26);
assert (second.targets[14].registration_sequence == 40);
assert (second.next_after_sequence == ?(40 : Nat64));
assert (not second.complete);

// Sequence 46 was registered after the frozen snapshot. It acts as bounded
// lookahead and is neither returned nor consumed.
let final = switch (
    Planner.plan(snapshot, second.next_after_sequence, page(41, 46))
) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("final ordered follower page failed");
};
assert (final.targets.size() == 5);
assert (final.targets[0].registration_sequence == 41);
assert (final.targets[4].registration_sequence == 45);
assert (final.next_after_sequence == ?(45 : Nat64));
assert (final.complete);

// Ineligible rows are consumed without entering the target page.
let ineligible = switch (
    Planner.plan(
        snapshot,
        ?(40 : Nat64),
        [{
            registration_sequence = 41;
            target = null;
        }],
    )
) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("ineligible follower page failed");
};
assert (ineligible.targets == []);
assert (ineligible.next_after_sequence == ?(41 : Nat64));
assert (ineligible.complete);

switch (
    Planner.plan(
        snapshot,
        ?(20 : Nat64),
        [{
            registration_sequence = 20;
            target = null;
        }],
    )
) {
    case (#err(#corrupt_state)) {};
    case (_) Runtime.trap("non-exclusive follower page was accepted");
};
switch (
    Planner.plan(
        snapshot,
        null,
        Array.tabulate<Planner.Entry>(
            Planner.MAX_PAGE + 1,
            func(index : Nat) : Planner.Entry {
                {
                    registration_sequence = Nat64.fromNat(index + 1);
                    target = null;
                };
            },
        ),
    )
) {
    case (#err(#corrupt_state)) {};
    case (_) Runtime.trap("oversized follower page was accepted");
};
