import { IDL } from "@dfinity/candid";
import { FILES_V2_LIMITS } from "../protocol/constants.ts";
import type {
  CanonicalNat64,
  FilesId128V2,
  FilesListCursorV2,
} from "../protocol/types.ts";
import { parseCanonicalNat64, parseFilesId128 } from "../protocol/ids.ts";
import { equalBytes } from "../crypto/canonical.ts";
import type {
  FilesChildIndexTransition,
  FilesFolderAggregateTransition,
  FilesFrameContentSummary,
  FilesFrameDecoded,
  FilesFrameNodeSummary,
  FilesNodeTransition,
  FilesPayloadSlice,
  FilesQuotaTransition,
  FilesRetiredContent,
  FilesWriteIntent,
} from "./types.ts";
import {
  bytesToFilesDigest,
  bytesToFilesId128,
  filesDigestToBytes,
  filesId128ToBytes,
  sameFilesId,
} from "./ids.ts";

const MAX_CONTROL_BYTES = 262_144;
const WRITE_SINGLE_CONTROL_BYTES = 9_996;
const WRITE_BATCH_CONTROL_BYTES = 196_608;
const WRITE_BATCH_RAW_BYTES = 1_703_388;
const FRAME_PREFIX_BYTES = 4;

const Id128 = IDL.Record({ hi: IDL.Nat64, lo: IDL.Nat64 });
const Digest256 = IDL.Record({
  a: IDL.Nat64,
  b: IDL.Nat64,
  c: IDL.Nat64,
  d: IDL.Nat64,
});
const PayloadSlice = IDL.Record({
  offset: IDL.Nat32,
  length: IDL.Nat32,
});
const NodeKind = IDL.Variant({ file: IDL.Null, folder: IDL.Null });
const CryptoProfile = IDL.Variant({
  aes_256_gcm_files_v2: IDL.Null,
});
const ListCursor = IDL.Record({
  parent_id: Id128,
  children_revision: IDL.Nat64,
  last_name_tag: Digest256,
});
const NodeSummary = IDL.Record({
  node_id: Id128,
  subtree_plaintext_bytes: IDL.Nat64,
  metadata_revision: IDL.Nat64,
  kind: IDL.Opt(NodeKind),
  name_tag: Digest256,
  declared_name_scalars: IDL.Nat16,
  parent_id: Id128,
  max_relative_path_scalars: IDL.Nat16,
  subtree_height: IDL.Nat8,
  children_revision: IDL.Nat64,
  structural_revision: IDL.Nat64,
});
const ContentSummary = IDL.Record({
  content_id: Id128,
  crypto_profile: IDL.Opt(CryptoProfile),
  block_count: IDL.Nat32,
  ciphertext_bytes: IDL.Nat64,
});
const VaultReadControl = IDL.Record({
  public_key_fingerprint: Digest256,
  slot_generation: IDL.Nat64,
  record_revision: IDL.Nat64,
  root_children_revision: IDL.Nat64,
  vault_id: Id128,
  root_structural_revision: IDL.Nat64,
  root_commitment: Digest256,
  root_metadata_revision: IDL.Nat64,
  vault_salt: Digest256,
  encrypted_root_metadata: PayloadSlice,
  raw_payload_bytes: IDL.Nat32,
  ibe_wrapped_root_key: PayloadSlice,
  format: IDL.Nat16,
});
const VaultRewrap = IDL.Record({
  public_key_fingerprint: Digest256,
  slot_generation: IDL.Nat64,
  vault_id: Id128,
  root_commitment: Digest256,
  vault_salt: Digest256,
  ibe_wrapped_root_key: PayloadSlice,
  format: IDL.Nat16,
});
const VaultInitialize = IDL.Record({
  public_key_fingerprint: Digest256,
  slot_generation: IDL.Nat64,
  root_children_revision: IDL.Nat64,
  vault_id: Id128,
  root_structural_revision: IDL.Nat64,
  root_commitment: Digest256,
  root_metadata_revision: IDL.Nat64,
  vault_salt: Digest256,
  encrypted_root_metadata: PayloadSlice,
  ibe_wrapped_root_key: PayloadSlice,
  format: IDL.Nat16,
});
const VaultWriteControl = IDL.Record({
  request_id: Id128,
  proposed_record_revision: IDL.Nat64,
  operation: IDL.Opt(
    IDL.Variant({
      rewrap: VaultRewrap,
      initialize: VaultInitialize,
    }),
  ),
  raw_payload_bytes: IDL.Nat32,
  expected_record_revision: IDL.Opt(IDL.Nat64),
});
const ListFrameItem = IDL.Record({
  content: IDL.Opt(ContentSummary),
  node: NodeSummary,
  encrypted_metadata: PayloadSlice,
});
const ListControl = IDL.Record({
  parent_id: Id128,
  next_cursor: IDL.Opt(ListCursor),
  items: IDL.Vec(ListFrameItem),
  raw_payload_bytes: IDL.Nat32,
  children_revision: IDL.Nat64,
  structural_revision: IDL.Nat64,
});
const LookupContent = IDL.Record({
  wrapped_content_key: PayloadSlice,
  summary: ContentSummary,
});
const LookupControl = IDL.Record({
  content: IDL.Opt(LookupContent),
  node: NodeSummary,
  encrypted_metadata: PayloadSlice,
  raw_payload_bytes: IDL.Nat32,
});
const ReadFirst = IDL.Record({
  content: ContentSummary,
  wrapped_content_key: PayloadSlice,
  node: NodeSummary,
  ciphertext_block: PayloadSlice,
  encrypted_metadata: PayloadSlice,
  index: IDL.Nat32,
  raw_payload_bytes: IDL.Nat32,
});
const ReadContinuation = IDL.Record({
  node_id: Id128,
  metadata_revision: IDL.Nat64,
  content_id: Id128,
  ciphertext_block_bytes: IDL.Nat32,
  ciphertext_block: PayloadSlice,
  block_count: IDL.Nat32,
  index: IDL.Nat32,
  ciphertext_total_bytes: IDL.Nat64,
  raw_payload_bytes: IDL.Nat32,
  structural_revision: IDL.Nat64,
});
const ReadControl = IDL.Record({
  frame: IDL.Opt(
    IDL.Variant({
      first: ReadFirst,
      continuation: ReadContinuation,
    }),
  ),
});
const NodeTransition = IDL.Record({
  requested_kind: IDL.Opt(NodeKind),
  node_id: Id128,
  proposed_name_tag: Digest256,
  declared_name_scalars: IDL.Nat16,
  expected_name_tag: IDL.Opt(Digest256),
  expected_max_relative_path_scalars: IDL.Opt(IDL.Nat16),
  expected_children_revision: IDL.Opt(IDL.Nat64),
  expected_subtree_height: IDL.Opt(IDL.Nat8),
  proposed_max_relative_path_scalars: IDL.Nat16,
  expected_structural_revision: IDL.Opt(IDL.Nat64),
  proposed_subtree_plaintext_bytes: IDL.Nat64,
  expected_parent_id: IDL.Opt(Id128),
  proposed_children_revision: IDL.Nat64,
  encrypted_metadata: PayloadSlice,
  expected_metadata_revision: IDL.Opt(IDL.Nat64),
  proposed_parent_id: Id128,
  proposed_subtree_height: IDL.Nat8,
  proposed_metadata_revision: IDL.Nat64,
  expected_subtree_plaintext_bytes: IDL.Opt(IDL.Nat64),
  proposed_structural_revision: IDL.Nat64,
});
const FolderTransition = IDL.Record({
  node_id: Id128,
  expected_children_revision: IDL.Nat64,
  expected_structural_revision: IDL.Nat64,
});
const ChildIndexTransition = IDL.Record({
  name_tag: Digest256,
  proposed_node_id: IDL.Opt(Id128),
  parent_id: Id128,
  expected_node_id: IDL.Opt(Id128),
});
const MutateControl = IDL.Record({
  request_id: Id128,
  action: IDL.Opt(
    IDL.Variant({
      rename: IDL.Null,
      move: IDL.Null,
      create_folder: IDL.Null,
    }),
  ),
  node: NodeTransition,
  child_index_transitions: IDL.Vec(ChildIndexTransition),
  raw_payload_bytes: IDL.Nat32,
  folder_transitions: IDL.Vec(FolderTransition),
});
const RetiredContent = IDL.Record({
  node_id: Id128,
  content_id: Id128,
  block_count: IDL.Nat32,
  ciphertext_bytes: IDL.Nat64,
});
const QuotaTransition = IDL.Record({
  gross_peak_physical_bytes: IDL.Nat64,
  expected_node_count: IDL.Nat64,
  proposed_node_count: IDL.Nat64,
  expected_committed_ciphertext_bytes: IDL.Nat64,
  expected_committed_plaintext_bytes: IDL.Nat64,
  proposed_committed_ciphertext_bytes: IDL.Nat64,
  proposed_committed_plaintext_bytes: IDL.Nat64,
});
const WriteContent = IDL.Record({
  wrapped_content_key: PayloadSlice,
  content_id: Id128,
  crypto_profile: IDL.Opt(CryptoProfile),
  plaintext_block_lengths: IDL.Vec(IDL.Nat32),
  ciphertext_block_lengths: IDL.Vec(IDL.Nat32),
  ciphertext_bytes: IDL.Nat64,
});
const WriteNode = IDL.Record({
  content: IDL.Opt(WriteContent),
  node: NodeTransition,
});
const WriteBlockSlice = IDL.Record({
  block_index: IDL.Nat32,
  content_id: Id128,
  ciphertext_bytes: IDL.Nat32,
  payload: PayloadSlice,
});
const WriteFramePlan = IDL.Record({
  blocks: IDL.Vec(WriteBlockSlice),
  frame_ordinal: IDL.Nat8,
  raw_payload_bytes: IDL.Nat32,
});
const WriteFirst = IDL.Record({
  retired_contents: IDL.Vec(RetiredContent),
  final: IDL.Bool,
  request_id: Id128,
  child_index_transitions: IDL.Vec(ChildIndexTransition),
  quota: QuotaTransition,
  intent: IDL.Opt(
    IDL.Variant({
      create: IDL.Null,
      replace: IDL.Null,
      batch: IDL.Null,
    }),
  ),
  nodes: IDL.Vec(WriteNode),
  frames: IDL.Vec(WriteFramePlan),
  frame_ordinal: IDL.Nat8,
  raw_payload_bytes: IDL.Nat32,
  folder_transitions: IDL.Vec(FolderTransition),
  frame_count: IDL.Nat8,
});
const WriteContinuation = IDL.Record({
  final: IDL.Bool,
  request_id: Id128,
  blocks: IDL.Vec(WriteBlockSlice),
  frame_ordinal: IDL.Nat8,
  raw_payload_bytes: IDL.Nat32,
  stage_id: IDL.Nat64,
});
const WriteControl = IDL.Record({
  frame: IDL.Opt(
    IDL.Variant({
      first: WriteFirst,
      continuation: WriteContinuation,
    }),
  ),
});

export type FilesDecodedVaultFrame = Readonly<{
  format: number;
  vaultId: Uint8Array;
  vaultSalt: Uint8Array;
  slotGeneration: CanonicalNat64;
  publicKeyFingerprint: Uint8Array;
  rootCommitment: Uint8Array;
  recordRevision: CanonicalNat64;
  rootStructuralRevision: CanonicalNat64;
  rootMetadataRevision: CanonicalNat64;
  rootChildrenRevision: CanonicalNat64;
  wrapperCiphertext: Uint8Array;
  encryptedRootMetadata: Uint8Array;
}>;

export type FilesDecodedListFrame = Readonly<{
  parentId: FilesId128V2;
  structuralRevision: CanonicalNat64;
  childrenRevision: CanonicalNat64;
  items: readonly Readonly<{
    node: FilesFrameNodeSummary;
    content: FilesFrameContentSummary | null;
    encryptedMetadata: Uint8Array;
  }>[];
  nextCursor: FilesListCursorV2 | null;
}>;

export type FilesDecodedLookupFrame = Readonly<{
  node: FilesFrameNodeSummary;
  content: FilesFrameContentSummary | null;
  encryptedMetadata: Uint8Array;
  wrappedContentKey: Uint8Array | null;
}>;

export type FilesDecodedReadFrame =
  | Readonly<{
      kind: "first";
      node: FilesFrameNodeSummary;
      content: FilesFrameContentSummary;
      index: 0;
      encryptedMetadata: Uint8Array;
      wrappedContentKey: Uint8Array;
      ciphertextBlock: Uint8Array;
    }>
  | Readonly<{
      kind: "continuation";
      nodeId: FilesId128V2;
      structuralRevision: CanonicalNat64;
      metadataRevision: CanonicalNat64;
      contentId: FilesId128V2;
      index: number;
      blockCount: number;
      ciphertextBlockBytes: number;
      ciphertextTotalBytes: CanonicalNat64;
      ciphertextBlock: Uint8Array;
    }>;

export type FilesVaultWriteFrameInput =
  | Readonly<{
      requestId: FilesId128V2;
      expectedRecordRevision: null;
      proposedRecordRevision: CanonicalNat64;
      operation: "initialize";
      format: number;
      vaultId: Uint8Array;
      vaultSalt: Uint8Array;
      slotGeneration: CanonicalNat64;
      publicKeyFingerprint: Uint8Array;
      rootCommitment: Uint8Array;
      rootStructuralRevision: CanonicalNat64;
      rootMetadataRevision: CanonicalNat64;
      rootChildrenRevision: CanonicalNat64;
      wrapperCiphertext: Uint8Array;
      encryptedRootMetadata: Uint8Array;
    }>
  | Readonly<{
      requestId: FilesId128V2;
      expectedRecordRevision: CanonicalNat64;
      proposedRecordRevision: CanonicalNat64;
      operation: "rewrap";
      format: number;
      vaultId: Uint8Array;
      vaultSalt: Uint8Array;
      slotGeneration: CanonicalNat64;
      publicKeyFingerprint: Uint8Array;
      rootCommitment: Uint8Array;
      wrapperCiphertext: Uint8Array;
    }>;

export type FilesMutateFrameInput = Readonly<{
  requestId: FilesId128V2;
  action: "create_folder" | "rename" | "move";
  node: FilesNodeTransition;
  encryptedMetadata: Uint8Array;
  folderTransitions: readonly FilesFolderAggregateTransition[];
  childIndexTransitions: readonly FilesChildIndexTransition[];
}>;

export type FilesPreparedWriteNode = Readonly<{
  transition: FilesNodeTransition;
  encryptedMetadata: Uint8Array;
  content: Readonly<{
    contentId: FilesId128V2;
    wrappedContentKey: Uint8Array;
    plaintextBlockLengths: readonly number[];
    ciphertextBlockLengths: readonly number[];
  }> | null;
}>;

export type FilesWriteBlockCoordinate = Readonly<{
  contentId: FilesId128V2;
  blockIndex: number;
  ciphertextBytes: number;
}>;

export type FilesWriteFrameLayout = Readonly<{
  frameOrdinal: number;
  rawPayloadBytes: number;
  blocks: readonly Readonly<
    FilesWriteBlockCoordinate & { payload: FilesPayloadSlice }
  >[];
}>;

export type FilesPrivateWriteLayout = Readonly<{
  intent: FilesWriteIntent;
  nodes: readonly FilesPreparedWriteNode[];
  frames: readonly FilesWriteFrameLayout[];
  firstMetadataSlices: readonly Readonly<{
    encryptedMetadata: FilesPayloadSlice;
    wrappedContentKey: FilesPayloadSlice | null;
  }>[];
}>;

export type FilesWriteFirstFrameInput = Readonly<{
  requestId: FilesId128V2;
  layout: FilesPrivateWriteLayout;
  folderTransitions: readonly FilesFolderAggregateTransition[];
  childIndexTransitions: readonly FilesChildIndexTransition[];
  retiredContents: readonly FilesRetiredContent[];
  quota: FilesQuotaTransition;
  ciphertextBlocks: ReadonlyMap<string, Uint8Array>;
}>;

export type FilesWriteContinuationFrameInput = Readonly<{
  requestId: FilesId128V2;
  stageId: CanonicalNat64;
  layout: FilesPrivateWriteLayout;
  frameOrdinal: number;
  ciphertextBlocks: ReadonlyMap<string, Uint8Array>;
}>;

export function encodeFilesVaultWriteFrame(
  input: FilesVaultWriteFrameInput,
): Uint8Array {
  const wrapper = exactBytes(input.wrapperCiphertext, "Files vault wrapper");
  const rootMetadata =
    input.operation === "initialize"
      ? exactBytes(input.encryptedRootMetadata, "Files root metadata")
      : new Uint8Array();
  const raw = concat(wrapper, rootMetadata);
  const common = {
    format: input.format,
    vault_id: wireId(bytesToFilesId128(exactLength(input.vaultId, 16, "Files vault id"))),
    vault_salt: wireDigest(exactLength(input.vaultSalt, 32, "Files vault salt")),
    slot_generation: wireNat(input.slotGeneration),
    public_key_fingerprint: wireDigest(
      exactLength(input.publicKeyFingerprint, 32, "Files public-key fingerprint"),
    ),
    root_commitment: wireDigest(
      exactLength(input.rootCommitment, 32, "Files root commitment"),
    ),
    ibe_wrapped_root_key: { offset: 0, length: wrapper.byteLength },
  };
  const operation =
    input.operation === "initialize"
      ? {
          initialize: {
            ...common,
            root_structural_revision: wireNat(input.rootStructuralRevision),
            root_metadata_revision: wireNat(input.rootMetadataRevision),
            root_children_revision: wireNat(input.rootChildrenRevision),
            encrypted_root_metadata: {
              offset: wrapper.byteLength,
              length: rootMetadata.byteLength,
            },
          },
        }
      : { rewrap: common };
  const control = {
    request_id: wireId(input.requestId),
    expected_record_revision: optNat(input.expectedRecordRevision),
    proposed_record_revision: wireNat(input.proposedRecordRevision),
    operation: [operation],
    raw_payload_bytes: raw.byteLength,
  };
  return encodeFrame(
    VaultWriteControl,
    control,
    raw,
    65_536,
    MAX_CONTROL_BYTES,
  );
}

export function decodeFilesVaultReadFrame(
  frame: ArrayBuffer | Uint8Array,
): FilesFrameDecoded<FilesDecodedVaultFrame> {
  const decoded = decodeFrame(VaultReadControl, frame, 65_536);
  const value = record(decoded.control, "Files vault frame");
  const wrapper = slice(value.ibe_wrapped_root_key, "Files vault wrapper");
  const metadata = slice(
    value.encrypted_root_metadata,
    "Files root metadata",
  );
  validatePartition(
    [wrapper, metadata],
    nat32(value.raw_payload_bytes, "Files vault raw payload"),
    decoded.rawPayload.byteLength,
  );
  return {
    ...decoded,
    control: Object.freeze({
      format: nat16(value.format, "Files vault format"),
      vaultId: filesId128ToBytes(normalizeId(value.vault_id)),
      vaultSalt: normalizeDigestBytes(value.vault_salt),
      slotGeneration: nat64(value.slot_generation, "Files slot generation"),
      publicKeyFingerprint: normalizeDigestBytes(
        value.public_key_fingerprint,
      ),
      rootCommitment: normalizeDigestBytes(value.root_commitment),
      recordRevision: nat64(value.record_revision, "Files vault revision"),
      rootStructuralRevision: nat64(
        value.root_structural_revision,
        "Files root structural revision",
      ),
      rootMetadataRevision: nat64(
        value.root_metadata_revision,
        "Files root metadata revision",
      ),
      rootChildrenRevision: nat64(
        value.root_children_revision,
        "Files root children revision",
      ),
      wrapperCiphertext: copySlice(decoded.rawPayload, wrapper),
      encryptedRootMetadata: copySlice(decoded.rawPayload, metadata),
    }),
  };
}

export function decodeFilesListFrame(
  frame: ArrayBuffer | Uint8Array,
): FilesFrameDecoded<FilesDecodedListFrame> {
  const decoded = decodeFrame(ListControl, frame, 524_288);
  const value = record(decoded.control, "Files list frame");
  const rawBytes = nat32(value.raw_payload_bytes, "Files list raw payload");
  const items = array(value.items, 200, "Files list items");
  const slices = items.map((item, index) =>
    slice(record(item, `Files list item ${index}`).encrypted_metadata, "Files metadata")
  );
  validatePartition(slices, rawBytes, decoded.rawPayload.byteLength);
  const normalized = items.map((item, index) => {
    const row = record(item, `Files list item ${index}`);
    const content = optionalRecord(row.content, "Files list content");
    return Object.freeze({
      node: normalizeNodeSummary(row.node),
      content:
        content === null
          ? null
          : normalizeContentSummary(content),
      encryptedMetadata: copySlice(decoded.rawPayload, slices[index]!),
    });
  });
  return {
    ...decoded,
    control: Object.freeze({
      parentId: normalizeId(value.parent_id),
      structuralRevision: nat64(
        value.structural_revision,
        "Files list structural revision",
      ),
      childrenRevision: nat64(
        value.children_revision,
        "Files list children revision",
      ),
      items: Object.freeze(normalized),
      nextCursor: normalizeCursor(value.next_cursor),
    }),
  };
}

export function decodeFilesLookupFrame(
  frame: ArrayBuffer | Uint8Array,
): FilesFrameDecoded<FilesDecodedLookupFrame> {
  const decoded = decodeFrame(LookupControl, frame, 8_192);
  const value = record(decoded.control, "Files lookup frame");
  const metadata = slice(value.encrypted_metadata, "Files metadata");
  const content = optionalRecord(value.content, "Files lookup content");
  const wrapped =
    content === null
      ? null
      : slice(content.wrapped_content_key, "Files wrapped content key");
  validatePartition(
    wrapped === null ? [metadata] : [metadata, wrapped],
    nat32(value.raw_payload_bytes, "Files lookup raw payload"),
    decoded.rawPayload.byteLength,
  );
  return {
    ...decoded,
    control: Object.freeze({
      node: normalizeNodeSummary(value.node),
      content:
        content === null
          ? null
          : normalizeContentSummary(content.summary),
      encryptedMetadata: copySlice(decoded.rawPayload, metadata),
      wrappedContentKey:
        wrapped === null ? null : copySlice(decoded.rawPayload, wrapped),
    }),
  };
}

export function decodeFilesReadFrame(
  frame: ArrayBuffer | Uint8Array,
): FilesFrameDecoded<FilesDecodedReadFrame> {
  const decoded = decodeFrame(ReadControl, frame, FILES_V2_LIMITS.frameBytes);
  const control = record(decoded.control, "Files read control");
  const frameValue = optionalVariant(
    control.frame,
    ["first", "continuation"],
    "Files read frame",
  );
  if (frameValue === null) {
    throw new Error("Files read frame variant is unsupported");
  }
  const value = record(frameValue.value, "Files read frame value");
  if (frameValue.tag === "first") {
    const metadata = slice(value.encrypted_metadata, "Files metadata");
    const wrapped = slice(value.wrapped_content_key, "Files wrapped key");
    const block = slice(value.ciphertext_block, "Files ciphertext block");
    validatePartition(
      [metadata, wrapped, block],
      nat32(value.raw_payload_bytes, "Files read raw payload"),
      decoded.rawPayload.byteLength,
    );
    if (nat32(value.index, "Files read index") !== 0) {
      throw new Error("Files first read frame has a nonzero index");
    }
    return {
      ...decoded,
      control: Object.freeze({
        kind: "first",
        node: normalizeNodeSummary(value.node),
        content: normalizeContentSummary(value.content),
        index: 0,
        encryptedMetadata: copySlice(decoded.rawPayload, metadata),
        wrappedContentKey: copySlice(decoded.rawPayload, wrapped),
        ciphertextBlock: copySlice(decoded.rawPayload, block),
      }),
    };
  }
  const block = slice(value.ciphertext_block, "Files ciphertext block");
  validatePartition(
    [block],
    nat32(value.raw_payload_bytes, "Files read raw payload"),
    decoded.rawPayload.byteLength,
  );
  const ciphertextBlockBytes = nat32(
    value.ciphertext_block_bytes,
    "Files ciphertext block bytes",
  );
  if (ciphertextBlockBytes !== block.length) {
    throw new Error("Files continuation block length does not match");
  }
  return {
    ...decoded,
    control: Object.freeze({
      kind: "continuation",
      nodeId: normalizeId(value.node_id),
      structuralRevision: nat64(
        value.structural_revision,
        "Files structural revision",
      ),
      metadataRevision: nat64(
        value.metadata_revision,
        "Files metadata revision",
      ),
      contentId: normalizeId(value.content_id),
      index: nat32(value.index, "Files block index"),
      blockCount: nat32(value.block_count, "Files block count"),
      ciphertextBlockBytes,
      ciphertextTotalBytes: nat64(
        value.ciphertext_total_bytes,
        "Files ciphertext total",
      ),
      ciphertextBlock: copySlice(decoded.rawPayload, block),
    }),
  };
}

export function encodeFilesMutateFrame(
  input: FilesMutateFrameInput,
): Uint8Array {
  const metadata = exactBytes(
    input.encryptedMetadata,
    "Files encrypted metadata",
  );
  const control = {
    request_id: wireId(input.requestId),
    action: [{ [input.action]: null }],
    node: wireNodeTransition(input.node, {
      offset: 0,
      length: metadata.byteLength,
    }),
    folder_transitions: input.folderTransitions.map(wireFolderTransition),
    child_index_transitions:
      input.childIndexTransitions.map(wireChildIndexTransition),
    raw_payload_bytes: metadata.byteLength,
  };
  return encodeFrame(
    MutateControl,
    control,
    metadata,
    262_144,
    MAX_CONTROL_BYTES,
  );
}

export function planFilesPrivateWrite(
  intent: FilesWriteIntent,
  nodes: readonly FilesPreparedWriteNode[],
): FilesPrivateWriteLayout {
  if (nodes.length < 1 || nodes.length > 64) {
    throw new Error("Files write node count is invalid");
  }
  const firstMetadataSlices: Array<{
    encryptedMetadata: FilesPayloadSlice;
    wrappedContentKey: FilesPayloadSlice | null;
  }> = [];
  let firstOffset = 0;
  for (const node of nodes) {
    if (
      node.encryptedMetadata.byteLength < 16 ||
      node.encryptedMetadata.byteLength > 2_048 ||
      (node.content !== null &&
        node.content.wrappedContentKey.byteLength !== 48)
    ) {
      throw new Error("Files write envelope is invalid");
    }
    const encryptedMetadata = {
      offset: firstOffset,
      length: node.encryptedMetadata.byteLength,
    };
    firstOffset += encryptedMetadata.length;
    const wrappedContentKey =
      node.content === null
        ? null
        : {
            offset: firstOffset,
            length: node.content.wrappedContentKey.byteLength,
          };
    firstOffset += wrappedContentKey?.length ?? 0;
    firstMetadataSlices.push({ encryptedMetadata, wrappedContentKey });
  }
  const blocks: FilesWriteBlockCoordinate[] = [];
  for (const node of nodes) {
    if (node.content === null) continue;
    const plain = node.content.plaintextBlockLengths;
    const cipher = node.content.ciphertextBlockLengths;
    if (
      plain.length < 1 ||
      plain.length > 36 ||
      cipher.length !== plain.length
    ) {
      throw new Error("Files write block geometry is invalid");
    }
    for (let index = 0; index < plain.length; index += 1) {
      const plainBytes = plain[index]!;
      const cipherBytes = cipher[index]!;
      if (
        !Number.isSafeInteger(plainBytes) ||
        plainBytes < 0 ||
        plainBytes > FILES_V2_LIMITS.normalPlaintextBlockBytes ||
        cipherBytes !== plainBytes + 16
      ) {
        throw new Error("Files write block geometry is invalid");
      }
      blocks.push({
        contentId: node.content.contentId,
        blockIndex: index,
        ciphertextBytes: cipherBytes,
      });
    }
  }
  if (intent === "batch" && blocks.length > 20) {
    throw new Error("Files batch block count exceeds its bound");
  }
  const contentTargets = nodes.reduce(
    (count, node) => count + (node.content === null ? 0 : 1),
    0,
  );
  if (intent !== "batch" && contentTargets !== 1) {
    throw new Error("Files single write must contain exactly one file");
  }
  const frameBlocks: FilesWriteBlockCoordinate[][] = [];
  if (intent === "batch") {
    let current: FilesWriteBlockCoordinate[] = [];
    let rawBytes = firstOffset;
    for (const block of blocks) {
      if (
        current.length > 0 &&
        rawBytes + block.ciphertextBytes > WRITE_BATCH_RAW_BYTES
      ) {
        frameBlocks.push(current);
        current = [];
        rawBytes = 0;
      }
      if (rawBytes + block.ciphertextBytes > WRITE_BATCH_RAW_BYTES) {
        throw new Error("Files batch block cannot fit one frame");
      }
      current.push(block);
      rawBytes += block.ciphertextBytes;
    }
    if (current.length > 0) frameBlocks.push(current);
    if (frameBlocks.length > 7) {
      throw new Error("Files batch requires too many transport frames");
    }
  } else {
    for (const block of blocks) frameBlocks.push([block]);
  }
  if (
    frameBlocks.length < 1 ||
    frameBlocks.length > (intent === "batch" ? 7 : 36)
  ) {
    throw new Error("Files write frame count is invalid");
  }
  const frames: FilesWriteFrameLayout[] = frameBlocks.map(
    (frame, frameOrdinal) => {
      let offset = frameOrdinal === 0 ? firstOffset : 0;
      const mapped = frame.map((block) => {
        const payload = { offset, length: block.ciphertextBytes };
        offset += block.ciphertextBytes;
        return Object.freeze({ ...block, payload });
      });
      return Object.freeze({
        frameOrdinal,
        rawPayloadBytes: offset,
        blocks: Object.freeze(mapped),
      });
    },
  );
  return Object.freeze({
    intent,
    nodes: Object.freeze([...nodes]),
    frames: Object.freeze(frames),
    firstMetadataSlices: Object.freeze(
      firstMetadataSlices.map((value) => Object.freeze(value)),
    ),
  });
}

export function encodeFilesWriteFirstFrame(
  input: FilesWriteFirstFrameInput,
): Uint8Array {
  const layout = input.layout;
  const first = layout.frames[0];
  if (!first) throw new Error("Files write has no first frame");
  const raw = new Uint8Array(first.rawPayloadBytes);
  for (let index = 0; index < layout.nodes.length; index += 1) {
    const node = layout.nodes[index]!;
    const slices = layout.firstMetadataSlices[index]!;
    raw.set(node.encryptedMetadata, slices.encryptedMetadata.offset);
    if (node.content !== null && slices.wrappedContentKey !== null) {
      raw.set(
        node.content.wrappedContentKey,
        slices.wrappedContentKey.offset,
      );
    }
  }
  setCiphertextBlocks(raw, first, input.ciphertextBlocks);
  const wireFrames = layout.frames.map((frame) => wireFrameLayout(frame));
  const nodes = layout.nodes.map((node, index) => ({
    node: wireNodeTransition(
      node.transition,
      layout.firstMetadataSlices[index]!.encryptedMetadata,
    ),
    content:
      node.content === null
        ? []
        : [{
            content_id: wireId(node.content.contentId),
            wrapped_content_key:
              layout.firstMetadataSlices[index]!.wrappedContentKey,
            plaintext_block_lengths:
              [...node.content.plaintextBlockLengths],
            ciphertext_block_lengths:
              [...node.content.ciphertextBlockLengths],
            ciphertext_bytes: wireNat(
              sum(node.content.ciphertextBlockLengths).toString(),
            ),
            crypto_profile: [{ aes_256_gcm_files_v2: null }],
          }],
  }));
  const control = {
    frame: [{
      first: {
        request_id: wireId(input.requestId),
        intent: [{ [layout.intent]: null }],
        frame_ordinal: 0,
        frame_count: layout.frames.length,
        final: layout.frames.length === 1,
        nodes,
        folder_transitions:
          input.folderTransitions.map(wireFolderTransition),
        child_index_transitions:
          input.childIndexTransitions.map(wireChildIndexTransition),
        retired_contents: input.retiredContents.map(wireRetiredContent),
        quota: wireQuota(input.quota),
        frames: wireFrames,
        raw_payload_bytes: raw.byteLength,
      },
    }],
  };
  return encodeFrame(
    WriteControl,
    control,
    raw,
    FILES_V2_LIMITS.frameBytes,
    layout.intent === "batch"
      ? WRITE_BATCH_CONTROL_BYTES
      : WRITE_SINGLE_CONTROL_BYTES,
  );
}

export function encodeFilesWriteContinuationFrame(
  input: FilesWriteContinuationFrameInput,
): Uint8Array {
  const frame = input.layout.frames[input.frameOrdinal];
  if (!frame || frame.frameOrdinal < 1) {
    throw new Error("Files continuation frame ordinal is invalid");
  }
  const raw = new Uint8Array(frame.rawPayloadBytes);
  setCiphertextBlocks(raw, frame, input.ciphertextBlocks);
  return encodeFrame(
    WriteControl,
    {
      frame: [{
        continuation: {
          request_id: wireId(input.requestId),
          stage_id: wireNat(input.stageId),
          frame_ordinal: frame.frameOrdinal,
          final: frame.frameOrdinal === input.layout.frames.length - 1,
          blocks: frame.blocks.map(wireBlockSlice),
          raw_payload_bytes: raw.byteLength,
        },
      }],
    },
    raw,
    FILES_V2_LIMITS.frameBytes,
    WRITE_SINGLE_CONTROL_BYTES,
  );
}

export function filesWriteBlockKey(
  contentId: FilesId128V2,
  blockIndex: number,
): string {
  const id = filesId128ToBytes(contentId);
  let hex = "";
  for (const byte of id) hex += byte.toString(16).padStart(2, "0");
  return `${hex}:${blockIndex}`;
}

function decodeFrame(
  type: IDL.Type,
  frameInput: ArrayBuffer | Uint8Array,
  maximumFrameBytes: number,
): FilesFrameDecoded<unknown> {
  const exactFrame =
    frameInput instanceof Uint8Array
      ? frameInput.slice()
      : frameInput instanceof ArrayBuffer
        ? new Uint8Array(frameInput.slice(0))
        : null;
  if (
    exactFrame === null ||
    exactFrame.byteLength < FRAME_PREFIX_BYTES + 1 ||
    exactFrame.byteLength > maximumFrameBytes
  ) {
    throw new Error("Files frame length is invalid");
  }
  const controlLength = new DataView(
    exactFrame.buffer,
    exactFrame.byteOffset,
    4,
  ).getUint32(0, false);
  if (
    controlLength < 1 ||
    controlLength > MAX_CONTROL_BYTES ||
    FRAME_PREFIX_BYTES + controlLength > exactFrame.byteLength
  ) {
    throw new Error("Files frame control length is invalid");
  }
  // @dfinity/candid's Pipe consumes the backing ArrayBuffer and does not
  // consistently honor a Uint8Array byteOffset. Give it an owned offset-zero
  // control buffer rather than the view that still includes our u32 prefix.
  const controlBytes = exactFrame.slice(4, 4 + controlLength);
  let control: unknown;
  try {
    const decoded = IDL.decode([type], controlBytes);
    if (decoded.length !== 1) throw new Error("wrong value count");
    control = decoded[0];
  } catch {
    throw new Error("Files frame Candid control is invalid");
  }
  return Object.freeze({
    control,
    rawPayload: exactFrame.subarray(4 + controlLength),
    exactFrame,
  });
}

function encodeFrame(
  type: IDL.Type,
  control: unknown,
  rawPayload: Uint8Array,
  maximumFrameBytes: number,
  maximumControlBytes: number,
): Uint8Array {
  let encoded: Uint8Array;
  try {
    encoded = new Uint8Array(IDL.encode([type], [control]));
  } catch {
    throw new Error("Files frame control cannot be encoded");
  }
  if (
    encoded.byteLength < 1 ||
    encoded.byteLength > maximumControlBytes
  ) {
    throw new Error("Files frame control exceeds its bound");
  }
  const frameBytes =
    FRAME_PREFIX_BYTES + encoded.byteLength + rawPayload.byteLength;
  if (frameBytes > maximumFrameBytes) {
    throw new Error("Files frame exceeds its attachment bound");
  }
  const output = new Uint8Array(frameBytes);
  new DataView(output.buffer).setUint32(0, encoded.byteLength, false);
  output.set(encoded, 4);
  output.set(rawPayload, 4 + encoded.byteLength);
  return output;
}

function normalizeNodeSummary(value: unknown): FilesFrameNodeSummary {
  const item = record(value, "Files node summary");
  const kind = optionalVariant(item.kind, ["folder", "file"], "Files node kind");
  if (kind === null) throw new Error("Files node kind is unsupported");
  const nodeId = normalizeId(item.node_id);
  const parentId = normalizeId(item.parent_id);
  const nameTag = normalizeDigestBytes(item.name_tag);
  const declaredNameScalars = nat16(
    item.declared_name_scalars,
    "Files declared name scalars",
  );
  const root = nodeId.hi === "0" && nodeId.lo === "0";
  if (
    (root &&
      (kind.tag !== "folder" ||
        parentId.hi !== "0" ||
        parentId.lo !== "0" ||
        declaredNameScalars !== 0 ||
        nameTag.some((byte) => byte !== 0))) ||
    (!root && declaredNameScalars < 1)
  ) {
    throw new Error("Files node summary violates the root/name contract");
  }
  return Object.freeze({
    nodeId,
    parentId,
    kind: kind.tag,
    nameTag,
    declaredNameScalars,
    structuralRevision: positiveNat64(
      item.structural_revision,
      "Files structural revision",
    ),
    metadataRevision: positiveNat64(
      item.metadata_revision,
      "Files metadata revision",
    ),
    childrenRevision: nat64(
      item.children_revision,
      "Files children revision",
    ),
    subtreeHeight: boundedNumber(
      item.subtree_height,
      0,
      FILES_V2_LIMITS.treeDepth,
      "Files subtree height",
    ),
    maxRelativePathScalars: boundedNumber(
      item.max_relative_path_scalars,
      0,
      FILES_V2_LIMITS.pathScalars,
      "Files relative path scalars",
    ),
    subtreePlaintextBytes: nat64(
      item.subtree_plaintext_bytes,
      "Files subtree plaintext bytes",
    ),
  });
}

function normalizeContentSummary(
  value: unknown,
): FilesFrameContentSummary {
  const item = record(value, "Files content summary");
  const profile = optionalVariant(
    item.crypto_profile,
    ["aes_256_gcm_files_v2"],
    "Files content crypto profile",
  );
  if (profile === null) {
    throw new Error("Files content crypto profile is unsupported");
  }
  const blockCount = boundedNumber(
    item.block_count,
    1,
    36,
    "Files content block count",
  );
  const ciphertextBytes = nat64(
    item.ciphertext_bytes,
    "Files content ciphertext bytes",
  );
  const bytes = BigInt(ciphertextBytes);
  if (
    bytes < 16n * BigInt(blockCount) ||
    bytes > 67_109_440n
  ) {
    throw new Error("Files content ciphertext geometry is invalid");
  }
  return Object.freeze({
    contentId: normalizeId(item.content_id),
    blockCount,
    ciphertextBytes,
    cryptoProfile: "aes_256_gcm_files_v2",
  });
}

function normalizeCursor(value: unknown): FilesListCursorV2 | null {
  const item = optionalRecord(value, "Files list cursor");
  if (item === null) return null;
  return Object.freeze({
    parent_id: normalizeId(item.parent_id),
    children_revision: nat64(
      item.children_revision,
      "Files cursor revision",
    ),
    last_name_tag: bytesToFilesDigest(
      normalizeDigestBytes(item.last_name_tag),
    ),
  });
}

function wireNodeTransition(
  value: FilesNodeTransition,
  encryptedMetadata: FilesPayloadSlice,
): Record<string, unknown> {
  return {
    node_id: wireId(value.nodeId),
    expected_parent_id: optId(value.expectedParentId),
    proposed_parent_id: wireId(value.proposedParentId),
    requested_kind: [{ [value.requestedKind]: null }],
    expected_name_tag:
      value.expectedNameTag === null
        ? []
        : [wireDigest(value.expectedNameTag)],
    proposed_name_tag: wireDigest(value.proposedNameTag),
    declared_name_scalars: value.declaredNameScalars,
    expected_structural_revision: optNat(value.expectedStructuralRevision),
    proposed_structural_revision: wireNat(value.proposedStructuralRevision),
    expected_metadata_revision: optNat(value.expectedMetadataRevision),
    proposed_metadata_revision: wireNat(value.proposedMetadataRevision),
    expected_children_revision: optNat(value.expectedChildrenRevision),
    proposed_children_revision: wireNat(value.proposedChildrenRevision),
    expected_subtree_height:
      value.expectedSubtreeHeight === null
        ? []
        : [value.expectedSubtreeHeight],
    proposed_subtree_height: value.proposedSubtreeHeight,
    expected_max_relative_path_scalars:
      value.expectedMaxRelativePathScalars === null
        ? []
        : [value.expectedMaxRelativePathScalars],
    proposed_max_relative_path_scalars:
      value.proposedMaxRelativePathScalars,
    expected_subtree_plaintext_bytes:
      optNat(value.expectedSubtreePlaintextBytes),
    proposed_subtree_plaintext_bytes:
      wireNat(value.proposedSubtreePlaintextBytes),
    encrypted_metadata: encryptedMetadata,
  };
}

function wireFolderTransition(
  value: FilesFolderAggregateTransition,
): Record<string, unknown> {
  return {
    node_id: wireId(value.nodeId),
    expected_structural_revision:
      wireNat(value.expectedStructuralRevision),
    expected_children_revision: wireNat(value.expectedChildrenRevision),
  };
}

function wireChildIndexTransition(
  value: FilesChildIndexTransition,
): Record<string, unknown> {
  return {
    parent_id: wireId(value.parentId),
    name_tag: wireDigest(value.nameTag),
    expected_node_id: optId(value.expectedNodeId),
    proposed_node_id: optId(value.proposedNodeId),
  };
}

function wireRetiredContent(
  value: FilesRetiredContent,
): Record<string, unknown> {
  return {
    node_id: wireId(value.nodeId),
    content_id: wireId(value.contentId),
    block_count: value.blockCount,
    ciphertext_bytes: wireNat(value.ciphertextBytes),
  };
}

function wireQuota(
  value: FilesQuotaTransition,
): Record<string, unknown> {
  return {
    expected_node_count: wireNat(value.expectedNodeCount),
    proposed_node_count: wireNat(value.proposedNodeCount),
    expected_committed_plaintext_bytes:
      wireNat(value.expectedCommittedPlaintextBytes),
    proposed_committed_plaintext_bytes:
      wireNat(value.proposedCommittedPlaintextBytes),
    expected_committed_ciphertext_bytes:
      wireNat(value.expectedCommittedCiphertextBytes),
    proposed_committed_ciphertext_bytes:
      wireNat(value.proposedCommittedCiphertextBytes),
    gross_peak_physical_bytes: wireNat(value.grossPeakPhysicalBytes),
  };
}

function wireFrameLayout(
  value: FilesWriteFrameLayout,
): Record<string, unknown> {
  return {
    frame_ordinal: value.frameOrdinal,
    raw_payload_bytes: value.rawPayloadBytes,
    blocks: value.blocks.map(wireBlockSlice),
  };
}

function wireBlockSlice(
  value: FilesWriteBlockCoordinate & { payload: FilesPayloadSlice },
): Record<string, unknown> {
  return {
    content_id: wireId(value.contentId),
    block_index: value.blockIndex,
    ciphertext_bytes: value.ciphertextBytes,
    payload: value.payload,
  };
}

function setCiphertextBlocks(
  raw: Uint8Array,
  layout: FilesWriteFrameLayout,
  blocks: ReadonlyMap<string, Uint8Array>,
): void {
  if (blocks.size !== layout.blocks.length) {
    throw new Error("Files ciphertext block set is incomplete");
  }
  for (const block of layout.blocks) {
    const key = filesWriteBlockKey(block.contentId, block.blockIndex);
    const bytes = blocks.get(key);
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength !== block.ciphertextBytes
    ) {
      throw new Error("Files ciphertext block does not match its plan");
    }
    raw.set(bytes, block.payload.offset);
  }
}

function validatePartition(
  slices: readonly FilesPayloadSlice[],
  declaredBytes: number,
  actualBytes: number,
): void {
  if (declaredBytes !== actualBytes) {
    throw new Error("Files frame raw payload length does not match");
  }
  let offset = 0;
  for (const item of slices) {
    if (item.length < 1 || item.offset !== offset) {
      throw new Error("Files frame payload slices are not canonical");
    }
    offset += item.length;
    if (!Number.isSafeInteger(offset) || offset > actualBytes) {
      throw new Error("Files frame payload slice exceeds its body");
    }
  }
  if (offset !== actualBytes) {
    throw new Error("Files frame payload contains unaccounted bytes");
  }
}

function copySlice(
  raw: Uint8Array,
  value: FilesPayloadSlice,
): Uint8Array {
  return raw.slice(value.offset, value.offset + value.length);
}

function slice(value: unknown, label: string): FilesPayloadSlice {
  const item = record(value, label);
  const offset = nat32(item.offset, `${label} offset`);
  const length = nat32(item.length, `${label} length`);
  return Object.freeze({ offset, length });
}

function normalizeId(value: unknown): FilesId128V2 {
  const item = record(value, "Files id");
  return parseFilesId128({
    hi: nat64(item.hi, "Files id high word"),
    lo: nat64(item.lo, "Files id low word"),
  });
}

function wireId(value: FilesId128V2): Record<string, bigint> {
  const parsed = parseFilesId128(value);
  return { hi: BigInt(parsed.hi), lo: BigInt(parsed.lo) };
}

function optId(
  value: FilesId128V2 | null,
): [] | [Record<string, bigint>] {
  return value === null ? [] : [wireId(value)];
}

function wireDigest(value: Uint8Array): Record<string, bigint> {
  const digest = bytesToFilesDigest(exactLength(value, 32, "Files digest"));
  return {
    a: BigInt(digest.a),
    b: BigInt(digest.b),
    c: BigInt(digest.c),
    d: BigInt(digest.d),
  };
}

function normalizeDigestBytes(value: unknown): Uint8Array {
  const item = record(value, "Files digest");
  return filesDigestToBytes({
    a: nat64(item.a, "Files digest word a"),
    b: nat64(item.b, "Files digest word b"),
    c: nat64(item.c, "Files digest word c"),
    d: nat64(item.d, "Files digest word d"),
  });
}

function wireNat(value: string): bigint {
  return BigInt(parseCanonicalNat64(value, "Files Nat64"));
}

function optNat(value: string | null): [] | [bigint] {
  return value === null ? [] : [wireNat(value)];
}

function nat64(value: unknown, label: string): CanonicalNat64 {
  if (typeof value !== "bigint") throw new Error(`${label} is invalid`);
  return parseCanonicalNat64(value, label);
}

function positiveNat64(value: unknown, label: string): CanonicalNat64 {
  const parsed = nat64(value, label);
  if (parsed === "0") throw new Error(`${label} must be positive`);
  return parsed;
}

function nat32(value: unknown, label: string): number {
  return boundedNumber(value, 0, 0xffff_ffff, label);
}

function nat16(value: unknown, label: string): number {
  return boundedNumber(value, 0, 0xffff, label);
}

function boundedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${label} is outside its bound`);
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function optionalRecord(
  value: unknown,
  label: string,
): Record<string, unknown> | null {
  if (!Array.isArray(value) || value.length > 1) {
    throw new Error(`${label} optional value is invalid`);
  }
  return value.length === 0 ? null : record(value[0], label);
}

function optionalVariant<const Tag extends string>(
  value: unknown,
  tags: readonly Tag[],
  label: string,
): { tag: Tag; value: unknown } | null {
  const item = optionalRecord(value, label);
  if (item === null) return null;
  const keys = Object.keys(item);
  if (keys.length !== 1 || !tags.includes(keys[0] as Tag)) {
    throw new Error(`${label} variant is unsupported`);
  }
  return { tag: keys[0] as Tag, value: item[keys[0]!] };
}

function exactLength(
  value: Uint8Array,
  length: number,
  label: string,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new Error(`${label} must be ${length} bytes`);
  }
  return value;
}

function exactBytes(value: Uint8Array, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`${label} is invalid`);
  return value;
}

function concat(...values: readonly Uint8Array[]): Uint8Array {
  const length = sum(values.map((value) => value.byteLength));
  const output = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.byteLength;
  }
  return output;
}

function sum(values: readonly number[]): number {
  const result = values.reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(result)) throw new Error("Files byte total overflow");
  return result;
}

export function assertFilesReadBinding(
  outer: {
    nodeId: FilesId128V2;
    structuralRevision: CanonicalNat64;
    metadataRevision: CanonicalNat64;
    contentId: FilesId128V2;
    index: number;
    blockCount: number;
    ciphertextBlockBytes: number;
    ciphertextTotalBytes: CanonicalNat64;
    frameKind: "first" | "continuation";
  },
  inner: FilesDecodedReadFrame,
): void {
  const nodeId = inner.kind === "first" ? inner.node.nodeId : inner.nodeId;
  const structuralRevision =
    inner.kind === "first"
      ? inner.node.structuralRevision
      : inner.structuralRevision;
  const metadataRevision =
    inner.kind === "first"
      ? inner.node.metadataRevision
      : inner.metadataRevision;
  const contentId =
    inner.kind === "first" ? inner.content.contentId : inner.contentId;
  const blockCount =
    inner.kind === "first" ? inner.content.blockCount : inner.blockCount;
  const total =
    inner.kind === "first"
      ? inner.content.ciphertextBytes
      : inner.ciphertextTotalBytes;
  if (
    outer.frameKind !== inner.kind ||
    !sameFilesId(outer.nodeId, nodeId) ||
    outer.structuralRevision !== structuralRevision ||
    outer.metadataRevision !== metadataRevision ||
    !sameFilesId(outer.contentId, contentId) ||
    outer.index !== inner.index ||
    outer.blockCount !== blockCount ||
    outer.ciphertextBlockBytes !== inner.ciphertextBlock.byteLength ||
    outer.ciphertextTotalBytes !== total
  ) {
    throw new Error("Files read frame does not match its outer binding");
  }
}

export function sameExactFilesFrame(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  return equalBytes(left, right);
}
