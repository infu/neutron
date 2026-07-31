import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Scope "Scope";
import Types "Types";

module {
    public let MAX_PER_APP : Nat = 64;
    public let MAX_TOTAL : Nat = 8_192;
    public let MAX_PAGE_SIZE : Nat = 100;
    public let MAX_OPERATION_CHARS : Nat = 64;
    public let MAX_CURSOR_CHARS : Nat = 160;
    let MAX_COUNTER : Nat64 = 18_446_744_073_709_551_615;

    public func init() : Types.CapabilityRegistryMemory {
        { entries = Map.empty<Text, Types.CapabilityRegistryEntry>() };
    };

    public class Service(
        mem : Types.CapabilityRegistryMemory,
        scopeActive : Types.AppScope -> Bool,
        deploymentCommitted : () -> Bool,
        now : () -> Nat64,
    ) {
        let declarations = Map.empty<Text, Types.CapabilityRegistration>();
        // These epochs revoke continuations within this installed actor.
        // Neutron's normal Motoko upgrade keeps pre-upgrade enabled, so code
        // replacement cannot successfully preserve a suspended Motoko
        // continuation. The map is bounded by the same validated runtime
        // catalogue as declarations and is deliberately not app state.
        let epochs = Map.empty<Text, Nat>();
        var configured = false;

        do { assert (validateMemory(mem)) };

        // Configuration is actor-local target state. It cannot mutate the
        // committed registry until commitConfiguration is called after the
        // install journal promotes the target app-instance inventory.
        public func configure(next : [Types.CapabilityRegistration]) : () {
            assert (not configured);
            assert (next.size() <= MAX_TOTAL);
            let perApp = Map.empty<Text, Nat>();
            let plansByApp = Map.empty<Text, Text>();
            var previous : ?Text = null;
            for (registration in next.vals()) {
                assert (validRegistration(registration));
                let entryKey = key(registration.scope, registration.kind, registration.resource_id);
                switch (previous) {
                    case (?last) assert (Text.compare(last, entryKey) == #less);
                    case null {};
                };
                previous := ?entryKey;
                let scopeKey = Scope.key(registration.scope);
                switch (Map.get(plansByApp, Text.compare, scopeKey)) {
                    case (?fingerprint) assert (
                        fingerprint == registration.plan_fingerprint
                    );
                    case null Map.add(
                        plansByApp,
                        Text.compare,
                        scopeKey,
                        registration.plan_fingerprint,
                    );
                };
                let count = switch (Map.get(perApp, Text.compare, scopeKey)) {
                    case (?current) current + 1;
                    case null 1;
                };
                assert (count <= MAX_PER_APP);
                Map.add(perApp, Text.compare, scopeKey, count);
                Map.add(declarations, Text.compare, entryKey, registration);
                Map.add(epochs, Text.compare, entryKey, 0);
            };
            configured := true;
        };

        // Returns false without mutation if called before target scopes are
        // committed. The caller must assert success from the atomic install
        // commit message.
        public func commitConfiguration(changedBy : Principal) : Bool {
            assert (configured);
            if (not deploymentCommitted()) return false;
            for (registration in Map.values(declarations)) {
                if (not scopeActive(registration.scope)) return false;
            };

            let timestamp = now();
            let target = Map.empty<Text, Types.CapabilityRegistryEntry>();
            for ((entryKey, registration) in Map.entries(declarations)) {
                let entry = switch (Map.get(mem.entries, Text.compare, entryKey)) {
                    case (?current) {
                        if (
                            sameAuthority(
                                current.registration,
                                registration,
                            ) or
                            sameCertifiedAssetsScope(
                                current.registration,
                                registration,
                            )
                        ) {
                            // An unrelated app-plan change must not revive a
                            // disabled resource or erase its bounded usage.
                            // Certified Assets additionally preserves this
                            // state across the quota-only same-scope widening
                            // that its service validates and commits first.
                            {
                                current with
                                registration;
                            };
                        } else {
                            freshEntry(registration, changedBy, timestamp);
                        };
                    };
                    case null freshEntry(registration, changedBy, timestamp);
                };
                Map.add(target, Text.compare, entryKey, entry);
            };

            Map.clear(mem.entries);
            for ((entryKey, entry) in Map.entries(target)) {
                Map.add(mem.entries, Text.compare, entryKey, entry);
            };
            true;
        };

        public func registration(
            appScope : Types.AppScope,
            kind : Types.CapabilityKind,
            resourceId : Text,
        ) : ?Types.CapabilityRegistration {
            if (not configured or not validResource(kind, resourceId)) return null;
            Map.get(
                declarations,
                Text.compare,
                key(appScope, kind, resourceId),
            );
        };

        // This is an additional live kill switch. Specialized declaration,
        // reservation, quota, holder, and target checks remain mandatory.
        public func allowed(
            appScope : Types.AppScope,
            kind : Types.CapabilityKind,
            resourceId : Text,
        ) : Bool {
            if (
                not scopeActive(appScope) or
                not validResource(kind, resourceId)
            ) return false;
            let entryKey = key(appScope, kind, resourceId);
            let ?declared = Map.get(declarations, Text.compare, entryKey) else return false;
            let ?entry = Map.get(mem.entries, Text.compare, entryKey) else return false;
            entry.enabled and sameRegistration(entry.registration, declared);
        };

        // Exact read-only projection used while the target actor is active but
        // its install journal has not promoted the target scopes yet. Static
        // package files can therefore be certified once with the policy that
        // commitConfiguration will publish, without granting runtime authority
        // before that atomic commit.
        public func enabledAfterCommit(
            appScope : Types.AppScope,
            kind : Types.CapabilityKind,
            resourceId : Text,
        ) : Bool {
            if (
                not configured or
                not validResource(kind, resourceId)
            ) return false;
            let entryKey = key(appScope, kind, resourceId);
            let ?declared = Map.get(
                declarations,
                Text.compare,
                entryKey,
            ) else return false;
            switch (Map.get(mem.entries, Text.compare, entryKey)) {
                case (?current) {
                    if (
                        sameAuthority(current.registration, declared) or
                        sameCertifiedAssetsScope(
                            current.registration,
                            declared,
                        )
                    ) current.enabled else true;
                };
                case null true;
            };
        };

        public func lease(
            appScope : Types.AppScope,
            kind : Types.CapabilityKind,
            resourceId : Text,
        ) : ?Types.RuntimeLease {
            if (not allowed(appScope, kind, resourceId)) return null;
            let entryKey = key(appScope, kind, resourceId);
            let ?capturedEpoch = Map.get(
                epochs,
                Text.compare,
                entryKey,
            ) else return null;
            ?{
                active = func() : Bool {
                    switch (Map.get(epochs, Text.compare, entryKey)) {
                        case (?currentEpoch) {
                            currentEpoch == capturedEpoch and
                            allowed(appScope, kind, resourceId);
                        };
                        case null false;
                    };
                };
            };
        };

        public func setEnabled(
            input : Types.CapabilitySetEnabledInput,
            changedBy : Principal,
        ) : ?Types.CapabilitySummary {
            if (not configured or input.installation_uid == 0) return null;
            let appScope : Types.AppScope = {
                app_id = input.app_id;
                installation_uid = input.installation_uid;
            };
            if (
                not scopeActive(appScope) or
                not validResource(input.kind, input.resource_id)
            ) return null;
            let entryKey = key(appScope, input.kind, input.resource_id);
            let ?declared = Map.get(declarations, Text.compare, entryKey) else return null;
            if (not declared.toggleable) return null;
            let ?current = Map.get(mem.entries, Text.compare, entryKey) else return null;
            if (not sameRegistration(current.registration, declared)) return null;
            let timestamp = now();
            let operation = if (input.enabled) "enable" else "disable";
            bumpEpoch(entryKey);
            let updated = {
                current with
                enabled = input.enabled;
                updated_at = timestamp;
                updated_by = changedBy;
                usage = recordOutcome(
                    current.usage,
                    operation,
                    #ok,
                    timestamp,
                );
            };
            Map.add(mem.entries, Text.compare, entryKey, updated);
            ?summary(updated);
        };

        // One terminal event per broker operation. Counters saturate instead
        // of growing unbounded, and only a bounded operation label is kept.
        public func record(
            appScope : Types.AppScope,
            kind : Types.CapabilityKind,
            resourceId : Text,
            operation : Text,
            outcome : Types.CapabilityOutcome,
        ) : Bool {
            if (
                operation.size() == 0 or
                operation.size() > MAX_OPERATION_CHARS or
                not scopeActive(appScope) or
                not validResource(kind, resourceId)
            ) return false;
            let entryKey = key(appScope, kind, resourceId);
            let ?declared = Map.get(declarations, Text.compare, entryKey) else return false;
            let ?current = Map.get(mem.entries, Text.compare, entryKey) else return false;
            if (not sameRegistration(current.registration, declared)) return false;
            let timestamp = now();
            let usage = recordOutcome(current.usage, operation, outcome, timestamp);
            Map.add(mem.entries, Text.compare, entryKey, {
                current with
                usage;
            });
            true;
        };

        public func page(input : Types.CapabilityPageInput) : Types.CapabilityPage {
            assert (input.limit >= 1 and input.limit <= MAX_PAGE_SIZE);
            switch (input.after) {
                case (?cursor) assert (cursor.size() <= MAX_CURSOR_CHARS);
                case null {};
            };
            let entries = List.empty<Types.CapabilitySummary>();
            var lastKey : ?Text = null;
            var more = false;
            label scan for ((entryKey, entry) in Map.entries(mem.entries)) {
                if (afterCursor(entryKey, input.after) and current(entryKey, entry)) {
                    if (List.size(entries) >= input.limit) {
                        more := true;
                        break scan;
                    };
                    List.add(entries, summary(entry));
                    lastKey := ?entryKey;
                };
            };
            {
                entries = List.toArray(entries);
                next = if (more) lastKey else null;
            };
        };

        func current(entryKey : Text, entry : Types.CapabilityRegistryEntry) : Bool {
            if (not scopeActive(entry.registration.scope)) return false;
            let ?declared = Map.get(declarations, Text.compare, entryKey) else return false;
            sameRegistration(entry.registration, declared);
        };

        func bumpEpoch(entryKey : Text) : () {
            let currentEpoch = switch (
                Map.get(epochs, Text.compare, entryKey)
            ) {
                case (?value) value;
                case null 0;
            };
            Map.add(epochs, Text.compare, entryKey, currentEpoch + 1);
        };
    };

    public func key(
        appScope : Types.AppScope,
        kind : Types.CapabilityKind,
        resourceId : Text,
    ) : Text {
        Scope.key(appScope) # "\00" # kindText(kind) # "\00" # resourceId;
    };

    public func kindText(kind : Types.CapabilityKind) : Text {
        switch (kind) {
            case (#backend_calls) "backend_calls";
            case (#randomness) "randomness";
            case (#https_outcalls) "https_outcalls";
            case (#chain_key_signing) "chain_key_signing";
            case (#stable_store) "stable_store";
            case (#vetkeys) "vetkeys";
            case (#scheduled_tasks) "scheduled_tasks";
            case (#connections) "connections";
            case (#persistent_browser_storage) "persistent_browser_storage";
            case (#dedicated_resident_origin) "dedicated_resident_origin";
            case (#http_routes) "http_routes";
            case (#certified_read_routes) "certified_read_routes";
            case (#certified_assets) "certified_assets";
            case (#public_ingress) "public_ingress";
        };
    };

    func sameAuthority(
        current : Types.CapabilityRegistration,
        target : Types.CapabilityRegistration,
    ) : Bool {
        Scope.equal(current.scope, target.scope) and
        current.kind == target.kind and
        current.resource_id == target.resource_id and
        current.api == target.api and
        current.declaration_fingerprint == target.declaration_fingerprint and
        current.grant == target.grant and
        current.toggleable == target.toggleable;
    };

    func sameCertifiedAssetsScope(
        current : Types.CapabilityRegistration,
        target : Types.CapabilityRegistration,
    ) : Bool {
        Scope.equal(current.scope, target.scope) and
        current.kind == #certified_assets and
        target.kind == #certified_assets and
        current.resource_id == "default" and
        target.resource_id == "default" and
        current.api == 2 and target.api == 2 and
        current.grant == #declaration and
        target.grant == #declaration and
        current.toggleable == target.toggleable;
    };

    func sameRegistration(
        current : Types.CapabilityRegistration,
        target : Types.CapabilityRegistration,
    ) : Bool {
        sameAuthority(current, target) and
        current.plan_fingerprint == target.plan_fingerprint;
    };

    func freshEntry(
        registration : Types.CapabilityRegistration,
        changedBy : Principal,
        timestamp : Nat64,
    ) : Types.CapabilityRegistryEntry {
        {
            registration;
            enabled = true;
            created_at = timestamp;
            created_by = changedBy;
            updated_at = timestamp;
            updated_by = changedBy;
            usage = emptyUsage();
        };
    };

    func emptyUsage() : Types.CapabilityUsage {
        {
            total = 0;
            succeeded = 0;
            denied = 0;
            failed = 0;
            rate_limited = 0;
            busy = 0;
            revoked = 0;
            last_at = null;
            last_operation = null;
            last_outcome = null;
        };
    };

    func recordOutcome(
        current : Types.CapabilityUsage,
        operation : Text,
        outcome : Types.CapabilityOutcome,
        timestamp : Nat64,
    ) : Types.CapabilityUsage {
        {
            total = increment(current.total);
            succeeded = if (outcome == #ok) increment(current.succeeded) else current.succeeded;
            denied = if (outcome == #denied) increment(current.denied) else current.denied;
            failed = if (outcome == #failed) increment(current.failed) else current.failed;
            rate_limited = if (outcome == #rate_limited) increment(current.rate_limited) else current.rate_limited;
            busy = if (outcome == #busy) increment(current.busy) else current.busy;
            revoked = if (outcome == #revoked) increment(current.revoked) else current.revoked;
            last_at = ?timestamp;
            last_operation = ?operation;
            last_outcome = ?outcome;
        };
    };

    func increment(value : Nat64) : Nat64 {
        if (value == MAX_COUNTER) value else value + 1;
    };

    func summary(entry : Types.CapabilityRegistryEntry) : Types.CapabilitySummary {
        {
            scope = entry.registration.scope;
            plan_fingerprint = entry.registration.plan_fingerprint;
            kind = entry.registration.kind;
            resource_id = entry.registration.resource_id;
            api = entry.registration.api;
            declaration_fingerprint = entry.registration.declaration_fingerprint;
            grant = entry.registration.grant;
            toggleable = entry.registration.toggleable;
            enabled = entry.enabled;
            created_at = entry.created_at;
            created_by = entry.created_by;
            updated_at = entry.updated_at;
            updated_by = entry.updated_by;
            usage = entry.usage;
        };
    };

    func afterCursor(entryKey : Text, cursor : ?Text) : Bool {
        switch (cursor) {
            case null true;
            case (?value) Text.compare(entryKey, value) == #greater;
        };
    };

    func validRegistration(registration : Types.CapabilityRegistration) : Bool {
        validAppId(registration.scope.app_id) and
        registration.scope.installation_uid > 0 and
        validApi(registration.kind, registration.api) and
        validGrant(registration.kind, registration.grant) and
        registration.toggleable and
        validFingerprint(registration.plan_fingerprint) and
        validFingerprint(registration.declaration_fingerprint) and
        validResource(registration.kind, registration.resource_id);
    };

    func validApi(kind : Types.CapabilityKind, api : Nat) : Bool {
        switch (kind) {
            case (#certified_assets) api == 2;
            case (_) api == 1;
        };
    };

    func validGrant(
        kind : Types.CapabilityKind,
        grant : Types.CapabilityGrantMode,
    ) : Bool {
        switch (kind) {
            case (#backend_calls) grant == #owner_runtime_grant;
            case (#connections) grant == #owner_runtime_grant;
            case (#http_routes) grant == #declaration;
            case (#certified_read_routes) grant == #declaration;
            case (#certified_assets) grant == #declaration;
            case (_) grant == #declaration;
        };
    };

    func validAppId(value : Text) : Bool {
        Scope.validAppId(value);
    };

    func validResource(kind : Types.CapabilityKind, value : Text) : Bool {
        if (value.size() < 1 or value.size() > 64) return false;
        for (char in value.chars()) {
            if (not (
                (char >= 'a' and char <= 'z') or
                (char >= 'A' and char <= 'Z') or
                (char >= '0' and char <= '9') or
                char == '_' or char == '-' or char == '.' or char == ':'
            )) return false;
        };
        switch (kind) {
            case (#backend_calls) value == "default";
            case (#randomness) value == "default";
            case (#https_outcalls) validMountId(value);
            case (#chain_key_signing) validMountId(value);
            case (#stable_store) validMountId(value);
            case (#persistent_browser_storage) value == "background";
            case (#dedicated_resident_origin) value == "background";
            case (#http_routes) validMountId(value);
            case (#certified_read_routes) validMountId(value);
            case (#certified_assets) value == "default";
            case (#public_ingress) validPublicIngressResource(value);
            case (_) true;
        };
    };

    func validPublicIngressResource(value : Text) : Bool {
        if (value.size() < 3 or value.size() > 64) return false;
        let parts = Text.split(value, #char ':');
        let ?protocol = parts.next() else return false;
        let ?method = parts.next() else return false;
        parts.next() == null and validPublicIngressId(protocol) and
        validPublicIngressId(method);
    };

    func validPublicIngressId(value : Text) : Bool {
        if (value.size() < 1 or value.size() > 63) return false;
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

    func validMountId(value : Text) : Bool {
        if (value.size() < 1 or value.size() > 40) return false;
        var first = true;
        for (char in value.chars()) {
            if (first) {
                if (char < 'a' or char > 'z') return false;
                first := false;
            } else if (not (
                (char >= 'a' and char <= 'z') or
                (char >= '0' and char <= '9') or
                char == '_'
            )) return false;
        };
        true;
    };

    func validFingerprint(value : Text) : Bool {
        if (value.size() != 64) return false;
        for (char in value.chars()) {
            if (not (
                (char >= '0' and char <= '9') or
                (char >= 'a' and char <= 'f')
            )) return false;
        };
        true;
    };

    func validUsage(usage : Types.CapabilityUsage) : Bool {
        let sum = Nat64.toNat(usage.succeeded) + Nat64.toNat(usage.denied) +
            Nat64.toNat(usage.failed) + Nat64.toNat(usage.rate_limited) +
            Nat64.toNat(usage.busy) + Nat64.toNat(usage.revoked);
        if (Nat.min(sum, Nat64.toNat(MAX_COUNTER)) != Nat64.toNat(usage.total)) {
            return false;
        };
        switch (usage.last_at, usage.last_operation, usage.last_outcome) {
            case (null, null, null) usage.total == 0;
            case (?_, ?operation, ?_) {
                usage.total > 0 and operation.size() > 0 and
                operation.size() <= MAX_OPERATION_CHARS;
            };
            case (_) false;
        };
    };

    func validateMemory(mem : Types.CapabilityRegistryMemory) : Bool {
        if (Map.size(mem.entries) > MAX_TOTAL) return false;
        let perApp = Map.empty<Text, Nat>();
        let plansByApp = Map.empty<Text, Text>();
        for ((entryKey, entry) in Map.entries(mem.entries)) {
            if (
                not validRegistration(entry.registration) or
                entryKey != key(
                    entry.registration.scope,
                    entry.registration.kind,
                    entry.registration.resource_id,
                ) or
                entry.updated_at < entry.created_at or
                not validUsage(entry.usage)
            ) return false;
            let scopeKey = Scope.key(entry.registration.scope);
            switch (Map.get(plansByApp, Text.compare, scopeKey)) {
                case (?fingerprint) {
                    if (fingerprint != entry.registration.plan_fingerprint) {
                        return false;
                    };
                };
                case null Map.add(
                    plansByApp,
                    Text.compare,
                    scopeKey,
                    entry.registration.plan_fingerprint,
                );
            };
            let count = switch (Map.get(perApp, Text.compare, scopeKey)) {
                case (?current) current + 1;
                case null 1;
            };
            if (count > MAX_PER_APP) return false;
            Map.add(perApp, Text.compare, scopeKey, count);
        };
        true;
    };
};
