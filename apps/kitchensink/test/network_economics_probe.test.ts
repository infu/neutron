import { test } from "bun:test";
import path from "node:path";
import { runActors } from "../../icpswap/test/actor_run";

test("backend probe reads the NNS network economics response through its exact reservation", async () => {
  await runActors(["test/network_economics_probe_actor.test.mo"], path.resolve(import.meta.dir, ".."));
}, 120_000);
