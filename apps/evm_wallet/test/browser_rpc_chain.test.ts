import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

test("browser helpers prepare and broadcast real local native/ERC20 transactions with durable lost-reply recovery", async () => {
  const result = await promisify(execFile)(process.execPath, [path.join(import.meta.dir, "browser_rpc_chain_run.ts")], { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
  expect(result.stdout).toContain("Browser/actor/Anvil integration passed");
}, 190_000);
