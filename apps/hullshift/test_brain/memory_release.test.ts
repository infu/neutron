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

test("Hullshift 0.2.5 has no managed state to initialize or migrate", async () => {
  const [productionBytes, sourceText] = await Promise.all([
    readFile(new URL("../hullshift.v0.2.4.neutron", import.meta.url)),
    readFile(new URL("../neutron.json", import.meta.url), "utf8"),
  ]);
  expect(productionBytes.byteLength).toBe(424_471);
  expect(createHash("sha256").update(productionBytes).digest("hex")).toBe(
    "f39cf6ffd2e53ea8aa0ca1f9be525e999c95856d4e3c2b2a4f3586915271cbd2",
  );

  const production = packageManifest(productionBytes);
  const source = JSON.parse(sourceText) as NeutronManifest;
  expect(production).toMatchObject({ id: "hullshift", version: 204 });
  expect(source).toMatchObject({ id: "hullshift", version: 205 });
  expect(production.memory).toBeUndefined();
  expect(source.memory).toBeUndefined();

  const candidate = { ...production, ...source } as PackagedNeutronManifest;
  expect(planMemoryMigrations({ kernel }, { kernel, hullshift: candidate }))
    .toEqual({
      upgrades: [],
      removedApps: [],
      destructiveMemoryRoots: [],
    });
  expect(
    planMemoryMigrations(
      { kernel, hullshift: production },
      { kernel, hullshift: candidate },
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
