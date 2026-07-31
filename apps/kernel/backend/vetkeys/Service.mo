import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Int "mo:core/Int";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Set "mo:core/Set";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Sha256 "mo:sha2/Sha256";
import AppUsageTypes "../app_usage/Types";
import CapabilityTypes "../capabilities/Types";
import Scope "../capabilities/Scope";
import Memory "Memory";
import Namespace "Namespace";
import Types "Types";

module {
    public let SUITE : Text = "bls12_381_g2";
    public let PUBLIC_KEY_BYTES : Nat = 96;
    public let TRANSPORT_PUBLIC_KEY_BYTES : Nat = 48;
    public let ENCRYPTED_KEY_BYTES : Nat = 192;
    public let DERIVE_CYCLES : Nat = 50_000_000_000;
    public let MIN_REMAINING_CYCLES : Nat = 250_000_000_000;
    let MAX_PUBLIC_KEY_IN_FLIGHT : Nat = 4;
    let MAX_DERIVE_IN_FLIGHT : Nat = 4;
    let MAX_RANDOM_IN_FLIGHT : Nat = 4;
    let MAX_DESCRIPTION_CHARS : Nat = 280;
    let MAX_PURPOSE_CHARS : Nat = 280;

    public class Service(
        mem : Types.Memory,
        adapter : Types.Adapter,
        isAuthorized : Principal -> Bool,
        committedScope : Text -> ?Types.AppScope,
        scopeActive : Types.AppScope -> Bool,
        registry : CapabilityTypes.RuntimeRegistry,
        outgoingCycles : AppUsageTypes.OutgoingCycleAccounting,
    ) {
        let declarations = Map.empty<Text, Types.Declaration>();
        let deriveInFlight = Set.empty<Text>();
        let randomInFlight = Set.empty<Text>();
        let publicKeyInFlight = Set.empty<Text>();
        var globalDeriveInFlight = 0;
        var configured = false;
        var environment : Types.Environment = #production;

        do {
            // A malformed stable registry must never be served partially. The
            // rebuild is deterministic and replaces the derived index only
            // after all authoritative records pass validation.
            assert (Memory.rebuildIndex(mem));
        };

        public func configure(
            selectedEnvironment : Types.Environment,
            apps : [Types.AppDeclaration],
        ) : () {
            assert (not configured);
            environment := selectedEnvironment;
            var declaredSlots = 0;
            for (app in apps.vals()) {
                assert (
                    validAppId(app.app_scope.app_id) and
                    app.app_scope.installation_uid > 0
                );
                let ?declaration = app.vetkeys else continue;
                validateDeclaration(declaration);
                declaredSlots += declaration.slots.size();
                assert (declaredSlots <= Memory.MAX_SLOTS_TOTAL);
                assert (
                    not Map.containsKey(
                        declarations,
                        Text.compare,
                        Scope.key(app.app_scope),
                    )
                );
                Map.add(
                    declarations,
                    Text.compare,
                    Scope.key(app.app_scope),
                    declaration,
                );
            };
            configured := true;
        };

        // Stable suspension and uninstall retirement happen only after the
        // install journal commits. Merely assembling/starting a replacement
        // actor must not destroy recoverability if deployment is aborted.
        public func commitConfiguration(
            removedApps : [Types.AppInstance],
            changedBy : Principal,
            now : Nat64,
        ) : () {
            let removed = Set.empty<Text>();
            for (app in removedApps.vals()) {
                let appScope = app.scope;
                assert (validAppId(appScope.app_id));
                Set.add(removed, Text.compare, Scope.key(appScope));
                let existing = Memory.listScope(mem, appScope);
                for (slot in existing.vals()) {
                    audit(
                        appScope,
                        ?slot.slot_uid,
                        slot.slot_id,
                        null,
                        #uninstall,
                        changedBy,
                        #ok,
                        now,
                    );
                };
                ignore Memory.retireScope(mem, appScope, changedBy, now);
            };

            let toSuspend = List.empty<Types.Slot>();
            for (slot in Map.values(mem.slots_by_uid)) {
                if (
                    not Set.contains(
                        removed,
                        Text.compare,
                        Scope.key(slot.scope),
                    ) and
                    declaredSlot(slot.scope, slot.slot_id) == null and
                    slot.status != #manifest_suspended
                ) {
                    List.add(toSuspend, slot);
                };
            };
            for (slot in List.values(toSuspend)) {
                ignore Memory.setStatus(
                    mem,
                    slot.scope,
                    slot.slot_id,
                    #manifest_suspended,
                    changedBy,
                    now,
                );
                audit(
                    slot.scope,
                    ?slot.slot_uid,
                    slot.slot_id,
                    ?slot.current_generation,
                    #manifest_suspend,
                    changedBy,
                    #ok,
                    now,
                );
            };
        };

        public func capability(
            appScope : Types.AppScope,
            self : actor {},
        ) : Types.PublicCapability {
            assert (configured and declarationFor(appScope) != null);
            let selfPrincipal = Principal.fromActor(self);
            {
                canister_principal = selfPrincipal;
                slot = func(slotId : Text) : ?Types.PublicSlotSummary {
                    publicSlot(appScope, slotId);
                };
                public_key = func(
                    request : Types.PublicKeyRequest,
                ) : async* Types.PublicKeyResult {
                    await* trackedPublicKeyForScope(
                        appScope,
                        request,
                        selfPrincipal,
                    );
                };
            };
        };

        public func list(appId : Text) : [Types.PublicSlotSummary] {
            let ?appScope = activeScope(appId) else return [];
            let ?declaration = declarationFor(appScope) else return [];
            let result = List.empty<Types.PublicSlotSummary>();
            for (slotDeclaration in declaration.slots.vals()) {
                switch (publicSlot(appScope, slotDeclaration.id)) {
                    case (?slot) List.add(result, slot);
                    case null {};
                };
            };
            List.toArray(result);
        };

        public func binding(
            appId : Text,
            slotId : Text,
        ) : Types.OperationResult<Nat> {
            if (not configured or not validSlotId(slotId)) {
                return #err(#invalid_request);
            };
            let ?appScope = activeScope(appId) else return #err(#not_declared);
            if (declaredSlot(appScope, slotId) == null) return #err(#not_declared);
            let ?slot = Memory.get(mem, appScope, slotId) else {
                return #err(#not_reserved);
            };
            #ok(slot.slot_uid);
        };

        public func reserve(
            input : Types.AppSlotInput,
            caller : Principal,
            _self : actor {},
        ) : async* Types.OperationResult<Types.PublicSlotSummary> {
            let result = await* reserveInner(input, caller);
            trackInput(input, "reserve", result);
        };

        func reserveInner(
            input : Types.AppSlotInput,
            caller : Principal,
        ) : async* Types.OperationResult<Types.PublicSlotSummary> {
            if (not validSourceInput(input, caller)) return #err(#invalid_request);
            let ?appScope = activeScope(input.app_id) else {
                return #err(#not_declared);
            };
            if (declaredSlot(appScope, input.slot_id) == null) {
                return #err(#not_declared);
            };
            let ?lease = registry.lease(
                appScope,
                #vetkeys,
                input.slot_id,
            ) else {
                return #err(#disabled);
            };
            switch (Memory.get(mem, appScope, input.slot_id)) {
                case (?existing) {
                    if (not Principal.equal(existing.key_holder, caller)) {
                        return #err(#owner_required);
                    };
                    return publicSlotResult(appScope, input.slot_id);
                };
                case null {};
            };

            if (
                Set.size(randomInFlight) >= MAX_RANDOM_IN_FLIGHT or
                Set.contains(
                    randomInFlight,
                    Text.compare,
                    Scope.key(appScope),
                )
            ) return #err(#busy);
            let ?cycleReservation = outgoingCycles.reserve(
                appScope,
                0,
                null,
                1,
            ) else return #err(#source_gone);
            let randomFuture : async Types.AdapterBlobResult = try {
                adapter.random_nonce();
            } catch (_) {
                outgoingCycles.cancel(cycleReservation);
                return #err(#management_failure);
            };
            assert (Set.insert(
                randomInFlight,
                Text.compare,
                Scope.key(appScope),
            ));
            assert (outgoingCycles.commit(cycleReservation));
            let randomResult : Types.AdapterBlobResult = try {
                await randomFuture;
            } catch (_) {
                #err;
            };
            outgoingCycles.finalize(cycleReservation, 0);
            Set.remove(randomInFlight, Text.compare, Scope.key(appScope));

            // The registry is a live kill switch, just like the installation
            // and exact declaration. Recheck all three immediately after the
            // management await and before interpreting or storing its reply.
            if (not validSourceInput(input, caller)) return #err(#source_gone);
            if (not scopeActive(appScope)) return #err(#source_gone);
            if (declaredSlot(appScope, input.slot_id) == null) {
                return #err(#source_gone);
            };
            if (not lease.active()) {
                return #err(#source_gone);
            };
            switch (Memory.get(mem, appScope, input.slot_id)) {
                case (?existing) {
                    if (not Principal.equal(existing.key_holder, caller)) {
                        return #err(#owner_required);
                    };
                    return publicSlotResult(appScope, input.slot_id);
                };
                case null {};
            };
            let nonce = switch (randomResult) {
                case (#ok(value)) value;
                case (#err) {
                    auditInput(input, null, #reserve, caller, #failed);
                    return #err(#management_failure);
                };
            };
            if (nonce.size() != Memory.NAMESPACE_NONCE_BYTES) {
                auditInput(input, null, #reserve, caller, #failed);
                return #err(#management_failure);
            };

            let now = nowNanos();
            let result = Memory.reserve(mem, {
                scope = appScope;
                slot_id = input.slot_id;
                namespace_nonce = nonce;
                key_holder = caller;
                key_name = environmentKeyName();
                now;
                changed_by = caller;
            });
            switch (result) {
                case (#ok(summary)) {
                    auditInput(input, ?summary.slot_uid, #reserve, caller, #ok);
                    publicSlotResult(appScope, input.slot_id);
                };
                case (#err(_)) {
                    auditInput(input, null, #reserve, caller, #failed);
                    #err(#key_unavailable);
                };
            };
        };

        public func enable(
            input : Types.AppSlotInput,
            caller : Principal,
        ) : Types.OperationResult<Types.PublicSlotSummary> {
            let result = lifecycleStatus(
                input,
                caller,
                #enabled,
                #enable,
                true,
            );
            trackInput(input, "enable", result);
        };

        public func disable(
            input : Types.AppSlotInput,
            caller : Principal,
        ) : Types.OperationResult<Types.PublicSlotSummary> {
            let result = lifecycleStatus(
                input,
                caller,
                #disabled,
                #disable,
                false,
            );
            trackInput(input, "disable", result);
        };

        public func rotate(
            input : Types.AppSlotInput,
            caller : Principal,
        ) : Types.OperationResult<Types.PublicSlotSummary> {
            let result = rotateInner(input, caller);
            trackInput(input, "rotate", result);
        };

        func rotateInner(
            input : Types.AppSlotInput,
            caller : Principal,
        ) : Types.OperationResult<Types.PublicSlotSummary> {
            let validated = validateOwnedAllowed(input, caller);
            let slot = switch (validated) {
                case (#ok(value)) value;
                case (#err(error)) return #err(error);
            };
            if (slot.status == #manifest_suspended) return #err(#manifest_suspended);
            if (slot.status == #disabled) return #err(#disabled);
            let now = nowNanos();
            switch (Memory.rotate(
                mem,
                slot.scope,
                input.slot_id,
                environmentKeyName(),
                caller,
                now,
            )) {
                case (#ok(_)) {
                    auditInput(input, ?slot.slot_uid, #rotate, caller, #ok);
                    publicSlotResult(slot.scope, input.slot_id);
                };
                case (#err(#previous_exists)) #err(#generation_unavailable);
                case (#err(_)) {
                    auditInput(input, ?slot.slot_uid, #rotate, caller, #failed);
                    #err(#key_unavailable);
                };
            };
        };

        public func retireGeneration(
            input : Types.AppGenerationInput,
            caller : Principal,
        ) : Types.OperationResult<Types.PublicSlotSummary> {
            let result = retireGenerationInner(input, caller);
            trackInput(
                { app_id = input.app_id; slot_id = input.slot_id },
                "retire_generation",
                result,
            );
        };

        func retireGenerationInner(
            input : Types.AppGenerationInput,
            caller : Principal,
        ) : Types.OperationResult<Types.PublicSlotSummary> {
            let ownedInput = { app_id = input.app_id; slot_id = input.slot_id };
            let validated = validateOwned(ownedInput, caller);
            let slot = switch (validated) {
                case (#ok(value)) value;
                case (#err(error)) return #err(error);
            };
            switch (Memory.retireGeneration(
                mem,
                slot.scope,
                input.slot_id,
                input.generation,
                caller,
                nowNanos(),
            )) {
                case (#ok(_)) {
                    audit(
                        slot.scope,
                        ?slot.slot_uid,
                        input.slot_id,
                        ?input.generation,
                        #retire_generation,
                        caller,
                        #ok,
                        nowNanos(),
                    );
                    publicSlotResult(slot.scope, input.slot_id);
                };
                case (#err(_)) #err(#generation_unavailable);
            };
        };

        public func transfer(
            input : Types.TransferInput,
            caller : Principal,
        ) : Types.OperationResult<Types.PublicSlotSummary> {
            let result = transferInner(input, caller);
            trackInput(
                { app_id = input.app_id; slot_id = input.slot_id },
                "transfer",
                result,
            );
        };

        func transferInner(
            input : Types.TransferInput,
            caller : Principal,
        ) : Types.OperationResult<Types.PublicSlotSummary> {
            let ownedInput = { app_id = input.app_id; slot_id = input.slot_id };
            let validated = validateOwnedAllowed(ownedInput, caller);
            let slot = switch (validated) {
                case (#ok(value)) value;
                case (#err(error)) return #err(error);
            };
            if (Principal.isAnonymous(input.new_holder)) return #err(#invalid_request);
            if (not isAuthorized(input.new_holder)) return #err(#invalid_request);
            switch (Memory.transfer(
                mem,
                slot.scope,
                input.slot_id,
                caller,
                input.new_holder,
                caller,
                nowNanos(),
            )) {
                case (#ok(_)) {
                    auditInput(ownedInput, ?slot.slot_uid, #transfer, caller, #ok);
                    publicSlotResult(slot.scope, input.slot_id);
                };
                case (#err(_)) #err(#owner_required);
            };
        };

        public func retireSlot(
            input : Types.AppSlotInput,
            caller : Principal,
        ) : Types.OperationResult<()> {
            let result = retireSlotInner(input, caller);
            trackInput(input, "retire_slot", result);
        };

        func retireSlotInner(
            input : Types.AppSlotInput,
            caller : Principal,
        ) : Types.OperationResult<()> {
            // Permanent cleanup remains available after a manifest removes the
            // declaration and suspends the slot. Other app-facing lifecycle
            // actions still require a current declaration.
            let validated = validateExistingOwned(input, caller);
            let slot = switch (validated) {
                case (#ok(value)) value;
                case (#err(error)) return #err(error);
            };
            switch (Memory.retireSlot(
                mem,
                slot.scope,
                input.slot_id,
                #owner_retired,
                caller,
                nowNanos(),
            )) {
                case (#ok(_)) {
                    auditInput(input, ?slot.slot_uid, #retire_slot, caller, #ok);
                    #ok(());
                };
                case (#err(_)) #err(#not_reserved);
            };
        };

        public func publicKey(
            appId : Text,
            request : Types.PublicKeyRequest,
            selfPrincipal : Principal,
        ) : async* Types.PublicKeyResult {
            if (not validSlotId(request.slot)) {
                return #err(#invalid_request);
            };
            let ?appScope = activeScope(appId) else {
                return #err(#not_declared);
            };
            await* trackedPublicKeyForScope(appScope, request, selfPrincipal);
        };

        func trackedPublicKeyForScope(
            appScope : Types.AppScope,
            request : Types.PublicKeyRequest,
            selfPrincipal : Principal,
        ) : async* Types.PublicKeyResult {
            let ?lease = registry.lease(
                appScope,
                #vetkeys,
                request.slot,
            ) else return trackScope(
                appScope,
                request.slot,
                "public_key",
                #err(#disabled),
            );
            let result = await* publicKeyForScope(
                appScope,
                request,
                selfPrincipal,
                lease,
            );
            trackScope(
                appScope,
                request.slot,
                "public_key",
                result,
            );
        };

        func publicKeyForScope(
            appScope : Types.AppScope,
            request : Types.PublicKeyRequest,
            selfPrincipal : Principal,
            lease : CapabilityTypes.RuntimeLease,
        ) : async* Types.PublicKeyResult {
            if (not scopeActive(appScope) or not validSlotId(request.slot)) {
                return #err(#source_gone);
            };
            let prepared = switch (
                prepareGeneration(appScope, request, selfPrincipal, lease)
            ) {
                case (#ok(value)) value;
                case (#err(error)) return auditedPublicKey(
                    appScope,
                    request,
                    selfPrincipal,
                    #err(error),
                );
            };
            switch (prepared.generation.cached_public_key, prepared.generation.public_fingerprint) {
                case (?publicKey, ?fingerprint) {
                    return auditedPublicKey(appScope, request, selfPrincipal, #ok(publicInfo(
                        selfPrincipal,
                        request.slot,
                        prepared.generation,
                        publicKey,
                        fingerprint,
                        prepared.material.derivation_input,
                    )));
                };
                case (null, null) {};
                case _ return auditedPublicKey(
                    appScope,
                    request,
                    selfPrincipal,
                    #err(#key_unavailable),
                );
            };

            let inFlightKey = generationKey(
                prepared.slot.slot_uid,
                request.generation,
            );
            if (
                Set.size(publicKeyInFlight) >= MAX_PUBLIC_KEY_IN_FLIGHT or
                Set.contains(publicKeyInFlight, Text.compare, inFlightKey)
            ) return auditedPublicKey(
                appScope,
                request,
                selfPrincipal,
                #err(#busy),
            );
            let ?cycleReservation = outgoingCycles.reserve(
                appScope,
                0,
                null,
                1,
            ) else return auditedPublicKey(
                appScope,
                request,
                selfPrincipal,
                #err(#source_gone),
            );
            let publicKeyFuture : async Types.AdapterBlobResult = try {
                adapter.public_key({
                    context = prepared.material.context;
                    key_name = prepared.generation.key_name;
                });
            } catch (_) {
                outgoingCycles.cancel(cycleReservation);
                return auditedPublicKey(
                    appScope,
                    request,
                    selfPrincipal,
                    #err(#management_failure),
                );
            };
            assert (Set.insert(
                publicKeyInFlight,
                Text.compare,
                inFlightKey,
            ));
            assert (outgoingCycles.commit(cycleReservation));
            let managementResult : Types.AdapterBlobResult = try {
                await publicKeyFuture;
            } catch (_) {
                #err;
            };
            outgoingCycles.finalize(cycleReservation, 0);
            Set.remove(publicKeyInFlight, Text.compare, inFlightKey);

            let revalidated = switch (
                prepareGeneration(appScope, request, selfPrincipal, lease)
            ) {
                case (#ok(value)) value;
                case (#err(_)) return auditedPublicKey(
                    appScope,
                    request,
                    selfPrincipal,
                    #err(#source_gone),
                );
            };
            if (
                revalidated.slot.slot_uid != prepared.slot.slot_uid or
                revalidated.slot.namespace_nonce != prepared.slot.namespace_nonce or
                revalidated.generation.key_name != prepared.generation.key_name or
                revalidated.material.context != prepared.material.context or
                revalidated.material.derivation_input != prepared.material.derivation_input
            ) return auditedPublicKey(
                appScope,
                request,
                selfPrincipal,
                #err(#source_gone),
            );

            let publicKey = switch (managementResult) {
                case (#ok(value)) value;
                case (#err) return auditedPublicKey(
                    appScope,
                    request,
                    selfPrincipal,
                    #err(#management_failure),
                );
            };
            if (publicKey.size() != PUBLIC_KEY_BYTES) return auditedPublicKey(
                appScope,
                request,
                selfPrincipal,
                #err(#management_failure),
            );

            let fingerprint = Sha256.fromBlob(#sha256, publicKey);
            switch (Memory.cachePublicKey(
                mem,
                appScope,
                request.slot,
                request.generation,
                publicKey,
                fingerprint,
            )) {
                case (#ok(_)) {};
                case (#err(_)) return auditedPublicKey(
                    appScope,
                    request,
                    selfPrincipal,
                    #err(#source_gone),
                );
            };
            auditedPublicKey(appScope, request, selfPrincipal, #ok(publicInfo(
                selfPrincipal,
                request.slot,
                revalidated.generation,
                publicKey,
                fingerprint,
                revalidated.material.derivation_input,
            )));
        };

        public func derive(
            input : Types.DeriveInput,
            caller : Principal,
            selfPrincipal : Principal,
        ) : async* Types.DeriveResult {
            let result = await* deriveInner(input, caller, selfPrincipal);
            trackInput(
                { app_id = input.app_id; slot_id = input.slot_id },
                "derive",
                result,
            );
        };

        func deriveInner(
            input : Types.DeriveInput,
            caller : Principal,
            selfPrincipal : Principal,
        ) : async* Types.DeriveResult {
            let slotInput = { app_id = input.app_id; slot_id = input.slot_id };
            if (
                Principal.equal(caller, selfPrincipal) or
                not validSourceInput(slotInput, caller) or
                input.transport_public_key.size() != TRANSPORT_PUBLIC_KEY_BYTES
            ) return #err(#invalid_request);
            let authorizedSlot = switch (validateDerivable(
                slotInput,
                caller,
                selfPrincipal,
            )) {
                case (#ok(value)) value;
                case (#err(error)) return #err(error);
            };
            if (authorizedSlot.slot_uid != input.expected_slot_uid) {
                return #err(#source_gone);
            };
            if (authorizedSlot.status == #manifest_suspended) {
                return #err(#manifest_suspended);
            };
            if (authorizedSlot.status == #disabled) return #err(#disabled);
            let ?lease = registry.lease(
                authorizedSlot.scope,
                #vetkeys,
                input.slot_id,
            ) else return #err(#disabled);

            let publicResult = await* publicKeyForScope(
                authorizedSlot.scope,
                { slot = input.slot_id; generation = input.generation },
                selfPrincipal,
                lease,
            );
            if (
                Principal.equal(caller, selfPrincipal) or
                not validSourceInput(slotInput, caller) or
                not lease.active()
            ) return #err(#source_gone);
            let publicMaterial = switch (publicResult) {
                case (#ok(value)) value;
                case (#err(error)) return #err(error);
            };

            // Public-key acquisition may await. Derivation follows the live
            // Neutron authorization set, while the slot holder remains only
            // the lifecycle manager. Recheck the exact requesting principal,
            // deny the Neutron canister itself, and fail closed if any stable
            // slot binding changed during the await.
            if (
                Principal.equal(caller, selfPrincipal) or
                not validSourceInput(slotInput, caller)
            ) return #err(#source_gone);
            let prepared = switch (prepareGeneration(
                authorizedSlot.scope,
                { slot = input.slot_id; generation = input.generation },
                selfPrincipal,
                lease,
            )) {
                case (#ok(value)) value;
                case (#err(error)) return #err(error);
            };
            if (
                prepared.slot.slot_uid != input.expected_slot_uid or
                prepared.slot.slot_uid != authorizedSlot.slot_uid or
                not Principal.equal(
                    prepared.slot.key_holder,
                    authorizedSlot.key_holder,
                ) or
                prepared.slot.namespace_nonce != authorizedSlot.namespace_nonce
            ) {
                return #err(#source_gone);
            };
            if (
                Set.contains(
                    deriveInFlight,
                    Text.compare,
                    Scope.key(authorizedSlot.scope),
                ) or
                globalDeriveInFlight >= MAX_DERIVE_IN_FLIGHT
            ) {
                auditGenerationInput(
                    slotInput,
                    ?prepared.slot.slot_uid,
                    input.generation,
                    #derive,
                    caller,
                    #busy,
                );
                return #err(#busy);
            };
            if (adapter.cycle_balance() < DERIVE_CYCLES + MIN_REMAINING_CYCLES) {
                auditGenerationInput(
                    slotInput,
                    ?prepared.slot.slot_uid,
                    input.generation,
                    #derive,
                    caller,
                    #low_cycles,
                );
                return #err(#low_cycles);
            };
            let ?cycleReservation = outgoingCycles.reserve(
                authorizedSlot.scope,
                DERIVE_CYCLES,
                null,
                1,
            ) else return #err(#source_gone);
            switch (Memory.recordDerivation(
                mem,
                authorizedSlot.scope,
                input.slot_id,
                nowNanos(),
            )) {
                case (#ok(_)) {};
                case (#err(_)) {
                    outgoingCycles.cancel(cycleReservation);
                    return #err(#source_gone);
                };
            };
            let deriveFuture : async Types.AdapterDeriveResult = try {
                adapter.derive_key({
                    context = prepared.material.context;
                    derivation_input = prepared.material.derivation_input;
                    transport_public_key = input.transport_public_key;
                    key_name = prepared.generation.key_name;
                    cycles = DERIVE_CYCLES;
                });
            } catch (_) {
                // The future was never created, so no management call could
                // have dispatched. The derivation count is durable telemetry,
                // but the transfer reservation and call base must be refunded.
                outgoingCycles.cancel(cycleReservation);
                return #err(#management_failure);
            };
            Set.add(
                deriveInFlight,
                Text.compare,
                Scope.key(authorizedSlot.scope),
            );
            globalDeriveInFlight += 1;
            assert (outgoingCycles.commit(cycleReservation));
            let managementResult : Types.AdapterDeriveResult = try {
                await deriveFuture;
            } catch (_) {
                // A trusted adapter trap after dispatch makes its refund
                // unobservable. Keep the gross reservation conservatively.
                #err({ charged_cycles = DERIVE_CYCLES });
            };
            Set.remove(
                deriveInFlight,
                Text.compare,
                Scope.key(authorizedSlot.scope),
            );
            globalDeriveInFlight -= 1;

            // The management call has already spent these cycles. Preserve
            // accounting even when a concurrent revocation withholds the
            // reply; this mutation grants no app authority.
            let chargedCycles = switch (managementResult) {
                case (#ok(value)) value.charged_cycles;
                case (#err(value)) value.charged_cycles;
            };
            outgoingCycles.finalize(cycleReservation, chargedCycles);
            ignore Memory.recordCycleSpend(
                mem,
                authorizedSlot.scope,
                prepared.slot.slot_uid,
                chargedCycles,
            );

            let after = switch (prepareGeneration(
                authorizedSlot.scope,
                { slot = input.slot_id; generation = input.generation },
                selfPrincipal,
                lease,
            )) {
                case (#ok(value)) value;
                case (#err(_)) return #err(#source_gone);
            };
            if (
                after.slot.slot_uid != prepared.slot.slot_uid or
                after.slot.slot_uid != input.expected_slot_uid or
                Principal.equal(caller, selfPrincipal) or
                not validSourceInput(slotInput, caller) or
                not Principal.equal(
                    after.slot.key_holder,
                    prepared.slot.key_holder,
                ) or
                after.slot.namespace_nonce != prepared.slot.namespace_nonce or
                after.generation.key_name != prepared.generation.key_name or
                after.material.context != prepared.material.context or
                after.material.derivation_input != prepared.material.derivation_input
            ) {
                return #err(#source_gone);
            };

            let encryptedKey = switch (managementResult) {
                case (#ok(value)) value.encrypted_key;
                case (#err(_value)) {
                    auditGenerationInput(
                        slotInput,
                        ?prepared.slot.slot_uid,
                        input.generation,
                        #derive,
                        caller,
                        #failed,
                    );
                    return #err(#management_failure);
                };
            };
            if (encryptedKey.size() != ENCRYPTED_KEY_BYTES) {
                auditGenerationInput(
                    slotInput,
                    ?prepared.slot.slot_uid,
                    input.generation,
                    #derive,
                    caller,
                    #failed,
                );
                return #err(#management_failure);
            };

            auditGenerationInput(
                slotInput,
                ?prepared.slot.slot_uid,
                input.generation,
                #derive,
                caller,
                #ok,
            );
            #ok({ encrypted_key = encryptedKey; public_info = publicMaterial });
        };

        public func auditSnapshot() : [Types.AuditEntry] {
            Memory.auditSnapshot(mem);
        };

        public func holdsSlots(principal : Principal) : Bool {
            for (slot in Map.values(mem.slots_by_uid)) {
                if (Principal.equal(slot.key_holder, principal)) return true;
            };
            false;
        };

        public func adminSnapshot() : Types.AdminSnapshot {
            let slots = List.empty<Types.AdminSlotSummary>();
            for (slot in Map.values(mem.slots_by_uid)) {
                List.add(slots, {
                    app_id = slot.scope.app_id;
                    installation_uid = slot.scope.installation_uid;
                    slot_uid = slot.slot_uid;
                    slot = slot.slot_id;
                    purpose = switch (declaredSlot(slot.scope, slot.slot_id)) {
                        case (?declaration) ?declaration.purpose;
                        case null null;
                    };
                    key_holder = slot.key_holder;
                    status = slot.status;
                    current_generation = slot.current_generation;
                    previous_generation = previousGeneration(slot);
                    generations = generationSummaries(slot);
                    created_at = slot.created_at;
                    created_by = slot.created_by;
                    updated_at = slot.updated_at;
                    updated_by = slot.updated_by;
                    last_used_at = slot.last_used_at;
                    total_derivations = slot.total_derivations;
                    approximate_cycle_spend = slot.approximate_cycle_spend;
                });
            };
            {
                environment = if (configured) ?environment else null;
                slots = List.toArray(slots);
                audit = Memory.auditSnapshot(mem);
            };
        };

        func lifecycleStatus(
            input : Types.AppSlotInput,
            caller : Principal,
            target : Types.SlotStatus,
            action : Types.AuditAction,
            requireAllowed : Bool,
        ) : Types.OperationResult<Types.PublicSlotSummary> {
            let validated = if (requireAllowed) {
                validateOwnedAllowed(input, caller);
            } else {
                validateOwned(input, caller);
            };
            let slot = switch (validated) {
                case (#ok(value)) value;
                case (#err(error)) return #err(error);
            };
            if (target == #disabled and slot.status == #manifest_suspended) {
                return #err(#manifest_suspended);
            };
            switch (Memory.setStatus(
                mem,
                slot.scope,
                input.slot_id,
                target,
                caller,
                nowNanos(),
            )) {
                case (#ok(_)) {
                    auditInput(input, ?slot.slot_uid, action, caller, #ok);
                    publicSlotResult(slot.scope, input.slot_id);
                };
                case (#err(_)) #err(#not_reserved);
            };
        };

        func validateOwned(
            input : Types.AppSlotInput,
            caller : Principal,
        ) : Types.OperationResult<Types.Slot> {
            if (not validSourceInput(input, caller)) return #err(#invalid_request);
            let ?appScope = activeScope(input.app_id) else {
                return #err(#not_declared);
            };
            if (declaredSlot(appScope, input.slot_id) == null) {
                return #err(#not_declared);
            };
            validateExistingOwned(input, caller);
        };

        func validateOwnedAllowed(
            input : Types.AppSlotInput,
            caller : Principal,
        ) : Types.OperationResult<Types.Slot> {
            let result = validateOwned(input, caller);
            let slot = switch (result) {
                case (#ok(value)) value;
                case (#err(error)) return #err(error);
            };
            if (not slotAllowed(slot.scope, input.slot_id)) {
                return #err(#disabled);
            };
            #ok(slot);
        };

        func validateExistingOwned(
            input : Types.AppSlotInput,
            caller : Principal,
        ) : Types.OperationResult<Types.Slot> {
            if (not validSourceInput(input, caller)) return #err(#invalid_request);
            let ?appScope = activeScope(input.app_id) else {
                return #err(#not_reserved);
            };
            let ?slot = Memory.get(mem, appScope, input.slot_id) else {
                return #err(#not_reserved);
            };
            if (not Principal.equal(slot.key_holder, caller)) {
                return #err(#owner_required);
            };
            #ok(slot);
        };

        func validateDerivable(
            input : Types.AppSlotInput,
            caller : Principal,
            selfPrincipal : Principal,
        ) : Types.OperationResult<Types.Slot> {
            if (
                Principal.equal(caller, selfPrincipal) or
                not validSourceInput(input, caller)
            ) return #err(#invalid_request);
            let ?appScope = activeScope(input.app_id) else {
                return #err(#not_declared);
            };
            if (declaredSlot(appScope, input.slot_id) == null) {
                return #err(#not_declared);
            };
            if (not slotAllowed(appScope, input.slot_id)) {
                return #err(#disabled);
            };
            let ?slot = Memory.get(mem, appScope, input.slot_id) else {
                return #err(#not_reserved);
            };
            #ok(slot);
        };

        type PreparedGeneration = {
            slot : Types.Slot;
            generation : Types.Generation;
            material : Namespace.Material;
        };

        func prepareGeneration(
            appScope : Types.AppScope,
            request : Types.PublicKeyRequest,
            selfPrincipal : Principal,
            lease : CapabilityTypes.RuntimeLease,
        ) : Types.OperationResult<PreparedGeneration> {
            if (not scopeActive(appScope)) return #err(#source_gone);
            if (declaredSlot(appScope, request.slot) == null) {
                return #err(#not_declared);
            };
            if (not lease.active()) {
                return #err(#disabled);
            };
            let ?slot = Memory.get(mem, appScope, request.slot) else {
                return #err(#not_reserved);
            };
            switch (slot.status) {
                case (#manifest_suspended) return #err(#manifest_suspended);
                case (#disabled) return #err(#disabled);
                case (#enabled) {};
            };
            let ?generation = Memory.generation(
                mem,
                appScope,
                request.slot,
                request.generation,
            ) else return #err(#generation_unavailable);
            if (generation.key_name != environmentKeyName()) {
                // This is an environment binding, not a fallback opportunity.
                return #err(#key_unavailable);
            };
            let #ok(material) = Namespace.build({
                canister = selfPrincipal;
                app_id = appScope.app_id;
                installation_uid = appScope.installation_uid;
                slot_id = request.slot;
                namespace_nonce = slot.namespace_nonce;
                generation = request.generation;
            }) else return #err(#key_unavailable);
            #ok({ slot; generation; material });
        };

        func publicSlotResult(
            appScope : Types.AppScope,
            slotId : Text,
        ) : Types.OperationResult<Types.PublicSlotSummary> {
            switch (publicSlot(appScope, slotId)) {
                case (?slot) #ok(slot);
                case null #err(#not_reserved);
            };
        };

        func publicSlot(
            appScope : Types.AppScope,
            slotId : Text,
        ) : ?Types.PublicSlotSummary {
            if (not scopeActive(appScope)) return null;
            let ?slotDeclaration = declaredSlot(appScope, slotId) else return null;
            let ?slot = Memory.get(mem, appScope, slotId) else return null;
            ?{
                slot = slot.slot_id;
                purpose = slotDeclaration.purpose;
                key_holder = slot.key_holder;
                status = slot.status;
                environment;
                current_generation = slot.current_generation;
                previous_generation = previousGeneration(slot);
                generations = generationSummaries(slot);
                created_at = slot.created_at;
                updated_at = slot.updated_at;
                last_used_at = slot.last_used_at;
                total_derivations = slot.total_derivations;
                approximate_cycle_spend = slot.approximate_cycle_spend;
            };
        };

        func declaredSlot(
            appScope : Types.AppScope,
            slotId : Text,
        ) : ?Types.SlotDeclaration {
            let ?declaration = declarationFor(appScope) else return null;
            Array.find<Types.SlotDeclaration>(
                declaration.slots,
                func(slot) { slot.id == slotId },
            );
        };

        func declarationFor(appScope : Types.AppScope) : ?Types.Declaration {
            if (not configured) return null;
            Map.get(declarations, Text.compare, Scope.key(appScope));
        };

        func slotAllowed(appScope : Types.AppScope, slotId : Text) : Bool {
            registry.allowed(appScope, #vetkeys, slotId);
        };

        func validSourceInput(
            input : Types.AppSlotInput,
            caller : Principal,
        ) : Bool {
            configured and
            not Principal.isAnonymous(caller) and
            isAuthorized(caller) and
            validAppId(input.app_id) and
            validSlotId(input.slot_id) and
            activeScope(input.app_id) != null;
        };

        func activeScope(appId : Text) : ?Types.AppScope {
            if (not configured or not validAppId(appId)) return null;
            let ?appScope = committedScope(appId) else return null;
            if (not scopeActive(appScope)) return null;
            ?appScope;
        };

        func environmentKeyName() : Text {
            switch (environment) {
                case (#production) "key_1";
                case (#local) "test_key_1";
            };
        };

        func previousGeneration(slot : Types.Slot) : ?Nat64 {
            for (generation in slot.generations.vals()) {
                if (generation.status == #previous) return ?generation.generation;
            };
            null;
        };

        func generationSummaries(
            slot : Types.Slot,
        ) : [Types.GenerationSummary] {
            Array.map<Types.Generation, Types.GenerationSummary>(
                slot.generations,
                func(generation) {
                    {
                        generation = generation.generation;
                        status = generation.status;
                        key_name = generation.key_name;
                        public_fingerprint = generation.public_fingerprint;
                    };
                },
            );
        };

        func publicInfo(
            selfPrincipal : Principal,
            slotId : Text,
            generation : Types.Generation,
            publicKey : Blob,
            fingerprint : Blob,
            derivationInput : Blob,
        ) : Types.PublicKeyInfo {
            {
                canister_principal = selfPrincipal;
                slot = slotId;
                generation = generation.generation;
                suite = SUITE;
                key_name = generation.key_name;
                public_key = publicKey;
                public_fingerprint = fingerprint;
                derivation_input = derivationInput;
            };
        };

        func generationKey(slotUid : Nat, generation : Nat64) : Text {
            Nat.toText(slotUid) # ":" # Nat64.toText(generation);
        };

        func trackInput<T>(
            input : Types.AppSlotInput,
            operation : Text,
            result : Types.OperationResult<T>,
        ) : Types.OperationResult<T> {
            if (not validSlotId(input.slot_id)) return result;
            let ?appScope = committedScope(input.app_id) else return result;
            trackScope(appScope, input.slot_id, operation, result);
        };

        func trackScope<T>(
            appScope : Types.AppScope,
            slotId : Text,
            operation : Text,
            result : Types.OperationResult<T>,
        ) : Types.OperationResult<T> {
            ignore registry.record(
                appScope,
                #vetkeys,
                slotId,
                operation,
                capabilityOutcome(result),
            );
            result;
        };

        func capabilityOutcome<T>(
            result : Types.OperationResult<T>,
        ) : CapabilityTypes.CapabilityOutcome {
            switch (result) {
                case (#ok(_)) #ok;
                case (#err(#busy)) #busy;
                case (#err(#source_gone)) #revoked;
                case (#err(#management_failure)) #failed;
                case (#err(#key_unavailable)) #failed;
                case (#err(#low_cycles)) #failed;
                case (#err(_)) #denied;
            };
        };

        func auditedPublicKey(
            appScope : Types.AppScope,
            request : Types.PublicKeyRequest,
            principal : Principal,
            result : Types.PublicKeyResult,
        ) : Types.PublicKeyResult {
            let slotUid = switch (Memory.get(mem, appScope, request.slot)) {
                case (?slot) ?slot.slot_uid;
                case null null;
            };
            let outcome : Types.AuditOutcome = switch (result) {
                case (#ok(_)) #ok;
                case (#err(#busy)) #busy;
                case (#err(#invalid_request)) #denied;
                case (#err(#owner_required)) #denied;
                case (#err(#management_failure)) #failed;
                case (#err(_)) #unavailable;
            };
            audit(
                appScope,
                slotUid,
                request.slot,
                ?request.generation,
                #public_key,
                principal,
                outcome,
                nowNanos(),
            );
            result;
        };

        func auditInput(
            input : Types.AppSlotInput,
            slotUid : ?Nat,
            action : Types.AuditAction,
            principal : Principal,
            outcome : Types.AuditOutcome,
        ) : () {
            let ?appScope = committedScope(input.app_id) else return;
            audit(
                appScope,
                slotUid,
                input.slot_id,
                null,
                action,
                principal,
                outcome,
                nowNanos(),
            );
        };

        func auditGenerationInput(
            input : Types.AppSlotInput,
            slotUid : ?Nat,
            generation : Nat64,
            action : Types.AuditAction,
            principal : Principal,
            outcome : Types.AuditOutcome,
        ) : () {
            let ?appScope = committedScope(input.app_id) else return;
            audit(
                appScope,
                slotUid,
                input.slot_id,
                ?generation,
                action,
                principal,
                outcome,
                nowNanos(),
            );
        };

        func audit(
            appScope : Types.AppScope,
            slotUid : ?Nat,
            slotId : Text,
            generation : ?Nat64,
            action : Types.AuditAction,
            auditPrincipal : Principal,
            outcome : Types.AuditOutcome,
            now : Nat64,
        ) : () {
            Memory.addAudit(mem, {
                at = now;
                scope = appScope;
                slot_uid = slotUid;
                slot_id = slotId;
                generation;
                action;
                principal = auditPrincipal;
                outcome;
            });
        };
    };

    func validateDeclaration(declaration : Types.Declaration) : () {
        assert (
            declaration.description.size() >= 1 and
            declaration.description.size() <= MAX_DESCRIPTION_CHARS
        );
        assert (
            declaration.slots.size() >= 1 and
            declaration.slots.size() <= Memory.MAX_SLOTS_PER_APP
        );
        let seen = Set.empty<Text>();
        for (slot in declaration.slots.vals()) {
            assert (validSlotId(slot.id));
            assert (slot.purpose.size() >= 1 and slot.purpose.size() <= MAX_PURPOSE_CHARS);
            assert (Set.insert(seen, Text.compare, slot.id));
        };
    };

    func validAppId(value : Text) : Bool {
        Scope.validAppId(value);
    };

    func validSlotId(value : Text) : Bool {
        validIdentifier(value, 1, 40, true);
    };

    func validIdentifier(
        value : Text,
        minimum : Nat,
        maximum : Nat,
        requireLeadingLetter : Bool,
    ) : Bool {
        if (value.size() < minimum or value.size() > maximum) return false;
        var first = true;
        for (char in value.chars()) {
            if (
                first and requireLeadingLetter and
                not (char >= 'a' and char <= 'z')
            ) return false;
            if (
                not (
                    (char >= 'a' and char <= 'z') or
                    (char >= '0' and char <= '9') or
                    char == '_'
                )
            ) return false;
            first := false;
        };
        true;
    };

    func nowNanos() : Nat64 {
        Nat64.fromNat(Int.abs(Time.now()));
    };
};
