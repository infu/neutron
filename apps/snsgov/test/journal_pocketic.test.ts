import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

test("SNS operation journal prevents concurrent resend and restores receipts across a real Wasm upgrade", async () => {
  // Isolate the compiler and the owned, disposable PocketIC process from other
  // suites. This test does not contact production or install an app package.
  const result = await promisify(execFile)(process.execPath, [
    path.join(import.meta.dir, "journal_pocketic_run.ts"),
  ], { cwd: path.resolve(import.meta.dir, ".."), timeout: 180_000 });
  expect(result.stdout).toContain("SNS journal PocketIC passed");
}, 190_000);
