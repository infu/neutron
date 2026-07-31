import { Glob, spawn } from "bun";
import { resolve } from "node:path";

const filesRoot = resolve(import.meta.dir, "..");
const browserTests = Object.freeze([
  "test/files_ui_browser.test.ts",
  "test/worker_browser_release.test.ts",
]);
const browserTestSet = new Set(browserTests);

const tests: string[] = [];
for await (
  const path of new Glob("**/*.test.ts").scan({
    cwd: resolve(filesRoot, "test"),
    onlyFiles: true,
  })
) {
  tests.push(`test/${path}`);
}
tests.sort();

const ordinaryTests = tests.filter((path) => !browserTestSet.has(path));
if (ordinaryTests.length === 0) {
  throw new Error("Files TypeScript test discovery returned no ordinary tests");
}
for (const browserTest of browserTests) {
  if (!tests.includes(browserTest)) {
    throw new Error(`Files browser test is missing: ${browserTest}`);
  }
}

// Bun executes files in one invocation concurrently. Files has independent
// Chromium harnesses and ABI tests with isolated dynamic module graphs, so
// file-level serialization is part of the release test contract.
for (const testPath of [...ordinaryTests, ...browserTests]) {
  await run(["bun", "test", testPath]);
}

async function run(command: string[]): Promise<void> {
  const child = spawn(command, {
    cwd: filesRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
