import Array "mo:core/Array";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Memory "memory/calendar/v2";
import Validation "Validation";

module {
    public func filter(
        occurrences : [Memory.Occurrence],
        series : [Memory.EventSeries],
        preferences : Memory.Preferences,
        nowNs : Nat64,
        windowStart : Nat64,
        windowEnd : Nat64,
        durationMinutes : Nat32,
        candidates : [Nat64],
    ) : [Nat64] {
        if (not Validation.validInterval(windowStart, windowEnd) or not Validation.validDuration(durationMinutes) or candidates.size() > Validation.MAX_CANDIDATES) return [];
        let startBound = Nat64.toNat(windowStart); let endBound = Nat64.toNat(windowEnd);
        let durationNs = Nat32.toNat(durationMinutes) * Validation.MINUTE_NS; let now = Nat64.toNat(nowNs);
        var previous : ?Nat64 = null;
        Array.filter<Nat64>(candidates, func(candidate) {
            let start = Nat64.toNat(candidate);
            let duplicate = switch (previous) { case (?value) candidate <= value; case null false }; previous := ?candidate;
            if (duplicate or start < startBound or start < now or start > endBound) return false;
            let finish = start + durationNs;
            // Working hours are a suggestion policy interpreted in the owner's
            // browser time zone. They must not become a UTC authorization gate.
            if (finish > endBound) return false;
            not Array.any<Memory.Occurrence>(occurrences, func(occurrence) {
                occurrenceBlocks(occurrence, series, now) and overlaps(start, finish, occurrence, preferences)
            })
        })
    };

    public func slotAvailable(occurrences : [Memory.Occurrence], series : [Memory.EventSeries], preferences : Memory.Preferences, nowNs : Nat64, startNs : Nat64, durationMinutes : Nat32) : Bool {
        filter(occurrences, series, preferences, nowNs, startNs, Nat64.fromNat(Nat64.toNat(startNs) + Nat32.toNat(durationMinutes) * Validation.MINUTE_NS), durationMinutes, [startNs]).size() == 1
    };

    func occurrenceBlocks(occurrence : Memory.Occurrence, series : [Memory.EventSeries], now : Nat) : Bool {
        switch (occurrence.status) {
            case (#cancelled) return false;
            case (#hold(expires)) if (Nat64.toNat(expires) <= now) return false;
            case (_) {};
        };
        switch (Array.find<Memory.EventSeries>(series, func(item) { item.id == occurrence.series_id })) {
            case (?item) item.availability == #busy;
            case null false;
        }
    };

    func overlaps(start : Nat, finish : Nat, occurrence : Memory.Occurrence, preferences : Memory.Preferences) : Bool {
        let before = Nat16.toNat(preferences.buffer_before_minutes) * Validation.MINUTE_NS;
        let after = Nat16.toNat(preferences.buffer_after_minutes) * Validation.MINUTE_NS;
        let bufferedStart = if (start >= before) start - before else 0;
        bufferedStart < Nat64.toNat(occurrence.end_ns) and Nat64.toNat(occurrence.start_ns) < finish + after
    };
}
