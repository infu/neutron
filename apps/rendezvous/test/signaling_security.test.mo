import Blob "mo:core/Blob";
import Int "mo:core/Int";
import Principal "mo:core/Principal";
import Nat64 "mo:core/Nat64";
import Time "mo:core/Time";
import NeutronCapabilities "mo:neutron-capabilities";
import Rendezvous "../backend/main";
import Memory "../backend/memory/rendezvous/v2";

let self = Principal.fromBlob(Blob.fromArray([0, 1, 1]));
let peer = Principal.fromBlob(Blob.fromArray([0, 1, 2]));
let stranger = Principal.fromBlob(Blob.fromArray([0, 1, 3]));
let id = Blob.fromArray([1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]);
let capability = Blob.fromArray([2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2]);
let signalId = Blob.fromArray([3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3]);
let memory = Memory.init();
memory.negotiations := [{
    id; capability; revision = 2; direction = #outbound; peer = ?peer;
    state = #confirmed; title = "Private call"; duration_minutes = 30;
    candidate_starts_ns = [1]; selected_start_ns = ?1; expires_at_ns = 9_999_999_999_999_999_999;
    outbound_bytes = null; attempts = 1; delivery = #delivered;
}];
let app = Rendezvous.Init({
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
        canister_principal = self; can_call = func(_, _) { true };
        call = func(_ : NeutronCapabilities.BackendCallRequestV1) : async* NeutronCapabilities.BackendCallResultV1 { #err({ code = "unused"; message = "unused" }) };
        call_batch = func(_ : [NeutronCapabilities.BackendCallRequestV1]) : async* [NeutronCapabilities.BackendCallResultV1] { [] };
    } };
});

switch (app.rendezvous_media_select_v1({ id })) { case (#ok(meeting)) { assert (meeting.initiator); assert (Principal.equal(meeting.peer, peer)) }; case (#err(_)) assert false };
let expires = Nat64.fromNat(Int.abs(Time.now()) + 60_000_000_000);
let request : Rendezvous.RemoteSignalRequest = { version = 1; negotiation_id = id; capability; signal_id = signalId; kind = "description"; payload = "{\"type\":\"offer\"}"; expires_at_ns = expires };
switch (app.rendezvous_remote_signal_v1(request, stranger)) { case (#err(e)) assert (e.code == "forbidden"); case (#ok) assert false };
switch (app.rendezvous_remote_signal_v1(request, peer)) { case (#ok) {}; case (#err(_)) assert false };
switch (app.rendezvous_remote_signal_v1(request, peer)) { case (#ok) {}; case (#err(_)) assert false };
assert (memory.signals.size() == 1);
assert (memory.signal_receipts.size() == 1);
let page = app.rendezvous_signal_poll_v1({ negotiation_id = id; after_sequence = 0 });
assert (page.signals.size() == 1);
assert (page.signals[0].kind == "description");
app.rendezvous_media_close_v1();
assert (app.rendezvous_signal_poll_v1({ negotiation_id = id; after_sequence = 0 }).signals.size() == 0);
assert (memory.signals.size() == 0);
assert (memory.signal_receipts.size() == 0);
