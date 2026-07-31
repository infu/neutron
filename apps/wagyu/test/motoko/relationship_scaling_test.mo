import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";

import Bounds "../../backend/protocol/Bounds";
import RelationshipService "../../backend/relationships/Service";
import Types "../../backend/relationships/Types";

func node(index : Nat) : Principal {
    Principal.fromBlob(
        Blob.fromArray([
            42,
            Nat8.fromNat(index / 256),
            Nat8.fromNat(index % 256),
            1,
        ])
    );
};

let selfNode = node(900);
let followPeer = node(901);
let subscription = Blob.fromArray(
    Array.repeat<Nat8>(
        1,
        RelationshipService.SUBSCRIPTION_ID_BYTES,
    )
);

// Exact Following occupancy transitions are constant-time and fail closed
// before a mutation can underflow or exceed the installation capacity.
assert (
    RelationshipService.followingCountAfterMutation(0, false, true, 5) ==
        ?1
);
assert (
    RelationshipService.followingCountAfterMutation(5, false, true, 5) ==
        null
);
assert (
    RelationshipService.followingCountAfterMutation(1, true, false, 5) ==
        ?0
);
assert (
    RelationshipService.followingCountAfterMutation(1, true, true, 5) ==
        ?1
);
assert (
    RelationshipService.followingCountAfterMutation(0, false, false, 5) ==
        ?0
);
assert (
    RelationshipService.followingCountAfterMutation(0, true, false, 5) ==
        null
);
assert (
    RelationshipService.followingCountAfterMutation(6, true, true, 5) ==
        null
);

var follower : ?Types.FollowerRow = null;
var counters : Types.FollowerCounters = {
    follower_revision = 0;
    max_registration_sequence = 0;
};
var followerMaterializations = 0;

let followState : Types.State = {
    follower = func(peer : Principal) : ?Types.FollowerRow {
        switch (follower) {
            case (?row) {
                if (Principal.equal(row.node, peer)) ?row else null;
            };
            case null null;
        };
    };
    followers = func() : [Types.FollowerRow] {
        followerMaterializations += 1;
        [];
    };
    followers_by_registration =
        func(_after : ?Nat64, _limit : Nat) : ?[Types.FollowerRow] {
            ?[];
        };
    active_follower_count = func() : Nat {
        switch (follower) {
            case null 0;
            case (?row) {
                switch (row.state) {
                    case (#active(_)) 1;
                    case (#inactive(_)) 0;
                };
            };
        };
    };
    follower_counters = func() : Types.FollowerCounters { counters };
    commit_follower = func(mutation : Types.FollowerMutation) : Bool {
        if (
            mutation.expected_storage_revision != null or
            mutation.expected_counters != counters
        ) return false;
        follower := ?mutation.next_row;
        counters := mutation.next_counters;
        true;
    };
    following = func(_peer : Principal) : ?Types.FollowingRow { null };
    following_count = func() : Nat { 0 };
    commit_following = func(_mutation : Types.FollowingMutation) : Bool {
        false;
    };
    block = func(_peer : Principal) : ?Types.BlockRow { null };
    block_count = func() : Nat { 0 };
    commit_block = func(_mutation : Types.BlockMutation) : Bool { false };
};

let estimator : Types.CostEstimator = {
    call_and_byte_cycles = func(_input : Types.CostEstimateInput) : ?Nat {
        ?0;
    };
    local_publication_cycles =
        func(_input : Types.CostEstimateInput) : ?Nat { ?0 };
};
let followService =
    RelationshipService.Service(followState, selfNode, estimator);
switch (
    followService.applyFollow(
        followPeer,
        {
            expected_revision = 0;
            subscription_id = subscription;
        },
        100,
    )
) {
    case (#accepted(_)) {};
    case (#err(_)) Runtime.trap("bounded Follow admission failed");
};
assert (followerMaterializations == 0);

func quoteRow(sequence : Nat64) : Types.FollowerRow {
    let eligible = sequence > 25;
    {
        node = node(Nat64.toNat(sequence));
        head_revision = 1;
        storage_revision = 1;
        state = #active({
            subscription_id = Blob.fromArray(
                Array.repeat<Nat8>(
                    Nat8.fromNat(
                        (Nat64.toNat(sequence) % 254) + 1
                    ),
                    RelationshipService.SUBSCRIPTION_ID_BYTES,
                )
            );
            lease_expires_ns = RelationshipService.LEASE_NS + 1;
            delivery_credits =
                Nat16.fromNat(if (eligible) 1 else 0);
        });
        registration_sequence = sequence;
        funded_at_ns = 1;
        delivery_pause = null;
        outstanding_delivery_charges = 0;
    };
};

let quoteRows = Array.tabulate<Types.FollowerRow>(
    520,
    func(index : Nat) : Types.FollowerRow {
        quoteRow(Nat64.fromNat(520 - index));
    },
);
var quoteMaterializations = 0;
var eligibilityChecks = 0;
var requestedLimit : ?Nat = null;
var estimatedDeliveries : ?Nat = null;

let quoteState : Types.State = {
    follower = func(_peer : Principal) : ?Types.FollowerRow { null };
    followers = func() : [Types.FollowerRow] {
        quoteMaterializations += 1;
        quoteRows;
    };
    followers_by_registration = func(
        afterSequence : ?Nat64,
        limit : Nat,
    ) : ?[Types.FollowerRow] {
        requestedLimit := ?limit;
        let ordered = Array.sort<Types.FollowerRow>(
            quoteRows,
            func(left, right) {
                Nat64.compare(
                    left.registration_sequence,
                    right.registration_sequence,
                );
            },
        );
        let remaining = Array.filter<Types.FollowerRow>(
            ordered,
            func(row) {
                switch (afterSequence) {
                    case null true;
                    case (?cursor) row.registration_sequence > cursor;
                };
            },
        );
        ?Array.tabulate<Types.FollowerRow>(
            Nat.min(limit, remaining.size()),
            func(index) { remaining[index] },
        );
    };
    active_follower_count = func() : Nat { quoteRows.size() };
    follower_counters = func() : Types.FollowerCounters {
        {
            follower_revision = 520;
            max_registration_sequence = 520;
        };
    };
    commit_follower = func(_mutation : Types.FollowerMutation) : Bool {
        false;
    };
    following = func(_peer : Principal) : ?Types.FollowingRow { null };
    following_count = func() : Nat { 0 };
    commit_following = func(_mutation : Types.FollowingMutation) : Bool {
        false;
    };
    block = func(_peer : Principal) : ?Types.BlockRow {
        eligibilityChecks += 1;
        null;
    };
    block_count = func() : Nat { 0 };
    commit_block = func(_mutation : Types.BlockMutation) : Bool { false };
};

let quoteService = RelationshipService.Service(
    quoteState,
    selfNode,
    {
        call_and_byte_cycles = func(input : Types.CostEstimateInput) : ?Nat {
            estimatedDeliveries := ?Nat32.toNat(input.delivery_count);
            ?0;
        };
        local_publication_cycles =
            func(_input : Types.CostEstimateInput) : ?Nat { ?0 };
    },
);
let quote = switch (
    quoteService.getSendQuote(
        {
            send_kind = ?#post;
            estimated_object_bytes = 1;
            notice_target = null;
        },
        100,
    )
) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("bounded send quote failed");
};
assert (quote.registered_follower_count == 520);
assert (quote.eligible_delivery_count == 495);
assert (quote.ineligible_follower_count == 25);
assert (
    quote.eligible_recipient_preview.size() ==
    Bounds.MAX_SEND_QUOTE_RECIPIENT_PREVIEW
);
assert (requestedLimit == ?RelationshipService.SEND_QUOTE_SCAN_LIMIT);
assert (eligibilityChecks == RelationshipService.SEND_QUOTE_SCAN_LIMIT);
assert (estimatedDeliveries == ?495);
assert (quoteMaterializations == 0);
