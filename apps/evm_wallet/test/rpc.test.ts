import { test } from "bun:test";
import { runActors } from "./actor_run";

test("EVM browser observation JSON preserves exact quantities and canonical shapes", async () => {
  await runActors(["test/rpc_test.mo"]);
}, 120_000);

test("EVM JSON handles complete deployed code and nested Unicode without losing bytes", async () => {
  await runActors(["test/json_large_response_test.mo"]);
}, 120_000);
