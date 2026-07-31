import List "mo:core/List";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Nat64 "mo:core/Nat64";
import Order "mo:core/Order";
import Principal "mo:core/Principal";
import Text "mo:core/Text";

import Memory "../memory/wagyu/v3";
import Types "Types";

module {
    public let PEER_RETENTION_NS : Nat64 = 34_560_000_000_000_000;
    public let LIKE_RETENTION_NS : Nat64 = 157_680_000_000_000_000;
    public let RATE_WINDOW_NS : Nat64 = 3_600_000_000_000;
    public let TERMINAL_CLEANUP_NS : Nat64 = 604_800_000_000_000;
    public let MAINTENANCE_RETRY_NS : Nat64 = 86_400_000_000_000;
    public let MAX_CLEANUP_PAGE : Nat = 64;
    public let MAX_REGISTRATION_BATCH : Nat = 64;

    // These tags are stable storage identifiers, not Candid discriminants.
    // Never infer them from variant hash/order and never reuse a retired tag.
    public let FOLLOWER_DOMAIN : Nat8 = 1;
    public let AUTHORED_POST_DOMAIN : Nat8 = 2;
    public let AUTHORED_ACTION_DOMAIN : Nat8 = 3;
    public let FEED_CANDIDATE_DOMAIN : Nat8 = 4;
    public let VERIFIED_FEED_DOMAIN : Nat8 = 5;
    public let SHARE_ATTRIBUTION_DOMAIN : Nat8 = 6;
    public let SUPPRESSION_DOMAIN : Nat8 = 7;
    public let TOMBSTONE_RELAY_DOMAIN : Nat8 = 8;
    public let NOTIFICATION_DOMAIN : Nat8 = 9;
    public let NOTICE_SEMANTIC_DOMAIN : Nat8 = 10;
    public let ACCEPTED_LIKE_DOMAIN : Nat8 = 11;
    public let SEALED_LIKE_BATCH_DOMAIN : Nat8 = 12;
    public let INGRESS_RECEIPT_DOMAIN : Nat8 = 13;
    public let CALLER_RATE_WINDOW_DOMAIN : Nat8 = 14;
    public let OUTBOX_DOMAIN : Nat8 = 15;
    public let FANOUT_JOB_DOMAIN : Nat8 = 16;
    public let FANOUT_TARGET_DOMAIN : Nat8 = 17;

    public func frozenPolicy() : Types.Policy {
        {
            peer_records_ns = PEER_RETENTION_NS;
            likes_ns = LIKE_RETENTION_NS;
            rate_window_ns = RATE_WINDOW_NS;
        };
    };

    public func validPolicy(policy : Types.Policy) : Bool {
        policy.peer_records_ns == PEER_RETENTION_NS and
        policy.likes_ns == LIKE_RETENTION_NS and
        policy.rate_window_ns == RATE_WINDOW_NS;
    };

    // Returns the exact bounded cleanup deadline used when a V2 terminal
    // outbox/fanout row first becomes fully detached. Null leaves the
    // original horizon in place rather than wrapping a Nat64 timestamp.
    public func terminalCleanupAt(detachedAtNs : Nat64) : ?Nat64 {
        addNat64(detachedAtNs, TERMINAL_CLEANUP_NS);
    };

    public func domain(record : Types.RecordRef) : Nat8 {
        switch (record) {
            case (#follower(_)) FOLLOWER_DOMAIN;
            case (#authored_post(_)) AUTHORED_POST_DOMAIN;
            case (#authored_action(_)) AUTHORED_ACTION_DOMAIN;
            case (#feed_candidate(_)) FEED_CANDIDATE_DOMAIN;
            case (#verified_feed(_)) VERIFIED_FEED_DOMAIN;
            case (#share_attribution(_)) SHARE_ATTRIBUTION_DOMAIN;
            case (#suppression(_)) SUPPRESSION_DOMAIN;
            case (#tombstone_relay(_)) TOMBSTONE_RELAY_DOMAIN;
            case (#notification(_)) NOTIFICATION_DOMAIN;
            case (#notice_semantic(_)) NOTICE_SEMANTIC_DOMAIN;
            case (#accepted_like(_)) ACCEPTED_LIKE_DOMAIN;
            case (#sealed_like_batch(_)) SEALED_LIKE_BATCH_DOMAIN;
            case (#ingress_receipt(_)) INGRESS_RECEIPT_DOMAIN;
            case (#caller_rate_window(_)) CALLER_RATE_WINDOW_DOMAIN;
            case (#outbox(_)) OUTBOX_DOMAIN;
            case (#fanout_job(_)) FANOUT_JOB_DOMAIN;
            case (#fanout_target(_)) FANOUT_TARGET_DOMAIN;
        };
    };

    // Collision-free canonical key for memory.retention_current. Text-backed
    // stable keys are length framed because they may themselves contain any
    // delimiter used by this module.
    public func canonicalKey(record : Types.RecordRef) : Text {
        let tag = Nat.toText(Nat8.toNat(domain(record)));
        let identity = switch (record) {
            case (#follower(value)) Principal.toText(value);
            case (#authored_post(value)) value;
            case (#authored_action(value)) value;
            case (#feed_candidate(value)) value;
            case (#verified_feed(value)) value;
            case (#share_attribution(value)) value;
            case (#suppression(value)) value;
            case (#tombstone_relay(value)) value;
            case (#notification(value)) Nat64.toText(value);
            case (#notice_semantic(value)) value;
            case (#accepted_like(value)) value;
            case (#sealed_like_batch(value)) value;
            case (#ingress_receipt(value)) value;
            case (#caller_rate_window(value)) value;
            case (#outbox(value)) Nat64.toText(value);
            case (#fanout_job(value)) Nat64.toText(value);
            case (#fanout_target(value)) value;
        };
        "wagyu.retention.v1:" # tag # ":" #
        Nat.toText(identity.size()) # ":" # identity;
    };

    // Use this planner inside the same no-await outer mutation that stores or
    // renews the primary row. Its sequence is global across every domain.
    public func prepareRegistration(
        policy : Types.Policy,
        expectedSequence : Nat64,
        view : Types.RecordView,
    ) : Types.RegistrationResult {
        prepareRegistrations(
            policy,
            expectedSequence,
            [{ view; expected_previous = null }],
        );
    };

    // Multi-row ingress and publication commits use this form so every
    // primary row and every expiry entry share one outer atomic mutation.
    public func prepareRegistrations(
        policy : Types.Policy,
        expectedSequence : Nat64,
        requests : [Types.RegistrationRequest],
    ) : Types.RegistrationResult {
        if (not validPolicy(policy)) return #err(#invalid_horizon);
        if (
            requests.size() == 0 or
            requests.size() > MAX_REGISTRATION_BATCH
        ) return #err(#invalid_record);
        if (
            Nat64.fromNat(requests.size()) >
                Nat64.maxValue - expectedSequence
        ) {
            return #err(#sequence_exhausted);
        };
        let changes = List.empty<Types.RegistrationChange>();
        var next = expectedSequence;
        for (request in requests.vals()) {
            let view = request.view;
            if (not validRecord(view) or incompleteAccounting(view)) {
                return #err(#invalid_record);
            };
            if (not validHorizon(policy, view)) {
                return #err(#invalid_horizon);
            };
            next += 1;
            let record = recordRef(view);
            for (existing in changes.values()) {
                if (sameRef(existing.record, record)) {
                    return #err(#invalid_record);
                };
            };
            switch (request.expected_previous) {
                case null {};
                case (?previous) {
                    if (
                        not sameRef(previous.record, record) or
                        previous.key.2 == 0 or
                        previous.key.1 != domain(record)
                    ) return #err(#invalid_record);
                };
            };
            List.add(changes, {
                current_key = canonicalKey(record);
                record;
                expected_previous = request.expected_previous;
                replacement = {
                    key = (nextCleanupAt(view), domain(record), next);
                    record;
                };
            });
        };
        #ok({
            expected_sequence = expectedSequence;
            next_sequence = next;
            changes = List.toArray(changes);
        });
    };

    public class Service(state : Types.State) {
        // Pure planner for an outer primary-row mutation. The caller must
        // apply every change together with those rows; this service never
        // commits an expiry index by itself.
        public func planRegistrations(
            views : [Types.RecordView]
        ) : Types.RegistrationResult {
            let requests = List.empty<Types.RegistrationRequest>();
            for (view in views.vals()) {
                let record = recordRef(view);
                List.add(requests, {
                    view;
                    expected_previous = state.current(record);
                });
            };
            prepareRegistrations(
                state.policy(),
                state.retention_sequence(),
                List.toArray(requests),
            );
        };

        public func planCleanup(
            request : Types.CleanupRequest
        ) : Types.CleanupPlanResult {
            if (
                request.limit == 0 or
                request.limit > MAX_CLEANUP_PAGE
            ) return #err(#invalid_request);
            let policy = state.policy();
            if (not validPolicy(policy)) return #err(#invalid_policy);

            let page = state.page_expired(
                request.after,
                request.now_ns,
                request.limit,
            );
            if (
                page.entries.size() > request.limit or
                (page.entries.size() == 0 and not page.complete)
            ) return #err(#corrupt_index);

            let mutations = List.empty<Types.CleanupMutation>();
            let held = List.empty<Types.HeldEntry>();
            var previous = request.after;
            let expectedRetentionSequence =
                state.retention_sequence();
            var nextRetentionSequence = expectedRetentionSequence;

            for (entry in page.entries.vals()) {
                if (
                    entry.key.2 == 0 or
                    entry.key.0 > request.now_ns or
                    entry.key.1 != domain(entry.record)
                ) return #err(#corrupt_index);
                switch (previous) {
                    case (?key) {
                        if (compareIndex(key, entry.key) != #less) {
                            return #err(#corrupt_index);
                        };
                    };
                    case null {};
                };
                previous := ?entry.key;

                let isCurrent = switch (state.current(entry.record)) {
                    case null false;
                    case (?current) sameEntry(current, entry);
                };
                if (not isCurrent) {
                    List.add(
                        mutations,
                        #delete_index_only({
                            entry;
                            reason = #superseded;
                        }),
                    );
                } else switch (state.inspect(entry)) {
                    case (#missing) {
                        List.add(
                            mutations,
                            #delete_index_only({
                                entry;
                                reason = #missing_record;
                            }),
                        );
                    };
                    case (#held(reason)) {
                        let replacement = switch (deferredEntry(
                            entry,
                            reason,
                            request.now_ns,
                            nextRetentionSequence,
                        )) {
                            case null {
                                return #err(
                                    #retention_sequence_exhausted
                                );
                            };
                            case (?(value, sequence)) {
                                nextRetentionSequence := sequence;
                                value;
                            };
                        };
                        List.add(held, { entry; reason });
                        List.add(
                            mutations,
                            #defer({ entry; replacement; reason }),
                        );
                    };
                    case (#record(view)) {
                        if (
                            not sameRef(recordRef(view), entry.record) or
                            not validRecord(view) or
                            not validHorizon(policy, view)
                        ) return #err(#corrupt_record);
                        if (nextCleanupAt(view) > request.now_ns) {
                            let reason : Types.HoldReason = #not_due;
                            let replacement = switch (deferredEntryAt(
                                entry,
                                reason,
                                nextCleanupAt(view),
                                nextRetentionSequence,
                            )) {
                                case null {
                                    return #err(
                                        #retention_sequence_exhausted
                                    );
                                };
                                case (?(value, sequence)) {
                                    nextRetentionSequence := sequence;
                                    value;
                                };
                            };
                            List.add(
                                mutations,
                                #defer({ entry; replacement; reason }),
                            );
                        } else {
                            switch (holdReason(view)) {
                                case (?reason) {
                                    let replacement = switch (deferredEntry(
                                        entry,
                                        reason,
                                        request.now_ns,
                                        nextRetentionSequence,
                                    )) {
                                        case null {
                                            return #err(
                                                #retention_sequence_exhausted
                                            );
                                        };
                                        case (?(value, sequence)) {
                                            nextRetentionSequence := sequence;
                                            value;
                                        };
                                    };
                                    List.add(held, { entry; reason });
                                    List.add(
                                        mutations,
                                        #defer({
                                            entry;
                                            replacement;
                                            reason;
                                        }),
                                    );
                                };
                                case null {
                                    List.add(
                                        mutations,
                                        #delete_record({
                                            entry;
                                            expected = view;
                                            decrement =
                                                counterDelta(view);
                                        }),
                                    );
                                };
                            };
                        };
                    };
                };
            };

            let expectedEpoch = state.cleanup_epoch();
            let mutationArray = List.toArray(mutations);
            if (
                mutationArray.size() > 0 and
                expectedEpoch == Nat64.maxValue
            ) return #err(#cleanup_epoch_exhausted);

            #ok({
                expected_cleanup_epoch = expectedEpoch;
                next_cleanup_epoch = if (mutationArray.size() == 0) {
                    expectedEpoch;
                } else {
                    expectedEpoch + 1;
                };
                expected_retention_sequence =
                    expectedRetentionSequence;
                next_retention_sequence = nextRetentionSequence;
                now_ns = request.now_ns;
                mutations = mutationArray;
                held = List.toArray(held);
                scanned = page.entries.size();
                next_after = previous;
                complete = page.complete;
            });
        };

        public func commitCleanup(
            plan : Types.CleanupPlan
        ) : Types.CleanupCommitResult {
            if (plan.mutations.size() == 0) {
                return #err(#nothing_to_commit);
            };
            var deferred = 0;
            for (mutation in plan.mutations.vals()) {
                switch (mutation) {
                    case (#defer(_)) deferred += 1;
                    case (_) {};
                };
            };
            if (
                plan.expected_cleanup_epoch == Nat64.maxValue or
                plan.next_cleanup_epoch !=
                    plan.expected_cleanup_epoch + 1 or
                plan.next_retention_sequence <
                    plan.expected_retention_sequence or
                Nat64.fromNat(deferred) >
                    Nat64.maxValue -
                        plan.expected_retention_sequence or
                plan.next_retention_sequence !=
                    plan.expected_retention_sequence +
                        Nat64.fromNat(deferred) or
                plan.mutations.size() > MAX_CLEANUP_PAGE
            ) return #err(#invalid_request);
            if (not state.commit_cleanup(plan)) {
                return #err(#state_conflict);
            };
            #ok(commitSummary(plan));
        };

        public func cleanup(
            request : Types.CleanupRequest
        ) : Types.CleanupCommitResult {
            let plan = switch (planCleanup(request)) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            if (plan.mutations.size() == 0) {
                return #ok({
                    deleted_records = 0;
                    deleted_indexes = 0;
                    deferred_records = 0;
                    held_records = plan.held.size();
                    next_after = plan.next_after;
                    complete = plan.complete;
                });
            };
            commitCleanup(plan);
        };
    };

    func commitSummary(
        plan : Types.CleanupPlan
    ) : {
        deleted_records : Nat;
        deleted_indexes : Nat;
        deferred_records : Nat;
        held_records : Nat;
        next_after : ?Types.IndexKey;
        complete : Bool;
    } {
        var records = 0;
        var deferred = 0;
        for (mutation in plan.mutations.vals()) {
            switch (mutation) {
                case (#delete_record(_)) records += 1;
                case (#delete_index_only(_)) {};
                case (#defer(_)) deferred += 1;
            };
        };
        {
            deleted_records = records;
            deleted_indexes = plan.mutations.size();
            deferred_records = deferred;
            held_records = plan.held.size();
            next_after = plan.next_after;
            complete = plan.complete;
        };
    };

    func deferredEntry(
        entry : Types.Entry,
        _reason : Types.HoldReason,
        nowNs : Nat64,
        sequence : Nat64,
    ) : ?(Types.Entry, Nat64) {
        let ?retryAt = addNat64(nowNs, MAINTENANCE_RETRY_NS)
            else return null;
        deferredEntryAt(entry, _reason, retryAt, sequence);
    };

    func deferredEntryAt(
        entry : Types.Entry,
        _reason : Types.HoldReason,
        retryAt : Nat64,
        sequence : Nat64,
    ) : ?(Types.Entry, Nat64) {
        if (sequence == Nat64.maxValue) return null;
        let next = sequence + 1;
        ?(
            {
                key = (retryAt, domain(entry.record), next);
                record = entry.record;
            },
            next,
        );
    };

    func holdReason(view : Types.RecordView) : ?Types.HoldReason {
        switch (view) {
            case (#follower(value)) {
                if (value.charges_detached) null
                else ?#protected_dependency;
            };
            case (#authored_post(value)) {
                if (value.dependents_detached) null
                else ?#protected_dependency;
            };
            case (#authored_action(value)) {
                if (value.certified_record_detached) null
                else ?#protected_dependency;
            };
            case (#feed_candidate(value)) {
                if (value.dependents_detached) null
                else ?#protected_dependency;
            };
            case (#verified_feed(value)) {
                if (value.dependents_detached) null
                else ?#protected_dependency;
            };
            case (#tombstone_relay(value)) {
                if (value.fanout_detached) null
                else ?#protected_dependency;
            };
            case (#notification(value)) {
                if (value.notice_semantic_detached) null
                else ?#protected_dependency;
            };
            case (#notice_semantic(value)) {
                switch (value.accounted_bytes) {
                    case null ?#missing_accounting;
                    case (?_) null;
                };
            };
            case (#sealed_like_batch(value)) {
                switch (value.accounted_bytes) {
                    case null ?#missing_accounting;
                    case (?_) {
                        if (value.certified_record_detached) null
                        else ?#protected_dependency;
                    };
                };
            };
            case (#accepted_like(value)) {
                switch (value.segment) {
                    case null null;
                    case (?_) ?#protected_dependency;
                };
            };
            case (#ingress_receipt(value)) {
                if (value.domain_dependency_detached) null
                else ?#protected_dependency;
            };
            case (#outbox(value)) {
                if (
                    value.pending_credit_charge == null and
                    value.links_detached
                ) null else ?#protected_dependency;
            };
            case (#fanout_job(value)) {
                if (value.targets_detached) null
                else ?#protected_dependency;
            };
            case (#fanout_target(value)) {
                if (value.outbox_detached) null
                else ?#protected_dependency;
            };
            case (_) null;
        };
    };

    func incompleteAccounting(view : Types.RecordView) : Bool {
        switch (holdReason(view)) {
            case (?#missing_accounting) true;
            case (_) false;
        };
    };

    func validRecord(view : Types.RecordView) : Bool {
        switch (view) {
            case (#follower(value)) {
                value.registration_sequence > 0 and
                value.retained_bytes > 0;
            };
            case (#authored_post(value)) {
                value.post_key.size() > 0 and
                value.author_sequence > 0 and
                value.retained_bytes > 0;
            };
            case (#authored_action(value)) {
                value.action_key.size() > 0 and
                value.sequence > 0 and
                value.retained_bytes > 0;
            };
            case (#feed_candidate(value)) {
                value.candidate_key.size() > 0 and
                value.local_sequence > 0 and
                value.retained_bytes > 0;
            };
            case (#verified_feed(value)) {
                value.feed_key.size() > 0 and value.retained_bytes > 0;
            };
            case (#share_attribution(value)) {
                value.attribution_key.size() > 0 and
                value.feed_key.size() > 0 and
                value.candidate_key.size() > 0 and
                value.retained_bytes > 0;
            };
            case (#suppression(value)) {
                value.suppression_key.size() > 0 and
                value.retained_bytes > 0;
            };
            case (#tombstone_relay(value)) {
                value.relay_key.size() > 0 and
                value.fanout_job_id > 0 and
                value.retained_bytes > 0;
            };
            case (#notification(value)) {
                value.local_sequence > 0 and
                value.semantic_key.size() > 0 and
                value.retained_bytes > 0;
            };
            case (#notice_semantic(value)) {
                value.semantic_key.size() > 0 and
                value.notification_sequence > 0 and
                value.target_post_key.size() > 0 and
                (switch (value.accounted_bytes) {
                    case null true;
                    case (?bytes) bytes > 0;
                });
            };
            case (#accepted_like(value)) {
                value.accepted_like_key.size() > 0 and
                value.accepted_sequence > 0 and
                value.post_key.size() > 0 and
                value.notification_sequence > 0 and
                value.retained_bytes > 0;
            };
            case (#sealed_like_batch(value)) {
                value.batch_key.size() > 0 and
                value.post_key.size() > 0 and
                (switch (value.accounted_bytes) {
                    case null true;
                    case (?bytes) bytes > 0;
                });
            };
            case (#ingress_receipt(value)) {
                value.receipt_key.size() > 0 and
                value.retained_bytes > 0;
            };
            case (#caller_rate_window(value)) {
                value.window_key.size() > 0 and
                value.retained_bytes > 0;
            };
            case (#outbox(value)) {
                value.local_id > 0 and
                value.retained_bytes > 0 and
                value.operation_key.1.size() > 0 and
                value.operation_key.2.size() > 0;
            };
            case (#fanout_job(value)) {
                value.fanout_job_id > 0 and
                value.retained_bytes > 0;
            };
            case (#fanout_target(value)) {
                value.target_key.size() > 0 and
                value.fanout_job_id > 0 and
                value.outbox_local_id > 0 and
                value.retained_bytes > 0;
            };
        };
    };

    func validHorizon(
        policy : Types.Policy,
        view : Types.RecordView,
    ) : Bool {
        if (not validWithdrawal(view)) return false;
        let (anchor, expiry, horizonNs, exact) =
            horizonBounds(view, policy);
        let ?minimum = addNat64(anchor, horizonNs) else return false;
        let primaryValid =
            if (exact) expiry == minimum else expiry >= minimum;
        if (not primaryValid) return false;
        switch (view) {
            // These two domains retain their existing, separately validated
            // withdrawal-driven early cleanup semantics.
            case (#accepted_like(_) or #sealed_like_batch(_)) {
                return true;
            };
            case (_) {};
        };
        let cleanup = nextCleanupAt(view);
        if (cleanup == expiry) return true;
        let ?minimumTerminalCleanup = addNat64(
            anchor,
            TERMINAL_CLEANUP_NS,
        ) else return false;
        cleanup >= minimumTerminalCleanup and
        terminalCleanupEligible(view);
    };

    func terminalCleanupEligible(view : Types.RecordView) : Bool {
        switch (view) {
            case (#outbox(value)) {
                value.pending_credit_charge == null and
                value.links_detached;
            };
            case (#fanout_job(value)) value.targets_detached;
            case (#fanout_target(value)) value.outbox_detached;
            case (_) false;
        };
    };

    func validWithdrawal(view : Types.RecordView) : Bool {
        switch (view) {
            case (#accepted_like(value)) {
                switch (value.withdrawn_at_ns) {
                    case null true;
                    case (?time) {
                        time >= value.accepted_at_ns and
                        time <= value.retain_until_ns;
                    };
                };
            };
            case (#sealed_like_batch(value)) {
                switch (value.withdrawn_at_ns) {
                    case null true;
                    case (?time) {
                        time >= value.sealed_at_ns and
                        time <= value.retain_until_ns;
                    };
                };
            };
            case (_) true;
        };
    };

    func horizonBounds(
        view : Types.RecordView,
        policy : Types.Policy,
    ) : (Nat64, Nat64, Nat64, Bool) {
        switch (view) {
            case (#follower(value)) (
                value.funded_at_ns,
                value.retain_until_ns,
                policy.peer_records_ns,
                false,
            );
            case (#authored_post(value)) (
                value.created_at_ns,
                value.retain_until_ns,
                policy.peer_records_ns,
                false,
            );
            case (#authored_action(value)) (
                value.created_at_ns,
                value.retain_until_ns,
                switch (value.kind) {
                    case (#like(_)) policy.likes_ns;
                    case (_) policy.peer_records_ns;
                },
                false,
            );
            case (#feed_candidate(value)) (
                value.received_at_ns,
                value.retain_until_ns,
                policy.peer_records_ns,
                false,
            );
            case (#verified_feed(value)) (
                value.created_at_ns,
                value.retain_until_ns,
                policy.peer_records_ns,
                false,
            );
            case (#share_attribution(value)) (
                value.verified_at_ns,
                value.retain_until_ns,
                policy.peer_records_ns,
                false,
            );
            case (#suppression(value)) (
                value.suppressed_at_ns,
                value.retain_until_ns,
                policy.peer_records_ns,
                false,
            );
            case (#tombstone_relay(value)) (
                value.created_at_ns,
                value.retain_until_ns,
                policy.peer_records_ns,
                false,
            );
            case (#notification(value)) (
                value.received_at_ns,
                value.retain_until_ns,
                policy.peer_records_ns,
                false,
            );
            case (#notice_semantic(value)) (
                value.received_at_ns,
                value.retain_until_ns,
                policy.peer_records_ns,
                false,
            );
            case (#accepted_like(value)) (
                value.accepted_at_ns,
                value.retain_until_ns,
                policy.likes_ns,
                false,
            );
            case (#sealed_like_batch(value)) (
                value.sealed_at_ns,
                value.retain_until_ns,
                policy.likes_ns,
                false,
            );
            case (#ingress_receipt(value)) (
                value.received_at_ns,
                value.retain_until_ns,
                switch (value.route) {
                    case (#like) policy.likes_ns;
                    case (_) policy.peer_records_ns;
                },
                false,
            );
            case (#caller_rate_window(value)) (
                value.window_started_at_ns,
                value.expires_at_ns,
                policy.rate_window_ns,
                true,
            );
            case (#outbox(value)) (
                value.created_at_ns,
                value.retry_expires_at_ns,
                policy.peer_records_ns,
                true,
            );
            case (#fanout_job(value)) (
                value.created_at_ns,
                value.expires_at_ns,
                policy.peer_records_ns,
                false,
            );
            case (#fanout_target(value)) (
                value.created_at_ns,
                value.expires_at_ns,
                policy.peer_records_ns,
                false,
            );
        };
    };

    func nextCleanupAt(view : Types.RecordView) : Nat64 {
        switch (view) {
            case (#follower(value)) value.retain_until_ns;
            case (#authored_post(value)) value.retain_until_ns;
            case (#authored_action(value)) value.retain_until_ns;
            case (#feed_candidate(value)) value.retain_until_ns;
            case (#verified_feed(value)) value.retain_until_ns;
            case (#share_attribution(value)) value.retain_until_ns;
            case (#suppression(value)) value.retain_until_ns;
            case (#tombstone_relay(value)) value.retain_until_ns;
            case (#notification(value)) value.retain_until_ns;
            case (#notice_semantic(value)) value.retain_until_ns;
            case (#accepted_like(value)) {
                switch (value.withdrawn_at_ns) {
                    case null value.retain_until_ns;
                    case (?time) time;
                };
            };
            case (#sealed_like_batch(value)) {
                switch (value.withdrawn_at_ns) {
                    case null value.retain_until_ns;
                    case (?time) time;
                };
            };
            case (#ingress_receipt(value)) value.retain_until_ns;
            case (#caller_rate_window(value)) value.expires_at_ns;
            case (#outbox(value)) value.cleanup_at_ns;
            case (#fanout_job(value)) value.cleanup_at_ns;
            case (#fanout_target(value)) value.cleanup_at_ns;
        };
    };

    func recordRef(view : Types.RecordView) : Types.RecordRef {
        switch (view) {
            case (#follower(value)) #follower(value.node);
            case (#authored_post(value)) {
                #authored_post(value.post_key);
            };
            case (#authored_action(value)) {
                #authored_action(value.action_key);
            };
            case (#feed_candidate(value)) {
                #feed_candidate(value.candidate_key);
            };
            case (#verified_feed(value)) #verified_feed(value.feed_key);
            case (#share_attribution(value)) {
                #share_attribution(value.attribution_key);
            };
            case (#suppression(value)) {
                #suppression(value.suppression_key);
            };
            case (#tombstone_relay(value)) {
                #tombstone_relay(value.relay_key);
            };
            case (#notification(value)) {
                #notification(value.local_sequence);
            };
            case (#notice_semantic(value)) {
                #notice_semantic(value.semantic_key);
            };
            case (#accepted_like(value)) {
                #accepted_like(value.accepted_like_key);
            };
            case (#sealed_like_batch(value)) {
                #sealed_like_batch(value.batch_key);
            };
            case (#ingress_receipt(value)) {
                #ingress_receipt(value.receipt_key);
            };
            case (#caller_rate_window(value)) {
                #caller_rate_window(value.window_key);
            };
            case (#outbox(value)) #outbox(value.local_id);
            case (#fanout_job(value)) #fanout_job(value.fanout_job_id);
            case (#fanout_target(value)) {
                #fanout_target(value.target_key);
            };
        };
    };

    func counterDelta(view : Types.RecordView) : Types.CounterDelta {
        let empty = emptyDelta();
        switch (view) {
            case (#follower(value)) {
                {
                    empty with
                    follower_head_count = 1;
                    follower_head_bytes = value.retained_bytes;
                    active_follower_count = if (value.active) 1 else 0;
                };
            };
            case (#authored_post(value)) {
                {
                    empty with
                    authored_post_count = 1;
                    authored_bytes = value.retained_bytes;
                };
            };
            case (#authored_action(value)) {
                {
                    empty with
                    authored_action_count = 1;
                    authored_bytes = value.retained_bytes;
                };
            };
            case (#feed_candidate(value)) {
                {
                    empty with
                    candidate_count = 1;
                    candidate_bytes = value.retained_bytes;
                    unread_feed_count = if (value.unread) 1 else 0;
                };
            };
            case (#verified_feed(value)) {
                {
                    empty with
                    verified_feed_count = 1;
                    verified_feed_bytes = value.retained_bytes;
                };
            };
            case (#share_attribution(value)) {
                {
                    empty with
                    share_attribution_count = 1;
                    share_attribution_bytes = value.retained_bytes;
                };
            };
            case (#suppression(value)) {
                {
                    empty with
                    suppression_count = 1;
                    suppression_bytes = value.retained_bytes;
                };
            };
            case (#tombstone_relay(value)) {
                {
                    empty with
                    tombstone_relay_count = 1;
                    tombstone_relay_bytes = value.retained_bytes;
                };
            };
            case (#notification(value)) {
                {
                    empty with
                    notification_count = 1;
                    notification_bytes = value.retained_bytes;
                    unread_notification_count =
                        if (value.unread) 1 else 0;
                };
            };
            case (#notice_semantic(_) or #sealed_like_batch(_)) empty;
            case (#accepted_like(value)) {
                {
                    empty with
                    accepted_like_count = 1;
                    accepted_like_bytes = value.retained_bytes;
                };
            };
            case (#ingress_receipt(value)) {
                {
                    empty with
                    ingress_receipt_count = 1;
                    ingress_receipt_bytes = value.retained_bytes;
                };
            };
            case (#caller_rate_window(value)) {
                {
                    empty with
                    caller_rate_window_count = 1;
                    caller_rate_window_bytes = value.retained_bytes;
                };
            };
            case (#outbox(value)) {
                {
                    empty with
                    outbox_count = 1;
                    outbox_bytes = value.retained_bytes;
                };
            };
            case (#fanout_job(value)) {
                {
                    empty with
                    fanout_job_count = 1;
                    fanout_bytes = value.retained_bytes;
                };
            };
            case (#fanout_target(value)) {
                {
                    empty with
                    fanout_target_count = 1;
                    fanout_bytes = value.retained_bytes;
                };
            };
        };
    };

    func emptyDelta() : Types.CounterDelta {
        {
            follower_head_count = 0;
            follower_head_bytes = 0;
            active_follower_count = 0;
            authored_post_count = 0;
            authored_action_count = 0;
            authored_bytes = 0;
            candidate_count = 0;
            candidate_bytes = 0;
            unread_feed_count = 0;
            verified_feed_count = 0;
            verified_feed_bytes = 0;
            share_attribution_count = 0;
            share_attribution_bytes = 0;
            suppression_count = 0;
            suppression_bytes = 0;
            tombstone_relay_count = 0;
            tombstone_relay_bytes = 0;
            notification_count = 0;
            notification_bytes = 0;
            unread_notification_count = 0;
            accepted_like_count = 0;
            accepted_like_bytes = 0;
            ingress_receipt_count = 0;
            ingress_receipt_bytes = 0;
            caller_rate_window_count = 0;
            caller_rate_window_bytes = 0;
            outbox_count = 0;
            outbox_bytes = 0;
            fanout_job_count = 0;
            fanout_target_count = 0;
            fanout_bytes = 0;
        };
    };

    func sameRef(left : Types.RecordRef, right : Types.RecordRef) : Bool {
        switch (left, right) {
            case (#follower(a), #follower(b)) Principal.equal(a, b);
            case (#authored_post(a), #authored_post(b)) a == b;
            case (#authored_action(a), #authored_action(b)) a == b;
            case (#feed_candidate(a), #feed_candidate(b)) a == b;
            case (#verified_feed(a), #verified_feed(b)) a == b;
            case (#share_attribution(a), #share_attribution(b)) a == b;
            case (#suppression(a), #suppression(b)) a == b;
            case (#tombstone_relay(a), #tombstone_relay(b)) a == b;
            case (#notification(a), #notification(b)) a == b;
            case (#notice_semantic(a), #notice_semantic(b)) a == b;
            case (#accepted_like(a), #accepted_like(b)) a == b;
            case (#sealed_like_batch(a), #sealed_like_batch(b)) a == b;
            case (#ingress_receipt(a), #ingress_receipt(b)) a == b;
            case (
                #caller_rate_window(a),
                #caller_rate_window(b),
            ) a == b;
            case (#outbox(a), #outbox(b)) a == b;
            case (#fanout_job(a), #fanout_job(b)) a == b;
            case (#fanout_target(a), #fanout_target(b)) a == b;
            case (_) false;
        };
    };

    func sameEntry(left : Types.Entry, right : Types.Entry) : Bool {
        compareIndex(left.key, right.key) == #equal and
        sameRef(left.record, right.record);
    };

    func compareIndex(
        left : Types.IndexKey,
        right : Types.IndexKey,
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

    func addNat64(left : Nat64, right : Nat64) : ?Nat64 {
        if (left > Nat64.maxValue - right) null else ?(left + right);
    };
};
