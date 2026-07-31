import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  disposeMotokoCompiler,
  loadMotoko,
} from "neutron-motoko-wasm";
import {
  getDependencies,
  parsePackageString,
  walkReplace,
  type DependencyCache,
  type HashFiles,
} from "neutron-scripts/src/walk.js";

const execute = promisify(execFile);
const allTests = [
  "memory_test.mo",
  "memory_v1_to_v2_test.mo",
  "keys_test.mo",
  "unicode_nfc_test.mo",
  "accounting_behavior_test.mo",
  "frames_behavior_test.mo",
  "tree_behavior_test.mo",
  "mutation_behavior_test.mo",
  "service_navigation_test.mo",
  "write_block_service_test.mo",
  "service_quota_receipt_test.mo",
  "bootstrap_integrity_test.mo",
  "cleanup_behavior_test.mo",
  "plain_service_behavior_test.mo",
  "main_compile_test.mo",
];
const requestedTests = process.env.MOTOKO_TEST
  ?.split(",")
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

const testRoot = import.meta.dir;
const appRoot = path.resolve(testRoot, "../..");
const repositoryRoot = path.resolve(appRoot, "../..");
process.chdir(appRoot);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "files-motoko-test-"));

try {
  const sourceOutput = await execute("mops", ["sources"], { cwd: appRoot });
  const packages = parsePackageString(
    sourceOutput.stdout.replace(/\n/g, " ").trim(),
  );
  // The backend surface already uses the stable capability leaf, while the
  // manifest/dependency update is owned by the coordinated packaging work.
  packages["neutron-capabilities"] = path.join(
    repositoryRoot,
    "packages/neutron-motoko-capabilities/src",
  );
  const wasmtime = await resolveWasmtime();
  const mo = await loadMotoko();

  for (const [index, test] of tests.entries()) {
    const hashfiles: HashFiles = {};
    const cache: DependencyCache = {};
    const dependencies = await getDependencies(
      null,
      path.join(testRoot, test),
      packages,
      hashfiles,
      cache,
    );
    const used: string[] = [];
    const [, entry] = walkReplace(dependencies, hashfiles, used, {
      allowDangerous: true,
    });
    for (const hash of new Set(used)) {
      await mo.write(`${hash}.mo`, hashfiles[hash]!.content);
    }
    const compiled = await mo.wasm(`${entry}.mo`, "wasi");
    const wasmPath = path.join(temporary, `${index}.wasm`);
    await fs.writeFile(wasmPath, compiled.wasm);
    try {
      await execute(wasmtime, ["-W", "memory64=y", wasmPath]);
    } catch (error) {
      const output = String(
        (error as { stdout?: string }).stdout ??
          (error as { message?: string }).message ??
          error,
      );
      const match = output.match(/at ([a-f0-9]{64})\.mo:(\d+)/);
      if (match) {
        const source = hashfiles[match[1]!]?.content;
        const line = Number(match[2]);
        if (source) {
          console.error(
            source
              .split("\n")
              .slice(Math.max(0, line - 4), line + 3)
              .map((value, offset) => `${line - 3 + offset}: ${value}`)
              .join("\n"),
          );
        }
      }
      throw error;
    }
    console.log(`Motoko test passed: ${test}`);
  }
} finally {
  await disposeMotokoCompiler();
  await fs.rm(temporary, { recursive: true, force: true });
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
