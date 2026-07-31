import Array "mo:core/Array";
import Blob "mo:core/Blob";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";

import FeedService "../../backend/feed/Service";
import FeedTypes "../../backend/feed/Types";
import NotificationService "../../backend/notifications/Service";
import NotificationTypes "../../backend/notifications/Types";

func appendArray<Value>(values : [Value], value : Value) : [Value] {
    Array.tabulate<Value>(
        values.size() + 1,
        func(index) {
            if (index < values.size()) values[index] else value
        },
    )
};

func repeated(byte : Nat8, count : Nat) : Blob {
    Blob.fromArray(Array.tabulate<Nat8>(count, func(_) { byte }));
};

let actorA = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
let actorB = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
let hashA = repeated(0x11, 32);
let hashB = repeated(0x22, 32);
let hashC = repeated(0x33, 32);
let hashD = repeated(0x44, 32);

func sameSemanticKey(
    left : NotificationTypes.SemanticKey,
    right : NotificationTypes.SemanticKey,
) : Bool {
    switch (left, right) {
        case (#new_follower(a), #new_follower(b)) {
            Principal.equal(a.acting_node, b.acting_node) and
            a.follower_revision == b.follower_revision;
        };
        case (#like(a), #like(b)) {
            Principal.equal(a.acting_node, b.acting_node) and
            Blob.equal(a.target_post_id, b.target_post_id);
        };
        case (#notice(a), #notice(b)) {
            Principal.equal(a.acting_node, b.acting_node) and
            a.relation == b.relation and
            Blob.equal(a.action_id, b.action_id);
        };
        case (_) false;
    };
};

func noticeObject(
    stored : NotificationTypes.StoredNotification
) : ?NotificationTypes.NotificationObjectV1 {
    switch (stored.summary.kind) {
        case (?#reply(value) or ?#share(value)) ?value;
        case (_) null;
    };
};

let notificationRows =
    Map.empty<Nat64, NotificationTypes.StoredNotification>();
var notificationSemantics :
    [(NotificationTypes.SemanticKey, Nat64)] = [];
var notificationRevision : Nat64 = 0;
var notificationLastSequence : Nat64 = 0;
var notificationTotalOverride : ?Nat = null;
var notificationActorCountOverride : ?Nat = null;
var notificationTargetCountOverride : ?Nat = null;
var rejectNextNotificationAppend = false;
var rejectNextNotificationReplace = false;
var notificationAppendCalls = 0;
var notificationReplaceCalls = 0;

func notificationTotal() : Nat {
    switch (notificationTotalOverride) {
        case (?value) value;
        case null Map.size(notificationRows);
    };
};

func findNotificationSemantic(
    key : NotificationTypes.SemanticKey
) : ?NotificationTypes.StoredNotification {
    for ((candidate, sequence) in notificationSemantics.vals()) {
        if (sameSemanticKey(candidate, key)) {
            return Map.get(notificationRows, Nat64.compare, sequence);
        };
    };
    null;
};

func noticeCountForActor(actingNode : Principal) : Nat {
    switch (notificationActorCountOverride) {
        case (?value) return value;
        case null {};
    };
    var count = 0;
    for (stored in Map.values(notificationRows)) {
        if (
            Principal.equal(stored.summary.actor_, actingNode) and
            noticeObject(stored) != null
        ) count += 1;
    };
    count;
};

func noticeCountForTarget(target : Blob) : Nat {
    switch (notificationTargetCountOverride) {
        case (?value) return value;
        case null {};
    };
    var count = 0;
    for (stored in Map.values(notificationRows)) {
        switch (noticeObject(stored)) {
            case (?action) {
                if (Blob.equal(action.target_post_id, target)) count += 1;
            };
            case null {};
        };
    };
    count;
};

func scanNotifications(
    before : ?Nat64,
    limit : Nat,
) : [NotificationTypes.StoredNotification] {
    let result = List.empty<NotificationTypes.StoredNotification>();
    label rows for ((sequence, stored) in Map.reverseEntries(notificationRows)) {
        switch (before) {
            case (?upperExclusive) {
                if (sequence >= upperExclusive) continue rows;
            };
            case null {};
        };
        if (List.size(result) >= limit) break rows;
        List.add(result, stored);
    };
    List.toArray(result);
};

func commitNotificationAppend(
    commit : NotificationTypes.AppendCommit
) : Bool {
    notificationAppendCalls += 1;
    if (rejectNextNotificationAppend) {
        rejectNextNotificationAppend := false;
        return false;
    };
    if (
        commit.expected.revision != notificationRevision or
        commit.expected.last_sequence != notificationLastSequence or
        commit.expected.total_count != notificationTotal() or
        commit.revision != notificationRevision + 1 or
        commit.stored.summary.local_sequence !=
            notificationLastSequence + 1 or
        Map.get(
            notificationRows,
            Nat64.compare,
            commit.stored.summary.local_sequence,
        ) != null or
        findNotificationSemantic(commit.semantic_key) != null
    ) return false;

    Map.add(
        notificationRows,
        Nat64.compare,
        commit.stored.summary.local_sequence,
        commit.stored,
    );
    notificationSemantics := appendArray(
        notificationSemantics,
        (commit.semantic_key, commit.stored.summary.local_sequence),
    );
    notificationLastSequence := commit.stored.summary.local_sequence;
    notificationRevision := commit.revision;
    true;
};

func commitNotificationReplace(
    commit : NotificationTypes.ReplaceCommit
) : Bool {
    notificationReplaceCalls += 1;
    if (rejectNextNotificationReplace) {
        rejectNextNotificationReplace := false;
        return false;
    };
    if (
        commit.expected_revision != notificationRevision or
        commit.revision != notificationRevision + 1 or
        commit.previous.local_sequence !=
            commit.replacement.local_sequence
    ) return false;
    let ?stored = Map.get(
        notificationRows,
        Nat64.compare,
        commit.previous.local_sequence,
    ) else return false;
    if (
        stored.summary.local_sequence !=
            commit.previous.local_sequence or
        stored.summary.read != commit.previous.read or
        stored.summary.verification != commit.previous.verification
    ) return false;

    Map.add(
        notificationRows,
        Nat64.compare,
        commit.replacement.local_sequence,
        {
            summary = commit.replacement;
            like_evidence = stored.like_evidence;
        },
    );
    notificationRevision := commit.revision;
    true;
};

let notificationStore : NotificationTypes.Store = {
    snapshot = func() {
        {
            revision = notificationRevision;
            last_sequence = notificationLastSequence;
            total_count = notificationTotal();
        };
    };
    find_semantic = findNotificationSemantic;
    get = func(sequence) {
        Map.get(notificationRows, Nat64.compare, sequence);
    };
    scan_descending = scanNotifications;
    notice_count_for_actor = noticeCountForActor;
    notice_count_for_target = noticeCountForTarget;
    commit_append = commitNotificationAppend;
    commit_replace = commitNotificationReplace;
};

func notificationObject(
    targetPostId : Blob,
    targetBodyHash : Blob,
    actionId : Blob,
    objectDigest : Blob,
) : NotificationTypes.NotificationObjectV1 {
    {
        target_post_id = targetPostId;
        target_body_hash = targetBodyHash;
        action_id = actionId;
        object_digest = objectDigest;
        object_length = 128;
    };
};

let followerRequest : NotificationTypes.AppendRequest = {
    acting_node = actorA;
    received_at_ns = 10;
    event = #new_follower({ follower_revision = 1 });
};
let follower = switch (
    NotificationService.append(notificationStore, followerRequest)
) {
    case (#accepted(value)) value;
    case (_) Runtime.trap("expected new-follower notification");
};
assert (follower.summary.local_sequence == 1);
assert (follower.summary.verification == ?#transport_authenticated);
assert (not follower.summary.read);
assert (notificationRevision == 1);
assert (Map.size(notificationRows) == 1);

// A replay can arrive at another receiver time, but the caller-bound semantic
// event remains exactly one notification row.
assert (
    NotificationService.append(
        notificationStore,
        { followerRequest with received_at_ns = 11 },
    ) == #duplicate({ revision = 1; local_sequence = 1 })
);
assert (Map.size(notificationRows) == 1);

let likeObject = notificationObject(hashA, hashB, hashC, hashD);
let likeReceipt : Blob = "exact-like-receipt";
let likeRequest : NotificationTypes.AppendRequest = {
    acting_node = actorB;
    received_at_ns = 20;
    event = #like({
        locator = likeObject;
        certified_like_receipt_candid = likeReceipt;
    });
};
let like = switch (
    NotificationService.append(notificationStore, likeRequest)
) {
    case (#accepted(value)) value;
    case (_) Runtime.trap("expected Like notification");
};
assert (like.summary.local_sequence == 2);
assert (like.summary.verification == ?#pending);
assert (
    NotificationService.append(
        notificationStore,
        { likeRequest with received_at_ns = 21 },
    ) == #duplicate({ revision = 2; local_sequence = 2 })
);
assert (
    NotificationService.append(
        notificationStore,
        {
            likeRequest with
            event = #like({
                locator = {
                    likeObject with object_digest = hashA
                };
                certified_like_receipt_candid = likeReceipt;
            });
        },
    ) == #conflict({ revision = 2; local_sequence = 2 })
);

let noticeRequest : NotificationTypes.AppendRequest = {
    acting_node = actorA;
    received_at_ns = 30;
    event = #notice({
        relation = #reply;
        locator = notificationObject(hashA, hashB, hashD, hashC);
    });
};
let notice = switch (
    NotificationService.append(notificationStore, noticeRequest)
) {
    case (#accepted(value)) value;
    case (_) Runtime.trap("expected reply notice");
};
assert (notice.summary.local_sequence == 3);
assert (notice.summary.verification == ?#pending);
assert (
    NotificationService.append(notificationStore, noticeRequest) ==
    #duplicate({ revision = 3; local_sequence = 3 })
);
assert (
    NotificationService.append(
        notificationStore,
        {
            noticeRequest with
            event = #notice({
                relation = #reply;
                locator = notificationObject(hashA, hashC, hashD, hashC);
            });
        },
    ) == #conflict({ revision = 3; local_sequence = 3 })
);

let firstNotificationPage = switch (
    NotificationService.page(
        notificationStore,
        { before_sequence = null; limit = 2 },
    )
) {
    case (#ok(value)) value;
    case (_) Runtime.trap("expected first notification page");
};
assert (firstNotificationPage.revision == 3);
assert (firstNotificationPage.items.size() == 2);
assert (firstNotificationPage.items[0].local_sequence == 3);
assert (firstNotificationPage.items[1].local_sequence == 2);
assert (firstNotificationPage.next_before_sequence == ?2);

let secondNotificationPage = switch (
    NotificationService.page(
        notificationStore,
        { before_sequence = ?2; limit = 2 },
    )
) {
    case (#ok(value)) value;
    case (_) Runtime.trap("expected second notification page");
};
assert (secondNotificationPage.items.size() == 1);
assert (secondNotificationPage.items[0].local_sequence == 1);
assert (secondNotificationPage.next_before_sequence == null);
assert (
    NotificationService.page(
        notificationStore,
        { before_sequence = null; limit = 0 },
    ) == #err(#invalid_limit)
);
assert (
    NotificationService.page(
        notificationStore,
        {
            before_sequence = null;
            limit = Nat16.fromNat(51);
        },
    ) == #err(#invalid_limit)
);

let likeEvidence = switch (
    NotificationService.evidence(
        notificationStore,
        { local_sequence = like.summary.local_sequence },
    )
) {
    case (#ok(value)) value;
    case (_) Runtime.trap("expected Like evidence");
};
assert (likeEvidence.found);
assert (
    likeEvidence.evidence ==
    ?#like({ certified_like_receipt_candid = likeReceipt })
);
assert (
    NotificationService.evidence(
        notificationStore,
        { local_sequence = follower.summary.local_sequence },
    ) ==
    #ok({
        local_sequence = follower.summary.local_sequence;
        found = true;
        evidence = null;
    })
);

func sameFeedTransportKey(
    left : FeedTypes.TransportKey,
    right : FeedTypes.TransportKey,
) : Bool {
    Principal.equal(left.immediate_sender, right.immediate_sender) and
    Blob.equal(left.operation_id, right.operation_id);
};

func sameFeedCanonicalKey(
    left : FeedTypes.CanonicalKey,
    right : FeedTypes.CanonicalKey,
) : Bool {
    Principal.equal(left.author, right.author) and
    Blob.equal(left.post_id, right.post_id) and
    Blob.equal(left.body_hash, right.body_hash);
};

let feedCandidates = Map.empty<Blob, FeedTypes.StoredCandidate>();
let feedOrder = Map.empty<Nat64, Blob>();
let hiddenFeedSequences = Map.empty<Nat64, ()>();
var feedTransports : [FeedTypes.TransportBinding] = [];
var feedCanonicals : [FeedTypes.CanonicalRecord] = [];
var feedAttributions : [FeedTypes.ShareAttribution] = [];
var feedSuppressions : [FeedTypes.SuppressionRecord] = [];
var feedRevision : Nat64 = 0;
var feedLastSequence : Nat64 = 0;
var feedCandidateBytes = 0;
var feedVerifiedCount = 0;
var feedCountOverride : ?Nat = null;
var feedBytesOverride : ?Nat = null;
var feedSenderCountOverride : ?Nat = null;
var feedSequenceOverride : ?Nat64 = null;
var rejectNextFeedAdmission = false;
var rejectNextFeedPromotion = false;
var rejectNextFeedVerification = false;
var feedAdmissionCalls = 0;
var feedPromotionCalls = 0;
var feedVerificationCalls = 0;

func currentFeedCount() : Nat {
    switch (feedCountOverride) {
        case (?value) value;
        case null Map.size(feedCandidates);
    };
};

func currentFeedBytes() : Nat {
    switch (feedBytesOverride) {
        case (?value) value;
        case null feedCandidateBytes;
    };
};

func feedSnapshot() : FeedTypes.StoreSnapshot {
    {
        revision = feedRevision;
        last_sequence = switch (feedSequenceOverride) {
            case (?value) value;
            case null feedLastSequence;
        };
        candidate_count = currentFeedCount();
        candidate_bytes = currentFeedBytes();
        verified_feed_count = feedVerifiedCount;
    };
};

func feedCountForSender(sender : Principal) : Nat {
    switch (feedSenderCountOverride) {
        case (?value) return value;
        case null {};
    };
    var count = 0;
    for (candidate in Map.values(feedCandidates)) {
        if (Principal.equal(candidate.immediate_sender, sender)) {
            count += 1;
        };
    };
    count;
};

func findFeedTransport(
    key : FeedTypes.TransportKey
) : ?FeedTypes.TransportBinding {
    for (binding in feedTransports.vals()) {
        if (sameFeedTransportKey(binding.key, key)) return ?binding;
    };
    null;
};

func findFeedCanonical(
    key : FeedTypes.CanonicalKey
) : ?FeedTypes.CanonicalRecord {
    for (canonical in feedCanonicals.vals()) {
        if (sameFeedCanonicalKey(canonical.key, key)) return ?canonical;
    };
    null;
};

func findFeedCanonicalSlot(
    author : Principal,
    postId : Blob,
) : [FeedTypes.CanonicalRecord] {
    Array.filter<FeedTypes.CanonicalRecord>(
        feedCanonicals,
        func(canonical) {
            Principal.equal(canonical.key.author, author) and
            Blob.equal(canonical.key.post_id, postId);
        },
    );
};

func findFeedAttribution(
    key : FeedTypes.CanonicalKey,
    sharer : Principal,
) : ?FeedTypes.ShareAttribution {
    for (attribution in feedAttributions.vals()) {
        if (
            sameFeedCanonicalKey(attribution.key, key) and
            Principal.equal(attribution.sharer, sharer)
        ) return ?attribution;
    };
    null;
};

func feedAttributionCount(key : FeedTypes.CanonicalKey) : Nat {
    var count = 0;
    for (attribution in feedAttributions.vals()) {
        if (sameFeedCanonicalKey(attribution.key, key)) count += 1;
    };
    count;
};

func findFeedSuppression(
    key : FeedTypes.CanonicalKey
) : ?FeedTypes.SuppressionRecord {
    for (suppression in feedSuppressions.vals()) {
        if (sameFeedCanonicalKey(suppression.key, key)) {
            return ?suppression;
        };
    };
    null;
};

func scanClaimedFeedSlot(
    author : Principal,
    postId : Blob,
) : [FeedTypes.StoredCandidate] {
    let result = List.empty<FeedTypes.StoredCandidate>();
    for (candidate in Map.values(feedCandidates)) {
        if (
            Principal.equal(candidate.claimed_author, author) and
            Blob.equal(candidate.claimed_post_id, postId)
        ) List.add(result, candidate);
    };
    List.toArray(result);
};

func scanFeedDescending(
    before : ?Nat64,
    limit : Nat,
) : [FeedTypes.StoredCandidate] {
    let result = List.empty<FeedTypes.StoredCandidate>();
    label rows for ((sequence, candidateId) in Map.reverseEntries(feedOrder)) {
        switch (before) {
            case (?upperExclusive) {
                if (sequence >= upperExclusive) continue rows;
            };
            case null {};
        };
        if (
            Map.get(hiddenFeedSequences, Nat64.compare, sequence) != null
        ) continue rows;
        if (List.size(result) >= limit) break rows;
        let ?candidate = Map.get(feedCandidates, Blob.compare, candidateId)
        else Runtime.trap("feed order points to missing candidate");
        List.add(result, candidate);
    };
    List.toArray(result);
};

func sameFeedSnapshot(
    expected : FeedTypes.StoreSnapshot,
    current : FeedTypes.StoreSnapshot,
) : Bool {
    expected.revision == current.revision and
    expected.last_sequence == current.last_sequence and
    expected.candidate_count == current.candidate_count and
    expected.candidate_bytes == current.candidate_bytes and
    expected.verified_feed_count == current.verified_feed_count;
};

func commitFeedAdmission(commit : FeedTypes.AdmissionCommit) : Bool {
    feedAdmissionCalls += 1;
    if (rejectNextFeedAdmission) {
        rejectNextFeedAdmission := false;
        return false;
    };
    if (
        not sameFeedSnapshot(commit.expected, feedSnapshot()) or
        commit.revision != feedRevision + 1 or
        commit.candidate.local_sequence != feedLastSequence + 1 or
        Map.get(
            feedCandidates,
            Blob.compare,
            commit.candidate.candidate_id,
        ) != null or
        findFeedTransport(commit.transport.key) != null
    ) return false;

    Map.add(
        feedCandidates,
        Blob.compare,
        commit.candidate.candidate_id,
        commit.candidate,
    );
    if (commit.visible) {
        Map.add(
            feedOrder,
            Nat64.compare,
            commit.candidate.local_sequence,
            commit.candidate.candidate_id,
        );
    };
    feedTransports := appendArray(feedTransports, commit.transport);
    feedCandidateBytes += commit.candidate.retained_bytes;
    feedLastSequence := commit.candidate.local_sequence;
    feedRevision := commit.revision;
    true;
};

func candidateReplacementValid(
    replacement : FeedTypes.CandidateReplacement
) : Bool {
    let ?current = Map.get(
        feedCandidates,
        Blob.compare,
        replacement.previous.candidate_id,
    ) else return false;
    Blob.equal(
        current.candidate_id,
        replacement.previous.candidate_id,
    ) and
    current.local_sequence == replacement.previous.local_sequence and
    current.verification == replacement.previous.verification;
};

func canonicalChangeValid(
    change : FeedTypes.CanonicalReplacement
) : Bool {
    switch (change.previous, findFeedCanonical(change.replacement.key)) {
        case (null, null) true;
        case (?previous, ?current) {
            Blob.equal(
                previous.first_candidate_id,
                current.first_candidate_id,
            ) and
            previous.latest_local_sequence ==
                current.latest_local_sequence;
        };
        case (_) false;
    };
};

func suppressionChangeValid(
    change : FeedTypes.SuppressionReplacement
) : Bool {
    switch (change.previous, findFeedSuppression(change.replacement.key)) {
        case (null, null) true;
        case (?previous, ?current) {
            Blob.equal(previous.tombstone_id, current.tombstone_id);
        };
        case (_) false;
    };
};

func applyCanonicalChange(change : FeedTypes.CanonicalReplacement) {
    switch (change.previous) {
        case null {
            feedCanonicals := appendArray(
                feedCanonicals,
                change.replacement,
            );
            feedVerifiedCount += 1;
        };
        case (?_) {
            feedCanonicals := Array.map<FeedTypes.CanonicalRecord, FeedTypes.CanonicalRecord>(
                feedCanonicals,
                func(current) {
                    if (
                        sameFeedCanonicalKey(
                            current.key,
                            change.replacement.key,
                        )
                    ) change.replacement else current;
                },
            );
        };
    };
};

func applySuppressionChange(change : FeedTypes.SuppressionReplacement) {
    switch (change.previous) {
        case null {
            feedSuppressions := appendArray(
                feedSuppressions,
                change.replacement,
            );
        };
        case (?_) {
            feedSuppressions := Array.map<FeedTypes.SuppressionRecord, FeedTypes.SuppressionRecord>(
                feedSuppressions,
                func(current) {
                    if (
                        sameFeedCanonicalKey(
                            current.key,
                            change.replacement.key,
                        )
                    ) change.replacement else current;
                },
            );
        };
    };
};

func commitFeedPromotion(commit : FeedTypes.PromotionCommit) : Bool {
    feedPromotionCalls += 1;
    if (rejectNextFeedPromotion) {
        rejectNextFeedPromotion := false;
        return false;
    };
    if (
        not sameFeedSnapshot(commit.expected, feedSnapshot()) or
        commit.revision != feedRevision + 1
    ) return false;
    for (replacement in commit.candidates.vals()) {
        if (not candidateReplacementValid(replacement)) return false;
    };
    switch (commit.canonical) {
        case (?change) {
            if (not canonicalChangeValid(change)) return false;
        };
        case null {};
    };
    switch (commit.attribution) {
        case (?attribution) {
            if (
                findFeedAttribution(
                    attribution.key,
                    attribution.sharer,
                ) != null
            ) return false;
        };
        case null {};
    };
    switch (commit.suppression) {
        case (?change) {
            if (not suppressionChangeValid(change)) return false;
        };
        case null {};
    };
    for (replacement in commit.candidates.vals()) {
        Map.add(
            feedCandidates,
            Blob.compare,
            replacement.replacement.candidate_id,
            replacement.replacement,
        );
    };
    switch (commit.canonical) {
        case (?change) applyCanonicalChange(change);
        case null {};
    };
    switch (commit.attribution) {
        case (?attribution) {
            feedAttributions := appendArray(feedAttributions, attribution);
        };
        case null {};
    };
    switch (commit.suppression) {
        case (?change) applySuppressionChange(change);
        case null {};
    };
    for (sequence in commit.hide_sequences.vals()) {
        Map.add(hiddenFeedSequences, Nat64.compare, sequence, ());
    };
    feedRevision := commit.revision;
    true;
};

func commitFeedVerification(
    commit : FeedTypes.VerificationCommit
) : Bool {
    feedVerificationCalls += 1;
    if (rejectNextFeedVerification) {
        rejectNextFeedVerification := false;
        return false;
    };
    if (
        commit.expected_revision != feedRevision or
        commit.revision != feedRevision + 1 or
        not candidateReplacementValid(commit.candidate)
    ) return false;
    if (commit.candidate.replacement.verification == #invalid) {
        Map.remove(
            feedCandidates,
            Blob.compare,
            commit.candidate.previous.candidate_id,
        );
        Map.remove(
            feedOrder,
            Nat64.compare,
            commit.candidate.previous.local_sequence,
        );
        feedCandidateBytes -=
            commit.candidate.previous.retained_bytes;
    } else {
        Map.add(
            feedCandidates,
            Blob.compare,
            commit.candidate.replacement.candidate_id,
            commit.candidate.replacement,
        );
    };
    feedRevision := commit.revision;
    true;
};

let feedStore : FeedTypes.Store = {
    snapshot = feedSnapshot;
    count_for_sender = feedCountForSender;
    find_candidate = func(candidateId) {
        Map.get(feedCandidates, Blob.compare, candidateId);
    };
    find_transport = findFeedTransport;
    find_canonical = findFeedCanonical;
    find_canonical_slot = findFeedCanonicalSlot;
    find_attribution = findFeedAttribution;
    attribution_count = feedAttributionCount;
    find_suppression = findFeedSuppression;
    scan_claimed_slot = scanClaimedFeedSlot;
    scan_descending = scanFeedDescending;
    commit_admission = commitFeedAdmission;
    commit_promotion = commitFeedPromotion;
    commit_verification = commitFeedVerification;
};

let feed = FeedService.Service(feedStore);

func feedAdmission(
    key : Text,
    candidateId : Blob,
    operationId : Blob,
    payloadDigest : Blob,
    sender : Principal,
    eventKind : FeedTypes.FeedEventKindV1,
    claimedAuthor : Principal,
    postId : Blob,
    bodyHash : Blob,
    exactEvent : Blob,
    receivedAt : Nat64,
) : FeedTypes.CandidateAdmission {
    {
        candidate_key = key;
        candidate_id = candidateId;
        route_receipt_key = "receipt:" # key;
        operation_id = operationId;
        payload_digest = payloadDigest;
        subscription_id = repeated(0x77, 16);
        received_at_ns = receivedAt;
        immediate_sender = sender;
        event_kind = eventKind;
        claimed_author = claimedAuthor;
        claimed_post_id = postId;
        claimed_body_hash = bodyHash;
        exact_event_candid = exactEvent;
        retain_until_ns = receivedAt + 1_000;
        retained_bytes = exactEvent.size() + 100;
    };
};

func verifiedPost(
    author : Principal,
    postId : Blob,
    bodyHash : Blob,
) : FeedTypes.VerifiedPost {
    let objectDigest = repeated(0x99, 32);
    {
        key = {
            author;
            post_id = postId;
            body_hash = bodyHash;
        };
        body_length = 128;
        object_digest = objectDigest;
        exact_certified_post_ref_candid = "exact-certified-post-ref";
        certified_ref = {
            author;
            post_id = postId;
            body_hash = bodyHash;
            body_length = 128;
            object_digest = objectDigest;
            proof = {
                certificate_version = 2;
                certificate_cbor = "certificate";
                witness_cbor = "witness";
                expression_path_cbor = "expression-path";
                certificate_time_ns = 100;
            };
        };
    };
};

let originalAdmission = feedAdmission(
    "candidate:original",
    repeated(0x01, 32),
    repeated(0x01, 16),
    repeated(0x81, 32),
    actorA,
    #original,
    actorA,
    hashA,
    hashB,
    "exact-certified-post-ref",
    100,
);
let originalAccepted = switch (feed.admit(originalAdmission)) {
    case (#accepted(value)) value;
    case (_) Runtime.trap("expected original candidate admission");
};
assert (originalAccepted.local_sequence == 1);
assert (feedRevision == 1);

// Receiver-local clock and retention accounting do not participate in the
// paid route's exact payload replay identity.
assert (
    feed.admit({
        originalAdmission with
        received_at_ns = 200;
        retain_until_ns = 2_000;
        retained_bytes = originalAdmission.retained_bytes + 1;
    }) == #duplicate({
        candidate_id = originalAdmission.candidate_id;
        local_sequence = 1;
        revision = 1;
    })
);
assert (
    feed.admit({
        originalAdmission with
        candidate_id = repeated(0x02, 32);
        payload_digest = repeated(0x82, 32);
    }) == #conflict({
        candidate_id = originalAdmission.candidate_id;
        local_sequence = 1;
        revision = 1;
    })
);

let shareAdmission = feedAdmission(
    "candidate:share",
    repeated(0x02, 32),
    repeated(0x02, 16),
    repeated(0x82, 32),
    actorB,
    #share,
    actorA,
    hashA,
    hashB,
    "share-event",
    110,
);
assert (
    feed.admit(shareAdmission) ==
    #accepted({
        candidate_id = shareAdmission.candidate_id;
        local_sequence = 2;
        revision = 2;
    })
);

let conflictingAdmission = feedAdmission(
    "candidate:conflicting",
    repeated(0x03, 32),
    repeated(0x03, 16),
    repeated(0x83, 32),
    actorA,
    #original,
    actorA,
    hashA,
    hashC,
    "conflicting-event",
    120,
);
assert (
    feed.admit(conflictingAdmission) ==
    #accepted({
        candidate_id = conflictingAdmission.candidate_id;
        local_sequence = 3;
        revision = 3;
    })
);

let firstFeedPage = switch (
    feed.page({ before_sequence = null; limit = 2 })
) {
    case (#ok(value)) value;
    case (_) Runtime.trap("expected first feed page");
};
assert (firstFeedPage.items.size() == 2);
assert (firstFeedPage.items[0].local_sequence == 3);
assert (firstFeedPage.items[1].local_sequence == 2);
assert (firstFeedPage.next_before_sequence == ?2);
let secondFeedPage = switch (
    feed.page({ before_sequence = ?2; limit = 2 })
) {
    case (#ok(value)) value;
    case (_) Runtime.trap("expected second feed page");
};
assert (secondFeedPage.items.size() == 1);
assert (secondFeedPage.items[0].local_sequence == 1);
assert (secondFeedPage.next_before_sequence == null);
assert (
    feed.page({ before_sequence = null; limit = 0 }) ==
    #err(#invalid_limit)
);
assert (
    feed.page({
        before_sequence = null;
        limit = Nat16.fromNat(26);
    }) == #err(#invalid_limit)
);

switch (
    feed.markVerification({
        candidate_id = conflictingAdmission.candidate_id;
        verification = #unavailable;
    })
) {
    case (#changed(value)) {
        assert (value.verification == #unavailable);
        assert (value.revision == 4);
    };
    case (_) Runtime.trap("expected unavailable feed transition");
};
switch (
    feed.markVerification({
        candidate_id = conflictingAdmission.candidate_id;
        verification = #pending;
    })
) {
    case (#changed(value)) {
        assert (value.verification == #pending);
        assert (value.revision == 5);
    };
    case (_) Runtime.trap("expected retryable pending feed transition");
};

let canonicalPost = verifiedPost(actorA, hashA, hashB);
let promotedOriginal = switch (
    feed.promoteDelivery({
        candidate_id = originalAdmission.candidate_id;
        post = canonicalPost;
        share = null;
        verified_at_ns = 130;
    })
) {
    case (#promoted(value)) value;
    case (_) Runtime.trap("expected original promotion");
};
assert (promotedOriginal.revision == 6);
let ?canonicalAfterOriginal = promotedOriginal.canonical else {
    Runtime.trap("canonical feed record missing");
};
assert (canonicalAfterOriginal.status == #active);
let ?conflictingAfterPromotion = Map.get(
    feedCandidates,
    Blob.compare,
    conflictingAdmission.candidate_id,
) else Runtime.trap("conflicting candidate missing");
assert (conflictingAfterPromotion.verification == #invalid);
assert (
    feed.promoteDelivery({
        candidate_id = originalAdmission.candidate_id;
        post = canonicalPost;
        share = null;
        verified_at_ns = 140;
    }) == #duplicate({
        candidate_id = originalAdmission.candidate_id;
        revision = 6;
        canonical = ?canonicalAfterOriginal;
    })
);

let verifiedShare : FeedTypes.VerifiedShare = {
    sharer = actorB;
    share_id = repeated(0x51, 32);
    share_object_digest = repeated(0x52, 32);
    exact_delivery_candid = shareAdmission.exact_event_candid;
    exact_original_post_ref_candid =
        canonicalPost.exact_certified_post_ref_candid;
    exact_share_action_candid = "exact-share-action";
    exact_share_ref_candid = "exact-share-ref";
};
let mergedShare = switch (
    feed.promoteDelivery({
        candidate_id = shareAdmission.candidate_id;
        post = canonicalPost;
        share = ?verifiedShare;
        verified_at_ns = 150;
    })
) {
    case (#merged(value)) value;
    case (_) Runtime.trap("expected share merge");
};
let ?canonicalAfterShare = mergedShare.canonical else {
    Runtime.trap("canonical missing after share");
};
assert (canonicalAfterShare.latest_local_sequence == 2);
assert (
    findFeedAttribution(canonicalPost.key, actorB) != null
);

let repeatedShareAdmission = feedAdmission(
    "candidate:repeated-share",
    repeated(0x04, 32),
    repeated(0x04, 16),
    repeated(0x84, 32),
    actorB,
    #share,
    actorA,
    hashA,
    hashB,
    "share-event",
    160,
);
ignore feed.admit(repeatedShareAdmission);
let repeatedShare = switch (
    feed.promoteDelivery({
        candidate_id = repeatedShareAdmission.candidate_id;
        post = canonicalPost;
        share = ?verifiedShare;
        verified_at_ns = 170;
    })
) {
    case (#merged(value)) value;
    case (_) Runtime.trap("expected repeated share merge");
};
let ?canonicalAfterRepeatedShare = repeatedShare.canonical else {
    Runtime.trap("canonical missing after repeated share");
};
assert (canonicalAfterRepeatedShare.latest_local_sequence == 2);
assert (feedAttributions.size() == 1);

let tombstoneAdmission = feedAdmission(
    "candidate:tombstone",
    repeated(0x05, 32),
    repeated(0x05, 16),
    repeated(0x85, 32),
    actorB,
    #tombstone,
    actorA,
    hashA,
    hashB,
    "exact-tombstone",
    180,
);
ignore feed.admit(tombstoneAdmission);
let promotedTombstone = switch (
    feed.promoteTombstone({
        candidate_id = tombstoneAdmission.candidate_id;
        key = canonicalPost.key;
        tombstone_id = repeated(0x61, 32);
        exact_tombstone_candid = tombstoneAdmission.exact_event_candid;
        verified_at_ns = 190;
        retain_until_ns = 1_190;
    })
) {
    case (#promoted(value)) value;
    case (_) Runtime.trap("expected attributed tombstone relay");
};
let ?withdrawnCanonical = promotedTombstone.canonical else {
    Runtime.trap("withdrawn canonical missing");
};
switch (withdrawnCanonical.status) {
    case (#withdrawn(value)) {
        assert (Blob.equal(value.tombstone_id, repeated(0x61, 32)));
    };
    case (#active) Runtime.trap("tombstone did not withdraw feed item");
};
assert (findFeedSuppression(canonicalPost.key) != null);
let promotionCallsAfterTombstone = feedPromotionCalls;
switch (
    feed.promoteTombstone({
        candidate_id = tombstoneAdmission.candidate_id;
        key = canonicalPost.key;
        tombstone_id = repeated(0x61, 32);
        exact_tombstone_candid = tombstoneAdmission.exact_event_candid;
        verified_at_ns = 191;
        retain_until_ns = 1_191;
    })
) {
    case (#duplicate(value)) {
        assert (value.revision == feedRevision);
    };
    case (_) Runtime.trap("expected exact tombstone promotion replay");
};
assert (feedPromotionCalls == promotionCallsAfterTombstone);

let delayedAdmission = feedAdmission(
    "candidate:delayed",
    repeated(0x06, 32),
    repeated(0x06, 16),
    repeated(0x86, 32),
    actorA,
    #original,
    actorA,
    hashA,
    hashB,
    "exact-certified-post-ref",
    200,
);
ignore feed.admit(delayedAdmission);
switch (
    feed.promoteDelivery({
        candidate_id = delayedAdmission.candidate_id;
        post = canonicalPost;
        share = null;
        verified_at_ns = 210;
    })
) {
    case (#suppressed(value)) {
        assert (
            Blob.equal(value.candidate_id, delayedAdmission.candidate_id)
        );
    };
    case (_) Runtime.trap("suppression did not block delayed delivery");
};

let actorC = Principal.fromText("r7inp-6aaaa-aaaaa-aaabq-cai");
let unauthorizedTombstone = feedAdmission(
    "candidate:unauthorized-tombstone",
    repeated(0x07, 32),
    repeated(0x07, 16),
    repeated(0x87, 32),
    actorC,
    #tombstone,
    actorA,
    hashA,
    hashB,
    "unauthorized-tombstone",
    220,
);
ignore feed.admit(unauthorizedTombstone);
switch (
    feed.promoteTombstone({
        candidate_id = unauthorizedTombstone.candidate_id;
        key = canonicalPost.key;
        tombstone_id = repeated(0x62, 32);
        exact_tombstone_candid =
            unauthorizedTombstone.exact_event_candid;
        verified_at_ns = 230;
        retain_until_ns = 1_230;
    })
) {
    case (#err(#invalid)) {};
    case (unexpected) {
        Runtime.trap(
            "expected unauthorized tombstone rejection: " #
            debug_show (unexpected)
        );
    };
};

let visibleAfterWithdrawal = switch (
    feed.page({ before_sequence = null; limit = 25 })
) {
    case (#ok(value)) value;
    case (_) Runtime.trap("expected feed page after withdrawal");
};
assert (visibleAfterWithdrawal.items.size() == 2);
assert (
    Blob.equal(
        visibleAfterWithdrawal.items[0].candidate_id,
        tombstoneAdmission.candidate_id,
    )
);
assert (
    Blob.equal(
        visibleAfterWithdrawal.items[1].candidate_id,
        conflictingAdmission.candidate_id,
    )
);
assert (visibleAfterWithdrawal.items[1].verification == ?#invalid);

let feedRowsBeforeStale = Map.size(feedCandidates);
let feedSequenceBeforeStale = feedLastSequence;
let feedRevisionBeforeStale = feedRevision;
rejectNextFeedAdmission := true;
let staleFeedAdmission = feedAdmission(
    "candidate:stale",
    repeated(0x08, 32),
    repeated(0x08, 16),
    repeated(0x88, 32),
    actorA,
    #original,
    actorA,
    hashD,
    hashC,
    "exact-certified-post-ref",
    240,
);
assert (
    feed.admit(staleFeedAdmission) == #rejected(#stale_state)
);
assert (Map.size(feedCandidates) == feedRowsBeforeStale);
assert (feedLastSequence == feedSequenceBeforeStale);
assert (feedRevision == feedRevisionBeforeStale);

rejectNextFeedVerification := true;
assert (
    feed.markVerification({
        candidate_id = unauthorizedTombstone.candidate_id;
        verification = #invalid;
    }) == #err(#stale_state)
);
let ?unauthorizedAfterStale = Map.get(
    feedCandidates,
    Blob.compare,
    unauthorizedTombstone.candidate_id,
) else Runtime.trap("unauthorized candidate disappeared");
assert (unauthorizedAfterStale.verification == #pending);
assert (feedRevision == feedRevisionBeforeStale);

let admissionCallsBeforeCapacity = feedAdmissionCalls;
feedCountOverride := ?FeedTypes.MAX_CANDIDATES;
feedSequenceOverride := ?Nat64.fromNat(FeedTypes.MAX_CANDIDATES);
assert (
    feed.admit(staleFeedAdmission) ==
    #rejected(#full(#total_count))
);
feedCountOverride := null;
feedSequenceOverride := null;
feedSenderCountOverride := ?FeedTypes.MAX_CANDIDATES_PER_SENDER;
feedCountOverride := ?FeedTypes.MAX_CANDIDATES_PER_SENDER;
feedSequenceOverride :=
    ?Nat64.fromNat(FeedTypes.MAX_CANDIDATES_PER_SENDER);
assert (
    feed.admit(staleFeedAdmission) ==
    #rejected(#full(#sender_count))
);
feedSenderCountOverride := null;
feedCountOverride := null;
feedSequenceOverride := null;
feedBytesOverride := ?FeedTypes.MAX_CANDIDATE_BYTES;
assert (
    feed.admit(staleFeedAdmission) ==
    #rejected(#full(#total_bytes))
);
feedBytesOverride := null;
assert (feedAdmissionCalls == admissionCallsBeforeCapacity);

let invalidPost : FeedTypes.VerifiedPost = {
    canonicalPost with body_length = (0 : Nat32)
};
assert (
    feed.promoteDelivery({
        candidate_id = unauthorizedTombstone.candidate_id;
        post = invalidPost;
        share = null;
        verified_at_ns = 250;
    }) == #err(#invalid)
);
let feedBytesBeforeInvalidDiscard = feedCandidateBytes;
switch (
    feed.markVerification({
        candidate_id = unauthorizedTombstone.candidate_id;
        verification = #invalid;
    })
) {
    case (#changed(value)) {
        assert (value.verification == #invalid);
    };
    case (_) Runtime.trap("expected invalid candidate discard");
};
assert (
    Map.get(
        feedCandidates,
        Blob.compare,
        unauthorizedTombstone.candidate_id,
    ) == null
);
assert (
    Map.get(
        feedOrder,
        Nat64.compare,
        unauthorizedAfterStale.local_sequence,
    ) == null
);
assert (
    feedCandidateBytes +
        unauthorizedTombstone.retained_bytes ==
        feedBytesBeforeInvalidDiscard
);

// Promotion commits use the same no-partial-write CAS boundary as admission
// and verification, including the canonical and conflict replacement plan.
let promotionCandidate = switch (feed.admit(staleFeedAdmission)) {
    case (#accepted(value)) value;
    case (_) Runtime.trap("expected promotion CAS candidate");
};
let promotionPost = verifiedPost(actorA, hashD, hashC);
let feedRevisionBeforeStalePromotion = feedRevision;
let feedCanonicalsBeforeStalePromotion = feedCanonicals.size();
rejectNextFeedPromotion := true;
assert (
    feed.promoteDelivery({
        candidate_id = promotionCandidate.candidate_id;
        post = promotionPost;
        share = null;
        verified_at_ns = 260;
    }) == #err(#stale_state)
);
let ?candidateAfterStalePromotion = Map.get(
    feedCandidates,
    Blob.compare,
    promotionCandidate.candidate_id,
) else Runtime.trap("promotion candidate disappeared after failed CAS");
assert (candidateAfterStalePromotion.verification == #pending);
assert (feedRevision == feedRevisionBeforeStalePromotion);
assert (feedCanonicals.size() == feedCanonicalsBeforeStalePromotion);

assert (
    NotificationService.evidence(
        notificationStore,
        { local_sequence = 999 },
    ) ==
    #ok({ local_sequence = 999; found = false; evidence = null })
);

let verifiedLike = switch (
    NotificationService.setVerification(
        notificationStore,
        {
            local_sequence = like.summary.local_sequence;
            verification = #verified;
        },
    )
) {
    case (#changed(value)) value;
    case (_) Runtime.trap("expected Like verification promotion");
};
assert (verifiedLike.summary.verification == ?#verified);
assert (notificationRevision == 4);
let replacementsBeforeRejectedTransition = notificationReplaceCalls;
let revisionBeforeRejectedTransition = notificationRevision;
assert (
    NotificationService.setVerification(
        notificationStore,
        {
            local_sequence = like.summary.local_sequence;
            verification = #invalid;
        },
    ) == #err(#invalid_transition)
);
assert (
    notificationReplaceCalls == replacementsBeforeRejectedTransition
);
assert (notificationRevision == revisionBeforeRejectedTransition);

let verifiedReplyNotice = switch (
    NotificationService.setVerification(
        notificationStore,
        {
            local_sequence = notice.summary.local_sequence;
            verification = #verified;
        },
    )
) {
    case (#changed(value)) value;
    case (_) Runtime.trap("expected reply verification promotion");
};
assert (verifiedReplyNotice.summary.verification == ?#verified);
let replyCallsBeforeRejectedTransition = notificationReplaceCalls;
let replyRevisionBeforeRejectedTransition = notificationRevision;
assert (
    NotificationService.setVerification(
        notificationStore,
        {
            local_sequence = notice.summary.local_sequence;
            verification = #invalid;
        },
    ) == #err(#invalid_transition)
);
assert (
    notificationReplaceCalls == replyCallsBeforeRejectedTransition
);
assert (
    notificationRevision == replyRevisionBeforeRejectedTransition
);
assert (
    NotificationService.setVerification(
        notificationStore,
        {
            local_sequence = follower.summary.local_sequence;
            verification = #pending;
        },
    ) == #err(#invalid_transition)
);

let readLike = switch (
    NotificationService.markRead(
        notificationStore,
        like.summary.local_sequence,
    )
) {
    case (#changed(value)) value;
    case (_) Runtime.trap("expected notification read transition");
};
assert (readLike.summary.read);
assert (notificationRevision == 6);
let replacementsBeforeReplay = notificationReplaceCalls;
switch (
    NotificationService.markRead(
        notificationStore,
        like.summary.local_sequence,
    )
) {
    case (#unchanged(value)) {
        assert (value.revision == 6);
        assert (value.summary.read);
    };
    case (_) Runtime.trap("expected idempotent read transition");
};
assert (notificationReplaceCalls == replacementsBeforeReplay);

// A failed adapter CAS is the service's atomic boundary: the row, evidence,
// indexes, sequence, and revision remain untouched.
rejectNextNotificationAppend := true;
let rowsBeforeStaleAppend = Map.size(notificationRows);
let sequenceBeforeStaleAppend = notificationLastSequence;
let revisionBeforeStaleAppend = notificationRevision;
let staleAppend : NotificationTypes.AppendRequest = {
    acting_node = actorB;
    received_at_ns = 40;
    event = #notice({
        relation = #share;
        locator = notificationObject(hashB, hashC, hashA, hashD);
    });
};
assert (
    NotificationService.append(notificationStore, staleAppend) ==
    #rejected(#stale_state)
);
assert (Map.size(notificationRows) == rowsBeforeStaleAppend);
assert (notificationLastSequence == sequenceBeforeStaleAppend);
assert (notificationRevision == revisionBeforeStaleAppend);

rejectNextNotificationReplace := true;
assert (
    NotificationService.markRead(
        notificationStore,
        notice.summary.local_sequence,
    ) == #err(#stale_state)
);
let ?noticeAfterStale = Map.get(
    notificationRows,
    Nat64.compare,
    notice.summary.local_sequence,
) else Runtime.trap("notice disappeared after failed CAS");
assert (not noticeAfterStale.summary.read);
assert (notificationRevision == revisionBeforeStaleAppend);

let appendCallsBeforeInvalid = notificationAppendCalls;
assert (
    NotificationService.append(
        notificationStore,
        {
            likeRequest with
            acting_node = actorA;
            event = #like({
                locator = likeObject;
                certified_like_receipt_candid = repeated(0xee, 6_001);
            });
        },
    ) == #rejected(#invalid)
);
assert (notificationAppendCalls == appendCallsBeforeInvalid);

notificationTotalOverride := ?NotificationTypes.MAX_SUMMARIES;
assert (
    NotificationService.append(notificationStore, staleAppend) ==
    #rejected(#full(#total))
);
notificationTotalOverride := null;
notificationActorCountOverride :=
    ?NotificationTypes.MAX_NOTICE_SUMMARIES_PER_ACTOR;
assert (
    NotificationService.append(notificationStore, staleAppend) ==
    #rejected(#full(#notice_actor))
);
notificationActorCountOverride := null;
notificationTargetCountOverride :=
    ?NotificationTypes.MAX_NOTICE_SUMMARIES_PER_TARGET;
assert (
    NotificationService.append(notificationStore, staleAppend) ==
    #rejected(#full(#notice_target))
);
notificationTargetCountOverride := null;
assert (Map.size(notificationRows) == rowsBeforeStaleAppend);

Map.remove(
    notificationRows,
    Nat64.compare,
    like.summary.local_sequence,
);
assert (
    NotificationService.evidence(
        notificationStore,
        { local_sequence = like.summary.local_sequence },
    ) ==
    #ok({
        local_sequence = like.summary.local_sequence;
        found = false;
        evidence = null;
    })
);

// One claimed semantic post slot is a fixed small admission domain. A peer
// cannot make later verification materialize work proportional to the global
// 100,000-candidate store.
let boundedSlotPostId = repeated(0x91, 32);
let boundedSlotBodyHash = repeated(0x92, 32);
var boundedSlotIndex = 0;
while (
    boundedSlotIndex <
        FeedTypes.MAX_CANDIDATES_PER_CLAIMED_SLOT
) {
    let byte = Nat8.fromNat(boundedSlotIndex + 64);
    let admitted = feed.admit(
        feedAdmission(
            "candidate:bounded-slot:" # Nat.toText(boundedSlotIndex),
            repeated(byte, 32),
            repeated(byte, 16),
            repeated(Nat8.fromNat(boundedSlotIndex + 65), 32),
            actorA,
            #original,
            actorA,
            boundedSlotPostId,
            boundedSlotBodyHash,
            repeated(byte, 8),
            Nat64.fromNat(1_000 + boundedSlotIndex),
        )
    );
    switch (admitted) {
        case (#accepted(_)) {};
        case (_) Runtime.trap("bounded claimed slot rejected too early");
    };
    boundedSlotIndex += 1;
};

assert (
    feed.admit(
        feedAdmission(
            "candidate:bounded-slot:overflow",
            repeated(0xf0, 32),
            repeated(0xf0, 16),
            repeated(0xf1, 32),
            actorA,
            #original,
            actorA,
            boundedSlotPostId,
            boundedSlotBodyHash,
            repeated(0xf2, 8),
            2_000,
        )
    ) == #rejected(#full(#claimed_slot))
);
