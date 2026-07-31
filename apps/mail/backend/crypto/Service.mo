import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat32 "mo:core/Nat32";
import Principal "mo:core/Principal";
import Set "mo:core/Set";
import Sha256 "mo:sha2/Sha256";
import Text "mo:core/Text";
import Memory "../memory/mail/v1";
import Envelope "../protocol/Envelope";
import KeyInfo "../protocol/KeyInfo";
import Types "Types";

module {
    public let SLOT_ID = Types.SLOT_ID;
    public let MAX_REWRAP_BATCH = Types.MAX_REWRAP_BATCH;
    public type SlotStatus = Types.SlotStatus;
    public type GenerationStatus = Types.GenerationStatus;
    public type Environment = Types.Environment;
    public type GenerationSummary = Types.GenerationSummary;
    public type SlotSummary = Types.SlotSummary;
    public type PublicKeyMaterial = Types.PublicKeyMaterial;
    public type PublicKeyError = Types.PublicKeyError;
    public type PublicKeyResult = Types.PublicKeyResult;
    public type VetKeysPublic = Types.VetKeysPublic;
    public type ReferenceCounts = Types.ReferenceCounts;
    public type Progress = Types.Progress;
    public type Error = Types.Error;
    public type Result = Types.Result;
    public type Start = Types.Start;
    public type Dispatch = Types.Dispatch;
    public type RewrapTarget = Types.RewrapTarget;
    public type RewrapRequest = Types.RewrapRequest;
    public type RewrapResult = Types.RewrapResult;

    public class Service(mem : Memory.Mem, vetkeys : VetKeysPublic) {
        // Remote Neutrons may encrypt only to the exact key that is still the
        // live, enabled current generation of Mail's reserved kernel slot.
        // The cached Mail record intentionally does not trust itself here:
        // disable, manifest suspension, rotation, retirement/re-reservation,
        // or a changed management public key must fail closed immediately.
        // A lifecycle-manager transfer is deliberately not part of the
        // cryptographic binding and therefore remains seamless.
        public func deliveryKeyInfo() : ?Memory.PublicKeyInfo {
            let info = switch (configured()) {
                case (#err(_)) return null;
                case (#ok(value)) value;
            };
            let slot = switch (readEnabledSlot(vetkeys)) {
                case (#err(_)) return null;
                case (#ok(value)) value;
            };
            if (slot.current_generation != info.current_epoch) return null;

            let expectedPublicFingerprint = Sha256.fromBlob(
                #sha256,
                info.context_public_key,
            );
            for (generation in slot.generations.vals()) {
                if (
                    generation.generation == info.current_epoch and
                    generation.status == #current
                ) {
                    let ?livePublicFingerprint = generation.public_fingerprint else {
                        return null;
                    };
                    if (Blob.equal(
                        livePublicFingerprint,
                        expectedPublicFingerprint,
                    )) return ?info;
                    return null;
                };
            };
            null;
        };

        public func setupStart() : Start {
            if (mem.key_info != null) return #err(#already_configured);
            let slot = switch (readEnabledSlot(vetkeys)) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            if (slot.previous_generation != null) {
                return #err(#rotation_in_progress);
            };
            #dispatch({ mode = #setup; slot; previous_key_info = null });
        };

        public func setupFinish(
            dispatch : Dispatch,
            response : PublicKeyResult,
        ) : Result {
            if (dispatch.mode != #setup or dispatch.previous_key_info != null) {
                return #err(#invalid_request);
            };
            if (mem.key_info != null) return #err(#capability_changed);
            let slot = switch (matchingSlot(dispatch.slot)) {
                case null return #err(#capability_changed);
                case (?value) value;
            };
            let material = switch (response) {
                case (#err(error)) return #err(#vetkeys(error));
                case (#ok(value)) value;
            };
            let info = switch (buildKeyInfo(
                slot,
                material,
                vetkeys.canister_principal,
                null,
            )) {
                case null return #err(#corrupt_state);
                case (?value) value;
            };
            mem.key_info := ?info;
            progress();
        };

        public func rotateStart() : Start {
            let current = switch (configured()) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            let slot = switch (readEnabledSlot(vetkeys)) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            if (slot.current_generation == current.current_epoch) {
                if (slot.previous_generation == current.previous_epoch) {
                    return switch (progress()) {
                        case (#ok(value)) #complete(value);
                        case (#err(error)) #err(error);
                    };
                };

                // The kernel may remove previous only after Mail reports no
                // references. Clearing cached previous is therefore safe only
                // after an exact local reference scan.
                switch (current.previous_epoch, slot.previous_generation) {
                    case (?_, null) {
                        let references = switch (referenceCounts(current)) {
                            case (#err(error)) return #err(error);
                            case (#ok(value)) value;
                        };
                        if (references.total != 0) {
                            return #err(#previous_references(references));
                        };
                        mem.key_info := ?{
                            current with
                            previous_epoch = null;
                            previous_fingerprint = null;
                        };
                        return switch (progress()) {
                            case (#ok(value)) #complete(value);
                            case (#err(error)) #err(error);
                        };
                    };
                    case (_) return #err(#capability_changed);
                };
            };

            if (current.previous_epoch != null) {
                return #err(#rotation_in_progress);
            };
            if (slot.previous_generation != ?current.current_epoch) {
                return #err(#rotation_not_ready);
            };
            #dispatch({
                mode = #rotate;
                slot;
                previous_key_info = ?current;
            });
        };

        public func rotateFinish(
            dispatch : Dispatch,
            response : PublicKeyResult,
        ) : Result {
            if (dispatch.mode != #rotate) return #err(#invalid_request);
            let ?before = dispatch.previous_key_info else {
                return #err(#invalid_request);
            };
            let current = switch (configured()) {
                case (#err(_)) return #err(#capability_changed);
                case (#ok(value)) value;
            };
            if (not sameKeyInfo(current, before)) {
                return #err(#capability_changed);
            };
            if (
                dispatch.slot.previous_generation != ?before.current_epoch or
                dispatch.slot.current_generation == before.current_epoch
            ) return #err(#capability_changed);

            let slot = switch (matchingSlot(dispatch.slot)) {
                case null return #err(#capability_changed);
                case (?value) value;
            };

            let material = switch (response) {
                case (#err(error)) return #err(#vetkeys(error));
                case (#ok(value)) value;
            };
            let next = switch (buildKeyInfo(
                slot,
                material,
                vetkeys.canister_principal,
                ?(before.current_epoch, before.current_fingerprint),
            )) {
                case null return #err(#corrupt_state);
                case (?value) value;
            };
            mem.key_info := ?next;
            progress();
        };

        public func status() : Result {
            progress();
        };

        public func rewrap(request : RewrapRequest) : RewrapResult {
            let info = switch (configured()) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            let (?previousEpoch, ?previousFingerprint) = (
                info.previous_epoch,
                info.previous_fingerprint,
            ) else return #err(#rotation_not_ready);
            if (
                request.expected_current_epoch != info.current_epoch or
                request.expected_previous_epoch != previousEpoch or
                request.targets.size() == 0 or
                request.targets.size() > MAX_REWRAP_BATCH
            ) return #err(#invalid_request);

            let seen = Set.empty<Text>();
            var messageChanges = 0;
            var settingsChange = false;
            for (target in request.targets.vals()) {
                let key = targetKey(target);
                if (not Set.insert(seen, Text.compare, key)) {
                    return #err(#invalid_request);
                };
                switch (validateTarget(
                    target,
                    previousEpoch,
                    previousFingerprint,
                )) {
                    case (#err(error)) return #err(error);
                    case (#ok(#settings)) settingsChange := true;
                    case (#ok(#message)) messageChanges += 1;
                };
            };

            for (target in request.targets.vals()) applyTarget(target, info);
            if (messageChanges > 0) mem.revision += 1;
            let updated = switch (progress()) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            #ok({
                changed = request.targets.size();
                message_wraps_changed = messageChanges;
                settings_wrap_changed = settingsChange;
                progress = updated;
            });
        };

    func validateTarget(
            target : RewrapTarget,
            previousEpoch : Nat64,
            previousFingerprint : Blob,
        ) : { #ok : { #settings; #message }; #err : Error } {
            switch (target) {
                case (#settings(request)) {
                    let ?stored = mem.encrypted_settings else {
                        return #err(#revision_conflict);
                    };
                    if (
                        stored.revision != request.expected_revision or
                        stored.local_wrap_epoch != previousEpoch or
                        not Blob.equal(stored.local_wrap_fingerprint, previousFingerprint) or
                        not Blob.equal(
                            stored.local_wrapped_cek,
                            request.expected_local_wrapped_cek,
                        )
                    ) return #err(#revision_conflict);
                    if (not validReplacement(
                        request.expected_local_wrapped_cek,
                        request.replacement_local_wrapped_cek,
                    )) return #err(#invalid_request);
                    #ok(#settings);
                };
                case (#inbox(request)) {
                    let ?stored = Map.get(mem.inbox, Nat.compare, request.local_id) else {
                        return #err(#revision_conflict);
                    };
                    if (not exactPreviousWrap(
                        stored.local_wrap_epoch,
                        stored.local_wrap_fingerprint,
                        stored.local_wrapped_cek,
                        previousEpoch,
                        previousFingerprint,
                        request.expected_local_wrapped_cek,
                    )) return #err(#revision_conflict);
                    if (not validReplacement(
                        request.expected_local_wrapped_cek,
                        request.replacement_local_wrapped_cek,
                    )) return #err(#invalid_request);
                    #ok(#message);
                };
                case (#outbox(request)) {
                    let ?stored = Map.get(mem.outbox, Nat.compare, request.local_id) else {
                        return #err(#revision_conflict);
                    };
                    if (not exactPreviousWrap(
                        stored.local_wrap_epoch,
                        stored.local_wrap_fingerprint,
                        stored.local_wrapped_cek,
                        previousEpoch,
                        previousFingerprint,
                        request.expected_local_wrapped_cek,
                    )) return #err(#revision_conflict);
                    if (not validReplacement(
                        request.expected_local_wrapped_cek,
                        request.replacement_local_wrapped_cek,
                    )) return #err(#invalid_request);
                    #ok(#message);
                };
            };
        };

    func applyTarget(
        target : RewrapTarget,
        info : Memory.PublicKeyInfo,
    ) : () {
            switch (target) {
                case (#settings(request)) {
                    let ?stored = mem.encrypted_settings else {
                        assert false;
                        loop {};
                    };
                    mem.encrypted_settings := ?{
                        stored with
                        local_wrap_epoch = info.current_epoch;
                        local_wrap_fingerprint = info.current_fingerprint;
                        local_wrapped_cek = request.replacement_local_wrapped_cek;
                    };
                };
                case (#inbox(request)) {
                    let ?stored = Map.get(mem.inbox, Nat.compare, request.local_id) else {
                        assert false;
                        loop {};
                    };
                    Map.add(mem.inbox, Nat.compare, request.local_id, {
                        stored with
                        local_wrap_epoch = info.current_epoch;
                        local_wrap_fingerprint = info.current_fingerprint;
                        local_wrapped_cek = request.replacement_local_wrapped_cek;
                    });
                };
                case (#outbox(request)) {
                    let ?stored = Map.get(mem.outbox, Nat.compare, request.local_id) else {
                        assert false;
                        loop {};
                    };
                    Map.add(mem.outbox, Nat.compare, request.local_id, {
                        stored with
                        local_wrap_epoch = info.current_epoch;
                        local_wrap_fingerprint = info.current_fingerprint;
                        local_wrapped_cek = request.replacement_local_wrapped_cek;
                    });
                };
            };
        };

    func progress() : Result {
            let info = switch (configured()) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            let references = switch (referenceCounts(info)) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            let liveKeyHolder = switch (readEnabledSlot(vetkeys)) {
                case (#ok(slot)) {
                    if (
                        slot.current_generation == info.current_epoch and
                        slot.previous_generation == info.previous_epoch
                    ) slot.key_holder else info.key_holder;
                };
                case (#err(_)) info.key_holder;
            };
            #ok({
                mail_revision = mem.revision;
                key_holder = liveKeyHolder;
                current_epoch = info.current_epoch;
                previous_epoch = info.previous_epoch;
                previous_references = references;
                ready_to_retire = info.previous_epoch != null and references.total == 0;
            });
        };

    func referenceCounts(
            info : Memory.PublicKeyInfo,
        ) : { #ok : ReferenceCounts; #err : Error } {
            if (
                Map.size(mem.inbox) > Types.MAX_INBOX_RECORDS or
                Map.size(mem.outbox) > Types.MAX_OUTBOX_RECORDS
            ) return #err(#corrupt_state);
            var settingsCount = 0;
            var inboxCount = 0;
            var outboxCount = 0;

            switch (mem.encrypted_settings) {
                case null {};
                case (?settings) {
                    switch (classifyWrap(
                        settings.local_wrap_epoch,
                        settings.local_wrap_fingerprint,
                        settings.local_wrapped_cek,
                        info,
                    )) {
                        case (#previous) settingsCount := 1;
                        case (#current) {};
                        case (#invalid) return #err(#corrupt_state);
                    };
                };
            };
            for (record in Map.values(mem.inbox)) {
                switch (classifyWrap(
                    record.local_wrap_epoch,
                    record.local_wrap_fingerprint,
                    record.local_wrapped_cek,
                    info,
                )) {
                    case (#previous) inboxCount += 1;
                    case (#current) {};
                    case (#invalid) return #err(#corrupt_state);
                };
            };
            for (record in Map.values(mem.outbox)) {
                switch (classifyWrap(
                    record.local_wrap_epoch,
                    record.local_wrap_fingerprint,
                    record.local_wrapped_cek,
                    info,
                )) {
                    case (#previous) outboxCount += 1;
                    case (#current) {};
                    case (#invalid) return #err(#corrupt_state);
                };
            };
            #ok({
                settings = settingsCount;
                inbox = inboxCount;
                outbox = outboxCount;
                total = settingsCount + inboxCount + outboxCount;
            });
        };

    func configured() : { #ok : Memory.PublicKeyInfo; #err : Error } {
            let ?info = mem.key_info else return #err(#not_configured);
            if (not KeyInfo.validConfigured(info)) return #err(#corrupt_state);
            #ok(info);
        };

    func readEnabledSlot(vetkeys : VetKeysPublic) : { #ok : SlotSummary; #err : Error } {
            let ?slot = vetkeys.slot(SLOT_ID) else return #err(#not_reserved);
            if (
                slot.slot != SLOT_ID or
                Principal.isAnonymous(slot.key_holder) or
                slot.current_generation == 0 or
                slot.previous_generation == ?slot.current_generation or
                not validGenerations(slot)
            ) return #err(#corrupt_state);
            switch (slot.status) {
                case (#enabled) #ok(slot);
                case (#disabled) #err(#disabled);
                case (#manifest_suspended) #err(#manifest_suspended);
            };
        };

    func matchingSlot(expected : SlotSummary) : ?SlotSummary {
            let actual = switch (readEnabledSlot(vetkeys)) {
                case (#err(_)) return null;
                case (#ok(value)) value;
            };
            if (
            actual.slot == expected.slot and
            actual.purpose == expected.purpose and
            actual.environment == expected.environment and
            actual.current_generation == expected.current_generation and
            actual.previous_generation == expected.previous_generation and
            actual.created_at == expected.created_at and
            generationBindingsCompatible(actual.generations, expected.generations)
            ) ?actual else null;
        };

    func buildKeyInfo(
        slot : SlotSummary,
        material : PublicKeyMaterial,
        canisterPrincipal : Principal,
        previous : ?(Nat64, Blob),
    ) : ?Memory.PublicKeyInfo {
        if (
            not Principal.equal(
                material.canister_principal,
                canisterPrincipal,
            ) or
            material.slot != SLOT_ID or
            material.generation != slot.current_generation or
            material.suite != "bls12_381_g2" or
            material.public_key.size() != 96 or
            material.public_fingerprint.size() != Envelope.FINGERPRINT_BYTES or
            KeyInfo.isZero(material.public_fingerprint) or
            material.derivation_input.size() != 32 or
            KeyInfo.isZero(material.derivation_input) or
            not validMaterialGeneration(slot, material)
        ) return null;
        let fingerprint = KeyInfo.fingerprint(
            1,
            material.generation,
            material.public_key,
            material.derivation_input,
        );
        let (previousEpoch, previousFingerprint) = switch (previous) {
            case null (null, null);
            case (?(epoch, oldFingerprint)) (?epoch, ?oldFingerprint);
        };
        let info : Memory.PublicKeyInfo = {
            protocol_version = Envelope.VERSION;
            suite = 1;
            key_holder = slot.key_holder;
            current_epoch = material.generation;
            current_fingerprint = fingerprint;
            context_public_key = material.public_key;
            effective_ibe_identity = material.derivation_input;
            max_envelope_bytes = Nat32.fromNat(Envelope.MAX_ENVELOPE_BYTES);
            previous_epoch = previousEpoch;
            previous_fingerprint = previousFingerprint;
        };
        if (not KeyInfo.validConfigured(info)) return null;
        ?info;
    };

    func validGenerations(slot : SlotSummary) : Bool {
        if (slot.generations.size() == 0 or slot.generations.size() > 2) {
            return false;
        };
        var current = 0;
        var previous = 0;
        for (generation in slot.generations.vals()) {
            if (
                generation.generation == 0 or
                not validEnvironmentKey(slot.environment, generation.key_name)
            ) return false;
            switch (generation.status) {
                case (#current) {
                    if (generation.generation != slot.current_generation) return false;
                    current += 1;
                };
                case (#previous) {
                    if (slot.previous_generation != ?generation.generation) return false;
                    previous += 1;
                };
            };
            switch (generation.public_fingerprint) {
                case null {};
                case (?value) if (
                    value.size() != Envelope.FINGERPRINT_BYTES or KeyInfo.isZero(value)
                ) return false;
                case (_) {};
            };
        };
        current == 1 and (
            (slot.previous_generation == null and previous == 0) or
            (slot.previous_generation != null and previous == 1)
        );
    };

    func validMaterialGeneration(
        slot : SlotSummary,
        material : PublicKeyMaterial,
    ) : Bool {
        for (generation in slot.generations.vals()) {
            if (
                generation.generation == material.generation and
                generation.status == #current and
                generation.key_name == material.key_name
            ) {
                switch (generation.public_fingerprint) {
                    case null return true;
                    case (?fingerprint) {
                        return Blob.equal(fingerprint, material.public_fingerprint);
                    };
                };
            };
        };
        false;
    };

    func generationBindingsCompatible(
        actual : [GenerationSummary],
        expected : [GenerationSummary],
    ) : Bool {
        if (actual.size() != expected.size()) return false;
        for (left in actual.vals()) {
            var found = false;
            for (right in expected.vals()) {
                if (
                    left.generation == right.generation and
                    left.status == right.status and
                    left.key_name == right.key_name and
                    fingerprintCompatible(
                        left.public_fingerprint,
                        right.public_fingerprint,
                    )
                ) found := true;
            };
            if (not found) return false;
        };
        true;
    };

    // A public-key call may populate a previously empty kernel cache. An
    // existing fingerprint may never disappear or change during the await.
    func fingerprintCompatible(actual : ?Blob, expected : ?Blob) : Bool {
        switch (actual, expected) {
            case (_, null) true;
            case (?left, ?right) Blob.equal(left, right);
            case (null, ?_) false;
        };
    };

    func validEnvironmentKey(environment : Environment, keyName : Text) : Bool {
        switch (environment) {
            case (#production) keyName == "key_1";
            case (#local) keyName == "test_key_1";
        };
    };

    func classifyWrap(
        epoch : Nat64,
        fingerprint : Blob,
        wrappedCek : Blob,
        info : Memory.PublicKeyInfo,
    ) : { #current; #previous; #invalid } {
        if (
            wrappedCek.size() != Envelope.WRAPPED_CEK_BYTES or
            KeyInfo.isZero(wrappedCek)
        ) return #invalid;
        if (
            epoch == info.current_epoch and
            Blob.equal(fingerprint, info.current_fingerprint)
        ) return #current;
        switch (info.previous_epoch, info.previous_fingerprint) {
            case (?previousEpoch, ?previousFingerprint) {
                if (
                    epoch == previousEpoch and
                    Blob.equal(fingerprint, previousFingerprint)
                ) #previous else #invalid;
            };
            case (_) #invalid;
        };
    };

    func exactPreviousWrap(
        epoch : Nat64,
        fingerprint : Blob,
        wrappedCek : Blob,
        previousEpoch : Nat64,
        previousFingerprint : Blob,
        expectedWrappedCek : Blob,
    ) : Bool {
        epoch == previousEpoch and
        Blob.equal(fingerprint, previousFingerprint) and
        Blob.equal(wrappedCek, expectedWrappedCek);
    };

    func validReplacement(previous : Blob, replacement : Blob) : Bool {
        replacement.size() == Envelope.WRAPPED_CEK_BYTES and
        not KeyInfo.isZero(replacement) and
        not Blob.equal(previous, replacement);
    };

    func targetKey(target : RewrapTarget) : Text {
        switch (target) {
            case (#settings(_)) "s";
            case (#inbox(request)) "i:" # Nat.toText(request.local_id);
            case (#outbox(request)) "o:" # Nat.toText(request.local_id);
        };
    };

    func sameKeyInfo(left : Memory.PublicKeyInfo, right : Memory.PublicKeyInfo) : Bool {
        left.protocol_version == right.protocol_version and
        left.suite == right.suite and
        left.current_epoch == right.current_epoch and
        Blob.equal(left.current_fingerprint, right.current_fingerprint) and
        Blob.equal(left.context_public_key, right.context_public_key) and
        Blob.equal(left.effective_ibe_identity, right.effective_ibe_identity) and
        left.max_envelope_bytes == right.max_envelope_bytes and
        left.previous_epoch == right.previous_epoch and
        optionalBlobEqual(left.previous_fingerprint, right.previous_fingerprint);
    };

    func optionalBlobEqual(left : ?Blob, right : ?Blob) : Bool {
        switch (left, right) {
            case (null, null) true;
            case (?a, ?b) Blob.equal(a, b);
            case (_) false;
        };
    };
    };
};
