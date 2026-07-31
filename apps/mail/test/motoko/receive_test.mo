import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Int64 "mo:core/Int64";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Memory "../../backend/memory/mail/v1";
import Receive "../../backend/mailbox/Receive";
import KeyInfo "../../backend/protocol/KeyInfo";
import Fixture "Fixture";

let START_NS : Int = 7_000_000_000_000;
let HOUR_NS : Int = 3_600_000_000_000;
let THIRTY_DAYS_NS : Int = 2_592_000_000_000_000;
let FINGERPRINT_BYTE : Nat8 = 0x22;
let CURRENT_EPOCH : Nat64 = 7;
let PUBLIC_KEY = Fixture.repeatBlob(96, 0x31);
let IBE_IDENTITY = Fixture.repeatBlob(32, 0x32);
let CURRENT_FINGERPRINT = KeyInfo.fingerprint(
    1,
    CURRENT_EPOCH,
    PUBLIC_KEY,
    IBE_IDENTITY,
);
let RECORD_OVERHEAD_BYTES = 512;
let INBOX_COUNT_LIMIT = 2_000;
let INBOX_BYTE_LIMIT = 20 * 1_024 * 1_024;
let UNKNOWN_COUNT_LIMIT = 100;
let UNKNOWN_BYTE_LIMIT = 2 * 1_024 * 1_024;

func canister(index : Nat) : Principal {
    let bytes : [Nat8] = [
        Nat8.fromNat((index / 65_536) % 256),
        Nat8.fromNat((index / 256) % 256),
        Nat8.fromNat(index % 256),
        1,
    ];
    Principal.fromBlob(Blob.fromArray(bytes));
};

let SELF = canister(900);
let FIRST = canister(1);
let SECOND = canister(2);
let NON_CANISTER = Principal.fromText(
    "6rgy7-3uukz-jrj2k-crt3v-u2wjm-dmn3t-p26d6-ndilt-3gusv-75ybk-jae"
);
assert (Principal.isCanister(SELF));
assert (Principal.isCanister(FIRST));
assert (Principal.isCanister(SECOND));
assert (not Principal.isCanister(NON_CANISTER));

func publicKeyInfo(epoch : Nat64, fingerprint : Blob) : Memory.PublicKeyInfo {
    {
        protocol_version = 1;
        suite = 1;
        key_holder = Principal.fromText("pcofx-mj5y3-27jya-3jcsk-jzcy2-2y6yj-bvf32-ousik-tb3ks-uyjkz-rqe");
        current_epoch = epoch;
        current_fingerprint = fingerprint;
        context_public_key = PUBLIC_KEY;
        effective_ibe_identity = IBE_IDENTITY;
        max_envelope_bytes = Nat32.fromNat(39_199);
        previous_epoch = null;
        previous_fingerprint = null;
    };
};

class Harness() {
    public let mem = Memory.init();
    var clock : Int = START_NS;
    var firstKnown : Bool = false;
    var secondKnown : Bool = false;
    var everyoneKnown : Bool = false;

    public let service = Receive.Service(
        mem,
        SELF,
        func(sender) {
            everyoneKnown or
            (firstKnown and Principal.equal(sender, FIRST)) or
            (secondKnown and Principal.equal(sender, SECOND));
        },
        func() { clock },
    );

    public func configure() {
        mem.key_info := ?publicKeyInfo(
            CURRENT_EPOCH,
            CURRENT_FINGERPRINT,
        );
    };

    public func setTime(value : Int) { clock := value };
    public func knowFirst(value : Bool) { firstKnown := value };
    public func knowSecond(value : Bool) { secondKnown := value };
    public func knowEveryone(value : Bool) { everyoneKnown := value };
};

func stageDeletedInbox(
    h : Harness,
    localId : Nat,
    deletedAt : Int,
) {
    let ?record = Map.get(h.mem.inbox, Nat.compare, localId) else return;
    Map.remove(h.mem.inbox, Nat.compare, localId);
    Map.remove(h.mem.unread, Nat.compare, localId);
    h.mem.inbox_order := Array.filter<Nat>(
        h.mem.inbox_order,
        func(id) { id != localId },
    );
    h.mem.inbox_count -= 1;
    h.mem.inbox_bytes -= record.retained_bytes;
    h.mem.unread_count -= 1;
    if (not record.known_at_receipt) {
        h.mem.unknown_inbox_count -= 1;
        h.mem.unknown_inbox_bytes -= record.retained_bytes;
    };
    let tombstone : Memory.InboxTombstone = {
        sender = record.sender;
        message_id = record.message_id;
        received_at_ns = record.received_at_ns;
        deleted_at_ns = deletedAt;
    };
    let previousTombstones = h.mem.inbox_tombstones;
    h.mem.inbox_tombstones := Array.tabulate<Memory.InboxTombstone>(
        previousTombstones.size() + 1,
        func(index) {
            if (index < previousTombstones.size()) previousTombstones[index] else tombstone;
        },
    );
    var indexed = false;
    for ((key, mapped) in Map.entries(h.mem.dedupe)) {
        if (mapped == localId) {
            Map.add(h.mem.inbox_tombstone_index, Text.compare, key, tombstone);
            indexed := true;
        };
    };
    assert indexed;
};

func payload(messageNumber : Nat) : Blob {
    Fixture.envelopeWithFingerprint(
        1_040,
        messageNumber,
        Nat64.toNat(CURRENT_EPOCH),
        CURRENT_FINGERPRINT,
    );
};

func expectAccepted(result : Receive.ReceiveResultV1, expectedAt : Int) {
    switch (result) {
        case (#accepted(value)) {
            assert (value.received_at_ns == Int64.fromInt(expectedAt));
        };
        case (_) assert false;
    };
};

func expectDuplicate(result : Receive.ReceiveResultV1, expectedAt : Int) {
    switch (result) {
        case (#duplicate(value)) {
            assert (value.received_at_ns == Int64.fromInt(expectedAt));
        };
        case (_) assert false;
    };
};

func expectInvalid(result : Receive.ReceiveResultV1) {
    switch (result) {
        case (#rejected(#invalid)) {};
        case (_) assert false;
    };
};

func expectCryptoUnavailable(result : Receive.ReceiveResultV1) {
    switch (result) {
        case (#rejected(#crypto_unavailable)) {};
        case (_) assert false;
    };
};

func expectFull(result : Receive.ReceiveResultV1) {
    switch (result) {
        case (#rejected(#mailbox_full)) {};
        case (_) assert false;
    };
};

func expectRate(result : Receive.ReceiveResultV1, expectedSeconds : Nat) {
    switch (result) {
        case (#rejected(#rate_limited(value))) {
            assert (Nat32.toNat(value.retry_after_seconds) == expectedSeconds);
        };
        case (_) assert false;
    };
};

func fillAccepted(
    h : Harness,
    total : Nat,
    bodySize : Nat,
    known : Bool,
    senderOffset : Nat,
) : Int {
    h.knowEveryone(known);
    let classLimit = if (known) 300 else 10;
    var acceptedAt = START_NS;
    var index = 0;
    while (index < total) {
        if (index > 0 and index % classLimit == 0) {
            acceptedAt += HOUR_NS;
            h.setTime(acceptedAt);
        };
        expectAccepted(
            h.service.receive(
                Fixture.envelopeWithFingerprint(
                    bodySize,
                    1,
                    Nat64.toNat(CURRENT_EPOCH),
                    CURRENT_FINGERPRINT,
                ),
                canister(senderOffset + index),
            ),
            acceptedAt,
        );
        index += 1;
    };
    acceptedAt;
};

func expectStale(result : Receive.ReceiveResultV1) {
    switch (result) {
        case (#rejected(#stale_key(value))) {
            assert (value.current_epoch == CURRENT_EPOCH);
            assert (
                value.current_fingerprint == CURRENT_FINGERPRINT
            );
        };
        case (_) assert false;
    };
};

// The paid kernel route proves canister mediation. This service retains only
// self-mail rejection and then applies key, payload, and mailbox validation.
do {
    let h = Harness();
    expectCryptoUnavailable(h.service.receive(payload(1), FIRST));
    expectCryptoUnavailable(h.service.receive(payload(1), NON_CANISTER));
    h.configure();
    expectInvalid(h.service.receive(payload(1), SELF));
    expectInvalid(h.service.receive(Fixture.replace(payload(1), 0, 2), FIRST));
    expectInvalid(
        h.service.receive(
            Fixture.envelope(1_040, 1, 0, FINGERPRINT_BYTE),
            FIRST,
        )
    );
    expectStale(
        h.service.receive(
            Fixture.envelope(1_040, 1, 6, FINGERPRINT_BYTE),
            FIRST,
        )
    );
    expectStale(
        h.service.receive(
            Fixture.envelope(1_040, 1, 7, 0x23),
            FIRST,
        )
    );

    expectAccepted(h.service.receive(payload(1), FIRST), START_NS);
    assert (h.mem.next_local_id == 2 and h.mem.revision == 1);
    assert (h.mem.inbox_count == 1 and h.mem.unread_count == 1);
    assert (Map.get(h.mem.unread, Nat.compare, 1) == ?());
    assert (h.mem.unknown_inbox_count == 1);
    assert (h.mem.inbox_order == [1]);
    switch (Map.get(h.mem.inbox, Nat.compare, 1)) {
        case null assert false;
        case (?record) {
            assert (record.sender == FIRST);
            assert (record.message_id == Fixture.messageId(1));
            assert (record.delivery_key_epoch == CURRENT_EPOCH);
            assert (record.local_wrap_epoch == CURRENT_EPOCH);
            assert (record.local_wrapped_cek == Fixture.repeatBlob(168, 0x55));
            assert (record.received_at_ns == START_NS and not record.read);
            assert (not record.known_at_receipt);
            assert (record.retained_bytes == payload(1).size() + RECORD_OVERHEAD_BYTES);
        };
    };

    expectDuplicate(h.service.receive(payload(1), FIRST), START_NS);
    expectDuplicate(
        h.service.receive(Fixture.replace(payload(1), 239, 0x67), FIRST),
        START_NS,
    );
    assert (h.mem.revision == 1 and h.mem.inbox_count == 1);
    assert (Map.size(h.mem.unread) == 1 and h.mem.unread_count == 1);
    assert (h.mem.unknown_rate_events.size() == 1);

    // The same 16-byte message id is independent for a different sender.
    expectAccepted(h.service.receive(payload(1), SECOND), START_NS);
    assert (h.mem.revision == 2 and h.mem.inbox_count == 2);
    assert (Map.size(h.mem.unread) == 2 and h.mem.unread_count == 2);
};

// Invalid cached key state fails closed instead of emitting malformed stale data.
do {
    let h = Harness();
    h.mem.key_info := ?publicKeyInfo(CURRENT_EPOCH, Fixture.repeatBlob(31, 0x22));
    expectCryptoUnavailable(h.service.receive(payload(1), FIRST));
    assert (h.mem.revision == 0 and h.mem.inbox_count == 0);
};

do {
    let h = Harness();
    h.mem.key_info := ?publicKeyInfo(CURRENT_EPOCH, Fixture.repeatBlob(32, 0x22));
    expectCryptoUnavailable(h.service.receive(payload(1), FIRST));
    assert (h.mem.revision == 0 and h.mem.inbox_count == 0);
};

// Tombstones dedupe without recreating storage or consuming admission.
do {
    let h = Harness();
    h.configure();
    h.setTime(START_NS - 10);
    expectAccepted(h.service.receive(payload(1), FIRST), START_NS - 10);
    stageDeletedInbox(h, 1, START_NS - 5);
    h.setTime(START_NS);
    expectDuplicate(h.service.receive(payload(1), FIRST), START_NS - 10);
    assert (h.mem.inbox_count == 0 and h.mem.unread_count == 0);
    assert (Map.size(h.mem.unread) == 0);
    assert (h.mem.unknown_rate_events.size() == 1);
};

// A dangling live dedupe index is corruption, never a false duplicate.
do {
    let h = Harness();
    h.configure();
    expectAccepted(h.service.receive(payload(1), FIRST), START_NS);
    Map.remove(h.mem.inbox, Nat.compare, 1);
    expectInvalid(h.service.receive(payload(1), FIRST));
};

// Tombstones protect delivery for 30 days, then the same id is accepted again.
// The orphan dedupe key is replaced, so expiry does not leak index capacity.
do {
    let h = Harness();
    h.configure();
    expectAccepted(h.service.receive(payload(1), FIRST), START_NS);
    let deletedAt = START_NS + 1;
    stageDeletedInbox(h, 1, deletedAt);
    let expiresAt = deletedAt + THIRTY_DAYS_NS;

    h.setTime(expiresAt - 1);
    expectDuplicate(h.service.receive(payload(1), FIRST), START_NS);
    assert (h.mem.inbox_tombstones.size() == 1 and Map.size(h.mem.dedupe) == 1);

    h.setTime(expiresAt);
    expectAccepted(h.service.receive(payload(1), FIRST), expiresAt);
    assert (h.mem.inbox_tombstones.size() == 0);
    assert (Map.size(h.mem.dedupe) == 1 and Map.size(h.mem.inbox) == 1);
    assert (h.mem.inbox_order == [2] and h.mem.next_local_id == 3);
};

// A tombstone that overlaps a live dedupe identity is corrupt and fails closed.
do {
    let h = Harness();
    h.configure();
    expectAccepted(h.service.receive(payload(1), FIRST), START_NS);
    h.mem.inbox_tombstones := [{
        sender = FIRST;
        message_id = Fixture.messageId(1);
        received_at_ns = START_NS;
        deleted_at_ns = START_NS;
    }];
    h.setTime(START_NS + THIRTY_DAYS_NS);
    expectInvalid(h.service.receive(payload(2), FIRST));
    assert (h.mem.inbox_tombstones.size() == 1);
    assert (Map.size(h.mem.dedupe) == 1 and Map.size(h.mem.inbox) == 1);
};

// Corrupt-counter, rate, and invalid rejections cannot commit a useful expiry plan.
do {
    let h = Harness();
    h.configure();
    expectAccepted(h.service.receive(payload(1), FIRST), START_NS);
    let deletedAt = START_NS + 1;
    stageDeletedInbox(h, 1, deletedAt);
    h.setTime(deletedAt + THIRTY_DAYS_NS);
    h.mem.inbox_count := INBOX_COUNT_LIMIT;

    expectInvalid(h.service.receive(payload(2), FIRST));
    assert (h.mem.inbox_tombstones.size() == 1 and Map.size(h.mem.dedupe) == 1);
    h.mem.inbox_count := 0;
    expectAccepted(
        h.service.receive(payload(2), FIRST),
        deletedAt + THIRTY_DAYS_NS,
    );
    assert (h.mem.inbox_tombstones.size() == 0 and Map.size(h.mem.dedupe) == 1);
};

do {
    let h = Harness();
    h.configure();
    expectAccepted(h.service.receive(payload(1), FIRST), START_NS);
    let deletedAt = START_NS + 1;
    let current = deletedAt + THIRTY_DAYS_NS;
    stageDeletedInbox(h, 1, deletedAt);
    h.setTime(current);
    h.mem.unknown_rate_events := Array.tabulate<Memory.RateEvent>(
        10,
        func(_) { { sender = SECOND; accepted_at_ns = current } },
    );

    expectRate(h.service.receive(payload(2), FIRST), 3_600);
    assert (h.mem.inbox_tombstones.size() == 1 and Map.size(h.mem.dedupe) == 1);
    h.mem.unknown_rate_events := [];
    expectAccepted(h.service.receive(payload(2), FIRST), current);
    assert (h.mem.inbox_tombstones.size() == 0 and Map.size(h.mem.dedupe) == 1);
};

do {
    let h = Harness();
    h.configure();
    expectAccepted(h.service.receive(payload(1), FIRST), START_NS);
    let deletedAt = START_NS + 1;
    stageDeletedInbox(h, 1, deletedAt);
    h.setTime(deletedAt + THIRTY_DAYS_NS);

    expectInvalid(h.service.receive(Fixture.replace(payload(2), 0, 2), FIRST));
    assert (h.mem.inbox_tombstones.size() == 1 and Map.size(h.mem.dedupe) == 1);
};

// Unknown senders share one exact rolling-hour pool of ten events.
do {
    let h = Harness();
    h.configure();
    var index = 1;
    while (index <= 9) {
        expectAccepted(h.service.receive(payload(index), FIRST), START_NS);
        index += 1;
    };
    expectAccepted(h.service.receive(payload(10), SECOND), START_NS);
    assert (h.mem.unknown_rate_events.size() == 10);
    expectRate(h.service.receive(payload(11), SECOND), 3_600);
    assert (h.mem.revision == 10 and h.mem.unknown_rate_events.size() == 10);

    h.setTime(START_NS + HOUR_NS - 1);
    expectRate(h.service.receive(payload(11), SECOND), 300);
    h.setTime(START_NS + HOUR_NS);
    expectAccepted(h.service.receive(payload(11), SECOND), START_NS + HOUR_NS);
    assert (h.mem.unknown_rate_events.size() == 1);
};

// Once the public pool is full, rejection is bounded by the small rate queues
// and does not scan retained mailbox state before returning.
do {
    let h = Harness();
    h.configure();
    ignore fillAccepted(h, 10, 1_040, false, 50_000);
    let revision = h.mem.revision;
    h.mem.inbox_count := 0; // deep state is intentionally inconsistent
    expectRate(h.service.receive(payload(11), canister(50_100)), 3_600);
    assert (h.mem.revision == revision and h.mem.inbox_count == 0);
};

// A Contacts change cannot reset the ten-per-sender window across both pools.
do {
    let h = Harness();
    h.configure();
    var index = 1;
    while (index <= 5) {
        expectAccepted(h.service.receive(payload(index), FIRST), START_NS);
        index += 1;
    };
    h.knowFirst(true);
    while (index <= 10) {
        expectAccepted(h.service.receive(payload(index), FIRST), START_NS);
        index += 1;
    };
    expectRate(h.service.receive(payload(11), FIRST), 3_600);
    h.knowSecond(true);
    expectAccepted(h.service.receive(payload(11), SECOND), START_NS);
    assert (h.mem.unknown_rate_events.size() == 5);
    assert (h.mem.known_rate_events.size() == 6);
};

// Thirty independent known senders fill the separate 300-event class pool.
do {
    let h = Harness();
    h.configure();
    h.knowEveryone(true);
    var senderNumber = 100;
    while (senderNumber < 130) {
        let sender = canister(senderNumber);
        var messageNumber = 1;
        while (messageNumber <= 10) {
            expectAccepted(
                h.service.receive(payload(messageNumber), sender),
                START_NS,
            );
            messageNumber += 1;
        };
        senderNumber += 1;
    };
    assert (h.mem.known_rate_events.size() == 300);
    expectRate(h.service.receive(payload(1), canister(130)), 3_600);
    assert (h.mem.revision == 300 and h.mem.inbox_count == 300);
};

// Count limits accept the exact boundary, then reject with no partial commit.
do {
    let h = Harness();
    h.configure();
    let acceptedAt = fillAccepted(h, INBOX_COUNT_LIMIT - 1, 1_040, true, 10_000);
    expectAccepted(
        h.service.receive(payload(1), canister(12_100)),
        acceptedAt,
    );
    assert (h.mem.inbox_count == INBOX_COUNT_LIMIT);
    let revision = h.mem.revision;
    let bytes = h.mem.inbox_bytes;
    expectFull(h.service.receive(payload(2), canister(12_101)));
    assert (h.mem.revision == revision and h.mem.inbox_count == INBOX_COUNT_LIMIT);
    assert (h.mem.inbox_bytes == bytes);
    assert (Map.size(h.mem.unread) == INBOX_COUNT_LIMIT);
    assert (h.mem.unread_count == INBOX_COUNT_LIMIT);
};

// Public admission recomputes live usage and fails closed if a persisted
// counter was lowered, so corruption cannot be used to admit past quotas.
do {
    let h = Harness();
    h.configure();
    expectAccepted(h.service.receive(payload(1), FIRST), START_NS);
    let revision = h.mem.revision;
    h.mem.inbox_bytes := 0;
    expectInvalid(h.service.receive(payload(2), FIRST));
    assert (h.mem.revision == revision and Map.size(h.mem.inbox) == 1);
};

// Total and unknown retained-byte limits use ciphertext plus fixed overhead.
do {
    let h = Harness();
    h.configure();
    let acceptedAt = fillAccepted(h, 528, 36_880, true, 20_000);
    expectAccepted(
        h.service.receive(payload(1), canister(20_600)),
        acceptedAt,
    );
    assert (INBOX_BYTE_LIMIT - h.mem.inbox_bytes == 241);
    let revision = h.mem.revision;
    expectFull(h.service.receive(payload(2), canister(20_601)));
    assert (INBOX_BYTE_LIMIT - h.mem.inbox_bytes == 241);
    assert (h.mem.revision == revision);
};

do {
    let h = Harness();
    h.configure();
    let acceptedAt = fillAccepted(h, 52, 36_880, false, 30_000);
    h.setTime(acceptedAt);
    expectAccepted(
        h.service.receive(
            Fixture.envelopeWithFingerprint(16_400, 1, 7, CURRENT_FINGERPRINT),
            canister(30_100),
        ),
        acceptedAt,
    );
    expectAccepted(
        h.service.receive(
            Fixture.envelopeWithFingerprint(4_112, 1, 7, CURRENT_FINGERPRINT),
            canister(30_101),
        ),
        acceptedAt,
    );
    expectAccepted(h.service.receive(payload(1), canister(30_102)), acceptedAt);
    assert (UNKNOWN_BYTE_LIMIT - h.mem.unknown_inbox_bytes == 2_135);
    let revision = h.mem.revision;
    expectFull(h.service.receive(payload(2), canister(30_103)));
    assert (UNKNOWN_BYTE_LIMIT - h.mem.unknown_inbox_bytes == 2_135);
    assert (h.mem.revision == revision);
};

// Unknown count has its own exact retained subset boundary.
do {
    let h = Harness();
    h.configure();
    let acceptedAt = fillAccepted(h, UNKNOWN_COUNT_LIMIT, 1_040, false, 40_000);
    assert (h.mem.unknown_inbox_count == UNKNOWN_COUNT_LIMIT);
    h.setTime(acceptedAt + HOUR_NS);
    expectFull(h.service.receive(payload(2), canister(40_101)));
    assert (h.mem.unknown_inbox_count == UNKNOWN_COUNT_LIMIT);
    assert (h.mem.revision == UNKNOWN_COUNT_LIMIT);
};

// A quota rejection does not commit otherwise useful rate-window pruning.
do {
    let h = Harness();
    h.configure();
    h.knowEveryone(true);
    h.mem.inbox_count := 1;
    h.mem.known_rate_events := [{
        sender = FIRST;
        accepted_at_ns = START_NS - HOUR_NS - 1;
    }];
    expectInvalid(h.service.receive(payload(1), FIRST));
    assert (h.mem.revision == 0 and h.mem.known_rate_events.size() == 1);
    assert (h.mem.known_rate_events[0].accepted_at_ns == START_NS - HOUR_NS - 1);
};

// Invalid clock/rate state is closed and cannot trap Int64 conversion.
do {
    let h = Harness();
    h.configure();
    h.setTime(-1);
    expectInvalid(h.service.receive(payload(1), FIRST));
    assert (h.mem.revision == 0 and h.mem.inbox_count == 0);
};

// A stable-state clock rollback conservatively rebases every future rate event
// to the recovered clock. No sender or quota is lost, the repair persists even
// on a rate-limit rejection, and the lockout expires after one bounded window.
do {
    let h = Harness();
    h.configure();
    h.mem.known_rate_events := [
        { sender = FIRST; accepted_at_ns = START_NS + 8 * HOUR_NS },
        { sender = SECOND; accepted_at_ns = START_NS + 8 * HOUR_NS + 1 },
    ];
    h.mem.unknown_rate_events := Array.tabulate<Memory.RateEvent>(
        10,
        func(index) {
            {
                sender = canister(50_000 + index);
                accepted_at_ns = START_NS + 9 * HOUR_NS + index;
            };
        },
    );

    expectRate(h.service.receive(payload(1), FIRST), 3_600);
    assert (h.mem.revision == 0 and h.mem.inbox_count == 0);
    assert (h.mem.known_rate_events.size() == 2);
    assert (Principal.equal(h.mem.known_rate_events[0].sender, FIRST));
    assert (Principal.equal(h.mem.known_rate_events[1].sender, SECOND));
    for (event in h.mem.known_rate_events.vals()) {
        assert (event.accepted_at_ns == START_NS);
    };
    assert (h.mem.unknown_rate_events.size() == 10);
    var index = 0;
    for (event in h.mem.unknown_rate_events.vals()) {
        assert (Principal.equal(event.sender, canister(50_000 + index)));
        assert (event.accepted_at_ns == START_NS);
        index += 1;
    };

    h.setTime(START_NS + HOUR_NS - 1);
    expectRate(h.service.receive(payload(1), FIRST), 300);
    for (event in h.mem.unknown_rate_events.vals()) {
        assert (event.accepted_at_ns == START_NS);
    };

    h.setTime(START_NS + HOUR_NS);
    expectAccepted(h.service.receive(payload(1), FIRST), START_NS + HOUR_NS);
    assert (h.mem.known_rate_events.size() == 0);
    assert (h.mem.unknown_rate_events.size() == 1);
};

// The live receiver may reuse its locally proved Inbox projection, but any
// shared-service revision change forces a fresh deep validation before another
// admission. A same-shape corruption must therefore never be blessed by the
// cache merely because the cheap counters still agree.
do {
    let h = Harness();
    h.configure();
    h.knowEveryone(true);
    expectAccepted(h.service.receive(payload(1), FIRST), START_NS);
    switch (Map.get(h.mem.inbox, Nat.compare, 1)) {
        case null assert false;
        case (?record) Map.add(h.mem.inbox, Nat.compare, 1, {
            record with retained_bytes = record.retained_bytes + 1
        });
    };
    h.mem.revision += 1;
    expectInvalid(h.service.receive(payload(2), SECOND));
    assert (h.mem.inbox_count == 1 and h.mem.next_local_id == 2);
};

// Service reconstruction (including canister upgrade) starts with an empty
// process-local cache and validates retained stable state before admitting.
do {
    let h = Harness();
    h.configure();
    h.knowEveryone(true);
    expectAccepted(h.service.receive(payload(1), FIRST), START_NS);
    switch (Map.get(h.mem.inbox, Nat.compare, 1)) {
        case null assert false;
        case (?record) Map.add(h.mem.inbox, Nat.compare, 1, {
            record with retained_bytes = record.retained_bytes + 1
        });
    };
    let reconstructed = Receive.Service(
        h.mem,
        SELF,
        func(_sender) { true },
        func() { START_NS },
    );
    expectInvalid(reconstructed.receive(payload(2), SECOND));
    assert (h.mem.inbox_count == 1 and h.mem.next_local_id == 2);
};
