import Int "mo:core/Int";
import Nat64 "mo:core/Nat64";
import Runtime "mo:core/Runtime";
import Time "mo:core/Time";
import Calendar "../backend/main";
import Memory "../backend/memory/calendar/v2";

let minute : Nat = 60_000_000_000;
let day : Nat = 86_400_000_000_000;
let now = Int.abs(Time.now());
var targetDay = now / day + 1;
while (((targetDay + 4) % 7) == 0 or ((targetDay + 4) % 7) == 6) { targetDay += 1 };
let first = Nat64.fromNat(targetDay * day + 600 * minute);
let second = Nat64.fromNat((targetDay + 1) * day + 600 * minute);
let third = Nat64.fromNat((targetDay + 2) * day + 600 * minute);
let duration = Nat64.fromNat(30 * minute);
let memory = Memory.init();
let calendar = Calendar.Init({ stable_memory = { calendar = memory } });
let occurrences : [Calendar.OccurrenceInput] = [
    { recurrence_key = "20260824T100000"; start_ns = first; end_ns = first + duration },
    { recurrence_key = "20260825T100000"; start_ns = second; end_ns = second + duration },
    { recurrence_key = "20260826T100000"; start_ns = third; end_ns = third + duration },
];
let write : Calendar.SeriesWrite = { title = "Daily focus"; notes = "Private"; location = "Desk"; color = "ocean"; availability = #free; kind = #timed; time_zone = "UTC"; recurrence = ?{ frequency = #daily; interval = 1; weekdays_mask = 0; month_day = null; end = #count(3) }; occurrences };
let #ok(created) = calendar.calendar_series_create_v2({ expected_revision = 0; value = write }) else Runtime.trap("series create failed");
assert (created.id == 1 and created.revision == 1);
let range = calendar.calendar_range_v2({ start_ns = first; end_ns = third + duration; offset = 0; limit = 10 });
assert (range.total == 3 and range.occurrences[0].location == "Desk" and range.occurrences[0].availability == #free);
let free = calendar.calendar_availability_v1({ window_start_ns = first; window_end_ns = first + duration; duration_minutes = 30; candidate_starts_ns = [first] });
assert (free.available_starts_ns.size() == 1);
// Working hours guide client-side suggestions; they are not a UTC rejection gate.
let early = first - Nat64.fromNat(7 * 60 * minute);
let outsideWorkingHours = calendar.calendar_availability_v1({ window_start_ns = early; window_end_ns = early + duration; duration_minutes = 30; candidate_starts_ns = [early] });
assert (outsideWorkingHours.available_starts_ns.size() == 1);

// Per-occurrence edits and cancellations are durable exceptions, not temporary
// projections that a later whole-series edit may erase or resurrect.
let firstOccurrence = range.occurrences[0];
let movedFirst = first + Nat64.fromNat(60 * minute);
let #ok(overridden) = calendar.calendar_occurrence_update_v2({
    occurrence_id = firstOccurrence.id;
    expected_occurrence_revision = firstOccurrence.revision;
    start_ns = movedFirst;
    end_ns = movedFirst + duration;
    title_override = ?"Special focus";
    notes_override = ?"Exception notes";
    location_override = ?"Library";
}) else Runtime.trap("occurrence override failed");
assert (overridden.status == "overridden" and overridden.title == "Special focus");
let #err(staleOccurrence) = calendar.calendar_occurrence_update_v2({
    occurrence_id = firstOccurrence.id;
    expected_occurrence_revision = firstOccurrence.revision;
    start_ns = movedFirst + Nat64.fromNat(15 * minute);
    end_ns = movedFirst + duration + Nat64.fromNat(15 * minute);
    title_override = null;
    notes_override = null;
    location_override = null;
}) else Runtime.trap("stale occurrence update accepted");
assert (staleOccurrence.code == "stale");
let secondOccurrence = range.occurrences[1];
let #ok(_) = calendar.calendar_occurrence_remove_v2({ occurrence_id = secondOccurrence.id; expected_occurrence_revision = secondOccurrence.revision }) else Runtime.trap("occurrence cancel failed");

let renamedWrite = { write with title = "Renamed daily focus"; availability = #busy };
let #ok(updated) = calendar.calendar_series_update_v2({ series_id = created.id; expected_series_revision = 1; value = renamedWrite }) else Runtime.trap("series update failed");
assert (updated.revision == 2);
let afterUpdate = calendar.calendar_range_v2({ start_ns = first; end_ns = third + duration; offset = 0; limit = 10 });
assert (afterUpdate.total == 2);
assert (afterUpdate.occurrences[0].id == firstOccurrence.id);
assert (afterUpdate.occurrences[0].start_ns == movedFirst);
assert (afterUpdate.occurrences[0].title == "Special focus");
assert (afterUpdate.occurrences[0].notes == "Exception notes");
assert (afterUpdate.occurrences[0].location == "Library");
assert (afterUpdate.occurrences[0].status == "overridden");
assert (afterUpdate.occurrences[1].start_ns == third);
assert (afterUpdate.occurrences[1].title == "Renamed daily focus");

// A drag/resize sends null metadata fields and must preserve prior overrides.
let preserved = afterUpdate.occurrences[0];
let movedAgain = movedFirst + Nat64.fromNat(30 * minute);
let #ok(afterDrag) = calendar.calendar_occurrence_update_v2({
    occurrence_id = preserved.id;
    expected_occurrence_revision = preserved.revision;
    start_ns = movedAgain;
    end_ns = movedAgain + duration;
    title_override = null;
    notes_override = null;
    location_override = null;
}) else Runtime.trap("drag-style update failed");
assert (afterDrag.start_ns == movedAgain and afterDrag.title == "Special focus");
assert (afterDrag.notes == "Exception notes" and afterDrag.location == "Library");
let busy = calendar.calendar_availability_v1({ window_start_ns = movedAgain; window_end_ns = movedAgain + duration; duration_minutes = 30; candidate_starts_ns = [movedAgain] });
assert (busy.available_starts_ns.size() == 0);
let #ok(_) = calendar.calendar_series_remove_v2({ series_id = created.id; expected_series_revision = 2 }) else Runtime.trap("series remove failed");
assert (calendar.calendar_status().event_count == 0);
