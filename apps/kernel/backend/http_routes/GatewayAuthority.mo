import Char "mo:core/Char";
import Nat32 "mo:core/Nat32";
import Text "mo:core/Text";

module {
    public type Authority = {
        authority : Text;
        hostname : Text;
        host_label : Text;
        port : ?Text;
        raw_gateway : Bool;
    };

    public type RequestAuthority = {
        #invalid;
        #missing;
        // Syntactically canonical, not authorized. The consuming surface must
        // still apply its own exact allow policy.
        #present : Authority;
    };

    // One verified IC authority and one fixed PocketIC development authority.
    // Callers still decide whether either authority is allowed for their own
    // surface; this module only constructs and parses their canonical form.
    public let CANISTER_AUTHORITY_VARIANTS : Nat = 2;
    public let CANISTER_AUTHORITY_VARIANTS_MAX : Nat = 2;

    public func canisterAuthorities(hostLabel : Text) : [Text] {
        assert (validHostnameLabel(hostLabel));
        let authorities = [
            icAuthority(hostLabel),
            localAuthority(hostLabel),
        ];
        assert (
            authorities.size() == CANISTER_AUTHORITY_VARIANTS and
            authorities.size() <= CANISTER_AUTHORITY_VARIANTS_MAX
        );
        for (authority in authorities.vals()) {
            assert (parseCanonical(authority) != null);
        };
        authorities;
    };

    public func icAuthority(hostLabel : Text) : Text {
        assert (validHostnameLabel(hostLabel));
        hostLabel # ".icp0.io";
    };

    public func localAuthority(hostLabel : Text) : Text {
        assert (validHostnameLabel(hostLabel));
        hostLabel # ".localhost:8000";
    };

    public func parseCanonical(value : Text) : ?Authority {
        if (value == "" or Text.encodeUtf8(value).size() > 260) return null;
        if (value != Text.toLower(value)) return null;

        let parts = Text.split(value, #char ':');
        let ?hostname = parts.next() else return null;
        if (not validHostname(hostname)) return null;
        let port = switch (parts.next()) {
            case null null;
            case (?candidate) {
                if (parts.next() != null or not validCanonicalPort(candidate)) {
                    return null;
                };
                ?candidate;
            };
        };
        let hostnameParts = Text.split(hostname, #char '.');
        let ?hostLabel = hostnameParts.next() else return null;
        ?{
            authority = value;
            hostname;
            host_label = hostLabel;
            port;
            raw_gateway = isRawGatewayHostname(hostname);
        };
    };

    // `X-Forwarded-Host` is deliberately ignored: only the gateway-delivered
    // Host field participates in routing and request certification.
    public func fromHeaders(headers : [(Text, Text)]) : RequestAuthority {
        var parsed : ?Authority = null;
        for ((name, value) in headers.vals()) {
            if (Text.toLower(name) == "host") {
                if (parsed != null) return #invalid;
                let ?authority = parseCanonical(value) else return #invalid;
                parsed := ?authority;
            };
        };
        switch (parsed) {
            case (?authority) #present(authority);
            case null #missing;
        };
    };

    func validHostname(value : Text) : Bool {
        if (
            value.size() < 1 or value.size() > 253 or
            Text.startsWith(value, #char '.') or
            Text.endsWith(value, #char '.')
        ) return false;
        var count : Nat = 0;
        for (part in Text.split(value, #char '.')) {
            if (not validHostnameLabel(part)) return false;
            count += 1;
        };
        count > 0;
    };

    func validHostnameLabel(value : Text) : Bool {
        if (
            value.size() < 1 or value.size() > 63 or
            Text.startsWith(value, #char '-') or
            Text.endsWith(value, #char '-')
        ) return false;
        for (char in value.chars()) {
            if (not (
                (char >= 'a' and char <= 'z') or
                (char >= '0' and char <= '9') or
                char == '-'
            )) return false;
        };
        true;
    };

    func validCanonicalPort(value : Text) : Bool {
        if (
            value.size() < 1 or value.size() > 5 or
            (value.size() > 1 and Text.startsWith(value, #char '0'))
        ) return false;
        var port : Nat = 0;
        for (char in value.chars()) {
            if (char < '0' or char > '9') return false;
            port := port * 10 +
                Nat32.toNat(Char.toNat32(char) - Char.toNat32('0'));
            if (port > 65_535) return false;
        };
        true;
    };

    func isRawGatewayHostname(hostname : Text) : Bool {
        Text.endsWith(hostname, #text ".raw.icp0.io") or
        Text.endsWith(hostname, #text ".raw.ic0.app") or
        Text.endsWith(hostname, #text ".raw.icp.net");
    };

};
