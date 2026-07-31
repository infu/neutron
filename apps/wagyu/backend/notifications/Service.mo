import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat "mo:core/Nat";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";

import Bounds "../protocol/Bounds";
import Types "Types";

module {
    public func append(
        store : Types.Store,
        request : Types.AppendRequest,
    ) : Types.AppendOutcome {
        if (not validAppend(request)) return #rejected(#invalid);

        let snapshot = store.snapshot();
        let key = semanticKey(request);
        switch (store.find_semantic(key)) {
            case (?existing) {
                let result : Types.Existing = {
                    revision = snapshot.revision;
                    local_sequence = existing.summary.local_sequence;
                };
                if (isExactDuplicate(existing, request)) {
                    return #duplicate(result);
                };
                return #conflict(result);
            };
            case null {};
        };

        if (snapshot.total_count >= Types.MAX_SUMMARIES) {
            return #rejected(#full(#total));
        };
        switch (request.event) {
            case (#notice(notice)) {
                if (
                    store.notice_count_for_actor(request.acting_node) >=
                    Types.MAX_NOTICE_SUMMARIES_PER_ACTOR
                ) return #rejected(#full(#notice_actor));
                if (
                    store.notice_count_for_target(
                        notice.locator.target_post_id
                    ) >= Types.MAX_NOTICE_SUMMARIES_PER_TARGET
                ) return #rejected(#full(#notice_target));
            };
            case (_) {};
        };
        if (
            snapshot.revision == Nat64.maxValue or
            snapshot.last_sequence == Nat64.maxValue
        ) return #rejected(#sequence_exhausted);

        let revision = snapshot.revision + 1;
        let summary : Types.NotificationSummaryV1 = {
            local_sequence = snapshot.last_sequence + 1;
            received_at_ns = request.received_at_ns;
            actor_ = request.acting_node;
            kind = ?summaryKind(request.event);
            verification = ?initialVerification(request.event);
            read = false;
        };
        let stored : Types.StoredNotification = {
            summary;
            like_evidence = switch (request.event) {
                case (#like(value)) {
                    ?value.certified_like_receipt_candid;
                };
                case (_) null;
            };
        };
        if (
            not store.commit_append({
                expected = snapshot;
                stored;
                semantic_key = key;
                revision;
            })
        ) return #rejected(#stale_state);
        #accepted({ revision; summary });
    };

    public func page(
        store : Types.Store,
        request : Types.NotificationPageRequestV1,
    ) : Types.PageResult {
        let wanted = Nat16.toNat(request.limit);
        if (wanted == 0 or wanted > Bounds.MAX_NOTIFICATION_PAGE_ITEMS) {
            return #err(#invalid_limit);
        };

        let snapshot = store.snapshot();
        let scanned = store.scan_descending(
            request.before_sequence,
            wanted + 1,
        );
        if (scanned.size() > wanted + 1) return #err(#corrupt_state);

        var previous = request.before_sequence;
        var index = 0;
        while (index < scanned.size()) {
            let sequence = scanned[index].summary.local_sequence;
            switch (previous) {
                case (?upperExclusive) {
                    if (sequence >= upperExclusive) {
                        return #err(#corrupt_state);
                    };
                };
                case null {};
            };
            if (not storageShapeValid(scanned[index])) {
                return #err(#corrupt_state);
            };
            previous := ?sequence;
            index += 1;
        };

        let count = Nat.min(wanted, scanned.size());
        let items = Array.tabulate<Types.NotificationSummaryV1>(
            count,
            func(itemIndex) {
                scanned[itemIndex].summary;
            },
        );
        let hasMore = scanned.size() > wanted;
        let nextBefore = if (hasMore and count > 0) {
            ?items[count - 1].local_sequence;
        } else {
            null;
        };
        #ok({
            revision = snapshot.revision;
            items;
            next_before_sequence = nextBefore;
        });
    };

    public func evidence(
        store : Types.Store,
        request : Types.NotificationEvidenceRequestV1,
    ) : Types.EvidenceResult {
        let ?stored = store.get(request.local_sequence) else {
            return #ok({
                local_sequence = request.local_sequence;
                found = false;
                evidence = null;
            });
        };
        if (stored.summary.local_sequence != request.local_sequence) {
            return #err(#corrupt_state);
        };
        switch (stored.summary.kind) {
            case (?#like(_)) {
                let ?exact = stored.like_evidence else {
                    return #err(#corrupt_state);
                };
                if (
                    exact.size() == 0 or
                    exact.size() > Bounds.MAX_LIKE_RECEIPT_CANDID_BYTES
                ) return #err(#corrupt_state);
                #ok({
                    local_sequence = request.local_sequence;
                    found = true;
                    evidence = ?#like({
                        certified_like_receipt_candid = exact;
                    });
                });
            };
            case (_) {
                if (stored.like_evidence != null) {
                    return #err(#corrupt_state);
                };
                #ok({
                    local_sequence = request.local_sequence;
                    found = true;
                    evidence = null;
                });
            };
        };
    };

    public func setVerification(
        store : Types.Store,
        request : Types.VerificationRequest,
    ) : Types.MutationOutcome {
        let snapshot = store.snapshot();
        let ?stored = store.get(request.local_sequence) else {
            return #err(#not_found);
        };
        let previous = stored.summary;
        if (previous.local_sequence != request.local_sequence) {
            return #err(#corrupt_state);
        };
        let ?kind = previous.kind else return #err(#incompatible);
        let ?current = previous.verification else {
            return #err(#incompatible);
        };

        switch (kind) {
            case (#new_follower(_)) {
                if (
                    current != #transport_authenticated or
                    request.verification != #transport_authenticated
                ) return #err(#invalid_transition);
            };
            case (#like(_) or #reply(_) or #share(_)) {
                if (
                    not actionTransitionAllowed(
                        current,
                        request.verification,
                    )
                ) return #err(#invalid_transition);
            };
        };
        if (current == request.verification) {
            return #unchanged({
                revision = snapshot.revision;
                summary = previous;
            });
        };
        mutate(
            store,
            snapshot,
            previous,
            {
                local_sequence = previous.local_sequence;
                received_at_ns = previous.received_at_ns;
                actor_ = previous.actor_;
                kind = previous.kind;
                verification = ?request.verification;
                read = previous.read;
            },
        );
    };

    public func markRead(
        store : Types.Store,
        localSequence : Nat64,
    ) : Types.MutationOutcome {
        let snapshot = store.snapshot();
        let ?stored = store.get(localSequence) else {
            return #err(#not_found);
        };
        let previous = stored.summary;
        if (previous.local_sequence != localSequence) {
            return #err(#corrupt_state);
        };
        if (previous.kind == null or previous.verification == null) {
            return #err(#incompatible);
        };
        if (previous.read) {
            return #unchanged({
                revision = snapshot.revision;
                summary = previous;
            });
        };
        mutate(
            store,
            snapshot,
            previous,
            {
                local_sequence = previous.local_sequence;
                received_at_ns = previous.received_at_ns;
                actor_ = previous.actor_;
                kind = previous.kind;
                verification = previous.verification;
                read = true;
            },
        );
    };

    func mutate(
        store : Types.Store,
        snapshot : Types.StoreSnapshot,
        previous : Types.NotificationSummaryV1,
        replacement : Types.NotificationSummaryV1,
    ) : Types.MutationOutcome {
        if (snapshot.revision == Nat64.maxValue) {
            return #err(#revision_exhausted);
        };
        let revision = snapshot.revision + 1;
        if (
            not store.commit_replace({
                expected_revision = snapshot.revision;
                previous;
                replacement;
                revision;
            })
        ) return #err(#stale_state);
        #changed({ revision; summary = replacement });
    };

    func semanticKey(request : Types.AppendRequest) : Types.SemanticKey {
        switch (request.event) {
            case (#new_follower(value)) {
                #new_follower({
                    acting_node = request.acting_node;
                    follower_revision = value.follower_revision;
                });
            };
            case (#like(value)) {
                #like({
                    acting_node = request.acting_node;
                    target_post_id = value.locator.target_post_id;
                });
            };
            case (#notice(value)) {
                #notice({
                    acting_node = request.acting_node;
                    relation = value.relation;
                    action_id = value.locator.action_id;
                });
            };
        };
    };

    func summaryKind(
        event : Types.AppendEvent
    ) : Types.NotificationKindV1 {
        switch (event) {
            case (#new_follower(value)) {
                #new_follower({
                    follower_revision = value.follower_revision;
                });
            };
            case (#like(value)) {
                #like(value.locator);
            };
            case (#notice(value)) {
                switch (value.relation) {
                    case (#reply) #reply(value.locator);
                    case (#share) #share(value.locator);
                };
            };
        };
    };

    func initialVerification(
        event : Types.AppendEvent
    ) : Types.NotificationVerificationV1 {
        switch (event) {
            case (#new_follower(_)) #transport_authenticated;
            case (#like(_) or #notice(_)) #pending;
        };
    };

    func validAppend(request : Types.AppendRequest) : Bool {
        switch (request.event) {
            case (#new_follower(_)) true;
            case (#like(value)) {
                validObject(
                    value.locator,
                    Bounds.MAX_ACTION_OBJECT_BYTES,
                ) and
                value.certified_like_receipt_candid.size() > 0 and
                value.certified_like_receipt_candid.size() <=
                Bounds.MAX_LIKE_RECEIPT_CANDID_BYTES;
            };
            case (#notice(value)) {
                let maximum = switch (value.relation) {
                    case (#reply) Bounds.MAX_POST_OBJECT_BYTES;
                    case (#share) Bounds.MAX_ACTION_OBJECT_BYTES;
                };
                validObject(value.locator, maximum);
            };
        };
    };

    func validObject(
        locator : Types.NotificationObjectV1,
        maximumLength : Nat,
    ) : Bool {
        locator.target_post_id.size() == Bounds.HASH_BYTES and
        locator.target_body_hash.size() == Bounds.HASH_BYTES and
        locator.action_id.size() == Bounds.HASH_BYTES and
        locator.object_digest.size() == Bounds.HASH_BYTES and
        Nat32.toNat(locator.object_length) > 0 and
        Nat32.toNat(locator.object_length) <= maximumLength;
    };

    func isExactDuplicate(
        existing : Types.StoredNotification,
        request : Types.AppendRequest,
    ) : Bool {
        if (
            not Principal.equal(
                existing.summary.actor_,
                request.acting_node,
            )
        ) {
            return false;
        };
        switch (request.event, existing.summary.kind) {
            case (
                #new_follower(candidate),
                ?#new_follower(current),
            ) {
                candidate.follower_revision == current.follower_revision and
                existing.like_evidence == null and
                existing.summary.verification ==
                    ?#transport_authenticated;
            };
            case (#like(candidate), ?#like(current)) {
                sameObject(candidate.locator, current) and
                sameBlobOption(
                    existing.like_evidence,
                    ?candidate.certified_like_receipt_candid,
                ) and
                actionVerificationValid(existing.summary.verification);
            };
            case (#notice(candidate), ?#reply(current)) {
                candidate.relation == #reply and
                sameObject(candidate.locator, current) and
                existing.like_evidence == null and
                actionVerificationValid(existing.summary.verification);
            };
            case (#notice(candidate), ?#share(current)) {
                candidate.relation == #share and
                sameObject(candidate.locator, current) and
                existing.like_evidence == null and
                actionVerificationValid(existing.summary.verification);
            };
            case (_) false;
        };
    };

    func sameObject(
        left : Types.NotificationObjectV1,
        right : Types.NotificationObjectV1,
    ) : Bool {
        Blob.equal(left.target_post_id, right.target_post_id) and
        Blob.equal(left.target_body_hash, right.target_body_hash) and
        Blob.equal(left.action_id, right.action_id) and
        Blob.equal(left.object_digest, right.object_digest) and
        left.object_length == right.object_length;
    };

    func sameBlobOption(left : ?Blob, right : ?Blob) : Bool {
        switch (left, right) {
            case (null, null) true;
            case (?a, ?b) Blob.equal(a, b);
            case (_) false;
        };
    };

    func storageShapeValid(stored : Types.StoredNotification) : Bool {
        switch (stored.summary.kind) {
            case (?#like(_)) {
                switch (stored.like_evidence) {
                    case (?exact) {
                        exact.size() > 0 and
                        exact.size() <=
                        Bounds.MAX_LIKE_RECEIPT_CANDID_BYTES;
                    };
                    case null false;
                };
            };
            case (_) stored.like_evidence == null;
        };
    };

    func actionVerificationValid(
        verification : ?Types.NotificationVerificationV1
    ) : Bool {
        switch (verification) {
            case (?#pending or ?#verified or ?#invalid or ?#unavailable) true;
            case (_) false;
        };
    };

    func actionTransitionAllowed(
        current : Types.NotificationVerificationV1,
        requested : Types.NotificationVerificationV1,
    ) : Bool {
        switch (current) {
            case (#pending) {
                switch (requested) {
                    case (#pending or #verified or #invalid or #unavailable) {
                        true;
                    };
                    case (#transport_authenticated) false;
                };
            };
            case (#unavailable) {
                switch (requested) {
                    case (#pending or #verified or #invalid) true;
                    case (#unavailable) true;
                    case (#transport_authenticated) false;
                };
            };
            case (#verified) requested == #verified;
            case (#invalid) requested == #invalid;
            case (#transport_authenticated) false;
        };
    };
};
