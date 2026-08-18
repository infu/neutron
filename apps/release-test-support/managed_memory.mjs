import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { unpackNeutronPackage } from "neutron-compiler/src/install.ts";
import { planMemoryMigrations } from "neutron-compiler/src/memory_migrations.ts";

const decoder = new TextDecoder();
const sentinelKernel = {
  format: 3,
  id: "kernel",
  name: "Kernel",
  version: 100,
  entry: "f".repeat(64),
};

export async function assertManagedMemoryCodeOnlyRelease(fixture) {
  const memoryVersion = fixture.memoryVersion ?? 1;
  const [productionBytes, candidateBytes, lockText] = await Promise.all([
    readFile(fixture.productionArchive),
    readFile(fixture.candidateArchive),
    readFile(fixture.lock, "utf8"),
  ]);

  expect(productionBytes.byteLength).toBe(fixture.production.bytes);
  expect(createHash("sha256").update(productionBytes).digest("hex")).toBe(
    fixture.production.sha256,
  );

  const production = packageManifest(productionBytes);
  const candidate = packageManifest(candidateBytes);
  expect(production).toMatchObject({
    format: 3,
    id: fixture.appId,
    version: fixture.production.version,
  });
  expect(candidate).toMatchObject({
    format: 3,
    id: fixture.appId,
    version: fixture.candidateVersion,
  });

  const productionMemory = production.memory?.[fixture.memoryId];
  const candidateMemory = candidate.memory?.[fixture.memoryId];
  if (productionMemory === undefined || candidateMemory === undefined) {
    throw new Error(
      `${fixture.appId} is missing managed memory ${fixture.memoryId}`,
    );
  }
  expect(candidateMemory).toEqual(productionMemory);
  expect(candidateMemory.version ?? 1).toBe(memoryVersion);

  const lock = JSON.parse(lockText);
  const lockedSchema =
    lock.memory?.[fixture.memoryId]?.schemas?.[String(memoryVersion)];
  if (lockedSchema === undefined) {
    throw new Error(
      `${fixture.appId} lock is missing ${fixture.memoryId} schema v${memoryVersion}`,
    );
  }
  expect(candidateMemory.schemas?.[String(memoryVersion)]).toMatchObject(
    lockedSchema,
  );

  expect(
    planMemoryMigrations(
      { kernel: sentinelKernel, [fixture.appId]: production },
      { kernel: sentinelKernel, [fixture.appId]: candidate },
    ),
  ).toEqual({
    upgrades: [
      {
        kind: "keep",
        owner: fixture.appId,
        memoryId: fixture.memoryId,
        version: memoryVersion,
      },
    ],
    removedApps: [],
    destructiveMemoryRoots: [],
  });
}

function packageManifest(bytes) {
  const unpacked = unpackNeutronPackage(bytes);
  const manifest = unpacked["neutron.json"];
  if (manifest === undefined) {
    throw new Error("Neutron package is missing neutron.json");
  }
  return JSON.parse(decoder.decode(manifest));
}
