import { test } from "bun:test";
import { assertManagedMemoryCodeOnlyRelease } from "../../release-test-support/managed_memory.mjs";

test("Contacts 0.3.2 keeps the exact production v2 memory root", async () => {
  await assertManagedMemoryCodeOnlyRelease({
    appId: "contacts",
    memoryId: "contacts",
    memoryVersion: 2,
    productionArchive: new URL("../contacts.v0.3.1.neutron", import.meta.url),
    candidateArchive: new URL("../contacts.v0.3.2.neutron", import.meta.url),
    lock: new URL("../neutron.lock.json", import.meta.url),
    production: {
      version: 301,
      bytes: 253_319,
      sha256:
        "19591c8db038db92c182b70ce0761e855efc1e7e7f37d3b1503866baa11d097a",
    },
    candidateVersion: 302,
  });
});
