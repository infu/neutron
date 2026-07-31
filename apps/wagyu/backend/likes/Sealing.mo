import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Set "mo:core/Set";

import Caps "mo:neutron-capabilities";

import Publication "../actions/Publication";
import Bounds "../protocol/Bounds";
import Hash "../protocol/Hash";
import Protocol "../protocol/Types";
import Admission "Admission";

// Like certification runs outside paid ingress. These functions create an
// immutable batch plus exact Like-head CAS plan, but never invoke the kernel.
module {
    let MAX_NAT64 : Nat64 = 18_446_744_073_709_551_615;

    public type Error = {
        #invalid_nonce;
        #invalid_head;
        #invalid_segment;
        #nothing_to_seal;
        #due_must_seal_first;
        #not_open;
        #not_closing;
        #already_closed;
        #counter_exhausted;
        #object_too_large;
        #batch_too_large;
        #invalid_kernel_receipt;
    };

    public type Result<T> = {
        #ok : T;
        #err : Error;
    };

    public type HeadState = {
        value : Protocol.LikeHeadV1;
        exact_body_candid : Blob;
        kernel_identity : Publication.StoredIdentity;
    };

    public type SealInput = {
        head : HeadState;
        segments : Admission.Segments;
        like_batches_generation : Nat64;
        publication_nonce : Blob;
    };

    public type SealMode = {
        #due;
        // V101 publishes a verified sub-150 active segment while the post
        // remains open. The frozen wire field is still named final_partial,
        // but now denotes any immutable partial-sized package.
        #open_partial;
        #final_partial;
    };

    public type SealPlan = {
        mode : SealMode;
        previous_head : HeadState;
        batch : Protocol.LikeBatchV1;
        batch_candid : Blob;
        batch_digest : Blob;
        batch_target : Caps.Target;
        sealed_entries : [Admission.AcceptedLike];
        next_segments : Admission.Segments;
        next_head : Protocol.LikeHeadV1;
        next_head_candid : Blob;
        next_head_digest : Blob;
        head_target : Caps.Target;
        commit : Caps.CommitBatchInput;
    };

    public type SealPublication = {
        batch_identity : Caps.RecordIdentity;
        head_identity : Caps.RecordIdentity;
    };

    public type StopInput = {
        head : HeadState;
        publication_nonce : Blob;
    };

    public type StopPlan = {
        previous_head : HeadState;
        next_head : Protocol.LikeHeadV1;
        next_head_candid : Blob;
        next_head_digest : Blob;
        head_target : Caps.Target;
        commit : Caps.CommitBatchInput;
    };

    public func planDue(input : SealInput) : Result<SealPlan> {
        let ?due = input.segments.due else {
            return #err(#nothing_to_seal);
        };
        plan(input, #due, due);
    };

    public func planFinalPartial(input : SealInput) : Result<SealPlan> {
        switch (input.segments.due) {
            case (?_) return #err(#due_must_seal_first);
            case null {};
        };
        if (input.head.value.accepting_likes) {
            return #err(#not_closing);
        };
        if (input.segments.active.size() == 0) {
            return #err(#nothing_to_seal);
        };
        plan(input, #final_partial, input.segments.active);
    };

    public func planOpenPartial(input : SealInput) : Result<SealPlan> {
        switch (input.segments.due) {
            case (?_) return #err(#due_must_seal_first);
            case null {};
        };
        if (not input.head.value.accepting_likes) {
            return #err(#not_open);
        };
        if (input.segments.active.size() == 0) {
            return #err(#nothing_to_seal);
        };
        plan(input, #open_partial, input.segments.active);
    };

    public func planStopAccepting(input : StopInput) : Result<StopPlan> {
        if (not Publication.validNonce(input.publication_nonce)) {
            return #err(#invalid_nonce);
        };
        if (not validHead(input.head)) return #err(#invalid_head);
        if (not input.head.value.accepting_likes) {
            return #err(#already_closed);
        };
        if (input.head.value.revision == MAX_NAT64) {
            return #err(#counter_exhausted);
        };
        let priorDigest = Hash.objectDigest(
            input.head.exact_body_candid
        );
        let nextHead : Protocol.LikeHeadV1 = {
            input.head.value with
            revision = input.head.value.revision + 1;
            previous_head_hash = ?priorDigest;
            accepting_likes = false;
        };
        let nextHeadCandid = to_candid (nextHead);
        if (nextHeadCandid.size() > Bounds.MAX_LIKE_HEAD_BYTES) {
            return #err(#object_too_large);
        };
        let nextHeadDigest = Hash.objectDigest(nextHeadCandid);
        let target = input.head.kernel_identity.target;
        let commit : Caps.CommitBatchInput = {
            nonce = input.publication_nonce;
            operations = [
                Publication.put(
                    target,
                    Publication.cas(input.head.kernel_identity),
                    #inline(nextHeadCandid),
                ),
            ];
            requires_present_after = [];
        };
        #ok({
            previous_head = input.head;
            next_head = nextHead;
            next_head_candid = nextHeadCandid;
            next_head_digest = nextHeadDigest;
            head_target = target;
            commit;
        });
    };

    public func reconcileSeal(
        plan : SealPlan,
        receipt : Caps.BatchReceipt,
    ) : Result<SealPublication> {
        let ?batchIdentity = Publication.committedAt(
            receipt,
            0,
            plan.batch_target,
            plan.batch_digest,
            plan.batch_candid.size(),
        ) else return #err(#invalid_kernel_receipt);
        let ?headIdentity = Publication.committedAt(
            receipt,
            1,
            plan.head_target,
            plan.next_head_digest,
            plan.next_head_candid.size(),
        ) else return #err(#invalid_kernel_receipt);
        #ok({
            batch_identity = batchIdentity;
            head_identity = headIdentity;
        });
    };

    public func reconcileStop(
        plan : StopPlan,
        receipt : Caps.BatchReceipt,
    ) : Result<Caps.RecordIdentity> {
        let ?identity = Publication.committedAt(
            receipt,
            0,
            plan.head_target,
            plan.next_head_digest,
            plan.next_head_candid.size(),
        ) else return #err(#invalid_kernel_receipt);
        #ok(identity);
    };

    func plan(
        input : SealInput,
        mode : SealMode,
        entries : [Admission.AcceptedLike],
    ) : Result<SealPlan> {
        if (not Publication.validNonce(input.publication_nonce)) {
            return #err(#invalid_nonce);
        };
        if (not validHead(input.head)) return #err(#invalid_head);
        switch (mode) {
            case (#due) {
                if (entries.size() != Bounds.LIKE_BATCH_RECEIPTS) {
                    return #err(#invalid_segment);
                };
            };
            case (#open_partial or #final_partial) {
                if (
                    entries.size() == 0 or
                    entries.size() >
                        Bounds.MAX_FINAL_PARTIAL_RECEIPTS
                ) return #err(#invalid_segment);
            };
        };
        if (
            input.head.value.revision == MAX_NAT64 or
            input.head.value.sealed_batch_count == MAX_NAT64
        ) return #err(#counter_exhausted);

        let sorted = Array.sort<Admission.AcceptedLike>(
            entries,
            compareAccepted,
        );
        if (not validEntries(input.head.value, sorted)) {
            return #err(#invalid_segment);
        };
        let ?nextReceiptCount = addNat64(
            input.head.value.sealed_receipt_count,
            sorted.size(),
        ) else return #err(#counter_exhausted);
        let batchNumber = input.head.value.sealed_batch_count;
        let batch : Protocol.LikeBatchV1 = {
            network_id = input.head.value.network_id;
            post_author = input.head.value.post_author;
            post_id = input.head.value.post_id;
            post_body_hash = input.head.value.post_body_hash;
            batch_number = batchNumber;
            previous_batch_digest =
                input.head.value.latest_batch_digest;
            first_accepted_sequence =
                sorted[0].accepted_sequence;
            last_accepted_sequence =
                sorted[sorted.size() - 1].accepted_sequence;
            final_partial = mode != #due;
            receipts = Array.map<
                Admission.AcceptedLike,
                Protocol.CertifiedLikeReceiptV1
            >(sorted, func(entry) { entry.receipt });
        };
        let batchCandid = to_candid (batch);
        if (batchCandid.size() > Bounds.MAX_LIKE_BATCH_BYTES) {
            return #err(#object_too_large);
        };
        let batchDigest = Hash.objectDigest(batchCandid);
        let batchTarget = Publication.immutableTarget(
            Publication.LIKE_BATCHES_COLLECTION,
            input.like_batches_generation,
            batchDigest,
        );
        let priorHeadDigest = Hash.objectDigest(
            input.head.exact_body_candid
        );
        let nextHead : Protocol.LikeHeadV1 = {
            input.head.value with
            revision = input.head.value.revision + 1;
            previous_head_hash = ?priorHeadDigest;
            latest_batch_number = ?batchNumber;
            latest_batch_digest = ?batchDigest;
            sealed_batch_count =
                input.head.value.sealed_batch_count + 1;
            sealed_receipt_count = nextReceiptCount;
        };
        let nextHeadCandid = to_candid (nextHead);
        if (nextHeadCandid.size() > Bounds.MAX_LIKE_HEAD_BYTES) {
            return #err(#object_too_large);
        };
        if (
            batchCandid.size() + nextHeadCandid.size() >
                Bounds.MAX_CERTIFIED_BATCH_BYTES
        ) return #err(#batch_too_large);
        let nextHeadDigest = Hash.objectDigest(nextHeadCandid);
        let headTarget = input.head.kernel_identity.target;
        let nextSegments : Admission.Segments = switch (mode) {
            case (#due) {
                {
                    due = null;
                    active = input.segments.active;
                };
            };
            case (#open_partial or #final_partial) {
                {
                    due = null;
                    active = [];
                };
            };
        };
        let commit : Caps.CommitBatchInput = {
            nonce = input.publication_nonce;
            operations = [
                Publication.put(
                    batchTarget,
                    #absent,
                    #inline(batchCandid),
                ),
                Publication.put(
                    headTarget,
                    Publication.cas(input.head.kernel_identity),
                    #inline(nextHeadCandid),
                ),
            ];
            requires_present_after = [
                Publication.presentAfter(batchTarget, batchDigest),
            ];
        };
        #ok({
            mode;
            previous_head = input.head;
            batch;
            batch_candid = batchCandid;
            batch_digest = batchDigest;
            batch_target = batchTarget;
            sealed_entries = sorted;
            next_segments = nextSegments;
            next_head = nextHead;
            next_head_candid = nextHeadCandid;
            next_head_digest = nextHeadDigest;
            head_target = headTarget;
            commit;
        });
    };

    func validHead(head : HeadState) : Bool {
        let value = head.value;
        if (
            value.network_id.size() != Bounds.HASH_BYTES or
            not Principal.isCanister(value.post_author) or
            value.post_id.size() != Bounds.HASH_BYTES or
            value.post_body_hash.size() != Bounds.HASH_BYTES or
            head.exact_body_candid.size() >
                Bounds.MAX_LIKE_HEAD_BYTES or
            head.kernel_identity.body_bytes !=
                head.exact_body_candid.size() or
            not Blob.equal(
                head.kernel_identity.content_tag,
                Hash.objectDigest(head.exact_body_candid),
            ) or
            head.kernel_identity.target.collection !=
                Publication.LIKE_HEADS_COLLECTION or
            value.store_generation !=
                head.kernel_identity.target.collection_generation or
            not Publication.sameTarget(
                head.kernel_identity.target,
                Publication.likeHeadTarget(
                    value.store_generation,
                    value.post_id,
                ),
            )
        ) return false;
        switch (
            value.latest_batch_number,
            value.latest_batch_digest,
        ) {
            case (null, null) {
                value.sealed_batch_count == 0;
            };
            case (?number, ?digest) {
                digest.size() == Bounds.HASH_BYTES and
                number < MAX_NAT64 and
                value.sealed_batch_count == number + 1;
            };
            case (_) false;
        };
    };

    func validEntries(
        head : Protocol.LikeHeadV1,
        entries : [Admission.AcceptedLike],
    ) : Bool {
        let likers = Set.empty<Principal>();
        let ids = Set.empty<Blob>();
        var previousSequence : ?Nat64 = null;
        for (entry in entries.vals()) {
            switch (previousSequence) {
                case (?previous) {
                    if (entry.accepted_sequence <= previous) {
                        return false;
                    };
                };
                case null {};
            };
            if (
                not Principal.isCanister(entry.liker) or
                entry.like_id.size() != Bounds.HASH_BYTES or
                entry.receipt_digest.size() != Bounds.HASH_BYTES or
                entry.exact_receipt_candid.size() >
                    Bounds.MAX_LIKE_RECEIPT_CANDID_BYTES or
                not Blob.equal(
                    entry.receipt_digest,
                    Hash.sha256(entry.exact_receipt_candid),
                ) or
                not Principal.equal(
                    entry.receipt.ref.actor_,
                    entry.liker,
                ) or
                entry.receipt.ref.action_kind != ?#like or
                entry.receipt.ref.body_length !=
                    Nat32.fromNat(
                        entry.receipt.like_action_candid.size()
                    ) or
                not Blob.equal(
                    entry.receipt.ref.object_digest,
                    Hash.objectDigest(
                        entry.receipt.like_action_candid
                    ),
                ) or
                not Set.insert(likers, Principal.compare, entry.liker) or
                not Set.insert(ids, Blob.compare, entry.like_id)
            ) return false;
            previousSequence := ?entry.accepted_sequence;
        };
        entries.size() > 0 and
        head.network_id.size() == Bounds.HASH_BYTES;
    };

    func compareAccepted(
        left : Admission.AcceptedLike,
        right : Admission.AcceptedLike,
    ) : { #less; #equal; #greater } {
        Nat64.compare(
            left.accepted_sequence,
            right.accepted_sequence,
        );
    };

    func addNat64(value : Nat64, increment : Nat) : ?Nat64 {
        let natural = Nat64.toNat(value);
        let maximum = Nat64.toNat(MAX_NAT64);
        if (increment > maximum - natural) return null;
        ?Nat64.fromNat(natural + increment);
    };
};
