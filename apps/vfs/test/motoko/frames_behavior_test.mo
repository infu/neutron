import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import CandidGuard "../../backend/files/CandidGuard";
import Frames "../../backend/files/Frames";
import Types "../../backend/files/Types";

func zeros(count : Nat) : Blob {
    Blob.fromArray(Array.tabulate<Nat8>(count, func(_) { 0 }));
};

func bytes(values : [Nat8]) : Blob { Blob.fromArray(values) };

func frame(control : Blob, raw : Blob) : Blob {
    let length = Nat32.fromNat(control.size());
    Frames.append([
        bytes([
            Nat8.fromNat(Nat32.toNat(length >> 24) % 256),
            Nat8.fromNat(Nat32.toNat(length >> 16) % 256),
            Nat8.fromNat(Nat32.toNat(length >> 8) % 256),
            Nat8.fromNat(Nat32.toNat(length) % 256),
        ]),
        control,
        raw,
    ]);
};

func encodedVault(
    control : Frames.VaultWriteFrameControl,
    raw : Blob,
) : Blob {
    frame(to_candid (control), raw);
};

func encodedWrite(
    control : Frames.WriteBlockFrameControl,
    raw : Blob,
) : Blob {
    frame(to_candid (control), raw);
};

func assertNone<T>(value : ?T) {
    switch (value) {
        case null {};
        case (?_) assert false;
    };
};

func assertSome<T>(value : ?T) : T {
    switch (value) {
        case (?result) result;
        case null {
            assert false;
            loop {};
        };
    };
};

let id0 : Types.Id128 = { hi = 0; lo = 0 };
let id1 : Types.Id128 = { hi = 0; lo = 1 };
let id2 : Types.Id128 = { hi = 0; lo = 2 };
let digest : Frames.Digest256 = { a = 1; b = 2; c = 3; d = 4 };

// The hostile-Candid preflight accepts exactly one canonical value and rejects
// overlong integer encodings, invalid primitive values, truncation, and
// trailing bytes before `from_candid` is ever attempted.
let canonicalNat8 = bytes([0x44, 0x49, 0x44, 0x4c, 0x00, 0x01, 0x7b, 0x2a]);
assert (CandidGuard.validOne(canonicalNat8, 100));
assert (
    not CandidGuard.validOne(
        bytes([
            0x44, 0x49, 0x44, 0x4c, 0x00, 0x81, 0x00, 0x7b, 0x2a
        ]),
        100,
    )
);
assert (
    not CandidGuard.validOne(
        bytes([0x44, 0x49, 0x44, 0x4c, 0x00, 0x01, 0x7e, 0x02]),
        100,
    )
);
assert (
    not CandidGuard.validOne(
        bytes([0x44, 0x49, 0x44, 0x4c, 0x00, 0x01, 0x7b]),
        100,
    )
);
assert (
    not CandidGuard.validOne(
        bytes([
            0x44, 0x49, 0x44, 0x4c, 0x00, 0x01, 0x7b, 0x2a, 0x00
        ]),
        100,
    )
);
assert (not CandidGuard.validOne(canonicalNat8, canonicalNat8.size() - 1));
let canonicalNull = bytes([
    0x44, 0x49, 0x44, 0x4c, 0x00, 0x01, 0x7f
]);
assert (CandidGuard.validOne(canonicalNull, 100));
// Signed LEB -1 must use one byte; ff 7f is a redundant sign extension.
assert (
    not CandidGuard.validOne(
        bytes([
            0x44, 0x49, 0x44, 0x4c, 0x00, 0x01, 0xff, 0x7f
        ]),
        100,
    )
);
let canonicalEmptyRecord = bytes([
    0x44, 0x49, 0x44, 0x4c,
    0x01, 0x6c, 0x00,
    0x01, 0x00,
]);
assert (CandidGuard.validOne(canonicalEmptyRecord, 100));
// Signed LEB +0 must use one byte; 80 00 is a redundant zero extension.
assert (
    not CandidGuard.validOne(
        bytes([
            0x44, 0x49, 0x44, 0x4c,
            0x01, 0x6c, 0x00,
            0x01, 0x80, 0x00,
        ]),
        100,
    )
);
// A positive table reference must resolve within the bounded type table.
assert (
    not CandidGuard.validOne(
        bytes([
            0x44, 0x49, 0x44, 0x4c,
            0x01, 0x6c, 0x00,
            0x01, 0x01,
        ]),
        100,
    )
);
let canonicalSingleVariant = bytes([
    0x44, 0x49, 0x44, 0x4c,
    0x01, 0x6b, 0x01, 0x00, 0x7f,
    0x01, 0x00,
    0x00,
]);
assert (CandidGuard.validOne(canonicalSingleVariant, 100));
assert (
    not CandidGuard.validOne(
        bytes([
            0x44, 0x49, 0x44, 0x4c,
            0x01, 0x6b, 0x01, 0x00, 0x7f,
            0x01, 0x00,
            0x01,
        ]),
        100,
    )
);

// Length-prefixed framing is exact and bounded.
assertNone(Frames.split(bytes([]), Types.MAX_FRAME_BYTES));
assertNone(Frames.split(bytes([0, 0, 0]), Types.MAX_FRAME_BYTES));
assertNone(Frames.split(bytes([0, 0, 0, 0]), Types.MAX_FRAME_BYTES));
assertNone(
    Frames.split(bytes([0, 0, 0, 2, 0]), Types.MAX_FRAME_BYTES)
);
assertNone(
    Frames.split(
        Frames.append([
            bytes([0, 8, 0, 1]),
            zeros(Types.MAX_CONTROL_ALLOCATION_BYTES + 1),
        ]),
        Types.MAX_FRAME_BYTES,
    )
);

let initialize : Frames.VaultWriteFrameControl = {
    request_id = id1;
    expected_record_revision = null;
    proposed_record_revision = 1;
    operation = ?#initialize({
        format = 2;
        vault_id = id2;
        vault_salt = digest;
        slot_generation = 1;
        public_key_fingerprint = digest;
        root_commitment = digest;
        root_structural_revision = 1;
        root_metadata_revision = 1;
        root_children_revision = 1;
        ibe_wrapped_root_key = { offset = 0; length = 32 };
        encrypted_root_metadata = { offset = 32; length = 16 };
    });
    raw_payload_bytes = 48;
};
let initializeRaw = zeros(48);
let initializeFrame = encodedVault(initialize, initializeRaw);
let decodedInitialize = assertSome(Frames.decodeVaultWrite(initializeFrame));
assert (decodedInitialize.control.request_id == id1);
assert (decodedInitialize.raw_payload.length == 48);
assert (Frames.payloadSlice(
    decodedInitialize.raw_payload,
    { offset = 0; length = 32 },
) == ?zeros(32));
assertNone(
    Frames.payloadSlice(
        decodedInitialize.raw_payload,
        { offset = 0; length = 0 },
    )
);
assertNone(
    Frames.payloadSlice(
        decodedInitialize.raw_payload,
        { offset = 47; length = 2 },
    )
);

// Extra raw bytes, gaps, overlaps, empty slices, or extra bytes inside the
// declared Candid control are not accepted as alternate encodings.
assertNone(
    Frames.decodeVaultWrite(
        Frames.append([initializeFrame, bytes([0])])
    )
);
let gappedInitialize : Frames.VaultWriteFrameControl = {
    initialize with
    operation = ?#initialize({
        format = 2;
        vault_id = id2;
        vault_salt = digest;
        slot_generation = 1;
        public_key_fingerprint = digest;
        root_commitment = digest;
        root_structural_revision = 1;
        root_metadata_revision = 1;
        root_children_revision = 1;
        ibe_wrapped_root_key = { offset = 0; length = 31 };
        encrypted_root_metadata = { offset = 32; length = 16 };
    });
};
assertNone(
    Frames.decodeVaultWrite(encodedVault(gappedInitialize, initializeRaw))
);
let candidWithTrailing = Frames.append([to_candid (initialize), bytes([0])]);
assertNone(
    Frames.decodeVaultWrite(frame(candidWithTrailing, initializeRaw))
);

func nodeTransition(metadataOffset : Nat32) : Frames.NodeTransitionFrame {
    {
        node_id = id1;
        expected_parent_id = null;
        proposed_parent_id = id0;
        requested_kind = ?#file;
        expected_name_tag = null;
        proposed_name_tag = digest;
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
        proposed_subtree_plaintext_bytes = 1;
        encrypted_metadata = { offset = metadataOffset; length = 16 };
    };
};

func oneBlockFirst(
    frames : [Frames.WriteFramePlan],
) : Frames.WriteBlockFrameControl {
    {
        frame = ?#first({
            request_id = id1;
            intent = ?#create;
            frame_ordinal = 0;
            frame_count = Nat8.fromNat(frames.size());
            final = frames.size() == 1;
            nodes = [{
                node = nodeTransition(0);
                content = ?{
                    content_id = id2;
                    wrapped_content_key = { offset = 16; length = 48 };
                    plaintext_block_lengths = [1];
                    ciphertext_block_lengths = [17];
                    ciphertext_bytes = 17;
                    crypto_profile = ?#aes_256_gcm_files_v2;
                };
            }];
            folder_transitions = [];
            child_index_transitions = [];
            retired_contents = [];
            quota = {
                expected_node_count = 1;
                proposed_node_count = 2;
                expected_committed_plaintext_bytes = 0;
                proposed_committed_plaintext_bytes = 1;
                expected_committed_ciphertext_bytes = 0;
                proposed_committed_ciphertext_bytes = 17;
                gross_peak_physical_bytes = 1_000;
            };
            frames;
            raw_payload_bytes = 81;
        });
    };
};

let block0 : Frames.WriteBlockSlice = {
    content_id = id2;
    block_index = 0;
    ciphertext_bytes = 17;
    payload = { offset = 64; length = 17 };
};

func boundedPlanControl(
    intent : ?Frames.WriteIntent,
    folderWitnesses : Nat,
    childTransitions : Nat,
) : Frames.WriteBlockFrameControl {
    let oldContentId : Types.Id128 = { hi = 0; lo = 3 };
    {
        frame = ?#first({
            request_id = id1;
            intent;
            frame_ordinal = 0;
            frame_count = 1;
            final = true;
            nodes = [{
                node = {
                    nodeTransition(0) with
                    expected_parent_id = ?id0;
                    expected_name_tag = ?digest;
                    expected_structural_revision = ?1;
                    proposed_structural_revision = 2;
                    expected_metadata_revision = ?1;
                    proposed_metadata_revision = 2;
                    expected_children_revision = ?0;
                    expected_subtree_height = ?0;
                    expected_max_relative_path_scalars = ?1;
                    expected_subtree_plaintext_bytes = ?1;
                };
                content = ?{
                    content_id = id2;
                    wrapped_content_key = { offset = 16; length = 48 };
                    plaintext_block_lengths = [1];
                    ciphertext_block_lengths = [17];
                    ciphertext_bytes = 17;
                    crypto_profile = ?#aes_256_gcm_files_v2;
                };
            }];
            folder_transitions =
                Array.tabulate<Frames.FolderAggregateTransition>(
                    folderWitnesses,
                    func(index) {
                        {
                            node_id = {
                                hi = 1;
                                lo = Nat64.fromNat(index + 1);
                            };
                            expected_structural_revision = 1;
                            expected_children_revision = 0;
                        };
                    },
                );
            child_index_transitions =
                Array.tabulate<Frames.ChildIndexTransition>(
                    childTransitions,
                    func(index) {
                        {
                            parent_id = {
                                hi = 2;
                                lo = Nat64.fromNat(index + 1);
                            };
                            name_tag = digest;
                            expected_node_id = null;
                            proposed_node_id = ?id1;
                        };
                    },
                );
            retired_contents = [{
                node_id = id1;
                content_id = oldContentId;
                block_count = 1;
                ciphertext_bytes = 17;
            }];
            quota = {
                expected_node_count = 2;
                proposed_node_count = 2;
                expected_committed_plaintext_bytes = 1;
                proposed_committed_plaintext_bytes = 1;
                expected_committed_ciphertext_bytes = 50;
                proposed_committed_ciphertext_bytes = 50;
                gross_peak_physical_bytes = 1_000;
            };
            frames = [{
                frame_ordinal = 0;
                raw_payload_bytes = 81;
                blocks = [block0];
            }];
            raw_payload_bytes = 81;
        });
    };
};

let validOneBlock = oneBlockFirst([{
    frame_ordinal = 0;
    raw_payload_bytes = 81;
    blocks = [block0];
}]);
assert (
    (to_candid (validOneBlock)).size() <=
    Types.MAX_SINGLE_WRITE_CONTROL_BYTES
);
let validOneBlockBody = encodedWrite(validOneBlock, zeros(81));
let validOneBlockParts = assertSome(
    Frames.split(validOneBlockBody, Types.MAX_FRAME_BYTES)
);
assert (
    CandidGuard.validOne(
        validOneBlockParts.control,
        Types.MAX_CONTROL_ALLOCATION_BYTES,
    )
);
let validOneBlockCandid : ?Frames.WriteBlockFrameControl =
    from_candid (validOneBlockParts.control);
switch (validOneBlockCandid) {
    case (?_) {};
    case null assert false;
};
switch (Frames.decodeWriteBlock(validOneBlockBody)) {
    case (?_) {};
    case null assert false;
};

// The first plan is authoritative: a block may be mapped exactly once across
// all frames, and every declared content block must be present with its exact
// ciphertext length. These assertions intentionally guard cross-frame cases,
// not merely duplicates inside one frame.
let duplicateAcrossFrames = oneBlockFirst([
    {
        frame_ordinal = 0;
        raw_payload_bytes = 81;
        blocks = [block0];
    },
    {
        frame_ordinal = 1;
        raw_payload_bytes = 17;
        blocks = [{
            block0 with
            payload = { offset = 0; length = 17 };
        }];
    },
]);
assertNone(
    Frames.decodeWriteBlock(encodedWrite(duplicateAcrossFrames, zeros(81)))
);

let missingDeclaredBlock : Frames.WriteBlockFrameControl = {
    frame = ?#first({
        request_id = id1;
        intent = ?#create;
        frame_ordinal = 0;
        frame_count = 1;
        final = true;
        nodes = [{
            node = nodeTransition(0);
            content = ?{
                content_id = id2;
                wrapped_content_key = { offset = 16; length = 48 };
                plaintext_block_lengths = [
                    1,
                    Nat32.fromNat(Types.MAX_PLAINTEXT_BLOCK_BYTES),
                ];
                ciphertext_block_lengths = [
                    17,
                    Nat32.fromNat(Types.MAX_PLAINTEXT_BLOCK_BYTES + 16),
                ];
                ciphertext_bytes = Nat64.fromNat(
                    17 + Types.MAX_PLAINTEXT_BLOCK_BYTES + 16
                );
                crypto_profile = ?#aes_256_gcm_files_v2;
            };
        }];
        folder_transitions = [];
        child_index_transitions = [];
        retired_contents = [];
        quota = {
            expected_node_count = 1;
            proposed_node_count = 2;
            expected_committed_plaintext_bytes = 0;
            proposed_committed_plaintext_bytes = Nat64.fromNat(
                1 + Types.MAX_PLAINTEXT_BLOCK_BYTES
            );
            expected_committed_ciphertext_bytes = 0;
            proposed_committed_ciphertext_bytes = Nat64.fromNat(
                33 + Types.MAX_PLAINTEXT_BLOCK_BYTES
            );
            gross_peak_physical_bytes = 2_000_000;
        };
        frames = [{
            frame_ordinal = 0;
            raw_payload_bytes = 81;
            blocks = [block0];
        }];
        raw_payload_bytes = 81;
    });
};
assertNone(
    Frames.decodeWriteBlock(encodedWrite(missingDeclaredBlock, zeros(81)))
);

// Exact maximum-file geometry: one short first block followed by 35 full
// blocks. Each ciphertext block adds one 16-byte AES-GCM tag.
let firstPlain = 959_424;
let fullPlain = Types.MAX_PLAINTEXT_BLOCK_BYTES;
assert (firstPlain + 35 * fullPlain == Types.MAX_FILE_PLAINTEXT_BYTES);
let plainLengths = Array.tabulate<Nat32>(
    36,
    func(index) {
        Nat32.fromNat(if (index == 0) firstPlain else fullPlain);
    },
);
let cipherLengths = Array.map<Nat32, Nat32>(
    plainLengths,
    func(length) { length + 16 },
);
let plans = Array.tabulate<Frames.WriteFramePlan>(
    36,
    func(index) {
        let cipher = cipherLengths[index];
        {
            frame_ordinal = Nat8.fromNat(index);
            raw_payload_bytes = if (index == 0) {
                cipher + 64
            } else {
                cipher
            };
            blocks = [{
                content_id = id2;
                block_index = Nat32.fromNat(index);
                ciphertext_bytes = cipher;
                payload = {
                    offset = if (index == 0) 64 else 0;
                    length = cipher;
                };
            }];
        };
    },
);
let maximumFile : Frames.WriteBlockFrameControl = {
    frame = ?#first({
        request_id = id1;
        intent = ?#create;
        frame_ordinal = 0;
        frame_count = 36;
        final = false;
        nodes = [{
            node = {
                nodeTransition(0) with
                proposed_subtree_plaintext_bytes = Nat64.fromNat(
                    Types.MAX_FILE_PLAINTEXT_BYTES
                );
            };
            content = ?{
                content_id = id2;
                wrapped_content_key = { offset = 16; length = 48 };
                plaintext_block_lengths = plainLengths;
                ciphertext_block_lengths = cipherLengths;
                ciphertext_bytes = Nat64.fromNat(
                    Types.MAX_FILE_PLAINTEXT_BYTES + 36 * 16
                );
                crypto_profile = ?#aes_256_gcm_files_v2;
            };
        }];
        folder_transitions = [];
        child_index_transitions = [];
        retired_contents = [];
        quota = {
            expected_node_count = 1;
            proposed_node_count = 2;
            expected_committed_plaintext_bytes = 0;
            proposed_committed_plaintext_bytes = Nat64.fromNat(
                Types.MAX_FILE_PLAINTEXT_BYTES
            );
            expected_committed_ciphertext_bytes = 0;
            proposed_committed_ciphertext_bytes = Nat64.fromNat(
                Types.MAX_FILE_PLAINTEXT_BYTES + 36 * 16
            );
            gross_peak_physical_bytes = Nat64.fromNat(
                Types.MAX_FILE_CIPHERTEXT_BYTES
            );
        };
        frames = plans;
        raw_payload_bytes = Nat32.fromNat(firstPlain + 16 + 64);
    });
};
switch (
    Frames.decodeWriteBlock(
        encodedWrite(maximumFile, zeros(firstPlain + 16 + 64))
    )
) {
    case (?_) {};
    case null assert false;
};

func structuralControl(
    intent : ?Frames.WriteIntent,
    oneByteOver : Bool,
) : Frames.WriteBlockFrameControl {
    let nodeCount = Types.MAX_BATCH_PLAN_ENTRIES;
    let metadataBytes = nodeCount * 16;
    let rawBytes = metadataBytes + 48 + 17;
    {
        frame = ?#first({
            request_id = id1;
            intent;
            frame_ordinal = 0;
            frame_count = 1;
            final = true;
            nodes = Array.tabulate<Frames.WriteNodePlan>(
                nodeCount,
                func(index) {
                    {
                        node = {
                            nodeTransition(
                                Nat32.fromNat(
                                    if (index == 0) 0 else index * 16 + 48
                                )
                            ) with
                            node_id = {
                                hi = 0;
                                lo = Nat64.fromNat(index + 1);
                            };
                            expected_name_tag =
                                if (index < 49) ?digest else null;
                            expected_subtree_height =
                                if (oneByteOver and index == 0) {
                                    ?0
                                } else null;
                        };
                        content = if (index == 0) {
                            ?{
                                content_id = id2;
                                wrapped_content_key = {
                                    offset = 16;
                                    length = 48;
                                };
                                plaintext_block_lengths = [1];
                                ciphertext_block_lengths = [17];
                                ciphertext_bytes = 17;
                                crypto_profile = ?#aes_256_gcm_files_v2;
                            }
                        } else null;
                    };
                },
            );
            folder_transitions = [];
            child_index_transitions = [];
            retired_contents = [];
            quota = {
                expected_node_count = 1;
                proposed_node_count = Nat64.fromNat(nodeCount + 1);
                expected_committed_plaintext_bytes = 0;
                proposed_committed_plaintext_bytes = 1;
                expected_committed_ciphertext_bytes = 0;
                proposed_committed_ciphertext_bytes = 17;
                gross_peak_physical_bytes = Nat64.fromNat(rawBytes);
            };
            frames = [{
                frame_ordinal = 0;
                raw_payload_bytes = Nat32.fromNat(rawBytes);
                blocks = [{
                    content_id = id2;
                    block_index = 0;
                    ciphertext_bytes = 17;
                    payload = {
                        offset = Nat32.fromNat(metadataBytes + 48);
                        length = 17;
                    };
                }];
            }];
            raw_payload_bytes = Nat32.fromNat(rawBytes);
        });
    };
};

// createParents is still a non-batch write: a structural first frame gets the
// same 9,996-byte ceiling as a one-node create or replace. The optional fields
// below make canonical, otherwise-valid controls land exactly on the boundary
// and one byte above it.
let exactStructuralCreate = structuralControl(?#create, false);
let overStructuralCreate = structuralControl(?#create, true);
let exactStructuralReplace = structuralControl(?#replace, false);
let overStructuralReplace = structuralControl(?#replace, true);
assert (
    (to_candid (exactStructuralCreate)).size() ==
    Types.MAX_SINGLE_WRITE_CONTROL_BYTES
);
assert (
    (to_candid (overStructuralCreate)).size() ==
    Types.MAX_SINGLE_WRITE_CONTROL_BYTES + 1
);
assert (
    (to_candid (exactStructuralReplace)).size() ==
    Types.MAX_SINGLE_WRITE_CONTROL_BYTES
);
assert (
    (to_candid (overStructuralReplace)).size() ==
    Types.MAX_SINGLE_WRITE_CONTROL_BYTES + 1
);
switch (
    Frames.decodeWriteBlock(
        encodedWrite(exactStructuralCreate, zeros(1_089))
    )
) {
    case (?_) {};
    case null assert false;
};
assertNone(
    Frames.decodeWriteBlock(
        encodedWrite(overStructuralCreate, zeros(1_089))
    )
);
switch (
    Frames.decodeWriteBlock(
        encodedWrite(exactStructuralReplace, zeros(1_089))
    )
) {
    case (?_) {};
    case null assert false;
};
assertNone(
    Frames.decodeWriteBlock(
        encodedWrite(overStructuralReplace, zeros(1_089))
    )
);

// Batch is the sole wider first-frame class. Reusing the otherwise-identical
// +1 control proves it is not accidentally held to the single-write ceiling.
assert (Types.MAX_BATCH_WRITE_CONTROL_BYTES == 196_608);
let batchAboveSingleLimit = structuralControl(?#batch, true);
assert (
    (to_candid (batchAboveSingleLimit)).size() ==
    Types.MAX_SINGLE_WRITE_CONTROL_BYTES + 1
);
assert (
    (to_candid (batchAboveSingleLimit)).size() <=
    Types.MAX_BATCH_WRITE_CONTROL_BYTES
);
switch (
    Frames.decodeWriteBlock(
        encodedWrite(batchAboveSingleLimit, zeros(1_089))
    )
) {
    case (?_) {};
    case null assert false;
};

// A depth-63 replacement has one explicit target and 63 ancestor witnesses.
// Its retirement descriptor duplicates the target's old content identity and
// therefore does not consume a structural-plan entry.
let depth63Replacement = boundedPlanControl(?#replace, 63, 0);
assert (
    (to_candid (depth63Replacement)).size() <=
    Types.MAX_SINGLE_WRITE_CONTROL_BYTES
);
switch (
    Frames.decodeWriteBlock(
        encodedWrite(depth63Replacement, zeros(81))
    )
) {
    case (?_) {};
    case null assert false;
};

// The same 64 structural entries are the exact batch limit even with a
// retirement descriptor. One additional child-index transition is rejected.
let exactBatchStructure = boundedPlanControl(?#batch, 63, 0);
switch (
    Frames.decodeWriteBlock(
        encodedWrite(exactBatchStructure, zeros(81))
    )
) {
    case (?_) {};
    case null assert false;
};
let plusOneBatchStructure = boundedPlanControl(?#batch, 63, 1);
assert (
    (to_candid (plusOneBatchStructure)).size() <=
    Types.MAX_BATCH_WRITE_CONTROL_BYTES
);
assertNone(
    Frames.decodeWriteBlock(
        encodedWrite(plusOneBatchStructure, zeros(81))
    )
);
