import {
  querySelf,
  updateSelf,
  type JsonObject,
  type JsonValue,
  type SelfCallObject,
  type SelfCallValue,
} from "neutron-tools/app";
import { FILES_V2_LIMITS } from "./constants.ts";
import {
  isCanonicalPlainFilesName,
  isCanonicalPlainFilesPath,
} from "./plain_paths.ts";
import type { CanonicalNat64 } from "./types.ts";

const PLAIN_BLOCK_BYTES = FILES_V2_LIMITS.normalPlaintextBlockBytes;
const PLAIN_FILE_BYTES = FILES_V2_LIMITS.binaryFileBytes;
const PLAIN_PATH_BYTES = 1_024;
const MAX_PLAIN_BLOCKS = 36;

export const FILES_PLAIN_METHODS = Object.freeze({
  list: "files_plain_list_v3",
  stat: "files_plain_stat_v3",
  readChunk: "files_plain_read_chunk_v3",
  writeBlock: "files_plain_write_block_v3",
  mkdir: "files_plain_mkdir_v3",
  move: "files_plain_move_v3",
  remove: "files_plain_remove_v3",
  abort: "files_plain_abort_v3",
  cleanup: "files_plain_cleanup_v3",
});

export type FilesPlainSpace = "shared" | "workspace";

export type FilesPlainCursor = Readonly<{
  after: string;
  revision: CanonicalNat64;
  parentNodeId: CanonicalNat64;
  /** Resident-only progress binding; never serialized into the Candid record. */
  seen: number;
  /** Resident-only first-page total binding; never serialized into Candid. */
  total: number;
}>;

export type FilesPlainEntry = Readonly<{
  nodeId: CanonicalNat64;
  path: string;
  name: string;
  type: "file" | "folder";
  contentKind: "text" | "binary" | null;
  byteLength: number | null;
  mediaType: string | null;
  etagSha256: string | null;
  createdAtNs: CanonicalNat64;
  modifiedAtNs: CanonicalNat64;
  revision: CanonicalNat64;
  relativeUrl: string | null;
}>;

export type FilesPlainWriteMoveSource = Readonly<{
  path: string;
  expectedNodeId: CanonicalNat64;
  expectedRevision: CanonicalNat64;
  ifMatch: string | null;
}>;

export type FilesPlainList = Readonly<{
  revision: CanonicalNat64;
  entries: readonly FilesPlainEntry[];
  total: number;
  cursor: FilesPlainCursor | null;
  hasMore: boolean;
}>;

export type FilesPlainWriteInput = Readonly<{
  requestId: string;
  space: FilesPlainSpace;
  path: string;
  stageId: CanonicalNat64 | null;
  blockIndex: number;
  blockCount: number;
  totalBytes: number;
  contentKind: "text" | "binary";
  mediaType: string;
  etagSha256: string;
  presentation: "inline_text" | "attachment" | null;
  ifMatch: string | null;
  expectedNodeId: CanonicalNat64 | null;
  expectedRevision: CanonicalNat64 | null;
  ifNoneMatch: boolean;
  createParents: boolean;
  final: boolean;
  safeName: string | null;
  beginNonce: Uint8Array | null;
  commitNonce: Uint8Array | null;
  deleteNonce: Uint8Array | null;
  moveSource: FilesPlainWriteMoveSource | null;
  body: Uint8Array;
}>;

export type FilesPlainWriteResult = Readonly<{
  stageId: CanonicalNat64 | null;
  committed: boolean;
  entry: FilesPlainEntry | null;
}>;

export type FilesPlainMutationResult = Readonly<{
  path: string;
  revision: CanonicalNat64;
  changed: number;
}>;

export type FilesPlainTransport = Readonly<{
  query(
    method: string,
    args: SelfCallValue[],
    timeoutSeconds: number,
  ): Promise<SelfCallValue>;
  update(
    method: string,
    args: SelfCallValue[],
    timeoutSeconds: number,
  ): Promise<SelfCallValue>;
}>;

const DEFAULT_TRANSPORT: FilesPlainTransport = Object.freeze({
  query: (method, args, timeoutSeconds) =>
    querySelf<SelfCallValue>(method, args, timeoutSeconds),
  update: (method, args, timeoutSeconds) =>
    updateSelf<SelfCallValue>(method, args, timeoutSeconds),
});

export class FilesPlainBackendError extends Error {
  constructor(
    readonly reason: string,
    message = `Files backend rejected the request: ${reason}`,
  ) {
    super(message);
    this.name = "FilesPlainBackendError";
  }
}

export class FilesPlainBackendProtocolError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "FilesPlainBackendProtocolError";
  }
}

export class FilesPlainBackendAdapter {
  constructor(
    private readonly transport: FilesPlainTransport = DEFAULT_TRANSPORT,
  ) {}

  async list(input: {
    space: FilesPlainSpace;
    path: string;
    cursor: FilesPlainCursor | null;
    limit: number;
  }): Promise<FilesPlainList> {
    const ok = await this.#query(FILES_PLAIN_METHODS.list, {
      space: spaceVariant(input.space),
      path: input.path,
      ...(input.cursor === null
        ? {}
        : {
            cursor: {
              after: input.cursor.after,
              revision: input.cursor.revision,
              parent_node_id: input.cursor.parentNodeId,
            },
          }),
      limit: input.limit,
    });
    try {
      return parsePlainListResponse(input, ok);
    } catch (error) {
      throw asPlainProtocolError(error);
    }
  }

  async stat(input: {
    space: FilesPlainSpace;
    path: string;
  }): Promise<FilesPlainEntry> {
    const ok = await this.#query(FILES_PLAIN_METHODS.stat, {
      space: spaceVariant(input.space),
      path: input.path,
    });
    try {
      const entry = parseEntry(ok);
      assertPlainWireEntry(input.space, entry, input.path);
      return entry;
    } catch (error) {
      throw asPlainProtocolError(error);
    }
  }

  async readChunk(input: {
    space: FilesPlainSpace;
    path: string;
    blockIndex: number;
  }): Promise<Readonly<{
    entry: FilesPlainEntry;
    blockIndex: number;
    blockCount: number;
    body: Uint8Array;
  }>> {
    if (
      !Number.isSafeInteger(input.blockIndex) ||
      input.blockIndex < 0 ||
      input.blockIndex >= MAX_PLAIN_BLOCKS
    ) {
      throw new Error("Files plain read requested an invalid block index");
    }
    const raw = await this.transport.query(
      FILES_PLAIN_METHODS.readChunk,
      [
        {
          space: spaceVariant(input.space),
          path: input.path,
          block_index: input.blockIndex,
        },
      ],
      45,
    );
    const output = record(raw, "plain read output");
    const bodyValue = output.body;
    if (!(bodyValue instanceof Uint8Array)) {
      throw new Error("Files plain read returned an invalid body");
    }
    return parseReadChunkOutput(
      output.value,
      bodyValue,
      input.blockIndex,
      input.space,
      input.path,
    );
  }

  async writeBlock(
    input: FilesPlainWriteInput,
  ): Promise<FilesPlainWriteResult> {
    const ok = await this.#update(FILES_PLAIN_METHODS.writeBlock, {
      request_id: input.requestId,
      space: spaceVariant(input.space),
      path: input.path,
      ...(input.stageId === null ? {} : { stage_id: input.stageId }),
      block_index: input.blockIndex,
      block_count: input.blockCount,
      total_bytes: input.totalBytes.toString(),
      content_kind: variant(input.contentKind),
      media_type: input.mediaType,
      etag_sha256: input.etagSha256,
      ...(input.presentation === null
        ? {}
        : { presentation: variant(input.presentation) }),
      ...(input.ifMatch === null ? {} : { if_match: input.ifMatch }),
      ...(input.expectedNodeId === null
        ? {}
        : { expected_node_id: input.expectedNodeId }),
      ...(input.expectedRevision === null
        ? {}
        : { expected_revision: input.expectedRevision }),
      if_none_match: input.ifNoneMatch,
      create_parents: input.createParents,
      final: input.final,
      ...(input.safeName === null ? {} : { safe_name: input.safeName }),
      ...(input.beginNonce === null
        ? {}
        : { begin_nonce: input.beginNonce }),
      ...(input.commitNonce === null
        ? {}
        : { commit_nonce: input.commitNonce }),
      ...(input.deleteNonce === null
        ? {}
        : { delete_nonce: input.deleteNonce }),
      ...(input.moveSource === null
        ? {}
        : {
            move_source: {
              path: input.moveSource.path,
              expected_node_id: input.moveSource.expectedNodeId,
              expected_revision: input.moveSource.expectedRevision,
              ...(input.moveSource.ifMatch === null
                ? {}
                : { if_match: input.moveSource.ifMatch }),
            },
          }),
      body_bytes: input.body.byteLength,
      body: input.body,
    });
    try {
      return {
        stageId:
          isAbsent(ok.stage_id)
            ? null
            : decimal(ok.stage_id, "plain write stage_id"),
        committed: boolean(ok.committed, "plain write committed"),
        entry: isAbsent(ok.entry) ? null : parseEntry(ok.entry),
      };
    } catch (error) {
      throw asPlainProtocolError(error);
    }
  }

  mkdir(input: {
    requestId: string;
    space: FilesPlainSpace;
    path: string;
    recursive: boolean;
  }): Promise<FilesPlainMutationResult> {
    return this.#mutation(FILES_PLAIN_METHODS.mkdir, {
      request_id: input.requestId,
      space: spaceVariant(input.space),
      path: input.path,
      recursive: input.recursive,
    });
  }

  move(input: {
    requestId: string;
    space: FilesPlainSpace;
    from: string;
    to: string;
    overwrite: boolean;
    expectedNodeId: CanonicalNat64;
    expectedRevision: CanonicalNat64;
    ifMatch: string | null;
  }): Promise<FilesPlainMutationResult> {
    return this.#mutation(FILES_PLAIN_METHODS.move, {
      request_id: input.requestId,
      space: spaceVariant(input.space),
      from: input.from,
      to: input.to,
      overwrite: input.overwrite,
      expected_node_id: input.expectedNodeId,
      expected_revision: input.expectedRevision,
      ...(input.ifMatch === null ? {} : { if_match: input.ifMatch }),
    });
  }

  remove(input: {
    requestId: string;
    space: FilesPlainSpace;
    path: string;
    recursive: boolean;
    expectedNodeId: CanonicalNat64;
    expectedRevision: CanonicalNat64;
    ifMatch: string | null;
    deleteNonce: Uint8Array | null;
  }): Promise<FilesPlainMutationResult> {
    return this.#mutation(FILES_PLAIN_METHODS.remove, {
      request_id: input.requestId,
      space: spaceVariant(input.space),
      path: input.path,
      recursive: input.recursive,
      expected_node_id: input.expectedNodeId,
      expected_revision: input.expectedRevision,
      ...(input.ifMatch === null ? {} : { if_match: input.ifMatch }),
      ...(input.deleteNonce === null
        ? {}
        : { delete_nonce: input.deleteNonce }),
    });
  }

  abort(input: {
    requestId: string;
    space: FilesPlainSpace;
    stageId: CanonicalNat64 | null;
  }): Promise<FilesPlainMutationResult> {
    return this.#mutation(FILES_PLAIN_METHODS.abort, {
      request_id: input.requestId,
      space: spaceVariant(input.space),
      ...(input.stageId === null ? {} : { stage_id: input.stageId }),
    });
  }

  cleanup(input: {
    requestId: string;
    limit: number;
  }): Promise<FilesPlainMutationResult> {
    return this.#mutation(FILES_PLAIN_METHODS.cleanup, {
      request_id: input.requestId,
      limit: input.limit,
    });
  }

  async #mutation(
    method: string,
    request: SelfCallObject,
  ): Promise<FilesPlainMutationResult> {
    const ok = await this.#update(method, request);
    try {
      return {
        path: string(ok.path, "plain mutation path"),
        revision: decimal(ok.revision, "plain mutation revision"),
        changed: integer(ok.changed, "plain mutation changed"),
      };
    } catch (error) {
      throw asPlainProtocolError(error);
    }
  }

  async #query(method: string, request: SelfCallObject): Promise<JsonObject> {
    const response = await this.transport.query(method, [request], 45);
    try {
      return parseOutcome(response);
    } catch (error) {
      if (error instanceof FilesPlainBackendError) throw error;
      throw asPlainProtocolError(error);
    }
  }

  async #update(method: string, request: SelfCallObject): Promise<JsonObject> {
    const response = await this.transport.update(method, [request], 300);
    try {
      return parseOutcome(response);
    } catch (error) {
      if (error instanceof FilesPlainBackendError) throw error;
      throw asPlainProtocolError(error);
    }
  }
}

function parsePlainListResponse(
  input: {
    space: FilesPlainSpace;
    path: string;
    cursor: FilesPlainCursor | null;
    limit: number;
  },
  ok: JsonObject,
): FilesPlainList {
  const revision = decimal(ok.revision, "plain list revision");
  const entries = array(ok.entries, "plain list entries").map(parseEntry);
  const total = integer(ok.total, "plain list total");
  const wireCursor =
    isAbsent(ok.next_cursor)
      ? null
      : parseCursor(record(ok.next_cursor, "plain list cursor"));
  const hasMore = boolean(ok.has_more, "plain list has_more");
  const seenBefore = input.cursor?.seen ?? 0;
  const seen = seenBefore + entries.length;
  const cursor =
    wireCursor === null
      ? null
      : Object.freeze({
          ...wireCursor,
          seen,
          total,
        });
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > FILES_V2_LIMITS.directChildPageMaximum ||
    entries.length > input.limit ||
    entries.length > FILES_V2_LIMITS.directChildPageMaximum ||
    total > FILES_V2_LIMITS.nodes ||
    total < entries.length ||
    seen > total ||
    hasMore !== (cursor !== null) ||
    (hasMore && entries.length === 0) ||
    (hasMore && seen >= total) ||
    (input.cursor !== null && entries.length === 0) ||
    (!hasMore && seen !== total)
  ) {
    throw new Error("Files plain list geometry is inconsistent");
  }
  if (
    input.cursor !== null &&
    (
      !validPlainWireName(input.cursor.after) ||
      input.cursor.parentNodeId === "0" ||
      input.cursor.revision !== revision ||
      !Number.isSafeInteger(input.cursor.seen) ||
      input.cursor.seen < 1 ||
      !Number.isSafeInteger(input.cursor.total) ||
      input.cursor.total < 1 ||
      input.cursor.seen >= input.cursor.total ||
      input.cursor.total !== total
    )
  ) {
    throw new Error("Files plain list did not preserve its cursor");
  }
  const names = new Set<string>();
  const nodeIds = new Set<CanonicalNat64>();
  let previousName = input.cursor?.after ?? null;
  for (const entry of entries) {
    assertPlainWireEntry(
      input.space,
      entry,
      joinPlainWireChild(input.path, entry.name),
    );
    if (
      names.has(entry.name) ||
      nodeIds.has(entry.nodeId) ||
      (previousName !== null &&
        comparePlainWireNames(previousName, entry.name) >= 0)
    ) {
      throw new Error(
        "Files plain list entries are duplicate or out of order",
      );
    }
    names.add(entry.name);
    nodeIds.add(entry.nodeId);
    previousName = entry.name;
  }
  if (cursor !== null) {
    const last = entries.at(-1);
    if (
      last === undefined ||
      cursor.after !== last.name ||
      cursor.revision !== revision ||
      cursor.parentNodeId === "0" ||
      cursor.seen !== seen ||
      cursor.total !== total ||
      (input.cursor !== null &&
        cursor.parentNodeId !== input.cursor.parentNodeId)
    ) {
      throw new Error("Files plain list continuation is inconsistent");
    }
  }
  return {
    revision,
    entries,
    total,
    cursor,
    hasMore,
  };
}

function assertPlainWireEntry(
  space: FilesPlainSpace,
  entry: FilesPlainEntry,
  expectedPath: string,
): void {
  assertPlainWirePathIdentity(space, entry, expectedPath);
  if (entry.type === "folder") {
    if (
      entry.contentKind !== null ||
      entry.byteLength !== null ||
      entry.mediaType !== null ||
      entry.etagSha256 !== null ||
      entry.relativeUrl !== null
    ) {
      throw new Error("Files plain folder fields are inconsistent");
    }
    return;
  }
  if (
    entry.contentKind === null ||
    entry.byteLength === null ||
    entry.mediaType === null ||
    entry.etagSha256 === null ||
    entry.byteLength > PLAIN_FILE_BYTES ||
    !validPlainWireMediaType(entry.mediaType) ||
    !/^[a-f0-9]{64}$/u.test(entry.etagSha256) ||
    (
      space === "workspace"
        ? entry.relativeUrl !== null
        : !validPlainWireSharedUrl(entry.relativeUrl, entry.path)
    )
  ) {
    throw new Error("Files plain file fields are inconsistent");
  }
}

function assertPlainWirePathIdentity(
  space: FilesPlainSpace,
  entry: FilesPlainEntry,
  expectedPath: string,
): void {
  const expectedName =
    expectedPath === "/"
      ? ""
      : expectedPath.slice(expectedPath.lastIndexOf("/") + 1);
  if (
    entry.nodeId === "0" ||
    entry.path !== expectedPath ||
    !validPlainWirePath(space, entry.path) ||
    entry.name !== expectedName ||
    (expectedPath !== "/" && !validPlainWireName(entry.name))
  ) {
    throw new Error("Files plain entry does not match the requested path");
  }
}

function joinPlainWireChild(parentPath: string, name: string): string {
  return parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
}

function validPlainWirePath(
  space: FilesPlainSpace,
  value: string,
): boolean {
  if (
    value === "" ||
    utf8WireLength(value) > PLAIN_PATH_BYTES ||
    !value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes("//") ||
    (value !== "/" && value.endsWith("/")) ||
    !isCanonicalPlainFilesPath(value) ||
    [...value].length >
      (
        space === "shared"
          ? FILES_V2_LIMITS.sharedRelativePathScalars
          : FILES_V2_LIMITS.workspaceRelativePathScalars
      )
  ) {
    return false;
  }
  const segments = value.split("/").filter(Boolean);
  return (
    segments.length <= FILES_V2_LIMITS.treeDepth &&
    segments.every(validPlainWireName)
  );
}

function validPlainWireName(value: string): boolean {
  return isCanonicalPlainFilesName(value);
}

function validPlainWireMediaType(value: string): boolean {
  const bytes = new TextEncoder().encode(value);
  return (
    bytes.byteLength <= 128 &&
    bytes.every((byte) => byte >= 32 && byte <= 126)
  );
}

function validPlainWireSharedUrl(
  value: string | null,
  path: string,
): boolean {
  if (value === null) return false;
  const match = value.match(
    /^\/app\/files\/_route\/shares\/[0-9a-f]{64}\/([A-Za-z0-9._-]{1,100})$/u,
  );
  return (
    match !== null &&
    match[1] !== "." &&
    match[1] !== ".." &&
    match[1] === safePlainWireName(path)
  );
}

function safePlainWireName(path: string): string {
  const raw = path.split("/").at(-1) ?? "file";
  const safe = raw
    .normalize("NFC")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 100);
  return safe && safe !== "." && safe !== ".." ? safe : "file";
}

function comparePlainWireNames(left: string, right: string): number {
  const leftScalars = [...left];
  const rightScalars = [...right];
  const common = Math.min(leftScalars.length, rightScalars.length);
  for (let index = 0; index < common; index += 1) {
    const leftCodePoint = leftScalars[index]!.codePointAt(0)!;
    const rightCodePoint = rightScalars[index]!.codePointAt(0)!;
    if (leftCodePoint !== rightCodePoint) {
      return leftCodePoint < rightCodePoint ? -1 : 1;
    }
  }
  return leftScalars.length === rightScalars.length
    ? 0
    : leftScalars.length < rightScalars.length
      ? -1
      : 1;
}

function utf8WireLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function asPlainProtocolError(
  error: unknown,
): FilesPlainBackendProtocolError {
  if (error instanceof FilesPlainBackendProtocolError) return error;
  const message =
    error instanceof Error ? error.message : String(error);
  return new FilesPlainBackendProtocolError(
    `Files plain response was invalid: ${message}`,
    { cause: error },
  );
}

function parseReadChunkOutput(
  value: unknown,
  body: Uint8Array,
  requestedBlockIndex: number,
  space: FilesPlainSpace,
  requestedPath: string,
): Readonly<{
  entry: FilesPlainEntry;
  blockIndex: number;
  blockCount: number;
  body: Uint8Array;
}> {
  try {
    const ok = parseOutcome(value);
    const bodyBytes = integer(ok.body_bytes, "plain read body_bytes");
    if (bodyBytes !== body.byteLength) {
      throw new Error(
        "Files plain read body length did not match its record",
      );
    }
    const entry = parseEntry(ok.entry);
    assertPlainWireEntry(space, entry, requestedPath);
    const blockIndex = integer(ok.block_index, "plain read block_index");
    const blockCount = integer(ok.block_count, "plain read block_count");
    if (blockIndex !== requestedBlockIndex) {
      throw new Error("Files plain read returned the wrong block index");
    }
    if (
      blockCount < 1 ||
      blockCount > MAX_PLAIN_BLOCKS ||
      blockIndex >= blockCount
    ) {
      throw new Error("Files plain read returned an invalid block count");
    }
    if (
      entry.type !== "file" ||
      entry.byteLength === null ||
      entry.byteLength > PLAIN_FILE_BYTES
    ) {
      throw new Error("Files plain read returned an invalid file entry");
    }
    const canonicalCount = Math.max(
      1,
      Math.ceil(entry.byteLength / PLAIN_BLOCK_BYTES),
    );
    if (blockCount !== canonicalCount) {
      throw new Error(
        "Files plain read returned a non-canonical block count",
      );
    }
    const expectedBytes =
      blockIndex + 1 === blockCount
        ? entry.byteLength - blockIndex * PLAIN_BLOCK_BYTES
        : PLAIN_BLOCK_BYTES;
    if (
      body.byteLength > PLAIN_BLOCK_BYTES ||
      body.byteLength !== expectedBytes
    ) {
      throw new Error("Files plain read returned a malformed block");
    }
    return {
      entry,
      blockIndex,
      blockCount,
      // Self-call blobs are transferred into this realm and are already
      // caller-owned. The resident wipes each block after copying it into the
      // final bounded output, so another full-sized clone is unnecessary.
      body,
    };
  } catch (error) {
    body.fill(0);
    if (error instanceof FilesPlainBackendError) throw error;
    throw asPlainProtocolError(error);
  }
}

function parseOutcome(value: unknown): JsonObject {
  const outer = record(value, "plain response");
  const outcome = outer.outcome;
  if (outcome === null || outcome === undefined) {
    throw new Error("Files plain response omitted its outcome");
  }
  const tagged = record(outcome, "plain outcome");
  const keys = Object.keys(tagged);
  if (keys.length !== 1) throw new Error("Files plain outcome is invalid");
  if (keys[0] === "ok") return record(tagged.ok, "plain ok");
  if (keys[0] !== "rejected") {
    throw new Error("Files plain outcome has an unknown variant");
  }
  const rejected = record(tagged.rejected, "plain rejection");
  const reasonValue = rejected.reason;
  let reason = "rejected";
  if (!isAbsent(reasonValue)) {
    const reasonKeys = Object.keys(
      record(reasonValue, "plain rejection reason"),
    );
    if (reasonKeys.length !== 1) {
      throw new Error("Files plain rejection reason is invalid");
    }
    reason = reasonKeys[0]!;
  }
  throw new FilesPlainBackendError(reason);
}

function parseEntry(value: unknown): FilesPlainEntry {
  const source = record(value, "plain entry");
  const kind = optionalVariant(source.kind, ["file", "folder"], "kind");
  if (kind === null) throw new Error("Files plain entry omitted kind");
  const contentKind = optionalVariant(
    source.content_kind,
    ["text", "binary"],
    "content_kind",
  );
  const byteLength =
    isAbsent(source.byte_length)
      ? null
      : safeNat(source.byte_length, "plain entry byte_length");
  const entry: FilesPlainEntry = {
    nodeId: decimal(source.node_id, "plain entry node_id"),
    path: string(source.path, "plain entry path"),
    name: string(source.name, "plain entry name"),
    type: kind,
    contentKind,
    byteLength,
    mediaType:
      isAbsent(source.media_type)
        ? null
        : string(source.media_type, "plain entry media_type"),
    etagSha256:
      isAbsent(source.etag_sha256)
        ? null
        : string(source.etag_sha256, "plain entry etag_sha256"),
    createdAtNs: decimal(source.created_at_ns, "plain entry created_at_ns"),
    modifiedAtNs: decimal(
      source.modified_at_ns,
      "plain entry modified_at_ns",
    ),
    revision: decimal(source.revision, "plain entry revision"),
    relativeUrl:
      isAbsent(source.relative_url)
        ? null
        : string(source.relative_url, "plain entry relative_url"),
  };
  if (
    (entry.type === "folder" &&
      (entry.contentKind !== null ||
        entry.byteLength !== null ||
        entry.etagSha256 !== null)) ||
    (entry.type === "file" &&
      (entry.contentKind === null ||
        entry.byteLength === null ||
        entry.etagSha256 === null))
  ) {
    throw new Error("Files plain entry fields are inconsistent");
  }
  return Object.freeze(entry);
}

function parseCursor(
  value: JsonObject,
): Omit<FilesPlainCursor, "seen" | "total"> {
  return Object.freeze({
    after: string(value.after, "plain cursor after"),
    revision: decimal(value.revision, "plain cursor revision"),
    parentNodeId: decimal(
      value.parent_node_id,
      "plain cursor parent_node_id",
    ),
  });
}

function variant(value: string): SelfCallObject {
  return { [value]: null };
}

function spaceVariant(value: FilesPlainSpace): SelfCallObject {
  return variant(value === "shared" ? "shared_" : value);
}

function optionalVariant<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T | null {
  if (isAbsent(value)) return null;
  const tagged = record(value, label);
  const keys = Object.keys(tagged);
  if (keys.length !== 1 || !allowed.includes(keys[0] as T)) {
    throw new Error(`Files plain ${label} is invalid`);
  }
  return keys[0] as T;
}

function isAbsent(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

function record(value: unknown, label: string): JsonObject {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer
  ) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function array(value: unknown, label: string): JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function safeNat(value: unknown, label: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} is outside the supported range`);
  }
  return parsed;
}

function decimal(value: unknown, label: string): CanonicalNat64 {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]*)$/u.test(value) ||
    BigInt(value) > 18_446_744_073_709_551_615n
  ) {
    throw new Error(`${label} must be a canonical Nat64`);
  }
  return value as CanonicalNat64;
}
