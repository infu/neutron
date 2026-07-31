import Array "mo:core/Array";
import Blob "mo:core/Blob";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Set "mo:core/Set";
import Text "mo:core/Text";
import AppUsageTypes "../app_usage/Types";
import CapabilityScope "../capabilities/Scope";
import CapabilityTypes "../capabilities/Types";
import Namespace "Namespace";
import Types "Types";

module {
    public let MAX_SLOTS_PER_APP : Nat = 4;
    public let MAX_SLOTS_GLOBAL : Nat = 2_048;
    public let MAX_ASSERTION_BYTES : Nat = 4_096;
    public let MAX_QUOTE_PER_ASSERTION : Nat = 50_000_000_000;
    public let MIN_REMAINING_CYCLES : Nat = 250_000_000_000;
    public let MAX_IN_FLIGHT_PER_SLOT : Nat = 1;
    public let MAX_IN_FLIGHT_PER_APP : Nat = 2;
    public let MAX_IN_FLIGHT_GLOBAL : Nat = 4;
    public let MAX_PURPOSE_CHARS : Nat = 160;

    let MAX_STATE_KEY_BYTES : Nat = 128;
    let MAX_FINGERPRINT_BYTES : Nat = 64;

    type PreparedSlot = {
        scope : CapabilityTypes.AppScope;
        declaration : Types.SlotDeclaration;
        declaration_fingerprint : Text;
        identity_fingerprint : Text;
        key_name : ?Text;
        material : ?Namespace.Material;
    };

    public func init() : Types.Memory {
        {
            slots = Map.empty<Text, Types.SlotState>();
        };
    };

    public class Service(
        mem : Types.Memory,
        adapter : Types.Adapter,
        canisterPrincipal : Principal,
        installEpoch : Nat64,
        scopeActive : CapabilityTypes.AppScope -> Bool,
        deploymentCommitted : () -> Bool,
        registry : CapabilityTypes.RuntimeRegistry,
        outgoingCycles : AppUsageTypes.OutgoingCycleAccounting,
    ) {
        let declarations = Map.empty<Text, Types.Declaration>();
        let slots = Map.empty<Text, PreparedSlot>();
        let slotInFlight = Set.empty<Text>();
        let scopeInFlight = Map.empty<Text, Nat>();
        var globalInFlight = 0;
        var configured = false;

        do { assert (validateMemory(mem)) };

        public func configure(
            keys : Types.KeyConfiguration,
            apps : [Types.AppDeclaration],
        ) : () {
            assert (not configured and validKeyConfiguration(keys));
            var slotCount = 0;
            var previousScope : ?Text = null;
            for (app in apps.vals()) {
                assert (validScope(app.app_scope));
                let scopeKey = CapabilityScope.key(app.app_scope);
                switch (previousScope) {
                    case (?previous) assert (
                        Text.compare(previous, scopeKey) == #less
                    );
                    case null {};
                };
                previousScope := ?scopeKey;
                let ?declaration = app.chain_key_signing else continue;
                assert (
                    declaration.slots.size() >= 1 and
                    declaration.slots.size() <= MAX_SLOTS_PER_APP
                );
                assert (not Map.containsKey(
                    declarations,
                    Text.compare,
                    scopeKey,
                ));
                Map.add(declarations, Text.compare, scopeKey, declaration);
                var previousSlot : ?Text = null;
                for (slot in declaration.slots.vals()) {
                    validateSlot(slot);
                    switch (previousSlot) {
                        case (?previous) assert (
                            Text.compare(previous, slot.id) == #less
                        );
                        case null {};
                    };
                    previousSlot := ?slot.id;
                    let stateKey = slotKey(app.app_scope, slot.id);
                    assert (not Map.containsKey(slots, Text.compare, stateKey));
                    let keyName = keyFor(keys, slot.algorithm);
                    let material = switch (keyName) {
                        case (?name) {
                            let #ok(value) = Namespace.build({
                                install_epoch = installEpoch;
                                canister = canisterPrincipal;
                                app_scope = app.app_scope;
                                slot_id = slot.id;
                                algorithm = slot.algorithm;
                                key_name = name;
                            }) else Runtime.trap(
                                "Invalid chain-key namespace configuration"
                            );
                            ?value;
                        };
                        case null null;
                    };
                    let declarationFingerprint = Namespace.authorityFingerprint(slot);
                    let identityFingerprint = switch (material) {
                        case (?value) value.identity_fingerprint;
                        case null Namespace.hex(Namespace.hashParts([
                            "neutron.chain-key-signing.unavailable-key.v1",
                            Text.encodeUtf8(scopeKey),
                            Text.encodeUtf8(slot.id),
                            Text.encodeUtf8(Namespace.algorithmText(slot.algorithm)),
                        ]));
                    };
                    Map.add(slots, Text.compare, stateKey, {
                        scope = app.app_scope;
                        declaration = slot;
                        declaration_fingerprint = declarationFingerprint;
                        identity_fingerprint = identityFingerprint;
                        key_name = keyName;
                        material;
                    });
                    slotCount += 1;
                };
            };
            assert (slotCount <= MAX_SLOTS_GLOBAL);
            configured := true;
        };

        public func commitConfiguration() : () {
            assert (configured and deploymentCommitted());
            let staleSlots = List.empty<Text>();
            for ((key, state) in Map.entries(mem.slots)) {
                switch (Map.get(slots, Text.compare, key)) {
                    case (?slot) {
                        if (
                            not scopeActive(slot.scope) or
                            state.declaration_fingerprint !=
                                slot.declaration_fingerprint or
                            state.identity_fingerprint !=
                                slot.identity_fingerprint
                        ) List.add(staleSlots, key);
                    };
                    case null List.add(staleSlots, key);
                };
            };
            for (key in List.values(staleSlots)) {
                ignore Map.delete(mem.slots, Text.compare, key);
            };

        };

        public func capability(
            appScope : CapabilityTypes.AppScope,
        ) : Types.Capability {
            assert (configured and declarationFor(appScope) != null);
            {
                public_key = func(slot : Text) : async* Types.PublicKeyResult {
                    await* publicKey(appScope, slot);
                };
                sign_assertion = func(
                    request : Types.SignRequest,
                ) : async* Types.SignResult {
                    await* signAssertion(appScope, request);
                };
            };
        };

        public func publicKey(
            appScope : CapabilityTypes.AppScope,
            slotId : Text,
        ) : async* Types.PublicKeyResult {
            let result = await* publicKeyInner(appScope, slotId);
            ignore registry.record(
                appScope,
                #chain_key_signing,
                slotId,
                "public_key",
                publicKeyOutcome(result),
            );
            result;
        };

        public func signAssertion(
            appScope : CapabilityTypes.AppScope,
            request : Types.SignRequest,
        ) : async* Types.SignResult {
            let result = await* signInner(appScope, request);
            ignore registry.record(
                appScope,
                #chain_key_signing,
                request.slot,
                "sign_assertion",
                signOutcome(result),
            );
            result;
        };

        func publicKeyInner(
            appScope : CapabilityTypes.AppScope,
            slotId : Text,
        ) : async* Types.PublicKeyResult {
            if (not scopeActive(appScope)) return #err(#source_gone);
            if (not Namespace.validSlotId(slotId)) {
                return #err(#invalid_request);
            };
            let ?_declaration = declarationFor(appScope) else {
                return #err(#not_declared);
            };
            let stateKey = slotKey(appScope, slotId);
            let ?slot = Map.get(slots, Text.compare, stateKey) else {
                return #err(#not_declared);
            };
            let ?lease = registry.lease(
                appScope,
                #chain_key_signing,
                slotId,
            ) else return #err(#disabled);
            let ?keyName = slot.key_name else return #err(#key_unavailable);
            let ?material = slot.material else return #err(#key_unavailable);

            switch (cachedKey(stateKey, slot)) {
                case (?publicKey) return #ok(publicKeyInfo(slot, material, publicKey));
                case null {};
            };
            if (inFlight(stateKey, appScope)) return #err(#busy);
            let ?cycleReservation = outgoingCycles.reserve(
                appScope,
                0,
                null,
                1,
            ) else return #err(#source_gone);

            let managementFuture = try {
                adapter.public_key({
                    algorithm = slot.declaration.algorithm;
                    key_name = keyName;
                    derivation_path = material.derivation_path;
                });
            } catch (_) {
                outgoingCycles.cancel(cycleReservation);
                return #err(#management_failure);
            };
            enter(stateKey, appScope);
            assert (outgoingCycles.commit(cycleReservation));
            let managementResult : Types.AdapterPublicKeyResult = try {
                await managementFuture;
            } catch (_) {
                #err({ charged_cycles = 0; kind = #definite });
            };
            leave(stateKey, appScope);
            outgoingCycles.finalize(cycleReservation, 0);

            if (not stillCurrent(slot, lease)) {
                return #err(#revoked_after_dispatch);
            };
            switch (managementResult) {
                case (#err(_)) #err(#management_failure);
                case (#ok(raw)) {
                    let ?normalized = normalizePublicKey(
                        slot.declaration.algorithm,
                        raw.public_key,
                        raw.chain_code,
                    ) else return #err(#management_failure);
                    storeCachedKey(stateKey, slot, normalized);
                    #ok(publicKeyInfo(slot, material, normalized));
                };
            };
        };

        func signInner(
            appScope : CapabilityTypes.AppScope,
            request : Types.SignRequest,
        ) : async* Types.SignResult {
            if (not scopeActive(appScope)) return #err(#source_gone);
            if (not Namespace.validSlotId(request.slot)) {
                return #err(#invalid_request);
            };
            let ?_declaration = declarationFor(appScope) else {
                return #err(#not_declared);
            };
            let stateKey = slotKey(appScope, request.slot);
            let ?slot = Map.get(slots, Text.compare, stateKey) else {
                return #err(#not_declared);
            };
            if (
                request.assertion.size() >
                    slot.declaration.max_assertion_bytes
            ) return #err(#invalid_request);
            let ?lease = registry.lease(
                appScope,
                #chain_key_signing,
                request.slot,
            ) else return #err(#disabled);
            let ?keyName = slot.key_name else return #err(#key_unavailable);
            let ?material = slot.material else return #err(#key_unavailable);
            let ?digest = Namespace.assertionDigest(
                material.signing_domain,
                request.assertion,
            ) else return #err(#invalid_request);
            let quote = switch (adapter.quote(
                slot.declaration.algorithm,
                keyName,
            )) {
                case (#ok(value)) value;
                case (#err) return #err(#key_unavailable);
            };
            if (quote > MAX_QUOTE_PER_ASSERTION) {
                return #err(#cost_too_high);
            };
            if (adapter.cycle_balance() < quote + MIN_REMAINING_CYCLES) {
                return #err(#low_cycles);
            };
            if (inFlight(stateKey, appScope)) return #err(#busy);
            let ?cycleReservation = outgoingCycles.reserve(
                appScope,
                quote,
                null,
                1,
            ) else return #err(#source_gone);

            let managementFuture = try {
                adapter.sign({
                    algorithm = slot.declaration.algorithm;
                    key_name = keyName;
                    derivation_path = material.derivation_path;
                    digest;
                    cycles = quote;
                });
            } catch (_) {
                outgoingCycles.cancel(cycleReservation);
                return #err(#management_failure);
            };
            enter(stateKey, appScope);
            assert (outgoingCycles.commit(cycleReservation));
            let managementResult : Types.AdapterSignResult = try {
                await managementFuture;
            } catch (_) {
                // A trusted adapter trap after dispatch makes both its refund
                // and signing outcome unobservable. Keep the gross reservation
                // conservatively and force callers onto the no-retry path.
                #err({ charged_cycles = quote; kind = #outcome_unknown });
            };
            leave(stateKey, appScope);

            let chargedCycles = switch (managementResult) {
                case (#ok(value)) value.charged_cycles;
                case (#err(value)) value.charged_cycles;
            };
            outgoingCycles.finalize(cycleReservation, chargedCycles);

            // Ambiguity is the stronger terminal signal. It carries no
            // signature bytes, so returning it cannot bypass revocation, and
            // callers must know not to retry even if the lease also changed.
            switch (managementResult) {
                case (#err({ kind = #outcome_unknown; charged_cycles = _ })) {
                    return #err(#outcome_unknown);
                };
                case (_) {};
            };
            if (not stillCurrent(slot, lease)) {
                return #err(#revoked_after_dispatch);
            };
            switch (managementResult) {
                case (#err(_)) #err(#management_failure);
                case (#ok(response)) {
                    if (response.signature.size() != 64) {
                        return #err(#management_failure);
                    };
                    #ok({
                        slot = request.slot;
                        algorithm = slot.declaration.algorithm;
                        digest;
                        signing_domain = material.signing_domain;
                        signature = response.signature;
                        message_format = #neutron_app_assertion_v1;
                    });
                };
            };
        };

        func declarationFor(
            scope : CapabilityTypes.AppScope,
        ) : ?Types.Declaration {
            if (not configured) return null;
            Map.get(
                declarations,
                Text.compare,
                CapabilityScope.key(scope),
            );
        };

        func cachedKey(
            stateKey : Text,
            slot : PreparedSlot,
        ) : ?Blob {
            let ?state = Map.get(mem.slots, Text.compare, stateKey) else {
                return null;
            };
            if (
                state.declaration_fingerprint !=
                    slot.declaration_fingerprint or
                state.identity_fingerprint != slot.identity_fingerprint
            ) return null;
            let ?cached = state.cached_public_key else return null;
            if (validNormalizedPublicKey(slot.declaration.algorithm, cached)) {
                ?cached;
            } else null;
        };

        func storeCachedKey(
            stateKey : Text,
            slot : PreparedSlot,
            publicKey : Blob,
        ) : () {
            let state = slotState(slot);
            Map.add(mem.slots, Text.compare, stateKey, {
                state with cached_public_key = ?publicKey;
            });
        };

        func publicKeyInfo(
            slot : PreparedSlot,
            material : Namespace.Material,
            publicKey : Blob,
        ) : Types.PublicKeyInfo {
            {
                slot = slot.declaration.id;
                algorithm = slot.declaration.algorithm;
                public_key = publicKey;
                key_fingerprint = Namespace.keyFingerprint(
                    slot.declaration.algorithm,
                    publicKey,
                );
                signing_domain = material.signing_domain;
                namespace_version = Namespace.VERSION;
                message_format = #neutron_app_assertion_v1;
            };
        };

        func stillCurrent(
            dispatched : PreparedSlot,
            lease : CapabilityTypes.RuntimeLease,
        ) : Bool {
            if (not scopeActive(dispatched.scope) or not lease.active()) {
                return false;
            };
            let key = slotKey(dispatched.scope, dispatched.declaration.id);
            let ?current = Map.get(slots, Text.compare, key) else return false;
            current.declaration_fingerprint ==
                dispatched.declaration_fingerprint and
            current.identity_fingerprint == dispatched.identity_fingerprint;
        };

        func slotState(
            slot : PreparedSlot,
        ) : Types.SlotState {
            let key = slotKey(slot.scope, slot.declaration.id);
            switch (Map.get(mem.slots, Text.compare, key)) {
                case (?stored) {
                    if (
                        stored.declaration_fingerprint ==
                            slot.declaration_fingerprint and
                        stored.identity_fingerprint ==
                            slot.identity_fingerprint
                    ) {
                        return stored;
                    };
                };
                case null {};
            };
            {
                declaration_fingerprint = slot.declaration_fingerprint;
                identity_fingerprint = slot.identity_fingerprint;
                cached_public_key = null;
            };
        };

        func inFlight(
            stateKey : Text,
            scope : CapabilityTypes.AppScope,
        ) : Bool {
            Set.contains(slotInFlight, Text.compare, stateKey) or
            count(scopeInFlight, CapabilityScope.key(scope)) >=
                MAX_IN_FLIGHT_PER_APP or
            globalInFlight >= MAX_IN_FLIGHT_GLOBAL;
        };

        func enter(
            stateKey : Text,
            scope : CapabilityTypes.AppScope,
        ) : () {
            assert (Set.insert(slotInFlight, Text.compare, stateKey));
            addCount(scopeInFlight, CapabilityScope.key(scope), 1);
            globalInFlight += 1;
        };

        func leave(
            stateKey : Text,
            scope : CapabilityTypes.AppScope,
        ) : () {
            Set.remove(slotInFlight, Text.compare, stateKey);
            subtractCount(scopeInFlight, CapabilityScope.key(scope), 1);
            assert (globalInFlight > 0);
            globalInFlight -= 1;
        };

    };

    public func normalizePublicKey(
        algorithm : Types.Algorithm,
        publicKey : Blob,
        chainCode : Blob,
    ) : ?Blob {
        if (chainCode.size() != 32) return null;
        switch (algorithm) {
            case (#ecdsa_secp256k1) {
                if (not validCompressedSec1(publicKey)) return null;
                ?publicKey;
            };
            case (#schnorr_bip340secp256k1) {
                if (not validCompressedSec1(publicKey)) return null;
                let bytes = Blob.toArray(publicKey);
                ?Array.toBlob(Array.sliceToArray(bytes, 1, 33));
            };
            case (#schnorr_ed25519) {
                if (publicKey.size() != 32) return null;
                ?publicKey;
            };
        };
    };

    public func validKeyConfiguration(keys : Types.KeyConfiguration) : Bool {
        validOptionalKey(keys.ecdsa_secp256k1) and
        validOptionalKey(keys.schnorr_bip340secp256k1) and
        validOptionalKey(keys.schnorr_ed25519);
    };

    public func validateMemory(memory : Types.Memory) : Bool {
        if (
            Map.size(memory.slots) > MAX_SLOTS_GLOBAL
        ) return false;
        for ((key, state) in Map.entries(memory.slots)) {
            if (
                Text.encodeUtf8(key).size() > MAX_STATE_KEY_BYTES or
                not validFingerprint(state.declaration_fingerprint) or
                not validFingerprint(state.identity_fingerprint) or
                (switch (state.cached_public_key) {
                    case (?value) value.size() != 32 and value.size() != 33;
                    case null false;
                })
            ) return false;
        };
        true;
    };

    func validateSlot(slot : Types.SlotDeclaration) : () {
        assert (
            Namespace.validSlotId(slot.id) and
            slot.purpose.size() >= 1 and
            slot.purpose.size() <= MAX_PURPOSE_CHARS and
            slot.max_assertion_bytes >= 1 and
            slot.max_assertion_bytes <= MAX_ASSERTION_BYTES
        );
    };

    func validScope(scope : CapabilityTypes.AppScope) : Bool {
        CapabilityScope.valid(scope);
    };

    func keyFor(
        keys : Types.KeyConfiguration,
        algorithm : Types.Algorithm,
    ) : ?Text {
        switch (algorithm) {
            case (#ecdsa_secp256k1) keys.ecdsa_secp256k1;
            case (#schnorr_bip340secp256k1) {
                keys.schnorr_bip340secp256k1;
            };
            case (#schnorr_ed25519) keys.schnorr_ed25519;
        };
    };

    func validOptionalKey(value : ?Text) : Bool {
        switch (value) {
            case (?key) Namespace.validKeyName(key);
            case null true;
        };
    };

    func validCompressedSec1(value : Blob) : Bool {
        if (value.size() != 33) return false;
        let bytes = Blob.toArray(value);
        bytes[0] == 2 or bytes[0] == 3;
    };

    func validNormalizedPublicKey(
        algorithm : Types.Algorithm,
        value : Blob,
    ) : Bool {
        switch (algorithm) {
            case (#ecdsa_secp256k1) validCompressedSec1(value);
            case (#schnorr_bip340secp256k1) value.size() == 32;
            case (#schnorr_ed25519) value.size() == 32;
        };
    };

    func validFingerprint(value : Text) : Bool {
        if (Text.encodeUtf8(value).size() != MAX_FINGERPRINT_BYTES) return false;
        for (char in value.chars()) {
            if (not (
                (char >= '0' and char <= '9') or
                (char >= 'a' and char <= 'f')
            )) return false;
        };
        true;
    };

    func slotKey(scope : CapabilityTypes.AppScope, slot : Text) : Text {
        CapabilityScope.key(scope) # "\00" # slot;
    };

    func count(map : Map.Map<Text, Nat>, key : Text) : Nat {
        switch (Map.get(map, Text.compare, key)) {
            case (?value) value;
            case null 0;
        };
    };

    func addCount(map : Map.Map<Text, Nat>, key : Text, amount : Nat) : () {
        Map.add(map, Text.compare, key, count(map, key) + amount);
    };

    func subtractCount(
        map : Map.Map<Text, Nat>,
        key : Text,
        amount : Nat,
    ) : () {
        let current = count(map, key);
        assert (current >= amount);
        if (current == amount) {
            ignore Map.delete(map, Text.compare, key);
        } else {
            Map.add(map, Text.compare, key, current - amount);
        };
    };

    func publicKeyOutcome(
        result : Types.PublicKeyResult,
    ) : CapabilityTypes.CapabilityOutcome {
        switch (result) {
            case (#ok(_)) #ok;
            case (#err(error)) errorOutcome(error);
        };
    };

    func signOutcome(
        result : Types.SignResult,
    ) : CapabilityTypes.CapabilityOutcome {
        switch (result) {
            case (#ok(_)) #ok;
            case (#err(error)) errorOutcome(error);
        };
    };

    func errorOutcome(error : Types.Error) : CapabilityTypes.CapabilityOutcome {
        switch (error) {
            case (#cost_too_high) #denied;
            case (#busy) #busy;
            case (#source_gone) #revoked;
            case (#revoked_after_dispatch) #revoked;
            case (#invalid_request) #denied;
            case (#not_declared) #denied;
            case (#disabled) #denied;
            case (#key_unavailable) #denied;
            case (#low_cycles) #denied;
            case (_) #failed;
        };
    };
}
