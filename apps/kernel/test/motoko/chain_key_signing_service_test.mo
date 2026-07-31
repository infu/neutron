import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Error "mo:core/Error";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import AppUsageTypes "../../backend/app_usage/Types";
import CapabilityTypes "../../backend/capabilities/Types";
import Adapter "../../backend/chain_key_signing/Adapter";
import Namespace "../../backend/chain_key_signing/Namespace";
import Service "../../backend/chain_key_signing/Service";
import Types "../../backend/chain_key_signing/Types";

let CANISTER = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");

var nextCycleReservationId : Nat = 1;
var reservedCycleCalls : Nat = 0;
var committedCycleCalls : Nat = 0;
var adapterDispatchCalls : Nat = 0;
var cancelledCycleCalls : Nat = 0;
var finalizedCycleCalls : Nat = 0;
var zeroAttachedCycleCalls : Nat = 0;
var lastReservedCycles : Nat = 0;
var lastReservationCallCount : Nat = 0;
var lastChargedCycles : Nat = 0;
func reserveCycles(
    appScope : CapabilityTypes.AppScope,
    attached : Nat,
    dailyLimit : ?Nat,
    callCount : Nat,
) : ?AppUsageTypes.OutgoingCycleReservation {
    reservedCycleCalls += 1;
    if (attached == 0) zeroAttachedCycleCalls += 1;
    lastReservedCycles := attached;
    lastReservationCallCount := callCount;
    let id = nextCycleReservationId;
    nextCycleReservationId += 1;
    ?{
        id;
        scope = appScope;
        day = 0;
        attached;
        daily_budgeted = dailyLimit != null;
        call_count = callCount;
    };
};
func commitCycles(
    reservation : AppUsageTypes.OutgoingCycleReservation,
) : Bool {
    assert (reservation.call_count > 0);
    committedCycleCalls += 1;
    true;
};
func cancelCycles(
    _reservation : AppUsageTypes.OutgoingCycleReservation,
) : () {
    cancelledCycleCalls += 1;
};
func finalizeCycles(
    _reservation : AppUsageTypes.OutgoingCycleReservation,
    charged : Nat,
) : () {
    finalizedCycleCalls += 1;
    lastChargedCycles := charged;
};
let cycleAccounting : AppUsageTypes.OutgoingCycleAccounting = {
    reserve = reserveCycles;
    commit = commitCycles;
    cancel = cancelCycles;
    finalize = finalizeCycles;
};

func bytes(size : Nat, seed : Nat8) : Blob {
    Array.toBlob(Array.tabulate<Nat8>(size, func(index) {
        seed +% Nat.toNat8(index);
    }));
};

func compressedKey(prefix : Nat8, seed : Nat8) : Blob {
    Array.toBlob(Array.tabulate<Nat8>(33, func(index) {
        if (index == 0) prefix else seed +% Nat.toNat8(index);
    }));
};

func scope(appId : Text, uid : Nat64) : CapabilityTypes.AppScope {
    { app_id = appId; installation_uid = uid };
};

func slot(
    id : Text,
    algorithm : Types.Algorithm,
    purpose : Text,
    maxBytes : Nat,
    _maxAssertions : Nat,
) : Types.SlotDeclaration {
    {
        id;
        algorithm;
        purpose;
        max_assertion_bytes = maxBytes;
    };
};

func declaration(
    appScope : CapabilityTypes.AppScope,
    slots : [Types.SlotDeclaration],
    _maxCycles : Nat,
) : Types.AppDeclaration {
    {
        app_scope = appScope;
        chain_key_signing = ?{
            slots;
        };
    };
};

let allKeys : Types.KeyConfiguration = {
    ecdsa_secp256k1 = ?"key_1";
    schnorr_bip340secp256k1 = ?"key_1";
    schnorr_ed25519 = ?"key_1";
};

class FakeAdapter() {
    public var quote_calls = 0;
    public var public_calls = 0;
    public var sign_calls = 0;
    public var quote_value : Nat = 1;
    public var quote_failure = false;
    public var balance = Service.MIN_REMAINING_CYCLES +
        Service.MAX_QUOTE_PER_ASSERTION;
    public var public_failure : ?Types.AdapterFailureKind = null;
    public var sign_failure : ?Types.AdapterFailureKind = null;
    public var malformed_public = false;
    public var malformed_signature = false;
    public var throw_sign = false;
    public var last_public : ?Types.AdapterPublicKeyRequest = null;
    public var last_sign : ?Types.AdapterSignRequest = null;
    public var before_public : ?(Types.AdapterPublicKeyRequest -> async ()) = null;
    public var before_sign : ?(Types.AdapterSignRequest -> async ()) = null;

    public func value() : Types.Adapter {
        {
            quote = func(_algorithm, _keyName) {
                quote_calls += 1;
                if (quote_failure) #err else #ok(quote_value);
            };
            cycle_balance = func() { balance };
            public_key = func(
                request : Types.AdapterPublicKeyRequest,
            ) : async Types.AdapterPublicKeyResult {
                // The saved future is committed before its async body runs.
                assert (committedCycleCalls == adapterDispatchCalls + 1);
                adapterDispatchCalls += 1;
                public_calls += 1;
                last_public := ?request;
                switch (before_public) {
                    case (?callback) await callback(request);
                    case null {};
                };
                switch (public_failure) {
                    case (?kind) #err({ charged_cycles = 0; kind });
                    case null {
                        let publicKey = if (malformed_public) {
                            bytes(31, 9);
                        } else switch (request.algorithm) {
                            case (#ecdsa_secp256k1) compressedKey(2, 10);
                            case (#schnorr_bip340secp256k1) compressedKey(3, 20);
                            case (#schnorr_ed25519) bytes(32, 30);
                        };
                        #ok({ public_key = publicKey; chain_code = bytes(32, 90) });
                    };
                };
            };
            sign = func(
                request : Types.AdapterSignRequest,
            ) : async Types.AdapterSignResult {
                // Paid dispatch follows the same create-then-commit ordering.
                assert (committedCycleCalls == adapterDispatchCalls + 1);
                adapterDispatchCalls += 1;
                sign_calls += 1;
                last_sign := ?request;
                switch (before_sign) {
                    case (?callback) await callback(request);
                    case null {};
                };
                if (throw_sign) throw Error.reject("local fake adapter failure");
                switch (sign_failure) {
                    case (?kind) #err({
                        charged_cycles = request.cycles;
                        kind;
                    });
                    case null #ok({
                        signature = bytes(
                            if (malformed_signature) 63 else 64,
                            40,
                        );
                        charged_cycles = request.cycles;
                    });
                };
            };
        };
    };
};

class FakeRegistry() {
    public var enabled = true;
    public var epoch : Nat = 0;
    public var records = 0;
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
            ) : Bool { enabled and kind == #chain_key_signing };
            lease = func(
                _scope : CapabilityTypes.AppScope,
                kind : CapabilityTypes.CapabilityKind,
                _resource : Text,
            ) : ?CapabilityTypes.RuntimeLease {
                if (not enabled or kind != #chain_key_signing) return null;
                let captured = epoch;
                ?{
                    active = func() : Bool {
                        enabled and epoch == captured;
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

func expectPublicOk(result : Types.PublicKeyResult) : Types.PublicKeyInfo {
    switch (result) {
        case (#ok(value)) value;
        case (#err(_)) Runtime.trap("Expected public-key success");
    };
};

func expectPublicError(result : Types.PublicKeyResult, expected : Types.Error) : () {
    switch (result) {
        case (#err(actual)) assert (actual == expected);
        case (#ok(_)) Runtime.trap("Expected public-key error");
    };
};

func expectSignOk(result : Types.SignResult) : Types.Signature {
    switch (result) {
        case (#ok(value)) value;
        case (#err(_)) Runtime.trap("Expected signature success");
    };
};

func expectSignError(result : Types.SignResult, expected : Types.Error) : () {
    switch (result) {
        case (#err(actual)) assert (actual == expected);
        case (#ok(_)) Runtime.trap("Expected signature error");
    };
};

// Frozen canonical vector. It covers the semantic app_assertion tag: omitting
// that length-prefixed component produces a different namespace and fails this
// exact vector.
let vectorInput : Namespace.Input = {
    install_epoch = 42;
    canister = CANISTER;
    app_scope = scope("receipt_app", 7);
    slot_id = "receipts";
    algorithm = #ecdsa_secp256k1;
    key_name = "key_1";
};
let #ok(vector) = Namespace.build(vectorInput) else Runtime.trap("vector");
assert (
    Namespace.hex(vector.derivation_path[0]) ==
        "17d52d68af3e7b95f5689310a6dbe1fc68c079b8cc414480905a561ccf17ecc6"
);
assert (
    Namespace.hex(vector.signing_domain) ==
        "03a9d3aa0598c08571c5f3013a421464fbdbea5e28fa8381abccbb1902f679a2"
);
let ?vectorDigest = Namespace.assertionDigest(
    vector.signing_domain,
    Text.encodeUtf8("hello"),
) else Runtime.trap("digest");
assert (
    Namespace.hex(vectorDigest) ==
        "cb8876f661df57c8ea70e6f424ec3ab3015566b714cf3bc7fedf842a38fad79c"
);

func namespace(input : Namespace.Input) : Namespace.Material {
    let #ok(value) = Namespace.build(input) else Runtime.trap("namespace");
    value;
};

for (changed in [
    { vectorInput with install_epoch = (43 : Nat64) },
    { vectorInput with canister = Principal.fromText("aaaaa-aa") },
    { vectorInput with app_scope = scope("other_app", 7) },
    { vectorInput with app_scope = scope("receipt_app", 8) },
    { vectorInput with slot_id = "other" },
    { vectorInput with algorithm = #schnorr_bip340secp256k1 },
    { vectorInput with key_name = "other_key" },
].vals()) {
    assert (namespace(changed).derivation_path != vector.derivation_path);
};
let authority = slot("receipts", #ecdsa_secp256k1, "Sign receipts", 100, 5);
assert (
    Namespace.authorityFingerprint(authority) ==
    Namespace.authorityFingerprint(
        { authority with purpose = "Presentation changed" },
    )
);
assert (
    Namespace.authorityFingerprint(authority) !=
    Namespace.authorityFingerprint(
        { authority with max_assertion_bytes = 101 },
    )
);
let rawDigestLookingAssertion = bytes(32, 1);
let ?framedDigest = Namespace.assertionDigest(
    vector.signing_domain,
    rawDigestLookingAssertion,
) else Runtime.trap("framed digest");
assert (framedDigest != rawDigestLookingAssertion);
assert (Namespace.validSlotId("receipts_v1"));
assert (not Namespace.validSlotId("Receipts"));
assert (not Namespace.validSlotId("1_receipts"));
assert (Adapter.unknownOutcomeCode(#system_unknown));
assert (Adapter.unknownOutcomeCode(#canister_error));
assert (not Adapter.unknownOutcomeCode(#canister_reject));
assert (not Adapter.unknownOutcomeCode(#destination_invalid));

// Public-key normalization is strict and BIP340 exposes only x-only bytes.
let ecdsaRaw = compressedKey(2, 1);
let bipRaw = compressedKey(3, 2);
let edRaw = bytes(32, 3);
assert (Service.normalizePublicKey(#ecdsa_secp256k1, ecdsaRaw, bytes(32, 9)) == ?ecdsaRaw);
let ?bipNormalized = Service.normalizePublicKey(
    #schnorr_bip340secp256k1,
    bipRaw,
    bytes(32, 9),
) else Runtime.trap("BIP340 normalize");
assert (bipNormalized.size() == 32 and Blob.toArray(bipNormalized)[0] == Blob.toArray(bipRaw)[1]);
assert (Service.normalizePublicKey(#schnorr_ed25519, edRaw, bytes(32, 9)) == ?edRaw);
assert (Service.normalizePublicKey(#ecdsa_secp256k1, compressedKey(4, 1), bytes(32, 9)) == null);
assert (Service.normalizePublicKey(#schnorr_ed25519, edRaw, bytes(31, 9)) == null);

assert (Service.validateMemory(Service.init()));
let corruptCache = Service.init();
Map.add(corruptCache.slots, Text.compare, "receipt_app\00\00\00receipts", {
    declaration_fingerprint =
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    identity_fingerprint =
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    cached_public_key = ?bytes(31, 1);
});
assert (not Service.validateMemory(corruptCache));

// All algorithms share one assertion envelope, while management receives the
// exact fixed path and the already-framed 32-byte digest.
let app = scope("signing_app", 1);
let appSlots = [
    slot("ecdsa", #ecdsa_secp256k1, "ECDSA assertions", 100, 5),
    slot("schnorr_bip", #schnorr_bip340secp256k1, "BIP340 assertions", 100, 5),
    slot("schnorr_ed", #schnorr_ed25519, "Ed25519 assertions", 100, 5),
];
let memory = Service.init();
let fake = FakeAdapter();
let registry = FakeRegistry();
var active = true;
let service = Service.Service(
    memory,
    fake.value(),
    CANISTER,
    42,
    func(candidate) { active and candidate == app },
    func() { true },
    registry.value(),
    cycleAccounting,
);
service.configure(allKeys, [declaration(
    app,
    appSlots,
    0,
)]);
let capability = service.capability(app);

let ecdsaInfo = expectPublicOk(await* capability.public_key("ecdsa"));
assert (ecdsaInfo.slot == "ecdsa" and ecdsaInfo.public_key.size() == 33);
assert (ecdsaInfo.key_fingerprint.size() == 32);
assert (ecdsaInfo.signing_domain.size() == 32);
assert (ecdsaInfo.namespace_version == 1);
assert (ecdsaInfo.message_format == #neutron_app_assertion_v1);
assert (
    zeroAttachedCycleCalls == 1 and
    reservedCycleCalls == 1 and
    committedCycleCalls == 1 and
    finalizedCycleCalls == 1 and
    cancelledCycleCalls == 0 and
    lastReservedCycles == 0 and
    lastReservationCallCount == 1 and
    lastChargedCycles == 0
);
ignore expectPublicOk(await* capability.public_key("ecdsa"));
assert (fake.public_calls == 1); // cache hit performs no management dispatch
assert (
    reservedCycleCalls == 1 and
    committedCycleCalls == 1 and
    finalizedCycleCalls == 1
);
let bipInfo = expectPublicOk(await* capability.public_key("schnorr_bip"));
let edInfo = expectPublicOk(await* capability.public_key("schnorr_ed"));
assert (bipInfo.public_key.size() == 32 and edInfo.public_key.size() == 32);
assert (
    zeroAttachedCycleCalls == 3 and
    reservedCycleCalls == 3 and
    committedCycleCalls == 3 and
    finalizedCycleCalls == 3 and
    cancelledCycleCalls == 0
);

let reservedBeforeSigns = reservedCycleCalls;
let committedBeforeSigns = committedCycleCalls;
let finalizedBeforeSigns = finalizedCycleCalls;
for (slotId in ["ecdsa", "schnorr_bip", "schnorr_ed"].vals()) {
    let signed = expectSignOk(await* capability.sign_assertion({
        slot = slotId;
        assertion = Text.encodeUtf8("hello");
    }));
    assert (signed.slot == slotId and signed.signature.size() == 64);
    assert (signed.digest.size() == 32 and signed.digest != Text.encodeUtf8("hello"));
    assert (signed.signing_domain.size() == 32);
    assert (signed.message_format == #neutron_app_assertion_v1);
    let ?dispatch = fake.last_sign else Runtime.trap("Missing sign dispatch");
    assert (dispatch.digest == signed.digest);
    assert (dispatch.derivation_path.size() == 1 and dispatch.derivation_path[0].size() == 32);
};
assert (
    reservedCycleCalls == reservedBeforeSigns + 3 and
    committedCycleCalls == committedBeforeSigns + 3 and
    finalizedCycleCalls == finalizedBeforeSigns + 3 and
    zeroAttachedCycleCalls == 3 and
    cancelledCycleCalls == 0 and
    lastReservedCycles == fake.quote_value and
    lastReservationCallCount == 1 and
    lastChargedCycles == fake.quote_value
);

let reservedBeforeInvalidRequests = reservedCycleCalls;
expectPublicError(await* capability.public_key("Bad"), #invalid_request);
expectSignError(await* capability.sign_assertion({
    slot = "ecdsa";
    assertion = bytes(101, 1);
}), #invalid_request);
registry.setEnabled(false);
expectSignError(await* capability.sign_assertion({ slot = "ecdsa"; assertion = "x" }), #disabled);
registry.setEnabled(true);
assert (reservedCycleCalls == reservedBeforeInvalidRequests);

// Purpose-only updates preserve the exact cached key and stable authority.
let purposeFake = FakeAdapter();
let purposeService = Service.Service(
    memory,
    purposeFake.value(),
    CANISTER,
    42,
    func(candidate) { candidate == app },
    func() { true },
    FakeRegistry().value(),
    cycleAccounting,
);
purposeService.configure(allKeys, [declaration(
    app,
    Array.map<Types.SlotDeclaration, Types.SlotDeclaration>(
        appSlots,
        func(value) { { value with purpose = value.purpose # " updated" } },
    ),
    0,
)]);
purposeService.commitConfiguration();
let reservedBeforePurposeCacheHit = reservedCycleCalls;
ignore expectPublicOk(await* purposeService.publicKey(app, "ecdsa"));
assert (purposeFake.public_calls == 0);
assert (
    reservedCycleCalls == reservedBeforePurposeCacheHit and
    committedCycleCalls == finalizedCycleCalls
);

// An app uninstall/reinstall gets a new UID-bound identity. Commit removes the
// old cached key, and the same slot now has a distinct signing domain.
let reinstalledApp = scope("signing_app", 2);
let reinstallFake = FakeAdapter();
let reinstallService = Service.Service(
    memory,
    reinstallFake.value(),
    CANISTER,
    42,
    func(candidate) { candidate == reinstalledApp },
    func() { true },
    FakeRegistry().value(),
    cycleAccounting,
);
reinstallService.configure(allKeys, [declaration(
    reinstalledApp,
    appSlots,
    0,
)]);
reinstallService.commitConfiguration();
assert (Map.size(memory.slots) == 0);
let reinstalledInfo = expectPublicOk(
    await* reinstallService.publicKey(reinstalledApp, "ecdsa")
);
assert (reinstallFake.public_calls == 1);
assert (reinstalledInfo.signing_domain != ecdsaInfo.signing_domain);

// Optional key absence is a stable closed failure, never a fallback.
let unavailable = Service.Service(
    Service.init(),
    FakeAdapter().value(),
    CANISTER,
    42,
    func(candidate) { candidate == app },
    func() { true },
    FakeRegistry().value(),
    cycleAccounting,
);
unavailable.configure({
    ecdsa_secp256k1 = ?"dfx_test_key";
    schnorr_bip340secp256k1 = null;
    schnorr_ed25519 = null;
}, [declaration(app, [slot(
    "schnorr",
    #schnorr_ed25519,
    "Unavailable locally",
    10,
    1,
)], 0)]);
expectPublicError(await* unavailable.publicKey(app, "schnorr"), #key_unavailable);
expectSignError(await* unavailable.signAssertion(app, {
    slot = "schnorr";
    assertion = "x";
}), #key_unavailable);

// Quote, balance, malformed reply, local adapter failure, and IC-ambiguous
// failure classifications are closed and never auto-retried.
let errorsFake = FakeAdapter();
let errorsRegistry = FakeRegistry();
let errorsService = Service.Service(
    Service.init(),
    errorsFake.value(),
    CANISTER,
    42,
    func(candidate) { candidate == app },
    func() { true },
    errorsRegistry.value(),
    cycleAccounting,
);
errorsService.configure(allKeys, [declaration(app, [authority], 0)]);
let signRequest : Types.SignRequest = { slot = "receipts"; assertion = "x" };
let reservedBeforeSignAdmission = reservedCycleCalls;
errorsFake.quote_failure := true;
expectSignError(await* errorsService.signAssertion(app, signRequest), #key_unavailable);
errorsFake.quote_failure := false;
errorsFake.quote_value := Service.MAX_QUOTE_PER_ASSERTION + 1;
expectSignError(
    await* errorsService.signAssertion(app, signRequest),
    #cost_too_high,
);
errorsFake.quote_value := 1;
errorsFake.balance := Service.MIN_REMAINING_CYCLES;
expectSignError(await* errorsService.signAssertion(app, signRequest), #low_cycles);
assert (
    reservedCycleCalls == reservedBeforeSignAdmission and
    committedCycleCalls == finalizedCycleCalls
);
errorsFake.balance := Service.MIN_REMAINING_CYCLES + Service.MAX_QUOTE_PER_ASSERTION;
errorsFake.sign_failure := ?#outcome_unknown;
expectSignError(await* errorsService.signAssertion(app, signRequest), #outcome_unknown);
errorsFake.before_sign := ?(func(_request : Types.AdapterSignRequest) : async () {
    errorsFake.before_sign := null;
    errorsRegistry.setEnabled(false);
    errorsRegistry.setEnabled(true);
});
expectSignError(await* errorsService.signAssertion(app, signRequest), #outcome_unknown);
assert (errorsRegistry.last_outcome == ?#failed);
errorsFake.sign_failure := null;
errorsFake.malformed_signature := true;
expectSignError(await* errorsService.signAssertion(app, signRequest), #management_failure);
errorsFake.malformed_signature := false;
errorsFake.throw_sign := true;
let finalizedBeforeAdapterThrow = finalizedCycleCalls;
let cancelledBeforeAdapterThrow = cancelledCycleCalls;
expectSignError(await* errorsService.signAssertion(app, signRequest), #outcome_unknown);
assert (
    finalizedCycleCalls == finalizedBeforeAdapterThrow + 1 and
    cancelledCycleCalls == cancelledBeforeAdapterThrow and
    lastChargedCycles == errorsFake.quote_value
);
errorsFake.throw_sign := false;
errorsFake.malformed_public := true;
expectPublicError(await* errorsService.publicKey(app, "receipts"), #management_failure);

// Slot concurrency is shared by discovery/signing and revocation epochs are
// rechecked after a paid signing await.
let awaitFake = FakeAdapter();
let awaitRegistry = FakeRegistry();
var awaitActive = true;
let awaitService = Service.Service(
    Service.init(),
    awaitFake.value(),
    CANISTER,
    42,
    func(candidate) { awaitActive and candidate == app },
    func() { true },
    awaitRegistry.value(),
    cycleAccounting,
);
awaitService.configure(allKeys, [declaration(app, [authority], 0)]);
awaitFake.before_sign := ?(func(_request : Types.AdapterSignRequest) : async () {
    awaitFake.before_sign := null;
    expectSignError(await* awaitService.signAssertion(app, signRequest), #busy);
});
ignore expectSignOk(await* awaitService.signAssertion(app, signRequest));
awaitFake.before_sign := ?(func(_request : Types.AdapterSignRequest) : async () {
    awaitFake.before_sign := null;
    awaitRegistry.setEnabled(false);
    awaitRegistry.setEnabled(true);
});
expectSignError(
    await* awaitService.signAssertion(app, signRequest),
    #revoked_after_dispatch,
);
assert (awaitRegistry.last_outcome == ?#revoked);
awaitFake.before_sign := ?(func(_request : Types.AdapterSignRequest) : async () {
    awaitFake.before_sign := null;
    awaitActive := false;
});
expectSignError(
    await* awaitService.signAssertion(app, signRequest),
    #revoked_after_dispatch,
);
expectSignError(await* awaitService.signAssertion(app, signRequest), #source_gone);

// Public-key replies are also suppressed after a lease epoch change and are
// never written to the stable cache.
let publicAwaitFake = FakeAdapter();
let publicAwaitRegistry = FakeRegistry();
let publicAwaitMemory = Service.init();
let publicAwaitService = Service.Service(
    publicAwaitMemory,
    publicAwaitFake.value(),
    CANISTER,
    42,
    func(candidate) { candidate == app },
    func() { true },
    publicAwaitRegistry.value(),
    cycleAccounting,
);
publicAwaitService.configure(allKeys, [declaration(
    app,
    [authority],
    0,
)]);
publicAwaitFake.before_public := ?(func(
    _request : Types.AdapterPublicKeyRequest,
) : async () {
    publicAwaitFake.before_public := null;
    publicAwaitRegistry.setEnabled(false);
    publicAwaitRegistry.setEnabled(true);
});
expectPublicError(
    await* publicAwaitService.publicKey(app, "receipts"),
    #revoked_after_dispatch,
);
for (state in Map.values(publicAwaitMemory.slots)) {
    assert (state.cached_public_key == null);
};

// App and global in-flight ceilings are independent of the per-slot lock.
let concurrencyApp = scope("concurrency_app", 1);
let concurrencyFake = FakeAdapter();
let concurrencyService = Service.Service(
    Service.init(),
    concurrencyFake.value(),
    CANISTER,
    42,
    func(candidate) { candidate == concurrencyApp },
    func() { true },
    FakeRegistry().value(),
    cycleAccounting,
);
concurrencyService.configure(allKeys, [declaration(concurrencyApp, [
    slot("a", #ecdsa_secp256k1, "A", 1, 2),
    slot("b", #ecdsa_secp256k1, "B", 1, 2),
    slot("c", #ecdsa_secp256k1, "C", 1, 2),
], 0)]);
var appDepth = 0;
concurrencyFake.before_sign := ?(func(
    _request : Types.AdapterSignRequest,
) : async () {
    if (appDepth == 0) {
        appDepth := 1;
        ignore expectSignOk(await* concurrencyService.signAssertion(concurrencyApp, {
            slot = "b"; assertion = "x";
        }));
    } else if (appDepth == 1) {
        appDepth := 2;
        expectSignError(await* concurrencyService.signAssertion(concurrencyApp, {
            slot = "c"; assertion = "x";
        }), #busy);
    };
});
ignore expectSignOk(await* concurrencyService.signAssertion(concurrencyApp, {
    slot = "a"; assertion = "x";
}));
assert (appDepth == 2 and concurrencyFake.sign_calls == 2);

let globalConcurrencyApps = Array.tabulate<CapabilityTypes.AppScope>(5, func(index) {
    scope("concurrent_" # Nat.toText(index), 1);
});
func globalConcurrencyActive(candidate : CapabilityTypes.AppScope) : Bool {
    for (allowed in globalConcurrencyApps.vals()) if (candidate == allowed) return true;
    false;
};
let globalConcurrencyFake = FakeAdapter();
let globalConcurrencyService = Service.Service(
    Service.init(),
    globalConcurrencyFake.value(),
    CANISTER,
    42,
    globalConcurrencyActive,
    func() { true },
    FakeRegistry().value(),
    cycleAccounting,
);
globalConcurrencyService.configure(allKeys, Array.map<
    CapabilityTypes.AppScope,
    Types.AppDeclaration,
>(globalConcurrencyApps, func(candidate) {
    declaration(candidate, [slot("key", #ecdsa_secp256k1, "Key", 1, 1)], 0);
}));
var globalDepth = 0;
globalConcurrencyFake.before_sign := ?(func(
    _request : Types.AdapterSignRequest,
) : async () {
    globalDepth += 1;
    if (globalDepth < Service.MAX_IN_FLIGHT_GLOBAL) {
        ignore expectSignOk(await* globalConcurrencyService.signAssertion(
            globalConcurrencyApps[globalDepth],
            { slot = "key"; assertion = "x" },
        ));
    } else {
        expectSignError(await* globalConcurrencyService.signAssertion(
            globalConcurrencyApps[4],
            { slot = "key"; assertion = "x" },
        ), #busy);
    };
});
ignore expectSignOk(await* globalConcurrencyService.signAssertion(
    globalConcurrencyApps[0],
    { slot = "key"; assertion = "x" },
));
assert (globalDepth == Service.MAX_IN_FLIGHT_GLOBAL);
assert (globalConcurrencyFake.sign_calls == Service.MAX_IN_FLIGHT_GLOBAL);
