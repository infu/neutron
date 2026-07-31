import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Runtime "mo:core/Runtime";
import Accounting "../../backend/files/Accounting";
import Frames "../../backend/files/Frames";
import Keys "../../backend/files/Keys";
import Memory "../../backend/memory/files/v1";
import Service "../../backend/files/Service";
import Types "../../backend/files/Types";
import Fixtures "Fixtures";

type WriteSpec = {
    first : Frames.WriteFirstFrame;
    first_raw : Blob;
    continuation_raws : [Blob];
    commit_plan : Memory.PrivateCommitPlan;
};

let largePlain = Types.MAX_PLAINTEXT_BLOCK_BYTES;
let largeCipher = largePlain + 16;
let twoBlockPlain = 1 + largePlain;
let twoBlockCipher = 17 + largeCipher;

func assertReason<T>(
    result : Types.Result<T>,
    expected : Types.RejectionReason,
) {
    switch (result) {
        case (#err({ reason = ?actual })) {
            if (actual != expected) Runtime.trap(
                "expected rejection " # debug_show (expected) #
                ", got " # debug_show (actual)
            );
        };
        case (_) Runtime.trap(
            "expected rejection " # debug_show (expected)
        );
    };
};

func hasReason<T>(
    result : Types.Result<T>,
    expected : Types.RejectionReason,
) : Bool {
    switch (result) {
        case (#err({ reason = ?actual })) actual == expected;
        case (_) false;
    };
};

func node(mem : Memory.Mem, nodeId : Types.Id128) : Memory.Node {
    switch (Map.get(mem.nodes_by_id, Keys.compareId128, nodeId)) {
        case (?value) value;
        case null Runtime.trap("missing test node");
    };
};

func content(value : Memory.Node) : Memory.ContentRecord {
    switch (value.kind) {
        case (#file({ active_content = ?current })) current;
        case (_) Runtime.trap("missing test content");
    };
};

func packFirst(spec : WriteSpec) : Blob {
    Fixtures.pack(
        to_candid ({
            frame = ?#first(spec.first);
        } : Frames.WriteBlockFrameControl),
        spec.first_raw,
    );
};

func request(
    requestId : Types.Id128,
    stageId : ?Nat64,
    ordinal : Nat8,
    final : Bool,
    body : Blob,
) : Types.WriteBlockRequest {
    {
        request_id = requestId;
        stage_id = stageId;
        frame_ordinal = ordinal;
        final;
        body_bytes = Nat32.fromNat(body.size());
    };
};

func frameCiphertext(frame : Frames.WriteFramePlan) : Nat {
    var total = 0;
    for (block in frame.blocks.values()) {
        total += Nat32.toNat(block.ciphertext_bytes);
    };
    total;
};

func stageFor(
    spec : WriteSpec,
    firstBodyBytes : Nat,
) : Memory.PrivateStage {
    let frameCount = Nat8.toNat(spec.first.frame_count);
    let frames = Array.map<Frames.WriteFramePlan, Memory.FramePlan>(
        spec.first.frames,
        func(frame) {
            {
                ordinal = frame.frame_ordinal;
                encoded_bytes =
                    if (frame.frame_ordinal == 0) {
                        Nat32.fromNat(firstBodyBytes);
                    } else {
                        frame.raw_payload_bytes;
                    };
                blocks = Array.map<Frames.WriteBlockSlice, Memory.StageBlock>(
                    frame.blocks,
                    func(block) {
                        {
                            content_id = block.content_id;
                            block_index = block.block_index;
                            ciphertext_bytes = block.ciphertext_bytes;
                            frame_ordinal = frame.frame_ordinal;
                            payload_offset = block.payload.offset;
                            payload_length = block.payload.length;
                        };
                    },
                );
            };
        },
    );
    var totalCipher = 0;
    for (frame in spec.first.frames.values()) {
        totalCipher += frameCiphertext(frame);
    };
    let acceptedCipher = frameCiphertext(spec.first.frames[0]);
    {
        request_id = spec.first.request_id;
        request_fingerprint = (1, 2, 3, 4);
        created_at_ns = 0;
        last_activity_at_ns = 0;
        expires_at_ns = Types.PRIVATE_STAGE_IDLE_NS;
        frame_count = spec.first.frame_count;
        accepted_frame_bitmap = Blob.fromArray([1]);
        frame_fingerprints = Array.tabulate<?Types.Digest256>(
            frameCount,
            func(index) {
                if (index == 0) ?(5, 6, 7, 8) else null;
            },
        );
        frames;
        commit_plan = spec.commit_plan;
        accepted_ciphertext_bytes = acceptedCipher;
        reserved_ciphertext_bytes = totalCipher - acceptedCipher;
        reserved_physical_bytes = 0;
        reserved_cleanup_jobs = 0;
    };
};

func reservationPeak(spec : WriteSpec, firstBodyBytes : Nat) : Nat {
    Accounting.privateCommitReservation(
        stageFor(spec, firstBodyBytes)
    ).peak_reservation_charge;
};

func exactGross(
    mem : Memory.Mem,
    spec : WriteSpec,
    firstBodyBytes : Nat,
) : Nat64 {
    Nat64.fromNat(
        mem.physical_private_bytes +
        mem.reserved_physical_private_bytes +
        reservationPeak(spec, firstBodyBytes)
    );
};

func initialize(
    service : Service.Service,
    requestId : Types.Id128,
) {
    let body = Fixtures.vaultInitializeBody(requestId);
    switch (
        service.vaultWrite(
            {
                request_id = requestId;
                operation = ?#initialize;
                expected_record_revision = null;
                proposed_record_revision = 1;
                body_bytes = Nat32.fromNat(body.size());
            },
            body,
        )
    ) {
        case (#ok(_)) {};
        case (value) Runtime.trap(
            "vault initialization failed: " # debug_show (value)
        );
    };
};

func writeNodeTransition(
    nodeId : Types.Id128,
    parentId : Types.Id128,
    nameTag : Frames.Digest256,
    metadataLength : Nat,
    plaintextBytes : Nat,
) : Frames.NodeTransitionFrame {
    {
        node_id = nodeId;
        expected_parent_id = null;
        proposed_parent_id = parentId;
        requested_kind = ?#file;
        expected_name_tag = null;
        proposed_name_tag = nameTag;
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
        proposed_subtree_plaintext_bytes = Nat64.fromNat(plaintextBytes);
        encrypted_metadata = {
            offset = 0;
            length = Nat32.fromNat(metadataLength);
        };
    };
};

func rootAfterTopLevelCreate(
    current : Memory.Node,
    plaintextBytes : Nat,
) : Memory.Node {
    let direct = switch (current.kind) {
        case (#folder(folder)) Nat32.toNat(folder.direct_child_count);
        case (_) Runtime.trap("root is not a folder");
    };
    {
        current with
        kind = #folder({
            direct_child_count = Nat32.fromNat(direct + 1);
            child_subtree_heights = [{
                value = 0;
                count = Nat32.fromNat(direct + 1);
            }];
            child_relative_path_scalars = [{
                value = 1;
                count = Nat32.fromNat(direct + 1);
            }];
        });
        structural_revision = current.structural_revision + 1;
        children_revision = current.children_revision + 1;
        subtree_height = 1;
        max_relative_path_scalars = 1;
        subtree_plaintext_bytes =
            current.subtree_plaintext_bytes + plaintextBytes;
    };
};

func createSpec(
    mem : Memory.Mem,
    requestId : Types.Id128,
    nodeId : Types.Id128,
    contentId : Types.Id128,
    nameWord : Nat64,
    multiFrame : Bool,
    gross : Nat64,
) : WriteSpec {
    let nameTag = Fixtures.digest(nameWord);
    let metadata = Fixtures.zeros(16);
    let wrapper = Fixtures.zeros(48);
    let firstBlock = Fixtures.zeros(17);
    let plaintext = if (multiFrame) twoBlockPlain else 1;
    let ciphertext = if (multiFrame) twoBlockCipher else 17;
    let firstRaw = Frames.append([metadata, wrapper, firstBlock]);
    let firstSlice : Frames.WriteBlockSlice = {
        content_id = contentId;
        block_index = 0;
        ciphertext_bytes = 17;
        payload = { offset = 64; length = 17 };
    };
    let secondSlice : Frames.WriteBlockSlice = {
        content_id = contentId;
        block_index = 1;
        ciphertext_bytes = Nat32.fromNat(largeCipher);
        payload = {
            offset = 0;
            length = Nat32.fromNat(largeCipher);
        };
    };
    let frames : [Frames.WriteFramePlan] =
        if (multiFrame) [
            {
                frame_ordinal = 0;
                raw_payload_bytes = Nat32.fromNat(firstRaw.size());
                blocks = [firstSlice];
            },
            {
                frame_ordinal = 1;
                raw_payload_bytes = Nat32.fromNat(largeCipher);
                blocks = [secondSlice];
            },
        ] else [{
            frame_ordinal = 0;
            raw_payload_bytes = Nat32.fromNat(firstRaw.size());
            blocks = [firstSlice];
        }];
    let currentRoot = node(mem, Types.ROOT_NODE_ID);
    let transition = writeNodeTransition(
        nodeId,
        Types.ROOT_NODE_ID,
        nameTag,
        metadata.size(),
        plaintext,
    );
    let contentPlan : Frames.WriteContentPlan = {
        content_id = contentId;
        wrapped_content_key = { offset = 16; length = 48 };
        plaintext_block_lengths =
            if (multiFrame) [
                1,
                Nat32.fromNat(largePlain),
            ] else [1];
        ciphertext_block_lengths =
            if (multiFrame) [
                17,
                Nat32.fromNat(largeCipher),
            ] else [17];
        ciphertext_bytes = Nat64.fromNat(ciphertext);
        crypto_profile = ?#aes_256_gcm_files_v2;
    };
    let first : Frames.WriteFirstFrame = {
        request_id = requestId;
        intent = ?#create;
        frame_ordinal = 0;
        frame_count = if (multiFrame) 2 else 1;
        final = not multiFrame;
        nodes = [{ node = transition; content = ?contentPlan }];
        folder_transitions = [{
            node_id = Types.ROOT_NODE_ID;
            expected_structural_revision =
                currentRoot.structural_revision;
            expected_children_revision =
                currentRoot.children_revision;
        }];
        child_index_transitions = [{
            parent_id = Types.ROOT_NODE_ID;
            name_tag = nameTag;
            expected_node_id = null;
            proposed_node_id = ?nodeId;
        }];
        retired_contents = [];
        quota = {
            expected_node_count = Nat64.fromNat(mem.node_count);
            proposed_node_count = Nat64.fromNat(mem.node_count + 1);
            expected_committed_plaintext_bytes =
                Nat64.fromNat(mem.committed_private_plaintext_bytes);
            proposed_committed_plaintext_bytes =
                Nat64.fromNat(
                    mem.committed_private_plaintext_bytes + plaintext
                );
            expected_committed_ciphertext_bytes =
                Nat64.fromNat(mem.committed_ciphertext_bytes);
            proposed_committed_ciphertext_bytes =
                Nat64.fromNat(
                    mem.committed_ciphertext_bytes +
                    metadata.size() +
                    ciphertext
                );
            gross_peak_physical_bytes = gross;
        };
        frames;
        raw_payload_bytes = Nat32.fromNat(firstRaw.size());
    };
    let storedContent : Memory.ContentRecord = {
        content_id = contentId;
        wrapped_content_key = wrapper;
        block_count = if (multiFrame) 2 else 1;
        ciphertext_bytes = ciphertext;
        crypto_profile = #aes_256_gcm_files_v2;
    };
    let file : Memory.Node = {
        parent_id = Types.ROOT_NODE_ID;
        kind = #file({ active_content = ?storedContent });
        state = #active;
        name_tag = Frames.digestToTag(nameTag);
        declared_name_scalars = 1;
        structural_revision = 1;
        metadata_revision = 1;
        children_revision = 0;
        subtree_height = 0;
        max_relative_path_scalars = 1;
        subtree_plaintext_bytes = plaintext;
        encrypted_metadata = metadata;
    };
    let nextRoot = rootAfterTopLevelCreate(currentRoot, plaintext);
    {
        first;
        first_raw = firstRaw;
        continuation_raws =
            if (multiFrame) [Fixtures.zeros(largeCipher)] else [];
        commit_plan = {
            intent = #create;
            node_mutations = [
                {
                    node_id = Types.ROOT_NODE_ID;
                    expected = ?currentRoot;
                    replacement = ?nextRoot;
                },
                {
                    node_id = nodeId;
                    expected = null;
                    replacement = ?file;
                },
            ];
            child_index_mutations = [{
                key = Keys.childNameKey(
                    Types.ROOT_NODE_ID,
                    Frames.digestToTag(nameTag),
                );
                expected = null;
                replacement = ?nodeId;
            }];
            retired_contents = [];
            node_count_delta = #increase(1);
            committed_plaintext_delta = #increase(plaintext);
            committed_ciphertext_delta =
                #increase(metadata.size() + ciphertext);
            final_physical_bytes = 0;
        };
    };
};

func threeFrameCreateSpec(
    mem : Memory.Mem,
    requestId : Types.Id128,
    nodeId : Types.Id128,
    contentId : Types.Id128,
    nameWord : Nat64,
    gross : Nat64,
) : WriteSpec {
    let nameTag = Fixtures.digest(nameWord);
    let metadata = Fixtures.zeros(16);
    let wrapper = Fixtures.zeros(48);
    let firstRaw = Frames.append([
        metadata,
        wrapper,
        Fixtures.zeros(17),
    ]);
    let totalPlain = 1 + largePlain * 2;
    let totalCipher = 17 + largeCipher * 2;
    let firstSlice : Frames.WriteBlockSlice = {
        content_id = contentId;
        block_index = 0;
        ciphertext_bytes = 17;
        payload = { offset = 64; length = 17 };
    };
    let secondSlice : Frames.WriteBlockSlice = {
        content_id = contentId;
        block_index = 1;
        ciphertext_bytes = Nat32.fromNat(largeCipher);
        payload = {
            offset = 0;
            length = Nat32.fromNat(largeCipher);
        };
    };
    let thirdSlice : Frames.WriteBlockSlice = {
        content_id = contentId;
        block_index = 2;
        ciphertext_bytes = Nat32.fromNat(largeCipher);
        payload = {
            offset = 0;
            length = Nat32.fromNat(largeCipher);
        };
    };
    let frames : [Frames.WriteFramePlan] = [
        {
            frame_ordinal = 0;
            raw_payload_bytes = Nat32.fromNat(firstRaw.size());
            blocks = [firstSlice];
        },
        {
            frame_ordinal = 1;
            raw_payload_bytes = Nat32.fromNat(largeCipher);
            blocks = [secondSlice];
        },
        {
            frame_ordinal = 2;
            raw_payload_bytes = Nat32.fromNat(largeCipher);
            blocks = [thirdSlice];
        },
    ];
    let currentRoot = node(mem, Types.ROOT_NODE_ID);
    let transition = writeNodeTransition(
        nodeId,
        Types.ROOT_NODE_ID,
        nameTag,
        metadata.size(),
        totalPlain,
    );
    let first : Frames.WriteFirstFrame = {
        request_id = requestId;
        intent = ?#create;
        frame_ordinal = 0;
        frame_count = 3;
        final = false;
        nodes = [{
            node = transition;
            content = ?{
                content_id = contentId;
                wrapped_content_key = { offset = 16; length = 48 };
                plaintext_block_lengths = [
                    1,
                    Nat32.fromNat(largePlain),
                    Nat32.fromNat(largePlain),
                ];
                ciphertext_block_lengths = [
                    17,
                    Nat32.fromNat(largeCipher),
                    Nat32.fromNat(largeCipher),
                ];
                ciphertext_bytes = Nat64.fromNat(totalCipher);
                crypto_profile = ?#aes_256_gcm_files_v2;
            };
        }];
        folder_transitions = [{
            node_id = Types.ROOT_NODE_ID;
            expected_structural_revision =
                currentRoot.structural_revision;
            expected_children_revision =
                currentRoot.children_revision;
        }];
        child_index_transitions = [{
            parent_id = Types.ROOT_NODE_ID;
            name_tag = nameTag;
            expected_node_id = null;
            proposed_node_id = ?nodeId;
        }];
        retired_contents = [];
        quota = {
            expected_node_count = Nat64.fromNat(mem.node_count);
            proposed_node_count = Nat64.fromNat(mem.node_count + 1);
            expected_committed_plaintext_bytes =
                Nat64.fromNat(mem.committed_private_plaintext_bytes);
            proposed_committed_plaintext_bytes =
                Nat64.fromNat(
                    mem.committed_private_plaintext_bytes + totalPlain
                );
            expected_committed_ciphertext_bytes =
                Nat64.fromNat(mem.committed_ciphertext_bytes);
            proposed_committed_ciphertext_bytes =
                Nat64.fromNat(
                    mem.committed_ciphertext_bytes +
                    metadata.size() +
                    totalCipher
                );
            gross_peak_physical_bytes = gross;
        };
        frames;
        raw_payload_bytes = Nat32.fromNat(firstRaw.size());
    };
    let storedContent : Memory.ContentRecord = {
        content_id = contentId;
        wrapped_content_key = wrapper;
        block_count = 3;
        ciphertext_bytes = totalCipher;
        crypto_profile = #aes_256_gcm_files_v2;
    };
    let file : Memory.Node = {
        parent_id = Types.ROOT_NODE_ID;
        kind = #file({ active_content = ?storedContent });
        state = #active;
        name_tag = Frames.digestToTag(nameTag);
        declared_name_scalars = 1;
        structural_revision = 1;
        metadata_revision = 1;
        children_revision = 0;
        subtree_height = 0;
        max_relative_path_scalars = 1;
        subtree_plaintext_bytes = totalPlain;
        encrypted_metadata = metadata;
    };
    let nextRoot = rootAfterTopLevelCreate(currentRoot, totalPlain);
    {
        first;
        first_raw = firstRaw;
        continuation_raws = [
            Fixtures.zeros(largeCipher),
            Fixtures.zeros(largeCipher),
        ];
        commit_plan = {
            intent = #create;
            node_mutations = [
                {
                    node_id = Types.ROOT_NODE_ID;
                    expected = ?currentRoot;
                    replacement = ?nextRoot;
                },
                {
                    node_id = nodeId;
                    expected = null;
                    replacement = ?file;
                },
            ];
            child_index_mutations = [{
                key = Keys.childNameKey(
                    Types.ROOT_NODE_ID,
                    Frames.digestToTag(nameTag),
                );
                expected = null;
                replacement = ?nodeId;
            }];
            retired_contents = [];
            node_count_delta = #increase(1);
            committed_plaintext_delta = #increase(totalPlain);
            committed_ciphertext_delta =
                #increase(metadata.size() + totalCipher);
            final_physical_bytes = 0;
        };
    };
};

func continuationBody(
    spec : WriteSpec,
    requestId : Types.Id128,
    stageId : Nat64,
    ordinal : Nat8,
    final : Bool,
    blocks : [Frames.WriteBlockSlice],
    raw : Blob,
) : Blob {
    Fixtures.pack(
        to_candid ({
            frame = ?#continuation({
                request_id = requestId;
                stage_id = stageId;
                frame_ordinal = ordinal;
                final;
                blocks;
                raw_payload_bytes = Nat32.fromNat(raw.size());
            });
        } : Frames.WriteBlockFrameControl),
        raw,
    );
};

func changedLast(value : Blob) : Blob {
    Blob.fromArray(
        Array.tabulate<Nat8>(
            value.size(),
            func(index) {
                if (index + 1 == value.size()) value[index] ^ 1 else value[index];
            },
        )
    );
};

func replaceChargedNode(
    mem : Memory.Mem,
    nodeId : Types.Id128,
    replacement : Memory.Node,
) {
    let current = node(mem, nodeId);
    Accounting.removePhysical(mem, Accounting.nodeCharge(current));
    Map.add(
        mem.nodes_by_id,
        Keys.compareId128,
        nodeId,
        replacement,
    );
    Accounting.addPhysical(mem, Accounting.nodeCharge(replacement));
};

func addChargedNode(
    mem : Memory.Mem,
    nodeId : Types.Id128,
    value : Memory.Node,
) {
    Map.add(mem.nodes_by_id, Keys.compareId128, nodeId, value);
    Accounting.addPhysical(mem, Accounting.nodeCharge(value));
};

func addChargedChild(
    mem : Memory.Mem,
    parentId : Types.Id128,
    nameTag : Memory.Tag256,
    nodeId : Types.Id128,
) {
    Map.add(
        mem.children_by_name,
        Keys.compareChildNameKey,
        Keys.childNameKey(parentId, nameTag),
        nodeId,
    );
    Accounting.addPhysical(mem, Accounting.childIndexCharge());
};

func addChargedBlock(
    mem : Memory.Mem,
    contentId : Types.Id128,
    index : Nat32,
    bytes : Nat,
) {
    Map.add(
        mem.blocks,
        Keys.compareBlockKey,
        Keys.blockKey(contentId, index),
        Fixtures.zeros(bytes),
    );
    Accounting.addPhysical(mem, Accounting.blockCharge(bytes));
};

func oldTwoBlockFile(
    parentId : Types.Id128,
    nameTag : Memory.Tag256,
    contentId : Types.Id128,
) : Memory.Node {
    {
        parent_id = parentId;
        kind = #file({
            active_content = ?{
                content_id = contentId;
                wrapped_content_key = Fixtures.zeros(48);
                block_count = 2;
                ciphertext_bytes = twoBlockCipher;
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
        subtree_plaintext_bytes = twoBlockPlain;
        encrypted_metadata = Fixtures.zeros(16);
    };
};

func seedTopLevelReplacementFiles(
    mem : Memory.Mem,
    nodeA : Types.Id128,
    contentA : Types.Id128,
    tagA : Memory.Tag256,
    nodeB : Types.Id128,
    contentB : Types.Id128,
    tagB : Memory.Tag256,
) {
    let root = node(mem, Types.ROOT_NODE_ID);
    let nextRoot : Memory.Node = {
        root with
        kind = #folder({
            direct_child_count = 2;
            child_subtree_heights = [{ value = 0; count = 2 }];
            child_relative_path_scalars = [{ value = 1; count = 2 }];
        });
        structural_revision = root.structural_revision + 1;
        children_revision = root.children_revision + 1;
        subtree_height = 1;
        max_relative_path_scalars = 1;
        subtree_plaintext_bytes = twoBlockPlain * 2;
    };
    replaceChargedNode(mem, Types.ROOT_NODE_ID, nextRoot);
    let fileA = oldTwoBlockFile(
        Types.ROOT_NODE_ID,
        tagA,
        contentA,
    );
    let fileB = oldTwoBlockFile(
        Types.ROOT_NODE_ID,
        tagB,
        contentB,
    );
    addChargedNode(mem, nodeA, fileA);
    addChargedNode(mem, nodeB, fileB);
    addChargedChild(mem, Types.ROOT_NODE_ID, tagA, nodeA);
    addChargedChild(mem, Types.ROOT_NODE_ID, tagB, nodeB);
    addChargedBlock(mem, contentA, 0, 17);
    addChargedBlock(mem, contentA, 1, largeCipher);
    addChargedBlock(mem, contentB, 0, 17);
    addChargedBlock(mem, contentB, 1, largeCipher);
    mem.node_count := 3;
    mem.committed_private_plaintext_bytes := twoBlockPlain * 2;
};

func replaceSpec(
    mem : Memory.Mem,
    requestId : Types.Id128,
    nodeId : Types.Id128,
    newContentId : Types.Id128,
    gross : Nat64,
) : WriteSpec {
    let current = node(mem, nodeId);
    let oldContent = content(current);
    let metadata = Fixtures.zeros(17);
    let wrapper = Fixtures.zeros(48);
    let firstBlock = Fixtures.zeros(17);
    let firstRaw = Frames.append([metadata, wrapper, firstBlock]);
    let firstSlice : Frames.WriteBlockSlice = {
        content_id = newContentId;
        block_index = 0;
        ciphertext_bytes = 17;
        payload = { offset = 65; length = 17 };
    };
    let secondSlice : Frames.WriteBlockSlice = {
        content_id = newContentId;
        block_index = 1;
        ciphertext_bytes = Nat32.fromNat(largeCipher);
        payload = {
            offset = 0;
            length = Nat32.fromNat(largeCipher);
        };
    };
    let frames : [Frames.WriteFramePlan] = [
        {
            frame_ordinal = 0;
            raw_payload_bytes = Nat32.fromNat(firstRaw.size());
            blocks = [firstSlice];
        },
        {
            frame_ordinal = 1;
            raw_payload_bytes = Nat32.fromNat(largeCipher);
            blocks = [secondSlice];
        },
    ];
    let transition : Frames.NodeTransitionFrame = {
        node_id = nodeId;
        expected_parent_id = ?current.parent_id;
        proposed_parent_id = current.parent_id;
        requested_kind = ?#file;
        expected_name_tag =
            ?Frames.digestFromTag(current.name_tag);
        proposed_name_tag = Frames.digestFromTag(current.name_tag);
        declared_name_scalars = current.declared_name_scalars;
        expected_structural_revision =
            ?current.structural_revision;
        proposed_structural_revision =
            current.structural_revision + 1;
        expected_metadata_revision = ?current.metadata_revision;
        proposed_metadata_revision = current.metadata_revision + 1;
        expected_children_revision = ?current.children_revision;
        proposed_children_revision = current.children_revision;
        expected_subtree_height = ?current.subtree_height;
        proposed_subtree_height = current.subtree_height;
        expected_max_relative_path_scalars =
            ?current.max_relative_path_scalars;
        proposed_max_relative_path_scalars =
            current.max_relative_path_scalars;
        expected_subtree_plaintext_bytes =
            ?Nat64.fromNat(current.subtree_plaintext_bytes);
        proposed_subtree_plaintext_bytes =
            Nat64.fromNat(current.subtree_plaintext_bytes);
        encrypted_metadata = { offset = 0; length = 17 };
    };
    let contentPlan : Frames.WriteContentPlan = {
        content_id = newContentId;
        wrapped_content_key = { offset = 17; length = 48 };
        plaintext_block_lengths = [
            1,
            Nat32.fromNat(largePlain),
        ];
        ciphertext_block_lengths = [
            17,
            Nat32.fromNat(largeCipher),
        ];
        ciphertext_bytes = Nat64.fromNat(twoBlockCipher);
        crypto_profile = ?#aes_256_gcm_files_v2;
    };
    let currentRoot = node(mem, Types.ROOT_NODE_ID);
    let first : Frames.WriteFirstFrame = {
        request_id = requestId;
        intent = ?#replace;
        frame_ordinal = 0;
        frame_count = 2;
        final = false;
        nodes = [{ node = transition; content = ?contentPlan }];
        folder_transitions = [{
            node_id = Types.ROOT_NODE_ID;
            expected_structural_revision =
                currentRoot.structural_revision;
            expected_children_revision =
                currentRoot.children_revision;
        }];
        child_index_transitions = [];
        retired_contents = [{
            node_id = nodeId;
            content_id = oldContent.content_id;
            block_count = oldContent.block_count;
            ciphertext_bytes =
                Nat64.fromNat(oldContent.ciphertext_bytes);
        }];
        quota = {
            expected_node_count = Nat64.fromNat(mem.node_count);
            proposed_node_count = Nat64.fromNat(mem.node_count);
            expected_committed_plaintext_bytes =
                Nat64.fromNat(mem.committed_private_plaintext_bytes);
            proposed_committed_plaintext_bytes =
                Nat64.fromNat(mem.committed_private_plaintext_bytes);
            expected_committed_ciphertext_bytes =
                Nat64.fromNat(mem.committed_ciphertext_bytes);
            proposed_committed_ciphertext_bytes =
                Nat64.fromNat(mem.committed_ciphertext_bytes + 1);
            gross_peak_physical_bytes = gross;
        };
        frames;
        raw_payload_bytes = Nat32.fromNat(firstRaw.size());
    };
    let replacementContent : Memory.ContentRecord = {
        content_id = newContentId;
        wrapped_content_key = wrapper;
        block_count = 2;
        ciphertext_bytes = twoBlockCipher;
        crypto_profile = #aes_256_gcm_files_v2;
    };
    let replacement : Memory.Node = {
        current with
        kind = #file({ active_content = ?replacementContent });
        structural_revision = current.structural_revision + 1;
        metadata_revision = current.metadata_revision + 1;
        encrypted_metadata = metadata;
    };
    {
        first;
        first_raw = firstRaw;
        continuation_raws = [Fixtures.zeros(largeCipher)];
        commit_plan = {
            intent = #replace;
            node_mutations = [{
                node_id = nodeId;
                expected = ?current;
                replacement = ?replacement;
            }];
            child_index_mutations = [];
            retired_contents = [{ node_id = nodeId; content = oldContent }];
            node_count_delta = #unchanged;
            committed_plaintext_delta = #unchanged;
            committed_ciphertext_delta = #increase(1);
            final_physical_bytes = 0;
        };
    };
};

func raceFolder(nameTag : Memory.Tag256) : Memory.Node {
    {
        parent_id = Types.ROOT_NODE_ID;
        kind = #folder({
            direct_child_count = 1;
            child_subtree_heights = [{ value = 0; count = 1 }];
            child_relative_path_scalars = [{ value = 1; count = 1 }];
        });
        state = #active;
        name_tag = nameTag;
        declared_name_scalars = 1;
        structural_revision = 1;
        metadata_revision = 1;
        children_revision = 1;
        subtree_height = 1;
        max_relative_path_scalars = 3;
        subtree_plaintext_bytes = twoBlockPlain;
        encrypted_metadata = Fixtures.zeros(16);
    };
};

func seedNodeRaceTree(
    mem : Memory.Mem,
    folderA : Types.Id128,
    folderTagA : Memory.Tag256,
    oldNodeA : Types.Id128,
    oldTagA : Memory.Tag256,
    oldContentA : Types.Id128,
    folderB : Types.Id128,
    folderTagB : Memory.Tag256,
    oldNodeB : Types.Id128,
    oldTagB : Memory.Tag256,
    oldContentB : Types.Id128,
) {
    let root = node(mem, Types.ROOT_NODE_ID);
    let nextRoot : Memory.Node = {
        root with
        kind = #folder({
            direct_child_count = 2;
            child_subtree_heights = [{ value = 1; count = 2 }];
            child_relative_path_scalars = [{ value = 3; count = 2 }];
        });
        structural_revision = root.structural_revision + 1;
        children_revision = root.children_revision + 1;
        subtree_height = 2;
        max_relative_path_scalars = 3;
        subtree_plaintext_bytes = twoBlockPlain * 2;
    };
    replaceChargedNode(mem, Types.ROOT_NODE_ID, nextRoot);
    let parentA = raceFolder(folderTagA);
    let parentB = raceFolder(folderTagB);
    let fileA = oldTwoBlockFile(folderA, oldTagA, oldContentA);
    let fileB = oldTwoBlockFile(folderB, oldTagB, oldContentB);
    addChargedNode(mem, folderA, parentA);
    addChargedNode(mem, oldNodeA, fileA);
    addChargedNode(mem, folderB, parentB);
    addChargedNode(mem, oldNodeB, fileB);
    addChargedChild(mem, Types.ROOT_NODE_ID, folderTagA, folderA);
    addChargedChild(mem, folderA, oldTagA, oldNodeA);
    addChargedChild(mem, Types.ROOT_NODE_ID, folderTagB, folderB);
    addChargedChild(mem, folderB, oldTagB, oldNodeB);
    addChargedBlock(mem, oldContentA, 0, 17);
    addChargedBlock(mem, oldContentA, 1, largeCipher);
    addChargedBlock(mem, oldContentB, 0, 17);
    addChargedBlock(mem, oldContentB, 1, largeCipher);
    mem.node_count := 5;
    mem.committed_private_plaintext_bytes := twoBlockPlain * 2;
    mem.committed_ciphertext_bytes :=
        // Root, two folders, two files, and the two content bodies.
        16 * 5 + twoBlockCipher * 2;
};

func nodeRaceBatchSpec(
    mem : Memory.Mem,
    requestId : Types.Id128,
    parentId : Types.Id128,
    oldNodeId : Types.Id128,
    emptyContentId : Types.Id128,
    newNodeId : Types.Id128,
    newContentId : Types.Id128,
    newNameWord : Nat64,
    gross : Nat64,
) : WriteSpec {
    let parent = node(mem, parentId);
    let oldFile = node(mem, oldNodeId);
    let oldContent = content(oldFile);
    let newName = Fixtures.digest(newNameWord);
    let metadataA = Fixtures.zeros(16);
    let wrapperA = Fixtures.zeros(48);
    let metadataB = Fixtures.zeros(16);
    let wrapperB = Fixtures.zeros(48);
    let emptyBlock = Fixtures.zeros(16);
    let firstBlock = Fixtures.zeros(17);
    let firstRaw = Frames.append([
        metadataA,
        wrapperA,
        metadataB,
        wrapperB,
        emptyBlock,
        firstBlock,
    ]);
    let emptySlice : Frames.WriteBlockSlice = {
        content_id = emptyContentId;
        block_index = 0;
        ciphertext_bytes = 16;
        payload = { offset = 128; length = 16 };
    };
    let firstSlice : Frames.WriteBlockSlice = {
        content_id = newContentId;
        block_index = 0;
        ciphertext_bytes = 17;
        payload = { offset = 144; length = 17 };
    };
    let finalSlice : Frames.WriteBlockSlice = {
        content_id = newContentId;
        block_index = 1;
        ciphertext_bytes = Nat32.fromNat(largeCipher);
        payload = {
            offset = 0;
            length = Nat32.fromNat(largeCipher);
        };
    };
    let frames : [Frames.WriteFramePlan] = [
        {
            frame_ordinal = 0;
            raw_payload_bytes = Nat32.fromNat(firstRaw.size());
            blocks = [emptySlice, firstSlice];
        },
        {
            frame_ordinal = 1;
            raw_payload_bytes = Nat32.fromNat(largeCipher);
            blocks = [finalSlice];
        },
    ];
    let oldTransition : Frames.NodeTransitionFrame = {
        node_id = oldNodeId;
        expected_parent_id = ?oldFile.parent_id;
        proposed_parent_id = oldFile.parent_id;
        requested_kind = ?#file;
        expected_name_tag =
            ?Frames.digestFromTag(oldFile.name_tag);
        proposed_name_tag = Frames.digestFromTag(oldFile.name_tag);
        declared_name_scalars = oldFile.declared_name_scalars;
        expected_structural_revision =
            ?oldFile.structural_revision;
        proposed_structural_revision =
            oldFile.structural_revision + 1;
        expected_metadata_revision = ?oldFile.metadata_revision;
        proposed_metadata_revision = oldFile.metadata_revision + 1;
        expected_children_revision = ?oldFile.children_revision;
        proposed_children_revision = oldFile.children_revision;
        expected_subtree_height = ?oldFile.subtree_height;
        proposed_subtree_height = oldFile.subtree_height;
        expected_max_relative_path_scalars =
            ?oldFile.max_relative_path_scalars;
        proposed_max_relative_path_scalars =
            oldFile.max_relative_path_scalars;
        expected_subtree_plaintext_bytes =
            ?Nat64.fromNat(oldFile.subtree_plaintext_bytes);
        proposed_subtree_plaintext_bytes = 0;
        encrypted_metadata = { offset = 0; length = 16 };
    };
    let newTransition = {
        writeNodeTransition(
            newNodeId,
            parentId,
            newName,
            16,
            twoBlockPlain,
        ) with
        encrypted_metadata = {
            offset = Nat32.fromNat(64);
            length = Nat32.fromNat(16);
        };
    };
    let emptyPlan : Frames.WriteContentPlan = {
        content_id = emptyContentId;
        wrapped_content_key = { offset = 16; length = 48 };
        plaintext_block_lengths = [0];
        ciphertext_block_lengths = [16];
        ciphertext_bytes = 16;
        crypto_profile = ?#aes_256_gcm_files_v2;
    };
    let newPlan : Frames.WriteContentPlan = {
        content_id = newContentId;
        wrapped_content_key = { offset = 80; length = 48 };
        plaintext_block_lengths = [
            1,
            Nat32.fromNat(largePlain),
        ];
        ciphertext_block_lengths = [
            17,
            Nat32.fromNat(largeCipher),
        ];
        ciphertext_bytes = Nat64.fromNat(twoBlockCipher);
        crypto_profile = ?#aes_256_gcm_files_v2;
    };
    let root = node(mem, Types.ROOT_NODE_ID);
    let first : Frames.WriteFirstFrame = {
        request_id = requestId;
        intent = ?#batch;
        frame_ordinal = 0;
        frame_count = 2;
        final = false;
        nodes = [
            { node = oldTransition; content = ?emptyPlan },
            { node = newTransition; content = ?newPlan },
        ];
        folder_transitions = [
            {
                node_id = Types.ROOT_NODE_ID;
                expected_structural_revision =
                    root.structural_revision;
                expected_children_revision = root.children_revision;
            },
            {
                node_id = parentId;
                expected_structural_revision =
                    parent.structural_revision;
                expected_children_revision =
                    parent.children_revision;
            },
        ];
        child_index_transitions = [{
            parent_id = parentId;
            name_tag = newName;
            expected_node_id = null;
            proposed_node_id = ?newNodeId;
        }];
        retired_contents = [{
            node_id = oldNodeId;
            content_id = oldContent.content_id;
            block_count = oldContent.block_count;
            ciphertext_bytes =
                Nat64.fromNat(oldContent.ciphertext_bytes);
        }];
        quota = {
            expected_node_count = Nat64.fromNat(mem.node_count);
            proposed_node_count = Nat64.fromNat(mem.node_count + 1);
            expected_committed_plaintext_bytes =
                Nat64.fromNat(mem.committed_private_plaintext_bytes);
            proposed_committed_plaintext_bytes =
                Nat64.fromNat(mem.committed_private_plaintext_bytes);
            expected_committed_ciphertext_bytes =
                Nat64.fromNat(mem.committed_ciphertext_bytes);
            proposed_committed_ciphertext_bytes =
                Nat64.fromNat(mem.committed_ciphertext_bytes + 32);
            gross_peak_physical_bytes = gross;
        };
        frames;
        raw_payload_bytes = Nat32.fromNat(firstRaw.size());
    };
    let emptyContent : Memory.ContentRecord = {
        content_id = emptyContentId;
        wrapped_content_key = wrapperA;
        block_count = 1;
        ciphertext_bytes = 16;
        crypto_profile = #aes_256_gcm_files_v2;
    };
    let emptyReplacement : Memory.Node = {
        oldFile with
        kind = #file({ active_content = ?emptyContent });
        structural_revision = oldFile.structural_revision + 1;
        metadata_revision = oldFile.metadata_revision + 1;
        subtree_plaintext_bytes = 0;
        encrypted_metadata = metadataA;
    };
    let newContent : Memory.ContentRecord = {
        content_id = newContentId;
        wrapped_content_key = wrapperB;
        block_count = 2;
        ciphertext_bytes = twoBlockCipher;
        crypto_profile = #aes_256_gcm_files_v2;
    };
    let newFile : Memory.Node = {
        parent_id = parentId;
        kind = #file({ active_content = ?newContent });
        state = #active;
        name_tag = Frames.digestToTag(newName);
        declared_name_scalars = 1;
        structural_revision = 1;
        metadata_revision = 1;
        children_revision = 0;
        subtree_height = 0;
        max_relative_path_scalars = 1;
        subtree_plaintext_bytes = twoBlockPlain;
        encrypted_metadata = metadataB;
    };
    let nextParent : Memory.Node = {
        parent with
        kind = #folder({
            direct_child_count = 2;
            child_subtree_heights = [{ value = 0; count = 2 }];
            child_relative_path_scalars = [{ value = 1; count = 2 }];
        });
        structural_revision = parent.structural_revision + 1;
        children_revision = parent.children_revision + 1;
    };
    {
        first;
        first_raw = firstRaw;
        continuation_raws = [Fixtures.zeros(largeCipher)];
        commit_plan = {
            intent = #batch;
            node_mutations = [
                {
                    node_id = parentId;
                    expected = ?parent;
                    replacement = ?nextParent;
                },
                {
                    node_id = oldNodeId;
                    expected = ?oldFile;
                    replacement = ?emptyReplacement;
                },
                {
                    node_id = newNodeId;
                    expected = null;
                    replacement = ?newFile;
                },
            ];
            child_index_mutations = [{
                key = Keys.childNameKey(
                    parentId,
                    Frames.digestToTag(newName),
                );
                expected = null;
                replacement = ?newNodeId;
            }];
            retired_contents = [{
                node_id = oldNodeId;
                content = oldContent;
            }];
            node_count_delta = #increase(1);
            committed_plaintext_delta = #unchanged;
            committed_ciphertext_delta = #increase(32);
            final_physical_bytes = 0;
        };
    };
};

// One-frame create: the independently derived gross witness is the inclusive
// lower bound. Its -1 neighbour rejects before any stage/receipt mutation;
// exact admission commits and the same frame replays from the retained receipt.
var clock : Nat64 = 1_000;
let oneMem = Memory.init();
let oneService = Service.Service(
    oneMem,
    Fixtures.assets(Fixtures.zeroUsage()),
    func() { clock },
);
initialize(oneService, Fixtures.id(1));

// ROOT/zero is a node sentinel, never a content identifier. The malformed
// first frame is rejected by the frame decoder before allocating a stage or
// retaining a receipt.
let rootContentRequestId = Fixtures.id(600);
let rootContentSpec = createSpec(
    oneMem,
    rootContentRequestId,
    Fixtures.id(601),
    Types.ROOT_NODE_ID,
    600,
    false,
    0,
);
let rootContentBody = packFirst(rootContentSpec);
assertReason(
    oneService.writeBlock(
        request(
            rootContentRequestId,
            null,
            0,
            true,
            rootContentBody,
        ),
        rootContentBody,
    ),
    #incompatible,
);
assert (Map.size(oneMem.stages) == 0);
assert (oneMem.next_stage_id == 1);
assert (
    Map.get(
        oneMem.private_receipts,
        Keys.compareId128,
        rootContentRequestId,
    ) == null
);

let oneRequestId = Fixtures.id(2);
let oneNodeId = Fixtures.id(3);
let oneContentId = Fixtures.id(4);
let oneZero = createSpec(
    oneMem,
    oneRequestId,
    oneNodeId,
    oneContentId,
    10,
    false,
    0,
);
let oneZeroBody = packFirst(oneZero);
let oneGross = exactGross(oneMem, oneZero, oneZeroBody.size());
let oneMinus = createSpec(
    oneMem,
    oneRequestId,
    oneNodeId,
    oneContentId,
    10,
    false,
    oneGross - 1,
);
let oneMinusBody = packFirst(oneMinus);
assert (oneMinusBody.size() == oneZeroBody.size());
let oneMinusResult = oneService.writeBlock(
    request(oneRequestId, null, 0, true, oneMinusBody),
    oneMinusBody,
);
if (not hasReason(oneMinusResult, #quota)) Runtime.trap(
    "gross minus result: " # debug_show (oneMinusResult) #
    "; gross=" # debug_show (oneGross)
);
assert (Map.size(oneMem.stages) == 0);
assert (
    Map.get(
        oneMem.private_receipts,
        Keys.compareId128,
        oneRequestId,
    ) == null
);
let oneExact = createSpec(
    oneMem,
    oneRequestId,
    oneNodeId,
    oneContentId,
    10,
    false,
    oneGross,
);
let oneBody = packFirst(oneExact);
let oneResult = oneService.writeBlock(
    request(oneRequestId, null, 0, true, oneBody),
    oneBody,
);
switch (oneResult) {
    case (#ok(value)) {
        assert (value.stage_id == ?1);
        assert (value.frame_ordinal == 0);
        assert (value.accepted_frames_bitmap == 1);
        assert (value.committed_nodes.size() == 1);
        assert (value.committed_nodes[0].node_id == oneNodeId);
        assert (value.committed_nodes[0].content_id == ?oneContentId);
    };
    case (value) Runtime.trap(
        "one-frame write failed: " # debug_show (value)
    );
};
assert (Map.size(oneMem.stages) == 0);
let ?oneNodeOwner = Map.get(
    oneMem.private_receipt_identity_owners,
    Keys.compareId128,
    oneNodeId,
) else Runtime.trap("missing retained node owner");
let ?oneContentOwner = Map.get(
    oneMem.private_receipt_identity_owners,
    Keys.compareId128,
    oneContentId,
) else Runtime.trap("missing retained content owner");
assert (oneNodeOwner.node_count == 1);
assert (oneNodeOwner.content_count == 0);
assert (oneContentOwner.node_count == 0);
assert (oneContentOwner.content_count == 1);
let onePhysical = oneMem.physical_private_bytes;
switch (
    oneService.writeBlock(
        request(oneRequestId, null, 0, true, oneBody),
        oneBody,
    )
) {
    case (#ok(value)) {
        assert (value.stage_id == ?1);
        assert (value.committed_nodes[0].node_id == oneNodeId);
    };
    case (_) assert false;
};
assert (oneMem.physical_private_bytes == onePhysical);
assert (
    Map.get(
        oneMem.private_receipt_identity_owners,
        Keys.compareId128,
        oneNodeId,
    ) == ?oneNodeOwner
);
assert (
    Map.get(
        oneMem.private_receipt_identity_owners,
        Keys.compareId128,
        oneContentId,
    ) == ?oneContentOwner
);
assertReason(
    oneService.writeBlock(
        request(oneRequestId, null, 0, true, changedLast(oneBody)),
        changedLast(oneBody),
    ),
    #conflict,
);

// Expiry does not weaken frame identity. For an already accepted continuation,
// altered pinned control or attachment bytes conflict at the exact idle
// boundary. The exact retry terminalizes the stage as expired, and the compact
// expiry receipt preserves both checks for later reconciliation.
var expiryClock : Nat64 = 10_000;
let expiryMem = Memory.init();
let expiryService = Service.Service(
    expiryMem,
    Fixtures.assets(Fixtures.zeroUsage()),
    func() { expiryClock },
);
initialize(expiryService, Fixtures.id(500));
let expiryRequestId = Fixtures.id(501);
let expiryZero = threeFrameCreateSpec(
    expiryMem,
    expiryRequestId,
    Fixtures.id(502),
    Fixtures.id(503),
    500,
    0,
);
let expiryZeroBody = packFirst(expiryZero);
let expirySpec = threeFrameCreateSpec(
    expiryMem,
    expiryRequestId,
    Fixtures.id(502),
    Fixtures.id(503),
    500,
    exactGross(
        expiryMem,
        expiryZero,
        expiryZeroBody.size(),
    ),
);
let expiryFirstBody = packFirst(expirySpec);
let expiryStageId = switch (
    expiryService.writeBlock(
        request(
            expiryRequestId,
            null,
            0,
            false,
            expiryFirstBody,
        ),
        expiryFirstBody,
    )
) {
    case (#ok(value)) {
        let ?stageId = value.stage_id else Runtime.trap(
            "expiry stage missing id"
        );
        stageId;
    };
    case (value) Runtime.trap(
        "expiry stage failed: " # debug_show (value)
    );
};
let middleRaw = expirySpec.continuation_raws[0];
let middleBody = continuationBody(
    expirySpec,
    expiryRequestId,
    expiryStageId,
    1,
    false,
    expirySpec.first.frames[1].blocks,
    middleRaw,
);
let middleRequest = request(
    expiryRequestId,
    ?expiryStageId,
    1,
    false,
    middleBody,
);
switch (expiryService.writeBlock(middleRequest, middleBody)) {
    case (#ok(value)) assert (value.accepted_frames_bitmap == 3);
    case (value) Runtime.trap(
        "expiry middle frame failed: " # debug_show (value)
    );
};
let expiryStage = switch (
    Map.get(expiryMem.stages, Nat64.compare, expiryStageId)
) {
    case (?#private_write(value)) value;
    case (_) Runtime.trap("expiry stage disappeared");
};
expiryClock := expiryStage.expires_at_ns;

let pinnedMiddle = expirySpec.first.frames[1].blocks[0];
let wrongMiddle : Frames.WriteBlockSlice = {
    pinnedMiddle with content_id = Fixtures.id(599)
};
let wrongControlBody = continuationBody(
    expirySpec,
    expiryRequestId,
    expiryStageId,
    1,
    false,
    [wrongMiddle],
    middleRaw,
);
assertReason(
    expiryService.writeBlock(
        {
            middleRequest with
            body_bytes = Nat32.fromNat(wrongControlBody.size());
        },
        wrongControlBody,
    ),
    #conflict,
);
let wrongMiddleBody = changedLast(middleBody);
assertReason(
    expiryService.writeBlock(
        {
            middleRequest with
            body_bytes = Nat32.fromNat(wrongMiddleBody.size());
        },
        wrongMiddleBody,
    ),
    #conflict,
);
assert (
    Map.get(expiryMem.stages, Nat64.compare, expiryStageId) != null
);

assertReason(
    expiryService.writeBlock(middleRequest, middleBody),
    #expired,
);

// Expiry removes all uncommitted blocks, but its retained receipt continues
// to own both allocation identities until the receipt itself is pruned.
let expiredNodeCollision = createSpec(
    expiryMem,
    Fixtures.id(504),
    Fixtures.id(502),
    Fixtures.id(504),
    504,
    false,
    Nat64.fromNat(Types.MAX_PHYSICAL_PRIVATE_BYTES),
);
let expiredNodeCollisionBody = packFirst(expiredNodeCollision);
assertReason(
    expiryService.writeBlock(
        request(
            expiredNodeCollision.first.request_id,
            null,
            0,
            true,
            expiredNodeCollisionBody,
        ),
        expiredNodeCollisionBody,
    ),
    #id_collision,
);
let expiredContentCollision = createSpec(
    expiryMem,
    Fixtures.id(505),
    Fixtures.id(505),
    Fixtures.id(503),
    505,
    false,
    Nat64.fromNat(Types.MAX_PHYSICAL_PRIVATE_BYTES),
);
let expiredContentCollisionBody = packFirst(
    expiredContentCollision
);
assertReason(
    expiryService.writeBlock(
        request(
            expiredContentCollision.first.request_id,
            null,
            0,
            true,
            expiredContentCollisionBody,
        ),
        expiredContentCollisionBody,
    ),
    #id_collision,
);
assert (
    Map.get(expiryMem.stages, Nat64.compare, expiryStageId) == null
);
assert (
    Map.get(
        expiryMem.private_receipts,
        Keys.compareId128,
        expiryRequestId,
    ) != null
);

assertReason(
    expiryService.writeBlock(
        {
            middleRequest with
            body_bytes = Nat32.fromNat(wrongControlBody.size());
        },
        wrongControlBody,
    ),
    #conflict,
);
assertReason(
    expiryService.writeBlock(
        {
            middleRequest with
            body_bytes = Nat32.fromNat(wrongMiddleBody.size());
        },
        wrongMiddleBody,
    ),
    #conflict,
);
assertReason(
    expiryService.writeBlock(middleRequest, middleBody),
    #expired,
);

// Once the terminal receipt reaches its own retention deadline, cleanup
// releases both identity rows. The same uncommitted allocation can then be
// admitted and committed normally.
let ?retainedExpiryReceipt = Map.get(
    expiryMem.private_receipts,
    Keys.compareId128,
    expiryRequestId,
) else Runtime.trap("missing retained expiry receipt");
expiryClock := retainedExpiryReceipt.expires_at_ns;
switch (expiryService.cleanup()) {
    case (#ok(_)) {};
    case (value) Runtime.trap(
        "expiry receipt cleanup failed: " # debug_show (value)
    );
};
assert (
    Map.get(
        expiryMem.private_receipt_identity_owners,
        Keys.compareId128,
        Fixtures.id(502),
    ) == null
);
assert (
    Map.get(
        expiryMem.private_receipt_identity_owners,
        Keys.compareId128,
        Fixtures.id(503),
    ) == null
);
let expiryReuseZero = createSpec(
    expiryMem,
    Fixtures.id(506),
    Fixtures.id(502),
    Fixtures.id(503),
    506,
    false,
    0,
);
let expiryReuseZeroBody = packFirst(expiryReuseZero);
let expiryReuse = createSpec(
    expiryMem,
    Fixtures.id(506),
    Fixtures.id(502),
    Fixtures.id(503),
    506,
    false,
    exactGross(
        expiryMem,
        expiryReuseZero,
        expiryReuseZeroBody.size(),
    ),
);
let expiryReuseBody = packFirst(expiryReuse);
switch (
    expiryService.writeBlock(
        request(
            expiryReuse.first.request_id,
            null,
            0,
            true,
            expiryReuseBody,
        ),
        expiryReuseBody,
    )
) {
    case (#ok(value)) {
        assert (value.committed_nodes.size() == 1);
        assert (value.committed_nodes[0].node_id == Fixtures.id(502));
        assert (
            value.committed_nodes[0].content_id ==
            ?Fixtures.id(503)
        );
    };
    case (value) Runtime.trap(
        "released expiry identities were not reusable: " #
        debug_show (value)
    );
};

// A successful private abort retains every planned node/content allocation,
// even though the accepted blocks and the active stage have been removed.
// Exact abort replay is side-effect free and both cross-operation collision
// checks remain active for the receipt's lifetime.
var abortClock : Nat64 = 20_000;
let abortMem = Memory.init();
let abortService = Service.Service(
    abortMem,
    Fixtures.assets(Fixtures.zeroUsage()),
    func() { abortClock },
);
initialize(abortService, Fixtures.id(520));
let abortRequestId = Fixtures.id(521);
let abortNodeId = Fixtures.id(522);
let abortContentId = Fixtures.id(523);
let abortZero = createSpec(
    abortMem,
    abortRequestId,
    abortNodeId,
    abortContentId,
    520,
    true,
    0,
);
let abortZeroBody = packFirst(abortZero);
let abortSpec = createSpec(
    abortMem,
    abortRequestId,
    abortNodeId,
    abortContentId,
    520,
    true,
    exactGross(abortMem, abortZero, abortZeroBody.size()),
);
let abortFirstBody = packFirst(abortSpec);
let abortStageId = switch (
    abortService.writeBlock(
        request(
            abortRequestId,
            null,
            0,
            false,
            abortFirstBody,
        ),
        abortFirstBody,
    )
) {
    case (#ok(value)) {
        let ?stageId = value.stage_id else Runtime.trap(
            "abort stage missing id"
        );
        stageId;
    };
    case (value) Runtime.trap(
        "abort stage admission failed: " # debug_show (value)
    );
};
let abortRequest : Types.AbortRequest = {
    request_id = abortRequestId;
    stage_id = abortStageId;
    stage_kind = ?#private_write;
    source_node_id = null;
    source_content_id = null;
};
switch (abortService.abort(abortRequest)) {
    case (#ok(value)) {
        assert (value.request_id == abortRequestId);
        assert (value.stage_id == abortStageId);
    };
    case (value) Runtime.trap(
        "private abort failed: " # debug_show (value)
    );
};
assert (Map.get(abortMem.stages, Nat64.compare, abortStageId) == null);
let ?abortNodeOwner = Map.get(
    abortMem.private_receipt_identity_owners,
    Keys.compareId128,
    abortNodeId,
) else Runtime.trap("abort receipt lost node ownership");
let ?abortContentOwner = Map.get(
    abortMem.private_receipt_identity_owners,
    Keys.compareId128,
    abortContentId,
) else Runtime.trap("abort receipt lost content ownership");
assert (abortNodeOwner.node_count == 1);
assert (abortNodeOwner.content_count == 0);
assert (abortContentOwner.node_count == 0);
assert (abortContentOwner.content_count == 1);
let abortPhysical = abortMem.physical_private_bytes;
switch (abortService.abort(abortRequest)) {
    case (#ok(_)) {};
    case (value) Runtime.trap(
        "exact private abort retry failed: " # debug_show (value)
    );
};
assert (abortMem.physical_private_bytes == abortPhysical);
assert (
    Map.get(
        abortMem.private_receipt_identity_owners,
        Keys.compareId128,
        abortNodeId,
    ) == ?abortNodeOwner
);
assert (
    Map.get(
        abortMem.private_receipt_identity_owners,
        Keys.compareId128,
        abortContentId,
    ) == ?abortContentOwner
);
let abortNodeCollision = createSpec(
    abortMem,
    Fixtures.id(524),
    abortNodeId,
    Fixtures.id(524),
    524,
    false,
    Nat64.fromNat(Types.MAX_PHYSICAL_PRIVATE_BYTES),
);
let abortNodeCollisionBody = packFirst(abortNodeCollision);
assertReason(
    abortService.writeBlock(
        request(
            abortNodeCollision.first.request_id,
            null,
            0,
            true,
            abortNodeCollisionBody,
        ),
        abortNodeCollisionBody,
    ),
    #id_collision,
);
let abortContentCollision = createSpec(
    abortMem,
    Fixtures.id(525),
    Fixtures.id(525),
    abortContentId,
    525,
    false,
    Nat64.fromNat(Types.MAX_PHYSICAL_PRIVATE_BYTES),
);
let abortContentCollisionBody = packFirst(abortContentCollision);
assertReason(
    abortService.writeBlock(
        request(
            abortContentCollision.first.request_id,
            null,
            0,
            true,
            abortContentCollisionBody,
        ),
        abortContentCollisionBody,
    ),
    #id_collision,
);

// Two replacements can be admitted against the same committed counter because
// their nodes, contents, and CAS sets are disjoint. The first final reaches the
// logical ciphertext ceiling; the second final rechecks the live counter and
// returns quota before accepting its last block.
let cipherMem = Memory.init();
let cipherService = Service.Service(
    cipherMem,
    Fixtures.assets(Fixtures.zeroUsage()),
    func() { clock },
);
initialize(cipherService, Fixtures.id(300));
let cipherNodeA = Fixtures.id(301);
let cipherOldA = Fixtures.id(302);
let cipherNodeB = Fixtures.id(303);
let cipherOldB = Fixtures.id(304);
seedTopLevelReplacementFiles(
    cipherMem,
    cipherNodeA,
    cipherOldA,
    Frames.digestToTag(Fixtures.digest(301)),
    cipherNodeB,
    cipherOldB,
    Frames.digestToTag(Fixtures.digest(302)),
);
cipherMem.committed_ciphertext_bytes :=
    Types.MAX_COMMITTED_CIPHERTEXT_BYTES - 1;

let cipherRequestA = Fixtures.id(305);
let cipherNewA = Fixtures.id(306);
let cipherZeroA = replaceSpec(
    cipherMem,
    cipherRequestA,
    cipherNodeA,
    cipherNewA,
    0,
);
let cipherZeroBodyA = packFirst(cipherZeroA);
let cipherSpecA = replaceSpec(
    cipherMem,
    cipherRequestA,
    cipherNodeA,
    cipherNewA,
    exactGross(
        cipherMem,
        cipherZeroA,
        cipherZeroBodyA.size(),
    ),
);
let cipherBodyA = packFirst(cipherSpecA);
let cipherStageA = switch (
    cipherService.writeBlock(
        request(cipherRequestA, null, 0, false, cipherBodyA),
        cipherBodyA,
    )
) {
    case (#ok(value)) {
        let ?stageId = value.stage_id else Runtime.trap(
            "cipher stage A missing id"
        );
        stageId;
    };
    case (value) Runtime.trap(
        "cipher stage A failed: " # debug_show (value)
    );
};

let cipherRequestB = Fixtures.id(307);
let cipherNewB = Fixtures.id(308);
let cipherZeroB = replaceSpec(
    cipherMem,
    cipherRequestB,
    cipherNodeB,
    cipherNewB,
    0,
);
let cipherZeroBodyB = packFirst(cipherZeroB);
let cipherSpecB = replaceSpec(
    cipherMem,
    cipherRequestB,
    cipherNodeB,
    cipherNewB,
    exactGross(
        cipherMem,
        cipherZeroB,
        cipherZeroBodyB.size(),
    ),
);
let cipherBodyB = packFirst(cipherSpecB);
let cipherStageB = switch (
    cipherService.writeBlock(
        request(cipherRequestB, null, 0, false, cipherBodyB),
        cipherBodyB,
    )
) {
    case (#ok(value)) {
        let ?stageId = value.stage_id else Runtime.trap(
            "cipher stage B missing id"
        );
        stageId;
    };
    case (value) Runtime.trap(
        "cipher stage B failed: " # debug_show (value)
    );
};
assert (Map.size(cipherMem.stages) == 2);

let cipherFinalRawA = cipherSpecA.continuation_raws[0];
let cipherFinalBodyA = continuationBody(
    cipherSpecA,
    cipherRequestA,
    cipherStageA,
    1,
    true,
    cipherSpecA.first.frames[1].blocks,
    cipherFinalRawA,
);
switch (
    cipherService.writeBlock(
        request(
            cipherRequestA,
            ?cipherStageA,
            1,
            true,
            cipherFinalBodyA,
        ),
        cipherFinalBodyA,
    )
) {
    case (#ok(_)) {};
    case (value) Runtime.trap(
        "cipher stage A final failed: " # debug_show (value)
    );
};
assert (
    cipherMem.committed_ciphertext_bytes ==
    Types.MAX_COMMITTED_CIPHERTEXT_BYTES
);

let cipherFinalRawB = cipherSpecB.continuation_raws[0];
let cipherFinalBodyB = continuationBody(
    cipherSpecB,
    cipherRequestB,
    cipherStageB,
    1,
    true,
    cipherSpecB.first.frames[1].blocks,
    cipherFinalRawB,
);
assertReason(
    cipherService.writeBlock(
        request(
            cipherRequestB,
            ?cipherStageB,
            1,
            true,
            cipherFinalBodyB,
        ),
        cipherFinalBodyB,
    ),
    #quota,
);
assert (
    Map.get(cipherMem.stages, Nat64.compare, cipherStageB) != null
);
assert (
    Map.get(
        cipherMem.blocks,
        Keys.compareBlockKey,
        Keys.blockKey(cipherNewB, 1),
    ) == null
);

// The same final-preflight rule applies to the node ceiling. Each batch changes
// a different parent and replaces a different file while keeping every
// ancestor aggregate unchanged, so their final structural CAS sets are
// disjoint. Only the live node counter makes the second final inadmissible.
let nodeRaceMem = Memory.init();
let nodeRaceService = Service.Service(
    nodeRaceMem,
    Fixtures.assets(Fixtures.zeroUsage()),
    func() { clock },
);
initialize(nodeRaceService, Fixtures.id(400));
let folderA = Fixtures.id(401);
let oldNodeA = Fixtures.id(402);
let oldContentA = Fixtures.id(403);
let folderB = Fixtures.id(410);
let oldNodeB = Fixtures.id(411);
let oldContentB = Fixtures.id(412);
seedNodeRaceTree(
    nodeRaceMem,
    folderA,
    Frames.digestToTag(Fixtures.digest(401)),
    oldNodeA,
    Frames.digestToTag(Fixtures.digest(402)),
    oldContentA,
    folderB,
    Frames.digestToTag(Fixtures.digest(410)),
    oldNodeB,
    Frames.digestToTag(Fixtures.digest(411)),
    oldContentB,
);
nodeRaceMem.node_count := Types.MAX_NODES - 1;

let nodeRequestA = Fixtures.id(420);
let nodeZeroA = nodeRaceBatchSpec(
    nodeRaceMem,
    nodeRequestA,
    folderA,
    oldNodeA,
    Fixtures.id(421),
    Fixtures.id(422),
    Fixtures.id(423),
    422,
    0,
);
let nodeZeroBodyA = packFirst(nodeZeroA);
let nodeSpecA = nodeRaceBatchSpec(
    nodeRaceMem,
    nodeRequestA,
    folderA,
    oldNodeA,
    Fixtures.id(421),
    Fixtures.id(422),
    Fixtures.id(423),
    422,
    exactGross(
        nodeRaceMem,
        nodeZeroA,
        nodeZeroBodyA.size(),
    ),
);
let nodeBodyA = packFirst(nodeSpecA);
let nodeStageA = switch (
    nodeRaceService.writeBlock(
        request(nodeRequestA, null, 0, false, nodeBodyA),
        nodeBodyA,
    )
) {
    case (#ok(value)) {
        let ?stageId = value.stage_id else Runtime.trap(
            "node stage A missing id"
        );
        stageId;
    };
    case (value) Runtime.trap(
        "node stage A failed: " # debug_show (value)
    );
};

let nodeRequestB = Fixtures.id(430);
let nodeZeroB = nodeRaceBatchSpec(
    nodeRaceMem,
    nodeRequestB,
    folderB,
    oldNodeB,
    Fixtures.id(431),
    Fixtures.id(432),
    Fixtures.id(433),
    432,
    0,
);
let nodeZeroBodyB = packFirst(nodeZeroB);
let nodeSpecB = nodeRaceBatchSpec(
    nodeRaceMem,
    nodeRequestB,
    folderB,
    oldNodeB,
    Fixtures.id(431),
    Fixtures.id(432),
    Fixtures.id(433),
    432,
    exactGross(
        nodeRaceMem,
        nodeZeroB,
        nodeZeroBodyB.size(),
    ),
);
let nodeBodyB = packFirst(nodeSpecB);
let nodeStageB = switch (
    nodeRaceService.writeBlock(
        request(nodeRequestB, null, 0, false, nodeBodyB),
        nodeBodyB,
    )
) {
    case (#ok(value)) {
        let ?stageId = value.stage_id else Runtime.trap(
            "node stage B missing id"
        );
        stageId;
    };
    case (value) Runtime.trap(
        "node stage B failed: " # debug_show (value)
    );
};
assert (Map.size(nodeRaceMem.stages) == 2);

let nodeFinalRawA = nodeSpecA.continuation_raws[0];
let nodeFinalBodyA = continuationBody(
    nodeSpecA,
    nodeRequestA,
    nodeStageA,
    1,
    true,
    nodeSpecA.first.frames[1].blocks,
    nodeFinalRawA,
);
switch (
    nodeRaceService.writeBlock(
        request(
            nodeRequestA,
            ?nodeStageA,
            1,
            true,
            nodeFinalBodyA,
        ),
        nodeFinalBodyA,
    )
) {
    case (#ok(_)) {};
    case (value) Runtime.trap(
        "node stage A final failed: " # debug_show (value)
    );
};
assert (nodeRaceMem.node_count == Types.MAX_NODES);

let nodeFinalRawB = nodeSpecB.continuation_raws[0];
let nodeFinalBodyB = continuationBody(
    nodeSpecB,
    nodeRequestB,
    nodeStageB,
    1,
    true,
    nodeSpecB.first.frames[1].blocks,
    nodeFinalRawB,
);
assertReason(
    nodeRaceService.writeBlock(
        request(
            nodeRequestB,
            ?nodeStageB,
            1,
            true,
            nodeFinalBodyB,
        ),
        nodeFinalBodyB,
    ),
    #quota,
);
assert (
    Map.get(nodeRaceMem.stages, Nat64.compare, nodeStageB) != null
);
assert (
    Map.get(
        nodeRaceMem.blocks,
        Keys.compareBlockKey,
        Keys.blockKey(Fixtures.id(433), 1),
    ) == null
);

// A private stage owns its complete peak reservation. Unrelated vault and tree
// mutations see the reservation in physical admission and cannot consume it;
// the already admitted continuation can still commit.
let reserveMem = Memory.init();
let reserveService = Service.Service(
    reserveMem,
    Fixtures.assets(Fixtures.zeroUsage()),
    func() { clock },
);
initialize(reserveService, Fixtures.id(200));
let reserveRequestId = Fixtures.id(201);
let reserveNodeId = Fixtures.id(202);
let reserveContentId = Fixtures.id(203);
let reserveZero = createSpec(
    reserveMem,
    reserveRequestId,
    reserveNodeId,
    reserveContentId,
    200,
    true,
    0,
);
let reserveZeroBody = packFirst(reserveZero);
let reservedPeak = reservationPeak(
    reserveZero,
    reserveZeroBody.size(),
);
assert (reservedPeak < Types.MAX_PHYSICAL_PRIVATE_BYTES);
reserveMem.physical_private_bytes :=
    Types.MAX_PHYSICAL_PRIVATE_BYTES - reservedPeak;
let reserveSpec = createSpec(
    reserveMem,
    reserveRequestId,
    reserveNodeId,
    reserveContentId,
    200,
    true,
    Nat64.fromNat(Types.MAX_PHYSICAL_PRIVATE_BYTES),
);
let reserveBody = packFirst(reserveSpec);
let reserveStageId = switch (
    reserveService.writeBlock(
        request(reserveRequestId, null, 0, false, reserveBody),
        reserveBody,
    )
) {
    case (#ok(value)) {
        let ?stageId = value.stage_id else Runtime.trap(
            "reservation stage missing id"
        );
        stageId;
    };
    case (value) Runtime.trap(
        "reservation stage failed: " # debug_show (value)
    );
};
assert (
    reserveMem.physical_private_bytes +
    reserveMem.reserved_physical_private_bytes ==
    Types.MAX_PHYSICAL_PRIVATE_BYTES
);

let ?reserveVault = reserveMem.vault else Runtime.trap(
    "reservation vault missing"
);
let rewrapRaw = Fixtures.zeros(48);
let rewrapControl : Frames.VaultWriteFrameControl = {
    request_id = Fixtures.id(204);
    expected_record_revision = ?reserveVault.record_revision;
    proposed_record_revision = reserveVault.record_revision + 1;
    operation = ?#rewrap({
        format = reserveVault.format;
        vault_id = reserveVault.vault_id;
        vault_salt = Frames.digestFromTag(reserveVault.vault_salt);
        slot_generation = reserveVault.slot_generation + 1;
        public_key_fingerprint = Fixtures.digest(201);
        root_commitment =
            Frames.digestFromTag(reserveVault.root_commitment);
        ibe_wrapped_root_key = { offset = 0; length = 48 };
    });
    raw_payload_bytes = 48;
};
let rewrapBody = Fixtures.pack(to_candid (rewrapControl), rewrapRaw);
assertReason(
    reserveService.vaultWrite(
        {
            request_id = rewrapControl.request_id;
            operation = ?#rewrap;
            expected_record_revision =
                rewrapControl.expected_record_revision;
            proposed_record_revision =
                rewrapControl.proposed_record_revision;
            body_bytes = Nat32.fromNat(rewrapBody.size());
        },
        rewrapBody,
    ),
    #quota,
);
assert (reserveMem.vault == ?reserveVault);

let reserveRoot = node(reserveMem, Types.ROOT_NODE_ID);
let folderId = Fixtures.id(205);
let folderTag = Fixtures.digest(202);
let folderControl : Frames.MutateFrameControl = {
    request_id = Fixtures.id(206);
    action = ?#create_folder;
    node = {
        node_id = folderId;
        expected_parent_id = null;
        proposed_parent_id = Types.ROOT_NODE_ID;
        requested_kind = ?#folder;
        expected_name_tag = null;
        proposed_name_tag = folderTag;
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
        expected_structural_revision =
            reserveRoot.structural_revision;
        expected_children_revision =
            reserveRoot.children_revision;
    }];
    child_index_transitions = [{
        parent_id = Types.ROOT_NODE_ID;
        name_tag = folderTag;
        expected_node_id = null;
        proposed_node_id = ?folderId;
    }];
    raw_payload_bytes = 16;
};
let folderBody = Fixtures.pack(
    to_candid (folderControl),
    Fixtures.zeros(16),
);
let reservedNodeFolderControl : Frames.MutateFrameControl = {
    folderControl with
    request_id = Fixtures.id(207);
    node = {
        folderControl.node with node_id = reserveNodeId
    };
    child_index_transitions = [{
        folderControl.child_index_transitions[0] with
        proposed_node_id = ?reserveNodeId
    }];
};
let reservedNodeFolderBody = Fixtures.pack(
    to_candid (reservedNodeFolderControl),
    Fixtures.zeros(16),
);
assertReason(
    reserveService.mutate(
        {
            request_id = reservedNodeFolderControl.request_id;
            action = ?#create_folder;
            body_bytes = Nat32.fromNat(
                reservedNodeFolderBody.size()
            );
        },
        reservedNodeFolderBody,
    ),
    #id_collision,
);
assert (
    Map.get(
        reserveMem.stages,
        Nat64.compare,
        reserveStageId,
    ) != null
);
assertReason(
    reserveService.mutate(
        {
            request_id = folderControl.request_id;
            action = ?#create_folder;
            body_bytes = Nat32.fromNat(folderBody.size());
        },
        folderBody,
    ),
    #quota,
);
assert (
    Map.get(
        reserveMem.nodes_by_id,
        Keys.compareId128,
        folderId,
    ) == null
);

let reserveFinalRaw = reserveSpec.continuation_raws[0];
let reserveFinalBody = continuationBody(
    reserveSpec,
    reserveRequestId,
    reserveStageId,
    1,
    true,
    reserveSpec.first.frames[1].blocks,
    reserveFinalRaw,
);
switch (
    reserveService.writeBlock(
        request(
            reserveRequestId,
            ?reserveStageId,
            1,
            true,
            reserveFinalBody,
        ),
        reserveFinalBody,
    )
) {
    case (#ok(value)) {
        assert (value.committed_nodes[0].node_id == reserveNodeId);
    };
    case (value) Runtime.trap(
        "reserved continuation failed: " # debug_show (value)
    );
};

// The witness is a conservative lower bound: +1 is accepted, but the backend
// still reserves only its independently derived amount.
let plusMem = Memory.init();
let plusService = Service.Service(
    plusMem,
    Fixtures.assets(Fixtures.zeroUsage()),
    func() { clock },
);
initialize(plusService, Fixtures.id(100));
let plusZero = createSpec(
    plusMem,
    Fixtures.id(101),
    Fixtures.id(102),
    Fixtures.id(103),
    100,
    false,
    0,
);
let plusZeroBody = packFirst(plusZero);
let plusGross = exactGross(
    plusMem,
    plusZero,
    plusZeroBody.size(),
);
let plus = createSpec(
    plusMem,
    Fixtures.id(101),
    Fixtures.id(102),
    Fixtures.id(103),
    100,
    false,
    plusGross + 1,
);
let plusBody = packFirst(plus);
switch (
    plusService.writeBlock(
        request(Fixtures.id(101), null, 0, true, plusBody),
        plusBody,
    )
) {
    case (#ok(value)) {
        assert (value.committed_nodes[0].node_id == Fixtures.id(102));
    };
    case (value) Runtime.trap(
        "gross plus-one write failed: " # debug_show (value)
    );
};

// A two-frame create persists only its first block, idempotently reports stage
// progress, and atomically publishes on the final continuation. Final-frame
// retries reconcile from the receipt and altered attachment bytes conflict.
let multiRequestId = Fixtures.id(5);
let multiNodeId = Fixtures.id(6);
let multiContentId = Fixtures.id(7);
let multiZero = createSpec(
    oneMem,
    multiRequestId,
    multiNodeId,
    multiContentId,
    11,
    true,
    0,
);
let multiZeroBody = packFirst(multiZero);
let multiGross = exactGross(
    oneMem,
    multiZero,
    multiZeroBody.size(),
);
let multi = createSpec(
    oneMem,
    multiRequestId,
    multiNodeId,
    multiContentId,
    11,
    true,
    multiGross,
);
let multiBody = packFirst(multi);
let multiFirstRequest = request(
    multiRequestId,
    null,
    0,
    false,
    multiBody,
);
let multiStageId = switch (
    oneService.writeBlock(multiFirstRequest, multiBody)
) {
    case (#ok(value)) {
        assert (value.accepted_frames_bitmap == 1);
        assert (value.committed_nodes.size() == 0);
        let ?stageId = value.stage_id else Runtime.trap(
            "missing private stage id"
        );
        stageId;
    };
    case (value) Runtime.trap(
        "first multi-frame write failed: " # debug_show (value)
    );
};
switch (oneService.writeBlock(multiFirstRequest, multiBody)) {
    case (#ok(value)) {
        assert (value.stage_id == ?multiStageId);
        assert (value.accepted_frames_bitmap == 1);
    };
    case (_) assert false;
};
let multiFinalRaw = multi.continuation_raws[0];
let multiFinalBody = continuationBody(
    multi,
    multiRequestId,
    multiStageId,
    1,
    true,
    multi.first.frames[1].blocks,
    multiFinalRaw,
);
let multiFinalRequest = request(
    multiRequestId,
    ?multiStageId,
    1,
    true,
    multiFinalBody,
);
switch (
    oneService.writeBlock(multiFinalRequest, multiFinalBody)
) {
    case (#ok(value)) {
        assert (value.stage_id == ?multiStageId);
        assert (value.accepted_frames_bitmap == 3);
        assert (value.committed_nodes.size() == 1);
        assert (value.committed_nodes[0].node_id == multiNodeId);
        assert (
            value.committed_nodes[0].content_id == ?multiContentId
        );
    };
    case (value) Runtime.trap(
        "final multi-frame write failed: " # debug_show (value)
    );
};
let multiPhysical = oneMem.physical_private_bytes;
switch (
    oneService.writeBlock(multiFinalRequest, multiFinalBody)
) {
    case (#ok(value)) assert (value.accepted_frames_bitmap == 3);
    case (_) assert false;
};
assert (oneMem.physical_private_bytes == multiPhysical);
let changedFinal = changedLast(multiFinalBody);
assertReason(
    oneService.writeBlock(
        {
            multiFinalRequest with
            body_bytes = Nat32.fromNat(changedFinal.size());
        },
        changedFinal,
    ),
    #conflict,
);
