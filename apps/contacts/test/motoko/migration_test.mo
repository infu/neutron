import Map "mo:core/Map";
import Nat "mo:core/Nat";
import V1 "../../backend/memory/contacts/v1";
import Migration "../../backend/memory/contacts/v1_to_v2";

let old = V1.init();
old.next_contact_id := 8;
old.next_address_id := 12;
old.revision := 9;
Map.add<Nat, V1.Contact>(old.contacts, Nat.compare, 7, {
    id = 7;
    revision = 3;
    kind = #person;
    name = "Legacy";
    notes = "kept";
    addresses = [{
        id = 11;
        address_label = ?"Bitcoin";
        destination = #bitcoin_mainnet("1BoatSLRHtKNngkdXEeobR76b53LETtpyT");
        preferred = true;
    }];
    created_at = 100;
    updated_at = 200;
});

let migrated = Migration.migrate(old);
assert (migrated.next_contact_id == 8);
assert (migrated.next_address_id == 12);
assert (migrated.revision == 9);
assert (Map.size(migrated.neutron_index) == 0);
switch (Map.get(migrated.contacts, Nat.compare, 7)) {
    case (?legacy) {
        assert (legacy.id == 7 and legacy.revision == 3);
        assert (legacy.name == "Legacy" and legacy.notes == "kept");
        assert (legacy.created_at == 100 and legacy.updated_at == 200);
        assert (legacy.addresses.size() == 1 and legacy.addresses[0].id == 11);
        switch (legacy.addresses[0].destination) {
            case (#bitcoin_mainnet(value)) assert (value == "1BoatSLRHtKNngkdXEeobR76b53LETtpyT");
            case (_) assert false;
        };
    };
    case null assert false;
};
