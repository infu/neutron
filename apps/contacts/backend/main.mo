import Array "mo:core/Array";
import Char "mo:core/Char";
import Iter "mo:core/Iter";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Set "mo:core/Set";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Memory "./memory/contacts/v2";

module {
    let MAX_CONTACTS = 2_000;
    let MAX_ADDRESSES = 20;
    let MAX_NAME_CHARS = 120;
    let MAX_NOTES_BYTES = 8_192;
    let MAX_LABEL_CHARS = 64;
    let MAX_ADDRESS_CHARS = 128;
    let MAX_QUERY_CHARS = 120;
    let MAX_PAGE = 50;

    public type ContactKindV1 = {
        #person;
        #self;
    };

    // Keep the V1 destination contract intact for contacts_discover_v1. Wallet
    // depends on this exact type even after Contacts moves its owner API to V2.

    public type DestinationKindV1 = {
        #internet_computer;
        #bitcoin_mainnet;
        #dogecoin_mainnet;
        #ethereum_mainnet;
        #solana_mainnet;
    };

    public type DestinationV1 = {
        #internet_computer : {
            owner : Principal;
            subaccount : ?Blob;
        };
        #bitcoin_mainnet : Text;
        #dogecoin_mainnet : Text;
        #ethereum_mainnet : Text;
        #solana_mainnet : Text;
    };

    public type ContactAddressV1 = {
        id : Nat;
        address_label : ?Text;
        destination : DestinationV1;
        preferred : Bool;
    };

    public type ContactAddressInputV1 = {
        id : ?Nat;
        address_label : ?Text;
        destination : DestinationV1;
        preferred : Bool;
    };

    public type ContactV1 = {
        id : Nat;
        revision : Nat;
        kind : ContactKindV1;
        name : Text;
        notes : Text;
        addresses : [ContactAddressV1];
        created_at : Int;
        updated_at : Int;
    };

    public type ContactErrorV1 = {
        #validation : Text;
        #not_found : Nat;
        #conflict : {
            expected : Nat;
            actual : Nat;
        };
        #limit : Text;
    };

    public type DestinationKindV2 = {
        #neutron;
        #internet_computer;
        #bitcoin_mainnet;
        #dogecoin_mainnet;
        #ethereum_mainnet;
        #solana_mainnet;
    };

    public type DestinationV2 = {
        #neutron : Principal;
        #internet_computer : {
            owner : Principal;
            subaccount : ?Blob;
        };
        #bitcoin_mainnet : Text;
        #dogecoin_mainnet : Text;
        #ethereum_mainnet : Text;
        #solana_mainnet : Text;
    };

    public type ContactAddressV2 = {
        id : Nat;
        address_label : ?Text;
        destination : DestinationV2;
        preferred : Bool;
    };

    public type ContactAddressInputV2 = {
        id : ?Nat;
        address_label : ?Text;
        destination : DestinationV2;
        preferred : Bool;
    };

    public type ContactV2 = {
        id : Nat;
        revision : Nat;
        kind : ContactKindV1;
        name : Text;
        notes : Text;
        addresses : [ContactAddressV2];
        created_at : Int;
        updated_at : Int;
    };

    public type ContactErrorV2 = {
        #validation : Text;
        #not_found : Nat;
        #conflict : {
            expected : Nat;
            actual : Nat;
        };
        #neutron_conflict : {
            principal : Principal;
            contact_id : Nat;
            contact_name : Text;
        };
        #limit : Text;
    };

    public type ContactRevisionV1 = {
        revision : Nat;
    };

    public type SearchContactsRequestV2 = {
        search_text : Text;
        kind : ?ContactKindV1;
        destination_kind : ?DestinationKindV2;
        offset : Nat;
        limit : Nat;
    };

    public type ContactSummaryV2 = {
        id : Nat;
        revision : Nat;
        kind : ContactKindV1;
        name : Text;
        address_count : Nat;
        destination_kinds : [DestinationKindV2];
        updated_at : Int;
    };

    public type SearchContactsPageV2 = {
        book_revision : Nat;
        contacts : [ContactSummaryV2];
        total : Nat;
        next_offset : ?Nat;
    };

    public type SearchContactsResultV2 = {
        #ok : SearchContactsPageV2;
        #err : ContactErrorV2;
    };

    public type DiscoverContactsRequestV2 = {
        contact_id : ?Nat;
        search_text : Text;
        destination_kinds : [DestinationKindV2];
        offset : Nat;
        limit : Nat;
    };

    public type ContactDestinationV2 = {
        contact_id : Nat;
        contact_revision : Nat;
        contact_kind : ContactKindV1;
        contact_name : Text;
        address : ContactAddressV2;
    };

    public type DiscoverContactsPageV2 = {
        book_revision : Nat;
        destinations : [ContactDestinationV2];
        total : Nat;
        next_offset : ?Nat;
    };

    public type DiscoverContactsResultV2 = {
        #ok : DiscoverContactsPageV2;
        #err : ContactErrorV2;
    };

    public type DiscoverContactsRequestV1 = {
        contact_id : ?Nat;
        search_text : Text;
        destination_kinds : [DestinationKindV1];
        offset : Nat;
        limit : Nat;
    };

    public type ContactDestinationV1 = {
        contact_id : Nat;
        contact_revision : Nat;
        contact_kind : ContactKindV1;
        contact_name : Text;
        address : ContactAddressV1;
    };

    public type DiscoverContactsPageV1 = {
        book_revision : Nat;
        destinations : [ContactDestinationV1];
        total : Nat;
        next_offset : ?Nat;
    };

    public type DiscoverContactsResultV1 = {
        #ok : DiscoverContactsPageV1;
        #err : ContactErrorV1;
    };

    public type SaveContactRequestV2 = {
        id : ?Nat;
        expected_revision : ?Nat;
        kind : ContactKindV1;
        name : Text;
        notes : Text;
        addresses : [ContactAddressInputV2];
    };

    public type SaveContactSuccessV2 = {
        book_revision : Nat;
        contact : ContactV2;
        duplicate_contact_ids : [Nat];
    };

    public type SaveContactResultV2 = {
        #ok : SaveContactSuccessV2;
        #err : ContactErrorV2;
    };

    public type RemoveContactRequestV2 = {
        id : Nat;
        expected_revision : Nat;
    };

    public type RemoveContactSuccessV2 = {
        id : Nat;
        book_revision : Nat;
    };

    public type RemoveContactResultV2 = {
        #ok : RemoveContactSuccessV2;
        #err : ContactErrorV2;
    };

    public type NeutronContactMatchV2 = {
        contact_id : Nat;
        contact_revision : Nat;
        contact_name : Text;
        principal : Principal;
    };

    public type NeutronContactLookupV2 = {
        book_revision : Nat;
        integrity_ok : Bool;
        match : ?NeutronContactMatchV2;
    };

    public type DiscoverNeutronContactsRequestV2 = {
        search_text : Text;
        offset : Nat;
        limit : Nat;
    };

    public type DiscoverNeutronContactsPageV2 = {
        book_revision : Nat;
        contacts : [NeutronContactMatchV2];
        total : Nat;
        next_offset : ?Nat;
    };

    public type DiscoverNeutronContactsResultV2 = {
        #ok : DiscoverNeutronContactsPageV2;
        #err : ContactErrorV2;
    };

    type BuildContactResult = {
        #ok : {
            contact : Memory.Contact;
            next_address_id : Nat;
        };
        #err : ContactErrorV2;
    };

    type NeutronState = {
        #none;
        #one : Principal;
        #conflict;
    };

    public type AppBackendEnvironment = {
        stable_memory : {
            contacts : Memory.Mem;
        };
    };

    public class Init(env : AppBackendEnvironment) {
        let mem = env.stable_memory.contacts;

        // Mail performs this exact lookup on its public receive path.  A full
        // book integrity scan for every sender would therefore turn Contacts'
        // bounded 2,000-entry book into an ingress amplification primitive.
        //
        // The book revision changes atomically with every supported mutation,
        // so one complete proof remains valid for that revision.  This cache
        // is intentionally transient: an upgrade constructs Init again and
        // proves the migrated stable state before trusting the index.
        var neutron_integrity_revision : ?Nat = null;
        var neutron_integrity_ok = false;

        func cachedNeutronIndexIntegrity() : Bool {
            if (neutron_integrity_revision == ?mem.revision) {
                return neutron_integrity_ok;
            };
            neutron_integrity_ok := neutronIndexIntegrity(mem);
            neutron_integrity_revision := ?mem.revision;
            neutron_integrity_ok;
        };

        public func /*query*/contacts_revision(()) : ContactRevisionV1 {
            { revision = mem.revision };
        };

        public func /*query*/contacts_search(
            request : SearchContactsRequestV2,
        ) : SearchContactsResultV2 {
            switch (validatePageV2(request.search_text, request.offset, request.limit)) {
                case (?error) return #err(error);
                case null {};
            };

            let searchText = Text.toLower(request.search_text);
            let matches = List.empty<ContactSummaryV2>();
            for (contact in Map.values(mem.contacts)) {
                if (matchesSearch(contact, searchText, request.kind, request.destination_kind)) {
                    List.add(matches, toSummary(contact));
                };
            };
            let sorted = Array.sort<ContactSummaryV2>(
                List.toArray(matches),
                compareSummaries,
            );
            #ok(pageSummaries(mem.revision, sorted, request.offset, request.limit));
        };

        public func /*query*/contacts_get(request : { id : Nat }) : ?ContactV2 {
            switch (Map.get(mem.contacts, Nat.compare, request.id)) {
                case (?contact) ?toContactView(contact);
                case null null;
            };
        };

        public func /*query*/contacts_resolve(
            request : DiscoverContactsRequestV2,
        ) : DiscoverContactsResultV2 {
            discoverV2(mem, request);
        };

        public func /*update*/contacts_save(
            request : SaveContactRequestV2,
        ) : SaveContactResultV2 {
            let current : ?Memory.Contact = switch (request.id) {
                case (?id) {
                    switch (Map.get(mem.contacts, Nat.compare, id)) {
                        case (?contact) ?contact;
                        case null return #err(#not_found(id));
                    };
                };
                case null null;
            };

            switch ((current, request.expected_revision)) {
                case (null, null) {};
                case (null, ?_) return #err(#validation("A new contact cannot have an expected revision"));
                case (?contact, ?expected) {
                    if (contact.revision != expected) {
                        return #err(#conflict({ expected; actual = contact.revision }));
                    };
                };
                case (?_, null) return #err(#validation("An existing contact requires an expected revision"));
            };

            let isNew = switch (current) {
                case null true;
                case (?_) false;
            };
            if (isNew and Map.size(mem.contacts) >= MAX_CONTACTS) {
                return #err(#limit("Contact limit reached"));
            };

            let contactId = switch (current) {
                case (?contact) contact.id;
                case null mem.next_contact_id;
            };
            switch (current) {
                case (?contact) {
                    switch (validateStoredNeutronMapping(mem, contact)) {
                        case (?error) return #err(error);
                        case null {};
                    };
                };
                case null {};
            };
            switch (buildContact(contactId, current, request, mem.next_address_id)) {
                case (#err(error)) #err(error);
                case (#ok(built)) {
                    switch (validateNeutronIndexForSave(mem, contactId, built.contact)) {
                        case (?error) return #err(error);
                        case null {};
                    };
                    let previousNeutron = switch (current) {
                        case (?contact) singleNeutronPrincipal(contact);
                        case null null;
                    };
                    let nextNeutron = singleNeutronPrincipal(built.contact);
                    switch (previousNeutron) {
                        case (?principal) {
                            if (nextNeutron != ?principal) {
                                Map.remove(mem.neutron_index, Principal.compare, principal);
                            };
                        };
                        case null {};
                    };
                    switch (nextNeutron) {
                        case (?principal) Map.add(mem.neutron_index, Principal.compare, principal, contactId);
                        case null {};
                    };
                    Map.add(mem.contacts, Nat.compare, contactId, built.contact);
                    mem.next_address_id := built.next_address_id;
                    if (isNew) mem.next_contact_id += 1;
                    mem.revision += 1;
                    #ok({
                        book_revision = mem.revision;
                        contact = toContactView(built.contact);
                        duplicate_contact_ids = duplicateContactIds(mem, built.contact);
                    });
                };
            };
        };

        public func /*update*/contacts_remove(
            request : RemoveContactRequestV2,
        ) : RemoveContactResultV2 {
            let ?contact = Map.get(mem.contacts, Nat.compare, request.id) else {
                return #err(#not_found(request.id));
            };
            if (contact.revision != request.expected_revision) {
                return #err(#conflict({
                    expected = request.expected_revision;
                    actual = contact.revision;
                }));
            };
            switch (validateStoredNeutronMapping(mem, contact)) {
                case (?error) return #err(error);
                case null {};
            };
            switch (singleNeutronPrincipal(contact)) {
                case (?principal) Map.remove(mem.neutron_index, Principal.compare, principal);
                case null {};
            };
            Map.remove(mem.contacts, Nat.compare, request.id);
            mem.revision += 1;
            #ok({ id = request.id; book_revision = mem.revision });
        };

        public func /*internal:apps*/contacts_discover_v1(
            request : DiscoverContactsRequestV1,
        ) : DiscoverContactsResultV1 {
            discoverV1(mem, request);
        };

        public func /*internal:apps*/contacts_neutron_lookup_v2(
            request : { principal : Principal },
        ) : NeutronContactLookupV2 {
            let integrityOk = cachedNeutronIndexIntegrity();
            {
                book_revision = mem.revision;
                integrity_ok = integrityOk;
                match = if (integrityOk) {
                    indexedNeutronMatch(mem, request.principal);
                } else null;
            };
        };

        public func /*internal:apps*/contacts_neutron_search_v2(
            request : DiscoverNeutronContactsRequestV2,
        ) : DiscoverNeutronContactsResultV2 {
            discoverNeutronContacts(mem, request, cachedNeutronIndexIntegrity());
        };

        public func /*internal:apps*/contacts_neutron_revision_v2(()) : Nat {
            mem.revision;
        };
    };

    func discoverV1(
        mem : Memory.Mem,
        request : DiscoverContactsRequestV1,
    ) : DiscoverContactsResultV1 {
        switch (validatePageV1(request.search_text, request.offset, request.limit)) {
            case (?error) return #err(error);
            case null {};
        };
        if (request.destination_kinds.size() == 0) {
            return #err(#validation("At least one destination kind is required"));
        };
        if (request.destination_kinds.size() > 5 or hasDuplicateKindsV1(request.destination_kinds)) {
            return #err(#validation("Destination kinds are invalid"));
        };

        let searchText = Text.toLower(request.search_text);
        let matches = List.empty<ContactDestinationV1>();
        for (contact in Map.values(mem.contacts)) {
            let idMatches = switch (request.contact_id) {
                case (?id) contact.id == id;
                case null true;
            };
            if (idMatches and matchesTextV1(contact, searchText)) {
                for (address in contact.addresses.vals()) {
                    switch (destinationKindV1(address.destination), toAddressViewV1(address)) {
                        case (?kind, ?view) {
                            if (containsKindV1(request.destination_kinds, kind)) {
                                List.add(matches, {
                                    contact_id = contact.id;
                                    contact_revision = contact.revision;
                                    contact_kind = contact.kind;
                                    contact_name = contact.name;
                                    address = view;
                                });
                            };
                        };
                        case (_) {};
                    };
                };
            };
        };
        let sorted = Array.sort<ContactDestinationV1>(
            List.toArray(matches),
            compareDestinations,
        );
        #ok(pageDestinations(mem.revision, sorted, request.offset, request.limit));
    };

    func discoverV2(
        mem : Memory.Mem,
        request : DiscoverContactsRequestV2,
    ) : DiscoverContactsResultV2 {
        switch (validatePageV2(request.search_text, request.offset, request.limit)) {
            case (?error) return #err(error);
            case null {};
        };
        if (request.destination_kinds.size() == 0) {
            return #err(#validation("At least one destination kind is required"));
        };
        if (request.destination_kinds.size() > 6 or hasDuplicateKindsV2(request.destination_kinds)) {
            return #err(#validation("Destination kinds are invalid"));
        };

        let searchText = Text.toLower(request.search_text);
        let matches = List.empty<ContactDestinationV2>();
        for (contact in Map.values(mem.contacts)) {
            let idMatches = switch (request.contact_id) {
                case (?id) contact.id == id;
                case null true;
            };
            if (idMatches and matchesText(contact, searchText)) {
                for (address in contact.addresses.vals()) {
                    if (containsKindV2(request.destination_kinds, destinationKindV2(address.destination))) {
                        List.add(matches, {
                            contact_id = contact.id;
                            contact_revision = contact.revision;
                            contact_kind = contact.kind;
                            contact_name = contact.name;
                            address = toAddressView(address);
                        });
                    };
                };
            };
        };
        let sorted = Array.sort<ContactDestinationV2>(
            List.toArray(matches),
            compareDestinationsV2,
        );
        #ok(pageDestinationsV2(mem.revision, sorted, request.offset, request.limit));
    };

    func buildContact(
        contactId : Nat,
        current : ?Memory.Contact,
        request : SaveContactRequestV2,
        initialNextAddressId : Nat,
    ) : BuildContactResult {
        let name = Text.trim(request.name, #char ' ');
        if (name.size() == 0 or name.size() > MAX_NAME_CHARS) {
            return #err(#validation("Contact name must contain 1 to 120 characters"));
        };
        if (hasUnsafeControls(name, false)) {
            return #err(#validation("Contact name contains unsupported control characters"));
        };
        if (Text.encodeUtf8(request.notes).size() > MAX_NOTES_BYTES) {
            return #err(#limit("Contact notes exceed 8 KiB"));
        };
        if (hasUnsafeControls(request.notes, true)) {
            return #err(#validation("Contact notes contain unsupported control characters"));
        };
        if (request.addresses.size() > MAX_ADDRESSES) {
            return #err(#limit("A contact cannot have more than 20 addresses"));
        };

        var nextAddressId = initialNextAddressId;
        var hasNeutron = false;
        let addresses = List.empty<Memory.Address>();
        let usedIds = Set.empty<Nat>();
        for (input in request.addresses.vals()) {
            let id = switch (input.id) {
                case (?id) {
                    let ?existing = current else {
                        return #err(#validation("A new contact address cannot have an id"));
                    };
                    if (not hasAddressId(existing, id)) {
                        return #err(#validation("Address id does not belong to this contact"));
                    };
                    id;
                };
                case null {
                    let id = nextAddressId;
                    nextAddressId += 1;
                    id;
                };
            };
            if (not Set.insert(usedIds, Nat.compare, id)) {
                return #err(#validation("Contact contains a duplicate address id"));
            };

            let addressLabel = normalizeLabel(input.address_label);
            switch (addressLabel) {
                case (#err(error)) return #err(error);
                case (#ok(normalizedLabel)) {
                    switch (normalizeDestination(input.destination)) {
                        case (#err(error)) return #err(error);
                        case (#ok(destination)) {
                            switch (destination) {
                                case (#neutron(_)) {
                                    if (hasNeutron) {
                                        return #err(#validation("A contact can have only one Neutron address"));
                                    };
                                    if (input.preferred) {
                                        return #err(#validation("A Neutron address cannot be marked preferred"));
                                    };
                                    hasNeutron := true;
                                };
                                case (_) {};
                            };
                            for (address in List.values(addresses)) {
                                if (address.destination == destination) {
                                    return #err(#validation("Contact contains a duplicate destination"));
                                };
                                if (
                                    input.preferred and address.preferred and
                                    destinationKindV2(address.destination) == destinationKindV2(destination)
                                ) {
                                    return #err(#validation("Only one preferred address is allowed per network"));
                                };
                            };
                            List.add(addresses, {
                                id;
                                address_label = normalizedLabel;
                                destination;
                                preferred = input.preferred;
                            });
                        };
                    };
                };
            };
        };

        let now = Time.now();
        let revision = switch (current) {
            case (?contact) contact.revision + 1;
            case null 1;
        };
        let createdAt = switch (current) {
            case (?contact) contact.created_at;
            case null now;
        };
        #ok({
            next_address_id = nextAddressId;
            contact = {
                id = contactId;
                revision;
                kind = request.kind;
                name;
                notes = request.notes;
                addresses = List.toArray(addresses);
                created_at = createdAt;
                updated_at = now;
            };
        });
    };

    func normalizeLabel(value : ?Text) : { #ok : ?Text; #err : ContactErrorV2 } {
        switch (value) {
            case null #ok(null);
            case (?raw) {
                let addressLabel = Text.trim(raw, #char ' ');
                if (addressLabel.size() == 0) return #ok(null);
                if (addressLabel.size() > MAX_LABEL_CHARS) {
                    return #err(#limit("Address label exceeds 64 characters"));
                };
                if (hasUnsafeControls(addressLabel, false)) {
                    return #err(#validation("Address label contains unsupported control characters"));
                };
                #ok(?addressLabel);
            };
        };
    };

    func normalizeDestination(
        value : DestinationV2,
    ) : { #ok : Memory.Destination; #err : ContactErrorV2 } {
        switch (value) {
            case (#neutron(principal)) {
                if (not Principal.isCanister(principal)) {
                    return #err(#validation("Neutron address must be a canister principal"));
                };
                #ok(#neutron(principal));
            };
            case (#internet_computer(account)) {
                if (Principal.isAnonymous(account.owner)) {
                    return #err(#validation("Anonymous is not a valid contact account"));
                };
                let subaccount = switch (account.subaccount) {
                    case null null;
                    case (?blob) {
                        if (blob.size() != 32) {
                            return #err(#validation("An ICRC subaccount must contain exactly 32 bytes"));
                        };
                        if (isZeroBlob(blob)) null else ?blob;
                    };
                };
                #ok(#internet_computer({ owner = account.owner; subaccount }));
            };
            case (#bitcoin_mainnet(raw)) {
                let address = Text.trim(raw, #char ' ');
                if (not validBitcoin(address)) {
                    return #err(#validation("Bitcoin address has an invalid mainnet format"));
                };
                #ok(#bitcoin_mainnet(if (Text.startsWith(Text.toLower(address), #text "bc1")) Text.toLower(address) else address));
            };
            case (#dogecoin_mainnet(raw)) {
                let address = Text.trim(raw, #char ' ');
                if (not validDogecoin(address)) {
                    return #err(#validation("Dogecoin address has an invalid mainnet format"));
                };
                #ok(#dogecoin_mainnet(address));
            };
            case (#ethereum_mainnet(raw)) {
                let address = Text.trim(raw, #char ' ');
                if (not validEthereum(address)) {
                    return #err(#validation("Ethereum address has an invalid mainnet format"));
                };
                #ok(#ethereum_mainnet(address));
            };
            case (#solana_mainnet(raw)) {
                let address = Text.trim(raw, #char ' ');
                if (not validSolana(address)) {
                    return #err(#validation("Solana address has an invalid mainnet format"));
                };
                #ok(#solana_mainnet(address));
            };
        };
    };

    func validatePageV1(searchText : Text, _offset : Nat, limit : Nat) : ?ContactErrorV1 {
        if (searchText.size() > MAX_QUERY_CHARS) return ?#limit("Search query exceeds 120 characters");
        if (hasUnsafeControls(searchText, false)) return ?#validation("Search query contains unsupported control characters");
        if (limit == 0 or limit > MAX_PAGE) return ?#validation("Page limit must be between 1 and 50");
        null;
    };

    func validatePageV2(searchText : Text, _offset : Nat, limit : Nat) : ?ContactErrorV2 {
        if (searchText.size() > MAX_QUERY_CHARS) return ?#limit("Search query exceeds 120 characters");
        if (hasUnsafeControls(searchText, false)) return ?#validation("Search query contains unsupported control characters");
        if (limit == 0 or limit > MAX_PAGE) return ?#validation("Page limit must be between 1 and 50");
        null;
    };

    func matchesSearch(
        contact : Memory.Contact,
        searchText : Text,
        kind : ?ContactKindV1,
        destinationKindFilter : ?DestinationKindV2,
    ) : Bool {
        switch (kind) {
            case (?value) if (contact.kind != value) return false;
            case null {};
        };
        switch (destinationKindFilter) {
            case (?value) if (not hasDestinationKindV2(contact, value)) return false;
            case null {};
        };
        matchesText(contact, searchText);
    };

    func matchesText(contact : Memory.Contact, searchText : Text) : Bool {
        if (searchText.size() == 0) return true;
        if (containsLower(contact.name, searchText) or containsLower(contact.notes, searchText)) return true;
        for (address in contact.addresses.vals()) {
            switch (address.address_label) {
                case (?addressLabel) if (containsLower(addressLabel, searchText)) return true;
                case null {};
            };
            if (containsLower(destinationText(address.destination), searchText)) return true;
        };
        false;
    };

    func matchesTextV1(contact : Memory.Contact, searchText : Text) : Bool {
        if (searchText.size() == 0) return true;
        if (containsLower(contact.name, searchText) or containsLower(contact.notes, searchText)) return true;
        for (address in contact.addresses.vals()) {
            switch (destinationKindV1(address.destination)) {
                case null {};
                case (?_) {
                    switch (address.address_label) {
                        case (?addressLabel) if (containsLower(addressLabel, searchText)) return true;
                        case null {};
                    };
                    if (containsLower(destinationText(address.destination), searchText)) return true;
                };
            };
        };
        false;
    };

    func containsLower(value : Text, searchText : Text) : Bool {
        Text.contains(Text.toLower(value), #text searchText);
    };

    func destinationText(destination : Memory.Destination) : Text {
        switch (destination) {
            case (#neutron(principal)) Principal.toText(principal);
            case (#internet_computer(account)) Principal.toText(account.owner);
            case (#bitcoin_mainnet(value)) value;
            case (#dogecoin_mainnet(value)) value;
            case (#ethereum_mainnet(value)) value;
            case (#solana_mainnet(value)) value;
        };
    };

    func destinationKindV1(destination : Memory.Destination) : ?DestinationKindV1 {
        switch (destination) {
            case (#neutron(_)) null;
            case (#internet_computer(_)) ?#internet_computer;
            case (#bitcoin_mainnet(_)) ?#bitcoin_mainnet;
            case (#dogecoin_mainnet(_)) ?#dogecoin_mainnet;
            case (#ethereum_mainnet(_)) ?#ethereum_mainnet;
            case (#solana_mainnet(_)) ?#solana_mainnet;
        };
    };

    func destinationKindV2(destination : Memory.Destination) : DestinationKindV2 {
        switch (destination) {
            case (#neutron(_)) #neutron;
            case (#internet_computer(_)) #internet_computer;
            case (#bitcoin_mainnet(_)) #bitcoin_mainnet;
            case (#dogecoin_mainnet(_)) #dogecoin_mainnet;
            case (#ethereum_mainnet(_)) #ethereum_mainnet;
            case (#solana_mainnet(_)) #solana_mainnet;
        };
    };

    func hasDestinationKindV2(contact : Memory.Contact, kind : DestinationKindV2) : Bool {
        for (address in contact.addresses.vals()) {
            if (destinationKindV2(address.destination) == kind) return true;
        };
        false;
    };

    func destinationKindsV2(contact : Memory.Contact) : [DestinationKindV2] {
        let kinds = List.empty<DestinationKindV2>();
        let ordered : [DestinationKindV2] = [
            #neutron,
            #internet_computer,
            #bitcoin_mainnet,
            #dogecoin_mainnet,
            #ethereum_mainnet,
            #solana_mainnet,
        ];
        for (kind in ordered.vals()) {
            if (hasDestinationKindV2(contact, kind)) List.add(kinds, kind);
        };
        List.toArray(kinds);
    };

    func containsKindV1(kinds : [DestinationKindV1], target : DestinationKindV1) : Bool {
        for (kind in kinds.vals()) if (kind == target) return true;
        false;
    };

    func containsKindV2(kinds : [DestinationKindV2], target : DestinationKindV2) : Bool {
        for (kind in kinds.vals()) if (kind == target) return true;
        false;
    };

    func hasDuplicateKindsV1(kinds : [DestinationKindV1]) : Bool {
        var index = 0;
        while (index < kinds.size()) {
            var other = index + 1;
            while (other < kinds.size()) {
                if (kinds[index] == kinds[other]) return true;
                other += 1;
            };
            index += 1;
        };
        false;
    };

    func hasDuplicateKindsV2(kinds : [DestinationKindV2]) : Bool {
        var index = 0;
        while (index < kinds.size()) {
            var other = index + 1;
            while (other < kinds.size()) {
                if (kinds[index] == kinds[other]) return true;
                other += 1;
            };
            index += 1;
        };
        false;
    };

    func hasAddressId(contact : Memory.Contact, id : Nat) : Bool {
        for (address in contact.addresses.vals()) if (address.id == id) return true;
        false;
    };

    func duplicateContactIds(mem : Memory.Mem, saved : Memory.Contact) : [Nat] {
        let duplicates = Set.empty<Nat>();
        for (contact in Map.values(mem.contacts)) {
            if (contact.id != saved.id) {
                label savedAddresses for (savedAddress in saved.addresses.vals()) {
                    for (address in contact.addresses.vals()) {
                        if (savedAddress.destination == address.destination) {
                            ignore Set.insert(duplicates, Nat.compare, contact.id);
                            break savedAddresses;
                        };
                    };
                };
            };
        };
        Set.toArray(duplicates);
    };

    func neutronState(contact : Memory.Contact) : NeutronState {
        var found : ?Principal = null;
        for (address in contact.addresses.vals()) {
            switch (address.destination) {
                case (#neutron(principal)) {
                    switch (found) {
                        case null found := ?principal;
                        case (?_) return #conflict;
                    };
                };
                case (_) {};
            };
        };
        switch (found) {
            case null #none;
            case (?principal) #one(principal);
        };
    };

    func singleNeutronPrincipal(contact : Memory.Contact) : ?Principal {
        switch (neutronState(contact)) {
            case (#one(principal)) ?principal;
            case (_) null;
        };
    };

    func contactContainsNeutron(contact : Memory.Contact, principal : Principal) : Bool {
        for (address in contact.addresses.vals()) {
            switch (address.destination) {
                case (#neutron(candidate)) if (candidate == principal) return true;
                case (_) {};
            };
        };
        false;
    };

    func indexIntegrityError() : ContactErrorV2 {
        #validation("Contacts Neutron address index is inconsistent");
    };

    func validateStoredNeutronMapping(
        mem : Memory.Mem,
        contact : Memory.Contact,
    ) : ?ContactErrorV2 {
        switch (neutronState(contact)) {
            case (#conflict) return ?indexIntegrityError();
            case (#none) return null;
            case (#one(principal)) {
                switch (Map.get(mem.neutron_index, Principal.compare, principal)) {
                    case (?id) if (id == contact.id) return null;
                    case (_) return ?indexIntegrityError();
                };
            };
        };
        null;
    };

    func validateNeutronIndexForSave(
        mem : Memory.Mem,
        contactId : Nat,
        built : Memory.Contact,
    ) : ?ContactErrorV2 {
        let principal = switch (neutronState(built)) {
            case (#none) return null;
            case (#conflict) return ?#validation("A contact can have only one Neutron address");
            case (#one(value)) value;
        };
        for (contact in Map.values(mem.contacts)) {
            if (contact.id != contactId and contactContainsNeutron(contact, principal)) {
                return ?#neutron_conflict({
                    principal;
                    contact_id = contact.id;
                    contact_name = contact.name;
                });
            };
        };
        switch (Map.get(mem.neutron_index, Principal.compare, principal)) {
            case null return null;
            case (?id) {
                if (id == contactId) return null;
                switch (Map.get(mem.contacts, Nat.compare, id)) {
                    case (?contact) {
                        switch (neutronState(contact)) {
                            case (#one(candidate)) if (candidate == principal) {
                                return ?#neutron_conflict({
                                    principal;
                                    contact_id = contact.id;
                                    contact_name = contact.name;
                                });
                            };
                            case (_) return ?indexIntegrityError();
                        };
                    };
                    case null return ?indexIntegrityError();
                };
            };
        };
        null;
    };

    // Safe after neutronIndexIntegrity has been proved for mem.revision.  The
    // proof establishes uniqueness and the complete index bijection, leaving
    // only two logarithmic map reads on repeated exact lookups.
    func indexedNeutronMatch(
        mem : Memory.Mem,
        principal : Principal,
    ) : ?NeutronContactMatchV2 {
        if (not Principal.isCanister(principal)) return null;
        let ?id = Map.get(mem.neutron_index, Principal.compare, principal) else return null;
        let ?contact = Map.get(mem.contacts, Nat.compare, id) else return null;
        switch (neutronState(contact)) {
            case (#one(candidate)) if (candidate == principal) {};
            case (_) return null;
        };
        ?{
            contact_id = contact.id;
            contact_revision = contact.revision;
            contact_name = contact.name;
            principal;
        };
    };

    // This signal is intentionally computed over the complete bounded book,
    // not just the requested principal. Consumers performing destructive work
    // must be able to distinguish a healthy absence from an inconsistent
    // index that merely looks absent at one key.
    func neutronIndexIntegrity(mem : Memory.Mem) : Bool {
        if (
            Map.size(mem.contacts) > MAX_CONTACTS or
            Map.size(mem.neutron_index) > MAX_CONTACTS
        ) return false;

        let principals = Set.empty<Principal>();
        var neutronCount = 0;
        for ((storedId, contact) in Map.entries(mem.contacts)) {
            if (
                storedId != contact.id or
                contact.addresses.size() > MAX_ADDRESSES
            ) return false;
            switch (neutronState(contact)) {
                case (#conflict) return false;
                case (#none) {};
                case (#one(principal)) {
                    if (
                        not Principal.isCanister(principal) or
                        not Set.insert(principals, Principal.compare, principal)
                    ) return false;
                    switch (Map.get(mem.neutron_index, Principal.compare, principal)) {
                        case (?indexedId) if (indexedId == storedId) {};
                        case (_) return false;
                    };
                    neutronCount += 1;
                };
            };
        };
        if (neutronCount != Map.size(mem.neutron_index)) return false;

        for ((principal, indexedId) in Map.entries(mem.neutron_index)) {
            if (not Principal.isCanister(principal)) return false;
            let ?contact = Map.get(mem.contacts, Nat.compare, indexedId) else return false;
            if (contact.id != indexedId) return false;
            switch (neutronState(contact)) {
                case (#one(candidate)) if (candidate == principal) {};
                case (_) return false;
            };
        };
        true;
    };

    func discoverNeutronContacts(
        mem : Memory.Mem,
        request : DiscoverNeutronContactsRequestV2,
        integrityOk : Bool,
    ) : DiscoverNeutronContactsResultV2 {
        switch (validatePageV2(request.search_text, request.offset, request.limit)) {
            case (?error) return #err(error);
            case null {};
        };
        if (not integrityOk) return #err(indexIntegrityError());
        let counts = Map.empty<Principal, Nat>();
        for (contact in Map.values(mem.contacts)) {
            switch (neutronState(contact)) {
                case (#one(principal)) {
                    let count = switch (Map.get(counts, Principal.compare, principal)) {
                        case null 0;
                        case (?value) value;
                    };
                    Map.add(counts, Principal.compare, principal, count + 1);
                };
                case (_) {};
            };
        };

        let searchText = Text.toLower(request.search_text);
        let matches = List.empty<NeutronContactMatchV2>();
        for (contact in Map.values(mem.contacts)) {
            switch (neutronState(contact)) {
                case (#one(principal)) {
                    let unique = Map.get(counts, Principal.compare, principal) == ?1;
                    let indexed = Map.get(mem.neutron_index, Principal.compare, principal) == ?contact.id;
                    let searchable = searchText.size() == 0 or
                        containsLower(contact.name, searchText) or
                        containsLower(Principal.toText(principal), searchText);
                    if (unique and indexed and searchable) {
                        List.add(matches, {
                            contact_id = contact.id;
                            contact_revision = contact.revision;
                            contact_name = contact.name;
                            principal;
                        });
                    };
                };
                case (_) {};
            };
        };
        let sorted = Array.sort<NeutronContactMatchV2>(
            List.toArray(matches),
            compareNeutronMatches,
        );
        #ok(pageNeutronContacts(mem.revision, sorted, request.offset, request.limit));
    };

    func toContactView(contact : Memory.Contact) : ContactV2 {
        {
            id = contact.id;
            revision = contact.revision;
            kind = contact.kind;
            name = contact.name;
            notes = contact.notes;
            addresses = Array.map<Memory.Address, ContactAddressV2>(contact.addresses, toAddressView);
            created_at = contact.created_at;
            updated_at = contact.updated_at;
        };
    };

    func toAddressView(address : Memory.Address) : ContactAddressV2 {
        {
            id = address.id;
            address_label = address.address_label;
            destination = address.destination;
            preferred = address.preferred;
        };
    };

    func toAddressViewV1(address : Memory.Address) : ?ContactAddressV1 {
        let destination : DestinationV1 = switch (address.destination) {
            case (#neutron(_)) return null;
            case (#internet_computer(value)) #internet_computer(value);
            case (#bitcoin_mainnet(value)) #bitcoin_mainnet(value);
            case (#dogecoin_mainnet(value)) #dogecoin_mainnet(value);
            case (#ethereum_mainnet(value)) #ethereum_mainnet(value);
            case (#solana_mainnet(value)) #solana_mainnet(value);
        };
        ?{
            id = address.id;
            address_label = address.address_label;
            destination;
            preferred = address.preferred;
        };
    };

    func toSummary(contact : Memory.Contact) : ContactSummaryV2 {
        {
            id = contact.id;
            revision = contact.revision;
            kind = contact.kind;
            name = contact.name;
            address_count = contact.addresses.size();
            destination_kinds = destinationKindsV2(contact);
            updated_at = contact.updated_at;
        };
    };

    func compareSummaries(left : ContactSummaryV2, right : ContactSummaryV2) : { #less; #equal; #greater } {
        switch (Text.compare(Text.toLower(left.name), Text.toLower(right.name))) {
            case (#equal) Nat.compare(left.id, right.id);
            case order order;
        };
    };

    func compareDestinations(left : ContactDestinationV1, right : ContactDestinationV1) : { #less; #equal; #greater } {
        switch (Text.compare(Text.toLower(left.contact_name), Text.toLower(right.contact_name))) {
            case (#equal) Nat.compare(left.address.id, right.address.id);
            case order order;
        };
    };

    func compareDestinationsV2(left : ContactDestinationV2, right : ContactDestinationV2) : { #less; #equal; #greater } {
        switch (Text.compare(Text.toLower(left.contact_name), Text.toLower(right.contact_name))) {
            case (#equal) Nat.compare(left.address.id, right.address.id);
            case order order;
        };
    };

    func compareNeutronMatches(left : NeutronContactMatchV2, right : NeutronContactMatchV2) : { #less; #equal; #greater } {
        switch (Text.compare(Text.toLower(left.contact_name), Text.toLower(right.contact_name))) {
            case (#equal) Nat.compare(left.contact_id, right.contact_id);
            case order order;
        };
    };

    func pageSummaries(
        revision : Nat,
        values : [ContactSummaryV2],
        offset : Nat,
        limit : Nat,
    ) : SearchContactsPageV2 {
        let total = values.size();
        if (offset >= total) {
            return { book_revision = revision; contacts = []; total; next_offset = null };
        };
        let end = min(total, offset + limit);
        {
            book_revision = revision;
            contacts = Array.tabulate<ContactSummaryV2>(end - offset, func(index) { values[offset + index] });
            total;
            next_offset = if (end < total) ?end else null;
        };
    };

    func pageDestinations(
        revision : Nat,
        values : [ContactDestinationV1],
        offset : Nat,
        limit : Nat,
    ) : DiscoverContactsPageV1 {
        let total = values.size();
        if (offset >= total) {
            return { book_revision = revision; destinations = []; total; next_offset = null };
        };
        let end = min(total, offset + limit);
        {
            book_revision = revision;
            destinations = Array.tabulate<ContactDestinationV1>(end - offset, func(index) { values[offset + index] });
            total;
            next_offset = if (end < total) ?end else null;
        };
    };

    func pageDestinationsV2(
        revision : Nat,
        values : [ContactDestinationV2],
        offset : Nat,
        limit : Nat,
    ) : DiscoverContactsPageV2 {
        let total = values.size();
        if (offset >= total) {
            return { book_revision = revision; destinations = []; total; next_offset = null };
        };
        let end = min(total, offset + limit);
        {
            book_revision = revision;
            destinations = Array.tabulate<ContactDestinationV2>(end - offset, func(index) { values[offset + index] });
            total;
            next_offset = if (end < total) ?end else null;
        };
    };

    func pageNeutronContacts(
        revision : Nat,
        values : [NeutronContactMatchV2],
        offset : Nat,
        limit : Nat,
    ) : DiscoverNeutronContactsPageV2 {
        let total = values.size();
        if (offset >= total) {
            return { book_revision = revision; contacts = []; total; next_offset = null };
        };
        let end = min(total, offset + limit);
        {
            book_revision = revision;
            contacts = Array.tabulate<NeutronContactMatchV2>(end - offset, func(index) { values[offset + index] });
            total;
            next_offset = if (end < total) ?end else null;
        };
    };

    func min(left : Nat, right : Nat) : Nat {
        if (left < right) left else right;
    };

    func isZeroBlob(value : Blob) : Bool {
        for (byte in value.vals()) if (byte != 0) return false;
        true;
    };

    func hasUnsafeControls(value : Text, allowLineWhitespace : Bool) : Bool {
        for (char in value.chars()) {
            let code = Char.toNat32(char);
            if (code < 32) {
                if (not allowLineWhitespace or (code != 9 and code != 10 and code != 13)) return true;
            };
            if (
                (code >= 127 and code <= 159) or
                (code >= 0x200B and code <= 0x200F) or
                (code >= 0x202A and code <= 0x202E) or
                (code >= 0x2060 and code <= 0x206F) or
                code == 0xFEFF
            ) return true;
        };
        false;
    };

    func validBitcoin(value : Text) : Bool {
        if (value.size() < 14 or value.size() > 90 or not isVisibleAscii(value)) return false;
        let lower = Text.toLower(value);
        if (Text.startsWith(lower, #text "bc1")) {
            if (value != lower and value != Text.toUpper(value)) return false;
            return allChars(lower, "023456789acdefghjklmnpqrstuvwxyz1");
        };
        if (value.size() < 26 or value.size() > 35) return false;
        if (not Text.startsWith(value, #char '1') and not Text.startsWith(value, #char '3')) return false;
        allChars(value, BASE58_ALPHABET);
    };

    func validDogecoin(value : Text) : Bool {
        if (value.size() < 25 or value.size() > 50 or not isVisibleAscii(value)) return false;
        if (
            not Text.startsWith(value, #char 'D') and
            not Text.startsWith(value, #char 'A') and
            not Text.startsWith(value, #char '9')
        ) return false;
        allChars(value, BASE58_ALPHABET);
    };

    func validEthereum(value : Text) : Bool {
        if (value.size() != 42 or not Text.startsWith(value, #text "0x")) return false;
        let body = Text.trimStart(value, #text "0x");
        if (body.size() != 40 or not allChars(body, "0123456789abcdefABCDEF")) return false;
        var nonzero = false;
        for (char in body.chars()) if (char != '0') nonzero := true;
        nonzero;
    };

    func validSolana(value : Text) : Bool {
        value.size() >= 32 and value.size() <= 44 and isVisibleAscii(value) and allChars(value, BASE58_ALPHABET);
    };

    let BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

    func allChars(value : Text, alphabet : Text) : Bool {
        for (char in value.chars()) {
            if (not Text.contains(alphabet, #char char)) return false;
        };
        true;
    };

    func isVisibleAscii(value : Text) : Bool {
        if (value.size() > MAX_ADDRESS_CHARS) return false;
        for (char in value.chars()) {
            let code = Char.toNat32(char);
            if (code < 33 or code > 126) return false;
        };
        true;
    };

/*---NEUTRON GENERATED BEGIN---*/

public type contacts_revision_Input = (());
public type contacts_revision_Output = ContactRevisionV1;

public type contacts_search_Input = (request : SearchContactsRequestV2,);
public type contacts_search_Output = SearchContactsResultV2;

public type contacts_get_Input = (request : { id : Nat });
public type contacts_get_Output = ?ContactV2;

public type contacts_resolve_Input = (request : DiscoverContactsRequestV2,);
public type contacts_resolve_Output = DiscoverContactsResultV2;

public type contacts_save_Input = (request : SaveContactRequestV2,);
public type contacts_save_Output = SaveContactResultV2;

public type contacts_remove_Input = (request : RemoveContactRequestV2,);
public type contacts_remove_Output = RemoveContactResultV2;

public type contacts_discover_v1_Input = (request : DiscoverContactsRequestV1,);
public type contacts_discover_v1_Output = DiscoverContactsResultV1;

public type contacts_neutron_lookup_v2_Input = (request : { principal : Principal },);
public type contacts_neutron_lookup_v2_Output = NeutronContactLookupV2;

public type contacts_neutron_search_v2_Input = (request : DiscoverNeutronContactsRequestV2,);
public type contacts_neutron_search_v2_Output = DiscoverNeutronContactsResultV2;

public type contacts_neutron_revision_v2_Input = (());
public type contacts_neutron_revision_v2_Output = Nat;

/*---NEUTRON GENERATED END---*/
};
