import { expect, test } from "bun:test";
import type { WorkbookFilesPort, XlsxCodecPort } from "../src/file_ports.ts";
import { decodeNativeWorkbook, encodeNativeWorkbook } from "../src/formats/native.ts";
import { BrowserXlsxCodec } from "../src/formats/xlsx_adapter.ts";
import { createMemoryRecoveryPersistence } from "../src/recovery.ts";
import { WorkbookSession } from "../src/session.ts";
import { createWorkbook } from "../src/model.ts";

test("session checkpoints commands, exposes recovery, and conditionally saves native bytes", async () => {
  let saved: ArrayBuffer | null = null;
  let condition: unknown = null;
  const files: WorkbookFilesPort = {
    async readBinary() { throw new Error("not used"); },
    async writeBinary(path, mediaType, data, nextCondition) {
      saved = data;
      condition = nextCondition;
      return { path, mediaType, byteLength: data.byteLength, etag: "etag-1" };
    },
  };
  const recovery = createMemoryRecoveryPersistence();
  const session = await WorkbookSession.open({ recovery, files });
  const sheetId = session.status().sheets[0]!.id;
  await session.apply({
    expectedRevision: 0,
    commandId: "edit",
    operations: [{ type: "set_cells", sheetId, start: "A1", values: [[{ kind: "number", value: 42 }]] }],
  });
  expect(session.status().recovery.available).toBe(true);
  expect(session.status().dirty).toBe(true);

  const result = await session.saveNative({ expectedRevision: 1, commandId: "save-answer", path: "/answer.nsheet" });
  expect(result.dirty).toBe(false);
  expect(condition).toEqual({ ifNoneMatch: "*" });
  expect(decodeNativeWorkbook(saved!).sheets[0]!.cells.A1!.input).toEqual({ kind: "number", value: 42 });
  expect(session.status().recovery.available).toBe(false);
});

test("CSV file acceptance is an unsaved import and dirty replacement is guarded", async () => {
  const session = await WorkbookSession.open({ recovery: createMemoryRecoveryPersistence() });
  await session.acceptFile(await acceptedFile(
    "/data.csv",
    "text/csv",
    new TextEncoder().encode("id,value\r\n001,2\r\n").buffer,
  ));
  expect(session.status()).toMatchObject({ dirty: true, nativeSource: null, importProvenance: { format: "csv" } });
  await expect(session.acceptFile(await acceptedFile(
    "/other.csv",
    "text/csv",
    new TextEncoder().encode("other\r\n").buffer,
  ))).rejects.toThrow("explicitly discard");
});

test("session replacements advance the resident revision monotonically", async () => {
  const session = await WorkbookSession.open({ recovery: createMemoryRecoveryPersistence() });
  const revisions: number[] = [];
  session.subscribe((status) => revisions.push(status.revision));
  const sheetId = session.status().sheets[0]!.id;
  await session.apply({
    expectedRevision: 0,
    commandId: "before-replace",
    operations: [{ type: "set_cells", sheetId, start: "A1", values: [[{ kind: "number", value: 1 }]] }],
  });
  await session.acceptFile(await acceptedFile(
    "/replacement.csv",
    "text/csv",
    new TextEncoder().encode("new\r\n").buffer,
  ), { discardDirty: true });
  expect(revisions).toEqual([1, 2]);
  await session.newWorkbook({ expectedRevision: 2, commandId: "new-after-import", discardDirty: true });
  expect(session.status()).toMatchObject({ revision: 3, dirty: false, nativeSource: null });
});

test("Kitchen Sink is an explicit dirty session replacement shared by UI and agents", async () => {
  const recovery = createMemoryRecoveryPersistence();
  const session = await WorkbookSession.open({ recovery });
  const result = await session.loadDemo({ expectedRevision: 0, commandId: "load-demo" });
  expect(result).toMatchObject({ revision: 1, dirty: true, nativeSource: null });
  expect(result.sheets.map((sheet) => sheet.name)).toEqual([
    "Read me", "Sales", "Summary", "Inventory", "Formats", "Formula gallery",
  ]);
  expect(recovery.current()?.workbook.workbookId).toBe("wb_neutron_spreadsheet_kitchen_sink");
  await expect(session.loadDemo({ expectedRevision: 1, commandId: "replace-dirty-demo" }))
    .rejects.toMatchObject({ code: "DIRTY_WORKBOOK" });
  const replaced = await session.loadDemo({ expectedRevision: 1, commandId: "replace-dirty-demo-explicit", discardDirty: true });
  expect(replaced).toMatchObject({ revision: 2, dirty: true });
});

test("invalid CSV candidates fail atomically before replacing the live workbook", async () => {
  const session = await WorkbookSession.open({ recovery: createMemoryRecoveryPersistence() });
  const before = session.status();
  const oversizedField = "x".repeat(32_769);
  await expect(session.acceptFile(await acceptedFile(
    "/oversized.csv",
    "text/csv",
    new TextEncoder().encode(oversizedField).buffer,
  ))).rejects.toThrow("Invalid tagged cell input");
  expect(session.status()).toMatchObject({
    workbookId: before.workbookId,
    revision: before.revision,
    dirty: false,
  });
});

test("invalid XLSX adapter candidates fail canonical validation atomically", async () => {
  const invalid = createWorkbook();
  invalid.sheets[0]!.cells.A1 = { input: { kind: "number", value: Number.POSITIVE_INFINITY } };
  const xlsx: XlsxCodecPort = {
    async import() { return { workbook: invalid, warnings: [] }; },
    async export() { throw new Error("not used"); },
  };
  const session = await WorkbookSession.open({ recovery: createMemoryRecoveryPersistence(), xlsx });
  const before = session.status();
  await expect(session.acceptFile(await acceptedFile(
    "/invalid.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    new ArrayBuffer(0),
  ))).rejects.toThrow("Invalid tagged cell input");
  expect(session.status()).toMatchObject({ workbookId: before.workbookId, revision: before.revision, dirty: false });
});

test("Files handoffs reject forged or contradictory metadata atomically", async () => {
  const session = await WorkbookSession.open({ recovery: createMemoryRecoveryPersistence() });
  const before = session.status();
  const valid = await acceptedFile(
    "/verified.csv",
    "text/csv",
    new TextEncoder().encode("name,value\r\nAda,42\r\n").buffer,
  );
  const invalid = [
    { ...valid, etag: "0".repeat(64) },
    { ...valid, etag: valid.etag.toUpperCase() },
    { ...valid, mediaType: "application/vnd.neutron.spreadsheet+json" },
    { ...valid, attachmentMediaType: "application/vnd.neutron.spreadsheet+json" },
    { ...valid, byteLength: valid.data.byteLength + 1 },
  ];

  for (const candidate of invalid) {
    await expect(session.acceptFile(candidate)).rejects.toMatchObject({
      code: "FILE_HANDOFF_INVALID",
    });
    expect(session.status()).toMatchObject({
      workbookId: before.workbookId,
      revision: before.revision,
      dirty: false,
      nativeSource: null,
      importProvenance: null,
    });
  }

  const accepted = await session.acceptFile({
    ...valid,
    attachmentMediaType: "application/octet-stream",
  });
  expect(accepted).toMatchObject({
    revision: 1,
    dirty: true,
    importProvenance: { path: "/verified.csv", etag: valid.etag, format: "csv" },
  });
});

test("recovery restores the tagged workbook at its recorded document revision", async () => {
  const recovery = createMemoryRecoveryPersistence();
  const first = await WorkbookSession.open({ recovery });
  const sheetId = first.status().sheets[0]!.id;
  await first.apply({
    expectedRevision: 0,
    commandId: "recover-me",
    operations: [{ type: "set_cells", sheetId, start: "C3", values: [[{ kind: "text", value: "draft" }]] }],
  });
  const reopened = await WorkbookSession.open({ recovery });
  expect(reopened.status().recovery).toMatchObject({ available: true, revision: 1 });
  const recovered = await reopened.recoverDraft({ expectedRevision: 0, commandId: "recover-draft" });
  expect(recovered.recoveryDisposition).toBe("no_source");
  expect(reopened.status()).toMatchObject({ revision: 1, dirty: true });
  expect(reopened.readRange(sheetId, "C3").cells[0]!.raw).toEqual({ kind: "text", value: "draft" });
});

test("recovery retains an exact native source after one scoped verification read", async () => {
  const fixture = await nativeRecoveryFixture();
  let reads = 0;
  let delegations = 0;
  const files: WorkbookFilesPort = {
    async readBinary(path, options) {
      reads += 1;
      expect(path).toBe(fixture.path);
      expect(options).toEqual({ ifMatch: fixture.etag, delegationToken: "recovery-token" });
      return {
        path,
        mediaType: "application/vnd.neutron.spreadsheet+json",
        etag: fixture.etag,
        byteLength: fixture.sourceData.byteLength,
        data: fixture.sourceData.slice(0),
      };
    },
    async writeBinary() { throw new Error("not used"); },
  };
  const session = await WorkbookSession.open({ recovery: fixture.recovery, files });
  const request = {
    expectedRevision: 0,
    commandId: "recover-exact-source",
    getDelegationToken: async () => {
      delegations += 1;
      return "recovery-token";
    },
  } as const;

  const [first, concurrentRetry] = await Promise.all([
    session.recoverDraft(request),
    session.recoverDraft(request),
  ]);
  expect(concurrentRetry).toEqual(first);
  expect(first).toMatchObject({
    recoveryDisposition: "source_exact",
    revision: fixture.revision,
    dirty: true,
    lastSavedRevision: null,
    nativeSource: { path: fixture.path, etag: fixture.etag },
  });
  expect(session.readRange(fixture.sheetId, "B2").cells[0]!.raw).toEqual({ kind: "text", value: "draft" });
  expect(await session.recoverDraft(request)).toEqual(first);
  expect({ reads, delegations }).toEqual({ reads: 1, delegations: 1 });
});

test("recovery whose native source changed becomes an unsaved copy", async () => {
  const fixture = await nativeRecoveryFixture();
  let reads = 0;
  const files: WorkbookFilesPort = {
    async readBinary(_path, options) {
      reads += 1;
      expect(options?.ifMatch).toBe(fixture.etag);
      throw codedError("VFS_CONFLICT");
    },
    async writeBinary() { throw new Error("not used"); },
  };
  const session = await WorkbookSession.open({ recovery: fixture.recovery, files });
  const request = {
    expectedRevision: 0,
    commandId: "recover-changed-source",
    getDelegationToken: async () => "changed-token",
  } as const;

  const recovered = await session.recoverDraft(request);
  expect(recovered).toMatchObject({
    recoveryDisposition: "source_changed",
    revision: fixture.revision,
    dirty: true,
    nativeSource: null,
    lastSavedRevision: null,
  });
  expect(session.readRange(fixture.sheetId, "B2").cells[0]!.raw).toEqual({ kind: "text", value: "draft" });
  expect(await session.recoverDraft(request)).toEqual(recovered);
  expect(reads).toBe(1);
});

test("recovery whose native source was deleted becomes an unsaved copy", async () => {
  const fixture = await nativeRecoveryFixture();
  let reads = 0;
  const files: WorkbookFilesPort = {
    async readBinary() {
      reads += 1;
      throw codedError("VFS_NOT_FOUND");
    },
    async writeBinary() { throw new Error("not used"); },
  };
  const session = await WorkbookSession.open({ recovery: fixture.recovery, files });
  const recovered = await session.recoverDraft({
    expectedRevision: 0,
    commandId: "recover-deleted-source",
    getDelegationToken: async () => "deleted-token",
  });

  expect(recovered).toMatchObject({
    recoveryDisposition: "source_deleted",
    dirty: true,
    nativeSource: null,
    lastSavedRevision: null,
  });
  expect(session.readRange(fixture.sheetId, "B2").cells[0]!.raw).toEqual({ kind: "text", value: "draft" });
  expect(reads).toBe(1);
});

test("recovery permission failure leaves the blank session and draft untouched", async () => {
  const fixture = await nativeRecoveryFixture();
  const persistedBefore = fixture.recovery.current();
  let reads = 0;
  const files: WorkbookFilesPort = {
    async readBinary() {
      reads += 1;
      throw codedError("PERMISSION_DENIED");
    },
    async writeBinary() { throw new Error("not used"); },
  };
  const session = await WorkbookSession.open({ recovery: fixture.recovery, files });
  const before = session.status();

  await expect(session.recoverDraft({
    expectedRevision: 0,
    commandId: "recover-without-permission",
    getDelegationToken: async () => "permission-token",
  })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

  expect(session.status()).toMatchObject({
    workbookId: before.workbookId,
    revision: 0,
    dirty: false,
    nativeSource: null,
    recovery: { available: true, pending: true, revision: fixture.revision },
  });
  expect(fixture.recovery.current()).toEqual(persistedBefore);
  expect(reads).toBe(1);
});

test("an unresolved startup recovery cannot be overwritten by a normal edit", async () => {
  const recovery = createMemoryRecoveryPersistence();
  const first = await WorkbookSession.open({ recovery });
  const originalSheetId = first.status().sheets[0]!.id;
  await first.apply({
    expectedRevision: 0,
    commandId: "checkpoint-original-draft",
    operations: [{ type: "set_cells", sheetId: originalSheetId, start: "B2", values: [[{ kind: "text", value: "keep me" }]] }],
  });

  const reopened = await WorkbookSession.open({ recovery });
  const blankSheetId = reopened.status().sheets[0]!.id;
  expect(reopened.status().recovery).toMatchObject({ available: true, pending: true, revision: 1 });
  await expect(reopened.apply({
    expectedRevision: 0,
    commandId: "must-not-replace-recovery",
    operations: [{ type: "set_cells", sheetId: blankSheetId, start: "A1", values: [[{ kind: "number", value: 99 }]] }],
  })).rejects.toMatchObject({ code: "RECOVERY_PENDING" });
  expect(recovery.current()?.workbook.sheets[0]!.cells.B2!.input).toEqual({ kind: "text", value: "keep me" });

  await reopened.recoverDraft({ expectedRevision: 0, commandId: "choose-recovery" });
  expect(reopened.status().recovery.pending).toBe(false);
  await reopened.apply({
    expectedRevision: 1,
    commandId: "edit-recovered-document",
    operations: [{ type: "set_cells", sheetId: originalSheetId, start: "C3", values: [[{ kind: "number", value: 3 }]] }],
  });
  expect(reopened.readRange(originalSheetId, "B2:C3").cells.map((cell) => cell.raw)).toEqual([
    { kind: "text", value: "keep me" },
    { kind: "blank" },
    { kind: "blank" },
    { kind: "number", value: 3 },
  ]);
});

test("CSV and XLSX exports create new snapshots without marking native work clean", async () => {
  const writes: Array<{ path: string; mediaType: string; data: ArrayBuffer; condition: unknown; delegationToken?: string }> = [];
  const files: WorkbookFilesPort = {
    async readBinary() { throw new Error("not used"); },
    async writeBinary(path, mediaType, data, condition, options) {
      writes.push({ path, mediaType, data: data.slice(0), condition, ...(options?.delegationToken ? { delegationToken: options.delegationToken } : {}) });
      return { path, mediaType, byteLength: data.byteLength, etag: `etag-${writes.length}` };
    },
  };
  const session = await WorkbookSession.open({
    recovery: createMemoryRecoveryPersistence(),
    files,
    xlsx: new BrowserXlsxCodec(),
  });
  const sheetId = session.status().sheets[0]!.id;
  await session.apply({
    expectedRevision: 0,
    commandId: "export-data",
    operations: [{ type: "set_cells", sheetId, start: "A1", values: [[
      { kind: "number", value: 4 },
      { kind: "formula", formula: "=A1*2" },
    ]] }],
  });
  let delegations = 0;
  const csvPreflight = await session.preflightExport({
    expectedRevision: 1,
    commandId: "csv-preflight",
    format: "csv",
    path: "/snapshot.csv",
    sheetId,
    csvInjectionPolicy: "exact",
  });
  const csv = await session.commitExport({
    expectedRevision: 1,
    commandId: "csv-commit",
    format: "csv",
    path: "/snapshot.csv",
    sheetId,
    csvInjectionPolicy: "exact",
    preflightToken: csvPreflight.preflightToken,
    getDelegationToken: async () => { delegations += 1; return "one-use-token"; },
  });
  const xlsxPreflight = await session.preflightExport({
    expectedRevision: 1,
    commandId: "xlsx-preflight",
    format: "xlsx",
    path: "/snapshot.xlsx",
  });
  const xlsx = await session.commitExport({
    expectedRevision: 1,
    commandId: "xlsx-commit",
    format: "xlsx",
    path: "/snapshot.xlsx",
    preflightToken: xlsxPreflight.preflightToken,
  });
  expect(new TextDecoder().decode(new Uint8Array(writes[0]!.data))).toBe("4,8\r\n");
  expect(writes[1]!.data.byteLength).toBeGreaterThan(500);
  expect(writes.map((write) => write.condition)).toEqual([{ ifNoneMatch: "*" }, { ifNoneMatch: "*" }]);
  expect(writes[0]!.delegationToken).toBe("one-use-token");
  expect(delegations).toBe(1);
  expect(csv.losses.formulaCellsFlattened).toBe(1);
  expect(xlsx.warnings).toEqual([]);
  expect(session.status().dirty).toBe(true);
});

test("session and native save commands reject stale revisions before Files I/O and coalesce retries", async () => {
  let reads = 0;
  let writes = 0;
  const files: WorkbookFilesPort = {
    async readBinary(path) {
      reads += 1;
      return {
        path,
        mediaType: "text/csv",
        etag: "csv-etag",
        byteLength: 3,
        data: new TextEncoder().encode("x\r\n").buffer,
      };
    },
    async writeBinary(path, mediaType, data) {
      writes += 1;
      await Promise.resolve();
      return { path, mediaType, byteLength: data.byteLength, etag: "native-etag" };
    },
  };
  const session = await WorkbookSession.open({ recovery: createMemoryRecoveryPersistence(), files });

  await expect(session.openPath("/stale.csv", {
    expectedRevision: 1,
    commandId: "stale-open",
  })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  await expect(session.saveNative({
    expectedRevision: 1,
    commandId: "stale-save",
    path: "/stale.nsheet",
  })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  expect({ reads, writes }).toEqual({ reads: 0, writes: 0 });

  const opened = await session.openPath("/fresh.csv", {
    expectedRevision: 0,
    commandId: "open-once",
  });
  const openedRetry = await session.openPath("/fresh.csv", {
    expectedRevision: 0,
    commandId: "open-once",
  });
  expect(openedRetry).toEqual(opened);
  expect(reads).toBe(1);

  const request = {
    expectedRevision: opened.revision,
    commandId: "save-once",
    path: "/saved.nsheet",
  } as const;
  const [first, concurrentRetry] = await Promise.all([
    session.saveNative(request),
    session.saveNative(request),
  ]);
  expect(concurrentRetry).toEqual(first);
  expect(await session.saveNative(request)).toEqual(first);
  expect(writes).toBe(1);
  await expect(session.saveNative({ ...request, path: "/different.nsheet" }))
    .rejects.toMatchObject({ code: "COMMAND_ID_REUSED" });
});

test("an aborted command stops before delegation and Files I/O without consuming its command id", async () => {
  let delegations = 0;
  let reads = 0;
  const files: WorkbookFilesPort = {
    async readBinary(path) {
      reads += 1;
      const data = new TextEncoder().encode("value\r\n1\r\n").buffer;
      return { path, mediaType: "text/csv", etag: "read-etag", byteLength: data.byteLength, data };
    },
    async writeBinary() { throw new Error("not used"); },
  };
  const session = await WorkbookSession.open({ recovery: createMemoryRecoveryPersistence(), files });
  const controller = new AbortController();
  controller.abort();
  const request = {
    expectedRevision: 0,
    commandId: "cancel-before-open",
    getDelegationToken: async () => {
      delegations += 1;
      return "open-token";
    },
  } as const;

  await expect(session.openPath("/cancelled.csv", {
    ...request,
    signal: controller.signal,
  })).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  expect({ delegations, reads }).toEqual({ delegations: 0, reads: 0 });
  expect(session.status()).toMatchObject({ revision: 0, dirty: false, importProvenance: null });

  const retried = await session.openPath("/cancelled.csv", request);
  expect(retried).toMatchObject({ commandId: request.commandId, revision: 1, dirty: true });
  expect({ delegations, reads }).toEqual({ delegations: 1, reads: 1 });
});

test("an abort during a Files read prevents late workbook replacement and permits retry", async () => {
  const readStarted = deferredSignal();
  const releaseRead = deferredSignal();
  let reads = 0;
  const files: WorkbookFilesPort = {
    async readBinary(path) {
      reads += 1;
      if (reads === 1) {
        readStarted.resolve();
        await releaseRead.promise;
      }
      const data = new TextEncoder().encode("value\r\n2\r\n").buffer;
      return { path, mediaType: "text/csv", etag: "read-etag", byteLength: data.byteLength, data };
    },
    async writeBinary() { throw new Error("not used"); },
  };
  const session = await WorkbookSession.open({ recovery: createMemoryRecoveryPersistence(), files });
  const before = session.status();
  const controller = new AbortController();
  const request = {
    expectedRevision: 0,
    commandId: "cancel-during-read",
    signal: controller.signal,
  } as const;
  const opening = session.openPath("/delayed.csv", request);
  await readStarted.promise;
  controller.abort();
  releaseRead.resolve();

  await expect(opening).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  expect(session.status()).toMatchObject({
    workbookId: before.workbookId,
    revision: before.revision,
    dirty: false,
    importProvenance: null,
  });

  const retried = await session.openPath("/delayed.csv", {
    expectedRevision: 0,
    commandId: request.commandId,
  });
  expect(retried).toMatchObject({ revision: 1, dirty: true });
  expect(reads).toBe(2);
});

test("an abort after write issuance does not skip save finalization", async () => {
  const writeStarted = deferredSignal();
  const releaseWrite = deferredSignal();
  let writes = 0;
  const files: WorkbookFilesPort = {
    async readBinary() { throw new Error("not used"); },
    async writeBinary(path, mediaType, data) {
      writes += 1;
      writeStarted.resolve();
      await releaseWrite.promise;
      return { path, mediaType, byteLength: data.byteLength, etag: "committed-etag" };
    },
  };
  const session = await WorkbookSession.open({ recovery: createMemoryRecoveryPersistence(), files });
  const sheetId = session.status().sheets[0]!.id;
  await session.apply({
    expectedRevision: 0,
    commandId: "edit-before-cancelled-save",
    operations: [{ type: "set_cells", sheetId, start: "A1", values: [[{ kind: "number", value: 1 }]] }],
  });
  const controller = new AbortController();
  const saving = session.saveNative({
    expectedRevision: 1,
    commandId: "cancel-after-write-start",
    path: "/committed.nsheet",
    signal: controller.signal,
  });
  await writeStarted.promise;
  controller.abort();
  releaseWrite.resolve();

  await expect(saving).resolves.toMatchObject({ savedRevision: 1, dirty: false });
  expect(writes).toBe(1);
  expect(session.status()).toMatchObject({
    revision: 1,
    dirty: false,
    saving: false,
    nativeSource: { path: "/committed.nsheet", etag: "committed-etag" },
  });
});

test("export preflight is write-free and commit binds revision, options, expiry, losses, and retry identity", async () => {
  let now = 1_000;
  const writes: Array<{ path: string; condition: unknown }> = [];
  const files: WorkbookFilesPort = {
    async readBinary() { throw new Error("not used"); },
    async writeBinary(path, mediaType, data, condition) {
      writes.push({ path, condition });
      await Promise.resolve();
      return { path, mediaType, byteLength: data.byteLength, etag: `etag-${writes.length}` };
    },
  };
  const session = await WorkbookSession.open({
    recovery: createMemoryRecoveryPersistence(),
    files,
    now: () => now,
    preflightTtlMs: 50,
  });
  const sheetId = session.status().sheets[0]!.id;
  await session.apply({
    expectedRevision: 0,
    commandId: "export-cells",
    operations: [{ type: "set_cells", sheetId, start: "A1", values: [[
      { kind: "text", value: "=danger" },
      { kind: "formula", formula: "=1+1" },
    ]] }],
  });
  const preflightRequest = {
    expectedRevision: 1,
    commandId: "safe-preflight",
    format: "csv" as const,
    path: "/safe.csv",
    sheetId,
    csvInjectionPolicy: "safe" as const,
  };
  const preflight = await session.preflightExport(preflightRequest);
  expect(writes).toHaveLength(0);
  expect(preflight).toMatchObject({
    revision: 1,
    byteLength: 12,
    losses: { formulaCellsFlattened: 1, textCellsHardened: 1, omittedSheets: 0 },
  });
  expect((await session.preflightExport(preflightRequest)).preflightToken).toBe(preflight.preflightToken);

  await expect(session.commitExport({
    ...preflightRequest,
    commandId: "changed-options",
    csvInjectionPolicy: "exact",
    preflightToken: preflight.preflightToken,
  })).rejects.toMatchObject({ code: "PREFLIGHT_STALE" });
  expect(writes).toHaveLength(0);

  const commitRequest = {
    ...preflightRequest,
    commandId: "safe-commit",
    preflightToken: preflight.preflightToken,
  };
  const [committed, concurrentRetry] = await Promise.all([
    session.commitExport(commitRequest),
    session.commitExport(commitRequest),
  ]);
  expect(concurrentRetry).toEqual(committed);
  expect(await session.commitExport(commitRequest)).toEqual(committed);
  expect(writes).toEqual([{ path: "/safe.csv", condition: { ifNoneMatch: "*" } }]);
  expect(session.status().dirty).toBe(true);

  const editStale = await session.preflightExport({
    ...preflightRequest,
    commandId: "edit-stale-preflight",
    path: "/edit-stale.csv",
  });
  await session.apply({
    expectedRevision: 1,
    commandId: "edit-after-preflight",
    operations: [{ type: "set_cells", sheetId, start: "C1", values: [[{ kind: "number", value: 3 }]] }],
  });
  await expect(session.commitExport({
    ...preflightRequest,
    expectedRevision: 1,
    commandId: "edit-stale-commit",
    path: "/edit-stale.csv",
    preflightToken: editStale.preflightToken,
  })).rejects.toMatchObject({ code: "PREFLIGHT_STALE" });

  const expired = await session.preflightExport({
    ...preflightRequest,
    expectedRevision: 2,
    commandId: "expired-preflight",
    path: "/expired.csv",
  });
  now = expired.expiresAt;
  await expect(session.commitExport({
    ...preflightRequest,
    expectedRevision: 2,
    commandId: "expired-commit",
    path: "/expired.csv",
    preflightToken: expired.preflightToken,
  })).rejects.toMatchObject({ code: "PREFLIGHT_STALE" });

  await expect(session.preflightExport({
    expectedRevision: 2,
    commandId: "missing-injection-policy",
    format: "csv",
    path: "/unsafe.csv",
    sheetId,
  })).rejects.toMatchObject({ code: "LOSS_ACK_REQUIRED" });
  expect(writes).toHaveLength(1);
});

test("native save and export I/O reject destructive session replacement", async () => {
  const writeStarted = deferredSignal();
  const releaseWrite = deferredSignal();
  let reads = 0;
  const files: WorkbookFilesPort = {
    async readBinary(path) {
      reads += 1;
      return {
        path,
        mediaType: "text/csv",
        etag: "read-etag",
        byteLength: 3,
        data: new TextEncoder().encode("x\r\n").buffer,
      };
    },
    async writeBinary(path, mediaType, data) {
      writeStarted.resolve();
      await releaseWrite.promise;
      return { path, mediaType, byteLength: data.byteLength, etag: "saved-etag" };
    },
  };
  const session = await WorkbookSession.open({ recovery: createMemoryRecoveryPersistence(), files });
  const sheetId = session.status().sheets[0]!.id;
  const workbookId = session.status().workbookId;
  await session.apply({
    expectedRevision: 0,
    commandId: "edit-before-delayed-save",
    operations: [{ type: "set_cells", sheetId, start: "A1", values: [[{ kind: "number", value: 1 }]] }],
  });

  const saving = session.saveNative({
    expectedRevision: 1,
    commandId: "delayed-save",
    path: "/delayed.nsheet",
  });
  await writeStarted.promise;
  expect(session.status().saving).toBe(true);

  await expect(session.newWorkbook({
    expectedRevision: 1,
    commandId: "new-during-save",
    discardDirty: true,
  })).rejects.toMatchObject({ code: "SAVE_IN_PROGRESS" });
  await expect(session.openPath("/other.csv", {
    expectedRevision: 1,
    commandId: "open-during-save",
    discardDirty: true,
  })).rejects.toMatchObject({ code: "SAVE_IN_PROGRESS" });
  await expect(session.recoverDraft({
    expectedRevision: 1,
    commandId: "recover-during-save",
    discardDirty: true,
  })).rejects.toMatchObject({ code: "SAVE_IN_PROGRESS" });
  await expect(session.acceptFile(await acceptedFile(
    "/handoff.csv",
    "text/csv",
    new TextEncoder().encode("handoff\r\n").buffer,
  ), { discardDirty: true })).rejects.toMatchObject({ code: "SAVE_IN_PROGRESS" });
  expect(reads).toBe(0);

  releaseWrite.resolve();
  const saved = await saving;
  expect(saved).toMatchObject({ savedRevision: 1, revision: 1, dirty: false });
  expect(session.status()).toMatchObject({
    workbookId,
    revision: 1,
    dirty: false,
    nativeSource: { path: "/delayed.nsheet", etag: "saved-etag" },
  });
});

test("same-workbook edits remain allowed during native save and stay dirty", async () => {
  const writeStarted = deferredSignal();
  const releaseWrite = deferredSignal();
  const files: WorkbookFilesPort = {
    async readBinary() { throw new Error("not used"); },
    async writeBinary(path, mediaType, data) {
      writeStarted.resolve();
      await releaseWrite.promise;
      return { path, mediaType, byteLength: data.byteLength, etag: "revision-one-etag" };
    },
  };
  const session = await WorkbookSession.open({ recovery: createMemoryRecoveryPersistence(), files });
  const sheetId = session.status().sheets[0]!.id;
  await session.apply({
    expectedRevision: 0,
    commandId: "first-edit",
    operations: [{ type: "set_cells", sheetId, start: "A1", values: [[{ kind: "number", value: 1 }]] }],
  });
  const saving = session.saveNative({
    expectedRevision: 1,
    commandId: "save-revision-one",
    path: "/live-edit.nsheet",
  });
  await writeStarted.promise;

  await session.apply({
    expectedRevision: 1,
    commandId: "edit-while-saving",
    operations: [{ type: "set_cells", sheetId, start: "A2", values: [[{ kind: "number", value: 2 }]] }],
  });
  releaseWrite.resolve();

  expect(await saving).toMatchObject({ savedRevision: 1, revision: 2, dirty: true });
  expect(session.status()).toMatchObject({
    revision: 2,
    lastSavedRevision: 1,
    dirty: true,
    nativeSource: { path: "/live-edit.nsheet", etag: "revision-one-etag" },
    recovery: { available: true, revision: 2 },
  });
});

test("native save reconciles an exact response-loss write and caches retries", async () => {
  let stored: ArrayBuffer | null = null;
  let writes = 0;
  let reads = 0;
  const delegated: string[] = [];
  const files: WorkbookFilesPort = {
    async readBinary(path, options) {
      reads += 1;
      expect(options?.delegationToken).toBe("delegation-2");
      expect(options?.ifMatch).toMatch(/^[a-f0-9]{64}$/);
      return {
        path,
        mediaType: "application/vnd.neutron.spreadsheet+json",
        etag: options!.ifMatch!,
        byteLength: stored!.byteLength,
        data: stored!.slice(0),
      };
    },
    async writeBinary(_path, _mediaType, data, _condition, options) {
      writes += 1;
      expect(options?.delegationToken).toBe("delegation-1");
      stored = data.slice(0);
      throw codedError("ATTACHMENT_TIMEOUT");
    },
  };
  const session = await WorkbookSession.open({ recovery: createMemoryRecoveryPersistence(), files });
  const sheetId = session.status().sheets[0]!.id;
  await session.apply({
    expectedRevision: 0,
    commandId: "edit-for-reconciled-save",
    operations: [{ type: "set_cells", sheetId, start: "A1", values: [[{ kind: "text", value: "persisted" }]] }],
  });
  const request = {
    expectedRevision: 1,
    commandId: "reconciled-native-save",
    path: "/reconciled.nsheet",
    getDelegationToken: async () => {
      const token = `delegation-${delegated.length + 1}`;
      delegated.push(token);
      return token;
    },
  } as const;

  const result = await session.saveNative(request);
  expect(result).toMatchObject({ dirty: false, file: { etag: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  expect(await session.saveNative(request)).toEqual(result);
  expect({ writes, reads, delegated }).toEqual({
    writes: 1,
    reads: 1,
    delegated: ["delegation-1", "delegation-2"],
  });
});

test("native save keeps state dirty and caches an unverifiable mismatch", async () => {
  let wrongBytes: ArrayBuffer | null = null;
  let writes = 0;
  let reads = 0;
  const files: WorkbookFilesPort = {
    async readBinary(path, options) {
      reads += 1;
      return {
        path,
        mediaType: "application/vnd.neutron.spreadsheet+json",
        etag: options!.ifMatch!,
        byteLength: wrongBytes!.byteLength,
        data: wrongBytes!.slice(0),
      };
    },
    async writeBinary(_path, _mediaType, data) {
      writes += 1;
      wrongBytes = data.slice(0);
      const corrupted = new Uint8Array(wrongBytes);
      corrupted[0] = (corrupted[0] ?? 0) ^ 1;
      throw codedError("ATTACHMENT_DISCONNECTED");
    },
  };
  const session = await WorkbookSession.open({ recovery: createMemoryRecoveryPersistence(), files });
  const sheetId = session.status().sheets[0]!.id;
  await session.apply({
    expectedRevision: 0,
    commandId: "edit-for-mismatch",
    operations: [{ type: "set_cells", sheetId, start: "A1", values: [[{ kind: "number", value: 9 }]] }],
  });
  const request = {
    expectedRevision: 1,
    commandId: "unknown-native-save",
    path: "/unknown.nsheet",
  } as const;

  await expect(session.saveNative(request)).rejects.toMatchObject({
    code: "SAVE_OUTCOME_UNKNOWN",
    details: {
      writeError: "ATTACHMENT_DISCONNECTED",
      reconciliationError: "RECONCILIATION_MISMATCH",
    },
  });
  expect(session.status()).toMatchObject({ dirty: true, nativeSource: null, lastSavedRevision: null, saving: false });
  await expect(session.saveNative(request)).rejects.toMatchObject({ code: "SAVE_OUTCOME_UNKNOWN" });
  expect({ writes, reads }).toEqual({ writes: 1, reads: 1 });
});

test("export commit reconciles exact response loss without a duplicate write", async () => {
  let stored: ArrayBuffer | null = null;
  let writes = 0;
  let reads = 0;
  const files: WorkbookFilesPort = {
    async readBinary(path, options) {
      reads += 1;
      return {
        path,
        mediaType: "text/csv",
        etag: options!.ifMatch!,
        byteLength: stored!.byteLength,
        data: stored!.slice(0),
      };
    },
    async writeBinary(_path, _mediaType, data) {
      writes += 1;
      stored = data.slice(0);
      throw codedError("FILES_INVALID_RESPONSE");
    },
  };
  const session = await WorkbookSession.open({ recovery: createMemoryRecoveryPersistence(), files });
  const sheetId = session.status().sheets[0]!.id;
  await session.apply({
    expectedRevision: 0,
    commandId: "edit-for-export-reconciliation",
    operations: [{ type: "set_cells", sheetId, start: "A1", values: [[{ kind: "number", value: 4 }]] }],
  });
  const preflight = await session.preflightExport({
    expectedRevision: 1,
    commandId: "reconciled-export-preflight",
    format: "csv",
    path: "/reconciled.csv",
    sheetId,
    csvInjectionPolicy: "exact",
  });
  const request = {
    expectedRevision: 1,
    commandId: "reconciled-export-commit",
    format: "csv" as const,
    path: "/reconciled.csv",
    sheetId,
    csvInjectionPolicy: "exact" as const,
    preflightToken: preflight.preflightToken,
  };

  const committed = await session.commitExport(request);
  expect(committed.file.etag).toMatch(/^[a-f0-9]{64}$/);
  expect(await session.commitExport(request)).toEqual(committed);
  expect({ writes, reads }).toEqual({ writes: 1, reads: 1 });
  expect(session.status()).toMatchObject({ dirty: true, nativeSource: null, saving: false });
});

test("export commit reports and caches unknown outcome when reconciliation is unavailable", async () => {
  let writes = 0;
  let reads = 0;
  const files: WorkbookFilesPort = {
    async readBinary() {
      reads += 1;
      throw codedError("ATTACHMENT_UNAVAILABLE");
    },
    async writeBinary() {
      writes += 1;
      throw codedError("ATTACHMENT_TIMEOUT");
    },
  };
  const session = await WorkbookSession.open({ recovery: createMemoryRecoveryPersistence(), files });
  const sheetId = session.status().sheets[0]!.id;
  await session.apply({
    expectedRevision: 0,
    commandId: "edit-for-unknown-export",
    operations: [{ type: "set_cells", sheetId, start: "A1", values: [[{ kind: "number", value: 7 }]] }],
  });
  const preflight = await session.preflightExport({
    expectedRevision: 1,
    commandId: "unknown-export-preflight",
    format: "csv",
    path: "/unknown.csv",
    sheetId,
    csvInjectionPolicy: "exact",
  });
  const request = {
    expectedRevision: 1,
    commandId: "unknown-export-commit",
    format: "csv" as const,
    path: "/unknown.csv",
    sheetId,
    csvInjectionPolicy: "exact" as const,
    preflightToken: preflight.preflightToken,
  };

  await expect(session.commitExport(request)).rejects.toMatchObject({
    code: "SAVE_OUTCOME_UNKNOWN",
    details: {
      writeError: "ATTACHMENT_TIMEOUT",
      reconciliationError: "ATTACHMENT_UNAVAILABLE",
    },
  });
  await expect(session.commitExport(request)).rejects.toMatchObject({ code: "SAVE_OUTCOME_UNKNOWN" });
  expect({ writes, reads }).toEqual({ writes: 1, reads: 1 });
  expect(session.status()).toMatchObject({ dirty: true, nativeSource: null, saving: false });
});

async function nativeRecoveryFixture() {
  const source = createWorkbook(100);
  const sheetId = source.sheets[0]!.id;
  const encoded = encodeNativeWorkbook(source);
  const sourceData = encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  ) as ArrayBuffer;
  const etag = await bufferSha256(sourceData);
  const draft = structuredClone(source);
  draft.sheets[0]!.cells.B2 = { input: { kind: "text", value: "draft" } };
  draft.metadata.updatedAt = 200;
  const path = "/source.nsheet";
  const revision = 4;
  const recovery = createMemoryRecoveryPersistence();
  await recovery.save({
    version: 1,
    savedAt: 300,
    revision,
    workbook: draft,
    nativeSource: { path, etag },
  });
  return { recovery, sourceData, etag, path, revision, sheetId };
}

async function bufferSha256(data: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function acceptedFile(path: string, mediaType: string, data: ArrayBuffer): Promise<{
  path: string;
  mediaType: string;
  etag: string;
  attachmentMediaType: string;
  byteLength: number;
  data: ArrayBuffer;
}> {
  return {
    path,
    mediaType,
    etag: await bufferSha256(data),
    attachmentMediaType: mediaType,
    byteLength: data.byteLength,
    data,
  };
}

function deferredSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function codedError(code: string): Error {
  const error = new Error(code);
  Object.defineProperty(error, "code", { enumerable: true, value: code });
  return error;
}
