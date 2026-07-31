export const FILES_V2_METHODS = {
  bootstrap: "files_bootstrap_v2",
  list: "files_list_v2",
  lookup: "files_lookup_v2",
  readChunk: "files_read_chunk_v2",
  operationStatus: "files_operation_status_v2",
  vaultWrite: "files_vault_write_v2",
  writeBlock: "files_write_block_v2",
  mutate: "files_mutate_v2",
  remove: "files_remove_v2",
  abort: "files_abort_v2",
  cleanup: "files_cleanup_v2",
} as const;

export type FilesV2Method =
  (typeof FILES_V2_METHODS)[keyof typeof FILES_V2_METHODS];

export type FilesV2MethodMode = "query" | "update";

export type FilesV2MethodContract = Readonly<{
  mode: FilesV2MethodMode;
  inputBlobMaxBytes: number;
  outputBlobMaxBytes: number;
}>;

export const FILES_V2_METHOD_CONTRACTS: Readonly<
  Record<FilesV2Method, FilesV2MethodContract>
> = Object.freeze({
  [FILES_V2_METHODS.bootstrap]: {
    mode: "query",
    inputBlobMaxBytes: 0,
    outputBlobMaxBytes: 65_536,
  },
  [FILES_V2_METHODS.list]: {
    mode: "query",
    inputBlobMaxBytes: 0,
    outputBlobMaxBytes: 524_288,
  },
  [FILES_V2_METHODS.lookup]: {
    mode: "query",
    inputBlobMaxBytes: 32,
    outputBlobMaxBytes: 8_192,
  },
  [FILES_V2_METHODS.readChunk]: {
    mode: "query",
    inputBlobMaxBytes: 0,
    outputBlobMaxBytes: 1_900_000,
  },
  [FILES_V2_METHODS.operationStatus]: {
    mode: "query",
    inputBlobMaxBytes: 0,
    outputBlobMaxBytes: 0,
  },
  [FILES_V2_METHODS.vaultWrite]: {
    mode: "update",
    inputBlobMaxBytes: 65_536,
    outputBlobMaxBytes: 0,
  },
  [FILES_V2_METHODS.writeBlock]: {
    mode: "update",
    inputBlobMaxBytes: 1_900_000,
    outputBlobMaxBytes: 0,
  },
  [FILES_V2_METHODS.mutate]: {
    mode: "update",
    inputBlobMaxBytes: 262_144,
    outputBlobMaxBytes: 0,
  },
  [FILES_V2_METHODS.remove]: {
    mode: "update",
    inputBlobMaxBytes: 0,
    outputBlobMaxBytes: 0,
  },
  [FILES_V2_METHODS.abort]: {
    mode: "update",
    inputBlobMaxBytes: 0,
    outputBlobMaxBytes: 0,
  },
  [FILES_V2_METHODS.cleanup]: {
    mode: "update",
    inputBlobMaxBytes: 0,
    outputBlobMaxBytes: 0,
  },
});

export const FILES_V2_LIMITS = Object.freeze({
  normalizedValueBytes: 65_536,
  rawNonAttachmentCandidBytes: 131_072,
  decoderAllocationBytes: 524_288,
  candidTypeEntries: 256,
  candidDepth: 32,
  candidDecodedElements: 4_096,
  committedNodesPerReceipt: 64,
  operationWriteTargetNodes: 64,
  frameBytes: 1_900_000,
  normalPlaintextBlockBytes: 1_889_984,
  textFileBytes: 524_288,
  binaryFileBytes: 67_108_864,
  privateLogicalBytes: 67_108_864,
  pathScalars: 240,
  sharedRelativePathScalars: 233,
  workspaceRelativePathScalars: 230,
  nameScalars: 100,
  nameUtf8Bytes: 400,
  treeDepth: 64,
  nodes: 10_000,
  directChildPageDefault: 100,
  directChildPageMaximum: 200,
  metadataLruEntries: 2_000,
  metadataLruBytes: 4 * 1024 * 1024,
} as const);

export const FILES_V2_ATTACHMENT_MEDIA_TYPE = "application/octet-stream";
