import { test } from "bun:test";
import { runActors } from "./actor_run";

test("Nuance publish responses preserve concurrent draft edits and deletion", async () => {
  await runActors(["test/publish_actor.test.mo"]);
}, 120_000);
