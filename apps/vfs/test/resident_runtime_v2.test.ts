import { expect, test } from "bun:test";
import {
  FilesAuthorityManager,
  FilesBlobUrlRegistry,
  FilesFolderPager,
  FilesResidentEnvironmentError,
  FilesUpdateUncertainError,
  assertFilesPersistentEnvironment,
  parseFilesResidentBinding,
  runFilesAmbiguousUpdate,
  type FilesAuthorityResetReason,
  type FilesFolderBackendPage,
  type FilesFolderEntry,
} from "../src/resident/index.ts";
import { parseCanonicalNat64 } from "../src/protocol/index.ts";

const ONE = parseCanonicalNat64("1");
const TWO = parseCanonicalNat64("2");

test("resident requires persistent mode and a complete authority binding", () => {
  expect(() => assertFilesPersistentEnvironment({ credentialless: true }))
    .toThrow(FilesResidentEnvironmentError);
  assertFilesPersistentEnvironment({ credentialless: false });
  const binding = parseFilesResidentBinding(
    "https://files.invalid/service.html?" +
      new URLSearchParams({
        "installation-uid": "7",
        "resident-frame-security": "persistent_dedicated_v1",
        "browser-origin-nonce": "cd".repeat(16),
        "browser-origin-authority-epoch": "3",
      }),
    "aaaaa-aa",
  );
  expect(binding).toMatchObject({
    installationUid: "7",
    browserOriginAuthorityEpoch: "3",
    authorizedPrincipal: "aaaaa-aa",
  });
  expect(() =>
    parseFilesResidentBinding(
      "https://files.invalid/service.html?installation-uid=7",
    ),
  ).toThrow("missing");
  expect(() =>
    parseFilesResidentBinding(
      "https://files.invalid/service.html?" +
        new URLSearchParams({
          installation_uid: "7",
          resident_frame_security: "persistent_dedicated_v1",
          browser_origin_nonce: "cd".repeat(16),
          browser_origin_authority_epoch: "3",
        }),
    ),
  ).toThrow("missing installation-uid");
});

test("authority changes synchronously purge volatile state while an idle lock retains dirty text", () => {
  const calls: string[] = [];
  const reset = {
    clearMetadata: () => calls.push("metadata"),
    clearContinuations: () => calls.push("continuations"),
    cancelTransfers: (reason: FilesAuthorityResetReason) =>
      calls.push(`transfers:${reason}`),
    revokeBlobUrls: () => calls.push("blobs"),
    dropDirtyBuffers: (reason: FilesAuthorityResetReason) =>
      calls.push(`dirty:${reason}`),
    lockWorker: (reason: FilesAuthorityResetReason) => {
      calls.push(`worker:${reason}`);
    },
  };
  const manager = new FilesAuthorityManager(reset);
  const first = parseFilesResidentBinding(
    bindingUrl({ "installation-uid": "7" }),
  );
  expect(manager.adopt(first)).toBe("initial_binding");
  calls.length = 0;
  manager.relock("lock_epoch_changed");
  expect(calls).toEqual([
    "metadata",
    "continuations",
    "transfers:lock_epoch_changed",
    "blobs",
    "worker:lock_epoch_changed",
  ]);
  calls.length = 0;
  manager.relock("worker_failure");
  expect(calls).toEqual([
    "metadata",
    "continuations",
    "transfers:worker_failure",
    "blobs",
    "dirty:worker_failure",
    "worker:worker_failure",
  ]);
  calls.length = 0;
  const second = parseFilesResidentBinding(
    bindingUrl({ "installation-uid": "8" }),
  );
  expect(manager.adopt(second)).toBe("installation_changed");
  expect(calls).toContain("dirty:installation_changed");
  expect(String(manager.lockEpoch)).toBe("4");
});

test("Blob URLs support immediate preview cleanup and delayed handoff cleanup", () => {
  const revoked: string[] = [];
  let next = 0;
  const registry = new FilesBlobUrlRegistry(
    {
      createObjectURL: () => `blob:files-${++next}`,
      revokeObjectURL: (url) => revoked.push(url),
    },
    1_000,
  );
  const first = registry.create(new Blob(["one"]));
  const second = registry.create(new Blob(["two"]));
  registry.releaseAfterHandoff(first);
  expect(registry.size).toBe(2);
  expect(registry.revoke(second)).toBe(true);
  expect(registry.revoke(second)).toBe(false);
  expect(revoked).toEqual([second]);
  registry.revokeAll();
  expect(revoked).toEqual([second, first]);
  expect(registry.size).toBe(0);
});

test("folder pager loads bounded pages, sorts folders first, and restarts a stale revision", async () => {
  const calls: Array<{ cursor: number | null; expected: string | null }> = [];
  let staleOnce = true;
  const pager = new FilesFolderPager<number>({
    async page(input): Promise<FilesFolderBackendPage<number>> {
      calls.push({
        cursor: input.cursor,
        expected: input.expectedFolderRevision,
      });
      if (input.cursor === null) {
        return {
          path: "/",
          folderRevision: staleOnce ? ONE : TWO,
          entries: [entry("/z.txt", "z.txt", "file")],
          total: 2,
          cursor: 1,
          hasMore: true,
        };
      }
      staleOnce = false;
      return {
        path: "/",
        folderRevision: TWO,
        entries: [entry("/docs", "docs", "folder")],
        total: 2,
        cursor: null,
        hasMore: false,
      };
    },
    async exact() {
      return null;
    },
  });
  let snapshot = await pager.loadFirst("/");
  expect(snapshot).toMatchObject({ loaded: 1, total: 2, hasMore: true });
  snapshot = await pager.loadMore("/");
  // The second page changed revision, so the pager discarded it and made one
  // bounded restart rather than mixing two folder revisions.
  expect(snapshot.folderRevision).toBe(TWO);
  expect(snapshot.entries.map((item) => item.name)).toEqual(["z.txt"]);
  expect(calls).toEqual([
    { cursor: null, expected: null },
    { cursor: 1, expected: "1" },
    { cursor: null, expected: null },
  ]);
});

test("folder pager sorts each decrypted page locally and never re-sorts accumulated pages", async () => {
  const calls: Array<{ cursor: number | null; expected: string | null }> = [];
  const pager = new FilesFolderPager<number>({
    async page(input): Promise<FilesFolderBackendPage<number>> {
      calls.push({
        cursor: input.cursor,
        expected: input.expectedFolderRevision,
      });
      if (input.cursor === null) {
        return {
          path: "/",
          folderRevision: ONE,
          entries: [
            entry("/z-file.txt", "z-file.txt", "file"),
            entry("/z-folder", "z-folder", "folder"),
          ],
          total: 4,
          cursor: 1,
          hasMore: true,
        };
      }
      return {
        path: "/",
        folderRevision: ONE,
        // Blind-tag order can put alphabetically earlier plaintext names on
        // a later page.
        entries: [
          entry("/a-file.txt", "a-file.txt", "file"),
          entry("/a-folder", "a-folder", "folder"),
        ],
        total: 4,
        cursor: null,
        hasMore: false,
      };
    },
    async exact() {
      return null;
    },
  });

  const first = await pager.loadFirst("/");
  expect(first.entries.map((item) => item.name)).toEqual([
    "z-folder",
    "z-file.txt",
  ]);
  expect(first).toMatchObject({
    loaded: 2,
    total: 4,
    cursor: 1,
    hasMore: true,
  });

  const complete = await pager.loadMore("/");
  expect(complete.entries.map((item) => item.name)).toEqual([
    "z-folder",
    "z-file.txt",
    "a-folder",
    "a-file.txt",
  ]);
  expect(complete).toMatchObject({
    loaded: 4,
    total: 4,
    cursor: null,
    hasMore: false,
  });
  expect(calls).toEqual([
    { cursor: null, expected: null },
    { cursor: 1, expected: ONE },
  ]);
});

test("ambiguous updates reconcile before retry and known failures pass through", async () => {
  let dispatches = 0;
  let reconciles = 0;
  const result = await runFilesAmbiguousUpdate({
    async dispatch() {
      dispatches += 1;
      if (dispatches === 1) throw new TypeError("network disconnected");
      return "retried";
    },
    async reconcile() {
      reconciles += 1;
      return { kind: "active" };
    },
    isAmbiguous: (error) => error instanceof TypeError,
    wait: async () => {},
  });
  expect(result).toBe("retried");
  expect({ dispatches, reconciles }).toEqual({ dispatches: 2, reconciles: 1 });

  await expect(
    runFilesAmbiguousUpdate({
      dispatch: async () => {
        throw new TypeError("lost");
      },
      reconcile: async () => ({ kind: "unknown" }),
      isAmbiguous: () => true,
    }),
  ).rejects.toBeInstanceOf(FilesUpdateUncertainError);

  const rejected = new Error("quota");
  await expect(
    runFilesAmbiguousUpdate({
      dispatch: async () => {
        throw rejected;
      },
      reconcile: async () => {
        throw new Error("must not reconcile");
      },
      isAmbiguous: () => false,
    }),
  ).rejects.toBe(rejected);
});

function bindingUrl(
  overrides: Partial<Record<string, string>> = {},
): string {
  return `https://files.invalid/service.html?${new URLSearchParams({
    "installation-uid": "7",
    "resident-frame-security": "persistent_dedicated_v1",
    "browser-origin-nonce": "cd".repeat(16),
    "browser-origin-authority-epoch": "3",
    ...overrides,
  })}`;
}

function entry(
  path: string,
  name: string,
  kind: "file" | "folder",
): FilesFolderEntry {
  return {
    path,
    name,
    kind,
    size: kind === "file" ? 1 : null,
    mediaType: kind === "file" ? "text/plain" : null,
    contentKind: kind === "file" ? "text" : null,
    etag: null,
    modifiedAtNs: ONE,
    structuralRevision: ONE,
    contentId: null,
  };
}
