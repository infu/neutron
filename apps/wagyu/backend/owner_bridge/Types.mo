import Blob "mo:core/Blob";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Text "mo:core/Text";

import Protocol "../protocol/Types";

// Owner-call boundary types.
//
// Fixed binary identifiers remain lowercase Text where that makes the UI
// contract explicit. Exact certified bytes are ordinary Blob fields in their
// containing API-1 request records.
module {
    public type LocalErrorV1 = {
        #not_configured;
        #invalid;
        #conflict;
        #not_found;
        #full;
        #certified_store;
        #proof_invalid;
        #unsupported;
        #busy;
    };

    public type PublishStageV1 = {
        #awaiting_proof;
        #certified_ref_ready;
        #fanout_queued;
        #complete;
        #partial;
        #failed;
        #uncertain;
    };

    public type CanonicalPublishResultV1 = {
        stage : ?PublishStageV1;
        post_id : ?Blob;
        action_id : ?Blob;
        object_digest : ?Blob;
        queued_recipient_count : Nat32;
        queued_notice_count : Nat32;
        accepted_recipient_count : Nat32;
        failed_recipient_count : Nat32;
        message : Text;
    };

    public type PublishSelfResultV1 = {
        stage : ?PublishStageV1;
        post_id_hex : ?Text;
        action_id_hex : ?Text;
        object_digest_hex : ?Text;
        queued_recipient_count : Nat32;
        queued_notice_count : Nat32;
        accepted_recipient_count : Nat32;
        failed_recipient_count : Nat32;
        message : Text;
    };

    public type CanonicalPublishLocalResultV1 = {
        #ok : CanonicalPublishResultV1;
        #err : LocalErrorV1;
    };

    public type PublishSelfLocalResultV1 = {
        #ok : PublishSelfResultV1;
        #err : LocalErrorV1;
    };

    public type FeedPageSelfValueV1 = {
        revision : Nat64;
        item_count : Nat16;
        body_bytes : Nat32;
        body_digest_hex : Text;
    };

    public type FeedPageSelfOutputV1 = {
        value : FeedPageSelfValueV1;
        body : Blob;
    };

    public type NotificationPageSelfValueV1 = {
        revision : Nat64;
        item_count : Nat16;
        body_bytes : Nat32;
        body_digest_hex : Text;
    };

    public type NotificationPageSelfOutputV1 = {
        value : NotificationPageSelfValueV1;
        body : Blob;
    };

    public type NotificationEvidenceSelfValueV1 = {
        local_sequence : Nat64;
        found : Bool;
        body_bytes : Nat32;
        body_digest_hex : Text;
    };

    public type NotificationEvidenceSelfOutputV1 = {
        value : NotificationEvidenceSelfValueV1;
        body : Blob;
    };

    public type FollowSelfRequestV1 = {
        node : Principal;
        subscription_id_hex : Text;
    };

    public type FollowInputV1 = {
        node : Principal;
        subscription_id : Blob;
    };

    public type ReplyLocatorSelfV1 = {
        author : Principal;
        post_id_hex : Text;
        body_hash_hex : Text;
        body_length : Nat32;
        object_digest_hex : Text;
    };

    public type PostPrepareSelfRequestV1 = {
        body_markdown : Text;
        nonce_hex : Text;
        reply_to : ?ReplyLocatorSelfV1;
    };

    public type PostPrepareInputV1 = {
        body_markdown : Text;
        nonce : Blob;
        reply_to : ?Protocol.ReplyToV1;
    };

    public type SharePrepareSelfRequestV1 = {
        nonce_hex : ?Text;
        exact_original_post_ref_candid : Blob;
    };

    public type SharePrepareInputV1 = {
        nonce : ?Blob;
        original_post_ref : Protocol.CertifiedPostRefV1;
        original_post_ref_digest : Blob;
        exact_original_post_ref_candid : Blob;
    };

    public type LikePrepareSelfRequestV1 = {
        post_author : Principal;
        post_id_hex : Text;
        post_body_hash_hex : Text;
        post_object_digest_hex : ?Text;
        nonce_hex : Text;
    };

    public type LikePrepareInputV1 = {
        post_author : Principal;
        post_id : Blob;
        post_body_hash : Blob;
        post_object_digest : ?Blob;
        nonce : Blob;
    };

    public type TombstonePrepareSelfRequestV1 = {
        post_id_hex : Text;
        nonce_hex : Text;
    };

    public type TombstonePrepareInputV1 = {
        post_id : Blob;
        nonce : Blob;
    };

    public type FinalizeSelfRequestV1 = {
        action_id_hex : Text;
        object_digest_hex : Text;
        exact_proof_candid : Blob;
    };

    public type FinalizeInputV1 = {
        action_kind : Protocol.ActionKindV1;
        action_id : Blob;
        object_digest : Blob;
        proof : Protocol.CertifiedHttpProofV1;
        proof_digest : Blob;
        exact_proof_candid : Blob;
    };

    public type FeedPromoteSelfRequestV1 = {
        candidate_id_hex : Text;
        verified_author : Principal;
        verified_post_id_hex : Text;
        verified_body_hash_hex : Text;
        verified_object_digest_hex : Text;
    };

    public type FeedPromoteInputV1 = {
        candidate_id : Blob;
        verified_author : Principal;
        verified_post_id : Blob;
        verified_body_hash : Blob;
        verified_object_digest : Blob;
    };

    public type FeedRejectDispositionV1 = {
        #invalid;
        #unavailable;
    };

    public type FeedRejectSelfRequestV1 = {
        candidate_id_hex : Text;
        disposition : ?FeedRejectDispositionV1;
    };

    public type FeedRejectInputV1 = {
        candidate_id : Blob;
        disposition : FeedRejectDispositionV1;
    };

    public type NotificationDispositionV1 = {
        #verified;
        #invalid;
        #unavailable;
    };

    public type VerifiedReplySelfV1 = {
        author : Principal;
        post_id_hex : Text;
        body_hash_hex : Text;
        body_length : Nat32;
        object_digest_hex : Text;
        reply_to : ReplyLocatorSelfV1;
    };

    public type VerifiedReplyInputV1 = {
        author : Principal;
        post_id : Blob;
        body_hash : Blob;
        body_length : Nat32;
        object_digest : Blob;
        reply_to : Protocol.ReplyToV1;
    };

    public type NotificationPromoteSelfRequestV1 = {
        local_sequence : Nat64;
        disposition : ?NotificationDispositionV1;
        verified_reply : ?VerifiedReplySelfV1;
    };

    public type NotificationPromoteInputV1 = {
        local_sequence : Nat64;
        disposition : NotificationDispositionV1;
        verified_reply : ?VerifiedReplyInputV1;
    };

    public type LikeSealSelfRequestV1 = {
        post_id_hex : Text;
        final_partial : Bool;
    };

    public type LikeSealInputV1 = {
        post_id : Blob;
        final_partial : Bool;
    };

    public type WithdrawalAdvanceSelfRequestV1 = {
        post_id_hex : Text;
        nonce_hex : Text;
    };

    public type WithdrawalAdvanceInputV1 = {
        post_id : Blob;
        nonce : Blob;
    };
};
