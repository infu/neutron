import { describe, expect, test } from "bun:test";
import type { CanonicalNat64 } from "../src/protocol/types.ts";
import {
  FilesRootedResidentPort,
} from "../src/resident/rooted_port.ts";
import {
  FILES_LEGACY_VAULT_PATH_ROUTING,
  FILES_POLICY_V3_PATH_ROUTING,
} from "../src/resident/path_routing.ts";
import {
  FilesServiceFault,
  type FilesResidentFilePort,
  type FilesServiceEntry,
  type FilesServiceFile,
  type FilesServiceListPage,
  type FilesServiceMoveSource,
  type FilesServiceMutationResult,
  type FilesServiceStatus,
  type FilesServiceWriteResult,
} from "../src/resident/service_contract.ts";
import type {
  FilesTransferControls,
  FilesTransferSource,
} from "../src/vault/types.ts";

type PortCall = Readonly<{
  method: string;
  args: readonly unknown[];
}>;

const LEGACY = FILES_LEGACY_VAULT_PATH_ROUTING;
const POLICY = FILES_POLICY_V3_PATH_ROUTING;

describe("Files rooted resident port", () => {
  test("lists the three immutable policy roots in product order", async () => {
    const rooted = new FilesRootedResidentPort({
      vault: new FakeResidentPort("vault"),
      plain: new FakeResidentPort("plain"),
    });

    const page = await rooted.list({
      path: "/",
      cursor: null,
      expectedFolderRevision: null,
      limit: 200,
      recursive: false,
      routing: POLICY,
    });

    expect(page).toMatchObject({
      path: "/",
      folderRevision: "1",
      total: 3,
      cursor: null,
      hasMore: false,
    });
    expect(page.entries.map((entry) => ({
      path: entry.path,
      name: entry.name,
      storageClass: entry.storageClass,
    }))).toEqual([
      {
        path: "/Shared",
        name: "Shared",
        storageClass: "shared",
      },
      {
        path: "/Vault",
        name: "Vault",
        storageClass: "vault",
      },
      {
        path: "/Workspace",
        name: "Workspace",
        storageClass: "workspace",
      },
    ]);
  });

  test("lists the historical encrypted root for legacy app callers", async () => {
    const vault = new FakeResidentPort("vault");
    const plain = new FakeResidentPort("plain");
    vault.listResult = page("/", [
      folder("/projects"),
      file("/workbook.nsheet", "vault-digest"),
    ], "vault-next");
    const rooted = new FilesRootedResidentPort({ vault, plain });

    const pageResult = await rooted.list({
      path: "/",
      cursor: null,
      expectedFolderRevision: nat(3),
      limit: 10,
      recursive: false,
      routing: LEGACY,
    });

    expect(vault.calls).toEqual([{
      method: "list",
      args: [{
        path: "/",
        cursor: null,
        expectedFolderRevision: "3",
        limit: 10,
        recursive: false,
      }],
    }]);
    expect(plain.calls).toEqual([]);
    expect(pageResult.path).toBe("/");
    expect(pageResult.entries.map((entry) => ({
      path: entry.path,
      storageClass: entry.storageClass,
      publicUrl: entry.publicUrl,
    }))).toEqual([
      {
        path: "/projects",
        storageClass: "vault",
        publicUrl: null,
      },
      {
        path: "/workbook.nsheet",
        storageClass: "vault",
        publicUrl: null,
      },
    ]);
    expect(pageResult.cursor).toEqual({
      storageClass: "vault",
      cursor: "vault-next",
    });

    await expect(rooted.list({
      path: "/",
      cursor: { storageClass: "root", offset: 1 },
      expectedFolderRevision: nat(3),
      limit: 10,
      recursive: false,
      routing: LEGACY,
    })).rejects.toMatchObject({
      code: "cursor_expired",
    });
  });

  test("routes Vault relative paths and plain virtual paths without crossing ports", async () => {
    const vault = new FakeResidentPort("vault");
    const plain = new FakeResidentPort("plain");
    vault.listResult = page("/projects", [
      folder("/projects/archive"),
      file("/projects/secret.txt", "vault-digest"),
    ], "vault-next");
    plain.listResult = page("/Shared/projects", [
      file("/Shared/projects/public.txt", "plain-digest", {
        publicUrl: "/app/files/_route/shared/public.txt",
      }),
    ], "plain-next");
    const rooted = new FilesRootedResidentPort({ vault, plain });

    const vaultPage = await rooted.list({
      path: "/Vault/projects",
      cursor: null,
      expectedFolderRevision: nat(5),
      limit: 10,
      recursive: false,
      routing: POLICY,
    });
    const sharedPage = await rooted.list({
      path: "/Shared/projects",
      cursor: null,
      expectedFolderRevision: nat(6),
      limit: 10,
      recursive: false,
      routing: POLICY,
    });
    await rooted.stat("/Vault/projects/secret.txt", undefined, POLICY);
    await rooted.stat("/Workspace/draft.txt", undefined, POLICY);

    expect(vault.calls[0]).toEqual({
      method: "list",
      args: [
        {
          path: "/projects",
          cursor: null,
          expectedFolderRevision: "5",
          limit: 10,
          recursive: false,
        },
      ],
    });
    expect(plain.calls[0]).toEqual({
      method: "list",
      args: [
        {
          path: "/Shared/projects",
          cursor: null,
          expectedFolderRevision: "6",
          limit: 10,
          recursive: false,
        },
      ],
    });
    expect(vault.calls[1]).toEqual({
      method: "stat",
      args: ["/projects/secret.txt", undefined],
    });
    expect(plain.calls[1]).toEqual({
      method: "stat",
      args: ["/Workspace/draft.txt", undefined],
    });

    expect(vaultPage.path).toBe("/Vault/projects");
    expect(vaultPage.entries.map((entry) => entry.path)).toEqual([
      "/Vault/projects/archive",
      "/Vault/projects/secret.txt",
    ]);
    expect(vaultPage.entries.every(
      (entry) =>
        entry.storageClass === "vault" && entry.publicUrl === null,
    )).toBe(true);
    expect(vaultPage.cursor).toEqual({
      storageClass: "vault",
      cursor: "vault-next",
    });

    expect(sharedPage.entries[0]).toMatchObject({
      path: "/Shared/projects/public.txt",
      storageClass: "shared",
      publicUrl: "/app/files/_route/shared/public.txt",
    });
    expect(sharedPage.cursor).toEqual({
      storageClass: "shared",
      cursor: "plain-next",
    });
  });

  test("rejects a continuation from a different storage root", async () => {
    const rooted = new FilesRootedResidentPort<string, string>({
      vault: new FakeResidentPort("vault"),
      plain: new FakeResidentPort("plain"),
    });

    const listing = rooted.list({
      path: "/Workspace",
      cursor: { storageClass: "vault", cursor: "vault-page" },
      expectedFolderRevision: null,
      limit: 10,
      recursive: false,
      routing: POLICY,
    });
    await expect(listing).rejects.toMatchObject({
      code: "cursor_expired",
    });
  });

  test("keeps legacy rootless app paths encrypted under Vault", async () => {
    const vault = new FakeResidentPort("vault");
    const plain = new FakeResidentPort("plain");
    vault.statResult = file("/workbook.nsheet", "vault-digest");
    const rooted = new FilesRootedResidentPort({ vault, plain });

    const entry = await rooted.stat("/workbook.nsheet");

    expect(vault.calls).toEqual([
      {
        method: "stat",
        args: ["/workbook.nsheet", undefined],
      },
    ]);
    expect(plain.calls).toEqual([]);
    expect(entry).toMatchObject({
      path: "/workbook.nsheet",
      storageClass: "vault",
      publicUrl: null,
    });
  });

  test("keeps reserved root spellings exact in the historical encrypted namespace", async () => {
    const vault = new FakeResidentPort("vault");
    const plain = new FakeResidentPort("plain");
    vault.listResult = page("/Workspace", [
      file("/Workspace/notes.txt", "listed-digest"),
    ]);
    vault.statResult = file("/Vault/secret.txt", "stat-digest");
    vault.readResult = {
      entry: file(
        "/Shared/read.txt",
        "read-digest",
      ) as FilesServiceFile["entry"],
      bytes: new Uint8Array([1, 2, 3]),
    };
    vault.writeResult = {
      entry: file(
        "/Workspace/written.txt",
        "write-digest",
      ) as FilesServiceWriteResult["entry"],
      cleanupPending: false,
    };
    const rooted = new FilesRootedResidentPort({ vault, plain });

    const listed = await rooted.list({
      path: "/Workspace",
      cursor: null,
      expectedFolderRevision: null,
      limit: 10,
      recursive: false,
    });
    const stated = await rooted.stat("/Vault/secret.txt");
    const read = await rooted.read("/Shared/read.txt");
    const written = await rooted.write({
      path: "/Workspace/written.txt",
      source: {
        size: 3,
        name: "written.txt",
        type: "text/plain",
        slice(start, end) {
          return new Uint8Array([4, 5, 6]).slice(start, end);
        },
      },
      contentKind: "text",
      mediaType: "text/plain",
      ifMatch: null,
      ifNoneMatch: false,
      createParents: true,
    });
    const made = await rooted.mkdir("/Shared", true);
    const moved = await rooted.move("/Vault", "/Workspace", false);
    const removed = await rooted.remove("/Shared", true);

    expect(plain.calls).toEqual([]);
    expect(vault.calls.map((call) => call.method)).toEqual([
      "list",
      "stat",
      "read",
      "write",
      "mkdir",
      "move",
      "remove",
    ]);
    expect(vault.calls[0]?.args[0]).toMatchObject({ path: "/Workspace" });
    expect(vault.calls[1]?.args[0]).toBe("/Vault/secret.txt");
    expect(vault.calls[2]?.args[0]).toBe("/Shared/read.txt");
    expect(
      (vault.calls[3]?.args[0] as { path: string }).path,
    ).toBe("/Workspace/written.txt");
    expect(vault.calls[4]?.args[0]).toBe("/Shared");
    expect(vault.calls[5]?.args.slice(0, 2)).toEqual([
      "/Vault",
      "/Workspace",
    ]);
    expect(vault.calls[6]?.args[0]).toBe("/Shared");
    expect(listed.path).toBe("/Workspace");
    expect(listed.entries[0]?.path).toBe("/Workspace/notes.txt");
    expect(stated.path).toBe("/Vault/secret.txt");
    expect(read.entry.path).toBe("/Shared/read.txt");
    expect(written.entry.path).toBe("/Workspace/written.txt");
    expect(made.path).toBe("/Shared");
    expect(moved.path).toBe("/Workspace");
    expect(removed.path).toBe("/Shared");

    await expect(
      rooted.move("/Shared", "/Workspace", false, undefined, POLICY),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      rooted.remove("/Vault", true, undefined, undefined, POLICY),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  test("treats every pre-v105 root collision, including slash, as Vault", async () => {
    const vault = new FakeResidentPort("vault");
    const plain = new FakeResidentPort("plain");
    const rooted = new FilesRootedResidentPort({ vault, plain });

    for (const path of ["/", "/Shared", "/Vault", "/Workspace"]) {
      vault.statResult = folder(path);
      const entry = await rooted.stat(path);
      expect(entry).toMatchObject({
        path,
        storageClass: "vault",
        publicUrl: null,
      });
    }

    expect(vault.calls.map((call) => call.args[0])).toEqual([
      "/",
      "/Shared",
      "/Vault",
      "/Workspace",
    ]);
    expect(plain.calls).toEqual([]);
  });

  test("only the resident identity token can select unencrypted Workspace", async () => {
    const vault = new FakeResidentPort("vault");
    const plain = new FakeResidentPort("plain");
    vault.statResult = file("/Workspace/forged.txt", "vault-digest");
    plain.statResult = file("/Workspace/policy.txt", "plain-digest");
    const rooted = new FilesRootedResidentPort({ vault, plain });
    const forged = {
      mode: "policy_v3",
    } as unknown as typeof POLICY;

    const forgedEntry = await rooted.stat(
      "/Workspace/forged.txt",
      undefined,
      forged,
    );
    const policyEntry = await rooted.stat(
      "/Workspace/policy.txt",
      undefined,
      POLICY,
    );

    expect(vault.calls[0]).toEqual({
      method: "stat",
      args: ["/Workspace/forged.txt", undefined],
    });
    expect(plain.calls[0]).toEqual({
      method: "stat",
      args: ["/Workspace/policy.txt", undefined],
    });
    expect(forgedEntry).toMatchObject({
      path: "/Workspace/forged.txt",
      storageClass: "vault",
    });
    expect(policyEntry).toMatchObject({
      path: "/Workspace/policy.txt",
      storageClass: "workspace",
    });
    await expect(
      rooted.stat("/rootless.txt", undefined, POLICY),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  test("inherits the first root policy through every nested folder", async () => {
    const vault = new FakeResidentPort("vault");
    const plain = new FakeResidentPort("plain");
    const rooted = new FilesRootedResidentPort({ vault, plain });

    await rooted.stat(
      "/Shared/teams/design/launch/brief.md",
      undefined,
      POLICY,
    );
    await rooted.stat(
      "/Workspace/teams/design/launch/notes.md",
      undefined,
      POLICY,
    );
    await rooted.stat(
      "/Vault/teams/design/launch/keys.bin",
      undefined,
      POLICY,
    );

    expect(plain.calls).toEqual([
      {
        method: "stat",
        args: ["/Shared/teams/design/launch/brief.md", undefined],
      },
      {
        method: "stat",
        args: ["/Workspace/teams/design/launch/notes.md", undefined],
      },
    ]);
    expect(vault.calls).toEqual([
      {
        method: "stat",
        args: ["/teams/design/launch/keys.bin", undefined],
      },
    ]);
  });

  test("delegates a legacy encrypted batch without reinterpreting reserved names", async () => {
    const vault = new FakeResidentPort("vault");
    const plain = new FakeResidentPort("plain");
    vault.writeManyResult = [
      {
        entry: file(
          "/Vault/projects/one.txt",
          "one-digest",
        ) as FilesServiceWriteResult["entry"],
        cleanupPending: false,
      },
      {
        entry: file(
          "/legacy-two.txt",
          "two-digest",
        ) as FilesServiceWriteResult["entry"],
        cleanupPending: false,
      },
    ];
    const rooted = new FilesRootedResidentPort({ vault, plain });
    const batch = [
      {
        path: "/Vault/projects/one.txt",
        text: "one",
        overwrite: false,
        createParents: true,
        mediaType: "text/plain",
      },
      {
        path: "/legacy-two.txt",
        text: "two",
        overwrite: true,
        createParents: false,
        mediaType: "text/plain",
      },
    ] as const;

    const results = await rooted.writeMany(batch);

    expect(vault.calls).toEqual([
      {
        method: "writeMany",
        args: [
          [
            {
              ...batch[0],
              path: "/Vault/projects/one.txt",
            },
            {
              ...batch[1],
              path: "/legacy-two.txt",
            },
          ],
          undefined,
        ],
      },
    ]);
    expect(plain.calls).toEqual([]);
    expect(results.map((result) => result.entry.path)).toEqual([
      "/Vault/projects/one.txt",
      "/legacy-two.txt",
    ]);
    expect(results.every(
      (result) =>
        result.entry.storageClass === "vault" &&
        result.entry.publicUrl === null,
    )).toBe(true);
  });

  test("moves a file across roots by copy, verification, then source deletion", async () => {
    const events: string[] = [];
    const vault = new FakeResidentPort("vault", events);
    const plain = new FakeResidentPort("plain", events);
    vault.statResult = file("/from/report.txt", "same-digest");
    const decryptedBytes = new Uint8Array([1, 2, 3]);
    vault.readResult = {
      entry: vault.statResult as FilesServiceFile["entry"],
      bytes: decryptedBytes,
    };
    plain.writeResult = {
      entry: file(
        "/Shared/inbox/report.txt",
        "same-digest",
      ) as FilesServiceWriteResult["entry"],
      cleanupPending: false,
    };
    plain.notFoundPaths.add("/Shared/inbox/report.txt");
    const rooted = new FilesRootedResidentPort({ vault, plain });

    await expect(
      rooted.move(
        "/Vault/from/report.txt",
        "/Shared/inbox/report.txt",
        false,
        undefined,
        POLICY,
      ),
    ).resolves.toEqual({
      path: "/Shared/inbox/report.txt",
      structuralRevision: nat(1),
      changed: 1,
      cleanupPending: false,
    });

    expect(events).toEqual([
      "plain:stat",
      "vault:stat",
      "vault:read",
      "plain:write",
      "vault:stat",
      "plain:stat",
      "vault:stat",
      "plain:stat",
      "vault:remove",
    ]);
    expect(vault.calls).toEqual([
      {
        method: "stat",
        args: ["/from/report.txt", undefined],
      },
      {
        method: "read",
        args: ["/from/report.txt", undefined],
      },
      {
        method: "stat",
        args: ["/from/report.txt", undefined],
      },
      {
        method: "stat",
        args: ["/from/report.txt", undefined],
      },
      {
        method: "remove",
        args: [
          "/from/report.txt",
          false,
          undefined,
          {
            nodeId: null,
            structuralRevision: "1",
            etagSha256: "same-digest",
          },
        ],
      },
    ]);
    const write = plain.calls.find((call) => call.method === "write");
    expect(write?.method).toBe("write");
    expect(write?.args[0]).toMatchObject({
      path: "/Shared/inbox/report.txt",
      contentKind: "binary",
      mediaType: "application/octet-stream",
      ifMatch: null,
      ifNoneMatch: true,
      createParents: true,
    });
    expect(plain.writeBytes).toEqual([new Uint8Array([1, 2, 3])]);
    expect(decryptedBytes).toEqual(new Uint8Array([0, 0, 0]));
  });

  test("moves a Workspace file into Vault using each root's native path", async () => {
    const events: string[] = [];
    const vault = new FakeResidentPort("vault", events);
    const plain = new FakeResidentPort("plain", events);
    plain.statResult = file("/Workspace/report.txt", "same-digest");
    const sourceBytes = new Uint8Array([4, 5, 6]);
    plain.readResult = {
      entry: plain.statResult as FilesServiceFile["entry"],
      bytes: sourceBytes,
    };
    vault.writeResult = {
      entry: file(
        "/inbox/report.txt",
        "same-digest",
      ) as FilesServiceWriteResult["entry"],
      cleanupPending: false,
    };
    vault.notFoundPaths.add("/inbox/report.txt");
    const rooted = new FilesRootedResidentPort({ vault, plain });

    await expect(
      rooted.move(
        "/Workspace/report.txt",
        "/Vault/inbox/report.txt",
        false,
        undefined,
        POLICY,
      ),
    ).resolves.toEqual({
      path: "/Vault/inbox/report.txt",
      structuralRevision: nat(1),
      changed: 1,
      cleanupPending: false,
    });

    expect(events).toEqual([
      "vault:stat",
      "plain:stat",
      "plain:read",
      "vault:write",
      "plain:stat",
      "vault:stat",
      "plain:stat",
      "vault:stat",
      "plain:remove",
    ]);
    expect(vault.calls[0]).toEqual({
      method: "stat",
      args: ["/inbox/report.txt", undefined],
    });
    expect(vault.calls.find((call) => call.method === "write")?.args[0])
      .toMatchObject({
        path: "/inbox/report.txt",
        contentKind: "binary",
        mediaType: "application/octet-stream",
        ifMatch: null,
        ifNoneMatch: true,
        createParents: true,
      });
    expect(plain.calls.find((call) => call.method === "read")).toEqual({
      method: "read",
      args: ["/Workspace/report.txt", undefined],
    });
    expect(plain.calls.at(-1)).toEqual({
      method: "remove",
      args: [
        "/Workspace/report.txt",
        false,
        undefined,
        {
          nodeId: nat(1),
          structuralRevision: nat(1),
          etagSha256: "same-digest",
        },
      ],
    });
    expect(sourceBytes).toEqual(new Uint8Array([0, 0, 0]));
  });

  test("wipes a decrypted copy buffer when the destination write fails", async () => {
    const vault = new FakeResidentPort("vault");
    const plain = new FakeResidentPort("plain");
    vault.statResult = file("/source.bin", "source-digest");
    const decryptedBytes = new Uint8Array([4, 5, 6]);
    vault.readResult = {
      entry: vault.statResult as FilesServiceFile["entry"],
      bytes: decryptedBytes,
    };
    plain.notFoundPaths.add("/Workspace/source.bin");
    plain.writeError = new Error("destination unavailable");
    const rooted = new FilesRootedResidentPort({ vault, plain });

    await expect(
      rooted.move(
        "/Vault/source.bin",
        "/Workspace/source.bin",
        false,
        undefined,
        POLICY,
      ),
    ).rejects.toThrow("destination unavailable");

    expect(plain.writeBytes).toEqual([new Uint8Array([4, 5, 6])]);
    expect(decryptedBytes).toEqual(new Uint8Array([0, 0, 0]));
    expect(
      vault.calls.some((call) => call.method === "remove"),
    ).toBe(false);
  });

  test("does not copy stale metadata when stat and read observe different source revisions", async () => {
    const vault = new FakeResidentPort("vault");
    const plain = new FakeResidentPort("plain");
    vault.statResult = file("/source.txt", "same-digest", {
      contentKind: "binary",
      mediaType: "application/octet-stream",
      structuralRevision: nat(1),
    });
    const decryptedBytes = new Uint8Array([8, 9, 10]);
    vault.readResult = {
      entry: file("/source.txt", "same-digest", {
        contentKind: "text",
        mediaType: "text/plain",
        structuralRevision: nat(2),
        modifiedAtNs: nat(2),
      }) as FilesServiceFile["entry"],
      bytes: decryptedBytes,
    };
    plain.notFoundPaths.add("/Workspace/source.txt");
    const rooted = new FilesRootedResidentPort({ vault, plain });

    await expect(
      rooted.move(
        "/Vault/source.txt",
        "/Workspace/source.txt",
        false,
        undefined,
        POLICY,
      ),
    ).rejects.toMatchObject({
      code: "conflict",
    });

    expect(
      plain.calls.some((call) => call.method === "write"),
    ).toBe(false);
    expect(
      vault.calls.some((call) => call.method === "remove"),
    ).toBe(false);
    expect(decryptedBytes).toEqual(new Uint8Array([0, 0, 0]));
  });

  test("rolls back the destination when cross-root copy verification fails", async () => {
    const events: string[] = [];
    const vault = new FakeResidentPort("vault", events);
    const plain = new FakeResidentPort("plain", events);
    vault.statResult = file("/source.bin", "expected-digest");
    vault.readResult = {
      entry: vault.statResult as FilesServiceFile["entry"],
      bytes: new Uint8Array([9]),
    };
    plain.writeResult = {
      entry: file(
        "/Workspace/source.bin",
        "wrong-digest",
      ) as FilesServiceWriteResult["entry"],
      cleanupPending: false,
    };
    plain.notFoundPaths.add("/Workspace/source.bin");
    const rooted = new FilesRootedResidentPort({ vault, plain });

    const operation = rooted.move(
      "/Vault/source.bin",
      "/Workspace/source.bin",
      false,
      undefined,
      POLICY,
    );
    await expect(operation).rejects.toMatchObject({
      code: "uncertain",
    });
    expect(events).toEqual([
      "plain:stat",
      "vault:stat",
      "vault:read",
      "plain:write",
      "plain:stat",
      "plain:remove",
    ]);
    expect(plain.calls.at(-1)).toMatchObject({
      method: "remove",
      args: [
        "/Workspace/source.bin",
        false,
        {},
        {
          nodeId: "1",
          structuralRevision: "1",
          etagSha256: "wrong-digest",
        },
      ],
    });
    expect(
      (plain.calls.at(-1)?.args[2] as AbortSignal).aborted,
    ).toBe(false);
    expect(
      vault.calls.some((call) => call.method === "remove"),
    ).toBe(false);
  });

  test("surfaces failed Shared rollback as possible public exposure", async () => {
    const vault = new FakeResidentPort("vault");
    const plain = new FakeResidentPort("plain");
    vault.statResult = file("/source.bin", "expected-digest");
    vault.readResult = {
      entry: vault.statResult as FilesServiceFile["entry"],
      bytes: new Uint8Array([9]),
    };
    plain.writeResult = {
      entry: file(
        "/Shared/source.bin",
        "wrong-digest",
      ) as FilesServiceWriteResult["entry"],
      cleanupPending: false,
    };
    plain.notFoundPaths.add("/Shared/source.bin");
    plain.removeError = new Error("rollback unavailable");
    const rooted = new FilesRootedResidentPort({ vault, plain });

    await expect(
      rooted.move(
        "/Vault/source.bin",
        "/Shared/source.bin",
        false,
        undefined,
        POLICY,
      ),
    ).rejects.toMatchObject({
      code: "uncertain",
      details: {
        destinationPath: "/Shared/source.bin",
        publicExposurePossible: true,
      },
    });
    expect(
      vault.calls.some((call) => call.method === "remove"),
    ).toBe(false);
  });

  test("never rolls back the only copy after an atomic Shared rename commits", async () => {
    const vault = new TreeResidentPort("vault");
    const source = treeFile("/Shared/original.txt", {
      nodeId: nat(41),
    });
    const plain = new TreeResidentPort("plain", [source]);
    plain.writeEtagOverrides.set(
      "/Shared/renamed.txt",
      "mismatched-returned-digest",
    );
    const rooted = new FilesRootedResidentPort({ vault, plain });

    await expect(
      rooted.move(
        "/Shared/original.txt",
        "/Shared/renamed.txt",
        false,
        undefined,
        POLICY,
      ),
    ).rejects.toMatchObject({
      code: "uncertain",
    });

    expect(plain.entries.has("/Shared/original.txt")).toBe(false);
    expect(plain.entries.get("/Shared/renamed.txt")).toMatchObject({
      etagSha256: "mismatched-returned-digest",
    });
    expect(plain.removeCalls).toEqual([]);
  });

  test("preserves the copied destination when deleting the old source fails", async () => {
    const events: string[] = [];
    const vault = new FakeResidentPort("vault", events);
    const plain = new FakeResidentPort("plain", events);
    vault.statResult = file("/source.txt", "same-digest");
    vault.readResult = {
      entry: vault.statResult as FilesServiceFile["entry"],
      bytes: new Uint8Array([7]),
    };
    vault.removeError = new Error("source delete failed");
    plain.writeResult = {
      entry: file(
        "/Shared/source.txt",
        "same-digest",
      ) as FilesServiceWriteResult["entry"],
      cleanupPending: false,
    };
    plain.notFoundPaths.add("/Shared/source.txt");
    const rooted = new FilesRootedResidentPort({ vault, plain });

    const operation = rooted.move(
      "/Vault/source.txt",
      "/Shared/source.txt",
      false,
      undefined,
      POLICY,
    );
    await expect(operation).rejects.toMatchObject({
      code: "uncertain",
      details: {
        from: "/Vault/source.txt",
        to: "/Shared/source.txt",
      },
    });
    expect(events).toEqual([
      "plain:stat",
      "vault:stat",
      "vault:read",
      "plain:write",
      "vault:stat",
      "plain:stat",
      "vault:stat",
      "plain:stat",
      "vault:remove",
    ]);
    expect(
      plain.calls.filter((call) => call.method === "remove"),
    ).toEqual([]);
  });

  test("does not start source deletion when a child changes during copy", async () => {
    const sourceChild = treeFile("/race/original.txt");
    const vault = new TreeResidentPort("vault", [
      folder("/race"),
      sourceChild,
    ]);
    const plain = new TreeResidentPort("plain");
    plain.onAfterWrite = () => {
      vault.entries.set(
        sourceChild.path,
        file(sourceChild.path, "changed-digest", {
          structuralRevision: nat(2),
          modifiedAtNs: nat(2),
        }),
      );
    };
    const rooted = new FilesRootedResidentPort({ vault, plain });

    await expect(
      rooted.move(
        "/Vault/race",
        "/Workspace/race",
        false,
        undefined,
        POLICY,
      ),
    ).rejects.toMatchObject({
      code: "uncertain",
    });

    expect(vault.removeCalls).toEqual([]);
    expect(vault.entries.get("/race/original.txt")).toMatchObject({
      etagSha256: "changed-digest",
      structuralRevision: "2",
    });
  });

  test("keeps the source when the copied destination is deleted or replaced", async () => {
    for (const mutation of ["deleted", "replaced"] as const) {
      const source = treeFile("/source.txt");
      const vault = new TreeResidentPort("vault", [source]);
      const plain = new TreeResidentPort("plain");
      plain.onBeforeStat = (path, call) => {
        if (path !== "/Workspace/source.txt" || call !== 3) return;
        if (mutation === "deleted") {
          plain.entries.delete(path);
        } else {
          plain.entries.set(
            path,
            treeFile(path, {
              etagSha256: "replacement-digest",
              createdAtNs: nat(2),
              modifiedAtNs: nat(2),
              structuralRevision: nat(2),
              contentId: "replacement-content",
            }),
          );
        }
      };
      const rooted = new FilesRootedResidentPort({ vault, plain });

      await expect(
        rooted.move(
          "/Vault/source.txt",
          "/Workspace/source.txt",
          false,
          undefined,
          POLICY,
        ),
      ).rejects.toMatchObject({
        code: "uncertain",
      });

      expect(vault.entries.get(source.path)).toEqual(source);
      expect(vault.removeCalls).toEqual([]);
    }
  });

  test("never deletes a child added after the verified source snapshot", async () => {
    const original = treeFile("/incoming/original.txt");
    const vault = new TreeResidentPort("vault", [
      folder("/incoming"),
      original,
    ]);
    const plain = new TreeResidentPort("plain");
    vault.onBeforeStat = (path, call) => {
      if (path === original.path && call === 3) {
        vault.put(treeFile("/incoming/new-arrival.txt"));
      }
    };
    const rooted = new FilesRootedResidentPort({ vault, plain });

    await expect(
      rooted.move(
        "/Vault/incoming",
        "/Workspace/incoming",
        false,
        undefined,
        POLICY,
      ),
    ).rejects.toMatchObject({
      code: "uncertain",
    });

    expect(vault.entries.has("/incoming/new-arrival.txt")).toBe(true);
    expect(vault.entries.has("/incoming")).toBe(true);
    expect(vault.removeCalls.map((call) => call.path)).toEqual([
      "/incoming/original.txt",
    ]);
    expect(vault.removeCalls[0]?.precondition).toEqual({
      nodeId: null,
      structuralRevision: original.structuralRevision,
      etagSha256: original.etagSha256,
    });
  });

  test("copies and conditionally removes a source folder beyond one 200-item page", async () => {
    const childCount = 201;
    const children = Array.from({ length: childCount }, (_, index) =>
      treeFile(`/many/item-${index.toString().padStart(3, "0")}.bin`)
    );
    const vault = new TreeResidentPort("vault", [
      folder("/many"),
      ...children,
    ]);
    const plain = new TreeResidentPort("plain");
    const rooted = new FilesRootedResidentPort({ vault, plain });

    await expect(
      rooted.move(
        "/Vault/many",
        "/Workspace/many",
        false,
        undefined,
        POLICY,
      ),
    ).resolves.toMatchObject({
      path: "/Workspace/many",
      changed: 1,
    });

    expect(vault.entries.size).toBe(0);
    expect(plain.entries.size).toBe(childCount + 1);
    expect(
      vault.listCalls
        .filter((call) => call.path === "/many")
        .map((call) => call.cursor),
    ).toEqual([null, "200", null, "200", null]);
    expect(vault.removeCalls).toHaveLength(childCount + 1);
    expect(
      vault.removeCalls.every(
        (call) =>
          call.recursive === false &&
          call.precondition !== undefined,
      ),
    ).toBe(true);
  });

  test("rejects an existing destination without deleting or replacing it", async () => {
    const vault = new TreeResidentPort("vault", [
      treeFile("/source.txt"),
    ]);
    const existing = treeFile("/Workspace/existing.txt", {
      etagSha256: "keep-this-digest",
    });
    const plain = new TreeResidentPort("plain", [existing]);
    const rooted = new FilesRootedResidentPort({ vault, plain });

    await expect(
      rooted.move(
        "/Vault/source.txt",
        "/Workspace/existing.txt",
        false,
        undefined,
        POLICY,
      ),
    ).rejects.toMatchObject({
      code: "conflict",
    });

    expect(plain.entries.get(existing.path)).toEqual(existing);
    expect(plain.removeCalls).toEqual([]);
    expect(vault.removeCalls).toEqual([]);
  });

  test("rollback removes only entries created by this copy", async () => {
    const vault = new TreeResidentPort("vault", [
      folder("/source"),
      treeFile("/source/a.bin"),
      treeFile("/source/b.bin"),
    ]);
    const plain = new TreeResidentPort("plain");
    const concurrent = treeFile("/Workspace/copied/keep-me.txt", {
      etagSha256: "foreign-digest",
    });
    plain.onAfterMkdir = (path) => {
      if (path === "/Workspace/copied") {
        plain.put(concurrent);
      }
    };
    plain.failWritePaths.add("/Workspace/copied/b.bin");
    const rooted = new FilesRootedResidentPort({ vault, plain });

    await expect(
      rooted.move(
        "/Vault/source",
        "/Workspace/copied",
        false,
        undefined,
        POLICY,
      ),
    ).rejects.toMatchObject({
      code: "uncertain",
      details: {
        destinationPath: "/Workspace/copied",
        publicExposurePossible: false,
      },
    });

    expect(plain.entries.get(concurrent.path)).toEqual(concurrent);
    expect(
      plain.removeCalls.some(
        (call) =>
          call.path === concurrent.path ||
          (call.path === "/Workspace/copied" && call.recursive),
      ),
    ).toBe(false);
    expect(vault.removeCalls).toEqual([]);
  });

  test("rollback retains a same-revision replacement of its Vault destination folder", async () => {
    const plain = new TreeResidentPort("plain", [
      folder("/Workspace/source"),
      treeFile("/Workspace/source/a.bin"),
      treeFile("/Workspace/source/b.bin"),
    ]);
    const vault = new TreeResidentPort("vault");
    vault.onAfterMkdir = (path) => {
      if (path !== "/copied") return;
      const created = vault.entries.get(path);
      if (created !== undefined) {
        vault.entries.set(path, {
          ...created,
          opaqueNodeIdentity: "vault-destination-original",
        });
      }
    };
    vault.onBeforeStat = (path, call) => {
      if (path !== "/copied" || call !== 3) return;
      const current = vault.entries.get(path);
      if (current !== undefined) {
        const replacement: FilesServiceEntry = {
          ...current,
          opaqueNodeIdentity: "vault-destination-replacement",
        };
        vault.entries.set(path, replacement);
      }
    };
    vault.failWritePaths.add("/copied/b.bin");
    const rooted = new FilesRootedResidentPort({ vault, plain });

    await expect(
      rooted.move(
        "/Workspace/source",
        "/Vault/copied",
        false,
        undefined,
        POLICY,
      ),
    ).rejects.toMatchObject({
      code: "uncertain",
      details: {
        destinationPath: "/Vault/copied",
        publicExposurePossible: false,
      },
    });

    expect(vault.entries.get("/copied")).toMatchObject({
      opaqueNodeIdentity: "vault-destination-replacement",
    });
    expect(
      vault.removeCalls.some((call) => call.path === "/copied"),
    ).toBe(false);
    expect(plain.removeCalls).toEqual([]);
  });

  test("uses a fresh bounded signal to clean up after cancellation", async () => {
    const controller = new AbortController();
    const vault = new TreeResidentPort("vault", [
      folder("/source"),
      treeFile("/source/a.bin"),
      treeFile("/source/b.bin"),
    ]);
    const plain = new TreeResidentPort("plain");
    plain.onBeforeWrite = (path) => {
      if (path === "/Workspace/copied/b.bin") controller.abort();
    };
    plain.failWritePaths.add("/Workspace/copied/b.bin");
    const rooted = new FilesRootedResidentPort({ vault, plain });

    await expect(
      rooted.move(
        "/Vault/source",
        "/Workspace/copied",
        false,
        controller.signal,
        POLICY,
      ),
    ).rejects.toThrow("injected destination failure");

    expect(plain.entries.size).toBe(0);
    expect(plain.removeCalls).toHaveLength(2);
    expect(
      plain.removeCalls.every(
        (call) =>
          call.signal !== controller.signal &&
          call.signal?.aborted === false,
      ),
    ).toBe(true);
    expect(vault.removeCalls).toEqual([]);
  });

  test("does not let a duplicate transfer id change backend ownership", async () => {
    const vault = new FakeResidentPort("vault");
    const plain = new FakeResidentPort("plain");
    vault.writeResult = {
      entry: file(
        "/first.bin",
        "first-digest",
      ) as FilesServiceWriteResult["entry"],
      cleanupPending: false,
    };
    const rooted = new FilesRootedResidentPort({ vault, plain });
    let release!: (bytes: Uint8Array) => void;
    const blockedSlice = new Promise<Uint8Array>((resolve) => {
      release = resolve;
    });
    const first = rooted.write({
      transferId: "same_transfer",
      path: "/Vault/first.bin",
      source: {
        size: 1,
        name: "first.bin",
        type: "application/octet-stream",
        slice() {
          return blockedSlice;
        },
      },
      contentKind: "binary",
      mediaType: "application/octet-stream",
      ifMatch: null,
      ifNoneMatch: true,
      createParents: true,
    }, undefined, POLICY);

    await expect(
      rooted.write({
        transferId: "same_transfer",
        path: "/Workspace/second.bin",
        source: {
          size: 1,
          name: "second.bin",
          type: "application/octet-stream",
          slice() {
            return new Uint8Array([2]);
          },
        },
        contentKind: "binary",
        mediaType: "application/octet-stream",
        ifMatch: null,
        ifNoneMatch: true,
        createParents: true,
      }, undefined, POLICY),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "This transfer already exists",
    });
    expect(plain.calls).toEqual([]);

    release(new Uint8Array([1]));
    await expect(first).resolves.toMatchObject({
      entry: { path: "/Vault/first.bin" },
    });
  });

  test("keeps a reused transfer owner across late cancel, status, and completion responses", async () => {
    const vault = new FakeResidentPort("vault");
    const plain = new FakeResidentPort("plain");
    const terminalStatus = residentStatus([{
      id: "aba_transfer",
      label: "old.bin",
      phase: "cancelled",
      processedBytes: 0,
      totalBytes: 1,
      error: null,
    }]);
    vault.statusHandler = () => Promise.resolve(terminalStatus);
    plain.statusHandler = () => Promise.resolve(residentStatus());
    let finishCancel!: (status: FilesServiceStatus) => void;
    vault.cancelHandler = () =>
      new Promise<FilesServiceStatus>((resolve) => {
        finishCancel = resolve;
      });

    let releaseOld!: (bytes: Uint8Array) => void;
    let releaseReplacement!: (bytes: Uint8Array) => void;
    const rooted = new FilesRootedResidentPort({ vault, plain });
    const oldWrite = rooted.write({
      transferId: "aba_transfer",
      path: "/Vault/old.bin",
      source: deferredSource("old.bin", (release) => {
        releaseOld = release;
      }),
      contentKind: "binary",
      mediaType: "application/octet-stream",
      ifMatch: null,
      ifNoneMatch: true,
      createParents: true,
    }, undefined, POLICY);
    const lateCancel = rooted.cancel("aba_transfer");

    // Authority reset forgets the old session, so this ID may be claimed
    // again while the old backend responses are still in flight.
    rooted.clearVolatile();
    const replacementWrite = rooted.write({
      transferId: "aba_transfer",
      path: "/Vault/replacement.bin",
      source: deferredSource("replacement.bin", (release) => {
        releaseReplacement = release;
      }),
      contentKind: "binary",
      mediaType: "application/octet-stream",
      ifMatch: null,
      ifNoneMatch: true,
      createParents: true,
    }, undefined, POLICY);

    finishCancel(terminalStatus);
    await expect(lateCancel).resolves.toMatchObject({
      transfers: [{ id: "aba_transfer", phase: "cancelled" }],
    });
    await expect(
      rooted.write({
        transferId: "aba_transfer",
        path: "/Vault/third.bin",
        source: immediateSource("third.bin", 3),
        contentKind: "binary",
        mediaType: "application/octet-stream",
        ifMatch: null,
        ifNoneMatch: true,
        createParents: true,
      }, undefined, POLICY),
    ).rejects.toMatchObject({ code: "conflict" });

    // The first write's even later success must also be unable to retire the
    // replacement session.
    releaseOld(new Uint8Array([1]));
    await oldWrite;
    await expect(
      rooted.write({
        transferId: "aba_transfer",
        path: "/Vault/fourth.bin",
        source: immediateSource("fourth.bin", 4),
        contentKind: "binary",
        mediaType: "application/octet-stream",
        ifMatch: null,
        ifNoneMatch: true,
        createParents: true,
      }, undefined, POLICY),
    ).rejects.toMatchObject({ code: "conflict" });

    releaseReplacement(new Uint8Array([2]));
    await replacementWrite;
  });

  test("keeps a Vault folder replaced after the final empty-list proof", async () => {
    const original = folder("/source");
    const replacement = {
      ...folder("/source"),
      nodeId: nat(99),
      // Vault entries intentionally hide node ids at the rooted boundary.
      // Keep the exposed creation/revision values equal and change another
      // available identity field to prove the final stat is rebound.
      modifiedAtNs: nat(2),
    };
    const vault = new TreeResidentPort("vault", [original]);
    const plain = new TreeResidentPort("plain");
    vault.onBeforeStat = (path, call) => {
      if (path === original.path && call === 5) {
        vault.entries.set(path, replacement);
      }
    };
    const rooted = new FilesRootedResidentPort({ vault, plain });

    await expect(
      rooted.move(
        "/Vault/source",
        "/Workspace/source",
        false,
        undefined,
        POLICY,
      ),
    ).rejects.toMatchObject({ code: "uncertain" });

    expect(vault.entries.get(original.path)).toEqual(replacement);
    expect(vault.removeCalls).toEqual([]);
    expect(plain.entries.has("/Workspace/source")).toBe(true);
  });

  test("does not adopt a same-revision Vault replacement before the final empty-list proof", async () => {
    const original = {
      ...folder("/source"),
      opaqueNodeIdentity: "vault-node-original",
    };
    const replacement = {
      ...original,
      opaqueNodeIdentity: "vault-node-replacement",
    };
    const vault = new TreeResidentPort("vault", [original]);
    const plain = new TreeResidentPort("plain");
    vault.onBeforeStat = (path, call) => {
      if (path === original.path && call === 4) {
        vault.entries.set(path, replacement);
      }
    };
    const rooted = new FilesRootedResidentPort({ vault, plain });

    await expect(
      rooted.move(
        "/Vault/source",
        "/Workspace/source",
        false,
        undefined,
        POLICY,
      ),
    ).rejects.toMatchObject({ code: "uncertain" });

    expect(vault.entries.get(original.path)).toEqual(replacement);
    expect(vault.removeCalls).toEqual([]);
    expect(plain.entries.has("/Workspace/source")).toBe(true);
  });

  test("conditionally retains a same-revision Vault folder replaced immediately before remove", async () => {
    const original = {
      ...folder("/source"),
      opaqueNodeIdentity: "vault-node-original",
    };
    const replacement = {
      ...original,
      opaqueNodeIdentity: "vault-node-replacement",
    };
    const vault = new TreeResidentPort("vault", [original]);
    const plain = new TreeResidentPort("plain");
    vault.onBeforeRemove = (path) => {
      if (path === original.path) {
        vault.entries.set(path, replacement);
      }
    };
    const rooted = new FilesRootedResidentPort({ vault, plain });

    await expect(
      rooted.move(
        "/Vault/source",
        "/Workspace/source",
        false,
        undefined,
        POLICY,
      ),
    ).rejects.toMatchObject({ code: "uncertain" });

    expect(vault.entries.get(original.path)).toEqual(replacement);
    expect(vault.removeCalls).toHaveLength(1);
    expect(vault.removeCalls[0]?.precondition).toMatchObject({
      opaqueNodeIdentity: "vault-node-original",
      structuralRevision: original.structuralRevision,
    });
    expect(plain.entries.has("/Workspace/source")).toBe(true);
  });
});

class FakeResidentPort implements FilesResidentFilePort<string> {
  readonly calls: PortCall[] = [];
  readonly writeBytes: Uint8Array[] = [];
  listResult: FilesServiceListPage<string> = page("/", []);
  statResult: FilesServiceEntry = file("/default.bin", "digest");
  readResult: FilesServiceFile = {
    entry: this.statResult as FilesServiceFile["entry"],
    bytes: new Uint8Array(),
  };
  writeResult: FilesServiceWriteResult = {
    entry: this.statResult as FilesServiceWriteResult["entry"],
    cleanupPending: false,
  };
  writeManyResult: readonly FilesServiceWriteResult[] = [];
  removeError: Error | null = null;
  writeError: Error | null = null;
  statusHandler: (() => Promise<FilesServiceStatus>) | null = null;
  cancelHandler: (() => Promise<FilesServiceStatus>) | null = null;
  readonly notFoundPaths = new Set<string>();

  constructor(
    readonly label: string,
    readonly events: string[] = [],
  ) {}

  #record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
    this.events.push(`${this.label}:${method}`);
  }

  status(): Promise<FilesServiceStatus> {
    this.#record("status");
    return this.statusHandler?.() ?? Promise.reject(unexpected("status"));
  }

  initialize(): Promise<FilesServiceStatus> {
    return Promise.reject(unexpected("initialize"));
  }

  unlock(): Promise<FilesServiceStatus> {
    return Promise.reject(unexpected("unlock"));
  }

  lock(): Promise<FilesServiceStatus> {
    return Promise.reject(unexpected("lock"));
  }

  rotate(): Promise<FilesServiceStatus> {
    return Promise.reject(unexpected("rotate"));
  }

  list(input: {
    path: string;
    cursor: string | null;
    expectedFolderRevision: CanonicalNat64 | null;
    limit: number;
    recursive: boolean;
    signal?: AbortSignal;
  }): Promise<FilesServiceListPage<string>> {
    this.#record("list", input);
    return Promise.resolve(this.listResult);
  }

  stat(
    path: string,
    signal?: AbortSignal,
  ): Promise<FilesServiceEntry> {
    this.#record("stat", path, signal);
    if (this.notFoundPaths.has(path)) {
      return Promise.reject(
        new FilesServiceFault(
          "not_found",
          "missing",
          "refresh",
        ),
      );
    }
    return Promise.resolve(this.statResult);
  }

  read(
    path: string,
    controls?: FilesTransferControls & Readonly<{ transferId?: string }>,
  ): Promise<FilesServiceFile> {
    this.#record("read", path, controls);
    return Promise.resolve(this.readResult);
  }

  async write(
    input: {
      transferId?: string;
      path: string;
      source: FilesTransferSource;
      contentKind: "text" | "binary";
      mediaType: string;
      ifMatch: string | null;
      ifNoneMatch: boolean;
      createParents: boolean;
    },
    controls?: FilesTransferControls,
  ): Promise<FilesServiceWriteResult> {
    this.#record("write", input, controls);
    const chunk = await input.source.slice(0, input.source.size);
    this.writeBytes.push(
      chunk instanceof Uint8Array
        ? chunk.slice()
        : chunk instanceof Blob
          ? new Uint8Array(await chunk.arrayBuffer())
          : new Uint8Array(chunk.slice(0)),
    );
    if (this.writeError !== null) throw this.writeError;
    this.notFoundPaths.delete(input.path);
    this.statResult = this.writeResult.entry;
    return this.writeResult;
  }

  writeMany(
    input: readonly {
      path: string;
      text: string;
      overwrite: boolean;
      createParents: boolean;
      mediaType: string;
    }[],
    controls?: FilesTransferControls,
  ): Promise<readonly FilesServiceWriteResult[]> {
    this.#record("writeMany", input, controls);
    return Promise.resolve(this.writeManyResult);
  }

  mkdir(
    path: string,
    recursive: boolean,
    signal?: AbortSignal,
  ): Promise<FilesServiceMutationResult> {
    this.#record("mkdir", path, recursive, signal);
    return Promise.resolve({
      path,
      structuralRevision: nat(2),
      changed: 1,
      cleanupPending: false,
    });
  }

  move(
    from: string,
    to: string,
    overwrite: boolean,
    signal?: AbortSignal,
  ): Promise<FilesServiceMutationResult> {
    this.#record("move", from, to, overwrite, signal);
    return Promise.resolve({
      path: to,
      structuralRevision: nat(2),
      changed: 1,
      cleanupPending: false,
    });
  }

  remove(
    path: string,
    recursive: boolean,
    signal?: AbortSignal,
    precondition?: {
      nodeId: CanonicalNat64 | null;
      structuralRevision: CanonicalNat64;
      etagSha256: string | null;
    },
  ): Promise<FilesServiceMutationResult> {
    this.#record("remove", path, recursive, signal, precondition);
    if (this.removeError !== null) return Promise.reject(this.removeError);
    return Promise.resolve({
      path,
      structuralRevision: nat(2),
      changed: 1,
      cleanupPending: false,
    });
  }

  cancel(): Promise<FilesServiceStatus> {
    this.#record("cancel");
    return this.cancelHandler?.() ?? Promise.reject(unexpected("cancel"));
  }

  retry(): Promise<FilesServiceStatus> {
    return Promise.reject(unexpected("retry"));
  }

  beginUpload(): ReturnType<
    FilesResidentFilePort<string>["beginUpload"]
  > {
    return Promise.reject(unexpected("beginUpload"));
  }

  uploadChunk(): ReturnType<
    FilesResidentFilePort<string>["uploadChunk"]
  > {
    return Promise.reject(unexpected("uploadChunk"));
  }

  clearVolatile(): void {}
}

type TreeRemoveCall = Readonly<{
  path: string;
  recursive: boolean;
  signal: AbortSignal | undefined;
  precondition:
    | Readonly<{
        structuralRevision: CanonicalNat64;
        etagSha256: string | null;
        nodeId: CanonicalNat64 | null;
        opaqueNodeIdentity?: string;
      }>
    | undefined;
}>;

class TreeResidentPort extends FakeResidentPort {
  readonly entries = new Map<string, FilesServiceEntry>();
  readonly listCalls: {
    path: string;
    cursor: string | null;
  }[] = [];
  readonly removeCalls: TreeRemoveCall[] = [];
  readonly failWritePaths = new Set<string>();
  readonly writeEtagOverrides = new Map<string, string>();
  onAfterMkdir: ((path: string) => void) | null = null;
  onAfterWrite: ((path: string) => void) | null = null;
  onBeforeWrite: ((path: string) => void) | null = null;
  onBeforeRemove: ((path: string) => void) | null = null;
  onBeforeStat:
    | ((path: string, call: number) => void)
    | null = null;
  readonly #statCounts = new Map<string, number>();

  constructor(
    label: string,
    entries: readonly FilesServiceEntry[] = [],
  ) {
    super(label);
    for (const entry of entries) this.entries.set(entry.path, entry);
  }

  put(entry: FilesServiceEntry): void {
    this.entries.set(entry.path, entry);
    this.#bumpParent(entry.path);
  }

  override list(input: {
    path: string;
    cursor: string | null;
    expectedFolderRevision: CanonicalNat64 | null;
    limit: number;
    recursive: boolean;
    signal?: AbortSignal;
  }): Promise<FilesServiceListPage<string>> {
    this.calls.push({ method: "list", args: [input] });
    this.events.push(`${this.label}:list`);
    this.listCalls.push({ path: input.path, cursor: input.cursor });
    const parent = this.entries.get(input.path);
    if (parent === undefined || parent.type !== "folder") {
      return Promise.reject(missing(input.path));
    }
    if (
      input.expectedFolderRevision !== null &&
      input.expectedFolderRevision !== parent.structuralRevision
    ) {
      return Promise.reject(
        new FilesServiceFault(
          "cursor_expired",
          "folder changed",
          "refresh",
        ),
      );
    }
    const children = [...this.entries.values()]
      .filter((entry) => parentPath(entry.path) === input.path)
      .sort((left, right) => left.name.localeCompare(right.name));
    const offset = input.cursor === null ? 0 : Number(input.cursor);
    const selected = children.slice(offset, offset + input.limit);
    const next = offset + selected.length;
    return Promise.resolve({
      path: input.path,
      folderRevision: parent.structuralRevision,
      entries: selected,
      total: children.length,
      cursor: next < children.length ? next.toString() : null,
      hasMore: next < children.length,
    });
  }

  override stat(
    path: string,
    signal?: AbortSignal,
  ): Promise<FilesServiceEntry> {
    this.calls.push({ method: "stat", args: [path, signal] });
    this.events.push(`${this.label}:stat`);
    const count = (this.#statCounts.get(path) ?? 0) + 1;
    this.#statCounts.set(path, count);
    this.onBeforeStat?.(path, count);
    const entry = this.entries.get(path);
    return entry === undefined
      ? Promise.reject(missing(path))
      : Promise.resolve(entry);
  }

  override read(
    path: string,
    controls?: FilesTransferControls & Readonly<{ transferId?: string }>,
  ): Promise<FilesServiceFile> {
    this.calls.push({ method: "read", args: [path, controls] });
    this.events.push(`${this.label}:read`);
    const entry = this.entries.get(path);
    if (
      entry === undefined ||
      entry.type !== "file" ||
      entry.byteLength === null
    ) {
      return Promise.reject(missing(path));
    }
    return Promise.resolve({
      entry: entry as FilesServiceFile["entry"],
      bytes: new Uint8Array(entry.byteLength).fill(7),
    });
  }

  override async write(
    input: {
      transferId?: string;
      path: string;
      source: FilesTransferSource;
      contentKind: "text" | "binary";
      mediaType: string;
      ifMatch: string | null;
      ifNoneMatch: boolean;
      createParents: boolean;
      moveSource?: FilesServiceMoveSource;
    },
    controls?: FilesTransferControls,
  ): Promise<FilesServiceWriteResult> {
    this.calls.push({ method: "write", args: [input, controls] });
    this.events.push(`${this.label}:write`);
    const chunk = await input.source.slice(0, input.source.size);
    const bytes =
      chunk instanceof Uint8Array
        ? chunk.slice()
        : chunk instanceof Blob
          ? new Uint8Array(await chunk.arrayBuffer())
          : new Uint8Array(chunk.slice(0));
    this.writeBytes.push(bytes);
    this.onBeforeWrite?.(input.path);
    if (this.failWritePaths.has(input.path)) {
      throw new Error("injected destination failure");
    }
    if (input.ifNoneMatch && this.entries.has(input.path)) {
      throw new FilesServiceFault(
        "conflict",
        "destination exists",
        "choose another name",
      );
    }
    const entry = treeFile(input.path, {
      byteLength: bytes.byteLength,
      contentKind: input.contentKind,
      mediaType: input.mediaType,
      etagSha256:
        this.writeEtagOverrides.get(input.path) ??
        input.moveSource?.etagSha256 ??
        `digest-${input.path.split("/").at(-1) ?? ""}`,
    });
    if (input.moveSource !== undefined) {
      const source = this.entries.get(input.moveSource.path);
      if (
        source === undefined ||
        source.nodeId !== input.moveSource.nodeId ||
        source.structuralRevision !== input.moveSource.structuralRevision ||
        source.etagSha256 !== input.moveSource.etagSha256
      ) {
        throw new FilesServiceFault(
          "conflict",
          "atomic move source changed",
          "refresh",
        );
      }
      this.entries.delete(input.moveSource.path);
      this.#bumpParent(input.moveSource.path);
    }
    this.put(entry);
    this.onAfterWrite?.(input.path);
    return {
      entry: entry as FilesServiceWriteResult["entry"],
      cleanupPending: false,
    };
  }

  override mkdir(
    path: string,
    _recursive: boolean,
    signal?: AbortSignal,
  ): Promise<FilesServiceMutationResult> {
    this.calls.push({ method: "mkdir", args: [path, true, signal] });
    this.events.push(`${this.label}:mkdir`);
    if (this.entries.has(path)) {
      return Promise.resolve({
        path,
        structuralRevision: this.entries.get(path)!.structuralRevision,
        changed: 0,
        cleanupPending: false,
      });
    }
    const entry = folder(path);
    this.put(entry);
    this.onAfterMkdir?.(path);
    return Promise.resolve({
      path,
      structuralRevision: entry.structuralRevision,
      changed: 1,
      cleanupPending: false,
    });
  }

  override remove(
    path: string,
    recursive: boolean,
    signal?: AbortSignal,
    precondition?: {
      nodeId: CanonicalNat64 | null;
      opaqueNodeIdentity?: string;
      structuralRevision: CanonicalNat64;
      etagSha256: string | null;
    },
  ): Promise<FilesServiceMutationResult> {
    this.calls.push({
      method: "remove",
      args: [path, recursive, signal, precondition],
    });
    this.events.push(`${this.label}:remove`);
    this.removeCalls.push({ path, recursive, signal, precondition });
    this.onBeforeRemove?.(path);
    const current = this.entries.get(path);
    if (current === undefined) return Promise.reject(missing(path));
    if (
      precondition !== undefined &&
      (
        (this.label !== "vault" &&
          precondition.nodeId !== current.nodeId) ||
        (
          precondition.opaqueNodeIdentity !== undefined &&
          precondition.opaqueNodeIdentity !== current.opaqueNodeIdentity
        ) ||
        precondition.structuralRevision !== current.structuralRevision ||
        precondition.etagSha256 !== current.etagSha256
      )
    ) {
      return Promise.reject(
        new FilesServiceFault(
          "conflict",
          "conditional remove rejected",
          "refresh",
        ),
      );
    }
    const descendants = [...this.entries.keys()].filter(
      (candidate) => candidate.startsWith(`${path}/`),
    );
    if (!recursive && descendants.length !== 0) {
      return Promise.reject(
        new FilesServiceFault(
          "conflict",
          "folder is not empty",
          "refresh",
        ),
      );
    }
    for (const candidate of descendants) this.entries.delete(candidate);
    this.entries.delete(path);
    this.#bumpParent(path);
    return Promise.resolve({
      path,
      structuralRevision: nat(1),
      changed: descendants.length + 1,
      cleanupPending: false,
    });
  }

  #bumpParent(path: string): void {
    const parent = parentPath(path);
    const entry = this.entries.get(parent);
    if (entry === undefined || entry.type !== "folder") return;
    this.entries.set(parent, {
      ...entry,
      modifiedAtNs: (BigInt(entry.modifiedAtNs) + 1n).toString() as CanonicalNat64,
      structuralRevision:
        (BigInt(entry.structuralRevision) + 1n).toString() as CanonicalNat64,
    });
  }
}

function deferredSource(
  name: string,
  onReady: (release: (bytes: Uint8Array) => void) => void,
): FilesTransferSource {
  let release!: (bytes: Uint8Array) => void;
  const bytes = new Promise<Uint8Array>((resolve) => {
    release = resolve;
  });
  onReady(release);
  return {
    size: 1,
    name,
    type: "application/octet-stream",
    slice() {
      return bytes;
    },
  };
}

function immediateSource(name: string, byte: number): FilesTransferSource {
  return {
    size: 1,
    name,
    type: "application/octet-stream",
    slice() {
      return new Uint8Array([byte]);
    },
  };
}

function residentStatus(
  transfers: FilesServiceStatus["transfers"] = [],
): FilesServiceStatus {
  return {
    vault: "ready",
    lockEpoch: nat(1),
    currentGeneration: nat(1),
    previousGeneration: null,
    rotationRequired: false,
    reason: null,
    quota: {
      nodes: nat(0),
      plaintextBytes: nat(0),
      ciphertextBytes: nat(0),
      physicalBytes: nat(0),
      cleanupJobs: 0,
    },
    publicUsage: {} as FilesServiceStatus["publicUsage"],
    transfers,
  };
}

function page(
  path: string,
  entries: readonly FilesServiceEntry[],
  cursor: string | null = null,
): FilesServiceListPage<string> {
  return {
    path,
    folderRevision: nat(3),
    entries,
    total: entries.length,
    cursor,
    hasMore: cursor !== null,
  };
}

function file(
  path: string,
  etagSha256: string,
  overrides: Partial<FilesServiceEntry> = {},
): FilesServiceEntry {
  return {
    nodeId: nat(1),
    path,
    name: path.split("/").at(-1) ?? "",
    type: "file",
    contentKind: "binary",
    byteLength: 3,
    mediaType: "application/octet-stream",
    etagSha256,
    publicUrl: null,
    createdAtNs: nat(1),
    modifiedAtNs: nat(1),
    structuralRevision: nat(1),
    contentId: "content-1",
    ...overrides,
  };
}

function folder(path: string): FilesServiceEntry {
  return {
    nodeId: nat(1),
    path,
    name: path.split("/").at(-1) ?? "",
    type: "folder",
    contentKind: null,
    byteLength: null,
    mediaType: null,
    etagSha256: null,
    publicUrl: null,
    createdAtNs: nat(1),
    modifiedAtNs: nat(1),
    structuralRevision: nat(1),
    contentId: null,
  };
}

function treeFile(
  path: string,
  overrides: Partial<FilesServiceEntry> = {},
): FilesServiceEntry {
  return file(path, `digest-${path.split("/").at(-1) ?? ""}`, {
    nodeId: nat(2),
    ...overrides,
  });
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator <= 0 ? "/" : path.slice(0, separator);
}

function missing(path: string): FilesServiceFault {
  return new FilesServiceFault(
    "not_found",
    `${path} is missing`,
    "refresh",
  );
}

function nat(value: number): CanonicalNat64 {
  return value.toString() as CanonicalNat64;
}

function unexpected(method: string): FilesServiceFault {
  return new FilesServiceFault(
    "invalid",
    `Unexpected fake-port ${method}`,
    "Fix the test",
  );
}
