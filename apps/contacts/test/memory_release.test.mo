import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Contacts "../backend/main";
import Memory "../backend/memory/contacts/v2";

// Fresh installs use the released v2 defaults.
let fresh = Memory.init();
assert (fresh.next_contact_id == 1);
assert (fresh.next_address_id == 1);
assert (fresh.revision == 0);
assert (Map.size(fresh.contacts) == 0);
assert (Map.size(fresh.neutron_index) == 0);

// Contacts 0.3.1 already runs v2. The archive transition test proves the
// license-only 0.3.2 release is #keep, so representative production data must
// be visible when the backend is rebuilt over the retained root.
let principal = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
let retained : Memory.Contact = {
    id = 7;
    revision = 3;
    kind = #person;
    name = "Retained contact";
    notes = "Kept across the release";
    addresses = [{
        id = 11;
        address_label = ?"Neutron";
        destination = #neutron(principal);
        preferred = true;
    }];
    created_at = 100;
    updated_at = 200;
};
fresh.next_contact_id := 8;
fresh.next_address_id := 12;
fresh.revision := 9;
Map.add(fresh.contacts, Nat.compare, retained.id, retained);
Map.add(fresh.neutron_index, Principal.compare, principal, retained.id);

let restored : Memory.Mem = fresh;
let contacts = Contacts.Init({ stable_memory = { contacts = restored } });
assert (contacts.contacts_revision(()).revision == 9);
switch (contacts.contacts_get({ id = 7 })) {
    case (?contact) {
        assert (contact.name == "Retained contact");
        assert (contact.notes == "Kept across the release");
        assert (contact.addresses.size() == 1);
    };
    case null assert false;
};
let lookup = contacts.contacts_neutron_lookup_v2({ principal });
assert lookup.integrity_ok;
switch (lookup.match) {
    case (?match) assert (match.contact_id == 7 and match.principal == principal);
    case null assert false;
};
