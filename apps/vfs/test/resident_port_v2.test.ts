import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { readFile } from "node:fs/promises";
import type { FilesCryptoWorkerClient } from "../src/crypto/worker_client.ts";
import type {
  FilesCryptoWorkerRequestWithoutId,
  FilesCryptoWorkerResult,
} from "../src/crypto/worker_protocol.ts";
import type {
  CanonicalNat64,
  FilesAttachmentOutcomeV2,
  FilesBootstrapOkV2,
  FilesId128V2,
  FilesOperationSummaryV2,
} from "../src/protocol/types.ts";
import { FILES_V2_LIMITS } from "../src/protocol/constants.ts";
import { filesId128ToKey } from "../src/protocol/ids.ts";
import type { FilesResidentFilePort } from "../src/resident/service_contract.ts";
import {
  DefaultFilesResidentPort,
  createDefaultFilesResidentPort,
} from "../src/vault/resident_port.ts";
import {
  FilesTransferEngine,
  FilesTransferEngineFault,
} from "../src/vault/transfer_engine.ts";
import type {
  FilesBackendPort,
  FilesCapacitySnapshot,
  FilesCryptoPort,
  FilesFileMetadata,
  FilesListPage,
  FilesNodeRecord,
  FilesPrivateWritePlan,
  FilesReadRequest,
  FilesTransferControls,
  FilesTransferSource,
  FilesVaultRecord,
  FilesVaultStatus,
  FilesVetKeysPort,
  FilesWriteItem,
  FilesWriteReceipt,
} from "../src/vault/types.ts";
import {
  FilesVaultEngine,
  FilesVaultEngineFault,
  type FilesVaultBootstrapOptions,
} from "../src/vault/vault_engine.ts";

const ZERO = nat(0);
const ROOT_ID = id(0);
const REQUIRED_PORT_METHODS = Object.freeze([
  "status",
  "initialize",
  "unlock",
  "lock",
  "rotate",
  "list",
  "stat",
  "read",
  "write",
  "writeMany",
  "mkdir",
  "move",
  "remove",
  "cancel",
  "retry",
  "beginUpload",
  "uploadChunk",
  "clearVolatile",
] as const satisfies readonly (keyof FilesResidentFilePort)[]);

type FakeVaultState = "uninitialized" | "locked" | "ready";

type Harness = {
  present: boolean;
  vaultState: FakeVaultState;
  backendCalls: string[];
  cryptoCreated: number;
  cryptos: FakeCrypto[];
  records: Map<string, FilesNodeRecord>;
  content: Map<string, Uint8Array>;
  vaults: Set<FilesVaultEngine>;
  lockListeners: Map<FilesVaultEngine, Set<() => void>>;
  sourceSlices: { start: number; end: number }[];
  failCryptoCreations: number;
  lastPlan: FilesPrivateWritePlan | null;
  plans: FilesPrivateWritePlan[];
  activeOperations: FilesOperationSummaryV2[];
  aborts: {
    requestId: FilesId128V2;
    stageId: CanonicalNat64;
    stageKind: "private_write";
  }[];
  readGate: Promise<void> | null;
  readStarted: number;
  readSignal: AbortSignal | null;
  writeGate: Promise<void> | null;
  writeCommitGate: Promise<void> | null;
  writeCommitReady: number;
  writeSignal: AbortSignal | null;
  writeCommitWins: boolean;
  writeExecutions: number;
  writeFailure: Error | null;
  writeFailures: Error[];
  refreshCalls: number;
  refreshFailure: Error | null;
  lookupPathCalls: number;
  lookupPathGate: Promise<void> | null;
  lookupChildCalls: number;
  lookupNodeCalls: number;
};

let activeHarness: Harness | null = null;
const vaultOwners = new WeakMap<FilesVaultEngine, Harness>();

const originalVaultMethods = {
  status: FilesVaultEngine.prototype.status,
  onLock: FilesVaultEngine.prototype.onLock,
  dispose: FilesVaultEngine.prototype.dispose,
  bootstrap: FilesVaultEngine.prototype.bootstrap,
  unlock: FilesVaultEngine.prototype.unlock,
  lock: FilesVaultEngine.prototype.lock,
  refreshCommittedView: FilesVaultEngine.prototype.refreshCommittedView,
  lookupPath: FilesVaultEngine.prototype.lookupPath,
  lookupChild: FilesVaultEngine.prototype.lookupChild,
  lookupNode: FilesVaultEngine.prototype.lookupNode,
  listFolder: FilesVaultEngine.prototype.listFolder,
};

const originalTransferMethods = {
  writePrivatePrehashed:
    FilesTransferEngine.prototype.writePrivatePrehashed,
  readPrivate: FilesTransferEngine.prototype.readPrivate,
};

describe("Files V2 concrete resident port", () => {
  beforeAll(() => {
    installVaultTestSeams();
  });

  afterAll(() => {
    Object.assign(FilesVaultEngine.prototype, originalVaultMethods);
    Object.assign(FilesTransferEngine.prototype, originalTransferMethods);
    activeHarness = null;
  });

  beforeEach(() => {
    activeHarness = makeHarness();
  });

  test("factory is inert and exposes the complete required resident surface", () => {
    const injected = active();
    const port = makePort(injected);
    expect(injected.cryptoCreated).toBe(0);
    expect(injected.backendCalls).toEqual([]);
    for (const method of REQUIRED_PORT_METHODS) {
      expect(typeof port[method]).toBe("function");
    }
    expect(typeof port.onLock).toBe("function");

    const production = createDefaultFilesResidentPort();
    for (const method of REQUIRED_PORT_METHODS) {
      expect(typeof production[method]).toBe("function");
    }
    expect(injected.cryptoCreated).toBe(0);
    expect(injected.backendCalls).toEqual([]);
  });

  test("status stays worker-free and initialize, inactivity, unlock, and explicit lock advance volatile generations", async () => {
    const harness = active();
    const port = makePort(harness);
    const reasons: (string | undefined)[] = [];
    const statusReasons: string[] = [];
    const unsubscribe = port.onLock?.((reason) => reasons.push(reason));
    const unsubscribeStatus = port.onStatusChange?.((reason) =>
      statusReasons.push(reason)
    );

    const absent = await port.status();
    expect(absent.vault).toBe("uninitialized");
    expect(absent.lockEpoch).toBe(nat(0));
    expect(harness.cryptoCreated).toBe(0);

    const initialized = await port.initialize();
    expect(initialized.vault).toBe("ready");
    expect(initialized.currentGeneration).toBe(nat(1));
    expect(harness.cryptoCreated).toBe(1);
    expect(harness.cryptos[0]?.closed).toBe(false);

    triggerInactivity(harness);
    await drainMicrotasks();
    expect(reasons).toEqual(["inactivity"]);
    expect(statusReasons).toEqual(["inactivity"]);
    expect(harness.cryptos[0]?.closed).toBe(true);
    const inactive = await port.status();
    expect(inactive.vault).toBe("locked");
    expect(inactive.lockEpoch).toBe(nat(1));

    const unlocked = await port.unlock();
    expect(unlocked.vault).toBe("ready");
    expect(harness.cryptoCreated).toBe(2);
    const locked = await port.lock();
    expect(locked.vault).toBe("locked");
    expect(locked.lockEpoch).toBe(nat(2));
    expect(harness.cryptos[1]?.closed).toBe(true);
    expect(reasons).toEqual(["inactivity"]);
    unsubscribe?.();
    unsubscribeStatus?.();
  });

  test("worker failure emits one lock and status transition and authority cleanup does not duplicate it", async () => {
    const harness = active();
    const port = makePort(harness);
    const lockReasons: (string | undefined)[] = [];
    const statusReasons: string[] = [];
    port.onLock?.((reason) => lockReasons.push(reason));
    port.onStatusChange?.((reason) => statusReasons.push(reason));
    await port.initialize();
    harness.cryptos[0]!.closed = true;

    triggerInactivity(harness);
    await drainMicrotasks();
    expect(lockReasons).toEqual(["worker_failure"]);
    expect(statusReasons).toEqual(["worker_failure"]);
    expect((await port.status()).lockEpoch).toBe(nat(1));

    port.clearVolatile("worker_failure");
    expect(lockReasons).toEqual(["worker_failure"]);
    expect(statusReasons).toEqual(["worker_failure"]);
    expect((await port.status()).lockEpoch).toBe(nat(1));
  });

  test("maps authenticated folder pages, stat records, and binary reads into service values", async () => {
    const harness = active();
    seedNavigation(harness);
    harness.present = true;
    harness.vaultState = "locked";
    const port = makePort(harness);
    await port.unlock();

    const page = await port.list({
      path: "/",
      cursor: null,
      expectedFolderRevision: nat(1),
      limit: 1,
      recursive: false,
    });
    expect(page.path).toBe("/");
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({
      path: "/blob.bin",
      name: "blob.bin",
      type: "file",
      opaqueNodeIdentity: filesId128ToKey(id(4)),
      contentKind: "binary",
      byteLength: 4,
      mediaType: "application/octet-stream",
    });
    expect(page.hasMore).toBe(true);
    expect(page.cursor?.mode).toBe("direct");

    const second = await port.list({
      path: "/",
      cursor: page.cursor,
      expectedFolderRevision: page.folderRevision,
      limit: 2,
      recursive: false,
    });
    expect(second.entries.map((entry) => entry.path)).toEqual(["/docs"]);
    expect(second.hasMore).toBe(false);

    const stat = await port.stat("/docs/note.txt");
    expect(stat).toMatchObject({
      path: "/docs/note.txt",
      name: "note.txt",
      type: "file",
      opaqueNodeIdentity: filesId128ToKey(id(2)),
      contentKind: "text",
      byteLength: 5,
      mediaType: "text/plain",
    });
    expect(stat.etagSha256).toBe(
      hex(sha256(new TextEncoder().encode("hello"))),
    );

    const binary = await port.read("/blob.bin");
    expect(binary.entry.etagSha256).toBe(
      hex(sha256(Uint8Array.of(0, 1, 2, 255))),
    );
    expect([...binary.bytes]).toEqual([0, 1, 2, 255]);

    await expect(
      port.list({
        path: "/",
        cursor: null,
        expectedFolderRevision: nat(99),
        limit: 1,
        recursive: false,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const recursive = await port.list({
      path: "/",
      cursor: null,
      expectedFolderRevision: nat(1),
      limit: 10,
      recursive: true,
    });
    expect(recursive.entries.map((entry) => entry.path)).toEqual([
      "/blob.bin",
      "/docs",
      "/docs/note.txt",
    ]);
    expect(recursive.hasMore).toBe(false);
    expect(harness.lookupNodeCalls).toBe(0);
    await expect(port.list({
      path: "/",
      cursor: page.cursor,
      expectedFolderRevision: nat(1),
      limit: 1,
      recursive: true,
    })).rejects.toMatchObject({ code: "invalid" });
  });

  test("direct pages are sorted locally by folder and deterministic decrypted name without changing paging", async () => {
    const harness = active();
    harness.present = true;
    harness.vaultState = "locked";
    const rootChildren = [
      { name: "a-file.txt", kind: "file" as const, value: 20 },
      { name: "b-file.txt", kind: "file" as const, value: 21 },
      { name: "c-folder", kind: "folder" as const, value: 22 },
      { name: "d-folder", kind: "folder" as const, value: 23 },
      { name: "e-file.txt", kind: "file" as const, value: 24 },
      { name: "f-folder", kind: "folder" as const, value: 25 },
    ];
    for (const child of rootChildren) {
      const path = `/${child.name}`;
      if (child.kind === "folder") {
        harness.records.set(path, folderRecord({
          nodeId: id(child.value),
          parentId: ROOT_ID,
          name: child.name,
          structuralRevision: nat(1),
          childrenRevision: nat(1),
        }));
      } else {
        harness.records.set(path, fileRecord({
          nodeId: id(child.value),
          parentId: ROOT_ID,
          contentId: id(child.value + 100),
          name: child.name,
          contentKind: "binary_v1",
          mediaType: "application/octet-stream",
          bytes: Uint8Array.of(child.value),
        }));
      }
    }
    const port = makePort(harness);
    await port.unlock();

    const first = await port.list({
      path: "/",
      cursor: null,
      expectedFolderRevision: nat(1),
      limit: 3,
      recursive: false,
    });
    expect(first.entries.map((entry) => entry.name)).toEqual([
      "c-folder",
      "a-file.txt",
      "b-file.txt",
    ]);
    expect(first).toMatchObject({
      total: 6,
      hasMore: true,
      folderRevision: nat(1),
    });
    expect(first.cursor?.mode).toBe("direct");

    const second = await port.list({
      path: "/",
      cursor: first.cursor,
      expectedFolderRevision: first.folderRevision,
      limit: 3,
      recursive: false,
    });
    expect(second.entries.map((entry) => entry.name)).toEqual([
      "d-folder",
      "f-folder",
      "e-file.txt",
    ]);
    expect(second).toMatchObject({
      total: 6,
      hasMore: false,
      cursor: null,
      folderRevision: nat(1),
    });
    // Appending the two pages keeps backend cursor order between pages; a
    // global folder-first sort would have moved d-folder and f-folder above
    // the first page's files.
    expect([...first.entries, ...second.entries].map((entry) => entry.name))
      .toEqual([
        "c-folder",
        "a-file.txt",
        "b-file.txt",
        "d-folder",
        "f-folder",
        "e-file.txt",
      ]);
  });

  test("Vault remove rejects a same-revision replacement by opaque node identity", async () => {
    const harness = active();
    seedNavigation(harness);
    harness.present = true;
    harness.vaultState = "locked";
    const port = makePort(harness);
    await port.unlock();
    const inspected = await port.stat("/docs");
    if (inspected.opaqueNodeIdentity === undefined) {
      throw new Error("Vault stat omitted its resident node identity");
    }
    const inspectedNodeIdentity = inspected.opaqueNodeIdentity;
    const replacement = folderRecord({
      nodeId: id(99),
      parentId: ROOT_ID,
      name: "docs",
      structuralRevision: inspected.structuralRevision,
      childrenRevision: nat(2),
    });
    harness.records.set("/docs", replacement);

    await expect(
      port.remove("/docs", false, undefined, {
        nodeId: null,
        opaqueNodeIdentity: inspectedNodeIdentity,
        structuralRevision: inspected.structuralRevision,
        etagSha256: null,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(harness.records.get("/docs")?.node.nodeId).toEqual(id(99));
    expect(harness.backendCalls).not.toContain("remove");
  });

  test("list/stat read authority is fenced after every awaited private lookup", async () => {
    const harness = active();
    harness.present = true;
    harness.vaultState = "locked";
    harness.records.set("/fenced.txt", fileRecord({
      nodeId: id(48),
      parentId: ROOT_ID,
      contentId: id(49),
      name: "fenced.txt",
      contentKind: "text_v1",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("fenced"),
    }));
    const port = makePort(harness);
    await port.unlock();
    let release!: () => void;
    harness.lookupPathGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const pending = port.stat("/fenced.txt");
    await drainMicrotasks();
    port.clearVolatile("shutdown");
    release();

    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });

  test("ordinary writes hash the replayable source, consume its second pass sequentially, and return the committed mapping", async () => {
    const harness = active();
    harness.present = true;
    harness.vaultState = "locked";
    const port = makePort(harness);
    await port.unlock();
    const bytes = new TextEncoder().encode("write me");
    const sourceCalls: { start: number; end: number }[] = [];

    const result = await port.write({
      path: "/written.txt",
      source: {
        size: bytes.byteLength,
        slice(start, end) {
          sourceCalls.push({ start, end });
          return bytes.slice(start, end);
        },
      },
      contentKind: "text",
      mediaType: "text/plain",
      ifMatch: null,
      ifNoneMatch: true,
      createParents: false,
    });

    expect(result.cleanupPending).toBe(false);
    expect(result.entry).toMatchObject({
      path: "/written.txt",
      name: "written.txt",
      type: "file",
      opaqueNodeIdentity: filesId128ToKey(
        harness.records.get("/written.txt")!.node.nodeId,
      ),
      contentKind: "text",
      byteLength: bytes.byteLength,
      mediaType: "text/plain",
      etagSha256: hex(sha256(bytes)),
    });
    expect(sourceCalls[0]).toEqual({ start: 0, end: bytes.byteLength });
    expect(sourceCalls.slice(1)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
      { start: 4, end: 6 },
      { start: 6, end: 8 },
    ]);
    expect([...harness.content.get("/written.txt")!]).toEqual([...bytes]);
    expect(harness.lastPlan?.folderTransitions).toEqual([{
      nodeId: ROOT_ID,
      expectedStructuralRevision: nat(1),
      expectedChildrenRevision: nat(1),
    }]);
    expect(
      "proposedStructuralRevision" in
        (harness.lastPlan?.folderTransitions[0] ?? {}),
    ).toBe(false);
    expect(harness.refreshCalls).toBe(0);
  });

  test("a committed write returns its receipt-bound entry even when the deferred committed-view refresh will fail", async () => {
    const harness = active();
    harness.present = true;
    harness.vaultState = "locked";
    harness.refreshFailure = new Error("synthetic deferred refresh failure");
    const port = makePort(harness);
    await port.unlock();
    const bytes = new TextEncoder().encode("receipt authority");

    const result = await port.write({
      path: "/receipt.txt",
      source: {
        size: bytes.byteLength,
        slice: (start, end) => bytes.slice(start, end),
      },
      contentKind: "text",
      mediaType: "text/plain",
      ifMatch: null,
      ifNoneMatch: true,
      createParents: false,
    });

    expect(result.entry).toMatchObject({
      path: "/receipt.txt",
      etagSha256: hex(sha256(bytes)),
      contentId: expect.any(String),
    });
    expect(harness.refreshCalls).toBe(0);
    await expect(port.stat("/receipt.txt")).rejects.toThrow(
      "synthetic deferred refresh failure",
    );
    expect(harness.refreshCalls).toBe(1);
  });

  test("deterministic ID collisions retry a completely regenerated replayable plan at most three times", async () => {
    const harness = active();
    harness.present = true;
    harness.vaultState = "locked";
    harness.writeFailures.push(
      idCollision(),
      idCollision(),
    );
    const port = makePort(harness);
    await port.unlock();
    const bytes = new TextEncoder().encode("collision-safe");

    const result = await port.write({
      path: "/collision.txt",
      source: {
        size: bytes.byteLength,
        slice: (start, end) => bytes.slice(start, end),
      },
      contentKind: "text",
      mediaType: "text/plain",
      ifMatch: null,
      ifNoneMatch: true,
      createParents: false,
    });

    expect(result.entry.path).toBe("/collision.txt");
    expect(harness.writeExecutions).toBe(3);
    expect(new Set(harness.plans.map((plan) =>
      idKey(plan.items[0]!.transition.nodeId)
    )).size).toBe(3);
  });

  test("writeMany submits one atomic batch plan and returns every committed file", async () => {
    const harness = active();
    harness.present = true;
    harness.vaultState = "locked";
    const port = makePort(harness);
    await port.unlock();
    const results = await port.writeMany([
      {
        path: "/first.txt",
        text: "first",
        overwrite: false,
        createParents: false,
        mediaType: "text/plain",
      },
      {
        path: "/second.txt",
        text: "second",
        overwrite: false,
        createParents: false,
        mediaType: "text/plain",
      },
    ]);
    expect(harness.writeExecutions).toBe(1);
    expect(harness.lastPlan?.intent).toBe("batch");
    expect(harness.lastPlan?.items).toHaveLength(2);
    expect(results.map((result) => result.entry.path)).toEqual([
      "/first.txt",
      "/second.txt",
    ]);
  });

  test("writeMany enforces each caller item's createParents policy even when another item shares the missing prefix", async () => {
    const harness = active();
    harness.present = true;
    harness.vaultState = "locked";
    const port = makePort(harness);
    await port.unlock();

    await expect(port.writeMany([
      {
        path: "/shared/allowed.txt",
        text: "allowed",
        overwrite: false,
        createParents: true,
        mediaType: "text/plain",
      },
      {
        path: "/shared/strict.txt",
        text: "strict",
        overwrite: false,
        createParents: false,
        mediaType: "text/plain",
      },
    ])).rejects.toMatchObject({ code: "not_found" });
    expect(harness.writeExecutions).toBe(0);
    expect([...harness.records.keys()]).toEqual(["/"]);
  });

  test("atomic parent creation leaves no folders on failure and enforces the complete 64-entry plan bound", async () => {
    const harness = active();
    harness.present = true;
    harness.vaultState = "locked";
    harness.records.set("/existing", folderRecord({
      nodeId: id(100),
      parentId: ROOT_ID,
      name: "existing",
      structuralRevision: nat(1),
      childrenRevision: nat(1),
    }));
    const port = makePort(harness);
    await port.unlock();

    harness.writeFailure = new Error("synthetic atomic commit failure");
    const exactBoundary = atomicParentBatch(11);
    await expect(port.writeMany(exactBoundary)).rejects.toThrow(
      "synthetic atomic commit failure",
    );
    expect(harness.writeExecutions).toBe(1);
    expect(harness.lastPlan).not.toBeNull();
    expect(structuralEntryCount(harness.lastPlan!)).toBe(64);
    expect(harness.lastPlan?.items.filter(
      (item) => item.metadata.nodeKind === "folder",
    )).toHaveLength(11);
    expect(harness.lookupPathCalls).toBe(1);
    expect(harness.lookupChildCalls).toBe(21);
    expect([...harness.records.keys()].sort()).toEqual(["/", "/existing"]);
    expect(harness.content.size).toBe(0);

    harness.lastPlan = null;
    await expect(port.writeMany(atomicParentBatch(12))).rejects.toMatchObject({
      code: "limit",
    });
    expect(harness.writeExecutions).toBe(1);
    expect(harness.lastPlan).toBeNull();
    expect([...harness.records.keys()].sort()).toEqual(["/", "/existing"]);
    expect(harness.content.size).toBe(0);
  });

  test("a deep one-file write cannot under-declare its 64-entry physical peak", async () => {
    const harness = active();
    harness.present = true;
    harness.vaultState = "locked";
    let parentId = ROOT_ID;
    const segments: string[] = [];
    for (let depth = 1; depth <= 61; depth += 1) {
      const name = "a";
      segments.push(name);
      const nodeId = id(1_000 + depth);
      harness.records.set(
        `/${segments.join("/")}`,
        folderRecord({
          nodeId,
          parentId,
          name,
          structuralRevision: nat(depth + 1),
          childrenRevision: nat(depth + 1),
        }),
      );
      parentId = nodeId;
    }
    const port = makePort(harness);
    await port.unlock();
    const bytes = new TextEncoder().encode("deep");

    await port.write({
      path: `/${[...segments, "file.txt"].join("/")}`,
      source: {
        size: bytes.byteLength,
        slice: (start, end) => bytes.slice(start, end),
      },
      contentKind: "text",
      mediaType: "text/plain",
      ifMatch: null,
      ifNoneMatch: true,
      createParents: false,
    });

    expect(harness.lastPlan).not.toBeNull();
    expect(structuralEntryCount(harness.lastPlan!)).toBe(64);
    expect(harness.lastPlan?.items).toHaveLength(1);
    expect(harness.lastPlan?.quota.grossPeakPhysicalBytes).toBe(
      nat(134_217_728),
    );
  });

  test("OS upload performs strict hash/encrypt passes without whole-file buffering", async () => {
    const harness = active();
    harness.present = true;
    harness.vaultState = "locked";
    const port = makePort(harness);
    await port.unlock();
    const payload = Uint8Array.of(10, 20, 30, 40, 50);
    const upload = await port.beginUpload({
      transferId: "upload_five_1",
      path: "/",
      name: "five.bin",
      mediaType: "application/octet-stream",
      size: payload.byteLength,
      contentKind: "binary",
    });
    expect(upload.chunkBytes).toBeGreaterThan(0);

    const firstHash = await port.uploadChunk({
      transferId: upload.transferId,
      pass: "hash",
      ordinal: 0,
      final: false,
      totalBytes: payload.byteLength,
    }, buffer(payload.slice(0, 2)));
    expect(firstHash).toMatchObject({
      phase: "hashing",
      processedBytes: 2,
      committed: false,
      readyForUpload: false,
    });
    const finalHash = await port.uploadChunk({
      transferId: upload.transferId,
      pass: "hash",
      ordinal: 1,
      final: true,
      totalBytes: payload.byteLength,
    }, buffer(payload.slice(2)));
    expect(finalHash).toMatchObject({
      phase: "queued",
      processedBytes: 5,
      committed: false,
      readyForUpload: true,
    });

    const firstEncrypt = await port.uploadChunk({
      transferId: upload.transferId,
      pass: "encrypt",
      ordinal: 0,
      final: false,
      totalBytes: payload.byteLength,
    }, buffer(payload.slice(0, 3)));
    expect(firstEncrypt.committed).toBe(false);
    expect(firstEncrypt.processedBytes).toBe(5);
    const finalEncrypt = await port.uploadChunk({
      transferId: upload.transferId,
      pass: "encrypt",
      ordinal: 1,
      final: true,
      totalBytes: payload.byteLength,
    }, buffer(payload.slice(3)));
    expect(finalEncrypt).toMatchObject({
      phase: "committed",
      processedBytes: 5,
      committed: true,
      readyForUpload: false,
    });
    expect(finalEncrypt.entry).toMatchObject({
      path: "/five.bin",
      byteLength: 5,
      etagSha256: hex(sha256(payload)),
    });
    expect([...harness.content.get("/five.bin")!]).toEqual([...payload]);
    expect(harness.sourceSlices).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
      { start: 4, end: 5 },
    ]);
  });

  test("tile upload returns its final attachment before the resident commit", async () => {
    const harness = active();
    harness.present = true;
    harness.vaultState = "locked";
    let releaseWrite!: () => void;
    harness.writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let releaseCommit!: () => void;
    harness.writeCommitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const port = makePort(harness);
    await port.unlock();
    const chunkBytes = FILES_V2_LIMITS.normalPlaintextBlockBytes;
    const payload = new Uint8Array(chunkBytes + 1);
    payload.fill(7);
    const upload = await port.beginUpload({
      transferId: "upload_deferred_commit_1",
      path: "/",
      name: "deferred.bin",
      mediaType: "application/octet-stream",
      size: payload.byteLength,
      contentKind: "binary",
    });
    await port.uploadChunk({
      transferId: upload.transferId,
      pass: "hash",
      ordinal: 0,
      final: false,
      totalBytes: payload.byteLength,
    }, buffer(payload.slice(0, chunkBytes)));
    await port.uploadChunk({
      transferId: upload.transferId,
      pass: "hash",
      ordinal: 1,
      final: true,
      totalBytes: payload.byteLength,
    }, buffer(payload.slice(chunkBytes)));
    await port.uploadChunk({
      transferId: upload.transferId,
      pass: "encrypt",
      ordinal: 0,
      final: false,
      totalBytes: payload.byteLength,
    }, buffer(payload.slice(0, chunkBytes)), { deferFinalCommit: true });
    expect(harness.writeExecutions).toBe(0);
    const acceptedPromise = port.uploadChunk({
      transferId: upload.transferId,
      pass: "encrypt",
      ordinal: 1,
      final: true,
      totalBytes: payload.byteLength,
    }, buffer(payload.slice(chunkBytes)), { deferFinalCommit: true });
    let finalAttachmentReturned = false;
    void acceptedPromise.then(() => {
      finalAttachmentReturned = true;
    });
    await waitFor(() => finalAttachmentReturned);
    const accepted = await acceptedPromise;
    expect(accepted).toMatchObject({
      committed: false,
      processedBytes: payload.byteLength,
    });
    expect(harness.sourceSlices).toHaveLength(0);

    releaseWrite();
    await waitFor(() => harness.writeCommitReady === 1);
    const pending = (await port.status()).transfers.find(
      (transfer) => transfer.id === upload.transferId,
    );
    expect(pending).toBeDefined();
    expect(["encrypting", "uploading"]).toContain(pending!.phase);

    releaseCommit();
    await waitFor(async () =>
      (await port.status()).transfers.some(
        (transfer) =>
          transfer.id === upload.transferId &&
          transfer.phase === "committed",
      )
    );
    expect(harness.records.has("/deferred.bin")).toBe(true);
    await expect(port.beginUpload({
      transferId: "upload_after_deferred_1",
      path: "/",
      name: "after.bin",
      mediaType: "application/octet-stream",
      size: 0,
      contentKind: "binary",
    })).resolves.toBeDefined();
  });

  test("OS upload accepts one file up to the full private-storage quota and atomically synthesizes every missing parent under single-file semantics", async () => {
    const harness = active();
    harness.present = true;
    harness.vaultState = "locked";
    const port = makePort(harness);
    await port.unlock();
    const totalBytes = FILES_V2_LIMITS.binaryFileBytes;
    const upload = await port.beginUpload({
      transferId: "upload_max_1",
      path: "/deep/missing",
      name: "maximum.bin",
      mediaType: "application/octet-stream",
      size: totalBytes,
      contentKind: "binary",
    });

    for (const pass of ["hash", "encrypt"] as const) {
      let offset = 0;
      let ordinal = 0;
      while (offset < totalBytes) {
        const end = Math.min(totalBytes, offset + upload.chunkBytes);
        const result = await port.uploadChunk({
          transferId: upload.transferId,
          pass,
          ordinal,
          final: end === totalBytes,
          totalBytes,
        }, new ArrayBuffer(end - offset));
        if (pass === "encrypt" && end === totalBytes) {
          expect(result.committed).toBe(true);
          expect(result.entry).toMatchObject({
            path: "/deep/missing/maximum.bin",
            byteLength: totalBytes,
            contentKind: "binary",
          });
        }
        offset = end;
        ordinal += 1;
      }
    }

    expect(harness.lastPlan?.intent).toBe("create");
    expect(harness.lastPlan?.items.filter(
      (item) => item.metadata.nodeKind === "folder",
    )).toHaveLength(2);
    expect(harness.lastPlan?.items.filter(
      (item) => item.metadata.nodeKind === "file",
    )).toHaveLength(1);
  });

  test("streamed upload replays only its retained first block when the first frame reports an ID collision", async () => {
    const harness = active();
    harness.present = true;
    harness.vaultState = "locked";
    harness.writeFailures.push(idCollision());
    const port = makePort(harness);
    await port.unlock();
    const totalBytes = FILES_V2_LIMITS.normalPlaintextBlockBytes + 1;
    const upload = await port.beginUpload({
      transferId: "upload_collision_1",
      path: "/",
      name: "collision.bin",
      mediaType: "application/octet-stream",
      size: totalBytes,
      contentKind: "binary",
    });

    for (const pass of ["hash", "encrypt"] as const) {
      await port.uploadChunk({
        transferId: upload.transferId,
        pass,
        ordinal: 0,
        final: false,
        totalBytes,
      }, new ArrayBuffer(upload.chunkBytes));
      const completed = await port.uploadChunk({
        transferId: upload.transferId,
        pass,
        ordinal: 1,
        final: true,
        totalBytes,
      }, new ArrayBuffer(1));
      if (pass === "encrypt") {
        expect(completed.committed).toBe(true);
        expect(completed.entry?.path).toBe("/collision.bin");
      }
    }
    expect(harness.writeExecutions).toBe(2);
    expect(new Set(harness.plans.map((plan) =>
      idKey(plan.items.find(
        (item) => item.metadata.nodeKind === "file",
      )!.transition.nodeId)
    )).size).toBe(2);
  });

  test("upload bindings reject bad size, pass order, ordinals, final flags, and allow cancellation", async () => {
    const harness = active();
    harness.present = true;
    harness.vaultState = "locked";
    const port = makePort(harness);
    await port.unlock();
    const upload = await port.beginUpload({
      transferId: "upload_strict_1",
      path: "/",
      name: "strict.bin",
      mediaType: "application/octet-stream",
      size: 3,
      contentKind: "binary",
    });

    await expect(port.uploadChunk({
      transferId: upload.transferId,
      pass: "encrypt",
      ordinal: 0,
      final: false,
      totalBytes: 3,
    }, buffer(Uint8Array.of(1)))).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(port.uploadChunk({
      transferId: upload.transferId,
      pass: "hash",
      ordinal: 1,
      final: false,
      totalBytes: 3,
    }, buffer(Uint8Array.of(1)))).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(port.uploadChunk({
      transferId: upload.transferId,
      pass: "hash",
      ordinal: 0,
      final: false,
      totalBytes: 4,
    }, buffer(Uint8Array.of(1)))).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(port.uploadChunk({
      transferId: upload.transferId,
      pass: "hash",
      ordinal: 0,
      final: true,
      totalBytes: 3,
    }, buffer(Uint8Array.of(1)))).rejects.toMatchObject({
      code: "conflict",
    });

    const cancelled = await port.cancel(upload.transferId);
    expect(cancelled.transfers).toContainEqual(
      expect.objectContaining({
        id: upload.transferId,
        phase: "cancelled",
      }),
    );
    await expect(port.uploadChunk({
      transferId: upload.transferId,
      pass: "hash",
      ordinal: 0,
      final: true,
      totalBytes: 3,
    }, buffer(Uint8Array.of(1, 2, 3)))).rejects.toMatchObject({
      code: "not_found",
    });
  });

  test("known upload CAS conflicts retain the session and surface the conflicted phase", async () => {
    const harness = active();
    harness.present = true;
    harness.vaultState = "locked";
    harness.writeFailures.push(
      new FilesTransferEngineFault(
        "conflict",
        "synthetic upload revision changed",
        { rejectionReason: "stale_revision" },
      ),
    );
    const port = makePort(harness);
    await port.unlock();
    const upload = await port.beginUpload({
      transferId: "upload_conflict_1",
      path: "/",
      name: "conflicted.bin",
      mediaType: "application/octet-stream",
      size: 3,
      contentKind: "binary",
    });
    await port.uploadChunk({
      transferId: upload.transferId,
      pass: "hash",
      ordinal: 0,
      final: true,
      totalBytes: 3,
    }, buffer(Uint8Array.of(1, 2, 3)));

    await expect(port.uploadChunk({
      transferId: upload.transferId,
      pass: "encrypt",
      ordinal: 0,
      final: true,
      totalBytes: 3,
    }, buffer(Uint8Array.of(1, 2, 3)))).rejects.toMatchObject({
      code: "conflict",
    });

    const conflicted = await port.status();
    expect(conflicted.transfers).toContainEqual(
      expect.objectContaining({
        id: upload.transferId,
        phase: "conflicted",
        error: "synthetic upload revision changed",
      }),
    );
    await expect(port.beginUpload({
      transferId: "upload_other_1",
      path: "/",
      name: "other.bin",
      mediaType: "application/octet-stream",
      size: 1,
      contentKind: "binary",
    })).rejects.toMatchObject({ code: "busy" });

    const cancelled = await port.cancel(upload.transferId);
    expect(cancelled.transfers).toContainEqual(
      expect.objectContaining({
        id: upload.transferId,
        phase: "cancelled",
      }),
    );
  });

  test("zero-length uploads complete one empty chunk in each pass", async () => {
    const harness = active();
    harness.present = true;
    harness.vaultState = "locked";
    const port = makePort(harness);
    await port.unlock();
    const upload = await port.beginUpload({
      transferId: "upload_empty_1",
      path: "/",
      name: "empty.bin",
      mediaType: "application/octet-stream",
      size: 0,
      contentKind: "binary",
    });
    const hashed = await port.uploadChunk({
      transferId: upload.transferId,
      pass: "hash",
      ordinal: 0,
      final: true,
      totalBytes: 0,
    }, new ArrayBuffer(0));
    expect(hashed.readyForUpload).toBe(true);
    const committed = await port.uploadChunk({
      transferId: upload.transferId,
      pass: "encrypt",
      ordinal: 0,
      final: true,
      totalBytes: 0,
    }, new ArrayBuffer(0));
    expect(committed.committed).toBe(true);
    expect(committed.entry).toMatchObject({
      path: "/empty.bin",
      byteLength: 0,
      etagSha256: hex(sha256(new Uint8Array())),
    });
    expect(harness.sourceSlices).toEqual([]);
  });

  test("cancel arriving before an attachment read registers is consumed once", async () => {
    const harness = active();
    seedNavigation(harness);
    harness.present = true;
    harness.vaultState = "locked";
    const port = makePort(harness);
    await port.unlock();

    await port.cancel("read_precancel_1");
    await expect(port.read("/docs/note.txt", {
      transferId: "read_precancel_1",
    })).rejects.toMatchObject({ code: "cancelled" });
    expect(harness.readStarted).toBe(0);
    expect((await port.status()).transfers).toContainEqual(
      expect.objectContaining({
        id: "read_precancel_1",
        phase: "cancelled",
      }),
    );
  });

  test("an explicit tile cancel aborts an active tracked attachment read", async () => {
    const harness = active();
    seedNavigation(harness);
    harness.present = true;
    harness.vaultState = "locked";
    let releaseRead!: () => void;
    harness.readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const port = makePort(harness);
    await port.unlock();

    const reading = port.read("/docs/note.txt", {
      transferId: "read_cancel_1",
    });
    const observed = reading.catch((error: unknown) => error);
    await waitFor(() => harness.readStarted === 1);
    const cancelling = port.cancel("read_cancel_1");
    expect(harness.readSignal?.aborted).toBe(true);
    releaseRead();
    await expect(observed).resolves.toMatchObject({ code: "cancelled" });
    expect((await cancelling).transfers).toContainEqual(
      expect.objectContaining({
        id: "read_cancel_1",
        phase: "cancelled",
      }),
    );
  });

  test("an explicit tile cancel aborts an ordinary tracked text write", async () => {
    const harness = active();
    harness.present = true;
    harness.vaultState = "locked";
    let releaseWrite!: () => void;
    harness.writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const port = makePort(harness);
    await port.unlock();
    const bytes = new TextEncoder().encode("cancel me");

    const writing = port.write({
      transferId: "write_cancel_1",
      path: "/cancel.txt",
      source: {
        size: bytes.byteLength,
        slice: (start, end) => bytes.slice(start, end),
      },
      contentKind: "text",
      mediaType: "text/plain",
      ifMatch: null,
      ifNoneMatch: true,
      createParents: false,
    });
    const observed = writing.catch((error: unknown) => error);
    await waitFor(() => harness.writeExecutions === 1);
    const cancelling = port.cancel("write_cancel_1");
    expect(harness.writeSignal?.aborted).toBe(true);
    releaseWrite();
    await expect(observed).resolves.toMatchObject({ code: "cancelled" });
    expect((await cancelling).transfers).toContainEqual(
      expect.objectContaining({
        id: "write_cancel_1",
        phase: "cancelled",
      }),
    );
    expect(harness.records.has("/cancel.txt")).toBe(false);
  });

  test("client-owned upload ids close the begin/cancel registration race", async () => {
    const harness = active();
    harness.present = true;
    harness.vaultState = "locked";
    const port = makePort(harness);
    await port.unlock();

    const beginning = port.beginUpload({
      transferId: "upload_begin_race_1",
      path: "/",
      name: "race.bin",
      mediaType: "application/octet-stream",
      size: 1,
      contentKind: "binary",
    });
    const cancelling = port.cancel("upload_begin_race_1");
    await expect(beginning).rejects.toMatchObject({ code: "cancelled" });
    expect((await cancelling).transfers).toContainEqual(
      expect.objectContaining({
        id: "upload_begin_race_1",
        phase: "cancelled",
      }),
    );
  });

  test("a validated final binary upload commit wins a concurrent cancel", async () => {
    const harness = active();
    harness.present = true;
    harness.vaultState = "locked";
    harness.writeCommitWins = true;
    let releaseCommit!: () => void;
    harness.writeCommitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const port = makePort(harness);
    await port.unlock();
    const payload = Uint8Array.of(7, 8, 9);
    const upload = await port.beginUpload({
      transferId: "upload_commit_race_1",
      path: "/",
      name: "commit-race.bin",
      mediaType: "application/octet-stream",
      size: payload.byteLength,
      contentKind: "binary",
    });
    await port.uploadChunk({
      transferId: upload.transferId,
      pass: "hash",
      ordinal: 0,
      final: true,
      totalBytes: payload.byteLength,
    }, buffer(payload));
    const finalChunk = port.uploadChunk({
      transferId: upload.transferId,
      pass: "encrypt",
      ordinal: 0,
      final: true,
      totalBytes: payload.byteLength,
    }, buffer(payload));
    await waitFor(() => harness.writeCommitReady === 1);

    const cancelling = port.cancel(upload.transferId);
    expect(harness.writeSignal?.aborted).toBe(true);
    releaseCommit();
    await expect(finalChunk).resolves.toMatchObject({
      committed: true,
      phase: "committed",
    });
    expect((await cancelling).transfers).toContainEqual(
      expect.objectContaining({
        id: upload.transferId,
        phase: "committed",
      }),
    );
    expect(harness.records.has("/commit-race.bin")).toBe(true);
  });

  test("terminal transfer history remains below the tile status ceiling", async () => {
    const harness = active();
    harness.present = true;
    harness.vaultState = "locked";
    const port = makePort(harness);
    await port.unlock();

    for (let index = 0; index < 140; index += 1) {
      const transferId = `bounded_${index}`;
      await port.beginUpload({
        transferId,
        path: "/",
        name: `bounded-${index}.bin`,
        mediaType: "application/octet-stream",
        size: 0,
        contentKind: "binary",
      });
      await port.cancel(transferId);
    }
    const status = await port.status();
    expect(status.transfers.length).toBeLessThanOrEqual(128);
    expect(status.transfers.some((row) => row.id === "bounded_0")).toBe(false);
    expect(status.transfers).toContainEqual(
      expect.objectContaining({
        id: "bounded_139",
        phase: "cancelled",
      }),
    );
  });

  test("locked private-write recovery aborts backend-only without inventing source authority", async () => {
    const harness = active();
    harness.present = true;
    harness.vaultState = "locked";
    harness.activeOperations = [{
      request_id: id(76),
      kind: { private_write: null },
      stage_id: nat(77),
      expires_at_ns: nat(9_999_999),
      target: {
        private_write: {
          nodes: [{
            node_id: id(78),
            content_id: id(79),
          }],
        },
      },
    }];
    harness.failCryptoCreations = 1;
    const port = makePort(harness);
    const status = await port.status();
    const transferId = status.transfers[0]!.id;

    const afterAbort = await port.cancel(transferId);

    expect(harness.aborts).toEqual([{
      requestId: id(76),
      stageId: nat(77),
      stageKind: "private_write",
    }]);
    expect(harness.cryptoCreated).toBe(0);
    expect(harness.failCryptoCreations).toBe(1);
    expect(afterAbort.transfers).toEqual([]);
  });

  test("failed and authority-fenced runtime creation never persists a worker and a later call starts fresh", async () => {
    const harness = active();
    harness.failCryptoCreations = 1;
    const port = makePort(harness);
    await expect(port.initialize()).rejects.toThrow(
      "synthetic worker construction failure",
    );
    expect(harness.cryptoCreated).toBe(1);
    expect((await port.initialize()).vault).toBe("ready");
    expect(harness.cryptoCreated).toBe(2);

    const fencedHarness = makeHarness();
    activeHarness = fencedHarness;
    const fenced = makePort(fencedHarness);
    const pending = fenced.initialize();
    fenced.clearVolatile();
    await expect(pending).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(fencedHarness.cryptos[0]?.closed).toBe(true);
    expect((await fenced.initialize()).vault).toBe("ready");
    expect(fencedHarness.cryptoCreated).toBe(2);
  });

  test("real VaultEngine bootstrap checkpoint lock does not self-close the resident runtime", async () => {
    restoreVaultTestSeams();
    let port: DefaultFilesResidentPort | null = null;
    try {
      const harness = makeHarness();
      activeHarness = harness;
      let closes = 0;
      const calls: string[] = [];
      const crypto = {
        closed: false,
        onInactivityLock() {
          return () => undefined;
        },
        async call(
          request: FilesCryptoWorkerRequestWithoutId,
        ): Promise<FilesCryptoWorkerResult> {
          calls.push(request.type);
          if (this.closed) throw new Error("synthetic worker was closed");
          if (request.type === "lock" || request.type === "reset") {
            return {
              type: "status",
              status: workerStatus(false),
            };
          }
          throw new Error(`unexpected real-lifecycle call: ${request.type}`);
        },
        close() {
          this.closed = true;
          closes += 1;
        },
      };
      port = new DefaultFilesResidentPort({
        backend: backend(harness),
        createCrypto: () =>
          crypto as unknown as FilesCryptoWorkerClient,
        vetkeys: {
          async list() {
            throw new Error("synthetic stop after bootstrap checkpoint");
          },
          request: async () => {
            throw new Error("unexpected lifecycle request");
          },
          publicKey: async () => {
            throw new Error("unexpected public-key request");
          },
          derive: async () => {
            throw new Error("unexpected derive request");
          },
          approve: async () => {
            throw new Error("unexpected approval");
          },
        },
      });
      await expect(port.initialize()).rejects.toThrow(
        "synthetic stop after bootstrap checkpoint",
      );
      expect(calls).toEqual(["lock", "reset"]);
      expect(closes).toBe(0);
      expect(crypto.closed).toBe(false);
    } finally {
      port?.clearVolatile("shutdown");
      installVaultTestSeams();
    }
  });

  test("volatile upload state is erased independently of the persistent unlock cache", async () => {
    const harness = active();
    harness.present = true;
    harness.vaultState = "locked";
    const port = makePort(harness);
    await port.unlock();
    const upload = await port.beginUpload({
      transferId: "upload_volatile_1",
      path: "/",
      name: "volatile.bin",
      mediaType: "application/octet-stream",
      size: 1,
      contentKind: "binary",
    });
    port.clearVolatile();
    await expect(port.uploadChunk({
      transferId: upload.transferId,
      pass: "hash",
      ordinal: 0,
      final: true,
      totalBytes: 1,
    }, buffer(Uint8Array.of(1)))).rejects.toMatchObject({
      code: "not_found",
    });
    expect(harness.cryptos[0]?.closed).toBe(true);

    const source = await readFile(
      new URL("../src/vault/resident_port.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /\b(?:indexedDB|localStorage|sessionStorage|CacheStorage)\b/u,
    );
  });

  test("explicit lock synchronously erases and fences an upload waiting below the write boundary", async () => {
    const harness = active();
    harness.present = true;
    harness.vaultState = "locked";
    const port = makePort(harness);
    await port.unlock();
    let releaseLookup!: () => void;
    harness.lookupPathGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const upload = await port.beginUpload({
      transferId: "upload_lock_race_1",
      path: "/",
      name: "lock-race.bin",
      mediaType: "application/octet-stream",
      size: 3,
      contentKind: "binary",
    });
    await port.uploadChunk({
      transferId: upload.transferId,
      pass: "hash",
      ordinal: 0,
      final: true,
      totalBytes: 3,
    }, buffer(Uint8Array.of(1, 2, 3)));
    const encryptBody = buffer(Uint8Array.of(1, 2, 3));
    const pendingEncrypt = port.uploadChunk({
      transferId: upload.transferId,
      pass: "encrypt",
      ordinal: 0,
      final: true,
      totalBytes: 3,
    }, encryptBody);
    await drainMicrotasks();
    expect([...new Uint8Array(encryptBody)]).toEqual([0, 0, 0]);
    expect(harness.lookupPathCalls).toBeGreaterThan(0);

    const pendingLock = port.lock();
    expect(harness.cryptos[0]?.closed).toBe(true);
    await expect(port.uploadChunk({
      transferId: upload.transferId,
      pass: "encrypt",
      ordinal: 1,
      final: true,
      totalBytes: 3,
    }, buffer(new Uint8Array()))).rejects.toMatchObject({
      code: "not_found",
    });

    releaseLookup();
    harness.lookupPathGate = null;
    await expect(pendingEncrypt).rejects.toMatchObject({
      code: "cancelled",
    });
    const locked = await pendingLock;
    expect(locked.vault).toBe("locked");
    expect(locked.transfers).toEqual([]);
    expect(harness.writeExecutions).toBe(0);
    expect(harness.records.has("/lock-race.bin")).toBe(false);
  });
});

function installVaultTestSeams(): void {
  FilesVaultEngine.prototype.status = function (): FilesVaultStatus {
    return statusFor(owner(this));
  };
  FilesVaultEngine.prototype.onLock = function (
    listener: () => void,
  ): () => void {
    const harness = owner(this);
    const listeners = listenersFor(harness, this);
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  FilesVaultEngine.prototype.dispose = function (): void {
    const harness = owner(this);
    listenersFor(harness, this).clear();
  };
  FilesVaultEngine.prototype.bootstrap = async function (
    options: FilesVaultBootstrapOptions = {},
  ): Promise<FilesVaultStatus> {
    const harness = owner(this);
    await Promise.resolve();
    if (options.initializeIfAbsent && !harness.present) {
      harness.present = true;
      harness.vaultState = "locked";
    }
    if (options.unlock && harness.present) harness.vaultState = "ready";
    return statusFor(harness);
  };
  FilesVaultEngine.prototype.unlock = async function (): Promise<
    FilesVaultStatus
  > {
    const harness = owner(this);
    if (!harness.present) {
      throw new FilesVaultEngineFault("not_initialized");
    }
    harness.vaultState = "ready";
    return statusFor(harness);
  };
  FilesVaultEngine.prototype.lock = async function (): Promise<
    FilesVaultStatus
  > {
    const harness = owner(this);
    if (harness.present) harness.vaultState = "locked";
    for (const listener of [...listenersFor(harness, this)]) listener();
    return statusFor(harness);
  };
  FilesVaultEngine.prototype.refreshCommittedView = async function () {
    const harness = owner(this);
    harness.refreshCalls += 1;
    if (harness.refreshFailure !== null) throw harness.refreshFailure;
    if (harness.vaultState !== "ready") {
      throw new FilesVaultEngineFault("needs_user_unlock");
    }
    return statusFor(harness) as Extract<
      FilesVaultStatus,
      { state: "ready" }
    >;
  };
  FilesVaultEngine.prototype.lookupPath = async function (
    pathInput: string,
  ): Promise<FilesNodeRecord> {
    const harness = owner(this);
    harness.lookupPathCalls += 1;
    await harness.lookupPathGate;
    const path = canonicalTestPath(pathInput);
    const record = harness.records.get(path);
    if (!record) throw new FilesVaultEngineFault("not_found");
    return record;
  };
  FilesVaultEngine.prototype.lookupNode = async function (
    nodeId: FilesId128V2,
  ): Promise<FilesNodeRecord> {
    const harness = owner(this);
    harness.lookupNodeCalls += 1;
    for (const record of harness.records.values()) {
      if (sameId(record.node.nodeId, nodeId)) return record;
    }
    throw new FilesVaultEngineFault("not_found");
  };
  FilesVaultEngine.prototype.lookupChild = async function (
    parent: FilesNodeRecord,
    name: string,
  ): Promise<FilesNodeRecord> {
    const harness = owner(this);
    harness.lookupChildCalls += 1;
    for (const record of harness.records.values()) {
      if (
        sameId(record.node.parentId, parent.node.nodeId) &&
        record.metadata.name === name
      ) {
        return record;
      }
    }
    throw new FilesVaultEngineFault("not_found");
  };
  FilesVaultEngine.prototype.listFolder = async function (
    folder: FilesNodeRecord,
    options: {
      cursor?: import("../src/protocol/types.ts").FilesListCursorV2 | null;
      limit?: number;
    } = {},
  ): Promise<FilesListPage> {
    const harness = owner(this);
    const entries = [...harness.records.entries()]
      .filter(([path, record]) =>
        path !== "/" && sameId(record.node.parentId, folder.node.nodeId)
      )
      .sort(([left], [right]) => left.localeCompare(right));
    const start = options.cursor === null || options.cursor === undefined
      ? 0
      : Number(options.cursor.last_name_tag.a);
    const limit = options.limit ?? 100;
    const items = entries.slice(start, start + limit).map(([, item]) => item);
    const nextOffset = start + items.length;
    const hasMore = nextOffset < entries.length;
    return Object.freeze({
      parentId: folder.node.nodeId,
      structuralRevision: folder.node.structuralRevision,
      childrenRevision: folder.node.childrenRevision,
      items: Object.freeze(items),
      totalChildren: entries.length,
      hasMore,
      nextCursor: hasMore
        ? Object.freeze({
            parent_id: folder.node.nodeId,
            children_revision: folder.node.childrenRevision,
            last_name_tag: {
              a: nat(nextOffset),
              b: ZERO,
              c: ZERO,
              d: ZERO,
            },
          })
        : null,
    });
  };

  FilesTransferEngine.prototype.readPrivate = async function (
    request: FilesReadRequest,
    controls: FilesTransferControls = {},
  ) {
    const harness = active();
    harness.readStarted += 1;
    harness.readSignal = controls.signal ?? null;
    controls.onProgress?.({
      phase: "decrypting",
      plaintextBytes: 0,
      processedBytes: 0,
      blockIndex: 0,
      blockCount: 1,
    });
    await harness.readGate;
    if (controls.signal?.aborted) throw cancelled();
    const match = [...harness.records.entries()].find(([, record]) =>
      sameId(record.node.nodeId, request.nodeId)
    );
    if (!match || match[1].metadata.nodeKind !== "file" || !match[1].content) {
      throw new Error("Synthetic file is absent");
    }
    const bytes = harness.content.get(match[0])?.slice();
    if (!bytes) throw new Error("Synthetic content is absent");
    controls.onProgress?.({
      phase: "committed",
      plaintextBytes: bytes.byteLength,
      processedBytes: bytes.byteLength,
      blockIndex: 0,
      blockCount: 1,
    });
    return Object.freeze({
      metadata: match[1].metadata,
      bytes,
      node: match[1].node,
      content: match[1].content,
    });
  };
  FilesTransferEngine.prototype.writePrivatePrehashed = async function (
    plan: FilesPrivateWritePlan,
    prehashedDigests: readonly Uint8Array[],
    controls: FilesTransferControls = {},
  ): Promise<FilesWriteReceipt> {
    const harness = active();
    harness.lastPlan = plan;
    harness.plans.push(plan);
    harness.writeExecutions += 1;
    harness.writeSignal = controls.signal ?? null;
    await harness.writeGate;
    if (controls.signal?.aborted) throw cancelled();
    const queuedFailure = harness.writeFailures.shift();
    if (queuedFailure !== undefined) {
      const file = plan.items.find(
        (item) => item.metadata.nodeKind === "file",
      );
      if (file !== undefined) {
        const end = Math.min(
          file.source.size,
          FILES_V2_LIMITS.normalPlaintextBlockBytes,
        );
        const value = await file.source.slice(0, end);
        const consumed = await bytesFrom(value);
        consumed.fill(0);
      }
      throw queuedFailure;
    }
    if (harness.writeFailure !== null) throw harness.writeFailure;
    let firstPath: string | null = null;
    let firstNode: FilesNodeRecord | null = null;
    const committedNodes: import("../src/protocol/types.ts")
      .FilesCommittedNodeV2[] = [];
    const staged: Array<{
      path: string;
      record: FilesNodeRecord;
      bytes: Uint8Array | null;
    }> = [];
    const plannedPaths = new Map<string, string>();
    for (const [path, record] of harness.records) {
      plannedPaths.set(idKey(record.node.nodeId), path);
    }
    let digestIndex = 0;
    for (let index = 0; index < plan.items.length; index += 1) {
      if (controls.signal?.aborted) throw cancelled();
      const item = plan.items[index]!;
      const parentPath = plannedPaths.get(
        idKey(item.transition.proposedParentId),
      );
      if (parentPath === undefined) {
        throw new Error("Synthetic planned parent is absent");
      }
      const path =
        parentPath === "/"
          ? `/${item.metadata.name}`
          : `${parentPath}/${item.metadata.name}`;
      if (item.metadata.nodeKind === "folder") {
        const record = folderNodeFromPlan(item);
        staged.push({ path, record, bytes: null });
        plannedPaths.set(idKey(record.node.nodeId), path);
        committedNodes.push({
          node_id: record.node.nodeId,
          content_id: null,
          structural_revision: record.node.structuralRevision,
          metadata_revision: record.node.metadataRevision,
        });
        continue;
      }
      const file = requireFileWriteItem(item);
      const bytes = new Uint8Array(file.source.size);
      let offset = 0;
      while (offset < file.source.size) {
        if (controls.signal?.aborted) throw cancelled();
        const chunkBytes =
          file.source.size > 1_024
            ? FILES_V2_LIMITS.normalPlaintextBlockBytes
            : 2;
        const end = Math.min(file.source.size, offset + chunkBytes);
        harness.sourceSlices.push({ start: offset, end });
        const value = await file.source.slice(offset, end);
        const part = await bytesFrom(value);
        if (part.byteLength !== end - offset) {
          throw new Error("Synthetic source changed length");
        }
        bytes.set(part, offset);
        offset = end;
        controls.onProgress?.({
          phase: "encrypting",
          plaintextBytes: file.source.size,
          processedBytes: offset,
          blockIndex: 0,
          blockCount: 1,
        });
      }
      if (!equal(sha256(bytes), prehashedDigests[digestIndex++]!)) {
        throw new Error("Synthetic second pass changed digest");
      }
      const contentId = id(
        Number(file.transition.nodeId.lo) + 10_000,
      );
      const record = nodeFromPlan(file, contentId);
      staged.push({ path, record, bytes });
      plannedPaths.set(idKey(record.node.nodeId), path);
      committedNodes.push({
        node_id: record.node.nodeId,
        content_id: record.content!.contentId,
        structural_revision: record.node.structuralRevision,
        metadata_revision: record.node.metadataRevision,
      });
      firstPath ??= path;
      firstNode ??= record;
    }
    harness.writeCommitReady += 1;
    await harness.writeCommitGate;
    if (controls.signal?.aborted && !harness.writeCommitWins) {
      throw cancelled();
    }
    for (const value of staged) {
      harness.records.set(value.path, value.record);
      if (value.bytes !== null) {
        harness.content.set(value.path, value.bytes);
      }
    }
    applyFolderTransitions(harness, plan);
    controls.onProgress?.({
      phase: "committed",
      plaintextBytes: plan.items.reduce(
        (total, item) => total + (item.source?.size ?? 0),
        0,
      ),
      processedBytes: plan.items.reduce(
        (total, item) => total + (item.source?.size ?? 0),
        0,
      ),
      blockIndex: 0,
      blockCount: 1,
    });
    if (!firstPath || !firstNode?.content) {
      throw new Error("Synthetic write plan was empty");
    }
    return Object.freeze({
      requestId: id(900),
      committedNodes: Object.freeze(
        committedNodes.sort((left, right) =>
          compareId(left.node_id, right.node_id)
        ),
      ),
      nodeId: firstNode.node.nodeId,
      contentId: firstNode.content.contentId,
      structuralRevision: firstNode.node.structuralRevision,
      cleanupPending: false,
    });
  };
}

function restoreVaultTestSeams(): void {
  Object.assign(FilesVaultEngine.prototype, originalVaultMethods);
  Object.assign(FilesTransferEngine.prototype, originalTransferMethods);
}

function makeHarness(): Harness {
  const records = new Map<string, FilesNodeRecord>();
  records.set("/", folderRecord({
    nodeId: ROOT_ID,
    parentId: ROOT_ID,
    name: "",
    structuralRevision: nat(1),
    childrenRevision: nat(1),
  }));
  return {
    present: false,
    vaultState: "uninitialized",
    backendCalls: [],
    cryptoCreated: 0,
    cryptos: [],
    records,
    content: new Map(),
    vaults: new Set(),
    lockListeners: new Map(),
    sourceSlices: [],
    failCryptoCreations: 0,
    lastPlan: null,
    plans: [],
    activeOperations: [],
    aborts: [],
    readGate: null,
    readStarted: 0,
    readSignal: null,
    writeGate: null,
    writeCommitGate: null,
    writeCommitReady: 0,
    writeSignal: null,
    writeCommitWins: false,
    writeExecutions: 0,
    writeFailure: null,
    writeFailures: [],
    refreshCalls: 0,
    refreshFailure: null,
    lookupPathCalls: 0,
    lookupPathGate: null,
    lookupChildCalls: 0,
    lookupNodeCalls: 0,
  };
}

function makePort(harness: Harness): DefaultFilesResidentPort {
  activeHarness = harness;
  return new DefaultFilesResidentPort({
    backend: backend(harness),
    vetkeys: unusedVetKeys(),
    createCrypto: () => {
      harness.cryptoCreated += 1;
      if (harness.failCryptoCreations > 0) {
        harness.failCryptoCreations -= 1;
        throw new Error("synthetic worker construction failure");
      }
      const crypto = new FakeCrypto();
      harness.cryptos.push(crypto);
      return crypto as unknown as FilesCryptoWorkerClient;
    },
  });
}

class FakeCrypto implements FilesCryptoPort {
  closed = false;

  async call(
    request: FilesCryptoWorkerRequestWithoutId,
  ): Promise<FilesCryptoWorkerResult> {
    if (this.closed) throw new Error("synthetic worker is closed");
    switch (request.type) {
      case "name_tag":
        return {
          type: "name_tag",
          nameTag: sha256(
            new TextEncoder().encode(
              `${request.parentNodeId.hi}:${request.parentNodeId.lo}:${
                request.filename
              }`,
            ),
          ),
        };
      case "encrypt_metadata":
        return {
          type: "metadata_encrypted",
          ciphertext: request.plaintext.slice(),
        };
      case "lock":
      case "reset":
      case "status":
        return {
          type: "status",
          status: workerStatus(request.type === "status"),
        };
      default:
        throw new Error(`Unexpected synthetic crypto call: ${request.type}`);
    }
  }

  onInactivityLock(): () => void {
    return () => undefined;
  }

  close(): void {
    this.closed = true;
  }
}

function workerStatus(unlocked: boolean) {
  return Object.freeze({
    configured: true,
    currentGeneration: "1",
    previousGeneration: null,
    unlocked,
    unlockedGeneration: unlocked ? "1" : null,
    pendingGeneration: null,
    inactivityExpiresAt: null,
    contentCipherCount: 0,
    retryFrameCount: 0,
  });
}

function backend(harness: Harness): FilesBackendPort {
  const unexpected = (name: string): never => {
    harness.backendCalls.push(name);
    throw new Error(`Unexpected synthetic backend call: ${name}`);
  };
  return {
    async bootstrap(): Promise<
      FilesAttachmentOutcomeV2<FilesBootstrapOkV2>
    > {
      harness.backendCalls.push("bootstrap");
      return {
        kind: "ok",
        value: bootstrapValue(harness.present, harness.activeOperations),
        body: new ArrayBuffer(0),
      };
    },
    list: async () => unexpected("list"),
    lookup: async () => unexpected("lookup"),
    readChunk: async () => unexpected("readChunk"),
    operationStatus: async () => unexpected("operationStatus"),
    vaultWrite: async () => unexpected("vaultWrite"),
    writeBlock: async () => unexpected("writeBlock"),
    mutate: async () => unexpected("mutate"),
    remove: async () => unexpected("remove"),
    async abort(request) {
      harness.backendCalls.push("abort");
      harness.aborts.push({
        requestId: request.request_id,
        stageId: request.stage_id,
        stageKind: "private_write",
      });
      harness.activeOperations = harness.activeOperations.filter(
        (summary) => !sameId(summary.request_id, request.request_id),
      );
      return {
        kind: "ok",
        value: {
          request_id: request.request_id,
          stage_id: request.stage_id,
          cleanup_state: { clean: null },
        },
      };
    },
    cleanup: async () => unexpected("cleanup"),
  };
}

function unusedVetKeys(): FilesVetKeysPort {
  const unexpected = (): never => {
    throw new Error("Synthetic VaultEngine seam unexpectedly used VetKeys");
  };
  return {
    list: async () => unexpected(),
    request: async () => unexpected(),
    publicKey: async () => unexpected(),
    derive: async () => unexpected(),
    approve: async () => unexpected(),
  };
}

function bootstrapValue(
  present: boolean,
  activeOperations: FilesOperationSummaryV2[],
): FilesBootstrapOkV2 {
  const counters = {
    live_entries: ZERO,
    occupied_entry_slots: ZERO,
    committed_body_bytes: ZERO,
    reserved_committed_body_bytes: ZERO,
    reserved_entry_slots: ZERO,
    allocated_body_bytes: ZERO,
    charged_metadata_bytes: ZERO,
    accepted_staged_bytes: ZERO,
    reserved_staged_bytes: ZERO,
    detached_charged_bytes: ZERO,
    active_stages: ZERO,
    receipt_lanes: ZERO,
    general_receipt_lanes: ZERO,
    reserved_general_receipt_lanes: ZERO,
    reserved_revocation_lanes: ZERO,
    filled_revocation_lanes: ZERO,
    receipt_nonce_indexes: ZERO,
    receipt_expiry_indexes: ZERO,
    cleanup_jobs: ZERO,
  };
  const limits = {
    entries: nat(256),
    committed_bytes: nat(64 * 1024 * 1024),
    object_bytes: nat(16 * 1024 * 1024),
    staged_bytes: nat(32 * 1024 * 1024),
    pending_stages: nat(2),
    batch_operations: nat(20),
    batch_bytes: nat(32 * 1024 * 1024),
    general_receipts: nat(256),
    revocation_lanes: nat(256),
  };
  return {
    vault: present
      ? {
          present: {
            format: 2,
            record_revision: nat(1),
            slot_generation: nat(1),
            public_key_fingerprint: digest(11),
            wrapper_frame_bytes: 512,
          },
        }
      : { absent: null },
    quota: {
      nodes: nat(1),
      committed_private_plaintext_bytes: ZERO,
      committed_ciphertext_bytes: ZERO,
      staged_ciphertext_bytes: ZERO,
      physical_private_bytes: ZERO,
      cleanup_jobs: 0,
    },
    public_usage: {
      current: counters,
      manifest_limits: limits,
      effective_limits: limits,
    },
    cleanup: {
      remaining_jobs: 0,
      has_more: false,
      state: { clean: null },
    },
    active_operations: activeOperations,
    body_bytes: 0,
  };
}

function statusFor(harness: Harness): FilesVaultStatus {
  if (harness.vaultState === "uninitialized") {
    return Object.freeze({
      state: "uninitialized",
      capacity: capacity(),
    });
  }
  if (harness.vaultState === "locked") {
    return Object.freeze({
      state: "locked",
      capacity: capacity(),
      record: vaultRecord(),
      currentGeneration: nat(1),
      previousGeneration: null,
      migrationRequired: false,
    });
  }
  return Object.freeze({
    state: "ready",
    capacity: capacity(),
    record: vaultRecord(),
    root: harness.records.get("/")!,
    currentGeneration: nat(1),
    previousGeneration: null,
    rotationConfirmed: true,
  });
}

function capacity(): FilesCapacitySnapshot {
  const meter = Object.freeze({
    used: ZERO,
    limit: nat(1_000_000_000),
    remaining: nat(1_000_000_000),
    utilizationBasisPoints: 0,
  });
  return Object.freeze({
    privateQuota: Object.freeze({
      nodes: nat(1),
      committedPlaintextBytes: ZERO,
      committedCiphertextBytes: ZERO,
      stagedCiphertextBytes: ZERO,
      physicalBytes: ZERO,
      cleanupJobs: 0,
    }),
    public: Object.freeze({
      rollingEntries: meter,
      committedBytes: meter,
      stagedBytes: meter,
      pendingStages: meter,
      rollingGeneralReceipts: meter,
      revocationLanes: meter,
      maxObjectBytes: nat(16 * 1024 * 1024),
      maxBatchOperations: nat(20),
      maxBatchBytes: nat(32 * 1024 * 1024),
      limiting: Object.freeze({
        dimension: "rolling_entries",
        utilizationBasisPoints: 0,
      }),
    }),
  });
}

function vaultRecord(): FilesVaultRecord {
  return Object.freeze({
    format: 2,
    recordRevision: nat(1),
    slotGeneration: nat(1),
    context: Object.freeze({
      neutronCanisterPrincipalBytes: Uint8Array.of(1),
      vaultId: bytes(16, 1),
      vaultSalt: bytes(32, 2),
    }),
    publicKeyFingerprint: bytes(32, 3),
    rootCommitment: bytes(32, 4),
    rootStructuralRevision: nat(1),
    rootMetadataRevision: nat(1),
    rootChildrenRevision: nat(1),
    wrapperCiphertext: bytes(48, 5),
    encryptedRootMetadata: Uint8Array.of(6),
  });
}

function seedNavigation(harness: Harness): void {
  harness.records.set("/docs", folderRecord({
    nodeId: id(1),
    parentId: ROOT_ID,
    name: "docs",
    structuralRevision: nat(2),
    childrenRevision: nat(2),
  }));
  const note = fileRecord({
    nodeId: id(2),
    parentId: id(1),
    contentId: id(3),
    name: "note.txt",
    contentKind: "text_v1",
    mediaType: "text/plain",
    bytes: new TextEncoder().encode("hello"),
  });
  harness.records.set("/docs/note.txt", note);
  harness.content.set(
    "/docs/note.txt",
    new TextEncoder().encode("hello"),
  );
  const binaryBytes = Uint8Array.of(0, 1, 2, 255);
  harness.records.set("/blob.bin", fileRecord({
    nodeId: id(4),
    parentId: ROOT_ID,
    contentId: id(5),
    name: "blob.bin",
    contentKind: "binary_v1",
    mediaType: "application/octet-stream",
    bytes: binaryBytes,
  }));
  harness.content.set("/blob.bin", binaryBytes);
}

function folderRecord(input: {
  nodeId: FilesId128V2;
  parentId: FilesId128V2;
  name: string;
  structuralRevision: CanonicalNat64;
  childrenRevision: CanonicalNat64;
}): FilesNodeRecord {
  return Object.freeze({
    node: Object.freeze({
      nodeId: input.nodeId,
      parentId: input.parentId,
      kind: "folder",
      nameTag: sha256(new TextEncoder().encode(input.name)),
      declaredNameScalars: [...input.name].length,
      structuralRevision: input.structuralRevision,
      metadataRevision: nat(1),
      childrenRevision: input.childrenRevision,
      subtreeHeight: 1,
      maxRelativePathScalars: 64,
      subtreePlaintextBytes: ZERO,
    }),
    content: null,
    metadata: Object.freeze({
      nodeKind: "folder",
      name: input.name,
      createdAtNs: nat(1),
      modifiedAtNs: nat(2),
    }),
    wrappedContentKey: null,
  });
}

function fileRecord(input: {
  nodeId: FilesId128V2;
  parentId: FilesId128V2;
  contentId: FilesId128V2;
  name: string;
  contentKind: "text_v1" | "binary_v1";
  mediaType: string;
  bytes: Uint8Array;
}): FilesNodeRecord {
  return Object.freeze({
    node: Object.freeze({
      nodeId: input.nodeId,
      parentId: input.parentId,
      kind: "file",
      nameTag: sha256(new TextEncoder().encode(input.name)),
      declaredNameScalars: [...input.name].length,
      structuralRevision: nat(1),
      metadataRevision: nat(1),
      childrenRevision: ZERO,
      subtreeHeight: 0,
      maxRelativePathScalars: 0,
      subtreePlaintextBytes: nat(input.bytes.byteLength),
    }),
    content: Object.freeze({
      contentId: input.contentId,
      blockCount: 1,
      ciphertextBytes: nat(input.bytes.byteLength),
      cryptoProfile: "aes_256_gcm_files_v2",
    }),
    metadata: Object.freeze({
      nodeKind: "file",
      name: input.name,
      contentKind: input.contentKind,
      mimeType: input.mediaType,
      plaintextBytes: input.bytes.byteLength,
      plaintextSha256: sha256(input.bytes),
      createdAtNs: nat(1),
      modifiedAtNs: nat(2),
    }),
    wrappedContentKey: bytes(48, 7),
  });
}

function nodeFromPlan(
  item: Extract<FilesWriteItem, { source: FilesTransferSource }>,
  contentId: FilesId128V2,
): FilesNodeRecord {
  const transition = item.transition;
  const metadata = item.metadata as FilesFileMetadata;
  return Object.freeze({
    node: Object.freeze({
      nodeId: transition.nodeId,
      parentId: transition.proposedParentId,
      kind: transition.requestedKind,
      nameTag: transition.proposedNameTag.slice(),
      declaredNameScalars: transition.declaredNameScalars,
      structuralRevision: transition.proposedStructuralRevision,
      metadataRevision: transition.proposedMetadataRevision,
      childrenRevision: transition.proposedChildrenRevision,
      subtreeHeight: transition.proposedSubtreeHeight,
      maxRelativePathScalars:
        transition.proposedMaxRelativePathScalars,
      subtreePlaintextBytes:
        transition.proposedSubtreePlaintextBytes,
    }),
    content: Object.freeze({
      contentId,
      blockCount: item.source.size === 0 ? 1 : 1,
      ciphertextBytes: nat(item.source.size),
      cryptoProfile: "aes_256_gcm_files_v2",
    }),
    metadata: Object.freeze({
      ...metadata,
      plaintextSha256: metadata.plaintextSha256.slice(),
    }),
    wrappedContentKey: bytes(48, 8),
  });
}

function folderNodeFromPlan(item: FilesWriteItem): FilesNodeRecord {
  if (item.metadata.nodeKind !== "folder") {
    throw new Error("Synthetic resident write expected a folder item");
  }
  const transition = item.transition;
  return Object.freeze({
    node: Object.freeze({
      nodeId: transition.nodeId,
      parentId: transition.proposedParentId,
      kind: "folder",
      nameTag: transition.proposedNameTag.slice(),
      declaredNameScalars: transition.declaredNameScalars,
      structuralRevision: transition.proposedStructuralRevision,
      metadataRevision: transition.proposedMetadataRevision,
      childrenRevision: transition.proposedChildrenRevision,
      subtreeHeight: transition.proposedSubtreeHeight,
      maxRelativePathScalars:
        transition.proposedMaxRelativePathScalars,
      subtreePlaintextBytes:
        transition.proposedSubtreePlaintextBytes,
    }),
    content: null,
    metadata: Object.freeze({ ...item.metadata }),
    wrappedContentKey: null,
  });
}

function requireFileWriteItem(
  item: FilesWriteItem,
): Extract<FilesWriteItem, { source: FilesTransferSource }> {
  if (item.source === null || item.metadata.nodeKind !== "file") {
    throw new Error("Synthetic resident write expected a file item");
  }
  return item as Extract<FilesWriteItem, { source: FilesTransferSource }>;
}

function applyFolderTransitions(
  harness: Harness,
  plan: FilesPrivateWritePlan,
): void {
  let previous: FilesId128V2 | null = null;
  const plaintextDelta =
    BigInt(plan.quota.proposedCommittedPlaintextBytes) -
    BigInt(plan.quota.expectedCommittedPlaintextBytes);
  for (const transition of plan.folderTransitions) {
    if (
      previous !== null &&
      compareId(previous, transition.nodeId) >= 0
    ) {
      throw new Error("Synthetic ancestor witnesses are not canonically sorted");
    }
    previous = transition.nodeId;
    const match = [...harness.records.entries()].find(([, record]) =>
      sameId(record.node.nodeId, transition.nodeId)
    );
    if (!match) continue;
    const [path, record] = match;
    if (
      record.node.structuralRevision !==
        transition.expectedStructuralRevision ||
      record.node.childrenRevision !== transition.expectedChildrenRevision
    ) {
      throw new Error("Synthetic ancestor witness is stale");
    }
    const directMembershipChanged = plan.childIndexTransitions.some(
      (index) =>
        sameId(index.parentId, transition.nodeId) &&
        !sameOptionalId(index.expectedNodeId, index.proposedNodeId),
    );
    harness.records.set(path, Object.freeze({
      ...record,
      node: Object.freeze({
        ...record.node,
        structuralRevision:
          incrementNat(record.node.structuralRevision),
        childrenRevision: directMembershipChanged
          ? incrementNat(record.node.childrenRevision)
          : record.node.childrenRevision,
        subtreePlaintextBytes:
          (BigInt(record.node.subtreePlaintextBytes) + plaintextDelta)
            .toString() as CanonicalNat64,
      }),
    }));
  }
}

function owner(vault: FilesVaultEngine): Harness {
  let harness = vaultOwners.get(vault);
  if (!harness) {
    harness = active();
    vaultOwners.set(vault, harness);
    harness.vaults.add(vault);
  }
  return harness;
}

function listenersFor(
  harness: Harness,
  vault: FilesVaultEngine,
): Set<() => void> {
  let listeners = harness.lockListeners.get(vault);
  if (!listeners) {
    listeners = new Set();
    harness.lockListeners.set(vault, listeners);
  }
  return listeners;
}

function triggerInactivity(harness: Harness): void {
  harness.vaultState = "locked";
  for (const vault of harness.vaults) {
    for (const listener of [...listenersFor(harness, vault)]) listener();
  }
}

function active(): Harness {
  if (!activeHarness) throw new Error("No active resident test harness");
  return activeHarness;
}

function atomicParentBatch(
  folderCount: number,
): Parameters<FilesResidentFilePort["writeMany"]>[0] {
  return Object.freeze(Array.from({ length: 20 }, (_, index) =>
    Object.freeze({
      path: index < folderCount
        ? `/existing/parent-${index}/file-${index}.txt`
        : `/existing/file-${index}.txt`,
      text: `value-${index}`,
      overwrite: false,
      createParents: true,
      mediaType: "text/plain",
    })
  ));
}

function structuralEntryCount(plan: FilesPrivateWritePlan): number {
  return plan.items.length +
    plan.folderTransitions.length +
    plan.childIndexTransitions.length +
    plan.retiredContents.length;
}

function pathForNode(
  harness: Harness,
  nodeId: FilesId128V2,
): string {
  const found = [...harness.records.entries()].find(([, record]) =>
    sameId(record.node.nodeId, nodeId)
  );
  if (!found) throw new Error("Synthetic parent node is absent");
  return found[0];
}

function canonicalTestPath(input: string): string {
  if (input === "/") return "/";
  return `/${input.split("/").filter(Boolean).join("/")}`;
}

function nat(value: number | bigint): CanonicalNat64 {
  return BigInt(value).toString() as CanonicalNat64;
}

function id(value: number): FilesId128V2 {
  return Object.freeze({ hi: ZERO, lo: nat(value) });
}

function digest(value: number) {
  return Object.freeze({
    a: nat(value),
    b: ZERO,
    c: ZERO,
    d: ZERO,
  });
}

function bytes(length: number, value: number): Uint8Array {
  return new Uint8Array(length).fill(value);
}

function buffer(value: Uint8Array): ArrayBuffer {
  return value.slice().buffer;
}

async function bytesFrom(
  value: Blob | ArrayBuffer | Uint8Array,
): Promise<Uint8Array> {
  if (value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : value.slice();
}

function sameId(left: FilesId128V2, right: FilesId128V2): boolean {
  return left.hi === right.hi && left.lo === right.lo;
}

function idKey(value: FilesId128V2): string {
  return `${value.hi}:${value.lo}`;
}

function sameOptionalId(
  left: FilesId128V2 | null,
  right: FilesId128V2 | null,
): boolean {
  return left === null
    ? right === null
    : right !== null && sameId(left, right);
}

function compareId(left: FilesId128V2, right: FilesId128V2): number {
  const leftHi = BigInt(left.hi);
  const rightHi = BigInt(right.hi);
  if (leftHi !== rightHi) return leftHi < rightHi ? -1 : 1;
  const leftLo = BigInt(left.lo);
  const rightLo = BigInt(right.lo);
  return leftLo < rightLo ? -1 : leftLo > rightLo ? 1 : 0;
}

function incrementNat(value: CanonicalNat64): CanonicalNat64 {
  return (BigInt(value) + 1n).toString() as CanonicalNat64;
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index]);
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cancelled(): Error {
  return Object.assign(new Error("cancelled"), { code: "cancelled" });
}

function idCollision(): FilesTransferEngineFault {
  return new FilesTransferEngineFault(
    "conflict",
    "synthetic deterministic ID collision",
    { rejectionReason: "id_collision" },
  );
}

async function drainMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Timed out waiting for synthetic Files operation");
}
