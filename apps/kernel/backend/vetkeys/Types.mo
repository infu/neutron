import Map "mo:core/Map";
import Caps "mo:neutron-capabilities";
import CapabilityTypes "../capabilities/Types";

module {
    public type AppScope = CapabilityTypes.AppScope;
    public type AppInstance = CapabilityTypes.AppInstance;

    public type Environment = Caps.VetKeyEnvironmentV1;
    public type SlotStatus = Caps.VetKeySlotStatusV1;
    public type GenerationStatus = Caps.VetKeyGenerationStatusV1;

    public type RetirementReason = {
        #owner_retired;
        #app_uninstalled;
    };

    public type Generation = {
        generation : Nat64;
        status : GenerationStatus;
        namespace_version : Nat;
        key_name : Text;
        cached_public_key : ?Blob;
        public_fingerprint : ?Blob;
        created_at : Nat64;
        created_by : Principal;
    };

    public type Slot = {
        slot_uid : Nat;
        scope : AppScope;
        slot_id : Text;
        namespace_nonce : Blob;
        key_holder : Principal;
        status : SlotStatus;
        current_generation : Nat64;
        next_generation : Nat64;
        generations : [Generation];
        created_at : Nat64;
        created_by : Principal;
        updated_at : Nat64;
        updated_by : Principal;
        last_used_at : ?Nat64;
        total_derivations : Nat;
        approximate_cycle_spend : Nat;
    };

    // Retired records intentionally omit app ids, slot ids, namespace nonces,
    // contexts, and derivation inputs. A never-reused uid is enough to retain a
    // bounded administrative fact without turning uninstall churn into an
    // unbounded sensitive metadata store.
    public type RetiredTombstone = {
        slot_uid : Nat;
        retired_at : Nat64;
        retired_by : Principal;
        reason : RetirementReason;
    };

    public type AuditAction = {
        #reserve;
        #enable;
        #disable;
        #rotate;
        #retire_generation;
        #transfer;
        #retire_slot;
        #uninstall;
        #derive;
        #public_key;
        #manifest_suspend;
    };

    public type AuditOutcome = {
        #ok;
        #denied;
        #busy;
        #low_cycles;
        #unavailable;
        #failed;
    };

    public type AuditEntry = {
        at : Nat64;
        scope : AppScope;
        slot_uid : ?Nat;
        slot_id : Text;
        generation : ?Nat64;
        action : AuditAction;
        principal : Principal;
        outcome : AuditOutcome;
    };

    public type Memory = {
        var next_slot_uid : Nat;
        slots_by_uid : Map.Map<Nat, Slot>;
        slot_index_by_scope_and_id : Map.Map<Text, Nat>;
        var retired_tombstones : [RetiredTombstone];
        var audit : [AuditEntry];
    };

    public type Error = {
        #invalid_app_id;
        #invalid_slot_id;
        #invalid_namespace_nonce;
        #invalid_key_holder;
        #invalid_key_name;
        #slot_limit;
        #app_slot_limit;
        #not_found;
        #previous_exists;
        #generation_not_found;
        #current_generation;
        #invariant_violation;
        #owner_required;
        #invalid_transition;
    };

    public type Result<T> = {
        #ok : T;
        #err : Error;
    };

    public type VetKeyError = Caps.VetKeysPublicErrorV1;

    public type OperationResult<T> = {
        #ok : T;
        #err : VetKeyError;
    };

    public type ReserveInput = {
        scope : AppScope;
        slot_id : Text;
        namespace_nonce : Blob;
        key_holder : Principal;
        key_name : Text;
        now : Nat64;
        changed_by : Principal;
    };

    public type SlotSummary = {
        slot_uid : Nat;
        app_id : Text;
        installation_uid : Nat64;
        slot_id : Text;
        key_holder : Principal;
        status : SlotStatus;
        current_generation : Nat64;
        previous_generation : ?Nat64;
        created_at : Nat64;
        updated_at : Nat64;
        last_used_at : ?Nat64;
        total_derivations : Nat;
        approximate_cycle_spend : Nat;
    };

    public type SlotDeclaration = {
        id : Text;
        purpose : Text;
    };

    public type Declaration = {
        description : Text;
        slots : [SlotDeclaration];
    };

    public type AppDeclaration = {
        app_scope : AppScope;
        vetkeys : ?Declaration;
    };

    public type GenerationSummary = Caps.VetKeyGenerationSummaryV1;

    // App-facing summaries never include app_id or slot_uid. The compiler-
    // injected capability has already captured the installed app identity.
    public type PublicSlotSummary = Caps.VetKeySlotSummaryV1;

    public type AdminSlotSummary = {
        app_id : Text;
        installation_uid : Nat64;
        slot_uid : Nat;
        slot : Text;
        purpose : ?Text;
        key_holder : Principal;
        status : SlotStatus;
        current_generation : Nat64;
        previous_generation : ?Nat64;
        generations : [GenerationSummary];
        created_at : Nat64;
        created_by : Principal;
        updated_at : Nat64;
        updated_by : Principal;
        last_used_at : ?Nat64;
        total_derivations : Nat;
        approximate_cycle_spend : Nat;
    };

    public type AdminSnapshot = {
        environment : ?Environment;
        slots : [AdminSlotSummary];
        audit : [AuditEntry];
    };

    public type PublicKeyRequest = Caps.VetKeyPublicKeyRequestV1;
    public type PublicKeyInfo = Caps.VetKeyPublicKeyInfoV1;
    public type PublicKeyResult = Caps.VetKeyPublicKeyResultV1;
    public type PublicCapability = Caps.VetKeysPublicV1;

    // These requests are trusted kernel-internal wire records. The source-bound
    // browser broker derives app_id from its live endpoint and adds it only
    // after rejecting payload-supplied app identities.
    public type AppSlotInput = {
        app_id : Text;
        slot_id : Text;
    };

    public type AppGenerationInput = {
        app_id : Text;
        slot_id : Text;
        generation : Nat64;
    };

    public type TransferInput = {
        app_id : Text;
        slot_id : Text;
        new_holder : Principal;
    };

    public type DeriveInput = {
        app_id : Text;
        slot_id : Text;
        // Captured by the trusted browser broker from the never-reused kernel
        // slot record. App SDK payloads never contain this field.
        expected_slot_uid : Nat;
        generation : Nat64;
        transport_public_key : Blob;
    };

    public type DeriveOutput = {
        encrypted_key : Blob;
        public_info : PublicKeyInfo;
    };

    public type DeriveResult = OperationResult<DeriveOutput>;

    public type AdapterBlobResult = {
        #ok : Blob;
        #err;
    };

    public type AdapterDeriveResult = {
        #ok : { encrypted_key : Blob; charged_cycles : Nat };
        #err : { charged_cycles : Nat };
    };

    public type AdapterPublicKeyRequest = {
        context : Blob;
        key_name : Text;
    };

    public type AdapterDeriveRequest = {
        context : Blob;
        derivation_input : Blob;
        transport_public_key : Blob;
        key_name : Text;
        cycles : Nat;
    };

    public type Adapter = {
        random_nonce : () -> async AdapterBlobResult;
        public_key : AdapterPublicKeyRequest -> async AdapterBlobResult;
        derive_key : AdapterDeriveRequest -> async AdapterDeriveResult;
        cycle_balance : () -> Nat;
    };
};
