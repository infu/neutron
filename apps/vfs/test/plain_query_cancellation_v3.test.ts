import { describe, expect, test } from "bun:test";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import type {
  FilesPlainBackendAdapter,
  FilesPlainEntry,
  FilesPlainList,
} from "../src/protocol/plain_backend_adapter.ts";
import type { CanonicalNat64 } from "../src/protocol/types.ts";
import { DefaultFilesPlainPort } from "../src/resident/plain_port.ts";

const SHARE_ID = "d".repeat(64);

describe("Files Plain query cancellation and authority fencing", () => {
  test("user abort releases pending stat and ignores its late response", async () => {
    const gate = deferred<FilesPlainEntry>();
    const port = portFor({ stat: async () => gate.promise });
    const controller = new AbortController();
    const pending = settleWithin(
      port.stat("/Workspace/report.txt", controller.signal),
    );

    controller.abort();
    await expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    gate.resolve(workspaceFile("/report.txt", Uint8Array.of(1)));
    await flushTasks();
  });

  test("authority change releases pending list and ignores its late page", async () => {
    const gate = deferred<FilesPlainList>();
    const port = portFor({ list: async () => gate.promise });
    const pending = settleWithin(port.list({
      path: "/Shared",
      cursor: null,
      expectedFolderRevision: null,
      limit: 10,
      recursive: false,
    }));

    port.clearVolatile("installation_changed");
    await expect(pending).rejects.toMatchObject({
      code: "cancelled",
    });
    gate.resolve({
      revision: nat(0),
      entries: [],
      total: 0,
      cursor: null,
      hasMore: false,
    });
    await flushTasks();
  });

  test("pending Workspace chunks reject promptly and wipe late bytes", async () => {
    for (const ending of ["abort", "authority"] as const) {
      const payload = Uint8Array.of(5, 7, 11);
      const entry = workspaceFile("/pending.bin", payload);
      const chunkGate = deferred<{
        entry: FilesPlainEntry;
        blockIndex: number;
        blockCount: number;
        body: Uint8Array;
      }>();
      const started = deferred<void>();
      const progress: number[] = [];
      const port = portFor({
        stat: async () => entry,
        readChunk: async () => {
          started.resolve();
          return chunkGate.promise;
        },
      });
      const controller = new AbortController();
      const reading = settleWithin(port.read("/Workspace/pending.bin", {
        signal: controller.signal,
        onProgress: (item) => progress.push(item.processedBytes),
      }));
      await started.promise;

      if (ending === "abort") {
        controller.abort();
      } else {
        port.clearVolatile("origin_authority_changed");
      }
      await expect(reading).rejects.toMatchObject(
        ending === "abort"
          ? { name: "AbortError" }
          : { code: "cancelled" },
      );
      const lateBody = payload.slice();
      chunkGate.resolve({
        entry,
        blockIndex: 0,
        blockCount: 1,
        body: lateBody,
      });
      await flushTasks();

      expect(lateBody).toEqual(Uint8Array.of(0, 0, 0));
      expect(progress).toEqual([]);
    }
  });

  test("authority change during Shared streaming cannot return copied bytes", async () => {
    const payload = Uint8Array.of(13, 17);
    const entry = sharedFile("/public.bin", payload);
    const streamed = payload.slice();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(streamed);
          controller.close();
        },
      }),
      { headers: { "content-length": "2" } },
    );
    let port!: DefaultFilesPlainPort;
    const progress: number[] = [];
    port = new DefaultFilesPlainPort({
      backend: asBackend({ stat: async () => entry }),
      publicBaseUrl: () => "https://files.example",
      fetchPublic: fetchStub(async () => response),
    });

    await expect(port.read("/Shared/public.bin", {
      onProgress: (item) => {
        progress.push(item.processedBytes);
        port.clearVolatile("origin_authority_changed");
      },
    })).rejects.toMatchObject({ code: "cancelled" });
    expect(progress).toEqual([2]);
    expect(streamed).toEqual(Uint8Array.of(0, 0));
  });
});

function workspaceFile(
  path: string,
  bytes: Uint8Array,
): FilesPlainEntry {
  return file(path, bytes, null);
}

function sharedFile(
  path: string,
  bytes: Uint8Array,
): FilesPlainEntry {
  const name = path.split("/").at(-1) ?? "file";
  return file(
    path,
    bytes,
    `/app/files/_route/shares/${SHARE_ID}/${name}`,
  );
}

function file(
  path: string,
  bytes: Uint8Array,
  relativeUrl: string | null,
): FilesPlainEntry {
  return {
    nodeId: nat(3),
    path,
    name: path.split("/").at(-1) ?? "file",
    type: "file",
    contentKind: "binary",
    byteLength: bytes.byteLength,
    mediaType: "application/octet-stream",
    etagSha256: hex(nobleSha256(bytes)),
    createdAtNs: nat(1),
    modifiedAtNs: nat(1),
    revision: nat(1),
    relativeUrl,
  };
}

function portFor(backend: object): DefaultFilesPlainPort {
  return new DefaultFilesPlainPort({
    backend: asBackend(backend),
  });
}

function asBackend(value: object): FilesPlainBackendAdapter {
  return value as unknown as FilesPlainBackendAdapter;
}

function fetchStub(
  handler: (...args: Parameters<typeof fetch>) => Promise<Response>,
): typeof fetch {
  return handler as unknown as typeof fetch;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function settleWithin<T>(pending: Promise<T>, timeoutMs = 500): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Plain query did not cancel promptly")),
      timeoutMs,
    );
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function flushTasks(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function nat(value: number): CanonicalNat64 {
  return value.toString() as CanonicalNat64;
}

function hex(bytes: Uint8Array): string {
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
