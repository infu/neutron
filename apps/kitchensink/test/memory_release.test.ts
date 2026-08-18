import { test } from "bun:test";
import { assertManagedMemoryCodeOnlyRelease } from "../../release-test-support/managed_memory.mjs";

test("Kitchen Sink 0.3.2 keeps the exact production v1 memory root", async () => {
  await assertManagedMemoryCodeOnlyRelease({
    appId: "kitchensink",
    memoryId: "kitchensink",
    productionArchive: new URL(
      "../kitchensink.v0.3.1.neutron",
      import.meta.url,
    ),
    candidateArchive: new URL(
      "../kitchensink.v0.3.2.neutron",
      import.meta.url,
    ),
    lock: new URL("../neutron.lock.json", import.meta.url),
    production: {
      version: 301,
      bytes: 372_478,
      sha256: "ea44590c1c7fca912e7b2957812fa42e1ad5853bddcdb016830ab8e0022a74ca",
    },
    candidateVersion: 302,
  });
});
