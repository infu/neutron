import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Char "mo:core/Char";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Set "mo:core/Set";
import Text "mo:core/Text";
import CapabilityScope "../capabilities/Scope";
import CapabilityTypes "../capabilities/Types";
import AppUsageTypes "../app_usage/Types";
import IC "../aaa_interface";
import Adapter "Adapter";
import Types "Types";

module {
    public let MAX_ENDPOINTS_PER_APP : Nat = 8;
    public let MAX_ENDPOINTS_GLOBAL : Nat = 2_048;
    public let MAX_URL_BYTES : Nat = 4_096;
    public let MAX_RELATIVE_PATH_BYTES : Nat = 1_024;
    public let MAX_RELATIVE_PATH_SEGMENTS : Nat = 64;
    public let MAX_QUERY_ITEMS : Nat = 32;
    public let MAX_QUERY_KEY_BYTES : Nat = 128;
    public let MAX_QUERY_VALUE_BYTES : Nat = 2_048;
    public let MAX_REQUEST_HEADERS : Nat = 16;
    public let MAX_REQUEST_HEADER_BYTES : Nat = 16_384;
    public let MAX_REQUEST_HEADER_VALUE_BYTES : Nat = 4_096;
    public let MAX_REQUEST_BYTES : Nat = 65_536;
    public let MAX_RESPONSE_BYTES : Nat = 524_288;
    public let MAX_QUOTE_PER_CALL : Nat = 50_000_000_000;
    public let MIN_REMAINING_CYCLES : Nat = 250_000_000_000;
    public let MAX_IN_FLIGHT_PER_ENDPOINT : Nat = 1;
    public let MAX_IN_FLIGHT_PER_APP : Nat = 2;
    public let MAX_IN_FLIGHT_GLOBAL : Nat = 8;

    let BODY_CONTEXT : Blob = "\00";
    let HEAD_CONTEXT : Blob = "\01";
    let IDEMPOTENCY_HEADER = "idempotency-key";
    let HEX = [
        "0", "1", "2", "3", "4", "5", "6", "7",
        "8", "9", "A", "B", "C", "D", "E", "F",
    ];

    type PreparedEndpoint = {
        scope : CapabilityTypes.AppScope;
        declaration : Types.EndpointDeclaration;
        fingerprint : Text;
    };

    type PreparedRequest = {
        url : Text;
        headers : [IC.http_header];
        context : Blob;
        request_size : Nat;
    };

    public class Service(
        adapter : Types.Adapter,
        scopeActive : CapabilityTypes.AppScope -> Bool,
        deploymentCommitted : () -> Bool,
        registry : CapabilityTypes.RuntimeRegistry,
        outgoingCycles : AppUsageTypes.OutgoingCycleAccounting,
    ) {
        let declarations = Map.empty<Text, Types.Declaration>();
        let endpoints = Map.empty<Text, PreparedEndpoint>();
        let endpointInFlight = Set.empty<Text>();
        let scopeInFlight = Map.empty<Text, Nat>();
        var globalInFlight = 0;
        var configured = false;

        public func configure(apps : [Types.AppDeclaration]) : () {
            assert (not configured);
            var endpointCount = 0;
            var previousScope : ?Text = null;
            for (app in apps.vals()) {
                assert (validScope(app.app_scope));
                let scopeKey = CapabilityScope.key(app.app_scope);
                switch (previousScope) {
                    case (?previous) assert (Text.compare(previous, scopeKey) == #less);
                    case null {};
                };
                previousScope := ?scopeKey;
                let ?declaration = app.https_outcalls else continue;
                assert (
                    declaration.endpoints.size() >= 1 and
                    declaration.endpoints.size() <= MAX_ENDPOINTS_PER_APP
                );
                assert (not Map.containsKey(declarations, Text.compare, scopeKey));
                Map.add(declarations, Text.compare, scopeKey, declaration);
                var previousEndpoint : ?Text = null;
                for (endpoint in declaration.endpoints.vals()) {
                    validateEndpoint(endpoint);
                    switch (previousEndpoint) {
                        case (?previous) assert (
                            Text.compare(previous, endpoint.id) == #less
                        );
                        case null {};
                    };
                    previousEndpoint := ?endpoint.id;
                    let key = endpointKey(app.app_scope, endpoint.id);
                    assert (not Map.containsKey(endpoints, Text.compare, key));
                    Map.add(endpoints, Text.compare, key, {
                        scope = app.app_scope;
                        declaration = endpoint;
                        fingerprint = endpointFingerprint(endpoint);
                    });
                    endpointCount += 1;
                };
            };
            assert (endpointCount <= MAX_ENDPOINTS_GLOBAL);
            configured := true;
        };

        public func commitConfiguration() : () {
            assert (configured and deploymentCommitted());
            for (endpoint in Map.values(endpoints)) assert (scopeActive(endpoint.scope));
        };

        public func capability(
            appScope : CapabilityTypes.AppScope,
        ) : Types.Capability {
            assert (configured and declarationFor(appScope) != null);
            {
                request = func(input : Types.Request) : async* Types.Result {
                    await* request(appScope, input);
                };
            };
        };

        public func request(
            appScope : CapabilityTypes.AppScope,
            input : Types.Request,
        ) : async* Types.Result {
            let result = await* requestInner(appScope, input);
            ignore registry.record(
                appScope,
                #https_outcalls,
                input.endpoint,
                "request_" # methodText(input.method),
                outcome(result),
            );
            result;
        };

        func requestInner(
            appScope : CapabilityTypes.AppScope,
            input : Types.Request,
        ) : async* Types.Result {
            if (not scopeActive(appScope)) return #err(#source_gone);
            let ?_declaration = declarationFor(appScope) else {
                return #err(#not_declared);
            };
            if (not validEndpointId(input.endpoint)) {
                return #err(#invalid_request);
            };
            let key = endpointKey(appScope, input.endpoint);
            let ?endpoint = Map.get(endpoints, Text.compare, key) else {
                return #err(#not_declared);
            };
            let ?lease = registry.lease(
                appScope,
                #https_outcalls,
                input.endpoint,
            ) else return #err(#disabled);

            let ?prepared = prepareRequest(endpoint.declaration, input) else {
                return #err(#invalid_request);
            };
            if (prepared.request_size > endpoint.declaration.max_request_bytes) {
                return #err(#invalid_request);
            };
            let quote = adapter.quote(
                Adapter.conservativeRequestSize(
                    endpoint.declaration.max_request_bytes,
                ),
                Nat64.fromNat(endpoint.declaration.max_response_bytes),
            );
            if (quote > MAX_QUOTE_PER_CALL) {
                return #err(#cost_too_high);
            };
            if (adapter.cycle_balance() < quote + MIN_REMAINING_CYCLES) {
                return #err(#low_cycles);
            };
            let scopeKey = CapabilityScope.key(appScope);
            if (
                Set.contains(endpointInFlight, Text.compare, key) or
                count(scopeInFlight, scopeKey) >= MAX_IN_FLIGHT_PER_APP or
                globalInFlight >= MAX_IN_FLIGHT_GLOBAL
            ) return #err(#busy);
            let ?cycleReservation = outgoingCycles.reserve(
                appScope,
                quote,
                null,
                1,
            ) else return #err(#source_gone);

            // Producing a proper Motoko future does not dispatch its body.
            // A synchronous producer failure (normally #call_error for an
            // actor-backed adapter) therefore proves that no paid call was
            // enqueued and the whole reservation may be cancelled.
            let adapterFuture : async Types.AdapterResult = try {
                adapter.request({
                    url = prepared.url;
                    method = input.method;
                    headers = prepared.headers;
                    body = input.body;
                    max_response_bytes = Nat64.fromNat(
                        endpoint.declaration.max_response_bytes
                    );
                    transform_context = prepared.context;
                    cycles = quote;
                });
            } catch (_) {
                outgoingCycles.cancel(cycleReservation);
                return #err(#management_failure);
            };

            assert (Set.insert(endpointInFlight, Text.compare, key));
            addCount(scopeInFlight, scopeKey, 1);
            globalInFlight += 1;
            assert (outgoingCycles.commit(cycleReservation));
            let managementResult : Types.AdapterResult = try {
                await adapterFuture;
            } catch (_) {
                // A trusted adapter trap after dispatch makes its refund
                // unobservable. Keep the gross reservation conservatively.
                #err({ charged_cycles = quote });
            };
            Set.remove(endpointInFlight, Text.compare, key);
            subtractCount(scopeInFlight, scopeKey, 1);
            assert (globalInFlight > 0);
            globalInFlight -= 1;

            let chargedCycles = switch (managementResult) {
                case (#ok(value)) value.charged_cycles;
                case (#err(value)) value.charged_cycles;
            };
            outgoingCycles.finalize(cycleReservation, chargedCycles);

            let current = Map.get(endpoints, Text.compare, key);
            if (
                not scopeActive(appScope) or
                not lease.active() or
                (switch (current) {
                    case (?value) value.fingerprint != endpoint.fingerprint;
                    case null true;
                })
            ) return #err(#revoked_after_dispatch);

            switch (managementResult) {
                case (#err(_)) #err(#management_failure);
                case (#ok({ response; charged_cycles = _ })) {
                    if (
                        response.headers.size() != 0 or
                        response.status < 100 or response.status > 599 or
                        response.body.size() > endpoint.declaration.max_response_bytes or
                        (input.method == #head and response.body.size() != 0)
                    ) return #err(#management_failure);
                    if (response.status >= 300 and response.status < 400) {
                        return #err(#redirected);
                    };
                    #ok({ status = response.status; body = response.body });
                };
            };
        };

        func prepareRequest(
            endpoint : Types.EndpointDeclaration,
            input : Types.Request,
        ) : ?PreparedRequest {
            if (not methodAllowed(endpoint.methods, input.method)) return null;
            if (input.body.size() > endpoint.max_request_bytes) return null;
            switch (input.method) {
                case (#get) {
                    if (input.body.size() != 0 or input.idempotency_key != null) {
                        return null;
                    };
                };
                case (#head) {
                    if (input.body.size() != 0 or input.idempotency_key != null) {
                        return null;
                    };
                };
                case (#post) {
                    let ?key = input.idempotency_key else return null;
                    if (not validIdempotencyKey(key)) return null;
                };
            };
            if (not validRelativePath(input.path)) return null;
            if (input.query_params.size() > MAX_QUERY_ITEMS) return null;

            let queryParts = List.empty<Text>();
            for ((key, value) in input.query_params.vals()) {
                if (
                    Text.encodeUtf8(key).size() > MAX_QUERY_KEY_BYTES or
                    Text.encodeUtf8(value).size() > MAX_QUERY_VALUE_BYTES
                ) return null;
                List.add(queryParts, percentEncode(key) # "=" # percentEncode(value));
            };
            let queryText = if (List.size(queryParts) == 0) {
                "";
            } else {
                "?" # Text.join(List.values(queryParts), "&");
            };
            let url = endpoint.url_prefix # input.path # queryText;
            if (Text.encodeUtf8(url).size() > MAX_URL_BYTES) return null;

            let supplied = Map.empty<Text, Text>();
            if (input.headers.size() > MAX_REQUEST_HEADERS) return null;
            for (header in input.headers.vals()) {
                if (
                    not validHeaderName(header.name) or
                    not headerAllowed(endpoint.request_headers, header.name) or
                    not validHeaderValue(header.value) or
                    Map.containsKey(supplied, Text.compare, header.name)
                ) return null;
                Map.add(supplied, Text.compare, header.name, header.value);
            };
            let outputHeaders = List.empty<IC.http_header>();
            for (name in endpoint.request_headers.vals()) {
                switch (Map.get(supplied, Text.compare, name)) {
                    case (?value) List.add(outputHeaders, { name; value });
                    case null {};
                };
            };

            switch (input.method) {
                case (#get) {};
                case (#head) {};
                case (#post) {
                    let ?key = input.idempotency_key else return null;
                    List.add(outputHeaders, {
                        name = IDEMPOTENCY_HEADER;
                        value = key;
                    });
                };
            };
            // A POST may carry all sixteen app-declared headers plus the one
            // broker-owned idempotency header. The declaration still grants
            // no authority over that seventeenth transport header.
            let transportHeaderLimit = if (input.method == #post) {
                MAX_REQUEST_HEADERS + 1
            } else MAX_REQUEST_HEADERS;
            if (List.size(outputHeaders) > transportHeaderLimit) return null;
            let headers = List.toArray(outputHeaders);
            var headerBytes = 0;
            for (header in headers.vals()) {
                headerBytes += Text.encodeUtf8(header.name).size();
                headerBytes += Text.encodeUtf8(header.value).size();
            };
            if (headerBytes > MAX_REQUEST_HEADER_BYTES) return null;
            let context = if (input.method == #head) HEAD_CONTEXT else BODY_CONTEXT;
            let bodyBytes = if (input.method == #post) input.body.size() else 0;
            let requestSize = Text.encodeUtf8(url).size() + headerBytes + bodyBytes;
            ?{
                url;
                headers;
                context;
                request_size = requestSize;
            };
        };

        func declarationFor(
            scope : CapabilityTypes.AppScope,
        ) : ?Types.Declaration {
            if (not configured) return null;
            Map.get(declarations, Text.compare, CapabilityScope.key(scope));
        };

    };

    func validateEndpoint(endpoint : Types.EndpointDeclaration) : () {
        assert (validEndpointId(endpoint.id));
        assert (validUrlPrefix(endpoint.url_prefix));
        assert (
            endpoint.methods.size() >= 1 and endpoint.methods.size() <= 3 and
            endpoint.request_headers.size() <= MAX_REQUEST_HEADERS and
            endpoint.max_request_bytes >= 1 and
            endpoint.max_request_bytes <= MAX_REQUEST_BYTES and
            Text.encodeUtf8(endpoint.url_prefix).size() <= endpoint.max_request_bytes and
            endpoint.max_response_bytes >= 1 and
            endpoint.max_response_bytes <= MAX_RESPONSE_BYTES and
            endpoint.transform == #strip_headers
        );
        var previousMethod : ?Text = null;
        for (method in endpoint.methods.vals()) {
            let value = methodText(method);
            switch (previousMethod) {
                case (?previous) assert (Text.compare(previous, value) == #less);
                case null {};
            };
            previousMethod := ?value;
        };
        var previousHeader : ?Text = null;
        for (header in endpoint.request_headers.vals()) {
            assert (validHeaderName(header) and not forbiddenHeader(header));
            switch (previousHeader) {
                case (?previous) assert (Text.compare(previous, header) == #less);
                case null {};
            };
            previousHeader := ?header;
        };
    };

    func validScope(scope : CapabilityTypes.AppScope) : Bool {
        CapabilityScope.valid(scope);
    };

    func validEndpointId(value : Text) : Bool {
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

    // The tools parser performs full WHATWG canonicalization. This independent
    // kernel check proves the authority-bearing properties it relies on.
    public func validUrlPrefix(value : Text) : Bool {
        if (
            Text.encodeUtf8(value).size() > MAX_URL_BYTES or
            not Text.startsWith(value, #text "https://") or
            not Text.endsWith(value, #text "/")
        ) return false;
        let ?rest = Text.stripStart(value, #text "https://") else return false;
        let ?withoutTrailingSlash = Text.stripEnd(rest, #char '/') else {
            return false;
        };
        let parts = Text.split(withoutTrailingSlash, #char '/');
        let ?host = parts.next() else return false;
        if (not validPublicHost(host)) return false;
        for (segment in parts) {
            if (segment == "" or segment == "." or segment == "..") {
                return false;
            };
            for (char in segment.chars()) if (not unreserved(char)) return false;
        };
        true;
    };

    func validPublicHost(host : Text) : Bool {
        if (
            host.size() < 3 or host.size() > 253 or
            Text.contains(host, #char ':') or Text.contains(host, #char '@')
        ) return false;
        let labels = Text.split(host, #char '.');
        var countLabels = 0;
        var last = "";
        for (dnsLabel in labels) {
            if (dnsLabel.size() < 1 or dnsLabel.size() > 63) return false;
            var index = 0;
            for (char in dnsLabel.chars()) {
                let alphaNumeric =
                    (char >= 'a' and char <= 'z') or
                    (char >= '0' and char <= '9');
                if (not alphaNumeric and char != '-') return false;
                if ((index == 0 or index + 1 == dnsLabel.size()) and char == '-') {
                    return false;
                };
                index += 1;
            };
            countLabels += 1;
            last := dnsLabel;
        };
        if (countLabels < 2) return false;
        if (
            last == "arpa" or last == "home" or last == "internal" or last == "invalid" or
            last == "lan" or last == "local" or last == "localhost" or
            last == "onion" or last == "test"
        ) return false;
        // Hostnames made only from decimal labels are IPv4 literals in disguise.
        var allNumeric = true;
        for (char in host.chars()) {
            if (char != '.' and (char < '0' or char > '9')) allNumeric := false;
        };
        not allNumeric;
    };

    public func validRelativePath(value : Text) : Bool {
        if (value == "") return true;
        if (Text.encodeUtf8(value).size() > MAX_RELATIVE_PATH_BYTES) return false;
        if (Text.startsWith(value, #char '/') or Text.endsWith(value, #char '/')) {
            return false;
        };
        var segmentCount = 0;
        for (segment in Text.split(value, #char '/')) {
            segmentCount += 1;
            if (segmentCount > MAX_RELATIVE_PATH_SEGMENTS) return false;
            if (segment == "" or segment == "." or segment == "..") return false;
            for (char in segment.chars()) {
                if (not unreserved(char)) return false;
            };
        };
        true;
    };

    func unreserved(char : Char) : Bool {
        (char >= 'a' and char <= 'z') or
        (char >= 'A' and char <= 'Z') or
        (char >= '0' and char <= '9') or
        char == '-' or char == '.' or char == '_' or char == '~';
    };

    func percentEncode(value : Text) : Text {
        let encoded = List.empty<Text>();
        for (byte in Text.encodeUtf8(value).vals()) {
            let value = Nat8.toNat(byte);
            if (
                (value >= 65 and value <= 90) or
                (value >= 97 and value <= 122) or
                (value >= 48 and value <= 57) or
                value == 45 or value == 46 or value == 95 or value == 126
            ) {
                List.add(
                    encoded,
                    Char.toText(Char.fromNat32(Nat32.fromNat(value))),
                );
            } else {
                List.add(encoded, "%" # HEX[value / 16] # HEX[value % 16]);
            };
        };
        Text.join(List.values(encoded), "");
    };

    func validHeaderName(value : Text) : Bool {
        if (value.size() < 1 or value.size() > 64) return false;
        for (char in value.chars()) {
            if (not (
                (char >= 'a' and char <= 'z') or
                (char >= '0' and char <= '9') or char == '-'
            )) return false;
        };
        true;
    };

    func validHeaderValue(value : Text) : Bool {
        if (Text.encodeUtf8(value).size() > MAX_REQUEST_HEADER_VALUE_BYTES) {
            return false;
        };
        for (char in value.chars()) {
            if (char < ' ' or char > '~') return false;
        };
        true;
    };

    public func forbiddenHeader(value : Text) : Bool {
        value == "connection" or value == "content-encoding" or
        value == "content-length" or value == "cookie" or value == "host" or
        value == IDEMPOTENCY_HEADER or value == "keep-alive" or
        value == "origin" or value == "set-cookie" or
        value == "proxy-authenticate" or value == "proxy-authorization" or
        value == "te" or value == "trailer" or
        value == "transfer-encoding" or value == "upgrade" or
        Text.startsWith(value, #text "ic-") or
        Text.startsWith(value, #text "proxy-") or
        Text.startsWith(value, #text "sec-");
    };

    public func validIdempotencyKey(value : Text) : Bool {
        let size = Text.encodeUtf8(value).size();
        if (size < 16 or size > 64) return false;
        for (char in value.chars()) {
            if (not (
                (char >= 'a' and char <= 'z') or
                (char >= 'A' and char <= 'Z') or
                (char >= '0' and char <= '9') or
                char == '-' or char == '_'
            )) return false;
        };
        true;
    };

    func methodAllowed(methods : [Types.Method], requested : Types.Method) : Bool {
        for (method in methods.vals()) if (method == requested) return true;
        false;
    };

    func headerAllowed(headers : [Text], requested : Text) : Bool {
        if (forbiddenHeader(requested)) return false;
        for (header in headers.vals()) if (header == requested) return true;
        false;
    };

    func endpointKey(scope : CapabilityTypes.AppScope, id : Text) : Text {
        CapabilityScope.key(scope) # "\00" # id;
    };

    func endpointFingerprint(endpoint : Types.EndpointDeclaration) : Text {
        endpoint.id # "\00" # endpoint.url_prefix # "\00" #
        Text.join(Array.map<Types.Method, Text>(endpoint.methods, methodText).vals(), ",") #
        "\00" # Text.join(endpoint.request_headers.vals(), ",") # "\00" #
        Nat64.toText(Nat64.fromNat(endpoint.max_request_bytes)) # "\00" #
        Nat64.toText(Nat64.fromNat(endpoint.max_response_bytes)) # "\00" #
        "strip_headers";
    };

    func methodText(method : Types.Method) : Text {
        switch (method) {
            case (#get) "get";
            case (#head) "head";
            case (#post) "post";
        };
    };

    func count(map : Map.Map<Text, Nat>, key : Text) : Nat {
        switch (Map.get(map, Text.compare, key)) {
            case (?value) value;
            case null 0;
        };
    };

    func addCount(map : Map.Map<Text, Nat>, key : Text, amount : Nat) : () {
        Map.add(map, Text.compare, key, count(map, key) + amount);
    };

    func subtractCount(map : Map.Map<Text, Nat>, key : Text, amount : Nat) : () {
        let current = count(map, key);
        assert (current >= amount);
        if (current == amount) {
            ignore Map.delete(map, Text.compare, key);
        } else {
            Map.add(map, Text.compare, key, current - amount);
        };
    };

    func outcome(result : Types.Result) : CapabilityTypes.CapabilityOutcome {
        switch (result) {
            case (#ok(_)) #ok;
            case (#err(#cost_too_high)) #denied;
            case (#err(#busy)) #busy;
            case (#err(#source_gone)) #revoked;
            case (#err(#revoked_after_dispatch)) #revoked;
            case (#err(#invalid_request)) #denied;
            case (#err(#not_declared)) #denied;
            case (#err(#disabled)) #denied;
            case (#err(_)) #failed;
        };
    };
}
