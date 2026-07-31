import List "mo:core/List";
import Map "mo:core/Map";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";

module {
    public let MAX_PAGE_SIZE : Nat = 50;

    public type Page<K, V> = {
        entries : [(K, V)];
        next_before : ?K;
    };

    public type PrincipalPage = {
        nodes : [Principal];
        next_before : ?Principal;
    };

    // The map iterator starts at the cursor inclusively when that key exists.
    // Skipping equality makes every returned page strictly older than the
    // previous page's last key. One extra row is consumed only as lookahead,
    // so a full terminal page does not claim a continuation.
    public func descendingNat64<V>(
        source : Map.Map<Nat64, V>,
        before : ?Nat64,
        limit : Nat,
    ) : Page<Nat64, V> {
        let iterator = switch (before) {
            case null Map.reverseEntries(source);
            case (?cursor) {
                Map.reverseEntriesFrom(source, Nat64.compare, cursor);
            };
        };
        let values = List.empty<(Nat64, V)>();
        var hasMore = false;
        label scan for ((key, value) in iterator) {
            switch (before) {
                case (?cursor) {
                    if (key == cursor) continue scan;
                };
                case null {};
            };
            if (List.size(values) >= limit) {
                hasMore := true;
                break scan;
            };
            List.add(values, (key, value));
        };
        let entries = List.toArray(values);
        {
            entries;
            next_before =
                if (hasMore and entries.size() > 0) {
                    ?entries[entries.size() - 1].0;
                } else null;
        };
    };

    // Relationships live in three independently ordered maps. This bounded
    // three-way merge returns the descending union without materializing or
    // scanning any map beyond the requested page plus one distinct peer.
    public func descendingPrincipalUnion<A, B, C>(
        first : Map.Map<Principal, A>,
        second : Map.Map<Principal, B>,
        third : Map.Map<Principal, C>,
        before : ?Principal,
        limit : Nat,
    ) : PrincipalPage {
        let firstEntries = switch (before) {
            case null Map.reverseEntries(first);
            case (?cursor) {
                Map.reverseEntriesFrom(first, Principal.compare, cursor);
            };
        };
        let secondEntries = switch (before) {
            case null Map.reverseEntries(second);
            case (?cursor) {
                Map.reverseEntriesFrom(second, Principal.compare, cursor);
            };
        };
        let thirdEntries = switch (before) {
            case null Map.reverseEntries(third);
            case (?cursor) {
                Map.reverseEntriesFrom(third, Principal.compare, cursor);
            };
        };

        func nextFirst() : ?Principal {
            switch (firstEntries.next()) {
                case null null;
                case (?(key, _)) {
                    switch (before) {
                        case (?cursor) {
                            if (Principal.equal(key, cursor)) {
                                nextFirst();
                            } else ?key;
                        };
                        case null ?key;
                    };
                };
            };
        };
        func nextSecond() : ?Principal {
            switch (secondEntries.next()) {
                case null null;
                case (?(key, _)) {
                    switch (before) {
                        case (?cursor) {
                            if (Principal.equal(key, cursor)) {
                                nextSecond();
                            } else ?key;
                        };
                        case null ?key;
                    };
                };
            };
        };
        func nextThird() : ?Principal {
            switch (thirdEntries.next()) {
                case null null;
                case (?(key, _)) {
                    switch (before) {
                        case (?cursor) {
                            if (Principal.equal(key, cursor)) {
                                nextThird();
                            } else ?key;
                        };
                        case null ?key;
                    };
                };
            };
        };
        func higher(
            left : ?Principal,
            right : ?Principal,
        ) : ?Principal {
            switch (left, right) {
                case (null, null) null;
                case (?value, null) ?value;
                case (null, ?value) ?value;
                case (?leftValue, ?rightValue) {
                    switch (
                        Principal.compare(leftValue, rightValue)
                    ) {
                        case (#less) ?rightValue;
                        case (#equal or #greater) ?leftValue;
                    };
                };
            };
        };

        var firstHead = nextFirst();
        var secondHead = nextSecond();
        var thirdHead = nextThird();
        let nodes = List.empty<Principal>();
        var hasMore = false;
        label merge loop {
            let candidate = higher(
                higher(firstHead, secondHead),
                thirdHead,
            );
            let ?node = candidate else break merge;
            if (List.size(nodes) >= limit) {
                hasMore := true;
                break merge;
            };
            List.add(nodes, node);
            switch (firstHead) {
                case (?value) {
                    if (Principal.equal(value, node)) {
                        firstHead := nextFirst();
                    };
                };
                case null {};
            };
            switch (secondHead) {
                case (?value) {
                    if (Principal.equal(value, node)) {
                        secondHead := nextSecond();
                    };
                };
                case null {};
            };
            switch (thirdHead) {
                case (?value) {
                    if (Principal.equal(value, node)) {
                        thirdHead := nextThird();
                    };
                };
                case null {};
            };
        };
        let values = List.toArray(nodes);
        {
            nodes = values;
            next_before =
                if (hasMore and values.size() > 0) {
                    ?values[values.size() - 1];
                } else null;
        };
    };
};
