import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";

import Bridge "../../backend/owner_bridge/Codec";
import BridgeTypes "../../backend/owner_bridge/Types";
import Hash "../../backend/protocol/Hash";
import Path "../../backend/protocol/Path";
import Protocol "../../backend/protocol/Types";

func bytes(length : Nat) : Blob {
    Blob.fromArray(Array.tabulate<Nat8>(length, func(index) {
        Nat8.fromNat(index % 251);
    }));
};

let principal = Principal.fromBlob(Blob.fromArray([]));
let another = Principal.fromBlob(Blob.fromArray([1]));
let id16 = bytes(16);
let id32 = bytes(32);
let other32 = Blob.fromArray(Array.tabulate<Nat8>(32, func(index) {
    Nat8.fromNat((index + 17) % 251);
}));
let id16Hex = Path.hexLower(id16);
let id32Hex = Path.hexLower(id32);
let other32Hex = Path.hexLower(other32);

assert (Bridge.parseLowerHex16(id16Hex) == ?id16);
assert (Bridge.parseLowerHex32(id32Hex) == ?id32);
assert (Bridge.parseLowerHex16("00") == null);
assert (
    Bridge.parseLowerHex16(
        "000102030405060708090A0b0c0d0e0f"
    ) == null
);

let ?follow = Bridge.follow({
    node = another;
    subscription_id_hex = id16Hex;
}) else Runtime.trap("follow bridge");
assert (Principal.equal(follow.node, another));
assert (Blob.equal(follow.subscription_id, id16));

let replySelf : BridgeTypes.ReplyLocatorSelfV1 = {
    author = another;
    post_id_hex = id32Hex;
    body_hash_hex = other32Hex;
    body_length = Nat32.fromNat(12);
    object_digest_hex = id32Hex;
};
let ?post = Bridge.postPrepare({
    body_markdown = "bridge post";
    nonce_hex = id16Hex;
    reply_to = ?replySelf;
}) else Runtime.trap("post bridge");
assert (Blob.equal(post.nonce, id16));
assert (post.reply_to != null);
assert (
    Bridge.postPrepare({
        body_markdown = "bad\00text";
        nonce_hex = id16Hex;
        reply_to = null;
    }) == null
);

let proof : Protocol.CertifiedHttpProofV1 = {
    certificate_version = 2;
    certificate_cbor = Blob.fromArray([1]);
    witness_cbor = Blob.fromArray([2]);
    expression_path_cbor = Blob.fromArray([3]);
    certificate_time_ns = Nat64.fromNat(99);
};

// A compatible future producer may add an optional record field. The bridge
// must decode current fields but preserve the exact Blob field, not require
// equality with a current-type re-encoding.
type FutureProof = {
    certificate_version : Nat8;
    certificate_cbor : Blob;
    witness_cbor : Blob;
    expression_path_cbor : Blob;
    certificate_time_ns : Nat64;
    future_hint : ?Nat8;
};
let futureProof : FutureProof = {
    certificate_version = proof.certificate_version;
    certificate_cbor = proof.certificate_cbor;
    witness_cbor = proof.witness_cbor;
    expression_path_cbor = proof.expression_path_cbor;
    certificate_time_ns = proof.certificate_time_ns;
    future_hint = ?7;
};
let exactFutureProof = to_candid (futureProof);
let ?finalize = Bridge.finalize(
    #post,
    {
        action_id_hex = id32Hex;
        object_digest_hex = other32Hex;
        exact_proof_candid = exactFutureProof;
    },
) else Runtime.trap("finalize bridge");
assert (finalize.action_kind == #post);
assert (Blob.equal(finalize.action_id, id32));
assert (Blob.equal(finalize.object_digest, other32));
assert (Blob.equal(finalize.exact_proof_candid, exactFutureProof));
assert (
    Blob.equal(
        finalize.proof_digest,
        Hash.objectDigest(exactFutureProof),
    )
);
assert (
    not Blob.equal(
        to_candid (finalize.proof),
        finalize.exact_proof_candid,
    )
);
assert (
    Bridge.finalize(
        #post,
        {
            action_id_hex = id32Hex;
            object_digest_hex = other32Hex;
            exact_proof_candid = Blob.fromArray([0, 1, 2]);
        },
    ) == null
);

let certifiedPostRef : Protocol.CertifiedPostRefV1 = {
    author = another;
    post_id = id32;
    body_hash = other32;
    body_length = Nat32.fromNat(100);
    object_digest = id32;
    proof;
};
type FuturePostRef = {
    author : Principal;
    post_id : Blob;
    body_hash : Blob;
    body_length : Nat32;
    object_digest : Blob;
    proof : Protocol.CertifiedHttpProofV1;
    future_label : ?Text;
};
let exactFuturePostRef = to_candid ({
    author = certifiedPostRef.author;
    post_id = certifiedPostRef.post_id;
    body_hash = certifiedPostRef.body_hash;
    body_length = certifiedPostRef.body_length;
    object_digest = certifiedPostRef.object_digest;
    proof = certifiedPostRef.proof;
    future_label = ?"future";
} : FuturePostRef);
let ?share = Bridge.sharePrepare(
    {
        nonce_hex = ?id16Hex;
        exact_original_post_ref_candid = exactFuturePostRef;
    },
) else Runtime.trap("share bridge");
assert (share.nonce == ?id16);
assert (
    Blob.equal(
        share.exact_original_post_ref_candid,
        exactFuturePostRef,
    )
);
assert (
    Blob.equal(
        share.original_post_ref_digest,
        Hash.objectDigest(exactFuturePostRef),
    )
);
assert (
    not Blob.equal(
        to_candid (share.original_post_ref),
        exactFuturePostRef,
    )
);

let ?like = Bridge.likePrepare({
    post_author = another;
    post_id_hex = id32Hex;
    post_body_hash_hex = other32Hex;
    post_object_digest_hex = ?id32Hex;
    nonce_hex = id16Hex;
}) else Runtime.trap("like bridge");
assert (Blob.equal(like.post_id, id32));
assert (like.post_object_digest == ?id32);

let ?tombstone = Bridge.tombstonePrepare({
    post_id_hex = id32Hex;
    nonce_hex = id16Hex;
}) else Runtime.trap("tombstone bridge");
assert (Blob.equal(tombstone.post_id, id32));

let ?promotion = Bridge.feedPromote({
    candidate_id_hex = id32Hex;
    verified_author = another;
    verified_post_id_hex = other32Hex;
    verified_body_hash_hex = id32Hex;
    verified_object_digest_hex = other32Hex;
}) else Runtime.trap("feed promotion bridge");
assert (Blob.equal(promotion.candidate_id, id32));
assert (
    Bridge.feedReject({
        candidate_id_hex = id32Hex;
        disposition = null;
    }) == null
);
assert (
    Bridge.notificationPromote({
        local_sequence = Nat64.fromNat(1);
        disposition = ?#verified;
        verified_reply = null;
    }) == ?{
        local_sequence = Nat64.fromNat(1);
        disposition = #verified;
        verified_reply = null;
    }
);
let ?replyPromotion = Bridge.notificationPromote({
    local_sequence = Nat64.fromNat(2);
    disposition = ?#verified;
    verified_reply = ?{
        author = another;
        post_id_hex = id32Hex;
        body_hash_hex = other32Hex;
        body_length = 128;
        object_digest_hex = other32Hex;
        reply_to = {
            author = another;
            post_id_hex = other32Hex;
            body_hash_hex = id32Hex;
            body_length = 256;
            object_digest_hex = other32Hex;
        };
    };
}) else Runtime.trap("reply promotion bridge");
let ?verifiedReply = replyPromotion.verified_reply
    else Runtime.trap("reply promotion omitted attestation");
assert (Principal.equal(verifiedReply.author, another));
assert (Blob.equal(verifiedReply.post_id, id32));
assert (Blob.equal(verifiedReply.body_hash, other32));
assert (verifiedReply.body_length == 128);
assert (Blob.equal(verifiedReply.object_digest, other32));
assert (Principal.equal(verifiedReply.reply_to.author, another));
assert (Blob.equal(verifiedReply.reply_to.post_id, other32));

let ?seal = Bridge.likeSeal({
    post_id_hex = id32Hex;
    final_partial = true;
}) else Runtime.trap("Like seal bridge");
assert (Blob.equal(seal.post_id, id32));
let ?advance = Bridge.withdrawalAdvance({
    post_id_hex = id32Hex;
    nonce_hex = id16Hex;
}) else Runtime.trap("withdrawal bridge");
assert (Blob.equal(advance.nonce, id16));

let canonicalPublish : BridgeTypes.CanonicalPublishResultV1 = {
    stage = ?#awaiting_proof;
    post_id = ?id32;
    action_id = ?other32;
    object_digest = ?id32;
    queued_recipient_count = 2;
    queued_notice_count = 1;
    accepted_recipient_count = 0;
    failed_recipient_count = 0;
    message = "capture proof";
};
let ?#ok(publish) = Bridge.publishResult(#ok(canonicalPublish))
    else Runtime.trap("publish result bridge");
assert (publish.post_id_hex == ?id32Hex);
assert (publish.action_id_hex == ?other32Hex);
assert (
    Bridge.publishResult(
        #ok({ canonicalPublish with object_digest = ?bytes(31) })
    ) == null
);

let exactEvent = to_candid ({ marker = "event" });
let feedPage : Protocol.FeedPageV1 = {
    revision = Nat64.fromNat(7);
    items = [{
        candidate_id = id32;
        local_sequence = Nat64.fromNat(6);
        received_at_ns = Nat64.fromNat(5);
        immediate_sender = another;
        event_kind = ?#original;
        claimed_author = another;
        claimed_post_id = other32;
        exact_event_candid = exactEvent;
        verification = ?#pending;
    }];
    next_before_sequence = ?Nat64.fromNat(6);
};
let ?feedOutput = Bridge.feedPageOutput(feedPage)
    else Runtime.trap("feed page output");
assert (feedOutput.value.revision == feedPage.revision);
assert (feedOutput.value.item_count == Nat16.fromNat(1));
assert (
    Nat32.toNat(feedOutput.value.body_bytes) ==
    feedOutput.body.size()
);
assert (
    feedOutput.value.body_digest_hex ==
    Path.hexLower(Hash.objectDigest(feedOutput.body))
);
let decodedFeed : ?Protocol.FeedPageV1 = from_candid feedOutput.body;
assert (decodedFeed == ?feedPage);

let directed = {
    target_post_id = id32;
    target_body_hash = other32;
    action_id = id32;
    object_digest = other32;
    object_length = Nat32.fromNat(10);
};
let notificationPage : Protocol.NotificationPageV1 = {
    revision = Nat64.fromNat(8);
    items = [{
        local_sequence = Nat64.fromNat(4);
        received_at_ns = Nat64.fromNat(3);
        actor_ = another;
        kind = ?#like(directed);
        verification = ?#pending;
        read = false;
    }];
    next_before_sequence = null;
};
let ?notificationOutput = Bridge.notificationPageOutput(
    notificationPage
) else Runtime.trap("notification page output");
assert (notificationOutput.value.item_count == Nat16.fromNat(1));
assert (
    notificationOutput.value.body_digest_hex ==
    Path.hexLower(Hash.objectDigest(notificationOutput.body))
);
let decodedNotifications : ?Protocol.NotificationPageV1 =
    from_candid notificationOutput.body;
assert (decodedNotifications == ?notificationPage);

let evidence : Protocol.NotificationEvidenceV1 = {
    local_sequence = Nat64.fromNat(4);
    found = true;
    evidence = ?#like({
        certified_like_receipt_candid = to_candid ({
            marker = "receipt";
        });
    });
};
let ?evidenceOutput = Bridge.notificationEvidenceOutput(evidence)
    else Runtime.trap("notification evidence output");
assert (evidenceOutput.value.local_sequence == evidence.local_sequence);
assert (evidenceOutput.value.found);
assert (
    evidenceOutput.value.body_digest_hex ==
    Path.hexLower(Hash.objectDigest(evidenceOutput.body))
);
let decodedEvidence : ?Protocol.NotificationEvidenceV1 =
    from_candid evidenceOutput.body;
assert (decodedEvidence == ?evidence);

assert (
    Bridge.notificationEvidenceOutput({
        local_sequence = Nat64.fromNat(9);
        found = true;
        evidence = null;
    }) == null
);
