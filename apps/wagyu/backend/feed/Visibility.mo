import Principal "mo:core/Principal";

module {
    public type IsBlocked = Principal -> Bool;

    // Render callers may conservatively provide a claimed semantic author;
    // promotion callers provide the browser-verified author. Suppression
    // controls remain processable so content cannot reappear after unblock.
    public func allows(
        immediateSender : Principal,
        semanticAuthor : ?Principal,
        suppressionControl : Bool,
        isBlocked : IsBlocked,
    ) : Bool {
        if (suppressionControl) return true;
        if (isBlocked(immediateSender)) return false;
        switch (semanticAuthor) {
            case null true;
            case (?author) not isBlocked(author);
        };
    };
};
