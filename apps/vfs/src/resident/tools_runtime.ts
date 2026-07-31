import type { JsonObject, JsonValue } from "neutron-tools/app";
import { parseCanonicalNat64 } from "../protocol/ids.ts";
import type { CanonicalNat64 } from "../protocol/types.ts";
import {
  FilesContinuationError,
  FilesContinuationRegistry,
  type FilesContinuationScope,
} from "./continuation_registry.ts";
import {
  FILES_POLICY_V3_PATH_ROUTING,
  filesPathRoutingMode,
  type FilesPathRouting,
} from "./path_routing.ts";
import { normalizeFilesPathForRouting } from "./routed_paths.ts";
import {
  filesStorageClassForPath,
  filesVirtualPath,
  parseFilesRootedPath,
} from "./storage_roots.ts";
import {
  FILES_SERVICE_LIMITS,
  FilesServiceFault,
  type FilesResidentFilePort,
  type FilesServiceEntry,
  type FilesServiceFile,
  type FilesServiceUiAction,
  type FilesToolCursorValue,
} from "./service_contract.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const ETAG_PATTERN = /^[a-f0-9]{64}$/u;
const TRANSFER_ID_PATTERN = /^[A-Za-z0-9_-]{1,96}$/u;
const TOOL_ATTACHMENT_MEDIA_TYPES = new Set([
  "application/octet-stream",
  "application/vnd.neutron.spreadsheet+json",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/json",
  "application/zip",
  "application/pdf",
  "text/csv",
  "text/plain",
  "text/markdown",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export type FilesToolInvocation = Readonly<{
  callerEndpoint: string;
  callerSession: string;
  callerAppId?: string;
  callerRole?: string;
  agentMode?: boolean;
  signal?: AbortSignal;
  reportProgress?(value: JsonValue): void;
}>;

export type FilesToolRuntimeBinding = Readonly<{
  installationGeneration(): CanonicalNat64;
  lockEpoch(): CanonicalNat64;
}>;

type FilesDownloadStage = {
  readonly transferId: string;
  readonly path: string;
  readonly etagSha256: string;
  readonly routingMode: ReturnType<typeof filesPathRoutingMode>;
  readonly callerEndpoint: string;
  readonly callerSession: string;
  readonly installationGeneration: CanonicalNat64;
  readonly lockEpoch: CanonicalNat64;
  entry: FilesServiceFile["entry"] | null;
  bytes: Uint8Array | null;
  mediaType: string | null;
  nextOrdinal: number;
  lastOrdinal: number | null;
  lastChunk: Uint8Array | null;
  lastValue: JsonObject | null;
};

export type FilesToolRuntimeOptions = Readonly<{
  downloadIdleMs?: number;
}>;

export class FilesToolRuntime<Cursor = unknown> {
  readonly #continuations =
    new FilesContinuationRegistry<FilesToolCursorValue<Cursor>>();
  #continuationEpoch: bigint;
  #download: FilesDownloadStage | null = null;
  #downloadExpiry: ReturnType<typeof setTimeout> | null = null;
  readonly #downloadIdleMs: number;

  constructor(
    private readonly port: FilesResidentFilePort<Cursor>,
    private readonly binding: FilesToolRuntimeBinding,
    options: FilesToolRuntimeOptions = {},
  ) {
    this.#continuationEpoch = BigInt(
      parseCanonicalNat64(
        binding.lockEpoch(),
        "Files continuation lock epoch",
      ),
    );
    this.#downloadIdleMs = options.downloadIdleMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.#downloadIdleMs) ||
      this.#downloadIdleMs < 1 ||
      this.#downloadIdleMs > 300_000
    ) {
      throw new Error("Files download inactivity timeout is invalid");
    }
  }

  async list(
    args: JsonObject,
    invocation: FilesToolInvocation,
  ): Promise<JsonObject> {
    const continuationEpoch = this.#continuationEpoch;
    const routing = FILES_POLICY_V3_PATH_ROUTING;
    const path = pathForInvocation(
      optionalString(args.path) ?? "/Workspace",
      routing,
      invocation,
    );
    const recursive = optionalBoolean(args.recursive) ?? false;
    const routingMode = filesPathRoutingMode(routing);
    const limit = optionalInteger(
      args.limit,
      1,
      FILES_SERVICE_LIMITS.pageEntries,
      "limit",
    ) ?? FILES_SERVICE_LIMITS.pageEntries;
    const token = optionalString(args.cursor);
    const scope = this.#scope(invocation);
    let cursor: Cursor | null = null;
    let expectedFolderRevision: CanonicalNat64 | null = null;
    if (token !== undefined) {
      try {
        const redeemed = this.#continuations.redeemScope(token, scope);
        if (
          redeemed.value.path !== path ||
          redeemed.value.recursive !== recursive ||
          redeemed.value.routingMode !== routingMode
        ) {
          throw new FilesContinuationError(
            "cursor_scope_mismatch",
            "The continuation belongs to another list request",
          );
        }
        cursor = redeemed.value.backendCursor;
        expectedFolderRevision = redeemed.binding.folderRevision;
        this.#continuations.revoke(token);
      } catch (error) {
        throw cursorFault(error);
      }
    }
    const page = await this.port.list({
      path,
      cursor,
      expectedFolderRevision,
      limit,
      recursive,
      routing,
      ...(invocation.signal ? { signal: invocation.signal } : {}),
    });
    if (continuationEpoch !== this.#continuationEpoch) {
      throw new FilesServiceFault(
        "cancelled",
        "Files authority changed while listing private entries",
        "Unlock Files and restart the list",
      );
    }
    if (page.path !== path || page.entries.length > limit) {
      throw new FilesServiceFault(
        "incompatible",
        "Files returned an invalid folder page",
        "Retry after updating Files",
      );
    }
    const nextCursor =
      page.hasMore && page.cursor !== null
        ? this.#continuations.issue(
            {
              ...scope,
              folderRevision: page.folderRevision,
            },
            {
              path,
              recursive,
              routingMode,
              backendCursor: page.cursor,
            },
          )
        : null;
    return {
      path,
      revision: page.folderRevision,
      loaded: page.entries.length,
      total: page.total,
      hasMore: page.hasMore,
      cursor: nextCursor,
      entries: page.entries.map(entryJson),
    };
  }

  async stat(args: JsonObject, invocation: FilesToolInvocation): Promise<JsonObject> {
    const routing = FILES_POLICY_V3_PATH_ROUTING;
    const entry = await this.port.stat(
      requiredPath(args.path, routing, invocation),
      invocation.signal,
      routing,
    );
    return entryJson(entry);
  }

  async read(args: JsonObject, invocation: FilesToolInvocation): Promise<JsonObject> {
    const routing = FILES_POLICY_V3_PATH_ROUTING;
    const file = await this.#readText(
      requiredPath(args.path, routing, invocation),
      invocation.signal,
      routing,
    );
    return {
      ...entryJson(file.entry),
      content: decodeText(file.bytes),
    };
  }

  async readBinary(
    args: JsonObject,
    invocation: FilesToolInvocation,
  ): Promise<{ value: JsonObject; data: ArrayBuffer; mediaType: string }> {
    const routing = FILES_POLICY_V3_PATH_ROUTING;
    const path = requiredPath(args.path, routing, invocation);
    const expected = await this.port.stat(
      path,
      invocation.signal,
      routing,
    );
    assertBoundedAttachmentMetadata(expected);
    const ifMatch = optionalEtag(args.ifMatch);
    if (ifMatch !== undefined && expected.etagSha256 !== ifMatch) {
      throw conflictFault(expected);
    }
    const file = await this.port.read(path, {
      ...this.#controls(invocation),
    }, routing);
    assertSameReadableFile(expected, file);
    const data = exactArrayBuffer(file.bytes);
    return {
      value: entryJson(file.entry),
      data,
      mediaType: safeAttachmentMediaType(file.entry.mediaType),
    };
  }

  async downloadChunk(
    args: JsonObject,
    invocation: FilesToolInvocation,
  ): Promise<{
    value: JsonObject;
    data: ArrayBuffer;
    mediaType: string;
  }> {
    const transferId = requiredString(args.transferId, "transferId");
    if (!TRANSFER_ID_PATTERN.test(transferId)) {
      throw invalidFault("transferId is invalid");
    }
    const routing = FILES_POLICY_V3_PATH_ROUTING;
    const path = requiredPath(args.path, routing, invocation);
    const etagSha256 = optionalEtag(args.etag);
    if (etagSha256 === undefined) {
      throw invalidFault("etag is required");
    }
    const ordinal = optionalInteger(
      args.ordinal,
      0,
      Math.ceil(
        FILES_SERVICE_LIMITS.tileBinaryBytes /
          FILES_SERVICE_LIMITS.tileChunkBytes,
      ) - 1,
      "ordinal",
    );
    if (ordinal === undefined) {
      throw invalidFault("ordinal is required");
    }

    let stage = this.#download;
    if (
      stage !== null &&
      ordinal === 0 &&
      stage.transferId !== transferId &&
      stage.callerEndpoint === invocation.callerEndpoint &&
      stage.callerSession === invocation.callerSession &&
      stage.installationGeneration === this.binding.installationGeneration() &&
      stage.lockEpoch ===
        (this.#continuationEpoch.toString() as CanonicalNat64) &&
      stage.bytes === null &&
      stage.lastValue?.final === true
    ) {
      // A completed receipt protects a lost final response, but it is no
      // longer an active plaintext download. Its owner may start new work.
      this.#dropDownload(stage);
      stage = null;
    }
    if (stage !== null) {
      const sameOwner =
        stage.callerEndpoint === invocation.callerEndpoint &&
        stage.callerSession === invocation.callerSession &&
        stage.installationGeneration ===
          this.binding.installationGeneration() &&
        stage.lockEpoch ===
          (this.#continuationEpoch.toString() as CanonicalNat64);
      const sameBinding =
        stage.transferId === transferId &&
        stage.path === path &&
        stage.etagSha256 === etagSha256 &&
        stage.routingMode === filesPathRoutingMode(routing);
      if (!sameOwner || !sameBinding) {
        if (ordinal === 0) {
          throw new FilesServiceFault(
            "busy",
            "Another Files download is active",
            "Wait for it to finish or cancel it",
          );
        }
        throw invalidFault(
          sameOwner
            ? "Download binding does not match"
            : "Download belongs to another Files tile session",
        );
      }
      if (
        stage.lastOrdinal === ordinal &&
        stage.lastChunk !== null &&
        stage.lastValue !== null &&
        stage.mediaType !== null
      ) {
        this.#armDownloadExpiry(stage);
        return {
          value: cloneDownloadValue(stage.lastValue),
          data: exactArrayBuffer(stage.lastChunk.slice()),
          mediaType: stage.mediaType,
        };
      }
      if (
        stage.bytes === null ||
        stage.entry === null ||
        stage.mediaType === null
      ) {
        if (stage.lastOrdinal !== null) {
          throw invalidFault("Download is already complete");
        }
        throw new FilesServiceFault(
          "busy",
          "Files is still preparing this download",
          "Retry the same chunk",
        );
      }
      if (ordinal !== stage.nextOrdinal) {
        throw invalidFault("Download ordinal is out of sequence");
      }
    }
    if (stage === null) {
      if (ordinal !== 0) {
        throw invalidFault("Download transfer is not active");
      }
      stage = {
        transferId,
        path,
        etagSha256,
        routingMode: filesPathRoutingMode(routing),
        callerEndpoint: invocation.callerEndpoint,
        callerSession: invocation.callerSession,
        installationGeneration: this.binding.installationGeneration(),
        lockEpoch:
          this.#continuationEpoch.toString() as CanonicalNat64,
        entry: null,
        bytes: null,
        mediaType: null,
        nextOrdinal: 0,
        lastOrdinal: null,
        lastChunk: null,
        lastValue: null,
      };
      this.#download = stage;
      try {
        const expected = await this.port.stat(
          path,
          invocation.signal,
          routing,
        );
        assertDownloadMetadata(expected, path, etagSha256);
        const file = await this.port.read(path, {
          ...this.#controls(invocation),
          transferId,
        }, routing);
        if (this.#download !== stage || invocation.signal?.aborted) {
          file.bytes.fill(0);
          throw cancelledFault("Files download was cancelled");
        }
        // The resident read result is transfer-owned. Keep that single
        // verified plaintext allocation until the final bounded slice.
        stage.bytes = file.bytes;
        assertSameReadableFile(expected, file);
        if (this.#download !== stage || invocation.signal?.aborted) {
          throw cancelledFault("Files download was cancelled");
        }
        stage.entry = file.entry;
        stage.mediaType = safeAttachmentMediaType(file.entry.mediaType);
      } catch (error) {
        this.#dropDownload(stage);
        throw error;
      }
    }

    if (stage.bytes === null || stage.entry === null || stage.mediaType === null) {
      throw invalidFault("Download transfer is not active");
    }
    if (ordinal !== stage.nextOrdinal) {
      throw invalidFault("Download ordinal is out of sequence");
    }

    const start = ordinal * FILES_SERVICE_LIMITS.tileChunkBytes;
    if (start > stage.bytes.byteLength) {
      throw invalidFault("Download ordinal exceeds the file");
    }
    const end = Math.min(
      stage.bytes.byteLength,
      start + FILES_SERVICE_LIMITS.tileChunkBytes,
    );
    const chunk = stage.bytes.slice(start, end);
    const final = end === stage.bytes.byteLength;
    const entry = stage.entry;
    const mediaType = stage.mediaType;
    const value: JsonObject = {
      transferId,
      path,
      ordinal,
      etag: etagSha256,
      totalBytes: entry.byteLength,
      processedBytes: end,
      final,
      entry: entryJson(entry),
    };
    stage.lastChunk?.fill(0);
    stage.lastChunk = chunk.slice();
    stage.lastOrdinal = ordinal;
    stage.lastValue = value;
    stage.nextOrdinal += 1;
    if (final) {
      // Retain only the bounded terminal receipt for a lost-response replay.
      // The full verified file must not survive completion.
      stage.bytes.fill(0);
      stage.bytes = null;
    }
    this.#armDownloadExpiry(stage);
    return {
      value,
      data: exactArrayBuffer(chunk),
      mediaType,
    };
  }

  async write(args: JsonObject, invocation: FilesToolInvocation): Promise<JsonObject> {
    const routing = FILES_POLICY_V3_PATH_ROUTING;
    const path = requiredPath(args.path, routing, invocation);
    assertSharedPublicationAllowed(path, invocation, routing);
    const content = requiredString(args.content, "content", true);
    const bytes = encoder.encode(content);
    if (bytes.byteLength > FILES_SERVICE_LIMITS.textBytes) {
      throw limitFault("Text file exceeds 512 KiB");
    }
    const result = await this.port.write(
      {
        path,
        source: bytesSource(bytes, leafName(path), "text/plain"),
        contentKind: "text",
        mediaType: normalizeMediaType(
          optionalString(args.mediaType) ?? inferTextMediaType(path),
        ),
        ifMatch: optionalEtag(args.ifMatch) ?? null,
        ifNoneMatch:
          optionalString(args.ifNoneMatch) === "*" ||
          optionalBoolean(args.overwrite) === false,
        createParents: optionalBoolean(args.createParents) ?? true,
      },
      this.#controls(invocation),
      routing,
    );
    return writeJson(result.entry, result.cleanupPending);
  }

  async writeBinary(
    args: JsonObject,
    data: ArrayBuffer,
    attachmentType: string,
    invocation: FilesToolInvocation,
  ): Promise<JsonObject> {
    const routing = FILES_POLICY_V3_PATH_ROUTING;
    const path = requiredPath(args.path, routing, invocation);
    assertSharedPublicationAllowed(path, invocation, routing);
    if (
      !(data instanceof ArrayBuffer) ||
      data.byteLength > FILES_SERVICE_LIMITS.binaryBytes
    ) {
      throw limitFault("Binary file exceeds 16 MiB");
    }
    const mediaType = normalizeMediaType(
      requiredString(args.mediaType, "mediaType"),
    );
    const normalizedAttachmentType = attachmentMediaType(attachmentType);
    if (
      normalizedAttachmentType !== "application/octet-stream" &&
      normalizedAttachmentType !== attachmentMediaType(mediaType)
    ) {
      throw invalidFault("Attachment media type does not match mediaType");
    }
    const ifNoneMatch = optionalString(args.ifNoneMatch);
    if (ifNoneMatch !== undefined && ifNoneMatch !== "*") {
      throw invalidFault('ifNoneMatch must be "*"');
    }
    const result = await this.port.write(
      {
        path,
        source: bytesSource(
          new Uint8Array(data),
          leafName(path),
          mediaType,
        ),
        contentKind: "binary",
        mediaType,
        ifMatch: optionalEtag(args.ifMatch) ?? null,
        ifNoneMatch: ifNoneMatch === "*",
        createParents: optionalBoolean(args.createParents) ?? true,
      },
      this.#controls(invocation),
      routing,
    );
    return writeJson(result.entry, result.cleanupPending);
  }

  async writeMany(
    args: JsonObject,
    invocation: FilesToolInvocation,
  ): Promise<JsonObject> {
    const routing = FILES_POLICY_V3_PATH_ROUTING;
    const files = requiredObjectArray(args.files, "files");
    if (
      files.length < 1 ||
      files.length > FILES_SERVICE_LIMITS.batchFiles
    ) {
      throw limitFault("writeMany accepts between 1 and 20 files");
    }
    let total = 0;
    const planned = files.map((file) => {
      const path = requiredPath(file.path, routing, invocation);
      assertSharedPublicationAllowed(path, invocation, routing);
      const text = requiredString(file.content, "content", true);
      const bytes = encoder.encode(text).byteLength;
      if (bytes > FILES_SERVICE_LIMITS.textBytes) {
        throw limitFault(`Text file exceeds 512 KiB: ${path}`);
      }
      total += bytes;
      return {
        path,
        text,
        overwrite: optionalBoolean(file.overwrite) ?? true,
        createParents: optionalBoolean(file.createParents) ?? true,
        mediaType: normalizeMediaType(
          optionalString(file.mediaType) ?? inferTextMediaType(path),
        ),
      };
    });
    if (total > FILES_SERVICE_LIMITS.batchTextBytes) {
      throw limitFault("writeMany exceeds its 10 MiB total plaintext limit");
    }
    if (new Set(planned.map((file) => file.path)).size !== planned.length) {
      throw invalidFault("writeMany contains duplicate canonical paths");
    }
    const results = await this.port.writeMany(
      planned,
      this.#controls(invocation),
      routing,
    );
    return {
      count: results.length,
      files: results.map((result) =>
        writeJson(result.entry, result.cleanupPending)
      ),
    };
  }

  async append(args: JsonObject, invocation: FilesToolInvocation): Promise<JsonObject> {
    const routing = FILES_POLICY_V3_PATH_ROUTING;
    const path = requiredPath(args.path, routing, invocation);
    assertSharedPublicationAllowed(path, invocation, routing);
    const additionInput = requiredString(args.content, "content");
    const current = await this.#readText(
      path,
      invocation.signal,
      routing,
    );
    const currentText = decodeText(current.bytes);
    const asNewLine = optionalBoolean(args.asNewLine) ?? true;
    const prefix =
      asNewLine && currentText && !currentText.endsWith("\n") ? "\n" : "";
    const suffix =
      asNewLine && !additionInput.endsWith("\n") ? "\n" : "";
    const addition = `${prefix}${additionInput}${suffix}`;
    const bytes = encoder.encode(currentText + addition);
    if (bytes.byteLength > FILES_SERVICE_LIMITS.textBytes) {
      throw limitFault("Append would exceed 512 KiB");
    }
    const result = await this.port.write(
      {
        path,
        source: bytesSource(
          bytes,
          leafName(path),
          current.entry.mediaType ?? inferTextMediaType(path),
        ),
        contentKind: "text",
        mediaType: current.entry.mediaType ?? inferTextMediaType(path),
        ifMatch: current.entry.etagSha256,
        ifNoneMatch: false,
        createParents: false,
      },
      this.#controls(invocation),
      routing,
    );
    return {
      ...writeJson(result.entry, result.cleanupPending),
      appended: encoder.encode(addition).byteLength,
    };
  }

  async patch(args: JsonObject, invocation: FilesToolInvocation): Promise<JsonObject> {
    const routing = FILES_POLICY_V3_PATH_ROUTING;
    const path = requiredPath(args.path, routing, invocation);
    assertSharedPublicationAllowed(path, invocation, routing);
    const oldText = requiredString(args.oldText, "oldText");
    const newText = requiredString(args.newText, "newText", true);
    const current = await this.#readText(
      path,
      invocation.signal,
      routing,
    );
    const text = decodeText(current.bytes);
    const occurrences = countOccurrences(text, oldText);
    if (occurrences === 0) {
      throw new FilesServiceFault(
        "not_found",
        "oldText was not found",
        "Read the current file and retry with exact context",
      );
    }
    const replaceAll = optionalBoolean(args.replaceAll) ?? false;
    if (!replaceAll && occurrences !== 1) {
      throw new FilesServiceFault(
        "conflict",
        "oldText is not unique",
        "Include more context or set replaceAll",
        { occurrences },
      );
    }
    const next = replaceAll
      ? text.split(oldText).join(newText)
      : text.replace(oldText, newText);
    const bytes = encoder.encode(next);
    if (bytes.byteLength > FILES_SERVICE_LIMITS.textBytes) {
      throw limitFault("Patch would exceed 512 KiB");
    }
    const result = await this.port.write(
      {
        path,
        source: bytesSource(
          bytes,
          leafName(path),
          current.entry.mediaType ?? inferTextMediaType(path),
        ),
        contentKind: "text",
        mediaType: current.entry.mediaType ?? inferTextMediaType(path),
        ifMatch: current.entry.etagSha256,
        ifNoneMatch: false,
        createParents: false,
      },
      this.#controls(invocation),
      routing,
    );
    return {
      ...writeJson(result.entry, result.cleanupPending),
      replacements: replaceAll ? occurrences : 1,
    };
  }

  async mkdir(args: JsonObject, invocation: FilesToolInvocation): Promise<JsonObject> {
    const routing = FILES_POLICY_V3_PATH_ROUTING;
    const result = await this.port.mkdir(
      requiredPath(args.path, routing, invocation),
      optionalBoolean(args.recursive) ?? true,
      invocation.signal,
      routing,
    );
    return mutationJson(result);
  }

  async move(args: JsonObject, invocation: FilesToolInvocation): Promise<JsonObject> {
    const routing = FILES_POLICY_V3_PATH_ROUTING;
    const from = requiredPath(args.from, routing, invocation);
    const to = requiredPath(args.to, routing, invocation);
    if (from === to || to.startsWith(`${from}/`)) {
      throw invalidFault("Move destination is the source or its descendant");
    }
    if (
      filesPathRoutingMode(routing) === "policy_v3" &&
      filesStorageClassForPath(to) === "shared"
    ) {
      assertSharedPublicationAllowed(to, invocation, routing);
    }
    const result = await this.port.move(
      from,
      to,
      optionalBoolean(args.overwrite) ?? false,
      invocation.signal,
      routing,
    );
    return { from, to, ...mutationJson(result) };
  }

  async remove(args: JsonObject, invocation: FilesToolInvocation): Promise<JsonObject> {
    const routing = FILES_POLICY_V3_PATH_ROUTING;
    const result = await this.port.remove(
      requiredPath(args.path, routing, invocation),
      optionalBoolean(args.recursive) ?? false,
      invocation.signal,
      undefined,
      routing,
    );
    return { removed: result.changed, ...mutationJson(result) };
  }

  async ui(
    action: FilesServiceUiAction,
    invocation: FilesToolInvocation,
  ): Promise<JsonObject> {
    switch (action.action) {
      case "status":
        return statusJson(await this.port.status());
      case "initialize":
        return statusJson(await this.port.initialize());
      case "unlock":
        return statusJson(await this.port.unlock());
      case "lock":
        this.#fenceContinuations();
        return statusJson(await this.port.lock());
      case "rotate":
        return statusJson(await this.port.rotate());
      case "upload_begin": {
        const upload = await this.port.beginUpload({
          transferId: action.transferId,
          path: requiredPath(
            action.path,
            FILES_POLICY_V3_PATH_ROUTING,
            invocation,
          ),
          name: action.name,
          mediaType: normalizeMediaType(action.mediaType),
          size: action.size,
          contentKind: "binary",
        }, FILES_POLICY_V3_PATH_ROUTING);
        return {
          transferId: upload.transferId,
          chunkBytes: upload.chunkBytes,
        };
      }
      case "cancel":
        this.#dropDownloadForTransfer(action.transferId);
        return statusJson(await this.port.cancel(action.transferId));
      case "retry":
        return statusJson(await this.port.retry(action.transferId));
    }
  }

  async uploadChunk(
    args: JsonObject,
    data: ArrayBuffer,
    invocation: FilesToolInvocation,
  ): Promise<JsonObject> {
    const transferId = requiredString(args.transferId, "transferId");
    if (!/^[A-Za-z0-9_-]{1,96}$/u.test(transferId)) {
      throw invalidFault("transferId is invalid");
    }
    const ordinal = optionalInteger(
      args.ordinal,
      0,
      0xffff_ffff,
      "ordinal",
    );
    const totalBytes = optionalInteger(
      args.totalBytes,
      0,
      FILES_SERVICE_LIMITS.tileBinaryBytes,
      "totalBytes",
    );
    if (ordinal === undefined || totalBytes === undefined) {
      throw invalidFault("Upload ordinal and totalBytes are required");
    }
    if (
      !(data instanceof ArrayBuffer) ||
      data.byteLength > FILES_SERVICE_LIMITS.tileChunkBytes
    ) {
      throw limitFault(
        `OS upload chunk exceeds ${FILES_SERVICE_LIMITS.tileChunkBytes.toLocaleString("en-US")} bytes`,
      );
    }
    if (args.pass !== "hash" && args.pass !== "encrypt") {
      throw invalidFault("Upload pass is invalid");
    }
    const result = await this.port.uploadChunk(
      {
        transferId,
        pass: args.pass,
        ordinal,
        final: requiredBoolean(args.final, "final"),
        totalBytes,
      },
      data,
      {
        ...this.#controls(invocation),
        // Kernel serializes one inbound attachment invocation with the
        // resident's self-calls. Let the final chunk return before the
        // encrypted backend commit, and expose completion through status.
        deferFinalCommit: true,
      },
    );
    return {
      transferId: result.transferId,
      phase: result.phase,
      processedBytes: result.processedBytes,
      totalBytes: result.totalBytes,
      committed: result.committed,
      readyForUpload: result.readyForUpload,
      entry: result.entry ? entryJson(result.entry) : null,
    };
  }

  clear(): void {
    this.#fenceContinuations();
    this.port.clearVolatile();
  }

  clearContinuations(): void {
    this.#fenceContinuations();
  }

  #scope(invocation: FilesToolInvocation): FilesContinuationScope {
    if (
      !invocation.callerEndpoint ||
      !invocation.callerSession
    ) {
      throw invalidFault("A kernel-attested caller session is required");
    }
    return {
      callerEndpoint: invocation.callerEndpoint,
      callerSession: invocation.callerSession,
      installationGeneration: this.binding.installationGeneration(),
      lockEpoch:
        this.#continuationEpoch.toString() as CanonicalNat64,
    };
  }

  #fenceContinuations(): void {
    this.#continuations.clear();
    this.#dropDownload();
    this.#continuationEpoch =
      this.#continuationEpoch >= 0xffff_ffff_ffff_ffffn
        ? 0n
        : this.#continuationEpoch + 1n;
  }

  #dropDownloadForTransfer(transferId: string): void {
    if (this.#download?.transferId === transferId) {
      this.#dropDownload(this.#download);
    }
  }

  #dropDownload(expected?: FilesDownloadStage): void {
    const stage = this.#download;
    if (stage === null || (expected !== undefined && stage !== expected)) {
      return;
    }
    if (this.#downloadExpiry !== null) {
      clearTimeout(this.#downloadExpiry);
      this.#downloadExpiry = null;
    }
    stage.bytes?.fill(0);
    stage.lastChunk?.fill(0);
    stage.bytes = null;
    stage.lastChunk = null;
    stage.lastValue = null;
    stage.lastOrdinal = null;
    stage.entry = null;
    stage.mediaType = null;
    this.#download = null;
  }

  #armDownloadExpiry(stage: FilesDownloadStage): void {
    if (
      this.#download !== stage ||
      (stage.bytes === null && stage.lastChunk === null)
    ) {
      return;
    }
    if (this.#downloadExpiry !== null) {
      clearTimeout(this.#downloadExpiry);
    }
    this.#downloadExpiry = setTimeout(() => {
      this.#downloadExpiry = null;
      this.#dropDownload(stage);
    }, this.#downloadIdleMs);
  }

  #controls(invocation: FilesToolInvocation) {
    return {
      ...(invocation.signal ? { signal: invocation.signal } : {}),
      ...(invocation.reportProgress
        ? {
            onProgress: (progress: {
              phase: string;
              plaintextBytes: number;
              processedBytes: number;
              blockIndex: number;
              blockCount: number;
            }) =>
              invocation.reportProgress?.({
                phase: progress.phase,
                plaintextBytes: progress.plaintextBytes,
                processedBytes: progress.processedBytes,
                blockIndex: progress.blockIndex,
                blockCount: progress.blockCount,
              }),
          }
        : {}),
    };
  }

  async #readText(
    path: string,
    signal: AbortSignal | undefined,
    routing: FilesPathRouting,
  ): Promise<FilesServiceFile> {
    const expected = await this.port.stat(path, signal, routing);
    assertBoundedTextMetadata(expected);
    const file = await this.port.read(path, {
      ...(signal ? { signal } : {}),
    }, routing);
    assertSameReadableFile(expected, file);
    decodeText(file.bytes);
    return file;
  }
}

export function invocationFromCaller(
  caller:
    | {
        endpoint?: string;
        sessionId?: string;
        appId?: string;
        role?: string;
      }
    | undefined,
  input: Pick<
    FilesToolInvocation,
    "signal" | "reportProgress" | "agentMode"
  > = {},
): FilesToolInvocation {
  if (
    typeof caller?.endpoint !== "string" ||
    caller.endpoint.length === 0 ||
    typeof caller.sessionId !== "string" ||
    caller.sessionId.length === 0
  ) {
    throw invalidFault("A kernel-attested caller session is required");
  }
  return {
    callerEndpoint: caller.endpoint,
    callerSession: caller.sessionId,
    ...(typeof caller.appId === "string"
      ? { callerAppId: caller.appId }
      : {}),
    ...(typeof caller.role === "string"
      ? { callerRole: caller.role }
      : {}),
    ...input,
  };
}

function assertSharedPublicationAllowed(
  path: string,
  invocation: FilesToolInvocation,
  routing: FilesPathRouting,
): void {
  if (filesPathRoutingMode(routing) !== "policy_v3") return;
  if (filesStorageClassForPath(path) !== "shared") return;
  if (
    isFilesTileInvocation(invocation) ||
    invocation.agentMode === true
  ) {
    return;
  }
  throw new FilesServiceFault(
    "invalid",
    "Publishing files in Shared requires Files or Agent Mode",
    "Open Files or start an owner-authorized Agent Mode turn",
  );
}

function isFilesTileInvocation(invocation: FilesToolInvocation): boolean {
  return (
    invocation.callerAppId === "files" &&
    invocation.callerRole === "tile"
  );
}

function entryJson(entry: FilesServiceEntry): JsonObject {
  return {
    path: entry.path,
    name: entry.name,
    type: entry.type,
    storageClass:
      entry.storageClass ??
      filesStorageClassForPath(entry.path) ??
      "workspace",
    contentKind: entry.contentKind,
    byteLength: entry.byteLength,
    mediaType: entry.mediaType,
    etag: entry.etagSha256,
    publicUrl: entry.publicUrl ?? null,
    createdAtNs: entry.createdAtNs,
    modifiedAtNs: entry.modifiedAtNs,
    revision: entry.structuralRevision,
  };
}

function writeJson(
  entry: FilesServiceEntry,
  cleanupPending: boolean,
): JsonObject {
  return { ...entryJson(entry), cleanupPending };
}

function mutationJson(input: {
  path: string;
  structuralRevision: CanonicalNat64;
  changed: number;
  cleanupPending: boolean;
}): JsonObject {
  return {
    path: input.path,
    revision: input.structuralRevision,
    changed: input.changed,
    cleanupPending: input.cleanupPending,
  };
}

function statusJson(
  status: Awaited<ReturnType<FilesResidentFilePort["status"]>>,
): JsonObject {
  return {
    vault: status.vault,
    lockEpoch: status.lockEpoch,
    currentGeneration: status.currentGeneration,
    previousGeneration: status.previousGeneration,
    rotationRequired: status.rotationRequired,
    reason: status.reason,
    quota: { ...status.quota },
    publicUsage: {
      current: { ...status.publicUsage.current },
      manifestLimits: { ...status.publicUsage.manifestLimits },
      effectiveLimits: { ...status.publicUsage.effectiveLimits },
    },
    transfers: status.transfers.map((transfer) => ({ ...transfer })),
  };
}

function decodeText(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > FILES_SERVICE_LIMITS.textBytes) {
    throw limitFault("Text file exceeds 512 KiB");
  }
  try {
    return decoder.decode(bytes);
  } catch {
    throw new FilesServiceFault(
      "not_text",
      "File is not strict UTF-8 text",
      "Use readBinary",
    );
  }
}

function bytesSource(
  bytes: Uint8Array,
  name: string,
  type: string,
) {
  return {
    size: bytes.byteLength,
    name,
    type,
    slice(start: number, end: number): Uint8Array {
      return bytes.slice(start, end);
    },
  };
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function cloneDownloadValue(value: JsonObject): JsonObject {
  const entry = value.entry;
  return {
    ...value,
    ...(typeof entry === "object" && entry !== null && !Array.isArray(entry)
      ? { entry: { ...(entry as JsonObject) } }
      : {}),
  };
}

function cursorFault(error: unknown): FilesServiceFault {
  if (error instanceof FilesContinuationError) {
    return new FilesServiceFault(
      "cursor_expired",
      "The Files list cursor expired or belongs to another caller",
      "Restart the list from the same path",
      { cursorCode: error.code },
      { cause: error },
    );
  }
  return new FilesServiceFault(
    "cursor_expired",
    "The Files list cursor is unavailable",
    "Restart the list from the same path",
    {},
    { cause: error },
  );
}

function assertDownloadMetadata(
  entry: FilesServiceEntry,
  path: string,
  etagSha256: string,
): asserts entry is FilesServiceFile["entry"] {
  if (
    entry.type !== "file" ||
    entry.path !== path ||
    entry.byteLength === null ||
    entry.etagSha256 === null
  ) {
    throw invalidFault("Download path is not a readable file");
  }
  if (entry.etagSha256 !== etagSha256) {
    throw conflictFault(entry);
  }
  if (entry.byteLength > FILES_SERVICE_LIMITS.tileBinaryBytes) {
    throw limitFault("File exceeds the 64 MiB Files download limit");
  }
}

function assertBoundedTextMetadata(
  entry: FilesServiceEntry,
): asserts entry is FilesServiceFile["entry"] {
  if (entry.type !== "file" || entry.contentKind !== "text") {
    throw new FilesServiceFault(
      "not_text",
      "File is not strict UTF-8 text",
      "Use readBinary",
    );
  }
  if (
    entry.byteLength === null ||
    entry.byteLength > FILES_SERVICE_LIMITS.textBytes
  ) {
    throw limitFault("Text file exceeds 512 KiB");
  }
}

function assertBoundedAttachmentMetadata(
  entry: FilesServiceEntry,
): asserts entry is FilesServiceFile["entry"] {
  if (
    entry.type !== "file" ||
    entry.byteLength === null ||
    entry.etagSha256 === null
  ) {
    throw invalidFault("Path is not a readable file");
  }
  if (entry.byteLength > FILES_SERVICE_LIMITS.binaryBytes) {
    throw limitFault("Binary file exceeds the 16 MiB app attachment limit");
  }
}

function assertSameReadableFile(
  expected: FilesServiceEntry & {
    type: "file";
    byteLength: number;
  },
  file: FilesServiceFile,
): void {
  if (
    file.entry.path !== expected.path ||
    file.entry.etagSha256 !== expected.etagSha256
  ) {
    throw conflictFault(file.entry);
  }
  if (
    file.entry.byteLength !== expected.byteLength ||
    file.entry.contentKind !== expected.contentKind ||
    file.bytes.byteLength !== expected.byteLength
  ) {
    throw new FilesServiceFault(
      "incompatible",
      "Files returned inconsistent verified file bytes",
      "Reload Files and retry",
    );
  }
}

function conflictFault(entry: FilesServiceEntry): FilesServiceFault {
  return new FilesServiceFault(
    "conflict",
    "The file changed since the supplied etag",
    "Read the current file and merge or save as a copy",
    {
      path: entry.path,
      etag: entry.etagSha256,
      revision: entry.structuralRevision,
    },
  );
}

function invalidFault(message: string): FilesServiceFault {
  return new FilesServiceFault(
    "invalid",
    message,
    "Correct the request and retry",
  );
}

function limitFault(message: string): FilesServiceFault {
  return new FilesServiceFault(
    "limit",
    message,
    "Reduce the request size and retry",
  );
}

function cancelledFault(message: string): FilesServiceFault {
  return new FilesServiceFault(
    "cancelled",
    message,
    "Start the download again",
  );
}

function requiredPath(
  value: unknown,
  routing: FilesPathRouting,
  invocation: FilesToolInvocation,
): string {
  return pathForInvocation(
    requiredString(value, "path"),
    routing,
    invocation,
  );
}

function pathForInvocation(
  value: string,
  routing: FilesPathRouting,
  invocation: FilesToolInvocation,
): string {
  const path = normalizeFilesPathForRouting(value, routing);
  if (
    filesPathRoutingMode(routing) !== "policy_v3" ||
    parseFilesRootedPath(path) !== null
  ) {
    return path;
  }
  if (isFilesTileInvocation(invocation) && path === "/") return path;
  return filesVirtualPath("workspace", path);
}

function requiredString(
  value: unknown,
  label: string,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw invalidFault(`${label} must be a string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, "value", true);
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw invalidFault("Expected a boolean");
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw invalidFault(`${label} must be a boolean`);
  }
  return value;
}

function optionalInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw invalidFault(`${label} is outside its allowed range`);
  }
  return Number(value);
}

function optionalEtag(value: unknown): string | undefined {
  const etag = optionalString(value);
  if (etag !== undefined && !ETAG_PATTERN.test(etag)) {
    throw invalidFault("etag must be a lowercase SHA-256 hex string");
  }
  return etag;
}

function requiredObjectArray(value: unknown, label: string): JsonObject[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (item) =>
        typeof item !== "object" ||
        item === null ||
        Array.isArray(item),
    )
  ) {
    throw invalidFault(`${label} must be an array of objects`);
  }
  return value as JsonObject[];
}

function normalizeMediaType(value: string): string {
  const normalized = value.trim().toLowerCase();
  const bytes = encoder.encode(normalized).byteLength;
  if (
    bytes < 3 ||
    bytes > FILES_SERVICE_LIMITS.mediaTypeBytes ||
    !/^[\x20-\x7e]+$/u.test(normalized) ||
    normalized.includes("\r") ||
    normalized.includes("\n")
  ) {
    throw invalidFault("mediaType is invalid");
  }
  return normalized;
}

function attachmentMediaType(mediaType: string): string {
  return mediaType.split(";", 1)[0]!.trim().toLowerCase();
}

function safeAttachmentMediaType(mediaType: string | null): string {
  const normalized = attachmentMediaType(
    mediaType ?? "application/octet-stream",
  );
  return TOOL_ATTACHMENT_MEDIA_TYPES.has(normalized)
    ? normalized
    : "application/octet-stream";
}

function inferTextMediaType(path: string): string {
  return path.toLowerCase().endsWith(".md")
    ? "text/markdown;charset=utf-8"
    : path.toLowerCase().endsWith(".json")
      ? "application/json"
      : path.toLowerCase().endsWith(".csv")
        ? "text/csv;charset=utf-8"
        : "text/plain;charset=utf-8";
}

function leafName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const found = value.indexOf(needle, offset);
    if (found < 0) return count;
    count += 1;
    offset = found + needle.length;
  }
}
