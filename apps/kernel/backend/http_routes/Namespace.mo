import Text "mo:core/Text";
import CapabilityScope "../capabilities/Scope";
import GatewayAuthority "GatewayAuthority";

module {
    public type Surface = {
        #app_host;
        #shared_app_path;
    };

    public type SharedTarget = {
        app_id : Text;
        mount_id : Text;
    };

    public let SHARED_ROUTE_SEGMENT : Text = "_route";

    public func parseSurface(value : Text) : ?Surface {
        if (value == "app_host") return ?#app_host;
        if (value == "shared_app_path") return ?#shared_app_path;
        null;
    };

    public func surfaceText(surface : Surface) : Text {
        switch (surface) {
            case (#app_host) "app_host";
            case (#shared_app_path) "shared_app_path";
        };
    };

    public func publicPrefix(
        surface : Surface,
        appId : Text,
        mountId : Text,
        authoredPrefix : ?Text,
    ) : ?Text {
        if (not validAppId(appId) or not validMountId(mountId)) return null;
        switch (surface) {
            case (#app_host) {
                let ?prefix = authoredPrefix else return null;
                if (not validAppHostPrefix(prefix)) return null;
                ?prefix;
            };
            case (#shared_app_path) {
                if (authoredPrefix != null) return null;
                ?sharedPrefix(appId, mountId);
            };
        };
    };

    public func sharedPrefix(appId : Text, mountId : Text) : Text {
        "/app/" # appId # "/" # SHARED_ROUTE_SEGMENT # "/" # mountId;
    };

    public func sharedTarget(url : Text) : ?SharedTarget {
        let ?rest = Text.stripStart(url, #text "/app/") else return null;
        let segments = Text.split(rest, #char '/');
        let ?appId = segments.next() else return null;
        let ?marker = segments.next() else return null;
        let ?mountId = segments.next() else return null;
        if (
            marker != SHARED_ROUTE_SEGMENT or
            not validAppId(appId) or
            not validMountId(mountId)
        ) return null;
        ?{ app_id = appId; mount_id = mountId };
    };

    public func isSharedRoutePath(url : Text) : Bool {
        sharedTarget(url) != null;
    };

    public func contains(prefix : Text, url : Text) : Bool {
        url == prefix or Text.startsWith(url, #text (prefix # "/"));
    };

    public func relativePath(prefix : Text, url : Text) : ?Text {
        if (not contains(prefix, url)) return null;
        Text.stripStart(url, #text prefix);
    };

    public func authorities(
        surface : Surface,
        canisterId : Text,
        appId : Text,
    ) : [Text] {
        let hostLabel = switch (surface) {
            case (#app_host) appOriginPrefix(appId) # "--" # canisterId;
            case (#shared_app_path) canisterId;
        };
        GatewayAuthority.canisterAuthorities(hostLabel);
    };

    public func isSharedAuthority(canisterId : Text, authority : Text) : Bool {
        // This shared-route surface owns its exact allow policy. Parsing a
        // canonical authority never grants route access by itself.
        authority == GatewayAuthority.icAuthority(canisterId) or
        authority == GatewayAuthority.localAuthority(canisterId);
    };

    public func appOriginPrefix(appId : Text) : Text {
        "a" # Text.map(appId, func(char) { if (char == '_') '-' else char }) # "a";
    };

    public func validAppId(value : Text) : Bool {
        CapabilityScope.validAppId(value);
    };

    public func validMountId(value : Text) : Bool {
        if (value.size() < 1 or value.size() > 40) return false;
        var first = true;
        for (char in value.chars()) {
            if (first) {
                if (char < 'a' or char > 'z') return false;
                first := false;
            } else if (not (
                (char >= 'a' and char <= 'z') or
                (char >= '0' and char <= '9') or char == '_'
            )) return false;
        };
        true;
    };

    public func validAppHostPrefix(value : Text) : Bool {
        if (value == "/" or value.size() > 256 or not validAbsolutePath(value)) {
            return false;
        };
        for (reserved in ["/app", "/system", "/pkg", "/mo", "/.well-known"].vals()) {
            if (value == reserved or Text.startsWith(value, #text (reserved # "/"))) {
                return false;
            };
        };
        true;
    };

    public func validAbsolutePath(value : Text) : Bool {
        if (
            not Text.startsWith(value, #char '/') or
            Text.endsWith(value, #char '/') or
            Text.contains(value, #text "//")
        ) return false;
        var segments = 0;
        for (segment in Text.split(value, #char '/')) {
            if (segment != "") {
                if (segment == "." or segment == "..") return false;
                for (char in segment.chars()) if (not safePathChar(char)) return false;
                segments += 1;
                if (segments > 64) return false;
            };
        };
        segments > 0;
    };

    public func validPassiveContentType(value : Text) : Bool {
        value == "application/json" or
        value == "application/json; charset=utf-8" or
        value == "application/cbor" or
        value == "application/octet-stream" or
        value == "text/plain" or
        value == "text/plain; charset=utf-8" or
        value == "text/markdown" or
        value == "text/markdown; charset=utf-8";
    };

    func safePathChar(char : Char) : Bool {
        (char >= 'a' and char <= 'z') or (char >= 'A' and char <= 'Z') or
        (char >= '0' and char <= '9') or char == '-' or char == '_' or
        char == '.' or char == '~';
    };
};
