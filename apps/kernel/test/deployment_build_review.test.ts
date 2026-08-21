import { describe, expect, test } from "bun:test";
import { gzipSync } from "fflate";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import msgpack from "tiny-msgpack";
import {
  DEPLOYMENT_WASM_TRANSPORT_ENCODER,
  parseDeploymentBuildRecord,
  serializeDeploymentBuildRecord,
  type CompleteDeploymentBuildRecord,
  type DeploymentPackageArchiveRecord,
  type PackageInformationRecordIdentity,
} from "neutron-compiler/src/deployment_record.js";
import {
  preparePackageInstall,
  type PreparedPackageInstall,
} from "neutron-compiler/src/install.js";
import {
  NEUTRON_APP_SOURCE_SNAPSHOT_PATH,
  NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE,
  NEUTRON_PACKAGE_RECORD_PATH,
  type NeutronPackageRecordV1,
} from "neutron-tools/package_record.js";
import { hashContent } from "neutron-tools/src/hash.js";
import { DeploymentBuildReview } from "../src/install_review/DeploymentBuildReview.tsx";
import {
  buildDeploymentReviewArtifacts,
  createDeploymentBuildReviewModel,
  downloadDeploymentReviewArtifact,
  type DeploymentBuildReviewInput,
  type DeploymentReviewArtifact,
} from "../src/install_review/deployment_build_review.ts";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const TARGET_CANISTER = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const RAW_WASM_SHA256 = "8".repeat(64);
const TRANSPORT_WASM_SHA256 = "9".repeat(64);

type PackageFixture = Readonly<{
  prepared: PreparedPackageInstall;
  archiveBytes: Uint8Array;
  packageRecord: NeutronPackageRecordV1 | undefined;
  packageRecordBytes: Uint8Array | undefined;
}>;

type PackageRecordSourceFixture =
  | Readonly<{
      kind: "status";
      status: "not-provided" | "not-required" | "unknown";
    }>
  | Readonly<{
      kind: "embedded";
      revision: string;
      path: string;
      content: Uint8Array;
    }>;

function packageFixture({
  archiveAsSubarray = false,
  archiveMarker = 7,
  dependencyProvider,
  id = "kernel",
  name = id,
  source,
  updateSource,
}: Readonly<{
  archiveAsSubarray?: boolean;
  archiveMarker?: number;
  dependencyProvider?: string;
  id?: string;
  name?: string;
  source?: PackageRecordSourceFixture;
  updateSource?: string;
}> = {}): PackageFixture {
  const version = 100;
  const moduleContent = encode(
    `module { public let reviewFixtureMarker : Nat = ${archiveMarker} }`,
  );
  const entry = hashContent(moduleContent);
  const manifest = {
    format: 3 as const,
    id,
    name,
    version,
    entry,
    ...(source?.kind === "embedded" && id !== "kernel"
      ? { package_features: [NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE] }
      : {}),
    ...(updateSource ? { update_source: updateSource } : {}),
    ...(dependencyProvider
      ? {
          dependencies: {
            system: {
              app: dependencyProvider,
              min_version: 100,
              functions: ["ping"],
            },
          },
        }
      : {}),
  };
  const manifestBytes = encode(JSON.stringify(manifest));
  const packageFiles: Record<string, Uint8Array> = {
    "neutron.json": manifestBytes,
    [`mo/${entry}.mo`]: moduleContent,
  };
  if (id === "kernel") {
    packageFiles["connection-providers.json"] = encode(
      JSON.stringify({
        schema: "neutron.connection-provider-support.v1",
        providers: [],
      }),
    );
  }
  let packageRecordBytes: Uint8Array | undefined;

  if (source) {
    const licensePath = "legal/LICENSE.txt";
    const licenseBytes = encode("Permission is granted for this fixture.\n");
    packageFiles[licensePath] = licenseBytes;
    const sourceRecord =
      source.kind === "status"
        ? source
        : {
            kind: "embedded" as const,
            revision: source.revision,
            path: source.path,
            sha256: hashContent(source.content),
            bytes: source.content.byteLength,
          };
    if (source.kind === "embedded") {
      packageFiles[source.path] = source.content;
    }
    const recordValue = {
      format: 1,
      ...(source.kind === "embedded" && id !== "kernel"
        ? { features: [NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE] }
        : {}),
      package: {
        id,
        version,
        manifest: {
          path: "neutron.json",
          sha256: hashContent(manifestBytes),
          bytes: manifestBytes.byteLength,
        },
      },
      license: {
        id: "MIT",
        texts: [
          {
            id: "MIT",
            path: licensePath,
            sha256: hashContent(licenseBytes),
            bytes: licenseBytes.byteLength,
          },
        ],
      },
      source: sourceRecord,
      dependencies: dependencyProvider
        ? [
            {
              alias: "system",
              app: dependencyProvider,
              min_version: 100,
              functions: ["ping"],
            },
          ]
        : [],
      notices: [],
      memory: null,
      build: { inputs: [], commands: [] },
    };
    packageRecordBytes = encode(JSON.stringify(recordValue));
    packageFiles[NEUTRON_PACKAGE_RECORD_PATH] = packageRecordBytes;
  }

  const encodedArchive = msgpack.encode(
    Object.fromEntries(
      Object.entries(packageFiles).map(([path, content]) => [
        path,
        gzipSync(content),
      ]),
    ),
  );
  let archiveBytes = encodedArchive;
  if (archiveAsSubarray) {
    const backing = new Uint8Array(encodedArchive.byteLength + 2);
    backing[0] = 0xaa;
    backing.set(encodedArchive, 1);
    backing[backing.byteLength - 1] = 0xbb;
    archiveBytes = backing.subarray(1, backing.byteLength - 1);
  }
  const prepared = preparePackageInstall(archiveBytes);
  return {
    prepared,
    archiveBytes,
    packageRecord: prepared.packageRecord,
    packageRecordBytes,
  };
}

type RecordPackageFixture = Readonly<{
  fixture: PackageFixture;
  archive?: DeploymentPackageArchiveRecord;
  packageInformation?: PackageInformationRecordIdentity;
}>;

function completeRecord(
  packages: readonly RecordPackageFixture[],
  options: Readonly<{
    diagnosticMessage?: string;
    diagnosticSource?: string;
  }> = {},
): CompleteDeploymentBuildRecord {
  const targetApps = packages
    .map(({ fixture }) => ({
      app_id: fixture.prepared.manifest.id,
      version: fixture.prepared.manifest.version,
      capability_plan_fingerprint:
        fixture.prepared.capabilityPlanFingerprint,
      resident_frame_security: "credentialless_opaque_v1" as const,
    }))
    .sort((left, right) => left.app_id.localeCompare(right.app_id));
  const recordPackages = packages.map(({ fixture, archive, packageInformation }) => {
    const { prepared, packageRecordBytes } = fixture;
    return {
      app_id: prepared.manifest.id,
      version: prepared.manifest.version,
      archive: archive ?? {
        state: "verified" as const,
        sha256: prepared.archiveIdentity!.sha256,
        bytes: prepared.archiveIdentity!.size,
      },
      package_information:
        packageInformation ??
        (packageRecordBytes
          ? {
              state: "verified" as const,
              sha256: hashContent(packageRecordBytes),
            }
          : { state: "not_supplied" as const }),
      dependencies: Object.entries(prepared.manifest.dependencies ?? {}).map(
        ([alias, dependency]) => {
          const provider = packages.find(
            ({ fixture: candidate }) =>
              candidate.prepared.manifest.id === dependency.app,
          );
          if (!provider) {
            throw new Error(`missing fixture provider ${dependency.app}`);
          }
          return {
            alias,
            provider_app_id: dependency.app,
            minimum_version: dependency.min_version,
            provider_version: provider.fixture.prepared.manifest.version,
            functions: dependency.functions,
          };
        },
      ),
    };
  });
  const diagnostics = options.diagnosticMessage
    ? [
        {
          source: options.diagnosticSource ?? "main.mo",
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 4 },
          },
          severity: 2,
          code: "review.warning",
          category: "review",
          message: options.diagnosticMessage,
        },
      ]
    : [];
  const parsed = parseDeploymentBuildRecord({
    format: 1,
    state: "complete",
    deployment_id: "1".repeat(32),
    previous: {
      deployment_id: null,
      stable_signature_sha256: null,
      apps: [],
      memories: [],
    },
    build: {
      compiler_id: "moc.fixture",
      assembler_id: "moassemble.fixture",
      environment: "local",
      deployment_nonce: "2".repeat(32),
      reachable_module_sha256: ["3".repeat(64)],
    },
    packages: recordPackages,
    target: { apps: targetApps, memories: [] },
    warnings: {
      diagnostics,
      compatibility_diagnostics: [],
      memory_changes: [],
      removed_apps: [],
      destructive_memory_roots: [],
    },
    installation: {
      target_canister: TARGET_CANISTER,
      mode: "install",
      argument: { sha256: "4".repeat(64), bytes: 0 },
      wasm_memory_persistence: "replace",
    },
    wasm: {
      raw: {
        sha256: RAW_WASM_SHA256,
        bytes: 1_024,
        representation: "neutron_compile_result_wasm",
        content_encoding: "identity",
      },
      transport: {
        sha256: TRANSPORT_WASM_SHA256,
        bytes: 512,
        representation: "ic_install_wasm_payload",
        content_encoding: "gzip",
        encoder: DEPLOYMENT_WASM_TRANSPORT_ENCODER,
      },
    },
  });
  if (parsed.state !== "complete") throw new Error("expected complete fixture");
  return parsed;
}

function reviewInput(
  fixtures: readonly PackageFixture[],
  record = completeRecord(fixtures.map((fixture) => ({ fixture }))),
): DeploymentBuildReviewInput {
  return {
    record,
    suppliedPackages: fixtures.map(({ prepared }) => prepared),
  };
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

describe("pre-dispatch deployment build review", () => {
  test("normal mode renders a compact result without the developer dump", () => {
    const kernel = packageFixture();
    const input = reviewInput([kernel]);
    const html = renderToStaticMarkup(
      createElement(DeploymentBuildReview, { ...input, uiMode: "normal" }),
    );

    expect(html).toContain("Deployment ready");
    expect(html).toContain("Package checks and compilation completed");
    expect(html).toContain("No data-loss or compatibility warnings");
    expect(html).not.toContain('data-tid="deployment-build-review-developer"');
    expect(html).not.toContain("Build identity");
    expect(html).not.toContain("Deployment Wasm");
    expect(html).not.toContain("Package Information Record");
    expect(html).not.toContain("Verified license declarations");
    expect(html).not.toContain("Source revision");
  });

  test("recordless unofficial input stays explicitly unknown", () => {
    const kernel = packageFixture({ name: "Unofficial Kernel" });
    const input = reviewInput([kernel]);
    const model = createDeploymentBuildReviewModel(input);

    expect(model.packages[0]?.distribution.state).toBe("manual_unofficial");
    expect(model.packages[0]?.packageInformation).toMatchObject({
      state: "not_supplied",
      sha256: null,
      details: null,
    });

    const html = renderToStaticMarkup(
      createElement(DeploymentBuildReview, { ...input, uiMode: "developer" }),
    );
    expect(html).toContain("Unofficial / manually supplied");
    expect(html).toContain("Package did not supply a record");
    expect(html).toContain("license and source are unknown");
    expect(html).not.toContain("MIT");
  });

  test("an explicit package source status is a status, never an offer", () => {
    const kernel = packageFixture({
      source: { kind: "status", status: "not-provided" },
    });
    const input = reviewInput([kernel]);
    const model = createDeploymentBuildReviewModel(input);
    const details = model.packages[0]?.packageInformation.details;

    expect(details?.record.source).toEqual({
      kind: "status",
      status: "not-provided",
    });
    const html = renderToStaticMarkup(
      createElement(DeploymentBuildReview, { ...input, uiMode: "developer" }),
    );
    expect(html).toContain("Explicit package-declared status");
    expect(html).toContain("not-provided");
    expect(html).toContain("not a source offer");
    expect(html).not.toContain("href=");
  });

  test("verified Package Information Record exposes verified license and embedded source facts", () => {
    const sourceBytes = msgpack.encode({
      format: 1,
      package: { id: "review_app", version: 100 },
      files: [
        {
          path: "apps/kernel/review-fixture.ts",
          mode: 0o644,
          content: encode("exact corresponding source\n"),
        },
      ],
    });
    const app = packageFixture({
      id: "review_app",
      name: "Review App",
      source: {
        kind: "embedded",
        revision: "fixture-release-1",
        path: NEUTRON_APP_SOURCE_SNAPSHOT_PATH,
        content: sourceBytes,
      },
    });
    const kernel = packageFixture();
    const input = reviewInput([kernel, app]);
    const model = createDeploymentBuildReviewModel(input);
    const information = model.packages.find(
      ({ appId }) => appId === "review_app",
    )?.packageInformation;

    expect(information?.state).toBe("verified");
    expect(information?.details?.origin).toBe("supplied_verified");
    expect(information?.details?.record.license.id).toBe("MIT");
    expect(information?.details?.record.source).toMatchObject({
      kind: "embedded",
      path: NEUTRON_APP_SOURCE_SNAPSHOT_PATH,
      sha256: hashContent(sourceBytes),
      bytes: sourceBytes.byteLength,
    });

    const html = renderToStaticMarkup(
      createElement(DeploymentBuildReview, { ...input, uiMode: "developer" }),
    );
    expect(html).toContain("Verified license declarations");
    expect(html).toContain("MIT (governing)");
    expect(html).toContain("Embedded source offer");
    expect(html).toContain("Embedded bytes were verified");
    expect(html).toContain(NEUTRON_APP_SOURCE_SNAPSHOT_PATH);
  });

  test("retained package details require their exact record bytes and digest", () => {
    const kernel = packageFixture({
      source: { kind: "status", status: "not-required" },
    });
    if (!kernel.packageRecord || !kernel.packageRecordBytes) {
      throw new Error("expected retained record fixture");
    }
    const record = completeRecord([{ fixture: kernel }]);
    const evidence = {
      record: kernel.packageRecord,
      recordBytes: kernel.packageRecordBytes,
      sha256: hashContent(kernel.packageRecordBytes),
    };
    const model = createDeploymentBuildReviewModel({
      record,
      suppliedPackages: [],
      retainedPackageRecords: { kernel: evidence },
    });
    expect(model.packages[0]?.packageInformation.details?.origin).toBe(
      "retained_record_verified",
    );

    expect(() =>
      createDeploymentBuildReviewModel({
        record,
        suppliedPackages: [],
        retainedPackageRecords: {
          kernel: { ...evidence, sha256: "0".repeat(64) },
        },
      }),
    ).toThrow("SHA-256 does not match");
  });

  test("multiple packages still render exactly one deployment-level Wasm", () => {
    const kernel = packageFixture();
    const base = packageFixture({ id: "base", name: "Base" });
    const hello = packageFixture({
      id: "hello",
      name: "Hello",
      dependencyProvider: "base",
      archiveMarker: 1,
    });
    const input = reviewInput([kernel, base, hello]);
    const html = renderToStaticMarkup(
      createElement(DeploymentBuildReview, { ...input, uiMode: "developer" }),
    );

    expect(html).toContain('data-tid="deployment-build-review-package-kernel"');
    expect(html).toContain('data-tid="deployment-build-review-package-hello"');
    expect(occurrences(html, 'data-tid="deployment-build-review-wasm"')).toBe(1);
    expect(occurrences(html, 'data-tid="deployment-build-review-wasm-raw"')).toBe(1);
    expect(
      occurrences(html, 'data-tid="deployment-build-review-wasm-transport"'),
    ).toBe(1);
    expect(occurrences(html, RAW_WASM_SHA256)).toBe(1);
    expect(occurrences(html, TRANSPORT_WASM_SHA256)).toBe(1);
    expect(html).toContain("minimum v0.1.0, resolved v0.1.0");
  });

  test("record-only digest and legacy archive evidence remains visible", () => {
    const kernel = packageFixture();
    const hello = packageFixture({ id: "hello", name: "Hello" });
    const record = completeRecord([
      {
        fixture: kernel,
        archive: {
          state: "outer_archive_digest_only",
          sha256: kernel.prepared.archiveIdentity!.sha256,
        },
        packageInformation: { state: "legacy_unavailable" },
      },
      {
        fixture: hello,
        archive: { state: "legacy_unavailable" },
        packageInformation: { state: "legacy_unavailable" },
      },
    ]);
    const model = createDeploymentBuildReviewModel({
      record,
      suppliedPackages: [],
    });

    expect(model.packages.map(({ archive }) => archive.recordState)).toEqual([
      "outer_archive_digest_only",
      "legacy_unavailable",
    ]);
    expect(model.packages.every(({ archive }) => archive.reconciliation === "record_only")).toBe(true);
    const html = renderToStaticMarkup(
      createElement(DeploymentBuildReview, {
        record,
        suppliedPackages: [],
        uiMode: "developer",
      }),
    );
    expect(html).toContain("outer_archive_digest_only");
    expect(html).toContain("legacy_unavailable");
    expect(html).not.toContain("Download exact kernel archive");
  });

  test("a supplied archive must exactly match a verified record entry", () => {
    const kernel = packageFixture();
    const record = completeRecord([
      {
        fixture: kernel,
        archive: {
          state: "verified",
          sha256: "f".repeat(64),
          bytes: kernel.archiveBytes.byteLength,
        },
      },
    ]);
    expect(() =>
      createDeploymentBuildReviewModel({
        record,
        suppliedPackages: [kernel.prepared],
      }),
    ).toThrow("archive SHA-256 does not match");
  });

  test("material diagnostics, memory retirements, removals, and destructive roots are not hidden", () => {
    const kernel = packageFixture();
    const base = completeRecord([{ fixture: kernel }], {
      diagnosticMessage: "review the removal",
    });
    const value = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    const target = value.target as {
      apps: Array<Record<string, unknown>>;
      memories: Array<Record<string, unknown>>;
    };
    value.previous = {
      deployment_id: "5".repeat(32),
      stable_signature_sha256: "6".repeat(64),
      apps: [
        ...target.apps,
        {
          app_id: "old_app",
          version: 100,
          capability_plan_fingerprint: "7".repeat(64),
          resident_frame_security: "credentialless_opaque_v1",
        },
      ],
      memories: [
        {
          owner: "old_app",
          id: "state",
          version: 1,
          schema: "a".repeat(64),
        },
      ],
    };
    value.warnings = {
      diagnostics: (base.warnings.diagnostics),
      compatibility_diagnostics: [
        {
          source: "old_app/main.mo",
          range: {
            start: { line: 2, character: 1 },
            end: { line: 2, character: 3 },
          },
          severity: 1,
          code: "compat.removal",
          category: "compatibility",
          message: "old app will be removed",
        },
      ],
      memory_changes: [
        {
          kind: "retire",
          reason: "app-uninstall",
          owner: "old_app",
          memory_id: "state",
          from: 1,
          old_schema_entry_sha256: "b".repeat(64),
        },
      ],
      removed_apps: ["old_app"],
      destructive_memory_roots: [{ owner: "old_app", memory_id: "state" }],
    };
    const parsed = parseDeploymentBuildRecord(value);
    if (parsed.state !== "complete") throw new Error("expected complete fixture");
    const html = renderToStaticMarkup(
      createElement(DeploymentBuildReview, {
        record: parsed,
        suppliedPackages: [kernel.prepared],
        uiMode: "developer",
      }),
    );

    expect(html).toContain("review items need attention");
    expect(html).toContain("review the removal");
    expect(html).toContain("old app will be removed");
    expect(html).toContain("old_app/state: retire v1 (app-uninstall)");
    expect(html).toContain("Removed apps");
    expect(html).toContain("Destructive memory roots");
    expect(occurrences(html, "old_app/state")).toBeGreaterThanOrEqual(2);
  });

  test("all app-authored and diagnostic text is escaped and rendering does no network I/O", () => {
    const kernel = packageFixture({
      name: "Bad App",
    });
    const record = completeRecord([{ fixture: kernel }], {
      diagnosticSource: "src/<img onerror=steal()>.mo",
      diagnosticMessage: "bad <script>steal()</script> diagnostic",
    });
    const input = reviewInput([kernel], record);
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error("review must not fetch");
    }) as unknown as typeof fetch;
    let html: string;
    try {
      createDeploymentBuildReviewModel(input);
      html = renderToStaticMarkup(
        createElement(DeploymentBuildReview, { ...input, uiMode: "developer" }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchCalls).toBe(0);
    expect(html!).toContain("&lt;img");
    expect(html!).toContain("&lt;script&gt;steal()&lt;/script&gt;");
    expect(html!).not.toContain("<img");
    expect(html!).not.toContain("<script>");
  });

  test("artifact builder preserves canonical record and exact archive bytes with stable filenames", () => {
    const kernel = packageFixture({
      archiveAsSubarray: true,
      archiveMarker: 10,
    });
    const input = reviewInput([kernel]);
    const artifacts = buildDeploymentReviewArtifacts(input);
    const recordArtifact = artifacts.find(
      (artifact) => artifact.kind === "build_record",
    );
    const archiveArtifact = artifacts.find(
      (artifact) => artifact.kind === "package_archive",
    );

    expect(recordArtifact?.filename).toBe("neutron-deployment-build-record.json");
    expect(recordArtifact?.bytes).toEqual(
      serializeDeploymentBuildRecord(input.record),
    );
    expect(archiveArtifact?.filename).toBe("kernel.v0.1.0.neutron");
    expect(kernel.archiveBytes.byteOffset).toBe(1);
    expect(kernel.archiveBytes.buffer.byteLength).toBe(
      kernel.archiveBytes.byteLength + 2,
    );
    expect(archiveArtifact?.bytes).toEqual(kernel.archiveBytes);
    expect(archiveArtifact?.bytes.buffer.byteLength).toBe(
      kernel.archiveBytes.byteLength,
    );
    expect(archiveArtifact?.bytes).not.toBe(kernel.archiveBytes);
  });

  test("exports detect mutation both before artifact build and before download", () => {
    const kernel = packageFixture({ archiveMarker: 4 });
    const input = reviewInput([kernel]);
    createDeploymentBuildReviewModel(input);
    const originalFirstByte = kernel.archiveBytes[0]!;
    kernel.archiveBytes[0] = 99;
    expect(() => buildDeploymentReviewArtifacts(input)).toThrow(
      "does not match reviewed",
    );
    kernel.archiveBytes[0] = originalFirstByte;

    const artifact = buildDeploymentReviewArtifacts(input).find(
      (candidate): candidate is Extract<
        DeploymentReviewArtifact,
        { kind: "package_archive" }
      > => candidate.kind === "package_archive",
    );
    if (!artifact) throw new Error("missing archive artifact");
    artifact.bytes[0] = 77;
    let createCalls = 0;
    expect(() =>
      downloadDeploymentReviewArtifact(artifact, {
        createObjectUrl() {
          createCalls += 1;
          return "blob:fixture";
        },
        triggerDownload() {},
        revokeObjectUrl() {},
      }),
    ).toThrow("changed after review export");
    expect(createCalls).toBe(0);
  });

  test("download helper triggers and always revokes the reviewed artifact URL", () => {
    const kernel = packageFixture();
    const artifact = buildDeploymentReviewArtifacts(reviewInput([kernel]))[0];
    if (!artifact) throw new Error("missing build record artifact");
    const calls: string[] = [];
    downloadDeploymentReviewArtifact(artifact, {
      createObjectUrl(bytes, mediaType) {
        calls.push(`create:${bytes.byteLength}:${mediaType}`);
        return "blob:review";
      },
      triggerDownload(objectUrl, filename) {
        calls.push(`download:${objectUrl}:${filename}`);
      },
      revokeObjectUrl(objectUrl) {
        calls.push(`revoke:${objectUrl}`);
      },
    });
    expect(calls).toEqual([
      `create:${artifact.bytes.byteLength}:application/json;charset=utf-8`,
      "download:blob:review:neutron-deployment-build-record.json",
      "revoke:blob:review",
    ]);

    const failedCalls: string[] = [];
    expect(() =>
      downloadDeploymentReviewArtifact(artifact, {
        createObjectUrl() {
          failedCalls.push("create");
          return "blob:failed";
        },
        triggerDownload() {
          failedCalls.push("download");
          throw new Error("blocked");
        },
        revokeObjectUrl() {
          failedCalls.push("revoke");
        },
      }),
    ).toThrow("blocked");
    expect(failedCalls).toEqual(["create", "download", "revoke"]);
  });
});
