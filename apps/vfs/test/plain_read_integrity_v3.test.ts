import { describe, expect, test } from "bun:test";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { FILES_V2_LIMITS } from "../src/protocol/constants.ts";
import {
  FilesPlainBackendError,
  type FilesPlainBackendAdapter,
  type FilesPlainEntry,
} from "../src/protocol/plain_backend_adapter.ts";
import type { CanonicalNat64 } from "../src/protocol/types.ts";
import {
  DefaultFilesPlainPort,
  filesCanonicalPublicOrigin,
} from "../src/resident/plain_port.ts";

const BLOCK_BYTES = FILES_V2_LIMITS.normalPlaintextBlockBytes;
const SHARE_ID = "a".repeat(64);

describe("Files plaintext read integrity", () => {
  test("derives the certified Kernel origin from an isolated resident URL", () => {
    const canisterId = "yifcp-hp777-77774-aaacq-cai";
    const prefix = `p${"12".repeat(12)}--`;
    expect(
      filesCanonicalPublicOrigin(
        `http://${prefix}${canisterId}.localhost:8000/app/files/service.html`,
      ),
    ).toBe(`http://${canisterId}.localhost:8000`);
    expect(
      filesCanonicalPublicOrigin(
        `https://${prefix}${canisterId}.icp0.io/app/files/service.html`,
      ),
    ).toBe(`https://${canisterId}.icp0.io`);

    for (const href of [
      `https://${canisterId}.raw.icp0.io/app/files/service.html`,
      "https://files.example/app/files/service.html",
      "data:text/html,files",
    ]) {
      expect(() => filesCanonicalPublicOrigin(href)).toThrow(
        "verified Kernel canister origin",
      );
    }
  });

  test("reads and verifies the canonical 36-block Workspace maximum", async () => {
    const blockCount = 36;
    const totalBytes = (blockCount - 1) * BLOCK_BYTES + 1;
    const digest = nobleSha256.create();
    for (let ordinal = 0; ordinal < blockCount; ordinal += 1) {
      const body = patternedBlock(ordinal, blockCount, totalBytes);
      digest.update(body);
    }
    const backend = new WorkspaceReadBackend(
      file("/large.bin", totalBytes, hex(digest.digest())),
    );
    const progress: number[] = [];
    const port = new DefaultFilesPlainPort({
      backend: asBackend(backend),
    });

    const result = await port.read("/Workspace/large.bin", {
      onProgress: (item) => progress.push(item.processedBytes),
    });

    expect(backend.ordinals).toEqual(
      Array.from({ length: blockCount }, (_, ordinal) => ordinal),
    );
    expect(progress).toHaveLength(blockCount);
    expect(progress.at(-1)).toBe(totalBytes);
    expect(result.bytes).toHaveLength(totalBytes);
    expect(result.bytes[0]).toBe(1);
    expect(result.bytes[BLOCK_BYTES]).toBe(2);
    expect(result.bytes.at(-1)).toBe(36);
    expect(
      backend.returnedBodies.every((body) =>
        body.every((value) => value === 0)
      ),
    ).toBe(true);
    result.bytes.fill(0);
  });

  test("rejects block overruns and wipes transferred chunks", async () => {
    const entry = file(
      "/overrun.bin",
      3,
      hex(nobleSha256(Uint8Array.of(1, 2, 3))),
    );
    const body = Uint8Array.of(1, 2, 3, 4);
    const backend = {
      stat: async () => entry,
      readChunk: async () => ({
        entry,
        blockIndex: 0,
        blockCount: 1,
        body,
      }),
    };
    const port = new DefaultFilesPlainPort({
      backend: asBackend(backend),
    });

    await expect(port.read("/Workspace/overrun.bin")).rejects.toMatchObject({
      code: "incompatible",
    });
    expect(body).toEqual(Uint8Array.of(0, 0, 0, 0));
  });

  test("rejects metadata drift between Workspace chunks", async () => {
    const first = new Uint8Array(BLOCK_BYTES);
    first.fill(17);
    const last = Uint8Array.of(23);
    const digest = nobleSha256.create().update(first).update(last);
    const entry = file(
      "/drift.bin",
      first.byteLength + last.byteLength,
      hex(digest.digest()),
    );
    const returned: Uint8Array[] = [];
    const backend = {
      stat: async () => entry,
      readChunk: async ({ blockIndex }: { blockIndex: number }) => {
        const body = blockIndex === 0 ? first.slice() : last.slice();
        returned.push(body);
        return {
          entry:
            blockIndex === 0
              ? entry
              : { ...entry, revision: nat(2) },
          blockIndex,
          blockCount: 2,
          body,
        };
      },
    };
    const port = new DefaultFilesPlainPort({
      backend: asBackend(backend),
    });

    await expect(port.read("/Workspace/drift.bin")).rejects.toMatchObject({
      code: "incompatible",
      message: "The stored file changed while it was being read",
    });
    expect(
      returned.every((body) => body.every((value) => value === 0)),
    ).toBe(true);
  });

  test("accepts only the exact same-origin certified Shared route", async () => {
    const bytes = new TextEncoder().encode("public report");
    const validEntry = file(
      "/report.txt",
      bytes.byteLength,
      hex(nobleSha256(bytes)),
      `/app/files/_route/shares/${SHARE_ID}/report.txt`,
    );
    let fetched = "";
    const validPort = new DefaultFilesPlainPort({
      backend: asBackend({ stat: async () => validEntry }),
      publicBaseUrl: () => "https://files.example",
      fetchPublic: fetchStub(async (input) => {
        fetched = String(input);
        return new Response(bytes.slice(), {
          headers: { "content-length": bytes.byteLength.toString() },
        });
      }),
    });

    await expect(validPort.read("/Shared/report.txt")).resolves.toMatchObject({
      bytes,
    });
    expect(fetched).toBe(
      `https://files.example/app/files/_route/shares/${SHARE_ID}/report.txt`,
    );

    for (const publicUrl of [
      "https://evil.example/app/files/_route/shares/" +
        `${SHARE_ID}/report.txt`,
      `//evil.example/app/files/_route/shares/${SHARE_ID}/report.txt`,
      `/app/files/_route/shares/${SHARE_ID}/other.txt`,
      `/app/files/_route/shares/${SHARE_ID}/report.txt?download=1`,
      `/app/other/_route/shares/${SHARE_ID}/report.txt`,
    ]) {
      let called = false;
      const maliciousPort = new DefaultFilesPlainPort({
        backend: asBackend({
          stat: async () => ({ ...validEntry, relativeUrl: publicUrl }),
        }),
        publicBaseUrl: () => "https://files.example",
        fetchPublic: fetchStub(async () => {
          called = true;
          return new Response(bytes);
        }),
      });
      await expect(
        maliciousPort.read("/Shared/report.txt"),
      ).rejects.toMatchObject({ code: "incompatible" });
      expect(called).toBe(false);
    }
  });

  test("bounds Shared Content-Length and streamed body before copying", async () => {
    const bytes = Uint8Array.of(7, 11, 13);
    const entry = file(
      "/bounded.bin",
      bytes.byteLength,
      hex(nobleSha256(bytes)),
      `/app/files/_route/shares/${SHARE_ID}/bounded.bin`,
    );
    const portFor = (response: Response) =>
      new DefaultFilesPlainPort({
        backend: asBackend({ stat: async () => entry }),
        publicBaseUrl: () => "https://files.example",
        fetchPublic: fetchStub(async () => response),
      });

    await expect(
      portFor(
        new Response(bytes.slice(), {
          headers: { "content-length": "4" },
        }),
      ).read("/Shared/bounded.bin"),
    ).rejects.toMatchObject({ code: "incompatible" });

    await expect(
      portFor(streamResponse(Uint8Array.of(7, 11, 13, 17))).read(
        "/Shared/bounded.bin",
      ),
    ).rejects.toMatchObject({
      code: "incompatible",
      message: "The shared file returned too much data",
    });

    await expect(
      portFor(streamResponse(Uint8Array.of(7, 11))).read(
        "/Shared/bounded.bin",
      ),
    ).rejects.toMatchObject({
      code: "incompatible",
      message: "Files could not verify the stored bytes",
    });
  });

  test("maps stale, temporary, and corrupt read/list rejections", async () => {
    const cursorPort = new DefaultFilesPlainPort({
      backend: asBackend({
        list: async () => {
          throw new FilesPlainBackendError("cursor_stale");
        },
      }),
    });
    await expect(cursorPort.list({
      path: "/Workspace",
      cursor: null,
      expectedFolderRevision: null,
      limit: 10,
      recursive: false,
    })).rejects.toMatchObject({ code: "cursor_expired" });

    const entry = file(
      "/broken.bin",
      1,
      hex(nobleSha256(Uint8Array.of(1))),
    );
    for (const [reason, code] of [
      ["temporarily_unavailable", "temporarily_unavailable"],
      ["corrupt_state", "incompatible"],
      ["stale_content", "conflict"],
    ] as const) {
      const port = new DefaultFilesPlainPort({
        backend: asBackend({
          stat: async () => entry,
          readChunk: async () => {
            throw new FilesPlainBackendError(reason);
          },
        }),
      });
      await expect(port.read("/Workspace/broken.bin")).rejects.toMatchObject({
        code,
      });
    }
  });
});

class WorkspaceReadBackend {
  readonly ordinals: number[] = [];
  readonly returnedBodies: Uint8Array[] = [];

  constructor(readonly entry: FilesPlainEntry) {}

  stat(): Promise<FilesPlainEntry> {
    return Promise.resolve(this.entry);
  }

  readChunk(input: { blockIndex: number }) {
    const blockCount = Math.max(
      1,
      Math.ceil(this.entry.byteLength! / BLOCK_BYTES),
    );
    const body = patternedBlock(
      input.blockIndex,
      blockCount,
      this.entry.byteLength!,
    );
    this.ordinals.push(input.blockIndex);
    this.returnedBodies.push(body);
    return Promise.resolve({
      entry: this.entry,
      blockIndex: input.blockIndex,
      blockCount,
      body,
    });
  }
}

function patternedBlock(
  ordinal: number,
  blockCount: number,
  totalBytes: number,
): Uint8Array {
  const length =
    ordinal + 1 === blockCount
      ? totalBytes - ordinal * BLOCK_BYTES
      : BLOCK_BYTES;
  const body = new Uint8Array(length);
  body.fill(ordinal + 1);
  return body;
}

function streamResponse(bytes: Uint8Array): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  );
}

function file(
  path: string,
  byteLength: number,
  etagSha256: string,
  relativeUrl: string | null = null,
): FilesPlainEntry {
  return {
    nodeId: nat(1),
    path,
    name: path.split("/").at(-1) ?? "file",
    type: "file",
    contentKind: "binary",
    byteLength,
    mediaType: "application/octet-stream",
    etagSha256,
    createdAtNs: nat(1),
    modifiedAtNs: nat(1),
    revision: nat(1),
    relativeUrl,
  };
}

function asBackend(value: object): FilesPlainBackendAdapter {
  return value as unknown as FilesPlainBackendAdapter;
}

function fetchStub(
  handler: (...args: Parameters<typeof fetch>) => Promise<Response>,
): typeof fetch {
  return handler as unknown as typeof fetch;
}

function nat(value: number): CanonicalNat64 {
  return value.toString() as CanonicalNat64;
}

function hex(bytes: Uint8Array): string {
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
