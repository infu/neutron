import Array "mo:core/Array";
import Caps "mo:neutron-capabilities";
import AppUsageTypes "../app_usage/Types";
import CapabilityTypes "../capabilities/Types";
import Signing "../chain_key_signing/Service";
import SigningTypes "../chain_key_signing/Types";
import Types "Types";

module {
    // A separate app-facing leaf over the shared checked signing engine.
    // Apps never receive the engine or its authority selection.
    public class Service(
        mem : Types.Memory,
        adapter : SigningTypes.Adapter,
        canisterPrincipal : Principal,
        installEpoch : Nat64,
        scopeActive : CapabilityTypes.AppScope -> Bool,
        deploymentCommitted : () -> Bool,
        registry : CapabilityTypes.RuntimeRegistry,
        outgoingCycles : AppUsageTypes.OutgoingCycleAccounting,
        resources : Signing.Resources,
    ) {
        let engine = Signing.Engine(
            mem, adapter, canisterPrincipal, installEpoch, scopeActive,
            deploymentCommitted, registry, outgoingCycles, #custody, resources,
        );

        public func configure(
            keys : SigningTypes.KeyConfiguration,
            apps : [Types.AppDeclaration],
        ) : () {
            engine.configure(keys, Array.map<Types.AppDeclaration, SigningTypes.AppDeclaration>(apps, func(app) {
                {
                    app_scope = app.app_scope;
                    chain_key_signing = switch (app.wallet_custody_signing) {
                        case null null;
                        case (?decl) ?{
                            slots = Array.map<Types.SlotDeclaration, SigningTypes.SlotDeclaration>(decl.slots, func(slot) {
                                {
                                    id = slot.id;
                                    algorithm = slot.algorithm;
                                    purpose = slot.purpose;
                                    max_assertion_bytes = 32;
                                };
                            });
                        };
                    };
                };
            }));
        };

        public func commitConfiguration() : () { engine.commitConfiguration() };

        public func capability(scope : CapabilityTypes.AppScope) : Types.Capability {
            let scoped = engine.capability(scope);
            {
                public_key = func(slot : Text) : async* Caps.WalletCustodyPublicKeyResultV1 {
                    switch (await* scoped.public_key(slot)) {
                        case (#err(error)) #err(error);
                        case (#ok(value)) #ok({
                            slot = value.slot;
                            algorithm = #ecdsa_secp256k1;
                            public_key = value.public_key;
                            key_fingerprint = value.key_fingerprint;
                            namespace_version = value.namespace_version;
                        });
                    };
                };
                sign_digest = func(request : Caps.WalletCustodySignDigestRequestV1) : async* Caps.WalletCustodySignatureResultV1 {
                    switch (await* scoped.sign_assertion({ slot = request.slot; assertion = request.digest })) {
                        case (#err(error)) #err(error);
                        case (#ok(value)) #ok({
                            slot = value.slot;
                            algorithm = #ecdsa_secp256k1;
                            digest = value.digest;
                            signature = value.signature;
                        });
                    };
                };
            };
        };
    };
}
