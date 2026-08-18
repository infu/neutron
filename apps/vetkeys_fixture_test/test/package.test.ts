import { expect, test } from "bun:test";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  preparePackageInstall,
  unpackNeutronPackage,
} from "neutron-compiler/src/install.ts";
import {
  NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE,
  type NeutronManifest,
} from "neutron-tools/src/schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";
import {
  NEUTRON_APP_SOURCE_SNAPSHOT_PATH,
  NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX,
  NEUTRON_PACKAGE_RECORD_PATH,
  neutronPackageRecordArchiveOnlyPaths,
} from "neutron-tools/package_record.js";
import {
  FIXTURE_ARCHIVE_IDS,
  buildFixtureArchives,
} from "../scripts/package-fixtures";

const rootUrl = new URL("../", import.meta.url);
const workspacePackageUrl = new URL("package.json", rootUrl);
const repositoryLockUrl = new URL("../../package-lock.json", rootUrl);
const manifestUrl = new URL("neutron.json", rootUrl);
const peerManifestUrl = new URL("peer/neutron.json", rootUrl);
const noticeUrl = new URL("NOTICE", rootUrl);
const peerNoticeUrl = new URL("peer/NOTICE", rootUrl);
const backendUrl = new URL("backend/main.mo", rootUrl);
const frontendUrl = new URL("src/index.tsx", rootUrl);
const probeUrl = new URL("src/adversarial_probe.ts", rootUrl);
const installedRunnerUrl = new URL(
  "scripts/prove-installed-origins.ts",
  rootUrl,
);
const sessionUrl = new URL("src/derivation_session.ts", rootUrl);
const htmlUrl = new URL("dist/web/index.html", rootUrl);
const cssUrl = new URL("dist/web/main.css", rootUrl);

const archiveUrls = {
  vetkeys_fixture: new URL("vetkeys_fixture.v0.1.2.neutron", rootUrl),
  vetkeys_fixture_peer: new URL(
    "vetkeys_fixture_peer.v0.1.2.neutron",
    rootUrl,
  ),
} as const;

const metadataPaths = new Set([
  "neutron.json",
  "schema.json",
]);

function isPackageMetadataPath(packagePath: string): boolean {
  return metadataPaths.has(packagePath) || packagePath.startsWith("legal/");
}

test("root lock records the exact fixture workspace and dependency surface", async () => {
  const [workspacePackage, repositoryLock] = await Promise.all([
    json<{
      name: string;
      version: string;
      license: string;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    }>(workspacePackageUrl),
    json<{ packages: Record<string, unknown> }>(repositoryLockUrl),
  ]);
  expect(repositoryLock.packages["apps/vetkeys_fixture_test"]).toEqual({
    name: workspacePackage.name,
    version: workspacePackage.version,
    license: workspacePackage.license,
    dependencies: workspacePackage.dependencies,
    devDependencies: workspacePackage.devDependencies,
  });
  expect(
    repositoryLock.packages["node_modules/neutron-vetkeys-fixture"],
  ).toEqual({
    resolved: "apps/vetkeys_fixture_test",
    link: true,
  });
});

test("two exact source manifests declare one same-named isolated slot", async () => {
  const [primary, peer] = await Promise.all([
    json<NeutronManifest>(manifestUrl),
    json<NeutronManifest>(peerManifestUrl),
  ]);
  for (const [manifest, id] of [
    [primary, "vetkeys_fixture"],
    [peer, "vetkeys_fixture_peer"],
  ] as const) {
    expect(validate_neutron_conf(manifest).valid).toBe(true);
    expect(manifest).toMatchObject({
      id,
      version: 102,
      src: "main.mo",
      tiles: [{ id: "main", path: "index.html" }],
      capabilities: {
        vetkeys: {
          slots: [{ id: "mailbox" }],
        },
      },
      func: {},
    });
    expect(manifest).not.toHaveProperty("entry");
    expect(manifest).not.toHaveProperty("memory");
    expect(manifest).not.toHaveProperty("background");
    expect(manifest).not.toHaveProperty("tray");
    expect(manifest).not.toHaveProperty("init_arg");
    expect(Object.keys(manifest.capabilities ?? {})).toEqual(["vetkeys"]);
  }
  expect(primary.id).not.toBe(peer.id);
  expect(primary.capabilities?.vetkeys?.slots[0]?.id).toBe(
    peer.capabilities?.vetkeys?.slots[0]?.id,
  );
});

test("fixture has no backend data or callable method", async () => {
  const backend = await readFile(backendUrl, "utf8");
  expect(backend).toContain("public class Init() {}");
  expect(backend).not.toMatch(/public func/);
  expect(backend).not.toMatch(/import Memory|stable\s+(?:var|let)|HashMap|Map\./);
});

test("normal browser flow is source-bound and never projects private bytes", async () => {
  const [frontend, probe, runner, session] = await Promise.all([
    readFile(frontendUrl, "utf8"),
    readFile(probeUrl, "utf8"),
    readFile(installedRunnerUrl, "utf8"),
    readFile(sessionUrl, "utf8"),
  ]);
  expect(frontend).toContain('requestVetKeys({ action: "reserve", slot: FIXTURE_SLOT })');
  expect(frontend).toContain("listVetKeys()");
  expect(frontend).toContain("getVetKeyPublicKey({");
  expect(frontend).toContain("deriveVetKey(");
  expect(frontend).toContain(
    "approveVetKeyDerivation({ challengeId: next.challengeId })",
  );
  expect(frontend).toContain("installLocalOriginProbe(fixtureAppId)");
  expect(frontend).toContain("installLocalRedactionProbe(fixtureAppId)");
  expect(frontend).not.toMatch(/Approve unlock|>Unlock<|>Lock<|focused approval/i);
  expect(frontend).not.toMatch(/requestVetKeys\([^)]*appId/s);
  expect(frontend).not.toMatch(/getVetKeyPublicKey\([^)]*appId/s);
  expect(frontend).not.toMatch(/deriveVetKey\([^)]*appId/s);
  expect(frontend).not.toMatch(/localStorage|sessionStorage|indexedDB/);

  expect(probe).toContain("injectPeerAppId");
  expect(probe).toContain("foreignChallenge.confirm");
  expect(probe).toContain("confirmOwnDerivation");
  expect(probe).toContain("isLoopbackBrowserHost(window.location.hostname)");
  expect(probe).not.toMatch(/return\s+.*encryptedKey|privateKey|localStorage|indexedDB/);
  expect(runner).toContain("await reserveFixtureIfMissing(page, frame, appId)");
  expect(runner).toContain('[data-tid="vetkeys-fixture-reserve"]');
  expect(runner).toContain('[data-tid="vetkeys-lifecycle-dialog"]');
  expect(runner).toContain('[data-tid="vetkeys-lifecycle-approve"]');
  expect(runner).toContain("const binding = await compareInstalledBindings");
  expect(runner.indexOf("await reserveFixtureIfMissing(page, frame, appId)"))
    .toBeLessThan(runner.indexOf("const binding = await compareInstalledBindings"));
  expect(session).toContain("#keyHandle");
  expect(session).not.toMatch(/signatureBytes\(|\.serialize\(\)|postMessage\(/);
  expect(session).not.toMatch(/console\.(?:log|debug|info|warn|error)/);
});

test("self-contained tile uses the shared design system", async () => {
  const [html, css] = await Promise.all([
    readFile(htmlUrl, "utf8"),
    readFile(cssUrl, "utf8"),
  ]);
  expect(html).toContain('<script type="module" src="./main.js"></script>');
  expect(html).toContain('<link rel="stylesheet" href="./main.css" />');
  expect(css).toContain(".nt-app");
  expect(css).toContain(".vk-fixture-evidence");
  expect(css).not.toMatch(/gradient\s*\(/i);
  expect(css).not.toMatch(/https?:\/\//i);
});

test("both deterministic archives carry exact manifests, schemas, and ids", async () => {
  const [primarySource, peerSource] = await Promise.all([
    json<Record<string, unknown>>(manifestUrl),
    json<Record<string, unknown>>(peerManifestUrl),
  ]);
  const archives = await readArchives();

  for (const id of FIXTURE_ARCHIVE_IDS) {
    const unpacked = archives[id];
    const manifest = decodeJson(unpacked["neutron.json"]!);
    const schema = decodeJson(unpacked["schema.json"]!);
    const source = id === "vetkeys_fixture" ? primarySource : peerSource;
    const expectedNotice = await readFile(
      id === "vetkeys_fixture" ? noticeUrl : peerNoticeUrl,
    );

    expect(manifest).toEqual({
      ...source,
      entry: expect.stringMatching(/^[a-f0-9]{64}$/u),
      package_features: [NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE],
    });
    expect(unpacked).not.toHaveProperty("neutron.lock.json");
    expect(schema).toEqual({
      $schema: "https://neutron.app/schema/app-methods.v1.json",
      version: 1,
      app: {
        id,
        name: source.name,
        version: 102,
      },
      methods: {},
    });

    const prepared = preparePackageInstall(unpacked);
    expect(prepared.manifest.id).toBe(id);
    expect(prepared.appPrefix).toBe(`app/${id}/`);
    expect(prepared.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        `app/${id}/index.html`,
        `app/${id}/main.css`,
        `app/${id}/main.js`,
        `app/${id}/static/icon.svg`,
      ]),
    );
    expect(prepared.packageRecord?.package).toMatchObject({ id, version: 102 });
    expect(prepared.packageRecord?.license.id).toBe(
      "LicenseRef-Neutron-Sovereign-Application-License-1.0",
    );
    expect(prepared.packageRecord?.source).toMatchObject({
      kind: "embedded",
      path: NEUTRON_APP_SOURCE_SNAPSHOT_PATH,
    });
    expect(prepared.packageRecord?.notices.map(({ path }) => path)).toContain(
      "legal/APPLICATION-NOTICE.txt",
    );
    expect(
      Buffer.from(unpacked["legal/APPLICATION-NOTICE.txt"]!).equals(
        expectedNotice,
      ),
    ).toBe(true);
    const expectedSourcePrefix = id === "vetkeys_fixture"
      ? "apps/vetkeys_fixture_test"
      : "apps/vetkeys_fixture_test/peer";
    expect(prepared.packageRecord?.build.inputs.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        `${expectedSourcePrefix}/NOTICE`,
        `${expectedSourcePrefix}/neutron.json`,
      ]),
    );
    const stagedPaths = new Set(prepared.files.map(({ path }) => path));
    for (const archiveOnlyPath of neutronPackageRecordArchiveOnlyPaths(
      prepared.packageRecord!,
    )) {
      expect(stagedPaths.has(`${prepared.appPrefix}pkg/${archiveOnlyPath}`))
        .toBe(false);
    }
  }

  expect(decodeJson(archives.vetkeys_fixture["neutron.json"]!).entry).toBe(
    decodeJson(archives.vetkeys_fixture_peer["neutron.json"]!).entry,
  );
});

test("archives contain identical compiled assets and no undeclared payload", async () => {
  const archives = await readArchives();
  const primaryPaths = Object.keys(archives.vetkeys_fixture).sort();
  const peerPaths = Object.keys(archives.vetkeys_fixture_peer).sort();
  expect(peerPaths).toEqual(primaryPaths);

  for (const path of primaryPaths) {
    const allowed =
      isPackageMetadataPath(path) ||
      path === "web/index.html" ||
      path === "web/main.css" ||
      path === "web/main.js" ||
      path === "web/static/icon.svg" ||
      /^mo\/[a-f0-9]{64}\.mo$/u.test(path);
    expect(allowed, `unexpected package path ${path}`).toBe(true);
    expect(path).not.toMatch(/\.(?:map|scss|ts|tsx|neutron)$/u);
    if (!isPackageMetadataPath(path)) {
      expect(Buffer.from(archives.vetkeys_fixture_peer[path]!)).toEqual(
        Buffer.from(archives.vetkeys_fixture[path]!),
      );
    }
  }
  expect(primaryPaths).toEqual(expect.arrayContaining([
    "neutron.json",
    "schema.json",
    NEUTRON_PACKAGE_RECORD_PATH,
    `${NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX}LICENSE.APP.txt`,
    NEUTRON_APP_SOURCE_SNAPSHOT_PATH,
    "legal/APPLICATION-NOTICE.txt",
    "web/index.html",
    "web/main.js",
    "web/main.css",
    "web/static/icon.svg",
  ]));
});

test("dual packaging is byte-deterministic and never rewrites either source manifest", async () => {
  const before = await Promise.all([
    readFile(manifestUrl),
    readFile(peerManifestUrl),
  ]);
  const [first, second] = await Promise.all([
    buildFixtureArchives(),
    buildFixtureArchives(),
  ]);
  expect(first.map(({ id, filename }) => ({ id, filename }))).toEqual([
    {
      id: "vetkeys_fixture",
      filename: "vetkeys_fixture.v0.1.2.neutron",
    },
    {
      id: "vetkeys_fixture_peer",
      filename: "vetkeys_fixture_peer.v0.1.2.neutron",
    },
  ]);
  for (let index = 0; index < first.length; index += 1) {
    expect(Buffer.from(first[index]!.bytes)).toEqual(
      Buffer.from(second[index]!.bytes),
    );
    expect(Buffer.from(first[index]!.bytes)).toEqual(
      await readFile(new URL(first[index]!.filename, rootUrl)),
    );
  }
  expect(Buffer.from(first[0]!.bytes)).not.toEqual(Buffer.from(first[1]!.bytes));
  const after = await Promise.all([
    readFile(manifestUrl),
    readFile(peerManifestUrl),
  ]);
  expect(after).toEqual(before);
  expect((await readdir(rootUrl)).filter((name) => name.endsWith(".neutron")).sort())
    .toEqual([
      "vetkeys_fixture.v0.1.0.neutron",
      "vetkeys_fixture.v0.1.1.neutron",
      "vetkeys_fixture.v0.1.2.neutron",
      "vetkeys_fixture_peer.v0.1.0.neutron",
      "vetkeys_fixture_peer.v0.1.1.neutron",
      "vetkeys_fixture_peer.v0.1.2.neutron",
    ]);
});

test("dual packaging works from a clean dist without a memory lock", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "neutron-vetkeys-fixture-package-"),
  );
  try {
    await Promise.all([
      cp(new URL("dist", rootUrl), path.join(temporaryRoot, "dist"), {
        recursive: true,
      }),
      mkdir(path.join(temporaryRoot, "peer"), { recursive: true }),
    ]);
    await cp(
      peerManifestUrl,
      path.join(temporaryRoot, "peer", "neutron.json"),
    );
    await rm(
      path.join(temporaryRoot, "dist", "neutron.lock.json"),
      { force: true },
    );

    const builds = await buildFixtureArchives(
      temporaryRoot,
      fileURLToPath(rootUrl),
    );
    expect(builds.map(({ id }) => id)).toEqual([...FIXTURE_ARCHIVE_IDS]);
    for (const build of builds) {
      const unpacked = unpackNeutronPackage(build.bytes);
      expect(unpacked).not.toHaveProperty("neutron.lock.json");
      expect(preparePackageInstall(build.bytes).manifest.id).toBe(build.id);
    }
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

async function readArchives(): Promise<Record<
  (typeof FIXTURE_ARCHIVE_IDS)[number],
  ReturnType<typeof unpackNeutronPackage>
>> {
  return {
    vetkeys_fixture: unpackNeutronPackage(
      await readFile(archiveUrls.vetkeys_fixture),
    ),
    vetkeys_fixture_peer: unpackNeutronPackage(
      await readFile(archiveUrls.vetkeys_fixture_peer),
    ),
  };
}

async function json<T>(url: URL): Promise<T> {
  return JSON.parse(await readFile(url, "utf8")) as T;
}

function decodeJson(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}
