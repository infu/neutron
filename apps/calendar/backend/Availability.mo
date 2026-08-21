import Array "mo:core/Array";
import Nat8 "mo:core/Nat8";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Memory "memory/calendar/v1";
import Validation "Validation";

module {
    public func filter(
        events : [Memory.Event],
        preferences : Memory.Preferences,
        nowNs : Nat64,
        windowStart : Nat64,
        windowEnd : Nat64,
        durationMinutes : Nat32,
        candidates : [Nat64],
    ) : [Nat64] {
        if (not Validation.validInterval(windowStart, windowEnd)) return [];
        if (not Validation.validDuration(durationMinutes)) return [];
        if (candidates.size() > Validation.MAX_CANDIDATES) return [];

        let startBound = Nat64.toNat(windowStart);
        let endBound = Nat64.toNat(windowEnd);
        let durationNs = Nat32.toNat(durationMinutes) * Validation.MINUTE_NS;
        let now = Nat64.toNat(nowNs);
        var previous : ?Nat64 = null;

        Array.filter<Nat64>(candidates, func(candidate) {
            let start = Nat64.toNat(candidate);
            let duplicate = switch (previous) { case (?value) candidate <= value; case null false };
            previous := ?candidate;
            if (duplicate or start < startBound or start < now or start > endBound) return false;
            let finish = start + durationNs;
            if (finish > endBound or not withinPreferences(start, finish, preferences)) return false;
            not Array.any<Memory.Event>(events, func(event) {
                blocks(event, now) and overlaps(start, finish, event, preferences);
            });
        });
    };

    public func slotAvailable(
        events : [Memory.Event],
        preferences : Memory.Preferences,
        nowNs : Nat64,
        startNs : Nat64,
        durationMinutes : Nat32,
    ) : Bool {
        filter(events, preferences, nowNs, startNs, Nat64.fromNat(Nat64.toNat(startNs) + Nat32.toNat(durationMinutes) * Validation.MINUTE_NS), durationMinutes, [startNs]).size() == 1;
    };

    func blocks(event : Memory.Event, now : Nat) : Bool {
        switch (event.status) {
            case (#confirmed) true;
            case (#hold(expires)) Nat64.toNat(expires) > now;
        };
    };

    func overlaps(start : Nat, finish : Nat, event : Memory.Event, preferences : Memory.Preferences) : Bool {
        let before = Nat16.toNat(preferences.buffer_before_minutes) * Validation.MINUTE_NS;
        let after = Nat16.toNat(preferences.buffer_after_minutes) * Validation.MINUTE_NS;
        let bufferedStart = if (start >= before) start - before else 0;
        let bufferedFinish = finish + after;
        bufferedStart < Nat64.toNat(event.end_ns) and Nat64.toNat(event.start_ns) < bufferedFinish;
    };

    func withinPreferences(start : Nat, finish : Nat, preferences : Memory.Preferences) : Bool {
        let startDay = start / Validation.DAY_NS;
        let finishDay = (finish - 1) / Validation.DAY_NS;
        if (startDay != finishDay) return false;
        let weekday = (startDay + 4) % 7;
        let weekdayBit = 2 ** weekday;
        if ((Nat8.toNat(preferences.allowed_weekdays_mask) / weekdayBit) % 2 == 0) return false;
        let startMinute = (start % Validation.DAY_NS) / Validation.MINUTE_NS;
        let finishMinute = ((finish - 1) % Validation.DAY_NS) / Validation.MINUTE_NS + 1;
        let increment = Nat16.toNat(preferences.slot_increment_minutes);
        startMinute >= Nat16.toNat(preferences.day_start_minute) and
        finishMinute <= Nat16.toNat(preferences.day_end_minute) and
        startMinute % increment == 0;
    };
}
