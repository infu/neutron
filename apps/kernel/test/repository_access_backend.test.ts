import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

test("repository access authenticates the owner, preserves Candid and refunds, and never retries uncertain requests", async () => {
  // Candid serialization plus async transport needs the compiled IC runtime.
  // Isolate the compiler and disposable PocketIC instance from other suites.
  const result = await promisify(execFile)(process.execPath, [
    path.join(import.meta.dir, "motoko/run_repository_access.ts"),
  ], { cwd: path.resolve(import.meta.dir, ".."), timeout: 180_000 });
  expect(result.stdout).toContain("Repository access IC test passed");
}, 190_000);
