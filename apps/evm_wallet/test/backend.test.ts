import { test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runActors } from "./actor_run";

test("EVM backend journal, execution and recovery", async () => {
  await promisify(execFile)(process.execPath, [new URL("backend_run.ts", import.meta.url).pathname], { maxBuffer: 20 * 1024 * 1024 });
  await runActors(["test/backend_actor_test.mo", "test/token_evidence_actor_test.mo", "test/fee_estimate_test.mo"]);
}, 120_000);
