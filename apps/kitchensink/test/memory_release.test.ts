import { test } from "bun:test";
import { assertManagedMemoryCodeOnlyRelease } from "../../release-test-support/managed_memory.mjs";

test("Kitchen Sink 0.3.15 keeps the exact production 0.3.10 v1 memory root across skipped releases", async () => {
  const productionArchive = new URL(
    "../kitchensink.v0.3.10.neutron",
    import.meta.url,
  );
  await assertManagedMemoryCodeOnlyRelease({
    appId: "kitchensink",
    memoryId: "kitchensink",
    productionArchive,
    candidateArchive: new URL(
      "../kitchensink.v0.3.15.neutron",
      import.meta.url,
    ),
    lock: new URL("../neutron.lock.json", import.meta.url),
    production: {
      version: 310,
      bytes: 430_618,
      sha256: "a9998e28ace0f3525bad787aa0f21ccaaf8389252d6f9bf7d063d36bd284d795",
    },
    candidateVersion: 315,
  });
});

test("Kitchen Sink 0.3.15 keeps the exact production 0.3.11 v1 memory root", async () => {
  await assertManagedMemoryCodeOnlyRelease({
    appId: "kitchensink",
    memoryId: "kitchensink",
    productionArchive: new URL("../kitchensink.v0.3.11.neutron", import.meta.url),
    candidateArchive: new URL("../kitchensink.v0.3.15.neutron", import.meta.url),
    lock: new URL("../neutron.lock.json", import.meta.url),
    production: {
      version: 311,
      bytes: 430_950,
      sha256: "4fb7f6fc74c29b05a95f4ce2f706d2f6cd8db4cd2dd9e840233b65e16acaa921",
    },
    candidateVersion: 315,
  });
});

test("Kitchen Sink 0.3.15 keeps the exact production 0.3.14 v1 memory root", async () => {
  await assertManagedMemoryCodeOnlyRelease({
    appId: "kitchensink",
    memoryId: "kitchensink",
    productionArchive: new URL("../kitchensink.v0.3.14.neutron", import.meta.url),
    candidateArchive: new URL("../kitchensink.v0.3.15.neutron", import.meta.url),
    lock: new URL("../neutron.lock.json", import.meta.url),
    production: {
      version: 314,
      bytes: 471_268,
      sha256: "e25c5230a91f2c99f72119e92c62204da5c13604785d018a358e57ea0a1bf18b",
    },
    candidateVersion: 315,
  });
});
