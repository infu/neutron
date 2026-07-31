import List "mo:core/List";
import Nat64 "mo:core/Nat64";

module {
    // Kept equal to the V1 outbox service limits. The extra page entry is a
    // structural lookahead only and is never counted as scanned.
    public let MAX_BATCH : Nat = 20;
    public let MAX_SCAN : Nat = 200;
    public let MAX_PAGE : Nat = 201;

    // Ordered lexicographically by (next_attempt_at_ns, local_id).
    public type Key = (Nat64, Nat64);

    // `ready` is supplied only after the caller has joined the index entry to
    // the authoritative outbox row and applied the requested drain mode.
    public type Entry = {
        key : Key;
        ready : Bool;
    };

    public type Plan = {
        local_ids : [Nat64];
        next_after : ?Key;
        scanned : Nat;
        // True means there is no later due entry for this `now_ns` in the
        // supplied ordered page. A page source must include one lookahead row
        // whenever another index entry exists.
        complete : Bool;
    };

    public type Error = {
        #invalid_cursor;
        #corrupt_page;
    };

    public type Result = {
        #ok : Plan;
        #err : Error;
    };

    // Plans from a bounded, ascending due-index page. `after` is exclusive.
    // Ineligible due rows still advance the cursor, preventing a run of
    // manual or stale index entries from pinning automatic work behind it.
    public func plan(
        entries : [Entry],
        after : ?Key,
        nowNs : Nat64,
    ) : Result {
        switch (after) {
            case (?key) {
                if (key.1 == 0) return #err(#invalid_cursor);
            };
            case null {};
        };
        if (entries.size() > MAX_PAGE) return #err(#corrupt_page);

        var previous = after;
        let seenLocalIds = List.empty<Nat64>();
        for (entry in entries.vals()) {
            if (entry.key.1 == 0) return #err(#corrupt_page);
            switch (previous) {
                case (?key) {
                    if (not strictlyAfter(entry.key, key)) {
                        return #err(#corrupt_page);
                    };
                };
                case null {};
            };
            for (localId in List.values(seenLocalIds)) {
                if (localId == entry.key.1) return #err(#corrupt_page);
            };
            List.add(seenLocalIds, entry.key.1);
            previous := ?entry.key;
        };

        let selected = List.empty<Nat64>();
        var selectedCount = 0;
        var scanned = 0;
        var nextAfter : ?Key = null;
        var complete = true;

        label scan for (entry in entries.vals()) {
            // Since the index is ascending, no later entry can be due yet.
            if (entry.key.0 > nowNs) break scan;
            if (scanned >= MAX_SCAN or selectedCount >= MAX_BATCH) {
                complete := false;
                break scan;
            };

            scanned += 1;
            nextAfter := ?entry.key;
            if (entry.ready) {
                List.add(selected, entry.key.1);
                selectedCount += 1;
            };
        };

        #ok({
            local_ids = List.toArray(selected);
            next_after = nextAfter;
            scanned;
            complete;
        });
    };

    func strictlyAfter(left : Key, right : Key) : Bool {
        left.0 > right.0 or
        (left.0 == right.0 and left.1 > right.1);
    };
};
