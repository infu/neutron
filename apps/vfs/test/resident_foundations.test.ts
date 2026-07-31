import { expect, test } from "bun:test";
import {
  FilesContinuationError,
  FilesContinuationRegistry,
  FilesMetadataLru,
  FilesPathError,
  FilesPathResolver,
  INITIAL_FILES_TRANSFER_STATE,
  INITIAL_FILES_VAULT_STATE,
  MapFilesPathCache,
  normalizeFilesPath,
  reduceFilesTransferState,
  reduceFilesVaultState,
  validateFilesName,
  type FilesContinuationBinding,
  type FilesResolvedNode,
} from "../src/resident/index.ts";
import {
  parseCanonicalNat64,
  parseFilesId128,
} from "../src/protocol/index.ts";

const ROOT = parseFilesId128({ hi: "0", lo: "0" });
const FOLDER = parseFilesId128({ hi: "1", lo: "1" });
const FILE = parseFilesId128({ hi: "2", lo: "2" });
const ONE = parseCanonicalNat64("1");
const TWO = parseCanonicalNat64("2");

function binding(
  overrides: Partial<FilesContinuationBinding> = {},
): FilesContinuationBinding {
  return {
    callerEndpoint: "app:agent:background",
    callerSession: "session-1",
    installationGeneration: ONE,
    lockEpoch: TWO,
    folderRevision: ONE,
    ...overrides,
  };
}

test("continuation handles are opaque, scope-bound, bounded, and expiring", () => {
  let now = 1_000;
  let seed = 0;
  const registry = new FilesContinuationRegistry<{ backendCursor: string }>({
    maxEntries: 2,
    maxTtlMs: 5_000,
    now: () => now,
    randomBytes(length) {
      seed += 1;
      return new Uint8Array(length).fill(seed);
    },
  });
  const token = registry.issue(
    binding(),
    { backendCursor: "parent-id:secret-tag" },
    1_000,
  );
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  expect(token).not.toContain("secret");
  expect(registry.redeem(token, binding())).toEqual({
    backendCursor: "parent-id:secret-tag",
  });
  expect(() =>
    registry.redeem(
      token,
      binding({ callerSession: "another-session" }),
    ),
  ).toThrow(FilesContinuationError);
  now = 2_000;
  expect(() => registry.redeem(token, binding())).toThrow("expired");
  expect(registry.size).toBe(0);
});

test("metadata LRU enforces entry and byte caps and evicts oldest plaintext", () => {
  const evicted: string[] = [];
  const lru = new FilesMetadataLru<string, { name: string }>({
    maxEntries: 2,
    maxBytes: 5,
    onEvict: (key) => evicted.push(key),
  });
  lru.set("a", { name: "a" }, 2);
  lru.set("b", { name: "b" }, 2);
  expect(lru.get("a")).toEqual({ name: "a" });
  expect(lru.set("c", { name: "c" }, 2)).toEqual(["b"]);
  expect(lru.has("a")).toBe(true);
  expect(lru.has("b")).toBe(false);
  expect(lru.stats()).toMatchObject({ entries: 2, bytes: 4 });
  expect(evicted).toEqual(["b"]);
  expect(() => lru.set("large", { name: "large" }, 6)).toThrow(
    "exceeds the complete LRU",
  );
});

test("path normalization follows root aliases, NFC, scalar, and whitespace rules", () => {
  expect(normalizeFilesPath("  //notes/./e\u0301.txt  ")).toEqual({
    path: "/notes/é.txt",
    segments: ["notes", "é.txt"],
    scalarLength: 12,
  });
  expect(normalizeFilesPath("///").path).toBe("/");
  expect(validateFilesName("🧪.txt")).toBe("🧪.txt");
  expect(() => normalizeFilesPath("/notes/../secret")).toThrow(
    "Parent path segments",
  );
  expect(() => validateFilesName(" trailing ")).toThrow(FilesPathError);
  expect(() => validateFilesName("\ud800")).toThrow("invalid Unicode");
});

test("path resolver performs one blind lookup per segment and checks bindings", async () => {
  const rootNode = node(ROOT, ROOT, "", "folder");
  const folderNode = node(FOLDER, ROOT, "docs", "folder");
  const fileNode = node(FILE, FOLDER, "readme.txt", "file");
  const requested: string[] = [];
  const resolver = new FilesPathResolver(
    {
      async nameTag(_parent, name) {
        requested.push(name);
        return new Uint8Array(32).fill(name.length).buffer;
      },
    },
    {
      async root() {
        return rootNode;
      },
      async child(parent, tag) {
        const marker = new Uint8Array(tag)[0];
        if (parent.hi === "0" && marker === 4) return folderNode;
        if (parent.hi === "1" && marker === 10) return fileNode;
        return null;
      },
    },
    new MapFilesPathCache(),
  );
  const result = await resolver.resolve("/docs/readme.txt");
  expect(result.node.nodeId).toEqual(FILE);
  expect(requested).toEqual(["docs", "readme.txt"]);
  await resolver.resolve("/docs/readme.txt");
  expect(requested).toEqual(["docs", "readme.txt"]);
});

test("vault reducer emits at most one prompt per lock epoch and ignores stale completion", () => {
  let state = reduceFilesVaultState(INITIAL_FILES_VAULT_STATE, {
    type: "bootstrap_locked",
    lockEpoch: ONE,
  });
  state = reduceFilesVaultState(state, {
    type: "unlock_prompted",
    lockEpoch: ONE,
  });
  const prompted = state;
  state = reduceFilesVaultState(state, {
    type: "unlock_prompted",
    lockEpoch: ONE,
  });
  expect(state).toBe(prompted);
  state = reduceFilesVaultState(state, {
    type: "unlock_started",
    lockEpoch: ONE,
  });
  expect(state.status).toBe("unlocking");
  const stale = reduceFilesVaultState(state, {
    type: "unlock_succeeded",
    lockEpoch: TWO,
    generation: ONE,
    rotationRequired: false,
  });
  expect(stale).toBe(state);
  state = reduceFilesVaultState(state, {
    type: "unlock_succeeded",
    lockEpoch: ONE,
    generation: ONE,
    rotationRequired: true,
  });
  expect(state).toMatchObject({ status: "ready", rotationRequired: true });
});

test("transfer reducer enforces explicit lifecycle transitions", () => {
  let transfers = reduceFilesTransferState(INITIAL_FILES_TRANSFER_STATE, {
    type: "enqueue",
    item: {
      id: "upload-1",
      authorityEpoch: "install-1",
      kind: "os-upload",
      label: "photo.bin",
      phase: "queued",
      completedBytes: 0,
      totalBytes: 100,
      error: null,
    },
  });
  transfers = reduceFilesTransferState(transfers, {
    type: "transition",
    id: "upload-1",
    phase: "hashing",
  });
  transfers = reduceFilesTransferState(transfers, {
    type: "progress",
    id: "upload-1",
    completedBytes: 50,
  });
  expect(transfers.items.get("upload-1")).toMatchObject({
    phase: "hashing",
    completedBytes: 50,
  });
  const invalid = reduceFilesTransferState(transfers, {
    type: "transition",
    id: "upload-1",
    phase: "committed",
  });
  expect(invalid).toBe(transfers);
});

function node(
  nodeId: ReturnType<typeof parseFilesId128>,
  parentId: ReturnType<typeof parseFilesId128>,
  canonicalName: string,
  kind: "file" | "folder",
): FilesResolvedNode {
  return {
    nodeId,
    parentId,
    canonicalName,
    kind,
    structuralRevision: ONE,
    metadataRevision: ONE,
    childrenRevision: ONE,
  };
}
