import Array "mo:core/Array";
import Blob "mo:core/Blob";
import List "mo:core/List";
import Nat "mo:core/Nat";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import OrderedFollowerPlanner "../fanout/OrderedFollowerPlanner";
import Bounds "../protocol/Bounds";
import Types "Types";

module {
    public let SUBSCRIPTION_ID_BYTES : Nat = 16;
    public let MAX_FOLLOWING : Nat = 5_000;
    public let MAX_ACTIVE_FOLLOWERS : Nat = 10_000;
    public let MAX_BLOCKS : Nat = 10_000;
    public let FOLLOW_CREDIT_TRANCHE : Nat = 32;
    public let MAX_DELIVERY_CREDITS : Nat = 128;
    public let RENEWAL_REQUEST_THRESHOLD : Nat = 4;
    // Renew while the remote still has four of the initial 32 delivery
    // credits. This signal is derived only from locally verified promotions;
    // the peer-provided renewal hint remains diagnostic.
    public let EARLY_RENEW_VERIFIED_DELIVERY_THRESHOLD : Nat =
        28;
    public let FANOUT_BATCH_LIMIT : Nat = 20;
    public let SEND_QUOTE_SCAN_LIMIT : Nat = 512;

    public let FOLLOW_REQUIRED_CYCLES : Nat = 7_000_000_000;
    public let UNFOLLOW_REQUIRED_CYCLES : Nat = 50_000_000;
    public let DELIVERY_REQUIRED_CYCLES : Nat = 200_000_000;
    public let LIKE_REQUIRED_CYCLES : Nat = 250_000_000;
    public let NOTICE_REQUIRED_CYCLES : Nat = 100_000_000;

    public let LEASE_NS : Nat64 = 34_560_000_000_000_000;
    public let AUTO_RENEW_BEFORE_EXPIRY_NS : Nat64 =
        4_320_000_000_000_000;
    public let AUTO_RENEW_AFTER_NS : Nat64 =
        30_240_000_000_000_000;
    public let MAX_POST_OBJECT_BYTES : Nat = 1_044_480;
    public let MAX_CERTIFIED_OBJECT_BYTES : Nat = 1_048_576;

    let MAX_NAT64 : Nat64 = 18_446_744_073_709_551_615;

    public class Service(
        state : Types.State,
        selfNode : Principal,
        estimator : Types.CostEstimator,
    ) {
        public func applyFollow(
            caller : Principal,
            request : Types.FollowRequest,
            receiptTimeNs : Nat64,
        ) : Types.FollowResult {
            if (not validRemote(caller) or not validId(request.subscription_id)) {
                return #err(#invalid_request);
            };
            if (Principal.equal(caller, selfNode)) return #err(#self_call);
            if (state.block(caller) != null) return #err(#blocked);

            if (state.block_count() > MAX_BLOCKS) return #err(#corrupt_state);
            let activeFollowerCount = state.active_follower_count();
            if (activeFollowerCount > MAX_ACTIVE_FOLLOWERS) {
                return #err(#corrupt_state);
            };

            let current = state.follower(caller);
            switch (current) {
                case (?row) {
                    if (not validFollowerRow(row) or not Principal.equal(row.node, caller)) {
                        return #err(#corrupt_state);
                    };
                    if (row.head_revision != request.expected_revision) {
                        return #err(#conflict(?head(row)));
                    };
                };
                case null {
                    if (request.expected_revision != 0) {
                        return #err(#conflict(null));
                    };
                };
            };

            let counters = state.follower_counters();
            if (not validCounters(counters)) return #err(#corrupt_state);
            switch (current) {
                case (?row) {
                    if (
                        row.registration_sequence >
                        counters.max_registration_sequence
                    ) return #err(#corrupt_state);
                };
                case null {};
            };

            var activation = false;
            var registrationSequence : Nat64 = 0;
            var availableCredits : Nat = 0;
            var outstandingCharges : Nat = 0;
            var grantedCredits = FOLLOW_CREDIT_TRANCHE;

            switch (current) {
                case null {
                    activation := true;
                };
                case (?row) {
                    registrationSequence := row.registration_sequence;
                    switch (row.state) {
                        case (#inactive(inactive)) {
                            if (Blob.equal(
                                inactive.last_subscription_id,
                                request.subscription_id,
                            )) {
                                return #err(#conflict(?head(row)));
                            };
                            activation := true;
                        };
                        case (#active(active)) {
                            if (not Blob.equal(
                                active.subscription_id,
                                request.subscription_id,
                            )) {
                                return #err(#conflict(?head(row)));
                            };
                            availableCredits := Nat16.toNat(active.delivery_credits);
                            outstandingCharges :=
                                Nat16.toNat(row.outstanding_delivery_charges);
                            let existingCredits =
                                availableCredits + outstandingCharges;
                            grantedCredits := Nat.min(
                                FOLLOW_CREDIT_TRANCHE,
                                MAX_DELIVERY_CREDITS - existingCredits,
                            );
                        };
                    };
                };
            };

            if (
                activation and
                activeFollowerCount >= MAX_ACTIVE_FOLLOWERS
            ) return #err(#full);

            let ?leaseExpires = addNat64(receiptTimeNs, LEASE_NS) else {
                return #err(#clock_overflow);
            };
            let nextHeadRevision : Nat64 = switch (current) {
                case null (1 : Nat64);
                case (?row) {
                    let ?next = incrementNat64(row.head_revision) else {
                        return #err(#revision_overflow);
                    };
                    next;
                };
            };
            let nextStorageRevision : Nat64 = switch (current) {
                case null (1 : Nat64);
                case (?row) {
                    let ?next = incrementNat64(row.storage_revision) else {
                        return #err(#revision_overflow);
                    };
                    next;
                };
            };
            let ?nextFollowerRevision =
                incrementNat64(counters.follower_revision) else {
                return #err(#revision_overflow);
            };

            var nextMaxRegistration = counters.max_registration_sequence;
            if (activation) {
                let ?nextRegistration =
                    incrementNat64(counters.max_registration_sequence) else {
                    return #err(#revision_overflow);
                };
                nextMaxRegistration := nextRegistration;
                registrationSequence := nextRegistration;
            };

            let creditTotal = availableCredits + grantedCredits;
            // The cap check includes outstanding restorable attempts. This
            // branch is defensive after either full-tranche admission or the
            // room-sized grant above.
            if (
                creditTotal > MAX_DELIVERY_CREDITS or
                creditTotal + outstandingCharges > MAX_DELIVERY_CREDITS
            ) return #err(#credit_cap);

            let nextRow : Types.FollowerRow = {
                node = caller;
                head_revision = nextHeadRevision;
                storage_revision = nextStorageRevision;
                state = #active({
                    subscription_id = request.subscription_id;
                    lease_expires_ns = leaseExpires;
                    delivery_credits = Nat16.fromNat(creditTotal);
                });
                registration_sequence = registrationSequence;
                funded_at_ns = receiptTimeNs;
                // A fresh paid CAS is the local state change that clears a
                // prior delivery incompatibility pause.
                delivery_pause = null;
                outstanding_delivery_charges =
                    Nat16.fromNat(outstandingCharges);
            };
            let nextCounters : Types.FollowerCounters = {
                follower_revision = nextFollowerRevision;
                max_registration_sequence = nextMaxRegistration;
            };
            let summary = if (activation) {
                ?{
                    node = caller;
                    resulting_revision = nextHeadRevision;
                    received_at_ns = receiptTimeNs;
                };
            } else null;
            let mutation : Types.FollowerMutation = {
                node = caller;
                expected_storage_revision = switch (current) {
                    case null null;
                    case (?row) ?row.storage_revision;
                };
                expected_counters = counters;
                next_row = nextRow;
                next_counters = nextCounters;
                new_follower_summary = summary;
            };
            if (not state.commit_follower(mutation)) {
                return #err(#state_conflict);
            };
            #accepted({
                head = head(nextRow);
                activation;
            });
        };

        public func applyUnfollow(
            caller : Principal,
            request : Types.FollowRequest,
        ) : Types.UnfollowResult {
            if (not validRemote(caller) or not validId(request.subscription_id)) {
                return #err(#invalid_request);
            };
            if (Principal.equal(caller, selfNode)) return #err(#self_call);
            if (state.block(caller) != null) return #err(#blocked);

            let ?current = state.follower(caller) else {
                return #err(#conflict(null));
            };
            if (
                not validFollowerRow(current) or
                not Principal.equal(current.node, caller)
            ) return #err(#corrupt_state);
            if (current.head_revision != request.expected_revision) {
                return #err(#conflict(?head(current)));
            };
            let active = switch (current.state) {
                case (#active(value)) value;
                case (#inactive(_)) return #err(#conflict(?head(current)));
            };
            if (not Blob.equal(active.subscription_id, request.subscription_id)) {
                return #err(#conflict(?head(current)));
            };

            let counters = state.follower_counters();
            if (not validCounters(counters)) return #err(#corrupt_state);
            let ?nextHeadRevision = incrementNat64(current.head_revision) else {
                return #err(#revision_overflow);
            };
            let ?nextStorageRevision = incrementNat64(current.storage_revision) else {
                return #err(#revision_overflow);
            };
            let ?nextFollowerRevision =
                incrementNat64(counters.follower_revision) else {
                return #err(#revision_overflow);
            };
            let nextRow : Types.FollowerRow = {
                current with
                head_revision = nextHeadRevision;
                storage_revision = nextStorageRevision;
                state = #inactive({
                    last_subscription_id = request.subscription_id;
                });
                delivery_pause = null;
                // Unused credits are forfeited. Any in-flight charge from the
                // old subscription is likewise unable to affect a later one.
                outstanding_delivery_charges = 0;
            };
            let mutation : Types.FollowerMutation = {
                node = caller;
                expected_storage_revision = ?current.storage_revision;
                expected_counters = counters;
                next_row = nextRow;
                next_counters = {
                    follower_revision = nextFollowerRevision;
                    max_registration_sequence =
                        counters.max_registration_sequence;
                };
                new_follower_summary = null;
            };
            if (not state.commit_follower(mutation)) {
                return #err(#state_conflict);
            };
            #accepted(head(nextRow));
        };

        public func beginFollowing(
            request : Types.BeginFollowingRequest,
            nowNs : Nat64,
        ) : Types.FollowingResult {
            if (
                not validRemote(request.node) or
                not validId(request.subscription_id)
            ) return #err(#invalid_request);
            if (Principal.equal(request.node, selfNode)) return #err(#self_call);
            if (state.block(request.node) != null) return #err(#blocked);

            let current = state.following(request.node);
            switch (current) {
                case null {
                    if (request.expected_intent_generation != 0) {
                        return #err(#conflict(null));
                    };
                };
                case (?row) {
                    if (
                        not validFollowingRow(row) or
                        not Principal.equal(row.node, request.node)
                    ) return #err(#corrupt_state);
                    if (
                        row.intent_generation !=
                        request.expected_intent_generation
                    ) return #err(#conflict(?row));
                    if (nowNs < row.updated_at_ns) {
                        return #err(#invalid_request);
                    };
                    switch (row.intent) {
                        case (#on(on)) {
                            if (not Blob.equal(
                                on.subscription_id,
                                request.subscription_id,
                            )) return #err(#conflict(?row));
                        };
                        case (#off(off)) {
                            if (Blob.equal(
                                off.last_subscription_id,
                                request.subscription_id,
                            )) return #err(#conflict(?row));
                        };
                    };
                };
            };

            let activeCount = state.following_count();
            if (activeCount > MAX_FOLLOWING) {
                return #err(#corrupt_state);
            };
            let alreadyOn = switch (current) {
                case null false;
                case (?row) {
                    switch (row.intent) {
                        case (#on(_)) true;
                        case (#off(_)) false;
                    };
                };
            };
            if (alreadyOn and activeCount == 0) {
                return #err(#corrupt_state);
            };
            if (not alreadyOn and activeCount >= MAX_FOLLOWING) {
                return #err(#full);
            };

            let nextStorageRevision : Nat64 = switch (current) {
                case null (1 : Nat64);
                case (?row) {
                    let ?next = incrementNat64(row.storage_revision) else {
                        return #err(#revision_overflow);
                    };
                    next;
                };
            };
            let nextGeneration : Nat = switch (current) {
                case null (1 : Nat);
                case (?row) row.intent_generation + 1;
            };
            let nextRow : Types.FollowingRow = {
                node = request.node;
                intent_generation = nextGeneration;
                storage_revision = nextStorageRevision;
                intent = #on({
                    subscription_id = request.subscription_id;
                    status = #registering;
                });
                last_remote_revision = switch (current) {
                    case null null;
                    case (?row) row.last_remote_revision;
                };
                renewal_requested = switch (current) {
                    case null false;
                    case (?row) row.renewal_requested;
                };
                locally_verified_delivery_count = switch (current) {
                    case null (0 : Nat16);
                    case (?row) {
                        switch (row.intent) {
                            // A same-subscription renewal keeps counting
                            // until its paid Follow is acknowledged.
                            case (#on(_)) {
                                row.locally_verified_delivery_count;
                            };
                            // A new subscription starts a new local epoch.
                            case (#off(_)) (0 : Nat16);
                        };
                    };
                };
                // A same-subscription renewal remains anchored to its last
                // acknowledged paid receipt until the remote accepts it.
                updated_at_ns = switch (current) {
                    case null nowNs;
                    case (?row) {
                        switch (row.intent) {
                            case (#on(_)) row.updated_at_ns;
                            case (#off(_)) nowNs;
                        };
                    };
                };
            };
            let mutation : Types.FollowingMutation = {
                node = request.node;
                expected_storage_revision = switch (current) {
                    case null null;
                    case (?row) ?row.storage_revision;
                };
                next_row = nextRow;
            };
            if (not state.commit_following(mutation)) {
                return #err(#state_conflict);
            };
            #ok(nextRow);
        };

        public func endFollowing(
            request : Types.EndFollowingRequest,
            nowNs : Nat64,
        ) : Types.FollowingResult {
            if (not validRemote(request.node)) return #err(#invalid_request);
            if (Principal.equal(request.node, selfNode)) return #err(#self_call);
            let ?current = state.following(request.node) else {
                return #err(#not_found);
            };
            if (
                not validFollowingRow(current) or
                not Principal.equal(current.node, request.node)
            ) return #err(#corrupt_state);
            if (
                current.intent_generation !=
                request.expected_intent_generation
            ) return #err(#conflict(?current));
            let subscription = switch (current.intent) {
                case (#on(on)) on.subscription_id;
                case (#off(_)) return #err(#conflict(?current));
            };
            if (nowNs < current.updated_at_ns) return #err(#invalid_request);
            let ?nextStorageRevision = incrementNat64(current.storage_revision) else {
                return #err(#revision_overflow);
            };
            let nextRow : Types.FollowingRow = {
                current with
                intent_generation = current.intent_generation + 1;
                storage_revision = nextStorageRevision;
                intent = #off({ last_subscription_id = subscription });
                renewal_requested = false;
                locally_verified_delivery_count = 0;
                updated_at_ns = nowNs;
            };
            if (not state.commit_following({
                node = request.node;
                expected_storage_revision = ?current.storage_revision;
                next_row = nextRow;
            })) return #err(#state_conflict);
            #ok(nextRow);
        };

        public func applyRemoteFollowResult(
            node : Principal,
            intentGeneration : Nat,
            subscriptionId : Blob,
            remote : Types.RemoteFollowResult,
            _nowNs : Nat64,
        ) : Types.FollowingResult {
            if (not validRemote(node) or not validId(subscriptionId)) {
                return #err(#invalid_request);
            };
            let ?current = state.following(node) else return #err(#not_found);
            if (
                not validFollowingRow(current) or
                not Principal.equal(current.node, node)
            ) return #err(#corrupt_state);

            let remoteRevision = remoteResultRevision(remote);
            let currentIntentMatches = switch (current.intent) {
                case (#on(on)) {
                    current.intent_generation == intentGeneration and
                    Blob.equal(on.subscription_id, subscriptionId);
                };
                case (#off(_)) false;
            };
            let nextHighWater = maxOptionalNat64(
                current.last_remote_revision,
                remoteRevision,
            );
            let nextIntent = if (currentIntentMatches) {
                switch (current.intent) {
                    case (#on(on)) {
                        #on({
                            subscription_id = on.subscription_id;
                            status = switch (remote) {
                                case (#accepted(_)) #active;
                                case (#duplicate(_)) #active;
                                case (#revision_conflict(_)) #conflicted;
                                case (#incompatible(_)) #incompatible;
                                case (#uncertain(_)) #uncertain;
                            };
                        });
                    };
                    case (#off(off)) #off(off);
                };
            } else current.intent;
            let acknowledgedCurrentIntent = if (currentIntentMatches) {
                switch (remote) {
                    case (#accepted(_) or #duplicate(_)) true;
                    case (
                        #revision_conflict(_) or
                        #incompatible(_) or
                        #uncertain(_)
                    ) false;
                };
            } else false;
            let nextPaidAnchor = if (currentIntentMatches) {
                switch (remote) {
                    case (#accepted(value)) {
                        value.paid_anchor_ns;
                    };
                    case (#duplicate(value)) {
                        value.paid_anchor_ns;
                    };
                    case (_) current.updated_at_ns;
                };
            } else current.updated_at_ns;
            let nextRenewalRequested =
                if (acknowledgedCurrentIntent) false
                else current.renewal_requested;
            let nextVerifiedDeliveryCount =
                if (acknowledgedCurrentIntent) (0 : Nat16)
                else current.locally_verified_delivery_count;
            if (
                nextIntent == current.intent and
                nextHighWater == current.last_remote_revision and
                nextRenewalRequested == current.renewal_requested and
                nextVerifiedDeliveryCount ==
                    current.locally_verified_delivery_count and
                nextPaidAnchor == current.updated_at_ns
            ) return #ok(current);

            let ?nextStorageRevision = incrementNat64(current.storage_revision) else {
                return #err(#revision_overflow);
            };
            let nextRow : Types.FollowingRow = {
                current with
                storage_revision = nextStorageRevision;
                intent = nextIntent;
                last_remote_revision = nextHighWater;
                renewal_requested = nextRenewalRequested;
                locally_verified_delivery_count =
                    nextVerifiedDeliveryCount;
                updated_at_ns = nextPaidAnchor;
            };
            if (not state.commit_following({
                node;
                expected_storage_revision = ?current.storage_revision;
                next_row = nextRow;
            })) return #err(#state_conflict);
            #ok(nextRow);
        };

        // Records one first durable, locally/browser-verified Delivery
        // promotion. The candidate's subscription is matched against local
        // Following state, so a peer payload cannot select or advance a
        // different row. The count saturates at the early-renew threshold.
        public func recordLocallyVerifiedDelivery(
            node : Principal,
            subscriptionId : Blob,
        ) : Types.VerifiedDeliveryCountResult {
            if (
                not validRemote(node) or
                not validId(subscriptionId) or
                Principal.equal(node, selfNode)
            ) return #err(#corrupt_state);
            let ?current = state.following(node) else return #unchanged;
            if (
                not validFollowingRow(current) or
                not Principal.equal(current.node, node)
            ) return #err(#corrupt_state);
            if (state.block(node) != null) return #unchanged;
            switch (current.intent) {
                case (#off(_)) return #unchanged;
                case (#on(on)) {
                    if (
                        not Blob.equal(
                            on.subscription_id,
                            subscriptionId,
                        )
                    ) return #unchanged;
                };
            };
            let count = Nat16.toNat(
                current.locally_verified_delivery_count
            );
            if (
                count >= EARLY_RENEW_VERIFIED_DELIVERY_THRESHOLD
            ) return #unchanged;
            let ?nextStorageRevision =
                incrementNat64(current.storage_revision) else {
                    return #err(#revision_overflow);
                };
            let nextRow : Types.FollowingRow = {
                current with
                storage_revision = nextStorageRevision;
                locally_verified_delivery_count =
                    Nat16.fromNat(count + 1);
            };
            if (not state.commit_following({
                node;
                expected_storage_revision =
                    ?current.storage_revision;
                next_row = nextRow;
            })) return #err(#state_conflict);
            #changed(nextRow);
        };

        public func deliveryAdmission(
            caller : Principal,
            subscriptionId : Blob,
        ) : Types.DeliveryAdmission {
            if (not validRemote(caller) or not validId(subscriptionId)) {
                return #invalid_request;
            };
            if (Principal.equal(caller, selfNode)) return #self_call;
            if (state.block(caller) != null) return #blocked;
            let ?row = state.following(caller) else return #not_following;
            if (
                not validFollowingRow(row) or
                not Principal.equal(row.node, caller)
            ) return #corrupt_state;
            switch (row.intent) {
                case (#off(_)) #not_following;
                case (#on(on)) {
                    if (not Blob.equal(on.subscription_id, subscriptionId)) {
                        #subscription_mismatch;
                    } else switch (on.status) {
                        case (#incompatible) #incompatible;
                        case (_) #allowed;
                    };
                };
            };
        };

        public func block(node : Principal, nowNs : Nat64) : Types.BlockResult {
            if (not validRemote(node)) return #err(#invalid_request);
            if (Principal.equal(node, selfNode)) return #err(#self_call);
            if (state.block_count() > MAX_BLOCKS) return #err(#corrupt_state);
            let currentBlock = state.block(node);
            switch (currentBlock) {
                case (?row) {
                    if (
                        not validBlockRow(row) or
                        not Principal.equal(row.node, node)
                    ) return #err(#corrupt_state);
                };
                case null {};
            };
            if (
                currentBlock == null and
                state.block_count() >= MAX_BLOCKS
            ) return #err(#full);

            let currentFollower = state.follower(node);
            switch (currentFollower) {
                case (?row) {
                    if (
                        not validFollowerRow(row) or
                        not Principal.equal(row.node, node)
                    ) return #err(#corrupt_state);
                };
                case null {};
            };
            let currentFollowing = state.following(node);
            switch (currentFollowing) {
                case (?row) {
                    if (
                        not validFollowingRow(row) or
                        not Principal.equal(row.node, node)
                    ) return #err(#corrupt_state);
                };
                case null {};
            };
            let followerNeedsClosure = switch (currentFollower) {
                case null false;
                case (?row) {
                    switch (row.state) {
                        case (#active(_)) true;
                        case (#inactive(_)) {
                            row.delivery_pause != null or
                            row.outstanding_delivery_charges != 0;
                        };
                    };
                };
            };
            let followingNeedsClosure = switch (currentFollowing) {
                case null false;
                case (?row) {
                    switch (row.intent) {
                        case (#on(_)) true;
                        case (#off(_)) row.renewal_requested;
                    };
                };
            };
            if (
                currentBlock != null and
                not followerNeedsClosure and
                not followingNeedsClosure
            ) return #unchanged;

            let counters = state.follower_counters();
            if (not validCounters(counters)) return #err(#corrupt_state);
            let ?nextFollowerRevision =
                incrementNat64(counters.follower_revision) else {
                return #err(#revision_overflow);
            };
            let nextCounters : Types.FollowerCounters = {
                follower_revision = nextFollowerRevision;
                max_registration_sequence =
                    counters.max_registration_sequence;
            };
            let followerMutation : ?Types.FollowerMutation = switch (
                currentFollower
            ) {
                case null null;
                case (?row) {
                    if (not followerNeedsClosure) {
                        null;
                    } else {
                        let ?nextStorageRevision =
                            incrementNat64(row.storage_revision) else {
                            return #err(#revision_overflow);
                        };
                        let nextHeadAndState = switch (row.state) {
                            case (#active(active)) {
                                let ?nextHeadRevision =
                                    incrementNat64(row.head_revision) else {
                                    return #err(#revision_overflow);
                                };
                                (
                                    nextHeadRevision,
                                    #inactive({
                                        last_subscription_id =
                                            active.subscription_id;
                                    }),
                                );
                            };
                            case (#inactive(inactive)) {
                                (row.head_revision, #inactive(inactive));
                            };
                        };
                        ?{
                            node;
                            expected_storage_revision =
                                ?row.storage_revision;
                            expected_counters = counters;
                            next_row = {
                                row with
                                head_revision = nextHeadAndState.0;
                                storage_revision = nextStorageRevision;
                                state = nextHeadAndState.1;
                                delivery_pause = null;
                                outstanding_delivery_charges = 0;
                            };
                            next_counters = nextCounters;
                            new_follower_summary = null;
                        };
                    };
                };
            };
            let followingMutation : ?Types.FollowingMutation = switch (
                currentFollowing
            ) {
                case null null;
                case (?row) {
                    if (not followingNeedsClosure) {
                        null;
                    } else {
                        let subscriptionId = switch (row.intent) {
                            case (#on(on)) on.subscription_id;
                            case (#off(off)) off.last_subscription_id;
                        };
                        let ?nextStorageRevision =
                            incrementNat64(row.storage_revision) else {
                            return #err(#revision_overflow);
                        };
                        ?{
                            node;
                            expected_storage_revision =
                                ?row.storage_revision;
                            next_row = {
                                row with
                                intent_generation =
                                    row.intent_generation + 1;
                                storage_revision =
                                    nextStorageRevision;
                                intent = #off({
                                    last_subscription_id =
                                        subscriptionId;
                                });
                                renewal_requested = false;
                                locally_verified_delivery_count = 0;
                                updated_at_ns = if (
                                    nowNs > row.updated_at_ns
                                ) nowNs else row.updated_at_ns;
                            };
                        };
                    };
                };
            };
            let mutation : Types.BlockMutation = {
                node;
                expected_storage_revision = switch (currentBlock) {
                    case null null;
                    case (?row) ?row.storage_revision;
                };
                expected_counters = counters;
                next_row = switch (currentBlock) {
                    case null ?{
                        node;
                        storage_revision = 1;
                        blocked_at_ns = nowNs;
                    };
                    case (?row) ?row;
                };
                next_counters = nextCounters;
                follower_mutation = followerMutation;
                following_mutation = followingMutation;
            };
            if (not state.commit_block(mutation)) {
                return #err(#state_conflict);
            };
            #changed;
        };

        public func unblock(node : Principal) : Types.BlockResult {
            if (not validRemote(node)) return #err(#invalid_request);
            if (Principal.equal(node, selfNode)) return #err(#self_call);
            if (state.block_count() > MAX_BLOCKS) return #err(#corrupt_state);
            let ?current = state.block(node) else return #unchanged;
            if (
                not validBlockRow(current) or
                not Principal.equal(current.node, node)
            ) return #err(#corrupt_state);
            let counters = state.follower_counters();
            if (not validCounters(counters)) return #err(#corrupt_state);
            let ?nextFollowerRevision =
                incrementNat64(counters.follower_revision) else {
                return #err(#revision_overflow);
            };
            if (not state.commit_block({
                node;
                expected_storage_revision = ?current.storage_revision;
                expected_counters = counters;
                next_row = null;
                next_counters = {
                    follower_revision = nextFollowerRevision;
                    max_registration_sequence =
                        counters.max_registration_sequence;
                };
                follower_mutation = null;
                following_mutation = null;
            })) return #err(#state_conflict);
            #changed;
        };

        public func clearFollowerPause(
            node : Principal,
        ) : Types.FollowerPauseResult {
            let ?current = state.follower(node) else return #err(#not_found);
            if (
                not validFollowerRow(current) or
                not Principal.equal(current.node, node)
            ) return #err(#corrupt_state);
            switch (current.state) {
                case (#inactive(_)) return #err(#inactive);
                case (#active(_)) {};
            };
            if (current.delivery_pause == null) return #unchanged(current);
            let counters = state.follower_counters();
            if (
                not validCounters(counters) or
                not rowsWithinCounters(state.followers(), counters)
            ) return #err(#corrupt_state);
            let ?nextStorageRevision = incrementNat64(current.storage_revision)
                else return #err(#revision_overflow);
            let ?nextFollowerRevision =
                incrementNat64(counters.follower_revision) else {
                return #err(#revision_overflow);
            };
            let next : Types.FollowerRow = {
                current with
                storage_revision = nextStorageRevision;
                delivery_pause = null;
            };
            if (not state.commit_follower({
                node;
                expected_storage_revision = ?current.storage_revision;
                expected_counters = counters;
                next_row = next;
                next_counters = {
                    follower_revision = nextFollowerRevision;
                    max_registration_sequence =
                        counters.max_registration_sequence;
                };
                new_follower_summary = null;
            })) return #err(#state_conflict);
            #changed(next);
        };

        public func followerEligibility(
            row : Types.FollowerRow,
            nowNs : Nat64,
        ) : Types.Eligibility {
            eligibility(row, nowNs, state.block(row.node) != null);
        };

        public func fanoutSnapshot(
            nowNs : Nat64,
        ) : Types.FanoutSnapshotResult {
            if (state.block_count() > MAX_BLOCKS) {
                return #err(#corrupt_state);
            };
            let rows = state.followers();
            switch (followerCounts(rows, nowNs)) {
                case (#err) return #err(#corrupt_state);
                case (#ok(_)) {};
            };
            let counters = state.follower_counters();
            if (
                not validCounters(counters) or
                not rowsWithinCounters(rows, counters)
            ) return #err(#corrupt_state);
            #ok({
                follower_revision = counters.follower_revision;
                cutoff_registration_sequence =
                    counters.max_registration_sequence;
                finalized_at_ns = nowNs;
            });
        };

        public func planFanoutBatch(
            snapshot : Types.FanoutSnapshot,
            afterSequence : ?Nat64,
            nowNs : Nat64,
        ) : Types.FanoutResult {
            if (
                snapshot.finalized_at_ns > nowNs or
                (switch (afterSequence) {
                    case (?value) value > snapshot.cutoff_registration_sequence;
                    case null false;
                })
            ) return #err(#invalid_cursor);
            if (state.block_count() > MAX_BLOCKS) return #err(#corrupt_state);
            let counters = state.follower_counters();
            if (
                not validCounters(counters) or
                snapshot.cutoff_registration_sequence >
                counters.max_registration_sequence
            ) return #err(#corrupt_state);

            let ?rows = state.followers_by_registration(
                afterSequence,
                OrderedFollowerPlanner.MAX_PAGE,
            ) else {
                return #err(#corrupt_state);
            };
            if (rows.size() > OrderedFollowerPlanner.MAX_PAGE) {
                return #err(#corrupt_state);
            };
            let entries =
                List.empty<OrderedFollowerPlanner.Entry>();
            var evaluated = 0;
            for (row in rows.vals()) {
                if (
                    not validFollowerRow(row) or
                    row.registration_sequence >
                    counters.max_registration_sequence
                ) return #err(#corrupt_state);
                let target : ?Types.FanoutTarget =
                    if (
                        row.registration_sequence <=
                            snapshot.cutoff_registration_sequence and
                        evaluated < FANOUT_BATCH_LIMIT
                    ) {
                        evaluated += 1;
                        let rowEligibility = eligibility(
                            row,
                            nowNs,
                            state.block(row.node) != null,
                        );
                        if (rowEligibility.eligible) {
                            let active = switch (row.state) {
                                case (#active(value)) value;
                                case (#inactive(_)) {
                                    return #err(#corrupt_state);
                                };
                            };
                            ?{
                                node = row.node;
                                subscription_id = active.subscription_id;
                                registration_sequence =
                                    row.registration_sequence;
                                follower_storage_revision =
                                    row.storage_revision;
                            };
                        } else {
                            null;
                        };
                    } else {
                        null;
                    };
                List.add(entries, {
                    registration_sequence =
                        row.registration_sequence;
                    target;
                });
            };
            OrderedFollowerPlanner.plan(
                snapshot,
                afterSequence,
                List.toArray(entries),
            );
        };

        public func getSendQuote(
            request : Types.SendQuoteRequest,
            nowNs : Nat64,
        ) : Types.SendQuoteResult {
            let sendKind = switch (request.send_kind) {
                case null return #err(#unsupported);
                case (?value) value;
            };
            let objectBytes = Nat32.toNat(request.estimated_object_bytes);
            if (
                objectBytes == 0 or
                objectBytes > objectBound(sendKind) or
                not validNoticeTarget(sendKind, request.notice_target)
            ) return #err(#invalid_request);
            if (state.block_count() > MAX_BLOCKS) {
                return #err(#corrupt_state);
            };

            let counters = state.follower_counters();
            if (not validCounters(counters)) {
                return #err(#corrupt_state);
            };
            let physicalActiveCount = state.active_follower_count();
            if (physicalActiveCount > MAX_ACTIVE_FOLLOWERS) {
                return #err(#corrupt_state);
            };
            let ?rows = state.followers_by_registration(
                null,
                SEND_QUOTE_SCAN_LIMIT,
            ) else {
                return #err(#corrupt_state);
            };
            if (rows.size() > SEND_QUOTE_SCAN_LIMIT) {
                return #err(#corrupt_state);
            };
            let observedEligible = List.empty<Principal>();
            var observedPhysicalActive = 0;
            var observedRegistered = 0;
            var observedEligibleCount = 0;
            var previousSequence : ?Nat64 = null;
            for (row in rows.vals()) {
                if (
                    not validFollowerRow(row) or
                    row.registration_sequence >
                        counters.max_registration_sequence
                ) return #err(#corrupt_state);
                switch (previousSequence) {
                    case (?value) {
                        if (row.registration_sequence <= value) {
                            return #err(#corrupt_state);
                        };
                    };
                    case null {};
                };
                previousSequence := ?row.registration_sequence;
                switch (row.state) {
                    case (#active(_)) observedPhysicalActive += 1;
                    case (#inactive(_)) {};
                };
                let status = eligibility(
                    row,
                    nowNs,
                    state.block(row.node) != null,
                );
                if (status.registered) {
                    observedRegistered += 1;
                    if (status.eligible) {
                        observedEligibleCount += 1;
                        List.add(observedEligible, row.node);
                    };
                };
            };
            if (observedPhysicalActive > physicalActiveCount) {
                return #err(#corrupt_state);
            };
            // The public V1 quote has no saturation bit. Treat every active
            // row outside the bounded page as registered and eligible so the
            // funding estimate cannot underquote. The observed preview stays
            // deterministic but is intentionally only a bounded sample.
            let unseenPhysicalActive =
                physicalActiveCount - observedPhysicalActive;
            let registered =
                observedRegistered + unseenPhysicalActive;
            let eligibleCount =
                observedEligibleCount + unseenPhysicalActive;
            let sortedEligible = Array.sort<Principal>(
                List.toArray(observedEligible),
                Principal.compare,
            );
            let eligiblePreview = Array.tabulate<Principal>(
                Nat.min(
                    sortedEligible.size(),
                    Bounds.MAX_SEND_QUOTE_RECIPIENT_PREVIEW,
                ),
                func(index) { sortedEligible[index] },
            );
            let noticeCount : Nat = if (hasRemoteNotice(
                sendKind,
                request.notice_target,
                selfNode,
            )) 1 else 0;
            let estimateInput : Types.CostEstimateInput = {
                send_kind = sendKind;
                estimated_object_bytes = request.estimated_object_bytes;
                delivery_count = Nat32.fromNat(eligibleCount);
                notice_count = Nat32.fromNat(noticeCount);
            };
            let ?callAndByte = estimator.call_and_byte_cycles(estimateInput) else {
                return #err(#estimate_unavailable);
            };
            let ?localPublication =
                estimator.local_publication_cycles(estimateInput) else {
                return #err(#estimate_unavailable);
            };
            let receiverFloor =
                eligibleCount * DELIVERY_REQUIRED_CYCLES;
            let noticeFloor = noticeCount * NOTICE_REQUIRED_CYCLES;
            #ok({
                follower_revision = counters.follower_revision;
                registered_follower_count = Nat32.fromNat(registered);
                eligible_delivery_count = Nat32.fromNat(eligibleCount);
                ineligible_follower_count =
                    Nat32.fromNat(registered - eligibleCount);
                eligible_recipient_preview = eligiblePreview;
                receiver_floor_cycles = receiverFloor;
                author_notice_floor_cycles = noticeFloor;
                estimated_call_and_byte_cycles = callAndByte;
                estimated_local_publication_cycles = localPublication;
                estimated_total_cycles =
                    receiverFloor + noticeFloor + callAndByte +
                    localPublication;
            });
        };

        public func prepareCreditDebit(
            follower : Principal,
            subscriptionId : Blob,
            nowNs : Nat64,
        ) : Types.CreditDebitResult {
            if (not validRemote(follower) or not validId(subscriptionId)) {
                return #err(#invalid_request);
            };
            let ?current = state.follower(follower) else return #err(#not_found);
            if (
                not validFollowerRow(current) or
                not Principal.equal(current.node, follower)
            ) return #err(#corrupt_state);
            if (state.block_count() > MAX_BLOCKS) return #err(#corrupt_state);
            let active = switch (current.state) {
                case (#active(value)) value;
                case (#inactive(_)) return #err(#ineligible);
            };
            if (
                not Blob.equal(active.subscription_id, subscriptionId) or
                active.lease_expires_ns <= nowNs or
                current.delivery_pause != null or
                state.block(follower) != null
            ) return #err(#ineligible);
            let credits = Nat16.toNat(active.delivery_credits);
            if (credits == 0) return #err(#no_credit);
            let outstanding =
                Nat16.toNat(current.outstanding_delivery_charges);
            if (
                outstanding >= MAX_DELIVERY_CREDITS or
                credits + outstanding > MAX_DELIVERY_CREDITS
            ) return #err(#corrupt_state);

            let counters = state.follower_counters();
            if (
                not validCounters(counters) or
                current.registration_sequence >
                counters.max_registration_sequence
            ) return #err(#corrupt_state);
            let ?nextStorageRevision = incrementNat64(current.storage_revision) else {
                return #err(#revision_overflow);
            };
            let ?nextFollowerRevision =
                incrementNat64(counters.follower_revision) else {
                return #err(#revision_overflow);
            };
            let afterCredits = credits - 1;
            let nextRow : Types.FollowerRow = {
                current with
                storage_revision = nextStorageRevision;
                state = #active({
                    active with
                    delivery_credits = Nat16.fromNat(afterCredits);
                });
                outstanding_delivery_charges =
                    Nat16.fromNat(outstanding + 1);
            };
            #ok({
                mutation = {
                    node = follower;
                    expected_storage_revision = ?current.storage_revision;
                    expected_counters = counters;
                    next_row = nextRow;
                    next_counters = {
                        follower_revision = nextFollowerRevision;
                        max_registration_sequence =
                            counters.max_registration_sequence;
                    };
                    new_follower_summary = null;
                };
                charge = {
                    follower;
                    subscription_id = subscriptionId;
                };
                renewal_requested =
                    afterCredits <= RENEWAL_REQUEST_THRESHOLD;
            });
        };

        public func prepareCreditFinish(
            request : Types.CreditFinishRequest,
        ) : Types.CreditFinishResult {
            if (
                not validRemote(request.charge.follower) or
                not validId(request.charge.subscription_id)
            ) return #err(#invalid_request);
            let ?current = state.follower(request.charge.follower) else {
                return #ok({ mutation = null });
            };
            if (
                not validFollowerRow(current) or
                not Principal.equal(
                    current.node,
                    request.charge.follower,
                )
            ) return #err(#corrupt_state);
            let active = switch (current.state) {
                case (#inactive(_)) return #ok({ mutation = null });
                case (#active(value)) value;
            };
            if (not Blob.equal(
                active.subscription_id,
                request.charge.subscription_id,
            )) return #ok({ mutation = null });

            let outstanding =
                Nat16.toNat(current.outstanding_delivery_charges);
            if (outstanding == 0) return #err(#corrupt_state);
            let credits = Nat16.toNat(active.delivery_credits);
            let nextCredits = switch (request.disposition) {
                case (#consume) credits;
                case (#restore) {
                    if (credits >= MAX_DELIVERY_CREDITS) {
                        return #err(#corrupt_state);
                    };
                    credits + 1;
                };
            };
            if (
                nextCredits + (outstanding - 1) >
                MAX_DELIVERY_CREDITS
            ) return #err(#corrupt_state);

            let counters = state.follower_counters();
            if (
                not validCounters(counters) or
                current.registration_sequence >
                counters.max_registration_sequence
            ) return #err(#corrupt_state);
            let pauseChanged = switch (request.pause) {
                case (?value) ?value != current.delivery_pause;
                case null false;
            };
            let eligibilityChanged =
                request.disposition == #restore or pauseChanged;
            let nextFollowerRevision = if (eligibilityChanged) {
                let ?next = incrementNat64(counters.follower_revision) else {
                    return #err(#revision_overflow);
                };
                next;
            } else counters.follower_revision;
            let ?nextStorageRevision = incrementNat64(current.storage_revision) else {
                return #err(#revision_overflow);
            };
            let nextRow : Types.FollowerRow = {
                current with
                storage_revision = nextStorageRevision;
                state = #active({
                    active with
                    delivery_credits = Nat16.fromNat(nextCredits);
                });
                delivery_pause = switch (request.pause) {
                    case (?value) ?value;
                    case null current.delivery_pause;
                };
                outstanding_delivery_charges =
                    Nat16.fromNat(outstanding - 1);
            };
            #ok({
                mutation = ?{
                    node = current.node;
                    expected_storage_revision = ?current.storage_revision;
                    expected_counters = counters;
                    next_row = nextRow;
                    next_counters = {
                        follower_revision = nextFollowerRevision;
                        max_registration_sequence =
                            counters.max_registration_sequence;
                    };
                    new_follower_summary = null;
                };
            });
        };

        public func creditPlanner() : Types.CreditPlanner {
            {
                prepare_debit = func(
                    follower : Principal,
                    subscriptionId : Blob,
                    nowNs : Nat64,
                ) : Types.CreditDebitResult {
                    prepareCreditDebit(follower, subscriptionId, nowNs);
                };
                prepare_finish = func(
                    request : Types.CreditFinishRequest,
                ) : Types.CreditFinishResult {
                    prepareCreditFinish(request);
                };
            };
        };
    };

    public func head(row : Types.FollowerRow) : Types.FollowerHead {
        {
            revision = row.head_revision;
            state = row.state;
        };
    };

    public func eligibility(
        row : Types.FollowerRow,
        nowNs : Nat64,
        blocked : Bool,
    ) : Types.Eligibility {
        switch (row.state) {
            case (#inactive(_)) {
                {
                    registered = false;
                    eligible = false;
                    reason = null;
                };
            };
            case (#active(active)) {
                if (active.lease_expires_ns <= nowNs) {
                    return {
                        registered = false;
                        eligible = false;
                        reason = ?#expired;
                    };
                };
                if (blocked) {
                    return {
                        registered = true;
                        eligible = false;
                        reason = ?#blocked;
                    };
                };
                if (row.delivery_pause != null) {
                    return {
                        registered = true;
                        eligible = false;
                        reason = ?#paused;
                    };
                };
                if (active.delivery_credits == 0) {
                    return {
                        registered = true;
                        eligible = false;
                        reason = ?#no_credit;
                    };
                };
                {
                    registered = true;
                    eligible = true;
                    reason = null;
                };
            };
        };
    };

    public func followingAutoRenewDue(
        row : Types.FollowingRow,
        nowNs : Nat64,
    ) : Bool {
        switch (row.intent) {
            case (#off(_)) false;
            case (#on(on)) {
                if (on.status != #active) return false;
                if (
                    Nat16.toNat(
                        row.locally_verified_delivery_count
                    ) >= EARLY_RENEW_VERIFIED_DELIVERY_THRESHOLD
                ) return true;
                let ?renewAt = addNat64(
                    row.updated_at_ns,
                    AUTO_RENEW_AFTER_NS,
                ) else return true;
                renewAt <= nowNs;
            };
        };
    };

    public func followingIntentOccupiesCapacity(
        intent : Types.FollowingIntent
    ) : Bool {
        switch (intent) {
            case (#on(_)) true;
            case (#off(_)) false;
        };
    };

    // Computes the exact stored occupancy after one Following mutation.
    // Null is a detectable counter invariant violation: either an occupied
    // row cannot be removed from a zero count, or a new occupied row would
    // exceed the configured installation capacity.
    public func followingCountAfterMutation(
        currentCount : Nat,
        currentOccupied : Bool,
        nextOccupied : Bool,
        capacity : Nat,
    ) : ?Nat {
        if (currentCount > capacity) return null;
        if (currentOccupied) {
            if (currentCount == 0) return null;
            if (nextOccupied) ?currentCount else ?(currentCount - 1);
        } else if (nextOccupied) {
            if (currentCount >= capacity) return null;
            ?(currentCount + 1);
        } else {
            ?currentCount;
        };
    };

    public func exactBlockStatuses(
        nodes : [Principal],
        isBlocked : Principal -> Bool,
    ) : [Types.BlockStatus] {
        Array.map<Principal, Types.BlockStatus>(
            nodes,
            func(node) {
                {
                    node;
                    blocked = isBlocked(node);
                };
            },
        );
    };

    public func followingAutoRenewActionable(
        row : Types.FollowingRow,
        nowNs : Nat64,
        blocked : Bool,
        compatible : Bool,
    ) : Bool {
        not blocked and
        compatible and
        followingAutoRenewDue(row, nowNs);
    };

    public func followDispatchAuthorized(
        row : Types.FollowingRow,
        expectedIntentGeneration : Nat,
        expectedSubscriptionId : Blob,
        pendingOutboxMatches : Bool,
        pendingOutboxDetached : Bool,
        allowDetachedUncertain : Bool,
        blocked : Bool,
    ) : Bool {
        if (
            blocked or
            row.intent_generation != expectedIntentGeneration
        ) return false;
        switch (row.intent) {
            case (#off(_)) false;
            case (#on(on)) {
                if (not Blob.equal(
                    on.subscription_id,
                    expectedSubscriptionId,
                )) return false;
                switch (on.status) {
                    case (#registering) pendingOutboxMatches;
                    case (#uncertain) {
                        allowDetachedUncertain and
                        pendingOutboxDetached;
                    };
                    case (#active or #conflicted or #incompatible) false;
                };
            };
        };
    };

    public func validFollowerRow(row : Types.FollowerRow) : Bool {
        if (
            not Principal.isCanister(row.node) or
            row.head_revision == 0 or
            row.storage_revision == 0 or
            row.storage_revision < row.head_revision or
            row.registration_sequence == 0
        ) return false;
        let outstanding = Nat16.toNat(row.outstanding_delivery_charges);
        switch (row.state) {
            case (#inactive(inactive)) {
                validId(inactive.last_subscription_id) and
                row.funded_at_ns != 0 and
                outstanding == 0 and
                row.delivery_pause == null;
            };
            case (#active(active)) {
                let credits = Nat16.toNat(active.delivery_credits);
                validId(active.subscription_id) and
                row.funded_at_ns <= active.lease_expires_ns and
                active.lease_expires_ns - row.funded_at_ns == LEASE_NS and
                credits <= MAX_DELIVERY_CREDITS and
                outstanding <= MAX_DELIVERY_CREDITS and
                credits + outstanding <= MAX_DELIVERY_CREDITS;
            };
        };
    };

    public func validFollowingRow(row : Types.FollowingRow) : Bool {
        if (
            not Principal.isCanister(row.node) or
            row.intent_generation == 0 or
            row.storage_revision == 0 or
            Nat16.toNat(row.locally_verified_delivery_count) >
                EARLY_RENEW_VERIFIED_DELIVERY_THRESHOLD
        ) return false;
        switch (row.intent) {
            case (#on(on)) validId(on.subscription_id);
            case (#off(off)) {
                validId(off.last_subscription_id) and
                row.locally_verified_delivery_count == 0;
            };
        };
    };

    func validFollowerRows(rows : [Types.FollowerRow], nowNs : Nat64) : Bool {
        let bySequence = Array.sort<Types.FollowerRow>(
            rows,
            func(left, right) {
                Nat64.compare(
                    left.registration_sequence,
                    right.registration_sequence,
                );
            },
        );
        var previousSequence : ?Nat64 = null;
        var registered = 0;
        for (row in bySequence.vals()) {
            if (not validFollowerRow(row)) return false;
            switch (previousSequence) {
                case (?value) {
                    if (value == row.registration_sequence) return false;
                };
                case null {};
            };
            previousSequence := ?row.registration_sequence;
            if (eligibility(row, nowNs, false).registered) registered += 1;
        };
        if (registered > MAX_ACTIVE_FOLLOWERS) return false;

        let byNode = Array.sort<Types.FollowerRow>(
            rows,
            func(left, right) {
                Principal.compare(left.node, right.node);
            },
        );
        var previousNode : ?Principal = null;
        for (row in byNode.vals()) {
            switch (previousNode) {
                case (?value) {
                    if (Principal.equal(value, row.node)) return false;
                };
                case null {};
            };
            previousNode := ?row.node;
        };
        true;
    };

    func followerCounts(
        rows : [Types.FollowerRow],
        nowNs : Nat64,
    ) : { #ok : Nat; #err } {
        if (not validFollowerRows(rows, nowNs)) return #err;
        var count = 0;
        for (row in rows.vals()) {
            if (eligibility(row, nowNs, false).registered) count += 1;
        };
        #ok(count);
    };

    func validCounters(counters : Types.FollowerCounters) : Bool {
        counters.max_registration_sequence <= counters.follower_revision;
    };

    func rowsWithinCounters(
        rows : [Types.FollowerRow],
        counters : Types.FollowerCounters,
    ) : Bool {
        for (row in rows.vals()) {
            if (
                row.registration_sequence >
                counters.max_registration_sequence
            ) return false;
        };
        true;
    };

    func validBlockRow(row : Types.BlockRow) : Bool {
        Principal.isCanister(row.node) and row.storage_revision > 0;
    };

    func validRemote(node : Principal) : Bool {
        Principal.isCanister(node);
    };

    func validId(value : Blob) : Bool {
        if (value.size() != SUBSCRIPTION_ID_BYTES) return false;
        for (byte in value.values()) {
            if (byte != 0) return true;
        };
        false;
    };

    func incrementNat64(value : Nat64) : ?Nat64 {
        if (value == MAX_NAT64) null else ?(value + 1);
    };

    func addNat64(left : Nat64, right : Nat64) : ?Nat64 {
        if (left > MAX_NAT64 - right) null else ?(left + right);
    };

    func objectBound(kind : Types.SendKind) : Nat {
        switch (kind) {
            case (#post) MAX_POST_OBJECT_BYTES;
            case (#reply) MAX_POST_OBJECT_BYTES;
            // V1 does not freeze a narrower standalone encoded-object ceiling
            // for these small actions, so the certified-object ceiling is the
            // fail-closed bound.
            case (#share) MAX_CERTIFIED_OBJECT_BYTES;
            case (#tombstone) MAX_CERTIFIED_OBJECT_BYTES;
        };
    };

    func validNoticeTarget(
        kind : Types.SendKind,
        target : ?Principal,
    ) : Bool {
        switch (kind, target) {
            case (#post, null) true;
            case (#tombstone, null) true;
            case (#post, ?_) false;
            case (#tombstone, ?_) false;
            case (#reply, null) true;
            case (#share, null) true;
            case (#reply, ?node) Principal.isCanister(node);
            case (#share, ?node) Principal.isCanister(node);
        };
    };

    func hasRemoteNotice(
        kind : Types.SendKind,
        target : ?Principal,
        selfNode : Principal,
    ) : Bool {
        switch (kind, target) {
            case (#reply, ?node) not Principal.equal(node, selfNode);
            case (#share, ?node) not Principal.equal(node, selfNode);
            case (_) false;
        };
    };

    func remoteResultRevision(
        result : Types.RemoteFollowResult,
    ) : ?Nat64 {
        switch (result) {
            case (#accepted(value)) ?value.revision;
            case (#duplicate(value)) ?value.revision;
            case (#revision_conflict(value)) ?value;
            case (#incompatible(value)) value;
            case (#uncertain(value)) value;
        };
    };

    func maxOptionalNat64(left : ?Nat64, right : ?Nat64) : ?Nat64 {
        switch (left, right) {
            case (null, null) null;
            case (?value, null) ?value;
            case (null, ?value) ?value;
            case (?leftValue, ?rightValue) {
                if (leftValue >= rightValue) ?leftValue else ?rightValue;
            };
        };
    };
};
