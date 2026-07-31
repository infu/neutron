import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Int64 "mo:core/Int64";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat32 "mo:core/Nat32";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Capabilities "../../backend/capabilities/Types";
import Delivery "../../backend/mailbox/Delivery";
import Receive "../../backend/mailbox/Receive";
import Store "../../backend/mailbox/Store";
import Memory "../../backend/memory/mail/v1";
import RemoteWire "../../backend/protocol/RemoteWire";
import Fixture "Fixture";

func canister(last : Nat8) : Principal {
    Principal.fromBlob(Blob.fromArray([0, last, 1]));
};

let self = canister(1);
let recipient = canister(2);
let holder = Principal.fromText("pcofx-mj5y3-27jya-3jcsk-jzcy2-2y6yj-bvf32-ousik-tb3ks-uyjkz-rqe");
let recipientPublicKey = Fixture.repeatBlob(96, 0x31);
let recipientIdentity = Fixture.repeatBlob(32, 0x32);
let recipientFingerprint = Delivery.keyFingerprint(1, 7, recipientPublicKey, recipientIdentity);
let MALFORMED_DIDL = Blob.fromArray([0x44, 0x49, 0x44, 0x4c, 0x80, 0x80]);
let MAIL_INGRESS_METHOD = "app_mail__mail_v1_update";
let keyInfo : Delivery.MailKeyInfoV1 = {
    protocol_version = 1;
    suite = 1;
    delivery_key_epoch = 7;
    context_public_key = recipientPublicKey;
    effective_ibe_identity = recipientIdentity;
    recipient_key_fingerprint = recipientFingerprint;
    max_envelope_bytes = Nat32.fromNat(39_199);
};

func keyReply(result : Delivery.MailKeyInfoResultV1) : Capabilities.CallResult {
    let outer : Capabilities.PublicIngressResult = #ok(
        to_candid (RemoteWire.encodeKeyInfoPayload(result))
    );
    #ok(to_candid (outer));
};

func receiveReply(result : Receive.ReceiveResultV1) : Capabilities.CallResult {
    let outer : Capabilities.PublicIngressResult = #ok(
        to_candid (RemoteWire.encodeReceivePayload(result))
    );
    #ok(to_candid (outer));
};

func ingressArgs(method : Text, payload : Blob) : Blob {
    let request : Capabilities.PublicIngressRequest = { method; payload };
    to_candid (request);
};

func withFingerprint(envelope : Blob, fingerprint : Blob) : Blob {
    let bytes = Blob.toArray(envelope);
    let fingerprintBytes = Blob.toArray(fingerprint);
    Blob.fromArray(Array.tabulate<Nat8>(bytes.size(), func(index) {
        if (index >= 11 and index < 43) fingerprintBytes[index - 11] else bytes[index];
    }));
};

let HEX : [Text] = [
    "0", "1", "2", "3", "4", "5", "6", "7",
    "8", "9", "a", "b", "c", "d", "e", "f",
];

func hex(value : Blob) : Text {
    var result = "";
    for (byte in value.values()) {
        let number = Nat8.toNat(byte);
        result #= HEX[number / 16] # HEX[number % 16];
    };
    result;
};

func preparationEdges() : () {
    let mem = Memory.init();
    var currentTime = 3_000_000_000_000;
    var reservation = true;
    var integrity = true;
    var bookRevision = 4;
    var contactRevision = 5;
    let calls : Capabilities.BackendCalls = {
        canister_principal = self;
        can_call = func(target : Principal, method : Text) : Bool {
            reservation and Principal.equal(target, recipient) and
            method == MAIL_INGRESS_METHOD;
        };
        call = func(_request : Capabilities.CallRequest) : async* Capabilities.CallResult {
            #err({ code = "unused"; message = "unused" });
        };
        call_batch = func(_requests : [Capabilities.CallRequest]) : async* [Capabilities.CallResult] { [] };
    };
    let delivery = Delivery.Service(
        mem,
        self,
        calls,
        func(target : Principal) : Delivery.ContactLookup {
            {
                book_revision = bookRevision;
                integrity_ok = integrity;
                match = if (Principal.equal(target, recipient)) {
                    ?{ contact_id = 3; contact_revision = contactRevision; principal = recipient };
                } else null;
            };
        },
        func() { currentTime },
    );

    reservation := false;
    switch (delivery.prepareStart({
        recipient = #direct({ principal = recipient });
        permit_request_id = Fixture.repeatBlob(16, 0x90);
    })) {
        case (#err(#permission_required)) {};
        case (_) assert false;
    };
    reservation := true;
    integrity := false;
    switch (delivery.prepareStart({
        recipient = #contact({ principal = recipient; contact_id = 3; expected_contact_revision = 5 });
        permit_request_id = Fixture.repeatBlob(16, 0x91);
    })) {
        case (#err(#recipient_changed)) {};
        case (_) assert false;
    };
    integrity := true;

    let contactRace = switch (delivery.prepareStart({
        recipient = #contact({ principal = recipient; contact_id = 3; expected_contact_revision = 5 });
        permit_request_id = Fixture.repeatBlob(16, 0x92);
    })) {
        case (#ok(value)) value;
        case (_) { assert false; loop {} };
    };
    contactRevision := 6;
    bookRevision := 5;
    switch (delivery.prepareFinish(
        contactRace,
        keyReply(#ok(keyInfo)),
    )) {
        case (#err(#recipient_changed)) {};
        case (_) assert false;
    };
    assert (Map.size(mem.permits) == 0);

    let cleanupRace = switch (delivery.prepareStart({
        recipient = #direct({ principal = recipient });
        permit_request_id = Fixture.repeatBlob(16, 0x93);
    })) {
        case (#ok(value)) value;
        case (_) { assert false; loop {} };
    };
    mem.cleanup_epoch += 1;
    switch (delivery.prepareFinish(
        cleanupRace,
        keyReply(#ok(keyInfo)),
    )) {
        case (#err(#recipient_changed)) {};
        case (_) assert false;
    };

    let malformed = switch (delivery.prepareStart({
        recipient = #direct({ principal = recipient });
        permit_request_id = Fixture.repeatBlob(16, 0x94);
    })) {
        case (#ok(value)) value;
        case (_) { assert false; loop {} };
    };
    switch (delivery.prepareFinish(malformed, #ok(MALFORMED_DIDL))) {
        case (#err(#recipient_unavailable)) {};
        case (_) assert false;
    };

    // Repeating even the same browser request id allocates a different durable
    // server generation. An old encrypted command therefore cannot regain its
    // consumed permit after bounded command tombstones are evicted.
    let repeatedRequest = {
        recipient = #direct({ principal = recipient });
        permit_request_id = Fixture.repeatBlob(16, 0x95);
    };
    let repeatedFirst = switch (delivery.prepareStart(repeatedRequest)) {
        case (#ok(value)) value;
        case (_) { assert false; loop {} };
    };
    let repeatedSecond = switch (delivery.prepareStart(repeatedRequest)) {
        case (#ok(value)) value;
        case (_) { assert false; loop {} };
    };
    assert (not Blob.equal(repeatedFirst.permit_id, repeatedSecond.permit_id));
    assert (repeatedFirst.permit_id.size() == 32 and repeatedSecond.permit_id.size() == 32);

    var index : Nat8 = 1;
    while (index <= 64) {
        let id = Fixture.repeatBlob(32, index);
        let permit : Memory.RecipientPermit = {
            permit_id = id;
            target = recipient;
            contact_id = null;
            contact_revision = null;
            book_revision = 0;
            suite = 1;
            delivery_key_epoch = 7;
            delivery_key_fingerprint = recipientFingerprint;
            public_info_hash = Fixture.repeatBlob(32, index);
            cleanup_epoch = mem.cleanup_epoch;
            expires_at_ns = currentTime + 100_000_000_000;
        };
        Map.add(mem.permits, Text.compare, hex(id), permit);
        index += 1;
    };
    switch (delivery.prepareStart({
        recipient = #direct({ principal = recipient });
        permit_request_id = Fixture.repeatBlob(16, 0xfe);
    })) {
        case (#err(#permit_capacity)) {};
        case (_) assert false;
    };

    // A stable-state clock rollback can leave otherwise-valid five-minute
    // preparation permits far ahead of Time.now(). They are ephemeral, so a
    // fresh preparation discards all of them and immediately recovers capacity.
    currentTime -= 600_000_000_000;
    let rollbackRecovery = switch (delivery.prepareStart({
        recipient = #direct({ principal = recipient });
        permit_request_id = Fixture.repeatBlob(16, 0xfd);
    })) {
        case (#ok(value)) value;
        case (_) { assert false; loop {} };
    };
    assert (rollbackRecovery.started_at_ns == currentTime);
    assert (Map.size(mem.permits) == 0);

    switch (delivery.prepareStart({
        recipient = #direct({ principal = recipient });
        permit_request_id = Fixture.repeatBlob(16, 0x00);
    })) {
        case (#err(#invalid_request)) {};
        case (_) assert false;
    };
};

func remoteClassificationEdges() : () {
    let mem = Memory.init();
    let localPublicKey = Fixture.repeatBlob(96, 0x51);
    let localIdentity = Fixture.repeatBlob(32, 0x52);
    let localFingerprint = Delivery.keyFingerprint(1, 11, localPublicKey, localIdentity);
    mem.key_info := ?{
        protocol_version = 1;
        suite = 1;
        key_holder = holder;
        current_epoch = 11;
        current_fingerprint = localFingerprint;
        context_public_key = localPublicKey;
        effective_ibe_identity = localIdentity;
        max_envelope_bytes = Nat32.fromNat(39_199);
        previous_epoch = null;
        previous_fingerprint = null;
    };
    var currentTime = 4_000_000_000_000;
    var contactIntegrity = true;
    let calls : Capabilities.BackendCalls = {
        canister_principal = self;
        can_call = func(target : Principal, method : Text) : Bool {
            Principal.equal(target, recipient) and
            method == MAIL_INGRESS_METHOD;
        };
        call = func(_request : Capabilities.CallRequest) : async* Capabilities.CallResult {
            #err({ code = "unused"; message = "unused" });
        };
        call_batch = func(_requests : [Capabilities.CallRequest]) : async* [Capabilities.CallResult] { [] };
    };
    let delivery = Delivery.Service(
        mem,
        self,
        calls,
        func(target : Principal) : Delivery.ContactLookup {
            {
                book_revision = 8;
                integrity_ok = contactIntegrity;
                match = if (Principal.equal(target, recipient)) {
                    ?{ contact_id = 7; contact_revision = 9; principal = recipient };
                } else null;
            };
        },
        func() { currentTime },
    );
    let infoHash = Delivery.publicInfoHash(recipient, keyInfo);

    func start(number : Nat8, contact : Bool) : Delivery.DeliveryDispatch {
        let permitId = Fixture.repeatBlob(32, number);
        let permit : Memory.RecipientPermit = {
            permit_id = permitId;
            target = recipient;
            contact_id = if (contact) ?7 else null;
            contact_revision = if (contact) ?9 else null;
            book_revision = if (contact) 8 else 0;
            suite = 1;
            delivery_key_epoch = 7;
            delivery_key_fingerprint = recipientFingerprint;
            public_info_hash = infoHash;
            cleanup_epoch = mem.cleanup_epoch;
            expires_at_ns = currentTime + 300_000_000_000;
        };
        Map.add(mem.permits, Text.compare, hex(permitId), permit);
        let request : Delivery.SendEncryptedRequest = {
            command_id = Fixture.repeatBlob(16, number + 80);
            permit_id = permitId;
            recipient;
            public_info_hash = infoHash;
            envelope = withFingerprint(
                Fixture.envelope(1_040, Nat8.toNat(number), 7, 0x22),
                recipientFingerprint,
            );
            local_wrap_epoch = 11;
            local_wrap_fingerprint = localFingerprint;
            local_wrapped_cek = Fixture.repeatBlob(168, number);
        };
        switch (delivery.sendStart(request)) {
            case (#ok(#dispatch(value))) value;
            case (_) { assert false; loop {} };
        }
    };

    let rate = start(1, false);
    let rateResponse : Receive.ReceiveResultV1 = #rejected(#rate_limited({
        retry_after_seconds = 300;
    }));
    switch (delivery.finishDelivery(rate, receiveReply(rateResponse))) {
        case (#ok({ state = #not_sent(#rate_limited) })) {};
        case (_) assert false;
    };
    let rateRevision = mem.revision;
    let rateTombstones = mem.retry_tombstones.size();
    let rateRetry : Delivery.RetryRequest = {
        local_id = rate.local_id;
        retry_request_id = Fixture.repeatBlob(16, 0xd1);
    };
    currentTime -= 1;
    switch (delivery.retryStart(rateRetry)) {
        case (#err(#clock_invalid)) {};
        case (_) assert false;
    };
    assert (mem.revision == rateRevision and mem.retry_tombstones.size() == rateTombstones);
    switch (Map.get(mem.outbox, Nat.compare, rate.local_id)) {
        case (?record) {
            assert (record.attempt_no == 1 and record.attempt_request_id == null);
            switch (record.state) {
                case (#not_sent(#rate_limited)) {};
                case (_) assert false;
            };
        };
        case null assert false;
    };
    currentTime += 2;
    let rateRetryDispatch = switch (delivery.retryStart(rateRetry)) {
        case (#ok(#dispatch(value))) value;
        case (_) { assert false; loop {} };
    };
    assert (rateRetryDispatch.attempt_no == 2 and rateRetryDispatch.call == rate.call);
    switch (delivery.finishDelivery(
        rateRetryDispatch,
        receiveReply(#duplicate({ received_at_ns = Int64.fromInt(currentTime) })),
    )) {
        case (#ok({ state = #accepted(_) })) {};
        case (_) assert false;
    };

    let full = start(2, false);
    let fullResponse : Receive.ReceiveResultV1 = #rejected(#mailbox_full);
    switch (delivery.finishDelivery(full, receiveReply(fullResponse))) {
        case (#ok({ state = #not_sent(#mailbox_full) })) {};
        case (_) assert false;
    };

    let staleZero = start(3, false);
    let staleZeroResponse : Receive.ReceiveResultV1 = #rejected(#stale_key({
        current_epoch = 8;
        current_fingerprint = Fixture.repeatBlob(32, 0);
    }));
    switch (delivery.finishDelivery(staleZero, receiveReply(staleZeroResponse))) {
        case (#ok({ state = #delivery_uncertain })) {};
        case (_) assert false;
    };

    let malformed = start(4, false);
    switch (delivery.finishDelivery(malformed, #ok(MALFORMED_DIDL))) {
        case (#ok({ state = #delivery_uncertain })) {};
        case (_) assert false;
    };

    let futureAccepted = start(5, false);
    let futureResponse : Receive.ReceiveResultV1 = #accepted({
        received_at_ns = Int64.fromInt(currentTime + 1);
    });
    switch (delivery.finishDelivery(futureAccepted, receiveReply(futureResponse))) {
        case (#ok({ state = #delivery_uncertain })) {};
        case (_) assert false;
    };

    let regressed = start(6, false);
    currentTime -= 1;
    let accepted : Receive.ReceiveResultV1 = #accepted({
        received_at_ns = Int64.fromInt(currentTime);
    });
    switch (delivery.finishDelivery(regressed, receiveReply(accepted))) {
        case (#ok(result)) {
            switch (result.state) {
                case (#delivery_uncertain) assert (result.updated_at_ns == currentTime + 1);
                case (_) assert false;
            };
        };
        case (_) assert false;
    };
    currentTime += 2;

    let changedContact = start(7, true);
    contactIntegrity := false;
    let duplicate : Receive.ReceiveResultV1 = #duplicate({
        received_at_ns = Int64.fromInt(currentTime);
    });
    switch (delivery.finishDelivery(changedContact, receiveReply(duplicate))) {
        case (#ok({ state = #delivery_uncertain })) {};
        case (_) assert false;
    };
};

func staleSendingRecoveryEdges() : () {
    let mem = Memory.init();
    let localPublicKey = Fixture.repeatBlob(96, 0x61);
    let localIdentity = Fixture.repeatBlob(32, 0x62);
    let localFingerprint = Delivery.keyFingerprint(1, 13, localPublicKey, localIdentity);
    mem.key_info := ?{
        protocol_version = 1;
        suite = 1;
        key_holder = holder;
        current_epoch = 13;
        current_fingerprint = localFingerprint;
        context_public_key = localPublicKey;
        effective_ibe_identity = localIdentity;
        max_envelope_bytes = Nat32.fromNat(39_199);
        previous_epoch = null;
        previous_fingerprint = null;
    };
    var currentTime : Int = 5_000_000_000_000;
    let calls : Capabilities.BackendCalls = {
        canister_principal = self;
        can_call = func(target : Principal, method : Text) : Bool {
            Principal.equal(target, recipient) and
            method == MAIL_INGRESS_METHOD;
        };
        call = func(_request : Capabilities.CallRequest) : async* Capabilities.CallResult {
            #err({ code = "unused"; message = "unused" });
        };
        call_batch = func(_requests : [Capabilities.CallRequest]) : async* [Capabilities.CallResult] { [] };
    };
    let delivery = Delivery.Service(
        mem,
        self,
        calls,
        func(_target : Principal) : Delivery.ContactLookup {
            { book_revision = 0; integrity_ok = true; match = null };
        },
        func() { currentTime },
    );
    let infoHash = Delivery.publicInfoHash(recipient, keyInfo);

    func start(number : Nat8) : (Delivery.SendEncryptedRequest, Delivery.DeliveryDispatch) {
        let permitId = Fixture.repeatBlob(32, number);
        let permit : Memory.RecipientPermit = {
            permit_id = permitId;
            target = recipient;
            contact_id = null;
            contact_revision = null;
            book_revision = 0;
            suite = 1;
            delivery_key_epoch = 7;
            delivery_key_fingerprint = recipientFingerprint;
            public_info_hash = infoHash;
            cleanup_epoch = mem.cleanup_epoch;
            expires_at_ns = currentTime + 300_000_000_000;
        };
        Map.add(mem.permits, Text.compare, hex(permitId), permit);
        let request : Delivery.SendEncryptedRequest = {
            command_id = Fixture.repeatBlob(16, number + 80);
            permit_id = permitId;
            recipient;
            public_info_hash = infoHash;
            envelope = withFingerprint(
                Fixture.envelope(1_040, Nat8.toNat(number), 7, 0x22),
                recipientFingerprint,
            );
            local_wrap_epoch = 13;
            local_wrap_fingerprint = localFingerprint;
            local_wrapped_cek = Fixture.repeatBlob(168, number);
        };
        let dispatch = switch (delivery.sendStart(request)) {
            case (#ok(#dispatch(value))) value;
            case (_) { assert false; loop {} };
        };
        (request, dispatch);
    };

    func stored(localId : Nat) : Memory.OutboxRecord {
        switch (Map.get(mem.outbox, Nat.compare, localId)) {
            case (?record) record;
            case null { assert false; loop {} };
        };
    };

    // A new click before the frozen boundary coalesces to the original attempt
    // and its request id cannot later turn into a dispatch.
    let (originalRequest, originalDispatch) = start(20);
    let originalStartedAt = currentTime;
    let earlyOriginal : Delivery.RetryRequest = {
        local_id = originalDispatch.local_id;
        retry_request_id = Fixture.repeatBlob(16, 0xa1);
    };
    currentTime := originalStartedAt + Delivery.SENDING_RECOVERY_TIMEOUT_NS - 1;
    let beforeRevision = mem.revision;
    switch (delivery.retryStart(earlyOriginal)) {
        case (#ok(#complete(value))) {
            assert (value.attempt_no == 1 and value.updated_at_ns == originalStartedAt);
            switch (value.state) {
                case (#sending) {};
                case (_) assert false;
            };
        };
        case (_) assert false;
    };
    assert (mem.revision == beforeRevision + 1 and mem.retry_tombstones.size() == 1);
    currentTime += 1;
    let coalescedRevision = mem.revision;
    switch (delivery.retryStart(earlyOriginal)) {
        case (#ok(#complete(value))) assert (value.attempt_no == 1);
        case (_) assert false;
    };
    assert (mem.revision == coalescedRevision);

    // At the exact boundary a fresh id supersedes the lost continuation and
    // dispatches byte-for-byte the same receive call.
    let recoverOriginal : Delivery.RetryRequest = {
        local_id = originalDispatch.local_id;
        retry_request_id = Fixture.repeatBlob(16, 0xa2);
    };
    let recoveredOriginal = switch (delivery.retryStart(recoverOriginal)) {
        case (#ok(#dispatch(value))) value;
        case (_) { assert false; loop {} };
    };
    assert (recoveredOriginal.attempt_no == 2);
    assert (recoveredOriginal.call == originalDispatch.call);
    let originalAttemptTwo = stored(originalDispatch.local_id);
    assert (
        originalAttemptTwo.attempt_no == 2 and
        originalAttemptTwo.updated_at_ns == currentTime and
        originalAttemptTwo.attempt_request_id == ?recoverOriginal.retry_request_id and
        Blob.equal(originalAttemptTwo.envelope, originalRequest.envelope) and
        Blob.equal(originalAttemptTwo.message_id, originalDispatch.message_id)
    );
    switch (delivery.finishDelivery(
        originalDispatch,
        receiveReply(#accepted({ received_at_ns = Int64.fromInt(currentTime) })),
    )) {
        case (#err(#attempt_superseded)) {};
        case (_) assert false;
    };
    assert (stored(originalDispatch.local_id).attempt_no == 2);

    // The same rule applies when the durable stale record is itself a retry.
    // Its late callback is superseded by attempt/origin matching.
    let earlyRetry : Delivery.RetryRequest = {
        local_id = originalDispatch.local_id;
        retry_request_id = Fixture.repeatBlob(16, 0xa3);
    };
    let retryStartedAt = currentTime;
    currentTime := retryStartedAt + Delivery.SENDING_RECOVERY_TIMEOUT_NS - 1;
    switch (delivery.retryStart(earlyRetry)) {
        case (#ok(#complete(value))) assert (value.attempt_no == 2);
        case (_) assert false;
    };
    currentTime += 1;
    let recoverRetry : Delivery.RetryRequest = {
        local_id = originalDispatch.local_id;
        retry_request_id = Fixture.repeatBlob(16, 0xa4);
    };
    let recoveredRetry = switch (delivery.retryStart(recoverRetry)) {
        case (#ok(#dispatch(value))) value;
        case (_) { assert false; loop {} };
    };
    assert (recoveredRetry.attempt_no == 3 and recoveredRetry.call == originalDispatch.call);
    switch (delivery.finishDelivery(
        recoveredOriginal,
        receiveReply(#accepted({ received_at_ns = Int64.fromInt(currentTime) })),
    )) {
        case (#err(#attempt_superseded)) {};
        case (_) assert false;
    };
    let recovered = switch (delivery.finishDelivery(
        recoveredRetry,
        receiveReply(#duplicate({ received_at_ns = Int64.fromInt(currentTime) })),
    )) {
        case (#ok(value)) value;
        case (_) { assert false; loop {} };
    };
    assert (recovered.attempt_no == 3);
    switch (recovered.state) {
        case (#accepted(_)) {};
        case (_) assert false;
    };

    // Deleting a recovered in-flight item tombstones its command/current retry
    // and neither old callback can recreate the row or dispatch it again.
    let (deletedRequest, deletedOriginal) = start(21);
    currentTime += Delivery.SENDING_RECOVERY_TIMEOUT_NS;
    let deletedRetryRequest : Delivery.RetryRequest = {
        local_id = deletedOriginal.local_id;
        retry_request_id = Fixture.repeatBlob(16, 0xa5);
    };
    let deletedRetry = switch (delivery.retryStart(deletedRetryRequest)) {
        case (#ok(#dispatch(value))) value;
        case (_) { assert false; loop {} };
    };
    let store = Store.Service(
        mem,
        func() { currentTime },
        func() { 0 },
        func(_target : Principal) { #none },
    );
    switch (store.delete({ targets = [#outbox(deletedOriginal.local_id)] })) {
        case (#ok(result)) assert (result.outbox_deleted == 1 and result.changed == 1);
        case (_) assert false;
    };
    switch (delivery.finishDelivery(
        deletedOriginal,
        receiveReply(#accepted({ received_at_ns = Int64.fromInt(currentTime) })),
    )) {
        case (#err(#attempt_superseded)) {};
        case (_) assert false;
    };
    switch (delivery.finishDelivery(
        deletedRetry,
        receiveReply(#duplicate({ received_at_ns = Int64.fromInt(currentTime) })),
    )) {
        case (#err(#attempt_superseded)) {};
        case (_) assert false;
    };
    assert (Map.get(mem.outbox, Nat.compare, deletedOriginal.local_id) == null);
    switch (delivery.sendStart(deletedRequest)) {
        case (#err(#command_deleted({ local_id }))) assert (local_id == deletedOriginal.local_id);
        case (_) assert false;
    };
    switch (delivery.retryStart(deletedRetryRequest)) {
        case (#err(#retry_deleted)) {};
        case (_) assert false;
    };
    switch (delivery.retryStart({
        local_id = deletedOriginal.local_id;
        retry_request_id = Fixture.repeatBlob(16, 0xa6);
    })) {
        case (#err(#not_found)) {};
        case (_) assert false;
    };

    // Invalid or regressed clocks cannot age an attempt. Near Int64 max the
    // subtraction-based boundary remains safe and a fresh click still
    // coalesces immediately after recovery.
    let (_, clockOriginal) = start(22);
    let clockStartedAt = currentTime;
    let clockRevision = mem.revision;
    currentTime -= 1;
    switch (delivery.retryStart({
        local_id = clockOriginal.local_id;
        retry_request_id = Fixture.repeatBlob(16, 0xa7);
    })) {
        case (#err(#clock_invalid)) {};
        case (_) assert false;
    };
    assert (mem.revision == clockRevision and stored(clockOriginal.local_id).attempt_no == 1);
    currentTime := -1;
    switch (delivery.retryStart({
        local_id = clockOriginal.local_id;
        retry_request_id = Fixture.repeatBlob(16, 0xa8);
    })) {
        case (#err(#clock_invalid)) {};
        case (_) assert false;
    };
    currentTime := 9_223_372_036_854_775_808;
    switch (delivery.retryStart({
        local_id = clockOriginal.local_id;
        retry_request_id = Fixture.repeatBlob(16, 0xa9);
    })) {
        case (#err(#clock_invalid)) {};
        case (_) assert false;
    };
    currentTime := 9_223_372_036_854_775_807;
    let maxRecovery = switch (delivery.retryStart({
        local_id = clockOriginal.local_id;
        retry_request_id = Fixture.repeatBlob(16, 0xaa);
    })) {
        case (#ok(#dispatch(value))) value;
        case (_) { assert false; loop {} };
    };
    assert (maxRecovery.call == clockOriginal.call and maxRecovery.attempt_no == 2);
    switch (delivery.retryStart({
        local_id = clockOriginal.local_id;
        retry_request_id = Fixture.repeatBlob(16, 0xab);
    })) {
        case (#ok(#complete(value))) {
            assert (value.attempt_no == 2 and value.updated_at_ns == currentTime);
        };
        case (_) assert false;
    };
    currentTime -= 1;
    switch (delivery.retryStart({
        local_id = clockOriginal.local_id;
        retry_request_id = Fixture.repeatBlob(16, 0xac);
    })) {
        case (#err(#clock_invalid)) {};
        case (_) assert false;
    };
    assert (clockStartedAt >= 0);
};

func test() : () {
    let mem = Memory.init();
    let localPublicKey = Fixture.repeatBlob(96, 0x41);
    let localIdentity = Fixture.repeatBlob(32, 0x42);
    let localFingerprint = Delivery.keyFingerprint(1, 9, localPublicKey, localIdentity);
    mem.key_info := ?{
        protocol_version = 1;
        suite = 1;
        key_holder = holder;
        current_epoch = 9;
        current_fingerprint = localFingerprint;
        context_public_key = localPublicKey;
        effective_ibe_identity = localIdentity;
        max_envelope_bytes = Nat32.fromNat(39_199);
        previous_epoch = null;
        previous_fingerprint = null;
    };
    var currentTime = 1_000_000_000_000;
    var reservation = true;
    let calls : Capabilities.BackendCalls = {
        canister_principal = self;
        can_call = func(target : Principal, method : Text) : Bool {
            reservation and Principal.equal(target, recipient) and
            method == MAIL_INGRESS_METHOD;
        };
        call = func(_request : Capabilities.CallRequest) : async* Capabilities.CallResult {
            #err({ code = "unused"; message = "unused" });
        };
        call_batch = func(_requests : [Capabilities.CallRequest]) : async* [Capabilities.CallResult] { [] };
    };
    let delivery = Delivery.Service(
        mem,
        self,
        calls,
        func(target : Principal) : Delivery.ContactLookup {
            {
                book_revision = 4;
                integrity_ok = true;
                match = if (Principal.equal(target, recipient)) {
                    ?{ contact_id = 3; contact_revision = 5; principal = recipient };
                } else null;
            };
        },
        func() { currentTime },
    );

    let permitId = Fixture.repeatBlob(16, 0x81);
    let prepareDispatch = switch (delivery.prepareStart({
        recipient = #contact({
            principal = recipient;
            contact_id = 3;
            expected_contact_revision = 5;
        });
        permit_request_id = permitId;
    })) {
        case (#err(_)) { assert false; loop {} };
        case (#ok(value)) value;
    };
    assert (prepareDispatch.call.method == MAIL_INGRESS_METHOD);
    assert (prepareDispatch.call.cycles == Delivery.KEY_INFO_REQUIRED_CYCLES);
    assert (Blob.equal(prepareDispatch.call.args, ingressArgs("key_info", to_candid ((),))));
    let prepared = switch (delivery.prepareFinish(
        prepareDispatch,
        keyReply(#ok(keyInfo)),
    )) {
        case (#err(_)) { assert false; loop {} };
        case (#ok(value)) value;
    };
    assert (prepared.expires_at_ns == currentTime + 300_000_000_000);
    assert (Map.size(mem.permits) == 1 and prepared.public_info_hash.size() == 32);

    let request : Delivery.SendEncryptedRequest = {
        command_id = Fixture.repeatBlob(16, 0x82);
        permit_id = prepared.permit_id;
        recipient;
        public_info_hash = prepared.public_info_hash;
        envelope = withFingerprint(Fixture.envelope(1_040, 7, 7, 0x22), recipientFingerprint);
        local_wrap_epoch = 9;
        local_wrap_fingerprint = localFingerprint;
        local_wrapped_cek = Fixture.repeatBlob(168, 0x33);
    };
    let firstDispatch = switch (delivery.sendStart(request)) {
        case (#ok(#dispatch(value))) value;
        case (_) { assert false; loop {} };
    };
    // The one-use permit, command ledger and sending Outbox record all exist
    // before a transport result is supplied.
    assert (mem.outbox_count == 1 and Map.size(mem.permits) == 0);
    assert (Map.size(mem.commands) == 1 and firstDispatch.call.method == MAIL_INGRESS_METHOD);
    assert (firstDispatch.call.cycles == Delivery.RECEIVE_REQUIRED_CYCLES);
    assert (Blob.equal(firstDispatch.call.args, ingressArgs("receive", to_candid (request.envelope))));
    switch (delivery.sendStart({
        request with command_id = Fixture.repeatBlob(16, 0x8f)
    })) {
        case (#err(#permit_missing)) {};
        case (_) assert false;
    };
    let first = switch (delivery.finishDelivery(
        firstDispatch,
        receiveReply(#accepted({ received_at_ns = 2_000 : Int64 })),
    )) {
        case (#err(_)) { assert false; loop {} };
        case (#ok(value)) value;
    };
    switch (first.state) {
        case (#accepted({ received_at_ns })) assert (received_at_ns == 2_000);
        case (_) assert false;
    };
    assert (mem.outbox_bytes == request.envelope.size() + 1_024);

    // Identical command replay returns the existing status before the now
    // consumed permit is consulted and does not redispatch.
    let replay = delivery.sendStart(request);
    switch (replay) {
        case (#ok(#complete(value))) assert (value.local_id == first.local_id);
        case (#err(_)) assert false;
        case (_) assert false;
    };
    switch (delivery.sendStart({ request with envelope = withFingerprint(Fixture.envelope(1_040, 8, 7, 0x22), recipientFingerprint) })) {
        case (#err(#command_conflict)) {};
        case (_) assert false;
    };

    // A permit left more than one TTL ahead by a clock rollback is revoked on
    // use. Only the ephemeral permit changes: the existing encrypted Outbox
    // record (and therefore any browser plaintext draft) remains untouched and
    // can be prepared again against the recipient's current key.
    let futurePermitId = Fixture.repeatBlob(32, 0x8c);
    let futurePermit : Memory.RecipientPermit = {
        permit_id = futurePermitId;
        target = recipient;
        contact_id = prepared.contact_id;
        contact_revision = prepared.contact_revision;
        book_revision = prepared.book_revision;
        suite = 1;
        delivery_key_epoch = 7;
        delivery_key_fingerprint = recipientFingerprint;
        public_info_hash = prepared.public_info_hash;
        cleanup_epoch = mem.cleanup_epoch;
        expires_at_ns = currentTime + 300_000_000_001;
    };
    Map.add(mem.permits, Text.compare, hex(futurePermitId), futurePermit);
    let rollbackRevision = mem.revision;
    let rollbackNextLocalId = mem.next_local_id;
    let rollbackOutboxCount = mem.outbox_count;
    let rollbackOutboxBytes = mem.outbox_bytes;
    switch (delivery.sendStart({
        request with
        command_id = Fixture.repeatBlob(16, 0x8d);
        permit_id = futurePermitId;
    })) {
        case (#err(#permit_missing)) {};
        case (_) assert false;
    };
    assert (Map.size(mem.permits) == 0);
    assert (
        mem.revision == rollbackRevision and
        mem.next_local_id == rollbackNextLocalId and
        mem.outbox_count == rollbackOutboxCount and
        mem.outbox_bytes == rollbackOutboxBytes and
        mem.outbox_order.size() == 1 and
        mem.outbox_order[0] == first.local_id
    );
    switch (Map.get(mem.outbox, Nat.compare, first.local_id)) {
        case (?record) {
            assert (
                record.attempt_no == first.attempt_no and
                record.updated_at_ns == first.updated_at_ns
            );
            switch (record.state) {
                case (#accepted({ received_at_ns })) assert (received_at_ns == 2_000);
                case (_) assert false;
            };
        };
        case null assert false;
    };

    // A second command receives an uncertain transport result, then exact
    // stored-envelope retry maps duplicate to accepted and dedupes its id.
    let permitId2 = Fixture.repeatBlob(16, 0x83);
    let prepareDispatch2 = switch (delivery.prepareStart({
        recipient = #direct({ principal = recipient });
        permit_request_id = permitId2;
    })) {
        case (#ok(value)) value;
        case (#err(_)) { assert false; loop {} };
    };
    let prepared2 = switch (delivery.prepareFinish(
        prepareDispatch2,
        keyReply(#ok(keyInfo)),
    )) {
        case (#ok(value)) value;
        case (#err(#invalid_request)) { assert false; loop {} };
        case (#err(#permission_required)) { assert false; loop {} };
        case (#err(#recipient_unavailable)) { assert false; loop {} };
        case (#err(#recipient_changed)) { assert false; loop {} };
        case (#err(#permit_capacity)) { assert false; loop {} };
        case (#err(#permit_request_reused)) { assert false; loop {} };
        case (#err(#clock_invalid)) { assert false; loop {} };
        case (#err(#corrupt_state)) { assert false; loop {} };
        case (#err(_)) { assert false; loop {} };
    };
    let request2 : Delivery.SendEncryptedRequest = {
        command_id = Fixture.repeatBlob(16, 0x84);
        permit_id = prepared2.permit_id;
        recipient;
        public_info_hash = prepared2.public_info_hash;
        envelope = withFingerprint(Fixture.envelope(4_112, 9, 7, 0x22), recipientFingerprint);
        local_wrap_epoch = 9;
        local_wrap_fingerprint = localFingerprint;
        local_wrapped_cek = Fixture.repeatBlob(168, 0x34);
    };
    let secondDispatch = switch (delivery.sendStart(request2)) {
        case (#ok(#dispatch(value))) value;
        case (_) { assert false; loop {} };
    };
    let uncertain = switch (delivery.finishDelivery(
        secondDispatch,
        #err({ code = "hidden"; message = "never expose" }),
    )) {
        case (#ok(value)) value;
        case (#err(_)) { assert false; loop {} };
    };
    switch (uncertain.state) {
        case (#delivery_uncertain) {};
        case (_) assert false;
    };
    let retryRequest : Delivery.RetryRequest = {
        local_id = uncertain.local_id;
        retry_request_id = Fixture.repeatBlob(16, 0x85);
    };
    let uncertainRevision = mem.revision;
    let uncertainTombstones = mem.retry_tombstones.size();
    currentTime -= 1;
    switch (delivery.retryStart(retryRequest)) {
        case (#err(#clock_invalid)) {};
        case (_) assert false;
    };
    assert (
        mem.revision == uncertainRevision and
        mem.retry_tombstones.size() == uncertainTombstones
    );
    switch (Map.get(mem.outbox, Nat.compare, uncertain.local_id)) {
        case (?record) {
            assert (record.attempt_no == 1 and record.attempt_request_id == null);
            switch (record.state) {
                case (#delivery_uncertain) {};
                case (_) assert false;
            };
        };
        case null assert false;
    };
    currentTime += 2;
    let retryDispatch = switch (delivery.retryStart(retryRequest)) {
        case (#ok(#dispatch(value))) value;
        case (_) { assert false; loop {} };
    };
    assert (retryDispatch.call.cycles == Delivery.RECEIVE_REQUIRED_CYCLES);
    assert (retryDispatch.call.args == secondDispatch.call.args);
    let coalescedRequest : Delivery.RetryRequest = {
        local_id = uncertain.local_id;
        retry_request_id = Fixture.repeatBlob(16, 0x86);
    };
    switch (delivery.retryStart(coalescedRequest)) {
        case (#ok(#complete(value))) assert (value.attempt_no == 2);
        case (_) assert false;
    };
    let retried = switch (delivery.finishDelivery(
        retryDispatch,
        receiveReply(#duplicate({ received_at_ns = 2_001 : Int64 })),
    )) {
        case (#ok(value)) value;
        case (#err(_)) { assert false; loop {} };
    };
    assert (retried.attempt_no == 2);
    switch (retried.state) {
        case (#accepted({ received_at_ns })) assert (received_at_ns == 2_001);
        case (_) assert false;
    };
    switch (delivery.retryStart(retryRequest)) {
        case (#ok(#complete(value))) assert (value.attempt_no == 2);
        case (_) assert false;
    };
    // The different id supplied while sending is permanently coalesced to the
    // same attempt and cannot become a later dispatch.
    switch (delivery.retryStart(coalescedRequest)) {
        case (#ok(#complete(value))) assert (value.attempt_no == 2);
        case (_) assert false;
    };

    let permitId3 = Fixture.repeatBlob(16, 0x88);
    let prepareDispatch3 = switch (delivery.prepareStart({
        recipient = #direct({ principal = recipient });
        permit_request_id = permitId3;
    })) {
        case (#ok(value)) value;
        case (_) { assert false; loop {} };
    };
    let prepared3 = switch (delivery.prepareFinish(
        prepareDispatch3,
        keyReply(#ok(keyInfo)),
    )) {
        case (#ok(value)) value;
        case (_) { assert false; loop {} };
    };
    let request3 : Delivery.SendEncryptedRequest = {
        command_id = Fixture.repeatBlob(16, 0x89);
        permit_id = prepared3.permit_id;
        recipient;
        public_info_hash = prepared3.public_info_hash;
        envelope = withFingerprint(Fixture.envelope(1_040, 10, 7, 0x22), recipientFingerprint);
        local_wrap_epoch = 9;
        local_wrap_fingerprint = localFingerprint;
        local_wrapped_cek = Fixture.repeatBlob(168, 0x35);
    };
    let thirdDispatch = switch (delivery.sendStart(request3)) {
        case (#ok(#dispatch(value))) value;
        case (_) { assert false; loop {} };
    };
    let third = switch (delivery.finishDelivery(
        thirdDispatch,
        #err({ code = "hidden"; message = "hidden" }),
    )) {
        case (#ok(value)) value;
        case (_) { assert false; loop {} };
    };
    let cleanupRetry : Delivery.RetryRequest = {
        local_id = third.local_id;
        retry_request_id = Fixture.repeatBlob(16, 0x8a);
    };
    let cleanupDispatch = switch (delivery.retryStart(cleanupRetry)) {
        case (#ok(#dispatch(value))) value;
        case (_) { assert false; loop {} };
    };

    // Keep one unused preparation permit live: Delete All must revoke it even
    // though it is not itself a mailbox row.
    let unusedPrepare = switch (delivery.prepareStart({
        recipient = #direct({ principal = recipient });
        permit_request_id = Fixture.repeatBlob(16, 0x8b);
    })) {
        case (#ok(value)) value;
        case (_) { assert false; loop {} };
    };
    ignore delivery.prepareFinish(
        unusedPrepare,
        keyReply(#ok(keyInfo)),
    );
    assert (Map.size(mem.permits) == 1);
    let store = Store.Service(
        mem,
        func() { currentTime },
        func() { 0 },
        func(_target : Principal) { #none },
    );
    let preview = switch (store.cleanupPreview(#all_mail)) {
        case (#ok(value)) value;
        case (_) { assert false; loop {} };
    };
    switch (store.cleanupCommit(preview)) {
        case (#ok(result)) assert (result.cleanup_epoch == 1);
        case (_) assert false;
    };
    assert (Map.size(mem.permits) == 0 and Map.size(mem.outbox) == 0);
    switch (delivery.sendStart(request3)) {
        case (#err(#command_deleted({ local_id }))) assert (local_id == third.local_id);
        case (_) assert false;
    };
    switch (delivery.finishDelivery(
        cleanupDispatch,
        receiveReply(#accepted({ received_at_ns = 2_002 : Int64 })),
    )) {
        case (#err(#attempt_superseded)) {};
        case (_) assert false;
    };
    switch (delivery.retryStart(cleanupRetry)) {
        case (#err(#retry_deleted)) {};
        case (_) assert false;
    };

    reservation := false;
    switch (delivery.prepareStart({
        recipient = #direct({ principal = recipient });
        permit_request_id = Fixture.repeatBlob(16, 0x87);
    })) {
        case (#err(#permission_required)) {};
        case (_) assert false;
    };
};

preparationEdges();
remoteClassificationEdges();
staleSendingRecoveryEdges();
assert (Delivery.KEY_INFO_REQUIRED_CYCLES == 50_000_000);
assert (Delivery.RECEIVE_REQUIRED_CYCLES == 250_000_000);
assert (not Delivery.fitsOutboxQuota(1_000, 0, Fixture.envelope(1_040, 1, 7, 0x22)));
assert (not Delivery.fitsOutboxQuota(0, 12_582_912, Fixture.envelope(1_040, 1, 7, 0x22)));
assert (Delivery.fitsOutboxQuota(999, 0, Fixture.envelope(1_040, 1, 7, 0x22)));
test();
