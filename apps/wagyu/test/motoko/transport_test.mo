import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";

import Bounds "../../backend/protocol/Bounds";
import ProtocolTypes "../../backend/protocol/Types";
import ProtocolWire "../../backend/protocol/Wire";
import Dispatcher "../../backend/transport/Dispatcher";
import OuterWire "../../backend/transport/OuterWire";
import Policy "../../backend/transport/Policy";
import TransportTypes "../../backend/transport/Types";

let accepted : ProtocolTypes.WagyuRouteResultV1 = {
    outcome = ?#accepted;
    local_receipt_time_ns = ?1;
    revision = null;
    relationship = null;
};
let acceptedResult = Policy.semanticForRoute(
    Bounds.FOLLOW_ROUTE,
    accepted,
    Blob.fromArray([1]),
);
assert (acceptedResult.outcome == #accepted);
assert (acceptedResult.certainty == #semantic);
assert (acceptedResult.retry == #complete);

let blocked : ProtocolTypes.WagyuRouteResultV1 = {
    outcome = ?#rejected({ reason = ?#blocked });
    local_receipt_time_ns = null;
    revision = null;
    relationship = null;
};
let blockedResult = Policy.semanticForRoute(
    Bounds.FOLLOW_ROUTE,
    blocked,
    Blob.fromArray([2]),
);
assert (blockedResult.outcome == #route_rejected(#blocked));
assert (blockedResult.retry == #terminal);

let unreceiptedFull : ProtocolTypes.WagyuRouteResultV1 = {
    outcome = ?#rejected({ reason = ?#full });
    local_receipt_time_ns = null;
    revision = null;
    relationship = null;
};
let transientLikeFull = Policy.semanticForRoute(
    Bounds.LIKE_ROUTE,
    unreceiptedFull,
    Blob.fromArray([3]),
);
assert (transientLikeFull.outcome == #route_rejected(#full));
assert (transientLikeFull.certainty == #semantic);
assert (
    transientLikeFull.retry ==
    #delayed({
        minimum_delay_ns = TransportTypes.LIKE_FULL_RETRY_DELAY_NS;
        jitter_window_ns = 0;
    })
);
let receiptedFull : ProtocolTypes.WagyuRouteResultV1 = {
    unreceiptedFull with
    local_receipt_time_ns = ?(2 : Nat64);
};
let terminalReceiptedLikeFull = Policy.semanticForRoute(
    Bounds.LIKE_ROUTE,
    receiptedFull,
    Blob.fromArray([4]),
);
assert (terminalReceiptedLikeFull.retry == #terminal);
let terminalNonLikeFull = Policy.semanticForRoute(
    Bounds.FOLLOW_ROUTE,
    unreceiptedFull,
    Blob.fromArray([5]),
);
assert (terminalNonLikeFull.retry == #terminal);

let unsupported : ProtocolTypes.WagyuRouteResultV1 = {
    outcome = null;
    local_receipt_time_ns = null;
    revision = null;
    relationship = null;
};
let unsupportedResult = Policy.semanticForRoute(
    Bounds.FOLLOW_ROUTE,
    unsupported,
    Blob.fromArray([6]),
);
assert (unsupportedResult.outcome == #unsupported);
assert (
    unsupportedResult.retry ==
    #manual({
        minimum_delay_ns = TransportTypes.UNCERTAIN_RETRY_DELAY_NS;
    })
);

let busy = Policy.publicIngressError(#busy);
assert (busy.outcome == #busy);
assert (busy.certainty == #may_have_dispatched);

let revokedAfterDispatch = Policy.publicIngressError(
    #revoked_after_dispatch
);
assert (revokedAfterDispatch.outcome == #uncertain);
assert (revokedAfterDispatch.certainty == #may_have_dispatched);

let preDispatch = Policy.backendError({
    code = "argument_limit";
    message = "too large";
});
assert (preDispatch.outcome == #pre_dispatch_failure);
assert (preDispatch.certainty == #not_dispatched);

let dailyLimit = Policy.backendError({
    code = "cycles_daily_limit";
    message = "daily transfer allowance exhausted";
});
assert (dailyLimit.outcome == #rate_limited);
assert (dailyLimit.certainty == #not_dispatched);
assert (
    dailyLimit.retry ==
    #delayed({
        minimum_delay_ns = TransportTypes.DAY_NS;
        jitter_window_ns = TransportTypes.RATE_LIMIT_RETRY_JITTER_NS;
    })
);

let callRejected = Policy.backendError({
    code = "call_rejected";
    message = "remote reject";
});
assert (callRejected.outcome == #handler_failure);
assert (callRejected.certainty == #may_have_dispatched);

let unknownBrokerCode = Policy.backendError({
    code = "future_kernel_error";
    message = "unknown dispatch point";
});
assert (unknownBrokerCode.outcome == #unsupported);
assert (unknownBrokerCode.certainty == #may_have_dispatched);

let exactReplyBody = Blob.fromArray([0x2a, 0x2b]);
let exactOk : ProtocolTypes.PublicIngressResultV1 = #ok(exactReplyBody);
let exactOkCandid = to_candid (exactOk);
assert (OuterWire.decode(exactOkCandid, 2) == ?exactOk);
assert (OuterWire.decode(to_candid (exactOk), 1) == null);

let exactOkBytes = Blob.toArray(exactOkCandid);
let outerPrefixBytes = exactOkBytes.size() - exactReplyBody.size() - 2;
var outerPrefixIndex = 0;
while (outerPrefixIndex < outerPrefixBytes) {
    let mutated = Blob.fromArray(Array.tabulate<Nat8>(
        exactOkBytes.size(),
        func(index) {
            if (index == outerPrefixIndex) {
                if (exactOkBytes[index] == 0) 1 else 0;
            } else exactOkBytes[index];
        },
    ));
    assert (OuterWire.decode(mutated, 2) == null);
    outerPrefixIndex += 1;
};

let overlongOk = Blob.fromArray(Array.tabulate<Nat8>(
    exactOkBytes.size() + 1,
    func(index) {
        if (index < outerPrefixBytes + 1) exactOkBytes[index]
        else if (index == outerPrefixBytes + 1) 0x82
        else if (index == outerPrefixBytes + 2) 0x00
        else exactOkBytes[index - 1];
    },
));
assert (OuterWire.decode(overlongOk, 2) == null);

let trailingOk = Blob.fromArray(Array.tabulate<Nat8>(
    exactOkBytes.size() + 1,
    func(index) {
        if (index < exactOkBytes.size()) exactOkBytes[index] else 0;
    },
));
assert (OuterWire.decode(trailingOk, 2) == null);

let ingressErrors : [ProtocolTypes.PublicIngressErrorV1] = [
    #revoked_after_dispatch,
    #bad_request,
    #low_cycles,
    #revoked,
    #rate_limited,
    #busy,
    #handler_failed,
    #not_found,
    #unauthorized,
    #too_large,
];
for (error in ingressErrors.values()) {
    let exactError : ProtocolTypes.PublicIngressResultV1 = #err(error);
    assert (OuterWire.decode(to_candid (exactError), 512) == ?exactError);
};

assert (
    OuterWire.decode(
        Blob.fromArray([0x44, 0x49, 0x44, 0x4c]),
        512,
    ) == null
);

func canister(last : Nat8) : Principal {
    Principal.fromBlob(Blob.fromArray([0, last, 1]));
};

let local = canister(1);
let peer = canister(2);
var reservationAvailable = true;
let unusedBroker : TransportTypes.BackendCallPort = {
    can_call = func(target : Principal, method : Text) : Bool {
        reservationAvailable and Principal.equal(target, peer) and
        method == TransportTypes.PHYSICAL_METHOD;
    };
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
let dispatcher = Dispatcher.Dispatcher(local, unusedBroker);
let operationId = Blob.fromArray([
    1, 2, 3, 4, 5, 6, 7, 8,
    9, 10, 11, 12, 13, 14, 15, 16,
]);
let subscriptionId = Blob.fromArray([
    16, 15, 14, 13, 12, 11, 10, 9,
    8, 7, 6, 5, 4, 3, 2, 1,
]);
let followBody : ProtocolTypes.FollowBodyV1 = {
    expected_revision = 0;
    subscription_id = subscriptionId;
};
let #ok(prepared) = dispatcher.prepare({
    target = peer;
    route = Bounds.FOLLOW_ROUTE;
    operation_id = operationId;
    exact_body_candid = to_candid (followBody);
    created_at_ns = 100;
}) else Runtime.trap("follow dispatch preparation failed");

assert (prepared.cycles == Bounds.FOLLOW.required_cycles);
assert (prepared.maximum_response_bytes == Bounds.FOLLOW.max_response_bytes);
assert (prepared.payload_digest.size() == Bounds.HASH_BYTES);
assert (dispatcher.validPrepared(prepared));
let ?exactRequest = dispatcher.exactRequest(prepared) else {
    Runtime.trap("prepared call did not produce an exact request");
};
assert (Principal.equal(exactRequest.canister, peer));
assert (exactRequest.method == TransportTypes.PHYSICAL_METHOD);
assert (exactRequest.cycles == Bounds.FOLLOW.required_cycles);
assert (Blob.equal(exactRequest.args, prepared.exact_call_args));
let decodedPhysical : ?ProtocolTypes.PublicIngressRequestV1 =
    from_candid prepared.exact_call_args;
let ?physical = decodedPhysical else {
    Runtime.trap("exact physical call args did not decode");
};
assert (physical.method == Bounds.FOLLOW.method);
assert (Blob.equal(physical.payload, prepared.exact_ingress_candid));
let ?decodedIngress = ProtocolWire.decodeIngressForRoute(
    Bounds.FOLLOW_ROUTE,
    prepared.exact_ingress_candid,
) else Runtime.trap("exact Wagyu ingress did not decode");
assert (Blob.equal(decodedIngress.operation_id, operationId));
assert (
    Blob.equal(decodedIngress.body_candid, prepared.exact_body_candid)
);

let acceptedInner = to_candid (accepted);
let acceptedOuter : ProtocolTypes.PublicIngressResultV1 = #ok(acceptedInner);
let interpreted = dispatcher.interpret(
    prepared,
    #ok(to_candid (acceptedOuter)),
);
assert (interpreted.outcome == #accepted);
assert (
    interpreted.exact_route_result_candid ==
    ?acceptedInner
);

let unreceiptedFullInner = to_candid (unreceiptedFull);
let unreceiptedFullOuter : ProtocolTypes.PublicIngressResultV1 =
    #ok(unreceiptedFullInner);
let interpretedFollowFull = dispatcher.interpret(
    prepared,
    #ok(to_candid (unreceiptedFullOuter)),
);
assert (interpretedFollowFull.outcome == #route_rejected(#full));
assert (interpretedFollowFull.retry == #terminal);

let #ok(preparedLike) = dispatcher.prepare({
    target = peer;
    route = Bounds.LIKE_ROUTE;
    operation_id = operationId;
    exact_body_candid = ProtocolWire.encodeLikeBody({
        certified_like_receipt_candid = Blob.fromArray([1]);
    });
    created_at_ns = 100;
}) else Runtime.trap("like dispatch preparation failed");
let interpretedLikeFull = dispatcher.interpret(
    preparedLike,
    #ok(to_candid (unreceiptedFullOuter)),
);
assert (interpretedLikeFull.outcome == #route_rejected(#full));
assert (
    interpretedLikeFull.retry ==
    #delayed({
        minimum_delay_ns = TransportTypes.LIKE_FULL_RETRY_DELAY_NS;
        jitter_window_ns = 0;
    })
);

let busyOuter : ProtocolTypes.PublicIngressResultV1 = #err(#busy);
let interpretedBusy = dispatcher.interpret(
    prepared,
    #ok(to_candid (busyOuter)),
);
assert (interpretedBusy.outcome == #busy);
assert (interpretedBusy.certainty == #may_have_dispatched);

let malformed = dispatcher.interpret(
    prepared,
    #ok(Blob.fromArray([0x44, 0x49])),
);
assert (malformed.outcome == #uncertain);
assert (malformed.certainty == #may_have_dispatched);

let changedBody = {
    prepared with
    exact_body_candid = Blob.fromArray([0]);
};
assert (not dispatcher.validPrepared(changedBody));
assert (not Dispatcher.exactRetryMatches(prepared, changedBody));
assert (Dispatcher.exactRetryMatches(prepared, prepared));
assert (
    not Dispatcher.retryExpired(
        prepared,
        prepared.created_at_ns + TransportTypes.RETRY_HORIZON_NS,
    )
);
assert (
    Dispatcher.retryExpired(
        prepared,
        prepared.created_at_ns + TransportTypes.RETRY_HORIZON_NS + 1,
    )
);

reservationAvailable := false;
assert (
    dispatcher.prepare({
        target = peer;
        route = Bounds.FOLLOW_ROUTE;
        operation_id = operationId;
        exact_body_candid = to_candid (followBody);
        created_at_ns = 101;
    }) == #err(#not_reserved)
);

assert (
    dispatcher.prepare({
        target = local;
        route = Bounds.FOLLOW_ROUTE;
        operation_id = operationId;
        exact_body_candid = to_candid (followBody);
        created_at_ns = 101;
    }) == #err(#self_call)
);

assert (
    dispatcher.prepare({
        target = peer;
        route = "wagyu_v1:unknown";
        operation_id = operationId;
        exact_body_candid = to_candid (followBody);
        created_at_ns = 101;
    }) == #err(#invalid_route)
);

reservationAvailable := true;
assert (
    dispatcher.prepare({
        target = peer;
        route = Bounds.FOLLOW_ROUTE;
        operation_id = Blob.fromArray([1, 2, 3]);
        exact_body_candid = to_candid (followBody);
        created_at_ns = 101;
    }) == #err(#invalid_operation_id)
);
assert (
    dispatcher.prepare({
        target = peer;
        route = Bounds.FOLLOW_ROUTE;
        operation_id = operationId;
        exact_body_candid = Blob.fromArray([]);
        created_at_ns = 101;
    }) == #err(#invalid_body_candid)
);
assert (
    dispatcher.prepare({
        target = peer;
        route = Bounds.FOLLOW_ROUTE;
        operation_id = operationId;
        exact_body_candid = Blob.fromArray(
            Array.repeat<Nat8>(0, Bounds.FOLLOW.max_request_bytes),
        );
        created_at_ns = 101;
    }) == #err(#request_too_large)
);
