import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Memory "../backend/memory/state/v1";
import App "../backend/main";
import ReadIdentity "../backend/read_identity";
import Capabilities "mo:neutron-capabilities";

let owner = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
let broker : Capabilities.BackendCallsV1 = {
    canister_principal = owner;
    can_call = func(_canister : Principal, _method : Text) : Bool { true };
    call = func(_request : Capabilities.BackendCallRequestV1) : async* Capabilities.BackendCallResultV1 { #err({ code = "test"; message = "No network" }) };
    call_batch = func(_requests : [Capabilities.BackendCallRequestV1]) : async* [Capabilities.BackendCallResultV1] { [] };
};
let rootKey : Blob = "\02\79\be\66\7e\f9\dc\bb\ac\55\a0\62\95\ce\87\0b\07\02\9b\fc\db\2d\ce\28\d9\59\f2\81\5b\16\f8\17\98";
var signedCount = 0;
var signatureError : ?Capabilities.ChainKeySigningErrorV1 = null;
var wrongDigest = false;
let signer : Capabilities.WalletCustodySigningV1 = {
    public_key = func(slot : Text) : async* Capabilities.WalletCustodyPublicKeyResultV1 {
        assert slot == "read_access";
        #ok({ slot; algorithm = #ecdsa_secp256k1; public_key = rootKey; key_fingerprint = "fixture"; namespace_version = 2 });
    };
    sign_digest = func(request : Capabilities.WalletCustodySignDigestRequestV1) : async* Capabilities.WalletCustodySignatureResultV1 {
        assert request.slot == "read_access";
        signedCount += 1;
        switch (signatureError) { case (?error) return #err(error); case null {} };
        #ok({ slot = request.slot; algorithm = #ecdsa_secp256k1; digest = if (wrongDigest) "bad" else request.digest; signature = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" });
    };
};
let memory = Memory.init();
let app = App.Init({ stable_memory = { state = memory }; capabilities = { backend_calls = broker; wallet_custody_signing = signer } });
let production = Principal.fromText("sj2r4-haaaa-aaaay-aadgq-cai");
assert app.marketplace_state(()).canister == ?production;
assert app.marketplace_state(()).host == "https://icp-api.io";
assert app.marketplace_state(()).revision == 1;
assert app.marketplace_state(()).seed == null;
switch (app.marketplace_initialize(Blob.fromArray([1, 2]))) { case (#err(_)) {}; case (_) assert false };
let seed : Blob = "01234567890123456789012345678901";
ignore app.marketplace_initialize(seed);
ignore app.marketplace_initialize("11234567890123456789012345678901");
assert app.marketplace_state(()).seed == ?seed;
ignore app.marketplace_save_draft({ id = "purchase-1"; value = "original" });
switch (app.marketplace_save_draft({ id = "purchase-1"; value = "replacement" })) { case (#err(_)) {}; case (_) assert false };
assert app.marketplace_draft("purchase-1") == ?"original";
let restored = App.Init({ stable_memory = { state = memory }; capabilities = { backend_calls = broker; wallet_custody_signing = signer } });
assert restored.marketplace_state(()).seed == ?seed;
assert restored.marketplace_state(()).canister == ?production;
assert restored.marketplace_state(()).revision == 2;
assert restored.marketplace_draft("purchase-1") == ?"original";
assert restored.marketplace_drafts({ cursor = null; limit = 1 }).items.size() == 1;
ignore app.marketplace_save_draft({ id = "purchase-2"; value = "second" });
let firstPage = restored.marketplace_drafts({ cursor = null; limit = 1 });
assert firstPage.nextCursor == ?"purchase-1";
let secondPage = restored.marketplace_drafts({ cursor = firstPage.nextCursor; limit = 1 });
assert secondPage.items[0].id == "purchase-2";
assert secondPage.items[0].value == "second";
assert secondPage.nextCursor == null;
// Revisions preserve the previous bytes and compare the exact expected value.
switch (restored.marketplace_revise_draft({ id = "purchase-1"; expected = "wrong"; value = "changed"; revision = "revision-1" })) { case (#err(_)) {}; case (_) assert false };
assert restored.marketplace_draft("purchase-1") == ?"original";
ignore restored.marketplace_revise_draft({ id = "purchase-1"; expected = "original"; value = "changed"; revision = "revision-1" });
assert restored.marketplace_draft("purchase-1") == ?"changed";
assert restored.marketplace_draft("history:purchase-1:revision-1") == ?"original";
ignore restored.marketplace_revise_draft({ id = "purchase-1"; expected = "original"; value = "changed"; revision = "revision-1" });
switch (restored.marketplace_revise_draft({ id = "purchase-1"; expected = "original"; value = "competing"; revision = "revision-2" })) { case (#err(_)) {}; case (_) assert false };
assert restored.marketplace_draft("purchase-1") == ?"changed";
let restoredRevision = App.Init({ stable_memory = { state = memory }; capabilities = { backend_calls = broker; wallet_custody_signing = signer } });
assert restoredRevision.marketplace_draft("history:purchase-1:revision-1") == ?"original";
// The existing v1 root stores opaque draft bytes. New optional installation
// diagnostics preserve older drafts and their revision history on restoration.
let originalInstall : Blob = "{\"version\":1,\"setupUrl\":null}";
let unavailableInstall : Blob = "{\"version\":1,\"setupUrl\":null,\"unavailableReason\":\"Saved release retired\"}";
ignore restoredRevision.marketplace_save_draft({ id = "installation-1"; value = originalInstall });
ignore restoredRevision.marketplace_revise_draft({ id = "installation-1"; expected = originalInstall; value = unavailableInstall; revision = "retirement" });
let restoredInstall = App.Init({ stable_memory = { state = memory }; capabilities = { backend_calls = broker; wallet_custody_signing = signer } });
assert restoredInstall.marketplace_draft("installation-1") == ?unavailableInstall;
assert restoredInstall.marketplace_draft("history:installation-1:retirement") == ?originalInstall;
// Restore the released v1 root before it had a deployed default. Adopt only
// the missing configuration; retain the read identity and opaque journal.
let unconfigured = Memory.init();
unconfigured.seed := ?seed;
unconfigured.revision := 8;
Map.add(unconfigured.drafts, Text.compare, "legacy-request", "legacy-data");
let adopted = App.Init({ stable_memory = { state = unconfigured }; capabilities = { backend_calls = broker; wallet_custody_signing = signer } });
assert adopted.marketplace_state(()).canister == ?production;
assert adopted.marketplace_state(()).seed == ?seed;
assert adopted.marketplace_state(()).revision == 9;
assert adopted.marketplace_draft("legacy-request") == ?"legacy-data";
let adoptedAgain = App.Init({ stable_memory = { state = unconfigured }; capabilities = { backend_calls = broker; wallet_custody_signing = signer } });
assert adoptedAgain.marketplace_state(()).revision == 9;
// A deliberately configured local or alternate protocol remains selected
// across initialization and upgrade, with its exact host and revision.
ignore adopted.marketplace_configure({ canister = owner; host = "http://127.0.0.1:4943" });
let custom = App.Init({ stable_memory = { state = unconfigured }; capabilities = { backend_calls = broker; wallet_custody_signing = signer } });
assert custom.marketplace_state(()).canister == ?owner;
assert custom.marketplace_state(()).host == "http://127.0.0.1:4943";
assert custom.marketplace_state(()).revision == 10;
assert custom.marketplace_state(()).seed == ?seed;
assert custom.marketplace_draft("legacy-request") == ?"legacy-data";
assert App.allowed("purchase");
assert App.allowed("repo_access_v1");
assert App.allowed("ethereum_prepare");
assert App.allowed("ethereum_verify");
assert App.allowed("ethereum_settle");
assert App.allowed("ethereum_cancel");
assert not App.allowed("ethereum_status");
assert not App.allowed("ethereum_history");
assert not App.allowed("icrc1_transfer");
assert not App.allowed("catalog");

// Published SDK known-answer vector: requestIdOf({pubkey, expiration,
// targets:[production]}) followed by the IC delegation domain and SHA-256.
let sessionKey : Blob = "\30\2a\30\05\06\03\2b\65\70\03\21\00\7b\c3\07\95\18\ed\11\da\03\36\08\5b\f6\96\29\20\ff\87\fb\3c\4d\63\0a\9b\58\cb\61\53\67\4f\5d\d6";
assert ReadIdentity.validSessionKey(sessionKey);
assert not ReadIdentity.validSessionKey("not an Ed25519 public key");
assert ReadIdentity.delegationHash(sessionKey, production) == "\2e\34\f3\be\d9\57\18\a4\8a\15\4d\f1\87\91\4b\1a\72\e5\fb\ec\77\22\8a\0d\26\32\63\ef\2c\2a\93\f3";
assert ReadIdentity.signingDigest(sessionKey, production) == "\75\1f\6a\ee\c9\2a\b4\18\c2\ab\26\39\fe\4e\f5\36\f1\33\1d\ba\4c\4e\1c\b2\a6\e9\c2\63\86\62\1d\89";
assert ReadIdentity.signingDigest(sessionKey, owner) != ReadIdentity.signingDigest(sessionKey, production);
await async {
    switch (await* app.marketplace_read_key(())) { case (#ok(key)) assert key == rootKey; case (#err(_)) assert false };
    assert signedCount == 0;
    switch (await* app.marketplace_read_identity({ publicKey = "bad" })) { case (#err(_)) {}; case (_) assert false };
    assert signedCount == 0;
    switch (await* app.marketplace_read_identity({ publicKey = sessionKey })) {
        case (#ok(value)) {
            assert value.publicKey == rootKey;
            assert value.sessionPublicKey == sessionKey;
            assert value.target == production;
            assert value.expiration == ReadIdentity.EXPIRATION;
        };
        case (#err(_)) assert false;
    };
    assert signedCount == 1;
    assert app.marketplace_state(()).seed == ?seed;
    assert app.marketplace_draft("purchase-1") == ?"changed";
    signatureError := ?#disabled;
    switch (await* app.marketplace_read_identity({ publicKey = sessionKey })) { case (#err(_)) {}; case (_) assert false };
    signatureError := null;
    wrongDigest := true;
    switch (await* app.marketplace_read_identity({ publicKey = sessionKey })) { case (#err(_)) {}; case (_) assert false };
    wrongDigest := false;
    let freshMemory = Memory.init();
    let reinstalled = App.Init({ stable_memory = { state = freshMemory }; capabilities = { backend_calls = broker; wallet_custody_signing = signer } });
    switch (await* reinstalled.marketplace_read_key(())) { case (#ok(key)) assert key == rootKey; case (#err(_)) assert false };
    switch (await* reinstalled.marketplace_read_identity({ publicKey = sessionKey })) { case (#err(_)) {}; case (_) assert false };
};
