import Blob "mo:core/Blob";
import Char "mo:core/Char";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Principal "mo:core/Principal";
import Text "mo:core/Text";

import Bounds "./Bounds";
import CandidGuard "./CandidGuard";
import Types "./Types";

module {
    public type VerdictV1 = {
        #valid;
        #invalid;
        #incompatible;
    };

    public type ProfileVerdictV1 = {
        #valid;
        #avatar_unsupported;
        #invalid;
    };

    public func blob32(value : Blob) : Bool {
        value.size() == Bounds.HASH_BYTES;
    };

    public func nonce(value : Blob) : Bool {
        value.size() == Bounds.NONCE_BYTES;
    };

    public func operationId(value : Blob) : Bool {
        value.size() == Bounds.OPERATION_ID_BYTES;
    };

    public func subscriptionId(value : Blob) : Bool {
        value.size() == Bounds.SUBSCRIPTION_ID_BYTES;
    };

    public func safeText(value : Text, maximumUtf8Bytes : Nat) : Bool {
        if (Text.encodeUtf8(value).size() > maximumUtf8Bytes) return false;
        for (character in value.chars()) {
            let code = Char.toNat32(character);
            if (
                (code < 32 and code != 9 and code != 10 and code != 13) or
                (code >= 127 and code <= 159)
            ) return false;
        };
        true;
    };

    public func capabilityToken(value : Text) : Bool {
        let bytes = Text.encodeUtf8(value);
        if (
            bytes.size() == 0 or
            bytes.size() > Bounds.MAX_CAPABILITY_TOKEN_BYTES
        ) return false;
        for (character in value.chars()) {
            let code = Char.toNat32(character);
            let accepted =
                (code >= 97 and code <= 122) or
                (code >= 48 and code <= 57) or
                code == 46 or code == 95 or code == 58 or code == 45;
            if (not accepted) return false;
        };
        true;
    };

    public func capabilities(values : [Text]) : Bool {
        if (values.size() > Bounds.MAX_CAPABILITIES) return false;
        var prior : ?Text = null;
        for (value in values.values()) {
            if (not capabilityToken(value)) return false;
            switch (prior) {
                case (?previous) {
                    if (Text.compare(previous, value) != #less) return false;
                };
                case null {};
            };
            prior := ?value;
        };
        true;
    };

    public func actionHeader(
        value : Types.ActionHeaderV1,
        expectedNetworkId : Blob,
        expectedActor : Principal,
        expectedKind : Types.ActionKindV1,
    ) : VerdictV1 {
        if (
            not blob32(value.network_id) or
            not blob32(expectedNetworkId) or
            not Blob.equal(value.network_id, expectedNetworkId) or
            not Principal.equal(value.actor_, expectedActor)
        ) return #invalid;
        switch (value.action_kind) {
            case null #incompatible;
            case (?kind) if (kind == expectedKind) #valid else #invalid;
        };
    };

    public func certifiedHttpProofValue(
        value : Types.CertifiedHttpProofV1
    ) : Bool {
        value.certificate_version == 2 and
        value.certificate_cbor.size() > 0 and
        value.witness_cbor.size() > 0 and
        value.expression_path_cbor.size() > 0 and
        value.certificate_cbor.size() <= Bounds.MAX_PROOF_CANDID_BYTES and
        value.witness_cbor.size() <= Bounds.MAX_PROOF_CANDID_BYTES and
        value.expression_path_cbor.size() <= Bounds.MAX_PROOF_CANDID_BYTES and
        value.certificate_cbor.size() + value.witness_cbor.size() +
            value.expression_path_cbor.size() <=
                Bounds.MAX_PROOF_CANDID_BYTES;
    };

    public func certifiedHttpProof(
        value : Types.CertifiedHttpProofV1,
        exactProofCandidBytes : Nat,
    ) : Bool {
        exactProofCandidBytes > 0 and
        exactProofCandidBytes <= Bounds.MAX_PROOF_CANDID_BYTES and
        certifiedHttpProofValue(value);
    };

    public func certifiedActionRefValue(
        value : Types.CertifiedActionRefV1,
        expectedActor : Principal,
        expectedKind : Types.ActionKindV1,
    ) : VerdictV1 {
        if (
            not Principal.equal(value.actor_, expectedActor) or
            not blob32(value.object_digest) or
            Nat32.toNat(value.body_length) == 0 or
            Nat32.toNat(value.body_length) >
                Bounds.actionObjectBytes(expectedKind) or
            not certifiedHttpProofValue(value.proof_snapshot)
        ) return #invalid;
        switch (value.action_kind) {
            case null #incompatible;
            case (?kind) if (kind == expectedKind) #valid else #invalid;
        };
    };

    public func certifiedActionRef(
        value : Types.CertifiedActionRefV1,
        expectedActor : Principal,
        expectedKind : Types.ActionKindV1,
        exactProofCandidBytes : Nat,
    ) : VerdictV1 {
        if (
            not certifiedHttpProof(
                value.proof_snapshot,
                exactProofCandidBytes,
            )
        ) return #invalid;
        certifiedActionRefValue(
            value,
            expectedActor,
            expectedKind,
        );
    };

    public func replyTo(value : Types.ReplyToV1) : Bool {
        blob32(value.post_id) and
        blob32(value.body_hash) and
        blob32(value.object_digest) and
        Nat32.toNat(value.body_length) > 0 and
        Nat32.toNat(value.body_length) <= Bounds.MAX_POST_OBJECT_BYTES;
    };

    public func postBody(
        value : Types.PostBodyV1,
        expectedNetworkId : Blob,
        expectedActor : Principal,
    ) : VerdictV1 {
        switch (
            actionHeader(
                value.header,
                expectedNetworkId,
                expectedActor,
                #post,
            )
        ) {
            case (#invalid) return #invalid;
            case (#incompatible) return #incompatible;
            case (#valid) {};
        };
        if (
            not nonce(value.nonce) or
            not safeText(value.body_markdown, Bounds.MAX_MARKDOWN_BYTES)
        ) return #invalid;
        switch (value.reply_to) {
            case (?parent) if (not replyTo(parent)) return #invalid;
            case (_) {};
        };
        #valid;
    };

    public func certifiedPostRefValue(
        value : Types.CertifiedPostRefV1
    ) : Bool {
        blob32(value.post_id) and
        blob32(value.body_hash) and
        blob32(value.object_digest) and
        Nat32.toNat(value.body_length) > 0 and
        Nat32.toNat(value.body_length) <= Bounds.MAX_POST_OBJECT_BYTES and
        certifiedHttpProofValue(value.proof);
    };

    public func certifiedPostRef(
        value : Types.CertifiedPostRefV1,
        exactProofCandidBytes : Nat,
    ) : Bool {
        certifiedPostRefValue(value) and
        certifiedHttpProof(value.proof, exactProofCandidBytes);
    };

    public func shareAction(
        value : Types.ShareActionV1,
        expectedNetworkId : Blob,
        expectedSharer : Principal,
    ) : VerdictV1 {
        switch (
            actionHeader(
                value.header,
                expectedNetworkId,
                expectedSharer,
                #share,
            )
        ) {
            case (#invalid) return #invalid;
            case (#incompatible) return #incompatible;
            case (#valid) {};
        };
        if (
            not blob32(value.share_id) or
            not blob32(value.original_post_id) or
            not blob32(value.original_body_hash) or
            not blob32(value.post_ref_digest)
        ) #invalid else #valid;
    };

    public func certifiedShareRefValue(
        value : Types.CertifiedShareRefV1
    ) : Bool {
        blob32(value.share_id) and
        blob32(value.object_digest) and
        Nat32.toNat(value.body_length) > 0 and
        Nat32.toNat(value.body_length) <= Bounds.MAX_ACTION_OBJECT_BYTES and
        certifiedHttpProofValue(value.proof);
    };

    public func certifiedShareRef(
        value : Types.CertifiedShareRefV1,
        exactProofCandidBytes : Nat,
    ) : Bool {
        certifiedShareRefValue(value) and
        certifiedHttpProof(value.proof, exactProofCandidBytes);
    };

    public func likeAction(
        value : Types.LikeActionV1,
        expectedNetworkId : Blob,
        expectedLiker : Principal,
    ) : VerdictV1 {
        switch (
            actionHeader(
                value.header,
                expectedNetworkId,
                expectedLiker,
                #like,
            )
        ) {
            case (#invalid) return #invalid;
            case (#incompatible) return #incompatible;
            case (#valid) {};
        };
        if (
            not blob32(value.like_id) or
            not blob32(value.post_id) or
            not blob32(value.post_body_hash)
        ) #invalid else #valid;
    };

    public func certifiedLikeReceiptValue(
        value : Types.CertifiedLikeReceiptV1
    ) : VerdictV1 {
        if (
            value.like_action_candid.size() == 0 or
            value.like_action_candid.size() >
                Bounds.MAX_ACTION_OBJECT_BYTES
        ) return #invalid;
        certifiedActionRefValue(value.ref, value.ref.actor_, #like);
    };

    public func certifiedLikeReceipt(
        value : Types.CertifiedLikeReceiptV1,
        exactReceiptCandidBytes : Nat,
    ) : VerdictV1 {
        if (
            exactReceiptCandidBytes == 0 or
            exactReceiptCandidBytes >
                Bounds.MAX_LIKE_RECEIPT_CANDID_BYTES
        ) return #invalid;
        certifiedLikeReceiptValue(value);
    };

    public func tombstoneAction(
        value : Types.TombstoneActionV1,
        expectedNetworkId : Blob,
        expectedAuthor : Principal,
    ) : VerdictV1 {
        switch (
            actionHeader(
                value.header,
                expectedNetworkId,
                expectedAuthor,
                #tombstone,
            )
        ) {
            case (#invalid) return #invalid;
            case (#incompatible) return #incompatible;
            case (#valid) {};
        };
        if (
            not blob32(value.tombstone_id) or
            not blob32(value.post_id) or
            not blob32(value.post_body_hash)
        ) #invalid else #valid;
    };

    public func profile(
        value : Types.ProfileV1,
        expectedNetworkId : Blob,
        expectedNode : Principal,
    ) : ProfileVerdictV1 {
        if (
            not blob32(value.network_id) or
            not Blob.equal(value.network_id, expectedNetworkId) or
            not Principal.equal(value.node, expectedNode) or
            not optionalBlob32(value.previous_profile_digest) or
            not safeText(
                value.display_name,
                Bounds.MAX_DISPLAY_NAME_BYTES,
            ) or
            not safeText(
                value.description,
                Bounds.MAX_DESCRIPTION_BYTES,
            )
        ) return #invalid;
        switch (value.capabilities) {
            case (?tokens) if (not capabilities(tokens)) return #invalid;
            case (_) {};
        };
        switch (value.avatar) {
            case null #valid;
            case (?avatar) {
                if (
                    avatar.bytes.size() > Bounds.MAX_AVATAR_BYTES or
                    Nat16.toNat(avatar.width) > Bounds.MAX_AVATAR_DIMENSION or
                    Nat16.toNat(avatar.height) >
                        Bounds.MAX_AVATAR_DIMENSION
                ) return #invalid;
                switch (avatar.media_type) {
                    case null #avatar_unsupported;
                    case (?_) #valid;
                };
            };
        };
    };

    public func profileEdit(
        value : Types.ProfileEditRequestV1,
    ) : VerdictV1 {
        if (
            not safeText(
                value.display_name,
                Bounds.MAX_DISPLAY_NAME_BYTES,
            ) or
            not safeText(
                value.description,
                Bounds.MAX_DESCRIPTION_BYTES,
            )
        ) return #invalid;
        switch (value.avatar) {
            case null #valid;
            case (?avatar) {
                if (
                    avatar.bytes.size() == 0 or
                    avatar.bytes.size() > Bounds.MAX_AVATAR_BYTES or
                    Nat16.toNat(avatar.width) == 0 or
                    Nat16.toNat(avatar.height) == 0 or
                    Nat16.toNat(avatar.width) >
                        Bounds.MAX_AVATAR_DIMENSION or
                    Nat16.toNat(avatar.height) >
                        Bounds.MAX_AVATAR_DIMENSION
                ) return #invalid;
                switch (avatar.media_type) {
                    case null #incompatible;
                    case (?_) #valid;
                };
            };
        };
    };

    public func followBody(value : Types.FollowBodyV1) : Bool {
        subscriptionId(value.subscription_id);
    };

    public func unfollowBody(value : Types.UnfollowBodyV1) : Bool {
        subscriptionId(value.subscription_id);
    };

    public func deliverBody(value : Types.DeliverBodyV1) : VerdictV1 {
        if (not subscriptionId(value.subscription_id)) return #invalid;
        switch (value.event) {
            case null #incompatible;
            case (?#original(exact) or ?#share(exact) or ?#tombstone(exact)) {
                if (
                    exact.size() == 0 or
                    exact.size() > Bounds.DELIVER.max_request_bytes or
                    not CandidGuard.validOne(
                        exact,
                        Bounds.DELIVER.max_request_bytes,
                    )
                ) #invalid else #valid;
            };
        };
    };

    public func likeBody(value : Types.LikeBodyV1) : Bool {
        value.certified_like_receipt_candid.size() > 0 and
        value.certified_like_receipt_candid.size() <=
            Bounds.MAX_LIKE_RECEIPT_CANDID_BYTES and
        CandidGuard.validOne(
            value.certified_like_receipt_candid,
            Bounds.MAX_LIKE_RECEIPT_CANDID_BYTES,
        );
    };

    public func noticeBody(value : Types.NoticeBodyV1) : VerdictV1 {
        if (
            not blob32(value.target_post_id) or
            not blob32(value.target_body_hash) or
            not blob32(value.actor_action_id) or
            not blob32(value.actor_object_digest) or
            Nat32.toNat(value.actor_object_length) == 0
        ) return #invalid;
        switch (value.relation) {
            case null #incompatible;
            case (?#reply) {
                if (
                    Nat32.toNat(value.actor_object_length) <=
                        Bounds.MAX_POST_OBJECT_BYTES
                ) #valid else #invalid;
            };
            case (?#share) {
                if (
                    Nat32.toNat(value.actor_object_length) <=
                        Bounds.MAX_ACTION_OBJECT_BYTES
                ) #valid else #invalid;
            };
        };
    };

    public func routeResult(value : Types.WagyuRouteResultV1) : VerdictV1 {
        switch (value.outcome) {
            case null return #incompatible;
            case (?#rejected({ reason = null })) return #incompatible;
            case (_) {};
        };
        switch (value.relationship) {
            case (?head) switch (head.state) {
                case null return #incompatible;
                case (?#active(active)) {
                    if (
                        not subscriptionId(active.subscription_id) or
                        Nat16.toNat(active.delivery_credits) >
                            Bounds.MAX_DELIVERY_CREDITS
                    ) return #invalid;
                };
                case (?#inactive(inactive)) {
                    if (
                        not subscriptionId(
                            inactive.last_subscription_id
                        )
                    ) return #invalid;
                };
            };
            case null {};
        };
        #valid;
    };

    public func likeBatch(
        value : Types.LikeBatchV1,
        exactBatchCandidBytes : Nat,
    ) : Bool {
        if (
            exactBatchCandidBytes == 0 or
            exactBatchCandidBytes > Bounds.MAX_LIKE_BATCH_BYTES or
            not blob32(value.network_id) or
            not blob32(value.post_id) or
            not blob32(value.post_body_hash) or
            not optionalBlob32(value.previous_batch_digest) or
            value.first_accepted_sequence >
                value.last_accepted_sequence
        ) return false;
        if (value.final_partial) {
            if (
                value.receipts.size() == 0 or
                value.receipts.size() >
                    Bounds.MAX_FINAL_PARTIAL_RECEIPTS
            ) return false;
        } else if (
            value.receipts.size() != Bounds.LIKE_BATCH_RECEIPTS
        ) return false;
        for (receipt in value.receipts.values()) {
            switch (certifiedLikeReceiptValue(receipt)) {
                case (#valid) {};
                case (_) return false;
            };
        };
        true;
    };

    public func likeHead(value : Types.LikeHeadV1) : Bool {
        if (
            not blob32(value.network_id) or
            not blob32(value.post_id) or
            not blob32(value.post_body_hash) or
            not optionalBlob32(value.previous_head_hash) or
            not optionalBlob32(value.latest_batch_digest)
        ) return false;
        switch (
            value.latest_batch_number,
            value.latest_batch_digest,
        ) {
            case (null, null) true;
            case (?_, ?_) true;
            case (_) false;
        };
    };

    public func feedPageRequest(
        value : Types.FeedPageRequestV1
    ) : Bool {
        let limit = Nat16.toNat(value.limit);
        limit > 0 and limit <= Bounds.MAX_FEED_PAGE_ITEMS;
    };

    public func notificationPageRequest(
        value : Types.NotificationPageRequestV1
    ) : Bool {
        let limit = Nat16.toNat(value.limit);
        limit > 0 and limit <= Bounds.MAX_NOTIFICATION_PAGE_ITEMS;
    };

    public func sendQuoteRequest(
        value : Types.SendQuoteRequestV1
    ) : VerdictV1 {
        switch (value.send_kind) {
            case null #incompatible;
            case (?kind) {
                if (
                    Nat32.toNat(value.estimated_object_bytes) <=
                        Bounds.sendObjectBytes(kind)
                ) #valid else #invalid;
            };
        };
    };

    func optionalBlob32(value : ?Blob) : Bool {
        switch (value) {
            case null true;
            case (?present) blob32(present);
        };
    };
};
