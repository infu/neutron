import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Nat16 "mo:core/Nat16";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";

import OutboxService "../../backend/outbox/Service";
import OutboxTypes "../../backend/outbox/Types";
import Bounds "../../backend/protocol/Bounds";
import ProtocolTypes "../../backend/protocol/Types";
import ProtocolWire "../../backend/protocol/Wire";
import RelationshipService "../../backend/relationships/Service";
import RelationshipTypes "../../backend/relationships/Types";
import Dispatcher "../../backend/transport/Dispatcher";
import Policy "../../backend/transport/Policy";
import TransportTypes "../../backend/transport/Types";

func appendArray<Value>(values : [Value], value : Value) : [Value] {
    Array.tabulate<Value>(
        values.size() + 1,
        func(index) {
            if (index < values.size()) values[index] else value
        },
    )
};

let selfNode = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
let peer = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
let subscription = Blob.fromArray(Array.repeat<Nat8>(1, 16));
let operation = Blob.fromArray(Array.repeat<Nat8>(2, 16));

var follower : ?RelationshipTypes.FollowerRow = null;
var following : ?RelationshipTypes.FollowingRow = null;
var blocked : ?RelationshipTypes.BlockRow = null;
var followerCounters : RelationshipTypes.FollowerCounters = {
    follower_revision = 0;
    max_registration_sequence = 0;
};
var rejectBlockCommit = false;
var followerMaterializations = 0;

func followerExpected(
    expected : ?Nat64,
    current : ?RelationshipTypes.FollowerRow,
) : Bool {
    switch (expected, current) {
        case (null, null) true;
        case (?revision, ?row) revision == row.storage_revision;
        case (_) false;
    };
};

func canApplyFollowerMutation(
    mutation : RelationshipTypes.FollowerMutation,
) : Bool {
    Principal.equal(mutation.node, mutation.next_row.node) and
    followerExpected(mutation.expected_storage_revision, follower) and
    mutation.expected_counters == followerCounters;
};

func applyFollowerMutation(
    mutation : RelationshipTypes.FollowerMutation,
) : Bool {
    if (not canApplyFollowerMutation(mutation)) return false;
    follower := ?mutation.next_row;
    followerCounters := mutation.next_counters;
    true;
};

let relationshipState : RelationshipTypes.State = {
    follower = func(node : Principal) : ?RelationshipTypes.FollowerRow {
        switch (follower) {
            case (?row) {
                if (Principal.equal(row.node, node)) ?row else null;
            };
            case null null;
        };
    };
    followers = func() : [RelationshipTypes.FollowerRow] {
        followerMaterializations += 1;
        switch (follower) {
            case (?row) [row];
            case null [];
        };
    };
    followers_by_registration = func(
        afterSequence : ?Nat64,
        limit : Nat,
    ) : ?[RelationshipTypes.FollowerRow] {
        if (limit == 0) return ?[];
        switch (follower) {
            case (?row) {
                let strictlyAfter = switch (afterSequence) {
                    case null true;
                    case (?cursor) row.registration_sequence > cursor;
                };
                if (strictlyAfter) ?[row] else ?[];
            };
            case null ?[];
        };
    };
    active_follower_count = func() : Nat {
        switch (follower) {
            case (?row) {
                switch (row.state) {
                    case (#active(_)) 1;
                    case (#inactive(_)) 0;
                };
            };
            case null 0;
        };
    };
    follower_counters = func() : RelationshipTypes.FollowerCounters {
        followerCounters;
    };
    commit_follower = applyFollowerMutation;
    following = func(node : Principal) : ?RelationshipTypes.FollowingRow {
        switch (following) {
            case (?row) {
                if (Principal.equal(row.node, node)) ?row else null;
            };
            case null null;
        };
    };
    following_count = func() : Nat {
        switch (following) {
            case (?row) {
                if (
                    RelationshipService.followingIntentOccupiesCapacity(
                        row.intent
                    )
                ) 1 else 0;
            };
            case null 0;
        };
    };
    commit_following = func(
        mutation : RelationshipTypes.FollowingMutation
    ) : Bool {
        let expected = switch (
            mutation.expected_storage_revision,
            following,
        ) {
            case (null, null) true;
            case (?revision, ?row) revision == row.storage_revision;
            case (_) false;
        };
        if (
            not expected or
            not Principal.equal(mutation.node, mutation.next_row.node)
        ) return false;
        following := ?mutation.next_row;
        true;
    };
    block = func(node : Principal) : ?RelationshipTypes.BlockRow {
        switch (blocked) {
            case (?row) {
                if (Principal.equal(row.node, node)) ?row else null;
            };
            case null null;
        };
    };
    block_count = func() : Nat {
        switch (blocked) {
            case null 0;
            case (?_) 1;
        };
    };
    commit_block = func(
        mutation : RelationshipTypes.BlockMutation
    ) : Bool {
        let blockExpected = switch (
            mutation.expected_storage_revision,
            blocked,
        ) {
            case (null, null) true;
            case (?revision, ?row) revision == row.storage_revision;
            case (_) false;
        };
        let followingExpected = switch (mutation.following_mutation) {
            case null true;
            case (?change) {
                switch (
                    change.expected_storage_revision,
                    following,
                ) {
                    case (?revision, ?row) {
                        revision == row.storage_revision;
                    };
                    case (_) false;
                };
            };
        };
        let followerMutationExpected = switch (
            mutation.follower_mutation
        ) {
            case null true;
            case (?change) canApplyFollowerMutation(change);
        };
        if (
            not blockExpected or
            not followingExpected or
            not followerMutationExpected or
            mutation.expected_counters != followerCounters or
            rejectBlockCommit
        ) {
            rejectBlockCommit := false;
            return false;
        };
        blocked := mutation.next_row;
        switch (mutation.following_mutation) {
            case (?change) following := ?change.next_row;
            case null {};
        };
        switch (mutation.follower_mutation) {
            case (?change) follower := ?change.next_row;
            case null {};
        };
        followerCounters := mutation.next_counters;
        true;
    };
};

let relationships = RelationshipService.Service(
    relationshipState,
    selfNode,
    {
        call_and_byte_cycles = func(
            _input : RelationshipTypes.CostEstimateInput
        ) : ?Nat { ?0 };
        local_publication_cycles = func(
            _input : RelationshipTypes.CostEstimateInput
        ) : ?Nat { ?0 };
    },
);

let followRequest : RelationshipTypes.FollowRequest = {
    expected_revision = 0;
    subscription_id = subscription;
};
let followResult : RelationshipTypes.FollowResult =
    relationships.applyFollow(peer, followRequest, (100 : Nat64));
assert (followerMaterializations == 0);
switch (followResult) {
    case (#accepted(accepted)) {
        assert (accepted.activation);
        assert (accepted.head.revision == 1);
    };
    case (#err(_)) Runtime.trap("initial follow failed");
};

let ?afterFollow = follower else Runtime.trap("follower was not committed");
assert (afterFollow.funded_at_ns == 100);
switch (afterFollow.state) {
    case (#active(active)) {
        assert (Blob.equal(active.subscription_id, subscription));
        assert (
            active.lease_expires_ns ==
            afterFollow.funded_at_ns + RelationshipService.LEASE_NS
        );
        assert (
            Nat16.toNat(active.delivery_credits) ==
            RelationshipService.FOLLOW_CREDIT_TRANCHE
        );
    };
    case (#inactive(_)) Runtime.trap("fresh follow was inactive");
};
assert (Nat16.toNat(afterFollow.outstanding_delivery_charges) == 0);

let calls : TransportTypes.BackendCallPort = {
    can_call = func(_canister : Principal, _method : Text) : Bool { true };
    call = func(
        _request : TransportTypes.BackendCallRequestV1,
    ) : async* TransportTypes.BackendCallResultV1 {
        #err({ code = "unused"; message = "unused" });
    };
    call_batch = func(
        _requests : [TransportTypes.BackendCallRequestV1],
    ) : async* [TransportTypes.BackendCallResultV1] {
        [];
    };
};
let dispatcher = Dispatcher.Dispatcher(selfNode, calls);
let body : ProtocolTypes.DeliverBodyV1 = {
    subscription_id = subscription;
    renewal_requested = false;
    event = ?#original(Blob.fromArray([7]));
};
let exactBody = ProtocolWire.encodeDeliverBody(body);
let prepared = switch (dispatcher.prepare({
    target = peer;
    route = Bounds.DELIVER_ROUTE;
    operation_id = operation;
    exact_body_candid = exactBody;
    created_at_ns = 200;
})) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("delivery preparation failed");
};
assert (dispatcher.validPrepared(prepared));
let originalCallArgs = prepared.exact_call_args;

var item : ?OutboxTypes.Item = null;
var control : OutboxTypes.Control = { revision = 0; pause = null };
var commitCount = 0;
var lastCommitHadFollower = false;
var lastCommitHadControl = false;
var rejectNextCommit = false;

func itemExpected(
    expected : ?Nat64,
    current : ?OutboxTypes.Item,
) : Bool {
    switch (expected, current) {
        case (null, null) true;
        case (?revision, ?stored) revision == stored.storage_revision;
        case (_) false;
    };
};

func controlExpected(mutation : ?OutboxTypes.ControlMutation) : Bool {
    switch (mutation) {
        case null true;
        case (?change) change.expected_revision == control.revision;
    };
};

func followerMutationExpected(
    mutation : ?RelationshipTypes.FollowerMutation,
) : Bool {
    switch (mutation) {
        case null true;
        case (?change) canApplyFollowerMutation(change);
    };
};

func commitOutbox(mutation : OutboxTypes.Mutation) : Bool {
    if (
        mutation.local_id != mutation.next_item.local_id or
        not itemExpected(mutation.expected_storage_revision, item) or
        not followerMutationExpected(mutation.follower_mutation) or
        not controlExpected(mutation.control_mutation)
    ) return false;
    if (rejectNextCommit) {
        rejectNextCommit := false;
        return false;
    };

    // The fake validates every CAS before changing any component, mirroring
    // the atomic adapter contract used by managed memory.
    item := ?mutation.next_item;
    switch (mutation.follower_mutation) {
        case (?change) {
            follower := ?change.next_row;
            followerCounters := change.next_counters;
        };
        case null {};
    };
    switch (mutation.control_mutation) {
        case (?change) { control := change.next };
        case null {};
    };
    commitCount += 1;
    lastCommitHadFollower := mutation.follower_mutation != null;
    lastCommitHadControl := mutation.control_mutation != null;
    true;
};

func commitControl(mutation : OutboxTypes.ControlMutation) : Bool {
    if (mutation.expected_revision != control.revision) return false;
    control := mutation.next;
    true;
};

func findOperation(
    target : Principal,
    route : Text,
    operationId : Blob,
) : ?OutboxTypes.Item {
    switch (item) {
        case (?stored) {
            if (
                Principal.equal(stored.prepared.target, target) and
                stored.prepared.route == route and
                Blob.equal(stored.prepared.operation_id, operationId)
            ) ?stored else null;
        };
        case null null;
    };
};

func pageAfter(after : ?Nat64, limit : Nat) : [OutboxTypes.Item] {
    if (limit == 0) return [];
    switch (item) {
        case (?stored) {
            switch (after) {
                case (?cursor) {
                    if (stored.local_id > cursor) [stored] else [];
                };
                case null [stored];
            };
        };
        case null [];
    };
};

let outboxState : OutboxTypes.State = {
    item = func(localId : Nat64) : ?OutboxTypes.Item {
        switch (item) {
            case (?stored) {
                if (stored.local_id == localId) ?stored else null;
            };
            case null null;
        };
    };
    find_operation = findOperation;
    count = func() : Nat {
        switch (item) {
            case null 0;
            case (?_) 1;
        };
    };
    page_after = pageAfter;
    due_page = func(
        afterLocalId : ?Nat64,
        limit : Nat,
    ) : ?OutboxTypes.DueIndexPage {
        var afterKey : ?OutboxTypes.DueIndexKey = null;
        let entries : [OutboxTypes.DueIndexEntry] = switch (item) {
            case null [];
            case (?stored) {
                switch (stored.next_attempt_at_ns) {
                    case null [];
                    case (?retryAt) {
                        let key = (retryAt, stored.local_id);
                        if (afterLocalId == ?stored.local_id) {
                            afterKey := ?key;
                            [];
                        } else if (limit == 0) {
                            [];
                        } else {
                            [{ key; item = stored }];
                        };
                    };
                };
            };
        };
        ?{ after_key = afterKey; entries };
    };
    control = func() : OutboxTypes.Control { control };
    commit = commitOutbox;
    commit_control = commitControl;
};

let outbox = OutboxService.Service(
    outboxState,
    relationships.creditPlanner(),
    dispatcher.validPrepared,
);

let enqueueRequest : OutboxTypes.EnqueueRequest = {
    local_id = 1;
    prepared;
    delivery_subscription_id = ?subscription;
    encoded_renewal_requested = ?false;
};

// A rejected multi-row commit cannot retain an item or consume a credit.
rejectNextCommit := true;
switch (outbox.enqueue(enqueueRequest, (200 : Nat64))) {
    case (#err(#state_conflict)) {};
    case (_) Runtime.trap("rejected enqueue did not report state conflict");
};
assert (commitCount == 0);
assert (item == null);
let ?afterRejectedEnqueue = follower else {
    Runtime.trap("rejected enqueue removed follower");
};
switch (afterRejectedEnqueue.state) {
    case (#active(active)) {
        assert (Nat16.toNat(active.delivery_credits) == 32);
    };
    case (#inactive(_)) Runtime.trap("rejected enqueue deactivated follower");
};
assert (
    Nat16.toNat(afterRejectedEnqueue.outstanding_delivery_charges) == 0
);

let queued = switch (outbox.enqueue(enqueueRequest, (200 : Nat64))) {
    case (#queued(value)) value;
    case (_) Runtime.trap("delivery enqueue failed");
};
assert (commitCount == 1);
assert (lastCommitHadFollower);
assert (not lastCommitHadControl);
assert (OutboxService.exactPreparedEqual(queued.prepared, prepared));
assert (Blob.equal(queued.prepared.exact_call_args, originalCallArgs));

let ?afterDebit = follower else Runtime.trap("debit removed follower");
assert (afterDebit.funded_at_ns == afterFollow.funded_at_ns);
switch (afterDebit.state) {
    case (#active(active)) {
        assert (Nat16.toNat(active.delivery_credits) == 31);
    };
    case (#inactive(_)) Runtime.trap("debit deactivated follower");
};
assert (Nat16.toNat(afterDebit.outstanding_delivery_charges) == 1);

// An exact operation replay returns the durable item without charging again.
switch (outbox.enqueue(enqueueRequest, (200 : Nat64))) {
    case (#existing(existing)) {
        assert (OutboxService.exactPreparedEqual(existing.prepared, prepared));
    };
    case (_) Runtime.trap("exact enqueue replay was not idempotent");
};
assert (commitCount == 1);

let plan = switch (outbox.planBatch({
    after_local_id = null;
    mode = #automatic;
    now_ns = 200;
})) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("outbox plan failed");
};
assert (plan.local_ids == [1]);

let started = switch (outbox.beginDispatch(
    1,
    #automatic,
    (201 : Nat64),
)) {
    case (#dispatch(value)) value;
    case (#err(_)) Runtime.trap("outbox begin failed");
};
assert (started.attempt_no == 1);
assert (OutboxService.exactPreparedEqual(started.prepared, prepared));
assert (Blob.equal(started.prepared.exact_call_args, originalCallArgs));

let definitePreDispatch = Policy.backendError({
    code = "low_cycles";
    message = "local node balance below policy floor";
});
assert (definitePreDispatch.certainty == #not_dispatched);
let finishRequest : OutboxTypes.FinishRequest = {
    local_id = 1;
    attempt_no = started.attempt_no;
    result = definitePreDispatch;
    callback_time_ns = 202;
    jitter = 0;
};

// A rejected finish commit cannot restore the follower or pause the node
// without also transitioning the exact outbox item.
rejectNextCommit := true;
switch (outbox.finishDispatch(finishRequest)) {
    case (#err(#state_conflict)) {};
    case (_) Runtime.trap("rejected finish did not report state conflict");
};
assert (commitCount == 2);
let ?afterRejectedFinishItem = item else {
    Runtime.trap("rejected finish removed item");
};
assert (afterRejectedFinishItem.state == #sending);
assert (
    OutboxService.exactPreparedEqual(
        afterRejectedFinishItem.prepared,
        prepared,
    )
);
let ?afterRejectedFinishFollower = follower else {
    Runtime.trap("rejected finish removed follower");
};
assert (
    afterRejectedFinishFollower.funded_at_ns ==
    afterFollow.funded_at_ns
);
switch (afterRejectedFinishFollower.state) {
    case (#active(active)) {
        assert (Nat16.toNat(active.delivery_credits) == 31);
    };
    case (#inactive(_)) Runtime.trap("rejected finish deactivated follower");
};
assert (
    Nat16.toNat(
        afterRejectedFinishFollower.outstanding_delivery_charges
    ) == 1
);
assert (control.pause == null);

let finished = switch (outbox.finishDispatch(finishRequest)) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("outbox finish failed");
};

// Item, restored follower credit, and node control pause are one commit.
assert (commitCount == 3);
assert (lastCommitHadFollower);
assert (lastCommitHadControl);
assert (finished.state == #paused);
assert (finished.retry_permission == #local_state_change);
assert (finished.pending_credit_charge == null);
assert (OutboxService.exactPreparedEqual(finished.prepared, prepared));
assert (Blob.equal(finished.prepared.exact_call_args, originalCallArgs));
assert (control.pause == ?#low_cycles);
assert (control.revision == 1);

let ?afterRestore = follower else Runtime.trap("restore removed follower");
assert (afterRestore.funded_at_ns == afterFollow.funded_at_ns);
switch (afterRestore.state) {
    case (#active(active)) {
        assert (
            Nat16.toNat(active.delivery_credits) ==
            RelationshipService.FOLLOW_CREDIT_TRANCHE
        );
    };
    case (#inactive(_)) Runtime.trap("restore deactivated follower");
};
assert (Nat16.toNat(afterRestore.outstanding_delivery_charges) == 0);
assert (afterRestore.storage_revision == 3);
assert (followerCounters.follower_revision == 3);
assert (finished.storage_revision == 3);

// Only another accepted paid Follow moves the funding/retention anchor.
let renewalResult : RelationshipTypes.FollowResult =
    relationships.applyFollow(
        peer,
        {
            expected_revision = 1;
            subscription_id = subscription;
        },
        (300 : Nat64),
    );
switch (renewalResult) {
    case (#accepted(accepted)) {
        assert (not accepted.activation);
        assert (accepted.head.revision == 2);
    };
    case (#err(_)) Runtime.trap("paid renewal failed");
};
let ?afterRenewal = follower else Runtime.trap("renewal removed follower");
assert (afterRenewal.funded_at_ns == 300);
switch (afterRenewal.state) {
    case (#active(active)) {
        assert (
            active.lease_expires_ns ==
            afterRenewal.funded_at_ns + RelationshipService.LEASE_NS
        );
        assert (Nat16.toNat(active.delivery_credits) == 64);
    };
    case (#inactive(_)) Runtime.trap("renewal deactivated follower");
};

let unfollowResult : RelationshipTypes.UnfollowResult =
    relationships.applyUnfollow(
        peer,
        {
            expected_revision = 2;
            subscription_id = subscription;
        },
    );
switch (unfollowResult) {
    case (#accepted(head)) {
        assert (head.revision == 3);
    };
    case (#err(_)) Runtime.trap("unfollow failed");
};
let ?afterUnfollow = follower else Runtime.trap("unfollow removed follower");
assert (afterUnfollow.funded_at_ns == afterRenewal.funded_at_ns);
assert (RelationshipService.validFollowerRow(afterUnfollow));

// Every active renewal grants only the room that remains under the cap.
// Outstanding charges count toward that room and remain reserved.
let quietFundedAtNs : Nat64 = 1_000;
let quietLeaseExpiresNs =
    quietFundedAtNs + RelationshipService.LEASE_NS;
follower := ?{
    node = peer;
    head_revision = 10;
    storage_revision = 10;
    state = #active({
        subscription_id = subscription;
        lease_expires_ns = quietLeaseExpiresNs;
        delivery_credits = 96;
    });
    registration_sequence = 1;
    funded_at_ns = quietFundedAtNs;
    delivery_pause = null;
    outstanding_delivery_charges = 1;
};
followerCounters := {
    follower_revision = 10;
    max_registration_sequence = 1;
};

let beforeRenewalWindowNs =
    quietLeaseExpiresNs -
    RelationshipService.AUTO_RENEW_BEFORE_EXPIRY_NS -
    (1 : Nat64);
switch (
    relationships.applyFollow(
        peer,
        {
            expected_revision = 10;
            subscription_id = subscription;
        },
        beforeRenewalWindowNs,
    )
) {
    case (#accepted(accepted)) {
        assert (not accepted.activation);
        assert (accepted.head.revision == 11);
    };
    case (#err(_)) Runtime.trap("room-sized early renewal failed");
};
let ?afterEarlyRenewal = follower else {
    Runtime.trap("early renewal removed follower");
};
assert (afterEarlyRenewal.head_revision == 11);
assert (afterEarlyRenewal.storage_revision == 11);
assert (afterEarlyRenewal.funded_at_ns == beforeRenewalWindowNs);
let earlyActive = switch (afterEarlyRenewal.state) {
    case (#active(active)) active;
    case (#inactive(_)) Runtime.trap("early renewal deactivated follower");
};
assert (Nat16.toNat(earlyActive.delivery_credits) == 127);
assert (
    Nat16.toNat(afterEarlyRenewal.outstanding_delivery_charges) == 1
);
assert (followerCounters.follower_revision == 11);

let renewalWindowBoundaryNs =
    quietLeaseExpiresNs -
    RelationshipService.AUTO_RENEW_BEFORE_EXPIRY_NS;
switch (
    relationships.applyFollow(
        peer,
        {
            expected_revision = 11;
            subscription_id = subscription;
        },
        renewalWindowBoundaryNs,
    )
) {
    case (#accepted(accepted)) {
        assert (not accepted.activation);
        assert (accepted.head.revision == 12);
    };
    case (#err(_)) Runtime.trap("lease-only boundary renewal failed");
};
let ?afterPartialRenewal = follower else {
    Runtime.trap("partial renewal removed follower");
};
assert (afterPartialRenewal.funded_at_ns == renewalWindowBoundaryNs);
assert (
    Nat16.toNat(afterPartialRenewal.outstanding_delivery_charges) == 1
);
let partialActive = switch (afterPartialRenewal.state) {
    case (#active(active)) active;
    case (#inactive(_)) Runtime.trap("partial renewal deactivated follower");
};
assert (Nat16.toNat(partialActive.delivery_credits) == 127);
assert (
    partialActive.lease_expires_ns ==
    renewalWindowBoundaryNs + RelationshipService.LEASE_NS
);

// At the combined 128-credit cap, an expired relationship can renew its
// lease without minting another credit.
let leaseOnlyAtNs = partialActive.lease_expires_ns;
switch (
    relationships.applyFollow(
        peer,
        {
            expected_revision = 12;
            subscription_id = subscription;
        },
        leaseOnlyAtNs,
    )
) {
    case (#accepted(accepted)) {
        assert (not accepted.activation);
        assert (accepted.head.revision == 13);
    };
    case (#err(_)) Runtime.trap("expired lease-only renewal failed");
};
let ?afterLeaseOnlyRenewal = follower else {
    Runtime.trap("lease-only renewal removed follower");
};
assert (afterLeaseOnlyRenewal.funded_at_ns == leaseOnlyAtNs);
assert (
    Nat16.toNat(afterLeaseOnlyRenewal.outstanding_delivery_charges) == 1
);
switch (afterLeaseOnlyRenewal.state) {
    case (#active(active)) {
        assert (Nat16.toNat(active.delivery_credits) == 127);
        assert (
            active.lease_expires_ns ==
            leaseOnlyAtNs + RelationshipService.LEASE_NS
        );
    };
    case (#inactive(_)) {
        Runtime.trap("lease-only renewal deactivated follower");
    };
};
assert (followerCounters.follower_revision == 13);

// After each 28-delivery epoch reaches steady state, 100 credits remain.
// The next early renewal grants exactly 28 instead of rejecting or exceeding
// the combined 128-credit ceiling.
follower := ?{
    afterLeaseOnlyRenewal with
    head_revision = 20;
    storage_revision = 20;
    state = #active({
        subscription_id = subscription;
        lease_expires_ns = leaseOnlyAtNs + RelationshipService.LEASE_NS;
        delivery_credits = 100;
    });
    outstanding_delivery_charges = 0;
};
followerCounters := {
    follower_revision = 20;
    max_registration_sequence = 1;
};
switch (
    relationships.applyFollow(
        peer,
        {
            expected_revision = 20;
            subscription_id = subscription;
        },
        leaseOnlyAtNs + (1 : Nat64),
    )
) {
    case (#accepted(accepted)) {
        assert (accepted.head.revision == 21);
    };
    case (#err(_)) Runtime.trap("steady-state 28-credit renewal failed");
};
let ?afterSteadyRenewal = follower else {
    Runtime.trap("steady renewal removed follower");
};
switch (afterSteadyRenewal.state) {
    case (#active(active)) {
        assert (Nat16.toNat(active.delivery_credits) == 128);
    };
    case (#inactive(_)) Runtime.trap("steady renewal deactivated follower");
};

// A Deliver renewal hint belongs to the current local Follow intent. Remote
// failures and callbacks for older intents must not clear it.
following := ?{
    node = peer;
    intent_generation = 6;
    storage_revision = 1;
    intent = #on({
        subscription_id = subscription;
        status = #active;
    });
    last_remote_revision = ?3;
    renewal_requested = true;
    locally_verified_delivery_count = 17;
    updated_at_ns = 400;
};
let renewalStarted = switch (
    relationships.beginFollowing(
        {
            node = peer;
            expected_intent_generation = 6;
            subscription_id = subscription;
        },
        450,
    )
) {
    case (#ok(row)) row;
    case (#err(_)) Runtime.trap("same-subscription renewal did not start");
};
assert (renewalStarted.intent_generation == 7);
assert (renewalStarted.updated_at_ns == 400);
assert (
    Nat16.toNat(renewalStarted.locally_verified_delivery_count) == 17
);
assert (
    RelationshipService.followDispatchAuthorized(
        renewalStarted,
        7,
        subscription,
        true,
        false,
        false,
        false,
    )
);
assert (
    not RelationshipService.followDispatchAuthorized(
        renewalStarted,
        6,
        subscription,
        true,
        false,
        false,
        false,
    )
);
assert (
    not RelationshipService.followDispatchAuthorized(
        renewalStarted,
        7,
        subscription,
        false,
        true,
        false,
        false,
    )
);
assert (
    not RelationshipService.followDispatchAuthorized(
        renewalStarted,
        7,
        subscription,
        true,
        false,
        false,
        true,
    )
);
assert (
    not RelationshipService.followDispatchAuthorized(
        renewalStarted,
        7,
        Blob.fromArray(Array.repeat<Nat8>(9, 16)),
        true,
        false,
        false,
        false,
    )
);
assert (
    not RelationshipService.followDispatchAuthorized(
        {
            renewalStarted with
            intent = #on({
                subscription_id = subscription;
                status = #active;
            });
        },
        7,
        subscription,
        true,
        false,
        false,
        false,
    )
);
let detachedUncertain = {
    renewalStarted with
    intent = #on({
        subscription_id = subscription;
        status = #uncertain;
    });
};
assert (
    RelationshipService.followDispatchAuthorized(
        detachedUncertain,
        7,
        subscription,
        false,
        true,
        true,
        false,
    )
);
assert (
    not RelationshipService.followDispatchAuthorized(
        detachedUncertain,
        7,
        subscription,
        false,
        true,
        false,
        false,
    )
);
assert (
    not RelationshipService.followDispatchAuthorized(
        detachedUncertain,
        7,
        subscription,
        false,
        false,
        true,
        false,
    )
);

func applyRemote(
    generation : Nat,
    subscriptionId : Blob,
    result : RelationshipTypes.RemoteFollowResult,
    nowNs : Nat64,
) : RelationshipTypes.FollowingRow {
    switch (
        relationships.applyRemoteFollowResult(
            peer,
            generation,
            subscriptionId,
            result,
            nowNs,
        )
    ) {
        case (#ok(row)) row;
        case (#err(_)) Runtime.trap("remote Follow result failed");
    };
};

let afterUncertain = applyRemote(
    7,
    subscription,
    #uncertain(?4),
    401,
);
assert (afterUncertain.renewal_requested);
assert (afterUncertain.updated_at_ns == 400);
assert (afterUncertain.last_remote_revision == ?4);
assert (Nat16.toNat(afterUncertain.locally_verified_delivery_count) == 17);
switch (afterUncertain.intent) {
    case (#on(on)) assert (on.status == #uncertain);
    case (#off(_)) Runtime.trap("uncertain result disabled Follow intent");
};

let afterConflict = applyRemote(
    7,
    subscription,
    #revision_conflict(5),
    402,
);
assert (afterConflict.renewal_requested);
assert (afterConflict.updated_at_ns == 400);
assert (Nat16.toNat(afterConflict.locally_verified_delivery_count) == 17);
switch (afterConflict.intent) {
    case (#on(on)) assert (on.status == #conflicted);
    case (#off(_)) Runtime.trap("conflict result disabled Follow intent");
};

let afterIncompatible = applyRemote(
    7,
    subscription,
    #incompatible(?6),
    403,
);
assert (afterIncompatible.renewal_requested);
assert (afterIncompatible.updated_at_ns == 400);
assert (
    Nat16.toNat(afterIncompatible.locally_verified_delivery_count) == 17
);
switch (afterIncompatible.intent) {
    case (#on(on)) assert (on.status == #incompatible);
    case (#off(_)) Runtime.trap("incompatible result disabled Follow intent");
};

// Even terminal success is stale when it names an older generation or a
// different subscription. It may advance remote high-water, but cannot
// acknowledge the current renewal.
let afterStaleGeneration = applyRemote(
    6,
    subscription,
    #accepted({
        revision = 7;
        paid_anchor_ns = 350;
    }),
    404,
);
assert (afterStaleGeneration.renewal_requested);
assert (afterStaleGeneration.updated_at_ns == 400);
assert (afterStaleGeneration.last_remote_revision == ?7);
assert (
    Nat16.toNat(afterStaleGeneration.locally_verified_delivery_count) == 17
);
switch (afterStaleGeneration.intent) {
    case (#on(on)) assert (on.status == #incompatible);
    case (#off(_)) Runtime.trap("stale success disabled Follow intent");
};

let otherSubscription = Blob.fromArray(Array.repeat<Nat8>(9, 16));
let afterStaleSubscription = applyRemote(
    7,
    otherSubscription,
    #duplicate({
        revision = 8;
        paid_anchor_ns = 351;
    }),
    405,
);
assert (afterStaleSubscription.renewal_requested);
assert (afterStaleSubscription.updated_at_ns == 400);
assert (afterStaleSubscription.last_remote_revision == ?8);
assert (
    Nat16.toNat(afterStaleSubscription.locally_verified_delivery_count) == 17
);

let afterAccepted = applyRemote(
    7,
    subscription,
    #accepted({
        revision = 9;
        paid_anchor_ns = 405;
    }),
    900,
);
assert (not afterAccepted.renewal_requested);
assert (afterAccepted.locally_verified_delivery_count == 0);
assert (afterAccepted.updated_at_ns == 405);
assert (RelationshipService.RENEWAL_REQUEST_THRESHOLD == 4);
assert (
    RelationshipService.EARLY_RENEW_VERIFIED_DELIVERY_THRESHOLD == 28
);
assert (
    not RelationshipService.followingAutoRenewDue(
        afterAccepted,
        RelationshipService.AUTO_RENEW_AFTER_NS + (404 : Nat64),
    )
);
assert (
    RelationshipService.followingAutoRenewDue(
        afterAccepted,
        405 + RelationshipService.AUTO_RENEW_AFTER_NS,
    )
);
assert (
    RelationshipService.followingAutoRenewActionable(
        afterAccepted,
        405 + RelationshipService.AUTO_RENEW_AFTER_NS,
        false,
        true,
    )
);
assert (
    not RelationshipService.followingAutoRenewActionable(
        afterAccepted,
        405 + RelationshipService.AUTO_RENEW_AFTER_NS,
        true,
        true,
    )
);
assert (
    not RelationshipService.followingAutoRenewActionable(
        afterAccepted,
        405 + RelationshipService.AUTO_RENEW_AFTER_NS,
        false,
        false,
    )
);
assert (
    not RelationshipService.followingAutoRenewDue(
        { afterAccepted with renewal_requested = true },
        405,
    )
);
switch (afterAccepted.intent) {
    case (#on(on)) assert (on.status == #active);
    case (#off(_)) Runtime.trap("accepted result disabled Follow intent");
};

// Only matching, locally verified promotions advance the bounded local
// counter. The 28th promotion triggers renewal while four of the peer's
// initial 32 credits should remain, and later promotions saturate in place.
switch (
    relationships.recordLocallyVerifiedDelivery(
        peer,
        otherSubscription,
    )
) {
    case (#unchanged) {};
    case (_) Runtime.trap("mismatched subscription advanced local count");
};
var verifiedDeliveries = 0;
while (
    verifiedDeliveries <
    RelationshipService.EARLY_RENEW_VERIFIED_DELIVERY_THRESHOLD - 1
) {
    switch (
        relationships.recordLocallyVerifiedDelivery(
            peer,
            subscription,
        )
    ) {
        case (#changed(_)) {};
        case (_) Runtime.trap("verified delivery was not recorded");
    };
    verifiedDeliveries += 1;
};
let ?beforeEarlyRenew = following else {
    Runtime.trap("verified delivery accounting removed Following row");
};
assert (
    Nat16.toNat(beforeEarlyRenew.locally_verified_delivery_count) == 27
);
assert (
    not RelationshipService.followingAutoRenewDue(
        beforeEarlyRenew,
        406,
    )
);
switch (
    relationships.recordLocallyVerifiedDelivery(
        peer,
        subscription,
    )
) {
    case (#changed(_)) {};
    case (_) Runtime.trap("early renewal threshold was not recorded");
};
let ?atEarlyRenew = following else {
    Runtime.trap("early renewal accounting removed Following row");
};
assert (
    Nat16.toNat(atEarlyRenew.locally_verified_delivery_count) == 28
);
assert (RelationshipService.followingAutoRenewDue(atEarlyRenew, 406));
let saturatedRevision = atEarlyRenew.storage_revision;
switch (
    relationships.recordLocallyVerifiedDelivery(
        peer,
        subscription,
    )
) {
    case (#unchanged) {};
    case (_) Runtime.trap("verified delivery count did not saturate");
};
let ?afterSaturation = following else {
    Runtime.trap("saturated delivery accounting removed Following row");
};
assert (afterSaturation.storage_revision == saturatedRevision);
assert (
    Nat16.toNat(afterSaturation.locally_verified_delivery_count) == 28
);

// Exact duplicate acceptance has the same acknowledgement semantics.
following := ?{
    atEarlyRenew with
    storage_revision = atEarlyRenew.storage_revision + 1;
    intent = #on({
        subscription_id = subscription;
        status = #registering;
    });
    renewal_requested = true;
    updated_at_ns = 405;
};
let afterDuplicate = applyRemote(
    7,
    subscription,
    #duplicate({
        revision = 9;
        paid_anchor_ns = 407;
    }),
    999,
);
assert (not afterDuplicate.renewal_requested);
assert (afterDuplicate.locally_verified_delivery_count == 0);
assert (afterDuplicate.updated_at_ns == 407);
switch (afterDuplicate.intent) {
    case (#on(on)) assert (on.status == #active);
    case (#off(_)) Runtime.trap("duplicate result disabled Follow intent");
};

// A late result for the Follow outbox cannot resurrect receive authority after
// the owner has already advanced the local intent to Unfollow.
following := ?{
    afterDuplicate with
    intent_generation = 8;
    storage_revision = afterDuplicate.storage_revision + 1;
    intent = #off({ last_subscription_id = subscription });
    updated_at_ns = 409;
};
let afterLateFollow = applyRemote(
    7,
    subscription,
    #accepted({
        revision = 10;
        paid_anchor_ns = 408;
    }),
    410,
);
assert (afterLateFollow.last_remote_revision == ?10);
switch (afterLateFollow.intent) {
    case (#off(off)) {
        assert (Blob.equal(off.last_subscription_id, subscription));
    };
    case (#on(_)) Runtime.trap("late Follow resurrected Unfollow intent");
};

assert (
    RelationshipService.followingIntentOccupiesCapacity(
        #on({
            subscription_id = subscription;
            status = #active;
        })
    )
);
assert (
    not RelationshipService.followingIntentOccupiesCapacity(
        #off({ last_subscription_id = subscription })
    )
);

// Block closes both directional rows in the same CAS transaction. A rejected
// commit cannot leave any part of the composite applied.
let blockFollowerBefore : RelationshipTypes.FollowerRow = {
    afterFollow with
    head_revision = 20;
    storage_revision = 30;
    state = #active({
        subscription_id = subscription;
        lease_expires_ns =
            afterFollow.funded_at_ns + RelationshipService.LEASE_NS;
        delivery_credits = 17;
    });
    delivery_pause = ?#not_following;
    outstanding_delivery_charges = 1;
};
let blockFollowingBefore : RelationshipTypes.FollowingRow = {
    afterLateFollow with
    intent_generation = 20;
    storage_revision = 30;
    intent = #on({
        subscription_id = subscription;
        status = #active;
    });
    renewal_requested = true;
    locally_verified_delivery_count = 11;
    updated_at_ns = 500;
};
follower := ?blockFollowerBefore;
following := ?blockFollowingBefore;
blocked := null;
followerCounters := {
    follower_revision = 50;
    max_registration_sequence =
        blockFollowerBefore.registration_sequence;
};
rejectBlockCommit := true;
switch (relationships.block(peer, 600)) {
    case (#err(#state_conflict)) {};
    case (_) Runtime.trap("rejected Block did not report state conflict");
};
assert (blocked == null);
assert (follower == ?blockFollowerBefore);
assert (following == ?blockFollowingBefore);
assert (followerCounters.follower_revision == 50);

switch (relationships.block(peer, 600)) {
    case (#changed) {};
    case (_) Runtime.trap("Block did not atomically close relationships");
};
let ?firstBlock = blocked else Runtime.trap("Block row was not stored");
assert (firstBlock.storage_revision == 1);
assert (firstBlock.blocked_at_ns == 600);
let ?afterBlockFollower = follower else {
    Runtime.trap("Block deleted the Follower replay fence");
};
assert (afterBlockFollower.head_revision == 21);
assert (afterBlockFollower.storage_revision == 31);
assert (
    afterBlockFollower.registration_sequence ==
    blockFollowerBefore.registration_sequence
);
assert (afterBlockFollower.funded_at_ns == blockFollowerBefore.funded_at_ns);
assert (afterBlockFollower.delivery_pause == null);
assert (afterBlockFollower.outstanding_delivery_charges == 0);
switch (afterBlockFollower.state) {
    case (#inactive(value)) {
        assert (Blob.equal(value.last_subscription_id, subscription));
    };
    case (#active(_)) Runtime.trap("Block left the Follower active");
};
let ?afterBlockFollowing = following else {
    Runtime.trap("Block deleted the Following replay fence");
};
assert (afterBlockFollowing.intent_generation == 21);
assert (afterBlockFollowing.storage_revision == 31);
assert (not afterBlockFollowing.renewal_requested);
assert (afterBlockFollowing.locally_verified_delivery_count == 0);
assert (
    afterBlockFollowing.last_remote_revision ==
    blockFollowingBefore.last_remote_revision
);
switch (afterBlockFollowing.intent) {
    case (#off(value)) {
        assert (Blob.equal(value.last_subscription_id, subscription));
    };
    case (#on(_)) Runtime.trap("Block left Following capacity occupied");
};
assert (followerCounters.follower_revision == 51);

// A result prepared under the old generation may advance only remote
// high-water; it cannot revive the capacity-releasing #off intent.
let afterBlockedLate = applyRemote(
    blockFollowingBefore.intent_generation,
    subscription,
    #accepted({
        revision = 11;
        paid_anchor_ns = 550;
    }),
    601,
);
switch (afterBlockedLate.intent) {
    case (#off(_)) {};
    case (#on(_)) Runtime.trap("late Follow revived a blocked relationship");
};
let followerBeforeUnblock = follower;
let followingBeforeUnblock = following;
switch (relationships.unblock(peer)) {
    case (#changed) {};
    case (_) Runtime.trap("Unblock did not remove the Block row");
};
assert (blocked == null);
assert (follower == followerBeforeUnblock);
assert (following == followingBeforeUnblock);

// Repeated Block also repairs a legacy row that remained live underneath an
// existing Block, while retaining the original Block timestamp/revision.
switch (relationships.block(peer, 650)) {
    case (#changed) {};
    case (_) Runtime.trap("second Block row was not created");
};
let ?retainedBlock = blocked else Runtime.trap("second Block disappeared");
follower := ?{
    blockFollowerBefore with
    head_revision = 40;
    storage_revision = 50;
};
following := ?{
    blockFollowingBefore with
    intent_generation = 40;
    storage_revision = 50;
    updated_at_ns = 650;
};
switch (relationships.block(peer, 700)) {
    case (#changed) {};
    case (_) Runtime.trap("existing Block did not repair live rows");
};
assert (blocked == ?retainedBlock);
let repairedCounters = followerCounters;
switch (relationships.block(peer, 701)) {
    case (#unchanged) {};
    case (_) Runtime.trap("clean repeated Block was not idempotent");
};
assert (followerCounters == repairedCounters);
let exactBlockStatuses = RelationshipService.exactBlockStatuses(
    [selfNode, peer],
    func(node) { relationshipState.block(node) != null },
);
assert (exactBlockStatuses.size() == 2);
assert (Principal.equal(exactBlockStatuses[0].node, selfNode));
assert (not exactBlockStatuses[0].blocked);
assert (Principal.equal(exactBlockStatuses[1].node, peer));
assert (exactBlockStatuses[1].blocked);

// Fanout pages are bounded by rows examined, including ineligible rows. The
// input is deliberately reverse-ordered so the service must preserve
// registration-sequence order rather than backing-store order.
func fanoutNode(index : Nat) : Principal {
    Principal.fromBlob(
        Blob.fromArray([42, Nat8.fromNat(index), 1])
    );
};

func fanoutRow(sequence : Nat64) : RelationshipTypes.FollowerRow {
    let eligible = sequence > 25;
    {
        node = fanoutNode(Nat64.toNat(sequence));
        head_revision = 1;
        storage_revision = 1;
        state = #active({
            subscription_id = Blob.fromArray(
                Array.repeat<Nat8>(
                    Nat8.fromNat((Nat64.toNat(sequence) % 254) + 1),
                    RelationshipService.SUBSCRIPTION_ID_BYTES,
                )
            );
            lease_expires_ns = 10 + RelationshipService.LEASE_NS;
            delivery_credits = Nat16.fromNat(if (eligible) 1 else 0);
        });
        registration_sequence = sequence;
        funded_at_ns = 10;
        delivery_pause = null;
        outstanding_delivery_charges = 0;
    };
};

var fanoutRows = Array.tabulate<RelationshipTypes.FollowerRow>(
    45,
    func(index : Nat) : RelationshipTypes.FollowerRow {
        fanoutRow(Nat64.fromNat(45 - index));
    },
);
var fanoutCounters : RelationshipTypes.FollowerCounters = {
    follower_revision = 45;
    max_registration_sequence = 45;
};
var fanoutEligibilityChecks = 0;
var fanoutFollowerMaterializations = 0;
var firstRegistrationPageLimit : ?Nat = null;

let fanoutState : RelationshipTypes.State = {
    follower = func(_node : Principal) : ?RelationshipTypes.FollowerRow {
        null;
    };
    followers = func() : [RelationshipTypes.FollowerRow] {
        fanoutFollowerMaterializations += 1;
        fanoutRows;
    };
    followers_by_registration = func(
        afterSequence : ?Nat64,
        limit : Nat,
    ) : ?[RelationshipTypes.FollowerRow] {
        if (firstRegistrationPageLimit == null) {
            firstRegistrationPageLimit := ?limit;
        };
        let ordered = Array.sort<RelationshipTypes.FollowerRow>(
            fanoutRows,
            func(left, right) {
                Nat64.compare(
                    left.registration_sequence,
                    right.registration_sequence,
                );
            },
        );
        let remaining = Array.filter<RelationshipTypes.FollowerRow>(
            ordered,
            func(row) {
                switch (afterSequence) {
                    case null true;
                    case (?cursor) row.registration_sequence > cursor;
                };
            },
        );
        ?Array.tabulate<RelationshipTypes.FollowerRow>(
            Nat.min(limit, remaining.size()),
            func(index) { remaining[index] },
        );
    };
    active_follower_count = func() : Nat { fanoutRows.size() };
    follower_counters = func() : RelationshipTypes.FollowerCounters {
        fanoutCounters;
    };
    commit_follower = func(
        _mutation : RelationshipTypes.FollowerMutation
    ) : Bool { false };
    following = func(
        _node : Principal
    ) : ?RelationshipTypes.FollowingRow { null };
    following_count = func() : Nat { 0 };
    commit_following = func(
        _mutation : RelationshipTypes.FollowingMutation
    ) : Bool { false };
    block = func(
        _node : Principal
    ) : ?RelationshipTypes.BlockRow {
        fanoutEligibilityChecks += 1;
        null;
    };
    block_count = func() : Nat { 0 };
    commit_block = func(
        _mutation : RelationshipTypes.BlockMutation
    ) : Bool { false };
};

let fanoutRelationships = RelationshipService.Service(
    fanoutState,
    selfNode,
    {
        call_and_byte_cycles = func(
            _input : RelationshipTypes.CostEstimateInput
        ) : ?Nat { ?0 };
        local_publication_cycles = func(
            _input : RelationshipTypes.CostEstimateInput
        ) : ?Nat { ?0 };
    },
);

let fanoutQuote = switch (
    fanoutRelationships.getSendQuote(
        {
            send_kind = ?#post;
            estimated_object_bytes = 1;
            notice_target = null;
        },
        100,
    )
) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("fanout send quote failed");
};
assert (fanoutQuote.registered_follower_count == 45);
assert (fanoutQuote.eligible_delivery_count == 20);
assert (fanoutQuote.ineligible_follower_count == 25);
assert (fanoutFollowerMaterializations == 0);
assert (
    firstRegistrationPageLimit ==
    ?RelationshipService.SEND_QUOTE_SCAN_LIMIT
);
assert (
    fanoutQuote.eligible_recipient_preview.size() ==
    Bounds.MAX_SEND_QUOTE_RECIPIENT_PREVIEW
);
assert (
    fanoutQuote.eligible_recipient_preview ==
    Array.tabulate<Principal>(
        Bounds.MAX_SEND_QUOTE_RECIPIENT_PREVIEW,
        func(index : Nat) : Principal {
            fanoutNode(26 + index);
        },
    )
);

// Quote eligibility checks must not affect the fanout scan assertions below.
fanoutEligibilityChecks := 0;

let frozenSnapshot = switch (fanoutRelationships.fanoutSnapshot(100)) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("fanout snapshot failed");
};
assert (frozenSnapshot.cutoff_registration_sequence == 45);

// A follower registered after finalization must never enter this job.
fanoutRows := appendArray(fanoutRows, fanoutRow(46));
fanoutCounters := {
    follower_revision = 46;
    max_registration_sequence = 46;
};

let firstFanoutPage = switch (
    fanoutRelationships.planFanoutBatch(
        frozenSnapshot,
        null,
        100,
    )
) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("first fanout page failed");
};
assert (firstFanoutPage.targets == []);
assert (firstFanoutPage.next_after_sequence == ?20);
assert (not firstFanoutPage.complete);
assert (
    fanoutEligibilityChecks ==
    RelationshipService.FANOUT_BATCH_LIMIT
);

let checksAfterFirstPage = fanoutEligibilityChecks;
let secondFanoutPage = switch (
    fanoutRelationships.planFanoutBatch(
        frozenSnapshot,
        firstFanoutPage.next_after_sequence,
        100,
    )
) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("second fanout page failed");
};
assert (
    Array.map<
        RelationshipTypes.FanoutTarget,
        Nat64
    >(
        secondFanoutPage.targets,
        func(target : RelationshipTypes.FanoutTarget) : Nat64 {
            target.registration_sequence;
        },
    ) == [
        26, 27, 28, 29, 30,
        31, 32, 33, 34, 35,
        36, 37, 38, 39, 40,
    ]
);
assert (secondFanoutPage.next_after_sequence == ?40);
assert (not secondFanoutPage.complete);
assert (
    fanoutEligibilityChecks - checksAfterFirstPage ==
    RelationshipService.FANOUT_BATCH_LIMIT
);

let checksAfterSecondPage = fanoutEligibilityChecks;
let finalFanoutPage = switch (
    fanoutRelationships.planFanoutBatch(
        frozenSnapshot,
        secondFanoutPage.next_after_sequence,
        100,
    )
) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("final fanout page failed");
};
assert (
    Array.map<
        RelationshipTypes.FanoutTarget,
        Nat64
    >(
        finalFanoutPage.targets,
        func(target : RelationshipTypes.FanoutTarget) : Nat64 {
            target.registration_sequence;
        },
    ) == [41, 42, 43, 44, 45]
);
assert (finalFanoutPage.next_after_sequence == ?45);
assert (finalFanoutPage.complete);
assert (
    fanoutEligibilityChecks - checksAfterSecondPage == 5
);
