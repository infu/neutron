import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { packDirectory } from "neutron-scripts/src/pack.ts";
import {
  hashContent,
  removeCommentsAndEmptyLines,
} from "neutron-scripts/src/walk.ts";
import {
  assertArchiveMatchesDist,
  assertFreshLockManifest,
  assertFreshLockResetNeeded,
  assertReleaseEvidenceCurrent,
  DEFAULT_FILES_ROOT,
  digestTree,
  validateHardCutState,
} from "../scripts/release.ts";
import {
  buildFilesInlineWorkerBundle,
  filesInlineWorkerModule,
} from "../scripts/worker_bundle.ts";
import { createDefaultFilesResidentPort } from "../src/vault/index.ts";

const DEFAULT_RESIDENT_METHODS = [
  "status",
  "initialize",
  "unlock",
  "lock",
  "rotate",
  "list",
  "stat",
  "read",
  "write",
  "writeMany",
  "mkdir",
  "move",
  "remove",
  "cancel",
  "retry",
  "beginUpload",
  "uploadChunk",
  "clearVolatile",
] as const;

test("inline worker evidence is deterministic and contains the real runtime", async () => {
  const first = await buildFilesInlineWorkerBundle(DEFAULT_FILES_ROOT);
  const second = await buildFilesInlineWorkerBundle(DEFAULT_FILES_ROOT);
  expect(second.sha256).toBe(first.sha256);
  expect(first.source).toContain(first.marker);
  expect(first.source).toContain("initialize_vault");
  expect(first.source).toContain("neutron.files.vault.v2");
  expect(first.source).toContain("neutron-browser-secret-cache-v1");
  expect(first.source.length).toBeGreaterThan(1_000);
  expect(first.source).not.toMatch(
    /\b(?:localStorage|setInterval|vfs_store)\b/iu,
  );
  expect(filesInlineWorkerModule(first)).toContain(first.marker);
});

test("default resident factory is lazy, concrete, and exposes the complete port", async () => {
  const port = await createDefaultFilesResidentPort();
  for (const method of DEFAULT_RESIDENT_METHODS) {
    expect(typeof port[method], method).toBe("function");
  }
  expect(() => port.clearVolatile()).not.toThrow();
});

test("normal packaging keeps the Playwright release gate separate", async () => {
  const workspace = JSON.parse(
    await readFile(join(DEFAULT_FILES_ROOT, "package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };
  expect(workspace.scripts?.package).toBeDefined();
  expect(workspace.scripts?.package).not.toMatch(
    /(?:release:browser|playwright|chromium)/iu,
  );
  expect(workspace.scripts?.["release:browser"]).toBe(
    "bun scripts/worker_browser_release.ts",
  );
});

test("release tree digests bind paths, lengths, and contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "files-release-tree-"));
  try {
    await writeFile(join(root, "a"), "same");
    await writeFile(join(root, "b"), "same");
    const first = await digestTree(root, ["a", "b"]);
    const reordered = await digestTree(root, ["b", "a"]);
    expect(reordered).toEqual(first);

    await writeFile(join(root, "b"), "changed");
    const changed = await digestTree(root, ["a", "b"]);
    expect(changed.sha256).not.toBe(first.sha256);
    expect(changed.bytes).toBeGreaterThan(first.bytes);

    await writeFile(join(root, "b"), "same");
    const renamed = await digestTree(root, ["b"]);
    const original = await digestTree(root, ["a"]);
    expect(renamed.sha256).not.toBe(original.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release evidence fails closed after source or output drift", () => {
  const current = {
    schema: "fixture",
    source_binding: { files: { sha256: "a".repeat(64) } },
    package_payload_without_evidence: { sha256: "b".repeat(64) },
  };
  expect(() => assertReleaseEvidenceCurrent(current, structuredClone(current)))
    .not.toThrow();
  expect(() =>
    assertReleaseEvidenceCurrent(current, {
      ...current,
      source_binding: { files: { sha256: "c".repeat(64) } },
    })
  ).toThrow(/stale relative to current sources or dist/u);
  expect(() =>
    assertReleaseEvidenceCurrent(current, {
      ...current,
      package_payload_without_evidence: { sha256: "d".repeat(64) },
    })
  ).toThrow(/stale relative to current sources or dist/u);
});

test("archive verification rejects stale ignored payload bytes and paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "files-release-archive-"));
  try {
    await writeFile(
      join(root, "neutron.json"),
      `${JSON.stringify({ id: "release_fixture", version: 100 }, null, 2)}\n`,
    );
    await mkdir(join(root, "dist", "web"), { recursive: true });
    await writeFile(join(root, "dist", "web", "main.js"), "current");
    const archivePath = await packDirectory(root);
    const archive = await readFile(archivePath);
    await expect(
      assertArchiveMatchesDist(archive, join(root, "dist")),
    ).resolves.toBeUndefined();

    await writeFile(join(root, "dist", "web", "main.js"), "new source build");
    await expect(
      assertArchiveMatchesDist(archive, join(root, "dist")),
    ).rejects.toThrow(/stale bytes/u);

    await writeFile(join(root, "dist", "web", "stale.js"), "ignored residue");
    await expect(
      assertArchiveMatchesDist(archive, join(root, "dist")),
    ).rejects.toThrow(/path set differs/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release validation binds both schemas, the V1-to-V2 migration, and both locks", async () => {
  const root = await mkdtemp(join(tmpdir(), "files-release-lock-"));
  try {
    const schemaV1 =
      "module { public type Mem = { var installed : Bool }; public func init() : Mem { { var installed = true } } }\n";
    const schemaV2 =
      "module { public type Mem = { var installed : Bool; var migrated : Bool }; public func init() : Mem { { var installed = true; var migrated = false } } }\n";
    const migration =
      "module { public func migrate(old : { var installed : Bool }) : { var installed : Bool; var migrated : Bool } { { var installed = old.installed; var migrated = true } } }\n";
    const appModule = "module {}\n";
    const appEntry = hashContent(appModule);
    const schemaV1Hash = hashContent(
      removeCommentsAndEmptyLines(schemaV1),
    );
    const schemaV1Entry = hashContent(schemaV1);
    const schemaV2Hash = hashContent(
      removeCommentsAndEmptyLines(schemaV2),
    );
    const schemaV2Entry = hashContent(schemaV2);
    const migrationEntry = hashContent(migration);
    const manifest = {
      format: 3,
      id: "files",
      name: "Files",
      version: 300,
      src: "main.mo",
      memory: {
        files: {
          version: 2,
          schemas: {
            "1": { src: "memory/files/v1.mo" },
            "2": { src: "memory/files/v2.mo" },
          },
          migrations: [
            {
              from: 1,
              to: 2,
              src: "memory/files/v1_to_v2.mo",
            },
          ],
        },
      },
    };
    const lock = {
      format: 2,
      app: "files",
      memory: {
        files: {
          schemas: {
            "1": { hash: schemaV1Hash, entry: schemaV1Entry },
            "2": { hash: schemaV2Hash, entry: schemaV2Entry },
          },
          migrations: {
            "1->2": migrationEntry,
          },
        },
      },
    };
    const packagedManifest = {
      ...manifest,
      entry: appEntry,
      memory: {
        files: {
          ...manifest.memory.files,
          schemas: {
            "1": {
              src: "memory/files/v1.mo",
              hash: schemaV1Hash,
              entry: schemaV1Entry,
            },
            "2": {
              src: "memory/files/v2.mo",
              hash: schemaV2Hash,
              entry: schemaV2Entry,
            },
          },
          migrations: [
            {
              from: 1,
              to: 2,
              src: "memory/files/v1_to_v2.mo",
              entry: migrationEntry,
            },
          ],
        },
      },
    };

    await mkdir(join(root, "backend", "memory", "files"), { recursive: true });
    await mkdir(join(root, "dist", "mo"), { recursive: true });
    await writeFile(
      join(root, "backend", "memory", "files", "v1.mo"),
      schemaV1,
    );
    await writeFile(
      join(root, "backend", "memory", "files", "v2.mo"),
      schemaV2,
    );
    await writeFile(
      join(root, "backend", "memory", "files", "v1_to_v2.mo"),
      migration,
    );
    await writeFile(join(root, "dist", "mo", `${appEntry}.mo`), appModule);
    await writeFile(
      join(root, "dist", "mo", `${schemaV1Entry}.mo`),
      schemaV1,
    );
    await writeFile(
      join(root, "dist", "mo", `${schemaV2Entry}.mo`),
      schemaV2,
    );
    await writeFile(
      join(root, "dist", "mo", `${migrationEntry}.mo`),
      migration,
    );
    await writeFile(
      join(root, "neutron.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const lockBytes = `${JSON.stringify(lock, null, 2)}\n`;
    await writeFile(join(root, "neutron.lock.json"), lockBytes);
    await writeFile(join(root, "dist", "neutron.lock.json"), lockBytes);
    await writeFile(
      join(root, "dist", "neutron.json"),
      `${JSON.stringify(packagedManifest, null, 2)}\n`,
    );

    await expect(validateHardCutState(root)).resolves.toMatchObject({
      version: 300,
      lock: {
        schemas: {
          "1": { hash: schemaV1Hash, entry: schemaV1Entry },
          "2": { hash: schemaV2Hash, entry: schemaV2Entry },
        },
        migrations: {
          "1->2": migrationEntry,
        },
      },
    });

    await writeFile(
      join(root, "backend", "memory", "files", "v2.mo"),
      schemaV2.replace("migrated = false", "migrated = true"),
    );
    await expect(validateHardCutState(root)).rejects.toThrow(
      /does not bind schema 2 source/u,
    );

    await writeFile(
      join(root, "backend", "memory", "files", "v2.mo"),
      schemaV2,
    );
    await writeFile(
      join(root, "dist", "neutron.lock.json"),
      `${JSON.stringify({ ...lock, app: "other" }, null, 2)}\n`,
    );
    await expect(validateHardCutState(root)).rejects.toThrow(
      /source and packaged memory locks differ/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the historical fresh-lock reset remains unavailable to manifest 105", async () => {
  const root = await mkdtemp(join(tmpdir(), "files-release-reset-manifest-"));
  try {
    await writeFile(
      join(root, "neutron.json"),
      `${JSON.stringify({
        format: 3,
        id: "files",
        name: "Files",
        version: 105,
        src: "main.mo",
        memory: {
          files: {
            version: 2,
            schemas: {
              "1": { src: "memory/files/v1.mo" },
              "2": { src: "memory/files/v2.mo" },
            },
            migrations: [
              {
                from: 1,
                to: 2,
                src: "memory/files/v1_to_v2.mo",
              },
            ],
          },
        },
      }, null, 2)}\n`,
    );
    await expect(assertFreshLockManifest(root)).rejects.toThrow(
      /restricted to Files V2 manifest 104/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the one-time hard-cut reset refuses an already-current memory lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "files-release-reset-"));
  try {
    const schema = "module { public type Mem = { var value : Nat } }\n";
    const currentHash = hashContent(removeCommentsAndEmptyLines(schema));
    const lock = (hash: string) => ({
      format: 2,
      app: "files",
      memory: {
        files: {
          schemas: { "1": { hash, entry: "1".repeat(64) } },
          migrations: {},
        },
      },
    });
    await mkdir(join(root, "backend", "memory", "files"), { recursive: true });
    await writeFile(join(root, "backend", "memory", "files", "v1.mo"), schema);
    await writeFile(
      join(root, "neutron.lock.json"),
      `${JSON.stringify(lock("0".repeat(64)), null, 2)}\n`,
    );
    await expect(assertFreshLockResetNeeded(root)).resolves.toBeUndefined();

    await writeFile(
      join(root, "neutron.lock.json"),
      `${JSON.stringify(lock(currentHash), null, 2)}\n`,
    );
    await expect(assertFreshLockResetNeeded(root)).rejects.toThrow(
      /already binds the current V2 schema/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
