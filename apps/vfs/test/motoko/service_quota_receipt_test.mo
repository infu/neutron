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
import Frames "../../backend/files/Frames";
import Keys "../../backend/files/Keys";
import Service "../../backend/files/Service";
import Types "../../backend/files/Types";
import Fixtures "Fixtures";

func vaultRequest(
    requestId : Types.Id128,
    bodyBytes : Nat,
) : Types.VaultWriteRequest {
    {
        request_id = requestId;
        operation = ?#initialize;
        expected_record_revision = null;
        proposed_record_revision = 1;
        body_bytes = Nat32.fromNat(bodyBytes);
    };
};

var rejectionAssertion = 0;

func assertReason<T>(result : Types.Result<T>, expected : Types.RejectionReason) {
    rejectionAssertion += 1;
    switch (result) {
        case (#err({ reason = ?actual })) {
            if (actual != expected) {
                Runtime.trap(
                    "expected " # debug_show (expected) #
                    ", got " # debug_show (actual) #
                    " at assertion " # debug_show (rejectionAssertion)
                );
            };
        };
        case (_) Runtime.trap(
            "expected rejection at assertion " #
            debug_show (rejectionAssertion)
        );
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

func vault() : Memory.VaultRecord {
    {
        format = 2;
        vault_id = Fixtures.id(100);
        vault_salt = FramesTag(1);
        slot_generation = 1;
        public_key_fingerprint = FramesTag(2);
        ibe_wrapped_root_key = Fixtures.zeros(32);
        root_commitment = FramesTag(3);
        record_revision = 1;
    };
};

func FramesTag(value : Nat64) : Memory.Tag256 {
    (0, 0, 0, value);
};

func receipt(expiresAt : Nat64) : Memory.PrivateReceipt {
    {
        request_fingerprint = FramesTag(99);
        outcome = #vault({
            request_id = Fixtures.id(1);
            expected_record_revision = null;
            record_revision = 1;
            initialized = true;
        });
        completed_at_ns = 0;
        terminal_kind = null;
        expires_at_ns = expiresAt;
    };
};

func rewrapReceipt(expiresAt : Nat64) : Memory.PrivateReceipt {
    {
        request_fingerprint = FramesTag(100);
        outcome = #vault({
            request_id = Fixtures.id(2);
            expected_record_revision = ?1;
            record_revision = 2;
            initialized = false;
        });
        completed_at_ns = 0;
        terminal_kind = null;
        expires_at_ns = expiresAt;
    };
};

func installVaultRoot(mem : Memory.Mem) {
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
    mem.committed_ciphertext_bytes :=
        rootValue.encrypted_metadata.size();
    mem.physical_private_bytes +=
        Accounting.vaultCharge(vaultValue) +
        Accounting.nodeCharge(rootValue);
};

func installVaultRootWithMetadata(
    mem : Memory.Mem,
    metadataBytes : Nat,
) {
    let vaultValue = vault();
    let rootValue : Memory.Node = {
        root() with
        encrypted_metadata = Fixtures.zeros(metadataBytes);
    };
    mem.vault := ?vaultValue;
    Map.add(
        mem.nodes_by_id,
        Keys.compareId128,
        Types.ROOT_NODE_ID,
        rootValue,
    );
    mem.node_count := 1;
    mem.committed_ciphertext_bytes := metadataBytes;
    mem.physical_private_bytes +=
        Accounting.vaultCharge(vaultValue) +
        Accounting.nodeCharge(rootValue);
};

func rewrapBody(
    requestId : Types.Id128,
    current : Memory.VaultRecord,
) : Blob {
    let control : Frames.VaultWriteFrameControl = {
        request_id = requestId;
        expected_record_revision = ?current.record_revision;
        proposed_record_revision = current.record_revision + 1;
        operation = ?#rewrap({
            format = current.format;
            vault_id = current.vault_id;
            vault_salt = Frames.digestFromTag(current.vault_salt);
            slot_generation = current.slot_generation + 1;
            public_key_fingerprint = Fixtures.digest(requestId.lo);
            root_commitment =
                Frames.digestFromTag(current.root_commitment);
            ibe_wrapped_root_key = { offset = 0; length = 32 };
        });
        raw_payload_bytes = 32;
    };
    Fixtures.pack(to_candid (control), Fixtures.zeros(32));
};

func initializeBodyWithLengths(
    requestId : Types.Id128,
    wrapperBytes : Nat,
    metadataBytes : Nat,
) : Blob {
    let raw = Fixtures.zeros(wrapperBytes + metadataBytes);
    let control : Frames.VaultWriteFrameControl = {
        request_id = requestId;
        expected_record_revision = null;
        proposed_record_revision = 1;
        operation = ?#initialize({
            format = 2;
            vault_id = Fixtures.id(100);
            vault_salt = Fixtures.digest(1);
            slot_generation = 1;
            public_key_fingerprint = Fixtures.digest(2);
            root_commitment = Fixtures.digest(3);
            root_structural_revision = 1;
            root_metadata_revision = 1;
            root_children_revision = 0;
            ibe_wrapped_root_key = {
                offset = 0;
                length = Nat32.fromNat(wrapperBytes);
            };
            encrypted_root_metadata = {
                offset = Nat32.fromNat(wrapperBytes);
                length = Nat32.fromNat(metadataBytes);
            };
        });
        raw_payload_bytes = Nat32.fromNat(raw.size());
    };
    Fixtures.pack(to_candid (control), raw);
};

func rewrapBodyWithLength(
    requestId : Types.Id128,
    current : Memory.VaultRecord,
    wrapperBytes : Nat,
) : Blob {
    let control : Frames.VaultWriteFrameControl = {
        request_id = requestId;
        expected_record_revision = ?current.record_revision;
        proposed_record_revision = current.record_revision + 1;
        operation = ?#rewrap({
            format = current.format;
            vault_id = current.vault_id;
            vault_salt = Frames.digestFromTag(current.vault_salt);
            slot_generation = current.slot_generation + 1;
            public_key_fingerprint = Fixtures.digest(requestId.lo);
            root_commitment =
                Frames.digestFromTag(current.root_commitment);
            ibe_wrapped_root_key = {
                offset = 0;
                length = Nat32.fromNat(wrapperBytes);
            };
        });
        raw_payload_bytes = Nat32.fromNat(wrapperBytes);
    };
    Fixtures.pack(
        to_candid (control),
        Fixtures.zeros(wrapperBytes),
    );
};

func vaultReadBodyForTest(
    vaultValue : Memory.VaultRecord,
    rootValue : Memory.Node,
) : ?Blob {
    let wrapperBytes = vaultValue.ibe_wrapped_root_key.size();
    let metadataBytes = rootValue.encrypted_metadata.size();
    let raw = Frames.append([
        vaultValue.ibe_wrapped_root_key,
        rootValue.encrypted_metadata,
    ]);
    Frames.encodeVaultRead(
        {
            format = vaultValue.format;
            vault_id = vaultValue.vault_id;
            vault_salt =
                Frames.digestFromTag(vaultValue.vault_salt);
            slot_generation = vaultValue.slot_generation;
            public_key_fingerprint =
                Frames.digestFromTag(
                    vaultValue.public_key_fingerprint
                );
            root_commitment =
                Frames.digestFromTag(vaultValue.root_commitment);
            record_revision = vaultValue.record_revision;
            root_structural_revision =
                rootValue.structural_revision;
            root_metadata_revision = rootValue.metadata_revision;
            root_children_revision = rootValue.children_revision;
            ibe_wrapped_root_key = {
                offset = 0;
                length = Nat32.fromNat(wrapperBytes);
            };
            encrypted_root_metadata = {
                offset = Nat32.fromNat(wrapperBytes);
                length = Nat32.fromNat(metadataBytes);
            };
            raw_payload_bytes = Nat32.fromNat(raw.size());
        },
        raw,
    );
};

func rewrapRequest(
    requestId : Types.Id128,
    current : Memory.VaultRecord,
    bodyBytes : Nat,
) : Types.VaultWriteRequest {
    {
        request_id = requestId;
        operation = ?#rewrap;
        expected_record_revision = ?current.record_revision;
        proposed_record_revision = current.record_revision + 1;
        body_bytes = Nat32.fromNat(bodyBytes);
    };
};

let rewrapAdmissionReceipt =
    rewrapReceipt(Types.RECEIPT_RETENTION_NS);
let rewrapAdmissionCharge =
    Accounting.receiptCharge(rewrapAdmissionReceipt) +
    Accounting.privateReceiptIndexCharge();
assert (rewrapAdmissionCharge < Types.MAX_PHYSICAL_PRIVATE_BYTES);

// Physical admission is inclusive at the reviewed limit and fails at +1.
let exactMem = Memory.init();
installVaultRoot(exactMem);
exactMem.physical_private_bytes :=
    Types.MAX_PHYSICAL_PRIVATE_BYTES - rewrapAdmissionCharge;
let exactVault = vault();
let exactRequestId = Fixtures.id(2);
let exactBody = rewrapBody(exactRequestId, exactVault);
let exactService = Service.Service(
    exactMem,
    Fixtures.assets(Fixtures.zeroUsage()),
    func() : Nat64 { 0 },
);
switch (
    exactService.vaultWrite(
        rewrapRequest(exactRequestId, exactVault, exactBody.size()),
        exactBody,
    )
) {
    case (#ok(_)) {};
    case (_) assert false;
};
assert (
    exactMem.physical_private_bytes ==
    Types.MAX_PHYSICAL_PRIVATE_BYTES
);

let plusOneMem = Memory.init();
installVaultRoot(plusOneMem);
plusOneMem.physical_private_bytes :=
    Types.MAX_PHYSICAL_PRIVATE_BYTES - rewrapAdmissionCharge + 1;
let plusOneVault = vault();
let plusOneRequestId = Fixtures.id(3);
let plusOneBody = rewrapBody(plusOneRequestId, plusOneVault);
let plusOneService = Service.Service(
    plusOneMem,
    Fixtures.assets(Fixtures.zeroUsage()),
    func() : Nat64 { 0 },
);
assertReason(
    plusOneService.vaultWrite(
        rewrapRequest(
            plusOneRequestId,
            plusOneVault,
            plusOneBody.size(),
        ),
        plusOneBody,
    ),
    #quota,
);
assert (plusOneMem.vault == ?plusOneVault);
assert (Map.size(plusOneMem.nodes_by_id) == 1);

// Reservation counters use inclusive ceilings for staged, physical, and
// cleanup capacity, with any single +1 rejected before mutation.
let reserveMem = Memory.init();
reserveMem.staged_ciphertext_bytes :=
    Types.MAX_STAGED_CIPHERTEXT_BYTES - 10;
reserveMem.physical_private_bytes :=
    Types.MAX_PHYSICAL_PRIVATE_BYTES - 20;
reserveMem.reserved_cleanup_jobs := Types.MAX_CLEANUP_JOBS - 1;
assert (Accounting.canReserve(reserveMem, 10, 20, 1));
assert (not Accounting.canReserve(reserveMem, 11, 20, 1));
assert (not Accounting.canReserve(reserveMem, 10, 21, 1));
assert (not Accounting.canReserve(reserveMem, 10, 20, 2));
Accounting.reserve(reserveMem, 10, 20, 1);
assert (
    reserveMem.staged_ciphertext_bytes +
    reserveMem.reserved_staged_ciphertext_bytes ==
    Types.MAX_STAGED_CIPHERTEXT_BYTES
);
assert (
    reserveMem.physical_private_bytes +
    reserveMem.reserved_physical_private_bytes ==
    Types.MAX_PHYSICAL_PRIVATE_BYTES
);
assert (
    reserveMem.reserved_cleanup_jobs == Types.MAX_CLEANUP_JOBS
);
Accounting.releaseReservation(reserveMem, 10, 20, 1);

func fillReceipts(
    mem : Memory.Mem,
    count : Nat,
    expiry : Nat64,
) {
    let value = receipt(expiry);
    let oneCharge =
        Accounting.receiptCharge(value) +
        Accounting.privateReceiptIndexCharge();
    var index = 1;
    while (index <= count) {
        let requestId = Fixtures.id(index);
        Map.add(
            mem.private_receipts,
            Keys.compareId128,
            requestId,
            value,
        );
        Map.add(
            mem.private_receipts_by_expiry,
            Keys.comparePrivateReceiptExpiryKey,
            (expiry, requestId.hi, requestId.lo),
            (),
        );
        index += 1;
    };
    mem.physical_private_bytes += count * oneCharge;
};

func addContentCleanupJob(
    mem : Memory.Mem,
    jobId : Nat64,
    contentId : Types.Id128,
    blockCount : Nat,
    blockBytes : Nat,
) : Nat {
    var charge = 0;
    var index = 0;
    while (index < blockCount) {
        let body = Fixtures.zeros(blockBytes);
        Map.add(
            mem.blocks,
            Keys.compareBlockKey,
            Keys.blockKey(contentId, Nat32.fromNat(index)),
            body,
        );
        charge += Accounting.blockCharge(body.size());
        index += 1;
    };
    let contents : [{
        content_id : Types.Id128;
        next_block_index : Nat32;
        block_count : Nat32;
    }] = if (blockCount == 0) [] else [{
        content_id = contentId;
        next_block_index = 0;
        block_count = Nat32.fromNat(blockCount);
    }];
    let job : Memory.DeleteJob = {
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
    Map.add(mem.delete_jobs, Nat64.compare, jobId, job);
    charge += Accounting.cleanupJobCharge(job);
    mem.physical_private_bytes += charge;
    charge;
};

func installRemovableFile(
    mem : Memory.Mem,
    nodeId : Types.Id128,
    nameTag : Memory.Tag256,
) {
    let vaultValue = vault();
    let rootValue : Memory.Node = {
        root() with
        kind = #folder({
            direct_child_count = 1;
            child_subtree_heights = [{ value = 0; count = 1 }];
            child_relative_path_scalars = [{ value = 1; count = 1 }];
        });
        structural_revision = 2;
        children_revision = 1;
        subtree_height = 1;
        max_relative_path_scalars = 1;
    };
    let file : Memory.Node = {
        parent_id = Types.ROOT_NODE_ID;
        kind = #file({ active_content = null });
        state = #active;
        name_tag = nameTag;
        declared_name_scalars = 1;
        structural_revision = 1;
        metadata_revision = 1;
        children_revision = 0;
        subtree_height = 0;
        max_relative_path_scalars = 1;
        subtree_plaintext_bytes = 0;
        encrypted_metadata = Fixtures.zeros(16);
    };
    mem.vault := ?vaultValue;
    Map.add(
        mem.nodes_by_id,
        Keys.compareId128,
        Types.ROOT_NODE_ID,
        rootValue,
    );
    Map.add(mem.nodes_by_id, Keys.compareId128, nodeId, file);
    Map.add(
        mem.children_by_name,
        Keys.compareChildNameKey,
        Keys.childNameKey(Types.ROOT_NODE_ID, nameTag),
        nodeId,
    );
    mem.node_count := 2;
    mem.committed_ciphertext_bytes :=
        rootValue.encrypted_metadata.size() +
        file.encrypted_metadata.size();
    mem.physical_private_bytes +=
        Accounting.vaultCharge(vaultValue) +
        Accounting.nodeCharge(rootValue) +
        Accounting.nodeCharge(file) +
        Accounting.childIndexCharge();
};

func nodeAt(
    mem : Memory.Mem,
    nodeId : Types.Id128,
) : Memory.Node {
    let ?node = Map.get(
        mem.nodes_by_id,
        Keys.compareId128,
        nodeId,
    ) else Runtime.trap("missing test node");
    node;
};

func folderWitness(
    mem : Memory.Mem,
    nodeId : Types.Id128,
) : Frames.FolderAggregateTransition {
    let node = nodeAt(mem, nodeId);
    {
        node_id = nodeId;
        expected_structural_revision = node.structural_revision;
        expected_children_revision = node.children_revision;
    };
};

func committedCiphertextFromNodes(mem : Memory.Mem) : Nat {
    var total = 0;
    for ((_, node) in Map.entries(mem.nodes_by_id)) {
        total += node.encrypted_metadata.size();
        switch (node.kind) {
            case (#file({ active_content = ?content })) {
                total += content.ciphertext_bytes;
            };
            case (_) {};
        };
    };
    total;
};

func privatePhysicalFromRows(mem : Memory.Mem) : Nat {
    var total = switch (mem.vault) {
        case (?value) Accounting.vaultCharge(value);
        case null 0;
    };
    for ((_, node) in Map.entries(mem.nodes_by_id)) {
        total += Accounting.nodeCharge(node);
    };
    total +=
        Map.size(mem.children_by_name) *
        Accounting.childIndexCharge();
    for ((_, body) in Map.entries(mem.blocks)) {
        total += Accounting.blockCharge(body.size());
    };
    for ((_, stage) in Map.entries(mem.stages)) {
        total += switch (stage) {
            case (#private_write(value)) {
                Accounting.privateStageCharge(value);
            };
            case (_) {
                assert false;
                0;
            };
        };
    };
    total +=
        Map.size(mem.stages_by_request) *
        Accounting.stageRequestIndexCharge();
    for ((_, receipt) in Map.entries(mem.private_receipts)) {
        total +=
            Accounting.receiptCharge(receipt) +
            Accounting.privateReceiptIndexCharge();
    };
    total +=
        Map.size(mem.private_receipt_identity_owners) *
        Accounting.privateReceiptIdentityRowCharge();
    for ((_, job) in Map.entries(mem.delete_jobs)) {
        total += Accounting.cleanupJobCharge(job);
    };
    total;
};

func assertPrivateCounters(mem : Memory.Mem, expectedNodes : Nat) {
    assert (Map.size(mem.nodes_by_id) == expectedNodes);
    assert (mem.node_count == expectedNodes);
    assert (
        mem.committed_ciphertext_bytes ==
        committedCiphertextFromNodes(mem)
    );
    assert (
        mem.physical_private_bytes ==
        privatePhysicalFromRows(mem)
    );
};

func emptyFolder(
    parentId : Types.Id128,
    nameTag : Memory.Tag256,
) : Memory.Node {
    {
        parent_id = parentId;
        kind = #folder({
            direct_child_count = 0;
            child_subtree_heights = [];
            child_relative_path_scalars = [];
        });
        state = #active;
        name_tag = nameTag;
        declared_name_scalars = 1;
        structural_revision = 1;
        metadata_revision = 1;
        children_revision = 0;
        subtree_height = 0;
        max_relative_path_scalars = 1;
        subtree_plaintext_bytes = 0;
        encrypted_metadata = Fixtures.zeros(16);
    };
};

func addIndexedNode(
    mem : Memory.Mem,
    nodeId : Types.Id128,
    node : Memory.Node,
) {
    Map.add(mem.nodes_by_id, Keys.compareId128, nodeId, node);
    Map.add(
        mem.children_by_name,
        Keys.compareChildNameKey,
        Keys.childNameKey(node.parent_id, node.name_tag),
        nodeId,
    );
};

func mutateFrame(
    service : Service.Service,
    control : Frames.MutateFrameControl,
) : (Types.MutateRequest, Blob, Types.MutateOk) {
    let body = Fixtures.pack(
        to_candid (control),
        Fixtures.zeros(Nat32.toNat(control.raw_payload_bytes)),
    );
    let request : Types.MutateRequest = {
        request_id = control.request_id;
        action = control.action;
        body_bytes = Nat32.fromNat(body.size());
    };
    let result = switch (service.mutate(request, body)) {
        case (#ok(value)) value;
        case (value) Runtime.trap(
            "counter regression mutation failed: " # debug_show (value)
        );
    };
    (request, body, result);
};

func replayMutationWithoutCleanup(
    service : Service.Service,
    mem : Memory.Mem,
    request : Types.MutateRequest,
    body : Blob,
    oldJobId : Nat64,
) {
    let beforeJob = Map.get(mem.delete_jobs, Nat64.compare, oldJobId);
    let beforeNodes = mem.node_count;
    let beforeCiphertext = mem.committed_ciphertext_bytes;
    let beforePhysical = mem.physical_private_bytes;
    let beforeReceipts = Map.size(mem.private_receipts);
    switch (service.mutate(request, body)) {
        case (#ok(_)) {};
        case (value) Runtime.trap(
            "exact mutation replay failed: " # debug_show (value)
        );
    };
    assert (
        Map.get(mem.delete_jobs, Nat64.compare, oldJobId) ==
        beforeJob
    );
    assert (mem.node_count == beforeNodes);
    assert (mem.committed_ciphertext_bytes == beforeCiphertext);
    assert (mem.physical_private_bytes == beforePhysical);
    assert (Map.size(mem.private_receipts) == beforeReceipts);
};

func privateStatusTarget(
    nodeId : Types.Id128
) : Types.OperationTarget {
    #private_write({
        nodes = [{
            node_id = nodeId;
            content_id = null;
        }];
    });
};

func privateAbortTarget(
    stageId : Nat64
) : Types.OperationTarget {
    #abort({
        stage_id = stageId;
    });
};

func privateStatusStage(
    requestId : Types.Id128,
    nodeId : Types.Id128,
    expiresAt : Nat64,
) : Memory.PrivateStage {
    let base : Memory.PrivateStage = {
        request_id = requestId;
        request_fingerprint = FramesTag(requestId.lo);
        created_at_ns = 0;
        last_activity_at_ns = 0;
        expires_at_ns = expiresAt;
        frame_count = 1;
        accepted_frame_bitmap = Fixtures.zeros(1);
        frame_fingerprints = [null];
        frames = [{
            ordinal = 0;
            encoded_bytes = 0;
            blocks = [];
        }];
        commit_plan = {
            intent = #create;
            node_mutations = [{
                node_id = nodeId;
                expected = null;
                replacement = ?root();
            }];
            child_index_mutations = [];
            retired_contents = [];
            node_count_delta = #increase(1);
            committed_plaintext_delta = #unchanged;
            committed_ciphertext_delta = #unchanged;
            final_physical_bytes = 0;
        };
        accepted_ciphertext_bytes = 0;
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

func installPrivateStatusStage(
    mem : Memory.Mem,
    stageId : Nat64,
    stage : Memory.PrivateStage,
) {
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
    mem.next_stage_id := stageId + 1;
    mem.physical_private_bytes +=
        Accounting.privateStageCharge(stage) +
        Accounting.stageRequestIndexCharge();
    mem.reserved_physical_private_bytes +=
        stage.reserved_physical_bytes;
    mem.reserved_cleanup_jobs +=
        Nat8.toNat(stage.reserved_cleanup_jobs);
};

func expiringTenBlockStage(
    requestId : Types.Id128,
    targetNodeId : Types.Id128,
    contentId : Types.Id128,
) : Memory.PrivateStage {
    let blocks = Array.tabulate<Memory.StageBlock>(
        Types.MAX_CLEANUP_BLOCKS_PER_PAGE + 1,
        func(index) {
            {
                content_id = contentId;
                block_index = Nat32.fromNat(index);
                ciphertext_bytes = 1;
                frame_ordinal = 0;
                payload_offset = Nat32.fromNat(index);
                payload_length = 1;
            };
        },
    );
    let base : Memory.PrivateStage = {
        request_id = requestId;
        request_fingerprint = FramesTag(requestId.lo);
        created_at_ns = 0;
        last_activity_at_ns = 0;
        expires_at_ns = 0;
        frame_count = 1;
        accepted_frame_bitmap = Blob.fromArray([1]);
        frame_fingerprints = [?FramesTag(requestId.lo + 1)];
        frames = [{
            ordinal = 0;
            encoded_bytes = Nat32.fromNat(blocks.size());
            blocks;
        }];
        commit_plan = {
            intent = #create;
            node_mutations = [{
                node_id = targetNodeId;
                expected = null;
                replacement = ?emptyFolder(
                    Types.ROOT_NODE_ID,
                    FramesTag(requestId.lo + 2),
                );
            }];
            child_index_mutations = [];
            retired_contents = [];
            node_count_delta = #increase(1);
            committed_plaintext_delta = #unchanged;
            committed_ciphertext_delta = #unchanged;
            final_physical_bytes = 0;
        };
        accepted_ciphertext_bytes = blocks.size();
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

func installExpiringTenBlockStage(
    mem : Memory.Mem,
    stageId : Nat64,
    stage : Memory.PrivateStage,
) {
    for (frame in stage.frames.values()) {
        for (block in frame.blocks.values()) {
            let body = Fixtures.zeros(
                Nat32.toNat(block.ciphertext_bytes)
            );
            Map.add(
                mem.blocks,
                Keys.compareBlockKey,
                Keys.blockKey(block.content_id, block.block_index),
                body,
            );
            mem.physical_private_bytes +=
                Accounting.blockCharge(body.size());
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
    mem.next_stage_id := stageId + 1;
    mem.staged_ciphertext_bytes += stage.accepted_ciphertext_bytes;
    mem.reserved_physical_private_bytes +=
        stage.reserved_physical_bytes;
    mem.reserved_cleanup_jobs +=
        Nat8.toNat(stage.reserved_cleanup_jobs);
    mem.physical_private_bytes +=
        Accounting.privateStageCharge(stage) +
        Accounting.stageRequestIndexCharge();
};

func status(
    files : Service.Service,
    requestId : Types.Id128,
    target : Types.OperationTarget,
) : Types.Result<Types.OperationStatusOk> {
    files.operationStatus({
        request_id = requestId;
        target = ?target;
    });
};

func assertUnknownStatus(
    result : Types.Result<Types.OperationStatusOk>
) {
    switch (result) {
        case (#ok(value)) assert (value.state == ?#unknown);
        case (_) assert false;
    };
};

func assertExpiredStatus(
    result : Types.Result<Types.OperationStatusOk>,
    terminalAt : Nat64,
    reconcileUntil : Nat64,
) {
    switch (result) {
        case (#ok(value)) switch (value.state) {
            case (?#expired(terminal)) {
                assert (terminal.terminal_at_ns == terminalAt);
                assert (
                    terminal.reconcile_until_ns == reconcileUntil
                );
            };
            case (_) assert false;
        };
        case (_) assert false;
    };
};

func assertAbortedStatus(
    result : Types.Result<Types.OperationStatusOk>,
    terminalAt : Nat64,
    reconcileUntil : Nat64,
) {
    switch (result) {
        case (#ok(value)) switch (value.state) {
            case (?#aborted(terminal)) {
                assert (terminal.terminal_at_ns == terminalAt);
                assert (
                    terminal.reconcile_until_ns == reconcileUntil
                );
            };
            case (_) assert false;
        };
        case (_) assert false;
    };
};

// Initialize is itself capped by the same 65,536-byte transport. Its Candid
// control is 98 bytes larger than VaultRead at the maximum 2,048-byte root
// metadata shape, so the largest valid initialize yields a future read 98
// bytes below the limit. Exact max input succeeds; max+1 is rejected without
// creating even the vault/root/receipt baseline.
let vaultBoundaryMetadataBytes = Types.MAX_METADATA_BYTES;
let initializeBoundaryRequestId = Fixtures.id(18_000);
let initializeProbe = initializeBodyWithLengths(
    initializeBoundaryRequestId,
    1,
    vaultBoundaryMetadataBytes,
);
let initializeOverhead =
    initializeProbe.size() - 1 - vaultBoundaryMetadataBytes;
let initializeBoundaryWrapperBytes =
    Types.MAX_VAULT_FRAME_BYTES -
    initializeOverhead -
    vaultBoundaryMetadataBytes;
let initializeBoundaryBody = initializeBodyWithLengths(
    initializeBoundaryRequestId,
    initializeBoundaryWrapperBytes,
    vaultBoundaryMetadataBytes,
);
assert (
    initializeBoundaryBody.size() ==
    Types.MAX_VAULT_FRAME_BYTES
);
let initializeBoundaryMem = Memory.init();
let initializeBoundaryService = Service.Service(
    initializeBoundaryMem,
    Fixtures.assets(Fixtures.zeroUsage()),
    func() : Nat64 { 0 },
);
switch (
    initializeBoundaryService.vaultWrite(
        vaultRequest(
            initializeBoundaryRequestId,
            initializeBoundaryBody.size(),
        ),
        initializeBoundaryBody,
    )
) {
    case (#ok(value)) assert (value.initialized);
    case (value) Runtime.trap(
        "maximum initialize failed: " # debug_show (value)
    );
};
let initializeReadBytes = switch (
    initializeBoundaryService.bootstrap()
) {
    case (#ok(value)) value.body.size();
    case (value) Runtime.trap(
        "maximum initialize bootstrap failed: " #
        debug_show (value)
    );
};
assert (
    initializeReadBytes ==
    Types.MAX_VAULT_FRAME_BYTES - 98
);
assertPrivateCounters(initializeBoundaryMem, 1);

let initializePlusOneMem = Memory.init();
let initializePlusOneService = Service.Service(
    initializePlusOneMem,
    Fixtures.assets(Fixtures.zeroUsage()),
    func() : Nat64 { 0 },
);
let initializePlusOneRequestId = Fixtures.id(18_001);
let initializePlusOneBody = initializeBodyWithLengths(
    initializePlusOneRequestId,
    initializeBoundaryWrapperBytes + 1,
    vaultBoundaryMetadataBytes,
);
assert (
    initializePlusOneBody.size() ==
    Types.MAX_VAULT_FRAME_BYTES + 1
);
assertReason(
    initializePlusOneService.vaultWrite(
        vaultRequest(
            initializePlusOneRequestId,
            initializePlusOneBody.size(),
        ),
        initializePlusOneBody,
    ),
    #invalid_request,
);
assert (initializePlusOneMem.vault == null);
assert (Map.size(initializePlusOneMem.nodes_by_id) == 0);
assert (Map.size(initializePlusOneMem.private_receipts) == 0);
assert (Map.size(initializePlusOneMem.delete_jobs) == 0);
assert (initializePlusOneMem.node_count == 0);
assert (initializePlusOneMem.committed_ciphertext_bytes == 0);
assert (initializePlusOneMem.physical_private_bytes == 0);

// Rewrap carries only the proposed wrapper, so it can fit the update while the
// future VaultRead (wrapper plus stored root metadata) reaches or exceeds its
// cap. Exact future size commits and bootstraps at 65,536 bytes. Adding one
// wrapper byte returns quota before admission cleanup, receipt insertion, or
// any stable/counter mutation.
let exactReadMem = Memory.init();
installVaultRootWithMetadata(
    exactReadMem,
    vaultBoundaryMetadataBytes,
);
let ?exactReadCurrent = exactReadMem.vault else {
    Runtime.trap("missing exact read vault")
};
let exactReadRequestId = Fixtures.id(18_010);
let exactReadRoot = nodeAt(
    exactReadMem,
    Types.ROOT_NODE_ID,
);
let exactReadProbeVault : Memory.VaultRecord = {
    exactReadCurrent with
    slot_generation = exactReadCurrent.slot_generation + 1;
    public_key_fingerprint =
        Frames.digestToTag(Fixtures.digest(exactReadRequestId.lo));
    ibe_wrapped_root_key = Fixtures.zeros(1);
    record_revision = exactReadCurrent.record_revision + 1;
};
let ?exactReadProbe = vaultReadBodyForTest(
    exactReadProbeVault,
    exactReadRoot,
) else Runtime.trap("small VaultRead probe failed");
let readOverhead =
    exactReadProbe.size() - 1 - vaultBoundaryMetadataBytes;
let exactReadWrapperBytes =
    Types.MAX_VAULT_FRAME_BYTES -
    readOverhead -
    vaultBoundaryMetadataBytes;
let exactReadBody = rewrapBodyWithLength(
    exactReadRequestId,
    exactReadCurrent,
    exactReadWrapperBytes,
);
assert (exactReadBody.size() < Types.MAX_VAULT_FRAME_BYTES);
let exactReadService = Service.Service(
    exactReadMem,
    Fixtures.assets(Fixtures.zeroUsage()),
    func() : Nat64 { 0 },
);
switch (
    exactReadService.vaultWrite(
        rewrapRequest(
            exactReadRequestId,
            exactReadCurrent,
            exactReadBody.size(),
        ),
        exactReadBody,
    )
) {
    case (#ok(value)) {
        assert (not value.initialized);
        assert (value.record_revision == 2);
    };
    case (value) Runtime.trap(
        "exact VaultRead rewrap failed: " # debug_show (value)
    );
};
let ?exactReadReplacement = exactReadMem.vault else {
    Runtime.trap("exact VaultRead replacement missing")
};
assert (
    exactReadReplacement.ibe_wrapped_root_key.size() ==
    exactReadWrapperBytes
);
switch (exactReadService.bootstrap()) {
    case (#ok(value)) {
        assert (value.body.size() == Types.MAX_VAULT_FRAME_BYTES);
        assert (
            Nat32.toNat(value.value.body_bytes) ==
            Types.MAX_VAULT_FRAME_BYTES
        );
    };
    case (value) Runtime.trap(
        "exact VaultRead bootstrap failed: " # debug_show (value)
    );
};
assertPrivateCounters(exactReadMem, 1);

let oversizedReadMem = Memory.init();
installVaultRootWithMetadata(
    oversizedReadMem,
    vaultBoundaryMetadataBytes,
);
ignore addContentCleanupJob(
    oversizedReadMem,
    1,
    Fixtures.id(18_020),
    1,
    1,
);
oversizedReadMem.next_job_id := 2;
let ?oversizedReadCurrent = oversizedReadMem.vault else {
    Runtime.trap("missing oversized read vault")
};
let oversizedReadRootBefore = nodeAt(
    oversizedReadMem,
    Types.ROOT_NODE_ID,
);
let oversizedReadJobBefore = Map.get(
    oversizedReadMem.delete_jobs,
    Nat64.compare,
    (1 : Nat64),
);
let oversizedReadPhysicalBefore =
    oversizedReadMem.physical_private_bytes;
let oversizedReadRequestId = Fixtures.id(18_021);
let oversizedReadBody = rewrapBodyWithLength(
    oversizedReadRequestId,
    oversizedReadCurrent,
    exactReadWrapperBytes + 1,
);
assert (oversizedReadBody.size() < Types.MAX_VAULT_FRAME_BYTES);
let oversizedReadService = Service.Service(
    oversizedReadMem,
    Fixtures.assets(Fixtures.zeroUsage()),
    func() : Nat64 { 0 },
);
assertReason(
    oversizedReadService.vaultWrite(
        rewrapRequest(
            oversizedReadRequestId,
            oversizedReadCurrent,
            oversizedReadBody.size(),
        ),
        oversizedReadBody,
    ),
    #quota,
);
assert (oversizedReadMem.vault == ?oversizedReadCurrent);
assert (
    nodeAt(oversizedReadMem, Types.ROOT_NODE_ID) ==
    oversizedReadRootBefore
);
assert (
    Map.get(
        oversizedReadMem.delete_jobs,
        Nat64.compare,
        (1 : Nat64),
    ) == oversizedReadJobBefore
);
assert (Map.size(oversizedReadMem.blocks) == 1);
assert (Map.size(oversizedReadMem.private_receipts) == 0);
assert (Map.size(oversizedReadMem.private_receipts_by_expiry) == 0);
assert (Map.size(
    oversizedReadMem.private_receipt_identity_owners
) == 0);
assert (oversizedReadMem.next_job_id == 2);
assert (oversizedReadMem.node_count == 1);
assert (
    oversizedReadMem.committed_ciphertext_bytes ==
    vaultBoundaryMetadataBytes
);
assert (
    oversizedReadMem.physical_private_bytes ==
    oversizedReadPhysicalBefore
);
assertPrivateCounters(oversizedReadMem, 1);

// Vault initialization accepts only the exact empty schema state. Orphan
// counters, blocks/jobs, and retained receipts are corruption, and validation
// rejects them before admission cleanup can mutate any of those rows.
let corruptAbsentMem = Memory.init();
fillReceipts(corruptAbsentMem, 1, 0);
ignore addContentCleanupJob(
    corruptAbsentMem,
    1,
    Fixtures.id(19_000),
    1,
    1,
);
corruptAbsentMem.next_job_id := 2;
corruptAbsentMem.node_count := 1;
let corruptAbsentRequestId = Fixtures.id(19_001);
let corruptAbsentBody =
    Fixtures.vaultInitializeBody(corruptAbsentRequestId);
let corruptAbsentService = Service.Service(
    corruptAbsentMem,
    Fixtures.assets(Fixtures.zeroUsage()),
    func() : Nat64 { 0 },
);
assertReason(
    corruptAbsentService.vaultWrite(
        vaultRequest(
            corruptAbsentRequestId,
            corruptAbsentBody.size(),
        ),
        corruptAbsentBody,
    ),
    #corrupt_state,
);
assert (corruptAbsentMem.vault == null);
assert (Map.size(corruptAbsentMem.blocks) == 1);
assert (Map.size(corruptAbsentMem.delete_jobs) == 1);
assert (Map.size(corruptAbsentMem.private_receipts) == 1);
assert (Map.size(corruptAbsentMem.private_receipts_by_expiry) == 1);

// 9,999 retained outcomes admit the 10,000th. A full 10,000-lane map rejects
// with busy (not quota), and exact expiry advances one aggregate receipt page
// before admitting the new lane.
let nearFullMem = Memory.init();
installVaultRoot(nearFullMem);
fillReceipts(
    nearFullMem,
    Types.MAX_PRIVATE_RECEIPTS - 1,
    Types.RECEIPT_RETENTION_NS,
);
let nearFullVault = vault();
let nearFullRequestId = Fixtures.id(20_000);
let nearFullBody = rewrapBody(
    nearFullRequestId,
    nearFullVault,
);
let nearFullService = Service.Service(
    nearFullMem,
    Fixtures.assets(Fixtures.zeroUsage()),
    func() : Nat64 { 0 },
);
switch (
    nearFullService.vaultWrite(
        rewrapRequest(
            nearFullRequestId,
            nearFullVault,
            nearFullBody.size(),
        ),
        nearFullBody,
    )
) {
    case (#ok(_)) {};
    case (_) assert false;
};
assert (
    Map.size(nearFullMem.private_receipts) ==
    Types.MAX_PRIVATE_RECEIPTS
);

var clock : Nat64 = 0;
let fullMem = Memory.init();
installVaultRoot(fullMem);
fillReceipts(
    fullMem,
    Types.MAX_PRIVATE_RECEIPTS,
    Types.RECEIPT_RETENTION_NS,
);
let fullVault = vault();
let fullRequestId = Fixtures.id(20_001);
let fullBody = rewrapBody(fullRequestId, fullVault);
let fullService = Service.Service(
    fullMem,
    Fixtures.assets(Fixtures.zeroUsage()),
    func() { clock },
);
switch (
    fullService.vaultWrite(
        rewrapRequest(
            fullRequestId,
            fullVault,
            fullBody.size(),
        ),
        fullBody,
    )
) {
    case (#err(error)) {
        if (
            error.reason != ?#busy or
            error.retry_after_ns != ?Types.RECEIPT_RETENTION_NS
        ) Runtime.trap(
            "unexpected full receipt lane result: " # debug_show (error)
        );
        assert (error.reason == ?#busy);
        assert (error.retry_after_ns == ?Types.RECEIPT_RETENTION_NS);
    };
    case (_) assert false;
};
assert (fullMem.vault == ?fullVault);
clock := Types.RECEIPT_RETENTION_NS;
switch (
    fullService.vaultWrite(
        rewrapRequest(
            fullRequestId,
            fullVault,
            fullBody.size(),
        ),
        fullBody,
    )
) {
    case (#ok(_)) {};
    case (_) assert false;
};
assert (
    Map.size(fullMem.private_receipts) ==
    Types.MAX_PRIVATE_RECEIPTS -
        Types.MAX_CLEANUP_ENTRIES_PER_PAGE / 2 + 1
);

// Hitting the nine-block stop closes the aggregate page. Even though the
// receipt lane is full of rows that are due at the same instant, admission
// cannot reset a second page to prune one more receipt.
let fullLaneBlockMem = Memory.init();
installVaultRoot(fullLaneBlockMem);
fillReceipts(
    fullLaneBlockMem,
    Types.MAX_PRIVATE_RECEIPTS,
    0,
);
ignore addContentCleanupJob(
    fullLaneBlockMem,
    1,
    Fixtures.id(40_000),
    Types.MAX_CLEANUP_BLOCKS_PER_PAGE,
    1,
);
fullLaneBlockMem.next_job_id := 2;
let fullLaneBlockVault = vault();
let fullLaneBlockRequestId = Fixtures.id(40_001);
let fullLaneBlockBody = rewrapBody(
    fullLaneBlockRequestId,
    fullLaneBlockVault,
);
let fullLaneBlockService = Service.Service(
    fullLaneBlockMem,
    Fixtures.assets(Fixtures.zeroUsage()),
    func() : Nat64 { 0 },
);
assertReason(
    fullLaneBlockService.vaultWrite(
        rewrapRequest(
            fullLaneBlockRequestId,
            fullLaneBlockVault,
            fullLaneBlockBody.size(),
        ),
        fullLaneBlockBody,
    ),
    #busy,
);
assert (fullLaneBlockMem.vault == ?fullLaneBlockVault);
assert (Map.size(fullLaneBlockMem.blocks) == 0);
assert (Map.size(fullLaneBlockMem.delete_jobs) == 0);
assert (
    Map.size(fullLaneBlockMem.private_receipts) ==
    Types.MAX_PRIVATE_RECEIPTS
);

// An exact-due receipt lookup is read-only. When the ordinary page first hits
// the nine-block stop, the reused request id remains busy and its two rows are
// untouched. A retry gets a fresh page, prunes the old receipt in-order, and
// inserts the replacement without leaving the old expiry index behind.
let exactExpiryPressureMem = Memory.init();
installVaultRoot(exactExpiryPressureMem);
fillReceipts(
    exactExpiryPressureMem,
    Types.MAX_PRIVATE_RECEIPTS,
    0,
);
ignore addContentCleanupJob(
    exactExpiryPressureMem,
    1,
    Fixtures.id(40_100),
    Types.MAX_CLEANUP_BLOCKS_PER_PAGE,
    1,
);
exactExpiryPressureMem.next_job_id := 2;
let exactExpiryRequestId = Fixtures.id(1);
let exactExpiryVault = vault();
let exactExpiryBody = rewrapBody(
    exactExpiryRequestId,
    exactExpiryVault,
);
let exactExpiryPressureService = Service.Service(
    exactExpiryPressureMem,
    Fixtures.assets(Fixtures.zeroUsage()),
    func() : Nat64 { 0 },
);
assertReason(
    exactExpiryPressureService.vaultWrite(
        rewrapRequest(
            exactExpiryRequestId,
            exactExpiryVault,
            exactExpiryBody.size(),
        ),
        exactExpiryBody,
    ),
    #busy,
);
assert (Map.size(exactExpiryPressureMem.blocks) == 0);
assert (Map.size(exactExpiryPressureMem.delete_jobs) == 0);
assert (
    Map.size(exactExpiryPressureMem.private_receipts) ==
        Types.MAX_PRIVATE_RECEIPTS
);
assert (
    Map.get(
        exactExpiryPressureMem.private_receipts_by_expiry,
        Keys.comparePrivateReceiptExpiryKey,
        (
            0 : Nat64,
            exactExpiryRequestId.hi,
            exactExpiryRequestId.lo,
        ),
    ) == ?()
);
switch (
    exactExpiryPressureService.vaultWrite(
        rewrapRequest(
            exactExpiryRequestId,
            exactExpiryVault,
            exactExpiryBody.size(),
        ),
        exactExpiryBody,
    )
) {
    case (#ok(_)) {};
    case (value) Runtime.trap(
        "exact-expiry retry failed: " # debug_show (value)
    );
};
assert (
    Map.size(exactExpiryPressureMem.private_receipts) ==
        Types.MAX_PRIVATE_RECEIPTS -
            Types.MAX_CLEANUP_ENTRIES_PER_PAGE / 2 + 1
);
assert (
    Map.size(
        exactExpiryPressureMem.private_receipts_by_expiry
    ) == Map.size(exactExpiryPressureMem.private_receipts)
);
assert (
    Map.get(
        exactExpiryPressureMem.private_receipts_by_expiry,
        Keys.comparePrivateReceiptExpiryKey,
        (
            0 : Nat64,
            exactExpiryRequestId.hi,
            exactExpiryRequestId.lo,
        ),
    ) == null
);
let ?replacementExactReceipt = Map.get(
    exactExpiryPressureMem.private_receipts,
    Keys.compareId128,
    exactExpiryRequestId,
) else Runtime.trap("exact-expiry replacement receipt missing");
assert (
    replacementExactReceipt.expires_at_ns ==
        Types.RECEIPT_RETENTION_NS
);

// Physical pressure advances only nine blocks, then recomputes admission.
// The first positive mutation succeeds using the reclaimed charge while the
// tenth block and its job remain for a later page.
let physicalRemainderMem = Memory.init();
installVaultRoot(physicalRemainderMem);
ignore addContentCleanupJob(
    physicalRemainderMem,
    1,
    Fixtures.id(41_000),
    Types.MAX_CLEANUP_BLOCKS_PER_PAGE + 1,
    1_000,
);
physicalRemainderMem.next_job_id := 2;
physicalRemainderMem.physical_private_bytes :=
    Types.MAX_PHYSICAL_PRIVATE_BYTES - rewrapAdmissionCharge + 1;
let physicalRemainderVault = vault();
let physicalRemainderRequestId = Fixtures.id(41_001);
let physicalRemainderBody = rewrapBody(
    physicalRemainderRequestId,
    physicalRemainderVault,
);
let physicalRemainderService = Service.Service(
    physicalRemainderMem,
    Fixtures.assets(Fixtures.zeroUsage()),
    func() : Nat64 { 0 },
);
switch (
    physicalRemainderService.vaultWrite(
        rewrapRequest(
            physicalRemainderRequestId,
            physicalRemainderVault,
            physicalRemainderBody.size(),
        ),
        physicalRemainderBody,
    )
) {
    case (#ok(_)) {};
    case (value) Runtime.trap(
        "cleanup-backed vault admission failed: " # debug_show (value)
    );
};
assert (Map.size(physicalRemainderMem.blocks) == 1);
assert (Map.size(physicalRemainderMem.delete_jobs) == 1);
assert (
    physicalRemainderMem.physical_private_bytes <=
    Types.MAX_PHYSICAL_PRIVATE_BYTES
);

// Eight occupied cleanup slots do not permanently block a remove. Its fully
// validated detach plan first advances the shared page. The oldest job consumes
// the exact nine-block budget, so the newly detached file must remain pending:
// remove cannot reset a second page to finish it synchronously.
let removePressureMem = Memory.init();
let removedNodeId = Fixtures.id(42_000);
let removedNameTag : Memory.Tag256 = (0, 0, 0, 42_001);
installRemovableFile(
    removePressureMem,
    removedNodeId,
    removedNameTag,
);
var oldJobId : Nat64 = 1;
while (oldJobId <= Nat64.fromNat(Types.MAX_CLEANUP_JOBS)) {
    ignore addContentCleanupJob(
        removePressureMem,
        oldJobId,
        Fixtures.id(42_100 + Nat64.toNat(oldJobId)),
        if (oldJobId == 1) {
            Types.MAX_CLEANUP_BLOCKS_PER_PAGE
        } else 0,
        if (oldJobId == 1) 1 else 0,
    );
    oldJobId += 1;
};
removePressureMem.next_job_id :=
    Nat64.fromNat(Types.MAX_CLEANUP_JOBS + 1);
let removePressureService = Service.Service(
    removePressureMem,
    Fixtures.assets(Fixtures.zeroUsage()),
    func() : Nat64 { 0 },
);
switch (
    removePressureService.remove({
        request_id = Fixtures.id(42_500);
        node_id = removedNodeId;
        expected_structural_revision = 1;
        expected_parent_id = Types.ROOT_NODE_ID;
        expected_parent_children_revision = 1;
        recursive = false;
    })
) {
    case (#ok(value)) {
        assert (value.node_id == removedNodeId);
        assert (value.reclaimed_entries == 0);
        assert (value.reclaimed_ciphertext_bytes == 0);
        switch (value.cleanup_state) {
            case (?#pending(state)) {
                assert (
                    state.remaining_jobs ==
                        Nat16.fromNat(Types.MAX_CLEANUP_JOBS)
                );
            };
            case (_) assert false;
        };
    };
    case (value) Runtime.trap(
        "cleanup-backed remove admission failed: " # debug_show (value)
    );
};
assert (
    Map.size(removePressureMem.delete_jobs) ==
        Types.MAX_CLEANUP_JOBS
);
assert (Map.size(removePressureMem.blocks) == 0);
let ?pendingRemovedNode = Map.get(
    removePressureMem.nodes_by_id,
    Keys.compareId128,
    removedNodeId,
) else Runtime.trap("detached node disappeared on a closed page");
switch (pendingRemovedNode.state) {
    case (#hidden(state)) {
        assert (
            state.cleanup_job_id ==
                Nat64.fromNat(Types.MAX_CLEANUP_JOBS + 1)
        );
    };
    case (_) assert false;
};
assert (removePressureMem.node_count == 2);
assert (removePressureMem.committed_ciphertext_bytes == 32);

// A metadata mutation at the physical ceiling uses the same pressure page.
// Nine blocks are reclaimed, the create commits, and the residual job remains.
let mutatePressureMem = Memory.init();
let mutateVault = vault();
let mutateRoot = root();
mutatePressureMem.vault := ?mutateVault;
Map.add(
    mutatePressureMem.nodes_by_id,
    Keys.compareId128,
    Types.ROOT_NODE_ID,
    mutateRoot,
);
mutatePressureMem.node_count := 1;
mutatePressureMem.committed_ciphertext_bytes :=
    mutateRoot.encrypted_metadata.size();
ignore addContentCleanupJob(
    mutatePressureMem,
    1,
    Fixtures.id(43_000),
    Types.MAX_CLEANUP_BLOCKS_PER_PAGE + 1,
    1_000,
);
mutatePressureMem.next_job_id := 2;
mutatePressureMem.physical_private_bytes :=
    Types.MAX_PHYSICAL_PRIVATE_BYTES;
let createdFolderId = Fixtures.id(43_001);
let createdFolderTag = Fixtures.digest(43_002);
let mutateControl : Frames.MutateFrameControl = {
    request_id = Fixtures.id(43_003);
    action = ?#create_folder;
    node = {
        node_id = createdFolderId;
        expected_parent_id = null;
        proposed_parent_id = Types.ROOT_NODE_ID;
        requested_kind = ?#folder;
        expected_name_tag = null;
        proposed_name_tag = createdFolderTag;
        declared_name_scalars = 1;
        expected_structural_revision = null;
        proposed_structural_revision = 1;
        expected_metadata_revision = null;
        proposed_metadata_revision = 1;
        expected_children_revision = null;
        proposed_children_revision = 0;
        expected_subtree_height = null;
        proposed_subtree_height = 0;
        expected_max_relative_path_scalars = null;
        proposed_max_relative_path_scalars = 1;
        expected_subtree_plaintext_bytes = null;
        proposed_subtree_plaintext_bytes = 0;
        encrypted_metadata = { offset = 0; length = 16 };
    };
    folder_transitions = [{
        node_id = Types.ROOT_NODE_ID;
        expected_structural_revision = 1;
        expected_children_revision = 0;
    }];
    child_index_transitions = [{
        parent_id = Types.ROOT_NODE_ID;
        name_tag = createdFolderTag;
        expected_node_id = null;
        proposed_node_id = ?createdFolderId;
    }];
    raw_payload_bytes = 16;
};
let mutateBody = Fixtures.pack(
    to_candid (mutateControl),
    Fixtures.zeros(16),
);
let mutatePressureService = Service.Service(
    mutatePressureMem,
    Fixtures.assets(Fixtures.zeroUsage()),
    func() : Nat64 { 0 },
);
switch (
    mutatePressureService.mutate(
        {
            request_id = mutateControl.request_id;
            action = ?#create_folder;
            body_bytes = Nat32.fromNat(mutateBody.size());
        },
        mutateBody,
    )
) {
    case (#ok(value)) assert (value.node_id == createdFolderId);
    case (value) Runtime.trap(
        "cleanup-backed metadata admission failed: " # debug_show (value)
    );
};
assert (Map.size(mutatePressureMem.blocks) == 1);
assert (Map.size(mutatePressureMem.delete_jobs) == 1);
assert (
    mutatePressureMem.physical_private_bytes <=
    Types.MAX_PHYSICAL_PRIVATE_BYTES
);

// Admission cleanup must run before every structural plan. A detached
// 260-leaf subtree consumes exactly four 128-entry pages (64 node/index pairs
// per page), so mkdir, rename, move, and remove each observe a different
// post-cleanup absolute node/ciphertext state. Exact retries must return their
// receipts before advancing the old job again.
let counterMem = Memory.init();
let counterVault = vault();
let counterAId = Fixtures.id(50_001);
let counterBId = Fixtures.id(50_002);
let counterHiddenId = Fixtures.id(50_003);
let counterXId = Fixtures.id(50_004);
let counterATag = FramesTag(50_001);
let counterBTag = FramesTag(50_002);
let counterHiddenTag = FramesTag(50_003);
let counterXTag = FramesTag(50_004);
let counterRenamedTag = FramesTag(50_005);
let counterRoot : Memory.Node = {
    root() with
    kind = #folder({
        direct_child_count = 2;
        child_subtree_heights = [{ value = 0; count = 2 }];
        child_relative_path_scalars = [{ value = 1; count = 2 }];
    });
    children_revision = 1;
    subtree_height = 1;
    max_relative_path_scalars = 1;
};
let counterA = emptyFolder(Types.ROOT_NODE_ID, counterATag);
let counterB = emptyFolder(Types.ROOT_NODE_ID, counterBTag);
let counterHidden : Memory.Node = {
    parent_id = Types.ROOT_NODE_ID;
    kind = #folder({
        direct_child_count = 260;
        child_subtree_heights = [{ value = 0; count = 260 }];
        child_relative_path_scalars = [{ value = 1; count = 260 }];
    });
    state = #hidden({ cleanup_job_id = 1; hidden_at_ns = 0 });
    name_tag = counterHiddenTag;
    declared_name_scalars = 1;
    structural_revision = 1;
    metadata_revision = 1;
    children_revision = 1;
    subtree_height = 1;
    max_relative_path_scalars = 3;
    subtree_plaintext_bytes = 0;
    encrypted_metadata = Fixtures.zeros(16);
};
counterMem.vault := ?counterVault;
Map.add(
    counterMem.nodes_by_id,
    Keys.compareId128,
    Types.ROOT_NODE_ID,
    counterRoot,
);
addIndexedNode(counterMem, counterAId, counterA);
addIndexedNode(counterMem, counterBId, counterB);
Map.add(
    counterMem.nodes_by_id,
    Keys.compareId128,
    counterHiddenId,
    counterHidden,
);
var counterLeaf = 0;
while (counterLeaf < 260) {
    let leafId = Fixtures.id(51_000 + counterLeaf);
    addIndexedNode(
        counterMem,
        leafId,
        emptyFolder(
            counterHiddenId,
            FramesTag(Nat64.fromNat(51_000 + counterLeaf)),
        ),
    );
    counterLeaf += 1;
};
let counterOldJob : Memory.DeleteJob = {
    job_id = 1;
    kind = #subtree({
        root_id = counterHiddenId;
        stack = [{
            node_id = counterHiddenId;
            after_child_tag = null;
            entered = false;
        }];
    });
    created_at_ns = 0;
    updated_at_ns = 0;
    reclaimed_entries = 0;
    reclaimed_ciphertext_bytes = 0;
};
Map.add(
    counterMem.delete_jobs,
    Nat64.compare,
    (1 : Nat64),
    counterOldJob,
);
counterMem.next_job_id := 2;
counterMem.node_count := Map.size(counterMem.nodes_by_id);
counterMem.committed_ciphertext_bytes :=
    committedCiphertextFromNodes(counterMem);
counterMem.physical_private_bytes :=
    privatePhysicalFromRows(counterMem);
assertPrivateCounters(counterMem, 264);
assert (counterMem.committed_ciphertext_bytes == 4_224);
assert (Map.size(counterMem.children_by_name) == 262);
let counterService = Service.Service(
    counterMem,
    Fixtures.assets(Fixtures.zeroUsage()),
    func() : Nat64 { 0 },
);

let counterCreateControl : Frames.MutateFrameControl = {
    request_id = Fixtures.id(52_001);
    action = ?#create_folder;
    node = {
        node_id = counterXId;
        expected_parent_id = null;
        proposed_parent_id = counterAId;
        requested_kind = ?#folder;
        expected_name_tag = null;
        proposed_name_tag = Frames.digestFromTag(counterXTag);
        declared_name_scalars = 1;
        expected_structural_revision = null;
        proposed_structural_revision = 1;
        expected_metadata_revision = null;
        proposed_metadata_revision = 1;
        expected_children_revision = null;
        proposed_children_revision = 0;
        expected_subtree_height = null;
        proposed_subtree_height = 0;
        expected_max_relative_path_scalars = null;
        proposed_max_relative_path_scalars = 1;
        expected_subtree_plaintext_bytes = null;
        proposed_subtree_plaintext_bytes = 0;
        encrypted_metadata = { offset = 0; length = 16 };
    };
    folder_transitions = [
        folderWitness(counterMem, Types.ROOT_NODE_ID),
        folderWitness(counterMem, counterAId),
    ];
    child_index_transitions = [{
        parent_id = counterAId;
        name_tag = Frames.digestFromTag(counterXTag);
        expected_node_id = null;
        proposed_node_id = ?counterXId;
    }];
    raw_payload_bytes = 16;
};
let (
    counterCreateRequest,
    counterCreateBody,
    counterCreateResult,
) = mutateFrame(counterService, counterCreateControl);
assert (counterCreateResult.node_id == counterXId);
assertPrivateCounters(counterMem, 201);
assert (counterMem.committed_ciphertext_bytes == 3_216);
assert (Map.size(counterMem.children_by_name) == 199);
assert (
    Map.get(
        counterMem.children_by_name,
        Keys.compareChildNameKey,
        Keys.childNameKey(counterAId, counterXTag),
    ) == ?counterXId
);
replayMutationWithoutCleanup(
    counterService,
    counterMem,
    counterCreateRequest,
    counterCreateBody,
    1,
);

let counterXBeforeRename = nodeAt(counterMem, counterXId);
let counterRenameControl : Frames.MutateFrameControl = {
    request_id = Fixtures.id(52_002);
    action = ?#rename;
    node = {
        node_id = counterXId;
        expected_parent_id = ?counterXBeforeRename.parent_id;
        proposed_parent_id = counterXBeforeRename.parent_id;
        requested_kind = ?#folder;
        expected_name_tag =
            ?Frames.digestFromTag(counterXBeforeRename.name_tag);
        proposed_name_tag =
            Frames.digestFromTag(counterRenamedTag);
        declared_name_scalars = 1;
        expected_structural_revision =
            ?counterXBeforeRename.structural_revision;
        proposed_structural_revision =
            counterXBeforeRename.structural_revision + 1;
        expected_metadata_revision =
            ?counterXBeforeRename.metadata_revision;
        proposed_metadata_revision =
            counterXBeforeRename.metadata_revision + 1;
        expected_children_revision =
            ?counterXBeforeRename.children_revision;
        proposed_children_revision =
            counterXBeforeRename.children_revision;
        expected_subtree_height =
            ?counterXBeforeRename.subtree_height;
        proposed_subtree_height =
            counterXBeforeRename.subtree_height;
        expected_max_relative_path_scalars =
            ?counterXBeforeRename.max_relative_path_scalars;
        proposed_max_relative_path_scalars =
            counterXBeforeRename.max_relative_path_scalars;
        expected_subtree_plaintext_bytes = ?0;
        proposed_subtree_plaintext_bytes = 0;
        encrypted_metadata = { offset = 0; length = 16 };
    };
    folder_transitions = [
        folderWitness(counterMem, Types.ROOT_NODE_ID),
        folderWitness(counterMem, counterAId),
    ];
    child_index_transitions = [
        {
            parent_id = counterAId;
            name_tag = Frames.digestFromTag(counterXTag);
            expected_node_id = ?counterXId;
            proposed_node_id = null;
        },
        {
            parent_id = counterAId;
            name_tag = Frames.digestFromTag(counterRenamedTag);
            expected_node_id = null;
            proposed_node_id = ?counterXId;
        },
    ];
    raw_payload_bytes = 16;
};
let (
    counterRenameRequest,
    counterRenameBody,
    counterRenameResult,
) = mutateFrame(counterService, counterRenameControl);
assert (counterRenameResult.node_id == counterXId);
assertPrivateCounters(counterMem, 137);
assert (counterMem.committed_ciphertext_bytes == 2_192);
assert (Map.size(counterMem.children_by_name) == 135);
assert (
    Map.get(
        counterMem.children_by_name,
        Keys.compareChildNameKey,
        Keys.childNameKey(counterAId, counterXTag),
    ) == null
);
assert (
    Map.get(
        counterMem.children_by_name,
        Keys.compareChildNameKey,
        Keys.childNameKey(counterAId, counterRenamedTag),
    ) == ?counterXId
);
replayMutationWithoutCleanup(
    counterService,
    counterMem,
    counterRenameRequest,
    counterRenameBody,
    1,
);

let counterXBeforeMove = nodeAt(counterMem, counterXId);
let counterMoveControl : Frames.MutateFrameControl = {
    request_id = Fixtures.id(52_003);
    action = ?#move;
    node = {
        node_id = counterXId;
        expected_parent_id = ?counterXBeforeMove.parent_id;
        proposed_parent_id = counterBId;
        requested_kind = ?#folder;
        expected_name_tag =
            ?Frames.digestFromTag(counterXBeforeMove.name_tag);
        proposed_name_tag =
            Frames.digestFromTag(counterXBeforeMove.name_tag);
        declared_name_scalars = 1;
        expected_structural_revision =
            ?counterXBeforeMove.structural_revision;
        proposed_structural_revision =
            counterXBeforeMove.structural_revision + 1;
        expected_metadata_revision =
            ?counterXBeforeMove.metadata_revision;
        proposed_metadata_revision =
            counterXBeforeMove.metadata_revision + 1;
        expected_children_revision =
            ?counterXBeforeMove.children_revision;
        proposed_children_revision =
            counterXBeforeMove.children_revision;
        expected_subtree_height =
            ?counterXBeforeMove.subtree_height;
        proposed_subtree_height =
            counterXBeforeMove.subtree_height;
        expected_max_relative_path_scalars =
            ?counterXBeforeMove.max_relative_path_scalars;
        proposed_max_relative_path_scalars =
            counterXBeforeMove.max_relative_path_scalars;
        expected_subtree_plaintext_bytes = ?0;
        proposed_subtree_plaintext_bytes = 0;
        encrypted_metadata = { offset = 0; length = 16 };
    };
    folder_transitions = [
        folderWitness(counterMem, Types.ROOT_NODE_ID),
        folderWitness(counterMem, counterAId),
        folderWitness(counterMem, counterBId),
    ];
    child_index_transitions = [
        {
            parent_id = counterAId;
            name_tag =
                Frames.digestFromTag(counterRenamedTag);
            expected_node_id = ?counterXId;
            proposed_node_id = null;
        },
        {
            parent_id = counterBId;
            name_tag =
                Frames.digestFromTag(counterRenamedTag);
            expected_node_id = null;
            proposed_node_id = ?counterXId;
        },
    ];
    raw_payload_bytes = 16;
};
let (
    counterMoveRequest,
    counterMoveBody,
    counterMoveResult,
) = mutateFrame(counterService, counterMoveControl);
assert (counterMoveResult.parent_id == counterBId);
assertPrivateCounters(counterMem, 73);
assert (counterMem.committed_ciphertext_bytes == 1_168);
assert (Map.size(counterMem.children_by_name) == 71);
assert (
    Map.get(
        counterMem.children_by_name,
        Keys.compareChildNameKey,
        Keys.childNameKey(counterAId, counterRenamedTag),
    ) == null
);
assert (
    Map.get(
        counterMem.children_by_name,
        Keys.compareChildNameKey,
        Keys.childNameKey(counterBId, counterRenamedTag),
    ) == ?counterXId
);
replayMutationWithoutCleanup(
    counterService,
    counterMem,
    counterMoveRequest,
    counterMoveBody,
    1,
);

let counterXBeforeRemove = nodeAt(counterMem, counterXId);
let counterBParent = nodeAt(counterMem, counterBId);
let counterRemoveRequest : Types.RemoveRequest = {
    request_id = Fixtures.id(52_004);
    node_id = counterXId;
    expected_structural_revision =
        counterXBeforeRemove.structural_revision;
    expected_parent_id = counterBId;
    expected_parent_children_revision =
        counterBParent.children_revision;
    recursive = true;
};
switch (counterService.remove(counterRemoveRequest)) {
    case (#ok(value)) assert (value.node_id == counterXId);
    case (value) Runtime.trap(
        "counter regression remove failed: " # debug_show (value)
    );
};
assertPrivateCounters(counterMem, 9);
assert (counterMem.committed_ciphertext_bytes == 144);
assert (Map.size(counterMem.children_by_name) == 6);
assert (Map.size(counterMem.delete_jobs) == 2);
assert (
    Map.get(
        counterMem.children_by_name,
        Keys.compareChildNameKey,
        Keys.childNameKey(counterBId, counterRenamedTag),
    ) == null
);
let counterOldJobBeforeReplay =
    Map.get(counterMem.delete_jobs, Nat64.compare, (1 : Nat64));
let counterNewJobBeforeReplay =
    Map.get(counterMem.delete_jobs, Nat64.compare, (2 : Nat64));
let counterPhysicalBeforeRemoveReplay =
    counterMem.physical_private_bytes;
switch (counterService.remove(counterRemoveRequest)) {
    case (#ok(_)) {};
    case (value) Runtime.trap(
        "exact remove replay failed: " # debug_show (value)
    );
};
assert (
    Map.get(counterMem.delete_jobs, Nat64.compare, (1 : Nat64)) ==
    counterOldJobBeforeReplay
);
assert (
    Map.get(counterMem.delete_jobs, Nat64.compare, (2 : Nat64)) ==
    counterNewJobBeforeReplay
);
assert (
    counterMem.physical_private_bytes ==
    counterPhysicalBeforeRemoveReplay
);
assertPrivateCounters(counterMem, 9);

var counterCleanupCalls = 0;
while (
    Map.size(counterMem.delete_jobs) > 0 and
    counterCleanupCalls < 4
) {
    switch (counterService.cleanup()) {
        case (#ok(_)) {};
        case (value) Runtime.trap(
            "counter regression cleanup failed: " # debug_show (value)
        );
    };
    counterCleanupCalls += 1;
};
assert (Map.size(counterMem.delete_jobs) == 0);
assert (Map.size(counterMem.children_by_name) == 2);
assert (
    Map.get(
        counterMem.nodes_by_id,
        Keys.compareId128,
        counterHiddenId,
    ) == null
);
assert (
    Map.get(
        counterMem.nodes_by_id,
        Keys.compareId128,
        counterXId,
    ) == null
);
assertPrivateCounters(counterMem, 3);
assert (counterMem.committed_ciphertext_bytes == 48);

// Expiring a ten-block private stage during remove admission consumes the
// stage's reserved cleanup slot and allocates the current next_job_id for its
// one-block remainder. Remove must read the advanced counter and allocate a
// distinct subtree job; exact replay must not drain either job.
let collisionMem = Memory.init();
let collisionNodeId = Fixtures.id(53_001);
let collisionNodeTag = FramesTag(53_001);
installRemovableFile(
    collisionMem,
    collisionNodeId,
    collisionNodeTag,
);
let collisionStage = expiringTenBlockStage(
    Fixtures.id(53_002),
    Fixtures.id(53_003),
    Fixtures.id(53_004),
);
assert (collisionStage.reserved_cleanup_jobs == 1);
installExpiringTenBlockStage(
    collisionMem,
    1,
    collisionStage,
);
collisionMem.next_job_id := 2;
let collisionService = Service.Service(
    collisionMem,
    Fixtures.assets(Fixtures.zeroUsage()),
    func() : Nat64 { 0 },
);
let collisionRemoveRequest : Types.RemoveRequest = {
    request_id = Fixtures.id(53_005);
    node_id = collisionNodeId;
    expected_structural_revision = 1;
    expected_parent_id = Types.ROOT_NODE_ID;
    expected_parent_children_revision = 1;
    recursive = false;
};
switch (collisionService.remove(collisionRemoveRequest)) {
    case (#ok(value)) assert (value.node_id == collisionNodeId);
    case (value) Runtime.trap(
        "stage-expiry remove failed: " # debug_show (value)
    );
};
assert (collisionMem.next_job_id == 4);
assert (Map.size(collisionMem.delete_jobs) == 2);
assert (
    Map.get(
        collisionMem.delete_jobs,
        Nat64.compare,
        (2 : Nat64),
    ) != null
);
assert (
    Map.get(
        collisionMem.delete_jobs,
        Nat64.compare,
        (3 : Nat64),
    ) != null
);
assert (Map.size(collisionMem.blocks) == 1);
let collisionHiddenNode = nodeAt(collisionMem, collisionNodeId);
switch (collisionHiddenNode.state) {
    case (#hidden(value)) assert (value.cleanup_job_id == 3);
    case (_) assert false;
};
assertPrivateCounters(collisionMem, 2);
let collisionStageJobBeforeReplay = Map.get(
    collisionMem.delete_jobs,
    Nat64.compare,
    (2 : Nat64),
);
let collisionRemoveJobBeforeReplay = Map.get(
    collisionMem.delete_jobs,
    Nat64.compare,
    (3 : Nat64),
);
let collisionPhysicalBeforeReplay =
    collisionMem.physical_private_bytes;
switch (collisionService.remove(collisionRemoveRequest)) {
    case (#ok(_)) {};
    case (value) Runtime.trap(
        "stage-expiry exact remove replay failed: " #
        debug_show (value)
    );
};
assert (
    Map.get(
        collisionMem.delete_jobs,
        Nat64.compare,
        (2 : Nat64),
    ) == collisionStageJobBeforeReplay
);
assert (
    Map.get(
        collisionMem.delete_jobs,
        Nat64.compare,
        (3 : Nat64),
    ) == collisionRemoveJobBeforeReplay
);
assert (
    collisionMem.physical_private_bytes ==
    collisionPhysicalBeforeReplay
);
switch (collisionService.cleanup()) {
    case (#ok(_)) {};
    case (value) Runtime.trap(
        "stage-expiry cleanup failed: " # debug_show (value)
    );
};
assert (Map.size(collisionMem.delete_jobs) == 0);
assert (Map.size(collisionMem.blocks) == 0);
assert (
    Map.get(
        collisionMem.nodes_by_id,
        Keys.compareId128,
        collisionNodeId,
    ) == null
);
assert (Map.size(collisionMem.children_by_name) == 0);
assertPrivateCounters(collisionMem, 1);
assert (collisionMem.committed_ciphertext_bytes == 16);

// The same admission edge at max-1 allocates only the stage remainder job and
// advances the counter to max. Remove rechecks after cleanup and returns quota
// without trapping, wrapping, overwriting that job, or detaching its target.
let nearMaxJobMem = Memory.init();
let nearMaxNodeId = Fixtures.id(54_001);
let nearMaxNodeTag = FramesTag(54_001);
installRemovableFile(
    nearMaxJobMem,
    nearMaxNodeId,
    nearMaxNodeTag,
);
let nearMaxStage = expiringTenBlockStage(
    Fixtures.id(54_002),
    Fixtures.id(54_003),
    Fixtures.id(54_004),
);
installExpiringTenBlockStage(nearMaxJobMem, 1, nearMaxStage);
nearMaxJobMem.next_job_id := Nat64.maxValue - 1;
let nearMaxJobService = Service.Service(
    nearMaxJobMem,
    Fixtures.assets(Fixtures.zeroUsage()),
    func() : Nat64 { 0 },
);
let nearMaxRemoveRequestId = Fixtures.id(54_005);
assertReason(
    nearMaxJobService.remove({
        request_id = nearMaxRemoveRequestId;
        node_id = nearMaxNodeId;
        expected_structural_revision = 1;
        expected_parent_id = Types.ROOT_NODE_ID;
        expected_parent_children_revision = 1;
        recursive = false;
    }),
    #quota,
);
assert (nearMaxJobMem.next_job_id == Nat64.maxValue);
assert (Map.size(nearMaxJobMem.delete_jobs) == 1);
assert (
    Map.get(
        nearMaxJobMem.delete_jobs,
        Nat64.compare,
        Nat64.maxValue - 1,
    ) != null
);
assert (Map.size(nearMaxJobMem.blocks) == 1);
assert (
    Map.get(
        nearMaxJobMem.private_receipts,
        Keys.compareId128,
        nearMaxRemoveRequestId,
    ) == null
);
let nearMaxStillActive = nodeAt(nearMaxJobMem, nearMaxNodeId);
assert (nearMaxStillActive.state == #active);
assert (
    Map.get(
        nearMaxJobMem.children_by_name,
        Keys.compareChildNameKey,
        Keys.childNameKey(
            Types.ROOT_NODE_ID,
            nearMaxNodeTag,
        ),
    ) == ?nearMaxNodeId
);
assertPrivateCounters(nearMaxJobMem, 2);
assert (nearMaxJobMem.committed_ciphertext_bytes == 32);

// A private abort has two exact reconciliation views: retrying the abort
// target reconstructs the committed abort result, while the original write
// target observes that its operation was aborted.
var abortClock : Nat64 = 10;
let abortMem = Memory.init();
let abortRequestId = Fixtures.id(30_000);
let abortNodeId = Fixtures.id(30_001);
let abortStageId : Nat64 = 1;
let abortStage = privateStatusStage(
    abortRequestId,
    abortNodeId,
    100,
);
installPrivateStatusStage(
    abortMem,
    abortStageId,
    abortStage,
);
let abortService = Service.Service(
    abortMem,
    Fixtures.assets(Fixtures.zeroUsage()),
    func() { abortClock },
);
switch (
    abortService.abort({
        request_id = abortRequestId;
        stage_id = abortStageId;
    })
) {
    case (#ok(value)) {
        assert (value.request_id == abortRequestId);
        assert (value.stage_id == abortStageId);
    };
    case (_) assert false;
};
switch (
    status(
        abortService,
        abortRequestId,
        privateAbortTarget(abortStageId),
    )
) {
    case (#ok(value)) switch (value.state) {
        case (?#committed({
            detail = ?#abort(detail)
        })) {
            assert (detail.request_id == abortRequestId);
            assert (detail.stage_id == abortStageId);
        };
        case (_) assert false;
    };
    case (_) assert false;
};
let abortReconcileUntil =
    abortClock + Types.RECEIPT_RETENTION_NS;
assertAbortedStatus(
    status(
        abortService,
        abortRequestId,
        privateStatusTarget(abortNodeId),
    ),
    abortClock,
    abortReconcileUntil,
);

// Before the receipt horizon an altered, but well-formed, target conflicts.
// At the exact horizon the receipt is logically absent before target matching.
abortClock := abortReconcileUntil - 1;
assertReason(
    status(
        abortService,
        abortRequestId,
        privateAbortTarget(abortStageId + 1),
    ),
    #conflict,
);
abortClock := abortReconcileUntil;
assertUnknownStatus(
    status(
        abortService,
        abortRequestId,
        privateAbortTarget(abortStageId + 1),
    )
);

// The abort target of an active private write is not itself active. At the
// exact private-stage boundary it becomes expired; terminalization preserves
// that result for both the original write target and the abort target.
var expiryClock : Nat64 = 99;
let expiryMem = Memory.init();
let expiryRequestId = Fixtures.id(31_000);
let expiryNodeId = Fixtures.id(31_001);
let expiryStageId : Nat64 = 1;
let expiryAt : Nat64 = 100;
let expiryStage = privateStatusStage(
    expiryRequestId,
    expiryNodeId,
    expiryAt,
);
installPrivateStatusStage(
    expiryMem,
    expiryStageId,
    expiryStage,
);
let expiryService = Service.Service(
    expiryMem,
    Fixtures.assets(Fixtures.zeroUsage()),
    func() { expiryClock },
);
assertUnknownStatus(
    status(
        expiryService,
        expiryRequestId,
        privateAbortTarget(expiryStageId),
    )
);
expiryClock := expiryAt;
let expiryReconcileUntil =
    expiryAt + Types.RECEIPT_RETENTION_NS;
assertExpiredStatus(
    status(
        expiryService,
        expiryRequestId,
        privateAbortTarget(expiryStageId),
    ),
    expiryAt,
    expiryReconcileUntil,
);
assertExpiredStatus(
    status(
        expiryService,
        expiryRequestId,
        privateStatusTarget(expiryNodeId),
    ),
    expiryAt,
    expiryReconcileUntil,
);
assertReason(
    expiryService.abort({
        request_id = expiryRequestId;
        stage_id = expiryStageId;
    }),
    #expired,
);
assert (
    Map.get(expiryMem.stages, Nat64.compare, expiryStageId) ==
    null
);
assert (
    Map.get(
        expiryMem.private_receipts,
        Keys.compareId128,
        expiryRequestId,
    ) != null
);
assertExpiredStatus(
    status(
        expiryService,
        expiryRequestId,
        privateStatusTarget(expiryNodeId),
    ),
    expiryAt,
    expiryReconcileUntil,
);
assertExpiredStatus(
    status(
        expiryService,
        expiryRequestId,
        privateAbortTarget(expiryStageId),
    ),
    expiryAt,
    expiryReconcileUntil,
);
assertReason(
    status(
        expiryService,
        expiryRequestId,
        privateAbortTarget(expiryStageId + 1),
    ),
    #conflict,
);
expiryClock := expiryReconcileUntil;
assertUnknownStatus(
    status(
        expiryService,
        expiryRequestId,
        privateAbortTarget(expiryStageId + 1),
    )
);

// Bootstrap conversions are checked. Values outside Nat64 are rejected as
// corrupt state rather than wrapping the public counters.
let counterOverflow = Memory.init();
counterOverflow.node_count := Nat64.toNat(Nat64.maxValue) + 1;
let overflowService = Service.Service(
    counterOverflow,
    Fixtures.assets(Fixtures.zeroUsage()),
    func() : Nat64 { 0 },
);
assertReason(overflowService.bootstrap(), #corrupt_state);

let zeroUsage = Fixtures.zeroUsage();
let usageOverflow = {
    zeroUsage with
    current = {
        zeroUsage.current with
        live_entries = Nat64.toNat(Nat64.maxValue) + 1;
    };
};
let publicOverflowService = Service.Service(
    Memory.init(),
    Fixtures.assets(usageOverflow),
    func() : Nat64 { 0 },
);
assertReason(publicOverflowService.bootstrap(), #corrupt_state);
