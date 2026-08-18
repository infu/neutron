import { test } from "bun:test";
import { assertManagedMemoryCodeOnlyRelease } from "../../release-test-support/managed_memory.mjs";

test("Gemma 0.2.3 keeps the exact production v1 memory root", async () => {
  await assertManagedMemoryCodeOnlyRelease({
    appId: "gemma",
    memoryId: "gemma",
    productionArchive: new URL("../gemma.v0.2.1.neutron", import.meta.url),
    candidateArchive: new URL("../gemma.v0.2.3.neutron", import.meta.url),
    lock: new URL("../neutron.lock.json", import.meta.url),
    production: {
      version: 201,
      bytes: 146_687,
      sha256: "070cae4c5908ddca0faba0b4d1da55bbe10539b5f680b45f80659008edd3781e",
    },
    candidateVersion: 203,
  });
});
