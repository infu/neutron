import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const didUrl = new URL("../../candid/files-plain-v3.did", import.meta.url);
const surfaceActorUrl = new URL("./plain_surface_actor.mo", import.meta.url);
const corePackageUrl = new URL(
  "../../.mops/_github/core%23v2.6.0/src/",
  import.meta.url,
);
const capabilitiesPackageUrl = new URL(
  "../../../../packages/neutron-motoko-capabilities/src/",
  import.meta.url,
);
const sha2PackageUrl = new URL("../../.mops/sha2@0.0.2/src/", import.meta.url);
const basePackageUrl = new URL("../../.mops/base@0.9.2/src/", import.meta.url);

test("the Files plaintext V3 fixture is valid Candid", () => {
  const result = spawnSync("didc", ["check", fileURLToPath(didUrl)], {
    encoding: "utf8",
  });
  expect(
    result.status,
    [result.stdout, result.stderr].filter(Boolean).join("\n"),
  ).toBe(0);
});

test("backend/main plaintext V3 types are exactly the checked Candid fixture", async () => {
  const temporary = await mkdtemp(
    join(tmpdir(), "neutron-files-plain-v3-abi-"),
  );
  const emittedDid = join(temporary, "plain-surface.did");
  try {
    const compile = spawnSync(
      "moc",
      [
        "--idl",
        "--package",
        "core",
        fileURLToPath(corePackageUrl),
        "--package",
        "neutron-capabilities",
        fileURLToPath(capabilitiesPackageUrl),
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

    for (const [current, expected] of [
      [emittedDid, fileURLToPath(didUrl)],
      [fileURLToPath(didUrl), emittedDid],
    ] as const) {
      const comparison = spawnSync(
        "didc",
        ["check", "-s", current, expected],
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
}, 20_000);
