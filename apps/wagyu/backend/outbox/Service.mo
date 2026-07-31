import Array "mo:core/Array";
import Blob "mo:core/Blob";
import List "mo:core/List";
import Nat "mo:core/Nat";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";

import DueIndexPlanner "DueIndexPlanner";
import Bounds "../protocol/Bounds";
import Hash "../protocol/Hash";
import ProtocolWire "../protocol/Wire";
import RelationshipTypes "../relationships/Types";
import TransportTypes "../transport/Types";
import Types "Types";

module {
    public let MAX_OUTBOX_ITEMS : Nat = 100_000;
    public let MAX_BATCH : Nat = 20;
    public let MAX_PLAN_SCAN : Nat = 200;
    public let MAX_PAGE : Nat = 100;
    public let MAX_AUTOMATIC_RETRIES : Nat = 8;
    public let MAX_RETRY_DELAY_NS : Nat64 = 86_400_000_000_000;

    let MAX_NAT32 : Nat32 = 4_294_967_295;
    let MAX_NAT64 : Nat64 = 18_446_744_073_709_551_615;
    let RETRY_JITTER_DOMAIN : Text = "wagyu.outbox-retry-jitter.v1";

    type FinishPlan = {
        state : Types.StateV1;
        retry_permission : Types.RetryPermission;
        next_attempt_at_ns : ?Nat64;
        node_pause : ?Types.NodePause;
    };

    public func retryJitter(
        prepared : TransportTypes.PreparedDispatchV1,
        attemptNo : Nat32,
    ) : Nat64 {
        let ?digest = Hash.lpHash(
            RETRY_JITTER_DOMAIN,
            [
                prepared.operation_id,
                Principal.toBlob(prepared.target),
                Hash.u32be(attemptNo),
            ],
        ) else return 1;
        let bytes = Blob.toArray(digest);
        var value : Nat64 = 0;
        var index = 0;
        while (index < 8) {
            value := (value << 8) |
                Nat64.fromNat(Nat8.toNat(bytes[index]));
            index += 1;
        };
        if (value == 0) 1 else value;
    };

    public class Service(
        state : Types.State,
        credits : RelationshipTypes.CreditPlanner,
        validPrepared : TransportTypes.PreparedDispatchV1 -> Bool,
    ) {
        public func enqueue(
            request : Types.EnqueueRequest,
            nowNs : Nat64,
        ) : Types.EnqueueResult {
            if (
                request.local_id == 0 or
                not validPrepared(request.prepared) or
                isZero(request.prepared.operation_id) or
                request.prepared.created_at_ns > nowNs
            ) return #err(#invalid_request);
            if (state.count() > MAX_OUTBOX_ITEMS) return #err(#corrupt_state);

            let ?retryExpires = addNat64(
                request.prepared.created_at_ns,
                TransportTypes.RETRY_HORIZON_NS,
            ) else return #err(#clock_overflow);
            if (nowNs >= retryExpires) return #err(#expired);

            switch (state.find_operation(
                request.prepared.target,
                request.prepared.route,
                request.prepared.operation_id,
            )) {
                case (?existing) {
                    if (not validItem(existing)) return #err(#corrupt_state);
                    if (exactPreparedEqual(existing.prepared, request.prepared)) {
                        return #existing(existing);
                    };
                    return #err(#operation_conflict);
                };
                case null {};
            };
            if (state.item(request.local_id) != null) {
                return #err(#operation_conflict);
            };
            if (state.count() >= MAX_OUTBOX_ITEMS) return #err(#full);

            let isDelivery = request.prepared.route == Bounds.DELIVER_ROUTE;
            let debit = if (isDelivery) {
                let ?subscription = request.delivery_subscription_id else {
                    return #err(#invalid_request);
                };
                let ?encodedRenewal = request.encoded_renewal_requested else {
                    return #err(#invalid_request);
                };
                let ?body = ProtocolWire.decodeDeliverBody(
                    request.prepared.exact_body_candid,
                ) else return #err(#invalid_request);
                if (
                    body.event == null or
                    not Blob.equal(body.subscription_id, subscription) or
                    body.renewal_requested != encodedRenewal
                ) return #err(#invalid_request);
                let plan = switch (credits.prepare_debit(
                    request.prepared.target,
                    subscription,
                    nowNs,
                )) {
                    case (#err(error)) {
                        return #err(#credit_unavailable(error));
                    };
                    case (#ok(value)) value;
                };
                if (plan.renewal_requested != encodedRenewal) {
                    return #err(#state_conflict);
                };
                ?plan;
            } else {
                if (
                    request.delivery_subscription_id != null or
                    request.encoded_renewal_requested != null
                ) return #err(#invalid_request);
                null;
            };
            let item : Types.Item = {
                local_id = request.local_id;
                storage_revision = 1;
                prepared = request.prepared;
                created_at_ns = request.prepared.created_at_ns;
                retry_expires_at_ns = retryExpires;
                updated_at_ns = nowNs;
                attempt_no = 1;
                attempt_prepared = true;
                state = #queued;
                retry_permission = #automatic;
                next_attempt_at_ns = ?nowNs;
                last_attempt_at_ns = null;
                automatic_retry_count = 0;
                delivery_subscription_id =
                    request.delivery_subscription_id;
                pending_credit_charge = switch (debit) {
                    case null null;
                    case (?plan) ?plan.charge;
                };
                last_result = null;
            };
            let mutation : Types.Mutation = {
                local_id = request.local_id;
                expected_storage_revision = null;
                next_item = item;
                follower_mutation = switch (debit) {
                    case null null;
                    case (?plan) ?plan.mutation;
                };
                control_mutation = null;
            };
            if (not state.commit(mutation)) return #err(#state_conflict);
            #queued(item);
        };

        public func get(localId : Nat64) : ?Types.Item {
            let ?item = state.item(localId) else return null;
            if (validItem(item)) ?item else null;
        };

        public func page(
            afterLocalId : ?Nat64,
            limit : Nat,
        ) : Types.PageResult {
            if (limit == 0 or limit > MAX_PAGE) {
                return #err(#invalid_request);
            };
            let items = state.page_after(afterLocalId, limit);
            if (
                items.size() > limit or
                not validOrderedPage(items, afterLocalId)
            ) return #err(#corrupt_state);
            for (item in items.vals()) {
                if (not validItem(item)) return #err(#corrupt_state);
            };
            #ok(items);
        };

        public func planBatch(
            request : Types.PlanRequest,
        ) : Types.PlanResult {
            switch (state.control().pause) {
                case (?reason) return #err(#node_paused(reason));
                case null {};
            };
            if (state.count() > MAX_OUTBOX_ITEMS) return #err(#corrupt_state);
            let ?page = state.due_page(
                request.after_local_id,
                DueIndexPlanner.MAX_PAGE,
            ) else return #err(#corrupt_state);
            if (
                page.entries.size() > DueIndexPlanner.MAX_PAGE or
                (
                    switch (
                        request.after_local_id,
                        page.after_key,
                    ) {
                        case (null, ?_) true;
                        case (?localId, ?key) localId != key.1;
                        case (_) false;
                    }
                )
            ) return #err(#corrupt_state);
            let indexed = List.empty<DueIndexPlanner.Entry>();
            for (entry in page.entries.vals()) {
                if (
                    not validItem(entry.item) or
                    entry.key.1 != entry.item.local_id or
                    entry.item.next_attempt_at_ns != ?entry.key.0
                ) return #err(#corrupt_state);
                List.add(indexed, {
                    key = entry.key;
                    ready = ready(
                        entry.item,
                        request.mode,
                        request.now_ns,
                    );
                });
            };
            switch (
                DueIndexPlanner.plan(
                    List.toArray(indexed),
                    page.after_key,
                    request.now_ns,
                )
            ) {
                case (#err(#invalid_cursor)) {
                    #err(#invalid_cursor);
                };
                case (#err(#corrupt_page)) {
                    #err(#corrupt_state);
                };
                case (#ok(plan)) {
                    #ok({
                        local_ids = plan.local_ids;
                        next_after_local_id = switch (plan.next_after) {
                            case null null;
                            case (?key) ?key.1;
                        };
                        complete = plan.complete;
                    });
                };
            };
        };

        public func beginDispatch(
            localId : Nat64,
            mode : Types.DrainMode,
            nowNs : Nat64,
        ) : Types.StartResult {
            switch (state.control().pause) {
                case (?reason) return #err(#node_paused(reason));
                case null {};
            };
            let ?current = state.item(localId) else return #err(#not_found);
            if (not validItem(current)) return #err(#corrupt_state);
            if (nowNs < current.updated_at_ns) return #err(#invalid_request);
            if (nowNs >= current.retry_expires_at_ns) return #err(#expired);
            if (current.state == #sending) return #err(#in_flight);
            if (not ready(current, mode, nowNs)) return #err(#not_ready);

            var attemptNo = current.attempt_no;
            var automaticCount = Nat16.toNat(
                current.automatic_retry_count,
            );
            var followerMutation : ?RelationshipTypes.FollowerMutation = null;
            var creditCharge = current.pending_credit_charge;

            if (not current.attempt_prepared) {
                if (attemptNo == MAX_NAT32) return #err(#revision_overflow);
                attemptNo += 1;
                // Automatic permission owns its retry budget regardless of
                // which trusted entrypoint selected the row. Owner mode must
                // not turn an automatic row into an uncounted retry loop.
                if (current.retry_permission == #automatic) {
                    if (automaticCount >= MAX_AUTOMATIC_RETRIES) {
                        return #err(#retry_not_allowed);
                    };
                    automaticCount += 1;
                };
                switch (current.delivery_subscription_id) {
                    case null {};
                    case (?subscription) {
                        let debit = switch (credits.prepare_debit(
                            current.prepared.target,
                            subscription,
                            nowNs,
                        )) {
                            case (#err(error)) {
                                return #err(#credit_unavailable(error));
                            };
                            case (#ok(value)) value;
                        };
                        followerMutation := ?debit.mutation;
                        creditCharge := ?debit.charge;
                        // The retry intentionally keeps the original encoded
                        // renewal bit even if today's projection differs.
                    };
                };
            };

            if (
                current.prepared.route == Bounds.DELIVER_ROUTE and
                creditCharge == null
            ) return #err(#corrupt_state);
            let ?nextRevision = incrementNat64(current.storage_revision) else {
                return #err(#revision_overflow);
            };
            let next : Types.Item = {
                current with
                storage_revision = nextRevision;
                updated_at_ns = nowNs;
                attempt_no = attemptNo;
                attempt_prepared = true;
                state = #sending;
                retry_permission = #none;
                next_attempt_at_ns = null;
                last_attempt_at_ns = switch (
                    current.last_attempt_at_ns
                ) {
                    case null ?nowNs;
                    case (?value) ?value;
                };
                automatic_retry_count = Nat16.fromNat(automaticCount);
                pending_credit_charge = creditCharge;
            };
            if (not state.commit({
                local_id = current.local_id;
                expected_storage_revision = ?current.storage_revision;
                next_item = next;
                follower_mutation = followerMutation;
                control_mutation = null;
            })) return #err(#state_conflict);
            #dispatch({
                local_id = next.local_id;
                attempt_no = next.attempt_no;
                prepared = next.prepared;
            });
        };

        public func finishDispatch(
            request : Types.FinishRequest,
        ) : Types.FinishResult {
            let ?current = state.item(request.local_id) else {
                return #err(#not_found);
            };
            if (not validItem(current)) return #err(#corrupt_state);
            if (
                current.state != #sending or
                not current.attempt_prepared
            ) return #err(#not_ready);
            if (current.attempt_no != request.attempt_no) {
                return #err(#attempt_mismatch);
            };
            if (request.callback_time_ns < current.updated_at_ns) {
                return #err(#invalid_request);
            };
            if (
                not validDispatchResult(
                    current.prepared.route,
                    request.result,
                )
            ) {
                return #err(#corrupt_state);
            };

            let creditDisposition : RelationshipTypes.CreditDisposition =
                switch (request.result.certainty) {
                    // This is the only branch allowed to refund.
                    case (#not_dispatched) #restore;
                    case (#may_have_dispatched) #consume;
                    case (#semantic) #consume;
                };
            let relationshipPause = deliveryPause(request.result);
            let followerMutation = switch (current.pending_credit_charge) {
                case null {
                    if (current.prepared.route == Bounds.DELIVER_ROUTE) {
                        return #err(#corrupt_state);
                    };
                    null;
                };
                case (?charge) {
                    let finish = switch (credits.prepare_finish({
                        charge;
                        disposition = creditDisposition;
                        pause = relationshipPause;
                    })) {
                        case (#err(error)) {
                            return #err(#credit_reconciliation(error));
                        };
                        case (#ok(value)) value;
                    };
                    finish.mutation;
                };
            };

            let finishPlan = planFinish(
                current.prepared.route,
                request.result,
                request.callback_time_ns,
                request.jitter,
                current.retry_expires_at_ns,
                Nat16.toNat(current.automatic_retry_count),
            );
            let control = state.control();
            let controlMutation = switch (finishPlan.node_pause) {
                case null null;
                case (?pause) {
                    switch (control.pause) {
                        case (?_) null;
                        case null {
                            let ?nextRevision = incrementNat64(control.revision) else {
                                return #err(#revision_overflow);
                            };
                            ?{
                                expected_revision = control.revision;
                                next = {
                                    revision = nextRevision;
                                    pause = ?pause;
                                };
                            };
                        };
                    };
                };
            };
            let ?nextRevision = incrementNat64(current.storage_revision) else {
                return #err(#revision_overflow);
            };
            let next : Types.Item = {
                current with
                storage_revision = nextRevision;
                updated_at_ns = request.callback_time_ns;
                attempt_prepared = false;
                state = finishPlan.state;
                retry_permission = finishPlan.retry_permission;
                next_attempt_at_ns = finishPlan.next_attempt_at_ns;
                pending_credit_charge = null;
                last_result = ?request.result;
            };
            if (not state.commit({
                local_id = current.local_id;
                expected_storage_revision = ?current.storage_revision;
                next_item = next;
                follower_mutation = followerMutation;
                control_mutation = controlMutation;
            })) return #err(#state_conflict);
            #ok(next);
        };

        public func recoverSending(
            localId : Nat64,
            nowNs : Nat64,
        ) : Types.FinishResult {
            let ?item = state.item(localId) else return #err(#not_found);
            if (not validItem(item)) return #err(#corrupt_state);
            if (item.state != #sending) return #err(#not_ready);
            finishDispatch({
                local_id = localId;
                attempt_no = item.attempt_no;
                callback_time_ns = nowNs;
                jitter = 0;
                result = {
                    outcome = #uncertain;
                    certainty = #may_have_dispatched;
                    retry = #manual({
                        minimum_delay_ns =
                            TransportTypes.UNCERTAIN_RETRY_DELAY_NS;
                    });
                    route_result = null;
                    exact_route_result_candid = null;
                    code = ?"lost_continuation";
                    detail = ?"Dispatch continuation was lost";
                };
            });
        };

        public func resumeItem(
            localId : Nat64,
            nowNs : Nat64,
        ) : Types.FinishResult {
            let ?current = state.item(localId) else return #err(#not_found);
            if (not validItem(current)) return #err(#corrupt_state);
            if (nowNs < current.updated_at_ns) return #err(#invalid_request);
            if (nowNs >= current.retry_expires_at_ns) return #err(#expired);
            switch (current.state) {
                case (#paused or #failed or #uncertain) {};
                case (#sending) return #err(#in_flight);
                case (_) return #err(#retry_not_allowed);
            };
            let ?nextRevision = incrementNat64(current.storage_revision) else {
                return #err(#revision_overflow);
            };
            let next : Types.Item = {
                current with
                storage_revision = nextRevision;
                updated_at_ns = nowNs;
                attempt_prepared = false;
                state = #queued;
                retry_permission = #manual;
                next_attempt_at_ns = ?nowNs;
                pending_credit_charge = null;
            };
            if (not state.commit({
                local_id = localId;
                expected_storage_revision = ?current.storage_revision;
                next_item = next;
                follower_mutation = null;
                control_mutation = null;
            })) return #err(#state_conflict);
            #ok(next);
        };

        public func supersede(
            localId : Nat64,
            nowNs : Nat64,
        ) : Types.FinishResult {
            let ?current = state.item(localId) else return #err(#not_found);
            if (not validItem(current)) return #err(#corrupt_state);
            if (current.state == #sending) return #err(#in_flight);
            if (nowNs < current.updated_at_ns) return #err(#invalid_request);
            if (
                current.state == #accepted or
                current.state == #duplicate or
                current.state == #superseded
            ) return #err(#retry_not_allowed);

            let followerMutation = switch (current.pending_credit_charge) {
                case null null;
                case (?charge) {
                    let finish = switch (credits.prepare_finish({
                        charge;
                        disposition = #restore;
                        pause = null;
                    })) {
                        case (#err(error)) {
                            return #err(#credit_reconciliation(error));
                        };
                        case (#ok(value)) value;
                    };
                    finish.mutation;
                };
            };
            let ?nextRevision = incrementNat64(current.storage_revision) else {
                return #err(#revision_overflow);
            };
            let next : Types.Item = {
                current with
                storage_revision = nextRevision;
                updated_at_ns = nowNs;
                attempt_prepared = false;
                state = #superseded;
                retry_permission = #none;
                next_attempt_at_ns = null;
                pending_credit_charge = null;
            };
            if (not state.commit({
                local_id = localId;
                expected_storage_revision = ?current.storage_revision;
                next_item = next;
                follower_mutation = followerMutation;
                control_mutation = null;
            })) return #err(#state_conflict);
            #ok(next);
        };

        public func resumeNode(
            expectedRevision : Nat64,
        ) : { #ok : Types.Control; #err : Types.TransitionError } {
            let current = state.control();
            if (current.revision != expectedRevision) {
                return #err(#state_conflict);
            };
            if (current.pause == null) return #ok(current);
            let ?nextRevision = incrementNat64(current.revision) else {
                return #err(#revision_overflow);
            };
            let next = {
                revision = nextRevision;
                pause = null;
            };
            // Control-only changes still use a real item CAS. The state
            // adapter may expose a reserved local-id zero control row.
            if (not state.commit_control({
                expected_revision = current.revision;
                next;
            })) return #err(#state_conflict);
            #ok(next);
        };

        public func validItem(item : Types.Item) : Bool {
            if (
                item.local_id == 0 or
                item.storage_revision == 0 or
                not validPrepared(item.prepared) or
                isZero(item.prepared.operation_id) or
                item.created_at_ns != item.prepared.created_at_ns or
                item.updated_at_ns < item.created_at_ns or
                item.attempt_no == 0
            ) return false;
            let expectedExpiry = addNat64(
                item.created_at_ns,
                TransportTypes.RETRY_HORIZON_NS,
            );
            if (expectedExpiry != ?item.retry_expires_at_ns) return false;
            let isDelivery = item.prepared.route == Bounds.DELIVER_ROUTE;
            if (isDelivery != (item.delivery_subscription_id != null)) {
                return false;
            };
            switch (item.delivery_subscription_id) {
                case (?value) {
                    if (
                        value.size() != Bounds.SUBSCRIPTION_ID_BYTES or
                        isZero(value)
                    ) return false;
                    let ?body = ProtocolWire.decodeDeliverBody(
                        item.prepared.exact_body_candid,
                    ) else return false;
                    if (
                        body.event == null or
                        not Blob.equal(body.subscription_id, value)
                    ) return false;
                };
                case null {};
            };
            if (
                item.attempt_prepared and isDelivery and
                item.pending_credit_charge == null
            ) return false;
            if (not item.attempt_prepared and item.pending_credit_charge != null) {
                return false;
            };
            switch (item.pending_credit_charge) {
                case (?charge) {
                    let ?subscription = item.delivery_subscription_id else {
                        return false;
                    };
                    if (
                        not Principal.equal(
                            charge.follower,
                            item.prepared.target,
                        ) or
                        not Blob.equal(
                            charge.subscription_id,
                            subscription,
                        )
                    ) return false;
                };
                case null {};
            };
            if (item.state == #sending and not item.attempt_prepared) {
                return false;
            };
            if (
                Nat16.toNat(item.automatic_retry_count) >
                MAX_AUTOMATIC_RETRIES
            ) return false;
            true;
        };
    };

    func ready(
        item : Types.Item,
        mode : Types.DrainMode,
        nowNs : Nat64,
    ) : Bool {
        if (nowNs < item.updated_at_ns or nowNs >= item.retry_expires_at_ns) {
            return false;
        };
        switch (item.next_attempt_at_ns) {
            case (?value) if (value > nowNs) return false;
            case null {};
        };
        switch (item.state) {
            case (#queued) {};
            case (#failed or #uncertain) {
                if (item.attempt_prepared) return false;
            };
            case (_) return false;
        };
        if (item.attempt_prepared) return item.state == #queued;
        switch (item.retry_permission, mode) {
            case (#automatic, _) {
                Nat16.toNat(item.automatic_retry_count) <
                MAX_AUTOMATIC_RETRIES;
            };
            case (#manual, #owner) true;
            case (#local_state_change, #owner) true;
            case (_) false;
        };
    };

    func planFinish(
        route : Text,
        result : TransportTypes.DispatchResultV1,
        nowNs : Nat64,
        jitter : Nat64,
        retryExpiresAtNs : Nat64,
        automaticRetryCount : Nat,
    ) : FinishPlan {
        switch (result.outcome) {
            case (#accepted) terminal(#accepted);
            case (#duplicate) terminal(#duplicate);
            case (#route_rejected(reason)) {
                if (transientLikeFull(route, result)) {
                    return delayedPlan(
                        result.retry,
                        nowNs,
                        jitter,
                        retryExpiresAtNs,
                        automaticRetryCount,
                    );
                };
                switch (reason) {
                    case (
                        #blocked or
                        #not_following or
                        #incompatible or
                        #unknown_post
                    ) {
                        {
                            state = #paused;
                            retry_permission = #local_state_change;
                            next_attempt_at_ns = null;
                            node_pause = null;
                        };
                    };
                    case (_) terminal(#failed);
                };
            };
            case (#busy or #rate_limited) {
                if (result.certainty == #not_dispatched) {
                    delayedPlan(
                        result.retry,
                        nowNs,
                        jitter,
                        retryExpiresAtNs,
                        automaticRetryCount,
                    );
                } else {
                    delayedManualPlan(
                        result.retry,
                        nowNs,
                        jitter,
                        retryExpiresAtNs,
                    );
                };
            };
            case (#low_cycles) {
                {
                    state = #paused;
                    retry_permission = #local_state_change;
                    next_attempt_at_ns = null;
                    node_pause = if (
                        result.certainty == #not_dispatched
                    ) ?#low_cycles else null;
                };
            };
            case (#revoked) {
                {
                    state = #paused;
                    retry_permission = #local_state_change;
                    next_attempt_at_ns = null;
                    node_pause = if (
                        result.certainty == #not_dispatched
                    ) ?#authority_revoked else null;
                };
            };
            case (#handler_failure) {
                {
                    state = #failed;
                    retry_permission = #manual;
                    next_attempt_at_ns = manualRetryAt(
                        result.retry,
                        nowNs,
                        retryExpiresAtNs,
                        0,
                    );
                    node_pause = null;
                };
            };
            case (#uncertain or #unsupported) {
                {
                    state = #uncertain;
                    retry_permission = #manual;
                    next_attempt_at_ns = manualRetryAt(
                        result.retry,
                        nowNs,
                        retryExpiresAtNs,
                        TransportTypes.UNCERTAIN_RETRY_DELAY_NS,
                    );
                    node_pause = null;
                };
            };
            case (#pre_dispatch_failure) {
                {
                    state = #failed;
                    retry_permission = switch (result.retry) {
                        case (#manual(_)) #manual;
                        case (_) #none;
                    };
                    next_attempt_at_ns = manualRetryAt(
                        result.retry,
                        nowNs,
                        retryExpiresAtNs,
                        0,
                    );
                    node_pause = null;
                };
            };
        };
    };

    func delayedManualPlan(
        retry : TransportTypes.RetryPolicyV1,
        nowNs : Nat64,
        jitter : Nat64,
        expiresAtNs : Nat64,
    ) : FinishPlan {
        let next = switch (retry) {
            case (#delayed(delay)) {
                retryAt(
                    nowNs,
                    delay.minimum_delay_ns,
                    delay.jitter_window_ns,
                    jitter,
                    expiresAtNs,
                );
            };
            case (_) null;
        };
        {
            state = #uncertain;
            retry_permission = #manual;
            next_attempt_at_ns = next;
            node_pause = null;
        };
    };

    func delayedPlan(
        retry : TransportTypes.RetryPolicyV1,
        nowNs : Nat64,
        jitter : Nat64,
        expiresAtNs : Nat64,
        automaticRetryCount : Nat,
    ) : FinishPlan {
        if (automaticRetryCount >= MAX_AUTOMATIC_RETRIES) {
            return {
                state = #failed;
                retry_permission = #manual;
                next_attempt_at_ns = null;
                node_pause = null;
            };
        };
        let next = switch (retry) {
            case (#delayed(delay)) {
                retryAt(
                    nowNs,
                    delay.minimum_delay_ns,
                    delay.jitter_window_ns,
                    jitter,
                    expiresAtNs,
                );
            };
            case (_) null;
        };
        switch (next) {
            case null {
                {
                    state = #failed;
                    retry_permission = #manual;
                    next_attempt_at_ns = null;
                    node_pause = null;
                };
            };
            case (?value) {
                {
                    state = #queued;
                    retry_permission = #automatic;
                    next_attempt_at_ns = ?value;
                    node_pause = null;
                };
            };
        };
    };

    func terminal(value : Types.StateV1) : FinishPlan {
        {
            state = value;
            retry_permission = #none;
            next_attempt_at_ns = null;
            node_pause = null;
        };
    };

    func manualRetryAt(
        retry : TransportTypes.RetryPolicyV1,
        nowNs : Nat64,
        expiresAtNs : Nat64,
        enforcedMinimum : Nat64,
    ) : ?Nat64 {
        let requested = switch (retry) {
            case (#manual(value)) value.minimum_delay_ns;
            case (_) return null;
        };
        let delay = if (requested > enforcedMinimum) {
            requested;
        } else enforcedMinimum;
        retryAt(nowNs, delay, 0, 0, expiresAtNs);
    };

    func retryAt(
        nowNs : Nat64,
        minimum : Nat64,
        jitterWindow : Nat64,
        jitter : Nat64,
        expiresAtNs : Nat64,
    ) : ?Nat64 {
        if (
            minimum > MAX_RETRY_DELAY_NS or
            jitterWindow > MAX_RETRY_DELAY_NS
        ) return null;
        let jitterAmount : Nat64 = if (jitterWindow == 0) {
            (0 : Nat64);
        } else if (jitterWindow == 1) {
            (1 : Nat64);
        } else {
            1 + (jitter % (jitterWindow - 1));
        };
        let ?withMinimum = addNat64(nowNs, minimum) else return null;
        let ?next = addNat64(withMinimum, jitterAmount) else return null;
        if (next >= expiresAtNs) null else ?next;
    };

    func deliveryPause(
        result : TransportTypes.DispatchResultV1,
    ) : ?RelationshipTypes.DeliveryPause {
        if (result.certainty != #semantic) return null;
        switch (result.outcome) {
            case (#route_rejected(#blocked)) ?#blocked;
            case (#route_rejected(#not_following)) ?#not_following;
            case (#route_rejected(#incompatible)) ?#incompatible;
            case (_) null;
        };
    };

    func validDispatchResult(
        route : Text,
        result : TransportTypes.DispatchResultV1,
    ) : Bool {
        switch (result.outcome) {
            case (#accepted or #duplicate) {
                result.certainty == #semantic and
                result.retry == #complete and
                result.route_result != null and
                result.exact_route_result_candid != null;
            };
            case (#route_rejected(_)) {
                result.certainty == #semantic and
                (
                    result.retry == #terminal or
                    transientLikeFull(route, result)
                ) and
                result.route_result != null and
                result.exact_route_result_candid != null;
            };
            case (#busy or #rate_limited) {
                switch (result.retry) {
                    case (#delayed(delay)) {
                        delay.minimum_delay_ns > 0 and
                        delay.minimum_delay_ns <= MAX_RETRY_DELAY_NS and
                        delay.jitter_window_ns <= MAX_RETRY_DELAY_NS;
                    };
                    case (_) false;
                };
            };
            case (#low_cycles or #revoked) result.retry == #pause;
            case (#handler_failure) {
                switch (result.retry) {
                    case (#manual(_)) true;
                    case (_) false;
                };
            };
            case (#uncertain or #unsupported) {
                result.certainty != #not_dispatched and
                (switch (result.retry) {
                    case (#manual(_)) true;
                    case (_) false;
                });
            };
            case (#pre_dispatch_failure) {
                result.certainty == #not_dispatched;
            };
        };
    };

    func transientLikeFull(
        route : Text,
        result : TransportTypes.DispatchResultV1,
    ) : Bool {
        if (
            route != Bounds.LIKE_ROUTE or
            result.certainty != #semantic or
            result.outcome != #route_rejected(#full)
        ) return false;
        let ?routeResult = result.route_result else return false;
        if (routeResult.local_receipt_time_ns != null) return false;
        switch (routeResult.outcome, result.retry) {
            case (
                ?#rejected({ reason = ?#full }),
                #delayed(delay),
            ) {
                delay.minimum_delay_ns ==
                TransportTypes.LIKE_FULL_RETRY_DELAY_NS and
                delay.jitter_window_ns == 0;
            };
            case (_) false;
        };
    };

    func validOrderedPage(items : [Types.Item], after : ?Nat64) : Bool {
        var previous : Nat64 = switch (after) {
            case (?value) value;
            case null (0 : Nat64);
        };
        for (item in items.vals()) {
            if (item.local_id <= previous) return false;
            previous := item.local_id;
        };
        true;
    };

    public func exactPreparedEqual(
        left : TransportTypes.PreparedDispatchV1,
        right : TransportTypes.PreparedDispatchV1,
    ) : Bool {
        Principal.equal(left.target, right.target) and
        left.route == right.route and
        Blob.equal(left.operation_id, right.operation_id) and
        Blob.equal(left.payload_digest, right.payload_digest) and
        Blob.equal(left.exact_body_candid, right.exact_body_candid) and
        Blob.equal(left.exact_ingress_candid, right.exact_ingress_candid) and
        Blob.equal(left.exact_call_args, right.exact_call_args) and
        left.cycles == right.cycles and
        left.maximum_response_bytes == right.maximum_response_bytes and
        left.created_at_ns == right.created_at_ns;
    };

    func incrementNat64(value : Nat64) : ?Nat64 {
        if (value == MAX_NAT64) null else ?(value + 1);
    };

    func addNat64(left : Nat64, right : Nat64) : ?Nat64 {
        if (left > MAX_NAT64 - right) null else ?(left + right);
    };

    func isZero(value : Blob) : Bool {
        for (byte in value.values()) if (byte != 0) return false;
        true;
    };

};
