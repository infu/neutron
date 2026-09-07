import { test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runActors } from "./actor_run";

test("EVM backend journal, execution and recovery", async () => {
  await promisify(execFile)(process.execPath, [new URL("backend_run.ts", import.meta.url).pathname], { maxBuffer: 20 * 1024 * 1024 });
  await runActors(["test/backend_actor_test.mo", "test/token_evidence_actor_test.mo"]);
}, 120_000);

test("EVM pending replacements retain browser-estimated gas and original nonce", async () => {
  await runActors(["test/estimate_block_actor_test.mo"]);
}, 120_000);

test("EVM interrupted preparation refreshes implicit fees while preserving exact requests and review revisions", async () => {
  await runActors(["test/preparation_refresh_actor_test.mo"]);
}, 120_000);
