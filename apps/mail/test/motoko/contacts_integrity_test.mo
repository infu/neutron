import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Contacts "../../../contacts/backend/main";
import ContactMemory "../../../contacts/backend/memory/contacts/v2";
import Mail "../../backend/main";
import Capabilities "../../backend/capabilities/Types";
import Accounting "../../backend/mailbox/Accounting";
import Store "../../backend/mailbox/Store";
import MailMemory "../../backend/memory/mail/v1";
import Fixture "Fixture";

func canister(last : Nat8) : Principal {
    Principal.fromBlob(Blob.fromArray([0, last, 1]));
};

func contact(id : Nat, addressId : Nat, principal : Principal) : ContactMemory.Contact {
    {
        id;
        revision = 1;
        kind = #person;
        name = "Contact " # Nat.toText(id);
        notes = "";
        addresses = [{
            id = addressId;
            address_label = null;
            destination = #neutron(principal);
            preferred = false;
        }];
        created_at = 1;
        updated_at = 1;
    };
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

let self = canister(1);
let sender = canister(9);
let contactMem = ContactMemory.init();
let contacts = Contacts.Init({
    stable_memory = {
        contacts = contactMem;
    };
});
let capabilities : {
    backend_calls : Capabilities.BackendCalls;
    vetkeys_public : Capabilities.VetKeysPublic;
} = {
    backend_calls = {
        canister_principal = self;
        can_call = func(_canister : Principal, _method : Text) { true };
        call = func(_request : Capabilities.CallRequest) : async* Capabilities.CallResult {
            #err({ code = "unused"; message = "unused" });
        };
        call_batch = func(_requests : [Capabilities.CallRequest]) : async* [Capabilities.CallResult] {
            [];
        };
    };
    vetkeys_public = {
        canister_principal = self;
        slot = func(_slot : Text) : ?Capabilities.VetKeySlotSummary { null };
        public_key = func(
            _request : { slot : Text; generation : Nat64 },
        ) : async* Capabilities.VetKeyPublicResult {
            #err(#not_reserved);
        };
    };
};
let appCalls : Mail.AppCalls = {
    contacts = {
        contacts_neutron_lookup_v2 = func(request) {
            contacts.contacts_neutron_lookup_v2(request);
        };
        contacts_neutron_search_v2 = func(request) {
            contacts.contacts_neutron_search_v2(request);
        };
        contacts_neutron_revision_v2 = func(_unit : ()) {
            contacts.contacts_neutron_revision_v2(());
        };
    };
};

let mem = MailMemory.init();
let messageId = Fixture.messageId(1);
let envelope = Fixture.envelope(1_040, 1, 7, 0x22);
let retainedBytes = Accounting.inboxRetainedBytes(envelope);
let inboxRecord : MailMemory.InboxRecord = {
    local_id = 1;
    sender;
    message_id = messageId;
    delivery_key_epoch = 7;
    delivery_key_fingerprint = Fixture.repeatBlob(32, 0x22);
    local_wrap_epoch = 7;
    local_wrap_fingerprint = Fixture.repeatBlob(32, 0x22);
    local_wrapped_cek = Fixture.repeatBlob(168, 0x55);
    envelope;
    received_at_ns = 1;
    read = false;
    known_at_receipt = false;
    retained_bytes = retainedBytes;
};
Map.add(mem.inbox, Nat.compare, 1, inboxRecord);
Map.add(mem.unread, Nat.compare, 1, ());
Map.add(
    mem.dedupe,
    Text.compare,
    Principal.toText(sender) # ":" # hex(messageId),
    1,
);
mem.next_local_id := 2;
mem.revision := 1;
mem.inbox_order := [1];
mem.inbox_count := 1;
mem.inbox_bytes := retainedBytes;
mem.unknown_inbox_count := 1;
mem.unknown_inbox_bytes := retainedBytes;
mem.unread_count := 1;

let mail = Mail.Init({
    stable_memory = { mail = mem };
    app_calls = appCalls;
    capabilities;
});

func listInbox() : Store.CurrentContact {
    switch (mail.mail_list_encrypted({
        folder = #inbox;
        unread_only = false;
        offset = 0;
        limit = 10;
        expected_mail_revision = null;
        expected_contacts_revision = null;
    })) {
        case (#ok(page)) {
            assert (page.items.size() == 1 and page.contacts_revision == contactMem.revision);
            switch (page.items[0]) {
                case (#inbox(item)) {
                    assert (not item.known_at_receipt);
                    item.current_contact;
                };
                case (_) { assert false; #contact_conflict };
            };
        };
        case (#err(_)) { assert false; #contact_conflict };
    };
};

func getInbox() : Store.CurrentContact {
    switch (mail.mail_get_encrypted({ store = #inbox; local_id = 1 })) {
        case (#ok(result)) {
            assert (result.contacts_revision == contactMem.revision);
            switch (result.record) {
                case (#inbox(item)) {
                    assert (not item.known_at_receipt);
                    item.current_contact;
                };
                case (_) { assert false; #contact_conflict };
            };
        };
        case (#err(_)) { assert false; #contact_conflict };
    };
};

func assertAbsentProjection() {
    for (projection in [listInbox(), getInbox()].vals()) {
        switch (projection) {
            case (#not_in_contacts) {};
            case (_) assert false;
        };
    };
};

func assertKnownProjection() {
    for (projection in [listInbox(), getInbox()].vals()) {
        switch (projection) {
            case (#in_contacts(current)) {
                assert (current.contact_id == 1);
                assert (current.contact_revision == 1);
                assert (current.contact_name == "Contact 1");
            };
            case (_) assert false;
        };
    };
};

func assertConflictProjection() {
    for (projection in [listInbox(), getInbox()].vals()) {
        switch (projection) {
            case (#contact_conflict) {};
            case (_) assert false;
        };
    };
};

func assertHealthyAbsent() {
    switch (mail.mail_cleanup_preview(#unknown_current)) {
        case (#ok(preview)) {
            assert (preview.counts.total == 1 and preview.counts.unread == 1);
        };
        case (#err(_)) assert false;
    };
};

func assertContactsConflict() {
    assertConflictProjection();
    switch (mail.mail_cleanup_preview(#unknown_current)) {
        case (#err(#contacts_conflict)) {};
        case (_) assert false;
    };
    assert (Map.size(mem.inbox) == 1 and mem.inbox_count == 1);
};

// A healthy absence is deletable by the unknown-current cleanup scope.
assertHealthyAbsent();
assertAbsentProjection();

// The same stored row reprojects through current Contacts without rewriting
// its immutable admission audit bit.
Map.add(contactMem.contacts, Nat.compare, 1, contact(1, 1, sender));
Map.add(contactMem.neutron_index, Principal.compare, sender, 1);
contactMem.revision += 1;
assertKnownProjection();

Map.remove(contactMem.neutron_index, Principal.compare, sender);
Map.remove(contactMem.contacts, Nat.compare, 1);
contactMem.revision += 1;
assertAbsentProjection();

// Missing index entry: fail closed.
Map.add(contactMem.contacts, Nat.compare, 1, contact(1, 1, sender));
contactMem.revision += 1;
assertContactsConflict();

// Index points at the wrong/missing contact: fail closed.
Map.add(contactMem.neutron_index, Principal.compare, sender, 2);
contactMem.revision += 1;
assertContactsConflict();

// Duplicate principal hidden behind one apparently correct index: fail closed.
Map.add(contactMem.neutron_index, Principal.compare, sender, 1);
Map.add(contactMem.contacts, Nat.compare, 2, contact(2, 2, sender));
contactMem.revision += 1;
assertContactsConflict();
