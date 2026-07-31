import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Sha256 "mo:sha2/Sha256";

import Bounds "./Bounds";

// Wagyu V1's only semantic hash framing is:
//   LP(x) = u32be(byte_length(x)) || x
//   H(xs) = SHA256(LP(xs[0]) || LP(xs[1]) || ...)
//
// Exact Candid bytes enter these functions as opaque Blobs. They are never
// decoded and re-encoded to recreate a hash preimage.
module {
    public let NETWORK_ID_DOMAIN : Text = "neutron.network-id.v1";
    public let POST_BODY_DOMAIN : Text = "wagyu.post-body.v1";
    public let POST_ID_DOMAIN : Text = "wagyu.post-id.v1";
    public let SHARE_ID_DOMAIN : Text = "wagyu.share-id.v1";
    public let LIKE_ID_DOMAIN : Text = "wagyu.like-id.v1";
    public let TOMBSTONE_ID_DOMAIN : Text = "wagyu.tombstone-id.v1";
    public let FEED_CANDIDATE_ID_DOMAIN : Text =
        "wagyu.feed-candidate-id.v1";

    let MAX_U32 : Nat = 4_294_967_295;

    public func sha256(value : Blob) : Blob {
        Sha256.fromBlob(#sha256, value);
    };

    public func payloadDigest(bodyCandid : Blob) : Blob {
        sha256(bodyCandid);
    };

    public func objectDigest(exactResponseBody : Blob) : Blob {
        sha256(exactResponseBody);
    };

    public func u32be(value : Nat32) : Blob {
        Blob.fromArray([
            Nat8.fromNat(Nat32.toNat(value >> 24)),
            Nat8.fromNat(Nat32.toNat(value >> 16) % 256),
            Nat8.fromNat(Nat32.toNat(value >> 8) % 256),
            Nat8.fromNat(Nat32.toNat(value) % 256),
        ]);
    };

    public func u64be(value : Nat64) : Blob {
        Blob.fromArray([
            Nat8.fromNat(Nat64.toNat(value >> 56)),
            Nat8.fromNat(Nat64.toNat(value >> 48) % 256),
            Nat8.fromNat(Nat64.toNat(value >> 40) % 256),
            Nat8.fromNat(Nat64.toNat(value >> 32) % 256),
            Nat8.fromNat(Nat64.toNat(value >> 24) % 256),
            Nat8.fromNat(Nat64.toNat(value >> 16) % 256),
            Nat8.fromNat(Nat64.toNat(value >> 8) % 256),
            Nat8.fromNat(Nat64.toNat(value) % 256),
        ]);
    };

    public func lengthPrefix(value : Blob) : ?Blob {
        if (value.size() > MAX_U32) return null;
        ?Blob.fromArray(
            Array.flatten<Nat8>([
                Blob.toArray(u32be(Nat32.fromNat(value.size()))),
                Blob.toArray(value),
            ])
        );
    };

    public func lpHash(domain : Text, items : [Blob]) : ?Blob {
        let digest = Sha256.Digest(#sha256);
        if (not writeLengthPrefixed(digest, Text.encodeUtf8(domain))) {
            return null;
        };
        for (item in items.values()) {
            if (not writeLengthPrefixed(digest, item)) return null;
        };
        ?digest.sum();
    };

    public func networkId(exactPinnedRootSpkiDer : Blob) : ?Blob {
        lpHash(NETWORK_ID_DOMAIN, [exactPinnedRootSpkiDer]);
    };

    public func postBodyHash(exactPostBodyCandid : Blob) : ?Blob {
        lpHash(POST_BODY_DOMAIN, [exactPostBodyCandid]);
    };

    public func postId(
        networkIdValue : Blob,
        author : Principal,
        bodyHash : Blob,
    ) : ?Blob {
        if (
            networkIdValue.size() != Bounds.HASH_BYTES or
            bodyHash.size() != Bounds.HASH_BYTES
        ) return null;
        lpHash(
            POST_ID_DOMAIN,
            [networkIdValue, Principal.toBlob(author), bodyHash],
        );
    };

    public func postRefDigest(exactCertifiedPostRefCandid : Blob) : Blob {
        sha256(exactCertifiedPostRefCandid);
    };

    public func shareId(
        networkIdValue : Blob,
        sharer : Principal,
        originalAuthor : Principal,
        originalPostId : Blob,
    ) : ?Blob {
        if (
            networkIdValue.size() != Bounds.HASH_BYTES or
            originalPostId.size() != Bounds.HASH_BYTES
        ) return null;
        lpHash(
            SHARE_ID_DOMAIN,
            [
                networkIdValue,
                Principal.toBlob(sharer),
                Principal.toBlob(originalAuthor),
                originalPostId,
            ],
        );
    };

    public func likeId(
        networkIdValue : Blob,
        liker : Principal,
        postAuthor : Principal,
        postIdValue : Blob,
    ) : ?Blob {
        if (
            networkIdValue.size() != Bounds.HASH_BYTES or
            postIdValue.size() != Bounds.HASH_BYTES
        ) return null;
        lpHash(
            LIKE_ID_DOMAIN,
            [
                networkIdValue,
                Principal.toBlob(liker),
                Principal.toBlob(postAuthor),
                postIdValue,
            ],
        );
    };

    public func tombstoneId(
        networkIdValue : Blob,
        author : Principal,
        postIdValue : Blob,
        authorSequence : Nat64,
    ) : ?Blob {
        if (
            networkIdValue.size() != Bounds.HASH_BYTES or
            postIdValue.size() != Bounds.HASH_BYTES
        ) return null;
        lpHash(
            TOMBSTONE_ID_DOMAIN,
            [
                networkIdValue,
                Principal.toBlob(author),
                postIdValue,
                u64be(authorSequence),
            ],
        );
    };

    public func feedCandidateId(
        immediateCaller : Principal,
        operationId : Blob,
        payloadDigestValue : Blob,
    ) : ?Blob {
        if (
            operationId.size() != Bounds.OPERATION_ID_BYTES or
            payloadDigestValue.size() != Bounds.HASH_BYTES
        ) return null;
        lpHash(
            FEED_CANDIDATE_ID_DOMAIN,
            [
                Principal.toBlob(immediateCaller),
                operationId,
                payloadDigestValue,
            ],
        );
    };

    func writeLengthPrefixed(
        digest : Sha256.Digest,
        value : Blob,
    ) : Bool {
        if (value.size() > MAX_U32) return false;
        digest.writeBlob(u32be(Nat32.fromNat(value.size())));
        digest.writeBlob(value);
        true;
    };
};
