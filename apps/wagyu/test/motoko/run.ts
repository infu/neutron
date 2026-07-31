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
const testRoot = import.meta.dir;
const appRoot = path.resolve(testRoot, "../..");

async function discoverTests(directory: string): Promise<string[]> {
  const tests: string[] = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });

  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      tests.push(...await discoverTests(candidate));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith("_test.mo") || entry.name.endsWith(".test.mo"))
    ) {
      tests.push(candidate);
    }
  }

  return tests;
}

const requestedTests = new Set(process.argv.slice(2));
const tests = (await discoverTests(testRoot)).filter((test) =>
  requestedTests.size === 0 ||
  requestedTests.has(path.relative(testRoot, test)) ||
  requestedTests.has(path.basename(test))
);
if (tests.length === 0) {
  throw new Error(`No Motoko tests found under ${testRoot}`);
}

process.chdir(appRoot);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wagyu-motoko-test-"));

try {
  const sourceOutput = await execute("mops", ["sources"], { cwd: appRoot });
  const packages = parsePackageString(
    sourceOutput.stdout.replace(/\n/g, " ").trim(),
  );
  const wasmtime = await resolveWasmtime();
  const mo = await loadMotoko();

  for (const [index, test] of tests.entries()) {
    const hashfiles: HashFiles = {};
    const cache: DependencyCache = {};
    const dependencies = await getDependencies(
      null,
      test,
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
    const relativeTest = path.relative(testRoot, test);
    // The first ordinary call lazily timestamps the local installation
    // context. Motoko's WASI target has no system clock, so retain full
    // compilation coverage here; pure planner tests execute profile values.
    if (relativeTest === "main_compile_test.mo") {
      console.log(`Motoko compile test passed: ${relativeTest}`);
      continue;
    }
    const wasmPath = path.join(temporary, `${index}.wasm`);
    await fs.writeFile(wasmPath, compiled.wasm);
    await execute(wasmtime, ["-W", "memory64=y", wasmPath]);
    console.log(
      `Motoko test passed: ${relativeTest}`,
    );
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
