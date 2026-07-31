import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat32 "mo:core/Nat32";
import Principal "mo:core/Principal";

import ActionPlanner "../actions/Planner";
import Bounds "../protocol/Bounds";
import Hash "../protocol/Hash";
import Protocol "../protocol/Types";

// Paid Like ingress uses this module only for bounded structural admission,
// semantic dedupe and segment append. It never verifies a remote certificate,
// encodes a batch, or mutates the certified tree.
module {
    let MAX_NAT64 : Nat64 = 18_446_744_073_709_551_615;

    public type AcceptedLike = {
        accepted_sequence : Nat64;
        accepted_at_ns : Nat64;
        liker : Principal;
        like_id : Blob;
        receipt : Protocol.CertifiedLikeReceiptV1;
        exact_receipt_candid : Blob;
        receipt_digest : Blob;
    };

    public type Segments = {
        due : ?[AcceptedLike];
        active : [AcceptedLike];
    };

    public type ValidReceipt = {
        action : Protocol.LikeActionV1;
        receipt : Protocol.CertifiedLikeReceiptV1;
        exact_receipt_candid : Blob;
        receipt_digest : Blob;
    };

    public type ValidationInput = {
        caller : Principal;
        network_id : Blob;
        post_author : Principal;
        post_id : Blob;
        post_body_hash : Blob;
        action : Protocol.LikeActionV1;
        receipt : Protocol.CertifiedLikeReceiptV1;
        exact_receipt_candid : Blob;
    };

    public type AdmissionInput = ValidationInput and {
        accepted_at_ns : Nat64;
        next_accepted_sequence : Nat64;
        existing_receipt_digest : ?Blob;
        segments : Segments;
        accepting_likes : Bool;
        blocked : Bool;
    };

    public type Error = {
        #invalid;
        #blocked;
        #closed;
        #sequence_exhausted;
        #corrupt_state;
    };

    public type ValidationResult = {
        #ok : ValidReceipt;
        #err : Error;
    };

    public type Decision = {
        #accepted : {
            accepted : AcceptedLike;
            segments : Segments;
            next_accepted_sequence : Nat64;
            seal_due : Bool;
        };
        #duplicate : {
            receipt_digest : Blob;
        };
        #conflict;
        #full;
        #rejected : Error;
    };

    public func emptySegments() : Segments {
        { due = null; active = [] };
    };

    public func validateReceipt(input : ValidationInput) : ValidationResult {
        if (
            not Principal.isCanister(input.caller) or
            not Principal.isCanister(input.post_author) or
            input.network_id.size() != Bounds.HASH_BYTES or
            input.post_id.size() != Bounds.HASH_BYTES or
            input.post_body_hash.size() != Bounds.HASH_BYTES or
            input.exact_receipt_candid.size() >
                Bounds.MAX_LIKE_RECEIPT_CANDID_BYTES or
            input.receipt.like_action_candid.size() >
                Bounds.MAX_ACTION_OBJECT_BYTES or
            not Principal.equal(input.action.header.actor_, input.caller) or
            input.action.header.action_kind != ?#like or
            not Blob.equal(
                input.action.header.network_id,
                input.network_id,
            ) or
            not Principal.equal(
                input.action.post_author,
                input.post_author,
            ) or
            not Blob.equal(input.action.post_id, input.post_id) or
            not Blob.equal(
                input.action.post_body_hash,
                input.post_body_hash,
            ) or
            not Principal.equal(input.receipt.ref.actor_, input.caller) or
            input.receipt.ref.action_kind != ?#like or
            input.receipt.ref.body_length != Nat32.fromNat(
                input.receipt.like_action_candid.size()
            ) or
            not Blob.equal(
                input.receipt.ref.object_digest,
                Hash.objectDigest(input.receipt.like_action_candid),
            ) or
            not ActionPlanner.validProof(
                input.receipt.ref.proof_snapshot
            )
        ) return #err(#invalid);

        let ?expectedLikeId = Hash.likeId(
            input.network_id,
            input.caller,
            input.post_author,
            input.post_id,
        ) else return #err(#invalid);
        if (not Blob.equal(input.action.like_id, expectedLikeId)) {
            return #err(#invalid);
        };
        #ok({
            action = input.action;
            receipt = input.receipt;
            exact_receipt_candid = input.exact_receipt_candid;
            receipt_digest = Hash.sha256(input.exact_receipt_candid);
        });
    };

    public func admit(input : AdmissionInput) : Decision {
        let valid = switch (validateReceipt(input)) {
            case (#err(error)) return #rejected(error);
            case (#ok(value)) value;
        };
        if (not validSegmentShape(input.segments)) {
            return #rejected(#corrupt_state);
        };

        // The durable caller index is authoritative even after its receipt has
        // moved into a sealed batch. A defensive segment scan also prevents a
        // missing index row from admitting a second receipt.
        switch (input.existing_receipt_digest) {
            case (?existing) {
                if (Blob.equal(existing, valid.receipt_digest)) {
                    return #duplicate({ receipt_digest = existing });
                };
                return #conflict;
            };
            case null {};
        };
        switch (receiptForLiker(input.segments, input.caller)) {
            case (?existing) {
                if (Blob.equal(existing, valid.receipt_digest)) {
                    return #duplicate({ receipt_digest = existing });
                };
                return #conflict;
            };
            case null {};
        };

        if (input.blocked) return #rejected(#blocked);
        if (not input.accepting_likes) return #rejected(#closed);
        if (input.next_accepted_sequence == MAX_NAT64) {
            return #rejected(#sequence_exhausted);
        };

        let accepted : AcceptedLike = {
            accepted_sequence = input.next_accepted_sequence;
            accepted_at_ns = input.accepted_at_ns;
            liker = input.caller;
            like_id = valid.action.like_id;
            receipt = valid.receipt;
            exact_receipt_candid = valid.exact_receipt_candid;
            receipt_digest = valid.receipt_digest;
        };
        let appended = Array.concat<AcceptedLike>(
            input.segments.active,
            [accepted],
        );
        if (appended.size() == Bounds.LIKE_BATCH_RECEIPTS) {
            switch (input.segments.due) {
                case (?_) return #full;
                case null {
                    return #accepted({
                        accepted;
                        segments = {
                            due = ?appended;
                            active = [];
                        };
                        next_accepted_sequence =
                            input.next_accepted_sequence + 1;
                        seal_due = true;
                    });
                };
            };
        };
        if (appended.size() > Bounds.MAX_FINAL_PARTIAL_RECEIPTS) {
            return #rejected(#corrupt_state);
        };
        #accepted({
            accepted;
            segments = {
                due = input.segments.due;
                active = appended;
            };
            next_accepted_sequence = input.next_accepted_sequence + 1;
            seal_due = false;
        });
    };

    public func unsealedCount(segments : Segments) : Nat {
        let dueCount = switch (segments.due) {
            case null 0;
            case (?due) due.size();
        };
        dueCount + segments.active.size();
    };

    func validSegmentShape(segments : Segments) : Bool {
        if (
            segments.active.size() >
                Bounds.MAX_FINAL_PARTIAL_RECEIPTS
        ) return false;
        let dueCount = switch (segments.due) {
            case null 0;
            case (?due) {
                if (due.size() != Bounds.LIKE_BATCH_RECEIPTS) {
                    return false;
                };
                due.size();
            };
        };
        dueCount + segments.active.size() <=
            Bounds.MAX_UNSEALED_LIKE_RECEIPTS;
    };

    func receiptForLiker(
        segments : Segments,
        liker : Principal,
    ) : ?Blob {
        switch (segments.due) {
            case (?due) {
                for (accepted in due.vals()) {
                    if (Principal.equal(accepted.liker, liker)) {
                        return ?accepted.receipt_digest;
                    };
                };
            };
            case null {};
        };
        for (accepted in segments.active.vals()) {
            if (Principal.equal(accepted.liker, liker)) {
                return ?accepted.receipt_digest;
            };
        };
        null;
    };
};
