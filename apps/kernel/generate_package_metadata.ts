import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { compareCanonicalText } from "neutron-tools/src/canonical.js";
import { hashContent } from "neutron-tools/src/hash.js";
import {
  NEUTRON_PACKAGE_RECORD_PATH,
  neutronAppSourceHttpsUrl,
  parseNeutronPackageRecord,
  type NeutronPackageRecordV1,
} from "neutron-tools/package_record.js";
import { canisterOrigin } from "neutron-tools/src/runtime.js";
import {
  normalizeManifestDependencies,
  type PackagedNeutronManifest,
} from "neutron-tools/src/schema.js";
import { assertAppVersion } from "neutron-tools/src/version.js";
import {
  ORDINARY_APP_SOURCE_LIMITS,
  createNeutronPackageSourceArtifact,
  encodeNeutronPackageSourceSnapshot,
  normalizePackageThirdPartyNoticeBundle,
  replacePackageDistLegalDirectory,
  retainNeutronPackageSourceArtifact,
  type NeutronPackageSourceArtifact,
} from "neutron-scripts/src/package_metadata.ts";
import {
  buildThirdPartyNoticeBundle,
  type AuditedNpmOwnerLicenseDecision,
  type ThirdPartyNoticeBundle,
} from "neutron-scripts/src/third_party_notices.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const execFile = promisify(execFileCallback);
const MIB = 1024 * 1024;

/** This generator is release-specific and must not silently label later bytes. */
export const KERNEL_NPL_RELEASE_VERSION = 317;
export const KERNEL_NPL_LICENSE_ID =
  "LicenseRef-Neutron-Public-License-1.0";
export const KERNEL_NPL_LICENSE_SHA256 =
  "8295489ea3ba02b704c3e7c39a85c16a2a00369bb16efbdec12e43a1f41e7c91";
export const KERNEL_RELEASE_MEMORY_LOCK_SHA256 =
  "0cc3f918b360f3d2f35d0622870e4c02fed414fe9d2638ae5bcbb229782ecd3d";
export const KERNEL_NPL_LICENSE_PATH = "legal/LICENSE.NPL-1.0.txt";
export const KERNEL_APPLICATION_NOTICE_PATH =
  "legal/APPLICATION-NOTICE.txt";
export const KERNEL_ESBUILD_META_PATH = "meta.json";
const KERNEL_WORKSPACE_SOURCE_MAX_FILES = 4_096;
const KERNEL_WORKSPACE_SOURCE_MAX_FILE_BYTES = 8 * MIB;
const KERNEL_WORKSPACE_SOURCE_MAX_TOTAL_BYTES = 32 * MIB;
const KERNEL_DIST_MAX_FILES = 4_096;
const KERNEL_DIST_MAX_FILE_BYTES = 16 * MIB;
const KERNEL_DIST_MAX_TOTAL_BYTES = 64 * MIB;
const KERNEL_PRODUCTION_UPDATE_SOURCE = "233tv-xiaaa-aaaay-aacta-cai";
const KERNEL_RELEASE_INIT_ARGS = Object.freeze([
  "memory_kernel",
  "memory_kernel_activation",
  "deployment_id",
  "active_app_instance_inventory",
  "canister_principal",
]);
const KERNEL_RELEASE_SOURCE_MANIFEST_KEYS = Object.freeze([
  "format",
  "func",
  "id",
  "init_arg",
  "memory",
  "name",
  "src",
  "update_source",
  "version",
]);
const KERNEL_MEMORY_SCHEMA_BINDINGS = Object.freeze({
  kernel: Object.freeze({
    version: 3,
    schema: "3",
    hash: "50d5dcda32504525875af20f38d3fcb46e61f3e1413f8b99fd7ce8163c0f3477",
    entry: "bac62a48a7c70cc09cc6e8200784f306db044f5c055cf2a61b3f16f42babce5b",
  }),
  kernel_activation: Object.freeze({
    version: 1,
    schema: "1",
    hash: "f73560cae883ddc894cc4ad8e474aaea0cb4d7f64a017d9fd72e391306e88d9b",
    entry: "f2380721e6147d0f0af208a70183e3d8ce6ac19ad533e1367b3f5780305e7ad3",
  }),
});
const KERNEL_RELEASED_SCHEMA_SOURCE_SHA256 = Object.freeze({
  "apps/kernel/backend/memory/activation/v1.mo":
    "828b20f8bfdf7b516774ef720eee1514bf917ce7e785917b0a1a62b775a1a1b6",
  "apps/kernel/backend/memory/kernel/v3.mo":
    "1a588ddddaef0c4f1bdcd4f11459e0c9b351e46481ffb81fcaab7eb4ecbfc77f",
});

const KERNEL_DIST_REQUIRED_FILES = new Set([
  ".neutron-release-evidence.json",
  "connection-providers.json",
  KERNEL_NPL_LICENSE_PATH,
  KERNEL_APPLICATION_NOTICE_PATH,
  "legal/THIRD_PARTY_NOTICES.md",
  NEUTRON_PACKAGE_RECORD_PATH,
  "neutron.did",
  "neutron.json",
  "neutron.lock.json",
]);

const KERNEL_SOURCE_ROOT_FILES = Object.freeze([
  ".gitignore",
  "AGENTS.md",
  "LICENSE",
  "LICENSES.md",
  "README.md",
  "flake.lock",
  "flake.nix",
  "package-lock.json",
  "package.json",
  "tsconfig.base.json",
  "tsconfig.browser.json",
  "tsconfig.bun.json",
  "tsconfig.json",
  "apps/kernel/.eslintrc.json",
  "apps/kernel/.gitignore",
  "apps/kernel/LICENSE",
  "apps/kernel/NOTICE",
  "apps/kernel/README.md",
  "apps/kernel/build.ts",
  "apps/kernel/certified-assets-candidate-binding.json",
  "apps/kernel/generate_package_metadata.ts",
  "apps/kernel/moassemble.ts",
  "apps/kernel/mops.toml",
  "apps/kernel/neutron.json",
  "apps/kernel/neutron.lock.json",
  "apps/kernel/package.json",
  "apps/kernel/stamp_wasm_metadata.ts",
  "apps/kernel/tsconfig.json",
]);

const KERNEL_SOURCE_TREES = Object.freeze([
  "doc",
  "apps/kernel/backend",
  "apps/kernel/connections",
  "apps/kernel/evidence",
  "apps/kernel/public",
  "apps/kernel/src",
  "apps/kernel/test",
  "apps/kernel/types",
  "packages/neutron-compiler",
  "packages/neutron-design-system",
  "packages/neutron-motoko-capabilities",
  "packages/neutron-motoko-wasm",
  "packages/neutron-scripts",
  "packages/neutron-security",
  "packages/neutron-tools",
]);

const EXCLUDED_SOURCE_DIRECTORIES = new Set([
  ".assetgen",
  ".cache",
  ".dfx",
  ".git",
  ".mops",
  ".slice7-smoke",
  "cache",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
  "tmp",
]);
// Exact detached release evidence may be required by qualification while not
// being source input to the candidate build. Keep this list path-specific so
// arbitrary ignored archives or generated files still fail closed.
const KERNEL_KNOWN_DETACHED_GENERATED_PATHS = new Set([
  "apps/kernel/certified-assets-qualification-receipt.json",
]);
const KERNEL_REVIEWED_BINARY_FIXTURE_IDENTITIES = new Map<
  string,
  Readonly<{ bytes: number; sha256: string }>
>([
  [
    "packages/neutron-compiler/test/fixtures/kernel.v0.3.5.neutron",
    {
      bytes: 1_918_481,
      sha256: "534e0ded262bb5700d92046a4fafad16ccf42473259edd3f18e8a0578347f2ae",
    },
  ],
  [
    "packages/neutron-compiler/test/fixtures/kernel.v0.3.6.neutron",
    {
      bytes: 1_858_175,
      sha256: "b25948f68ed10f29c984e936ecfd18b95fa8d4cdec0bbd1e944b53b2a371bd8b",
    },
  ],
  [
    "packages/neutron-compiler/test/fixtures/kernel.v0.3.7.neutron",
    {
      bytes: 1_924_034,
      sha256: "aaf329e5d526f4b5a436c440ac21a245b068172c6e4e2d6dc07696ecadc60f7d",
    },
  ],
  [
    "packages/neutron-compiler/test/fixtures/kernel.v0.3.15.neutron",
    {
      bytes: 2_011_370,
      sha256: "9deeea94795589ee8a331e005c63a85a42886c3f6c0a948e194915539d6a13db",
    },
  ],
]);

/** Explicitly reviewed new files in this uncommitted release candidate. */
const KERNEL_REVIEWED_UNTRACKED_SOURCE_PATHS = new Set([
  "LICENSES.md",
  "apps/kernel/NOTICE",
  "apps/kernel/backend/install/BrowserOrigin.mo",
  "apps/kernel/generate_package_metadata.ts",
  "apps/kernel/evidence/qualification/failure.ts",
  "apps/kernel/evidence/qualification/profile.test.ts",
  "apps/kernel/evidence/qualification/run_failure.test.ts",
  "apps/kernel/evidence/qualification/run_metric.test.ts",
  "apps/kernel/src/app_frame_security.ts",
  "apps/kernel/src/install_review/DeploymentBuildReview.tsx",
  "apps/kernel/src/install_review/deployment_build_review.ts",
  "apps/kernel/src/install_review/prepare_browser_deployment.ts",
  "apps/kernel/src/install_review/provenance_binding.ts",
  "apps/kernel/src/settings/DeploymentBuildRecordDetails.tsx",
  "apps/kernel/src/settings/DeploymentIntegrityDetails.tsx",
  "apps/kernel/src/settings/InstalledPackageLegalDetails.tsx",
  "apps/kernel/src/settings/deployment_build_record.ts",
  "apps/kernel/src/settings/deployment_integrity.ts",
  "apps/kernel/src/settings/installed_package_record.ts",
  "apps/kernel/test/access_settings_ui.test.tsx",
  "apps/kernel/test/app_frame_security.test.ts",
  "apps/kernel/test/browser/media-capabilities.qualification.ts",
  "apps/kernel/test/deployment_build_record.test.ts",
  "apps/kernel/test/deployment_build_record_ui.test.tsx",
  "apps/kernel/test/deployment_build_review.test.ts",
  "apps/kernel/test/deployment_record_fixture.ts",
  "apps/kernel/test/deployment_integrity.test.ts",
  "apps/kernel/test/deployment_integrity_ui.test.tsx",
  "apps/kernel/test/installed_package_record.test.ts",
  "apps/kernel/test/installed_package_record_ui.test.tsx",
  "apps/kernel/test/manual_install_review_flow.isolated.ts",
  "apps/kernel/test/manual_install_review_flow.test.ts",
  "apps/kernel/test/motoko/http_canonical_paths_test.mo",
  "apps/kernel/test/npl_hash_semantics.test.ts",
  "apps/kernel/test/package_metadata_generation.test.ts",
  "apps/kernel/test/prepare_browser_deployment.test.ts",
  "apps/kernel/test/provenance_binding.test.ts",
  "apps/kernel/test/repository_build_review_service.isolated.ts",
  "apps/kernel/test/repository_build_review_service.test.ts",
  "apps/kernel/test/runtime_authority_registry_race.isolated.ts",
  "apps/kernel/test/runtime_authority_registry_race.test.ts",
  "apps/kernel/test/tiny-msgpack.d.ts",
  "apps/kernel/test/uninstall_flow.isolated.ts",
  "apps/kernel/test/uninstall_flow.test.ts",
  "apps/kernel/test/uninstall_review_ui.test.tsx",
  "doc/license-and-deployment-records.md",
  "packages/neutron-compiler/src/deployment_record.ts",
  "packages/neutron-compiler/src/source_snapshot.ts",
  "packages/neutron-compiler/test/deployment_record.test.ts",
  "packages/neutron-compiler/test/fixtures/kernel.v0.3.5.neutron",
  "packages/neutron-compiler/test/fixtures/kernel-v0.3.5.identity.json",
  "packages/neutron-compiler/test/fixtures/kernel.v0.3.6.neutron",
  "packages/neutron-compiler/test/fixtures/kernel-v0.3.6.identity.json",
  "packages/neutron-compiler/test/fixtures/kernel.v0.3.7.neutron",
  "packages/neutron-compiler/test/fixtures/kernel-v0.3.7.identity.json",
  "packages/neutron-compiler/test/fixtures/kernel.v0.3.15.neutron",
  "packages/neutron-compiler/test/fixtures/kernel-v0.3.15.identity.json",
  "packages/neutron-compiler/test/legacy_https_package_compat.test.ts",
  "packages/neutron-compiler/test/legacy_kernel_upgrade.pocketic.test.ts",
  "packages/neutron-compiler/test/legacy_kernel_upgrade.test.ts",
  "packages/neutron-compiler/test/legacy_kernel_upgrade_fixture.ts",
  "packages/neutron-compiler/test/npl_conformance.test.ts",
  "packages/neutron-compiler/test/package_decoder.test.ts",
  "packages/neutron-compiler/test/source_snapshot.test.ts",
  "packages/neutron-compiler/LICENSE",
  "packages/neutron-compiler/NOTICE",
  "packages/neutron-design-system/LICENSE",
  "packages/neutron-design-system/NOTICE",
  "packages/neutron-motoko-capabilities/LICENSE",
  "packages/neutron-motoko-capabilities/NOTICE",
  "packages/neutron-motoko-wasm/LICENSE",
  "packages/neutron-motoko-wasm/LICENSE.js_of_ocaml",
  "packages/neutron-motoko-wasm/LICENSES.md",
  "packages/neutron-motoko-wasm/NOTICE",
  "packages/neutron-scripts/LICENSE",
  "packages/neutron-scripts/NOTICE",
  "packages/neutron-scripts/assets/legal/Ionicons-5.5.4.LICENSE",
  "packages/neutron-scripts/src/package_metadata.ts",
  "packages/neutron-scripts/src/run_motoko_program.ts",
  "packages/neutron-scripts/src/third_party_notices.ts",
  "packages/neutron-scripts/test/package_metadata.test.ts",
  "packages/neutron-scripts/test/third_party_notices.test.ts",
  "packages/neutron-security/LICENSE",
  "packages/neutron-security/NOTICE",
  "packages/neutron-tools/LICENSE",
  "packages/neutron-tools/NOTICE",
  "packages/neutron-tools/src/package_surface_origins.ts",
  "packages/neutron-tools/src/tile_ids.ts",
  "packages/neutron-tools/src/package_record.ts",
  "packages/neutron-tools/test/package_record.test.ts",
]);

/** Important local inputs checked before metadata is generated. */
export const KERNEL_PACKAGE_BUILD_INPUT_PATHS = Object.freeze([
  "package-lock.json",
  "package.json",
  "apps/kernel/build.ts",
  "apps/kernel/LICENSE",
  "apps/kernel/NOTICE",
  "apps/kernel/backend/memory/activation/v1.mo",
  "apps/kernel/backend/memory/kernel/v3.mo",
  "apps/kernel/generate_package_metadata.ts",
  "apps/kernel/moassemble.ts",
  "apps/kernel/mops.toml",
  "apps/kernel/neutron.json",
  "apps/kernel/neutron.lock.json",
  "apps/kernel/package.json",
  "packages/neutron-scripts/src/mopack.ts",
  "packages/neutron-scripts/src/package_metadata.ts",
  "packages/neutron-scripts/src/pack.ts",
  "packages/neutron-scripts/src/third_party_notices.ts",
  "packages/neutron-tools/src/package_record.ts",
]);

export type KernelWorkspaceSourceFile = Readonly<{
  /** POSIX path relative to the repository root. */
  path: string;
  content: Uint8Array;
  mode: 0o644 | 0o755;
}>;

export type GeneratedKernelPackageMetadata = Readonly<{
  license: Uint8Array;
  notice: Uint8Array;
  sourceSnapshot: Uint8Array;
  sourceArtifact: NeutronPackageSourceArtifact;
  sourceFiles: readonly KernelWorkspaceSourceFile[];
  thirdPartyNotices: ThirdPartyNoticeBundle;
  record: NeutronPackageRecordV1;
  recordBytes: Uint8Array;
}>;

type BuildKernelPackageMetadataOptions = Readonly<{
  kernelRoot: string;
  packagedManifest: Uint8Array;
  memoryLock: Uint8Array;
  packageJson: Uint8Array;
  license: Uint8Array;
  notice: Uint8Array;
  esbuildMetafile: Uint8Array;
  sourceFiles: readonly KernelWorkspaceSourceFile[];
  thirdPartyNotices: ThirdPartyNoticeBundle;
}>;

const KERNEL_ICBLAST_OWNER_LICENSE_DECISION = Object.freeze({
  name: "icblast",
  version: "4.3.0",
  packageJsonSha256:
    "8b1567890ef4a42b57fdedd404891f1998ca1d7dc56107e52b2c850f24434fa0",
  selectedLicense: "Apache-2.0",
  copyrightHolder: "3V Interactive",
  scope:
    "First-party JavaScript and TypeScript authored and owned by 3V Interactive in this exact installed npm package, excluding the paths listed below.",
  excludedPaths: Object.freeze(["didc_wasm_pkg"]),
} satisfies AuditedNpmOwnerLicenseDecision);

/**
 * Build the target-neutral Kernel legal record and deterministic provider-hosted
 * source payload from already-reviewed local bytes.
 */
export function buildKernelPackageMetadata(
  options: BuildKernelPackageMetadataOptions,
): GeneratedKernelPackageMetadata {
  const manifest = parseKernelReleaseManifest(options.packagedManifest);
  assertKernelPackageLicenseLabel(options.packageJson);
  assertExactNplLicense(options.license);
  assertKernelApplicationNotice(options.notice);
  assertKernelBrowserMetafile(options.esbuildMetafile);
  if (hashContent(options.memoryLock) !== KERNEL_RELEASE_MEMORY_LOCK_SHA256) {
    throw new Error(
      "The Kernel release must preserve the released managed-memory lock",
    );
  }
  const sourceFiles = normalizeSourceFiles(options.sourceFiles);
  const notice = options.notice.slice();
  const dependencies = Object.entries(normalizeManifestDependencies(manifest))
    .sort(([left], [right]) => compareCanonicalText(left, right))
    .map(([alias, dependency]) => ({
      alias,
      app: dependency.app,
      min_version: dependency.min_version,
      functions: [...dependency.functions],
    }));
  const sourceByPath = new Map(
    sourceFiles.map((file) => [file.path, file] as const),
  );
  assertWorkspaceCopy(sourceByPath, "LICENSE", options.license);
  assertWorkspaceCopy(sourceByPath, "apps/kernel/LICENSE", options.license);
  assertWorkspaceCopy(sourceByPath, "apps/kernel/NOTICE", notice);
  assertWorkspaceCopy(
    sourceByPath,
    "apps/kernel/neutron.lock.json",
    options.memoryLock,
  );
  assertWorkspaceCopy(
    sourceByPath,
    "apps/kernel/package.json",
    options.packageJson,
  );
  assertSourceManifestIdentity(sourceByPath, manifest);
  for (const [sourcePath, expectedSha256] of Object.entries(
    KERNEL_RELEASED_SCHEMA_SOURCE_SHA256,
  )) {
    const source = sourceByPath.get(sourcePath);
    if (!source || hashContent(source.content) !== expectedSha256) {
      throw new Error(
        `The Kernel release must preserve immutable released schema source ${sourcePath}`,
      );
    }
  }

  const compilerLicenseIndex = sourceByPath.get(
    "packages/neutron-motoko-wasm/LICENSES.md",
  );
  if (
    compilerLicenseIndex === undefined ||
    !textDecoder
      .decode(compilerLicenseIndex.content)
      .includes(
        "https://github.com/infu/neutron_motoko/tree/d7ed0a92b6219d784b7143e0851ed64b55dfc25a",
      )
  ) {
    throw new Error(
      "The Kernel release source must retain the pinned external compiler source offer",
    );
  }
  assertThirdPartyNoticeEnvelope(options.thirdPartyNotices);

  const sourceSnapshot = encodeNeutronPackageSourceSnapshot({
    format: 1,
    package: { id: manifest.id, version: manifest.version },
    files: sourceFiles,
  });
  if (
    sourceSnapshot.byteLength < 1 ||
    sourceSnapshot.byteLength > ORDINARY_APP_SOURCE_LIMITS.snapshotBytes
  ) {
    throw new Error("Kernel source snapshot is outside transport limits");
  }
  const sourceArtifact = createNeutronPackageSourceArtifact(
    options.kernelRoot,
    sourceSnapshot,
  );
  const noticeFiles = normalizePackageThirdPartyNoticeBundle(
    options.thirdPartyNotices,
    false,
  );
  for (const sourcePath of KERNEL_PACKAGE_BUILD_INPUT_PATHS) {
    const file = sourceByPath.get(sourcePath);
    if (!file) {
      throw new Error(
        `Kernel workspace review is missing required build input ${sourcePath}`,
      );
    }
    if (file.content.byteLength === 0) {
      throw new Error(`Kernel build input ${sourcePath} must not be empty`);
    }
  }

  const record = {
    format: 1 as const,
    package: {
      id: manifest.id,
      version: manifest.version,
      manifest: embeddedFile("neutron.json", options.packagedManifest),
    },
    license: {
      id: KERNEL_NPL_LICENSE_ID,
      texts: [
        {
          id: KERNEL_NPL_LICENSE_ID,
          ...embeddedFile(KERNEL_NPL_LICENSE_PATH, options.license),
        },
      ],
    },
    source: {
      kind: "https" as const,
      revision: `source-sha256:${sourceArtifact.sha256}`,
      url: neutronAppSourceHttpsUrl(
        canisterOrigin({ canisterId: KERNEL_PRODUCTION_UPDATE_SOURCE }),
        sourceArtifact.sha256,
      ),
      sha256: sourceArtifact.sha256,
      bytes: sourceArtifact.bytes,
    },
    dependencies,
    notices: [
      embeddedFile(KERNEL_APPLICATION_NOTICE_PATH, notice),
      ...noticeFiles.map(([noticePath, content]) =>
        embeddedFile(noticePath, content),
      ),
    ].sort((left, right) => compareCanonicalText(left.path, right.path)),
    memory: {
      lock: embeddedFile("neutron.lock.json", options.memoryLock),
    },
    build: {
      inputs: KERNEL_PACKAGE_BUILD_INPUT_PATHS.map((sourcePath) => {
        const file = sourceByPath.get(sourcePath)!;
        return embeddedFile(sourcePath, file.content);
      }).sort((left, right) => compareCanonicalText(left.path, right.path)),
      commands: [
        {
          purpose: "package",
          cwd: ".",
          argv: ["npm", "--workspace", "neutron-kernel", "run", "package"],
        },
      ],
    },
  } satisfies NeutronPackageRecordV1;
  const recordBytes = jsonBytes(record);
  const packageFiles: Record<string, Uint8Array> = Object.create(null);
  packageFiles["neutron.json"] = options.packagedManifest;
  packageFiles["neutron.lock.json"] = options.memoryLock;
  packageFiles[KERNEL_NPL_LICENSE_PATH] = options.license;
  packageFiles[KERNEL_APPLICATION_NOTICE_PATH] = notice;
  for (const [noticePath, content] of noticeFiles) {
    packageFiles[noticePath] = content;
  }
  packageFiles[NEUTRON_PACKAGE_RECORD_PATH] = recordBytes;
  const parsedRecord = parseNeutronPackageRecord(recordBytes, {
    files: packageFiles,
    manifest,
  });

  return Object.freeze({
    license: options.license,
    notice,
    sourceSnapshot,
    sourceArtifact,
    sourceFiles,
    thirdPartyNotices: options.thirdPartyNotices,
    record: parsedRecord,
    recordBytes,
  });
}

/** Atomically own dist/legal so stale v307 GPL bridge files cannot survive. */
export async function installGeneratedKernelPackageMetadata(
  distRoot: string,
  generated: GeneratedKernelPackageMetadata,
): Promise<void> {
  const packageFiles: Record<string, Uint8Array> = Object.create(null);
  packageFiles[KERNEL_NPL_LICENSE_PATH] = generated.license;
  packageFiles[KERNEL_APPLICATION_NOTICE_PATH] = generated.notice;
  for (const [noticePath, content] of normalizePackageThirdPartyNoticeBundle(
    generated.thirdPartyNotices,
    false,
  )) {
    packageFiles[noticePath] = content;
  }
  packageFiles[NEUTRON_PACKAGE_RECORD_PATH] = generated.recordBytes;
  await replacePackageDistLegalDirectory(distRoot, packageFiles);
}

/** Generate the release legal tree and retain its immutable HTTPS source input. */
export async function generateKernelPackageMetadata(
  kernelRoot = path.resolve(import.meta.dir),
  repositoryRoot = path.resolve(kernelRoot, "../.."),
): Promise<GeneratedKernelPackageMetadata> {
  const distRoot = path.join(kernelRoot, "dist");
  const packagedManifest = await readBytes(path.join(distRoot, "neutron.json"));
  // Reject any other release before workspace enumeration or dist writes.
  parseKernelReleaseManifest(packagedManifest);
  const sourceFiles = await collectKernelWorkspaceSource(repositoryRoot);
  const thirdPartyNotices = await buildThirdPartyNoticeBundle({
    appRoot: kernelRoot,
    repositoryRoot,
    appSpecificNoticePaths: [],
    auditedNpmOwnerLicenseDecisions: [KERNEL_ICBLAST_OWNER_LICENSE_DECISION],
  });
  const generated = buildKernelPackageMetadata({
    kernelRoot,
    packagedManifest,
    memoryLock: await readBytes(path.join(distRoot, "neutron.lock.json")),
    packageJson: await readBytes(path.join(kernelRoot, "package.json")),
    license: await readBytes(path.join(kernelRoot, "LICENSE")),
    notice: await readBytes(path.join(kernelRoot, "NOTICE")),
    esbuildMetafile: await readBytes(
      path.join(kernelRoot, KERNEL_ESBUILD_META_PATH),
    ),
    sourceFiles,
    thirdPartyNotices,
  });
  await installGeneratedKernelPackageMetadata(distRoot, generated);
  await retainNeutronPackageSourceArtifact(generated.sourceArtifact);
  await auditKernelDistForPackaging(distRoot);
  return generated;
}

/** Reject stale or unexpected dist files before pack.ts traverses the directory. */
export async function auditKernelDistForPackaging(
  distRoot: string,
): Promise<void> {
  const rootStats = await fs.lstat(distRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("Kernel dist root must be a real directory");
  }
  const found = new Set<string>();
  let totalBytes = 0;
  let motokoFiles = 0;
  let webFiles = 0;

  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort(
      (left, right) => compareCanonicalText(left.name, right.name),
    );
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      assertSafeSourcePath(relativePath);
      const absolutePath = path.join(directory, entry.name);
      const stats = await fs.lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        throw new Error(
          `Kernel dist contains a symbolic link: ${relativePath}`,
        );
      }
      if (stats.isDirectory()) {
        // Empty directories are not conveyed by pack.ts; recurse so every file
        // under an otherwise stale directory is still checked and rejected.
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!stats.isFile()) {
        throw new Error(
          `Kernel dist contains a non-file entry: ${relativePath}`,
        );
      }
      if (!isAllowedKernelDistFile(relativePath)) {
        throw new Error(
          `Kernel dist contains an unexpected file: ${relativePath}`,
        );
      }
      if (
        !Number.isSafeInteger(stats.size) ||
        stats.size > KERNEL_DIST_MAX_FILE_BYTES
      ) {
        throw new Error(
          `Kernel dist file exceeds the ${KERNEL_DIST_MAX_FILE_BYTES}-byte limit: ${relativePath}`,
        );
      }
      found.add(relativePath);
      if (found.size > KERNEL_DIST_MAX_FILES) {
        throw new Error(`Kernel dist exceeds ${KERNEL_DIST_MAX_FILES} files`);
      }
      totalBytes += stats.size;
      if (
        !Number.isSafeInteger(totalBytes) ||
        totalBytes > KERNEL_DIST_MAX_TOTAL_BYTES
      ) {
        throw new Error(
          `Kernel dist exceeds the ${KERNEL_DIST_MAX_TOTAL_BYTES}-byte decoded limit`,
        );
      }
      if (relativePath.startsWith("mo/")) motokoFiles += 1;
      if (relativePath.startsWith("web/")) webFiles += 1;
    }
  };

  await visit(distRoot, "");
  for (const requiredPath of KERNEL_DIST_REQUIRED_FILES) {
    if (!found.has(requiredPath)) {
      throw new Error(`Kernel dist is missing required file: ${requiredPath}`);
    }
  }
  if (motokoFiles === 0 || webFiles === 0) {
    throw new Error("Kernel dist must contain generated Motoko and web files");
  }
}

function isAllowedKernelDistFile(relativePath: string): boolean {
  return (
    KERNEL_DIST_REQUIRED_FILES.has(relativePath) ||
    relativePath === "legal/third-party/EXACT-MATERIALS.v1.txt" ||
    /^mo\/[a-f0-9]{64}\.mo$/u.test(relativePath) ||
    relativePath.startsWith("web/")
  );
}

/** Collect the reviewed Kernel/build-tool source scope from current workspace bytes. */
export async function collectKernelWorkspaceSource(
  repositoryRoot: string,
): Promise<readonly KernelWorkspaceSourceFile[]> {
  if (!(await repositoryHasGitMetadata(repositoryRoot))) {
    throw new Error(
      "Kernel metadata generation requires Git workspace metadata",
    );
  }
  const files = new Map<string, KernelWorkspaceSourceFile>();
  const untracked = new Set(
    await gitPathList(repositoryRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
    ]),
  );
  const workspacePaths = await gitPathList(repositoryRoot, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
  ]);
  for (const relativePath of workspacePaths) {
    if (
      !isReviewedSourcePath(relativePath) ||
      isExcludedSourceFile(relativePath)
    ) {
      continue;
    }
    assertNotSensitiveSourcePath(relativePath);
    if (
      untracked.has(relativePath) &&
      !KERNEL_REVIEWED_UNTRACKED_SOURCE_PATHS.has(relativePath)
    ) {
      throw new Error(
        `Untracked Kernel source path requires explicit review before packaging: ${relativePath}`,
      );
    }
    await addWorkspaceSourceFile(files, repositoryRoot, relativePath, {
      allowDeleted: true,
    });
  }
  await assertNoOmittedCandidateChanges(repositoryRoot, files);
  return normalizeSourceFiles([...files.values()]);
}

async function repositoryHasGitMetadata(
  repositoryRoot: string,
): Promise<boolean> {
  try {
    const stats = await fs.lstat(path.join(repositoryRoot, ".git"));
    if (stats.isSymbolicLink()) {
      throw new Error("Kernel source collector rejects symbolic .git metadata");
    }
    return stats.isDirectory() || stats.isFile();
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

async function addWorkspaceSourceFile(
  files: Map<string, KernelWorkspaceSourceFile>,
  repositoryRoot: string,
  relativePath: string,
  options: Readonly<{ allowDeleted?: boolean }> = {},
): Promise<void> {
  assertSafeSourcePath(relativePath);
  if (files.has(relativePath)) return;
  const absolutePath = path.join(repositoryRoot, ...relativePath.split("/"));
  let handle;
  try {
    handle = await fs.open(
      absolutePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    if (options.allowDeleted && isMissingFile(error)) return;
    if (isSymlinkLoop(error)) {
      throw new Error(
        `Kernel source input is not a real file: ${relativePath}`,
      );
    }
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error(
        `Kernel source input is not a real file: ${relativePath}`,
      );
    }
    if (
      !Number.isSafeInteger(stats.size) ||
      stats.size > KERNEL_WORKSPACE_SOURCE_MAX_FILE_BYTES
    ) {
      throw new Error(
        `Kernel source input ${relativePath} exceeds the ` +
          `${KERNEL_WORKSPACE_SOURCE_MAX_FILE_BYTES}-byte file limit`,
      );
    }
    const content = new Uint8Array(await handle.readFile());
    if (content.byteLength !== stats.size) {
      throw new Error(
        `Kernel source input changed while read: ${relativePath}`,
      );
    }
    files.set(
      relativePath,
      Object.freeze({
        path: relativePath,
        content,
        mode: stats.mode & 0o111 ? 0o755 : 0o644,
      }),
    );
  } finally {
    await handle.close();
  }
}

async function assertNoOmittedCandidateChanges(
  repositoryRoot: string,
  files: ReadonlyMap<string, KernelWorkspaceSourceFile>,
): Promise<void> {
  const changed = new Set([
    ...(await gitPathList(repositoryRoot, [
      "diff",
      "--name-only",
      "-z",
      "HEAD",
      "--",
    ])),
    ...(await gitPathList(repositoryRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
    ])),
  ]);
  for (const relativePath of changed) {
    if (!isCandidateRelevantChange(relativePath)) continue;
    assertNotSensitiveSourcePath(relativePath);
    if (isExcludedSourceFile(relativePath)) {
      const fixtureIdentity = KERNEL_REVIEWED_BINARY_FIXTURE_IDENTITIES.get(
        relativePath,
      );
      if (fixtureIdentity) {
        await assertReviewedBinaryFixture(
          repositoryRoot,
          relativePath,
          fixtureIdentity,
        );
        continue;
      }
      if (KERNEL_KNOWN_DETACHED_GENERATED_PATHS.has(relativePath)) continue;
      throw new Error(
        `Changed candidate-relevant source is in an excluded path: ${relativePath}`,
      );
    }
    const absolutePath = path.join(repositoryRoot, ...relativePath.split("/"));
    try {
      const stats = await fs.lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        throw new Error(
          `Changed Kernel source is a symbolic link and cannot be packaged: ${relativePath}`,
        );
      }
      if (!stats.isFile()) {
        throw new Error(
          `Changed Kernel source is not a regular file: ${relativePath}`,
        );
      }
    } catch (error) {
      if (isMissingFile(error)) continue; // A tracked deletion is represented by absence.
      throw error;
    }
    if (!files.has(relativePath)) {
      throw new Error(
        `Changed candidate-relevant source is outside the reviewed workspace scope: ${relativePath}`,
      );
    }
  }
}

async function assertReviewedBinaryFixture(
  repositoryRoot: string,
  relativePath: string,
  expected: Readonly<{ bytes: number; sha256: string }>,
): Promise<void> {
  const content = await readBytes(
    path.join(repositoryRoot, ...relativePath.split("/")),
  );
  if (
    content.byteLength !== expected.bytes ||
    hashContent(content) !== expected.sha256
  ) {
    throw new Error(
      `Reviewed binary fixture identity changed: ${relativePath}`,
    );
  }
}

function isReviewedSourcePath(relativePath: string): boolean {
  return (
    KERNEL_SOURCE_ROOT_FILES.includes(
      relativePath as (typeof KERNEL_SOURCE_ROOT_FILES)[number],
    ) ||
    KERNEL_SOURCE_TREES.some(
      (root) => relativePath === root || relativePath.startsWith(`${root}/`),
    )
  );
}

function isCandidateRelevantChange(relativePath: string): boolean {
  if (isReviewedSourcePath(relativePath)) return true;
  if (relativePath.startsWith("apps/kernel/")) return true;
  if (
    KERNEL_SOURCE_TREES.some(
      (root) =>
        root.startsWith("packages/") && relativePath.startsWith(`${root}/`),
    )
  ) {
    return true;
  }
  return !relativePath.includes("/") && isBuildControlFilename(relativePath);
}

function isBuildControlFilename(relativePath: string): boolean {
  return (
    /^(?:package(?:-lock)?\.json|tsconfig(?:\.[a-z0-9_-]+)?\.json)$/u.test(
      relativePath,
    ) || /\.(?:cjs|js|mjs|ts)$/u.test(relativePath)
  );
}

function assertNotSensitiveSourcePath(relativePath: string): void {
  const basename = path.posix.basename(relativePath).toLowerCase();
  if (
    basename === ".env" ||
    basename.startsWith(".env.") ||
    /\.(?:key|p12|pfx|pem)$/u.test(basename) ||
    /^(?:credentials?|secrets?)(?:\.[a-z0-9_-]+)?$/u.test(basename) ||
    /^(?:id_ed25519|id_rsa)(?:\.pub)?$/u.test(basename)
  ) {
    throw new Error(
      `Sensitive credential-like path cannot enter Kernel source metadata: ${relativePath}`,
    );
  }
}

async function gitPathList(
  repositoryRoot: string,
  args: readonly string[],
): Promise<string[]> {
  const result = await execFile("git", args, {
    cwd: repositoryRoot,
    maxBuffer: 8 * MIB,
  });
  return result.stdout
    .split("\0")
    .filter((entry) => entry.length > 0)
    .sort(compareCanonicalText);
}

function isExcludedSourceFile(relativePath: string): boolean {
  const segments = relativePath.split("/");
  const basename = path.posix.basename(relativePath);
  return (
    KERNEL_KNOWN_DETACHED_GENERATED_PATHS.has(relativePath) ||
    segments.some((segment) => EXCLUDED_SOURCE_DIRECTORIES.has(segment)) ||
    basename === ".DS_Store" ||
    basename === "meta.json" ||
    basename.endsWith(".tsbuildinfo") ||
    basename.endsWith(".neutron") ||
    /\.(?:7z|gz|rar|tar|tgz|zip)$/u.test(basename) ||
    basename.endsWith(".ndeploy.session.json") ||
    basename.includes(".ndeploy.session.json.")
  );
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isSymlinkLoop(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ELOOP"
  );
}

function normalizeSourceFiles(
  sourceFiles: readonly KernelWorkspaceSourceFile[],
): readonly KernelWorkspaceSourceFile[] {
  if (sourceFiles.length === 0) {
    throw new Error("Kernel workspace input review must not be empty");
  }
  if (sourceFiles.length > KERNEL_WORKSPACE_SOURCE_MAX_FILES) {
    throw new Error(
      `Kernel workspace input review exceeds ${KERNEL_WORKSPACE_SOURCE_MAX_FILES} files`,
    );
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  const normalized = sourceFiles.map((file) => {
    assertSafeSourcePath(file.path);
    assertNotSensitiveSourcePath(file.path);
    if (isExcludedSourceFile(file.path)) {
      throw new Error(
        `Generated/archive/cache path cannot enter Kernel source metadata: ${file.path}`,
      );
    }
    if (seen.has(file.path)) {
      throw new Error(`Duplicate Kernel workspace source path ${file.path}`);
    }
    seen.add(file.path);
    if (!(file.content instanceof Uint8Array)) {
      throw new Error(`Kernel workspace source ${file.path} is not bytes`);
    }
    if (file.content.byteLength > KERNEL_WORKSPACE_SOURCE_MAX_FILE_BYTES) {
      throw new Error(
        `Kernel workspace source ${file.path} exceeds the ` +
          `${KERNEL_WORKSPACE_SOURCE_MAX_FILE_BYTES}-byte file limit`,
      );
    }
    totalBytes += file.content.byteLength;
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes > KERNEL_WORKSPACE_SOURCE_MAX_TOTAL_BYTES
    ) {
      throw new Error(
        `Kernel workspace source exceeds the ` +
          `${KERNEL_WORKSPACE_SOURCE_MAX_TOTAL_BYTES}-byte aggregate limit`,
      );
    }
    if (file.mode !== 0o644 && file.mode !== 0o755) {
      throw new Error(
        `Kernel workspace source ${file.path} has unsupported mode`,
      );
    }
    return Object.freeze({
      path: file.path,
      content: file.content,
      mode: file.mode,
    });
  });
  normalized.sort((left, right) => compareCanonicalText(left.path, right.path));
  return Object.freeze(normalized);
}

function parseKernelReleaseManifest(
  content: Uint8Array,
): PackagedNeutronManifest {
  let value: unknown;
  try {
    value = JSON.parse(textDecoder.decode(content));
  } catch (error) {
    throw new Error("Packaged Kernel neutron.json is not valid UTF-8 JSON", {
      cause: error,
    });
  }
  if (!isRecord(value) || value.id !== "kernel") {
    throw new Error(
      "Kernel release metadata is only valid for the Kernel package",
    );
  }
  assertAppVersion(value.version, "Kernel package version");
  if (value.version !== KERNEL_NPL_RELEASE_VERSION) {
    throw new Error(
      `Kernel NPL metadata is restricted to Kernel version ${KERNEL_NPL_RELEASE_VERSION}`,
    );
  }
  if (value.format !== 3) {
    throw new Error("The Kernel release must retain package manifest format 3");
  }
  assertExactObjectKeys(
    value,
    [...KERNEL_RELEASE_SOURCE_MANIFEST_KEYS, "entry"],
    "Packaged Kernel manifest",
  );
  assertKernelProductionManifestFields(value);
  if (!isRecord(value.memory) || Object.keys(value.memory).length === 0) {
    throw new Error("The Kernel release must retain its managed-memory declarations");
  }
  assertReleasedMemoryManifest(value.memory, true);
  return value as PackagedNeutronManifest;
}

function assertReleasedMemoryManifest(
  memory: Record<string, unknown>,
  packaged: boolean,
): void {
  const memoryIds = Object.keys(memory).sort(compareCanonicalText);
  if (
    memoryIds.length !== 2 ||
    memoryIds[0] !== "kernel" ||
    memoryIds[1] !== "kernel_activation"
  ) {
    throw new Error(
      "The Kernel release must preserve exactly its two released memory roots",
    );
  }
  for (const [memoryId, binding] of Object.entries(
    KERNEL_MEMORY_SCHEMA_BINDINGS,
  )) {
    const root = memory[memoryId];
    if (!isRecord(root) || root.version !== binding.version) {
      throw new Error(
        `The Kernel release must preserve memory ${memoryId} v${binding.version}`,
      );
    }
    const schemas = root.schemas;
    const schema = isRecord(schemas) ? schemas[binding.schema] : undefined;
    if (
      !isRecord(schemas) ||
      Object.keys(schemas).length !== 1 ||
      !isRecord(schema)
    ) {
      throw new Error(
        `The Kernel release must preserve schema ${memoryId} v${binding.schema}`,
      );
    }
    if (packaged) {
      if (schema.hash !== binding.hash || schema.entry !== binding.entry) {
        throw new Error(
          `The Kernel release changed the schema binding for ${memoryId} v${binding.schema}`,
        );
      }
    }
    if (
      Object.hasOwn(root, "migrations") &&
      (!Array.isArray(root.migrations) || root.migrations.length !== 0)
    ) {
      throw new Error(
        `The Kernel release must not introduce a fake migration for ${memoryId}`,
      );
    }
  }
}

function assertKernelPackageLicenseLabel(content: Uint8Array): void {
  let value: unknown;
  try {
    value = JSON.parse(textDecoder.decode(content));
  } catch (error) {
    throw new Error("Kernel package.json is not valid UTF-8 JSON", {
      cause: error,
    });
  }
  if (!isRecord(value) || value.license !== "SEE LICENSE IN LICENSE") {
    throw new Error(
      "Kernel package.json must declare SEE LICENSE IN LICENSE",
    );
  }
}

function assertExactNplLicense(content: Uint8Array): void {
  if (hashContent(content) !== KERNEL_NPL_LICENSE_SHA256) {
    throw new Error(
      "Kernel NPL license bytes do not match the canonical repository NPL 1.0 text",
    );
  }
}

function assertKernelApplicationNotice(content: Uint8Array): void {
  const notice = textDecoder.decode(content);
  for (const required of [
    "Neutron Kernel",
    "Copyright 2026 3V Interactive",
    "Neutron Public License, Version 1.0",
    `SPDX-License-Identifier: ${KERNEL_NPL_LICENSE_ID}`,
    "Package release: v0.3.17 (packed version 317)",
    "provider-hosted HTTPS source artifact",
    "modified browser compiler is maintained in its own source repository",
    "3V Interactive remains responsible for keeping the referenced source available",
    "does not publish it",
  ]) {
    if (!notice.includes(required)) {
      throw new Error(`Kernel NOTICE is missing required text: ${required}`);
    }
  }
}

function assertKernelBrowserMetafile(content: Uint8Array): void {
  let value: unknown;
  try {
    value = JSON.parse(textDecoder.decode(content));
  } catch (error) {
    throw new Error("Kernel esbuild metafile is not valid UTF-8 JSON", {
      cause: error,
    });
  }
  if (!isRecord(value) || !isRecord(value.inputs)) {
    throw new Error("Kernel esbuild metafile must contain an inputs object");
  }
  const inputs = Object.keys(value.inputs).map((input) =>
    input.replaceAll("\\", "/"),
  );
  if (
    !inputs.some((input) =>
      input.endsWith("/node_modules/icblast/lib/browser.js"),
    )
  ) {
    throw new Error(
      "Kernel browser bundle is missing the expected icblast/lib/browser.js input",
    );
  }
  const forbidden = inputs.find((input) =>
    input.includes("/node_modules/icblast/didc_wasm_pkg/"),
  );
  if (forbidden !== undefined) {
    throw new Error(
      `Kernel browser bundle must not incorporate icblast didc_wasm_pkg: ${forbidden}`,
    );
  }
}

function assertThirdPartyNoticeEnvelope(bundle: ThirdPartyNoticeBundle): void {
  const icblast = bundle.components.find(
    ({ ecosystem, name }) => ecosystem === "npm" && name === "icblast",
  );
  if (
    icblast?.version !== "4.3.0" ||
    icblast.declaredLicense !== "package.json omits a license field" ||
    icblast.selectedLicense !== "Apache-2.0"
  ) {
    throw new Error("Kernel notices lack the exact icblast@4.3.0 decision");
  }
  if (
    !bundle.components.some(
      ({ ecosystem, name, version }) =>
        ecosystem === "npm" &&
        name === "neutron-motoko-wasm" &&
        version === "1.1.0",
    )
  ) {
    throw new Error("Kernel notices omit neutron-motoko-wasm@1.1.0");
  }
  const materialText = Object.values(bundle.files)
    .map((bytes) => textDecoder.decode(bytes))
    .join("\n");
  for (const required of [
    "didc_wasm_pkg",
    "this decision makes no claim about those rights",
    "https://github.com/infu/neutron_motoko/tree/d7ed0a92b6219d784b7143e0851ed64b55dfc25a",
    "https://github.com/ocsigen/js_of_ocaml/tree/e4d950bc1cbcb0f8fc61cce06b0c6a2c55f94581",
  ]) {
    if (!materialText.includes(required)) {
      throw new Error(
        `Kernel third-party materials are missing required admission: ${required}`,
      );
    }
  }
}

function assertWorkspaceCopy(
  sourceByPath: ReadonlyMap<string, KernelWorkspaceSourceFile>,
  sourcePath: string,
  expected: Uint8Array,
): void {
  const actual = sourceByPath.get(sourcePath);
  if (
    !actual ||
    actual.content.byteLength !== expected.byteLength ||
    hashContent(actual.content) !== hashContent(expected)
  ) {
    throw new Error(
      `Local workspace review does not contain the exact package input ${sourcePath}`,
    );
  }
}

function assertSourceManifestIdentity(
  sourceByPath: ReadonlyMap<string, KernelWorkspaceSourceFile>,
  packagedManifest: PackagedNeutronManifest,
): void {
  const source = sourceByPath.get("apps/kernel/neutron.json");
  let value: unknown;
  try {
    value = source ? JSON.parse(textDecoder.decode(source.content)) : undefined;
  } catch (error) {
    throw new Error("Workspace Kernel neutron.json is not valid UTF-8 JSON", {
      cause: error,
    });
  }
  if (
    !isRecord(value) ||
    value.id !== packagedManifest.id ||
    value.version !== packagedManifest.version ||
    value.format !== 3 ||
    !isRecord(value.memory)
  ) {
    throw new Error(
      "Workspace Kernel manifest does not match the packaged identity",
    );
  }
  assertExactObjectKeys(
    value,
    KERNEL_RELEASE_SOURCE_MANIFEST_KEYS,
    "Workspace Kernel manifest",
  );
  assertKernelProductionManifestFields(value);
  assertReleasedMemoryManifest(value.memory, false);
  const normalizedPackaged = stripMopackDerivedManifest(packagedManifest);
  if (canonicalJson(value) !== canonicalJson(normalizedPackaged)) {
    throw new Error(
      "Workspace Kernel manifest differs from packaged non-derived fields",
    );
  }
}

function assertKernelProductionManifestFields(
  manifest: Record<string, unknown>,
): void {
  if (manifest.update_source !== KERNEL_PRODUCTION_UPDATE_SOURCE) {
    throw new Error("The Kernel release must retain the production update source");
  }
  if (
    !Array.isArray(manifest.init_arg) ||
    manifest.init_arg.length !== KERNEL_RELEASE_INIT_ARGS.length ||
    manifest.init_arg.some(
      (argument, index) => argument !== KERNEL_RELEASE_INIT_ARGS[index],
    )
  ) {
    throw new Error("The Kernel release must retain its production init arguments");
  }
}

function stripMopackDerivedManifest(
  manifest: PackagedNeutronManifest,
): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
  delete clone.entry;
  if (!isRecord(clone.memory)) return clone;
  for (const root of Object.values(clone.memory)) {
    if (!isRecord(root)) continue;
    if (isRecord(root.schemas)) {
      for (const schema of Object.values(root.schemas)) {
        if (!isRecord(schema)) continue;
        delete schema.hash;
        delete schema.entry;
      }
    }
    if (Array.isArray(root.migrations)) {
      for (const migration of root.migrations) {
        if (isRecord(migration)) delete migration.entry;
      }
    }
  }
  return clone;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Cannot canonicalize manifest");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(compareCanonicalText)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function embeddedFile(
  embeddedPath: string,
  content: Uint8Array,
): Readonly<{ path: string; sha256: string; bytes: number }> {
  if (content.byteLength === 0) {
    throw new Error(`Embedded package file ${embeddedPath} must not be empty`);
  }
  return Object.freeze({
    path: embeddedPath,
    sha256: hashContent(content),
    bytes: content.byteLength,
  });
}

function jsonBytes(value: unknown): Uint8Array {
  return textEncoder.encode(`${JSON.stringify(value, null, 2)}\n`);
}

function assertSafeSourcePath(sourcePath: string): void {
  const segments = sourcePath.split("/");
  if (
    sourcePath.length === 0 ||
    sourcePath.startsWith("/") ||
    sourcePath.includes("\\") ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(sourcePath) ||
    /[%?#]/u.test(sourcePath) ||
    sourcePath.normalize("NFC") !== sourcePath ||
    textEncoder.encode(sourcePath).byteLength > 255 ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment.trim() !== segment,
    )
  ) {
    throw new Error(`Unsafe Kernel workspace source path ${sourcePath}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactObjectKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key))
      throw new Error(`${label} has unknown field ${key}`);
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`${label} is missing field ${key}`);
    }
  }
}

async function readBytes(filePath: string): Promise<Uint8Array> {
  const handle = await fs.open(
    filePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile())
      throw new Error(`Expected a regular file: ${filePath}`);
    return new Uint8Array(await handle.readFile());
  } finally {
    await handle.close();
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  const generated = await generateKernelPackageMetadata();
  console.log(
    `Generated ${NEUTRON_PACKAGE_RECORD_PATH} and retained the Kernel v${KERNEL_NPL_RELEASE_VERSION} source artifact.`,
  );
}
