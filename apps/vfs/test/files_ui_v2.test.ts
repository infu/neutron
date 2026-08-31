import { expect, test } from "bun:test";
import type {
  VetKeySlotSummary,
  VetKeysLifecycleRequest,
  VetKeysLifecycleResult,
} from "neutron-tools/app";
import { FilesSerialUploadQueue } from "../src/resident/upload_queue.ts";

// Keep the browser entrypoint outside the scripts project's static module
// graph. Bun still executes these pure boundary helpers in their real module.
const FILES_TILE_ENTRYPOINT = "../src/index.tsx";
const {
  canonicalFilesMoveDestination,
  committedFilesResidentTransfer,
  authorizedFilesInternalDragSource,
  deriveFilesVaultMigrationNotice,
  derivePublicUsagePressure,
  classifyFilesError,
  errorMessage,
  FILES_UI_ROOTS,
  filesDropDestination,
  filesDropIntent,
  filesDownloadHandoffDecision,
  filesDownloadStartIsCurrent,
  filesCanonicalPublicLink,
  filesPathCanOpen,
  filesRootKind,
  flattenFilesTree,
  handoffFileToSpreadsheet,
  isFilesPublicRelativeUrl,
  isFilesAmbiguousTransferFailure,
  isFilesKnownConflictFailure,
  openFilesSpreadsheetTile,
  prepareFilesVaultLifecycle,
  readStrictTextFile,
  releaseFilesResidentDownload,
  reviewFilesUpload,
  shutdownFilesTransfers,
  shouldRetainFilesDirtyBuffer,
  shouldResetFilesSelectionAfterRevisionRestart,
  startFilesVaultRotation,
  streamFilesDownloadChunks,
  streamFilesUploadPasses,
  virtualWindow,
  wipeFilesDownloadChunks,
} = await import(FILES_TILE_ENTRYPOINT);

test("public links use the canonical Kernel origin from an isolated tile", () => {
  const canisterId = "yifcp-hp777-77774-aaacq-cai";
  const relativeUrl =
    `/app/files/_route/shares/${"a".repeat(64)}/report.txt`;
  const tileHref =
    `https://i${"34".repeat(12)}--${canisterId}.icp0.io/app/files/index.html`;

  expect(filesCanonicalPublicLink(relativeUrl, tileHref)).toBe(
    `https://${canisterId}.icp0.io${relativeUrl}`,
  );
  expect(() => filesCanonicalPublicLink(`//evil.example${relativeUrl}`, tileHref))
    .toThrow("invalid public link");
});

test("internal file moves require the live locally-issued drag token", () => {
  const live = {
    path: "/Vault/private.txt",
    token: "47d7a8a1-fc45-42db-85a5-9b17ea067d47",
  };
  expect(authorizedFilesInternalDragSource(live, live.token))
    .toBe("/Vault/private.txt");
  expect(
    authorizedFilesInternalDragSource(
      live,
      "/Vault/private.txt",
    ),
  ).toBeNull();
  expect(authorizedFilesInternalDragSource(null, live.token)).toBeNull();
});

test("technical transport and schema faults use normal Files wording", () => {
  expect(
    errorMessage(
      new Error(
        'Invalid call JSON: [{"instancePath":"/0/cursor","schemaPath":"#/cursor"}]',
      ),
    ),
  ).toBe(
    "Files received an outdated response. Refresh Files and try again.",
  );
  expect(errorMessage(new Error("Error 503 Response Verification Error")))
    .toBe("Files could not verify the server response. Try again.");
});

type FilesTileEntry = Readonly<{
  path: string;
  name: string;
  type: "file" | "folder";
  contentKind: "text" | "binary" | null;
  byteLength: number | null;
  mediaType: string | null;
  etag: string | null;
  createdAtNs: string;
  modifiedAtNs: string;
  revision: string;
  publicUrl: string | null;
}>;

type FilesTreeRow = Readonly<{
  entry: FilesTileEntry;
  level: number;
  position: number;
  setSize: number;
  ancestorContinues: readonly boolean[];
  isLastSibling: boolean;
}>;

type FilesTilePublicUsage = Readonly<{
  current: Readonly<Record<string, string>>;
  manifestLimits: Readonly<Record<string, string>>;
  effectiveLimits: Readonly<Record<string, string>>;
}>;

test("vault preparation reserves and enables only through the tile lifecycle port", async () => {
  const requests: VetKeysLifecycleRequest[] = [];
  const result = await prepareFilesVaultLifecycle({
    async list() {
      return { slots: [] };
    },
    async request(input: VetKeysLifecycleRequest) {
      requests.push(input);
      return lifecycle(
        input.action === "reserve"
          ? slot({ status: "disabled" })
          : slot({ status: "enabled" }),
      );
    },
  });
  expect(requests).toEqual([
    { action: "reserve", slot: "files_vault" },
    { action: "enable", slot: "files_vault" },
  ]);
  expect(result.status).toBe("enabled");

  await expect(
    prepareFilesVaultLifecycle({
      async list() {
        return { slots: [slot({ status: "manifest_suspended" })] };
      },
      async request() {
        throw new Error("must not request");
      },
    }),
  ).rejects.toThrow("not enabled");
});

test("rotation starts immediately and binds the exact prior generation", async () => {
  const observed: { requested: VetKeysLifecycleRequest | null } = {
    requested: null,
  };
  let resolve!: (value: VetKeysLifecycleResult) => void;
  const pending = new Promise<VetKeysLifecycleResult>((done) => {
    resolve = done;
  });
  const rotation = startFilesVaultRotation("7", {
    request(input: VetKeysLifecycleRequest) {
      observed.requested = input;
      return pending;
    },
  });
  expect(observed.requested).toEqual({
    action: "rotate",
    slot: "files_vault",
  });
  resolve(
    lifecycle(
      slot({
        currentGeneration: "8",
        previousGeneration: "7",
        status: "enabled",
      }),
    ),
  );
  expect((await rotation).currentGeneration).toBe("8");

  await expect(
    startFilesVaultRotation("7", {
      async request() {
        return lifecycle(
          slot({
            currentGeneration: "9",
            previousGeneration: "6",
            status: "enabled",
          }),
        );
      },
    }),
  ).rejects.toThrow("invalid Files key rotation");
});

test("vault migration states separate wrapper recovery from owner rotation", () => {
  expect(
    deriveFilesVaultMigrationNotice({
      vault: "locked",
      currentGeneration: "8",
      previousGeneration: "7",
      rotationRequired: true,
    }),
  ).toMatchObject({
    kind: "migration-required",
    title: "Finish security update",
    action: null,
  });
  expect(
    deriveFilesVaultMigrationNotice({
      vault: "ready",
      currentGeneration: "8",
      previousGeneration: "7",
      rotationRequired: true,
    }),
  ).toMatchObject({
    kind: "migration-required",
    action: "finish",
  });
  expect(
    deriveFilesVaultMigrationNotice({
      vault: "ready",
      currentGeneration: "8",
      previousGeneration: "7",
      rotationRequired: false,
    }),
  ).toBeNull();
  expect(
    deriveFilesVaultMigrationNotice({
      vault: "locked",
      currentGeneration: "8",
      previousGeneration: "7",
      rotationRequired: false,
    }),
  ).toBeNull();
});

test("move destinations canonicalize once and reject unsafe topology", () => {
  expect(
    canonicalFilesMoveDestination(
      "/draft.txt",
      "/Archive/Cafe\u0301.txt",
    ),
  ).toBe("/Archive/Café.txt");
  expect(() =>
    canonicalFilesMoveDestination("/draft.txt", "/draft.txt")
  ).toThrow("different destination");
  expect(() =>
    canonicalFilesMoveDestination("/Folder", "/Folder/child")
  ).toThrow("inside itself");
  expect(() =>
    canonicalFilesMoveDestination("/draft.txt", "/")
  ).toThrow("destination name");
  expect(() =>
    canonicalFilesMoveDestination("/", "/renamed")
  ).toThrow("root cannot be moved");
});

test("three fixed roots route access, flatten lazily, and validate drops", () => {
  expect(FILES_UI_ROOTS.map(
    ({ name, path }: { name: string; path: string }) => ({ name, path }),
  )).toEqual([
    { name: "Shared", path: "/Shared" },
    { name: "Vault", path: "/Vault" },
    { name: "Workspace", path: "/Workspace" },
  ]);
  expect(filesRootKind("/Shared/note.txt")).toBe("shared");
  expect(filesRootKind("/Vault/Private/book.txt")).toBe("vault");
  expect(filesRootKind("/Workspace")).toBe("workspace");
  expect(filesRootKind("/unknown")).toBeNull();
  expect(filesPathCanOpen("/Workspace/note.txt", "locked")).toBe(true);
  expect(filesPathCanOpen("/Shared/note.txt", "uninitialized")).toBe(true);
  expect(filesPathCanOpen("/Vault/note.txt", "locked")).toBe(false);
  expect(filesPathCanOpen("/Vault/note.txt", "ready")).toBe(true);

  const project = folder("/Workspace/Projects", "Projects");
  const note = {
    ...entry(),
    path: "/Workspace/Projects/note.txt",
    name: "note.txt",
    contentKind: "text" as const,
    mediaType: "text/plain;charset=utf-8",
  };
  const archive = folder("/Workspace/Archive", "Archive");
  const pages = new Map([
    ["/Workspace", page("/Workspace", [project, archive], 3)],
    ["/Workspace/Projects", page("/Workspace/Projects", [note])],
  ]);
  expect(
    flattenFilesTree(
      pages,
      new Set(["/Workspace", "/Workspace/Projects"]),
    ).map((row: FilesTreeRow) => [row.entry.path, row.level]),
  ).toEqual([
    ["/Shared", 1],
    ["/Vault", 1],
    ["/Workspace", 1],
    ["/Workspace/Projects", 2],
    ["/Workspace/Projects/note.txt", 3],
    ["/Workspace/Archive", 2],
  ]);
  expect(
    flattenFilesTree(pages, new Set()).map(
      (row: FilesTreeRow) => row.entry.path,
    ),
  )
    .toEqual(["/Shared", "/Vault", "/Workspace"]);

  const expanded = flattenFilesTree(
    pages,
    new Set(["/Workspace", "/Workspace/Projects"]),
  );
  const projectRow = expanded.find(
    (row: FilesTreeRow) => row.entry.path === project.path,
  ) as FilesTreeRow;
  const noteRow = expanded.find(
    (row: FilesTreeRow) => row.entry.path === note.path,
  ) as FilesTreeRow;
  expect(projectRow).toMatchObject({
    position: 1,
    setSize: 3,
    ancestorContinues: [],
    isLastSibling: false,
  });
  expect(noteRow).toMatchObject({
    position: 1,
    setSize: 1,
    ancestorContinues: [true],
    isLastSibling: true,
  });

  expect(
    filesDropDestination(
      "/Workspace/Projects/note.txt",
      "/Shared/Public",
    ),
  ).toBe("/Shared/Public/note.txt");
  expect(() =>
    filesDropDestination("/Workspace", "/Shared")
  ).toThrow("main folders");
  expect(() =>
    filesDropDestination("/Workspace/Projects", "/Workspace/Projects/Child")
  ).toThrow("inside itself");

  expect(
    filesDropIntent(note.path, folder("/Shared/Public", "Public"), "ready"),
  ).toMatchObject({
    ok: true,
    intent: {
      destination: "/Shared/Public/note.txt",
      sourceRoot: "workspace",
      targetRoot: "shared",
      policyChange: true,
    },
  });
  expect(
    filesDropIntent(note.path, project, "ready"),
  ).toMatchObject({ ok: false });
  expect(
    filesDropIntent(project.path, folder(
      "/Workspace/Projects/Child",
      "Child",
    ), "ready"),
  ).toMatchObject({ ok: false });
  expect(
    filesDropIntent(note.path, { ...entry(), path: "/Shared/file" }, "ready"),
  ).toMatchObject({ ok: false });
  expect(
    filesDropIntent(note.path, folder("/Vault/Private", "Private"), "locked"),
  ).toMatchObject({ ok: false });
});

test("upload review preserves capacity for valid unique files", () => {
  const review = reviewFilesUpload(
    [
      { name: " bad ", size: 1 },
      { name: "large.bin", size: 64 * 1024 * 1024 + 1 },
      { name: "report.txt", size: 5 },
      { name: "report.txt", size: 7 },
      { name: "later.txt", size: 9 },
    ],
    "/Workspace/Projects",
    99,
    "ready",
  );
  expect(review.accepted.map(
    (item: { path: string | null }) => item.path,
  )).toEqual(["/Workspace/Projects/report.txt"]);
  expect(review.items.map(
    (item: { error: string | null }) => item.error,
  )).toEqual([
    "Files cannot store this filename.",
    "This file is larger than the 64 MiB Files limit.",
    null,
    "Another staged file has the same destination name.",
    "Only 1 more file can be queued.",
  ]);
  expect(review.acceptedBytes).toBe(5);
  expect(
    reviewFilesUpload(
      [{ name: "secret.txt", size: 1 }],
      "/Vault",
      0,
      "locked",
    ).accepted,
  ).toEqual([]);
});

test("strict UTF-8 reads slices and invalid text is classified for binary fallback", async () => {
  const valid = new File(["hello"], "hello.txt", { type: "text/plain" });
  Object.defineProperty(valid, "arrayBuffer", {
    value: () => {
      throw new Error("whole File.arrayBuffer must not run");
    },
  });
  expect(
    await readStrictTextFile(valid, new AbortController().signal),
  ).toBe("hello");

  const invalid = new File(
    [new Uint8Array([0xff, 0xfe, 0x00])],
    "invalid.txt",
    { type: "text/plain" },
  );
  expect(
    await readStrictTextFile(invalid, new AbortController().signal),
  ).toBeNull();
});

test("binary upload replays identical bounded slices in two strictly serial passes", async () => {
  const file = new File(["abcde"], "bytes.bin", {
    type: "application/octet-stream",
  });
  const originalSlice = file.slice.bind(file);
  const slices: Array<[number, number]> = [];
  Object.defineProperty(file, "slice", {
    value(start: number, end: number) {
      slices.push([start, end]);
      return originalSlice(start, end);
    },
  });
  Object.defineProperty(file, "arrayBuffer", {
    value: () => {
      throw new Error("whole File.arrayBuffer must not run");
    },
  });
  const calls: string[] = [];
  let inFlight = 0;
  let maximum = 0;
  const result = await streamFilesUploadPasses(
    file,
    2,
    new AbortController().signal,
    async (chunk: {
      pass: "hash" | "encrypt";
      ordinal: number;
      final: boolean;
      data: ArrayBuffer;
    }) => {
      inFlight += 1;
      maximum = Math.max(maximum, inFlight);
      calls.push(
        `${chunk.pass}:${chunk.ordinal}:${chunk.final}:${chunk.data.byteLength}`,
      );
      await Promise.resolve();
      inFlight -= 1;
      return {
        phase: chunk.pass,
        processedBytes: chunk.data.byteLength,
        readyForUpload: chunk.pass === "hash" && chunk.final,
        committed: chunk.pass === "encrypt" && chunk.final,
      };
    },
  );
  expect(calls).toEqual([
    "hash:0:false:2",
    "hash:1:false:2",
    "hash:2:true:1",
    "encrypt:0:false:2",
    "encrypt:1:false:2",
    "encrypt:2:true:1",
  ]);
  expect(slices).toEqual([
    [0, 2],
    [2, 4],
    [4, 5],
    [0, 2],
    [2, 4],
    [4, 5],
  ]);
  expect(maximum).toBe(1);
  expect(result.committed).toBe(true);
});

test("tile downloads assemble bounded exact chunks and wipe rejected or handed-off buffers", async () => {
  const chunkBytes = 1_889_984;
  const reviewed = {
    ...entry(),
    path: "/Vault/archive.bin",
    name: "archive.bin",
    byteLength: chunkBytes + 3,
    mediaType: "application/zip",
    etag: "c".repeat(64),
  };
  const transferId = "download_1";
  const calls: number[] = [];
  const attempts = new Map<number, number>();
  const downloaded = await streamFilesDownloadChunks(
    reviewed,
    transferId,
    new AbortController().signal,
    async (ordinal: number) => {
      calls.push(ordinal);
      const attempt = (attempts.get(ordinal) ?? 0) + 1;
      attempts.set(ordinal, attempt);
      if (attempt === 1) {
        throw new Error("network response was lost");
      }
      const start = ordinal * chunkBytes;
      const size = Math.min(chunkBytes, reviewed.byteLength - start);
      const processedBytes = start + size;
      return {
        transferId,
        path: reviewed.path,
        ordinal,
        etag: reviewed.etag,
        totalBytes: reviewed.byteLength,
        processedBytes,
        final: processedBytes === reviewed.byteLength,
        entry: reviewed,
        data: new Uint8Array(size).fill(ordinal + 1).buffer,
        mediaType: "application/octet-stream",
      };
    },
  );
  expect(calls).toEqual([0, 0, 1, 1]);
  expect(downloaded.chunks.map((chunk: ArrayBuffer) => chunk.byteLength))
    .toEqual([chunkBytes, 3]);
  expect(downloaded.mediaType).toBe("application/zip");
  wipeFilesDownloadChunks(downloaded.chunks);
  expect(
    downloaded.chunks.every((chunk: ArrayBuffer) =>
      new Uint8Array(chunk).every((byte) => byte === 0)
    ),
  ).toBe(true);

  let retained: ArrayBuffer | null = null;
  await expect(
    streamFilesDownloadChunks(
      reviewed,
      "download_2",
      new AbortController().signal,
      async (ordinal: number) => {
        const size = ordinal === 0 ? chunkBytes : 3;
        const data = new Uint8Array(size).fill(9).buffer;
        if (ordinal === 0) retained = data;
        return {
          transferId: "download_2",
          path: ordinal === 0 ? reviewed.path : "/Vault/wrong.bin",
          ordinal,
          etag: reviewed.etag,
          totalBytes: reviewed.byteLength,
          processedBytes: ordinal === 0 ? chunkBytes : reviewed.byteLength,
          final: ordinal === 1,
          entry: reviewed,
          data,
          mediaType: "application/octet-stream",
        };
      },
    ),
  ).rejects.toThrow("binding is invalid");
  expect(retained).not.toBeNull();
  expect(new Uint8Array(retained!).every((byte) => byte === 0)).toBe(true);
});

test("serial upload queue keeps one task active and cancellation advances FIFO", async () => {
  const queue = new FilesSerialUploadQueue();
  const first = deferred();
  const third = deferred();
  const active: string[] = [];
  let inFlight = 0;
  let maximum = 0;
  let secondCancelled = false;
  const firstController = new AbortController();
  const secondController = new AbortController();
  const thirdController = new AbortController();
  queue.enqueue({
    id: "first",
    signal: firstController.signal,
    async run() {
      active.push("first");
      inFlight += 1;
      maximum = Math.max(maximum, inFlight);
      await first.promise;
      inFlight -= 1;
    },
  });
  queue.enqueue({
    id: "second",
    signal: secondController.signal,
    async run() {
      throw new Error("cancelled queued upload must not start");
    },
    onCancelledBeforeStart() {
      secondCancelled = true;
    },
  });
  queue.enqueue({
    id: "third",
    signal: thirdController.signal,
    async run() {
      active.push("third");
      inFlight += 1;
      maximum = Math.max(maximum, inFlight);
      await third.promise;
      inFlight -= 1;
    },
  });
  expect(queue.activeId).toBe("first");
  expect(queue.pendingCount).toBe(2);
  secondController.abort();
  expect(secondCancelled).toBe(true);
  expect(queue.pendingCount).toBe(1);
  first.resolve();
  await eventually(() => queue.activeId === "third");
  expect(active).toEqual(["first", "third"]);
  expect(maximum).toBe(1);
  third.resolve();
  await eventually(() => queue.activeId === null);
});

test("transfer shutdown aborts live work, cancels resident stages, and clears queue state", async () => {
  const queue = new FilesSerialUploadQueue();
  const controller = new AbortController();
  const controllers = new Map([["local", controller]]);
  const cancelled: string[] = [];
  shutdownFilesTransfers(
    [{ id: "local", residentId: "resident-stage" }],
    controllers,
    queue,
    async (id: string) => {
      cancelled.push(id);
    },
  );
  await Promise.resolve();
  expect(controller.signal.aborted).toBe(true);
  expect(cancelled).toEqual(["resident-stage"]);
  expect(controllers.size).toBe(0);
  expect(() =>
    queue.enqueue({
      id: "later",
      signal: new AbortController().signal,
      async run() {},
    })
  ).toThrow("closed");
});

test("Spreadsheet handoff sends the exact authenticated etag and attachment before opening", async () => {
  const reviewed = entry();
  const events: string[] = [];
  let acceptedArgs: unknown;
  let acceptedBytes: number[] = [];
  await handoffFileToSpreadsheet(reviewed, {
    async readBinary() {
      events.push("read");
      return {
        entry: reviewed,
        data: new Uint8Array([1, 2, 3]).buffer,
        mediaType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      };
    },
    async accept(
      args: Record<string, unknown>,
      attachment: { data: ArrayBuffer },
    ) {
      events.push("accept");
      acceptedArgs = args;
      acceptedBytes = [...new Uint8Array(attachment.data)];
    },
    async open() {
      events.push("open");
    },
  });
  expect(events).toEqual(["read", "accept", "open"]);
  expect(acceptedArgs).toEqual({
    path: reviewed.path,
    mediaType: reviewed.mediaType,
    etag: reviewed.etag,
  });
  expect(acceptedBytes).toEqual([1, 2, 3]);

  await expect(
    handoffFileToSpreadsheet(reviewed, {
      async readBinary() {
        return {
          entry: { ...reviewed, etag: "b".repeat(64) },
          data: new Uint8Array([1, 2, 3]).buffer,
          mediaType: reviewed.mediaType!,
        };
      },
      async accept() {
        throw new Error("must not accept stale bytes");
      },
      async open() {},
    }),
  ).rejects.toThrow("changed after review");
});

test("Spreadsheet handoff opens the installed workbook tile", async () => {
  let request: unknown = null;
  await openFilesSpreadsheetTile(async (input: unknown) => {
    request = input;
    return {
      instanceId: "spreadsheet-instance",
      workspace: 0,
      opened: true,
    };
  });
  expect(request).toEqual({
    appId: "spreadsheet",
    tileId: "workbook",
    reuseExisting: true,
  });
});

test("public links are exact local publication routes", () => {
  const publication = "a".repeat(64);
  expect(
    isFilesPublicRelativeUrl(
      `/app/files/_route/shares/${publication}/reviewed.txt`,
    ),
  ).toBe(true);
  expect(
    isFilesPublicRelativeUrl(
      `//evil.invalid/app/files/_route/shares/${publication}/reviewed.txt`,
    ),
  ).toBe(false);
  expect(
    isFilesPublicRelativeUrl(
      `/app/files/_route/shares/${publication}/reviewed.txt?next=evil`,
    ),
  ).toBe(false);
});

test("public usage derives the actual limiting effective counter", () => {
  const usage = publicUsage();
  expect(derivePublicUsagePressure(usage)).toMatchObject({
    key: "revocationLanes",
    used: "9",
    limit: "10",
    basisPoints: 9_000,
    rolling: true,
  });
});

test("virtual rows remain bounded for a large folder", () => {
  const rows = Array.from({ length: 100_000 }, (_, index) => index);
  const window = virtualWindow(rows, 38 * 50_000, 380, 38, 6);
  expect(window.items.length).toBeLessThanOrEqual(22);
  expect(window.items[0]).toBe(49_994);
  expect(window.before + window.after).toBeGreaterThan(3_000_000);
  const restarted = virtualWindow(
    rows.slice(0, 200),
    38 * 50_000,
    380,
    38,
    6,
  );
  expect(restarted.items).toHaveLength(22);
  expect(restarted.items.at(-1)).toBe(199);
});

test("folder restart preserves only a selection present in the refreshed page", () => {
  const refreshed = [{ path: "/first.txt" }, { path: "/second.txt" }];
  expect(
    shouldResetFilesSelectionAfterRevisionRestart(
      "/second.txt",
      refreshed,
    ),
  ).toBe(false);
  expect(
    shouldResetFilesSelectionAfterRevisionRestart(
      "/row-5000.txt",
      refreshed,
    ),
  ).toBe(true);
});

test("authoritative committed transfer outcomes win a local cancel", () => {
  const transfers = [{
    id: "write_1",
    label: "note.txt",
    phase: "committed",
    processedBytes: 4,
    totalBytes: 4,
    error: null,
  }];
  expect(committedFilesResidentTransfer(transfers, "write_1")).toEqual(
    transfers[0],
  );
  expect(committedFilesResidentTransfer(
    [{ ...transfers[0]!, phase: "cancelled" }],
    "write_1",
  )).toBeNull();
});

test("download response handoff has one synchronous cancel-or-commit boundary", () => {
  expect(filesDownloadHandoffDecision({
    authorityCurrent: true,
    signalAborted: true,
    controllerCurrent: false,
    transferCurrent: true,
  })).toBe("cancelled");
  expect(filesDownloadHandoffDecision({
    authorityCurrent: true,
    signalAborted: false,
    controllerCurrent: true,
    transferCurrent: true,
  })).toBe("commit");
});

test("only the latest download click may start after prior cleanup", () => {
  expect(filesDownloadStartIsCurrent({
    authorityCurrent: true,
    startEpoch: 12,
    currentEpoch: 12,
  })).toBe(true);
  expect(filesDownloadStartIsCurrent({
    authorityCurrent: true,
    startEpoch: 11,
    currentEpoch: 12,
  })).toBe(false);
  expect(filesDownloadStartIsCurrent({
    authorityCurrent: false,
    startEpoch: 12,
    currentEpoch: 12,
  })).toBe(false);
});

test("every tile download releases its resident receipt without masking cleanup failure", async () => {
  const cancelled: string[] = [];
  await releaseFilesResidentDownload(
    "download_failed",
    async (transferId: string) => {
      cancelled.push(transferId);
      throw new Error("cleanup transport failed");
    },
  );
  await releaseFilesResidentDownload(
    "download_complete",
    async (transferId: string) => {
      cancelled.push(transferId);
    },
  );
  expect(cancelled).toEqual(["download_failed", "download_complete"]);
});

test("a hung resident download release cannot block the next download", async () => {
  let attempted = false;
  let cleanupSignal: AbortSignal | null = null;
  await releaseFilesResidentDownload(
    "download_hung",
    async (_transferId: string, signal: AbortSignal) => {
      attempted = true;
      cleanupSignal = signal;
      await new Promise<never>(() => undefined);
    },
    5,
  );
  expect(attempted).toBe(true);
  expect((cleanupSignal as AbortSignal | null)?.aborted).toBe(true);
});

test("common service faults map to one concrete recovery action", () => {
  expect(classifyFilesError("cursor_expired: stale cursor")).toEqual({
    kind: "restart-folder",
    label: "Restart folder",
  });
  expect(
    classifyFilesError("Files folder changed during paging"),
  ).toEqual({
    kind: "restart-folder",
    label: "Restart folder",
  });
  expect(classifyFilesError("Private Files are locked")).toEqual({
    kind: "unlock",
    label: "Open Vault",
  });
  expect(classifyFilesError("storage quota reached")).toEqual({
    kind: "review-space",
    label: "Review files",
  });
  expect(classifyFilesError("incompatible frontend version")).toEqual({
    kind: "reload",
    label: "Reload Files",
  });
  expect(isFilesAmbiguousTransferFailure("network outcome uncertain")).toBe(
    true,
  );
  expect(isFilesAmbiguousTransferFailure("storage quota reached")).toBe(false);
  expect(isFilesAmbiguousTransferFailure("stale content conflict")).toBe(
    false,
  );
  expect(
    isFilesKnownConflictFailure(
      Object.assign(new Error("write rejected"), { code: "conflict" }),
    ),
  ).toBe(true);
  expect(isFilesKnownConflictFailure("Files path already exists")).toBe(true);
  expect(isFilesKnownConflictFailure("stale cursor")).toBe(false);
});

test("only same-authority explicit or inactivity locks retain dirty plaintext", () => {
  expect(shouldRetainFilesDirtyBuffer("inactivity", true)).toBe(true);
  expect(shouldRetainFilesDirtyBuffer("explicit", true)).toBe(true);
  expect(shouldRetainFilesDirtyBuffer("worker_failure", true)).toBe(false);
  expect(shouldRetainFilesDirtyBuffer("authority_changed", true)).toBe(false);
  expect(shouldRetainFilesDirtyBuffer(null, true)).toBe(false);
  expect(shouldRetainFilesDirtyBuffer("inactivity", false)).toBe(false);
});

function slot(
  overrides: Partial<VetKeySlotSummary> = {},
): VetKeySlotSummary {
  return {
    slot: "files_vault",
    status: "enabled",
    currentGeneration: "7",
    previousGeneration: null,
    holderPrincipal: null,
    ...overrides,
  } as VetKeySlotSummary;
}

function lifecycle(value: VetKeySlotSummary): VetKeysLifecycleResult {
  return { slot: value, retired: false };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function eventually(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error("condition did not become true");
}

function entry(): FilesTileEntry {
  return {
    path: "/book.xlsx",
    name: "book.xlsx",
    type: "file",
    contentKind: "binary",
    byteLength: 3,
    mediaType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    etag: "a".repeat(64),
    createdAtNs: "1",
    modifiedAtNs: "2",
    revision: "3",
    publicUrl: null,
  };
}

function folder(path: string, name: string): FilesTileEntry {
  return {
    path,
    name,
    type: "folder",
    contentKind: null,
    byteLength: null,
    mediaType: null,
    etag: null,
    createdAtNs: "1",
    modifiedAtNs: "1",
    revision: "1",
    publicUrl: null,
  };
}

function page(
  path: string,
  entries: readonly FilesTileEntry[],
  total = entries.length,
) {
  return {
    path,
    revision: "1",
    entries,
    loaded: entries.length,
    total,
    hasMore: total > entries.length,
    cursor: total > entries.length ? "next" : null,
  };
}

function publicUsage(): FilesTilePublicUsage {
  return {
    current: {
      liveEntries: "2",
      occupiedEntrySlots: "3",
      committedBodyBytes: "10",
      reservedCommittedBodyBytes: "0",
      reservedEntrySlots: "0",
      allocatedBodyBytes: "10",
      chargedMetadataBytes: "2",
      acceptedStagedBytes: "0",
      reservedStagedBytes: "0",
      detachedChargedBytes: "0",
      activeStages: "0",
      receiptLanes: "11",
      generalReceiptLanes: "1",
      reservedGeneralReceiptLanes: "1",
      reservedRevocationLanes: "4",
      filledRevocationLanes: "5",
      receiptNonceIndexes: "11",
      receiptExpiryIndexes: "11",
      cleanupJobs: "0",
    },
    manifestLimits: limits(),
    effectiveLimits: limits(),
  };
}

function limits() {
  return {
    entries: "100",
    committedBytes: "100",
    objectBytes: "100",
    stagedBytes: "100",
    pendingStages: "1",
    batchOperations: "10",
    batchBytes: "100",
    generalReceipts: "100",
    revocationLanes: "10",
  };
}
