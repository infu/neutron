import { test } from "bun:test";
import { assertManagedMemoryCodeOnlyRelease } from "../../release-test-support/managed_memory.mjs";

test("Hello 0.2.3 keeps the exact production v1 memory root", async () => {
  await assertManagedMemoryCodeOnlyRelease({
    appId: "hello",
    memoryId: "hello",
    productionArchive: new URL("../hello.v0.2.1.neutron", import.meta.url),
    candidateArchive: new URL("../hello.v0.2.3.neutron", import.meta.url),
    lock: new URL("../neutron.lock.json", import.meta.url),
    production: {
      version: 201,
      bytes: 185_021,
      sha256: "82613cc3882c7404e51e09308e27a4885062f5f622663becf18cca0a046b8c27",
    },
    candidateVersion: 203,
  });
});
