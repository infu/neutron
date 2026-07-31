import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat32 "mo:core/Nat32";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Receive "../../backend/mailbox/Receive";
import Store "../../backend/mailbox/Store";
import Memory "../../backend/memory/mail/v1";
import KeyInfo "../../backend/protocol/KeyInfo";
import Fixture "Fixture";

func canister(last : Nat8) : Principal {
    Principal.fromBlob(Blob.fromArray([0, last, 1]));
};

func assertInboxPage(
    result : Store.Result<Store.ListPage>,
    expectedIds : [Nat],
    expectedTotal : Nat,
    expectedNext : ?Nat,
) {
    switch (result) {
        case (#err(_)) assert false;
        case (#ok(page)) {
            assert (page.items.size() == expectedIds.size());
            assert (page.total == expectedTotal and page.next_offset == expectedNext);
            var index = 0;
            while (index < expectedIds.size()) {
                switch (page.items[index]) {
                    case (#inbox(item)) assert (item.local_id == expectedIds[index]);
                    case (_) assert false;
                };
                index += 1;
            };
        };
    };
};

func assertOutboxPage(
    result : Store.Result<Store.ListPage>,
    sent : Bool,
    expectedIds : [Nat],
    expectedTotal : Nat,
    expectedNext : ?Nat,
) {
    switch (result) {
        case (#err(_)) assert false;
        case (#ok(page)) {
            assert (page.items.size() == expectedIds.size());
            assert (page.total == expectedTotal and page.next_offset == expectedNext);
            var index = 0;
            while (index < expectedIds.size()) {
                switch (page.items[index]) {
                    case (#sent(item)) assert (sent and item.local_id == expectedIds[index]);
                    case (#outbox(item)) assert (not sent and item.local_id == expectedIds[index]);
                    case (_) assert false;
                };
                index += 1;
            };
        };
    };
};

let self = canister(1);
let remote = canister(2);
let publicKey = Fixture.repeatBlob(96, 0x31);
let ibeIdentity = Fixture.repeatBlob(32, 0x32);
let fingerprint = KeyInfo.fingerprint(1, 7, publicKey, ibeIdentity);

let mem = Memory.init();
let store = Store.Service(
    mem,
    func() { 7_000_000_000_000 },
    func() { 0 },
    func(_sender : Principal) { #none },
);

switch (store.status()) {
    case (#err(_)) assert false;
    case (#ok(status)) {
        assert (status.mail_revision == 0 and status.inbox_count == 0);
        assert (status.unread_count == 0 and status.outbox_count == 0);
    };
};

switch (store.pulse()) {
    case (#err(_)) assert false;
    case (#ok(pulse)) {
        assert (pulse.mail_revision == 0 and pulse.contacts_revision == 0);
        assert (pulse.cleanup_epoch == 0 and pulse.inbox_count == 0);
        assert (pulse.unread_count == 0);
    };
};
mem.unread_count := 1;
switch (store.pulse()) {
    case (#err(#corrupt_state)) {};
    case (_) assert false;
};
mem.unread_count := 0;

switch (store.mark({ local_ids = []; read = true })) {
    case (#err(_)) assert false;
    case (#ok(result)) assert (result.changed == 0);
};

mem.key_info := ?{
    protocol_version = 1;
    suite = 1;
    key_holder = Principal.fromText("pcofx-mj5y3-27jya-3jcsk-jzcy2-2y6yj-bvf32-ousik-tb3ks-uyjkz-rqe");
    current_epoch = 7;
    current_fingerprint = fingerprint;
    context_public_key = publicKey;
    effective_ibe_identity = ibeIdentity;
    max_envelope_bytes = Nat32.fromNat(39_199);
    previous_epoch = null;
    previous_fingerprint = null;
};
let receiver = Receive.Service(
    mem,
    self,
    func(_sender : Principal) { false },
    func() { 7_000_000_000_000 },
);
switch (receiver.receive(Fixture.envelopeWithFingerprint(1_040, 1, 7, fingerprint), remote)) {
    case (#accepted(_)) {};
    case (_) assert false;
};
assert (Map.get(mem.unread, Nat.compare, 1) == ?() and mem.unread_count == 1);
switch (store.status()) {
    case (#err(_)) assert false;
    case (#ok(status)) assert (status.unread_count == 1 and status.inbox_count == 1);
};
switch (store.pulse()) {
    case (#err(_)) assert false;
    case (#ok(pulse)) {
        assert (pulse.mail_revision == mem.revision);
        assert (pulse.inbox_count == 1 and pulse.unread_count == 1);
    };
};

switch (store.mark({ local_ids = [1]; read = true })) {
    case (#err(_)) assert false;
    case (#ok(result)) assert (result.changed == 1 and result.unread_remaining == 0);
};
assert (Map.get(mem.unread, Nat.compare, 1) == null and mem.unread_count == 0);
switch (store.pulse()) {
    case (#err(_)) assert false;
    case (#ok(pulse)) {
        assert (pulse.mail_revision == mem.revision);
        assert (pulse.inbox_count == 1 and pulse.unread_count == 0);
    };
};

switch (store.mark({ local_ids = [1]; read = false })) {
    case (#err(_)) assert false;
    case (#ok(result)) assert (result.changed == 1 and result.unread_remaining == 1);
};
assert (Map.get(mem.unread, Nat.compare, 1) == ?() and mem.unread_count == 1);

let regressedStore = Store.Service(
    mem,
    func() { 6_999_999_999_999 },
    func() { 0 },
    func(_sender : Principal) { #none },
);
switch (regressedStore.delete({ targets = [#inbox(1)] })) {
    case (#err(#clock_invalid)) {};
    case (_) assert false;
};
assert (Map.size(mem.inbox) == 1 and mem.inbox_tombstones.size() == 0);

switch (store.delete({ targets = [#inbox(1)] })) {
    case (#err(_)) assert false;
    case (#ok(result)) {
        assert (result.changed == 1 and result.inbox_deleted == 1);
        assert (result.unread_deleted == 1 and result.unread_remaining == 0);
    };
};
assert (Map.size(mem.inbox) == 0 and Map.size(mem.unread) == 0);
assert (mem.inbox_count == 0 and mem.unread_count == 0);

let commandId = Fixture.repeatBlob(16, 0x0a);
let commandFingerprint = Fixture.repeatBlob(32, 0x0c);
let retryRequestId = Fixture.repeatBlob(16, 0x0b);
let outboxEnvelope = Fixture.envelopeWithFingerprint(1_040, 2, 7, fingerprint);
let outboxRecord : Memory.OutboxRecord = {
    local_id = 2;
    command_id = commandId;
    command_fingerprint = commandFingerprint;
    recipient = remote;
    contact_id = null;
    contact_revision = null;
    message_id = Fixture.messageId(2);
    delivery_key_epoch = 7;
    delivery_key_fingerprint = fingerprint;
    local_wrap_epoch = 7;
    local_wrap_fingerprint = fingerprint;
    local_wrapped_cek = Fixture.repeatBlob(168, 0x33);
    envelope = outboxEnvelope;
    created_at_ns = 6_000_000_000_000;
    updated_at_ns = 6_000_000_000_001;
    cleanup_epoch = 0;
    attempt_no = 2;
    attempt_request_id = ?retryRequestId;
    state = #delivery_uncertain;
    retained_bytes = outboxEnvelope.size() + 1_024;
};
Map.add(mem.outbox, Nat.compare, 2, outboxRecord);
Map.add(mem.commands, Text.compare, "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a", {
    command_id = commandId;
    request_fingerprint = commandFingerprint;
    local_id = 2;
    cleanup_epoch = 0;
    created_at_ns = 6_000_000_000_000;
});
mem.outbox_order := [2];
mem.outbox_count := 1;
mem.outbox_bytes := outboxEnvelope.size() + 1_024;
mem.next_local_id := 3;

// A recipient timestamp can never be later than the callback/update that
// recorded it. Treat such stable state as corrupt instead of projecting a
// future acceptance time.
Map.add(mem.outbox, Nat.compare, 2, {
    outboxRecord with
    state = #accepted({ received_at_ns = outboxRecord.updated_at_ns + 1 });
});
switch (store.status()) {
    case (#err(#corrupt_state)) {};
    case (_) assert false;
};
Map.add(mem.outbox, Nat.compare, 2, outboxRecord);

switch (store.list({
    folder = #outbox;
    unread_only = false;
    offset = 0;
    limit = 10;
    expected_mail_revision = null;
    expected_contacts_revision = null;
})) {
    case (#ok(page)) switch (page.items[0]) {
        case (#outbox(item)) switch (item.current_contact) {
            case (#not_in_contacts) {};
            case (_) assert false;
        };
        case (_) assert false;
    };
    case (#err(_)) assert false;
};
switch (store.get({ store = #outbox; local_id = 2 })) {
    case (#ok(result)) switch (result.record) {
        case (#outbox(item)) switch (item.current_contact) {
            case (#not_in_contacts) {};
            case (_) assert false;
        };
        case (_) assert false;
    };
    case (#err(_)) assert false;
};

switch (store.delete({ targets = [#outbox(2)] })) {
    case (#err(_)) assert false;
    case (#ok(result)) assert (result.outbox_deleted == 1 and result.changed == 1);
};
assert (Map.size(mem.outbox) == 0 and Map.size(mem.commands) == 0);
assert (mem.command_tombstones.size() == 1 and mem.retry_tombstones.size() == 1);
assert (mem.cleanup_epoch == 0);

mem.encrypted_settings := ?{
    record_id = Fixture.repeatBlob(16, 0x71);
    revision = 1;
    local_wrap_epoch = 7;
    local_wrap_fingerprint = fingerprint;
    local_wrapped_cek = Fixture.repeatBlob(168, 0x72);
    nonce = Fixture.repeatBlob(12, 0x73);
    ciphertext_and_tag = Fixture.repeatBlob(32, 0x74);
};
mem.known_rate_events := [{ sender = remote; accepted_at_ns = 6_000_000_000_000 }];
let permitId = Fixture.repeatBlob(32, 0x75);
let permit : Memory.RecipientPermit = {
    permit_id = permitId;
    target = remote;
    contact_id = null;
    contact_revision = null;
    book_revision = 0;
    suite = 1;
    delivery_key_epoch = 7;
    delivery_key_fingerprint = fingerprint;
    public_info_hash = Fixture.repeatBlob(32, 0x76);
    cleanup_epoch = 0;
    expires_at_ns = 7_100_000_000_000;
};
Map.add(mem.permits, Text.compare, "7575757575757575757575757575757575757575757575757575757575757575", permit);

switch (store.cleanupPreview(#all_mail)) {
    case (#err(_)) assert false;
    case (#ok(preview)) {
        assert (preview.counts.total == 0);
        switch (store.cleanupCommit(preview)) {
            case (#err(_)) assert false;
            case (#ok(result)) assert (result.changed == 0 and result.cleanup_epoch == 1);
        };
    };
};
assert (mem.key_info != null and mem.encrypted_settings != null);
assert (Map.size(mem.permits) == 0);
assert (mem.known_rate_events.size() == 1 and Map.size(mem.dedupe) == 1);
assert (mem.command_tombstones.size() == 1 and mem.retry_tombstones.size() == 1);

// Multiple pages preserve the descending stable order without constructing a
// mailbox-wide id projection. The filtered unread cursor is logical (not a
// physical inbox_order position) and remains gap-free after read mutations.
let pageMem = Memory.init();
pageMem.key_info := mem.key_info;
let pageReceiver = Receive.Service(
    pageMem,
    self,
    func(_sender : Principal) { true },
    func() { 8_000_000_000_000 },
);
var messageNumber = 1;
while (messageNumber <= 5) {
    switch (pageReceiver.receive(
        Fixture.envelopeWithFingerprint(1_040, messageNumber, 7, fingerprint),
        remote,
    )) {
        case (#accepted(_)) {};
        case (_) assert false;
    };
    messageNumber += 1;
};
let pageStore = Store.Service(
    pageMem,
    func() { 8_000_000_000_000 },
    func() { 11 },
    func(_sender : Principal) { #none },
);
let pageRevision = pageMem.revision;
assertInboxPage(pageStore.list({
    folder = #inbox;
    unread_only = false;
    offset = 0;
    limit = 2;
    expected_mail_revision = ?pageRevision;
    expected_contacts_revision = ?11;
}), [5, 4], 5, ?2);
assertInboxPage(pageStore.list({
    folder = #inbox;
    unread_only = false;
    offset = 2;
    limit = 2;
    expected_mail_revision = ?pageRevision;
    expected_contacts_revision = ?11;
}), [3, 2], 5, ?4);
assertInboxPage(pageStore.list({
    folder = #inbox;
    unread_only = false;
    offset = 4;
    limit = 2;
    expected_mail_revision = ?pageRevision;
    expected_contacts_revision = ?11;
}), [1], 5, null);
assertInboxPage(pageStore.list({
    folder = #inbox;
    unread_only = false;
    offset = 5;
    limit = 2;
    expected_mail_revision = ?pageRevision;
    expected_contacts_revision = ?11;
}), [], 5, null);

switch (pageStore.mark({ local_ids = [4, 2]; read = true })) {
    case (#ok(result)) assert (result.changed == 2 and result.unread_remaining == 3);
    case (#err(_)) assert false;
};
switch (pageStore.list({
    folder = #inbox;
    unread_only = false;
    offset = 0;
    limit = 2;
    expected_mail_revision = ?pageRevision;
    expected_contacts_revision = ?11;
})) {
    case (#err(#revision_conflict(_))) {};
    case (_) assert false;
};
let unreadRevision = pageMem.revision;
assertInboxPage(pageStore.list({
    folder = #inbox;
    unread_only = true;
    offset = 0;
    limit = 2;
    expected_mail_revision = ?unreadRevision;
    expected_contacts_revision = ?11;
}), [5, 3], 3, ?2);
assertInboxPage(pageStore.list({
    folder = #inbox;
    unread_only = true;
    offset = 2;
    limit = 2;
    expected_mail_revision = ?unreadRevision;
    expected_contacts_revision = ?11;
}), [1], 3, null);

func addPageOutbox(
    id : Nat,
    commandByte : Nat8,
    commandKey : Text,
    sent : Bool,
) {
    let envelope = Fixture.envelopeWithFingerprint(1_040, 100 + id, 7, fingerprint);
    let state : Memory.OutboxState = if (sent) {
        #accepted({ received_at_ns = 7_999_999_999_999 });
    } else {
        #delivery_uncertain;
    };
    let commandId = Fixture.repeatBlob(16, commandByte);
    let commandFingerprint = Fixture.repeatBlob(32, commandByte);
    let record : Memory.OutboxRecord = {
        local_id = id;
        command_id = commandId;
        command_fingerprint = commandFingerprint;
        recipient = remote;
        contact_id = null;
        contact_revision = null;
        message_id = Fixture.messageId(100 + id);
        delivery_key_epoch = 7;
        delivery_key_fingerprint = fingerprint;
        local_wrap_epoch = 7;
        local_wrap_fingerprint = fingerprint;
        local_wrapped_cek = Fixture.repeatBlob(168, 0x33);
        envelope;
        created_at_ns = 8_000_000_000_000;
        updated_at_ns = 8_000_000_000_001;
        cleanup_epoch = 0;
        attempt_no = 1;
        attempt_request_id = null;
        state;
        retained_bytes = envelope.size() + 1_024;
    };
    Map.add(pageMem.outbox, Nat.compare, id, record);
    Map.add(pageMem.commands, Text.compare, commandKey, {
        command_id = commandId;
        request_fingerprint = commandFingerprint;
        local_id = id;
        cleanup_epoch = 0;
        created_at_ns = 8_000_000_000_000;
    });
    pageMem.outbox_count += 1;
    pageMem.outbox_bytes += envelope.size() + 1_024;
};

addPageOutbox(6, 0x16, "16161616161616161616161616161616", false);
addPageOutbox(7, 0x17, "17171717171717171717171717171717", true);
addPageOutbox(8, 0x18, "18181818181818181818181818181818", false);
addPageOutbox(9, 0x19, "19191919191919191919191919191919", true);
pageMem.outbox_order := [9, 8, 7, 6];
pageMem.next_local_id := 10;
pageMem.revision += 1;

switch (pageStore.status()) {
    case (#ok(status)) {
        assert (status.inbox_count == 5 and status.unread_count == 3);
        assert (status.sent_count == 2 and status.outbox_count == 2);
    };
    case (#err(_)) assert false;
};
// A repeated status call must return the same authoritative counters while
// remaining independent of query-local mutable state.
switch (pageStore.status()) {
    case (#ok(status)) assert (status.sent_count == 2 and status.outbox_count == 2);
    case (#err(_)) assert false;
};
let outboxRevision = pageMem.revision;
assertOutboxPage(pageStore.list({
    folder = #sent;
    unread_only = false;
    offset = 0;
    limit = 1;
    expected_mail_revision = ?outboxRevision;
    expected_contacts_revision = ?11;
}), true, [9], 2, ?1);
assertOutboxPage(pageStore.list({
    folder = #sent;
    unread_only = false;
    offset = 1;
    limit = 1;
    expected_mail_revision = ?outboxRevision;
    expected_contacts_revision = ?11;
}), true, [7], 2, null);
assertOutboxPage(pageStore.list({
    folder = #outbox;
    unread_only = false;
    offset = 0;
    limit = 2;
    expected_mail_revision = ?outboxRevision;
    expected_contacts_revision = ?11;
}), false, [8, 6], 2, null);
