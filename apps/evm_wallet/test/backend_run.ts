import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { disposeMotokoCompiler, loadMotoko } from "neutron-motoko-wasm";
import { prepareMotokoProgram } from "neutron-scripts/src/motoko.js";
import { parsePackageString } from "neutron-scripts/src/walk.js";

const execute = promisify(execFile);
const appRoot = path.resolve(import.meta.dir, "..");
const requested = process.argv.slice(2);
const tests = requested.length ? requested : ["journal_test.mo", "backend_test.mo"];
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "evm-backend-test-"));
const sources = await execute("mops", ["sources"], { cwd: appRoot });
const packages = Object.fromEntries(Object.entries(parsePackageString(sources.stdout.replace(/\n/g, " ").trim())).map(([name, root]) => [name, path.resolve(appRoot, root)]));

async function wasmtimePath(): Promise<string> {
  if (process.env.WASMTIME) return process.env.WASMTIME;
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const executable = path.join(directory, "wasmtime");
    try { await fs.access(executable, fs.constants.X_OK); return executable; } catch {}
  }
  for (const entry of (await fs.readdir("/nix/store")).filter((entry) => entry.includes("-wasmtime-")).sort().reverse()) {
    const executable = path.join("/nix/store", entry, "bin/wasmtime");
    try { await fs.access(executable, fs.constants.X_OK); return executable; } catch {}
  }
  throw new Error("wasmtime is required for EVM cryptography tests");
}

try {
  const wasmtime = await wasmtimePath();
  const compiler = await loadMotoko();
  try {
    for (const test of tests) {
      if (!["journal_test.mo", "backend_test.mo"].includes(test)) throw new Error(`Unexpected backend test filename: ${test}`);
      const prepared = await prepareMotokoProgram({ compiler, sourcePath: path.join(appRoot, "test", test), packages, allowDangerous: true });
      const compiled = await compiler.wasm(prepared.entryPath, "wasi");
      const wasmPath = path.join(temporary, test.replace(/\.mo$/, ".wasm"));
      await fs.writeFile(wasmPath, compiled.wasm);
      const result = await execute(wasmtime, ["-W", "memory64=y", wasmPath]);
      if (result.stdout.trim()) console.log(result.stdout.trim());
      console.log(`EVM Motoko test passed: ${test}`);
    }
  } finally { await disposeMotokoCompiler(); }
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
