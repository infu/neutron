import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  CERTIFIED_ASSETS_CANDIDATE_BINDING_INPUT_SCHEMA,
  CERTIFIED_ASSETS_IMPLEMENTATION_FIXED_SOURCES,
  CERTIFIED_ASSETS_IMPLEMENTATION_GENERATED_SOURCE,
  CERTIFIED_ASSETS_IMPLEMENTATION_SOURCE_ROOT,
  CERTIFIED_ASSETS_QUALIFICATION_MOTOKO_PACKAGES,
  CERTIFIED_ASSETS_QUALIFICATION_MOTOKO_PACKAGE_SET_SCHEMA,
  CERTIFIED_ASSETS_QUALIFICATION_RUNNER_SOURCE_ROOTS,
  bindCertifiedAssetsQualificationCandidate,
  buildCertifiedAssetsCandidateBindingInput,
  certifiedAssetsQualificationMotokoPackageMap,
  certifiedAssetsQualificationMotokoPackageSet,
  certifiedAssetsImplementationSourcePaths,
  certifiedAssetsCandidateBindingInputBytes,
  qualificationRunnerSourcePaths,
  validateCertifiedAssetsCandidateBindingInput,
} from "../evidence/certified_assets_candidate_binding.ts";
import {
  CERTIFIED_ASSETS_QUALIFICATION_FIXTURES,
  buildCertifiedAssetsQualificationManifestSet,
  generateCertifiedAssetsQualificationManifest,
} from "../evidence/qualification/fixture_manifests.ts";
import {
  CERTIFIED_ASSETS_RELEASE_QUALIFICATION_PROFILE,
} from "../evidence/qualification/profile.ts";
import { withSupportedCertificateVersions } from "neutron-tools/src/wasm_metadata.js";
import {
  CERTIFIED_ASSETS_SYNTHETIC_PLAN,
} from "neutron-tools/src/certified_assets_qualification.js";

const repositoryRoot = path.resolve(import.meta.dir, "../../..");
const checkedBindingPath = path.join(
  repositoryRoot,
  "apps/kernel/certified-assets-candidate-binding.json",
);
const EMPTY_WASM = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
]);

describe("generic Certified Assets qualification binding", () => {
  test("binds only the synthetic actor and generic implementation", () => {
    const bindingInput =
      buildCertifiedAssetsCandidateBindingInput(repositoryRoot);
    expect(bindingInput.schema).toBe(
      CERTIFIED_ASSETS_CANDIDATE_BINDING_INPUT_SCHEMA,
    );
    expect(bindingInput.implementation.sources.map(({ path }) => path)).toEqual(
      certifiedAssetsImplementationSourcePaths(repositoryRoot),
    );
    expect(bindingInput.implementation.sources.map(({ path }) => path)).toEqual(
      [
        ...CERTIFIED_ASSETS_IMPLEMENTATION_FIXED_SOURCES,
        ...sourceFiles(
          CERTIFIED_ASSETS_IMPLEMENTATION_SOURCE_ROOT,
          (sourcePath) =>
            sourcePath.endsWith(".mo") &&
            sourcePath !==
              CERTIFIED_ASSETS_IMPLEMENTATION_GENERATED_SOURCE,
        ),
      ].sort(),
    );
    const implementationPaths = bindingInput.implementation.sources.map(
      ({ path: sourcePath }) => sourcePath,
    );
    expect(implementationPaths).not.toContain(
      CERTIFIED_ASSETS_IMPLEMENTATION_GENERATED_SOURCE,
    );
    expect(implementationPaths).toContain("apps/kernel/backend/main.mo");
    expect(implementationPaths).not.toContain(
      "packages/neutron-compiler/src/assemble.ts",
    );
    expect(implementationPaths).not.toContain(
      "packages/neutron-tools/src/capabilities/catalog.ts",
    );
    expect(
      new Set(implementationPaths).size,
    ).toBe(bindingInput.implementation.sources.length);
    expect(
      JSON.stringify(bindingInput),
    ).not.toMatch(/wagyu|kitchensink|contacts|apps\/vfs/iu);
    expect(bindingInput.qualification.profile).toMatchObject(
      CERTIFIED_ASSETS_RELEASE_QUALIFICATION_PROFILE,
    );
    expect(
      bindingInput.synthetic_actor.manifest_set.manifests.map(
        ({ app_id, role }) => ({ app_id, role }),
      ),
    ).toEqual(
      CERTIFIED_ASSETS_QUALIFICATION_FIXTURES.map(({ app_id, role }) => ({
        app_id,
        role,
      })),
    );
    const behavior = CERTIFIED_ASSETS_QUALIFICATION_FIXTURES.find(
      ({ role }) => role === "behavior",
    );
    expect(behavior?.certified_assets).toEqual({
      api: 2,
      ...CERTIFIED_ASSETS_SYNTHETIC_PLAN.limits,
      collections: CERTIFIED_ASSETS_SYNTHETIC_PLAN.collections.map(
        (collection) => ({ ...collection }),
      ),
    });
    expect(() =>
      validateCertifiedAssetsCandidateBindingInput(
        bindingInput,
        repositoryRoot,
      ),
    ).not.toThrow();
  });

  test("binds the exact deterministic five-manifest set and runner source set", () => {
    const bindingInput =
      buildCertifiedAssetsCandidateBindingInput(repositoryRoot);
    expect(bindingInput.synthetic_actor.manifest_set.manifests).toHaveLength(5);
    expect(
      bindingInput.synthetic_actor.manifest_set.manifests.map(
        ({ app_id }) => app_id,
      ),
    ).toEqual([
      "ca_qualification_primary",
      "ca_qualification_aux_1",
      "ca_qualification_aux_2",
      "ca_qualification_aux_3",
      "ca_qualification_aux_4",
    ]);
    expect(bindingInput.runner.sources.map(({ path }) => path)).toEqual(
      qualificationRunnerSourcePaths(repositoryRoot),
    );
    expect(bindingInput.runner.sources.map(({ path }) => path)).not.toContain(
      "apps/kernel/evidence/qualification/receipt.test.ts",
    );
    expect(bindingInput.runner.sources.map(({ path }) => path)).toContain(
      "apps/kernel/evidence/qualification/run.ts",
    );
    expect(bindingInput.runner.sources.map(({ path }) => path)).toContain(
      "packages/neutron-tools/src/certified_assets_qualification.ts",
    );
    const runnerSourcePaths = bindingInput.runner.sources.map(
      ({ path: sourcePath }) => sourcePath,
    );
    expect(new Set(runnerSourcePaths).size).toBe(runnerSourcePaths.length);
    for (
      const sourceRoot of
      CERTIFIED_ASSETS_QUALIFICATION_RUNNER_SOURCE_ROOTS
    ) {
      expect(
        runnerSourcePaths.filter((sourcePath) =>
          sourcePath.startsWith(`${sourceRoot}/`),
        ),
      ).toEqual(productionTypeScriptSources(sourceRoot));
    }
    expect(runnerSourcePaths).toContain(
      "apps/kernel/test/motoko/authenticated_forest_test.mo",
    );
    expect(runnerSourcePaths).toContain(
      "packages/neutron-scripts/whitelist.ts",
    );
    expect(runnerSourcePaths).toContain(
      "packages/neutron-provision/package.json",
    );
    expect(runnerSourcePaths).toContain(
      "packages/neutron-scripts/package.json",
    );
    expect(runnerSourcePaths).toContain("flake.nix");
    expect(runnerSourcePaths).toContain("flake.lock");
    expect(runnerSourcePaths).toContain("apps/kernel/mops.toml");

    const template = JSON.parse(
      readFileSync(
        path.join(
          repositoryRoot,
          bindingInput.synthetic_actor.manifest_template_path,
        ),
        "utf8",
      ),
    ) as unknown;
    expect(buildCertifiedAssetsQualificationManifestSet(template)).toEqual(
      bindingInput.synthetic_actor.manifest_set,
    );
  });

  test("binds a fixed repository-confined Motoko package source set without mops resolution", () => {
    const bindingInput =
      buildCertifiedAssetsCandidateBindingInput(repositoryRoot);
    const packageSet =
      certifiedAssetsQualificationMotokoPackageSet(repositoryRoot);
    expect(packageSet.schema).toBe(
      CERTIFIED_ASSETS_QUALIFICATION_MOTOKO_PACKAGE_SET_SCHEMA,
    );
    expect(packageSet).toEqual(bindingInput.motoko_packages);
    expect(
      packageSet.packages.map(({ name, path: sourcePath }) => ({
        name,
        path: sourcePath,
      })),
    ).toEqual([...CERTIFIED_ASSETS_QUALIFICATION_MOTOKO_PACKAGES]);
    expect(
      packageSet.packages.every(
        ({ source_files, source_bytes, source_sha256 }) =>
          source_files > 0 &&
          source_bytes > 0 &&
          /^[0-9a-f]{64}$/u.test(source_sha256),
      ),
    ).toBe(true);
    expect(
      Object.keys(
        certifiedAssetsQualificationMotokoPackageMap(repositoryRoot),
      ),
    ).toEqual(
      CERTIFIED_ASSETS_QUALIFICATION_MOTOKO_PACKAGES.map(({ name }) => name),
    );
    const fixturePackageSource = readFileSync(
      path.join(
        repositoryRoot,
        "apps/kernel/evidence/qualification/fixture_package.ts",
      ),
      "utf8",
    );
    expect(fixturePackageSource).not.toMatch(
      /executeFile\(\s*["']mops["']|mops sources/u,
    );
  });

  test("returns detached manifests that cannot mutate the bound fixture set", () => {
    const template = JSON.parse(
      readFileSync(
        path.join(
          repositoryRoot,
          "apps/kernel/evidence/qualification/fixture/neutron.json",
        ),
        "utf8",
      ),
    ) as unknown;
    const before = buildCertifiedAssetsQualificationManifestSet(template);
    const fixture = CERTIFIED_ASSETS_QUALIFICATION_FIXTURES[0];
    const generated = generateCertifiedAssetsQualificationManifest(
      template,
      fixture,
    );
    const capabilities = generated.capabilities as Record<string, unknown>;
    const certifiedAssets =
      capabilities.certified_assets as Record<string, unknown>;
    certifiedAssets.max_entries = 257;
    expect(fixture.certified_assets.max_entries).toBe(256);
    expect(buildCertifiedAssetsQualificationManifestSet(template)).toEqual(
      before,
    );
  });

  test("rejects a stale source binding", () => {
    const bindingInput =
      buildCertifiedAssetsCandidateBindingInput(repositoryRoot);
    expect(() =>
      validateCertifiedAssetsCandidateBindingInput(
        {
          ...bindingInput,
          implementation: {
            ...bindingInput.implementation,
            fingerprint_sha256: "00".repeat(32),
          },
        },
        repositoryRoot,
      ),
    ).toThrow("does not match");
    expect(() =>
      validateCertifiedAssetsCandidateBindingInput(
        {
          ...bindingInput,
          motoko_packages: {
            ...bindingInput.motoko_packages,
            source_set_sha256: "00".repeat(32),
          },
        },
        repositoryRoot,
      ),
    ).toThrow("does not match");
    expect(() =>
      validateCertifiedAssetsCandidateBindingInput(
        {
          ...bindingInput,
          runner: {
            ...bindingInput.runner,
            source_set_sha256: "00".repeat(32),
          },
        },
        repositoryRoot,
      ),
    ).toThrow("does not match");
    expect(() =>
      validateCertifiedAssetsCandidateBindingInput(
        {
          ...bindingInput,
          synthetic_actor: {
            ...bindingInput.synthetic_actor,
            manifest_set: {
              ...bindingInput.synthetic_actor.manifest_set,
              manifests: [
                ...bindingInput.synthetic_actor.manifest_set.manifests,
              ].reverse(),
            },
          },
        },
        repositoryRoot,
      ),
    ).toThrow("does not match");
  });

  test("uses one canonical candidate-binding input", () => {
    const bindingInput =
      buildCertifiedAssetsCandidateBindingInput(repositoryRoot);
    const bytes = certifiedAssetsCandidateBindingInputBytes(bindingInput);
    expect(bytes.at(-1)).toBe(10);
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(bindingInput);
  });

  test("keeps the checked candidate binding exact and current", () => {
    const expected = certifiedAssetsCandidateBindingInputBytes(
      buildCertifiedAssetsCandidateBindingInput(repositoryRoot),
    );
    const checked = readFileSync(checkedBindingPath);
    expect(checked.equals(Buffer.from(expected))).toBe(true);
    expect(() =>
      validateCertifiedAssetsCandidateBindingInput(
        JSON.parse(checked.toString("utf8")),
        repositoryRoot,
      ),
    ).not.toThrow();
  });

  test("binds the exact raw and transport Wasm and inspects the raw Wasm", () => {
    const bindingInput =
      buildCertifiedAssetsCandidateBindingInput(repositoryRoot);
    const qualifiedRawWasm =
      withSupportedCertificateVersions(EMPTY_WASM);
    const candidate = bindCertifiedAssetsQualificationCandidate({
      binding_input: bindingInput,
      qualified_raw_wasm: qualifiedRawWasm,
      qualified_transport_wasm: gzipSync(qualifiedRawWasm),
      compiler_source_fingerprint_sha256: "ab".repeat(32),
      compiler_id: "moc_test",
      assembler_id: "neutron_actor_test",
      repository_root: repositoryRoot,
    });
    expect(candidate.synthetic_actor_source_sha256).toBe(
      bindingInput.synthetic_actor.source_sha256,
    );
    expect(candidate.synthetic_actor_manifest_set_sha256).toBe(
      bindingInput.synthetic_actor.manifest_set.sha256,
    );
    expect(candidate.qualification_runner_source_sha256).toBe(
      bindingInput.runner.source_set_sha256,
    );
    expect(candidate.motoko_package_source_set_sha256).toBe(
      bindingInput.motoko_packages.source_set_sha256,
    );
    expect(candidate.qualified_raw_wasm_sha256).not.toBe(
      candidate.qualified_transport_wasm_sha256,
    );
    expect(() =>
      bindCertifiedAssetsQualificationCandidate({
        binding_input: bindingInput,
        qualified_raw_wasm: EMPTY_WASM,
        qualified_transport_wasm: gzipSync(EMPTY_WASM),
        compiler_source_fingerprint_sha256: "ab".repeat(32),
        compiler_id: "moc_test",
        assembler_id: "neutron_actor_test",
        repository_root: repositoryRoot,
      }),
    ).toThrow("Missing Wasm custom section");
    expect(() =>
      bindCertifiedAssetsQualificationCandidate({
        binding_input: bindingInput,
        qualified_raw_wasm: qualifiedRawWasm,
        qualified_transport_wasm: gzipSync(EMPTY_WASM),
        compiler_source_fingerprint_sha256: "ab".repeat(32),
        compiler_id: "moc_test",
        assembler_id: "neutron_actor_test",
        repository_root: repositoryRoot,
      }),
    ).toThrow("does not decode to the bound raw Wasm");
  });

  test("normal frontend builds do not consume qualification results", () => {
    const buildSource = readFileSync(
      path.join(repositoryRoot, "apps/kernel/build.ts"),
      "utf8",
    );
    expect(buildSource).not.toContain(
      "certified-assets-candidate-binding.json",
    );
    expect(buildSource).not.toContain("certified-assets-qualification.json");
    expect(buildSource).not.toContain(
      "certifiedAssetsQualification",
    );
  });
});

function productionTypeScriptSources(relativeDirectory: string): string[] {
  return sourceFiles(
    relativeDirectory,
    (sourcePath) =>
      sourcePath.endsWith(".ts") &&
      !sourcePath.endsWith(".test.ts"),
  );
}

function sourceFiles(
  relativeDirectory: string,
  include: (sourcePath: string) => boolean,
): string[] {
  return readdirSync(path.join(repositoryRoot, relativeDirectory), {
    withFileTypes: true,
  })
    .flatMap((entry) => {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(relativePath, include);
      }
      const normalized = relativePath.split(path.sep).join("/");
      if (!entry.isFile() || !include(normalized)) {
        return [];
      }
      return [normalized];
    })
    .sort();
}
