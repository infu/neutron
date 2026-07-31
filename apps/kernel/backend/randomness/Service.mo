import Map "mo:core/Map";
import Set "mo:core/Set";
import Text "mo:core/Text";
import AppUsageTypes "../app_usage/Types";
import Scope "../capabilities/Scope";
import CapabilityTypes "../capabilities/Types";
import Types "Types";

module {
    public let ENTROPY_BYTES : Nat = 32;
    public let MAX_IN_FLIGHT : Nat = 4;
    public let MIN_REMAINING_CYCLES : Nat = 250_000_000_000;

    public class Service(
        adapter : Types.Adapter,
        scopeActive : CapabilityTypes.AppScope -> Bool,
        registry : CapabilityTypes.RuntimeRegistry,
        outgoingCycles : AppUsageTypes.OutgoingCycleAccounting,
    ) {
        let declarations = Map.empty<Text, Types.Declaration>();
        let inFlight = Set.empty<Text>();
        var configured = false;

        public func configure(apps : [Types.AppDeclaration]) : () {
            assert (not configured);
            for (app in apps.vals()) {
                assert (
                    Scope.valid(app.app_scope)
                );
                let ?declaration = app.randomness else continue;
                let key = Scope.key(app.app_scope);
                assert (not Map.containsKey(declarations, Text.compare, key));
                Map.add(declarations, Text.compare, key, declaration);
            };
            configured := true;
        };

        public func capability(
            appScope : CapabilityTypes.AppScope,
        ) : Types.Capability {
            assert (configured and declarationFor(appScope) != null);
            {
                fresh_bytes = func() : async* Types.Result {
                    await* freshBytes(appScope);
                };
            };
        };

        public func freshBytes(
            appScope : CapabilityTypes.AppScope,
        ) : async* Types.Result {
            let result = await* freshBytesInner(appScope);
            ignore registry.record(
                appScope,
                #randomness,
                "default",
                "fresh_bytes",
                outcome(result),
            );
            result;
        };

        func freshBytesInner(
            appScope : CapabilityTypes.AppScope,
        ) : async* Types.Result {
            if (not scopeActive(appScope)) return #err(#source_gone);
            let ?_declaration = declarationFor(appScope) else {
                return #err(#source_gone);
            };
            let ?lease = registry.lease(
                appScope,
                #randomness,
                "default",
            ) else {
                return #err(#source_gone);
            };
            if (adapter.cycle_balance() < MIN_REMAINING_CYCLES) {
                return #err(#low_cycles);
            };

            let key = Scope.key(appScope);
            if (
                Set.size(inFlight) >= MAX_IN_FLIGHT or
                Set.contains(inFlight, Text.compare, key)
            ) return #err(#busy);

            let ?reservation = outgoingCycles.reserve(
                appScope,
                0,
                null,
                1,
            ) else return #err(#source_gone);
            let future = try {
                adapter.random();
            } catch (_) {
                // Producing a management-call future can fail with #call_error
                // before the call is enqueued. Nothing dispatched, so release
                // the complete reservation instead of charging a call base.
                outgoingCycles.cancel(reservation);
                return #err(#management_failure);
            };
            assert (Set.insert(inFlight, Text.compare, key));
            assert (outgoingCycles.commit(reservation));
            let result : Types.AdapterResult = try {
                await future;
            } catch (_) {
                // After commit the call may have dispatched. Keep the base
                // conservatively even when its reply is unobservable.
                #err;
            };
            outgoingCycles.finalize(reservation, 0);
            Set.remove(inFlight, Text.compare, key);

            // Installation and declaration authority are live facts. Never
            // return paid entropy to a scope that disappeared during await.
            if (
                not scopeActive(appScope) or
                declarationFor(appScope) == null or
                not lease.active()
            ) return #err(#source_gone);

            switch (result) {
                case (#ok(entropy)) {
                    if (entropy.size() != ENTROPY_BYTES) {
                        #err(#management_failure);
                    } else {
                        #ok(entropy);
                    };
                };
                case (#err) #err(#management_failure);
            };
        };

        func outcome(result : Types.Result) : CapabilityTypes.CapabilityOutcome {
            switch (result) {
                case (#ok(_)) #ok;
                case (#err(#busy)) #busy;
                case (#err(#source_gone)) #revoked;
                case (#err(_)) #failed;
            };
        };

        func declarationFor(
            appScope : CapabilityTypes.AppScope,
        ) : ?Types.Declaration {
            if (not configured) return null;
            Map.get(declarations, Text.compare, Scope.key(appScope));
        };

    };
};
