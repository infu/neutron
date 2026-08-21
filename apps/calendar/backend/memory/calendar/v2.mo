// Persistent schema: keep immutable after Calendar 0.2.0 is released.
module {
    public type SeriesSource = { #owner; #rendezvous : Blob };
    public type Availability = { #busy; #free };
    public type EventKind = { #timed; #all_day };
    public type Frequency = { #daily; #weekly; #monthly; #yearly };
    public type RecurrenceEnd = { #count : Nat16; #until : Nat64 };
    public type RecurrenceRule = {
        frequency : Frequency;
        interval : Nat8;
        weekdays_mask : Nat8;
        month_day : ?Nat8;
        end : RecurrenceEnd;
    };

    public type EventSeries = {
        id : Nat64;
        revision : Nat64;
        title : Text;
        notes : Text;
        location : Text;
        color : Text;
        availability : Availability;
        kind : EventKind;
        source : SeriesSource;
        time_zone : Text;
        recurrence : ?RecurrenceRule;
        created_at_ns : Nat64;
        updated_at_ns : Nat64;
    };

    public type OccurrenceStatus = {
        #normal;
        #overridden;
        #cancelled;
        #hold : Nat64;
        #confirmed;
    };

    public type Occurrence = {
        id : Nat64;
        revision : Nat64;
        series_id : Nat64;
        recurrence_key : Text;
        start_ns : Nat64;
        end_ns : Nat64;
        status : OccurrenceStatus;
        title_override : ?Text;
        notes_override : ?Text;
        location_override : ?Text;
    };

    public type Preferences = {
        day_start_minute : Nat16;
        day_end_minute : Nat16;
        allowed_weekdays_mask : Nat8;
        slot_increment_minutes : Nat16;
        buffer_before_minutes : Nat16;
        buffer_after_minutes : Nat16;
        display_time_zone : Text;
    };

    public type Mem = {
        var revision : Nat64;
        var next_series_id : Nat64;
        var next_occurrence_id : Nat64;
        var series : [EventSeries];
        var occurrences : [Occurrence];
        var preferences : Preferences;
    };

    public func init() : Mem {
        {
            var revision = 0;
            var next_series_id = 1;
            var next_occurrence_id = 1;
            var series = [];
            var occurrences = [];
            var preferences = {
                day_start_minute = 540;
                day_end_minute = 1_020;
                allowed_weekdays_mask = 62;
                slot_increment_minutes = 15;
                buffer_before_minutes = 0;
                buffer_after_minutes = 0;
                display_time_zone = "UTC";
            };
        };
    };
}
