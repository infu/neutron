import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Region "mo:core/Region";
import Runtime "mo:core/Runtime";
import Set "mo:core/Set";
import Text "mo:core/Text";
import V3 "../../backend/memory/kernel/v3";
import V4 "../../backend/memory/kernel/v4";
import Migration "../../backend/memory/kernel/v3_to_v4";

func required<T>(value : ?T) : T {
    switch (value) {
        case (?present) present;
        case null Runtime.trap("expected preserved migration value");
    };
};

// This is a compiled WASI test: both fresh initialization and preservation of
// actual Region-backed asset bytes must run, not merely typecheck.
let fresh = V4.init();
assert (Map.size(fresh.wallet_custody_signing.slots) == 0);
assert (Map.size(fresh.chain_key_signing.slots) == 0);
assert (Map.size(fresh.capability_registry.entries) == 0);
assert (fresh.install.next_installation_uid == 1);
assert (fresh.install.browser_origin_epoch == null);
assert (fresh.install.pending == null);
assert (fresh.backend_calls.next_id == 1);
assert (fresh.stable_store.next_namespace_uid == 1);
assert (fresh.stable_store.next_revision == 1);
assert (Region.size(fresh.certified_assets.arena.region) == 0);
assert (fresh.certified_assets.authenticated_forest.header.healthy);
assert (fresh.public_ingress.next_dispatch_id == 1);
assert (fresh.vetkeys.next_slot_uid == 1);

let old = V3.init();
let owner = Principal.fromText("aaaaa-aa");
let scope : V3.AppScope = { app_id = "sample"; installation_uid = 71 };
let instance : V3.AppInstance = {
    scope;
    version = 315;
    deployment_id = "deployed";
    capability_plan_fingerprint = "plan";
    resident_frame_security = #persistent_dedicated_v1;
    browser_origin_nonce = "origin-nonce";
    browser_origin_authority_epoch = 18;
};
let asset : V3.Asset = {
    id = "/sample/data";
    chunks = 1;
    content = ["retained bytes"];
    content_encoding = "identity";
    content_type = "text/plain";
};
Map.add(old.core.assets, Text.compare, asset.id, asset);
Set.add(old.core.authorized, Principal.compare, owner);
let flow : V3.OAuthFlow = {
    flow_id_hash = "flow-hash";
    owner_principal = owner;
    owner_scope = scope;
    provider = "provider";
    declaration_scopes = ["read"];
    pkce_verifier = "verifier";
    callback_url = "https://example.test/callback";
    created_at = 20;
    expires_at = 80;
    status = #exchanging;
};
Map.add(old.connections.flows, Blob.compare, flow.flow_id_hash, flow);
let connection : V3.Connection = {
    owner_scope = scope;
    provider = "provider";
    declaration_scopes = ["read"];
    credential = "stored-credential";
    created_at = 21;
};
Map.add(old.connections.connections, Text.compare, "connection", connection);
old.install.browser_origin_epoch := ?18;
old.install.next_installation_uid := 80;
old.install.committed_app_instances := [instance];
old.install.pending := ?{
    deployment_id = "pending";
    allocation_start_uid = 80;
    copies = [{ source = "/staged"; target = "/committed" }];
    clear_prefixes = ["/old"];
    removed_apps = ["retired"];
    committed_app_instances = [instance];
    target_app_instances = [instance];
};
old.backend_calls.next_id := 19;
let reservation : V3.BackendCallReservation = {
    id = 18;
    app_scope = scope;
    scope = #exact({ principal = owner; method = "method" });
    created_at = 23;
    created_by = owner;
};
Map.add(old.backend_calls.reservations, Nat.compare, 18, reservation);

// Exercise every previously released capability kind, both enablement values,
// both grant modes, and non-zero values in every usage counter. Widening must
// preserve every immutable entry exactly, including denial/revocation history.
let kinds : [V3.CapabilityKind] = [
    #backend_calls, #randomness, #https_outcalls, #chain_key_signing,
    #stable_store, #vetkeys, #scheduled_tasks, #connections,
    #persistent_browser_storage, #dedicated_resident_origin, #http_routes,
    #certified_read_routes, #certified_assets, #public_ingress,
];
let outcomes : [V3.CapabilityOutcome] = [
    #ok, #denied, #failed, #rate_limited, #busy, #revoked,
];
var index = 0;
for (kind in kinds.vals()) {
    let entry : V3.CapabilityRegistryEntry = {
        registration = {
            scope;
            plan_fingerprint = "plan-" # Nat.toText(index);
            kind;
            resource_id = "resource-" # Nat.toText(index);
            api = 1;
            declaration_fingerprint = "declaration-" # Nat.toText(index);
            grant = if (index % 2 == 0) #declaration else #owner_runtime_grant;
            toggleable = index % 3 == 0;
        };
        enabled = index % 2 == 0;
        created_at = 100;
        created_by = owner;
        updated_at = 120;
        updated_by = Principal.fromText("2vxsx-fae");
        usage = {
            total = 30;
            succeeded = 8;
            denied = 4;
            failed = 3;
            rate_limited = 2;
            busy = 6;
            revoked = 7;
            last_at = ?Nat64.fromNat(1000 + index);
            last_operation = ?("operation-" # Nat.toText(index));
            last_outcome = ?outcomes[index % outcomes.size()];
        };
    };
    Map.add(old.capability_registry.entries, Text.compare, Nat.toText(index), entry);
    index += 1;
};

let usage : V3.AppUsage = {
    scope;
    days = Map.empty<Nat64, V3.AppUsageDay>();
    var lifetime_instructions = 1200;
    var lifetime_executions = 12;
    var lifetime_incoming_cycles_accepted = 1300;
    var lifetime_outgoing_cycles_attached = 1400;
    var lifetime_outgoing_cycles_refunded = 150;
};
Map.add(old.app_usage.by_scope, Text.compare, "sample:71", usage);
old.app_usage.last_seen_at := 1001;
old.app_usage.next_outgoing_cycle_reservation_id := 81;
let assertionSlot : V3.ChainKeySlotState = {
    declaration_fingerprint = "assertion-declaration";
    identity_fingerprint = "assertion-identity";
    cached_public_key = ?"existing assertion public key";
};
Map.add(old.chain_key_signing.slots, Text.compare, "sample:71:identity", assertionSlot);
old.stable_store.next_namespace_uid := 17;
old.stable_store.next_revision := 150;
old.stable_store.total_entries := 1;
old.stable_store.total_bytes := 9;
let store : V3.StableStoreState = {
    scope;
    id = "journal";
    namespace_uid = 16;
    var schema_version = 3;
    var max_entries = 100;
    var max_key_bytes = 30;
    var max_value_bytes = 100;
    var max_bytes = 10000;
    var entries = Map.empty<Blob, V3.StableStoreEntry>();
    var bytes = 9;
    var oversized_entries = 0;
    var observed_revision = 149;
};
let storedEntry : V3.StableStoreEntry = {
    value = "retained";
    revision = 149;
    schema_version = 3;
};
Map.add(store.entries, Blob.compare, ("k" : Blob), storedEntry);
Map.add(old.stable_store.stores, Text.compare, "sample:71:journal", store);
Map.add(old.stable_store.usage_by_scope, Text.compare, "sample:71", { entries = 1; bytes = 9 });

assert (Region.grow(old.certified_assets.arena.region, 1) == 0);
Region.storeBlob(old.certified_assets.arena.region, 24, "preserved asset bytes");
old.certified_assets.arena.committed_bytes := 65536;
old.certified_assets.arena.mutation_epoch := 17;
old.certified_assets.next_stage_id := 29;
old.certified_assets.next_content_id := 33;
old.certified_assets.authenticated_forest.header.commit_sequence := 32;
Map.add(old.certified_assets.route_index, Text.compare, "/sample/asset", "record-7");
old.http_post_update_handlers.last_seen_at := 41;
old.http_post_update_handlers.pending := 2;
old.http_post_update_handlers.replay_reserved_bytes := 100;
old.http_post_update_handlers.global_rate := { window_started_at = 40; accepted = 3 };
Map.add(old.http_post_update_handlers.pending_by_scope, Text.compare, "sample:71", 2);
old.public_ingress.next_dispatch_id := 49;
old.public_ingress.pending_count := 1;
old.public_ingress.last_seen_at := 47;
old.public_ingress.global_rate := { window_started_at = 45; accepted = 9 };
let dispatch : V3.PublicIngressPendingDispatch = {
    dispatch_id = 48;
    scope;
    protocol = "protocol";
    method = "method";
    request_hash = "request-hash";
    route_fingerprint = "route-fingerprint";
    authority_epoch = 5;
    accepted_at = 46;
    additional_cycles_available = 120;
    additional_cycles_requested = 110;
    state = #completed("result");
};
Map.add(old.public_ingress.pending, Nat64.compare, (48 : Nat64), dispatch);
old.vetkeys.next_slot_uid := 22;
Map.add(old.vetkeys.slot_index_by_scope_and_id, Text.compare, "sample:71:secret", 21);
old.vetkeys.retired_tombstones := [{
    slot_uid = 20;
    retired_at = 50;
    retired_by = owner;
    reason = #app_uninstalled;
}];
old.vetkeys.audit := [{
    at = 51;
    scope;
    slot_uid = ?21;
    slot_id = "secret";
    generation = ?3;
    action = #derive;
    principal = owner;
    outcome = #ok;
}];

let migrated = Migration.migrate(old);
assert (Map.size(migrated.wallet_custody_signing.slots) == 0);
assert (required(Map.get(migrated.core.assets, Text.compare, asset.id)) == asset);
assert (Set.contains(migrated.core.authorized, Principal.compare, owner));
assert (required(Map.get(migrated.connections.flows, Blob.compare, flow.flow_id_hash)) == flow);
assert (required(Map.get(migrated.connections.connections, Text.compare, "connection")) == connection);
assert (migrated.install.browser_origin_epoch == ?18);
assert (migrated.install.next_installation_uid == 80);
assert (migrated.install.committed_app_instances == [instance]);
assert (migrated.install.pending == old.install.pending);
assert (migrated.backend_calls.next_id == 19);
assert (required(Map.get(migrated.backend_calls.reservations, Nat.compare, 18)) == reservation);
assert (Map.size(migrated.capability_registry.entries) == kinds.size());
for ((key, entry) in Map.entries(old.capability_registry.entries)) {
    let widened : V4.CapabilityRegistryEntry = entry;
    assert (required(Map.get(migrated.capability_registry.entries, Text.compare, key)) == widened);
};
let retainedUsage = required(Map.get(migrated.app_usage.by_scope, Text.compare, "sample:71"));
assert (retainedUsage.lifetime_instructions == 1200);
assert (retainedUsage.lifetime_executions == 12);
assert (retainedUsage.lifetime_incoming_cycles_accepted == 1300);
assert (retainedUsage.lifetime_outgoing_cycles_attached == 1400);
assert (retainedUsage.lifetime_outgoing_cycles_refunded == 150);
assert (migrated.app_usage.last_seen_at == 1001);
assert (migrated.app_usage.next_outgoing_cycle_reservation_id == 81);
assert (required(Map.get(migrated.chain_key_signing.slots, Text.compare, "sample:71:identity")) == assertionSlot);
assert (migrated.stable_store.next_namespace_uid == 17);
assert (migrated.stable_store.next_revision == 150);
assert (migrated.stable_store.total_entries == 1);
assert (migrated.stable_store.total_bytes == 9);
let retainedStore = required(Map.get(migrated.stable_store.stores, Text.compare, "sample:71:journal"));
assert (retainedStore.namespace_uid == 16);
assert (retainedStore.schema_version == 3);
assert (retainedStore.observed_revision == 149);
assert (required(Map.get(retainedStore.entries, Blob.compare, ("k" : Blob))) == storedEntry);
assert (Region.size(migrated.certified_assets.arena.region) == 1);
assert (Region.loadBlob(migrated.certified_assets.arena.region, 24, 21) == ("preserved asset bytes" : Blob));
assert (migrated.certified_assets.arena.committed_bytes == 65536);
assert (migrated.certified_assets.arena.mutation_epoch == 17);
assert (migrated.certified_assets.next_stage_id == 29);
assert (migrated.certified_assets.next_content_id == 33);
assert (migrated.certified_assets.authenticated_forest.header.commit_sequence == 32);
assert (required(Map.get(migrated.certified_assets.route_index, Text.compare, "/sample/asset")) == "record-7");
assert (migrated.http_post_update_handlers.last_seen_at == 41);
assert (migrated.http_post_update_handlers.pending == 2);
assert (migrated.http_post_update_handlers.replay_reserved_bytes == 100);
assert (migrated.http_post_update_handlers.global_rate == ({ window_started_at = 40; accepted = 3 } : V4.HttpPostUpdateHandlerRateCounter));
assert (required(Map.get(migrated.http_post_update_handlers.pending_by_scope, Text.compare, "sample:71")) == 2);
assert (migrated.public_ingress.next_dispatch_id == 49);
assert (migrated.public_ingress.pending_count == 1);
assert (migrated.public_ingress.last_seen_at == 47);
assert (migrated.public_ingress.global_rate == ({ window_started_at = 45; accepted = 9 } : V4.PublicIngressRateCounter));
assert (required(Map.get(migrated.public_ingress.pending, Nat64.compare, (48 : Nat64))) == dispatch);
assert (migrated.vetkeys.next_slot_uid == 22);
assert (required(Map.get(migrated.vetkeys.slot_index_by_scope_and_id, Text.compare, "sample:71:secret")) == 21);
assert (migrated.vetkeys.retired_tombstones == old.vetkeys.retired_tombstones);
assert (migrated.vetkeys.audit == old.vetkeys.audit);

// Prove roots and nested mutable objects were restored, not reconstructed with
// similar snapshots. The capability registry alone must be an independent map.
Map.add(migrated.core.assets, Text.compare, "/after", asset);
assert (Map.containsKey(old.core.assets, Text.compare, "/after"));
Map.add(migrated.connections.connections, Text.compare, "after", connection);
assert (Map.containsKey(old.connections.connections, Text.compare, "after"));
migrated.install.next_installation_uid := 81;
assert (old.install.next_installation_uid == 81);
migrated.backend_calls.next_id := 20;
assert (old.backend_calls.next_id == 20);
retainedUsage.lifetime_executions := 13;
assert (usage.lifetime_executions == 13);
migrated.app_usage.last_seen_at := 1002;
assert (old.app_usage.last_seen_at == 1002);
Map.add(migrated.chain_key_signing.slots, Text.compare, "after", assertionSlot);
assert (Map.containsKey(old.chain_key_signing.slots, Text.compare, "after"));
Map.add(migrated.wallet_custody_signing.slots, Text.compare, "custody", assertionSlot);
assert (not Map.containsKey(old.chain_key_signing.slots, Text.compare, "custody"));
assert (Map.size(fresh.wallet_custody_signing.slots) == 0);
retainedStore.observed_revision := 151;
assert (store.observed_revision == 151);
migrated.stable_store.next_revision := 152;
assert (old.stable_store.next_revision == 152);
migrated.certified_assets.next_stage_id := 30;
assert (old.certified_assets.next_stage_id == 30);
Region.storeBlob(migrated.certified_assets.arena.region, 24, "shared");
assert (Region.loadBlob(old.certified_assets.arena.region, 24, 6) == ("shared" : Blob));
migrated.certified_assets.authenticated_forest.header.commit_sequence := 33;
assert (old.certified_assets.authenticated_forest.header.commit_sequence == 33);
migrated.http_post_update_handlers.pending := 3;
assert (old.http_post_update_handlers.pending == 3);
migrated.public_ingress.next_dispatch_id := 50;
assert (old.public_ingress.next_dispatch_id == 50);
migrated.vetkeys.next_slot_uid := 23;
assert (old.vetkeys.next_slot_uid == 23);

let originalEntry : V4.CapabilityRegistryEntry = required(Map.get(old.capability_registry.entries, Text.compare, "0"));
let custodyEntry : V4.CapabilityRegistryEntry = {
    originalEntry with
    registration = { originalEntry.registration with kind = #wallet_custody_signing };
};
Map.add(migrated.capability_registry.entries, Text.compare, "custody", custodyEntry);
assert (Map.size(migrated.capability_registry.entries) == kinds.size() + 1);
assert (not Map.containsKey(old.capability_registry.entries, Text.compare, "custody"));
Map.add(old.capability_registry.entries, Text.compare, "old-after", required(Map.get(old.capability_registry.entries, Text.compare, "0")));
assert (not Map.containsKey(migrated.capability_registry.entries, Text.compare, "old-after"));
