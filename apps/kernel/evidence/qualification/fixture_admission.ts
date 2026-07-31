import {
  CERTIFIED_ASSETS_GLOBAL_ACTIVE_STAGES_MAX,
  CERTIFIED_ASSETS_GLOBAL_CHARGED_BYTES_MAX,
  CERTIFIED_ASSETS_PHYSICAL_RESERVATION_POLICY_V1,
  certifiedAssetsPhysicalReservation,
  type CertifiedAssetsPhysicalReservation,
} from "neutron-tools/src/capabilities/catalog.js";
import {
  CERTIFIED_ASSETS_QUALIFICATION_FIXTURES,
  type CertifiedAssetsQualificationFixtureId,
} from "./fixture_manifests.ts";
import {
  CERTIFIED_ASSETS_RELEASE_QUALIFICATION_PROFILE,
} from "./profile.ts";

export type QualificationFixtureAdmission = Readonly<{
  scopes: readonly Readonly<{
    app_id: CertifiedAssetsQualificationFixtureId;
    reservation: CertifiedAssetsPhysicalReservation;
  }>[];
  charged_bytes: bigint;
  charged_bytes_with_allocator_metadata: bigint;
  arena_bytes: bigint;
  arena_extents: bigint;
  arena_descriptors: bigint;
}>;

/**
 * Re-run the same target-wide reservation formula as assembly before the
 * qualification launcher performs any expensive work. This is an assertion,
 * not a second set of hand-maintained budget values.
 */
export function assertQualificationFixtureSetAdmission():
  QualificationFixtureAdmission {
  const fixtures = CERTIFIED_ASSETS_QUALIFICATION_FIXTURES;
  if (fixtures.length !== CERTIFIED_ASSETS_GLOBAL_ACTIVE_STAGES_MAX + 1) {
    throw new Error(
      "Qualification fixture set must contain exactly one scope beyond the actor-wide stage cap",
    );
  }
  const primary = fixtures[0]!;
  if (
    primary.role !== "bounded_physical" ||
    primary.certified_assets.max_entries !==
      CERTIFIED_ASSETS_RELEASE_QUALIFICATION_PROFILE
        .bounded_physical_sample.entries
  ) {
    throw new Error(
      "Qualification primary scope does not bind the bounded physical sample",
    );
  }
  if (
    fixtures.some(
      ({ certified_assets }) =>
        certified_assets.max_pending_stages !== 1 ||
        certified_assets.collections.filter(
          ({ kind }) => kind === "immutable_blob",
        ).length !== 1,
    )
  ) {
    throw new Error(
      "Every qualification scope must reserve exactly one immutable stage lane",
    );
  }

  const scopes = fixtures.map((fixture) => ({
    app_id: fixture.app_id,
    reservation: certifiedAssetsPhysicalReservation(
      fixture.certified_assets,
      fixture.app_id,
    ),
  }));
  const chargedBytes = scopes.reduce(
    (total, { reservation }) => total + reservation.chargedBytes,
    0n,
  );
  const arenaBytes = scopes.reduce(
    (total, { reservation }) => total + reservation.arenaBytes,
    0n,
  );
  const arenaExtents = scopes.reduce(
    (total, { reservation }) => total + reservation.arenaExtents,
    0n,
  );
  const policy = CERTIFIED_ASSETS_PHYSICAL_RESERVATION_POLICY_V1;
  const chargedWithMetadata =
    chargedBytes + policy.arenaMetadataReserveBytes;
  const arenaDescriptors = 2n * arenaExtents + 1n;
  if (
    chargedWithMetadata > CERTIFIED_ASSETS_GLOBAL_CHARGED_BYTES_MAX ||
    arenaBytes > policy.arenaAllocatableBytesMax ||
    arenaDescriptors > policy.arenaExtentsMax
  ) {
    throw new Error(
      "Exact qualification fixture set exceeds Certified Assets physical admission",
    );
  }
  return {
    scopes,
    charged_bytes: chargedBytes,
    charged_bytes_with_allocator_metadata: chargedWithMetadata,
    arena_bytes: arenaBytes,
    arena_extents: arenaExtents,
    arena_descriptors: arenaDescriptors,
  };
}
