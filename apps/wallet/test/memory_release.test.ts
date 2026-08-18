import { test } from "bun:test";
import { assertManagedMemoryCodeOnlyRelease } from "../../release-test-support/managed_memory.mjs";

test("Wallet 0.3.4 keeps the exact production v1 memory root", async () => {
  await assertManagedMemoryCodeOnlyRelease({
    appId: "wallet",
    memoryId: "wallet",
    productionArchive: new URL("../wallet.v0.3.2.neutron", import.meta.url),
    candidateArchive: new URL("../wallet.v0.3.4.neutron", import.meta.url),
    lock: new URL("../neutron.lock.json", import.meta.url),
    production: {
      version: 302,
      bytes: 575_530,
      sha256:
        "830e8cb4e59bcb73deed3024f704c373f6cce744ccf850efea65eac74b545b43",
    },
    candidateVersion: 304,
  });
});
