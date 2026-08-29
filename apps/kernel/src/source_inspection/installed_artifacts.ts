import { readPackageManifest } from "neutron-compiler/src/install.js";
import { isValidAppId } from "neutron-tools/src/app_ids.js";
import { compareCanonicalText } from "neutron-tools/src/canonical.js";
import { hashContent } from "neutron-tools/src/hash.js";
import {
  KERNEL_INSTALLED_ARTIFACT_INVENTORY_PATH,
  KERNEL_INSTALLED_ARTIFACT_RUNTIME_PATHS,
  INSTALLED_ARTIFACT_PATH_BYTES_MAX,
  kernelInstalledArtifactPath,
  kernelPackagePathIsInventoried,
  kernelPackagePathRequiresInlineText,
  parseKernelInstalledArtifactInventory,
  type KernelInstalledArtifactInventoryFile,
} from "neutron-tools/src/installed_artifacts.js";
import { contentAddressedMotokoImports } from "neutron-tools/src/motoko_imports.js";
import { KernelPolicyError, type JsonObject } from "neutron-tools/protocol";
import type { PackagedNeutronManifest } from "neutron-tools/src/schema.js";
import { throwIfRequestCancelled } from "../request_cancel.ts";

const MIB = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 16 * MIB;
const MAX_BACKEND_BYTES = 32 * MIB;
const MAX_BACKEND_MODULES = 4_096;
const MAX_BACKEND_READ_CONCURRENCY = 2;
const MAX_LISTED_ASSETS = 20_000;
const MAX_INVENTORY_BYTES = 16 * MIB;
const MAX_RESULT_BYTES = 96 * 1024;
const SEARCH_FILE_MAX_BYTES = 8 * MIB;
const SEARCH_PAGE_MAX_BYTES = 8 * MIB;
const SEARCH_PAGE_MAX_FILES = 32;
const SEARCH_MAX_MATCHES_PER_FILE = 8;
const TEXT_CHUNK_MIN_BYTES = 4;
const TEXT_CHUNK_MAX_BYTES = 49_152;
const SHA256 = /^[a-f0-9]{64}$/u;
const textEncoder = new TextEncoder();
const sourceTextDecoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});
const jsonTextDecoder = new TextDecoder("utf-8", { fatal: true });

export type InstalledArtifactArea =
  "frontend" | "backend" | "package" | "runtime";

export type InstalledArtifactBinding = Readonly<{
  appId: string;
  version: number;
  installationUid: string;
  capabilityPlanFingerprint: string;
  /** Fences in-flight reads and cache reuse, but is not in the public revision. */
  runtimeIdentity: string;
}>;

export type InstalledArtifactRead =
  | Readonly<{ status: "ok"; content: Uint8Array }>
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "too_large" }>;

export type InstalledArtifactInspectionEnvironment = Readonly<{
  currentBinding(appId: string): InstalledArtifactBinding | null;
  listStatic(prefix: string, signal?: AbortSignal): Promise<readonly string[]>;
  readAsset(
    path: string,
    maximumBytes: number,
    signal?: AbortSignal,
  ): Promise<InstalledArtifactRead>;
}>;

type ArtifactEntry = Readonly<{
  path: string;
  area: InstalledArtifactArea;
  expected?: Readonly<{ bytes: number; sha256: string }>;
  readability: "text" | "unknown";
}>;

type Catalog = Readonly<{
  binding: InstalledArtifactBinding;
  revision: string;
  entries: readonly ArtifactEntry[];
  byPath: ReadonlyMap<string, ArtifactEntry>;
  bytes: Map<string, Uint8Array>;
  recentAsset: Map<string, Uint8Array>;
  anchors: ReadonlyMap<string, string>;
}>;

type FilesInput = Readonly<{
  appId: string;
  sourceRevision: string | null;
  cursor: string | null;
  area: "all" | InstalledArtifactArea;
  pathPrefix: string;
  limit: number;
}>;

type SearchInput = Readonly<{
  appId: string;
  sourceRevision: string;
  query: string;
  cursor: string | null;
  area: "all" | InstalledArtifactArea;
  pathPrefix: string;
  caseSensitive: boolean;
  limit: number;
}>;

type ReadInput = Readonly<{
  appId: string;
  sourceRevision: string;
  path: string;
  cursor: string | null;
  maxBytes: number;
}>;

/**
 * Read-only view over the exact transformed artifacts retained by the running
 * Neutron. No repository, update source, arbitrary URL, or backend mutation is
 * involved.
 */
export class InstalledArtifactInspector {
  private cache: Catalog | null = null;
  private buildingCatalog = false;

  constructor(
    private readonly environment: InstalledArtifactInspectionEnvironment,
  ) {}

  async list(
    raw: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    const input = parseFilesInput(raw);
    if (input.cursor !== null && input.sourceRevision === null) {
      invalidRequest(
        "source.files continuation requires the returned sourceRevision",
      );
    }
    const catalog = await this.catalog(input.appId, signal);
    assertRequestedRevision(input.sourceRevision, catalog.revision, true);

    const matching = catalog.entries.filter(
      (entry) =>
        (input.area === "all" || entry.area === input.area) &&
        entry.path.startsWith(input.pathPrefix),
    );
    const position = parseCursor(input.cursor, "list", (candidate) =>
      cursorDigest(
        "list",
        listCursorArguments(input, catalog.revision),
        candidate,
      ),
    );
    if (position.length !== 1 || position[0]! > matching.length) {
      invalidRequest("Invalid source.files cursor");
    }

    const artifacts: JsonObject[] = [];
    let index = position[0]!;
    while (index < matching.length && artifacts.length < input.limit) {
      throwIfRequestCancelled(signal);
      const entry = matching[index]!;
      const candidate: JsonObject = {
        path: entry.path,
        area: entry.area,
        readability: entry.readability,
        ...(entry.expected
          ? {
              bytes: entry.expected.bytes,
              sha256: entry.expected.sha256,
            }
          : {}),
      };
      if (
        artifacts.length > 0 &&
        serializedBytes({ artifacts: [...artifacts, candidate] }) >
          MAX_RESULT_BYTES
      ) {
        break;
      }
      artifacts.push(candidate);
      index += 1;
    }

    await this.assertCurrent(catalog, signal);
    const complete = index >= matching.length;
    return {
      appId: input.appId,
      appVersion: catalog.binding.version,
      installationUid: catalog.binding.installationUid,
      sourceRevision: catalog.revision,
      artifacts,
      complete,
      nextCursor: complete
        ? null
        : createCursor("list", [index], (candidate) =>
            cursorDigest(
              "list",
              listCursorArguments(input, catalog.revision),
              candidate,
            ),
          ),
    };
  }

  async search(
    raw: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    const input = parseSearchInput(raw);
    const catalog = await this.catalog(input.appId, signal);
    assertRequestedRevision(input.sourceRevision, catalog.revision, false);
    const entries = catalog.entries.filter(
      (entry) =>
        (input.area === "all" || entry.area === input.area) &&
        entry.path.startsWith(input.pathPrefix),
    );
    const cursorArguments = searchCursorArguments(input, catalog.revision);
    const position = parseCursor(input.cursor, "search", (candidate) =>
      cursorDigest("search", cursorArguments, candidate),
    );
    if (position.length !== 1 || position[0]! > entries.length) {
      invalidRequest("Invalid source.search cursor");
    }

    const matches: JsonObject[] = [];
    let fileIndex = position[0]!;
    let scannedFiles = 0;
    let attemptedFiles = 0;
    let scannedBytes = 0;
    let skippedBinaryFiles = 0;
    let skippedLargeFiles = 0;
    let skippedUnavailableFiles = 0;
    let truncatedFiles = 0;
    const needle = input.caseSensitive
      ? input.query
      : foldAsciiCase(input.query);

    search: while (fileIndex < entries.length) {
      throwIfRequestCancelled(signal);
      if (attemptedFiles >= SEARCH_PAGE_MAX_FILES) break;
      attemptedFiles += 1;
      const entry = entries[fileIndex]!;
      let loaded: InstalledArtifactRead;
      try {
        loaded = await this.readEntry(
          catalog,
          entry,
          SEARCH_FILE_MAX_BYTES,
          signal,
        );
      } catch (error) {
        if (entry.expected) throw error;
        skippedUnavailableFiles += 1;
        fileIndex += 1;
        continue;
      }
      if (loaded.status === "too_large") {
        skippedLargeFiles += 1;
        fileIndex += 1;
        break;
      }
      if (loaded.status === "missing") {
        throw artifactsChanged();
      }
      const content = loaded.content;
      if (
        scannedFiles > 0 &&
        scannedBytes + content.byteLength > SEARCH_PAGE_MAX_BYTES
      ) {
        break;
      }
      scannedFiles += 1;
      scannedBytes += content.byteLength;

      const text = decodeText(content);
      if (text === null) {
        skippedBinaryFiles += 1;
        fileIndex += 1;
        continue;
      }
      const haystack = input.caseSensitive ? text : foldAsciiCase(text);
      const fileSha256 = entry.expected?.sha256 ?? hashContent(content);
      let textOffset = 0;
      let fileMatches = 0;
      while (textOffset <= haystack.length) {
        throwIfRequestCancelled(signal);
        const found = haystack.indexOf(needle, textOffset);
        if (found < 0) break;
        if (fileMatches >= SEARCH_MAX_MATCHES_PER_FILE) {
          truncatedFiles += 1;
          break;
        }
        const nextOffset = found + Math.max(needle.length, 1);
        const candidate: JsonObject = {
          path: entry.path,
          area: entry.area,
          characterOffset: found,
          preview: searchPreview(text, found, input.query.length),
          sha256: fileSha256,
        };
        if (
          matches.length > 0 &&
          serializedBytes({ matches: [...matches, candidate] }) >
            MAX_RESULT_BYTES
        ) {
          throw new Error("Source search result exceeded its bounded schema");
        }
        matches.push(candidate);
        fileMatches += 1;
        textOffset = nextOffset;
        if (matches.length >= input.limit) {
          if (haystack.indexOf(needle, textOffset) >= 0) truncatedFiles += 1;
          fileIndex += 1;
          break search;
        }
      }
      fileIndex += 1;
    }

    await this.assertCurrent(catalog, signal);
    const complete = fileIndex >= entries.length;
    return {
      appId: input.appId,
      sourceRevision: catalog.revision,
      matches,
      scannedFiles,
      scannedBytes,
      skippedBinaryFiles,
      skippedLargeFiles,
      skippedUnavailableFiles,
      truncatedFiles,
      complete,
      nextCursor: complete
        ? null
        : createCursor("search", [fileIndex], (candidate) =>
            cursorDigest("search", cursorArguments, candidate),
          ),
    };
  }

  async read(
    raw: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    const input = parseReadInput(raw);
    const catalog = await this.catalog(input.appId, signal);
    assertRequestedRevision(input.sourceRevision, catalog.revision, false);
    const entry = catalog.byPath.get(input.path);
    if (!entry) invalidRequest("source.read path is not in this app's catalog");
    const cursorArguments = readCursorArguments(input, catalog.revision);
    const position = parseCursor(input.cursor, "read", (candidate) =>
      cursorDigest("read", cursorArguments, candidate),
    );
    if (position.length !== 1) invalidRequest("Invalid source.read cursor");

    const loaded = await this.readEntry(
      catalog,
      entry,
      MAX_ARTIFACT_BYTES,
      signal,
    );
    if (loaded.status === "missing") throw artifactsChanged();
    if (loaded.status === "too_large") {
      await this.assertCurrent(catalog, signal);
      return {
        appId: input.appId,
        sourceRevision: catalog.revision,
        path: entry.path,
        area: entry.area,
        kind: "unavailable",
        reason: `Artifact exceeds the ${MAX_ARTIFACT_BYTES}-byte safe read limit`,
        complete: true,
        nextCursor: null,
      };
    }

    const content = loaded.content;
    const digest = entry.expected?.sha256 ?? hashContent(content);
    const text = decodeText(content);
    if (text === null) {
      if (position[0] !== 0) invalidRequest("Binary artifacts have no cursor");
      await this.assertCurrent(catalog, signal);
      return {
        appId: input.appId,
        sourceRevision: catalog.revision,
        path: entry.path,
        area: entry.area,
        kind: "binary",
        sha256: digest,
        totalBytes: content.byteLength,
        complete: true,
        nextCursor: null,
      };
    }

    const startByte = position[0]!;
    if (startByte > content.byteLength || !isUtf8Boundary(content, startByte)) {
      invalidRequest("Invalid source.read cursor offset");
    }
    let endByte = utf8EndBoundary(
      content,
      Math.min(content.byteLength, startByte + input.maxBytes),
    );
    let chunk = sourceTextDecoder.decode(content.subarray(startByte, endByte));
    while (true) {
      const complete = endByte >= content.byteLength;
      const result = {
        appId: input.appId,
        sourceRevision: catalog.revision,
        path: entry.path,
        area: entry.area,
        kind: "text" as const,
        sha256: digest,
        totalBytes: content.byteLength,
        startByte,
        endByte,
        text: chunk,
        complete,
        nextCursor: complete
          ? null
          : createCursor("read", [endByte], (candidate) =>
              cursorDigest("read", cursorArguments, candidate),
            ),
      };
      if (serializedBytes(result) <= MAX_RESULT_BYTES) {
        await this.assertCurrent(catalog, signal);
        return result;
      }
      const candidateEnd = utf8EndBoundary(
        content,
        startByte + Math.floor((endByte - startByte) / 2),
      );
      if (candidateEnd <= startByte) {
        throw new Error("A source character cannot fit in the tool result");
      }
      endByte = candidateEnd;
      chunk = sourceTextDecoder.decode(content.subarray(startByte, endByte));
    }
  }

  private async catalog(appId: string, signal?: AbortSignal): Promise<Catalog> {
    throwIfRequestCancelled(signal);
    if (!isValidAppId(appId)) invalidRequest("Unknown installed app id");
    const binding = this.environment.currentBinding(appId);
    if (!binding) invalidRequest(`App '${appId}' is not installed`);
    if (
      this.cache?.binding.appId === appId &&
      sameTargetBinding(binding, this.cache.binding)
    ) {
      return this.cache;
    }
    if (this.buildingCatalog) {
      throw new KernelPolicyError(
        "UI_BUSY",
        "Another installed-artifact catalog is being prepared",
      );
    }

    this.cache = null;
    this.buildingCatalog = true;
    try {
      const catalog = await this.buildCatalog(binding, signal);
      this.cache = catalog;
      return catalog;
    } finally {
      this.buildingCatalog = false;
    }
  }

  private async buildCatalog(
    binding: InstalledArtifactBinding,
    signal?: AbortSignal,
  ): Promise<Catalog> {
    const manifestPath = installedManifestPath(binding.appId);
    const manifestBytes = await this.readRequired(
      manifestPath,
      MAX_ARTIFACT_BYTES,
      signal,
    );
    const manifestSha256 = hashContent(manifestBytes);
    let manifest: PackagedNeutronManifest;
    try {
      manifest = readPackageManifest({ "neutron.json": manifestBytes });
    } catch (cause) {
      throw new Error(`Installed manifest for ${binding.appId} is invalid`, {
        cause,
      });
    }
    if (manifest.id !== binding.appId || manifest.version !== binding.version) {
      throw artifactsChanged();
    }

    const entries = new Map<string, ArtifactEntry>();
    const bytes = new Map<string, Uint8Array>([[manifestPath, manifestBytes]]);
    const anchors = new Map<string, string>([[manifestPath, manifestSha256]]);
    if (binding.appId === "kernel") {
      await this.addKernelStaticArtifacts(
        manifest,
        manifestBytes,
        entries,
        bytes,
        anchors,
        signal,
      );
    } else {
      await this.addAppStaticArtifacts(binding.appId, entries, signal);
      if (!entries.has(manifestPath)) {
        throw new Error(`Installed asset inventory omitted ${manifestPath}`);
      }
    }

    await this.addBackendClosure(manifest, entries, bytes, signal);
    const orderedEntries = [...entries.values()].sort((left, right) =>
      compareCanonicalText(left.path, right.path),
    );
    const revision = hashContent(
      JSON.stringify({
        format: 1,
        appId: binding.appId,
        version: binding.version,
        installationUid: binding.installationUid,
        capabilityPlanFingerprint: binding.capabilityPlanFingerprint,
        manifestSha256,
        artifacts: orderedEntries.map((entry) => [
          entry.path,
          entry.area,
          entry.expected?.bytes ?? null,
          entry.expected?.sha256 ?? null,
        ]),
      }),
    );
    const catalog: Catalog = Object.freeze({
      binding,
      revision,
      entries: Object.freeze(orderedEntries),
      byPath: entries,
      bytes,
      recentAsset: new Map(),
      anchors,
    });
    return catalog;
  }

  private async addAppStaticArtifacts(
    appId: string,
    entries: Map<string, ArtifactEntry>,
    signal?: AbortSignal,
  ): Promise<void> {
    const prefix = `/app/${appId}/`;
    const listed = await this.environment.listStatic(prefix, signal);
    throwIfRequestCancelled(signal);
    if (!Array.isArray(listed) || listed.length > MAX_LISTED_ASSETS) {
      throw new Error("Installed app asset inventory is too large");
    }
    for (const path of listed) {
      assertInstalledPath(path);
      if (!path.startsWith(prefix)) {
        throw new Error(
          "Installed app asset inventory escaped its app subtree",
        );
      }
      const relative = path.slice(prefix.length);
      if (relative === "_route" || relative.startsWith("_route/")) continue;
      addEntry(entries, {
        path,
        area:
          relative === "pkg" || relative.startsWith("pkg/")
            ? "package"
            : "frontend",
        readability: "unknown",
      });
    }
  }

  private async addKernelStaticArtifacts(
    manifest: PackagedNeutronManifest,
    manifestBytes: Uint8Array,
    entries: Map<string, ArtifactEntry>,
    bytes: Map<string, Uint8Array>,
    anchors: Map<string, string>,
    signal?: AbortSignal,
  ): Promise<void> {
    const inventoryBytes = await this.readRequired(
      KERNEL_INSTALLED_ARTIFACT_INVENTORY_PATH,
      MAX_INVENTORY_BYTES,
      signal,
    );
    let inventory;
    try {
      inventory = parseKernelInstalledArtifactInventory(
        JSON.parse(jsonTextDecoder.decode(inventoryBytes)),
      );
    } catch (cause) {
      throw new Error("Kernel installed-artifact inventory is invalid", {
        cause,
      });
    }
    if (inventory.package.version !== manifest.version) {
      throw artifactsChanged();
    }
    for (const file of inventory.artifacts) {
      const installedPath = kernelInventoryInstalledPath(file);
      addEntry(entries, {
        path: installedPath,
        area: file.package_path.startsWith("web/") ? "frontend" : "package",
        readability: file.inline_text === undefined ? "unknown" : "text",
        expected: { bytes: file.bytes, sha256: file.sha256 },
      });
      if (file.inline_text !== undefined) {
        bytes.set(installedPath, textEncoder.encode(file.inline_text));
      }
    }
    const manifestClaim = entries.get("/pkg/neutron.json")?.expected;
    if (
      !manifestClaim ||
      manifestClaim.bytes !== manifestBytes.byteLength ||
      manifestClaim.sha256 !== hashContent(manifestBytes)
    ) {
      throw new Error("Kernel inventory does not bind its installed manifest");
    }

    const inventorySha256 = hashContent(inventoryBytes);
    addEntry(entries, {
      path: KERNEL_INSTALLED_ARTIFACT_INVENTORY_PATH,
      area: "package",
      readability: "unknown",
      expected: {
        bytes: inventoryBytes.byteLength,
        sha256: inventorySha256,
      },
    });
    anchors.set(KERNEL_INSTALLED_ARTIFACT_INVENTORY_PATH, inventorySha256);

    for (const path of KERNEL_INSTALLED_ARTIFACT_RUNTIME_PATHS) {
      const content = await this.readRequired(path, MAX_ARTIFACT_BYTES, signal);
      const sha256 = hashContent(content);
      addEntry(entries, {
        path,
        area: "runtime",
        readability: "unknown",
        expected: { bytes: content.byteLength, sha256 },
      });
      anchors.set(path, sha256);
    }
  }

  private async addBackendClosure(
    manifest: PackagedNeutronManifest,
    entries: Map<string, ArtifactEntry>,
    bytes: Map<string, Uint8Array>,
    signal?: AbortSignal,
  ): Promise<void> {
    const requiredRoots = new Set([manifest.entry]);
    const optionalRoots = new Set<string>();
    for (const memory of Object.values(manifest.memory ?? {})) {
      for (const [version, schema] of Object.entries(memory.schemas ?? {})) {
        if (!schema.entry) continue;
        if (!memory.retired && Number(version) === memory.version) {
          requiredRoots.add(schema.entry);
        } else {
          optionalRoots.add(schema.entry);
        }
      }
      for (const migration of memory.migrations ?? []) {
        if (!migration.entry) continue;
        optionalRoots.add(migration.entry);
      }
    }

    const visited = new Set<string>();
    const attempted = new Set<string>();
    let totalBytes = 0;
    const visit = async (root: string, required: boolean): Promise<void> => {
      const pending = [root];
      const queued = new Set([root]);
      while (pending.length > 0) {
        throwIfRequestCancelled(signal);
        const batch: string[] = [];
        while (
          pending.length > 0 &&
          batch.length < MAX_BACKEND_READ_CONCURRENCY
        ) {
          const hash = pending.pop()!;
          queued.delete(hash);
          assertModuleHash(hash);
          if (visited.has(hash) || attempted.has(hash)) continue;
          if (attempted.size >= MAX_BACKEND_MODULES) {
            throw new Error(
              "Installed backend closure exceeds the inspection limit",
            );
          }
          attempted.add(hash);
          batch.push(hash);
        }
        const loadedBatch = await Promise.all(
          batch.map(async (hash) => ({
            hash,
            loaded: await this.environment.readAsset(
              `/mo/${hash}.mo`,
              MAX_ARTIFACT_BYTES,
              signal,
            ),
          })),
        );
        for (const { hash, loaded } of loadedBatch) {
          const path = `/mo/${hash}.mo`;
          if (loaded.status !== "ok") {
            if (!required) continue;
            throw new Error(
              `Required installed backend module ${path} is missing`,
            );
          }
          const content = loaded.content;
          if (hashContent(content) !== hash) {
            throw new Error(
              `Installed backend module ${path} has the wrong digest`,
            );
          }
          const text = decodeText(content);
          if (text === null) {
            throw new Error(
              `Installed backend module ${path} is not UTF-8 text`,
            );
          }
          totalBytes += content.byteLength;
          if (
            visited.size >= MAX_BACKEND_MODULES ||
            totalBytes > MAX_BACKEND_BYTES
          ) {
            throw new Error(
              "Installed backend closure exceeds the inspection limit",
            );
          }
          visited.add(hash);
          bytes.set(path, content);
          addEntry(entries, {
            path,
            area: "backend",
            readability: "text",
            expected: { bytes: content.byteLength, sha256: hash },
          });
          for (const dependency of contentAddressedMotokoImports(
            text,
            MAX_BACKEND_MODULES,
          ).reverse()) {
            if (
              visited.has(dependency) ||
              attempted.has(dependency) ||
              queued.has(dependency)
            ) {
              continue;
            }
            if (attempted.size + queued.size >= MAX_BACKEND_MODULES) {
              throw new Error(
                "Installed backend closure exceeds the inspection limit",
              );
            }
            queued.add(dependency);
            pending.push(dependency);
          }
        }
      }
    };

    for (const root of requiredRoots) await visit(root, true);
    for (const root of optionalRoots) {
      if (!requiredRoots.has(root)) await visit(root, false);
    }
  }

  private async readEntry(
    catalog: Catalog,
    entry: ArtifactEntry,
    maximumBytes: number,
    signal?: AbortSignal,
  ): Promise<InstalledArtifactRead> {
    throwIfRequestCancelled(signal);
    const cached =
      catalog.bytes.get(entry.path) ?? catalog.recentAsset.get(entry.path);
    if (cached) {
      return cached.byteLength > maximumBytes
        ? { status: "too_large" }
        : { status: "ok", content: cached };
    }
    if (entry.expected && entry.expected.bytes > maximumBytes) {
      return { status: "too_large" };
    }
    const loaded = await this.environment.readAsset(
      entry.path,
      maximumBytes,
      signal,
    );
    throwIfRequestCancelled(signal);
    if (loaded.status === "too_large" && entry.expected) {
      throw new Error(
        `Installed artifact ${entry.path} failed integrity verification`,
      );
    }
    if (loaded.status !== "ok") return loaded;
    if (
      entry.expected &&
      (loaded.content.byteLength !== entry.expected.bytes ||
        hashContent(loaded.content) !== entry.expected.sha256)
    ) {
      throw new Error(
        `Installed artifact ${entry.path} failed integrity verification`,
      );
    }
    catalog.recentAsset.clear();
    catalog.recentAsset.set(entry.path, loaded.content);
    return loaded;
  }

  private async readRequired(
    path: string,
    maximumBytes: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const loaded = await this.environment.readAsset(path, maximumBytes, signal);
    throwIfRequestCancelled(signal);
    if (loaded.status === "too_large") {
      throw new Error(`Installed artifact ${path} exceeds its safe read limit`);
    }
    if (loaded.status === "missing") {
      throw new Error(`Installed artifact ${path} was not found`);
    }
    return loaded.content;
  }

  private async assertCurrent(
    catalog: Catalog,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfRequestCancelled(signal);
    const current = this.environment.currentBinding(catalog.binding.appId);
    if (!current || !sameTargetBinding(current, catalog.binding)) {
      throw artifactsChanged();
    }
    for (const [path, expectedSha256] of catalog.anchors) {
      const content = await this.readRequired(path, MAX_ARTIFACT_BYTES, signal);
      if (hashContent(content) !== expectedSha256) throw artifactsChanged();
    }
    throwIfRequestCancelled(signal);
    const afterAnchors = this.environment.currentBinding(catalog.binding.appId);
    if (!afterAnchors || !sameTargetBinding(afterAnchors, catalog.binding)) {
      throw artifactsChanged();
    }
  }
}

function addEntry(
  entries: Map<string, ArtifactEntry>,
  entry: ArtifactEntry,
): void {
  assertInstalledPath(entry.path);
  if (entries.has(entry.path)) {
    throw new Error(`Installed artifact inventory repeats ${entry.path}`);
  }
  entries.set(entry.path, Object.freeze(entry));
}

function kernelInventoryInstalledPath(
  file: KernelInstalledArtifactInventoryFile,
): string {
  if (!kernelPackagePathIsInventoried(file.package_path)) {
    throw new Error("Kernel inventory includes a runtime-generated artifact");
  }
  const installedPath = kernelInstalledArtifactPath(file.package_path);
  if (
    file.package_path.startsWith("web/") &&
    (/^\/(?:app|mo|pkg)(?:\/|$)/u.test(installedPath) ||
      (/^\/system(?:\/|$)/u.test(installedPath) &&
        !kernelPackagePathRequiresInlineText(file.package_path)))
  ) {
    throw new Error("Kernel frontend inventory overlaps a reserved subtree");
  }
  return installedPath;
}

function installedManifestPath(appId: string): string {
  return appId === "kernel"
    ? "/pkg/neutron.json"
    : `/app/${appId}/pkg/neutron.json`;
}

function sameTargetBinding(
  left: InstalledArtifactBinding,
  right: InstalledArtifactBinding,
): boolean {
  return (
    left.appId === right.appId &&
    left.version === right.version &&
    left.installationUid === right.installationUid &&
    left.capabilityPlanFingerprint === right.capabilityPlanFingerprint &&
    left.runtimeIdentity === right.runtimeIdentity
  );
}

function assertRequestedRevision(
  requested: string | null,
  current: string,
  allowNull: boolean,
): void {
  if ((allowNull && requested === null) || requested === current) return;
  throw artifactsChanged();
}

function artifactsChanged(): KernelPolicyError {
  return new KernelPolicyError(
    "REQUEST_CANCELLED",
    "Installed artifacts changed; restart with source.files",
  );
}

function invalidRequest(message: string): never {
  throw new KernelPolicyError("INVALID_REQUEST", message);
}

function parseFilesInput(raw: Readonly<Record<string, unknown>>): FilesInput {
  assertExactKeys(raw, [
    "appId",
    "sourceRevision",
    "cursor",
    "area",
    "pathPrefix",
    "limit",
  ]);
  return {
    appId: appId(raw.appId),
    sourceRevision: nullableRevision(raw.sourceRevision),
    cursor: nullableCursor(raw.cursor),
    area: area(raw.area),
    pathPrefix: pathPrefix(raw.pathPrefix),
    limit: boundedInteger(raw.limit, 1, 128, 128, "limit"),
  };
}

function parseSearchInput(raw: Readonly<Record<string, unknown>>): SearchInput {
  assertExactKeys(raw, [
    "appId",
    "sourceRevision",
    "query",
    "cursor",
    "area",
    "pathPrefix",
    "caseSensitive",
    "limit",
  ]);
  if (
    typeof raw.query !== "string" ||
    raw.query.length < 1 ||
    raw.query.length > 256 ||
    /\u0000/u.test(raw.query)
  ) {
    invalidRequest("source.search query is invalid");
  }
  if (
    raw.caseSensitive !== undefined &&
    typeof raw.caseSensitive !== "boolean"
  ) {
    invalidRequest("source.search caseSensitive is invalid");
  }
  return {
    appId: appId(raw.appId),
    sourceRevision: revision(raw.sourceRevision),
    query: raw.query,
    cursor: nullableCursor(raw.cursor),
    area: area(raw.area),
    pathPrefix: pathPrefix(raw.pathPrefix),
    caseSensitive: raw.caseSensitive === undefined ? true : raw.caseSensitive,
    limit: boundedInteger(raw.limit, 1, 8, 8, "limit"),
  };
}

function parseReadInput(raw: Readonly<Record<string, unknown>>): ReadInput {
  assertExactKeys(raw, [
    "appId",
    "sourceRevision",
    "path",
    "cursor",
    "maxBytes",
  ]);
  assertInstalledPath(raw.path);
  return {
    appId: appId(raw.appId),
    sourceRevision: revision(raw.sourceRevision),
    path: raw.path,
    cursor: nullableCursor(raw.cursor),
    maxBytes: boundedInteger(
      raw.maxBytes,
      TEXT_CHUNK_MIN_BYTES,
      TEXT_CHUNK_MAX_BYTES,
      TEXT_CHUNK_MAX_BYTES,
      "maxBytes",
    ),
  };
}

function assertExactKeys(
  raw: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(raw).some((key) => !allowedSet.has(key))) {
    invalidRequest("Source inspection request has unknown fields");
  }
}

function appId(value: unknown): string {
  if (typeof value !== "string" || !isValidAppId(value)) {
    invalidRequest("Invalid installed app id");
  }
  return value;
}

function nullableRevision(value: unknown): string | null {
  if (value === null) return null;
  return revision(value);
}

function revision(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    invalidRequest("Invalid source revision");
  }
  return value;
}

function nullableCursor(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    !/^[a-z0-9.]+$/u.test(value)
  ) {
    invalidRequest("Invalid source cursor");
  }
  return value;
}

function area(value: unknown): "all" | InstalledArtifactArea {
  if (value === undefined) return "all";
  if (
    value !== "all" &&
    value !== "frontend" &&
    value !== "backend" &&
    value !== "package" &&
    value !== "runtime"
  ) {
    invalidRequest("Invalid source area");
  }
  return value;
}

function pathPrefix(value: unknown): string {
  if (value === undefined) return "";
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    textEncoder.encode(value).byteLength > INSTALLED_ARTIFACT_PATH_BYTES_MAX ||
    /[?#%\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    invalidRequest("Invalid source path prefix");
  }
  return value;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    invalidRequest(`Invalid source ${label}`);
  }
  return Number(value);
}

function assertInstalledPath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    textEncoder.encode(value).byteLength > INSTALLED_ARTIFACT_PATH_BYTES_MAX ||
    value.includes("\\") ||
    value.includes("//") ||
    /[?#%\u0000-\u001f\u007f-\u009f]/u.test(value) ||
    (value !== "/" &&
      value
        .slice(1)
        .split("/")
        .some((part) => part === "" || part === "." || part === ".."))
  ) {
    invalidRequest("Invalid installed artifact path");
  }
}

function assertModuleHash(value: string): void {
  if (!SHA256.test(value)) {
    throw new Error("Installed manifest contains an invalid backend root");
  }
}

function decodeText(content: Uint8Array): string | null {
  if (content.includes(0)) return null;
  try {
    return sourceTextDecoder.decode(content);
  } catch {
    return null;
  }
}

function serializedBytes(value: unknown): number {
  return textEncoder.encode(JSON.stringify(value)).byteLength;
}

function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function searchPreview(text: string, offset: number, length: number): string {
  const start = Math.max(0, offset - 96);
  const end = Math.min(text.length, offset + length + 96);
  return text.slice(start, end).replace(/[\r\n\t]+/gu, " ");
}

function isUtf8Boundary(content: Uint8Array, offset: number): boolean {
  return (
    offset === 0 ||
    offset === content.byteLength ||
    (content[offset]! & 0xc0) !== 0x80
  );
}

function utf8EndBoundary(content: Uint8Array, proposed: number): number {
  let end = proposed;
  while (end > 0 && end < content.byteLength && !isUtf8Boundary(content, end)) {
    end -= 1;
  }
  return end;
}

function listCursorArguments(input: FilesInput, revision: string): unknown {
  return [input.appId, revision, input.area, input.pathPrefix, input.limit];
}

function searchCursorArguments(input: SearchInput, revision: string): unknown {
  return [
    input.appId,
    revision,
    input.query,
    input.area,
    input.pathPrefix,
    input.caseSensitive,
    input.limit,
  ];
}

function readCursorArguments(input: ReadInput, revision: string): unknown {
  return [input.appId, revision, input.path, input.maxBytes];
}

function cursorDigest(
  kind: string,
  args: unknown,
  position: readonly number[],
): string {
  return hashContent(JSON.stringify([1, kind, args, position]));
}

function createCursor(
  kind: "list" | "search" | "read",
  position: readonly number[],
  digest: (position: readonly number[]) => string,
): string {
  return `v1.${kind}.${position.join(".")}.${digest(position)}`;
}

function parseCursor(
  value: string | null,
  kind: "list" | "search" | "read",
  digest: (position: readonly number[]) => string,
): number[] {
  if (value === null) return [0];
  const parts = value.split(".");
  const expectedLength = 4;
  if (
    parts.length !== expectedLength ||
    parts[0] !== "v1" ||
    parts[1] !== kind
  ) {
    invalidRequest(`Invalid ${cursorToolName(kind)} cursor`);
  }
  const positionParts = parts.slice(2, -1);
  if (positionParts.some((part) => !/^(?:0|[1-9][0-9]*)$/u.test(part))) {
    invalidRequest(`Invalid ${cursorToolName(kind)} cursor`);
  }
  const position = positionParts.map(Number);
  if (position.some((part) => !Number.isSafeInteger(part))) {
    invalidRequest(`Invalid ${cursorToolName(kind)} cursor`);
  }
  if (parts.at(-1) !== digest(position)) {
    invalidRequest(
      `${cursorToolName(kind)} cursor does not match this request`,
    );
  }
  return position;
}

function cursorToolName(kind: "list" | "search" | "read"): string {
  return kind === "list" ? "source.files" : `source.${kind}`;
}
