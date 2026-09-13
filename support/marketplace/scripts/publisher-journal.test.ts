// All rights reserved. See ../LICENSE.
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { lockFirstPartyOperation } from "./publisher-journal.ts";

test("publish and promote exclude concurrent production writers across distinct journals", async () => {
  const canister = "rrkah-fqaaa-aaaaa-aaaaq-cai";
  const unlock = await lockFirstPartyOperation("publish", "beta", canister);
  try {
    const lock = JSON.parse(await readFile(path.resolve(import.meta.dir, `../../../.neutron/marketplace-publications/production-${canister}.lock`), "utf8"));
    expect(lock).toEqual({ pid: process.pid, operation: "publish", channel: "beta" });
    await expect(lockFirstPartyOperation("promote", "stable", canister)).rejects.toThrow("already being used");
  } finally { await unlock(); }
  const release = await lockFirstPartyOperation("promote", "stable", canister);
  await release();
});
