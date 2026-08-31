import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type DragEvent,
  type UIEvent,
} from "react";
import { createRoot } from "react-dom/client";
import {
  IoAddOutline,
  IoCheckmark,
  IoClose,
  IoCloudDownloadOutline,
  IoCloudUploadOutline,
  IoCopyOutline,
  IoDocumentOutline,
  IoDocumentTextOutline,
  IoFolderOpenOutline,
  IoFolderOutline,
  IoHomeOutline,
  IoImageOutline,
  IoKeyOutline,
  IoLinkOutline,
  IoMenuOutline,
  IoEllipsisVerticalOutline,
  IoRemoveOutline,
  IoPencilOutline,
  IoRefresh,
  IoReloadOutline,
  IoSaveOutline,
  IoShieldCheckmarkOutline,
  IoTrashOutline,
  IoWarningOutline,
} from "react-icons/io5";
import { cx, nt } from "neutron-design-system";
import {
  callTool,
  copyToClipboard,
  listApps,
  listVetKeys,
  loadTileContext,
  onAppStateChange,
  openAppTile,
  requestVetKeys,
  toError,
  type JsonObject,
  type JsonValue,
  type MsgBusEndpointId,
  type VetKeySlotSummary,
  type VetKeysLifecycleRequest,
  type VetKeysLifecycleResult,
} from "neutron-tools/app";
import {
  callToolWithAttachments,
  type AppToolAttachment,
} from "neutron-tools/app_attachments";
import { isMarkdownPath, MarkdownPreview } from "./markdown.tsx";
import {
  FILES_IMAGE_PREVIEW_MAX_BYTES,
  filesImagePreviewMediaType,
  validateFilesImageRead,
} from "./image_preview.ts";
import {
  FILES_SERVICE_LIMITS,
  FILES_UI_DOWNLOAD_TOOL,
  FILES_UI_TOOL,
  FILES_UI_TRANSFER_TOOL,
  FilesBlobUrlRegistry,
  FilesSerialUploadQueue,
  filesCanonicalPublicOrigin,
  normalizeFilesPath,
  normalizeFilesPolicyPath,
  validateFilesPolicyName,
} from "./resident/index.ts";
import "./style.scss";

const STATE_TOPIC = "filesystem";
const ATTACHMENT_NAME = "file";
const FILES_INTERNAL_DRAG_TYPE = "application/x-neutron-files-entry";
const ROW_HEIGHT = 32;
const OVERSCAN = 6;
const TEXT_LIMIT = 512 * 1024;
const PRIVATE_FILE_LIMIT = 64 * 1024 * 1024;
const BLOB_REVOKE_DELAY_MS = 60_000;
const FILES_VETKEY_SLOT = "files_vault";
const FOLDER_PAGE_SIZE = 200;
const MAX_PRIVATE_ENTRIES = 10_000;
const MAX_VISIBLE_TRANSFERS = 100;
const MAX_STATUS_TRANSFERS = 256;
const BUSY_REVEAL_MS = 400;
const BUSY_MIN_VISIBLE_MS = 650;
const DOWNLOAD_RELEASE_TIMEOUT_MS = 2_500;
const UPLOAD_COMMIT_POLL_MS = 750;
const UPLOAD_COMMIT_TIMEOUT_MS = 300_000;
const MESSAGE_BUS_LIFECYCLE_MESSAGES = new Set([
  "Message bus connection timed out",
  "Message bus connection replaced",
  "Message bus disconnected",
]);
const MESSAGE_BUS_RECONNECT_MIN_DELAY_MS = 100;
const MESSAGE_BUS_RECONNECT_MAX_DELAY_MS = 1_000;

export function isFilesMessageBusLifecycleError(value: unknown): boolean {
  return MESSAGE_BUS_LIFECYCLE_MESSAGES.has(errorMessage(value).trim());
}

async function retryFilesMessageBusRead<T>(
  read: () => Promise<T>,
  isCurrent: () => boolean,
): Promise<T | null> {
  let delayMs = MESSAGE_BUS_RECONNECT_MIN_DELAY_MS;
  while (isCurrent()) {
    try {
      return await read();
    } catch (nextError) {
      if (!isCurrent() || !isFilesMessageBusLifecycleError(nextError)) {
        throw nextError;
      }
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, delayMs);
      });
      delayMs = Math.min(
        MESSAGE_BUS_RECONNECT_MAX_DELAY_MS,
        delayMs * 2,
      );
    }
  }
  return null;
}

export type FilesTileEntry = Readonly<{
  path: string;
  name: string;
  type: "file" | "folder";
  nodeId: string | null;
  contentKind: "text" | "binary" | null;
  byteLength: number | null;
  mediaType: string | null;
  etag: string | null;
  createdAtNs: string;
  modifiedAtNs: string;
  revision: string;
  publicUrl: string | null;
}>;

export type FilesTileDownloadChunk = Readonly<{
  transferId: string;
  path: string;
  ordinal: number;
  etag: string;
  totalBytes: number;
  processedBytes: number;
  final: boolean;
  entry: FilesTileEntry;
  data: ArrayBuffer;
  mediaType: string;
}>;

export type FilesRootKind = "shared" | "vault" | "workspace";

export const FILES_UI_ROOTS: readonly Readonly<{
  kind: FilesRootKind;
  name: "Shared" | "Vault" | "Workspace";
  path: "/Shared" | "/Vault" | "/Workspace";
}>[] = Object.freeze([
  Object.freeze({ kind: "shared", name: "Shared", path: "/Shared" }),
  Object.freeze({ kind: "vault", name: "Vault", path: "/Vault" }),
  Object.freeze({
    kind: "workspace",
    name: "Workspace",
    path: "/Workspace",
  }),
]);

export type FilesTreeRow = Readonly<{
  entry: FilesTileEntry;
  level: number;
  position: number;
  setSize: number;
  root: FilesRootKind;
  isRoot: boolean;
  ancestorContinues: readonly boolean[];
  isLastSibling: boolean;
}>;

export type FilesDropIntent = Readonly<{
  sourcePath: string;
  targetFolder: string;
  destination: string;
  sourceRoot: FilesRootKind;
  targetRoot: FilesRootKind;
  policyChange: boolean;
}>;

export type FilesDropIntentResult =
  | Readonly<{ ok: true; intent: FilesDropIntent }>
  | Readonly<{ ok: false; reason: string }>;

export function filesRootKind(path: string): FilesRootKind | null {
  const normalized = normalizeFilesPath(path).path;
  for (const root of FILES_UI_ROOTS) {
    if (normalized === root.path || normalized.startsWith(`${root.path}/`)) {
      return root.kind;
    }
  }
  return null;
}

export function filesPathCanOpen(
  path: string,
  vaultState: FilesTileStatus["vault"] | null,
): boolean {
  return filesRootKind(path) !== "vault" || vaultState === "ready";
}

export function filesDropDestination(
  sourcePath: string,
  targetFolder: string,
): string {
  const source = normalizeFilesPolicyPath(sourcePath);
  const target = normalizeFilesPolicyPath(targetFolder);
  if (FILES_UI_ROOTS.some((root) => root.path === source)) {
    throw new Error("The main folders cannot be moved.");
  }
  if (!FILES_UI_ROOTS.some(
    (root) => target === root.path || target.startsWith(`${root.path}/`)
  )) {
    throw new Error("Choose Shared, Vault, Workspace, or a folder inside one.");
  }
  return canonicalFilesMoveDestination(
    source,
    joinPath(target, leafName(source)),
  );
}

export function filesDropIntent(
  sourcePath: string,
  target: Readonly<{ path: string; type: FilesTileEntry["type"] }>,
  vaultState: FilesTileStatus["vault"] | null,
): FilesDropIntentResult {
  try {
    if (target.type !== "folder") {
      throw new Error("Choose a folder as the move destination.");
    }
    const targetFolder = target.path;
    const sourceRoot = filesRootKind(sourcePath);
    const targetRoot = filesRootKind(targetFolder);
    if (!sourceRoot || !targetRoot) {
      throw new Error("Choose a folder inside Files.");
    }
    if (
      vaultState !== "ready" &&
      (sourceRoot === "vault" || targetRoot === "vault")
    ) {
      throw new Error("Open Vault before moving files into or out of it.");
    }
    const destination = filesDropDestination(sourcePath, targetFolder);
    return {
      ok: true,
      intent: {
        sourcePath: normalizeFilesPolicyPath(sourcePath),
        targetFolder: normalizeFilesPolicyPath(targetFolder),
        destination,
        sourceRoot,
        targetRoot,
        policyChange: sourceRoot !== targetRoot,
      },
    };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

export function filesPathContains(
  ancestorPath: string,
  candidatePath: string,
): boolean {
  const ancestor = normalizeFilesPath(ancestorPath).path;
  const candidate = normalizeFilesPath(candidatePath).path;
  return candidate === ancestor || candidate.startsWith(`${ancestor}/`);
}

export function flattenFilesTree(
  pages: ReadonlyMap<string, FilesTileList>,
  expandedPaths: ReadonlySet<string>,
): readonly FilesTreeRow[] {
  const rows: FilesTreeRow[] = [];
  const visit = (
    entry: FilesTileEntry,
    level: number,
    position: number,
    setSize: number,
    root: FilesRootKind,
    isRoot: boolean,
    ancestorContinues: readonly boolean[],
  ): void => {
    rows.push({
      entry,
      level,
      position,
      setSize,
      root,
      isRoot,
      ancestorContinues,
      isLastSibling: position >= setSize,
    });
    if (
      entry.type !== "folder" ||
      !expandedPaths.has(entry.path) ||
      level >= 64
    ) {
      return;
    }
    const page = pages.get(entry.path);
    const children = page?.entries ?? [];
    const childSetSize = page?.total ?? children.length;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (!child || !child.path.startsWith(`${entry.path}/`)) continue;
      visit(
        child,
        level + 1,
        index + 1,
        childSetSize,
        root,
        false,
        isRoot
          ? []
          : [...ancestorContinues, position < setSize],
      );
    }
  };
  for (let index = 0; index < FILES_UI_ROOTS.length; index += 1) {
    const root = FILES_UI_ROOTS[index]!;
    visit(
      rootEntry(root),
      1,
      index + 1,
      FILES_UI_ROOTS.length,
      root.kind,
      true,
      [],
    );
  }
  return rows;
}

export type FilesTileList = Readonly<{
  path: string;
  revision: string;
  entries: readonly FilesTileEntry[];
  loaded: number;
  total: number;
  hasMore: boolean;
  cursor: string | null;
}>;

export type FilesTileStatus = Readonly<{
  vault:
    | "uninitialized"
    | "locked"
    | "ready"
    | "rotating"
    | "unrecoverable";
  lockEpoch: string;
  currentGeneration: string | null;
  previousGeneration: string | null;
  rotationRequired: boolean;
  reason: string | null;
  quota: {
    nodes: string;
    plaintextBytes: string;
    ciphertextBytes: string;
    physicalBytes: string;
    cleanupJobs: number;
  };
  publicUsage: FilesTilePublicUsage;
  transfers: readonly FilesTileTransfer[];
}>;

export type FilesTilePublicUsageCounters = Readonly<{
  liveEntries: string;
  occupiedEntrySlots: string;
  committedBodyBytes: string;
  reservedCommittedBodyBytes: string;
  reservedEntrySlots: string;
  allocatedBodyBytes: string;
  chargedMetadataBytes: string;
  acceptedStagedBytes: string;
  reservedStagedBytes: string;
  detachedChargedBytes: string;
  activeStages: string;
  receiptLanes: string;
  generalReceiptLanes: string;
  reservedGeneralReceiptLanes: string;
  reservedRevocationLanes: string;
  filledRevocationLanes: string;
  receiptNonceIndexes: string;
  receiptExpiryIndexes: string;
  cleanupJobs: string;
}>;

export type FilesTilePublicUsageLimits = Readonly<{
  entries: string;
  committedBytes: string;
  objectBytes: string;
  stagedBytes: string;
  pendingStages: string;
  batchOperations: string;
  batchBytes: string;
  generalReceipts: string;
  revocationLanes: string;
}>;

export type FilesTilePublicUsage = Readonly<{
  current: FilesTilePublicUsageCounters;
  manifestLimits: FilesTilePublicUsageLimits;
  effectiveLimits: FilesTilePublicUsageLimits;
}>;

export type FilesTileTransfer = Readonly<{
  id: string;
  label: string;
  phase: string;
  processedBytes: number;
  totalBytes: number;
  error: string | null;
}>;

export function committedFilesResidentTransfer(
  transfers: readonly FilesTileTransfer[],
  transferId: string,
): FilesTileTransfer | null {
  return transfers.find((transfer) =>
      transfer.id === transferId &&
      (
        transfer.phase === "committed" ||
        transfer.phase === "cleanup-pending"
      )
    ) ?? null;
}

export function filesDownloadHandoffDecision(input: Readonly<{
  authorityCurrent: boolean;
  signalAborted: boolean;
  controllerCurrent: boolean;
  transferCurrent: boolean;
}>): "commit" | "cancelled" | "stale-authority" {
  if (!input.authorityCurrent) return "stale-authority";
  return (
      input.signalAborted ||
      !input.controllerCurrent ||
      !input.transferCurrent
    )
    ? "cancelled"
    : "commit";
}

export function filesDownloadStartIsCurrent(input: Readonly<{
  authorityCurrent: boolean;
  startEpoch: number;
  currentEpoch: number;
}>): boolean {
  return (
    input.authorityCurrent &&
    input.startEpoch === input.currentEpoch
  );
}

export async function releaseFilesResidentDownload(
  transferId: string,
  cancel: (transferId: string, signal: AbortSignal) => Promise<unknown>,
  timeoutMs = DOWNLOAD_RELEASE_TIMEOUT_MS,
): Promise<void> {
  const controller = new AbortController();
  const boundedTimeoutMs = Number.isFinite(timeoutMs)
    ? Math.min(
        DOWNLOAD_RELEASE_TIMEOUT_MS,
        Math.max(0, Math.trunc(timeoutMs)),
      )
    : DOWNLOAD_RELEASE_TIMEOUT_MS;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      cancel(transferId, controller.signal),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          controller.abort();
          resolve();
        }, boundedTimeoutMs);
      }),
    ]);
  } catch {
    // The resident inactivity expiry is the final backstop. Never replace the
    // original download failure with a best-effort cleanup failure.
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}

export type FilesTileClient = Readonly<{
  list(input: {
    path: string;
    cursor?: string | null;
    limit?: number;
    recursive?: boolean;
    signal?: AbortSignal;
  }): Promise<FilesTileList>;
  stat(path: string, signal?: AbortSignal): Promise<FilesTileEntry>;
  read(path: string, signal?: AbortSignal): Promise<{
    entry: FilesTileEntry;
    content: string;
  }>;
  write(input: {
    path: string;
    content: string;
    mediaType?: string;
    ifMatch?: string;
    ifNoneMatch?: "*";
    overwrite?: boolean;
    createParents?: boolean;
    signal?: AbortSignal;
    onProgress?: (value: JsonValue) => void;
  }): Promise<FilesTileEntry>;
  mkdir(path: string, signal?: AbortSignal): Promise<void>;
  move(
    from: string,
    to: string,
    overwrite?: boolean,
    signal?: AbortSignal,
  ): Promise<void>;
  remove(path: string, recursive: boolean, signal?: AbortSignal): Promise<void>;
  readBinary(path: string, options?: {
    ifMatch?: string;
    signal?: AbortSignal;
    onProgress?: (value: JsonValue) => void;
  }): Promise<{
    entry: FilesTileEntry;
    data: ArrayBuffer;
    mediaType: string;
  }>;
  downloadChunk(input: {
    transferId: string;
    path: string;
    ordinal: number;
    etag: string;
    signal?: AbortSignal;
    onProgress?: (value: JsonValue) => void;
  }): Promise<FilesTileDownloadChunk>;
  writeBinary(input: {
    path: string;
    data: ArrayBuffer;
    mediaType: string;
    ifMatch?: string;
    ifNoneMatch?: "*";
    signal?: AbortSignal;
    onProgress?: (value: JsonValue) => void;
  }): Promise<FilesTileEntry>;
  ui(action: JsonObject, signal?: AbortSignal): Promise<JsonObject>;
  beginUpload(input: {
    transferId: string;
    path: string;
    name: string;
    mediaType: string;
    size: number;
    signal?: AbortSignal;
  }): Promise<{ transferId: string; chunkBytes: number }>;
  uploadChunk(input: {
    transferId: string;
    pass: "hash" | "encrypt";
    ordinal: number;
    final: boolean;
    totalBytes: number;
    data: ArrayBuffer;
    signal?: AbortSignal;
    onProgress?: (value: JsonValue) => void;
  }): Promise<{
    phase: string;
    processedBytes: number;
    committed: boolean;
    readyForUpload: boolean;
    entry: FilesTileEntry | null;
  }>;
  prepareVault(): Promise<VetKeySlotSummary>;
  rotateVault(expectedCurrentGeneration: string): Promise<VetKeySlotSummary>;
  spreadsheetInstalled(): Promise<boolean>;
}>;

export function createFilesTileClient(
  target: MsgBusEndpointId,
): FilesTileClient {
  return {
    async list(input) {
      return parseList(
        await callTool(
          {
            target,
            name: "list",
            arguments: {
              path: input.path,
              recursive: input.recursive ?? false,
              limit: input.limit ?? 200,
              ...(input.cursor ? { cursor: input.cursor } : {}),
            },
          },
          {
            timeout: 45,
            ...(input.signal ? { signal: input.signal } : {}),
          },
        ),
      );
    },
    async stat(path, signal) {
      return parseEntry(
        record(
          await callTool(
            { target, name: "stat", arguments: { path } },
            { timeout: 45, ...(signal ? { signal } : {}) },
          ),
          "stat result",
        ),
      );
    },
    async read(path, signal) {
      const value = record(
        await callTool(
          { target, name: "read", arguments: { path } },
          { timeout: 45, ...(signal ? { signal } : {}) },
        ),
        "read result",
      );
      return {
        entry: parseEntry(value),
        content: string(value.content, "content"),
      };
    },
    async write(input) {
      return parseEntry(
        record(
          await callTool(
            {
              target,
              name: "write",
              arguments: {
                path: input.path,
                content: input.content,
                ...(input.mediaType ? { mediaType: input.mediaType } : {}),
                ...(input.ifMatch ? { ifMatch: input.ifMatch } : {}),
                ...(input.ifNoneMatch
                  ? { ifNoneMatch: input.ifNoneMatch }
                  : {}),
                ...(input.overwrite !== undefined
                  ? { overwrite: input.overwrite }
                  : {}),
                ...(input.createParents !== undefined
                  ? { createParents: input.createParents }
                  : {}),
              },
            },
            {
              timeout: 180,
              ...(input.signal ? { signal: input.signal } : {}),
              ...(input.onProgress
                ? { onProgress: input.onProgress }
                : {}),
            },
          ),
          "write result",
        ),
      );
    },
    async mkdir(path, signal) {
      await callTool(
        {
          target,
          name: "mkdir",
          arguments: { path, recursive: true },
        },
        { timeout: 120, ...(signal ? { signal } : {}) },
      );
    },
    async move(from, to, overwrite = false, signal) {
      await callTool(
        {
          target,
          name: "move",
          arguments: { from, to, overwrite },
        },
        { timeout: 600, ...(signal ? { signal } : {}) },
      );
    },
    async remove(path, recursive, signal) {
      await callTool(
        { target, name: "remove", arguments: { path, recursive } },
        { timeout: 120, ...(signal ? { signal } : {}) },
      );
    },
    async readBinary(path, options = {}) {
      const result = await callToolWithAttachments(
        {
          target,
          name: "readBinary",
          arguments: {
            path,
            ...(options.ifMatch ? { ifMatch: options.ifMatch } : {}),
          },
        },
        [],
        {
          timeoutSeconds: 180,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.onProgress
            ? { onProgress: options.onProgress }
            : {}),
        },
      );
      const attachment = result.attachments[0];
      if (
        result.attachments.length !== 1 ||
        !attachment ||
        attachment.name !== ATTACHMENT_NAME ||
        attachment.mediaType !== "application/octet-stream" ||
        attachment.byteLength !== attachment.data.byteLength ||
        attachment.data.byteLength > FILES_SERVICE_LIMITS.binaryBytes
      ) {
        throw new Error("Files binary response is missing its attachment");
      }
      const entry = parseEntry(record(result.value, "binary read result"));
      if (entry.byteLength !== attachment.data.byteLength) {
        throw new Error("Files binary response length is inconsistent");
      }
      return {
        entry,
        data: attachment.data,
        mediaType: attachment.mediaType,
      };
    },
    async downloadChunk(input) {
      const result = await callToolWithAttachments(
        {
          target,
          name: FILES_UI_DOWNLOAD_TOOL,
          arguments: {
            transferId: input.transferId,
            path: input.path,
            ordinal: input.ordinal,
            etag: input.etag,
          },
        },
        [],
        {
          timeoutSeconds: 300,
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.onProgress ? { onProgress: input.onProgress } : {}),
        },
      );
      const attachment = result.attachments[0];
      if (
        result.attachments.length !== 1 ||
        !attachment ||
        attachment.name !== ATTACHMENT_NAME ||
        attachment.mediaType !== "application/octet-stream" ||
        attachment.byteLength !== attachment.data.byteLength ||
        attachment.data.byteLength > FILES_SERVICE_LIMITS.tileChunkBytes
      ) {
        throw new Error("Files download chunk attachment is invalid");
      }
      const value = record(result.value, "download chunk result");
      return {
        transferId: string(value.transferId, "download transferId"),
        path: string(value.path, "download path"),
        ordinal: integer(value.ordinal, "download ordinal"),
        etag: string(value.etag, "download etag"),
        totalBytes: integer(value.totalBytes, "download totalBytes"),
        processedBytes: integer(
          value.processedBytes,
          "download processedBytes",
        ),
        final: boolean(value.final, "download final"),
        entry: parseEntry(value.entry),
        data: attachment.data,
        mediaType: attachment.mediaType,
      };
    },
    async writeBinary(input) {
      const attachment: AppToolAttachment = {
        name: ATTACHMENT_NAME,
        mediaType: input.mediaType,
        byteLength: input.data.byteLength,
        data: input.data,
      };
      const result = await callToolWithAttachments(
        {
          target,
          name: "writeBinary",
          arguments: {
            path: input.path,
            mediaType: input.mediaType,
            ...(input.ifMatch ? { ifMatch: input.ifMatch } : {}),
            ...(input.ifNoneMatch
              ? { ifNoneMatch: input.ifNoneMatch }
              : {}),
            createParents: true,
          },
        },
        [attachment],
        {
          timeoutSeconds: 300,
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.onProgress ? { onProgress: input.onProgress } : {}),
        },
      );
      return parseEntry(record(result.value, "binary write result"));
    },
    async ui(action, signal) {
      return record(
        await callTool(
          { target, name: FILES_UI_TOOL, arguments: action },
          { timeout: 300, ...(signal ? { signal } : {}) },
        ),
        "Files tile result",
      );
    },
    async beginUpload(input) {
      const result = record(
        await callTool(
          {
            target,
            name: FILES_UI_TOOL,
            arguments: {
              action: "upload_begin",
              transferId: input.transferId,
              path: input.path,
              name: input.name,
              mediaType: input.mediaType,
              size: input.size,
              contentKind: "binary",
            },
          },
          {
            timeout: 45,
            ...(input.signal ? { signal: input.signal } : {}),
          },
        ),
        "upload begin result",
      );
      return {
        transferId: string(result.transferId, "transferId"),
        chunkBytes: integer(result.chunkBytes, "chunkBytes"),
      };
    },
    async uploadChunk(input) {
      const result = await callToolWithAttachments(
        {
          target,
          name: FILES_UI_TRANSFER_TOOL,
          arguments: {
            transferId: input.transferId,
            pass: input.pass,
            ordinal: input.ordinal,
            final: input.final,
            totalBytes: input.totalBytes,
          },
        },
        [
          {
            name: ATTACHMENT_NAME,
            mediaType: "application/octet-stream",
            byteLength: input.data.byteLength,
            data: input.data,
          },
        ],
        {
          timeoutSeconds: 300,
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.onProgress ? { onProgress: input.onProgress } : {}),
        },
      );
      const value = record(result.value, "upload chunk result");
      return {
        phase: string(value.phase, "upload phase"),
        processedBytes: integer(
          value.processedBytes,
          "upload processedBytes",
        ),
        committed: boolean(value.committed, "upload committed"),
        readyForUpload: boolean(
          value.readyForUpload,
          "upload readyForUpload",
        ),
        entry:
          value.entry === null ? null : parseEntry(value.entry),
      };
    },
    prepareVault() {
      return prepareFilesVaultLifecycle();
    },
    rotateVault(expectedCurrentGeneration) {
      return startFilesVaultRotation(expectedCurrentGeneration);
    },
    async spreadsheetInstalled() {
      const value = record(await listApps(10), "app list");
      const apps = Array.isArray(value.apps) ? value.apps : [];
      return apps.some(
        (app) =>
          typeof app === "object" &&
          app !== null &&
          !Array.isArray(app) &&
          (app as JsonObject).id === "spreadsheet",
      );
    },
  };
}

type LocalTransfer = {
  id: string;
  file: File;
  path: string;
  residentId: string | null;
  phase: string;
  processedBytes: number;
  error: string | null;
  controller: AbortController | null;
};

type LocalDownload = {
  id: string;
  path: string;
  label: string;
  phase:
    | "queued"
    | "decrypting"
    | "downloading"
    | "checking-outcome"
    | "committed"
    | "cancelled"
    | "failed"
    | "cleanup-pending";
  processedBytes: number;
  totalBytes: number;
  error: string | null;
  controller: AbortController | null;
};

type EditorConflict = {
  latestEtag: string | null;
  message: string;
};

type CreateDraft = {
  kind: "file" | "folder";
  parentPath: string;
  name: string;
  error: string | null;
};

type RenameDraft = Readonly<{
  target: FilesTileEntry;
  name: string;
  error: string | null;
}>;

type StagedUpload = Readonly<{
  id: string;
  file: File;
}>;

function stagedUploads(
  files: FileList | readonly File[],
  limit: number,
): { items: readonly StagedUpload[]; truncated: number } {
  const incoming = Array.from(files);
  const accepted = incoming.slice(0, Math.max(0, limit));
  return {
    items: accepted.map((file) => ({ id: crypto.randomUUID(), file })),
    truncated: incoming.length - accepted.length,
  };
}

type UploadDraft = Readonly<{
  destination: string;
  items: readonly StagedUpload[];
  truncated: number;
}>;

type EntryMenuState = Readonly<{
  entry: FilesTileEntry;
  anchor: Readonly<{ left: number; top: number; right: number; bottom: number }>;
}>;

type FilesEntryMenuAction = Readonly<{
  label: string;
  icon: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect(): void;
}>;

type ImagePreviewState =
  | Readonly<{ key: string; phase: "loading"; url: null; error: null }>
  | Readonly<{ key: string; phase: "ready"; url: string; error: null }>
  | Readonly<{ key: string; phase: "error"; url: null; error: string }>;

export type FilesUploadReviewItem<T> = Readonly<{
  source: T;
  path: string | null;
  error: string | null;
}>;

export type FilesUploadReview<T> = Readonly<{
  items: readonly FilesUploadReviewItem<T>[];
  accepted: readonly FilesUploadReviewItem<T>[];
  acceptedBytes: number;
}>;

export function reviewFilesUpload<T extends Readonly<{
  name: string;
  size: number;
}>>(
  files: readonly T[],
  destinationFolder: string,
  activeTransfers: number,
  vaultState: FilesTileStatus["vault"] | null,
): FilesUploadReview<T> {
  const available = Math.max(0, MAX_VISIBLE_TRANSFERS - activeTransfers);
  const destinationOpen = filesPathCanOpen(destinationFolder, vaultState);
  const seen = new Set<string>();
  let acceptedCount = 0;
  const items = files.map((source): FilesUploadReviewItem<T> => {
    if (!destinationOpen) {
      return {
        source,
        path: null,
        error: "Open Vault before adding files there.",
      };
    }
    if (source.size > PRIVATE_FILE_LIMIT) {
      return {
        source,
        path: null,
        error: "This file is larger than the 64 MiB Files limit.",
      };
    }
    try {
      const path = joinPath(
        destinationFolder,
        validateFilesPolicyName(destinationFolder, source.name),
      );
      if (seen.has(path)) {
        return {
          source,
          path: null,
          error: "Another staged file has the same destination name.",
        };
      }
      seen.add(path);
      if (acceptedCount >= available) {
        return {
          source,
          path: null,
          error: `Only ${available} more file${available === 1 ? "" : "s"} can be queued.`,
        };
      }
      acceptedCount += 1;
      return { source, path, error: null };
    } catch {
      return {
        source,
        path: null,
        error: "Files cannot store this filename.",
      };
    }
  });
  const accepted = items.filter(
    (item) => item.path !== null && item.error === null,
  );
  return {
    items,
    accepted,
    acceptedBytes: accepted.reduce(
      (total, item) => total + item.source.size,
      0,
    ),
  };
}

function reviewStagedUploads(
  draft: UploadDraft,
  activeTransfers: number,
  vaultState: FilesTileStatus["vault"] | null,
) {
  return reviewFilesUpload(
    draft.items.map((item) => ({
      ...item,
      name: item.file.name,
      size: item.file.size,
    })),
    draft.destination,
    activeTransfers,
    vaultState,
  );
}

export function shutdownFilesTransfers(
  transfers: readonly {
    id: string;
    residentId: string | null;
  }[],
  controllers: Map<string, AbortController>,
  queue: Pick<FilesSerialUploadQueue, "close">,
  cancelResident: (transferId: string) => Promise<unknown>,
): void {
  queue.close();
  for (const [id, controller] of controllers) {
    controller.abort();
    const residentId = transfers.find((transfer) => transfer.id === id)
      ?.residentId;
    if (residentId) {
      void cancelResident(residentId).catch(() => undefined);
    }
  }
  controllers.clear();
}

export type FilesVaultLifecycleDependencies = Readonly<{
  list(): Promise<{ slots: VetKeySlotSummary[] }>;
  request(input: VetKeysLifecycleRequest): Promise<VetKeysLifecycleResult>;
}>;

const DEFAULT_FILES_VAULT_LIFECYCLE: FilesVaultLifecycleDependencies =
  Object.freeze({
    list: () => listVetKeys(),
    request: (input) => requestVetKeys(input),
  });

/**
 * Must be entered synchronously from the focused Files tile's initialize
 * click. Lifecycle authority stays with that tile; the resident receives only
 * the resulting enabled generation and never reserves or enables a slot.
 */
export async function prepareFilesVaultLifecycle(
  dependencies: FilesVaultLifecycleDependencies =
    DEFAULT_FILES_VAULT_LIFECYCLE,
): Promise<VetKeySlotSummary> {
  const listed = await dependencies.list();
  let slot =
    listed.slots.find((candidate) => candidate.slot === FILES_VETKEY_SLOT) ??
    null;
  if (slot === null) {
    const reserved = await dependencies.request({
      action: "reserve",
      slot: FILES_VETKEY_SLOT,
    });
    slot = reserved.retired ? null : reserved.slot;
  }
  if (slot?.status === "disabled") {
    const enabled = await dependencies.request({
      action: "enable",
      slot: FILES_VETKEY_SLOT,
    });
    slot = enabled.retired ? null : enabled.slot;
  }
  if (
    slot === null ||
    slot.slot !== FILES_VETKEY_SLOT ||
    slot.status !== "enabled"
  ) {
    throw new Error("The Files vault key slot is not enabled");
  }
  return slot;
}

/** Starts the trusted rotation before the resident is asked to rewrap. */
export async function startFilesVaultRotation(
  expectedCurrentGeneration: string,
  dependencies: Pick<FilesVaultLifecycleDependencies, "request"> =
    DEFAULT_FILES_VAULT_LIFECYCLE,
): Promise<VetKeySlotSummary> {
  const operation = dependencies.request({
    action: "rotate",
    slot: FILES_VETKEY_SLOT,
  });
  const result = await operation;
  const slot = result.retired ? null : result.slot;
  if (
    slot === null ||
    slot.slot !== FILES_VETKEY_SLOT ||
    slot.status !== "enabled" ||
    slot.currentGeneration === expectedCurrentGeneration ||
    slot.previousGeneration !== expectedCurrentGeneration
  ) {
    throw new Error("Neutron returned an invalid Files key rotation");
  }
  return slot;
}

export type FilesVaultMigrationNotice = Readonly<{
  kind: "migration-required";
  title: string;
  body: string;
  action: "finish" | null;
}>;

export function deriveFilesVaultMigrationNotice(
  status: Pick<
    FilesTileStatus,
    | "vault"
    | "currentGeneration"
    | "previousGeneration"
    | "rotationRequired"
  > | null,
): FilesVaultMigrationNotice | null {
  if (status === null || status.vault === "unrecoverable") return null;
  if (status.rotationRequired) {
    return Object.freeze({
      kind: "migration-required",
      title: "Finish security update",
      body: "Files is ready to finish the security update.",
      action: status.vault === "ready" ? "finish" : null,
    });
  }
  return null;
}

export function canonicalFilesMoveDestination(
  source: string,
  suppliedDestination: string,
): string {
  const from = normalizeFilesPolicyPath(source);
  const to = normalizeFilesPolicyPath(suppliedDestination);
  if (from === "/") {
    throw new Error("The Files root cannot be moved.");
  }
  if (to === "/") {
    throw new Error("Choose a destination name below the Files root.");
  }
  if (from === to) {
    throw new Error("Choose a different destination path.");
  }
  if (to.startsWith(`${from}/`)) {
    throw new Error("A folder cannot be moved inside itself.");
  }
  return to;
}

export type FilesSpreadsheetHandoffDependencies = Readonly<{
  readBinary(path: string): ReturnType<FilesTileClient["readBinary"]>;
  accept(
    args: JsonObject,
    attachment: AppToolAttachment,
  ): Promise<void>;
  open(): Promise<void>;
}>;

/**
 * Hands one authenticated immutable read to Spreadsheet. Opening a tile with
 * only a path is insufficient: Spreadsheet intentionally accepts Files bytes
 * only through its Files-tile-restricted attachment contract.
 */
export async function handoffFileToSpreadsheet(
  reviewed: FilesTileEntry,
  dependencies: FilesSpreadsheetHandoffDependencies,
): Promise<void> {
  if (reviewed.type !== "file" || !reviewed.etag) {
    throw new Error("Spreadsheet handoff requires a reviewed file etag");
  }
  const file = await dependencies.readBinary(reviewed.path);
  if (
    file.entry.path !== reviewed.path ||
    file.entry.etag !== reviewed.etag ||
    file.entry.byteLength !== file.data.byteLength ||
    !file.entry.etag ||
    !file.entry.mediaType
  ) {
    throw new Error(
      "The file changed after review; reload it before opening Spreadsheet",
    );
  }
  await dependencies.accept(
    {
      path: file.entry.path,
      mediaType: file.entry.mediaType,
      etag: file.entry.etag,
    },
    {
      name: ATTACHMENT_NAME,
      mediaType: file.mediaType,
      byteLength: file.data.byteLength,
      data: file.data,
    },
  );
  await dependencies.open();
}

export function isFilesPublicRelativeUrl(value: string): boolean {
  const match = value.match(
    /^\/app\/files\/_route\/shares\/[0-9a-f]{64}\/([A-Za-z0-9._-]{1,100})$/u,
  );
  return match !== null && match[1] !== "." && match[1] !== "..";
}

export function filesCanonicalPublicLink(
  relativeUrl: string,
  tileHref: string,
): string {
  if (!isFilesPublicRelativeUrl(relativeUrl)) {
    throw new Error("Files returned an invalid public link");
  }
  const publicOrigin = filesCanonicalPublicOrigin(tileHref);
  const publicUrl = new URL(relativeUrl, publicOrigin);
  if (publicUrl.origin !== publicOrigin) {
    throw new Error("Files returned a link for another site");
  }
  return publicUrl.href;
}

export function App({
  client: suppliedClient,
  subscribeStateChange = onAppStateChange,
}: {
  client?: FilesTileClient;
  subscribeStateChange?: typeof onAppStateChange;
} = {}) {
  const context = useMemo(() => loadTileContext(), []);
  const target = `app:${context.app ?? "files"}:background` as MsgBusEndpointId;
  const client = useMemo(
    () => suppliedClient ?? createFilesTileClient(target),
    [suppliedClient, target],
  );
  const mountedRef = useRef(true);
  const selectedRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const folderPathRef = useRef("/Workspace");
  const folderRequestRef = useRef(0);
  const editorRequestRef = useRef(0);
  const editorControllerRef = useRef<AbortController | null>(null);
  const imageRequestRef = useRef(0);
  const imageControllerRef = useRef<AbortController | null>(null);
  const imageUrlRef = useRef<string | null>(null);
  const privateRequestGenerationRef = useRef(0);
  const vaultRequestEpochRef = useRef(0);
  const authorityBoundaryGenerationRef = useRef(0);
  const statusRequestRef = useRef(0);
  const vaultLifecycleRequestRef = useRef(0);
  const vaultUnlockPromiseRef = useRef<Promise<FilesTileStatus | null> | null>(
    null,
  );
  const vaultMigrationAttemptRef = useRef<string | null>(null);
  const mountedClientRef = useRef<FilesTileClient | null>(null);
  const lastStatusRef = useRef<FilesTileStatus | null>(null);
  const downloadControllerRef = useRef<AbortController | null>(null);
  const downloadStartEpochRef = useRef(0);
  const downloadTransferRef = useRef<LocalDownload | null>(null);
  const uploadQueueRef = useRef<FilesSerialUploadQueue | null>(null);
  const transferControllersRef = useRef(new Map<string, AbortController>());
  const queuedTransferIdsRef = useRef(new Set<string>());
  const transfersRef = useRef<LocalTransfer[]>([]);
  const activeResidentTransferIdsRef = useRef("");
  const treeRequestRefs = useRef(new Map<string, number>());
  const treeControllersRef = useRef(new Map<string, AbortController>());
  const internalDragRef = useRef<Readonly<{
    path: string;
    token: string;
  }> | null>(null);
  const pendingTreeFocusRef = useRef<string | null>(null);
  const busyVisibleSinceRef = useRef(0);
  const busyOperationSequenceRef = useRef(0);
  const busyOperationsRef = useRef(new Map<number, Readonly<{
    blocksNavigation: boolean;
    label: string;
    vaultEpoch: number | null;
  }>>());
  const blobUrlsRef = useRef<FilesBlobUrlRegistry | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const browserToggleRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const resizeDragRef = useRef<Readonly<{
    pointerId: number;
    startX: number;
    startWidth: number;
  }> | null>(null);
  const [status, setStatus] = useState<FilesTileStatus | null>(null);
  const [folder, setFolder] = useState<FilesTileList>({
    path: "/Workspace",
    revision: "0",
    entries: [],
    loaded: 0,
    total: 0,
    hasMore: false,
    cursor: null,
  });
  folderPathRef.current = folder.path;
  const [selected, setSelected] = useState<string | null>(null);
  const [treeFocusPath, setTreeFocusPath] = useState("/Workspace");
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [loadedEtag, setLoadedEtag] = useState<string | null>(null);
  const [editorLoadingPath, setEditorLoadingPath] = useState<string | null>(
    null,
  );
  const [busy, setBusy] = useState<string | null>("Starting Files");
  const [visibleBusy, setVisibleBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(480);
  const [dragging, setDragging] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [keyboardMovePath, setKeyboardMovePath] = useState<string | null>(
    null,
  );
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(
    () => new Set(["/Workspace"]),
  );
  const [treePages, setTreePages] = useState<
    ReadonlyMap<string, FilesTileList>
  >(() => new Map());
  const [treeLoading, setTreeLoading] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [transfers, setTransfers] = useState<LocalTransfer[]>([]);
  const [downloadTransfer, setDownloadTransfer] =
    useState<LocalDownload | null>(null);
  const [transferToastHidden, setTransferToastHidden] = useState(false);
  const [createDraft, setCreateDraft] = useState<CreateDraft | null>(null);
  const [uploadDraft, setUploadDraft] = useState<UploadDraft | null>(null);
  const [entryMenu, setEntryMenu] = useState<EntryMenuState | null>(null);
  const [pendingMove, setPendingMove] = useState<FilesDropIntent | null>(null);
  const [browserCollapsed, setBrowserCollapsed] = useState(false);
  const [browserWidth, setBrowserWidth] = useState(240);
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const [renameDraft, setRenameDraft] = useState<RenameDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FilesTileEntry | null>(null);
  const [markdownPreview, setMarkdownPreview] = useState(false);
  const [spreadsheetInstalled, setSpreadsheetInstalled] = useState(false);
  const [conflict, setConflict] = useState<EditorConflict | null>(null);
  const [copiedLinkPath, setCopiedLinkPath] = useState<string | null>(null);
  const [imagePreview, setImagePreview] =
    useState<ImagePreviewState | null>(null);
  const [imageReloadEpoch, setImageReloadEpoch] = useState(0);
  if (uploadQueueRef.current === null) {
    uploadQueueRef.current = new FilesSerialUploadQueue();
  }
  if (blobUrlsRef.current === null && typeof URL !== "undefined") {
    blobUrlsRef.current = new FilesBlobUrlRegistry(
      URL,
      BLOB_REVOKE_DELAY_MS,
    );
  }
  const dirty = content !== savedContent;
  const currentRoot = filesRootKind(folder.path);
  const treeRows = useMemo(
    () => flattenFilesTree(treePages, expandedPaths),
    [expandedPaths, treePages],
  );
  const selectedEntry =
    treeRows.find((row) => row.entry.path === selected)?.entry ??
    folder.entries.find((entry) => entry.path === selected) ??
    null;

  function resetImagePreview({
    clearState = true,
    revokeAll = false,
  }: Readonly<{
    clearState?: boolean;
    revokeAll?: boolean;
  }> = {}): void {
    imageRequestRef.current += 1;
    imageControllerRef.current?.abort();
    imageControllerRef.current = null;
    if (revokeAll) {
      blobUrlsRef.current?.revokeAll();
    } else if (imageUrlRef.current) {
      blobUrlsRef.current?.revoke(imageUrlRef.current);
    }
    imageUrlRef.current = null;
    if (clearState) setImagePreview(null);
  }

  function beginBusy(
    label: string,
    vaultEpoch: number | null = null,
    blocksNavigation = false,
  ): number {
    const id = ++busyOperationSequenceRef.current;
    busyOperationsRef.current.set(id, {
      blocksNavigation,
      label,
      vaultEpoch,
    });
    setBusy(label);
    return id;
  }

  function finishBusy(id: number): void {
    if (!busyOperationsRef.current.delete(id)) return;
    const active = [...busyOperationsRef.current.values()].at(-1);
    setBusy(active?.label ?? null);
  }

  function clearBusy(): void {
    busyOperationsRef.current.clear();
    setBusy(null);
  }

  function clearIdleBusy(): void {
    if (busyOperationsRef.current.size === 0) setBusy(null);
  }

  function clearVaultBusy(): void {
    let changed = false;
    for (const [id, operation] of busyOperationsRef.current) {
      if (operation.vaultEpoch === null) continue;
      busyOperationsRef.current.delete(id);
      changed = true;
    }
    if (!changed) return;
    const active = [...busyOperationsRef.current.values()].at(-1);
    setBusy(active?.label ?? null);
  }

  function navigationIsBlocked(): boolean {
    return [...busyOperationsRef.current.values()].some(
      (operation) => operation.blocksNavigation,
    );
  }
  const focusedEntry =
    treeRows.find((row) => row.entry.path === treeFocusPath)?.entry ?? null;
  const virtual = useMemo(
    () =>
      virtualWindow(
        treeRows,
        scrollTop,
        viewportHeight,
        ROW_HEIGHT,
        OVERSCAN,
      ),
    [scrollTop, treeRows, viewportHeight],
  );

  useEffect(() => {
    const entry = selectedEntry;
    resetImagePreview();
    const mediaType = entry ? filesImagePreviewMediaType(entry) : null;
    if (
      !entry ||
      entry.type !== "file" ||
      entry.contentKind !== "binary" ||
      mediaType === null ||
      entry.etag === null ||
      entry.byteLength === null ||
      entry.byteLength > FILES_IMAGE_PREVIEW_MAX_BYTES
    ) {
      return;
    }
    const etag = entry.etag;
    const request = imageRequestRef.current;
    const generation = privateRequestGenerationRef.current;
    const key = `${entry.path}\n${entry.etag}`;
    const controller = new AbortController();
    imageControllerRef.current = controller;
    setImagePreview({ key, phase: "loading", url: null, error: null });
    const requestIsCurrent = (): boolean =>
      mountedRef.current &&
      request === imageRequestRef.current &&
      generation === privateRequestGenerationRef.current &&
      selectedRef.current === entry.path &&
      imageControllerRef.current === controller &&
      !controller.signal.aborted;
    void retryFilesMessageBusRead(
      () =>
        client.readBinary(entry.path, {
          ifMatch: etag,
          signal: controller.signal,
        }),
      requestIsCurrent,
    ).then((result) => {
      if (result === null) return;
      if (!requestIsCurrent()) {
        new Uint8Array(result.data).fill(0);
        return;
      }
      let data: ArrayBuffer | null = result.data;
      let url: string | null = null;
      try {
        const validated = validateFilesImageRead(entry, result);
        const blob = new Blob([validated.data], {
          type: validated.mediaType,
        });
        url = blobUrlsRef.current?.create(blob) ?? null;
        if (!url) throw new Error("Files could not create an image preview");
        if (!requestIsCurrent()) {
          blobUrlsRef.current?.revoke(url);
          return;
        }
        imageUrlRef.current = url;
        setImagePreview({ key, phase: "ready", url, error: null });
      } catch (nextError) {
        if (url) blobUrlsRef.current?.revoke(url);
        if (requestIsCurrent()) {
          setImagePreview({
            key,
            phase: "error",
            url: null,
            error: errorMessage(nextError),
          });
        }
      } finally {
        if (data) new Uint8Array(data).fill(0);
        data = null;
      }
    }).catch((nextError) => {
      if (!requestIsCurrent()) return;
      setImagePreview({
        key,
        phase: "error",
        url: null,
        error: errorMessage(nextError),
      });
    }).finally(() => {
      if (imageControllerRef.current === controller) {
        imageControllerRef.current = null;
      }
    });
    return () => {
      controller.abort();
    };
  }, [
    client,
    selectedEntry?.byteLength,
    selectedEntry?.contentKind,
    selectedEntry?.etag,
    selectedEntry?.mediaType,
    selectedEntry?.path,
    selectedEntry?.type,
    imageReloadEpoch,
  ]);

  useEffect(() => {
    selectedRef.current = selected;
    dirtyRef.current = dirty;
  }, [dirty, selected]);

  useEffect(() => {
    transfersRef.current = transfers;
  }, [transfers]);

  useEffect(() => {
    if (busy !== null) {
      if (visibleBusy !== null) {
        setVisibleBusy(busy);
        return;
      }
      const timeout = window.setTimeout(() => {
        busyVisibleSinceRef.current = Date.now();
        setVisibleBusy(busy);
      }, BUSY_REVEAL_MS);
      return () => window.clearTimeout(timeout);
    }
    if (visibleBusy === null) return;
    const remaining = Math.max(
      0,
      BUSY_MIN_VISIBLE_MS - (Date.now() - busyVisibleSinceRef.current),
    );
    const timeout = window.setTimeout(() => {
      busyVisibleSinceRef.current = 0;
      setVisibleBusy(null);
    }, remaining);
    return () => window.clearTimeout(timeout);
  }, [busy, visibleBusy]);

  useEffect(() => {
    const pendingPath = pendingTreeFocusRef.current;
    if (!pendingPath) return;
    const node = listRef.current;
    if (!node) return;
    const row = [...node.querySelectorAll<HTMLElement>("[data-path]")]
      .find((candidate) => candidate.dataset.path === pendingPath);
    if (!row) {
      const index = treeRows.findIndex(
        (candidate) => candidate.entry.path === pendingPath,
      );
      if (index >= 0) scrollTreeRowIntoView(index, node);
      return;
    }
    pendingTreeFocusRef.current = null;
    row.focus({ preventScroll: true });
  }, [treeFocusPath, treeRows, virtual.after, virtual.before, virtual.items]);

  useEffect(() => {
    if (treeRows.some((row) => row.entry.path === treeFocusPath)) return;
    const fallback =
      treeRows.find((row) => row.entry.path === folder.path) ??
      treeRows[0];
    if (!fallback) return;
    focusTreeRow(treeRows.indexOf(fallback));
  }, [folder.path, treeFocusPath, treeRows]);

  useEffect(() => {
    downloadTransferRef.current = downloadTransfer;
  }, [downloadTransfer]);

  useEffect(() => {
    const activeResidentIds = (status?.transfers ?? [])
      .filter((transfer) => !isTerminalTransferPhase(transfer.phase))
      .map((transfer) => transfer.id)
      .sort()
      .join(",");
    if (
      activeResidentIds &&
      activeResidentIds !== activeResidentTransferIdsRef.current
    ) {
      setTransferToastHidden(false);
    }
    activeResidentTransferIdsRef.current = activeResidentIds;
  }, [status?.transfers]);

  useEffect(() => {
    const residentTransfers = (status?.transfers ?? []).filter(
      (resident) =>
        !isTerminalTransferPhase(resident.phase) &&
        !transfers.some((local) => local.residentId === resident.id),
    );
    const phases = [
      ...transfers.map((transfer) => transfer.phase),
      ...residentTransfers.map((transfer) => transfer.phase),
      ...(downloadTransfer ? [downloadTransfer.phase] : []),
    ];
    if (
      phases.length === 0 ||
      phases.some((phase) => !isTerminalTransferPhase(phase))
    ) {
      return;
    }
    const timeout = window.setTimeout(() => {
      setTransferToastHidden(true);
      replaceTransfers((current) =>
        current.filter(
          (transfer) => !isTerminalTransferPhase(transfer.phase),
        )
      );
      setDownloadTransfer((current) =>
        current && isTerminalTransferPhase(current.phase) ? null : current
      );
    }, 2_200);
    return () => window.clearTimeout(timeout);
  }, [downloadTransfer, status?.transfers, transfers]);

  useEffect(() => {
    mountedRef.current = true;
    const clientChanged =
      mountedClientRef.current !== null &&
      mountedClientRef.current !== client;
    mountedClientRef.current = client;
    if (clientChanged) {
      lastStatusRef.current = null;
      vaultMigrationAttemptRef.current = null;
      purgePrivateTileState(false, "/Workspace");
    } else {
      uploadQueueRef.current = new FilesSerialUploadQueue();
    }
    return () => {
      mountedRef.current = false;
      privateRequestGenerationRef.current += 1;
      folderRequestRef.current += 1;
      editorRequestRef.current += 1;
      statusRequestRef.current += 1;
      editorControllerRef.current?.abort();
      editorControllerRef.current = null;
      resetImagePreview({ clearState: false, revokeAll: true });
      downloadStartEpochRef.current += 1;
      downloadControllerRef.current?.abort();
      downloadControllerRef.current = null;
      const downloadId = downloadTransferRef.current?.id;
      if (downloadId) {
        void client.ui({
          action: "cancel",
          transferId: downloadId,
        }).catch(() => undefined);
      }
      for (const controller of treeControllersRef.current.values()) {
        controller.abort();
      }
      treeControllersRef.current.clear();
      treeRequestRefs.current.clear();
      internalDragRef.current = null;
      const queue = uploadQueueRef.current;
      if (queue) {
        shutdownFilesTransfers(
          transfersRef.current,
          transferControllersRef.current,
          queue,
          (transferId) =>
            client.ui({ action: "cancel", transferId }),
        );
      }
      queuedTransferIdsRef.current.clear();
    };
    // Transfers intentionally remain memory-only; authority/page teardown
    // aborts them rather than persisting retry material.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);

  useEffect(() => {
    const list = listRef.current;
    const workspace = workspaceRef.current;
    if (!list || !workspace || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === list) {
          setViewportHeight(Math.round(entry.contentRect.height));
        } else if (entry.target === workspace) {
          setWorkspaceWidth(Math.round(entry.contentRect.width));
        }
      }
    });
    observer.observe(list);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

  function applyPrivateBoundary(
    next: FilesTileStatus,
    knownReason?: string | null,
  ): boolean {
    const previous = lastStatusRef.current;
    lastStatusRef.current = next;
    // A successful unlock clears `reason`, so retain the observed lock reason
    // long enough to distinguish a local Vault epoch from a true
    // resident-authority boundary.
    const boundaryReason = next.reason ?? knownReason;
    const sameAuthorityVaultLock =
      isFilesSameAuthorityVaultLockReason(boundaryReason);
    if (
      previous !== null &&
      previous.lockEpoch !== next.lockEpoch &&
      !sameAuthorityVaultLock
    ) {
      // Principal, installation, endpoint and resident authority changes are
      // global. Do not retain either plaintext or stale public/workspace rows.
      purgePrivateTileState(false, "/Workspace");
      return true;
    }
    if (next.vault === "ready") return false;
    if (
      previous !== null &&
      previous.vault === next.vault &&
      previous.currentGeneration === next.currentGeneration &&
      previous.previousGeneration === next.previousGeneration &&
      previous.rotationRequired === next.rotationRequired &&
      previous.reason === next.reason
    ) {
      // Status refreshes also carry quotas, transfers, and publication hints.
      // Repeating the same non-ready Vault boundary must not invalidate an
      // unrelated Shared or Workspace request.
      return false;
    }
    if (next.reason === "authority_changed") {
      purgePrivateTileState(false, "/Workspace");
      return true;
    }
    const affectsOpenVault =
      filesRootKind(folderPathRef.current) === "vault" ||
      (selectedRef.current !== null &&
        filesRootKind(selectedRef.current) === "vault");
    const mayRetainDirty = shouldRetainFilesDirtyBuffer(
      boundaryReason,
      dirtyRef.current,
    );
    purgeVaultTileState(mayRetainDirty);
    return affectsOpenVault;
  }

  function purgeVaultTileState(preserveDirty: boolean): void {
    vaultRequestEpochRef.current += 1;
    vaultLifecycleRequestRef.current += 1;
    vaultUnlockPromiseRef.current = null;
    clearVaultBusy();
    const selectedOutsideVault =
      selectedRef.current !== null &&
      filesRootKind(selectedRef.current) !== "vault";
    resetImagePreview({ revokeAll: true });
    if (selectedOutsideVault) {
      setImageReloadEpoch((current) => current + 1);
    }
    setCreateDraft((current) =>
      current && filesRootKind(current.parentPath) === "vault"
        ? null
        : current
    );
    setUploadDraft((current) =>
      current && filesRootKind(current.destination) === "vault"
        ? null
        : current
    );
    setEntryMenu((current) =>
      current && filesRootKind(current.entry.path) === "vault"
        ? null
        : current
    );
    setPendingMove((current) =>
      current &&
          (current.sourceRoot === "vault" || current.targetRoot === "vault")
        ? null
        : current
    );
    setDeleteTarget((current) =>
      current && filesRootKind(current.path) === "vault" ? null : current
    );
    setRenameDraft((current) =>
      current && filesRootKind(current.target.path) === "vault"
        ? null
        : current
    );
    setKeyboardMovePath((current) =>
      current && filesRootKind(current) === "vault" ? null : current
    );
    setDropTarget((current) =>
      current && filesRootKind(current) === "vault" ? null : current
    );
    if (
      pendingTreeFocusRef.current &&
      pendingTreeFocusRef.current !== "/Vault" &&
      filesRootKind(pendingTreeFocusRef.current) === "vault"
    ) {
      pendingTreeFocusRef.current = null;
    }
    setTreeFocusPath((current) =>
      current !== "/Vault" && filesRootKind(current) === "vault"
        ? "/Vault"
        : current
    );
    if (
      internalDragRef.current &&
      filesRootKind(internalDragRef.current.path) === "vault"
    ) {
      internalDragRef.current = null;
    }
    if (inputRef.current) inputRef.current.value = "";
    const retainedTransfers = transfersRef.current.filter((transfer) => {
      if (filesRootKind(transfer.path) !== "vault") return true;
      transferControllersRef.current.get(transfer.id)?.abort();
      if (transfer.residentId) {
        void client.ui({
          action: "cancel",
          transferId: transfer.residentId,
        }).catch(() => undefined);
      }
      return false;
    });
    replaceTransfers(() => retainedTransfers);
    const activeDownload = downloadTransferRef.current;
    if (activeDownload && filesRootKind(activeDownload.path) === "vault") {
      downloadStartEpochRef.current += 1;
      downloadControllerRef.current?.abort();
      downloadControllerRef.current = null;
      downloadTransferRef.current = null;
      setDownloadTransfer(null);
    }
    for (const [path, controller] of treeControllersRef.current) {
      if (filesRootKind(path) !== "vault") continue;
      controller.abort();
      treeControllersRef.current.delete(path);
      treeRequestRefs.current.delete(path);
    }
    setTreePages((current) => {
      const next = new Map(current);
      for (const path of next.keys()) {
        if (filesRootKind(path) === "vault") next.delete(path);
      }
      return next;
    });
    setExpandedPaths((current) =>
      new Set(
        [...current].filter((path) => filesRootKind(path) !== "vault"),
      )
    );
    setTreeLoading((current) =>
      new Set(
        [...current].filter((path) => filesRootKind(path) !== "vault"),
      )
    );
    const currentFolderPath = folderPathRef.current;
    if (filesRootKind(currentFolderPath) === "vault") {
      folderPathRef.current = "/Vault";
      setFolder(emptyTileList("/Vault"));
    }
    if (
      selectedRef.current !== null &&
      filesRootKind(selectedRef.current) === "vault"
    ) {
      if (preserveDirty && dirtyRef.current) return;
      editorRequestRef.current += 1;
      editorControllerRef.current?.abort();
      editorControllerRef.current = null;
      selectedRef.current = null;
      dirtyRef.current = false;
      setSelected(null);
      setContent("");
      setSavedContent("");
      setLoadedEtag(null);
      setEditorLoadingPath(null);
      setConflict(null);
      setMarkdownPreview(false);
    }
  }

  function purgePrivateTileState(
    preserveDirty: boolean,
    retainedFolderPath: string,
  ): void {
    privateRequestGenerationRef.current += 1;
    vaultLifecycleRequestRef.current += 1;
    vaultUnlockPromiseRef.current = null;
    authorityBoundaryGenerationRef.current += 1;
    folderRequestRef.current += 1;
    editorRequestRef.current += 1;
    vaultMigrationAttemptRef.current = null;
    editorControllerRef.current?.abort();
    editorControllerRef.current = null;
    for (const controller of treeControllersRef.current.values()) {
      controller.abort();
    }
    treeControllersRef.current.clear();
    treeRequestRefs.current.clear();
    internalDragRef.current = null;
    for (const controller of transferControllersRef.current.values()) {
      controller.abort();
    }
    downloadStartEpochRef.current += 1;
    downloadControllerRef.current?.abort();
    downloadControllerRef.current = null;
    transferControllersRef.current.clear();
    queuedTransferIdsRef.current.clear();
    uploadQueueRef.current?.close();
    uploadQueueRef.current = new FilesSerialUploadQueue();
    replaceTransfers(() => []);
    setDownloadTransfer(null);
    downloadTransferRef.current = null;
    if (inputRef.current) inputRef.current.value = "";
    setFolder({
      path: retainedFolderPath,
      revision: "0",
      entries: [],
      loaded: 0,
      total: 0,
      hasMore: false,
      cursor: null,
    });
    if (listRef.current) listRef.current.scrollTop = 0;
    setScrollTop(0);
    setDragging(false);
    setDropTarget(null);
    setExpandedPaths(new Set(["/Workspace"]));
    setTreeFocusPath("/Workspace");
    pendingTreeFocusRef.current = null;
    setTreePages(new Map());
    setTreeLoading(new Set());
    clearBusy();
    setError(null);
    setEditorLoadingPath(null);
    clearPrivateTileState(preserveDirty);
  }

  function clearPrivateTileState(preserveDirty: boolean): void {
    editorRequestRef.current += 1;
    editorControllerRef.current?.abort();
    editorControllerRef.current = null;
    resetImagePreview({ revokeAll: true });
    setDeleteTarget(null);
    setCreateDraft(null);
    setUploadDraft(null);
    setEntryMenu(null);
    setPendingMove(null);
    setRenameDraft(null);
    setKeyboardMovePath(null);
    setConflict(null);
    if (preserveDirty && dirtyRef.current) return;
    selectedRef.current = null;
    dirtyRef.current = false;
    setSelected(null);
    setContent("");
    setSavedContent("");
    setLoadedEtag(null);
    setEditorLoadingPath(null);
    setMarkdownPreview(false);
  }

  function captureVaultRequestEpoch(...paths: readonly string[]): number | null {
    return paths.some((path) => filesRootKind(path) === "vault")
      ? vaultRequestEpochRef.current
      : null;
  }

  function privateRequestIsCurrent(
    generation: number,
    vaultEpoch: number | null = null,
  ): boolean {
    return (
      mountedRef.current &&
      generation === privateRequestGenerationRef.current &&
      (vaultEpoch === null || vaultEpoch === vaultRequestEpochRef.current)
    );
  }

  function replaceTransfers(
    update: (current: readonly LocalTransfer[]) => LocalTransfer[],
  ): void {
    const next = update(transfersRef.current);
    transfersRef.current = next;
    setTransfers(next);
  }

  function applyStatusResult(
    next: FilesTileStatus,
    knownReason?: string | null,
  ): void {
    applyPrivateBoundary(next, knownReason);
    setStatus(next);
    replaceTransfers((current) =>
      current.map((transfer) => {
        if (!transfer.residentId) return transfer;
        const resident = next.transfers.find(
          (candidate) => candidate.id === transfer.residentId,
        );
        if (!resident) return transfer;
        if (
          transfer.phase === "checking-outcome" &&
          !isResolvedTransferPhase(resident.phase)
        ) {
          return transfer;
        }
        return {
          ...transfer,
          phase:
            resident.phase === "failed" &&
            isFilesKnownConflictFailure(resident.error)
              ? "conflicted"
              : resident.phase,
          processedBytes: resident.processedBytes,
          error: resident.error,
        };
      })
    );
    setError((current) =>
      current !== null && isFilesMessageBusLifecycleError(current)
        ? null
        : current,
    );
  }

  const unlockVault = useCallback((
    observedLocked: FilesTileStatus,
  ): Promise<FilesTileStatus | null> => {
    if (observedLocked.vault !== "locked") return Promise.resolve(null);
    const pending = vaultUnlockPromiseRef.current;
    if (pending) return pending;
    const generation = privateRequestGenerationRef.current;
    const vaultEpoch = captureVaultRequestEpoch("/Vault");
    const request = ++vaultLifecycleRequestRef.current;
    const observedStatusRequest = statusRequestRef.current;
    const requestIsCurrent = (): boolean =>
      privateRequestIsCurrent(generation, vaultEpoch) &&
      request === vaultLifecycleRequestRef.current;
    const busyId = beginBusy("Opening Vault", vaultEpoch);
    const operation = (async (): Promise<FilesTileStatus | null> => {
      try {
        // Unlock is an intentional, coalesced dispatch. In particular it must
        // not inherit the status-read reconnect loop and derive another key
        // merely because a resident connection was replaced.
        const next = parseStatus(await client.ui({ action: "unlock" }));
        if (!requestIsCurrent()) return null;
        statusRequestRef.current += 1;
        applyStatusResult(next, observedLocked.reason);
        setError(null);
        return next;
      } catch (nextError) {
        if (requestIsCurrent()) {
          const current = lastStatusRef.current;
          if (current?.vault === "ready") {
            setError(null);
            return current;
          }
          if (statusRequestRef.current === observedStatusRequest) {
            applyStatusResult(observedLocked);
          }
          setError(errorMessage(nextError));
        }
        return null;
      } finally {
        finishBusy(busyId);
        if (request === vaultLifecycleRequestRef.current) {
          vaultUnlockPromiseRef.current = null;
        }
      }
    })();
    vaultUnlockPromiseRef.current = operation;
    return operation;
    // applyStatusResult only uses refs and stable React setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const refreshStatus = useCallback(async () => {
    const request = ++statusRequestRef.current;
    const requestIsCurrent = (): boolean =>
      mountedRef.current && request === statusRequestRef.current;
    try {
      const next = await retryFilesMessageBusRead(
        async () => parseStatus(await client.ui({ action: "status" })),
        requestIsCurrent,
      );
      if (next === null || !requestIsCurrent()) return null;
      // Generic refreshes are observation-only. State publications, mutation
      // reconciliation, and reconnect retries must never derive a Vault key.
      applyStatusResult(next);
      return next;
    } catch (nextError) {
      if (requestIsCurrent()) setError(errorMessage(nextError));
      return null;
    } finally {
      if (requestIsCurrent()) clearIdleBusy();
    }
    // applyStatusResult only uses refs and stable React setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const loadTreeFolder = useCallback(
    async (
      path: string,
      force = false,
      vaultState = status?.vault ?? null,
    ): Promise<void> => {
      if (!filesPathCanOpen(path, vaultState)) return;
      if (!force && treePages.has(path)) return;
      const prior = treeControllersRef.current.get(path);
      prior?.abort();
      const controller = new AbortController();
      treeControllersRef.current.set(path, controller);
      const request = (treeRequestRefs.current.get(path) ?? 0) + 1;
      treeRequestRefs.current.set(path, request);
      setTreeLoading((current) => new Set(current).add(path));
      try {
        const requestIsCurrent = (): boolean =>
          mountedRef.current &&
          !controller.signal.aborted &&
          treeRequestRefs.current.get(path) === request;
        const page = await retryFilesMessageBusRead(
          () =>
            client.list({
              path,
              limit: FOLDER_PAGE_SIZE,
              signal: controller.signal,
            }),
          requestIsCurrent,
        );
        if (page === null) return;
        if (
          controller.signal.aborted ||
          treeRequestRefs.current.get(path) !== request
        ) {
          return;
        }
        setTreePages((current) => new Map(current).set(path, page));
      } catch (nextError) {
        if (!controller.signal.aborted) setError(errorMessage(nextError));
      } finally {
        if (treeControllersRef.current.get(path) === controller) {
          treeControllersRef.current.delete(path);
        }
        setTreeLoading((current) => {
          const next = new Set(current);
          next.delete(path);
          return next;
        });
      }
    },
    [client, status?.vault, treePages],
  );

  const loadFolder = useCallback(
    async (
      path: string,
      append = false,
      revisionRestart = false,
    ) => {
      if (!filesPathCanOpen(path, status?.vault ?? null)) {
        setFolder(emptyTileList(path));
        return;
      }
      const generation = privateRequestGenerationRef.current;
      const vaultEpoch = captureVaultRequestEpoch(path);
      const request = ++folderRequestRef.current;
      const requestIsCurrent = (): boolean =>
        privateRequestIsCurrent(generation, vaultEpoch) &&
        request === folderRequestRef.current;
      const busyId = beginBusy(
        append ? "Loading more files" : "Loading folder",
        vaultEpoch,
      );
      try {
        const page = await retryFilesMessageBusRead(
          () =>
            client.list({
              path,
              ...(append && folder.cursor ? { cursor: folder.cursor } : {}),
              limit: 200,
            }),
          requestIsCurrent,
        );
        if (page === null) return;
        if (!requestIsCurrent()) return;
        const resetSelection =
          revisionRestart &&
          !append &&
          shouldResetFilesSelectionAfterRevisionRestart(
            selectedRef.current,
            page.entries,
          );
        if (
          resetSelection &&
          dirtyRef.current &&
          !window.confirm(
            "This folder changed. Discard your unsaved changes and refresh it?",
          )
        ) {
          setError(
            "Your changes are still here. Save or discard them before refreshing this folder.",
          );
          return;
        }
        setFolder((current) => {
          if (!append) return page;
          if (current.revision !== page.revision) return page;
          const byPath = new Map(
            current.entries.map((entry) => [entry.path, entry]),
          );
          for (const entry of page.entries) byPath.set(entry.path, entry);
          return {
            ...page,
            entries: [...byPath.values()],
            loaded: byPath.size,
          };
        });
        setTreePages((current) => {
          if (!append) return new Map(current).set(path, page);
          const prior = current.get(path);
          if (!prior || prior.revision !== page.revision) {
            return new Map(current).set(path, page);
          }
          const entries = new Map(
            prior.entries.map((entry) => [entry.path, entry]),
          );
          for (const entry of page.entries) entries.set(entry.path, entry);
          return new Map(current).set(path, {
            ...page,
            entries: [...entries.values()],
            loaded: entries.size,
          });
        });
        if (!append && resetSelection) {
          clearPrivateTileState(false);
        }
        setError(null);
      } catch (nextError) {
        if (requestIsCurrent()) setError(errorMessage(nextError));
      } finally {
        finishBusy(busyId);
      }
    },
    [client, folder.cursor, folder.path, status?.vault],
  );

  useEffect(() => {
    void refreshStatus();
    void client
      .spreadsheetInstalled()
      .then((value) => mountedRef.current && setSpreadsheetInstalled(value))
      .catch(() => {});
  }, [client, refreshStatus]);

  useEffect(() => {
    if (
      status !== null &&
      filesPathCanOpen(folder.path, status.vault)
    ) {
      void loadFolder(folder.path, false);
    }
    // Vault readiness gates only Vault. Shared and Workspace remain ordinary
    // backend folders while key setup or recovery needs attention.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.vault]);

  useEffect(
    () =>
      subscribeStateChange(STATE_TOPIC, () => {
        const authorityGeneration =
          authorityBoundaryGenerationRef.current;
        void refreshStatus().then((next) => {
          const reloadPath =
            authorityGeneration ===
                authorityBoundaryGenerationRef.current
              ? folderPathRef.current
              : "/Workspace";
          if (
            next !== null &&
            !dirtyRef.current &&
            filesPathCanOpen(reloadPath, next.vault)
          ) {
            void loadFolder(reloadPath, false);
          }
        });
      }),
    [
      loadFolder,
      refreshStatus,
      subscribeStateChange,
    ],
  );

  useEffect(() => {
    if (
      busy !== null ||
      status?.vault !== "ready" ||
      !status.rotationRequired
    ) {
      return;
    }
    const signature = [
      status.lockEpoch,
      status.currentGeneration,
      status.previousGeneration ?? "",
    ].join(":");
    if (vaultMigrationAttemptRef.current === signature) return;
    vaultMigrationAttemptRef.current = signature;
    void finishVaultMigration(true);
    // The resident-only migration is intentionally attempted once for each
    // observed key generation. A visible error offers an explicit retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    busy,
    status?.currentGeneration,
    status?.previousGeneration,
    status?.lockEpoch,
    status?.rotationRequired,
    status?.vault,
  ]);

  async function vaultAction(
    action: "initialize" | "rotate",
  ): Promise<void> {
    if (busy) return;
    const generation = privateRequestGenerationRef.current;
    const vaultEpoch = captureVaultRequestEpoch("/Vault");
    const request = ++vaultLifecycleRequestRef.current;
    const requestIsCurrent = (): boolean =>
      privateRequestIsCurrent(generation, vaultEpoch) &&
      request === vaultLifecycleRequestRef.current;
    // Lifecycle requests originate in this focused click stack. The
    // background resident is deliberately never allowed to reserve,
    // enable, or rotate a vetKey slot on the tile's behalf.
    const startsNewRotation =
      action === "rotate" &&
      status?.vault === "ready" &&
      !status.rotationRequired &&
      status.previousGeneration === null;
    const lifecycle =
      action === "initialize"
        ? client.prepareVault()
        : action === "rotate"
          ? startsNewRotation && status?.currentGeneration
            ? client.rotateVault(status.currentGeneration)
            : Promise.reject(
                new Error("Files does not have a current key generation"),
              )
          : Promise.resolve(null);
    const busyId = beginBusy(
      action === "initialize"
        ? "Setting up Files"
        : "Updating security",
      vaultEpoch,
    );
    try {
      await lifecycle;
      const next = parseStatus(await client.ui({ action }));
      if (!requestIsCurrent()) return;
      statusRequestRef.current += 1;
      applyPrivateBoundary(next);
      setStatus(next);
      setError(null);
    } catch (nextError) {
      if (!requestIsCurrent()) return;
      const message = errorMessage(nextError);
      if (startsNewRotation) {
        try {
          const next = parseStatus(await client.ui({ action: "status" }));
          if (!requestIsCurrent()) return;
          statusRequestRef.current += 1;
          applyPrivateBoundary(next);
          setStatus(next);
        } catch {
          // Preserve the initiating rotation failure. A later refresh can
          // reconcile status if the resident itself is unavailable.
        }
      }
      if (requestIsCurrent()) setError(message);
    } finally {
      finishBusy(busyId);
    }
  }

  async function finishVaultMigration(quiet = false): Promise<void> {
    if (
      busy ||
      status?.vault !== "ready" ||
      !status.rotationRequired
    ) {
      return;
    }
    const generation = privateRequestGenerationRef.current;
    const vaultEpoch = captureVaultRequestEpoch("/Vault");
    const busyId = quiet ? null : beginBusy("Opening Vault", vaultEpoch);
    try {
      // The kernel key generation already advanced. This resident-only call
      // rewraps/verifies Files and must never rotate the kernel slot again.
      const next = parseStatus(await client.ui({ action: "rotate" }));
      if (!privateRequestIsCurrent(generation, vaultEpoch)) return;
      statusRequestRef.current += 1;
      applyPrivateBoundary(next);
      setStatus(next);
      setError(null);
    } catch {
      if (privateRequestIsCurrent(generation, vaultEpoch)) {
        setError(
          "Vault could not finish opening. Refresh Files and try again.",
        );
      }
    } finally {
      if (busyId !== null) finishBusy(busyId);
    }
  }

  function expandTreePath(path: string): void {
    const normalized = normalizeFilesPath(path).path;
    setExpandedPaths((current) => {
      const next = new Set(current);
      for (const root of FILES_UI_ROOTS) {
        if (
          normalized === root.path ||
          normalized.startsWith(`${root.path}/`)
        ) {
          next.add(root.path);
          let parent = parentPath(normalized);
          while (parent !== "/" && parent.startsWith(root.path)) {
            next.add(parent);
            parent = parentPath(parent);
          }
          next.add(normalized);
          break;
        }
      }
      return next;
    });
  }

  function pruneTreeSubtree(path: string): void {
    for (const [candidate, controller] of treeControllersRef.current) {
      if (!filesPathContains(path, candidate)) continue;
      controller.abort();
      treeControllersRef.current.delete(candidate);
    }
    for (const candidate of treeRequestRefs.current.keys()) {
      if (filesPathContains(path, candidate)) {
        treeRequestRefs.current.delete(candidate);
      }
    }
    setExpandedPaths((current) =>
      new Set(
        [...current].filter((candidate) =>
          !filesPathContains(path, candidate)
        ),
      )
    );
    setTreePages((current) =>
      new Map(
        [...current].filter(([candidate]) =>
          !filesPathContains(path, candidate)
        ),
      )
    );
    setTreeLoading((current) =>
      new Set(
        [...current].filter((candidate) =>
          !filesPathContains(path, candidate)
        ),
      )
    );
  }

  async function toggleTreeFolder(entry: FilesTileEntry): Promise<void> {
    if (navigationIsBlocked()) return;
    if (entry.type !== "folder") return;
    if (expandedPaths.has(entry.path)) {
      setExpandedPaths((current) => {
        const next = new Set(current);
        next.delete(entry.path);
        return next;
      });
      return;
    }
    if (!filesPathCanOpen(entry.path, status?.vault ?? null)) {
      if (filesRootKind(entry.path) === "vault" && status?.vault === "locked") {
        const next = await unlockVault(status);
        if (next?.vault === "ready") {
          expandTreePath(entry.path);
          await loadTreeFolder(entry.path, false, next.vault);
        }
      }
      return;
    }
    expandTreePath(entry.path);
    await loadTreeFolder(entry.path);
  }

  async function selectEntry(
    entry: FilesTileEntry,
    forceReload = false,
  ): Promise<void> {
    if (navigationIsBlocked()) return;
    const treeIndex = treeRows.findIndex(
      (row) => row.entry.path === entry.path,
    );
    if (treeIndex >= 0) {
      focusTreeRow(treeIndex);
    } else {
      setTreeFocusPath(entry.path);
      pendingTreeFocusRef.current = entry.path;
    }
    const retriesLockedVault =
      entry.type === "folder" &&
      filesRootKind(entry.path) === "vault" &&
      status?.vault === "locked";
    if (
      selectedRef.current === entry.path &&
      !forceReload &&
      !retriesLockedVault
    ) return;
    if (!confirmDiscardIfDirty(entry.path)) return;
    dirtyRef.current = false;
    const request = ++editorRequestRef.current;
    editorControllerRef.current?.abort();
    editorControllerRef.current = null;
    if (entry.type === "folder") {
      selectedRef.current = entry.path;
      setSelected(entry.path);
      setConflict(null);
      setMarkdownPreview(false);
      setEditorLoadingPath(null);
      setContent("");
      setSavedContent("");
      setLoadedEtag(null);
      if (!filesPathCanOpen(entry.path, status?.vault ?? null)) {
        setFolder(emptyTileList(entry.path));
        if (
          filesRootKind(entry.path) === "vault" &&
          status?.vault === "locked"
        ) {
          // Selecting Vault is a deliberate user gesture. Cold startup,
          // background state changes, and reconnect refreshes remain
          // observation-only and never reach this paid derivation path.
          const next = await unlockVault(status);
          if (
            next?.vault === "ready" &&
            selectedRef.current === entry.path
          ) {
            expandTreePath(entry.path);
          }
        }
        return;
      }
      expandTreePath(entry.path);
      setFolder(treePages.get(entry.path) ?? emptyTileList(entry.path));
      await loadFolder(entry.path, false);
      return;
    }
    selectedRef.current = entry.path;
    setSelected(entry.path);
    setConflict(null);
    setMarkdownPreview(false);
    setContent("");
    setSavedContent("");
    setLoadedEtag(null);
    setEditorLoadingPath(null);
    setError(null);
    const containingFolder = parentPath(entry.path);
    if (folder.path !== containingFolder) {
      folderRequestRef.current += 1;
      setFolder(
        treePages.get(containingFolder) ?? emptyTileList(containingFolder),
      );
    }
    if (entry.contentKind === "binary") {
      setLoadedEtag(entry.etag);
      return;
    }
    const generation = privateRequestGenerationRef.current;
    const vaultEpoch = captureVaultRequestEpoch(entry.path);
    const controller = new AbortController();
    editorControllerRef.current = controller;
    setEditorLoadingPath(entry.path);
    const requestIsCurrent = (): boolean =>
      privateRequestIsCurrent(generation, vaultEpoch) &&
      request === editorRequestRef.current &&
      selectedRef.current === entry.path &&
      editorControllerRef.current === controller &&
      !controller.signal.aborted;
    try {
      const result = await retryFilesMessageBusRead(
        () => client.read(entry.path, controller.signal),
        requestIsCurrent,
      );
      if (result === null) return;
      if (!requestIsCurrent()) return;
      setContent(result.content);
      setSavedContent(result.content);
      dirtyRef.current = false;
      setLoadedEtag(result.entry.etag);
      setError(null);
    } catch (nextError) {
      if (requestIsCurrent()) {
        setError(errorMessage(nextError));
      }
    } finally {
      if (
        generation === privateRequestGenerationRef.current &&
        request === editorRequestRef.current &&
        selectedRef.current === entry.path
      ) {
        if (editorControllerRef.current === controller) {
          editorControllerRef.current = null;
        }
        setEditorLoadingPath(null);
      }
    }
  }

  async function save(mode: "normal" | "copy" | "overwrite" = "normal") {
    if (!selectedEntry || selectedEntry.type !== "file") return;
    const sourcePath = selectedEntry.path;
    const buffer = content;
    const generation = privateRequestGenerationRef.current;
    const vaultEpoch = captureVaultRequestEpoch(sourcePath);
    const request = ++editorRequestRef.current;
    editorControllerRef.current?.abort();
    editorControllerRef.current = null;
    setEditorLoadingPath(null);
    const requestIsCurrent = (): boolean =>
      privateRequestIsCurrent(generation, vaultEpoch) &&
      request === editorRequestRef.current &&
      selectedRef.current === sourcePath;
    let path = sourcePath;
    let ifMatch = loadedEtag ?? undefined;
    if (mode === "copy") {
      path = copyPath(sourcePath);
      ifMatch = undefined;
    }
    if (mode === "overwrite") {
      if (
        !window.confirm(
          "Replace the newer saved version with your changes? Changes made elsewhere will be lost.",
        )
      ) {
        return;
      }
      try {
        const latest = await client.read(sourcePath);
        if (!requestIsCurrent()) return;
        ifMatch = latest.entry.etag ?? undefined;
      } catch (nextError) {
        if (requestIsCurrent()) {
          setError(errorMessage(nextError));
        }
        return;
      }
    }
    const busyId = beginBusy("Saving", vaultEpoch);
    try {
      const result = await client.write({
        path,
        content: buffer,
        ...(selectedEntry.mediaType
          ? { mediaType: selectedEntry.mediaType }
          : {}),
        ...(ifMatch ? { ifMatch } : { ifNoneMatch: "*" }),
      });
      if (!requestIsCurrent()) return;
      setSavedContent(buffer);
      dirtyRef.current = false;
      setLoadedEtag(result.etag);
      setConflict(null);
      setError(null);
      if (mode === "copy") {
        selectedRef.current = path;
        setSelected(path);
        setTreeFocusPath(path);
      }
      await loadFolder(parentPath(path), false);
      if (
        !privateRequestIsCurrent(generation, vaultEpoch) ||
        request !== editorRequestRef.current
      ) return;
    } catch (nextError) {
      if (!requestIsCurrent()) return;
      const message = errorMessage(nextError);
      if (/conflict|etag|changed|stale/i.test(message)) {
        setConflict({ latestEtag: null, message });
      } else {
        setError(message);
      }
    } finally {
      finishBusy(busyId);
    }
  }

  async function reloadConflict(): Promise<void> {
    if (!selectedEntry) return;
    setConflict(null);
    await selectEntry(selectedEntry, true);
  }

  function startCreate(
    kind: CreateDraft["kind"],
    parentPath: string,
  ): void {
    if (busy) return;
    if (!filesPathCanOpen(parentPath, status?.vault ?? null)) {
      setError("Open Vault before adding files there.");
      return;
    }
    setCreateDraft({ kind, parentPath, name: "", error: null });
  }

  async function createEntry(): Promise<void> {
    if (!createDraft || busy) return;
    let name: string;
    try {
      name = validateFilesPolicyName(
        createDraft.parentPath,
        createDraft.name,
      );
    } catch {
      setCreateDraft((current) =>
        current
          ? {
              ...current,
              error: "Enter one valid name without surrounding whitespace.",
            }
          : null
      );
      return;
    }
    const path = joinPath(createDraft.parentPath, name);
    const parent = createDraft.parentPath;
    const kind = createDraft.kind;
    const generation = privateRequestGenerationRef.current;
    const vaultEpoch = captureVaultRequestEpoch(parent);
    const busyId = beginBusy(
      kind === "folder" ? "Creating folder" : "Creating file",
      vaultEpoch,
      true,
    );
    try {
      if (kind === "folder") {
        await client.mkdir(path);
      } else {
        await client.write({
          path,
          content: "",
          ifNoneMatch: "*",
          createParents: false,
        });
      }
      if (!privateRequestIsCurrent(generation, vaultEpoch)) return;
      setCreateDraft(null);
      expandTreePath(parent);
      if (folder.path === parent) {
        await loadFolder(parent, false);
      } else {
        await loadTreeFolder(parent, true);
      }
    } catch (nextError) {
      if (privateRequestIsCurrent(generation, vaultEpoch)) {
        setCreateDraft((current) =>
          current ? { ...current, error: errorMessage(nextError) } : null
        );
      }
    } finally {
      finishBusy(busyId);
    }
  }

  function startRename(entry: FilesTileEntry): void {
    if (busy) return;
    if (FILES_UI_ROOTS.some((root) => root.path === entry.path)) return;
    if (
      dirtyRef.current &&
      selectedRef.current !== null &&
      filesPathContains(entry.path, selectedRef.current)
    ) {
      setError("Save or discard the open file before renaming this folder.");
      return;
    }
    setRenameDraft({ target: entry, name: entry.name, error: null });
  }

  function closeRename(): void {
    setRenameDraft(null);
  }

  async function renameEntry(): Promise<void> {
    if (!renameDraft || busy) return;
    const draft = renameDraft;
    if (
      dirtyRef.current &&
      selectedRef.current !== null &&
      filesPathContains(draft.target.path, selectedRef.current)
    ) {
      setRenameDraft((current) =>
        current
          ? {
              ...current,
              error:
                "Save or discard the open file before renaming this folder.",
            }
          : null
      );
      return;
    }
    let name: string;
    let destination: string;
    try {
      name = validateFilesPolicyName(
        parentPath(draft.target.path),
        draft.name,
      );
      destination = canonicalFilesMoveDestination(
        draft.target.path,
        joinPath(parentPath(draft.target.path), name),
      );
    } catch (nextError) {
      setRenameDraft((current) =>
        current ? { ...current, error: errorMessage(nextError) } : null
      );
      return;
    }
    const generation = privateRequestGenerationRef.current;
    const vaultEpoch = captureVaultRequestEpoch(
      draft.target.path,
      destination,
    );
    const sourcePath = draft.target.path;
    const sourceParent = parentPath(sourcePath);
    const selectedBeforeRename = selectedRef.current;
    const renamesCurrentSelection =
      selectedBeforeRename !== null &&
      filesPathContains(sourcePath, selectedBeforeRename);
    const selectedAfterRename =
      renamesCurrentSelection && selectedBeforeRename !== null
        ? `${destination}${selectedBeforeRename.slice(sourcePath.length)}`
        : selectedBeforeRename;
    const openFolderAfterRename =
      folder.path === sourcePath ||
        folder.path.startsWith(`${sourcePath}/`)
        ? `${destination}${folder.path.slice(sourcePath.length)}`
        : folder.path;
    const busyId = beginBusy("Renaming", vaultEpoch, true);
    try {
      await client.move(sourcePath, destination, false);
      if (!privateRequestIsCurrent(generation, vaultEpoch)) return;
      pruneTreeSubtree(sourcePath);
      closeRename();
      if (renamesCurrentSelection) {
        selectedRef.current = selectedAfterRename;
        setSelected(selectedAfterRename);
      }
      if (openFolderAfterRename !== folder.path) {
        expandTreePath(destination);
        await loadTreeFolder(sourceParent, true);
        await loadFolder(openFolderAfterRename, false);
      } else if (folder.path === sourceParent) {
        await loadFolder(sourceParent, false);
      } else {
        await loadTreeFolder(sourceParent, true);
      }
      if (!privateRequestIsCurrent(generation, vaultEpoch)) return;
      setTreeFocusPath(destination);
      pendingTreeFocusRef.current = destination;
      setError(null);
    } catch (nextError) {
      if (privateRequestIsCurrent(generation, vaultEpoch)) {
        setRenameDraft((current) =>
          current ? { ...current, error: errorMessage(nextError) } : null
        );
      }
    } finally {
      finishBusy(busyId);
    }
  }

  function requestMoveToFolder(
    sourcePath: string,
    target: Readonly<{ path: string; type: FilesTileEntry["type"] }>,
  ): void {
    if (busy) return;
    const result = filesDropIntent(
      sourcePath,
      target,
      status?.vault ?? null,
    );
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    if (
      dirtyRef.current &&
      selectedRef.current !== null &&
      filesPathContains(sourcePath, selectedRef.current)
    ) {
      setError("Save or discard the open file before moving this item.");
      return;
    }
    if (result.intent.policyChange) {
      setPendingMove(result.intent);
      return;
    }
    void performMove(result.intent);
  }

  async function performMove(intent: FilesDropIntent): Promise<void> {
    if (busy) {
      setPendingMove(null);
      return;
    }
    const current = filesDropIntent(
      intent.sourcePath,
      { path: intent.targetFolder, type: "folder" },
      status?.vault ?? null,
    );
    if (
      !current.ok ||
      current.intent.destination !== intent.destination ||
      current.intent.sourceRoot !== intent.sourceRoot ||
      current.intent.targetRoot !== intent.targetRoot
    ) {
      setPendingMove(null);
      setError(
        current.ok
          ? "The move destination changed. Choose it again."
          : current.reason,
      );
      return;
    }
    if (
      dirtyRef.current &&
      selectedRef.current !== null &&
      filesPathContains(intent.sourcePath, selectedRef.current)
    ) {
      setPendingMove(null);
      setError("Save or discard the open file before moving this item.");
      return;
    }
    setPendingMove(null);
    const { sourcePath, destination } = intent;
    const generation = privateRequestGenerationRef.current;
    const vaultEpoch = captureVaultRequestEpoch(sourcePath, destination);
    const sourceParent = parentPath(sourcePath);
    const destinationParent = parentPath(destination);
    const selectedBeforeMove = selectedRef.current;
    const movesCurrentSelection =
      selectedBeforeMove !== null &&
      filesPathContains(sourcePath, selectedBeforeMove);
    const selectedAfterMove =
      movesCurrentSelection && selectedBeforeMove !== null
        ? `${destination}${selectedBeforeMove.slice(sourcePath.length)}`
        : selectedBeforeMove;
    const openFolderAfterMove =
      folder.path === sourcePath ||
        folder.path.startsWith(`${sourcePath}/`)
        ? `${destination}${folder.path.slice(sourcePath.length)}`
        : movesCurrentSelection
          ? destinationParent
          : folder.path;
    const busyId = beginBusy(
      filesRootKind(sourcePath) === filesRootKind(destination)
        ? "Moving"
        : "Moving and updating storage",
      vaultEpoch,
      true,
    );
    try {
      await client.move(sourcePath, destination, false);
      if (!privateRequestIsCurrent(generation, vaultEpoch)) return;
      pruneTreeSubtree(sourcePath);
      expandTreePath(destinationParent);
      await Promise.all([
        sourceParent === openFolderAfterMove
          ? Promise.resolve()
          : loadTreeFolder(sourceParent, true),
        destinationParent === openFolderAfterMove ||
          destinationParent === sourceParent
          ? Promise.resolve()
          : loadTreeFolder(destinationParent, true),
      ]);
      await loadFolder(openFolderAfterMove, false);
      if (!privateRequestIsCurrent(generation, vaultEpoch)) return;
      selectedRef.current = selectedAfterMove;
      setSelected(selectedAfterMove);
      const focusAfterMove = selectedAfterMove ?? destination;
      setTreeFocusPath(focusAfterMove);
      pendingTreeFocusRef.current = focusAfterMove;
      setError(null);
    } catch (nextError) {
      if (privateRequestIsCurrent(generation, vaultEpoch)) {
        setError(errorMessage(nextError));
      }
    } finally {
      if (privateRequestIsCurrent(generation, vaultEpoch)) {
        setDropTarget(null);
      }
      finishBusy(busyId);
    }
  }

  async function copyPublicLink(entry: FilesTileEntry): Promise<void> {
    if (!entry.publicUrl) return;
    const generation = privateRequestGenerationRef.current;
    try {
      await copyToClipboard(
        filesCanonicalPublicLink(entry.publicUrl, window.location.href),
      );
      if (!privateRequestIsCurrent(generation)) return;
      setCopiedLinkPath(entry.path);
      window.setTimeout(() => {
        if (privateRequestIsCurrent(generation)) {
          setCopiedLinkPath((current) =>
            current === entry.path ? null : current
          );
        }
      }, 1_800);
    } catch (nextError) {
      setError(errorMessage(nextError));
    }
  }

  async function refreshContainingFolder(path: string): Promise<void> {
    const parent = parentPath(path);
    await loadTreeFolder(parent, true);
    if (folderPathRef.current === parent) await loadFolder(parent, false);
  }

  async function removeEntry(): Promise<void> {
    if (!deleteTarget || busy) return;
    const target = deleteTarget;
    if (
      dirtyRef.current &&
      selectedRef.current !== null &&
      filesPathContains(target.path, selectedRef.current)
    ) {
      setDeleteTarget(null);
      setError("Save or discard the open file before deleting this item.");
      return;
    }
    const generation = privateRequestGenerationRef.current;
    const vaultEpoch = captureVaultRequestEpoch(target.path);
    const targetParent = parentPath(target.path);
    const navigateAfterDelete = filesPathContains(
      target.path,
      folder.path,
    );
    const busyId = beginBusy("Removing item", vaultEpoch, true);
    try {
      await client.remove(
        target.path,
        target.type === "folder",
      );
      if (!privateRequestIsCurrent(generation, vaultEpoch)) return;
      if (
        selectedRef.current !== null &&
        filesPathContains(target.path, selectedRef.current)
      ) {
        editorRequestRef.current += 1;
        editorControllerRef.current?.abort();
        editorControllerRef.current = null;
        selectedRef.current = null;
        setSelected(null);
        setContent("");
        setSavedContent("");
        dirtyRef.current = false;
        setLoadedEtag(null);
        setEditorLoadingPath(null);
      }
      setDeleteTarget(null);
      pruneTreeSubtree(target.path);
      if (navigateAfterDelete) {
        expandTreePath(targetParent);
        selectedRef.current = targetParent;
        setSelected(targetParent);
        setTreeFocusPath(targetParent);
        pendingTreeFocusRef.current = targetParent;
        await loadFolder(targetParent, false);
      } else if (folder.path === targetParent) {
        await loadFolder(targetParent, false);
      } else {
        await loadTreeFolder(targetParent, true);
      }
      await refreshStatus();
    } catch (nextError) {
      if (privateRequestIsCurrent(generation, vaultEpoch)) {
        setError(errorMessage(nextError));
      }
    } finally {
      finishBusy(busyId);
    }
  }

  function stageFiles(
    destinationFolder: string,
    files: FileList | readonly File[] = [],
  ): void {
    if (busy) return;
    if (!filesPathCanOpen(destinationFolder, status?.vault ?? null)) {
      setError("Open Vault before adding files there.");
      return;
    }
    const staged = stagedUploads(files, MAX_VISIBLE_TRANSFERS);
    setUploadDraft({
      destination: destinationFolder,
      items: staged.items,
      truncated: staged.truncated,
    });
  }

  function appendStagedFiles(files: FileList | readonly File[]): void {
    if (!uploadDraft) return;
    const staged = stagedUploads(
      files,
      MAX_VISIBLE_TRANSFERS - uploadDraft.items.length,
    );
    if (staged.items.length === 0 && staged.truncated === 0) return;
    setUploadDraft((current) =>
      current
        ? {
            ...current,
            items: [...current.items, ...staged.items].slice(
              0,
              MAX_VISIBLE_TRANSFERS,
            ),
            truncated: current.truncated + staged.truncated,
          }
        : current
    );
  }

  function queueStagedFiles(): void {
    if (!uploadDraft || busy) return;
    const review = reviewStagedUploads(
      uploadDraft,
      transfersRef.current.length,
      status?.vault ?? null,
    );
    const accepted = review.accepted.flatMap((item) =>
      item.path === null ? [] : [{ file: item.source.file, path: item.path }]
    );
    if (accepted.length === 0) return;
    const rejected =
      review.items.length - accepted.length + uploadDraft.truncated;
    setUploadDraft(null);
    if (inputRef.current) inputRef.current.value = "";
    if (rejected > 0) {
      setError(
        `${rejected} staged file${rejected === 1 ? " was" : "s were"} skipped.`,
      );
    }
    enqueueFiles(accepted, uploadDraft.destination);
  }

  function enqueueFiles(
    files: readonly Readonly<{ file: File; path: string }>[],
    destinationFolder: string,
  ): void {
    expandTreePath(destinationFolder);
    setTransferToastHidden(false);
    for (const { file, path } of files) {
      const id = crypto.randomUUID();
      const transfer: LocalTransfer = {
        id,
        file,
        path,
        // The tile chooses the resident identity before dispatch so an
        // ordinary cancel can win even while upload_begin/write is awaiting.
        residentId: id,
        phase: "queued",
        processedBytes: 0,
        error: null,
        controller: null,
      };
      replaceTransfers((current) => [...current, transfer]);
      enqueueUpload(transfer);
    }
  }

  function enqueueUpload(item: LocalTransfer): void {
    if (queuedTransferIdsRef.current.has(item.id)) return;
    setTransferToastHidden(false);
    const controller = new AbortController();
    const generation = privateRequestGenerationRef.current;
    const vaultEpoch = captureVaultRequestEpoch(item.path);
    queuedTransferIdsRef.current.add(item.id);
    transferControllersRef.current.set(item.id, controller);
    updateTransfer(item.id, {
      phase: "queued",
      residentId: item.residentId,
      controller,
      error: null,
    });
    uploadQueueRef.current?.enqueue({
      id: `${item.id}:${crypto.randomUUID()}`,
      signal: controller.signal,
      run: async () => {
        try {
          if (
            controller.signal.aborted ||
            !privateRequestIsCurrent(generation, vaultEpoch)
          ) {
            return;
          }
          updateTransfer(item.id, { phase: "hashing" });
          await runUpload(item, controller, generation, vaultEpoch);
        } finally {
          transferControllersRef.current.delete(item.id);
          queuedTransferIdsRef.current.delete(item.id);
        }
      },
      onCancelledBeforeStart: () => {
        transferControllersRef.current.delete(item.id);
        queuedTransferIdsRef.current.delete(item.id);
        updateTransfer(item.id, {
          phase: "cancelled",
          controller: null,
          error: null,
        });
      },
    });
  }

  async function runUpload(
    item: LocalTransfer,
    controller: AbortController,
    generation: number,
    vaultEpoch: number | null,
  ): Promise<void> {
    const requestIsCurrent = (): boolean =>
      !controller.signal.aborted &&
      privateRequestIsCurrent(generation, vaultEpoch);
    try {
      const onProgress = (value: JsonValue): void => {
        if (!requestIsCurrent()) return;
        const progress = progressFrom(value);
        updateTransfer(item.id, {
          phase: progress.phase,
          processedBytes: progress.processedBytes,
        });
      };
      if (isTextUploadCandidate(item.file)) {
        const text = await readStrictTextFile(item.file, controller.signal);
        if (text !== null) {
          updateTransfer(item.id, { phase: "encrypting" });
          await client.write({
            path: item.path,
            content: text,
            ...(item.file.type ? { mediaType: item.file.type } : {}),
            ifNoneMatch: "*",
            signal: controller.signal,
            onProgress,
          });
        } else {
          await uploadBinaryFile(item, controller, onProgress);
        }
      } else {
        await uploadBinaryFile(item, controller, onProgress);
      }
      if (!requestIsCurrent()) return;
      updateTransfer(item.id, {
        phase: "committed",
        processedBytes: item.file.size,
        controller: null,
      });
      await refreshContainingFolder(item.path);
      await refreshStatus();
    } catch (nextError) {
      if (!privateRequestIsCurrent(generation, vaultEpoch)) return;
      const committed = committedFilesResidentTransfer(
        lastStatusRef.current?.transfers ?? [],
        item.id,
      );
      if (committed !== null) {
        updateTransfer(item.id, {
          phase: committed.phase,
          processedBytes: Math.max(
            committed.processedBytes,
            item.file.size,
          ),
          error: committed.error,
          controller: null,
        });
        return;
      }
      if (
        transfersRef.current.find((transfer) => transfer.id === item.id)
          ?.phase === "checking-outcome"
      ) {
        return;
      }
      const cancelled =
        controller.signal.aborted ||
        (nextError instanceof DOMException && nextError.name === "AbortError");
      const message = cancelled ? null : errorMessage(nextError);
      const conflicted =
        !cancelled && isFilesKnownConflictFailure(nextError);
      updateTransfer(item.id, {
        phase: cancelled
          ? "cancelled"
          : conflicted
            ? "conflicted"
            : "failed",
        error: message,
        controller: null,
      });
      if (
        message !== null &&
        !conflicted &&
        !isFilesAmbiguousTransferFailure(message)
      ) {
        setError(message);
      }
    }
  }

  async function uploadBinaryFile(
    item: LocalTransfer,
    controller: AbortController,
    onProgress: (value: JsonValue) => void,
  ): Promise<void> {
    const upload = await client.beginUpload({
      transferId: item.id,
      path: item.path,
      name: leafName(item.path),
      mediaType: item.file.type || "application/octet-stream",
      size: item.file.size,
      signal: controller.signal,
    });
    if (upload.transferId !== item.id) {
      throw new Error("Files changed the client-owned upload identity");
    }
    if (upload.chunkBytes < 1 || upload.chunkBytes > 1_889_984) {
      throw new Error("Files returned an invalid upload chunk size");
    }
    const accepted = await streamFilesUploadPasses(
      item.file,
      upload.chunkBytes,
      controller.signal,
      (chunk) =>
        client.uploadChunk({
          transferId: upload.transferId,
          pass: chunk.pass,
          ordinal: chunk.ordinal,
          final: chunk.final,
          totalBytes: item.file.size,
          data: chunk.data,
          signal: controller.signal,
          onProgress,
        }),
      (pass, offset, result) => {
        updateTransfer(item.id, {
          phase:
            result?.phase ??
            (pass === "hash"
              ? "hashing"
              : offset === 0
                ? "encrypting"
                : "uploading"),
          processedBytes: result.processedBytes,
        });
      },
    );
    if (!accepted.committed) {
      await waitForUploadCommit(
        upload.transferId,
        item.file.size,
        controller.signal,
      );
    }
  }

  async function waitForUploadCommit(
    transferId: string,
    totalBytes: number,
    signal: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + UPLOAD_COMMIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await abortableDelay(UPLOAD_COMMIT_POLL_MS, signal);
      const next = parseStatus(
        await client.ui({ action: "status" }, signal),
      );
      const resident = next.transfers.find(
        (transfer) => transfer.id === transferId,
      );
      if (resident === undefined) continue;
      updateTransfer(transferId, {
        phase: resident.phase,
        processedBytes: Math.min(
          totalBytes,
          resident.processedBytes,
        ),
      });
      if (
        resident.phase === "committed" ||
        resident.phase === "cleanup-pending"
      ) {
        return;
      }
      if (resident.phase === "cancelled") {
        throw new DOMException("Cancelled", "AbortError");
      }
      if (
        resident.phase === "conflicted" ||
        resident.phase === "failed"
      ) {
        throw new Error(
          resident.error ??
            (resident.phase === "conflicted"
              ? "A file with this name already exists."
              : "Files could not finish this upload."),
        );
      }
    }
    throw new Error(
      "Files is still finishing this upload. Retry after refreshing the folder.",
    );
  }

  async function cancelLocalTransfer(transfer: LocalTransfer): Promise<void> {
    transfer.controller?.abort();
    if (!transfer.residentId) {
      updateTransfer(transfer.id, {
        phase: "cancelled",
        controller: null,
        error: null,
      });
      return;
    }
    const generation = privateRequestGenerationRef.current;
    const vaultEpoch = captureVaultRequestEpoch(transfer.path);
    const requestIsCurrent = (): boolean =>
      privateRequestIsCurrent(generation, vaultEpoch);
    updateTransfer(transfer.id, {
      phase: "checking-outcome",
      controller: null,
    });
    try {
      const next = parseStatus(
        await client.ui({
          action: "cancel",
          transferId: transfer.residentId,
        }),
      );
      if (requestIsCurrent() && transferAwaitsOutcome(transfer)) {
        statusRequestRef.current += 1;
        const boundaryChanged = applyPrivateBoundary(next);
        setStatus(next);
        if (
          boundaryChanged ||
          !requestIsCurrent()
        ) return;
        const committed = committedFilesResidentTransfer(
          next.transfers,
          transfer.residentId,
        );
        if (committed !== null) {
          updateTransfer(transfer.id, {
            phase: committed.phase,
            processedBytes: Math.max(
              committed.processedBytes,
              transfer.file.size,
            ),
            controller: null,
            error: committed.error,
          });
          await refreshContainingFolder(transfer.path);
          return;
        }
        const resident = next.transfers.find(
          (candidate) => candidate.id === transfer.residentId,
        );
        updateTransfer(transfer.id, {
          phase: resident?.phase ?? "cancelled",
          processedBytes:
            resident?.processedBytes ?? transfer.processedBytes,
          controller: null,
          error: resident?.error ?? null,
        });
      }
    } catch (nextError) {
      if (requestIsCurrent() && transferAwaitsOutcome(transfer)) {
        updateTransfer(transfer.id, {
          phase: "cleanup-pending",
          error: errorMessage(nextError),
        });
      }
    }
  }

  async function uploadConflictedTransferAsCopy(
    transfer: LocalTransfer,
  ): Promise<void> {
    if (transfer.phase !== "conflicted") return;
    const generation = privateRequestGenerationRef.current;
    const vaultEpoch = captureVaultRequestEpoch(transfer.path);
    const requestIsCurrent = (): boolean =>
      privateRequestIsCurrent(generation, vaultEpoch);
    updateTransfer(transfer.id, {
      phase: "checking-outcome",
      controller: null,
    });
    try {
      if (transfer.residentId) {
        const next = parseStatus(
          await client.ui({
            action: "cancel",
            transferId: transfer.residentId,
          }),
        );
        if (!requestIsCurrent() || !transferAwaitsOutcome(transfer)) return;
        statusRequestRef.current += 1;
        const boundaryChanged = applyPrivateBoundary(next);
        setStatus(next);
        if (
          boundaryChanged ||
          !requestIsCurrent()
        ) return;
        const committed = committedFilesResidentTransfer(
          next.transfers,
          transfer.residentId,
        );
        if (committed !== null) {
          updateTransfer(transfer.id, {
            phase: committed.phase,
            processedBytes: Math.max(
              committed.processedBytes,
              transfer.file.size,
            ),
            error: committed.error,
            controller: null,
          });
          await refreshContainingFolder(transfer.path);
          return;
        }
      }
      if (!requestIsCurrent()) return;
      const replacementId = crypto.randomUUID();
      const restarted: LocalTransfer = {
        ...transfer,
        // Recovery can be clicked while the terminal render precedes the
        // old queue task's same-turn cleanup. A fresh local identity lets
        // the new attempt queue behind it without sharing bookkeeping.
        id: replacementId,
        path: copyPath(transfer.path),
        residentId: replacementId,
        phase: "queued",
        processedBytes: 0,
        error: null,
        controller: null,
      };
      replaceTransfers((current) =>
        current.map((item) =>
          item.id === transfer.id ? restarted : item
        )
      );
      enqueueUpload(restarted);
    } catch (nextError) {
      if (!requestIsCurrent() || !transferAwaitsOutcome(transfer)) return;
      updateTransfer(transfer.id, {
        phase: "conflicted",
        error: errorMessage(nextError),
        controller: null,
      });
    }
  }

  async function retryLocalTransfer(transfer: LocalTransfer): Promise<void> {
    if (
      transfer.phase === "failed" &&
      !isFilesAmbiguousTransferFailure(transfer.error)
    ) {
      if (transfer.error) setError(transfer.error);
      return;
    }
    if (!transfer.residentId) {
      const replacementId = crypto.randomUUID();
      const restarted = {
        ...transfer,
        id: replacementId,
        residentId: replacementId,
        phase: "queued",
        processedBytes: 0,
        error: null,
        controller: null,
      };
      replaceTransfers((current) =>
        current.map((item) =>
          item.id === transfer.id ? restarted : item
        )
      );
      enqueueUpload(restarted);
      return;
    }
    const generation = privateRequestGenerationRef.current;
    const vaultEpoch = captureVaultRequestEpoch(transfer.path);
    const requestIsCurrent = (): boolean =>
      privateRequestIsCurrent(generation, vaultEpoch);
    updateTransfer(transfer.id, {
      phase: "checking-outcome",
      error: null,
    });
    try {
      const next = parseStatus(
        await client.ui({
          // The tile still owns the original OS File, but the resident cannot
          // replay an erased private stage. Prove exact abort first, then
          // start a fresh two-pass upload; never overlap two stage identities.
          action: "cancel",
          transferId: transfer.residentId,
        }),
      );
      if (requestIsCurrent() && transferAwaitsOutcome(transfer)) {
        statusRequestRef.current += 1;
        const boundaryChanged = applyPrivateBoundary(next);
        setStatus(next);
        if (
          boundaryChanged ||
          !requestIsCurrent()
        ) return;
        const committed = committedFilesResidentTransfer(
          next.transfers,
          transfer.residentId,
        );
        if (committed !== null) {
          updateTransfer(transfer.id, {
            phase: committed.phase,
            processedBytes: Math.max(
              committed.processedBytes,
              transfer.file.size,
            ),
            error: committed.error,
            controller: null,
          });
          await refreshContainingFolder(transfer.path);
          return;
        }
        const replacementId = crypto.randomUUID();
        const restarted = {
          ...transfer,
          id: replacementId,
          residentId: replacementId,
          phase: "queued",
          processedBytes: 0,
          error: null,
          controller: null,
        };
        replaceTransfers((current) =>
          current.map((item) =>
            item.id === transfer.id ? restarted : item
          )
        );
        enqueueUpload(restarted);
      }
    } catch (nextError) {
      if (!requestIsCurrent() || !transferAwaitsOutcome(transfer)) return;
      const message = errorMessage(nextError);
      updateTransfer(transfer.id, {
        phase: "failed",
        error: message,
      });
      if (!isFilesAmbiguousTransferFailure(message)) setError(message);
    }
  }

  function updateTransfer(
    id: string,
    patch: Partial<LocalTransfer>,
  ): void {
    replaceTransfers((current) =>
      current.map((item) =>
        item.id === id ? { ...item, ...patch } : item
      )
    );
  }

  function transferAwaitsOutcome(transfer: LocalTransfer): boolean {
    const current = transfersRef.current.find(
      (candidate) => candidate.id === transfer.id,
    );
    return (
      current?.residentId === transfer.residentId &&
      current.phase === "checking-outcome"
    );
  }

  async function downloadSelected(): Promise<void> {
    if (!selectedEntry || selectedEntry.type !== "file") return;
    const reviewed = selectedEntry;
    if (
      reviewed.etag === null ||
      reviewed.byteLength === null ||
      reviewed.mediaType === null
    ) {
      setError("Reload this file before downloading it.");
      return;
    }
    setTransferToastHidden(false);
    const generation = privateRequestGenerationRef.current;
    const vaultEpoch = captureVaultRequestEpoch(reviewed.path);
    const startEpoch = ++downloadStartEpochRef.current;
    downloadControllerRef.current?.abort();
    const previousDownloadId = downloadTransferRef.current?.id;
    if (previousDownloadId) {
      await releaseFilesResidentDownload(
        previousDownloadId,
        (transferId, signal) =>
          client.ui({
            action: "cancel",
            transferId,
          }, signal),
      );
    }
    if (!filesDownloadStartIsCurrent({
      authorityCurrent: privateRequestIsCurrent(generation, vaultEpoch),
      startEpoch,
      currentEpoch: downloadStartEpochRef.current,
    })) {
      return;
    }
    const controller = new AbortController();
    downloadControllerRef.current = controller;
    const transfer: LocalDownload = {
      id: crypto.randomUUID(),
      path: reviewed.path,
      label: reviewed.name,
      phase: "downloading",
      processedBytes: 0,
      totalBytes: reviewed.byteLength,
      error: null,
      controller,
    };
    setDownloadTransfer(transfer);
    downloadTransferRef.current = transfer;
    const requestIsCurrent = (): boolean =>
      privateRequestIsCurrent(generation, vaultEpoch) &&
      startEpoch === downloadStartEpochRef.current &&
      downloadControllerRef.current === controller &&
      downloadTransferRef.current?.id === transfer.id;
    try {
      const result = await streamFilesDownloadChunks(
        reviewed,
        transfer.id,
        controller.signal,
        (ordinal) =>
          client.downloadChunk({
            transferId: transfer.id,
            path: reviewed.path,
            ordinal,
            etag: reviewed.etag!,
            signal: controller.signal,
            onProgress(value) {
              if (
                !requestIsCurrent()
              ) {
                return;
              }
              const progress = progressFrom(value);
              setDownloadTransfer((current) =>
                current?.id === transfer.id
                  ? {
                      ...current,
                      phase:
                        progress.phase === "decrypting"
                          ? "decrypting"
                          : "downloading",
                      processedBytes: Math.max(
                        current.processedBytes,
                        progress.processedBytes,
                      ),
                    }
                  : current
              );
            },
          }),
        (processedBytes) => {
          if (
            !requestIsCurrent()
          ) {
            return;
          }
          setDownloadTransfer((current) =>
            current?.id === transfer.id
              ? {
                  ...current,
                  phase: "downloading",
                  processedBytes: Math.max(
                    current.processedBytes,
                    processedBytes,
                  ),
                }
              : current
          );
        },
      );
      const handoff = filesDownloadHandoffDecision({
        authorityCurrent:
          privateRequestIsCurrent(generation, vaultEpoch) &&
          startEpoch === downloadStartEpochRef.current,
        signalAborted: controller.signal.aborted,
        controllerCurrent: downloadControllerRef.current === controller,
        transferCurrent: downloadTransferRef.current?.id === transfer.id,
      });
      if (handoff === "stale-authority") {
        wipeFilesDownloadChunks(result.chunks);
        return;
      }
      if (handoff === "cancelled") {
        wipeFilesDownloadChunks(result.chunks);
        throw new DOMException("Cancelled", "AbortError");
      }
      const registry = blobUrlsRef.current;
      if (!registry) {
        wipeFilesDownloadChunks(result.chunks);
        throw new Error("Blob downloads are unavailable");
      }
      let blob: Blob;
      try {
        blob = new Blob([...result.chunks], { type: result.mediaType });
      } finally {
        wipeFilesDownloadChunks(result.chunks);
      }
      const url = registry.create(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = reviewed.name;
      anchor.rel = "noopener";
      anchor.click();
      registry.releaseAfterHandoff(url);
      setDownloadTransfer({
        ...transfer,
        phase: "committed",
        processedBytes: transfer.totalBytes,
        controller: null,
      });
      downloadTransferRef.current = {
        ...transfer,
        phase: "committed",
        processedBytes: transfer.totalBytes,
        controller: null,
      };
      setError(null);
    } catch (nextError) {
      if (requestIsCurrent()) {
        if (controller.signal.aborted) {
          const cancelled: LocalDownload = {
            ...transfer,
            phase: "cancelled",
            controller: null,
          };
          downloadTransferRef.current = cancelled;
          setDownloadTransfer(cancelled);
        } else {
          const message = errorMessage(nextError);
          const failed: LocalDownload = {
            ...transfer,
            phase: "failed",
            error: message,
            controller: null,
          };
          downloadTransferRef.current = failed;
          setDownloadTransfer(failed);
          setError(message);
        }
      }
    } finally {
      await releaseFilesResidentDownload(
        transfer.id,
        (transferId, signal) =>
          client.ui({
            action: "cancel",
            transferId,
          }, signal),
      );
      if (downloadControllerRef.current === controller) {
        downloadControllerRef.current = null;
      }
    }
  }

  async function cancelDownload(): Promise<void> {
    const controller = downloadControllerRef.current;
    const transfer = downloadTransferRef.current;
    if (!controller || !transfer || transfer.phase === "committed") return;
    const generation = privateRequestGenerationRef.current;
    const vaultEpoch = captureVaultRequestEpoch(transfer.path);
    const cancelEpoch = ++downloadStartEpochRef.current;
    controller.abort();
    downloadControllerRef.current = null;
    const checking: LocalDownload = {
      ...transfer,
      phase: "checking-outcome",
      controller: null,
    };
    downloadTransferRef.current = checking;
    setDownloadTransfer((current) =>
      current?.id === transfer.id ? checking : current
    );
    const requestIsCurrent = (): boolean =>
      privateRequestIsCurrent(generation, vaultEpoch) &&
      cancelEpoch === downloadStartEpochRef.current &&
      downloadTransferRef.current?.id === transfer.id;
    try {
      const next = parseStatus(
        await client.ui({
          action: "cancel",
          transferId: transfer.id,
        }),
      );
      if (!requestIsCurrent()) return;
      statusRequestRef.current += 1;
      const boundaryChanged = applyPrivateBoundary(next);
      setStatus(next);
      if (
        boundaryChanged ||
        !requestIsCurrent()
      ) return;
      const cancelled: LocalDownload = {
        ...transfer,
        phase: "cancelled",
        controller: null,
        error: null,
      };
      downloadTransferRef.current = cancelled;
      setDownloadTransfer((current) =>
        current?.id === transfer.id ? cancelled : current
      );
    } catch (nextError) {
      if (!requestIsCurrent()) return;
      const pending: LocalDownload = {
        ...transfer,
        phase: "cleanup-pending",
        controller: null,
        error: errorMessage(nextError),
      };
      downloadTransferRef.current = pending;
      setDownloadTransfer((current) =>
        current?.id === transfer.id ? pending : current
      );
    }
  }

  async function openSelectedInSpreadsheet(): Promise<void> {
    if (!selectedEntry) return;
    const reviewedPath = selectedEntry.path;
    const generation = privateRequestGenerationRef.current;
    const vaultEpoch = captureVaultRequestEpoch(reviewedPath);
    const busyId = beginBusy(
      "Verifying and handing off to Spreadsheet",
      vaultEpoch,
    );
    try {
      await handoffFileToSpreadsheet(selectedEntry, {
        async readBinary(path) {
          const file = await client.readBinary(path);
          if (!privateRequestIsCurrent(generation, vaultEpoch)) {
            throw new DOMException(
              "Files authority changed",
              "AbortError",
            );
          }
          return file;
        },
        async accept(args, attachment) {
          if (!privateRequestIsCurrent(generation, vaultEpoch)) {
            throw new DOMException(
              "Files authority changed",
              "AbortError",
            );
          }
          await callToolWithAttachments(
            {
              target:
                "app:spreadsheet:background" as MsgBusEndpointId,
              name: "workbook_accept_file",
              arguments: args,
            },
            [attachment],
            { timeoutSeconds: 300 },
          );
        },
        async open() {
          if (!privateRequestIsCurrent(generation, vaultEpoch)) return;
          await openAppTile({
            appId: "spreadsheet",
            tileId: "spreadsheet",
            reuseExisting: true,
          });
        },
      });
      if (!privateRequestIsCurrent(generation, vaultEpoch)) return;
      setError(null);
    } catch (nextError) {
      if (privateRequestIsCurrent(generation, vaultEpoch)) {
        setError(errorMessage(nextError));
      }
    } finally {
      finishBusy(busyId);
    }
  }

  function confirmDiscardIfDirty(nextPath?: string): boolean {
    if (
      !dirtyRef.current ||
      !selectedRef.current ||
      selectedRef.current === nextPath
    ) {
      return true;
    }
    return window.confirm(
      "Discard your unsaved changes and open something else?",
    );
  }

  function treeRowElement(path: string): HTMLElement | null {
    const node = listRef.current;
    if (!node) return null;
    return [...node.querySelectorAll<HTMLElement>("[data-path]")]
      .find((candidate) => candidate.dataset.path === path) ?? null;
  }

  function openEntryMenu(
    entry: FilesTileEntry,
    anchor: Pick<DOMRect, "left" | "top" | "right" | "bottom">,
  ): void {
    setTreeFocusPath(entry.path);
    setEntryMenu({
      entry,
      anchor: {
        left: anchor.left,
        top: anchor.top,
        right: anchor.right,
        bottom: anchor.bottom,
      },
    });
  }

  function closeEntryMenu(restoreFocus = true): void {
    const path = entryMenu?.entry.path ?? null;
    if (restoreFocus && path) {
      treeRowElement(path)?.focus({ preventScroll: true });
    }
    setEntryMenu(null);
  }

  function runEntryMenuAction(action: () => void): void {
    closeEntryMenu(true);
    action();
  }

  function browserWidthBounds(): { min: number; max: number } {
    const available = workspaceWidth || workspaceRef.current?.clientWidth || 800;
    return {
      min: 180,
      max: Math.max(180, Math.min(420, available - 280)),
    };
  }

  function clampBrowserWidth(width: number): number {
    const bounds = browserWidthBounds();
    return Math.min(bounds.max, Math.max(bounds.min, Math.round(width)));
  }

  function resizeBrowserBy(delta: number): void {
    setBrowserWidth((current) =>
      clampBrowserWidth(clampBrowserWidth(current) + delta)
    );
  }

  function focusTreeRow(index: number): void {
    const row = treeRows[index];
    if (!row) return;
    setTreeFocusPath(row.entry.path);
    pendingTreeFocusRef.current = row.entry.path;
    const node = listRef.current;
    if (!node) return;
    scrollTreeRowIntoView(index, node);
  }

  function scrollTreeRowIntoView(
    index: number,
    node: HTMLElement,
  ): void {
    const top = index * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    const next = top < node.scrollTop
      ? top
      : bottom > node.scrollTop + node.clientHeight
        ? bottom - node.clientHeight
        : node.scrollTop;
    if (next === node.scrollTop) return;
    node.scrollTop = next;
    setScrollTop(next);
  }

  function moveListSelection(
    direction: "next" | "previous" | "first" | "last",
  ): void {
    if (treeRows.length === 0) return;
    const current = treeRows.findIndex(
      (row) => row.entry.path === treeFocusPath,
    );
    const index =
      direction === "first"
        ? 0
        : direction === "last"
          ? treeRows.length - 1
          : direction === "next"
            ? Math.min(
                treeRows.length - 1,
                current < 0 ? 0 : current + 1,
              )
            : Math.max(0, current < 0 ? 0 : current - 1);
    focusTreeRow(index);
  }

  function runErrorRecovery(kind: FilesErrorRecoveryKind): void {
    setError(null);
    if (kind === "unlock") {
      const current = lastStatusRef.current;
      if (current?.vault === "locked") {
        void unlockVault(current);
      } else {
        void refreshStatus();
      }
    } else if (kind === "restart-folder") {
      void loadFolder(folder.path, false, true);
    } else if (kind === "review-space") {
      listRef.current?.focus();
    } else if (kind === "reload") {
      window.location.reload();
    } else if (
      status?.vault === "ready" &&
      status.rotationRequired
    ) {
      vaultMigrationAttemptRef.current = null;
      void finishVaultMigration(true);
    } else {
      const authorityGeneration =
        authorityBoundaryGenerationRef.current;
      void refreshStatus().then((next) => {
        const reloadPath =
          authorityGeneration ===
              authorityBoundaryGenerationRef.current
            ? folderPathRef.current
            : "/Workspace";
        if (
          next !== null &&
          !dirtyRef.current &&
          filesPathCanOpen(reloadPath, next.vault)
        ) {
          void loadFolder(reloadPath, false);
        }
      });
    }
  }

  const markdownSelected =
    selectedEntry?.contentKind === "text" &&
    isMarkdownPath(selectedEntry.path);
  const spreadsheetSelected =
    selectedEntry?.type === "file" &&
    isSpreadsheet(selectedEntry.mediaType, selectedEntry.path);
  const selectedImageMediaType = selectedEntry
    ? filesImagePreviewMediaType(selectedEntry)
    : null;
  const selectedImageKey =
    selectedEntry?.etag && selectedImageMediaType
      ? `${selectedEntry.path}\n${selectedEntry.etag}`
      : null;
  const selectedImageTooLarge =
    selectedImageMediaType !== null &&
    selectedEntry?.byteLength !== null &&
    selectedEntry?.byteLength !== undefined &&
    selectedEntry.byteLength > FILES_IMAGE_PREVIEW_MAX_BYTES;
  const detachedResidentTransfers =
    status?.transfers.filter(
      (resident) =>
        !isTerminalTransferPhase(resident.phase) &&
        !transfers.some((local) => local.residentId === resident.id),
    ) ?? [];
  const visibleError =
    error !== null && !isFilesMessageBusLifecycleError(error)
      ? error
      : null;
  const errorRecovery = visibleError
    ? classifyFilesError(visibleError)
    : null;
  const folderCanOpen = filesPathCanOpen(
    folder.path,
    status?.vault ?? null,
  );
  const entryMenuTarget = entryMenu?.entry ?? null;
  const entryMenuTargetIsRoot = entryMenuTarget
    ? FILES_UI_ROOTS.some((root) => root.path === entryMenuTarget.path)
    : false;
  const entryMenuActions: readonly FilesEntryMenuAction[] = entryMenuTarget
    ? [
        ...(entryMenuTarget.type === "folder"
          ? [
              {
                label: "New text file",
                icon: <IoAddOutline aria-hidden="true" />,
                disabled:
                  Boolean(busy) ||
                  !filesPathCanOpen(
                    entryMenuTarget.path,
                    status?.vault ?? null,
                  ),
                onSelect: () =>
                  runEntryMenuAction(() =>
                    startCreate("file", entryMenuTarget.path)
                  ),
              },
              {
                label: "New folder",
                icon: <IoFolderOutline aria-hidden="true" />,
                disabled:
                  Boolean(busy) ||
                  !filesPathCanOpen(
                    entryMenuTarget.path,
                    status?.vault ?? null,
                  ),
                onSelect: () =>
                  runEntryMenuAction(() =>
                    startCreate("folder", entryMenuTarget.path)
                  ),
              },
              {
                label: "Upload files",
                icon: <IoCloudUploadOutline aria-hidden="true" />,
                disabled:
                  Boolean(busy) ||
                  !filesPathCanOpen(
                    entryMenuTarget.path,
                    status?.vault ?? null,
                  ),
                onSelect: () =>
                  runEntryMenuAction(() =>
                    stageFiles(entryMenuTarget.path)
                  ),
              },
            ]
          : []),
        ...(!entryMenuTargetIsRoot
          ? [
              {
                label: "Rename",
                icon: <IoPencilOutline aria-hidden="true" />,
                disabled: Boolean(busy),
                onSelect: () =>
                  runEntryMenuAction(() => startRename(entryMenuTarget)),
              },
              {
                label: `Delete ${entryMenuTarget.type}`,
                icon: <IoTrashOutline aria-hidden="true" />,
                danger: true,
                disabled: Boolean(busy),
                onSelect: () =>
                  runEntryMenuAction(() => setDeleteTarget(entryMenuTarget)),
              },
            ]
          : []),
      ]
    : [];
  const uploadReview = uploadDraft
    ? reviewStagedUploads(
        uploadDraft,
        transfers.length,
        status?.vault ?? null,
      )
    : null;
  const effectiveBrowserWidth = clampBrowserWidth(browserWidth);
  const navigationBlocked = navigationIsBlocked();

  return (
    <main className={cx("nt-app", "files-v2-app")}>
      <header className="files-v2-header">
        <button
          aria-controls="files-v2-browser"
          aria-expanded={!browserCollapsed}
          aria-label={browserCollapsed ? "Show file tree" : "Hide file tree"}
          className="nt-icon-button"
          onClick={() => setBrowserCollapsed((current) => !current)}
          ref={browserToggleRef}
          title={browserCollapsed ? "Show file tree" : "Hide file tree"}
          type="button"
        >
          <IoMenuOutline aria-hidden="true" />
        </button>
        <button
          aria-label="Home"
          className="nt-icon-button"
          disabled={folder.path === "/Workspace" || Boolean(busy)}
          onClick={() => {
            const workspace = rootEntry(FILES_UI_ROOTS[2]!);
            void selectEntry(workspace);
          }}
          type="button"
        >
          <IoHomeOutline aria-hidden="true" />
        </button>
        <nav aria-label="Current folder" className="files-v2-breadcrumb">
          {pathCrumbs(folder.path).slice(1).map((crumb) => (
            <button
              key={crumb.path}
              onClick={() => {
                if (navigationBlocked) return;
                const known = treeRows.find(
                  (row) => row.entry.path === crumb.path
                )?.entry;
                if (known) void selectEntry(known);
              }}
              type="button"
            >
              {crumb.name}
            </button>
          ))}
        </nav>
        <button
          aria-label="Refresh folder"
          className="nt-icon-button"
          disabled={Boolean(busy) || !folderCanOpen}
          onClick={() => {
            void loadFolder(folder.path, false);
          }}
          type="button"
        >
          <IoRefresh aria-hidden="true" />
        </button>
        <button
          className="nt-button nt-button--secondary files-v2-upload-button"
          disabled={Boolean(busy) || !folderCanOpen}
          onClick={() => stageFiles(folder.path)}
          type="button"
        >
          <IoCloudUploadOutline aria-hidden="true" />
          Upload
        </button>
        <input
          className="files-v2-visually-hidden"
          multiple
          onChange={(event) => {
            if (event.target.files) {
              appendStagedFiles(event.target.files);
            }
            event.target.value = "";
          }}
          ref={inputRef}
          type="file"
        />
        <div className="files-v2-header-actions">
          {currentRoot === "vault" && status?.vault !== "ready" ? (
            <VaultBadge status={status} />
          ) : null}
        </div>
      </header>

      <div
        aria-label="Files notifications"
        className="files-v2-notifications"
      >
        {visibleError ? (
          <div className="files-v2-banner files-v2-banner--error" role="alert">
            <IoWarningOutline aria-hidden="true" />
            <span>{visibleError}</span>
            {errorRecovery ? (
              <button
                className="nt-button nt-button--secondary"
                onClick={() => runErrorRecovery(errorRecovery.kind)}
                type="button"
              >
                {errorRecovery.label}
              </button>
            ) : null}
            <button
              aria-label="Dismiss error"
              className="nt-icon-button"
              onClick={() => setError(null)}
              type="button"
            >
              <IoClose aria-hidden="true" />
            </button>
          </div>
        ) : null}
        {visibleBusy ? (
          <div className="files-v2-progress" role="status">
            <span className="nt-spinner" aria-hidden="true" />
            {visibleBusy}
          </div>
        ) : null}
      </div>

      <div
        className={cx(
          "files-v2-workspace",
          browserCollapsed && "files-v2-workspace--browser-collapsed",
        )}
        ref={workspaceRef}
        style={{
          "--files-browser-width": `${effectiveBrowserWidth}px`,
        } as CSSProperties}
      >
          <section
            aria-label="File browser"
            className="files-v2-browser"
            hidden={browserCollapsed}
            id="files-v2-browser"
          >
            <div
              aria-busy={Boolean(busy)}
              aria-label="Files"
              className={cx(
                "files-v2-list",
                dragging && "files-v2-list--dragging",
              )}
              onDragEnter={(event) => {
                if (hasOsFileDrag(event.dataTransfer)) {
                  event.preventDefault();
                  setDragging(true);
                }
              }}
              onDragLeave={(event) => {
                const related = event.relatedTarget;
                if (
                  related instanceof Node &&
                  event.currentTarget.contains(related)
                ) {
                  return;
                }
                setDragging(false);
                setDropTarget(null);
              }}
              onDragOver={(event) => {
                if (hasOsFileDrag(event.dataTransfer)) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                  setDragging(true);
                }
              }}
              onDrop={(event: DragEvent<HTMLDivElement>) => {
                if (!hasOsFileDrag(event.dataTransfer)) return;
                event.preventDefault();
                const files = Array.from(event.dataTransfer.files);
                setDragging(false);
                stageFiles(folder.path, files);
              }}
              onKeyDown={(event) => {
                if (
                  event.target instanceof HTMLElement &&
                  event.target.closest("button,input,textarea,select")
                ) {
                  return;
                }
                if (
                  (event.metaKey || event.ctrlKey) &&
                  event.key.toLocaleLowerCase() === "x" &&
                  focusedEntry &&
                  !FILES_UI_ROOTS.some(
                    (root) => root.path === focusedEntry.path,
                  )
                ) {
                  event.preventDefault();
                  setKeyboardMovePath(focusedEntry.path);
                } else if (
                  (event.metaKey || event.ctrlKey) &&
                  event.key.toLocaleLowerCase() === "v" &&
                  focusedEntry?.type === "folder" &&
                  keyboardMovePath
                ) {
                  event.preventDefault();
                  const source = keyboardMovePath;
                  setKeyboardMovePath(null);
                  requestMoveToFolder(source, focusedEntry);
                } else if (event.key === "Escape" && keyboardMovePath) {
                  event.preventDefault();
                  setKeyboardMovePath(null);
                } else if (event.key === "ArrowDown") {
                  event.preventDefault();
                  moveListSelection("next");
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  moveListSelection("previous");
                } else if (event.key === "Home") {
                  event.preventDefault();
                  moveListSelection("first");
                } else if (event.key === "End") {
                  event.preventDefault();
                  moveListSelection("last");
                } else if (
                  event.key === "Enter" &&
                  focusedEntry
                ) {
                  event.preventDefault();
                  void selectEntry(focusedEntry);
                } else if (
                  event.key === "ArrowRight" &&
                  focusedEntry?.type === "folder"
                ) {
                  event.preventDefault();
                  if (!expandedPaths.has(focusedEntry.path)) {
                    void toggleTreeFolder(focusedEntry);
                  } else {
                    const index = treeRows.findIndex(
                      (row) => row.entry.path === focusedEntry.path,
                    );
                    const child = treeRows[index + 1];
                    if (child && child.level === (
                      treeRows[index]?.level ?? 0
                    ) + 1) {
                      focusTreeRow(index + 1);
                    }
                  }
                } else if (
                  event.key === "ArrowLeft" &&
                  focusedEntry?.type === "folder" &&
                  expandedPaths.has(focusedEntry.path)
                ) {
                  event.preventDefault();
                  void toggleTreeFolder(focusedEntry);
                } else if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  const parent = focusedEntry
                    ? parentPath(focusedEntry.path)
                    : "/";
                  const parentIndex = treeRows.findIndex(
                    (row) => row.entry.path === parent,
                  );
                  if (parentIndex >= 0) focusTreeRow(parentIndex);
                } else if (event.key === "F2" && focusedEntry && !busy) {
                  event.preventDefault();
                  startRename(focusedEntry);
                } else if (
                  event.key === "F10" &&
                  event.shiftKey &&
                  focusedEntry
                ) {
                  event.preventDefault();
                  const rect = treeRowElement(focusedEntry.path)
                    ?.getBoundingClientRect();
                  if (rect) openEntryMenu(focusedEntry, rect);
                } else if (
                  event.key === "Delete" &&
                  focusedEntry &&
                  !busy &&
                  !FILES_UI_ROOTS.some(
                    (root) => root.path === focusedEntry.path,
                  )
                ) {
                  event.preventDefault();
                  setDeleteTarget(focusedEntry);
                }
              }}
              onScroll={(event: UIEvent<HTMLDivElement>) => {
                setScrollTop(event.currentTarget.scrollTop);
                if (entryMenu) {
                  setEntryMenu(null);
                  event.currentTarget.focus({ preventScroll: true });
                }
              }}
              ref={listRef}
              role="tree"
              tabIndex={-1}
            >
              {dragging ? (
                <div className="files-v2-drop">
                  <IoCloudUploadOutline aria-hidden="true" />
                  Drop files to upload
                </div>
              ) : null}
              <div style={{ height: virtual.before }} />
              {virtual.items.map((row) => {
                const entry = row.entry;
                const expanded =
                  entry.type === "folder" &&
                  expandedPaths.has(entry.path);
                return (
                  <div
                    aria-expanded={
                      entry.type === "folder" ? expanded : undefined
                    }
                    aria-level={row.level}
                    aria-label={entry.name}
                    aria-posinset={row.position}
                    aria-selected={selected === entry.path}
                    aria-setsize={row.setSize}
                    className={cx(
                      "files-v2-row",
                      row.isRoot && "files-v2-row--root",
                      folder.path === entry.path && "files-v2-row--current",
                      selected === entry.path && "files-v2-row--selected",
                      dropTarget === entry.path && "files-v2-row--drop-target",
                    )}
                    data-path={entry.path}
                    draggable={!row.isRoot && !busy}
                    key={entry.path}
                    onClick={() => void selectEntry(entry)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      openEntryMenu(entry, {
                        left: event.clientX,
                        right: event.clientX,
                        top: event.clientY,
                        bottom: event.clientY,
                      });
                    }}
                    onDragEnd={() => {
                      internalDragRef.current = null;
                      setDropTarget(null);
                    }}
                    onDragLeave={() => {
                      setDropTarget((current) =>
                        current === entry.path ? null : current
                      );
                    }}
                    onDragOver={(event) => {
                      const internal = internalDragRef.current;
                      const osFiles = hasOsFileDrag(event.dataTransfer);
                      const canAcceptInternal = internal
                        ? !busy && filesDropIntent(
                            internal.path,
                            entry,
                            status?.vault ?? null,
                          ).ok
                        : false;
                      const canAcceptFiles =
                        !busy &&
                        osFiles &&
                        entry.type === "folder" &&
                        filesPathCanOpen(entry.path, status?.vault ?? null);
                      if (!canAcceptInternal && !canAcceptFiles) return;
                      event.preventDefault();
                      event.stopPropagation();
                      event.dataTransfer.dropEffect =
                        canAcceptInternal ? "move" : "copy";
                      setDropTarget(entry.path);
                    }}
                    onDragStart={(event) => {
                      if (row.isRoot) {
                        event.preventDefault();
                        return;
                      }
                      const token = crypto.randomUUID();
                      internalDragRef.current = {
                        path: entry.path,
                        token,
                      };
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData(
                        FILES_INTERNAL_DRAG_TYPE,
                        token,
                      );
                    }}
                    onDrop={(event) => {
                      if (entry.type !== "folder") return;
                      event.preventDefault();
                      event.stopPropagation();
                      const files = Array.from(event.dataTransfer.files);
                      const liveDrag = internalDragRef.current;
                      const source = authorizedFilesInternalDragSource(
                        liveDrag,
                        event.dataTransfer.getData(
                          FILES_INTERNAL_DRAG_TYPE,
                        ),
                      );
                      internalDragRef.current = null;
                      setDragging(false);
                      setDropTarget(null);
                      if (source) {
                        requestMoveToFolder(source, entry);
                      } else if (files.length > 0) {
                        stageFiles(entry.path, files);
                      }
                    }}
                    role="treeitem"
                    style={{
                      height: ROW_HEIGHT,
                    }}
                    tabIndex={
                      treeFocusPath === entry.path
                        ? 0
                        : -1
                    }
                  >
                    <span
                      aria-hidden="true"
                      className="files-v2-tree-guides"
                    >
                      {row.ancestorContinues.map((continues, index) => (
                        <span
                          className={cx(
                            "files-v2-tree-guide",
                            continues && "files-v2-tree-guide--continues",
                          )}
                          key={`${entry.path}:ancestor:${index}`}
                        />
                      ))}
                      {!row.isRoot ? (
                        <span
                          className={cx(
                            "files-v2-tree-guide",
                            "files-v2-tree-guide--branch",
                            !row.isLastSibling &&
                              "files-v2-tree-guide--continues",
                          )}
                        />
                      ) : null}
                    </span>
                    {entry.type === "folder" ? (
                      <button
                        aria-label={`${expanded ? "Collapse" : "Expand"} ${entry.name}`}
                        className="files-v2-tree-toggle"
                        onClick={(event) => {
                          event.stopPropagation();
                          setTreeFocusPath(entry.path);
                          event.currentTarget
                            .closest<HTMLElement>('[role="treeitem"]')
                            ?.focus();
                          void toggleTreeFolder(entry);
                        }}
                        onDragStart={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        tabIndex={-1}
                        type="button"
                      >
                        {expanded ? (
                          <IoRemoveOutline aria-hidden="true" />
                        ) : (
                          <IoAddOutline aria-hidden="true" />
                        )}
                      </button>
                    ) : (
                      <span className="files-v2-tree-spacer" />
                    )}
                    {row.root === "shared" && row.isRoot ? (
                      <IoLinkOutline aria-hidden="true" />
                    ) : row.root === "vault" && row.isRoot ? (
                      <IoShieldCheckmarkOutline aria-hidden="true" />
                    ) : entry.type === "folder" ? (
                      <IoFolderOutline aria-hidden="true" />
                    ) : entry.contentKind === "text" ? (
                      <IoDocumentTextOutline aria-hidden="true" />
                    ) : (
                      <IoDocumentOutline aria-hidden="true" />
                    )}
                    <span className="files-v2-row-name">{entry.name}</span>
                    {treeLoading.has(entry.path) ? (
                      <span
                        aria-label={`Loading ${entry.name}`}
                        className="nt-spinner files-v2-row-spinner"
                        role="status"
                      />
                    ) : (
                      <button
                        aria-expanded={entryMenuTarget?.path === entry.path}
                        aria-haspopup="menu"
                        aria-label={`Actions for ${entry.name}`}
                        className="nt-icon-button files-v2-row-menu-button"
                        data-menu-for={entry.path}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          openEntryMenu(
                            entry,
                            event.currentTarget.getBoundingClientRect(),
                          );
                        }}
                        onDragStart={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        tabIndex={-1}
                        type="button"
                      >
                        <IoEllipsisVerticalOutline aria-hidden="true" />
                      </button>
                    )}
                  </div>
                );
              })}
              <div style={{ height: virtual.after }} />
              <span
                aria-live="polite"
                className="files-v2-visually-hidden"
              >
                {keyboardMovePath
                  ? `${leafName(keyboardMovePath)} is ready to move. Focus a folder and press Control or Command plus V.`
                  : ""}
              </span>
            </div>
            {folder.hasMore ? (
              <footer className="files-v2-list-footer">
                <button
                  className="nt-button nt-button--secondary"
                  disabled={Boolean(busy)}
                  onClick={() => void loadFolder(folder.path, true)}
                  type="button"
                >
                  Show more files
                </button>
              </footer>
            ) : null}
          </section>

          <div
            aria-controls="files-v2-browser"
            aria-label="Resize file tree"
            aria-orientation="vertical"
            aria-valuemax={browserWidthBounds().max}
            aria-valuemin={browserWidthBounds().min}
            aria-valuenow={effectiveBrowserWidth}
            className="files-v2-browser-resizer"
            hidden={browserCollapsed}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                resizeBrowserBy(-16);
              } else if (event.key === "ArrowRight") {
                event.preventDefault();
                resizeBrowserBy(16);
              } else if (event.key === "Home") {
                event.preventDefault();
                setBrowserWidth(browserWidthBounds().min);
              } else if (event.key === "End") {
                event.preventDefault();
                setBrowserWidth(browserWidthBounds().max);
              } else if (event.key === "Enter") {
                event.preventDefault();
                browserToggleRef.current?.focus();
                setBrowserCollapsed(true);
              }
            }}
            onLostPointerCapture={() => {
              resizeDragRef.current = null;
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              resizeDragRef.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startWidth: effectiveBrowserWidth,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
              event.preventDefault();
            }}
            onPointerMove={(event) => {
              const drag = resizeDragRef.current;
              if (!drag || drag.pointerId !== event.pointerId) return;
              setBrowserWidth(
                clampBrowserWidth(
                  drag.startWidth + event.clientX - drag.startX,
                ),
              );
            }}
            onPointerUp={(event) => {
              const drag = resizeDragRef.current;
              if (!drag || drag.pointerId !== event.pointerId) return;
              resizeDragRef.current = null;
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
            }}
            role="separator"
            tabIndex={0}
          />

          <section aria-label="File details and editor" className="files-v2-detail">
            {currentRoot === "vault" && status?.vault !== "ready" ? (
              status?.vault === "uninitialized" ? (
                <VaultGate
                  icon={<IoKeyOutline aria-hidden="true" />}
                  title="Set up Vault"
                  body="Files placed in Vault are protected automatically."
                  action="Get started"
                  disabled={Boolean(busy)}
                  onAction={() => void vaultAction("initialize")}
                />
              ) : status?.vault === "unrecoverable" ? (
                <VaultGate
                  icon={<IoWarningOutline aria-hidden="true" />}
                  title="Vault cannot be opened"
                  body={
                    status.reason ??
                    "The information needed to open Vault is unavailable."
                  }
                  action="Refresh status"
                  disabled={Boolean(busy)}
                  onAction={() => void refreshStatus()}
                />
              ) : (
                <VaultGate
                  icon={<IoKeyOutline aria-hidden="true" />}
                  title={
                    status?.vault === "rotating"
                      ? "Updating Vault"
                      : "Open Vault"
                  }
                  body={
                    status?.vault === "rotating"
                      ? "This should only take a moment."
                      : "Vault needs to finish opening."
                  }
                  action={
                    status?.vault === "locked"
                      ? "Open Vault"
                      : "Try again"
                  }
                  disabled={Boolean(busy)}
                  onAction={() => {
                    if (status?.vault === "locked") {
                      void unlockVault(status);
                    } else {
                      void refreshStatus();
                    }
                  }}
                />
              )
            ) : selectedEntry ? (
              <>
                <header className="files-v2-detail-header">
                  <div>
                    <h2>{selectedEntry.name}</h2>
                    <p>
                      {selectedEntry.contentKind ?? selectedEntry.type}
                      {selectedEntry.byteLength !== null
                        ? ` · ${formatBytes(selectedEntry.byteLength)}`
                        : ""}
                      {dirty ? " · Unsaved changes" : ""}
                    </p>
                  </div>
                  <div className="files-v2-detail-actions">
                    {selectedEntry.type === "file" &&
                    selectedEntry.contentKind === "text" ? (
                      <button
                        className="nt-button nt-button--primary"
                        disabled={
                          !dirty ||
                          Boolean(busy) ||
                          editorLoadingPath === selectedEntry.path
                        }
                        onClick={() => void save()}
                        type="button"
                      >
                        <IoSaveOutline aria-hidden="true" />
                        Save
                      </button>
                    ) : null}
                    {markdownSelected ? (
                      <button
                        className="nt-button nt-button--secondary"
                        onClick={() => setMarkdownPreview((value) => !value)}
                        type="button"
                      >
                        {markdownPreview ? "Edit" : "Preview Markdown"}
                      </button>
                    ) : null}
                    {spreadsheetSelected && spreadsheetInstalled ? (
                      <button
                        className="nt-button nt-button--secondary"
                        onClick={() => void openSelectedInSpreadsheet()}
                        type="button"
                      >
                        Open in Spreadsheet
                      </button>
                    ) : null}
                    {selectedEntry.type === "file" ? (
                      <>
                        <button
                          className="nt-button nt-button--secondary"
                          disabled={Boolean(busy)}
                          onClick={() => void downloadSelected()}
                          type="button"
                        >
                          <IoCloudDownloadOutline aria-hidden="true" />
                          Download
                        </button>
                        {filesRootKind(selectedEntry.path) === "shared" ? (
                          <button
                            className="nt-button nt-button--secondary"
                            disabled={!selectedEntry.publicUrl}
                            onClick={() => void copyPublicLink(selectedEntry)}
                            title={
                              selectedEntry.publicUrl
                                ? "Copy public link"
                                : "The link is still being prepared"
                            }
                            type="button"
                          >
                            {copiedLinkPath === selectedEntry.path ? (
                              <IoCheckmark aria-hidden="true" />
                            ) : (
                              <IoLinkOutline aria-hidden="true" />
                            )}
                            {copiedLinkPath === selectedEntry.path
                              ? "Copied"
                              : selectedEntry.publicUrl
                                ? "Get link"
                                : "Preparing link…"}
                          </button>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                </header>
                {conflict ? (
                  <div className="files-v2-conflict" role="alert">
                    <IoWarningOutline aria-hidden="true" />
                    <div>
                      <strong>This file changed somewhere else.</strong>
                      <p>{conflict.message}</p>
                      <div className="files-v2-inline-actions">
                        <button
                          className="nt-button nt-button--secondary"
                          onClick={() => void reloadConflict()}
                          type="button"
                        >
                          Reload newer file
                        </button>
                        <button
                          className="nt-button nt-button--secondary"
                          onClick={() => void save("copy")}
                          type="button"
                        >
                          Save local buffer as copy
                        </button>
                        <button
                          className="nt-button nt-button--danger"
                          onClick={() => void save("overwrite")}
                          type="button"
                        >
                          Confirm overwrite
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
                {selectedEntry.type === "folder" ? (
                  <div className="files-v2-folder-detail">
                    <IoFolderOpenOutline aria-hidden="true" />
                    <h3>{selectedEntry.name}</h3>
                    <p>{folderDescription(selectedEntry.path)}</p>
                  </div>
                ) : selectedEntry.contentKind === "text" ? (
                  markdownPreview && markdownSelected ? (
                    <div className="files-v2-markdown">
                      <MarkdownPreview
                        path={selectedEntry.path}
                        source={content}
                      />
                    </div>
                  ) : (
                    <textarea
                      aria-label={`Edit ${selectedEntry.name}`}
                      className="files-v2-editor"
                      disabled={
                        navigationBlocked ||
                        editorLoadingPath === selectedEntry.path
                      }
                      onChange={(event) => {
                        const next = event.target.value;
                        dirtyRef.current = next !== savedContent;
                        setContent(next);
                      }}
                      placeholder={
                        editorLoadingPath === selectedEntry.path
                          ? "Opening file…"
                          : undefined
                      }
                      spellCheck={false}
                      value={content}
                    />
                  )
                ) : selectedImageMediaType &&
                  selectedImageKey &&
                  !selectedImageTooLarge ? (
                  imagePreview?.key === selectedImageKey &&
                  imagePreview.phase === "ready" ? (
                    <div className="files-v2-image-preview">
                      <img
                        alt={selectedEntry.name}
                        decoding="async"
                        draggable={false}
                        onError={() => {
                          const failedUrl = imagePreview.url;
                          if (imageUrlRef.current !== failedUrl) return;
                          blobUrlsRef.current?.revoke(failedUrl);
                          imageUrlRef.current = null;
                          setImagePreview((current) =>
                            current?.phase === "ready" &&
                              current.key === selectedImageKey &&
                              current.url === failedUrl
                              ? {
                                  key: selectedImageKey,
                                  phase: "error",
                                  url: null,
                                  error:
                                    "This image could not be decoded safely.",
                                }
                              : current
                          );
                        }}
                        src={imagePreview.url}
                      />
                    </div>
                  ) : imagePreview?.key === selectedImageKey &&
                    imagePreview.phase === "error" ? (
                    <div className="files-v2-binary-detail">
                      <IoImageOutline aria-hidden="true" />
                      <h3>Preview unavailable</h3>
                      <p>{imagePreview.error} You can still download it.</p>
                    </div>
                  ) : (
                    <div className="files-v2-binary-detail" role="status">
                      <span className="nt-spinner" aria-hidden="true" />
                      <h3>Opening image</h3>
                    </div>
                  )
                ) : (
                  <div className="files-v2-binary-detail">
                    {selectedImageTooLarge ? (
                      <IoImageOutline aria-hidden="true" />
                    ) : (
                      <IoDocumentOutline aria-hidden="true" />
                    )}
                    <h3>
                      {selectedImageTooLarge
                        ? "Image is too large to preview"
                        : "Download to open"}
                    </h3>
                    <p>
                      {selectedImageTooLarge
                        ? "Download it to view the original image."
                        : "This file opens with an app on your device."}
                    </p>
                  </div>
                )}
              </>
            ) : (
              <div className="files-v2-detail-empty">
                <IoDocumentOutline aria-hidden="true" />
                <h2>Select a file</h2>
                <p>Choose a file or folder on the left.</p>
              </div>
            )}
          </section>
        </div>

      {!transferToastHidden &&
      (transfers.length > 0 ||
        detachedResidentTransfers.length > 0 ||
        downloadTransfer !== null) ? (
        <aside aria-label="File transfers" className="files-v2-transfers">
          <header>
            <strong>Transfers</strong>
            <button
              aria-label="Dismiss transfers"
              className="nt-icon-button"
              onClick={() => {
                setTransferToastHidden(true);
                replaceTransfers((current) =>
                  current.filter(
                    (transfer) =>
                      !isTerminalTransferPhase(transfer.phase),
                  )
                );
                setDownloadTransfer((current) =>
                  current && isTerminalTransferPhase(current.phase)
                    ? null
                    : current
                );
              }}
              type="button"
            >
              <IoClose aria-hidden="true" />
            </button>
          </header>
          {downloadTransfer ? (
            <div
              className="files-v2-transfer"
              key={`download:${downloadTransfer.id}`}
            >
              <div>
                <strong>{downloadTransfer.label}</strong>
                <span>{transferPhaseLabel(downloadTransfer.phase)}</span>
              </div>
              <progress
                max={Math.max(downloadTransfer.totalBytes, 1)}
                value={Math.min(
                  downloadTransfer.processedBytes,
                  downloadTransfer.totalBytes,
                )}
              />
              {downloadTransfer.error ? (
                <p>{downloadTransfer.error}</p>
              ) : null}
              {downloadTransfer.controller ? (
                <div className="files-v2-inline-actions">
                  <button
                    className="nt-button nt-button--secondary"
                    onClick={() => void cancelDownload()}
                    type="button"
                  >
                    Cancel download
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          {transfers.map((transfer) => (
            <div className="files-v2-transfer" key={transfer.id}>
              <div>
                <strong>{leafName(transfer.path)}</strong>
                <span>{transferPhaseLabel(transfer.phase)}</span>
              </div>
              <progress
                max={Math.max(transfer.file.size, 1)}
                value={Math.min(transfer.processedBytes, transfer.file.size)}
              />
              {transfer.error ? <p>{transfer.error}</p> : null}
              <div className="files-v2-inline-actions">
                {transfer.controller ? (
                  <button
                    className="nt-button nt-button--secondary"
                    onClick={() => void cancelLocalTransfer(transfer)}
                    type="button"
                  >
                    Cancel
                  </button>
                ) : null}
                {transfer.phase === "conflicted" ? (
                  <>
                    <button
                      className="nt-button nt-button--secondary"
                      onClick={() =>
                        void uploadConflictedTransferAsCopy(transfer)
                      }
                      type="button"
                    >
                      Upload as copy
                    </button>
                    <button
                      className="nt-button nt-button--secondary"
                      onClick={() => void cancelLocalTransfer(transfer)}
                      type="button"
                    >
                      Cancel upload
                    </button>
                  </>
                ) : null}
                {transfer.phase === "cancelled" ||
                (transfer.phase === "failed" &&
                  isFilesAmbiguousTransferFailure(transfer.error)) ? (
                  <button
                    className="nt-button nt-button--secondary"
                    onClick={() => void retryLocalTransfer(transfer)}
                    type="button"
                  >
                    <IoReloadOutline aria-hidden="true" />
                    Retry
                  </button>
                ) : null}
              </div>
            </div>
          ))}
          {detachedResidentTransfers.map((transfer) => (
            <div className="files-v2-transfer" key={`resident:${transfer.id}`}>
              <div>
                <strong>{transfer.label}</strong>
                <span>{transferPhaseLabel(transfer.phase)}</span>
              </div>
              <progress
                max={Math.max(transfer.totalBytes, 1)}
                value={Math.min(
                  transfer.processedBytes,
                  transfer.totalBytes,
                )}
              />
              {transfer.error ? <p>{transfer.error}</p> : null}
              <div className="files-v2-inline-actions">
                {!isTerminalTransferPhase(transfer.phase) ? (
                  <button
                    className="nt-button nt-button--secondary"
                    onClick={() =>
                      void client
                        .ui({
                          action: "cancel",
                          transferId: transfer.id,
                        })
                        .then(() => refreshStatus())
                        .catch((nextError) =>
                          setError(errorMessage(nextError))
                        )
                    }
                    type="button"
                  >
                    Cancel
                  </button>
                ) : null}
                {transfer.phase === "failed" &&
                isFilesAmbiguousTransferFailure(transfer.error) ? (
                  <button
                    className="nt-button nt-button--secondary"
                    onClick={() =>
                      void client
                        .ui({
                          action: "retry",
                          transferId: transfer.id,
                        })
                        .then(() => refreshStatus())
                        .catch((nextError) =>
                          setError(errorMessage(nextError))
                        )
                    }
                    type="button"
                  >
                    <IoReloadOutline aria-hidden="true" />
                    Try again
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </aside>
      ) : null}

      {entryMenu ? (
        <FilesEntryMenu
          actions={entryMenuActions}
          anchor={entryMenu.anchor}
          entryName={entryMenu.entry.name}
          onClose={() => closeEntryMenu(true)}
        />
      ) : null}

      {createDraft ? (
        <Dialog
          actions={
            <>
              <button
                className="nt-button nt-button--secondary"
                disabled={navigationBlocked}
                onClick={() => setCreateDraft(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="nt-button nt-button--primary"
                disabled={Boolean(busy)}
                onClick={() => void createEntry()}
                type="button"
              >
                Create {createDraft.kind}
              </button>
            </>
          }
          closeDisabled={navigationBlocked}
          initialFocusSelector="[data-files-dialog-initial]"
          onClose={() => setCreateDraft(null)}
          title={`New ${createDraft.kind}`}
        >
          <p className="files-v2-dialog-destination">
            In <code>{createDraft.parentPath}</code>
          </p>
          <label className="nt-field">
            <span className="nt-label">Name</span>
            <input
              aria-describedby={
                createDraft.error ? "files-create-error" : undefined
              }
              className="nt-input"
              data-files-dialog-initial
              disabled={navigationBlocked}
              onChange={(event) =>
                setCreateDraft((current) =>
                  current
                    ? { ...current, name: event.target.value, error: null }
                    : null
                )
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void createEntry();
                }
              }}
              spellCheck={false}
              value={createDraft.name}
            />
          </label>
          {createDraft.error ? (
            <p id="files-create-error" role="alert">
              {createDraft.error}
            </p>
          ) : null}
        </Dialog>
      ) : null}

      {uploadDraft && uploadReview ? (
        <Dialog
          actions={
            <>
              <button
                className="nt-button nt-button--secondary"
                onClick={() => setUploadDraft(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="nt-button nt-button--primary"
                disabled={
                  Boolean(busy) || uploadReview.accepted.length === 0
                }
                onClick={queueStagedFiles}
                type="button"
              >
                Upload {uploadReview.accepted.length || ""}
              </button>
            </>
          }
          initialFocusSelector="[data-files-dialog-initial]"
          onClose={() => setUploadDraft(null)}
          title="Upload files"
        >
          <div className="files-v2-upload-destination">
            <strong>Destination</strong>
            <code>{uploadDraft.destination}</code>
            <span>{filesPathPolicy(uploadDraft.destination)}</span>
          </div>
          <div
            className="files-v2-upload-dropzone"
            data-files-dialog-initial
            onDragOver={(event) => {
              if (!hasOsFileDrag(event.dataTransfer)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
            }}
            onDrop={(event) => {
              if (!hasOsFileDrag(event.dataTransfer)) return;
              event.preventDefault();
              event.stopPropagation();
              const files = Array.from(event.dataTransfer.files);
              appendStagedFiles(files);
            }}
            role="group"
            tabIndex={0}
          >
            <IoCloudUploadOutline aria-hidden="true" />
            <span>Drop multiple files here</span>
            <button
              className="nt-button nt-button--secondary"
              onClick={() => inputRef.current?.click()}
              type="button"
            >
              Choose files
            </button>
          </div>
          {uploadReview.items.length > 0 ? (
            <ul className="files-v2-upload-review">
              {uploadReview.items.map((item) => (
                <li key={item.source.id}>
                  <IoDocumentOutline aria-hidden="true" />
                  <span>
                    <strong>{item.source.file.name || "Unnamed file"}</strong>
                    <small>
                      {item.error ?? formatBytes(item.source.file.size)}
                    </small>
                  </span>
                  <button
                    aria-label={`Remove ${item.source.file.name || "file"}`}
                    className="nt-icon-button"
                    onClick={() =>
                      setUploadDraft((current) =>
                        current
                          ? {
                              ...current,
                              items: current.items.filter(
                                (candidate) =>
                                  candidate.id !== item.source.id,
                              ),
                            }
                          : null
                      )
                    }
                    type="button"
                  >
                    <IoClose aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {uploadDraft.truncated > 0 ? (
            <p className="files-v2-upload-limit" role="alert">
              {uploadDraft.truncated} additional file{
                uploadDraft.truncated === 1 ? " was" : "s were"
              } not added because each review is limited to {
                MAX_VISIBLE_TRANSFERS
              } files.
            </p>
          ) : null}
          <p className="files-v2-upload-summary" role="status">
            {uploadReview.accepted.length} ready · {formatBytes(
              uploadReview.acceptedBytes,
            )}
          </p>
        </Dialog>
      ) : null}

      {pendingMove ? (
        <Dialog
          actions={
            <>
              <button
                className="nt-button nt-button--secondary"
                onClick={() => setPendingMove(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="nt-button nt-button--primary"
                disabled={Boolean(busy)}
                onClick={() => void performMove(pendingMove)}
                type="button"
              >
                Move and change storage
              </button>
            </>
          }
          onClose={() => setPendingMove(null)}
          title="Change storage policy?"
        >
          <p>
            Moving <strong>{leafName(pendingMove.sourcePath)}</strong> from
            {` ${filesRootLabel(pendingMove.sourceRoot)} to ${filesRootLabel(pendingMove.targetRoot)} `}
            changes how it is stored.
          </p>
          <p>
            {filesRootPolicy(pendingMove.sourceRoot)} {filesRootPolicy(
              pendingMove.targetRoot,
            )}
          </p>
        </Dialog>
      ) : null}

      {renameDraft ? (
        <Dialog
          actions={
            <>
              <button
                className="nt-button nt-button--secondary"
                disabled={navigationBlocked}
                onClick={closeRename}
                type="button"
              >
                Cancel
              </button>
              <button
                className="nt-button nt-button--primary"
                disabled={Boolean(busy)}
                onClick={() => void renameEntry()}
                type="button"
              >
                Rename
              </button>
            </>
          }
          closeDisabled={navigationBlocked}
          initialFocusSelector="[data-files-dialog-initial]"
          onClose={closeRename}
          title={`Rename ${renameDraft.target.name}`}
        >
          <label className="nt-field">
            <span className="nt-label">Name</span>
            <input
              aria-describedby={
                renameDraft.error ? "files-rename-error" : undefined
              }
              className="nt-input"
              data-files-dialog-initial
              disabled={navigationBlocked}
              onChange={(event) => {
                setRenameDraft((current) =>
                  current
                    ? { ...current, name: event.target.value, error: null }
                    : null
                );
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void renameEntry();
                }
              }}
              spellCheck={false}
              value={renameDraft.name}
            />
          </label>
          {renameDraft.error ? (
            <p id="files-rename-error" role="alert">
              {renameDraft.error}
            </p>
          ) : null}
        </Dialog>
      ) : null}

      {deleteTarget ? (
        <Dialog
          actions={
            <>
              <button
                className="nt-button nt-button--secondary"
                disabled={navigationBlocked}
                onClick={() => setDeleteTarget(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="nt-button nt-button--danger"
                disabled={Boolean(busy)}
                onClick={() => void removeEntry()}
                type="button"
              >
                Delete {deleteTarget.type}
              </button>
            </>
          }
          closeDisabled={navigationBlocked}
          onClose={() => setDeleteTarget(null)}
          title={`Delete ${deleteTarget.name}?`}
        >
          <p>
            {filesRootKind(deleteTarget.path) === "shared"
              ? "The public link will stop working when this item is deleted."
              : "This item will be removed from Files."}
          </p>
        </Dialog>
      ) : null}
    </main>
  );
}

function VaultBadge({ status }: { status: FilesTileStatus | null }) {
  const state = status?.vault ?? "loading";
  return (
    <span className={cx("files-v2-vault-badge", `is-${state}`)}>
      {state === "unrecoverable" ? (
        <IoWarningOutline aria-hidden="true" />
      ) : (
        <IoShieldCheckmarkOutline aria-hidden="true" />
      )}
      {state === "uninitialized"
        ? "Setup needed"
        : state === "ready"
          ? "Private"
          : state === "rotating"
            ? "Updating"
            : state === "unrecoverable"
              ? "Needs attention"
              : state === "locked"
                ? "Starting"
                : "Opening"}
    </span>
  );
}

function VaultGate({
  icon,
  title,
  body,
  action,
  disabled,
  onAction,
  footer,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action: string;
  disabled: boolean;
  onAction(): void;
  footer?: React.ReactNode;
}) {
  return (
    <section className="files-v2-gate">
      <div className="files-v2-gate-icon">{icon}</div>
      <h2>{title}</h2>
      <p>{body}</p>
      <button
        className="nt-button nt-button--primary"
        disabled={disabled}
        onClick={onAction}
        type="button"
      >
        {action}
      </button>
      {footer}
    </section>
  );
}

export type FilesPublicUsagePressure = Readonly<{
  key:
    | "entries"
    | "committedBytes"
    | "stagedBytes"
    | "pendingStages"
    | "generalReceipts"
    | "revocationLanes";
  label: string;
  used: string;
  limit: string;
  basisPoints: number;
  rolling: boolean;
}>;

export function derivePublicUsagePressure(
  usage: FilesTilePublicUsage,
): FilesPublicUsagePressure {
  const current = usage.current;
  const limits = usage.effectiveLimits;
  const candidates: Omit<FilesPublicUsagePressure, "basisPoints">[] = [
    {
      key: "entries",
      label: "Occupied lifecycle slots",
      used: (
        BigInt(current.occupiedEntrySlots) +
        BigInt(current.reservedEntrySlots)
      ).toString(),
      limit: limits.entries,
      rolling: true,
    },
    {
      key: "committedBytes",
      label: "Committed public bytes",
      used: (
        BigInt(current.committedBodyBytes) +
        BigInt(current.reservedCommittedBodyBytes)
      ).toString(),
      limit: limits.committedBytes,
      rolling: false,
    },
    {
      key: "stagedBytes",
      label: "Staged and reserved bytes",
      used: (
        BigInt(current.acceptedStagedBytes) +
        BigInt(current.reservedStagedBytes)
      ).toString(),
      limit: limits.stagedBytes,
      rolling: false,
    },
    {
      key: "pendingStages",
      label: "Active public stages",
      used: current.activeStages,
      limit: limits.pendingStages,
      rolling: false,
    },
    {
      key: "generalReceipts",
      label: "General receipt lanes",
      used: (
        BigInt(current.generalReceiptLanes) +
        BigInt(current.reservedGeneralReceiptLanes)
      ).toString(),
      limit: limits.generalReceipts,
      rolling: true,
    },
    {
      key: "revocationLanes",
      label: "Revocation lanes",
      used: (
        BigInt(current.reservedRevocationLanes) +
        BigInt(current.filledRevocationLanes)
      ).toString(),
      limit: limits.revocationLanes,
      rolling: true,
    },
  ];
  let limiting = candidates[0]!;
  for (const candidate of candidates.slice(1)) {
    const candidateLimit = BigInt(candidate.limit);
    const limitingLimit = BigInt(limiting.limit);
    const candidateFull =
      candidateLimit === 0n && BigInt(candidate.used) > 0n;
    const limitingFull =
      limitingLimit === 0n && BigInt(limiting.used) > 0n;
    if (
      (candidateFull && !limitingFull) ||
      (!candidateFull &&
        !limitingFull &&
        candidateLimit > 0n &&
        (limitingLimit === 0n ||
          BigInt(candidate.used) * limitingLimit >
            BigInt(limiting.used) * candidateLimit))
    ) {
      limiting = candidate;
    }
  }
  const limit = BigInt(limiting.limit);
  const used = BigInt(limiting.used);
  const basisPoints =
    limit === 0n
      ? used === 0n
        ? 0
        : 10_000
      : Number((used * 10_000n) / limit > 10_000n
          ? 10_000n
          : (used * 10_000n) / limit);
  return { ...limiting, basisPoints };
}

function Dialog({
  title,
  children,
  actions,
  onClose,
  closeDisabled = false,
  initialFocusSelector,
}: {
  title: string;
  children: React.ReactNode;
  actions: React.ReactNode;
  onClose(): void;
  closeDisabled?: boolean;
  initialFocusSelector?: string;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  const closeDisabledRef = useRef(closeDisabled);
  const titleId = useId();
  closeRef.current = onClose;
  closeDisabledRef.current = closeDisabled;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const focusable = (): HTMLElement[] =>
      [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.getAttribute("aria-hidden") !== "true");
    const initial = initialFocusSelector
      ? dialog.querySelector<HTMLElement>(initialFocusSelector)
      : null;
    (initial ?? focusable()[0] ?? dialog).focus();
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!closeDisabledRef.current) closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      if (previous?.isConnected) previous.focus();
    };
  }, [initialFocusSelector]);

  return (
    <div className="files-v2-dialog-backdrop" role="presentation">
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="files-v2-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header>
          <h2 id={titleId}>{title}</h2>
          <button
            aria-label="Close dialog"
            className="nt-icon-button"
            disabled={closeDisabled}
            onClick={onClose}
            type="button"
          >
            <IoClose aria-hidden="true" />
          </button>
        </header>
        <div className="files-v2-dialog-body">{children}</div>
        <footer>{actions}</footer>
      </section>
    </div>
  );
}

function FilesEntryMenu({
  actions,
  anchor,
  entryName,
  onClose,
}: {
  actions: readonly FilesEntryMenuAction[];
  anchor: EntryMenuState["anchor"];
  entryName: string;
  onClose(): void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const menuWidth = 184;
  const estimatedHeight = actions.length * 32 + 8;
  const left = Math.max(
    8,
    Math.min(anchor.right - menuWidth, window.innerWidth - menuWidth - 8),
  );
  const top = Math.max(
    8,
    anchor.bottom + estimatedHeight + 8 <= window.innerHeight
      ? anchor.bottom + 4
      : anchor.top - estimatedHeight - 4,
  );

  useEffect(() => {
    const menu = menuRef.current;
    const first = menu?.querySelector<HTMLButtonElement>(
      '[role="menuitem"]:not([disabled])',
    );
    (first ?? menu)?.focus();
    const pointerDown = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        !menuRef.current?.contains(event.target)
      ) {
        closeRef.current();
      }
    };
    const close = (): void => closeRef.current();
    document.addEventListener("pointerdown", pointerDown, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", pointerDown, true);
      window.removeEventListener("resize", close);
    };
  }, []);

  return (
    <div
      aria-label={`Actions for ${entryName}`}
      className="files-v2-entry-menu"
      onKeyDown={(event) => {
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(
          '[role="menuitem"]:not([disabled])',
        )];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        let next: HTMLButtonElement | undefined;
        if (event.key === "ArrowDown") {
          next = items[(index + 1 + items.length) % items.length];
        } else if (event.key === "ArrowUp") {
          next = items[(index - 1 + items.length) % items.length];
        } else if (event.key === "Home") {
          next = items[0];
        } else if (event.key === "End") {
          next = items.at(-1);
        } else if (event.key === "Escape") {
          event.preventDefault();
          onClose();
          return;
        } else if (event.key === "Tab") {
          onClose();
          return;
        } else {
          return;
        }
        event.preventDefault();
        next?.focus();
      }}
      ref={menuRef}
      role="menu"
      style={{ left, top }}
      tabIndex={-1}
    >
      {actions.map((action) => (
        <button
          className={cx(
            "files-v2-entry-menu-item",
            action.danger && "files-v2-entry-menu-item--danger",
          )}
          disabled={action.disabled}
          key={action.label}
          onClick={action.onSelect}
          role="menuitem"
          type="button"
        >
          {action.icon}
          {action.label}
        </button>
      ))}
    </div>
  );
}

export function virtualWindow<T>(
  entries: readonly T[],
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan: number,
): { items: readonly T[]; before: number; after: number } {
  const requestedStart = Math.max(
    0,
    Math.floor(scrollTop / rowHeight) - overscan,
  );
  const visible = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  // A revision-bound cursor restart can shrink a previously loaded folder to
  // its first page while the tile deliberately retains scroll. Clamp to the
  // last valid window instead of rendering only an oversized leading spacer.
  const start = Math.min(
    requestedStart,
    Math.max(0, entries.length - visible),
  );
  const end = Math.min(entries.length, start + visible);
  return {
    items: entries.slice(start, end),
    before: start * rowHeight,
    after: Math.max(0, (entries.length - end) * rowHeight),
  };
}

function parseList(value: unknown): FilesTileList {
  const source = record(value, "file list");
  const entries = array(source.entries, "entries").map(parseEntry);
  const loaded = integer(source.loaded, "loaded");
  const total = integer(source.total, "total");
  const cursor =
    source.cursor === null ? null : string(source.cursor, "cursor");
  const hasMore = boolean(source.hasMore, "hasMore");
  if (
    loaded !== entries.length ||
    loaded > total ||
    total > MAX_PRIVATE_ENTRIES ||
    entries.length > FOLDER_PAGE_SIZE ||
    hasMore !== (cursor !== null)
  ) {
    throw new Error("Files list result is inconsistent");
  }
  return {
    path: string(source.path, "path"),
    revision: decimal(source.revision, "revision"),
    entries,
    loaded,
    total,
    hasMore,
    cursor,
  };
}

function parseEntry(value: unknown): FilesTileEntry {
  const source = record(value, "file entry");
  const type = source.type;
  if (type !== "file" && type !== "folder") {
    throw new Error("Files entry type is invalid");
  }
  const contentKind = source.contentKind;
  if (
    contentKind !== null &&
    contentKind !== "text" &&
    contentKind !== "binary"
  ) {
    throw new Error("Files content kind is invalid");
  }
  const byteLength =
    source.byteLength === null
      ? null
      : integer(source.byteLength, "byteLength");
  const mediaType =
    source.mediaType === null
      ? null
      : string(source.mediaType, "mediaType");
  const etag =
    source.etag === null ? null : string(source.etag, "etag");
  const publicUrl =
    source.publicUrl === undefined || source.publicUrl === null
      ? null
      : string(source.publicUrl, "publicUrl");
  const nodeId =
    source.nodeId === undefined || source.nodeId === null
      ? null
      : decimal(source.nodeId, "nodeId");
  if (
    (etag !== null && !/^[a-f0-9]{64}$/u.test(etag)) ||
    (publicUrl !== null && !isFilesPublicRelativeUrl(publicUrl)) ||
    (type === "folder" &&
      (contentKind !== null ||
        byteLength !== null ||
        mediaType !== null ||
        etag !== null ||
        publicUrl !== null)) ||
    (type === "file" &&
      (contentKind === null ||
        byteLength === null ||
        mediaType === null ||
        etag === null))
  ) {
    throw new Error("Files entry fields are inconsistent");
  }
  return {
    path: string(source.path, "path"),
    name: string(source.name, "name"),
    type,
    nodeId,
    contentKind,
    byteLength,
    mediaType,
    etag,
    createdAtNs: decimal(source.createdAtNs, "createdAtNs"),
    modifiedAtNs: decimal(source.modifiedAtNs, "modifiedAtNs"),
    revision: decimal(source.revision, "revision"),
    publicUrl,
  };
}

function parseStatus(value: unknown): FilesTileStatus {
  const source = record(value, "Files status");
  if (
    source.vault !== "uninitialized" &&
    source.vault !== "locked" &&
    source.vault !== "ready" &&
    source.vault !== "rotating" &&
    source.vault !== "unrecoverable"
  ) {
    throw new Error("Files vault state is invalid");
  }
  const quota = record(source.quota, "Files quota");
  const publicUsage = parsePublicUsage(source.publicUsage);
  const transfers = array(source.transfers, "transfers");
  if (transfers.length > MAX_STATUS_TRANSFERS) {
    throw new Error("Files status page is inconsistent");
  }
  return {
    vault: source.vault,
    lockEpoch: decimal(source.lockEpoch, "lockEpoch"),
    currentGeneration:
      source.currentGeneration === null
        ? null
        : decimal(source.currentGeneration, "currentGeneration"),
    previousGeneration:
      source.previousGeneration === null
        ? null
        : decimal(source.previousGeneration, "previousGeneration"),
    rotationRequired: boolean(
      source.rotationRequired,
      "rotationRequired",
    ),
    reason:
      source.reason === null ? null : string(source.reason, "reason"),
    quota: {
      nodes: decimal(quota.nodes, "quota.nodes"),
      plaintextBytes: decimal(
        quota.plaintextBytes,
        "quota.plaintextBytes",
      ),
      ciphertextBytes: decimal(
        quota.ciphertextBytes,
        "quota.ciphertextBytes",
      ),
      physicalBytes: decimal(
        quota.physicalBytes,
        "quota.physicalBytes",
      ),
      cleanupJobs: integer(quota.cleanupJobs, "quota.cleanupJobs"),
    },
    publicUsage,
    transfers: transfers.map(parseTransfer),
  };
}

function parsePublicUsage(value: unknown): FilesTilePublicUsage {
  const source = record(value, "Files public usage");
  const currentSource = record(source.current, "Files public usage current");
  const current: FilesTilePublicUsageCounters = {
    liveEntries: decimal(currentSource.liveEntries, "publicUsage.liveEntries"),
    occupiedEntrySlots: decimal(
      currentSource.occupiedEntrySlots,
      "publicUsage.occupiedEntrySlots",
    ),
    committedBodyBytes: decimal(
      currentSource.committedBodyBytes,
      "publicUsage.committedBodyBytes",
    ),
    reservedCommittedBodyBytes: decimal(
      currentSource.reservedCommittedBodyBytes,
      "publicUsage.reservedCommittedBodyBytes",
    ),
    reservedEntrySlots: decimal(
      currentSource.reservedEntrySlots,
      "publicUsage.reservedEntrySlots",
    ),
    allocatedBodyBytes: decimal(
      currentSource.allocatedBodyBytes,
      "publicUsage.allocatedBodyBytes",
    ),
    chargedMetadataBytes: decimal(
      currentSource.chargedMetadataBytes,
      "publicUsage.chargedMetadataBytes",
    ),
    acceptedStagedBytes: decimal(
      currentSource.acceptedStagedBytes,
      "publicUsage.acceptedStagedBytes",
    ),
    reservedStagedBytes: decimal(
      currentSource.reservedStagedBytes,
      "publicUsage.reservedStagedBytes",
    ),
    detachedChargedBytes: decimal(
      currentSource.detachedChargedBytes,
      "publicUsage.detachedChargedBytes",
    ),
    activeStages: decimal(
      currentSource.activeStages,
      "publicUsage.activeStages",
    ),
    receiptLanes: decimal(
      currentSource.receiptLanes,
      "publicUsage.receiptLanes",
    ),
    generalReceiptLanes: decimal(
      currentSource.generalReceiptLanes,
      "publicUsage.generalReceiptLanes",
    ),
    reservedGeneralReceiptLanes: decimal(
      currentSource.reservedGeneralReceiptLanes,
      "publicUsage.reservedGeneralReceiptLanes",
    ),
    reservedRevocationLanes: decimal(
      currentSource.reservedRevocationLanes,
      "publicUsage.reservedRevocationLanes",
    ),
    filledRevocationLanes: decimal(
      currentSource.filledRevocationLanes,
      "publicUsage.filledRevocationLanes",
    ),
    receiptNonceIndexes: decimal(
      currentSource.receiptNonceIndexes,
      "publicUsage.receiptNonceIndexes",
    ),
    receiptExpiryIndexes: decimal(
      currentSource.receiptExpiryIndexes,
      "publicUsage.receiptExpiryIndexes",
    ),
    cleanupJobs: decimal(
      currentSource.cleanupJobs,
      "publicUsage.cleanupJobs",
    ),
  };
  const manifestLimits = parsePublicUsageLimits(
    source.manifestLimits,
    "manifest",
  );
  const effectiveLimits = parsePublicUsageLimits(
    source.effectiveLimits,
    "effective",
  );
  if (
    BigInt(current.liveEntries) > BigInt(current.occupiedEntrySlots) ||
    BigInt(current.generalReceiptLanes) +
        BigInt(current.reservedGeneralReceiptLanes) +
        BigInt(current.reservedRevocationLanes) +
        BigInt(current.filledRevocationLanes) !==
      BigInt(current.receiptLanes)
  ) {
    throw new Error("Files public usage counters are inconsistent");
  }
  for (const key of Object.keys(
    manifestLimits,
  ) as (keyof FilesTilePublicUsageLimits)[]) {
    if (BigInt(effectiveLimits[key]) > BigInt(manifestLimits[key])) {
      throw new Error("Files effective public limits exceed the manifest");
    }
  }
  return { current, manifestLimits, effectiveLimits };
}

function parsePublicUsageLimits(
  value: unknown,
  label: string,
): FilesTilePublicUsageLimits {
  const source = record(value, `Files ${label} public limits`);
  return {
    entries: decimal(source.entries, `${label}.entries`),
    committedBytes: decimal(
      source.committedBytes,
      `${label}.committedBytes`,
    ),
    objectBytes: decimal(source.objectBytes, `${label}.objectBytes`),
    stagedBytes: decimal(source.stagedBytes, `${label}.stagedBytes`),
    pendingStages: decimal(
      source.pendingStages,
      `${label}.pendingStages`,
    ),
    batchOperations: decimal(
      source.batchOperations,
      `${label}.batchOperations`,
    ),
    batchBytes: decimal(source.batchBytes, `${label}.batchBytes`),
    generalReceipts: decimal(
      source.generalReceipts,
      `${label}.generalReceipts`,
    ),
    revocationLanes: decimal(
      source.revocationLanes,
      `${label}.revocationLanes`,
    ),
  };
}

function parseTransfer(value: unknown): FilesTileTransfer {
  const source = record(value, "transfer");
  const phase = string(source.phase, "transfer.phase");
  const processedBytes = integer(
    source.processedBytes,
    "transfer.processedBytes",
  );
  const totalBytes = integer(source.totalBytes, "transfer.totalBytes");
  if (
    ![
      "queued",
      "hashing",
      "encrypting",
      "decrypting",
      "uploading",
      "downloading",
      "checking-outcome",
      "committed",
      "cancelled",
      "conflicted",
      "failed",
      "cleanup-pending",
    ].includes(phase) ||
    processedBytes > totalBytes
  ) {
    throw new Error("Files transfer fields are inconsistent");
  }
  return {
    id: string(source.id, "transfer.id"),
    label: string(source.label, "transfer.label"),
    phase,
    processedBytes,
    totalBytes,
    error:
      source.error === null ? null : string(source.error, "transfer.error"),
  };
}

function progressFrom(value: JsonValue): {
  phase: string;
  processedBytes: number;
} {
  const source = record(value, "transfer progress");
  return {
    phase:
      typeof source.phase === "string" ? source.phase : "uploading",
    processedBytes:
      typeof source.processedBytes === "number" &&
      Number.isSafeInteger(source.processedBytes)
        ? source.processedBytes
        : 0,
  };
}

function isTextUploadCandidate(file: File): boolean {
  if (file.size > TEXT_LIMIT) return false;
  if (
    file.type &&
    !file.type.startsWith("text/") &&
    file.type !== "application/json"
  ) {
    return false;
  }
  return true;
}

export async function readStrictTextFile(
  file: File,
  signal: AbortSignal,
): Promise<string | null> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const pieces: string[] = [];
  const chunkBytes = 64 * 1024;
  for (let offset = 0; offset < file.size; offset += chunkBytes) {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const end = Math.min(file.size, offset + chunkBytes);
    const chunk = await file.slice(offset, end).arrayBuffer();
    try {
      pieces.push(
        decoder.decode(chunk, {
          stream: end < file.size,
        }),
      );
    } catch {
      return null;
    }
  }
  if (file.size === 0) pieces.push(decoder.decode());
  return pieces.join("");
}

export type FilesDownloadChunks = Readonly<{
  chunks: readonly ArrayBuffer[];
  mediaType: string;
  totalBytes: number;
}>;

export async function streamFilesDownloadChunks(
  reviewed: FilesTileEntry,
  transferId: string,
  signal: AbortSignal,
  read: (ordinal: number) => Promise<FilesTileDownloadChunk>,
  onChunk?: (processedBytes: number) => void,
): Promise<FilesDownloadChunks> {
  if (
    reviewed.type !== "file" ||
    reviewed.byteLength === null ||
    reviewed.mediaType === null ||
    reviewed.etag === null
  ) {
    throw new Error("Files download requires reviewed file metadata");
  }
  if (
    reviewed.byteLength > FILES_SERVICE_LIMITS.tileBinaryBytes ||
    !/^[A-Za-z0-9_-]{1,96}$/u.test(transferId)
  ) {
    throw new Error("Files download request is outside its allowed range");
  }

  const chunks: ArrayBuffer[] = [];
  let inFlight: ArrayBuffer | null = null;
  let processedBytes = 0;
  let ordinal = 0;
  const maxChunks = Math.ceil(
    FILES_SERVICE_LIMITS.tileBinaryBytes /
      FILES_SERVICE_LIMITS.tileChunkBytes,
  );
  try {
    do {
      if (signal.aborted) {
        throw new DOMException("Cancelled", "AbortError");
      }
      if (ordinal >= maxChunks) {
        throw new Error("Files download returned too many chunks");
      }
      const result = await readFilesDownloadChunkWithReplay(
        ordinal,
        signal,
        read,
      );
      inFlight = result.data;
      if (signal.aborted) {
        throw new DOMException("Cancelled", "AbortError");
      }
      const expectedChunkBytes = Math.min(
        FILES_SERVICE_LIMITS.tileChunkBytes,
        reviewed.byteLength - processedBytes,
      );
      const nextProcessed = processedBytes + result.data.byteLength;
      if (
        result.transferId !== transferId ||
        result.path !== reviewed.path ||
        result.ordinal !== ordinal ||
        result.etag !== reviewed.etag ||
        result.totalBytes !== reviewed.byteLength ||
        result.processedBytes !== nextProcessed ||
        result.final !== (nextProcessed === reviewed.byteLength) ||
        result.entry.type !== "file" ||
        result.entry.path !== reviewed.path ||
        result.entry.etag !== reviewed.etag ||
        result.entry.byteLength !== reviewed.byteLength ||
        result.entry.mediaType !== reviewed.mediaType ||
        result.mediaType !== "application/octet-stream" ||
        result.data.byteLength !== expectedChunkBytes ||
        result.data.byteLength > FILES_SERVICE_LIMITS.tileChunkBytes
      ) {
        throw new Error("Files download chunk binding is invalid");
      }
      chunks.push(result.data);
      inFlight = null;
      processedBytes = nextProcessed;
      onChunk?.(processedBytes);
      ordinal += 1;
      if (result.final) break;
    } while (processedBytes < reviewed.byteLength);
    if (processedBytes !== reviewed.byteLength) {
      throw new Error("Files download ended before the complete file arrived");
    }
    return {
      chunks,
      mediaType: reviewed.mediaType,
      totalBytes: processedBytes,
    };
  } catch (error) {
    if (inFlight !== null) new Uint8Array(inFlight).fill(0);
    wipeFilesDownloadChunks(chunks);
    throw error;
  }
}

export async function readFilesDownloadChunkWithReplay(
  ordinal: number,
  signal: AbortSignal,
  read: (ordinal: number) => Promise<FilesTileDownloadChunk>,
): Promise<FilesTileDownloadChunk> {
  try {
    return await read(ordinal);
  } catch (error) {
    if (
      signal.aborted ||
      !isFilesAmbiguousTransferFailure(toError(error).message)
    ) {
      throw error;
    }
    // The resident accepts only an exact replay of the immediately previous
    // ordinal, so retrying cannot advance or duplicate the transfer.
    return read(ordinal);
  }
}

export function wipeFilesDownloadChunks(
  chunks: readonly ArrayBuffer[],
): void {
  for (const chunk of chunks) new Uint8Array(chunk).fill(0);
}

export type FilesUploadPassChunk = Readonly<{
  pass: "hash" | "encrypt";
  ordinal: number;
  final: boolean;
  totalBytes: number;
  data: ArrayBuffer;
}>;

export async function streamFilesUploadPasses<
  Result extends {
    phase: string;
    processedBytes: number;
    committed: boolean;
    readyForUpload: boolean;
  },
>(
  file: File,
  chunkBytes: number,
  signal: AbortSignal,
  send: (chunk: FilesUploadPassChunk) => Promise<Result>,
  onResult?: (
    pass: FilesUploadPassChunk["pass"],
    offset: number,
    result: Result,
  ) => void,
): Promise<Result> {
  if (
    !Number.isSafeInteger(chunkBytes) ||
    chunkBytes < 1 ||
    chunkBytes > 1_889_984
  ) {
    throw new Error("Files upload chunk size is invalid");
  }
  const runPass = async (
    pass: FilesUploadPassChunk["pass"],
  ): Promise<Result> => {
    let offset = 0;
    let ordinal = 0;
    let result: Result | null = null;
    do {
      if (signal.aborted) {
        throw new DOMException("Cancelled", "AbortError");
      }
      const end = Math.min(file.size, offset + chunkBytes);
      const data = await file.slice(offset, end).arrayBuffer();
      if (signal.aborted) {
        throw new DOMException("Cancelled", "AbortError");
      }
      result = await send({
        pass,
        ordinal,
        final: end === file.size,
        totalBytes: file.size,
        data,
      });
      onResult?.(pass, offset, result);
      offset = end;
      ordinal += 1;
    } while (offset < file.size);
    if (result === null) {
      throw new Error("Files upload pass produced no result");
    }
    return result;
  };
  const hashed = await runPass("hash");
  if (!hashed.readyForUpload || hashed.committed) {
    throw new Error("Files did not accept the completed upload hash pass");
  }
  const encrypted = await runPass("encrypt");
  return encrypted;
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("Cancelled", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("Cancelled", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function record(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as JsonObject;
}

function array(value: unknown, label: string): JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  return value;
}

function decimal(value: unknown, label: string): string {
  const result = string(value, label);
  if (!/^(0|[1-9][0-9]{0,19})$/u.test(result)) {
    throw new Error(`${label} is invalid`);
  }
  return result;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} is invalid`);
  }
  return Number(value);
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} is invalid`);
  return value;
}

function parentPath(path: string): string {
  if (path === "/") return "/";
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function rootEntry(root: (typeof FILES_UI_ROOTS)[number]): FilesTileEntry {
  return Object.freeze({
    path: root.path,
    name: root.name,
    type: "folder",
    nodeId: null,
    contentKind: null,
    byteLength: null,
    mediaType: null,
    etag: null,
    createdAtNs: "0",
    modifiedAtNs: "0",
    revision: "0",
    publicUrl: null,
  });
}

function emptyTileList(path: string): FilesTileList {
  return {
    path: normalizeFilesPath(path).path,
    revision: "0",
    entries: [],
    loaded: 0,
    total: 0,
    hasMore: false,
    cursor: null,
  };
}

function joinPath(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

function leafName(path: string): string {
  return normalizeFilesPath(path).segments.at(-1) ?? "file";
}

function copyPath(path: string): string {
  const index = path.lastIndexOf(".");
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  return index > path.lastIndexOf("/")
    ? `${path.slice(0, index)} copy ${stamp}${path.slice(index)}`
    : `${path} copy ${stamp}`;
}

function pathCrumbs(path: string): Array<{ name: string; path: string }> {
  const result = [{ name: "Files", path: "/" }];
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    result.push({ name: part, path: current });
  }
  return result;
}

function folderDescription(path: string): string {
  const root = filesRootKind(path);
  if (path === "/Shared") {
    return "Everything here gets a public link automatically.";
  }
  if (path === "/Vault") {
    return "Files here are protected automatically.";
  }
  if (path === "/Workspace") {
    return "Regular files for everyday work.";
  }
  return root === "shared"
    ? "Files in this folder have public links."
    : root === "vault"
      ? "This folder is protected automatically."
      : "Open this folder from the tree to see its contents.";
}

function filesRootLabel(root: FilesRootKind): string {
  return root === "shared" ? "Shared" : root === "vault" ? "Vault" : "Workspace";
}

function filesRootPolicy(root: FilesRootKind): string {
  if (root === "shared") {
    return "Shared publishes files through public links.";
  }
  if (root === "vault") {
    return "Vault protects files with the current Vault key.";
  }
  return "Workspace stores regular files without a public link.";
}

function filesPathPolicy(path: string): string {
  const root = filesRootKind(path);
  return root === null
    ? "Choose a folder in Shared, Vault, or Workspace."
    : filesRootPolicy(root);
}

function hasOsFileDrag(dataTransfer: DataTransfer): boolean {
  return (
    dataTransfer.files.length > 0 ||
    Array.from(dataTransfer.types).includes("Files")
  );
}

export function authorizedFilesInternalDragSource(
  liveDrag: Readonly<{ path: string; token: string }> | null,
  suppliedToken: string,
): string | null {
  return liveDrag !== null &&
      liveDrag.token.length >= 16 &&
      suppliedToken === liveDrag.token
    ? liveDrag.path
    : null;
}

function isSpreadsheet(mediaType: string | null, path: string): boolean {
  return (
    mediaType === "application/vnd.neutron.spreadsheet+json" ||
    mediaType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    /\.(xlsx?|nsheet)$/iu.test(path)
  );
}

function isTerminalTransferPhase(phase: string): boolean {
  return (
    phase === "committed" ||
    phase === "cancelled" ||
    phase === "cleanup-pending"
  );
}

function isResolvedTransferPhase(phase: string): boolean {
  return (
    isTerminalTransferPhase(phase) ||
    phase === "conflicted" ||
    phase === "failed"
  );
}

function transferPhaseLabel(phase: string): string {
  switch (phase) {
    case "queued":
      return "Waiting";
    case "hashing":
    case "preparing":
    case "staging":
      return "Preparing";
    case "encrypting":
    case "uploading":
    case "publishing":
      return "Uploading";
    case "decrypting":
    case "downloading":
      return "Downloading";
    case "checking-outcome":
    case "cleanup-pending":
      return "Finishing";
    case "committed":
      return "Done";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Failed";
    case "conflicted":
      return "Needs attention";
    default:
      return "Working";
  }
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}

export type FilesErrorRecoveryKind =
  | "unlock"
  | "restart-folder"
  | "review-space"
  | "refresh"
  | "reload";

export function shouldRetainFilesDirtyBuffer(
  reason: string | null | undefined,
  dirty: boolean,
): boolean {
  return dirty && isFilesSameAuthorityVaultLockReason(reason);
}

export function isFilesSameAuthorityVaultLockReason(
  reason: string | null | undefined,
): boolean {
  if (!reason) return false;
  const normalized = reason.toLocaleLowerCase();
  return (
    normalized === "explicit" ||
    normalized === "inactivity" ||
    normalized === "idle" ||
    normalized.includes("inactivity") ||
    normalized.includes("idle lock") ||
    normalized.includes("explicit lock")
  );
}

export function shouldResetFilesSelectionAfterRevisionRestart(
  selectedPath: string | null,
  refreshedEntries: readonly Pick<FilesTileEntry, "path">[],
): boolean {
  return (
    selectedPath !== null &&
    !refreshedEntries.some((entry) => entry.path === selectedPath)
  );
}

export function classifyFilesError(
  message: string,
): { kind: FilesErrorRecoveryKind; label: string } | null {
  if (isFilesMessageBusLifecycleError(message)) return null;
  if (
    /needs.?user.?unlock|private files are locked|vault.*locked/i
      .test(message)
  ) {
    return { kind: "unlock", label: "Open Vault" };
  }
  if (
    /cursor.*(expired|stale|invalid)|stale.*cursor|folder changed during paging/i
      .test(message)
  ) {
    return { kind: "restart-folder", label: "Restart folder" };
  }
  if (/quota|storage.*limit|capacity|out of space/i.test(message)) {
    return { kind: "review-space", label: "Review files" };
  }
  if (/incompatible|unsupported.*version|update files/i.test(message)) {
    return { kind: "reload", label: "Reload Files" };
  }
  if (
    /offline|network|transport|connection|timed? ?out|temporarily unavailable|busy|try again|uncertain/i.test(
      message,
    )
  ) {
    return { kind: "refresh", label: "Refresh status" };
  }
  return null;
}

export function isFilesAmbiguousTransferFailure(
  message: string | null,
): boolean {
  return (
    message !== null &&
    /uncertain|unknown outcome|network|transport|offline|timed? ?out|connection|fetch failed/i
      .test(message)
  );
}

export function isFilesKnownConflictFailure(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const normalized = toError(value) as Error & { code?: unknown };
  if (normalized.code === "conflict") return true;
  return /(?:^|[^a-z])conflict(?:ed)?(?:[^a-z]|$)|already exists|etag no longer matches|stale (?:content|revision)|target already exists/i
    .test(normalized.message);
}

export function errorMessage(error: unknown): string {
  const normalized = toError(error);
  if (/needs.?user.?unlock/i.test(normalized.message)) {
    return "Files is restarting. Try again.";
  }
  if (/require(?:s|d)? (?:an )?authorized principal|unauthorized principal/i.test(
    normalized.message,
  )) {
    return "This account does not have permission to change Files security.";
  }
  if (/(?:lookup|list|write|mutation).*rejected: stale_revision/i.test(
    normalized.message,
  )) {
    return "This folder changed. Refresh it and try again.";
  }
  if (
    /Invalid call JSON|schemaPath|instancePath|expected_list_revision.*must be string|cursor.*must be object/i
      .test(normalized.message)
  ) {
    return "Files received an outdated response. Refresh Files and try again.";
  }
  if (/Response Verification Error|(?:HTTP |Error )?503\b/i.test(
    normalized.message,
  )) {
    return "Files could not verify the server response. Try again.";
  }
  return normalized.message || "Files operation failed";
}

const root =
  typeof document === "undefined" ? null : document.getElementById("root");
if (root) createRoot(root).render(<App />);
