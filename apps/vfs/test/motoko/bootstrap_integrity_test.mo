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
import Service "../../backend/files/Service";
import Types "../../backend/files/Types";
import Fixtures "Fixtures";

let SOURCE_NODE_ID = Fixtures.id(10);
let SOURCE_CONTENT_ID = Fixtures.id(11);
let SOURCE_NAME_TAG : Memory.Tag256 = (0, 0, 0, 10);
let FUTURE : Nat64 = 10_000;
let PLANNED_PLAINTEXT_BYTES =
    Types.MAX_PLAINTEXT_BLOCK_BYTES + 1;
let PLANNED_CIPHERTEXT_BYTES =
    Types.MAX_PLAINTEXT_BLOCK_BYTES + 33;

func rootNode() : Memory.Node {
    {
        parent_id = Types.ROOT_NODE_ID;
        kind = #folder({
            direct_child_count = 1;
            child_subtree_heights = [{ value = 0; count = 1 }];
            child_relative_path_scalars = [{ value = 1; count = 1 }];
        });
        state = #active;
        name_tag = Types.ZERO_TAG;
        declared_name_scalars = 0;
        structural_revision = 2;
        metadata_revision = 1;
        children_revision = 1;
        subtree_height = 1;
        max_relative_path_scalars = 1;
        subtree_plaintext_bytes = 1;
        encrypted_metadata = Fixtures.zeros(16);
    };
};

func fileNode(
    contentId : Types.Id128,
    nameTag : Memory.Tag256,
) : Memory.Node {
    {
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
        name_tag = nameTag;
        declared_name_scalars = 1;
        structural_revision = 1;
        metadata_revision = 1;
        children_revision = 0;
        subtree_height = 0;
        max_relative_path_scalars = 1;
        subtree_plaintext_bytes = 1;
        encrypted_metadata = Fixtures.zeros(16);
    };
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

func initializedMemory() : Memory.Mem {
    let mem = Memory.init();
    let root = rootNode();
    let source = fileNode(SOURCE_CONTENT_ID, SOURCE_NAME_TAG);
    let sourceBody = Fixtures.zeros(17);
    mem.vault := ?vault();
    Map.add(
        mem.nodes_by_id,
        Keys.compareId128,
        Types.ROOT_NODE_ID,
        root,
    );
    Map.add(
        mem.nodes_by_id,
        Keys.compareId128,
        SOURCE_NODE_ID,
        source,
    );
    Map.add(
        mem.children_by_name,
        Keys.compareChildNameKey,
        Keys.childNameKey(Types.ROOT_NODE_ID, SOURCE_NAME_TAG),
        SOURCE_NODE_ID,
    );
    Map.add(
        mem.blocks,
        Keys.compareBlockKey,
        Keys.blockKey(SOURCE_CONTENT_ID, 0),
        sourceBody,
    );
    mem.node_count := 2;
    mem.committed_private_plaintext_bytes := 1;
    mem.committed_ciphertext_bytes := 17;
    mem.physical_private_bytes :=
        Accounting.vaultCharge(vault()) +
        Accounting.nodeCharge(root) +
        Accounting.nodeCharge(source) +
        Accounting.childIndexCharge() +
        Accounting.blockCharge(sourceBody.size());
    mem;
};

func incrementReceiptOwner(
    mem : Memory.Mem,
    id : Types.Id128,
    node : Bool,
) : Bool {
    let current : Memory.PrivateReceiptIdentityOwner = switch (
        Map.get(
            mem.private_receipt_identity_owners,
            Keys.compareId128,
            id,
        )
    ) {
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
    current.node_count == 0 and current.content_count == 0;
};

func receiptOwner(
    nodes : Nat,
    contents : Nat,
) : Memory.PrivateReceiptIdentityOwner {
    {
        node_count = Nat16.fromNat(nodes);
        content_count = Nat16.fromNat(contents);
    };
};

func addRetainedWriteReceipt(
    mem : Memory.Mem,
    requestId : Types.Id128,
    nodeId : Types.Id128,
    contentId : Types.Id128,
) : Memory.PrivateReceipt {
    let receipt : Memory.PrivateReceipt = {
        request_fingerprint = (0, 0, 8, requestId.lo);
        outcome = #write({
            request_id = requestId;
            stage_id = ?1;
            frame_ordinal = 0;
            accepted_frames_bitmap = 1;
            frame_fingerprints = [(0, 0, 7, requestId.lo)];
            nodes = [{
                node_id = nodeId;
                content_id = ?contentId;
                structural_revision = 1;
                metadata_revision = 1;
            }];
            cleanup_state = null;
        });
        completed_at_ns = 1;
        terminal_kind = null;
        expires_at_ns = FUTURE;
    };
    Map.add(
        mem.private_receipts,
        Keys.compareId128,
        requestId,
        receipt,
    );
    Map.add(
        mem.private_receipts_by_expiry,
        Keys.comparePrivateReceiptExpiryKey,
        (FUTURE, requestId.hi, requestId.lo),
        (),
    );
    var newRows = 0;
    if (incrementReceiptOwner(mem, nodeId, true)) {
        newRows += 1;
    };
    if (incrementReceiptOwner(mem, contentId, false)) {
        newRows += 1;
    };
    mem.physical_private_bytes +=
        Accounting.receiptCharge(receipt) +
        Accounting.privateReceiptIndexCharge() +
        newRows * Accounting.privateReceiptIdentityRowCharge();
    receipt;
};

func assertCorrupt(mem : Memory.Mem) {
    let service = Service.Service(
        mem,
        Fixtures.assets(Fixtures.zeroUsage()),
        func() : Nat64 { 1 },
    );
    switch (service.bootstrap()) {
        case (#err({ reason = ?#corrupt_state })) {};
        case (other) Runtime.trap(
            "expected corrupt bootstrap: " # debug_show (other)
        );
    };
};

func assertBootstrapOk(mem : Memory.Mem, activeCount : Nat) {
    let service = Service.Service(
        mem,
        Fixtures.assets(Fixtures.zeroUsage()),
        func() : Nat64 { 1 },
    );
    switch (service.bootstrap()) {
        case (#ok(value)) {
            if (value.value.active_operations.size() != activeCount) {
                Runtime.trap(
                    "unexpected active-operation count: " #
                    debug_show (value.value.active_operations)
                );
            };
        };
        case (#err(error)) Runtime.trap(
            "valid bootstrap rejected: " # debug_show (error)
        );
    };
};

func plannedNode(stageId : Nat64, contentId : Types.Id128) : Memory.Node {
    let base = fileNode(contentId, (0, 0, 1, stageId));
    {
        base with
        kind = #file({
            active_content = ?{
                content_id = contentId;
                wrapped_content_key = Fixtures.zeros(48);
                block_count = 2;
                ciphertext_bytes = PLANNED_CIPHERTEXT_BYTES;
                crypto_profile = #aes_256_gcm_files_v2;
            };
        });
        subtree_plaintext_bytes = PLANNED_PLAINTEXT_BYTES;
    };
};

func rootWithCreatedNode(node : Memory.Node) : Memory.Node {
    let root = rootNode();
    {
        root with
        kind = #folder({
            direct_child_count = 2;
            child_subtree_heights = [{ value = 0; count = 2 }];
            child_relative_path_scalars = [{ value = 1; count = 2 }];
        });
        structural_revision = root.structural_revision + 1;
        children_revision = root.children_revision + 1;
        subtree_plaintext_bytes =
            root.subtree_plaintext_bytes +
            node.subtree_plaintext_bytes;
    };
};

func privateStage(
    stageId : Nat64,
    requestId : Types.Id128,
) : Memory.PrivateStage {
    let targetNodeId = Fixtures.id(1_000 + Nat64.toNat(stageId));
    let contentId = Fixtures.id(2_000 + Nat64.toNat(stageId));
    let node = plannedNode(stageId, contentId);
    let draft : Memory.PrivateStage = {
        request_id = requestId;
        request_fingerprint = (0, 0, 2, stageId);
        created_at_ns = 1;
        last_activity_at_ns = 1;
        expires_at_ns = FUTURE;
        frame_count = 2;
        accepted_frame_bitmap = Blob.fromArray([1]);
        frame_fingerprints = [?(0, 0, 3, stageId), null];
        frames = [
            {
                ordinal = 0;
                encoded_bytes = 17;
                blocks = [{
                    content_id = contentId;
                    block_index = 0;
                    ciphertext_bytes = 17;
                    frame_ordinal = 0;
                    payload_offset = 0;
                    payload_length = 17;
                }];
            },
            {
                ordinal = 1;
                encoded_bytes = Nat32.fromNat(
                    Types.MAX_PLAINTEXT_BLOCK_BYTES + 16
                );
                blocks = [{
                    content_id = contentId;
                    block_index = 1;
                    ciphertext_bytes = Nat32.fromNat(
                        Types.MAX_PLAINTEXT_BLOCK_BYTES + 16
                    );
                    frame_ordinal = 1;
                    payload_offset = 0;
                    payload_length = Nat32.fromNat(
                        Types.MAX_PLAINTEXT_BLOCK_BYTES + 16
                    );
                }];
            },
        ];
        commit_plan = {
            intent = #create;
            node_mutations = [
                {
                    node_id = Types.ROOT_NODE_ID;
                    expected = ?rootNode();
                    replacement = ?rootWithCreatedNode(node);
                },
                {
                    node_id = targetNodeId;
                    expected = null;
                    replacement = ?node;
                },
            ];
            child_index_mutations = [{
                key = Keys.childNameKey(
                    Types.ROOT_NODE_ID,
                    node.name_tag,
                );
                expected = null;
                replacement = ?targetNodeId;
            }];
            retired_contents = [];
            node_count_delta = #increase(1);
            committed_plaintext_delta =
                #increase(PLANNED_PLAINTEXT_BYTES);
            committed_ciphertext_delta = #increase(
                PLANNED_CIPHERTEXT_BYTES + 16
            );
            final_physical_bytes = 0;
        };
        accepted_ciphertext_bytes = 17;
        reserved_ciphertext_bytes =
            Types.MAX_PLAINTEXT_BLOCK_BYTES + 16;
        reserved_physical_bytes = 0;
        reserved_cleanup_jobs = 0;
    };
    let reservation = Accounting.privateCommitReservation(draft);
    let consumed =
        reservation.current_stage_charge +
        Accounting.blockCharge(17);
    assert reservation.peak_reservation_charge >= consumed;
    {
        draft with
        reserved_physical_bytes =
            reservation.peak_reservation_charge - consumed;
    };
};

func installPrivate(
    mem : Memory.Mem,
    stageId : Nat64,
    requestId : Types.Id128,
) : Memory.PrivateStage {
    let stage = privateStage(stageId, requestId);
    let accepted = stage.frames[0].blocks[0];
    let body = Fixtures.zeros(Nat32.toNat(accepted.ciphertext_bytes));
    Map.add(
        mem.blocks,
        Keys.compareBlockKey,
        Keys.blockKey(accepted.content_id, accepted.block_index),
        body,
    );
    Map.add(
        mem.stages,
        Nat64.compare,
        stageId,
        #private_write(stage),
    );
    Map.add(
        mem.stages_by_request,
        Keys.compareId128,
        requestId,
        stageId,
    );
    mem.staged_ciphertext_bytes += stage.accepted_ciphertext_bytes;
    mem.reserved_staged_ciphertext_bytes +=
        stage.reserved_ciphertext_bytes;
    mem.reserved_physical_private_bytes +=
        stage.reserved_physical_bytes;
    mem.physical_private_bytes +=
        Accounting.blockCharge(body.size()) +
        Accounting.privateStageCharge(stage) +
        Accounting.stageRequestIndexCharge();
    if (stageId >= mem.next_stage_id) {
        mem.next_stage_id := stageId + 1;
    };
    stage;
};

func installCleanupJob(
    mem : Memory.Mem,
    job : Memory.DeleteJob,
) {
    Map.add(mem.delete_jobs, Nat64.compare, job.job_id, job);
    mem.physical_private_bytes +=
        Accounting.cleanupJobCharge(job);
    if (job.job_id >= mem.next_job_id) {
        mem.next_job_id := job.job_id + 1;
    };
};

type PrivateFixture = {
    mem : Memory.Mem;
    stage_id : Nat64;
    stage : Memory.PrivateStage;
};

func privateFixture(request : Nat) : PrivateFixture {
    let mem = initializedMemory();
    let stageId : Nat64 = 1;
    let stage = installPrivate(
        mem,
        stageId,
        Fixtures.id(request),
    );
    { mem; stage_id = stageId; stage };
};

func replacePrivateStage(
    fixture : PrivateFixture,
    stage : Memory.PrivateStage,
) {
    Map.add(
        fixture.mem.stages,
        Nat64.compare,
        fixture.stage_id,
        #private_write(stage),
    );
};

func exactPrivateReservation(
    stage : Memory.PrivateStage
) : Memory.PrivateStage {
    let draft : Memory.PrivateStage = {
        stage with reserved_physical_bytes = 0
    };
    var acceptedBlockCharge = 0;
    var frameIndex = 0;
    while (frameIndex < draft.frames.size()) {
        switch (draft.frame_fingerprints[frameIndex]) {
            case null {};
            case (?_) {
                for (block in draft.frames[frameIndex].blocks.values()) {
                    acceptedBlockCharge += Accounting.blockCharge(
                        Nat32.toNat(block.ciphertext_bytes)
                    );
                };
            };
        };
        frameIndex += 1;
    };
    let reservation = Accounting.privateCommitReservation(draft);
    let consumed =
        reservation.current_stage_charge + acceptedBlockCharge;
    assert reservation.peak_reservation_charge >= consumed;
    {
        draft with
        reserved_physical_bytes =
            reservation.peak_reservation_charge - consumed;
    };
};

func replacePrivateStageExact(
    fixture : PrivateFixture,
    stage : Memory.PrivateStage,
) : Memory.PrivateStage {
    let ?#private_write(oldStage) = Map.get(
        fixture.mem.stages,
        Nat64.compare,
        fixture.stage_id,
    ) else Runtime.trap("missing private fixture stage");
    let exact = exactPrivateReservation(stage);
    let oldCharge = Accounting.privateStageCharge(oldStage);
    assert fixture.mem.physical_private_bytes >= oldCharge;
    fixture.mem.physical_private_bytes :=
        fixture.mem.physical_private_bytes - oldCharge +
        Accounting.privateStageCharge(exact);
    assert (
        fixture.mem.reserved_physical_private_bytes >=
        oldStage.reserved_physical_bytes
    );
    fixture.mem.reserved_physical_private_bytes :=
        fixture.mem.reserved_physical_private_bytes -
        oldStage.reserved_physical_bytes +
        exact.reserved_physical_bytes;
    replacePrivateStage(fixture, exact);
    exact;
};

func replaceFixture(request : Nat) : PrivateFixture {
    let fixture = privateFixture(request);
    let rootExpected = rootNode();
    let sourceExpected =
        fileNode(SOURCE_CONTENT_ID, SOURCE_NAME_TAG);
    let ?sourceContent = switch (sourceExpected.kind) {
        case (#file(file)) file.active_content;
        case (#folder(_)) null;
    } else Runtime.trap("missing source content");
    let targetMutation =
        fixture.stage.commit_plan.node_mutations[1];
    let ?planned = targetMutation.replacement else {
        Runtime.trap("missing planned replacement")
    };
    let sourceReplacement : Memory.Node = {
        planned with
        parent_id = sourceExpected.parent_id;
        name_tag = sourceExpected.name_tag;
        declared_name_scalars =
            sourceExpected.declared_name_scalars;
        structural_revision =
            sourceExpected.structural_revision + 1;
        metadata_revision =
            sourceExpected.metadata_revision + 1;
    };
    let rootReplacement : Memory.Node = {
        rootExpected with
        structural_revision =
            rootExpected.structural_revision + 1;
        subtree_plaintext_bytes = PLANNED_PLAINTEXT_BYTES;
    };
    let plan : Memory.PrivateCommitPlan = {
        intent = #replace;
        node_mutations = [
            {
                node_id = Types.ROOT_NODE_ID;
                expected = ?rootExpected;
                replacement = ?rootReplacement;
            },
            {
                node_id = SOURCE_NODE_ID;
                expected = ?sourceExpected;
                replacement = ?sourceReplacement;
            },
        ];
        child_index_mutations = [];
        retired_contents = [{
            node_id = SOURCE_NODE_ID;
            content = sourceContent;
        }];
        node_count_delta = #unchanged;
        committed_plaintext_delta = #increase(
            PLANNED_PLAINTEXT_BYTES - 1
        );
        committed_ciphertext_delta = #increase(
            PLANNED_CIPHERTEXT_BYTES - 17
        );
        final_physical_bytes = 0;
    };
    let exact = replacePrivateStageExact(
        fixture,
        {
            fixture.stage with
            commit_plan = plan;
        },
    );
    {
        fixture with
        stage = exact;
    };
};


// The complete graph at each legal per-kind maximum must remain bootstrappable.
assertBootstrapOk(initializedMemory(), 0);
let validPrivate = initializedMemory();
ignore installPrivate(validPrivate, 1, Fixtures.id(201));
assertBootstrapOk(validPrivate, 1);
let validMaximum = initializedMemory();
ignore installPrivate(validMaximum, 1, Fixtures.id(211));
ignore installPrivate(validMaximum, 2, Fixtures.id(212));
assertBootstrapOk(validMaximum, 2);

// The private active-stage ceiling is exact.
let excessPrivate = initializedMemory();
ignore installPrivate(excessPrivate, 1, Fixtures.id(221));
ignore installPrivate(excessPrivate, 2, Fixtures.id(222));
ignore installPrivate(excessPrivate, 3, Fixtures.id(223));
assertCorrupt(excessPrivate);

// stages_by_request is an exact bidirectional index, not a best-effort hint.
let missingReverse = initializedMemory();
let missingStage = installPrivate(
    missingReverse,
    1,
    Fixtures.id(241),
);
ignore Map.remove(
    missingReverse.stages_by_request,
    Keys.compareId128,
    missingStage.request_id,
);
assertCorrupt(missingReverse);

let danglingReverse = initializedMemory();
Map.add(
    danglingReverse.stages_by_request,
    Keys.compareId128,
    Fixtures.id(242),
    (1 : Nat64),
);
assertCorrupt(danglingReverse);

let swappedReverse = initializedMemory();
let swappedFirst = installPrivate(
    swappedReverse,
    1,
    Fixtures.id(243),
);
let swappedSecond = installPrivate(
    swappedReverse,
    2,
    Fixtures.id(244),
);
Map.add(
    swappedReverse.stages_by_request,
    Keys.compareId128,
    swappedFirst.request_id,
    (2 : Nat64),
);
Map.add(
    swappedReverse.stages_by_request,
    Keys.compareId128,
    swappedSecond.request_id,
    (1 : Nat64),
);
assertCorrupt(swappedReverse);

// Server-assigned identifiers are nonzero and strictly below their checked
// next-counter. Request and target identifiers also cannot use the root zero.
let zeroStageId = initializedMemory();
ignore installPrivate(zeroStageId, 0, Fixtures.id(251));
assertCorrupt(zeroStageId);

let stageAtCounter = initializedMemory();
ignore installPrivate(stageAtCounter, 1, Fixtures.id(252));
stageAtCounter.next_stage_id := 1;
assertCorrupt(stageAtCounter);

let zeroRequestId = initializedMemory();
ignore installPrivate(zeroRequestId, 1, Types.ROOT_NODE_ID);
assertCorrupt(zeroRequestId);

let zeroNextStage = initializedMemory();
zeroNextStage.next_stage_id := 0;
assertCorrupt(zeroNextStage);

// A private active-operation plan must be nonempty and canonical. The derived
// root row is authoritative, while a file target and content identifier may
// never use the root identifier.
let emptyPrivateTarget = initializedMemory();
let emptyPrivateStage = installPrivate(
    emptyPrivateTarget,
    1,
    Fixtures.id(261),
);
Map.add(
    emptyPrivateTarget.stages,
    Nat64.compare,
    (1 : Nat64),
    #private_write({
        emptyPrivateStage with
        commit_plan = {
            emptyPrivateStage.commit_plan with
            node_mutations = ([] : [Memory.NodeMutation]);
        };
    }),
);
assertCorrupt(emptyPrivateTarget);

let rootPrivateTarget = initializedMemory();
let rootTargetStage = installPrivate(
    rootPrivateTarget,
    1,
    Fixtures.id(262),
);
let rootMutation : Memory.NodeMutation = {
    rootTargetStage.commit_plan.node_mutations[1] with
    node_id = Types.ROOT_NODE_ID;
};
Map.add(
    rootPrivateTarget.stages,
    Nat64.compare,
    (1 : Nat64),
    #private_write({
        rootTargetStage with
        commit_plan = {
            rootTargetStage.commit_plan with
            node_mutations = [
                rootTargetStage.commit_plan.node_mutations[0],
                rootMutation,
            ];
        };
    }),
);
assertCorrupt(rootPrivateTarget);

let rootContentTarget = initializedMemory();
let rootContentStage = installPrivate(
    rootContentTarget,
    1,
    Fixtures.id(263),
);
let originalMutation = rootContentStage.commit_plan.node_mutations[1];
let ?originalReplacement = originalMutation.replacement else {
    assert false;
    loop {};
};
let rootContentNode = plannedNode(1, Types.ROOT_NODE_ID);
let rootContentReplacement : Memory.Node = {
    rootContentNode with
    parent_id = originalReplacement.parent_id;
    name_tag = originalReplacement.name_tag;
};
let rootContentMutation : Memory.NodeMutation = {
    originalMutation with
    replacement = ?rootContentReplacement;
};
Map.add(
    rootContentTarget.stages,
    Nat64.compare,
    (1 : Nat64),
    #private_write({
        rootContentStage with
        commit_plan = {
            rootContentStage.commit_plan with
            node_mutations = [
                rootContentStage.commit_plan.node_mutations[0],
                rootContentMutation,
            ];
        };
    }),
);
assertCorrupt(rootContentTarget);

let unorderedPrivateTarget = initializedMemory();
let unorderedStage = installPrivate(
    unorderedPrivateTarget,
    1,
    Fixtures.id(264),
);
let lowMutation = unorderedStage.commit_plan.node_mutations[0];
let highMutation = unorderedStage.commit_plan.node_mutations[1];
Map.add(
    unorderedPrivateTarget.stages,
    Nat64.compare,
    (1 : Nat64),
    #private_write({
        unorderedStage with
        commit_plan = {
            unorderedStage.commit_plan with
            node_mutations = [highMutation, lowMutation];
        };
    }),
);
assertCorrupt(unorderedPrivateTarget);

let duplicatePrivateTarget = privateFixture(2_065);
let duplicatedTargetMutation =
    duplicatePrivateTarget.stage.commit_plan.node_mutations[1];
ignore replacePrivateStageExact(
    duplicatePrivateTarget,
    {
        duplicatePrivateTarget.stage with
        commit_plan = {
            duplicatePrivateTarget.stage.commit_plan with
            node_mutations = [
                duplicatePrivateTarget.stage.commit_plan.node_mutations[0],
                duplicatedTargetMutation,
                duplicatedTargetMutation,
            ];
        };
    },
);
assertCorrupt(duplicatePrivateTarget.mem);

let nullReplacement = privateFixture(2_066);
let nullTarget : Memory.NodeMutation = {
    nullReplacement.stage.commit_plan.node_mutations[1] with
    replacement = null;
};
ignore replacePrivateStageExact(
    nullReplacement,
    {
        nullReplacement.stage with
        commit_plan = {
            nullReplacement.stage.commit_plan with
            node_mutations = [
                nullReplacement.stage.commit_plan.node_mutations[0],
                nullTarget,
            ];
        };
    },
);
assertCorrupt(nullReplacement.mem);

let oversizedReplacementMetadata = privateFixture(2_067);
let replacementMetadataMutation =
    oversizedReplacementMetadata.stage.commit_plan.node_mutations[1];
let ?replacementMetadataNode =
    replacementMetadataMutation.replacement else {
        Runtime.trap("missing replacement metadata node")
    };
ignore replacePrivateStageExact(
    oversizedReplacementMetadata,
    {
        oversizedReplacementMetadata.stage with
        commit_plan = {
            oversizedReplacementMetadata.stage.commit_plan with
            node_mutations = [
                oversizedReplacementMetadata.stage.commit_plan.node_mutations[
                    0
                ],
                {
                    replacementMetadataMutation with
                    replacement = ?{
                        replacementMetadataNode with
                        encrypted_metadata =
                            Fixtures.zeros(
                                Types.MAX_METADATA_BYTES + 1
                            );
                    };
                },
            ];
        };
    },
);
assertCorrupt(oversizedReplacementMetadata.mem);

let oversizedExpectedMetadata = privateFixture(2_068);
let expectedMetadataMutation =
    oversizedExpectedMetadata.stage.commit_plan.node_mutations[0];
let ?expectedMetadataNode =
    expectedMetadataMutation.expected else {
        Runtime.trap("missing expected metadata node")
    };
ignore replacePrivateStageExact(
    oversizedExpectedMetadata,
    {
        oversizedExpectedMetadata.stage with
        commit_plan = {
            oversizedExpectedMetadata.stage.commit_plan with
            node_mutations = [
                {
                    expectedMetadataMutation with
                    expected = ?{
                        expectedMetadataNode with
                        encrypted_metadata =
                            Fixtures.zeros(
                                Types.MAX_METADATA_BYTES + 1
                            );
                    };
                },
                oversizedExpectedMetadata.stage.commit_plan.node_mutations[
                    1
                ],
            ];
        };
    },
);
assertCorrupt(oversizedExpectedMetadata.mem);

let oversizedReplacementFolder = privateFixture(2_069);
let replacementFolderMutation =
    oversizedReplacementFolder.stage.commit_plan.node_mutations[0];
let ?replacementFolderNode =
    replacementFolderMutation.replacement else {
        Runtime.trap("missing replacement folder node")
    };
let #folder(replacementFolder) = replacementFolderNode.kind else {
    Runtime.trap("replacement is not a folder")
};
ignore replacePrivateStageExact(
    oversizedReplacementFolder,
    {
        oversizedReplacementFolder.stage with
        commit_plan = {
            oversizedReplacementFolder.stage.commit_plan with
            node_mutations = [
                {
                    replacementFolderMutation with
                    replacement = ?{
                        replacementFolderNode with
                        kind = #folder({
                            replacementFolder with
                            child_subtree_heights =
                                Array.tabulate<Memory.HeightCount>(
                                    Nat8.toNat(
                                        Types.MAX_TREE_DEPTH
                                    ) + 1,
                                    func(index) {
                                        {
                                            value = Nat8.fromNat(index);
                                            count = 1;
                                        }
                                    },
                                );
                        });
                    };
                },
                oversizedReplacementFolder.stage.commit_plan.node_mutations[
                    1
                ],
            ];
        };
    },
);
assertCorrupt(oversizedReplacementFolder.mem);

let oversizedExpectedFolder = privateFixture(2_070);
let expectedFolderMutation =
    oversizedExpectedFolder.stage.commit_plan.node_mutations[0];
let ?expectedFolderNode = expectedFolderMutation.expected else {
    Runtime.trap("missing expected folder node")
};
let #folder(expectedFolder) = expectedFolderNode.kind else {
    Runtime.trap("expected node is not a folder")
};
ignore replacePrivateStageExact(
    oversizedExpectedFolder,
    {
        oversizedExpectedFolder.stage with
        commit_plan = {
            oversizedExpectedFolder.stage.commit_plan with
            node_mutations = [
                {
                    expectedFolderMutation with
                    expected = ?{
                        expectedFolderNode with
                        kind = #folder({
                            expectedFolder with
                            child_relative_path_scalars =
                                Array.tabulate<Memory.PathScalarCount>(
                                    Nat16.toNat(
                                        Types.MAX_PATH_SCALARS
                                    ) + 1,
                                    func(index) {
                                        {
                                            value = Nat16.fromNat(index);
                                            count = 1;
                                        }
                                    },
                                );
                        });
                    };
                },
                oversizedExpectedFolder.stage.commit_plan.node_mutations[
                    1
                ],
            ];
        };
    },
);
assertCorrupt(oversizedExpectedFolder.mem);

let duplicateChildKeys = privateFixture(2_071);
let childMutation =
    duplicateChildKeys.stage.commit_plan.child_index_mutations[0];
ignore replacePrivateStageExact(
    duplicateChildKeys,
    {
        duplicateChildKeys.stage with
        commit_plan = {
            duplicateChildKeys.stage.commit_plan with
            child_index_mutations = [childMutation, childMutation];
        };
    },
);
assertCorrupt(duplicateChildKeys.mem);

let unorderedChildKeys = privateFixture(2_072);
let lowChild =
    unorderedChildKeys.stage.commit_plan.child_index_mutations[0];
let highChild : Memory.ChildIndexMutation = {
    lowChild with
    key = Keys.childNameKey(
        Types.ROOT_NODE_ID,
        (0, 0, 9, 9),
    );
};
ignore replacePrivateStageExact(
    unorderedChildKeys,
    {
        unorderedChildKeys.stage with
        commit_plan = {
            unorderedChildKeys.stage.commit_plan with
            child_index_mutations = [highChild, lowChild];
        };
    },
);
assertCorrupt(unorderedChildKeys.mem);

let missingChildMapping = privateFixture(2_073);
ignore replacePrivateStageExact(
    missingChildMapping,
    {
        missingChildMapping.stage with
        commit_plan = {
            missingChildMapping.stage.commit_plan with
            child_index_mutations = [];
        };
    },
);
assertCorrupt(missingChildMapping.mem);

let wrongChildMapping = privateFixture(2_074);
let wrongChild =
    wrongChildMapping.stage.commit_plan.child_index_mutations[0];
ignore replacePrivateStageExact(
    wrongChildMapping,
    {
        wrongChildMapping.stage with
        commit_plan = {
            wrongChildMapping.stage.commit_plan with
            child_index_mutations = [{
                wrongChild with
                replacement = ?SOURCE_NODE_ID;
            }];
        };
    },
);
assertCorrupt(wrongChildMapping.mem);

let nodeDeltaHigh = privateFixture(2_075);
ignore replacePrivateStageExact(
    nodeDeltaHigh,
    {
        nodeDeltaHigh.stage with
        commit_plan = {
            nodeDeltaHigh.stage.commit_plan with
            node_count_delta = #increase(2);
        };
    },
);
assertCorrupt(nodeDeltaHigh.mem);

let nodeDeltaLow = privateFixture(2_076);
ignore replacePrivateStageExact(
    nodeDeltaLow,
    {
        nodeDeltaLow.stage with
        commit_plan = {
            nodeDeltaLow.stage.commit_plan with
            node_count_delta = #unchanged;
        };
    },
);
assertCorrupt(nodeDeltaLow.mem);

let plaintextDeltaHigh = privateFixture(2_077);
ignore replacePrivateStageExact(
    plaintextDeltaHigh,
    {
        plaintextDeltaHigh.stage with
        commit_plan = {
            plaintextDeltaHigh.stage.commit_plan with
            committed_plaintext_delta =
                #increase(PLANNED_PLAINTEXT_BYTES + 1);
        };
    },
);
assertCorrupt(plaintextDeltaHigh.mem);

let plaintextDeltaLow = privateFixture(2_078);
ignore replacePrivateStageExact(
    plaintextDeltaLow,
    {
        plaintextDeltaLow.stage with
        commit_plan = {
            plaintextDeltaLow.stage.commit_plan with
            committed_plaintext_delta =
                #increase(PLANNED_PLAINTEXT_BYTES - 1);
        };
    },
);
assertCorrupt(plaintextDeltaLow.mem);

let ciphertextDeltaHigh = privateFixture(2_079);
ignore replacePrivateStageExact(
    ciphertextDeltaHigh,
    {
        ciphertextDeltaHigh.stage with
        commit_plan = {
            ciphertextDeltaHigh.stage.commit_plan with
            committed_ciphertext_delta = #increase(
                PLANNED_CIPHERTEXT_BYTES + 17
            );
        };
    },
);
assertCorrupt(ciphertextDeltaHigh.mem);

let ciphertextDeltaLow = privateFixture(2_080);
ignore replacePrivateStageExact(
    ciphertextDeltaLow,
    {
        ciphertextDeltaLow.stage with
        commit_plan = {
            ciphertextDeltaLow.stage.commit_plan with
            committed_ciphertext_delta = #increase(
                PLANNED_CIPHERTEXT_BYTES + 15
            );
        };
    },
);
assertCorrupt(ciphertextDeltaLow.mem);

let validReplace = replaceFixture(2_081);
assertBootstrapOk(validReplace.mem, 1);

let missingRetirement = replaceFixture(2_082);
ignore replacePrivateStageExact(
    missingRetirement,
    {
        missingRetirement.stage with
        commit_plan = {
            missingRetirement.stage.commit_plan with
            retired_contents = [];
        };
    },
);
assertCorrupt(missingRetirement.mem);

let duplicateRetirement = replaceFixture(2_083);
let retirement =
    duplicateRetirement.stage.commit_plan.retired_contents[0];
ignore replacePrivateStageExact(
    duplicateRetirement,
    {
        duplicateRetirement.stage with
        commit_plan = {
            duplicateRetirement.stage.commit_plan with
            retired_contents = [retirement, retirement];
        };
    },
);
assertCorrupt(duplicateRetirement.mem);

let wrongRetirement = replaceFixture(2_084);
let wrongRetired =
    wrongRetirement.stage.commit_plan.retired_contents[0];
ignore replacePrivateStageExact(
    wrongRetirement,
    {
        wrongRetirement.stage with
        commit_plan = {
            wrongRetirement.stage.commit_plan with
            retired_contents = [{
                wrongRetired with
                node_id = Fixtures.id(99_084);
            }];
        };
    },
);
assertCorrupt(wrongRetirement.mem);

let oversizedBatchPlaintext = privateFixture(2_085);
let batchTargetMutation =
    oversizedBatchPlaintext.stage.commit_plan.node_mutations[1];
let ?batchTargetNode = batchTargetMutation.replacement else {
    Runtime.trap("missing batch target")
};
let #file(batchFile) = batchTargetNode.kind else {
    Runtime.trap("batch target is not a file")
};
let ?batchContent = batchFile.active_content else {
    Runtime.trap("missing batch content")
};
let batchPlaintextBytes =
    6 * Types.MAX_PLAINTEXT_BLOCK_BYTES + 1;
let batchCiphertextBytes = batchPlaintextBytes + 7 * 16;
let batchContentValue : Memory.ContentRecord = {
    batchContent with
    block_count = 7;
    ciphertext_bytes = batchCiphertextBytes;
};
let batchTargetNodeValue : Memory.Node = {
    batchTargetNode with
    kind = #file({ active_content = ?batchContentValue });
    subtree_plaintext_bytes = batchPlaintextBytes;
};
let batchRootMutation =
    oversizedBatchPlaintext.stage.commit_plan.node_mutations[0];
let ?batchRootNode = batchRootMutation.replacement else {
    Runtime.trap("missing batch root")
};
let batchFrames = Array.tabulate<Memory.FramePlan>(
    7,
    func(index) {
        if (index == 0) {
            oversizedBatchPlaintext.stage.frames[0]
        } else {
            let bytes =
                Types.MAX_PLAINTEXT_BLOCK_BYTES + 16;
            {
                ordinal = Nat8.fromNat(index);
                encoded_bytes = Nat32.fromNat(bytes);
                blocks = [{
                    content_id = batchContent.content_id;
                    block_index = Nat32.fromNat(index);
                    ciphertext_bytes = Nat32.fromNat(bytes);
                    frame_ordinal = Nat8.fromNat(index);
                    payload_offset = 0;
                    payload_length = Nat32.fromNat(bytes);
                }];
            };
        };
    },
);
let batchStage : Memory.PrivateStage = {
    oversizedBatchPlaintext.stage with
    frame_count = 7;
    frame_fingerprints = Array.tabulate<?Memory.Tag256>(
        7,
        func(index) {
            if (index == 0) {
                oversizedBatchPlaintext.stage.frame_fingerprints[0]
            } else null;
        },
    );
    frames = batchFrames;
    commit_plan = {
        oversizedBatchPlaintext.stage.commit_plan with
        intent = #batch;
        node_mutations = [
            {
                batchRootMutation with
                replacement = ?{
                    batchRootNode with
                    subtree_plaintext_bytes =
                        rootNode().subtree_plaintext_bytes +
                        batchPlaintextBytes;
                };
            },
            {
                batchTargetMutation with
                replacement = ?batchTargetNodeValue;
            },
        ];
        committed_plaintext_delta =
            #increase(batchPlaintextBytes);
        committed_ciphertext_delta =
            #increase(batchCiphertextBytes + 16);
    };
    reserved_ciphertext_bytes =
        6 * (Types.MAX_PLAINTEXT_BLOCK_BYTES + 16);
};
oversizedBatchPlaintext.mem.reserved_staged_ciphertext_bytes :=
    batchStage.reserved_ciphertext_bytes;
ignore replacePrivateStageExact(
    oversizedBatchPlaintext,
    batchStage,
);
assert (
    batchPlaintextBytes >
    Types.MAX_BATCH_PLAINTEXT_BYTES
);
assertCorrupt(oversizedBatchPlaintext.mem);

// Startup may check a planned new node with one bounded map lookup, but it
// deliberately does not scan the committed tree for content ownership.
// Existing content block keys remain a runtime-admission invariant.
let committedNodeCollision = privateFixture(2_086);
let collisionTargetMutation =
    committedNodeCollision.stage.commit_plan.node_mutations[1];
let collisionNodeId = collisionTargetMutation.node_id;
let collisionNameTag : Memory.Tag256 = (0, 0, 9, 86);
let collisionContentId = Fixtures.id(99_086);
let collisionNode = fileNode(
    collisionContentId,
    collisionNameTag,
);
let collisionRoot = rootWithCreatedNode(collisionNode);
Map.add(
    committedNodeCollision.mem.nodes_by_id,
    Keys.compareId128,
    Types.ROOT_NODE_ID,
    collisionRoot,
);
Map.add(
    committedNodeCollision.mem.nodes_by_id,
    Keys.compareId128,
    collisionNodeId,
    collisionNode,
);
Map.add(
    committedNodeCollision.mem.children_by_name,
    Keys.compareChildNameKey,
    Keys.childNameKey(
        Types.ROOT_NODE_ID,
        collisionNameTag,
    ),
    collisionNodeId,
);
let collisionBody = Fixtures.zeros(17);
Map.add(
    committedNodeCollision.mem.blocks,
    Keys.compareBlockKey,
    Keys.blockKey(collisionContentId, 0),
    collisionBody,
);
committedNodeCollision.mem.node_count += 1;
committedNodeCollision.mem.committed_private_plaintext_bytes += 1;
committedNodeCollision.mem.committed_ciphertext_bytes += 17;
committedNodeCollision.mem.physical_private_bytes :=
    committedNodeCollision.mem.physical_private_bytes -
    Accounting.nodeCharge(rootNode()) +
    Accounting.nodeCharge(collisionRoot) +
    Accounting.nodeCharge(collisionNode) +
    Accounting.childIndexCharge() +
    Accounting.blockCharge(collisionBody.size());
assertCorrupt(committedNodeCollision.mem);

let duplicatePrivateNode = initializedMemory();
let duplicateNodeFirst = installPrivate(
    duplicatePrivateNode,
    1,
    Fixtures.id(2_087),
);
let duplicateNodeSecond = installPrivate(
    duplicatePrivateNode,
    2,
    Fixtures.id(2_088),
);
let duplicateNodeFixture : PrivateFixture = {
    mem = duplicatePrivateNode;
    stage_id = 2;
    stage = duplicateNodeSecond;
};
let duplicateNodeId =
    duplicateNodeFirst.commit_plan.node_mutations[1].node_id;
let duplicateNodeTarget =
    duplicateNodeSecond.commit_plan.node_mutations[1];
let duplicateNodeChild =
    duplicateNodeSecond.commit_plan.child_index_mutations[0];
ignore replacePrivateStageExact(
    duplicateNodeFixture,
    {
        duplicateNodeSecond with
        commit_plan = {
            duplicateNodeSecond.commit_plan with
            node_mutations = [
                duplicateNodeSecond.commit_plan.node_mutations[0],
                {
                    duplicateNodeTarget with
                    node_id = duplicateNodeId;
                },
            ];
            child_index_mutations = [{
                duplicateNodeChild with
                replacement = ?duplicateNodeId;
            }];
        };
    },
);
assertCorrupt(duplicatePrivateNode);

// Private active stages retain a bounded copy of the first-frame allocation
// contract. Bootstrap rejects malformed dimensions before any indexed replay
// or continuation path can observe them.
let privateFrameCount = privateFixture(3_001);
replacePrivateStage(
    privateFrameCount,
    { privateFrameCount.stage with frame_count = 3 },
);
assertCorrupt(privateFrameCount.mem);

let privateFrameVector = privateFixture(3_002);
replacePrivateStage(
    privateFrameVector,
    {
        privateFrameVector.stage with
        frames = [privateFrameVector.stage.frames[0]];
    },
);
assertCorrupt(privateFrameVector.mem);

let privateFingerprintVector = privateFixture(3_003);
replacePrivateStage(
    privateFingerprintVector,
    {
        privateFingerprintVector.stage with
        frame_fingerprints = [
            privateFingerprintVector.stage.frame_fingerprints[0]
        ];
    },
);
assertCorrupt(privateFingerprintVector.mem);

let privateOrdinal = privateFixture(3_004);
replacePrivateStage(
    privateOrdinal,
    {
        privateOrdinal.stage with
        frames = [
            privateOrdinal.stage.frames[0],
            {
                privateOrdinal.stage.frames[1] with
                ordinal = 0;
            },
        ];
    },
);
assertCorrupt(privateOrdinal.mem);

let privateBitmapLength = privateFixture(3_005);
replacePrivateStage(
    privateBitmapLength,
    {
        privateBitmapLength.stage with
        accepted_frame_bitmap = Blob.fromArray([]);
    },
);
assertCorrupt(privateBitmapLength.mem);

let privateBitmapTail = privateFixture(3_006);
replacePrivateStage(
    privateBitmapTail,
    {
        privateBitmapTail.stage with
        // frame_count is two, so bits two through seven are padding.
        accepted_frame_bitmap = Blob.fromArray([5]);
    },
);
assertCorrupt(privateBitmapTail.mem);

let privateMissingAcceptedFingerprint = privateFixture(3_007);
replacePrivateStage(
    privateMissingAcceptedFingerprint,
    {
        privateMissingAcceptedFingerprint.stage with
        frame_fingerprints = [null, null];
    },
);
assertCorrupt(privateMissingAcceptedFingerprint.mem);

let privateUnexpectedFingerprint = privateFixture(3_008);
replacePrivateStage(
    privateUnexpectedFingerprint,
    {
        privateUnexpectedFingerprint.stage with
        frame_fingerprints = [
            privateUnexpectedFingerprint.stage.frame_fingerprints[0],
            ?(0, 0, 30, 8),
        ];
    },
);
assertCorrupt(privateUnexpectedFingerprint.mem);

let privateAcceptedTotal = privateFixture(3_009);
replacePrivateStage(
    privateAcceptedTotal,
    {
        privateAcceptedTotal.stage with
        accepted_ciphertext_bytes =
            privateAcceptedTotal.stage.accepted_ciphertext_bytes + 1;
    },
);
assertCorrupt(privateAcceptedTotal.mem);

let privateReservedTotal = privateFixture(3_010);
replacePrivateStage(
    privateReservedTotal,
    {
        privateReservedTotal.stage with
        reserved_ciphertext_bytes =
            privateReservedTotal.stage.reserved_ciphertext_bytes + 1;
    },
);
assertCorrupt(privateReservedTotal.mem);

let privateBlockFrame = privateFixture(3_011);
let wrongFrameBlock : Memory.StageBlock = {
    privateBlockFrame.stage.frames[1].blocks[0] with
    frame_ordinal = 0;
};
replacePrivateStage(
    privateBlockFrame,
    {
        privateBlockFrame.stage with
        frames = [
            privateBlockFrame.stage.frames[0],
            {
                privateBlockFrame.stage.frames[1] with
                blocks = [wrongFrameBlock];
            },
        ];
    },
);
assertCorrupt(privateBlockFrame.mem);

let privateUndeclaredBlock = privateFixture(3_012);
let undeclaredBlock : Memory.StageBlock = {
    privateUndeclaredBlock.stage.frames[1].blocks[0] with
    content_id = Fixtures.id(30_012);
};
replacePrivateStage(
    privateUndeclaredBlock,
    {
        privateUndeclaredBlock.stage with
        frames = [
            privateUndeclaredBlock.stage.frames[0],
            {
                privateUndeclaredBlock.stage.frames[1] with
                blocks = [undeclaredBlock];
            },
        ];
    },
);
assertCorrupt(privateUndeclaredBlock.mem);

let privateDuplicateBlock = privateFixture(3_013);
let firstPrivateBlock =
    privateDuplicateBlock.stage.frames[0].blocks[0];
let duplicateBlock : Memory.StageBlock = {
    firstPrivateBlock with
    frame_ordinal = 1;
    payload_offset = 0;
};
replacePrivateStage(
    privateDuplicateBlock,
    {
        privateDuplicateBlock.stage with
        accepted_frame_bitmap = Blob.fromArray([3]);
        frame_fingerprints = [
            privateDuplicateBlock.stage.frame_fingerprints[0],
            ?(0, 0, 30, 13),
        ];
        frames = [
            privateDuplicateBlock.stage.frames[0],
            {
                ordinal = 1;
                encoded_bytes = firstPrivateBlock.ciphertext_bytes;
                blocks = [duplicateBlock];
            },
        ];
        accepted_ciphertext_bytes = 34;
        reserved_ciphertext_bytes = 0;
    },
);
privateDuplicateBlock.mem.staged_ciphertext_bytes := 34;
privateDuplicateBlock.mem.reserved_staged_ciphertext_bytes := 0;
assertCorrupt(privateDuplicateBlock.mem);

let privateMissingBlockRow = privateFixture(3_014);
let missingBlock =
    privateMissingBlockRow.stage.frames[0].blocks[0];
ignore Map.remove(
    privateMissingBlockRow.mem.blocks,
    Keys.compareBlockKey,
    Keys.blockKey(
        missingBlock.content_id,
        missingBlock.block_index,
    ),
);
assertCorrupt(privateMissingBlockRow.mem);

let privateUnexpectedBlockRow = privateFixture(3_015);
let unexpectedBlock =
    privateUnexpectedBlockRow.stage.frames[1].blocks[0];
Map.add(
    privateUnexpectedBlockRow.mem.blocks,
    Keys.compareBlockKey,
    Keys.blockKey(
        unexpectedBlock.content_id,
        unexpectedBlock.block_index,
    ),
    Fixtures.zeros(
        Nat32.toNat(unexpectedBlock.ciphertext_bytes)
    ),
);
assertCorrupt(privateUnexpectedBlockRow.mem);

let privateUnboundedPlan = privateFixture(3_016);
replacePrivateStage(
    privateUnboundedPlan,
    {
        privateUnboundedPlan.stage with
        commit_plan = {
            privateUnboundedPlan.stage.commit_plan with
            node_mutations = Array.tabulate<Memory.NodeMutation>(
                Types.MAX_BATCH_PLAN_ENTRIES + 1,
                func(_) {
                    privateUnboundedPlan.stage.commit_plan.node_mutations[
                        0
                    ];
                },
            );
        };
    },
);
assertCorrupt(privateUnboundedPlan.mem);

let privateCleanupReservation = privateFixture(3_017);
replacePrivateStage(
    privateCleanupReservation,
    {
        privateCleanupReservation.stage with
        reserved_cleanup_jobs = 1;
    },
);
privateCleanupReservation.mem.reserved_cleanup_jobs := 1;
assertCorrupt(privateCleanupReservation.mem);

let privateAcceptedCounter = privateFixture(3_018);
privateAcceptedCounter.mem.staged_ciphertext_bytes -= 1;
assertCorrupt(privateAcceptedCounter.mem);

let privateReservedCounter = privateFixture(3_019);
privateReservedCounter.mem.reserved_staged_ciphertext_bytes += 1;
assertCorrupt(privateReservedCounter.mem);

let privateCleanupCounter = privateFixture(3_020);
privateCleanupCounter.mem.reserved_cleanup_jobs := 1;
assertCorrupt(privateCleanupCounter.mem);

// Local managed-memory reservations and their global aggregate are exact.
// Adjusting both local and global isolates corruption of the local formula;
// adjusting only the global value isolates aggregate reconciliation.
let privateLocalReservationHigh = privateFixture(3_021);
privateLocalReservationHigh.mem.reserved_physical_private_bytes += 1;
replacePrivateStage(
    privateLocalReservationHigh,
    {
        privateLocalReservationHigh.stage with
        reserved_physical_bytes =
            privateLocalReservationHigh.stage.reserved_physical_bytes + 1;
    },
);
assertCorrupt(privateLocalReservationHigh.mem);

let privateLocalReservationLow = privateFixture(3_022);
assert privateLocalReservationLow.stage.reserved_physical_bytes > 0;
privateLocalReservationLow.mem.reserved_physical_private_bytes -= 1;
replacePrivateStage(
    privateLocalReservationLow,
    {
        privateLocalReservationLow.stage with
        reserved_physical_bytes =
            privateLocalReservationLow.stage.reserved_physical_bytes - 1;
    },
);
assertCorrupt(privateLocalReservationLow.mem);

let globalReservationHigh = privateFixture(3_023);
globalReservationHigh.mem.reserved_physical_private_bytes += 1;
assertCorrupt(globalReservationHigh.mem);

let globalReservationLow = privateFixture(3_024);
assert globalReservationLow.mem.reserved_physical_private_bytes > 0;
globalReservationLow.mem.reserved_physical_private_bytes -= 1;
assertCorrupt(globalReservationLow.mem);

let duplicatePrivateContent = initializedMemory();
let duplicateContentFirst = installPrivate(
    duplicatePrivateContent,
    1,
    Fixtures.id(3_025),
);
let duplicateContentSecond = installPrivate(
    duplicatePrivateContent,
    2,
    Fixtures.id(3_026),
);
let duplicatedContentId =
    duplicateContentFirst.frames[0].blocks[0].content_id;
let duplicatedReplacement =
    plannedNode(2, duplicatedContentId);
let secondMutation =
    duplicateContentSecond.commit_plan.node_mutations[1];
let duplicateSecondMutation : Memory.NodeMutation = {
    secondMutation with
    replacement = ?duplicatedReplacement;
};
let duplicateSecondFrames = Array.map<
    Memory.FramePlan,
    Memory.FramePlan
>(
    duplicateContentSecond.frames,
    func(frame) {
        {
            frame with
            blocks = Array.map<Memory.StageBlock, Memory.StageBlock>(
                frame.blocks,
                func(block) {
                    { block with content_id = duplicatedContentId };
                },
            );
        };
    },
);
Map.add(
    duplicatePrivateContent.stages,
    Nat64.compare,
    (2 : Nat64),
    #private_write({
        duplicateContentSecond with
        frames = duplicateSecondFrames;
        commit_plan = {
            duplicateContentSecond.commit_plan with
            node_mutations = [
                duplicateContentSecond.commit_plan.node_mutations[0],
                duplicateSecondMutation,
            ];
        };
    }),
);
assertCorrupt(duplicatePrivateContent);

// The retained-receipt ownership index is a bounded exact reconstruction.
// Multiple receipts can reference the same live node/content while each
// namespace retains its own refcount.
let validReceiptOwners = initializedMemory();
ignore addRetainedWriteReceipt(
    validReceiptOwners,
    Fixtures.id(8_001),
    SOURCE_NODE_ID,
    SOURCE_CONTENT_ID,
);
ignore addRetainedWriteReceipt(
    validReceiptOwners,
    Fixtures.id(8_002),
    SOURCE_NODE_ID,
    SOURCE_CONTENT_ID,
);
assert (
    Map.get(
        validReceiptOwners.private_receipt_identity_owners,
        Keys.compareId128,
        SOURCE_NODE_ID,
    ) == ?receiptOwner(2, 0)
);
assert (
    Map.get(
        validReceiptOwners.private_receipt_identity_owners,
        Keys.compareId128,
        SOURCE_CONTENT_ID,
    ) == ?receiptOwner(0, 2)
);
assertBootstrapOk(validReceiptOwners, 0);

let receiptOwnerHigh = initializedMemory();
ignore addRetainedWriteReceipt(
    receiptOwnerHigh,
    Fixtures.id(8_003),
    SOURCE_NODE_ID,
    SOURCE_CONTENT_ID,
);
Map.add(
    receiptOwnerHigh.private_receipt_identity_owners,
    Keys.compareId128,
    SOURCE_NODE_ID,
    receiptOwner(2, 0),
);
assertCorrupt(receiptOwnerHigh);

let receiptOwnerLow = initializedMemory();
ignore addRetainedWriteReceipt(
    receiptOwnerLow,
    Fixtures.id(8_004),
    SOURCE_NODE_ID,
    SOURCE_CONTENT_ID,
);
Map.add(
    receiptOwnerLow.private_receipt_identity_owners,
    Keys.compareId128,
    SOURCE_NODE_ID,
    receiptOwner(0, 0),
);
assertCorrupt(receiptOwnerLow);

let receiptOwnerMissing = initializedMemory();
ignore addRetainedWriteReceipt(
    receiptOwnerMissing,
    Fixtures.id(8_005),
    SOURCE_NODE_ID,
    SOURCE_CONTENT_ID,
);
ignore Map.remove(
    receiptOwnerMissing.private_receipt_identity_owners,
    Keys.compareId128,
    SOURCE_CONTENT_ID,
);
assertCorrupt(receiptOwnerMissing);

let receiptOwnerExtra = initializedMemory();
ignore addRetainedWriteReceipt(
    receiptOwnerExtra,
    Fixtures.id(8_006),
    SOURCE_NODE_ID,
    SOURCE_CONTENT_ID,
);
Map.add(
    receiptOwnerExtra.private_receipt_identity_owners,
    Keys.compareId128,
    Fixtures.id(88_006),
    receiptOwner(0, 0),
);
assertCorrupt(receiptOwnerExtra);

let receiptExpiryMissing = initializedMemory();
let missingExpiryRequest = Fixtures.id(8_007);
ignore addRetainedWriteReceipt(
    receiptExpiryMissing,
    missingExpiryRequest,
    SOURCE_NODE_ID,
    SOURCE_CONTENT_ID,
);
ignore Map.remove(
    receiptExpiryMissing.private_receipts_by_expiry,
    Keys.comparePrivateReceiptExpiryKey,
    (
        FUTURE,
        missingExpiryRequest.hi,
        missingExpiryRequest.lo,
    ),
);
assertCorrupt(receiptExpiryMissing);

let retainedStageCollision = initializedMemory();
let collidingStage = installPrivate(
    retainedStageCollision,
    1,
    Fixtures.id(8_008),
);
let collidingMutation =
    collidingStage.commit_plan.node_mutations[1];
let ?collidingReplacement =
    collidingMutation.replacement else {
        Runtime.trap("missing colliding replacement")
    };
let #file(collidingFile) =
    collidingReplacement.kind else {
        Runtime.trap("colliding replacement is not a file")
    };
let ?collidingContent =
    collidingFile.active_content else {
        Runtime.trap("missing colliding content")
    };
ignore addRetainedWriteReceipt(
    retainedStageCollision,
    Fixtures.id(8_009),
    collidingMutation.node_id,
    collidingContent.content_id,
);
assertCorrupt(retainedStageCollision);

// Cleanup cursors and the staged-byte counter are reconstructed from only the
// bounded job vectors and their point-addressed block suffix.
let validOrphanJob = initializedMemory();
let orphanBody = Fixtures.zeros(17);
Map.add(
    validOrphanJob.blocks,
    Keys.compareBlockKey,
    Keys.blockKey(Fixtures.id(8_200), 0),
    orphanBody,
);
validOrphanJob.physical_private_bytes +=
    Accounting.blockCharge(orphanBody.size());
installCleanupJob(validOrphanJob, {
    job_id = 1;
    kind = #orphan_blocks({
        content_id = Fixtures.id(8_200);
        next_block_index = 0;
        block_count = 1;
    });
    created_at_ns = 1;
    updated_at_ns = 1;
    reclaimed_entries = 0;
    reclaimed_ciphertext_bytes = 0;
});
assertBootstrapOk(validOrphanJob, 0);

let validContentsJob = initializedMemory();
let contentsId = Fixtures.id(8_203);
Map.add(
    validContentsJob.blocks,
    Keys.compareBlockKey,
    Keys.blockKey(contentsId, 0),
    orphanBody,
);
validContentsJob.physical_private_bytes +=
    Accounting.blockCharge(orphanBody.size());
let contentsCleanupJob : Memory.DeleteJob = {
    job_id = 1;
    kind = #contents({
        contents = [{
            content_id = contentsId;
            next_block_index = 0;
            block_count = 1;
        }];
        current_content = 0;
    });
    created_at_ns = 1;
    updated_at_ns = 1;
    reclaimed_entries = 0;
    reclaimed_ciphertext_bytes = 0;
};
installCleanupJob(validContentsJob, contentsCleanupJob);
assertBootstrapOk(validContentsJob, 0);

let missingContentsSuffix = initializedMemory();
installCleanupJob(missingContentsSuffix, contentsCleanupJob);
assertCorrupt(missingContentsSuffix);

let invalidOrphanCursor = initializedMemory();
installCleanupJob(invalidOrphanCursor, {
    job_id = 1;
    kind = #orphan_blocks({
        content_id = Fixtures.id(8_201);
        next_block_index = 2;
        block_count = 1;
    });
    created_at_ns = 1;
    updated_at_ns = 1;
    reclaimed_entries = 0;
    reclaimed_ciphertext_bytes = 0;
});
assertCorrupt(invalidOrphanCursor);

let validPrivateCleanup = initializedMemory();
let processedKey = Keys.blockKey(Fixtures.id(8_202), 0);
let remainingKey = Keys.blockKey(Fixtures.id(8_202), 1);
let remainingBody = Fixtures.zeros(17);
Map.add(
    validPrivateCleanup.blocks,
    Keys.compareBlockKey,
    remainingKey,
    remainingBody,
);
validPrivateCleanup.physical_private_bytes +=
    Accounting.blockCharge(remainingBody.size());
validPrivateCleanup.staged_ciphertext_bytes :=
    remainingBody.size();
let privateCleanupJob : Memory.DeleteJob = {
    job_id = 1;
    kind = #private_stage({
        blocks = [remainingKey];
        next_block = 0;
    });
    created_at_ns = 1;
    updated_at_ns = 1;
    reclaimed_entries = 0;
    reclaimed_ciphertext_bytes = 0;
};
installCleanupJob(validPrivateCleanup, privateCleanupJob);
assertBootstrapOk(validPrivateCleanup, 0);

let processedPrivateCleanupJob : Memory.DeleteJob = {
    privateCleanupJob with
    kind = #private_stage({
        blocks = [processedKey, remainingKey];
        next_block = 1;
    });
};

let ghostPrivateCleanupBytes = initializedMemory();
ghostPrivateCleanupBytes.staged_ciphertext_bytes := 1;
assertCorrupt(ghostPrivateCleanupBytes);

let presentProcessedPrefix = initializedMemory();
Map.add(
    presentProcessedPrefix.blocks,
    Keys.compareBlockKey,
    processedKey,
    remainingBody,
);
Map.add(
    presentProcessedPrefix.blocks,
    Keys.compareBlockKey,
    remainingKey,
    remainingBody,
);
presentProcessedPrefix.physical_private_bytes +=
    Accounting.blockCharge(remainingBody.size()) * 2;
presentProcessedPrefix.staged_ciphertext_bytes :=
    remainingBody.size();
installCleanupJob(
    presentProcessedPrefix,
    processedPrivateCleanupJob,
);
assertCorrupt(presentProcessedPrefix);

let missingPrivateSuffix = initializedMemory();
installCleanupJob(missingPrivateSuffix, privateCleanupJob);
assertCorrupt(missingPrivateSuffix);

let cleanupOwnerCollision = initializedMemory();
Map.add(
    cleanupOwnerCollision.blocks,
    Keys.compareBlockKey,
    remainingKey,
    remainingBody,
);
cleanupOwnerCollision.physical_private_bytes +=
    Accounting.blockCharge(remainingBody.size());
cleanupOwnerCollision.staged_ciphertext_bytes :=
    remainingBody.size();
installCleanupJob(cleanupOwnerCollision, privateCleanupJob);
installCleanupJob(cleanupOwnerCollision, {
    contentsCleanupJob with
    job_id = 2;
    kind = #contents({
        contents = [{
            content_id = Fixtures.id(8_202);
            next_block_index = 1;
            block_count = 2;
        }];
        current_content = 0;
    });
    reclaimed_entries = 1;
});
assertCorrupt(cleanupOwnerCollision);

let activeCleanupOwnerCollision = initializedMemory();
let collidingActiveStage = installPrivate(
    activeCleanupOwnerCollision,
    1,
    Fixtures.id(8_204),
);
let activeBlock =
    collidingActiveStage.frames[0].blocks[0];
installCleanupJob(activeCleanupOwnerCollision, {
    contentsCleanupJob with
    job_id = 1;
    kind = #contents({
        contents = [{
            content_id = activeBlock.content_id;
            next_block_index = 0;
            block_count = 1;
        }];
        current_content = 0;
    });
});
assertCorrupt(activeCleanupOwnerCollision);

let zeroInitializedJobCounter = initializedMemory();
zeroInitializedJobCounter.next_job_id := 0;
assertCorrupt(zeroInitializedJobCounter);

let wrongInitializedNodeCount = initializedMemory();
wrongInitializedNodeCount.node_count += 1;
assertCorrupt(wrongInitializedNodeCount);

// A null vault is a truly fresh state. Non-root rows or non-default counters
// cannot be exposed as a valid empty filesystem.
assertBootstrapOk(Memory.init(), 0);

let absentNode = Memory.init();
Map.add(
    absentNode.nodes_by_id,
    Keys.compareId128,
    SOURCE_NODE_ID,
    fileNode(SOURCE_CONTENT_ID, SOURCE_NAME_TAG),
);
assertCorrupt(absentNode);

let absentChildIndex = Memory.init();
Map.add(
    absentChildIndex.children_by_name,
    Keys.compareChildNameKey,
    Keys.childNameKey(Types.ROOT_NODE_ID, SOURCE_NAME_TAG),
    SOURCE_NODE_ID,
);
assertCorrupt(absentChildIndex);

let absentBlock = Memory.init();
Map.add(
    absentBlock.blocks,
    Keys.compareBlockKey,
    Keys.blockKey(SOURCE_CONTENT_ID, 0),
    Fixtures.zeros(17),
);
assertCorrupt(absentBlock);

let absentStage = Memory.init();
ignore installPrivate(absentStage, 1, Fixtures.id(9_099));
assertCorrupt(absentStage);

let absentPrivateReceipt = Memory.init();
let absentReceiptRequest = Fixtures.id(9_100);
let absentReceipt : Memory.PrivateReceipt = {
    request_fingerprint = (0, 0, 9, 100);
    outcome = #vault({
        request_id = absentReceiptRequest;
        expected_record_revision = null;
        record_revision = 1;
        initialized = true;
    });
    completed_at_ns = 1;
    terminal_kind = null;
    expires_at_ns = FUTURE;
};
Map.add(
    absentPrivateReceipt.private_receipts,
    Keys.compareId128,
    absentReceiptRequest,
    absentReceipt,
);
assertCorrupt(absentPrivateReceipt);

let absentPrivateExpiry = Memory.init();
Map.add(
    absentPrivateExpiry.private_receipts_by_expiry,
    Keys.comparePrivateReceiptExpiryKey,
    (FUTURE, (0 : Nat64), (9_101 : Nat64)),
    (),
);
assertCorrupt(absentPrivateExpiry);

let absentCleanup = Memory.init();
let absentJob : Memory.DeleteJob = {
    job_id = 1;
    kind = #orphan_blocks({
        content_id = SOURCE_CONTENT_ID;
        next_block_index = 0;
        block_count = 1;
    });
    created_at_ns = 1;
    updated_at_ns = 1;
    reclaimed_entries = 0;
    reclaimed_ciphertext_bytes = 0;
};
Map.add(
    absentCleanup.delete_jobs,
    Nat64.compare,
    (1 : Nat64),
    absentJob,
);
assertCorrupt(absentCleanup);


let absentCounters = Memory.init();
absentCounters.next_stage_id := 2;
absentCounters.next_job_id := 2;
absentCounters.node_count := 1;
absentCounters.committed_private_plaintext_bytes := 1;
absentCounters.committed_ciphertext_bytes := 1;
absentCounters.staged_ciphertext_bytes := 1;
absentCounters.reserved_staged_ciphertext_bytes := 1;
absentCounters.physical_private_bytes := 1;
absentCounters.reserved_physical_private_bytes := 1;
absentCounters.reserved_cleanup_jobs := 1;
assertCorrupt(absentCounters);
