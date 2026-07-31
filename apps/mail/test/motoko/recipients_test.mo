import Blob "mo:core/Blob";
import Principal "mo:core/Principal";
import Recipients "../../backend/recipients/Service";

func canister(last : Nat8) : Principal {
    Principal.fromBlob(Blob.fromArray([0, last, 1]));
};

func repeatedText(size : Nat) : Text {
    var result = "";
    var index = 0;
    while (index < size) {
        result #= "x";
        index += 1;
    };
    result;
};

let first : Recipients.Contact = {
    contact_id = 1;
    contact_revision = 3;
    contact_name = "Ada";
    principal = canister(1);
};
let second : Recipients.Contact = {
    contact_id = 2;
    contact_revision = 4;
    contact_name = "Grace";
    principal = canister(2);
};
var calls = 0;
var response : Recipients.ContactsResult = #ok({
    book_revision = 9;
    contacts = [first, second];
    total = 3;
    next_offset = ?2;
});
let service = Recipients.Service(func(_request) {
    calls += 1;
    response;
});

switch (service.recipients({ search_text = "a"; offset = 0; limit = 2 })) {
    case (#err(_)) assert false;
    case (#ok(page)) {
        assert (page.book_revision == 9 and page.total == 3);
        assert (page.contacts == [first, second] and page.next_offset == ?2);
    };
};
assert (calls == 1);

// Invalid requests are rejected before Contacts is invoked.
for (request in [
    { search_text = repeatedText(121); offset = 0; limit = 1 },
    { search_text = "bad\0aquery"; offset = 0; limit = 1 },
    { search_text = ""; offset = 2_001; limit = 1 },
    { search_text = ""; offset = 0; limit = 0 },
    { search_text = ""; offset = 0; limit = 51 },
].vals()) {
    switch (service.recipients(request)) {
        case (#err(#invalid_request)) {};
        case (_) assert false;
    };
};
assert (calls == 1);

response := #err(#validation("Contacts rejected the request"));
switch (service.recipients({ search_text = ""; offset = 0; limit = 1 })) {
    case (#err(#contacts_error)) {};
    case (_) assert false;
};

// Dependency results are independently bounded and structurally checked.
response := #ok({
    book_revision = 9;
    contacts = [first];
    total = 2;
    next_offset = null;
});
switch (service.recipients({ search_text = ""; offset = 0; limit = 1 })) {
    case (#err(#invalid_dependency)) {};
    case (_) assert false;
};

response := #ok({
    book_revision = 9;
    contacts = [first, { first with principal = canister(2) }];
    total = 2;
    next_offset = null;
});
switch (service.recipients({ search_text = ""; offset = 0; limit = 2 })) {
    case (#err(#invalid_dependency)) {};
    case (_) assert false;
};

response := #ok({
    book_revision = 9;
    contacts = [{ first with contact_name = "bad\0aname" }];
    total = 1;
    next_offset = null;
});
switch (service.recipients({ search_text = ""; offset = 0; limit = 1 })) {
    case (#err(#invalid_dependency)) {};
    case (_) assert false;
};

response := #ok({
    book_revision = 10;
    contacts = [second];
    total = 3;
    next_offset = null;
});
switch (service.recipients({ search_text = "g"; offset = 2; limit = 2 })) {
    case (#err(_)) assert false;
    case (#ok(page)) assert (page.contacts == [second] and page.next_offset == null);
};
