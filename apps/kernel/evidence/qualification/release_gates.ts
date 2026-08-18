import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  readFile,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";
import {
  CERTIFIED_ASSETS_MAX_ENTRIES,
} from "neutron-tools/src/capabilities/catalog.js";
import {
  CERTIFIED_ASSETS_SYNTHETIC_ACTOR_MANIFEST,
  certifiedAssetsQualificationMotokoPackageMap,
} from "../certified_assets_candidate_binding.ts";
import {
  CERTIFIED_ASSETS_MOTOKO_GATES_SCHEMA,
  CERTIFIED_ASSETS_ONE_OVER_GATE_SCHEMA,
  type ExactBytes,
  type FocusedMotokoGateObservation,
  type PhysicalOneOverGateObservation,
} from "./receipt.ts";
import {
  certifiedAssetsQualificationFixture,
  certifiedAssetsQualificationManifestBytes,
  generateCertifiedAssetsQualificationManifest,
} from "./fixture_manifests.ts";

const executeFile = promisify(execFile);
const FOCUSED_TEST_FILES = [
  "apps/kernel/test/motoko/authenticated_forest_test.mo",
  "apps/kernel/test/motoko/certified_assets_allocator_test.mo",
  "apps/kernel/test/motoko/certified_assets_service_test.mo",
] as const;
const FOCUSED_TEST_NAMES = FOCUSED_TEST_FILES.map((file) =>
  path.basename(file)
);
const EXPECTED_PASS_LINES = FOCUSED_TEST_NAMES.map(
  (test) => `Motoko test passed: ${test}`,
) as [
  "Motoko test passed: authenticated_forest_test.mo",
  "Motoko test passed: certified_assets_allocator_test.mo",
  "Motoko test passed: certified_assets_service_test.mo",
];
const PHYSICAL_ENTRY_MAXIMUM =
  CERTIFIED_ASSETS_MAX_ENTRIES;
const PHYSICAL_ENTRY_ONE_OVER = PHYSICAL_ENTRY_MAXIMUM + 1;
const TRUSTED_NIX_EXECUTABLES = [
  "/nix/var/nix/profiles/default/bin/nix",
  "/run/current-system/sw/bin/nix",
] as const;
const WASMTIME_FLAKE_OUTPUT = "qualification-wasmtime" as const;

/**
 * Run the two implementation-level fail-closed gates plus the authenticated
 * forest test which owns their certified-tree substrate. The transcript is
 * accepted only when it consists of the three fixed pass lines.
 */
export async function runFocusedMotokoGates(
  repositoryRoot: string,
): Promise<FocusedMotokoGateObservation> {
  const kernelRoot = path.join(repositoryRoot, "apps", "kernel");
  const wasmtime = await resolvePinnedWasmtime(repositoryRoot);
  const motokoPackages =
    certifiedAssetsQualificationMotokoPackageMap(repositoryRoot);
  const {
    WASMTIME: _callerSelectedWasmtime,
    MOTOKO_EXACT_PASS_TRANSCRIPT: _callerSelectedTranscript,
    MOTOKO_PACKAGES_JSON: _callerSelectedPackages,
    ...fixedEnvironment
  } = process.env;
  const { stdout, stderr } = await executeFile(
    process.execPath,
    [path.join(kernelRoot, "test", "motoko", "run.ts")],
    {
      cwd: kernelRoot,
      env: {
        ...fixedEnvironment,
        MOTOKO_EXACT_PASS_TRANSCRIPT: "1",
        MOTOKO_PACKAGES_JSON: JSON.stringify(motokoPackages),
        MOTOKO_TEST: FOCUSED_TEST_NAMES.join(","),
        WASMTIME: wasmtime.executable,
      },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (stderr !== "") {
    throw new Error(
      "Focused Certified Assets Motoko gates wrote an unexpected stderr transcript",
    );
  }
  const expectedStdout = `${EXPECTED_PASS_LINES.join("\n")}\n`;
  if (stdout !== expectedStdout) {
    throw new Error(
      "Focused Certified Assets Motoko gates did not produce the exact pass transcript",
    );
  }
  const testFiles = await Promise.all(
    FOCUSED_TEST_FILES.map(async (relativePath) => ({
      path: relativePath,
      source_sha256: sha256(await readFile(
        path.join(repositoryRoot, relativePath),
      )),
    })),
  );
  return {
    schema: CERTIFIED_ASSETS_MOTOKO_GATES_SCHEMA,
    wasmtime: {
      version: wasmtime.version,
      binary: wasmtime.binary,
    },
    test_files: testFiles,
    expected_pass_lines: EXPECTED_PASS_LINES,
    stdout: exactBytes(new TextEncoder().encode(stdout)),
  };
}

async function resolvePinnedWasmtime(repositoryRoot: string): Promise<{
  executable: string;
  version: string;
  binary: ExactBytes;
}> {
  const nix = await resolveTrustedNixExecutable();
  const { stdout } = await executeFile(
    nix,
    [
      "build",
      "--no-link",
      "--no-write-lock-file",
      "--print-out-paths",
      `${repositoryRoot}#${WASMTIME_FLAKE_OUTPUT}`,
    ],
    {
      cwd: repositoryRoot,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const outputPaths = stdout.trim().split(/\s+/u).filter(Boolean);
  if (outputPaths.length !== 1) {
    throw new Error(
      "Pinned qualification Wasmtime must resolve to exactly one Nix store output",
    );
  }
  const outputPath = await realpath(outputPaths[0]!);
  if (!isNixStorePath(outputPath)) {
    throw new Error(
      "Pinned qualification Wasmtime resolved outside the Nix store",
    );
  }
  const executable = await realpath(
    path.join(outputPath, "bin", "wasmtime"),
  );
  const relativeExecutable = path.relative(outputPath, executable);
  if (
    relativeExecutable === ".." ||
    relativeExecutable.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeExecutable)
  ) {
    throw new Error(
      "Pinned qualification Wasmtime executable escaped its Nix store output",
    );
  }
  await access(executable, constants.X_OK);
  const versionResult = await executeFile(executable, ["--version"], {
    cwd: repositoryRoot,
    maxBuffer: 64 * 1024,
  });
  if (versionResult.stderr !== "") {
    throw new Error(
      "Pinned qualification Wasmtime wrote an unexpected version stderr transcript",
    );
  }
  const version = versionResult.stdout.trim();
  if (!/^wasmtime [0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(
      "Pinned qualification Wasmtime returned an invalid version transcript",
    );
  }
  return {
    executable,
    version,
    binary: exactBytes(await readFile(executable)),
  };
}

async function resolveTrustedNixExecutable(): Promise<string> {
  for (const executable of TRUSTED_NIX_EXECUTABLES) {
    try {
      await access(executable, constants.X_OK);
      const resolved = await realpath(executable);
      if (!isNixStorePath(resolved)) continue;
      return resolved;
    } catch {}
  }
  throw new Error(
    "Certified Assets release qualification requires Nix from a trusted system profile",
  );
}

function isNixStorePath(value: string): boolean {
  const relative = path.relative("/nix/store", value);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Exercise the public manifest validator at the exact physical entry
 * boundary. This is independent of the live 100,001st runtime write.
 */
export async function runPhysicalOneOverManifestGate(
  repositoryRoot: string,
): Promise<PhysicalOneOverGateObservation> {
  const template = JSON.parse(
    await readFile(
      path.join(
        repositoryRoot,
        CERTIFIED_ASSETS_SYNTHETIC_ACTOR_MANIFEST,
      ),
      "utf8",
    ),
  ) as unknown;
  const manifest = structuredClone(
    generateCertifiedAssetsQualificationManifest(
      template,
      certifiedAssetsQualificationFixture("ca_qualification_primary"),
    ),
  );
  const capabilities = record(
    manifest.capabilities,
    "physical one-over manifest capabilities",
  );
  const certifiedAssets = record(
    capabilities.certified_assets,
    "physical one-over manifest certified_assets",
  );
  certifiedAssets.max_entries = PHYSICAL_ENTRY_ONE_OVER;
  const result = validate_neutron_conf(manifest);
  if (result.errors.length !== 1) {
    throw new Error(
      `Physical one-over manifest must have exactly one validation error, found ${result.errors.length}`,
    );
  }
  const error = result.errors[0]!;
  if (
    error.name !== "maximum" ||
    error.argument !== PHYSICAL_ENTRY_MAXIMUM ||
    error.property !==
      "instance.capabilities.certified_assets.max_entries"
  ) {
    throw new Error(
      "Physical one-over manifest was not rejected at the exact max_entries boundary",
    );
  }
  const normalizedError = {
    instance_path: "/capabilities/certified_assets/max_entries",
    schema_path:
      "#/properties/capabilities/properties/certified_assets/properties/max_entries/maximum",
    keyword: "maximum" as const,
  };
  const manifestBytes =
    certifiedAssetsQualificationManifestBytes(manifest);
  return {
    schema: CERTIFIED_ASSETS_ONE_OVER_GATE_SCHEMA,
    attempted_entries:
      PHYSICAL_ENTRY_ONE_OVER as
        PhysicalOneOverGateObservation["attempted_entries"],
    maximum_entries: PHYSICAL_ENTRY_MAXIMUM,
    manifest: exactBytes(manifestBytes),
    validation_error: {
      ...normalizedError,
      canonical_sha256: sha256(
        new TextEncoder().encode(canonicalJson(normalizedError)),
      ),
    },
  };
}

function exactBytes(value: Uint8Array): ExactBytes {
  return {
    bytes: value.byteLength,
    sha256: sha256(value),
  };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`)
    .join(",")}}`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a record`);
  }
  return value as Record<string, unknown>;
}
