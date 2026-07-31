import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";
import Nat32 "mo:core/Nat32";
import Runtime "mo:core/Runtime";

import Caps "mo:neutron-capabilities";

import Publication "../../backend/actions/Publication";
import Memory "../../backend/memory/wagyu/v3";
import Journal "../../backend/publication/Journal";

func repeated(size : Nat, byte : Nat8) : Blob {
    Blob.fromArray(Array.repeat<Nat8>(byte, size));
};

func expectMutations(
    result : Journal.Result<[Memory.PublicationMutation]>,
    message : Text,
) : [Memory.PublicationMutation] {
    switch (result) {
        case (#ok(value)) value;
        case (#err(error)) {
            Runtime.trap(message # ": " # debug_show (error));
        };
    };
};

func journalObject(
    target : Caps.Target,
    digest : Blob,
    length : Nat,
) : Journal.ObjectInput {
    {
        target;
        body_digest = digest;
        body_length = length;
    };
};

func expected(
    target : Caps.Target,
    digest : Blob,
    length : Nat,
    revision : Nat64,
) : Journal.ExpectedIdentity {
    {
        target;
        kernel_revision = revision;
        content_tag = digest;
        body_bytes = length;
    };
};

let NONCE = repeated(16, 0x10);
let FINGERPRINT = repeated(32, 0x11);
let POST_DIGEST = repeated(32, 0x21);
let POST_ID = repeated(32, 0x22);
let HEAD_DIGEST_0 = repeated(32, 0x23);
let HEAD_DIGEST_1 = repeated(32, 0x24);
let BATCH_DIGEST = repeated(32, 0x25);
let PROFILE_DIGEST_0 = repeated(32, 0x26);
let PROFILE_DIGEST_1 = repeated(32, 0x27);

let postTarget = Publication.immutableTarget(
    Publication.POSTS_COLLECTION,
    7,
    POST_DIGEST,
);
let headTarget = Publication.likeHeadTarget(8, POST_ID);
let batchTarget = Publication.immutableTarget(
    Publication.LIKE_BATCHES_COLLECTION,
    9,
    BATCH_DIGEST,
);
let profileTarget = Publication.profileTarget(10);

let postMutations = expectMutations(
    Journal.postAndInitialHead({
        post = journalObject(postTarget, POST_DIGEST, 500);
        initial_head = journalObject(headTarget, HEAD_DIGEST_0, 300);
    }),
    "post journal planning failed",
);
assert (postMutations.size() == 2);
let #put(postPut) = postMutations[0] else {
    Runtime.trap("post mutation must be a put");
};
assert (postPut.expected == null);
assert (postPut.requires_present_after == null);
assert (Blob.equal(postPut.body_digest, POST_DIGEST));
assert (postPut.body_length == Nat32.fromNat(500));
let #put(initialHeadPut) = postMutations[1] else {
    Runtime.trap("initial head mutation must be a put");
};
assert (initialHeadPut.expected == null);
let ?postDependency = initialHeadPut.requires_present_after else {
    Runtime.trap("initial head must depend on the post");
};
assert (postDependency.target == postPut.target);
assert (Blob.equal(postDependency.body_digest, POST_DIGEST));

// Each immutable action has one absent put whose locator is the exact body
// digest. The wrappers prevent accidentally journaling the right bytes under
// the wrong Wagyu collection.
let SHARE_DIGEST = repeated(32, 0x31);
let LIKE_DIGEST = repeated(32, 0x32);
let TOMBSTONE_DIGEST = repeated(32, 0x33);
let shareMutations = expectMutations(
    Journal.immutableShare({
        action = journalObject(
            Publication.immutableTarget(
                Publication.SHARES_COLLECTION,
                11,
                SHARE_DIGEST,
            ),
            SHARE_DIGEST,
            401,
        );
    }),
    "share journal planning failed",
);
let likeMutations = expectMutations(
    Journal.immutableLike({
        action = journalObject(
            Publication.immutableTarget(
                Publication.LIKES_COLLECTION,
                12,
                LIKE_DIGEST,
            ),
            LIKE_DIGEST,
            402,
        );
    }),
    "Like journal planning failed",
);
let tombstoneMutations = expectMutations(
    Journal.immutableTombstone({
        action = journalObject(
            Publication.immutableTarget(
                Publication.TOMBSTONES_COLLECTION,
                13,
                TOMBSTONE_DIGEST,
            ),
            TOMBSTONE_DIGEST,
            403,
        );
    }),
    "tombstone journal planning failed",
);
for (
    (mutations, collection) in [
        (shareMutations, #shares),
        (likeMutations, #likes),
        (tombstoneMutations, #tombstones),
    ].vals()
) {
    assert (mutations.size() == 1);
    let #put(value) = mutations[0] else {
        Runtime.trap("immutable action mutation must be a put");
    };
    assert (value.target.collection == collection);
    assert (value.expected == null);
    assert (value.requires_present_after == null);
};

let oldProfile = expected(
    profileTarget,
    PROFILE_DIGEST_0,
    250,
    4,
);
let profileCreateMutations = expectMutations(
    Journal.profileCreate(
        journalObject(profileTarget, PROFILE_DIGEST_0, 250)
    ),
    "lazy profile create journal planning failed",
);
let #put(profileCreate) = profileCreateMutations[0] else {
    Runtime.trap("lazy profile creation must be a put");
};
assert (profileCreate.target.key == #profile);
assert (profileCreate.expected == null);
assert (profileCreate.requires_present_after == null);

let profileMutations = expectMutations(
    Journal.profileCas({
        profile = journalObject(profileTarget, PROFILE_DIGEST_1, 275);
        expected_profile = oldProfile;
    }),
    "profile CAS journal planning failed",
);
let #put(profilePut) = profileMutations[0] else {
    Runtime.trap("profile mutation must be a put");
};
let ?profileExpected = profilePut.expected else {
    Runtime.trap("profile mutation must retain its CAS identity");
};
assert (profileExpected.target == profilePut.target);
assert (profileExpected.kernel_revision == 4);
assert (Blob.equal(profileExpected.content_tag, PROFILE_DIGEST_0));
assert (Blob.equal(profileExpected.body_digest, PROFILE_DIGEST_0));
assert (profileExpected.body_length == Nat32.fromNat(250));
assert (profilePut.requires_present_after == null);

let oldHead = expected(headTarget, HEAD_DIGEST_0, 300, 9);
let sealMutations = expectMutations(
    Journal.likeBatchAndHead({
        batch = journalObject(batchTarget, BATCH_DIGEST, 900_000);
        head = journalObject(headTarget, HEAD_DIGEST_1, 320);
        expected_head = oldHead;
    }),
    "Like batch/head journal planning failed",
);
assert (sealMutations.size() == 2);
let #put(batchPut) = sealMutations[0] else {
    Runtime.trap("Like batch mutation must be a put");
};
assert (batchPut.target.collection == #like_batches);
assert (batchPut.expected == null);
assert (batchPut.requires_present_after == null);
let #put(sealedHeadPut) = sealMutations[1] else {
    Runtime.trap("sealed head mutation must be a put");
};
let ?sealedHeadExpected = sealedHeadPut.expected else {
    Runtime.trap("sealed head must retain its prior CAS identity");
};
assert (sealedHeadExpected.kernel_revision == 9);
let ?batchDependency = sealedHeadPut.requires_present_after else {
    Runtime.trap("sealed head must depend on the immutable batch");
};
assert (batchDependency.target == batchPut.target);
assert (Blob.equal(batchDependency.body_digest, BATCH_DIGEST));

let stopMutations = expectMutations(
    Journal.headStop({
        head = journalObject(headTarget, HEAD_DIGEST_1, 320);
        expected_head = oldHead;
    }),
    "head-stop journal planning failed",
);
let #put(stopPut) = stopMutations[0] else {
    Runtime.trap("head-stop mutation must be a put");
};
assert (stopPut.expected != null);
assert (stopPut.requires_present_after == null);

let roomyCapacity : Journal.Capacity = {
    current_receipt_count = 7;
    receipt_count_limit = 4_096;
    current_retained_bytes = 1_000;
    retained_bytes_limit = 10_000_000;
};
let #ok(postJournal) = Journal.validate({
    request_nonce = NONCE;
    request_fingerprint = FINGERPRINT;
    mutations = postMutations;
    capacity = roomyCapacity;
}) else Runtime.trap("valid post journal preflight failed");
assert (postJournal.mutations.size() == 2);
assert (
    postJournal.retained_bytes ==
        Journal.retainedBytesFor(postMutations)
);
assert (postJournal.retained_bytes > 0);

// Envelope and local-capacity validation happens before a kernel mutation.
assert (
    Journal.validate({
        request_nonce = repeated(15, 0x10);
        request_fingerprint = FINGERPRINT;
        mutations = postMutations;
        capacity = roomyCapacity;
    }) == #err(#invalid_nonce)
);
assert (
    Journal.validate({
        request_nonce = NONCE;
        request_fingerprint = repeated(31, 0x11);
        mutations = postMutations;
        capacity = roomyCapacity;
    }) == #err(#invalid_fingerprint)
);
assert (
    Journal.validate({
        request_nonce = NONCE;
        request_fingerprint = FINGERPRINT;
        mutations = [];
        capacity = roomyCapacity;
    }) == #err(#empty_mutations)
);
assert (
    Journal.validate({
        request_nonce = NONCE;
        request_fingerprint = FINGERPRINT;
        mutations = Array.repeat<Memory.PublicationMutation>(
            shareMutations[0],
            17,
        );
        capacity = roomyCapacity;
    }) == #err(#too_many_mutations)
);
assert (
    Journal.validate({
        request_nonce = NONCE;
        request_fingerprint = FINGERPRINT;
        mutations = postMutations;
        capacity = {
            roomyCapacity with
            current_receipt_count = 4_096;
        };
    }) == #err(#receipt_full)
);
assert (
    Journal.validate({
        request_nonce = NONCE;
        request_fingerprint = FINGERPRINT;
        mutations = postMutations;
        capacity = {
            roomyCapacity with
            current_retained_bytes = 11;
            retained_bytes_limit = 10;
        };
    }) == #err(#invalid_capacity)
);
let requiredPostBytes = Journal.retainedBytesFor(postMutations);
assert (
    Journal.validate({
        request_nonce = NONCE;
        request_fingerprint = FINGERPRINT;
        mutations = postMutations;
        capacity = {
            current_receipt_count = 0;
            receipt_count_limit = 1;
            current_retained_bytes = 0;
            retained_bytes_limit = requiredPostBytes - 1;
        };
    }) == #err(#retained_bytes_full)
);

// The aggregate body limit is independent of each collection's object limit.
let LARGE_SHARE_DIGEST = repeated(32, 0x41);
let LARGE_LIKE_DIGEST = repeated(32, 0x42);
let largeShare = expectMutations(
    Journal.immutableShare({
        action = journalObject(
            Publication.immutableTarget(
                Publication.SHARES_COLLECTION,
                20,
                LARGE_SHARE_DIGEST,
            ),
            LARGE_SHARE_DIGEST,
            600_000,
        );
    }),
    "large share should fit its collection",
);
let largeLike = expectMutations(
    Journal.immutableLike({
        action = journalObject(
            Publication.immutableTarget(
                Publication.LIKES_COLLECTION,
                21,
                LARGE_LIKE_DIGEST,
            ),
            LARGE_LIKE_DIGEST,
            600_000,
        );
    }),
    "large Like should fit its collection",
);
assert (
    Journal.validate({
        request_nonce = NONCE;
        request_fingerprint = FINGERPRINT;
        mutations = [largeShare[0], largeLike[0]];
        capacity = roomyCapacity;
    }) == #err(#batch_too_large)
);

// A body-sha locator and the journaled digest are one immutable identity.
assert (
    Journal.immutableShare({
        action = journalObject(
            Publication.immutableTarget(
                Publication.SHARES_COLLECTION,
                11,
                SHARE_DIGEST,
            ),
            LIKE_DIGEST,
            401,
        );
    }) == #err(#invalid_target)
);
assert (
    Journal.headStop({
        head = journalObject(headTarget, HEAD_DIGEST_1, 320);
        expected_head = {
            oldHead with
            kernel_revision = 0;
        };
    }) == #err(#invalid_expected_identity)
);

// One-target revocation retains the exact CAS identity. Wagyu never revokes
// its exact-path profile and never mixes delete and positive mutations.
let shareIdentity : Memory.KernelRecordIdentity = {
    target = {
        collection = #shares;
        collection_generation = 11;
        key = #digest(SHARE_DIGEST);
    };
    kernel_revision = 3;
    content_tag = SHARE_DIGEST;
    body_digest = SHARE_DIGEST;
    body_length = 401;
};
let deleteMutations = expectMutations(
    Journal.deleteRecord(shareIdentity),
    "one-target revocation planning failed",
);
assert (deleteMutations.size() == 1);
switch (deleteMutations[0]) {
    case (#delete(_)) {};
    case (_) Runtime.trap("revocation must be a delete");
};
switch (
    Journal.deleteRecord({
        shareIdentity with
        content_tag = repeated(31, 0x31);
    })
) {
    case (#err(#invalid_expected_identity)) {};
    case (_) Runtime.trap("invalid revocation content tag was accepted");
};
switch (
    Journal.deleteRecord({
        shareIdentity with
        target = {
            collection = #profile;
            collection_generation = 10;
            key = #profile;
        };
    })
) {
    case (#err(#invalid_expected_identity)) {};
    case (_) Runtime.trap("profile revocation was accepted");
};
switch (
    Journal.validate({
        request_nonce = NONCE;
        request_fingerprint = FINGERPRINT;
        mutations = [deleteMutations[0], likeMutations[0]];
        capacity = roomyCapacity;
    })
) {
    case (#err(#mixed_domains)) {};
    case (_) Runtime.trap("mixed positive/revocation journal was accepted");
};
