import Availability "../backend/Availability";
import Memory "../backend/memory/calendar/v1";
import Nat64 "mo:core/Nat64";

let minute : Nat = 60_000_000_000;
let day : Nat = 86_400_000_000_000;
func at(dayIndex : Nat, minuteOfDay : Nat) : Nat64 { Nat64.fromNat(dayIndex * day + minuteOfDay * minute) };

let preferences : Memory.Preferences = {
    day_start_minute = 540;
    day_end_minute = 1_020;
    allowed_weekdays_mask = 62;
    slot_increment_minutes = 15;
    buffer_before_minutes = 0;
    buffer_after_minutes = 0;
    display_time_zone = "UTC";
};

// Day four after the Unix epoch is Monday. A confirmed 10:00–11:00 event
// blocks only that slot; exact adjacent boundaries remain available.
let event : Memory.Event = {
    id = 1;
    revision = 1;
    start_ns = at(4, 600);
    end_ns = at(4, 660);
    title = "private title";
    notes = "private notes";
    source = #owner;
    status = #confirmed;
};
let result = Availability.filter([event], preferences, at(4, 480), at(4, 540), at(4, 720), 60, [at(4, 540), at(4, 600), at(4, 660)]);
assert (result == [at(4, 540), at(4, 660)]);

// Candidate order is canonical: duplicate or descending entries fail rather
// than being silently repeated in a protocol response.
let unordered = Availability.filter([], preferences, at(4, 480), at(4, 540), at(4, 720), 30, [at(4, 600), at(4, 600), at(4, 585)]);
assert (unordered == [at(4, 600)]);

let expiredHold : Memory.Event = { event with id = 2; status = #hold(at(4, 470)) };
let activeHold : Memory.Event = { event with id = 3; status = #hold(at(4, 700)) };
assert (Availability.filter([expiredHold], preferences, at(4, 480), at(4, 600), at(4, 660), 60, [at(4, 600)]).size() == 1);
assert (Availability.filter([activeHold], preferences, at(4, 480), at(4, 600), at(4, 660), 60, [at(4, 600)]).size() == 0);

// Weekend, before-hours, cross-day, short, and overlong meetings fail closed.
assert (Availability.filter([], preferences, at(2, 480), at(2, 540), at(2, 720), 60, [at(2, 540)]).size() == 0);
assert (Availability.filter([], preferences, at(4, 400), at(4, 480), at(4, 600), 60, [at(4, 480)]).size() == 0);
assert (Availability.filter([], preferences, at(4, 480), at(4, 540), at(4, 720), 5, [at(4, 540)]).size() == 0);
assert (Availability.filter([], preferences, at(4, 480), at(4, 540), at(4, 1_439), 481, [at(4, 540)]).size() == 0);

let buffered : Memory.Preferences = { preferences with buffer_before_minutes = 15; buffer_after_minutes = 15 };
assert (Availability.filter([event], buffered, at(4, 480), at(4, 540), at(4, 720), 45, [at(4, 555), at(4, 674), at(4, 675)]) == [at(4, 675)]);
