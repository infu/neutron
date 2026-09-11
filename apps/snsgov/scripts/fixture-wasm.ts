import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { disposeMotokoCompiler, loadMotoko } from "neutron-motoko-wasm";
import { prepareMotokoProgram } from "neutron-scripts/src/motoko.js";
import { parsePackageString } from "neutron-scripts/src/walk.js";

export async function compileNeutronFixture(): Promise<Uint8Array> {
  const root = path.resolve(import.meta.dir, "..");
  const { stdout } = await promisify(execFile)("mops", ["sources"], { cwd: root });
  const packages = Object.fromEntries(Object.entries(parsePackageString(stdout.replace(/\n/g, " ").trim())).map(([name, directory]) => [name, path.resolve(root, directory)]));
  const compiler = await loadMotoko();
  try {
    await compiler.configurePersistence("enhanced");
    const program = await prepareMotokoProgram({ compiler, sourcePath: path.join(import.meta.dir, "fixtures/SnsNeutron.mo"), packages, allowDangerous: true });
    return (await compiler.wasm(program.entryPath, "ic")).wasm;
  } finally { await disposeMotokoCompiler(); }
}
