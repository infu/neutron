import { test } from "bun:test";
import { assertManagedMemoryCodeOnlyRelease } from "../../release-test-support/managed_memory.mjs";

test("Kitchen Sink 0.3.11 keeps the exact production 0.3.10 v1 memory root", async () => {
  const productionArchive = new URL(
    "../kitchensink.v0.3.10.neutron",
    import.meta.url,
  );
  await assertManagedMemoryCodeOnlyRelease({
    appId: "kitchensink",
    memoryId: "kitchensink",
    productionArchive,
    candidateArchive: new URL(
      "../kitchensink.v0.3.11.neutron",
      import.meta.url,
    ),
    lock: new URL("../neutron.lock.json", import.meta.url),
    production: {
      version: 310,
      bytes: 430_618,
      sha256: "a9998e28ace0f3525bad787aa0f21ccaaf8389252d6f9bf7d063d36bd284d795",
    },
    candidateVersion: 311,
  });
});
