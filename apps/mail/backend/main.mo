import Blob "mo:core/Blob";
import Principal "mo:core/Principal";
import Time "mo:core/Time";
import NeutronCapabilities "mo:neutron-capabilities";
import Crypto "./crypto/Service";
import Recipients "./recipients/Service";
import Delivery "./mailbox/Delivery";
import Receive "./mailbox/Receive";
import Settings "./settings/Service";
import Store "./mailbox/Store";
import Memory "./memory/mail/v1";
import RemoteWire "./protocol/RemoteWire";

module {
    public type NeutronContactMatchV2 = {
        contact_id : Nat;
        contact_revision : Nat;
        contact_name : Text;
        principal : Principal;
    };

    public type NeutronContactLookupV2 = {
        book_revision : Nat;
        integrity_ok : Bool;
        match : ?NeutronContactMatchV2;
    };

    public type AppCalls = {
        contacts : {
            contacts_neutron_lookup_v2 : {
                principal : Principal;
            } -> NeutronContactLookupV2;
            contacts_neutron_search_v2 : Recipients.Search;
            contacts_neutron_revision_v2 : (()) -> Nat;
        };
    };

    // Keep every type reachable from a public method app-local and concrete.
    // The Neutron method-schema generator resolves local aliases but cannot
    // inspect imported module aliases or generic Result<T> applications.
    // These are structural mirrors of the service types used below; changing
    // one therefore remains a Motoko compile error instead of a wire drift.
    public type MailStoreError = {
        #invalid_request;
        #not_found;
        #revision_conflict : {
            mail_revision : Nat;
            contacts_revision : Nat;
            cleanup_epoch : Nat;
        };
        #contacts_conflict;
        #clock_invalid;
        #corrupt_state;
    };

    public type MailOutboxState = {
        #sending;
        #accepted : { received_at_ns : Int };
        #not_sent : {
            #invalid;
            #rate_limited;
            #mailbox_full;
            #stale_key;
            #crypto_unavailable;
            #permission_required;
        };
        #delivery_uncertain;
    };

    public type MailCurrentContact = {
        #in_contacts : {
            contact_id : Nat;
            contact_revision : Nat;
            contact_name : Text;
        };
        #not_in_contacts;
        #contact_conflict;
    };

    public type MailEncryptedHeader = {
        message_id : Blob;
        delivery_key_epoch : Nat64;
        delivery_key_fingerprint : Blob;
        local_wrap_epoch : Nat64;
        local_wrap_fingerprint : Blob;
        local_wrapped_cek : Blob;
        header_nonce : Blob;
        header_ciphertext_and_tag : Blob;
    };

    public type MailEncryptedContent = {
        header : MailEncryptedHeader;
        body_nonce : Blob;
        body_ciphertext_and_tag : Blob;
    };

    public type MailSetupStatus = {
        #not_configured;
        #configured : {
            key_holder : Principal;
            current_epoch : Nat64;
            previous_epoch : ?Nat64;
        };
    };

    public type MailStorageLevel = {
        #normal;
        #approaching_limit;
        #almost_full;
    };

    public type MailStatus = {
        mail_revision : Nat;
        contacts_revision : Nat;
        cleanup_epoch : Nat;
        setup : MailSetupStatus;
        encrypted_settings_revision : ?Nat64;
        inbox_count : Nat;
        inbox_bytes : Nat;
        unknown_at_receipt_count : Nat;
        unknown_at_receipt_bytes : Nat;
        unread_count : Nat;
        sent_count : Nat;
        outbox_count : Nat;
        active_sends : Nat;
        sent_and_outbox_bytes : Nat;
        storage_level : MailStorageLevel;
    };

    public type MailStatusResult = {
        #ok : MailStatus;
        #err : MailStoreError;
    };

    public type MailPulse = {
        mail_revision : Nat;
        contacts_revision : Nat;
        cleanup_epoch : Nat;
        inbox_count : Nat;
        unread_count : Nat;
    };

    public type MailPulseResult = {
        #ok : MailPulse;
        #err : MailStoreError;
    };

    public type MailFolder = {
        #inbox;
        #sent;
        #outbox;
    };

    public type MailListRequest = {
        folder : MailFolder;
        unread_only : Bool;
        offset : Nat;
        limit : Nat;
        expected_mail_revision : ?Nat;
        expected_contacts_revision : ?Nat;
    };

    public type MailInboxListItem = {
        local_id : Nat;
        sender : Principal;
        received_at_ns : Int;
        read : Bool;
        known_at_receipt : Bool;
        current_contact : MailCurrentContact;
        retained_bytes : Nat;
        encrypted_header : MailEncryptedHeader;
    };

    public type MailOutboxListItem = {
        local_id : Nat;
        recipient : Principal;
        contact_id : ?Nat;
        contact_revision : ?Nat;
        current_contact : MailCurrentContact;
        created_at_ns : Int;
        updated_at_ns : Int;
        cleanup_epoch : Nat;
        attempt_no : Nat;
        state : MailOutboxState;
        retained_bytes : Nat;
        encrypted_header : MailEncryptedHeader;
    };

    public type MailListItem = {
        #inbox : MailInboxListItem;
        #sent : MailOutboxListItem;
        #outbox : MailOutboxListItem;
    };

    public type MailListPage = {
        mail_revision : Nat;
        contacts_revision : Nat;
        cleanup_epoch : Nat;
        items : [MailListItem];
        total : Nat;
        next_offset : ?Nat;
        ciphertext_bytes : Nat;
    };

    public type MailListResult = {
        #ok : MailListPage;
        #err : MailStoreError;
    };

    public type MailRecordStore = {
        #inbox;
        #outbox;
    };

    public type MailGetRequest = {
        store : MailRecordStore;
        local_id : Nat;
    };

    public type MailInboxRecord = {
        local_id : Nat;
        sender : Principal;
        received_at_ns : Int;
        read : Bool;
        known_at_receipt : Bool;
        current_contact : MailCurrentContact;
        retained_bytes : Nat;
        encrypted : MailEncryptedContent;
    };

    public type MailOutboxRecord = {
        local_id : Nat;
        command_id : Blob;
        recipient : Principal;
        contact_id : ?Nat;
        contact_revision : ?Nat;
        current_contact : MailCurrentContact;
        created_at_ns : Int;
        updated_at_ns : Int;
        cleanup_epoch : Nat;
        attempt_no : Nat;
        attempt_request_id : ?Blob;
        state : MailOutboxState;
        retained_bytes : Nat;
        encrypted : MailEncryptedContent;
    };

    public type MailExactRecord = {
        #inbox : MailInboxRecord;
        #outbox : MailOutboxRecord;
    };

    public type MailGetPayload = {
        mail_revision : Nat;
        contacts_revision : Nat;
        cleanup_epoch : Nat;
        record : MailExactRecord;
    };

    public type MailGetResult = {
        #ok : MailGetPayload;
        #err : MailStoreError;
    };

    public type MailRecipientContact = {
        contact_id : Nat;
        contact_revision : Nat;
        contact_name : Text;
        principal : Principal;
    };

    public type MailRecipientSearchRequest = {
        search_text : Text;
        offset : Nat;
        limit : Nat;
    };

    public type MailRecipientPage = {
        book_revision : Nat;
        contacts : [MailRecipientContact];
        total : Nat;
        next_offset : ?Nat;
    };

    public type MailRecipientError = {
        #invalid_request;
        #contacts_error;
        #invalid_dependency;
    };

    public type MailRecipientsResult = {
        #ok : MailRecipientPage;
        #err : MailRecipientError;
    };

    public type MailEncryptedSettings = {
        record_id : Blob;
        revision : Nat64;
        local_wrap_epoch : Nat64;
        local_wrap_fingerprint : Blob;
        local_wrapped_cek : Blob;
        nonce : Blob;
        ciphertext_and_tag : Blob;
    };

    public type MailSettingsRewrap = {
        expected_revision : Nat64;
        local_wrap_epoch : Nat64;
        local_wrap_fingerprint : Blob;
        local_wrapped_cek : Blob;
    };

    public type MailSettingsMutation = {
        #create : MailEncryptedSettings;
        #replace : {
            expected_revision : Nat64;
            settings : MailEncryptedSettings;
        };
        #rewrap : MailSettingsRewrap;
    };

    public type MailSettingsError = {
        #invalid_request;
        #not_configured;
        #corrupt_state;
        #revision_conflict : {
            expected : ?Nat64;
            actual : ?Nat64;
        };
    };

    public type MailSettingsGetResult = {
        #ok : ?MailEncryptedSettings;
        #err : MailSettingsError;
    };

    public type MailSettingsSetResult = {
        #ok : MailEncryptedSettings;
        #err : MailSettingsError;
    };

    public type MailDeliveryRecipient = {
        #direct : { principal : Principal };
        #contact : {
            principal : Principal;
            contact_id : Nat;
            expected_contact_revision : Nat;
        };
    };

    public type MailPrepareRecipientRequest = {
        recipient : MailDeliveryRecipient;
        permit_request_id : Blob;
    };

    public type MailKeyInfoV1 = {
        protocol_version : Nat8;
        suite : Nat16;
        delivery_key_epoch : Nat64;
        context_public_key : Blob;
        effective_ibe_identity : Blob;
        recipient_key_fingerprint : Blob;
        max_envelope_bytes : Nat32;
    };

    public type MailKeyInfoResultV1 = {
        #ok : MailKeyInfoV1;
        #unavailable;
    };

    public type MailPreparedRecipient = {
        permit_id : Blob;
        recipient : Principal;
        contact_id : ?Nat;
        contact_revision : ?Nat;
        book_revision : Nat;
        expires_at_ns : Int;
        public_info_hash : Blob;
        key_info : MailKeyInfoV1;
    };

    public type MailSendEncryptedRequest = {
        command_id : Blob;
        permit_id : Blob;
        recipient : Principal;
        public_info_hash : Blob;
        envelope : Blob;
        local_wrap_epoch : Nat64;
        local_wrap_fingerprint : Blob;
        local_wrapped_cek : Blob;
    };

    public type MailRetryRequest = {
        local_id : Nat;
        retry_request_id : Blob;
    };

    public type MailDeliveryView = {
        local_id : Nat;
        mail_revision : Nat;
        cleanup_epoch : Nat;
        attempt_no : Nat;
        state : MailOutboxState;
        updated_at_ns : Int;
    };

    public type MailDeliveryError = {
        #invalid_request;
        #permission_required;
        #recipient_unavailable;
        #recipient_changed;
        #permit_capacity;
        #permit_request_reused;
        #permit_missing;
        #permit_expired;
        #permit_mismatch;
        #mailbox_full;
        #crypto_unavailable;
        #command_conflict;
        #command_deleted : { local_id : Nat };
        #not_found;
        #not_retryable;
        #retry_deleted;
        #attempt_superseded;
        #clock_invalid;
        #corrupt_state;
    };

    public type MailPrepareRecipientResult = {
        #ok : MailPreparedRecipient;
        #err : MailDeliveryError;
    };

    public type MailDeliveryResult = {
        #ok : MailDeliveryView;
        #err : MailDeliveryError;
    };

    public type MailMarkRequest = {
        local_ids : [Nat];
        read : Bool;
    };

    public type MailDeleteTarget = {
        #inbox : Nat;
        #outbox : Nat;
    };

    public type MailDeleteRequest = {
        targets : [MailDeleteTarget];
    };

    public type MailMutationResult = {
        mail_revision : Nat;
        cleanup_epoch : Nat;
        changed : Nat;
        inbox_deleted : Nat;
        outbox_deleted : Nat;
        unread_deleted : Nat;
        retained_bytes_deleted : Nat;
        unread_remaining : Nat;
    };

    public type MailMutationResponse = {
        #ok : MailMutationResult;
        #err : MailStoreError;
    };

    public type MailCleanupScope = {
        #read_inbox;
        #unknown_current;
        #all_mail;
    };

    public type MailCleanupCounts = {
        total : Nat;
        unread : Nat;
        inbox : Nat;
        sent : Nat;
        outbox : Nat;
        active_sends : Nat;
        retained_bytes : Nat;
    };

    public type MailCleanupPreview = {
        scope : MailCleanupScope;
        mail_revision : Nat;
        contacts_revision : Nat;
        cleanup_epoch : Nat;
        counts : MailCleanupCounts;
    };

    public type MailCleanupPreviewResult = {
        #ok : MailCleanupPreview;
        #err : MailStoreError;
    };

    public type MailCryptoReferenceCounts = {
        settings : Nat;
        inbox : Nat;
        outbox : Nat;
        total : Nat;
    };

    public type MailVetKeyError = {
        #not_declared;
        #not_reserved;
        #manifest_suspended;
        #disabled;
        #generation_unavailable;
        #invalid_request;
        #challenge_expired;
        #challenge_consumed;
        #rate_limited : { retry_after_seconds : Nat64 };
        #busy;
        #low_cycles;
        #key_unavailable;
        #management_failure;
        #source_gone;
        #owner_required;
    };

    public type MailCryptoError = {
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
        #vetkeys : MailVetKeyError;
        #previous_references : MailCryptoReferenceCounts;
        #revision_conflict;
        #corrupt_state;
    };

    public type MailCryptoProgress = {
        mail_revision : Nat;
        key_holder : Principal;
        current_epoch : Nat64;
        previous_epoch : ?Nat64;
        previous_references : MailCryptoReferenceCounts;
        ready_to_retire : Bool;
    };

    public type MailCryptoResult = {
        #ok : MailCryptoProgress;
        #err : MailCryptoError;
    };

    public type MailCryptoRewrapTarget = {
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

    public type MailCryptoRewrapRequest = {
        expected_current_epoch : Nat64;
        expected_previous_epoch : Nat64;
        targets : [MailCryptoRewrapTarget];
    };

    public type MailCryptoRewrapResult = {
        #ok : {
            changed : Nat;
            message_wraps_changed : Nat;
            settings_wrap_changed : Bool;
            progress : MailCryptoProgress;
        };
        #err : MailCryptoError;
    };

    public type AppBackendEnvironment = {
        stable_memory : {
            mail : Memory.Mem;
        };
        app_calls : AppCalls;
        capabilities : {
            backend_calls : NeutronCapabilities.BackendCallsV1;
            vetkeys_public : NeutronCapabilities.VetKeysPublicV1;
        };
    };

    public class Init(env : AppBackendEnvironment) {
        let mem = env.stable_memory.mail;
        let appCalls = env.app_calls;
        let capabilities = env.capabilities;
        let selfCanister = capabilities.backend_calls.canister_principal;
        let receiver = Receive.Service(
            mem,
            selfCanister,
            func(sender) {
                let result = appCalls.contacts.contacts_neutron_lookup_v2({
                    principal = sender;
                });
                if (not result.integrity_ok) return false;
                switch (result.match) {
                    case (?match) Principal.equal(match.principal, sender);
                    case null false;
                };
            },
            Time.now,
        );
        let store = Store.Service(
            mem,
            Time.now,
            func() {
                appCalls.contacts.contacts_neutron_revision_v2(());
            },
            func(sender) {
                let result = appCalls.contacts.contacts_neutron_lookup_v2({
                    principal = sender;
                });
                if (not result.integrity_ok) return #conflict;
                switch (result.match) {
                    case null #none;
                    case (?match) {
                        if (not Principal.equal(match.principal, sender)) {
                            #conflict;
                        } else {
                            #match({
                                principal = match.principal;
                                contact_id = match.contact_id;
                                contact_revision = match.contact_revision;
                                contact_name = match.contact_name;
                            });
                        };
                    };
                };
            },
        );
        let recipients = Recipients.Service(
            appCalls.contacts.contacts_neutron_search_v2,
        );
        let settings = Settings.Service(mem);
        let crypto = Crypto.Service(mem, capabilities.vetkeys_public);
        let delivery = Delivery.Service(
            mem,
            selfCanister,
            capabilities.backend_calls,
            func(target) {
                let result = appCalls.contacts.contacts_neutron_lookup_v2({
                    principal = target;
                });
                {
                    book_revision = result.book_revision;
                    integrity_ok = result.integrity_ok;
                    match = switch (result.match) {
                        case null null;
                        case (?match) ?{
                            contact_id = match.contact_id;
                            contact_revision = match.contact_revision;
                            principal = match.principal;
                        };
                    };
                };
            },
            Time.now,
        );

        public func /*query*/mail_status(()) : MailStatusResult {
            store.status();
        };

        public func /*query*/mail_pulse(()) : MailPulseResult {
            store.pulse();
        };

        public func /*query*/mail_crypto_status(()) : MailCryptoResult {
            crypto.status();
        };

        // Setup and rotation obtain all public material from the injected,
        // app-bound kernel capability. No browser-supplied key, identity,
        // context, key name, or canister principal is accepted here.
        public func /*update*/mail_crypto_setup(()) : async* MailCryptoResult {
            switch (crypto.setupStart()) {
                case (#err(error)) #err(error);
                case (#complete(progress)) #ok(progress);
                case (#dispatch(dispatch)) {
                    let response = await* capabilities.vetkeys_public.public_key({
                        slot = Crypto.SLOT_ID;
                        generation = dispatch.slot.current_generation;
                    });
                    crypto.setupFinish(dispatch, response);
                };
            };
        };

        public func /*update*/mail_crypto_rotate(()) : async* MailCryptoResult {
            switch (crypto.rotateStart()) {
                case (#err(error)) #err(error);
                case (#complete(progress)) #ok(progress);
                case (#dispatch(dispatch)) {
                    let response = await* capabilities.vetkeys_public.public_key({
                        slot = Crypto.SLOT_ID;
                        generation = dispatch.slot.current_generation;
                    });
                    crypto.rotateFinish(dispatch, response);
                };
            };
        };

        public func /*update*/mail_crypto_rewrap(
            request : MailCryptoRewrapRequest,
        ) : MailCryptoRewrapResult {
            crypto.rewrap(request);
        };

        public func /*query*/mail_list_encrypted(
            request : MailListRequest,
        ) : MailListResult {
            store.list(request);
        };

        public func /*query*/mail_get_encrypted(
            request : MailGetRequest,
        ) : MailGetResult {
            store.get(request);
        };

        public func /*query*/mail_recipients(
            request : MailRecipientSearchRequest,
        ) : MailRecipientsResult {
            recipients.recipients(request);
        };

        public func /*query*/mail_settings_encrypted(()) : MailSettingsGetResult {
            settings.get();
        };

        public func /*update*/mail_settings_set_encrypted(
            mutation : MailSettingsMutation,
        ) : MailSettingsSetResult {
            settings.set(mutation);
        };

        public func /*update*/mail_prepare_recipient(
            request : MailPrepareRecipientRequest,
        ) : async* MailPrepareRecipientResult {
            await* delivery.prepareRecipient(request);
        };

        public func /*update*/mail_send_encrypted(
            request : MailSendEncryptedRequest,
        ) : async* MailDeliveryResult {
            await* delivery.sendEncrypted(request);
        };

        public func /*update*/mail_retry(
            request : MailRetryRequest,
        ) : async* MailDeliveryResult {
            await* delivery.retry(request);
        };

        public func /*update*/mail_mark(
            request : MailMarkRequest,
        ) : MailMutationResponse {
            store.mark(request);
        };

        public func /*update*/mail_delete(
            request : MailDeleteRequest,
        ) : MailMutationResponse {
            store.delete(request);
        };

        public func /*query*/mail_cleanup_preview(
            scope : MailCleanupScope,
        ) : MailCleanupPreviewResult {
            store.cleanupPreview(scope);
        };

        public func /*update*/mail_cleanup(
            preview : MailCleanupPreview,
        ) : MailMutationResponse {
            store.cleanupCommit(preview);
        };

        public func /*update*/mail_key_info_v1(
            (),
            /*caller*/ caller : Principal,
        ) : Blob {
            // The kernel has already accepted the route's positive base, which
            // is the proof that this immediate caller used a canister call.
            if (Principal.equal(caller, selfCanister)) {
                return RemoteWire.encodeKeyInfoPayload(#unavailable);
            };
            let ?info = crypto.deliveryKeyInfo() else {
                return RemoteWire.encodeKeyInfoPayload(#unavailable);
            };
            RemoteWire.encodeKeyInfoPayload(#ok({
                protocol_version = info.protocol_version;
                suite = info.suite;
                delivery_key_epoch = info.current_epoch;
                context_public_key = info.context_public_key;
                effective_ibe_identity = info.effective_ibe_identity;
                recipient_key_fingerprint = info.current_fingerprint;
                max_envelope_bytes = info.max_envelope_bytes;
            }));
        };

        public func /*update*/mail_receive_v1(
            payload : Blob,
            /*caller*/ caller : Principal,
        ) : Blob {
            // The kernel accepts the route's positive base before dispatch, so
            // Mail does not reclassify the principal. Preserve only the
            // protocol-specific self-mail rejection before consulting setup.
            if (Principal.equal(caller, selfCanister)) {
                return RemoteWire.encodeReceivePayload(#rejected(#invalid));
            };
            if (crypto.deliveryKeyInfo() == null) {
                return RemoteWire.encodeReceivePayload(
                    #rejected(#crypto_unavailable),
                );
            };
            RemoteWire.encodeReceivePayload(receiver.receive(payload, caller));
        };
    };

/*---NEUTRON GENERATED BEGIN---*/

public type mail_status_Input = (());
public type mail_status_Output = MailStatusResult;

public type mail_pulse_Input = (());
public type mail_pulse_Output = MailPulseResult;

public type mail_crypto_status_Input = (());
public type mail_crypto_status_Output = MailCryptoResult;

public type mail_crypto_setup_Input = (());
public type mail_crypto_setup_Output = MailCryptoResult;

public type mail_crypto_rotate_Input = (());
public type mail_crypto_rotate_Output = MailCryptoResult;

public type mail_crypto_rewrap_Input = (request : MailCryptoRewrapRequest,);
public type mail_crypto_rewrap_Output = MailCryptoRewrapResult;

public type mail_list_encrypted_Input = (request : MailListRequest,);
public type mail_list_encrypted_Output = MailListResult;

public type mail_get_encrypted_Input = (request : MailGetRequest,);
public type mail_get_encrypted_Output = MailGetResult;

public type mail_recipients_Input = (request : MailRecipientSearchRequest,);
public type mail_recipients_Output = MailRecipientsResult;

public type mail_settings_encrypted_Input = (());
public type mail_settings_encrypted_Output = MailSettingsGetResult;

public type mail_settings_set_encrypted_Input = (mutation : MailSettingsMutation,);
public type mail_settings_set_encrypted_Output = MailSettingsSetResult;

public type mail_prepare_recipient_Input = (request : MailPrepareRecipientRequest,);
public type mail_prepare_recipient_Output = MailPrepareRecipientResult;

public type mail_send_encrypted_Input = (request : MailSendEncryptedRequest,);
public type mail_send_encrypted_Output = MailDeliveryResult;

public type mail_retry_Input = (request : MailRetryRequest,);
public type mail_retry_Output = MailDeliveryResult;

public type mail_mark_Input = (request : MailMarkRequest,);
public type mail_mark_Output = MailMutationResponse;

public type mail_delete_Input = (request : MailDeleteRequest,);
public type mail_delete_Output = MailMutationResponse;

public type mail_cleanup_preview_Input = (scope : MailCleanupScope,);
public type mail_cleanup_preview_Output = MailCleanupPreviewResult;

public type mail_cleanup_Input = (preview : MailCleanupPreview,);
public type mail_cleanup_Output = MailMutationResponse;

public type mail_key_info_v1_Input = (());
public type mail_key_info_v1_Output = Blob;

public type mail_receive_v1_Input = (payload : Blob);
public type mail_receive_v1_Output = Blob;

/*---NEUTRON GENERATED END---*/
};
