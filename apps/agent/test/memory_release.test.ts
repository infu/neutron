import { test } from "bun:test";
import { assertManagedMemoryCodeOnlyRelease } from "../../release-test-support/managed_memory.mjs";

test("Agent 0.3.8 keeps the oldest production v1 memory root", async () => {
  await assertManagedMemoryCodeOnlyRelease({
    appId: "agent",
    memoryId: "agent",
    productionArchive: new URL("../agent.v0.3.1.neutron", import.meta.url),
    candidateArchive: new URL("../agent.v0.3.8.neutron", import.meta.url),
    lock: new URL("../neutron.lock.json", import.meta.url),
    production: {
      version: 301,
      bytes: 303_109,
      sha256: "544f072f49ae2b131e1159fc92444e732a02cce474336b5fb3f548dda72e7616",
    },
    candidateVersion: 308,
  });
});

test("Agent 0.3.8 keeps its immediate predecessor's v1 memory root", async () => {
  await assertManagedMemoryCodeOnlyRelease({
    appId: "agent",
    memoryId: "agent",
    productionArchive: new URL("../agent.v0.3.7.neutron", import.meta.url),
    candidateArchive: new URL("../agent.v0.3.8.neutron", import.meta.url),
    lock: new URL("../neutron.lock.json", import.meta.url),
    production: {
      version: 307,
      bytes: 414_489,
      sha256: "933c7d9f2b6dd95934306dfd936bf9629de549fa673b3e72030c083f0a0b431e",
    },
    candidateVersion: 308,
  });
});
