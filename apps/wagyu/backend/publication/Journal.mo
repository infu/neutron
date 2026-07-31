import Blob "mo:core/Blob";
import Nat32 "mo:core/Nat32";

import Caps "mo:neutron-capabilities";

import Memory "../memory/wagyu/v3";
import Publication "../actions/Publication";
import Bounds "../protocol/Bounds";

// Pure construction and validation for Wagyu's durable certified-publication
// journal. Callers freeze and preflight the returned mutations before invoking
// the kernel certified-asset commit, and persist those exact mutations in the
// reserved journal row. A kernel receipt is evidence of the result, never the
// source from which the requested transaction is reconstructed.
module {
    public type Error = {
        #invalid_nonce;
        #invalid_fingerprint;
        #empty_mutations;
        #too_many_mutations;
        #batch_too_large;
        #invalid_target;
        #invalid_digest;
        #invalid_body_length;
        #invalid_expected_identity;
        #invalid_dependency;
        #duplicate_target;
        #mixed_domains;
        #invalid_capacity;
        #receipt_full;
        #retained_bytes_full;
    };

    public type Result<T> = {
        #ok : T;
        #err : Error;
    };

    public type ObjectInput = {
        target : Caps.Target;
        body_digest : Blob;
        body_length : Nat;
    };

    // This is structurally identical to Publication.StoredIdentity, allowing
    // action and Like planners to pass their retained kernel CAS identity
    // directly without importing capability types into stable memory.
    public type ExpectedIdentity = Publication.StoredIdentity;

    public type Capacity = {
        current_receipt_count : Nat;
        receipt_count_limit : Nat;
        current_retained_bytes : Nat;
        retained_bytes_limit : Nat;
    };

    public type PreflightInput = {
        request_nonce : Blob;
        request_fingerprint : Blob;
        mutations : [Memory.PublicationMutation];
        capacity : Capacity;
    };

    public type Plan = {
        request_nonce : Blob;
        request_fingerprint : Blob;
        mutations : [Memory.PublicationMutation];
        retained_bytes : Nat;
    };

    public type PostAndInitialHeadInput = {
        post : ObjectInput;
        initial_head : ObjectInput;
    };

    public type ImmutableActionInput = {
        action : ObjectInput;
    };

    public type ProfileCasInput = {
        profile : ObjectInput;
        expected_profile : ExpectedIdentity;
    };

    public type ReplyIndexInput = {
        index : ObjectInput;
        expected_index : ?ExpectedIdentity;
    };

    public type LikeBatchAndHeadInput = {
        batch : ObjectInput;
        head : ObjectInput;
        expected_head : ExpectedIdentity;
    };

    public type HeadStopInput = {
        head : ObjectInput;
        expected_head : ExpectedIdentity;
    };

    public func postAndInitialHead(
        input : PostAndInitialHeadInput
    ) : Result<[Memory.PublicationMutation]> {
        let post = switch (
            newObject(input.post, ?#posts)
        ) {
            case (#err(error)) return #err(error);
            case (#ok(value)) value;
        };
        let head = switch (
            newObject(input.initial_head, ?#like_heads)
        ) {
            case (#err(error)) return #err(error);
            case (#ok(value)) value;
        };
        let postTarget = putTarget(post);
        let mutations : [Memory.PublicationMutation] = [
            post,
            withDependency(
                head,
                {
                    target = postTarget;
                    body_digest = input.post.body_digest;
                },
            ),
        ];
        validateMutationBatch(mutations);
    };

    public func immutableShare(
        input : ImmutableActionInput
    ) : Result<[Memory.PublicationMutation]> {
        immutableAction(input.action, #shares);
    };

    public func immutableLike(
        input : ImmutableActionInput
    ) : Result<[Memory.PublicationMutation]> {
        immutableAction(input.action, #likes);
    };

    public func immutableTombstone(
        input : ImmutableActionInput
    ) : Result<[Memory.PublicationMutation]> {
        immutableAction(input.action, #tombstones);
    };

    public func profileCas(
        input : ProfileCasInput
    ) : Result<[Memory.PublicationMutation]> {
        let mutation = switch (
            casObject(
                input.profile,
                input.expected_profile,
                #profile,
            )
        ) {
            case (#err(error)) return #err(error);
            case (#ok(value)) value;
        };
        validateMutationBatch([mutation]);
    };

    public func profileCreate(
        input : ObjectInput
    ) : Result<[Memory.PublicationMutation]> {
        let mutation = switch (newObject(input, ?#profile)) {
            case (#err(error)) return #err(error);
            case (#ok(value)) value;
        };
        validateMutationBatch([mutation]);
    };

    public func replyIndex(
        input : ReplyIndexInput
    ) : Result<[Memory.PublicationMutation]> {
        let mutation = switch (input.expected_index) {
            case null {
                switch (newObject(input.index, ?#reply_indexes)) {
                    case (#err(error)) return #err(error);
                    case (#ok(value)) value;
                };
            };
            case (?expected) {
                switch (
                    casObject(input.index, expected, #reply_indexes)
                ) {
                    case (#err(error)) return #err(error);
                    case (#ok(value)) value;
                };
            };
        };
        validateMutationBatch([mutation]);
    };

    public func likeBatchAndHead(
        input : LikeBatchAndHeadInput
    ) : Result<[Memory.PublicationMutation]> {
        let batch = switch (
            newObject(input.batch, ?#like_batches)
        ) {
            case (#err(error)) return #err(error);
            case (#ok(value)) value;
        };
        let head = switch (
            casObject(
                input.head,
                input.expected_head,
                #like_heads,
            )
        ) {
            case (#err(error)) return #err(error);
            case (#ok(value)) value;
        };
        let batchTarget = putTarget(batch);
        let mutations : [Memory.PublicationMutation] = [
            batch,
            withDependency(
                head,
                {
                    target = batchTarget;
                    body_digest = input.batch.body_digest;
                },
            ),
        ];
        validateMutationBatch(mutations);
    };

    public func headStop(
        input : HeadStopInput
    ) : Result<[Memory.PublicationMutation]> {
        let mutation = switch (
            casObject(
                input.head,
                input.expected_head,
                #like_heads,
            )
        ) {
            case (#err(error)) return #err(error);
            case (#ok(value)) value;
        };
        validateMutationBatch([mutation]);
    };

    public func deleteRecord(
        expected : Memory.KernelRecordIdentity
    ) : Result<[Memory.PublicationMutation]> {
        if (
            not validMemoryIdentity(expected) or
            expected.target.collection == #profile
        ) return #err(#invalid_expected_identity);
        validateMutationBatch([
            #delete({
                target = expected.target;
                expected;
            }),
        ]);
    };

    // The common preflight is deliberately separate from the shape-specific
    // builders. A caller can construct the exact mutations as soon as it has
    // frozen body bytes, then add the publication nonce and canonical
    // fingerprint immediately before reserving its local journal row.
    public func validate(input : PreflightInput) : Result<Plan> {
        if (input.request_nonce.size() != Bounds.NONCE_BYTES) {
            return #err(#invalid_nonce);
        };
        if (input.request_fingerprint.size() != Bounds.HASH_BYTES) {
            return #err(#invalid_fingerprint);
        };
        switch (validateMutationBatch(input.mutations)) {
            case (#err(error)) return #err(error);
            case (#ok(_)) {};
        };
        let capacity = input.capacity;
        if (
            capacity.current_receipt_count >
                capacity.receipt_count_limit or
            capacity.current_retained_bytes >
                capacity.retained_bytes_limit
        ) return #err(#invalid_capacity);
        if (
            capacity.current_receipt_count ==
                capacity.receipt_count_limit
        ) return #err(#receipt_full);
        let retainedBytes = retainedBytesFor(input.mutations);
        if (
            retainedBytes > capacity.retained_bytes_limit or
            capacity.current_retained_bytes >
                capacity.retained_bytes_limit - retainedBytes
        ) return #err(#retained_bytes_full);
        #ok({
            request_nonce = input.request_nonce;
            request_fingerprint = input.request_fingerprint;
            mutations = input.mutations;
            retained_bytes = retainedBytes;
        });
    };

    // This deliberately counts the complete retained journal shape, including
    // the eventual committed identity for every put. It is a stable accounting
    // formula rather than an estimate of a particular Motoko runtime layout.
    public func retainedBytesFor(
        mutations : [Memory.PublicationMutation]
    ) : Nat {
        var total = 256;
        for (mutation in mutations.vals()) {
            switch (mutation) {
                case (#put(value)) {
                    total += 128 + targetRetainedBytes(value.target) +
                        value.body_digest.size();
                    switch (value.expected) {
                        case null {};
                        case (?identity) {
                            total += identityRetainedBytes(identity);
                        };
                    };
                    switch (value.requires_present_after) {
                        case null {};
                        case (?dependency) {
                            total += 64 +
                                targetRetainedBytes(dependency.target) +
                                dependency.body_digest.size();
                        };
                    };
                    // The committed state retains the corresponding record
                    // identity alongside the original requested mutation.
                    total += 128 + targetRetainedBytes(value.target) +
                        Bounds.HASH_BYTES * 2;
                };
                case (#delete(value)) {
                    total += 96 + targetRetainedBytes(value.target) +
                        identityRetainedBytes(value.expected);
                };
            };
        };
        total;
    };

    public func memoryTarget(
        target : Caps.Target
    ) : Result<Memory.CertifiedTarget> {
        let collection : Memory.CertifiedCollection =
            if (target.collection == Publication.POSTS_COLLECTION) {
                #posts;
            } else if (
                target.collection == Publication.SHARES_COLLECTION
            ) {
                #shares;
            } else if (
                target.collection == Publication.TOMBSTONES_COLLECTION
            ) {
                #tombstones;
            } else if (
                target.collection == Publication.LIKES_COLLECTION
            ) {
                #likes;
            } else if (
                target.collection == Publication.LIKE_BATCHES_COLLECTION
            ) {
                #like_batches;
            } else if (
                target.collection == Publication.LIKE_HEADS_COLLECTION
            ) {
                #like_heads;
            } else if (
                target.collection == Publication.REPLY_INDEXES_COLLECTION
            ) {
                #reply_indexes;
            } else if (
                target.collection == Publication.PROFILE_COLLECTION
            ) {
                #profile;
            } else return #err(#invalid_target);
        let key : Memory.CertifiedTargetKey = switch (
            collection,
            target.locator,
        ) {
            case (
                (
                    #posts or #shares or #tombstones or #likes or
                    #like_batches
                ),
                #body_sha256(value),
            ) {
                if (value.digest.size() != Bounds.HASH_BYTES) {
                    return #err(#invalid_target);
                };
                #digest(value.digest);
            };
            case ((#like_heads or #reply_indexes), #key32(value)) {
                if (value.key.size() != Bounds.HASH_BYTES) {
                    return #err(#invalid_target);
                };
                #post_id(value.key);
            };
            case (#profile, #exact_path) #profile;
            case (_) return #err(#invalid_target);
        };
        #ok({
            collection;
            collection_generation = target.collection_generation;
            key;
        });
    };

    func immutableAction(
        input : ObjectInput,
        expectedCollection : Memory.CertifiedCollection,
    ) : Result<[Memory.PublicationMutation]> {
        let mutation = switch (
            newObject(input, ?expectedCollection)
        ) {
            case (#err(error)) return #err(error);
            case (#ok(value)) value;
        };
        validateMutationBatch([mutation]);
    };

    func newObject(
        input : ObjectInput,
        expectedCollection : ?Memory.CertifiedCollection,
    ) : Result<Memory.PublicationMutation> {
        let target = switch (memoryTarget(input.target)) {
            case (#err(error)) return #err(error);
            case (#ok(value)) value;
        };
        switch (expectedCollection) {
            case (?expected) {
                if (target.collection != expected) {
                    return #err(#invalid_target);
                };
            };
            case null {};
        };
        if (not validDigest(input.body_digest)) {
            return #err(#invalid_digest);
        };
        if (not validBodyLength(target.collection, input.body_length)) {
            return #err(#invalid_body_length);
        };
        if (
            immutableCollection(target.collection) and
            not targetCarriesDigest(target, input.body_digest)
        ) return #err(#invalid_target);
        #ok(#put({
            target;
            body_digest = input.body_digest;
            body_length = Nat32.fromNat(input.body_length);
            expected = null;
            requires_present_after = null;
        }));
    };

    func casObject(
        input : ObjectInput,
        expected : ExpectedIdentity,
        expectedCollection : Memory.CertifiedCollection,
    ) : Result<Memory.PublicationMutation> {
        let next = switch (
            newObject(input, ?expectedCollection)
        ) {
            case (#err(error)) return #err(error);
            case (#ok(value)) value;
        };
        let expectedIdentity = switch (
            memoryIdentity(expected)
        ) {
            case (#err(error)) return #err(error);
            case (#ok(value)) value;
        };
        let target = putTarget(next);
        if (
            expectedIdentity.target.collection != expectedCollection or
            not sameTarget(target, expectedIdentity.target)
        ) return #err(#invalid_expected_identity);
        switch (next) {
            case (#put(value)) {
                #ok(#put({
                    value with
                    expected = ?expectedIdentity;
                }));
            };
            case (#delete(_)) #err(#mixed_domains);
        };
    };

    func memoryIdentity(
        input : ExpectedIdentity
    ) : Result<Memory.KernelRecordIdentity> {
        let target = switch (memoryTarget(input.target)) {
            case (#err(_)) return #err(#invalid_expected_identity);
            case (#ok(value)) value;
        };
        if (
            input.kernel_revision == 0 or
            not validDigest(input.content_tag) or
            not validBodyLength(target.collection, input.body_bytes)
        ) return #err(#invalid_expected_identity);
        #ok({
            target;
            kernel_revision = input.kernel_revision;
            content_tag = input.content_tag;
            body_digest = input.content_tag;
            body_length = Nat32.fromNat(input.body_bytes);
        });
    };

    func withDependency(
        mutation : Memory.PublicationMutation,
        dependency : Memory.CertifiedDependency,
    ) : Memory.PublicationMutation {
        switch (mutation) {
            case (#put(value)) {
                #put({
                    value with
                    requires_present_after = ?dependency;
                });
            };
            case (#delete(_)) mutation;
        };
    };

    func putTarget(
        mutation : Memory.PublicationMutation
    ) : Memory.CertifiedTarget {
        switch (mutation) {
            case (#put(value)) value.target;
            case (#delete(value)) value.target;
        };
    };

    func validateMutationBatch(
        mutations : [Memory.PublicationMutation]
    ) : Result<[Memory.PublicationMutation]> {
        if (mutations.size() == 0) return #err(#empty_mutations);
        if (mutations.size() > Bounds.MAX_CERTIFIED_BATCH_OBJECTS) {
            return #err(#too_many_mutations);
        };

        var putCount = 0;
        var deleteCount = 0;
        var bodyBytes = 0;
        var index = 0;
        while (index < mutations.size()) {
            let mutation = mutations[index];
            let target = putTarget(mutation);
            if (not validMemoryTarget(target)) {
                return #err(#invalid_target);
            };
            var prior = 0;
            while (prior < index) {
                if (sameTarget(target, putTarget(mutations[prior]))) {
                    return #err(#duplicate_target);
                };
                prior += 1;
            };
            switch (mutation) {
                case (#put(value)) {
                    putCount += 1;
                    let length = Nat32.toNat(value.body_length);
                    if (
                        not validDigest(value.body_digest) or
                        not validBodyLength(
                            value.target.collection,
                            length,
                        )
                    ) return #err(
                        if (not validDigest(value.body_digest)) {
                            #invalid_digest;
                        } else #invalid_body_length
                    );
                    if (
                        immutableCollection(value.target.collection) and
                        not targetCarriesDigest(
                            value.target,
                            value.body_digest,
                        )
                    ) return #err(#invalid_target);
                    switch (value.expected) {
                        case null {};
                        case (?expected) {
                            if (
                                immutableCollection(
                                    value.target.collection
                                ) or
                                not validMemoryIdentity(expected) or
                                not sameTarget(
                                    value.target,
                                    expected.target,
                                )
                            ) return #err(#invalid_expected_identity);
                        };
                    };
                    bodyBytes += length;
                };
                case (#delete(value)) {
                    deleteCount += 1;
                    if (
                        not validMemoryIdentity(value.expected) or
                        not sameTarget(value.target, value.expected.target)
                    ) return #err(#invalid_expected_identity);
                };
            };
            index += 1;
        };
        if (
            (putCount > 0 and deleteCount > 0) or
            (deleteCount > 0 and mutations.size() != 1)
        ) return #err(#mixed_domains);
        if (bodyBytes > Bounds.MAX_CERTIFIED_BATCH_BYTES) {
            return #err(#batch_too_large);
        };

        for (mutation in mutations.vals()) {
            switch (mutation) {
                case (#delete(_)) {};
                case (#put(value)) {
                    switch (value.requires_present_after) {
                        case null {};
                        case (?dependency) {
                            if (
                                not validMemoryTarget(dependency.target) or
                                not validDigest(dependency.body_digest) or
                                not dependencySatisfied(
                                    mutations,
                                    dependency,
                                ) or
                                sameTarget(value.target, dependency.target)
                            ) return #err(#invalid_dependency);
                        };
                    };
                };
            };
        };
        #ok(mutations);
    };

    func dependencySatisfied(
        mutations : [Memory.PublicationMutation],
        dependency : Memory.CertifiedDependency,
    ) : Bool {
        for (mutation in mutations.vals()) {
            switch (mutation) {
                case (#delete(_)) {};
                case (#put(value)) {
                    if (
                        sameTarget(value.target, dependency.target) and
                        Blob.equal(
                            value.body_digest,
                            dependency.body_digest,
                        )
                    ) return true;
                };
            };
        };
        false;
    };

    func validMemoryIdentity(
        identity : Memory.KernelRecordIdentity
    ) : Bool {
        identity.kernel_revision > 0 and
        validMemoryTarget(identity.target) and
        validDigest(identity.content_tag) and
        validDigest(identity.body_digest) and
        Blob.equal(identity.content_tag, identity.body_digest) and
        validBodyLength(
            identity.target.collection,
            Nat32.toNat(identity.body_length),
        );
    };

    func identityRetainedBytes(
        identity : Memory.KernelRecordIdentity
    ) : Nat {
        128 + targetRetainedBytes(identity.target) +
        identity.content_tag.size() + identity.body_digest.size();
    };

    func targetRetainedBytes(target : Memory.CertifiedTarget) : Nat {
        64 + (
            switch (target.key) {
                case (#digest(value)) value.size();
                case (#post_id(value)) value.size();
                case (#profile) 0;
            }
        );
    };

    func validMemoryTarget(target : Memory.CertifiedTarget) : Bool {
        switch (target.collection, target.key) {
            case (
                (
                    #posts or #shares or #tombstones or #likes or
                    #like_batches
                ),
                #digest(value),
            ) value.size() == Bounds.HASH_BYTES;
            case ((#like_heads or #reply_indexes), #post_id(value)) {
                value.size() == Bounds.HASH_BYTES;
            };
            case (#profile, #profile) true;
            case (_) false;
        };
    };

    func targetCarriesDigest(
        target : Memory.CertifiedTarget,
        digest : Blob,
    ) : Bool {
        switch (target.key) {
            case (#digest(value)) Blob.equal(value, digest);
            case (_) false;
        };
    };

    func immutableCollection(
        collection : Memory.CertifiedCollection
    ) : Bool {
        switch (collection) {
            case (
                #posts or #shares or #tombstones or #likes or #like_batches
            ) true;
            case (#like_heads or #reply_indexes or #profile) false;
        };
    };

    func validBodyLength(
        collection : Memory.CertifiedCollection,
        bodyLength : Nat,
    ) : Bool {
        bodyLength > 0 and bodyLength <= (
            switch (collection) {
                case (#posts) Bounds.MAX_POST_OBJECT_BYTES;
                case (#shares or #tombstones or #likes) {
                    Bounds.MAX_ACTION_OBJECT_BYTES;
                };
                case (#like_batches) Bounds.MAX_LIKE_BATCH_BYTES;
                case (#like_heads) Bounds.MAX_LIKE_HEAD_BYTES;
                case (#reply_indexes) Bounds.MAX_REPLY_INDEX_BYTES;
                case (#profile) Bounds.MAX_PROFILE_OBJECT_BYTES;
            }
        );
    };

    func validDigest(value : Blob) : Bool {
        value.size() == Bounds.HASH_BYTES;
    };

    func sameTarget(
        left : Memory.CertifiedTarget,
        right : Memory.CertifiedTarget,
    ) : Bool {
        left.collection == right.collection and
        left.collection_generation == right.collection_generation and
        (
            switch (left.key, right.key) {
                case (#digest(a), #digest(b)) Blob.equal(a, b);
                case (#post_id(a), #post_id(b)) Blob.equal(a, b);
                case (#profile, #profile) true;
                case (_) false;
            }
        );
    };
};
