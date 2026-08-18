import { test } from "bun:test";
import { assertManagedMemoryCodeOnlyRelease } from "../../release-test-support/managed_memory.mjs";

test("Mail 0.3.3 keeps the exact production v1 memory root", async () => {
  await assertManagedMemoryCodeOnlyRelease({
    appId: "mail",
    memoryId: "mail",
    productionArchive: new URL("../mail.v0.3.2.neutron", import.meta.url),
    candidateArchive: new URL("../mail.v0.3.3.neutron", import.meta.url),
    lock: new URL("../neutron.lock.json", import.meta.url),
    production: {
      version: 302,
      bytes: 683_943,
      sha256:
        "826385b4f79ba6973b7e33e882bca03c4cfee4aa4930172e7ea18bf482cb52b9",
    },
    candidateVersion: 303,
  });
});
