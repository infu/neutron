// All rights reserved. See ../LICENSE.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { main, promotionExecuteCommand } from "./promote-catalog.ts";

test("printed execution command preserves the reviewed target, request and literal file paths", () => {
  const input = { appIds: ["kernel", "wallet"], catalog: "/tmp/owner's beta/catalog.json", journal: "/tmp/$(printf wrong)/journal.json", requestId: "reviewed-request", host: "http://127.0.0.1:4943", rootKeyFile: "/tmp/root `printf wrong`.der" };
  const command = promotionExecuteCommand(input);
  // Capture the argv through a local function, without invoking npm or a replica.
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", `npm() { printf '%s\\0' "$@"; }\n${command}`], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout.split("\0").slice(0, -1)).toEqual(["run", "updates:promote", "--", "kernel", "wallet", "--catalog", input.catalog, "--journal", input.journal, "--request", input.requestId, "--host", input.host, "--root-key", input.rootKeyFile, "--execute"]);
});

test("promotion has no implicit all-app selection", async () => {
  await expect(main([])).rejects.toThrow("Select explicit app IDs");
});
