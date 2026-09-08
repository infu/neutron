// Saved swap plans bind Wallet funding and the exact pool call to one intent.
// ICPSwap has no caller idempotency key, so every dispatch is retained before
// awaiting the pool and is never replayed after an uncertain reply.
import Error "mo:core/Error";
import Principal "mo:core/Principal";
import Capabilities "mo:neutron-capabilities";
import Actions "./Actions";
import Client "./Client";
import Market "./Market";
import Swap "./Swap";
import ProtocolReply "./ProtocolReply";

module {
    public type Result<T> = { #ok : T; #err : Text };
    public type Request = {
        request_id : Text; input_address : Text; output_address : Text;
        amount_in : Nat; slippage : Nat;
    };
    // Structurally equal to the established app quote wire contract.
    public type Quote = {
        pool : Text; pool_key : Text; fee_tier : Nat;
        input_address : Text; output_address : Text; decimals_in : Nat; decimals_out : Nat;
        zero_for_one : Bool; amount_in : Nat; quoted_out : Nat; amount_out_minimum : Nat;
        expected_out : Nat; token_in_fee : Nat; token_out_fee : Nat;
        funding_amount : Nat; total_debit : Nat; price_impact : Float; warn : Bool;
        slippage : Nat; funding_ledger : Text; funding_spender : Text; at : Int;
    };
    public type Receipt = {
        request_id : Text; state : Text; pool : Text; input_address : Text; output_address : Text;
        amount_in : Nat; amount_out_minimum : Nat; swapped_out : Nat; received_out : Nat;
        detail : Text; needs_funding : Bool; funding_ledger : Text; funding_spender : Text;
        funding_amount : Nat; at : Int;
    };
    public type PrepareRequest = { id : Text; input_json : Text; request : Request };
    public type ExecuteRequest = { id : Text; expected_revision : Nat };
    public type Prepared = { operation : Actions.Operation; plan : Quote; receipt : ?Receipt };
    type SavedPlan = { kind : Text; request : Request; quote : Quote };

    public func sameRequest(a : Request, b : Request) : Bool =
        a.request_id == b.request_id and Market.lower(a.input_address) == Market.lower(b.input_address) and
        Market.lower(a.output_address) == Market.lower(b.output_address) and a.amount_in == b.amount_in and
        Swap.normalizeSlippage(?a.slippage) == Swap.normalizeSlippage(?b.slippage);

    public class Service(
        calls : Capabilities.BackendCallsV1,
        journal : Actions.Journal,
        quote : (Request) -> async* Result<Quote>,
        now : () -> Int,
    ) {
        func savedPlan(id : Text) : ?SavedPlan {
            let saved = switch (journal.raw(id)) { case null return null; case (?v) v };
            let decoded : ?SavedPlan = from_candid(saved.plan_blob);
            switch (decoded) { case (?plan) { if (plan.kind == "icpswap_swap_v1") ?plan else null }; case null null };
        };
        public func status(id : Text) : ?Prepared {
            let saved = switch (journal.raw(id)) { case null return null; case (?v) v };
            let plan = switch (savedPlan(id)) { case null return null; case (?v) v };
            let operation = Actions.view(saved);
            var receipt : ?Receipt = null;
            for (effect in operation.effects.vals()) {
                if (effect.key == "swap") {
                    let gross = switch (effect.result_nat) { case null 0; case (?v) v };
                    receipt := ?{
                        request_id = plan.request.request_id; state = operation.state; pool = plan.quote.pool;
                        input_address = plan.quote.input_address; output_address = plan.quote.output_address;
                        amount_in = plan.quote.amount_in; amount_out_minimum = plan.quote.amount_out_minimum;
                        swapped_out = gross;
                        // The pool's reply only schedules the outgoing transfer.
                        // No ledger observation in this method proves receipt.
                        received_out = 0; detail = operation.detail; needs_funding = false;
                        funding_ledger = plan.quote.funding_ledger; funding_spender = plan.quote.funding_spender;
                        funding_amount = plan.quote.funding_amount;
                        // Existing swap quote/receipt timestamps use seconds;
                        // the generic operation journal stores nanoseconds.
                        at = operation.updated_at / 1_000_000_000;
                    };
                };
            };
            ?{ operation; plan = plan.quote; receipt };
        };
        func existing(request : PrepareRequest) : Result<?Prepared> {
            switch (journal.raw(request.id)) {
                case null #ok(null);
                case (?record) {
                    let plan = switch (savedPlan(request.id)) {
                        case null return #err("This operation ID belongs to another saved operation type.");
                        case (?v) v;
                    };
                    if (record.input_json != request.input_json or not sameRequest(plan.request, request.request)) {
                        return #err("This operation ID already belongs to a different swap intent.");
                    };
                    #ok(status(request.id));
                };
            };
        };
        public func prepare(request : PrepareRequest) : async* Result<Prepared> {
            if (request.id == "" or request.request.request_id == "") return #err("A retained operation ID is required.");
            if (request.id != request.request.request_id) return #err("The swap request ID must match the retained operation ID.");
            switch (existing(request)) { case (#err(e)) return #err(e); case (#ok(?v)) return #ok(v); case (#ok(null)) {} };
            let plan = switch (await* quote(request.request)) { case (#err(e)) return #err(e); case (#ok(v)) v };
            // An overlapping prepare can have finished while this one queried.
            // Reuse its saved minimum instead of replacing it with a new quote.
            switch (existing(request)) { case (#err(e)) return #err(e); case (#ok(?v)) return #ok(v); case (#ok(null)) {} };
            if (Market.lower(request.request.input_address) != plan.input_address or
                Market.lower(request.request.output_address) != plan.output_address or
                request.request.amount_in != plan.amount_in or
                Swap.normalizeSlippage(?request.request.slippage) != plan.slippage or
                plan.funding_ledger != plan.input_address or plan.funding_spender != plan.pool or
                plan.funding_amount != plan.amount_in or plan.amount_out_minimum == 0) {
                return #err("The server quote does not match the requested swap and its funding route.");
            };
            let operation = switch (journal.beginTyped({ id = request.id; input_json = request.input_json;
                plan_json = ""; funding_json = "" }, to_candid({ kind = "icpswap_swap_v1"; request = request.request; quote = plan } : SavedPlan))) {
                case (#err(e)) return #err(e); case (#ok(v)) v;
            };
            #ok({ operation; plan; receipt = null });
        };
        func mark(id : Text, state : Text, detail : Text) {
            // Wallet funding receipts remain available after the protocol step.
            let fundingResult = switch (journal.raw(id)) { case null ""; case (?v) v.result_json };
            ignore journal.mark(id, state, detail, fundingResult);
        };
        func current(id : Text) : Result<Prepared> {
            switch (status(id)) { case null #err("The retained swap operation is unavailable."); case (?v) #ok(v) };
        };
        public func execute(request : ExecuteRequest) : async* Result<Prepared> {
            let saved = switch (status(request.id)) { case null return #err("Unknown swap operation ID."); case (?v) v };
            // A stale continuation still returns the authoritative outcome once
            // an effect exists. It cannot create another pool transfer.
            if (saved.operation.effects.size() > 0) return #ok(saved);
            if (saved.operation.state == "stopped") return #ok(saved);
            if (saved.operation.revision != request.expected_revision) return #err("Operation revision changed; read the saved swap before continuing.");
            if (saved.operation.state != "funded") return #err("Complete or reconcile the exact saved Wallet funding request before executing this swap.");
            let plan = saved.plan;
            let call = Client.depositFromAndSwapRequest(Principal.fromText(plan.pool), plan.zero_for_one,
                plan.amount_in, plan.amount_out_minimum, plan.token_in_fee, plan.token_out_fee);
            switch (journal.dispatch(request.id, saved.operation.revision, "swap", call)) {
                case (#err(e)) return #err(e); case (#ok(_)) {};
            };
            let response : Client.CallResult = try {
                let replies = await* calls.call_batch([call]);
                if (replies.size() != 1) {
                    ignore journal.finish(request.id, "swap", "uncertain", null, "The pool reply was absent or malformed. The retained request will not be repeated.");
                    return current(request.id);
                };
                replies[0];
            } catch (error) {
                ignore journal.finish(request.id, "swap", "uncertain", null,
                    "The pool call was interrupted: " # Error.message(error) # ". Its effect is unknown; keep this operation ID.");
                return current(request.id);
            };
            let bytes = switch (response) {
                case (#err(error)) {
                    ignore journal.finish(request.id, "swap", "uncertain", null,
                        "The call broker did not confirm the pool outcome: " # error.code # ": " # error.message # ". Do not repeat the swap.");
                    return current(request.id);
                };
                case (#ok(value)) value;
            };
            switch (ProtocolReply.decodeNat(bytes)) {
                case (#unknown(message)) {
                    ignore journal.finish(request.id, "swap", "uncertain", ?bytes,
                        "The pool reply could not be decoded: " # message # ". Its exact bytes are retained; the swap will not be repeated.");
                };
                case (#ok(_)) {
                    ignore journal.finish(request.id, "swap", "succeeded", ?bytes, "");
                    mark(request.id, "settlement_pending", "The swap succeeded and ICPSwap scheduled the output transfer. Wallet receipt is not yet confirmed; closing this app does not cancel protocol settlement.");
                };
                case (#rejected(message)) {
                    let kind = Swap.classifyFailure(message);
                    let uncertain = kind == #ambiguous;
                    ignore journal.finish(request.id, "swap", if (uncertain) "uncertain" else "failed", ?bytes, message);
                    mark(request.id, if (uncertain) "uncertain" else "stopped", message #
                        (if (uncertain) ". Input transfer or refund settlement may still be unresolved. Inspect this pool's unused balance, transactions and withdrawal queue; do not repeat the operation."
                         else ". The pool rejected this request before a confirmed input transfer. Retain its funding receipt and review any remaining Wallet allowance before preparing a new intent."));
                };
            };
            current(request.id);
        };
    };
};
