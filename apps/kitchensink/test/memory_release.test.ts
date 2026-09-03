import { test } from "bun:test";
import { assertManagedMemoryCodeOnlyRelease } from "../../release-test-support/managed_memory.mjs";

test("Kitchen Sink 0.3.8 keeps the exact production 0.3.7 v1 memory root", async () => {
  const productionArchive = new URL(
    "../kitchensink.v0.3.7.neutron",
    import.meta.url,
  );
  await assertManagedMemoryCodeOnlyRelease({
    appId: "kitchensink",
    memoryId: "kitchensink",
    productionArchive,
    candidateArchive: new URL(
      "../kitchensink.v0.3.8.neutron",
      import.meta.url,
    ),
    lock: new URL("../neutron.lock.json", import.meta.url),
    production: {
      version: 307,
      bytes: 430_099,
      sha256: "5610bd8d4ae94bb7caa9e38841561913efa09b800b7b17bff1c3b2bb154cdb50",
    },
    candidateVersion: 308,
  });
});
