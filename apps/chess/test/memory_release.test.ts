import { test } from "bun:test";
import { assertManagedMemoryCodeOnlyRelease } from "../../release-test-support/managed_memory.mjs";

test("Chess 0.3.2 keeps the exact production v1 memory root", async () => {
  await assertManagedMemoryCodeOnlyRelease({
    appId: "chess",
    memoryId: "chess",
    productionArchive: new URL("../chess.v0.3.1.neutron", import.meta.url),
    candidateArchive: new URL("../chess.v0.3.2.neutron", import.meta.url),
    lock: new URL("../neutron.lock.json", import.meta.url),
    production: {
      version: 301,
      bytes: 252_940,
      sha256: "203989a0cb4c8299989c3a0365d691303419a367348216dfc6ffd44bc671a834",
    },
    candidateVersion: 302,
  });
});
