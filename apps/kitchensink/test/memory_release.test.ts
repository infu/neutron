import { test } from "bun:test";
import { assertManagedMemoryCodeOnlyRelease } from "../../release-test-support/managed_memory.mjs";

test("Kitchen Sink 0.3.10 keeps the exact production 0.3.9 v1 memory root", async () => {
  const productionArchive = new URL(
    "../kitchensink.v0.3.9.neutron",
    import.meta.url,
  );
  await assertManagedMemoryCodeOnlyRelease({
    appId: "kitchensink",
    memoryId: "kitchensink",
    productionArchive,
    candidateArchive: new URL(
      "../kitchensink.v0.3.10.neutron",
      import.meta.url,
    ),
    lock: new URL("../neutron.lock.json", import.meta.url),
    production: {
      version: 309,
      bytes: 430_587,
      sha256: "d4810fa66040bd8b7a9f6973bfa427e8a17f0367cf5a463595417833d96c7c7b",
    },
    candidateVersion: 310,
  });
});
