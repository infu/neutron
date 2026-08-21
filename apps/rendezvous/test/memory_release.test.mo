import Blob "mo:core/Blob";
import Principal "mo:core/Principal";
import NeutronCapabilities "mo:neutron-capabilities";
import Rendezvous "../backend/main";
import Memory "../backend/memory/rendezvous/v2";

let memory = Memory.init();
let self = Principal.fromBlob(Blob.fromArray([0, 1, 1]));
let rendezvous = Rendezvous.Init({
    stable_memory = { rendezvous = memory };
    app_calls = { calendar = {
        calendar_availability_v1 = func(request) { { revision = 0; available_starts_ns = request.candidate_starts_ns } };
        calendar_reserve_v1 = func(_) { #reserved({ event_id = 1; event_revision = 1; calendar_revision = 1 }) };
        calendar_confirm_v1 = func(_) { #ok({ calendar_revision = 1 }) };
        calendar_release_v1 = func(_) { #ok({ calendar_revision = 1 }) };
    }; contacts = {
        contacts_neutron_lookup_v2 = func(_ : { principal : Principal }) : Rendezvous.ContactLookup { { book_revision = 0; integrity_ok = true; match = null } };
        contacts_neutron_search_v2 = func(_ : Rendezvous.ContactSearchRequest) : Rendezvous.ContactSearchDependencyResult { #ok({ book_revision = 0; contacts = []; total = 0; next_offset = null }) };
        contacts_neutron_revision_v2 = func(()) : Nat { 0 };
    } };
    capabilities = { backend_calls = {
        canister_principal = self;
        can_call = func(_canister : Principal, _method : Text) { true };
        call = func(_request : NeutronCapabilities.BackendCallRequestV1) : async* NeutronCapabilities.BackendCallResultV1 { #err({ code = "unused"; message = "unused" }) };
        call_batch = func(_requests : [NeutronCapabilities.BackendCallRequestV1]) : async* [NeutronCapabilities.BackendCallResultV1] { [] };
    } };
});
let status = rendezvous.rendezvous_status();
assert (status.revision == 0);
assert (status.negotiation_count == 0);
