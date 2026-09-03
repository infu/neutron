import { expect, test } from "bun:test";
import { gzipSync, gunzipSync } from "fflate";
import msgpack from "tiny-msgpack";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { hashContent } from "neutron-tools/src/hash.js";
import { compareCanonicalText } from "neutron-tools/src/canonical.js";
import { physicalAppMethodName } from "neutron-tools/src/physical_names.js";
import type { NeutronBackendCallReservation } from "neutron-tools/src/capabilities/catalog.js";
import { fingerprintCapabilityPlanWireV1 } from "neutron-tools/src/capabilities/wire.js";
import {
  NEUTRON_APP_SOURCE_SNAPSHOT_PATH,
  NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE,
  NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX,
  NEUTRON_PACKAGE_RECORD_PATH,
  neutronPackageRecordArchiveOnlyPaths,
} from "neutron-tools/src/package_record.js";
import {
  NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH,
  browserSurfaceOriginsPackageMarkerBytes,
} from "neutron-tools/src/package_surface_origins.js";
import {
  createKernelRuntimeConfig,
  IC_RUNTIME_GATEWAY,
  IC_RUNTIME_IDENTITY_PROVIDER,
  isolatedFrameOriginTemplate,
  KERNEL_RUNTIME_CONFIG_PATH,
  parseKernelRuntimeConfig,
  POCKETIC_RUNTIME_GATEWAY,
  runtimeUpdateSourceOrigin,
} from "neutron-tools/src/runtime_config.js";
import { scopedLocalIdentityProvider } from "neutron-tools/src/runtime.js";
import {
  MANIFEST_MAX_FUNCTION_ARGS,
  MANIFEST_MAX_FUNCTIONS,
  MANIFEST_MAX_TILES,
} from "neutron-tools/src/schema.js";
import {
  buildPackageCompileInput,
  buildPackageInstallAssets,
  buildPackagesCompileInput,
  buildPackagesInstallAssets,
  compilePackages,
  browserSurfaceOriginAppIdsForSelectedPackages,
  browserSurfaceOriginsSidecar,
  applyRuntimeDeploymentConfig,
  buildAppUninstallCompileInput,
  buildAppsUninstallCompileInput,
  appRegistryEntry,
  appDependencyImpact,
  createStaticFileOperation,
  createDeploymentNonce,
  deployPreparedPackages as deployPreparedPackagesRaw,
  assertKernelPackageBaselineMatchesRuntime,
  assertKernelPackageStateMatchesRuntime,
  assertPreparedPackageBatch,
  assertPreparedPackageBrowserSurfaceFanout,
  assertPreparedPackageArchiveIdentity,
  mime,
  mapWithConcurrency,
  normalizeAppRegistry,
  parseBrowserSurfaceOriginsSidecar,
  planAppRegistryDependencies,
  preparePackageInstall,
  prepareCompleteDeploymentBuildRecord,
  preparePackageFiles,
  prepareInstallCodeRequest,
  readKernelPackageState,
  recoverPendingInstall,
  retainedDeploymentPackageEvidenceFromRecord,
  DEFAULT_DEPLOYMENT_ACTIVATION_TIMEOUT_MS,
  BROWSER_SURFACE_ORIGINS_PATH,
  NEUTRON_INSTALLED_APP_LIMIT,
  KERNEL_INSTALL_MAX_APP_REMOVALS_PER_COMMIT,
  KERNEL_INSTALL_MAX_CLEAR_PREFIXES_PER_COMMIT,
  KERNEL_INSTALL_MAX_COPIES,
  KERNEL_BROWSER_SURFACE_CERTIFICATION_UNITS_MAX,
  KERNEL_CONNECTION_PROVIDER_SUPPORT_ARCHIVE_PATH,
  KERNEL_CONNECTION_PROVIDER_SUPPORT_PATH,
  REMOTE_NEUTRON_PACKAGE_DECODE_LIMITS,
  unpackNeutronPackage,
  uploadPreparedFiles,
  type KernelStaticRequest,
  type AppRegistry,
  type CompileResult,
  type DeployPreparedPackagesInput,
  type KernelPackageInstaller,
  type KernelPackageState,
  type InstallJournal,
  type PreparedPackageInstall,
  type UnpackedNeutronPackage,
} from "../src/install.ts";
import {
  DEPLOYMENT_BUILD_RECORD_PATH,
  parseDeploymentBuildRecordJson,
  prepareDeterministicWasmTransport,
} from "../src/deployment_record.ts";
import {
  ASSEMBLER_ID,
  assemble,
  LEGACY_V25_ASSEMBLER_ID,
  type AssemblyManifest,
} from "../src/assemble.ts";
import { writeManagedMemoryRetirements } from "../src/memory_retirements.ts";
import { trustedInstallationContextFromRootKey } from "../src/installation_context.ts";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (value: Uint8Array): string => new TextDecoder().decode(value);
const TEST_TARGET_CANISTER_ID = "qaa6y-5yaaa-aaaaa-aaafa-cai";

test("allows slow IC actor activation after browser compilation", () => {
  expect(DEFAULT_DEPLOYMENT_ACTIVATION_TIMEOUT_MS).toBe(10 * 60_000);
});

function deployPreparedPackages(
  input: Omit<DeployPreparedPackagesInput, "targetCanisterId"> & {
    targetCanisterId?: string;
  },
) {
  const {
    targetCanisterId = TEST_TARGET_CANISTER_ID,
    ...deployment
  } = input;
  return deployPreparedPackagesRaw({ ...deployment, targetCanisterId });
}

function packageBytes(files: Record<string, Uint8Array>): Uint8Array {
  return msgpack.encode(
    Object.fromEntries(
      Object.entries(files).map(([path, content]) => [path, gzipSync(content)]),
    ),
  );
}

function encodedCompressedEntries(
  entries: Record<string, Uint8Array | number[]>,
): Uint8Array {
  return msgpack.encode(entries);
}

function duplicateEntryPackage(
  path: string,
  compressed: Uint8Array,
): Uint8Array {
  return concatChunks([
    Uint8Array.of(0x82),
    msgpack.encode(path),
    msgpack.encode(compressed),
    msgpack.encode(path),
    msgpack.encode(compressed),
  ]);
}

function helloPackageFiles(): UnpackedNeutronPackage {
  const moduleContent = bytes(
    'module { public class Init() { public func hello_world() : Text { "ok" } } }',
  );
  const hash = hashContent(moduleContent);

  return {
    "neutron.json": bytes(
      JSON.stringify({
        format: 3 as const,
        id: "hello",
        name: "Hello",
        version: 100,
        entry: hash,
        func: {
          hello_world: {
            type: "update",
            async: false,
          },
        },
      }),
    ),
    "web/index.html": bytes("<main></main>"),
    "web/main.js": bytes("console.log('hello')"),
    [`mo/${hash}.mo`]: moduleContent,
    [NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH]:
      browserSurfaceOriginsPackageMarkerBytes(),
  };
}

function withBrowserSurfaceOriginsMarker(
  files: UnpackedNeutronPackage,
): UnpackedNeutronPackage {
  return {
    ...files,
    [NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH]:
      browserSurfaceOriginsPackageMarkerBytes(),
  };
}

function withoutBrowserSurfaceOriginsMarker(
  files: UnpackedNeutronPackage,
): UnpackedNeutronPackage {
  const result = { ...files };
  delete result[NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH];
  return result;
}

const connectionProviderSupportFixture = {
  schema: "neutron.connection-provider-support.v1",
  providers: [{ provider: "openrouter", scopes: [] }],
} as const;

function kernelPackageFiles(): UnpackedNeutronPackage {
  const files = helloPackageFiles();
  delete files[NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH];
  const manifest = JSON.parse(text(files["neutron.json"]!));
  files["neutron.json"] = bytes(
    JSON.stringify({ ...manifest, id: "kernel", name: "Kernel" }),
  );
  files[KERNEL_CONNECTION_PROVIDER_SUPPORT_ARCHIVE_PATH] = bytes(
    JSON.stringify(connectionProviderSupportFixture),
  );
  return files;
}

function kernelPackageFilesAtVersion(version: number): UnpackedNeutronPackage {
  const files = kernelPackageFiles();
  const manifest = JSON.parse(text(files["neutron.json"]!));
  files["neutron.json"] = bytes(JSON.stringify({ ...manifest, version }));
  return files;
}

function withValidPackageRecord(
  files: UnpackedNeutronPackage,
): UnpackedNeutronPackage {
  const manifest = JSON.parse(text(files["neutron.json"]!));
  const isKernel = manifest.id === "kernel";
  if (!isKernel) {
    manifest.package_features = [NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE];
    files["neutron.json"] = bytes(JSON.stringify(manifest));
  }
  const licensePath = isKernel
    ? "legal/LICENSE.example.txt"
    : `${NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX}LICENSE.example.txt`;
  const noticePath = "legal/APPLICATION-NOTICE.txt";
  const sourcePath = NEUTRON_APP_SOURCE_SNAPSHOT_PATH;
  const license = bytes("Example package license\n");
  const notice = bytes("Concise application notice\n");
  const source = msgpack.encode({
    format: 1,
    package: { id: manifest.id, version: manifest.version },
    files: [
      {
        path: "neutron.json",
        mode: 0o644,
        content: files["neutron.json"]!,
      },
    ],
  });
  files[licensePath] = license;
  files[noticePath] = notice;
  if (!isKernel) files[sourcePath] = source;
  files[NEUTRON_PACKAGE_RECORD_PATH] = bytes(
    JSON.stringify({
      format: 1,
      ...(!isKernel
        ? { features: [NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE] }
        : {}),
      package: {
        id: manifest.id,
        version: manifest.version,
        manifest: {
          path: "neutron.json",
          sha256: hashContent(files["neutron.json"]!),
          bytes: files["neutron.json"]!.byteLength,
        },
      },
      license: {
        id: "LicenseRef-Example-1.0",
        texts: [
          {
            id: "LicenseRef-Example-1.0",
            path: licensePath,
            sha256: hashContent(license),
            bytes: license.byteLength,
          },
        ],
      },
      source: isKernel
        ? { kind: "status", status: "not-provided" }
        : {
            kind: "embedded",
            revision: "test-revision",
            path: sourcePath,
            sha256: hashContent(source),
            bytes: source.byteLength,
          },
      dependencies: [],
      notices: [
        {
          path: noticePath,
          sha256: hashContent(notice),
          bytes: notice.byteLength,
        },
      ],
      memory: null,
      build: isKernel
        ? { inputs: [], commands: [] }
        : {
            inputs: [
              {
                path: "neutron.json",
                sha256: hashContent(files["neutron.json"]!),
                bytes: files["neutron.json"]!.byteLength,
              },
            ],
            commands: [
              {
                purpose: "package",
                cwd: ".",
                argv: ["npm", "run", "package"],
              },
            ],
          },
    }),
  );
  return files;
}

function replacePackageRecordSource(
  files: UnpackedNeutronPackage,
  source: Uint8Array,
  buildInputs?: readonly Readonly<{
    path: string;
    sha256: string;
    bytes: number;
  }>[],
): UnpackedNeutronPackage {
  const record = JSON.parse(text(files[NEUTRON_PACKAGE_RECORD_PATH]!));
  files[NEUTRON_APP_SOURCE_SNAPSHOT_PATH] = source;
  record.source = {
    ...record.source,
    sha256: hashContent(source),
    bytes: source.byteLength,
  };
  if (buildInputs !== undefined) record.build.inputs = buildInputs;
  files[NEUTRON_PACKAGE_RECORD_PATH] = bytes(JSON.stringify(record));
  return files;
}

function connectionPackageFiles(
  provider: string,
  scopes: string[] = [],
): UnpackedNeutronPackage {
  const files = helloPackageFiles();
  const manifest = JSON.parse(text(files["neutron.json"]!));
  files["neutron.json"] = bytes(
    JSON.stringify({
      ...manifest,
      id: "connector_app",
      name: "Connector App",
      background: { path: "service.html" },
      capabilities: {
        connections: {
          api: 1,
          providers: [{ provider, scopes }],
        },
      },
    }),
  );
  files["web/service.html"] = bytes("<main></main>");
  return files;
}

function headlessPackageFiles(id: string): UnpackedNeutronPackage {
  const moduleContent = bytes("module { public class Init() {} }");
  const hash = hashContent(moduleContent);
  return {
    "neutron.json": bytes(
      JSON.stringify({
        format: 3,
        id,
        name: `Headless ${id.slice(id.lastIndexOf("_") + 1)}`,
        version: 100,
        entry: hash,
      }),
    ),
    [`mo/${hash}.mo`]: moduleContent,
  };
}

function packageFilesWithInstallReservations(
  id: string,
  reservations: NeutronBackendCallReservation[],
): UnpackedNeutronPackage {
  const files = helloPackageFiles();
  const manifest = JSON.parse(text(files["neutron.json"]!));
  files["neutron.json"] = bytes(
    JSON.stringify({
      ...manifest,
      id,
      name: `Install ${id.replaceAll("_", " ")}`,
      capabilities: {
        backend_calls: {
          api: 1,
          description: "Call approved services",
          reservation_scopes: ["exact", "method", "principal"],
          install_reservations: reservations,
          max_concurrency: 2,
          max_cycles_per_call: 10_000,
          max_cycles_per_day: 100_000,
        },
      },
    }),
  );
  return files;
}

test("unpacks package payloads and prepares install paths", () => {
  const unpacked = unpackNeutronPackage(
    packageBytes(withoutBrowserSurfaceOriginsMarker(helloPackageFiles())),
  );
  const prepared = preparePackageInstall(unpacked);

  expect(prepared.manifest.id).toBe("hello");
  expect(prepared.appPrefix).toBe("app/hello/");
  expect(prepared.isKernel).toBe(false);
  expect(prepared.browserSurfaceOriginsReady).toBe(false);
  expect(prepared.packageRecord).toBeUndefined();
  expect(prepared.archiveBytes).toBeUndefined();
  expect(prepared.archiveIdentity).toBeUndefined();
  expect(prepared.files.map((file) => file.path).sort()).toEqual([
    "app/hello/index.html",
    "app/hello/main.js",
    "app/hello/pkg/neutron.json",
    `mo/${prepared.manifest.entry}.mo`,
  ]);
});

test("captures only canonical package-generation origin readiness", () => {
  const marked = preparePackageInstall(
    withBrowserSurfaceOriginsMarker(helloPackageFiles()),
  );
  expect(marked.browserSurfaceOriginsReady).toBe(true);
  expect(marked.files.map(({ path }) => path)).toContain(
    `app/hello/pkg/${NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH}`,
  );

  const malformed = helloPackageFiles();
  malformed[NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH] = bytes(
    '{"format":2}\n',
  );
  expect(() => preparePackageInstall(malformed)).toThrow(
    `Invalid ${NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH} package marker`,
  );

  const kernelWithMarker = withBrowserSurfaceOriginsMarker(
    kernelPackageFiles(),
  );
  expect(() => preparePackageInstall(kernelWithMarker)).toThrow(
    "reserved for ordinary app packages",
  );
});

test("browser permissions implicitly opt a package into surface origins", () => {
  const files = withoutBrowserSurfaceOriginsMarker(helloPackageFiles());
  const manifest = JSON.parse(text(files["neutron.json"]!));
  files["neutron.json"] = bytes(
    JSON.stringify({
      ...manifest,
      tiles: [
        {
          id: "main",
          title: "Media",
          path: "index.html",
          icon: "index.html",
        },
      ],
      capabilities: {
        browser_permissions: {
          api: 1,
          tiles: [{ id: "main", features: ["camera"] }],
        },
      },
    }),
  );

  const prepared = preparePackageInstall(files);
  expect(prepared.browserSurfaceOriginsReady).toBe(true);
  expect(
    buildPackagesInstallAssets({
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      packages: [prepared],
      candid: "service : {}",
    }).browserSurfaceOriginAppIds,
  ).toEqual(["hello"]);
});

test("fresh origin selection adopts only ready ordinary packages", () => {
  const kernel = preparePackageInstall(kernelPackageFiles());
  const legacy = preparePackageInstall(headlessPackageFiles("legacy_app"));
  const marked = preparePackageInstall(
    withBrowserSurfaceOriginsMarker(headlessPackageFiles("marked_app")),
  );

  expect(
    browserSurfaceOriginAppIdsForSelectedPackages(
      [kernel, marked, legacy],
      ASSEMBLER_ID,
    ),
  ).toEqual(["marked_app"]);
  expect(
    browserSurfaceOriginAppIdsForSelectedPackages(
      [kernel, marked, legacy],
      LEGACY_V25_ASSEMBLER_ID,
    ),
  ).toEqual([]);
});

test("verifies bulk legal/source bytes without installing them as public assets", () => {
  const app = preparePackageInstall(withValidPackageRecord(helloPackageFiles()));
  expect(app.packageRecord?.package).toMatchObject({ id: "hello", version: 100 });
  expect(app.packageRecord?.source.kind).toBe("embedded");
  expect(app.files.map(({ path }) => path)).toContain(
    `app/hello/pkg/${NEUTRON_PACKAGE_RECORD_PATH}`,
  );
  expect(app.files.map(({ path }) => path)).toContain(
    "app/hello/pkg/legal/APPLICATION-NOTICE.txt",
  );
  expect(app.files.map(({ path }) => path)).not.toContain(
    `app/hello/pkg/${NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX}LICENSE.example.txt`,
  );
  expect(app.files.map(({ path }) => path)).not.toContain(
    `app/hello/pkg/${NEUTRON_APP_SOURCE_SNAPSHOT_PATH}`,
  );

  const kernel = preparePackageInstall(
    withValidPackageRecord(kernelPackageFiles()),
  );
  expect(kernel.packageRecord?.package.id).toBe("kernel");
  expect(kernel.packageRecord?.source).toEqual({
    kind: "status",
    status: "not-provided",
  });
  expect(kernel.files.map(({ path }) => path)).toContain(
    `pkg/${NEUTRON_PACKAGE_RECORD_PATH}`,
  );
  expect(kernel.files.map(({ path }) => path)).toContain(
    "pkg/legal/LICENSE.example.txt",
  );
});

test("rejects an unreferenced archive-only source snapshot", () => {
  const files = withValidPackageRecord(helloPackageFiles());
  const record = JSON.parse(text(files[NEUTRON_PACKAGE_RECORD_PATH]!));
  record.source = { kind: "status", status: "not-provided" };
  record.build = { inputs: [], commands: [] };
  files[NEUTRON_PACKAGE_RECORD_PATH] = bytes(JSON.stringify(record));

  expect(() => preparePackageInstall(files)).toThrow(
    `Package path ${NEUTRON_APP_SOURCE_SNAPSHOT_PATH} is reserved for the embedded source referenced by ${NEUTRON_PACKAGE_RECORD_PATH}`,
  );
});

test("rejects unreferenced files under the archive-only legal prefix", () => {
  const files = withValidPackageRecord(helloPackageFiles());
  const path = `${NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX}unclaimed.txt`;
  files[path] = bytes("not declared by a package record");

  expect(() => preparePackageInstall(files)).toThrow(
    `Package path ${path} is reserved for archive-only material referenced by ${NEUTRON_PACKAGE_RECORD_PATH}`,
  );
});

test("archive-only packages require matching manifest and record feature gates", () => {
  {
    const files = withValidPackageRecord(helloPackageFiles());
    const manifest = JSON.parse(text(files["neutron.json"]!));
    delete manifest.package_features;
    files["neutron.json"] = bytes(JSON.stringify(manifest));
    const record = JSON.parse(text(files[NEUTRON_PACKAGE_RECORD_PATH]!));
    record.package.manifest = {
      path: "neutron.json",
      sha256: hashContent(files["neutron.json"]!),
      bytes: files["neutron.json"]!.byteLength,
    };
    record.build.inputs = [];
    files[NEUTRON_PACKAGE_RECORD_PATH] = bytes(JSON.stringify(record));
    expect(() => preparePackageInstall(files)).toThrow(
      `package_features and package-record features to include ${NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE}`,
    );
  }

  {
    const files = withValidPackageRecord(helloPackageFiles());
    const record = JSON.parse(text(files[NEUTRON_PACKAGE_RECORD_PATH]!));
    delete record.features;
    files[NEUTRON_PACKAGE_RECORD_PATH] = bytes(JSON.stringify(record));
    expect(() => preparePackageInstall(files)).toThrow(
      `features must include ${NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE}`,
    );
  }

  {
    const files = helloPackageFiles();
    const manifest = JSON.parse(text(files["neutron.json"]!));
    manifest.package_features = [NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE];
    files["neutron.json"] = bytes(JSON.stringify(manifest));
    expect(() => preparePackageInstall(files)).toThrow(
      `Package feature ${NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE} requires archive-only package material`,
    );
  }
});

test("package preparation semantically verifies embedded source and build inputs", () => {
  const malformed = withValidPackageRecord(helloPackageFiles());
  replacePackageRecordSource(malformed, bytes("not MessagePack"), []);
  expect(() => preparePackageInstall(malformed)).toThrow(
    /Complete App Source snapshot/u,
  );

  const wrongIdentity = withValidPackageRecord(helloPackageFiles());
  replacePackageRecordSource(
    wrongIdentity,
    msgpack.encode({
      format: 1,
      package: { id: "other", version: 100 },
      files: [{ path: "main.mo", mode: 0o644, content: bytes("module {}") }],
    }),
    [],
  );
  expect(() => preparePackageInstall(wrongIdentity)).toThrow(
    /does not match hello v100/u,
  );

  const wrongBuildInput = withValidPackageRecord(helloPackageFiles());
  const manifestBytes = wrongBuildInput["neutron.json"]!;
  replacePackageRecordSource(
    wrongBuildInput,
    wrongBuildInput[NEUTRON_APP_SOURCE_SNAPSHOT_PATH]!,
    [{
      path: "neutron.json",
      sha256: "0".repeat(64),
      bytes: manifestBytes.byteLength,
    }],
  );
  expect(() => preparePackageInstall(wrongBuildInput)).toThrow(
    /build input neutron\.json SHA-256 does not match/u,
  );
});

test("fails closed when an optional package record is present but malformed", () => {
  const files = helloPackageFiles();
  files[NEUTRON_PACKAGE_RECORD_PATH] = bytes(
    JSON.stringify({ format: 1, package: { id: "hello", version: 100 } }),
  );
  expect(() => preparePackageInstall(files)).toThrow(
    `Invalid ${NEUTRON_PACKAGE_RECORD_PATH}:`,
  );
});

test("prepares a headless package without synthesizing a tile", () => {
  const files = helloPackageFiles();
  delete files["web/index.html"];
  delete files["web/main.js"];

  const prepared = preparePackageInstall(files);

  expect(appRegistryEntry(prepared.manifest).tiles).toEqual([]);
  expect(prepared.files.map(({ path }) => path)).not.toContain(
    "app/hello/index.html",
  );
});

test("package preparation requires every declared tile entrypoint and icon", () => {
  const files = helloPackageFiles();
  const manifest = JSON.parse(text(files["neutron.json"]!));
  files["neutron.json"] = bytes(
    JSON.stringify({
      ...manifest,
      tiles: [
        {
          id: "main",
          title: "Hello",
          path: "index.html",
          icon: "static/icon.png",
        },
      ],
    }),
  );

  expect(() => preparePackageInstall(files)).toThrow(
    "Package is missing tile icon web/static/icon.png",
  );
  files["web/static/icon.png"] = bytes("png");
  expect(() => preparePackageInstall(files)).not.toThrow();
  delete files["web/index.html"];
  expect(() => preparePackageInstall(files)).toThrow(
    "Package is missing tile entrypoint web/index.html",
  );
});

test("package preparation rejects removed target metadata", () => {
  expect(() =>
    preparePackageInstall({
      ...helloPackageFiles(),
      ".neutron-build.json": bytes(
        JSON.stringify({ format: 1, build_target: "production" }),
      ),
    }),
  ).toThrow("deployment-target-neutral package");
});

test("bounded package decoding preflights raw bytes, entries, and paths", () => {
  const archive = packageBytes(helloPackageFiles());
  expect(() =>
    unpackNeutronPackage(archive, {
      limits: { maxRawBytes: archive.byteLength - 1 },
    }),
  ).toThrow(/raw limit/);
  expect(() =>
    unpackNeutronPackage(archive, { limits: { maxEntries: 3 } }),
  ).toThrow(/has 5 entries/);

  const longPath = `${"a".repeat(20)}.txt`;
  expect(() =>
    unpackNeutronPackage(packageBytes({ [longPath]: bytes("ok") }), {
      limits: { maxPathBytes: 8 },
    }),
  ).toThrow(/path exceeds/);
  expect(() =>
    unpackNeutronPackage(packageBytes({ "web/bad\u0000.txt": bytes("ok") })),
  ).toThrow(/Unsafe package path/);
});

test("bounded package decoding rejects duplicate and dangerous map keys", () => {
  const compressed = gzipSync(bytes("ok"));
  expect(() =>
    unpackNeutronPackage(duplicateEntryPackage("web/a.txt", compressed)),
  ).toThrow("Duplicate package path web/a.txt");

  const dangerous = Object.create(null) as Record<string, Uint8Array>;
  dangerous.__proto__ = compressed;
  expect(() =>
    unpackNeutronPackage(encodedCompressedEntries(dangerous)),
  ).toThrow("Dangerous package map key __proto__");
});

test("bounded package decoding rejects gzip bombs and aggregate overflow", () => {
  const large = bytes("x".repeat(1024));
  expect(() =>
    unpackNeutronPackage(packageBytes({ "web/large.txt": large }), {
      limits: { maxDecodedEntryBytes: 100 },
    }),
  ).toThrow(/Decoded package entry web\/large\.txt exceeds/);

  expect(() =>
    unpackNeutronPackage(
      packageBytes({
        "web/a.txt": bytes("a".repeat(80)),
        "web/b.txt": bytes("b".repeat(80)),
      }),
      { limits: { maxDecodedEntryBytes: 100, maxDecodedTotalBytes: 100 } },
    ),
  ).toThrow(/remaining limit|aggregate limit/);
});

test("bounded package decoding rejects extra gzip members and bad footers", () => {
  const first = gzipSync(bytes("first"));
  const second = gzipSync(bytes("second"));
  expect(() =>
    unpackNeutronPackage(
      encodedCompressedEntries({
        "web/multi.txt": concatChunks([first, second]),
      }),
    ),
  ).toThrow(/multiple gzip members|Invalid gzip/);

  const badChecksum = Uint8Array.from(first);
  badChecksum[badChecksum.length - 8] =
    badChecksum[badChecksum.length - 8]! ^ 1;
  expect(() =>
    unpackNeutronPackage(
      encodedCompressedEntries({ "web/checksum.txt": badChecksum }),
    ),
  ).toThrow(/checksum/);

  const badSize = Uint8Array.from(first);
  badSize[badSize.length - 4] = 1;
  badSize[badSize.length - 3] = 0;
  badSize[badSize.length - 2] = 0;
  badSize[badSize.length - 1] = 0;
  expect(() =>
    unpackNeutronPackage(encodedCompressedEntries({ "web/size.txt": badSize })),
  ).toThrow(/declared size|gzip size|Invalid gzip/);
});

test("bounded package decoding rejects non-current keys and byte arrays", () => {
  const compressed = gzipSync(bytes("removed"));
  expect(() =>
    unpackNeutronPackage(
      encodedCompressedEntries({
        "web/removed.txt": Array.from(compressed),
      }),
    ),
  ).toThrow(/Invalid package file bytes/);
  expect(() =>
    unpackNeutronPackage(
      concatChunks([
        Uint8Array.of(0x81, 0x01),
        msgpack.encode(compressed),
      ]),
    ),
  ).toThrow(/path key/);
  expect(REMOTE_NEUTRON_PACKAGE_DECODE_LIMITS.maxDecodedEntryBytes).toBe(
    16 * 1024 * 1024,
  );
});

test("bounded package decoding accepts every active canonical package fixture", async () => {
  const appRoot = fileURLToPath(new URL("../../../apps/", import.meta.url));
  const archivePaths = (
    await readdir(appRoot, { recursive: true, withFileTypes: true })
  )
    .filter((entry) => entry.isFile())
    .map((entry) => relative(appRoot, join(entry.parentPath, entry.name)))
    .filter((path) => {
      const canonicalPath = path.replaceAll("\\", "/");
      // Mail e2e evidence is an immutable historical capture, not an active
      // package fixture to migrate in place.
      return (
        canonicalPath.endsWith(".neutron") &&
        !canonicalPath.startsWith("mail/e2e/evidence/")
      );
    });
  expect(
    archivePaths.every(
      (path) => !path.replaceAll("\\", "/").includes("/e2e/evidence/"),
    ),
  ).toBe(true);
  const archives = archivePaths.map((path) => join(appRoot, path));
  expect(archives.length).toBeGreaterThan(0);
  for (const archive of archives.sort(compareCanonicalText)) {
    const packageBytes = new Uint8Array(await readFile(archive));
    const prepared = preparePackageInstall(packageBytes);
    if (prepared.manifest.id === "kernel" && prepared.manifest.version === 307) {
      expect(prepared.packageRecord?.package).toMatchObject({
        id: "kernel",
        version: 307,
      });
      expect(prepared.packageRecord?.license.id).toBe("GPL-3.0-only");
      expect(prepared.packageRecord?.source).toEqual({
        kind: "status",
        status: "not-provided",
      });
      expect(prepared.packageRecord?.build).toEqual({
        inputs: [],
        commands: [],
      });
    } else {
      const appDirectory = relative(appRoot, archive).split(/[\\/]/u)[0]!;
      const sourceManifestPath = prepared.manifest.id === "vetkeys_fixture_peer"
        ? join(appRoot, appDirectory, "peer", "neutron.json")
        : join(appRoot, appDirectory, "neutron.json");
      const activeManifest = JSON.parse(
        await readFile(sourceManifestPath, "utf8"),
      ) as { id: string; version: number; update_source?: string };
      const workspacePackage = JSON.parse(
        await readFile(join(appRoot, appDirectory, "package.json"), "utf8"),
      ) as { license?: string };
      if (prepared.manifest.version !== activeManifest.version) {
        if (prepared.packageRecord !== undefined) {
          expect(prepared.packageRecord.package).toMatchObject({
            id: prepared.manifest.id,
            version: prepared.manifest.version,
          });
        }
      } else {
        const record = prepared.packageRecord;
        expect(record).toBeDefined();
        if (record === undefined) throw new Error("expected current package record");
        expect(record.package).toMatchObject({
          id: activeManifest.id,
          version: activeManifest.version,
        });
        const declaredLicense = workspacePackage.license;
        expect(typeof declaredLicense).toBe("string");
        if (typeof declaredLicense !== "string") {
          throw new Error("workspace package license is missing");
        }
        expect(record.license.id).toBe(
          activeManifest.id === "kernel"
            ? "LicenseRef-Neutron-Public-License-1.0"
            : declaredLicense,
        );
        expect(record.notices.map(({ path }) => path)).toContain(
          "legal/APPLICATION-NOTICE.txt",
        );
        const stagedPaths = new Set(prepared.files.map(({ path }) => path));
        if (activeManifest.update_source !== undefined) {
          expect(prepared.manifest.package_features).toBeUndefined();
          expect(record.features).toBeUndefined();
          expect(record.license.texts.every(({ path }) =>
            !path.startsWith(NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX)
          )).toBe(true);
          expect(record.source).toMatchObject({ kind: "https" });
          if (record.source.kind !== "https") {
            throw new Error("expected current HTTPS source offer");
          }
          expect(record.source.url).toStartWith(
            `https://${activeManifest.update_source}.icp0.io/repo/v1/sources/`,
          );
          expect(record.source.url).toEndWith(".source.v1.msgpack.gz");
          expect(record.notices.map(({ path }) => path)).toContain(
            "legal/THIRD_PARTY_NOTICES.md",
          );
          expect(neutronPackageRecordArchiveOnlyPaths(record)).toEqual([]);
          for (const embedded of [
            ...record.license.texts,
            ...record.notices,
          ]) {
            expect(stagedPaths.has(`${prepared.appPrefix}pkg/${embedded.path}`))
              .toBe(true);
          }
        } else {
          expect(record.license.texts.every(({ path }) =>
            path.startsWith(NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX)
          )).toBe(true);
          expect(record.source).toMatchObject({
            kind: "embedded",
            path: NEUTRON_APP_SOURCE_SNAPSHOT_PATH,
          });
          expect(record.notices.map(({ path }) => path)).toContain(
            `${NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX}THIRD_PARTY_NOTICES.md`,
          );
          for (
            const archiveOnlyPath of neutronPackageRecordArchiveOnlyPaths(
              record,
            )
          ) {
            expect(
              stagedPaths.has(`${prepared.appPrefix}pkg/${archiveOnlyPath}`),
            ).toBe(false);
          }
        }
        expect(stagedPaths.has(
          `${prepared.appPrefix}pkg/legal/APPLICATION-NOTICE.txt`,
        )).toBe(true);
      }
    }
    expect(prepared.archiveBytes).toBe(packageBytes);
    expect(prepared.archiveIdentity).toEqual({
      sha256: hashContent(packageBytes),
      size: packageBytes.byteLength,
    });
  }
}, 120_000);

test("remote preparation reconciles outer bytes and authoritative manifest identity", () => {
  const archive = packageBytes(helloPackageFiles());
  const expectedIdentity = {
    id: "hello",
    version: 100,
    size: archive.byteLength,
    sha256: hashContent(archive),
  };
  const prepared = preparePackageInstall(archive, {
    limits: REMOTE_NEUTRON_PACKAGE_DECODE_LIMITS,
    expectedIdentity,
  });
  expect(prepared.manifest.id).toBe("hello");
  expect(prepared.archiveIdentity).toEqual({
    sha256: expectedIdentity.sha256,
    size: expectedIdentity.size,
  });
  expect(prepared.archiveBytes).toBe(archive);

  expect(() =>
    preparePackageInstall(archive, {
      expectedIdentity: { ...expectedIdentity, id: "other" },
    }),
  ).toThrow("Package id hello does not match expected other");
  expect(() =>
    preparePackageInstall(archive, {
      expectedIdentity: { ...expectedIdentity, version: 101 },
    }),
  ).toThrow("Package hello v0.1.0 does not match expected v0.1.1");
  expect(() =>
    preparePackageInstall(archive, {
      expectedIdentity: { ...expectedIdentity, size: archive.byteLength + 1 },
    }),
  ).toThrow(/Package size/);
  expect(() =>
    preparePackageInstall(archive, {
      expectedIdentity: { ...expectedIdentity, sha256: "0".repeat(64) },
    }),
  ).toThrow(/Package SHA-256/);
});

test("rechecks retained archive bytes before compile and install boundaries", () => {
  const archive = packageBytes(helloPackageFiles());
  const prepared = preparePackageInstall(archive);
  expect(() => assertPreparedPackageArchiveIdentity(prepared)).not.toThrow();

  archive[archive.byteLength - 1] = archive[archive.byteLength - 1]! ^ 1;
  expect(() => assertPreparedPackageArchiveIdentity(prepared)).toThrow(
    /does not match reviewed/,
  );

  const contentPrepared = preparePackageInstall(
    packageBytes(helloPackageFiles()),
  );
  const mutableFile = contentPrepared.files.find(
    ({ path }) => path === "app/hello/main.js",
  );
  if (!mutableFile) throw new Error("Expected prepared frontend file");
  mutableFile.content[0] = mutableFile.content[0]! ^ 1;
  expect(() =>
    buildPackagesCompileInput({
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      packages: [contentPrepared],
    }),
  ).toThrow(/contents changed after archive review/);
});

test("package preparation rejects unsafe paths and invalid Motoko hashes", () => {
  const files = helloPackageFiles();
  expect(() =>
    preparePackageFiles(
      {
        ...files,
        "../escape.txt": bytes("bad"),
      },
      { moPrefix: "mo/", appPrefix: "app/hello/" },
    ),
  ).toThrow(/Unsafe package path/);

  const moduleContent = bytes("module {}");
  expect(() =>
    preparePackageFiles(
      {
        "mo/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mo":
          moduleContent,
      },
      { moPrefix: "mo/", appPrefix: "app/hello/" },
    ),
  ).toThrow(/Invalid mo hash/);

  const prepared = preparePackageInstall(helloPackageFiles());
  const module = prepared.files.find(({ path }) => path.startsWith("mo/"));
  if (!module) throw new Error("Expected prepared Motoko module");
  module.content[0] = module.content[0]! ^ 1;
  expect(() =>
    buildPackagesCompileInput({
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      packages: [prepared],
    }),
  ).toThrow(/Prepared Motoko module .* content SHA-256/);
});

test("ordinary app packages reserve Kernel-owned web namespaces", () => {
  for (const path of [
    "web/_route",
    "web/_route/status.json",
    "web/pkg",
    "web/pkg/index.html",
  ]) {
    expect(() =>
      preparePackageFiles(
        { [path]: bytes("reserved") },
        { moPrefix: "mo/", appPrefix: "app/hello/" },
      ),
    ).toThrow(`${path} is reserved for Kernel-owned app metadata`);

    expect(() =>
      preparePackageInstall({
        ...helloPackageFiles(),
        [path]: bytes("reserved"),
      }),
    ).toThrow(`${path} is reserved for Kernel-owned app metadata`);
  }

  const kernelFiles = kernelPackageFiles();
  kernelFiles["web/_route/status.json"] = bytes("kernel-owned");
  const kernel = preparePackageInstall(kernelFiles);
  expect(kernel.files.some(({ path }) => path === "_route/status.json")).toBe(
    true,
  );

  const prepared = preparePackageInstall(helloPackageFiles());
  const forged = {
    ...prepared,
    files: [
      ...prepared.files,
      { path: "app/hello/_route/status.json", content: bytes("reserved") },
    ],
  };
  expect(() =>
    buildPackageCompileInput({
      existingModules: [],
      existingConfigs: {},
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      preparedPackage: forged,
    }),
  ).toThrow(
    "Prepared package path app/hello/_route/status.json is reserved for shared app routes",
  );

  for (const path of [
    "app/victim_app/_route",
    "app/victim_app/_route/status.json",
    "app/kernel/_route/status.json",
  ]) {
    const crossAppForged = {
      ...prepared,
      files: [...prepared.files, { path, content: bytes("reserved") }],
    };
    expect(() =>
      buildPackageCompileInput({
        existingModules: [],
        existingConfigs: {},
        existingApps: {},
        existingBrowserSurfaceOriginAppIds: [],
        preparedPackage: crossAppForged,
      }),
    ).toThrow(
      `Prepared package path ${path} is reserved for shared app routes`,
    );
  }

  const forgedKernel = {
    ...kernel,
    files: [
      ...kernel.files,
      {
        path: "app/victim_app/_route/status.json",
        content: bytes("kernel-owned"),
      },
    ],
  };
  expect(() =>
    buildPackageCompileInput({
      existingModules: [],
      existingConfigs: {},
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      preparedPackage: forgedKernel,
    }),
  ).toThrow(
    "Prepared Kernel package path app/victim_app/_route/status.json cannot write an app asset subtree",
  );

  const kernelWithAppAsset = kernelPackageFiles();
  kernelWithAppAsset["web/app/victim/index.html"] = bytes("forbidden");
  expect(() => preparePackageInstall(kernelWithAppAsset)).toThrow(
    "Kernel package path web/app/victim/index.html cannot write an app asset subtree",
  );

  for (const path of [
    "web/system/apps.json",
    "web/system/browser-surface-origins.json",
  ]) {
    expect(() =>
      preparePackageInstall({
        ...kernelPackageFiles(),
        [path]: bytes("forbidden"),
      }),
    ).toThrow(`Reserved package asset target /${path.slice("web/".length)}`);
  }
});

test("prepared package batches bind identity, capability plan, and app assets", () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  expect(() => assertPreparedPackageBatch([prepared])).not.toThrow();

  expect(() =>
    assertPreparedPackageBatch([
      {
        ...prepared,
        files: [
          ...prepared.files,
          { path: "app/victim/main.js", content: bytes("cross-app") },
        ],
      },
    ]),
  ).toThrow(
    "Prepared package hello path app/victim/main.js is outside app/hello/",
  );

  expect(() =>
    assertPreparedPackageBatch([
      { ...prepared, appPrefix: "app/victim/" },
    ]),
  ).toThrow("Prepared package hello has invalid app prefix app/victim/");

  expect(() =>
    assertPreparedPackageBatch([{ ...prepared, isKernel: true }]),
  ).toThrow("Prepared package hello has inconsistent Kernel identity");

  expect(() =>
    assertPreparedPackageBatch([
      { ...prepared, capabilityPlanFingerprint: "0".repeat(64) },
    ]),
  ).toThrow("Prepared package hello capability plan does not match its manifest");
});

test("package preparation and registry normalization reject unsafe app ids", () => {
  for (const id of ["constructor", "prototype"]) {
    const files = helloPackageFiles();
    const manifest = JSON.parse(text(files["neutron.json"]!));
    files["neutron.json"] = bytes(JSON.stringify({ ...manifest, id }));

    expect(() => preparePackageInstall(files)).toThrow(
      `Reserved app name ${id}`,
    );
    expect(() =>
      normalizeAppRegistry(
        JSON.parse(`{"${id}":{"name":"Reserved","tiles":[]}}`),
      ),
    ).toThrow(`Reserved app name ${id}`);
  }

  for (const id of ["__proto__", "_hello", "hello_", "hello__app"]) {
    const files = helloPackageFiles();
    const manifest = JSON.parse(text(files["neutron.json"]!));
    files["neutron.json"] = bytes(JSON.stringify({ ...manifest, id }));

    expect(() => preparePackageInstall(files)).toThrow("Invalid neutron.json");
    expect(() =>
      normalizeAppRegistry(
        JSON.parse(`{"${id}":{"name":"Invalid","tiles":[]}}`),
      ),
    ).toThrow("Invalid app name");
  }
});

test("package preparation requires every declared background entrypoint", () => {
  const files = helloPackageFiles();
  const manifest = JSON.parse(text(files["neutron.json"]!));
  files["neutron.json"] = bytes(
    JSON.stringify({
      ...manifest,
      background: { path: "service.html" },
    }),
  );

  expect(() => preparePackageInstall(files)).toThrow(
    "Package is missing background entrypoint web/service.html",
  );
  files["web/service.html"] = bytes("<script src='./service.js'></script>");
  expect(preparePackageInstall(files).manifest.background).toEqual({
    path: "service.html",
  });
});

test("package preparation requires declared tray entrypoint and icon", () => {
  const files = helloPackageFiles();
  const manifest = JSON.parse(text(files["neutron.json"]!));
  files["neutron.json"] = bytes(
    JSON.stringify({
      ...manifest,
      background: { path: "service.html" },
      tray: {
        title: "Inbox",
        path: "tray/index.html",
        icon: "static/tray.png",
      },
    }),
  );
  files["web/service.html"] = bytes("<script></script>");

  expect(() => preparePackageInstall(files)).toThrow(
    "Package is missing tray entrypoint web/tray/index.html",
  );
  files["web/tray/index.html"] = bytes("<main>Inbox</main>");
  expect(() => preparePackageInstall(files)).toThrow(
    "Package is missing tray icon web/static/tray.png",
  );
  files["web/static/tray.png"] = bytes("png");

  const prepared = preparePackageInstall(files);
  expect(prepared.manifest.tray).toEqual({
    title: "Inbox",
    path: "tray/index.html",
    icon: "static/tray.png",
  });
  expect(prepared.files.map(({ path }) => path)).toContain(
    "app/hello/static/tray.png",
  );
});

test("builds compile input by merging installed state and pending package", () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const existingKernel = {
    format: 3 as const,
    id: "kernel",
    name: "Kernel",
    version: 100,
    entry: "main",
  };
  const input = buildPackageCompileInput({
    existingModules: [{ path: "main.mo", content: "module {}" }],
    existingConfigs: { kernel: existingKernel },
    existingApps: { kernel: appRegistryEntry(existingKernel) },
    existingBrowserSurfaceOriginAppIds: [],
    preparedPackage: prepared,
  });

  expect(input.configs.hello?.entry).toBe(prepared.manifest.entry);
  expect(input.configs.kernel?.entry).toBe("main");
  expect(input.mofiles.map((file) => file.path)).toEqual([
    "main.mo",
    `${prepared.manifest.entry}.mo`,
  ]);
});

test("Kernel packages carry the exact generated connection-provider support metadata", () => {
  const files = kernelPackageFiles();
  delete files[KERNEL_CONNECTION_PROVIDER_SUPPORT_ARCHIVE_PATH];
  expect(() => preparePackageInstall(files)).toThrow(
    `Kernel package is missing ${KERNEL_CONNECTION_PROVIDER_SUPPORT_ARCHIVE_PATH}`,
  );

  const prepared = preparePackageInstall(kernelPackageFiles());
  expect(prepared.connectionProviderSupport).toEqual(
    connectionProviderSupportFixture,
  );
});

test("compile input rejects providers and scopes absent from the selected Kernel catalog", () => {
  const kernel = preparePackageInstall(kernelPackageFiles());
  const supported = preparePackageInstall(
    connectionPackageFiles("openrouter"),
  );
  expect(() =>
    buildPackagesCompileInput({
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      packages: [kernel, supported],
    }),
  ).not.toThrow();

  const unsupportedProvider = preparePackageInstall(
    connectionPackageFiles("unsupported_provider"),
  );
  expect(() =>
    buildPackagesCompileInput({
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      packages: [kernel, unsupportedProvider],
    }),
  ).toThrow(
    "Unsupported connection provider 'unsupported_provider' for App connector_app",
  );

  const unsupportedScope = preparePackageInstall(
    connectionPackageFiles("openrouter", ["unsupported_scope"]),
  );
  expect(() =>
    buildPackagesCompileInput({
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      packages: [kernel, unsupportedScope],
    }),
  ).toThrow(
    "Provider 'openrouter' does not support scope 'unsupported_scope' for App connector_app",
  );

  const reducedKernelFiles = kernelPackageFiles();
  reducedKernelFiles[KERNEL_CONNECTION_PROVIDER_SUPPORT_ARCHIVE_PATH] = bytes(
    JSON.stringify({
      schema: "neutron.connection-provider-support.v1",
      providers: [],
    }),
  );
  const reducedKernel = preparePackageInstall(reducedKernelFiles);
  expect(() =>
    buildPackagesCompileInput({
      packages: [reducedKernel],
      existingConfigs: {
        connector_app: supported.manifest,
      },
      existingApps: {
        connector_app: appRegistryEntry(supported.manifest),
      },
      existingBrowserSurfaceOriginAppIds: [],
    }),
  ).toThrow(
    "Unsupported connection provider 'openrouter' for App connector_app",
  );
});

test("builds compile input from multiple prepared packages", () => {
  const kernelFiles = kernelPackageFiles();
  const kernelEntry = JSON.parse(text(kernelFiles["neutron.json"]!)).entry;
  const kernel = preparePackageInstall(kernelFiles);
  const hello = preparePackageInstall(helloPackageFiles());
  const input = buildPackagesCompileInput({
    existingApps: {},
    existingBrowserSurfaceOriginAppIds: [],
    packages: [kernel, hello],
  });

  expect(kernel.isKernel).toBe(true);
  expect(kernel.appPrefix).toBe("");
  expect(kernel.files.map((file) => file.path).sort()).toEqual([
    "index.html",
    "main.js",
    "mo/" + kernelEntry + ".mo",
    "pkg/connection-providers.json",
    "pkg/neutron.json",
  ]);
  expect(Object.keys(input.configs).sort()).toEqual(["hello", "kernel"]);
  // Both packages contain the exact same content-addressed module. It is
  // compiled and uploaded once.
  expect(input.mofiles.length).toBe(1);

  const freshInstallationContext = trustedInstallationContextFromRootKey(
    new Uint8Array(133).fill(0x4c),
  );
  const localInput = buildPackagesCompileInput({
    existingApps: {},
    existingBrowserSurfaceOriginAppIds: [],
    packages: [kernel, hello],
    deploymentNonce: "01".repeat(16),
    vetKeysEnvironment: "local",
    freshInstallationContext,
  });
  expect(localInput.vetKeysEnvironment).toBe("local");
  expect(localInput.deploymentNonce).toBe("01".repeat(16));
  expect(localInput.freshInstallationContext).toBe(freshInstallationContext);
});

test("final compiler environment binds one certified Kernel runtime config", () => {
  const kernelFiles = kernelPackageFiles();
  const kernel = preparePackageInstall(packageBytes(kernelFiles));
  const runtimePath = KERNEL_RUNTIME_CONFIG_PATH.slice(1);

  const canisterId = "rrkah-fqaaa-aaaaa-aaaaq-cai";
  const deploymentId = "01".repeat(16);
  applyRuntimeDeploymentConfig(
    [kernel],
    createKernelRuntimeConfig({
      target: "pocketic",
      gateway: POCKETIC_RUNTIME_GATEWAY,
      identity_provider: scopedLocalIdentityProvider({
        neutronCanisterId: canisterId,
        localHost: POCKETIC_RUNTIME_GATEWAY,
      }),
      canister_id: canisterId,
      deployment_id: deploymentId,
      root_key_policy: "fetch",
      allow_loopback_http: true,
      isolated_frame_origin_template: isolatedFrameOriginTemplate(
        "pocketic",
        canisterId,
      ),
      update_source_origin: runtimeUpdateSourceOrigin(
        "pocketic",
        "r7inp-6aaaa-aaaaa-aaabq-cai",
      ),
    }),
  );
  let runtimeFiles = kernel.files.filter(({ path }) => path === runtimePath);
  expect(runtimeFiles).toHaveLength(1);
  expect(parseKernelRuntimeConfig(runtimeFiles[0]!.content).target).toBe(
    "pocketic",
  );

  applyRuntimeDeploymentConfig(
    [kernel],
    createKernelRuntimeConfig({
      target: "ic",
      gateway: IC_RUNTIME_GATEWAY,
      identity_provider: IC_RUNTIME_IDENTITY_PROVIDER,
      canister_id: canisterId,
      deployment_id: deploymentId,
      root_key_policy: "mainnet",
      allow_loopback_http: false,
      isolated_frame_origin_template: isolatedFrameOriginTemplate(
        "ic",
        canisterId,
      ),
      update_source_origin: null,
    }),
  );
  runtimeFiles = kernel.files.filter(({ path }) => path === runtimePath);
  expect(runtimeFiles).toHaveLength(1);
  expect(parseKernelRuntimeConfig(runtimeFiles[0]!.content).target).toBe("ic");
});

test("Kernel packages cannot supply the deployment-specific build record", () => {
  const files = kernelPackageFilesAtVersion(307);
  files[`web${DEPLOYMENT_BUILD_RECORD_PATH}`] = bytes("untrusted record");
  expect(() => preparePackageInstall(files)).toThrow(
    /deployment-build-record\.json.*reserved for the deployment transaction/,
  );
});

test("deployment attempts use a full 16-byte nonce", () => {
  const values = Uint8Array.from({ length: 16 }, (_, index) => index);
  const nonce = createDeploymentNonce({
    getRandomValues<T extends ArrayBufferView>(target: T): T {
      new Uint8Array(target.buffer, target.byteOffset, target.byteLength).set(
        values,
      );
      return target;
    },
  });
  expect(nonce).toBe("000102030405060708090a0b0c0d0e0f");
});

test("multi-package entry points reject duplicate app ids", () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const duplicate = {
    ...prepared,
    files: prepared.files.map((file) => ({ ...file })),
  };

  expect(() =>
    buildPackagesCompileInput({
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      packages: [prepared, duplicate],
    }),
  ).toThrow("Duplicate prepared app id hello");
  expect(() =>
    buildPackagesInstallAssets({
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      packages: [prepared, duplicate],
      candid: "service : {}",
    }),
  ).toThrow("Duplicate prepared app id hello");
});

test("package batches reject duplicate mutable targets before construction", () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  prepared.files.push({
    path: "app/hello/main.js",
    content: bytes("different"),
  });

  expect(() =>
    buildPackagesCompileInput({
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      packages: [prepared],
    }),
  ).toThrow(
    "Duplicate mutable install target /app/hello/main.js",
  );
});

test("package batches bound browser-surface certification fanout", async () => {
  const surfacePackage = (browserAssetCount: number) => {
    const files = helloPackageFiles();
    const manifest = JSON.parse(text(files["neutron.json"]!));
    files["neutron.json"] = bytes(
      JSON.stringify({
        ...manifest,
        tiles: Array.from({ length: MANIFEST_MAX_TILES }, (_, index) => ({
          id: `tile_${index}`,
          title: `Tile ${index}`,
          path: "index.html",
          icon: "index.html",
        })),
      }),
    );
    for (let index = 2; index < browserAssetCount; index += 1) {
      files[`web/asset-${index}.js`] = bytes(`export default ${index}`);
    }
    return preparePackageInstall(files);
  };

  expect(KERNEL_BROWSER_SURFACE_CERTIFICATION_UNITS_MAX).toBe(1_024);
  const withinV26Limit = surfacePackage(32);
  const validOnlyOnV25 = surfacePackage(33);
  // Archive preparation is generation-independent. The released v25 actor
  // creates no installation-surface response variants, so its valid package
  // shape must not be rejected by a v26-only certification ceiling.
  expect(() => assertPreparedPackageBatch([validOnlyOnV25])).not.toThrow();
  expect(() =>
    assertPreparedPackageBrowserSurfaceFanout(
      [validOnlyOnV25],
      LEGACY_V25_ASSEMBLER_ID,
      [],
    ),
  ).not.toThrow();
  expect(() =>
    assertPreparedPackageBrowserSurfaceFanout(
      [withinV26Limit],
      ASSEMBLER_ID,
      ["hello"],
    ),
  ).not.toThrow();
  expect(() =>
    assertPreparedPackageBrowserSurfaceFanout(
      [validOnlyOnV25],
      ASSEMBLER_ID,
      ["hello"],
    ),
  ).toThrow(
    "Selected packages require 1056 browser-surface certification units; kernel limit is 1024",
  );
  await expect(
    compilePackages({
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      packages: [validOnlyOnV25],
    }),
  ).rejects.toThrow(
    "Selected packages require 1056 browser-surface certification units; kernel limit is 1024",
  );
});

test("compile inputs deduplicate identical modules and reject conflicts", () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const module = prepared.files.find((file) => file.path.startsWith("mo/"))!;
  const modulePath = module.path.slice("mo/".length);

  const deduplicated = buildPackageCompileInput({
    existingModules: [
      { path: modulePath, content: text(module.content) },
      { path: modulePath, content: text(module.content) },
    ],
    existingConfigs: {},
    existingApps: {},
    existingBrowserSurfaceOriginAppIds: [],
    preparedPackage: prepared,
  });
  expect(deduplicated.mofiles).toHaveLength(1);

  expect(() =>
    buildPackageCompileInput({
      existingModules: [
        { path: modulePath, content: "module { let changed = 1 }" },
      ],
      existingConfigs: {},
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      preparedPackage: prepared,
    }),
  ).toThrow(`Motoko module ${modulePath} content SHA-256`);
});

test("package batches reject same module path with different bytes", () => {
  const hello = preparePackageInstall(helloPackageFiles());
  const otherFiles = helloPackageFiles();
  const otherManifest = JSON.parse(text(otherFiles["neutron.json"]!));
  otherFiles["neutron.json"] = bytes(
    JSON.stringify({ ...otherManifest, id: "other", name: "Other" }),
  );
  const other = preparePackageInstall(otherFiles);
  const otherModule = other.files.find((file) => file.path.startsWith("mo/"));
  if (!otherModule) throw new Error("Expected prepared Motoko module");
  otherModule.content = bytes("different module");

  expect(() =>
    buildPackagesCompileInput({
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      packages: [hello, other],
    }),
  ).toThrow(/Prepared Motoko module .* content SHA-256/);
});

test("compile inputs require a strict upgrade unless local reinstall opts in", () => {
  const files = helloPackageFiles();
  const manifest = JSON.parse(text(files["neutron.json"]!));
  files["neutron.json"] = bytes(JSON.stringify({ ...manifest, version: 102 }));
  const prepared = preparePackageInstall(files);
  const existingConfigs = {
    hello: {
      ...prepared.manifest,
      version: 103,
    },
  };
  const existingApps = {
    hello: appRegistryEntry(existingConfigs.hello),
  };

  expect(() =>
    buildPackageCompileInput({
      existingModules: [],
      existingConfigs,
      existingApps,
      existingBrowserSurfaceOriginAppIds: [],
      preparedPackage: prepared,
    }),
  ).toThrow("Refusing to downgrade hello from v0.1.3 to v0.1.2");
  expect(() =>
    buildPackagesCompileInput({
      packages: [prepared],
      existingConfigs,
      existingApps,
      existingBrowserSurfaceOriginAppIds: [],
    }),
  ).toThrow("Refusing to downgrade hello from v0.1.3 to v0.1.2");

  const sameVersionConfigs = { hello: { ...prepared.manifest } };
  const sameVersionApps = {
    hello: appRegistryEntry(sameVersionConfigs.hello),
  };
  expect(() =>
    buildPackageCompileInput({
      existingModules: [],
      existingConfigs: sameVersionConfigs,
      existingApps: sameVersionApps,
      existingBrowserSurfaceOriginAppIds: [],
      preparedPackage: prepared,
    }),
  ).toThrow(
    "hello v0.1.2 is already installed; choose a package with a higher version",
  );
  expect(() =>
    buildPackagesCompileInput({
      packages: [prepared],
      existingConfigs: sameVersionConfigs,
      existingApps: sameVersionApps,
      existingBrowserSurfaceOriginAppIds: [],
    }),
  ).toThrow(
    "hello v0.1.2 is already installed; choose a package with a higher version",
  );

  expect(() =>
    buildPackageCompileInput({
      existingModules: [],
      existingConfigs: sameVersionConfigs,
      existingApps: sameVersionApps,
      existingBrowserSurfaceOriginAppIds: [],
      preparedPackage: prepared,
      versionPolicy: "allow-same-version",
    }),
  ).not.toThrow();
  expect(() =>
    buildPackagesCompileInput({
      packages: [prepared],
      existingConfigs: sameVersionConfigs,
      existingApps: sameVersionApps,
      existingBrowserSurfaceOriginAppIds: [],
      versionPolicy: "allow-same-version",
    }),
  ).not.toThrow();

  expect(() =>
    buildPackageCompileInput({
      existingModules: [],
      existingConfigs,
      existingApps,
      existingBrowserSurfaceOriginAppIds: [],
      preparedPackage: prepared,
      versionPolicy: "allow-same-version",
    }),
  ).toThrow("Refusing to downgrade hello from v0.1.3 to v0.1.2");
});

test("shared kernel package state reader uses injected IO callbacks", async () => {
  const kernelModule = "module {}";
  const kernelModulePath = `${hashContent(kernelModule)}.mo`;
  const kernelManifest = {
    format: 3 as const,
    id: "kernel",
    name: "Kernel",
    version: 100,
    entry: "kernel",
  };
  const helloManifest = {
    format: 3 as const,
    id: "hello",
    name: "Hello",
    version: 100,
    entry: "hello",
  };
  const installedKernel = appRegistryEntry(kernelManifest);
  const installedHello = appRegistryEntry(helloManifest);
  const state = await readKernelPackageState({
    listStatic: async (prefix) => {
      expect(prefix).toBe("/mo/");
      return [`/mo/${kernelModulePath}`];
    },
    fetchText: async (path) => {
      if (path === `/mo/${kernelModulePath}`) return kernelModule;
      if (path === "/pkg/neutron.most") return "type Stable = {}";
      throw new Error(`Unexpected text asset ${path}`);
    },
    fetchJson: async (path, fallback) => {
      if (path === "/system/apps.json") {
        return {
          hello: installedHello,
          kernel: installedKernel,
        } as typeof fallback;
      }
      if (path === "/pkg/neutron.json") {
        return kernelManifest as typeof fallback;
      }
      if (path === KERNEL_CONNECTION_PROVIDER_SUPPORT_PATH) {
        return connectionProviderSupportFixture as typeof fallback;
      }
      if (path === "/app/hello/pkg/neutron.json") {
        return helloManifest as typeof fallback;
      }
      return fallback;
    },
  });

  expect(state.existingModules).toEqual([
    { path: kernelModulePath, content: kernelModule },
  ]);
  expect(Object.keys(state.existingConfigs).sort()).toEqual([
    "hello",
    "kernel",
  ]);
  expect(state.registry.hello?.version).toBe(100);
  expect(state.registry.hello).not.toHaveProperty("browser_surface_origins");
  expect(state.registry.kernel?.version).toBe(100);
  expect(state.apps.hello?.version).toBe(100);
  expect(state.apps).toBe(state.registry);
  expect(state.apps.hello?.tiles).toEqual([]);
});

test("kernel package state rejects corrupt content-addressed installed modules", async () => {
  const kernelManifest = {
    format: 3 as const,
    id: "kernel",
    name: "Kernel",
    version: 100,
    entry: "kernel",
  };
  const expectedPath = `/mo/${hashContent("module {}")}.mo`;
  await expect(
    readKernelPackageState({
      listStatic: async () => [expectedPath],
      fetchText: async (path) => {
        if (path === expectedPath) return "module { public func changed() {} }";
        if (path === "/pkg/neutron.most") return "type Stable = {}";
        throw new Error(`Unexpected text asset ${path}`);
      },
      fetchJson: async (path, fallback) => {
        if (path === "/system/apps.json") {
          return { kernel: appRegistryEntry(kernelManifest) } as typeof fallback;
        }
        if (path === "/pkg/neutron.json") {
          return kernelManifest as typeof fallback;
        }
        if (path === KERNEL_CONNECTION_PROVIDER_SUPPORT_PATH) {
          return connectionProviderSupportFixture as typeof fallback;
        }
        return fallback;
      },
    }),
  ).rejects.toThrow(/Motoko module .* content SHA-256/);
});

function strictStateReaderFixture({
  registry,
  manifests,
  browserSurfaceOriginAppIds,
  previousStable = "type Stable = {}",
}: {
  registry: AppRegistry;
  manifests: Record<string, unknown>;
  browserSurfaceOriginAppIds?: readonly string[];
  previousStable?: string | Error;
}) {
  return {
    browserSurfaceOriginAppIds,
    listStatic: async () => [],
    fetchText: async (path: string) => {
      if (path !== "/pkg/neutron.most") {
        throw new Error(`Unexpected text asset ${path}`);
      }
      if (previousStable instanceof Error) throw previousStable;
      return previousStable;
    },
    fetchJson: async <T>(path: string, fallback: T): Promise<T> => {
      if (path === "/system/apps.json") return registry as T;
      if (
        path === BROWSER_SURFACE_ORIGINS_PATH &&
        browserSurfaceOriginAppIds !== undefined
      ) {
        return browserSurfaceOriginsSidecar(
          browserSurfaceOriginAppIds,
          Object.keys(registry),
        ) as T;
      }
      if (path === KERNEL_CONNECTION_PROVIDER_SUPPORT_PATH) {
        return connectionProviderSupportFixture as T;
      }
      return (manifests[path] ?? fallback) as T;
    },
  };
}

test("kernel package state distinguishes legacy absence from a v26 sidecar", async () => {
  const kernel = {
    format: 3 as const,
    id: "kernel",
    name: "Kernel",
    version: 100,
    entry: "kernel",
  };
  const hello = {
    format: 3 as const,
    id: "hello",
    name: "Hello",
    version: 100,
    entry: "hello",
  };

  for (const {
    sidecar,
    expectedIds,
    expectedPresent,
  } of [
    { sidecar: undefined, expectedIds: [], expectedPresent: false },
    { sidecar: [], expectedIds: [], expectedPresent: true },
    { sidecar: ["hello"], expectedIds: ["hello"], expectedPresent: true },
  ] as const) {
    const state = await readKernelPackageState(
      strictStateReaderFixture({
        registry: {
          kernel: appRegistryEntry(kernel),
          hello: appRegistryEntry(hello),
        },
        ...(sidecar === undefined
          ? {}
          : { browserSurfaceOriginAppIds: sidecar }),
        manifests: {
          "/pkg/neutron.json": kernel,
          "/app/hello/pkg/neutron.json": hello,
        },
      }),
    );
    expect(state.browserSurfaceOriginAppIds).toEqual([...expectedIds]);
    expect(state.browserSurfaceOriginsSidecarPresent).toBe(expectedPresent);
  }
});

test("kernel package state rejects registry and package manifest mismatch", async () => {
  const kernel = {
    format: 3 as const,
    id: "kernel",
    name: "Kernel",
    version: 100,
    entry: "kernel",
  };
  const hello = {
    format: 3 as const,
    id: "hello",
    name: "Hello",
    version: 100,
    entry: "hello",
  };
  const registry = {
    kernel: appRegistryEntry(kernel),
    hello: appRegistryEntry(hello),
  };
  await expect(
    readKernelPackageState(
      strictStateReaderFixture({
        registry,
        manifests: {
          "/pkg/neutron.json": kernel,
          "/app/hello/pkg/neutron.json": { ...hello, name: "Changed" },
        },
      }),
    ),
  ).rejects.toThrow(/does not exactly match its registry entry/);
});

test("kernel package state rejects a missing installed package manifest", async () => {
  const kernel = {
    format: 3 as const,
    id: "kernel",
    name: "Kernel",
    version: 100,
    entry: "kernel",
  };
  const hello = {
    format: 3 as const,
    id: "hello",
    name: "Hello",
    version: 100,
    entry: "hello",
  };
  await expect(
    readKernelPackageState(
      strictStateReaderFixture({
        registry: {
          kernel: appRegistryEntry(kernel),
          hello: appRegistryEntry(hello),
        },
        manifests: { "/pkg/neutron.json": kernel },
      }),
    ),
  ).rejects.toThrow(
    "Installed package manifest /app/hello/pkg/neutron.json is missing",
  );
});

test("kernel package state rejects old-format installed manifests", async () => {
  const kernel = {
    format: 3 as const,
    id: "kernel",
    name: "Kernel",
    version: 100,
    entry: "kernel",
  };
  await expect(
    readKernelPackageState(
      strictStateReaderFixture({
        registry: { kernel: appRegistryEntry(kernel) },
        manifests: {
          "/pkg/neutron.json": { ...kernel, format: 2 },
        },
      }),
    ),
  ).rejects.toThrow("Invalid installed package manifest /pkg/neutron.json");
});

test("kernel package state requires the registry and config inventories to agree", async () => {
  await expect(
    readKernelPackageState(
      strictStateReaderFixture({ registry: {}, manifests: {} }),
    ),
  ).rejects.toThrow(/registry is missing the kernel package manifest entry/);
});

test("kernel package state rejects a missing prior stable signature", async () => {
  const kernel = {
    format: 3 as const,
    id: "kernel",
    name: "Kernel",
    version: 100,
    entry: "kernel",
  };
  await expect(
    readKernelPackageState(
      strictStateReaderFixture({
        registry: { kernel: appRegistryEntry(kernel) },
        manifests: { "/pkg/neutron.json": kernel },
        previousStable: new Error("not found"),
      }),
    ),
  ).rejects.toThrow("not found");
});

test("builds registry and candid assets for deployment", () => {
  const prepared = preparePackageInstall(
    withBrowserSurfaceOriginsMarker(helloPackageFiles()),
  );
  const assets = buildPackageInstallAssets({
    existingApps: {},
    existingBrowserSurfaceOriginAppIds: [],
    preparedPackage: prepared,
    candid: "service : {}",
  });

  expect(assets.apps.hello).toEqual({
    link: "/hello",
    name: "Hello",
    version: 100,
    format: 3 as const,
    icon: "/app/hello/static/icon.png",
    capability_plan: prepared.capabilityPlan,
    capability_plan_fingerprint: prepared.capabilityPlanFingerprint,
    functions: [
      {
        name: "hello_world",
        candid_name: "app_hello__hello_world",
        type: "update",
        access: "authorized",
        async: "sync",
        args: [],
      },
    ],
    tiles: [],
  });
  expect(assets.appRegistryAsset.key).toBe("/system/apps.json");
  expect(text(assets.appRegistryAsset.val.content)).toContain('"hello"');
  expect(assets.browserSurfaceOriginAppIds).toEqual(["hello"]);
  expect(text(assets.browserSurfaceOriginsAsset.val.content)).toBe(
    JSON.stringify({ format: 1, app_ids: ["hello"] }),
  );
  expect(assets.candidAsset.key).toBe("/pkg/neutron.did");
  expect(text(assets.candidAsset.val.content)).toBe("service : {}");
});

test("rolls browser surface origins forward only for ready package writes", () => {
  const preparedHeadless = (
    id: string,
    version = 100,
    ready = false,
  ) => {
    const files = headlessPackageFiles(id);
    const manifest = JSON.parse(text(files["neutron.json"]!));
    files["neutron.json"] = bytes(JSON.stringify({ ...manifest, version }));
    return preparePackageInstall(
      ready ? withBrowserSurfaceOriginsMarker(files) : files,
    );
  };
  const retainedLegacyPackage = preparedHeadless("retained_legacy");
  const retainedMarkedPackage = preparedHeadless("retained_marked");
  const updatedLegacyPackage = preparedHeadless("updated_legacy");
  const kernelManifest = {
    format: 3,
    id: "kernel",
    name: "Kernel",
    version: 100,
    entry: "kernel",
  } as const;
  const kernel = appRegistryEntry(kernelManifest);
  const retainedLegacy = appRegistryEntry(retainedLegacyPackage.manifest);
  const retainedMarked = appRegistryEntry(retainedMarkedPackage.manifest);
  const updatedLegacy = appRegistryEntry(updatedLegacyPackage.manifest);
  const update = preparedHeadless("updated_legacy", 101);
  const fresh = preparedHeadless("fresh_app", 100, true);
  const existingApps = {
    kernel,
    retained_legacy: retainedLegacy,
    retained_marked: retainedMarked,
    updated_legacy: updatedLegacy,
  };
  const existingConfigs = {
    kernel: kernelManifest,
    retained_legacy: retainedLegacyPackage.manifest,
    retained_marked: retainedMarkedPackage.manifest,
    updated_legacy: updatedLegacyPackage.manifest,
  };
  const firstCompile = buildPackagesCompileInput({
    packages: [fresh, update],
    existingApps,
    existingBrowserSurfaceOriginAppIds: ["retained_marked"],
    existingConfigs,
  });
  expect(firstCompile.browserSurfaceOriginAppIds).toEqual([
    "fresh_app",
    "retained_marked",
  ]);

  const firstInstall = buildPackagesInstallAssets({
    existingApps,
    existingBrowserSurfaceOriginAppIds: ["retained_marked"],
    packages: [fresh, update],
    candid: "service : {}",
  });
  const first = firstInstall.apps;

  expect(firstInstall.browserSurfaceOriginAppIds).toEqual([
    "fresh_app",
    "retained_marked",
  ]);

  const kernelOnly = buildPackagesInstallAssets({
    existingApps: first,
    existingBrowserSurfaceOriginAppIds:
      firstInstall.browserSurfaceOriginAppIds,
    packages: [preparePackageInstall(kernelPackageFilesAtVersion(101))],
    candid: "service : {}",
  });
  expect(kernelOnly.browserSurfaceOriginAppIds).toEqual([
    "fresh_app",
    "retained_marked",
  ]);

  const later = preparedHeadless("later_app", 100, true);
  const firstConfigs = {
    ...existingConfigs,
    updated_legacy: update.manifest,
    fresh_app: fresh.manifest,
  };
  const secondCompile = buildPackagesCompileInput({
    packages: [later],
    existingApps: first,
    existingBrowserSurfaceOriginAppIds:
      firstInstall.browserSurfaceOriginAppIds,
    existingConfigs: firstConfigs,
  });
  expect(secondCompile.browserSurfaceOriginAppIds).toEqual([
    "fresh_app",
    "later_app",
    "retained_marked",
  ]);
  const secondInstall = buildPackagesInstallAssets({
    existingApps: first,
    existingBrowserSurfaceOriginAppIds:
      firstInstall.browserSurfaceOriginAppIds,
    packages: [later],
    candid: "service : {}",
  });
  const second = secondInstall.apps;

  expect(secondInstall.browserSurfaceOriginAppIds).toEqual([
    "fresh_app",
    "later_app",
    "retained_marked",
  ]);

  const uninstall = buildAppUninstallCompileInput({
    state: {
      registry: second,
      apps: second,
      browserSurfaceOriginAppIds:
        secondInstall.browserSurfaceOriginAppIds,
      browserSurfaceOriginsSidecarPresent: true,
      existingConfigs: { ...firstConfigs, later_app: later.manifest },
      existingModules: [],
      previousStable: "type Legacy = ();",
      connectionProviderSupport: connectionProviderSupportFixture,
    },
    appId: "fresh_app",
  });
  expect(uninstall.browserSurfaceOriginAppIds).toEqual([
    "later_app",
    "retained_marked",
  ]);
});

test("strictly normalizes the browser surface origins sidecar", () => {
  const prepared = preparePackageInstall(headlessPackageFiles("marked_app"));
  const entry = buildPackageInstallAssets({
    existingApps: {},
    existingBrowserSurfaceOriginAppIds: [],
    preparedPackage: prepared,
    candid: "service : {}",
  }).apps.marked_app!;
  expect(normalizeAppRegistry({ marked_app: entry }).marked_app).toEqual(entry);

  expect(parseBrowserSurfaceOriginsSidecar(undefined, ["marked_app"])).toEqual(
    [],
  );
  expect(
    parseBrowserSurfaceOriginsSidecar(
      { format: 1, app_ids: ["marked_app"] },
      ["marked_app"],
    ),
  ).toEqual(["marked_app"]);
  for (const invalid of [
    null,
    {},
    { format: 2, app_ids: [] },
    { format: 1, app_ids: ["marked_app", "marked_app"] },
    { format: 1, app_ids: ["missing"] },
    { format: 1, app_ids: [], extra: true },
    { format: 1, app_ids: Array.from({ length: 257 }, () => "marked_app") },
  ]) {
    expect(() =>
      parseBrowserSurfaceOriginsSidecar(invalid, ["marked_app"]),
    ).toThrow(/browser-surface origin/i);
  }
  const kernel = appRegistryEntry({
    format: 3,
    id: "kernel",
    name: "Kernel",
    version: 100,
  });
  expect(() =>
    normalizeAppRegistry({
      kernel: { ...kernel, unexpected_surface_authority: 1 } as never,
    }),
  ).toThrow(/Unknown registry field unexpected_surface_authority/);
});

test("package update source persists through installation and registry normalization", () => {
  const updateSource = "rrkah-fqaaa-aaaaa-aaaaq-cai";
  const files = helloPackageFiles();
  const manifest = JSON.parse(text(files["neutron.json"]!));
  files["neutron.json"] = bytes(
    JSON.stringify({ ...manifest, update_source: updateSource }),
  );

  const prepared = preparePackageInstall(files);
  expect(prepared.manifest.update_source).toBe(updateSource);
  const entry = appRegistryEntry(prepared.manifest);
  expect(entry.update_source).toBe(updateSource);
  expect(normalizeAppRegistry({ hello: entry }).hello).toEqual(entry);

  const manualManifest = { ...prepared.manifest };
  delete manualManifest.update_source;
  const absent = appRegistryEntry(manualManifest);
  expect(absent).not.toHaveProperty("update_source");
  expect(() =>
    normalizeAppRegistry({ hello: { ...entry, update_source: "aaaaa-aa" } }),
  ).toThrow(/registry update_source/);
  expect(() =>
    normalizeAppRegistry({ hello: { ...entry, updateSource } }),
  ).toThrow(/Unknown registry field updateSource/);
});

test("multi-package registry construction rejects ambiguous removals", () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const build = (removedApps: string[]) =>
    buildPackagesInstallAssets({
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      packages: [prepared],
      candid: "service : {}",
      removedApps,
    });

  expect(() => build(["hello"])).toThrow(
    /cannot be installed and removed together/,
  );
  expect(() => build(["gone", "gone"])).toThrow(/Duplicate removed app gone/);
  expect(() => build(["kernel"])).toThrow(/kernel app cannot be removed/);
  expect(() => build(["bad\/id"])).toThrow(/Invalid app (id|name)/);
  expect(() =>
    build(
      Array.from(
        { length: KERNEL_INSTALL_MAX_APP_REMOVALS_PER_COMMIT + 1 },
        (_, index) => `gone_${index}`,
      ),
    ),
  ).toThrow(/kernel limit is 64 per deployment.*successive deployments/i);
});

test("roughly 200 arbitrary headless apps install and remove in bounded batches", () => {
  const ordinaryIds = Array.from({ length: 200 }, (_, index) =>
    `headless_${index}`,
  );
  const packages = ordinaryIds.map((id) =>
    preparePackageInstall(headlessPackageFiles(id)),
  );
  const kernelManifest: AssemblyManifest = {
    format: 3,
    id: "kernel",
    name: "Kernel",
    version: 100,
    entry: "kernel",
  };
  const kernel = appRegistryEntry(kernelManifest);
  let apps: AppRegistry = { kernel };
  let installedPackages: PreparedPackageInstall[] = [];
  for (
    let offset = 0;
    offset < packages.length;
    offset += KERNEL_INSTALL_MAX_CLEAR_PREFIXES_PER_COMMIT
  ) {
    const batch = packages.slice(
      offset,
      offset + KERNEL_INSTALL_MAX_CLEAR_PREFIXES_PER_COMMIT,
    );
    apps = buildPackagesInstallAssets({
      existingApps: apps,
      existingBrowserSurfaceOriginAppIds: [],
      packages: batch,
      candid: "service : {}",
    }).apps;
    installedPackages = [...installedPackages, ...batch];
    const installedSource = assemble({
      kernel: kernelManifest,
      ...Object.fromEntries(
        installedPackages.map((prepared) => [
          prepared.manifest.id,
          prepared.manifest,
        ]),
      ),
    });
    expect(installedSource).toContain(
      `app_instances = ${installedPackages.length + 1};`,
    );
  }

  expect(Object.keys(apps)).toHaveLength(201);
  expect(
    ordinaryIds.every((id) => apps[id]?.tiles.length === 0),
  ).toBe(true);

  for (
    let offset = 0;
    offset < ordinaryIds.length;
    offset += KERNEL_INSTALL_MAX_APP_REMOVALS_PER_COMMIT
  ) {
    apps = buildPackagesInstallAssets({
      existingApps: apps,
      existingBrowserSurfaceOriginAppIds: [],
      packages: [],
      candid: "service : {}",
      removedApps: ordinaryIds.slice(
        offset,
        offset + KERNEL_INSTALL_MAX_APP_REMOVALS_PER_COMMIT,
      ),
    }).apps;
    const removed = new Set(
      ordinaryIds.slice(
        offset,
        offset + KERNEL_INSTALL_MAX_APP_REMOVALS_PER_COMMIT,
      ),
    );
    installedPackages = installedPackages.filter(
      (prepared) => !removed.has(prepared.manifest.id),
    );
    const removedSource = assemble({
      kernel: kernelManifest,
      ...Object.fromEntries(
        installedPackages.map((prepared) => [
          prepared.manifest.id,
          prepared.manifest,
        ]),
      ),
    });
    expect(removedSource).toContain(
      `app_instances = ${installedPackages.length + 1};`,
    );
  }
  expect(Object.keys(apps)).toEqual(["kernel"]);
});

test("registry generation includes explicit app tiles and hides kernel tiles", () => {
  expect(
    appRegistryEntry({
      format: 3 as const,
      id: "kernel",
      name: "Kernel",
      version: 100,
      tiles: [{ id: "main", title: "Kernel", path: "index.html" }],
    }),
  ).toEqual({
    link: "/",
    name: "Kernel",
    version: 100,
    format: 3 as const,
    icon: "/static/icon.png",
    tiles: [],
    capability_plan: expect.any(Object),
    capability_plan_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    functions: [],
  });

  expect(
    appRegistryEntry({
      format: 3 as const,
      id: "hello",
      name: "Hello",
      version: 100,
      tiles: [
        {
          id: "chat",
          title: "Chat",
          path: "chat/index.html",
          icon: "static/chat.png",
        },
      ],
    }),
  ).toEqual({
    link: "/hello",
    name: "Hello",
    version: 100,
    format: 3 as const,
    icon: "/app/hello/static/chat.png",
    capability_plan: expect.any(Object),
    capability_plan_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    functions: [],
    tiles: [
      {
        id: "chat",
        title: "Chat",
        path: "chat/index.html",
        icon: "/app/hello/static/chat.png",
      },
    ],
  });
});

test("registry preserves discovery and resident background metadata", () => {
  expect(
    appRegistryEntry({
      format: 3 as const,
      id: "gemma",
      name: "Gemma",
      version: 101,
      description: "Resident local agent",
      func: {
        status: { type: "query", async: "async*" },
        helper: { type: "internal", arg: ["canister_principal"] },
      },
      background: {
        path: "service.html",
        description: "Model owner",
      },
      capabilities: {
        connections: {
          api: 1,
          providers: [
            {
              provider: "openrouter",
              scopes: [],
            },
          ],
        },
        persistent_browser_storage: { api: 1, surface: "background" },
      },
      tiles: [
        {
          id: "chat",
          title: "Gemma",
          path: "index.html",
          description: "Chat client",
        },
      ],
    }),
  ).toMatchObject({
    version: 101,
    format: 3 as const,
    description: "Resident local agent",
    background: {
      path: "service.html",
      description: "Model owner",
    },
    functions: [
      {
        name: "helper",
        type: "internal",
        access: "internal",
        async: "sync",
        args: ["canister_principal"],
      },
      {
        name: "status",
        type: "query",
        access: "authorized",
        async: "async*",
        args: [],
      },
    ],
    tiles: [{ id: "chat", description: "Chat client" }],
  });

  const entry = appRegistryEntry({
    format: 3 as const,
    id: "gemma",
    name: "Gemma",
    version: 101,
    background: { path: "service.html" },
  });
  expect(normalizeAppRegistry({ gemma: entry }).gemma).toEqual(entry);
  expect(() =>
    normalizeAppRegistry({
      gemma: { ...entry, background: { path: "../service.html" } },
    }),
  ).toThrow(/Unsafe registry background path/);
});

test("registry preserves one app-scoped tray without adding capabilities", () => {
  const entry = appRegistryEntry({
    format: 3 as const,
    id: "mail_app",
    name: "Mail App",
    version: 102,
    background: { path: "service.html" },
    tray: {
      title: "Inbox",
      path: "tray/index.html",
      icon: "static/tray.png",
    },
  });

  expect(entry.tray).toEqual({
    title: "Inbox",
    path: "tray/index.html",
    icon: "/app/mail_app/static/tray.png",
  });
  expect(entry.capability_plan.entries.map(({ id }) => id)).toEqual([
    "background_endpoint",
    "tray_endpoint",
  ]);

  expect(normalizeAppRegistry({ mail_app: entry }).mail_app?.tray).toEqual(
    entry.tray,
  );
  expect(() =>
    appRegistryEntry({
      format: 3 as const,
      id: "mail_app",
      name: "Mail App",
      version: 102,
      tray: {
        title: "Inbox",
        path: "tray/index.html",
        icon: "static/tray.png",
      },
    }),
  ).toThrow("Tray requires a background process");
  expect(() =>
    normalizeAppRegistry({
      mail_app: {
        ...entry,
        tray: {
          title: "Inbox",
          path: "tray/index.html",
          icon: "/app/other_app/static/tray.png",
        },
      },
    }),
  ).toThrow(/Unsafe registry tray icon/);
});

test("registry preserves normalized vetKeys declarations for trusted disclosure", () => {
  const entry = appRegistryEntry({
    format: 3 as const,
    id: "private_mail",
    name: "Private Mail",
    version: 100,
    capabilities: {
      vetkeys: {
        api: 1,
        description: "Recover private Mail keys",
        slots: [
          {
            id: "mailbox",
            purpose: "Encrypt and decrypt private Mail",
          },
        ],
      },
    },
  });
  expect(
    entry.capability_plan.entries.find(({ id }) => id === "vetkeys")?.config,
  ).toEqual({
    api: 1,
    description: "Recover private Mail keys",
    slots: [
      {
        id: "mailbox",
        purpose: "Encrypt and decrypt private Mail",
      },
    ],
  });

  expect(() =>
    normalizeAppRegistry({
      private_mail: { ...entry, capabilities: {} },
    }),
  ).toThrow(/Unknown registry field capabilities/);
});

test("registry generation rejects ambiguous or internal public access metadata", () => {
  expect(() =>
    appRegistryEntry({
      format: 3 as const,
      id: "legacy_app",
      name: "Legacy App",
      version: 100,
      func: { status: { type: "query", allow: "any" } },
    } as any),
  ).toThrow(/unsupported allow value any/);

  expect(() =>
    appRegistryEntry({
      format: 3 as const,
      id: "private_app",
      name: "Private App",
      version: 100,
      func: {
        helper: { type: "internal", allow: "unauthorized" },
      },
    }),
  ).toThrow(/internal and cannot declare public access/);
});

test("new packages and strict registries reject spoofing text", () => {
  const unsafePackage = helloPackageFiles();
  const unsafeManifest = JSON.parse(text(unsafePackage["neutron.json"]!));
  unsafePackage["neutron.json"] = bytes(
    JSON.stringify({
      ...unsafeManifest,
      description: "Kernel\u202everified",
    }),
  );
  expect(() => preparePackageInstall(unsafePackage)).toThrow(
    /Invalid neutron\.json/,
  );

  expect(() =>
    appRegistryEntry({
      format: 3 as const,
      id: "hello",
      name: "Hello",
      version: 100,
      tiles: [{ id: "main", title: "Safe\u200btitle" }],
    }),
  ).toThrow(/tile title/);
  expect(() =>
    appRegistryEntry({
      format: 3 as const,
      id: "hello",
      name: "Hello",
      version: 100,
      capabilities: {
        backend_calls: {
          api: 1,
          description: "No\u2066access required",
          reservation_scopes: ["exact"],
          max_concurrency: 2,
          max_cycles_per_call: 0,
          max_cycles_per_day: 0,
        },
      },
    }),
  ).toThrow(/backend_calls description/);

  const valid = appRegistryEntry({
    format: 3 as const,
    id: "hello",
    name: "Hello",
    version: 100,
  });
  expect(() =>
    normalizeAppRegistry({ hello: { ...valid, name: "Leg\u202eacy" } }),
  ).toThrow(/registry name/);
});

test("registry preserves normalized backend dependencies and app exports", () => {
  const entry = appRegistryEntry({
    format: 3 as const,
    id: "calendar",
    name: "Calendar",
    version: 101,
    dependencies: {
      people: {
        app: "contacts",
        min_version: 102,
        functions: ["upsert_contact", "list_contacts"],
      },
    },
    func: {
      provide_calendar: {
        type: "internal",
        expose: "apps",
        async: "async*",
      },
    },
  });
  expect(entry.dependencies).toEqual({
    people: {
      app: "contacts",
      min_version: 102,
      functions: ["list_contacts", "upsert_contact"],
    },
  });
  expect(entry.functions).toEqual([
    {
      name: "provide_calendar",
      type: "internal",
      access: "internal",
      async: "async*",
      args: [],
      expose: "apps",
    },
  ]);
  expect(normalizeAppRegistry({ calendar: entry }).calendar).toMatchObject({
    dependencies: entry.dependencies,
    functions: [{ expose: "apps" }],
  });
});

test("uninstall preflight blocks providers and permits consumers", () => {
  const kernel = {
    format: 3 as const,
    id: "kernel",
    name: "Kernel",
    version: 100,
    entry: "kernel",
  } as const;
  const contacts = {
    format: 3 as const,
    id: "contacts",
    name: "Contacts",
    version: 102,
    entry: "contacts",
    func: {
      list_contacts: { type: "internal" as const, expose: "apps" as const },
    },
  };
  const calendar = {
    format: 3 as const,
    id: "calendar",
    name: "Calendar",
    version: 100,
    entry: "calendar",
    dependencies: {
      people: {
        app: "contacts",
        min_version: 102,
        functions: ["list_contacts"],
      },
    },
  };
  const state = {
    registry: {},
    apps: {},
    browserSurfaceOriginAppIds: [],
    browserSurfaceOriginsSidecarPresent: true,
    existingModules: [],
    existingConfigs: { kernel, contacts, calendar },
    previousStable: null,
    connectionProviderSupport: connectionProviderSupportFixture,
  };

  expect(() =>
    buildAppUninstallCompileInput({ state, appId: "contacts" }),
  ).toThrow(
    "Contacts cannot be uninstalled; required by Calendar (list_contacts)",
  );
  expect(
    buildAppUninstallCompileInput({ state, appId: "calendar" }).configs,
  ).toEqual({ kernel, contacts });
  expect(
    buildAppsUninstallCompileInput({
      state,
      appIds: ["contacts", "calendar"],
    }).configs,
  ).toEqual({ kernel });
});

test("batch uninstall selection is non-empty, unique, bounded, and non-system", () => {
  const kernel = {
    format: 3 as const,
    id: "kernel",
    name: "Kernel",
    version: 100,
    entry: "kernel",
  };
  const mail = {
    format: 3 as const,
    id: "mail",
    name: "Mail",
    version: 100,
    entry: "mail",
  };
  const state = {
    registry: {},
    apps: {},
    browserSurfaceOriginAppIds: [],
    browserSurfaceOriginsSidecarPresent: true,
    existingModules: [],
    existingConfigs: { kernel, mail },
    previousStable: null,
    connectionProviderSupport: connectionProviderSupportFixture,
  };

  expect(() =>
    buildAppsUninstallCompileInput({ state, appIds: [] }),
  ).toThrow("Select at least one app");
  expect(() =>
    buildAppsUninstallCompileInput({ state, appIds: ["mail", "mail"] }),
  ).toThrow("Duplicate removed app mail");
  expect(() =>
    buildAppsUninstallCompileInput({ state, appIds: ["kernel"] }),
  ).toThrow("kernel app cannot be removed");
  expect(() =>
    buildAppsUninstallCompileInput({ state, appIds: ["missing"] }),
  ).toThrow("App missing is not installed");
  expect(() =>
    buildAppsUninstallCompileInput({
      state,
      appIds: Array.from(
        { length: KERNEL_INSTALL_MAX_APP_REMOVALS_PER_COMMIT + 1 },
        (_, index) => `app${index}`,
      ),
    }),
  ).toThrow(`kernel limit is ${KERNEL_INSTALL_MAX_APP_REMOVALS_PER_COMMIT}`);
});

test("registry dependency graph reports direct and transitive impact", () => {
  const baseEntry = (
    id: string,
    name: string,
    dependencies?: Record<
      string,
      { app: string; min_version: number; functions: string[] }
    >,
  ) =>
    appRegistryEntry({
      format: 3 as const,
      id,
      name,
      version: 100,
      func: {
        read: { type: "internal", async: "async*", expose: "apps" },
      },
      ...(dependencies ? { dependencies } : {}),
    });
  const registry = normalizeAppRegistry({
    files: baseEntry("files", "Files"),
    search: baseEntry("search", "Search", {
      files: { app: "files", min_version: 100, functions: ["read"] },
    }),
    editor: baseEntry("editor", "Editor", {
      search: { app: "search", min_version: 100, functions: ["read"] },
    }),
  });
  const plan = planAppRegistryDependencies(registry);

  expect(appDependencyImpact(plan, "files")).toEqual({
    direct: [
      {
        consumer: "search",
        alias: "files",
        minVersion: 100,
        functions: ["read"],
      },
    ],
    transitiveConsumers: ["editor"],
  });
});

test("uninstall preflight reports nested dependency impact", () => {
  const exported = {
    read: { type: "internal" as const, expose: "apps" as const },
  };
  const kernel = {
    format: 3 as const,
    id: "kernel",
    name: "Kernel",
    version: 100,
    entry: "kernel",
  };
  const files = {
    format: 3 as const,
    id: "files",
    name: "Files",
    version: 100,
    entry: "files",
    func: exported,
  };
  const search = {
    format: 3 as const,
    id: "search",
    name: "Search",
    version: 100,
    entry: "search",
    func: exported,
    dependencies: {
      files: { app: "files", min_version: 100, functions: ["read"] },
    },
  };
  const editor = {
    format: 3 as const,
    id: "editor",
    name: "Editor",
    version: 100,
    entry: "editor",
    dependencies: {
      search: { app: "search", min_version: 100, functions: ["read"] },
    },
  };

  expect(() =>
    buildAppUninstallCompileInput({
      state: {
        registry: {},
        apps: {},
        browserSurfaceOriginAppIds: [],
        browserSurfaceOriginsSidecarPresent: true,
        existingModules: [],
        existingConfigs: { kernel, files, search, editor },
        previousStable: null,
        connectionProviderSupport: connectionProviderSupportFixture,
      },
      appId: "files",
    }),
  ).toThrow("transitively used by Editor");
});

test("registry preserves only authorized preapproved self calls", () => {
  const entry = appRegistryEntry({
    format: 3 as const,
    id: "demo",
    name: "Demo",
    version: 100,
    func: {
      read: { type: "query" },
      refresh: { type: "update" },
    },
    capabilities: {
      preapproved_self_calls: {
        api: 1,
        methods: ["read", "refresh"],
      },
    },
  });
  expect(
    entry.capability_plan.entries.find(
      ({ id }) => id === "preapproved_self_calls",
    )?.config,
  ).toEqual({
    api: 1,
    methods: [
      { method: "read", mode: "query" },
      { method: "refresh", mode: "update" },
    ],
  });

  const updateEntry = appRegistryEntry({
    format: 3 as const,
    id: "demo",
    name: "Demo",
    version: 100,
    func: { read: { type: "update" } },
    capabilities: {
      preapproved_self_calls: { api: 1, methods: ["read"] },
    },
  });
  expect(updateEntry.capability_plan_fingerprint).not.toBe(
    appRegistryEntry({
      format: 3 as const,
      id: "demo",
      name: "Demo",
      version: 100,
      func: { read: { type: "query" } },
      capabilities: {
        preapproved_self_calls: { api: 1, methods: ["read"] },
      },
    }).capability_plan_fingerprint,
  );

  const tamperedPlan = structuredClone(entry.capability_plan);
  const tamperedPreapproved = tamperedPlan.entries.find(
    (candidate) => candidate.id === "preapproved_self_calls",
  );
  if (
    !tamperedPreapproved ||
    tamperedPreapproved.id !== "preapproved_self_calls"
  ) {
    throw new Error("Missing preapproved plan entry");
  }
  tamperedPreapproved.config.methods = [
    { method: "read", mode: "update" },
    { method: "refresh", mode: "update" },
  ];
  expect(() =>
    normalizeAppRegistry({
      demo: {
        ...entry,
        capability_plan: tamperedPlan,
        capability_plan_fingerprint:
          fingerprintCapabilityPlanWireV1(tamperedPlan),
      },
    }),
  ).toThrow(/preapproved self-call read:update is invalid/);

  expect(() =>
    appRegistryEntry({
      format: 3 as const,
      id: "demo",
      name: "Demo",
      version: 100,
      func: { status: { type: "query", allow: "unauthorized" } },
      capabilities: {
        preapproved_self_calls: { api: 1, methods: ["status"] },
      },
    }),
  ).toThrow(
    /cannot bypass public_ingress|must name a non-internal manifest function|authorized/,
  );
  expect(() =>
    appRegistryEntry({
      format: 3 as const,
      id: "demo",
      name: "Demo",
      version: 100,
      func: { read: { type: "query" } },
      capabilities: {
        preapproved_self_calls: { api: 1, methods: ["missing"] },
      },
    }),
  ).toThrow(/must name an owner-authorized query or update/);
});

test("registry rejects a preapproved self call bound to another app's backend method", () => {
  const entry = appRegistryEntry({
    format: 3 as const,
    id: "demo",
    name: "Demo",
    version: 100,
    func: { read: { type: "query" } },
    capabilities: {
      preapproved_self_calls: { api: 1, methods: ["read"] },
    },
  });

  expect(entry.functions).toContainEqual(
    expect.objectContaining({
      name: "read",
      candid_name: physicalAppMethodName("demo", "read"),
    }),
  );

  const forged = structuredClone(entry);
  forged.functions[0]!.candid_name = physicalAppMethodName("other", "read");
  expect(() => normalizeAppRegistry({ demo: forged })).toThrow(
    /Invalid registry Candid name for demo\.read/,
  );
});

test("registry preserves exact public ingress routes and rejects handler drift", () => {
  const entry = appRegistryEntry({
    format: 3 as const,
    id: "relay",
    name: "Relay",
    version: 100,
    func: {
      ingress_status: {
        type: "query",
        async: false,
        arg: ["caller"],
      },
      ingress_deliver: {
        type: "update",
        async: false,
        arg: ["caller", "public_ingress_cycles"],
      },
    },
    capabilities: {
      public_ingress: {
        api: 1,
        routes: [
          {
            protocol: "relay_v1",
            id: "status",
            handler: "ingress_status",
            mode: "query",
            caller: "any",
            max_request_bytes: 128,
            max_response_bytes: 256,
          },
          {
            protocol: "relay_v1",
            id: "deliver",
            handler: "ingress_deliver",
            mode: "update",
            caller: "canister",
            max_request_bytes: 4096,
            max_response_bytes: 512,
            max_calls_per_hour: 120,
            required_cycles: 10_000_000,
          },
        ],
      },
    },
  });

  const ingress = entry.capability_plan.entries.find(
    (candidate) => candidate.id === "public_ingress",
  );
  expect(ingress?.config).toEqual({
    api: 1,
    routes: [
      {
        protocol: "relay_v1",
        id: "deliver",
        handler: "ingress_deliver",
        mode: "update",
        caller: "canister",
        max_request_bytes: 4096,
        max_response_bytes: 512,
        max_calls_per_hour: 120,
        required_cycles: 10_000_000,
      },
      {
        protocol: "relay_v1",
        id: "status",
        handler: "ingress_status",
        mode: "query",
        caller: "any",
        max_request_bytes: 128,
        max_response_bytes: 256,
      },
    ],
  });
  expect(entry.functions).toEqual([
    expect.objectContaining({
      name: "ingress_deliver",
      access: "authorized",
    }),
    expect.objectContaining({
      name: "ingress_status",
      candid_name: physicalAppMethodName("relay", "ingress_status"),
      access: "authorized",
    }),
  ]);
  expect(
    entry.functions.find(({ name }) => name === "ingress_deliver"),
  ).not.toHaveProperty("candid_name");
  expect(
    entry.capability_plan.entries.find(
      (candidate) => candidate.id === "function_resources",
    )?.config,
  ).toEqual({
    functions: [
      {
        method: "ingress_deliver",
        mode: "update",
        resources: [
          { kind: "caller" },
          { kind: "public_ingress_cycles" },
        ],
      },
      {
        method: "ingress_status",
        mode: "query",
        resources: [{ kind: "caller" }],
      },
    ],
  });
  expect(() => normalizeAppRegistry({ relay: entry })).not.toThrow();

  const tamperedPlan = structuredClone(entry.capability_plan);
  const tamperedIngress = tamperedPlan.entries.find(
    (candidate) => candidate.id === "public_ingress",
  );
  if (!tamperedIngress || tamperedIngress.id !== "public_ingress") {
    throw new Error("Missing public ingress plan entry");
  }
  tamperedIngress.config.routes[0]!.handler = "ingress_status";
  expect(() =>
    normalizeAppRegistry({
      relay: {
        ...entry,
        capability_plan: tamperedPlan,
        capability_plan_fingerprint:
          fingerprintCapabilityPlanWireV1(tamperedPlan),
      },
    }),
  ).toThrow(
    /Invalid public_ingress_cycles resource|public ingress route relay_v1:deliver has invalid handler/,
  );
});

test("registry reconciles exact ordered function resource bindings", () => {
  const entry = appRegistryEntry({
    format: 3,
    id: "demo",
    name: "Demo",
    version: 100,
    func: {
      bind: {
        type: "update",
        arg: ["caller", "canister_principal"],
      },
    },
  });
  const reversed = appRegistryEntry({
    format: 3,
    id: "demo",
    name: "Demo",
    version: 100,
    func: {
      bind: {
        type: "update",
        arg: ["canister_principal", "caller"],
      },
    },
  });
  expect(reversed.capability_plan_fingerprint).not.toBe(
    entry.capability_plan_fingerprint,
  );

  const tamperedPlan = structuredClone(entry.capability_plan);
  const resources = tamperedPlan.entries.find(
    (candidate) => candidate.id === "function_resources",
  );
  if (!resources || resources.id !== "function_resources") {
    throw new Error("Missing function resource plan entry");
  }
  resources.config.functions[0]!.resources.reverse();
  expect(() =>
    normalizeAppRegistry({
      demo: {
        ...entry,
        capability_plan: tamperedPlan,
        capability_plan_fingerprint:
          fingerprintCapabilityPlanWireV1(tamperedPlan),
      },
    }),
  ).toThrow(/function_resources projection mismatch/);
});

test("registry normalization validates manifest function metadata", () => {
  const entry = appRegistryEntry({
    format: 3 as const,
    id: "hello",
    name: "Hello",
    version: 100,
    func: { read: { type: "query", arg: ["caller"] } },
  });
  expect(normalizeAppRegistry({ hello: entry }).hello).toMatchObject({
    format: 3 as const,
    functions: [
      {
        name: "read",
        candid_name: "app_hello__read",
        args: ["caller"],
      },
    ],
  });

  expect(() =>
    normalizeAppRegistry({
      hello: {
        ...entry,
        functions: [
          {
            name: "read",
            type: "query",
            access: "everyone",
            async: "sync",
            args: [],
          },
        ],
      },
    }),
  ).toThrow("Invalid registry function access");

  expect(() =>
    normalizeAppRegistry({
      hello: {
        ...entry,
        functions: [
          {
            name: "read",
            type: "internal",
            access: "authorized",
            async: "sync",
            args: [],
          },
        ],
      },
    }),
  ).toThrow("Invalid registry function type/access for read");

  expect(() =>
    normalizeAppRegistry({
      hello: {
        ...entry,
        functions: [
          {
            name: "read",
            type: "query",
            access: "internal",
            async: "sync",
            args: [],
          },
        ],
      },
    }),
  ).toThrow("Invalid registry function type/access for read");

  expect(() =>
    normalizeAppRegistry({
      hello: {
        ...entry,
        functions: [
          {
            name: "read",
            type: "query",
            access: "authorized",
            async: "sync",
            args: ["caller"],
          },
        ],
      },
    }),
  ).toThrow("Invalid registry Candid name for hello.read");

  expect(() =>
    normalizeAppRegistry({
      hello: {
        ...entry,
        functions: [
          {
            ...entry.functions[0]!,
            candid_name: "app_mail__read",
          },
        ],
      },
    }),
  ).toThrow("Invalid registry Candid name for hello.read");

  expect(() =>
    normalizeAppRegistry({
      hello: {
        ...entry,
        functions: [{ ...entry.functions[0]!, ambient_authority: true }],
      },
    }),
  ).toThrow("Unknown registry function field ambient_authority");
});

test("registry rejects legacy physical Candid names without aliases", () => {
  const entry = appRegistryEntry({
    format: 3 as const,
    id: "hello",
    name: "Hello",
    version: 100,
    func: { read: { type: "query" } },
  });
  expect(entry.functions[0]?.candid_name).toBe("app_hello__read");

  expect(() =>
    normalizeAppRegistry({
      hello: {
        ...entry,
        functions: [
          {
            ...entry.functions[0]!,
            candid_name: "NeutronAppMethod_a5_hello_r4_read",
          },
        ],
      },
    }),
  ).toThrow("Invalid registry Candid name for hello.read");
});

test("registry maps logical app functions to exact physical Candid methods", () => {
  const app = appRegistryEntry({
    format: 3,
    id: "a_b_c",
    name: "Scoped",
    version: 100,
    func: {
      read_status: { type: "query" },
      helper: { type: "internal" },
    },
  });
  expect(app.functions.find(({ name }) => name === "read_status")).toMatchObject({
    name: "read_status",
    candid_name: "app_a_b_c__read_status",
  });
  expect(app.functions.find(({ name }) => name === "helper")).not.toHaveProperty(
    "candid_name",
  );

  const kernel = appRegistryEntry({
    format: 3,
    id: "kernel",
    name: "Kernel",
    version: 100,
    func: { kernel_status: { type: "query" } },
  });
  expect(kernel.functions[0]?.candid_name).toBe("kernel_status");
});

test("registry bounds logical kernel methods like ordinary app methods", () => {
  const registryEntry = (name: string) => appRegistryEntry({
    format: 3,
    id: "kernel",
    name: "Kernel",
    version: 100,
    func: { [name]: { type: "query" } },
  });
  const maximum = "m".repeat(128);
  expect(
    normalizeAppRegistry({ kernel: registryEntry(maximum) }).kernel?.functions[0]
      ?.name,
  ).toBe(maximum);
  expect(() => registryEntry(`${maximum}m`)).toThrow(
    "Invalid function name in kernel",
  );
  expect(() => registryEntry("1status")).toThrow(
    "Invalid function name in kernel",
  );
  const forged = registryEntry(maximum);
  expect(() => normalizeAppRegistry({
    kernel: {
      ...forged,
      functions: [{
        ...forged.functions[0]!,
        name: `${maximum}m`,
        candid_name: `${maximum}m`,
      }],
    },
  })).toThrow("Invalid registry function name");
  expect(() => normalizeAppRegistry({
    kernel: {
      ...forged,
      functions: [{
        ...forged.functions[0]!,
        name: "1status",
        candid_name: "1status",
      }],
    },
  })).toThrow("Invalid registry function name");
});

test("registry function metadata enforces manifest collection bounds", () => {
  const entry = appRegistryEntry({
    format: 3 as const,
    id: "hello",
    name: "Hello",
    version: 100,
  });
  const registryFunction = (name: string, args: string[] = []) => ({
    name,
    candid_name: physicalAppMethodName("hello", name),
    type: "update" as const,
    access: "authorized" as const,
    async: "sync" as const,
    args,
  });

  expect(() =>
    normalizeAppRegistry({
      hello: {
        ...entry,
        functions: Array.from({ length: MANIFEST_MAX_FUNCTIONS + 1 }, (_, index) =>
          registryFunction(`method_${index}`),
        ),
      },
    }),
  ).toThrow("Invalid registry functions");

  expect(() =>
    normalizeAppRegistry({
      hello: {
        ...entry,
        functions: [
          registryFunction(
            "read",
            Array.from(
              { length: MANIFEST_MAX_FUNCTION_ARGS + 1 },
              (_, index) => `resource_${index}`,
            ),
          ),
        ],
      },
    }),
  ).toThrow("Invalid registry function arguments for read");

  expect(() =>
    normalizeAppRegistry({
      hello: {
        ...entry,
        functions: [registryFunction("read", ["caller", "caller"])],
      },
    }),
  ).toThrow("Invalid registry function arguments for read");
});

test("registry normalization rejects oversized app and tile inventories", () => {
  const oversizedRegistry = Object.fromEntries(
    Array.from(
      { length: NEUTRON_INSTALLED_APP_LIMIT + 1 },
      (_, index) => [`app_${index}`, {}],
    ),
  );
  expect(() => normalizeAppRegistry(oversizedRegistry)).toThrow(
    "App registry exceeds the installed app limit",
  );

  const entry = appRegistryEntry({
    format: 3 as const,
    id: "hello",
    name: "Hello",
    version: 100,
  });
  expect(() =>
    normalizeAppRegistry({
      hello: {
        ...entry,
        tiles: Array.from({ length: MANIFEST_MAX_TILES + 1 }, (_, index) => ({
          id: `tile_${index}`,
          title: `Tile ${index}`,
          path: `tile_${index}.html`,
          icon: `/app/hello/static/icon.png`,
        })),
      },
    }),
  ).toThrow("Registry app hello declares too many tiles");
});

test("registry normalization rejects unsafe tile paths", () => {
  const entry = appRegistryEntry({
    format: 3 as const,
    id: "hello",
    name: "Hello",
    version: 100,
  });
  expect(() =>
    normalizeAppRegistry({
      hello: {
        ...entry,
        tiles: [
          {
            id: "main",
            title: "Hello",
            path: "../index.html",
            icon: "/app/hello/static/icon.png",
          },
        ],
      },
    }),
  ).toThrow(/Unsafe registry tile path/);
});

test("registry normalization rejects unsafe tile icons", () => {
  const entry = appRegistryEntry({
    format: 3 as const,
    id: "hello",
    name: "Hello",
    version: 100,
  });
  expect(() =>
    normalizeAppRegistry({
      hello: {
        ...entry,
        tiles: [
          {
            id: "main",
            title: "Hello",
            path: "index.html",
            icon: "/app/hello/../secret.png",
          },
        ],
      },
    }),
  ).toThrow(/Unsafe registry tile icon/);
});

test("registry normalization rejects missing fields and plan tampering", () => {
  const entry = appRegistryEntry({
    format: 3 as const,
    id: "hello",
    name: "Hello",
    version: 100,
  });
  expect(() =>
    normalizeAppRegistry({
      hello: { ...entry, format: 2 },
    }),
  ).toThrow(/Unsupported registry manifest format/);
  expect(() =>
    normalizeAppRegistry({
      hello: { ...entry, capability_plan_fingerprint: "0".repeat(64) },
    }),
  ).toThrow(/fingerprint mismatch/);
});

test("static files are gzipped, chunked, and uploaded through generic writer", async () => {
  const operation = createStaticFileOperation(
    "app/hello/main.js",
    bytes("abcdef"),
    "application/javascript",
    "gzip",
    4,
  );
  expect(operation.key).toBe("/app/hello/main.js");
  expect(operation.val.chunks).toBeGreaterThan(1);
  const compressed = concatChunks([
    operation.val.content,
    ...operation.chunks.map((x) => x.content),
  ]);
  expect(Array.from(compressed.slice(4, 8))).toEqual([0, 0, 0, 0]);
  expect(
    text(gunzipSync(compressed)),
  ).toBe("abcdef");

  const calls: KernelStaticRequest[] = [];
  await uploadPreparedFiles(
    {
      async kernel_static(req) {
        calls.push(req);
      },
    },
    [{ path: "app/hello/main.js", content: bytes("abcdef") }],
    { chunkSize: 4, concurrency: 1 },
  );

  expect(calls[0]).toHaveProperty("store");
  expect(calls.slice(1).every((call) => "store_chunk" in call)).toBe(true);

  calls.length = 0;
  const module = bytes("actor {}");
  const moduleHash = hashContent(module);
  await uploadPreparedFiles(
    {
      async kernel_static(req) {
        calls.push(req);
      },
    },
    [{ path: `mo/${moduleHash}.mo`, content: module }],
    { concurrency: 1 },
  );
  const moduleStore = calls[0];
  if (!moduleStore || !("store" in moduleStore)) {
    throw new Error("Expected a Motoko module store operation");
  }
  expect(moduleStore.store.val.content_encoding).toBe("identity");
  expect(moduleStore.store.val.content).toEqual(module);
});

test("bounded parallel work waits for in-flight operations before reporting failure", async () => {
  let active = 0;
  let maximumActive = 0;
  const completed: number[] = [];

  await expect(
    mapWithConcurrency([0, 1, 2, 3], 2, async (item) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, item === 0 ? 1 : 5));
      active -= 1;
      if (item === 0) throw new Error("fixture failure");
      completed.push(item);
      return item;
    }),
  ).rejects.toThrow("fixture failure");

  expect(maximumActive).toBe(2);
  expect(active).toBe(0);
  expect(completed).toEqual([1]);
});

test("wasm assets use the browser streaming compile MIME type", () => {
  expect(mime("motoko/moc_wasm.bc.wasm.assets/code.wasm")).toBe(
    "application/wasm",
  );
});

test("browser surface assets use destination-compatible MIME types", () => {
  for (const [path, expected] of [
    ["module.mjs", "application/javascript"],
    ["font.woff", "font/woff"],
    ["font.woff2", "font/woff2"],
    ["font.ttf", "font/ttf"],
    ["font.otf", "font/otf"],
    ["site.webmanifest", "application/manifest+json"],
    ["image.avif", "image/avif"],
    ["captions.vtt", "text/vtt"],
    ["audio.m4a", "audio/mp4"],
    ["audio.aac", "audio/aac"],
    ["audio.flac", "audio/flac"],
    ["audio.oga", "audio/ogg"],
    ["audio.opus", "audio/ogg"],
    ["audio.weba", "audio/webm"],
    ["video.ogv", "video/ogg"],
    ["video.mov", "video/quicktime"],
    ["font.eot", "application/vnd.ms-fontobject"],
  ] as const) {
    expect(mime(path)).toBe(expected);
  }
});

test("kernel package state binds exactly to the active assembler and app inventory", () => {
  const kernel = {
    format: 3 as const,
    id: "kernel",
    name: "Kernel",
    version: 100,
    entry: "kernel",
  };
  const hello = {
    format: 3 as const,
    id: "hello",
    name: "Hello",
    version: 101,
    entry: "hello",
  };
  const registry = normalizeAppRegistry({
    kernel: appRegistryEntry(kernel),
    hello: appRegistryEntry(hello),
  });
  const state: KernelPackageState = {
    registry,
    apps: registry,
    browserSurfaceOriginAppIds: [],
    browserSurfaceOriginsSidecarPresent: true,
    existingConfigs: { kernel, hello },
    existingModules: [],
    previousStable: "type Stable = {}",
    connectionProviderSupport: connectionProviderSupportFixture,
  };
  const runtime = {
    deployment_id: "0123456789abcdef0123456789abcdef",
    assembler_id: "neutron_actor_v26",
    compiler_id: "moc_test",
    apps: Object.entries(registry)
      .sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      )
      .map(([app_id, entry], index) => ({
        scope: { app_id, installation_uid: BigInt(index + 1) },
        version: BigInt(entry.version),
        deployment_id: "0123456789abcdef0123456789abcdef",
        capability_plan_fingerprint: entry.capability_plan_fingerprint,
        browser_origin_nonce: (index + 1).toString(16).padStart(32, "0"),
        browser_origin_authority_epoch: BigInt(index + 1),
        resident_frame_security: { credentialless_opaque_v1: null },
      })),
    memories: [],
  };

  expect(() =>
    assertKernelPackageStateMatchesRuntime(state, runtime),
  ).not.toThrow();
  expect(() =>
    assertKernelPackageStateMatchesRuntime(
      { ...state, browserSurfaceOriginsSidecarPresent: false },
      runtime,
    ),
  ).toThrow(/missing its browser-surface origins sidecar/);
  const v25State = {
    ...state,
    browserSurfaceOriginsSidecarPresent: false,
  };
  expect(() =>
    assertKernelPackageBaselineMatchesRuntime(v25State, {
      ...runtime,
      assembler_id: "neutron_actor_v25",
    }),
  ).not.toThrow();
  expect(() =>
    assertKernelPackageBaselineMatchesRuntime(state, {
      ...runtime,
      assembler_id: "neutron_actor_v25",
    }),
  ).toThrow(
    /Assembler neutron_actor_v25 cannot contain a browser-surface origins sidecar/,
  );
  const markedState = {
    ...state,
    browserSurfaceOriginAppIds: ["hello"],
  };
  expect(() =>
    assertKernelPackageStateMatchesRuntime(markedState, runtime),
  ).not.toThrow();
  expect(() =>
    assertKernelPackageBaselineMatchesRuntime(
      {
        ...markedState,
        browserSurfaceOriginsSidecarPresent: false,
      },
      {
        ...runtime,
        assembler_id: "neutron_actor_v25",
      },
    ),
  ).toThrow(
    /Assembler neutron_actor_v25 cannot own v26 browser-surface origin authority/,
  );
  expect(() =>
    assertKernelPackageStateMatchesRuntime(state, {
      ...runtime,
      assembler_id: "neutron_actor_v25",
    }),
  ).toThrow(/assembler generation/);
  expect(() =>
    assertKernelPackageBaselineMatchesRuntime(state, {
      ...runtime,
      assembler_id: "neutron_actor_v24",
    }),
  ).toThrow(/assembler generation/);
  expect(() =>
    assertKernelPackageStateMatchesRuntime(state, {
      ...runtime,
      assembler_id: "neutron_actor_v24",
    }),
  ).toThrow(/assembler generation/);
  expect(() =>
    assertKernelPackageBaselineMatchesRuntime(state, {
      ...runtime,
      assembler_id: "neutron_actor_v4",
    }),
  ).toThrow(/assembler generation/);
  expect(() =>
    assertKernelPackageStateMatchesRuntime(state, {
      ...runtime,
      apps: runtime.apps.map((app) =>
        app.scope.app_id === "hello" ? { ...app, version: 100n } : app,
      ),
    }),
  ).toThrow(/does not match the active runtime app inventory/);
  expect(() =>
    assertKernelPackageStateMatchesRuntime(state, {
      ...runtime,
      apps: runtime.apps.map((app) =>
        app.scope.app_id === "hello"
          ? { ...app, capability_plan_fingerprint: "f".repeat(64) }
          : app,
      ),
    }),
  ).toThrow(/does not match the active runtime app inventory/);
  expect(() =>
    assertKernelPackageStateMatchesRuntime(state, {
      ...runtime,
      apps: runtime.apps.filter((app) => app.scope.app_id !== "hello"),
    }),
  ).toThrow(/does not match the active runtime app inventory/);
  expect(() =>
    assertKernelPackageStateMatchesRuntime(state, {
      ...runtime,
      apps: [],
    }),
  ).toThrow(/Invalid runtime app-instance inventory/);
  expect(() =>
    assertKernelPackageStateMatchesRuntime(state, {
      ...runtime,
      apps: runtime.apps.map((app) =>
        app.scope.app_id === "hello"
          ? { ...app, scope: { ...app.scope, installation_uid: 0n } }
          : app,
      ),
    }),
  ).toThrow(/installation uid/);
  expect(() =>
    assertKernelPackageStateMatchesRuntime(state, {
      ...runtime,
      apps: runtime.apps.map((app) =>
        app.scope.app_id === "hello"
          ? { ...app, browser_origin_nonce: "not-a-nonce" }
          : app,
      ),
    }),
  ).toThrow(/app instance/);
  expect(() =>
    assertKernelPackageStateMatchesRuntime(state, {
      ...runtime,
      apps: runtime.apps.map((app) => ({
        ...app,
        deployment_id: "fedcba9876543210fedcba9876543210",
      })),
    }),
  ).toThrow(/another deployment/);
});

test("runtime memory verification keys equal local ids by owner", () => {
  const deploymentId = "0123456789abcdef0123456789abcdef";
  const app = (id: string, schema: string) => ({
    format: 3 as const,
    id,
    name: id === "alpha" ? "Alpha" : "Beta App",
    version: 100,
    entry: schema,
    memory: {
      state: {
        version: 1,
        schemas: { "1": { entry: schema, hash: schema } },
        migrations: [],
      },
    },
  });
  const kernel = {
    format: 3 as const,
    id: "kernel",
    name: "Kernel",
    version: 100,
    entry: "a".repeat(64),
  };
  const alpha = app("alpha", "b".repeat(64));
  const beta = app("beta_app", "c".repeat(64));
  const registry = normalizeAppRegistry({
    alpha: appRegistryEntry(alpha),
    beta_app: appRegistryEntry(beta),
    kernel: appRegistryEntry(kernel),
  });
  const state: KernelPackageState = {
    registry,
    apps: registry,
    browserSurfaceOriginAppIds: [],
    browserSurfaceOriginsSidecarPresent: true,
    existingConfigs: { alpha, beta_app: beta, kernel },
    existingModules: [],
    previousStable: "type Stable = {}",
    connectionProviderSupport: connectionProviderSupportFixture,
  };
  const runtime = {
    deployment_id: deploymentId,
    assembler_id: "neutron_actor_v26",
    compiler_id: "moc_test",
    apps: Object.entries(registry).map(([app_id, entry], index) => ({
      scope: { app_id, installation_uid: BigInt(index + 1) },
      version: BigInt(entry.version),
      deployment_id: deploymentId,
      capability_plan_fingerprint: entry.capability_plan_fingerprint,
      browser_origin_nonce: (index + 1).toString(16).padStart(32, "0"),
      browser_origin_authority_epoch: BigInt(index + 1),
      resident_frame_security: { credentialless_opaque_v1: null },
    })),
    memories: [
      { id: "state", owner: "alpha", version: 1n, schema: "b".repeat(64) },
      {
        id: "state",
        owner: "beta_app",
        version: 1n,
        schema: "c".repeat(64),
      },
    ],
  };

  expect(() =>
    assertKernelPackageStateMatchesRuntime(state, runtime),
  ).not.toThrow();
  expect(() =>
    assertKernelPackageStateMatchesRuntime(state, {
      ...runtime,
      memories: [...runtime.memories].reverse(),
    }),
  ).toThrow(/not canonically ordered/);
  expect(() =>
    assertKernelPackageStateMatchesRuntime(state, {
      ...runtime,
      memories: [runtime.memories[0]!, runtime.memories[0]!],
    }),
  ).toThrow(/duplicates alpha\.state/);
  expect(() =>
    assertKernelPackageStateMatchesRuntime(state, {
      ...runtime,
      memories: [runtime.memories[0]!],
    }),
  ).toThrow(/does not match compile output/);
});

test("install code requests gzip Wasm and roundtrip without changing it", () => {
  const wasm = bytes("\0asm\u0001\0\0\0compiled neutron wasm");
  const request = prepareInstallCodeRequest({
    wasm,
    candid: "service : {}",
    deploymentId: "deploy00000000000000000000000000",
  });

  expect(request.wasm).not.toEqual(wasm);
  expect(Array.from(request.wasm.slice(4, 8))).toEqual([0, 0, 0, 0]);
  expect(Array.from(gunzipSync(request.wasm))).toEqual(Array.from(wasm));
  expect(request.deployment_id).toBe("deploy00000000000000000000000000");
});

test("install code preflight rejects compressed requests above ingress budget", () => {
  const wasm = pseudoRandomBytes(2 * 1024 * 1024);

  expect(() =>
    prepareInstallCodeRequest({
      wasm,
      candid: "service : {}",
      deploymentId: "deploy00000000000000000000000000",
    }),
  ).toThrow(
    /too large.*2 MiB IC ingress limit.*estimated serialized ingress.*chunked Wasm/s,
  );
});

test("deploy rejects a backend-call reservation for its target before I/O", async () => {
  const targetCanisterId = "r7inp-6aaaa-aaaaa-aaabq-cai";
  const prepared = preparePackageInstall(
    packageFilesWithInstallReservations("caller", [
      { kind: "principal", principal: targetCanisterId },
    ]),
  );
  const calls: string[] = [];
  const compiled = compiledFixture(prepared);
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });

  await expect(
    deployPreparedPackages({
      actor,
      targetCanisterId,
      packages: [prepared],
      compiled,
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "old-deployment",
    }),
  ).rejects.toThrow(
    "App caller backend_calls install reservation cannot target the Neutron canister itself",
  );
  expect(calls).toEqual([]);
});

test("deploy uses journal-bound management chunks above the ingress limit", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const calls: string[] = [];
  const compiled = {
    ...compiledFixture(prepared),
    wasm: pseudoRandomBytes(2 * 1024 * 1024),
  };
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });
  const uploaded: Uint8Array[] = [];
  let chunkedRequest:
    | Parameters<
        NonNullable<KernelPackageInstaller["kernel_install_code_chunked"]>
      >[0]
    | undefined;
  actor.kernel_install_wasm_chunks_clear = async (request) => {
    expect(request.deployment_id).toBe(compiled.deploymentId);
    calls.push("clear-wasm");
  };
  actor.kernel_install_wasm_chunk = async (request) => {
    expect(request.deployment_id).toBe(compiled.deploymentId);
    expect(request.chunk.byteLength).toBeLessThanOrEqual(1024 * 1024);
    expect(Buffer.from(request.sha256).toString("hex")).toBe(
      hashContent(request.chunk),
    );
    uploaded.push(request.chunk);
    calls.push("upload-wasm");
  };
  actor.kernel_install_code_chunked = async (request) => {
    chunkedRequest = request;
    calls.push("install-chunked");
  };

  await deployPreparedPackages({
    actor,
    packages: [prepared],
    compiled,
    existingApps: {},
    existingBrowserSurfaceOriginAppIds: [],
    expectedDeploymentId: "old-deployment",
  });

  const compressed = concatChunks(uploaded);
  expect(compressed).toEqual(
    prepareDeterministicWasmTransport(compiled.wasm).transportWasm,
  );
  expect(Array.from(gunzipSync(compressed))).toEqual(
    Array.from(compiled.wasm),
  );
  expect(chunkedRequest?.chunk_hashes.length).toBe(uploaded.length);
  expect(
    Buffer.from(chunkedRequest?.wasm_module_hash ?? []).toString("hex"),
  ).toBe(hashContent(compressed));
  expect(calls.filter((call) => call === "clear-wasm")).toHaveLength(2);
  expect(calls).not.toContain("install");
  expect(calls.indexOf("begin")).toBeLessThan(
    calls.indexOf("clear-wasm"),
  );
  expect(calls.indexOf("install-chunked")).toBeLessThan(
    calls.indexOf("commit"),
  );
});

test("failed chunked activation clears the management store before abort", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const calls: string[] = [];
  const compiled = {
    ...compiledFixture(prepared),
    wasm: pseudoRandomBytes(2 * 1024 * 1024),
  };
  const actor = journalActor({
    calls,
    deploymentId: "old-deployment",
    compiled,
  });
  actor.kernel_install_wasm_chunks_clear = async () => {
    calls.push("clear-wasm");
  };
  actor.kernel_install_wasm_chunk = async () => {
    calls.push("upload-wasm");
  };
  actor.kernel_install_code_chunked = async () => {
    calls.push("install-chunked");
    throw new Error("chunked install rejected");
  };

  await expect(
    deployPreparedPackages({
      actor,
      packages: [prepared],
      compiled,
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "old-deployment",
      verifyTimeoutMs: 1,
    }),
  ).rejects.toThrow(/chunked install rejected/);

  expect(calls.filter((call) => call === "clear-wasm")).toHaveLength(2);
  expect(calls).toContain("abort");
  expect(calls.indexOf("clear-wasm", calls.indexOf("install-chunked"))).toBeLessThan(
    calls.indexOf("abort"),
  );
});

test("chunk upload failure aborts without waiting for runtime activation", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const calls: string[] = [];
  const compiled = {
    ...compiledFixture(prepared),
    wasm: pseudoRandomBytes(2 * 1024 * 1024),
  };
  const actor = journalActor({
    calls,
    deploymentId: "old-deployment",
    compiled,
  });
  actor.kernel_install_wasm_chunks_clear = async () => {
    calls.push("clear-wasm");
  };
  actor.kernel_install_wasm_chunk = async () => {
    calls.push("upload-wasm");
    throw new Error("upload rejected");
  };
  actor.kernel_install_code_chunked = async () => {
    calls.push("install-chunked");
  };

  await expect(
    deployPreparedPackages({
      actor,
      packages: [prepared],
      compiled,
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "old-deployment",
    }),
  ).rejects.toThrow(/upload failed before activation was dispatched/);

  expect(calls).not.toContain("install-chunked");
  expect(calls.filter((call) => call === "clear-wasm")).toHaveLength(2);
  expect(calls).toContain("abort");
});

test("deploy stages assets, verifies the actor, then commits", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const calls: string[] = [];
  const compiled = compiledFixture(prepared);
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });

  const result = await deployPreparedPackages({
    actor,
    packages: [prepared],
    compiled,
    existingApps: {},
    existingBrowserSurfaceOriginAppIds: [],
    expectedDeploymentId: "old-deployment",
  });

  expect(result.apps.hello?.name).toBe("Hello");
  expect(
    calls.some((call) =>
      call.startsWith(
        "store:/system/staging/deploy00000000000000000000000000/",
      ),
    ),
  ).toBe(true);
  expect(calls).not.toContain("store:/system/apps.json");
  expect(calls).toContain("begin");
  expect(calls).not.toContain("prepare-reservations");
  expect(calls).toContain("install");
  expect(calls).toContain("commit");
  expect(calls.indexOf("install")).toBeLessThan(calls.indexOf("commit"));
});

test("deploy snapshots reviewed package content before its first upload await", async () => {
  const prepared = preparePackageInstall(packageBytes(helloPackageFiles()));
  const mutable = prepared.files.find(
    ({ path }) => path === "app/hello/main.js",
  );
  if (!mutable) throw new Error("Expected prepared frontend file");
  const reviewed = mutable.content.slice();
  const compiled = compiledFixture(prepared);
  const calls: string[] = [];
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });
  const stored = new Map<
    string,
    { encoding: "gzip" | "identity"; chunks: Uint8Array[] }
  >();
  let journal: InstallJournal | undefined;
  let mutated = false;
  const kernelStatic = actor.kernel_static.bind(actor);
  const begin = actor.kernel_install_begin_checked.bind(actor);
  actor.kernel_static = async (request) => {
    if ("store" in request) {
      stored.set(request.store.key, {
        encoding: request.store.val.content_encoding,
        chunks: [request.store.val.content.slice()],
      });
      if (!mutated && request.store.key.startsWith("/mo/")) {
        mutable.content[0] = mutable.content[0]! ^ 1;
        mutated = true;
      }
    } else if ("store_chunk" in request) {
      stored.get(request.store_chunk.key)?.chunks.push(
        request.store_chunk.content.slice(),
      );
    }
    return kernelStatic(request);
  };
  actor.kernel_install_begin_checked = async (request) => {
    journal = request.journal;
    return begin(request);
  };

  await deployPreparedPackages({
    actor,
    packages: [prepared],
    compiled,
    existingApps: {},
    existingBrowserSurfaceOriginAppIds: [],
    expectedDeploymentId: "old-deployment",
  });

  expect(mutated).toBe(true);
  const source = journal?.copies.find(
    ({ target }) => target === "/app/hello/main.js",
  )?.source;
  expect(source).toBeDefined();
  const uploaded = stored.get(source!);
  expect(uploaded).toBeDefined();
  const encoded = concatChunks(uploaded!.chunks);
  const installed =
    uploaded!.encoding === "gzip" ? gunzipSync(encoded) : encoded;
  expect(installed).toEqual(reviewed);
});

test("deploy seals compile identity and runtime expectations before its first upload await", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const compiled = compiledFixture(prepared);
  const reviewed = structuredClone(compiled);
  const calls: string[] = [];
  const actor = journalActor({
    calls,
    deploymentId: reviewed.deploymentId,
    compiled,
  });
  let mutated = false;
  let journal: InstallJournal | undefined;
  let dispatchedWasm: Uint8Array | undefined;
  let committedDeploymentId: string | undefined;
  const kernelStatic = actor.kernel_static.bind(actor);
  const begin = actor.kernel_install_begin_checked.bind(actor);
  const installCode = actor.kernel_install_code.bind(actor);
  const commit = actor.kernel_install_commit.bind(actor);

  actor.kernel_static = async (request) => {
    await kernelStatic(request);
    if (
      !mutated &&
      "store" in request &&
      request.store.key.startsWith("/mo/")
    ) {
      compiled.deploymentId = "mutated-deployment";
      compiled.compilerId = "mutated-compiler";
      compiled.appInstanceInventory = compiled.appInstanceInventory.map(
        (entry) => ({ ...entry, version: entry.version + 1 }),
      );
      compiled.managedMemoryInventory = [
        {
          owner: "hello",
          id: "mutated",
          version: 1,
          schema: "f".repeat(64),
        },
      ];
      compiled.wasm.fill(0xff);
      mutated = true;
    }
  };
  actor.kernel_install_begin_checked = async (request) => {
    journal = request.journal;
    return begin(request);
  };
  actor.kernel_install_code = async (request) => {
    dispatchedWasm = request.wasm.slice();
    return installCode(request);
  };
  actor.kernel_runtime_info = async () => ({
    deployment_id: reviewed.deploymentId,
    assembler_id: "neutron_actor_v26",
    compiler_id: reviewed.compilerId,
    apps: runtimeInstances(reviewed, reviewed.deploymentId),
    memories: reviewed.managedMemoryInventory,
  });
  actor.kernel_install_commit = async (request) => {
    committedDeploymentId = request.deployment_id;
    return commit(request);
  };

  const result = await deployPreparedPackages({
    actor,
    packages: [prepared],
    compiled,
    existingApps: {},
    existingBrowserSurfaceOriginAppIds: [],
    expectedDeploymentId: "old-deployment",
  });

  expect(mutated).toBe(true);
  expect(journal?.deployment_id).toBe(reviewed.deploymentId);
  expect(journal?.target_app_inventory).toEqual(runtimeAppInventory(reviewed));
  expect(committedDeploymentId).toBe(reviewed.deploymentId);
  expect(Array.from(gunzipSync(dispatchedWasm!))).toEqual(
    Array.from(reviewed.wasm),
  );
  expect(result.compiled).not.toBe(compiled);
  expect(result.compiled).toEqual(reviewed);
  expect(Object.isFrozen(result.compiled)).toBe(true);
  expect(Object.isFrozen(result.compiled.appInstanceInventory)).toBe(true);
});

test("deploy prepares install reservations after the journal and before activation", async () => {
  const zeta = preparePackageInstall(
    packageFilesWithInstallReservations("zeta_app", [
      {
        kind: "principal",
        principal: "rrkah-fqaaa-aaaaa-aaaaq-cai",
      },
    ]),
  );
  const alpha = preparePackageInstall(
    packageFilesWithInstallReservations("alpha_app", [
      {
        kind: "method",
        method: "app_mail__mail_v1_update",
      },
      {
        kind: "exact",
        principal: "rrkah-fqaaa-aaaaa-aaaaq-cai",
        method: "app_mail__mail_v1_update",
      },
    ]),
  );
  const calls: string[] = [];
  const compiled = compiledFixture(zeta, alpha);
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });
  let request:
    | Parameters<
        NonNullable<
          KernelPackageInstaller["kernel_install_reservations_prepare"]
        >
      >[0]
    | undefined;
  actor.kernel_install_reservations_prepare = async (input) => {
    calls.push("prepare-reservations");
    request = input;
  };
  actor.kernel_install_commit = async () => {
    calls.push("commit");
    return { committed: null };
  };

  await deployPreparedPackages({
    actor,
    packages: [zeta, alpha],
    compiled,
    existingApps: {},
    existingBrowserSurfaceOriginAppIds: [],
    expectedDeploymentId: "old-deployment",
  });

  expect(calls.indexOf("begin")).toBeLessThan(
    calls.indexOf("prepare-reservations"),
  );
  expect(calls.indexOf("prepare-reservations")).toBeLessThan(
    calls.indexOf("install"),
  );
  expect(calls.filter((call) => call === "commit")).toHaveLength(1);
  expect(request?.deployment_id).toBe(compiled.deploymentId);
  expect(request?.apps.map(({ app_id }) => app_id)).toEqual([
    "alpha_app",
    "zeta_app",
  ]);
  const alphaReservations = request?.apps[0]?.reservations as
    | Array<Record<string, unknown>>
    | undefined;
  expect(
    alphaReservations?.map((reservation) => Object.keys(reservation)[0]),
  ).toEqual(["exact", "method"]);
  const exact = alphaReservations?.[0]?.exact as
    | { principal?: { toText(): string } }
    | undefined;
  expect(exact?.principal?.toText()).toBe("rrkah-fqaaa-aaaaa-aaaaq-cai");
});

test("deploy rejects a target that lacks the current install commit", async () => {
  const prepared = preparePackageInstall(
    packageFilesWithInstallReservations("reserved_app", [
      {
        kind: "method",
        method: "app_mail__mail_v1_update",
      },
    ]),
  );
  const calls: string[] = [];
  const compiled = compiledFixture(prepared);
  compiled.candid = `service : {}`;
  const actor = journalActor({
    calls,
    deploymentId: "old-deployment",
    compiled,
  });
  actor.kernel_install_reservations_prepare = async () => {
    calls.push("prepare-reservations");
  };

  await expect(
    deployPreparedPackages({
      actor,
      packages: [prepared],
      compiled,
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "old-deployment",
    }),
  ).rejects.toThrow(
    /compiled target must expose the current kernel_install_commit contract/i,
  );

  expect(calls).toEqual([]);
});

test("deploy rejects an incompatible current commit target ABI before IO", async () => {
  const prepared = preparePackageInstall(
    packageFilesWithInstallReservations("reserved_app", [
      {
        kind: "method",
        method: "app_mail__mail_v1_update",
      },
    ]),
  );
  const calls: string[] = [];
  const compiled = compiledFixture(prepared);
  compiled.candid = `
type IncompatibleKernel = service {
  kernel_install_commit : () -> ();
};
service : () -> IncompatibleKernel
`;
  const actor = journalActor({
    calls,
    deploymentId: "old-deployment",
    compiled,
  });
  actor.kernel_install_reservations_prepare = async () => {
    calls.push("prepare-reservations");
  };

  await expect(
    deployPreparedPackages({
      actor,
      packages: [prepared],
      compiled,
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "old-deployment",
    }),
  ).rejects.toThrow(/install commit binding mismatch.*input arity/i);

  expect(calls).toEqual([]);
});

test("deploy replays an ambiguously acknowledged reservation preparation before activation", async () => {
  const prepared = preparePackageInstall(
    packageFilesWithInstallReservations("reserved_app", [
      {
        kind: "method",
        method: "app_mail__mail_v1_update",
      },
    ]),
  );
  const calls: string[] = [];
  const compiled = compiledFixture(prepared);
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });
  let attempts = 0;
  let firstRequest: unknown;
  actor.kernel_install_reservations_prepare = async (request) => {
    attempts += 1;
    calls.push(`prepare-reservations:${attempts}`);
    if (attempts === 1) {
      firstRequest = request;
      throw new Error("reply lost after update execution");
    }
    expect(request === firstRequest).toBe(true);
  };

  await deployPreparedPackages({
    actor,
    packages: [prepared],
    compiled,
    existingApps: {},
    existingBrowserSurfaceOriginAppIds: [],
    expectedDeploymentId: "old-deployment",
  });

  expect(attempts).toBe(2);
  expect(calls.indexOf("begin")).toBeLessThan(
    calls.indexOf("prepare-reservations:1"),
  );
  expect(calls.indexOf("prepare-reservations:2")).toBeLessThan(
    calls.indexOf("install"),
  );
});

test("failed reservation preparation confirms pre-dispatch abort without runtime inference", async () => {
  const prepared = preparePackageInstall(
    packageFilesWithInstallReservations("reserved_app", [
      {
        kind: "method",
        method: "app_mail__mail_v1_update",
      },
    ]),
  );
  const calls: string[] = [];
  const compiled = compiledFixture(prepared);
  const actor = journalActor({
    calls,
    deploymentId: "old-deployment",
    compiled,
  });
  actor.kernel_install_reservations_prepare = async () => {
    calls.push("prepare-reservations");
    throw new Error("reservation preparation unavailable");
  };
  const abort = actor.kernel_install_abort.bind(actor);
  let abortAttempts = 0;
  actor.kernel_install_abort = async (request) => {
    abortAttempts += 1;
    await abort(request);
    if (abortAttempts === 1) {
      throw new Error("abort reply lost");
    }
  };
  actor.kernel_runtime_info = async () => {
    calls.push("runtime");
    throw new Error("runtime query unavailable");
  };

  await expect(
    deployPreparedPackages({
      actor,
      packages: [prepared],
      compiled,
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "old-deployment",
    }),
  ).rejects.toThrow(/reservation preparation unavailable/i);

  expect(calls.filter((call) => call === "prepare-reservations")).toHaveLength(
    2,
  );
  expect(abortAttempts).toBe(2);
  expect(calls).not.toContain("install");
  expect(calls).not.toContain("runtime");
  expect(await actor.kernel_install_status(null)).toEqual([]);
});

test("failed reservation preparation reports unconfirmed cleanup without dispatch", async () => {
  const prepared = preparePackageInstall(
    packageFilesWithInstallReservations("reserved_app", [
      {
        kind: "method",
        method: "app_mail__mail_v1_update",
      },
    ]),
  );
  const calls: string[] = [];
  const compiled = compiledFixture(prepared);
  const actor = journalActor({
    calls,
    deploymentId: "old-deployment",
    compiled,
  });
  actor.kernel_install_reservations_prepare = async () => {
    calls.push("prepare-reservations");
    throw new Error("reservation preparation unavailable");
  };
  actor.kernel_install_abort = async () => {
    calls.push("abort");
    throw new Error("abort unavailable");
  };

  await expect(
    deployPreparedPackages({
      actor,
      packages: [prepared],
      compiled,
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "old-deployment",
    }),
  ).rejects.toThrow(/cleanup could not be confirmed/i);

  expect(calls.filter((call) => call === "abort")).toHaveLength(2);
  expect(calls).not.toContain("install");
  expect(await actor.kernel_install_status(null)).toHaveLength(1);
});

test("failed reservation preparation never trusts a stale empty cleanup query", async () => {
  const prepared = preparePackageInstall(
    packageFilesWithInstallReservations("reserved_app", [
      {
        kind: "method",
        method: "app_mail__mail_v1_update",
      },
    ]),
  );
  const calls: string[] = [];
  const compiled = compiledFixture(prepared);
  const actor = journalActor({
    calls,
    deploymentId: "old-deployment",
    compiled,
  });
  actor.kernel_install_reservations_prepare = async () => {
    calls.push("prepare-reservations");
    throw new Error("reservation preparation unavailable");
  };
  actor.kernel_install_abort = async () => {
    calls.push("abort");
    throw new Error("abort reply unavailable");
  };
  actor.kernel_install_status = async () => [];

  await expect(
    deployPreparedPackages({
      actor,
      packages: [prepared],
      compiled,
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "old-deployment",
    }),
  ).rejects.toThrow(/cleanup could not be confirmed/i);

  expect(calls.filter((call) => call === "abort")).toHaveLength(2);
  expect(calls).not.toContain("install");
});

test("a blocked current commit remains pending and cannot report deploy success", async () => {
  const prepared = preparePackageInstall(
    packageFilesWithInstallReservations("reserved_app", [
      {
        kind: "method",
        method: "app_mail__mail_v1_update",
      },
    ]),
  );
  const calls: string[] = [];
  const compiled = compiledFixture(prepared);
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });
  actor.kernel_install_commit = async () => {
    calls.push("commit");
    return { blocked: null };
  };
  actor.kernel_install_reservations_prepare = async () => {
    calls.push("prepare-reservations");
  };

  await expect(
    deployPreparedPackages({
      actor,
      packages: [prepared],
      compiled,
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "old-deployment",
    }),
  ).rejects.toThrow(/commit is blocked.*remains pending/i);

  expect(calls.filter((call) => call === "commit")).toHaveLength(1);
  expect(await actor.kernel_install_status(null)).toHaveLength(1);
});

test("deploy replays a lost current commit reply", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const calls: string[] = [];
  const compiled = compiledFixture(prepared);
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });
  const readStatus = actor.kernel_install_status.bind(actor);
  const commit = actor.kernel_install_commit.bind(actor);
  let commitAttempts = 0;
  let statusReads = 0;
  actor.kernel_install_status = async (input) => {
    statusReads += 1;
    return readStatus(input);
  };
  actor.kernel_install_commit = async (request) => {
    commitAttempts += 1;
    const result = await commit(request);
    if (commitAttempts === 1) {
      throw new Error("commit reply lost");
    }
    return result;
  };

  await expect(
    deployPreparedPackages({
      actor,
      packages: [prepared],
      compiled,
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "old-deployment",
    }),
  ).resolves.toMatchObject({ compiled });

  expect(commitAttempts).toBe(2);
  expect(calls.filter((call) => call === "commit")).toHaveLength(2);
  expect(statusReads).toBe(0);
  expect(await readStatus(null)).toEqual([]);
});

test("current commit cannot report success while its journal remains pending", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const calls: string[] = [];
  const compiled = compiledFixture(prepared);
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });
  actor.kernel_install_commit = async () => {
    calls.push("commit");
    throw new Error("commit reply unavailable");
  };

  await expect(
    deployPreparedPackages({
      actor,
      packages: [prepared],
      compiled,
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "old-deployment",
    }),
  ).rejects.toThrow(/could not be causally confirmed/i);

  expect(calls.filter((call) => call === "commit")).toHaveLength(2);
  expect(await actor.kernel_install_status(null)).toHaveLength(1);
});

test("current commit never trusts a stale empty status after two failed updates", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const calls: string[] = [];
  const compiled = compiledFixture(prepared);
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });
  actor.kernel_install_commit = async () => {
    calls.push("commit");
    throw new Error("commit reply unavailable");
  };
  actor.kernel_install_status = async () => [];

  await expect(
    deployPreparedPackages({
      actor,
      packages: [prepared],
      compiled,
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "old-deployment",
    }),
  ).rejects.toThrow(/could not be causally confirmed/i);

  expect(calls.filter((call) => call === "commit")).toHaveLength(2);
});

test("a multi-package deployment uses one journal, activation, and commit", async () => {
  const hello = preparePackageInstall(helloPackageFiles());
  const otherFiles = helloPackageFiles();
  const otherManifest = JSON.parse(text(otherFiles["neutron.json"]!));
  otherFiles["neutron.json"] = bytes(
    JSON.stringify({ ...otherManifest, id: "other_app", name: "Other" }),
  );
  const other = preparePackageInstall(otherFiles);
  const calls: string[] = [];
  const compiled = compiledFixture(hello, other);
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });
  let journal: InstallJournal | undefined;
  const begin = actor.kernel_install_begin_checked.bind(actor);
  actor.kernel_install_begin_checked = async (request) => {
    journal = request.journal;
    return begin(request);
  };

  const result = await deployPreparedPackages({
    actor,
    packages: [hello, other],
    compiled,
    existingApps: {},
    existingBrowserSurfaceOriginAppIds: [],
    expectedDeploymentId: "old-deployment",
  });

  expect(Object.keys(result.apps).sort()).toEqual(["hello", "other_app"]);
  expect(
    journal?.copies.some(({ target }) => target === "/app/hello/main.js"),
  ).toBe(true);
  expect(
    journal?.copies.some(({ target }) => target === "/app/other_app/main.js"),
  ).toBe(true);
  expect(calls.filter((call) => call === "begin")).toHaveLength(1);
  expect(calls.filter((call) => call === "install")).toHaveLength(1);
  expect(calls.filter((call) => call === "commit")).toHaveLength(1);
});

test("deploy commits caller-supplied staged assets in the same journal", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const calls: string[] = [];
  const compiled = compiledFixture(prepared);
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });
  let journal: InstallJournal | undefined;
  const begin = actor.kernel_install_begin_checked.bind(actor);
  actor.kernel_install_begin_checked = async (request) => {
    journal = request.journal;
    return begin(request);
  };

  await deployPreparedPackages({
    actor,
    packages: [prepared],
    compiled,
    existingApps: {},
    existingBrowserSurfaceOriginAppIds: [],
    expectedDeploymentId: "old-deployment",
    stagedAssets: [
      {
        target: "/system/install-provenance.json",
        content: bytes('{"format":1,"apps":{}}'),
        contentType: "application/json",
      },
    ],
  });

  expect(
    journal?.copies.some(
      ({ target }) => target === "/system/install-provenance.json",
    ),
  ).toBe(true);
});

test("deploy rejects staged asset collisions and reserved targets before IO", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const compiled = compiledFixture(prepared);
  for (const target of [
    "/system/apps.json",
    BROWSER_SURFACE_ORIGINS_PATH,
    "/app/hello/extra.js",
    "/mo/forbidden.mo",
    "/system/staging/x",
    DEPLOYMENT_BUILD_RECORD_PATH,
  ]) {
    const calls: string[] = [];
    const actor = journalActor({
      calls,
      deploymentId: compiled.deploymentId,
      compiled,
    });
    await expect(
      deployPreparedPackages({
        actor,
        packages: [prepared],
        compiled,
        existingApps: {},
        existingBrowserSurfaceOriginAppIds: [],
        expectedDeploymentId: "old-deployment",
        stagedAssets: [{ target, content: bytes("x") }],
      }),
    ).rejects.toThrow(
      /Duplicate mutable install target|Reserved staged asset target/,
    );
    expect(calls).toEqual([]);
  }
});

test("deploy rejects an oversized install journal before any upload", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const compiled = compiledFixture(prepared);
  const calls: string[] = [];
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });

  await expect(
    deployPreparedPackages({
      actor,
      packages: [prepared],
      compiled,
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "old-deployment",
      stagedAssets: Array.from(
        { length: KERNEL_INSTALL_MAX_COPIES },
        (_, index) => ({
          target: `/extra/${index}`,
          content: Uint8Array.of(index & 0xff),
        }),
      ),
    }),
  ).rejects.toThrow(/asset copies.*kernel limit/);
  expect(calls).toEqual([]);
});

test("Kernel legal and deployment-record clears count toward the bounded prefix inventory", async () => {
  const kernel = preparePackageInstall(kernelPackageFilesAtVersion(308));
  const packages = [
    kernel,
    ...Array.from(
      { length: KERNEL_INSTALL_MAX_CLEAR_PREFIXES_PER_COMMIT },
      (_, index) =>
        preparePackageInstall(headlessPackageFiles(`clear_${index}`)),
    ),
  ];
  const compiled = compiledFixture(...packages);
  const calls: string[] = [];
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });

  await expect(
    deployPreparedPackages({
      actor,
      packages,
      compiled,
      existingApps: {
        kernel: appRegistryEntry({ ...kernel.manifest, version: 307 }),
      },
      existingBrowserSurfaceOriginAppIds: [],
      deploymentBuildRecord: {} as any,
      expectedDeploymentId: "old-deployment",
    }),
  ).rejects.toThrow(
    /clears 130 asset prefixes.*limit is 128 per deployment.*successive deployments/i,
  );
  expect(calls).toEqual([]);
});

test("deploy rejects too many app removals before any upload", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const compiled = compiledFixture(prepared);
  const calls: string[] = [];
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });

  await expect(
    deployPreparedPackages({
      actor,
      packages: [prepared],
      compiled,
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "old-deployment",
      removedApps: Array.from(
        { length: KERNEL_INSTALL_MAX_APP_REMOVALS_PER_COMMIT + 1 },
        (_, index) => `gone_${index}`,
      ),
    }),
  ).rejects.toThrow(/kernel limit is 64 per deployment.*successive deployments/i);
  expect(calls).toEqual([]);
});

test("deployment records an expected-baseline journal before activation", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const calls: string[] = [];
  const compiled = compiledFixture(prepared);
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });
  let beginRequest:
    { expected_deployment_id: string; journal: InstallJournal } | undefined;
  const begin = actor.kernel_install_begin_checked.bind(actor);
  actor.kernel_install_begin_checked = async (request) => {
    beginRequest = request;
    calls.push("begin-bound");
    await begin(request);
  };

  await deployPreparedPackages({
    actor,
    packages: [prepared],
    compiled,
    existingApps: {},
    existingBrowserSurfaceOriginAppIds: [],
    expectedDeploymentId: "old-deployment",
  });

  expect(beginRequest?.expected_deployment_id).toBe("old-deployment");
  expect(beginRequest?.journal.deployment_id).toBe(compiled.deploymentId);
  expect(beginRequest?.journal.target_app_inventory).toEqual([
    {
      app_id: "hello",
      version: 100,
      capability_plan_fingerprint: prepared.capabilityPlanFingerprint,
      resident_frame_security: { credentialless_opaque_v1: null },
    },
  ]);
  expect(calls).toContain("begin-bound");
});

test("journal begin failures stop before activation", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const calls: string[] = [];
  const compiled = compiledFixture(prepared);
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });
  actor.kernel_install_begin_checked = async () => {
    throw new Error(
      "Canister has no update method kernel_install_begin_checked",
    );
  };

  await expect(
    deployPreparedPackages({
      actor,
      packages: [prepared],
      compiled,
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "old-deployment",
    }),
  ).rejects.toThrow(/kernel_install_begin_checked/);

  expect(calls).not.toContain("begin");
  expect(calls).not.toContain("install");
});

test("deploy clears partial staging when an upload fails before journaling", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const calls: string[] = [];
  const compiled = compiledFixture(prepared);
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });
  const kernelStatic = actor.kernel_static.bind(actor);
  let stagedStores = 0;
  actor.kernel_static = async (request) => {
    if (
      "store" in request &&
      request.store.key.startsWith(
        `/system/staging/${compiled.deploymentId}/`,
      ) &&
      (stagedStores += 1) === 2
    ) {
      throw new Error("staging upload failed");
    }
    return kernelStatic(request);
  };

  await expect(
    deployPreparedPackages({
      actor,
      packages: [prepared],
      compiled,
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "old-deployment",
    }),
  ).rejects.toThrow("staging upload failed");

  expect(calls).toContain(`clear:/system/staging/${compiled.deploymentId}/`);
  expect(calls).not.toContain("begin");
});

test("deploy retains staging after two unacknowledged journal failures", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const calls: string[] = [];
  const compiled = compiledFixture(prepared);
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });
  let beginAttempts = 0;
  actor.kernel_install_begin_checked = async () => {
    beginAttempts += 1;
    calls.push("begin");
    throw new Error("journal write failed");
  };

  await expect(
    deployPreparedPackages({
      actor,
      packages: [prepared],
      compiled,
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "old-deployment",
    }),
  ).rejects.toThrow("journal write failed");

  expect(beginAttempts).toBe(2);
  expect(calls).not.toContain(
    `clear:/system/staging/${compiled.deploymentId}/`,
  );
});

test("deploy proceeds when the exact journal replay acknowledges a lost first reply", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const calls: string[] = [];
  const compiled = compiledFixture(prepared);
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });
  const kernelInstallBegin = actor.kernel_install_begin_checked.bind(actor);
  let firstRequest: unknown;
  let beginAttempts = 0;
  actor.kernel_install_begin_checked = async (request) => {
    beginAttempts += 1;
    if (beginAttempts === 1) {
      firstRequest = request;
    } else {
      expect(request === firstRequest).toBe(true);
    }
    await kernelInstallBegin(request);
    if (beginAttempts === 1) {
      throw new Error("journal response lost");
    }
  };

  await expect(
    deployPreparedPackages({
      actor,
      packages: [prepared],
      compiled,
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "old-deployment",
    }),
  ).resolves.toMatchObject({ compiled });

  expect(beginAttempts).toBe(2);
  expect(calls.filter((call) => call === "begin")).toHaveLength(2);
  expect(calls.filter((call) => call === "install")).toHaveLength(1);
  expect(calls.filter((call) => call === "commit")).toHaveLength(1);
});

test("deploy retains staging when journal replies are lost and status is stale", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const calls: string[] = [];
  const compiled = compiledFixture(prepared);
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });
  const kernelInstallBegin = actor.kernel_install_begin_checked.bind(actor);
  const readStatus = actor.kernel_install_status.bind(actor);
  let firstRequest: unknown;
  let beginAttempts = 0;
  actor.kernel_install_begin_checked = async (request) => {
    beginAttempts += 1;
    if (beginAttempts === 1) {
      firstRequest = request;
    } else {
      expect(request === firstRequest).toBe(true);
    }
    await kernelInstallBegin(request);
    throw new Error("journal response lost");
  };
  actor.kernel_install_status = async () => [];

  await expect(
    deployPreparedPackages({
      actor,
      packages: [prepared],
      compiled,
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "old-deployment",
    }),
  ).rejects.toThrow("journal response lost");

  expect(beginAttempts).toBe(2);
  expect(calls).not.toContain(
    `clear:/system/staging/${compiled.deploymentId}/`,
  );
  const status = await readStatus(null);
  expect(Array.isArray(status) ? status[0]?.deployment_id : undefined).toBe(
    compiled.deploymentId,
  );
});

test("deploy rejects browser-surface origin authority drift before I/O", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const compiled = compiledFixture(prepared);
  const retainedCalls: string[] = [];
  const retainedActor = journalActor({
    calls: retainedCalls,
    deploymentId: compiled.deploymentId,
    compiled,
  });
  await expect(
    deployPreparedPackages({
      actor: retainedActor,
      packages: [],
      compiled,
      existingApps: { hello: appRegistryEntry(prepared.manifest) },
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "old-deployment",
    }),
  ).rejects.toThrow(
    "Browser-surface origin sidecar does not match compile output",
  );
  expect(retainedCalls).toEqual([]);

  const suppressed = {
    ...compiledFixture(prepared),
    browserSurfaceOriginAppIds: [],
  };
  const calls: string[] = [];
  const actor = journalActor({
    calls,
    deploymentId: suppressed.deploymentId,
    compiled: suppressed,
  });

  await expect(
    deployPreparedPackages({
      actor,
      packages: [prepared],
      compiled: suppressed,
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "old-deployment",
    }),
  ).rejects.toThrow(
    "Browser-surface origin sidecar does not match compile output",
  );
  expect(calls).toEqual([]);
});

test("deploy preserves kernel root HTML content type while staging", async () => {
  const files = kernelPackageFiles();
  const prepared = preparePackageInstall(files);
  const calls: string[] = [];
  const compiled = compiledFixture(prepared);
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });
  const stores = new Map<string, { content_type: string }>();
  let journalCopies: InstallJournal["copies"] = [];
  const kernelStatic = actor.kernel_static.bind(actor);
  const kernelInstallBegin = actor.kernel_install_begin_checked.bind(actor);
  actor.kernel_static = async (request) => {
    if ("store" in request) stores.set(request.store.key, request.store.val);
    return kernelStatic(request);
  };
  actor.kernel_install_begin_checked = async (request) => {
    journalCopies = request.journal.copies;
    return kernelInstallBegin(request);
  };

  await deployPreparedPackages({
    actor,
    packages: [prepared],
    compiled,
    existingApps: {},
    existingBrowserSurfaceOriginAppIds: [],
    expectedDeploymentId: "old-deployment",
  });

  const rootSource = journalCopies.find(({ target }) => target === "/")?.source;
  expect(rootSource).toBeDefined();
  expect(stores.get(rootSource!)?.content_type).toBe("text/html");
});

test("the v0.3.6 bridge omits the unsupported legal clear and copies its record", async () => {
  const journal = await captureKernelReplacementJournal(
    withValidPackageRecord(kernelPackageFilesAtVersion(307)),
    306,
  );

  expect(journal.clear_prefixes).toEqual([]);
  expect(
    journal.copies
      .map(({ target }) => target)
      .filter((target) => target.startsWith("/pkg/legal/"))
      .sort(compareCanonicalText),
  ).toEqual([
    "/pkg/legal/APPLICATION-NOTICE.txt",
    "/pkg/legal/LICENSE.example.txt",
    "/pkg/legal/package-record.v1.json",
  ]);
});

test("state-preserving deployment rejects a legacy assembler before I/O", async () => {
  const previous = preparePackageInstall(kernelPackageFilesAtVersion(307));
  const candidate = preparePackageInstall(kernelPackageFilesAtVersion(308));
  const existingApps = { kernel: appRegistryEntry(previous.manifest) };
  const compiled: CompileResult = {
    ...completeKernelCompiledFixture(candidate),
    assemblerId: LEGACY_V25_ASSEMBLER_ID,
  };
  const state: KernelPackageState = {
    registry: existingApps,
    apps: existingApps,
    browserSurfaceOriginAppIds: [],
    browserSurfaceOriginsSidecarPresent: false,
    existingConfigs: { kernel: previous.manifest },
    existingModules: [],
    previousStable: "previous stable signature\n",
    connectionProviderSupport: connectionProviderSupportFixture,
  };

  expect(() =>
    prepareCompleteDeploymentBuildRecord({
      targetCanisterId: TEST_TARGET_CANISTER_ID,
      packages: [candidate],
      state,
      compiled,
      expectedDeploymentId: "c".repeat(32),
    }),
  ).toThrow(
    `State-preserving deployment requires current assembler ${ASSEMBLER_ID}`,
  );

  const calls: string[] = [];
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });
  await expect(
    deployPreparedPackages({
      actor,
      packages: [candidate],
      compiled,
      existingApps,
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "c".repeat(32),
    }),
  ).rejects.toThrow(
    `State-preserving deployment requires current assembler ${ASSEMBLER_ID}`,
  );
  expect(calls).toEqual([]);
});

test("v0.3.7 rejects missing or null records for inline and chunked deployments before I/O", async () => {
  const previous = preparePackageInstall(kernelPackageFilesAtVersion(307));
  const candidate = preparePackageInstall(kernelPackageFilesAtVersion(308));
  const existingApps = { kernel: appRegistryEntry(previous.manifest) };
  for (const wasm of [
    Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0),
    pseudoRandomBytes(2 * 1024 * 1024),
  ]) {
    const compiled = { ...completeKernelCompiledFixture(candidate), wasm };
    for (const deploymentBuildRecord of [undefined, null]) {
      const calls: string[] = [];
      const actor = journalActor({
        calls,
        deploymentId: compiled.deploymentId,
        compiled,
      });
      await expect(
        deployPreparedPackages({
          actor,
          packages: [candidate],
          compiled,
          existingApps,
          existingBrowserSurfaceOriginAppIds: [],
          expectedDeploymentId: "c".repeat(32),
          ...(deploymentBuildRecord === null
            ? { deploymentBuildRecord: null as never }
            : {}),
        }),
      ).rejects.toThrow(/requires a complete reviewed deployment build record/);
      expect(calls).toEqual([]);
    }
  }
});

test.each([
  ["inline", Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)],
  ["chunked", pseudoRandomBytes(2 * 1024 * 1024)],
] as const)(
  "complete build record and exact %s Wasm transport commit in one v0.3.6 bridge journal",
  async (dispatchKind, wasm) => {
  const previous = preparePackageInstall(kernelPackageFilesAtVersion(306));
  const candidate = preparePackageInstall(
    packageBytes(withValidPackageRecord(kernelPackageFilesAtVersion(307))),
  );
  const expectedDeploymentId = "c".repeat(32);
  const compiled = { ...completeKernelCompiledFixture(candidate), wasm };
  const previousApps = {
    kernel: appRegistryEntry(previous.manifest),
  };
  const state: KernelPackageState = {
    registry: previousApps,
    apps: previousApps,
    browserSurfaceOriginAppIds: [],
    browserSurfaceOriginsSidecarPresent: false,
    existingConfigs: { kernel: previous.manifest },
    existingModules: [],
    previousStable: "previous stable signature\n",
    connectionProviderSupport: connectionProviderSupportFixture,
  };
  const preparedBuild = prepareCompleteDeploymentBuildRecord({
    targetCanisterId: TEST_TARGET_CANISTER_ID,
    packages: [candidate],
    state,
    compiled,
    expectedDeploymentId,
  });
  if (!candidate.archiveIdentity) {
    throw new Error("Expected retained raw candidate archive identity");
  }
  expect(preparedBuild.record.packages[0]?.archive).toEqual({
    state: "verified",
    sha256: candidate.archiveIdentity.sha256,
    bytes: candidate.archiveIdentity.size,
  });
  expect(preparedBuild.record.packages[0]?.package_information.state).toBe(
    "verified",
  );

  const calls: string[] = [];
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });
  const stored = new Map<
    string,
    { encoding: "gzip" | "identity"; chunks: Uint8Array[] }
  >();
  let journal: InstallJournal | undefined;
  let dispatchedWasm: Uint8Array | undefined;
  const uploadedWasmChunks: Uint8Array[] = [];
  const kernelStatic = actor.kernel_static.bind(actor);
  const begin = actor.kernel_install_begin_checked.bind(actor);
  const installCode = actor.kernel_install_code.bind(actor);
  const uploadWasmChunk = actor.kernel_install_wasm_chunk.bind(actor);
  actor.kernel_static = async (request) => {
    if ("store" in request) {
      stored.set(request.store.key, {
        encoding: request.store.val.content_encoding,
        chunks: [request.store.val.content],
      });
    } else if ("store_chunk" in request) {
      stored.get(request.store_chunk.key)?.chunks.push(
        request.store_chunk.content,
      );
    }
    return kernelStatic(request);
  };
  actor.kernel_install_begin_checked = async (request) => {
    journal = request.journal;
    return begin(request);
  };
  actor.kernel_install_code = async (request) => {
    dispatchedWasm = request.wasm;
    return installCode(request);
  };
  actor.kernel_install_wasm_chunk = async (request) => {
    uploadedWasmChunks.push(request.chunk);
    return uploadWasmChunk(request);
  };

  await deployPreparedPackages({
    actor,
    targetCanisterId: TEST_TARGET_CANISTER_ID,
    packages: [candidate],
    compiled,
    existingApps: previousApps,
    existingBrowserSurfaceOriginAppIds: [],
    expectedDeploymentId,
    deploymentBuildRecord: preparedBuild.record,
  });

  expect(journal?.clear_prefixes).toEqual([]);
  const source = journal?.copies.find(
    ({ target }) => target === DEPLOYMENT_BUILD_RECORD_PATH,
  )?.source;
  expect(source).toBeDefined();
  const storedRecord = stored.get(source!);
  expect(storedRecord).toBeDefined();
  const encodedRecord = concatChunks(storedRecord!.chunks);
  const recordBytes =
    storedRecord!.encoding === "gzip"
      ? gunzipSync(encodedRecord)
      : encodedRecord;
  expect(recordBytes).toEqual(preparedBuild.recordBytes);
  expect(parseDeploymentBuildRecordJson(recordBytes)).toEqual(
    preparedBuild.record,
  );
  const exactDispatchedWasm =
    dispatchKind === "inline"
      ? dispatchedWasm
      : concatChunks(uploadedWasmChunks);
  expect(exactDispatchedWasm).toEqual(preparedBuild.transportWasm);
  expect(hashContent(exactDispatchedWasm!)).toBe(
    preparedBuild.record.wasm.transport.sha256,
  );
  },
);

test("deploy rejects supplied-archive and predecessor drift from a sealed record before I/O", async () => {
  const previous = preparePackageInstall(kernelPackageFilesAtVersion(306));
  const candidate = preparePackageInstall(
    packageBytes(withValidPackageRecord(kernelPackageFilesAtVersion(307))),
  );
  const compiled = completeKernelCompiledFixture(candidate);
  const existingApps = { kernel: appRegistryEntry(previous.manifest) };
  const preparedBuild = prepareCompleteDeploymentBuildRecord({
    targetCanisterId: TEST_TARGET_CANISTER_ID,
    packages: [candidate],
    state: {
      registry: existingApps,
      apps: existingApps,
      browserSurfaceOriginAppIds: [],
      browserSurfaceOriginsSidecarPresent: false,
      existingConfigs: { kernel: previous.manifest },
      existingModules: [],
      previousStable: "previous stable signature\n",
      connectionProviderSupport: connectionProviderSupportFixture,
    },
    compiled,
    expectedDeploymentId: "c".repeat(32),
  });
  const replacementFiles = kernelPackageFilesAtVersion(307);
  replacementFiles["web/index.html"] = bytes("<main>different archive</main>");
  const replacement = preparePackageInstall(
    packageBytes(withValidPackageRecord(replacementFiles)),
  );
  const calls: string[] = [];
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });

  await expect(
    deployPreparedPackages({
      actor,
      targetCanisterId: TEST_TARGET_CANISTER_ID,
      packages: [replacement],
      compiled,
      existingApps,
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "c".repeat(32),
      deploymentBuildRecord: preparedBuild.record,
    }),
  ).rejects.toThrow(/package identity does not match supplied app kernel/);
  expect(calls).toEqual([]);

  const mismatchedPredecessor = {
    ...compiled,
    previousStableSignatureSha256: "e".repeat(64),
  };
  await expect(
    deployPreparedPackages({
      actor,
      targetCanisterId: TEST_TARGET_CANISTER_ID,
      packages: [candidate],
      compiled: mismatchedPredecessor,
      existingApps,
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "c".repeat(32),
      deploymentBuildRecord: preparedBuild.record,
    }),
  ).rejects.toThrow(/predecessor memory baseline does not match the compiler/);
  expect(calls).toEqual([]);
});

test("deploy rejects unsealed clones and retained-package evidence mutation before I/O", async () => {
  const previous = preparePackageInstall(kernelPackageFilesAtVersion(307));
  const candidate = preparePackageInstall(
    packageBytes(withValidPackageRecord(kernelPackageFilesAtVersion(308))),
  );
  const retained = preparePackageInstall(helloPackageFiles());
  const existingApps = {
    kernel: appRegistryEntry(previous.manifest),
    hello: appRegistryEntry(retained.manifest),
  };
  const compiledBase = compiledFixture(candidate, retained);
  const compiled: CompileResult = {
    ...compiledBase,
    browserSurfaceOriginAppIds: [],
    deploymentId: "a".repeat(32),
    deploymentNonce: "b".repeat(32),
    previousStableSignatureSha256: hashContent(
      "previous stable signature\n",
    ),
    dependencyPlan: {
      order: ["kernel", "hello"],
      dependenciesByConsumer: { kernel: [], hello: [] },
      dependentsByProvider: {},
    },
  };
  const preparedBuild = prepareCompleteDeploymentBuildRecord({
    targetCanisterId: TEST_TARGET_CANISTER_ID,
    packages: [candidate],
    state: {
      registry: existingApps,
      apps: existingApps,
      browserSurfaceOriginAppIds: [],
      browserSurfaceOriginsSidecarPresent: false,
      existingConfigs: {
        kernel: previous.manifest,
        hello: retained.manifest,
      },
      existingModules: [],
      previousStable: "previous stable signature\n",
      connectionProviderSupport: connectionProviderSupportFixture,
    },
    compiled,
    expectedDeploymentId: "c".repeat(32),
    retainedPackageEvidence: {
      hello: {
        version: retained.manifest.version,
        archive: {
          state: "outer_archive_digest_only",
          sha256: "d".repeat(64),
        },
        package_information: { state: "legacy_unavailable" },
      },
    },
  });
  const unsealedClone = structuredClone(preparedBuild.record);
  const changedRetainedEvidence = structuredClone(preparedBuild.record);
  const retainedRecord = changedRetainedEvidence.packages.find(
    ({ app_id }) => app_id === "hello",
  );
  if (retainedRecord?.archive.state !== "outer_archive_digest_only") {
    throw new Error("Expected retained outer-archive digest fixture");
  }
  (retainedRecord.archive as { sha256: string }).sha256 = "e".repeat(64);

  const calls: string[] = [];
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });
  for (const deploymentBuildRecord of [
    unsealedClone,
    changedRetainedEvidence,
  ]) {
    await expect(
      deployPreparedPackages({
        actor,
        targetCanisterId: TEST_TARGET_CANISTER_ID,
        packages: [candidate],
        compiled,
        existingApps,
        existingBrowserSurfaceOriginAppIds: [],
        expectedDeploymentId: "c".repeat(32),
        deploymentBuildRecord,
      }),
    ).rejects.toThrow(/not the authenticated reviewed preparation result/);
    expect(calls).toEqual([]);
  }
});

test("deploy rejects Candid drift from sealed review before I/O", async () => {
  const previous = preparePackageInstall(kernelPackageFilesAtVersion(307));
  const candidate = preparePackageInstall(
    packageBytes(withValidPackageRecord(kernelPackageFilesAtVersion(308))),
  );
  const compiled = completeKernelCompiledFixture(candidate);
  const existingApps = { kernel: appRegistryEntry(previous.manifest) };
  const preparedBuild = prepareCompleteDeploymentBuildRecord({
    targetCanisterId: TEST_TARGET_CANISTER_ID,
    packages: [candidate],
    state: {
      registry: existingApps,
      apps: existingApps,
      browserSurfaceOriginAppIds: [],
      browserSurfaceOriginsSidecarPresent: false,
      existingConfigs: { kernel: previous.manifest },
      existingModules: [],
      previousStable: "previous stable signature\n",
      connectionProviderSupport: connectionProviderSupportFixture,
    },
    compiled,
    expectedDeploymentId: "c".repeat(32),
  });
  compiled.candid = `${compiled.candid}\n`;
  const calls: string[] = [];
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });

  await expect(
    deployPreparedPackages({
      actor,
      targetCanisterId: TEST_TARGET_CANISTER_ID,
      packages: [candidate],
      compiled,
      existingApps,
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "c".repeat(32),
      deploymentBuildRecord: preparedBuild.record,
    }),
  ).rejects.toThrow(/Candid changed after deployment review/);
  expect(calls).toEqual([]);
});

test("deploy rejects stable-signature drift from sealed review before I/O", async () => {
  const previous = preparePackageInstall(kernelPackageFilesAtVersion(307));
  const candidate = preparePackageInstall(
    packageBytes(withValidPackageRecord(kernelPackageFilesAtVersion(308))),
  );
  const compiled = completeKernelCompiledFixture(candidate);
  const existingApps = { kernel: appRegistryEntry(previous.manifest) };
  const preparedBuild = prepareCompleteDeploymentBuildRecord({
    targetCanisterId: TEST_TARGET_CANISTER_ID,
    packages: [candidate],
    state: {
      registry: existingApps,
      apps: existingApps,
      browserSurfaceOriginAppIds: [],
      browserSurfaceOriginsSidecarPresent: false,
      existingConfigs: { kernel: previous.manifest },
      existingModules: [],
      previousStable: "previous stable signature\n",
      connectionProviderSupport: connectionProviderSupportFixture,
    },
    compiled,
    expectedDeploymentId: "c".repeat(32),
  });
  compiled.stable = `${compiled.stable}// changed after review\n`;
  const calls: string[] = [];
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });

  await expect(
    deployPreparedPackages({
      actor,
      targetCanisterId: TEST_TARGET_CANISTER_ID,
      packages: [candidate],
      compiled,
      existingApps,
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "c".repeat(32),
      deploymentBuildRecord: preparedBuild.record,
    }),
  ).rejects.toThrow(/stable signature changed after deployment review/);
  expect(calls).toEqual([]);
});

test("retained package evidence is bound to runtime context and package version", () => {
  const previous = preparePackageInstall(kernelPackageFilesAtVersion(306));
  const candidate = preparePackageInstall(
    packageBytes(withValidPackageRecord(kernelPackageFilesAtVersion(307))),
  );
  const compiled = completeKernelCompiledFixture(candidate);
  const previousApps = { kernel: appRegistryEntry(previous.manifest) };
  const state: KernelPackageState = {
    registry: previousApps,
    apps: previousApps,
    browserSurfaceOriginAppIds: [],
    browserSurfaceOriginsSidecarPresent: false,
    existingConfigs: { kernel: previous.manifest },
    existingModules: [],
    previousStable: "previous stable signature\n",
    connectionProviderSupport: connectionProviderSupportFixture,
  };
  const installed = prepareCompleteDeploymentBuildRecord({
    targetCanisterId: TEST_TARGET_CANISTER_ID,
    packages: [candidate],
    state,
    compiled,
    expectedDeploymentId: "c".repeat(32),
  });
  const installedApps = { kernel: appRegistryEntry(candidate.manifest) };
  expect(() =>
    retainedDeploymentPackageEvidenceFromRecord(installed.record, {
      targetCanisterId: TEST_TARGET_CANISTER_ID,
      deploymentId: "d".repeat(32),
      apps: installedApps,
    }),
  ).toThrow(/does not match the checked runtime and app registry/);

  const evidence = retainedDeploymentPackageEvidenceFromRecord(
    installed.record,
    {
      targetCanisterId: TEST_TARGET_CANISTER_ID,
      deploymentId: compiled.deploymentId,
      apps: installedApps,
    },
  );
  expect(evidence.kernel?.version).toBe(307);
  const retainedCompile = {
    ...completeKernelCompiledFixture(candidate),
    deploymentId: "d".repeat(32),
    deploymentNonce: "e".repeat(32),
  };
  expect(() =>
    prepareCompleteDeploymentBuildRecord({
      targetCanisterId: TEST_TARGET_CANISTER_ID,
      packages: [],
      state: {
        ...state,
        registry: installedApps,
        apps: installedApps,
        existingConfigs: { kernel: candidate.manifest },
      },
      compiled: retainedCompile,
      expectedDeploymentId: compiled.deploymentId,
      retainedPackageEvidence: {
        kernel: { ...evidence.kernel!, version: 306 },
      },
    }),
  ).toThrow(/evidence for kernel is version 306, expected 307/);
});

test("a package-recordful to package-recordless Kernel replacement clears stale legal assets", async () => {
  // The predecessor's contents do not need to be read: every Kernel
  // replacement after the bridge clears its legal subtree transactionally.
  const journal = await captureKernelReplacementJournal(
    kernelPackageFilesAtVersion(308),
    307,
  );

  expect(journal.clear_prefixes).toEqual([
    "/pkg/legal/",
    DEPLOYMENT_BUILD_RECORD_PATH,
  ]);
  expect(
    journal.copies
      .map(({ target }) => target)
      .filter((target) => target.startsWith("/pkg/legal/")),
  ).toEqual([]);
});

test("a package-recordful to package-recordful Kernel replacement clears then copies the new legal set", async () => {
  const journal = await captureKernelReplacementJournal(
    withValidPackageRecord(kernelPackageFilesAtVersion(308)),
    307,
  );

  expect(journal.clear_prefixes).toEqual([
    "/pkg/legal/",
    DEPLOYMENT_BUILD_RECORD_PATH,
  ]);
  expect(
    journal.copies
      .map(({ target }) => target)
      .filter((target) => target.startsWith("/pkg/legal/"))
      .sort(compareCanonicalText),
  ).toEqual([
    "/pkg/legal/APPLICATION-NOTICE.txt",
    "/pkg/legal/LICENSE.example.txt",
    "/pkg/legal/package-record.v1.json",
  ]);
});

test("deploy keeps kernel-package Candid compatibility while committing compiled Candid", async () => {
  const files = kernelPackageFiles();
  files["neutron.did"] = bytes("service : { stale : () -> () }");
  const prepared = preparePackageInstall(files);
  const calls: string[] = [];
  const compiled = compiledFixture(prepared);
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });
  let targets: string[] = [];
  const begin = actor.kernel_install_begin_checked.bind(actor);
  actor.kernel_install_begin_checked = async (request) => {
    targets = request.journal.copies.map(({ target }) => target);
    return begin(request);
  };

  await deployPreparedPackages({
    actor,
    targetCanisterId: TEST_TARGET_CANISTER_ID,
    packages: [prepared],
    compiled,
    existingApps: {},
    existingBrowserSurfaceOriginAppIds: [],
    expectedDeploymentId: "old-deployment",
  });

  expect(
    targets.filter((target) => target === "/pkg/neutron.did"),
  ).toHaveLength(1);
});

test("deploy does not globally delete modules after releasing its journal", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const calls: string[] = [];
  const compiled = compiledFixture(prepared);
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
    staticPaths: [
      `/mo/${compiled.modulePaths[0]}`,
      "/mo/orphan.mo",
      "/motoko/moc.wasm.js",
      "/motoko/moc_wasm.bc.wasm.assets/code.wasm",
    ],
  });

  await deployPreparedPackages({
    actor,
    packages: [prepared],
    compiled,
    existingApps: {},
    existingBrowserSurfaceOriginAppIds: [],
    expectedDeploymentId: "old-deployment",
  });

  expect(calls).not.toContain("query:/mo/");
  expect(calls).not.toContain("delete:/mo/orphan.mo");
  expect(calls).not.toContain("delete:/motoko/moc.wasm.js");
  expect(calls).not.toContain(
    "delete:/motoko/moc_wasm.bc.wasm.assets/code.wasm",
  );
  expect(calls.filter((call) => call === "commit")).toHaveLength(1);
  expect(calls).not.toContain("abort");
});

test("deploy stages only obsolete baseline modules for atomic commit cleanup", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const calls: string[] = [];
  const compiled = compiledFixture(prepared);
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });
  const retired = `${"a".repeat(64)}.mo`;
  const retained = compiled.modulePaths[0]!;
  const cleanupKey = `/system/staging/${compiled.deploymentId}/module-gc`;
  let cleanupContent: Uint8Array | undefined;
  let journal: InstallJournal | undefined;
  const kernelStatic = actor.kernel_static.bind(actor);
  const kernelInstallBegin = actor.kernel_install_begin_checked.bind(actor);
  actor.kernel_static = async (request) => {
    if ("store" in request && request.store.key === cleanupKey) {
      expect(request.store.val.content_encoding).toBe("identity");
      expect(request.store.val.chunks).toBe(1);
      cleanupContent = request.store.val.content;
    }
    return kernelStatic(request);
  };
  actor.kernel_install_begin_checked = async (request) => {
    journal = request.journal;
    return kernelInstallBegin(request);
  };

  await deployPreparedPackages({
    actor,
    packages: [prepared],
    compiled,
    existingApps: {},
    existingBrowserSurfaceOriginAppIds: [],
    expectedDeploymentId: "old-deployment",
    previousModulePaths: [retired, retained, retired],
  });

  expect(text(cleanupContent!)).toBe(`${retired}\n`);
  expect(calls).toContain(`store:${cleanupKey}`);
  expect(journal?.copies.some(({ source }) => source === cleanupKey)).toBe(
    false,
  );
  expect(calls).not.toContain(`delete:/mo/${retired}`);
  expect(calls.filter((call) => call === "commit")).toHaveLength(1);
});

test("deploy rejects invalid baseline module cleanup paths before upload", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const calls: string[] = [];
  const compiled = compiledFixture(prepared);
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });

  await expect(
    deployPreparedPackages({
      actor,
      packages: [prepared],
      compiled,
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "old-deployment",
      previousModulePaths: ["not-content-addressed.mo"],
    }),
  ).rejects.toThrow("Invalid previous Motoko module path");

  expect(calls).toEqual([]);
});

test("deploy rejects crafted stable retirement metadata before any IO", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const calls: string[] = [];
  const compiled = compiledFixture(prepared);
  compiled.migrationPlan = {
    removedApps: [prepared.manifest.id],
    destructiveMemoryRoots: [
      { owner: prepared.manifest.id, memoryId: "hello_state" },
    ],
    upgrades: [
      {
        kind: "retire",
        reason: "app-uninstall",
        owner: prepared.manifest.id,
        memoryId: "hello_state",
        from: 1,
        oldSchemaEntry: "a".repeat(64),
      },
    ],
  };
  compiled.managedMemoryRetirements = [
    {
      memoryId: "hello_state",
      owner: prepared.manifest.id,
      version: 1,
      schemaEntry: "a".repeat(64),
    },
  ];
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });

  await expect(
    deployPreparedPackages({
      actor,
      packages: [prepared],
      compiled,
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "old-deployment",
    }),
  ).rejects.toThrow(/retirement metadata does not match/);

  expect(calls).toEqual([]);
});

test("deploy rejects crafted declared retirement metadata before any IO", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const calls: string[] = [];
  const compiled = compiledFixture(prepared);
  const retirement = {
    memoryId: "hello_state",
    owner: prepared.manifest.id,
    version: 1,
    schemaEntry: "a".repeat(64),
  };
  compiled.migrationPlan = {
    removedApps: [prepared.manifest.id],
    destructiveMemoryRoots: [
      { owner: retirement.owner, memoryId: retirement.memoryId },
    ],
    upgrades: [
      {
        kind: "retire",
        reason: "app-uninstall",
        owner: retirement.owner,
        memoryId: retirement.memoryId,
        from: retirement.version,
        oldSchemaEntry: retirement.schemaEntry,
      },
    ],
  };
  compiled.stable = writeManagedMemoryRetirements(
    "stable signature",
    [retirement],
  );
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });

  await expect(
    deployPreparedPackages({
      actor,
      packages: [prepared],
      compiled,
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "old-deployment",
    }),
  ).rejects.toThrow(/retirement metadata does not match/);

  expect(calls).toEqual([]);
});

test("failed actor activation aborts staging without changing active metadata", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const calls: string[] = [];
  const compiled = compiledFixture(prepared);
  const actor = journalActor({
    calls,
    deploymentId: "old00000000000000000000000000000",
    installFails: true,
  });

  await expect(
    deployPreparedPackages({
      actor,
      packages: [prepared],
      compiled,
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "old-deployment",
      verifyTimeoutMs: 1,
    }),
  ).rejects.toThrow(/Timed out waiting for deployment/);

  expect(calls).toContain("abort");
  expect(calls).not.toContain("commit");
  expect(calls).not.toContain("store:/system/apps.json");
});

test("a trapped migration leaves one two-app journal recovery without a partial commit", async () => {
  const hello = preparePackageInstall(helloPackageFiles());
  const otherFiles = helloPackageFiles();
  const otherManifest = JSON.parse(text(otherFiles["neutron.json"]!));
  otherFiles["neutron.json"] = bytes(
    JSON.stringify({ ...otherManifest, id: "other_app", name: "Other" }),
  );
  const other = preparePackageInstall(otherFiles);
  const calls: string[] = [];
  const compiled = compiledFixture(hello, other);
  const actor = journalActor({
    calls,
    deploymentId: "old00000000000000000000000000000",
    compiled,
    installError: new Error("managed memory migration trapped"),
  });
  actor.kernel_install_abort = async () => {
    calls.push("abort");
    throw new Error("management status is temporarily unavailable");
  };

  await expect(
    deployPreparedPackages({
      actor,
      packages: [hello, other],
      compiled,
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "old-deployment",
      verifyTimeoutMs: 1,
    }),
  ).rejects.toThrow(/managed memory migration trapped/);

  expect(calls.filter((call) => call === "begin")).toHaveLength(1);
  expect(calls.filter((call) => call === "install")).toHaveLength(1);
  expect(calls).not.toContain("commit");
  expect(calls).not.toContain("store:/system/apps.json");
  await expect(recoverPendingInstall(actor, { timeoutMs: 1 })).resolves.toEqual({
    status: "pending",
    deploymentId: compiled.deploymentId,
  });
  const rawStatus = await actor.kernel_install_status(null);
  const pending = rawStatus[0];
  expect(
    pending?.target_app_instances.map(({ scope }) => scope.app_id).sort(),
  ).toEqual(["hello", "other_app"]);
});

test("runtime verification timeout retains the install dispatch error", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const calls: string[] = [];
  const compiled = compiledFixture(prepared);
  const dispatchError = new Error("ingress message rejected");
  const actor = journalActor({
    calls,
    deploymentId: "old00000000000000000000000000000",
    installError: dispatchError,
  });

  let failure: unknown;
  try {
    await deployPreparedPackages({
      actor,
      packages: [prepared],
      compiled,
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "old-deployment",
      verifyTimeoutMs: 1,
    });
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(
    "install dispatch failed: ingress message rejected",
  );
  expect((failure as Error).cause).toBe(dispatchError);
  expect(calls).toContain("abort");
});

test("deploy observer failures do not alter activation", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const calls: string[] = [];
  const compiled = compiledFixture(prepared);
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await deployPreparedPackages({
      actor,
      packages: [prepared],
      compiled,
      existingApps: {},
      existingBrowserSurfaceOriginAppIds: [],
      expectedDeploymentId: "old-deployment",
      onStep() {
        throw new Error("observer failed");
      },
      onProgress() {
        throw new Error("observer failed");
      },
    });
    expect(result.apps.hello?.name).toBe("Hello");
    expect(calls).toContain("commit");
  } finally {
    console.warn = originalWarn;
  }
});

test("pending journal recovery commits the active target but never aborts an old runtime", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const compiled = compiledFixture(prepared);
  const targetCalls: string[] = [];
  const target = journalActor({
    calls: targetCalls,
    deploymentId: "deploy00000000000000000000000000",
    compiled,
  });
  await target.kernel_install_begin_checked({
    expected_deployment_id: "old-deployment",
    journal: {
      deployment_id: "deploy00000000000000000000000000",
      copies: [],
      clear_prefixes: [],
      target_app_inventory: runtimeAppInventory(compiled),
    },
  });
  await expect(
    recoverPendingInstall(target, { timeoutMs: 1 }),
  ).resolves.toEqual({
    status: "committed",
    deploymentId: "deploy00000000000000000000000000",
  });

  const oldCalls: string[] = [];
  const old = journalActor({
    calls: oldCalls,
    deploymentId: "old00000000000000000000000000000",
    compiled,
  });
  await old.kernel_install_begin_checked({
    expected_deployment_id: "old-deployment",
    journal: {
      deployment_id: "deploy00000000000000000000000000",
      copies: [],
      clear_prefixes: [],
      target_app_inventory: runtimeAppInventory(compiled),
    },
  });
  await expect(recoverPendingInstall(old, { timeoutMs: 1 })).resolves.toEqual({
    status: "pending",
    deploymentId: "deploy00000000000000000000000000",
  });
  expect(oldCalls).not.toContain("abort");
});

test.each([null, { deployment_id: "deploy-predecessor" }])(
  "pending journal recovery rejects predecessor opt shape %#",
  async (status) => {
    const actor = journalActor({
      calls: [],
      deploymentId: "old00000000000000000000000000000",
    });
    actor.kernel_install_status = async () => status as never;

    await expect(
      recoverPendingInstall(actor, { timeoutMs: 1 }),
    ).rejects.toThrow("Invalid install journal status response");
  },
);

test("pending journal recovery retains an active target when commit fails", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const compiled = compiledFixture(prepared);
  const calls: string[] = [];
  const deploymentId = "deploy00000000000000000000000000";
  const actor = journalActor({ calls, deploymentId, compiled });
  await actor.kernel_install_begin_checked({
    expected_deployment_id: "old-deployment",
    journal: {
      deployment_id: deploymentId,
      copies: [],
      clear_prefixes: [],
      target_app_inventory: runtimeAppInventory(compiled),
    },
  });
  actor.kernel_install_commit = async () => {
    calls.push("commit");
    throw new Error("commit response failed");
  };

  await expect(recoverPendingInstall(actor, { timeoutMs: 1 })).resolves.toEqual(
    { status: "pending", deploymentId },
  );
  expect(calls).not.toContain("abort");
});

test("pending journal recovery reports a blocked current commit as pending", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const compiled = compiledFixture(prepared);
  const calls: string[] = [];
  const deploymentId = "deploy00000000000000000000000000";
  const actor = journalActor({ calls, deploymentId, compiled });
  await actor.kernel_install_begin_checked({
    expected_deployment_id: "old-deployment",
    journal: {
      deployment_id: deploymentId,
      copies: [],
      clear_prefixes: [],
      target_app_inventory: runtimeAppInventory(compiled),
    },
  });
  actor.kernel_install_commit = async () => {
    calls.push("commit");
    return { blocked: null };
  };

  await expect(recoverPendingInstall(actor, { timeoutMs: 1 })).resolves.toEqual(
    { status: "pending", deploymentId },
  );
  expect(calls.filter((call) => call === "commit")).toHaveLength(1);
  expect(calls).not.toContain("abort");
});

test("v26 recovery commits only an exact active v25 journal target", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const compiled = compiledFixture(prepared);
  const deploymentId = "deploy00000000000000000000000000";

  const exactCalls: string[] = [];
  const exact = journalActor({
    calls: exactCalls,
    deploymentId,
    compiled,
  });
  await exact.kernel_install_begin_checked({
    expected_deployment_id: "old-deployment",
    journal: {
      deployment_id: deploymentId,
      copies: [],
      clear_prefixes: [],
      target_app_inventory: runtimeAppInventory(compiled),
    },
  });
  const exactRuntimeInfo = exact.kernel_runtime_info.bind(exact);
  exact.kernel_runtime_info = async () => ({
    ...(await exactRuntimeInfo()),
    assembler_id: "neutron_actor_v25",
  });

  await expect(recoverPendingInstall(exact, { timeoutMs: 1 })).resolves.toEqual(
    { status: "committed", deploymentId },
  );
  expect(exactCalls).toContain("commit");

  const mismatchCalls: string[] = [];
  const mismatch = journalActor({
    calls: mismatchCalls,
    deploymentId,
    compiled,
  });
  await mismatch.kernel_install_begin_checked({
    expected_deployment_id: "old-deployment",
    journal: {
      deployment_id: deploymentId,
      copies: [],
      clear_prefixes: [],
      target_app_inventory: runtimeAppInventory(compiled),
    },
  });
  const mismatchRuntimeInfo = mismatch.kernel_runtime_info.bind(mismatch);
  mismatch.kernel_runtime_info = async () => {
    const runtime = await mismatchRuntimeInfo();
    return {
      ...runtime,
      assembler_id: "neutron_actor_v25",
      apps: runtime.apps.map((app, index) =>
        index === 0
          ? { ...app, browser_origin_authority_epoch: 99n }
          : app,
      ),
    };
  };

  await expect(
    recoverPendingInstall(mismatch, { timeoutMs: 1 }),
  ).resolves.toEqual({ status: "pending", deploymentId });
  expect(mismatchCalls).not.toContain("commit");
  expect(mismatchCalls).not.toContain("abort");
});

test("pending journal recovery does not commit a stale assembler generation", async () => {
  const prepared = preparePackageInstall(helloPackageFiles());
  const compiled = compiledFixture(prepared);
  const calls: string[] = [];
  const deploymentId = "deploy00000000000000000000000000";
  const actor = journalActor({ calls, deploymentId, compiled });
  await actor.kernel_install_begin_checked({
    expected_deployment_id: "old-deployment",
    journal: {
      deployment_id: deploymentId,
      copies: [],
      clear_prefixes: [],
      target_app_inventory: runtimeAppInventory(compiled),
    },
  });
  const runtimeInfo = actor.kernel_runtime_info.bind(actor);
  actor.kernel_runtime_info = async () => ({
    ...(await runtimeInfo()),
    assembler_id: "neutron_actor_v5",
  });

  await expect(recoverPendingInstall(actor, { timeoutMs: 1 })).resolves.toEqual(
    { status: "pending", deploymentId },
  );
  expect(calls).not.toContain("commit");
  expect(calls).not.toContain("abort");
});

function compiledFixture(...packages: PreparedPackageInstall[]): CompileResult {
  const capabilityPlans = Object.fromEntries(
    packages.map((prepared) => [
      prepared.manifest.id,
      {
        plan: prepared.capabilityPlan,
        fingerprint: prepared.capabilityPlanFingerprint,
      },
    ]),
  );
  return {
    wasm: Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0),
    candid: `
type InstallCommitInput = record { deployment_id : text };
type InstallCommitResult = variant { blocked; committed; };
type InstallKernel = service {
  kernel_install_commit : (InstallCommitInput) -> (InstallCommitResult);
};
service : () -> InstallKernel
`,
    stable:
      "stable signature\n// @neutron-managed-memory-retirements-v2 []\n",
    diagnostics: [],
    compatibilityDiagnostics: [],
    danger: {},
    dependencyPlan: {
      order: [],
      dependenciesByConsumer: {},
      dependentsByProvider: {},
    },
    migrationPlan: {
      upgrades: [],
      removedApps: [],
      destructiveMemoryRoots: [],
    },
    managedMemoryRetirements: [],
    previousManagedMemoryInventory: [],
    managedMemoryInventory: [],
    previousStableSignatureSha256: null,
    browserSurfaceOriginAppIds: packages
      .filter(({ isKernel }) => !isKernel)
      .map(({ manifest }) => manifest.id)
      .sort(compareCanonicalText),
    capabilityPlans,
    appInstanceInventory: Object.entries(capabilityPlans)
      .map(([app_id, capability]) => ({
        app_id,
        version: capability.plan.app.version,
        capability_plan_fingerprint: capability.fingerprint,
        resident_frame_security: "credentialless_opaque_v1" as const,
      }))
      .sort((left, right) =>
        left.app_id < right.app_id ? -1 : left.app_id > right.app_id ? 1 : 0,
      ),
    deploymentId: "deploy00000000000000000000000000",
    deploymentNonce: null,
    vetKeysEnvironment: "production",
    persistenceMode: "classical",
    compilerId: "moc_test",
    assemblerId: ASSEMBLER_ID,
    modulePaths: [
      ...new Set(packages.map(({ manifest }) => `${manifest.entry}.mo`)),
    ],
  };
}

function completeKernelCompiledFixture(
  prepared: PreparedPackageInstall,
): CompileResult {
  const compiled = compiledFixture(prepared);
  return {
    ...compiled,
    deploymentId: "a".repeat(32),
    deploymentNonce: "b".repeat(32),
    vetKeysEnvironment: "production",
    previousStableSignatureSha256: hashContent(
      "previous stable signature\n",
    ),
    dependencyPlan: {
      order: ["kernel"],
      dependenciesByConsumer: { kernel: [] },
      dependentsByProvider: {},
    },
  };
}

async function captureKernelReplacementJournal(
  files: UnpackedNeutronPackage,
  existingKernelVersion: number,
): Promise<InstallJournal> {
  const prepared = preparePackageInstall(files);
  const calls: string[] = [];
  const compiled =
    existingKernelVersion >= 307
      ? completeKernelCompiledFixture(prepared)
      : compiledFixture(prepared);
  const actor = journalActor({
    calls,
    deploymentId: compiled.deploymentId,
    compiled,
  });
  let captured: InstallJournal | undefined;
  const begin = actor.kernel_install_begin_checked.bind(actor);
  actor.kernel_install_begin_checked = async (request) => {
    captured = request.journal;
    return begin(request);
  };
  const previousManifest = {
    ...prepared.manifest,
    version: existingKernelVersion,
  };
  const existingApps = {
    kernel: appRegistryEntry(previousManifest),
  };
  const expectedDeploymentId =
    existingKernelVersion >= 307 ? "c".repeat(32) : "old-deployment";
  const deploymentBuildRecord =
    existingKernelVersion >= 307
      ? prepareCompleteDeploymentBuildRecord({
          targetCanisterId: TEST_TARGET_CANISTER_ID,
          packages: [prepared],
          state: {
            registry: existingApps,
            apps: existingApps,
            browserSurfaceOriginAppIds: [],
            browserSurfaceOriginsSidecarPresent: false,
            existingConfigs: { kernel: previousManifest },
            existingModules: [],
            previousStable: "previous stable signature\n",
            connectionProviderSupport: connectionProviderSupportFixture,
          },
          compiled,
          expectedDeploymentId,
        }).record
      : undefined;
  await deployPreparedPackages({
    actor,
    targetCanisterId: TEST_TARGET_CANISTER_ID,
    packages: [prepared],
    compiled,
    existingApps,
    existingBrowserSurfaceOriginAppIds: [],
    expectedDeploymentId,
    ...(deploymentBuildRecord ? { deploymentBuildRecord } : {}),
  });
  if (captured === undefined) throw new Error("Install journal was not recorded");
  return captured;
}

function journalActor({
  calls,
  deploymentId,
  installFails = false,
  installError,
  staticPaths = [],
  compiled,
}: {
  calls: string[];
  deploymentId: string;
  installFails?: boolean;
  installError?: unknown;
  staticPaths?: string[];
  compiled?: CompileResult;
}): KernelPackageInstaller {
  let journal: InstallJournal | null = null;
  let checkedBeginFingerprint: string | null = null;
  return {
    async kernel_static(req) {
      if ("store" in req) calls.push(`store:${req.store.key}`);
      if ("delete" in req) calls.push(`delete:${req.delete.key}`);
      if ("clear" in req) calls.push(`clear:${req.clear.prefix}`);
    },
    async kernel_static_query(req) {
      calls.push(`query:${req.list.prefix}`);
      return staticPaths.filter((path) => path.startsWith(req.list.prefix));
    },
    async kernel_install_begin_checked(input) {
      calls.push("begin");
      const fingerprint = JSON.stringify(input);
      if (journal !== null) {
        if (fingerprint === checkedBeginFingerprint) return;
        throw new Error("A different install journal is already pending");
      }
      journal = input.journal;
      checkedBeginFingerprint = fingerprint;
    },
    async kernel_install_status() {
      return journal
        ? [
            {
              deployment_id: journal.deployment_id,
              copy_count: journal.copies.length,
              clear_count: journal.clear_prefixes.length,
              removed_apps: [],
              committed_app_instances: runtimeInstances(
                compiled,
                "old-deployment",
              ),
              target_app_instances: runtimeInstances(
                compiled,
                journal.deployment_id,
              ),
            },
          ]
        : [];
    },
    async kernel_install_reservations_prepare() {
      calls.push("prepare-reservations");
    },
    async kernel_install_code() {
      calls.push("install");
      if (installError !== undefined) throw installError;
      if (installFails) throw new Error("install failed");
    },
    async kernel_runtime_info() {
      return {
        deployment_id: deploymentId,
        assembler_id: "neutron_actor_v26",
        compiler_id: compiled?.compilerId ?? "test",
        apps: runtimeInstances(compiled, deploymentId),
        memories: [],
      };
    },
    async kernel_install_commit() {
      calls.push("commit");
      journal = null;
      checkedBeginFingerprint = null;
      return { committed: null };
    },
    async kernel_install_abort() {
      calls.push("abort");
      journal = null;
      checkedBeginFingerprint = null;
    },
    async kernel_install_wasm_chunks_clear() {
      calls.push("clear-wasm");
    },
    async kernel_install_wasm_chunk() {
      calls.push("upload-wasm");
    },
    async kernel_install_code_chunked() {
      calls.push("install-chunked");
    },
  };
}

function runtimeInstances(
  compiled: CompileResult | undefined,
  deploymentId: string,
) {
  return (compiled?.appInstanceInventory ?? []).map((entry, index) => ({
    scope: {
      app_id: entry.app_id,
      installation_uid: BigInt(index + 1),
    },
    version: entry.version,
    deployment_id: deploymentId,
    capability_plan_fingerprint: entry.capability_plan_fingerprint,
    browser_origin_nonce: (index + 1).toString(16).padStart(32, "0"),
    browser_origin_authority_epoch: BigInt(index + 1),
    resident_frame_security: candidResidentFrameSecurity(
      entry.resident_frame_security,
    ),
  }));
}

function runtimeAppInventory(compiled: CompileResult) {
  return compiled.appInstanceInventory.map((entry) => ({
    app_id: entry.app_id,
    version: entry.version,
    capability_plan_fingerprint: entry.capability_plan_fingerprint,
    resident_frame_security: candidResidentFrameSecurity(
      entry.resident_frame_security,
    ),
  }));
}

function candidResidentFrameSecurity(
  value: CompileResult["appInstanceInventory"][number]["resident_frame_security"],
) {
  if (value === "credentialless_opaque_v1") {
    return { credentialless_opaque_v1: null } as const;
  }
  if (value === "credentialless_ephemeral_dedicated_v1") {
    return { credentialless_ephemeral_dedicated_v1: null } as const;
  }
  return { persistent_dedicated_v1: null } as const;
}

function pseudoRandomBytes(size: number): Uint8Array {
  const result = new Uint8Array(size);
  let state = 0x9e3779b9;
  for (let index = 0; index < result.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    result[index] = state & 0xff;
  }
  if (result.length >= 8) {
    result.set(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
  }
  return result;
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
