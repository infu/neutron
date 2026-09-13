import { Principal } from "@dfinity/principal";
import { isValidAppId } from "neutron-tools/src/app_ids.js";

export const INSTALL_PROVENANCE_PATH = "/system/install-provenance.json";

export type ReleaseSelectionProvenance = {
  release_channel?: "stable" | "beta";
  release_preferences_revision?: string;
  /** Source participation established by certified channel evidence. */
  channel_aware?: true;
};

export type RepositoryInstallProvenance = ReleaseSelectionProvenance & {
  kind: "repository";
  repository: string;
  manifest_id: string;
  manifest_digest: string;
  package_digest: string;
};

export type UpdateSourceInstallProvenance = ReleaseSelectionProvenance & {
  kind: "update_source";
  source_canister: string;
  release_digest: string;
  package_digest: string;
  checked_at: number;
};

export type ManualInstallProvenance = {
  kind: "manual";
  acquisition: "file" | "url";
  package_digest: string;
};

export type ProvisionedInstallProvenance = {
  kind: "provisioned";
  package_digest: string;
};

export type AppInstallProvenance =
  | RepositoryInstallProvenance
  | UpdateSourceInstallProvenance
  | ManualInstallProvenance
  | ProvisionedInstallProvenance;

export type InstallProvenance = {
  format: 2;
  apps: Record<string, AppInstallProvenance>;
};

export const EMPTY_INSTALL_PROVENANCE: InstallProvenance = Object.freeze({
  format: 2,
  apps: Object.freeze({}),
});

const RESERVED_APP_IDS = new Set(["__proto__", "constructor", "prototype"]);
const MANIFEST_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const NAT_DECIMAL = /^(0|[1-9][0-9]*)$/;
const RELEASE_SELECTION_KEYS = [
  "release_channel",
  "release_preferences_revision",
  "channel_aware",
] as const;

export function parseInstallProvenance(value: unknown): InstallProvenance {
  if (!isRecord(value) || !hasExactKeys(value, ["format", "apps"])) {
    throw new Error("Invalid install provenance");
  }
  if ((value.format !== 1 && value.format !== 2) || !isRecord(value.apps)) {
    throw new Error("Unsupported install provenance format");
  }

  // Format 1 remains a closed historical format. Validate its original entry
  // shapes before converting to format 2; never interpret new fields as v1.
  const optionalReleaseKeys = value.format === 2 ? RELEASE_SELECTION_KEYS : [];
  const apps = Object.create(null) as Record<string, AppInstallProvenance>;
  for (const [appId, candidate] of Object.entries(value.apps)) {
    if (
      !isValidAppId(appId) ||
      RESERVED_APP_IDS.has(appId) ||
      !isRecord(candidate)
    ) {
      throw new Error(`Invalid install provenance entry ${appId}`);
    }
    if (candidate.kind === "repository") {
      if (
        !hasExactKeys(candidate, [
          "kind",
          "repository",
          "manifest_id",
          "manifest_digest",
          "package_digest",
        ], optionalReleaseKeys) ||
        !validReleaseSelection(candidate) ||
        typeof candidate.repository !== "string" ||
        !isRepositoryPrincipal(candidate.repository) ||
        typeof candidate.manifest_id !== "string" ||
        typeof candidate.manifest_digest !== "string" ||
        typeof candidate.package_digest !== "string" ||
        !MANIFEST_ID.test(candidate.manifest_id) ||
        !SHA256.test(candidate.manifest_digest) ||
        !SHA256.test(candidate.package_digest)
      ) {
        throw new Error(`Invalid install provenance entry ${appId}`);
      }
      apps[appId] = Object.freeze({
        kind: "repository",
        repository: candidate.repository,
        manifest_id: candidate.manifest_id,
        manifest_digest: candidate.manifest_digest,
        package_digest: candidate.package_digest,
        ...releaseSelection(candidate),
      });
      continue;
    }
    if (candidate.kind === "manual") {
      if (
        !hasExactKeys(candidate, [
          "kind",
          "acquisition",
          "package_digest",
        ]) ||
        (candidate.acquisition !== "file" && candidate.acquisition !== "url") ||
        typeof candidate.package_digest !== "string" ||
        !SHA256.test(candidate.package_digest)
      ) {
        throw new Error(`Invalid install provenance entry ${appId}`);
      }
      apps[appId] = Object.freeze({
        kind: "manual",
        acquisition: candidate.acquisition,
        package_digest: candidate.package_digest,
      });
      continue;
    }
    if (candidate.kind === "provisioned") {
      if (
        !hasExactKeys(candidate, ["kind", "package_digest"]) ||
        typeof candidate.package_digest !== "string" ||
        !SHA256.test(candidate.package_digest)
      ) {
        throw new Error(`Invalid install provenance entry ${appId}`);
      }
      apps[appId] = Object.freeze({
        kind: "provisioned",
        package_digest: candidate.package_digest,
      });
      continue;
    }
    if (
      candidate.kind !== "update_source" ||
      !hasExactKeys(candidate, [
        "kind",
        "source_canister",
        "release_digest",
        "package_digest",
        "checked_at",
      ], optionalReleaseKeys) ||
      !validReleaseSelection(candidate) ||
      typeof candidate.source_canister !== "string" ||
      !isRepositoryPrincipal(candidate.source_canister) ||
      typeof candidate.release_digest !== "string" ||
      typeof candidate.package_digest !== "string" ||
      !SHA256.test(candidate.release_digest) ||
      !SHA256.test(candidate.package_digest) ||
      typeof candidate.checked_at !== "number" ||
      !Number.isSafeInteger(candidate.checked_at) ||
      candidate.checked_at < 0
    ) {
      throw new Error(`Invalid install provenance entry ${appId}`);
    }
    apps[appId] = Object.freeze({
      kind: "update_source",
      source_canister: candidate.source_canister,
      release_digest: candidate.release_digest,
      package_digest: candidate.package_digest,
      checked_at: candidate.checked_at,
      ...releaseSelection(candidate),
    });
  }

  return Object.freeze({ format: 2, apps: Object.freeze(apps) });
}

export function installProvenanceOrEmpty(value: unknown): InstallProvenance {
  return value === undefined ? EMPTY_INSTALL_PROVENANCE : parseInstallProvenance(value);
}

export function withoutInstallProvenance(
  current: InstallProvenance,
  appIds: readonly string[],
): InstallProvenance {
  const removed = new Set(appIds);
  return Object.freeze({
    format: 2,
    apps: Object.freeze(
      Object.fromEntries(
        Object.entries(current.apps).filter(([appId]) => !removed.has(appId)),
      ),
    ),
  });
}

export function withRepositoryInstallProvenance(
  current: InstallProvenance,
  entries: Readonly<Record<string, RepositoryInstallProvenance>>,
): InstallProvenance {
  return withInstallProvenance(current, entries);
}

export function withUpdateSourceInstallProvenance(
  current: InstallProvenance,
  entries: Readonly<Record<string, UpdateSourceInstallProvenance>>,
): InstallProvenance {
  return withInstallProvenance(current, entries);
}

export function withInstallProvenance(
  current: InstallProvenance,
  entries: Readonly<Record<string, AppInstallProvenance>>,
): InstallProvenance {
  return parseInstallProvenance({
    format: 2,
    apps: { ...current.apps, ...entries },
  });
}

export function serializeInstallProvenance(value: InstallProvenance): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(parseInstallProvenance(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function validReleaseSelection(value: Record<string, unknown>): boolean {
  return (
    (!Object.hasOwn(value, "release_channel") ||
      value.release_channel === "stable" || value.release_channel === "beta") &&
    (!Object.hasOwn(value, "release_preferences_revision") ||
      (typeof value.release_preferences_revision === "string" &&
        NAT_DECIMAL.test(value.release_preferences_revision))) &&
    (!Object.hasOwn(value, "channel_aware") || value.channel_aware === true)
  );
}

function releaseSelection(
  value: Record<string, unknown>,
): ReleaseSelectionProvenance {
  return {
    ...(Object.hasOwn(value, "release_channel")
      ? { release_channel: value.release_channel as "stable" | "beta" }
      : {}),
    ...(Object.hasOwn(value, "release_preferences_revision")
      ? { release_preferences_revision: value.release_preferences_revision as string }
      : {}),
    ...(Object.hasOwn(value, "channel_aware") ? { channel_aware: true as const } : {}),
  };
}

function isRepositoryPrincipal(value: string): boolean {
  try {
    const parsed = Principal.fromText(value);
    const bytes = parsed.toUint8Array();
    return (
      parsed.toText() === value &&
      bytes.length >= 1 &&
      bytes.length <= 29 &&
      bytes.at(-1) === 0x01
    );
  } catch {
    return false;
  }
}
