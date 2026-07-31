import Blob "mo:core/Blob";
import Iter "mo:core/Iter";
import Nat64 "mo:core/Nat64";
import Text "mo:core/Text";

import Bounds "../protocol/Bounds";
import ProtocolTypes "../protocol/Types";
import Types "./Types";

module {
    public func semantic(
        result : ProtocolTypes.WagyuRouteResultV1,
        exact : Blob,
    ) : Types.DispatchResultV1 {
        semanticForRoute("", result, exact);
    };

    public func semanticForRoute(
        route : Text,
        result : ProtocolTypes.WagyuRouteResultV1,
        exact : Blob,
    ) : Types.DispatchResultV1 {
        switch (result.outcome) {
            case (?#accepted) resolved(#accepted, result, exact);
            case (?#duplicate) resolved(#duplicate, result, exact);
            case (?#rejected({ reason = ?reason })) {
                let transientLikeFull =
                    route == Bounds.LIKE_ROUTE and
                    reason == #full and
                    result.local_receipt_time_ns == null;
                {
                    outcome = #route_rejected(reason);
                    certainty = #semantic;
                    retry = if (transientLikeFull) {
                        #delayed({
                            minimum_delay_ns =
                                Types.LIKE_FULL_RETRY_DELAY_NS;
                            jitter_window_ns = 0;
                        });
                    } else #terminal;
                    route_result = ?result;
                    exact_route_result_candid = ?exact;
                    code = ?rejectionCode(reason);
                    detail = null;
                };
            };
            // Optional extensibility fields deliberately fail closed. An old
            // caller must not map a future outcome or reason to success or a
            // blind automatic retry.
            case null unsupported(
                #semantic,
                ?"unknown_route_outcome",
                ?"The peer returned an unsupported Wagyu outcome",
                ?result,
                ?exact,
            );
            case (?#rejected({ reason = null })) unsupported(
                #semantic,
                ?"unknown_rejection_reason",
                ?"The peer returned an unsupported Wagyu rejection reason",
                ?result,
                ?exact,
            );
        };
    };

    public func publicIngressError(
        error : ProtocolTypes.PublicIngressErrorV1,
    ) : Types.DispatchResultV1 {
        switch (error) {
            case (#busy) delayed(
                #busy,
                #may_have_dispatched,
                "public_ingress_busy",
                Types.BUSY_RETRY_DELAY_NS,
                Types.BUSY_RETRY_JITTER_NS,
            );
            case (#rate_limited) delayed(
                #rate_limited,
                #may_have_dispatched,
                "public_ingress_rate_limited",
                Types.RATE_LIMIT_RETRY_DELAY_NS,
                Types.RATE_LIMIT_RETRY_JITTER_NS,
            );
            case (#low_cycles) paused(
                #low_cycles,
                #may_have_dispatched,
                "public_ingress_low_cycles",
            );
            case (#revoked) paused(
                #revoked,
                #may_have_dispatched,
                "public_ingress_revoked",
            );
            case (#revoked_after_dispatch) uncertain(
                "public_ingress_revoked_after_dispatch",
                "Public-ingress authority changed after dispatch",
            );
            case (#handler_failed) {
                {
                    outcome = #handler_failure;
                    certainty = #may_have_dispatched;
                    retry = #manual({ minimum_delay_ns = 0 });
                    route_result = null;
                    exact_route_result_candid = null;
                    code = ?"public_ingress_handler_failed";
                    detail = ?"The remote Wagyu handler failed";
                };
            };
            // Every outer error is evidence that the cross-canister call
            // reached the peer dispatcher. For valid paid routes the kernel
            // accepts the route floor before busy/rate/size/authority checks,
            // so an outbox must consume the attempt credit even where the
            // Wagyu handler definitely did not run.
            case (#bad_request) remoteTerminal("public_ingress_bad_request");
            case (#not_found) remoteTerminal("public_ingress_not_found");
            case (#too_large) remoteTerminal("public_ingress_too_large");
            case (#unauthorized) remoteTerminal(
                "public_ingress_unauthorized"
            );
        };
    };

    public func backendError(
        error : Types.BackendCallErrorV1,
    ) : Types.DispatchResultV1 {
        let code = boundedText(error.code, 64);
        let detail = boundedText(error.message, 512);
        switch (code) {
            case ("concurrency_limit") delayedDetail(
                #busy,
                #not_dispatched,
                code,
                detail,
                Types.BUSY_RETRY_DELAY_NS,
                Types.BUSY_RETRY_JITTER_NS,
            );
            case ("scheduled_budget_exhausted") delayedDetail(
                #busy,
                #not_dispatched,
                code,
                detail,
                Types.BUSY_RETRY_DELAY_NS,
                Types.BUSY_RETRY_JITTER_NS,
            );
            case ("low_cycles") pausedDetail(
                #low_cycles,
                #not_dispatched,
                code,
                detail,
            );
            case ("cycles_daily_limit") delayedDetail(
                #rate_limited,
                #not_dispatched,
                code,
                detail,
                Types.DAY_NS,
                Types.RATE_LIMIT_RETRY_JITTER_NS,
            );
            case ("capability_revoked") pausedDetail(
                #revoked,
                #not_dispatched,
                code,
                detail,
            );
            case ("capability_disabled") pausedDetail(
                #revoked,
                #not_dispatched,
                code,
                detail,
            );
            case ("capability_missing") pausedDetail(
                #revoked,
                #not_dispatched,
                code,
                detail,
            );
            case ("not_reserved") pausedDetail(
                #revoked,
                #not_dispatched,
                code,
                detail,
            );
            case ("invocation_expired") pausedDetail(
                #revoked,
                #not_dispatched,
                code,
                detail,
            );
            case ("revoked_after_dispatch") uncertainDetail(code, detail);
            case ("invocation_revoked_after_dispatch") uncertainDetail(
                code,
                detail,
            );
            case ("reply_limit") uncertainDetail(code, detail);
            case ("internal") uncertainDetail(code, detail);
            // The raw broker intentionally collapses IC reject codes. A
            // rejection can therefore follow an attempted dispatch; it is a
            // manual handler/transport failure, never an automatic loop.
            case ("call_rejected") {
                {
                    outcome = #handler_failure;
                    certainty = #may_have_dispatched;
                    retry = #manual({ minimum_delay_ns = 0 });
                    route_result = null;
                    exact_route_result_candid = null;
                    code = ?code;
                    detail = ?detail;
                };
            };
            // These are all current kernel checks made before any future is
            // created.
            case ("target_blocked") preDispatchFailure(code, detail);
            case ("invalid_method") preDispatchFailure(code, detail);
            case ("argument_limit") preDispatchFailure(code, detail);
            case ("cycles_per_call_limit") preDispatchFailure(code, detail);
            case ("batch_limit") preDispatchFailure(code, detail);
            // A future broker may add a failure at either side of its await.
            // Unknown codes therefore fail closed as unsupported/uncertain.
            case (_) unsupported(
                #may_have_dispatched,
                ?code,
                ?detail,
                null,
                null,
            );
        };
    };

    public func malformedReply(code : Text, detail : Text) : Types.DispatchResultV1 {
        uncertainDetail(boundedText(code, 64), boundedText(detail, 512));
    };

    public func expired() : Types.DispatchResultV1 {
        {
            outcome = #pre_dispatch_failure;
            certainty = #not_dispatched;
            retry = #terminal;
            route_result = null;
            exact_route_result_candid = null;
            code = ?"retry_horizon_expired";
            detail = ?"The exact operation is older than Wagyu's 400-day retry horizon";
        };
    };

    public func invalidPrepared() : Types.DispatchResultV1 {
        preDispatchFailure(
            "invalid_prepared_call",
            "The durable Wagyu dispatch bytes do not match their frozen identity",
        );
    };

    func resolved(
        outcome : { #accepted; #duplicate },
        result : ProtocolTypes.WagyuRouteResultV1,
        exact : Blob,
    ) : Types.DispatchResultV1 {
        {
            outcome;
            certainty = #semantic;
            retry = #complete;
            route_result = ?result;
            exact_route_result_candid = ?exact;
            code = null;
            detail = null;
        };
    };

    func rejectionCode(
        reason : ProtocolTypes.RouteRejectionReasonV1,
    ) : Text {
        switch (reason) {
            case (#invalid) "invalid";
            case (#blocked) "blocked";
            case (#not_following) "not_following";
            case (#unknown_post) "unknown_post";
            case (#expired) "expired";
            case (#full) "full";
            case (#conflict) "conflict";
            case (#incompatible) "incompatible";
        };
    };

    func delayed(
        outcome : { #busy; #rate_limited },
        certainty : Types.DispatchCertaintyV1,
        code : Text,
        delay : Nat64,
        jitter : Nat64,
    ) : Types.DispatchResultV1 {
        delayedDetail(outcome, certainty, code, "", delay, jitter);
    };

    func delayedDetail(
        outcome : { #busy; #rate_limited },
        certainty : Types.DispatchCertaintyV1,
        code : Text,
        detail : Text,
        delay : Nat64,
        jitter : Nat64,
    ) : Types.DispatchResultV1 {
        {
            outcome;
            certainty;
            retry = #delayed({
                minimum_delay_ns = delay;
                jitter_window_ns = jitter;
            });
            route_result = null;
            exact_route_result_candid = null;
            code = ?code;
            detail = if (detail == "") null else ?detail;
        };
    };

    func paused(
        outcome : { #low_cycles; #revoked },
        certainty : Types.DispatchCertaintyV1,
        code : Text,
    ) : Types.DispatchResultV1 {
        pausedDetail(outcome, certainty, code, "");
    };

    func pausedDetail(
        outcome : { #low_cycles; #revoked },
        certainty : Types.DispatchCertaintyV1,
        code : Text,
        detail : Text,
    ) : Types.DispatchResultV1 {
        {
            outcome;
            certainty;
            retry = #pause;
            route_result = null;
            exact_route_result_candid = null;
            code = ?code;
            detail = if (detail == "") null else ?detail;
        };
    };

    func uncertain(code : Text, detail : Text) : Types.DispatchResultV1 {
        uncertainDetail(code, detail);
    };

    func uncertainDetail(code : Text, detail : Text) : Types.DispatchResultV1 {
        {
            outcome = #uncertain;
            certainty = #may_have_dispatched;
            retry = #manual({
                minimum_delay_ns = Types.UNCERTAIN_RETRY_DELAY_NS;
            });
            route_result = null;
            exact_route_result_candid = null;
            code = ?code;
            detail = ?detail;
        };
    };

    func unsupported(
        certainty : Types.DispatchCertaintyV1,
        code : ?Text,
        detail : ?Text,
        result : ?ProtocolTypes.WagyuRouteResultV1,
        exact : ?Blob,
    ) : Types.DispatchResultV1 {
        {
            outcome = #unsupported;
            certainty;
            retry = #manual({
                minimum_delay_ns = Types.UNCERTAIN_RETRY_DELAY_NS;
            });
            route_result = result;
            exact_route_result_candid = exact;
            code;
            detail;
        };
    };

    func remoteTerminal(code : Text) : Types.DispatchResultV1 {
        {
            outcome = #handler_failure;
            certainty = #may_have_dispatched;
            retry = #terminal;
            route_result = null;
            exact_route_result_candid = null;
            code = ?code;
            detail = null;
        };
    };

    func preDispatchFailure(
        code : Text,
        detail : Text,
    ) : Types.DispatchResultV1 {
        {
            outcome = #pre_dispatch_failure;
            certainty = #not_dispatched;
            retry = #terminal;
            route_result = null;
            exact_route_result_candid = null;
            code = ?code;
            detail = if (detail == "") null else ?detail;
        };
    };

    func boundedText(value : Text, limit : Nat) : Text {
        if (value.size() <= limit) value else {
            Text.fromIter(Iter.take(value.chars(), limit));
        };
    };
};
