import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";

import Feed "../../backend/feed/Types";
import IngressService "../../backend/ingress/Service";
import Ingress "../../backend/ingress/Types";
import Likes "../../backend/likes/Admission";
import Notifications "../../backend/notifications/Types";
import Bounds "../../backend/protocol/Bounds";
import Hash "../../backend/protocol/Hash";
import Protocol "../../backend/protocol/Types";
import Wire "../../backend/protocol/Wire";
import Relationships "../../backend/relationships/Types";

func appendArray<Value>(values : [Value], value : Value) : [Value] {
    Array.tabulate<Value>(
        values.size() + 1,
        func(index) {
            if (index < values.size()) values[index] else value
        },
    )
};

let selfNode = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
let peer = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
let otherPeer = Principal.fromText("r7inp-6aaaa-aaaaa-aaabq-cai");
let networkId = Blob.fromArray(Array.repeat<Nat8>(0xa2, 32));
let subscription = Blob.fromArray(Array.repeat<Nat8>(0x5a, 16));
let postBodyHash = Blob.fromArray(Array.repeat<Nat8>(0x22, 32));
let postId = switch (
    Hash.postId(networkId, selfNode, postBodyHash)
) {
    case (?value) value;
    case null Runtime.trap("local post id");
};

func repeated(byte : Nat8, count : Nat) : Blob {
    Blob.fromArray(Array.repeat<Nat8>(byte, count));
};

func operation(byte : Nat8) : Blob {
    repeated(byte, Bounds.OPERATION_ID_BYTES);
};

func blob32(byte : Nat8) : Blob {
    repeated(byte, Bounds.HASH_BYTES);
};

func derivedPostId(
    author : Principal,
    bodyHash : Blob,
) : Blob {
    let ?value = Hash.postId(networkId, author, bodyHash)
        else Runtime.trap("derived post id");
    value;
};

func sameReceiptKey(
    left : Ingress.ReceiptKey,
    right : Ingress.ReceiptKey,
) : Bool {
    Principal.equal(left.caller, right.caller) and
    left.route == right.route and
    Blob.equal(left.operation_id, right.operation_id);
};

func sameTransportKey(
    left : Feed.TransportKey,
    right : Feed.TransportKey,
) : Bool {
    Principal.equal(
        left.immediate_sender,
        right.immediate_sender,
    ) and Blob.equal(left.operation_id, right.operation_id);
};

func sameSemanticKey(
    left : Notifications.SemanticKey,
    right : Notifications.SemanticKey,
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

func sameFollowerExpected(
    expected : ?Nat64,
    current : ?Relationships.FollowerRow,
) : Bool {
    switch (expected, current) {
        case (null, null) true;
        case (?revision, ?row) revision == row.storage_revision;
        case (_) false;
    };
};

func sameFollowingExpected(
    expected : ?Nat64,
    current : ?Relationships.FollowingRow,
) : Bool {
    switch (expected, current) {
        case (null, null) true;
        case (?revision, ?row) revision == row.storage_revision;
        case (_) false;
    };
};

func isNotice(
    stored : Notifications.StoredNotification
) : Bool {
    switch (stored.summary.kind) {
        case (?#reply(_) or ?#share(_)) true;
        case (_) false;
    };
};

func noticeTarget(
    stored : Notifications.StoredNotification
) : ?Blob {
    switch (stored.summary.kind) {
        case (?#reply(value) or ?#share(value)) {
            ?value.target_post_id;
        };
        case (_) null;
    };
};

func domainEmpty(domain : Ingress.DomainMutation) : Bool {
    domain.follower == null and
    domain.following == null and
    domain.feed == null and
    domain.notification == null and
    domain.like == null;
};

class Harness() {
    var receipts : [Ingress.Receipt] = [];
    var rates : [Ingress.RateWindow] = [];

    var followers : [Relationships.FollowerRow] = [];
    var followerCounters : Relationships.FollowerCounters = {
        follower_revision = 0;
        max_registration_sequence = 0;
    };
    var followings : [Relationships.FollowingRow] = [];
    var blocks : [Relationships.BlockRow] = [];

    var feedSnapshot : Feed.StoreSnapshot = {
        revision = 0;
        last_sequence = 0;
        candidate_count = 0;
        candidate_bytes = 0;
        verified_feed_count = 0;
    };
    var candidates : [Feed.StoredCandidate] = [];
    var transports : [Feed.TransportBinding] = [];

    var notificationSnapshot : Notifications.StoreSnapshot = {
        revision = 0;
        last_sequence = 0;
        total_count = 0;
    };
    var notificationRows :
        [(Notifications.SemanticKey, Notifications.StoredNotification)] = [];
    var latestFollowerSummaryPresent : ?Bool = null;

    var currentLikeTarget : ?Ingress.LikeTarget = null;
    var currentAuthoredTarget : ?Ingress.AuthoredPostTarget = null;

    var allowPreflight = true;
    var allowCommit = true;
    var preflightCount = 0;
    var atomicCommitAttemptCount = 0;
    var atomicCommitCount = 0;
    var latestNotificationRetainUntil : ?Nat64 = null;
    var latestLikeRetainUntil : ?Nat64 = null;

    func findReceipt(key : Ingress.ReceiptKey) : ?Ingress.Receipt {
        for (receipt in receipts.vals()) {
            if (sameReceiptKey(receipt.key, key)) return ?receipt;
        };
        null;
    };

    func findRate(
        caller : Principal,
        route : Ingress.Route,
    ) : ?Ingress.RateWindow {
        for (window in rates.vals()) {
            if (
                Principal.equal(window.caller, caller) and
                window.route == route
            ) return ?window;
        };
        null;
    };

    func replaceRate(replacement : Ingress.RateWindow) {
        rates := appendArray(
            Array.filter<Ingress.RateWindow>(
                rates,
                func(window) {
                    not (
                        Principal.equal(
                            window.caller,
                            replacement.caller,
                        ) and window.route == replacement.route
                    );
                },
            ),
            replacement,
        );
    };

    func findFollower(
        node : Principal
    ) : ?Relationships.FollowerRow {
        for (row in followers.vals()) {
            if (Principal.equal(row.node, node)) return ?row;
        };
        null;
    };

    func replaceFollower(replacement : Relationships.FollowerRow) {
        followers := appendArray(
            Array.filter<Relationships.FollowerRow>(
                followers,
                func(row) {
                    not Principal.equal(row.node, replacement.node);
                },
            ),
            replacement,
        );
    };

    func findFollowing(
        node : Principal
    ) : ?Relationships.FollowingRow {
        for (row in followings.vals()) {
            if (Principal.equal(row.node, node)) return ?row;
        };
        null;
    };

    func replaceFollowing(
        replacement : Relationships.FollowingRow
    ) {
        followings := appendArray(
            Array.filter<Relationships.FollowingRow>(
                followings,
                func(row) {
                    not Principal.equal(row.node, replacement.node);
                },
            ),
            replacement,
        );
    };

    func findBlock(node : Principal) : ?Relationships.BlockRow {
        for (row in blocks.vals()) {
            if (Principal.equal(row.node, node)) return ?row;
        };
        null;
    };

    func findCandidate(id : Blob) : ?Feed.StoredCandidate {
        for (candidate in candidates.vals()) {
            if (Blob.equal(candidate.candidate_id, id)) {
                return ?candidate;
            };
        };
        null;
    };

    func findTransport(
        key : Feed.TransportKey
    ) : ?Feed.TransportBinding {
        for (transport in transports.vals()) {
            if (sameTransportKey(transport.key, key)) {
                return ?transport;
            };
        };
        null;
    };

    func findSemantic(
        key : Notifications.SemanticKey
    ) : ?Notifications.StoredNotification {
        for ((candidate, stored) in notificationRows.vals()) {
            if (sameSemanticKey(candidate, key)) return ?stored;
        };
        null;
    };

    func findNotification(
        sequence : Nat64
    ) : ?Notifications.StoredNotification {
        for ((_, stored) in notificationRows.vals()) {
            if (stored.summary.local_sequence == sequence) return ?stored;
        };
        null;
    };

    func notificationScan(
        before : ?Nat64,
        limit : Nat,
    ) : [Notifications.StoredNotification] {
        let descending = Array.sort<(
            Notifications.SemanticKey,
            Notifications.StoredNotification
        )>(
            notificationRows,
            func(left, right) {
                Nat64.compare(
                    right.1.summary.local_sequence,
                    left.1.summary.local_sequence,
                );
            },
        );
        var result : [Notifications.StoredNotification] = [];
        label rows for ((_, stored) in descending.vals()) {
            switch (before) {
                case (?upper) {
                    if (stored.summary.local_sequence >= upper) {
                        continue rows;
                    };
                };
                case null {};
            };
            if (result.size() >= limit) break rows;
            result := appendArray(result, stored);
        };
        result;
    };

    func notificationCountForActor(actorNode : Principal) : Nat {
        var count = 0;
        for ((_, stored) in notificationRows.vals()) {
            if (
                Principal.equal(stored.summary.actor_, actorNode) and
                isNotice(stored)
            ) count += 1;
        };
        count;
    };

    func notificationCountForTarget(target : Blob) : Nat {
        var count = 0;
        for ((_, stored) in notificationRows.vals()) {
            switch (noticeTarget(stored)) {
                case (?candidate) {
                    if (Blob.equal(candidate, target)) count += 1;
                };
                case null {};
            };
        };
        count;
    };

    func canApplyRate(mutation : ?Ingress.RateMutation) : Bool {
        switch (mutation) {
            case null true;
            case (?change) {
                change.expected ==
                    findRate(
                        change.replacement.caller,
                        change.replacement.route,
                    ) and change.stable_key.size() > 0;
            };
        };
    };

    func canApplyFollower(
        mutation : ?Relationships.FollowerMutation
    ) : Bool {
        switch (mutation) {
            case null true;
            case (?change) {
                Principal.equal(change.node, change.next_row.node) and
                sameFollowerExpected(
                    change.expected_storage_revision,
                    findFollower(change.node),
                ) and change.expected_counters == followerCounters;
            };
        };
    };

    func canApplyFollowing(
        mutation : ?Relationships.FollowingMutation
    ) : Bool {
        switch (mutation) {
            case null true;
            case (?change) {
                Principal.equal(change.node, change.next_row.node) and
                sameFollowingExpected(
                    change.expected_storage_revision,
                    findFollowing(change.node),
                );
            };
        };
    };

    func canApplyFeed(mutation : ?Feed.AdmissionCommit) : Bool {
        switch (mutation) {
            case null true;
            case (?change) {
                change.expected == feedSnapshot and
                change.revision == feedSnapshot.revision + 1 and
                change.candidate.local_sequence ==
                    feedSnapshot.last_sequence + 1 and
                findCandidate(change.candidate.candidate_id) == null and
                findTransport(change.transport.key) == null;
            };
        };
    };

    func canApplyNotification(
        mutation : ?Ingress.NotificationMutation
    ) : Bool {
        switch (mutation) {
            case null true;
            case (?change) {
                let append = change.append;
                append.expected == notificationSnapshot and
                append.revision == notificationSnapshot.revision + 1 and
                append.stored.summary.local_sequence ==
                    notificationSnapshot.last_sequence + 1 and
                findSemantic(append.semantic_key) == null;
            };
        };
    };

    func canApplyLike(mutation : ?Ingress.LikeMutation) : Bool {
        switch (mutation) {
            case null true;
            case (?change) {
                switch (currentLikeTarget) {
                    case null false;
                    case (?target) {
                        target.post_key == change.post_key and
                        target.next_accepted_sequence ==
                            change.expected_next_accepted_sequence and
                        target.existing_receipt_digest ==
                            change.expected_existing_receipt_digest and
                        target.segments == change.expected_segments;
                    };
                };
            };
        };
    };

    func applyRate(mutation : ?Ingress.RateMutation) {
        switch (mutation) {
            case (?change) replaceRate(change.replacement);
            case null {};
        };
    };

    func applyFollower(mutation : ?Relationships.FollowerMutation) {
        switch (mutation) {
            case (?change) {
                latestFollowerSummaryPresent :=
                    ?(change.new_follower_summary != null);
                replaceFollower(change.next_row);
                followerCounters := change.next_counters;
            };
            case null {};
        };
    };

    func applyFollowing(
        mutation : ?Relationships.FollowingMutation
    ) {
        switch (mutation) {
            case (?change) replaceFollowing(change.next_row);
            case null {};
        };
    };

    func applyFeed(mutation : ?Feed.AdmissionCommit) {
        switch (mutation) {
            case (?change) {
                candidates := appendArray(candidates, change.candidate);
                transports := appendArray(transports, change.transport);
                feedSnapshot := {
                    revision = change.revision;
                    last_sequence =
                        change.candidate.local_sequence;
                    candidate_count =
                        feedSnapshot.candidate_count + 1;
                    candidate_bytes =
                        feedSnapshot.candidate_bytes +
                        change.candidate.retained_bytes;
                    verified_feed_count =
                        feedSnapshot.verified_feed_count;
                };
            };
            case null {};
        };
    };

    func applyNotification(
        mutation : ?Ingress.NotificationMutation
    ) {
        switch (mutation) {
            case (?change) {
                let append = change.append;
                notificationRows := appendArray(
                    notificationRows,
                    (append.semantic_key, append.stored),
                );
                notificationSnapshot := {
                    revision = append.revision;
                    last_sequence =
                        append.stored.summary.local_sequence;
                    total_count =
                        notificationSnapshot.total_count + 1;
                };
                latestNotificationRetainUntil :=
                    ?change.retain_until_ns;
                switch (
                    append.stored.summary.kind,
                    append.stored.like_evidence,
                    currentLikeTarget,
                ) {
                    case (?#like(_), ?_, ?target) {
                        currentLikeTarget := ?{
                            target with
                            unsealed_receipt_count =
                                target.unsealed_receipt_count + 1;
                        };
                    };
                    case (_) {};
                };
            };
            case null {};
        };
    };

    func applyLike(mutation : ?Ingress.LikeMutation) {
        switch (mutation) {
            case (?change) {
                let ?target = currentLikeTarget else {
                    Runtime.trap("validated like target disappeared");
                };
                currentLikeTarget := ?{
                    target with
                    next_accepted_sequence =
                        change.replacement_next_accepted_sequence;
                    existing_receipt_digest =
                        ?change.accepted.receipt_digest;
                    segments = change.replacement_segments;
                };
                latestLikeRetainUntil := ?change.retain_until_ns;
            };
            case null {};
        };
    };

    func commitAtomic(plan : Ingress.CommitPlan) : Bool {
        atomicCommitAttemptCount += 1;
        if (
            not IngressService.validCommitPlanAccounting(plan) or
            (not allowCommit and not domainEmpty(plan.domain)) or
            findReceipt(plan.receipt.key) != null or
            not canApplyRate(plan.rate) or
            not canApplyFollower(plan.domain.follower) or
            not canApplyFollowing(plan.domain.following) or
            not canApplyFeed(plan.domain.feed) or
            not canApplyNotification(plan.domain.notification) or
            not canApplyLike(plan.domain.like)
        ) return false;

        receipts := appendArray(receipts, plan.receipt);
        applyRate(plan.rate);
        applyFollower(plan.domain.follower);
        applyFollowing(plan.domain.following);
        applyFeed(plan.domain.feed);
        applyNotification(plan.domain.notification);
        applyLike(plan.domain.like);
        atomicCommitCount += 1;
        true;
    };

    let relationshipState : Relationships.State = {
        follower = findFollower;
        followers = func() { followers };
        followers_by_registration = func(
            afterSequence : ?Nat64,
            limit : Nat,
        ) : ?[Relationships.FollowerRow] {
            let ordered = Array.sort<Relationships.FollowerRow>(
                followers,
                func(left, right) {
                    Nat64.compare(
                        left.registration_sequence,
                        right.registration_sequence,
                    );
                },
            );
            let remaining = Array.filter<Relationships.FollowerRow>(
                ordered,
                func(row) {
                    switch (afterSequence) {
                        case null true;
                        case (?cursor) {
                            row.registration_sequence > cursor;
                        };
                    };
                },
            );
            ?Array.tabulate<Relationships.FollowerRow>(
                Nat.min(limit, remaining.size()),
                func(index) { remaining[index] },
            );
        };
        active_follower_count = func() : Nat {
            var count = 0;
            for (row in followers.vals()) {
                switch (row.state) {
                    case (#active(_)) count += 1;
                    case (#inactive(_)) {};
                };
            };
            count;
        };
        follower_counters = func() { followerCounters };
        commit_follower = func(_) { false };
        following = findFollowing;
        following_count = func() : Nat {
            var count = 0;
            for (row in followings.vals()) {
                switch (row.intent) {
                    case (#on(_)) count += 1;
                    case (#off(_)) {};
                };
            };
            count;
        };
        commit_following = func(_) { false };
        block = findBlock;
        block_count = func() { blocks.size() };
        commit_block = func(_) { false };
    };

    let feedStore : Feed.Store = {
        snapshot = func() { feedSnapshot };
        count_for_sender = func(sender : Principal) : Nat {
            var count = 0;
            for (candidate in candidates.vals()) {
                if (
                    Principal.equal(
                        candidate.immediate_sender,
                        sender,
                    )
                ) count += 1;
            };
            count;
        };
        find_candidate = findCandidate;
        find_transport = findTransport;
        find_canonical = func(_ : Feed.CanonicalKey) { null };
        find_canonical_slot = func(
            _ : Principal,
            _ : Blob,
        ) : [Feed.CanonicalRecord] { [] };
        find_attribution = func(
            _ : Feed.CanonicalKey,
            _ : Principal,
        ) { null };
        attribution_count = func(_ : Feed.CanonicalKey) : Nat { 0 };
        find_suppression = func(_ : Feed.CanonicalKey) { null };
        scan_claimed_slot = func(
            author : Principal,
            id : Blob,
        ) : [Feed.StoredCandidate] {
            Array.filter<Feed.StoredCandidate>(
                candidates,
                func(candidate) {
                    Principal.equal(
                        candidate.claimed_author,
                        author,
                    ) and Blob.equal(candidate.claimed_post_id, id);
                },
            );
        };
        scan_descending = func(
            _ : ?Nat64,
            _ : Nat,
        ) : [Feed.StoredCandidate] { [] };
        commit_admission = func(_) { false };
        commit_promotion = func(_) { false };
        commit_verification = func(_) { false };
    };

    let notificationStore : Notifications.Store = {
        snapshot = func() { notificationSnapshot };
        find_semantic = findSemantic;
        get = findNotification;
        scan_descending = notificationScan;
        notice_count_for_actor = notificationCountForActor;
        notice_count_for_target = notificationCountForTarget;
        commit_append = func(_) { false };
        commit_replace = func(_) { false };
    };

    public func state() : Ingress.State {
        {
            receipt = findReceipt;
            receipt_stable_key = func(_) { "receipt-key" };
            candidate_stable_key = func(_) { "candidate-key" };
            rate_window = findRate;
            rate_window_stable_key = func(_, _) { "rate-key" };
            relationships = relationshipState;
            feed = feedStore;
            notifications = notificationStore;
            like_target = func(
                id : Blob,
                _liker : Principal,
            ) : ?Ingress.LikeTarget {
                switch (currentLikeTarget) {
                    case (?target) {
                        if (Blob.equal(target.post_id, id)) {
                            ?target;
                        } else null;
                    };
                    case null null;
                };
            };
            authored_post_target = func(
                id : Blob
            ) : ?Ingress.AuthoredPostTarget {
                switch (currentAuthoredTarget) {
                    case (?target) {
                        if (Blob.equal(target.post_id, id)) {
                            ?target;
                        } else null;
                    };
                    case null null;
                };
            };
            preflight = func(plan) {
                preflightCount += 1;
                IngressService.validCommitPlanAccounting(plan) and
                (allowPreflight or domainEmpty(plan.domain));
            };
            commit_atomic = commitAtomic;
        };
    };

    public func setPreflight(value : Bool) {
        allowPreflight := value;
    };

    public func setCommit(value : Bool) {
        allowCommit := value;
    };

    public func fillNotificationCapacity() {
        notificationSnapshot := {
            notificationSnapshot with
            total_count = Notifications.MAX_SUMMARIES;
        };
    };

    public func exhaustNotificationSequence() {
        notificationSnapshot := {
            notificationSnapshot with
            last_sequence = Nat64.maxValue;
        };
    };

    public func seedNewFollowerSemanticConflict(
        node : Principal,
        keyRevision : Nat64,
        storedRevision : Nat64,
    ) {
        let sequence = notificationSnapshot.last_sequence + 1;
        let semanticKey : Notifications.SemanticKey =
            #new_follower({
                acting_node = node;
                follower_revision = keyRevision;
            });
        let stored : Notifications.StoredNotification = {
            summary = {
                local_sequence = sequence;
                received_at_ns = 1;
                actor_ = node;
                kind = ?#new_follower({
                    follower_revision = storedRevision;
                });
                verification = ?#transport_authenticated;
                read = false;
            };
            like_evidence = null;
        };
        notificationRows := appendArray(
            notificationRows,
            (semanticKey, stored),
        );
        notificationSnapshot := {
            revision = notificationSnapshot.revision + 1;
            last_sequence = sequence;
            total_count = notificationSnapshot.total_count + 1;
        };
    };

    public func addBlock(node : Principal) {
        let row : Relationships.BlockRow = {
            node;
            storage_revision = 1;
            blocked_at_ns = 1;
        };
        blocks := appendArray(blocks, row);
    };

    public func installFollowing(
        node : Principal,
        id : Blob,
        status : Relationships.FollowingStatus,
    ) {
        let row : Relationships.FollowingRow = {
            node;
            intent_generation = 1;
            storage_revision = 1;
            intent = #on({ subscription_id = id; status });
            last_remote_revision = ?1;
            renewal_requested = false;
            locally_verified_delivery_count = 9;
            updated_at_ns = 1;
        };
        followings := appendArray(
            Array.filter<Relationships.FollowingRow>(
                followings,
                func(row) {
                    not Principal.equal(row.node, node);
                },
            ),
            row,
        );
    };

    public func setAuthoredTarget(
        target : ?Ingress.AuthoredPostTarget
    ) {
        currentAuthoredTarget := target;
    };

    public func setLikeTarget(target : ?Ingress.LikeTarget) {
        currentLikeTarget := target;
    };

    public func seedRate(window : Ingress.RateWindow) {
        replaceRate(window);
    };

    public func receiptCount() : Nat { receipts.size() };
    public func notificationCount() : Nat {
        notificationSnapshot.total_count;
    };
    public func candidateCount() : Nat {
        feedSnapshot.candidate_count;
    };
    public func commits() : Nat { atomicCommitCount };
    public func commitAttempts() : Nat {
        atomicCommitAttemptCount;
    };
    public func preflights() : Nat { preflightCount };
    public func rate(
        caller : Principal,
        route : Ingress.Route,
    ) : ?Ingress.RateWindow {
        findRate(caller, route);
    };
    public func receipt(
        caller : Principal,
        route : Ingress.Route,
        id : Blob,
    ) : ?Ingress.Receipt {
        findReceipt({ caller; route; operation_id = id });
    };
    public func follower(
        node : Principal
    ) : ?Relationships.FollowerRow {
        findFollower(node);
    };
    public func following(
        node : Principal
    ) : ?Relationships.FollowingRow {
        findFollowing(node);
    };
    public func candidateAt(index : Nat) : Feed.StoredCandidate {
        candidates[index];
    };
    public func notificationAt(
        sequence : Nat64
    ) : ?Notifications.StoredNotification {
        findNotification(sequence);
    };
    public func likeTarget() : ?Ingress.LikeTarget {
        currentLikeTarget;
    };
    public func notificationRetainUntil() : ?Nat64 {
        latestNotificationRetainUntil;
    };
    public func followerSummaryPresent() : ?Bool {
        latestFollowerSummaryPresent;
    };
    public func likeRetainUntil() : ?Nat64 {
        latestLikeRetainUntil;
    };
};

func ingress(
    route : Ingress.Route,
    caller : Principal,
    id : Blob,
    exactBody : Blob,
    now : Nat64,
) : Ingress.Request {
    {
        route;
        caller;
        exact_ingress_candid = Wire.encodeIngress({
            operation_id = id;
            body_candid = exactBody;
        });
        network_id = networkId;
        self_node = selfNode;
        now_ns = now;
    };
};

func execute(
    harness : Harness,
    route : Ingress.Route,
    caller : Principal,
    id : Blob,
    exactBody : Blob,
    now : Nat64,
) : Ingress.Response {
    IngressService.execute(
        harness.state(),
        ingress(route, caller, id, exactBody, now),
    );
};

func expectAccepted(response : Ingress.Response) {
    if (response.result.outcome != ?#accepted) {
        Runtime.trap(
            "expected accepted route result: " #
            debug_show (response.result)
        );
    };
};

func expectDuplicate(response : Ingress.Response) {
    if (response.result.outcome != ?#duplicate) {
        Runtime.trap("expected duplicate route result");
    };
};

func expectRejected(
    response : Ingress.Response,
    expected : Protocol.RouteRejectionReasonV1,
) {
    if (
        response.result.outcome !=
            ?#rejected({ reason = ?expected })
    ) Runtime.trap("unexpected route rejection");
};

func followBody(
    expectedRevision : Nat64,
    id : Blob,
) : Blob {
    Wire.encodeFollowBody({
        expected_revision = expectedRevision;
        subscription_id = id;
    });
};

func unfollowBody(
    expectedRevision : Nat64,
    id : Blob,
) : Blob {
    Wire.encodeUnfollowBody({
        expected_revision = expectedRevision;
        subscription_id = id;
    });
};

func proof() : Protocol.CertifiedHttpProofV1 {
    {
        certificate_version = 2;
        certificate_cbor = repeated(1, 1);
        witness_cbor = repeated(2, 1);
        expression_path_cbor = repeated(3, 1);
        certificate_time_ns = 1;
    };
};

func certifiedPostWithId(
    author : Principal,
    claimedPostId : Blob,
) : Blob {
    Wire.encodeCertifiedPostRef({
        author;
        post_id = claimedPostId;
        body_hash = postBodyHash;
        body_length = 10;
        object_digest = blob32(0x33);
        proof = proof();
    });
};

func certifiedPost(author : Principal) : Blob {
    certifiedPostWithId(
        author,
        derivedPostId(author, postBodyHash),
    );
};

func certifiedShareDelivery(
    sharer : Principal,
    originalAuthor : Principal,
    corruptPostId : Bool,
    corruptShareId : Bool,
) : Blob {
    let originalPostId = if (corruptPostId) {
        blob32(0x81);
    } else {
        derivedPostId(originalAuthor, postBodyHash);
    };
    let exactPostRef = certifiedPostWithId(
        originalAuthor,
        originalPostId,
    );
    let ?derivedShareId = Hash.shareId(
        networkId,
        sharer,
        originalAuthor,
        originalPostId,
    ) else Runtime.trap("derived share id");
    let shareId = if (corruptShareId) {
        blob32(0x82);
    } else {
        derivedShareId;
    };
    let action : Protocol.ShareActionV1 = {
        header = {
            network_id = networkId;
            actor_ = sharer;
            action_kind = ?#share;
        };
        share_id = shareId;
        share_sequence = 1;
        issued_at_ns = 205;
        original_author = originalAuthor;
        original_post_id = originalPostId;
        original_body_hash = postBodyHash;
        post_ref_digest = Hash.postRefDigest(exactPostRef);
    };
    let exactAction = Wire.encodeShareAction(action);
    Wire.encodeCertifiedShareDelivery({
        original_post_ref_candid = exactPostRef;
        share_action_candid = exactAction;
        share_ref = {
            sharer;
            share_id = shareId;
            body_length = Nat32.fromNat(exactAction.size());
            object_digest = Hash.objectDigest(exactAction);
            proof = proof();
        };
    });
};

func certifiedTombstone(
    author : Principal,
    corruptPostId : Bool,
    corruptTombstoneId : Bool,
) : Blob {
    let claimedPostId = if (corruptPostId) {
        blob32(0x83);
    } else {
        derivedPostId(author, postBodyHash);
    };
    let authorSequence : Nat64 = 2;
    let ?derivedTombstoneId = Hash.tombstoneId(
        networkId,
        author,
        claimedPostId,
        authorSequence,
    ) else Runtime.trap("derived tombstone id");
    let tombstoneId = if (corruptTombstoneId) {
        blob32(0x84);
    } else {
        derivedTombstoneId;
    };
    let action : Protocol.TombstoneActionV1 = {
        header = {
            network_id = networkId;
            actor_ = author;
            action_kind = ?#tombstone;
        };
        tombstone_id = tombstoneId;
        author_sequence = authorSequence;
        issued_at_ns = 206;
        post_id = claimedPostId;
        post_body_hash = postBodyHash;
    };
    let exactAction = Wire.encodeTombstoneAction(action);
    Wire.encodeCertifiedTombstone({
        tombstone_action_candid = exactAction;
        ref = {
            actor_ = author;
            action_kind = ?#tombstone;
            object_digest = Hash.objectDigest(exactAction);
            body_length = Nat32.fromNat(exactAction.size());
            proof_snapshot = proof();
        };
    });
};

func deliverBody(
    event : ?Protocol.DeliveryEventV1
) : Blob {
    deliverBodyWithRenewal(event, false);
};

func deliverBodyWithRenewal(
    event : ?Protocol.DeliveryEventV1,
    renewalRequested : Bool,
) : Blob {
    Wire.encodeDeliverBody({
        subscription_id = subscription;
        renewal_requested = renewalRequested;
        event;
    });
};

func noticeBody(
    actionId : Blob,
    objectDigest : Blob,
) : Blob {
    Wire.encodeNoticeBody({
        relation = ?#reply;
        target_post_id = postId;
        target_body_hash = postBodyHash;
        actor_action_id = actionId;
        actor_object_digest = objectDigest;
        actor_object_length = 128;
    });
};

func localPostTarget() : Ingress.AuthoredPostTarget {
    {
        post_key = "local-post";
        post_author = selfNode;
        post_id = postId;
        post_body_hash = postBodyHash;
        live = true;
    };
};

func emptyLikeTarget() : Ingress.LikeTarget {
    {
        post_key = "local-post";
        post_author = selfNode;
        post_id = postId;
        post_body_hash = postBodyHash;
        accepting_likes = true;
        unsealed_receipt_count = 0;
        unsealed_receipt_limit =
            Nat16.fromNat(Bounds.MAX_UNSEALED_LIKE_RECEIPTS);
        next_accepted_sequence = 1;
        existing_receipt_digest = null;
        segments = Likes.emptySegments();
    };
};

func likeReceipt(
    issuedAt : Nat64,
    corruptDigest : Bool,
) : Blob {
    let ?likeId = Hash.likeId(
        networkId,
        peer,
        selfNode,
        postId,
    ) else Runtime.trap("like id");
    let action : Protocol.LikeActionV1 = {
        header = {
            network_id = networkId;
            actor_ = peer;
            action_kind = ?#like;
        };
        like_id = likeId;
        issued_at_ns = issuedAt;
        post_author = selfNode;
        post_id = postId;
        post_body_hash = postBodyHash;
    };
    let exactAction = Wire.encodeLikeAction(action);
    let receipt : Protocol.CertifiedLikeReceiptV1 = {
        like_action_candid = exactAction;
        ref = {
            actor_ = peer;
            action_kind = ?#like;
            object_digest = if (corruptDigest) {
                blob32(0xff);
            } else {
                Hash.objectDigest(exactAction);
            };
            body_length = Nat32.fromNat(exactAction.size());
            proof_snapshot = proof();
        };
    };
    Wire.encodeCertifiedLikeReceipt(receipt);
};

func likeBody(exactReceipt : Blob) : Blob {
    Wire.encodeLikeBody({
        certified_like_receipt_candid = exactReceipt;
    });
};

// Receiver-clock constants are part of the adapter contract.
assert (IngressService.HOUR_NS == 3_600_000_000_000);
assert (IngressService.NOTICE_SEMANTIC_LIMIT_PER_HOUR == 60);

// The opaque body is hashed before any route decoder is allowed to interpret
// it. A syntactically valid, wrong-shaped Candid value is therefore rejected
// but still receives a durable digest-bound receipt.
let rawHarness = Harness();
let rawBody = to_candid (true);
let rawOperation = operation(1);
let rawRejected = execute(
    rawHarness,
    #follow,
    peer,
    rawOperation,
    rawBody,
    10,
);
expectRejected(rawRejected, #invalid);
assert (rawRejected.committed);
assert (not rawRejected.replayed);
assert (rawHarness.receiptCount() == 1);
let ?rawReceipt = rawHarness.receipt(
    peer,
    #follow,
    rawOperation,
) else Runtime.trap("missing raw receipt");
assert (
    Blob.equal(
        rawReceipt.payload_digest,
        Hash.payloadDigest(rawBody),
    )
);
assert (rawReceipt.received_at_ns == 10);
assert (
    rawReceipt.retain_until_ns ==
        10 + IngressService.PEER_RETENTION_NS
);
assert (rawHarness.rate(peer, #follow) == null);

let rawReplay = execute(
    rawHarness,
    #follow,
    peer,
    rawOperation,
    rawBody,
    999,
);
expectRejected(rawReplay, #invalid);
assert (rawReplay.replayed);
assert (not rawReplay.committed);
assert (
    Blob.equal(
        rawReplay.exact_result_candid,
        rawRejected.exact_result_candid,
    )
);
assert (rawReplay.result.local_receipt_time_ns == ?10);

let rawConflict = execute(
    rawHarness,
    #follow,
    peer,
    rawOperation,
    to_candid (false),
    1_000,
);
expectRejected(rawConflict, #conflict);
assert (not rawConflict.replayed);
assert (not rawConflict.committed);
assert (rawHarness.receiptCount() == 1);
let ?unchangedRawReceipt = rawHarness.receipt(
    peer,
    #follow,
    rawOperation,
) else Runtime.trap("raw receipt disappeared");
assert (
    Blob.equal(
        unchangedRawReceipt.payload_digest,
        Hash.payloadDigest(rawBody),
    )
);

// A structurally valid Deliver/Like wrapper with malformed nested Candid is
// charged to the route window before deep semantic decoding. Both outcomes
// remain digest-bound and replayable.
let malformedDeliverHarness = Harness();
malformedDeliverHarness.installFollowing(
    peer,
    subscription,
    #active,
);
let malformedDeliverBody = deliverBody(
    ?#original(to_candid (true))
);
let malformedDeliver = execute(
    malformedDeliverHarness,
    #deliver,
    peer,
    operation(0x70),
    malformedDeliverBody,
    1_010,
);
expectRejected(malformedDeliver, #invalid);
assert (malformedDeliver.committed);
let ?malformedDeliverRate =
    malformedDeliverHarness.rate(peer, #deliver)
    else Runtime.trap("malformed Deliver bypassed rate");
assert (malformedDeliverRate.accepted_count == 1);
assert (malformedDeliverHarness.receiptCount() == 1);
assert (malformedDeliverHarness.candidateCount() == 0);
let malformedDeliverReplay = execute(
    malformedDeliverHarness,
    #deliver,
    peer,
    operation(0x70),
    malformedDeliverBody,
    9_999,
);
expectRejected(malformedDeliverReplay, #invalid);
assert (malformedDeliverReplay.replayed);
let ?malformedDeliverRateAfterReplay =
    malformedDeliverHarness.rate(peer, #deliver)
    else Runtime.trap("malformed Deliver rate disappeared");
assert (malformedDeliverRateAfterReplay.accepted_count == 1);

let malformedLikeHarness = Harness();
let malformedLikeBody = likeBody(to_candid (true));
let malformedLike = execute(
    malformedLikeHarness,
    #like,
    peer,
    operation(0x71),
    malformedLikeBody,
    1_020,
);
expectRejected(malformedLike, #invalid);
assert (malformedLike.committed);
let ?malformedLikeRate =
    malformedLikeHarness.rate(peer, #like)
    else Runtime.trap("malformed Like bypassed rate");
assert (malformedLikeRate.accepted_count == 1);
assert (malformedLikeHarness.receiptCount() == 1);
assert (malformedLikeHarness.notificationCount() == 0);

// Every route rejects non-canister callers, self-calls and blocked callers
// before reaching domain state. Valid operation ids still make those
// authenticated semantic rejections replayable.
let nonCanisterHarness = Harness();
let nonCanister = execute(
    nonCanisterHarness,
    #follow,
    Principal.anonymous(),
    operation(2),
    followBody(0, subscription),
    20,
);
expectRejected(nonCanister, #invalid);
assert (nonCanister.committed);
assert (nonCanisterHarness.receiptCount() == 1);
assert (nonCanisterHarness.notificationCount() == 0);

let selfHarness = Harness();
let selfCall = execute(
    selfHarness,
    #follow,
    selfNode,
    operation(3),
    followBody(0, subscription),
    30,
);
expectRejected(selfCall, #invalid);
assert (selfCall.committed);
assert (selfHarness.follower(selfNode) == null);

let blockedHarness = Harness();
blockedHarness.addBlock(peer);
let blockedCall = execute(
    blockedHarness,
    #follow,
    peer,
    operation(4),
    followBody(0, subscription),
    40,
);
expectRejected(blockedCall, #blocked);
assert (blockedCall.committed);
assert (blockedHarness.follower(peer) == null);
assert (blockedHarness.notificationCount() == 0);

// Allocation preflight is read-only. Refusing the complete Follow transaction
// atomically commits the already-preflighted receipt+rate fallback, without
// retaining the follower row or notification.
let preflightHarness = Harness();
preflightHarness.setPreflight(false);
let preflightRejected = execute(
    preflightHarness,
    #follow,
    peer,
    operation(5),
    followBody(0, subscription),
    50,
);
expectRejected(preflightRejected, #full);
assert (preflightRejected.committed);
assert (not preflightRejected.replayed);
assert (preflightHarness.preflights() == 3);
assert (preflightHarness.commitAttempts() == 1);
assert (preflightHarness.commits() == 1);
assert (preflightHarness.receiptCount() == 1);
let ?preflightRate = preflightHarness.rate(peer, #follow)
    else Runtime.trap("domain-full fallback lost rate");
assert (preflightRate.accepted_count == 1);
assert (preflightHarness.follower(peer) == null);
assert (preflightHarness.notificationCount() == 0);
assert (preflightHarness.candidateCount() == 0);
let preflightReplay = execute(
    preflightHarness,
    #follow,
    peer,
    operation(5),
    followBody(0, subscription),
    5_000,
);
expectRejected(preflightReplay, #full);
assert (preflightReplay.replayed);
assert (
    Blob.equal(
        preflightReplay.exact_result_candid,
        preflightRejected.exact_result_candid,
    )
);

// A failed final CAS has the same all-or-nothing property. execute() reports
// a durable conflict receipt and retains only the route-rate mutation.
let commitHarness = Harness();
commitHarness.setCommit(false);
let commitRejected = execute(
    commitHarness,
    #follow,
    peer,
    operation(6),
    followBody(0, subscription),
    60,
);
expectRejected(commitRejected, #conflict);
assert (commitRejected.committed);
assert (commitHarness.preflights() == 3);
assert (commitHarness.commitAttempts() == 2);
assert (commitHarness.commits() == 1);
assert (commitHarness.receiptCount() == 1);
let ?commitFallbackRate = commitHarness.rate(peer, #follow)
    else Runtime.trap("commit-conflict fallback lost rate");
assert (commitFallbackRate.accepted_count == 1);
assert (commitHarness.follower(peer) == null);
assert (commitHarness.notificationCount() == 0);
let commitRejectedReplay = execute(
    commitHarness,
    #follow,
    peer,
    operation(6),
    followBody(0, subscription),
    6_000,
);
expectRejected(commitRejectedReplay, #conflict);
assert (commitRejectedReplay.replayed);
assert (
    Blob.equal(
        commitRejectedReplay.exact_result_candid,
        commitRejected.exact_result_candid,
    )
);

// A Notice domain refusal consumes the ordinary route window, but it does not
// consume the separate "new retained semantic" sub-window.
let noticeDomainFullHarness = Harness();
noticeDomainFullHarness.setAuthoredTarget(?localPostTarget());
noticeDomainFullHarness.setPreflight(false);
let noticeDomainFull = execute(
    noticeDomainFullHarness,
    #notice,
    peer,
    operation(7),
    noticeBody(blob32(0x07), blob32(0x08)),
    70,
);
expectRejected(noticeDomainFull, #full);
assert (noticeDomainFull.committed);
assert (noticeDomainFullHarness.notificationCount() == 0);
let ?noticeDomainFullRate =
    noticeDomainFullHarness.rate(peer, #notice)
    else Runtime.trap("Notice full fallback lost rate");
assert (noticeDomainFullRate.accepted_count == 1);
assert (noticeDomainFullRate.semantic_notice_count == 0);

// A full activity tray or exhausted tray sequence cannot deny a valid
// relationship activation. The follower mutation drops its notification
// summary along with the best-effort notification, preserving the adapter's
// summary/notification pairing invariant.
let notificationFullFollowHarness = Harness();
notificationFullFollowHarness.fillNotificationCapacity();
let notificationFullFollow = execute(
    notificationFullFollowHarness,
    #follow,
    peer,
    operation(8),
    followBody(0, subscription),
    80,
);
expectAccepted(notificationFullFollow);
assert (notificationFullFollow.committed);
assert (notificationFullFollowHarness.receiptCount() == 1);
assert (
    notificationFullFollowHarness.notificationCount() ==
        Notifications.MAX_SUMMARIES
);
assert (notificationFullFollowHarness.follower(peer) != null);
assert (
    notificationFullFollowHarness.followerSummaryPresent() ==
        ?false
);
assert (
    notificationFullFollowHarness.notificationRetainUntil() == null
);
let notificationFullFollowReplay = execute(
    notificationFullFollowHarness,
    #follow,
    peer,
    operation(8),
    followBody(0, subscription),
    81,
);
expectAccepted(notificationFullFollowReplay);
assert (notificationFullFollowReplay.replayed);
assert (not notificationFullFollowReplay.committed);
assert (
    Blob.equal(
        notificationFullFollowReplay.exact_result_candid,
        notificationFullFollow.exact_result_candid,
    )
);

let notificationSequenceFollowHarness = Harness();
notificationSequenceFollowHarness.exhaustNotificationSequence();
let notificationSequenceFollow = execute(
    notificationSequenceFollowHarness,
    #follow,
    peer,
    operation(9),
    followBody(0, subscription),
    90,
);
expectAccepted(notificationSequenceFollow);
assert (notificationSequenceFollow.committed);
assert (notificationSequenceFollowHarness.notificationCount() == 0);
assert (notificationSequenceFollowHarness.follower(peer) != null);
assert (
    notificationSequenceFollowHarness.followerSummaryPresent() ==
        ?false
);

// A pre-existing semantic row is corruption, not capacity pressure. It still
// rejects the activation instead of silently dropping the invariant failure.
let conflictingFollowNotificationHarness = Harness();
conflictingFollowNotificationHarness.seedNewFollowerSemanticConflict(
    peer,
    1,
    2,
);
let conflictingFollowNotification = execute(
    conflictingFollowNotificationHarness,
    #follow,
    peer,
    operation(0x0a),
    followBody(0, subscription),
    95,
);
expectRejected(conflictingFollowNotification, #invalid);
assert (conflictingFollowNotification.committed);
assert (conflictingFollowNotificationHarness.follower(peer) == null);
assert (conflictingFollowNotificationHarness.notificationCount() == 1);
assert (
    conflictingFollowNotificationHarness.followerSummaryPresent() ==
        null
);

// First Follow activation commits exactly one notification in the same atomic
// unit. Exact operation replay and a same-subscription renewal create none.
// Unfollow exercises the fifth route's relationship CAS in the same harness.
let relationshipHarness = Harness();
let firstFollowBody = followBody(0, subscription);
let firstFollow = execute(
    relationshipHarness,
    #follow,
    peer,
    operation(10),
    firstFollowBody,
    100,
);
expectAccepted(firstFollow);
assert (firstFollow.committed);
assert (relationshipHarness.notificationCount() == 1);
assert (relationshipHarness.followerSummaryPresent() == ?true);
let ?firstFollower = relationshipHarness.follower(peer)
    else Runtime.trap("follow did not store a follower");
assert (firstFollower.head_revision == 1);
switch (firstFollower.state) {
    case (#active(active)) {
        assert (Blob.equal(active.subscription_id, subscription));
        assert (Nat16.toNat(active.delivery_credits) == 32);
    };
    case (#inactive(_)) Runtime.trap("new follower is inactive");
};
let ?followNotification = relationshipHarness.notificationAt(1)
    else Runtime.trap("missing follow notification");
switch (followNotification.summary.kind) {
    case (?#new_follower(value)) {
        assert (value.follower_revision == 1);
        assert (
            Principal.equal(followNotification.summary.actor_, peer)
        );
    };
    case (_) Runtime.trap("wrong first-follow notification kind");
};
assert (
    relationshipHarness.notificationRetainUntil() ==
        ?(100 + IngressService.PEER_RETENTION_NS)
);

let firstFollowReplay = execute(
    relationshipHarness,
    #follow,
    peer,
    operation(10),
    firstFollowBody,
    101,
);
expectAccepted(firstFollowReplay);
assert (firstFollowReplay.replayed);
assert (not firstFollowReplay.committed);
assert (relationshipHarness.notificationCount() == 1);

let renewal = execute(
    relationshipHarness,
    #follow,
    peer,
    operation(11),
    followBody(1, subscription),
    110,
);
expectAccepted(renewal);
assert (renewal.committed);
assert (relationshipHarness.notificationCount() == 1);
let ?renewedFollower = relationshipHarness.follower(peer)
    else Runtime.trap("renewal removed follower");
assert (renewedFollower.head_revision == 2);

let exactUnfollowBody = unfollowBody(2, subscription);
let unfollow = execute(
    relationshipHarness,
    #unfollow,
    peer,
    operation(12),
    exactUnfollowBody,
    120,
);
expectAccepted(unfollow);
assert (unfollow.committed);
assert (unfollow.result.local_receipt_time_ns == null);
assert (unfollow.result.revision == ?3);
assert (unfollow.result.relationship == null);
assert (
    unfollow.exact_result_candid.size() <=
        Bounds.UNFOLLOW.max_response_bytes
);
assert (
    Wire.decodeRouteResult(
        unfollow.exact_result_candid,
        Bounds.UNFOLLOW.max_response_bytes,
    ) == ?unfollow.result
);
assert (relationshipHarness.notificationCount() == 1);
let ?inactiveFollower = relationshipHarness.follower(peer)
    else Runtime.trap("unfollow removed retained head");
assert (inactiveFollower.head_revision == 3);
switch (inactiveFollower.state) {
    case (#inactive(inactive)) {
        assert (
            Blob.equal(
                inactive.last_subscription_id,
                subscription,
            )
        );
    };
    case (#active(_)) Runtime.trap("unfollow left follower active");
};

let unfollowReplay = execute(
    relationshipHarness,
    #unfollow,
    peer,
    operation(12),
    exactUnfollowBody,
    121,
);
expectAccepted(unfollowReplay);
assert (unfollowReplay.replayed);
assert (not unfollowReplay.committed);
assert (unfollowReplay.result == unfollow.result);
assert (
    Blob.equal(
        unfollowReplay.exact_result_candid,
        unfollow.exact_result_candid,
    )
);
assert (
    unfollowReplay.exact_result_candid.size() <=
        Bounds.UNFOLLOW.max_response_bytes
);
assert (
    Wire.decodeRouteResult(
        unfollowReplay.exact_result_candid,
        Bounds.UNFOLLOW.max_response_bytes,
    ) == ?unfollow.result
);
assert (relationshipHarness.notificationCount() == 1);

// Deliver is accepted only for a locally active Following intent with the
// exact subscription. An original event is bound to its immediate sender.
let exactPeerPost = certifiedPost(peer);
let notFollowingHarness = Harness();
let notFollowing = execute(
    notFollowingHarness,
    #deliver,
    peer,
    operation(20),
    deliverBody(?#original(exactPeerPost)),
    200,
);
expectRejected(notFollowing, #not_following);
assert (notFollowing.committed);
assert (notFollowingHarness.candidateCount() == 0);
assert (notFollowingHarness.rate(peer, #deliver) == null);

let deliveryHarness = Harness();
deliveryHarness.installFollowing(
    peer,
    subscription,
    #active,
);
let delivered = execute(
    deliveryHarness,
    #deliver,
    peer,
    operation(21),
    deliverBodyWithRenewal(?#original(exactPeerPost), true),
    210,
);
expectAccepted(delivered);
assert (delivered.committed);
assert (deliveryHarness.candidateCount() == 1);
let ?followingAfterRenewalHint = deliveryHarness.following(peer)
    else Runtime.trap("delivery removed following");
assert (followingAfterRenewalHint.renewal_requested);
assert (
    followingAfterRenewalHint.locally_verified_delivery_count == 9
);
assert (followingAfterRenewalHint.updated_at_ns == 1);
let candidate = deliveryHarness.candidateAt(0);
let peerPostId = derivedPostId(peer, postBodyHash);
assert (candidate.event_kind == #original);
assert (Principal.equal(candidate.immediate_sender, peer));
assert (Principal.equal(candidate.claimed_author, peer));
assert (Blob.equal(candidate.claimed_post_id, peerPostId));
assert (Blob.equal(candidate.claimed_body_hash, postBodyHash));
assert (Blob.equal(candidate.exact_event_candid, exactPeerPost));
assert (
    candidate.retain_until_ns ==
        210 + IngressService.PEER_RETENTION_NS
);

let wrongImmediateAuthor = execute(
    deliveryHarness,
    #deliver,
    peer,
    operation(22),
    deliverBody(?#original(certifiedPost(otherPeer))),
    220,
);
expectRejected(wrongImmediateAuthor, #invalid);
assert (wrongImmediateAuthor.committed);
assert (deliveryHarness.candidateCount() == 1);

let mismatchedOriginalPostId = execute(
    deliveryHarness,
    #deliver,
    peer,
    operation(24),
    deliverBody(
        ?#original(
            certifiedPostWithId(peer, blob32(0x85))
        )
    ),
    240,
);
expectRejected(mismatchedOriginalPostId, #invalid);
assert (mismatchedOriginalPostId.committed);
assert (deliveryHarness.candidateCount() == 1);

let exactShare = certifiedShareDelivery(
    peer,
    otherPeer,
    false,
    false,
);
let deliveredShare = execute(
    deliveryHarness,
    #deliver,
    peer,
    operation(25),
    deliverBody(?#share(exactShare)),
    250,
);
expectAccepted(deliveredShare);
assert (deliveredShare.committed);
assert (deliveryHarness.candidateCount() == 2);
let ?followingAfterLaterDelivery = deliveryHarness.following(peer)
    else Runtime.trap("later delivery removed following");
assert (followingAfterLaterDelivery.renewal_requested);
assert (
    followingAfterLaterDelivery.locally_verified_delivery_count == 9
);
assert (followingAfterLaterDelivery.updated_at_ns == 1);
let shareCandidate = deliveryHarness.candidateAt(1);
let originalPostId = derivedPostId(otherPeer, postBodyHash);
assert (shareCandidate.event_kind == #share);
assert (Principal.equal(shareCandidate.immediate_sender, peer));
assert (Principal.equal(shareCandidate.claimed_author, otherPeer));
assert (Blob.equal(shareCandidate.claimed_post_id, originalPostId));
assert (Blob.equal(shareCandidate.claimed_body_hash, postBodyHash));
assert (Blob.equal(shareCandidate.exact_event_candid, exactShare));

let mismatchedSharedPostId = execute(
    deliveryHarness,
    #deliver,
    peer,
    operation(26),
    deliverBody(
        ?#share(
            certifiedShareDelivery(
                peer,
                otherPeer,
                true,
                false,
            )
        )
    ),
    260,
);
expectRejected(mismatchedSharedPostId, #invalid);
assert (mismatchedSharedPostId.committed);
assert (deliveryHarness.candidateCount() == 2);

let mismatchedShareId = execute(
    deliveryHarness,
    #deliver,
    peer,
    operation(27),
    deliverBody(
        ?#share(
            certifiedShareDelivery(
                peer,
                otherPeer,
                false,
                true,
            )
        )
    ),
    270,
);
expectRejected(mismatchedShareId, #invalid);
assert (mismatchedShareId.committed);
assert (deliveryHarness.candidateCount() == 2);

let exactTombstone = certifiedTombstone(
    peer,
    false,
    false,
);
let deliveredTombstone = execute(
    deliveryHarness,
    #deliver,
    peer,
    operation(28),
    deliverBody(?#tombstone(exactTombstone)),
    280,
);
expectAccepted(deliveredTombstone);
assert (deliveredTombstone.committed);
assert (deliveryHarness.candidateCount() == 3);
let tombstoneCandidate = deliveryHarness.candidateAt(2);
assert (tombstoneCandidate.event_kind == #tombstone);
assert (Principal.equal(tombstoneCandidate.immediate_sender, peer));
assert (Principal.equal(tombstoneCandidate.claimed_author, peer));
assert (Blob.equal(tombstoneCandidate.claimed_post_id, peerPostId));
assert (
    Blob.equal(
        tombstoneCandidate.claimed_body_hash,
        postBodyHash,
    )
);
assert (
    Blob.equal(
        tombstoneCandidate.exact_event_candid,
        exactTombstone,
    )
);

let mismatchedTombstonePostId = execute(
    deliveryHarness,
    #deliver,
    peer,
    operation(29),
    deliverBody(
        ?#tombstone(
            certifiedTombstone(peer, true, false)
        )
    ),
    290,
);
expectRejected(mismatchedTombstonePostId, #invalid);
assert (mismatchedTombstonePostId.committed);
assert (deliveryHarness.candidateCount() == 3);

let mismatchedTombstoneId = execute(
    deliveryHarness,
    #deliver,
    peer,
    operation(30),
    deliverBody(
        ?#tombstone(
            certifiedTombstone(peer, false, true)
        )
    ),
    300,
);
expectRejected(mismatchedTombstoneId, #invalid);
assert (mismatchedTombstoneId.committed);
assert (deliveryHarness.candidateCount() == 3);

let nullDeliveryHarness = Harness();
nullDeliveryHarness.installFollowing(
    peer,
    subscription,
    #active,
);
let nullDelivery = execute(
    nullDeliveryHarness,
    #deliver,
    peer,
    operation(23),
    deliverBody(null),
    230,
);
expectRejected(nullDelivery, #incompatible);
assert (nullDelivery.committed);
assert (nullDeliveryHarness.candidateCount() == 0);

// Notice targets are strictly live local authored posts. No follow relation is
// needed and no feed candidate is created. Semantic identity ignores the paid
// operation id: identical content is duplicate, changed content is conflict.
let missingNoticeHarness = Harness();
let missingNotice = execute(
    missingNoticeHarness,
    #notice,
    peer,
    operation(30),
    noticeBody(blob32(0x30), blob32(0x31)),
    300,
);
expectRejected(missingNotice, #unknown_post);
assert (missingNotice.committed);
assert (missingNoticeHarness.notificationCount() == 0);

let staleNoticeHarness = Harness();
let localTarget = localPostTarget();
staleNoticeHarness.setAuthoredTarget(
    ?{ localTarget with live = false }
);
let staleNotice = execute(
    staleNoticeHarness,
    #notice,
    peer,
    operation(31),
    noticeBody(blob32(0x32), blob32(0x33)),
    310,
);
expectRejected(staleNotice, #unknown_post);
assert (staleNoticeHarness.notificationCount() == 0);

let noticeHarness = Harness();
noticeHarness.setAuthoredTarget(?localTarget);
let semanticAction = blob32(0x34);
let exactNotice = noticeBody(semanticAction, blob32(0x35));
let firstNotice = execute(
    noticeHarness,
    #notice,
    peer,
    operation(32),
    exactNotice,
    320,
);
expectAccepted(firstNotice);
assert (firstNotice.committed);
assert (noticeHarness.notificationCount() == 1);
assert (noticeHarness.candidateCount() == 0);
assert (noticeHarness.follower(peer) == null);
assert (
    noticeHarness.notificationRetainUntil() ==
        ?(320 + IngressService.PEER_RETENTION_NS)
);

let duplicateNotice = execute(
    noticeHarness,
    #notice,
    peer,
    operation(33),
    exactNotice,
    321,
);
expectDuplicate(duplicateNotice);
assert (duplicateNotice.committed);
assert (noticeHarness.notificationCount() == 1);

let conflictingNotice = execute(
    noticeHarness,
    #notice,
    peer,
    operation(34),
    noticeBody(semanticAction, blob32(0x36)),
    322,
);
expectRejected(conflictingNotice, #conflict);
assert (conflictingNotice.committed);
assert (noticeHarness.notificationCount() == 1);
let ?noticeRate = noticeHarness.rate(peer, #notice)
    else Runtime.trap("missing Notice rate");
assert (noticeRate.accepted_count == 3);
assert (noticeRate.semantic_notice_count == 1);

// Notice adds at most sixty new semantic summaries per receiver-clock hour.
// The sixty-first operation is still receipted, but no notification mutation
// is retained and the semantic counter remains exactly sixty.
let quotaHarness = Harness();
quotaHarness.setAuthoredTarget(?localTarget);
var noticeIndex = 0;
while (noticeIndex < 60) {
    let byte = Nat8.fromNat(noticeIndex + 1);
    let accepted = execute(
        quotaHarness,
        #notice,
        peer,
        operation(Nat8.fromNat(noticeIndex + 80)),
        noticeBody(blob32(byte), blob32(0x70)),
        1_000,
    );
    expectAccepted(accepted);
    assert (accepted.committed);
    noticeIndex += 1;
};
assert (quotaHarness.notificationCount() == 60);
let ?fullNoticeRate = quotaHarness.rate(peer, #notice)
    else Runtime.trap("missing quota rate");
assert (fullNoticeRate.accepted_count == 60);
assert (fullNoticeRate.semantic_notice_count == 60);
assert (
    quotaHarness.notificationRetainUntil() ==
        ?(1_000 + IngressService.PEER_RETENTION_NS)
);

let overSemanticQuota = execute(
    quotaHarness,
    #notice,
    peer,
    operation(200),
    noticeBody(blob32(0xee), blob32(0x71)),
    1_001,
);
expectRejected(overSemanticQuota, #full);
assert (overSemanticQuota.committed);
assert (quotaHarness.notificationCount() == 60);
let ?afterQuotaRate = quotaHarness.rate(peer, #notice)
    else Runtime.trap("quota rate disappeared");
assert (afterQuotaRate.accepted_count == 61);
assert (afterQuotaRate.semantic_notice_count == 60);
let ?overQuotaReceipt = quotaHarness.receipt(
    peer,
    #notice,
    operation(200),
) else Runtime.trap("semantic quota rejection was not receipted");
assert (
    overQuotaReceipt.retain_until_ns ==
        1_001 + IngressService.PEER_RETENTION_NS
);

// Like is accepted only against an accepting post authored by this node. The
// exact certified receipt remains quarantined in the sole pending notification;
// no AcceptedLike sequence or sealable segment exists before browser
// verification. A new operation id does not bypass liker/post dedupe.
let exactLikeReceipt = likeReceipt(2_000, false);
let missingLikeHarness = Harness();
let missingLike = execute(
    missingLikeHarness,
    #like,
    peer,
    operation(40),
    likeBody(exactLikeReceipt),
    2_000,
);
expectRejected(missingLike, #unknown_post);
assert (missingLike.committed);
assert (missingLikeHarness.notificationCount() == 0);
let ?missingLikeRate = missingLikeHarness.rate(peer, #like)
    else Runtime.trap("deep Like target check bypassed rate");
assert (missingLikeRate.accepted_count == 1);

let corruptLikeHarness = Harness();
corruptLikeHarness.setLikeTarget(?emptyLikeTarget());
let corruptLike = execute(
    corruptLikeHarness,
    #like,
    peer,
    operation(41),
    likeBody(likeReceipt(2_001, true)),
    2_001,
);
expectRejected(corruptLike, #invalid);
assert (corruptLike.committed);
assert (corruptLikeHarness.notificationCount() == 0);
let ?stillEmptyTarget = corruptLikeHarness.likeTarget()
    else Runtime.trap("corrupt Like removed target");
assert (stillEmptyTarget.next_accepted_sequence == 1);
assert (stillEmptyTarget.existing_receipt_digest == null);

let likeHarness = Harness();
likeHarness.setLikeTarget(?emptyLikeTarget());
let firstLike = execute(
    likeHarness,
    #like,
    peer,
    operation(42),
    likeBody(exactLikeReceipt),
    2_010,
);
expectAccepted(firstLike);
assert (firstLike.committed);
assert (likeHarness.notificationCount() == 1);
let ?likeNotification = likeHarness.notificationAt(1)
    else Runtime.trap("missing Like notification");
switch (likeNotification.summary.kind) {
    case (?#like(locator)) {
        assert (Blob.equal(locator.target_post_id, postId));
        assert (
            Blob.equal(locator.target_body_hash, postBodyHash)
        );
    };
    case (_) Runtime.trap("wrong Like notification kind");
};
let ?likeEvidence = likeNotification.like_evidence
    else Runtime.trap("Like notification lost exact evidence");
assert (Blob.equal(likeEvidence, exactLikeReceipt));
let ?acceptedLikeTarget = likeHarness.likeTarget()
    else Runtime.trap("Like removed target");
assert (acceptedLikeTarget.next_accepted_sequence == 1);
assert (acceptedLikeTarget.existing_receipt_digest == null);
assert (
    Likes.unsealedCount(acceptedLikeTarget.segments) == 0
);
assert (acceptedLikeTarget.unsealed_receipt_count == 1);
assert (
    likeHarness.notificationRetainUntil() ==
        ?(2_010 + IngressService.PEER_RETENTION_NS)
);
assert (
    likeHarness.likeRetainUntil() == null
);
let ?likeRouteReceipt = likeHarness.receipt(
    peer,
    #like,
    operation(42),
) else Runtime.trap("missing Like route receipt");
assert (
    likeRouteReceipt.retain_until_ns ==
        2_010 + IngressService.LIKE_RETENTION_NS
);

let firstLikeReplay = execute(
    likeHarness,
    #like,
    peer,
    operation(42),
    likeBody(exactLikeReceipt),
    2_011,
);
expectAccepted(firstLikeReplay);
assert (firstLikeReplay.replayed);
assert (likeHarness.notificationCount() == 1);

let semanticLikeDuplicate = execute(
    likeHarness,
    #like,
    peer,
    operation(43),
    likeBody(exactLikeReceipt),
    2_012,
);
expectDuplicate(semanticLikeDuplicate);
assert (semanticLikeDuplicate.committed);
assert (likeHarness.notificationCount() == 1);
let ?afterDuplicateLikeTarget = likeHarness.likeTarget()
    else Runtime.trap("duplicate Like removed target");
assert (afterDuplicateLikeTarget.next_accepted_sequence == 1);
assert (Likes.unsealedCount(afterDuplicateLikeTarget.segments) == 0);
assert (afterDuplicateLikeTarget.unsealed_receipt_count == 1);

let semanticLikeConflict = execute(
    likeHarness,
    #like,
    peer,
    operation(44),
    likeBody(likeReceipt(2_013, false)),
    2_013,
);
expectRejected(semanticLikeConflict, #conflict);
assert (semanticLikeConflict.committed);
assert (likeHarness.notificationCount() == 1);

// Per-post quarantine pressure is temporary: it has no durable rejection
// receipt, and retrying the exact operation succeeds after capacity returns.
let pressuredLikeHarness = Harness();
let pressuredTarget = emptyLikeTarget();
pressuredLikeHarness.setLikeTarget(?{
    pressuredTarget with
    unsealed_receipt_count =
        pressuredTarget.unsealed_receipt_limit;
});
let temporarilyFullLike = execute(
    pressuredLikeHarness,
    #like,
    peer,
    operation(45),
    likeBody(exactLikeReceipt),
    2_014,
);
expectRejected(temporarilyFullLike, #full);
assert (not temporarilyFullLike.committed);
assert (not temporarilyFullLike.replayed);
assert (
    temporarilyFullLike.result.local_receipt_time_ns == null
);
assert (
    pressuredLikeHarness.receipt(
        peer,
        #like,
        operation(45),
    ) == null
);
pressuredLikeHarness.setLikeTarget(?pressuredTarget);
let retriedAfterPressure = execute(
    pressuredLikeHarness,
    #like,
    peer,
    operation(45),
    likeBody(exactLikeReceipt),
    2_015,
);
expectAccepted(retriedAfterPressure);
assert (retriedAfterPressure.committed);
assert (pressuredLikeHarness.notificationCount() == 1);

// App-local rate defense uses a rolling receiver-clock window independently
// for every caller/route. A full current window commits a stable #full
// receipt, while the exact boundary starts a fresh window.
let rateHarness = Harness();
rateHarness.setAuthoredTarget(?localTarget);
let rateStarted : Nat64 = 10_000;
let rateExpires = rateStarted + IngressService.HOUR_NS;
rateHarness.seedRate({
    caller = peer;
    route = #notice;
    window_started_at_ns = rateStarted;
    accepted_count = Nat32.fromNat(
        Bounds.NOTICE.max_calls_per_hour
    );
    semantic_notice_count = 0;
    expires_at_ns = rateExpires;
    retained_bytes = 192;
});
let appLimited = execute(
    rateHarness,
    #notice,
    peer,
    operation(50),
    noticeBody(blob32(0x50), blob32(0x51)),
    rateStarted + 1,
);
expectRejected(appLimited, #full);
assert (appLimited.committed);
assert (rateHarness.notificationCount() == 0);
let ?unchangedFullWindow = rateHarness.rate(peer, #notice)
    else Runtime.trap("full rate window disappeared");
assert (
    unchangedFullWindow.accepted_count ==
        Nat32.fromNat(Bounds.NOTICE.max_calls_per_hour)
);

let afterWindow = execute(
    rateHarness,
    #notice,
    peer,
    operation(51),
    noticeBody(blob32(0x52), blob32(0x53)),
    rateExpires,
);
expectAccepted(afterWindow);
assert (afterWindow.committed);
assert (rateHarness.notificationCount() == 1);
let ?resetWindow = rateHarness.rate(peer, #notice)
    else Runtime.trap("reset rate window missing");
assert (resetWindow.window_started_at_ns == rateExpires);
assert (
    resetWindow.expires_at_ns ==
        rateExpires + IngressService.HOUR_NS
);
assert (resetWindow.accepted_count == 1);
assert (resetWindow.semantic_notice_count == 1);
