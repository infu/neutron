import Blob "mo:core/Blob";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";

import FeedService "../feed/Service";
import FeedTypes "../feed/Types";
import Likes "../likes/Admission";
import NotificationService "../notifications/Service";
import NotificationTypes "../notifications/Types";
import Bounds "../protocol/Bounds";
import Hash "../protocol/Hash";
import Protocol "../protocol/Types";
import Validation "../protocol/Validation";
import Wire "../protocol/Wire";
import RelationshipService "../relationships/Service";
import RelationshipTypes "../relationships/Types";
import Types "Types";

// Synchronous paid-ingress orchestration.
//
// Existing domain services are invoked through capture-only commit adapters.
// Consequently plan() never mutates business state. execute() preflights the
// bounded receipt+rate fallback lanes and the complete domain allocation,
// then atomically commits exactly one explicit plan without awaiting.
module {
    public let HOUR_NS : Nat64 = 3_600_000_000_000;
    public let PEER_RETENTION_NS : Nat64 = 34_560_000_000_000_000;
    public let LIKE_RETENTION_NS : Nat64 = 157_680_000_000_000_000;
    public let NOTICE_SEMANTIC_LIMIT_PER_HOUR : Nat32 = 60;

    let RECEIPT_ACCOUNTING_OVERHEAD : Nat = 512;
    let RATE_ACCOUNTING_BYTES : Nat = 192;
    let NOTIFICATION_ACCOUNTING_OVERHEAD : Nat = 512;
    let LIKE_ACCOUNTING_OVERHEAD : Nat = 512;

    type DeliveryClaims = {
        subscription_id : Blob;
        renewal_requested : Bool;
        following : RelationshipTypes.FollowingRow;
        event_kind : FeedTypes.FeedEventKindV1;
        claimed_author : Principal;
        claimed_post_id : Blob;
        claimed_body_hash : Blob;
        exact_event_candid : Blob;
    };

    type PreparedLike = {
        target : Types.LikeTarget;
        action : Protocol.LikeActionV1;
        receipt : Protocol.CertifiedLikeReceiptV1;
        exact_receipt_candid : Blob;
    };

    type PreparedNotice = {
        relation : Protocol.NoticeRelationV1;
        body : Protocol.NoticeBodyV1;
    };

    type ShallowDelivery = {
        body : Protocol.DeliverBodyV1;
        following : RelationshipTypes.FollowingRow;
    };

    type ShallowPreparedRoute = {
        #follow : Protocol.FollowBodyV1;
        #unfollow : Protocol.UnfollowBodyV1;
        #deliver : ShallowDelivery;
        #like : Protocol.LikeBodyV1;
        #notice : PreparedNotice;
    };

    type ShallowPreparedResult = {
        #ok : ShallowPreparedRoute;
        #rejected : Protocol.RouteRejectionReasonV1;
    };

    type PreparedRoute = {
        #follow : Protocol.FollowBodyV1;
        #unfollow : Protocol.UnfollowBodyV1;
        #deliver : DeliveryClaims;
        #like : PreparedLike;
        #notice : PreparedNotice;
    };

    type PreparedResult = {
        #ok : PreparedRoute;
        #rejected : Protocol.RouteRejectionReasonV1;
    };

    type PlannedDomain = {
        result : Protocol.WagyuRouteResultV1;
        domain : Types.DomainMutation;
        semantic_notice_increment : Bool;
    };

    type CapturedFollower = {
        result : RelationshipTypes.FollowResult;
        mutation : ?RelationshipTypes.FollowerMutation;
    };

    type CapturedUnfollow = {
        result : RelationshipTypes.UnfollowResult;
        mutation : ?RelationshipTypes.FollowerMutation;
    };

    type CapturedFeed = {
        result : FeedTypes.AdmissionOutcome;
        mutation : ?FeedTypes.AdmissionCommit;
    };

    type CapturedNotification = {
        result : NotificationTypes.AppendOutcome;
        mutation : ?NotificationTypes.AppendCommit;
    };

    public func plan(
        state : Types.State,
        request : Types.Request,
    ) : Types.PlanOutcome {
        let spec = Bounds.routeById(toBoundsRoute(request.route));
        let ?ingress = Wire.decodeIngressForRoute(
            spec.route,
            request.exact_ingress_candid,
        ) else {
            return #immediate(response(
                request.route,
                rejected(#invalid, request.now_ns),
                false,
                false,
            ));
        };
        // This line deliberately precedes every route-body decoder below.
        // body_candid remains opaque while its protocol identity is frozen.
        let payloadDigest = Hash.payloadDigest(ingress.body_candid);
        let receiptKey : Types.ReceiptKey = {
            caller = request.caller;
            route = request.route;
            operation_id = ingress.operation_id;
        };

        switch (state.receipt(receiptKey)) {
            case (?existing) {
                if (
                    not sameReceiptKey(existing.key, receiptKey) or
                    existing.payload_digest.size() != Bounds.HASH_BYTES or
                    existing.exact_result_candid.size() == 0 or
                    existing.exact_result_candid.size() >
                        spec.max_response_bytes
                ) {
                    return #immediate(response(
                        request.route,
                        rejected(#invalid, request.now_ns),
                        false,
                        false,
                    ));
                };
                if (Blob.equal(existing.payload_digest, payloadDigest)) {
                    return #replay(existing);
                };
                return #immediate(response(
                    request.route,
                    rejected(#conflict, request.now_ns),
                    false,
                    false,
                ));
            };
            case null {};
        };

        let stableReceiptKey = state.receipt_stable_key(receiptKey);
        if (stableReceiptKey.size() == 0) {
            return #immediate(response(
                request.route,
                rejected(#invalid, request.now_ns),
                false,
                false,
            ));
        };

        switch (prepareCallerPolicy(state, request)) {
            case (?reason) {
                return ready(
                    request,
                    ingress,
                    payloadDigest,
                    stableReceiptKey,
                    rejected(reason, request.now_ns),
                    null,
                    emptyDomain(),
                );
            };
            case null {};
        };

        let shallow = switch (
            prepareShallowRoute(
                state,
                request,
                ingress.body_candid,
            )
        ) {
            case (#rejected(reason)) {
                return ready(
                    request,
                    ingress,
                    payloadDigest,
                    stableReceiptKey,
                    rejected(reason, request.now_ns),
                    null,
                    emptyDomain(),
                );
            };
            case (#ok(value)) value;
        };

        // Fixed route-body shapes and cheap caller/route policy were checked
        // above. The route window is now planned before nested Deliver/Like
        // objects are decoded or semantically interpreted, so malformed deep
        // Candid cannot evade app rate pressure.
        let rate = switch (prepareRate(state, request)) {
            case (#invalid) {
                return ready(
                    request,
                    ingress,
                    payloadDigest,
                    stableReceiptKey,
                    rejected(#invalid, request.now_ns),
                    null,
                    emptyDomain(),
                );
            };
            case (#limited) {
                // The route result has no rate-limited semantic tag. The
                // kernel owns the outer #rate_limited error; this defensive
                // app-local lane therefore fails closed as retained capacity.
                return ready(
                    request,
                    ingress,
                    payloadDigest,
                    stableReceiptKey,
                    rejected(#full, request.now_ns),
                    null,
                    emptyDomain(),
                );
            };
            case (#ok(value)) value;
        };

        let prepared = prepareRoute(
            state,
            request,
            shallow,
        );
        let routePrepared = switch (prepared) {
            case (#rejected(reason)) {
                return ready(
                    request,
                    ingress,
                    payloadDigest,
                    stableReceiptKey,
                    rejected(reason, request.now_ns),
                    ?rate,
                    emptyDomain(),
                );
            };
            case (#ok(value)) value;
        };

        // A Like quarantine slot can become available after browser
        // verification, invalid-evidence deletion, or batch sealing. Do not
        // persist a terminal operation receipt for that temporary pressure:
        // the sender must be able to retry the exact prepared operation.
        switch (routePrepared) {
            case (#like(value)) {
                let semantic = state.notifications.find_semantic(#like({
                    acting_node = request.caller;
                    target_post_id = value.target.post_id;
                }));
                if (
                    value.target.existing_receipt_digest == null and
                    semantic == null and
                    value.target.unsealed_receipt_count >=
                        value.target.unsealed_receipt_limit
                ) {
                    return #immediate(response(
                        request.route,
                        transientFull(),
                        false,
                        false,
                    ));
                };
            };
            case (_) {};
        };

        var planned = planDomain(
            state,
            request,
            ingress,
            payloadDigest,
            stableReceiptKey,
            routePrepared,
        );
        var finalRate = rate;
        if (planned.semantic_notice_increment) {
            if (
                rate.replacement.semantic_notice_count >=
                    NOTICE_SEMANTIC_LIMIT_PER_HOUR
            ) {
                planned := {
                    result = rejected(#full, request.now_ns);
                    domain = emptyDomain();
                    semantic_notice_increment = false;
                };
            } else {
                finalRate := {
                    rate with
                    replacement = {
                        rate.replacement with
                        semantic_notice_count =
                            rate.replacement.semantic_notice_count + 1;
                    };
                };
            };
        };

        ready(
            request,
            ingress,
            payloadDigest,
            stableReceiptKey,
            planned.result,
            ?finalRate,
            planned.domain,
        );
    };

    public func execute(
        state : Types.State,
        request : Types.Request,
    ) : Types.Response {
        switch (plan(state, request)) {
            case (#replay(receipt)) {
                {
                    result = receipt.result;
                    exact_result_candid = receipt.exact_result_candid;
                    replayed = true;
                    committed = false;
                };
            };
            case (#immediate(value)) value;
            case (#ready(commitPlan)) {
                // Establish both durable receipt-only escape lanes before
                // asking whether the domain allocation fits. All callbacks
                // are synchronous and read-only/atomic, so a successful
                // fallback preflight remains valid until one plan commits.
                let fullFallback = rejectionCommitPlan(
                    commitPlan,
                    #full,
                );
                let conflictFallback = rejectionCommitPlan(
                    commitPlan,
                    #conflict,
                );
                if (
                    not state.preflight(fullFallback) or
                    not state.preflight(conflictFallback)
                ) {
                    Runtime.trap(
                        "Wagyu ingress receipt/rate admission unavailable"
                    );
                };
                if (not state.preflight(commitPlan)) {
                    return commitFallbackOrTrap(
                        state,
                        fullFallback,
                    );
                };
                if (not state.commit_atomic(commitPlan)) {
                    return commitFallbackOrTrap(
                        state,
                        conflictFallback,
                    );
                };
                {
                    result = commitPlan.receipt.result;
                    exact_result_candid =
                        commitPlan.receipt.exact_result_candid;
                    replayed = false;
                    committed = true;
                };
            };
        };
    };

    func commitFallbackOrTrap(
        state : Types.State,
        fallback : Types.CommitPlan,
    ) : Types.Response {
        if (not state.commit_atomic(fallback)) {
            Runtime.trap(
                "Wagyu ingress fallback violated atomic preflight"
            );
        };
        {
            result = fallback.receipt.result;
            exact_result_candid =
                fallback.receipt.exact_result_candid;
            replayed = false;
            committed = true;
        };
    };

    func rejectionCommitPlan(
        primary : Types.CommitPlan,
        reason : Protocol.RouteRejectionReasonV1,
    ) : Types.CommitPlan {
        let route = primary.receipt.key.route;
        let result = normalizeRouteResult(
            route,
            rejected(reason, primary.receipt.received_at_ns),
        );
        let exactResult = encodeRouteResult(route, result);
        {
            receipt = {
                primary.receipt with
                result;
                exact_result_candid = exactResult;
                retained_bytes =
                    primary.receipt.key.operation_id.size() +
                    primary.receipt.payload_digest.size() +
                    exactResult.size() +
                    RECEIPT_ACCOUNTING_OVERHEAD;
            };
            rate = fallbackRate(primary);
            domain = emptyDomain();
        };
    };

    // A newly retained Notice alone consumes the semantic sub-window. If its
    // domain allocation or CAS fails, the route attempt still consumes the
    // ordinary call window but not the new-semantic counter.
    func fallbackRate(
        primary : Types.CommitPlan
    ) : ?Types.RateMutation {
        let ?rate = primary.rate else return null;
        if (
            primary.receipt.key.route != #notice or
            primary.domain.notification == null
        ) return ?rate;
        if (rate.replacement.semantic_notice_count == 0) {
            Runtime.trap(
                "Wagyu ingress Notice fallback underflow"
            );
        };
        ?{
            rate with
            replacement = {
                rate.replacement with
                semantic_notice_count =
                    rate.replacement.semantic_notice_count - 1;
            };
        };
    };

    public func encodeRouteResult(
        route : Types.Route,
        result : Protocol.WagyuRouteResultV1,
    ) : Blob {
        let normalized = normalizeRouteResult(route, result);
        switch (route) {
            case (#unfollow) {
                to_candid (toUnfollowRouteResult(normalized));
            };
            case (_) Wire.encodeRouteResult(normalized);
        };
    };

    public func toUnfollowRouteResult(
        result : Protocol.WagyuRouteResultV1
    ) : Types.UnfollowRouteResultV1 {
        {
            outcome = result.outcome;
            revision = result.revision;
        };
    };

    public func validCommitPlanAccounting(
        plan : Types.CommitPlan
    ) : Bool {
        let receipt = plan.receipt;
        if (
            not Blob.equal(
                receipt.exact_result_candid,
                encodeRouteResult(receipt.key.route, receipt.result),
            ) or
            receipt.retained_bytes !=
                receipt.key.operation_id.size() +
                receipt.payload_digest.size() +
                receipt.exact_result_candid.size() +
                RECEIPT_ACCOUNTING_OVERHEAD
        ) return false;
        switch (plan.rate) {
            case null {};
            case (?mutation) {
                if (
                    mutation.replacement.retained_bytes !=
                        RATE_ACCOUNTING_BYTES
                ) return false;
                switch (mutation.expected) {
                    case null {};
                    case (?current) {
                        if (
                            current.retained_bytes !=
                                RATE_ACCOUNTING_BYTES
                        ) return false;
                    };
                };
            };
        };
        switch (plan.domain.feed) {
            case null {};
            case (?mutation) {
                if (
                    mutation.candidate.retained_bytes !=
                        mutation.candidate.exact_event_candid.size() +
                        FeedTypes.MAX_ACCOUNTED_OVERHEAD_BYTES
                ) return false;
            };
        };
        switch (plan.domain.notification) {
            case null {};
            case (?mutation) {
                let evidenceBytes = switch (
                    mutation.append.stored.like_evidence
                ) {
                    case null 0;
                    case (?evidence) evidence.size();
                };
                if (
                    mutation.retained_bytes !=
                        evidenceBytes +
                        NOTIFICATION_ACCOUNTING_OVERHEAD
                ) return false;
            };
        };
        switch (plan.domain.like) {
            case null {};
            case (?mutation) {
                if (
                    mutation.retained_bytes !=
                        mutation.accepted.exact_receipt_candid.size() +
                        mutation.accepted.receipt.like_action_candid.size() +
                        LIKE_ACCOUNTING_OVERHEAD
                ) return false;
            };
        };
        true;
    };

    func prepareShallowRoute(
        state : Types.State,
        request : Types.Request,
        exactBodyCandid : Blob,
    ) : ShallowPreparedResult {
        switch (request.route) {
            case (#follow) {
                let ?body = Wire.decodeFollowBody(exactBodyCandid)
                    else return #rejected(#invalid);
                if (not Validation.followBody(body)) {
                    return #rejected(#invalid);
                };
                #ok(#follow(body));
            };
            case (#unfollow) {
                let ?body = Wire.decodeUnfollowBody(exactBodyCandid)
                    else return #rejected(#invalid);
                if (not Validation.unfollowBody(body)) {
                    return #rejected(#invalid);
                };
                #ok(#unfollow(body));
            };
            case (#deliver) {
                let ?body = Wire.decodeDeliverBody(exactBodyCandid)
                    else return #rejected(#invalid);
                switch (Validation.deliverBody(body)) {
                    case (#invalid) return #rejected(#invalid);
                    case (#incompatible) return #rejected(#incompatible);
                    case (#valid) {};
                };
                switch (deliveryPolicy(state, request, body.subscription_id)) {
                    case (?reason) return #rejected(reason);
                    case null {};
                };
                let ?following = state.relationships.following(
                    request.caller
                ) else return #rejected(#not_following);
                #ok(#deliver({ body; following }));
            };
            case (#like) {
                let ?body = Wire.decodeLikeBody(exactBodyCandid)
                    else return #rejected(#invalid);
                if (not Validation.likeBody(body)) {
                    return #rejected(#invalid);
                };
                #ok(#like(body));
            };
            case (#notice) {
                let ?body = Wire.decodeNoticeBody(exactBodyCandid)
                    else return #rejected(#invalid);
                switch (Validation.noticeBody(body)) {
                    case (#invalid) return #rejected(#invalid);
                    case (#incompatible) return #rejected(#incompatible);
                    case (#valid) {};
                };
                let ?relation = body.relation else {
                    return #rejected(#incompatible);
                };
                let ?target = state.authored_post_target(
                    body.target_post_id
                ) else return #rejected(#unknown_post);
                if (
                    not target.live or
                    not Principal.equal(
                        target.post_author,
                        request.self_node,
                    ) or
                    not Blob.equal(target.post_id, body.target_post_id) or
                    not Blob.equal(
                        target.post_body_hash,
                        body.target_body_hash,
                    )
                ) return #rejected(#unknown_post);
                #ok(#notice({ relation; body }));
            };
        };
    };

    func prepareRoute(
        state : Types.State,
        request : Types.Request,
        shallow : ShallowPreparedRoute,
    ) : PreparedResult {
        switch (shallow) {
            case (#follow(body)) #ok(#follow(body));
            case (#unfollow(body)) #ok(#unfollow(body));
            case (#notice(value)) #ok(#notice(value));
            case (#deliver(value)) {
                let body = value.body;
                let ?event = body.event else {
                    return #rejected(#incompatible);
                };
                switch (
                    decodeDeliveryClaims(
                        request,
                        body.subscription_id,
                        body.renewal_requested,
                        value.following,
                        event,
                    )
                ) {
                    case (#ok(claims)) #ok(#deliver(claims));
                    case (#rejected(reason)) #rejected(reason);
                };
            };
            case (#like(body)) {
                let ?receipt = Wire.decodeCertifiedLikeReceipt(
                    body.certified_like_receipt_candid
                ) else return #rejected(#invalid);
                let ?action = Wire.decodeLikeAction(
                    receipt.like_action_candid
                ) else return #rejected(#invalid);
                switch (
                    Validation.likeAction(
                        action,
                        request.network_id,
                        request.caller,
                    )
                ) {
                    case (#incompatible) return #rejected(#incompatible);
                    case (#invalid) return #rejected(#invalid);
                    case (#valid) {};
                };
                switch (
                    Validation.certifiedLikeReceipt(
                        receipt,
                        body.certified_like_receipt_candid.size(),
                    )
                ) {
                    case (#incompatible) return #rejected(#incompatible);
                    case (#invalid) return #rejected(#invalid);
                    case (#valid) {};
                };
                let ?target = state.like_target(
                    action.post_id,
                    request.caller,
                ) else return #rejected(#unknown_post);
                if (
                    not targetShape(target, request.self_node) or
                    not Blob.equal(target.post_id, action.post_id) or
                    not Blob.equal(
                        target.post_body_hash,
                        action.post_body_hash,
                    ) or
                    not Principal.equal(
                        action.post_author,
                        request.self_node,
                    )
                ) return #rejected(#unknown_post);
                switch (Likes.validateReceipt({
                    caller = request.caller;
                    network_id = request.network_id;
                    post_author = target.post_author;
                    post_id = target.post_id;
                    post_body_hash = target.post_body_hash;
                    action;
                    receipt;
                    exact_receipt_candid =
                        body.certified_like_receipt_candid;
                })) {
                    case (#err(#blocked)) return #rejected(#blocked);
                    case (#err(#closed)) return #rejected(#expired);
                    case (#err(_)) return #rejected(#invalid);
                    case (#ok(_)) {};
                };
                #ok(#like({
                    target;
                    action;
                    receipt;
                    exact_receipt_candid =
                        body.certified_like_receipt_candid;
                }));
            };
        };
    };

    func prepareCallerPolicy(
        state : Types.State,
        request : Types.Request,
    ) : ?Protocol.RouteRejectionReasonV1 {
        // The app-local zero hash is the explicit unconfigured sentinel. No
        // new protocol action is admitted until the owner has installed a
        // root-derived network id. Stored exact receipts were checked first.
        if (not configuredNetworkId(request.network_id)) {
            return ?#incompatible;
        };
        if (
            not Principal.isCanister(request.caller) or
            not Principal.isCanister(request.self_node) or
            Principal.equal(request.caller, request.self_node)
        ) return ?#invalid;
        if (state.relationships.block(request.caller) != null) {
            return ?#blocked;
        };
        null;
    };

    func planDomain(
        state : Types.State,
        request : Types.Request,
        ingress : Protocol.WagyuIngressV1,
        payloadDigest : Blob,
        stableReceiptKey : Text,
        prepared : PreparedRoute,
    ) : PlannedDomain {
        switch (prepared) {
            case (#follow(body)) {
                planFollow(state, request, body);
            };
            case (#unfollow(body)) {
                planUnfollow(state, request, body);
            };
            case (#deliver(claims)) {
                planDelivery(
                    state,
                    request,
                    ingress,
                    payloadDigest,
                    stableReceiptKey,
                    claims,
                );
            };
            case (#like(value)) {
                planLike(state, request, value);
            };
            case (#notice(value)) {
                planNotice(state, request, value);
            };
        };
    };

    func planFollow(
        state : Types.State,
        request : Types.Request,
        body : Protocol.FollowBodyV1,
    ) : PlannedDomain {
        let captured = captureFollow(
            state.relationships,
            request.self_node,
            request.caller,
            {
                expected_revision = body.expected_revision;
                subscription_id = body.subscription_id;
            },
            request.now_ns,
        );
        switch (captured.result) {
            case (#err(#credit_cap)) {
                let head = switch (
                    state.relationships.follower(request.caller)
                ) {
                    case null null;
                    case (?row) ?RelationshipService.head(row);
                };
                {
                    result = rejectedWithHead(
                        #conflict,
                        head,
                        request.now_ns,
                    );
                    domain = emptyDomain();
                    semantic_notice_increment = false;
                };
            };
            case (#err(error)) {
                {
                    result = relationshipError(error, request.now_ns);
                    domain = emptyDomain();
                    semantic_notice_increment = false;
                };
            };
            case (#accepted(accepted)) {
                let ?followerMutation = captured.mutation else {
                    return invalidPlan(request.now_ns);
                };
                var committedFollowerMutation = followerMutation;
                var notification : ?Types.NotificationMutation = null;
                if (accepted.activation) {
                    let notificationCapture = captureNotification(
                        state.notifications,
                        {
                            acting_node = request.caller;
                            received_at_ns = request.now_ns;
                            event = #new_follower({
                                follower_revision =
                                    accepted.head.revision;
                            });
                        },
                    );
                    switch (
                        capturedNotificationMutation(
                            notificationCapture,
                            peerRetainUntil(request.now_ns),
                        )
                    ) {
                        case (#ok(value)) notification := ?value;
                        case (#duplicate) {
                            // A follower activation and its semantic summary
                            // are one transaction. A pre-existing summary here
                            // means the backing indexes are inconsistent.
                            return invalidPlan(request.now_ns);
                        };
                        case (#conflict) return invalidPlan(request.now_ns);
                        case (#unavailable) {
                            // Relationship admission must not depend on the
                            // capacity of the best-effort activity tray.
                            committedFollowerMutation := {
                                followerMutation with
                                new_follower_summary = null;
                            };
                        };
                        case (#invalid) {
                            return invalidPlan(request.now_ns);
                        };
                    };
                };
                {
                    result = acceptedResult(
                        request.now_ns,
                        ?accepted.head.revision,
                        ?protocolHead(accepted.head),
                    );
                    domain = {
                        follower = ?committedFollowerMutation;
                        following = null;
                        feed = null;
                        notification;
                        like = null;
                    };
                    semantic_notice_increment = false;
                };
            };
        };
    };

    func planUnfollow(
        state : Types.State,
        request : Types.Request,
        body : Protocol.UnfollowBodyV1,
    ) : PlannedDomain {
        let captured = captureUnfollow(
            state.relationships,
            request.self_node,
            request.caller,
            {
                expected_revision = body.expected_revision;
                subscription_id = body.subscription_id;
            },
        );
        switch (captured.result) {
            case (#err(error)) {
                {
                    result = unfollowError(error, request.now_ns);
                    domain = emptyDomain();
                    semantic_notice_increment = false;
                };
            };
            case (#accepted(head)) {
                let ?mutation = captured.mutation else {
                    return invalidPlan(request.now_ns);
                };
                {
                    result = acceptedResult(
                        request.now_ns,
                        ?head.revision,
                        // The frozen Unfollow response ceiling is 128 bytes.
                        // Revision remains useful CAS metadata; the complete
                        // head does not fit and is therefore omitted.
                        null,
                    );
                    domain = {
                        follower = ?mutation;
                        following = null;
                        feed = null;
                        notification = null;
                        like = null;
                    };
                    semantic_notice_increment = false;
                };
            };
        };
    };

    func planDelivery(
        state : Types.State,
        request : Types.Request,
        ingress : Protocol.WagyuIngressV1,
        payloadDigest : Blob,
        stableReceiptKey : Text,
        claims : DeliveryClaims,
    ) : PlannedDomain {
        if (
            claims.following.storage_revision == Nat64.maxValue
        ) return fullPlan(request.now_ns);
        if (request.now_ns < claims.following.updated_at_ns) {
            return invalidPlan(request.now_ns);
        };
        let followingMutation : RelationshipTypes.FollowingMutation = {
            node = request.caller;
            expected_storage_revision =
                ?claims.following.storage_revision;
            next_row = {
                claims.following with
                storage_revision =
                    claims.following.storage_revision + 1;
                // Renewal requests are sticky until a successful paid Follow
                // clears them. Deliveries do not move the local estimate of
                // the peer's funded lease window.
                renewal_requested =
                    claims.following.renewal_requested or
                    claims.renewal_requested;
            };
        };
        let ?candidateId = Hash.feedCandidateId(
            request.caller,
            ingress.operation_id,
            payloadDigest,
        ) else return invalidPlan(request.now_ns);
        let candidateKey = state.candidate_stable_key(candidateId);
        if (candidateKey.size() == 0) return invalidPlan(request.now_ns);
        let retainedBytes =
            claims.exact_event_candid.size() +
                FeedTypes.MAX_ACCOUNTED_OVERHEAD_BYTES;
        let captured = captureFeed(
            state.feed,
            {
                candidate_key = candidateKey;
                candidate_id = candidateId;
                route_receipt_key = stableReceiptKey;
                operation_id = ingress.operation_id;
                payload_digest = payloadDigest;
                subscription_id = claims.subscription_id;
                received_at_ns = request.now_ns;
                immediate_sender = request.caller;
                event_kind = claims.event_kind;
                claimed_author = claims.claimed_author;
                claimed_post_id = claims.claimed_post_id;
                claimed_body_hash = claims.claimed_body_hash;
                exact_event_candid = claims.exact_event_candid;
                retain_until_ns = peerRetainUntil(request.now_ns);
                retained_bytes = retainedBytes;
            },
        );
        switch (captured.result) {
            case (#accepted(value)) {
                let ?mutation = captured.mutation else {
                    return invalidPlan(request.now_ns);
                };
                {
                    result = acceptedResult(
                        request.now_ns,
                        ?value.revision,
                        null,
                    );
                    domain = {
                        follower = null;
                        following = ?followingMutation;
                        feed = ?mutation;
                        notification = null;
                        like = null;
                    };
                    semantic_notice_increment = false;
                };
            };
            case (#duplicate(value)) {
                duplicatePlan(request.now_ns, ?value.revision);
            };
            case (#conflict(_)) conflictPlan(request.now_ns);
            case (#rejected(#full(_))) fullPlan(request.now_ns);
            case (#rejected(#invalid)) invalidPlan(request.now_ns);
            case (#rejected(_)) fullPlan(request.now_ns);
        };
    };

    func planLike(
        state : Types.State,
        request : Types.Request,
        value : PreparedLike,
    ) : PlannedDomain {
        if (not value.target.accepting_likes) {
            return rejectedPlan(#expired, request.now_ns);
        };
        switch (value.target.existing_receipt_digest) {
            case (?existing) {
                if (
                    Blob.equal(
                        existing,
                        Hash.sha256(value.exact_receipt_candid),
                    )
                ) return duplicatePlan(request.now_ns, null);
                return conflictPlan(request.now_ns);
            };
            case null {};
        };
        if (value.target.next_accepted_sequence == Nat64.maxValue) {
            return fullPlan(request.now_ns);
        };

        let notificationCapture = captureNotification(
            state.notifications,
            {
                acting_node = request.caller;
                received_at_ns = request.now_ns;
                event = #like({
                    locator = {
                        target_post_id = value.target.post_id;
                        target_body_hash =
                            value.target.post_body_hash;
                        action_id = value.action.like_id;
                        object_digest =
                            value.receipt.ref.object_digest;
                        object_length =
                            value.receipt.ref.body_length;
                    };
                    certified_like_receipt_candid =
                        value.exact_receipt_candid;
                });
            },
        );
        let notification = switch (
            capturedNotificationMutation(
                notificationCapture,
                peerRetainUntil(request.now_ns),
            )
        ) {
            case (#ok(mutation)) mutation;
            case (#duplicate) {
                return duplicatePlan(request.now_ns, null);
            };
            case (#conflict) return conflictPlan(request.now_ns);
            case (#unavailable) return fullPlan(request.now_ns);
            case (#invalid) return invalidPlan(request.now_ns);
        };
        {
            result = acceptedResult(request.now_ns, null, null);
            domain = {
                follower = null;
                following = null;
                feed = null;
                notification = ?notification;
                // The notification/evidence row is the bounded quarantine.
                // AcceptedLike and the sealable segments are populated only
                // by owner-browser verified notification promotion.
                like = null;
            };
            semantic_notice_increment = false;
        };
    };

    func planNotice(
        state : Types.State,
        request : Types.Request,
        value : PreparedNotice,
    ) : PlannedDomain {
        let body = value.body;
        let captured = captureNotification(
            state.notifications,
            {
                acting_node = request.caller;
                received_at_ns = request.now_ns;
                event = #notice({
                    relation = value.relation;
                    locator = {
                        target_post_id = body.target_post_id;
                        target_body_hash = body.target_body_hash;
                        action_id = body.actor_action_id;
                        object_digest = body.actor_object_digest;
                        object_length = body.actor_object_length;
                    };
                });
            },
        );
        switch (
            capturedNotificationMutation(
                captured,
                peerRetainUntil(request.now_ns),
            )
        ) {
            case (#ok(mutation)) {
                {
                    result = acceptedResult(
                        request.now_ns,
                        ?mutation.append.revision,
                        null,
                    );
                    domain = {
                        follower = null;
                        following = null;
                        feed = null;
                        notification = ?mutation;
                        like = null;
                    };
                    semantic_notice_increment = true;
                };
            };
            case (#duplicate) duplicatePlan(request.now_ns, null);
            case (#conflict) conflictPlan(request.now_ns);
            case (#unavailable) fullPlan(request.now_ns);
            case (#invalid) invalidPlan(request.now_ns);
        };
    };

    func decodeDeliveryClaims(
        request : Types.Request,
        subscriptionId : Blob,
        renewalRequested : Bool,
        following : RelationshipTypes.FollowingRow,
        event : Protocol.DeliveryEventV1,
    ) : {
        #ok : DeliveryClaims;
        #rejected : Protocol.RouteRejectionReasonV1;
    } {
        switch (event) {
            case (#original(exact)) {
                let ?post = Wire.decodeCertifiedPostRef(exact)
                    else return #rejected(#invalid);
                let ?expectedPostId = Hash.postId(
                    request.network_id,
                    post.author,
                    post.body_hash,
                ) else return #rejected(#invalid);
                if (
                    not Blob.equal(post.post_id, expectedPostId) or
                    not Validation.certifiedPostRefValue(post) or
                    not Principal.equal(post.author, request.caller)
                ) return #rejected(#invalid);
                #ok({
                    subscription_id = subscriptionId;
                    renewal_requested = renewalRequested;
                    following;
                    event_kind = #original;
                    claimed_author = post.author;
                    claimed_post_id = post.post_id;
                    claimed_body_hash = post.body_hash;
                    exact_event_candid = exact;
                });
            };
            case (#share(exact)) {
                let ?delivery = Wire.decodeCertifiedShareDelivery(exact)
                    else return #rejected(#invalid);
                let ?post = Wire.decodeCertifiedPostRef(
                    delivery.original_post_ref_candid
                ) else return #rejected(#invalid);
                let ?action = Wire.decodeShareAction(
                    delivery.share_action_candid
                ) else return #rejected(#invalid);
                let ?expectedPostId = Hash.postId(
                    request.network_id,
                    post.author,
                    post.body_hash,
                ) else return #rejected(#invalid);
                let ?expectedShareId = Hash.shareId(
                    request.network_id,
                    request.caller,
                    action.original_author,
                    action.original_post_id,
                ) else return #rejected(#invalid);
                switch (
                    Validation.shareAction(
                        action,
                        request.network_id,
                        request.caller,
                    )
                ) {
                    case (#incompatible) return #rejected(#incompatible);
                    case (#invalid) return #rejected(#invalid);
                    case (#valid) {};
                };
                if (
                    not Blob.equal(post.post_id, expectedPostId) or
                    not Blob.equal(action.share_id, expectedShareId) or
                    not Validation.certifiedPostRefValue(post) or
                    not Validation.certifiedShareRefValue(
                        delivery.share_ref
                    ) or
                    not Principal.equal(
                        delivery.share_ref.sharer,
                        request.caller,
                    ) or
                    not Blob.equal(
                        delivery.share_ref.share_id,
                        action.share_id,
                    ) or
                    delivery.share_ref.body_length !=
                        Nat32.fromNat(
                            delivery.share_action_candid.size()
                        ) or
                    not Blob.equal(
                        delivery.share_ref.object_digest,
                        Hash.objectDigest(
                            delivery.share_action_candid
                        ),
                    ) or
                    not Principal.equal(
                        action.original_author,
                        post.author,
                    ) or
                    not Blob.equal(
                        action.original_post_id,
                        post.post_id,
                    ) or
                    not Blob.equal(
                        action.original_body_hash,
                        post.body_hash,
                    ) or
                    not Blob.equal(
                        action.post_ref_digest,
                        Hash.postRefDigest(
                            delivery.original_post_ref_candid
                        ),
                    )
                ) return #rejected(#invalid);
                #ok({
                    subscription_id = subscriptionId;
                    renewal_requested = renewalRequested;
                    following;
                    event_kind = #share;
                    claimed_author = post.author;
                    claimed_post_id = post.post_id;
                    claimed_body_hash = post.body_hash;
                    exact_event_candid = exact;
                });
            };
            case (#tombstone(exact)) {
                let ?tombstone = Wire.decodeCertifiedTombstone(exact)
                    else return #rejected(#invalid);
                let ?action = Wire.decodeTombstoneAction(
                    tombstone.tombstone_action_candid
                ) else return #rejected(#invalid);
                let ?expectedPostId = Hash.postId(
                    request.network_id,
                    action.header.actor_,
                    action.post_body_hash,
                ) else return #rejected(#invalid);
                let ?expectedTombstoneId = Hash.tombstoneId(
                    request.network_id,
                    action.header.actor_,
                    action.post_id,
                    action.author_sequence,
                ) else return #rejected(#invalid);
                switch (
                    Validation.tombstoneAction(
                        action,
                        request.network_id,
                        action.header.actor_,
                    )
                ) {
                    case (#incompatible) return #rejected(#incompatible);
                    case (#invalid) return #rejected(#invalid);
                    case (#valid) {};
                };
                switch (
                    Validation.certifiedActionRefValue(
                        tombstone.ref,
                        action.header.actor_,
                        #tombstone,
                    )
                ) {
                    case (#incompatible) return #rejected(#incompatible);
                    case (#invalid) return #rejected(#invalid);
                    case (#valid) {};
                };
                if (
                    not Blob.equal(action.post_id, expectedPostId) or
                    not Blob.equal(
                        action.tombstone_id,
                        expectedTombstoneId,
                    ) or
                    tombstone.ref.body_length !=
                        Nat32.fromNat(
                            tombstone.tombstone_action_candid.size()
                        ) or
                    not Blob.equal(
                        tombstone.ref.object_digest,
                        Hash.objectDigest(
                            tombstone.tombstone_action_candid
                        ),
                    )
                ) return #rejected(#invalid);
                #ok({
                    subscription_id = subscriptionId;
                    renewal_requested = renewalRequested;
                    following;
                    event_kind = #tombstone;
                    claimed_author = action.header.actor_;
                    claimed_post_id = action.post_id;
                    claimed_body_hash = action.post_body_hash;
                    exact_event_candid = exact;
                });
            };
        };
    };

    func deliveryPolicy(
        state : Types.State,
        request : Types.Request,
        subscriptionId : Blob,
    ) : ?Protocol.RouteRejectionReasonV1 {
        let estimator : RelationshipTypes.CostEstimator = {
            call_and_byte_cycles = func(_) { ?0 };
            local_publication_cycles = func(_) { ?0 };
        };
        let service = RelationshipService.Service(
            readOnlyRelationships(state.relationships),
            request.self_node,
            estimator,
        );
        switch (
            service.deliveryAdmission(
                request.caller,
                subscriptionId,
            )
        ) {
            case (#allowed) null;
            case (#blocked) ?#blocked;
            case (#not_following or #subscription_mismatch) {
                ?#not_following;
            };
            case (#incompatible) ?#incompatible;
            case (#invalid_request or #self_call or #corrupt_state) {
                ?#invalid;
            };
        };
    };

    func captureFollow(
        base : RelationshipTypes.State,
        selfNode : Principal,
        caller : Principal,
        body : RelationshipTypes.FollowRequest,
        nowNs : Nat64,
    ) : CapturedFollower {
        var mutation : ?RelationshipTypes.FollowerMutation = null;
        let capturing = relationshipCaptureStore(base, func(value) {
            if (mutation != null) return false;
            mutation := ?value;
            true;
        });
        let estimator : RelationshipTypes.CostEstimator = {
            call_and_byte_cycles = func(_) { ?0 };
            local_publication_cycles = func(_) { ?0 };
        };
        let service = RelationshipService.Service(
            capturing,
            selfNode,
            estimator,
        );
        {
            result = service.applyFollow(caller, body, nowNs);
            mutation;
        };
    };

    func captureUnfollow(
        base : RelationshipTypes.State,
        selfNode : Principal,
        caller : Principal,
        body : RelationshipTypes.FollowRequest,
    ) : CapturedUnfollow {
        var mutation : ?RelationshipTypes.FollowerMutation = null;
        let capturing = relationshipCaptureStore(base, func(value) {
            if (mutation != null) return false;
            mutation := ?value;
            true;
        });
        let estimator : RelationshipTypes.CostEstimator = {
            call_and_byte_cycles = func(_) { ?0 };
            local_publication_cycles = func(_) { ?0 };
        };
        let service = RelationshipService.Service(
            capturing,
            selfNode,
            estimator,
        );
        {
            result = service.applyUnfollow(caller, body);
            mutation;
        };
    };

    func relationshipCaptureStore(
        base : RelationshipTypes.State,
        commitFollower :
            RelationshipTypes.FollowerMutation -> Bool,
    ) : RelationshipTypes.State {
        {
            follower = base.follower;
            followers = base.followers;
            followers_by_registration =
                base.followers_by_registration;
            active_follower_count = base.active_follower_count;
            follower_counters = base.follower_counters;
            commit_follower = commitFollower;
            following = base.following;
            following_count = base.following_count;
            commit_following = func(_) { false };
            block = base.block;
            block_count = base.block_count;
            commit_block = func(_) { false };
        };
    };

    func readOnlyRelationships(
        base : RelationshipTypes.State
    ) : RelationshipTypes.State {
        relationshipCaptureStore(base, func(_) { false });
    };

    func captureFeed(
        base : FeedTypes.Store,
        admission : FeedTypes.CandidateAdmission,
    ) : CapturedFeed {
        var mutation : ?FeedTypes.AdmissionCommit = null;
        let store : FeedTypes.Store = {
            snapshot = base.snapshot;
            count_for_sender = base.count_for_sender;
            find_candidate = base.find_candidate;
            find_transport = base.find_transport;
            find_canonical = base.find_canonical;
            find_canonical_slot = base.find_canonical_slot;
            find_attribution = base.find_attribution;
            attribution_count = base.attribution_count;
            find_suppression = base.find_suppression;
            scan_claimed_slot = base.scan_claimed_slot;
            scan_descending = base.scan_descending;
            commit_admission = func(value) {
                if (mutation != null) return false;
                mutation := ?value;
                true;
            };
            commit_promotion = func(_) { false };
            commit_verification = func(_) { false };
        };
        let service = FeedService.Service(store);
        {
            result = service.admit(admission);
            mutation;
        };
    };

    func captureNotification(
        base : NotificationTypes.Store,
        append : NotificationTypes.AppendRequest,
    ) : CapturedNotification {
        var mutation : ?NotificationTypes.AppendCommit = null;
        let store : NotificationTypes.Store = {
            snapshot = base.snapshot;
            find_semantic = base.find_semantic;
            get = base.get;
            scan_descending = base.scan_descending;
            notice_count_for_actor = base.notice_count_for_actor;
            notice_count_for_target = base.notice_count_for_target;
            commit_append = func(value) {
                if (mutation != null) return false;
                mutation := ?value;
                true;
            };
            commit_replace = func(_) { false };
        };
        {
            result = NotificationService.append(store, append);
            mutation;
        };
    };

    func capturedNotificationMutation(
        captured : CapturedNotification,
        retainUntilNs : Nat64,
    ) : {
        #ok : Types.NotificationMutation;
        #duplicate;
        #conflict;
        #unavailable;
        #invalid;
    } {
        switch (captured.result) {
            case (#accepted(_)) {
                let ?mutation = captured.mutation else return #invalid;
                let evidenceBytes = switch (
                    mutation.stored.like_evidence
                ) {
                    case null 0;
                    case (?value) value.size();
                };
                #ok({
                    append = mutation;
                    retain_until_ns = retainUntilNs;
                    retained_bytes =
                        evidenceBytes +
                        NOTIFICATION_ACCOUNTING_OVERHEAD;
                });
            };
            case (#duplicate(_)) #duplicate;
            case (#conflict(_)) #conflict;
            case (#rejected(#full(_))) #unavailable;
            case (#rejected(#sequence_exhausted)) #unavailable;
            case (#rejected(#invalid or #stale_state)) #invalid;
        };
    };

    func prepareRate(
        state : Types.State,
        request : Types.Request,
    ) : {
        #ok : Types.RateMutation;
        #limited;
        #invalid;
    } {
        let stableKey = state.rate_window_stable_key(
            request.caller,
            request.route,
        );
        if (stableKey.size() == 0) return #invalid;
        let maximum = Nat32.fromNat(
            Bounds.routeById(
                toBoundsRoute(request.route)
            ).max_calls_per_hour
        );
        let current = state.rate_window(
            request.caller,
            request.route,
        );
        let replacement : Types.RateWindow = switch (current) {
            case null {
                let ?expires = addNat64(request.now_ns, HOUR_NS)
                    else return #invalid;
                {
                    caller = request.caller;
                    route = request.route;
                    window_started_at_ns = request.now_ns;
                    accepted_count = (1 : Nat32);
                    semantic_notice_count = (0 : Nat32);
                    expires_at_ns = expires;
                    retained_bytes = RATE_ACCOUNTING_BYTES;
                };
            };
            case (?window) {
                if (
                    not Principal.equal(window.caller, request.caller) or
                    window.route != request.route or
                    window.window_started_at_ns >
                        window.expires_at_ns or
                    window.expires_at_ns -
                        window.window_started_at_ns != HOUR_NS or
                    window.retained_bytes < RATE_ACCOUNTING_BYTES or
                    window.accepted_count > maximum or
                    window.semantic_notice_count >
                        NOTICE_SEMANTIC_LIMIT_PER_HOUR
                ) return #invalid;
                if (request.now_ns >= window.expires_at_ns) {
                    let ?expires = addNat64(request.now_ns, HOUR_NS)
                        else return #invalid;
                    {
                        caller = request.caller;
                        route = request.route;
                        window_started_at_ns = request.now_ns;
                        accepted_count = (1 : Nat32);
                        semantic_notice_count = (0 : Nat32);
                        expires_at_ns = expires;
                        retained_bytes = window.retained_bytes;
                    };
                } else {
                    if (
                        request.now_ns < window.window_started_at_ns
                    ) return #invalid;
                    if (window.accepted_count >= maximum) {
                        return #limited;
                    };
                    {
                        window with
                        accepted_count = window.accepted_count + 1;
                    };
                };
            };
        };
        #ok({
            stable_key = stableKey;
            expected = current;
            replacement;
        });
    };

    func ready(
        request : Types.Request,
        ingress : Protocol.WagyuIngressV1,
        payloadDigest : Blob,
        stableReceiptKey : Text,
        result : Protocol.WagyuRouteResultV1,
        rate : ?Types.RateMutation,
        domain : Types.DomainMutation,
    ) : Types.PlanOutcome {
        let normalizedResult = normalizeRouteResult(
            request.route,
            result,
        );
        let exactResult = encodeRouteResult(
            request.route,
            normalizedResult,
        );
        let maximumResponseBytes = Bounds.routeById(
            toBoundsRoute(request.route)
        ).max_response_bytes;
        if (
            exactResult.size() == 0 or
            exactResult.size() > maximumResponseBytes
        ) {
            return #immediate(response(
                request.route,
                rejected(#incompatible, request.now_ns),
                false,
                false,
            ));
        };
        let retainUntil = switch (request.route) {
            case (#like) likeRetainUntil(request.now_ns);
            case (_) peerRetainUntil(request.now_ns);
        };
        #ready({
            receipt = {
                key = {
                    caller = request.caller;
                    route = request.route;
                    operation_id = ingress.operation_id;
                };
                stable_key = stableReceiptKey;
                payload_digest = payloadDigest;
                result = normalizedResult;
                exact_result_candid = exactResult;
                received_at_ns = request.now_ns;
                retain_until_ns = retainUntil;
                retained_bytes =
                    ingress.operation_id.size() +
                    payloadDigest.size() +
                    exactResult.size() +
                    RECEIPT_ACCOUNTING_OVERHEAD;
            };
            rate;
            domain;
        });
    };

    func response(
        route : Types.Route,
        result : Protocol.WagyuRouteResultV1,
        replayed : Bool,
        committed : Bool,
    ) : Types.Response {
        let normalizedResult = normalizeRouteResult(route, result);
        {
            result = normalizedResult;
            exact_result_candid =
                encodeRouteResult(route, normalizedResult);
            replayed;
            committed;
        };
    };

    func normalizeRouteResult(
        route : Types.Route,
        result : Protocol.WagyuRouteResultV1,
    ) : Protocol.WagyuRouteResultV1 {
        switch (route) {
            case (#unfollow) {
                {
                    outcome = result.outcome;
                    local_receipt_time_ns = null;
                    revision = result.revision;
                    relationship = null;
                };
            };
            case (_) result;
        };
    };

    func acceptedResult(
        nowNs : Nat64,
        revision : ?Nat64,
        relationship : ?Protocol.FollowerHeadV1,
    ) : Protocol.WagyuRouteResultV1 {
        {
            outcome = ?#accepted;
            local_receipt_time_ns = ?nowNs;
            revision;
            relationship;
        };
    };

    func duplicateResult(
        nowNs : Nat64,
        revision : ?Nat64,
    ) : Protocol.WagyuRouteResultV1 {
        {
            outcome = ?#duplicate;
            local_receipt_time_ns = ?nowNs;
            revision;
            relationship = null;
        };
    };

    func rejected(
        reason : Protocol.RouteRejectionReasonV1,
        nowNs : Nat64,
    ) : Protocol.WagyuRouteResultV1 {
        {
            outcome = ?#rejected({ reason = ?reason });
            local_receipt_time_ns = ?nowNs;
            revision = null;
            relationship = null;
        };
    };

    func transientFull() : Protocol.WagyuRouteResultV1 {
        {
            outcome = ?#rejected({ reason = ?#full });
            local_receipt_time_ns = null;
            revision = null;
            relationship = null;
        };
    };

    func invalidPlan(nowNs : Nat64) : PlannedDomain {
        rejectedPlan(#invalid, nowNs);
    };

    func fullPlan(nowNs : Nat64) : PlannedDomain {
        rejectedPlan(#full, nowNs);
    };

    func conflictPlan(nowNs : Nat64) : PlannedDomain {
        rejectedPlan(#conflict, nowNs);
    };

    func rejectedPlan(
        reason : Protocol.RouteRejectionReasonV1,
        nowNs : Nat64,
    ) : PlannedDomain {
        {
            result = rejected(reason, nowNs);
            domain = emptyDomain();
            semantic_notice_increment = false;
        };
    };

    func duplicatePlan(
        nowNs : Nat64,
        revision : ?Nat64,
    ) : PlannedDomain {
        {
            result = duplicateResult(nowNs, revision);
            domain = emptyDomain();
            semantic_notice_increment = false;
        };
    };

    func relationshipError(
        error : RelationshipTypes.FollowError,
        nowNs : Nat64,
    ) : Protocol.WagyuRouteResultV1 {
        switch (error) {
            case (#blocked) rejected(#blocked, nowNs);
            case (#conflict(head)) {
                {
                    outcome = ?#rejected({ reason = ?#conflict });
                    local_receipt_time_ns = ?nowNs;
                    revision = switch (head) {
                        case null null;
                        case (?value) ?value.revision;
                    };
                    relationship = switch (head) {
                        case null null;
                        case (?value) ?protocolHead(value);
                    };
                };
            };
            case (#full or #revision_overflow) {
                rejected(#full, nowNs);
            };
            case (#credit_cap) rejected(#conflict, nowNs);
            case (#invalid_request or #self_call or #clock_overflow or
                  #corrupt_state or #state_conflict) {
                rejected(#invalid, nowNs);
            };
        };
    };

    func unfollowError(
        error : RelationshipTypes.FollowError,
        nowNs : Nat64,
    ) : Protocol.WagyuRouteResultV1 {
        switch (error) {
            case (#blocked) rejected(#blocked, nowNs);
            case (#conflict(head)) {
                {
                    outcome = ?#rejected({ reason = ?#conflict });
                    local_receipt_time_ns = ?nowNs;
                    revision = switch (head) {
                        case null null;
                        case (?value) ?value.revision;
                    };
                    relationship = null;
                };
            };
            case (#full or #revision_overflow) {
                rejected(#full, nowNs);
            };
            case (#credit_cap) rejected(#conflict, nowNs);
            case (#invalid_request or #self_call or #clock_overflow or
                  #corrupt_state or #state_conflict) {
                rejected(#invalid, nowNs);
            };
        };
    };

    func rejectedWithHead(
        reason : Protocol.RouteRejectionReasonV1,
        head : ?RelationshipTypes.FollowerHead,
        nowNs : Nat64,
    ) : Protocol.WagyuRouteResultV1 {
        {
            outcome = ?#rejected({ reason = ?reason });
            local_receipt_time_ns = ?nowNs;
            revision = switch (head) {
                case null null;
                case (?value) ?value.revision;
            };
            relationship = switch (head) {
                case null null;
                case (?value) ?protocolHead(value);
            };
        };
    };

    func protocolHead(
        head : RelationshipTypes.FollowerHead
    ) : Protocol.FollowerHeadV1 {
        let state = switch (head.state) {
            case (#active(value)) #active(value);
            case (#inactive(value)) #inactive(value);
        };
        {
            revision = head.revision;
            state = ?state;
        };
    };

    func emptyDomain() : Types.DomainMutation {
        {
            follower = null;
            following = null;
            feed = null;
            notification = null;
            like = null;
        };
    };

    func targetShape(
        target : Types.LikeTarget,
        selfNode : Principal,
    ) : Bool {
        target.post_key.size() > 0 and
        Principal.equal(target.post_author, selfNode) and
        target.post_id.size() == Bounds.HASH_BYTES and
        target.post_body_hash.size() == Bounds.HASH_BYTES and
        target.unsealed_receipt_limit > 0 and
        target.unsealed_receipt_count <=
            target.unsealed_receipt_limit;
    };

    func sameReceiptKey(
        left : Types.ReceiptKey,
        right : Types.ReceiptKey,
    ) : Bool {
        Principal.equal(left.caller, right.caller) and
        left.route == right.route and
        Blob.equal(left.operation_id, right.operation_id);
    };

    func toBoundsRoute(
        route : Types.Route
    ) : Bounds.RouteIdV1 {
        switch (route) {
            case (#follow) #follow;
            case (#unfollow) #unfollow;
            case (#deliver) #deliver;
            case (#like) #like;
            case (#notice) #notice;
        };
    };

    func peerRetainUntil(nowNs : Nat64) : Nat64 {
        switch (addNat64(nowNs, PEER_RETENTION_NS)) {
            case (?value) value;
            case null Nat64.maxValue;
        };
    };

    func likeRetainUntil(nowNs : Nat64) : Nat64 {
        switch (addNat64(nowNs, LIKE_RETENTION_NS)) {
            case (?value) value;
            case null Nat64.maxValue;
        };
    };

    func addNat64(left : Nat64, right : Nat64) : ?Nat64 {
        if (left > Nat64.maxValue - right) null else ?(left + right);
    };

    func configuredNetworkId(value : Blob) : Bool {
        if (value.size() != Bounds.HASH_BYTES) return false;
        for (byte in value.values()) {
            if (byte != 0) return true;
        };
        false;
    };

};
