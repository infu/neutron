import List "mo:core/List";
import Nat64 "mo:core/Nat64";

import Types "../relationships/Types";

module {
    // Kept equal to the V1 relationship service limit. The extra row is a
    // structural lookahead only and is never included in the returned page.
    public let BATCH_LIMIT : Nat = 20;
    public let MAX_PAGE : Nat = 21;

    public type Entry = {
        registration_sequence : Nat64;
        // The relationship service supplies a target only after validating
        // the authoritative row and evaluating current eligibility.
        target : ?Types.FanoutTarget;
    };

    // Plans one already registration-ordered page without sorting or
    // materializing the complete follower table. `afterSequence` is
    // exclusive. The page source must include one lookahead row whenever one
    // exists, including a row beyond the frozen snapshot cutoff.
    public func plan(
        snapshot : Types.FanoutSnapshot,
        afterSequence : ?Nat64,
        entries : [Entry],
    ) : Types.FanoutResult {
        if (
            (switch (afterSequence) {
                case (?value) value >
                    snapshot.cutoff_registration_sequence;
                case null false;
            })
        ) return #err(#invalid_cursor);
        if (entries.size() > MAX_PAGE) return #err(#corrupt_state);

        var previous = afterSequence;
        for (entry in entries.vals()) {
            if (entry.registration_sequence == 0) {
                return #err(#corrupt_state);
            };
            switch (previous) {
                case (?value) {
                    if (entry.registration_sequence <= value) {
                        return #err(#corrupt_state);
                    };
                };
                case null {};
            };
            switch (entry.target) {
                case null {};
                case (?target) {
                    if (
                        target.registration_sequence !=
                        entry.registration_sequence
                    ) return #err(#corrupt_state);
                };
            };
            previous := ?entry.registration_sequence;
        };

        let targets = List.empty<Types.FanoutTarget>();
        var scanned = 0;
        var nextAfter : ?Nat64 = null;
        var complete = true;

        label scan for (entry in entries.vals()) {
            // A page source need not apply the snapshot cutoff itself. Since
            // the rows are ascending, this row proves the snapshot is done.
            if (
                entry.registration_sequence >
                snapshot.cutoff_registration_sequence
            ) break scan;
            if (scanned >= BATCH_LIMIT) {
                complete := false;
                break scan;
            };

            scanned += 1;
            nextAfter := ?entry.registration_sequence;
            switch (entry.target) {
                case null {};
                case (?target) {
                    List.add(targets, target);
                };
            };
        };

        #ok({
            snapshot;
            targets = List.toArray(targets);
            next_after_sequence = nextAfter;
            complete;
        });
    };
};
