import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Int "mo:core/Int";
import Nat8 "mo:core/Nat8";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Availability "AvailabilityV2";
import Memory "memory/calendar/v2";
import Validation "Validation";

module {
    let MAX_SERIES = 2_000; let MAX_OCCURRENCES = 10_000; let MAX_SERIES_OCCURRENCES = 730; let MAX_RANGE_RESULTS = 2_000;
    public type Status = { revision : Nat64; event_count : Nat };
    public type Error = { code : Text; message : Text; revision : Nat64 };
    public type EventView = { id : Nat64; revision : Nat64; start_ns : Nat64; end_ns : Nat64; title : Text; notes : Text; source : Text; status : Text; hold_expires_at_ns : ?Nat64 };
    public type EventResult = { #ok : EventView; #err : Error };
    public type MutationResult = { #ok : { revision : Nat64 }; #err : Error };
    public type ListRequest = { offset : Nat; limit : Nat };
    public type EventPage = { revision : Nat64; total : Nat; events : [EventView] };
    public type CreateRequest = { expected_revision : Nat64; start_ns : Nat64; end_ns : Nat64; title : Text; notes : Text };
    public type UpdateRequest = { id : Nat64; expected_event_revision : Nat64; start_ns : Nat64; end_ns : Nat64; title : Text; notes : Text };
    public type RemoveRequest = { id : Nat64; expected_event_revision : Nat64 };

    public type PreferencesView = { revision : Nat64; day_start_minute : Nat16; day_end_minute : Nat16; allowed_weekdays_mask : Nat8; slot_increment_minutes : Nat16; buffer_before_minutes : Nat16; buffer_after_minutes : Nat16; display_time_zone : Text };
    public type PreferencesSetRequest = { expected_revision : Nat64; day_start_minute : Nat16; day_end_minute : Nat16; allowed_weekdays_mask : Nat8; slot_increment_minutes : Nat16; buffer_before_minutes : Nat16; buffer_after_minutes : Nat16; display_time_zone : Text };
    public type PreferencesResult = { #ok : PreferencesView; #err : Error };

    public type AvailabilityMode = { #busy; #free };
    public type EventKind = { #timed; #all_day };
    public type Frequency = { #daily; #weekly; #monthly; #yearly };
    public type RecurrenceEnd = { #count : Nat16; #until : Nat64 };
    public type RecurrenceRule = { frequency : Frequency; interval : Nat8; weekdays_mask : Nat8; month_day : ?Nat8; end : RecurrenceEnd };
    public type OccurrenceInput = { recurrence_key : Text; start_ns : Nat64; end_ns : Nat64 };
    public type SeriesWrite = { title : Text; notes : Text; location : Text; color : Text; availability : AvailabilityMode; kind : EventKind; time_zone : Text; recurrence : ?RecurrenceRule; occurrences : [OccurrenceInput] };
    public type SeriesCreateRequest = { expected_revision : Nat64; value : SeriesWrite };
    public type SeriesUpdateRequest = { series_id : Nat64; expected_series_revision : Nat64; value : SeriesWrite };
    public type SeriesRemoveRequest = { series_id : Nat64; expected_series_revision : Nat64 };
    public type OccurrenceUpdateRequest = { occurrence_id : Nat64; expected_occurrence_revision : Nat64; start_ns : Nat64; end_ns : Nat64; title_override : ?Text; notes_override : ?Text; location_override : ?Text };
    public type OccurrenceRemoveRequest = { occurrence_id : Nat64; expected_occurrence_revision : Nat64 };
    public type RangeRequest = { start_ns : Nat64; end_ns : Nat64; offset : Nat; limit : Nat };
    public type SeriesView = { id : Nat64; revision : Nat64; title : Text; notes : Text; location : Text; color : Text; availability : AvailabilityMode; kind : EventKind; source : Text; time_zone : Text; recurrence : ?RecurrenceRule; created_at_ns : Nat64; updated_at_ns : Nat64 };
    public type OccurrenceView = { id : Nat64; revision : Nat64; series_id : Nat64; series_revision : Nat64; recurrence_key : Text; start_ns : Nat64; end_ns : Nat64; title : Text; notes : Text; location : Text; color : Text; availability : AvailabilityMode; kind : EventKind; source : Text; status : Text };
    public type RangePage = { revision : Nat64; total : Nat; occurrences : [OccurrenceView] };
    public type SeriesOccurrencesRequest = { series_id : Nat64; offset : Nat; limit : Nat };
    public type SeriesOccurrencesPage = { revision : Nat64; total : Nat; occurrences : [OccurrenceView] };
    public type SeriesResult = { #ok : SeriesView; #err : Error };
    public type OccurrenceResult = { #ok : OccurrenceView; #err : Error };

    public type AvailabilityRequestV1 = { window_start_ns : Nat64; window_end_ns : Nat64; duration_minutes : Nat32; candidate_starts_ns : [Nat64] };
    public type AvailabilityResultV1 = { revision : Nat64; available_starts_ns : [Nat64] };
    public type ReserveRequestV1 = { external_id : Blob; expected_revision : Nat64; start_ns : Nat64; duration_minutes : Nat32; meeting_label : Text; hold_expires_at_ns : Nat64 };
    public type ReserveResultV1 = { #reserved : { event_id : Nat64; event_revision : Nat64; calendar_revision : Nat64 }; #conflict : { calendar_revision : Nat64 }; #stale : { calendar_revision : Nat64 }; #invalid; #full };
    public type ExternalRequestV1 = { external_id : Blob };
    public type ExternalResultV1 = { #ok : { calendar_revision : Nat64 }; #not_found : { calendar_revision : Nat64 }; #invalid };
    public type AppBackendEnvironment = { stable_memory : { calendar : Memory.Mem } };

    public class Init(env : AppBackendEnvironment) {
        let mem = env.stable_memory.calendar;

        public func /*query*/calendar_status() : Status { { revision = mem.revision; event_count = activeOccurrences().size() } };
        public func /*query*/calendar_list(request : ListRequest) : EventPage {
            let values = activeOccurrences(); let (start, finish) = bounds(request.offset, request.limit, values.size(), Validation.MAX_PAGE);
            { revision = mem.revision; total = values.size(); events = Array.tabulate<EventView>(finish - start, func(index) { legacyView(values[start + index]) }) }
        };
        public func /*query*/calendar_range_v2(request : RangeRequest) : RangePage {
            if (not validRange(request.start_ns, request.end_ns)) return { revision = mem.revision; total = 0; occurrences = [] };
            let values = Array.sort<Memory.Occurrence>(Array.filter<Memory.Occurrence>(activeOccurrences(), func(item) { item.start_ns < request.end_ns and request.start_ns < item.end_ns }), func(left, right) { Nat64.compare(left.start_ns, right.start_ns) });
            let (start, finish) = bounds(request.offset, request.limit, values.size(), MAX_RANGE_RESULTS);
            { revision = mem.revision; total = values.size(); occurrences = Array.tabulate<OccurrenceView>(finish - start, func(index) { occurrenceView(values[start + index]) }) }
        };
        public func /*query*/calendar_series_get_v2(request : { series_id : Nat64 }) : ?SeriesView { switch (findSeries(request.series_id)) { case (?(_, item)) ?seriesView(item); case null null } };
        public func /*query*/calendar_series_occurrences_v2(request : SeriesOccurrencesRequest) : SeriesOccurrencesPage {
            let values = Array.sort<Memory.Occurrence>(Array.filter<Memory.Occurrence>(mem.occurrences, func(item) { item.series_id == request.series_id }), func(left, right) { Nat64.compare(left.start_ns, right.start_ns) });
            let (start, finish) = bounds(request.offset, request.limit, values.size(), MAX_SERIES_OCCURRENCES);
            { revision = mem.revision; total = values.size(); occurrences = Array.tabulate<OccurrenceView>(finish - start, func(index) { occurrenceView(values[start + index]) }) }
        };

        public func /*update*/calendar_series_create_v2(request : SeriesCreateRequest) : SeriesResult {
            if (request.expected_revision != mem.revision) return #err(error("stale", "Calendar changed", mem.revision));
            switch (validateSeriesWrite(request.value, 0)) { case (?problem) return #err(problem); case null {} };
            let now = nowNs(); let id = mem.next_series_id;
            let item : Memory.EventSeries = { id; revision = 1; title = request.value.title; notes = request.value.notes; location = request.value.location; color = request.value.color; availability = request.value.availability; kind = request.value.kind; source = #owner; time_zone = request.value.time_zone; recurrence = request.value.recurrence; created_at_ns = now; updated_at_ns = now };
            mem.next_series_id += 1; mem.series := Array.concat(mem.series, [item]);
            mem.occurrences := Array.concat(mem.occurrences, materialize(id, request.value.occurrences, [])); mem.revision += 1;
            #ok(seriesView(item))
        };
        public func /*update*/calendar_series_update_v2(request : SeriesUpdateRequest) : SeriesResult {
            let ?(index, current) = findSeries(request.series_id) else return #err(error("not_found", "Series not found", mem.revision));
            if (current.revision != request.expected_series_revision) return #err(error("stale", "Series changed", mem.revision));
            if (current.source != #owner) return #err(error("forbidden", "Rendezvous series cannot be edited here", mem.revision));
            let existing = Array.filter<Memory.Occurrence>(mem.occurrences, func(item) { item.series_id == current.id });
            switch (validateSeriesWrite(request.value, existing.size())) { case (?problem) return #err(problem); case null {} };
            let updated : Memory.EventSeries = { current with revision = current.revision + 1; title = request.value.title; notes = request.value.notes; location = request.value.location; color = request.value.color; availability = request.value.availability; kind = request.value.kind; time_zone = request.value.time_zone; recurrence = request.value.recurrence; updated_at_ns = nowNs() };
            mem.series := replaceAt(mem.series, index, updated);
            let other = Array.filter<Memory.Occurrence>(mem.occurrences, func(item) { item.series_id != current.id });
            mem.occurrences := Array.concat(other, materialize(current.id, request.value.occurrences, existing)); mem.revision += 1;
            #ok(seriesView(updated))
        };
        public func /*update*/calendar_series_remove_v2(request : SeriesRemoveRequest) : MutationResult {
            let ?(index, current) = findSeries(request.series_id) else return #err(error("not_found", "Series not found", mem.revision));
            if (current.revision != request.expected_series_revision) return #err(error("stale", "Series changed", mem.revision));
            if (current.source != #owner) return #err(error("forbidden", "Rendezvous series cannot be deleted here", mem.revision));
            mem.series := removeAt(mem.series, index); mem.occurrences := Array.filter<Memory.Occurrence>(mem.occurrences, func(item) { item.series_id != current.id }); mem.revision += 1; #ok({ revision = mem.revision })
        };
        public func /*update*/calendar_occurrence_update_v2(request : OccurrenceUpdateRequest) : OccurrenceResult {
            let ?(index, current) = findOccurrence(request.occurrence_id) else return #err(error("not_found", "Occurrence not found", mem.revision));
            if (current.revision != request.expected_occurrence_revision) return #err(error("stale", "Occurrence changed", mem.revision));
            let ?(_, owner) = findSeries(current.series_id) else return #err(error("corrupt", "Series missing", mem.revision));
            if (owner.source != #owner) return #err(error("forbidden", "Rendezvous occurrence cannot be edited here", mem.revision));
            if (not validOccurrence(request.start_ns, request.end_ns, current.recurrence_key) or not validOverrides(request.title_override, request.notes_override, request.location_override)) return #err(error("invalid", "Invalid occurrence fields", mem.revision));
            if (overlapsLiveHold(request.start_ns, request.end_ns, ?current.id)) return #err(error("conflict", "Occurrence overlaps a tentative meeting hold", mem.revision));
            let updated : Memory.Occurrence = {
                current with
                revision = current.revision + 1;
                start_ns = request.start_ns;
                end_ns = request.end_ns;
                status = #overridden;
                title_override = keepOverride(request.title_override, current.title_override);
                notes_override = keepOverride(request.notes_override, current.notes_override);
                location_override = keepOverride(request.location_override, current.location_override);
            };
            mem.occurrences := replaceAt(mem.occurrences, index, updated); mem.revision += 1; #ok(occurrenceView(updated))
        };
        public func /*update*/calendar_occurrence_remove_v2(request : OccurrenceRemoveRequest) : MutationResult {
            let ?(index, current) = findOccurrence(request.occurrence_id) else return #err(error("not_found", "Occurrence not found", mem.revision));
            if (current.revision != request.expected_occurrence_revision) return #err(error("stale", "Occurrence changed", mem.revision));
            let ?(_, owner) = findSeries(current.series_id) else return #err(error("corrupt", "Series missing", mem.revision));
            if (owner.source != #owner) return #err(error("forbidden", "Rendezvous occurrence cannot be deleted here", mem.revision));
            mem.occurrences := replaceAt(mem.occurrences, index, { current with revision = current.revision + 1; status = #cancelled }); mem.revision += 1; #ok({ revision = mem.revision })
        };

        public func /*update*/calendar_create(request : CreateRequest) : EventResult {
            if (request.expected_revision != mem.revision) return #err(error("stale", "Calendar changed", mem.revision));
            if (not validOwnerFields(request.start_ns, request.end_ns, request.title, request.notes) or overlapsLiveHold(request.start_ns, request.end_ns, null)) return #err(error("invalid", "Invalid event fields or tentative hold conflict", mem.revision));
            if (mem.series.size() >= MAX_SERIES or mem.occurrences.size() >= MAX_OCCURRENCES) return #err(error("full", "Calendar capacity reached", mem.revision));
            let now = nowNs(); let seriesId = mem.next_series_id; let occurrenceId = mem.next_occurrence_id;
            let series : Memory.EventSeries = { id = seriesId; revision = 1; title = request.title; notes = request.notes; location = ""; color = "sage"; availability = #busy; kind = #timed; source = #owner; time_zone = mem.preferences.display_time_zone; recurrence = null; created_at_ns = now; updated_at_ns = now };
            let occurrence : Memory.Occurrence = { id = occurrenceId; revision = 1; series_id = seriesId; recurrence_key = "once:" # Nat64.toText(occurrenceId); start_ns = request.start_ns; end_ns = request.end_ns; status = #normal; title_override = null; notes_override = null; location_override = null };
            mem.next_series_id += 1; mem.next_occurrence_id += 1; mem.series := Array.concat(mem.series, [series]); mem.occurrences := Array.concat(mem.occurrences, [occurrence]); mem.revision += 1; #ok(legacyView(occurrence))
        };
        public func /*update*/calendar_update(request : UpdateRequest) : EventResult {
            let ?(occurrenceIndex, occurrence) = findOccurrence(request.id) else return #err(error("not_found", "Event not found", mem.revision));
            if (occurrence.revision != request.expected_event_revision) return #err(error("stale", "Event changed", mem.revision));
            let ?(seriesIndex, series) = findSeries(occurrence.series_id) else return #err(error("corrupt", "Series missing", mem.revision));
            if (series.source != #owner) return #err(error("forbidden", "Rendezvous event cannot be edited here", mem.revision));
            if (not validOwnerFields(request.start_ns, request.end_ns, request.title, request.notes) or overlapsLiveHold(request.start_ns, request.end_ns, ?occurrence.id)) return #err(error("invalid", "Invalid event fields or tentative hold conflict", mem.revision));
            let nextOccurrence : Memory.Occurrence = { occurrence with revision = occurrence.revision + 1; start_ns = request.start_ns; end_ns = request.end_ns; status = if (series.recurrence == null) #normal else #overridden };
            let nextSeries : Memory.EventSeries = { series with revision = series.revision + 1; title = request.title; notes = request.notes; updated_at_ns = nowNs() };
            mem.occurrences := replaceAt(mem.occurrences, occurrenceIndex, nextOccurrence); mem.series := replaceAt(mem.series, seriesIndex, nextSeries); mem.revision += 1; #ok(legacyView(nextOccurrence))
        };
        public func /*update*/calendar_remove(request : RemoveRequest) : MutationResult {
            let ?(index, current) = findOccurrence(request.id) else return #err(error("not_found", "Event not found", mem.revision));
            if (current.revision != request.expected_event_revision) return #err(error("stale", "Event changed", mem.revision));
            mem.occurrences := removeAt(mem.occurrences, index);
            if (not Array.any<Memory.Occurrence>(mem.occurrences, func(item) { item.series_id == current.series_id })) mem.series := Array.filter<Memory.EventSeries>(mem.series, func(item) { item.id != current.series_id });
            mem.revision += 1; #ok({ revision = mem.revision })
        };

        public func /*query*/calendar_preferences_get() : PreferencesView { preferencesView() };
        public func /*update*/calendar_preferences_set(request : PreferencesSetRequest) : PreferencesResult {
            if (request.expected_revision != mem.revision) return #err(error("stale", "Calendar changed", mem.revision));
            if (not Validation.validPreferences(request.day_start_minute, request.day_end_minute, request.allowed_weekdays_mask, request.slot_increment_minutes, request.buffer_before_minutes, request.buffer_after_minutes, request.display_time_zone)) return #err(error("invalid", "Invalid scheduling preferences", mem.revision));
            mem.preferences := { day_start_minute = request.day_start_minute; day_end_minute = request.day_end_minute; allowed_weekdays_mask = request.allowed_weekdays_mask; slot_increment_minutes = request.slot_increment_minutes; buffer_before_minutes = request.buffer_before_minutes; buffer_after_minutes = request.buffer_after_minutes; display_time_zone = request.display_time_zone }; mem.revision += 1; #ok(preferencesView())
        };

        public func /*internal:apps*/calendar_availability_v1(request : AvailabilityRequestV1) : AvailabilityResultV1 { { revision = mem.revision; available_starts_ns = Availability.filter(mem.occurrences, mem.series, mem.preferences, nowNs(), request.window_start_ns, request.window_end_ns, request.duration_minutes, request.candidate_starts_ns) } };
        public func /*internal:apps*/calendar_reserve_v1(request : ReserveRequestV1) : ReserveResultV1 {
            if (not validExternalId(request.external_id) or not Validation.validDuration(request.duration_minutes) or not Validation.textWithin(request.meeting_label, Validation.MAX_TITLE_BYTES)) return #invalid;
            switch (findExternal(request.external_id)) { case (?(_, _, occurrence)) { let expectedEnd = Nat64.fromNat(Nat64.toNat(request.start_ns) + Nat32.toNat(request.duration_minutes) * Validation.MINUTE_NS); if (occurrence.start_ns == request.start_ns and occurrence.end_ns == expectedEnd) return #reserved({ event_id = occurrence.id; event_revision = occurrence.revision; calendar_revision = mem.revision }); return #conflict({ calendar_revision = mem.revision }) }; case null {} };
            if (request.expected_revision != mem.revision) return #stale({ calendar_revision = mem.revision });
            if (mem.series.size() >= MAX_SERIES or mem.occurrences.size() >= MAX_OCCURRENCES) return #full;
            if (request.hold_expires_at_ns <= nowNs() or not Availability.slotAvailable(mem.occurrences, mem.series, mem.preferences, nowNs(), request.start_ns, request.duration_minutes)) return #conflict({ calendar_revision = mem.revision });
            let seriesId = mem.next_series_id; let occurrenceId = mem.next_occurrence_id; let now = nowNs();
            let series : Memory.EventSeries = { id = seriesId; revision = 1; title = request.meeting_label; notes = ""; location = ""; color = "violet"; availability = #busy; kind = #timed; source = #rendezvous(request.external_id); time_zone = mem.preferences.display_time_zone; recurrence = null; created_at_ns = now; updated_at_ns = now };
            let occurrence : Memory.Occurrence = { id = occurrenceId; revision = 1; series_id = seriesId; recurrence_key = "meeting:" # Nat64.toText(occurrenceId); start_ns = request.start_ns; end_ns = Nat64.fromNat(Nat64.toNat(request.start_ns) + Nat32.toNat(request.duration_minutes) * Validation.MINUTE_NS); status = #hold(request.hold_expires_at_ns); title_override = null; notes_override = null; location_override = null };
            mem.next_series_id += 1; mem.next_occurrence_id += 1; mem.series := Array.concat(mem.series, [series]); mem.occurrences := Array.concat(mem.occurrences, [occurrence]); mem.revision += 1; #reserved({ event_id = occurrence.id; event_revision = occurrence.revision; calendar_revision = mem.revision })
        };
        public func /*internal:apps*/calendar_confirm_v1(request : ExternalRequestV1) : ExternalResultV1 {
            if (not validExternalId(request.external_id)) return #invalid;
            let ?(_, occurrenceIndex, occurrence) = findExternal(request.external_id) else return #not_found({ calendar_revision = mem.revision });
            switch (occurrence.status) { case (#confirmed) return #ok({ calendar_revision = mem.revision }); case (#hold(expires)) if (expires <= nowNs()) return #not_found({ calendar_revision = mem.revision }); case (_) {} };
            mem.occurrences := replaceAt(mem.occurrences, occurrenceIndex, { occurrence with revision = occurrence.revision + 1; status = #confirmed }); mem.revision += 1; #ok({ calendar_revision = mem.revision })
        };
        public func /*internal:apps*/calendar_release_v1(request : ExternalRequestV1) : ExternalResultV1 {
            if (not validExternalId(request.external_id)) return #invalid;
            let ?(seriesIndex, _, seriesOccurrence) = findExternal(request.external_id) else return #not_found({ calendar_revision = mem.revision });
            mem.series := removeAt(mem.series, seriesIndex); mem.occurrences := Array.filter<Memory.Occurrence>(mem.occurrences, func(item) { item.series_id != seriesOccurrence.series_id }); mem.revision += 1; #ok({ calendar_revision = mem.revision })
        };

        func validateSeriesWrite(value : SeriesWrite, replacing : Nat) : ?Error {
            if (mem.series.size() >= MAX_SERIES and replacing == 0) return ?error("full", "Series capacity reached", mem.revision);
            if (value.occurrences.size() == 0 or value.occurrences.size() > MAX_SERIES_OCCURRENCES or mem.occurrences.size() - replacing + value.occurrences.size() > MAX_OCCURRENCES) return ?error("full", "Occurrence capacity reached", mem.revision);
            if (value.title.size() == 0 or not Validation.textWithin(value.title, Validation.MAX_TITLE_BYTES) or not Validation.textWithin(value.notes, Validation.MAX_NOTES_BYTES) or not Validation.textWithin(value.location, 512) or not Validation.textWithin(value.color, 32) or not Validation.textWithin(value.time_zone, Validation.MAX_ZONE_BYTES)) return ?error("invalid", "Invalid series fields", mem.revision);
            switch (value.recurrence) { case (?rule) { if (not validRecurrence(rule, value.occurrences.size())) return ?error("invalid_recurrence", "Invalid recurrence rule", mem.revision) }; case (_) {} };
            var previousStart : ?Nat64 = null; var previousKey = "";
            for (item in value.occurrences.vals()) { if (not validOccurrence(item.start_ns, item.end_ns, item.recurrence_key)) return ?error("invalid_occurrence", "Invalid occurrence", mem.revision); switch (previousStart) { case (?start) { if (item.start_ns <= start or Text.compare(item.recurrence_key, previousKey) == #equal) return ?error("invalid_occurrence", "Occurrences must be ordered and unique", mem.revision) }; case (_) {} }; previousStart := ?item.start_ns; previousKey := item.recurrence_key };
            null
        };
        func validRecurrence(rule : RecurrenceRule, count : Nat) : Bool { rule.interval >= 1 and rule.interval <= 99 and (switch (rule.end) { case (#count(value)) value >= 1 and value <= 730 and Nat16.toNat(value) == count; case (#until(value)) value > 0 }) and (switch (rule.frequency) { case (#weekly) rule.weekdays_mask > 0; case (#monthly) switch (rule.month_day) { case (?day) day >= 1 and day <= 31; case null false }; case (_) true }) };
        func validOwnerFields(start : Nat64, finish : Nat64, title : Text, notes : Text) : Bool { Validation.validInterval(start, finish) and title.size() > 0 and Validation.textWithin(title, Validation.MAX_TITLE_BYTES) and Validation.textWithin(notes, Validation.MAX_NOTES_BYTES) };
        func validOccurrence(start : Nat64, finish : Nat64, key : Text) : Bool { Validation.validInterval(start, finish) and key.size() > 0 and Validation.textWithin(key, 64) };
        func validOverrides(title : ?Text, notes : ?Text, location : ?Text) : Bool { optionWithin(title, Validation.MAX_TITLE_BYTES) and optionWithin(notes, Validation.MAX_NOTES_BYTES) and optionWithin(location, 512) };
        func optionWithin(value : ?Text, limit : Nat) : Bool { switch (value) { case (?text) Validation.textWithin(text, limit); case null true } };
        func validRange(start : Nat64, finish : Nat64) : Bool { start < finish and Nat64.toNat(finish) - Nat64.toNat(start) <= 366 * Validation.DAY_NS };
        func overlapsLiveHold(start : Nat64, finish : Nat64, ignoredId : ?Nat64) : Bool { let now = nowNs(); Array.any<Memory.Occurrence>(mem.occurrences, func(item) { let ignored = switch (ignoredId) { case (?id) item.id == id; case null false }; not ignored and (switch (item.status) { case (#hold(expires)) expires > now; case (_) false }) and start < item.end_ns and item.start_ns < finish }) };
        func activeOccurrences() : [Memory.Occurrence] { let now = nowNs(); Array.filter<Memory.Occurrence>(mem.occurrences, func(item) { switch (item.status) { case (#cancelled) false; case (#hold(expires)) expires > now; case (_) true } }) };
        func findSeries(id : Nat64) : ?(Nat, Memory.EventSeries) { var index = 0; while (index < mem.series.size()) { if (mem.series[index].id == id) return ?(index, mem.series[index]); index += 1 }; null };
        func findOccurrence(id : Nat64) : ?(Nat, Memory.Occurrence) { var index = 0; while (index < mem.occurrences.size()) { if (mem.occurrences[index].id == id) return ?(index, mem.occurrences[index]); index += 1 }; null };
        func findExternal(id : Blob) : ?(Nat, Nat, Memory.Occurrence) { var seriesIndex = 0; while (seriesIndex < mem.series.size()) { switch (mem.series[seriesIndex].source) { case (#rendezvous(value)) if (value == id) { var occurrenceIndex = 0; while (occurrenceIndex < mem.occurrences.size()) { if (mem.occurrences[occurrenceIndex].series_id == mem.series[seriesIndex].id) return ?(seriesIndex, occurrenceIndex, mem.occurrences[occurrenceIndex]); occurrenceIndex += 1 } }; case (_) {} }; seriesIndex += 1 }; null };
        func materialize(seriesId : Nat64, inputs : [OccurrenceInput], existing : [Memory.Occurrence]) : [Memory.Occurrence] {
            Array.map<OccurrenceInput, Memory.Occurrence>(inputs, func(input) {
                switch (Array.find<Memory.Occurrence>(existing, func(item) { item.recurrence_key == input.recurrence_key })) {
                    case (?previous) {
                        switch (previous.status) {
                            case (#normal) { { previous with revision = previous.revision + 1; start_ns = input.start_ns; end_ns = input.end_ns } };
                            case (#overridden) { { previous with revision = previous.revision + 1 } };
                            case (#cancelled) { { previous with revision = previous.revision + 1 } };
                            case (#hold(_)) { { previous with revision = previous.revision + 1 } };
                            case (#confirmed) { { previous with revision = previous.revision + 1 } };
                        }
                    };
                    case null {
                        let id = mem.next_occurrence_id; mem.next_occurrence_id += 1;
                        let created : Memory.Occurrence = { id; revision = 1; series_id = seriesId; recurrence_key = input.recurrence_key; start_ns = input.start_ns; end_ns = input.end_ns; status = #normal; title_override = null; notes_override = null; location_override = null };
                        created
                    };
                }
            })
        };
        func keepOverride(requested : ?Text, existing : ?Text) : ?Text {
            switch (requested) { case (?value) ?value; case null existing }
        };
        func seriesView(item : Memory.EventSeries) : SeriesView { { id = item.id; revision = item.revision; title = item.title; notes = item.notes; location = item.location; color = item.color; availability = item.availability; kind = item.kind; source = sourceText(item.source); time_zone = item.time_zone; recurrence = item.recurrence; created_at_ns = item.created_at_ns; updated_at_ns = item.updated_at_ns } };
        func occurrenceView(item : Memory.Occurrence) : OccurrenceView { let ?(_, series) = findSeries(item.series_id) else { return { id = item.id; revision = item.revision; series_id = item.series_id; series_revision = 0; recurrence_key = item.recurrence_key; start_ns = item.start_ns; end_ns = item.end_ns; title = "Missing series"; notes = ""; location = ""; color = "sage"; availability = #free; kind = #timed; source = "corrupt"; status = "corrupt" } }; { id = item.id; revision = item.revision; series_id = series.id; series_revision = series.revision; recurrence_key = item.recurrence_key; start_ns = item.start_ns; end_ns = item.end_ns; title = switch (item.title_override) { case (?value) value; case null series.title }; notes = switch (item.notes_override) { case (?value) value; case null series.notes }; location = switch (item.location_override) { case (?value) value; case null series.location }; color = series.color; availability = series.availability; kind = series.kind; source = sourceText(series.source); status = statusText(item.status) } };
        func legacyView(item : Memory.Occurrence) : EventView { let view = occurrenceView(item); { id = view.id; revision = view.revision; start_ns = view.start_ns; end_ns = view.end_ns; title = view.title; notes = view.notes; source = view.source; status = view.status; hold_expires_at_ns = switch (item.status) { case (#hold(expires)) ?expires; case (_) null } } };
        func sourceText(value : Memory.SeriesSource) : Text { switch (value) { case (#owner) "owner"; case (#rendezvous(_)) "rendezvous" } };
        func statusText(value : Memory.OccurrenceStatus) : Text { switch (value) { case (#normal) "normal"; case (#overridden) "overridden"; case (#cancelled) "cancelled"; case (#hold(_)) "hold"; case (#confirmed) "confirmed" } };
        func preferencesView() : PreferencesView { { revision = mem.revision; day_start_minute = mem.preferences.day_start_minute; day_end_minute = mem.preferences.day_end_minute; allowed_weekdays_mask = mem.preferences.allowed_weekdays_mask; slot_increment_minutes = mem.preferences.slot_increment_minutes; buffer_before_minutes = mem.preferences.buffer_before_minutes; buffer_after_minutes = mem.preferences.buffer_after_minutes; display_time_zone = mem.preferences.display_time_zone } };
    };

    func nowNs() : Nat64 { Nat64.fromNat(Int.abs(Time.now())) };
    func validExternalId(value : Blob) : Bool { Blob.size(value) >= 16 and Blob.size(value) <= 32 };
    func error(code : Text, message : Text, revision : Nat64) : Error { { code; message; revision } };
    func bounds(offset : Nat, requested : Nat, size : Nat, maximum : Nat) : (Nat, Nat) { let limit = if (requested > maximum) maximum else requested; let start = if (offset > size) size else offset; let finish = if (start + limit > size) size else start + limit; (start, finish) };
    func replaceAt<T>(values : [T], index : Nat, value : T) : [T] { Array.tabulate<T>(values.size(), func(i) { if (i == index) value else values[i] }) };
    func removeAt<T>(values : [T], index : Nat) : [T] { Array.tabulate<T>(values.size() - 1, func(i) { if (i < index) values[i] else values[i + 1] }) };

/*---NEUTRON GENERATED BEGIN---*/

public type calendar_status_Input = ();
public type calendar_status_Output = Status;

public type calendar_list_Input = (request : ListRequest);
public type calendar_list_Output = EventPage;

public type calendar_range_v2_Input = (request : RangeRequest);
public type calendar_range_v2_Output = RangePage;

public type calendar_series_get_v2_Input = (request : { series_id : Nat64 });
public type calendar_series_get_v2_Output = ?SeriesView;

public type calendar_series_occurrences_v2_Input = (request : SeriesOccurrencesRequest);
public type calendar_series_occurrences_v2_Output = SeriesOccurrencesPage;

public type calendar_series_create_v2_Input = (request : SeriesCreateRequest);
public type calendar_series_create_v2_Output = SeriesResult;

public type calendar_series_update_v2_Input = (request : SeriesUpdateRequest);
public type calendar_series_update_v2_Output = SeriesResult;

public type calendar_series_remove_v2_Input = (request : SeriesRemoveRequest);
public type calendar_series_remove_v2_Output = MutationResult;

public type calendar_occurrence_update_v2_Input = (request : OccurrenceUpdateRequest);
public type calendar_occurrence_update_v2_Output = OccurrenceResult;

public type calendar_occurrence_remove_v2_Input = (request : OccurrenceRemoveRequest);
public type calendar_occurrence_remove_v2_Output = MutationResult;

public type calendar_create_Input = (request : CreateRequest);
public type calendar_create_Output = EventResult;

public type calendar_update_Input = (request : UpdateRequest);
public type calendar_update_Output = EventResult;

public type calendar_remove_Input = (request : RemoveRequest);
public type calendar_remove_Output = MutationResult;

public type calendar_preferences_get_Input = ();
public type calendar_preferences_get_Output = PreferencesView;

public type calendar_preferences_set_Input = (request : PreferencesSetRequest);
public type calendar_preferences_set_Output = PreferencesResult;

public type calendar_availability_v1_Input = (request : AvailabilityRequestV1);
public type calendar_availability_v1_Output = AvailabilityResultV1;

public type calendar_reserve_v1_Input = (request : ReserveRequestV1);
public type calendar_reserve_v1_Output = ReserveResultV1;

public type calendar_confirm_v1_Input = (request : ExternalRequestV1);
public type calendar_confirm_v1_Output = ExternalResultV1;

public type calendar_release_v1_Input = (request : ExternalRequestV1);
public type calendar_release_v1_Output = ExternalResultV1;

/*---NEUTRON GENERATED END---*/
}
