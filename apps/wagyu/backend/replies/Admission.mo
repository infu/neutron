import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Principal "mo:core/Principal";

import Bounds "../protocol/Bounds";
import Protocol "../protocol/Types";

// V1 readers retain the frozen 4,096-entry decoding ceiling for compatibility,
// but first-launch Wagyu publishers deliberately expose a much smaller direct
// reply set per parent.
module {
    public let MAX_PUBLISHED_DIRECT_REPLIES : Nat = 100;

    public type Promotion = {
        #append : [Protocol.ReplyIndexEntryV1];
        #duplicate;
        #conflict;
        // The reply is valid and terminally verified, but the bounded public
        // index deliberately omits it.
        #terminal_unindexed;
        #invalid;
    };

    public type Removal = {
        #removed : [Protocol.ReplyIndexEntryV1];
        #unchanged;
    };

    public func promote(
        existing : [Protocol.ReplyIndexEntryV1],
        candidate : Protocol.ReplyIndexEntryV1,
    ) : Promotion {
        if (not validEntry(candidate)) return #invalid;

        for (reply in existing.vals()) {
            if (
                Principal.equal(reply.author, candidate.author) and
                Blob.equal(reply.post_id, candidate.post_id)
            ) {
                if (
                    Blob.equal(
                        reply.object_digest,
                        candidate.object_digest,
                    ) and
                    reply.object_length == candidate.object_length
                ) {
                    return #duplicate;
                };
                return #conflict;
            };
        };
        if (existing.size() >= MAX_PUBLISHED_DIRECT_REPLIES) {
            return #terminal_unindexed;
        };

        let receivedAt = if (existing.size() == 0) {
            candidate.received_at_ns;
        } else {
            let previous = existing[existing.size() - 1];
            if (candidate.received_at_ns < previous.received_at_ns) {
                previous.received_at_ns;
            } else {
                candidate.received_at_ns;
            };
        };
        #append(
            Array.concat<Protocol.ReplyIndexEntryV1>(
                existing,
                [{ candidate with received_at_ns = receivedAt }],
            )
        );
    };

    public func remove(
        existing : [Protocol.ReplyIndexEntryV1],
        author : Principal,
        postId : Blob,
    ) : Removal {
        var found = false;
        let retained = Array.filter<Protocol.ReplyIndexEntryV1>(
            existing,
            func(reply) {
                let matches =
                    Principal.equal(reply.author, author) and
                    Blob.equal(reply.post_id, postId);
                if (matches) found := true;
                not matches;
            },
        );
        if (found) #removed(retained) else #unchanged;
    };

    public func validEntry(
        value : Protocol.ReplyIndexEntryV1
    ) : Bool {
        Principal.isCanister(value.author) and
        value.post_id.size() == Bounds.HASH_BYTES and
        value.object_digest.size() == Bounds.HASH_BYTES and
        Bounds.bodyLengthWithin(value.object_length, #post);
    };
};
