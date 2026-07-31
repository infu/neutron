import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";

import OutboxService "../../backend/outbox/Service";
import OutboxTypes "../../backend/outbox/Types";
import Bounds "../../backend/protocol/Bounds";
import ProtocolTypes "../../backend/protocol/Types";
import ProtocolWire "../../backend/protocol/Wire";
import RelationshipTypes "../../backend/relationships/Types";
import Dispatcher "../../backend/transport/Dispatcher";
import Policy "../../backend/transport/Policy";
import TransportTypes "../../backend/transport/Types";

let selfNode = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
let peer = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
let subscription = Blob.fromArray(Array.repeat<Nat8>(1, 16));

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

var item : ?OutboxTypes.Item = null;
let control : OutboxTypes.Control = { revision = 0; pause = null };

func expectedItem(
    expected : ?Nat64,
    current : ?OutboxTypes.Item,
) : Bool {
    switch (expected, current) {
        case (null, null) true;
        case (?revision, ?stored) revision == stored.storage_revision;
        case (_) false;
    };
};

let state : OutboxTypes.State = {
    item = func(localId : Nat64) : ?OutboxTypes.Item {
        switch (item) {
            case (?stored) {
                if (stored.local_id == localId) ?stored else null;
            };
            case null null;
        };
    };
    find_operation = func(
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
    count = func() : Nat {
        switch (item) {
            case null 0;
            case (?_) 1;
        };
    };
    page_after = func(after : ?Nat64, limit : Nat) : [OutboxTypes.Item] {
        if (limit == 0) return [];
        switch (item) {
            case null [];
            case (?stored) {
                let cursor = switch (after) {
                    case null (0 : Nat64);
                    case (?value) value;
                };
                if (stored.local_id > cursor) [stored] else [];
            };
        };
    };
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
    commit = func(mutation : OutboxTypes.Mutation) : Bool {
        if (
            not expectedItem(mutation.expected_storage_revision, item) or
            mutation.follower_mutation != null or
            mutation.control_mutation != null
        ) return false;
        item := ?mutation.next_item;
        true;
    };
    commit_control = func(_mutation : OutboxTypes.ControlMutation) : Bool {
        false;
    };
};

let credits : RelationshipTypes.CreditPlanner = {
    prepare_debit = func(
        _peer : Principal,
        _subscription : Blob,
        _nowNs : Nat64,
    ) : RelationshipTypes.CreditDebitResult {
        #err(#invalid_request);
    };
    prepare_finish = func(
        _request : RelationshipTypes.CreditFinishRequest
    ) : RelationshipTypes.CreditFinishResult {
        #err(#invalid_request);
    };
};

let outbox = OutboxService.Service(
    state,
    credits,
    dispatcher.validPrepared,
);

func preparedFollow(
    operationByte : Nat8,
    createdAt : Nat64,
) : TransportTypes.PreparedDispatchV1 {
    let prepared = dispatcher.prepare({
        target = peer;
        route = Bounds.FOLLOW_ROUTE;
        operation_id =
            Blob.fromArray(Array.repeat<Nat8>(operationByte, 16));
        exact_body_candid = ProtocolWire.encodeFollowBody({
            expected_revision = 0;
            subscription_id = subscription;
        });
        created_at_ns = createdAt;
    });
    switch (prepared) {
        case (#ok(value)) value;
        case (#err(_)) Runtime.trap("Follow preparation failed");
    };
};

func preparedLike(
    operationByte : Nat8,
    createdAt : Nat64,
) : TransportTypes.PreparedDispatchV1 {
    let prepared = dispatcher.prepare({
        target = peer;
        route = Bounds.LIKE_ROUTE;
        operation_id =
            Blob.fromArray(Array.repeat<Nat8>(operationByte, 16));
        exact_body_candid = ProtocolWire.encodeLikeBody({
            certified_like_receipt_candid = Blob.fromArray([1]);
        });
        created_at_ns = createdAt;
    });
    switch (prepared) {
        case (#ok(value)) value;
        case (#err(_)) Runtime.trap("Like preparation failed");
    };
};

func enqueue(
    localId : Nat64,
    prepared : TransportTypes.PreparedDispatchV1,
    nowNs : Nat64,
) {
    switch (
        outbox.enqueue(
            {
                local_id = localId;
                prepared;
                delivery_subscription_id = null;
                encoded_renewal_requested = null;
            },
            nowNs,
        )
    ) {
        case (#queued(_)) {};
        case (_) Runtime.trap("Outbox enqueue failed");
    };
};

func begin(
    localId : Nat64,
    mode : OutboxTypes.DrainMode,
    nowNs : Nat64,
) : OutboxTypes.StartDispatch {
    switch (outbox.beginDispatch(localId, mode, nowNs)) {
        case (#dispatch(value)) value;
        case (#err(_)) Runtime.trap("Outbox dispatch did not start");
    };
};

// A peer-controlled outer busy response proves that cycles reached the peer.
// It remains available for an exact owner retry, but normal automatic drains
// must never select it.
let remotePrepared = preparedFollow(2, (100 : Nat64));
let stableJitter = OutboxService.retryJitter(remotePrepared, 1);
assert (stableJitter > 0);
assert (stableJitter == 8_335_235_161_366_445_167);
assert (
    stableJitter ==
    OutboxService.retryJitter(remotePrepared, 1)
);
assert (
    stableJitter !=
    OutboxService.retryJitter(remotePrepared, 2)
);
assert (
    stableJitter !=
    OutboxService.retryJitter(
        { remotePrepared with target = selfNode },
        1,
    )
);
assert (
    stableJitter !=
    OutboxService.retryJitter(
        {
            remotePrepared with
            operation_id = Blob.fromArray(Array.repeat<Nat8>(9, 16));
        },
        1,
    )
);
enqueue(1, remotePrepared, 100);
let remoteStart = begin(1, #automatic, 100);
let remoteBusy = Policy.publicIngressError(#busy);
assert (remoteBusy.certainty == #may_have_dispatched);
let remoteFinished = switch (
    outbox.finishDispatch({
        local_id = 1;
        attempt_no = remoteStart.attempt_no;
        result = remoteBusy;
        callback_time_ns = 101;
        jitter = 7;
    })
) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("Remote busy finish failed");
};
assert (remoteFinished.state == #uncertain);
assert (remoteFinished.retry_permission == #manual);
let ?remoteRetryAt = remoteFinished.next_attempt_at_ns else {
    Runtime.trap("Remote busy omitted its retry deadline");
};
let automaticRemotePlan = switch (
    outbox.planBatch({
        after_local_id = null;
        mode = #automatic;
        now_ns = remoteRetryAt;
    })
) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("Automatic remote-busy plan failed");
};
assert (automaticRemotePlan.local_ids == []);
let ownerRemotePlan = switch (
    outbox.planBatch({
        after_local_id = null;
        mode = #owner;
        now_ns = remoteRetryAt;
    })
) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("Owner remote-busy plan failed");
};
assert (ownerRemotePlan.local_ids == [1]);

// A trusted broker pre-dispatch busy response transfers no route cycles and may
// retry automatically. Selecting that automatic row through owner mode still
// consumes the same automatic retry budget.
item := null;
let localPrepared = preparedFollow(3, (200 : Nat64));
enqueue(2, localPrepared, 200);
let localStart = begin(2, #automatic, 200);
let ?afterLocalStart = item else {
    Runtime.trap("Local busy start removed its row");
};
assert (afterLocalStart.last_attempt_at_ns == ?200);
let localBusy = Policy.backendError({
    code = "concurrency_limit";
    message = "local concurrency is full";
});
assert (localBusy.certainty == #not_dispatched);
let localFinished = switch (
    outbox.finishDispatch({
        local_id = 2;
        attempt_no = localStart.attempt_no;
        result = localBusy;
        callback_time_ns = 201;
        jitter = 0;
    })
) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("Local busy finish failed");
};
assert (localFinished.state == #queued);
assert (localFinished.retry_permission == #automatic);
assert (localFinished.last_attempt_at_ns == ?200);
let ?localRetryAt = localFinished.next_attempt_at_ns else {
    Runtime.trap("Local busy omitted its retry deadline");
};
assert (
    localRetryAt ==
    201 + TransportTypes.BUSY_RETRY_DELAY_NS + 1
);
let beforeLocalRetry = switch (
    outbox.planBatch({
        after_local_id = null;
        mode = #automatic;
        now_ns = localRetryAt - 1;
    })
) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("Early local-busy plan failed");
};
assert (beforeLocalRetry.local_ids == []);
let localRetry = begin(2, #owner, localRetryAt);
assert (localRetry.attempt_no == 2);
let ?afterOwnerSelection = item else {
    Runtime.trap("Owner selection removed the local-busy row");
};
assert (afterOwnerSelection.automatic_retry_count == 1);
assert (afterOwnerSelection.last_attempt_at_ns == ?200);

// An unreceipted Like #full is the narrow semantic exception: the receiver
// explicitly committed no durable operation receipt, so the same frozen
// operation retries automatically after a bounded delay.
item := null;
let likePrepared = preparedLike(4, (300 : Nat64));
enqueue(3, likePrepared, 300);
let likeStart = begin(3, #automatic, 300);
let unreceiptedFull : ProtocolTypes.WagyuRouteResultV1 = {
    outcome = ?#rejected({ reason = ?#full });
    local_receipt_time_ns = null;
    revision = null;
    relationship = null;
};
let exactUnreceiptedFull = to_candid (unreceiptedFull);
let transientLikeFull = Policy.semanticForRoute(
    Bounds.LIKE_ROUTE,
    unreceiptedFull,
    exactUnreceiptedFull,
);
let likeFinished = switch (
    outbox.finishDispatch({
        local_id = 3;
        attempt_no = likeStart.attempt_no;
        result = transientLikeFull;
        callback_time_ns = 301;
        jitter = 99;
    })
) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("Transient Like full finish failed");
};
assert (likeFinished.state == #queued);
assert (likeFinished.retry_permission == #automatic);
assert (
    likeFinished.next_attempt_at_ns ==
    ?(301 + TransportTypes.LIKE_FULL_RETRY_DELAY_NS)
);
let exactLikeRetry = begin(
    3,
    #automatic,
    301 + TransportTypes.LIKE_FULL_RETRY_DELAY_NS,
);
assert (exactLikeRetry.attempt_no == 2);
assert (
    Dispatcher.exactRetryMatches(
        likePrepared,
        exactLikeRetry.prepared,
    )
);

// A receipt timestamp means the receiver durably resolved the operation;
// #full is terminal even for Like. The same null timestamp on another route
// is terminal as well.
item := null;
let receiptedLikePrepared = preparedLike(5, (400 : Nat64));
enqueue(4, receiptedLikePrepared, 400);
let receiptedLikeStart = begin(4, #automatic, 400);
let receiptedFull : ProtocolTypes.WagyuRouteResultV1 = {
    unreceiptedFull with
    local_receipt_time_ns = ?401;
};
let receiptedLikeFinished = switch (
    outbox.finishDispatch({
        local_id = 4;
        attempt_no = receiptedLikeStart.attempt_no;
        result = Policy.semanticForRoute(
            Bounds.LIKE_ROUTE,
            receiptedFull,
            to_candid (receiptedFull),
        );
        callback_time_ns = 401;
        jitter = 0;
    })
) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("Receipted Like full finish failed");
};
assert (receiptedLikeFinished.state == #failed);
assert (receiptedLikeFinished.retry_permission == #none);
assert (receiptedLikeFinished.next_attempt_at_ns == null);

item := null;
let fullFollowPrepared = preparedFollow(6, (500 : Nat64));
enqueue(5, fullFollowPrepared, 500);
let fullFollowStart = begin(5, #automatic, 500);
let fullFollowFinished = switch (
    outbox.finishDispatch({
        local_id = 5;
        attempt_no = fullFollowStart.attempt_no;
        result = Policy.semanticForRoute(
            Bounds.FOLLOW_ROUTE,
            unreceiptedFull,
            exactUnreceiptedFull,
        );
        callback_time_ns = 501;
        jitter = 0;
    })
) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("Non-Like full finish failed");
};
assert (fullFollowFinished.state == #failed);
assert (fullFollowFinished.retry_permission == #none);
assert (fullFollowFinished.next_attempt_at_ns == null);

// Exhausting the kernel's daily transfer allowance is not a low-balance
// condition. It restores the undispatched attempt and schedules one automatic
// retry after the UTC-day budget is guaranteed to have rolled over.
item := null;
let dailyPrepared = preparedFollow(7, (600 : Nat64));
enqueue(6, dailyPrepared, 600);
let dailyStart = begin(6, #automatic, 600);
let dailyLimited = Policy.backendError({
    code = "cycles_daily_limit";
    message = "daily transfer allowance exhausted";
});
assert (dailyLimited.outcome == #rate_limited);
assert (dailyLimited.certainty == #not_dispatched);
assert (
    dailyLimited.retry ==
    #delayed({
        minimum_delay_ns = TransportTypes.DAY_NS;
        jitter_window_ns = TransportTypes.RATE_LIMIT_RETRY_JITTER_NS;
    })
);
let dailyJitter = OutboxService.retryJitter(
    dailyPrepared,
    dailyStart.attempt_no,
);
let dailyFinished = switch (
    outbox.finishDispatch({
        local_id = 6;
        attempt_no = dailyStart.attempt_no;
        result = dailyLimited;
        callback_time_ns = 601;
        jitter = dailyJitter;
    })
) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("Daily-limit finish failed");
};
assert (dailyFinished.state == #queued);
assert (dailyFinished.retry_permission == #automatic);
let expectedDailyRetry =
    601 +
    TransportTypes.DAY_NS +
    1 +
    (
        dailyJitter %
        (TransportTypes.RATE_LIMIT_RETRY_JITTER_NS - 1)
    );
assert (dailyFinished.next_attempt_at_ns == ?expectedDailyRetry);
assert (control.pause == null);
let dailyRetry = begin(6, #automatic, expectedDailyRetry);
assert (dailyRetry.attempt_no == 2);
let ?afterDailyRetry = item else {
    Runtime.trap("Daily-limit retry removed the row");
};
assert (afterDailyRetry.automatic_retry_count == 1);
