import { test } from "bun:test";
import { runActors } from "./actor_run";

test("EVM RPC uses quoted cycles, explicit consensus and recoverable broadcast outcomes", async () => {
  await runActors(["test/rpc_test.mo"]);
}, 120_000);

test("EVM RPC compares complete deployed code and nested JSON without overflowing text ropes", async () => {
  await runActors(["test/rpc_large_response_test.mo"]);
}, 120_000);
