import { test } from "bun:test";
import { assertManagedMemoryCodeOnlyRelease } from "../../release-test-support/managed_memory.mjs";

test("Files 0.4.5 keeps the exact production v2 memory root", async () => {
  await assertManagedMemoryCodeOnlyRelease({
    appId: "files",
    memoryId: "files",
    memoryVersion: 2,
    productionArchive: new URL("../files.v0.4.3.neutron", import.meta.url),
    candidateArchive: new URL("../files.v0.4.5.neutron", import.meta.url),
    lock: new URL("../neutron.lock.json", import.meta.url),
    production: {
      version: 403,
      bytes: 709_431,
      sha256:
        "b05c5c88d7705cefc2026478002a372f778fe4430f946663bba3003a82f8348d",
    },
    candidateVersion: 405,
  });
});
