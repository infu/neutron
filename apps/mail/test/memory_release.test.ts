import { test } from "bun:test";
import { assertManagedMemoryCodeOnlyRelease } from "../../release-test-support/managed_memory.mjs";

test("Mail 0.3.5 keeps the exact production v1 memory root", async () => {
  await assertManagedMemoryCodeOnlyRelease({
    appId: "mail",
    memoryId: "mail",
    productionArchive: new URL("../mail.v0.3.2.neutron", import.meta.url),
    candidateArchive: new URL("../mail.v0.3.5.neutron", import.meta.url),
    lock: new URL("../neutron.lock.json", import.meta.url),
    production: {
      version: 302,
      bytes: 683_943,
      sha256:
        "826385b4f79ba6973b7e33e882bca03c4cfee4aa4930172e7ea18bf482cb52b9",
    },
    candidateVersion: 305,
  });
});

test("Mail 0.3.6 keeps the exact production 0.3.5 root across the source transition", async () => {
  await assertManagedMemoryCodeOnlyRelease({
    appId: "mail",
    memoryId: "mail",
    memoryVersion: 1,
    productionArchive: new URL("../mail.v0.3.5.neutron", import.meta.url),
    candidateArchive: new URL("../mail.v0.3.6.neutron", import.meta.url),
    lock: new URL("../neutron.lock.json", import.meta.url),
    production: {
      version: 305,
      bytes: 724878,
      sha256: "d82e7251b67ed250e47e730df49cea4e88f27ec9187de3033abe5a923b7ecdd1",
    },
    candidateVersion: 306,
  });
});
