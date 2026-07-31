import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Error "mo:core/Error";
import List "mo:core/List";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import VarArray "mo:core/VarArray";

import Bounds "../protocol/Bounds";
import Hash "../protocol/Hash";
import ProtocolWire "../protocol/Wire";
import OuterWire "./OuterWire";
import Policy "./Policy";
import Types "./Types";

module {
    let MAX_BACKEND_ARGUMENT_BYTES : Nat = 262_144;

    public class Dispatcher(
        localCanister : Principal,
        backendCalls : Types.BackendCallPort,
    ) {
        public func prepare(input : Types.PrepareInputV1) : Types.PrepareResultV1 {
            let ?route = Bounds.route(input.route) else {
                return #err(#invalid_route);
            };
            if (input.operation_id.size() != Bounds.OPERATION_ID_BYTES) {
                return #err(#invalid_operation_id);
            };
            if (input.exact_body_candid.size() == 0) {
                return #err(#invalid_body_candid);
            };
            if (Principal.equal(input.target, localCanister)) {
                return #err(#self_call);
            };
            let ?wire = ProtocolWire.prepare(
                input.route,
                input.operation_id,
                input.exact_body_candid,
            ) else return #err(#request_too_large);
            if (
                wire.ingress_candid.size() > route.max_request_bytes or
                wire.physical_args.size() > MAX_BACKEND_ARGUMENT_BYTES
            ) return #err(#request_too_large);
            if (
                wire.request.method != route.method or
                not Blob.equal(wire.request.payload, wire.ingress_candid) or
                not Blob.equal(wire.body_candid, input.exact_body_candid)
            ) return #err(#invalid_prepared_call);
            if (
                not backendCalls.can_call(
                    input.target,
                    Types.PHYSICAL_METHOD,
                )
            ) return #err(#not_reserved);
            #ok({
                target = input.target;
                route = input.route;
                operation_id = input.operation_id;
                payload_digest = wire.payload_digest;
                exact_body_candid = wire.body_candid;
                exact_ingress_candid = wire.ingress_candid;
                exact_call_args = wire.physical_args;
                cycles = route.required_cycles;
                maximum_response_bytes = route.max_response_bytes;
                created_at_ns = input.created_at_ns;
            });
        };

        // Dispatches the exact stored backend-call argument. `validPrepared`
        // may reconstruct a comparison value, but that value is never sent or
        // substituted for the durable bytes.
        public func call(
            prepared : Types.PreparedDispatchV1,
            nowNs : Nat64,
        ) : async* Types.DispatchResultV1 {
            if (not validPrepared(prepared)) return Policy.invalidPrepared();
            if (retryExpired(prepared, nowNs)) return Policy.expired();
            if (
                not backendCalls.can_call(
                    prepared.target,
                    Types.PHYSICAL_METHOD,
                )
            ) {
                return Policy.backendError({
                    code = "not_reserved";
                    message =
                        "The exact Wagyu dispatcher reservation is unavailable";
                });
            };
            let result = try {
                await* backendCalls.call(callRequest(prepared));
            } catch (error) {
                return Policy.malformedReply(
                    "backend_call_trap",
                    Error.message(error),
                );
            };
            decodeResult(prepared, result);
        };

        // Retry is intentionally only an alias for dispatching the same
        // PreparedDispatchV1. It accepts no decoded body and creates no new
        // operation id, timestamp, envelope, or physical call argument.
        public func retry(
            prepared : Types.PreparedDispatchV1,
            nowNs : Nat64,
        ) : async* Types.DispatchResultV1 {
            await* call(prepared, nowNs);
        };

        // Read-only inspection hooks keep request construction and hostile
        // reply interpretation testable without exposing the capability.
        public func exactRequest(
            prepared : Types.PreparedDispatchV1,
        ) : ?Types.BackendCallRequestV1 {
            if (not validPrepared(prepared)) return null;
            ?callRequest(prepared);
        };

        public func interpret(
            prepared : Types.PreparedDispatchV1,
            result : Types.BackendCallResultV1,
        ) : Types.DispatchResultV1 {
            if (not validPrepared(prepared)) return Policy.invalidPrepared();
            decodeResult(prepared, result);
        };

        public func callBatch(
            prepared : [Types.PreparedDispatchV1],
            nowNs : Nat64,
        ) : async* Types.BatchDispatchResultV1 {
            if (prepared.size() == 0) return #err(#empty);
            if (prepared.size() > Types.MAX_BATCH_CALLS) {
                return #err(#too_large);
            };
            for (entry in prepared.values()) {
                if (not validPrepared(entry)) {
                    return #err(#invalid_prepared_call);
                };
            };

            let slots = VarArray.repeat<?Types.DispatchResultV1>(
                null,
                prepared.size(),
            );
            let requests = List.empty<Types.BackendCallRequestV1>();
            let requestIndexes = List.empty<Nat>();
            var index = 0;
            for (entry in prepared.values()) {
                if (retryExpired(entry, nowNs)) {
                    slots[index] := ?Policy.expired();
                } else if (
                    not backendCalls.can_call(
                        entry.target,
                        Types.PHYSICAL_METHOD,
                    )
                ) {
                    slots[index] := ?Policy.backendError({
                        code = "not_reserved";
                        message =
                            "The exact Wagyu dispatcher reservation is unavailable";
                    });
                } else {
                    List.add(requests, callRequest(entry));
                    List.add(requestIndexes, index);
                };
                index += 1;
            };

            let outbound = List.toArray(requests);
            if (outbound.size() > 0) {
                let brokerResults = try {
                    await* backendCalls.call_batch(outbound);
                } catch (error) {
                    let uncertain = Policy.malformedReply(
                        "backend_batch_trap",
                        Error.message(error),
                    );
                    for (slot in List.values(requestIndexes)) {
                        slots[slot] := ?uncertain;
                    };
                    return #ok(finishSlots(slots));
                };
                if (brokerResults.size() != outbound.size()) {
                    let uncertain = Policy.malformedReply(
                        "backend_batch_shape",
                        "The backend broker returned the wrong number of results",
                    );
                    for (slot in List.values(requestIndexes)) {
                        slots[slot] := ?uncertain;
                    };
                } else {
                    let indexes = List.toArray(requestIndexes);
                    var resultIndex = 0;
                    while (resultIndex < brokerResults.size()) {
                        let preparedIndex = indexes[resultIndex];
                        slots[preparedIndex] := ?decodeResult(
                            prepared[preparedIndex],
                            brokerResults[resultIndex],
                        );
                        resultIndex += 1;
                    };
                };
            };
            #ok(finishSlots(slots));
        };

        public func validPrepared(
            prepared : Types.PreparedDispatchV1,
        ) : Bool {
            let ?route = Bounds.route(prepared.route) else return false;
            if (
                prepared.operation_id.size() != Bounds.OPERATION_ID_BYTES or
                Principal.equal(prepared.target, localCanister) or
                prepared.cycles != route.required_cycles or
                prepared.maximum_response_bytes != route.max_response_bytes or
                prepared.exact_ingress_candid.size() > route.max_request_bytes or
                prepared.exact_call_args.size() > MAX_BACKEND_ARGUMENT_BYTES or
                not Blob.equal(
                    prepared.payload_digest,
                    Hash.payloadDigest(prepared.exact_body_candid),
                )
            ) return false;

            // Validate the durable envelope and physical args without ever
            // replacing them. This catches corrupted/restored state while the
            // transmitted retry remains byte-for-byte the stored call.
            let ?rebuilt = ProtocolWire.prepare(
                prepared.route,
                prepared.operation_id,
                prepared.exact_body_candid,
            ) else return false;
            Blob.equal(rebuilt.payload_digest, prepared.payload_digest) and
            Blob.equal(rebuilt.body_candid, prepared.exact_body_candid) and
            Blob.equal(rebuilt.ingress_candid, prepared.exact_ingress_candid) and
            Blob.equal(rebuilt.physical_args, prepared.exact_call_args);
        };

        func decodeResult(
            prepared : Types.PreparedDispatchV1,
            brokerResult : Types.BackendCallResultV1,
        ) : Types.DispatchResultV1 {
            switch (brokerResult) {
                case (#err(error)) Policy.backendError(error);
                case (#ok(exactOuterReply)) {
                    let ?outer = OuterWire.decode(
                        exactOuterReply,
                        prepared.maximum_response_bytes,
                    ) else {
                        return Policy.malformedReply(
                            "public_ingress_reply_invalid",
                            "The peer returned an invalid public-ingress result",
                        );
                    };
                    switch (outer) {
                        case (#err(error)) Policy.publicIngressError(error);
                        case (#ok(exactRouteResult)) {
                            let ?routeResult = ProtocolWire.decodeRouteResult(
                                exactRouteResult,
                                prepared.maximum_response_bytes,
                            ) else {
                                return Policy.malformedReply(
                                    "wagyu_route_reply_invalid",
                                    "The peer returned an invalid Wagyu route result",
                                );
                            };
                            Policy.semanticForRoute(
                                prepared.route,
                                routeResult,
                                exactRouteResult,
                            );
                        };
                    };
                };
            };
        };
    };

    public func exactRetryMatches(
        original : Types.PreparedDispatchV1,
        candidate : Types.PreparedDispatchV1,
    ) : Bool {
        Principal.equal(original.target, candidate.target) and
        original.route == candidate.route and
        Blob.equal(original.operation_id, candidate.operation_id) and
        Blob.equal(original.payload_digest, candidate.payload_digest) and
        Blob.equal(original.exact_body_candid, candidate.exact_body_candid) and
        Blob.equal(
            original.exact_ingress_candid,
            candidate.exact_ingress_candid,
        ) and
        Blob.equal(original.exact_call_args, candidate.exact_call_args) and
        original.cycles == candidate.cycles and
        original.maximum_response_bytes == candidate.maximum_response_bytes and
        original.created_at_ns == candidate.created_at_ns;
    };

    public func retryExpired(
        prepared : Types.PreparedDispatchV1,
        nowNs : Nat64,
    ) : Bool {
        nowNs > prepared.created_at_ns and
        nowNs - prepared.created_at_ns > Types.RETRY_HORIZON_NS;
    };

    func callRequest(
        prepared : Types.PreparedDispatchV1,
    ) : Types.BackendCallRequestV1 {
        {
            canister = prepared.target;
            method = Types.PHYSICAL_METHOD;
            args = prepared.exact_call_args;
            cycles = prepared.cycles;
        };
    };

    func finishSlots(
        slots : [var ?Types.DispatchResultV1],
    ) : [Types.DispatchResultV1] {
        Array.tabulate<Types.DispatchResultV1>(slots.size(), func(index) {
            switch (slots[index]) {
                case (?result) result;
                case null Policy.malformedReply(
                    "backend_batch_shape",
                    "The backend broker result slot is missing",
                );
            };
        });
    };
};
