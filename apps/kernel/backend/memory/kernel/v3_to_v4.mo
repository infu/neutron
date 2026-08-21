import Map "mo:core/Map";
import Text "mo:core/Text";
import V3 "./v3";
import V4 "./v4";

module {
    // V3 state is retained by reference. The new media authority starts empty,
    // so an upgrade can only revoke browser capture; it can never revive a
    // pre-upgrade media session.
    public func migrate(old : V3.Mem) : V4.Mem {
        let registry = Map.empty<Text, V4.CapabilityRegistryEntry>();
        for ((key, entry) in Map.entries(old.capability_registry.entries)) {
            let registration = entry.registration;
            Map.add(registry, Text.compare, key, {
                registration = {
                    scope = registration.scope;
                    plan_fingerprint = registration.plan_fingerprint;
                    kind = migrateKind(registration.kind);
                    resource_id = registration.resource_id;
                    api = registration.api;
                    declaration_fingerprint = registration.declaration_fingerprint;
                    grant = registration.grant;
                    toggleable = registration.toggleable;
                };
                enabled = entry.enabled;
                created_at = entry.created_at;
                created_by = entry.created_by;
                updated_at = entry.updated_at;
                updated_by = entry.updated_by;
                usage = entry.usage;
            });
        };
        {
            core = old.core;
            connections = old.connections;
            install = old.install;
            backend_calls = old.backend_calls;
            capability_registry = { entries = registry };
            media_sessions = {
                var next_session_id = 1;
                var authority_epoch = 1;
                var active_session_id = null;
                leases = Map.empty<Text, V4.MediaLease>();
            };
            app_usage = old.app_usage;
            chain_key_signing = old.chain_key_signing;
            stable_store = old.stable_store;
            certified_assets = old.certified_assets;
            http_post_update_handlers = old.http_post_update_handlers;
            public_ingress = old.public_ingress;
            vetkeys = old.vetkeys;
        }
    };

    func migrateKind(kind : V3.CapabilityKind) : V4.CapabilityKind {
        switch (kind) {
            case (#backend_calls) #backend_calls;
            case (#randomness) #randomness;
            case (#https_outcalls) #https_outcalls;
            case (#chain_key_signing) #chain_key_signing;
            case (#stable_store) #stable_store;
            case (#vetkeys) #vetkeys;
            case (#scheduled_tasks) #scheduled_tasks;
            case (#connections) #connections;
            case (#persistent_browser_storage) #persistent_browser_storage;
            case (#dedicated_resident_origin) #dedicated_resident_origin;
            case (#http_routes) #http_routes;
            case (#certified_read_routes) #certified_read_routes;
            case (#certified_assets) #certified_assets;
            case (#public_ingress) #public_ingress;
        }
    };
}
