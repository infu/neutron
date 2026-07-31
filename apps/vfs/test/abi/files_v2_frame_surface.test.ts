import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const canonicalDidUrl = new URL(
  "../../candid/files-v2-frames.did",
  import.meta.url,
);
const surfaceActorUrl = new URL("./frame_surface_actor.mo", import.meta.url);
const corePackageUrl = new URL(
  "../../.mops/_github/core%23v2.6.0/src/",
  import.meta.url,
);
const sha2PackageUrl = new URL("../../.mops/sha2@0.0.2/src/", import.meta.url);
const basePackageUrl = new URL("../../.mops/base@0.9.2/src/", import.meta.url);

const syntheticService = `service : {
  frame_vault_read : (VaultReadFrameControlV2) -> (VaultReadFrameControlV2) query;
  frame_vault_write : (VaultWriteFrameControlV2) -> (VaultWriteFrameControlV2) query;
  frame_list : (ListFrameControlV2) -> (ListFrameControlV2) query;
  frame_lookup : (LookupFrameControlV2) -> (LookupFrameControlV2) query;
  frame_read_block : (ReadBlockFrameControlV2) -> (ReadBlockFrameControlV2) query;
  frame_mutate : (MutateFrameControlV2) -> (MutateFrameControlV2) query;
  frame_write_block : (WriteBlockFrameControlV2) -> (WriteBlockFrameControlV2) query;
};`;

test("backend Frames public controls exactly match the canonical inner Candid", async () => {
  const temporary = await mkdtemp(
    join(tmpdir(), "neutron-files-v2-frame-abi-"),
  );
  const canonicalSurfaceDid = join(temporary, "canonical-frame-surface.did");
  const emittedDid = join(temporary, "motoko-frame-surface.did");

  try {
    const canonical = await readFile(canonicalDidUrl, "utf8");
    const emptyService = "service : {};";
    expect(canonical.match(new RegExp(emptyService, "g"))).toHaveLength(1);
    await writeFile(
      canonicalSurfaceDid,
      canonical.replace(emptyService, syntheticService),
      "utf8",
    );

    const compile = spawnSync(
      "moc",
      [
        "--idl",
        "--package",
        "core",
        fileURLToPath(corePackageUrl),
        "--package",
        "sha2",
        fileURLToPath(sha2PackageUrl),
        "--package",
        "base",
        fileURLToPath(basePackageUrl),
        "-o",
        emittedDid,
        fileURLToPath(surfaceActorUrl),
      ],
      { encoding: "utf8" },
    );
    expect(
      compile.status,
      [compile.stdout, compile.stderr].filter(Boolean).join("\n"),
    ).toBe(0);

    for (const [current, previous] of [
      [emittedDid, canonicalSurfaceDid],
      [canonicalSurfaceDid, emittedDid],
    ] as const) {
      const comparison = spawnSync(
        "didc",
        ["check", "-s", current, previous],
        { encoding: "utf8" },
      );
      expect(
        comparison.status,
        [comparison.stdout, comparison.stderr].filter(Boolean).join("\n"),
      ).toBe(0);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
