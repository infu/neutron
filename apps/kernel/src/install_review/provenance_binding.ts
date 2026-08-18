import {
  assertPreparedPackageArchiveIdentity,
  type PreparedPackageInstall,
} from "neutron-compiler/src/install.js";
import { compareCanonicalText } from "neutron-tools/src/canonical.js";
import type { AppInstallProvenance } from "../repository/provenance.ts";

export type ProvenanceBoundPreparedPackage = PreparedPackageInstall;

/**
 * Bind install provenance to the exact package archive batch that was
 * reviewed. Call this immediately before re-reading the deployment baseline
 * and before any staging or deployment I/O.
 */
export function assertPackageProvenanceCoverage(
  packages: readonly ProvenanceBoundPreparedPackage[],
  provenance: Readonly<Record<string, AppInstallProvenance>>,
): void {
  const packageIds = packages
    .map(({ manifest }) => manifest.id)
    .sort(compareCanonicalText);
  const provenanceIds = Object.keys(provenance).sort(compareCanonicalText);
  if (JSON.stringify(packageIds) !== JSON.stringify(provenanceIds)) {
    throw new Error(
      "Install provenance must describe exactly the compiled package batch.",
    );
  }

  for (const preparedPackage of packages) {
    assertPreparedPackageArchiveIdentity(preparedPackage);
    const identity = preparedPackage.archiveIdentity;
    if (!identity) {
      throw new Error(
        `Install provenance for ${preparedPackage.manifest.id} requires exact supplied archive bytes`,
      );
    }
    const recorded = provenance[preparedPackage.manifest.id];
    if (!recorded || recorded.package_digest !== identity.sha256) {
      throw new Error(
        `Install provenance package digest for ${preparedPackage.manifest.id} does not match the reviewed archive`,
      );
    }
  }
}
