import Blob "mo:core/Blob";
import Nat32 "mo:core/Nat32";
import Principal "mo:core/Principal";
import Mail "../../backend/main";
import Capabilities "../../backend/capabilities/Types";
import Delivery "../../backend/mailbox/Delivery";
import Memory "../../backend/memory/mail/v1";
import RemoteWire "../../backend/protocol/RemoteWire";
import CryptoFixture "CryptoFixture";
import Fixture "Fixture";

func canister(last : Nat8) : Principal {
    Principal.fromBlob(Blob.fromArray([0, last, 1]));
};

func expectReceiveInvalid(encoded : Blob) {
    switch (RemoteWire.decodeReceivePayload(encoded)) {
        case (?#rejected(#invalid)) {};
        case (_) assert false;
    };
};

func expectReceiveCryptoUnavailable(encoded : Blob) {
    switch (RemoteWire.decodeReceivePayload(encoded)) {
        case (?#rejected(#crypto_unavailable)) {};
        case (_) assert false;
    };
};

let self = canister(1);
let remote = canister(2);
let user = CryptoFixture.holder();
assert (not Principal.isCanister(user));
var liveSlot : ?Capabilities.VetKeySlotSummary = null;
let capabilities : {
    backend_calls : Capabilities.BackendCalls;
    vetkeys_public : Capabilities.VetKeysPublic;
} = {
    backend_calls = {
        canister_principal = self;
        can_call = func(_canister : Principal, _method : Text) { true };
        call = func(_request : Capabilities.CallRequest) : async* Capabilities.CallResult {
            #err({ code = "unused"; message = "unused" });
        };
        call_batch = func(_requests : [Capabilities.CallRequest]) : async* [Capabilities.CallResult] {
            [];
        };
    };
    vetkeys_public = {
        canister_principal = self;
        slot = func(slot : Text) : ?Capabilities.VetKeySlotSummary {
            if (slot == "mailbox") liveSlot else null;
        };
        public_key = func(
            _request : { slot : Text; generation : Nat64 },
        ) : async* Capabilities.VetKeyPublicResult {
            #err(#not_reserved);
        };
    };
};
let appCalls : Mail.AppCalls = {
    contacts = {
        contacts_neutron_lookup_v2 = func(request) {
            {
                book_revision = 1;
                integrity_ok = true;
                match = ?{
                    contact_id = 1;
                    contact_revision = 1;
                    contact_name = "Remote";
                    principal = request.principal;
                };
            };
        };
        contacts_neutron_search_v2 = func(request) {
            if (request.offset == 0) {
                #ok({
                    book_revision = 1;
                    contacts = [{
                        contact_id = 1;
                        contact_revision = 1;
                        contact_name = "Remote";
                        principal = remote;
                    }];
                    total = 1;
                    next_offset = null;
                });
            } else {
                #ok({
                    book_revision = 1;
                    contacts = [];
                    total = 1;
                    next_offset = null;
                });
            };
        };
        contacts_neutron_revision_v2 = func(_unit : ()) { 1 };
    };
};
let mem = Memory.init();
let mail = Mail.Init({
    stable_memory = { mail = mem };
    app_calls = appCalls;
    capabilities;
});

switch (mail.mail_status(())) {
    case (#err(_)) assert false;
    case (#ok(emptyStatus)) {
        switch (emptyStatus.setup) {
            case (#not_configured) {};
            case (_) assert false;
        };
        assert (emptyStatus.unread_count == 0 and emptyStatus.inbox_count == 0);
    };
};
switch (mail.mail_pulse(())) {
    case (#err(_)) assert false;
    case (#ok(pulse)) {
        assert (pulse.mail_revision == 0 and pulse.contacts_revision == 1);
        assert (pulse.cleanup_epoch == 0 and pulse.inbox_count == 0);
        assert (pulse.unread_count == 0);
    };
};
// Stable Mail state alone is never sufficient to publish a delivery key or
// accept ciphertext: the exact live kernel slot must still be enabled.
switch (RemoteWire.decodeKeyInfoPayload(mail.mail_key_info_v1((), remote))) {
    case (?#unavailable) {};
    case (_) assert false;
};
expectReceiveCryptoUnavailable(mail.mail_receive_v1("\00", remote));
// The paid kernel dispatcher supplies canister-mediation proof. The app does
// not reclassify that caller; only its distinct-self protocol check remains.
expectReceiveCryptoUnavailable(mail.mail_receive_v1("\00", Principal.anonymous()));
expectReceiveCryptoUnavailable(mail.mail_receive_v1("\00", user));
expectReceiveInvalid(mail.mail_receive_v1("\00", self));

switch (RemoteWire.decodeKeyInfoPayload(mail.mail_key_info_v1((), remote))) {
    case (?#unavailable) {};
    case (_) assert false;
};
switch (mail.mail_settings_encrypted(())) {
    case (#err(#not_configured)) {};
    case (_) assert false;
};
switch (mail.mail_recipients({ search_text = "rem"; offset = 0; limit = 1 })) {
    case (#ok(page)) {
        assert (page.contacts.size() == 1 and page.total == 1);
        assert (page.contacts[0].principal == remote);
    };
    case (_) assert false;
};

let publicKey = Fixture.repeatBlob(96, 0x31);
let identity = Fixture.repeatBlob(32, 0x32);
let fingerprint = Delivery.keyFingerprint(1, 7, publicKey, identity);
mem.key_info := ?{
    protocol_version = 1;
    suite = 1;
    key_holder = Principal.fromText("pcofx-mj5y3-27jya-3jcsk-jzcy2-2y6yj-bvf32-ousik-tb3ks-uyjkz-rqe");
    current_epoch = 7;
    current_fingerprint = fingerprint;
    context_public_key = publicKey;
    effective_ibe_identity = identity;
    max_envelope_bytes = Nat32.fromNat(39_199);
    previous_epoch = null;
    previous_fingerprint = null;
};
switch (mail.mail_status(())) {
    case (#err(_)) assert false;
    case (#ok(status)) {
        switch (status.setup) {
            case (#configured(configured)) {
                assert (configured.current_epoch == 7);
            };
            case (_) assert false;
        };
    };
};
switch (RemoteWire.decodeKeyInfoPayload(mail.mail_key_info_v1((), remote))) {
    case (?#unavailable) {};
    case (_) assert false;
};
expectReceiveCryptoUnavailable(mail.mail_receive_v1("\00", remote));
liveSlot := ?CryptoFixture.summary(
    7,
    null,
    #enabled,
    CryptoFixture.holder(),
);
switch (RemoteWire.decodeKeyInfoPayload(mail.mail_key_info_v1((), remote))) {
    case (?#unavailable) assert false;
    case (?#ok(info)) {
        assert (info.protocol_version == 1 and info.suite == 1);
        assert (info.delivery_key_epoch == 7);
        assert (info.recipient_key_fingerprint == fingerprint);
        assert (Nat32.toNat(info.max_envelope_bytes) == 39_199);
    };
};
switch (RemoteWire.decodeKeyInfoPayload(mail.mail_key_info_v1((), user))) {
    case (?#ok(_)) {};
    case (_) assert false;
};
switch (RemoteWire.decodeKeyInfoPayload(mail.mail_key_info_v1((), self))) {
    case (?#unavailable) {};
    case (_) assert false;
};
switch (mail.mail_settings_encrypted(())) {
    case (#ok(null)) {};
    case (_) assert false;
};
let encryptedSettings = {
    record_id = Fixture.repeatBlob(16, 0x11);
    revision : Nat64 = 1;
    local_wrap_epoch : Nat64 = 7;
    local_wrap_fingerprint = fingerprint;
    local_wrapped_cek = Fixture.repeatBlob(168, 0x41);
    nonce = Fixture.repeatBlob(12, 0x51);
    ciphertext_and_tag = Fixture.repeatBlob(32, 0x61);
};
switch (mail.mail_settings_set_encrypted(#create(encryptedSettings))) {
    case (#ok(settings)) assert (settings == encryptedSettings);
    case (_) assert false;
};
switch (mail.mail_settings_encrypted(())) {
    case (#ok(?settings)) assert (settings == encryptedSettings);
    case (_) assert false;
};

// Exercise the generated public receive shape without invoking Time.now.
expectReceiveInvalid(mail.mail_receive_v1("\00", remote));
expectReceiveInvalid(mail.mail_receive_v1("\00", user));

liveSlot := ?CryptoFixture.summary(
    7,
    null,
    #disabled,
    CryptoFixture.holder(),
);
switch (RemoteWire.decodeKeyInfoPayload(mail.mail_key_info_v1((), remote))) {
    case (?#unavailable) {};
    case (_) assert false;
};
expectReceiveCryptoUnavailable(mail.mail_receive_v1("\00", remote));
expectReceiveCryptoUnavailable(mail.mail_receive_v1("\00", Principal.anonymous()));
expectReceiveCryptoUnavailable(mail.mail_receive_v1("\00", user));
expectReceiveInvalid(mail.mail_receive_v1("\00", self));

// Lifecycle-manager transfer preserves the namespace and delivery key.
liveSlot := ?CryptoFixture.summary(
    7,
    null,
    #enabled,
    CryptoFixture.otherHolder(),
);
switch (RemoteWire.decodeKeyInfoPayload(mail.mail_key_info_v1((), remote))) {
    case (?#ok(_)) {};
    case (_) assert false;
};
