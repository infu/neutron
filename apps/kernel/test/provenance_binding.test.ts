import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { gzipSync } from "fflate";
import msgpack from "tiny-msgpack";
import { hashContent } from "neutron-tools/src/hash.js";
import { preparePackageInstall } from "neutron-compiler/src/install.js";
import type { AppInstallProvenance } from "../src/repository/provenance.ts";
import {
  assertPackageProvenanceCoverage,
  type ProvenanceBoundPreparedPackage,
} from "../src/install_review/provenance_binding.ts";

function reviewedPackage(
  id: string,
  archiveSeed: Uint8Array,
): ProvenanceBoundPreparedPackage {
  const moduleContent = new TextEncoder().encode(
    `module { public let seed : Nat = ${archiveSeed[0] ?? 0} }`,
  );
  const entry = hashContent(moduleContent);
  const files = {
    "neutron.json": new TextEncoder().encode(
      JSON.stringify({ format: 3, id, name: id, version: 100, entry }),
    ),
    [`mo/${entry}.mo`]: moduleContent,
  };
  const archiveBytes = msgpack.encode(
    Object.fromEntries(
      Object.entries(files).map(([path, content]) => [
        path,
        gzipSync(content),
      ]),
    ),
  );
  return preparePackageInstall(archiveBytes);
}

function manualProvenance(packageDigest: string): AppInstallProvenance {
  return Object.freeze({
    kind: "manual",
    acquisition: "file",
    package_digest: packageDigest,
  });
}

test("install provenance must name the exact reviewed archive digest", () => {
  const prepared = reviewedPackage("alpha", new Uint8Array([1, 2, 3, 4]));

  expect(() =>
    assertPackageProvenanceCoverage([prepared], {
      alpha: manualProvenance("0".repeat(64)),
    }),
  ).toThrow(
    "Install provenance package digest for alpha does not match the reviewed archive",
  );

  expect(() =>
    assertPackageProvenanceCoverage([prepared], {
      alpha: manualProvenance(prepared.archiveIdentity!.sha256),
    }),
  ).not.toThrow();
});

test("archive mutation after review is rejected even when provenance matches the reviewed digest", () => {
  const prepared = reviewedPackage("alpha", new Uint8Array([5, 6, 7, 8]));
  const reviewedDigest = prepared.archiveIdentity!.sha256;

  prepared.archiveBytes![0] = prepared.archiveBytes![0]! ^ 0xff;

  expect(() =>
    assertPackageProvenanceCoverage([prepared], {
      alpha: manualProvenance(reviewedDigest),
    }),
  ).toThrow(/Prepared package archive SHA-256 .* does not match reviewed/u);
});

test("the session checks archive-bound provenance before baseline reads or deployment", async () => {
  const source = await readFile(
    new URL("../src/reducer/apps.ts", import.meta.url),
    "utf8",
  );
  const session = source.slice(
    source.indexOf("export async function beginPackageInstallSession"),
    source.indexOf("function assertPackageSessionTargets"),
  );
  const deployMethod = session.slice(
    session.indexOf("async deploy({"),
    session.indexOf("\n      cancel()"),
  );
  const provenanceCheck = deployMethod.indexOf(
    "assertPackageProvenanceCoverage(packages, provenanceEntries)",
  );
  const baselineRead = deployMethod.indexOf(
    "await readConsistentRepositoryPackageState(neutron)",
  );
  const dispatch = deployMethod.indexOf("await deployPreparedPackages");

  expect(provenanceCheck).toBeGreaterThan(-1);
  expect(baselineRead).toBeGreaterThan(provenanceCheck);
  expect(dispatch).toBeGreaterThan(baselineRead);
});
