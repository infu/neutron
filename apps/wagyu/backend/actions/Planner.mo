import Blob "mo:core/Blob";
import Char "mo:core/Char";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Text "mo:core/Text";

import Caps "mo:neutron-capabilities";

import Bounds "../protocol/Bounds";
import Hash "../protocol/Hash";
import Protocol "../protocol/Types";
import Publication "Publication";

// Pure action construction. Every returned plan freezes the exact Candid body
// and the exact certified-asset mutation before main invokes a capability.
module {
    let MAX_NAT64 : Nat64 = 18_446_744_073_709_551_615;

    public type Error = {
        #invalid_network;
        #invalid_actor;
        #invalid_nonce;
        #invalid_text;
        #invalid_locator;
        #invalid_profile;
        #invalid_proof;
        #invalid_kernel_identity;
        #sequence_exhausted;
        #object_too_large;
        #batch_too_large;
        #invalid_kernel_receipt;
    };

    public type Result<T> = {
        #ok : T;
        #err : Error;
    };

    public type AvatarValidationError = {
        #missing_media_type;
        #too_large;
        #invalid_dimensions;
        #media_content_mismatch;
        #declared_dimensions_mismatch;
        #animation_forbidden;
    };

    public type AvatarInspection = {
        media_type : Protocol.AvatarMediaTypeV1;
        width : Nat;
        height : Nat;
    };

    public type AvatarValidationResult = {
        #ok : ?AvatarInspection;
        #err : AvatarValidationError;
    };

    public type PreparePostInput = {
        network_id : Blob;
        actor_ : Principal;
        author_sequence : Nat64;
        nonce : Blob;
        created_at_ns : Nat64;
        body_markdown : Text;
        reply_to : ?Protocol.ReplyToV1;
        posts_generation : Nat64;
        like_heads_generation : Nat64;
        publication_nonce : Blob;
    };

    public type PostPlan = {
        value : Protocol.PostBodyV1;
        body_candid : Blob;
        body_hash : Blob;
        post_id : Blob;
        object_digest : Blob;
        target : Caps.Target;
        like_head : Protocol.LikeHeadV1;
        like_head_candid : Blob;
        like_head_digest : Blob;
        like_head_target : Caps.Target;
        commit : Caps.CommitBatchInput;
    };

    public type PrepareShareInput = {
        network_id : Blob;
        sharer : Principal;
        share_sequence : Nat64;
        issued_at_ns : Nat64;
        original_post_ref : Protocol.CertifiedPostRefV1;
        original_post_ref_candid : Blob;
        shares_generation : Nat64;
        publication_nonce : Blob;
    };

    public type SharePlan = {
        value : Protocol.ShareActionV1;
        body_candid : Blob;
        share_id : Blob;
        object_digest : Blob;
        target : Caps.Target;
        original_post_ref_candid : Blob;
        commit : Caps.CommitBatchInput;
    };

    public type PrepareLikeInput = {
        network_id : Blob;
        liker : Principal;
        issued_at_ns : Nat64;
        post_author : Principal;
        post_id : Blob;
        post_body_hash : Blob;
        likes_generation : Nat64;
        publication_nonce : Blob;
    };

    public type LikePlan = {
        value : Protocol.LikeActionV1;
        body_candid : Blob;
        like_id : Blob;
        object_digest : Blob;
        target : Caps.Target;
        commit : Caps.CommitBatchInput;
    };

    public type PrepareTombstoneInput = {
        network_id : Blob;
        author : Principal;
        author_sequence : Nat64;
        issued_at_ns : Nat64;
        post_id : Blob;
        post_body_hash : Blob;
        tombstones_generation : Nat64;
        publication_nonce : Blob;
    };

    public type TombstonePlan = {
        value : Protocol.TombstoneActionV1;
        body_candid : Blob;
        tombstone_id : Blob;
        object_digest : Blob;
        target : Caps.Target;
        commit : Caps.CommitBatchInput;
    };

    public type DefaultProfileInput = {
        network_id : Blob;
        node : Principal;
        profile_generation : Nat64;
        updated_at_ns : Nat64;
        capabilities : ?[Text];
    };

    public type DefaultProfilePlan = {
        value : Protocol.ProfileV1;
        body_candid : Blob;
        body_digest : Blob;
    };

    public type PrepareProfileEditInput = {
        current : Protocol.ProfileV1;
        current_body_candid : Blob;
        current_identity : Publication.StoredIdentity;
        updated_at_ns : Nat64;
        display_name : Text;
        description : Text;
        capabilities : ?[Text];
        avatar : ?Protocol.AvatarV1;
        publication_nonce : Blob;
    };

    public type CreateProfileInput = {
        network_id : Blob;
        node : Principal;
        profile_generation : Nat64;
        updated_at_ns : Nat64;
        display_name : Text;
        description : Text;
        capabilities : ?[Text];
        avatar : ?Protocol.AvatarV1;
        profile_collection_generation : Nat64;
        publication_nonce : Blob;
    };

    public type ProfileEditPlan = {
        previous : Protocol.ProfileV1;
        value : Protocol.ProfileV1;
        body_candid : Blob;
        body_digest : Blob;
        target : Caps.Target;
        commit : Caps.CommitBatchInput;
    };

    public type PostPublication = {
        post_identity : Caps.RecordIdentity;
        like_head_identity : Caps.RecordIdentity;
    };

    public type LikeFinalization = {
        action_ref : Protocol.CertifiedActionRefV1;
        receipt : Protocol.CertifiedLikeReceiptV1;
        receipt_candid : Blob;
    };

    // Profile-edit admission is intentionally stricter than bounded decoding
    // of a remote ProfileV1. A present local avatar must carry a current known
    // media tag, and the declared dimensions are trusted only after they match
    // dimensions parsed from the tagged raster's own header.
    public func validateAvatarAdmission(
        avatar : ?Protocol.AvatarV1
    ) : AvatarValidationResult {
        let ?value = avatar else return #ok(null);
        if (value.bytes.size() > Bounds.MAX_AVATAR_BYTES) {
            return #err(#too_large);
        };

        let declaredWidth = Nat16.toNat(value.width);
        let declaredHeight = Nat16.toNat(value.height);
        if (
            not boundedAvatarDimensions(
                declaredWidth,
                declaredHeight,
            )
        ) return #err(#invalid_dimensions);

        let ?mediaType = value.media_type else {
            return #err(#missing_media_type);
        };
        let bytes = Blob.toArray(value.bytes);
        let inspected = switch (mediaType) {
            case (#png) sniffPng(bytes);
            case (#jpeg) sniffJpeg(bytes);
            case (#webp) sniffWebp(bytes);
        };
        let dimensions = switch (inspected) {
            case (#ok(value)) value;
            case (#err(reason)) return #err(reason);
        };
        if (
            not boundedAvatarDimensions(
                dimensions.width,
                dimensions.height,
            )
        ) return #err(#invalid_dimensions);
        if (
            dimensions.width != declaredWidth or
            dimensions.height != declaredHeight
        ) return #err(#declared_dimensions_mismatch);

        #ok(
            ?{
                media_type = mediaType;
                width = dimensions.width;
                height = dimensions.height;
            }
        );
    };

    public func preparePost(input : PreparePostInput) : Result<PostPlan> {
        if (not validNetworkAndActor(input.network_id, input.actor_)) {
            return #err(
                if (input.network_id.size() != Bounds.HASH_BYTES) {
                    #invalid_network;
                } else #invalid_actor
            );
        };
        if (
            input.nonce.size() != Bounds.NONCE_BYTES or
            not Publication.validNonce(input.publication_nonce)
        ) return #err(#invalid_nonce);
        if (
            Text.encodeUtf8(input.body_markdown).size() >
                Bounds.MAX_MARKDOWN_BYTES or
            hasNonTextControls(input.body_markdown)
        ) return #err(#invalid_text);
        switch (input.reply_to) {
            case (?reply) {
                if (not validReply(reply)) return #err(#invalid_locator);
            };
            case null {};
        };

        let value : Protocol.PostBodyV1 = {
            header = {
                network_id = input.network_id;
                actor_ = input.actor_;
                action_kind = ?#post;
            };
            author_sequence = input.author_sequence;
            nonce = input.nonce;
            created_at_ns = input.created_at_ns;
            body_markdown = input.body_markdown;
            reply_to = input.reply_to;
        };
        let bodyCandid = to_candid (value);
        if (bodyCandid.size() > Bounds.MAX_POST_OBJECT_BYTES) {
            return #err(#object_too_large);
        };
        let ?bodyHash = Hash.postBodyHash(bodyCandid) else {
            return #err(#object_too_large);
        };
        let ?postId = Hash.postId(
            input.network_id,
            input.actor_,
            bodyHash,
        ) else return #err(#invalid_locator);
        let objectDigest = Hash.objectDigest(bodyCandid);

        let likeHead : Protocol.LikeHeadV1 = {
            network_id = input.network_id;
            post_author = input.actor_;
            post_id = postId;
            post_body_hash = bodyHash;
            store_generation = input.like_heads_generation;
            revision = 0;
            previous_head_hash = null;
            latest_batch_number = null;
            latest_batch_digest = null;
            sealed_batch_count = 0;
            sealed_receipt_count = 0;
            accepting_likes = true;
        };
        let likeHeadCandid = to_candid (likeHead);
        if (likeHeadCandid.size() > Bounds.MAX_LIKE_HEAD_BYTES) {
            return #err(#object_too_large);
        };
        if (
            bodyCandid.size() + likeHeadCandid.size() >
                Bounds.MAX_CERTIFIED_BATCH_BYTES
        ) return #err(#batch_too_large);
        let likeHeadDigest = Hash.objectDigest(likeHeadCandid);
        let target = Publication.immutableTarget(
            Publication.POSTS_COLLECTION,
            input.posts_generation,
            objectDigest,
        );
        let likeHeadTarget = Publication.likeHeadTarget(
            input.like_heads_generation,
            postId,
        );
        let commit : Caps.CommitBatchInput = {
            nonce = input.publication_nonce;
            operations = [
                Publication.put(target, #absent, #inline(bodyCandid)),
                Publication.put(
                    likeHeadTarget,
                    #absent,
                    #inline(likeHeadCandid),
                ),
            ];
            requires_present_after = [
                Publication.presentAfter(target, objectDigest),
            ];
        };
        #ok({
            value;
            body_candid = bodyCandid;
            body_hash = bodyHash;
            post_id = postId;
            object_digest = objectDigest;
            target;
            like_head = likeHead;
            like_head_candid = likeHeadCandid;
            like_head_digest = likeHeadDigest;
            like_head_target = likeHeadTarget;
            commit;
        });
    };

    public func prepareShare(input : PrepareShareInput) : Result<SharePlan> {
        if (not validNetworkAndActor(input.network_id, input.sharer)) {
            return #err(
                if (input.network_id.size() != Bounds.HASH_BYTES) {
                    #invalid_network;
                } else #invalid_actor
            );
        };
        if (
            not Publication.validNonce(input.publication_nonce) or
            not validPostRef(input.original_post_ref) or
            input.original_post_ref_candid.size() == 0
        ) return #err(#invalid_locator);
        let postRefDigest = Hash.postRefDigest(
            input.original_post_ref_candid
        );
        let ?shareId = Hash.shareId(
            input.network_id,
            input.sharer,
            input.original_post_ref.author,
            input.original_post_ref.post_id,
        ) else return #err(#invalid_locator);
        let value : Protocol.ShareActionV1 = {
            header = {
                network_id = input.network_id;
                actor_ = input.sharer;
                action_kind = ?#share;
            };
            share_id = shareId;
            share_sequence = input.share_sequence;
            issued_at_ns = input.issued_at_ns;
            original_author = input.original_post_ref.author;
            original_post_id = input.original_post_ref.post_id;
            original_body_hash = input.original_post_ref.body_hash;
            post_ref_digest = postRefDigest;
        };
        let bodyCandid = to_candid (value);
        if (bodyCandid.size() > Bounds.MAX_ACTION_OBJECT_BYTES) {
            return #err(#object_too_large);
        };
        let objectDigest = Hash.objectDigest(bodyCandid);
        let target = Publication.immutableTarget(
            Publication.SHARES_COLLECTION,
            input.shares_generation,
            objectDigest,
        );
        #ok({
            value;
            body_candid = bodyCandid;
            share_id = shareId;
            object_digest = objectDigest;
            target;
            original_post_ref_candid = input.original_post_ref_candid;
            commit = immutableCommit(
                input.publication_nonce,
                target,
                bodyCandid,
            );
        });
    };

    public func prepareLike(input : PrepareLikeInput) : Result<LikePlan> {
        if (
            not validNetworkAndActor(input.network_id, input.liker) or
            not Principal.isCanister(input.post_author) or
            input.post_id.size() != Bounds.HASH_BYTES or
            input.post_body_hash.size() != Bounds.HASH_BYTES
        ) return #err(#invalid_locator);
        if (not Publication.validNonce(input.publication_nonce)) {
            return #err(#invalid_nonce);
        };
        let ?likeId = Hash.likeId(
            input.network_id,
            input.liker,
            input.post_author,
            input.post_id,
        ) else return #err(#invalid_locator);
        let value : Protocol.LikeActionV1 = {
            header = {
                network_id = input.network_id;
                actor_ = input.liker;
                action_kind = ?#like;
            };
            like_id = likeId;
            issued_at_ns = input.issued_at_ns;
            post_author = input.post_author;
            post_id = input.post_id;
            post_body_hash = input.post_body_hash;
        };
        let bodyCandid = to_candid (value);
        if (bodyCandid.size() > Bounds.MAX_ACTION_OBJECT_BYTES) {
            return #err(#object_too_large);
        };
        let objectDigest = Hash.objectDigest(bodyCandid);
        let target = Publication.immutableTarget(
            Publication.LIKES_COLLECTION,
            input.likes_generation,
            objectDigest,
        );
        #ok({
            value;
            body_candid = bodyCandid;
            like_id = likeId;
            object_digest = objectDigest;
            target;
            commit = immutableCommit(
                input.publication_nonce,
                target,
                bodyCandid,
            );
        });
    };

    public func prepareTombstone(
        input : PrepareTombstoneInput
    ) : Result<TombstonePlan> {
        if (
            not validNetworkAndActor(input.network_id, input.author) or
            input.post_id.size() != Bounds.HASH_BYTES or
            input.post_body_hash.size() != Bounds.HASH_BYTES
        ) return #err(#invalid_locator);
        if (not Publication.validNonce(input.publication_nonce)) {
            return #err(#invalid_nonce);
        };
        let ?tombstoneId = Hash.tombstoneId(
            input.network_id,
            input.author,
            input.post_id,
            input.author_sequence,
        ) else return #err(#invalid_locator);
        let value : Protocol.TombstoneActionV1 = {
            header = {
                network_id = input.network_id;
                actor_ = input.author;
                action_kind = ?#tombstone;
            };
            tombstone_id = tombstoneId;
            author_sequence = input.author_sequence;
            issued_at_ns = input.issued_at_ns;
            post_id = input.post_id;
            post_body_hash = input.post_body_hash;
        };
        let bodyCandid = to_candid (value);
        if (bodyCandid.size() > Bounds.MAX_ACTION_OBJECT_BYTES) {
            return #err(#object_too_large);
        };
        let objectDigest = Hash.objectDigest(bodyCandid);
        let target = Publication.immutableTarget(
            Publication.TOMBSTONES_COLLECTION,
            input.tombstones_generation,
            objectDigest,
        );
        #ok({
            value;
            body_candid = bodyCandid;
            tombstone_id = tombstoneId;
            object_digest = objectDigest;
            target;
            commit = immutableCommit(
                input.publication_nonce,
                target,
                bodyCandid,
            );
        });
    };

    public func defaultProfile(
        input : DefaultProfileInput
    ) : Result<DefaultProfilePlan> {
        if (
            not validNetworkAndActor(input.network_id, input.node) or
            not validCapabilities(input.capabilities)
        ) return #err(#invalid_profile);
        let value : Protocol.ProfileV1 = {
            network_id = input.network_id;
            node = input.node;
            profile_generation = input.profile_generation;
            revision = 0;
            updated_at_ns = input.updated_at_ns;
            previous_profile_digest = null;
            display_name = "";
            description = "";
            capabilities = input.capabilities;
            avatar = null;
        };
        let bodyCandid = to_candid (value);
        if (bodyCandid.size() > Bounds.MAX_PROFILE_OBJECT_BYTES) {
            return #err(#object_too_large);
        };
        #ok({
            value;
            body_candid = bodyCandid;
            body_digest = Hash.objectDigest(bodyCandid);
        });
    };

    public func prepareProfileEdit(
        input : PrepareProfileEditInput
    ) : Result<ProfileEditPlan> {
        switch (validateAvatarAdmission(input.avatar)) {
            case (#err(_)) return #err(#invalid_profile);
            case (#ok(_)) {};
        };
        if (
            input.current.revision == MAX_NAT64 or
            not validProfileCore(input.current) or
            not validProfileText(input.display_name, input.description) or
            not validCapabilities(input.capabilities) or
            not Publication.validNonce(input.publication_nonce)
        ) return #err(#invalid_profile);
        if (
            input.current_identity.target.collection !=
                Publication.PROFILE_COLLECTION or
            not Publication.sameTarget(
                input.current_identity.target,
                Publication.profileTarget(
                    input.current_identity.target.collection_generation
                ),
            ) or
            input.current_identity.body_bytes !=
                input.current_body_candid.size() or
            not Blob.equal(
                input.current_identity.content_tag,
                Hash.objectDigest(input.current_body_candid),
            )
        ) return #err(#invalid_kernel_identity);

        let value : Protocol.ProfileV1 = {
            network_id = input.current.network_id;
            node = input.current.node;
            profile_generation = input.current.profile_generation;
            revision = input.current.revision + 1;
            updated_at_ns = input.updated_at_ns;
            previous_profile_digest = ?Hash.objectDigest(
                input.current_body_candid
            );
            display_name = input.display_name;
            description = input.description;
            capabilities = input.capabilities;
            avatar = input.avatar;
        };
        let bodyCandid = to_candid (value);
        if (bodyCandid.size() > Bounds.MAX_PROFILE_OBJECT_BYTES) {
            return #err(#object_too_large);
        };
        let bodyDigest = Hash.objectDigest(bodyCandid);
        let target = input.current_identity.target;
        let commit : Caps.CommitBatchInput = {
            nonce = input.publication_nonce;
            operations = [
                Publication.put(
                    target,
                    Publication.cas(input.current_identity),
                    #inline(bodyCandid),
                ),
            ];
            requires_present_after = [];
        };
        #ok({
            previous = input.current;
            value;
            body_candid = bodyCandid;
            body_digest = bodyDigest;
            target;
            commit;
        });
    };

    public func createProfile(
        input : CreateProfileInput
    ) : Result<ProfileEditPlan> {
        switch (validateAvatarAdmission(input.avatar)) {
            case (#err(_)) return #err(#invalid_profile);
            case (#ok(_)) {};
        };
        if (
            not validNetworkAndActor(input.network_id, input.node) or
            not validProfileText(input.display_name, input.description) or
            not validCapabilities(input.capabilities) or
            not Publication.validNonce(input.publication_nonce)
        ) return #err(#invalid_profile);
        let previous : Protocol.ProfileV1 = {
            network_id = input.network_id;
            node = input.node;
            profile_generation = input.profile_generation;
            revision = 0;
            updated_at_ns = 0;
            previous_profile_digest = null;
            display_name = "";
            description = "";
            capabilities = input.capabilities;
            avatar = null;
        };
        let value : Protocol.ProfileV1 = {
            network_id = input.network_id;
            node = input.node;
            profile_generation = input.profile_generation;
            revision = 1;
            updated_at_ns = input.updated_at_ns;
            previous_profile_digest = null;
            display_name = input.display_name;
            description = input.description;
            capabilities = input.capabilities;
            avatar = input.avatar;
        };
        let bodyCandid = to_candid (value);
        if (bodyCandid.size() > Bounds.MAX_PROFILE_OBJECT_BYTES) {
            return #err(#object_too_large);
        };
        let bodyDigest = Hash.objectDigest(bodyCandid);
        let target = Publication.profileTarget(
            input.profile_collection_generation
        );
        #ok({
            previous;
            value;
            body_candid = bodyCandid;
            body_digest = bodyDigest;
            target;
            commit = {
                nonce = input.publication_nonce;
                operations = [
                    Publication.put(
                        target,
                        #absent,
                        #inline(bodyCandid),
                    ),
                ];
                requires_present_after = [];
            };
        });
    };

    public func finalizePost(
        plan : PostPlan,
        proof : Protocol.CertifiedHttpProofV1,
    ) : Result<Protocol.CertifiedPostRefV1> {
        if (not validProof(proof)) return #err(#invalid_proof);
        #ok({
            author = plan.value.header.actor_;
            post_id = plan.post_id;
            body_hash = plan.body_hash;
            body_length = Nat32.fromNat(plan.body_candid.size());
            object_digest = plan.object_digest;
            proof;
        });
    };

    public func finalizeShare(
        plan : SharePlan,
        proof : Protocol.CertifiedHttpProofV1,
    ) : Result<Protocol.CertifiedShareRefV1> {
        if (not validProof(proof)) return #err(#invalid_proof);
        #ok({
            sharer = plan.value.header.actor_;
            share_id = plan.share_id;
            body_length = Nat32.fromNat(plan.body_candid.size());
            object_digest = plan.object_digest;
            proof;
        });
    };

    public func finalizeLike(
        plan : LikePlan,
        proof : Protocol.CertifiedHttpProofV1,
    ) : Result<LikeFinalization> {
        if (not validProof(proof)) return #err(#invalid_proof);
        let actionRef : Protocol.CertifiedActionRefV1 = {
            actor_ = plan.value.header.actor_;
            action_kind = ?#like;
            object_digest = plan.object_digest;
            body_length = Nat32.fromNat(plan.body_candid.size());
            proof_snapshot = proof;
        };
        let receipt : Protocol.CertifiedLikeReceiptV1 = {
            like_action_candid = plan.body_candid;
            ref = actionRef;
        };
        let receiptCandid = to_candid (receipt);
        if (receiptCandid.size() > Bounds.MAX_LIKE_RECEIPT_CANDID_BYTES) {
            return #err(#object_too_large);
        };
        #ok({
            action_ref = actionRef;
            receipt;
            receipt_candid = receiptCandid;
        });
    };

    public func finalizeTombstone(
        plan : TombstonePlan,
        proof : Protocol.CertifiedHttpProofV1,
    ) : Result<Protocol.CertifiedTombstoneV1> {
        if (not validProof(proof)) return #err(#invalid_proof);
        #ok({
            tombstone_action_candid = plan.body_candid;
            ref = {
                actor_ = plan.value.header.actor_;
                action_kind = ?#tombstone;
                object_digest = plan.object_digest;
                body_length = Nat32.fromNat(plan.body_candid.size());
                proof_snapshot = proof;
            };
        });
    };

    public func reconcilePost(
        plan : PostPlan,
        receipt : Caps.BatchReceipt,
    ) : Result<PostPublication> {
        let ?postIdentity = Publication.committedAt(
            receipt,
            0,
            plan.target,
            plan.object_digest,
            plan.body_candid.size(),
        ) else return #err(#invalid_kernel_receipt);
        let ?headIdentity = Publication.committedAt(
            receipt,
            1,
            plan.like_head_target,
            plan.like_head_digest,
            plan.like_head_candid.size(),
        ) else return #err(#invalid_kernel_receipt);
        #ok({
            post_identity = postIdentity;
            like_head_identity = headIdentity;
        });
    };

    public func reconcileShare(
        plan : SharePlan,
        receipt : Caps.BatchReceipt,
    ) : Result<Caps.RecordIdentity> {
        reconcileImmutable(
            receipt,
            plan.target,
            plan.object_digest,
            plan.body_candid.size(),
        );
    };

    public func reconcileLike(
        plan : LikePlan,
        receipt : Caps.BatchReceipt,
    ) : Result<Caps.RecordIdentity> {
        reconcileImmutable(
            receipt,
            plan.target,
            plan.object_digest,
            plan.body_candid.size(),
        );
    };

    public func reconcileTombstone(
        plan : TombstonePlan,
        receipt : Caps.BatchReceipt,
    ) : Result<Caps.RecordIdentity> {
        reconcileImmutable(
            receipt,
            plan.target,
            plan.object_digest,
            plan.body_candid.size(),
        );
    };

    public func reconcileProfile(
        plan : ProfileEditPlan,
        receipt : Caps.BatchReceipt,
    ) : Result<Caps.RecordIdentity> {
        reconcileImmutable(
            receipt,
            plan.target,
            plan.body_digest,
            plan.body_candid.size(),
        );
    };

    public func validProof(
        proof : Protocol.CertifiedHttpProofV1
    ) : Bool {
        if (proof.certificate_version != 2) return false;
        let proofCandid = to_candid (proof);
        proofCandid.size() <= Bounds.MAX_PROOF_CANDID_BYTES;
    };

    func immutableCommit(
        nonce : Blob,
        target : Caps.Target,
        body : Blob,
    ) : Caps.CommitBatchInput {
        {
            nonce;
            operations = [
                Publication.put(target, #absent, #inline(body)),
            ];
            requires_present_after = [];
        };
    };

    func reconcileImmutable(
        receipt : Caps.BatchReceipt,
        target : Caps.Target,
        digest : Blob,
        bodyBytes : Nat,
    ) : Result<Caps.RecordIdentity> {
        let ?identity = Publication.committedAt(
            receipt,
            0,
            target,
            digest,
            bodyBytes,
        ) else return #err(#invalid_kernel_receipt);
        #ok(identity);
    };

    func validNetworkAndActor(
        networkId : Blob,
        principal : Principal,
    ) : Bool {
        networkId.size() == Bounds.HASH_BYTES and
        Principal.isCanister(principal);
    };

    func validReply(reply : Protocol.ReplyToV1) : Bool {
        Principal.isCanister(reply.author) and
        reply.post_id.size() == Bounds.HASH_BYTES and
        reply.body_hash.size() == Bounds.HASH_BYTES and
        reply.object_digest.size() == Bounds.HASH_BYTES and
        Bounds.bodyLengthWithin(reply.body_length, #post);
    };

    func validPostRef(ref : Protocol.CertifiedPostRefV1) : Bool {
        Principal.isCanister(ref.author) and
        ref.post_id.size() == Bounds.HASH_BYTES and
        ref.body_hash.size() == Bounds.HASH_BYTES and
        ref.object_digest.size() == Bounds.HASH_BYTES and
        Bounds.bodyLengthWithin(ref.body_length, #post) and
        validProof(ref.proof);
    };

    func validProfileCore(profile : Protocol.ProfileV1) : Bool {
        let previousDigestValid = switch (
            profile.previous_profile_digest
        ) {
            case null true;
            case (?digest) digest.size() == Bounds.HASH_BYTES;
        };
        validNetworkAndActor(profile.network_id, profile.node) and
        validProfileText(profile.display_name, profile.description) and
        validCapabilities(profile.capabilities) and
        validAvatarShape(profile.avatar) and
        previousDigestValid;
    };

    func validProfileText(displayName : Text, description : Text) : Bool {
        Text.encodeUtf8(displayName).size() <=
            Bounds.MAX_DISPLAY_NAME_BYTES and
        Text.encodeUtf8(description).size() <=
            Bounds.MAX_DESCRIPTION_BYTES and
        not hasNonTextControls(displayName) and
        not hasNonTextControls(description);
    };

    func validCapabilities(capabilities : ?[Text]) : Bool {
        let ?values = capabilities else return true;
        if (values.size() > Bounds.MAX_CAPABILITIES) return false;
        var previous : ?Text = null;
        for (value in values.vals()) {
            let bytes = Text.encodeUtf8(value);
            if (
                bytes.size() == 0 or
                bytes.size() > Bounds.MAX_CAPABILITY_TOKEN_BYTES
            ) return false;
            for (byte in bytes.vals()) {
                let lower = byte >= 97 and byte <= 122;
                let digit = byte >= 48 and byte <= 57;
                if (
                    not lower and not digit and
                    byte != 46 and byte != 95 and byte != 58 and byte != 45
                ) return false;
            };
            switch (previous) {
                case (?prior) if (Text.compare(prior, value) != #less) {
                    return false;
                };
                case (_) {};
            };
            previous := ?value;
        };
        true;
    };

    // Structural decoding remains tolerant of a future media tag being
    // projected to null, as required for remotely fetched profiles. Local
    // profile-edit admission uses validateAvatarAdmission above.
    func validAvatarShape(avatar : ?Protocol.AvatarV1) : Bool {
        let ?value = avatar else return true;
        Nat16.toNat(value.width) <= Bounds.MAX_AVATAR_DIMENSION and
        Nat16.toNat(value.height) <= Bounds.MAX_AVATAR_DIMENSION and
        Nat16.toNat(value.width) > 0 and
        Nat16.toNat(value.height) > 0 and
        value.bytes.size() <= Bounds.MAX_AVATAR_BYTES;
    };

    type RasterDimensions = {
        width : Nat;
        height : Nat;
    };

    type RasterInspection = {
        #ok : RasterDimensions;
        #err : AvatarValidationError;
    };

    func sniffPng(bytes : [Nat8]) : RasterInspection {
        if (
            bytes.size() < 33 or
            not matches(
                bytes,
                0,
                [137, 80, 78, 71, 13, 10, 26, 10],
            ) or
            readU32be(bytes, 8) != 13 or
            not matches(bytes, 12, [73, 72, 68, 82])
        ) return #err(#media_content_mismatch);

        let dimensions : RasterDimensions = {
            width = readU32be(bytes, 16);
            height = readU32be(bytes, 20);
        };

        // Chunk framing lets admission reject APNG without decoding pixels.
        // CRC validation and raster decoding remain client responsibilities.
        var offset = 8;
        var first = true;
        var sawImageData = false;
        while (offset < bytes.size()) {
            if (offset + 12 > bytes.size()) {
                return #err(#media_content_mismatch);
            };
            let length = readU32be(bytes, offset);
            let dataStart = offset + 8;
            if (dataStart + length + 4 > bytes.size()) {
                return #err(#media_content_mismatch);
            };
            let chunkEnd = dataStart + length + 4;
            let isHeader = matches(bytes, offset + 4, [73, 72, 68, 82]);
            if (first) {
                if (not isHeader or length != 13) {
                    return #err(#media_content_mismatch);
                };
                first := false;
            } else if (isHeader) {
                return #err(#media_content_mismatch);
            };
            if (matches(bytes, offset + 4, [97, 99, 84, 76])) {
                return #err(#animation_forbidden);
            };
            if (matches(bytes, offset + 4, [73, 68, 65, 84])) {
                sawImageData := true;
            };
            if (matches(bytes, offset + 4, [73, 69, 78, 68])) {
                if (
                    length != 0 or not sawImageData or
                    chunkEnd != bytes.size()
                ) return #err(#media_content_mismatch);
                return #ok(dimensions);
            };
            offset := chunkEnd;
        };
        #err(#media_content_mismatch);
    };

    func sniffJpeg(bytes : [Nat8]) : RasterInspection {
        if (
            bytes.size() < 4 or bytes[0] != 0xff or bytes[1] != 0xd8
        ) return #err(#media_content_mismatch);

        var offset = 2;
        while (offset + 4 <= bytes.size()) {
            while (offset < bytes.size() and bytes[offset] == 0xff) {
                offset += 1;
            };
            if (offset >= bytes.size()) {
                return #err(#media_content_mismatch);
            };
            let marker = Nat8.toNat(bytes[offset]);
            offset += 1;
            if (marker == 0xd9 or marker == 0xda) {
                return #err(#media_content_mismatch);
            };
            if (
                marker == 0x01 or
                (marker >= 0xd0 and marker <= 0xd7)
            ) {
                // Standalone markers have no segment length.
            } else {
                if (offset + 2 > bytes.size()) {
                    return #err(#media_content_mismatch);
                };
                let length = readU16be(bytes, offset);
                if (length < 2 or offset + length > bytes.size()) {
                    return #err(#media_content_mismatch);
                };
                if (isJpegStartOfFrame(marker)) {
                    if (length < 8) {
                        return #err(#media_content_mismatch);
                    };
                    return #ok({
                        height = readU16be(bytes, offset + 3);
                        width = readU16be(bytes, offset + 5);
                    });
                };
                offset += length;
            };
        };
        #err(#media_content_mismatch);
    };

    func sniffWebp(bytes : [Nat8]) : RasterInspection {
        if (
            bytes.size() < 20 or
            not matches(bytes, 0, [82, 73, 70, 70]) or
            not matches(bytes, 8, [87, 69, 66, 80]) or
            readU32le(bytes, 4) + 8 != bytes.size()
        ) return #err(#media_content_mismatch);

        var offset = 12;
        var dimensions : ?RasterDimensions = null;
        var sawImageData = false;
        while (offset < bytes.size()) {
            if (offset + 8 > bytes.size()) {
                return #err(#media_content_mismatch);
            };
            let size = readU32le(bytes, offset + 4);
            let start = offset + 8;
            if (start + size > bytes.size()) {
                return #err(#media_content_mismatch);
            };
            let end = start + size;
            let paddedEnd = end + size % 2;
            if (paddedEnd > bytes.size()) {
                return #err(#media_content_mismatch);
            };

            if (
                matches(bytes, offset, [65, 78, 73, 77]) or
                matches(bytes, offset, [65, 78, 77, 70])
            ) return #err(#animation_forbidden);

            var candidate : ?RasterDimensions = null;
            if (matches(bytes, offset, [86, 80, 56, 88])) {
                if (
                    size != 10 or
                    Nat8.toNat(bytes[start]) % 4 >= 2
                ) return #err(
                    if (size == 10) {
                        #animation_forbidden;
                    } else #media_content_mismatch
                );
                candidate := ?{
                    width = readU24le(bytes, start + 4) + 1;
                    height = readU24le(bytes, start + 7) + 1;
                };
            } else if (matches(bytes, offset, [86, 80, 56, 32])) {
                if (
                    sawImageData or size < 10 or
                    bytes[start + 3] != 0x9d or
                    bytes[start + 4] != 0x01 or
                    bytes[start + 5] != 0x2a
                ) return #err(#media_content_mismatch);
                sawImageData := true;
                candidate := ?{
                    width = readU16le(bytes, start + 6) % 16_384;
                    height = readU16le(bytes, start + 8) % 16_384;
                };
            } else if (matches(bytes, offset, [86, 80, 56, 76])) {
                if (
                    sawImageData or size < 5 or bytes[start] != 0x2f
                ) return #err(#media_content_mismatch);
                sawImageData := true;
                let packed = readU32le(bytes, start + 1);
                candidate := ?{
                    width = packed % 16_384 + 1;
                    height = (packed / 16_384) % 16_384 + 1;
                };
            };

            switch (candidate) {
                case null {};
                case (?found) {
                    switch (dimensions) {
                        case null dimensions := ?found;
                        case (?current) {
                            if (
                                current.width != found.width or
                                current.height != found.height
                            ) return #err(#media_content_mismatch);
                        };
                    };
                };
            };
            offset := paddedEnd;
        };

        let ?found = dimensions else {
            return #err(#media_content_mismatch);
        };
        if (not sawImageData) return #err(#media_content_mismatch);
        #ok(found);
    };

    func boundedAvatarDimensions(width : Nat, height : Nat) : Bool {
        width > 0 and height > 0 and
        width <= Bounds.MAX_AVATAR_DIMENSION and
        height <= Bounds.MAX_AVATAR_DIMENSION;
    };

    func isJpegStartOfFrame(marker : Nat) : Bool {
        (marker >= 0xc0 and marker <= 0xc3) or
        (marker >= 0xc5 and marker <= 0xc7) or
        (marker >= 0xc9 and marker <= 0xcb) or
        (marker >= 0xcd and marker <= 0xcf);
    };

    func matches(
        bytes : [Nat8],
        offset : Nat,
        expected : [Nat8],
    ) : Bool {
        if (offset + expected.size() > bytes.size()) return false;
        var index = 0;
        while (index < expected.size()) {
            if (bytes[offset + index] != expected[index]) return false;
            index += 1;
        };
        true;
    };

    func readU16be(bytes : [Nat8], offset : Nat) : Nat {
        Nat8.toNat(bytes[offset]) * 256 +
        Nat8.toNat(bytes[offset + 1]);
    };

    func readU16le(bytes : [Nat8], offset : Nat) : Nat {
        Nat8.toNat(bytes[offset]) +
        Nat8.toNat(bytes[offset + 1]) * 256;
    };

    func readU24le(bytes : [Nat8], offset : Nat) : Nat {
        Nat8.toNat(bytes[offset]) +
        Nat8.toNat(bytes[offset + 1]) * 256 +
        Nat8.toNat(bytes[offset + 2]) * 65_536;
    };

    func readU32be(bytes : [Nat8], offset : Nat) : Nat {
        Nat8.toNat(bytes[offset]) * 16_777_216 +
        Nat8.toNat(bytes[offset + 1]) * 65_536 +
        Nat8.toNat(bytes[offset + 2]) * 256 +
        Nat8.toNat(bytes[offset + 3]);
    };

    func readU32le(bytes : [Nat8], offset : Nat) : Nat {
        Nat8.toNat(bytes[offset]) +
        Nat8.toNat(bytes[offset + 1]) * 256 +
        Nat8.toNat(bytes[offset + 2]) * 65_536 +
        Nat8.toNat(bytes[offset + 3]) * 16_777_216;
    };

    func hasNonTextControls(value : Text) : Bool {
        for (character in value.chars()) {
            let code = Char.toNat32(character);
            if (
                (code < 32 and code != 9 and code != 10 and code != 13) or
                (code >= 127 and code <= 159)
            ) return true;
        };
        false;
    };
};
