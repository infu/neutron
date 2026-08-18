import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat32 "mo:core/Nat32";
import Principal "mo:core/Principal";
import Memory "../backend/memory/mail/v1";

// Fresh installs use the released v1 defaults.
let fresh = Memory.init();
assert (fresh.next_local_id == 1);
assert (fresh.next_permit_generation == 1);
assert (fresh.revision == 0 and fresh.cleanup_epoch == 0);
assert (fresh.key_info == null and fresh.encrypted_settings == null);
assert (Map.size(fresh.inbox) == 0 and fresh.inbox_order.size() == 0);
assert (Map.size(fresh.unread) == 0);
assert (Map.size(fresh.outbox) == 0 and fresh.outbox_order.size() == 0);

// Mail 0.3.2 already runs v1. The archive transition test proves the
// license-only 0.3.3 release is #keep rather than a second init().
let sender = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
let inbox : Memory.InboxRecord = {
    local_id = 7;
    sender;
    message_id = "message-id";
    delivery_key_epoch = 4;
    delivery_key_fingerprint = "delivery-fingerprint";
    local_wrap_epoch = 5;
    local_wrap_fingerprint = "local-fingerprint";
    local_wrapped_cek = "wrapped-cek";
    envelope = "ciphertext";
    received_at_ns = 123;
    read = false;
    known_at_receipt = true;
    retained_bytes = 321;
};
fresh.next_local_id := 8;
fresh.next_permit_generation := 12;
fresh.revision := 9;
fresh.cleanup_epoch := 3;
fresh.key_info := ?{
    protocol_version = 1;
    suite = 1;
    key_holder = sender;
    current_epoch = 4;
    current_fingerprint = "delivery-fingerprint";
    context_public_key = "public-key";
    effective_ibe_identity = "identity";
    max_envelope_bytes = Nat32.fromNat(65_536);
    previous_epoch = ?3;
    previous_fingerprint = ?"previous-fingerprint";
};
Map.add(fresh.inbox, Nat.compare, inbox.local_id, inbox);
Map.add(fresh.unread, Nat.compare, inbox.local_id, ());
fresh.inbox_order := [inbox.local_id];
fresh.inbox_count := 1;
fresh.inbox_bytes := inbox.retained_bytes;
fresh.unread_count := 1;

let restored : Memory.Mem = fresh;
assert (restored.next_local_id == 8);
assert (restored.next_permit_generation == 12);
assert (restored.revision == 9 and restored.cleanup_epoch == 3);
assert (restored.inbox_order == [7]);
assert (restored.inbox_count == 1 and restored.inbox_bytes == 321);
assert (restored.unread_count == 1);
switch (restored.key_info) {
    case (?keyInfo) assert (keyInfo.current_epoch == 4 and keyInfo.key_holder == sender);
    case null assert false;
};
switch (Map.get(restored.inbox, Nat.compare, 7)) {
    case (?message) assert (message.envelope == "ciphertext" and not message.read);
    case null assert false;
};
assert (Map.get(restored.unread, Nat.compare, 7) == ?());
