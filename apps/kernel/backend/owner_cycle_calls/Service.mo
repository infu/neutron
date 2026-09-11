import Blob "mo:core/Blob";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Backend "../backend_calls/Service";
import BackendTypes "../backend_calls/Types";
import Scope "../capabilities/Scope";
import Memory "../memory/kernel_cycle_calls/v1";
import Types "Types";

module {
    func sameRequest(left : Types.Request, right : Types.Request) : Bool {
        left.id == right.id and left.app_scope == right.app_scope and
        left.call == right.call and left.allow_partial == right.allow_partial;
    };

    public class Service(
        mem : Memory.Mem,
        broker : Backend.Service,
        scopeActive : Memory.AppScope -> Bool,
        authorized : Principal -> Bool,
        selfPrincipal : Principal,
        nowNanos : () -> Nat64,
    ) {
        func requestError(request : Types.Request) : ?Types.Error {
            if (request.id.size() != 16) return ?{ code = "invalid_id"; message = "A one-time cycle call requires a 16-byte request ID" };
            if (not scopeActive(request.app_scope)) return ?{ code = "capability_revoked"; message = "The requesting app installation is no longer active" };
            null;
        };

        public func quote(request : Types.Request) : Types.QuoteResult {
            switch (requestError(request)) { case (?error) return #err(error); case null {} };
            broker.ownerCallQuote(request.app_scope, selfPrincipal, request.call, request.allow_partial);
        };

        public func status(input : Types.StatusInput) : ?Types.Receipt {
            if (not scopeActive(input.app_scope)) return null;
            let ?scope = Map.get(mem.by_scope, Text.compare, Scope.key(input.app_scope)) else return null;
            Map.get(scope.by_id, Blob.compare, input.id);
        };

        public func list(input : Types.ListInput) : Types.Page {
            if (not scopeActive(input.app_scope) or input.limit == 0) return { calls = []; next_before = null };
            let ?scope = Map.get(mem.by_scope, Text.compare, Scope.key(input.app_scope)) else return { calls = []; next_before = null };
            let rows = switch (input.before) {
                case null Map.reverseEntries(scope.by_sequence);
                case (?before) Map.reverseEntriesFrom(scope.by_sequence, Nat.compare, before);
            };
            let calls = List.empty<Types.Summary>();
            var next : ?Nat = null;
            var last : ?Nat = null;
            label page for ((sequence, id) in rows) {
                switch (input.before) { case (?before) { if (sequence >= before) continue page }; case null {} };
                if (List.size(calls) == input.limit) { next := last; break page };
                let ?receipt = Map.get(scope.by_id, Blob.compare, id) else continue page;
                List.add(calls, summary(receipt));
                last := ?sequence;
            };
            { calls = List.toArray(calls); next_before = next };
        };

        public func execute(request : Types.Request, caller : Principal) : async* Types.Result {
            if (Principal.isAnonymous(caller) or caller == selfPrincipal or not authorized(caller)) {
                return #err({ code = "unauthorized"; message = "This cycle transfer requires explicit Neutron owner approval" });
            };
            switch (requestError(request)) { case (?error) return #err(error); case null {} };
            let key = Scope.key(request.app_scope);
            let scope = switch (Map.get(mem.by_scope, Text.compare, key)) {
                case (?value) value;
                case null {
                    let value : Memory.ScopeReceipts = { by_id = Map.empty<Blob, Types.Receipt>(); by_sequence = Map.empty<Nat, Blob>() };
                    Map.add(mem.by_scope, Text.compare, key, value);
                    value;
                };
            };
            switch (Map.get(scope.by_id, Blob.compare, request.id)) {
                case (?saved) {
                    if (not sameRequest(saved.request, request)) return #err({ code = "request_conflict"; message = "This request ID already belongs to a different cycle transfer" });
                    // A deposit-like update need not implement remote dedup.
                    // Repeated calls return even an unresolved retained receipt.
                    return #ok(saved);
                };
                case null {};
            };
            let created = nowNanos();
            var receipt : Types.Receipt = {
                request; sequence = mem.next_sequence; created_at = created;
                updated_at = created; dispatched = false; actual_cycles = 0;
                result = null; charged_cycles = null;
            };
            mem.next_sequence += 1;
            Map.add(scope.by_id, Blob.compare, request.id, receipt);
            Map.add(scope.by_sequence, Nat.compare, receipt.sequence, request.id);
            func save(next : Types.Receipt) : () {
                receipt := next;
                Map.add(scope.by_id, Blob.compare, request.id, next);
            };
            let result = await* broker.ownerCall(
                request.app_scope, selfPrincipal, request.call, request.allow_partial,
                {
                    before_dispatch = func(actual : BackendTypes.CallRequest, _callCost : Nat) : () {
                        save({ receipt with dispatched = true; actual_cycles = actual.cycles; updated_at = nowNanos() });
                    };
                    settled = func(original : BackendTypes.CallResult, charged : Nat) : () {
                        // Persist before delivery checks: a later revocation or
                        // closed browser must not erase a successful response.
                        save({ receipt with result = ?original; charged_cycles = ?charged; updated_at = nowNanos() });
                    };
                },
            );
            if (not receipt.dispatched) {
                save({ receipt with result = ?result; charged_cycles = ?0; updated_at = nowNanos() });
            };
            if (not authorized(caller)) return #err({ code = "revoked_after_dispatch"; message = "Owner access changed while this request was in progress. Its original receipt is retained; do not submit another transfer." });
            switch (result) {
                case (#err(error)) {
                    if (error.code == "revoked_after_dispatch") return #err(error);
                };
                case (_) {};
            };
            #ok(receipt);
        };
    };

    func summary(receipt : Types.Receipt) : Types.Summary {
        {
            id = receipt.request.id; sequence = receipt.sequence;
            canister = receipt.request.call.canister; method = receipt.request.call.method;
            requested_cycles = receipt.request.call.cycles; actual_cycles = receipt.actual_cycles;
            allow_partial = receipt.request.allow_partial;
            created_at = receipt.created_at; updated_at = receipt.updated_at;
            dispatched = receipt.dispatched; settled = receipt.result != null;
            charged_cycles = receipt.charged_cycles;
            error = switch (receipt.result) { case (?#err(error)) ?error; case (_) null };
        };
    };
};
