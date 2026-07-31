import { expect, test } from "bun:test";
import type {
  ExposedToolOptions,
  JsonObject,
  JsonValue,
  MsgBusToolContext,
} from "neutron-tools/app";
import type {
  AttachmentToolContext,
  AttachmentToolResult,
} from "neutron-tools/app_attachments";
import { appBackgroundUrl } from "neutron-tools/src/runtime.js";
import {
  FILES_TOOL_NAMES,
  FILES_SERVICE_LIMITS,
  FILES_UI_DOWNLOAD_TOOL,
  FILES_UI_TOOL,
  FILES_UI_TRANSFER_TOOL,
  FilesToolRuntime,
  type FilesResidentFilePort,
  type FilesServiceEntry,
  type FilesServiceStatus,
} from "../src/resident/index.ts";
import { parseCanonicalNat64 } from "../src/protocol/index.ts";
// @ts-ignore The browser service entrypoint is intentionally outside the
// scripts project include set; Bun executes this runtime descriptor test.
import { installFilesV2Tools, startFilesResident, type FilesToolExposure } from "../src/service.ts";

type OrdinaryHandler = (
  args: JsonObject,
  context: MsgBusToolContext,
) => JsonValue | Promise<JsonValue>;
type AttachmentHandler = (
  args: JsonObject,
  attachments: Array<{
    name: string;
    mediaType: string;
    byteLength: number;
    data: ArrayBuffer;
  }>,
  context: AttachmentToolContext,
) => AttachmentToolResult | Promise<AttachmentToolResult>;

test("runtime exposes the exact file tools, separate tile transfers, and metadata-only audit", async () => {
  const captured = captureTools();
  const port = fakePort();
  installFilesV2Tools(
    port,
    {
      installationGeneration: () => parseCanonicalNat64("7"),
      lockEpoch: () => parseCanonicalNat64("3"),
    },
    captured.exposure,
  );

  const productNames = new Set([
    ...captured.ordinary.keys(),
    ...captured.attachments.keys(),
  ]);
  expect([...productNames].sort()).toEqual(
    [
      ...FILES_TOOL_NAMES,
      FILES_UI_DOWNLOAD_TOOL,
      FILES_UI_TOOL,
      FILES_UI_TRANSFER_TOOL,
    ].sort(),
  );
  for (const name of FILES_TOOL_NAMES) expect(productNames.has(name)).toBe(true);
  expect(FILES_TOOL_NAMES).toHaveLength(12);
  expect(captured.ordinary.has(FILES_UI_TOOL)).toBe(true);
  expect(captured.attachments.has(FILES_UI_TRANSFER_TOOL)).toBe(true);
  expect(captured.attachments.has(FILES_UI_DOWNLOAD_TOOL)).toBe(true);
  expect(productNames.has("share")).toBe(false);
  expect(productNames.has("unshare")).toBe(false);
  for (const name of FILES_TOOL_NAMES) {
    const registration =
      captured.ordinary.get(name) ?? captured.attachments.get(name);
    const input = registration!.options.inputSchema as JsonObject;
    expect((input.properties as JsonObject).rootMode).toBeUndefined();
    const modelContract = JSON.stringify(registration!.options);
    expect(modelContract).toContain("/Workspace");
    expect(modelContract).not.toContain("rootMode");
    expect(modelContract).not.toContain("legacy");
    expect(modelContract).not.toContain("transferId");
    expect(
      registration!.options.annotations?.["neutron:visibility"],
    ).toBeUndefined();
  }
  const uiInput = captured.ordinary.get(FILES_UI_TOOL)!.options
    .inputSchema as JsonObject;
  const uiProperties = uiInput.properties as JsonObject;
  expect((uiProperties.action as JsonObject).enum).toEqual([
    "status",
    "initialize",
    "unlock",
    "lock",
    "rotate",
    "upload_begin",
    "cancel",
    "retry",
  ]);
  expect(
    captured.ordinary.get(FILES_UI_TOOL)!.options.annotations?.[
      "neutron:visibility"
    ],
  ).toBe("same_app");
  expect(
    captured.attachments.get(FILES_UI_TRANSFER_TOOL)!.options.annotations?.[
      "neutron:visibility"
    ],
  ).toBe("same_app");
  expect(
    captured.attachments.get(FILES_UI_DOWNLOAD_TOOL)!.options.annotations?.[
      "neutron:visibility"
    ],
  ).toBe("same_app");
  expect((uiProperties.size as JsonObject).maximum).toBe(
    FILES_SERVICE_LIMITS.tileBinaryBytes,
  );
  const transferInput = captured.attachments.get(FILES_UI_TRANSFER_TOOL)!
    .options.inputSchema as JsonObject;
  const transferProperties = transferInput.properties as JsonObject;
  expect((transferProperties.totalBytes as JsonObject).maximum).toBe(
    FILES_SERVICE_LIMITS.tileBinaryBytes,
  );
  const download = captured.attachments.get(FILES_UI_DOWNLOAD_TOOL)!;
  const downloadAttachments = (
    download.options as unknown as {
      attachments?: { output?: { maxBytes?: number } };
    }
  ).attachments;
  expect(downloadAttachments?.output?.maxBytes).toBe(
    FILES_SERVICE_LIMITS.tileChunkBytes,
  );

  for (const registration of [
    ...captured.ordinary.values(),
    ...captured.attachments.values(),
  ]) {
    expect(registration.options.annotations?.["neutron:audit"]).toBe(
      "metadata_only",
    );
  }

  const ordinaryContext = toolContext();
  for (const [name, args] of [
    ["list", { path: "/" }],
    ["read", { path: "/note.txt" }],
    ["write", { path: "/note.txt", content: "next" }],
    ["append", { path: "/note.txt", content: "tail" }],
    [
      "patch",
      {
        path: "/note.txt",
        oldText: "hello",
        newText: "next",
      },
    ],
    ["move", { from: "/note.txt", to: "/moved.txt" }],
    ["remove", { path: "/note.txt" }],
  ] as const) {
    const registration = captured.ordinary.get(name)!;
    expect(JSON.stringify(registration.options.outputSchema)).not.toContain(
      '"allOf"',
    );
    const result = await registration.handler(args, ordinaryContext);
    validateSchema(registration.options.outputSchema!, result, name);
    expect(JSON.stringify(result)).not.toContain("opaqueNodeIdentity");
    expect(JSON.stringify(result)).not.toContain("vault-secret-node-id");
    expect(JSON.stringify(result)).not.toContain('"nodeId"');
    expect(JSON.stringify(result)).not.toContain('"etagSha256"');
    expect(JSON.stringify(result)).not.toContain('"size"');
  }

  const readBinary = captured.attachments.get("readBinary")!;
  const binary = await readBinary.handler(
    { path: "/note.txt" },
    [],
    attachmentContext(),
  );
  validateSchema(
    readBinary.options.outputSchema!,
    binary.value,
    "readBinary",
  );
  expect(binary.attachments?.[0]?.byteLength).toBe(5);
  expect(binary.attachments?.[0]?.mediaType).toBe(
    "application/octet-stream",
  );
});

test("tile upload setup accepts the full private-file quota", async () => {
  const captured = captureTools();
  installFilesV2Tools(
    fakePort(),
    {
      installationGeneration: () => parseCanonicalNat64("7"),
      lockEpoch: () => parseCanonicalNat64("3"),
    },
    captured.exposure,
  );
  const upload = captured.ordinary.get(FILES_UI_TOOL)!;
  const context = callerContext("files", "tile", "session-1");
  await expect(
    upload.handler(
      {
        action: "upload_begin",
        transferId: "large_private_upload",
        path: "/large.bin",
        name: "large.bin",
        mediaType: "application/octet-stream",
        size: 17 * 1024 * 1024,
        contentKind: "binary",
      },
      context,
    ),
  ).resolves.toBeDefined();
  await expect(
    upload.handler(
      {
        action: "upload_begin",
        transferId: "oversized_private_upload",
        path: "/too-large.bin",
        name: "too-large.bin",
        mediaType: "application/octet-stream",
        size: FILES_SERVICE_LIMITS.tileBinaryBytes + 1,
        contentKind: "binary",
      },
      context,
    ),
  ).rejects.toThrow("Invalid Files streaming upload request");
});

test("Workspace is the default and Shared publication requires Files or Agent Mode", async () => {
  const captured = captureTools();
  installFilesV2Tools(
    fakePort(),
    {
      installationGeneration: () => parseCanonicalNat64("7"),
      lockEpoch: () => parseCanonicalNat64("3"),
    },
    captured.exposure,
  );
  const app = callerContext("spreadsheet", "background", "app-session");
  const agent = {
    ...callerContext("agent", "background", "agent-session"),
    agentMode: true,
  };
  const tile = callerContext("files", "tile", "tile-session");

  await expect(
    captured.ordinary.get("write")!.handler(
      { path: "/report.txt", content: "workspace file" },
      app,
    ),
  ).resolves.toMatchObject({
    path: "/Workspace/report.txt",
  });
  await expect(
    captured.ordinary.get("write")!.handler(
      { path: "/Shared/report.txt", content: "public" },
      app,
    ),
  ).rejects.toMatchObject({
    code: "invalid",
    message: "Publishing files in Shared requires Files or Agent Mode",
  });
  await expect(
    captured.ordinary.get("move")!.handler(
      {
        from: "/Workspace/report.txt",
        to: "/Shared/report.txt",
      },
      app,
    ),
  ).rejects.toMatchObject({
    code: "invalid",
  });
  await expect(
    captured.ordinary.get("write")!.handler(
      { path: "/Shared/agent.html", content: "public" },
      agent,
    ),
  ).resolves.toMatchObject({
    path: "/Shared/agent.html",
  });
  await expect(
    captured.ordinary.get("write")!.handler(
      { path: "/Shared/report.txt", content: "public" },
      tile,
    ),
  ).resolves.toMatchObject({
    path: "/Shared/report.txt",
  });
});

test("tile upload chunks accept files beyond the app attachment limit", async () => {
  const captured = captureTools();
  installFilesV2Tools(
    fakePort(),
    {
      installationGeneration: () => parseCanonicalNat64("7"),
      lockEpoch: () => parseCanonicalNat64("3"),
    },
    captured.exposure,
  );
  const transfer = captured.attachments.get(FILES_UI_TRANSFER_TOOL)!;
  const attachment = [{
    name: "file",
    mediaType: "application/octet-stream",
    byteLength: 1,
    data: new Uint8Array([1]).buffer,
  }];
  await expect(
    transfer.handler(
      {
        transferId: "large_private_upload",
        pass: "hash",
        ordinal: 0,
        final: false,
        totalBytes: 17 * 1024 * 1024,
      },
      attachment,
      attachmentContext(),
    ),
  ).resolves.toMatchObject({
    value: {
      transferId: "large_private_upload",
      totalBytes: 17 * 1024 * 1024,
    },
  });
  await expect(
    transfer.handler(
      {
        transferId: "oversized_private_upload",
        pass: "hash",
        ordinal: 0,
        final: false,
        totalBytes: FILES_SERVICE_LIMITS.tileBinaryBytes + 1,
      },
      attachment,
      attachmentContext(),
    ),
  ).rejects.toThrow("totalBytes is outside its allowed range");
});

test("tile downloads read once and emit exact etag-bound chunks before wiping", async () => {
  const captured = captureTools();
  const base = fakePort();
  const bytes = new Uint8Array(FILES_SERVICE_LIMITS.tileChunkBytes + 3);
  bytes.fill(7);
  const entry = {
    ...fileEntry(),
    path: "/Workspace/large.bin",
    name: "large.bin",
    contentKind: "binary" as const,
    byteLength: bytes.byteLength,
    mediaType: "image/png",
    etagSha256: "a".repeat(64),
  };
  let reads = 0;
  installFilesV2Tools(
    {
      ...base,
      async stat(path) {
        expect(path).toBe(entry.path);
        return entry;
      },
      async read(path) {
        reads += 1;
        expect(path).toBe(entry.path);
        return { entry, bytes };
      },
    },
    {
      installationGeneration: () => parseCanonicalNat64("7"),
      lockEpoch: () => parseCanonicalNat64("3"),
    },
    captured.exposure,
  );
  const download = captured.attachments.get(FILES_UI_DOWNLOAD_TOOL)!;
  const args = {
    transferId: "download_1",
    path: entry.path,
    etag: entry.etagSha256,
  };
  const first = await download.handler(
    { ...args, ordinal: 0 },
    [],
    attachmentContext(),
  );
  expect(first.value).toMatchObject({
    ...args,
    ordinal: 0,
    processedBytes: FILES_SERVICE_LIMITS.tileChunkBytes,
    totalBytes: bytes.byteLength,
    final: false,
  });
  expect(first.attachments?.[0]).toMatchObject({
    mediaType: "application/octet-stream",
    byteLength: FILES_SERVICE_LIMITS.tileChunkBytes,
  });
  const firstReplay = await download.handler(
    { ...args, ordinal: 0 },
    [],
    attachmentContext(),
  );
  expect(firstReplay.value).toEqual(first.value);
  expect(firstReplay.attachments?.[0]?.byteLength).toBe(
    FILES_SERVICE_LIMITS.tileChunkBytes,
  );
  expect(reads).toBe(1);
  const final = await download.handler(
    { ...args, ordinal: 1 },
    [],
    attachmentContext(),
  );
  expect(final.value).toMatchObject({
    ...args,
    ordinal: 1,
    processedBytes: bytes.byteLength,
    final: true,
  });
  expect(final.attachments?.[0]?.byteLength).toBe(3);
  expect(bytes.every((byte) => byte === 0)).toBe(true);
  expect(reads).toBe(1);
  const replay = await download.handler(
    { ...args, ordinal: 1 },
    [],
    attachmentContext(),
  );
  expect(replay.value).toEqual(final.value);
  expect(
    [...new Uint8Array(replay.attachments?.[0]?.data ?? new ArrayBuffer(0))],
  ).toEqual([7, 7, 7]);
  expect(reads).toBe(1);
  await captured.ordinary.get(FILES_UI_TOOL)!.handler(
    { action: "cancel", transferId: args.transferId },
    toolContext(),
  );
  await expect(
    download.handler(
      { ...args, ordinal: 1 },
      [],
      attachmentContext(),
    ),
  ).rejects.toThrow("not active");
});

test("competing downloads cannot evict active bytes and completed receipts do not block their owner", async () => {
  const captured = captureTools();
  const base = fakePort();
  const entry = {
    ...fileEntry(),
    path: "/Workspace/two.bin",
    name: "two.bin",
    contentKind: "binary" as const,
    byteLength: FILES_SERVICE_LIMITS.tileChunkBytes + 1,
    mediaType: "application/zip",
    etagSha256: "b".repeat(64),
  };
  let residentBytes = new Uint8Array();
  installFilesV2Tools(
    {
      ...base,
      async stat() {
        return entry;
      },
      async read() {
        residentBytes = new Uint8Array(entry.byteLength);
        residentBytes.fill(7);
        return {
          entry,
          bytes: residentBytes,
        };
      },
    },
    {
      installationGeneration: () => parseCanonicalNat64("7"),
      lockEpoch: () => parseCanonicalNat64("3"),
    },
    captured.exposure,
  );
  const download = captured.attachments.get(FILES_UI_DOWNLOAD_TOOL)!;
  const args = {
    transferId: "download_2",
    path: entry.path,
    etag: entry.etagSha256,
  };
  await download.handler(
    { ...args, ordinal: 0 },
    [],
    attachmentContext(),
  );
  await expect(
    download.handler(
      { ...args, path: "/Workspace/other.bin", ordinal: 1 },
      [],
      attachmentContext(),
    ),
  ).rejects.toThrow("binding does not match");
  expect(residentBytes[0]).toBe(7);
  await expect(
    download.handler(
      {
        ...args,
        transferId: "competing_download",
        ordinal: 0,
      },
      [],
      attachmentContext(),
    ),
  ).rejects.toMatchObject({ code: "busy" });
  expect(residentBytes[0]).toBe(7);
  await expect(
    download.handler(
      {
        ...args,
        transferId: "other_session_download",
        ordinal: 0,
      },
      [],
      attachmentCallerContext("files", "tile", "session-2"),
    ),
  ).rejects.toMatchObject({ code: "busy" });
  expect(residentBytes[0]).toBe(7);
  await download.handler(
    { ...args, ordinal: 1 },
    [],
    attachmentContext(),
  );
  expect(residentBytes.every((byte) => byte === 0)).toBe(true);

  // A completed receipt is not active plaintext and must not block its owner
  // from immediately starting another transfer.
  await download.handler(
    { ...args, transferId: "download_3", ordinal: 0 },
    [],
    attachmentContext(),
  );
  await captured.ordinary.get(FILES_UI_TOOL)!.handler(
    { action: "cancel", transferId: "download_3" },
    toolContext(),
  );
  expect(residentBytes.every((byte) => byte === 0)).toBe(true);
  await expect(
    download.handler(
      { ...args, transferId: "download_3", ordinal: 1 },
      [],
      attachmentContext(),
    ),
  ).rejects.toThrow("not active");
});

test("a staged download binds equivalent default-Workspace spellings", async () => {
  const base = fakePort();
  const entry = {
    ...fileEntry(),
    path: "/Workspace/routed.bin",
    name: "routed.bin",
    contentKind: "binary" as const,
    byteLength: FILES_SERVICE_LIMITS.tileChunkBytes + 1,
    mediaType: "application/octet-stream",
    etagSha256: "f".repeat(64),
  };
  const residentBytes = new Uint8Array(entry.byteLength).fill(9);
  const runtime = new FilesToolRuntime({
    ...base,
    async stat() {
      return entry;
    },
    async read() {
      return { entry, bytes: residentBytes };
    },
  }, {
    installationGeneration: () => parseCanonicalNat64("7"),
    lockEpoch: () => parseCanonicalNat64("3"),
  });
  const invocation = {
    callerEndpoint: "app:spreadsheet:background:test",
    callerSession: "same-session",
    callerAppId: "spreadsheet",
    callerRole: "background",
  };
  const args = {
    transferId: "routing_bound_download",
    path: "/routed.bin",
    etag: entry.etagSha256,
  };

  await runtime.downloadChunk({ ...args, ordinal: 0 }, invocation);
  await runtime.downloadChunk({
    ...args,
    path: "/Workspace/routed.bin",
    ordinal: 1,
  }, invocation);
  expect(residentBytes.every((byte) => byte === 0)).toBe(true);
});

test("an inactive tile download expires and wipes its verified resident bytes", async () => {
  const base = fakePort();
  const entry = {
    ...fileEntry(),
    path: "/Vault/idle.bin",
    name: "idle.bin",
    contentKind: "binary" as const,
    byteLength: FILES_SERVICE_LIMITS.tileChunkBytes + 1,
    mediaType: "application/octet-stream",
    etagSha256: "d".repeat(64),
  };
  const residentBytes = new Uint8Array(entry.byteLength);
  residentBytes.fill(11);
  const runtime = new FilesToolRuntime(
    {
      ...base,
      async stat() {
        return entry;
      },
      async read() {
        return { entry, bytes: residentBytes };
      },
    },
    {
      installationGeneration: () => parseCanonicalNat64("7"),
      lockEpoch: () => parseCanonicalNat64("3"),
    },
    { downloadIdleMs: 5 },
  );
  const invocation = {
    callerEndpoint: "app:files:tile:test",
    callerSession: "session-1",
  };
  const args = {
    transferId: "download_idle",
    path: entry.path,
    etag: entry.etagSha256,
  };
  await runtime.downloadChunk({ ...args, ordinal: 0 }, invocation);
  expect(residentBytes[0]).toBe(11);
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(residentBytes.every((byte) => byte === 0)).toBe(true);
  await expect(
    runtime.downloadChunk({ ...args, ordinal: 1 }, invocation),
  ).rejects.toThrow("not active");
});

test("authority fencing cancels download expiry and wipes resident bytes immediately", async () => {
  const base = fakePort();
  const entry = {
    ...fileEntry(),
    path: "/Vault/fenced.bin",
    name: "fenced.bin",
    contentKind: "binary" as const,
    byteLength: FILES_SERVICE_LIMITS.tileChunkBytes + 1,
    mediaType: "application/octet-stream",
    etagSha256: "f".repeat(64),
  };
  const residentBytes = new Uint8Array(entry.byteLength);
  residentBytes.fill(12);
  const runtime = new FilesToolRuntime(
    {
      ...base,
      async stat() {
        return entry;
      },
      async read() {
        return { entry, bytes: residentBytes };
      },
    },
    {
      installationGeneration: () => parseCanonicalNat64("7"),
      lockEpoch: () => parseCanonicalNat64("3"),
    },
    { downloadIdleMs: 30_000 },
  );
  const invocation = {
    callerEndpoint: "app:files:tile:test",
    callerSession: "session-1",
  };
  const args = {
    transferId: "download_fenced",
    path: entry.path,
    etag: entry.etagSha256,
  };

  await runtime.downloadChunk({ ...args, ordinal: 0 }, invocation);
  expect(residentBytes[0]).toBe(12);
  runtime.clearContinuations();
  expect(residentBytes.every((byte) => byte === 0)).toBe(true);
  await expect(
    runtime.downloadChunk({ ...args, ordinal: 1 }, invocation),
  ).rejects.toThrow("not active");
});

test("a final response keeps only a bounded replay receipt until acknowledgement or expiry", async () => {
  const base = fakePort();
  const entry = {
    ...fileEntry(),
    path: "/Vault/final.bin",
    name: "final.bin",
    contentKind: "binary" as const,
    byteLength: 3,
    mediaType: "application/octet-stream",
    etagSha256: "e".repeat(64),
  };
  const residentBytes = new Uint8Array([4, 5, 6]);
  const runtime = new FilesToolRuntime(
    {
      ...base,
      async stat() {
        return entry;
      },
      async read() {
        return { entry, bytes: residentBytes };
      },
    },
    {
      installationGeneration: () => parseCanonicalNat64("7"),
      lockEpoch: () => parseCanonicalNat64("3"),
    },
    { downloadIdleMs: 5 },
  );
  const invocation = {
    callerEndpoint: "app:files:tile:test",
    callerSession: "session-1",
  };
  const args = {
    transferId: "download_final",
    path: entry.path,
    etag: entry.etagSha256,
    ordinal: 0,
  };
  const final = await runtime.downloadChunk(args, invocation);
  expect([...residentBytes]).toEqual([0, 0, 0]);
  const replay = await runtime.downloadChunk(args, invocation);
  expect([...new Uint8Array(replay.data)]).toEqual([4, 5, 6]);
  expect(replay.value).toEqual(final.value);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await expect(
    runtime.downloadChunk({ ...args, ordinal: 1 }, invocation),
  ).rejects.toThrow("not active");
});

test("text reads reject binary and oversized metadata before fetching a body", async () => {
  const base = fakePort();
  let reads = 0;
  const runtime = new FilesToolRuntime(
    {
      ...base,
      async stat(path) {
        return {
          ...fileEntry(),
          path,
          name: path.slice(path.lastIndexOf("/") + 1),
          contentKind: path.endsWith("binary.txt") ? "binary" : "text",
          byteLength: path.endsWith("binary.txt")
            ? 5
            : FILES_SERVICE_LIMITS.textBytes + 1,
        };
      },
      async read() {
        reads += 1;
        return {
          entry: fileEntry(),
          bytes: new Uint8Array(),
        };
      },
    },
    {
      installationGeneration: () => parseCanonicalNat64("7"),
      lockEpoch: () => parseCanonicalNat64("3"),
    },
  );
  const invocation = {
    callerEndpoint: "app:files:tile:test",
    callerSession: "session-1",
  };
  await expect(
    runtime.read({ path: "/Workspace/binary.txt" }, invocation),
  ).rejects.toMatchObject({ code: "not_text" });
  await expect(
    runtime.read({ path: "/Workspace/oversized.txt" }, invocation),
  ).rejects.toMatchObject({ code: "limit" });
  expect(reads).toBe(0);
});

test("tile status requests current resident state without retired share options", async () => {
  const base = fakePort();
  let statusCalls = 0;
  const runtime = new FilesToolRuntime(
    {
      ...base,
      async status() {
        statusCalls += 1;
        return readyStatus();
      },
    },
    {
      installationGeneration: () => parseCanonicalNat64("7"),
      lockEpoch: () => parseCanonicalNat64("3"),
    },
  );
  await runtime.ui(
    { action: "status" },
    {
      callerEndpoint: "app:files:tile:test",
      callerSession: "session-1",
    },
  );
  expect(statusCalls).toBe(1);
});

test("tile controls reject foreign, background, agent, and sessionless callers", async () => {
  const captured = captureTools();
  installFilesV2Tools(
    fakePort(),
    {
      installationGeneration: () => parseCanonicalNat64("7"),
      lockEpoch: () => parseCanonicalNat64("3"),
    },
    captured.exposure,
  );
  const status = captured.ordinary.get(FILES_UI_TOOL)!;
  for (const context of [
    callerContext("mail", "tile", "session-1"),
    callerContext("files", "background", "session-1"),
    callerContext("agent-runner", "background", "agent-session"),
    callerContext("files", "tile", ""),
  ]) {
    await expect(status.handler({ action: "status" }, context)).rejects
      .toThrow("kernel-attested Files tile session");
  }

  const transfer = captured.attachments.get(FILES_UI_TRANSFER_TOOL)!;
  await expect(
    transfer.handler(
      {
        transferId: "upload_1",
        pass: "hash",
        ordinal: 0,
        final: true,
        totalBytes: 0,
      },
      [],
      attachmentCallerContext("mail", "tile", "session-1"),
    ),
  ).rejects.toThrow("kernel-attested Files tile session");
  const download = captured.attachments.get(FILES_UI_DOWNLOAD_TOOL)!;
  await expect(
    download.handler(
      {
        transferId: "download_1",
        path: "/Workspace/note.txt",
        ordinal: 0,
        etag: "a".repeat(64),
      },
      [],
      attachmentCallerContext("mail", "tile", "session-1"),
    ),
  ).rejects.toThrow("kernel-attested Files tile session");
});

test("explicit lock fences a continuation issued by an already-running list", async () => {
  let releaseList!: () => void;
  const listGate = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  const base = fakePort();
  const port = {
    ...base,
    async list() {
      await listGate;
      return {
        path: "/",
        folderRevision: parseCanonicalNat64("1"),
        entries: [fileEntry()],
        total: 2,
        cursor: 1,
        hasMore: true,
      };
    },
  } as FilesResidentFilePort<number>;
  const runtime = new FilesToolRuntime<number>(port, {
    installationGeneration: () => parseCanonicalNat64("7"),
    lockEpoch: () => parseCanonicalNat64("3"),
  });
  const invocation = {
    callerEndpoint: "files",
    callerSession: "tile-session",
  };

  const pendingList = runtime.list(
    { path: "/", limit: 1 },
    invocation,
  );
  await Promise.resolve();
  await runtime.ui({ action: "lock" }, invocation);
  releaseList();
  await expect(pendingList).rejects.toMatchObject({
    code: "cancelled",
  });
  await expect(runtime.list(
    {
      path: "/",
      limit: 1,
      cursor: "0".repeat(64),
    },
    invocation,
  )).rejects.toMatchObject({
    code: "cursor_expired",
  });
});

test("home listing defaults to Workspace and keeps cursors caller-scoped", async () => {
  type ListInput = Parameters<FilesResidentFilePort<number>["list"]>[0];
  const calls: ListInput[] = [];
  const base = fakePort();
  const port = {
    ...base,
    async list(input: ListInput) {
      calls.push(input);
      const hasMore = calls.length <= 2;
      return {
        path: input.path,
        folderRevision: parseCanonicalNat64("1"),
        entries: [],
        total: hasMore ? 2 : 0,
        cursor: hasMore ? calls.length : null,
        hasMore,
      };
    },
  } as FilesResidentFilePort<number>;
  const runtime = new FilesToolRuntime<number>(port, {
    installationGeneration: () => parseCanonicalNat64("7"),
    lockEpoch: () => parseCanonicalNat64("3"),
  });
  const appInvocation = {
    callerEndpoint: "same-attested-endpoint",
    callerSession: "same-session",
    callerAppId: "spreadsheet",
    callerRole: "background",
  };
  const filesTileInvocation = {
    ...appInvocation,
    callerAppId: "files",
    callerRole: "tile",
  };

  const first = await runtime.list({}, appInvocation);
  expect(calls[0]).toMatchObject({
    path: "/Workspace",
  });
  expect(calls[0]?.routing?.mode).toBe("policy_v3");
  expect(typeof first.cursor).toBe("string");
  if (typeof first.cursor !== "string") {
    throw new Error("Expected a scoped Files continuation");
  }

  await expect(runtime.list(
    { path: "/", cursor: first.cursor },
    filesTileInvocation,
  )).rejects.toMatchObject({
    code: "cursor_expired",
  });
  expect(calls).toHaveLength(1);

  const continued = await runtime.list(
    { path: "/", cursor: first.cursor },
    appInvocation,
  );
  expect(calls[1]).toMatchObject({
    path: "/Workspace",
  });
  expect(calls[1]?.routing?.mode).toBe("policy_v3");
  expect(continued.path).toBe("/Workspace");
});

test("every ordinary path tool uses policy roots and defaults unrooted paths to Workspace", async () => {
  const modes: string[] = [];
  const paths: string[] = [];
  const base = fakePort();
  const port: FilesResidentFilePort<never> = {
    ...base,
    async list(input) {
      modes.push(input.routing?.mode ?? "missing");
      return {
        path: input.path,
        folderRevision: parseCanonicalNat64("1"),
        entries: [],
        total: 0,
        cursor: null,
        hasMore: false,
      };
    },
    async stat(path, signal, routing) {
      modes.push(routing?.mode ?? "missing");
      paths.push(path);
      return base.stat(path, signal, routing);
    },
    async read(path, controls, routing) {
      modes.push(routing?.mode ?? "missing");
      paths.push(path);
      return base.read(path, controls, routing);
    },
    async write(input, controls, routing) {
      modes.push(routing?.mode ?? "missing");
      paths.push(input.path);
      return base.write(input, controls, routing);
    },
    async writeMany(input, controls, routing) {
      modes.push(routing?.mode ?? "missing");
      paths.push(...input.map((file) => file.path));
      return base.writeMany(input, controls, routing);
    },
    async mkdir(path, recursive, signal, routing) {
      modes.push(routing?.mode ?? "missing");
      paths.push(path);
      return base.mkdir(path, recursive, signal, routing);
    },
    async move(from, to, overwrite, signal, routing) {
      modes.push(routing?.mode ?? "missing");
      paths.push(from, to);
      return base.move(from, to, overwrite, signal, routing);
    },
    async remove(path, recursive, signal, precondition, routing) {
      modes.push(routing?.mode ?? "missing");
      paths.push(path);
      return base.remove(path, recursive, signal, precondition, routing);
    },
  };
  const runtime = new FilesToolRuntime(port, {
    installationGeneration: () => parseCanonicalNat64("7"),
    lockEpoch: () => parseCanonicalNat64("3"),
  });
  const invocation = {
    callerEndpoint: "app:spreadsheet:background:test",
    callerSession: "agent-session",
    callerAppId: "spreadsheet",
    callerRole: "background",
  };

  async function exercise() {
    await runtime.list({}, invocation);
    await runtime.stat({ path: "/note.txt" }, invocation);
    await runtime.read({ path: "/note.txt" }, invocation);
    await runtime.readBinary(
      { path: "/note.txt" },
      invocation,
    );
    await runtime.write({
      path: "/note.txt",
      content: "hello",
    }, invocation);
    await runtime.writeBinary(
      {
        path: "/blob.bin",
        mediaType: "application/octet-stream",
      },
      new Uint8Array([1]).buffer,
      "application/octet-stream",
      invocation,
    );
    await runtime.writeMany({
      files: [{ path: "/a.txt", content: "a" }],
    }, invocation);
    await runtime.append({
      path: "/note.txt",
      content: "tail",
    }, invocation);
    await runtime.patch({
      path: "/note.txt",
      oldText: "hello",
      newText: "next",
    }, invocation);
    await runtime.mkdir({
      path: "/folder",
    }, invocation);
    await runtime.move({
      from: "/a.txt",
      to: "/b.txt",
    }, invocation);
    await runtime.remove({
      path: "/b.txt",
    }, invocation);
  }

  await exercise();
  expect(modes).toHaveLength(18);
  expect(new Set(modes)).toEqual(new Set(["policy_v3"]));
  expect(paths.length).toBeGreaterThan(0);
  expect(paths.every((path) => path.startsWith("/Workspace"))).toBe(true);
});

test("default resident binding purges on authority change and shutdown", async () => {
  const captured = captureTools();
  const port = fakePort();
  const controller = startFilesResident(port, {
    environment: { credentialless: false },
    href: bindingUrl("7", "3"),
    exposure: captured.exposure,
  });
  expect(captured.ordinary.has(FILES_UI_TOOL)).toBe(true);
  expect(captured.ordinary.has("write")).toBe(true);
  await Promise.resolve();
  const afterStart = port.events.length;
  expect(afterStart).toBeGreaterThan(0);

  controller.refreshAuthority(bindingUrl("8", "4"));
  await Promise.resolve();
  expect(String(controller.binding()?.installationUid)).toBe("8");
  expect(port.events.length).toBeGreaterThan(afterStart);

  const publicationsBeforeStateChange = captured.published.length;
  port.triggerStatus("state_changed");
  await Promise.resolve();
  expect(captured.published).toHaveLength(
    publicationsBeforeStateChange + 1,
  );

  const publicationsBeforeLock = captured.published.length;
  const clearsBeforeLock = port.events.filter((event) => event === "clear")
    .length;
  port.triggerLock("worker_failure");
  port.triggerStatus("worker_failure");
  await Promise.resolve();
  expect(
    port.events.filter((event) => event === "clear").length,
  ).toBe(
    clearsBeforeLock + 1,
  );
  expect(captured.published).toHaveLength(publicationsBeforeLock + 1);

  const beforeShutdown = port.events.length;
  const publicationsBeforeShutdown = captured.published.length;
  controller.shutdown();
  await Promise.resolve();
  expect(port.events.length).toBeGreaterThan(beforeShutdown);
  expect(port.events).not.toContain("indexedDB");
  expect(port.events).not.toContain("localStorage");
  expect(port.events).not.toContain("caches");
  port.triggerStatus("inactivity");
  await Promise.resolve();
  expect(captured.published).toHaveLength(publicationsBeforeShutdown);
});

function captureTools() {
  const ordinary = new Map<
    string,
    { options: ExposedToolOptions; handler: OrdinaryHandler }
  >();
  const attachments = new Map<
    string,
    {
      options: ExposedToolOptions;
      handler: AttachmentHandler;
    }
  >();
  const published: string[] = [];
  const exposure = {
    expose(
      name: string,
      options: ExposedToolOptions,
      handler: OrdinaryHandler,
    ) {
      ordinary.set(name, { options, handler });
    },
    exposeAttachment(
      name: string,
      options: ExposedToolOptions,
      handler: AttachmentHandler,
    ) {
      attachments.set(name, { options, handler });
    },
    async publish(topic: string, revision: string) {
      published.push(`${topic}:${revision}`);
    },
  } as unknown as FilesToolExposure;
  return { ordinary, attachments, exposure, published };
}

function fakePort(): FilesResidentFilePort & {
  events: string[];
  triggerLock(reason: "inactivity" | "worker_failure"): void;
  triggerStatus(
    reason:
      | "inactivity"
      | "worker_failure"
      | "authority_changed"
      | "state_changed",
  ): void;
} {
  const events: string[] = [];
  const lockListeners = new Set<
    (reason?: "inactivity" | "worker_failure") => void
  >();
  const statusListeners = new Set<
    (
      reason:
        | "inactivity"
        | "worker_failure"
        | "authority_changed"
        | "state_changed",
    ) => void
  >();
  const entry = fileEntry();
  const status = readyStatus();
  return {
    events,
    triggerLock(reason) {
      for (const listener of lockListeners) listener(reason);
    },
    triggerStatus(reason) {
      for (const listener of statusListeners) listener(reason);
    },
    onLock(listener) {
      lockListeners.add(listener);
      return () => lockListeners.delete(listener);
    },
    onStatusChange(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    async status() {
      return status;
    },
    async initialize() {
      return status;
    },
    async unlock() {
      return status;
    },
    async lock() {
      events.push("lock");
      return { ...status, vault: "locked" };
    },
    async rotate() {
      return status;
    },
    async list() {
      return {
        path: "/",
        folderRevision: parseCanonicalNat64("1"),
        entries: [entry],
        total: 1,
        cursor: null,
        hasMore: false,
      };
    },
    async stat() {
      return entry;
    },
    async read() {
      return { entry, bytes: new TextEncoder().encode("hello") };
    },
    async write(input) {
      return {
        entry: {
          ...entry,
          path: input.path,
          name: input.path.slice(input.path.lastIndexOf("/") + 1),
        },
        cleanupPending: false,
      };
    },
    async writeMany(input) {
      return input.map((file) => ({
        entry: {
          ...entry,
          path: file.path,
          name: file.path.slice(file.path.lastIndexOf("/") + 1),
        },
        cleanupPending: false,
      }));
    },
    async mkdir(path) {
      return mutation(path);
    },
    async move(_from, to) {
      return mutation(to);
    },
    async remove(path) {
      return mutation(path);
    },
    async cancel() {
      return status;
    },
    async retry() {
      return status;
    },
    async beginUpload() {
      return { transferId: "upload_1", chunkBytes: 1_889_984 };
    },
    async uploadChunk(input) {
      return {
        transferId: input.transferId,
        phase: "committed",
        processedBytes: input.totalBytes,
        totalBytes: input.totalBytes,
        committed: input.pass === "encrypt",
        readyForUpload: input.pass === "hash",
        entry,
      };
    },
    clearVolatile() {
      events.push("clear");
    },
  };
}

function fileEntry(): FilesServiceEntry & {
  type: "file";
  byteLength: number;
} {
  return {
    path: "/note.txt",
    name: "note.txt",
    type: "file",
    nodeId: null,
    opaqueNodeIdentity: "vault-secret-node-id",
    contentKind: "text",
    byteLength: 5,
    mediaType: "text/plain;charset=utf-8",
    etagSha256:
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    createdAtNs: parseCanonicalNat64("1"),
    modifiedAtNs: parseCanonicalNat64("2"),
    structuralRevision: parseCanonicalNat64("1"),
    contentId: "00000000000000010000000000000001",
  };
}

function readyStatus(): FilesServiceStatus {
  return {
    vault: "ready",
    lockEpoch: parseCanonicalNat64("3"),
    currentGeneration: parseCanonicalNat64("1"),
    previousGeneration: null,
    rotationRequired: false,
    reason: null,
    quota: {
      nodes: parseCanonicalNat64("2"),
      plaintextBytes: parseCanonicalNat64("5"),
      ciphertextBytes: parseCanonicalNat64("21"),
      physicalBytes: parseCanonicalNat64("21"),
      cleanupJobs: 0,
    },
    publicUsage: publicUsage(),
    transfers: [],
  };
}

function publicUsage(): FilesServiceStatus["publicUsage"] {
  const n = (value: string) => parseCanonicalNat64(value);
  return {
    current: {
      liveEntries: n("1"),
      occupiedEntrySlots: n("1"),
      committedBodyBytes: n("5"),
      reservedCommittedBodyBytes: n("0"),
      reservedEntrySlots: n("0"),
      allocatedBodyBytes: n("5"),
      chargedMetadataBytes: n("64"),
      acceptedStagedBytes: n("0"),
      reservedStagedBytes: n("0"),
      detachedChargedBytes: n("0"),
      activeStages: n("0"),
      receiptLanes: n("2"),
      generalReceiptLanes: n("1"),
      reservedGeneralReceiptLanes: n("0"),
      reservedRevocationLanes: n("1"),
      filledRevocationLanes: n("0"),
      receiptNonceIndexes: n("1"),
      receiptExpiryIndexes: n("1"),
      cleanupJobs: n("0"),
    },
    manifestLimits: usageLimits(n),
    effectiveLimits: usageLimits(n),
  };
}

function usageLimits(
  n: (value: string) => ReturnType<typeof parseCanonicalNat64>,
): FilesServiceStatus["publicUsage"]["effectiveLimits"] {
  return {
    entries: n("256"),
    committedBytes: n("67108864"),
    objectBytes: n("16777216"),
    stagedBytes: n("16777216"),
    pendingStages: n("1"),
    batchOperations: n("256"),
    batchBytes: n("67108864"),
    generalReceipts: n("1024"),
    revocationLanes: n("256"),
  };
}

function mutation(path: string) {
  return {
    path,
    structuralRevision: parseCanonicalNat64("2"),
    changed: 1,
    cleanupPending: false,
  };
}

function toolContext(): MsgBusToolContext {
  return {
    caller: {
      endpoint: "app:files:tile:files:instance:test",
      appId: "files",
      role: "tile",
      sessionId: "session-1",
    },
    reportProgress() {},
    kernel: {} as MsgBusToolContext["kernel"],
  };
}

function callerContext(
  appId: string,
  role: "tile" | "background",
  sessionId: string,
): MsgBusToolContext {
  return {
    ...toolContext(),
    caller: {
      endpoint: `app:${appId}:${role}:test`,
      appId,
      role,
      sessionId,
    },
  };
}

function attachmentContext(): AttachmentToolContext {
  return {
    caller: {
      endpoint: "app:files:tile:files:instance:test",
      appId: "files",
      role: "tile",
      sessionId: "session-1",
    },
    reportProgress() {},
    callTool: async () => ({ value: {}, attachments: [] }),
  };
}

function attachmentCallerContext(
  appId: string,
  role: "tile" | "background",
  sessionId: string,
): AttachmentToolContext {
  return {
    ...attachmentContext(),
    caller: {
      endpoint: `app:${appId}:${role}:test`,
      appId,
      role,
      sessionId,
    },
  };
}

function bindingUrl(installation: string, epoch: string): string {
  return appBackgroundUrl({
    canisterId: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    appId: "files",
    path: "service.html",
    residentBinding: {
      installationUid: installation,
      mode: "persistent_dedicated_v1",
      browserOriginNonce: "cd".repeat(16),
      browserOriginAuthorityEpoch: epoch,
    },
    local: true,
  });
}

function validateSchema(
  schemaValue: JsonObject,
  value: JsonValue,
  label: string,
): void {
  if (Array.isArray(schemaValue.oneOf)) {
    const matches = schemaValue.oneOf.filter((candidate) => {
      try {
        validateSchema(candidate as JsonObject, value, label);
        return true;
      } catch {
        return false;
      }
    });
    if (matches.length !== 1) throw new Error(`${label} does not match oneOf`);
    return;
  }
  const expected = schemaValue.type;
  if (expected === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${label} is not an object`);
    }
    const object = value as JsonObject;
    const properties = (schemaValue.properties ?? {}) as JsonObject;
    for (const required of (schemaValue.required ?? []) as string[]) {
      if (!Object.hasOwn(object, required)) {
        throw new Error(`${label} is missing ${required}`);
      }
    }
    if (schemaValue.additionalProperties === false) {
      for (const key of Object.keys(object)) {
        if (!Object.hasOwn(properties, key)) {
          throw new Error(`${label} contains extra ${key}`);
        }
      }
    }
    for (const [key, child] of Object.entries(object)) {
      const childSchema = properties[key];
      if (childSchema && typeof childSchema === "object") {
        validateSchema(childSchema as JsonObject, child, `${label}.${key}`);
      }
    }
    return;
  }
  if (expected === "array") {
    if (!Array.isArray(value)) throw new Error(`${label} is not an array`);
    const items = schemaValue.items;
    if (items && typeof items === "object") {
      for (const child of value) {
        validateSchema(items as JsonObject, child, `${label}[]`);
      }
    }
    return;
  }
  if (Array.isArray(expected)) {
    const kind = value === null ? "null" : typeof value;
    const integer =
      kind === "number" &&
      Number.isSafeInteger(value) &&
      expected.includes("integer");
    if (!expected.includes(kind) && !integer) {
      throw new Error(`${label} has wrong type`);
    }
    return;
  }
  if (expected === "string" && typeof value !== "string") {
    throw new Error(`${label} is not a string`);
  }
  if (
    expected === "integer" &&
    (typeof value !== "number" || !Number.isSafeInteger(value))
  ) {
    throw new Error(`${label} is not an integer`);
  }
  if (expected === "boolean" && typeof value !== "boolean") {
    throw new Error(`${label} is not a boolean`);
  }
  if (expected === "null" && value !== null) {
    throw new Error(`${label} is not null`);
  }
}
