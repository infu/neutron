// The durable intent and dispatch boundary is app-local. Protocol methods lack
// caller idempotency keys: a retained dispatched effect is never sent again.
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Int "mo:core/Int";
import List "mo:core/List";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Memory "../memory/icpswap_actions/v1";
import Client "./Client";
import ProtocolReply "./ProtocolReply";
module {
    public type Result<T> = { #ok : T; #err : Text };
    public type EffectView = {
        key : Text; canister : Text; method : Text; state : Text;
        error : Text; dispatched_at : Int; completed_at : ?Int;
        result_nat : ?Nat; result_amount0 : ?Nat; result_amount1 : ?Nat;
    };
    public type Operation = {
        id : Text; input_json : Text; plan_json : Text; funding_json : Text;
        state : Text; detail : Text; result_json : Text; revision : Nat;
        created_at : Int; updated_at : Int; effects : [EffectView];
    };
    // History pages do not include saved funding receipts, plans or raw protocol
    // results. Those remain available through get(id) for recovery and review.
    public type EffectSummary = {
        key : Text; canister : Text; method : Text; state : Text;
        error : Text; dispatched_at : Int; completed_at : ?Int;
    };
    public type Summary = {
        id : Text; input_json : Text; state : Text; detail : Text; revision : Nat;
        created_at : Int; updated_at : Int; effects : [EffectSummary];
    };
    public type PageRequest = { cursor : ?Text; limit : Nat };
    public type Page = { items : [Summary]; next_cursor : ?Text };
    public type BeginRequest = {
        id : Text; input_json : Text; plan_json : Text; funding_json : Text;
    };
    public type UpdateRequest = {
        id : Text; expected_revision : Nat; state : Text; detail : Text;
        result_json : Text; funding_json : Text;
    };
    public func view(value : Memory.Operation) : Operation = {
        id = value.id; input_json = value.input_json; plan_json = value.plan_json;
        funding_json = value.funding_json; state = value.state; detail = value.detail;
        result_json = value.result_json; revision = value.revision;
        created_at = value.created_at; updated_at = value.updated_at;
        effects = Array.map<Memory.Effect, EffectView>(value.effects, func(effect) {
            let (resultNat, result0, result1) = switch (effect.reply) {
                case null (null, null, null);
                case (?bytes) {
                    let scalar = ProtocolReply.decodeNat(bytes);
                    let pair = ProtocolReply.decodeAmounts(bytes);
                    let n = switch (scalar) { case (#ok(v)) ?v; case (_) null };
                    switch (pair) { case (#ok(v)) (n, ?v.amount0, ?v.amount1); case (_) (n, null, null) };
                };
            };
            { key = effect.key; canister = Principal.toText(effect.canister);
              method = effect.method; state = effect.state; error = effect.error;
              dispatched_at = effect.dispatched_at; completed_at = effect.completed_at;
              result_nat = resultNat; result_amount0 = result0; result_amount1 = result1 }
        });
    };
    public func summary(value : Memory.Operation) : Summary = {
        id = value.id; input_json = value.input_json; state = value.state; detail = value.detail;
        revision = value.revision; created_at = value.created_at; updated_at = value.updated_at;
        effects = Array.map<Memory.Effect, EffectSummary>(value.effects, func(effect) {
            { key = effect.key; canister = Principal.toText(effect.canister);
              method = effect.method; state = effect.state; error = effect.error;
              dispatched_at = effect.dispatched_at; completed_at = effect.completed_at }
        });
    };
    public class Journal(mem : Memory.Mem, now : () -> Int, legacyExists : Text -> Bool) {
        public func raw(id : Text) : ?Memory.Operation = Map.get(mem.operations, Text.compare, id);
        public func get(id : Text) : ?Operation {
            switch (raw(id)) { case null null; case (?value) ?view(value) };
        };
        public func list() : [Operation] = Array.map<Memory.Operation, Operation>(
            Array.fromIter(Map.values(mem.operations)), view,
        );
        public func page(request : PageRequest) : Result<Page> {
            if (request.limit == 0) return #err("History page size must be positive.");
            let anchor = switch (request.cursor) {
                case null null;
                case (?id) {
                    let ?saved = raw(id) else return #err("History cursor was not found; refresh the first page.");
                    ?saved;
                };
            };
            // Created time and ID never change when an operation progresses.
            // Updates and newer insertions therefore cannot shift older pages.
            func compare(a : Memory.Operation, b : Memory.Operation) : { #less; #equal; #greater } {
                switch (Int.compare(b.created_at, a.created_at)) {
                    case (#equal) Text.compare(a.id, b.id);
                    case other other;
                };
            };
            let items = List.empty<Summary>();
            var last : ?Text = null;
            var more = false;
            label scan for (saved in Array.sort<Memory.Operation>(Array.fromIter(Map.values(mem.operations)), compare).vals()) {
                let after = switch (anchor) { case null true; case (?prior) compare(saved, prior) == #greater };
                if (after) {
                    if (List.size(items) == request.limit) { more := true; break scan };
                    List.add(items, summary(saved));
                    last := ?saved.id;
                };
            };
            #ok({ items = List.toArray(items); next_cursor = if (more) last else null });
        };
        func save(value : Memory.Operation) : Operation {
            ignore Map.insert(mem.operations, Text.compare, value.id, value);
            view(value);
        };
        public func beginTyped(request : BeginRequest, planBlob : Blob) : Result<Operation> {
            if (request.id == "") return #err("An operation ID is required.");
            if (legacyExists(request.id)) return #err("This ID belongs to a retained legacy swap. Read its legacy swap history and recovery evidence; do not create a duplicate intent.");
            switch (raw(request.id)) {
                case (?prior) {
                    if (prior.input_json != request.input_json or prior.plan_json != request.plan_json or
                        not Blob.equal(prior.plan_blob, planBlob)) {
                        return #err("This operation ID already belongs to a different saved intent or plan.");
                    };
                    return #ok(view(prior));
                };
                case null {};
            };
            let at = now();
            #ok(save({ id = request.id; input_json = request.input_json; plan_json = request.plan_json;
                plan_blob = planBlob; funding_json = request.funding_json; state = "prepared";
                detail = "Prepared; no protocol effect has been dispatched."; result_json = "";
                revision = 0; created_at = at; updated_at = at; effects = [] }));
        };
        public func begin(request : BeginRequest) : Result<Operation> = beginTyped(request, Blob.fromArray([]));
        public func update(request : UpdateRequest) : Result<Operation> {
            let prior = switch (raw(request.id)) { case null return #err("Unknown operation ID."); case (?v) v };
            if (prior.revision != request.expected_revision) return #err("Operation revision changed; read the saved operation before continuing.");
            let beforeFunding = prior.state == "prepared" and prior.effects.size() == 0;
            if (request.funding_json != prior.funding_json and not beforeFunding) {
                return #err("Funding bytes cannot change after a funding request may have been sent.");
            };
            let allowed =
                (prior.state == "prepared" and (request.state == "prepared" or request.state == "funding_requested" or request.state == "funded" or request.state == "stopped")) or
                (prior.state == "funding_requested" and (request.state == "funding_requested" or request.state == "funded")) or
                (prior.state == "funded" and request.state == "funded");
            if (not allowed) return #err("This state is owned by protocol execution; reconcile the retained operation.");
            #ok(save({ prior with funding_json = request.funding_json; state = request.state;
                detail = request.detail; result_json = request.result_json;
                revision = prior.revision + 1; updated_at = now() }));
        };
        // Internal methods are not app wire methods. Callers construct requests
        // from their validated, retained typed plan, never raw frontend calls.
        public func dispatch(id : Text, expectedRevision : Nat, key : Text, request : Client.CallRequest) : Result<Operation> {
            let prior = switch (raw(id)) { case null return #err("Unknown operation ID."); case (?v) v };
            if (prior.revision != expectedRevision) return #err("Operation revision changed; read it before continuing.");
            for (effect in prior.effects.vals()) {
                if (effect.key == key) return #err("This protocol effect was already requested. Its result must be reconciled; it will not be replayed.");
                if (effect.state == "requested" or effect.state == "uncertain") return #err("A previous protocol effect remains uncertain and must not be replayed.");
                if (effect.state == "failed") return #err("A previous protocol effect failed. Retain this operation and inspect unused funds.");
                if (effect.state == "recovery_reserved" or effect.state == "recovered") return #err("This intent's direct-funded deposit belongs to a saved recovery operation.");
            };
            if (prior.state != "prepared" and prior.state != "funded" and prior.state != "execution_requested") {
                return #err("This operation cannot dispatch another protocol effect in its current state.");
            };
            let effect : Memory.Effect = { key; canister = request.canister; method = request.method;
                args = request.args; state = "requested"; reply = null; error = "";
                dispatched_at = now(); completed_at = null };
            #ok(save({ prior with effects = Array.concat(prior.effects, [effect]);
                state = "execution_requested"; detail = "Protocol request saved before dispatch; do not repeat it if its reply is lost.";
                revision = prior.revision + 1; updated_at = now() }));
        };
        public func finish(id : Text, key : Text, state : Text, reply : ?Blob, error : Text) : Result<Operation> {
            let prior = switch (raw(id)) { case null return #err("Unknown operation ID."); case (?v) v };
            var found = false;
            let effects = Array.map<Memory.Effect, Memory.Effect>(prior.effects, func(effect) {
                if (effect.key != key or effect.state != "requested") return effect;
                found := true;
                { effect with state; reply; error; completed_at = ?now() };
            });
            if (not found) return #err("The retained dispatch is absent or already resolved.");
            var hasUnknown = false;
            var hasRecovery = false;
            var hasRecovered = false;
            for (effect in effects.vals()) {
                if (effect.state == "uncertain") hasUnknown := true;
                if (effect.state == "recovery_reserved") hasRecovery := true;
                if (effect.state == "recovered") hasRecovered := true;
            };
            let nextState = if (hasUnknown) "uncertain" else if (state == "failed" or hasRecovered) "stopped"
                else if (hasRecovery) "recovery_requested" else "execution_requested";
            #ok(save({ prior with effects; state = nextState;
                detail = if (error == "" and (hasRecovery or hasRecovered)) prior.detail else error;
                revision = prior.revision + 1; updated_at = now() }));
        };
        public func mark(id : Text, state : Text, detail : Text, resultJson : Text) : Result<Operation> {
            let prior = switch (raw(id)) { case null return #err("Unknown operation ID."); case (?v) v };
            #ok(save({ prior with state; detail; result_json = if (resultJson == "") prior.result_json else resultJson;
                revision = prior.revision + 1; updated_at = now() }));
        };
        // A recovery uses a second reviewed operation, but claims the original
        // deposit key before either invocation can dispatch. This prevents a
        // second recovery ID or the original mint from drawing that subaccount.
        public func reserveRecovery(id : Text, expectedRevision : Nat, key : Text, recoveryId : Text, request : Client.CallRequest) : Result<Operation> {
            let prior = switch (raw(id)) { case null return #err("Unknown source operation ID."); case (?v) v };
            if (prior.revision != expectedRevision) return #err("Source operation changed; read it before continuing.");
            for (effect in prior.effects.vals()) {
                if (effect.key == key) {
                    if (effect.state == "recovery_reserved" and effect.error == recoveryId and effect.canister == request.canister and
                        effect.method == request.method and Blob.equal(effect.args, request.args)) return #ok(view(prior));
                    return #err("The original deposit already has a retained dispatch or recovery. It cannot be requested again.");
                };
            };
            let effect : Memory.Effect = { key; canister = request.canister; method = request.method; args = request.args;
                state = "recovery_reserved"; reply = null; error = recoveryId; dispatched_at = now(); completed_at = null };
            var unresolved = false;
            for (existing in prior.effects.vals()) { if (existing.state == "requested" or existing.state == "uncertain") unresolved := true };
            #ok(save({ prior with effects = Array.concat(prior.effects, [effect]);
                state = if (unresolved) "uncertain" else "recovery_requested";
                detail = "Direct-funded subaccount recovery is saved as operation " # recoveryId # ". The original deposit will not be sent again.";
                revision = prior.revision + 1; updated_at = now() }));
        };
        public func finishRecovery(id : Text, key : Text, recoveryId : Text, reply : ?Blob) : Result<Operation> {
            let prior = switch (raw(id)) { case null return #err("Unknown source operation ID."); case (?v) v };
            var found = false;
            let effects = Array.map<Memory.Effect, Memory.Effect>(prior.effects, func(effect) {
                if (effect.key != key or effect.state != "recovery_reserved" or effect.error != recoveryId) return effect;
                found := true;
                { effect with state = "recovered"; reply; completed_at = ?now() };
            });
            if (not found) return #err("The original deposit is not reserved by this recovery.");
            var unresolved = false;
            for (effect in effects.vals()) { if (effect.state == "requested" or effect.state == "uncertain") unresolved := true };
            #ok(save({ prior with effects; state = if (unresolved) "uncertain" else "stopped";
                detail = "The direct-funded subaccount deposit was credited to pool-unused funds by recovery " # recoveryId # ". This original liquidity intent will not continue automatically.";
                revision = prior.revision + 1; updated_at = now() }));
        };
    };
};
