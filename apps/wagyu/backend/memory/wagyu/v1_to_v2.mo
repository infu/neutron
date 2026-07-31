import Map "mo:core/Map";

import V1 "./v1";
import V2 "./v2";

module {
    public func migrate(old : V1.Mem) : V2.Mem {
        let protocolLimits : V2.ProtocolLimits = {
            profile_body_bytes = old.protocol_limits.profile_body_bytes;
            profile_avatar_bytes = old.protocol_limits.profile_avatar_bytes;
            post_body_bytes = old.protocol_limits.post_body_bytes;
            immutable_action_bytes =
                old.protocol_limits.immutable_action_bytes;
            like_batch_bytes = old.protocol_limits.like_batch_bytes;
            like_head_bytes = old.protocol_limits.like_head_bytes;
            reply_index_bytes = 1_044_480;
            proof_snapshot_bytes = old.protocol_limits.proof_snapshot_bytes;
            certified_like_receipt_bytes =
                old.protocol_limits.certified_like_receipt_bytes;
            delivery_request_bytes =
                old.protocol_limits.delivery_request_bytes;
            publication_batch_objects =
                old.protocol_limits.publication_batch_objects;
            publication_batch_bytes =
                old.protocol_limits.publication_batch_bytes;
            staged_block_bytes = old.protocol_limits.staged_block_bytes;
            staged_block_count = old.protocol_limits.staged_block_count;
            like_batch_receipts =
                old.protocol_limits.like_batch_receipts;
            active_like_receipts =
                old.protocol_limits.active_like_receipts;
            fanout_call_batch = old.protocol_limits.fanout_call_batch;
        };
        {
            old with
            protocol_limits = protocolLimits;
            reply_indexes = Map.empty<V2.StableKey, V2.ReplyIndexState>();
        };
    };
};
