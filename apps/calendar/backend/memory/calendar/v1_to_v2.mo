import Array "mo:core/Array";
import Int "mo:core/Int";
import Nat64 "mo:core/Nat64";
import Time "mo:core/Time";
import V1 "./v1";
import V2 "./v2";

module {
    public func migrate(old : V1.Mem) : V2.Mem {
        let now = Nat64.fromNat(Int.abs(Time.now()));
        let retained = Array.filter<V1.Event>(old.events, func(event) {
            switch (event.status) {
                case (#confirmed) true;
                case (#hold(expires)) expires > now;
            }
        });
        let series = Array.map<V1.Event, V2.EventSeries>(retained, func(event) {
            {
                id = event.id;
                revision = event.revision;
                title = event.title;
                notes = event.notes;
                location = "";
                color = "sage";
                availability = #busy;
                kind = #timed;
                source = switch (event.source) { case (#owner) #owner; case (#rendezvous(id)) #rendezvous(id) };
                time_zone = old.preferences.display_time_zone;
                recurrence = null;
                created_at_ns = 0;
                updated_at_ns = 0;
            }
        });
        let occurrences = Array.map<V1.Event, V2.Occurrence>(retained, func(event) {
            {
                id = event.id;
                revision = event.revision;
                series_id = event.id;
                recurrence_key = "legacy:" # Nat64.toText(event.id);
                start_ns = event.start_ns;
                end_ns = event.end_ns;
                status = switch (event.status) {
                    case (#hold(expires)) #hold(expires);
                    case (#confirmed) switch (event.source) { case (#owner) #normal; case (#rendezvous(_)) #confirmed };
                };
                title_override = null;
                notes_override = null;
                location_override = null;
            }
        });
        {
            var revision = old.revision;
            var next_series_id = old.next_event_id;
            var next_occurrence_id = old.next_event_id;
            var series;
            var occurrences;
            var preferences = old.preferences;
        }
    };
}
