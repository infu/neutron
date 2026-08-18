import { createHash } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import {
  CERTIFIED_ASSETS_CANDIDATE_BINDING_SCHEMA,
  CERTIFIED_ASSETS_QUALIFICATION_CONTRACT_SHA256,
  CERTIFIED_ASSETS_SYNTHETIC_PLAN_SHA256,
  assertCertifiedAssetsCandidateBinding,
  assertFinalAssembledWasmCertification,
  type CertifiedAssetsCandidateBinding,
} from "neutron-tools/src/certified_assets_qualification.js";
import {
  buildCertifiedAssetsQualificationManifestSet,
  type CertifiedAssetsQualificationManifestSet,
} from "./qualification/fixture_manifests.ts";
import {
  CERTIFIED_ASSETS_RELEASE_QUALIFICATION_PROFILE,
} from "./qualification/profile.ts";

export const CERTIFIED_ASSETS_CANDIDATE_BINDING_INPUT_SCHEMA =
  "neutron.kernel.certified-assets-candidate-binding-input.v3" as const;
export const CERTIFIED_ASSETS_IMPLEMENTATION_FINGERPRINT_SCHEMA =
  "neutron.kernel.certified-assets-implementation.v2" as const;
export const CERTIFIED_ASSETS_RUNNER_FINGERPRINT_SCHEMA =
  "neutron.kernel.certified-assets-qualification-runner.v2" as const;
export const CERTIFIED_ASSETS_QUALIFICATION_PROFILE = {
  schema: "neutron.kernel.certified-assets-qualification-profile.v2",
  target: "local",
  isolation: "fresh_pocketic_canister_per_sample",
  gateway: "pocketic_http_gateway",
  compiled_actor_cache: false,
  app_usage_meter: "kernel_app_usage_snapshot",
  allocator_meter: "kernel_certified_assets_diagnostics",
  proof_bytes:
    "decoded_certificate_cbor_plus_witness_cbor_plus_expression_path_cbor",
  ...CERTIFIED_ASSETS_RELEASE_QUALIFICATION_PROFILE,
} as const;

export const CERTIFIED_ASSETS_IMPLEMENTATION_SOURCE_ROOT =
  "apps/kernel/backend" as const;
export const CERTIFIED_ASSETS_IMPLEMENTATION_GENERATED_SOURCE =
  "apps/kernel/backend/_neutron.mo" as const;
export const CERTIFIED_ASSETS_IMPLEMENTATION_FIXED_SOURCES = [
  "apps/kernel/neutron.json",
  "apps/kernel/neutron.lock.json",
  "apps/kernel/connections/provider-support.generated.json",
  "packages/neutron-motoko-capabilities/src/lib.mo",
] as const;

export const CERTIFIED_ASSETS_SYNTHETIC_ACTOR_SOURCE =
  "apps/kernel/evidence/qualification/fixture/backend/main.mo" as const;
export const CERTIFIED_ASSETS_SYNTHETIC_ACTOR_MANIFEST =
  "apps/kernel/evidence/qualification/fixture/neutron.json" as const;
export const CERTIFIED_ASSETS_QUALIFICATION_RUNNER_SOURCE_ROOTS = [
  "apps/kernel/evidence/qualification",
  // These workspaces drive package construction, PocketIC, installation, and
  // raw transport. They are not part of compilerSourceFingerprint.
  "packages/neutron-provision/src",
  "packages/neutron-scripts/src",
] as const;
export const CERTIFIED_ASSETS_QUALIFICATION_RUNNER_DEPENDENCIES = [
  // neutron-tools, neutron-compiler, neutron-motoko-wasm, and
  // neutron-security are covered in full by compilerSourceFingerprint. Keep
  // the qualification contract and Wasm parser visible here as well.
  "packages/neutron-tools/src/certified_assets_qualification.ts",
  "packages/neutron-tools/src/wasm_metadata.ts",
  // walk.ts imports this source from outside neutron-scripts/src.
  "packages/neutron-scripts/whitelist.ts",
  "packages/neutron-provision/package.json",
  "packages/neutron-scripts/package.json",
  "flake.nix",
  "flake.lock",
  "apps/kernel/mops.toml",
  "apps/kernel/test/motoko/run.ts",
  "apps/kernel/test/motoko/authenticated_forest_test.mo",
  "apps/kernel/test/motoko/certified_assets_allocator_test.mo",
  "apps/kernel/test/motoko/certified_assets_service_test.mo",
] as const;
export const CERTIFIED_ASSETS_QUALIFICATION_MOTOKO_PACKAGE_SET_SCHEMA =
  "neutron.kernel.certified-assets-motoko-package-set.v1" as const;
export const CERTIFIED_ASSETS_QUALIFICATION_MOTOKO_PACKAGES = [
  {
    name: "core",
    path: "apps/kernel/.mops/_github/core#v2.6.0/src",
  },
  {
    name: "ic-certification",
    path: "apps/kernel/.mops/ic-certification@1.1.0/src",
  },
  {
    name: "base@0",
    path: "apps/kernel/.mops/base@0.16.0/src",
  },
  {
    name: "sha2@0",
    path: "apps/kernel/.mops/sha2@0.1.6/src",
  },
  {
    name: "base",
    path: "apps/kernel/.mops/base@0.14.14/src",
  },
  {
    name: "cbor@4",
    path: "apps/kernel/.mops/cbor@4.1.0/src",
  },
  {
    name: "core@1",
    path: "apps/kernel/.mops/core@1.0.0/src",
  },
  {
    name: "xtended-numbers@2",
    path: "apps/kernel/.mops/xtended-numbers@2.1.0/src",
  },
  {
    name: "buffer@0",
    path: "apps/kernel/.mops/buffer@0.1.0/src",
  },
  {
    name: "json.mo",
    path: "apps/kernel/.mops/json.mo@0.1.2/src",
  },
  {
    name: "base-0.7.3",
    path:
      "apps/kernel/.mops/_github/base-0.7.3#aafcdee0c8328087aeed506e64aa2ff4ed329b47/src",
  },
  {
    name: "parser-combinators",
    path: "apps/kernel/.mops/_github/parser-combinators#v0.1.2/src",
  },
  {
    name: "neutron-capabilities",
    path: "packages/neutron-motoko-capabilities/src",
  },
  {
    name: "sha2",
    path: "apps/kernel/.mops/sha2@0.0.2/src",
  },
] as const;

type SourceMeasurement<Path extends string = string> = {
  path: Path;
  bytes: number;
  sha256: string;
};

export type CertifiedAssetsCandidateBindingInput = Readonly<{
  schema: typeof CERTIFIED_ASSETS_CANDIDATE_BINDING_INPUT_SCHEMA;
  qualification: {
    contract_sha256: string;
    synthetic_plan_sha256: string;
    profile: typeof CERTIFIED_ASSETS_QUALIFICATION_PROFILE;
    profile_sha256: string;
  };
  synthetic_actor: {
    source_path: typeof CERTIFIED_ASSETS_SYNTHETIC_ACTOR_SOURCE;
    source_bytes: number;
    source_sha256: string;
    manifest_template_path:
      typeof CERTIFIED_ASSETS_SYNTHETIC_ACTOR_MANIFEST;
    manifest_set: CertifiedAssetsQualificationManifestSet;
  };
  implementation: {
    fingerprint_schema:
      typeof CERTIFIED_ASSETS_IMPLEMENTATION_FINGERPRINT_SCHEMA;
    fingerprint_sha256: string;
    sources: SourceMeasurement[];
  };
  runner: {
    fingerprint_schema: typeof CERTIFIED_ASSETS_RUNNER_FINGERPRINT_SCHEMA;
    source_set_sha256: string;
    sources: SourceMeasurement[];
  };
  motoko_packages: {
    schema:
      typeof CERTIFIED_ASSETS_QUALIFICATION_MOTOKO_PACKAGE_SET_SCHEMA;
    source_set_sha256: string;
    packages: readonly Readonly<{
      name:
        (typeof CERTIFIED_ASSETS_QUALIFICATION_MOTOKO_PACKAGES)[number]["name"];
      path:
        (typeof CERTIFIED_ASSETS_QUALIFICATION_MOTOKO_PACKAGES)[number]["path"];
      source_files: number;
      source_bytes: number;
      source_sha256: string;
    }>[];
  };
  package_lock: {
    path: "package-lock.json";
    bytes: number;
    sha256: string;
  };
}>;

export function buildCertifiedAssetsCandidateBindingInput(
  repositoryRoot = path.resolve(import.meta.dir, "../../.."),
): CertifiedAssetsCandidateBindingInput {
  const manifestTemplate = JSON.parse(
    readFileSync(
      path.join(repositoryRoot, CERTIFIED_ASSETS_SYNTHETIC_ACTOR_MANIFEST),
      "utf8",
    ),
  ) as unknown;
  const manifestSet = buildCertifiedAssetsQualificationManifestSet(
    manifestTemplate,
  );

  const sourceBytes = readFileSync(
    path.join(repositoryRoot, CERTIFIED_ASSETS_SYNTHETIC_ACTOR_SOURCE),
  );
  const sources =
    certifiedAssetsImplementationSourcePaths(repositoryRoot).map((sourcePath) => {
      const bytes = readFileSync(path.join(repositoryRoot, sourcePath));
      return {
        path: sourcePath,
        bytes: bytes.byteLength,
        sha256: sha256Hex(bytes),
      };
    });
  const runnerSources = qualificationRunnerSourcePaths(repositoryRoot).map(
    (sourcePath) => {
      const bytes = readFileSync(path.join(repositoryRoot, sourcePath));
      return {
        path: sourcePath,
        bytes: bytes.byteLength,
        sha256: sha256Hex(bytes),
      };
    },
  );
  const packageLockBytes = readFileSync(
    path.join(repositoryRoot, "package-lock.json"),
  );
  const motokoPackages =
    certifiedAssetsQualificationMotokoPackageSet(repositoryRoot);

  return {
    schema: CERTIFIED_ASSETS_CANDIDATE_BINDING_INPUT_SCHEMA,
    qualification: {
      contract_sha256:
        CERTIFIED_ASSETS_QUALIFICATION_CONTRACT_SHA256,
      synthetic_plan_sha256: CERTIFIED_ASSETS_SYNTHETIC_PLAN_SHA256,
      profile: CERTIFIED_ASSETS_QUALIFICATION_PROFILE,
      profile_sha256: sha256Hex(
        Buffer.from(
          canonicalJson(CERTIFIED_ASSETS_QUALIFICATION_PROFILE),
          "utf8",
        ),
      ),
    },
    synthetic_actor: {
      source_path: CERTIFIED_ASSETS_SYNTHETIC_ACTOR_SOURCE,
      source_bytes: sourceBytes.byteLength,
      source_sha256: sha256Hex(sourceBytes),
      manifest_template_path:
        CERTIFIED_ASSETS_SYNTHETIC_ACTOR_MANIFEST,
      manifest_set: manifestSet,
    },
    implementation: {
      fingerprint_schema:
        CERTIFIED_ASSETS_IMPLEMENTATION_FINGERPRINT_SCHEMA,
      fingerprint_sha256: sourceFingerprint(
        CERTIFIED_ASSETS_IMPLEMENTATION_FINGERPRINT_SCHEMA,
        sources,
      ),
      sources,
    },
    runner: {
      fingerprint_schema:
        CERTIFIED_ASSETS_RUNNER_FINGERPRINT_SCHEMA,
      source_set_sha256: sourceFingerprint(
        CERTIFIED_ASSETS_RUNNER_FINGERPRINT_SCHEMA,
        runnerSources,
      ),
      sources: runnerSources,
    },
    motoko_packages: motokoPackages,
    package_lock: {
      path: "package-lock.json",
      bytes: packageLockBytes.byteLength,
      sha256: sha256Hex(packageLockBytes),
    },
  };
}

export function certifiedAssetsQualificationMotokoPackageSet(
  repositoryRoot = path.resolve(import.meta.dir, "../../.."),
): CertifiedAssetsCandidateBindingInput["motoko_packages"] {
  const repositoryRealPath = realpathSync(repositoryRoot);
  const names = new Set<string>();
  const packages =
    CERTIFIED_ASSETS_QUALIFICATION_MOTOKO_PACKAGES.map((entry) => {
      if (names.has(entry.name)) {
        throw new Error(
          `Certified Assets qualification Motoko package ${entry.name} is duplicated`,
        );
      }
      names.add(entry.name);
      const packageRoot = path.join(repositoryRoot, entry.path);
      const packageRealPath = realpathSync(packageRoot);
      const relativeRealPath = path.relative(
        repositoryRealPath,
        packageRealPath,
      );
      if (
        relativeRealPath === ".." ||
        relativeRealPath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeRealPath)
      ) {
        throw new Error(
          `Certified Assets qualification Motoko package ${entry.name} resolves outside the repository`,
        );
      }
      const sources = walkSources(
        repositoryRoot,
        entry.path,
        (sourcePath) => sourcePath.endsWith(".mo"),
        `Certified Assets qualification Motoko package ${entry.name}`,
      ).sort();
      if (sources.length === 0) {
        throw new Error(
          `Certified Assets qualification Motoko package ${entry.name} has no Motoko sources`,
        );
      }
      const measurements = sources.map((sourcePath) => {
        const bytes = readFileSync(path.join(repositoryRoot, sourcePath));
        return {
          path: sourcePath,
          bytes: bytes.byteLength,
          sha256: sha256Hex(bytes),
        };
      });
      return {
        ...entry,
        source_files: measurements.length,
        source_bytes: measurements.reduce(
          (total, source) => total + source.bytes,
          0,
        ),
        source_sha256: sourceFingerprint(
          `neutron.kernel.certified-assets-motoko-package.v1:${entry.name}`,
          measurements,
        ),
      };
    });
  return {
    schema: CERTIFIED_ASSETS_QUALIFICATION_MOTOKO_PACKAGE_SET_SCHEMA,
    source_set_sha256: sha256Hex(
      Buffer.from(
        canonicalJson({
          schema:
            CERTIFIED_ASSETS_QUALIFICATION_MOTOKO_PACKAGE_SET_SCHEMA,
          packages,
        }),
        "utf8",
      ),
    ),
    packages,
  };
}

export function certifiedAssetsQualificationMotokoPackageMap(
  repositoryRoot = path.resolve(import.meta.dir, "../../.."),
): Record<string, string> {
  const packageSet =
    certifiedAssetsQualificationMotokoPackageSet(repositoryRoot);
  return Object.fromEntries(
    packageSet.packages.map((entry) => [
      entry.name,
      realpathSync(path.resolve(repositoryRoot, entry.path)),
    ]),
  );
}

export function certifiedAssetsImplementationSourcePaths(
  repositoryRoot = path.resolve(import.meta.dir, "../../.."),
): string[] {
  const sources = [
    ...CERTIFIED_ASSETS_IMPLEMENTATION_FIXED_SOURCES,
    ...walkSources(
      repositoryRoot,
      CERTIFIED_ASSETS_IMPLEMENTATION_SOURCE_ROOT,
      (sourcePath) =>
        sourcePath.endsWith(".mo") &&
        sourcePath !== CERTIFIED_ASSETS_IMPLEMENTATION_GENERATED_SOURCE,
      "Certified Assets implementation",
    ),
  ].sort();
  assertUniqueRegularSources(
    repositoryRoot,
    sources,
    "Certified Assets implementation",
  );
  return sources;
}

export function qualificationRunnerSourcePaths(
  repositoryRoot = path.resolve(import.meta.dir, "../../.."),
): string[] {
  const sources = [
    "apps/kernel/evidence/certified_assets_candidate_binding.ts",
    ...CERTIFIED_ASSETS_QUALIFICATION_RUNNER_DEPENDENCIES,
    ...CERTIFIED_ASSETS_QUALIFICATION_RUNNER_SOURCE_ROOTS.flatMap(
      (sourceRoot) =>
        walkSources(
          repositoryRoot,
          sourceRoot,
          (sourcePath) =>
            sourcePath.endsWith(".ts") &&
            !sourcePath.endsWith(".test.ts"),
          "Certified Assets qualification runner",
        ),
    ),
  ].sort();
  assertUniqueRegularSources(
    repositoryRoot,
    sources,
    "Certified Assets qualification runner",
  );
  return sources;
}

function walkSources(
  repositoryRoot: string,
  relativeDirectory: string,
  include: (sourcePath: string) => boolean,
  label: string,
): string[] {
  const directory = path.join(repositoryRoot, relativeDirectory);
  const directoryMetadata = lstatSync(directory);
  if (
    directoryMetadata.isSymbolicLink() ||
    !directoryMetadata.isDirectory()
  ) {
    throw new Error(
      `${label} source root ${relativeDirectory} must be a real directory`,
    );
  }
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `${label} source set contains symlink ${relativePath}`,
      );
    }
    if (entry.isDirectory()) {
      return walkSources(
        repositoryRoot,
        relativePath,
        include,
        label,
      );
    }
    const normalized = relativePath.split(path.sep).join("/");
    if (!entry.isFile() || !include(normalized)) {
      return [];
    }
    return [normalized];
  });
}

function assertUniqueRegularSources(
  repositoryRoot: string,
  sources: readonly string[],
  label: string,
): void {
  if (new Set(sources).size !== sources.length) {
    throw new Error(`${label} source set contains duplicates`);
  }
  for (const sourcePath of sources) {
    const metadata = lstatSync(path.join(repositoryRoot, sourcePath));
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(
        `${label} source ${sourcePath} must be a regular file`,
      );
    }
  }
}

export function validateCertifiedAssetsCandidateBindingInput(
  value: unknown,
  repositoryRoot = path.resolve(import.meta.dir, "../../.."),
): asserts value is CertifiedAssetsCandidateBindingInput {
  const expected = canonicalJson(
    buildCertifiedAssetsCandidateBindingInput(repositoryRoot),
  );
  const actual = canonicalJson(value);
  if (actual !== expected) {
    throw new Error(
      "Certified Assets candidate-binding input does not match the current generic contract, fixture set, runner, profile, and implementation",
    );
  }
}

export function certifiedAssetsCandidateBindingInputBytes(
  value: unknown,
): Uint8Array {
  return new TextEncoder().encode(`${canonicalJson(value)}\n`);
}

/**
 * Bind one qualification run to the exact final actor assembled from the
 * Kernel and synthetic fixture. Both raw and transport bytes are bound, and
 * the raw Wasm is inspected structurally instead of trusting runner metadata.
 */
export function bindCertifiedAssetsQualificationCandidate(input: {
  binding_input: CertifiedAssetsCandidateBindingInput;
  qualified_raw_wasm: Uint8Array;
  qualified_transport_wasm: Uint8Array;
  compiler_source_fingerprint_sha256: string;
  compiler_id: string;
  assembler_id: string;
  repository_root?: string;
}): CertifiedAssetsCandidateBinding {
  validateCertifiedAssetsCandidateBindingInput(
    input.binding_input,
    input.repository_root,
  );
  const supportedCertificateVersions =
    assertFinalAssembledWasmCertification(input.qualified_raw_wasm);
  let decodedTransport: Buffer;
  try {
    decodedTransport = gunzipSync(input.qualified_transport_wasm);
  } catch (error) {
    throw new Error(
      "Certified Assets qualified transport Wasm must be one valid gzip stream",
      { cause: error },
    );
  }
  if (
    !decodedTransport.equals(Buffer.from(input.qualified_raw_wasm))
  ) {
    throw new Error(
      "Certified Assets qualified transport Wasm does not decode to the bound raw Wasm",
    );
  }
  return assertCertifiedAssetsCandidateBinding({
    schema: CERTIFIED_ASSETS_CANDIDATE_BINDING_SCHEMA,
    qualification_contract_sha256:
      input.binding_input.qualification.contract_sha256,
    synthetic_plan_sha256:
      input.binding_input.qualification.synthetic_plan_sha256,
    qualification_profile_sha256:
      input.binding_input.qualification.profile_sha256,
    implementation_fingerprint_sha256:
      input.binding_input.implementation.fingerprint_sha256,
    compiler_source_fingerprint_sha256:
      input.compiler_source_fingerprint_sha256,
    compiler_id: input.compiler_id,
    assembler_id: input.assembler_id,
    synthetic_actor_source_sha256:
      input.binding_input.synthetic_actor.source_sha256,
    synthetic_actor_manifest_set_sha256:
      input.binding_input.synthetic_actor.manifest_set.sha256,
    qualification_runner_source_sha256:
      input.binding_input.runner.source_set_sha256,
    motoko_package_source_set_sha256:
      input.binding_input.motoko_packages.source_set_sha256,
    qualified_raw_wasm_sha256:
      sha256Hex(input.qualified_raw_wasm),
    qualified_transport_wasm_sha256:
      sha256Hex(input.qualified_transport_wasm),
    package_lock_sha256: input.binding_input.package_lock.sha256,
    supported_certificate_versions: supportedCertificateVersions,
  });
}

function sourceFingerprint(
  schema: string,
  sources: readonly {
    path: string;
    bytes: number;
    sha256: string;
  }[],
): string {
  return sha256Hex(
    Buffer.from(
      canonicalJson({
        schema,
        sources,
      }),
      "utf8",
    ),
  );
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("Canonical candidate binding accepts only safe integers");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
      )
      .join(",")}}`;
  }
  throw new Error("Canonical candidate binding contains an unsupported value");
}
