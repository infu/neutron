import { Principal } from "@dfinity/principal";
import { isValidAppId } from "neutron-tools/src/app_ids.js";

export const INSTALL_PROVENANCE_PATH = "/system/install-provenance.json";

export type RepositoryInstallProvenance = {
  kind: "repository";
  repository: string;
  manifest_id: string;
  manifest_digest: string;
  package_digest: string;
};

export type UpdateSourceInstallProvenance = {
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
  format: 1;
  apps: Record<string, AppInstallProvenance>;
};

export const EMPTY_INSTALL_PROVENANCE: InstallProvenance = Object.freeze({
  format: 1,
  apps: Object.freeze({}),
});

const RESERVED_APP_IDS = new Set(["__proto__", "constructor", "prototype"]);
const MANIFEST_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export function parseInstallProvenance(value: unknown): InstallProvenance {
  if (!isRecord(value) || !hasExactKeys(value, ["format", "apps"])) {
    throw new Error("Invalid install provenance");
  }
  if (value.format !== 1 || !isRecord(value.apps)) {
    throw new Error("Unsupported install provenance format");
  }

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
        ]) ||
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
      ]) ||
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
    });
  }

  return Object.freeze({ format: 1, apps: Object.freeze(apps) });
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
    format: 1,
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
    format: 1,
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
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === [...expected].sort()[index])
  );
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
