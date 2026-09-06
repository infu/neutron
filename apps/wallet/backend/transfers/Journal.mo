import Array "mo:core/Array";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Time "mo:core/Time";
import Capabilities "../capabilities/Types";
import Icrc "../icrc1/Client";
import Withdrawals "../chainkey/Withdrawals";
import Memory "../memory/wallet_transfers/v1";

module {
    public func minterDispatched(command : Memory.Command) : Bool {
        for (step in command.calls.vals()) {
            if (isEffect(step.method) and not isDeduplicated(step.method)) return true;
        };
        false;
    };

    public func hasUnresolved(command : Memory.Command) : Bool {
        for (step in command.calls.vals()) {
            if (isEffect(step.method)) switch (step.outcome) {
                case (#started or #unknown(_)) return true;
                case (#reply(reply)) {
                    if (not isDeduplicated(step.method) and Withdrawals.replyNeedsReconciliation(step.method, reply)) return true;
                };
                case (_) {};
            };
        };
        false;
    };

    public func allowanceReserved(
        mem : Memory.Mem,
        ledger : Principal,
        spender : Principal,
        except : ?Blob,
    ) : Bool {
        for ((id, command) in Map.entries(mem.commands)) {
            if (except != ?id and command.status == #pending and command.minter == ?spender) {
                for (reserved in command.allowance_ledgers.vals()) {
                    if (Principal.equal(reserved, ledger)) return true;
                };
            };
        };
        false;
    };

    public func pendingNativeConflict(mem : Memory.Mem, minter : Principal, except : ?Blob) : Bool {
        for ((id, command) in Map.entries(mem.commands)) {
            if (except != ?id and command.status == #pending and command.minter == ?minter) return true;
        };
        false;
    };

    // One instance executes one pass of a saved command. The parent serializes
    // passes. An interrupted #started step has the same semantics as unknown.
    // Only ICRC's timestamp-deduplicated ledger calls may be replayed; minter
    // withdrawal protocols do not accept an idempotency key and are never retried
    // after an ambiguous outcome.
    public class Replay(command : Memory.Command, base : Capabilities.BackendCalls) {
        var index = 0;
        var unresolved = false;

        public func hasUnknown() : Bool { unresolved };
        public func dispatched() : Bool {
            for (step in command.calls.vals()) {
                if (isEffect(step.method)) return true;
            };
            false;
        };

        func fail(message : Text) : Capabilities.CallResult {
            unresolved := true;
            command.last_error := ?message;
            #err({ code = "outcome_unknown"; message });
        };

        func execute(request : Capabilities.CallRequest) : async* Capabilities.CallResult {
            let offset = index;
            index += 1;
            let existing = offset < command.calls.size();
            let step = if (existing) {
                let saved = command.calls[offset];
                if (saved.canister != request.canister or saved.method != request.method or
                    saved.args != request.args or saved.cycles != request.cycles) {
                    return fail("Saved transfer arguments differ from this execution. The original operation remains unresolved.");
                };
                saved;
            } else {
                let saved : Memory.Step = {
                    canister = request.canister;
                    method = request.method;
                    args = request.args;
                    cycles = request.cycles;
                    var outcome = #started;
                };
                command.calls := Array.concat(command.calls, [saved]);
                saved;
            };
            let prior = step.outcome;
            switch (prior) {
                case (#reply(reply)) {
                    if (isEffect(step.method) and not isDeduplicated(step.method) and
                        Withdrawals.replyNeedsReconciliation(step.method, reply)) {
                        // Preserve the reply for the protocol decoder: partial
                        // ckERC20 failures identify the already-burned ckETH
                        // block, which belongs in the owner's recovery status.
                        unresolved := true;
                    };
                    return #ok(reply);
                };
                case (#rejected(error)) return #err(error);
                case (_) {};
            };
            let replay = switch (prior) {
                case (#unknown(_)) true;
                case (#started) existing;
                case (_) false;
            };
            if (replay and isEffect(step.method) and not isDeduplicated(step.method)) {
                return fail("Withdrawal outcome is unresolved. The minter call is not repeated because it has no deduplication key.");
            };
            step.outcome := #started;
            command.updated_at := Time.now();
            // Both the frozen arguments and started outcome are committed at
            // the remote-call await, before any reply can be lost.
            let result = await* base.call(request);
            command.updated_at := Time.now();
            if (isDeduplicated(step.method)) {
                let classified = if (step.method == "icrc1_transfer") {
                    Icrc.classifyTransferResult(result);
                } else Icrc.classifyApproveResult(result);
                switch (classified) {
                    case (#ok(_)) switch (result) {
                        case (#ok(reply)) { step.outcome := #reply(reply); result };
                        case (_) { step.outcome := #unknown("Unexpected ledger result"); fail("Unexpected ledger result") };
                    };
                    case (#unknown(message)) {
                        step.outcome := #unknown(message);
                        fail(message);
                    };
                    case (#rejected(message)) {
                        if (replay) {
                            let detail = "The exact ledger retry was rejected, but the earlier outcome remains unresolved: " # message;
                            step.outcome := #unknown(detail);
                            fail(detail);
                        } else {
                            switch (result) {
                                case (#ok(reply)) step.outcome := #reply(reply);
                                case (#err(error)) step.outcome := #rejected(error);
                            };
                            result;
                        };
                    };
                };
            } else switch (result) {
                case (#ok(reply)) {
                    step.outcome := #reply(reply);
                    if (isEffect(step.method) and Withdrawals.replyNeedsReconciliation(step.method, reply)) {
                        unresolved := true;
                    };
                    result;
                };
                case (#err(error)) {
                    if (isEffect(step.method)) {
                        // Even future broker errors remain conservative here.
                        step.outcome := #unknown(error.message);
                        fail(error.message);
                    } else {
                        // Repeating a fee/price read has no monetary effect.
                        step.outcome := #unknown(error.message);
                        result;
                    };
                };
            };
        };

        public let backend_calls : Capabilities.BackendCalls = {
            canister_principal = base.canister_principal;
            can_call = base.can_call;
            call = execute;
            call_batch = func(requests : [Capabilities.CallRequest]) : async* [Capabilities.CallResult] {
                var results : [Capabilities.CallResult] = [];
                for (request in requests.vals()) {
                    results := Array.concat(results, [await* execute(request)]);
                };
                results;
            };
        };
    };

    func isDeduplicated(method : Text) : Bool {
        method == "icrc1_transfer" or method == "icrc2_approve";
    };

    func isEffect(method : Text) : Bool {
        method != "icrc1_fee" and method != "eip_1559_transaction_price" and method != "get_events";
    };
};
