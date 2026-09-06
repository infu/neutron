import { test } from "bun:test";
import { runActors } from "./actor_run";

test("EVM RPC uses quoted cycles, explicit consensus and recoverable broadcast outcomes", async () => {
  await runActors(["test/rpc_test.mo"]);
}, 120_000);
