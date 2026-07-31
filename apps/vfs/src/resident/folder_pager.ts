import type { CanonicalNat64 } from "../protocol/types.ts";
import { normalizeFilesPath } from "./paths.ts";

export const FILES_FOLDER_PAGE_LIMIT = 200;
export const FILES_FOLDER_SCAN_MAX_PAGES = 64;

export type FilesFolderEntry = Readonly<{
  path: string;
  name: string;
  kind: "file" | "folder";
  size: number | null;
  mediaType: string | null;
  contentKind: "text" | "binary" | null;
  etag: string | null;
  modifiedAtNs: CanonicalNat64 | null;
  structuralRevision: CanonicalNat64;
  contentId: string | null;
}>;

export type FilesFolderBackendPage<Cursor> = Readonly<{
  path: string;
  folderRevision: CanonicalNat64;
  entries: readonly FilesFolderEntry[];
  total: number;
  cursor: Cursor | null;
  hasMore: boolean;
}>;

export type FilesFolderPagePort<Cursor> = Readonly<{
  page(input: {
    path: string;
    expectedFolderRevision: CanonicalNat64 | null;
    cursor: Cursor | null;
    limit: number;
    signal?: AbortSignal;
  }): Promise<FilesFolderBackendPage<Cursor>>;
  exact(path: string, name: string, signal?: AbortSignal): Promise<FilesFolderEntry | null>;
}>;

export type FilesFolderSnapshot<Cursor> = Readonly<{
  path: string;
  folderRevision: CanonicalNat64 | null;
  entries: readonly FilesFolderEntry[];
  loaded: number;
  total: number;
  cursor: Cursor | null;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
}>;

export class FilesFolderPager<Cursor> {
  readonly #folders = new Map<string, FilesFolderSnapshot<Cursor>>();
  readonly #pending = new Map<string, Promise<FilesFolderSnapshot<Cursor>>>();

  constructor(private readonly port: FilesFolderPagePort<Cursor>) {}

  snapshot(input: string): FilesFolderSnapshot<Cursor> {
    const path = normalizeFilesPath(input).path;
    return this.#folders.get(path) ?? emptySnapshot(path);
  }

  loadFirst(
    input: string,
    signal?: AbortSignal,
  ): Promise<FilesFolderSnapshot<Cursor>> {
    const path = normalizeFilesPath(input).path;
    return this.#load(path, true, signal);
  }

  loadMore(
    input: string,
    signal?: AbortSignal,
  ): Promise<FilesFolderSnapshot<Cursor>> {
    const path = normalizeFilesPath(input).path;
    const current = this.snapshot(path);
    if (!current.hasMore && current.folderRevision !== null) {
      return Promise.resolve(current);
    }
    return this.#load(path, false, signal);
  }

  async scan(
    input: string,
    query: string,
    options: { fuzzy?: boolean; maxPages?: number; signal?: AbortSignal } = {},
  ): Promise<readonly FilesFolderEntry[]> {
    const path = normalizeFilesPath(input).path;
    const needle = query.normalize("NFC").toLocaleLowerCase();
    if (!needle) return [];
    const maxPages = bounded(
      options.maxPages ?? FILES_FOLDER_SCAN_MAX_PAGES,
      1,
      FILES_FOLDER_SCAN_MAX_PAGES,
      "folder scan page limit",
    );
    const exact = await this.port.exact(path, query, options.signal);
    const matches = new Map<string, FilesFolderEntry>();
    if (exact) matches.set(exact.path, exact);
    let snapshot = await this.loadFirst(path, options.signal);
    for (let page = 1; ; page += 1) {
      throwIfAborted(options.signal);
      for (const entry of snapshot.entries) {
        const candidate = entry.name.toLocaleLowerCase();
        if (
          candidate.startsWith(needle) ||
          (options.fuzzy === true && subsequence(needle, candidate))
        ) {
          matches.set(entry.path, entry);
        }
      }
      if (!snapshot.hasMore || page >= maxPages) break;
      snapshot = await this.loadMore(path, options.signal);
    }
    return sortEntries([...matches.values()]);
  }

  invalidate(input?: string): void {
    if (input === undefined) {
      this.#folders.clear();
      return;
    }
    this.#folders.delete(normalizeFilesPath(input).path);
  }

  clear(): void {
    this.#folders.clear();
  }

  async #load(
    path: string,
    restart: boolean,
    signal?: AbortSignal,
  ): Promise<FilesFolderSnapshot<Cursor>> {
    const existing = this.#pending.get(path);
    if (existing) return existing;
    const operation = this.#loadNow(path, restart, signal).finally(() => {
      if (this.#pending.get(path) === operation) this.#pending.delete(path);
    });
    this.#pending.set(path, operation);
    return operation;
  }

  async #loadNow(
    path: string,
    restart: boolean,
    signal?: AbortSignal,
  ): Promise<FilesFolderSnapshot<Cursor>> {
    throwIfAborted(signal);
    const previous = restart ? emptySnapshot<Cursor>(path) : this.snapshot(path);
    const loading = Object.freeze({ ...previous, loading: true, error: null });
    this.#folders.set(path, loading);
    try {
      const page = await this.port.page({
        path,
        expectedFolderRevision:
          restart ? null : previous.folderRevision,
        cursor: restart ? null : previous.cursor,
        limit: FILES_FOLDER_PAGE_LIMIT,
        ...(signal ? { signal } : {}),
      });
      validatePage(path, page);
      if (
        !restart &&
        previous.folderRevision !== null &&
        page.folderRevision !== previous.folderRevision
      ) {
        // Backend cursors are revision-bound. Restart once, retaining the
        // caller's selection/scroll outside this data model.
        this.#folders.delete(path);
        return this.#loadNow(path, true, signal);
      }
      // Blind-tag pagination has no plaintext-name ordering guarantee. Sort
      // this decrypted page only, then append it intact so the accumulated
      // rows are never presented as globally alphabetical.
      const localPage = sortEntries([...page.entries]);
      const merged = restart
        ? localPage
        : mergeEntries(previous.entries, localPage);
      const next = Object.freeze({
        path,
        folderRevision: page.folderRevision,
        entries: Object.freeze(merged),
        loaded: merged.length,
        total: page.total,
        cursor: page.cursor,
        hasMore: page.hasMore,
        loading: false,
        error: null,
      });
      this.#folders.set(path, next);
      return next;
    } catch (error) {
      const failed = Object.freeze({
        ...previous,
        loading: false,
        error: error instanceof Error ? error.message : "Folder load failed",
      });
      this.#folders.set(path, failed);
      throw error;
    }
  }
}

function validatePage<Cursor>(
  path: string,
  page: FilesFolderBackendPage<Cursor>,
): void {
  if (
    page.path !== path ||
    !Number.isSafeInteger(page.total) ||
    page.total < 0 ||
    page.entries.length > FILES_FOLDER_PAGE_LIMIT ||
    page.entries.length > page.total ||
    page.hasMore !== (page.cursor !== null) ||
    (!page.hasMore && page.entries.length > page.total)
  ) {
    throw new Error("Files folder page is inconsistent");
  }
  const names = new Set<string>();
  for (const entry of page.entries) {
    if (
      normalizeFilesPath(entry.path).path !== entry.path ||
      !entry.path.startsWith(path === "/" ? "/" : `${path}/`) ||
      entry.name.includes("/") ||
      names.has(entry.name)
    ) {
      throw new Error("Files folder page contains an invalid child");
    }
    names.add(entry.name);
  }
}

function mergeEntries(
  before: readonly FilesFolderEntry[],
  additions: readonly FilesFolderEntry[],
): FilesFolderEntry[] {
  const byPath = new Map(before.map((entry) => [entry.path, entry]));
  for (const entry of additions) {
    if (byPath.has(entry.path)) {
      throw new Error("Files folder page repeated an existing child");
    }
    byPath.set(entry.path, entry);
  }
  return [...byPath.values()];
}

function sortEntries(entries: FilesFolderEntry[]): FilesFolderEntry[] {
  return entries.sort(
    (left, right) =>
      (left.kind === right.kind ? 0 : left.kind === "folder" ? -1 : 1) ||
      compareCanonicalUnicode(left.name, right.name) ||
      compareCanonicalUnicode(left.path, right.path),
  );
}

function compareCanonicalUnicode(left: string, right: string): number {
  const leftScalars = Array.from(left.normalize("NFC"));
  const rightScalars = Array.from(right.normalize("NFC"));
  const length = Math.min(leftScalars.length, rightScalars.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftScalars[index]!.codePointAt(0)!;
    const rightPoint = rightScalars[index]!.codePointAt(0)!;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
  }
  return leftScalars.length < rightScalars.length
    ? -1
    : leftScalars.length > rightScalars.length
      ? 1
      : 0;
}

function subsequence(needle: string, haystack: string): boolean {
  let cursor = 0;
  for (const scalar of haystack) {
    if (scalar === needle[cursor]) cursor += 1;
    if (cursor === needle.length) return true;
  }
  return false;
}

function emptySnapshot<Cursor>(path: string): FilesFolderSnapshot<Cursor> {
  return Object.freeze({
    path,
    folderRevision: null,
    entries: Object.freeze([]),
    loaded: 0,
    total: 0,
    cursor: null,
    hasMore: true,
    loading: false,
    error: null,
  });
}

function bounded(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Files operation was cancelled", "AbortError");
}
