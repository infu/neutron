import { FILES_V2_LIMITS } from "../protocol/constants.ts";
import type { CanonicalNat64 } from "../protocol/types.ts";
import type {
  FilesTransferControls,
  FilesTransferSource,
} from "../vault/types.ts";
import {
  filesPathRoutingMode,
  type FilesPathRouting,
} from "./path_routing.ts";
import { normalizePlainFilesPath } from "../protocol/plain_paths.ts";
import { normalizeFilesPathForRouting } from "./routed_paths.ts";
import {
  FilesServiceFault,
  type FilesResidentFilePort,
  type FilesServiceEntry,
  type FilesServiceFile,
  type FilesServiceListPage,
  type FilesServiceMoveSource,
  type FilesServiceMutationResult,
  type FilesServiceRemovePrecondition,
  type FilesServiceStatus,
  type FilesServiceWriteResult,
} from "./service_contract.ts";
import {
  FILES_STORAGE_ROOTS,
  filesVirtualPath,
  isFilesStorageRootPath,
  parseFilesRootedPath,
  type FilesRootedPath,
  type FilesStorageClass,
} from "./storage_roots.ts";

const ZERO = "0" as CanonicalNat64;
const ROOT_REVISION = "1" as CanonicalNat64;
const CROSS_ROOT_ROLLBACK_TIMEOUT_MS = 15_000;

export type FilesRootedCursor<VaultCursor = unknown, PlainCursor = unknown> =
  | Readonly<{ storageClass: "root"; offset: number }>
  | Readonly<{ storageClass: "vault"; cursor: VaultCursor }>
  | Readonly<{
      storageClass: "shared" | "workspace";
      cursor: PlainCursor;
    }>
  | Readonly<{
      storageClass: "shared" | "workspace";
      recursive: true;
      rootPath: string;
      rootNodeId: CanonicalNat64;
      rootRevision: CanonicalNat64;
      stack: readonly Readonly<{
        path: string;
        nodeId: CanonicalNat64;
        structuralRevision: CanonicalNat64;
        backend: PlainCursor | null;
        seen: number;
        total: number | null;
        afterName: string | null;
        complete: boolean;
      }>[];
    }>;

export type FilesRootedPortDependencies<VaultCursor, PlainCursor> = Readonly<{
  vault: FilesResidentFilePort<VaultCursor>;
  plain: FilesResidentFilePort<PlainCursor>;
}>;

type FilesCopySnapshot = Readonly<{
  entry: FilesServiceEntry;
  destinationEntry: FilesServiceEntry;
  children: readonly FilesCopySnapshot[];
  sourceRemoved: boolean;
}>;

type FilesUploadOwner = Readonly<{
  storageClass: FilesStorageClass;
  rooted: ResolvedRootedPath;
}>;

type PlainRecursiveFrame<PlainCursor> = {
  path: string;
  nodeId: CanonicalNat64;
  structuralRevision: CanonicalNat64;
  backend: PlainCursor | null;
  seen: number;
  total: number | null;
  afterName: string | null;
  complete: boolean;
};

/**
 * Presents the Files tile's three disjoint storage policies while retaining
 * the exact pre-v105 encrypted namespace for unmarked callers. Only the
 * resident-issued policy token makes the fixed first segment a policy root.
 */
export class FilesRootedResidentPort<VaultCursor = unknown, PlainCursor = unknown>
  implements FilesResidentFilePort<FilesRootedCursor<VaultCursor, PlainCursor>> {
  readonly #vault: FilesResidentFilePort<VaultCursor>;
  readonly #plain: FilesResidentFilePort<PlainCursor>;
  readonly #uploadOwners = new Map<string, FilesUploadOwner>();

  constructor(
    dependencies: FilesRootedPortDependencies<VaultCursor, PlainCursor>,
  ) {
    this.#vault = dependencies.vault;
    this.#plain = dependencies.plain;
  }

  onStatusChange(
    listener: (
      reason:
        | "inactivity"
        | "worker_failure"
        | "authority_changed"
        | "state_changed",
    ) => void,
  ): () => void {
    const unsubscribeVault = this.#vault.onStatusChange?.(listener) ?? (() => {});
    const unsubscribePlain = this.#plain.onStatusChange?.(listener) ?? (() => {});
    return () => {
      unsubscribeVault();
      unsubscribePlain();
    };
  }

  onLock(
    listener: (reason?: "inactivity" | "worker_failure") => void,
  ): () => void {
    return this.#vault.onLock?.(listener) ?? (() => {});
  }

  async status(): Promise<FilesServiceStatus> {
    return this.#status(new Map(this.#uploadOwners));
  }

  async #status(
    observedOwners: ReadonlyMap<string, FilesUploadOwner>,
  ): Promise<FilesServiceStatus> {
    const [vault, plain] = await Promise.all([
      this.#vault.status(),
      this.#plain.status(),
    ]);
    const combined = {
      ...vault,
      quota: {
        nodes: addDecimal(vault.quota.nodes, plain.quota.nodes),
        plaintextBytes: addDecimal(
          vault.quota.plaintextBytes,
          plain.quota.plaintextBytes,
        ),
        ciphertextBytes: vault.quota.ciphertextBytes,
        physicalBytes: addDecimal(
          vault.quota.physicalBytes,
          plain.quota.physicalBytes,
        ),
        cleanupJobs: vault.quota.cleanupJobs + plain.quota.cleanupJobs,
      },
      transfers: [...plain.transfers, ...vault.transfers],
    };
    this.#releaseTerminalUploadOwners(
      vault.transfers,
      "vault",
      observedOwners,
    );
    this.#releaseTerminalUploadOwners(
      plain.transfers,
      "plain",
      observedOwners,
    );
    return combined;
  }

  initialize(): Promise<FilesServiceStatus> {
    return Promise.all([
      this.#vault.initialize(),
      this.#plain.initialize(),
    ]).then(() => this.status());
  }

  unlock(): Promise<FilesServiceStatus> {
    return this.#vault.unlock().then(() => this.status());
  }

  lock(): Promise<FilesServiceStatus> {
    return this.#vault.lock().then(() => this.status());
  }

  rotate(): Promise<FilesServiceStatus> {
    return this.#vault.rotate().then(() => this.status());
  }

  async list(input: {
    path: string;
    cursor: FilesRootedCursor<VaultCursor, PlainCursor> | null;
    expectedFolderRevision: CanonicalNat64 | null;
    limit: number;
    recursive: boolean;
    routing?: FilesPathRouting;
    signal?: AbortSignal;
  }): Promise<
    FilesServiceListPage<FilesRootedCursor<VaultCursor, PlainCursor>>
  > {
    if (filesPathRoutingMode(input.routing) === "legacy_vault") {
      const rooted = requireRoot(input.path, input.routing);
      if (
        input.cursor !== null &&
        input.cursor.storageClass !== "vault"
      ) {
        throw new FilesServiceFault(
          "cursor_expired",
          "This folder page belongs to another Files root view",
          "Refresh the folder",
        );
      }
      const page = await this.#vault.list({
        path: rooted.relativePath,
        cursor:
          input.cursor?.storageClass === "vault"
            ? input.cursor.cursor
            : null,
        expectedFolderRevision: input.expectedFolderRevision,
        limit: input.limit,
        recursive: input.recursive,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return {
        ...page,
        entries: page.entries.map((entry) => ({
          ...entry,
          storageClass: "vault",
          publicUrl: null,
        })),
        cursor:
          page.cursor === null
            ? null
            : { storageClass: "vault", cursor: page.cursor },
      };
    }
    if (input.path === "/") {
      if (
        input.recursive ||
        (input.cursor !== null && input.cursor.storageClass !== "root")
      ) {
        throw invalidRootOperation(
          "The Files home lists only Shared, Vault, and Workspace",
        );
      }
      const entries = FILES_STORAGE_ROOTS.map((root) =>
        rootEntry(root.toLocaleLowerCase("en-US") as FilesStorageClass)
      );
      const offset =
        input.cursor?.storageClass === "root" ? input.cursor.offset : 0;
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset >= entries.length
      ) {
        throw new FilesServiceFault(
          "cursor_expired",
          "This Files home page is no longer valid",
          "Refresh Files",
        );
      }
      const selected = entries.slice(offset, offset + input.limit);
      const nextOffset = offset + selected.length;
      return {
        path: "/",
        folderRevision: ROOT_REVISION,
        entries: selected,
        total: entries.length,
        cursor:
          nextOffset < entries.length
            ? { storageClass: "root", offset: nextOffset }
            : null,
        hasMore: nextOffset < entries.length,
      };
    }
    const rooted = requireRoot(input.path, input.routing);
    if (
      input.cursor !== null &&
      input.cursor.storageClass !== rooted.storageClass
    ) {
      throw new FilesServiceFault(
        "cursor_expired",
        "This folder page belongs to another Files root",
        "Refresh the folder",
      );
    }
    if (rooted.storageClass === "vault") {
      if (
        input.cursor !== null &&
        !("cursor" in input.cursor)
      ) {
        throw rootedCursorExpired(
          "This folder page belongs to another Files view",
        );
      }
      const page = await this.#vault.list({
        path: rooted.relativePath,
        cursor:
          input.cursor?.storageClass === "vault"
            ? input.cursor.cursor
            : null,
        expectedFolderRevision: input.expectedFolderRevision,
        limit: input.limit,
        recursive: input.recursive,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return {
        ...page,
        path: rooted.legacyAlias
          ? page.path
          : filesVirtualPath("vault", page.path),
        entries: page.entries.map((entry) =>
          vaultEntry(rooted, entry)
        ),
        cursor:
          page.cursor === null
            ? null
            : { storageClass: "vault", cursor: page.cursor },
      };
    }
    if (input.recursive) {
      return this.#listPlainRecursive(
        input,
        rooted as ResolvedRootedPath & Readonly<{
          storageClass: "shared" | "workspace";
        }>,
      );
    }
    if (
      input.cursor !== null &&
      !("cursor" in input.cursor)
    ) {
      throw rootedCursorExpired(
        "This folder page belongs to another Files view",
      );
    }
    const page = await this.#plain.list({
      path: input.path,
      cursor:
        input.cursor?.storageClass === rooted.storageClass &&
          "cursor" in input.cursor
          ? input.cursor.cursor
          : null,
      expectedFolderRevision: input.expectedFolderRevision,
      limit: input.limit,
      recursive: input.recursive,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return {
      ...page,
      entries: page.entries.map((entry) => ({
        ...entry,
        storageClass: rooted.storageClass,
      })),
      cursor:
        page.cursor === null
          ? null
          : {
              storageClass: rooted.storageClass,
              cursor: page.cursor,
            },
    };
  }

  async #listPlainRecursive(
    input: {
      path: string;
      cursor: FilesRootedCursor<VaultCursor, PlainCursor> | null;
      expectedFolderRevision: CanonicalNat64 | null;
      limit: number;
      recursive: boolean;
      routing?: FilesPathRouting;
      signal?: AbortSignal;
    },
    rooted: ResolvedRootedPath & Readonly<{
      storageClass: "shared" | "workspace";
    }>,
  ): Promise<
    FilesServiceListPage<FilesRootedCursor<VaultCursor, PlainCursor>>
  > {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > FILES_V2_LIMITS.directChildPageMaximum
    ) {
      throw new FilesServiceFault(
        "limit",
        `Files lists at most ${FILES_V2_LIMITS.directChildPageMaximum} items per page`,
        "Use a smaller page size",
      );
    }
    if (
      input.cursor !== null &&
      !isPlainRecursiveCursor(input.cursor)
    ) {
      throw rootedCursorExpired(
        "This folder page belongs to another Files view",
      );
    }
    const cursor =
      input.cursor !== null && isPlainRecursiveCursor(input.cursor)
        ? input.cursor
        : null;
    if (
      cursor !== null &&
      (
        cursor.storageClass !== rooted.storageClass ||
        cursor.rootPath !== rooted.path
      )
    ) {
      throw rootedCursorExpired(
        "This recursive page belongs to another Files root",
      );
    }

    const root = await this.#plain.stat(rooted.path, input.signal);
    assertPlainRecursiveFolder(
      root,
      rooted.path,
      rooted.storageClass,
      cursor !== null,
    );
    const rootNodeId = requireRootedPlainNodeId(root, cursor !== null);
    const rootRevision = cursor?.rootRevision ?? root.structuralRevision;
    if (
      (cursor !== null &&
        (
          cursor.rootNodeId !== rootNodeId ||
          cursor.rootRevision !== root.structuralRevision
        )) ||
      (
        input.expectedFolderRevision !== null &&
        input.expectedFolderRevision !== rootRevision
      )
    ) {
      throw cursor === null
        ? rootedListConflict("The folder changed while it was being listed")
        : rootedCursorExpired("The recursive folder changed");
    }

    const stack: PlainRecursiveFrame<PlainCursor>[] =
      cursor === null
        ? [{
            path: rooted.path,
            nodeId: rootNodeId,
            structuralRevision: root.structuralRevision,
            backend: null,
            seen: 0,
            total: null,
            afterName: null,
            complete: false,
          }]
        : cursor.stack.map((frame) => ({ ...frame }));
    assertPlainRecursiveStack(
      stack,
      rooted,
      rootNodeId,
      rootRevision,
    );

    const entries: FilesServiceEntry[] = [];
    const knownFolders = new Map<string, FilesServiceEntry>([
      [plainFolderCacheKey(rootNodeId, rooted.path), root],
    ]);
    let iterations = 0;
    const iterationLimit =
      input.limit * 2 + FILES_V2_LIMITS.treeDepth + 1;
    while (entries.length < input.limit && stack.length > 0) {
      if (iterations >= iterationLimit) {
        throw new FilesServiceFault(
          "incompatible",
          "Files recursive traversal exceeded its bounded work",
          "Retry after updating Files",
        );
      }
      iterations += 1;
      throwIfRootedAborted(input.signal);
      const frame = stack[stack.length - 1]!;
      const cacheKey = plainFolderCacheKey(frame.nodeId, frame.path);
      if (frame.complete) {
        let rebound: FilesServiceEntry;
        try {
          rebound = await this.#plain.stat(frame.path, input.signal);
        } catch (error) {
          throw plainRecursiveContinuationError(error, cursor !== null);
        }
        assertPlainRecursiveFolder(
          rebound,
          frame.path,
          rooted.storageClass,
          cursor !== null,
        );
        if (
          rebound.nodeId !== frame.nodeId ||
          rebound.structuralRevision !== frame.structuralRevision
        ) {
          throw cursor === null
            ? rootedListConflict("A nested folder changed during listing")
            : rootedCursorExpired("A nested folder changed");
        }
        stack.pop();
        continue;
      }
      let folder = knownFolders.get(cacheKey);
      if (folder === undefined) {
        try {
          folder = await this.#plain.stat(frame.path, input.signal);
        } catch (error) {
          throw plainRecursiveContinuationError(error, cursor !== null);
        }
        assertPlainRecursiveFolder(
          folder,
          frame.path,
          rooted.storageClass,
          cursor !== null,
        );
        if (
          folder.nodeId !== frame.nodeId ||
          folder.structuralRevision !== frame.structuralRevision
        ) {
          throw cursor === null
            ? rootedListConflict("A nested folder changed during listing")
            : rootedCursorExpired("A nested folder changed");
        }
        knownFolders.set(cacheKey, folder);
      }

      let page: FilesServiceListPage<PlainCursor>;
      try {
        page = await this.#plain.list({
          path: frame.path,
          cursor: frame.backend,
          expectedFolderRevision: frame.structuralRevision,
          limit: 1,
          recursive: false,
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch (error) {
        throw plainRecursiveContinuationError(error, cursor !== null);
      }
      const item = assertPlainRecursivePage(
        page,
        frame,
        rooted.storageClass,
      );
      const nextSeen = frame.seen + page.entries.length;
      if (page.hasMore) {
        frame.backend = page.cursor;
        frame.seen = nextSeen;
        frame.total = page.total;
        frame.afterName = item?.name ?? frame.afterName;
      } else if (item?.type === "folder") {
        frame.backend = null;
        frame.seen = nextSeen;
        frame.total = page.total;
        frame.afterName = item.name;
        frame.complete = true;
      } else {
        stack.pop();
      }
      if (item === undefined) continue;
      entries.push(item);
      if (item.type === "folder") {
        const itemNodeId = requireRootedPlainNodeId(item, cursor !== null);
        const itemRoot = parseFilesRootedPath(item.path);
        if (
          itemRoot === null ||
          itemRoot.storageClass !== rooted.storageClass ||
          filesRelativeDepth(itemRoot) > FILES_V2_LIMITS.treeDepth
        ) {
          throw new FilesServiceFault(
            "incompatible",
            "Files returned a folder outside this storage root",
            "Retry after updating Files",
          );
        }
        stack.push({
          path: item.path,
          nodeId: itemNodeId,
          structuralRevision: item.structuralRevision,
          backend: null,
          seen: 0,
          total: null,
          afterName: null,
          complete: false,
        });
        knownFolders.set(
          plainFolderCacheKey(itemNodeId, item.path),
          item,
        );
      }
    }

    const nextCursor:
      | FilesRootedCursor<VaultCursor, PlainCursor>
      | null =
      stack.length === 0
        ? null
        : Object.freeze({
            storageClass: rooted.storageClass,
            recursive: true as const,
            rootPath: rooted.path,
            rootNodeId,
            rootRevision,
            stack: Object.freeze(
              stack.map((frame) => Object.freeze({ ...frame })),
            ),
          });
    return Object.freeze({
      path: rooted.path,
      folderRevision: rootRevision,
      entries: Object.freeze(entries),
      // As with Vault DFS, the backend has no recursive global count. This
      // exact page count is paired with an explicit continuation, so a
      // partial subtree is never reported as complete.
      total: entries.length,
      cursor: nextCursor,
      hasMore: nextCursor !== null,
    });
  }

  async stat(
    path: string,
    signal?: AbortSignal,
    routing?: FilesPathRouting,
  ): Promise<FilesServiceEntry> {
    const rooted = requireRoot(path, routing);
    if (rooted.isRoot && !rooted.legacyAlias) {
      return rootEntry(rooted.storageClass);
    }
    const port = this.#port(rooted.storageClass);
    const entry = await port.stat(
      rooted.storageClass === "vault" ? rooted.relativePath : rooted.path,
      signal,
    );
    return rooted.storageClass === "vault"
      ? vaultEntry(rooted, entry)
      : { ...entry, storageClass: rooted.storageClass };
  }

  async read(
    path: string,
    controls?: FilesTransferControls & Readonly<{ transferId?: string }>,
    routing?: FilesPathRouting,
  ): Promise<FilesServiceFile> {
    const rooted = requireFilePath(path, routing);
    const result = await this.#port(rooted.storageClass).read(
      rooted.storageClass === "vault" ? rooted.relativePath : rooted.path,
      controls,
    );
    return {
      ...result,
      entry:
        rooted.storageClass === "vault"
          ? vaultEntry(rooted, result.entry)
          : { ...result.entry, storageClass: rooted.storageClass },
    };
  }

  async write(
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
  ): Promise<FilesServiceWriteResult> {
    const rooted = requireFilePath(input.path, routing);
    const claimedOwner = input.transferId
      ? this.#claimUploadOwner(input.transferId, rooted)
      : null;
    try {
      const result = await this.#port(rooted.storageClass).write(
        {
          ...input,
          path:
            rooted.storageClass === "vault"
              ? rooted.relativePath
              : rooted.path,
        },
        controls,
      );
      if (input.transferId && claimedOwner !== null) {
        this.#releaseUploadOwner(input.transferId, claimedOwner);
      }
      return {
        ...result,
        entry:
          rooted.storageClass === "vault"
            ? vaultEntry(rooted, result.entry)
            : { ...result.entry, storageClass: rooted.storageClass },
      };
    } catch (error) {
      // A transfer status may still reconcile an uncertain response. Keep its
      // owner until status observes a terminal phase or explicit cancel wins.
      throw error;
    }
  }

  async writeMany(
    input: readonly {
      path: string;
      text: string;
      overwrite: boolean;
      createParents: boolean;
      mediaType: string;
    }[],
    controls?: FilesTransferControls,
    routing?: FilesPathRouting,
  ): Promise<readonly FilesServiceWriteResult[]> {
    const rootedItems = input.map((item) => ({
      item,
      rooted: requireFilePath(item.path, routing),
    }));
    if (
      rootedItems.length !== 0 &&
      rootedItems.every(({ rooted }) => rooted.storageClass === "vault")
    ) {
      const written = await this.#vault.writeMany(
        rootedItems.map(({ item, rooted }) => ({
          ...item,
          path: rooted.relativePath,
        })),
        controls,
      );
      if (written.length !== rootedItems.length) {
        throw new FilesServiceFault(
          "uncertain",
          "Files received an incomplete Vault batch result",
          "Check the destination before retrying",
        );
      }
      return written.map((result, index) => ({
        ...result,
        entry: vaultEntry(rootedItems[index]!.rooted, result.entry),
      }));
    }
    const results: FilesServiceWriteResult[] = [];
    for (const { item } of rootedItems) {
      const bytes = new TextEncoder().encode(item.text);
      const replacement = item.overwrite
        ? await this.stat(item.path, controls?.signal, routing)
        : null;
      if (
        replacement !== null &&
        (
          replacement.type !== "file" ||
          replacement.etagSha256 === null
        )
      ) {
        throw new FilesServiceFault(
          "conflict",
          "Only an existing file can be replaced",
          "Refresh the folder and try again",
        );
      }
      results.push(
        await this.write(
          {
            path: item.path,
            source: byteSource(bytes, item.path, item.mediaType),
            contentKind: "text",
            mediaType: item.mediaType,
            ifMatch: replacement?.etagSha256 ?? null,
            ifNoneMatch: !item.overwrite,
            createParents: item.createParents,
          },
          controls,
          routing,
        ),
      );
    }
    return results;
  }

  async mkdir(
    path: string,
    recursive: boolean,
    signal?: AbortSignal,
    routing?: FilesPathRouting,
  ): Promise<FilesServiceMutationResult> {
    const rooted = requireMutablePath(path, routing);
    return this.#port(rooted.storageClass).mkdir(
      rooted.storageClass === "vault" ? rooted.relativePath : rooted.path,
      recursive,
      signal,
    ).then((result) => ({
      ...result,
      path:
        rooted.storageClass === "vault"
          ? rooted.legacyAlias
            ? result.path
            : filesVirtualPath("vault", result.path)
          : result.path,
    }));
  }

  async move(
    from: string,
    to: string,
    overwrite: boolean,
    signal?: AbortSignal,
    routing?: FilesPathRouting,
  ): Promise<FilesServiceMutationResult> {
    const source = requireMutablePath(from, routing);
    const destination = requireMutablePath(to, routing);
    if (
      source.storageClass === "shared" &&
      destination.storageClass === "shared" &&
      leafName(source.path) !== leafName(destination.path)
    ) {
      const entry = await this.stat(source.path, signal, routing);
      if (entry.type === "file") {
        if (overwrite) {
          throw invalidRootOperation(
            "Replacing a Shared file while renaming is not supported",
          );
        }
        return this.#copyThenRemove(
          source.path,
          destination.path,
          routing,
          signal,
        );
      }
    }
    if (source.storageClass === destination.storageClass) {
      const result = await this.#port(source.storageClass).move(
        source.storageClass === "vault" ? source.relativePath : source.path,
        destination.storageClass === "vault"
          ? destination.relativePath
          : destination.path,
        overwrite,
        signal,
      );
      return {
        ...result,
        path:
          source.storageClass === "vault"
            ? destination.legacyAlias
              ? result.path
              : filesVirtualPath("vault", result.path)
            : result.path,
      };
    }
    if (overwrite) {
      throw invalidRootOperation(
        "Replacing an existing item while moving between Files roots is not supported",
      );
    }
    return this.#copyThenRemove(
      source.path,
      destination.path,
      routing,
      signal,
    );
  }

  async #copyThenRemove(
    sourcePath: string,
    destinationPath: string,
    routing: FilesPathRouting | undefined,
    signal?: AbortSignal,
  ): Promise<FilesServiceMutationResult> {
    try {
      await this.stat(destinationPath, signal, routing);
      throw new FilesServiceFault(
        "conflict",
        "An item already exists at the destination",
        "Choose another name or folder",
      );
    } catch (error) {
      if (
        !(error instanceof FilesServiceFault) ||
        error.code !== "not_found"
      ) {
        throw error;
      }
    }
    const copiedSource = await this.#copyAcrossRoots(
      sourcePath,
      destinationPath,
      routing,
      signal,
    );
    try {
      if (!copiedSource.sourceRemoved) {
        await this.#verifyCopySnapshot(copiedSource, routing, signal);
      }
      await this.#verifyDestinationSnapshot(copiedSource, routing, signal);
      if (!copiedSource.sourceRemoved) {
        await this.#removeCopySnapshot(copiedSource, routing, signal);
      }
    } catch (error) {
      throw new FilesServiceFault(
        "uncertain",
        "The item was copied, but Files could not remove the original",
        "Check both folders and remove the old copy",
        { from: sourcePath, to: destinationPath },
        { cause: error },
      );
    }
    return {
      path: destinationPath,
      structuralRevision: ROOT_REVISION,
      changed: 1,
      cleanupPending: false,
    };
  }

  async remove(
    path: string,
    recursive: boolean,
    signal?: AbortSignal,
    precondition?: FilesServiceRemovePrecondition,
    routing?: FilesPathRouting,
  ): Promise<FilesServiceMutationResult> {
    const rooted = requireMutablePath(path, routing);
    const result = await this.#port(rooted.storageClass).remove(
      rooted.storageClass === "vault" ? rooted.relativePath : rooted.path,
      recursive,
      signal,
      precondition,
    );
    return {
      ...result,
      path:
        rooted.storageClass === "vault"
          ? rooted.legacyAlias
            ? result.path
            : filesVirtualPath("vault", result.path)
          : result.path,
    };
  }

  async cancel(transferId: string): Promise<FilesServiceStatus> {
    const observedOwners = new Map(this.#uploadOwners);
    const owner = this.#uploadOwners.get(transferId);
    await (owner === undefined || owner.storageClass === "vault"
      ? this.#vault.cancel(transferId)
      : this.#plain.cancel(transferId));
    if (owner !== undefined) {
      this.#releaseUploadOwner(transferId, owner);
    }
    return this.#status(observedOwners);
  }

  async retry(transferId: string): Promise<FilesServiceStatus> {
    const observedOwners = new Map(this.#uploadOwners);
    const owner = this.#uploadOwners.get(transferId);
    await (owner === undefined || owner.storageClass === "vault"
      ? this.#vault.retry(transferId)
      : this.#plain.retry(transferId));
    return this.#status(observedOwners);
  }

  async beginUpload(
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
  > {
    const rooted = requireFilePath(input.path, routing);
    const claimedOwner = this.#claimUploadOwner(input.transferId, rooted);
    try {
      return await this.#port(rooted.storageClass).beginUpload({
        ...input,
        path:
          rooted.storageClass === "vault"
            ? rooted.relativePath
            : rooted.path,
      });
    } catch (error) {
      this.#releaseUploadOwner(input.transferId, claimedOwner);
      throw error;
    }
  }

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
  ) {
    const owner = this.#uploadOwners.get(input.transferId);
    if (owner === undefined) {
      throw new FilesServiceFault(
        "not_found",
        "This upload is no longer active",
        "Start the upload again",
      );
    }
    return this.#port(owner.storageClass)
      .uploadChunk(input, bytes, controls)
      .then((result) => {
        if (
          result.committed ||
          result.phase === "cancelled" ||
          result.phase === "failed"
        ) {
          this.#releaseUploadOwner(input.transferId, owner);
        }
        return {
          ...result,
          entry:
            result.entry === null
              ? null
              : owner.storageClass === "vault"
                ? vaultEntry(owner.rooted, result.entry)
                : { ...result.entry, storageClass: owner.storageClass },
        };
      });
  }

  clearVolatile(reason?: import("./authority.ts").FilesAuthorityResetReason) {
    this.#uploadOwners.clear();
    this.#vault.clearVolatile(reason);
    this.#plain.clearVolatile(reason);
  }

  #port(
    storageClass: FilesStorageClass,
  ): FilesResidentFilePort<VaultCursor> | FilesResidentFilePort<PlainCursor> {
    return storageClass === "vault" ? this.#vault : this.#plain;
  }

  #claimUploadOwner(
    transferId: string,
    rooted: ResolvedRootedPath,
  ): FilesUploadOwner {
    if (this.#uploadOwners.has(transferId)) {
      throw new FilesServiceFault(
        "conflict",
        "This transfer already exists",
        "Wait for it to finish or cancel it",
      );
    }
    const owner: FilesUploadOwner = {
      storageClass: rooted.storageClass,
      rooted,
    };
    this.#uploadOwners.set(transferId, owner);
    return owner;
  }

  #releaseUploadOwner(
    transferId: string,
    expectedOwner: FilesUploadOwner,
  ): void {
    if (this.#uploadOwners.get(transferId) === expectedOwner) {
      this.#uploadOwners.delete(transferId);
    }
  }

  #releaseTerminalUploadOwners(
    transfers: FilesServiceStatus["transfers"],
    backend: "vault" | "plain",
    observedOwners: ReadonlyMap<string, FilesUploadOwner>,
  ): void {
    for (const transfer of transfers) {
      if (!isTerminalTransferPhase(transfer.phase)) continue;
      const owner = observedOwners.get(transfer.id);
      if (
        owner === undefined ||
        (owner.storageClass === "vault" ? "vault" : "plain") !== backend
      ) {
        continue;
      }
      this.#releaseUploadOwner(transfer.id, owner);
    }
  }

  async #copyAcrossRoots(
    sourcePath: string,
    destinationPath: string,
    routing: FilesPathRouting | undefined,
    signal?: AbortSignal,
  ): Promise<FilesCopySnapshot> {
    const source = await this.stat(sourcePath, signal, routing);
    let destinationCreated = false;
    let destinationEntry: FilesServiceEntry | null = null;
    const copiedChildren: FilesCopySnapshot[] = [];
    try {
      if (source.type === "file") {
        const file = await this.read(
          sourcePath,
          signal ? { signal } : undefined,
          routing,
        );
        try {
          if (!sameSnapshotEntry(source, file.entry)) {
            throw new FilesServiceFault(
              "conflict",
              "The source changed while Files was opening it",
              "Review the source and try again",
            );
          }
          const verifiedSource = file.entry;
          const sourceRoot = requireRoot(sourcePath, routing);
          const destinationRoot = requireRoot(destinationPath, routing);
          const moveSource =
            sourceRoot.storageClass === "shared" &&
            destinationRoot.storageClass === "shared"
              ? sharedMoveSource(verifiedSource)
              : undefined;
          const written = await this.write(
            {
              path: destinationPath,
              source: byteSource(
                file.bytes,
                verifiedSource.name,
                verifiedSource.mediaType ?? "application/octet-stream",
              ),
              contentKind: verifiedSource.contentKind ?? "binary",
              mediaType:
                verifiedSource.mediaType ?? "application/octet-stream",
              ifMatch: null,
              ifNoneMatch: true,
              createParents: true,
              ...(moveSource === undefined ? {} : { moveSource }),
            },
            signal ? { signal } : undefined,
            routing,
          );
          // A Shared rename commits destination publication and source
          // revocation atomically. Once that update returns, rolling the
          // destination back could erase the only remaining copy.
          destinationCreated = moveSource === undefined;
          destinationEntry = written.entry;
          if (
            verifiedSource.etagSha256 !== null &&
            written.entry.etagSha256 !== verifiedSource.etagSha256
          ) {
            throw new FilesServiceFault(
              "uncertain",
              "Files could not verify the copied item",
              "Keep the original and retry",
            );
          }
          return {
            entry: verifiedSource,
            destinationEntry: written.entry,
            children: [],
            sourceRemoved: moveSource !== undefined,
          };
        } finally {
          file.bytes.fill(0);
        }
      }

      const created = await this.mkdir(
        destinationPath,
        true,
        signal,
        routing,
      );
      if (created.changed < 1) {
        throw new FilesServiceFault(
          "conflict",
          "An item already exists at the destination",
          "Choose another name or folder",
        );
      }
      destinationCreated = true;
      destinationEntry = await this.stat(
        destinationPath,
        signal,
        routing,
      );
      if (destinationEntry.type !== "folder") {
        throw new FilesServiceFault(
          "conflict",
          "An item already exists at the destination",
          "Choose another name or folder",
        );
      }
      let cursor: FilesRootedCursor<VaultCursor, PlainCursor> | null = null;
      let expectedFolderRevision: CanonicalNat64 | null = null;
      do {
        const page = await this.list({
          path: sourcePath,
          cursor,
          expectedFolderRevision,
          limit: 200,
          recursive: false,
          ...(routing ? { routing } : {}),
          ...(signal ? { signal } : {}),
        });
        expectedFolderRevision ??= page.folderRevision;
        for (const child of page.entries) {
          copiedChildren.push(
            await this.#copyAcrossRoots(
              child.path,
              `${destinationPath}/${child.name}`,
              routing,
              signal,
            ),
          );
        }
        cursor = page.cursor;
      } while (cursor !== null);
      const current = await this.stat(sourcePath, signal, routing);
      if (!sameSnapshotEntry(source, current)) {
        throw new FilesServiceFault(
          "conflict",
          "The source changed while it was being copied",
          "Review the source and try again",
        );
      }
      const completedDestination = await this.stat(
        destinationPath,
        signal,
        routing,
      );
      if (
        completedDestination.type !== "folder" ||
        completedDestination.createdAtNs !== destinationEntry.createdAtNs ||
        !sameStableNodeIdentity(destinationEntry, completedDestination)
      ) {
        throw new FilesServiceFault(
          "conflict",
          "The destination changed while Files was copying into it",
          "Review both folders and try again",
        );
      }
      destinationEntry = completedDestination;
      return {
        entry: source,
        destinationEntry,
        children: copiedChildren,
        sourceRemoved: false,
      };
    } catch (error) {
      if (destinationCreated && destinationEntry !== null) {
        try {
          await this.#rollbackCopySnapshot(
            {
            entry: source,
            destinationEntry,
            children: copiedChildren,
            sourceRemoved: false,
            },
            routing,
            AbortSignal.timeout(CROSS_ROOT_ROLLBACK_TIMEOUT_MS),
          );
        } catch (cleanupError) {
          const isPublic =
            requireRoot(destinationPath, routing).storageClass === "shared";
          throw new FilesServiceFault(
            "uncertain",
            "The copy failed, and Files could not confirm the incomplete destination was cleaned up",
            isPublic
              ? "Check Shared because the incomplete copy may still be public"
              : "Check the destination and remove any incomplete copy",
            {
              destinationPath,
              publicExposurePossible: isPublic,
            },
            {
              cause: new AggregateError(
                [error, cleanupError],
                "Copy and rollback both failed",
              ),
            },
          );
        }
      }
      throw error;
    }
  }

  async #rollbackCopySnapshot(
    snapshot: FilesCopySnapshot,
    routing: FilesPathRouting | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const failures: unknown[] = [];
    for (const child of [...snapshot.children].reverse()) {
      try {
        await this.#rollbackCopySnapshot(child, routing, signal);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await this.#rollbackCopyEntry(
        snapshot.destinationEntry,
        routing,
        signal,
      );
    } catch (error) {
      failures.push(error);
    }
    if (failures.length !== 0) {
      throw new AggregateError(
        failures,
        "One or more incomplete copied entries could not be cleaned up",
      );
    }
  }

  async #rollbackCopyEntry(
    destinationEntry: FilesServiceEntry,
    routing: FilesPathRouting | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    let current: FilesServiceEntry;
    try {
      current = await this.stat(destinationEntry.path, signal, routing);
    } catch (error) {
      if (
        error instanceof FilesServiceFault &&
        error.code === "not_found"
      ) {
        return;
      }
      throw error;
    }
    if (destinationEntry.type === "file") {
      if (!sameExactSnapshotEntry(destinationEntry, current)) {
        throw new FilesServiceFault(
          "conflict",
          "The incomplete copied file changed before cleanup",
          "Review the destination",
        );
      }
    } else {
      if (
        current.type !== "folder" ||
        current.createdAtNs !== destinationEntry.createdAtNs ||
        !sameStableNodeIdentity(destinationEntry, current)
      ) {
        throw new FilesServiceFault(
          "conflict",
          "The incomplete copied folder was replaced before cleanup",
          "Review the destination",
        );
      }
      const page = await this.list({
        path: destinationEntry.path,
        cursor: null,
        expectedFolderRevision: null,
        limit: 1,
        recursive: false,
        ...(routing ? { routing } : {}),
        ...(signal ? { signal } : {}),
      });
      if (
        page.total !== 0 ||
        page.entries.length !== 0 ||
        page.cursor !== null
      ) {
        throw new FilesServiceFault(
          "conflict",
          "The incomplete copied folder now contains other items",
          "Review the destination",
        );
      }
      current = await this.stat(destinationEntry.path, signal, routing);
      if (
        current.type !== "folder" ||
        current.createdAtNs !== destinationEntry.createdAtNs ||
        !sameStableNodeIdentity(destinationEntry, current)
      ) {
        throw new FilesServiceFault(
          "conflict",
          "The incomplete copied folder changed during cleanup",
          "Review the destination",
        );
      }
    }
    const rooted = requireMutablePath(destinationEntry.path, routing);
    await this.#port(rooted.storageClass).remove(
      rooted.storageClass === "vault"
        ? rooted.relativePath
        : rooted.path,
      false,
      signal,
      {
        structuralRevision: current.structuralRevision,
        etagSha256: current.etagSha256,
        nodeId: destinationEntry.nodeId,
        ...(destinationEntry.opaqueNodeIdentity === undefined
          ? {}
          : {
              opaqueNodeIdentity:
                destinationEntry.opaqueNodeIdentity,
            }),
      },
    );
  }

  async #verifyCopySnapshot(
    snapshot: FilesCopySnapshot,
    routing: FilesPathRouting | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const current = await this.stat(snapshot.entry.path, signal, routing);
    if (!sameSnapshotEntry(snapshot.entry, current)) {
      throw new FilesServiceFault(
        "conflict",
        "The source changed while it was being moved",
        "Review both folders and try again",
      );
    }
    if (snapshot.entry.type !== "folder") return;

    const expected = new Map(
      snapshot.children.map((child) => [child.entry.path, child]),
    );
    let cursor: FilesRootedCursor<VaultCursor, PlainCursor> | null = null;
    let expectedFolderRevision: CanonicalNat64 | null = null;
    do {
      const page = await this.list({
        path: snapshot.entry.path,
        cursor,
        expectedFolderRevision,
        limit: 200,
        recursive: false,
        ...(routing ? { routing } : {}),
        ...(signal ? { signal } : {}),
      });
      expectedFolderRevision ??= page.folderRevision;
      for (const child of page.entries) {
        const copied = expected.get(child.path);
        if (copied === undefined || !sameSnapshotEntry(copied.entry, child)) {
          throw new FilesServiceFault(
            "conflict",
            "The source folder changed while it was being moved",
            "Review both folders and try again",
          );
        }
        expected.delete(child.path);
      }
      cursor = page.cursor;
    } while (cursor !== null);
    if (expected.size !== 0) {
      throw new FilesServiceFault(
        "conflict",
        "The source folder changed while it was being moved",
        "Review both folders and try again",
      );
    }
    for (const child of snapshot.children) {
      await this.#verifyCopySnapshot(child, routing, signal);
    }
  }

  async #verifyDestinationSnapshot(
    snapshot: FilesCopySnapshot,
    routing: FilesPathRouting | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const current = await this.stat(
      snapshot.destinationEntry.path,
      signal,
      routing,
    );
    if (!sameExactSnapshotEntry(snapshot.destinationEntry, current)) {
      throw new FilesServiceFault(
        "conflict",
        "The copied item changed before Files could finish the move",
        "Review both folders and try again",
      );
    }
    if (snapshot.destinationEntry.type !== "folder") return;

    const expected = new Map(
      snapshot.children.map((child) => [
        child.destinationEntry.path,
        child,
      ]),
    );
    let cursor: FilesRootedCursor<VaultCursor, PlainCursor> | null = null;
    let expectedFolderRevision: CanonicalNat64 | null = null;
    do {
      const page = await this.list({
        path: snapshot.destinationEntry.path,
        cursor,
        expectedFolderRevision,
        limit: 200,
        recursive: false,
        ...(routing ? { routing } : {}),
        ...(signal ? { signal } : {}),
      });
      expectedFolderRevision ??= page.folderRevision;
      for (const child of page.entries) {
        const copied = expected.get(child.path);
        if (
          copied === undefined ||
          !sameExactSnapshotEntry(copied.destinationEntry, child)
        ) {
          throw new FilesServiceFault(
            "conflict",
            "The copied folder changed before Files could finish the move",
            "Review both folders and try again",
          );
        }
        expected.delete(child.path);
      }
      cursor = page.cursor;
    } while (cursor !== null);
    if (expected.size !== 0) {
      throw new FilesServiceFault(
        "conflict",
        "The copied folder changed before Files could finish the move",
        "Review both folders and try again",
      );
    }
    for (const child of snapshot.children) {
      await this.#verifyDestinationSnapshot(child, routing, signal);
    }
  }

  async #removeCopySnapshot(
    snapshot: FilesCopySnapshot,
    routing: FilesPathRouting | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const child of snapshot.children) {
      await this.#removeCopySnapshot(child, routing, signal);
    }
    let current = await this.stat(snapshot.entry.path, signal, routing);
    if (snapshot.entry.type === "file") {
      if (!sameSnapshotEntry(snapshot.entry, current)) {
        throw new FilesServiceFault(
          "conflict",
          "The source changed while it was being moved",
          "Review both folders and try again",
        );
      }
    } else {
      if (
        current.type !== "folder" ||
        current.createdAtNs !== snapshot.entry.createdAtNs ||
        !sameStableNodeIdentity(snapshot.entry, current)
      ) {
        throw new FilesServiceFault(
          "conflict",
          "The source folder changed while it was being moved",
          "Review both folders and try again",
        );
      }
      const page = await this.list({
        path: snapshot.entry.path,
        cursor: null,
        expectedFolderRevision: null,
        limit: 1,
        recursive: false,
        ...(routing ? { routing } : {}),
        ...(signal ? { signal } : {}),
      });
      if (page.total !== 0 || page.entries.length !== 0) {
        throw new FilesServiceFault(
          "conflict",
          "The source folder received new items while it was being moved",
          "Review both folders and try again",
        );
      }
      if (page.folderRevision !== current.structuralRevision) {
        throw new FilesServiceFault(
          "conflict",
          "The source folder changed while it was being moved",
          "Review both folders and try again",
        );
      }
      const rebound = await this.stat(
        snapshot.entry.path,
        signal,
        routing,
      );
      // Rebind the complete resident snapshot, including Vault's internal
      // opaque identity, after the empty-list proof.
      if (!sameExactSnapshotEntry(current, rebound)) {
        throw new FilesServiceFault(
          "conflict",
          "The source folder changed while it was being moved",
          "Review both folders and try again",
        );
      }
      current = rebound;
    }
    await this.#assertDestinationEntry(
      snapshot.destinationEntry,
      routing,
      signal,
    );
    const rooted = requireMutablePath(snapshot.entry.path, routing);
    await this.#port(rooted.storageClass).remove(
      rooted.storageClass === "vault"
        ? rooted.relativePath
        : rooted.path,
      false,
      signal,
      {
        structuralRevision: current.structuralRevision,
        etagSha256: current.etagSha256,
        nodeId: snapshot.entry.nodeId,
        ...(snapshot.entry.opaqueNodeIdentity === undefined
          ? {}
          : {
              opaqueNodeIdentity:
                snapshot.entry.opaqueNodeIdentity,
            }),
      },
    );
  }

  async #assertDestinationEntry(
    expected: FilesServiceEntry,
    routing: FilesPathRouting | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const current = await this.stat(expected.path, signal, routing);
    if (!sameExactSnapshotEntry(expected, current)) {
      throw new FilesServiceFault(
        "conflict",
        "The copied item changed before Files could remove the original",
        "Review both folders and try again",
      );
    }
  }
}

function rootEntry(storageClass: FilesStorageClass): FilesServiceEntry {
  const name =
    storageClass === "shared"
      ? "Shared"
      : storageClass === "vault"
        ? "Vault"
        : "Workspace";
  return {
    path: `/${name}`,
    name,
    type: "folder",
    nodeId: null,
    storageClass,
    contentKind: null,
    byteLength: null,
    mediaType: null,
    etagSha256: null,
    publicUrl: null,
    createdAtNs: ZERO,
    modifiedAtNs: ZERO,
    structuralRevision: ROOT_REVISION,
    contentId: null,
  };
}

function rootedEntry<T extends FilesServiceEntry>(
  storageClass: "vault",
  entry: T,
): T {
  return {
    ...entry,
    nodeId: null,
    path: filesVirtualPath(storageClass, entry.path),
    storageClass,
    publicUrl: null,
  } as T;
}

type ResolvedRootedPath = FilesRootedPath &
  Readonly<{ legacyAlias: boolean }>;

function isPlainRecursiveCursor<VaultCursor, PlainCursor>(
  cursor: FilesRootedCursor<VaultCursor, PlainCursor>,
): cursor is Extract<
  FilesRootedCursor<VaultCursor, PlainCursor>,
  Readonly<{ recursive: true }>
> {
  return (
    (cursor.storageClass === "shared" ||
      cursor.storageClass === "workspace") &&
    "recursive" in cursor &&
    cursor.recursive === true
  );
}

function assertPlainRecursiveStack<PlainCursor>(
  stack: readonly PlainRecursiveFrame<PlainCursor>[],
  rooted: ResolvedRootedPath & Readonly<{
    storageClass: "shared" | "workspace";
  }>,
  rootNodeId: CanonicalNat64,
  rootRevision: CanonicalNat64,
): void {
  const maximumFrames =
    FILES_V2_LIMITS.treeDepth - filesRelativeDepth(rooted) + 1;
  if (
    !Array.isArray(stack) ||
    stack.length < 1 ||
    stack.length > maximumFrames
  ) {
    throw rootedCursorExpired("The recursive cursor depth is invalid");
  }
  const nodeIds = new Set<CanonicalNat64>();
  for (let index = 0; index < stack.length; index += 1) {
    const frame = stack[index]!;
    const parsed = parseFilesRootedPath(frame.path);
    const parent = index === 0 ? null : stack[index - 1]!;
    if (
      parsed === null ||
      parsed.path !== frame.path ||
      parsed.storageClass !== rooted.storageClass ||
      filesRelativeDepth(parsed) > FILES_V2_LIMITS.treeDepth ||
      (index === 0
        ? (
            frame.path !== rooted.path ||
            frame.nodeId !== rootNodeId ||
            frame.structuralRevision !== rootRevision
          )
        : parentServicePath(frame.path) !== parent?.path) ||
      !isNonzeroCanonicalNat64(frame.nodeId) ||
      !isNonzeroCanonicalNat64(frame.structuralRevision) ||
      nodeIds.has(frame.nodeId) ||
      !Number.isSafeInteger(frame.seen) ||
      frame.seen < 0 ||
      !validPlainRecursiveFrameProgress(frame)
    ) {
      throw rootedCursorExpired("The recursive cursor is no longer valid");
    }
    nodeIds.add(frame.nodeId);
  }
}

function validPlainRecursiveFrameProgress<PlainCursor>(
  frame: PlainRecursiveFrame<PlainCursor>,
): boolean {
  const fresh =
    !frame.complete &&
    frame.backend === null &&
    frame.seen === 0 &&
    frame.total === null &&
    frame.afterName === null;
  const active =
    !frame.complete &&
    frame.backend !== null &&
    frame.seen >= 1 &&
    frame.total !== null &&
    Number.isSafeInteger(frame.total) &&
    frame.total >= 2 &&
    frame.seen < frame.total &&
    frame.afterName !== null;
  const complete =
    frame.complete === true &&
    frame.backend === null &&
    frame.total !== null &&
    Number.isSafeInteger(frame.total) &&
    frame.total >= 1 &&
    frame.seen === frame.total &&
    frame.afterName !== null;
  return fresh || active || complete;
}

function assertPlainRecursiveFolder(
  entry: FilesServiceEntry,
  path: string,
  storageClass: "shared" | "workspace",
  continuation: boolean,
): void {
  if (
    entry.path !== path ||
    entry.storageClass !== storageClass ||
    entry.type !== "folder" ||
    entry.nodeId === null ||
    !isNonzeroCanonicalNat64(entry.nodeId) ||
    !isNonzeroCanonicalNat64(entry.structuralRevision)
  ) {
    if (continuation) {
      throw rootedCursorExpired("A recursive folder was replaced");
    }
    throw new FilesServiceFault(
      "incompatible",
      "Files returned an invalid recursive folder",
      "Retry after updating Files",
    );
  }
}

function requireRootedPlainNodeId(
  entry: FilesServiceEntry,
  continuation: boolean,
): CanonicalNat64 {
  if (entry.nodeId !== null && isNonzeroCanonicalNat64(entry.nodeId)) {
    return entry.nodeId;
  }
  if (continuation) {
    throw rootedCursorExpired("A recursive folder was replaced");
  }
  throw new FilesServiceFault(
    "incompatible",
    "Files returned an item without a stable identity",
    "Retry after updating Files",
  );
}

function assertPlainRecursivePage<PlainCursor>(
  page: FilesServiceListPage<PlainCursor>,
  frame: PlainRecursiveFrame<PlainCursor>,
  storageClass: "shared" | "workspace",
): FilesServiceEntry | undefined {
  const item = page.entries[0];
  const total = frame.total ?? page.total;
  const nextSeen = frame.seen + page.entries.length;
  if (
    page.path !== frame.path ||
    page.folderRevision !== frame.structuralRevision ||
    !Number.isSafeInteger(page.total) ||
    page.total < 0 ||
    page.total > FILES_V2_LIMITS.nodes ||
    page.total !== total ||
    page.entries.length > 1 ||
    page.hasMore !== (page.cursor !== null) ||
    (page.hasMore &&
      (
        item === undefined ||
        nextSeen >= total
      )) ||
    (!page.hasMore && nextSeen !== total)
  ) {
    throw new FilesServiceFault(
      "incompatible",
      "Files returned an inconsistent recursive page",
      "Retry after updating Files",
    );
  }
  if (
    item !== undefined &&
    (
      item.storageClass !== storageClass ||
      !isExactPlainDirectChild(frame.path, item) ||
      (
        frame.afterName !== null &&
        comparePlainServiceNames(frame.afterName, item.name) >= 0
      )
    )
  ) {
    throw new FilesServiceFault(
      "incompatible",
      "Files returned recursive items out of order or from another folder",
      "Retry after updating Files",
    );
  }
  return item;
}

function plainRecursiveContinuationError(
  error: unknown,
  continuation: boolean,
): Error {
  if (
    continuation &&
    error instanceof FilesServiceFault &&
    (
      error.code === "conflict" ||
      error.code === "cursor_expired" ||
      error.code === "not_found"
    )
  ) {
    return rootedCursorExpired("A recursive folder changed");
  }
  return error instanceof Error ? error : new Error(String(error));
}

function rootedCursorExpired(message: string): FilesServiceFault {
  return new FilesServiceFault(
    "cursor_expired",
    message,
    "Refresh the folder",
  );
}

function rootedListConflict(message: string): FilesServiceFault {
  return new FilesServiceFault(
    "conflict",
    message,
    "Refresh the folder",
  );
}

function plainFolderCacheKey(nodeId: CanonicalNat64, path: string): string {
  return `${nodeId}\u0000${path}`;
}

function directServiceChildPath(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

function isExactPlainDirectChild(
  parent: string,
  entry: FilesServiceEntry,
): boolean {
  if (
    entry.name === "" ||
    entry.name.includes("/") ||
    entry.name.includes("\\") ||
    entry.path !== directServiceChildPath(parent, entry.name) ||
    parentServicePath(entry.path) !== parent
  ) {
    return false;
  }
  try {
    return normalizePlainFilesPath(entry.path).path === entry.path;
  } catch {
    return false;
  }
}

function parentServicePath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator <= 0 ? "/" : path.slice(0, separator);
}

function filesRelativeDepth(rooted: FilesRootedPath): number {
  return normalizePlainFilesPath(rooted.relativePath).segments.length;
}

function isNonzeroCanonicalNat64(value: unknown): value is CanonicalNat64 {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]*$/u.test(value)
  ) {
    return false;
  }
  try {
    return BigInt(value) <= 18_446_744_073_709_551_615n;
  } catch {
    return false;
  }
}

function comparePlainServiceNames(left: string, right: string): number {
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

function throwIfRootedAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was cancelled", "AbortError");
  }
}

function requireRoot(
  path: string,
  routing?: FilesPathRouting,
): ResolvedRootedPath {
  const normalized = normalizeFilesPathForRouting(path, routing);
  if (filesPathRoutingMode(routing) === "legacy_vault") {
    // Before v105 every spelling belonged to one encrypted namespace. Keep
    // reserved-looking names and "/" exact rather than interpreting them as
    // policy selectors.
    return {
      path: normalized,
      root: "Vault",
      storageClass: "vault",
      relativePath: normalized,
      isRoot: normalized === "/",
      legacyAlias: true,
    };
  }
  const rooted = parseFilesRootedPath(normalized);
  if (rooted === null) {
    throw invalidRootOperation("Choose Shared, Vault, or Workspace");
  }
  return { ...rooted, legacyAlias: false };
}

function vaultEntry<T extends FilesServiceEntry>(
  rooted: ResolvedRootedPath,
  entry: T,
): T {
  return rooted.legacyAlias
    ? ({
        ...entry,
        storageClass: "vault",
        publicUrl: null,
      } as T)
    : rootedEntry("vault", entry);
}

function requireMutablePath(path: string, routing?: FilesPathRouting) {
  const rooted = requireRoot(path, routing);
  if (
    !rooted.legacyAlias &&
    (rooted.isRoot || isFilesStorageRootPath(path))
  ) {
    throw invalidRootOperation(
      "Shared, Vault, and Workspace cannot be renamed, moved, or removed",
    );
  }
  return rooted;
}

function requireFilePath(path: string, routing?: FilesPathRouting) {
  const rooted = requireRoot(path, routing);
  if (rooted.isRoot && !rooted.legacyAlias) {
    throw invalidRootOperation("Choose a folder inside this Files root");
  }
  return rooted;
}

function invalidRootOperation(message: string): FilesServiceFault {
  return new FilesServiceFault("invalid", message, "Choose another location");
}

function addDecimal(
  left: CanonicalNat64,
  right: CanonicalNat64,
): CanonicalNat64 {
  return (BigInt(left) + BigInt(right)).toString() as CanonicalNat64;
}

function leafName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function sharedMoveSource(entry: FilesServiceEntry): FilesServiceMoveSource {
  if (
    entry.storageClass !== "shared" ||
    entry.nodeId === null ||
    entry.type !== "file"
  ) {
    throw new FilesServiceFault(
      "incompatible",
      "Files could not identify the Shared file being renamed",
      "Refresh Shared and try again",
    );
  }
  return {
    path: entry.path,
    nodeId: entry.nodeId,
    structuralRevision: entry.structuralRevision,
    etagSha256: entry.etagSha256,
  };
}

function byteSource(
  bytes: Uint8Array,
  name: string,
  type: string,
): FilesTransferSource {
  return {
    size: bytes.byteLength,
    name,
    type,
    slice(start, end) {
      return bytes.slice(start, end);
    },
  };
}

function sameSnapshotEntry(
  expected: FilesServiceEntry,
  actual: FilesServiceEntry,
): boolean {
  return (
    expected.path === actual.path &&
    sameStableNodeIdentity(expected, actual) &&
    expected.type === actual.type &&
    expected.createdAtNs === actual.createdAtNs &&
    expected.structuralRevision === actual.structuralRevision &&
    expected.byteLength === actual.byteLength &&
    expected.etagSha256 === actual.etagSha256
  );
}

function sameStableNodeIdentity(
  expected: FilesServiceEntry,
  actual: FilesServiceEntry,
): boolean {
  return (
    expected.nodeId === actual.nodeId &&
    expected.opaqueNodeIdentity === actual.opaqueNodeIdentity
  );
}

function sameExactSnapshotEntry(
  expected: FilesServiceEntry,
  actual: FilesServiceEntry,
): boolean {
  return (
    sameSnapshotEntry(expected, actual) &&
    expected.name === actual.name &&
    expected.storageClass === actual.storageClass &&
    expected.contentKind === actual.contentKind &&
    expected.mediaType === actual.mediaType &&
    expected.publicUrl === actual.publicUrl &&
    expected.modifiedAtNs === actual.modifiedAtNs &&
    expected.contentId === actual.contentId
  );
}

function isTerminalTransferPhase(
  phase: FilesServiceStatus["transfers"][number]["phase"],
): boolean {
  return (
    phase === "committed" ||
    phase === "cleanup-pending" ||
    phase === "cancelled" ||
    phase === "conflicted" ||
    phase === "failed"
  );
}
