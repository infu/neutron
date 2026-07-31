import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";

import Caps "mo:neutron-capabilities";

import Planner "../../backend/actions/Planner";
import Publication "../../backend/actions/Publication";
import Closing "../../backend/closing/Service";
import ClosingTypes "../../backend/closing/Types";
import Admission "../../backend/likes/Admission";
import Hash "../../backend/protocol/Hash";
import Protocol "../../backend/protocol/Types";

func repeated(size : Nat, byte : Nat8) : Blob {
    Blob.fromArray(Array.repeat<Nat8>(byte, size));
};

func canister(index : Nat) : Principal {
    Principal.fromBlob(
        Blob.fromArray([
            Nat8.fromNat((index / 65_536) % 256),
            Nat8.fromNat((index / 256) % 256),
            Nat8.fromNat(index % 256),
            1,
        ])
    );
};

func record(
    target : Caps.Target,
    digest : Blob,
    bodyBytes : Nat,
    revision : Nat64,
) : Caps.RecordIdentity {
    {
        target;
        kernel_revision = revision;
        content_tag = digest;
        body_bytes = bodyBytes;
        geometry = {
            block_bytes = bodyBytes;
            block_count = 1;
            expected_bytes = bodyBytes;
        };
        block_hashes = [digest];
    };
};

func putReceipt(
    index : Nat,
    identity : Caps.RecordIdentity,
) : Caps.OperationReceipt {
    #put({
        request_index = Nat32.fromNat(index);
        lifecycle = {
            committed = identity;
        };
    });
};

let NETWORK = repeated(32, 0x11);
let POST_ID = repeated(32, 0x12);
let POST_HASH = repeated(32, 0x13);
let AUTHOR = canister(1);
let PROOF : Protocol.CertifiedHttpProofV1 = {
    certificate_version = 2;
    certificate_cbor = "\01";
    witness_cbor = "\02";
    expression_path_cbor = "\03";
    certificate_time_ns = 900;
};

let HEAD : Protocol.LikeHeadV1 = {
    network_id = NETWORK;
    post_author = AUTHOR;
    post_id = POST_ID;
    post_body_hash = POST_HASH;
    store_generation = 8;
    revision = 0;
    previous_head_hash = null;
    latest_batch_number = null;
    latest_batch_digest = null;
    sealed_batch_count = 0;
    sealed_receipt_count = 0;
    accepting_likes = true;
};
let HEAD_CANDID = to_candid (HEAD);
let HEAD_TARGET = Publication.likeHeadTarget(8, POST_ID);
let HEAD_IDENTITY = record(
    HEAD_TARGET,
    Hash.objectDigest(HEAD_CANDID),
    HEAD_CANDID.size(),
    1,
);
let HEAD_STATE = ClosingTypes.storedHead(
    HEAD,
    HEAD_CANDID,
    HEAD_IDENTITY,
);

// Withdrawal retention uses the per-post batch number plus a bounded receipt
// offset. A full 150-receipt batch takes three receipt pages; its batch row is
// included in the final page without a global accepted-Like scan.
let ?retentionPage1 = Closing.retentionPage(0, 1, 0, 150, 64)
else Runtime.trap("first withdrawal retention page was rejected");
assert (retentionPage1.first_receipt == 0);
assert (retentionPage1.past_receipt == 64);
assert (not retentionPage1.include_batch);
assert (
    retentionPage1.next ==
        ?{ batch_number = 0; receipt_offset = 64 }
);
let ?retentionPage2 = Closing.retentionPage(0, 1, 64, 150, 64)
else Runtime.trap("second withdrawal retention page was rejected");
assert (retentionPage2.past_receipt == 128);
assert (not retentionPage2.include_batch);
let ?retentionPage3 = Closing.retentionPage(0, 1, 128, 150, 64)
else Runtime.trap("final withdrawal retention page was rejected");
assert (retentionPage3.first_receipt == 128);
assert (retentionPage3.past_receipt == 150);
assert (retentionPage3.include_batch);
assert (retentionPage3.next == null);
assert (Closing.retentionPage(0, 1, 151, 150, 64) == null);

let #ok(TOMBSTONE) = Planner.prepareTombstone({
    network_id = NETWORK;
    author = AUTHOR;
    author_sequence = 2;
    issued_at_ns = 950;
    post_id = POST_ID;
    post_body_hash = POST_HASH;
    tombstones_generation = 7;
    publication_nonce = repeated(16, 0x21);
}) else Runtime.trap("tombstone preparation failed");

func acceptedLike(index : Nat) : Admission.AcceptedLike {
    let liker = canister(100 + index);
    let actionBytes = Blob.fromArray([
        Nat8.fromNat(index % 251),
        0x51,
    ]);
    let receipt : Protocol.CertifiedLikeReceiptV1 = {
        like_action_candid = actionBytes;
        ref = {
            actor_ = liker;
            action_kind = ?#like;
            object_digest = Hash.objectDigest(actionBytes);
            body_length = Nat32.fromNat(actionBytes.size());
            proof_snapshot = PROOF;
        };
    };
    let exact = to_candid (receipt);
    {
        accepted_sequence = Nat64.fromNat(index);
        accepted_at_ns = Nat64.fromNat(1_000 + index);
        liker;
        like_id = repeated(
            32,
            Nat8.fromNat(index % 251),
        );
        receipt;
        exact_receipt_candid = exact;
        receipt_digest = Hash.sha256(exact);
    };
};

// Start combines tombstone-proof finalization, a frozen follower cutoff, and
// the single Like-head CAS. No durable closing state exists until that exact
// kernel receipt has reconciled.
let due = Array.tabulate<Admission.AcceptedLike>(
    150,
    func(index) { acceptedLike(index + 1) },
);
let active = [acceptedLike(151), acceptedLike(152)];
let #ok(start) = Closing.planStart({
    tombstone_plan = TOMBSTONE;
    proof = PROOF;
    head = HEAD_STATE;
    segments = { due = ?due; active };
    follower_registration_cutoff = 77;
    started_at_ns = 2_000;
    publication_nonce = repeated(16, 0x22);
}) else Runtime.trap("closing start plan failed");
assert (start.phase == #stop_likes);
assert (start.follower_registration_cutoff == 77);
assert (start.commit.operations.size() == 1);
assert (start.commit.requires_present_after.size() == 0);
assert (not start.stop.next_head.accepting_likes);

let STOPPED_HEAD_IDENTITY = record(
    start.stop.head_target,
    start.stop.next_head_digest,
    start.stop.next_head_candid.size(),
    2,
);
let wrongStopIdentity = record(
    start.stop.head_target,
    repeated(32, 0xee),
    start.stop.next_head_candid.size(),
    2,
);
let #err(#sealing(#invalid_kernel_receipt)) =
    Closing.reconcileStart(
        start,
        {
            operations = [putReceipt(0, wrongStopIdentity)];
        },
    ) else Runtime.trap("wrong stop receipt advanced closing");

let startReceipt : Caps.BatchReceipt = {
    operations = [putReceipt(0, STOPPED_HEAD_IDENTITY)];
};
let #ok(started) = Closing.reconcileStart(
    start,
    startReceipt,
) else Runtime.trap("closing start reconciliation failed");
assert (started.closing.phase == #seal_due);
assert (not started.closing.head.value.accepting_likes);
assert (
    started.closing.follower_registration_cutoff == 77
);
let closingLiker = canister(1_000);
let #ok(closingLikePlan) = Planner.prepareLike({
    network_id = NETWORK;
    liker = closingLiker;
    issued_at_ns = 2_001;
    post_author = AUTHOR;
    post_id = POST_ID;
    post_body_hash = POST_HASH;
    likes_generation = 10;
    publication_nonce = repeated(16, 0x31);
}) else Runtime.trap("closing Like preparation failed");
let #ok(closingLike) = Planner.finalizeLike(
    closingLikePlan,
    PROOF,
) else Runtime.trap("closing Like finalization failed");
let #rejected(#closed) = Admission.admit({
    caller = closingLiker;
    network_id = NETWORK;
    post_author = AUTHOR;
    post_id = POST_ID;
    post_body_hash = POST_HASH;
    action = closingLikePlan.value;
    receipt = closingLike.receipt;
    exact_receipt_candid = closingLike.receipt_candid;
    accepted_at_ns = (2_001 : Nat64);
    next_accepted_sequence = (153 : Nat64);
    existing_receipt_digest = null;
    segments = started.closing.segments;
    accepting_likes =
        started.closing.head.value.accepting_likes;
    blocked = false;
}) else Runtime.trap("closing post admitted a new Like");

// One update publishes only the due 150-receipt batch and its CAS head.
// The full segment remains in the previous cursor until receipt validation.
let #ok(#publish(duePlan)) = Closing.planNext({
    closing = started.closing;
    like_batches_generation = 9;
    publication_nonce = repeated(16, 0x23);
    updated_at_ns = 2_100;
}) else Runtime.trap("due seal was not planned");
assert (duePlan.sealing.mode == #due);
assert (duePlan.sealing.batch.receipts.size() == 150);
assert (not duePlan.sealing.batch.final_partial);
assert (duePlan.commit.operations.size() == 2);
assert (duePlan.commit.requires_present_after.size() == 1);
assert (
    Publication.sameTarget(
        duePlan.commit.requires_present_after[0].target,
        duePlan.sealing.batch_target,
    )
);
assert (
    Blob.equal(
        duePlan.commit.requires_present_after[0].content_tag,
        duePlan.sealing.batch_digest,
    )
);
assert (
    duePlan.commit.requires_present_after[0].revision == ?1
);
assert (
    started.closing.segments.due != null
);

let DUE_BATCH_IDENTITY = record(
    duePlan.sealing.batch_target,
    duePlan.sealing.batch_digest,
    duePlan.sealing.batch_candid.size(),
    1,
);
let DUE_HEAD_IDENTITY = record(
    duePlan.sealing.head_target,
    duePlan.sealing.next_head_digest,
    duePlan.sealing.next_head_candid.size(),
    3,
);
let dueReceipt : Caps.BatchReceipt = {
    operations = [
        putReceipt(0, DUE_BATCH_IDENTITY),
        putReceipt(1, DUE_HEAD_IDENTITY),
    ];
};
let #ok(dueSealed) = Closing.reconcileSeal(
    duePlan,
    dueReceipt,
) else Runtime.trap("due receipt reconciliation failed");
assert (dueSealed.closing.phase == #seal_final_partial);
assert (dueSealed.closing.segments.due == null);
assert (dueSealed.closing.segments.active.size() == 2);
assert (
    dueSealed.closing.head.value.sealed_receipt_count == 150
);

// Replaying the retained plan and kernel receipt is deterministic. This is
// the upgrade/lost-response recovery boundary.
let #ok(dueReplay) = Closing.reconcileSeal(
    duePlan,
    dueReceipt,
) else Runtime.trap("due receipt replay failed");
assert (
    Blob.equal(
        dueReplay.closing.head.exact_body_candid,
        dueSealed.closing.head.exact_body_candid,
    )
);
assert (dueReplay.closing.phase == dueSealed.closing.phase);

// Only after the due segment has reconciled may the 1-149 final partial be
// published. It uses the same two-operation presence-dependent CAS shape.
let #ok(#publish(partialPlan)) = Closing.planNext({
    closing = dueSealed.closing;
    like_batches_generation = 9;
    publication_nonce = repeated(16, 0x24);
    updated_at_ns = 2_200;
}) else Runtime.trap("final partial was not planned");
assert (partialPlan.sealing.mode == #final_partial);
assert (partialPlan.sealing.batch.final_partial);
assert (partialPlan.sealing.batch.receipts.size() == 2);
assert (
    partialPlan.sealing.batch.previous_batch_digest ==
        ?duePlan.sealing.batch_digest
);
assert (partialPlan.commit.requires_present_after.size() == 1);
assert (
    Blob.equal(
        partialPlan.commit.requires_present_after[0].content_tag,
        partialPlan.sealing.batch_digest,
    )
);

let PARTIAL_BATCH_IDENTITY = record(
    partialPlan.sealing.batch_target,
    partialPlan.sealing.batch_digest,
    partialPlan.sealing.batch_candid.size(),
    1,
);
let PARTIAL_HEAD_IDENTITY = record(
    partialPlan.sealing.head_target,
    partialPlan.sealing.next_head_digest,
    partialPlan.sealing.next_head_candid.size(),
    4,
);
let #ok(partialSealed) = Closing.reconcileSeal(
    partialPlan,
    {
        operations = [
            putReceipt(0, PARTIAL_BATCH_IDENTITY),
            putReceipt(1, PARTIAL_HEAD_IDENTITY),
        ];
    },
) else Runtime.trap("partial receipt reconciliation failed");
assert (partialSealed.closing.phase == #ready_for_fanout);
assert (
    Admission.unsealedCount(
        partialSealed.closing.segments
    ) == 0
);
assert (
    partialSealed.closing.head.value.sealed_receipt_count ==
        152
);

// The last step is local-only. The returned values let main atomically
// suppress the authored row and enqueue the exact tombstone for followers at
// the frozen cutoff before any remote await.
let #ok(#finalize(finalize)) = Closing.planNext({
    closing = partialSealed.closing;
    like_batches_generation = 9;
    publication_nonce = repeated(16, 0x25);
    updated_at_ns = 2_300;
}) else Runtime.trap("local finalize was not planned");
assert (finalize.next.phase == #complete);
assert (finalize.fanout.follower_registration_cutoff == 77);
assert (
    Blob.equal(
        finalize.fanout.exact_event_candid,
        start.exact_tombstone_candid,
    )
);
assert (
    Blob.equal(
        finalize.suppression.post_id,
        POST_ID,
    )
);
assert (
    Blob.equal(
        finalize.suppression.tombstone_id,
        TOMBSTONE.tombstone_id,
    )
);

let #err(#already_complete) = Closing.planNext({
    closing = finalize.next;
    like_batches_generation = 9;
    publication_nonce = repeated(16, 0x26);
    updated_at_ns = 2_400;
}) else Runtime.trap("completed withdrawal advanced again");
