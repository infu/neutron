import Char "mo:core/Char";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Set "mo:core/Set";
import Text "mo:core/Text";

module {
    public let MAX_SEARCH_CHARS = 120;
    public let MAX_OFFSET = 2_000;
    public let MAX_PAGE = 50;
    public let MAX_TOTAL = 2_000;

    public type ContactErrorV2 = {
        #validation : Text;
        #not_found : Nat;
        #conflict : { expected : Nat; actual : Nat };
        #neutron_conflict : {
            principal : Principal;
            contact_id : Nat;
            contact_name : Text;
        };
        #limit : Text;
    };

    public type Contact = {
        contact_id : Nat;
        contact_revision : Nat;
        contact_name : Text;
        principal : Principal;
    };

    public type Request = {
        search_text : Text;
        offset : Nat;
        limit : Nat;
    };

    public type Page = {
        book_revision : Nat;
        contacts : [Contact];
        total : Nat;
        next_offset : ?Nat;
    };

    public type ContactsResult = {
        #ok : Page;
        #err : ContactErrorV2;
    };

    public type Error = {
        #invalid_request;
        #contacts_error;
        #invalid_dependency;
    };

    public type Result = {
        #ok : Page;
        #err : Error;
    };

    public type Search = Request -> ContactsResult;

    public class Service(search : Search) {
        public func recipients(request : Request) : Result {
            if (not validRequest(request)) return #err(#invalid_request);
            switch (search(request)) {
                case (#err(_)) #err(#contacts_error);
                case (#ok(page)) {
                    if (not validPage(request, page)) {
                        #err(#invalid_dependency);
                    } else #ok(page);
                };
            };
        };
    };

    func validRequest(request : Request) : Bool {
        request.search_text.size() <= MAX_SEARCH_CHARS and
        not hasUnsafeControls(request.search_text) and
        request.offset <= MAX_OFFSET and
        request.limit > 0 and request.limit <= MAX_PAGE;
    };

    func validPage(request : Request, page : Page) : Bool {
        if (
            page.total > MAX_TOTAL or
            page.contacts.size() > request.limit or
            page.contacts.size() > MAX_PAGE
        ) return false;

        let expectedCount = if (request.offset >= page.total) {
            0;
        } else min(request.limit, page.total - request.offset);
        if (page.contacts.size() != expectedCount) return false;
        let end = request.offset + page.contacts.size();
        let expectedNext = if (end < page.total) ?end else null;
        if (page.next_offset != expectedNext) return false;

        let contactIds = Set.empty<Nat>();
        let principals = Set.empty<Principal>();
        for (contact in page.contacts.vals()) {
            if (
                contact.contact_id == 0 or
                contact.contact_revision == 0 or
                contact.contact_name.size() == 0 or
                contact.contact_name.size() > 120 or
                hasUnsafeControls(contact.contact_name) or
                not Principal.isCanister(contact.principal) or
                not Set.insert(contactIds, Nat.compare, contact.contact_id) or
                not Set.insert(principals, Principal.compare, contact.principal)
            ) return false;
        };
        true;
    };

    func hasUnsafeControls(value : Text) : Bool {
        for (char in value.chars()) {
            let code = Char.toNat32(char);
            if (code < 32 or code == 127) return true;
        };
        false;
    };

    func min(left : Nat, right : Nat) : Nat {
        if (left < right) left else right;
    };
};
