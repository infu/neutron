import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Char "mo:core/Char";
import Int "mo:core/Int";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat32 "mo:core/Nat32";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Set "mo:core/Set";
import Text "mo:core/Text";
import Memory "../memory/mail/v1";
import Accounting "Accounting";
import Envelope "../protocol/Envelope";
import KeyInfo "../protocol/KeyInfo";

module {
    public let MAX_PAGE = 50;
    public let MAX_MUTATION_BATCH = 100;

    let THIRTY_DAYS_NS : Int = 2_592_000_000_000_000;
    let TOMBSTONE_LIMIT = 2_048;
    let COMMAND_TOMBSTONE_LIMIT = 2_048;
    let RETRY_TOMBSTONE_LIMIT = 2_048;
    let PERMIT_LIMIT = 64;
    let INBOX_COUNT_LIMIT = 2_000;
    let INBOX_BYTE_LIMIT = 20_971_520;
    let UNKNOWN_COUNT_LIMIT = 100;
    let UNKNOWN_BYTE_LIMIT = 2_097_152;
    let OUTBOX_COUNT_LIMIT = 1_000;
    let OUTBOX_BYTE_LIMIT = 12_582_912;
    let MAX_LIST_CIPHERTEXT_BYTES = 163_840;
    let MAX_LOCAL_WRAP_BYTES = 4_096;
    let MAX_SETTINGS_CIPHERTEXT_BYTES = 4_096;
    let KNOWN_RATE_LIMIT = 300;
    let UNKNOWN_RATE_LIMIT = 10;
    let MAX_TIMESTAMP : Int = 9_223_372_036_854_775_807;

    public type StoreError = {
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

    public type Result<T> = {
        #ok : T;
        #err : StoreError;
    };

    public type Folder = {
        #inbox;
        #sent;
        #outbox;
    };

    public type SetupStatus = {
        #not_configured;
        #configured : {
            key_holder : Principal;
            current_epoch : Nat64;
            previous_epoch : ?Nat64;
        };
    };

    public type StorageLevel = {
        #normal;
        #approaching_limit;
        #almost_full;
    };

    public type Status = {
        mail_revision : Nat;
        contacts_revision : Nat;
        cleanup_epoch : Nat;
        setup : SetupStatus;
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
        storage_level : StorageLevel;
    };

    // The resident UI polls this constant-cost projection while idle. Any
    // revision change tells it to refresh richer status/page data; the Inbox
    // counters let it detect arrivals and update its unread badge immediately.
    public type Pulse = {
        mail_revision : Nat;
        contacts_revision : Nat;
        cleanup_epoch : Nat;
        inbox_count : Nat;
        unread_count : Nat;
    };

    public type EncryptedHeader = {
        message_id : Blob;
        delivery_key_epoch : Nat64;
        delivery_key_fingerprint : Blob;
        local_wrap_epoch : Nat64;
        local_wrap_fingerprint : Blob;
        local_wrapped_cek : Blob;
        header_nonce : Blob;
        header_ciphertext_and_tag : Blob;
    };

    public type EncryptedContent = {
        header : EncryptedHeader;
        body_nonce : Blob;
        body_ciphertext_and_tag : Blob;
    };

    // A live Contacts projection. This is deliberately separate from
    // known_at_receipt and the Outbox's send-time contact binding: those are
    // immutable audit facts, while this value is recomputed for every list/get.
    public type CurrentContact = {
        #in_contacts : {
            contact_id : Nat;
            contact_revision : Nat;
            contact_name : Text;
        };
        #not_in_contacts;
        #contact_conflict;
    };

    public type InboxListItem = {
        local_id : Nat;
        sender : Principal;
        received_at_ns : Int;
        read : Bool;
        known_at_receipt : Bool;
        current_contact : CurrentContact;
        retained_bytes : Nat;
        encrypted_header : EncryptedHeader;
    };

    public type OutboxListItem = {
        local_id : Nat;
        recipient : Principal;
        contact_id : ?Nat;
        contact_revision : ?Nat;
        current_contact : CurrentContact;
        created_at_ns : Int;
        updated_at_ns : Int;
        cleanup_epoch : Nat;
        attempt_no : Nat;
        state : Memory.OutboxState;
        retained_bytes : Nat;
        encrypted_header : EncryptedHeader;
    };

    public type ListItem = {
        #inbox : InboxListItem;
        #sent : OutboxListItem;
        #outbox : OutboxListItem;
    };

    public type ListRequest = {
        folder : Folder;
        unread_only : Bool;
        offset : Nat;
        limit : Nat;
        expected_mail_revision : ?Nat;
        expected_contacts_revision : ?Nat;
    };

    public type ListPage = {
        mail_revision : Nat;
        contacts_revision : Nat;
        cleanup_epoch : Nat;
        items : [ListItem];
        total : Nat;
        next_offset : ?Nat;
        ciphertext_bytes : Nat;
    };

    public type RecordStore = {
        #inbox;
        #outbox;
    };

    public type GetRequest = {
        store : RecordStore;
        local_id : Nat;
    };

    public type InboxRecord = {
        local_id : Nat;
        sender : Principal;
        received_at_ns : Int;
        read : Bool;
        known_at_receipt : Bool;
        current_contact : CurrentContact;
        retained_bytes : Nat;
        encrypted : EncryptedContent;
    };

    public type OutboxRecord = {
        local_id : Nat;
        command_id : Blob;
        recipient : Principal;
        contact_id : ?Nat;
        contact_revision : ?Nat;
        current_contact : CurrentContact;
        created_at_ns : Int;
        updated_at_ns : Int;
        cleanup_epoch : Nat;
        attempt_no : Nat;
        attempt_request_id : ?Blob;
        state : Memory.OutboxState;
        retained_bytes : Nat;
        encrypted : EncryptedContent;
    };

    public type ExactRecord = {
        #inbox : InboxRecord;
        #outbox : OutboxRecord;
    };

    public type GetResult = {
        mail_revision : Nat;
        contacts_revision : Nat;
        cleanup_epoch : Nat;
        record : ExactRecord;
    };

    public type MarkRequest = {
        local_ids : [Nat];
        read : Bool;
    };

    public type DeleteTarget = {
        #inbox : Nat;
        #outbox : Nat;
    };

    public type DeleteRequest = {
        targets : [DeleteTarget];
    };

    public type MutationResult = {
        mail_revision : Nat;
        cleanup_epoch : Nat;
        changed : Nat;
        inbox_deleted : Nat;
        outbox_deleted : Nat;
        unread_deleted : Nat;
        retained_bytes_deleted : Nat;
        unread_remaining : Nat;
    };

    public type CleanupScope = {
        #read_inbox;
        #unknown_current;
        #all_mail;
    };

    public type CleanupCounts = {
        total : Nat;
        unread : Nat;
        inbox : Nat;
        sent : Nat;
        outbox : Nat;
        active_sends : Nat;
        retained_bytes : Nat;
    };

    public type CleanupPreview = {
        scope : CleanupScope;
        mail_revision : Nat;
        contacts_revision : Nat;
        cleanup_epoch : Nat;
        counts : CleanupCounts;
    };

    public type ContactMatch = {
        #none;
        #match : {
            principal : Principal;
            contact_id : Nat;
            contact_revision : Nat;
            contact_name : Text;
        };
        #conflict;
    };

    type StateCounts = {
        inbox_count : Nat;
        inbox_bytes : Nat;
        unknown_count : Nat;
        unknown_bytes : Nat;
        unread : Nat;
        outbox_count : Nat;
        outbox_bytes : Nat;
        sent : Nat;
        pending : Nat;
        active : Nat;
    };

    type ListSlice = {
        items : [ListItem];
        total : Nat;
        next_offset : ?Nat;
        ciphertext_bytes : Nat;
    };

    type Selection = {
        inbox_ids : [Nat];
        outbox_ids : [Nat];
        counts : CleanupCounts;
    };

    type TombstonePlan = {
        retained : [Memory.InboxTombstone];
        release_dedupe : [Text];
    };

    type OutboxTombstonePlan = {
        command_keys : [Text];
        command_tombstones : [Memory.CommandTombstone];
        retry_tombstones : [Memory.RetryTombstone];
    };

    // Other Mail services use the same bounded stable-state gate before a
    // commit. Corrupt details are deliberately not projected to public APIs.
    public func validMemory(mem : Memory.Mem) : Bool {
        switch (validateState(mem)) {
            case (#ok(_)) true;
            case (#err(_)) false;
        };
    };

    public class Service(
        mem : Memory.Mem,
        now : () -> Int,
        contactsRevision : () -> Nat,
        exactContactMatch : Principal -> ContactMatch,
    ) {
        public func pulse() : Result<Pulse> {
            if (not validHotState(mem)) return #err(#corrupt_state);
            #ok({
                mail_revision = mem.revision;
                contacts_revision = contactsRevision();
                cleanup_epoch = mem.cleanup_epoch;
                inbox_count = mem.inbox_count;
                unread_count = mem.unread_count;
            });
        };

        public func status() : Result<Status> {
            if (not validHotState(mem)) return #err(#corrupt_state);
            // Inbox, unread, quota, and byte totals are maintained counters.
            // V1 has no separate Sent/pending/active counters, so classify only
            // the bounded Outbox order; importantly, do not rescan Inbox.
            let counts : StateCounts = switch (scanStatusCounts()) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            let contacts = contactsRevision();
            #ok({
                mail_revision = mem.revision;
                contacts_revision = contacts;
                cleanup_epoch = mem.cleanup_epoch;
                setup = switch (mem.key_info) {
                    case null #not_configured;
                    case (?info) #configured({
                        key_holder = info.key_holder;
                        current_epoch = info.current_epoch;
                        previous_epoch = info.previous_epoch;
                    });
                };
                encrypted_settings_revision = switch (mem.encrypted_settings) {
                    case null null;
                    case (?settings) ?settings.revision;
                };
                inbox_count = counts.inbox_count;
                inbox_bytes = counts.inbox_bytes;
                unknown_at_receipt_count = counts.unknown_count;
                unknown_at_receipt_bytes = counts.unknown_bytes;
                unread_count = counts.unread;
                sent_count = counts.sent;
                outbox_count = counts.pending;
                active_sends = counts.active;
                sent_and_outbox_bytes = counts.outbox_bytes;
                storage_level = overallStorageLevel(counts);
            });
        };

        func scanStatusCounts() : Result<StateCounts> {
            var sent = 0;
            var pending = 0;
            var active = 0;
            var exactBytes = 0;
            var position = 0;
            while (position < mem.outbox_order.size()) {
                let record = switch (loadOutboxAt(position)) {
                    case (#err(error)) return #err(error);
                    case (#ok(value)) value;
                };
                exactBytes += record.retained_bytes;
                if (isSent(record.state)) {
                    sent += 1;
                } else {
                    pending += 1;
                    if (isSending(record.state)) active += 1;
                };
                position += 1;
            };
            if (
                sent + pending != mem.outbox_count or
                exactBytes != mem.outbox_bytes
            ) return #err(#corrupt_state);
            #ok({
                inbox_count = mem.inbox_count;
                inbox_bytes = mem.inbox_bytes;
                unknown_count = mem.unknown_inbox_count;
                unknown_bytes = mem.unknown_inbox_bytes;
                unread = mem.unread_count;
                outbox_count = mem.outbox_count;
                outbox_bytes = mem.outbox_bytes;
                sent;
                pending;
                active;
            });
        };

        public func list(request : ListRequest) : Result<ListPage> {
            if (not validHotState(mem)) return #err(#corrupt_state);
            if (
                request.limit == 0 or request.limit > MAX_PAGE or
                (request.unread_only and request.folder != #inbox)
            ) return #err(#invalid_request);

            let mailRevision = mem.revision;
            let contacts = contactsRevision();
            if (not revisionsMatch(
                request.expected_mail_revision,
                request.expected_contacts_revision,
                contacts,
            )) return #err(revisionConflict(contacts));

            let contactCache = Map.empty<Principal, CurrentContact>();
            let resolveCurrentContact = func(peer : Principal) : CurrentContact {
                switch (Map.get(contactCache, Principal.compare, peer)) {
                    case (?cached) cached;
                    case null {
                        let projected = projectCurrentContact(peer);
                        Map.add(contactCache, Principal.compare, peer, projected);
                        projected;
                    };
                };
            };
            let slice = switch (request.folder) {
                case (#inbox) {
                    if (request.unread_only) {
                        listUnreadInbox(request, resolveCurrentContact);
                    } else {
                        listAllInbox(request, resolveCurrentContact);
                    };
                };
                case (#sent) listOutboxFolder(request, true, resolveCurrentContact);
                case (#outbox) listOutboxFolder(request, false, resolveCurrentContact);
            };
            let page = switch (slice) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            let finalContacts = contactsRevision();
            if (mem.revision != mailRevision or finalContacts != contacts) {
                return #err(revisionConflict(finalContacts));
            };
            #ok({
                mail_revision = mailRevision;
                contacts_revision = contacts;
                cleanup_epoch = mem.cleanup_epoch;
                items = page.items;
                total = page.total;
                next_offset = page.next_offset;
                ciphertext_bytes = page.ciphertext_bytes;
            });
        };

        // The ordinary Inbox route is positionally identical to inbox_order.
        // Read only the requested window (plus adjacent ids for local ordering)
        // instead of allocating an array containing every mailbox id.
        func listAllInbox(
            request : ListRequest,
            resolveCurrentContact : Principal -> CurrentContact,
        ) : Result<ListSlice> {
            let total = mem.inbox_count;
            if (request.offset >= total) return #ok(emptyListSlice(total));
            let items = List.empty<ListItem>();
            var usedBytes = 0;
            var cursor = request.offset;
            label page while (cursor < total and List.size(items) < request.limit) {
                let record = switch (loadInboxAt(cursor)) {
                    case (#err(error)) return #err(error);
                    case (#ok(value)) value;
                };
                let (item, itemBytes) = switch (
                    projectInboxListRecord(record, resolveCurrentContact)
                ) {
                    case (#err(error)) return #err(error);
                    case (#ok(value)) value;
                };
                if (usedBytes + itemBytes > MAX_LIST_CIPHERTEXT_BYTES) {
                    if (List.size(items) == 0) return #err(#corrupt_state);
                    break page;
                };
                List.add(items, item);
                usedBytes += itemBytes;
                cursor += 1;
            };
            #ok({
                items = List.toArray(items);
                total;
                next_offset = if (cursor < total) ?cursor else null;
                ciphertext_bytes = usedBytes;
            });
        };

        // Unread order is the Inbox order with read records omitted. The exact
        // total comes from the maintained unread counter; scan only far enough
        // to skip the requested logical offset and fill one bounded page.
        func listUnreadInbox(
            request : ListRequest,
            resolveCurrentContact : Principal -> CurrentContact,
        ) : Result<ListSlice> {
            let total = mem.unread_count;
            if (request.offset >= total) return #ok(emptyListSlice(total));
            let items = List.empty<ListItem>();
            var usedBytes = 0;
            var position = 0;
            var matched = 0;
            label page while (
                position < mem.inbox_order.size() and
                List.size(items) < request.limit
            ) {
                let record = switch (loadInboxAt(position)) {
                    case (#err(error)) return #err(error);
                    case (#ok(value)) value;
                };
                position += 1;
                if (not record.read) {
                    if (matched < request.offset) {
                        matched += 1;
                    } else {
                        let (item, itemBytes) = switch (
                            projectInboxListRecord(record, resolveCurrentContact)
                        ) {
                            case (#err(error)) return #err(error);
                            case (#ok(value)) value;
                        };
                        if (usedBytes + itemBytes > MAX_LIST_CIPHERTEXT_BYTES) {
                            if (List.size(items) == 0) return #err(#corrupt_state);
                            break page;
                        };
                        List.add(items, item);
                        usedBytes += itemBytes;
                        matched += 1;
                    };
                };
            };
            if (
                position == mem.inbox_order.size() and matched != total or
                List.size(items) == 0
            ) return #err(#corrupt_state);
            let cursor = request.offset + List.size(items);
            #ok({
                items = List.toArray(items);
                total;
                next_offset = if (cursor < total) ?cursor else null;
                ciphertext_bytes = usedBytes;
            });
        };

        // Sent and Outbox share one stable order and do not have separate
        // counters in V1. Traverse that bounded order once to compute the exact
        // filtered total, projecting ciphertext only for the requested page.
        func listOutboxFolder(
            request : ListRequest,
            sent : Bool,
            resolveCurrentContact : Principal -> CurrentContact,
        ) : Result<ListSlice> {
            let items = List.empty<ListItem>();
            var usedBytes = 0;
            var total = 0;
            var exactBytes = 0;
            var position = 0;
            var pageFull = false;
            while (position < mem.outbox_order.size()) {
                let record = switch (loadOutboxAt(position)) {
                    case (#err(error)) return #err(error);
                    case (#ok(value)) value;
                };
                exactBytes += record.retained_bytes;
                if (isSent(record.state) == sent) {
                    if (
                        total >= request.offset and
                        List.size(items) < request.limit and
                        not pageFull
                    ) {
                        let (item, itemBytes) = switch (
                            projectOutboxListRecord(record, sent, resolveCurrentContact)
                        ) {
                            case (#err(error)) return #err(error);
                            case (#ok(value)) value;
                        };
                        if (usedBytes + itemBytes > MAX_LIST_CIPHERTEXT_BYTES) {
                            if (List.size(items) == 0) return #err(#corrupt_state);
                            pageFull := true;
                        } else {
                            List.add(items, item);
                            usedBytes += itemBytes;
                        };
                    };
                    total += 1;
                };
                position += 1;
            };
            if (exactBytes != mem.outbox_bytes) return #err(#corrupt_state);
            if (request.offset < total and List.size(items) == 0) {
                return #err(#corrupt_state);
            };
            let cursor = request.offset + List.size(items);
            #ok({
                items = List.toArray(items);
                total;
                next_offset = if (cursor < total) ?cursor else null;
                ciphertext_bytes = usedBytes;
            });
        };

        public func get(request : GetRequest) : Result<GetResult> {
            if (not validHotState(mem)) return #err(#corrupt_state);
            let mailRevision = mem.revision;
            let contacts = contactsRevision();
            let record : ExactRecord = switch (request.store) {
                case (#inbox) {
                    let ?stored = Map.get(mem.inbox, Nat.compare, request.local_id) else {
                        return #err(#not_found);
                    };
                    if (not validInboxLookup(request.local_id, stored)) {
                        return #err(#corrupt_state);
                    };
                    let encrypted = switch (encryptedContentFromInbox(stored)) {
                        case (#err(error)) return #err(error);
                        case (#ok(value)) value;
                    };
                    #inbox({
                        local_id = stored.local_id;
                        sender = stored.sender;
                        received_at_ns = stored.received_at_ns;
                        read = stored.read;
                        known_at_receipt = stored.known_at_receipt;
                        current_contact = projectCurrentContact(stored.sender);
                        retained_bytes = stored.retained_bytes;
                        encrypted;
                    });
                };
                case (#outbox) {
                    let ?stored = Map.get(mem.outbox, Nat.compare, request.local_id) else {
                        return #err(#not_found);
                    };
                    if (not validOutboxLookup(request.local_id, stored)) {
                        return #err(#corrupt_state);
                    };
                    let encrypted = switch (encryptedContentFromOutbox(stored)) {
                        case (#err(error)) return #err(error);
                        case (#ok(value)) value;
                    };
                    #outbox({
                        local_id = stored.local_id;
                        command_id = stored.command_id;
                        recipient = stored.recipient;
                        contact_id = stored.contact_id;
                        contact_revision = stored.contact_revision;
                        current_contact = projectCurrentContact(stored.recipient);
                        created_at_ns = stored.created_at_ns;
                        updated_at_ns = stored.updated_at_ns;
                        cleanup_epoch = stored.cleanup_epoch;
                        attempt_no = stored.attempt_no;
                        attempt_request_id = stored.attempt_request_id;
                        state = stored.state;
                        retained_bytes = stored.retained_bytes;
                        encrypted;
                    });
                };
            };
            let finalContacts = contactsRevision();
            if (mem.revision != mailRevision or finalContacts != contacts) {
                return #err(revisionConflict(finalContacts));
            };
            #ok({
                mail_revision = mailRevision;
                contacts_revision = contacts;
                cleanup_epoch = mem.cleanup_epoch;
                record;
            });
        };

        public func mark(request : MarkRequest) : Result<MutationResult> {
            if (not validHotState(mem)) return #err(#corrupt_state);
            if (request.local_ids.size() > MAX_MUTATION_BATCH) {
                return #err(#invalid_request);
            };
            let seen = Set.empty<Nat>();
            let changed = List.empty<Memory.InboxRecord>();
            for (id in request.local_ids.vals()) {
                if (not Set.insert(seen, Nat.compare, id)) return #err(#invalid_request);
                switch (Map.get(mem.inbox, Nat.compare, id)) {
                    case null {};
                    case (?record) {
                        if (not validInboxLookup(id, record)) return #err(#corrupt_state);
                        if (record.read != request.read) List.add(changed, record);
                    };
                };
            };
            let changedCount = List.size(changed);
            if (changedCount == 0) return #ok(noDeletionResult(0));
            if (request.read and mem.unread_count < changedCount) {
                return #err(#corrupt_state);
            };

            for (record in List.values(changed)) {
                Map.add(mem.inbox, Nat.compare, record.local_id, {
                    record with read = request.read
                });
                if (request.read) {
                    Map.remove(mem.unread, Nat.compare, record.local_id);
                } else {
                    Map.add(mem.unread, Nat.compare, record.local_id, ());
                };
            };
            if (request.read) {
                mem.unread_count -= changedCount;
            } else {
                mem.unread_count += changedCount;
            };
            mem.revision += 1;
            #ok({
                mail_revision = mem.revision;
                cleanup_epoch = mem.cleanup_epoch;
                changed = changedCount;
                inbox_deleted = 0;
                outbox_deleted = 0;
                unread_deleted = 0;
                retained_bytes_deleted = 0;
                unread_remaining = mem.unread_count;
            });
        };

        public func delete(request : DeleteRequest) : Result<MutationResult> {
            switch (validateState(mem)) {
                case (#err(error)) return #err(error);
                case (#ok(_)) {};
            };
            if (request.targets.size() > MAX_MUTATION_BATCH) {
                return #err(#invalid_request);
            };
            let keys = Set.empty<Text>();
            let inboxIds = List.empty<Nat>();
            let outboxIds = List.empty<Nat>();
            for (target in request.targets.vals()) {
                let key = targetKey(target);
                if (not Set.insert(keys, Text.compare, key)) return #err(#invalid_request);
                switch (target) {
                    case (#inbox(id)) if (Map.containsKey(mem.inbox, Nat.compare, id)) {
                        List.add(inboxIds, id);
                    };
                    case (#outbox(id)) if (Map.containsKey(mem.outbox, Nat.compare, id)) {
                        List.add(outboxIds, id);
                    };
                    case (_) {};
                };
            };
            applyDeletion(List.toArray(inboxIds), List.toArray(outboxIds), false);
        };

        public func cleanupPreview(scope : CleanupScope) : Result<CleanupPreview> {
            switch (validateState(mem)) {
                case (#err(error)) return #err(error);
                case (#ok(_)) {};
            };
            let contacts = contactsRevision();
            let selection = switch (selectCleanup(scope)) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            if (contactsRevision() != contacts) return #err(revisionConflict(contactsRevision()));
            #ok({
                scope;
                mail_revision = mem.revision;
                contacts_revision = contacts;
                cleanup_epoch = mem.cleanup_epoch;
                counts = selection.counts;
            });
        };

        public func cleanupCommit(preview : CleanupPreview) : Result<MutationResult> {
            switch (validateState(mem)) {
                case (#err(error)) return #err(error);
                case (#ok(_)) {};
            };
            let contacts = contactsRevision();
            if (
                preview.mail_revision != mem.revision or
                preview.contacts_revision != contacts or
                preview.cleanup_epoch != mem.cleanup_epoch
            ) return #err(revisionConflict(contacts));

            let selection = switch (selectCleanup(preview.scope)) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            if (
                contactsRevision() != contacts or
                not cleanupCountsEqual(selection.counts, preview.counts)
            ) return #err(revisionConflict(contactsRevision()));

            let bumpCleanup = preview.scope == #all_mail;
            applyDeletion(selection.inbox_ids, selection.outbox_ids, bumpCleanup);
        };

        func revisionsMatch(
            expectedMail : ?Nat,
            expectedContacts : ?Nat,
            currentContacts : Nat,
        ) : Bool {
            switch (expectedMail) {
                case (?revision) if (revision != mem.revision) return false;
                case (_) {};
            };
            switch (expectedContacts) {
                case (?revision) if (revision != currentContacts) return false;
                case (_) {};
            };
            true;
        };

        func revisionConflict(contacts : Nat) : StoreError {
            #revision_conflict({
                mail_revision = mem.revision;
                contacts_revision = contacts;
                cleanup_epoch = mem.cleanup_epoch;
            });
        };

        func emptyListSlice(total : Nat) : ListSlice {
            {
                items = [];
                total;
                next_offset = null;
                ciphertext_bytes = 0;
            };
        };

        func loadInboxAt(position : Nat) : Result<Memory.InboxRecord> {
            if (position >= mem.inbox_order.size()) return #err(#corrupt_state);
            let id = mem.inbox_order[position];
            if (not validOrderPosition(mem.inbox_order, position, id)) {
                return #err(#corrupt_state);
            };
            let ?record = Map.get(mem.inbox, Nat.compare, id) else {
                return #err(#corrupt_state);
            };
            if (not validInboxLookup(id, record)) return #err(#corrupt_state);
            #ok(record);
        };

        func loadOutboxAt(position : Nat) : Result<Memory.OutboxRecord> {
            if (position >= mem.outbox_order.size()) return #err(#corrupt_state);
            let id = mem.outbox_order[position];
            if (not validOrderPosition(mem.outbox_order, position, id)) {
                return #err(#corrupt_state);
            };
            let ?record = Map.get(mem.outbox, Nat.compare, id) else {
                return #err(#corrupt_state);
            };
            if (not validOutboxLookup(id, record)) return #err(#corrupt_state);
            #ok(record);
        };

        func validOrderPosition(order : [Nat], position : Nat, id : Nat) : Bool {
            if (id == 0 or id >= mem.next_local_id) return false;
            if (position > 0 and order[position - 1] <= id) return false;
            if (position + 1 < order.size() and id <= order[position + 1]) return false;
            true;
        };

        func validInboxLookup(id : Nat, record : Memory.InboxRecord) : Bool {
            if (
                id == 0 or id >= mem.next_local_id or
                not validInboxRecord(id, record) or
                Map.containsKey(mem.unread, Nat.compare, id) == record.read
            ) return false;
            switch (Map.get(mem.dedupe, Text.compare, messageKey(record.sender, record.message_id))) {
                case (?mapped) mapped == id;
                case null false;
            };
        };

        func validOutboxLookup(id : Nat, record : Memory.OutboxRecord) : Bool {
            if (
                id == 0 or id >= mem.next_local_id or
                not validOutboxRecord(id, record, mem.cleanup_epoch)
            ) return false;
            let ?command = Map.get(mem.commands, Text.compare, commandKey(record.command_id)) else {
                return false;
            };
            Blob.equal(command.command_id, record.command_id) and
            Blob.equal(command.request_fingerprint, record.command_fingerprint) and
            command.local_id == id and
            command.cleanup_epoch == record.cleanup_epoch and
            validTimestamp(command.created_at_ns) and
            command.created_at_ns <= record.updated_at_ns;
        };

        func projectInboxListRecord(
            record : Memory.InboxRecord,
            resolveCurrentContact : Principal -> CurrentContact,
        ) : Result<(ListItem, Nat)> {
            let encrypted = switch (encryptedContentFromInbox(record)) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            #ok((#inbox({
                local_id = record.local_id;
                sender = record.sender;
                received_at_ns = record.received_at_ns;
                read = record.read;
                known_at_receipt = record.known_at_receipt;
                current_contact = resolveCurrentContact(record.sender);
                retained_bytes = record.retained_bytes;
                encrypted_header = encrypted.header;
            }), headerBytes(encrypted.header)));
        };

        func projectOutboxListRecord(
            record : Memory.OutboxRecord,
            sent : Bool,
            resolveCurrentContact : Principal -> CurrentContact,
        ) : Result<(ListItem, Nat)> {
            if (isSent(record.state) != sent) return #err(#corrupt_state);
            let encrypted = switch (encryptedContentFromOutbox(record)) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            let item : OutboxListItem = {
                local_id = record.local_id;
                recipient = record.recipient;
                contact_id = record.contact_id;
                contact_revision = record.contact_revision;
                current_contact = resolveCurrentContact(record.recipient);
                created_at_ns = record.created_at_ns;
                updated_at_ns = record.updated_at_ns;
                cleanup_epoch = record.cleanup_epoch;
                attempt_no = record.attempt_no;
                state = record.state;
                retained_bytes = record.retained_bytes;
                encrypted_header = encrypted.header;
            };
            #ok((if (sent) #sent(item) else #outbox(item), headerBytes(encrypted.header)));
        };

        func projectCurrentContact(peer : Principal) : CurrentContact {
            switch (exactContactMatch(peer)) {
                case (#none) #not_in_contacts;
                case (#conflict) #contact_conflict;
                case (#match(match)) {
                    if (
                        not Principal.equal(match.principal, peer) or
                        not Principal.isCanister(match.principal) or
                        match.contact_id == 0 or
                        match.contact_revision == 0 or
                        match.contact_name.size() == 0 or
                        match.contact_name.size() > 120 or
                        hasUnsafeControls(match.contact_name)
                    ) {
                        #contact_conflict;
                    } else {
                        #in_contacts({
                            contact_id = match.contact_id;
                            contact_revision = match.contact_revision;
                            contact_name = match.contact_name;
                        });
                    };
                };
            };
        };

        func encryptedContentFromInbox(record : Memory.InboxRecord) : Result<EncryptedContent> {
            let decoded = switch (Envelope.decode(record.envelope)) {
                case (#err) return #err(#corrupt_state);
                case (#ok(value)) value;
            };
            if (
                not Blob.equal(decoded.message_id, record.message_id) or
                decoded.delivery_key_epoch != record.delivery_key_epoch or
                not Blob.equal(decoded.recipient_key_fingerprint, record.delivery_key_fingerprint)
            ) return #err(#corrupt_state);
            encryptedContent(record.local_wrap_epoch, record.local_wrap_fingerprint, record.local_wrapped_cek, decoded);
        };

        func encryptedContentFromOutbox(record : Memory.OutboxRecord) : Result<EncryptedContent> {
            let decoded = switch (Envelope.decode(record.envelope)) {
                case (#err) return #err(#corrupt_state);
                case (#ok(value)) value;
            };
            if (
                not Blob.equal(decoded.message_id, record.message_id) or
                decoded.delivery_key_epoch != record.delivery_key_epoch or
                not Blob.equal(decoded.recipient_key_fingerprint, record.delivery_key_fingerprint)
            ) return #err(#corrupt_state);
            encryptedContent(record.local_wrap_epoch, record.local_wrap_fingerprint, record.local_wrapped_cek, decoded);
        };

        func encryptedContent(
            localEpoch : Nat64,
            localFingerprint : Blob,
            localWrappedCek : Blob,
            decoded : Envelope.EnvelopeV1,
        ) : Result<EncryptedContent> {
            if (
                localEpoch == 0 or
                localFingerprint.size() != Envelope.FINGERPRINT_BYTES or
                localWrappedCek.size() == 0 or localWrappedCek.size() > MAX_LOCAL_WRAP_BYTES
            ) return #err(#corrupt_state);
            #ok({
                header = {
                    message_id = decoded.message_id;
                    delivery_key_epoch = decoded.delivery_key_epoch;
                    delivery_key_fingerprint = decoded.recipient_key_fingerprint;
                    local_wrap_epoch = localEpoch;
                    local_wrap_fingerprint = localFingerprint;
                    local_wrapped_cek = localWrappedCek;
                    header_nonce = decoded.header_nonce;
                    header_ciphertext_and_tag = decoded.header_ciphertext_and_tag;
                };
                body_nonce = decoded.body_nonce;
                body_ciphertext_and_tag = decoded.body_ciphertext_and_tag;
            });
        };

        func selectCleanup(scope : CleanupScope) : Result<Selection> {
            let inboxIds = List.empty<Nat>();
            let outboxIds = List.empty<Nat>();
            var unread = 0;
            var inboxCount = 0;
            var sentCount = 0;
            var outboxCount = 0;
            var active = 0;
            var retainedBytes = 0;
            let contactCache = Map.empty<Principal, ContactMatch>();

            for (id in mem.inbox_order.vals()) {
                let ?record = Map.get(mem.inbox, Nat.compare, id) else return #err(#corrupt_state);
                let selected = switch (scope) {
                    case (#read_inbox) record.read;
                    case (#all_mail) true;
                    case (#unknown_current) {
                        let match = switch (Map.get(contactCache, Principal.compare, record.sender)) {
                            case (?cached) cached;
                            case null {
                                let resolved = exactContactMatch(record.sender);
                                Map.add(contactCache, Principal.compare, record.sender, resolved);
                                resolved;
                            };
                        };
                        switch (match) {
                            case (#none) true;
                            case (#conflict) return #err(#contacts_conflict);
                            case (#match(value)) {
                                if (not Principal.equal(value.principal, record.sender)) {
                                    return #err(#contacts_conflict);
                                };
                                false;
                            };
                        };
                    };
                };
                if (selected) {
                    List.add(inboxIds, id);
                    inboxCount += 1;
                    retainedBytes += record.retained_bytes;
                    if (not record.read) unread += 1;
                };
            };

            if (scope == #all_mail) {
                for (id in mem.outbox_order.vals()) {
                    let ?record = Map.get(mem.outbox, Nat.compare, id) else return #err(#corrupt_state);
                    List.add(outboxIds, id);
                    retainedBytes += record.retained_bytes;
                    if (isSent(record.state)) {
                        sentCount += 1;
                    } else {
                        outboxCount += 1;
                        if (isSending(record.state)) active += 1;
                    };
                };
            };
            #ok({
                inbox_ids = List.toArray(inboxIds);
                outbox_ids = List.toArray(outboxIds);
                counts = {
                    total = inboxCount + sentCount + outboxCount;
                    unread;
                    inbox = inboxCount;
                    sent = sentCount;
                    outbox = outboxCount;
                    active_sends = active;
                    retained_bytes = retainedBytes;
                };
            });
        };

        func applyDeletion(
            inboxIds : [Nat],
            outboxIds : [Nat],
            bumpCleanup : Bool,
        ) : Result<MutationResult> {
            let inboxSet = Set.empty<Nat>();
            let outboxSet = Set.empty<Nat>();
            let inboxRecords = List.empty<Memory.InboxRecord>();
            let outboxRecords = List.empty<Memory.OutboxRecord>();
            var unreadDeleted = 0;
            var unknownDeleted = 0;
            var inboxBytes = 0;
            var unknownBytes = 0;
            var outboxBytes = 0;

            for (id in inboxIds.vals()) {
                if (not Set.insert(inboxSet, Nat.compare, id)) return #err(#invalid_request);
                let ?record = Map.get(mem.inbox, Nat.compare, id) else return #err(#revision_conflict({
                    mail_revision = mem.revision;
                    contacts_revision = contactsRevision();
                    cleanup_epoch = mem.cleanup_epoch;
                }));
                List.add(inboxRecords, record);
                inboxBytes += record.retained_bytes;
                if (not record.read) unreadDeleted += 1;
                if (not record.known_at_receipt) {
                    unknownDeleted += 1;
                    unknownBytes += record.retained_bytes;
                };
            };
            for (id in outboxIds.vals()) {
                if (not Set.insert(outboxSet, Nat.compare, id)) return #err(#invalid_request);
                let ?record = Map.get(mem.outbox, Nat.compare, id) else return #err(#revision_conflict({
                    mail_revision = mem.revision;
                    contacts_revision = contactsRevision();
                    cleanup_epoch = mem.cleanup_epoch;
                }));
                List.add(outboxRecords, record);
                outboxBytes += record.retained_bytes;
            };
            if (
                mem.inbox_count < List.size(inboxRecords) or
                mem.inbox_bytes < inboxBytes or
                mem.unknown_inbox_count < unknownDeleted or
                mem.unknown_inbox_bytes < unknownBytes or
                mem.outbox_count < List.size(outboxRecords) or
                mem.outbox_bytes < outboxBytes or
                mem.unread_count < unreadDeleted
            ) return #err(#corrupt_state);

            let changed = List.size(inboxRecords) + List.size(outboxRecords);
            let deletionTimestamp : ?Int = if (changed == 0) {
                null;
            } else {
                let timestamp = now();
                if (not validTimestamp(timestamp)) return #err(#clock_invalid);
                ?timestamp;
            };

            let tombstones = if (List.size(inboxRecords) == 0) {
                { retained = mem.inbox_tombstones; release_dedupe = [] };
            } else {
                let ?timestamp = deletionTimestamp else return #err(#corrupt_state);
                switch (planTombstones(List.toArray(inboxRecords), timestamp)) {
                    case (#err(error)) return #err(error);
                    case (#ok(value)) value;
                };
            };
            let outboxTombstones = if (List.size(outboxRecords) == 0) {
                {
                    command_keys = [];
                    command_tombstones = mem.command_tombstones;
                    retry_tombstones = mem.retry_tombstones;
                };
            } else {
                let ?timestamp = deletionTimestamp else return #err(#corrupt_state);
                switch (planOutboxTombstones(List.toArray(outboxRecords), timestamp)) {
                    case (#err(error)) return #err(error);
                    case (#ok(value)) value;
                };
            };

            if (changed == 0 and not bumpCleanup) return #ok(noDeletionResult(0));

            for (record in List.values(inboxRecords)) {
                Map.remove(mem.inbox, Nat.compare, record.local_id);
                Map.remove(mem.unread, Nat.compare, record.local_id);
            };
            for (record in List.values(outboxRecords)) {
                Map.remove(mem.outbox, Nat.compare, record.local_id);
            };
            for (key in tombstones.release_dedupe.vals()) {
                Map.remove(mem.dedupe, Text.compare, key);
                Map.remove(mem.inbox_tombstone_index, Text.compare, key);
            };
            for (key in outboxTombstones.command_keys.vals()) {
                Map.remove(mem.commands, Text.compare, key);
            };
            if (List.size(inboxRecords) > 0) {
                mem.inbox_tombstones := tombstones.retained;
                Map.clear(mem.inbox_tombstone_index);
                for (tombstone in tombstones.retained.vals()) {
                    Map.add(
                        mem.inbox_tombstone_index,
                        Text.compare,
                        messageKey(tombstone.sender, tombstone.message_id),
                        tombstone,
                    );
                };
                mem.inbox_order := Array.filter<Nat>(
                    mem.inbox_order,
                    func(id) { not Set.contains(inboxSet, Nat.compare, id) },
                );
                mem.inbox_count -= List.size(inboxRecords);
                mem.inbox_bytes -= inboxBytes;
                mem.unknown_inbox_count -= unknownDeleted;
                mem.unknown_inbox_bytes -= unknownBytes;
                mem.unread_count -= unreadDeleted;
            };
            if (List.size(outboxRecords) > 0) {
                mem.command_tombstones := outboxTombstones.command_tombstones;
                mem.retry_tombstones := outboxTombstones.retry_tombstones;
                mem.outbox_order := Array.filter<Nat>(
                    mem.outbox_order,
                    func(id) { not Set.contains(outboxSet, Nat.compare, id) },
                );
                mem.outbox_count -= List.size(outboxRecords);
                mem.outbox_bytes -= outboxBytes;
            };
            if (bumpCleanup) {
                // Preparation permits are bound to the old cleanup epoch. An
                // empty Delete All still revokes them atomically so a late
                // browser cannot dispatch after the user's global cleanup.
                Map.clear(mem.permits);
                mem.cleanup_epoch += 1;
            };
            mem.revision += 1;
            #ok({
                mail_revision = mem.revision;
                cleanup_epoch = mem.cleanup_epoch;
                changed;
                inbox_deleted = List.size(inboxRecords);
                outbox_deleted = List.size(outboxRecords);
                unread_deleted = unreadDeleted;
                retained_bytes_deleted = inboxBytes + outboxBytes;
                unread_remaining = mem.unread_count;
            });
        };

        func planTombstones(
            deleted : [Memory.InboxRecord],
            timestamp : Int,
        ) : Result<TombstonePlan> {
            let kept = List.empty<Memory.InboxTombstone>();
            let released = List.empty<Text>();
            let cutoff = timestamp - THIRTY_DAYS_NS;
            for (tombstone in mem.inbox_tombstones.vals()) {
                if (tombstone.deleted_at_ns > timestamp) return #err(#clock_invalid);
                if (tombstone.deleted_at_ns > cutoff) {
                    List.add(kept, tombstone);
                } else {
                    List.add(released, messageKey(tombstone.sender, tombstone.message_id));
                };
            };
            for (record in deleted.vals()) {
                if (record.received_at_ns > timestamp) {
                    return #err(#clock_invalid);
                };
                List.add(kept, {
                    sender = record.sender;
                    message_id = record.message_id;
                    received_at_ns = record.received_at_ns;
                    deleted_at_ns = timestamp;
                });
            };
            let sorted = Array.sort<Memory.InboxTombstone>(
                List.toArray(kept),
                compareTombstones,
            );
            let excess = if (sorted.size() > TOMBSTONE_LIMIT) {
                sorted.size() - TOMBSTONE_LIMIT;
            } else 0;
            var index = 0;
            while (index < excess) {
                let evicted = sorted[index];
                List.add(released, messageKey(evicted.sender, evicted.message_id));
                index += 1;
            };
            let retained = Array.tabulate<Memory.InboxTombstone>(
                sorted.size() - excess,
                func(position) { sorted[position + excess] },
            );
            #ok({ retained; release_dedupe = List.toArray(released) });
        };

        func planOutboxTombstones(
            deleted : [Memory.OutboxRecord],
            timestamp : Int,
        ) : Result<OutboxTombstonePlan> {
            let deletedIds = Set.empty<Nat>();
            let foundCommands = Set.empty<Nat>();
            let commandKeys = List.empty<Text>();
            let commandTombstones = List.empty<Memory.CommandTombstone>();
            let retryTombstones = List.empty<Memory.RetryTombstone>();

            for (record in deleted.vals()) {
                if (not Set.insert(deletedIds, Nat.compare, record.local_id)) {
                    return #err(#invalid_request);
                };
            };
            for (tombstone in mem.command_tombstones.vals()) {
                List.add(commandTombstones, tombstone);
            };
            for (tombstone in mem.retry_tombstones.vals()) {
                List.add(retryTombstones, tombstone);
            };

            for ((key, entry) in Map.entries(mem.commands)) {
                if (Set.contains(deletedIds, Nat.compare, entry.local_id)) {
                    let ?record = Map.get(mem.outbox, Nat.compare, entry.local_id) else {
                        return #err(#corrupt_state);
                    };
                    if (
                        key != commandKey(record.command_id) or
                        not Blob.equal(entry.command_id, record.command_id) or
                        not Blob.equal(entry.request_fingerprint, record.command_fingerprint) or
                        entry.cleanup_epoch != record.cleanup_epoch or
                        not Set.insert(foundCommands, Nat.compare, entry.local_id)
                    ) return #err(#corrupt_state);
                    List.add(commandKeys, key);
                    List.add(commandTombstones, {
                        command_id = entry.command_id;
                        request_fingerprint = entry.request_fingerprint;
                        local_id = entry.local_id;
                        deleted_at_ns = timestamp;
                    });
                };
            };
            for (record in deleted.vals()) {
                if (not Set.contains(foundCommands, Nat.compare, record.local_id)) {
                    return #err(#corrupt_state);
                };
                switch (record.attempt_request_id) {
                    case null {};
                    case (?requestId) List.add(retryTombstones, {
                        local_id = record.local_id;
                        retry_request_id = requestId;
                        attempt_no = record.attempt_no;
                        deleted_at_ns = timestamp;
                    });
                };
            };

            #ok({
                command_keys = List.toArray(commandKeys);
                command_tombstones = keepNewestCommandTombstones(
                    Array.sort<Memory.CommandTombstone>(
                        List.toArray(commandTombstones),
                        compareCommandTombstones,
                    ),
                );
                retry_tombstones = keepNewestRetryTombstones(
                    Array.sort<Memory.RetryTombstone>(
                        List.toArray(retryTombstones),
                        compareRetryTombstones,
                    ),
                );
            });
        };

        func noDeletionResult(changed : Nat) : MutationResult {
            {
                mail_revision = mem.revision;
                cleanup_epoch = mem.cleanup_epoch;
                changed;
                inbox_deleted = 0;
                outbox_deleted = 0;
                unread_deleted = 0;
                retained_bytes_deleted = 0;
                unread_remaining = mem.unread_count;
            };
        };
    };

    // Query hot paths rely on exact maintained counters and collection sizes,
    // then validate only the records they actually traverse. Mutations and
    // cross-service commits continue to use validateState below, which proves
    // every record/index relationship before changing stable memory.
    func validHotState(mem : Memory.Mem) : Bool {
        switch (mem.key_info) {
            case (?info) if (not validPublicKeyInfo(info)) return false;
            case (_) {};
        };
        switch (mem.encrypted_settings) {
            case (?settings) if (not validEncryptedSettings(settings, mem.key_info)) {
                return false;
            };
            case (_) {};
        };
        mem.inbox_count <= INBOX_COUNT_LIMIT and
        mem.outbox_count <= OUTBOX_COUNT_LIMIT and
        mem.next_local_id > mem.inbox_count + mem.outbox_count and
        mem.next_permit_generation > 0 and
        mem.inbox_count == mem.inbox_order.size() and
        mem.inbox_count == Map.size(mem.inbox) and
        mem.inbox_bytes <= INBOX_BYTE_LIMIT and
        ((mem.inbox_count == 0) == (mem.inbox_bytes == 0)) and
        mem.unknown_inbox_count <= mem.inbox_count and
        mem.unknown_inbox_count <= UNKNOWN_COUNT_LIMIT and
        mem.unknown_inbox_bytes <= mem.inbox_bytes and
        mem.unknown_inbox_bytes <= UNKNOWN_BYTE_LIMIT and
        ((mem.unknown_inbox_count == 0) == (mem.unknown_inbox_bytes == 0)) and
        mem.unread_count <= mem.inbox_count and
        mem.unread_count == Map.size(mem.unread) and
        mem.outbox_count == mem.outbox_order.size() and
        mem.outbox_count == Map.size(mem.outbox) and
        mem.outbox_count == Map.size(mem.commands) and
        mem.outbox_bytes <= OUTBOX_BYTE_LIMIT and
        ((mem.outbox_count == 0) == (mem.outbox_bytes == 0)) and
        mem.inbox_tombstones.size() <= TOMBSTONE_LIMIT and
        mem.inbox_tombstones.size() == Map.size(mem.inbox_tombstone_index) and
        Map.size(mem.dedupe) == mem.inbox_count + mem.inbox_tombstones.size() and
        mem.command_tombstones.size() <= COMMAND_TOMBSTONE_LIMIT and
        mem.retry_tombstones.size() <= RETRY_TOMBSTONE_LIMIT and
        Map.size(mem.permits) <= PERMIT_LIMIT and
        mem.known_rate_events.size() <= KNOWN_RATE_LIMIT and
        mem.unknown_rate_events.size() <= UNKNOWN_RATE_LIMIT;
    };

    func validateState(mem : Memory.Mem) : Result<StateCounts> {
        switch (mem.key_info) {
            case (?info) if (not validPublicKeyInfo(info)) return #err(#corrupt_state);
            case (_) {};
        };
        switch (mem.encrypted_settings) {
            case (?settings) if (not validEncryptedSettings(settings, mem.key_info)) {
                return #err(#corrupt_state);
            };
            case (_) {};
        };
        if (
            mem.next_local_id == 0 or
            mem.next_permit_generation == 0 or
            mem.inbox_order.size() != Map.size(mem.inbox) or
            Map.size(mem.unread) != mem.unread_count or
            mem.outbox_order.size() != Map.size(mem.outbox) or
            mem.inbox_tombstones.size() > TOMBSTONE_LIMIT or
            Map.size(mem.inbox_tombstone_index) != mem.inbox_tombstones.size() or
            mem.command_tombstones.size() > COMMAND_TOMBSTONE_LIMIT or
            mem.retry_tombstones.size() > RETRY_TOMBSTONE_LIMIT or
            Map.size(mem.permits) > PERMIT_LIMIT or
            not validRateEvents(mem.known_rate_events, KNOWN_RATE_LIMIT) or
            not validRateEvents(mem.unknown_rate_events, UNKNOWN_RATE_LIMIT)
        ) return #err(#corrupt_state);

        let allIds = Set.empty<Nat>();
        let dedupeKeys = Set.empty<Text>();
        let commandTombstoneKeys = Set.empty<Text>();
        let retryTombstoneKeys = Set.empty<Text>();
        var maxId = 0;
        var previousInboxId : ?Nat = null;
        var previousOutboxId : ?Nat = null;
        var inboxCount = 0;
        var inboxBytes = 0;
        var unknownCount = 0;
        var unknownBytes = 0;
        var unread = 0;
        var outboxCount = 0;
        var outboxBytes = 0;
        var sent = 0;
        var pending = 0;
        var active = 0;

        for ((key, permit) in Map.entries(mem.permits)) {
            if (not validRecipientPermit(key, permit, mem.cleanup_epoch)) {
                return #err(#corrupt_state);
            };
        };

        for (id in mem.inbox_order.vals()) {
            if (not Set.insert(allIds, Nat.compare, id)) return #err(#corrupt_state);
            switch (previousInboxId) {
                case (?previous) if (previous <= id) return #err(#corrupt_state);
                case (_) {};
            };
            previousInboxId := ?id;
            if (id > maxId) maxId := id;
            let ?record = Map.get(mem.inbox, Nat.compare, id) else return #err(#corrupt_state);
            if (not validInboxRecord(id, record)) return #err(#corrupt_state);
            if (Map.containsKey(mem.unread, Nat.compare, id) == record.read) {
                return #err(#corrupt_state);
            };
            let dedupeKey = messageKey(record.sender, record.message_id);
            if (not Set.insert(dedupeKeys, Text.compare, dedupeKey)) {
                return #err(#corrupt_state);
            };
            switch (Map.get(mem.dedupe, Text.compare, dedupeKey)) {
                case (?mapped) if (mapped == id) {};
                case (_) return #err(#corrupt_state);
            };
            inboxCount += 1;
            inboxBytes += record.retained_bytes;
            if (not record.known_at_receipt) {
                unknownCount += 1;
                unknownBytes += record.retained_bytes;
            };
            if (not record.read) unread += 1;
        };

        for (id in mem.outbox_order.vals()) {
            if (not Set.insert(allIds, Nat.compare, id)) return #err(#corrupt_state);
            switch (previousOutboxId) {
                case (?previous) if (previous <= id) return #err(#corrupt_state);
                case (_) {};
            };
            previousOutboxId := ?id;
            if (id > maxId) maxId := id;
            let ?record = Map.get(mem.outbox, Nat.compare, id) else return #err(#corrupt_state);
            if (not validOutboxRecord(id, record, mem.cleanup_epoch)) return #err(#corrupt_state);
            let commandKeyText = commandKey(record.command_id);
            let ?command = Map.get(mem.commands, Text.compare, commandKeyText) else {
                return #err(#corrupt_state);
            };
            if (
                not Blob.equal(command.command_id, record.command_id) or
                not Blob.equal(command.request_fingerprint, record.command_fingerprint) or
                command.local_id != id or
                command.cleanup_epoch != record.cleanup_epoch or
                not validTimestamp(command.created_at_ns) or
                command.created_at_ns > record.updated_at_ns
            ) return #err(#corrupt_state);
            outboxCount += 1;
            outboxBytes += record.retained_bytes;
            if (isSent(record.state)) {
                sent += 1;
            } else {
                pending += 1;
                if (isSending(record.state)) active += 1;
            };
        };

        var previousTombstone : ?Memory.InboxTombstone = null;
        for (tombstone in mem.inbox_tombstones.vals()) {
            if (not validTombstone(tombstone)) return #err(#corrupt_state);
            let key = messageKey(tombstone.sender, tombstone.message_id);
            if (not Set.insert(dedupeKeys, Text.compare, key)) return #err(#corrupt_state);
            switch (previousTombstone) {
                case (?previous) if (compareTombstones(previous, tombstone) == #greater) {
                    return #err(#corrupt_state);
                };
                case (_) {};
            };
            previousTombstone := ?tombstone;
            let ?indexed = Map.get(mem.inbox_tombstone_index, Text.compare, key) else {
                return #err(#corrupt_state);
            };
            if (
                not Principal.equal(indexed.sender, tombstone.sender) or
                not Blob.equal(indexed.message_id, tombstone.message_id) or
                indexed.received_at_ns != tombstone.received_at_ns or
                indexed.deleted_at_ns != tombstone.deleted_at_ns
            ) return #err(#corrupt_state);
            let ?mapped = Map.get(mem.dedupe, Text.compare, key) else {
                return #err(#corrupt_state);
            };
            if (
                mapped == 0 or mapped >= mem.next_local_id or
                Map.containsKey(mem.inbox, Nat.compare, mapped) or
                Map.containsKey(mem.outbox, Nat.compare, mapped)
            ) return #err(#corrupt_state);
        };

        var previousCommandTombstone : ?Memory.CommandTombstone = null;
        for (tombstone in mem.command_tombstones.vals()) {
            if (not validCommandTombstone(tombstone)) return #err(#corrupt_state);
            let key = commandKey(tombstone.command_id);
            if (
                not Set.insert(commandTombstoneKeys, Text.compare, key) or
                Map.containsKey(mem.commands, Text.compare, key)
            ) return #err(#corrupt_state);
            switch (previousCommandTombstone) {
                case (?previous) if (compareCommandTombstones(previous, tombstone) == #greater) {
                    return #err(#corrupt_state);
                };
                case (_) {};
            };
            previousCommandTombstone := ?tombstone;
        };

        var previousRetryTombstone : ?Memory.RetryTombstone = null;
        for (tombstone in mem.retry_tombstones.vals()) {
            if (not validRetryTombstone(tombstone)) return #err(#corrupt_state);
            let key = retryTombstoneKey(tombstone);
            if (not Set.insert(retryTombstoneKeys, Text.compare, key)) {
                return #err(#corrupt_state);
            };
            switch (previousRetryTombstone) {
                case (?previous) if (compareRetryTombstones(previous, tombstone) == #greater) {
                    return #err(#corrupt_state);
                };
                case (_) {};
            };
            previousRetryTombstone := ?tombstone;
        };

        if (
            mem.next_local_id <= maxId or
            inboxCount != mem.inbox_count or
            inboxBytes != mem.inbox_bytes or
            unknownCount != mem.unknown_inbox_count or
            unknownBytes != mem.unknown_inbox_bytes or
            unread != mem.unread_count or
            outboxCount != mem.outbox_count or
            Map.size(mem.commands) != outboxCount or
            Map.size(mem.dedupe) != inboxCount + mem.inbox_tombstones.size() or
            outboxBytes != mem.outbox_bytes or
            inboxCount > INBOX_COUNT_LIMIT or inboxBytes > INBOX_BYTE_LIMIT or
            unknownCount > UNKNOWN_COUNT_LIMIT or unknownBytes > UNKNOWN_BYTE_LIMIT or
            outboxCount > OUTBOX_COUNT_LIMIT or outboxBytes > OUTBOX_BYTE_LIMIT
        ) return #err(#corrupt_state);

        #ok({
            inbox_count = inboxCount;
            inbox_bytes = inboxBytes;
            unknown_count = unknownCount;
            unknown_bytes = unknownBytes;
            unread;
            outbox_count = outboxCount;
            outbox_bytes = outboxBytes;
            sent;
            pending;
            active;
        });
    };

    func validPublicKeyInfo(info : Memory.PublicKeyInfo) : Bool {
        KeyInfo.validConfigured(info);
    };

    func validEncryptedSettings(
        settings : Memory.EncryptedSettings,
        keyInfo : ?Memory.PublicKeyInfo,
    ) : Bool {
        settings.record_id.size() == 16 and
        not isZero(settings.record_id) and
        settings.revision > 0 and
        settings.local_wrap_epoch > 0 and
        settings.local_wrap_fingerprint.size() == Envelope.FINGERPRINT_BYTES and
        not isZero(settings.local_wrap_fingerprint) and
        settings.local_wrapped_cek.size() > 0 and
        settings.local_wrapped_cek.size() <= MAX_LOCAL_WRAP_BYTES and
        not isZero(settings.local_wrapped_cek) and
        settings.nonce.size() == Envelope.NONCE_BYTES and
        not isZero(settings.nonce) and
        settings.ciphertext_and_tag.size() >= 16 and
        settings.ciphertext_and_tag.size() <= MAX_SETTINGS_CIPHERTEXT_BYTES and
        not isZero(settings.ciphertext_and_tag) and
        settingsTargetsConfiguredKey(settings, keyInfo);
    };

    func settingsTargetsConfiguredKey(
        settings : Memory.EncryptedSettings,
        keyInfo : ?Memory.PublicKeyInfo,
    ) : Bool {
        let ?info = keyInfo else return false;
        if (
            settings.local_wrap_epoch == info.current_epoch and
            Blob.equal(settings.local_wrap_fingerprint, info.current_fingerprint)
        ) return true;
        switch (info.previous_epoch, info.previous_fingerprint) {
            case (?epoch, ?fingerprint) {
                settings.local_wrap_epoch == epoch and
                Blob.equal(settings.local_wrap_fingerprint, fingerprint);
            };
            case (_) false;
        };
    };

    func validRecipientPermit(
        key : Text,
        permit : Memory.RecipientPermit,
        cleanupEpoch : Nat,
    ) : Bool {
        permit.permit_id.size() == 32 and
        not isZero(permit.permit_id) and
        key == hex(permit.permit_id) and
        Principal.isCanister(permit.target) and
        validPermitContact(
            permit.contact_id,
            permit.contact_revision,
            permit.book_revision,
        ) and
        permit.suite == 1 and
        permit.delivery_key_epoch > 0 and
        permit.delivery_key_fingerprint.size() == Envelope.FINGERPRINT_BYTES and
        not isZero(permit.delivery_key_fingerprint) and
        permit.public_info_hash.size() == 32 and
        not isZero(permit.public_info_hash) and
        permit.cleanup_epoch == cleanupEpoch and
        validTimestamp(permit.expires_at_ns);
    };

    func validPermitContact(
        contactId : ?Nat,
        contactRevision : ?Nat,
        bookRevision : Nat,
    ) : Bool {
        switch (contactId, contactRevision) {
            case (null, null) bookRevision == 0;
            case (?id, ?revision) id > 0 and revision > 0 and bookRevision > 0;
            case (_) false;
        };
    };

    func validRateEvents(events : [Memory.RateEvent], limit : Nat) : Bool {
        if (events.size() > limit) return false;
        var previous : ?Int = null;
        for (event in events.vals()) {
            if (
                not Principal.isCanister(event.sender) or
                not validTimestamp(event.accepted_at_ns)
            ) return false;
            switch (previous) {
                case (?timestamp) if (timestamp > event.accepted_at_ns) return false;
                case (_) {};
            };
            previous := ?event.accepted_at_ns;
        };
        true;
    };

    func validInboxRecord(id : Nat, record : Memory.InboxRecord) : Bool {
        record.local_id == id and
        Principal.isCanister(record.sender) and
        record.message_id.size() == Envelope.MESSAGE_ID_BYTES and
        not isZero(record.message_id) and
        record.delivery_key_epoch > 0 and
        record.delivery_key_fingerprint.size() == Envelope.FINGERPRINT_BYTES and
        not isZero(record.delivery_key_fingerprint) and
        record.local_wrap_epoch > 0 and
        record.local_wrap_fingerprint.size() == Envelope.FINGERPRINT_BYTES and
        not isZero(record.local_wrap_fingerprint) and
        record.local_wrapped_cek.size() == Envelope.WRAPPED_CEK_BYTES and
        not isZero(record.local_wrapped_cek) and
        validTimestamp(record.received_at_ns) and
        record.envelope.size() > 0 and
        record.envelope.size() <= Envelope.MAX_ENVELOPE_BYTES and
        record.retained_bytes == Accounting.inboxRetainedBytes(record.envelope);
    };

    func validOutboxRecord(
        id : Nat,
        record : Memory.OutboxRecord,
        cleanupEpoch : Nat,
    ) : Bool {
        record.local_id == id and
        Principal.isCanister(record.recipient) and
        record.message_id.size() == Envelope.MESSAGE_ID_BYTES and
        not isZero(record.message_id) and
        record.command_id.size() == 16 and
        not isZero(record.command_id) and
        record.command_fingerprint.size() == 32 and
        not isZero(record.command_fingerprint) and
        record.delivery_key_epoch > 0 and
        record.delivery_key_fingerprint.size() == Envelope.FINGERPRINT_BYTES and
        not isZero(record.delivery_key_fingerprint) and
        record.local_wrap_epoch > 0 and
        record.local_wrap_fingerprint.size() == Envelope.FINGERPRINT_BYTES and
        not isZero(record.local_wrap_fingerprint) and
        record.local_wrapped_cek.size() == Envelope.WRAPPED_CEK_BYTES and
        not isZero(record.local_wrapped_cek) and
        validTimestamp(record.created_at_ns) and
        validTimestamp(record.updated_at_ns) and
        record.updated_at_ns >= record.created_at_ns and
        record.cleanup_epoch == cleanupEpoch and
        validAttemptMetadata(
            record.attempt_no,
            record.attempt_request_id,
            record.state,
            record.updated_at_ns,
        ) and
        record.envelope.size() > 0 and
        record.envelope.size() <= Envelope.MAX_ENVELOPE_BYTES and
        record.retained_bytes == Accounting.outboxRetainedBytes(record.envelope);
    };

    func validAttemptMetadata(
        attemptNo : Nat,
        requestId : ?Blob,
        state : Memory.OutboxState,
        updatedAt : Int,
    ) : Bool {
        if (attemptNo == 0) return false;
        if (attemptNo == 1 and requestId != null) return false;
        if (attemptNo > 1) {
            switch (requestId) {
                case (?value) if (value.size() == 16 and not isZero(value)) {};
                case (_) return false;
            };
        };
        switch (state) {
            case (#accepted({ received_at_ns })) {
                validTimestamp(received_at_ns) and received_at_ns <= updatedAt;
            };
            case (#sending) true;
            case (#delivery_uncertain) true;
            case (#not_sent(_)) true;
        };
    };

    func validTombstone(tombstone : Memory.InboxTombstone) : Bool {
        Principal.isCanister(tombstone.sender) and
        tombstone.message_id.size() == Envelope.MESSAGE_ID_BYTES and
        validTimestamp(tombstone.received_at_ns) and
        validTimestamp(tombstone.deleted_at_ns) and
        tombstone.deleted_at_ns >= tombstone.received_at_ns;
    };

    func validCommandTombstone(tombstone : Memory.CommandTombstone) : Bool {
        tombstone.command_id.size() == 16 and
        not isZero(tombstone.command_id) and
        tombstone.request_fingerprint.size() == 32 and
        not isZero(tombstone.request_fingerprint) and
        tombstone.local_id > 0 and
        validTimestamp(tombstone.deleted_at_ns);
    };

    func validRetryTombstone(tombstone : Memory.RetryTombstone) : Bool {
        tombstone.local_id > 0 and
        tombstone.retry_request_id.size() == 16 and
        not isZero(tombstone.retry_request_id) and
        tombstone.attempt_no > 0 and
        validTimestamp(tombstone.deleted_at_ns);
    };

    func validTimestamp(value : Int) : Bool {
        value >= 0 and value <= MAX_TIMESTAMP;
    };

    func isSent(state : Memory.OutboxState) : Bool {
        switch (state) {
            case (#accepted(_)) true;
            case (_) false;
        };
    };

    func isSending(state : Memory.OutboxState) : Bool {
        switch (state) {
            case (#sending) true;
            case (_) false;
        };
    };

    func headerBytes(header : EncryptedHeader) : Nat {
        header.message_id.size() +
        header.delivery_key_fingerprint.size() +
        header.local_wrap_fingerprint.size() +
        header.local_wrapped_cek.size() +
        header.header_nonce.size() +
        header.header_ciphertext_and_tag.size() + 128;
    };

    func overallStorageLevel(counts : StateCounts) : StorageLevel {
        let inbox = usagePercent(counts.inbox_count, INBOX_COUNT_LIMIT, counts.inbox_bytes, INBOX_BYTE_LIMIT);
        let unknown = usagePercent(counts.unknown_count, UNKNOWN_COUNT_LIMIT, counts.unknown_bytes, UNKNOWN_BYTE_LIMIT);
        let outbox = usagePercent(counts.outbox_count, OUTBOX_COUNT_LIMIT, counts.outbox_bytes, OUTBOX_BYTE_LIMIT);
        let highest = max(inbox, max(unknown, outbox));
        if (highest >= 95) #almost_full else if (highest >= 80) #approaching_limit else #normal;
    };

    func usagePercent(count : Nat, countLimit : Nat, bytes : Nat, byteLimit : Nat) : Nat {
        max(count * 100 / countLimit, bytes * 100 / byteLimit);
    };

    func max(left : Nat, right : Nat) : Nat {
        if (left > right) left else right;
    };

    func targetKey(target : DeleteTarget) : Text {
        switch (target) {
            case (#inbox(id)) "i:" # Nat.toText(id);
            case (#outbox(id)) "o:" # Nat.toText(id);
        };
    };

    func cleanupCountsEqual(left : CleanupCounts, right : CleanupCounts) : Bool {
        left.total == right.total and
        left.unread == right.unread and
        left.inbox == right.inbox and
        left.sent == right.sent and
        left.outbox == right.outbox and
        left.active_sends == right.active_sends and
        left.retained_bytes == right.retained_bytes;
    };

    func compareTombstones(
        left : Memory.InboxTombstone,
        right : Memory.InboxTombstone,
    ) : { #less; #equal; #greater } {
        switch (Int.compare(left.deleted_at_ns, right.deleted_at_ns)) {
            case (#equal) {
                switch (Int.compare(left.received_at_ns, right.received_at_ns)) {
                    case (#equal) Text.compare(
                        messageKey(left.sender, left.message_id),
                        messageKey(right.sender, right.message_id),
                    );
                    case order order;
                };
            };
            case order order;
        };
    };

    func compareCommandTombstones(
        left : Memory.CommandTombstone,
        right : Memory.CommandTombstone,
    ) : { #less; #equal; #greater } {
        switch (Int.compare(left.deleted_at_ns, right.deleted_at_ns)) {
            case (#equal) {
                switch (Nat.compare(left.local_id, right.local_id)) {
                    case (#equal) Text.compare(commandKey(left.command_id), commandKey(right.command_id));
                    case order order;
                };
            };
            case order order;
        };
    };

    func compareRetryTombstones(
        left : Memory.RetryTombstone,
        right : Memory.RetryTombstone,
    ) : { #less; #equal; #greater } {
        switch (Int.compare(left.deleted_at_ns, right.deleted_at_ns)) {
            case (#equal) {
                switch (Nat.compare(left.local_id, right.local_id)) {
                    case (#equal) {
                        switch (Nat.compare(left.attempt_no, right.attempt_no)) {
                            case (#equal) Text.compare(hex(left.retry_request_id), hex(right.retry_request_id));
                            case order order;
                        };
                    };
                    case order order;
                };
            };
            case order order;
        };
    };

    func keepNewestCommandTombstones(
        sorted : [Memory.CommandTombstone],
    ) : [Memory.CommandTombstone] {
        let excess = if (sorted.size() > COMMAND_TOMBSTONE_LIMIT) {
            sorted.size() - COMMAND_TOMBSTONE_LIMIT;
        } else 0;
        Array.tabulate<Memory.CommandTombstone>(
            sorted.size() - excess,
            func(index) { sorted[index + excess] },
        );
    };

    func keepNewestRetryTombstones(
        sorted : [Memory.RetryTombstone],
    ) : [Memory.RetryTombstone] {
        let excess = if (sorted.size() > RETRY_TOMBSTONE_LIMIT) {
            sorted.size() - RETRY_TOMBSTONE_LIMIT;
        } else 0;
        Array.tabulate<Memory.RetryTombstone>(
            sorted.size() - excess,
            func(index) { sorted[index + excess] },
        );
    };

    func messageKey(sender : Principal, messageId : Blob) : Text {
        Principal.toText(sender) # ":" # hex(messageId);
    };

    func commandKey(commandId : Blob) : Text {
        hex(commandId);
    };

    func retryTombstoneKey(tombstone : Memory.RetryTombstone) : Text {
        Nat.toText(tombstone.local_id) # ":" # hex(tombstone.retry_request_id);
    };

    func isZero(value : Blob) : Bool {
        for (byte in value.values()) if (byte != 0) return false;
        true;
    };

    func hasUnsafeControls(value : Text) : Bool {
        for (char in value.chars()) {
            let code = Char.toNat32(char);
            if (code < 32 or code == 127) return true;
        };
        false;
    };

    let HEX_DIGITS : [Text] = [
        "0", "1", "2", "3", "4", "5", "6", "7",
        "8", "9", "a", "b", "c", "d", "e", "f",
    ];

    func hex(value : Blob) : Text {
        var result = "";
        for (byte in value.vals()) {
            let number = Nat8.toNat(byte);
            result #= HEX_DIGITS[number / 16] # HEX_DIGITS[number % 16];
        };
        result;
    };
};
