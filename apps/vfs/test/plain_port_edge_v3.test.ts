import { describe, expect, test } from "bun:test";
import {
  FILES_V2_LIMITS,
} from "../src/protocol/constants.ts";
import {
  FilesPlainBackendError,
  type FilesPlainBackendAdapter,
  type FilesPlainCursor,
  type FilesPlainEntry,
  type FilesPlainList,
  type FilesPlainMutationResult,
  type FilesPlainWriteInput,
  type FilesPlainWriteResult,
} from "../src/protocol/plain_backend_adapter.ts";
import type { CanonicalNat64 } from "../src/protocol/types.ts";
import {
  DefaultFilesPlainPort,
} from "../src/resident/plain_port.ts";

describe("Files plain resident edge cases", () => {
  test("browser uploads choose Shared presentation from the filename", async () => {
    const cases = [
      {
        name: "notes.txt",
        mediaType: "text/plain",
        expected: "inline_text",
        expectedContentKind: "text",
      },
      {
        name: "DATA.JSONL",
        mediaType: "application/octet-stream",
        expected: "inline_text",
        expectedContentKind: "text",
      },
      {
        name: "site.HTML",
        mediaType: "text/html",
        expected: "inline_text",
        expectedContentKind: "text",
      },
      {
        name: "deploy.SH",
        mediaType: "application/octet-stream",
        expected: "inline_text",
        expectedContentKind: "text",
      },
      {
        name: ".ENV",
        mediaType: "application/octet-stream",
        expected: "inline_text",
        expectedContentKind: "text",
      },
      {
        name: ".txt",
        mediaType: "application/octet-stream",
        expected: "inline_text",
        expectedContentKind: "text",
      },
      {
        name: "photo.png",
        mediaType: "image/png",
        expected: "attachment",
        expectedContentKind: "binary",
      },
      {
        name: "unknown.neutron",
        mediaType: "application/octet-stream",
        expected: "attachment",
        expectedContentKind: "binary",
      },
      {
        name: ".neutron",
        mediaType: "application/octet-stream",
        expected: "attachment",
        expectedContentKind: "binary",
      },
      {
        name: "README",
        mediaType: "text/plain",
        expected: "attachment",
        expectedContentKind: "binary",
      },
    ] as const;

    for (const item of cases) {
      const backend = new UploadBackend();
      const port = new DefaultFilesPlainPort({
        backend: asBackend(backend),
      });
      const first = new Uint8Array(
        FILES_V2_LIMITS.normalPlaintextBlockBytes,
      );
      first[0] = 17;
      first[first.byteLength - 1] = 29;
      const last = new Uint8Array([41, 53, 67]);
      const chunks = [first, last] as const;
      const totalBytes = first.byteLength + last.byteLength;
      const transferId = `upload-${item.name}`;
      const beginning = await port.beginUpload({
        transferId,
        path: `/Shared/${item.name}`,
        name: item.name,
        mediaType: item.mediaType,
        size: totalBytes,
        contentKind: "binary",
      });

      expect(beginning.chunkBytes).toBe(first.byteLength);
      for (const pass of ["hash", "encrypt"] as const) {
        for (const [ordinal, chunk] of chunks.entries()) {
          const data = arrayBuffer(chunk);
          await port.uploadChunk(
            {
              transferId,
              pass,
              ordinal,
              final: ordinal + 1 === chunks.length,
              totalBytes,
            },
            data,
          );
          expect(
            new Uint8Array(data).every((value) => value === 0),
          ).toBe(true);
        }
      }

      expect(backend.writes).toHaveLength(2);
      expect(
        backend.writes.map((write) => ({
          space: write.space,
          path: write.path,
          blockIndex: write.blockIndex,
          blockCount: write.blockCount,
          contentKind: write.contentKind,
          presentation: write.presentation,
          final: write.final,
        })),
      ).toEqual([
        {
          space: "shared",
          path: `/${item.name}`,
          blockIndex: 0,
          blockCount: 2,
          contentKind: item.expectedContentKind,
          presentation: item.expected,
          final: false,
        },
        {
          space: "shared",
          path: `/${item.name}`,
          blockIndex: 1,
          blockCount: 2,
          contentKind: item.expectedContentKind,
          presentation: item.expected,
          final: true,
        },
      ]);
      expect(backend.writes.map((write) => write.safeName)).toEqual([
        item.name,
        item.name,
      ]);
      expect(backend.writes[0]).toMatchObject({
        beginNonce: expect.any(Uint8Array),
        commitNonce: null,
        deleteNonce: null,
      });
      expect(backend.writes[1]).toMatchObject({
        beginNonce: null,
        commitNonce: expect.any(Uint8Array),
        deleteNonce: expect.any(Uint8Array),
      });
    }
  });

  test("Shared filenames normalize generic write content and public names", async () => {
    const cases = [
      {
        path: "/Shared/notes.txt/.",
        requested: "binary",
        expected: "text",
        presentation: "inline_text",
        safeName: "notes.txt",
      },
      {
        path: "/Shared/photo.png",
        requested: "text",
        expected: "binary",
        presentation: "attachment",
        safeName: "photo.png",
      },
    ] as const;
    for (const item of cases) {
      const backend = new UploadBackend();
      const port = new DefaultFilesPlainPort({
        backend: asBackend(backend),
      });
      const result = await port.write({
        path: item.path,
        source: testSource(Uint8Array.of(11), item.safeName),
        contentKind: item.requested,
        mediaType: "application/octet-stream",
        ifMatch: null,
        ifNoneMatch: true,
        createParents: false,
      });
      expect(result.entry).toMatchObject({
        contentKind: item.expected,
        path: `/Shared/${item.safeName}`,
      });
      expect(backend.writes[0]).toMatchObject({
        contentKind: item.expected,
        path: `/${item.safeName}`,
        presentation: item.presentation,
        safeName: item.safeName,
      });
    }
  });

  test("Workspace direct and streamed writes omit public-asset authority", async () => {
    const backend = new DeferredUploadBackend();
    const port = new DefaultFilesPlainPort({
      backend: asBackend(backend),
    });
    await port.write({
      path: "/Workspace/private.bin",
      source: testSource(twoBlockPayload(), "private.bin"),
      contentKind: "binary",
      mediaType: "application/octet-stream",
      ifMatch: null,
      ifNoneMatch: true,
      createParents: false,
    });
    await port.beginUpload({
      transferId: "workspace-token-free",
      path: "/Workspace/token-free.bin",
      name: "token-free.bin",
      mediaType: "application/octet-stream",
      size: 1,
      contentKind: "binary",
    });
    for (const pass of ["hash", "encrypt"] as const) {
      await port.uploadChunk({
        transferId: "workspace-token-free",
        pass,
        ordinal: 0,
        final: true,
        totalBytes: 1,
      }, arrayBuffer(Uint8Array.of(13)));
    }
    expect(backend.writes).toHaveLength(3);
    for (const write of backend.writes) {
      expect(write).toMatchObject({
        presentation: null,
        safeName: null,
        beginNonce: null,
        commitNonce: null,
        deleteNonce: null,
      });
    }
  });

  test("plain createParents stays backend-authoritative on abort and success", async () => {
    const failedBackend = new ParentPlanningBackend();
    failedBackend.rejectOrdinal = 1;
    const failedPort = new DefaultFilesPlainPort({
      backend: asBackend(failedBackend),
    });
    await expect(failedPort.write({
      transferId: "deferred-parent-failure",
      path: "/Workspace/missing/deep/failed.bin",
      source: testSource(twoBlockPayload(), "failed.bin"),
      contentKind: "binary",
      mediaType: "application/octet-stream",
      ifMatch: null,
      ifNoneMatch: true,
      createParents: true,
    })).rejects.toMatchObject({ code: "conflict" });
    expect(failedBackend.writes).toHaveLength(2);
    expect(
      failedBackend.writes.every((write) => write.createParents),
    ).toBe(true);
    expect(failedBackend.aborts).toEqual([nat(70)]);
    expect(failedBackend.statCalls).toBe(0);
    expect(failedBackend.mkdirCalls).toEqual([]);

    const successfulBackend = new ParentPlanningBackend();
    const successfulPort = new DefaultFilesPlainPort({
      backend: asBackend(successfulBackend),
    });
    await expect(successfulPort.write({
      path: "/Shared/new/folder/notes.txt",
      source: testSource(
        new TextEncoder().encode("ready"),
        "notes.txt",
        "text/plain",
      ),
      contentKind: "text",
      mediaType: "text/plain",
      ifMatch: null,
      ifNoneMatch: true,
      createParents: true,
    })).resolves.toMatchObject({
      entry: { path: "/Shared/new/folder/notes.txt" },
    });
    expect(successfulBackend.writes).toHaveLength(1);
    expect(successfulBackend.writes[0]).toMatchObject({
      space: "shared",
      path: "/new/folder/notes.txt",
      createParents: true,
    });
    expect(successfulBackend.statCalls).toBe(0);
    expect(successfulBackend.mkdirCalls).toEqual([]);
  });

  test("recursive removal restarts listing after every mutating page", async () => {
    const backend = new RecursiveRemovalBackend([
      file("/folder/alpha.txt"),
      file("/folder/bravo.txt"),
      file("/folder/charlie.txt"),
    ]);
    const port = new DefaultFilesPlainPort({
      backend: asBackend(backend),
    });

    await expect(
      port.remove("/Workspace/folder", true),
    ).resolves.toMatchObject({
      path: "/Workspace/folder",
      changed: 1,
      cleanupPending: false,
    });

    expect(backend.listCalls).toHaveLength(4);
    expect(backend.listCalls.map((call) => call.cursor)).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(backend.offeredCursors).toHaveLength(2);
    expect(backend.removeCalls).toEqual([
      "/folder/alpha.txt",
      "/folder/bravo.txt",
      "/folder/charlie.txt",
      "/folder",
    ]);
    expect(backend.remaining).toEqual([]);
  });

  test("deferred tile uploads return before ordered backend commits", async () => {
    const backend = new DeferredUploadBackend();
    backend.hold(0);
    backend.hold(1);
    const port = new DefaultFilesPlainPort({
      backend: asBackend(backend),
    });
    const statusReasons: string[] = [];
    port.onStatusChange((reason) => statusReasons.push(reason));
    const upload = await acceptTwoPassUpload(
      port,
      backend,
      "deferred-ordered",
    );

    expect(upload.accepted).toMatchObject({
      committed: false,
      phase: "uploading",
      processedBytes: upload.totalBytes,
    });
    expect(backend.writes).toHaveLength(0);

    await waitFor(() => backend.writes.length === 1);
    expect(backend.writes[0]).toMatchObject({
      blockIndex: 0,
      stageId: null,
      final: false,
    });
    expect(backend.bodyRefs[0]?.some((value) => value !== 0)).toBe(true);
    expect(backend.writes).toHaveLength(1);

    backend.release(0);
    await waitFor(() => backend.writes.length === 2);
    expect(backend.bodyRefs[0]?.every((value) => value === 0)).toBe(true);
    expect(backend.writes[1]).toMatchObject({
      blockIndex: 1,
      stageId: nat(70),
      final: true,
    });
    expect(backend.bodyRefs[1]?.some((value) => value !== 0)).toBe(true);

    backend.release(1);
    await waitFor(async () =>
      (await port.status()).transfers.some(
        (transfer) =>
          transfer.id === upload.transferId &&
          transfer.phase === "committed",
      )
    );
    expect(backend.bodyRefs.every(
      (body) => body.every((value) => value === 0),
    )).toBe(true);
    expect(backend.aborts).toEqual([]);
    expect(statusReasons).toEqual(["state_changed"]);
  });

  test("an ambiguous deferred final failure is uncertain and aborts its known stage", async () => {
    const backend = new DeferredUploadBackend();
    backend.failOrdinal = 1;
    const port = new DefaultFilesPlainPort({
      backend: asBackend(backend),
    });
    const statusReasons: string[] = [];
    port.onStatusChange((reason) => statusReasons.push(reason));
    const upload = await acceptTwoPassUpload(
      port,
      backend,
      "deferred-failure",
    );

    expect(upload.accepted.committed).toBe(false);
    expect(backend.writes).toHaveLength(0);
    await waitFor(async () =>
      (await port.status()).transfers.some(
        (transfer) =>
          transfer.id === upload.transferId &&
          transfer.phase === "failed",
      )
    );

    expect(backend.writes.map((write) => write.blockIndex)).toEqual([
      0,
      1,
      1,
    ]);
    expect(backend.aborts).toEqual([nat(70)]);
    expect(backend.bodyRefs.every(
      (body) => body.every((value) => value === 0),
    )).toBe(true);
    expect(
      (await port.status()).transfers.find(
        (transfer) => transfer.id === upload.transferId,
      ),
    ).toMatchObject({
      phase: "failed",
      error: "Files may still be finishing this upload",
    });
    expect(statusReasons).toEqual(["state_changed"]);
  });

  test("deferred final transport loss reconciles exact stored metadata", async () => {
    const backend = new DeferredUploadBackend();
    backend.ambiguousFinal = true;
    const port = new DefaultFilesPlainPort({
      backend: asBackend(backend),
    });
    const reasons: string[] = [];
    port.onStatusChange((reason) => reasons.push(reason));
    const upload = await acceptTwoPassUpload(
      port,
      backend,
      "deferred-reconcile",
    );

    await waitFor(async () =>
      (await port.status()).transfers.some(
        (transfer) =>
          transfer.id === upload.transferId &&
          transfer.phase === "committed",
      )
    );
    expect(backend.statCalls).toBe(1);
    expect(reasons).toEqual(["state_changed"]);
  });

  test("a committed final receipt wins cancel and volatile clear races", async () => {
    for (const action of ["cancel", "clear"] as const) {
      const backend = new DeferredUploadBackend();
      backend.hold(1);
      const port = new DefaultFilesPlainPort({
        backend: asBackend(backend),
      });
      const statusReasons: string[] = [];
      port.onStatusChange((reason) => statusReasons.push(reason));
      const upload = await acceptTwoPassUpload(
        port,
        backend,
        `deferred-${action}`,
      );
      await waitFor(() => backend.writes.length === 2);
      expect(backend.bodyRefs[1]?.some((value) => value !== 0)).toBe(true);

      if (action === "cancel") {
        await port.cancel(upload.transferId);
      } else {
        port.clearVolatile();
      }

      // updateSelf owns its outbound view until the final request settles.
      expect(backend.bodyRefs[1]?.some((value) => value !== 0)).toBe(true);
      expect(backend.aborts).toContain(nat(70));
      const beforeReceipt = (await port.status()).transfers.find(
        (transfer) => transfer.id === upload.transferId,
      );
      if (action === "cancel") {
        expect(beforeReceipt).toMatchObject({ phase: "cancelled" });
      } else {
        expect(beforeReceipt).toBeUndefined();
      }

      backend.release(1);
      await waitFor(() => statusReasons.length === 1);
      expect(backend.bodyRefs[1]?.every((value) => value === 0)).toBe(true);
      const afterReceipt = (await port.status()).transfers.find(
        (transfer) => transfer.id === upload.transferId,
      );
      if (action === "cancel") {
        expect(afterReceipt).toMatchObject({ phase: "committed" });
      } else {
        expect(afterReceipt).toBeUndefined();
      }
      expect(backend.committedEntry).not.toBeNull();
      expect(statusReasons).toEqual(["state_changed"]);
    }
  });

  test("tracked direct writes reconcile cancellation and lost responses", async () => {
    const payload = twoBlockPayload();
    const backend = new DeferredUploadBackend();
    backend.hold(1);
    const port = new DefaultFilesPlainPort({
      backend: asBackend(backend),
    });
    const reasons: string[] = [];
    port.onStatusChange((reason) => reasons.push(reason));
    const writing = port.write({
      transferId: "direct-cancel-race",
      path: "/Workspace/direct-cancel-race.bin",
      source: testSource(payload, "direct-cancel-race.bin"),
      contentKind: "binary",
      mediaType: "application/octet-stream",
      ifMatch: null,
      ifNoneMatch: true,
      createParents: true,
    });

    await waitFor(() => backend.writes.length === 2);
    await port.cancel("direct-cancel-race");
    expect(backend.aborts).toEqual([nat(70)]);
    backend.release(1);
    await expect(writing).resolves.toMatchObject({
      entry: {
        path: "/Workspace/direct-cancel-race.bin",
        etagSha256: expect.any(String),
      },
    });
    expect(
      (await port.status()).transfers.find(
        (transfer) => transfer.id === "direct-cancel-race",
      ),
    ).toMatchObject({ phase: "committed" });
    expect(reasons).toEqual(["state_changed"]);

    const clearBackend = new DeferredUploadBackend();
    clearBackend.hold(1);
    const clearPort = new DefaultFilesPlainPort({
      backend: asBackend(clearBackend),
    });
    const clearReasons: string[] = [];
    clearPort.onStatusChange((reason) => clearReasons.push(reason));
    const clearedWrite = clearPort.write({
      transferId: "direct-clear-race",
      path: "/Workspace/direct-clear-race.bin",
      source: testSource(payload, "direct-clear-race.bin"),
      contentKind: "binary",
      mediaType: "application/octet-stream",
      ifMatch: null,
      ifNoneMatch: true,
      createParents: true,
    });
    await waitFor(() => clearBackend.writes.length === 2);
    clearPort.clearVolatile();
    expect((await clearPort.status()).transfers).toEqual([]);
    clearBackend.release(1);
    await expect(clearedWrite).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(clearBackend.committedEntry).not.toBeNull();
    expect((await clearPort.status()).transfers).toEqual([]);
    expect(clearReasons).toEqual(["state_changed"]);

    const ambiguousBackend = new DeferredUploadBackend();
    ambiguousBackend.ambiguousFinal = true;
    const ambiguousPort = new DefaultFilesPlainPort({
      backend: asBackend(ambiguousBackend),
    });
    await expect(ambiguousPort.write({
      transferId: "direct-ambiguous",
      path: "/Workspace/direct-ambiguous.txt",
      source: testSource(
        new TextEncoder().encode("saved despite a lost response"),
        "direct-ambiguous.txt",
        "text/plain",
      ),
      contentKind: "text",
      mediaType: "text/plain",
      ifMatch: null,
      ifNoneMatch: true,
      createParents: true,
    })).resolves.toMatchObject({
      entry: {
        path: "/Workspace/direct-ambiguous.txt",
        contentKind: "text",
      },
    });
    expect(ambiguousBackend.statCalls).toBe(1);
    expect(
      (await ambiguousPort.status()).transfers.find(
        (transfer) => transfer.id === "direct-ambiguous",
      ),
    ).toMatchObject({ phase: "committed" });
  });

  test("tracked direct writes replay only ambiguous non-final blocks", async () => {
    const backend = new DeferredUploadBackend();
    backend.ambiguousOnceOrdinal = 0;
    const port = new DefaultFilesPlainPort({
      backend: asBackend(backend),
    });
    await expect(port.write({
      transferId: "direct-replay",
      path: "/Workspace/direct-replay.bin",
      source: testSource(twoBlockPayload(), "direct-replay.bin"),
      contentKind: "binary",
      mediaType: "application/octet-stream",
      ifMatch: null,
      ifNoneMatch: true,
      createParents: true,
    })).resolves.toMatchObject({
      entry: { path: "/Workspace/direct-replay.bin" },
    });
    expect(backend.writes.map((write) => write.blockIndex)).toEqual([
      0,
      0,
      1,
    ]);
  });

  test("tracked direct writes do not replay explicit backend rejection", async () => {
    const backend = new DeferredUploadBackend();
    backend.rejectOrdinal = 0;
    const port = new DefaultFilesPlainPort({
      backend: asBackend(backend),
    });
    await expect(port.write({
      transferId: "direct-rejected",
      path: "/Workspace/direct-rejected.txt",
      source: testSource(
        new TextEncoder().encode("conflict"),
        "direct-rejected.txt",
        "text/plain",
      ),
      contentKind: "text",
      mediaType: "text/plain",
      ifMatch: null,
      ifNoneMatch: true,
      createParents: true,
    })).rejects.toMatchObject({ code: "conflict" });
    expect(backend.writes).toHaveLength(1);
    expect(backend.statCalls).toBe(0);
    expect(
      (await port.status()).transfers.find(
        (transfer) => transfer.id === "direct-rejected",
      ),
    ).toMatchObject({ phase: "conflicted" });
  });

  test("direct writes reject a same-length second-pass mutation before final", async () => {
    const backend = new DeferredUploadBackend();
    const port = new DefaultFilesPlainPort({
      backend: asBackend(backend),
    });
    const firstPass = twoBlockPayload();
    const uploadPass = firstPass.slice();
    const lastIndex = uploadPass.byteLength - 1;
    uploadPass[lastIndex] = uploadPass[lastIndex]! ^ 0xff;
    const source = twoPassSource(
      firstPass,
      uploadPass,
      "mutable-direct.bin",
    );

    await expect(port.write({
      path: "/Workspace/mutable-direct.bin",
      source,
      contentKind: "binary",
      mediaType: "application/octet-stream",
      ifMatch: null,
      ifNoneMatch: true,
      createParents: false,
    })).rejects.toMatchObject({
      code: "invalid",
      message: "The file changed while it was being uploaded",
    });

    expect(source.sliceCalls()).toBe(4);
    expect(backend.writes.map((write) => write.blockIndex)).toEqual([0]);
    expect(backend.committedEntry).toBeNull();
    expect(backend.aborts).toEqual([nat(70)]);
    expect(backend.bodyRefs.every(
      (body) => body.every((value) => value === 0),
    )).toBe(true);
  });

  test("streamed direct and deferred uploads reject changed second-pass bytes", async () => {
    for (const mode of ["direct", "deferred"] as const) {
      const backend = new DeferredUploadBackend();
      const port = new DefaultFilesPlainPort({
        backend: asBackend(backend),
      });
      const firstPass = twoBlockPayload();
      const uploadPass = firstPass.slice();
      const lastIndex = uploadPass.byteLength - 1;
      uploadPass[lastIndex] = uploadPass[lastIndex]! ^ 0xff;
      const chunks = [
        firstPass.slice(0, FILES_V2_LIMITS.normalPlaintextBlockBytes),
        firstPass.slice(FILES_V2_LIMITS.normalPlaintextBlockBytes),
      ];
      const uploadChunks = [
        uploadPass.slice(0, FILES_V2_LIMITS.normalPlaintextBlockBytes),
        uploadPass.slice(FILES_V2_LIMITS.normalPlaintextBlockBytes),
      ];
      const transferId = `mutable-stream-${mode}`;
      await port.beginUpload({
        transferId,
        path: `/Workspace/${transferId}.bin`,
        name: `${transferId}.bin`,
        mediaType: "application/octet-stream",
        size: firstPass.byteLength,
        contentKind: "binary",
      });
      for (const [ordinal, chunk] of chunks.entries()) {
        const data = arrayBuffer(chunk);
        await port.uploadChunk({
          transferId,
          pass: "hash",
          ordinal,
          final: ordinal === 1,
          totalBytes: firstPass.byteLength,
        }, data);
        expect(new Uint8Array(data).every((value) => value === 0)).toBe(true);
      }
      const firstUpload = arrayBuffer(uploadChunks[0]!);
      await port.uploadChunk({
        transferId,
        pass: "encrypt",
        ordinal: 0,
        final: false,
        totalBytes: firstPass.byteLength,
      }, firstUpload, {
        deferFinalCommit: mode === "deferred",
      });
      expect(
        new Uint8Array(firstUpload).every((value) => value === 0),
      ).toBe(true);

      const finalUpload = arrayBuffer(uploadChunks[1]!);
      await expect(port.uploadChunk({
        transferId,
        pass: "encrypt",
        ordinal: 1,
        final: true,
        totalBytes: firstPass.byteLength,
      }, finalUpload, {
        deferFinalCommit: mode === "deferred",
      })).rejects.toMatchObject({
        code: "invalid",
        message: "The file changed while it was being uploaded",
      });
      expect(
        new Uint8Array(finalUpload).every((value) => value === 0),
      ).toBe(true);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));

      expect(backend.writes.map((write) => write.blockIndex)).toEqual(
        mode === "direct" ? [0] : [],
      );
      expect(backend.aborts).toEqual(
        mode === "direct" ? [nat(70)] : [null],
      );
      expect(
        (await port.status()).transfers.find(
          (transfer) => transfer.id === transferId,
        ),
      ).toMatchObject({
        phase: "failed",
        error: "The file changed while it was being uploaded",
      });
      expect(backend.bodyRefs.every(
        (body) => body.every((value) => value === 0),
      )).toBe(true);
    }
  });

  test("untracked writes abort a known stage on cancellation and rejection", async () => {
    const cancelledBackend = new DeferredUploadBackend();
    const cancelledPort = new DefaultFilesPlainPort({
      backend: asBackend(cancelledBackend),
    });
    const controller = new AbortController();
    await expect(cancelledPort.write({
      path: "/Workspace/untracked-cancel.bin",
      source: testSource(twoBlockPayload(), "untracked-cancel.bin"),
      contentKind: "binary",
      mediaType: "application/octet-stream",
      ifMatch: null,
      ifNoneMatch: true,
      createParents: false,
    }, {
      signal: controller.signal,
      onProgress(progress) {
        if (progress.phase === "uploading" && progress.blockIndex === 0) {
          controller.abort();
        }
      },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelledBackend.writes.map(
      (write) => write.blockIndex,
    )).toEqual([0]);
    expect(cancelledBackend.aborts).toEqual([nat(70)]);

    const rejectedBackend = new DeferredUploadBackend();
    rejectedBackend.rejectOrdinal = 1;
    const rejectedPort = new DefaultFilesPlainPort({
      backend: asBackend(rejectedBackend),
    });
    await expect(rejectedPort.write({
      path: "/Workspace/untracked-reject.bin",
      source: testSource(twoBlockPayload(), "untracked-reject.bin"),
      contentKind: "binary",
      mediaType: "application/octet-stream",
      ifMatch: null,
      ifNoneMatch: true,
      createParents: false,
    })).rejects.toMatchObject({ code: "conflict" });
    expect(rejectedBackend.writes.map(
      (write) => write.blockIndex,
    )).toEqual([0, 1]);
    expect(rejectedBackend.aborts).toEqual([nat(70)]);
  });

  test("an aborted signal cannot authorize ambiguous block replay", async () => {
    const backend = new DeferredUploadBackend();
    const controller = new AbortController();
    backend.ambiguousOnceOrdinal = 0;
    backend.onAmbiguousOnce = () => controller.abort();
    const port = new DefaultFilesPlainPort({
      backend: asBackend(backend),
    });

    await expect(port.write({
      path: "/Workspace/no-replay-after-abort.bin",
      source: testSource(twoBlockPayload(), "no-replay-after-abort.bin"),
      contentKind: "binary",
      mediaType: "application/octet-stream",
      ifMatch: null,
      ifNoneMatch: true,
      createParents: false,
    }, {
      signal: controller.signal,
    })).rejects.toThrow("lost non-final response");
    expect(backend.writes.map((write) => write.blockIndex)).toEqual([0]);
  });

  test("tracked cancellation is visible while destination stat is pending", async () => {
    const existing = file("/cancel-before-stat.bin", {
      nodeId: nat(45),
      revision: nat(8),
      etagSha256: "d".repeat(64),
    });
    const backend = new GatedStatBackend(existing);
    const port = new DefaultFilesPlainPort({
      backend: asBackend(backend),
    });
    const writing = port.write({
      transferId: "cancel-before-stat",
      path: "/Workspace/cancel-before-stat.bin",
      source: testSource(Uint8Array.of(1), "cancel-before-stat.bin"),
      contentKind: "binary",
      mediaType: "application/octet-stream",
      ifMatch: existing.etagSha256,
      ifNoneMatch: false,
      createParents: false,
    });
    await waitFor(() => backend.statStarted);

    await port.cancel("cancel-before-stat");
    backend.releaseStat();
    await expect(writing).rejects.toMatchObject({ code: "cancelled" });
    expect(backend.writes).toEqual([]);
    expect(
      (await port.status()).transfers.find(
        (transfer) => transfer.id === "cancel-before-stat",
      ),
    ).toMatchObject({ phase: "cancelled" });
  });

  test("deferred uploads are count-bounded, byte-bounded, and expire", async () => {
    const backend = new DeferredUploadBackend();
    const timers = new ManualUploadTimers();
    const blockBytes = FILES_V2_LIMITS.normalPlaintextBlockBytes;
    const port = new DefaultFilesPlainPort({
      backend: asBackend(backend),
      uploadInactivityMs: 10,
      maxDeferredResidentBytes: blockBytes,
      scheduleUploadTimer: timers.schedule,
    });
    const first = new Uint8Array(blockBytes);
    first.fill(61);
    const last = Uint8Array.of(67);
    const totalBytes = first.byteLength + last.byteLength;

    await port.beginUpload({
      transferId: "bounded-one",
      path: "/Workspace/bounded-one.bin",
      name: "bounded-one.bin",
      mediaType: "application/octet-stream",
      size: totalBytes,
      contentKind: "binary",
    });
    await expect(port.beginUpload({
      transferId: "bounded-two",
      path: "/Workspace/bounded-two.bin",
      name: "bounded-two.bin",
      mediaType: "application/octet-stream",
      size: 1,
      contentKind: "binary",
    })).rejects.toMatchObject({ code: "temporarily_unavailable" });
    for (const [ordinal, chunk] of [first, last].entries()) {
      await port.uploadChunk({
        transferId: "bounded-one",
        pass: "hash",
        ordinal,
        final: ordinal === 1,
        totalBytes,
      }, arrayBuffer(chunk));
    }
    await port.uploadChunk({
      transferId: "bounded-one",
      pass: "encrypt",
      ordinal: 0,
      final: false,
      totalBytes,
    }, arrayBuffer(first), { deferFinalCommit: true });
    await expect(port.uploadChunk({
      transferId: "bounded-one",
      pass: "encrypt",
      ordinal: 1,
      final: true,
      totalBytes,
    }, arrayBuffer(last), {
      deferFinalCommit: true,
    })).rejects.toMatchObject({ code: "temporarily_unavailable" });
    expect(backend.writes).toEqual([]);
    expect(backend.aborts).toEqual([null]);

    await port.beginUpload({
      transferId: "expires",
      path: "/Workspace/expires.bin",
      name: "expires.bin",
      mediaType: "application/octet-stream",
      size: totalBytes,
      contentKind: "binary",
    });
    for (const [ordinal, chunk] of [first, last].entries()) {
      await port.uploadChunk({
        transferId: "expires",
        pass: "hash",
        ordinal,
        final: ordinal === 1,
        totalBytes,
      }, arrayBuffer(chunk));
    }
    await port.uploadChunk({
      transferId: "expires",
      pass: "encrypt",
      ordinal: 0,
      final: false,
      totalBytes,
    }, arrayBuffer(first), { deferFinalCommit: true });
    const expiredTimer = timers.latestIndex();
    timers.fire(expiredTimer);
    await waitFor(async () =>
      (await port.status()).transfers.some(
        (transfer) =>
          transfer.id === "expires" &&
          transfer.phase === "failed",
      )
    );
    expect(backend.writes).toEqual([]);
    expect(backend.aborts).toEqual([null, null]);

    await port.beginUpload({
      transferId: "expires",
      path: "/Workspace/reused-after-expiry.bin",
      name: "reused-after-expiry.bin",
      mediaType: "application/octet-stream",
      size: 1,
      contentKind: "binary",
    });
    timers.fire(expiredTimer);
    expect(
      (await port.status()).transfers.find(
        (transfer) => transfer.id === "expires",
      ),
    ).toMatchObject({
      label: "reused-after-expiry.bin",
      phase: "hashing",
    });
    await port.cancel("expires");

    await port.beginUpload({
      transferId: "direct-expiry",
      path: "/Workspace/direct-expiry.bin",
      name: "direct-expiry.bin",
      mediaType: "application/octet-stream",
      size: totalBytes,
      contentKind: "binary",
    });
    for (const [ordinal, chunk] of [first, last].entries()) {
      await port.uploadChunk({
        transferId: "direct-expiry",
        pass: "hash",
        ordinal,
        final: ordinal === 1,
        totalBytes,
      }, arrayBuffer(chunk));
    }
    await port.uploadChunk({
      transferId: "direct-expiry",
      pass: "encrypt",
      ordinal: 0,
      final: false,
      totalBytes,
    }, arrayBuffer(first));
    timers.fire(timers.latestIndex());
    await waitFor(async () =>
      (await port.status()).transfers.some(
        (transfer) =>
          transfer.id === "direct-expiry" &&
          transfer.phase === "failed",
      )
    );
    expect(backend.aborts.at(-1)).toBe(nat(70));

    expect(() => new DefaultFilesPlainPort({
      backend: asBackend(backend),
      uploadInactivityMs: 120_001,
    })).toThrow(TypeError);
  });

  test("late committed receipts cannot clobber a reused transfer id", async () => {
    const deferredBackend = new DeferredUploadBackend();
    deferredBackend.hold(1);
    const deferredPort = new DefaultFilesPlainPort({
      backend: asBackend(deferredBackend),
    });
    const oldPayload = twoBlockPayload();
    const oldChunks = [
      oldPayload.slice(0, FILES_V2_LIMITS.normalPlaintextBlockBytes),
      oldPayload.slice(FILES_V2_LIMITS.normalPlaintextBlockBytes),
    ];
    const oldTransferId = "reused-upload";
    await deferredPort.beginUpload({
      transferId: oldTransferId,
      path: "/Workspace/old-upload.bin",
      name: "old-upload.bin",
      mediaType: "application/octet-stream",
      size: oldPayload.byteLength,
      contentKind: "binary",
    });
    for (const [ordinal, chunk] of oldChunks.entries()) {
      await deferredPort.uploadChunk({
        transferId: oldTransferId,
        pass: "hash",
        ordinal,
        final: ordinal === 1,
        totalBytes: oldPayload.byteLength,
      }, arrayBuffer(chunk));
    }
    await deferredPort.uploadChunk({
      transferId: oldTransferId,
      pass: "encrypt",
      ordinal: 0,
      final: false,
      totalBytes: oldPayload.byteLength,
    }, arrayBuffer(oldChunks[0]!));
    const oldFinalUpload = deferredPort.uploadChunk({
      transferId: oldTransferId,
      pass: "encrypt",
      ordinal: 1,
      final: true,
      totalBytes: oldPayload.byteLength,
    }, arrayBuffer(oldChunks[1]!));
    await waitFor(() => deferredBackend.writes.length === 2);
    await deferredPort.cancel(oldTransferId);
    await deferredPort.beginUpload({
      transferId: oldTransferId,
      path: "/Workspace/new-upload.bin",
      name: "new-upload.bin",
      mediaType: "application/octet-stream",
      size: 1,
      contentKind: "binary",
    });
    deferredBackend.release(1);
    await expect(oldFinalUpload).resolves.toMatchObject({
      committed: true,
    });
    await waitFor(() =>
      deferredBackend.bodyRefs[1]?.every((value) => value === 0) === true
    );
    expect(
      (await deferredPort.status()).transfers.find(
        (transfer) => transfer.id === oldTransferId,
      ),
    ).toMatchObject({
      label: "new-upload.bin",
      phase: "hashing",
    });
    const newHash = arrayBuffer(Uint8Array.of(91));
    await deferredPort.uploadChunk({
      transferId: oldTransferId,
      pass: "hash",
      ordinal: 0,
      final: true,
      totalBytes: 1,
    }, newHash);
    const newUpload = arrayBuffer(Uint8Array.of(91));
    await expect(deferredPort.uploadChunk({
      transferId: oldTransferId,
      pass: "encrypt",
      ordinal: 0,
      final: true,
      totalBytes: 1,
    }, newUpload)).resolves.toMatchObject({ committed: true });

    const directBackend = new DeferredUploadBackend();
    directBackend.hold(1);
    const directPort = new DefaultFilesPlainPort({
      backend: asBackend(directBackend),
    });
    const oldWrite = directPort.write({
      transferId: "reused-write",
      path: "/Workspace/old-write.bin",
      source: testSource(twoBlockPayload(), "old-write.bin"),
      contentKind: "binary",
      mediaType: "application/octet-stream",
      ifMatch: null,
      ifNoneMatch: true,
      createParents: false,
    });
    await waitFor(() => directBackend.writes.length === 2);
    await directPort.cancel("reused-write");
    await expect(directPort.write({
      transferId: "reused-write",
      path: "/Workspace/new-write.bin",
      source: testSource(Uint8Array.of(79), "new-write.bin"),
      contentKind: "binary",
      mediaType: "application/octet-stream",
      ifMatch: null,
      ifNoneMatch: true,
      createParents: false,
    })).resolves.toMatchObject({
      entry: { path: "/Workspace/new-write.bin" },
    });
    directBackend.release(1);
    await expect(oldWrite).resolves.toMatchObject({
      entry: { path: "/Workspace/old-write.bin" },
    });
    expect(
      (await directPort.status()).transfers.find(
        (transfer) => transfer.id === "reused-write",
      ),
    ).toMatchObject({
      label: "new-write.bin",
      phase: "committed",
    });
  });

  test("pins stable node identity on every plaintext replacement and delete", async () => {
    const moveCalls: Record<string, unknown>[] = [];
    const removeCalls: Record<string, unknown>[] = [];
    const writes: FilesPlainWriteInput[] = [];
    const existingEtag = "a".repeat(64);
    const sourceEtag = "b".repeat(64);
    const backend = {
      stat(input: { path: string }): Promise<FilesPlainEntry> {
        return Promise.resolve(file(input.path, {
          nodeId: input.path === "/replace.txt" ? nat(45) : nat(44),
          revision: input.path === "/replace.txt" ? nat(8) : nat(7),
          etagSha256:
            input.path === "/replace.txt" ? existingEtag : sourceEtag,
        }));
      },
      move(input: Record<string, unknown>): Promise<FilesPlainMutationResult> {
        moveCalls.push(input);
        return Promise.resolve({
          path: "/renamed",
          revision: nat(8),
          changed: 1,
        });
      },
      remove(input: Record<string, unknown>): Promise<FilesPlainMutationResult> {
        removeCalls.push(input);
        return Promise.resolve({
          path: "/item",
          revision: nat(9),
          changed: 1,
        });
      },
      writeBlock(
        input: FilesPlainWriteInput,
      ): Promise<FilesPlainWriteResult> {
        writes.push(input);
        const expectedIdentity =
          input.moveSource ??
          (
            input.expectedNodeId === null ||
              input.expectedRevision === null
              ? null
              : {
                  expectedNodeId: input.expectedNodeId,
                  expectedRevision: input.expectedRevision,
                }
          );
        return Promise.resolve({
          stageId: null,
          committed: input.final,
          entry: input.final
            ? file(input.path, {
                nodeId: expectedIdentity?.expectedNodeId ?? nat(50),
                revision:
                  expectedIdentity === null
                    ? nat(1)
                    : incrementNat(expectedIdentity.expectedRevision),
                contentKind: input.contentKind,
                byteLength: input.totalBytes,
                mediaType: input.mediaType,
                etagSha256: input.etagSha256,
                relativeUrl:
                  input.space === "shared"
                    ? `/app/files/_route/shares/${"c".repeat(64)}/${input.safeName}`
                    : null,
              })
            : null,
        });
      },
    };
    const port = new DefaultFilesPlainPort({
      backend: asBackend(backend),
    });

    await port.move(
      "/Workspace/item",
      "/Workspace/renamed",
      false,
    );
    await port.remove(
      "/Workspace/item",
      false,
      undefined,
      {
        nodeId: nat(44),
        structuralRevision: nat(7),
        etagSha256: sourceEtag,
      },
    );
    await port.write({
      path: "/Workspace/replace.txt",
      source: testSource(Uint8Array.of(1), "replace.txt"),
      contentKind: "binary",
      mediaType: "application/octet-stream",
      ifMatch: existingEtag,
      ifNoneMatch: false,
      createParents: false,
    });
    await port.write({
      path: "/Shared/new-name.txt",
      source: testSource(Uint8Array.of(2), "new-name.txt"),
      contentKind: "binary",
      mediaType: "application/octet-stream",
      ifMatch: null,
      ifNoneMatch: true,
      createParents: false,
      moveSource: {
        path: "/Shared/old-name.txt",
        nodeId: nat(44),
        structuralRevision: nat(7),
        etagSha256: sourceEtag,
      },
    });
    await port.writeMany([
      {
        path: "/Workspace/batch.txt",
        text: "replace",
        overwrite: true,
        createParents: false,
        mediaType: "text/plain",
      },
    ]);

    expect(moveCalls[0]).toMatchObject({
      expectedNodeId: "44",
      expectedRevision: "7",
      ifMatch: sourceEtag,
    });
    expect(removeCalls[0]).toMatchObject({
      expectedNodeId: "44",
      expectedRevision: "7",
      ifMatch: sourceEtag,
    });
    expect(writes[0]).toMatchObject({
      expectedNodeId: "45",
      expectedRevision: "8",
      ifMatch: existingEtag,
      moveSource: null,
    });
    expect(writes[1]).toMatchObject({
      expectedNodeId: null,
      expectedRevision: null,
      ifMatch: null,
      moveSource: {
        path: "/old-name.txt",
        expectedNodeId: "44",
        expectedRevision: "7",
        ifMatch: sourceEtag,
      },
    });
    expect(writes[2]).toMatchObject({
      expectedNodeId: "44",
      expectedRevision: "7",
      ifMatch: sourceEtag,
      moveSource: null,
    });

    await expect(
      port.remove(
        "/Workspace/item",
        false,
        undefined,
        {
          nodeId: nat(99),
          structuralRevision: nat(7),
          etagSha256: sourceEtag,
        },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(removeCalls).toHaveLength(1);
  });
});

class ParentPlanningBackend {
  readonly writes: FilesPlainWriteInput[] = [];
  readonly mkdirCalls: string[] = [];
  readonly aborts: Array<CanonicalNat64 | null> = [];
  rejectOrdinal: number | null = null;
  statCalls = 0;

  stat(): Promise<FilesPlainEntry> {
    this.statCalls += 1;
    return Promise.reject(new FilesPlainBackendError("not_found"));
  }

  mkdir(input: {
    path: string;
  }): Promise<FilesPlainMutationResult> {
    this.mkdirCalls.push(input.path);
    return Promise.resolve({
      path: input.path,
      revision: nat(1),
      changed: 1,
    });
  }

  abort(input: {
    stageId: CanonicalNat64 | null;
  }): Promise<FilesPlainMutationResult> {
    this.aborts.push(input.stageId);
    return Promise.resolve({
      path: "/",
      revision: nat(1),
      changed: 0,
    });
  }

  writeBlock(
    input: FilesPlainWriteInput,
  ): Promise<FilesPlainWriteResult> {
    this.writes.push({
      ...input,
      body: input.body.slice(),
    });
    if (input.blockIndex === this.rejectOrdinal) {
      return Promise.reject(new FilesPlainBackendError("conflict"));
    }
    return Promise.resolve({
      stageId: input.final ? null : nat(70),
      committed: input.final,
      entry: input.final
        ? file(input.path, {
          contentKind: input.contentKind,
          byteLength: input.totalBytes,
          mediaType: input.mediaType,
          etagSha256: input.etagSha256,
          relativeUrl: input.space === "shared"
            ? `/app/files/_route/shares/${"d".repeat(64)}/${input.safeName}`
            : null,
        })
        : null,
    });
  }
}

class UploadBackend {
  readonly writes: FilesPlainWriteInput[] = [];

  writeBlock(
    input: FilesPlainWriteInput,
  ): Promise<FilesPlainWriteResult> {
    this.writes.push({
      ...input,
      body: input.body.slice(),
    });
    return Promise.resolve({
      stageId: input.final ? null : nat(70),
      committed: input.final,
      entry: input.final
        ? file(input.path, {
          contentKind: input.contentKind,
          byteLength: input.totalBytes,
          mediaType: input.mediaType,
          etagSha256: input.etagSha256,
          relativeUrl:
            `/app/files/_route/shares/${"c".repeat(64)}/${input.safeName}`,
        })
        : null,
    });
  }
}

class RecursiveRemovalBackend {
  readonly listCalls: Array<Readonly<{
    cursor: FilesPlainCursor | null;
    revision: CanonicalNat64;
  }>> = [];
  readonly offeredCursors: FilesPlainCursor[] = [];
  readonly removeCalls: string[] = [];
  revision = 1;

  constructor(readonly remaining: FilesPlainEntry[]) {}

  stat(input: {
    path: string;
  }): Promise<FilesPlainEntry> {
    if (input.path === "/folder") {
      return Promise.resolve(folder("/folder", this.revision));
    }
    const entry = this.remaining.find((item) => item.path === input.path);
    if (!entry) throw new Error(`Unexpected stat: ${input.path}`);
    return Promise.resolve(entry);
  }

  list(input: {
    path: string;
    cursor: FilesPlainCursor | null;
  }): Promise<FilesPlainList> {
    if (input.path !== "/folder") {
      throw new Error(`Unexpected list: ${input.path}`);
    }
    if (input.cursor !== null) {
      throw new Error("Recursive removal reused a stale cursor");
    }
    this.listCalls.push({
      cursor: input.cursor,
      revision: nat(this.revision),
    });
    const entries = this.remaining.slice(0, 1);
    const hasMore = this.remaining.length > entries.length;
    const cursor = hasMore
      ? {
          after: entries[0]?.name ?? "",
          revision: nat(this.revision),
          parentNodeId: nat(1),
          seen: entries.length,
          total: this.remaining.length,
        }
      : null;
    if (cursor !== null) this.offeredCursors.push(cursor);
    return Promise.resolve({
      revision: nat(this.revision),
      entries,
      total: this.remaining.length,
      cursor,
      hasMore,
    });
  }

  remove(input: {
    path: string;
  }): Promise<FilesPlainMutationResult> {
    this.removeCalls.push(input.path);
    if (input.path === "/folder") {
      if (this.remaining.length !== 0) {
        throw new Error("Folder was removed before its children");
      }
    } else {
      const index = this.remaining.findIndex(
        (entry) => entry.path === input.path,
      );
      if (index < 0) throw new Error(`Unexpected remove: ${input.path}`);
      this.remaining.splice(index, 1);
    }
    this.revision += 1;
    return Promise.resolve({
      path: input.path,
      revision: nat(this.revision),
      changed: 1,
    });
  }
}

class DeferredUploadBackend {
  readonly writes: FilesPlainWriteInput[] = [];
  readonly bodyRefs: Uint8Array[] = [];
  readonly aborts: Array<CanonicalNat64 | null> = [];
  readonly #gates = new Map<number, {
    promise: Promise<void>;
    release: () => void;
  }>();
  failOrdinal: number | null = null;
  rejectOrdinal: number | null = null;
  ambiguousOnceOrdinal: number | null = null;
  onAmbiguousOnce: (() => void) | null = null;
  ambiguousFinal = false;
  committedEntry: FilesPlainEntry | null = null;
  statCalls = 0;
  #ambiguousOrdinalThrown = false;

  hold(ordinal: number): void {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#gates.set(ordinal, { promise, release });
  }

  release(ordinal: number): void {
    this.#gates.get(ordinal)?.release();
  }

  async writeBlock(
    input: FilesPlainWriteInput,
  ): Promise<FilesPlainWriteResult> {
    this.writes.push(input);
    this.bodyRefs.push(input.body);
    await this.#gates.get(input.blockIndex)?.promise;
    if (input.blockIndex === this.failOrdinal) {
      throw new Error("deferred backend failure");
    }
    if (input.blockIndex === this.rejectOrdinal) {
      throw new FilesPlainBackendError("conflict");
    }
    const entry = input.final
      ? file(input.path, {
          contentKind: input.contentKind,
          byteLength: input.totalBytes,
          mediaType: input.mediaType,
          etagSha256: input.etagSha256,
          relativeUrl: null,
        })
      : null;
    if (entry !== null) this.committedEntry = entry;
    if (
      input.blockIndex === this.ambiguousOnceOrdinal &&
      !this.#ambiguousOrdinalThrown
    ) {
      this.#ambiguousOrdinalThrown = true;
      this.onAmbiguousOnce?.();
      throw new Error("lost non-final response");
    }
    if (input.final && this.ambiguousFinal) {
      throw new Error("lost final response");
    }
    return {
      stageId: input.final ? null : nat(70),
      committed: input.final,
      entry,
    };
  }

  stat(input: {
    path: string;
  }): Promise<FilesPlainEntry> {
    this.statCalls += 1;
    if (
      this.committedEntry === null ||
      this.committedEntry.path !== input.path
    ) {
      return Promise.reject(new Error("not found"));
    }
    return Promise.resolve(this.committedEntry);
  }

  abort(input: {
    stageId: CanonicalNat64 | null;
  }): Promise<FilesPlainMutationResult> {
    this.aborts.push(input.stageId);
    return Promise.resolve({
      path: "/",
      revision: nat(1),
      changed: 0,
    });
  }
}

class GatedStatBackend {
  readonly writes: FilesPlainWriteInput[] = [];
  statStarted = false;
  readonly #entry: FilesPlainEntry;
  readonly #statGate: Promise<void>;
  #releaseStat!: () => void;

  constructor(entry: FilesPlainEntry) {
    this.#entry = entry;
    this.#statGate = new Promise<void>((resolve) => {
      this.#releaseStat = resolve;
    });
  }

  releaseStat(): void {
    this.#releaseStat();
  }

  async stat(): Promise<FilesPlainEntry> {
    this.statStarted = true;
    await this.#statGate;
    return this.#entry;
  }

  writeBlock(
    input: FilesPlainWriteInput,
  ): Promise<FilesPlainWriteResult> {
    this.writes.push(input);
    return Promise.resolve({
      stageId: input.final ? null : nat(70),
      committed: input.final,
      entry: input.final
        ? file(input.path, {
            contentKind: input.contentKind,
            byteLength: input.totalBytes,
            mediaType: input.mediaType,
            etagSha256: input.etagSha256,
          })
        : null,
    });
  }
}

class ManualUploadTimers {
  readonly records: Array<{
    callback: () => void;
    cancelled: boolean;
    delayMs: number;
  }> = [];

  readonly schedule = (
    callback: () => void,
    delayMs: number,
  ): (() => void) => {
    const record = {
      callback,
      cancelled: false,
      delayMs,
    };
    this.records.push(record);
    return () => {
      record.cancelled = true;
    };
  };

  latestIndex(): number {
    const index = this.records.length - 1;
    if (index < 0) throw new Error("No Files upload timer was scheduled");
    expect(this.records[index]?.delayMs).toBe(10);
    return index;
  }

  fire(index: number): void {
    const record = this.records[index];
    if (record === undefined) {
      throw new Error(`Missing Files upload timer ${index}`);
    }
    // Tests may deliberately invoke a cancelled callback to prove its
    // captured epoch cannot affect a reused transfer id.
    record.callback();
  }
}

function asBackend(
  value: object,
): FilesPlainBackendAdapter {
  return value as unknown as FilesPlainBackendAdapter;
}

async function acceptTwoPassUpload(
  port: DefaultFilesPlainPort,
  backend: DeferredUploadBackend,
  transferId: string,
) {
  const first = new Uint8Array(
    FILES_V2_LIMITS.normalPlaintextBlockBytes,
  );
  first.fill(19);
  const last = Uint8Array.of(23, 29, 31);
  const chunks = [first, last] as const;
  const totalBytes = first.byteLength + last.byteLength;
  await port.beginUpload({
    transferId,
    path: `/Workspace/${transferId}.bin`,
    name: `${transferId}.bin`,
    mediaType: "application/octet-stream",
    size: totalBytes,
    contentKind: "binary",
  });
  for (const [ordinal, chunk] of chunks.entries()) {
    const data = arrayBuffer(chunk);
    await port.uploadChunk(
      {
        transferId,
        pass: "hash",
        ordinal,
        final: ordinal + 1 === chunks.length,
        totalBytes,
      },
      data,
    );
    expect(new Uint8Array(data).every((value) => value === 0)).toBe(true);
  }
  const firstUpload = arrayBuffer(first);
  await port.uploadChunk(
    {
      transferId,
      pass: "encrypt",
      ordinal: 0,
      final: false,
      totalBytes,
    },
    firstUpload,
    { deferFinalCommit: true },
  );
  expect(
    new Uint8Array(firstUpload).every((value) => value === 0),
  ).toBe(true);
  expect(backend.writes).toHaveLength(0);
  const finalUpload = arrayBuffer(last);
  const accepted = await port.uploadChunk(
    {
      transferId,
      pass: "encrypt",
      ordinal: 1,
      final: true,
      totalBytes,
    },
    finalUpload,
    { deferFinalCommit: true },
  );
  expect(
    new Uint8Array(finalUpload).every((value) => value === 0),
  ).toBe(true);
  return { transferId, totalBytes, accepted };
}

function twoBlockPayload(): Uint8Array {
  const output = new Uint8Array(
    FILES_V2_LIMITS.normalPlaintextBlockBytes + 3,
  );
  output.fill(37);
  output.set([41, 43, 47], output.byteLength - 3);
  return output;
}

function testSource(
  bytes: Uint8Array,
  name: string,
  type = "application/octet-stream",
) {
  return {
    size: bytes.byteLength,
    name,
    type,
    slice(start: number, end: number): Uint8Array {
      return bytes.slice(start, end);
    },
  };
}

function twoPassSource(
  firstPass: Uint8Array,
  uploadPass: Uint8Array,
  name: string,
) {
  const blockCount = Math.ceil(
    firstPass.byteLength /
      FILES_V2_LIMITS.normalPlaintextBlockBytes,
  );
  let calls = 0;
  return {
    size: firstPass.byteLength,
    name,
    type: "application/octet-stream",
    slice(start: number, end: number): Uint8Array {
      const source = calls < blockCount ? firstPass : uploadPass;
      calls += 1;
      return source.slice(start, end);
    },
    sliceCalls(): number {
      return calls;
    },
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for Files plain upload state");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

function file(
  path: string,
  overrides: Partial<FilesPlainEntry> = {},
): FilesPlainEntry {
  return {
    nodeId: nat(2),
    path,
    name: path.split("/").at(-1) ?? "file",
    type: "file",
    contentKind: "binary",
    byteLength: 1,
    mediaType: "application/octet-stream",
    etagSha256: "a".repeat(64),
    createdAtNs: nat(1),
    modifiedAtNs: nat(1),
    revision: nat(1),
    relativeUrl: null,
    ...overrides,
  };
}

function folder(path: string, revision: number): FilesPlainEntry {
  return {
    nodeId: nat(1),
    path,
    name: path.split("/").at(-1) ?? "folder",
    type: "folder",
    contentKind: null,
    byteLength: null,
    mediaType: null,
    etagSha256: null,
    createdAtNs: nat(1),
    modifiedAtNs: nat(1),
    revision: nat(revision),
    relativeUrl: null,
  };
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer as ArrayBuffer;
}

function nat(value: number): CanonicalNat64 {
  return value.toString() as CanonicalNat64;
}

function incrementNat(value: CanonicalNat64): CanonicalNat64 {
  return (BigInt(value) + 1n).toString() as CanonicalNat64;
}
