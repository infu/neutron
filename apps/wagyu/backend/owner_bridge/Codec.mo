import Blob "mo:core/Blob";
import Char "mo:core/Char";
import Iter "mo:core/Iter";
import Nat "mo:core/Nat";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import VarArray "mo:core/VarArray";

import Bounds "../protocol/Bounds";
import CandidGuard "../protocol/CandidGuard";
import Hash "../protocol/Hash";
import Path "../protocol/Path";
import Protocol "../protocol/Types";
import Validation "../protocol/Validation";
import Types "./Types";

// Pure validation and conversion helpers for the owner-call bridge.
//
// Opaque Blob fields are hashed before decoding and the exact received bytes
// are returned to the semantic layer. Do not decode/re-encode those bytes to
// reconstruct a proof or certified reference: compatible future optional
// fields may be intentionally unknown to this decoder.
module {
    public let FEED_PAGE_OUTPUT_BYTES : Nat = 614_400;
    public let NOTIFICATION_PAGE_OUTPUT_BYTES : Nat = 131_072;
    public let NOTIFICATION_EVIDENCE_OUTPUT_BYTES : Nat = 8_192;
    public let SHARE_REF_INPUT_BYTES : Nat = 16_384;
    public let PROOF_INPUT_BYTES : Nat = Bounds.MAX_PROOF_CANDID_BYTES;

    public func parseLowerHex16(value : Text) : ?Blob {
        parseLowerHex(value, Bounds.NONCE_BYTES);
    };

    public func parseLowerHex32(value : Text) : ?Blob {
        Path.parseLowerHex32(value);
    };

    public func follow(
        request : Types.FollowSelfRequestV1
    ) : ?Types.FollowInputV1 {
        let ?subscriptionId = parseLowerHex16(
            request.subscription_id_hex
        ) else return null;
        ?{
            node = request.node;
            subscription_id = subscriptionId;
        };
    };

    public func postPrepare(
        request : Types.PostPrepareSelfRequestV1
    ) : ?Types.PostPrepareInputV1 {
        if (
            not Validation.safeText(
                request.body_markdown,
                Bounds.MAX_MARKDOWN_BYTES,
            )
        ) return null;
        let ?nonce = parseLowerHex16(request.nonce_hex) else return null;
        let replyTo : ?Protocol.ReplyToV1 = switch (request.reply_to) {
            case null null;
            case (?value) {
                let ?postId = parseLowerHex32(value.post_id_hex)
                    else return null;
                let ?bodyHash = parseLowerHex32(value.body_hash_hex)
                    else return null;
                let ?objectDigest = parseLowerHex32(
                    value.object_digest_hex
                ) else return null;
                let reply : Protocol.ReplyToV1 = {
                    author = value.author;
                    post_id = postId;
                    body_hash = bodyHash;
                    body_length = value.body_length;
                    object_digest = objectDigest;
                };
                if (not Validation.replyTo(reply)) return null;
                ?reply;
            };
        };
        ?{
            body_markdown = request.body_markdown;
            nonce;
            reply_to = replyTo;
        };
    };

    public func sharePrepare(
        request : Types.SharePrepareSelfRequestV1,
    ) : ?Types.SharePrepareInputV1 {
        let exactCertifiedPostRefCandid =
            request.exact_original_post_ref_candid;
        if (
            exactCertifiedPostRefCandid.size() == 0 or
            exactCertifiedPostRefCandid.size() > SHARE_REF_INPUT_BYTES
        ) return null;

        // Hash the untouched bytes before any type interpretation.
        let exactDigest = Hash.objectDigest(exactCertifiedPostRefCandid);
        if (
            not CandidGuard.validOne(
                exactCertifiedPostRefCandid,
                SHARE_REF_INPUT_BYTES,
            )
        ) return null;
        let decoded : ?Protocol.CertifiedPostRefV1 =
            from_candid exactCertifiedPostRefCandid;
        let ?postRef = decoded else return null;
        if (not Validation.certifiedPostRefValue(postRef)) return null;

        let nonce : ?Blob = switch (request.nonce_hex) {
            case null null;
            case (?value) {
                let ?parsed = parseLowerHex16(value) else return null;
                ?parsed;
            };
        };
        ?{
            nonce;
            original_post_ref = postRef;
            original_post_ref_digest = exactDigest;
            exact_original_post_ref_candid = exactCertifiedPostRefCandid;
        };
    };

    public func likePrepare(
        request : Types.LikePrepareSelfRequestV1
    ) : ?Types.LikePrepareInputV1 {
        let ?postId = parseLowerHex32(request.post_id_hex)
            else return null;
        let ?postBodyHash = parseLowerHex32(
            request.post_body_hash_hex
        ) else return null;
        let postObjectDigest : ?Blob = switch (
            request.post_object_digest_hex
        ) {
            case null null;
            case (?value) {
                let ?parsed = parseLowerHex32(value) else return null;
                ?parsed;
            };
        };
        let ?nonce = parseLowerHex16(request.nonce_hex) else return null;
        ?{
            post_author = request.post_author;
            post_id = postId;
            post_body_hash = postBodyHash;
            post_object_digest = postObjectDigest;
            nonce;
        };
    };

    public func tombstonePrepare(
        request : Types.TombstonePrepareSelfRequestV1
    ) : ?Types.TombstonePrepareInputV1 {
        let ?postId = parseLowerHex32(request.post_id_hex)
            else return null;
        let ?nonce = parseLowerHex16(request.nonce_hex) else return null;
        ?{ post_id = postId; nonce };
    };

    public func finalize(
        actionKind : Protocol.ActionKindV1,
        request : Types.FinalizeSelfRequestV1,
    ) : ?Types.FinalizeInputV1 {
        let exactProofCandid = request.exact_proof_candid;
        let ?actionId = parseLowerHex32(request.action_id_hex)
            else return null;
        let ?objectDigest = parseLowerHex32(
            request.object_digest_hex
        ) else return null;
        if (
            exactProofCandid.size() == 0 or
            exactProofCandid.size() > PROOF_INPUT_BYTES
        ) return null;

        // Preserve this hash and the exact body before decoding. The backend
        // stores/forwards the received proof bytes; it never reconstructs
        // proof evidence from the decoded value.
        let exactDigest = Hash.objectDigest(exactProofCandid);
        if (
            not CandidGuard.validOne(
                exactProofCandid,
                PROOF_INPUT_BYTES,
            )
        ) return null;
        let decoded : ?Protocol.CertifiedHttpProofV1 =
            from_candid exactProofCandid;
        let ?proof = decoded else return null;
        if (
            not Validation.certifiedHttpProof(
                proof,
                exactProofCandid.size(),
            )
        ) return null;
        ?{
            action_kind = actionKind;
            action_id = actionId;
            object_digest = objectDigest;
            proof;
            proof_digest = exactDigest;
            exact_proof_candid = exactProofCandid;
        };
    };

    public func feedPromote(
        request : Types.FeedPromoteSelfRequestV1
    ) : ?Types.FeedPromoteInputV1 {
        let ?candidateId = parseLowerHex32(request.candidate_id_hex)
            else return null;
        let ?postId = parseLowerHex32(request.verified_post_id_hex)
            else return null;
        let ?bodyHash = parseLowerHex32(request.verified_body_hash_hex)
            else return null;
        let ?objectDigest = parseLowerHex32(
            request.verified_object_digest_hex
        ) else return null;
        ?{
            candidate_id = candidateId;
            verified_author = request.verified_author;
            verified_post_id = postId;
            verified_body_hash = bodyHash;
            verified_object_digest = objectDigest;
        };
    };

    public func feedReject(
        request : Types.FeedRejectSelfRequestV1
    ) : ?Types.FeedRejectInputV1 {
        let ?candidateId = parseLowerHex32(request.candidate_id_hex)
            else return null;
        let ?disposition = request.disposition else return null;
        ?{ candidate_id = candidateId; disposition };
    };

    public func notificationPromote(
        request : Types.NotificationPromoteSelfRequestV1
    ) : ?Types.NotificationPromoteInputV1 {
        let ?disposition = request.disposition else return null;
        let verifiedReply : ?Types.VerifiedReplyInputV1 = switch (
            request.verified_reply
        ) {
            case null null;
            case (?value) {
                let ?postId = parseLowerHex32(value.post_id_hex)
                    else return null;
                let ?bodyHash = parseLowerHex32(value.body_hash_hex)
                    else return null;
                let ?objectDigest = parseLowerHex32(
                    value.object_digest_hex
                ) else return null;
                let parent = value.reply_to;
                let ?parentPostId = parseLowerHex32(parent.post_id_hex)
                    else return null;
                let ?parentBodyHash = parseLowerHex32(
                    parent.body_hash_hex
                ) else return null;
                let ?parentObjectDigest = parseLowerHex32(
                    parent.object_digest_hex
                ) else return null;
                let replyTo : Protocol.ReplyToV1 = {
                    author = parent.author;
                    post_id = parentPostId;
                    body_hash = parentBodyHash;
                    body_length = parent.body_length;
                    object_digest = parentObjectDigest;
                };
                if (
                    not Principal.isCanister(value.author) or
                    not Bounds.bodyLengthWithin(value.body_length, #post) or
                    not Validation.replyTo(replyTo)
                ) return null;
                ?{
                    author = value.author;
                    post_id = postId;
                    body_hash = bodyHash;
                    body_length = value.body_length;
                    object_digest = objectDigest;
                    reply_to = replyTo;
                };
            };
        };
        switch (disposition, verifiedReply) {
            case (#verified, ?_) {};
            case (#verified, null) {};
            case (#invalid or #unavailable, null) {};
            case (#invalid or #unavailable, ?_) return null;
        };
        ?{
            local_sequence = request.local_sequence;
            disposition;
            verified_reply = verifiedReply;
        };
    };

    public func likeSeal(
        request : Types.LikeSealSelfRequestV1
    ) : ?Types.LikeSealInputV1 {
        let ?postId = parseLowerHex32(request.post_id_hex)
            else return null;
        ?{ post_id = postId; final_partial = request.final_partial };
    };

    public func withdrawalAdvance(
        request : Types.WithdrawalAdvanceSelfRequestV1
    ) : ?Types.WithdrawalAdvanceInputV1 {
        let ?postId = parseLowerHex32(request.post_id_hex)
            else return null;
        let ?nonce = parseLowerHex16(request.nonce_hex) else return null;
        ?{ post_id = postId; nonce };
    };

    public func publishResult(
        result : Types.CanonicalPublishLocalResultV1
    ) : ?Types.PublishSelfLocalResultV1 {
        switch (result) {
            case (#err(error)) ?#err(error);
            case (#ok(value)) {
                let ?postIdHex = optionalHex32(value.post_id)
                    else return null;
                let ?actionIdHex = optionalHex32(value.action_id)
                    else return null;
                let ?objectDigestHex = optionalHex32(value.object_digest)
                    else return null;
                ?#ok({
                    stage = value.stage;
                    post_id_hex = postIdHex;
                    action_id_hex = actionIdHex;
                    object_digest_hex = objectDigestHex;
                    queued_recipient_count =
                        value.queued_recipient_count;
                    queued_notice_count = value.queued_notice_count;
                    accepted_recipient_count =
                        value.accepted_recipient_count;
                    failed_recipient_count =
                        value.failed_recipient_count;
                    message = value.message;
                });
            };
        };
    };

    public func feedPageOutput(
        page : Protocol.FeedPageV1
    ) : ?Types.FeedPageSelfOutputV1 {
        if (page.items.size() > Bounds.MAX_FEED_PAGE_ITEMS) return null;
        var eventBytes : Nat = 0;
        for (item in page.items.values()) {
            if (
                not Validation.blob32(item.candidate_id) or
                not Validation.blob32(item.claimed_post_id) or
                item.exact_event_candid.size() == 0 or
                item.exact_event_candid.size() >
                    Bounds.MAX_FEED_PAGE_EVENT_BYTES - eventBytes
            ) return null;
            eventBytes += item.exact_event_candid.size();
        };
        let body = to_candid (page);
        if (body.size() > FEED_PAGE_OUTPUT_BYTES) return null;
        ?{
            value = {
                revision = page.revision;
                item_count = Nat16.fromNat(page.items.size());
                body_bytes = Nat32.fromNat(body.size());
                body_digest_hex = Path.hexLower(
                    Hash.objectDigest(body)
                );
            };
            body;
        };
    };

    public func notificationPageOutput(
        page : Protocol.NotificationPageV1
    ) : ?Types.NotificationPageSelfOutputV1 {
        if (
            page.items.size() > Bounds.MAX_NOTIFICATION_PAGE_ITEMS
        ) return null;
        for (item in page.items.values()) {
            switch (item.kind) {
                case null {};
                case (?#new_follower(_)) {};
                case (?#like(value)) {
                    if (not validDirectedAction(value)) return null;
                };
                case (?#reply(value)) {
                    if (not validDirectedAction(value)) return null;
                };
                case (?#share(value)) {
                    if (not validDirectedAction(value)) return null;
                };
            };
        };
        let body = to_candid (page);
        if (body.size() > NOTIFICATION_PAGE_OUTPUT_BYTES) return null;
        ?{
            value = {
                revision = page.revision;
                item_count = Nat16.fromNat(page.items.size());
                body_bytes = Nat32.fromNat(body.size());
                body_digest_hex = Path.hexLower(
                    Hash.objectDigest(body)
                );
            };
            body;
        };
    };

    public func notificationEvidenceOutput(
        evidence : Protocol.NotificationEvidenceV1
    ) : ?Types.NotificationEvidenceSelfOutputV1 {
        switch (evidence.evidence) {
            case null {
                if (evidence.found) return null;
            };
            case (?#like(value)) {
                if (
                    not evidence.found or
                    value.certified_like_receipt_candid.size() == 0 or
                    value.certified_like_receipt_candid.size() >
                        Bounds.MAX_LIKE_RECEIPT_CANDID_BYTES
                ) return null;
            };
        };
        let body = to_candid (evidence);
        if (
            body.size() > NOTIFICATION_EVIDENCE_OUTPUT_BYTES
        ) return null;
        ?{
            value = {
                local_sequence = evidence.local_sequence;
                found = evidence.found;
                body_bytes = Nat32.fromNat(body.size());
                body_digest_hex = Path.hexLower(
                    Hash.objectDigest(body)
                );
            };
            body;
        };
    };

    func validDirectedAction(value : {
        target_post_id : Blob;
        target_body_hash : Blob;
        action_id : Blob;
        object_digest : Blob;
        object_length : Nat32;
    }) : Bool {
        Validation.blob32(value.target_post_id) and
        Validation.blob32(value.target_body_hash) and
        Validation.blob32(value.action_id) and
        Validation.blob32(value.object_digest) and
        Nat32.toNat(value.object_length) > 0 and
        Nat32.toNat(value.object_length) <=
            Bounds.MAX_ACTION_OBJECT_BYTES;
    };

    func optionalHex32(value : ?Blob) : ?(?Text) {
        switch (value) {
            case null ?null;
            case (?bytes) {
                if (not Validation.blob32(bytes)) return null;
                ??Path.hexLower(bytes);
            };
        };
    };

    func isZero(value : Blob) : Bool {
        for (byte in value.values()) {
            if (byte != 0) return false;
        };
        true;
    };

    func parseLowerHex(value : Text, byteLength : Nat) : ?Blob {
        let characters = Iter.toArray(value.chars());
        if (characters.size() != byteLength * 2) return null;
        let output = VarArray.repeat<Nat8>(0, byteLength);
        var index = 0;
        while (index < byteLength) {
            let ?high = lowerNibble(characters[index * 2])
                else return null;
            let ?low = lowerNibble(characters[index * 2 + 1])
                else return null;
            output[index] := Nat8.fromNat(high * 16 + low);
            index += 1;
        };
        ?Blob.fromArray(VarArray.toArray(output));
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
