import path from "node:path";
import { test } from "bun:test";
import { runActors } from "./actor_run";

test("saved ICPSwap swap plans dispatch once and preserve recovery evidence", async () => {
  await runActors(["test/swap_actions.test.mo"], path.resolve(import.meta.dir, ".."));
}, 120_000);

test("legacy ICPSwap swap IDs retain outcomes and cannot dispatch twice", async () => {
  await runActors(["test/legacy_swap_actor.test.mo"], path.resolve(import.meta.dir, ".."));
}, 120_000);
