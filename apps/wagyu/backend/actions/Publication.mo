import Blob "mo:core/Blob";
import Nat32 "mo:core/Nat32";

import Caps "mo:neutron-capabilities";

// Small, pure helpers for constructing and reconciling kernel certified-asset
// publication plans. Capability invocation deliberately remains in main.mo so
// application state can be assigned only after a synchronous kernel success.
module {
    public let POSTS_COLLECTION = "posts";
    public let SHARES_COLLECTION = "shares";
    public let TOMBSTONES_COLLECTION = "tombstones";
    public let LIKES_COLLECTION = "likes";
    public let LIKE_BATCHES_COLLECTION = "like_batches";
    public let LIKE_HEADS_COLLECTION = "like_heads";
    public let REPLY_INDEXES_COLLECTION = "reply_indexes";
    public let PROFILE_COLLECTION = "profile";

    // This is the only kernel identity Wagyu must retain for later CAS. Stage
    // geometry and block hashes belong to reconciliation receipts and are not
    // fabricated after application state is restored.
    public type StoredIdentity = {
        target : Caps.Target;
        kernel_revision : Nat64;
        content_tag : Blob;
        body_bytes : Nat;
    };

    public func validNonce(value : Blob) : Bool {
        value.size() == 16;
    };

    public func validDigest(value : Blob) : Bool {
        value.size() == 32;
    };

    public func immutableTarget(
        collection : Text,
        collectionGeneration : Nat64,
        digest : Blob,
    ) : Caps.Target {
        {
            collection;
            collection_generation = collectionGeneration;
            locator = #body_sha256({ digest });
        };
    };

    public func likeHeadTarget(
        collectionGeneration : Nat64,
        postId : Blob,
    ) : Caps.Target {
        {
            collection = LIKE_HEADS_COLLECTION;
            collection_generation = collectionGeneration;
            locator = #key32({ key = postId });
        };
    };

    public func replyIndexTarget(
        collectionGeneration : Nat64,
        postId : Blob,
    ) : Caps.Target {
        {
            collection = REPLY_INDEXES_COLLECTION;
            collection_generation = collectionGeneration;
            locator = #key32({ key = postId });
        };
    };

    public func profileTarget(collectionGeneration : Nat64) : Caps.Target {
        {
            collection = PROFILE_COLLECTION;
            collection_generation = collectionGeneration;
            locator = #exact_path;
        };
    };

    public func put(
        target : Caps.Target,
        condition : Caps.Condition,
        body : Caps.BodySource,
    ) : Caps.BatchOperation {
        #put({
            target;
            condition;
            body;
        });
    };

    public func presentAfter(
        target : Caps.Target,
        digest : Blob,
    ) : Caps.PresentRequirement {
        {
            target;
            content_tag = digest;
            revision = ?1;
        };
    };

    public func stored(
        identity : Caps.RecordIdentity
    ) : StoredIdentity {
        {
            target = identity.target;
            kernel_revision = identity.kernel_revision;
            content_tag = identity.content_tag;
            body_bytes = identity.body_bytes;
        };
    };

    public func cas(identity : StoredIdentity) : Caps.Condition {
        #match({
            revision = identity.kernel_revision;
            content_tag = identity.content_tag;
        });
    };

    public func sameTarget(left : Caps.Target, right : Caps.Target) : Bool {
        left.collection == right.collection and
        left.collection_generation == right.collection_generation and
        sameLocator(left.locator, right.locator);
    };

    public func committedAt(
        receipt : Caps.BatchReceipt,
        requestIndex : Nat,
        expectedTarget : Caps.Target,
        expectedContentTag : Blob,
        expectedBodyBytes : Nat,
    ) : ?Caps.RecordIdentity {
        if (requestIndex >= receipt.operations.size()) return null;
        switch (receipt.operations[requestIndex]) {
            case (#delete(_)) null;
            case (#put(value)) {
                if (
                    Nat32.toNat(value.request_index) != requestIndex or
                    not sameTarget(
                        value.lifecycle.committed.target,
                        expectedTarget,
                    ) or
                    not Blob.equal(
                        value.lifecycle.committed.content_tag,
                        expectedContentTag,
                    ) or
                    value.lifecycle.committed.body_bytes != expectedBodyBytes
                ) {
                    return null;
                };
                ?value.lifecycle.committed;
            };
        };
    };

    func sameLocator(left : Caps.Locator, right : Caps.Locator) : Bool {
        switch (left, right) {
            case (
                #body_sha256(leftValue),
                #body_sha256(rightValue),
            ) {
                Blob.equal(leftValue.digest, rightValue.digest);
            };
            case (#key32(leftValue), #key32(rightValue)) {
                Blob.equal(leftValue.key, rightValue.key);
            };
            case (#exact_path, #exact_path) true;
            case (
                #publication(leftValue),
                #publication(rightValue),
            ) {
                Blob.equal(
                    leftValue.publication_id,
                    rightValue.publication_id,
                ) and
                leftValue.filename == rightValue.filename;
            };
            case (_) false;
        };
    };
};
