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
  "envelope_test.mo",
  "memory_test.mo",
  "main_compile_test.mo",
  "key_info_test.mo",
  "remote_wire_test.mo",
  "receive_test.mo",
  "store_compile_test.mo",
  "recipients_test.mo",
  "settings_test.mo",
  "crypto_compile_test.mo",
  "crypto_call_test.mo",
  "crypto_setup_test.mo",
  "crypto_rewrap_test.mo",
  "delivery_compile_test.mo",
  "delivery_test.mo",
  "contacts_integrity_test.mo",
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
process.chdir(appRoot);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "mail-motoko-test-"));

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
    await execute(wasmtime, ["-W", "memory64=y", wasmPath]);
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
