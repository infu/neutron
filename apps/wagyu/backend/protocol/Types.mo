import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Text "mo:core/Text";

// Frozen Wagyu V1 Candid-oriented runtime aliases.
//
// Variants intended to grow within V1 are always carried through an optional
// field. An older decoder therefore observes an unknown future tag as `null`
// at that field instead of losing the surrounding record.
module {
    public type ActionKindV1 = {
        #post;
        #share;
        #tombstone;
        #like;
    };

    public type ActionHeaderV1 = {
        network_id : Blob;
        // Motoko's trailing underscore escapes the keyword while Candid
        // exports the exact field label `actor`.
        actor_ : Principal;
        action_kind : ?ActionKindV1;
    };

    public type CertifiedHttpProofV1 = {
        certificate_version : Nat8;
        certificate_cbor : Blob;
        witness_cbor : Blob;
        expression_path_cbor : Blob;
        certificate_time_ns : Nat64;
    };

    public type CertifiedActionRefV1 = {
        actor_ : Principal;
        action_kind : ?ActionKindV1;
        object_digest : Blob;
        body_length : Nat32;
        proof_snapshot : CertifiedHttpProofV1;
    };

    public type ReplyToV1 = {
        author : Principal;
        post_id : Blob;
        body_hash : Blob;
        body_length : Nat32;
        object_digest : Blob;
    };

    public type PostBodyV1 = {
        header : ActionHeaderV1;
        author_sequence : Nat64;
        nonce : Blob;
        created_at_ns : Nat64;
        body_markdown : Text;
        reply_to : ?ReplyToV1;
    };

    public type ReplyIndexEntryV1 = {
        author : Principal;
        post_id : Blob;
        object_digest : Blob;
        object_length : Nat32;
        received_at_ns : Nat64;
    };

    public type ReplyIndexV1 = {
        network_id : Blob;
        post_author : Principal;
        post_id : Blob;
        post_body_hash : Blob;
        store_generation : Nat64;
        revision : Nat64;
        previous_index_hash : ?Blob;
        replies : [ReplyIndexEntryV1];
    };

    public type CertifiedPostRefV1 = {
        author : Principal;
        post_id : Blob;
        body_hash : Blob;
        body_length : Nat32;
        object_digest : Blob;
        proof : CertifiedHttpProofV1;
    };

    public type ShareActionV1 = {
        header : ActionHeaderV1;
        share_id : Blob;
        share_sequence : Nat64;
        issued_at_ns : Nat64;
        original_author : Principal;
        original_post_id : Blob;
        original_body_hash : Blob;
        post_ref_digest : Blob;
    };

    public type CertifiedShareRefV1 = {
        sharer : Principal;
        share_id : Blob;
        body_length : Nat32;
        object_digest : Blob;
        proof : CertifiedHttpProofV1;
    };

    public type CertifiedShareDeliveryV1 = {
        original_post_ref_candid : Blob;
        share_action_candid : Blob;
        share_ref : CertifiedShareRefV1;
    };

    public type LikeActionV1 = {
        header : ActionHeaderV1;
        like_id : Blob;
        issued_at_ns : Nat64;
        post_author : Principal;
        post_id : Blob;
        post_body_hash : Blob;
    };

    public type CertifiedLikeReceiptV1 = {
        like_action_candid : Blob;
        ref : CertifiedActionRefV1;
    };

    public type AvatarMediaTypeV1 = {
        #jpeg;
        #png;
        #webp;
    };

    public type AvatarV1 = {
        media_type : ?AvatarMediaTypeV1;
        width : Nat16;
        height : Nat16;
        bytes : Blob;
    };

    public type ProfileV1 = {
        network_id : Blob;
        node : Principal;
        profile_generation : Nat64;
        revision : Nat64;
        updated_at_ns : Nat64;
        previous_profile_digest : ?Blob;
        display_name : Text;
        description : Text;
        capabilities : ?[Text];
        avatar : ?AvatarV1;
    };

    public type TombstoneActionV1 = {
        header : ActionHeaderV1;
        tombstone_id : Blob;
        author_sequence : Nat64;
        issued_at_ns : Nat64;
        post_id : Blob;
        post_body_hash : Blob;
    };

    public type CertifiedTombstoneV1 = {
        tombstone_action_candid : Blob;
        ref : CertifiedActionRefV1;
    };

    public type PublicIngressRequestV1 = {
        method : Text;
        payload : Blob;
    };

    // This closed error/result pair mirrors neutron-capabilities exactly.
    public type PublicIngressErrorV1 = {
        #bad_request;
        #not_found;
        #too_large;
        #unauthorized;
        #rate_limited;
        #busy;
        #low_cycles;
        #revoked;
        #revoked_after_dispatch;
        #handler_failed;
    };

    public type PublicIngressResultV1 = {
        #ok : Blob;
        #err : PublicIngressErrorV1;
    };

    public type WagyuIngressV1 = {
        operation_id : Blob;
        body_candid : Blob;
    };

    public type FollowBodyV1 = {
        expected_revision : Nat64;
        subscription_id : Blob;
    };

    public type UnfollowBodyV1 = {
        expected_revision : Nat64;
        subscription_id : Blob;
    };

    public type DeliveryEventV1 = {
        #original : Blob;
        #share : Blob;
        #tombstone : Blob;
    };

    public type DeliverBodyV1 = {
        subscription_id : Blob;
        renewal_requested : Bool;
        event : ?DeliveryEventV1;
    };

    public type LikeBodyV1 = {
        certified_like_receipt_candid : Blob;
    };

    public type NoticeRelationV1 = {
        #reply;
        #share;
    };

    public type NoticeBodyV1 = {
        relation : ?NoticeRelationV1;
        target_post_id : Blob;
        target_body_hash : Blob;
        actor_action_id : Blob;
        actor_object_digest : Blob;
        actor_object_length : Nat32;
    };

    public type FollowerStateV1 = {
        #active : {
            subscription_id : Blob;
            lease_expires_ns : Nat64;
            delivery_credits : Nat16;
        };
        #inactive : {
            last_subscription_id : Blob;
        };
    };

    public type FollowerHeadV1 = {
        revision : Nat64;
        state : ?FollowerStateV1;
    };

    public type RouteRejectionReasonV1 = {
        #invalid;
        #blocked;
        #not_following;
        #unknown_post;
        #expired;
        #full;
        #conflict;
        #incompatible;
    };

    public type RouteOutcomeV1 = {
        #accepted;
        #duplicate;
        #rejected : {
            reason : ?RouteRejectionReasonV1;
        };
    };

    public type WagyuRouteResultV1 = {
        outcome : ?RouteOutcomeV1;
        local_receipt_time_ns : ?Nat64;
        revision : ?Nat64;
        relationship : ?FollowerHeadV1;
    };

    public type FeedPageRequestV1 = {
        before_sequence : ?Nat64;
        limit : Nat16;
    };

    public type FeedEventKindV1 = {
        #original;
        #share;
        #tombstone;
    };

    public type VerificationStateV1 = {
        #pending;
        #verified;
        #invalid;
        #unavailable;
    };

    public type FeedCandidateSummaryV1 = {
        candidate_id : Blob;
        local_sequence : Nat64;
        received_at_ns : Nat64;
        immediate_sender : Principal;
        event_kind : ?FeedEventKindV1;
        claimed_author : Principal;
        claimed_post_id : Blob;
        exact_event_candid : Blob;
        verification : ?VerificationStateV1;
    };

    public type FeedPageV1 = {
        revision : Nat64;
        items : [FeedCandidateSummaryV1];
        next_before_sequence : ?Nat64;
    };

    public type LikeBatchV1 = {
        network_id : Blob;
        post_author : Principal;
        post_id : Blob;
        post_body_hash : Blob;
        batch_number : Nat64;
        previous_batch_digest : ?Blob;
        first_accepted_sequence : Nat64;
        last_accepted_sequence : Nat64;
        final_partial : Bool;
        receipts : [CertifiedLikeReceiptV1];
    };

    public type LikeHeadV1 = {
        network_id : Blob;
        post_author : Principal;
        post_id : Blob;
        post_body_hash : Blob;
        store_generation : Nat64;
        revision : Nat64;
        previous_head_hash : ?Blob;
        latest_batch_number : ?Nat64;
        latest_batch_digest : ?Blob;
        sealed_batch_count : Nat64;
        sealed_receipt_count : Nat64;
        accepting_likes : Bool;
    };

    public type NotificationKindV1 = {
        #new_follower : {
            follower_revision : Nat64;
        };
        #like : {
            target_post_id : Blob;
            target_body_hash : Blob;
            action_id : Blob;
            object_digest : Blob;
            object_length : Nat32;
        };
        #reply : {
            target_post_id : Blob;
            target_body_hash : Blob;
            action_id : Blob;
            object_digest : Blob;
            object_length : Nat32;
        };
        #share : {
            target_post_id : Blob;
            target_body_hash : Blob;
            action_id : Blob;
            object_digest : Blob;
            object_length : Nat32;
        };
    };

    public type NotificationVerificationV1 = {
        #transport_authenticated;
        #pending;
        #verified;
        #invalid;
        #unavailable;
    };

    public type NotificationSummaryV1 = {
        local_sequence : Nat64;
        received_at_ns : Nat64;
        actor_ : Principal;
        kind : ?NotificationKindV1;
        verification : ?NotificationVerificationV1;
        read : Bool;
    };

    public type NotificationPageRequestV1 = {
        before_sequence : ?Nat64;
        limit : Nat16;
    };

    public type NotificationPageV1 = {
        revision : Nat64;
        items : [NotificationSummaryV1];
        next_before_sequence : ?Nat64;
    };

    public type NotificationEvidenceRequestV1 = {
        local_sequence : Nat64;
    };

    public type NotificationEvidenceV1 = {
        local_sequence : Nat64;
        found : Bool;
        evidence : ?{
            #like : {
                certified_like_receipt_candid : Blob;
            };
        };
    };

    public type ProfileEditAvatarV1 = {
        media_type : ?AvatarMediaTypeV1;
        width : Nat16;
        height : Nat16;
        bytes : Blob;
    };

    public type ProfileEditRequestV1 = {
        expected_profile_generation : Nat64;
        expected_revision : Nat64;
        display_name : Text;
        description : Text;
        avatar : ?ProfileEditAvatarV1;
    };

    public type ProfileEditRejectionReasonV1 = {
        #invalid;
        #full;
        #low_cycles;
    };

    public type ProfileEditOutcomeV1 = {
        #updated : {
            profile_generation : Nat64;
            revision : Nat64;
            body_digest : Blob;
        };
        #conflict : {
            current_generation : Nat64;
            current_revision : Nat64;
        };
        #rejected : {
            reason : ?ProfileEditRejectionReasonV1;
        };
    };

    public type ProfileEditResultV1 = {
        outcome : ?ProfileEditOutcomeV1;
    };

    public type SendKindV1 = {
        #post;
        #reply;
        #share;
        #tombstone;
    };

    public type SendQuoteRequestV1 = {
        send_kind : ?SendKindV1;
        estimated_object_bytes : Nat32;
        notice_target : ?Principal;
    };

    public type SendQuoteV1 = {
        follower_revision : Nat64;
        registered_follower_count : Nat32;
        eligible_delivery_count : Nat32;
        ineligible_follower_count : Nat32;
        eligible_recipient_preview : [Principal];
        receiver_floor_cycles : Nat;
        author_notice_floor_cycles : Nat;
        estimated_call_and_byte_cycles : Nat;
        estimated_local_publication_cycles : Nat;
        estimated_total_cycles : Nat;
    };
};
