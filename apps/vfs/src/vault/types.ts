import type {
  VetKeyDeriveChallenge,
  VetKeyDeriveResult,
  VetKeyPublicInfo,
  VetKeySlotSummary,
  VetKeysLifecycleRequest,
  VetKeysLifecycleResult,
} from "neutron-tools/app";
import type { FilesCryptoWorkerRequestWithoutId, FilesCryptoWorkerResult } from "../crypto/worker_protocol.ts";
import type {
  CanonicalNat64,
  FilesAbortOkV2,
  FilesAbortRequestV2,
  FilesAttachmentOutcomeV2,
  FilesBootstrapOkV2,
  FilesCleanupOkV2,
  FilesCleanupRequestV2,
  FilesCommittedNodeV2,
  FilesContentDescriptorV2,
  FilesDigest256V2,
  FilesId128V2,
  FilesListOkV2,
  FilesListRequestV2,
  FilesLookupOkV2,
  FilesLookupRequestV2,
  FilesMutateOkV2,
  FilesMutateRequestV2,
  FilesNodeBindingV2,
  FilesOperationStatusOkV2,
  FilesOperationStatusRequestV2,
  FilesOutcomeV2,
  FilesPublicUsageV2,
  FilesQuotaSnapshotV2,
  FilesReadChunkOutcomeV2,
  FilesReadChunkRequestV2,
  FilesRemoveOkV2,
  FilesRemoveRequestV2,
  FilesVaultWriteOkV2,
  FilesVaultWriteRequestV2,
  FilesWriteBlockOkV2,
  FilesWriteBlockRequestV2,
} from "../protocol/types.ts";

export const FILES_VAULT_FORMAT = 2;
export const FILES_ROOT_ID = Object.freeze({
  hi: "0" as CanonicalNat64,
  lo: "0" as CanonicalNat64,
});

export type FilesMetadataContentKind = "text_v1" | "binary_v1";

export type FilesFolderMetadata = Readonly<{
  nodeKind: "folder";
  name: string;
  createdAtNs: CanonicalNat64;
  modifiedAtNs: CanonicalNat64;
}>;

export type FilesFileMetadata = Readonly<{
  nodeKind: "file";
  name: string;
  contentKind: FilesMetadataContentKind;
  mimeType: string;
  plaintextBytes: number;
  plaintextSha256: Uint8Array;
  createdAtNs: CanonicalNat64;
  modifiedAtNs: CanonicalNat64;
}>;

export type FilesPrivateMetadata = FilesFolderMetadata | FilesFileMetadata;

export type FilesPayloadSlice = Readonly<{
  offset: number;
  length: number;
}>;

export type FilesFrameNodeSummary = Readonly<{
  nodeId: FilesId128V2;
  parentId: FilesId128V2;
  kind: "folder" | "file";
  nameTag: Uint8Array;
  declaredNameScalars: number;
  structuralRevision: CanonicalNat64;
  metadataRevision: CanonicalNat64;
  childrenRevision: CanonicalNat64;
  subtreeHeight: number;
  maxRelativePathScalars: number;
  subtreePlaintextBytes: CanonicalNat64;
}>;

export type FilesFrameContentSummary = Readonly<{
  contentId: FilesId128V2;
  blockCount: number;
  ciphertextBytes: CanonicalNat64;
  cryptoProfile: "aes_256_gcm_files_v2";
}>;

export type FilesNodeRecord = Readonly<{
  node: FilesFrameNodeSummary;
  content: FilesFrameContentSummary | null;
  metadata: FilesPrivateMetadata;
  wrappedContentKey: Uint8Array | null;
}>;

export type FilesListPage = Readonly<{
  parentId: FilesId128V2;
  structuralRevision: CanonicalNat64;
  childrenRevision: CanonicalNat64;
  items: readonly FilesNodeRecord[];
  totalChildren: number;
  hasMore: boolean;
  nextCursor: FilesListOkV2["next_cursor"];
}>;

export type FilesVaultRecord = Readonly<{
  format: number;
  recordRevision: CanonicalNat64;
  slotGeneration: CanonicalNat64;
  context: Readonly<{
    neutronCanisterPrincipalBytes: Uint8Array;
    vaultId: Uint8Array;
    vaultSalt: Uint8Array;
  }>;
  publicKeyFingerprint: Uint8Array;
  rootCommitment: Uint8Array;
  rootStructuralRevision: CanonicalNat64;
  rootMetadataRevision: CanonicalNat64;
  rootChildrenRevision: CanonicalNat64;
  wrapperCiphertext: Uint8Array;
  encryptedRootMetadata: Uint8Array;
}>;

export type FilesCapacityMeter = Readonly<{
  used: CanonicalNat64;
  limit: CanonicalNat64;
  remaining: CanonicalNat64;
  utilizationBasisPoints: number;
}>;

export type FilesPublicCapacityDimension =
  | "rolling_entries"
  | "committed_bytes"
  | "staged_bytes"
  | "pending_stages"
  | "rolling_general_receipts"
  | "revocation_lanes";

export type FilesCapacitySnapshot = Readonly<{
  privateQuota: Readonly<{
    nodes: CanonicalNat64;
    committedPlaintextBytes: CanonicalNat64;
    committedCiphertextBytes: CanonicalNat64;
    stagedCiphertextBytes: CanonicalNat64;
    physicalBytes: CanonicalNat64;
    cleanupJobs: number;
  }>;
  public: Readonly<{
    rollingEntries: FilesCapacityMeter;
    committedBytes: FilesCapacityMeter;
    stagedBytes: FilesCapacityMeter;
    pendingStages: FilesCapacityMeter;
    rollingGeneralReceipts: FilesCapacityMeter;
    revocationLanes: FilesCapacityMeter;
    maxObjectBytes: CanonicalNat64;
    maxBatchOperations: CanonicalNat64;
    maxBatchBytes: CanonicalNat64;
    limiting: Readonly<{
      dimension: FilesPublicCapacityDimension;
      utilizationBasisPoints: number;
    }>;
  }>;
}>;

export type FilesVaultStatus =
  | Readonly<{
      state: "uninitialized";
      capacity: FilesCapacitySnapshot | null;
    }>
  | Readonly<{
      state: "locked";
      capacity: FilesCapacitySnapshot;
      record: FilesVaultRecord;
      currentGeneration: CanonicalNat64;
      previousGeneration: CanonicalNat64 | null;
      migrationRequired: boolean;
    }>
  | Readonly<{
      state: "ready";
      capacity: FilesCapacitySnapshot;
      record: FilesVaultRecord;
      root: FilesNodeRecord;
      currentGeneration: CanonicalNat64;
      previousGeneration: CanonicalNat64 | null;
      rotationConfirmed: boolean;
    }>
  | Readonly<{
      state: "unrecoverable";
      capacity: FilesCapacitySnapshot | null;
      record: FilesVaultRecord | null;
      reason: string;
    }>;

export type FilesTransferPhase =
  | "queued"
  | "hashing"
  | "encrypting"
  | "uploading"
  | "downloading"
  | "decrypting"
  | "checking-outcome"
  | "committed"
  | "cancelled"
  | "conflicted"
  | "failed"
  | "cleanup-pending";

export type FilesTransferProgress = Readonly<{
  phase: FilesTransferPhase;
  plaintextBytes: number;
  processedBytes: number;
  blockIndex: number;
  blockCount: number;
}>;

export type FilesTransferSource = Readonly<{
  size: number;
  name?: string;
  type?: string;
  slice(
    start: number,
    end: number,
  ):
    | Blob
    | ArrayBuffer
    | Uint8Array
    | Promise<Blob | ArrayBuffer | Uint8Array>;
}>;

export type FilesTransferControls = Readonly<{
  signal?: AbortSignal;
  onProgress?: (progress: FilesTransferProgress) => void;
  /**
   * Return after the final streamed source chunk is accepted instead of
   * holding an inbound tool call open while the resident performs self-calls.
   */
  deferFinalCommit?: boolean;
}>;

export type FilesWriteIntent = "create" | "replace" | "batch";

export type FilesNodeTransition = Readonly<{
  nodeId: FilesId128V2;
  expectedParentId: FilesId128V2 | null;
  proposedParentId: FilesId128V2;
  requestedKind: "folder" | "file";
  expectedNameTag: Uint8Array | null;
  proposedNameTag: Uint8Array;
  declaredNameScalars: number;
  expectedStructuralRevision: CanonicalNat64 | null;
  proposedStructuralRevision: CanonicalNat64;
  expectedMetadataRevision: CanonicalNat64 | null;
  proposedMetadataRevision: CanonicalNat64;
  expectedChildrenRevision: CanonicalNat64 | null;
  proposedChildrenRevision: CanonicalNat64;
  expectedSubtreeHeight: number | null;
  proposedSubtreeHeight: number;
  expectedMaxRelativePathScalars: number | null;
  proposedMaxRelativePathScalars: number;
  expectedSubtreePlaintextBytes: CanonicalNat64 | null;
  proposedSubtreePlaintextBytes: CanonicalNat64;
}>;

export type FilesFolderAggregateTransition = Readonly<{
  nodeId: FilesId128V2;
  expectedStructuralRevision: CanonicalNat64;
  expectedChildrenRevision: CanonicalNat64;
}>;

export type FilesChildIndexTransition = Readonly<{
  parentId: FilesId128V2;
  nameTag: Uint8Array;
  expectedNodeId: FilesId128V2 | null;
  proposedNodeId: FilesId128V2 | null;
}>;

export type FilesQuotaTransition = Readonly<{
  expectedNodeCount: CanonicalNat64;
  proposedNodeCount: CanonicalNat64;
  expectedCommittedPlaintextBytes: CanonicalNat64;
  proposedCommittedPlaintextBytes: CanonicalNat64;
  expectedCommittedCiphertextBytes: CanonicalNat64;
  proposedCommittedCiphertextBytes: CanonicalNat64;
  grossPeakPhysicalBytes: CanonicalNat64;
}>;

export type FilesRetiredContent = Readonly<{
  nodeId: FilesId128V2;
  contentId: FilesId128V2;
  blockCount: number;
  ciphertextBytes: CanonicalNat64;
}>;

export type FilesWriteItem = Readonly<{
  transition: FilesNodeTransition;
  metadata: FilesPrivateMetadata;
  source: FilesTransferSource;
  contentId?: FilesId128V2;
}>;

export type FilesPrivateWritePlan = Readonly<{
  intent: FilesWriteIntent;
  items: readonly FilesWriteItem[];
  folderTransitions: readonly FilesFolderAggregateTransition[];
  childIndexTransitions: readonly FilesChildIndexTransition[];
  retiredContents: readonly FilesRetiredContent[];
  quota: FilesQuotaTransition;
}>;

export type FilesWriteReceipt = Readonly<{
  requestId: FilesId128V2;
  committedNodes: readonly FilesCommittedNodeV2[];
  nodeId: FilesId128V2 | null;
  contentId: FilesId128V2 | null;
  structuralRevision: CanonicalNat64 | null;
  cleanupPending: boolean;
}>;

export type FilesReadRequest = Readonly<{
  nodeId: FilesId128V2;
  structuralRevision: CanonicalNat64;
  contentId: FilesId128V2;
}>;

export type FilesReadResult = Readonly<{
  metadata: FilesFileMetadata;
  bytes: Uint8Array;
  node: FilesFrameNodeSummary;
  content: FilesFrameContentSummary;
}>;

export interface FilesBackendPort {
  bootstrap(): Promise<FilesAttachmentOutcomeV2<FilesBootstrapOkV2>>;
  list(request: FilesListRequestV2): Promise<FilesAttachmentOutcomeV2<FilesListOkV2>>;
  lookup(
    request: FilesLookupRequestV2,
  ): Promise<FilesAttachmentOutcomeV2<FilesLookupOkV2>>;
  readChunk(request: FilesReadChunkRequestV2): Promise<FilesReadChunkOutcomeV2>;
  operationStatus(
    request: FilesOperationStatusRequestV2,
  ): Promise<FilesOutcomeV2<FilesOperationStatusOkV2>>;
  vaultWrite(
    request: FilesVaultWriteRequestV2,
  ): Promise<FilesOutcomeV2<FilesVaultWriteOkV2>>;
  writeBlock(
    request: FilesWriteBlockRequestV2,
  ): Promise<FilesOutcomeV2<FilesWriteBlockOkV2>>;
  mutate(
    request: FilesMutateRequestV2,
  ): Promise<FilesOutcomeV2<FilesMutateOkV2>>;
  remove(request: FilesRemoveRequestV2): Promise<FilesOutcomeV2<FilesRemoveOkV2>>;
  abort(request: FilesAbortRequestV2): Promise<FilesOutcomeV2<FilesAbortOkV2>>;
  cleanup(request?: FilesCleanupRequestV2): Promise<FilesOutcomeV2<FilesCleanupOkV2>>;
}

export interface FilesCryptoPort {
  call(request: FilesCryptoWorkerRequestWithoutId): Promise<FilesCryptoWorkerResult>;
  onInactivityLock?(listener: () => void): () => void;
}

export interface FilesVetKeysPort {
  list(): Promise<{ slots: VetKeySlotSummary[] }>;
  request(request: VetKeysLifecycleRequest): Promise<VetKeysLifecycleResult>;
  publicKey(request: {
    slot: string;
    generation: string;
  }): Promise<VetKeyPublicInfo>;
  derive(
    request: {
      slot: string;
      generation: string;
      transportPublicKey: Uint8Array;
      requestNonce: Uint8Array;
    },
    options: {
      timeout: number;
      onChallenge: (challenge: VetKeyDeriveChallenge) => void;
    },
  ): Promise<VetKeyDeriveResult>;
  approve(challengeId: string): Promise<void>;
}

export type FilesFrameDecoded<Control> = Readonly<{
  control: Control;
  rawPayload: Uint8Array;
  exactFrame: Uint8Array;
}>;

export type FilesFrameNodeBinding = FilesNodeBindingV2;
export type FilesFrameContentDescriptor = FilesContentDescriptorV2;
export type FilesFrameDigest = FilesDigest256V2;

// Kept as a compile-time assertion that the public-capacity projection is
// sourced from the complete frozen kernel usage record.
export type FilesCapacitySource = Readonly<{
  quota: FilesQuotaSnapshotV2;
  publicUsage: FilesPublicUsageV2;
}>;
