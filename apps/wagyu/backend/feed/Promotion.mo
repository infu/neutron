import Blob "mo:core/Blob";
import Nat32 "mo:core/Nat32";
import Principal "mo:core/Principal";

import Hash "../protocol/Hash";
import Protocol "../protocol/Types";
import Validation "../protocol/Validation";
import Wire "../protocol/Wire";
import Types "Types";

module {
    public type VerifiedClaim = {
        author : Principal;
        post_id : Blob;
        body_hash : Blob;
        object_digest : Blob;
    };

    public type Plan = {
        #delivery : Types.PromoteDeliveryRequest;
        #tombstone : Types.PromoteTombstoneRequest;
    };

    public type Error = {
        #invalid;
        #mismatch;
        #incompatible;
    };

    public type Result = {
        #ok : Plan;
        #err : Error;
    };

    // The browser is the cryptographic verifier. This planner does not repeat
    // certificate verification; it binds the owner-authorized verified claim
    // to the exact delivery bytes already retained by paid ingress and rejects
    // malformed or internally inconsistent packages before Feed.Service
    // applies canonical promotion policy.
    public func prepare(
        networkId : Blob,
        candidate : Types.StoredCandidate,
        claim : VerifiedClaim,
        verifiedAtNs : Nat64,
        retainUntilNs : Nat64,
    ) : Result {
        if (
            not Validation.blob32(networkId) or
            not Principal.isCanister(claim.author) or
            not Validation.blob32(claim.post_id) or
            not Validation.blob32(claim.body_hash) or
            not Validation.blob32(claim.object_digest) or
            retainUntilNs < verifiedAtNs
        ) return #err(#invalid);
        if (
            not Principal.equal(candidate.claimed_author, claim.author) or
            not Blob.equal(candidate.claimed_post_id, claim.post_id) or
            not Blob.equal(candidate.claimed_body_hash, claim.body_hash)
        ) return #err(#mismatch);

        switch (candidate.event_kind) {
            case (#original) {
                let ?reference = Wire.decodeCertifiedPostRef(
                    candidate.exact_event_candid
                ) else return #err(#invalid);
                let postResult = verifiedPost(
                    networkId,
                    reference,
                    candidate.exact_event_candid,
                    claim,
                );
                let #ok(post) = postResult else {
                    let #err(error) = postResult else {
                        return #err(#invalid);
                    };
                    return #err(error);
                };
                #ok(#delivery({
                    candidate_id = candidate.candidate_id;
                    post;
                    share = null;
                    verified_at_ns = verifiedAtNs;
                }));
            };
            case (#share) {
                let ?delivery = Wire.decodeCertifiedShareDelivery(
                    candidate.exact_event_candid
                ) else return #err(#invalid);
                let ?reference = Wire.decodeCertifiedPostRef(
                    delivery.original_post_ref_candid
                ) else return #err(#invalid);
                let postResult = verifiedPost(
                    networkId,
                    reference,
                    delivery.original_post_ref_candid,
                    claim,
                );
                let #ok(post) = postResult else {
                    let #err(error) = postResult else {
                        return #err(#invalid);
                    };
                    return #err(error);
                };
                let ?action = Wire.decodeShareAction(
                    delivery.share_action_candid
                ) else return #err(#invalid);
                switch (
                    Validation.shareAction(
                        action,
                        networkId,
                        delivery.share_ref.sharer,
                    )
                ) {
                    case (#invalid) return #err(#invalid);
                    case (#incompatible) return #err(#incompatible);
                    case (#valid) {};
                };
                switch (
                    Validation.certifiedShareRefValue(delivery.share_ref)
                ) {
                    case false return #err(#invalid);
                    case true {};
                };
                let ?expectedShareId = Hash.shareId(
                    networkId,
                    delivery.share_ref.sharer,
                    reference.author,
                    reference.post_id,
                ) else return #err(#invalid);
                if (
                    not Principal.equal(
                        delivery.share_ref.sharer,
                        candidate.immediate_sender,
                    ) or
                    not Blob.equal(action.share_id, expectedShareId) or
                    not Blob.equal(
                        delivery.share_ref.share_id,
                        expectedShareId,
                    ) or
                    not Principal.equal(
                        action.original_author,
                        reference.author,
                    ) or
                    not Blob.equal(
                        action.original_post_id,
                        reference.post_id,
                    ) or
                    not Blob.equal(
                        action.original_body_hash,
                        reference.body_hash,
                    ) or
                    not Blob.equal(
                        action.post_ref_digest,
                        Hash.postRefDigest(
                            delivery.original_post_ref_candid
                        ),
                    ) or
                    Nat32.toNat(delivery.share_ref.body_length) !=
                        delivery.share_action_candid.size() or
                    not Blob.equal(
                        delivery.share_ref.object_digest,
                        Hash.sha256(delivery.share_action_candid),
                    )
                ) return #err(#invalid);
                #ok(#delivery({
                    candidate_id = candidate.candidate_id;
                    post;
                    share = ?{
                        sharer = delivery.share_ref.sharer;
                        share_id = delivery.share_ref.share_id;
                        share_object_digest =
                            delivery.share_ref.object_digest;
                        exact_delivery_candid =
                            candidate.exact_event_candid;
                        exact_original_post_ref_candid =
                            delivery.original_post_ref_candid;
                        exact_share_action_candid =
                            delivery.share_action_candid;
                        // CertifiedShareDeliveryV1 embeds this record rather
                        // than an opaque nested blob. Canonical Candid is the
                        // reproducible exact representation of that value.
                        exact_share_ref_candid =
                            to_candid (delivery.share_ref);
                    };
                    verified_at_ns = verifiedAtNs;
                }));
            };
            case (#tombstone) {
                let ?certified = Wire.decodeCertifiedTombstone(
                    candidate.exact_event_candid
                ) else return #err(#invalid);
                let ?action = Wire.decodeTombstoneAction(
                    certified.tombstone_action_candid
                ) else return #err(#invalid);
                switch (
                    Validation.tombstoneAction(
                        action,
                        networkId,
                        claim.author,
                    )
                ) {
                    case (#invalid) return #err(#invalid);
                    case (#incompatible) return #err(#incompatible);
                    case (#valid) {};
                };
                switch (
                    Validation.certifiedActionRefValue(
                        certified.ref,
                        claim.author,
                        #tombstone,
                    )
                ) {
                    case (#invalid) return #err(#invalid);
                    case (#incompatible) return #err(#incompatible);
                    case (#valid) {};
                };
                let ?expectedTombstoneId = Hash.tombstoneId(
                    networkId,
                    claim.author,
                    action.post_id,
                    action.author_sequence,
                ) else return #err(#invalid);
                if (
                    not Blob.equal(action.tombstone_id, expectedTombstoneId) or
                    not Blob.equal(action.post_id, claim.post_id) or
                    not Blob.equal(
                        action.post_body_hash,
                        claim.body_hash,
                    ) or
                    not Blob.equal(
                        certified.ref.object_digest,
                        claim.object_digest,
                    ) or
                    Nat32.toNat(certified.ref.body_length) !=
                        certified.tombstone_action_candid.size() or
                    not Blob.equal(
                        certified.ref.object_digest,
                        Hash.sha256(
                            certified.tombstone_action_candid
                        ),
                    )
                ) return #err(#mismatch);
                #ok(#tombstone({
                    candidate_id = candidate.candidate_id;
                    key = {
                        author = claim.author;
                        post_id = claim.post_id;
                        body_hash = claim.body_hash;
                    };
                    tombstone_id = action.tombstone_id;
                    exact_tombstone_candid =
                        candidate.exact_event_candid;
                    verified_at_ns = verifiedAtNs;
                    retain_until_ns = retainUntilNs;
                }));
            };
        };
    };

    func verifiedPost(
        networkId : Blob,
        reference : Protocol.CertifiedPostRefV1,
        exactReferenceCandid : Blob,
        claim : VerifiedClaim,
    ) : {
        #ok : Types.VerifiedPost;
        #err : Error;
    } {
        if (not Validation.certifiedPostRefValue(reference)) {
            return #err(#invalid);
        };
        let ?expectedPostId = Hash.postId(
            networkId,
            reference.author,
            reference.body_hash,
        ) else return #err(#invalid);
        if (
            not Blob.equal(reference.post_id, expectedPostId) or
            not Principal.equal(reference.author, claim.author) or
            not Blob.equal(reference.post_id, claim.post_id) or
            not Blob.equal(reference.body_hash, claim.body_hash) or
            not Blob.equal(
                reference.object_digest,
                claim.object_digest,
            )
        ) return #err(#mismatch);
        #ok({
            key = {
                author = reference.author;
                post_id = reference.post_id;
                body_hash = reference.body_hash;
            };
            body_length = reference.body_length;
            object_digest = reference.object_digest;
            exact_certified_post_ref_candid = exactReferenceCandid;
            certified_ref = reference;
        });
    };
};
