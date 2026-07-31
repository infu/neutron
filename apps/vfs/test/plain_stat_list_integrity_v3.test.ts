import { describe, expect, test } from "bun:test";
import type { SelfCallValue } from "neutron-tools/app";
import type {
  FilesPlainCursor,
  FilesPlainEntry,
  FilesPlainList,
  FilesPlainTransport,
} from "../src/protocol/plain_backend_adapter.ts";
import {
  FilesPlainBackendAdapter,
  FilesPlainBackendProtocolError,
} from "../src/protocol/plain_backend_adapter.ts";
import type { CanonicalNat64 } from "../src/protocol/types.ts";
import { DefaultFilesPlainPort } from "../src/resident/plain_port.ts";

const SHARE_ID = "b".repeat(64);

describe("Files Plain stat/list trust boundary", () => {
  test("accepts exact stat paths and coherent direct-child pages", async () => {
    const statEntry = folder("/docs", 3);
    const page: FilesPlainList = {
      revision: nat(9),
      entries: [
        file("/docs/alpha.txt", 4),
        folder("/docs/archive", 5),
      ],
      total: 2,
      cursor: null,
      hasMore: false,
    };
    const port = portFor({
      stat: async () => statEntry,
      list: async () => page,
    });

    await expect(port.stat("/Workspace/docs")).resolves.toMatchObject({
      path: "/Workspace/docs",
      nodeId: nat(3),
      storageClass: "workspace",
    });
    await expect(port.list({
      path: "/Workspace/docs",
      cursor: null,
      expectedFolderRevision: null,
      limit: 2,
      recursive: false,
    })).resolves.toMatchObject({
      path: "/Workspace/docs",
      folderRevision: nat(9),
      total: 2,
      hasMore: false,
      entries: [
        { path: "/Workspace/docs/alpha.txt", nodeId: nat(4) },
        { path: "/Workspace/docs/archive", nodeId: nat(5) },
      ],
    });
  });

  test("rejects stat entries from another path or storage policy", async () => {
    const sharedUrl =
      `/app/files/_route/shares/${SHARE_ID}/report.txt`;
    const cases: Array<Readonly<{
      requested: string;
      entry: FilesPlainEntry;
    }>> = [
      {
        requested: "/Workspace/report.txt",
        entry: file("/other.txt", 2),
      },
      {
        requested: "/Workspace/report.txt",
        entry: {
          ...file("/report.txt", 2),
          name: "other.txt",
        },
      },
      {
        requested: "/Workspace/report.txt",
        entry: {
          ...file("/report.txt", 2),
          relativeUrl: sharedUrl,
        },
      },
      {
        requested: "/Shared/report.txt",
        entry: file("/report.txt", 2),
      },
      {
        requested: "/Shared/report.txt",
        entry: {
          ...file("/report.txt", 2),
          relativeUrl:
            `/app/files/_route/shares/${SHARE_ID}/other.txt`,
        },
      },
      {
        requested: "/Workspace/folder",
        entry: {
          ...folder("/folder", 2),
          mediaType: "text/plain",
        },
      },
      {
        requested: "/Workspace/report.txt",
        entry: {
          ...file("/report.txt", 0),
          nodeId: nat(0),
        },
      },
    ];

    for (const item of cases) {
      const port = portFor({ stat: async () => item.entry });
      await expect(port.stat(item.requested)).rejects.toMatchObject({
        code: "incompatible",
      });
    }
  });

  test("rejects non-child, duplicate, and out-of-order list entries", async () => {
    const cases: FilesPlainEntry[][] = [
      [file("/docs/nested/alpha.txt", 2)],
      [file("/docs/alpha.txt", 2), file("/docs/alpha.txt", 3)],
      [file("/docs/alpha.txt", 2), file("/docs/bravo.txt", 2)],
      [file("/docs/bravo.txt", 2), file("/docs/alpha.txt", 3)],
      [{
        ...file("/docs/alpha.txt", 2),
        name: "../alpha.txt",
      }],
    ];
    for (const entries of cases) {
      const port = portFor({
        list: async () => ({
          revision: nat(4),
          entries,
          total: entries.length,
          cursor: null,
          hasMore: false,
        }),
      });
      await expect(port.list({
        path: "/Workspace/docs",
        cursor: null,
        expectedFolderRevision: null,
        limit: 10,
        recursive: false,
      })).rejects.toMatchObject({ code: "incompatible" });
    }
  });

  test("rejects incoherent totals, limits, and continuation geometry", async () => {
    const alpha = file("/docs/alpha.txt", 2);
    const bravo = file("/docs/bravo.txt", 3);
    const cursor = cursorAfter("alpha.txt", 7, 1);
    const malformed: Array<Readonly<{
      requestedCursor: FilesPlainCursor | null;
      limit: number;
      page: FilesPlainList;
    }>> = [
      {
        requestedCursor: null,
        limit: 1,
        page: page([alpha, bravo], 2),
      },
      {
        requestedCursor: null,
        limit: 10,
        page: page([alpha], 2),
      },
      {
        requestedCursor: null,
        limit: 10,
        page: {
          ...page([alpha], 2),
          hasMore: true,
          cursor: null,
        },
      },
      {
        requestedCursor: null,
        limit: 10,
        page: {
          ...page([alpha], 2),
          hasMore: true,
          cursor: cursorAfter("wrong.txt", 7, 1),
        },
      },
      {
        requestedCursor: cursor,
        limit: 10,
        page: {
          ...page([bravo], 2, 8),
        },
      },
      {
        requestedCursor: cursor,
        limit: 10,
        page: {
          ...page([bravo], 2),
          hasMore: true,
          cursor: cursorAfter("bravo.txt", 7, 2),
        },
      },
      {
        requestedCursor: null,
        limit: 10,
        page: {
          ...page([], 1),
          hasMore: true,
          cursor: cursorAfter("alpha.txt", 7, 1),
        },
      },
    ];

    for (const item of malformed) {
      const port = portFor({ list: async () => item.page });
      await expect(port.list({
        path: "/Workspace/docs",
        cursor: item.requestedCursor,
        expectedFolderRevision: null,
        limit: item.limit,
        recursive: false,
      })).rejects.toMatchObject({ code: "incompatible" });
    }
  });

  test("accepts a coherent continuation bound to its parent identity", async () => {
    const requestedCursor = cursorAfter("alpha.txt", 7, 11, 1, 3);
    const nextCursor = cursorAfter("bravo.txt", 7, 11, 2, 3);
    const port = portFor({
      list: async () => ({
        revision: nat(7),
        entries: [file("/docs/bravo.txt", 3)],
        total: 3,
        cursor: nextCursor,
        hasMore: true,
      }),
    });

    await expect(port.list({
      path: "/Workspace/docs",
      cursor: requestedCursor,
      expectedFolderRevision: nat(7),
      limit: 10,
      recursive: false,
    })).resolves.toMatchObject({
      folderRevision: nat(7),
      cursor: nextCursor,
      hasMore: true,
    });
  });

  test("rejects a non-empty terminal page before cumulative total", async () => {
    const firstCursor = cursorAfter("alpha.txt", 7, 11, 1, 3);
    const port = portFor({
      list: async (input: { cursor: FilesPlainCursor | null }) =>
        input.cursor === null
          ? {
              revision: nat(7),
              entries: [file("/docs/alpha.txt", 2)],
              total: 3,
              cursor: firstCursor,
              hasMore: true,
            }
          : {
              revision: nat(7),
              entries: [file("/docs/bravo.txt", 3)],
              total: 3,
              cursor: null,
              hasMore: false,
            },
    });
    const first = await port.list({
      path: "/Workspace/docs",
      cursor: null,
      expectedFolderRevision: null,
      limit: 1,
      recursive: false,
    });
    expect(first.cursor).toEqual(firstCursor);
    await expect(port.list({
      path: "/Workspace/docs",
      cursor: first.cursor,
      expectedFolderRevision: first.folderRevision,
      limit: 1,
      recursive: false,
    })).rejects.toMatchObject({ code: "incompatible" });
  });

  test("maps malformed adapter stat/list wire responses to incompatible", async () => {
    const malformedStat = adapterFor(ok(wireFile("/other.txt", 2)));
    await expect(malformedStat.stat({
      space: "workspace",
      path: "/report.txt",
    })).rejects.toBeInstanceOf(FilesPlainBackendProtocolError);
    await expect(
      new DefaultFilesPlainPort({ backend: malformedStat }).stat(
        "/Workspace/report.txt",
      ),
    ).rejects.toMatchObject({ code: "incompatible" });

    const malformedList = adapterFor(ok({
      revision: "7",
      entries: [
        wireFile("/docs/alpha.txt", 2),
        wireFile("/docs/bravo.txt", 2),
      ],
      total: 2,
      next_cursor: null,
      has_more: false,
    }));
    await expect(malformedList.list({
      space: "workspace",
      path: "/docs",
      cursor: null,
      limit: 10,
    })).rejects.toBeInstanceOf(FilesPlainBackendProtocolError);
    await expect(
      new DefaultFilesPlainPort({ backend: malformedList }).list({
        path: "/Workspace/docs",
        cursor: null,
        expectedFolderRevision: null,
        limit: 10,
        recursive: false,
      }),
    ).rejects.toMatchObject({ code: "incompatible" });
  });

  test("does not misclassify query transport outages as corrupt data", async () => {
    const offline = new FilesPlainBackendAdapter({
      query: async () => {
        throw new Error("query transport offline");
      },
      update: async () => {
        throw new Error("unexpected update");
      },
    });
    await expect(offline.stat({
      space: "workspace",
      path: "/report.txt",
    })).rejects.toThrow("query transport offline");
    await expect(
      new DefaultFilesPlainPort({ backend: offline }).stat(
        "/Workspace/report.txt",
      ),
    ).rejects.not.toBeInstanceOf(FilesPlainBackendProtocolError);
  });
});

function portFor(backend: object): DefaultFilesPlainPort {
  return new DefaultFilesPlainPort({
    backend: backend as unknown as FilesPlainBackendAdapter,
  });
}

function adapterFor(query: SelfCallValue): FilesPlainBackendAdapter {
  const transport: FilesPlainTransport = {
    query: async () => query,
    update: async () => {
      throw new Error("unexpected update");
    },
  };
  return new FilesPlainBackendAdapter(transport);
}

function ok(value: SelfCallValue): SelfCallValue {
  return { outcome: { ok: value } };
}

function wireFile(path: string, nodeId: number): SelfCallValue {
  return {
    node_id: nodeId.toString(),
    path,
    name: path.split("/").at(-1) ?? "file",
    kind: { file: null },
    content_kind: { binary: null },
    byte_length: "1",
    media_type: "application/octet-stream",
    etag_sha256: "a".repeat(64),
    created_at_ns: "1",
    modified_at_ns: "1",
    revision: "1",
    relative_url: null,
  };
}

function page(
  entries: readonly FilesPlainEntry[],
  total: number,
  revision = 7,
): FilesPlainList {
  return {
    revision: nat(revision),
    entries,
    total,
    cursor: null,
    hasMore: false,
  };
}

function cursorAfter(
  after: string,
  revision: number,
  parentNodeId: number,
  seen = 1,
  total = 2,
): FilesPlainCursor {
  return {
    after,
    revision: nat(revision),
    parentNodeId: nat(parentNodeId),
    seen,
    total,
  };
}

function file(path: string, nodeId: number): FilesPlainEntry {
  return {
    nodeId: nat(nodeId),
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
  };
}

function folder(path: string, nodeId: number): FilesPlainEntry {
  return {
    nodeId: nat(nodeId),
    path,
    name: path === "/" ? "" : path.split("/").at(-1) ?? "folder",
    type: "folder",
    contentKind: null,
    byteLength: null,
    mediaType: null,
    etagSha256: null,
    createdAtNs: nat(1),
    modifiedAtNs: nat(1),
    revision: nat(1),
    relativeUrl: null,
  };
}

function nat(value: number): CanonicalNat64 {
  return value.toString() as CanonicalNat64;
}
