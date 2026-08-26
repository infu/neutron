import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { disposeMotokoCompiler, loadMotoko } from "neutron-motoko-wasm";
import {
  parsePackageString,
  type PackageMap,
} from "neutron-scripts/src/walk.js";
import { prepareMotokoProgram } from "neutron-scripts/src/motoko.js";

const execute = promisify(execFile);
const compiledTests = [
  "authenticated_forest_test.mo",
  "capability_registry_test.mo",
  "certified_assets_allocator_test.mo",
  "certified_assets_service_test.mo",
  "connections_codec_test.mo",
  "connections_memory_test.mo",
  "painless_test.mo",
];
const interpretedTests = [
  "authenticated_forest_lifecycle_test.mo",
  "backend_calls_test.mo",
  "chain_key_signing_service_test.mo",
  "certified_assets_codec_test.mo",
  "certified_assets_incremental_sha256_test.mo",
  "certified_assets_public_surface_test.mo",
  "connections_service_test.mo",
  "frontend_runtime_admission_test.mo",
  "gateway_authority_test.mo",
  "http_canonical_paths_test.mo",
  "http_privacy_test.mo",
  "http_certification_test.mo",
  "memory_v3_schema_test.mo",
  "http_post_update_handlers_service_test.mo",
  "https_outcalls_service_test.mo",
  "app_usage_service_test.mo",
  "activation_service_test.mo",
  "public_ingress_service_test.mo",
  "install_service_test.mo",
  "randomness_service_test.mo",
  "scheduler_memory_test.mo",
  "stable_store_service_test.mo",
  "vetkeys_memory_test.mo",
  "vetkeys_service_test.mo",
];
const allTests = [...compiledTests, ...interpretedTests];
const requestedTests = process.env.MOTOKO_TEST?.split(",")
  .map((test) => test.trim())
  .filter(Boolean);
const tests = requestedTests
  ? allTests.filter((test) => requestedTests.includes(test))
  : allTests;
if (tests.length === 0) {
  throw new Error(`Unknown MOTOKO_TEST: ${process.env.MOTOKO_TEST}`);
}
if (requestedTests && tests.length !== new Set(requestedTests).size) {
  const unknown = requestedTests.filter((test) => !allTests.includes(test));
  throw new Error(`Unknown MOTOKO_TEST: ${unknown.join(",")}`);
}
const cwd = process.cwd();
const testRoot = path.resolve("test/motoko");
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "neutron-motoko-test-"),
);
const exactPassTranscript =
  process.env.MOTOKO_EXACT_PASS_TRANSCRIPT === "1";
const originalConsoleLog = console.log;
if (exactPassTranscript) {
  console.log = () => {};
}

try {
  const packages = await resolvePackages(cwd);
  const mo = await loadMotoko();
  let wasmtime: string | undefined;

  for (const [index, test] of tests.entries()) {
    const prepared = await prepareMotokoProgram({
      compiler: mo,
      sourcePath: path.join(testRoot, test),
      packages,
      allowDangerous: true,
    });
    if (interpretedTests.includes(test)) {
      await mo.run(prepared.entryPath);
      reportPass(test);
      continue;
    }
    const compiled = await mo.wasm(prepared.entryPath, "wasi");
    const wasmPath = path.join(temporary, `${index}.wasm`);
    await fs.writeFile(wasmPath, compiled.wasm);
    wasmtime ??= await resolveWasmtime();
    await execute(wasmtime, ["-W", "memory64=y", wasmPath]);
    reportPass(test);
  }
} finally {
  console.log = originalConsoleLog;
  await disposeMotokoCompiler();
  await fs.rm(temporary, { recursive: true, force: true });
}

async function resolvePackages(cwd: string): Promise<PackageMap> {
  const boundPackages = process.env.MOTOKO_PACKAGES_JSON;
  if (boundPackages === undefined) {
    const sourceOutput = await execute("mops", ["sources"], { cwd });
    return parsePackageString(
      sourceOutput.stdout.replace(/\n/g, " ").trim(),
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(boundPackages);
  } catch {
    throw new Error("MOTOKO_PACKAGES_JSON must be valid JSON");
  }
  if (
    decoded === null ||
    typeof decoded !== "object" ||
    Array.isArray(decoded)
  ) {
    throw new Error("MOTOKO_PACKAGES_JSON must be a package map");
  }
  const packages: PackageMap = {};
  for (const [name, sourceRoot] of Object.entries(decoded)) {
    if (
      !/^[A-Za-z0-9_.@-]+$/u.test(name) ||
      typeof sourceRoot !== "string" ||
      !path.isAbsolute(sourceRoot) ||
      path.resolve(sourceRoot) !== sourceRoot
    ) {
      throw new Error("MOTOKO_PACKAGES_JSON contains an invalid package root");
    }
    const metadata = await fs.lstat(sourceRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(
        "MOTOKO_PACKAGES_JSON package roots must be real directories",
      );
    }
    packages[name] = sourceRoot;
  }
  if (Object.keys(packages).length === 0) {
    throw new Error("MOTOKO_PACKAGES_JSON must not be empty");
  }
  return packages;
}

function reportPass(test: string): void {
  const line = `Motoko test passed: ${test}`;
  if (exactPassTranscript) {
    process.stdout.write(`${line}\n`);
  } else {
    console.log(line);
  }
}

async function resolveWasmtime(): Promise<string> {
  const configured = process.env.WASMTIME;
  if (configured) {
    await fs.access(configured, fs.constants.X_OK);
    return configured;
  }

  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, "wasmtime");
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }

  try {
    const entries = (await fs.readdir("/nix/store"))
      .filter((entry) => entry.includes("-wasmtime-"))
      .sort()
      .reverse();
    for (const entry of entries) {
      const candidate = path.join("/nix/store", entry, "bin", "wasmtime");
      try {
        await fs.access(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
  } catch {}

  throw new Error("wasmtime is required to execute Motoko unit tests");
}
