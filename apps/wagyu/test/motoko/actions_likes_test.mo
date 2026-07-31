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
import Admission "../../backend/likes/Admission";
import Sealing "../../backend/likes/Sealing";
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
let NONCE = repeated(16, 0x22);
let AUTHOR = canister(1);
let PROOF : Protocol.CertifiedHttpProofV1 = {
    certificate_version = 2;
    certificate_cbor = "\01";
    witness_cbor = "\02";
    expression_path_cbor = "\03";
    certificate_time_ns = 900;
};

// A post freezes exact Candid bytes and atomically creates its immutable body
// plus revision-zero Like head with a projected-state dependency.
let #ok(post) = Planner.preparePost({
    network_id = NETWORK;
    actor_ = AUTHOR;
    author_sequence = 1;
    nonce = NONCE;
    created_at_ns = 100;
    body_markdown = "hello **wagyu**";
    reply_to = null;
    posts_generation = 7;
    like_heads_generation = 8;
    publication_nonce = NONCE;
}) else Runtime.trap("post preparation failed");
assert (post.value.header.action_kind == ?#post);
assert (Principal.equal(post.value.header.actor_, AUTHOR));
assert (post.object_digest.size() == 32);
assert (post.body_hash.size() == 32);
assert (post.post_id.size() == 32);
assert (post.like_head.revision == 0);
assert (post.like_head.accepting_likes);
assert (post.commit.operations.size() == 2);
assert (post.commit.requires_present_after.size() == 1);

let postIdentity = record(
    post.target,
    post.object_digest,
    post.body_candid.size(),
    1,
);
let initialHeadIdentity = record(
    post.like_head_target,
    post.like_head_digest,
    post.like_head_candid.size(),
    1,
);
let #ok(postPublication) = Planner.reconcilePost(
    post,
    {
        operations = [
            putReceipt(0, postIdentity),
            putReceipt(1, initialHeadIdentity),
        ];
    },
) else Runtime.trap("post receipt reconciliation failed");
assert (postPublication.post_identity.kernel_revision == 1);
assert (postPublication.like_head_identity.kernel_revision == 1);

let #ok(postRef) = Planner.finalizePost(post, PROOF) else {
    Runtime.trap("post finalization failed");
};
assert (Blob.equal(postRef.object_digest, post.object_digest));
assert (postRef.body_length == Nat32.fromNat(post.body_candid.size()));

// Replies preserve the compact verified parent locator while retaining a new
// original post identity.
let #ok(reply) = Planner.preparePost({
    network_id = NETWORK;
    actor_ = AUTHOR;
    author_sequence = 2;
    nonce = repeated(16, 0x23);
    created_at_ns = 101;
    body_markdown = "a reply";
    reply_to = ?{
        author = postRef.author;
        post_id = postRef.post_id;
        body_hash = postRef.body_hash;
        body_length = postRef.body_length;
        object_digest = postRef.object_digest;
    };
    posts_generation = 7;
    like_heads_generation = 8;
    publication_nonce = repeated(16, 0x24);
}) else Runtime.trap("reply preparation failed");
assert (reply.value.reply_to != null);
assert (not Blob.equal(reply.post_id, post.post_id));

// A share hashes the exact original ref bytes, never a reconstructed URL or a
// nested share chain.
let postRefCandid = to_candid (postRef);
let SHARER = canister(2);
let #ok(share) = Planner.prepareShare({
    network_id = NETWORK;
    sharer = SHARER;
    share_sequence = 1;
    issued_at_ns = 200;
    original_post_ref = postRef;
    original_post_ref_candid = postRefCandid;
    shares_generation = 9;
    publication_nonce = repeated(16, 0x25);
}) else Runtime.trap("share preparation failed");
assert (
    Blob.equal(
        share.value.post_ref_digest,
        Hash.sha256(postRefCandid),
    )
);
let #ok(shareRef) = Planner.finalizeShare(share, PROOF) else {
    Runtime.trap("share finalization failed");
};
assert (Principal.equal(shareRef.sharer, SHARER));

// Like and tombstone preparation are immutable one-object plans. Like
// finalization freezes the complete portable receipt before dispatch.
func preparedLike(liker : Principal, token : Nat8) : Planner.LikePlan {
    let #ok(value) = Planner.prepareLike({
        network_id = NETWORK;
        liker;
        issued_at_ns = 300;
        post_author = AUTHOR;
        post_id = post.post_id;
        post_body_hash = post.body_hash;
        likes_generation = 10;
        publication_nonce = repeated(16, token);
    }) else Runtime.trap("like preparation failed");
    value;
};

func finalizedLike(
    plan : Planner.LikePlan
) : Planner.LikeFinalization {
    let #ok(value) = Planner.finalizeLike(plan, PROOF) else {
        Runtime.trap("like finalization failed");
    };
    value;
};

let LIKER = canister(3);
let like = preparedLike(LIKER, 0x26);
let likeFinal = finalizedLike(like);
assert (likeFinal.receipt_candid.size() <= 6_000);
assert (
    Blob.equal(
        likeFinal.receipt.ref.object_digest,
        Hash.sha256(like.body_candid),
    )
);

let #ok(tombstone) = Planner.prepareTombstone({
    network_id = NETWORK;
    author = AUTHOR;
    author_sequence = 3;
    issued_at_ns = 400;
    post_id = post.post_id;
    post_body_hash = post.body_hash;
    tombstones_generation = 11;
    publication_nonce = repeated(16, 0x27);
}) else Runtime.trap("tombstone preparation failed");
let #ok(certifiedTombstone) = Planner.finalizeTombstone(
    tombstone,
    PROOF,
) else Runtime.trap("tombstone finalization failed");
assert (certifiedTombstone.ref.action_kind == ?#tombstone);

// Profile edits preserve generation, increment protocol revision, chain the
// raw prior body digest, and use only the durable kernel CAS identity.
let #ok(defaultProfile) = Planner.defaultProfile({
    network_id = NETWORK;
    node = AUTHOR;
    profile_generation = 42;
    updated_at_ns = 500;
    capabilities = ?["wagyu_v1:test"];
}) else Runtime.trap("default profile failed");
let defaultProfileTarget = Publication.profileTarget(12);
let defaultProfileIdentity = Publication.stored(
    record(
        defaultProfileTarget,
        defaultProfile.body_digest,
        defaultProfile.body_candid.size(),
        1,
    )
);
let #ok(profileEdit) = Planner.prepareProfileEdit({
    current = defaultProfile.value;
    current_body_candid = defaultProfile.body_candid;
    current_identity = defaultProfileIdentity;
    updated_at_ns = 501;
    display_name = "Wagyu Owner";
    description = "A certified profile";
    capabilities = ?["wagyu_v1:test"];
    avatar = null;
    publication_nonce = repeated(16, 0x28);
}) else Runtime.trap("profile edit failed");
assert (profileEdit.value.revision == 1);
assert (
    profileEdit.value.previous_profile_digest ==
        ?defaultProfile.body_digest
);
assert (profileEdit.commit.operations.size() == 1);

// Admission binds immediate caller, target, exact Like action bytes, ref
// digest/length and semantic ID without verifying remote certificate bytes.
let admissionBase : Admission.AdmissionInput = {
    caller = LIKER;
    network_id = NETWORK;
    post_author = AUTHOR;
    post_id = post.post_id;
    post_body_hash = post.body_hash;
    action = like.value;
    receipt = likeFinal.receipt;
    exact_receipt_candid = likeFinal.receipt_candid;
    accepted_at_ns = (600 : Nat64);
    next_accepted_sequence = (1 : Nat64);
    existing_receipt_digest = null;
    segments = Admission.emptySegments();
    accepting_likes = true;
    blocked = false;
};
let #accepted(firstAdmission) = Admission.admit(admissionBase) else {
    Runtime.trap("first Like should be accepted");
};
assert (firstAdmission.accepted.accepted_sequence == 1);
assert (firstAdmission.segments.active.size() == 1);
assert (not firstAdmission.seal_due);

let exactDigest = Hash.sha256(likeFinal.receipt_candid);
let #duplicate(_) = Admission.admit({
    admissionBase with
    existing_receipt_digest = ?exactDigest;
}) else Runtime.trap("exact semantic replay should be duplicate");
let #conflict = Admission.admit({
    admissionBase with
    existing_receipt_digest = ?repeated(32, 0xee);
}) else Runtime.trap("different receipt from same liker should conflict");
let #rejected(#blocked) = Admission.admit({
    admissionBase with
    blocked = true;
}) else Runtime.trap("blocked new Like should be rejected");

func acceptedLike(index : Nat) : Admission.AcceptedLike {
    let liker = canister(100 + index);
    let plan = preparedLike(liker, Nat8.fromNat(index % 256));
    let finalization = finalizedLike(plan);
    {
        accepted_sequence = Nat64.fromNat(index);
        accepted_at_ns = Nat64.fromNat(1_000 + index);
        liker;
        like_id = plan.like_id;
        receipt = finalization.receipt;
        exact_receipt_candid = finalization.receipt_candid;
        receipt_digest = Hash.sha256(finalization.receipt_candid);
    };
};

// The 150th receipt moves the active segment into the single due slot. With a
// due slot already occupied, a 150th active receipt returns full before state
// mutation, enforcing the 299-unsealed bound.
let first149 = Array.tabulate<Admission.AcceptedLike>(
    149,
    func(index) { acceptedLike(index + 1) },
);
let oneHundredFiftiethPlan = preparedLike(canister(250), 0xfa);
let oneHundredFiftieth = finalizedLike(oneHundredFiftiethPlan);
let #accepted(rollover) = Admission.admit({
    caller = canister(250);
    network_id = NETWORK;
    post_author = AUTHOR;
    post_id = post.post_id;
    post_body_hash = post.body_hash;
    action = oneHundredFiftiethPlan.value;
    receipt = oneHundredFiftieth.receipt;
    exact_receipt_candid = oneHundredFiftieth.receipt_candid;
    accepted_at_ns = (2_000 : Nat64);
    next_accepted_sequence = (150 : Nat64);
    existing_receipt_digest = null;
    segments = { due = null; active = first149 };
    accepting_likes = true;
    blocked = false;
}) else Runtime.trap("150th receipt should create due segment");
assert (rollover.seal_due);
assert (rollover.segments.due != null);
assert (rollover.segments.active.size() == 0);
assert (Admission.unsealedCount(rollover.segments) == 150);

let second149 = Array.tabulate<Admission.AcceptedLike>(
    149,
    func(index) { acceptedLike(index + 300) },
);
let overflowPlan = preparedLike(canister(600), 0xfb);
let overflowFinal = finalizedLike(overflowPlan);
let #full = Admission.admit({
    caller = canister(600);
    network_id = NETWORK;
    post_author = AUTHOR;
    post_id = post.post_id;
    post_body_hash = post.body_hash;
    action = overflowPlan.value;
    receipt = overflowFinal.receipt;
    exact_receipt_candid = overflowFinal.receipt_candid;
    accepted_at_ns = (3_000 : Nat64);
    next_accepted_sequence = (500 : Nat64);
    existing_receipt_digest = null;
    segments = {
        due = rollover.segments.due;
        active = second149;
    };
    accepting_likes = true;
    blocked = false;
}) else Runtime.trap("299 unsealed receipts should apply backpressure");

// Sealing sorts by accepted sequence, emits exactly one immutable batch and
// one CAS head update, and advances the public protocol counters only once.
let initialHeadState : Sealing.HeadState = {
    value = post.like_head;
    exact_body_candid = post.like_head_candid;
    kernel_identity = Publication.stored(initialHeadIdentity);
};

// V101 may certify a verified 1-149 active segment while the post remains
// open. The partial package is immutable, advances the same head chain, and
// leaves a fresh empty active segment for later verified Likes.
let openPartialEntries = [
    acceptedLike(700),
    acceptedLike(701),
];
let #ok(openPartial) = Sealing.planOpenPartial({
    head = initialHeadState;
    segments = { due = null; active = openPartialEntries };
    like_batches_generation = 13;
    publication_nonce = repeated(16, 0x2c);
}) else Runtime.trap("open partial sealing failed");
assert (openPartial.mode == #open_partial);
assert (openPartial.batch.batch_number == 0);
assert (openPartial.batch.final_partial);
assert (openPartial.batch.receipts.size() == 2);
assert (openPartial.next_head.accepting_likes);
assert (openPartial.next_head.sealed_batch_count == 1);
assert (openPartial.next_head.sealed_receipt_count == 2);
assert (openPartial.next_segments.due == null);
assert (openPartial.next_segments.active.size() == 0);
assert (openPartial.commit.operations.size() == 2);
assert (openPartial.commit.requires_present_after.size() == 1);

let openPartialHeadIdentity = record(
    openPartial.head_target,
    openPartial.next_head_digest,
    openPartial.next_head_candid.size(),
    2,
);
let fullEntriesAfterPartial =
    Array.tabulate<Admission.AcceptedLike>(
        150,
        func(index) { acceptedLike(index + 800) },
    );
let #ok(fullAfterOpenPartial) = Sealing.planDue({
    head = {
        value = openPartial.next_head;
        exact_body_candid = openPartial.next_head_candid;
        kernel_identity =
            Publication.stored(openPartialHeadIdentity);
    };
    segments = {
        due = ?fullEntriesAfterPartial;
        active = [];
    };
    like_batches_generation = 13;
    publication_nonce = repeated(16, 0x2d);
}) else Runtime.trap("full sealing after open partial failed");
assert (fullAfterOpenPartial.mode == #due);
assert (not fullAfterOpenPartial.batch.final_partial);
assert (fullAfterOpenPartial.batch.batch_number == 1);
assert (
    fullAfterOpenPartial.batch.previous_batch_digest ==
        ?openPartial.batch_digest
);
assert (fullAfterOpenPartial.next_head.accepting_likes);
assert (fullAfterOpenPartial.next_head.sealed_batch_count == 2);
assert (fullAfterOpenPartial.next_head.sealed_receipt_count == 152);

let #err(#due_must_seal_first) = Sealing.planOpenPartial({
    head = initialHeadState;
    segments = rollover.segments;
    like_batches_generation = 13;
    publication_nonce = repeated(16, 0x2e);
}) else Runtime.trap("open partial must not bypass a full due segment");

let #ok(seal) = Sealing.planDue({
    head = initialHeadState;
    segments = rollover.segments;
    like_batches_generation = 13;
    publication_nonce = repeated(16, 0x29);
}) else Runtime.trap("due segment sealing failed");
assert (seal.batch.batch_number == 0);
assert (seal.batch.receipts.size() == 150);
assert (not seal.batch.final_partial);
assert (seal.batch.first_accepted_sequence == 1);
assert (seal.batch.last_accepted_sequence == 150);
assert (seal.next_head.revision == 1);
assert (seal.next_head.sealed_batch_count == 1);
assert (seal.next_head.sealed_receipt_count == 150);
assert (seal.commit.operations.size() == 2);
assert (seal.commit.requires_present_after.size() == 1);
assert (seal.next_segments.due == null);

let sealedBatchIdentity = record(
    seal.batch_target,
    seal.batch_digest,
    seal.batch_candid.size(),
    1,
);
let sealedHeadIdentity = record(
    seal.head_target,
    seal.next_head_digest,
    seal.next_head_candid.size(),
    2,
);
let #ok(sealPublication) = Sealing.reconcileSeal(
    seal,
    {
        operations = [
            putReceipt(0, sealedBatchIdentity),
            putReceipt(1, sealedHeadIdentity),
        ];
    },
) else Runtime.trap("seal receipt reconciliation failed");
assert (sealPublication.batch_identity.kernel_revision == 1);
assert (sealPublication.head_identity.kernel_revision == 2);

// Withdrawal first closes the head by CAS, then a final partial batch can be
// archived only after all due work is gone.
let sealedHeadState : Sealing.HeadState = {
    value = seal.next_head;
    exact_body_candid = seal.next_head_candid;
    kernel_identity = Publication.stored(sealedHeadIdentity);
};
let #ok(stop) = Sealing.planStopAccepting({
    head = sealedHeadState;
    publication_nonce = repeated(16, 0x2a);
}) else Runtime.trap("Like closure plan failed");
assert (not stop.next_head.accepting_likes);
assert (stop.next_head.revision == 2);
assert (
    stop.next_head.previous_head_hash ==
        ?Hash.sha256(seal.next_head_candid)
);

let stoppedHeadIdentity = record(
    stop.head_target,
    stop.next_head_digest,
    stop.next_head_candid.size(),
    3,
);
let stoppedHeadState : Sealing.HeadState = {
    value = stop.next_head;
    exact_body_candid = stop.next_head_candid;
    kernel_identity = Publication.stored(stoppedHeadIdentity);
};
let partialEntries = [
    acceptedLike(700),
    acceptedLike(701),
];
let #ok(partial) = Sealing.planFinalPartial({
    head = stoppedHeadState;
    segments = { due = null; active = partialEntries };
    like_batches_generation = 13;
    publication_nonce = repeated(16, 0x2b);
}) else Runtime.trap("final partial sealing failed");
assert (partial.batch.final_partial);
assert (partial.batch.batch_number == 1);
assert (partial.batch.receipts.size() == 2);
assert (
    partial.batch.previous_batch_digest ==
        ?seal.batch_digest
);
assert (not partial.next_head.accepting_likes);
assert (partial.next_head.sealed_batch_count == 2);
assert (partial.next_head.sealed_receipt_count == 152);
assert (partial.next_segments.active.size() == 0);
