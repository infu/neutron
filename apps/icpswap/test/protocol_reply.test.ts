import { test } from "bun:test";
import { runActors } from "./actor_run";

test("ICPSwap mutation reply decoding survives malformed Candid without losing an outcome", async () => {
    await runActors(["test/protocol_reply_actor.test.mo"]);
}, 120_000);
