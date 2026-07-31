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
const cwd = process.cwd();
const testRoot = path.resolve("test/motoko");
const testFile = process.argv[2] ?? "migration_test.mo";
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "contacts-motoko-test-"));

try {
  const sourceOutput = await execute("mops", ["sources"], { cwd });
  const packages = parsePackageString(
    sourceOutput.stdout.replace(/\n/g, " ").trim(),
  );
  const wasmtime = await resolveWasmtime();
  const mo = await loadMotoko();
  const hashfiles: HashFiles = {};
  const cache: DependencyCache = {};
  const dependencies = await getDependencies(
    null,
    path.join(testRoot, testFile),
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
  const wasmPath = path.join(temporary, "contacts_test.wasm");
  await fs.writeFile(wasmPath, compiled.wasm);
  await execute(wasmtime, ["-W", "memory64=y", wasmPath]);
  console.log(`Motoko test passed: ${testFile}`);
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
  throw new Error("wasmtime is required to execute Motoko unit tests");
}
