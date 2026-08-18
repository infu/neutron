import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
  disposeMotokoCompiler,
  loadMotoko,
} from "neutron-motoko-wasm";
import { prepareMotokoProgram } from "./motoko.js";
import { parsePackageString } from "./walk.js";

const execute = promisify(execFile);
export async function runMotokoProgram(
  requestedTests: string[],
  appRoot = process.cwd(),
): Promise<void> {
  if (requestedTests.length === 0) {
    throw new Error("Usage: run_motoko_program.ts <test.mo> [test.mo ...]");
  }

  const testPaths = requestedTests.map((requested) => {
    const testPath = path.resolve(appRoot, requested);
    const relative = path.relative(appRoot, testPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Motoko test must stay inside ${appRoot}: ${requested}`);
    }
    return { requested, testPath };
  });

  // Mops only resolves the declared package roots. Compilation and execution
  // use the repository's browser compiler rather than a host `moc` toolchain.
  const sourceOutput = await execute("mops", ["sources"], { cwd: appRoot });
  const packages = Object.fromEntries(
    Object.entries(
      parsePackageString(sourceOutput.stdout.replace(/\n/g, " ").trim()),
    ).map(([name, packageRoot]) => [
      name,
      path.resolve(appRoot, packageRoot),
    ]),
  );
  const compiler = await loadMotoko();

  try {
    for (const { requested, testPath } of testPaths) {
      const prepared = await prepareMotokoProgram({
        compiler,
        sourcePath: testPath,
        packages,
        allowDangerous: true,
      });
      await compiler.run(prepared.entryPath);
      console.log(`Browser Motoko test passed: ${requested}`);
    }
  } finally {
    await disposeMotokoCompiler();
  }
}

if (import.meta.main) {
  runMotokoProgram(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
