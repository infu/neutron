import { test } from "bun:test";
import { assertManagedMemoryCodeOnlyRelease } from "../../release-test-support/managed_memory.mjs";

test("Contacts 0.3.5 keeps the exact production 0.3.4 v2 memory root", async () => {
  await assertManagedMemoryCodeOnlyRelease({
    appId: "contacts",
    memoryId: "contacts",
    memoryVersion: 2,
    productionArchive: new URL("../contacts.v0.3.4.neutron", import.meta.url),
    candidateArchive: new URL("../contacts.v0.3.5.neutron", import.meta.url),
    lock: new URL("../neutron.lock.json", import.meta.url),
    production: {
      version: 304,
      bytes: 284_475,
      sha256:
        "8068c5e4df862c2e7cbf627eb62e00c1dbed79f1bfbeb18d0868ab8123f4196b",
    },
    candidateVersion: 305,
  });
});
