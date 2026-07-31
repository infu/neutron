import Array "mo:core/Array";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Scope "../capabilities/Scope";
import Types "Types";

module {
    public let MAX_SLOTS_PER_APP : Nat = 4;
    // Keep in sync with VETKEYS_MAX_SLOTS_GLOBAL in the manifest catalog.
    public let MAX_SLOTS_TOTAL : Nat = 128;
    public let MAX_TOMBSTONES : Nat = 128;
    public let MAX_AUDIT_ENTRIES : Nat = 256;
    public let NAMESPACE_NONCE_BYTES : Nat = 32;
    public let NAMESPACE_VERSION : Nat = 1;
    public let MAX_COUNTER_VALUE : Nat = 18_446_744_073_709_551_615;
    let MAX_NAT64 : Nat64 = 18_446_744_073_709_551_615;

    public func init() : Types.Memory {
        {
            var next_slot_uid = 1;
            slots_by_uid = Map.empty<Nat, Types.Slot>();
            slot_index_by_scope_and_id = Map.empty<Text, Nat>();
            var retired_tombstones = [];
            var audit = [];
        };
    };

    public func reserve(
        mem : Types.Memory,
        input : Types.ReserveInput,
    ) : Types.Result<Types.SlotSummary> {
        if (
            not validAppId(input.scope.app_id) or
            input.scope.installation_uid == 0
        ) return #err(#invalid_app_id);
        if (not validSlotId(input.slot_id)) return #err(#invalid_slot_id);
        if (input.namespace_nonce.size() != NAMESPACE_NONCE_BYTES) {
            return #err(#invalid_namespace_nonce);
        };
        if (Principal.isAnonymous(input.key_holder)) {
            return #err(#invalid_key_holder);
        };
        if (not validKeyName(input.key_name)) return #err(#invalid_key_name);

        switch (get(mem, input.scope, input.slot_id)) {
            case (?existing) return #ok(summary(existing));
            case null {};
        };
        if (Map.size(mem.slots_by_uid) >= MAX_SLOTS_TOTAL) {
            return #err(#slot_limit);
        };
        if (appSlotCount(mem, input.scope) >= MAX_SLOTS_PER_APP) {
            return #err(#app_slot_limit);
        };

        let generation : Types.Generation = {
            generation = 1;
            status = #current;
            namespace_version = NAMESPACE_VERSION;
            key_name = input.key_name;
            cached_public_key = null;
            public_fingerprint = null;
            created_at = input.now;
            created_by = input.changed_by;
        };
        let slot : Types.Slot = {
            slot_uid = mem.next_slot_uid;
            scope = input.scope;
            slot_id = input.slot_id;
            namespace_nonce = input.namespace_nonce;
            key_holder = input.key_holder;
            status = #enabled;
            current_generation = 1;
            next_generation = 2;
            generations = [generation];
            created_at = input.now;
            created_by = input.changed_by;
            updated_at = input.now;
            updated_by = input.changed_by;
            last_used_at = null;
            total_derivations = 0;
            approximate_cycle_spend = 0;
        };
        mem.next_slot_uid += 1;
        Map.add(mem.slots_by_uid, Nat.compare, slot.slot_uid, slot);
        Map.add(
            mem.slot_index_by_scope_and_id,
            Text.compare,
            indexKey(slot.scope, slot.slot_id),
            slot.slot_uid,
        );
        #ok(summary(slot));
    };

    public func get(
        mem : Types.Memory,
        appScope : Types.AppScope,
        slotId : Text,
    ) : ?Types.Slot {
        let ?uid = Map.get(
            mem.slot_index_by_scope_and_id,
            Text.compare,
            indexKey(appScope, slotId),
        ) else return null;
        let ?slot = Map.get(mem.slots_by_uid, Nat.compare, uid) else return null;
        if (not Scope.equal(slot.scope, appScope) or slot.slot_id != slotId) {
            return null;
        };
        ?slot;
    };

    public func getByUidForScope(
        mem : Types.Memory,
        appScope : Types.AppScope,
        uid : Nat,
    ) : ?Types.Slot {
        let ?slot = Map.get(mem.slots_by_uid, Nat.compare, uid) else return null;
        if (not Scope.equal(slot.scope, appScope)) return null;
        ?slot;
    };

    public func listScope(
        mem : Types.Memory,
        appScope : Types.AppScope,
    ) : [Types.SlotSummary] {
        let result = List.empty<Types.SlotSummary>();
        for (slot in Map.values(mem.slots_by_uid)) {
            if (Scope.equal(slot.scope, appScope)) {
                List.add(result, summary(slot));
            };
        };
        List.toArray(result);
    };

    public func generation(
        mem : Types.Memory,
        appScope : Types.AppScope,
        slotId : Text,
        generationNumber : Nat64,
    ) : ?Types.Generation {
        let ?slot = get(mem, appScope, slotId) else return null;
        Array.find<Types.Generation>(
            slot.generations,
            func(candidate) { candidate.generation == generationNumber },
        );
    };

    public func cachePublicKey(
        mem : Types.Memory,
        appScope : Types.AppScope,
        slotId : Text,
        generationNumber : Nat64,
        publicKey : Blob,
        fingerprint : Blob,
    ) : Types.Result<Types.Generation> {
        if (publicKey.size() != 96 or fingerprint.size() != 32) {
            return #err(#invariant_violation);
        };
        let ?slot = get(mem, appScope, slotId) else return #err(#not_found);
        var found : ?Types.Generation = null;
        let generations = Array.map<Types.Generation, Types.Generation>(
            slot.generations,
            func(candidate) {
                if (candidate.generation != generationNumber) return candidate;
                let updated = {
                    candidate with
                    cached_public_key = ?publicKey;
                    public_fingerprint = ?fingerprint;
                };
                found := ?updated;
                updated;
            },
        );
        let ?updatedGeneration = found else return #err(#generation_not_found);
        put(mem, { slot with generations });
        #ok(updatedGeneration);
    };

    public func setStatus(
        mem : Types.Memory,
        appScope : Types.AppScope,
        slotId : Text,
        status : Types.SlotStatus,
        changedBy : Principal,
        now : Nat64,
    ) : Types.Result<Types.SlotSummary> {
        let ?slot = get(mem, appScope, slotId) else return #err(#not_found);
        let updated = {
            slot with
            status;
            updated_at = now;
            updated_by = changedBy;
        };
        put(mem, updated);
        #ok(summary(updated));
    };

    public func transfer(
        mem : Types.Memory,
        appScope : Types.AppScope,
        slotId : Text,
        currentHolder : Principal,
        newHolder : Principal,
        changedBy : Principal,
        now : Nat64,
    ) : Types.Result<Types.SlotSummary> {
        let ?slot = get(mem, appScope, slotId) else return #err(#not_found);
        if (not Principal.equal(slot.key_holder, currentHolder)) {
            return #err(#owner_required);
        };
        if (Principal.isAnonymous(newHolder)) return #err(#invalid_key_holder);
        let updated = {
            slot with
            key_holder = newHolder;
            updated_at = now;
            updated_by = changedBy;
        };
        put(mem, updated);
        #ok(summary(updated));
    };

    public func rotate(
        mem : Types.Memory,
        appScope : Types.AppScope,
        slotId : Text,
        keyName : Text,
        changedBy : Principal,
        now : Nat64,
    ) : Types.Result<Types.SlotSummary> {
        let ?slot = get(mem, appScope, slotId) else return #err(#not_found);
        if (slot.generations.size() >= 2) return #err(#previous_exists);
        if (not validKeyName(keyName) or slot.next_generation == MAX_NAT64) {
            return #err(#invariant_violation);
        };
        let ?current = currentGeneration(slot) else {
            return #err(#invariant_violation);
        };
        let previous = { current with status = #previous };
        let next : Types.Generation = {
            generation = slot.next_generation;
            status = #current;
            namespace_version = NAMESPACE_VERSION;
            key_name = keyName;
            cached_public_key = null;
            public_fingerprint = null;
            created_at = now;
            created_by = changedBy;
        };
        let updated = {
            slot with
            current_generation = next.generation;
            next_generation = next.generation + 1;
            generations = [next, previous];
            updated_at = now;
            updated_by = changedBy;
        };
        put(mem, updated);
        #ok(summary(updated));
    };

    public func retireGeneration(
        mem : Types.Memory,
        appScope : Types.AppScope,
        slotId : Text,
        generation : Nat64,
        changedBy : Principal,
        now : Nat64,
    ) : Types.Result<Types.SlotSummary> {
        let ?slot = get(mem, appScope, slotId) else return #err(#not_found);
        if (generation == slot.current_generation) return #err(#current_generation);
        let retained = Array.filter<Types.Generation>(
            slot.generations,
            func(candidate) { candidate.generation != generation },
        );
        if (retained.size() == slot.generations.size()) {
            return #err(#generation_not_found);
        };
        let updated = {
            slot with
            generations = retained;
            updated_at = now;
            updated_by = changedBy;
        };
        put(mem, updated);
        #ok(summary(updated));
    };

    public func markUsed(
        mem : Types.Memory,
        appScope : Types.AppScope,
        slotId : Text,
        now : Nat64,
    ) : Types.Result<Types.SlotSummary> {
        let ?slot = get(mem, appScope, slotId) else return #err(#not_found);
        let updated = { slot with last_used_at = ?now };
        put(mem, updated);
        #ok(summary(updated));
    };

    // Lifetime accounting is updated immediately before management dispatch.
    // It never gates an authorized derivation.
    public func recordDerivation(
        mem : Types.Memory,
        appScope : Types.AppScope,
        slotId : Text,
        now : Nat64,
    ) : Types.Result<Types.SlotSummary> {
        let ?slot = get(mem, appScope, slotId) else return #err(#not_found);
        let updated = {
            slot with
            total_derivations = saturatingAdd(slot.total_derivations, 1);
            last_used_at = ?now;
        };
        put(mem, updated);
        #ok(summary(updated));
    };

    public func recordCycleSpend(
        mem : Types.Memory,
        appScope : Types.AppScope,
        slotUid : Nat,
        amount : Nat,
    ) : Bool {
        let ?slot = getByUidForScope(mem, appScope, slotUid) else return false;
        put(mem, {
            slot with
            approximate_cycle_spend = saturatingAdd(
                slot.approximate_cycle_spend,
                amount,
            );
        });
        true;
    };

    public func addAudit(mem : Types.Memory, entry : Types.AuditEntry) : () {
        let appended = Array.concat<Types.AuditEntry>(mem.audit, [entry]);
        if (appended.size() <= MAX_AUDIT_ENTRIES) {
            mem.audit := appended;
            return;
        };
        let start = appended.size() - MAX_AUDIT_ENTRIES;
        mem.audit := Array.tabulate<Types.AuditEntry>(
            MAX_AUDIT_ENTRIES,
            func(index) { appended[start + index] },
        );
    };

    public func auditSnapshot(mem : Types.Memory) : [Types.AuditEntry] {
        mem.audit;
    };

    public func suspendIncompatible(
        mem : Types.Memory,
        supports : (Types.AppScope, Text) -> Bool,
        changedBy : Principal,
        now : Nat64,
    ) : () {
        let updates = List.empty<Types.Slot>();
        for (slot in Map.values(mem.slots_by_uid)) {
            if (not supports(slot.scope, slot.slot_id)) {
                List.add(updates, {
                    slot with
                    status = #manifest_suspended;
                    updated_at = now;
                    updated_by = changedBy;
                });
            };
        };
        for (slot in List.values(updates)) put(mem, slot);
    };

    public func retireSlot(
        mem : Types.Memory,
        appScope : Types.AppScope,
        slotId : Text,
        reason : Types.RetirementReason,
        changedBy : Principal,
        now : Nat64,
    ) : Types.Result<()> {
        let ?slot = get(mem, appScope, slotId) else return #err(#not_found);
        ignore Map.delete(mem.slots_by_uid, Nat.compare, slot.slot_uid);
        ignore Map.delete(
            mem.slot_index_by_scope_and_id,
            Text.compare,
            indexKey(appScope, slotId),
        );
        appendTombstone(mem, {
            slot_uid = slot.slot_uid;
            retired_at = now;
            retired_by = changedBy;
            reason;
        });
        #ok(());
    };

    public func retireScope(
        mem : Types.Memory,
        appScope : Types.AppScope,
        changedBy : Principal,
        now : Nat64,
    ) : Nat {
        let slotIds = List.empty<Text>();
        for (slot in Map.values(mem.slots_by_uid)) {
            if (Scope.equal(slot.scope, appScope)) List.add(slotIds, slot.slot_id);
        };
        var retired = 0;
        for (slotId in List.values(slotIds)) {
            switch (retireSlot(
                mem,
                appScope,
                slotId,
                #app_uninstalled,
                changedBy,
                now,
            )) {
                case (#ok(_)) retired += 1;
                case (#err(_)) {};
            };
        };
        retired;
    };

    public func rebuildIndex(mem : Types.Memory) : Bool {
        if (Map.size(mem.slots_by_uid) > MAX_SLOTS_TOTAL) return false;
        if (mem.retired_tombstones.size() > MAX_TOMBSTONES) return false;
        if (mem.audit.size() > MAX_AUDIT_ENTRIES) return false;
        let rebuilt = Map.empty<Text, Nat>();
        let appCounts = Map.empty<Text, Nat>();
        var maximumUid = 0;
        for ((uid, slot) in Map.entries(mem.slots_by_uid)) {
            if (
                uid != slot.slot_uid or
                not validSlot(slot) or
                Map.containsKey(
                    rebuilt,
                    Text.compare,
                    indexKey(slot.scope, slot.slot_id),
                )
            ) return false;
            let scopeKey = Scope.key(slot.scope);
            let count = switch (Map.get(appCounts, Text.compare, scopeKey)) {
                case (?value) value + 1;
                case null 1;
            };
            if (count > MAX_SLOTS_PER_APP) return false;
            Map.add(appCounts, Text.compare, scopeKey, count);
            Map.add(rebuilt, Text.compare, indexKey(slot.scope, slot.slot_id), uid);
            if (uid > maximumUid) maximumUid := uid;
        };
        for (entry in mem.audit.vals()) {
            if (
                not validAppId(entry.scope.app_id) or
                entry.scope.installation_uid == 0 or
                not validSlotId(entry.slot_id)
            ) return false;
            switch (entry.slot_uid) {
                case (?uid) {
                    if (uid == 0 or uid >= mem.next_slot_uid) return false;
                };
                case null {};
            };
        };
        if (mem.next_slot_uid <= maximumUid) return false;
        if (not validTombstones(mem)) return false;

        Map.clear(mem.slot_index_by_scope_and_id);
        for ((key, uid) in Map.entries(rebuilt)) {
            Map.add(mem.slot_index_by_scope_and_id, Text.compare, key, uid);
        };
        true;
    };

    public func summary(slot : Types.Slot) : Types.SlotSummary {
        {
            slot_uid = slot.slot_uid;
            app_id = slot.scope.app_id;
            installation_uid = slot.scope.installation_uid;
            slot_id = slot.slot_id;
            key_holder = slot.key_holder;
            status = slot.status;
            current_generation = slot.current_generation;
            previous_generation = previousGeneration(slot);
            created_at = slot.created_at;
            updated_at = slot.updated_at;
            last_used_at = slot.last_used_at;
            total_derivations = slot.total_derivations;
            approximate_cycle_spend = slot.approximate_cycle_spend;
        };
    };

    func put(mem : Types.Memory, slot : Types.Slot) : () {
        Map.add(mem.slots_by_uid, Nat.compare, slot.slot_uid, slot);
    };

    func appSlotCount(mem : Types.Memory, appScope : Types.AppScope) : Nat {
        var count = 0;
        for (slot in Map.values(mem.slots_by_uid)) {
            if (Scope.equal(slot.scope, appScope)) count += 1;
        };
        count;
    };

    func currentGeneration(slot : Types.Slot) : ?Types.Generation {
        Array.find<Types.Generation>(
            slot.generations,
            func(candidate) {
                candidate.status == #current and
                candidate.generation == slot.current_generation;
            },
        );
    };

    func previousGeneration(slot : Types.Slot) : ?Nat64 {
        for (generation in slot.generations.vals()) {
            if (generation.status == #previous) return ?generation.generation;
        };
        null;
    };

    func appendTombstone(
        mem : Types.Memory,
        tombstone : Types.RetiredTombstone,
    ) : () {
        let appended = Array.concat<Types.RetiredTombstone>(
            mem.retired_tombstones,
            [tombstone],
        );
        if (appended.size() <= MAX_TOMBSTONES) {
            mem.retired_tombstones := appended;
            return;
        };
        let start = appended.size() - MAX_TOMBSTONES;
        mem.retired_tombstones := Array.tabulate<Types.RetiredTombstone>(
            MAX_TOMBSTONES,
            func(index) { appended[start + index] },
        );
    };

    func validSlot(slot : Types.Slot) : Bool {
        if (
            not validAppId(slot.scope.app_id) or
            slot.scope.installation_uid == 0 or
            not validSlotId(slot.slot_id) or
            Principal.isAnonymous(slot.key_holder) or
            slot.namespace_nonce.size() != NAMESPACE_NONCE_BYTES or
            slot.generations.size() < 1 or
            slot.generations.size() > 2 or
            slot.next_generation <= slot.current_generation or
            slot.total_derivations > MAX_COUNTER_VALUE or
            slot.approximate_cycle_spend > MAX_COUNTER_VALUE
        ) return false;
        var currentCount = 0;
        var previousCount = 0;
        let seenGenerations = Map.empty<Nat64, ()>();
        for (generation in slot.generations.vals()) {
            if (
                generation.namespace_version != NAMESPACE_VERSION or
                not validKeyName(generation.key_name) or
                generation.generation >= slot.next_generation or
                Map.containsKey(seenGenerations, Nat64.compare, generation.generation)
            ) return false;
            Map.add(seenGenerations, Nat64.compare, generation.generation, ());
            switch (generation.cached_public_key) {
                case (?value) {
                    if (value.size() != 96) return false;
                };
                case null {};
            };
            if (
                (generation.cached_public_key == null) !=
                (generation.public_fingerprint == null)
            ) return false;
            switch (generation.public_fingerprint) {
                case (?value) {
                    if (value.size() != 32) return false;
                };
                case null {};
            };
            switch (generation.status) {
                case (#current) {
                    currentCount += 1;
                    if (generation.generation != slot.current_generation) return false;
                };
                case (#previous) {
                    previousCount += 1;
                    if (generation.generation >= slot.current_generation) return false;
                };
            };
        };
        currentCount == 1 and previousCount <= 1;
    };

    func validTombstones(mem : Types.Memory) : Bool {
        let seen = Map.empty<Nat, ()>();
        for (tombstone in mem.retired_tombstones.vals()) {
            if (
                tombstone.slot_uid == 0 or
                tombstone.slot_uid >= mem.next_slot_uid or
                Map.containsKey(mem.slots_by_uid, Nat.compare, tombstone.slot_uid) or
                Map.containsKey(seen, Nat.compare, tombstone.slot_uid)
            ) return false;
            Map.add(seen, Nat.compare, tombstone.slot_uid, ());
        };
        true;
    };

    func saturatingAdd(left : Nat, right : Nat) : Nat {
        if (left >= MAX_COUNTER_VALUE) return MAX_COUNTER_VALUE;
        let remaining = MAX_COUNTER_VALUE - left;
        if (right >= remaining) MAX_COUNTER_VALUE else left + right;
    };

    func indexKey(appScope : Types.AppScope, slotId : Text) : Text {
        Scope.key(appScope) # "\00" # slotId;
    };

    func validKeyName(value : Text) : Bool {
        value == "key_1" or value == "test_key_1";
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
};
