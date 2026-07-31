import Map "mo:core/Map";
import Nat32 "mo:core/Nat32";
import Memory "../memory/files/v1";
import ReceiptOwnership "ReceiptOwnership";
import Types "Types";

// Frozen Files managed-memory V1 charging policy. Every persisted row is
// charged as its canonical key bytes, canonical value bytes, and one
// class-specific allocator allowance. Length-bearing values always include a
// four-byte prefix, including empty values. These are conservative quota
// units, not a claim that Motoko heap objects have this exact layout.
module {
    let LENGTH_BYTES = 4;
    let OPTION_TAG_BYTES = 1;
    let VARIANT_TAG_BYTES = 1;
    let BOOL_BYTES = 1;
    let NAT_BYTES = 8;
    let NAT8_BYTES = 1;
    let NAT16_BYTES = 2;
    let NAT32_BYTES = 4;
    let NAT64_BYTES = 8;
    let ID128_BYTES = 16;
    let TAG256_BYTES = 32;
    let CHILD_KEY_BYTES = 48;
    let BLOCK_KEY_BYTES = 20;
    let EXPIRY_KEY_BYTES = 24;

    // Frozen per-row allowances. Payload-bearing tree/stage/lifecycle records
    // use larger classes than compact ordered indexes.
    let VAULT_OVERHEAD = 96;
    let NODE_ROW_OVERHEAD = 128;
    let CHILD_INDEX_ROW_OVERHEAD = 96;
    let BLOCK_ROW_OVERHEAD = 96;
    let STAGE_ROW_OVERHEAD = 160;
    let STAGE_REQUEST_ROW_OVERHEAD = 96;
    let PRIVATE_RECEIPT_ROW_OVERHEAD = 128;
    let PRIVATE_RECEIPT_EXPIRY_ROW_OVERHEAD = 96;
    let PRIVATE_RECEIPT_IDENTITY_ROW_OVERHEAD = 96;
    let CLEANUP_JOB_ROW_OVERHEAD = 128;

    func blobBytes(value : Blob) : Nat {
        LENGTH_BYTES + value.size();
    };

    func optionalIdBytes(value : ?Memory.Id128) : Nat {
        OPTION_TAG_BYTES + (switch (value) {
            case null 0;
            case (?_) ID128_BYTES;
        });
    };

    func optionalTagBytes(value : ?Memory.Tag256) : Nat {
        OPTION_TAG_BYTES + (switch (value) {
            case null 0;
            case (?_) TAG256_BYTES;
        });
    };

    func optionalNat64Bytes(value : ?Nat64) : Nat {
        OPTION_TAG_BYTES + (switch (value) {
            case null 0;
            case (?_) NAT64_BYTES;
        });
    };

    func contentBytes(value : Memory.ContentRecord) : Nat {
        ID128_BYTES +
        blobBytes(value.wrapped_content_key) +
        NAT32_BYTES +
        NAT_BYTES +
        VARIANT_TAG_BYTES;
    };

    func nodeValueBytes(value : Memory.Node) : Nat {
        var bytes =
            ID128_BYTES +
            VARIANT_TAG_BYTES +
            VARIANT_TAG_BYTES +
            TAG256_BYTES +
            NAT16_BYTES +
            NAT64_BYTES * 3 +
            NAT8_BYTES +
            NAT16_BYTES +
            NAT_BYTES +
            blobBytes(value.encrypted_metadata);
        switch (value.state) {
            case (#active) {};
            case (#hidden(_)) bytes += NAT64_BYTES * 2;
        };
        switch (value.kind) {
            case (#folder(folder)) {
                bytes +=
                    NAT32_BYTES +
                    LENGTH_BYTES +
                    folder.child_subtree_heights.size() *
                        (NAT8_BYTES + NAT32_BYTES) +
                    LENGTH_BYTES +
                    folder.child_relative_path_scalars.size() *
                        (NAT16_BYTES + NAT32_BYTES);
            };
            case (#file(file)) {
                bytes += OPTION_TAG_BYTES;
                switch (file.active_content) {
                    case null {};
                    case (?content) bytes += contentBytes(content);
                };
            };
        };
        bytes;
    };

    public func vaultCharge(value : Memory.VaultRecord) : Nat {
        VAULT_OVERHEAD +
        NAT16_BYTES +
        ID128_BYTES +
        TAG256_BYTES +
        NAT64_BYTES +
        TAG256_BYTES +
        blobBytes(value.ibe_wrapped_root_key) +
        TAG256_BYTES +
        NAT64_BYTES;
    };

    public func nodeCharge(value : Memory.Node) : Nat {
        NODE_ROW_OVERHEAD + ID128_BYTES + nodeValueBytes(value);
    };

    public func childIndexCharge() : Nat {
        CHILD_INDEX_ROW_OVERHEAD + CHILD_KEY_BYTES + ID128_BYTES;
    };

    public func blockCharge(bodyBytes : Nat) : Nat {
        BLOCK_ROW_OVERHEAD + BLOCK_KEY_BYTES + LENGTH_BYTES + bodyBytes;
    };

    func byteDeltaBytes(value : Memory.ByteDelta) : Nat {
        VARIANT_TAG_BYTES + (switch (value) {
            case (#unchanged) 0;
            case (#increase(_)) NAT_BYTES;
            case (#decrease(_)) NAT_BYTES;
        });
    };

    func nodeMutationBytes(value : Memory.NodeMutation) : Nat {
        var bytes = ID128_BYTES + OPTION_TAG_BYTES + OPTION_TAG_BYTES;
        switch (value.expected) {
            case null {};
            case (?node) bytes += nodeValueBytes(node);
        };
        switch (value.replacement) {
            case null {};
            case (?node) bytes += nodeValueBytes(node);
        };
        bytes;
    };

    func childMutationBytes(value : Memory.ChildIndexMutation) : Nat {
        CHILD_KEY_BYTES +
        optionalIdBytes(value.expected) +
        optionalIdBytes(value.replacement);
    };

    func commitPlanBytes(value : Memory.PrivateCommitPlan) : Nat {
        var bytes =
            VARIANT_TAG_BYTES +
            LENGTH_BYTES +
            LENGTH_BYTES +
            LENGTH_BYTES +
            byteDeltaBytes(value.node_count_delta) +
            byteDeltaBytes(value.committed_plaintext_delta) +
            byteDeltaBytes(value.committed_ciphertext_delta) +
            NAT_BYTES;
        for (mutation in value.node_mutations.values()) {
            bytes += nodeMutationBytes(mutation);
        };
        for (mutation in value.child_index_mutations.values()) {
            bytes += childMutationBytes(mutation);
        };
        for (retirement in value.retired_contents.values()) {
            bytes += ID128_BYTES + contentBytes(retirement.content);
        };
        bytes;
    };

    func framePlanBytes(value : Memory.FramePlan) : Nat {
        NAT8_BYTES +
        NAT32_BYTES +
        LENGTH_BYTES +
        value.blocks.size() * (
            ID128_BYTES +
            NAT32_BYTES +
            NAT32_BYTES +
            NAT8_BYTES +
            NAT32_BYTES +
            NAT32_BYTES
        );
    };

    public func privateStageCharge(stage : Memory.PrivateStage) : Nat {
        var bytes =
            VARIANT_TAG_BYTES +
            ID128_BYTES +
            TAG256_BYTES +
            NAT64_BYTES * 3 +
            NAT8_BYTES +
            blobBytes(stage.accepted_frame_bitmap) +
            LENGTH_BYTES +
            LENGTH_BYTES +
            commitPlanBytes(stage.commit_plan) +
            NAT_BYTES * 3 +
            NAT8_BYTES;
        for (fingerprint in stage.frame_fingerprints.values()) {
            bytes += OPTION_TAG_BYTES;
            switch (fingerprint) {
                case null {};
                case (?_) bytes += TAG256_BYTES;
            };
        };
        for (frame in stage.frames.values()) {
            bytes += framePlanBytes(frame);
        };
        bytes;
    };

    // Stage value charge is separate because it changes in place. This fixed
    // charge covers exactly its primary row and RequestId -> StageId pointer.
    public func stageRequestIndexCharge() : Nat {
        (STAGE_ROW_OVERHEAD + NAT64_BYTES) +
        (STAGE_REQUEST_ROW_OVERHEAD + ID128_BYTES + NAT64_BYTES);
    };

    func cleanupStateBytes(
        value : ?Memory.StoredCleanupState
    ) : Nat {
        OPTION_TAG_BYTES + (switch (value) {
            case null 0;
            case (?#clean) VARIANT_TAG_BYTES;
            case (?#pending(_)) VARIANT_TAG_BYTES + NAT16_BYTES;
        });
    };

    func privateReceiptNodeBytes(
        value : Memory.PrivateReceiptNode
    ) : Nat {
        ID128_BYTES +
        optionalIdBytes(value.content_id) +
        NAT64_BYTES * 2;
    };

    func privateOutcomeBytes(
        value : Memory.PrivateReceiptOutcome
    ) : Nat {
        VARIANT_TAG_BYTES + (switch (value) {
            case (#vault(outcome)) {
                ID128_BYTES +
                optionalNat64Bytes(outcome.expected_record_revision) +
                NAT64_BYTES +
                BOOL_BYTES;
            };
            case (#write(outcome)) {
                var bytes =
                    ID128_BYTES +
                    optionalNat64Bytes(outcome.stage_id) +
                    NAT8_BYTES +
                    NAT16_BYTES +
                    LENGTH_BYTES +
                    outcome.frame_fingerprints.size() * TAG256_BYTES +
                    LENGTH_BYTES +
                    cleanupStateBytes(outcome.cleanup_state);
                for (node in outcome.nodes.values()) {
                    bytes += privateReceiptNodeBytes(node);
                };
                bytes;
            };
            case (#mutation(_)) ID128_BYTES * 3 + NAT64_BYTES * 2;
            case (#remove(outcome)) {
                ID128_BYTES * 2 +
                NAT64_BYTES +
                NAT16_BYTES +
                NAT64_BYTES +
                cleanupStateBytes(outcome.cleanup_state) +
                optionalNat64Bytes(outcome.cleanup_job_id);
            };
            case (#abort(outcome)) {
                var bytes =
                    ID128_BYTES +
                NAT64_BYTES +
                LENGTH_BYTES +
                OPTION_TAG_BYTES +
                (switch (outcome.stage_kind) {
                    case null 0;
                    case (?_) VARIANT_TAG_BYTES;
                }) +
                optionalIdBytes(outcome.source_node_id) +
                optionalIdBytes(outcome.source_content_id) +
                cleanupStateBytes(outcome.cleanup_state) +
                optionalNat64Bytes(outcome.cleanup_job_id);
                for (node in outcome.nodes.values()) {
                    bytes += ID128_BYTES +
                        optionalIdBytes(node.content_id);
                };
                bytes;
            };
            case (#expired(outcome)) {
                var bytes =
                    ID128_BYTES +
                    NAT64_BYTES +
                    LENGTH_BYTES +
                    LENGTH_BYTES +
                    outcome.frame_plan_fingerprints.size() *
                        TAG256_BYTES +
                    LENGTH_BYTES +
                    cleanupStateBytes(outcome.cleanup_state) +
                    optionalNat64Bytes(outcome.cleanup_job_id);
                for (node in outcome.nodes.values()) {
                    bytes += ID128_BYTES +
                        optionalIdBytes(node.content_id);
                };
                for (fingerprint in
                    outcome.frame_fingerprints.values()) {
                    bytes += OPTION_TAG_BYTES;
                    if (fingerprint != null) {
                        bytes += TAG256_BYTES;
                    };
                };
                bytes;
            };
        });
    };

    public func receiptCharge(receipt : Memory.PrivateReceipt) : Nat {
        TAG256_BYTES +
        privateOutcomeBytes(receipt.outcome) +
        NAT64_BYTES +
        OPTION_TAG_BYTES +
        (switch (receipt.terminal_kind) {
            case null 0;
            case (?_) VARIANT_TAG_BYTES;
        }) +
        NAT64_BYTES;
    };

    // Receipt value charge is separate from the two persistent map rows.
    public func privateReceiptIndexCharge() : Nat {
        (PRIVATE_RECEIPT_ROW_OVERHEAD + ID128_BYTES) +
        (
            PRIVATE_RECEIPT_EXPIRY_ROW_OVERHEAD +
            EXPIRY_KEY_BYTES
        );
    };

    public func privateReceiptIdentityRowCharge() : Nat {
        PRIVATE_RECEIPT_IDENTITY_ROW_OVERHEAD +
        ID128_BYTES +
        NAT16_BYTES * 2;
    };

    // Reservations conservatively assume every distinct identity retained by
    // the receipt creates a new stable row. Insertion charges only actual new
    // rows, so the physical counter remains exact when receipts share IDs.
    public func privateReceiptMaximumIdentityCharge(
        receipt : Memory.PrivateReceipt
    ) : Nat {
        ReceiptOwnership.receipt(receipt).row_ids.size() *
        privateReceiptIdentityRowCharge();
    };

    public func cleanupJobCharge(job : Memory.DeleteJob) : Nat {
        var bytes =
            CLEANUP_JOB_ROW_OVERHEAD +
            NAT64_BYTES +
            NAT64_BYTES +
            VARIANT_TAG_BYTES +
            NAT64_BYTES * 2 +
            NAT_BYTES * 2;
        switch (job.kind) {
            case (#subtree(value)) {
                bytes += ID128_BYTES + LENGTH_BYTES;
                for (frame in value.stack.values()) {
                    bytes +=
                        ID128_BYTES +
                        optionalTagBytes(frame.after_child_tag) +
                        BOOL_BYTES;
                };
            };
            case (#contents(value)) {
                bytes +=
                    LENGTH_BYTES +
                    value.contents.size() *
                        (ID128_BYTES + NAT32_BYTES * 2) +
                    NAT8_BYTES;
            };
            case (#private_stage(value)) {
                bytes +=
                    LENGTH_BYTES +
                    value.blocks.size() * BLOCK_KEY_BYTES +
                    NAT32_BYTES;
            };
            case (#orphan_blocks(_)) {
                bytes += ID128_BYTES + NAT32_BYTES * 2;
            };
        };
        bytes;
    };

    public type PrivateCommitReservation = {
        current_stage_charge : Nat;
        maximum_stage_charge : Nat;
        block_rows_charge : Nat;
        structural_growth_charge : Nat;
        terminal_receipt_charge : Nat;
        commit_cleanup_job_charge : Nat;
        abort_cleanup_job_charge : Nat;
        cleanup_job_charge : Nat;
        final_commit_charge : Nat;
        terminal_reservation_charge : Nat;
        peak_reservation_charge : Nat;
        cleanup_jobs : Nat;
    };

    func privateReceiptContentBytes(node : Memory.Node) : Nat {
        switch (node.kind) {
            case (#folder(_)) OPTION_TAG_BYTES;
            case (#file(file)) switch (file.active_content) {
                case null OPTION_TAG_BYTES;
                case (?_) OPTION_TAG_BYTES + ID128_BYTES;
            };
        };
    };

    // Completion stores only explicit file/folder results, matching the
    // metadata-revision predicate used by Service.committedPrivateNodes.
    func projectedWriteReceiptCharge(
        stage : Memory.PrivateStage
    ) : Nat {
        var nodesBytes = 0;
        for (mutation in stage.commit_plan.node_mutations.values()) {
            switch (mutation.replacement) {
                case null {};
                case (?replacement) {
                    let explicit = switch (mutation.expected) {
                        case null true;
                        case (?expected) {
                            expected.metadata_revision !=
                                replacement.metadata_revision;
                        };
                    };
                    if (explicit) {
                        nodesBytes +=
                            ID128_BYTES +
                            privateReceiptContentBytes(replacement) +
                            NAT64_BYTES * 2;
                    };
                };
            };
        };
        let valueBytes =
            TAG256_BYTES +
            VARIANT_TAG_BYTES +
            ID128_BYTES +
            OPTION_TAG_BYTES + NAT64_BYTES +
            NAT8_BYTES +
            NAT16_BYTES +
            LENGTH_BYTES +
            stage.frame_fingerprints.size() * TAG256_BYTES +
            LENGTH_BYTES +
            nodesBytes +
            // Optional #pending is the largest persisted cleanup summary.
            OPTION_TAG_BYTES + VARIANT_TAG_BYTES + NAT16_BYTES +
            NAT64_BYTES +
            OPTION_TAG_BYTES +
            NAT64_BYTES;
        valueBytes +
        privateReceiptIndexCharge() +
        ReceiptOwnership.stage(stage).row_ids.size() *
            privateReceiptIdentityRowCharge();
    };

    func projectedExpiredReceiptCharge(
        stage : Memory.PrivateStage
    ) : Nat {
        var nodesBytes = 0;
        for (mutation in stage.commit_plan.node_mutations.values()) {
            switch (mutation.replacement) {
                case null {};
                case (?replacement) {
                    let explicit = switch (mutation.expected) {
                        case null true;
                        case (?expected) {
                            expected.metadata_revision !=
                                replacement.metadata_revision;
                        };
                    };
                    if (explicit) {
                        nodesBytes += ID128_BYTES + OPTION_TAG_BYTES;
                        switch (replacement.kind) {
                            case (#file(file)) if (
                                file.active_content != null
                            ) nodesBytes += ID128_BYTES;
                            case (_) {};
                        };
                    };
                };
            };
        };
        let frameCount = stage.frame_fingerprints.size();
        let valueBytes =
            TAG256_BYTES +
            VARIANT_TAG_BYTES +
            ID128_BYTES +
            NAT64_BYTES +
            LENGTH_BYTES + nodesBytes +
            LENGTH_BYTES + frameCount * TAG256_BYTES +
            LENGTH_BYTES +
                frameCount * (OPTION_TAG_BYTES + TAG256_BYTES) +
            // Optional #pending and a present cleanup job are the largest
            // terminal encodings.
            OPTION_TAG_BYTES + VARIANT_TAG_BYTES + NAT16_BYTES +
            OPTION_TAG_BYTES + NAT64_BYTES +
            NAT64_BYTES +
            OPTION_TAG_BYTES + VARIANT_TAG_BYTES +
            NAT64_BYTES;
        valueBytes +
        privateReceiptIndexCharge() +
        ReceiptOwnership.stage(stage).row_ids.size() *
            privateReceiptIdentityRowCharge();
    };

    func projectedContentsJobCharge(
        retiredCount : Nat
    ) : Nat {
        CLEANUP_JOB_ROW_OVERHEAD +
        NAT64_BYTES +
        NAT64_BYTES +
        VARIANT_TAG_BYTES +
        LENGTH_BYTES +
        retiredCount * (ID128_BYTES + NAT32_BYTES * 2) +
        NAT8_BYTES +
        NAT64_BYTES * 2 +
        NAT_BYTES * 2;
    };

    // An abort/expiry removes one bounded block page synchronously. If blocks
    // remain, the persisted job retains the complete canonical key vector and
    // advances its cursor past that first page.
    func projectedPrivateStageJobCharge(
        plannedBlockCount : Nat
    ) : Nat {
        CLEANUP_JOB_ROW_OVERHEAD +
        NAT64_BYTES +
        NAT64_BYTES +
        VARIANT_TAG_BYTES +
        LENGTH_BYTES +
        plannedBlockCount * BLOCK_KEY_BYTES +
        NAT32_BYTES +
        NAT64_BYTES * 2 +
        NAT_BYTES * 2;
    };

    // Derives the complete gross private peak from persisted plan geometry.
    // Client gross_peak_physical_bytes and commit_plan.final_physical_bytes
    // are witnesses only and must never be used as authority for admission.
    public func privateCommitReservation(
        stage : Memory.PrivateStage
    ) : PrivateCommitReservation {
        var nullFingerprints = 0;
        for (fingerprint in stage.frame_fingerprints.values()) {
            if (fingerprint == null) nullFingerprints += 1;
        };
        let currentStage =
            privateStageCharge(stage) + stageRequestIndexCharge();
        let maximumStage =
            currentStage + nullFingerprints * TAG256_BYTES;
        var blocks = 0;
        var plannedBlockCount = 0;
        var plannedCiphertextBytes = 0;
        for (frame in stage.frames.values()) {
            for (block in frame.blocks.values()) {
                plannedBlockCount += 1;
                plannedCiphertextBytes += Nat32.toNat(
                    block.ciphertext_bytes
                );
                blocks += blockCharge(
                    Nat32.toNat(block.ciphertext_bytes)
                );
            };
        };
        var structuralBefore = 0;
        var structuralAfter = 0;
        for (mutation in stage.commit_plan.node_mutations.values()) {
            switch (mutation.expected) {
                case null {};
                case (?node) structuralBefore += nodeCharge(node);
            };
            switch (mutation.replacement) {
                case null {};
                case (?node) structuralAfter += nodeCharge(node);
            };
        };
        for (
            mutation in stage.commit_plan.child_index_mutations.values()
        ) {
            if (mutation.expected != null) {
                structuralBefore += childIndexCharge();
            };
            if (mutation.replacement != null) {
                structuralAfter += childIndexCharge();
            };
        };
        let structuralGrowth = if (
            structuralAfter > structuralBefore
        ) {
            structuralAfter - structuralBefore;
        } else 0;
        var retiredBlocks = 0;
        var retiredCiphertextBytes = 0;
        for (
            retirement in stage.commit_plan.retired_contents.values()
        ) {
            retiredBlocks += Nat32.toNat(
                retirement.content.block_count
            );
            retiredCiphertextBytes +=
                retirement.content.ciphertext_bytes;
        };
        let commitCleanupJobs =
            if (
                retiredBlocks > Types.MAX_CLEANUP_BLOCKS_PER_PAGE or
                retiredCiphertextBytes >
                    Types.MAX_CLEANUP_CIPHERTEXT_PER_PAGE
            ) 1 else 0;
        let commitJobCharge = if (commitCleanupJobs == 0) 0 else {
            projectedContentsJobCharge(
                stage.commit_plan.retired_contents.size()
            );
        };
        let abortCleanupJobs =
            if (
                plannedBlockCount >
                    Types.MAX_CLEANUP_BLOCKS_PER_PAGE or
                plannedCiphertextBytes >
                    Types.MAX_CLEANUP_CIPHERTEXT_PER_PAGE
            ) 1 else 0;
        let abortJobCharge = if (abortCleanupJobs == 0) 0 else {
            projectedPrivateStageJobCharge(plannedBlockCount);
        };
        let cleanupJobs =
            if (commitCleanupJobs >= abortCleanupJobs) {
                commitCleanupJobs
            } else {
                abortCleanupJobs
            };
        let jobCharge =
            if (commitJobCharge >= abortJobCharge) {
                commitJobCharge
            } else {
                abortJobCharge
            };
        let writeReceiptCharge = projectedWriteReceiptCharge(stage);
        let expiredReceiptCharge =
            projectedExpiredReceiptCharge(stage);
        let receiptCharge = if (
            writeReceiptCharge >= expiredReceiptCharge
        ) {
            writeReceiptCharge;
        } else {
            expiredReceiptCharge;
        };
        let finalCharge =
            structuralGrowth + receiptCharge + commitJobCharge;
        // Reserve the larger committed/expired receipt shape. The private
        // abort receipt is smaller; the independent maximum cleanup-job shape
        // then covers every terminal path.
        let terminalReservation =
            structuralGrowth + receiptCharge + jobCharge;
        {
            current_stage_charge = currentStage;
            maximum_stage_charge = maximumStage;
            block_rows_charge = blocks;
            structural_growth_charge = structuralGrowth;
            terminal_receipt_charge = receiptCharge;
            commit_cleanup_job_charge = commitJobCharge;
            abort_cleanup_job_charge = abortJobCharge;
            cleanup_job_charge = jobCharge;
            final_commit_charge = finalCharge;
            terminal_reservation_charge = terminalReservation;
            peak_reservation_charge =
                maximumStage + blocks + terminalReservation;
            cleanup_jobs = cleanupJobs;
        };
    };

    public func canReserve(
        mem : Memory.Mem,
        stagedBytes : Nat,
        physicalBytes : Nat,
        cleanupJobs : Nat,
    ) : Bool {
        mem.staged_ciphertext_bytes +
            mem.reserved_staged_ciphertext_bytes + stagedBytes <=
            Types.MAX_STAGED_CIPHERTEXT_BYTES and
        mem.physical_private_bytes +
            mem.reserved_physical_private_bytes + physicalBytes <=
            Types.MAX_PHYSICAL_PRIVATE_BYTES and
        Map.size(mem.delete_jobs) + mem.reserved_cleanup_jobs + cleanupJobs <=
            Types.MAX_CLEANUP_JOBS;
    };

    public func reserve(
        mem : Memory.Mem,
        stagedBytes : Nat,
        physicalBytes : Nat,
        cleanupJobs : Nat,
    ) {
        mem.reserved_staged_ciphertext_bytes += stagedBytes;
        mem.reserved_physical_private_bytes += physicalBytes;
        mem.reserved_cleanup_jobs += cleanupJobs;
    };

    public func releaseReservation(
        mem : Memory.Mem,
        stagedBytes : Nat,
        physicalBytes : Nat,
        cleanupJobs : Nat,
    ) {
        assert mem.reserved_staged_ciphertext_bytes >= stagedBytes;
        assert mem.reserved_physical_private_bytes >= physicalBytes;
        assert mem.reserved_cleanup_jobs >= cleanupJobs;
        mem.reserved_staged_ciphertext_bytes -= stagedBytes;
        mem.reserved_physical_private_bytes -= physicalBytes;
        mem.reserved_cleanup_jobs -= cleanupJobs;
    };

    public func addPhysical(mem : Memory.Mem, bytes : Nat) {
        assert mem.physical_private_bytes + bytes <=
            Types.MAX_PHYSICAL_PRIVATE_BYTES;
        mem.physical_private_bytes += bytes;
    };

    public func removePhysical(mem : Memory.Mem, bytes : Nat) {
        assert mem.physical_private_bytes >= bytes;
        mem.physical_private_bytes -= bytes;
    };
};
