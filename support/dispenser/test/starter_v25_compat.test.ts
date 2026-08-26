import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  LEGACY_V25_ASSEMBLER_ID,
} from "neutron-compiler/src/assemble.js";
import { BROWSER_SURFACE_ORIGINS_PATH } from "neutron-compiler/src/install.js";
import {
  prepareDeployment,
  sha256Hex,
} from "neutron-provision/src/artifact.js";
import { starterAssetOperations } from "../starter_payload.ts";

test("the v315 starter remains v25-compatible and omits the v26 sidecar", async () => {
  const archivePath = path.resolve(
    import.meta.dir,
    "../../../packages/neutron-compiler/test/fixtures/kernel.v0.3.15.neutron",
  );
  const archive = new Uint8Array(await readFile(archivePath));
  const deployment = await prepareDeployment([archivePath], {
    target: "production",
    deploymentNonce: "3".repeat(32),
    expectedArtifacts: [
      {
        path: archivePath,
        id: "kernel",
        version: 315,
        sha256: sha256Hex(archive),
        bytes: archive.byteLength,
      },
    ],
  });

  expect(deployment.compiled.assemblerId).toBe(LEGACY_V25_ASSEMBLER_ID);
  expect(deployment.compiled.browserSurfaceOriginAppIds).toEqual([]);
  expect(
    starterAssetOperations(deployment).map(({ key }) => key),
  ).not.toContain(BROWSER_SURFACE_ORIGINS_PATH);
}, 30_000);
