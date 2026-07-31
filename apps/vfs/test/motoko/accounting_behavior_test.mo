import Map "mo:core/Map";
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Memory "../../backend/memory/files/v1";
import Accounting "../../backend/files/Accounting";
import Types "../../backend/files/Types";
import Fixtures "Fixtures";

func id(value : Nat) : Memory.Id128 {
    Fixtures.id(value);
};

func tag(value : Nat64) : Memory.Tag256 {
    (0, 0, 0, value);
};

let content : Memory.ContentRecord = {
    content_id = id(20);
    wrapped_content_key = Fixtures.zeros(5);
    block_count = 2;
    ciphertext_bytes = 20;
    crypto_profile = #aes_256_gcm_files_v2;
};

let folder : Memory.Node = {
    parent_id = id(1);
    kind = #folder({
        direct_child_count = 2;
        child_subtree_heights = [{ value = 1; count = 2 }];
        child_relative_path_scalars = [{ value = 3; count = 2 }];
    });
    state = #active;
    name_tag = tag(1);
    declared_name_scalars = 3;
    structural_revision = 1;
    metadata_revision = 2;
    children_revision = 3;
    subtree_height = 1;
    max_relative_path_scalars = 3;
    subtree_plaintext_bytes = 20;
    encrypted_metadata = Fixtures.zeros(3);
};

let file : Memory.Node = {
    folder with
    parent_id = id(2);
    kind = #file({ active_content = ?content });
    state = #hidden({ cleanup_job_id = 9; hidden_at_ns = 10 });
    name_tag = tag(2);
    children_revision = 0;
    subtree_height = 0;
};

let vault : Memory.VaultRecord = {
    format = 2;
    vault_id = id(10);
    vault_salt = tag(10);
    slot_generation = 1;
    public_key_fingerprint = tag(11);
    ibe_wrapped_root_key = Fixtures.zeros(4);
    root_commitment = tag(12);
    record_revision = 1;
};

let plan : Memory.PrivateCommitPlan = {
    intent = #replace;
    node_mutations = [{
        node_id = id(2);
        expected = ?folder;
        replacement = ?file;
    }];
    child_index_mutations = [{
        key = (0, 2, 0, 0, 0, 2);
        expected = ?id(2);
        replacement = ?id(3);
    }];
    retired_contents = [{ node_id = id(2); content }];
    node_count_delta = #increase(1);
    committed_plaintext_delta = #decrease(2);
    committed_ciphertext_delta = #unchanged;
    final_physical_bytes = 123;
};

let privateStage : Memory.PrivateStage = {
    request_id = id(30);
    request_fingerprint = tag(30);
    created_at_ns = 1;
    last_activity_at_ns = 2;
    expires_at_ns = 3;
    frame_count = 1;
    accepted_frame_bitmap = Fixtures.zeros(1);
    frame_fingerprints = [?tag(31), null];
    frames = [{
        ordinal = 0;
        encoded_bytes = 100;
        blocks = [{
            content_id = id(20);
            block_index = 0;
            ciphertext_bytes = 20;
            frame_ordinal = 0;
            payload_offset = 0;
            payload_length = 20;
        }];
    }];
    commit_plan = plan;
    accepted_ciphertext_bytes = 20;
    reserved_ciphertext_bytes = 20;
    reserved_physical_bytes = 1_000;
    reserved_cleanup_jobs = 1;
};

let writeReceipt : Memory.PrivateReceipt = {
    request_fingerprint = tag(50);
    outcome = #write({
        request_id = id(50);
        stage_id = ?1;
        frame_ordinal = 1;
        accepted_frames_bitmap = 3;
        frame_fingerprints = [tag(51), tag(52)];
        nodes = [
            {
                node_id = id(2);
                content_id = null;
                structural_revision = 1;
                metadata_revision = 2;
            },
            {
                node_id = id(3);
                content_id = ?id(20);
                structural_revision = 3;
                metadata_revision = 4;
            },
        ];
        cleanup_state = ?#pending({ remaining_jobs = 1 });
    });
    completed_at_ns = 5;
    terminal_kind = ?#aborted;
    expires_at_ns = 6;
};

let contentsJob : Memory.DeleteJob = {
    job_id = 1;
    kind = #contents({
        contents = [
            {
                content_id = id(20);
                next_block_index = 1;
                block_count = 2;
            },
            {
                content_id = id(21);
                next_block_index = 0;
                block_count = 3;
            },
        ];
        current_content = 0;
    });
    created_at_ns = 1;
    updated_at_ns = 2;
    reclaimed_entries = 3;
    reclaimed_ciphertext_bytes = 4;
};

// Literal schema-V1 golden vector. Any persisted-shape or prefix change must
// deliberately version the policy and update this fixture.
assert (Accounting.vaultCharge(vault) == 234);
assert (Accounting.nodeCharge(folder) == 261);
assert (Accounting.nodeCharge(file) == 293);
assert (Accounting.childIndexCharge() == 160);
assert (Accounting.blockCharge(20) == 140);
assert (Accounting.privateStageCharge(privateStage) == 648);
assert (Accounting.stageRequestIndexCharge() == 288);
assert (Accounting.receiptCharge(writeReceipt) == 237);
assert (Accounting.privateReceiptIndexCharge() == 264);
assert (Accounting.privateReceiptIdentityRowCharge() == 116);
assert (
    Accounting.privateReceiptMaximumIdentityCharge(writeReceipt) ==
        348
);
assert (Accounting.cleanupJobCharge(contentsJob) == 230);
let reservation = Accounting.privateCommitReservation(privateStage);
assert (reservation.current_stage_charge == 936);
assert (reservation.maximum_stage_charge == 968);
assert (reservation.block_rows_charge == 140);
assert (reservation.structural_growth_charge == 32);
assert (reservation.terminal_receipt_charge == 494);
assert (reservation.commit_cleanup_job_charge == 0);
assert (reservation.abort_cleanup_job_charge == 0);
assert (reservation.cleanup_job_charge == 0);
assert (reservation.final_commit_charge == 526);
assert (reservation.terminal_reservation_charge == 526);
assert (reservation.peak_reservation_charge == 1_634);
assert (reservation.cleanup_jobs == 0);

// A fully accepted stage with more than one synchronous cleanup page needs a
// job even when commit retires no prior content. Admission reserves the full
// private-stage job row and one cleanup slot for the abort/expiry path.
let abortBlocks = Array.tabulate<Memory.StageBlock>(
    Types.MAX_CLEANUP_BLOCKS_PER_PAGE + 1,
    func(index) {
        {
            content_id = id(100 + index);
            block_index = 0;
            ciphertext_bytes = 1;
            frame_ordinal = 0;
            payload_offset = Nat32.fromNat(index);
            payload_length = 1;
        };
    },
);
let abortPlan : Memory.PrivateCommitPlan = {
    plan with retired_contents = [];
};
let abortStage : Memory.PrivateStage = {
    privateStage with
    frames = [{
        ordinal = 0;
        encoded_bytes = 10;
        blocks = abortBlocks;
    }];
    commit_plan = abortPlan;
    accepted_ciphertext_bytes =
        Types.MAX_CLEANUP_BLOCKS_PER_PAGE + 1;
    reserved_ciphertext_bytes = 0;
};
let abortReservation =
    Accounting.privateCommitReservation(abortStage);
assert (abortReservation.cleanup_jobs == 1);
assert (abortReservation.commit_cleanup_job_charge == 0);
assert (abortReservation.abort_cleanup_job_charge == 925);
assert (abortReservation.cleanup_job_charge == 925);
assert (
    abortReservation.terminal_reservation_charge ==
        abortReservation.final_commit_charge + 925
);
assert (
    abortReservation.peak_reservation_charge ==
        abortReservation.maximum_stage_charge +
        abortReservation.block_rows_charge +
        abortReservation.terminal_reservation_charge
);
let lastCleanupSlot = Memory.init();
lastCleanupSlot.reserved_cleanup_jobs :=
    Types.MAX_CLEANUP_JOBS - 1;
assert (
    Accounting.canReserve(
        lastCleanupSlot,
        0,
        abortReservation.peak_reservation_charge,
        abortReservation.cleanup_jobs,
    )
);
let fullCleanupLane = Memory.init();
fullCleanupLane.reserved_cleanup_jobs :=
    Types.MAX_CLEANUP_JOBS;
assert (
    not Accounting.canReserve(
        fullCleanupLane,
        0,
        abortReservation.peak_reservation_charge,
        abortReservation.cleanup_jobs,
    )
);

// Maximum terminal geometry is charged from the persisted value shapes, not
// from an average receipt estimate. Sixty-four explicit targets, nine accepted
// frames, and ten accepted block rows cover the largest batch target vector
// together with an abort/expiry cleanup job.
let maximumNodeMutations = Array.tabulate<Memory.NodeMutation>(
    Types.MAX_BATCH_PLAN_ENTRIES,
    func(index) {
        {
            node_id = id(1_000 + index);
            expected = null;
            replacement = ?file;
        };
    },
);
let maximumBlocks = Array.tabulate<Memory.StageBlock>(
    Types.MAX_CLEANUP_BLOCKS_PER_PAGE + 1,
    func(index) {
        {
            content_id = id(2_000 + index);
            block_index = 0;
            ciphertext_bytes = 1;
            frame_ordinal = Nat8.fromNat(
                if (index < 2) 0 else index - 1
            );
            payload_offset = Nat32.fromNat(index);
            payload_length = 1;
        };
    },
);
let maximumFrames = Array.tabulate<Memory.FramePlan>(
    Types.MAX_SINGLE_WRITE_FRAMES,
    func(index) {
        let blocks = if (index == 0) {
            [maximumBlocks[0], maximumBlocks[1]]
        } else {
            [maximumBlocks[index + 1]]
        };
        {
            ordinal = Nat8.fromNat(index);
            encoded_bytes = Nat32.fromNat(blocks.size());
            blocks;
        };
    },
);
let maximumPlan : Memory.PrivateCommitPlan = {
    intent = #batch;
    node_mutations = maximumNodeMutations;
    child_index_mutations = [];
    retired_contents = [];
    node_count_delta = #increase(Types.MAX_BATCH_PLAN_ENTRIES);
    committed_plaintext_delta = #unchanged;
    committed_ciphertext_delta = #unchanged;
    final_physical_bytes = 0;
};
let maximumStage : Memory.PrivateStage = {
    request_id = id(3_000);
    request_fingerprint = tag(3_000);
    created_at_ns = 1;
    last_activity_at_ns = 2;
    expires_at_ns = 3;
    frame_count = Nat8.fromNat(Types.MAX_SINGLE_WRITE_FRAMES);
    accepted_frame_bitmap = Blob.fromArray([255, 255, 255, 255, 15]);
    frame_fingerprints = Array.tabulate<?Memory.Tag256>(
        Types.MAX_SINGLE_WRITE_FRAMES,
        func(index) { ?tag(Nat64.fromNat(3_100 + index)) },
    );
    frames = maximumFrames;
    commit_plan = maximumPlan;
    accepted_ciphertext_bytes =
        Types.MAX_CLEANUP_BLOCKS_PER_PAGE + 1;
    reserved_ciphertext_bytes = 0;
    reserved_physical_bytes = 100_000;
    reserved_cleanup_jobs = 1;
};
let maximumTargets = Array.tabulate<Memory.PrivateReceiptTargetNode>(
    Types.MAX_BATCH_PLAN_ENTRIES,
    func(index) {
        {
            node_id = id(1_000 + index);
            content_id = ?content.content_id;
        };
    },
);
let maximumAbort : Memory.PrivateReceipt = {
    request_fingerprint = tag(3_001);
    outcome = #abort({
        request_id = id(3_001);
        stage_id = 1;
        nodes = maximumTargets;
        stage_kind = ?#private_write;
        source_node_id = null;
        source_content_id = null;
        cleanup_state = ?#pending({
            remaining_jobs = Nat16.fromNat(Types.MAX_CLEANUP_JOBS)
        });
        cleanup_job_id = ?1;
    });
    completed_at_ns = 4;
    terminal_kind = ?#aborted;
    expires_at_ns = 5;
};
let maximumExpired : Memory.PrivateReceipt = {
    request_fingerprint = maximumStage.request_fingerprint;
    outcome = #expired({
        request_id = maximumStage.request_id;
        stage_id = 1;
        nodes = maximumTargets;
        frame_plan_fingerprints = Array.tabulate<Memory.Tag256>(
            Types.MAX_SINGLE_WRITE_FRAMES,
            func(index) { tag(Nat64.fromNat(3_200 + index)) },
        );
        frame_fingerprints = maximumStage.frame_fingerprints;
        cleanup_state = ?#pending({
            remaining_jobs = Nat16.fromNat(Types.MAX_CLEANUP_JOBS)
        });
        cleanup_job_id = ?1;
    });
    completed_at_ns = maximumStage.expires_at_ns;
    terminal_kind = ?#expired;
    expires_at_ns = 6;
};
let maximumCleanupJob : Memory.DeleteJob = {
    job_id = 1;
    kind = #private_stage({
        blocks = Array.map<Memory.StageBlock, Memory.BlockKey>(
            maximumBlocks,
            func(block) {
                (
                    block.content_id.hi,
                    block.content_id.lo,
                    block.block_index,
                )
            },
        );
        next_block = Nat32.fromNat(
            Types.MAX_CLEANUP_BLOCKS_PER_PAGE
        );
    });
    created_at_ns = 4;
    updated_at_ns = 4;
    reclaimed_entries = Types.MAX_CLEANUP_BLOCKS_PER_PAGE;
    reclaimed_ciphertext_bytes =
        Types.MAX_CLEANUP_BLOCKS_PER_PAGE;
};
let maximumReservation =
    Accounting.privateCommitReservation(maximumStage);
assert (Accounting.privateStageCharge(maximumStage) == 13_569);
assert (maximumReservation.current_stage_charge == 13_857);
assert (maximumReservation.maximum_stage_charge == 13_857);
assert (maximumReservation.block_rows_charge == 4_477);
assert (maximumReservation.structural_growth_charge == 18_752);
assert (Accounting.receiptCharge(maximumAbort) == 2_208);
assert (
    Accounting.receiptCharge(maximumAbort) +
        Accounting.privateReceiptIndexCharge() == 2_472
);
assert (Accounting.receiptCharge(maximumExpired) == 4_552);
assert (
    Accounting.receiptCharge(maximumExpired) +
        Accounting.privateReceiptIndexCharge() == 4_816
);
assert (Accounting.cleanupJobCharge(maximumCleanupJob) == 925);
assert (maximumReservation.terminal_receipt_charge == 12_356);
assert (maximumReservation.final_commit_charge == 31_108);
assert (maximumReservation.terminal_reservation_charge == 32_033);
assert (maximumReservation.peak_reservation_charge == 50_367);
assert (maximumReservation.cleanup_jobs == 1);
let maximumExpiredTail =
    maximumReservation.structural_growth_charge +
    Accounting.receiptCharge(maximumExpired) +
    Accounting.privateReceiptIndexCharge() +
    Accounting.privateReceiptMaximumIdentityCharge(maximumExpired) +
    Accounting.cleanupJobCharge(maximumCleanupJob);
assert (
    maximumExpiredTail <=
        maximumReservation.terminal_reservation_charge
);
let maximumAccounting = Memory.init();
Accounting.reserve(
    maximumAccounting,
    maximumStage.accepted_ciphertext_bytes,
    maximumReservation.peak_reservation_charge,
    maximumReservation.cleanup_jobs,
);
Accounting.releaseReservation(
    maximumAccounting,
    maximumStage.accepted_ciphertext_bytes,
    maximumReservation.peak_reservation_charge,
    maximumReservation.cleanup_jobs,
);
assert (maximumAccounting.reserved_staged_ciphertext_bytes == 0);
assert (maximumAccounting.reserved_physical_private_bytes == 0);
assert (maximumAccounting.reserved_cleanup_jobs == 0);

// Every dynamic field contributes its canonical prefix and payload. These
// monotonicity checks protect the common omission regressions independently
// of the literal golden vector below.
assert (
    Accounting.blockCharge(21) ==
    Accounting.blockCharge(20) + 1
);
// Admission remains inclusive at the physical ceiling with the complete
// canonical stage value and both stage-map indexes.
let stageTotal =
    Accounting.privateStageCharge(privateStage) +
    Accounting.stageRequestIndexCharge();
let exact = Memory.init();
exact.physical_private_bytes :=
    Types.MAX_PHYSICAL_PRIVATE_BYTES - stageTotal;
assert (Accounting.canReserve(exact, 0, stageTotal, 0));
let plusOne = Memory.init();
plusOne.physical_private_bytes :=
    Types.MAX_PHYSICAL_PRIVATE_BYTES - stageTotal + 1;
assert (not Accounting.canReserve(plusOne, 0, stageTotal, 0));

// A representative full logical body state includes all body-row prefixes,
// 10,000 primary node rows, 9,999 child indexes, and the singleton vault.
// The gross physical ceiling, not any logical sub-limit, remains authoritative.
let representativeFull =
    Types.MAX_COMMITTED_CIPHERTEXT_BYTES +
    45 * Accounting.blockCharge(0) +
    9_999 * Accounting.nodeCharge(file) +
    Accounting.nodeCharge(folder) +
    9_999 * Accounting.childIndexCharge() +
    Accounting.vaultCharge(vault);
assert (representativeFull < Types.MAX_PHYSICAL_PRIVATE_BYTES);

// Keep imports and constructor paths live in the managed-memory configuration
// used by the release fixture.
assert (Map.size(Memory.init().nodes_by_id) == 0);
assert (Nat32.toNat(content.block_count) == 2);
