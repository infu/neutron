import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { unpackNeutronPackage } from "neutron-compiler/src/install.ts";
import { planMemoryMigrations } from "neutron-compiler/src/memory_migrations.ts";
import type {
  NeutronManifest,
  PackagedNeutronManifest,
} from "neutron-tools/src/schema.js";

type Fixture = Readonly<{
  archive: URL;
  bytes: number;
  id: "vetkeys_fixture" | "vetkeys_fixture_peer";
  manifest: URL;
  sha256: string;
}>;

const decoder = new TextDecoder();
const kernel: PackagedNeutronManifest = {
  format: 3,
  id: "kernel",
  name: "Kernel",
  version: 100,
  entry: "f".repeat(64),
};
const fixtures: readonly Fixture[] = [
  {
    archive: new URL("../vetkeys_fixture.v0.1.0.neutron", import.meta.url),
    bytes: 137_448,
    id: "vetkeys_fixture",
    manifest: new URL("../neutron.json", import.meta.url),
    sha256:
      "daa7c270690ea923f7fc994cd15e2e943473967a1eddbec71c0cd5e399cef963",
  },
  {
    archive: new URL(
      "../vetkeys_fixture_peer.v0.1.0.neutron",
      import.meta.url,
    ),
    bytes: 137_473,
    id: "vetkeys_fixture_peer",
    manifest: new URL("../peer/neutron.json", import.meta.url),
    sha256:
      "2e63189d2f4b2250799602bd4a24f731270a19c570701d1790e67e260792d662",
  },
];

test("vetKeys 0.1.2 fixtures have no managed state to initialize or migrate", async () => {
  const installed: Record<string, PackagedNeutronManifest> = { kernel };
  const target: Record<string, PackagedNeutronManifest> = { kernel };

  for (const fixture of fixtures) {
    const [productionBytes, sourceText] = await Promise.all([
      readFile(fixture.archive),
      readFile(fixture.manifest, "utf8"),
    ]);
    expect(productionBytes.byteLength).toBe(fixture.bytes);
    expect(createHash("sha256").update(productionBytes).digest("hex")).toBe(
      fixture.sha256,
    );

    const production = packageManifest(productionBytes);
    const source = JSON.parse(sourceText) as NeutronManifest;
    expect(production).toMatchObject({ id: fixture.id, version: 100 });
    expect(source).toMatchObject({ id: fixture.id, version: 102 });
    expect(production.memory).toBeUndefined();
    expect(source.memory).toBeUndefined();

    installed[fixture.id] = production;
    target[fixture.id] = {
      ...production,
      ...source,
    } as PackagedNeutronManifest;
  }

  expect(planMemoryMigrations({ kernel }, target)).toEqual({
    upgrades: [],
    removedApps: [],
    destructiveMemoryRoots: [],
  });
  expect(planMemoryMigrations(installed, target)).toEqual({
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
