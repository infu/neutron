import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Contacts "../../backend/main";
import Memory "../../backend/memory/contacts/v2";

func canister(last : Nat8) : Principal {
    Principal.fromBlob(Blob.fromArray([0, last, 1]));
};

func contact(id : Nat, addressId : Nat, principal : Principal) : Memory.Contact {
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

let principal = canister(9);
let mem = Memory.init();
let contacts = Contacts.Init({
    stable_memory = {
        contacts = mem;
    };
});

func assertSearchHealthy(expectedTotal : Nat) {
    switch (contacts.contacts_neutron_search_v2({
        search_text = "";
        offset = 0;
        limit = 10;
    })) {
        case (#ok(page)) assert (page.total == expectedTotal);
        case (#err(_)) assert false;
    };
};

func assertSearchIntegrityError() {
    switch (contacts.contacts_neutron_search_v2({
        search_text = "";
        offset = 0;
        limit = 10;
    })) {
        case (#err(#validation(message))) {
            assert (message == "Contacts Neutron address index is inconsistent");
        };
        case (_) assert false;
    };
};

// A principal that is genuinely absent from a healthy book is safe to treat
// as absent.
let healthyAbsent = contacts.contacts_neutron_lookup_v2({ principal });
assert healthyAbsent.integrity_ok;
assert (healthyAbsent.match == null);
assertSearchHealthy(0);

// A stored address without its required index entry must not look absent.
Map.add(mem.contacts, Nat.compare, 1, contact(1, 1, principal));
mem.revision += 1;
let missingIndex = contacts.contacts_neutron_lookup_v2({ principal });
assert (not missingIndex.integrity_ok);
assert (missingIndex.match == null);
assertSearchIntegrityError();

// An index entry that points at the wrong/missing contact also fails closed.
Map.add(mem.neutron_index, Principal.compare, principal, 2);
mem.revision += 1;
let wrongIndex = contacts.contacts_neutron_lookup_v2({ principal });
assert (not wrongIndex.integrity_ok);
assert (wrongIndex.match == null);
assertSearchIntegrityError();

// Even with one apparently correct index entry, a duplicate principal in the
// bounded contact map is corruption rather than a valid match.
Map.add(mem.neutron_index, Principal.compare, principal, 1);
Map.add(mem.contacts, Nat.compare, 2, contact(2, 2, principal));
mem.revision += 1;
let duplicatePrincipal = contacts.contacts_neutron_lookup_v2({ principal });
assert (not duplicatePrincipal.integrity_ok);
assert (duplicatePrincipal.match == null);
assertSearchIntegrityError();
