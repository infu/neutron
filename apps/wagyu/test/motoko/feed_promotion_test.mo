import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat32 "mo:core/Nat32";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";

import Promotion "../../backend/feed/Promotion";
import FeedTypes "../../backend/feed/Types";
import Hash "../../backend/protocol/Hash";
import Protocol "../../backend/protocol/Types";
import Wire "../../backend/protocol/Wire";

func repeated(byte : Nat8, count : Nat) : Blob {
    Blob.fromArray(Array.tabulate<Nat8>(count, func(_) { byte }));
};

func expect<T>(value : ?T, message : Text) : T {
    switch (value) {
        case (?result) result;
        case null Runtime.trap(message);
    };
};

let networkId = repeated(0x11, 32);
let author = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
let sharer = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
let bodyHash = repeated(0x22, 32);
let objectDigest = repeated(0x33, 32);
let postId = expect(
    Hash.postId(networkId, author, bodyHash),
    "post id unavailable",
);
let proof : Protocol.CertifiedHttpProofV1 = {
    certificate_version = 2;
    certificate_cbor = repeated(0x41, 1);
    witness_cbor = repeated(0x42, 1);
    expression_path_cbor = repeated(0x43, 1);
    certificate_time_ns = 10;
};
let postRef : Protocol.CertifiedPostRefV1 = {
    author;
    post_id = postId;
    body_hash = bodyHash;
    body_length = 12;
    object_digest = objectDigest;
    proof;
};
let exactPostRef = Wire.encodeCertifiedPostRef(postRef);

func candidate(
    idByte : Nat8,
    immediateSender : Principal,
    kind : FeedTypes.FeedEventKindV1,
    exactEvent : Blob,
) : FeedTypes.StoredCandidate {
    {
        candidate_key = "candidate:test";
        candidate_id = repeated(idByte, 32);
        route_receipt_key = "receipt:test";
        operation_id = repeated(idByte, 16);
        payload_digest = repeated(idByte + 1, 32);
        subscription_id = repeated(idByte + 2, 32);
        local_sequence = 1;
        received_at_ns = 20;
        immediate_sender = immediateSender;
        event_kind = kind;
        claimed_author = author;
        claimed_post_id = postId;
        claimed_body_hash = bodyHash;
        exact_event_candid = exactEvent;
        verification = #pending;
        retain_until_ns = 1_020;
        retained_bytes = exactEvent.size() + 256;
    };
};

let claim : Promotion.VerifiedClaim = {
    author;
    post_id = postId;
    body_hash = bodyHash;
    object_digest = objectDigest;
};

switch (
    Promotion.prepare(
        networkId,
        candidate(0x51, author, #original, exactPostRef),
        claim,
        30,
        1_030,
    )
) {
    case (#ok(#delivery(value))) {
        assert (value.share == null);
        assert (Blob.equal(value.post.key.post_id, postId));
        assert (
            Blob.equal(
                value.post.exact_certified_post_ref_candid,
                exactPostRef,
            )
        );
    };
    case (_) Runtime.trap("expected original promotion plan");
};

assert (
    Promotion.prepare(
        networkId,
        candidate(0x52, author, #original, exactPostRef),
        { claim with object_digest = repeated(0x34, 32) },
        30,
        1_030,
    ) == #err(#mismatch)
);

let shareId = expect(
    Hash.shareId(networkId, sharer, author, postId),
    "share id unavailable",
);
let shareAction : Protocol.ShareActionV1 = {
    header = {
        network_id = networkId;
        actor_ = sharer;
        action_kind = ?#share;
    };
    share_id = shareId;
    share_sequence = 1;
    issued_at_ns = 40;
    original_author = author;
    original_post_id = postId;
    original_body_hash = bodyHash;
    post_ref_digest = Hash.postRefDigest(exactPostRef);
};
let exactShareAction = Wire.encodeShareAction(shareAction);
let shareRef : Protocol.CertifiedShareRefV1 = {
    sharer;
    share_id = shareId;
    body_length = Nat32.fromNat(exactShareAction.size());
    object_digest = Hash.sha256(exactShareAction);
    proof;
};
let exactShareDelivery = Wire.encodeCertifiedShareDelivery({
    original_post_ref_candid = exactPostRef;
    share_action_candid = exactShareAction;
    share_ref = shareRef;
});

switch (
    Promotion.prepare(
        networkId,
        candidate(0x53, sharer, #share, exactShareDelivery),
        claim,
        50,
        1_050,
    )
) {
    case (#ok(#delivery(value))) {
        let ?share = value.share else {
            Runtime.trap("share promotion omitted attribution");
        };
        assert (Principal.equal(share.sharer, sharer));
        assert (Blob.equal(share.share_id, shareId));
        assert (
            Blob.equal(
                share.exact_delivery_candid,
                exactShareDelivery,
            )
        );
    };
    case (_) Runtime.trap("expected share promotion plan");
};

let invalidShareAction = Wire.encodeShareAction({
    shareAction with post_ref_digest = repeated(0x77, 32)
});
let invalidShareDelivery = Wire.encodeCertifiedShareDelivery({
    original_post_ref_candid = exactPostRef;
    share_action_candid = invalidShareAction;
    share_ref = {
        shareRef with
        body_length = Nat32.fromNat(invalidShareAction.size());
        object_digest = Hash.sha256(invalidShareAction);
    };
});
assert (
    Promotion.prepare(
        networkId,
        candidate(0x54, sharer, #share, invalidShareDelivery),
        claim,
        50,
        1_050,
    ) == #err(#invalid)
);

let tombstoneId = expect(
    Hash.tombstoneId(networkId, author, postId, 2),
    "tombstone id unavailable",
);
let tombstoneAction : Protocol.TombstoneActionV1 = {
    header = {
        network_id = networkId;
        actor_ = author;
        action_kind = ?#tombstone;
    };
    tombstone_id = tombstoneId;
    author_sequence = 2;
    issued_at_ns = 60;
    post_id = postId;
    post_body_hash = bodyHash;
};
let exactTombstoneAction = Wire.encodeTombstoneAction(tombstoneAction);
let tombstoneObjectDigest = Hash.sha256(exactTombstoneAction);
let exactTombstone = Wire.encodeCertifiedTombstone({
    tombstone_action_candid = exactTombstoneAction;
    ref = {
        actor_ = author;
        action_kind = ?#tombstone;
        object_digest = tombstoneObjectDigest;
        body_length = Nat32.fromNat(exactTombstoneAction.size());
        proof_snapshot = proof;
    };
});
let tombstoneClaim : Promotion.VerifiedClaim = {
    claim with object_digest = tombstoneObjectDigest
};

switch (
    Promotion.prepare(
        networkId,
        candidate(0x55, sharer, #tombstone, exactTombstone),
        tombstoneClaim,
        70,
        1_070,
    )
) {
    case (#ok(#tombstone(value))) {
        assert (Blob.equal(value.tombstone_id, tombstoneId));
        assert (value.retain_until_ns == 1_070);
        assert (
            Blob.equal(
                value.exact_tombstone_candid,
                exactTombstone,
            )
        );
    };
    case (_) Runtime.trap("expected relayed tombstone promotion plan");
};

assert (
    Promotion.prepare(
        networkId,
        candidate(0x56, sharer, #tombstone, exactTombstone),
        { tombstoneClaim with object_digest = repeated(0x88, 32) },
        70,
        1_070,
    ) == #err(#mismatch)
);
