import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const testDirectory = import.meta.dir;
const packageRoot = path.dirname(testDirectory);
const testFiles = (await readdir(testDirectory))
  .filter((file) => file.endsWith(".test.ts"))
  .sort();

// Each process receives a fresh vendored Motoko compiler. Its virtual
// filesystem is process-global and its removeFile operation is not reliable,
// so sharing it across otherwise independent test files eventually retains
// enough compiler state to stall an unrelated test.
for (const testFile of testFiles) {
  const result = spawnSync(
    process.execPath,
    ["test", `./test/${testFile}`],
    { cwd: packageRoot, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
