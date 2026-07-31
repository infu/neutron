import Blob "mo:core/Blob";
import Nat "mo:core/Nat";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Set "mo:core/Set";

import Caps "mo:neutron-capabilities";

import Planner "../actions/Planner";
import Publication "../actions/Publication";
import Admission "../likes/Admission";
import Sealing "../likes/Sealing";
import Bounds "../protocol/Bounds";
import Hash "../protocol/Hash";
import Protocol "../protocol/Types";
import Types "Types";

module {
    let MAX_NAT64 : Nat64 = 18_446_744_073_709_551_615;

    public type RetentionPage = {
        first_receipt : Nat;
        past_receipt : Nat;
        include_batch : Bool;
        next : ?{
            batch_number : Nat64;
            receipt_offset : Nat64;
        };
    };

    // A withdrawal walks one authored post's sealed-batch index. The two
    // durable closing cursors are the batch number and receipt offset, so no
    // page ever scans the global accepted-Like index looking for a match.
    public func retentionPage(
        batchNumber : Nat64,
        sealedBatchCount : Nat64,
        receiptOffset : Nat64,
        receiptCount : Nat,
        limit : Nat,
    ) : ?RetentionPage {
        if (
            limit == 0 or
            receiptCount == 0 or
            receiptCount > 150 or
            batchNumber >= sealedBatchCount or
            receiptOffset > Nat64.fromNat(receiptCount)
        ) return null;
        let first = Nat64.toNat(receiptOffset);
        let past = Nat.min(receiptCount, first + limit);
        let includeBatch =
            past == receiptCount and past - first < limit;
        let next = if (includeBatch) {
            if (batchNumber + 1 == sealedBatchCount) null
            else ?{
                batch_number = batchNumber + 1;
                receipt_offset = (0 : Nat64);
            };
        } else {
            ?{
                batch_number = batchNumber;
                receipt_offset = Nat64.fromNat(past);
            };
        };
        ?{
            first_receipt = first;
            past_receipt = past;
            include_batch = includeBatch;
            next;
        };
    };

    public func planStart(
        input : Types.StartInput
    ) : Types.Result<Types.StartPlan> {
        if (not validSegments(input.segments)) {
            return #err(#invalid_segments);
        };
        if (
            not validTombstonePlan(input.tombstone_plan) or
            not matchingPost(
                input.tombstone_plan,
                input.head,
            )
        ) return #err(#invalid_post_binding);

        let certified = switch (
            Planner.finalizeTombstone(
                input.tombstone_plan,
                input.proof,
            )
        ) {
            case (#err(error)) return #err(#planner(error));
            case (#ok(value)) value;
        };
        let exactTombstoneCandid = to_candid (certified);
        if (
            not validCertifiedTombstone(
                input.tombstone_plan,
                certified,
                exactTombstoneCandid,
            )
        ) return #err(#invalid_tombstone);

        let stop = switch (
            Sealing.planStopAccepting({
                head = input.head;
                publication_nonce = input.publication_nonce;
            })
        ) {
            case (#err(error)) return #err(#sealing(error));
            case (#ok(value)) value;
        };
        #ok({
            phase = #stop_likes;
            tombstone_plan = input.tombstone_plan;
            certified_tombstone = certified;
            exact_tombstone_candid = exactTombstoneCandid;
            follower_registration_cutoff =
                input.follower_registration_cutoff;
            segments = input.segments;
            started_at_ns = input.started_at_ns;
            stop;
            commit = stop.commit;
        });
    };

    // This callback is deliberately deterministic. Main may retain StartPlan
    // before capability invocation and run this again with an idempotent
    // kernel receipt after a lost response or upgrade.
    public func reconcileStart(
        plan : Types.StartPlan,
        receipt : Caps.BatchReceipt,
    ) : Types.Result<Types.StartReconciliation> {
        if (
            plan.phase != #stop_likes or
            receipt.operations.size() != 1 or
            not validSegments(plan.segments) or
            not validTombstonePlan(plan.tombstone_plan) or
            not validCertifiedTombstone(
                plan.tombstone_plan,
                plan.certified_tombstone,
                plan.exact_tombstone_candid,
            )
        ) return #err(#invalid_state);
        let headIdentity = switch (
            Sealing.reconcileStop(plan.stop, receipt)
        ) {
            case (#err(error)) return #err(#sealing(error));
            case (#ok(value)) value;
        };
        let head = Types.storedHead(
            plan.stop.next_head,
            plan.stop.next_head_candid,
            headIdentity,
        );
        if (
            head.value.accepting_likes or
            not matchingPost(plan.tombstone_plan, head)
        ) return #err(#invalid_state);
        let nextPhase = switch (phaseForSegments(plan.segments)) {
            case null return #err(#invalid_segments);
            case (?value) value;
        };
        #ok({
            closing = {
                tombstone_id =
                    plan.tombstone_plan.tombstone_id;
                certified_tombstone =
                    plan.certified_tombstone;
                exact_tombstone_candid =
                    plan.exact_tombstone_candid;
                follower_registration_cutoff =
                    plan.follower_registration_cutoff;
                head;
                segments = plan.segments;
                phase = nextPhase;
                started_at_ns = plan.started_at_ns;
                updated_at_ns = plan.started_at_ns;
            };
            head_identity = headIdentity;
        });
    };

    public func planNext(
        input : Types.AdvanceInput
    ) : Types.Result<Types.AdvancePlan> {
        let closing = input.closing;
        if (closing.phase == #complete) {
            return #err(#already_complete);
        };
        if (
            input.updated_at_ns < closing.updated_at_ns or
            not validClosing(closing)
        ) return #err(
            if (input.updated_at_ns < closing.updated_at_ns) {
                #invalid_time;
            } else #invalid_state
        );
        let expectedPhase = switch (
            phaseForSegments(closing.segments)
        ) {
            case null return #err(#invalid_segments);
            case (?value) value;
        };
        if (closing.phase != expectedPhase) {
            return #err(#invalid_state);
        };

        switch (closing.phase) {
            case (#seal_due) {
                planSeal(input, #due);
            };
            case (#seal_final_partial) {
                planSeal(input, #final_partial);
            };
            case (#ready_for_fanout) {
                if (Admission.unsealedCount(closing.segments) != 0) {
                    return #err(#invalid_state);
                };
                let suppression : Types.SuppressionPlan = {
                    author = closing.head.value.post_author;
                    post_id = closing.head.value.post_id;
                    post_body_hash =
                        closing.head.value.post_body_hash;
                    tombstone_id = closing.tombstone_id;
                    exact_tombstone_candid =
                        closing.exact_tombstone_candid;
                    withdrawn_at_ns = input.updated_at_ns;
                };
                let fanout : Types.FanoutPlan = {
                    tombstone_id = closing.tombstone_id;
                    exact_event_candid =
                        closing.exact_tombstone_candid;
                    follower_registration_cutoff =
                        closing.follower_registration_cutoff;
                    created_at_ns = input.updated_at_ns;
                };
                #ok(#finalize({
                    previous = closing;
                    suppression;
                    fanout;
                    next = {
                        closing with
                        phase = #complete;
                        updated_at_ns = input.updated_at_ns;
                    };
                }));
            };
            // Neither phase can occur in a reconciled ClosingState.
            case (#stop_likes or #complete) #err(#invalid_state);
        };
    };

    // Like reconcileStart, this can be called repeatedly with the same
    // retained plan and receipt. It does not mutate state or invoke a
    // capability; main commits the returned state and sealed-batch metadata
    // atomically after validation succeeds.
    public func reconcileSeal(
        plan : Types.SealPlan,
        receipt : Caps.BatchReceipt,
    ) : Types.Result<Types.SealReconciliation> {
        if (
            receipt.operations.size() != 2 or
            plan.updated_at_ns < plan.previous.updated_at_ns or
            not validClosing(plan.previous) or
            plan.previous.phase == #ready_for_fanout or
            plan.previous.phase == #complete or
            plan.previous.phase == #stop_likes
        ) return #err(#invalid_state);
        switch (plan.previous.phase, plan.sealing.mode) {
            case (#seal_due, #due) {};
            case (#seal_final_partial, #final_partial) {};
            case (_) return #err(#invalid_state);
        };
        let publication = switch (
            Sealing.reconcileSeal(plan.sealing, receipt)
        ) {
            case (#err(error)) return #err(#sealing(error));
            case (#ok(value)) value;
        };
        let nextHead = Types.storedHead(
            plan.sealing.next_head,
            plan.sealing.next_head_candid,
            publication.head_identity,
        );
        let nextPhase = switch (
            phaseForSegments(plan.sealing.next_segments)
        ) {
            case null return #err(#invalid_segments);
            case (?value) value;
        };
        let closing : Types.ClosingState = {
            plan.previous with
            head = nextHead;
            segments = plan.sealing.next_segments;
            phase = nextPhase;
            updated_at_ns = plan.updated_at_ns;
        };
        if (not validClosing(closing)) {
            return #err(#invalid_state);
        };
        #ok({
            closing;
            batch_identity = publication.batch_identity;
            head_identity = publication.head_identity;
        });
    };

    func planSeal(
        input : Types.AdvanceInput,
        mode : Sealing.SealMode,
    ) : Types.Result<Types.AdvancePlan> {
        let sealingInput : Sealing.SealInput = {
            head = input.closing.head;
            segments = input.closing.segments;
            like_batches_generation =
                input.like_batches_generation;
            publication_nonce = input.publication_nonce;
        };
        let sealing = switch (mode) {
            case (#due) Sealing.planDue(sealingInput);
            case (#open_partial) return #err(#invalid_state);
            case (#final_partial) {
                Sealing.planFinalPartial(sealingInput);
            };
        };
        switch (sealing) {
            case (#err(error)) #err(#sealing(error));
            case (#ok(plan)) {
                #ok(#publish({
                    previous = input.closing;
                    sealing = plan;
                    updated_at_ns = input.updated_at_ns;
                    commit = plan.commit;
                }));
            };
        };
    };

    func phaseForSegments(
        segments : Admission.Segments
    ) : ?Types.Phase {
        if (not validSegments(segments)) return null;
        switch (segments.due) {
            case (?_) ?#seal_due;
            case null {
                if (segments.active.size() > 0) {
                    ?#seal_final_partial;
                } else ?#ready_for_fanout;
            };
        };
    };

    func validClosing(value : Types.ClosingState) : Bool {
        if (
            value.phase == #stop_likes or
            value.updated_at_ns < value.started_at_ns or
            value.head.value.accepting_likes or
            not validSegments(value.segments) or
            value.tombstone_id.size() != Bounds.HASH_BYTES or
            not Blob.equal(
                value.exact_tombstone_candid,
                to_candid (value.certified_tombstone),
            ) or
            value.exact_tombstone_candid.size() >
                Bounds.DELIVER.max_request_bytes or
            not validHead(value.head)
        ) return false;
        let action : ?Protocol.TombstoneActionV1 = from_candid (
            value.certified_tombstone.tombstone_action_candid
        );
        let ?decoded = action else return false;
        let ?expectedTombstoneId = Hash.tombstoneId(
            decoded.header.network_id,
            decoded.header.actor_,
            decoded.post_id,
            decoded.author_sequence,
        ) else return false;
        decoded.header.action_kind == ?#tombstone and
        Blob.equal(decoded.tombstone_id, expectedTombstoneId) and
        Blob.equal(decoded.tombstone_id, value.tombstone_id) and
        value.certified_tombstone.tombstone_action_candid.size() <=
            Bounds.MAX_ACTION_OBJECT_BYTES and
        Principal.equal(
            value.certified_tombstone.ref.actor_,
            decoded.header.actor_,
        ) and
        value.certified_tombstone.ref.action_kind == ?#tombstone and
        Blob.equal(
            value.certified_tombstone.ref.object_digest,
            Hash.objectDigest(
                value.certified_tombstone.tombstone_action_candid
            ),
        ) and
        value.certified_tombstone.ref.body_length ==
            Nat32.fromNat(
                value.certified_tombstone.tombstone_action_candid.size()
            ) and
        Planner.validProof(
            value.certified_tombstone.ref.proof_snapshot
        ) and
        Principal.equal(
            decoded.header.actor_,
            value.head.value.post_author,
        ) and
        Blob.equal(
            decoded.header.network_id,
            value.head.value.network_id,
        ) and
        Blob.equal(decoded.post_id, value.head.value.post_id) and
        Blob.equal(
            decoded.post_body_hash,
            value.head.value.post_body_hash,
        );
    };

    func validTombstonePlan(plan : Planner.TombstonePlan) : Bool {
        let value = plan.value;
        if (
            value.header.network_id.size() != Bounds.HASH_BYTES or
            not Principal.isCanister(value.header.actor_) or
            value.header.action_kind != ?#tombstone or
            value.tombstone_id.size() != Bounds.HASH_BYTES or
            value.post_id.size() != Bounds.HASH_BYTES or
            value.post_body_hash.size() != Bounds.HASH_BYTES or
            plan.body_candid.size() > Bounds.MAX_ACTION_OBJECT_BYTES or
            not Blob.equal(plan.body_candid, to_candid (value)) or
            not Blob.equal(
                plan.object_digest,
                Hash.objectDigest(plan.body_candid),
            ) or
            not Blob.equal(plan.tombstone_id, value.tombstone_id)
        ) return false;
        let ?expectedId = Hash.tombstoneId(
            value.header.network_id,
            value.header.actor_,
            value.post_id,
            value.author_sequence,
        ) else return false;
        Blob.equal(expectedId, plan.tombstone_id) and
        Publication.sameTarget(
            plan.target,
            Publication.immutableTarget(
                Publication.TOMBSTONES_COLLECTION,
                plan.target.collection_generation,
                plan.object_digest,
            ),
        );
    };

    func validCertifiedTombstone(
        plan : Planner.TombstonePlan,
        certified : Protocol.CertifiedTombstoneV1,
        exact : Blob,
    ) : Bool {
        Blob.equal(
            certified.tombstone_action_candid,
            plan.body_candid,
        ) and
        Principal.equal(
            certified.ref.actor_,
            plan.value.header.actor_,
        ) and
        certified.ref.action_kind == ?#tombstone and
        Blob.equal(
            certified.ref.object_digest,
            plan.object_digest,
        ) and
        certified.ref.body_length ==
            Nat32.fromNat(plan.body_candid.size()) and
        Planner.validProof(certified.ref.proof_snapshot) and
        exact.size() <= Bounds.DELIVER.max_request_bytes and
        Blob.equal(exact, to_candid (certified));
    };

    func matchingPost(
        tombstone : Planner.TombstonePlan,
        head : Sealing.HeadState,
    ) : Bool {
        Principal.equal(
            tombstone.value.header.actor_,
            head.value.post_author,
        ) and
        Blob.equal(
            tombstone.value.header.network_id,
            head.value.network_id,
        ) and
        Blob.equal(tombstone.value.post_id, head.value.post_id) and
        Blob.equal(
            tombstone.value.post_body_hash,
            head.value.post_body_hash,
        );
    };

    func validHead(head : Sealing.HeadState) : Bool {
        let value = head.value;
        if (
            value.network_id.size() != Bounds.HASH_BYTES or
            not Principal.isCanister(value.post_author) or
            value.post_id.size() != Bounds.HASH_BYTES or
            value.post_body_hash.size() != Bounds.HASH_BYTES or
            head.exact_body_candid.size() >
                Bounds.MAX_LIKE_HEAD_BYTES or
            not Blob.equal(
                head.exact_body_candid,
                to_candid (value),
            ) or
            head.kernel_identity.body_bytes !=
                head.exact_body_candid.size() or
            not Blob.equal(
                head.kernel_identity.content_tag,
                Hash.objectDigest(head.exact_body_candid),
            ) or
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
            case (null, null) value.sealed_batch_count == 0;
            case (?number, ?digest) {
                digest.size() == Bounds.HASH_BYTES and
                number < MAX_NAT64 and
                value.sealed_batch_count == number + 1;
            };
            case (_) false;
        };
    };

    func validSegments(segments : Admission.Segments) : Bool {
        if (
            segments.active.size() >
                Bounds.MAX_FINAL_PARTIAL_RECEIPTS
        ) return false;
        switch (segments.due) {
            case (?due) {
                if (due.size() != Bounds.LIKE_BATCH_RECEIPTS) {
                    return false;
                };
            };
            case null {};
        };
        if (
            Admission.unsealedCount(segments) >
                Bounds.MAX_UNSEALED_LIKE_RECEIPTS
        ) return false;

        let likers = Set.empty<Principal>();
        let likeIds = Set.empty<Blob>();
        let acceptedSequences = Set.empty<Nat64>();
        var largestDue : ?Nat64 = null;
        switch (segments.due) {
            case (?due) {
                for (entry in due.vals()) {
                    if (
                        not validEntry(entry) or
                        not Set.insert(
                            likers,
                            Principal.compare,
                            entry.liker,
                        ) or
                        not Set.insert(
                            likeIds,
                            Blob.compare,
                            entry.like_id,
                        ) or
                        not Set.insert(
                            acceptedSequences,
                            Nat64.compare,
                            entry.accepted_sequence,
                        )
                    ) return false;
                    switch (largestDue) {
                        case (?value) {
                            if (entry.accepted_sequence > value) {
                                largestDue :=
                                    ?entry.accepted_sequence;
                            };
                        };
                        case null {
                            largestDue := ?entry.accepted_sequence;
                        };
                    };
                };
            };
            case null {};
        };
        for (entry in segments.active.vals()) {
            if (
                not validEntry(entry) or
                not Set.insert(
                    likers,
                    Principal.compare,
                    entry.liker,
                ) or
                not Set.insert(
                    likeIds,
                    Blob.compare,
                    entry.like_id,
                ) or
                not Set.insert(
                    acceptedSequences,
                    Nat64.compare,
                    entry.accepted_sequence,
                )
            ) return false;
            switch (largestDue) {
                case (?value) {
                    if (entry.accepted_sequence <= value) {
                        return false;
                    };
                };
                case null {};
            };
        };
        true;
    };

    func validEntry(entry : Admission.AcceptedLike) : Bool {
        Principal.isCanister(entry.liker) and
        entry.like_id.size() == Bounds.HASH_BYTES and
        entry.receipt_digest.size() == Bounds.HASH_BYTES and
        entry.exact_receipt_candid.size() <=
            Bounds.MAX_LIKE_RECEIPT_CANDID_BYTES and
        Blob.equal(
            entry.exact_receipt_candid,
            to_candid (entry.receipt),
        ) and
        Blob.equal(
            entry.receipt_digest,
            Hash.sha256(entry.exact_receipt_candid),
        ) and
        Principal.equal(
            entry.receipt.ref.actor_,
            entry.liker,
        ) and
        entry.receipt.ref.action_kind == ?#like and
        entry.receipt.ref.body_length ==
            Nat32.fromNat(
                entry.receipt.like_action_candid.size()
            ) and
        Blob.equal(
            entry.receipt.ref.object_digest,
            Hash.objectDigest(
                entry.receipt.like_action_candid
            ),
        );
    };

};
