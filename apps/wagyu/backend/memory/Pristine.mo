import Map "mo:core/Map";
import Runtime "mo:core/Runtime";

import Memory "./wagyu/v3";

module {
    // A fresh installation context may be bound only to the exact state
    // produced by Memory.init(). This is deliberately exhaustive:
    // #uninitialized is a lifecycle marker, not authority to relabel unrelated
    // durable data.
    public func isPristineForBinding(mem : Memory.Mem) : Bool {
        switch (mem.installation) {
            case (#uninitialized) {};
            case (_) return false;
        };
        switch (mem.profile) {
            case null {};
            case (_) return false;
        };

        let pristine = Memory.init();
        if (
            mem.quota_limits != pristine.quota_limits or
            mem.protocol_limits != pristine.protocol_limits or
            mem.retention != pristine.retention or
            mem.state_revision != 0 or
            mem.relationship_revision != 0 or
            mem.follower_revision != 0 or
            mem.feed_revision != 0 or
            mem.notification_revision != 0 or
            mem.author_sequence != 0 or
            mem.feed_sequence != 0 or
            mem.notification_sequence != 0 or
            mem.outbox_sequence != 0 or
            mem.accepted_like_sequence != 0 or
            mem.follower_registration_sequence != 0 or
            mem.fanout_sequence != 0 or
            mem.publication_sequence != 0 or
            mem.retention_sequence != 0 or
            mem.cleanup_epoch != 0 or
            mem.outbox_control.revision != 0 or
            mem.outbox_control.pause != null or
            mem.scheduler.running or
            mem.scheduler.run_generation != 0 or
            mem.scheduler.started_at_ns != null or
            mem.scheduler.outbox_after_sequence != null or
            mem.scheduler.fanout_after_job_id != null or
            mem.scheduler.like_seal_after_post_key != null or
            mem.active_stage_publication != null
        ) return false;

        if (
            Map.size(mem.following) != 0 or
            Map.size(mem.locally_verified_delivery_counts) != 0 or
            Map.size(mem.followers) != 0 or
            Map.size(mem.followers_by_registration) != 0 or
            Map.size(mem.blocks) != 0 or
            Map.size(mem.authored_posts) != 0 or
            Map.size(mem.authored_post_by_nonce) != 0 or
            Map.size(mem.authored_post_order) != 0 or
            Map.size(mem.authored_actions) != 0 or
            Map.size(mem.authored_action_order) != 0 or
            Map.size(mem.shares_by_original_post) != 0 or
            Map.size(mem.outgoing_likes_by_post) != 0 or
            Map.size(mem.tombstones_by_post) != 0 or
            Map.size(mem.feed_candidates) != 0 or
            Map.size(mem.feed_candidates_by_claimed_slot) != 0 or
            Map.size(mem.feed_order) != 0 or
            Map.size(mem.unread_feed_candidates) != 0 or
            Map.size(mem.candidate_pressure_by_sender) != 0 or
            Map.size(mem.verified_feed) != 0 or
            Map.size(mem.verified_feed_by_post_slot) != 0 or
            Map.size(mem.share_attributions) != 0 or
            Map.size(mem.suppressions) != 0 or
            Map.size(mem.tombstone_relays) != 0 or
            Map.size(mem.notifications) != 0 or
            Map.size(mem.notification_order) != 0 or
            Map.size(mem.notification_evidence) != 0 or
            Map.size(mem.notification_by_semantic) != 0 or
            Map.size(mem.unread_notifications) != 0 or
            Map.size(mem.notice_semantics) != 0 or
            Map.size(mem.notice_pressure_by_caller) != 0 or
            Map.size(mem.notice_count_by_target) != 0 or
            Map.size(mem.accepted_likes) != 0 or
            Map.size(mem.accepted_likes_by_sequence) != 0 or
            Map.size(mem.accepted_like_count_by_post) != 0 or
            Map.size(mem.like_states) != 0 or
            Map.size(mem.like_heads) != 0 or
            Map.size(mem.reply_indexes) != 0 or
            Map.size(mem.sealed_like_batches) != 0 or
            Map.size(mem.sealed_batches_by_post_number) != 0 or
            Map.size(mem.ingress_receipts) != 0 or
            Map.size(mem.caller_rate_windows) != 0 or
            Map.size(mem.outbox) != 0 or
            Map.size(mem.outbox_metadata) != 0 or
            Map.size(mem.outbox_by_retry_time) != 0 or
            Map.size(mem.outbox_by_operation) != 0 or
            Map.size(mem.fanout_jobs) != 0 or
            Map.size(mem.fanout_targets) != 0 or
            Map.size(mem.fanout_target_count_by_job) != 0 or
            Map.size(mem.authored_dependency_count_by_key) != 0 or
            Map.size(mem.certified_collections) != 0 or
            Map.size(mem.certified_records) != 0 or
            Map.size(mem.certified_record_by_local_object) != 0 or
            Map.size(mem.publications) != 0 or
            Map.size(mem.publication_by_nonce) != 0 or
            Map.size(mem.publication_by_target) != 0 or
            Map.size(mem.publication_reconcile_order) != 0 or
            Map.size(mem.retention_order) != 0 or
            Map.size(mem.retention_current) != 0
        ) return false;

        mem.following_count == 0 and
        mem.follower_head_count == 0 and
        mem.follower_head_bytes == 0 and
        mem.active_follower_count == 0 and
        mem.block_count == 0 and
        mem.authored_post_count == 0 and
        mem.authored_action_count == 0 and
        mem.authored_bytes == 0 and
        mem.candidate_count == 0 and
        mem.candidate_bytes == 0 and
        mem.verified_feed_count == 0 and
        mem.verified_feed_bytes == 0 and
        mem.share_attribution_count == 0 and
        mem.share_attribution_bytes == 0 and
        mem.suppression_count == 0 and
        mem.suppression_bytes == 0 and
        mem.tombstone_relay_count == 0 and
        mem.tombstone_relay_bytes == 0 and
        mem.unread_feed_count == 0 and
        mem.notification_count == 0 and
        mem.notification_bytes == 0 and
        mem.unread_notification_count == 0 and
        mem.accepted_like_count == 0 and
        mem.accepted_like_bytes == 0 and
        mem.outbox_count == 0 and
        mem.outbox_bytes == 0 and
        mem.caller_rate_window_count == 0 and
        mem.caller_rate_window_bytes == 0 and
        mem.fanout_job_count == 0 and
        mem.fanout_target_count == 0 and
        mem.fanout_bytes == 0 and
        mem.ingress_receipt_count == 0 and
        mem.ingress_receipt_bytes == 0 and
        mem.certified_object_count == 0 and
        mem.certified_object_bytes == 0 and
        mem.publication_receipt_count == 0 and
        mem.publication_receipt_bytes == 0 and
        mem.revocation_receipt_count == 0 and
        mem.revocation_receipt_bytes == 0;
    };

    public func assertForBinding(mem : Memory.Mem) {
        if (not isPristineForBinding(mem)) {
            Runtime.trap(
                "Wagyu refuses to bind non-pristine durable state"
            );
        };
    };
};
