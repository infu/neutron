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
import CapabilityScope "../../backend/capabilities/Scope";
import Adapter "../../backend/chain_key_signing/Adapter";
import Namespace "../../backend/chain_key_signing/Namespace";
import Service "../../backend/chain_key_signing/Service";
import Types "../../backend/chain_key_signing/Types";
import Caps "mo:neutron-capabilities";
import Custody "../../backend/wallet_custody_signing/Service";
import CustodyTypes "../../backend/wallet_custody_signing/Types";

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
                        let publicKey : Blob = if (malformed_public) {
                            bytes(31, 9);
                        } else switch (request.algorithm) {
                            case (#ecdsa_secp256k1) "\02\79\be\66\7e\f9\dc\bb\ac\55\a0\62\95\ce\87\0b\07\02\9b\fc\db\2d\ce\28\d9\59\f2\81\5b\16\f8\17\98";
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
                        signature = if (malformed_signature) bytes(63, 40) else "\91\c5\bd\51\ba\17\51\34\ee\4a\66\34\a9\3c\2f\5c\c3\ae\8f\c9\ba\c3\c9\8b\89\60\55\bf\0e\5c\f7\1c\44\f3\bb\8f\35\cd\8e\27\04\c3\63\0a\b1\a3\a9\24\75\50\23\16\d2\5c\b8\c1\66\d7\7b\da\d9\f3\a6\c9";
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
            ) : Bool { enabled and (kind == #chain_key_signing or kind == #wallet_custody_signing) };
            lease = func(
                _scope : CapabilityTypes.AppScope,
                kind : CapabilityTypes.CapabilityKind,
                _resource : Text,
            ) : ?CapabilityTypes.RuntimeLease {
                if (not enabled or (kind != #chain_key_signing and kind != #wallet_custody_signing)) return null;
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

// Signature fixture is independently checked by wallet_custody_signing.test.ts.
func digest() : Blob { Array.toBlob(Array.repeat<Nat8>(0x42, 32)) };
func expectKey(result : Caps.WalletCustodyPublicKeyResultV1) : Caps.WalletCustodyPublicKeyV1 {
    switch (result) { case (#ok(value)) value; case (#err(_)) Runtime.trap("expected custody key") };
};
func expectSignature(result : Caps.WalletCustodySignatureResultV1) : Caps.WalletCustodySignatureV1 {
    switch (result) { case (#ok(value)) value; case (#err(_)) Runtime.trap("expected custody signature") };
};
func failSign(result : Caps.WalletCustodySignatureResultV1, error : Caps.ChainKeySigningErrorV1) : () {
    switch (result) { case (#err(actual)) assert (actual == error); case (_) assert false };
};
func failKey(result : Caps.WalletCustodyPublicKeyResultV1, error : Caps.ChainKeySigningErrorV1) : () {
    switch (result) { case (#err(actual)) assert (actual == error); case (_) assert false };
};
func decl(app : CapabilityTypes.AppScope, purpose : Text) : CustodyTypes.AppDeclaration {
    { app_scope = app; wallet_custody_signing = ?{ slots = [{id = "main"; algorithm = #ecdsa_secp256k1; purpose}, {id = "spare"; algorithm = #ecdsa_secp256k1; purpose}] } };
};
let app = scope("evm_wallet", 17);
let other = scope("other_wallet", 18);
var active = true;
var activeUid : Nat64 = 17;
func scopeActive(value : CapabilityTypes.AppScope) : Bool {
    active and (value.app_id != app.app_id or value.installation_uid == activeUid);
};
let fake = FakeAdapter();
let registry = FakeRegistry();
let memory = Service.init();
let resources = Service.Resources();
// Released v1 custody cache is incompatible with the explicit fresh-account
// cutover. Its namespace is an independently checked historical fixture.
let legacyNamespace = "a185bec07ff722f7f134819259d5bf3c4d01cee13ac0657de53893ff27f588cd";
Map.add(memory.slots, Text.compare, CapabilityScope.key(app) # "\00main", {
    declaration_fingerprint = Namespace.custodyAuthorityFingerprint(slot("main", #ecdsa_secp256k1, "Old account", 32, 0));
    identity_fingerprint = legacyNamespace;
    cached_public_key = ?compressedKey(3, 70);
});
let custody = Custody.Service(memory, fake.value(), CANISTER, scopeActive, func() { true }, registry.value(), cycleAccounting, resources);
custody.configure(allKeys, [decl(app, "Manage EVM account"), decl(other, "Other account")]);
custody.commitConfiguration();
assert (Map.size(memory.slots) == 0);
let wallet = custody.capability(app);
let foreign = custody.capability(other);
let key = expectKey(await* wallet.public_key("main"));
assert (key.public_key.size() == 33 and key.namespace_version == 2);
let ?keyCall = fake.last_public else Runtime.trap("missing key request");
let #ok(namespace) = Namespace.buildDurableCustody({install_epoch = 3; canister = CANISTER; app_scope = app; slot_id = "main"; algorithm = #ecdsa_secp256k1; key_name = "key_1"}) else Runtime.trap("namespace");
assert (Namespace.hex(namespace.derivation_path[0]) == "95bae18ad5ce0598335267f05062381be41593193fc5df5b1e608fdbde820410");
assert (namespace.identity_fingerprint != legacyNamespace);
assert (keyCall.derivation_path == namespace.derivation_path and keyCall.key_name == "key_1");
assert (fake.public_calls == 1);
ignore expectKey(await* wallet.public_key("main"));
assert (fake.public_calls == 1);
assert (expectKey(await* foreign.public_key("main")).namespace_version == 2);
let ?foreignCall = fake.last_public else Runtime.trap("foreign key request");
assert (foreignCall.derivation_path != keyCall.derivation_path);
let signed = expectSignature(await* wallet.sign_digest({slot = "main"; digest = digest()}));
let ?signCall = fake.last_sign else Runtime.trap("sign request");
assert (signed.digest == digest() and signCall.digest == digest());
assert (signed.signature.size() == 64 and signCall.derivation_path == keyCall.derivation_path);
assert (lastChargedCycles == 1);
failSign(await* wallet.sign_digest({slot = "main"; digest = bytes(31, 1)}), #invalid_request);
failSign(await* wallet.sign_digest({slot = "main"; digest = bytes(33, 1)}), #invalid_request);
failSign(await* wallet.sign_digest({slot = "missing"; digest = digest()}), #not_declared);
assert (fake.sign_calls == 1);
// Same installation and slot as assertion signing still produces another path.
let assertions = Service.Engine(Service.init(), fake.value(), CANISTER, 3, scopeActive, func() {true}, registry.value(), cycleAccounting, #assertion, resources);
assertions.configure(allKeys, [declaration(app, [slot("main", #ecdsa_secp256k1, "Assertion", 32, 0)], 0)]);
let assertion = assertions.capability(app);
ignore await* assertion.public_key("main");
let ?assertionCall = fake.last_public else Runtime.trap("assertion request");
assert (assertionCall.derivation_path != keyCall.derivation_path);
registry.setEnabled(false);
failSign(await* wallet.sign_digest({slot = "main"; digest = digest()}), #disabled);
registry.setEnabled(true);
assert (expectKey(await* wallet.public_key("main")).public_key == key.public_key);
fake.before_sign := ?(func(_request : Types.AdapterSignRequest) : async () { registry.setEnabled(false); registry.setEnabled(true) });
failSign(await* wallet.sign_digest({slot = "main"; digest = digest()}), #revoked_after_dispatch);
fake.before_sign := null;
fake.sign_failure := ?#outcome_unknown;
let beforeUnknown = fake.sign_calls;
failSign(await* wallet.sign_digest({slot = "main"; digest = digest()}), #outcome_unknown);
assert (fake.sign_calls == beforeUnknown + 1);
fake.sign_failure := null;
fake.malformed_signature := true;
failSign(await* wallet.sign_digest({slot = "main"; digest = digest()}), #management_failure);
fake.malformed_signature := false;
fake.before_sign := ?(func(_request : Types.AdapterSignRequest) : async () {
    fake.before_sign := null;
    failSign(await* wallet.sign_digest({slot = "main"; digest = digest()}), #busy);
});
ignore expectSignature(await* wallet.sign_digest({slot = "main"; digest = digest()}));
fake.before_sign := null;
// A custody and an assertion request together consume the same per-app budget.
// The third slot is otherwise idle, so this is not the per-slot busy condition.
fake.before_sign := ?(func(_request : Types.AdapterSignRequest) : async () {
    fake.before_sign := ?(func(_nested : Types.AdapterSignRequest) : async () {
        fake.before_sign := null;
        failSign(await* wallet.sign_digest({slot = "spare"; digest = digest()}), #busy);
    });
    let #ok(_) = await* assertion.sign_assertion({slot = "main"; assertion = digest()}) else Runtime.trap("shared signing budget");
});
ignore expectSignature(await* wallet.sign_digest({slot = "main"; digest = digest()}));
fake.before_sign := null;
// Compatible upgrade retains cached key and ignores purpose-only changes.
let upgraded = Custody.Service(memory, fake.value(), CANISTER, scopeActive, func() {true}, registry.value(), cycleAccounting, Service.Resources());
upgraded.configure(allKeys, [decl(app, "Updated account description"), decl(other, "Other account")]);
upgraded.commitConfiguration();
let callsBeforeUpgrade = fake.public_calls;
ignore expectKey(await* upgraded.capability(app).public_key("main"));
assert (fake.public_calls == callsBeforeUpgrade);
// Removing/re-adding a slot in the same installation drops cache, retains key.
let removed = Custody.Service(memory, fake.value(), CANISTER, scopeActive, func() {true}, registry.value(), cycleAccounting, Service.Resources());
removed.configure(allKeys, []);
removed.commitConfiguration();
assert (Map.size(memory.slots) == 0);
let readded = Custody.Service(memory, fake.value(), CANISTER, scopeActive, func() {true}, registry.value(), cycleAccounting, Service.Resources());
readded.configure(allKeys, [decl(app, "Restored account")]);
readded.commitConfiguration();
ignore expectKey(await* readded.capability(app).public_key("main"));
assert (fake.last_public == ?keyCall);
// Reinstalling uses the same app ID and slot for derivation, while the removed
// installation's capabilities remain revoked. Epoch and UID are absent from
// custody identity and cannot select a historical account.
let #ok(newInstallation) = Namespace.buildDurableCustody({install_epoch = 3; canister = CANISTER; app_scope = scope("evm_wallet", 19); slot_id = "main"; algorithm = #ecdsa_secp256k1; key_name = "key_1"}) else Runtime.trap("reinstall namespace");
let #ok(newEpoch) = Namespace.buildDurableCustody({install_epoch = 4; canister = CANISTER; app_scope = app; slot_id = "main"; algorithm = #ecdsa_secp256k1; key_name = "key_1"}) else Runtime.trap("epoch namespace");
assert (newInstallation.derivation_path == keyCall.derivation_path);
assert (newEpoch.derivation_path == keyCall.derivation_path);
activeUid := 19;
let reinstalledApp = scope("evm_wallet", activeUid);
let reinstalled = Custody.Service(memory, fake.value(), CANISTER, scopeActive, func() {true}, registry.value(), cycleAccounting, Service.Resources());
reinstalled.configure(allKeys, [decl(reinstalledApp, "Reinstalled account")]);
reinstalled.commitConfiguration();
assert (Map.size(memory.slots) == 0);
let reinstalledWallet = reinstalled.capability(reinstalledApp);
failKey(await* wallet.public_key("main"), #source_gone);
failSign(await* wallet.sign_digest({slot = "main"; digest = digest()}), #source_gone);
registry.setEnabled(false);
failKey(await* reinstalledWallet.public_key("main"), #disabled);
failSign(await* reinstalledWallet.sign_digest({slot = "main"; digest = digest()}), #disabled);
registry.setEnabled(true);
assert (expectKey(await* reinstalledWallet.public_key("main")).namespace_version == 2);
assert (fake.last_public == ?keyCall);
ignore expectSignature(await* reinstalledWallet.sign_digest({slot = "main"; digest = digest()}));
let ?restoredSign = fake.last_sign else Runtime.trap("restored sign request");
assert (restoredSign.derivation_path == keyCall.derivation_path);
registry.setEnabled(false);
failSign(await* reinstalledWallet.sign_digest({slot = "main"; digest = digest()}), #disabled);
registry.setEnabled(true);
ignore expectSignature(await* reinstalledWallet.sign_digest({slot = "main"; digest = digest()}));
assert (fake.last_sign == ?restoredSign);
fake.before_sign := ?(func(_request : Types.AdapterSignRequest) : async () {
    activeUid := 20;
});
failSign(await* reinstalledWallet.sign_digest({slot = "main"; digest = digest()}), #revoked_after_dispatch);
fake.before_sign := null;
// The v2 path depends only on the canister, app ID, slot, algorithm and key.
let durableInput : Namespace.Input = {install_epoch = 3; canister = CANISTER; app_scope = other; slot_id = "main"; algorithm = #ecdsa_secp256k1; key_name = "key_1"};
let #ok(durable) = Namespace.buildDurableCustody(durableInput) else Runtime.trap("durable namespace");
assert (durable.namespace_version == 2 and durable.derivation_path == foreignCall.derivation_path);
assert (Namespace.hex(durable.derivation_path[0]) == "02ca7ab65b14b8e8f69ff51c4d4ebf3e2f2ee7f273c10b275ae4bbd2ba6b571b");
let #ok(durableReinstall) = Namespace.buildDurableCustody({durableInput with install_epoch = 999; app_scope = scope(other.app_id, 123)}) else Runtime.trap("durable reinstall namespace");
assert (durableReinstall == durable);
let #ok(durableOtherApp) = Namespace.buildDurableCustody({durableInput with app_scope = scope("another_wallet", 18)}) else Runtime.trap("different app namespace");
let #ok(durableOtherCanister) = Namespace.buildDurableCustody({durableInput with canister = Principal.fromText("r7inp-6aaaa-aaaaa-aaabq-cai")}) else Runtime.trap("different canister namespace");
let #ok(durableOtherSlot) = Namespace.buildDurableCustody({durableInput with slot_id = "spare"}) else Runtime.trap("different slot namespace");
let #ok(durableOtherKey) = Namespace.buildDurableCustody({durableInput with key_name = "key_2"}) else Runtime.trap("different key namespace");
assert (durableOtherApp.derivation_path != durable.derivation_path);
assert (durableOtherCanister.derivation_path != durable.derivation_path);
assert (durableOtherSlot.derivation_path != durable.derivation_path);
assert (durableOtherKey.derivation_path != durable.derivation_path);
assert (Namespace.buildDurableCustody({durableInput with algorithm = #schnorr_ed25519}) == #err(#invalid_input));
assert (Namespace.buildDurableCustody({durableInput with slot_id = "INVALID"}) == #err(#invalid_input));
active := false;
failSign(await* wallet.sign_digest({slot = "main"; digest = digest()}), #source_gone);
assert (reservedCycleCalls == committedCycleCalls + cancelledCycleCalls);
assert (finalizedCycleCalls == committedCycleCalls);
