import Nat "mo:core/Nat";

module {
    public type Scan<Cursor> = {
        cursor : ?Cursor;
        pages : Nat;
        // Count wire entries, not only entries retained after filtering.
        entries : Nat;
    };

    public type Limits = {
        max_page_entries : Nat;
        max_scan_pages : Nat;
        max_scan_entries : Nat;
    };

    public type Result<T> = {
        #ok : T;
        #err : Text;
    };

    public func start<Cursor>() : Scan<Cursor> {
        {
            cursor = null;
            pages = 0;
            entries = 0;
        };
    };

    public func effectiveTake<Cursor>(
        subject : Text,
        scan : Scan<Cursor>,
        requested : Nat,
        limits : Limits,
    ) : Result<Nat> {
        if (requested == 0 or requested > limits.max_page_entries) {
            return #err(subject # " page size is outside the Wallet limit");
        };
        if (scan.pages >= limits.max_scan_pages) {
            return #err(subject # " scan exceeds the Wallet page limit");
        };
        if (scan.entries >= limits.max_scan_entries) {
            return #err(subject # " scan exceeds the Wallet entry limit");
        };
        if (scan.pages == 0) {
            let hasCursor = switch (scan.cursor) {
                case null false;
                case (?_) true;
            };
            if (scan.entries != 0 or hasCursor) {
                return #err("Invalid initial " # subject # " scan");
            };
        } else {
            switch (scan.cursor) {
                case null return #err(subject # " scan is already complete");
                case (?_) {};
            };
        };
        #ok(Nat.min(requested, limits.max_scan_entries - scan.entries));
    };
};
