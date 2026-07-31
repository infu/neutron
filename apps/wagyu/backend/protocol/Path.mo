import Blob "mo:core/Blob";
import Char "mo:core/Char";
import Iter "mo:core/Iter";
import List "mo:core/List";
import Nat32 "mo:core/Nat32";
import Nat8 "mo:core/Nat8";
import Text "mo:core/Text";
import VarArray "mo:core/VarArray";

import Bounds "./Bounds";
import Types "./Types";

module {
    public let PROTOCOL_ROOT : Text =
        "/app/wagyu/_route/protocol/v1";
    public let OBJECT_ROOT : Text =
        "/app/wagyu/_route/protocol/v1/objects";
    public let PROFILE : Text =
        "/app/wagyu/_route/protocol/v1/profile";
    public let LIKE_HEAD_ROOT : Text =
        "/app/wagyu/_route/protocol/v1/heads/likes";
    public let REPLY_INDEX_ROOT : Text =
        "/app/wagyu/_route/protocol/v1/heads/replies";

    let HEX : [Char] = [
        '0', '1', '2', '3', '4', '5', '6', '7',
        '8', '9', 'a', 'b', 'c', 'd', 'e', 'f',
    ];

    public func actionKindSegment(kind : Types.ActionKindV1) : Text {
        switch (kind) {
            case (#post) "post";
            case (#share) "share";
            case (#tombstone) "tombstone";
            case (#like) "like";
        };
    };

    public func hexLower(value : Blob) : Text {
        let chars = List.empty<Char>();
        for (byte in value.values()) {
            let number = Nat8.toNat(byte);
            List.add(chars, HEX[number / 16]);
            List.add(chars, HEX[number % 16]);
        };
        Text.fromIter(List.values(chars));
    };

    public func parseLowerHex32(value : Text) : ?Blob {
        let chars = Iter.toArray(value.chars());
        if (chars.size() != Bounds.HASH_BYTES * 2) return null;
        let bytes = VarArray.repeat<Nat8>(0, Bounds.HASH_BYTES);
        var index = 0;
        while (index < Bounds.HASH_BYTES) {
            let ?high = lowerNibble(chars[index * 2]) else return null;
            let ?low = lowerNibble(chars[index * 2 + 1]) else return null;
            bytes[index] := Nat8.fromNat(high * 16 + low);
            index += 1;
        };
        ?Blob.fromArray(VarArray.toArray(bytes));
    };

    public func actionObject(
        kind : Types.ActionKindV1,
        objectDigest : Blob,
    ) : ?Text {
        if (objectDigest.size() != Bounds.HASH_BYTES) return null;
        ?(
            OBJECT_ROOT # "/" # actionKindSegment(kind) #
            "/sha256/" # hexLower(objectDigest)
        );
    };

    public func postObject(objectDigest : Blob) : ?Text {
        actionObject(#post, objectDigest);
    };

    public func shareObject(objectDigest : Blob) : ?Text {
        actionObject(#share, objectDigest);
    };

    public func tombstoneObject(objectDigest : Blob) : ?Text {
        actionObject(#tombstone, objectDigest);
    };

    public func likeObject(objectDigest : Blob) : ?Text {
        actionObject(#like, objectDigest);
    };

    public func likeBatchObject(batchDigest : Blob) : ?Text {
        if (batchDigest.size() != Bounds.HASH_BYTES) return null;
        ?(
            OBJECT_ROOT # "/like-batch/sha256/" #
            hexLower(batchDigest)
        );
    };

    public func likeHead(postId : Blob) : ?Text {
        if (postId.size() != Bounds.HASH_BYTES) return null;
        ?(LIKE_HEAD_ROOT # "/" # hexLower(postId));
    };

    public func replyIndex(postId : Blob) : ?Text {
        if (postId.size() != Bounds.HASH_BYTES) return null;
        ?(REPLY_INDEX_ROOT # "/" # hexLower(postId));
    };

    public func noticeActorObject(
        relation : Types.NoticeRelationV1,
        objectDigest : Blob,
    ) : ?Text {
        switch (relation) {
            case (#reply) postObject(objectDigest);
            case (#share) shareObject(objectDigest);
        };
    };

    public func isExactActionObject(
        path : Text,
        kind : Types.ActionKindV1,
        objectDigest : Blob,
    ) : Bool {
        switch (actionObject(kind, objectDigest)) {
            case (?expected) path == expected;
            case null false;
        };
    };

    public func isExactLikeBatchObject(
        path : Text,
        batchDigest : Blob,
    ) : Bool {
        switch (likeBatchObject(batchDigest)) {
            case (?expected) path == expected;
            case null false;
        };
    };

    public func isExactLikeHead(path : Text, postId : Blob) : Bool {
        switch (likeHead(postId)) {
            case (?expected) path == expected;
            case null false;
        };
    };

    func lowerNibble(value : Char) : ?Nat {
        if (value >= '0' and value <= '9') {
            return ?(
                Nat32.toNat(Char.toNat32(value)) -
                Nat32.toNat(Char.toNat32('0'))
            );
        };
        if (value >= 'a' and value <= 'f') {
            return ?(
                10 + Nat32.toNat(Char.toNat32(value)) -
                Nat32.toNat(Char.toNat32('a'))
            );
        };
        null;
    };
};
