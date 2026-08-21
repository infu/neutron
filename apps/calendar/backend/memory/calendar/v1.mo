// Persistent schema: keep immutable after Calendar 0.1.0 is released.
module {
    public type EventSource = { #owner; #rendezvous : Blob };
    public type EventStatus = { #confirmed; #hold : Nat64 };

    public type Event = {
        id : Nat64;
        revision : Nat64;
        start_ns : Nat64;
        end_ns : Nat64;
        title : Text;
        notes : Text;
        source : EventSource;
        status : EventStatus;
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
        var next_event_id : Nat64;
        var events : [Event];
        var preferences : Preferences;
    };

    public func init() : Mem {
        {
            var revision = 0;
            var next_event_id = 1;
            var events = [];
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
