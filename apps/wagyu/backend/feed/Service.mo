import Blob "mo:core/Blob";
import List "mo:core/List";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Text "mo:core/Text";

import Bounds "../protocol/Bounds";
import Types "Types";

module {
    type ConflictPlan = {
        #ok : [Types.CandidateReplacement];
        #err : Types.PromotionError;
    };

    public class Service(store : Types.Store) {
        public func admit(
            request : Types.CandidateAdmission
        ) : Types.AdmissionOutcome {
            if (not validAdmission(request)) {
                return #rejected(#invalid);
            };

            let snapshot = store.snapshot();
            if (not validSnapshot(snapshot)) {
                return #rejected(#corrupt_state);
            };

            let transportKey : Types.TransportKey = {
                immediate_sender = request.immediate_sender;
                operation_id = request.operation_id;
            };

            // Replay/conflict is resolved before capacity. A store becoming
            // full after the first acceptance must not change its exact retry
            // result.
            switch (store.find_transport(transportKey)) {
                case (?binding) {
                    let ?existing = store.find_candidate(binding.candidate_id)
                    else return #rejected(#corrupt_state);
                    if (
                        not validTransportBinding(binding) or
                        not validStoredCandidate(existing) or
                        not sameTransportKey(binding.key, transportKey) or
                        not Blob.equal(
                            binding.candidate_id,
                            existing.candidate_id,
                        ) or
                        not Blob.equal(
                            binding.payload_digest,
                            existing.payload_digest,
                        ) or
                        binding.candidate_key != existing.candidate_key or
                        not Blob.equal(
                            binding.key.operation_id,
                            existing.operation_id,
                        ) or
                        not Principal.equal(
                            binding.key.immediate_sender,
                            existing.immediate_sender,
                        )
                    ) {
                        return #rejected(#corrupt_state);
                    };
                    let summary = existingSummary(
                        existing,
                        binding.accepted_revision,
                    );
                    if (
                        not Blob.equal(
                            binding.payload_digest,
                            request.payload_digest,
                        )
                    ) {
                        return #conflict(summary);
                    };
                    if (
                        Blob.equal(binding.candidate_id, request.candidate_id) and
                        sameAdmission(existing, request)
                    ) {
                        return #duplicate(summary);
                    };
                    return #conflict(summary);
                };
                case null {};
            };

            switch (store.find_candidate(request.candidate_id)) {
                case (?existing) {
                    if (not validStoredCandidate(existing)) {
                        return #rejected(#corrupt_state);
                    };
                    // A candidate without its transport index is corrupt even
                    // when the caller happens to repeat all retained fields.
                    return #conflict(
                        existingSummary(existing, snapshot.revision)
                    );
                };
                case null {};
            };

            let senderCount = store.count_for_sender(
                request.immediate_sender
            );
            let claimedSlot = store.scan_claimed_slot(
                request.claimed_author,
                request.claimed_post_id,
            );
            if (
                claimedSlot.size() >
                    Types.MAX_CANDIDATES_PER_CLAIMED_SLOT
            ) {
                return #rejected(#corrupt_state);
            };
            if (snapshot.candidate_count >= Types.MAX_CANDIDATES) {
                return #rejected(#full(#total_count));
            };
            if (senderCount >= Types.MAX_CANDIDATES_PER_SENDER) {
                return #rejected(#full(#sender_count));
            };
            if (
                claimedSlot.size() ==
                    Types.MAX_CANDIDATES_PER_CLAIMED_SLOT
            ) {
                return #rejected(#full(#claimed_slot));
            };
            if (senderCount > snapshot.candidate_count) {
                return #rejected(#corrupt_state);
            };
            if (request.retained_bytes > Types.MAX_CANDIDATE_BYTES) {
                return #rejected(#full(#total_bytes));
            };
            if (
                snapshot.candidate_bytes + request.retained_bytes >
                    Types.MAX_CANDIDATE_BYTES
            ) {
                return #rejected(#full(#total_bytes));
            };
            if (snapshot.last_sequence == Nat64.maxValue) {
                return #rejected(#sequence_exhausted);
            };
            if (snapshot.revision == Nat64.maxValue) {
                return #rejected(#revision_exhausted);
            };

            let sequence = snapshot.last_sequence + 1;
            let revision = snapshot.revision + 1;
            let candidate : Types.StoredCandidate = {
                candidate_key = request.candidate_key;
                candidate_id = request.candidate_id;
                route_receipt_key = request.route_receipt_key;
                operation_id = request.operation_id;
                payload_digest = request.payload_digest;
                subscription_id = request.subscription_id;
                local_sequence = sequence;
                received_at_ns = request.received_at_ns;
                immediate_sender = request.immediate_sender;
                event_kind = request.event_kind;
                claimed_author = request.claimed_author;
                claimed_post_id = request.claimed_post_id;
                claimed_body_hash = request.claimed_body_hash;
                exact_event_candid = request.exact_event_candid;
                verification = #pending;
                retain_until_ns = request.retain_until_ns;
                retained_bytes = request.retained_bytes;
            };
            let transport : Types.TransportBinding = {
                key = transportKey;
                payload_digest = request.payload_digest;
                candidate_id = request.candidate_id;
                candidate_key = request.candidate_key;
                accepted_revision = revision;
            };
            let claimedKey : Types.CanonicalKey = {
                author = request.claimed_author;
                post_id = request.claimed_post_id;
                body_hash = request.claimed_body_hash;
            };
            let visible = switch (store.find_suppression(claimedKey)) {
                case null true;
                case (?suppression) {
                    if (
                        not validSuppression(suppression) or
                        not sameKey(suppression.key, claimedKey)
                    ) {
                        return #rejected(#corrupt_state);
                    };
                    false;
                };
            };
            if (
                not store.commit_admission({
                    expected = snapshot;
                    candidate;
                    transport;
                    visible;
                    revision;
                })
            ) {
                return #rejected(#stale_state);
            };
            #accepted({
                candidate_id = request.candidate_id;
                local_sequence = sequence;
                revision;
            });
        };

        public func page(request : Types.FeedPageRequestV1) : Types.PageResult {
            let wanted = Nat16.toNat(request.limit);
            if (wanted == 0 or wanted > Bounds.MAX_FEED_PAGE_ITEMS) {
                return #err(#invalid_limit);
            };
            let snapshot = store.snapshot();
            if (not validSnapshot(snapshot)) {
                return #err(#corrupt_state);
            };

            // One look-ahead row makes the sequence cursor unambiguous.
            let rows = store.scan_descending(
                request.before_sequence,
                wanted + 1,
            );
            if (rows.size() > wanted + 1) {
                return #err(#corrupt_state);
            };
            if (rows.size() > snapshot.candidate_count) {
                return #err(#corrupt_state);
            };

            let items = List.empty<Types.FeedCandidateSummaryV1>();
            var exactBytes = 0;
            var previous : ?Nat64 = null;
            var hasMore = false;

            for (row in rows.values()) {
                if (not validStoredCandidate(row)) {
                    return #err(#corrupt_state);
                };
                if (row.local_sequence > snapshot.last_sequence) {
                    return #err(#corrupt_state);
                };
                switch (request.before_sequence) {
                    case (?before) if (row.local_sequence >= before) {
                        return #err(#corrupt_state);
                    };
                    case (_) {};
                };
                switch (previous) {
                    case (?prior) if (row.local_sequence >= prior) {
                        return #err(#corrupt_state);
                    };
                    case (_) {};
                };
                previous := ?row.local_sequence;

                if (
                    List.size(items) == wanted or
                    exactBytes + row.exact_event_candid.size() >
                        Bounds.MAX_FEED_PAGE_EVENT_BYTES
                ) {
                    hasMore := true;
                } else {
                    exactBytes += row.exact_event_candid.size();
                    List.add(items, toSummary(row));
                };
            };

            let result = List.toArray(items);
            let next = if (hasMore) {
                if (result.size() == 0) return #err(#corrupt_state);
                ?result[result.size() - 1].local_sequence;
            } else {
                null;
            };
            #ok({
                revision = snapshot.revision;
                items = result;
                next_before_sequence = next;
            });
        };

        public func promoteDelivery(
            request : Types.PromoteDeliveryRequest
        ) : Types.PromotionOutcome {
            if (
                request.candidate_id.size() != Bounds.HASH_BYTES or
                not validVerifiedPost(request.post)
            ) {
                return #err(#invalid);
            };
            let snapshot = store.snapshot();
            if (not validSnapshot(snapshot)) {
                return #err(#corrupt_state);
            };
            let ?candidate = store.find_candidate(request.candidate_id)
            else return #err(#not_found);
            if (
                not validStoredCandidate(candidate) or
                not Blob.equal(candidate.candidate_id, request.candidate_id) or
                not candidateMatchesKey(candidate, request.post.key)
            ) {
                return #err(#invalid);
            };

            let attributionResult : {
                #ok : {
                    attribution : ?Types.ShareAttribution;
                    advance_position : Bool;
                };
                #err : Types.PromotionError;
            } = switch (candidate.event_kind, request.share) {
                case (#original, null) {
                    if (
                        not Principal.equal(
                            candidate.immediate_sender,
                            request.post.key.author,
                        ) or
                        not Blob.equal(
                            candidate.exact_event_candid,
                            request.post.exact_certified_post_ref_candid,
                        )
                    ) {
                        #err(#invalid);
                    } else {
                        #ok({
                            attribution = null;
                            advance_position = true;
                        });
                    };
                };
                case (#share, ?share) {
                    if (
                        not validVerifiedShare(
                            share,
                            candidate,
                            request.post,
                        )
                    ) {
                        #err(#invalid);
                    } else {
                        switch (
                            store.find_attribution(
                                request.post.key,
                                candidate.immediate_sender,
                            )
                        ) {
                            case (?existing) {
                                if (
                                    not validAttribution(existing) or
                                    not sameKey(
                                        existing.key,
                                        request.post.key,
                                    )
                                ) {
                                    #err(#corrupt_state);
                                } else if (
                                    not sameShareAttribution(existing, share)
                                ) {
                                    #err(#equivocation);
                                } else {
                                    #ok({
                                        attribution = null;
                                        advance_position = false;
                                    });
                                };
                            };
                            case null {
                                let count = store.attribution_count(
                                    request.post.key
                                );
                                if (count > Types.MAX_RECEIVED_VIA) {
                                    #err(#corrupt_state);
                                } else if (
                                    count == Types.MAX_RECEIVED_VIA
                                ) {
                                    // The content card remains canonical; V1
                                    // intentionally drops attribution beyond
                                    // the fixed received_via bound.
                                    #ok({
                                        attribution = null;
                                        advance_position = false;
                                    });
                                } else {
                                    #ok({
                                        attribution = ?{
                                            key = request.post.key;
                                            sharer = share.sharer;
                                            share_id = share.share_id;
                                            share_object_digest =
                                                share.share_object_digest;
                                            candidate_id =
                                                candidate.candidate_id;
                                            exact_share_action_candid =
                                                share.exact_share_action_candid;
                                            exact_share_ref_candid =
                                                share.exact_share_ref_candid;
                                            verified_at_ns =
                                                request.verified_at_ns;
                                        };
                                        advance_position = true;
                                    });
                                };
                            };
                        };
                    };
                };
                case (_) #err(#invalid);
            };
            let #ok(attributionPlan) = attributionResult else {
                let #err(error) = attributionResult else {
                    return #err(#corrupt_state);
                };
                if (error == #equivocation) {
                    return quarantine(candidate, snapshot);
                };
                return #err(error);
            };

            switch (candidate.verification) {
                case (#invalid) return #err(#invalid_transition);
                case (#verified) {
                    let existing = store.find_canonical(request.post.key);
                    switch (existing) {
                        case (?canonical) {
                            if (
                                not validCanonical(canonical) or
                                not sameVerifiedPost(
                                    canonical.post,
                                    request.post,
                                )
                            ) {
                                return #err(#corrupt_state);
                            };
                            let changed = promotionChanged(
                                candidate,
                                snapshot.revision,
                                ?canonical,
                            );
                            return switch (canonical.status) {
                                case (#withdrawn(_)) #suppressed(changed);
                                case (#active) #duplicate(changed);
                            };
                        };
                        case null {
                            switch (store.find_suppression(request.post.key)) {
                                case (?suppression) {
                                    if (not validSuppression(suppression)) {
                                        return #err(#corrupt_state);
                                    };
                                    return #suppressed(
                                        promotionChanged(
                                            candidate,
                                            snapshot.revision,
                                            null,
                                        )
                                    );
                                };
                                case null return #err(#corrupt_state);
                            };
                        };
                    };
                };
                case (#pending or #unavailable) {};
            };

            // A verified withdrawal is authoritative over every later or
            // delayed delivery of the exact semantic object.
            switch (store.find_suppression(request.post.key)) {
                case (?suppression) {
                    if (not validSuppression(suppression)) {
                        return #err(#corrupt_state);
                    };
                    return commitSuppressedDelivery(
                        candidate,
                        snapshot,
                    );
                };
                case null {};
            };

            let slot = canonicalForSlot(request.post.key);
            let #ok(existingCanonical) = slot else {
                let #err(error) = slot else {
                    return #err(#corrupt_state);
                };
                return #err(error);
            };
            switch (existingCanonical) {
                case (?canonical) if (
                    not sameKey(canonical.key, request.post.key) or
                    not sameVerifiedPost(canonical.post, request.post)
                ) {
                    return quarantine(candidate, snapshot);
                };
                case (_) {};
            };

            if (
                existingCanonical == null and
                snapshot.verified_feed_count >=
                    Types.MAX_VERIFIED_FEED_RECORDS
            ) {
                return #err(#full(#verified_feed));
            };
            if (snapshot.revision == Nat64.maxValue) {
                return #err(#revision_exhausted);
            };

            let conflicts = conflictPlan(
                candidate,
                request.post.key,
                false,
            );
            let #ok(conflicting) = conflicts else {
                let #err(error) = conflicts else {
                    return #err(#corrupt_state);
                };
                return #err(error);
            };
            let replacements = List.empty<Types.CandidateReplacement>();
            List.add(replacements, {
                previous = candidate;
                replacement = {
                    candidate with verification = #verified
                };
            });
            for (replacement in conflicting.values()) {
                List.add(replacements, replacement);
            };

            let canonical = switch (existingCanonical) {
                case null {
                    {
                        key = request.post.key;
                        post = request.post;
                        first_candidate_id = candidate.candidate_id;
                        first_local_sequence = candidate.local_sequence;
                        latest_local_sequence = candidate.local_sequence;
                        direct_candidate_id = switch (
                            candidate.event_kind
                        ) {
                            case (#original) ?candidate.candidate_id;
                            case (_) null;
                        };
                        status = #active;
                        created_at_ns = request.verified_at_ns;
                        updated_at_ns = request.verified_at_ns;
                    };
                };
                case (?current) {
                    {
                        current with
                        latest_local_sequence =
                            if (attributionPlan.advance_position) {
                                Nat64.max(
                                    current.latest_local_sequence,
                                    candidate.local_sequence,
                                );
                            } else {
                                current.latest_local_sequence;
                            };
                        direct_candidate_id = switch (
                            current.direct_candidate_id,
                            candidate.event_kind,
                        ) {
                            case (null, #original) ?candidate.candidate_id;
                            case (value, _) value;
                        };
                        updated_at_ns = request.verified_at_ns;
                    };
                };
            };
            let revision = snapshot.revision + 1;
            if (
                not store.commit_promotion({
                    expected = snapshot;
                    candidates = List.toArray(replacements);
                    canonical = ?{
                        previous = existingCanonical;
                        replacement = canonical;
                    };
                    attribution = attributionPlan.attribution;
                    suppression = null;
                    hide_sequences = [];
                    revision;
                })
            ) {
                return #err(#stale_state);
            };
            let changed = promotionChanged(candidate, revision, ?canonical);
            switch (existingCanonical) {
                case null #promoted(changed);
                case (?_) #merged(changed);
            };
        };

        public func promoteTombstone(
            request : Types.PromoteTombstoneRequest
        ) : Types.PromotionOutcome {
            if (
                request.candidate_id.size() != Bounds.HASH_BYTES or
                request.tombstone_id.size() != Bounds.HASH_BYTES or
                not validKey(request.key) or
                request.exact_tombstone_candid.size() == 0 or
                request.exact_tombstone_candid.size() >
                    Types.MAX_DELIVERY_EVENT_BYTES or
                request.retain_until_ns < request.verified_at_ns
            ) {
                return #err(#invalid);
            };
            let snapshot = store.snapshot();
            if (not validSnapshot(snapshot)) {
                return #err(#corrupt_state);
            };
            let ?candidate = store.find_candidate(request.candidate_id)
            else return #err(#not_found);
            if (
                not validStoredCandidate(candidate) or
                candidate.event_kind != #tombstone or
                not candidateMatchesKey(candidate, request.key) or
                not Blob.equal(
                    candidate.exact_event_candid,
                    request.exact_tombstone_candid,
                )
            ) {
                return #err(#invalid);
            };

            // A followed sharer may relay another author's exact tombstone
            // only after this node has verified that sharer's attribution for
            // this exact original object.
            if (
                not Principal.equal(
                    request.key.author,
                    candidate.immediate_sender,
                )
            ) {
                let ?attribution = store.find_attribution(
                    request.key,
                    candidate.immediate_sender,
                ) else return #err(#invalid);
                if (
                    not validAttribution(attribution) or
                    not sameKey(attribution.key, request.key) or
                    not Principal.equal(
                        attribution.sharer,
                        candidate.immediate_sender,
                    )
                ) {
                    return #err(#corrupt_state);
                };
            };

            switch (candidate.verification) {
                case (#invalid) return #err(#invalid_transition);
                case (_) {};
            };

            let slot = canonicalForSlot(request.key);
            let #ok(existingCanonical) = slot else {
                let #err(error) = slot else {
                    return #err(#corrupt_state);
                };
                return #err(error);
            };
            switch (existingCanonical) {
                case (?canonical) if (
                    not sameKey(canonical.key, request.key)
                ) {
                    return quarantine(candidate, snapshot);
                };
                case (_) {};
            };

            let existingSuppression = store.find_suppression(request.key);
            switch (existingSuppression) {
                case (?suppression) {
                    if (not validSuppression(suppression)) {
                        return #err(#corrupt_state);
                    };
                    if (
                        not Blob.equal(
                            suppression.tombstone_id,
                            request.tombstone_id,
                        ) or
                        not Blob.equal(
                            suppression.exact_tombstone_candid,
                            request.exact_tombstone_candid,
                        )
                    ) {
                        return quarantine(candidate, snapshot);
                    };
                    if (candidate.verification == #verified) {
                        return #duplicate(
                            promotionChanged(
                                candidate,
                                snapshot.revision,
                                existingCanonical,
                            )
                        );
                    };
                };
                case null {};
            };

            if (snapshot.revision == Nat64.maxValue) {
                return #err(#revision_exhausted);
            };
            let conflicts = conflictPlan(candidate, request.key, true);
            let #ok(conflicting) = conflicts else {
                let #err(error) = conflicts else {
                    return #err(#corrupt_state);
                };
                return #err(error);
            };
            let replacements = List.empty<Types.CandidateReplacement>();
            List.add(replacements, {
                previous = candidate;
                replacement = {
                    candidate with verification = #verified
                };
            });
            for (replacement in conflicting.values()) {
                List.add(replacements, replacement);
            };

            let canonicalReplacement = switch (
                existingCanonical,
                existingSuppression,
            ) {
                case (null, _) null;
                case (?canonical, null) {
                    switch (canonical.status) {
                        case (#withdrawn(_)) {
                            return #err(#corrupt_state);
                        };
                        case (#active) {};
                    };
                    let replacement = {
                        canonical with
                        status = #withdrawn({
                            tombstone_id = request.tombstone_id;
                            exact_tombstone_candid =
                                request.exact_tombstone_candid;
                            withdrawn_at_ns = request.verified_at_ns;
                        });
                        updated_at_ns = request.verified_at_ns;
                    };
                    ?{
                        previous = ?canonical;
                        replacement;
                    };
                };
                case (?canonical, ?suppression) {
                    switch (canonical.status) {
                        case (#active) return #err(#corrupt_state);
                        case (#withdrawn(withdrawal)) {
                            if (
                                not Blob.equal(
                                    withdrawal.tombstone_id,
                                    suppression.tombstone_id,
                                ) or
                                not Blob.equal(
                                    withdrawal.exact_tombstone_candid,
                                    suppression.exact_tombstone_candid,
                                )
                            ) {
                                return #err(#corrupt_state);
                            };
                        };
                    };
                    null;
                };
            };
            let suppression = switch (existingSuppression) {
                case (?_) null;
                case null {
                    ?{
                        previous = null;
                        replacement = {
                            key = request.key;
                            tombstone_id = request.tombstone_id;
                            exact_tombstone_candid =
                                request.exact_tombstone_candid;
                            source_candidate_id =
                                candidate.candidate_id;
                            suppressed_at_ns = request.verified_at_ns;
                            retain_until_ns = request.retain_until_ns;
                        };
                    };
                };
            };
            let hide = hiddenDeliverySequences(
                candidate,
                request.key,
            );
            let #ok(hiddenSequences) = hide else {
                let #err(error) = hide else {
                    return #err(#corrupt_state);
                };
                return #err(error);
            };
            let revision = snapshot.revision + 1;
            if (
                not store.commit_promotion({
                    expected = snapshot;
                    candidates = List.toArray(replacements);
                    canonical = canonicalReplacement;
                    attribution = null;
                    suppression;
                    hide_sequences = hiddenSequences;
                    revision;
                })
            ) {
                return #err(#stale_state);
            };
            let nextCanonical = switch (canonicalReplacement) {
                case null existingCanonical;
                case (?replacement) ?replacement.replacement;
            };
            let changed = promotionChanged(
                candidate,
                revision,
                nextCanonical,
            );
            switch (existingSuppression) {
                case null #promoted(changed);
                case (?_) #duplicate(changed);
            };
        };

        public func markVerification(
            request : Types.VerificationRequest
        ) : Types.VerificationOutcome {
            if (
                request.candidate_id.size() != Bounds.HASH_BYTES or
                request.verification == #verified
            ) {
                return #err(#invalid);
            };
            let snapshot = store.snapshot();
            if (not validSnapshot(snapshot)) {
                return #err(#corrupt_state);
            };
            let ?candidate = store.find_candidate(request.candidate_id)
            else return #err(#not_found);
            if (not validStoredCandidate(candidate)) {
                return #err(#corrupt_state);
            };
            let current = candidate.verification;
            if (current == request.verification) {
                return #unchanged({
                    candidate_id = candidate.candidate_id;
                    revision = snapshot.revision;
                    verification = current;
                });
            };
            switch (current, request.verification) {
                case (#pending, #invalid or #unavailable) {};
                case (#unavailable, #pending or #invalid) {};
                case (_) return #err(#invalid_transition);
            };
            if (snapshot.revision == Nat64.maxValue) {
                return #err(#revision_exhausted);
            };
            let revision = snapshot.revision + 1;
            if (
                not store.commit_verification({
                    expected_revision = snapshot.revision;
                    candidate = {
                        previous = candidate;
                        replacement = {
                            candidate with
                            verification = request.verification
                        };
                    };
                    revision;
                })
            ) {
                return #err(#stale_state);
            };
            #changed({
                candidate_id = candidate.candidate_id;
                revision;
                verification = request.verification;
            });
        };

        // find_canonical_slot is allowed to use an adapter-owned slot index,
        // but the index may never contain multiple semantic bodies.
        func canonicalForSlot(
            key : Types.CanonicalKey
        ) : {
            #ok : ?Types.CanonicalRecord;
            #err : Types.PromotionError;
        } {
            let rows = store.find_canonical_slot(key.author, key.post_id);
            if (rows.size() > 1) return #err(#corrupt_state);
            let direct = store.find_canonical(key);
            switch (rows.size(), direct) {
                case (0, null) #ok(null);
                case (1, ?found) {
                    let indexed = rows[0];
                    if (
                        not validCanonical(indexed) or
                        not validCanonical(found) or
                        not sameCanonical(indexed, found)
                    ) {
                        #err(#corrupt_state);
                    } else {
                        #ok(?found);
                    };
                };
                case (1, null) {
                    let indexed = rows[0];
                    if (not validCanonical(indexed)) {
                        #err(#corrupt_state);
                    } else if (sameKey(indexed.key, key)) {
                        #err(#corrupt_state);
                    } else {
                        #ok(?indexed);
                    };
                };
                case (0, ?_) #err(#corrupt_state);
                case (_) #err(#corrupt_state);
            };
        };

        // Quarantine every still-unverified row that cheaply claims the same
        // post slot with a body hash that conflicts with a verified winner.
        // In tombstone mode, exact matching deliveries are hidden instead of
        // being relabeled invalid; their replay evidence remains retained.
        func conflictPlan(
            primary : Types.StoredCandidate,
            winner : Types.CanonicalKey,
            tombstoneMode : Bool,
        ) : ConflictPlan {
            let rows = store.scan_claimed_slot(
                winner.author,
                winner.post_id,
            );
            let snapshot = store.snapshot();
            if (
                rows.size() > snapshot.candidate_count or
                rows.size() >
                    Types.MAX_CANDIDATES_PER_CLAIMED_SLOT
            ) {
                return #err(#corrupt_state);
            };
            let replacements = List.empty<Types.CandidateReplacement>();
            for (row in rows.values()) {
                if (
                    not validStoredCandidate(row) or
                    not Principal.equal(
                        row.claimed_author,
                        winner.author,
                    ) or
                    not Blob.equal(row.claimed_post_id, winner.post_id)
                ) {
                    return #err(#corrupt_state);
                };
                if (Blob.equal(row.candidate_id, primary.candidate_id)) {
                    if (row.candidate_key != primary.candidate_key) {
                        return #err(#corrupt_state);
                    };
                } else if (
                    not Blob.equal(row.claimed_body_hash, winner.body_hash)
                ) {
                    switch (row.verification) {
                        case (#verified) return #err(#corrupt_state);
                        case (#invalid) {};
                        case (#pending or #unavailable) {
                            List.add(replacements, {
                                previous = row;
                                replacement = {
                                    row with verification = #invalid
                                };
                            });
                        };
                    };
                } else if (tombstoneMode) {
                    // Visibility removal is carried separately by
                    // hiddenDeliverySequences; proof state is not rewritten.
                };
            };
            #ok(List.toArray(replacements));
        };

        func hiddenDeliverySequences(
            _primary : Types.StoredCandidate,
            key : Types.CanonicalKey,
        ) : {
            #ok : [Nat64];
            #err : Types.PromotionError;
        } {
            let rows = store.scan_claimed_slot(key.author, key.post_id);
            let snapshot = store.snapshot();
            if (
                rows.size() > snapshot.candidate_count or
                rows.size() >
                    Types.MAX_CANDIDATES_PER_CLAIMED_SLOT
            ) {
                return #err(#corrupt_state);
            };
            let sequences = List.empty<Nat64>();
            for (row in rows.values()) {
                if (
                    not validStoredCandidate(row) or
                    not Principal.equal(row.claimed_author, key.author) or
                    not Blob.equal(row.claimed_post_id, key.post_id)
                ) {
                    return #err(#corrupt_state);
                };
                if (
                    row.event_kind != #tombstone and
                    Blob.equal(row.claimed_body_hash, key.body_hash)
                ) {
                    List.add(sequences, row.local_sequence);
                };
            };
            #ok(List.toArray(sequences));
        };

        func commitSuppressedDelivery(
            candidate : Types.StoredCandidate,
            snapshot : Types.StoreSnapshot,
        ) : Types.PromotionOutcome {
            if (snapshot.revision == Nat64.maxValue) {
                return #err(#revision_exhausted);
            };
            let revision = snapshot.revision + 1;
            if (
                not store.commit_promotion({
                    expected = snapshot;
                    candidates = [{
                        previous = candidate;
                        replacement = {
                            candidate with verification = #verified
                        };
                    }];
                    canonical = null;
                    attribution = null;
                    suppression = null;
                    hide_sequences = [candidate.local_sequence];
                    revision;
                })
            ) {
                return #err(#stale_state);
            };
            #suppressed(
                promotionChanged(candidate, revision, null)
            );
        };

        func quarantine(
            candidate : Types.StoredCandidate,
            snapshot : Types.StoreSnapshot,
        ) : Types.PromotionOutcome {
            if (candidate.verification == #invalid) {
                return #err(#equivocation);
            };
            if (candidate.verification == #verified) {
                return #err(#corrupt_state);
            };
            if (snapshot.revision == Nat64.maxValue) {
                return #err(#revision_exhausted);
            };
            let revision = snapshot.revision + 1;
            if (
                not store.commit_promotion({
                    expected = snapshot;
                    candidates = [{
                        previous = candidate;
                        replacement = {
                            candidate with verification = #invalid
                        };
                    }];
                    canonical = null;
                    attribution = null;
                    suppression = null;
                    hide_sequences = [];
                    revision;
                })
            ) {
                return #err(#stale_state);
            };
            #quarantined({
                candidate_id = candidate.candidate_id;
                revision;
                canonical = null;
            });
        };

        func validAdmission(value : Types.CandidateAdmission) : Bool {
            validStableKey(value.candidate_key) and
            validStableKey(value.route_receipt_key) and
            value.candidate_id.size() == Bounds.HASH_BYTES and
            value.operation_id.size() == Bounds.OPERATION_ID_BYTES and
            value.payload_digest.size() == Bounds.HASH_BYTES and
            value.subscription_id.size() == Bounds.SUBSCRIPTION_ID_BYTES and
            value.claimed_post_id.size() == Bounds.HASH_BYTES and
            value.claimed_body_hash.size() == Bounds.HASH_BYTES and
            value.exact_event_candid.size() > 0 and
            value.exact_event_candid.size() <=
                Types.MAX_DELIVERY_EVENT_BYTES and
            value.retained_bytes >= value.exact_event_candid.size() and
            value.retained_bytes <=
                value.exact_event_candid.size() +
                    Types.MAX_ACCOUNTED_OVERHEAD_BYTES and
            value.retain_until_ns >= value.received_at_ns and
            (
                value.event_kind != #original or
                Principal.equal(
                    value.immediate_sender,
                    value.claimed_author,
                )
            )
        };

        func validStoredCandidate(value : Types.StoredCandidate) : Bool {
            validStableKey(value.candidate_key) and
            validStableKey(value.route_receipt_key) and
            value.candidate_id.size() == Bounds.HASH_BYTES and
            value.operation_id.size() == Bounds.OPERATION_ID_BYTES and
            value.payload_digest.size() == Bounds.HASH_BYTES and
            value.subscription_id.size() == Bounds.SUBSCRIPTION_ID_BYTES and
            value.local_sequence > 0 and
            value.claimed_post_id.size() == Bounds.HASH_BYTES and
            value.claimed_body_hash.size() == Bounds.HASH_BYTES and
            value.exact_event_candid.size() > 0 and
            value.exact_event_candid.size() <=
                Types.MAX_DELIVERY_EVENT_BYTES and
            value.retained_bytes >= value.exact_event_candid.size() and
            value.retained_bytes <=
                value.exact_event_candid.size() +
                    Types.MAX_ACCOUNTED_OVERHEAD_BYTES and
            value.retain_until_ns >= value.received_at_ns and
            (
                value.event_kind != #original or
                Principal.equal(
                    value.immediate_sender,
                    value.claimed_author,
                )
            )
        };

        func validSnapshot(value : Types.StoreSnapshot) : Bool {
            value.candidate_count <= Types.MAX_CANDIDATES and
            value.candidate_bytes <= Types.MAX_CANDIDATE_BYTES and
            value.verified_feed_count <= Types.MAX_VERIFIED_FEED_RECORDS and
            (
                (
                    value.candidate_count == 0 and
                    value.candidate_bytes == 0
                ) or
                (
                    value.candidate_count > 0 and
                    value.candidate_bytes > 0
                )
            )
        };

        func validTransportBinding(
            value : Types.TransportBinding
        ) : Bool {
            value.key.operation_id.size() == Bounds.OPERATION_ID_BYTES and
            value.payload_digest.size() == Bounds.HASH_BYTES and
            value.candidate_id.size() == Bounds.HASH_BYTES and
            validStableKey(value.candidate_key) and
            value.accepted_revision > 0
        };

        func validVerifiedPost(value : Types.VerifiedPost) : Bool {
            if (
                not validKey(value.key) or
                value.body_length == 0 or
                Nat32.toNat(value.body_length) >
                    Bounds.MAX_POST_OBJECT_BYTES or
                value.object_digest.size() != Bounds.HASH_BYTES or
                value.exact_certified_post_ref_candid.size() == 0 or
                value.exact_certified_post_ref_candid.size() >
                    Types.MAX_DELIVERY_EVENT_BYTES
            ) {
                return false;
            };
            let reference = value.certified_ref;
            Principal.equal(reference.author, value.key.author) and
            Blob.equal(reference.post_id, value.key.post_id) and
            Blob.equal(reference.body_hash, value.key.body_hash) and
            reference.body_length == value.body_length and
            Blob.equal(reference.object_digest, value.object_digest) and
            reference.proof.certificate_version == 2 and
            reference.proof.certificate_cbor.size() > 0 and
            reference.proof.witness_cbor.size() > 0 and
            reference.proof.expression_path_cbor.size() > 0 and
            (
                reference.proof.certificate_cbor.size() +
                reference.proof.witness_cbor.size() +
                reference.proof.expression_path_cbor.size() <=
                    Bounds.MAX_PROOF_CANDID_BYTES
            )
        };

        func validVerifiedShare(
            value : Types.VerifiedShare,
            candidate : Types.StoredCandidate,
            post : Types.VerifiedPost,
        ) : Bool {
            Principal.equal(value.sharer, candidate.immediate_sender) and
            value.share_id.size() == Bounds.HASH_BYTES and
            value.share_object_digest.size() == Bounds.HASH_BYTES and
            value.exact_delivery_candid.size() > 0 and
            value.exact_delivery_candid.size() <=
                Types.MAX_DELIVERY_EVENT_BYTES and
            Blob.equal(
                value.exact_delivery_candid,
                candidate.exact_event_candid,
            ) and
            value.exact_original_post_ref_candid.size() > 0 and
            value.exact_original_post_ref_candid.size() <=
                Types.MAX_DELIVERY_EVENT_BYTES and
            Blob.equal(
                value.exact_original_post_ref_candid,
                post.exact_certified_post_ref_candid,
            ) and
            value.exact_share_action_candid.size() > 0 and
            value.exact_share_action_candid.size() <=
                Types.MAX_DELIVERY_EVENT_BYTES and
            value.exact_share_ref_candid.size() > 0 and
            value.exact_share_ref_candid.size() <=
                Types.MAX_DELIVERY_EVENT_BYTES
        };

        func validKey(value : Types.CanonicalKey) : Bool {
            value.post_id.size() == Bounds.HASH_BYTES and
            value.body_hash.size() == Bounds.HASH_BYTES
        };

        func validCanonical(value : Types.CanonicalRecord) : Bool {
            validKey(value.key) and
            validVerifiedPost(value.post) and
            sameKey(value.key, value.post.key) and
            value.first_candidate_id.size() == Bounds.HASH_BYTES and
            value.first_local_sequence > 0 and
            value.latest_local_sequence >= value.first_local_sequence and
            (
                switch (value.direct_candidate_id) {
                    case null true;
                    case (?candidateId) {
                        candidateId.size() == Bounds.HASH_BYTES
                    };
                }
            ) and
            (
                switch (value.status) {
                    case (#active) true;
                    case (#withdrawn(withdrawal)) {
                        withdrawal.tombstone_id.size() ==
                            Bounds.HASH_BYTES and
                        withdrawal.exact_tombstone_candid.size() > 0 and
                        withdrawal.exact_tombstone_candid.size() <=
                            Types.MAX_DELIVERY_EVENT_BYTES
                    };
                }
            )
        };

        func validAttribution(value : Types.ShareAttribution) : Bool {
            validKey(value.key) and
            value.share_id.size() == Bounds.HASH_BYTES and
            value.share_object_digest.size() == Bounds.HASH_BYTES and
            value.candidate_id.size() == Bounds.HASH_BYTES and
            value.exact_share_action_candid.size() > 0 and
            value.exact_share_action_candid.size() <=
                Types.MAX_DELIVERY_EVENT_BYTES and
            value.exact_share_ref_candid.size() > 0 and
            value.exact_share_ref_candid.size() <=
                Types.MAX_DELIVERY_EVENT_BYTES
        };

        func validSuppression(value : Types.SuppressionRecord) : Bool {
            validKey(value.key) and
            value.tombstone_id.size() == Bounds.HASH_BYTES and
            value.source_candidate_id.size() == Bounds.HASH_BYTES and
            value.exact_tombstone_candid.size() > 0 and
            value.exact_tombstone_candid.size() <=
                Types.MAX_DELIVERY_EVENT_BYTES and
            value.retain_until_ns >= value.suppressed_at_ns
        };

        func sameAdmission(
            stored : Types.StoredCandidate,
            request : Types.CandidateAdmission,
        ) : Bool {
            stored.candidate_key == request.candidate_key and
            stored.route_receipt_key == request.route_receipt_key and
            Blob.equal(stored.candidate_id, request.candidate_id) and
            Blob.equal(stored.operation_id, request.operation_id) and
            Blob.equal(stored.payload_digest, request.payload_digest) and
            Blob.equal(stored.subscription_id, request.subscription_id) and
            Principal.equal(
                stored.immediate_sender,
                request.immediate_sender,
            ) and
            stored.event_kind == request.event_kind and
            Principal.equal(
                stored.claimed_author,
                request.claimed_author,
            ) and
            Blob.equal(
                stored.claimed_post_id,
                request.claimed_post_id,
            ) and
            Blob.equal(
                stored.claimed_body_hash,
                request.claimed_body_hash,
            ) and
            Blob.equal(
                stored.exact_event_candid,
                request.exact_event_candid,
            )
        };

        func sameTransportKey(
            left : Types.TransportKey,
            right : Types.TransportKey,
        ) : Bool {
            Principal.equal(
                left.immediate_sender,
                right.immediate_sender,
            ) and Blob.equal(left.operation_id, right.operation_id)
        };

        func sameKey(
            left : Types.CanonicalKey,
            right : Types.CanonicalKey,
        ) : Bool {
            Principal.equal(left.author, right.author) and
            Blob.equal(left.post_id, right.post_id) and
            Blob.equal(left.body_hash, right.body_hash)
        };

        func sameVerifiedPost(
            left : Types.VerifiedPost,
            right : Types.VerifiedPost,
        ) : Bool {
            sameKey(left.key, right.key) and
            left.body_length == right.body_length and
            Blob.equal(left.object_digest, right.object_digest) and
            Blob.equal(
                left.exact_certified_post_ref_candid,
                right.exact_certified_post_ref_candid,
            )
        };

        func sameCanonical(
            left : Types.CanonicalRecord,
            right : Types.CanonicalRecord,
        ) : Bool {
            left == right
        };

        func sameShareAttribution(
            existing : Types.ShareAttribution,
            share : Types.VerifiedShare,
        ) : Bool {
            Principal.equal(existing.sharer, share.sharer) and
            Blob.equal(existing.share_id, share.share_id) and
            Blob.equal(
                existing.share_object_digest,
                share.share_object_digest,
            ) and
            Blob.equal(
                existing.exact_share_action_candid,
                share.exact_share_action_candid,
            ) and
            Blob.equal(
                existing.exact_share_ref_candid,
                share.exact_share_ref_candid,
            )
        };

        func candidateMatchesKey(
            candidate : Types.StoredCandidate,
            key : Types.CanonicalKey,
        ) : Bool {
            Principal.equal(candidate.claimed_author, key.author) and
            Blob.equal(candidate.claimed_post_id, key.post_id) and
            Blob.equal(candidate.claimed_body_hash, key.body_hash)
        };

        func validStableKey(value : Text) : Bool {
            let bytes = Text.encodeUtf8(value).size();
            bytes > 0 and bytes <= 512
        };

        func existingSummary(
            candidate : Types.StoredCandidate,
            revision : Nat64,
        ) : Types.ExistingCandidate {
            {
                candidate_id = candidate.candidate_id;
                local_sequence = candidate.local_sequence;
                revision;
            }
        };

        func promotionChanged(
            candidate : Types.StoredCandidate,
            revision : Nat64,
            canonical : ?Types.CanonicalRecord,
        ) : Types.PromotionChanged {
            {
                candidate_id = candidate.candidate_id;
                revision;
                canonical;
            }
        };

        func toSummary(
            candidate : Types.StoredCandidate
        ) : Types.FeedCandidateSummaryV1 {
            {
                candidate_id = candidate.candidate_id;
                local_sequence = candidate.local_sequence;
                received_at_ns = candidate.received_at_ns;
                immediate_sender = candidate.immediate_sender;
                event_kind = ?candidate.event_kind;
                claimed_author = candidate.claimed_author;
                claimed_post_id = candidate.claimed_post_id;
                exact_event_candid = candidate.exact_event_candid;
                verification = ?candidate.verification;
            }
        };
    };
};
