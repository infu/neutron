import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Error "mo:core/Error";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import AppUsageTypes "../../backend/app_usage/Types";
import CapabilityTypes "../../backend/capabilities/Types";
import IC "../../backend/aaa_interface";
import Adapter "../../backend/https_outcalls/Adapter";
import Service "../../backend/https_outcalls/Service";
import Types "../../backend/https_outcalls/Types";

let EMPTY : Blob = "";

var nextCycleReservationId : Nat = 1;
var cycleReserveCalls : Nat = 0;
var cycleCommitCalls : Nat = 0;
var cycleCancelCalls : Nat = 0;
var cycleFinalizeCalls : Nat = 0;
var adapterDispatchCalls : Nat = 0;
var lastChargedCycles : Nat = 0;
func reserveCycles(
    appScope : CapabilityTypes.AppScope,
    attached : Nat,
    _dailyLimit : ?Nat,
    callCount : Nat,
) : ?AppUsageTypes.OutgoingCycleReservation {
    let id = nextCycleReservationId;
    nextCycleReservationId += 1;
    cycleReserveCalls += 1;
    ?{
        id;
        scope = appScope;
        day = 0;
        attached;
        call_count = callCount;
        daily_budgeted = false;
    };
};
func commitCycles(
    reservation : AppUsageTypes.OutgoingCycleReservation,
) : Bool {
    assert (reservation.call_count == 1);
    assert (cycleCommitCalls + 1 == cycleReserveCalls);
    // Creating the adapter future must not start its body before accounting
    // records the dispatch.
    assert (adapterDispatchCalls == cycleCommitCalls);
    cycleCommitCalls += 1;
    true;
};
func cancelCycles(
    _reservation : AppUsageTypes.OutgoingCycleReservation,
) : () {
    cycleCancelCalls += 1;
};
func finalizeCycles(
    _reservation : AppUsageTypes.OutgoingCycleReservation,
    charged : Nat,
) : () {
    cycleFinalizeCalls += 1;
    lastChargedCycles := charged;
};
let outgoingCycleAccounting : AppUsageTypes.OutgoingCycleAccounting = {
    reserve = reserveCycles;
    commit = commitCycles;
    cancel = cancelCycles;
    finalize = finalizeCycles;
};

func scope(appId : Text, uid : Nat64) : CapabilityTypes.AppScope {
    { app_id = appId; installation_uid = uid };
};

func endpoint(
    id : Text,
    prefix : Text,
    methods : [Types.Method],
    headers : [Text],
    maxRequest : Nat,
    maxResponse : Nat,
    _maxCalls : Nat,
) : Types.EndpointDeclaration {
    {
        id;
        url_prefix = prefix;
        methods;
        request_headers = headers;
        max_request_bytes = maxRequest;
        max_response_bytes = maxResponse;
        transform = #strip_headers;
    };
};

func declaration(
    appScope : CapabilityTypes.AppScope,
    endpoints : [Types.EndpointDeclaration],
    _maxCycles : Nat,
) : Types.AppDeclaration {
    {
        app_scope = appScope;
        https_outcalls = ?{
            endpoints;
        };
    };
};

func request(
    endpointId : Text,
    method : Types.Method,
    path : Text,
    queryParams : [(Text, Text)],
    headers : [{ name : Text; value : Text }],
    body : Blob,
    key : ?Text,
) : Types.Request {
    {
        endpoint = endpointId;
        method;
        path;
        query_params = queryParams;
        headers;
        body;
        idempotency_key = key;
    };
};

func simpleRequest(endpointId : Text) : Types.Request {
    request(endpointId, #get, "", [], [], EMPTY, null);
};

func expectOk(result : Types.Result) : Types.Response {
    switch (result) {
        case (#ok(value)) value;
        case (#err(_)) Runtime.trap("Expected HTTPS outcall success");
    };
};

func expectError(result : Types.Result, expected : Types.Error) : () {
    switch (result) {
        case (#err(actual)) assert (actual == expected);
        case (#ok(_)) Runtime.trap("Expected HTTPS outcall error");
    };
};

class FakeAdapter() {
    public var calls : Nat = 0;
    public var quote_calls : Nat = 0;
    public var quote_value : Nat = 100_000_000;
    public var balance : Nat =
        Service.MIN_REMAINING_CYCLES + Service.MAX_QUOTE_PER_CALL;
    public var quoted_request_size : Nat64 = 0;
    public var quoted_response_size : Nat64 = 0;
    public var last_request : ?Types.AdapterRequest = null;
    public var fail = false;
    public var throw_request = false;
    public var response : IC.http_request_result = {
        status = 200;
        headers = [];
        body = Text.encodeUtf8("ok");
    };
    public var before_reply : ?((Nat, Types.AdapterRequest) -> async ()) = null;

    public func value() : Types.Adapter {
        {
            quote = func(requestSize, responseSize) {
                quote_calls += 1;
                quoted_request_size := requestSize;
                quoted_response_size := responseSize;
                quote_value;
            };
            cycle_balance = func() { balance };
            request = func(input : Types.AdapterRequest) : async Types.AdapterResult {
                // Paid dispatch must not begin until its reservation has been
                // committed exactly once.
                assert (cycleCommitCalls == cycleReserveCalls);
                adapterDispatchCalls += 1;
                assert (adapterDispatchCalls == cycleCommitCalls);
                calls += 1;
                last_request := ?input;
                switch (before_reply) {
                    case (?callback) await callback(calls, input);
                    case null {};
                };
                if (throw_request) throw Error.reject("fake adapter trap");
                if (fail) {
                    #err({ charged_cycles = quote_value });
                } else {
                    #ok({ response; charged_cycles = quote_value });
                };
            };
        };
    };
};

class FakeRegistry() {
    public var enabled = true;
    public var epoch : Nat = 0;
    public var records : Nat = 0;
    public var last_outcome : ?CapabilityTypes.CapabilityOutcome = null;

    public func setEnabled(value : Bool) : () {
        enabled := value;
        epoch += 1;
    };

    public func value() : CapabilityTypes.RuntimeRegistry {
        {
            allowed = func(
                _scope : CapabilityTypes.AppScope,
                kind : CapabilityTypes.CapabilityKind,
                _resource : Text,
            ) : Bool { enabled and kind == #https_outcalls };
            lease = func(
                _scope : CapabilityTypes.AppScope,
                kind : CapabilityTypes.CapabilityKind,
                _resource : Text,
            ) : ?CapabilityTypes.RuntimeLease {
                if (not enabled or kind != #https_outcalls) return null;
                let capturedEpoch = epoch;
                ?{
                    active = func() {
                        enabled and capturedEpoch == epoch;
                    };
                };
            };
            record = func(
                _scope : CapabilityTypes.AppScope,
                _kind : CapabilityTypes.CapabilityKind,
                _resource : Text,
                _operation : Text,
                outcome : CapabilityTypes.CapabilityOutcome,
            ) : Bool {
                records += 1;
                last_outcome := ?outcome;
                true;
            };
        };
    };
};

// Independent defense-in-depth validators mirror the compiler's canonical
// grammar and reject authority-changing URL/path/header forms.
assert (Service.validUrlPrefix("https://api.example.com/"));
assert (Service.validUrlPrefix("https://api.example.com/v1/A._~-/"));
for (invalid in [
    "http://api.example.com/",
    "https://API.example.com/",
    "https://user@api.example.com/",
    "https://api.example.com:443/",
    "https://127.0.0.1/",
    "https://x.arpa/",
    "https://api.example.com/a//b/",
    "https://api.example.com/a/../b/",
    "https://api.example.com/%41/",
    "https://api.example.com/a?b/",
].vals()) assert (not Service.validUrlPrefix(invalid));

assert (Service.validRelativePath(""));
assert (Service.validRelativePath("A._~-/second"));
for (invalid in [
    "/leading", "trailing/", "a//b", ".", "..", "a/../b",
    "percent%20", "query?x", "fragment#x",
].vals()) assert (not Service.validRelativePath(invalid));
var sixtyFiveSegments = "a";
var segmentIndex = 1;
while (segmentIndex < 65) {
    sixtyFiveSegments #= "/a";
    segmentIndex += 1;
};
assert (not Service.validRelativePath(sixtyFiveSegments));
var oversizedPath = "";
var pathByte = 0;
while (pathByte < 1_025) {
    oversizedPath #= "a";
    pathByte += 1;
};
assert (not Service.validRelativePath(oversizedPath));

for (forbidden in [
    "cookie", "set-cookie", "origin", "idempotency-key", "connection",
    "ic-certificate", "proxy-anything", "sec-fetch-site",
].vals()) assert (Service.forbiddenHeader(forbidden));
assert (not Service.forbiddenHeader("accept"));
assert (Service.validIdempotencyKey("Abcd_1234-Efgh56"));
assert (not Service.validIdempotencyKey("Abcd.1234:Efgh56"));
assert (not Service.validIdempotencyKey("short"));

assert (Adapter.managementCaller(Principal.fromText("aaaaa-aa")));
assert (not Adapter.managementCaller(Principal.fromText("2vxsx-fae")));
assert (Adapter.validTransformContext("\00"));
assert (Adapter.validTransformContext("\01"));
assert (not Adapter.validTransformContext("\02"));
let ordinaryTransform = Adapter.transform({
    response = {
        status = 201;
        headers = [{ name = "date"; value = "unstable" }];
        body = Text.encodeUtf8("body");
    };
    context = "\00";
});
assert (ordinaryTransform.status == 201);
assert (ordinaryTransform.headers.size() == 0);
assert (ordinaryTransform.body == Text.encodeUtf8("body"));
let headTransform = Adapter.transform({
    response = {
        status = 204;
        headers = [{ name = "server"; value = "hidden" }];
        body = Text.encodeUtf8("must disappear");
    };
    context = "\01";
});
assert (headTransform.status == 204);
assert (headTransform.headers.size() == 0);
assert (headTransform.body.size() == 0);

let wideHeaders = [
    "h00", "h01", "h02", "h03", "h04", "h05", "h06", "h07",
    "h08", "h09", "h10", "h11", "h12", "h13", "h14", "h15",
];
let app = scope("weather", 1);
let appEndpoints = [
    endpoint(
        "api",
        "https://api.example.com/v1/",
        [#get, #head, #post],
        ["accept", "x-trace"],
        4_096,
        4_096,
        60,
    ),
    endpoint("beta", "https://api.example.com/v1/", [#get], [], 4_096, 4_096, 60),
    endpoint("gamma", "https://api.example.com/v1/", [#get], [], 4_096, 4_096, 60),
    endpoint("wide", "https://api.example.com/v1/", [#get, #post], wideHeaders, 65_536, 4_096, 60),
];
let fake = FakeAdapter();
let registry = FakeRegistry();
var active = true;
let service = Service.Service(
    fake.value(),
    func(candidate) { active and candidate == app },
    func() { true },
    registry.value(),
    outgoingCycleAccounting,
);
service.configure([declaration(app, appEndpoints, 2_000_000_000_000)]);
let capability = service.capability(app);

let getResult = expectOk(await* capability.request(request(
    "api",
    #get,
    "records/A._~-",
    [("q", "snow & ice"), ("emoji", "☃")],
    [
        { name = "x-trace"; value = "trace" },
        { name = "accept"; value = "application/json" },
    ],
    EMPTY,
    null,
)));
assert (getResult.status == 200 and getResult.body == Text.encodeUtf8("ok"));
assert (cycleReserveCalls == 1 and cycleCommitCalls == 1);
assert (cycleCancelCalls == 0);
assert (cycleFinalizeCalls == 1 and lastChargedCycles == fake.quote_value);
assert (
    fake.quoted_request_size == Nat64.fromNat(
        4_096 + Adapter.QUOTE_REQUEST_OVERHEAD_BYTES
    )
);
assert (fake.quoted_response_size == 4_096);
let ?getDispatch = fake.last_request else Runtime.trap("Missing GET dispatch");
assert (
    getDispatch.url ==
        "https://api.example.com/v1/records/A._~-" #
        "?q=snow%20%26%20ice&emoji=%E2%98%83"
);
assert (getDispatch.headers == [
    { name = "accept"; value = "application/json" },
    { name = "x-trace"; value = "trace" },
]);
assert (getDispatch.transform_context == "\00");

// Sixteen app headers plus the broker-owned POST key are legal and emitted in
// declaration order regardless of caller order.
let reversedWideHeaders = Array.tabulate<{ name : Text; value : Text }>(
    wideHeaders.size(),
    func(index) {
        let name = wideHeaders[wideHeaders.size() - index - 1];
        { name; value = "v-" # name };
    },
);
ignore expectOk(await* capability.request(request(
    "wide",
    #post,
    "submit",
    [],
    reversedWideHeaders,
    Text.encodeUtf8("payload"),
    ?"Abcd_1234-Efgh56",
)));
let ?postDispatch = fake.last_request else Runtime.trap("Missing POST dispatch");
assert (postDispatch.headers.size() == 17);
var headerIndex = 0;
while (headerIndex < wideHeaders.size()) {
    assert (postDispatch.headers[headerIndex].name == wideHeaders[headerIndex]);
    headerIndex += 1;
};
assert (postDispatch.headers[16] == {
    name = "idempotency-key";
    value = "Abcd_1234-Efgh56";
});

let callsBeforeInvalid = fake.calls;
expectError(
    await* capability.request(request("api", #get, "/escape", [], [], EMPTY, null)),
    #invalid_request,
);
expectError(
    await* capability.request(request("api", #get, sixtyFiveSegments, [], [], EMPTY, null)),
    #invalid_request,
);
expectError(
    await* capability.request(request("api", #get, "", [], [], Text.encodeUtf8("x"), null)),
    #invalid_request,
);
expectError(
    await* capability.request(request("api", #post, "", [], [], EMPTY, null)),
    #invalid_request,
);
expectError(
    await* capability.request(request("api", #post, "", [], [], EMPTY, ?"Abcd.1234:Efgh56")),
    #invalid_request,
);
expectError(
    await* capability.request(request(
        "api",
        #get,
        "",
        Array.tabulate<(Text, Text)>(33, func(index) { (Nat.toText(index), "v") }),
        [],
        EMPTY,
        null,
    )),
    #invalid_request,
);
assert (fake.calls == callsBeforeInvalid);

// HEAD gets its distinct body-stripping context and refuses a body even if a
// test adapter violates the transform contract.
fake.response := { status = 204; headers = []; body = EMPTY };
ignore expectOk(await* capability.request(request("api", #head, "", [], [], EMPTY, null)));
let ?headDispatch = fake.last_request else Runtime.trap("Missing HEAD dispatch");
assert (headDispatch.transform_context == "\01");
fake.response := { status = 204; headers = []; body = Text.encodeUtf8("bad") };
expectError(
    await* capability.request(request("api", #head, "", [], [], EMPTY, null)),
    #management_failure,
);

fake.response := { status = 302; headers = []; body = EMPTY };
expectError(await* capability.request(simpleRequest("api")), #redirected);
fake.response := { status = 99; headers = []; body = EMPTY };
expectError(await* capability.request(simpleRequest("api")), #management_failure);
fake.response := {
    status = 200;
    headers = [{ name = "date"; value = "must be stripped" }];
    body = EMPTY;
};
expectError(await* capability.request(simpleRequest("api")), #management_failure);
fake.response := {
    status = 200;
    headers = [];
    body = Blob.fromArray(Array.tabulate<Nat8>(4_097, func(_) { 0 }));
};
expectError(await* capability.request(simpleRequest("api")), #management_failure);
fake.response := { status = 200; headers = []; body = Text.encodeUtf8("ok") };
fake.fail := true;
expectError(await* capability.request(simpleRequest("api")), #management_failure);
fake.fail := false;
fake.throw_request := true;
let finalizedBeforeAdapterThrow = cycleFinalizeCalls;
expectError(await* capability.request(simpleRequest("api")), #management_failure);
assert (
    cycleFinalizeCalls == finalizedBeforeAdapterThrow + 1 and
    lastChargedCycles == fake.quote_value
);
fake.throw_request := false;

// Endpoint and app concurrency are charged before the await and rejected
// without reaching the adapter.
var endpointNested = false;
fake.before_reply := ?(func(_call : Nat, _dispatch : Types.AdapterRequest) : async () {
    if (not endpointNested) {
        endpointNested := true;
        expectError(await* capability.request(simpleRequest("beta")), #busy);
    };
});
ignore expectOk(await* capability.request(simpleRequest("beta")));
fake.before_reply := null;

var appDepth = 0;
fake.before_reply := ?(func(_call : Nat, _dispatch : Types.AdapterRequest) : async () {
    if (appDepth == 0) {
        appDepth := 1;
        ignore expectOk(await* capability.request(simpleRequest("gamma")));
    } else if (appDepth == 1) {
        appDepth := 2;
        expectError(await* capability.request(simpleRequest("wide")), #busy);
    };
});
ignore expectOk(await* capability.request(simpleRequest("beta")));
fake.before_reply := null;
assert (appDepth == 2);

// An epoch-changing toggle or removed installation after dispatch suppresses
// the paid response and is recorded as revocation.
fake.before_reply := ?(func(_call : Nat, _dispatch : Types.AdapterRequest) : async () {
    registry.setEnabled(false);
    registry.setEnabled(true);
});
expectError(await* capability.request(simpleRequest("api")), #revoked_after_dispatch);
assert (registry.last_outcome == ?#revoked);
let finalizedBeforeRevocation = cycleFinalizeCalls;
fake.before_reply := ?(func(
    _call : Nat,
    _dispatch : Types.AdapterRequest,
) : async () { active := false });
expectError(await* capability.request(simpleRequest("api")), #revoked_after_dispatch);
assert (cycleFinalizeCalls == finalizedBeforeRevocation + 1);
fake.before_reply := null;
expectError(await* capability.request(simpleRequest("api")), #source_gone);
active := true;
registry.setEnabled(false);
expectError(await* capability.request(simpleRequest("api")), #disabled);
registry.setEnabled(true);

// Quote and balance rejection happen before paid admission/dispatch.
let callsBeforeCycleChecks = fake.calls;
fake.quote_value := Service.MAX_QUOTE_PER_CALL + 1;
expectError(
    await* capability.request(simpleRequest("api")),
    #cost_too_high,
);
fake.quote_value := 100_000_000;
fake.balance := Service.MIN_REMAINING_CYCLES + fake.quote_value - 1;
expectError(await* capability.request(simpleRequest("api")), #low_cycles);
assert (fake.calls == callsBeforeCycleChecks);
fake.balance := Service.MIN_REMAINING_CYCLES + Service.MAX_QUOTE_PER_CALL;

// Eight distinct app requests may be suspended; a ninth is rejected by the
// canister-global concurrency ceiling without reaching the adapter.
let globalApps = Array.tabulate<CapabilityTypes.AppScope>(9, func(index) {
    scope("global_" # Nat.toText(index), 1);
});
func globalActive(candidate : CapabilityTypes.AppScope) : Bool {
    for (allowed in globalApps.vals()) if (candidate == allowed) return true;
    false;
};
let globalFake = FakeAdapter();
globalFake.quote_value := 1;
let globalService = Service.Service(
    globalFake.value(),
    globalActive,
    func() { true },
    FakeRegistry().value(),
    outgoingCycleAccounting,
);
globalService.configure(Array.map<CapabilityTypes.AppScope, Types.AppDeclaration>(
    globalApps,
    func(candidate) {
        declaration(
            candidate,
            [endpoint("api", "https://global.example.com/", [#get], [], 1_024, 1_024, 1)],
            0,
        );
    },
));
var globalDepth = 0;
globalFake.before_reply := ?(func(
    _call : Nat,
    _dispatch : Types.AdapterRequest,
) : async () {
    globalDepth += 1;
    if (globalDepth < Service.MAX_IN_FLIGHT_GLOBAL) {
        ignore expectOk(await* globalService.request(
            globalApps[globalDepth],
            simpleRequest("api"),
        ));
    } else {
        expectError(
            await* globalService.request(globalApps[8], simpleRequest("api")),
            #busy,
        );
    };
});
ignore expectOk(await* globalService.request(globalApps[0], simpleRequest("api")));
assert (globalDepth == Service.MAX_IN_FLIGHT_GLOBAL);
assert (globalFake.calls == Service.MAX_IN_FLIGHT_GLOBAL);
assert (cycleCommitCalls == cycleReserveCalls);
assert (cycleCancelCalls == 0);
