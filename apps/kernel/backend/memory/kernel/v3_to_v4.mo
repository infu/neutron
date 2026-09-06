import Map "mo:core/Map";
import Text "mo:core/Text";
import V3 "./v3";
import V4 "./v4";

module {
    public func migrate(old : V3.Mem) : V4.Mem {
        // CapabilityKind gains a variant, so the mutable map cannot be reused
        // with its wider value type. Its immutable entries safely widen while
        // retaining every registration, grant, enablement and usage value.
        let entries = Map.empty<Text, V4.CapabilityRegistryEntry>();
        for ((key, entry) in Map.entries(old.capability_registry.entries)) {
            let widened : V4.CapabilityRegistryEntry = entry;
            Map.add(entries, Text.compare, key, widened);
        };

        // Preserve the exact existing service roots, including cached assertion
        // keys and the certified-assets arena/forest. Custody has its own empty
        // slot registry; no existing assertion key becomes a custody key.
        {
            core = old.core;
            connections = old.connections;
            install = old.install;
            backend_calls = old.backend_calls;
            capability_registry = { entries };
            app_usage = old.app_usage;
            chain_key_signing = old.chain_key_signing;
            wallet_custody_signing = {
                slots = Map.empty<Text, V4.ChainKeySlotState>();
            };
            stable_store = old.stable_store;
            certified_assets = old.certified_assets;
            http_post_update_handlers = old.http_post_update_handlers;
            public_ingress = old.public_ingress;
            vetkeys = old.vetkeys;
        };
    };
};
