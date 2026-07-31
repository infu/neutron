import { createHash } from "node:crypto";
import type { NeutronCertifiedAssetsCapabilityV2 } from "neutron-tools/src/capabilities/catalog.js";
import {
  CERTIFIED_ASSETS_SYNTHETIC_PLAN,
} from "neutron-tools/src/certified_assets_qualification.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";
import {
  CERTIFIED_ASSETS_RELEASE_QUALIFICATION_PROFILE,
} from "./profile.ts";

const boundedPhysical =
  CERTIFIED_ASSETS_RELEASE_QUALIFICATION_PROFILE.bounded_physical_sample;

export const CERTIFIED_ASSETS_QUALIFICATION_MANIFEST_SET_SCHEMA =
  "neutron.kernel.certified-assets-qualification-manifest-set.v1" as const;

export const CERTIFIED_ASSETS_QUALIFICATION_FIXTURES = [
  {
    app_id: "ca_qualification_primary",
    name: "CA Qualification P",
    role: "bounded_physical",
    certified_assets: {
      api: 2,
      max_entries: boundedPhysical.entries,
      // Keep one byte beyond the populated body total so the 257th
      // one-byte put isolates the bounded sample's entry ceiling rather than
      // crossing both entry and committed-byte ceilings.
      max_committed_bytes: boundedPhysical.entries + 1,
      max_object_bytes: 1,
      max_pending_stages: 1,
      max_staged_bytes: 1,
      max_batch_operations: boundedPhysical.batch_operations,
      max_batch_bytes: boundedPhysical.batch_operations,
      // Eight receipts force one expiry/reclaim boundary halfway through the
      // 16-batch sample without paying for thousands of redundant calls.
      max_idempotency_receipts: boundedPhysical.idempotency_receipts,
      collections: [
        {
          id: "physical",
          mount: "physical",
          kind: "mutable_blob",
          path_prefix: "/records/",
          max_object_bytes: 1,
        },
        {
          id: "stage",
          mount: "stage",
          kind: "immutable_blob",
          path_prefix: "/objects/",
          max_object_bytes: 1,
        },
      ],
    },
  },
  {
    app_id: "ca_qualification_aux_1",
    name: "CA Qualification A1",
    role: "behavior",
    // This is the exact behavior plan bound by the public qualification
    // contract, not a smaller look-alike.
    certified_assets: {
      api: 2,
      ...CERTIFIED_ASSETS_SYNTHETIC_PLAN.limits,
      collections: CERTIFIED_ASSETS_SYNTHETIC_PLAN.collections.map(
        (collection) => ({ ...collection }),
      ),
    },
  },
  ...(["2", "3", "4"] as const).map((suffix) => ({
    app_id: `ca_qualification_aux_${suffix}` as const,
    name: `CA Qualification A${suffix}` as const,
    role: "stage_probe" as const,
    certified_assets: {
      api: 2 as const,
      max_entries: 1,
      max_committed_bytes: 1,
      max_object_bytes: 1,
      max_pending_stages: 1,
      max_staged_bytes: 1,
      max_batch_operations: 1,
      max_batch_bytes: 1,
      max_idempotency_receipts: 2,
      collections: [
        {
          id: "stage",
          mount: "stage",
          kind: "immutable_blob" as const,
          path_prefix: "/objects/",
          max_object_bytes: 1,
        },
      ],
    },
  })),
] as const satisfies readonly {
  app_id: string;
  name: string;
  role: "bounded_physical" | "behavior" | "stage_probe";
  certified_assets: NeutronCertifiedAssetsCapabilityV2;
}[];

export type CertifiedAssetsQualificationFixture =
  (typeof CERTIFIED_ASSETS_QUALIFICATION_FIXTURES)[number];
export type CertifiedAssetsQualificationFixtureId =
  CertifiedAssetsQualificationFixture["app_id"];
export type CertifiedAssetsQualificationFixtureRole =
  CertifiedAssetsQualificationFixture["role"];

export type CertifiedAssetsQualificationManifestEntry = Readonly<{
  app_id: CertifiedAssetsQualificationFixtureId;
  role: CertifiedAssetsQualificationFixtureRole;
  bytes: number;
  sha256: string;
}>;

export type CertifiedAssetsQualificationManifestSet = Readonly<{
  schema: typeof CERTIFIED_ASSETS_QUALIFICATION_MANIFEST_SET_SCHEMA;
  manifests: readonly CertifiedAssetsQualificationManifestEntry[];
  sha256: string;
}>;

export function certifiedAssetsQualificationFixture(
  appId: string,
): CertifiedAssetsQualificationFixture {
  const fixture = CERTIFIED_ASSETS_QUALIFICATION_FIXTURES.find(
    (candidate) => candidate.app_id === appId,
  );
  if (fixture === undefined) {
    throw new Error(`Unknown Certified Assets qualification fixture ${appId}`);
  }
  return fixture;
}

export function generateCertifiedAssetsQualificationManifest(
  template: unknown,
  fixture: CertifiedAssetsQualificationFixture,
): Record<string, unknown> {
  const source = record(
    structuredClone(template),
    "Certified Assets fixture manifest template",
  );
  const backend = record(
    source.backend,
    "Certified Assets fixture manifest template.backend",
  );
  const generated = {
    ...source,
    name: fixture.name,
    id: fixture.app_id,
    backend: {
      ...backend,
      capabilities: {
        certified_assets: { api: 2 },
      },
    },
    capabilities: {
      certified_assets: structuredClone(fixture.certified_assets),
    },
  };
  assertGeneratedManifest(generated, fixture);
  return generated;
}

export function certifiedAssetsQualificationManifestBytes(
  manifest: unknown,
): Uint8Array {
  // `mogen` materializes exactly this JSON representation before packaging.
  return new TextEncoder().encode(JSON.stringify(manifest, null, 2));
}

export function buildCertifiedAssetsQualificationManifestSet(
  template: unknown,
): CertifiedAssetsQualificationManifestSet {
  const manifests = CERTIFIED_ASSETS_QUALIFICATION_FIXTURES.map((fixture) => {
    const bytes = certifiedAssetsQualificationManifestBytes(
      generateCertifiedAssetsQualificationManifest(template, fixture),
    );
    return {
      app_id: fixture.app_id,
      role: fixture.role,
      bytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
    };
  });
  return {
    schema: CERTIFIED_ASSETS_QUALIFICATION_MANIFEST_SET_SCHEMA,
    manifests,
    sha256: sha256Hex(
      new TextEncoder().encode(
        `${canonicalJson({
          schema: CERTIFIED_ASSETS_QUALIFICATION_MANIFEST_SET_SCHEMA,
          manifests,
        })}\n`,
      ),
    ),
  };
}

function assertGeneratedManifest(
  value: unknown,
  fixture: CertifiedAssetsQualificationFixture,
): void {
  const validation = validate_neutron_conf(value);
  if (validation.errors.length > 0) {
    throw new Error(
      `Certified Assets generated manifest ${fixture.app_id} is invalid: ${validation.errors
        .map((error) => error.stack)
        .join("; ")}`,
    );
  }
  const manifest = record(
    value,
    `Certified Assets generated manifest ${fixture.app_id}`,
  );
  const capabilities = record(
    manifest.capabilities,
    `Certified Assets generated manifest ${fixture.app_id}.capabilities`,
  );
  if (
    manifest.id !== fixture.app_id ||
    manifest.name !== fixture.name ||
    canonicalJson(capabilities.certified_assets) !==
      canonicalJson(fixture.certified_assets)
  ) {
    throw new Error(
      `Certified Assets generated manifest ${fixture.app_id} does not match its fixed neutral definition`,
    );
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a record`);
  }
  return value as Record<string, unknown>;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("Canonical manifest set accepts only safe integers");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  throw new Error("Canonical manifest set contains an unsupported value");
}
