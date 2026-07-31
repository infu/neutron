import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Crypto "../../backend/crypto/Service";
import Memory "../../backend/memory/mail/v1";
import Fixture "Fixture";
import F "CryptoFixture";

var slot = F.summary(8, ?7, #enabled, F.holder());
let capability : Crypto.VetKeysPublic = {
    canister_principal = F.canister(1);
    slot = func(id : Text) : ?Crypto.SlotSummary {
        if (id == Crypto.SLOT_ID) ?slot else null;
    };
    public_key = func(request : { slot : Text; generation : Nat64 }) : async* Crypto.PublicKeyResult {
        #ok(F.material(request.generation, true));
    };
};
let mem = Memory.init();
let crypto = Crypto.Service(mem, capability);
mem.key_info := ?F.configured8();
mem.encrypted_settings := ?F.settings();
Map.add(mem.inbox, Nat.compare, 1, F.inboxRecord());
Map.add(mem.outbox, Nat.compare, 2, F.outboxRecord());

let originalInbox = F.inboxRecord();
let originalOutbox = F.outboxRecord();
let originalSettings = F.settings();
switch (crypto.rewrap({
    expected_current_epoch = 8;
    expected_previous_epoch = 7;
    targets = [
        #settings({
            expected_revision = 4;
            expected_local_wrapped_cek = F.wrapSettings7();
            replacement_local_wrapped_cek = F.wrapSettings8();
        }),
        #inbox({
            local_id = 1;
            expected_local_wrapped_cek = F.wrapInbox7();
            replacement_local_wrapped_cek = F.wrapInbox8();
        }),
    ];
})) {
    case (#ok(value)) {
        assert (value.changed == 2 and value.message_wraps_changed == 1);
        assert (value.settings_wrap_changed);
        assert (value.progress.previous_references.total == 1);
        assert (value.progress.previous_references.outbox == 1);
        assert (value.progress.mail_revision == 1);
    };
    case (_) assert false;
};

let ?newSettings = mem.encrypted_settings else { assert false; loop {} };
let ?newInbox = Map.get(mem.inbox, Nat.compare, 1) else { assert false; loop {} };
assert (newSettings.revision == originalSettings.revision);
assert (newSettings.record_id == originalSettings.record_id);
assert (newSettings.nonce == originalSettings.nonce);
assert (newSettings.ciphertext_and_tag == originalSettings.ciphertext_and_tag);
assert (newSettings.local_wrap_epoch == 8);
assert (newSettings.local_wrap_fingerprint == F.fingerprint8());
assert (newSettings.local_wrapped_cek == F.wrapSettings8());
assert (newInbox.delivery_key_epoch == originalInbox.delivery_key_epoch);
assert (newInbox.delivery_key_fingerprint == originalInbox.delivery_key_fingerprint);
assert (newInbox.envelope == originalInbox.envelope);
assert (newInbox.local_wrap_epoch == 8);
assert (newInbox.local_wrap_fingerprint == F.fingerprint8());
assert (newInbox.local_wrapped_cek == F.wrapInbox8());

// Duplicate and stale exact selectors reject the whole batch.
switch (crypto.rewrap({
    expected_current_epoch = 8;
    expected_previous_epoch = 7;
    targets = [
        #outbox({
            local_id = 2;
            expected_local_wrapped_cek = F.wrapOutbox7();
            replacement_local_wrapped_cek = F.wrapOutbox8();
        }),
        #outbox({
            local_id = 2;
            expected_local_wrapped_cek = F.wrapOutbox7();
            replacement_local_wrapped_cek = Fixture.repeatBlob(168, 0x64);
        }),
    ];
})) {
    case (#err(#invalid_request)) {};
    case (_) assert false;
};
assert (mem.revision == 1);
let ?unchangedOutbox = Map.get(mem.outbox, Nat.compare, 2) else { assert false; loop {} };
assert (unchangedOutbox.local_wrap_epoch == 7);
assert (unchangedOutbox.local_wrapped_cek == F.wrapOutbox7());

switch (crypto.rewrap({
    expected_current_epoch = 8;
    expected_previous_epoch = 7;
    targets = [#outbox({
        local_id = 2;
        expected_local_wrapped_cek = Fixture.repeatBlob(168, 0x70);
        replacement_local_wrapped_cek = F.wrapOutbox8();
    })];
})) {
    case (#err(#revision_conflict)) {};
    case (_) assert false;
};
assert (mem.revision == 1);

switch (crypto.rewrap({
    expected_current_epoch = 8;
    expected_previous_epoch = 7;
    targets = [#outbox({
        local_id = 2;
        expected_local_wrapped_cek = F.wrapOutbox7();
        replacement_local_wrapped_cek = F.wrapOutbox8();
    })];
})) {
    case (#ok(value)) {
        assert (value.progress.previous_references.total == 0);
        assert (value.progress.ready_to_retire);
    };
    case (_) assert false;
};
let ?newOutbox = Map.get(mem.outbox, Nat.compare, 2) else { assert false; loop {} };
assert (newOutbox.delivery_key_epoch == originalOutbox.delivery_key_epoch);
assert (newOutbox.delivery_key_fingerprint == originalOutbox.delivery_key_fingerprint);
assert (newOutbox.envelope == originalOutbox.envelope);
assert (newOutbox.local_wrap_epoch == 8);
assert (newOutbox.local_wrap_fingerprint == F.fingerprint8());
assert (newOutbox.local_wrapped_cek == F.wrapOutbox8());

// Authoritative post-retirement sync clears cached previous only at zero refs.
slot := F.summary(8, null, #enabled, F.holder());
switch (crypto.rotateStart()) {
    case (#complete(value)) {
        assert (value.previous_epoch == null);
        assert (value.previous_references.total == 0);
        assert (not value.ready_to_retire);
    };
    case (_) assert false;
};
let ?retired = mem.key_info else { assert false; loop {} };
assert (retired.previous_epoch == null and retired.previous_fingerprint == null);
