import Map "mo:core/Map";

module {
    // Kernel-private ownership root. App source can receive this only through
    // compiler-resolved factories; app-authored text never becomes a scope.
    public type AppScope = {
        app_id : Text;
        installation_uid : Nat64;
    };

    public type ResidentFrameSecurity = {
        #credentialless_opaque_v1;
        #credentialless_ephemeral_dedicated_v1;
        #persistent_dedicated_v1;
    };

    // Complete compiler-authored runtime declaration. It intentionally omits
    // installation identity: only the kernel allocates that identity.
    public type RuntimeApp = {
        app_id : Text;
        version : Nat;
        capability_plan_fingerprint : Text;
        resident_frame_security : ResidentFrameSecurity;
    };

    // Durable identity for one installed app instance. The deployment and
    // plan fingerprint make every committed or staged projection independently
    // checkable against the actor that is currently executing.
    public type AppInstance = {
        scope : AppScope;
        version : Nat;
        deployment_id : Text;
        capability_plan_fingerprint : Text;
        resident_frame_security : ResidentFrameSecurity;
        browser_origin_nonce : Text;
        browser_origin_authority_epoch : Nat64;
    };

    public type CapabilityKind = {
        #backend_calls;
        #randomness;
        #https_outcalls;
        #chain_key_signing;
        #stable_store;
        #vetkeys;
        #scheduled_tasks;
        #connections;
        #persistent_browser_storage;
        #dedicated_resident_origin;
        #http_routes;
        #certified_read_routes;
        #certified_assets;
        #public_ingress;
    };

    public type CapabilityGrantMode = {
        #declaration;
        #owner_runtime_grant;
    };

    // Compiler-authored exact runtime resource. Descriptive manifest text is
    // deliberately absent; the fingerprint covers authority-bearing fields.
    public type CapabilityRegistration = {
        scope : AppScope;
        plan_fingerprint : Text;
        kind : CapabilityKind;
        resource_id : Text;
        api : Nat;
        declaration_fingerprint : Text;
        grant : CapabilityGrantMode;
        toggleable : Bool;
    };

    public type CapabilityOutcome = {
        #ok;
        #denied;
        #failed;
        #rate_limited;
        #busy;
        #revoked;
    };

    public type CapabilityUsage = {
        total : Nat64;
        succeeded : Nat64;
        denied : Nat64;
        failed : Nat64;
        rate_limited : Nat64;
        busy : Nat64;
        revoked : Nat64;
        last_at : ?Nat64;
        last_operation : ?Text;
        last_outcome : ?CapabilityOutcome;
    };

    public type CapabilityRegistryEntry = {
        registration : CapabilityRegistration;
        enabled : Bool;
        created_at : Nat64;
        created_by : Principal;
        updated_at : Nat64;
        updated_by : Principal;
        usage : CapabilityUsage;
    };

    public type CapabilityRegistryMemory = {
        entries : Map.Map<Text, CapabilityRegistryEntry>;
    };

    public type CapabilitySummary = {
        scope : AppScope;
        plan_fingerprint : Text;
        kind : CapabilityKind;
        resource_id : Text;
        api : Nat;
        declaration_fingerprint : Text;
        grant : CapabilityGrantMode;
        toggleable : Bool;
        enabled : Bool;
        created_at : Nat64;
        created_by : Principal;
        updated_at : Nat64;
        updated_by : Principal;
        usage : CapabilityUsage;
    };

    public type CapabilityPageInput = {
        after : ?Text;
        limit : Nat;
    };

    public type CapabilityPage = {
        entries : [CapabilitySummary];
        next : ?Text;
    };

    public type CapabilitySetEnabledInput = {
        app_id : Text;
        installation_uid : Nat64;
        kind : CapabilityKind;
        resource_id : Text;
        enabled : Bool;
    };

    // A lease captures one actor-local revocation epoch. Its authority is
    // irreversible: disabling and then re-enabling the resource cannot revive
    // an operation that was in flight across the toggle.
    public type RuntimeLease = {
        active : () -> Bool;
    };

    // Narrow structural view supplied to specialized brokers. It exposes no
    // registry configuration, lifecycle reconciliation, or toggle authority.
    public type RuntimeRegistry = {
        allowed : (AppScope, CapabilityKind, Text) -> Bool;
        lease : (AppScope, CapabilityKind, Text) -> ?RuntimeLease;
        record : (
            AppScope,
            CapabilityKind,
            Text,
            Text,
            CapabilityOutcome,
        ) -> Bool;
    };
};
