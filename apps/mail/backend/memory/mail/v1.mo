// Persistent schema: keep this file immutable after release. Package imports
// are allowed; relative imports are forbidden so app-local types cannot drift.
import Map "mo:core/Map";

module {
    public type PublicKeyInfo = {
        protocol_version : Nat8;
        suite : Nat16;
        key_holder : Principal;
        current_epoch : Nat64;
        current_fingerprint : Blob;
        context_public_key : Blob;
        effective_ibe_identity : Blob;
        max_envelope_bytes : Nat32;
        previous_epoch : ?Nat64;
        previous_fingerprint : ?Blob;
    };

    public type InboxRecord = {
        local_id : Nat;
        sender : Principal;
        message_id : Blob;
        delivery_key_epoch : Nat64;
        delivery_key_fingerprint : Blob;
        local_wrap_epoch : Nat64;
        local_wrap_fingerprint : Blob;
        local_wrapped_cek : Blob;
        envelope : Blob;
        received_at_ns : Int;
        read : Bool;
        known_at_receipt : Bool;
        retained_bytes : Nat;
    };

    public type OutboxState = {
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

    public type OutboxRecord = {
        local_id : Nat;
        command_id : Blob;
        command_fingerprint : Blob;
        recipient : Principal;
        contact_id : ?Nat;
        contact_revision : ?Nat;
        message_id : Blob;
        delivery_key_epoch : Nat64;
        delivery_key_fingerprint : Blob;
        local_wrap_epoch : Nat64;
        local_wrap_fingerprint : Blob;
        local_wrapped_cek : Blob;
        envelope : Blob;
        created_at_ns : Int;
        updated_at_ns : Int;
        cleanup_epoch : Nat;
        attempt_no : Nat;
        attempt_request_id : ?Blob;
        state : OutboxState;
        retained_bytes : Nat;
    };

    public type RateEvent = {
        sender : Principal;
        accepted_at_ns : Int;
    };

    public type InboxTombstone = {
        sender : Principal;
        message_id : Blob;
        received_at_ns : Int;
        deleted_at_ns : Int;
    };

    public type RecipientPermit = {
        permit_id : Blob;
        target : Principal;
        contact_id : ?Nat;
        contact_revision : ?Nat;
        book_revision : Nat;
        suite : Nat16;
        delivery_key_epoch : Nat64;
        delivery_key_fingerprint : Blob;
        public_info_hash : Blob;
        cleanup_epoch : Nat;
        expires_at_ns : Int;
    };

    public type EncryptedSettings = {
        record_id : Blob;
        revision : Nat64;
        local_wrap_epoch : Nat64;
        local_wrap_fingerprint : Blob;
        local_wrapped_cek : Blob;
        nonce : Blob;
        ciphertext_and_tag : Blob;
    };

    public type CommandLedgerEntry = {
        command_id : Blob;
        request_fingerprint : Blob;
        local_id : Nat;
        cleanup_epoch : Nat;
        created_at_ns : Int;
    };

    public type CommandTombstone = {
        command_id : Blob;
        request_fingerprint : Blob;
        local_id : Nat;
        deleted_at_ns : Int;
    };

    public type RetryTombstone = {
        local_id : Nat;
        retry_request_id : Blob;
        attempt_no : Nat;
        deleted_at_ns : Int;
    };

    public type Mem = {
        var next_local_id : Nat;
        // Monotonic and never reset by cleanup. Delivery mixes this generation
        // into every server-issued preparation permit so an old permit id can
        // never be recreated after bounded command tombstones are evicted.
        var next_permit_generation : Nat;
        var revision : Nat;
        var cleanup_epoch : Nat;
        var key_info : ?PublicKeyInfo;
        var encrypted_settings : ?EncryptedSettings;
        inbox : Map.Map<Nat, InboxRecord>;
        var inbox_order : [Nat];
        unread : Map.Map<Nat, ()>;
        outbox : Map.Map<Nat, OutboxRecord>;
        var outbox_order : [Nat];
        dedupe : Map.Map<Text, Nat>;
        commands : Map.Map<Text, CommandLedgerEntry>;
        permits : Map.Map<Text, RecipientPermit>;
        var inbox_tombstones : [InboxTombstone];
        inbox_tombstone_index : Map.Map<Text, InboxTombstone>;
        var command_tombstones : [CommandTombstone];
        var retry_tombstones : [RetryTombstone];
        var known_rate_events : [RateEvent];
        var unknown_rate_events : [RateEvent];
        var inbox_count : Nat;
        var inbox_bytes : Nat;
        var unknown_inbox_count : Nat;
        var unknown_inbox_bytes : Nat;
        var outbox_count : Nat;
        var outbox_bytes : Nat;
        var unread_count : Nat;
    };

    public func init() : Mem {
        {
            var next_local_id = 1;
            var next_permit_generation = 1;
            var revision = 0;
            var cleanup_epoch = 0;
            var key_info = null;
            var encrypted_settings = null;
            inbox = Map.empty<Nat, InboxRecord>();
            var inbox_order = [];
            unread = Map.empty<Nat, ()>();
            outbox = Map.empty<Nat, OutboxRecord>();
            var outbox_order = [];
            dedupe = Map.empty<Text, Nat>();
            commands = Map.empty<Text, CommandLedgerEntry>();
            permits = Map.empty<Text, RecipientPermit>();
            var inbox_tombstones = [];
            inbox_tombstone_index = Map.empty<Text, InboxTombstone>();
            var command_tombstones = [];
            var retry_tombstones = [];
            var known_rate_events = [];
            var unknown_rate_events = [];
            var inbox_count = 0;
            var inbox_bytes = 0;
            var unknown_inbox_count = 0;
            var unknown_inbox_bytes = 0;
            var outbox_count = 0;
            var outbox_bytes = 0;
            var unread_count = 0;
        };
    };
};
