import Blob "mo:core/Blob";
import Int "mo:core/Int";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Time "mo:core/Time";
import Cap "mo:neutron-capabilities";
import Rendezvous "../backend/main";
import Memory "../backend/memory/rendezvous/v2";

let self = Principal.fromBlob(Blob.fromArray([0, 1, 1]));
let peer = Principal.fromBlob(Blob.fromArray([0, 2, 1]));
let calendar = {
  calendar_availability_v1 = func(request : { window_start_ns : Nat64; window_end_ns : Nat64; duration_minutes : Nat32; candidate_starts_ns : [Nat64] }) : Rendezvous.CalendarAvailability { { revision = 0; available_starts_ns = request.candidate_starts_ns } };
  calendar_reserve_v1 = func(_ : { external_id : Blob; expected_revision : Nat64; start_ns : Nat64; duration_minutes : Nat32; meeting_label : Text; hold_expires_at_ns : Nat64 }) : Rendezvous.CalendarReserve { #reserved({ event_id = 1; event_revision = 1; calendar_revision = 1 }) };
  calendar_confirm_v1 = func(_ : { external_id : Blob }) : Rendezvous.CalendarSimple { #ok({ calendar_revision = 1 }) };
  calendar_release_v1 = func(_ : { external_id : Blob }) : Rendezvous.CalendarSimple { #ok({ calendar_revision = 1 }) };
};
var contactsRevision = 7;
let contacts = {
  contacts_neutron_lookup_v2 = func(request : { principal : Principal }) : Rendezvous.ContactLookup { { book_revision = contactsRevision; integrity_ok = true; match = if (Principal.equal(request.principal, peer)) ?{ contact_id = 4; contact_revision = 2; contact_name = "Bob"; principal = peer } else null } };
  contacts_neutron_search_v2 = func(_ : Rendezvous.ContactSearchRequest) : Rendezvous.ContactSearchDependencyResult { #ok({ book_revision = contactsRevision; contacts = [{ contact_id = 4; contact_revision = 2; contact_name = "Bob"; principal = peer }]; total = 1; next_offset = null }) };
  contacts_neutron_revision_v2 = func(()) : Nat { contactsRevision };
};
let app = Rendezvous.Init({ stable_memory = { rendezvous = Memory.init() }; app_calls = { calendar; contacts }; capabilities = { backend_calls = { canister_principal = self; can_call = func(_, _) { true }; call = func(_ : Cap.BackendCallRequestV1) : async* Cap.BackendCallResultV1 { #err({ code = "offline"; message = "test" }) }; call_batch = func(_ : [Cap.BackendCallRequestV1]) : async* [Cap.BackendCallResultV1] { [] } } } });
let id = Blob.fromArray([1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]); let token = Blob.fromArray([2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2]); let command = Blob.fromArray([3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3]);
let now = Int.abs(Time.now()); let start = Nat64.fromNat(now + 3_600_000_000_000); let expires = Nat64.fromNat(now + 86_400_000_000_000);
let #ok(contactPage) = app.rendezvous_contacts_search_v1({ search_text = "Bob"; offset = 0; limit = 1 }) else Runtime.trap("Contacts search failed");
assert (contactPage.book_revision == 7 and contactPage.contacts.size() == 1 and contactPage.contacts[0].contact_name == "Bob");
let contactId = Blob.fromArray([8,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]);
let #ok(contactDraft) = app.rendezvous_create_contact_offer({ id = contactId; capability = token; peer; contact = { contact_id = 4; contact_revision = 2; book_revision = 7 }; title = "Bound contact"; duration_minutes = 30; candidate_starts_ns = [start]; expires_at_ns = expires }) else Runtime.trap("Contact offer failed");
assert (contactDraft.peer == ?peer);
contactsRevision := 8;
let changedId = Blob.fromArray([8,2,1,1,1,1,1,1,1,1,1,1,1,1,1,1]);
let #err(changedContact) = app.rendezvous_create_contact_offer({ id = changedId; capability = token; peer; contact = { contact_id = 4; contact_revision = 2; book_revision = 7 }; title = "Stale contact"; duration_minutes = 30; candidate_starts_ns = [start]; expires_at_ns = expires }) else Runtime.trap("Changed Contact was accepted");
assert (changedContact.code == "contact_changed" and app.rendezvous_get({ id = changedId }) == null);
let offer : Rendezvous.RemoteExchangeRequest = { version = 1; command = "offer"; command_id = command; negotiation_id = id; capability = token; expected_revision = 0; title = "Private-free proposal"; duration_minutes = 30; candidate_starts_ns = [start]; selected_start_ns = null; expires_at_ns = expires };
let #ok(first) = app.rendezvous_remote_exchange_v1(offer, peer) else Runtime.trap("offer failed"); assert (first.state == #offered);
let inboundPage = app.rendezvous_list({ offset = 0; limit = 10 });
assert (inboundPage.negotiations.size() == 2);
assert (inboundPage.negotiations[1].peer_name == ?"Bob");
let #ok(replayed) = app.rendezvous_remote_exchange_v1(offer, peer) else Runtime.trap("replay failed"); assert (replayed.revision == first.revision and app.rendezvous_status().negotiation_count == 2);
let selfOffer = app.rendezvous_remote_exchange_v1({ offer with negotiation_id = Blob.fromArray([9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9]) }, self);
let #err(selfDenied) = selfOffer else Runtime.trap("self offer accepted"); assert (selfDenied.code == "self_call");

let wrong = Principal.fromBlob(Blob.fromArray([0, 3, 1])); let counter : Rendezvous.RemoteExchangeRequest = { offer with command = "counter"; command_id = Blob.fromArray([4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4]); expected_revision = 1; selected_start_ns = ?start };
let #err(denied) = app.rendezvous_remote_exchange_v1(counter, wrong) else Runtime.trap("wrong peer accepted"); assert (denied.code == "forbidden");
let #err(wrongCapability) = app.rendezvous_remote_exchange_v1({ counter with command_id = Blob.fromArray([7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7]); capability = Blob.fromArray([8,8,8,8,8,8,8,8,8,8,8,8,8,8,8,8]) }, peer) else Runtime.trap("wrong capability accepted"); assert (wrongCapability.code == "forbidden");
let #err(futureRevision) = app.rendezvous_remote_exchange_v1({ counter with command_id = Blob.fromArray([6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6]); expected_revision = 2 }, peer) else Runtime.trap("future revision accepted"); assert (futureRevision.code == "stale");
let #ok(countered) = app.rendezvous_remote_exchange_v1(counter, peer) else Runtime.trap("valid counter failed"); assert (countered.state == #countered and countered.revision == 2);
let #ok(counterReplay) = app.rendezvous_remote_exchange_v1(counter, peer) else Runtime.trap("counter replay failed"); assert (counterReplay.state == #countered and counterReplay.revision == 2);
let reordered : Rendezvous.RemoteExchangeRequest = { counter with command_id = Blob.fromArray([5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5]); expected_revision = 1 };
let #err(reorderedError) = app.rendezvous_remote_exchange_v1(reordered, peer) else Runtime.trap("reordered command accepted"); assert (reorderedError.code == "stale");

// Accept persists a local intent before the await, but the peer must compare
// against the revision that existed before that local-only transition.
assert (Rendezvous.remoteExpectedRevision("offer", #draft, 1) == 0);
assert (Rendezvous.remoteExpectedRevision("accept", #accept_intent, 2) == 1);
assert (Rendezvous.remoteExpectedRevision("accept", #offered, 1) == 1);
assert (Rendezvous.remoteExpectedRevision("counter", #countered, 2) == 2);
