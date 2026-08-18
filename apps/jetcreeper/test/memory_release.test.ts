import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { unpackNeutronPackage } from "neutron-compiler/src/install.ts";
import { planMemoryMigrations } from "neutron-compiler/src/memory_migrations.ts";
import type {
  NeutronManifest,
  PackagedNeutronManifest,
} from "neutron-tools/src/schema.js";

const decoder = new TextDecoder();
const kernel: PackagedNeutronManifest = {
  format: 3,
  id: "kernel",
  name: "Kernel",
  version: 100,
  entry: "f".repeat(64),
};

test("Jetcreeper 0.3.4 has no managed state to initialize or migrate", async () => {
  const [productionBytes, sourceText] = await Promise.all([
    readFile(new URL("../jetcreeper.v0.3.1.neutron", import.meta.url)),
    readFile(new URL("../neutron.json", import.meta.url), "utf8"),
  ]);
  expect(productionBytes.byteLength).toBe(300_389);
  expect(createHash("sha256").update(productionBytes).digest("hex")).toBe(
    "a24ae6f9c4ad609bd16afcead0da49245bd36f6303d959ddd1229fa2b8eb1275",
  );

  const production = packageManifest(productionBytes);
  const source = JSON.parse(sourceText) as NeutronManifest;
  expect(production).toMatchObject({ id: "jetcreeper", version: 301 });
  expect(source).toMatchObject({ id: "jetcreeper", version: 304 });
  expect(production.memory).toBeUndefined();
  expect(source.memory).toBeUndefined();

  const candidate = { ...production, ...source } as PackagedNeutronManifest;
  expect(planMemoryMigrations({ kernel }, { kernel, jetcreeper: candidate }))
    .toEqual({
      upgrades: [],
      removedApps: [],
      destructiveMemoryRoots: [],
    });
  expect(
    planMemoryMigrations(
      { kernel, jetcreeper: production },
      { kernel, jetcreeper: candidate },
    ),
  ).toEqual({
    upgrades: [],
    removedApps: [],
    destructiveMemoryRoots: [],
  });
});

function packageManifest(bytes: Uint8Array): PackagedNeutronManifest {
  const manifest = unpackNeutronPackage(bytes)["neutron.json"];
  if (manifest === undefined) throw new Error("Missing packaged manifest");
  return JSON.parse(decoder.decode(manifest)) as PackagedNeutronManifest;
}
