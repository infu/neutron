import Array "mo:core/Array";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import V1 "./v1";
import V2 "./v2";

module {
    public func migrate(old : V1.Mem) : V2.Mem {
        let contacts = Map.empty<Nat, V2.Contact>();
        let neutronIndex = Map.empty<Principal, Nat>();
        for ((id, contact) in Map.entries(old.contacts)) {
            let converted = convertContact(contact);
            Map.add(contacts, Nat.compare, id, converted);
            // V1 has no Neutron destination. Keep this scan here so the index
            // construction remains explicit in the lineage migration.
            for (address in converted.addresses.vals()) {
                switch (address.destination) {
                    case (#neutron(principal)) {
                        Map.add(neutronIndex, Principal.compare, principal, id);
                    };
                    case (_) {};
                };
            };
        };
        {
            var next_contact_id = old.next_contact_id;
            var next_address_id = old.next_address_id;
            var revision = old.revision;
            contacts;
            neutron_index = neutronIndex;
        };
    };

    func convertContact(contact : V1.Contact) : V2.Contact {
        {
            id = contact.id;
            revision = contact.revision;
            kind = contact.kind;
            name = contact.name;
            notes = contact.notes;
            addresses = Array.map<V1.Address, V2.Address>(contact.addresses, convertAddress);
            created_at = contact.created_at;
            updated_at = contact.updated_at;
        };
    };

    func convertAddress(address : V1.Address) : V2.Address {
        {
            id = address.id;
            address_label = address.address_label;
            destination = switch (address.destination) {
                case (#internet_computer(value)) #internet_computer(value);
                case (#bitcoin_mainnet(value)) #bitcoin_mainnet(value);
                case (#dogecoin_mainnet(value)) #dogecoin_mainnet(value);
                case (#ethereum_mainnet(value)) #ethereum_mainnet(value);
                case (#solana_mainnet(value)) #solana_mainnet(value);
            };
            preferred = address.preferred;
        };
    };
};
