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

test("My Subnet 0.3.4 has no managed state to initialize or migrate", async () => {
  const [productionBytes, sourceText] = await Promise.all([
    readFile(new URL("../mysubnet.v0.3.1.neutron", import.meta.url)),
    readFile(new URL("../neutron.json", import.meta.url), "utf8"),
  ]);
  expect(productionBytes.byteLength).toBe(313_999);
  expect(createHash("sha256").update(productionBytes).digest("hex")).toBe(
    "e99733fa5e219d476b44d9b4a34083fa04af8885b268cf8ab40ff83008ab8589",
  );

  const production = packageManifest(productionBytes);
  const source = JSON.parse(sourceText) as NeutronManifest;
  expect(production).toMatchObject({ id: "mysubnet", version: 301 });
  expect(source).toMatchObject({ id: "mysubnet", version: 304 });
  expect(production.memory).toBeUndefined();
  expect(source.memory).toBeUndefined();

  const candidate = { ...production, ...source } as PackagedNeutronManifest;
  expect(planMemoryMigrations({ kernel }, { kernel, mysubnet: candidate }))
    .toEqual({
      upgrades: [],
      removedApps: [],
      destructiveMemoryRoots: [],
    });
  expect(
    planMemoryMigrations(
      { kernel, mysubnet: production },
      { kernel, mysubnet: candidate },
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
