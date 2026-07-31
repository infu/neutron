import Capabilities "../capabilities/Types";
import Memory "../memory/mail/v1";

module {
    public let SLOT_ID = "mailbox";
    public let MAX_REWRAP_BATCH : Nat = 50;
    public let MAX_INBOX_RECORDS : Nat = 2_000;
    public let MAX_OUTBOX_RECORDS : Nat = 1_000;

    public type SlotStatus = Capabilities.VetKeySlotStatus;
    public type GenerationStatus = Capabilities.VetKeyGenerationStatus;
    public type Environment = Capabilities.VetKeyEnvironment;
    public type GenerationSummary = Capabilities.VetKeyGenerationSummary;
    public type SlotSummary = Capabilities.VetKeySlotSummary;
    public type PublicKeyMaterial = Capabilities.VetKeyPublicInfo;
    public type PublicKeyError = Capabilities.VetKeyError;
    public type PublicKeyResult = Capabilities.VetKeyPublicResult;
    public type VetKeysPublic = Capabilities.VetKeysPublic;
    public type ReferenceCounts = {
        settings : Nat;
        inbox : Nat;
        outbox : Nat;
        total : Nat;
    };
    public type Progress = {
        mail_revision : Nat;
        key_holder : Principal;
        current_epoch : Nat64;
        previous_epoch : ?Nat64;
        previous_references : ReferenceCounts;
        ready_to_retire : Bool;
    };
    public type Error = {
        #invalid_request;
        #not_configured;
        #already_configured;
        #not_reserved;
        #disabled;
        #manifest_suspended;
        #generation_unavailable;
        #key_holder_changed;
        #rotation_in_progress;
        #rotation_not_ready;
        #capability_changed;
        #vetkeys : PublicKeyError;
        #previous_references : ReferenceCounts;
        #revision_conflict;
        #corrupt_state;
    };
    public type Result = { #ok : Progress; #err : Error };
    public type Dispatch = {
        mode : { #setup; #rotate };
        slot : SlotSummary;
        previous_key_info : ?Memory.PublicKeyInfo;
    };
    public type Start = { #dispatch : Dispatch; #complete : Progress; #err : Error };

    public type RewrapTarget = {
        #settings : {
            expected_revision : Nat64;
            expected_local_wrapped_cek : Blob;
            replacement_local_wrapped_cek : Blob;
        };
        #inbox : {
            local_id : Nat;
            expected_local_wrapped_cek : Blob;
            replacement_local_wrapped_cek : Blob;
        };
        #outbox : {
            local_id : Nat;
            expected_local_wrapped_cek : Blob;
            replacement_local_wrapped_cek : Blob;
        };
    };
    public type RewrapRequest = {
        expected_current_epoch : Nat64;
        expected_previous_epoch : Nat64;
        targets : [RewrapTarget];
    };
    public type RewrapResult = {
        #ok : {
            changed : Nat;
            message_wraps_changed : Nat;
            settings_wrap_changed : Bool;
            progress : Progress;
        };
        #err : Error;
    };
};
