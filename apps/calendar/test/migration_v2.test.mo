import Blob "mo:core/Blob";
import Int "mo:core/Int";
import Nat64 "mo:core/Nat64";
import Time "mo:core/Time";
import Runtime "mo:core/Runtime";
import V1 "../backend/memory/calendar/v1";
import V2 "../backend/memory/calendar/v2";
import Migration "../backend/memory/calendar/v1_to_v2";

let minute : Nat = 60_000_000_000;
let now = Nat64.fromNat(Int.abs(Time.now()));
let old = V1.init();
old.revision := 12;
old.next_event_id := 9;
old.preferences := { old.preferences with display_time_zone = "America/Chicago" };
let external = Blob.fromArray([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
old.events := [
    { id = 2; revision = 3; start_ns = now + Nat64.fromNat(minute); end_ns = now + Nat64.fromNat(2 * minute); title = "Owner"; notes = "Private"; source = #owner; status = #confirmed },
    { id = 4; revision = 1; start_ns = now + Nat64.fromNat(3 * minute); end_ns = now + Nat64.fromNat(4 * minute); title = "Meeting"; notes = ""; source = #rendezvous(external); status = #confirmed },
    { id = 6; revision = 1; start_ns = now + Nat64.fromNat(5 * minute); end_ns = now + Nat64.fromNat(6 * minute); title = "Live hold"; notes = ""; source = #rendezvous(external); status = #hold(now + Nat64.fromNat(10 * minute)) },
    { id = 8; revision = 1; start_ns = now; end_ns = now + Nat64.fromNat(minute); title = "Expired"; notes = ""; source = #rendezvous(external); status = #hold(now - 1) },
];

let migrated : V2.Mem = Migration.migrate(old);
assert (migrated.revision == 12);
assert (migrated.next_series_id == 9 and migrated.next_occurrence_id == 9);
assert (migrated.series.size() == 3 and migrated.occurrences.size() == 3);
assert (migrated.series[0].title == "Owner" and migrated.series[0].time_zone == "America/Chicago");
assert (migrated.series[1].source == #rendezvous(external));
assert (migrated.occurrences[0].status == #normal);
assert (migrated.occurrences[1].status == #confirmed);
switch (migrated.occurrences[2].status) { case (#hold(expires)) assert (expires > now); case (_) Runtime.trap("live hold status lost") };
