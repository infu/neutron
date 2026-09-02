import { test } from "bun:test";
import { assertManagedMemoryCodeOnlyRelease } from "../../release-test-support/managed_memory.mjs";

test("Kitchen Sink 0.3.7 keeps the exact production 0.3.6 v1 memory root", async () => {
  await assertManagedMemoryCodeOnlyRelease({
    appId: "kitchensink",
    memoryId: "kitchensink",
    productionArchive: new URL(
      "../kitchensink.v0.3.6.neutron",
      import.meta.url,
    ),
    candidateArchive: new URL(
      "../kitchensink.v0.3.7.neutron",
      import.meta.url,
    ),
    lock: new URL("../neutron.lock.json", import.meta.url),
    production: {
      version: 306,
      bytes: 429_282,
      sha256: "31f447052918fbfb848a32f649af5c0098a043149d52d0e14f759b58a4743f2f",
    },
    candidateVersion: 307,
  });
});
