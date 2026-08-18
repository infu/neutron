import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "bun:test";
import { gzipSync } from "fflate";
import { chromium, type Browser, type Page } from "playwright";
import msgpack from "tiny-msgpack";
import { hashContent } from "neutron-tools/src/hash.js";
import {
  buildPackagesCompileInput,
  preparePackageInstall,
  unpackNeutronPackage,
} from "../src/install.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PRODUCTION_UPDATE_SOURCE = "233tv-xiaaa-aaaay-aacta-cai";
const ARCHIVE_ONLY_FEATURE = "archive-only-legal-v1";
const ARCHIVE_ONLY_SOURCE_PATH = "legal/source/app-source.v1.msgpack";
const KERNEL_307_PREDECESSOR_ARCHIVE_PATH = fileURLToPath(
  new URL("./fixtures/kernel.v0.3.7.neutron", import.meta.url),
);
const FINAL_KERNEL_CANDIDATE_ARCHIVE_PATH = fileURLToPath(
  new URL("../../../apps/kernel/kernel.v0.3.10.neutron", import.meta.url),
);
const KERNEL_306_FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/kernel.v0.3.6.neutron", import.meta.url),
);
const CURRENT_PRODUCTION_APP_ARCHIVE_PATHS = [
  "../../../apps/agent/agent.v0.3.3.neutron",
  "../../../apps/chess/chess.v0.3.3.neutron",
  "../../../apps/contacts/contacts.v0.3.3.neutron",
  "../../../apps/gemma/gemma.v0.2.3.neutron",
  "../../../apps/hello/hello.v0.2.3.neutron",
  "../../../apps/hullshift/hullshift.v0.2.3.neutron",
  "../../../apps/jetcreeper/jetcreeper.v0.3.3.neutron",
  "../../../apps/kitchensink/kitchensink.v0.3.3.neutron",
  "../../../apps/mail/mail.v0.3.4.neutron",
  "../../../apps/mysubnet/mysubnet.v0.3.3.neutron",
  "../../../apps/spreadsheet/spreadsheet.v0.3.3.neutron",
  "../../../apps/vfs/files.v0.4.5.neutron",
  "../../../apps/wagyu/wagyu.v0.3.4.neutron",
  "../../../apps/wallet/wallet.v0.3.4.neutron",
].map((path) => fileURLToPath(new URL(path, import.meta.url)));

type LegacyKernelExecutableFixture = Readonly<{
  label: "v0.3.5" | "v0.3.6" | "v0.3.7";
  archivePath: string;
  bytes: number;
  sha256: string;
  mainTailMarker: string;
  prepareSymbol: string;
  batchSymbol: string;
  compileSymbol: string;
}>;

const LEGACY_KERNEL_EXECUTABLE_FIXTURES = [
  {
    label: "v0.3.5",
    archivePath: fileURLToPath(
      new URL("./fixtures/kernel.v0.3.5.neutron", import.meta.url),
    ),
    bytes: 1_918_481,
    sha256: "534e0ded262bb5700d92046a4fafad16ccf42473259edd3f18e8a0578347f2ae",
    mainTailMarker: "var _n=V(q(),1),II=document.getElementById",
    prepareSymbol: "vb",
    batchSymbol: "kR",
    compileSymbol: "Ab",
  },
  {
    label: "v0.3.6",
    archivePath: KERNEL_306_FIXTURE_PATH,
    bytes: 1_858_175,
    sha256: "b25948f68ed10f29c984e936ecfd18b95fa8d4cdec0bbd1e944b53b2a371bd8b",
    mainTailMarker: "var _n=V(q(),1),II=document.getElementById",
    prepareSymbol: "vb",
    batchSymbol: "kR",
    compileSymbol: "Ab",
  },
  {
    label: "v0.3.7",
    archivePath: KERNEL_307_PREDECESSOR_ARCHIVE_PATH,
    bytes: 1_924_034,
    sha256: "aaf329e5d526f4b5a436c440ac21a245b068172c6e4e2d6dc07696ecadc60f7d",
    mainTailMarker: "var Wn=D(J(),1),AR=document.getElementById",
    prepareSymbol: "Wk",
    batchSymbol: "Dz",
    compileSymbol: "Xk",
  },
] as const satisfies readonly LegacyKernelExecutableFixture[];
const HAS_CURRENT_RELEASE_ARTIFACTS = [
  KERNEL_307_PREDECESSOR_ARCHIVE_PATH,
  FINAL_KERNEL_CANDIDATE_ARCHIVE_PATH,
  ...CURRENT_PRODUCTION_APP_ARCHIVE_PATHS,
].every(existsSync);
const RUN_CURRENT_RELEASE_ARTIFACT_GATE =
  process.env.NEUTRON_RUN_LEGACY_CURRENT_ARCHIVE_GATE === "1";
let sharedLegacyBrowserPromise: Promise<Browser> | undefined;

afterAll(async () => {
  const browserPromise = sharedLegacyBrowserPromise;
  sharedLegacyBrowserPromise = undefined;
  if (browserPromise !== undefined) {
    await (await browserPromise).close();
  }
});

type HttpsPackageOptions = Readonly<{
  manifestExtra?: Readonly<Record<string, unknown>>;
  recordExtra?: Readonly<Record<string, unknown>>;
  includeArchiveOnlySource?: boolean;
}>;

type HttpsPackageFixture = Readonly<{
  archive: Uint8Array;
  source: Readonly<{
    kind: "https";
    revision: string;
    url: string;
    sha256: string;
    bytes: number;
  }>;
}>;

function httpsPackageFixture(
  options: HttpsPackageOptions = {},
): HttpsPackageFixture {
  const module = encoder.encode(
    "module { public type AppBackendEnvironment = (); " +
      "public class Init(_env : AppBackendEnvironment) {} }",
  );
  const entry = hashContent(module);
  const manifest = {
    format: 3,
    id: "hello",
    name: "Hello",
    version: 203,
    update_source: PRODUCTION_UPDATE_SOURCE,
    entry,
    ...options.manifestExtra,
  };
  const manifestBytes = encoder.encode(JSON.stringify(manifest));
  const licenseBytes = encoder.encode("NSAL compatibility fixture\n");
  const applicationNoticeBytes = encoder.encode(
    "Application notice compatibility fixture\n",
  );
  const thirdPartyNoticeBytes = encoder.encode(
    "Third-party notice compatibility fixture\n",
  );
  const offeredSourceBytes = gzipSync(
    encoder.encode("deterministic external source artifact fixture"),
  );
  const sourceSha256 = hashContent(offeredSourceBytes);
  const source = Object.freeze({
    kind: "https" as const,
    revision: `source-sha256:${sourceSha256}`,
    url:
      `https://${PRODUCTION_UPDATE_SOURCE}.icp0.io/repo/v1/sources/` +
      `${sourceSha256}.source.v1.msgpack.gz`,
    sha256: sourceSha256,
    bytes: offeredSourceBytes.byteLength,
  });

  const embeddedReference = (path: string, content: Uint8Array) => ({
    path,
    sha256: hashContent(content),
    bytes: content.byteLength,
  });
  const record = {
    format: 1,
    package: {
      id: "hello",
      version: 203,
      manifest: embeddedReference("neutron.json", manifestBytes),
    },
    license: {
      id: "LicenseRef-Neutron-Sovereign-Application-License-1.0",
      texts: [
        {
          id: "LicenseRef-Neutron-Sovereign-Application-License-1.0",
          ...embeddedReference("legal/LICENSE.APP.txt", licenseBytes),
        },
      ],
    },
    source,
    dependencies: [],
    notices: [
      embeddedReference("legal/APPLICATION-NOTICE.txt", applicationNoticeBytes),
      embeddedReference("legal/THIRD_PARTY_NOTICES.md", thirdPartyNoticeBytes),
    ],
    memory: null,
    build: { inputs: [], commands: [] },
    ...options.recordExtra,
  };
  const files: Record<string, Uint8Array> = {
    "neutron.json": manifestBytes,
    [`mo/${entry}.mo`]: module,
    "legal/LICENSE.APP.txt": licenseBytes,
    "legal/APPLICATION-NOTICE.txt": applicationNoticeBytes,
    "legal/THIRD_PARTY_NOTICES.md": thirdPartyNoticeBytes,
    "legal/package-record.v1.json": encoder.encode(JSON.stringify(record)),
  };
  if (options.includeArchiveOnlySource) {
    files[ARCHIVE_ONLY_SOURCE_PATH] = offeredSourceBytes;
  }

  const compressed = Object.fromEntries(
    Object.entries(files).map(([path, content]) => [path, gzipSync(content)]),
  );
  return Object.freeze({
    archive: msgpack.encode(compressed),
    source,
  });
}

function syntheticSuccessorKernelArchive(): Uint8Array {
  const files = unpackNeutronPackage(
    new Uint8Array(readFileSync(KERNEL_306_FIXTURE_PATH)),
  );
  const manifestBytes = files["neutron.json"];
  if (manifestBytes === undefined) {
    throw new Error("The v0.3.6 Kernel fixture has no neutron.json");
  }
  const manifest = JSON.parse(decoder.decode(manifestBytes)) as Record<
    string,
    unknown
  >;
  files["neutron.json"] = encoder.encode(
    JSON.stringify({ ...manifest, version: 310 }),
  );
  return msgpack.encode(
    Object.fromEntries(
      Object.entries(files).map(([path, content]) => [path, gzipSync(content)]),
    ),
  );
}

type LegacyAcceptanceResult = Readonly<{
  appId: string;
  appVersion: number;
  batchAppIds: readonly string[];
  legalPaths: readonly string[];
  source: HttpsPackageFixture["source"] | null;
}>;

type LegacyAttempt =
  | Readonly<{ ok: true; paths: readonly string[] }>
  | Readonly<{ ok: false; error: string }>;

type LegacyCompileResult = Readonly<{
  appIds: readonly string[];
  inventoryAppIds: readonly string[];
  wasmBytes: number;
  wasmMagic: readonly number[];
  diagnosticErrors: number;
  compatibilityDiagnostics: number;
}>;

async function compileLegacyArchiveBatch(
  fixture: LegacyKernelExecutableFixture,
  archives: readonly Uint8Array[],
): Promise<LegacyCompileResult> {
  return withLegacyKernelExecutable(fixture, async (page) =>
    page.evaluate(
      async (archivesBase64) => {
        const decodeBase64 = (value: string): Uint8Array => {
          const binary = atob(value);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
          }
          return bytes;
        };
        const exposed = globalThis as typeof globalThis & {
          __legacyPreparePackageInstall: (archive: Uint8Array) => unknown;
          __legacyCompilePackages: (input: { packages: unknown[] }) => Promise<{
            wasm: Uint8Array;
            diagnostics: Array<{ severity?: number }>;
            compatibilityDiagnostics: unknown[];
            appInstanceInventory: Array<{ app_id: string }>;
          }>;
        };
        const packages = archivesBase64.map((archive) =>
          exposed.__legacyPreparePackageInstall(decodeBase64(archive)),
        );
        const compiled = await exposed.__legacyCompilePackages({ packages });
        return {
          wasmBytes: compiled.wasm.byteLength,
          wasmMagic: [...compiled.wasm.slice(0, 4)],
          diagnosticErrors: compiled.diagnostics.filter(
            ({ severity }) => severity === 1,
          ).length,
          compatibilityDiagnostics: compiled.compatibilityDiagnostics.length,
          inventoryAppIds: compiled.appInstanceInventory
            .map(({ app_id }) => app_id)
            .sort(),
          appIds: packages.map(
            (prepared) =>
              (prepared as { manifest: { id: string } }).manifest.id,
          ),
        };
      },
      archives.map((archive) => Buffer.from(archive).toString("base64")),
    ),
  );
}

function expectSuccessfulLegacyCompile(
  result: LegacyCompileResult,
  expectedAppIds: readonly string[],
): void {
  expect(result.appIds).toEqual(expectedAppIds);
  expect(result.inventoryAppIds).toEqual([...expectedAppIds].sort());
  expect(result.wasmBytes).toBeGreaterThan(0);
  expect(result.wasmMagic).toEqual([0, 97, 115, 109]);
  expect(result.diagnosticErrors).toBe(0);
  expect(result.compatibilityDiagnostics).toBe(0);
}

for (const fixture of LEGACY_KERNEL_EXECUTABLE_FIXTURES) {
  test(
    `the exact ${fixture.label} browser installer accepts one Kernel-plus-HTTPS-app batch`,
    async () => {
      const app = httpsPackageFixture();
      const kernelArchive = syntheticSuccessorKernelArchive();

      const result = await withLegacyKernelExecutable(fixture, async (page) =>
        page.evaluate(
          ({ appBase64, kernelBase64 }) => {
            const decodeBase64 = (value: string): Uint8Array => {
              const binary = atob(value);
              const bytes = new Uint8Array(binary.length);
              for (let index = 0; index < binary.length; index += 1) {
                bytes[index] = binary.charCodeAt(index);
              }
              return bytes;
            };
            const exposed = globalThis as typeof globalThis & {
              __legacyPreparePackageInstall: (archive: Uint8Array) => {
                manifest: { id: string; version: number };
                files: { path: string }[];
                packageRecord?: { source: HttpsPackageFixture["source"] };
              };
              __legacyBuildPackagesCompileInput: (input: {
                packages: unknown[];
              }) => { configs: Record<string, unknown> };
            };
            const preparedKernel = exposed.__legacyPreparePackageInstall(
              decodeBase64(kernelBase64),
            );
            const preparedApp = exposed.__legacyPreparePackageInstall(
              decodeBase64(appBase64),
            );
            const batch = exposed.__legacyBuildPackagesCompileInput({
              packages: [preparedKernel, preparedApp],
            });
            return {
              appId: preparedApp.manifest.id,
              appVersion: preparedApp.manifest.version,
              batchAppIds: Object.keys(batch.configs),
              legalPaths: preparedApp.files
                .map(({ path }) => path)
                .filter((path) => path.includes("legal/"))
                .sort(),
              source: preparedApp.packageRecord?.source ?? null,
            } satisfies LegacyAcceptanceResult;
          },
          {
            appBase64: Buffer.from(app.archive).toString("base64"),
            kernelBase64: Buffer.from(kernelArchive).toString("base64"),
          },
        ),
      );

      expect(result).toEqual({
        appId: "hello",
        appVersion: 203,
        batchAppIds: ["kernel", "hello"],
        legalPaths: [
          "app/hello/pkg/legal/APPLICATION-NOTICE.txt",
          "app/hello/pkg/legal/LICENSE.APP.txt",
          "app/hello/pkg/legal/THIRD_PARTY_NOTICES.md",
          "app/hello/pkg/legal/package-record.v1.json",
        ],
        // v0.3.5 and v0.3.6 treat the sidecar as an ordinary auxiliary file;
        // v0.3.7 understands and verifies its already-supported HTTPS form.
        source: fixture.label === "v0.3.7" ? app.source : null,
      });
      expect(result.legalPaths).not.toContain(
        `app/hello/pkg/${ARCHIVE_ONLY_SOURCE_PATH}`,
      );
      expect(
        result.legalPaths.some((path) => path.includes("archive-only/")),
      ).toBe(false);
    },
    30_000,
  );
}

test("the exact v0.3.5, v0.3.6, and v0.3.7 browser compilers compile a clean HTTPS app with a successor Kernel", async () => {
  const app = httpsPackageFixture();
  const kernelArchive = syntheticSuccessorKernelArchive();
  for (const fixture of LEGACY_KERNEL_EXECUTABLE_FIXTURES) {
    const result = await compileLegacyArchiveBatch(fixture, [
      kernelArchive,
      app.archive,
    ]);
    expectSuccessfulLegacyCompile(result, ["kernel", "hello"]);
  }
}, 120_000);

test.skipIf(!RUN_CURRENT_RELEASE_ARTIFACT_GATE)(
  "release-only archived browser compilers compile the exact v0.3.10 candidate and current app archives in one batch",
  async () => {
    if (!HAS_CURRENT_RELEASE_ARTIFACTS) {
      throw new Error(
        "NEUTRON_RUN_LEGACY_CURRENT_ARCHIVE_GATE=1 requires the v0.3.7 predecessor, v0.3.10 candidate, and every current app archive",
      );
    }
    const kernelArchive = new Uint8Array(
      readFileSync(FINAL_KERNEL_CANDIDATE_ARCHIVE_PATH),
    );
    const appArchives = CURRENT_PRODUCTION_APP_ARCHIVE_PATHS.map(
      (path) => new Uint8Array(readFileSync(path)),
    );
    const currentApps = appArchives.map((archive) =>
      preparePackageInstall(archive),
    );
    for (const app of currentApps) {
      expect(app.manifest).not.toHaveProperty("package_features");
      expect(app.packageRecord?.source.kind).toBe("https");
      expect(app.packageRecord).not.toHaveProperty("features");
      expect(
        app.files.some(
          ({ path }) =>
            path.includes("legal/source/app-source.v1.msgpack") ||
            path.includes("legal/archive-only/"),
        ),
      ).toBe(false);
    }
    const expectedAppIds = [
      "kernel",
      ...currentApps.map(({ manifest }) => manifest.id),
    ];
    for (const fixture of LEGACY_KERNEL_EXECUTABLE_FIXTURES) {
      const result = await compileLegacyArchiveBatch(fixture, [
        kernelArchive,
        ...appArchives,
      ]);
      expectSuccessfulLegacyCompile(result, expectedAppIds);
    }
  },
  120_000,
);

test("the current installer accepts the same legacy-readable HTTPS app in one batch", () => {
  const app = httpsPackageFixture();
  const kernelArchive = syntheticSuccessorKernelArchive();
  const preparedKernel = preparePackageInstall(kernelArchive);
  const preparedApp = preparePackageInstall(app.archive);
  const batch = buildPackagesCompileInput({
    packages: [preparedKernel, preparedApp],
  });

  expect(preparedApp.manifest).toMatchObject({
    format: 3,
    id: "hello",
    version: 203,
    update_source: PRODUCTION_UPDATE_SOURCE,
  });
  expect(preparedApp.manifest).not.toHaveProperty("package_features");
  expect(preparedApp.packageRecord).toMatchObject({
    format: 1,
    source: app.source,
  });
  expect(preparedApp.packageRecord).not.toHaveProperty("features");
  expect(Object.keys(batch.configs)).toEqual(["kernel", "hello"]);
  expect(preparedApp.files.map(({ path }) => path)).toEqual(
    expect.arrayContaining([
      "app/hello/pkg/legal/LICENSE.APP.txt",
      "app/hello/pkg/legal/APPLICATION-NOTICE.txt",
      "app/hello/pkg/legal/THIRD_PARTY_NOTICES.md",
      "app/hello/pkg/legal/package-record.v1.json",
    ]),
  );
  expect(
    preparedApp.files.some(({ path }) =>
      path.includes(ARCHIVE_ONLY_SOURCE_PATH),
    ),
  ).toBe(false);
});

test("the executable legacy fixtures pin the closed compatibility boundary", async () => {
  const clean = httpsPackageFixture();
  const markedManifest = httpsPackageFixture({
    manifestExtra: { package_features: [ARCHIVE_ONLY_FEATURE] },
  });
  const httpsInManifest = httpsPackageFixture({
    manifestExtra: { source_url: clean.source.url },
  });
  const markedRecord = httpsPackageFixture({
    recordExtra: { features: [ARCHIVE_ONLY_FEATURE] },
  });
  const archiveOnlyPath = httpsPackageFixture({
    includeArchiveOnlySource: true,
  });
  const variants = Object.fromEntries(
    Object.entries({
      clean,
      markedManifest,
      httpsInManifest,
      markedRecord,
      archiveOnlyPath,
    }).map(([name, value]) => [
      name,
      Buffer.from(value.archive).toString("base64"),
    ]),
  );

  for (const fixture of LEGACY_KERNEL_EXECUTABLE_FIXTURES) {
    const attempts = await withLegacyKernelExecutable(fixture, async (page) =>
      page.evaluate((encodedVariants) => {
        const exposed = globalThis as typeof globalThis & {
          __legacyPreparePackageInstall: (archive: Uint8Array) => {
            files: { path: string }[];
          };
        };
        const decodeBase64 = (value: string): Uint8Array => {
          const binary = atob(value);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
          }
          return bytes;
        };
        return Object.fromEntries(
          Object.entries(encodedVariants).map(([name, value]) => {
            try {
              const prepared = exposed.__legacyPreparePackageInstall(
                decodeBase64(value),
              );
              return [
                name,
                {
                  ok: true,
                  paths: prepared.files.map(({ path }) => path),
                } satisfies LegacyAttempt,
              ];
            } catch (error) {
              return [
                name,
                {
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                } satisfies LegacyAttempt,
              ];
            }
          }),
        ) as Record<string, LegacyAttempt>;
      }, variants),
    );

    expect(attempts.clean).toMatchObject({ ok: true });
    expect(attempts.markedManifest).toMatchObject({ ok: false });
    if (!attempts.markedManifest!.ok) {
      expect(attempts.markedManifest!.error).toContain("additional property");
    }
    expect(attempts.httpsInManifest).toMatchObject({ ok: false });
    if (!attempts.httpsInManifest!.ok) {
      expect(attempts.httpsInManifest!.error).toContain("additional property");
    }

    if (fixture.label !== "v0.3.7") {
      // v0.3.5 and v0.3.6 do not interpret package-record.v1 at all.
      expect(attempts.markedRecord).toMatchObject({ ok: true });
    } else {
      // v0.3.7's record parser is closed and predates the features field.
      expect(attempts.markedRecord).toMatchObject({ ok: false });
      if (!attempts.markedRecord!.ok) {
        expect(attempts.markedRecord!.error).toContain(
          "unknown field features",
        );
      }
    }

    // Neither legacy installer recognizes this as reserved. It would be
    // publicly staged, so compatibility requires omitting it rather than
    // relying on either predecessor to filter or reject it.
    expect(attempts.archiveOnlyPath).toMatchObject({ ok: true });
    if (attempts.archiveOnlyPath?.ok) {
      expect(attempts.archiveOnlyPath.paths).toContain(
        `app/hello/pkg/${ARCHIVE_ONLY_SOURCE_PATH}`,
      );
    }
  }
}, 30_000);

async function withLegacyKernelExecutable<T>(
  fixture: LegacyKernelExecutableFixture,
  operation: (page: Page) => Promise<T>,
): Promise<T> {
  const archive = new Uint8Array(readFileSync(fixture.archivePath));
  expect(archive.byteLength).toBe(fixture.bytes);
  expect(hashContent(archive)).toBe(fixture.sha256);

  const files = unpackNeutronPackage(archive);
  const mainPath = exactlyOne(
    Object.keys(files).filter((path) =>
      /^web\/chunks\/main-[A-Z0-9]+\.js$/u.test(path),
    ),
    `${fixture.label} main browser bundle`,
  );
  const runtimePath = exactlyOne(
    Object.entries(files)
      .filter(
        ([path, content]) =>
          path.startsWith("web/chunks/") &&
          path.endsWith(".js") &&
          decoder
            .decode(content)
            .includes("Kernel runtime deployment has not been loaded"),
      )
      .map(([path]) => path),
    `${fixture.label} runtime bundle`,
  );

  let mainSource = decoder.decode(files[mainPath]);
  const mainTail = mainSource.indexOf(fixture.mainTailMarker);
  if (mainTail < 0) {
    throw new Error(`The exact ${fixture.label} parser exposure point changed`);
  }
  // Only the rendered-UI tail is replaced. The archived decoder, manifest
  // validator, package-record parser, file preparation, and batch validation
  // closures execute byte-for-byte from the immutable browser bundle.
  mainSource =
    mainSource.slice(0, mainTail) +
    `globalThis.__legacyPreparePackageInstall=${fixture.prepareSymbol};` +
    `globalThis.__legacyBuildPackagesCompileInput=${fixture.batchSymbol};` +
    `globalThis.__legacyCompilePackages=${fixture.compileSymbol};`;

  let runtimeSource = decoder.decode(files[runtimePath]);
  const emptyRuntime = "var St=4096,G=null;";
  if (!runtimeSource.includes(emptyRuntime)) {
    throw new Error(`The exact ${fixture.label} runtime fixture changed`);
  }
  const runtime = Object.freeze({
    target: "ic",
    canisterId: "ryjl3-tyaaa-aaaaa-aaaba-cai",
    deploymentId: "01".repeat(16),
    gateway: "https://icp-api.io",
    identityProvider: "https://identity.ic0.app",
    rootKeyPolicy: "mainnet",
    allowLoopbackHttp: false,
    isolatedFrameOriginTemplate:
      "https://<prefix>--ryjl3-tyaaa-aaaaa-aaaba-cai.icp0.io",
    updateSourceOrigin: null,
    local: false,
  });
  runtimeSource = runtimeSource.replace(
    emptyRuntime,
    `var St=4096,G=Object.freeze(${JSON.stringify(runtime)});`,
  );

  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
      });
      response.end(
        `<script type="module" src="/${mainPath.slice("web/".length)}"></script>`,
      );
      return;
    }
    const archivePath = `web${pathname}`;
    const content =
      archivePath === mainPath
        ? encoder.encode(mainSource)
        : archivePath === runtimePath
          ? encoder.encode(runtimeSource)
          : files[archivePath];
    if (content === undefined) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "content-type": archivePath.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : archivePath.endsWith(".wasm")
          ? "application/wasm"
          : "application/octet-stream",
    });
    response.end(Buffer.from(content));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Legacy compatibility server has no TCP address");
  }
  const port = (address as AddressInfo).port;

  let page: Page | undefined;
  try {
    const browser = await sharedLegacyBrowser();
    page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(
      () =>
        typeof (
          globalThis as typeof globalThis & {
            __legacyPreparePackageInstall?: unknown;
          }
        ).__legacyPreparePackageInstall === "function",
    );
    return await operation(page);
  } finally {
    await page?.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      );
    });
  }
}

function sharedLegacyBrowser(): Promise<Browser> {
  sharedLegacyBrowserPromise ??= launchChromium();
  return sharedLegacyBrowserPromise;
}

async function launchChromium(): Promise<Browser> {
  // NixOS cannot execute Playwright's FHS browser directly. Other CI and
  // developer environments continue to use Playwright's pinned browser.
  const systemCandidates = [
    process.env.NEUTRON_TEST_CHROME,
    "/run/current-system/sw/bin/google-chrome-stable",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  const executablePath = systemCandidates.find(
    (path): path is string => typeof path === "string" && existsSync(path),
  );
  return executablePath === undefined
    ? chromium.launch({ headless: true })
    : chromium.launch({ headless: true, executablePath });
}

function exactlyOne(values: readonly string[], label: string): string {
  if (values.length !== 1) {
    throw new Error(`Expected exactly one ${label}; found ${values.length}`);
  }
  return values[0]!;
}
