import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  disposeMotokoCompiler,
  loadMotoko,
} from "neutron-motoko-wasm";
import { prepareMotokoProgram } from "neutron-scripts/src/motoko.js";
import { parsePackageString } from "neutron-scripts/src/walk.js";

const execute = promisify(execFile);
const appRoot = path.resolve(import.meta.dir, "../..");
const testRoot = path.join(appRoot, "test");
const testFiles = await fs.readdir(testRoot);
const interpretedTests = testFiles
  .filter((file) => file.endsWith(".test.mo"))
  .sort();
const compiledTests = testFiles
  .filter((file) => file.endsWith(".wasi.mo"))
  .sort();
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "chess-motoko-test-"));

try {
  const sourceOutput = await execute("mops", ["sources"], { cwd: appRoot });
  const packages = Object.fromEntries(
    Object.entries(
      parsePackageString(sourceOutput.stdout.replace(/\n/g, " ").trim()),
    ).map(([name, packageRoot]) => [
      name,
      path.resolve(appRoot, packageRoot),
    ]),
  );
  const mo = await loadMotoko();

  for (const test of interpretedTests) {
    const prepared = await prepareMotokoProgram({
      compiler: mo,
      sourcePath: path.join(testRoot, test),
      packages,
      allowDangerous: true,
    });
    await mo.run(prepared.entryPath);
    console.log(`Motoko test passed: ${test}`);
  }

  for (const [index, test] of compiledTests.entries()) {
    const prepared = await prepareMotokoProgram({
      compiler: mo,
      sourcePath: path.join(testRoot, test),
      packages,
      allowDangerous: true,
    });
    const compiled = await mo.wasm(prepared.entryPath, "wasi");
    const wasmPath = path.join(temporary, `${index}.wasm`);
    await fs.writeFile(wasmPath, compiled.wasm);
    await execute(
      "node",
      ["--no-warnings", "scripts/run_wasi.mjs", wasmPath],
      { cwd: appRoot },
    );
    console.log(`Motoko test passed: ${test}`);
  }
} finally {
  await disposeMotokoCompiler();
  await fs.rm(temporary, { recursive: true, force: true });
}
