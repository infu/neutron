import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";

import Bounds "../../backend/protocol/Bounds";
import CandidGuard "../../backend/protocol/CandidGuard";
import Hash "../../backend/protocol/Hash";
import Path "../../backend/protocol/Path";
import Types "../../backend/protocol/Types";
import Validation "../../backend/protocol/Validation";
import Wire "../../backend/protocol/Wire";

func blob(bytes : [Nat8]) : Blob { Blob.fromArray(bytes) };

let management = Principal.fromBlob(blob([]));
let another = Principal.fromBlob(blob([1]));
let rootDer = blob([1, 2, 3, 4]);
let hash32 = blob(Array.tabulate<Nat8>(32, func(index) {
    Nat8.fromNat(index)
}));
let nonce16 = blob(Array.tabulate<Nat8>(16, func(index) {
    Nat8.fromNat(index)
}));

// Independent LP/SHA-256 golden vectors.
let ?networkId = Hash.networkId(rootDer) else {
    Runtime.trap("network id");
};
assert (
    Path.hexLower(networkId) ==
    "6e6906b3f36913351bf828d0deae0eadd479d553b6822436f06873bd83c6a6e7"
);
let exactPost = Text.encodeUtf8("DIDL-test-post");
let ?bodyHash = Hash.postBodyHash(exactPost) else {
    Runtime.trap("post body hash");
};
assert (
    Path.hexLower(bodyHash) ==
    "0e5c45e7e5b1485e745c5b167a493d504601919446f76818b02d942f331be1bb"
);
let ?postId = Hash.postId(networkId, management, bodyHash) else {
    Runtime.trap("post id");
};
assert (
    Path.hexLower(postId) ==
    "18493ee5aba95fdbf3e14197042cc16d2b784b1e3f8bc454e25d3d18f14572f3"
);
let ?shareId = Hash.shareId(
    networkId,
    management,
    another,
    hash32,
) else Runtime.trap("share id");
assert (
    Path.hexLower(shareId) ==
    "0c7a7249f0c59a54eac0aec57d5d8d218f546a3a6cd8da8e42173202a3d1d3ef"
);
let ?likeId = Hash.likeId(
    networkId,
    management,
    another,
    hash32,
) else Runtime.trap("like id");
assert (
    Path.hexLower(likeId) ==
    "1395628f8270727f86d5ee421e7fe007c6eefd37e94dc46dc5b78f328ce4a8e7"
);
let ?tombstoneId = Hash.tombstoneId(
    networkId,
    management,
    hash32,
    Nat64.fromNat(42),
) else Runtime.trap("tombstone id");
assert (
    Path.hexLower(tombstoneId) ==
    "f083ec21e05cfc2bab9a4fde2918759ba3d38efac717e1d37d0c204f9fba3106"
);
let payloadDigest = Hash.payloadDigest(Text.encodeUtf8("abc"));
assert (
    Path.hexLower(payloadDigest) ==
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
);
let ?candidateId = Hash.feedCandidateId(
    management,
    nonce16,
    payloadDigest,
) else Runtime.trap("candidate id");
assert (
    Path.hexLower(candidateId) ==
    "34b67fd352668a77b6542d7294c91b9c4547337a75f1f8e4f08d3ae53ab876e5"
);
assert (Hash.postId(blob([0]), management, bodyHash) == null);

// Fixed path construction is lowercase, content-addressed, and rejects
// adjacent-length digests.
assert (
    Path.postObject(hash32) ==
    ?(
        "/app/wagyu/_route/protocol/v1/objects/post/sha256/" #
        "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
    )
);
assert (
    Path.likeBatchObject(hash32) ==
    ?(
        "/app/wagyu/_route/protocol/v1/objects/like-batch/sha256/" #
        "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
    )
);
assert (
    Path.likeHead(hash32) ==
    ?(
        "/app/wagyu/_route/protocol/v1/heads/likes/" #
        "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
    )
);
assert (Path.postObject(blob([0])) == null);
assert (
    Path.parseLowerHex32(Path.hexLower(hash32)) == ?hash32
);
assert (
    Path.parseLowerHex32(
        "000102030405060708090A0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
    ) == null
);

assert (Bounds.route(Bounds.FOLLOW_ROUTE) == ?Bounds.FOLLOW);
assert (Bounds.route("wagyu_v1:future") == null);
assert (Bounds.stagingBlockCount(0) == ?1);
assert (Bounds.stagingBlockCount(65_536) == ?1);
assert (Bounds.stagingBlockCount(65_537) == ?2);
assert (Bounds.stagingBlockCount(1_048_576) == ?16);
assert (Bounds.stagingBlockCount(1_048_577) == null);

// UTF-8 Text is already scalar-valid; protocol validation additionally rejects
// non-text C0/C1 controls while retaining ordinary line whitespace.
assert (Validation.safeText("hello\nworld", 32));
assert (not Validation.safeText("bad\00value", 32));
let ?c1 = Text.decodeUtf8(blob([0xc2, 0x80])) else {
    Runtime.trap("C1 fixture");
};
assert (not Validation.safeText(c1, 32));
assert (Validation.capabilityToken("wagyu_v1:feature-name"));
assert (not Validation.capabilityToken("Bad Token"));
assert (
    Validation.capabilities([
        "wagyu_v1:a",
        "wagyu_v1:b",
    ])
);
assert (
    not Validation.capabilities([
        "wagyu_v1:b",
        "wagyu_v1:a",
    ])
);
assert (
    not Validation.capabilities([
        "wagyu_v1:a",
        "wagyu_v1:a",
    ])
);

let proof : Types.CertifiedHttpProofV1 = {
    certificate_version = 2;
    certificate_cbor = blob([1]);
    witness_cbor = blob([2]);
    expression_path_cbor = blob([3]);
    certificate_time_ns = Nat64.fromNat(10);
};
assert (Validation.certifiedHttpProof(proof, 100));
assert (
    not Validation.certifiedHttpProof(
        { proof with certificate_version = 1 },
        100,
    )
);

let header : Types.ActionHeaderV1 = {
    network_id = networkId;
    actor_ = management;
    action_kind = ?#post;
};
let post : Types.PostBodyV1 = {
    header;
    author_sequence = Nat64.fromNat(1);
    nonce = nonce16;
    created_at_ns = Nat64.fromNat(2);
    body_markdown = "hello";
    reply_to = null;
};
assert (
    Validation.postBody(post, networkId, management) == #valid
);
assert (
    Validation.postBody(
        {
            post with
            header = { header with action_kind = null };
        },
        networkId,
        management,
    ) == #incompatible
);
assert (
    Validation.postBody(
        { post with nonce = blob([1]) },
        networkId,
        management,
    ) == #invalid
);

let profile : Types.ProfileV1 = {
    network_id = networkId;
    node = management;
    profile_generation = Nat64.fromNat(1);
    revision = Nat64.fromNat(0);
    updated_at_ns = Nat64.fromNat(3);
    previous_profile_digest = null;
    display_name = "Node";
    description = "Description";
    capabilities = ?["wagyu_v1:a", "wagyu_v1:b"];
    avatar = null;
};
assert (
    Validation.profile(profile, networkId, management) == #valid
);
assert (
    Validation.profile(
        {
            profile with
            avatar = ?{
                media_type = null;
                width = Nat16.fromNat(1);
                height = Nat16.fromNat(1);
                bytes = blob([0]);
            };
        },
        networkId,
        management,
    ) == #avatar_unsupported
);

// Exact nested Candid round trips, and malformed/truncated values are rejected
// before `from_candid`.
let follow : Types.FollowBodyV1 = {
    expected_revision = Nat64.fromNat(7);
    subscription_id = nonce16;
};
let followCandid = Wire.encodeFollowBody(follow);
assert (Wire.decodeFollowBody(followCandid) == ?follow);
assert (
    Wire.decodeFollowBody(
        blob(Array.tabulate<Nat8>(
            followCandid.size() - 1,
            func(index) { followCandid[index] },
        ))
    ) == null
);
let ?prepared = Wire.prepare(
    Bounds.FOLLOW_ROUTE,
    nonce16,
    followCandid,
) else Runtime.trap("prepared ingress");
assert (prepared.request.method == Bounds.FOLLOW.method);
assert (Blob.equal(prepared.request.payload, prepared.ingress_candid));
assert (Blob.equal(prepared.body_candid, followCandid));
assert (
    Blob.equal(
        prepared.payload_digest,
        Hash.sha256(followCandid),
    )
);
assert (
    Wire.decodeIngressForRoute(
        Bounds.FOLLOW_ROUTE,
        prepared.ingress_candid,
    ) == ?{
        operation_id = nonce16;
        body_candid = followCandid;
    }
);
assert (
    Wire.prepare(
        Bounds.FOLLOW_ROUTE,
        blob([0]),
        followCandid,
    ) == null
);

let routeResult : Types.WagyuRouteResultV1 = {
    outcome = ?#accepted;
    local_receipt_time_ns = ?Nat64.fromNat(100);
    revision = null;
    relationship = null;
};
let routeResultCandid = Wire.encodeRouteResult(routeResult);
assert (
    Wire.decodeRouteResult(routeResultCandid, 256) == ?routeResult
);
assert (Validation.routeResult(routeResult) == #valid);
assert (
    Validation.routeResult(
        { routeResult with outcome = null }
    ) == #incompatible
);

let outerError : Types.PublicIngressResultV1 = #err(#busy);
assert (
    Wire.decodePublicIngressResult(
        to_candid (outerError),
        256,
    ) == ?outerError
);
let outerOk : Types.PublicIngressResultV1 = #ok(routeResultCandid);
assert (
    Wire.decodePublicIngressResult(
        to_candid (outerOk),
        256,
    ) == ?outerOk
);

let encodedPost = Wire.encodePostBody(post);
assert (Wire.decodePostBody(encodedPost) == ?post);
let encodedProfile = Wire.encodeProfile(profile);
assert (Wire.decodeProfile(encodedProfile) == ?profile);

// Independent Motoko encoding of the same semantic ReplyIndexV1 value as the
// TypeScript golden fixture. Candid encoders may order their type tables
// differently, so Motoko freezes its own exact bytes by length and digest.
let ?goldenNetworkId = Path.parseLowerHex32(
    "6c777193cb352fcf161afad69a6def789c4c6ebdd1fd1a9eb98d54c9a8a01c44"
) else Runtime.trap("golden network id");
let ?goldenPostId = Path.parseLowerHex32(
    "de126f939e1c981ea2d29c9393fa9ee643167d46ed367ee8a6ca31408b037422"
) else Runtime.trap("golden post id");
let ?goldenPostBodyHash = Path.parseLowerHex32(
    "6136ecd5838ee1c6cb00f9b387a8966af87f97ec39363c94c7dadd864502ee03"
) else Runtime.trap("golden post body hash");
let ?goldenReplyPostId = Path.parseLowerHex32(
    "0b052402c5b2dc99c4a7082dfb0d7e5d1fcb8a3a7fe939c8dbc40f4237a38dfc"
) else Runtime.trap("golden reply post id");
let ?goldenReplyDigest = Path.parseLowerHex32(
    "a47c2ba099bc354ffd7c123a2983a59ca4b16b79ec40564e9adf1fd7a7852e91"
) else Runtime.trap("golden reply digest");
let goldenReplyIndex : Types.ReplyIndexV1 = {
    network_id = goldenNetworkId;
    post_author = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
    post_id = goldenPostId;
    post_body_hash = goldenPostBodyHash;
    store_generation = Nat64.fromNat(10);
    revision = Nat64.fromNat(1);
    previous_index_hash = null;
    replies = [{
        author = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
        post_id = goldenReplyPostId;
        object_digest = goldenReplyDigest;
        object_length = Nat32.fromNat(314);
        received_at_ns = Nat64.fromNat(1_725_000_000_150_000_000);
    }];
};
let goldenReplyIndexCandid = to_candid (goldenReplyIndex);
assert (goldenReplyIndexCandid.size() == 314);
assert (
    Path.hexLower(Hash.sha256(goldenReplyIndexCandid)) ==
    "ba6c58ce793e888614c55a5ade41c4d4358f0fbb1fc924e05ba7a17efd6fd7d1"
);
let decodedGoldenReplyIndex : ?Types.ReplyIndexV1 =
    from_candid goldenReplyIndexCandid;
assert (decodedGoldenReplyIndex == ?goldenReplyIndex);

// One text argument with invalid UTF-8. Structural preflight must reject it,
// otherwise Motoko's subsequent from_candid could trap.
let malformedTextCandid = blob([
    0x44, 0x49, 0x44, 0x4c,
    0x00,
    0x01, 0x71,
    0x01, 0xff,
]);
assert (not CandidGuard.validOne(malformedTextCandid, 32));
