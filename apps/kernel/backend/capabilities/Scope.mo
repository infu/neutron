import Nat64 "mo:core/Nat64";
import Text "mo:core/Text";
import Types "Types";

module {
    public func equal(left : Types.AppScope, right : Types.AppScope) : Bool {
        left.app_id == right.app_id and
        left.installation_uid == right.installation_uid;
    };

    // Internal map key only. The NUL separator cannot occur in a valid app id.
    public func key(scope : Types.AppScope) : Text {
        scope.app_id # "\00" # Nat64.toText(scope.installation_uid);
    };

    public func validAppId(value : Text) : Bool {
        if (value.size() < 4 or value.size() > 30) return false;
        var first = true;
        var previousUnderscore = false;
        for (char in value.chars()) {
            if (
                (char >= 'a' and char <= 'z') or
                (char >= '0' and char <= '9')
            ) {
                first := false;
                previousUnderscore := false;
            } else if (char == '_') {
                if (first or previousUnderscore) return false;
                previousUnderscore := true;
            } else {
                return false;
            };
        };
        not previousUnderscore;
    };

    public func valid(scope : Types.AppScope) : Bool {
        scope.installation_uid > 0 and validAppId(scope.app_id);
    };
};
