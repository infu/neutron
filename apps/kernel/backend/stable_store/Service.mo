import Blob "mo:core/Blob";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import CapabilityScope "../capabilities/Scope";
import CapabilityTypes "../capabilities/Types";
import Types "Types";

module {
    public let MAX_STORES_PER_APP : Nat = 8;
    public let MAX_ENTRIES_PER_STORE : Nat = 4_096;
    public let MAX_BYTES_PER_STORE : Nat = 16_777_216;
    public let MAX_ENTRIES_PER_APP : Nat = 8_192;
    public let MAX_BYTES_PER_APP : Nat = 33_554_432;
    public let MAX_KEY_BYTES : Nat = 256;
    public let MAX_VALUE_BYTES : Nat = 262_144;
    public let MAX_STORES_GLOBAL : Nat = 2_048;
    public let MAX_ENTRIES_GLOBAL : Nat = 65_536;
    public let MAX_BYTES_GLOBAL : Nat = 268_435_456;
    public let MAX_PAGE_ENTRIES : Nat = 64;
    public let MAX_PAGE_BYTES : Nat = 1_048_576;
    public let MAX_SCHEMA_VERSION : Nat = 65_535;
    public let MAX_PURPOSE_CHARS : Nat = 160;
    public let MIN_CYCLE_BALANCE : Nat = 250_000_000_000;

    let MAX_NAT64 : Nat64 = 18_446_744_073_709_551_615;

    type Access = {
        declaration : Types.StoreDeclaration;
        state : Types.StoreState;
    };
    type AccessResult = { #ok : Access; #err : Types.Error };

    public class Service(
        mem : Types.Memory,
        scopeActive : Types.AppScope -> Bool,
        deploymentCommitted : () -> Bool,
        registry : CapabilityTypes.RuntimeRegistry,
        cycleBalance : () -> Nat,
        isReplicated : () -> Bool,
    ) {
        let declarations = Map.empty<Text, Types.StoreDeclaration>();
        let declarationScopes = Map.empty<Text, Types.AppScope>();
        var configured = false;

        do { assert (validateMemory(mem)) };

        public func configure(next : [Types.AppDeclaration]) : () {
            assert (not configured);
            let seenScopes = Map.empty<Text, ()>();
            var targetStores = 0;
            var targetEntries = 0;
            var targetBytes = 0;
            label apps for (app in next.vals()) {
                assert (validScope(app.app_scope));
                let scopeKey = CapabilityScope.key(app.app_scope);
                assert (Map.get(seenScopes, Text.compare, scopeKey) == null);
                Map.add(seenScopes, Text.compare, scopeKey, ());
                let ?declaration = app.stable_store else { continue apps };
                assert (
                    declaration.stores.size() >= 1 and
                    declaration.stores.size() <= MAX_STORES_PER_APP
                );
                var appEntries = 0;
                var appBytes = 0;
                var prior : ?Text = null;
                for (store in declaration.stores.vals()) {
                    assert (validDeclaration(store));
                    switch (prior) {
                        case (?value) assert (Text.compare(value, store.id) == #less);
                        case null {};
                    };
                    prior := ?store.id;
                    let key = storeKey(app.app_scope, store.id);
                    assert (Map.get(declarations, Text.compare, key) == null);
                    Map.add(declarations, Text.compare, key, store);
                    Map.add(declarationScopes, Text.compare, key, app.app_scope);
                    appEntries += store.max_entries;
                    appBytes += store.max_bytes;
                    targetStores += 1;
                    targetEntries += store.max_entries;
                    targetBytes += store.max_bytes;
                };
                assert (appEntries <= MAX_ENTRIES_PER_APP);
                assert (appBytes <= MAX_BYTES_PER_APP);
            };
            assert (targetStores <= MAX_STORES_GLOBAL);
            assert (targetEntries <= MAX_ENTRIES_GLOBAL);
            assert (targetBytes <= MAX_BYTES_GLOBAL);
            // Deterministic schema or namespace-allocation defects are
            // rejected while the upgrade Wasm is still being initialized so
            // install_code preserves the predecessor actor.
            assert (targetConfigurationCommitReady(mem, next));
            configured := true;
        };

        // Commit rechecks the same condition before any install mutation.
        // Keeping this public and non-trapping lets the install boundary
        // return its typed #blocked result if retained state ever differs
        // from what actor initialization admitted.
        public func configurationCommitReady() : Bool {
            configured and configuredCommitReady();
        };

        // Reconciliation runs only in the install commit message (or
        // during construction of an already committed actor). Removing the
        // outer map entry makes its complete nested B-tree unreachable; the
        // enhanced Motoko heap reclaims it incrementally without a Region or
        // app-controlled pointer.
        public func commitConfiguration() : () {
            assert (configured and deploymentCommitted());
            assert (configuredCommitReady());
            for ((key, scope) in Map.entries(declarationScopes)) {
                assert (scopeActive(scope));
                assert (Map.get(declarations, Text.compare, key) != null);
            };

            let removed = List.empty<Text>();
            for ((key, _state) in Map.entries(mem.stores)) {
                if (Map.get(declarations, Text.compare, key) == null) {
                    List.add(removed, key);
                };
            };
            for (key in List.values(removed)) {
                ignore Map.delete(mem.stores, Text.compare, key);
            };

            for ((key, declaration) in Map.entries(declarations)) {
                let scope = switch (Map.get(declarationScopes, Text.compare, key)) {
                    case (?value) value;
                    case null Runtime.trap("Stable store declaration scope is missing");
                };
                switch (Map.get(mem.stores, Text.compare, key)) {
                    case (?state) {
                        // Opaque records are never reinterpreted as an older
                        // schema. Quota narrowing retains them and gates later
                        // growth rather than deleting app data.
                        assert (declaration.schema_version >= state.schema_version);
                        state.schema_version := declaration.schema_version;
                        state.max_entries := declaration.max_entries;
                        state.max_key_bytes := declaration.max_key_bytes;
                        state.max_value_bytes := declaration.max_value_bytes;
                        state.max_bytes := declaration.max_bytes;
                        state.oversized_entries := oversizedEntries(state);
                    };
                    case null {
                        assert (mem.next_namespace_uid < MAX_NAT64);
                        let uid = mem.next_namespace_uid;
                        mem.next_namespace_uid += 1;
                        Map.add(mem.stores, Text.compare, key, {
                            scope;
                            id = declaration.id;
                            namespace_uid = uid;
                            var schema_version = declaration.schema_version;
                            var max_entries = declaration.max_entries;
                            var max_key_bytes = declaration.max_key_bytes;
                            var max_value_bytes = declaration.max_value_bytes;
                            var max_bytes = declaration.max_bytes;
                            var entries = Map.empty<Blob, Types.StoredEntry>();
                            var bytes = 0;
                            var oversized_entries = 0;
                            var observed_revision : Nat64 = 0;
                        });
                    };
                };
            };
            assert (Map.size(mem.stores) <= MAX_STORES_GLOBAL);
            rebuildUsage();
            assert (validateMemory(mem));
        };

        func configuredCommitReady() : Bool {
            var nextNamespaceUid = mem.next_namespace_uid;
            for ((key, declaration) in Map.entries(declarations)) {
                let ?next = nextNamespaceUidIfCompatible(
                    mem,
                    key,
                    declaration.schema_version,
                    nextNamespaceUid,
                ) else return false;
                nextNamespaceUid := next;
            };
            true;
        };

        public func capability(scope : Types.AppScope) : Types.Capability {
            // Capture only the kernel-derived scope. Looking state up anew on
            // every operation makes removal, reinstall, and runtime disable
            // effective against a retained closure.
            {
                get = func(input) { get(scope, input) };
                put = func(input) { put(scope, input) };
                delete = func(input) { delete(scope, input) };
                list = func(input) { list(scope, input) };
                usage = func(store) { usage(scope, store) };
                clear_page = func(input) { clearPage(scope, input) };
            };
        };

        public func get(scope : Types.AppScope, input : Types.GetInput) : Types.GetResult {
            if (not validKey(input.key)) return #err(#invalid_request);
            switch (access(scope, input.store)) {
                case (#err(error)) #err(error);
                case (#ok({ state })) {
                    #ok(switch (Map.get(state.entries, Blob.compare, input.key)) {
                        case null null;
                        case (?entry) ?publicEntry(input.key, entry);
                    });
                };
            };
        };

        public func put(scope : Types.AppScope, input : Types.PutInput) : Types.PutResult {
            if (not validKey(input.key) or input.value.size() > MAX_VALUE_BYTES) {
                return finishPut(scope, input.store, #err(#too_large));
            };
            let accessResult = access(scope, input.store);
            let #ok({ declaration; state }) = accessResult else {
                let #err(error) = accessResult else return finishPut(scope, input.store, #err(#invalid_request));
                return finishPut(scope, input.store, #err(error));
            };
            if (not isReplicated()) {
                return finishPut(scope, input.store, #err(#not_replicated));
            };
            let prior = Map.get(state.entries, Blob.compare, input.key);
            switch (input.condition) {
                case (#unconditional) {};
                case (#if_absent) {
                    switch (prior) {
                        case null {};
                        case (?entry) return finishPut(
                            scope,
                            input.store,
                            #err(#conflict({ current_revision = ?entry.revision })),
                        );
                    };
                };
                case (#if_revision(expected)) {
                    switch (prior) {
                        case (?entry) {
                            if (entry.revision != expected) return finishPut(
                                scope,
                                input.store,
                                #err(#conflict({ current_revision = ?entry.revision })),
                            );
                        };
                        case null return finishPut(
                            scope,
                            input.store,
                            #err(#conflict({ current_revision = null })),
                        );
                    };
                };
            };
            if (
                input.key.size() > declaration.max_key_bytes or
                input.value.size() > declaration.max_value_bytes
            ) return finishPut(scope, input.store, #err(#too_large));

            let priorBytes = switch (prior) {
                case (?entry) input.key.size() + entry.value.size();
                case null 0;
            };
            let nextEntries = Map.size(state.entries) + (if (prior == null) 1 else 0);
            let nextBytes = Nat.sub(state.bytes, priorBytes) + input.key.size() + input.value.size();
            let overQuota = storeOverQuota(state);
            let nonGrowingReplacement = prior != null and nextBytes <= state.bytes;
            if (
                (overQuota and not nonGrowingReplacement) or
                (not overQuota and (
                    nextEntries > declaration.max_entries or
                    nextBytes > declaration.max_bytes
                ))
            ) return finishPut(scope, input.store, #err(#quota_exceeded));

            let currentScopeUsage = scopeUsage(scope);
            let nextScopeEntries = currentScopeUsage.entries + (if (prior == null) 1 else 0);
            let nextScopeBytes = Nat.sub(currentScopeUsage.bytes, priorBytes) + input.key.size() + input.value.size();
            let nextGlobalEntries = mem.total_entries + (if (prior == null) 1 else 0);
            let nextGlobalBytes = Nat.sub(mem.total_bytes, priorBytes) + input.key.size() + input.value.size();
            if (
                nextScopeEntries > MAX_ENTRIES_PER_APP or
                nextScopeBytes > MAX_BYTES_PER_APP or
                nextGlobalEntries > MAX_ENTRIES_GLOBAL or
                nextGlobalBytes > MAX_BYTES_GLOBAL
            ) return finishPut(scope, input.store, #err(#quota_exceeded));

            let grows = switch (prior) {
                case null true;
                case (?entry) input.value.size() > entry.value.size();
            };
            if (grows and cycleBalance() < MIN_CYCLE_BALANCE) {
                return finishPut(scope, input.store, #err(#low_cycles));
            };
            if (mem.next_revision == MAX_NAT64) {
                return finishPut(scope, input.store, #err(#revision_exhausted));
            };
            let revision = takeRevision();
            Map.add(state.entries, Blob.compare, input.key, {
                value = input.value;
                revision;
                schema_version = declaration.schema_version;
            });
            state.bytes := nextBytes;
            switch (prior) {
                case (?entry) {
                    if (entryOversized(state, input.key, entry)) {
                        state.oversized_entries -= 1;
                    };
                };
                case null {};
            };
            state.observed_revision := revision;
            mem.total_entries := nextGlobalEntries;
            mem.total_bytes := nextGlobalBytes;
            setScopeUsage(scope, { entries = nextScopeEntries; bytes = nextScopeBytes });
            let result : Types.PutResult = #ok({
                revision;
                schema_version = declaration.schema_version;
                usage = usageFor(declaration, state);
            });
            finishPut(scope, input.store, result);
        };

        public func delete(
            scope : Types.AppScope,
            input : Types.DeleteInput,
        ) : Types.DeleteResult {
            if (not validKey(input.key)) {
                return finishDelete(scope, input.store, #err(#invalid_request));
            };
            let accessResult = access(scope, input.store);
            let #ok({ declaration; state }) = accessResult else {
                let #err(error) = accessResult else return finishDelete(scope, input.store, #err(#invalid_request));
                return finishDelete(scope, input.store, #err(error));
            };
            if (not isReplicated()) {
                return finishDelete(scope, input.store, #err(#not_replicated));
            };
            let ?entry = Map.get(state.entries, Blob.compare, input.key) else {
                return finishDelete(scope, input.store, #err(#not_found));
            };
            switch (input.expected_revision) {
                case (?expected) {
                    if (expected != entry.revision) return finishDelete(
                        scope,
                        input.store,
                        #err(#conflict({ current_revision = ?entry.revision })),
                    );
                };
                case null {};
            };
            let revision = if (mem.next_revision < MAX_NAT64) {
                ?takeRevision()
            } else null;
            assert (Map.delete(state.entries, Blob.compare, input.key));
            let removedBytes = input.key.size() + entry.value.size();
            state.bytes -= removedBytes;
            if (entryOversized(state, input.key, entry)) {
                state.oversized_entries -= 1;
            };
            switch (revision) {
                case (?value) state.observed_revision := value;
                case null {};
            };
            mem.total_entries -= 1;
            mem.total_bytes -= removedBytes;
            let currentScopeUsage = scopeUsage(scope);
            setScopeUsage(scope, {
                entries = currentScopeUsage.entries - 1;
                bytes = currentScopeUsage.bytes - removedBytes;
            });
            finishDelete(scope, input.store, #ok(usageFor(declaration, state)));
        };

        public func list(scope : Types.AppScope, input : Types.ListInput) : Types.ListResult {
            if (
                input.prefix.size() > MAX_KEY_BYTES or
                input.limit < 1 or input.limit > MAX_PAGE_ENTRIES
            ) return #err(#invalid_request);
            let accessResult = access(scope, input.store);
            let #ok({ state }) = accessResult else {
                let #err(error) = accessResult else return #err(#invalid_request);
                return #err(error);
            };
            let start = switch (input.cursor) {
                case null input.prefix;
                case (?cursor) {
                    if (
                        cursor.namespace_uid != state.namespace_uid or
                        cursor.prefix != input.prefix or
                        not validKey(cursor.after) or
                        not hasPrefix(cursor.after, input.prefix)
                    ) return #err(#cursor_stale);
                    cursor.after;
                };
            };
            let iterator = Map.entriesFrom(state.entries, Blob.compare, start);
            let output = List.empty<Types.Entry>();
            var outputBytes = 0;
            var last : ?Blob = null;
            var more = false;
            var first = true;
            label scan loop {
                let ?(key, entry) = iterator.next() else break scan;
                if (not hasPrefix(key, input.prefix)) break scan;
                if (first) {
                    first := false;
                    switch (input.cursor) {
                        case (?cursor) {
                            if (key == cursor.after) continue scan;
                        };
                        case null {};
                    };
                };
                let entryBytes = key.size() + entry.value.size();
                if (
                    List.size(output) >= input.limit or
                    (List.size(output) > 0 and outputBytes + entryBytes > MAX_PAGE_BYTES)
                ) {
                    more := true;
                    break scan;
                };
                List.add(output, publicEntry(key, entry));
                outputBytes += entryBytes;
                last := ?key;
            };
            #ok({
                entries = List.toArray(output);
                next = if (more) switch (last) {
                    case (?after) ?{
                        namespace_uid = state.namespace_uid;
                        prefix = input.prefix;
                        after;
                    };
                    case null null;
                } else null;
                observed_revision = state.observed_revision;
            });
        };

        public func usage(scope : Types.AppScope, storeId : Text) : Types.UsageResult {
            switch (access(scope, storeId)) {
                case (#err(error)) #err(error);
                case (#ok({ declaration; state })) #ok(usageFor(declaration, state));
            };
        };

        public func clearPage(
            scope : Types.AppScope,
            input : Types.ClearPageInput,
        ) : Types.ClearPageResult {
            if (
                input.prefix.size() > MAX_KEY_BYTES or
                input.limit < 1 or input.limit > MAX_PAGE_ENTRIES
            ) return finishClear(scope, input.store, #err(#invalid_request));
            let accessResult = access(scope, input.store);
            let #ok({ declaration; state }) = accessResult else {
                let #err(error) = accessResult else return finishClear(scope, input.store, #err(#invalid_request));
                return finishClear(scope, input.store, #err(error));
            };
            if (not isReplicated()) {
                return finishClear(scope, input.store, #err(#not_replicated));
            };
            let keys = List.empty<(Blob, Nat, Bool)>();
            var removedBytes = 0;
            var removedOversized = 0;
            let iterator = Map.entriesFrom(state.entries, Blob.compare, input.prefix);
            label collect loop {
                let ?(key, entry) = iterator.next() else break collect;
                if (not hasPrefix(key, input.prefix)) break collect;
                let entryBytes = key.size() + entry.value.size();
                if (
                    List.size(keys) >= input.limit or
                    (List.size(keys) > 0 and removedBytes + entryBytes > MAX_PAGE_BYTES)
                ) break collect;
                let oversized = entryOversized(state, key, entry);
                List.add(keys, (key, entryBytes, oversized));
                if (oversized) removedOversized += 1;
                removedBytes += entryBytes;
            };
            if (List.size(keys) == 0) {
                return finishClear(scope, input.store, #ok({
                    removed_entries = 0;
                    removed_bytes = 0;
                    more = false;
                    usage = usageFor(declaration, state);
                }));
            };
            let revision = if (mem.next_revision < MAX_NAT64) {
                ?takeRevision()
            } else null;
            for ((key, _bytes, _oversized) in List.values(keys)) {
                assert (Map.delete(state.entries, Blob.compare, key));
            };
            let removedEntries = List.size(keys);
            state.bytes -= removedBytes;
            state.oversized_entries -= removedOversized;
            switch (revision) {
                case (?value) state.observed_revision := value;
                case null {};
            };
            mem.total_entries -= removedEntries;
            mem.total_bytes -= removedBytes;
            let currentScopeUsage = scopeUsage(scope);
            setScopeUsage(scope, {
                entries = currentScopeUsage.entries - removedEntries;
                bytes = currentScopeUsage.bytes - removedBytes;
            });
            let more = hasMatchingEntry(state, input.prefix);
            finishClear(scope, input.store, #ok({
                removed_entries = removedEntries;
                removed_bytes = removedBytes;
                more;
                usage = usageFor(declaration, state);
            }));
        };

        func access(scope : Types.AppScope, storeId : Text) : AccessResult {
            if (not validStoreId(storeId)) return #err(#invalid_request);
            if (not deploymentCommitted() or not scopeActive(scope)) {
                return #err(#source_gone);
            };
            let key = storeKey(scope, storeId);
            let ?declaration = Map.get(declarations, Text.compare, key) else {
                return #err(#not_declared);
            };
            let ?state = Map.get(mem.stores, Text.compare, key) else {
                return #err(#not_declared);
            };
            if (not registry.allowed(scope, #stable_store, storeId)) {
                return #err(#disabled);
            };
            #ok({ declaration; state });
        };

        func takeRevision() : Nat64 {
            assert (mem.next_revision < MAX_NAT64);
            let revision = mem.next_revision;
            mem.next_revision += 1;
            revision;
        };

        func rebuildUsage() : () {
            Map.clear(mem.usage_by_scope);
            mem.total_entries := 0;
            mem.total_bytes := 0;
            for (state in Map.values(mem.stores)) {
                let entries = Map.size(state.entries);
                let scopeKey = CapabilityScope.key(state.scope);
                let current = switch (Map.get(mem.usage_by_scope, Text.compare, scopeKey)) {
                    case (?value) value;
                    case null ({ entries = 0; bytes = 0 } : Types.UsageTotals);
                };
                let next = {
                    entries = current.entries + entries;
                    bytes = current.bytes + state.bytes;
                };
                if (next.entries > 0 or next.bytes > 0) {
                    Map.add(mem.usage_by_scope, Text.compare, scopeKey, next);
                };
                mem.total_entries += entries;
                mem.total_bytes += state.bytes;
            };
            assert (mem.total_entries <= MAX_ENTRIES_GLOBAL);
            assert (mem.total_bytes <= MAX_BYTES_GLOBAL);
        };

        func scopeUsage(scope : Types.AppScope) : Types.UsageTotals {
            switch (Map.get(mem.usage_by_scope, Text.compare, CapabilityScope.key(scope))) {
                case (?value) value;
                case null ({ entries = 0; bytes = 0 } : Types.UsageTotals);
            };
        };

        func setScopeUsage(scope : Types.AppScope, value : Types.UsageTotals) : () {
            let key = CapabilityScope.key(scope);
            if (value.entries == 0 and value.bytes == 0) {
                ignore Map.delete(mem.usage_by_scope, Text.compare, key);
            } else {
                Map.add(mem.usage_by_scope, Text.compare, key, value);
            };
        };

        func hasMatchingEntry(state : Types.StoreState, prefix : Blob) : Bool {
            let iterator = Map.entriesFrom(state.entries, Blob.compare, prefix);
            switch (iterator.next()) {
                case (?(key, _)) hasPrefix(key, prefix);
                case null false;
            };
        };

        func finishPut(
            scope : Types.AppScope,
            storeId : Text,
            result : Types.PutResult,
        ) : Types.PutResult {
            recordMutation(scope, storeId, "put", putOutcome(result));
            result;
        };

        func finishDelete(
            scope : Types.AppScope,
            storeId : Text,
            result : Types.DeleteResult,
        ) : Types.DeleteResult {
            recordMutation(scope, storeId, "delete", deleteOutcome(result));
            result;
        };

        func finishClear(
            scope : Types.AppScope,
            storeId : Text,
            result : Types.ClearPageResult,
        ) : Types.ClearPageResult {
            recordMutation(scope, storeId, "clear_page", clearOutcome(result));
            result;
        };

        func recordMutation(
            scope : Types.AppScope,
            storeId : Text,
            operation : Text,
            outcome : CapabilityTypes.CapabilityOutcome,
        ) : () {
            ignore registry.record(scope, #stable_store, storeId, operation, outcome);
        };
    };

    public func targetConfigurationCommitReady(
        mem : Types.Memory,
        next : [Types.AppDeclaration],
    ) : Bool {
        var nextNamespaceUid = mem.next_namespace_uid;
        for (app in next.vals()) {
            let ?declaration = app.stable_store else { continue };
            for (store in declaration.stores.vals()) {
                let ?next = nextNamespaceUidIfCompatible(
                    mem,
                    storeKey(app.app_scope, store.id),
                    store.schema_version,
                    nextNamespaceUid,
                ) else return false;
                nextNamespaceUid := next;
            };
        };
        true;
    };

    public func validateMemory(mem : Types.Memory) : Bool {
        if (
            mem.next_namespace_uid == 0 or mem.next_revision == 0 or
            Map.size(mem.stores) > MAX_STORES_GLOBAL or
            mem.total_entries > MAX_ENTRIES_GLOBAL or
            mem.total_bytes > MAX_BYTES_GLOBAL
        ) return false;
        let uids = Map.empty<Nat64, ()>();
        let revisions = Map.empty<Nat64, ()>();
        let expectedScopeUsage = Map.empty<Text, Types.UsageTotals>();
        let storesPerScope = Map.empty<Text, Nat>();
        let declaredEntriesPerScope = Map.empty<Text, Nat>();
        let declaredBytesPerScope = Map.empty<Text, Nat>();
        var entries = 0;
        var bytes = 0;
        var declaredEntries = 0;
        var declaredBytes = 0;
        for ((key, state) in Map.entries(mem.stores)) {
            if (
                key != storeKey(state.scope, state.id) or
                not validScope(state.scope) or
                not validPersistedDeclaration(state) or
                state.namespace_uid == 0 or
                state.namespace_uid >= mem.next_namespace_uid or
                Map.get(uids, Nat64.compare, state.namespace_uid) != null or
                state.observed_revision >= mem.next_revision or
                Map.size(state.entries) > MAX_ENTRIES_PER_STORE
            ) return false;
            Map.add(uids, Nat64.compare, state.namespace_uid, ());
            var storeBytes = 0;
            var oversized = 0;
            for ((entryKey, entry) in Map.entries(state.entries)) {
                if (
                    not validKey(entryKey) or
                    entry.value.size() > MAX_VALUE_BYTES or
                    entry.revision == 0 or entry.revision >= mem.next_revision or
                    entry.revision > state.observed_revision or
                    Map.get(revisions, Nat64.compare, entry.revision) != null or
                    entry.schema_version < 1 or
                    entry.schema_version > state.schema_version
                ) return false;
                Map.add(revisions, Nat64.compare, entry.revision, ());
                storeBytes += entryKey.size() + entry.value.size();
                if (entryOversized(state, entryKey, entry)) oversized += 1;
            };
            if (
                storeBytes != state.bytes or storeBytes > MAX_BYTES_PER_STORE or
                oversized != state.oversized_entries
            ) {
                return false;
            };
            let count = Map.size(state.entries);
            entries += count;
            bytes += storeBytes;
            let scopeKey = CapabilityScope.key(state.scope);
            let scopeStores = switch (Map.get(storesPerScope, Text.compare, scopeKey)) {
                case (?value) value + 1;
                case null 1;
            };
            let scopeDeclaredEntries = switch (
                Map.get(declaredEntriesPerScope, Text.compare, scopeKey)
            ) {
                case (?value) value + state.max_entries;
                case null state.max_entries;
            };
            let scopeDeclaredBytes = switch (
                Map.get(declaredBytesPerScope, Text.compare, scopeKey)
            ) {
                case (?value) value + state.max_bytes;
                case null state.max_bytes;
            };
            if (
                scopeStores > MAX_STORES_PER_APP or
                scopeDeclaredEntries > MAX_ENTRIES_PER_APP or
                scopeDeclaredBytes > MAX_BYTES_PER_APP
            ) return false;
            Map.add(storesPerScope, Text.compare, scopeKey, scopeStores);
            Map.add(
                declaredEntriesPerScope,
                Text.compare,
                scopeKey,
                scopeDeclaredEntries,
            );
            Map.add(
                declaredBytesPerScope,
                Text.compare,
                scopeKey,
                scopeDeclaredBytes,
            );
            declaredEntries += state.max_entries;
            declaredBytes += state.max_bytes;
            let current = switch (Map.get(expectedScopeUsage, Text.compare, scopeKey)) {
                case (?value) value;
                case null ({ entries = 0; bytes = 0 } : Types.UsageTotals);
            };
            let next = {
                entries = current.entries + count;
                bytes = current.bytes + storeBytes;
            };
            if (next.entries > MAX_ENTRIES_PER_APP or next.bytes > MAX_BYTES_PER_APP) {
                return false;
            };
            if (next.entries > 0 or next.bytes > 0) {
                Map.add(expectedScopeUsage, Text.compare, scopeKey, next);
            };
        };
        if (
            entries != mem.total_entries or bytes != mem.total_bytes or
            declaredEntries > MAX_ENTRIES_GLOBAL or
            declaredBytes > MAX_BYTES_GLOBAL or
            Map.size(expectedScopeUsage) != Map.size(mem.usage_by_scope)
        ) return false;
        for ((scopeKey, expected) in Map.entries(expectedScopeUsage)) {
            if (Map.get(mem.usage_by_scope, Text.compare, scopeKey) != ?expected) {
                return false;
            };
        };
        true;
    };

    func validPersistedDeclaration(state : Types.StoreState) : Bool {
        validStoreId(state.id) and
        state.schema_version >= 1 and state.schema_version <= MAX_SCHEMA_VERSION and
        state.max_entries >= 1 and state.max_entries <= MAX_ENTRIES_PER_STORE and
        state.max_key_bytes >= 1 and state.max_key_bytes <= MAX_KEY_BYTES and
        state.max_value_bytes >= 1 and state.max_value_bytes <= MAX_VALUE_BYTES and
        state.max_bytes >= state.max_key_bytes + state.max_value_bytes and
        state.max_bytes <= MAX_BYTES_PER_STORE
    };

    func validDeclaration(store : Types.StoreDeclaration) : Bool {
        validStoreId(store.id) and
        store.purpose.size() >= 1 and store.purpose.size() <= MAX_PURPOSE_CHARS and
        store.schema_version >= 1 and store.schema_version <= MAX_SCHEMA_VERSION and
        store.max_entries >= 1 and store.max_entries <= MAX_ENTRIES_PER_STORE and
        store.max_key_bytes >= 1 and store.max_key_bytes <= MAX_KEY_BYTES and
        store.max_value_bytes >= 1 and store.max_value_bytes <= MAX_VALUE_BYTES and
        store.max_bytes >= store.max_key_bytes + store.max_value_bytes and
        store.max_bytes <= MAX_BYTES_PER_STORE
    };

    func validScope(scope : Types.AppScope) : Bool {
        CapabilityScope.valid(scope);
    };

    func validStoreId(value : Text) : Bool {
        if (value.size() < 1 or value.size() > 40) return false;
        var first = true;
        for (char in value.chars()) {
            if (first) {
                if (char < 'a' or char > 'z') return false;
                first := false;
            } else if (not (
                (char >= 'a' and char <= 'z') or
                (char >= '0' and char <= '9') or char == '_'
            )) return false;
        };
        true;
    };

    func validKey(value : Blob) : Bool { value.size() <= MAX_KEY_BYTES };

    func storeKey(scope : Types.AppScope, storeId : Text) : Text {
        CapabilityScope.key(scope) # "\00" # storeId;
    };

    func nextNamespaceUidIfCompatible(
        mem : Types.Memory,
        key : Text,
        targetSchemaVersion : Nat,
        nextNamespaceUid : Nat64,
    ) : ?Nat64 {
        switch (Map.get(mem.stores, Text.compare, key)) {
            case (?state) {
                if (targetSchemaVersion < state.schema_version) return null;
                ?nextNamespaceUid;
            };
            case null {
                if (nextNamespaceUid >= MAX_NAT64) return null;
                ?(nextNamespaceUid + 1);
            };
        };
    };

    func publicEntry(key : Blob, entry : Types.StoredEntry) : Types.Entry {
        {
            key;
            value = entry.value;
            revision = entry.revision;
            schema_version = entry.schema_version;
        };
    };

    func usageFor(
        declaration : Types.StoreDeclaration,
        state : Types.StoreState,
    ) : Types.Usage {
        {
            store = declaration.id;
            schema_version = declaration.schema_version;
            entries = Map.size(state.entries);
            bytes = state.bytes;
            max_entries = declaration.max_entries;
            max_bytes = declaration.max_bytes;
            over_quota = storeOverQuota(state);
        };
    };

    func storeOverQuota(state : Types.StoreState) : Bool {
        Map.size(state.entries) > state.max_entries or state.bytes > state.max_bytes or
        state.oversized_entries > 0
    };

    func entryOversized(
        state : Types.StoreState,
        key : Blob,
        entry : Types.StoredEntry,
    ) : Bool {
        key.size() > state.max_key_bytes or
        entry.value.size() > state.max_value_bytes
    };

    func oversizedEntries(state : Types.StoreState) : Nat {
        var count = 0;
        for ((key, entry) in Map.entries(state.entries)) {
            if (entryOversized(state, key, entry)) count += 1;
        };
        count;
    };

    func hasPrefix(value : Blob, prefix : Blob) : Bool {
        if (prefix.size() > value.size()) return false;
        let values = value.values();
        for (expected in prefix.values()) {
            let ?actual = values.next() else return false;
            if (actual != expected) return false;
        };
        true;
    };

    func putOutcome(result : Types.PutResult) : CapabilityTypes.CapabilityOutcome {
        switch (result) {
            case (#ok(_)) #ok;
            case (#err(_)) #denied;
        };
    };

    func deleteOutcome(result : Types.DeleteResult) : CapabilityTypes.CapabilityOutcome {
        switch (result) { case (#ok(_)) #ok; case (#err(_)) #denied };
    };

    func clearOutcome(result : Types.ClearPageResult) : CapabilityTypes.CapabilityOutcome {
        switch (result) { case (#ok(_)) #ok; case (#err(_)) #denied };
    };
};
