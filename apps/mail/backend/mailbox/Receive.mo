import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Int "mo:core/Int";
import Int64 "mo:core/Int64";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Nat32 "mo:core/Nat32";
import Principal "mo:core/Principal";
import Set "mo:core/Set";
import Text "mo:core/Text";
import Memory "../memory/mail/v1";
import Accounting "Accounting";
import Envelope "../protocol/Envelope";
import KeyInfo "../protocol/KeyInfo";

module {
    public type StaleKey = {
        current_epoch : Nat64;
        current_fingerprint : Blob;
    };

    public type ReceiveResultV1 = {
        #accepted : { received_at_ns : Int64 };
        #duplicate : { received_at_ns : Int64 };
        #rejected : {
            #invalid;
            #rate_limited : { retry_after_seconds : Nat32 };
            #mailbox_full;
            #stale_key : StaleKey;
            #crypto_unavailable;
        };
    };

    type TombstonePlan = {
        retained : [Memory.InboxTombstone];
        orphan_dedupe_keys : [Text];
        max_deleted_at_ns : ?Int;
        next_expiry_ns : ?Int;
        changed : Bool;
    };

    type RateQueuePlan = {
        events : [Memory.RateEvent];
        rebased : Bool;
    };

    // This cache is deliberately local to one live Service instance. It is not
    // stable, so an upgrade/reconstruction starts cold, and every mutation made
    // by another Mail service invalidates it by advancing mem.revision. The
    // cheap shape projection also catches accidental counter/index changes that
    // failed to advance the shared revision before the deep validation is
    // skipped.
    type AdmissionIntegrityCache = {
        revision : Nat;
        next_local_id : Nat;
        inbox_order_size : Nat;
        inbox_size : Nat;
        unread_size : Nat;
        tombstone_size : Nat;
        tombstone_index_size : Nat;
        dedupe_size : Nat;
        inbox_count : Nat;
        inbox_bytes : Nat;
        unknown_inbox_count : Nat;
        unknown_inbox_bytes : Nat;
        unread_count : Nat;
        tombstone_max_deleted_at_ns : ?Int;
        tombstone_next_expiry_ns : ?Int;
    };

    let HOUR_NS : Int = 3_600_000_000_000;
    let THIRTY_DAYS_NS : Int = 2_592_000_000_000_000;
    let FIVE_MINUTES_SECONDS = 300;
    let PER_SENDER_RATE = 10;
    let UNKNOWN_RATE = 10;
    let KNOWN_RATE = 300;
    let INBOX_COUNT_LIMIT = 2_000;
    let INBOX_BYTE_LIMIT = 20_971_520;
    let UNKNOWN_COUNT_LIMIT = 100;
    let UNKNOWN_BYTE_LIMIT = 2_097_152;
    let TOMBSTONE_LIMIT = 2_048;
    let MAX_INT64 : Int = 9_223_372_036_854_775_807;

    public class Service(
        mem : Memory.Mem,
        selfCanister : Principal,
        isKnownSender : Principal -> Bool,
        now : () -> Int,
    ) {
        var admissionIntegrityCache : ?AdmissionIntegrityCache = null;

        public func receive(payload : Blob, caller : Principal) : ReceiveResultV1 {
            // The kernel accepts the route's required cycle base before this
            // service runs. That positive attachment is the canister-call
            // proof; Mail only needs its protocol-specific self-mail check.
            if (Principal.equal(caller, selfCanister)) return #rejected(#invalid);

            let envelope = switch (Envelope.decode(payload)) {
                case (#err) return #rejected(#invalid);
                case (#ok(value)) value;
            };
            let keyInfo = switch (mem.key_info) {
                case null return #rejected(#crypto_unavailable);
                case (?value) value;
            };
            if (not validKeyInfo(keyInfo)) {
                return #rejected(#crypto_unavailable);
            };
            if (
                envelope.delivery_key_epoch != keyInfo.current_epoch or
                not Blob.equal(
                    envelope.recipient_key_fingerprint,
                    keyInfo.current_fingerprint,
                )
            ) {
                return #rejected(#stale_key({
                    current_epoch = keyInfo.current_epoch;
                    current_fingerprint = keyInfo.current_fingerprint;
                }));
            };

            let acceptedAt = now();
            if (not validTimestamp(acceptedAt)) return #rejected(#invalid);

            let dedupeKey = messageKey(caller, envelope.message_id);
            switch (Map.get(mem.dedupe, Text.compare, dedupeKey)) {
                case (?id) {
                    switch (Map.get(mem.inbox, Nat.compare, id)) {
                        case (?record) {
                            if (
                                not Principal.equal(record.sender, caller) or
                                not Blob.equal(record.message_id, envelope.message_id)
                            ) return #rejected(#invalid);
                            return duplicate(record.received_at_ns);
                        };
                        case null {
                            let ?tombstone = Map.get(
                                mem.inbox_tombstone_index,
                                Text.compare,
                                dedupeKey,
                            ) else return #rejected(#invalid);
                            if (
                                not Principal.equal(tombstone.sender, caller) or
                                not Blob.equal(tombstone.message_id, envelope.message_id) or
                                not validTimestamp(tombstone.received_at_ns) or
                                not validTimestamp(tombstone.deleted_at_ns) or
                                tombstone.received_at_ns > tombstone.deleted_at_ns or
                                tombstone.deleted_at_ns > acceptedAt
                            ) return #rejected(#invalid);
                            if (tombstone.deleted_at_ns > acceptedAt - THIRTY_DAYS_NS) {
                                return duplicate(tombstone.received_at_ns);
                            };
                        };
                    };
                };
                case null {};
            };
            if (mem.inbox_tombstones.size() > TOMBSTONE_LIMIT) {
                return #rejected(#invalid);
            };

            let knownRatePlan = switch (
                planRateQueue(mem.known_rate_events, KNOWN_RATE, acceptedAt)
            ) {
                case null return #rejected(#invalid);
                case (?plan) plan;
            };
            let unknownRatePlan = switch (
                planRateQueue(mem.unknown_rate_events, UNKNOWN_RATE, acceptedAt)
            ) {
                case null return #rejected(#invalid);
                case (?plan) plan;
            };

            // PocketIC snapshots (and any future platform clock recovery) can
            // restore stable rate events whose otherwise-valid timestamps are
            // ahead of Time.now(). Rebase every such event to this one current
            // instant before admission. This retains every sender and count,
            // so rollback cannot restore quota, while ensuring the conservative
            // lockout expires after at most one fresh one-hour window. Commit
            // the repair even when this request is rate limited; otherwise each
            // retry would rebase the same future events again and never recover.
            if (knownRatePlan.rebased) {
                mem.known_rate_events := knownRatePlan.events;
            };
            if (unknownRatePlan.rebased) {
                mem.unknown_rate_events := unknownRatePlan.events;
            };

            let cutoff = acceptedAt - HOUR_NS;
            let knownRateEvents = Array.filter<Memory.RateEvent>(
                knownRatePlan.events,
                func(event) { event.accepted_at_ns > cutoff },
            );
            let unknownRateEvents = Array.filter<Memory.RateEvent>(
                unknownRatePlan.events,
                func(event) { event.accepted_at_ns > cutoff },
            );

            let known = isKnownSender(caller);
            let senderEvents = Array.concat<Memory.RateEvent>(
                Array.filter<Memory.RateEvent>(
                    knownRateEvents,
                    func(event) { Principal.equal(event.sender, caller) },
                ),
                Array.filter<Memory.RateEvent>(
                    unknownRateEvents,
                    func(event) { Principal.equal(event.sender, caller) },
                ),
            );
            let classEvents = if (known) knownRateEvents else unknownRateEvents;
            let classLimit = if (known) KNOWN_RATE else UNKNOWN_RATE;
            if (senderEvents.size() >= PER_SENDER_RATE or classEvents.size() >= classLimit) {
                let senderWait = if (senderEvents.size() >= PER_SENDER_RATE) {
                    waitForOldest(senderEvents, acceptedAt);
                } else 0;
                let classWait = if (classEvents.size() >= classLimit) {
                    waitForOldest(classEvents, acceptedAt);
                } else 0;
                return #rejected(#rate_limited({
                    retry_after_seconds = quantizedRetry(max(senderWait, classWait));
                }));
            };

            // Deep consistency work is paid only by an admission that passed
            // the bounded public throttle. Rejected spam remains independent
            // of retained mailbox size.
            if (not admissionStateIsValid()) return #rejected(#invalid);
            let tombstonePlan = switch (tombstonePlanForAdmission(acceptedAt)) {
                case null return #rejected(#invalid);
                case (?plan) plan;
            };
            let retainedBytes = Accounting.inboxRetainedBytes(payload);
            let dedupeSize = Map.size(mem.dedupe);
            if (tombstonePlan.orphan_dedupe_keys.size() > dedupeSize) {
                return #rejected(#invalid);
            };
            let projectedDedupeSize = dedupeSize - tombstonePlan.orphan_dedupe_keys.size();
            if (
                mem.inbox_count + 1 > INBOX_COUNT_LIMIT or
                Map.size(mem.inbox) + 1 > INBOX_COUNT_LIMIT or
                mem.inbox_order.size() + 1 > INBOX_COUNT_LIMIT or
                projectedDedupeSize + 1 > INBOX_COUNT_LIMIT + TOMBSTONE_LIMIT or
                Map.size(mem.unread) + 1 > INBOX_COUNT_LIMIT or
                mem.inbox_bytes + retainedBytes > INBOX_BYTE_LIMIT or
                (
                    not known and (
                        mem.unknown_inbox_count + 1 > UNKNOWN_COUNT_LIMIT or
                        mem.unknown_inbox_bytes + retainedBytes > UNKNOWN_BYTE_LIMIT
                    )
                )
            ) return #rejected(#mailbox_full);

            let localId = mem.next_local_id;
            switch (Map.get(mem.inbox, Nat.compare, localId)) {
                case (?_) return #rejected(#invalid);
                case null {};
            };
            switch (Map.get(mem.unread, Nat.compare, localId)) {
                case (?_) return #rejected(#invalid);
                case null {};
            };
            switch (Map.get(mem.outbox, Nat.compare, localId)) {
                case (?_) return #rejected(#invalid);
                case null {};
            };
            let record : Memory.InboxRecord = {
                local_id = localId;
                sender = caller;
                message_id = envelope.message_id;
                delivery_key_epoch = envelope.delivery_key_epoch;
                delivery_key_fingerprint = envelope.recipient_key_fingerprint;
                local_wrap_epoch = envelope.delivery_key_epoch;
                local_wrap_fingerprint = envelope.recipient_key_fingerprint;
                local_wrapped_cek = envelope.recipient_wrapped_cek;
                envelope = payload;
                received_at_ns = acceptedAt;
                read = false;
                known_at_receipt = known;
                retained_bytes = retainedBytes;
            };
            let nextInboxOrder = Array.concat<Nat>([localId], mem.inbox_order);
            let event : Memory.RateEvent = {
                sender = caller;
                accepted_at_ns = acceptedAt;
            };
            let nextKnownRateEvents = if (known) {
                Array.concat<Memory.RateEvent>(knownRateEvents, [event]);
            } else knownRateEvents;
            let nextUnknownRateEvents = if (known) {
                unknownRateEvents;
            } else {
                Array.concat<Memory.RateEvent>(unknownRateEvents, [event]);
            };
            let acceptedAt64 = Int64.fromInt(acceptedAt);

            if (tombstonePlan.changed) {
                for (key in tombstonePlan.orphan_dedupe_keys.vals()) {
                    Map.remove(mem.dedupe, Text.compare, key);
                    Map.remove(mem.inbox_tombstone_index, Text.compare, key);
                };
                mem.inbox_tombstones := tombstonePlan.retained;
                Map.clear(mem.inbox_tombstone_index);
                for (tombstone in tombstonePlan.retained.vals()) {
                    Map.add(
                        mem.inbox_tombstone_index,
                        Text.compare,
                        messageKey(tombstone.sender, tombstone.message_id),
                        tombstone,
                    );
                };
            };
            Map.add(mem.inbox, Nat.compare, localId, record);
            Map.add(mem.dedupe, Text.compare, dedupeKey, localId);
            Map.add(mem.unread, Nat.compare, localId, ());
            mem.inbox_order := nextInboxOrder;
            mem.known_rate_events := nextKnownRateEvents;
            mem.unknown_rate_events := nextUnknownRateEvents;
            if (not known) {
                mem.unknown_inbox_count += 1;
                mem.unknown_inbox_bytes += retainedBytes;
            };
            mem.next_local_id += 1;
            mem.revision += 1;
            mem.inbox_count += 1;
            mem.inbox_bytes += retainedBytes;
            mem.unread_count += 1;
            // Every write above is a locally proved transition from the exact
            // cached projection. Publish the new revision only after the whole
            // commit, so no rejected/partial path can bless inconsistent state.
            admissionIntegrityCache := ?admissionIntegrityProjection(
                mem,
                tombstonePlan.max_deleted_at_ns,
                tombstonePlan.next_expiry_ns,
            );
            #accepted({ received_at_ns = acceptedAt64 });
        };

        func admissionStateIsValid() : Bool {
            switch (admissionIntegrityCache) {
                case (?cached) if (admissionIntegrityMatches(mem, cached)) {
                    return true;
                };
                case (_) {};
            };
            admissionIntegrityCache := null;
            if (not validAdmissionState(mem)) return false;
            true;
        };

        func tombstonePlanForAdmission(current : Int) : ?TombstonePlan {
            switch (admissionIntegrityCache) {
                case (?cached) {
                    if (tombstoneWindowContains(cached, current)) {
                        return ?cachedTombstonePlan(mem, cached);
                    };
                };
                case null {};
            };
            planTombstones(mem, current);
        };
    };

    func admissionIntegrityProjection(
        mem : Memory.Mem,
        tombstoneMaxDeletedAt : ?Int,
        tombstoneNextExpiry : ?Int,
    ) : AdmissionIntegrityCache {
        {
            revision = mem.revision;
            next_local_id = mem.next_local_id;
            inbox_order_size = mem.inbox_order.size();
            inbox_size = Map.size(mem.inbox);
            unread_size = Map.size(mem.unread);
            tombstone_size = mem.inbox_tombstones.size();
            tombstone_index_size = Map.size(mem.inbox_tombstone_index);
            dedupe_size = Map.size(mem.dedupe);
            inbox_count = mem.inbox_count;
            inbox_bytes = mem.inbox_bytes;
            unknown_inbox_count = mem.unknown_inbox_count;
            unknown_inbox_bytes = mem.unknown_inbox_bytes;
            unread_count = mem.unread_count;
            tombstone_max_deleted_at_ns = tombstoneMaxDeletedAt;
            tombstone_next_expiry_ns = tombstoneNextExpiry;
        };
    };

    func admissionIntegrityMatches(
        mem : Memory.Mem,
        cached : AdmissionIntegrityCache,
    ) : Bool {
        cached.revision == mem.revision and
        cached.next_local_id == mem.next_local_id and
        cached.inbox_order_size == mem.inbox_order.size() and
        cached.inbox_size == Map.size(mem.inbox) and
        cached.unread_size == Map.size(mem.unread) and
        cached.tombstone_size == mem.inbox_tombstones.size() and
        cached.tombstone_index_size == Map.size(mem.inbox_tombstone_index) and
        cached.dedupe_size == Map.size(mem.dedupe) and
        cached.inbox_count == mem.inbox_count and
        cached.inbox_bytes == mem.inbox_bytes and
        cached.unknown_inbox_count == mem.unknown_inbox_count and
        cached.unknown_inbox_bytes == mem.unknown_inbox_bytes and
        cached.unread_count == mem.unread_count;
    };

    func tombstoneWindowContains(
        cached : AdmissionIntegrityCache,
        current : Int,
    ) : Bool {
        switch (cached.tombstone_max_deleted_at_ns) {
            case (?latest) if (current < latest) return false;
            case (_) {};
        };
        switch (cached.tombstone_next_expiry_ns) {
            case (?expiry) current < expiry;
            case null true;
        };
    };

    func cachedTombstonePlan(
        mem : Memory.Mem,
        cached : AdmissionIntegrityCache,
    ) : TombstonePlan {
        {
            retained = mem.inbox_tombstones;
            orphan_dedupe_keys = [];
            max_deleted_at_ns = cached.tombstone_max_deleted_at_ns;
            next_expiry_ns = cached.tombstone_next_expiry_ns;
            changed = false;
        };
    };

    func duplicate(receivedAt : Int) : ReceiveResultV1 {
        if (not validTimestamp(receivedAt)) return #rejected(#invalid);
        #duplicate({ received_at_ns = Int64.fromInt(receivedAt) });
    };

    func validKeyInfo(info : Memory.PublicKeyInfo) : Bool {
        KeyInfo.validConfigured(info);
    };

    func isZero(value : Blob) : Bool {
        for (byte in value.vals()) if (byte != 0) return false;
        true;
    };

    func validTimestamp(value : Int) : Bool {
        value >= 0 and value <= MAX_INT64;
    };

    func planTombstones(mem : Memory.Mem, current : Int) : ?TombstonePlan {
        let retained = List.empty<Memory.InboxTombstone>();
        let orphanDedupeKeys = List.empty<Text>();
        let plannedKeys = Set.empty<Text>();
        let cutoff = current - THIRTY_DAYS_NS;
        var maxDeletedAt : ?Int = null;
        var nextExpiry : ?Int = null;
        var changed = false;

        for (tombstone in mem.inbox_tombstones.vals()) {
            if (
                not Principal.isCanister(tombstone.sender) or
                tombstone.message_id.size() != Envelope.MESSAGE_ID_BYTES or
                not validTimestamp(tombstone.received_at_ns) or
                not validTimestamp(tombstone.deleted_at_ns) or
                tombstone.received_at_ns > tombstone.deleted_at_ns or
                tombstone.deleted_at_ns > current
            ) return null;

            if (tombstone.deleted_at_ns > cutoff) {
                List.add(retained, tombstone);
                maxDeletedAt := switch (maxDeletedAt) {
                    case (?latest) ?max(latest, tombstone.deleted_at_ns);
                    case null ?tombstone.deleted_at_ns;
                };
                let expiry = tombstone.deleted_at_ns + THIRTY_DAYS_NS;
                nextExpiry := switch (nextExpiry) {
                    case (?earliest) ?min(earliest, expiry);
                    case null ?expiry;
                };
            } else {
                changed := true;
                let key = messageKey(tombstone.sender, tombstone.message_id);
                switch (Map.get(mem.dedupe, Text.compare, key)) {
                    case null {};
                    case (?localId) {
                        switch (Map.get(mem.inbox, Nat.compare, localId)) {
                            case (?_) {};
                            case null {
                                if (Set.insert(plannedKeys, Text.compare, key)) {
                                    List.add(orphanDedupeKeys, key);
                                };
                            };
                        };
                    };
                };
            };
        };

        ?{
            retained = List.toArray(retained);
            orphan_dedupe_keys = List.toArray(orphanDedupeKeys);
            max_deleted_at_ns = maxDeletedAt;
            next_expiry_ns = nextExpiry;
            changed;
        };
    };

    func planRateQueue(
        events : [Memory.RateEvent],
        limit : Nat,
        current : Int,
    ) : ?RateQueuePlan {
        if (events.size() > limit) return null;
        var previous : ?Int = null;
        var rebased = false;
        for (event in events.vals()) {
            if (
                not Principal.isCanister(event.sender) or
                not validTimestamp(event.accepted_at_ns)
            ) return null;
            switch (previous) {
                case (?timestamp) if (timestamp > event.accepted_at_ns) return null;
                case (_) {};
            };
            if (event.accepted_at_ns > current) rebased := true;
            previous := ?event.accepted_at_ns;
        };
        if (not rebased) return ?{ events; rebased = false };
        ?{
            events = Array.map<Memory.RateEvent, Memory.RateEvent>(
                events,
                func(event) {
                    if (event.accepted_at_ns > current) {
                        { event with accepted_at_ns = current };
                    } else event;
                },
            );
            rebased = true;
        };
    };

    // Public receive mutates the shared mailbox state, so it only starts from
    // an exact, internally coherent Inbox projection. Accepting conservative
    // counters would make the new record unreadable through Store, whose
    // invariants require exact counters.
    func validAdmissionState(mem : Memory.Mem) : Bool {
        if (
            mem.next_local_id == 0 or
            mem.inbox_order.size() != Map.size(mem.inbox) or
            Map.size(mem.unread) != mem.unread_count or
            Map.size(mem.inbox_tombstone_index) != mem.inbox_tombstones.size() or
            Map.size(mem.dedupe) != Map.size(mem.inbox) + mem.inbox_tombstones.size()
        ) return false;
        let ids = Set.empty<Nat>();
        let dedupeKeys = Set.empty<Text>();
        var previousId : ?Nat = null;
        var count = 0;
        var bytes = 0;
        var unknownCount = 0;
        var unknownBytes = 0;
        var unreadCount = 0;
        for (id in mem.inbox_order.vals()) {
            if (
                id == 0 or id >= mem.next_local_id or
                not Set.insert(ids, Nat.compare, id)
            ) return false;
            switch (previousId) {
                case (?previous) if (previous <= id) return false;
                case (_) {};
            };
            previousId := ?id;
            let ?record = Map.get(mem.inbox, Nat.compare, id) else return false;
            if (not validInboxRecord(id, record)) return false;
            if (Map.containsKey(mem.unread, Nat.compare, id) == record.read) {
                return false;
            };
            let key = messageKey(record.sender, record.message_id);
            if (not Set.insert(dedupeKeys, Text.compare, key)) return false;
            switch (Map.get(mem.dedupe, Text.compare, key)) {
                case (?mapped) if (mapped == id) {};
                case (_) return false;
            };
            count += 1;
            bytes += record.retained_bytes;
            if (not record.known_at_receipt) {
                unknownCount += 1;
                unknownBytes += record.retained_bytes;
            };
            if (not record.read) unreadCount += 1;
        };

        for (tombstone in mem.inbox_tombstones.vals()) {
            if (
                not Principal.isCanister(tombstone.sender) or
                tombstone.message_id.size() != Envelope.MESSAGE_ID_BYTES or
                isZero(tombstone.message_id) or
                not validTimestamp(tombstone.received_at_ns) or
                not validTimestamp(tombstone.deleted_at_ns) or
                tombstone.deleted_at_ns < tombstone.received_at_ns
            ) return false;
            let key = messageKey(tombstone.sender, tombstone.message_id);
            if (not Set.insert(dedupeKeys, Text.compare, key)) return false;
            let ?indexed = Map.get(mem.inbox_tombstone_index, Text.compare, key) else {
                return false;
            };
            if (
                not Principal.equal(indexed.sender, tombstone.sender) or
                not Blob.equal(indexed.message_id, tombstone.message_id) or
                indexed.received_at_ns != tombstone.received_at_ns or
                indexed.deleted_at_ns != tombstone.deleted_at_ns
            ) return false;
            let ?mapped = Map.get(mem.dedupe, Text.compare, key) else return false;
            if (
                mapped == 0 or mapped >= mem.next_local_id or
                Map.containsKey(mem.inbox, Nat.compare, mapped) or
                Map.containsKey(mem.outbox, Nat.compare, mapped)
            ) return false;
        };

        mem.inbox_count == count and
        mem.inbox_bytes == bytes and
        mem.unknown_inbox_count == unknownCount and
        mem.unknown_inbox_bytes == unknownBytes and
        mem.unread_count == unreadCount;
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

    func waitForOldest(events : [Memory.RateEvent], current : Int) : Int {
        var oldest = current;
        for (event in events.vals()) {
            if (event.accepted_at_ns < oldest) oldest := event.accepted_at_ns;
        };
        let wait = oldest + HOUR_NS - current;
        if (wait > 0) wait else 1;
    };

    func quantizedRetry(waitNs : Int) : Nat32 {
        let seconds = (Int.abs(waitNs) + 999_999_999) / 1_000_000_000;
        let rounded = ((seconds + FIVE_MINUTES_SECONDS - 1) / FIVE_MINUTES_SECONDS) * FIVE_MINUTES_SECONDS;
        Nat32.fromNat(rounded);
    };

    func max(left : Int, right : Int) : Int {
        if (left > right) left else right;
    };

    func min(left : Int, right : Int) : Int {
        if (left < right) left else right;
    };

    func messageKey(sender : Principal, messageId : Blob) : Text {
        Principal.toText(sender) # ":" # hex(messageId);
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
