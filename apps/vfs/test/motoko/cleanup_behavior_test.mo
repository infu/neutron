import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Runtime "mo:core/Runtime";
import Memory "../../backend/memory/files/v1";
import Accounting "../../backend/files/Accounting";
import Keys "../../backend/files/Keys";
import ReceiptOwnership "../../backend/files/ReceiptOwnership";
import Service "../../backend/files/Service";
import Types "../../backend/files/Types";
import Fixtures "Fixtures";

func privateReceipt(
    requestId : Types.Id128,
    expiry : Nat64,
) : Memory.PrivateReceipt {
    {
        request_fingerprint = (0, 0, 0, requestId.lo);
        outcome = #vault({
            request_id = requestId;
            expected_record_revision = null;
            record_revision = 1;
            initialized = true;
        });
        completed_at_ns = 0;
        terminal_kind = null;
        expires_at_ns = expiry;
    };
};

func writeReceipt(
    requestId : Types.Id128,
    expiry : Nat64,
    nodes : [Memory.PrivateReceiptNode],
) : Memory.PrivateReceipt {
    {
        request_fingerprint = (0, 0, 1, requestId.lo);
        outcome = #write({
            request_id = requestId;
            stage_id = ?requestId.lo;
            frame_ordinal = 0;
            accepted_frames_bitmap = 1;
            frame_fingerprints = [(0, 0, 2, requestId.lo)];
            nodes;
            cleanup_state = ?#clean;
        });
        completed_at_ns = 0;
        terminal_kind = null;
        expires_at_ns = expiry;
    };
};

func incrementPrivateReceiptIdentity(
    mem : Memory.Mem,
    id : Types.Id128,
    node : Bool,
) : Bool {
    let prior = Map.get(
        mem.private_receipt_identity_owners,
        Keys.compareId128,
        id,
    );
    let current : Memory.PrivateReceiptIdentityOwner = switch (prior) {
        case null {
            { node_count = 0; content_count = 0 };
        };
        case (?value) value;
    };
    Map.add(
        mem.private_receipt_identity_owners,
        Keys.compareId128,
        id,
        if (node) {
            {
                node_count = Nat16.fromNat(
                    Nat16.toNat(current.node_count) + 1
                );
                content_count = current.content_count;
            };
        } else {
            {
                node_count = current.node_count;
                content_count = Nat16.fromNat(
                    Nat16.toNat(current.content_count) + 1
                );
            };
        },
    );
    prior == null;
};

func installPrivateReceipt(
    mem : Memory.Mem,
    requestId : Types.Id128,
    receipt : Memory.PrivateReceipt,
) : Nat {
    Map.add(
        mem.private_receipts,
        Keys.compareId128,
        requestId,
        receipt,
    );
    Map.add(
        mem.private_receipts_by_expiry,
        Keys.comparePrivateReceiptExpiryKey,
        (receipt.expires_at_ns, requestId.hi, requestId.lo),
        (),
    );
    let identities = ReceiptOwnership.receipt(receipt);
    var identityRows = 0;
    for (id in identities.node_ids.values()) {
        if (incrementPrivateReceiptIdentity(mem, id, true)) {
            identityRows += 1;
        };
    };
    for (id in identities.content_ids.values()) {
        if (incrementPrivateReceiptIdentity(mem, id, false)) {
            identityRows += 1;
        };
    };
    let charge =
        Accounting.receiptCharge(receipt) +
        Accounting.privateReceiptIndexCharge() +
        identityRows * Accounting.privateReceiptIdentityRowCharge();
    mem.physical_private_bytes += charge;
    charge;
};

func addPrivateReceipt(
    mem : Memory.Mem,
    requestId : Types.Id128,
    expiry : Nat64,
) : Nat {
    installPrivateReceipt(
        mem,
        requestId,
        privateReceipt(requestId, expiry),
    );
};


func service(mem : Memory.Mem, now : Nat64) : Service.Service {
    Service.Service(
        mem,
        Fixtures.assets(Fixtures.zeroUsage()),
        func() : Nat64 { now },
    );
};

func serviceWithCounter(
    mem : Memory.Mem,
    now : Nat64,
    measuredAfterStart : Nat64,
) : Service.Service {
    var sampled = false;
    Service.ServiceWithCounter(
        mem,
        Fixtures.assets(Fixtures.zeroUsage()),
        func() : Nat64 { now },
        func() : Nat64 {
            if (sampled) measuredAfterStart else {
                sampled := true;
                0;
            };
        },
    );
};

func vault() : Memory.VaultRecord {
    {
        format = 2;
        vault_id = Fixtures.id(100);
        vault_salt = (0, 0, 0, 1);
        slot_generation = 1;
        public_key_fingerprint = (0, 0, 0, 2);
        ibe_wrapped_root_key = Fixtures.zeros(32);
        root_commitment = (0, 0, 0, 3);
        record_revision = 1;
    };
};

func root() : Memory.Node {
    {
        parent_id = Types.ROOT_NODE_ID;
        kind = #folder({
            direct_child_count = 0;
            child_subtree_heights = [];
            child_relative_path_scalars = [];
        });
        state = #active;
        name_tag = Types.ZERO_TAG;
        declared_name_scalars = 0;
        structural_revision = 1;
        metadata_revision = 1;
        children_revision = 0;
        subtree_height = 0;
        max_relative_path_scalars = 0;
        subtree_plaintext_bytes = 0;
        encrypted_metadata = Fixtures.zeros(16);
    };
};

func initializeVault(mem : Memory.Mem) : Nat {
    let vaultValue = vault();
    let rootValue = root();
    mem.vault := ?vaultValue;
    Map.add(
        mem.nodes_by_id,
        Keys.compareId128,
        Types.ROOT_NODE_ID,
        rootValue,
    );
    mem.node_count := 1;
    let charge =
        Accounting.vaultCharge(vaultValue) +
        Accounting.nodeCharge(rootValue);
    mem.physical_private_bytes += charge;
    charge;
};

func cleanup(
    files : Service.Service
) : Types.CleanupOk {
    switch (files.cleanup()) {
        case (#ok(value)) value;
        case (#err(error)) Runtime.trap(
            "cleanup failed: " # debug_show (error)
        );
    };
};

func contentJob(
    jobId : Nat64,
    contents : [{
        content_id : Types.Id128;
        next_block_index : Nat32;
        block_count : Nat32;
    }],
) : Memory.DeleteJob {
    {
        job_id = jobId;
        kind = #contents({
            contents;
            current_content = 0;
        });
        created_at_ns = 0;
        updated_at_ns = 0;
        reclaimed_entries = 0;
        reclaimed_ciphertext_bytes = 0;
    };
};

func addBlock(
    mem : Memory.Mem,
    contentId : Types.Id128,
    index : Nat,
    body : Blob,
) : Nat {
    Map.add(
        mem.blocks,
        Keys.compareBlockKey,
        Keys.blockKey(contentId, Nat32.fromNat(index)),
        body,
    );
    let charge = Accounting.blockCharge(body.size());
    mem.physical_private_bytes += charge;
    charge;
};

func addContentJob(mem : Memory.Mem, job : Memory.DeleteJob) : Nat {
    Map.add(mem.delete_jobs, Nat64.compare, job.job_id, job);
    let charge = Accounting.cleanupJobCharge(job);
    mem.physical_private_bytes += charge;
    charge;
};

func addSingleContentJob(
    mem : Memory.Mem,
    jobId : Nat64,
    contentId : Types.Id128,
    blockCount : Nat,
    body : Blob,
) : Nat {
    var charge = 0;
    var index = 0;
    while (index < blockCount) {
        charge += addBlock(mem, contentId, index, body);
        index += 1;
    };
    charge + addContentJob(
        mem,
        contentJob(jobId, [{
            content_id = contentId;
            next_block_index = 0;
            block_count = Nat32.fromNat(blockCount);
        }]),
    );
};


func abortStage(
    stageId : Nat64,
    blockCount : Nat,
    blockBytes : Nat,
    expiresAt : Nat64,
) : Memory.PrivateStage {
    let blocks = Array.tabulate<Memory.StageBlock>(
        blockCount,
        func(index) {
            {
                content_id = Fixtures.id(
                    20_000 + Nat64.toNat(stageId) * 100 + index
                );
                block_index = 0;
                ciphertext_bytes = Nat32.fromNat(blockBytes);
                frame_ordinal = 0;
                payload_offset = Nat32.fromNat(index * blockBytes);
                payload_length = Nat32.fromNat(blockBytes);
            };
        },
    );
    let base : Memory.PrivateStage = {
        request_id = Fixtures.id(30_000 + Nat64.toNat(stageId));
        request_fingerprint = (0, 0, 0, stageId);
        created_at_ns = 0;
        last_activity_at_ns = 0;
        expires_at_ns = expiresAt;
        frame_count = 1;
        accepted_frame_bitmap = Blob.fromArray([1]);
        frame_fingerprints = [?(0, 0, 0, stageId + 1)];
        frames = [{
            ordinal = 0;
            encoded_bytes = Nat32.fromNat(blockCount * blockBytes);
            blocks;
        }];
        commit_plan = {
            intent = #batch;
            node_mutations = [];
            child_index_mutations = [];
            retired_contents = [];
            node_count_delta = #unchanged;
            committed_plaintext_delta = #unchanged;
            committed_ciphertext_delta = #unchanged;
            final_physical_bytes = 0;
        };
        accepted_ciphertext_bytes = blockCount * blockBytes;
        reserved_ciphertext_bytes = 0;
        reserved_physical_bytes = 0;
        reserved_cleanup_jobs = 0;
    };
    let reservation = Accounting.privateCommitReservation(base);
    {
        base with
        reserved_physical_bytes =
            reservation.terminal_reservation_charge;
        reserved_cleanup_jobs =
            Nat8.fromNat(reservation.cleanup_jobs);
    };
};

func installAbortStage(
    mem : Memory.Mem,
    stageId : Nat64,
    blockCount : Nat,
    blockBytes : Nat,
    expiresAt : Nat64,
) : Memory.PrivateStage {
    let stage = abortStage(
        stageId,
        blockCount,
        blockBytes,
        expiresAt,
    );
    for (frame in stage.frames.values()) {
        for (block in frame.blocks.values()) {
            ignore addBlock(
                mem,
                block.content_id,
                Nat32.toNat(block.block_index),
                Fixtures.zeros(blockBytes),
            );
        };
    };
    Map.add(
        mem.stages,
        Nat64.compare,
        stageId,
        #private_write(stage),
    );
    Map.add(
        mem.stages_by_request,
        Keys.compareId128,
        stage.request_id,
        stageId,
    );
    mem.physical_private_bytes +=
        Accounting.privateStageCharge(stage) +
        Accounting.stageRequestIndexCharge();
    mem.staged_ciphertext_bytes += stage.accepted_ciphertext_bytes;
    mem.reserved_physical_private_bytes +=
        stage.reserved_physical_bytes;
    mem.reserved_cleanup_jobs +=
        Nat8.toNat(stage.reserved_cleanup_jobs);
    stage;
};

func identityHeavyNode(
    nodeId : Types.Id128,
    contentId : Types.Id128,
) : Memory.NodeMutation {
    let node : Memory.Node = {
        parent_id = Types.ROOT_NODE_ID;
        kind = #file({
            active_content = ?{
                content_id = contentId;
                wrapped_content_key = Fixtures.zeros(48);
                block_count = 1;
                ciphertext_bytes = 17;
                crypto_profile = #aes_256_gcm_files_v2;
            };
        });
        state = #active;
        name_tag = (nodeId.hi, nodeId.lo, 0, 1);
        declared_name_scalars = 1;
        structural_revision = 1;
        metadata_revision = 1;
        children_revision = 0;
        subtree_height = 0;
        max_relative_path_scalars = 1;
        subtree_plaintext_bytes = 1;
        encrypted_metadata = Fixtures.zeros(16);
    };
    {
        node_id = nodeId;
        expected = null;
        replacement = ?node;
    };
};

func installIdentityHeavyExpiryStage(
    mem : Memory.Mem,
    stageId : Nat64,
    expiresAt : Nat64,
) : Memory.PrivateStage {
    let base = abortStage(stageId, 1, 1, expiresAt);
    let mutations = Array.tabulate<Memory.NodeMutation>(
        42,
        func(index) {
            identityHeavyNode(
                Fixtures.id(
                    60_000 +
                    Nat64.toNat(stageId) * 1_000 + index
                ),
                Fixtures.id(
                    70_000 +
                    Nat64.toNat(stageId) * 1_000 + index
                ),
            );
        },
    );
    let draft : Memory.PrivateStage = {
        base with
        commit_plan = {
            base.commit_plan with node_mutations = mutations
        };
        reserved_physical_bytes = 0;
        reserved_cleanup_jobs = 0;
    };
    let reservation = Accounting.privateCommitReservation(draft);
    let stage : Memory.PrivateStage = {
        draft with
        reserved_physical_bytes =
            reservation.terminal_reservation_charge;
        reserved_cleanup_jobs =
            Nat8.fromNat(reservation.cleanup_jobs);
    };
    for (frame in stage.frames.values()) {
        for (block in frame.blocks.values()) {
            ignore addBlock(
                mem,
                block.content_id,
                Nat32.toNat(block.block_index),
                Fixtures.zeros(1),
            );
        };
    };
    Map.add(
        mem.stages,
        Nat64.compare,
        stageId,
        #private_write(stage),
    );
    Map.add(
        mem.stages_by_request,
        Keys.compareId128,
        stage.request_id,
        stageId,
    );
    mem.physical_private_bytes +=
        Accounting.privateStageCharge(stage) +
        Accounting.stageRequestIndexCharge();
    mem.staged_ciphertext_bytes += stage.accepted_ciphertext_bytes;
    mem.reserved_physical_private_bytes +=
        stage.reserved_physical_bytes;
    mem.reserved_cleanup_jobs +=
        Nat8.toNat(stage.reserved_cleanup_jobs);
    stage;
};

func abortPrivate(
    files : Service.Service,
    stageId : Nat64,
    stage : Memory.PrivateStage,
) : Types.Result<Types.AbortOk> {
    files.abort({
        request_id = stage.request_id;
        stage_id = stageId;
    });
};

// Each retained private outcome owns a primary and an ordered-expiry row, so
// 64 outcomes exactly fill the aggregate 128-entry cleanup page.
let expiry : Nat64 = 10;
let receiptMem = Memory.init();
var firstPageCharge = 0;
var privateIndex = 1;
while (privateIndex <= 64) {
    firstPageCharge += addPrivateReceipt(
        receiptMem,
        Fixtures.id(privateIndex),
        expiry,
    );
    privateIndex += 1;
};
let finalReceiptCharge = addPrivateReceipt(
    receiptMem,
    Fixtures.id(65),
    expiry,
);
let receiptService = service(receiptMem, expiry);
let firstReceiptPage = cleanup(receiptService);
assert (
    Nat16.toNat(firstReceiptPage.reclaimed_entries) ==
    Types.MAX_CLEANUP_ENTRIES_PER_PAGE
);
assert (
    Nat64.toNat(firstReceiptPage.reclaimed_charged_bytes) ==
    firstPageCharge
);
assert (Map.size(receiptMem.private_receipts) == 1);
assert (Map.size(receiptMem.private_receipts_by_expiry) == 1);
assert (receiptMem.physical_private_bytes == finalReceiptCharge);
assert (firstReceiptPage.has_more);
let secondReceiptPage = cleanup(receiptService);
assert (secondReceiptPage.reclaimed_entries == 2);
assert (
    Nat64.toNat(secondReceiptPage.reclaimed_charged_bytes) ==
    finalReceiptCharge
);
assert (receiptMem.physical_private_bytes == 0);
assert (not secondReceiptPage.has_more);

// Two retained outcomes may name the same node. The first expiry only
// decrements the shared owner row, while the last expiry reclaims that row and
// its exact charge.
let sharedOwnerMem = Memory.init();
let sharedOwnerNode = Fixtures.id(10_000);
let sharedFirstRequest = Fixtures.id(10_001);
let sharedSecondRequest = Fixtures.id(10_002);
let sharedFirstReceipt = writeReceipt(
    sharedFirstRequest,
    10,
    [{
        node_id = sharedOwnerNode;
        content_id = null;
        structural_revision = 1;
        metadata_revision = 1;
    }],
);
let sharedSecondReceipt = writeReceipt(
    sharedSecondRequest,
    20,
    [{
        node_id = sharedOwnerNode;
        content_id = null;
        structural_revision = 2;
        metadata_revision = 2;
    }],
);
let sharedFirstBaseCharge =
    Accounting.receiptCharge(sharedFirstReceipt) +
    Accounting.privateReceiptIndexCharge();
let sharedSecondBaseCharge =
    Accounting.receiptCharge(sharedSecondReceipt) +
    Accounting.privateReceiptIndexCharge();
let ownerRowCharge = Accounting.privateReceiptIdentityRowCharge();
assert (
    installPrivateReceipt(
        sharedOwnerMem,
        sharedFirstRequest,
        sharedFirstReceipt,
    ) == sharedFirstBaseCharge + ownerRowCharge
);
assert (
    installPrivateReceipt(
        sharedOwnerMem,
        sharedSecondRequest,
        sharedSecondReceipt,
    ) == sharedSecondBaseCharge
);
let ?sharedOwnerBefore = Map.get(
    sharedOwnerMem.private_receipt_identity_owners,
    Keys.compareId128,
    sharedOwnerNode,
) else Runtime.trap("shared private receipt owner missing");
assert (sharedOwnerBefore.node_count == 2);
assert (sharedOwnerBefore.content_count == 0);

let sharedFirstPage = cleanup(service(sharedOwnerMem, 10));
assert (sharedFirstPage.reclaimed_entries == 2);
assert (
    Nat64.toNat(sharedFirstPage.reclaimed_charged_bytes) ==
    sharedFirstBaseCharge
);
assert (
    sharedOwnerMem.physical_private_bytes ==
    sharedSecondBaseCharge + ownerRowCharge
);
let ?sharedOwnerAfterFirst = Map.get(
    sharedOwnerMem.private_receipt_identity_owners,
    Keys.compareId128,
    sharedOwnerNode,
) else Runtime.trap("shared owner released before last receipt");
assert (sharedOwnerAfterFirst.node_count == 1);
assert (sharedOwnerAfterFirst.content_count == 0);

let sharedLastPage = cleanup(service(sharedOwnerMem, 20));
assert (sharedLastPage.reclaimed_entries == 3);
assert (
    Nat64.toNat(sharedLastPage.reclaimed_charged_bytes) ==
    sharedSecondBaseCharge + ownerRowCharge
);
assert (
    Map.get(
        sharedOwnerMem.private_receipt_identity_owners,
        Keys.compareId128,
        sharedOwnerNode,
    ) == null
);
assert (sharedOwnerMem.physical_private_bytes == 0);
assert (not sharedLastPage.has_more);

// The largest retained target vector owns 64 node identities and 20 distinct
// content identities. Its primary, expiry, and 84 owner rows still fit in one
// 128-entry cleanup page.
let maximumOwnerMem = Memory.init();
let maximumOwnerRequest = Fixtures.id(11_000);
let maximumOwnerNodes = Array.tabulate<Memory.PrivateReceiptNode>(
    Types.MAX_BATCH_PLAN_ENTRIES,
    func(index) {
        {
            node_id = Fixtures.id(12_000 + index);
            content_id =
                if (index < Types.MAX_BATCH_FILES) {
                    ?Fixtures.id(13_000 + index);
                } else null;
            structural_revision = 1;
            metadata_revision = 1;
        };
    },
);
let maximumOwnerReceipt = writeReceipt(
    maximumOwnerRequest,
    30,
    maximumOwnerNodes,
);
let maximumOwnerRows =
    Types.MAX_BATCH_PLAN_ENTRIES + Types.MAX_BATCH_FILES;
let maximumOwnerCharge = installPrivateReceipt(
    maximumOwnerMem,
    maximumOwnerRequest,
    maximumOwnerReceipt,
);
assert (
    Map.size(maximumOwnerMem.private_receipt_identity_owners) ==
    maximumOwnerRows
);
assert (
    maximumOwnerCharge ==
    Accounting.receiptCharge(maximumOwnerReceipt) +
    Accounting.privateReceiptIndexCharge() +
    maximumOwnerRows * ownerRowCharge
);
let maximumOwnerPage = cleanup(service(maximumOwnerMem, 30));
assert (
    Nat16.toNat(maximumOwnerPage.reclaimed_entries) ==
    maximumOwnerRows + 2
);
assert (
    Nat64.toNat(maximumOwnerPage.reclaimed_charged_bytes) ==
    maximumOwnerCharge
);
assert (Map.size(maximumOwnerMem.private_receipts) == 0);
assert (Map.size(maximumOwnerMem.private_receipts_by_expiry) == 0);
assert (
    Map.size(maximumOwnerMem.private_receipt_identity_owners) == 0
);
assert (maximumOwnerMem.physical_private_bytes == 0);
assert (not maximumOwnerPage.has_more);

// A completed job row and expired receipts consume the same aggregate row
// allowance: one block + one job row + 63 two-row receipts is exactly 128.
let aggregateMem = Memory.init();
let aggregateContent = Fixtures.id(200);
let aggregateBody = Fixtures.zeros(7);
let aggregateBlockCharge = addBlock(
    aggregateMem,
    aggregateContent,
    0,
    aggregateBody,
);
let aggregateJob = contentJob(1, [{
    content_id = aggregateContent;
    next_block_index = 0;
    block_count = 1;
}]);
let aggregateJobCharge = addContentJob(aggregateMem, aggregateJob);
var aggregateReceiptCharge = 0;
var aggregateIndex = 1;
while (aggregateIndex <= 63) {
    aggregateReceiptCharge += addPrivateReceipt(
        aggregateMem,
        Fixtures.id(300 + aggregateIndex),
        expiry,
    );
    aggregateIndex += 1;
};
let aggregatePage = cleanup(service(aggregateMem, expiry));
assert (aggregatePage.reclaimed_entries == 128);
assert (aggregatePage.reclaimed_ciphertext_bytes == 7);
assert (
    Nat64.toNat(aggregatePage.reclaimed_charged_bytes) ==
    aggregateBlockCharge + aggregateJobCharge +
        aggregateReceiptCharge
);
assert (aggregateMem.physical_private_bytes == 0);
assert (Map.size(aggregateMem.delete_jobs) == 0);
assert (not aggregatePage.has_more);

// One page advances jobs in ascending JobId order and carries one aggregate
// block budget across job boundaries.
let orderedMem = Memory.init();
let orderedBody = Fixtures.zeros(1);
ignore addSingleContentJob(
    orderedMem,
    3,
    Fixtures.id(603),
    4,
    orderedBody,
);
ignore addSingleContentJob(
    orderedMem,
    1,
    Fixtures.id(601),
    3,
    orderedBody,
);
ignore addSingleContentJob(
    orderedMem,
    2,
    Fixtures.id(602),
    4,
    orderedBody,
);
let orderedService = service(orderedMem, 0);
let orderedFirst = cleanup(orderedService);
assert (orderedFirst.reclaimed_entries == 14);
assert (orderedFirst.reclaimed_ciphertext_bytes == 11);
assert (orderedFirst.remaining_jobs == 0);
assert (not orderedFirst.has_more);
assert (
    Map.get(orderedMem.delete_jobs, Nat64.compare, (1 : Nat64)) ==
    null
);
assert (
    Map.get(orderedMem.delete_jobs, Nat64.compare, (2 : Nat64)) ==
    null
);
assert (
    Map.get(orderedMem.delete_jobs, Nat64.compare, (3 : Nat64)) ==
    null
);
assert (orderedMem.physical_private_bytes == 0);

// Ten blocks split across two valid content descriptors fit in one page.
let blockMem = Memory.init();
let contentA = Fixtures.id(400);
let contentB = Fixtures.id(401);
let smallBody = Fixtures.zeros(11);
var blockIndex = 0;
while (blockIndex < 5) {
    ignore addBlock(blockMem, contentA, blockIndex, smallBody);
    blockIndex += 1;
};
blockIndex := 0;
while (blockIndex < 5) {
    ignore addBlock(blockMem, contentB, blockIndex, smallBody);
    blockIndex += 1;
};
let tenBlockJob = contentJob(1, [
    {
        content_id = contentA;
        next_block_index = 0;
        block_count = 5;
    },
    {
        content_id = contentB;
        next_block_index = 0;
        block_count = 5;
    },
]);
ignore addContentJob(blockMem, tenBlockJob);
ignore addPrivateReceipt(blockMem, Fixtures.id(402), 0);
let blockService = service(blockMem, 0);
let tenBlockPage = cleanup(blockService);
assert (tenBlockPage.reclaimed_entries == 13);
assert (tenBlockPage.reclaimed_ciphertext_bytes == 110);
assert (not tenBlockPage.has_more);
assert (Map.size(blockMem.blocks) == 0);
assert (Map.size(blockMem.delete_jobs) == 0);
assert (Map.size(blockMem.private_receipts) == 0);
assert (blockMem.physical_private_bytes == 0);

func addNineBlockJob(
    mem : Memory.Mem,
    tailBytes : Nat,
) : Nat {
    let firstContent = Fixtures.id(500);
    let secondContent = Fixtures.id(501);
    let large = Fixtures.zeros(1_889_000);
    let tail = Fixtures.zeros(tailBytes);
    var charge = 0;
    var index = 0;
    while (index < 5) {
        charge += addBlock(mem, firstContent, index, large);
        index += 1;
    };
    index := 0;
    while (index < 3) {
        charge += addBlock(mem, secondContent, index, large);
        index += 1;
    };
    charge += addBlock(mem, secondContent, 3, tail);
    let job = contentJob(1, [
        {
            content_id = firstContent;
            next_block_index = 0;
            block_count = 5;
        },
        {
            content_id = secondContent;
            next_block_index = 0;
            block_count = 4;
        },
    ]);
    charge + addContentJob(mem, job);
};

// Rows left over from the former 16 MiB cleanup boundary now fit in the
// expanded page together with all nine blocks.
let exactByteMem = Memory.init();
let exactByteCharge = addNineBlockJob(exactByteMem, 1_665_360);
let deferredReceiptCharge = addPrivateReceipt(
    exactByteMem,
    Fixtures.id(650),
    0,
);
let exactBytePage = cleanup(service(exactByteMem, 0));
assert (exactBytePage.reclaimed_entries == 12);
assert (
    Nat64.toNat(exactBytePage.reclaimed_ciphertext_bytes) ==
    16_777_360
);
assert (
    Nat64.toNat(exactBytePage.reclaimed_charged_bytes) ==
    exactByteCharge + deferredReceiptCharge
);
assert (not exactBytePage.has_more);
assert (exactByteMem.physical_private_bytes == 0);

// One byte above the former aggregate ceiling also fits in one page.
let plusByteMem = Memory.init();
ignore addNineBlockJob(plusByteMem, 1_665_361);
let plusByteService = service(plusByteMem, 0);
let plusBytePage = cleanup(plusByteService);
assert (plusBytePage.reclaimed_entries == 10);
assert (plusBytePage.reclaimed_ciphertext_bytes == 16_777_361);
assert (Map.size(plusByteMem.blocks) == 0);
assert (Map.size(plusByteMem.delete_jobs) == 0);
assert (plusByteMem.physical_private_bytes == 0);
assert (not plusBytePage.has_more);

// The instruction sampler is deterministic in tests. Work may start one
// instruction below the ceiling, while reaching the exact ceiling (or one
// instruction beyond it) closes the aggregate page before the first job.
let belowInstructionMem = Memory.init();
ignore addSingleContentJob(
    belowInstructionMem,
    1,
    Fixtures.id(660),
    1,
    Fixtures.zeros(1),
);
let belowInstructionPage = cleanup(
    serviceWithCounter(
        belowInstructionMem,
        0,
        Types.MAX_CLEANUP_INSTRUCTIONS_PER_PAGE - 1,
    )
);
assert (belowInstructionPage.reclaimed_entries == 2);
assert (belowInstructionPage.reclaimed_ciphertext_bytes == 1);
assert (not belowInstructionPage.has_more);

let exactInstructionMem = Memory.init();
ignore addSingleContentJob(
    exactInstructionMem,
    1,
    Fixtures.id(661),
    1,
    Fixtures.zeros(1),
);
let exactInstructionPage = cleanup(
    serviceWithCounter(
        exactInstructionMem,
        0,
        Types.MAX_CLEANUP_INSTRUCTIONS_PER_PAGE,
    )
);
assert (exactInstructionPage.reclaimed_entries == 0);
assert (exactInstructionPage.reclaimed_ciphertext_bytes == 0);
assert (exactInstructionPage.has_more);
assert (Map.size(exactInstructionMem.blocks) == 1);
assert (Map.size(exactInstructionMem.delete_jobs) == 1);

let plusInstructionMem = Memory.init();
ignore addSingleContentJob(
    plusInstructionMem,
    1,
    Fixtures.id(662),
    1,
    Fixtures.zeros(1),
);
let plusInstructionPage = cleanup(
    serviceWithCounter(
        plusInstructionMem,
        0,
        Types.MAX_CLEANUP_INSTRUCTIONS_PER_PAGE + 1,
    )
);
assert (plusInstructionPage.reclaimed_entries == 0);
assert (plusInstructionPage.reclaimed_ciphertext_bytes == 0);
assert (plusInstructionPage.has_more);
assert (Map.size(plusInstructionMem.blocks) == 1);
assert (Map.size(plusInstructionMem.delete_jobs) == 1);

// Multiple simultaneously due private stages share the same aggregate page.
// Their stage rows, request indexes, accepted blocks, and ciphertext all
// consume one common set of limits.
let twoSmallStagesMem = Memory.init();
ignore installAbortStage(twoSmallStagesMem, 1, 2, 3, 0);
ignore installAbortStage(twoSmallStagesMem, 2, 3, 5, 0);
let twoSmallStagesPage = cleanup(service(twoSmallStagesMem, 0));
assert (twoSmallStagesPage.reclaimed_entries == 9);
assert (twoSmallStagesPage.reclaimed_ciphertext_bytes == 21);
assert (Map.size(twoSmallStagesMem.stages) == 0);
assert (Map.size(twoSmallStagesMem.stages_by_request) == 0);
assert (Map.size(twoSmallStagesMem.blocks) == 0);
assert (Map.size(twoSmallStagesMem.delete_jobs) == 0);
assert (Map.size(twoSmallStagesMem.private_receipts) == 2);
assert (not twoSmallStagesPage.has_more);

// A zero-job stage must be retired entirely or deferred. After a five-block
// stage, the 36-block stage cannot fit the residual budget; it
// remains intact without trapping or materializing an unreserved cleanup job.
let deferredStageMem = Memory.init();
ignore installAbortStage(deferredStageMem, 1, 5, 1, 0);
let deferredStage = installAbortStage(
    deferredStageMem,
    2,
    Types.MAX_CLEANUP_BLOCKS_PER_PAGE,
    1,
    0,
);
assert (deferredStage.reserved_cleanup_jobs == 0);
let deferredStageFirst = cleanup(service(deferredStageMem, 0));
assert (deferredStageFirst.reclaimed_entries == 7);
assert (deferredStageFirst.reclaimed_ciphertext_bytes == 5);
assert (deferredStageFirst.has_more);
assert (Map.size(deferredStageMem.stages) == 1);
assert (Map.size(deferredStageMem.stages_by_request) == 1);
assert (Map.size(deferredStageMem.blocks) == 36);
assert (Map.size(deferredStageMem.delete_jobs) == 0);
let deferredStageSecond = cleanup(service(deferredStageMem, 0));
assert (deferredStageSecond.reclaimed_entries == 38);
assert (deferredStageSecond.reclaimed_ciphertext_bytes == 36);
assert (not deferredStageSecond.has_more);
assert (Map.size(deferredStageMem.stages) == 0);
assert (Map.size(deferredStageMem.blocks) == 0);
assert (Map.size(deferredStageMem.delete_jobs) == 0);

// The ciphertext residual is inclusive across due stages. The second stage
// exactly fills the bytes left by the first and is reclaimed on the same page.
let exactStageBytesMem = Memory.init();
let firstStageBytes = 17;
let secondStageBytes =
    Types.MAX_CLEANUP_CIPHERTEXT_PER_PAGE - firstStageBytes;
ignore installAbortStage(
    exactStageBytesMem,
    1,
    1,
    firstStageBytes,
    0,
);
ignore installAbortStage(
    exactStageBytesMem,
    2,
    1,
    secondStageBytes,
    0,
);
let exactStageBytesPage = cleanup(service(exactStageBytesMem, 0));
assert (exactStageBytesPage.reclaimed_entries == 6);
assert (
    Nat64.toNat(exactStageBytesPage.reclaimed_ciphertext_bytes) ==
    Types.MAX_CLEANUP_CIPHERTEXT_PER_PAGE
);
assert (Map.size(exactStageBytesMem.stages) == 0);
assert (Map.size(exactStageBytesMem.blocks) == 0);
assert (not exactStageBytesPage.has_more);

// Stage expiry runs first, then the oldest delete job and due private receipt
// continue in the same aggregate page when all residual budgets remain open.
let stageJobReceiptMem = Memory.init();
ignore addSingleContentJob(
    stageJobReceiptMem,
    1,
    Fixtures.id(670),
    1,
    Fixtures.zeros(2),
);
let dueReceiptId = Fixtures.id(671);
ignore addPrivateReceipt(stageJobReceiptMem, dueReceiptId, 0);
ignore installAbortStage(stageJobReceiptMem, 1, 1, 3, 0);
let stageJobReceiptPage = cleanup(service(stageJobReceiptMem, 0));
assert (stageJobReceiptPage.reclaimed_entries == 7);
assert (stageJobReceiptPage.reclaimed_ciphertext_bytes == 5);
assert (Map.size(stageJobReceiptMem.stages) == 0);
assert (Map.size(stageJobReceiptMem.blocks) == 0);
assert (Map.size(stageJobReceiptMem.delete_jobs) == 0);
assert (
    Map.get(
        stageJobReceiptMem.private_receipts,
        Keys.compareId128,
        dueReceiptId,
    ) == null
);
assert (Map.size(stageJobReceiptMem.private_receipts) == 1);
assert (not stageJobReceiptPage.has_more);

// Retiring nine accepted stage blocks is fully synchronous and does not need
// a cleanup slot, even while every cleanup slot is reserved elsewhere.
let nineStageMem = Memory.init();
nineStageMem.reserved_cleanup_jobs := Types.MAX_CLEANUP_JOBS;
let nineStage = installAbortStage(
    nineStageMem,
    1,
    Types.MAX_CLEANUP_BLOCKS_PER_PAGE,
    1,
    100,
);
assert (nineStage.reserved_cleanup_jobs == 0);
switch (abortPrivate(service(nineStageMem, 0), 1, nineStage)) {
    case (#ok(value)) {
        assert (value.cleanup_state == ?#clean);
    };
    case (_) assert false;
};
assert (Map.size(nineStageMem.blocks) == 0);
assert (Map.size(nineStageMem.delete_jobs) == 0);
assert (nineStageMem.staged_ciphertext_bytes == 0);
assert (
    nineStageMem.reserved_cleanup_jobs ==
    Types.MAX_CLEANUP_JOBS
);

// The same bounded retirement runs at the exact idle-expiry boundary, but the
// operation is terminally expired rather than reported as a successful abort.
let expiredStageMem = Memory.init();
let expiredStage = installAbortStage(
    expiredStageMem,
    1,
    Types.MAX_CLEANUP_BLOCKS_PER_PAGE,
    1,
    100,
);
switch (abortPrivate(
    service(expiredStageMem, expiredStage.expires_at_ns),
    1,
    expiredStage,
)) {
    case (#err({ reason = ?#expired })) {};
    case (_) assert false;
};
assert (Map.size(expiredStageMem.stages) == 0);
assert (Map.size(expiredStageMem.stages_by_request) == 0);
assert (Map.size(expiredStageMem.blocks) == 0);
assert (Map.size(expiredStageMem.delete_jobs) == 0);
assert (expiredStageMem.staged_ciphertext_bytes == 0);
let ?expiredStageReceipt = Map.get(
    expiredStageMem.private_receipts,
    Keys.compareId128,
    expiredStage.request_id,
) else {
    assert false;
    loop {};
};
assert (expiredStageReceipt.completed_at_ns == expiredStage.expires_at_ns);
assert (
    expiredStageReceipt.expires_at_ns ==
    expiredStage.expires_at_ns + Types.RECEIPT_RETENTION_NS
);
switch (expiredStageReceipt.outcome) {
    case (#expired(value)) {
        assert (value.stage_id == 1);
        assert (value.cleanup_state == ?#clean);
        assert (value.cleanup_job_id == null);
    };
    case (_) assert false;
};

// Each identity-heavy terminal receipt touches 84 bounded ownership rows.
// Together with its block, stage/request removals, and receipt/index inserts,
// one expiry consumes 89 entry units. A second due stage therefore remains
// for the next aggregate page.
let identityExpiryMem = Memory.init();
ignore installIdentityHeavyExpiryStage(
    identityExpiryMem,
    1,
    expiry,
);
ignore installIdentityHeavyExpiryStage(
    identityExpiryMem,
    2,
    expiry,
);
let firstIdentityExpiry = cleanup(
    service(identityExpiryMem, expiry)
);
assert (firstIdentityExpiry.reclaimed_entries == 3);
assert (firstIdentityExpiry.has_more);
assert (Map.size(identityExpiryMem.stages) == 1);
assert (Map.size(identityExpiryMem.private_receipts) == 1);
assert (
    Map.size(identityExpiryMem.private_receipt_identity_owners) ==
    84
);
let secondIdentityExpiry = cleanup(
    service(identityExpiryMem, expiry)
);
assert (secondIdentityExpiry.reclaimed_entries == 3);
assert (not secondIdentityExpiry.has_more);
assert (Map.size(identityExpiryMem.stages) == 0);
assert (Map.size(identityExpiryMem.private_receipts) == 2);
assert (
    Map.size(identityExpiryMem.private_receipt_identity_owners) ==
    168
);

// A ten-block stage reserves the eighth and final available cleanup slot.
// Abort removes nine blocks synchronously and materializes only the one-block
// remainder, while seven older jobs retain deterministic priority.
let tenStageMem = Memory.init();
var contentionJobId : Nat64 = 1;
while (contentionJobId <= 7) {
    ignore addContentJob(
        tenStageMem,
        contentJob(contentionJobId, []),
    );
    contentionJobId += 1;
};
tenStageMem.next_job_id := 8;
let tenStage = installAbortStage(
    tenStageMem,
    1,
    Types.MAX_CLEANUP_BLOCKS_PER_PAGE + 1,
    1,
    100,
);
assert (tenStage.reserved_cleanup_jobs == 1);
assert (tenStageMem.reserved_cleanup_jobs == 1);
switch (abortPrivate(service(tenStageMem, 0), 1, tenStage)) {
    case (#ok(value)) {
        switch (value.cleanup_state) {
            case (?#pending({ remaining_jobs })) {
                assert (
                    Nat16.toNat(remaining_jobs) ==
                    Types.MAX_CLEANUP_JOBS
                );
            };
            case (_) assert false;
        };
    };
    case (_) assert false;
};
assert (Map.size(tenStageMem.blocks) == 1);
assert (
    Map.size(tenStageMem.delete_jobs) ==
    Types.MAX_CLEANUP_JOBS
);
assert (tenStageMem.reserved_cleanup_jobs == 0);
assert (tenStageMem.staged_ciphertext_bytes == 1);
let contentionPage = cleanup(service(tenStageMem, 0));
assert (
    Nat16.toNat(contentionPage.reclaimed_entries) ==
    Types.MAX_CLEANUP_JOBS + 1
);
assert (contentionPage.reclaimed_ciphertext_bytes == 1);
assert (contentionPage.remaining_jobs == 0);
assert (not contentionPage.has_more);
assert (Map.size(tenStageMem.blocks) == 0);
assert (tenStageMem.staged_ciphertext_bytes == 0);

// Future private receipt rows are not eligible. At the exact nanosecond
// boundary, both the primary and ordered-expiry rows are reclaimed.
let boundaryMem = Memory.init();
let boundaryBaseCharge = initializeVault(boundaryMem);
let boundaryExpiry : Nat64 = 10;
let boundaryPrivateCharge = addPrivateReceipt(
    boundaryMem,
    Fixtures.id(800),
    boundaryExpiry,
);
let boundaryCleanupCharge = boundaryPrivateCharge;
let boundaryTotal = boundaryBaseCharge + boundaryCleanupCharge;
let beforeBoundaryService = service(
    boundaryMem,
    boundaryExpiry - 1,
);
let beforeBoundary = cleanup(beforeBoundaryService);
assert (beforeBoundary.reclaimed_entries == 0);
assert (beforeBoundary.reclaimed_charged_bytes == 0);
assert (not beforeBoundary.has_more);
assert (boundaryMem.physical_private_bytes == boundaryTotal);
switch (beforeBoundaryService.bootstrap()) {
    case (#ok(value)) {
        assert (not value.value.cleanup.has_more);
    };
    case (_) assert false;
};
let atBoundaryService = service(boundaryMem, boundaryExpiry);
switch (atBoundaryService.bootstrap()) {
    case (#ok(value)) {
        assert (value.value.cleanup.has_more);
        assert (value.value.cleanup.remaining_jobs == 0);
    };
    case (_) assert false;
};
let atBoundary = cleanup(atBoundaryService);
assert (atBoundary.reclaimed_entries == 2);
assert (
    Nat64.toNat(atBoundary.reclaimed_charged_bytes) ==
    boundaryCleanupCharge
);
assert (atBoundary.remaining_jobs == 0);
assert (not atBoundary.has_more);
assert (Map.size(boundaryMem.private_receipts) == 0);
assert (
    boundaryMem.physical_private_bytes ==
    boundaryBaseCharge
);

// Selection validates the job key before touching unrelated expired rows.
let corruptMem = Memory.init();
let corruptJob : Memory.DeleteJob = {
    contentJob(2, []) with job_id = 2
};
Map.add(
    corruptMem.delete_jobs,
    Nat64.compare,
    (1 : Nat64),
    corruptJob,
);
corruptMem.physical_private_bytes +=
    Accounting.cleanupJobCharge(corruptJob);
ignore addPrivateReceipt(corruptMem, Fixtures.id(900), expiry);
let beforeCorrupt = corruptMem.physical_private_bytes;
switch (service(corruptMem, expiry).cleanup()) {
    case (#err({ reason = ?#corrupt_state })) {};
    case (_) assert false;
};
assert (corruptMem.physical_private_bytes == beforeCorrupt);
assert (Map.size(corruptMem.private_receipts) == 1);
assert (Map.size(corruptMem.private_receipts_by_expiry) == 1);
