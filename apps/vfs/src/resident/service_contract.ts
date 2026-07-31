import type { JsonObject } from "neutron-tools/app";
import type { CanonicalNat64 } from "../protocol/types.ts";
import type {
  FilesTransferControls,
  FilesTransferPhase,
  FilesTransferSource,
} from "../vault/types.ts";
import type {
  FilesContinuationScope,
} from "./continuation_registry.ts";
import type { FilesAuthorityResetReason } from "./authority.ts";
import type {
  FilesPathRouting,
  FilesPathRoutingMode,
} from "./path_routing.ts";

export const FILES_TOOL_NAMES = Object.freeze([
  "list",
  "stat",
  "read",
  "readBinary",
  "write",
  "writeBinary",
  "writeMany",
  "append",
  "patch",
  "mkdir",
  "move",
  "remove",
] as const);

export type FilesToolName = (typeof FILES_TOOL_NAMES)[number];

export const FILES_UI_TOOL = "files_ui";
export const FILES_UI_TRANSFER_TOOL = "files_ui_transfer";
export const FILES_UI_DOWNLOAD_TOOL = "files_ui_download";

export const FILES_SERVICE_LIMITS = Object.freeze({
  textBytes: 512 * 1024,
  // App-to-app attachments remain one-shot and use the Kernel's 16 MiB
  // transport envelope. The Files tile uses the chunked 64 MiB path below.
  binaryBytes: 16 * 1024 * 1024,
  tileBinaryBytes: 64 * 1024 * 1024,
  tileChunkBytes: 1_889_984,
  batchFiles: 20,
  batchTextBytes: 10 * 1024 * 1024,
  pageEntries: 200,
  mediaTypeBytes: 128,
  cursorBytes: 64,
});

export type FilesServiceEntry = Readonly<{
  path: string;
  name: string;
  type: "file" | "folder";
  nodeId: CanonicalNat64 | null;
  /**
   * Resident-only stable identity used to bind an awaited Vault mutation to
   * the exact encrypted node that was inspected. Tool/UI serializers must
   * never expose this opaque value.
   */
  opaqueNodeIdentity?: string;
  storageClass?: "shared" | "vault" | "workspace";
  contentKind: "text" | "binary" | null;
  byteLength: number | null;
  mediaType: string | null;
  etagSha256: string | null;
  publicUrl?: string | null;
  createdAtNs: CanonicalNat64;
  modifiedAtNs: CanonicalNat64;
  structuralRevision: CanonicalNat64;
  contentId: string | null;
}>;

export type FilesServiceListPage<Cursor> = Readonly<{
  path: string;
  folderRevision: CanonicalNat64;
  entries: readonly FilesServiceEntry[];
  total: number;
  cursor: Cursor | null;
  hasMore: boolean;
}>;

export type FilesServiceFile = Readonly<{
  entry: FilesServiceEntry & { type: "file"; byteLength: number };
  bytes: Uint8Array;
}>;

export type FilesServiceWriteResult = Readonly<{
  entry: FilesServiceEntry & { type: "file"; byteLength: number };
  cleanupPending: boolean;
}>;

export type FilesServiceMutationResult = Readonly<{
  path: string;
  structuralRevision: CanonicalNat64;
  changed: number;
  cleanupPending: boolean;
}>;

export type FilesServiceRemovePrecondition = Readonly<{
  nodeId: CanonicalNat64 | null;
  /** Resident-only; never accepted from tool JSON. */
  opaqueNodeIdentity?: string;
  structuralRevision: CanonicalNat64;
  etagSha256: string | null;
}>;

export type FilesServiceMoveSource = Readonly<{
  path: string;
  nodeId: CanonicalNat64;
  structuralRevision: CanonicalNat64;
  etagSha256: string | null;
}>;

export type FilesServiceStatus = Readonly<{
  vault:
    | "uninitialized"
    | "locked"
    | "ready"
    | "rotating"
    | "unrecoverable";
  lockEpoch: CanonicalNat64;
  currentGeneration: CanonicalNat64 | null;
  previousGeneration: CanonicalNat64 | null;
  rotationRequired: boolean;
  reason: string | null;
  quota: Readonly<{
    nodes: CanonicalNat64;
    plaintextBytes: CanonicalNat64;
    ciphertextBytes: CanonicalNat64;
    physicalBytes: CanonicalNat64;
    cleanupJobs: number;
  }>;
  publicUsage: FilesServicePublicUsage;
  transfers: readonly FilesServiceTransfer[];
}>;

export type FilesServicePublicUsageCounters = Readonly<{
  liveEntries: CanonicalNat64;
  occupiedEntrySlots: CanonicalNat64;
  committedBodyBytes: CanonicalNat64;
  reservedCommittedBodyBytes: CanonicalNat64;
  reservedEntrySlots: CanonicalNat64;
  allocatedBodyBytes: CanonicalNat64;
  chargedMetadataBytes: CanonicalNat64;
  acceptedStagedBytes: CanonicalNat64;
  reservedStagedBytes: CanonicalNat64;
  detachedChargedBytes: CanonicalNat64;
  activeStages: CanonicalNat64;
  receiptLanes: CanonicalNat64;
  generalReceiptLanes: CanonicalNat64;
  reservedGeneralReceiptLanes: CanonicalNat64;
  reservedRevocationLanes: CanonicalNat64;
  filledRevocationLanes: CanonicalNat64;
  receiptNonceIndexes: CanonicalNat64;
  receiptExpiryIndexes: CanonicalNat64;
  cleanupJobs: CanonicalNat64;
}>;

export type FilesServicePublicUsageLimits = Readonly<{
  entries: CanonicalNat64;
  committedBytes: CanonicalNat64;
  objectBytes: CanonicalNat64;
  stagedBytes: CanonicalNat64;
  pendingStages: CanonicalNat64;
  batchOperations: CanonicalNat64;
  batchBytes: CanonicalNat64;
  generalReceipts: CanonicalNat64;
  revocationLanes: CanonicalNat64;
}>;

export type FilesServicePublicUsage = Readonly<{
  current: FilesServicePublicUsageCounters;
  manifestLimits: FilesServicePublicUsageLimits;
  effectiveLimits: FilesServicePublicUsageLimits;
}>;

export type FilesServiceTransfer = Readonly<{
  id: string;
  label: string;
  phase:
    | "queued"
    | "hashing"
    | "encrypting"
    | "decrypting"
    | "uploading"
    | "downloading"
    | "checking-outcome"
    | "committed"
    | "cancelled"
    | "conflicted"
    | "failed"
    | "cleanup-pending";
  processedBytes: number;
  totalBytes: number;
  error: string | null;
}>;

export type FilesServiceUiAction =
  | Readonly<{ action: "status" }>
  | Readonly<{ action: "initialize" }>
  | Readonly<{ action: "unlock" }>
  | Readonly<{ action: "lock" }>
  | Readonly<{ action: "rotate" }>
  | Readonly<{
      action: "upload_begin";
      transferId: string;
      path: string;
      name: string;
      mediaType: string;
      size: number;
      contentKind: "binary";
    }>
  | Readonly<{ action: "cancel"; transferId: string }>
  | Readonly<{ action: "retry"; transferId: string }>;

export interface FilesResidentFilePort<Cursor = unknown> {
  /**
   * Publishes unsolicited resident state transitions (for example an
   * inactivity lock) so connected tiles refresh immediately instead of
   * discovering the new lock state on their next private operation.
   */
  onStatusChange?(
    listener: (
      reason:
        | "inactivity"
        | "worker_failure"
        | "authority_changed"
        | "state_changed",
    ) => void,
  ): () => void;
  onLock?(
    listener: (reason?: "inactivity" | "worker_failure") => void,
  ): () => void;
  status(): Promise<FilesServiceStatus>;
  initialize(): Promise<FilesServiceStatus>;
  unlock(): Promise<FilesServiceStatus>;
  lock(): Promise<FilesServiceStatus>;
  rotate(): Promise<FilesServiceStatus>;
  list(input: {
    path: string;
    cursor: Cursor | null;
    expectedFolderRevision: CanonicalNat64 | null;
    limit: number;
    recursive: boolean;
    /**
     * Resident-only authority selected from the validated tool request and
     * Kernel-attested caller. It is never accepted directly from caller JSON.
     */
    routing?: FilesPathRouting;
    signal?: AbortSignal;
  }): Promise<FilesServiceListPage<Cursor>>;
  stat(
    path: string,
    signal?: AbortSignal,
    routing?: FilesPathRouting,
  ): Promise<FilesServiceEntry>;
  read(
    path: string,
    controls?: FilesTransferControls & Readonly<{ transferId?: string }>,
    routing?: FilesPathRouting,
  ): Promise<FilesServiceFile>;
  write(
    input: {
      transferId?: string;
      path: string;
      source: FilesTransferSource;
      contentKind: "text" | "binary";
      mediaType: string;
      ifMatch: string | null;
      ifNoneMatch: boolean;
      createParents: boolean;
      moveSource?: FilesServiceMoveSource;
    },
    controls?: FilesTransferControls,
    routing?: FilesPathRouting,
  ): Promise<FilesServiceWriteResult>;
  writeMany(
    input: readonly {
      path: string;
      text: string;
      overwrite: boolean;
      createParents: boolean;
      mediaType: string;
    }[],
    controls?: FilesTransferControls,
    routing?: FilesPathRouting,
  ): Promise<readonly FilesServiceWriteResult[]>;
  mkdir(
    path: string,
    recursive: boolean,
    signal?: AbortSignal,
    routing?: FilesPathRouting,
  ): Promise<FilesServiceMutationResult>;
  move(
    from: string,
    to: string,
    overwrite: boolean,
    signal?: AbortSignal,
    routing?: FilesPathRouting,
  ): Promise<FilesServiceMutationResult>;
  remove(
    path: string,
    recursive: boolean,
    signal?: AbortSignal,
    precondition?: FilesServiceRemovePrecondition,
    routing?: FilesPathRouting,
  ): Promise<FilesServiceMutationResult>;
  cancel(transferId: string): Promise<FilesServiceStatus>;
  retry(transferId: string): Promise<FilesServiceStatus>;
  beginUpload(
    input: {
      transferId: string;
      path: string;
      name: string;
      mediaType: string;
      size: number;
      contentKind: "binary";
    },
    routing?: FilesPathRouting,
  ): Promise<
    Readonly<{ transferId: string; chunkBytes: number }>
  >;
  uploadChunk(
    input: {
      transferId: string;
      pass: "hash" | "encrypt";
      ordinal: number;
      final: boolean;
      totalBytes: number;
    },
    bytes: ArrayBuffer,
    controls?: FilesTransferControls,
  ): Promise<
    Readonly<{
      transferId: string;
      phase: FilesTransferPhase;
      processedBytes: number;
      totalBytes: number;
      committed: boolean;
      readyForUpload: boolean;
      entry: FilesServiceEntry | null;
    }>
  >;
  clearVolatile(reason?: FilesAuthorityResetReason): void;
}

export type FilesToolCursorValue<Cursor> = Readonly<{
  path: string;
  recursive: boolean;
  routingMode: FilesPathRoutingMode;
  backendCursor: Cursor;
}>;

export type FilesToolCallerScope = FilesContinuationScope;

export class FilesServiceFault extends Error {
  readonly code:
    | "needs_user_unlock"
    | "vault_unrecoverable"
    | "conflict"
    | "not_found"
    | "not_text"
    | "invalid"
    | "limit"
    | "quota"
    | "busy"
    | "cursor_expired"
    | "incompatible"
    | "temporarily_unavailable"
    | "cancelled"
    | "uncertain";
  readonly nextAction: string;
  readonly details: JsonObject;

  constructor(
    code: FilesServiceFault["code"],
    message: string,
    nextAction: string,
    details: JsonObject = {},
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "FilesServiceFault";
    this.code = code;
    this.nextAction = nextAction;
    this.details = details;
  }
}
