import { test } from "bun:test";
import { runActors } from "./actor_run";

test("liquidity effects retain exact intents, funding and uncertain outcomes across restoration", async () => {
  await runActors(["test/liquidity_backend_actor_test.mo"]);
}, 120_000);
