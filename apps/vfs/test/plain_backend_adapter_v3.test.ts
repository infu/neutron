import { describe, expect, test } from "bun:test";
import type {
  SelfCallValue,
} from "neutron-tools/app";
import {
  FILES_PLAIN_METHODS,
  FilesPlainBackendAdapter,
  FilesPlainBackendError,
  FilesPlainBackendProtocolError,
  type FilesPlainTransport,
  type FilesPlainWriteInput,
} from "../src/protocol/plain_backend_adapter.ts";
import type { CanonicalNat64 } from "../src/protocol/types.ts";

type TransportCall = Readonly<{
  mode: "query" | "update";
  method: string;
  args: SelfCallValue[];
  timeoutSeconds: number;
}>;

describe("Files plain backend adapter", () => {
  test("sends the list Candid record and parses entries and continuation", async () => {
    const { adapter, calls } = harness({
      query: ok({
        revision: "9",
        entries: [
          plainFolder("/docs/archive", "archive"),
          plainFile({
            path: "/docs/readme.txt",
            name: "readme.txt",
            content_kind: { text: null },
            byte_length: "12",
            media_type: "text/plain",
            etag_sha256: "b".repeat(64),
            relative_url:
              `/app/files/_route/shares/${"c".repeat(64)}/readme.txt`,
          }),
        ],
        total: 4,
        next_cursor: {
          after: "readme.txt",
          revision: "9",
          parent_node_id: "6",
        },
        has_more: true,
      }),
    });

    const result = await adapter.list({
      space: "shared",
      path: "/docs",
      cursor: {
        after: "aardvark",
        revision: nat(9),
        parentNodeId: nat(6),
        seen: 1,
        total: 4,
      },
      limit: 2,
    });

    expect(calls).toEqual([
      {
        mode: "query",
        method: FILES_PLAIN_METHODS.list,
        args: [
          {
            space: { shared_: null },
            path: "/docs",
            cursor: {
              after: "aardvark",
              revision: "9",
              parent_node_id: "6",
            },
            limit: 2,
          },
        ],
        timeoutSeconds: 45,
      },
    ]);
    expect(result).toEqual({
      revision: nat(9),
      entries: [
        {
          nodeId: nat(8),
          path: "/docs/archive",
          name: "archive",
          type: "folder",
          contentKind: null,
          byteLength: null,
          mediaType: null,
          etagSha256: null,
          createdAtNs: nat(10),
          modifiedAtNs: nat(11),
          revision: nat(12),
          relativeUrl: null,
        },
        {
          nodeId: nat(7),
          path: "/docs/readme.txt",
          name: "readme.txt",
          type: "file",
          contentKind: "text",
          byteLength: 12,
          mediaType: "text/plain",
          etagSha256: "b".repeat(64),
          createdAtNs: nat(10),
          modifiedAtNs: nat(11),
          revision: nat(12),
          relativeUrl:
            `/app/files/_route/shares/${"c".repeat(64)}/readme.txt`,
        },
      ],
      total: 4,
      cursor: {
        after: "readme.txt",
        revision: nat(9),
        parentNodeId: nat(6),
        seen: 3,
        total: 4,
      },
      hasMore: true,
    });
  });

  test("rejects a non-empty continuation that terminates before its bound total", async () => {
    const { adapter } = harness({
      query: ok({
        revision: "9",
        entries: [
          plainFile({
            path: "/docs/bravo.txt",
            name: "bravo.txt",
          }),
        ],
        total: 3,
        next_cursor: null,
        has_more: false,
      }),
    });

    await expect(adapter.list({
      space: "workspace",
      path: "/docs",
      cursor: {
        after: "alpha.txt",
        revision: nat(9),
        parentNodeId: nat(6),
        seen: 1,
        total: 3,
      },
      limit: 2,
    })).rejects.toThrow("geometry is inconsistent");
  });

  test("sends every write field in its Candid-compatible shape", async () => {
    const body = new Uint8Array([1, 2, 3]);
    const beginNonce = new Uint8Array([6]);
    const commitNonce = new Uint8Array([7]);
    const deleteNonce = new Uint8Array([8]);
    const { adapter, calls } = harness({
      update: ok({
        stage_id: "27",
        committed: true,
        entry: plainFile({
          path: "/report.bin",
          name: "report.bin",
          content_kind: { binary: null },
          byte_length: "3",
          media_type: "application/octet-stream",
          etag_sha256: "d".repeat(64),
          relative_url: null,
        }),
      }),
    });

    const result = await adapter.writeBlock({
      requestId: "request-1",
      space: "workspace",
      path: "/report.bin",
      stageId: nat(26),
      blockIndex: 1,
      blockCount: 2,
      totalBytes: 3,
      contentKind: "binary",
      mediaType: "application/octet-stream",
      etagSha256: "digest",
      presentation: null,
      ifMatch: "old-digest",
      expectedNodeId: nat(30),
      expectedRevision: nat(31),
      ifNoneMatch: false,
      createParents: true,
      final: true,
      safeName: null,
      beginNonce,
      commitNonce,
      deleteNonce,
      moveSource: {
        path: "/old-report.bin",
        expectedNodeId: nat(20),
        expectedRevision: nat(21),
        ifMatch: "source-digest",
      },
      body,
    });

    expect(calls).toEqual([
      {
        mode: "update",
        method: FILES_PLAIN_METHODS.writeBlock,
        args: [
          {
            request_id: "request-1",
            space: { workspace: null },
            path: "/report.bin",
            stage_id: "26",
            block_index: 1,
            block_count: 2,
            total_bytes: "3",
            content_kind: { binary: null },
            media_type: "application/octet-stream",
            etag_sha256: "digest",
            if_match: "old-digest",
            expected_node_id: "30",
            expected_revision: "31",
            if_none_match: false,
            create_parents: true,
            final: true,
            begin_nonce: beginNonce,
            commit_nonce: commitNonce,
            delete_nonce: deleteNonce,
            move_source: {
              path: "/old-report.bin",
              expected_node_id: "20",
              expected_revision: "21",
              if_match: "source-digest",
            },
            body_bytes: 3,
            body,
          },
        ],
        timeoutSeconds: 300,
      },
    ]);
    expect(result).toMatchObject({
      stageId: "27",
      committed: true,
      entry: {
        path: "/report.bin",
        type: "file",
        contentKind: "binary",
        byteLength: 3,
      },
    });
  });

  test("sends the canonical safe name on Shared continuations and omits it for Workspace", async () => {
    const shared = harness({
      update: ok({
        stage_id: "44",
        committed: false,
        entry: null,
      }),
    });
    await shared.adapter.writeBlock({
      ...writeInput(),
      requestId: "shared-continuation",
      space: "shared",
      path: "/published/report.txt",
      stageId: nat(44),
      blockIndex: 1,
      blockCount: 3,
      totalBytes: 3,
      final: false,
      safeName: "report.txt",
      beginNonce: null,
      commitNonce: null,
      deleteNonce: null,
    });
    expect(shared.calls[0]?.args[0]).toMatchObject({
      space: { shared_: null },
      stage_id: "44",
      block_index: 1,
      safe_name: "report.txt",
    });

    const workspace = harness({
      update: ok({
        stage_id: "45",
        committed: false,
        entry: null,
      }),
    });
    await workspace.adapter.writeBlock({
      ...writeInput(),
      requestId: "workspace-continuation",
      stageId: nat(45),
      blockIndex: 1,
      blockCount: 3,
      totalBytes: 3,
      final: false,
      beginNonce: null,
      commitNonce: null,
      deleteNonce: null,
    });
    expect(workspace.calls[0]?.args[0]).not.toHaveProperty("safe_name");
  });

  test("parses the read body envelope, transfers ownership, and checks its length", async () => {
    const body = new Uint8Array([10, 20, 30]);
    const response = {
      value: ok({
        entry: plainFile({
          path: "/notes.txt",
          name: "notes.txt",
          content_kind: { text: null },
          byte_length: "3",
          media_type: "text/plain",
          etag_sha256: "d".repeat(64),
          relative_url: null,
        }),
        block_index: 0,
        block_count: 1,
        body_bytes: 3,
      }),
      body,
    };
    const { adapter, calls } = harness({ query: response });

    const result = await adapter.readChunk({
      space: "workspace",
      path: "/notes.txt",
      blockIndex: 0,
    });

    expect(calls).toEqual([
      {
        mode: "query",
        method: FILES_PLAIN_METHODS.readChunk,
        args: [
          {
            space: { workspace: null },
            path: "/notes.txt",
            block_index: 0,
          },
        ],
        timeoutSeconds: 45,
      },
    ]);
    expect(result.body).toEqual(body);
    expect(result.body).toBe(body);
    expect(result.blockIndex).toBe(0);
    expect(result.blockCount).toBe(1);

    const invalid = harness({
      query: {
        ...response,
        value: ok({
          ...(response.value as {
            outcome: { ok: Record<string, unknown> };
          }).outcome.ok,
          body_bytes: 4,
        }),
      },
    });
    await expect(
      invalid.adapter.readChunk({
        space: "workspace",
        path: "/notes.txt",
        blockIndex: 0,
      }),
    ).rejects.toThrow("body length did not match");
    expect(body).toEqual(Uint8Array.of(0, 0, 0));
  });

  test("rejects non-canonical plaintext read geometry", async () => {
    const read = (
      overrides: Record<string, SelfCallValue>,
      body = new Uint8Array([10, 20, 30]),
    ) =>
      harness({
        query: {
          value: ok({
            entry: plainFile({
              path: "/notes.txt",
              name: "notes.txt",
              content_kind: { text: null },
              byte_length: body.byteLength.toString(),
              media_type: "text/plain",
              etag_sha256: "d".repeat(64),
              relative_url: null,
            }),
            block_index: 0,
            block_count: 1,
            body_bytes: body.byteLength,
            ...overrides,
          }),
          body,
        },
      }).adapter.readChunk({
        space: "workspace",
        path: "/notes.txt",
        blockIndex: 0,
      });

    await expect(read({ block_index: 1 })).rejects.toThrow(
      "wrong block index",
    );
    await expect(read({ block_count: 0 })).rejects.toThrow(
      "invalid block count",
    );
    await expect(read({ block_count: 37 })).rejects.toThrow(
      "invalid block count",
    );
    await expect(read({ block_count: 2 })).rejects.toThrow(
      "non-canonical block count",
    );
    await expect(
      read(
        {
          entry: plainFile({
            path: "/notes.txt",
            name: "notes.txt",
            content_kind: { text: null },
            byte_length: "3",
            media_type: "text/plain",
            etag_sha256: "d".repeat(64),
            relative_url: null,
          }),
          body_bytes: 2,
        },
        new Uint8Array(2),
      ),
    ).rejects.toThrow("malformed block");
    const oversized = new Uint8Array(
      1_889_984 + 1,
    );
    await expect(
      read({
        entry: plainFile({
          path: "/notes.txt",
          name: "notes.txt",
          content_kind: { text: null },
          byte_length: oversized.byteLength.toString(),
          media_type: "text/plain",
          etag_sha256: "d".repeat(64),
          relative_url: null,
        }),
        block_count: 2,
      }, oversized),
    ).rejects.toThrow("malformed block");
    expect(oversized.every((value) => value === 0)).toBe(true);
  });

  test("uses update records for mutations and exposes backend rejection reasons", async () => {
    const calls: TransportCall[] = [];
    const transport: FilesPlainTransport = {
      query: async () => {
        throw new Error("unexpected query");
      },
      update: async (method, args, timeoutSeconds) => {
        calls.push({ mode: "update", method, args, timeoutSeconds });
        if (method === FILES_PLAIN_METHODS.remove) {
          return rejected("quota");
        }
        return ok({ path: "/done", revision: "15", changed: 1 });
      },
    };
    const adapter = new FilesPlainBackendAdapter(transport);

    await expect(
      adapter.mkdir({
        requestId: "mkdir-1",
        space: "shared",
        path: "/docs",
        recursive: true,
      }),
    ).resolves.toEqual({
      path: "/done",
      revision: nat(15),
      changed: 1,
    });
    await expect(
      adapter.move({
        requestId: "move-1",
        space: "workspace",
        from: "/old",
        to: "/new",
        overwrite: false,
        expectedNodeId: nat(10),
        expectedRevision: nat(11),
        ifMatch: null,
      }),
    ).resolves.toMatchObject({ revision: nat(15) });
    const deleteNonce = new Uint8Array([9, 8]);
    const removal = adapter.remove({
      requestId: "remove-1",
      space: "shared",
      path: "/old",
      recursive: true,
      expectedNodeId: nat(10),
      expectedRevision: nat(12),
      ifMatch: "ab".repeat(32),
      deleteNonce,
    });
    await expect(removal).rejects.toBeInstanceOf(FilesPlainBackendError);
    await expect(removal).rejects.toMatchObject({ reason: "quota" });
    await expect(
      adapter.abort({
        requestId: "abort-1",
        space: "workspace",
        stageId: nat(44),
      }),
    ).resolves.toMatchObject({ changed: 1 });
    await expect(
      adapter.abort({
        requestId: "abort-unknown-stage",
        space: "shared",
        stageId: null,
      }),
    ).resolves.toMatchObject({ changed: 1 });
    await expect(
      adapter.cleanup({ requestId: "cleanup-1", limit: 3 }),
    ).resolves.toMatchObject({ changed: 1 });

    expect(calls).toEqual([
      {
        mode: "update",
        method: FILES_PLAIN_METHODS.mkdir,
        args: [
          {
            request_id: "mkdir-1",
            space: { shared_: null },
            path: "/docs",
            recursive: true,
          },
        ],
        timeoutSeconds: 300,
      },
      {
        mode: "update",
        method: FILES_PLAIN_METHODS.move,
        args: [
          {
            request_id: "move-1",
            space: { workspace: null },
            from: "/old",
            to: "/new",
            overwrite: false,
            expected_node_id: "10",
            expected_revision: "11",
          },
        ],
        timeoutSeconds: 300,
      },
      {
        mode: "update",
        method: FILES_PLAIN_METHODS.remove,
        args: [
          {
            request_id: "remove-1",
            space: { shared_: null },
            path: "/old",
            recursive: true,
            expected_node_id: "10",
            expected_revision: "12",
            if_match: "ab".repeat(32),
            delete_nonce: deleteNonce,
          },
        ],
        timeoutSeconds: 300,
      },
      {
        mode: "update",
        method: FILES_PLAIN_METHODS.abort,
        args: [
          {
            request_id: "abort-1",
            space: { workspace: null },
            stage_id: "44",
          },
        ],
        timeoutSeconds: 300,
      },
      {
        mode: "update",
        method: FILES_PLAIN_METHODS.abort,
        args: [
          {
            request_id: "abort-unknown-stage",
            space: { shared_: null },
          },
        ],
        timeoutSeconds: 300,
      },
      {
        mode: "update",
        method: FILES_PLAIN_METHODS.cleanup,
        args: [{ request_id: "cleanup-1", limit: 3 }],
        timeoutSeconds: 300,
      },
    ]);
  });

  test("rejects malformed Nat64 and internally inconsistent entries", async () => {
    const malformedRevision = harness({
      query: ok({
        revision: "01",
        entries: [],
        total: 0,
        next_cursor: null,
        has_more: false,
      }),
    });
    await expect(
      malformedRevision.adapter.list({
        space: "workspace",
        path: "/",
        cursor: null,
        limit: 10,
      }),
    ).rejects.toThrow("canonical Nat64");

    const inconsistentFolder = harness({
      query: ok(
        plainFile({
          path: "/folder",
          name: "folder",
          kind: { folder: null },
          content_kind: { text: null },
          byte_length: "3",
          media_type: "text/plain",
          etag_sha256: "digest",
          relative_url: null,
        }),
      ),
    });
    await expect(
      inconsistentFolder.adapter.stat({
        space: "workspace",
        path: "/folder",
      }),
    ).rejects.toThrow("fields are inconsistent");
  });

  test("normalizes malformed successful update replies as protocol faults", async () => {
    const malformedOutcome = harness({ update: { outcome: null } });
    await expect(malformedOutcome.adapter.mkdir({
      requestId: "bad-mutation",
      space: "workspace",
      path: "/folder",
      recursive: false,
    })).rejects.toBeInstanceOf(FilesPlainBackendProtocolError);

    const malformedWrite = harness({
      update: ok({
        stage_id: null,
        committed: "yes",
        entry: null,
      }),
    });
    await expect(
      malformedWrite.adapter.writeBlock(writeInput()),
    ).rejects.toBeInstanceOf(FilesPlainBackendProtocolError);

    const transportFailure = new FilesPlainBackendAdapter({
      query: async () => {
        throw new Error("unexpected query");
      },
      update: async () => {
        throw new Error("update transport offline");
      },
    });
    await expect(
      transportFailure.writeBlock(writeInput()),
    ).rejects.toThrow("update transport offline");
    await expect(
      transportFailure.writeBlock(writeInput()),
    ).rejects.not.toBeInstanceOf(FilesPlainBackendProtocolError);
  });
});

function harness(responses: {
  query?: SelfCallValue;
  update?: SelfCallValue;
}): {
  adapter: FilesPlainBackendAdapter;
  calls: TransportCall[];
} {
  const calls: TransportCall[] = [];
  const transport: FilesPlainTransport = {
    query: async (method, args, timeoutSeconds) => {
      calls.push({ mode: "query", method, args, timeoutSeconds });
      if (responses.query === undefined) {
        throw new Error(`unexpected query: ${method}`);
      }
      return responses.query;
    },
    update: async (method, args, timeoutSeconds) => {
      calls.push({ mode: "update", method, args, timeoutSeconds });
      if (responses.update === undefined) {
        throw new Error(`unexpected update: ${method}`);
      }
      return responses.update;
    },
  };
  return {
    adapter: new FilesPlainBackendAdapter(transport),
    calls,
  };
}

function ok(value: SelfCallValue): SelfCallValue {
  return { outcome: { ok: value } };
}

function rejected(reason: string): SelfCallValue {
  return {
    outcome: {
      rejected: {
        reason: { [reason]: null },
        retry_after_ns: null,
      },
    },
  };
}

function plainFile(
  overrides: Record<string, SelfCallValue>,
): SelfCallValue {
  return {
    node_id: "7",
    path: "/file.bin",
    name: "file.bin",
    kind: { file: null },
    content_kind: { binary: null },
    byte_length: "1",
    media_type: "application/octet-stream",
    etag_sha256: "digest",
    created_at_ns: "10",
    modified_at_ns: "11",
    revision: "12",
    relative_url: null,
    ...overrides,
  };
}

function plainFolder(path: string, name: string): SelfCallValue {
  return {
    node_id: "8",
    path,
    name,
    kind: { folder: null },
    content_kind: null,
    byte_length: null,
    media_type: null,
    etag_sha256: null,
    created_at_ns: "10",
    modified_at_ns: "11",
    revision: "12",
    relative_url: null,
  };
}

function nat(value: number): CanonicalNat64 {
  return value.toString() as CanonicalNat64;
}

function writeInput(): FilesPlainWriteInput {
  return {
    requestId: "write-test",
    space: "workspace",
    path: "/file.bin",
    stageId: null,
    blockIndex: 0,
    blockCount: 1,
    totalBytes: 1,
    contentKind: "binary",
    mediaType: "application/octet-stream",
    etagSha256: "a".repeat(64),
    presentation: null,
    ifMatch: null,
    expectedNodeId: null,
    expectedRevision: null,
    ifNoneMatch: true,
    createParents: false,
    final: true,
    safeName: null,
    beginNonce: new Uint8Array(16),
    commitNonce: new Uint8Array(16),
    deleteNonce: new Uint8Array(16),
    moveSource: null,
    body: Uint8Array.of(1),
  };
}
