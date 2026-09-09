import { test } from "bun:test";
import { assertManagedMemoryCodeOnlyRelease } from "../../release-test-support/managed_memory.mjs";

test("Agent 0.3.20 keeps the oldest production v1 memory root", async () => {
  await assertManagedMemoryCodeOnlyRelease({
    appId: "agent",
    memoryId: "agent",
    productionArchive: new URL("../agent.v0.3.1.neutron", import.meta.url),
    candidateArchive: new URL("../agent.v0.3.20.neutron", import.meta.url),
    lock: new URL("../neutron.lock.json", import.meta.url),
    production: {
      version: 301,
      bytes: 303_109,
      sha256: "544f072f49ae2b131e1159fc92444e732a02cce474336b5fb3f548dda72e7616",
    },
    candidateVersion: 320,
  });
});

test("Agent 0.3.20 keeps the production 0.3.17 v1 memory root", async () => {
  await assertManagedMemoryCodeOnlyRelease({
    appId: "agent",
    memoryId: "agent",
    productionArchive: new URL("../agent.v0.3.17.neutron", import.meta.url),
    candidateArchive: new URL("../agent.v0.3.20.neutron", import.meta.url),
    lock: new URL("../neutron.lock.json", import.meta.url),
    production: {
      version: 317,
      bytes: 511_078,
      sha256: "fd1cc607c8e2c666415baa0594e415e76c71f6f71d992fea728290c22e520d9d",
    },
    candidateVersion: 320,
  });
});

test("Agent 0.3.20 keeps the production 0.3.18 v1 memory root", async () => {
  await assertManagedMemoryCodeOnlyRelease({
    appId: "agent",
    memoryId: "agent",
    productionArchive: new URL("../agent.v0.3.18.neutron", import.meta.url),
    candidateArchive: new URL("../agent.v0.3.20.neutron", import.meta.url),
    lock: new URL("../neutron.lock.json", import.meta.url),
    production: {
      version: 318,
      bytes: 513_437,
      sha256: "6d02e4098e22abf3089c773abdd0b6c20b876ad7f6c3eab35ddac21bb1527568",
    },
    candidateVersion: 320,
  });
});


test("Agent 0.3.20 keeps its immediate predecessor's v1 memory root", async () => {
  await assertManagedMemoryCodeOnlyRelease({
    appId: "agent",
    memoryId: "agent",
    productionArchive: new URL("../agent.v0.3.19.neutron", import.meta.url),
    candidateArchive: new URL("../agent.v0.3.20.neutron", import.meta.url),
    lock: new URL("../neutron.lock.json", import.meta.url),
    production: {
      version: 319,
      bytes: 526_738,
      sha256: "6ff77a15604d42cef035cf30792d6b635fbbafcc10c91b0c0c582a9f6859edf4",
    },
    candidateVersion: 320,
  });
});
