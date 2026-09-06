import { test } from "bun:test";
import { assertManagedMemoryCodeOnlyRelease } from "../../release-test-support/managed_memory.mjs";

test("Agent 0.3.17 keeps the oldest production v1 memory root", async () => {
  await assertManagedMemoryCodeOnlyRelease({
    appId: "agent",
    memoryId: "agent",
    productionArchive: new URL("../agent.v0.3.1.neutron", import.meta.url),
    candidateArchive: new URL("../agent.v0.3.17.neutron", import.meta.url),
    lock: new URL("../neutron.lock.json", import.meta.url),
    production: {
      version: 301,
      bytes: 303_109,
      sha256: "544f072f49ae2b131e1159fc92444e732a02cce474336b5fb3f548dda72e7616",
    },
    candidateVersion: 317,
  });
});

test("Agent 0.3.17 keeps its immediate predecessor's v1 memory root", async () => {
  await assertManagedMemoryCodeOnlyRelease({
    appId: "agent",
    memoryId: "agent",
    productionArchive: new URL("../agent.v0.3.16.neutron", import.meta.url),
    candidateArchive: new URL("../agent.v0.3.17.neutron", import.meta.url),
    lock: new URL("../neutron.lock.json", import.meta.url),
    production: {
      version: 316,
      bytes: 511_061,
      sha256: "4386b050da92485ae3b4b05ac94fb49f989d4e6691c18a121a3cea6a68bdd73d",
    },
    candidateVersion: 317,
  });
});
