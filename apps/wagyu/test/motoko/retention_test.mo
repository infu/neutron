import Array "mo:core/Array";
import Blob "mo:core/Blob";
import List "mo:core/List";
import Nat8 "mo:core/Nat8";
import Nat64 "mo:core/Nat64";
import Order "mo:core/Order";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";

import RetentionService "../../backend/retention/Service";
import RetentionTypes "../../backend/retention/Types";

let peer = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
let operation = Blob.fromArray(Array.repeat<Nat8>(7, 16));
let started : Nat64 = 1_000;
let rateExpiry = started + RetentionService.RATE_WINDOW_NS;
let peerExpiry = started + RetentionService.PEER_RETENTION_NS;
let likeExpiry = started + RetentionService.LIKE_RETENTION_NS;

let views : [RetentionTypes.RecordView] = [
    #follower({
        node = peer;
        funded_at_ns = started;
        retain_until_ns = peerExpiry;
        retained_bytes = 101;
        registration_sequence = 1;
        active = true;
        charges_detached = true;
    }),
    #authored_post({
        post_key = "post";
        created_at_ns = started;
        retain_until_ns = peerExpiry;
        retained_bytes = 102;
        author_sequence = 2;
        dependents_detached = true;
    }),
    #authored_action({
        action_key = "share";
        created_at_ns = started;
        retain_until_ns = peerExpiry;
        retained_bytes = 103;
        sequence = 3;
        certified_record_detached = true;
        kind = #share({
            original_author = peer;
            original_post_id = operation;
        });
    }),
    #feed_candidate({
        candidate_key = "candidate";
        received_at_ns = started;
        retain_until_ns = peerExpiry;
        retained_bytes = 104;
        local_sequence = 4;
        immediate_sender = peer;
        unread = true;
        dependents_detached = true;
    }),
    #verified_feed({
        feed_key = "verified";
        created_at_ns = started;
        retain_until_ns = peerExpiry;
        retained_bytes = 105;
        dependents_detached = true;
    }),
    #share_attribution({
        attribution_key = "attribution";
        verified_at_ns = started;
        retain_until_ns = peerExpiry;
        retained_bytes = 106;
        feed_key = "verified";
        candidate_key = "candidate";
    }),
    #suppression({
        suppression_key = "suppression";
        suppressed_at_ns = started;
        retain_until_ns = peerExpiry;
        retained_bytes = 107;
        source_candidate_key = ?"candidate";
    }),
    #tombstone_relay({
        relay_key = "relay";
        created_at_ns = started;
        retain_until_ns = peerExpiry;
        retained_bytes = 108;
        fanout_job_id = 8;
        fanout_detached = true;
    }),
    #notification({
        local_sequence = 9;
        received_at_ns = started;
        retain_until_ns = peerExpiry;
        retained_bytes = 109;
        semantic_key = "notice";
        actor_ = peer;
        unread = true;
        has_evidence = true;
        notice_target_key = ?"target";
        notice_semantic_detached = true;
    }),
    #notice_semantic({
        semantic_key = "notice";
        received_at_ns = started;
        retain_until_ns = peerExpiry;
        accounted_bytes = ?110;
        notification_sequence = 9;
        actor_ = peer;
        target_post_key = "target";
    }),
    #accepted_like({
        accepted_like_key = "accepted-like";
        accepted_sequence = 11;
        accepted_at_ns = started;
        retain_until_ns = likeExpiry;
        withdrawn_at_ns = null;
        retained_bytes = 111;
        post_key = "post";
        notification_sequence = 9;
        segment = null;
    }),
    #sealed_like_batch({
        batch_key = "batch";
        sealed_at_ns = started;
        retain_until_ns = likeExpiry;
        withdrawn_at_ns = null;
        accounted_bytes = ?112;
        post_key = "post";
        batch_number = 1;
        certified_record_detached = true;
    }),
    #ingress_receipt({
        receipt_key = "receipt";
        route = #deliver;
        received_at_ns = started;
        retain_until_ns = peerExpiry;
        retained_bytes = 113;
        domain_dependency_detached = true;
    }),
    #caller_rate_window({
        window_key = "window";
        window_started_at_ns = started;
        expires_at_ns = rateExpiry;
        retained_bytes = 114;
    }),
    #outbox({
        local_id = 15;
        created_at_ns = started;
        retry_expires_at_ns = peerExpiry;
        cleanup_at_ns = peerExpiry;
        retained_bytes = 115;
        operation_key = (peer, "wagyu_v1:deliver", operation);
        retry_index_key = ?(started, 15);
        pending_credit_charge = null;
        links_detached = true;
    }),
    #fanout_job({
        fanout_job_id = 16;
        created_at_ns = started;
        expires_at_ns = peerExpiry;
        cleanup_at_ns = peerExpiry;
        retained_bytes = 116;
        targets_detached = true;
    }),
    #fanout_target({
        target_key = "fanout-target";
        fanout_job_id = 16;
        outbox_local_id = 15;
        created_at_ns = started;
        expires_at_ns = peerExpiry;
        cleanup_at_ns = peerExpiry;
        retained_bytes = 117;
        outbox_detached = true;
    }),
];

var retentionSequence : Nat64 = 0;
var cleanupEpoch : Nat64 = 0;
var indexed : [RetentionTypes.Entry] = [];
var anomalyMode = false;
var rejectCleanup = false;

func compareIndex(
    left : RetentionTypes.IndexKey,
    right : RetentionTypes.IndexKey,
) : Order.Order {
    switch (Nat64.compare(left.0, right.0)) {
        case (#equal) {
            switch (Nat8.compare(left.1, right.1)) {
                case (#equal) Nat64.compare(left.2, right.2);
                case (order) order;
            };
        };
        case (order) order;
    };
};

func entryFor(domain : Nat8) : RetentionTypes.Entry {
    for (entry in indexed.vals()) {
        if (entry.key.1 == domain) return entry;
    };
    Runtime.trap("missing registered retention domain");
};

func sortedEntries() : [RetentionTypes.Entry] {
    // Rate expiry precedes peer expiry; five-year Like rows follow it.
    let order : [Nat8] = [
        14, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 15, 16, 17, 11, 12,
    ];
    Array.tabulate<RetentionTypes.Entry>(
        order.size(),
        func(index) { entryFor(order[index]) },
    );
};

func pageExpired(
    after : ?RetentionTypes.IndexKey,
    nowNs : Nat64,
    limit : Nat,
) : RetentionTypes.ExpiredPage {
    let result = List.empty<RetentionTypes.Entry>();
    for (entry in sortedEntries().vals()) {
        let afterCursor = switch (after) {
            case null true;
            case (?cursor) compareIndex(cursor, entry.key) == #less;
        };
        if (
            result.size() < limit and
            afterCursor and
            entry.key.0 <= nowNs
        ) {
            List.add(result, entry);
        };
    };
    {
        entries = List.toArray(result);
        complete = result.size() < limit;
    };
};

func baseView(domain : Nat8) : RetentionTypes.RecordView {
    views[Nat8.toNat(domain) - 1];
};

func inspect(
    entry : RetentionTypes.Entry
) : RetentionTypes.Inspection {
    if (not anomalyMode) return #record(baseView(entry.key.1));
    switch (entry.key.1) {
        case (1) {
            #record(#follower({
                node = peer;
                funded_at_ns = started + 1;
                retain_until_ns = peerExpiry + 1;
                retained_bytes = 101;
                registration_sequence = 1;
                active = true;
                charges_detached = true;
            }));
        };
        case (2) {
            #record(#authored_post({
                post_key = "post";
                created_at_ns = started;
                retain_until_ns = peerExpiry;
                retained_bytes = 102;
                author_sequence = 2;
                dependents_detached = false;
            }));
        };
        case (7) #missing;
        case (12) {
            #record(#sealed_like_batch({
                batch_key = "batch";
                sealed_at_ns = started;
                retain_until_ns = likeExpiry;
                withdrawn_at_ns = null;
                accounted_bytes = null;
                post_key = "post";
                batch_number = 1;
                certified_record_detached = true;
            }));
        };
        case (_) #record(baseView(entry.key.1));
    };
};

func commitRegistration(
    plan : RetentionTypes.RegistrationPlan
) : Bool {
    if (
        plan.expected_sequence != retentionSequence or
        plan.next_sequence <= plan.expected_sequence or
        plan.changes.size() == 0
    ) return false;
    // This fake mirrors the outer adapter: validation precedes every write.
    indexed := Array.map<
        RetentionTypes.RegistrationChange,
        RetentionTypes.Entry
    >(plan.changes, func(change) { change.replacement });
    retentionSequence := plan.next_sequence;
    true;
};

func assertDelete(
    deletion : {
        entry : RetentionTypes.Entry;
        expected : RetentionTypes.RecordView;
        decrement : RetentionTypes.CounterDelta;
    }
) {
    let delta = deletion.decrement;
    switch (deletion.expected) {
        case (#follower(_)) {
            assert (delta.follower_head_count == 1);
            assert (delta.follower_head_bytes == 101);
            assert (delta.active_follower_count == 1);
        };
        case (#authored_post(_)) {
            assert (delta.authored_post_count == 1);
            assert (delta.authored_bytes == 102);
        };
        case (#authored_action(_)) {
            assert (delta.authored_action_count == 1);
            assert (delta.authored_bytes == 103);
        };
        case (#feed_candidate(_)) {
            assert (delta.candidate_count == 1);
            assert (delta.candidate_bytes == 104);
            assert (delta.unread_feed_count == 1);
        };
        case (#verified_feed(_)) {
            assert (delta.verified_feed_count == 1);
            assert (delta.verified_feed_bytes == 105);
        };
        case (#share_attribution(_)) {
            assert (delta.share_attribution_count == 1);
            assert (delta.share_attribution_bytes == 106);
        };
        case (#suppression(_)) {
            assert (delta.suppression_count == 1);
            assert (delta.suppression_bytes == 107);
        };
        case (#tombstone_relay(_)) {
            assert (delta.tombstone_relay_count == 1);
            assert (delta.tombstone_relay_bytes == 108);
        };
        case (#notification(_)) {
            assert (delta.notification_count == 1);
            assert (delta.notification_bytes == 109);
            assert (delta.unread_notification_count == 1);
        };
        case (#notice_semantic(_)) {
            assert (delta.notification_count == 0);
            assert (delta.notification_bytes == 0);
        };
        case (#accepted_like(_)) {
            assert (delta.accepted_like_count == 1);
            assert (delta.accepted_like_bytes == 111);
        };
        case (#sealed_like_batch(_)) {
            assert (delta.accepted_like_count == 0);
        };
        case (#ingress_receipt(_)) {
            assert (delta.ingress_receipt_count == 1);
            assert (delta.ingress_receipt_bytes == 113);
        };
        case (#caller_rate_window(_)) {
            assert (delta.caller_rate_window_count == 1);
            assert (delta.caller_rate_window_bytes == 114);
        };
        case (#outbox(value)) {
            assert (value.pending_credit_charge == null);
            assert (delta.outbox_count == 1);
            assert (delta.outbox_bytes == 115);
        };
        case (#fanout_job(_)) {
            assert (delta.fanout_job_count == 1);
            assert (delta.fanout_bytes == 116);
        };
        case (#fanout_target(_)) {
            assert (delta.fanout_target_count == 1);
            assert (delta.fanout_bytes == 117);
        };
    };
};

func commitCleanup(plan : RetentionTypes.CleanupPlan) : Bool {
    if (
        rejectCleanup or
        plan.expected_cleanup_epoch != cleanupEpoch or
        plan.expected_retention_sequence != retentionSequence or
        plan.next_cleanup_epoch != cleanupEpoch + 1
    ) return false;
    for (mutation in plan.mutations.vals()) {
        switch (mutation) {
            case (#delete_record(value)) assertDelete(value);
            case (#delete_index_only(_)) {};
            case (#defer(value)) {
                assert (
                    value.replacement.key.0 ==
                    plan.now_ns +
                    RetentionService.MAINTENANCE_RETRY_NS
                );
                assert (
                    value.replacement.key.1 == value.entry.key.1
                );
            };
        };
    };
    // As in the real adapter, the epoch, global suffix, rows, secondary
    // indexes, counters, and replacement indexes commit only after validation.
    cleanupEpoch := plan.next_cleanup_epoch;
    retentionSequence := plan.next_retention_sequence;
    true;
};

let state : RetentionTypes.State = {
    policy = RetentionService.frozenPolicy;
    retention_sequence = func() : Nat64 { retentionSequence };
    cleanup_epoch = func() : Nat64 { cleanupEpoch };
    current = func(record) {
        if (
            anomalyMode and
            RetentionService.domain(record) ==
                RetentionService.FOLLOWER_DOMAIN
        ) return null;
        let key = RetentionService.canonicalKey(record);
        for (entry in indexed.vals()) {
            if (RetentionService.canonicalKey(entry.record) == key) {
                return ?entry;
            };
        };
        null;
    };
    page_expired = pageExpired;
    inspect;
    commit_cleanup = commitCleanup;
};
let service = RetentionService.Service(state);

// A single pure plan allocates the first globally unique index suffix.
switch (
    RetentionService.prepareRegistration(
        RetentionService.frozenPolicy(),
        retentionSequence,
        views[0],
    )
) {
    case (#ok(plan)) {
        assert (plan.expected_sequence == 0);
        assert (plan.next_sequence == 1);
        assert (plan.changes.size() == 1);
        assert (plan.changes[0].replacement.key.2 == 1);
    };
    case (#err(_)) Runtime.trap("single registration failed");
};

// Multi-row planning is pure and lets ingress fold all indexes into its one
// receipt+rate+domain atomic commit.
let registration = switch (
    RetentionService.prepareRegistrations(
        RetentionService.frozenPolicy(),
        retentionSequence,
        Array.map<
            RetentionTypes.RecordView,
            RetentionTypes.RegistrationRequest
        >(views, func(view) { { view; expected_previous = null } }),
    )
) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("batch registration failed");
};
assert (registration.changes.size() == 17);
assert (registration.next_sequence == 17);
assert (commitRegistration(registration));
for (change in registration.changes.vals()) {
    let entry = change.replacement;
    assert (entry.key.2 > 0);
    assert (entry.key.1 == RetentionService.domain(entry.record));
    assert (
        change.current_key ==
        RetentionService.canonicalKey(change.record)
    );
};

let terminalAt = started + RetentionService.RATE_WINDOW_NS;
let terminalCleanup = switch (
    RetentionService.terminalCleanupAt(terminalAt)
) {
    case (?value) value;
    case null Runtime.trap("terminal cleanup deadline overflowed");
};
let terminalOutbox : RetentionTypes.RecordView = #outbox({
    local_id = 15;
    created_at_ns = started;
    retry_expires_at_ns = peerExpiry;
    cleanup_at_ns = terminalCleanup;
    retained_bytes = 115;
    operation_key = (peer, "wagyu_v1:deliver", operation);
    retry_index_key = null;
    pending_credit_charge = null;
    links_detached = true;
});
switch (
    RetentionService.prepareRegistrations(
        RetentionService.frozenPolicy(),
        retentionSequence,
        [{
            view = terminalOutbox;
            expected_previous = ?entryFor(
                RetentionService.OUTBOX_DOMAIN
            );
        }],
    )
) {
    case (#ok(plan)) {
        assert (plan.changes.size() == 1);
        assert (
            plan.changes[0].replacement.key.0 ==
            terminalCleanup
        );
        assert (plan.changes[0].expected_previous != null);
    };
    case (#err(_)) Runtime.trap("terminal outbox was not re-aged");
};
let nonterminalOutbox : RetentionTypes.RecordView = #outbox({
    local_id = 15;
    created_at_ns = started;
    retry_expires_at_ns = peerExpiry;
    cleanup_at_ns = terminalCleanup;
    retained_bytes = 115;
    operation_key = (peer, "wagyu_v1:deliver", operation);
    retry_index_key = ?(started, 15);
    pending_credit_charge = null;
    links_detached = false;
});
switch (
    RetentionService.prepareRegistration(
        RetentionService.frozenPolicy(),
        retentionSequence,
        nonterminalOutbox,
    )
) {
    case (#err(#invalid_horizon)) {};
    case (_) Runtime.trap("nonterminal outbox was re-aged");
};
assert (
    RetentionService.terminalCleanupAt(
        Nat64.maxValue -
        RetentionService.TERMINAL_CLEANUP_NS +
        1
    ) == null
);

let renewedFollower : RetentionTypes.RecordView = #follower({
    node = peer;
    funded_at_ns = started + 100;
    retain_until_ns = peerExpiry + 100;
    retained_bytes = 101;
    registration_sequence = 1;
    active = true;
    charges_detached = true;
});
switch (service.planRegistrations([renewedFollower])) {
    case (#ok(plan)) {
        assert (plan.expected_sequence == retentionSequence);
        assert (plan.next_sequence == retentionSequence + 1);
        assert (plan.changes.size() == 1);
        let change = plan.changes[0];
        assert (change.expected_previous != null);
        assert (
            change.replacement.key.0 == peerExpiry + 100
        );
        assert (
            change.current_key ==
            RetentionService.canonicalKey(change.record)
        );
    };
    case (#err(_)) Runtime.trap("renewal replacement was not planned");
};

let siblingShare : RetentionTypes.RecordView = #authored_action({
    action_key = "share-2";
    created_at_ns = started;
    retain_until_ns = peerExpiry;
    retained_bytes = 50;
    sequence = 51;
    certified_record_detached = true;
    kind = #share({
        original_author = peer;
        original_post_id = operation;
    });
});
switch (
    RetentionService.prepareRegistrations(
        RetentionService.frozenPolicy(),
        retentionSequence,
        [
            { view = views[2]; expected_previous = null },
            { view = siblingShare; expected_previous = null },
        ],
    )
) {
    case (#ok(plan)) {
        assert (plan.changes.size() == 2);
        assert (
            plan.changes[0].replacement.key.0 ==
            plan.changes[1].replacement.key.0
        );
        assert (
            plan.changes[0].replacement.key.1 ==
            plan.changes[1].replacement.key.1
        );
        assert (
            plan.changes[0].replacement.key.2 !=
            plan.changes[1].replacement.key.2
        );
    };
    case (#err(_)) Runtime.trap("same-domain suffixes collided");
};

switch (
    RetentionService.prepareRegistrations(
        RetentionService.frozenPolicy(),
        retentionSequence,
        [
            { view = views[0]; expected_previous = null },
            { view = views[0]; expected_previous = null },
        ],
    )
) {
    case (#err(#invalid_record)) {};
    case (_) Runtime.trap("duplicate registration ref was accepted");
};

switch (
    RetentionService.prepareRegistration(
        RetentionService.frozenPolicy(),
        Nat64.maxValue,
        views[0],
    )
) {
    case (#err(#sequence_exhausted)) {};
    case (_) Runtime.trap("exhausted retention suffix was allocated");
};

// Like actions and Like ingress receipts cannot be indexed at the shorter
// peer horizon.
let tooShortLike : RetentionTypes.RecordView = #authored_action({
    action_key = "short-like";
    created_at_ns = started;
    retain_until_ns = peerExpiry;
    retained_bytes = 50;
    sequence = 50;
    certified_record_detached = true;
    kind = #like({
        post_author = peer;
        post_id = operation;
    });
});
switch (
    RetentionService.prepareRegistration(
        RetentionService.frozenPolicy(),
        retentionSequence,
        tooShortLike,
    )
) {
    case (#err(#invalid_horizon)) {};
    case (_) Runtime.trap("short outgoing Like horizon was accepted");
};

let withdrawnLike : RetentionTypes.RecordView = #accepted_like({
    accepted_like_key = "withdrawn-like";
    accepted_sequence = 52;
    accepted_at_ns = started;
    retain_until_ns = likeExpiry;
    withdrawn_at_ns = ?(started + 500);
    retained_bytes = 52;
    post_key = "post";
    notification_sequence = 9;
    segment = null;
});
switch (
    RetentionService.prepareRegistration(
        RetentionService.frozenPolicy(),
        retentionSequence,
        withdrawnLike,
    )
) {
    case (#ok(plan)) {
        assert (
            plan.changes[0].replacement.key.0 == started + 500
        );
    };
    case (#err(_)) Runtime.trap("withdrawn Like was not rescheduled");
};

// A full page covers all 17 variants, derives exact counter/byte decrements,
// and commits them under one cleanup epoch.
switch (service.cleanup({
    now_ns = likeExpiry;
    after = null;
    limit = 64;
})) {
    case (#ok(result)) {
        assert (result.deleted_records == 17);
        assert (result.deleted_indexes == 17);
        assert (result.deferred_records == 0);
        assert (result.held_records == 0);
        assert (result.complete);
    };
    case (#err(_)) Runtime.trap("complete retention cleanup failed");
};
assert (cleanupEpoch == 1);
assert (retentionSequence == 17);

// Stale/missing rows remove only their old index. Protected or incompletely
// accounted rows are deferred with new global suffixes, so they do not starve
// later pages and are never silently deleted.
anomalyMode := true;
switch (service.cleanup({
    now_ns = likeExpiry;
    after = null;
    limit = 64;
})) {
    case (#ok(result)) {
        assert (result.deleted_records == 13);
        assert (result.deleted_indexes == 17);
        assert (result.deferred_records == 2);
        assert (result.held_records == 2);
    };
    case (#err(_)) Runtime.trap("safe anomaly cleanup failed");
};
assert (cleanupEpoch == 2);
assert (retentionSequence == 19);

// A rejected adapter CAS changes no epoch or suffix.
rejectCleanup := true;
let epochBefore = cleanupEpoch;
let sequenceBefore = retentionSequence;
switch (service.cleanup({
    now_ns = likeExpiry;
    after = null;
    limit = 64;
})) {
    case (#err(#state_conflict)) {};
    case (_) Runtime.trap("rejected atomic cleanup was not surfaced");
};
assert (cleanupEpoch == epochBefore);
assert (retentionSequence == sequenceBefore);

switch (service.planCleanup({
    now_ns = likeExpiry;
    after = null;
    limit = RetentionService.MAX_CLEANUP_PAGE + 1;
})) {
    case (#err(#invalid_request)) {};
    case (_) Runtime.trap("oversized cleanup page was accepted");
};
