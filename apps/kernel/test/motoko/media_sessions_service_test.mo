import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat8 "mo:core/Nat8";
import Runtime "mo:core/Runtime";
import CapabilityTypes "../../backend/capabilities/Types";
import Service "../../backend/media_sessions/Service";
import Types "../../backend/media_sessions/Types";

let scope : CapabilityTypes.AppScope = { app_id = "rendezvous"; installation_uid = 17 };
let instance : CapabilityTypes.AppInstance = {
    scope;
    version = 4;
    deployment_id = "deployment";
    capability_plan_fingerprint = "plan";
    resident_frame_security = #credentialless_opaque_v1;
    browser_origin_nonce = "";
    browser_origin_authority_epoch = 1;
};

var clock : Nat64 = 1_000_000_000;
var installed = true;
var entropyOk = true;
var registryEnabled = true;
var registryEpoch : Nat = 0;
var records : Nat = 0;

let adapter : Types.Adapter = {
    random = func() : async Types.AdapterResult {
        if (not entropyOk) return #err;
        #ok(Blob.fromArray(Array.tabulate<Nat8>(32, func(index) {
            Nat8.fromNat(index);
        })));
    };
};

let registry : CapabilityTypes.RuntimeRegistry = {
    allowed = func(candidate : CapabilityTypes.AppScope, kind, resource) {
        registryEnabled and candidate == scope and kind == #media_sessions and resource == "default";
    };
    lease = func(candidate : CapabilityTypes.AppScope, kind, resource) {
        if (not registryEnabled or candidate != scope or kind != #media_sessions or resource != "default") return null;
        let captured = registryEpoch;
        ?{ active = func() { registryEnabled and registryEpoch == captured } };
    };
    record = func(_scope, kind, resource, _operation, _outcome) {
        assert (kind == #media_sessions and resource == "default");
        records += 1;
        true;
    };
};

let memory : Types.Memory = {
    var next_session_id = 0;
    var authority_epoch = 0;
    var active_session_id = null;
    leases = Map.empty<Text, Types.Lease>();
};
let service = Service.Service(
    memory,
    adapter,
    func(appId) { if (installed and appId == scope.app_id) ?instance else null },
    func(candidate) { installed and candidate == scope },
    registry,
    func() { clock },
);
service.configure([{
    app_scope = scope;
    media_sessions = ?{
        entrypoint = "media.html";
        features = [#camera, #microphone];
        max_duration_seconds = 3_600;
    };
}]);

func begin(features : [Types.Feature], duration : Nat, requestId : Text) : async* Types.BeginResult {
    await* service.begin({
        app_id = scope.app_id;
        request_id = requestId;
        features;
        duration_seconds = duration;
    });
};

func expectOk(result : Types.BeginResult) : Types.LeaseView {
    switch (result) {
        case (#ok(value)) value;
        case (_) Runtime.trap("expected media lease");
    };
};

let requestId = "0123456789abcdef0123456789abcdef";
assert (Service.validEntrypoint("media.html"));
assert (Service.validEntrypoint("media/index.html"));
assert (not Service.validEntrypoint("../media.html"));
assert (not Service.validEntrypoint("media.html?device=camera"));
assert ((await* begin([#camera], 299, requestId)) == #err(#invalid_request));
assert ((await* begin([#camera, #camera], 300, requestId)) == #err(#invalid_request));
assert ((await* begin([#camera], 300, "ABC")) == #err(#invalid_request));

let opened = await* begin([#camera, #microphone], 600, requestId);
let lease = expectOk(opened);
assert (lease.app_id == scope.app_id);
assert (lease.installation_uid == scope.installation_uid);
assert (lease.entrypoint == "media.html");
assert (lease.origin_nonce.size() == 64);
assert (lease.session_id == "media-" # lease.origin_nonce);
assert (lease.expires_at == clock + 600_000_000_000);
assert (Map.size(memory.leases) == 1);
assert (records == 1);
assert ((await* begin([#camera], 300, requestId)) == #err(#busy));
assert (service.active(lease.session_id, lease.origin_nonce) != null);
assert (service.active(lease.session_id, "wrong") == null);

assert (service.close(lease.session_id) == #ok);
assert (memory.active_session_id == null and Map.size(memory.leases) == 0);
assert (service.takeTerminalCertification() != null);
assert (service.takeTerminalCertification() == null);
assert (records == 2);

registryEnabled := false;
registryEpoch += 1;
assert ((await* begin([#camera], 300, requestId)) == #err(#disabled));
registryEnabled := true;
registryEpoch += 1;

let expiring = expectOk(await* begin([#microphone], 300, requestId));
clock := expiring.expires_at;
assert (service.current() == null);
assert (memory.active_session_id == null and Map.size(memory.leases) == 0);
assert (service.takeTerminalCertification() != null);

entropyOk := false;
assert ((await* begin([#camera], 300, requestId)) == #err(#randomness_failed));
