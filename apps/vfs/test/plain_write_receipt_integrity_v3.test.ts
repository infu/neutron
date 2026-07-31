import { describe, expect, test } from "bun:test";
import type { SelfCallValue } from "neutron-tools/app";
import { FILES_V2_LIMITS } from "../src/protocol/constants.ts";
import {
  FilesPlainBackendAdapter,
  FilesPlainBackendError,
  type FilesPlainEntry,
  type FilesPlainMutationResult,
  type FilesPlainTransport,
  type FilesPlainWriteInput,
  type FilesPlainWriteResult,
} from "../src/protocol/plain_backend_adapter.ts";
import type { CanonicalNat64 } from "../src/protocol/types.ts";
import {
  DefaultFilesPlainPort,
} from "../src/resident/plain_port.ts";

describe("Files Plain write receipt integrity", () => {
  test("turns unconditional writes into identity-pinned replace-or-create", async () => {
    for (const space of ["Workspace", "Shared"] as const) {
      const existingEtag = "a".repeat(64);
      const writes: FilesPlainWriteInput[] = [];
      const relativePath = `/${space.toLowerCase()}-upsert.txt`;
      const backend = {
        stat(): Promise<FilesPlainEntry> {
          return Promise.resolve(file(relativePath, {
            nodeId: nat(17),
            revision: nat(4),
            etagSha256: existingEtag,
            relativeUrl:
              space === "Shared" ? sharedUrl(relativePath) : null,
          }));
        },
        writeBlock(
          input: FilesPlainWriteInput,
        ): Promise<FilesPlainWriteResult> {
          writes.push(input);
          return Promise.resolve(committedWrite(input, {
            nodeId: nat(17),
            revision: nat(5),
          }));
        },
      };
      const port = new DefaultFilesPlainPort({
        backend: asBackend(backend),
      });

      await expect(port.write({
        path: `/${space}${relativePath}`,
        source: source(Uint8Array.of(1), relativePath.slice(1)),
        contentKind: "binary",
        mediaType: "application/octet-stream",
        ifMatch: null,
        ifNoneMatch: false,
        createParents: false,
      })).resolves.toMatchObject({
        entry: {
          nodeId: "17",
          structuralRevision: "5",
        },
      });
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        expectedNodeId: "17",
        expectedRevision: "4",
        ifMatch: existingEtag,
        ifNoneMatch: false,
      });
    }

    const writes: FilesPlainWriteInput[] = [];
    const backend = {
      stat(): Promise<FilesPlainEntry> {
        return Promise.reject(new FilesPlainBackendError("not_found"));
      },
      writeBlock(
        input: FilesPlainWriteInput,
      ): Promise<FilesPlainWriteResult> {
        writes.push(input);
        return Promise.resolve(committedWrite(input, {
          nodeId: nat(23),
          revision: nat(1),
        }));
      },
    };
    const port = new DefaultFilesPlainPort({
      backend: asBackend(backend),
    });
    await expect(port.write({
      path: "/Workspace/new-upsert.txt",
      source: source(Uint8Array.of(2), "new-upsert.txt"),
      contentKind: "binary",
      mediaType: "application/octet-stream",
      ifMatch: null,
      ifNoneMatch: false,
      createParents: false,
    })).resolves.toMatchObject({
      entry: {
        nodeId: "23",
        structuralRevision: "1",
      },
    });
    expect(writes[0]).toMatchObject({
      expectedNodeId: null,
      expectedRevision: null,
      ifMatch: null,
      ifNoneMatch: true,
    });
  });

  test("rejects committed receipts with mismatched write metadata", async () => {
    const cases: readonly Readonly<{
      name: string;
      mutate(entry: FilesPlainEntry): FilesPlainEntry;
    }>[] = [
      {
        name: "path",
        mutate: (entry) => ({
          ...entry,
          path: "/other.bin",
          name: "other.bin",
        }),
      },
      {
        name: "content kind",
        mutate: (entry) => ({ ...entry, contentKind: "text" }),
      },
      {
        name: "media type",
        mutate: (entry) => ({ ...entry, mediaType: "text/plain" }),
      },
      {
        name: "byte length",
        mutate: (entry) => ({ ...entry, byteLength: 2 }),
      },
      {
        name: "etag",
        mutate: (entry) => ({ ...entry, etagSha256: "f".repeat(64) }),
      },
      {
        name: "create revision",
        mutate: (entry) => ({ ...entry, revision: nat(2) }),
      },
    ];

    for (const item of cases) {
      const backend = {
        writeBlock(
          input: FilesPlainWriteInput,
        ): Promise<FilesPlainWriteResult> {
          const valid = committedWrite(input, {
            nodeId: nat(30),
            revision: nat(1),
          });
          return Promise.resolve({
            ...valid,
            entry: item.mutate(valid.entry!),
          });
        },
      };
      const port = new DefaultFilesPlainPort({
        backend: asBackend(backend),
      });
      await expect(port.write({
        path: "/Workspace/receipt.bin",
        source: source(Uint8Array.of(3), "receipt.bin"),
        contentKind: "binary",
        mediaType: "application/octet-stream",
        ifMatch: null,
        ifNoneMatch: true,
        createParents: false,
      }), item.name).rejects.toMatchObject({ code: "incompatible" });
    }
  });

  test("rejects missing, changed, or leaked write stages", async () => {
    const cases = [
      {
        name: "missing intermediate stage",
        bytes: new Uint8Array(
          FILES_V2_LIMITS.normalPlaintextBlockBytes + 1,
        ),
        result(input: FilesPlainWriteInput): FilesPlainWriteResult {
          return input.final
            ? committedWrite(input, {
                nodeId: nat(30),
                revision: nat(1),
              })
            : {
                stageId: null,
                committed: false,
                entry: null,
              };
        },
        expectedAborts: [null],
      },
      {
        name: "changed intermediate stage",
        bytes: new Uint8Array(
          FILES_V2_LIMITS.normalPlaintextBlockBytes * 2 + 1,
        ),
        result(input: FilesPlainWriteInput): FilesPlainWriteResult {
          if (input.final) {
            return committedWrite(input, {
              nodeId: nat(30),
              revision: nat(1),
            });
          }
          return {
            stageId: input.blockIndex === 0 ? nat(70) : nat(71),
            committed: false,
            entry: null,
          };
        },
        expectedAborts: [nat(70)],
      },
      {
        name: "committed stage leak",
        bytes: Uint8Array.of(1),
        result(input: FilesPlainWriteInput): FilesPlainWriteResult {
          return {
            ...committedWrite(input, {
              nodeId: nat(30),
              revision: nat(1),
            }),
            stageId: nat(72),
          };
        },
        expectedAborts: [nat(72)],
      },
    ] as const;

    for (const item of cases) {
      const writes: FilesPlainWriteInput[] = [];
      const aborts: Array<CanonicalNat64 | null> = [];
      const backend = {
        writeBlock(
          input: FilesPlainWriteInput,
        ): Promise<FilesPlainWriteResult> {
          writes.push(input);
          return Promise.resolve(item.result(input));
        },
        abort(input: {
          stageId: CanonicalNat64 | null;
        }): Promise<FilesPlainMutationResult> {
          aborts.push(input.stageId);
          return Promise.resolve(mutation("/stage"));
        },
      };
      const port = new DefaultFilesPlainPort({
        backend: asBackend(backend),
      });
      await expect(port.write({
        path: "/Workspace/stages.bin",
        source: source(item.bytes, "stages.bin"),
        contentKind: "binary",
        mediaType: "application/octet-stream",
        ifMatch: null,
        ifNoneMatch: true,
        createParents: false,
      }), item.name).rejects.toMatchObject({ code: "incompatible" });
      if (writes.length > 1) {
        expect(writes[1]!.stageId).toBe(nat(70));
      }
      expect(aborts).toEqual([...item.expectedAborts]);
    }
  });

  test("binds replacement receipts to the expected node and next revision", async () => {
    for (const mismatch of ["node", "revision"] as const) {
      const existingEtag = "b".repeat(64);
      const backend = {
        stat(): Promise<FilesPlainEntry> {
          return Promise.resolve(file("/replace.bin", {
            nodeId: nat(41),
            revision: nat(7),
            etagSha256: existingEtag,
          }));
        },
        writeBlock(
          input: FilesPlainWriteInput,
        ): Promise<FilesPlainWriteResult> {
          return Promise.resolve(committedWrite(input, {
            nodeId: mismatch === "node" ? nat(42) : nat(41),
            revision: mismatch === "revision" ? nat(9) : nat(8),
          }));
        },
      };
      const port = new DefaultFilesPlainPort({
        backend: asBackend(backend),
      });
      await expect(port.write({
        path: "/Workspace/replace.bin",
        source: source(Uint8Array.of(4), "replace.bin"),
        contentKind: "binary",
        mediaType: "application/octet-stream",
        ifMatch: existingEtag,
        ifNoneMatch: false,
        createParents: false,
      })).rejects.toMatchObject({ code: "incompatible" });
    }
  });

  test("reconciles an ambiguous Shared move only after source disappearance", async () => {
    for (const sourcePresent of [true, false]) {
      const backend = new AmbiguousSharedMoveBackend(sourcePresent);
      const port = new DefaultFilesPlainPort({
        backend: asBackend(backend),
      });
      const operation = port.write({
        path: "/Shared/new-name.bin",
        source: source(Uint8Array.of(5), "new-name.bin"),
        contentKind: "binary",
        mediaType: "application/octet-stream",
        ifMatch: null,
        ifNoneMatch: true,
        createParents: false,
        moveSource: {
          path: "/Shared/old-name.bin",
          nodeId: nat(44),
          structuralRevision: nat(7),
          etagSha256: "c".repeat(64),
        },
      });

      if (sourcePresent) {
        await expect(operation).rejects.toMatchObject({
          code: "uncertain",
        });
      } else {
        await expect(operation).resolves.toMatchObject({
          entry: {
            path: "/Shared/new-name.bin",
            nodeId: "44",
            structuralRevision: "8",
          },
        });
      }
      expect(backend.writeCalls).toBe(2);
      expect(backend.statPaths).toEqual([
        "/new-name.bin",
        "/old-name.bin",
      ]);
    }
  });

  test("rejects mutation receipts for a different path", async () => {
    const backend = {
      stat(input: { path: string }): Promise<FilesPlainEntry> {
        return Promise.resolve(file(input.path));
      },
      mkdir(): Promise<FilesPlainMutationResult> {
        return Promise.resolve(mutation("/wrong-folder"));
      },
      move(): Promise<FilesPlainMutationResult> {
        return Promise.resolve(mutation("/wrong-destination"));
      },
      remove(): Promise<FilesPlainMutationResult> {
        return Promise.resolve(mutation("/wrong-source"));
      },
    };
    const port = new DefaultFilesPlainPort({
      backend: asBackend(backend),
    });

    await expect(
      port.mkdir("/Workspace/folder", true),
    ).rejects.toMatchObject({ code: "incompatible" });
    await expect(
      port.move(
        "/Workspace/source.bin",
        "/Workspace/destination.bin",
        false,
      ),
    ).rejects.toMatchObject({ code: "incompatible" });
    await expect(
      port.remove("/Workspace/source.bin", false),
    ).rejects.toMatchObject({ code: "incompatible" });
  });

  test("maps malformed successful update envelopes to incompatible", async () => {
    const transport: FilesPlainTransport = {
      query: async () => {
        throw new Error("unexpected query");
      },
      update: async () => ({ outcome: null }) as SelfCallValue,
    };
    const port = new DefaultFilesPlainPort({
      backend: new FilesPlainBackendAdapter(transport),
    });
    await expect(
      port.mkdir("/Workspace/folder", false),
    ).rejects.toMatchObject({ code: "incompatible" });
  });
});

class AmbiguousSharedMoveBackend {
  writeCalls = 0;
  readonly statPaths: string[] = [];
  #committed: FilesPlainEntry | null = null;

  constructor(readonly sourcePresent: boolean) {}

  writeBlock(
    input: FilesPlainWriteInput,
  ): Promise<FilesPlainWriteResult> {
    this.writeCalls += 1;
    if (!input.final || input.moveSource === null) {
      throw new Error("Expected one final atomic Shared move block");
    }
    this.#committed = file(input.path, {
      nodeId: input.moveSource.expectedNodeId,
      revision: incrementNat(input.moveSource.expectedRevision),
      contentKind: input.contentKind,
      byteLength: input.totalBytes,
      mediaType: input.mediaType,
      etagSha256: input.etagSha256,
      relativeUrl: sharedUrl(input.path),
    });
    return Promise.reject(new Error("lost final response"));
  }

  stat(input: { path: string }): Promise<FilesPlainEntry> {
    this.statPaths.push(input.path);
    if (input.path === "/new-name.bin" && this.#committed !== null) {
      return Promise.resolve(this.#committed);
    }
    if (input.path === "/old-name.bin" && this.sourcePresent) {
      return Promise.resolve(file(input.path, {
        nodeId: nat(44),
        revision: nat(7),
        etagSha256: "c".repeat(64),
        relativeUrl: sharedUrl(input.path),
      }));
    }
    return Promise.reject(new FilesPlainBackendError("not_found"));
  }
}

function committedWrite(
  input: FilesPlainWriteInput,
  identity: Readonly<{
    nodeId: CanonicalNat64;
    revision: CanonicalNat64;
  }>,
): FilesPlainWriteResult {
  return {
    stageId: null,
    committed: true,
    entry: file(input.path, {
      ...identity,
      contentKind: input.contentKind,
      byteLength: input.totalBytes,
      mediaType: input.mediaType,
      etagSha256: input.etagSha256,
      relativeUrl:
        input.space === "shared" ? sharedUrl(input.path) : null,
    }),
  };
}

function mutation(path: string): FilesPlainMutationResult {
  return {
    path,
    revision: nat(2),
    changed: 1,
  };
}

function file(
  path: string,
  overrides: Partial<FilesPlainEntry> = {},
): FilesPlainEntry {
  return {
    nodeId: nat(2),
    path,
    name: path.split("/").at(-1) ?? "",
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

function sharedUrl(path: string): string {
  const name = path.split("/").at(-1) ?? "file";
  return `/app/files/_route/shares/${"d".repeat(64)}/${name}`;
}

function source(bytes: Uint8Array, name: string) {
  return {
    size: bytes.byteLength,
    name,
    type: "application/octet-stream",
    slice(start: number, end: number): Uint8Array {
      return bytes.slice(start, end);
    },
  };
}

function asBackend(value: object): FilesPlainBackendAdapter {
  return value as unknown as FilesPlainBackendAdapter;
}

function nat(value: number): CanonicalNat64 {
  return value.toString() as CanonicalNat64;
}

function incrementNat(value: CanonicalNat64): CanonicalNat64 {
  return (BigInt(value) + 1n).toString() as CanonicalNat64;
}
