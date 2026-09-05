import { test } from "bun:test";
import { assertManagedMemoryCodeOnlyRelease } from "../../release-test-support/managed_memory.mjs";

test("Agent 0.3.10 keeps the oldest production v1 memory root", async () => {
  await assertManagedMemoryCodeOnlyRelease({
    appId: "agent",
    memoryId: "agent",
    productionArchive: new URL("../agent.v0.3.1.neutron", import.meta.url),
    candidateArchive: new URL("../agent.v0.3.10.neutron", import.meta.url),
    lock: new URL("../neutron.lock.json", import.meta.url),
    production: {
      version: 301,
      bytes: 303_109,
      sha256: "544f072f49ae2b131e1159fc92444e732a02cce474336b5fb3f548dda72e7616",
    },
    candidateVersion: 310,
  });
});

test("Agent 0.3.10 keeps its immediate predecessor's v1 memory root", async () => {
  await assertManagedMemoryCodeOnlyRelease({
    appId: "agent",
    memoryId: "agent",
    productionArchive: new URL("../agent.v0.3.9.neutron", import.meta.url),
    candidateArchive: new URL("../agent.v0.3.10.neutron", import.meta.url),
    lock: new URL("../neutron.lock.json", import.meta.url),
    production: {
      version: 309,
      bytes: 497_726,
      sha256: "deb0f9c490b55ec16aec6a4344f13c66f1e2e6021cb6f048f4f07dfa21c8f933",
    },
    candidateVersion: 310,
  });
});
