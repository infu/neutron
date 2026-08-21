import Blob "mo:core/Blob";
import Int "mo:core/Int";
import Nat64 "mo:core/Nat64";
import Runtime "mo:core/Runtime";
import Time "mo:core/Time";
import Calendar "../backend/main";
import Memory "../backend/memory/calendar/v2";

let minute : Nat = 60_000_000_000;
let day : Nat = 86_400_000_000_000;
let now = Int.abs(Time.now());
let start = Nat64.fromNat(now + minute * 60);
let finish = Nat64.fromNat(now + minute * 120);
let memory = Memory.init();
let calendar = Calendar.Init({ stable_memory = { calendar = memory } });

let #ok(created) = calendar.calendar_create({ expected_revision = 0; start_ns = start; end_ns = finish; title = "Private"; notes = "Never shared" }) else Runtime.trap("create failed");
assert (created.id == 1 and created.revision == 1);
assert (calendar.calendar_status().revision == 1);

let #ok(overlap) = calendar.calendar_create({ expected_revision = 1; start_ns = start; end_ns = finish; title = "Overlap"; notes = "" }) else Runtime.trap("ordinary overlap rejected");
assert (overlap.id == 2 and overlap.revision == 1);
let #err(stale) = calendar.calendar_update({ id = 1; expected_event_revision = 0; start_ns = start; end_ns = finish; title = "Changed"; notes = "" }) else Runtime.trap("stale update accepted");
assert (stale.code == "stale");

var targetDay = now / day + 1;
while (((targetDay + 4) % 7) == 0 or ((targetDay + 4) % 7) == 6) { targetDay += 1 };
let laterStart = Nat64.fromNat(targetDay * day + minute * 600);
let laterEnd = Nat64.fromNat(targetDay * day + minute * 660);
let #ok(updated) = calendar.calendar_update({ id = 1; expected_event_revision = 1; start_ns = laterStart; end_ns = laterEnd; title = "Changed"; notes = "" }) else Runtime.trap("update failed");
assert (updated.revision == 2);
let page = calendar.calendar_list({ offset = 0; limit = 10 });
assert (page.total == 2 and page.events[0].title == "Changed");

let #ok(_) = calendar.calendar_remove({ id = 2; expected_event_revision = 1 }) else Runtime.trap("overlap remove failed");
let #ok(_) = calendar.calendar_remove({ id = 1; expected_event_revision = 2 }) else Runtime.trap("remove failed");
assert (calendar.calendar_status().event_count == 0);

// Dependency holds are external-id idempotent.
let external = Blob.fromArray([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
let #reserved(held) = calendar.calendar_reserve_v1({ external_id = external; expected_revision = 5; start_ns = laterStart; duration_minutes = 60; meeting_label = "Rendezvous"; hold_expires_at_ns = Nat64.fromNat(now + minute * 300) }) else Runtime.trap("reserve failed");
let #reserved(same) = calendar.calendar_reserve_v1({ external_id = external; expected_revision = 0; start_ns = laterStart; duration_minutes = 60; meeting_label = "Rendezvous"; hold_expires_at_ns = Nat64.fromNat(now + minute * 300) }) else Runtime.trap("idempotent reserve failed");
assert (held.event_id == same.event_id);
let #ok(_) = calendar.calendar_confirm_v1({ external_id = external }) else Runtime.trap("confirm failed");
let #ok(_) = calendar.calendar_confirm_v1({ external_id = external }) else Runtime.trap("idempotent confirm failed");
let #ok(_) = calendar.calendar_release_v1({ external_id = external }) else Runtime.trap("release failed");
let #not_found(_) = calendar.calendar_release_v1({ external_id = external }) else Runtime.trap("missing release was not idempotent");
