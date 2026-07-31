import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
  disposeMotokoCompiler,
  loadMotoko,
} from "neutron-motoko-wasm";
import { prepareMotokoProgram } from "neutron-scripts/src/motoko.js";
import { parsePackageString } from "neutron-scripts/src/walk.js";

const execute = promisify(execFile);
const cwd = path.resolve(import.meta.dir, "../..");
const sourceOutput = await execute("mops", ["sources"], { cwd });
const packages = parsePackageString(
  sourceOutput.stdout.replace(/\n/g, " ").trim(),
);
const mo = await loadMotoko();

try {
  const prepared = await prepareMotokoProgram({
    compiler: mo,
    sourcePath: path.join(cwd, "test/motoko/repository_test.mo"),
    packages,
    allowDangerous: true,
  });
  await mo.run(prepared.entryPath);
  console.log("Motoko test passed: repository_test.mo");
} finally {
  await disposeMotokoCompiler();
}
