import { describe, expect, test } from "bun:test";
import type { CanonicalNat64 } from "../src/protocol/types.ts";
import {
  FILES_POLICY_V3_PATH_ROUTING,
} from "../src/resident/path_routing.ts";
import {
  FilesRootedResidentPort,
  type FilesRootedCursor,
} from "../src/resident/rooted_port.ts";
import {
  FilesServiceFault,
  type FilesResidentFilePort,
  type FilesServiceEntry,
  type FilesServiceListPage,
} from "../src/resident/service_contract.ts";

type TestCursor = Readonly<{
  after: string;
  revision: CanonicalNat64;
  seen: number;
  total: number;
}>;

const POLICY = FILES_POLICY_V3_PATH_ROUTING;

describe("Files rooted recursive plain listing", () => {
  test("pages a nested tree in exact pre-order DFS without truncation", async () => {
    const tree = new PlainTree("workspace");
    tree.folder("/Workspace/a-folder", "2");
    tree.file("/Workspace/m-file.txt", "3");
    tree.folder("/Workspace/z-folder", "4");
    tree.file("/Workspace/a-folder/A.txt", "5");
    tree.folder("/Workspace/a-folder/b-folder", "6");
    tree.file("/Workspace/a-folder/z.txt", "7");
    for (let index = 0; index < 205; index += 1) {
      tree.file(
        `/Workspace/a-folder/b-folder/item-${index.toString().padStart(3, "0")}.txt`,
        (20 + index).toString(),
      );
    }
    tree.file("/Workspace/z-folder/end.txt", "500");
    const rooted = rootedWithPlain(tree.port);

    const paths: string[] = [];
    let cursor: FilesRootedCursor<never, TestCursor> | null = null;
    let revision: CanonicalNat64 | null = null;
    let pages = 0;
    do {
      const page = await rooted.list({
        path: "/Workspace",
        cursor,
        expectedFolderRevision: revision,
        limit: 17,
        recursive: true,
        routing: POLICY,
      });
      expect(page.entries.length).toBeLessThanOrEqual(17);
      expect(page.total).toBe(page.entries.length);
      expect(page.hasMore).toBe(page.cursor !== null);
      paths.push(...page.entries.map((entry) => entry.path));
      cursor = page.cursor;
      revision = page.folderRevision;
      pages += 1;
    } while (cursor !== null);

    expect(pages).toBeGreaterThan(1);
    expect(paths).toEqual([
      "/Workspace/a-folder",
      "/Workspace/a-folder/A.txt",
      "/Workspace/a-folder/b-folder",
      ...Array.from(
        { length: 205 },
        (_, index) =>
          `/Workspace/a-folder/b-folder/item-${index.toString().padStart(3, "0")}.txt`,
      ),
      "/Workspace/a-folder/z.txt",
      "/Workspace/m-file.txt",
      "/Workspace/z-folder",
      "/Workspace/z-folder/end.txt",
    ]);
    expect(new Set(paths).size).toBe(paths.length);
    expect(tree.listLimits.every((limit) => limit === 1)).toBe(true);
  });

  test("uses Unicode scalar order exactly across recursive pages", async () => {
    const tree = new PlainTree("shared");
    for (const [index, name] of [
      "a.txt",
      "\u{1f600}.txt",
      "\ue000.txt",
      "A.txt",
    ].entries()) {
      tree.file(`/Shared/${name}`, (index + 2).toString());
    }
    const rooted = rootedWithPlain(tree.port);
    const names: string[] = [];
    let cursor: FilesRootedCursor<never, TestCursor> | null = null;
    do {
      const page = await rooted.list({
        path: "/Shared",
        cursor,
        expectedFolderRevision: cursor === null ? null : nat(1),
        limit: 1,
        recursive: true,
        routing: POLICY,
      });
      names.push(...page.entries.map((entry) => entry.name));
      cursor = page.cursor;
    } while (cursor !== null);

    expect(names).toEqual([
      "A.txt",
      "a.txt",
      "\ue000.txt",
      "\u{1f600}.txt",
    ]);
  });

  test("keeps traversal work bounded while visiting a full page of empty folders", async () => {
    const tree = new PlainTree("workspace");
    for (let index = 0; index < 200; index += 1) {
      tree.folder(
        `/Workspace/folder-${index.toString().padStart(3, "0")}`,
        (index + 2).toString(),
      );
    }
    const rooted = rootedWithPlain(tree.port);
    const first = await rooted.list({
      path: "/Workspace",
      cursor: null,
      expectedFolderRevision: null,
      limit: 200,
      recursive: true,
      routing: POLICY,
    });
    expect(first.entries).toHaveLength(200);
    expect(first.cursor).not.toBeNull();
    const terminal = await rooted.list({
      path: "/Workspace",
      cursor: first.cursor,
      expectedFolderRevision: first.folderRevision,
      limit: 200,
      recursive: true,
      routing: POLICY,
    });
    expect(terminal).toMatchObject({
      entries: [],
      total: 0,
      cursor: null,
      hasMore: false,
    });
  });

  test("expires a continuation when an active nested folder changes", async () => {
    const tree = new PlainTree("workspace");
    tree.folder("/Workspace/a", "2");
    tree.file("/Workspace/a/one.txt", "3");
    tree.file("/Workspace/a/two.txt", "4");
    tree.file("/Workspace/z.txt", "5");
    const rooted = rootedWithPlain(tree.port);

    const first = await rooted.list({
      path: "/Workspace",
      cursor: null,
      expectedFolderRevision: null,
      limit: 2,
      recursive: true,
      routing: POLICY,
    });
    expect(first.entries.map((entry) => entry.path)).toEqual([
      "/Workspace/a",
      "/Workspace/a/one.txt",
    ]);
    expect(first.cursor).not.toBeNull();
    tree.revise("/Workspace/a", nat(2));

    await expect(rooted.list({
      path: "/Workspace",
      cursor: first.cursor,
      expectedFolderRevision: first.folderRevision,
      limit: 2,
      recursive: true,
      routing: POLICY,
    })).rejects.toMatchObject({ code: "cursor_expired" });
  });

  test("binds continuations to their root and never traverses another root", async () => {
    const tree = new PlainTree("workspace");
    tree.file("/Workspace/a.txt", "2");
    tree.file("/Workspace/b.txt", "3");
    const rooted = rootedWithPlain(tree.port);
    const first = await rooted.list({
      path: "/Workspace",
      cursor: null,
      expectedFolderRevision: null,
      limit: 1,
      recursive: true,
      routing: POLICY,
    });
    expect(first.cursor).toMatchObject({
      storageClass: "workspace",
      recursive: true,
      rootPath: "/Workspace",
      rootNodeId: "1",
      rootRevision: "1",
    });
    const callsBefore = tree.statPaths.length + tree.listPaths.length;

    await expect(rooted.list({
      path: "/Shared",
      cursor: first.cursor,
      expectedFolderRevision: first.folderRevision,
      limit: 1,
      recursive: true,
      routing: POLICY,
    })).rejects.toMatchObject({ code: "cursor_expired" });
    expect(tree.statPaths.length + tree.listPaths.length).toBe(callsBefore);
  });

  test("rejects oversized pages before touching plain storage", async () => {
    const tree = new PlainTree("workspace");
    const rooted = rootedWithPlain(tree.port);
    await expect(rooted.list({
      path: "/Workspace",
      cursor: null,
      expectedFolderRevision: null,
      limit: 201,
      recursive: true,
      routing: POLICY,
    })).rejects.toMatchObject({ code: "limit" });
    expect(tree.statPaths).toEqual([]);
    expect(tree.listPaths).toEqual([]);
  });

  test("rejects a terminal child page that omits stored entries", async () => {
    const root = folderEntry("/Workspace", "workspace", nat(1), nat(1));
    const one = fileEntry(
      "/Workspace/one.txt",
      "workspace",
      nat(2),
      nat(1),
    );
    const malformed = {
      stat: async () => root,
      list: async () => ({
        path: "/Workspace",
        folderRevision: nat(1),
        entries: [one],
        total: 2,
        cursor: null,
        hasMore: false,
      }),
    } as unknown as FilesResidentFilePort<TestCursor>;
    const rooted = rootedWithPlain(malformed);

    await expect(rooted.list({
      path: "/Workspace",
      cursor: null,
      expectedFolderRevision: null,
      limit: 10,
      recursive: true,
      routing: POLICY,
    })).rejects.toMatchObject({ code: "incompatible" });
  });

  test("preserves recursive legacy Vault routing when no policy token exists", async () => {
    const calls: unknown[] = [];
    const vault = {
      list: async (input: unknown) => {
        calls.push(input);
        return {
          path: "/",
          folderRevision: nat(7),
          entries: [],
          total: 0,
          cursor: null,
          hasMore: false,
        };
      },
    } as unknown as FilesResidentFilePort<string>;
    const rooted = new FilesRootedResidentPort({
      vault,
      plain: unexpectedPort<TestCursor>(),
    });

    const page = await rooted.list({
      path: "/",
      cursor: null,
      expectedFolderRevision: nat(7),
      limit: 19,
      recursive: true,
    });
    expect(page.path).toBe("/");
    expect(calls).toEqual([{
      path: "/",
      cursor: null,
      expectedFolderRevision: "7",
      limit: 19,
      recursive: true,
    }]);
  });
});

class PlainTree {
  readonly entries = new Map<string, FilesServiceEntry>();
  readonly listLimits: number[] = [];
  readonly listPaths: string[] = [];
  readonly statPaths: string[] = [];
  readonly port: FilesResidentFilePort<TestCursor>;

  constructor(readonly storageClass: "shared" | "workspace") {
    const root = storageClass === "shared" ? "/Shared" : "/Workspace";
    this.entries.set(
      root,
      folderEntry(root, storageClass, nat(1), nat(1)),
    );
    this.port = {
      list: (
        input: Parameters<FilesResidentFilePort<TestCursor>["list"]>[0],
      ) => this.list(input),
      stat: (path: string) => this.stat(path),
    } as unknown as FilesResidentFilePort<TestCursor>;
  }

  folder(path: string, nodeId: string): void {
    this.entries.set(
      path,
      folderEntry(path, this.storageClass, nat(Number(nodeId)), nat(1)),
    );
  }

  file(path: string, nodeId: string): void {
    this.entries.set(
      path,
      fileEntry(path, this.storageClass, nat(Number(nodeId)), nat(1)),
    );
  }

  revise(path: string, revision: CanonicalNat64): void {
    const current = this.entries.get(path);
    if (current === undefined) throw new Error(`Missing test path ${path}`);
    this.entries.set(path, { ...current, structuralRevision: revision });
  }

  async stat(path: string): Promise<FilesServiceEntry> {
    this.statPaths.push(path);
    const entry = this.entries.get(path);
    if (entry === undefined) {
      throw new FilesServiceFault("not_found", "missing", "refresh");
    }
    return entry;
  }

  async list(input: {
    path: string;
    cursor: TestCursor | null;
    expectedFolderRevision: CanonicalNat64 | null;
    limit: number;
    recursive: boolean;
  }): Promise<FilesServiceListPage<TestCursor>> {
    this.listPaths.push(input.path);
    this.listLimits.push(input.limit);
    if (input.recursive) throw new Error("Plain recursion crossed the adapter");
    const parent = await this.stat(input.path);
    if (
      parent.type !== "folder" ||
      (
        input.expectedFolderRevision !== null &&
        parent.structuralRevision !== input.expectedFolderRevision
      ) ||
      (
        input.cursor !== null &&
        input.cursor.revision !== parent.structuralRevision
      )
    ) {
      throw new FilesServiceFault(
        input.cursor === null ? "conflict" : "cursor_expired",
        "folder changed",
        "refresh",
      );
    }
    const children = [...this.entries.values()]
      .filter((entry) => parentPath(entry.path) === input.path)
      .sort((left, right) => compareNames(left.name, right.name));
    const start =
      input.cursor === null
        ? 0
        : children.findIndex((entry) => entry.name === input.cursor?.after) + 1;
    if (start < 0 || (input.cursor !== null && start === 0)) {
      throw new FilesServiceFault(
        "cursor_expired",
        "cursor missing",
        "refresh",
      );
    }
    const selected = children.slice(start, start + input.limit);
    const seen = start + selected.length;
    const hasMore = seen < children.length;
    const cursor =
      hasMore
        ? {
            after: selected.at(-1)!.name,
            revision: parent.structuralRevision,
            seen,
            total: children.length,
          }
        : null;
    return {
      path: input.path,
      folderRevision: parent.structuralRevision,
      entries: selected,
      total: children.length,
      cursor,
      hasMore,
    };
  }
}

function rootedWithPlain(
  plain: FilesResidentFilePort<TestCursor>,
): FilesRootedResidentPort<never, TestCursor> {
  return new FilesRootedResidentPort({
    vault: unexpectedPort<never>(),
    plain,
  });
}

function unexpectedPort<Cursor>(): FilesResidentFilePort<Cursor> {
  return new Proxy({}, {
    get() {
      return () => Promise.reject(new Error("Unexpected port call"));
    },
  }) as FilesResidentFilePort<Cursor>;
}

function folderEntry(
  path: string,
  storageClass: "shared" | "workspace",
  nodeId: CanonicalNat64,
  revision: CanonicalNat64,
): FilesServiceEntry {
  return {
    path,
    name: path.split("/").at(-1) ?? "",
    type: "folder",
    nodeId,
    storageClass,
    contentKind: null,
    byteLength: null,
    mediaType: null,
    etagSha256: null,
    publicUrl: null,
    createdAtNs: nat(1),
    modifiedAtNs: nat(1),
    structuralRevision: revision,
    contentId: null,
  };
}

function fileEntry(
  path: string,
  storageClass: "shared" | "workspace",
  nodeId: CanonicalNat64,
  revision: CanonicalNat64,
): FilesServiceEntry {
  return {
    path,
    name: path.split("/").at(-1) ?? "",
    type: "file",
    nodeId,
    storageClass,
    contentKind: "text",
    byteLength: 1,
    mediaType: "text/plain",
    etagSha256: "a".repeat(64),
    publicUrl:
      storageClass === "shared"
        ? `/app/files/_route/shares/${"b".repeat(64)}/${encodeURIComponent(path.split("/").at(-1) ?? "")}`
        : null,
    createdAtNs: nat(1),
    modifiedAtNs: nat(1),
    structuralRevision: revision,
    contentId: null,
  };
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator <= 0 ? "/" : path.slice(0, separator);
}

function compareNames(left: string, right: string): number {
  const leftScalars = [...left];
  const rightScalars = [...right];
  const common = Math.min(leftScalars.length, rightScalars.length);
  for (let index = 0; index < common; index += 1) {
    const difference =
      leftScalars[index]!.codePointAt(0)! -
      rightScalars[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return leftScalars.length - rightScalars.length;
}

function nat(value: number): CanonicalNat64 {
  return value.toString() as CanonicalNat64;
}
