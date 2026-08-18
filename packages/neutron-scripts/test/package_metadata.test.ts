import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import msgpack5 from "msgpack5";
import { hashContent } from "neutron-tools/src/hash.js";
import {
  NEUTRON_APP_SOURCE_SNAPSHOT_PATH,
  NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE,
  NEUTRON_PACKAGE_RECORD_PATH,
} from "neutron-tools/package_record.js";
import {
  APACHE_2_LICENSE_ID,
  NSAL_LICENSE_ID,
  ORDINARY_APP_ARCHIVE_ONLY_LICENSE_PATHS,
  ORDINARY_APP_LICENSE_PATHS,
  ORDINARY_APP_NOTICE_PATH,
  ORDINARY_APP_SOURCE_LIMITS,
  generateOrdinaryAppPackageMetadata,
} from "../src/package_metadata.ts";
import {
  THIRD_PARTY_NOTICE_INDEX_PATH,
  THIRD_PARTY_NOTICE_MATERIAL_DIRECTORY,
  type ThirdPartyNoticeBundle,
} from "../src/third_party_notices.ts";

const msgpack = msgpack5();
const textEncoder = new TextEncoder();
const sourceRepositoryRoot = fileURLToPath(
  new URL("../../../", import.meta.url),
);
const THIRD_PARTY_MATERIAL_PATH =
  `${THIRD_PARTY_NOTICE_MATERIAL_DIRECTORY}/${"a".repeat(64)}.txt`;

type Fixture = Readonly<{
  root: string;
  appRoot: string;
  appRelative: string;
  canonicalNsal: Uint8Array;
  canonicalApache: Uint8Array;
  notice: Uint8Array;
}>;

async function writeJson(target: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
}

function nsalNotice(name = "Fixture App"): string {
  return `${name}\n\n` +
    "Copyright 2026 3V Interactive\n" +
    "Licensed under the Neutron Sovereign Application License, Version 1.0.\n" +
    `SPDX-License-Identifier: ${NSAL_LICENSE_ID}\n` +
    "Provider-operated Production Use is permitted only in a Qualifying Sovereign System.\n" +
    "Private personal use is protected by sections 2 and 3. See LICENSE.APP.\n";
}

function apacheNotice(name = "Fixture App"): string {
  return `${name}\n\n` +
    "Copyright 2026 3V Interactive\n" +
    "Licensed under the Apache License, Version 2.0.\n" +
    "SPDX-License-Identifier: Apache-2.0\n";
}

function noticeBundle(): ThirdPartyNoticeBundle {
  const index = textEncoder.encode(
    "# Third-party notices\n\n- fixture-dependency 1.0.0 (MIT)\n",
  );
  const material = textEncoder.encode("MIT License\n\nFixture dependency.\n");
  return Object.freeze({
    files: Object.freeze({
      [THIRD_PARTY_NOTICE_INDEX_PATH]: index,
      [THIRD_PARTY_MATERIAL_PATH]: material,
    }),
    noticePaths: Object.freeze([
      THIRD_PARTY_NOTICE_INDEX_PATH,
      THIRD_PARTY_MATERIAL_PATH,
    ]),
    components: Object.freeze([]),
  });
}

async function createFixture(
  options: Readonly<{
    license?: typeof NSAL_LICENSE_ID | typeof APACHE_2_LICENSE_ID;
    managedMemory?: boolean;
    httpsSource?: boolean;
  }> = {},
): Promise<Fixture> {
  const license = options.license ?? NSAL_LICENSE_ID;
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "neutron-package-metadata-"),
  );
  const appRelative = "apps/fixture";
  const appRoot = path.join(root, appRelative);
  const canonicalNsal = new Uint8Array(
    await fs.readFile(path.join(sourceRepositoryRoot, "LICENSE.APP")),
  );
  const canonicalApache = new Uint8Array(
    await fs.readFile(
      path.join(
        sourceRepositoryRoot,
        "packages/neutron-design-system/LICENSE",
      ),
    ),
  );
  const notice = textEncoder.encode(
    license === NSAL_LICENSE_ID ? nsalNotice() : apacheNotice(),
  );
  const appEntry = "1".repeat(64);
  const schemaHash = "2".repeat(64);
  const schemaEntry = "3".repeat(64);
  const sourceMemory = options.managedMemory
    ? {
        state: {
          version: 1,
          schemas: { "1": { src: "memory/state/v1.mo" } },
          migrations: [],
        },
      }
    : undefined;
  const packagedMemory = options.managedMemory
    ? {
        state: {
          version: 1,
          schemas: {
            "1": { src: "memory/state/v1.mo", hash: schemaHash, entry: schemaEntry },
          },
          migrations: [],
        },
      }
    : undefined;

  await Promise.all([
    fs.mkdir(path.join(appRoot, "backend", "memory", "state"), {
      recursive: true,
    }),
    fs.mkdir(path.join(appRoot, "dist", "legal"), { recursive: true }),
    fs.mkdir(path.join(appRoot, "node_modules", "private-cache"), {
      recursive: true,
    }),
    fs.mkdir(path.join(root, "packages", "neutron-design-system"), {
      recursive: true,
    }),
    fs.mkdir(path.join(root, "packages", "runtime-lib", "src"), {
      recursive: true,
    }),
    fs.mkdir(path.join(root, "packages", "runtime-child", "src"), {
      recursive: true,
    }),
    fs.mkdir(path.join(root, "packages", "build-only", "src"), {
      recursive: true,
    }),
    fs.mkdir(path.join(root, "packages", "motoko-runtime", "src"), {
      recursive: true,
    }),
  ]);

  await Promise.all([
    writeJson(path.join(root, "package.json"), {
      name: "fixture-root",
      private: true,
      license: "Apache-2.0",
      workspaces: ["apps/*", "packages/*"],
    }),
    fs.writeFile(path.join(root, "package-lock.json"), "{\n  \"lockfileVersion\": 3\n}\n"),
    fs.writeFile(path.join(root, "LICENSE.APP"), canonicalNsal),
    writeJson(path.join(appRoot, "package.json"), {
      name: "neutron-fixture",
      version: "1.0.0",
      license,
      dependencies: { "runtime-lib": "1.0.0" },
      devDependencies: { "build-only": "1.0.0" },
    }),
    fs.writeFile(path.join(appRoot, "NOTICE"), notice),
    fs.writeFile(
      path.join(appRoot, "mops.toml"),
      "[dependencies]\ncore = \"https://example.invalid/core#v1\"\nruntime = \"../../packages/motoko-runtime\"\n",
    ),
    writeJson(path.join(appRoot, "neutron.json"), {
      format: 3,
      name: "Fixture App",
      id: "fixture_app",
      version: 101,
      src: "main.mo",
      ...(options.httpsSource
        ? { update_source: "233tv-xiaaa-aaaay-aacta-cai" }
        : {}),
      ...(sourceMemory ? { memory: sourceMemory } : {}),
    }),
    writeJson(path.join(appRoot, "dist", "neutron.json"), {
      format: 3,
      name: "Fixture App",
      id: "fixture_app",
      version: 101,
      ...(options.httpsSource
        ? { update_source: "233tv-xiaaa-aaaay-aacta-cai" }
        : { package_features: [NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE] }),
      entry: appEntry,
      ...(packagedMemory ? { memory: packagedMemory } : {}),
    }),
    fs.writeFile(path.join(appRoot, "backend", "main.mo"), "module {};\n"),
    fs.writeFile(
      path.join(appRoot, "backend", "memory", "state", "v1.mo"),
      "module { public type Mem = {}; public func init() : Mem { {} } };\n",
    ),
    fs.writeFile(path.join(appRoot, ".env"), "DO_NOT_PACKAGE=secret\n"),
    fs.writeFile(path.join(appRoot, "fixture_app.v0.1.0.neutron"), "old archive"),
    fs.writeFile(
      path.join(appRoot, "node_modules", "private-cache", "secret.txt"),
      "dependency cache",
    ),
    fs.writeFile(path.join(appRoot, "dist", "legal", "stale-gpl.txt"), "GPL"),
    fs.writeFile(
      path.join(root, "packages", "neutron-design-system", "LICENSE"),
      canonicalApache,
    ),
    writeJson(
      path.join(root, "packages", "neutron-design-system", "package.json"),
      { name: "neutron-design-system", version: "1.0.0", license: "Apache-2.0" },
    ),
    writeJson(path.join(root, "packages", "runtime-lib", "package.json"), {
      name: "runtime-lib",
      version: "1.0.0",
      license: "Apache-2.0",
      optionalDependencies: { "runtime-child": "1.0.0" },
    }),
    fs.writeFile(
      path.join(root, "packages", "runtime-lib", "src", "index.ts"),
      "export const runtime = true;\n",
    ),
    writeJson(path.join(root, "packages", "runtime-child", "package.json"), {
      name: "runtime-child",
      version: "1.0.0",
      license: "Apache-2.0",
    }),
    fs.writeFile(
      path.join(root, "packages", "runtime-child", "src", "index.ts"),
      "export const child = true;\n",
    ),
    writeJson(path.join(root, "packages", "build-only", "package.json"), {
      name: "build-only",
      version: "1.0.0",
      license: "Apache-2.0",
    }),
    fs.writeFile(
      path.join(root, "packages", "build-only", "src", "index.ts"),
      "export const buildOnly = true;\n",
    ),
    writeJson(path.join(root, "packages", "motoko-runtime", "package.json"), {
      name: "motoko-runtime",
      version: "1.0.0",
      license: "Apache-2.0",
    }),
    fs.writeFile(
      path.join(root, "packages", "motoko-runtime", "src", "Capability.mo"),
      "module {};\n",
    ),
  ]);

  if (license === APACHE_2_LICENSE_ID) {
    await fs.writeFile(path.join(appRoot, "LICENSE"), canonicalApache);
  }
  if (options.managedMemory) {
    await writeJson(path.join(appRoot, "dist", "neutron.lock.json"), {
      format: 2,
      app: "fixture_app",
      memory: {
        state: {
          schemas: {
            "1": { hash: schemaHash, entry: schemaEntry },
          },
        },
      },
    });
  }
  return { root, appRoot, appRelative, canonicalNsal, canonicalApache, notice };
}

function decodedSourcePaths(snapshot: Uint8Array): string[] {
  const decoded = msgpack.decode(Buffer.from(snapshot)) as {
    format: number;
    files: Array<{ path: string; content: Uint8Array }>;
  };
  expect(decoded.format).toBe(1);
  return decoded.files.map(({ path }) => path);
}

test("ordinary NSAL metadata is exact, deterministic, complete, and cleans stale legal files", async () => {
  const fixture = await createFixture();
  try {
    const buildNotices = async (): Promise<ThirdPartyNoticeBundle> =>
      noticeBundle();
    const first = await generateOrdinaryAppPackageMetadata({
      appRoot: fixture.appRoot,
      repositoryRoot: fixture.root,
      buildNotices,
    });
    const firstLegalPaths = (await fs.readdir(
      path.join(fixture.appRoot, "dist", "legal"),
      { recursive: true },
    )).sort();
    const second = await generateOrdinaryAppPackageMetadata({
      appRoot: fixture.appRoot,
      repositoryRoot: fixture.root,
      buildNotices,
    });

    expect(first.licenseId).toBe(NSAL_LICENSE_ID);
    expect(first.license).toEqual(fixture.canonicalNsal);
    expect(first.applicationNotice).toEqual(fixture.notice);
    expect(first.record.features).toEqual([
      NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE,
    ]);
    expect(first.sourceArtifact).toBeNull();
    expect(second.sourceSnapshot).toEqual(first.sourceSnapshot);
    expect(second.recordBytes).toEqual(first.recordBytes);
    expect(first.record.license).toEqual({
      id: NSAL_LICENSE_ID,
      texts: [
        {
          id: NSAL_LICENSE_ID,
          path: ORDINARY_APP_ARCHIVE_ONLY_LICENSE_PATHS[NSAL_LICENSE_ID],
          sha256: hashContent(fixture.canonicalNsal),
          bytes: fixture.canonicalNsal.byteLength,
        },
      ],
    });
    expect(first.record.source).toMatchObject({
      kind: "embedded",
      path: NEUTRON_APP_SOURCE_SNAPSHOT_PATH,
      sha256: hashContent(first.sourceSnapshot),
      bytes: first.sourceSnapshot.byteLength,
    });
    expect(first.record.notices.map(({ path }) => path)).toEqual([
      ORDINARY_APP_NOTICE_PATH,
      THIRD_PARTY_NOTICE_INDEX_PATH,
      THIRD_PARTY_MATERIAL_PATH,
    ]);
    expect(first.record.memory).toBeNull();
    expect(firstLegalPaths).toEqual([
      "APPLICATION-NOTICE.txt",
      "archive-only",
      "archive-only/LICENSE.APP.txt",
      "archive-only/THIRD_PARTY_NOTICES.md",
      "archive-only/third-party",
      `archive-only/third-party/${"a".repeat(64)}.txt`,
      "package-record.v1.json",
      "source",
      "source/app-source.v1.msgpack",
    ]);
    await expect(
      fs.stat(path.join(fixture.appRoot, "dist", "legal", "stale-gpl.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const sourcePaths = decodedSourcePaths(first.sourceSnapshot);
    expect(sourcePaths).toContain(`${fixture.appRelative}/NOTICE`);
    expect(sourcePaths).toContain(`${fixture.appRelative}/backend/main.mo`);
    expect(sourcePaths).toContain("packages/runtime-lib/src/index.ts");
    expect(sourcePaths).toContain("packages/runtime-child/src/index.ts");
    expect(sourcePaths).toContain("packages/motoko-runtime/src/Capability.mo");
    expect(sourcePaths).not.toContain("LICENSE.APP");
    expect(sourcePaths).not.toContain("packages/build-only/src/index.ts");
    expect(sourcePaths.some((sourcePath) => sourcePath.includes("node_modules")))
      .toBe(false);
    expect(sourcePaths.some((sourcePath) => sourcePath.endsWith(".neutron")))
      .toBe(false);
    expect(sourcePaths.some((sourcePath) => path.basename(sourcePath) === ".env"))
      .toBe(false);
    expect(first.sourceSnapshot.byteLength).toBeLessThanOrEqual(
      ORDINARY_APP_SOURCE_LIMITS.snapshotBytes,
    );
    expect(ORDINARY_APP_SOURCE_LIMITS.snapshotBytes).toBe(16 * 1024 * 1024);
    expect(
      Buffer.from(
        await fs.readFile(
          path.join(fixture.appRoot, "dist", NEUTRON_PACKAGE_RECORD_PATH),
        ),
      ).equals(Buffer.from(first.recordBytes)),
    ).toBe(true);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("update-source apps emit a legacy-readable HTTPS source offer and external artifact", async () => {
  const fixture = await createFixture({ httpsSource: true });
  try {
    const buildNotices = async (): Promise<ThirdPartyNoticeBundle> =>
      noticeBundle();
    const first = await generateOrdinaryAppPackageMetadata({
      appRoot: fixture.appRoot,
      repositoryRoot: fixture.root,
      buildNotices,
    });
    const second = await generateOrdinaryAppPackageMetadata({
      appRoot: fixture.appRoot,
      repositoryRoot: fixture.root,
      buildNotices,
    });
    const artifact = first.sourceArtifact;
    expect(artifact).not.toBeNull();
    if (artifact === null) throw new Error("Expected HTTPS source artifact");

    expect(first.record.features).toBeUndefined();
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(fixture.appRoot, "dist", "neutron.json"),
          "utf8",
        ),
      ),
    ).not.toHaveProperty("package_features");
    expect(first.record.license.texts[0]?.path).toBe(
      ORDINARY_APP_LICENSE_PATHS[NSAL_LICENSE_ID],
    );
    expect(first.record.notices.map(({ path: noticePath }) => noticePath)).toEqual([
      ORDINARY_APP_NOTICE_PATH,
      "legal/THIRD_PARTY_NOTICES.md",
      `legal/third-party/${"a".repeat(64)}.txt`,
    ]);
    expect(first.record.source).toEqual({
      kind: "https",
      revision: `source-sha256:${artifact.sha256}`,
      url:
        `https://233tv-xiaaa-aaaay-aacta-cai.icp0.io/repo/v1/sources/` +
        `${artifact.sha256}.source.v1.msgpack.gz`,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
    });
    expect(artifact.path).toBe(
      path.join(
        fixture.appRoot,
        ".neutron",
        "sources",
        `${artifact.sha256}.source.v1.msgpack.gz`,
      ),
    );
    expect([...artifact.content.slice(3, 8)]).toEqual([0, 0, 0, 0, 0]);
    expect(
      Buffer.from(gunzipSync(artifact.content)).equals(
        Buffer.from(first.sourceSnapshot),
      ),
    ).toBe(true);
    expect(
      Buffer.from(await fs.readFile(artifact.path)).equals(
        Buffer.from(artifact.content),
      ),
    ).toBe(true);
    expect(second.sourceArtifact).toEqual(artifact);
    expect(second.recordBytes).toEqual(first.recordBytes);
    expect(decodedSourcePaths(second.sourceSnapshot)).not.toContain(
      path.relative(fixture.root, artifact.path).split(path.sep).join("/"),
    );

    const legalPaths = (await fs.readdir(
      path.join(fixture.appRoot, "dist", "legal"),
      { recursive: true },
    )).sort();
    expect(legalPaths).toEqual([
      "APPLICATION-NOTICE.txt",
      "LICENSE.APP.txt",
      "THIRD_PARTY_NOTICES.md",
      "package-record.v1.json",
      "third-party",
      `third-party/${"a".repeat(64)}.txt`,
    ]);
    expect(legalPaths).not.toContain("source");
    expect(legalPaths).not.toContain("archive-only");
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("Apache ordinary metadata requires and binds the exact local Apache license", async () => {
  const fixture = await createFixture({
    license: APACHE_2_LICENSE_ID,
    httpsSource: true,
  });
  try {
    const generated = await generateOrdinaryAppPackageMetadata({
      appRoot: fixture.appRoot,
      repositoryRoot: fixture.root,
      buildNotices: async () => noticeBundle(),
    });
    expect(generated.licenseId).toBe(APACHE_2_LICENSE_ID);
    expect(generated.license).toEqual(fixture.canonicalApache);
    expect(generated.record.license.texts).toEqual([
      {
        id: APACHE_2_LICENSE_ID,
        path: ORDINARY_APP_LICENSE_PATHS[APACHE_2_LICENSE_ID],
        sha256: hashContent(fixture.canonicalApache),
        bytes: fixture.canonicalApache.byteLength,
      },
    ]);
    expect(generated.record.source.kind).toBe("https");
    expect(decodedSourcePaths(generated.sourceSnapshot)).toContain(
      `${fixture.appRelative}/LICENSE`,
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("managed-memory metadata binds the exact immutable packaged lock", async () => {
  const fixture = await createFixture({ managedMemory: true });
  try {
    const generated = await generateOrdinaryAppPackageMetadata({
      appRoot: fixture.appRoot,
      repositoryRoot: fixture.root,
      buildNotices: async () => noticeBundle(),
    });
    const lock = new Uint8Array(
      await fs.readFile(path.join(fixture.appRoot, "dist", "neutron.lock.json")),
    );
    expect(generated.record.memory).toEqual({
      lock: {
        path: "neutron.lock.json",
        sha256: hashContent(lock),
        bytes: lock.byteLength,
      },
    });
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("metadata fails closed on duplicate NSAL text, empty notices, and source symlinks", async () => {
  const fixture = await createFixture();
  try {
    await fs.writeFile(path.join(fixture.appRoot, "LICENSE"), fixture.canonicalNsal);
    await expect(
      generateOrdinaryAppPackageMetadata({
        appRoot: fixture.appRoot,
        repositoryRoot: fixture.root,
        buildNotices: async () => noticeBundle(),
      }),
    ).rejects.toThrow(/must not carry a duplicate application LICENSE/u);
    await fs.rm(path.join(fixture.appRoot, "LICENSE"));

    await expect(
      generateOrdinaryAppPackageMetadata({
        appRoot: fixture.appRoot,
        repositoryRoot: fixture.root,
        buildNotices: async () => ({
          files: Object.freeze({}),
          noticePaths: Object.freeze([]),
          components: Object.freeze([]),
        }),
      }),
    ).rejects.toThrow(/produced no notice artifact/u);

    const installedNoticePath = "legal/THIRD_PARTY_NOTICES.md";
    await expect(
      generateOrdinaryAppPackageMetadata({
        appRoot: fixture.appRoot,
        repositoryRoot: fixture.root,
        buildNotices: async () => ({
          files: Object.freeze({
            [installedNoticePath]: textEncoder.encode("not archive-only\n"),
          }),
          noticePaths: Object.freeze([installedNoticePath]),
          components: Object.freeze([]),
        }),
      }),
    ).rejects.toThrow(/must be retained below legal\/archive-only\//u);

    const packagedManifestPath = path.join(
      fixture.appRoot,
      "dist",
      "neutron.json",
    );
    const packagedManifest = JSON.parse(
      await fs.readFile(packagedManifestPath, "utf8"),
    ) as Record<string, unknown>;
    delete packagedManifest.package_features;
    await writeJson(packagedManifestPath, packagedManifest);
    await expect(
      generateOrdinaryAppPackageMetadata({
        appRoot: fixture.appRoot,
        repositoryRoot: fixture.root,
        buildNotices: async () => noticeBundle(),
      }),
    ).rejects.toThrow(/without update_source must declare package_features/u);
    packagedManifest.package_features = [
      NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE,
    ];
    await writeJson(packagedManifestPath, packagedManifest);

    await fs.symlink(
      path.join(fixture.appRoot, "backend", "main.mo"),
      path.join(fixture.appRoot, "linked-main.mo"),
    );
    await expect(
      generateOrdinaryAppPackageMetadata({
        appRoot: fixture.appRoot,
        repositoryRoot: fixture.root,
        buildNotices: async () => noticeBundle(),
      }),
    ).rejects.toThrow(/rejects symbolic link/u);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
