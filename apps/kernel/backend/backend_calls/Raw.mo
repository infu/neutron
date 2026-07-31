import Cycles "mo:core/Cycles";
import Error "mo:core/Error";
import IC "mo:core/InternetComputer";
import Nat64 "mo:core/Nat64";
import Prim "mo:prim";
import Types "Types";

module {
    // This is the only raw transport available to assembled app backends. Each
    // invocation owns its await context, so `Cycles.refunded()` always belongs
    // to the matching request even when Service dispatches a parallel batch.
    // Deliberately omit best-effort timeout syntax: V1 uses unbounded calls.
    public func transport() : Types.Transport {
        {
            cycle_balance = Cycles.balance;
            call_cost = func(method : Text, argumentBytes : Nat) : Nat {
                Prim.costCall(
                    Nat64.fromNat(method.size()),
                    Nat64.fromNat(argumentBytes),
                );
            };
            call = func(request : Types.CallRequest) : async Types.TransportResult {
                try {
                    let reply = await (with cycles = request.cycles) IC.call(
                        request.canister,
                        request.method,
                        request.args,
                    );
                    #ok({
                        reply;
                        charged_cycles = charged(request.cycles);
                    });
                } catch (cause) {
                    #err({
                        message = Error.message(cause);
                        charged_cycles = charged(request.cycles);
                    });
                };
            };
        };
    };

    func charged(attached : Nat) : Nat {
        let refunded = Cycles.refunded();
        if (refunded >= attached) 0 else attached - refunded;
    };
};
