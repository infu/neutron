import { describe, expect, test } from "bun:test";
import {
  type FilesPlainBackendAdapter,
  type FilesPlainEntry,
  type FilesPlainList,
  type FilesPlainMutationResult,
} from "../src/protocol/plain_backend_adapter.ts";
import type { CanonicalNat64 } from "../src/protocol/types.ts";
import { DefaultFilesPlainPort } from "../src/resident/plain_port.ts";

describe("Files Plain recursive remove identity", () => {
  test("pins listed children and never deletes a same-path folder replacement", async () => {
    const backend = new RecursiveRemoveAbaBackend();
    const port = new DefaultFilesPlainPort({
      backend: backend as unknown as FilesPlainBackendAdapter,
    });

    await expect(
      port.remove("/Workspace/folder", true),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "The folder changed while it was being removed",
    });

    expect(backend.removeInputs).toHaveLength(1);
    expect(backend.removeInputs[0]).toMatchObject({
      path: "/folder/child.txt",
      recursive: false,
      expectedNodeId: nat(20),
      expectedRevision: nat(7),
      ifMatch: "b".repeat(64),
    });
    expect(
      backend.removeInputs.some((input) => input.path === "/folder"),
    ).toBe(false);
  });
});

class RecursiveRemoveAbaBackend {
  readonly removeInputs: Array<Readonly<{
    path: string;
    recursive: boolean;
    expectedNodeId: CanonicalNat64;
    expectedRevision: CanonicalNat64;
    ifMatch: string | null;
  }>> = [];
  #childRemoved = false;
  #listedEmpty = false;
  #returnedPostEmptyStat = false;
  #folderRevision = nat(1);

  stat(input: { path: string }): Promise<FilesPlainEntry> {
    if (input.path === "/folder/child.txt") {
      return Promise.resolve(child());
    }
    if (input.path !== "/folder") {
      return Promise.reject(new Error(`Unexpected stat: ${input.path}`));
    }
    if (this.#listedEmpty) {
      if (!this.#returnedPostEmptyStat) {
        this.#returnedPostEmptyStat = true;
        return Promise.resolve(folder(nat(10), this.#folderRevision));
      }
      return Promise.resolve(folder(nat(99), nat(1)));
    }
    return Promise.resolve(folder(nat(10), this.#folderRevision));
  }

  list(input: {
    path: string;
    cursor: null;
    limit: number;
  }): Promise<FilesPlainList> {
    if (
      input.path !== "/folder" ||
      input.cursor !== null ||
      input.limit !== 200
    ) {
      return Promise.reject(new Error("Unexpected recursive list request"));
    }
    if (!this.#childRemoved) {
      return Promise.resolve({
        revision: this.#folderRevision,
        entries: [child()],
        total: 1,
        cursor: null,
        hasMore: false,
      });
    }
    this.#listedEmpty = true;
    return Promise.resolve({
      revision: this.#folderRevision,
      entries: [],
      total: 0,
      cursor: null,
      hasMore: false,
    });
  }

  remove(input: {
    path: string;
    recursive: boolean;
    expectedNodeId: CanonicalNat64;
    expectedRevision: CanonicalNat64;
    ifMatch: string | null;
  }): Promise<FilesPlainMutationResult> {
    this.removeInputs.push({ ...input });
    if (input.path !== "/folder/child.txt") {
      return Promise.reject(new Error("Replacement folder was removed"));
    }
    this.#childRemoved = true;
    this.#folderRevision = nat(2);
    return Promise.resolve({
      path: input.path,
      revision: this.#folderRevision,
      changed: 1,
    });
  }
}

function folder(
  nodeId: CanonicalNat64,
  revision: CanonicalNat64,
): FilesPlainEntry {
  return {
    nodeId,
    path: "/folder",
    name: "folder",
    type: "folder",
    contentKind: null,
    byteLength: null,
    mediaType: null,
    etagSha256: null,
    createdAtNs: nodeId === nat(10) ? nat(1) : nat(2),
    modifiedAtNs: nat(1),
    revision,
    relativeUrl: null,
  };
}

function child(): FilesPlainEntry {
  return {
    nodeId: nat(20),
    path: "/folder/child.txt",
    name: "child.txt",
    type: "file",
    contentKind: "text",
    byteLength: 1,
    mediaType: "text/plain",
    etagSha256: "b".repeat(64),
    createdAtNs: nat(1),
    modifiedAtNs: nat(1),
    revision: nat(7),
    relativeUrl: null,
  };
}

function nat(value: number): CanonicalNat64 {
  return value.toString() as CanonicalNat64;
}
