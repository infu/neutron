import { test } from "bun:test";
import { assertManagedMemoryCodeOnlyRelease } from "../../release-test-support/managed_memory.mjs";

test("Kitchen Sink 0.3.9 keeps the exact production 0.3.8 v1 memory root", async () => {
  const productionArchive = new URL(
    "../kitchensink.v0.3.8.neutron",
    import.meta.url,
  );
  await assertManagedMemoryCodeOnlyRelease({
    appId: "kitchensink",
    memoryId: "kitchensink",
    productionArchive,
    candidateArchive: new URL(
      "../kitchensink.v0.3.9.neutron",
      import.meta.url,
    ),
    lock: new URL("../neutron.lock.json", import.meta.url),
    production: {
      version: 308,
      bytes: 430_105,
      sha256: "b92d77a9dc9475116c04311cfad2114275ec264df32303937bdb65c693b6ea96",
    },
    candidateVersion: 309,
  });
});
