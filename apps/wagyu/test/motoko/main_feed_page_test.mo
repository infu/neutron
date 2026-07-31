import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat8 "mo:core/Nat8";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Text "mo:core/Text";

import Capabilities "mo:neutron-capabilities";

import Wagyu "../../backend/main";
import Memory "../../backend/memory/wagyu/v3";

func repeated(byte : Nat8, count : Nat) : Blob {
    Blob.fromArray(Array.tabulate<Nat8>(count, func(_) { byte }));
};

func canister(last : Nat8) : Principal {
    Principal.fromBlob(Blob.fromArray([0, last, 1]));
};

let node = canister(1);
let sender = canister(2);
let author = canister(3);
let visibleSender = canister(4);
let networkId = repeated(0x11, 32);
let mem = Memory.init();
mem.installation := #active({
    node;
    network_id = networkId;
    profile_generation = 1;
    activated_at_ns = 1;
});
mem.feed_revision := 7;
mem.feed_sequence := 5;
mem.candidate_count := 5;

func addCandidate(
    sequence : Nat64,
    unsupported : Bool,
    immediateSender : Principal,
) {
    let byte = Nat8.fromNat(Nat64.toNat(sequence % 251) + 1);
    let key = "candidate:" # Nat64.toText(sequence);
    let exact = repeated(byte, 3);
    let row : Memory.FeedCandidate = {
        candidate_key = key;
        candidate_id = repeated(byte, 32);
        local_sequence = sequence;
        received_at_ns = sequence;
        immediate_sender = immediateSender;
        route_receipt_key = "receipt:" # Nat64.toText(sequence);
        operation_id = repeated(byte, 16);
        payload_digest = repeated(byte, 32);
        subscription_id = repeated(byte, 32);
        event_kind = if (unsupported) null else ?#original;
        claimed_author = author;
        claimed_post_id = repeated(0x22, 32);
        claimed_body_hash =
            if (unsupported) null else ?repeated(0x23, 32);
        exact_event_candid = exact;
        verification = if (unsupported) null else ?#pending;
        read = false;
        retain_until_ns = (1_000 : Nat64);
        retained_bytes = exact.size() + 256;
    };
    Map.add(mem.feed_candidates, Text.compare, key, row);
    Map.add(mem.feed_order, Nat64.compare, sequence, key);
    mem.candidate_bytes += exact.size() + 256;
};

addCandidate(1, false, sender);
addCandidate(2, false, sender);
addCandidate(3, false, sender);
addCandidate(4, false, sender);
addCandidate(5, true, sender);

let backendCalls : Capabilities.BackendCallsV1 = {
    canister_principal = node;
    can_call = func(_canister : Principal, _method : Text) { false };
    call = func(
        _request : Capabilities.BackendCallRequestV1
    ) : async* Capabilities.BackendCallResultV1 {
        #err({ code = "disabled"; message = "disabled" });
    };
    call_batch = func(
        _requests : [Capabilities.BackendCallRequestV1]
    ) : async* [Capabilities.BackendCallResultV1] {
        [];
    };
};

let disabledAssets : Capabilities.CertifiedAssetsV2 = {
    scope_info = func() { #err(#disabled) };
    begin_stage = func(_) { #err(#disabled) };
    put_chunk = func(_) { #err(#disabled) };
    stage_status = func(_) { #err(#disabled) };
    abort_stage = func(_) { #err(#disabled) };
    commit_batch = func(_) { #err(#disabled) };
    record_status = func(_) { #err(#disabled) };
    maintenance_page = func() { #err(#disabled) };
    usage = func() { #err(#disabled) };
};

let deferredTimers : Capabilities.DeferredTimersV1 = {
    arm = func(
        _input : Capabilities.DeferredTimerArmInputV1
    ) : async* Capabilities.DeferredTimerArmResultV1 {
        #err(#source_gone);
    };
    status = func(_key : Text) {
        null;
    };
};

let wagyu = Wagyu.Init(
    {
        installation = { network_id = networkId };
        stable_memory = { wagyu = mem };
        capabilities = {
            backend_calls = backendCalls;
            deferred_timers = deferredTimers;
            certified_assets = disabledAssets;
        };
    },
);

let first = wagyu.wagyu_get_feed_page_v1({
    before_sequence = null;
    limit = 2;
});
assert (first.revision == 7);
assert (first.items.size() == 2);
assert (first.items[0].local_sequence == 5);
assert (first.items[0].event_kind == null);
assert (first.items[0].verification == null);
assert (first.items[1].local_sequence == 4);
assert (first.next_before_sequence == ?4);

let second = wagyu.wagyu_get_feed_page_v1({
    before_sequence = ?4;
    limit = 2;
});
assert (second.items.size() == 2);
assert (second.items[0].local_sequence == 3);
assert (second.items[1].local_sequence == 2);
assert (second.next_before_sequence == ?2);

let exactLast = wagyu.wagyu_get_feed_page_v1({
    before_sequence = ?3;
    limit = 2;
});
assert (exactLast.items.size() == 2);
assert (exactLast.items[0].local_sequence == 2);
assert (exactLast.items[1].local_sequence == 1);
assert (exactLast.next_before_sequence == null);

// A page advances from the last examined key even when 256 blocked rows
// produce no visible result. The next cursor reaches older visible content
// without rescanning the blocked prefix.
addCandidate(6, false, visibleSender);
var blockedFeedSequence : Nat64 = 7;
while (blockedFeedSequence <= 262) {
    addCandidate(blockedFeedSequence, false, sender);
    blockedFeedSequence += 1;
};
mem.feed_sequence := 262;
mem.candidate_count := 262;
Map.add(mem.blocks, Principal.compare, sender, {
    node = sender;
    storage_revision = (1 : Nat64);
    blocked_at_ns = (1 : Nat64);
});

let blockedFeedPage = wagyu.wagyu_get_feed_page_v1({
    before_sequence = null;
    limit = 2;
});
assert (blockedFeedPage.items.size() == 0);
assert (blockedFeedPage.next_before_sequence == ?7);

let visibleFeedPage = wagyu.wagyu_get_feed_page_v1({
    before_sequence = blockedFeedPage.next_before_sequence;
    limit = 2;
});
assert (visibleFeedPage.items.size() == 1);
assert (visibleFeedPage.items[0].local_sequence == 6);
assert (visibleFeedPage.next_before_sequence == null);

func addNotification(
    sequence : Nat64,
    actorNode : Principal,
) {
    Map.add(mem.notifications, Nat64.compare, sequence, {
        local_sequence = sequence;
        received_at_ns = sequence;
        actor_ = actorNode;
        kind = ?#new_follower({ follower_revision = sequence });
        verification = ?#transport_authenticated;
        read = false;
        semantic_key = "notification:" # Nat64.toText(sequence);
        retain_until_ns = (1_000 : Nat64);
        retained_bytes = 256;
    });
    Map.add(mem.notification_order, Nat64.compare, sequence, ());
};

addNotification(1, visibleSender);
var blockedNotificationSequence : Nat64 = 2;
while (blockedNotificationSequence <= 257) {
    addNotification(blockedNotificationSequence, sender);
    blockedNotificationSequence += 1;
};
mem.notification_sequence := 257;
mem.notification_count := 257;
mem.notification_revision := 9;

let blockedNotificationPage = wagyu.wagyu_get_notification_page_v1({
    before_sequence = null;
    limit = 2;
});
assert (blockedNotificationPage.items.size() == 0);
assert (blockedNotificationPage.next_before_sequence == ?2);

let visibleNotificationPage = wagyu.wagyu_get_notification_page_v1({
    before_sequence = blockedNotificationPage.next_before_sequence;
    limit = 2;
});
assert (visibleNotificationPage.items.size() == 1);
assert (visibleNotificationPage.items[0].local_sequence == 1);
assert (visibleNotificationPage.next_before_sequence == null);
