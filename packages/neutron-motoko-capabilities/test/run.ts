import path from "node:path";
import {
  disposeMotokoCompiler,
  loadMotoko,
} from "neutron-motoko-wasm";
import { prepareMotokoProgram } from "neutron-scripts/src/motoko.js";

const packageRoot = path.resolve(import.meta.dir, "..");
const tests = ["lib.test.mo", "certified_assets_v2.test.mo"];
const mo = await loadMotoko();

try {
  for (const test of tests) {
    const prepared = await prepareMotokoProgram({
      compiler: mo,
      sourcePath: path.join(packageRoot, "test", test),
      allowDangerous: true,
    });
    await mo.run(prepared.entryPath);
    console.log(`Motoko test passed: ${test}`);
  }
} finally {
  await disposeMotokoCompiler();
}
