import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Crypto "../../backend/crypto/Service";
import Memory "../../backend/memory/mail/v1";
import F "CryptoFixture";
import Fixture "Fixture";

func dispatch(start : Crypto.Start) : Crypto.Dispatch {
    switch (start) {
        case (#dispatch(value)) value;
        case (_) { assert false; loop {} };
    };
};

var slot = F.summary(7, null, #enabled, F.holder());
let capability : Crypto.VetKeysPublic = {
    canister_principal = F.canister(1);
    slot = func(id : Text) : ?Crypto.SlotSummary {
        if (id == Crypto.SLOT_ID) ?slot else null;
    };
    public_key = func(request : { slot : Text; generation : Nat64 }) : async* Crypto.PublicKeyResult {
        #ok(F.material(request.generation, true));
    };
};
let mem = Memory.init();
let crypto = Crypto.Service(mem, capability);

let setup = dispatch(crypto.setupStart());
switch (crypto.setupFinish(setup, #ok(F.material(7, true)))) {
    case (#ok(value)) {
        assert (value.current_epoch == 7 and value.previous_epoch == null);
        assert (value.previous_references.total == 0);
    };
    case (_) assert false;
};
let ?configured = mem.key_info else { assert false; loop {} };
assert (configured.current_fingerprint == F.fingerprint7());
assert (configured.context_public_key == F.public7());
assert (crypto.deliveryKeyInfo() == ?configured);
switch (crypto.setupStart()) {
    case (#err(#already_configured)) {};
    case (_) assert false;
};

mem.encrypted_settings := ?F.settings();
Map.add(mem.inbox, Nat.compare, 1, F.inboxRecord());
Map.add(mem.outbox, Nat.compare, 2, F.outboxRecord());
slot := F.summary(8, ?7, #enabled, F.holder());
let rotation = dispatch(crypto.rotateStart());

// Disable/change during the public-key await cannot commit.
slot := F.summary(8, ?7, #disabled, F.holder());
assert (crypto.deliveryKeyInfo() == null);
switch (crypto.rotateFinish(rotation, #ok(F.material(8, true)))) {
    case (#err(#capability_changed)) {};
    case (_) assert false;
};
let ?stillSeven = mem.key_info else { assert false; loop {} };
assert (stillSeven.current_epoch == 7 and stillSeven.previous_epoch == null);

slot := F.summary(8, ?7, #enabled, F.holder());
switch (crypto.rotateFinish(rotation, #ok(F.material(8, true)))) {
    case (#ok(value)) {
        assert (value.current_epoch == 8 and value.previous_epoch == ?7);
        assert (value.previous_references.settings == 1);
        assert (value.previous_references.inbox == 1);
        assert (value.previous_references.outbox == 1);
        assert (value.previous_references.total == 3);
    };
    case (_) assert false;
};
let ?configuredEight = mem.key_info else { assert false; loop {} };
assert (configuredEight.current_fingerprint == F.fingerprint8());
assert (crypto.deliveryKeyInfo() == ?configuredEight);

slot := F.summary(8, null, #enabled, F.holder());
// Retiring the previous generation does not invalidate current delivery.
assert (crypto.deliveryKeyInfo() == ?configuredEight);
switch (crypto.rotateStart()) {
    case (#err(#previous_references(value))) assert (value.total == 3);
    case (_) assert false;
};
// Lifecycle-manager transfer does not change the vetKey namespace or Mail key.
slot := F.summary(8, ?7, #enabled, F.otherHolder());
assert (crypto.deliveryKeyInfo() == ?configuredEight);
switch (crypto.rotateStart()) {
    case (#complete(value)) {
        assert (value.current_epoch == 8 and value.previous_epoch == ?7);
        assert (value.key_holder == F.otherHolder());
    };
    case (_) assert false;
};

slot := F.summary(8, ?7, #manifest_suspended, F.otherHolder());
assert (crypto.deliveryKeyInfo() == null);
slot := F.summary(7, null, #enabled, F.otherHolder());
assert (crypto.deliveryKeyInfo() == null);
let fingerprintMismatch = F.summary(8, ?7, #enabled, F.otherHolder());
slot := {
    fingerprintMismatch with
    generations = [{
        fingerprintMismatch.generations[0] with
        public_fingerprint = ?Fixture.repeatBlob(32, 0x7f);
    }, fingerprintMismatch.generations[1]];
};
assert (crypto.deliveryKeyInfo() == null);
let fingerprintMissing = F.summary(8, ?7, #enabled, F.otherHolder());
slot := {
    fingerprintMissing with
    generations = [{
        fingerprintMissing.generations[0] with
        public_fingerprint = null;
    }, fingerprintMissing.generations[1]];
};
assert (crypto.deliveryKeyInfo() == null);
slot := F.summary(8, ?7, #enabled, F.otherHolder());
assert (crypto.deliveryKeyInfo() == ?configuredEight);

let fresh = Memory.init();
let freshCrypto = Crypto.Service(fresh, capability);
slot := F.summary(7, null, #enabled, F.holder());
let freshSetup = dispatch(freshCrypto.setupStart());
switch (freshCrypto.setupFinish(freshSetup, #ok(F.material(7, false)))) {
    case (#err(#corrupt_state)) {};
    case (_) assert false;
};
assert (fresh.key_info == null);
switch (freshCrypto.setupFinish(freshSetup, #err(#low_cycles))) {
    case (#err(#vetkeys(#low_cycles))) {};
    case (_) assert false;
};
assert (fresh.key_info == null);
