import { REPOSITORY_LIMITS } from "neutron-tools/repository";
import { compareCanonicalText } from "neutron-tools/src/canonical.js";
import type { InstallProvenance } from "../repository/provenance.ts";
import { useAppsStore } from "../reducer/apps.ts";
import type { InstalledUpdateApp, UpdateCheckResult } from "./model.ts";

export type AvailableUpdate = Extract<
  UpdateCheckResult,
  { kind: "available" }
>;

export function installedUpdateApps(
  registry: ReturnType<typeof useAppsStore.getState>["list"],
  provenance: InstallProvenance,
): InstalledUpdateApp[] {
  return Object.entries(registry)
    .sort(([left], [right]) => compareCanonicalText(left, right))
    .map(([appId, entry]) => ({
      appId,
      name: entry.name,
      version: entry.version,
      ...(entry.update_source ? { updateSource: entry.update_source } : {}),
      ...(provenance.apps[appId]?.package_digest
        ? { packageDigest: provenance.apps[appId]!.package_digest }
        : {}),
    }));
}

export function watchRegistrySnapshot(
  baseline: ReturnType<typeof useAppsStore.getState>["list"],
  abort: AbortController,
  onChanged: () => void,
): () => void {
  const fingerprint = registryUpdateFingerprint(baseline);
  return useAppsStore.subscribe((current) => {
    if (
      !abort.signal.aborted &&
      registryUpdateFingerprint(current.list) !== fingerprint
    ) {
      onChanged();
      abort.abort();
    }
  });
}

export function selectedCandidates(
  results: readonly UpdateCheckResult[],
  selectedIds: readonly string[],
): AvailableUpdate[] {
  const selected = new Set(selectedIds);
  return results
    .filter(
      (result): result is AvailableUpdate =>
        result.kind === "available" && selected.has(result.appId),
    )
    .sort((left, right) => compareCanonicalText(left.appId, right.appId));
}

export function updateResultsMatchRegistry(
  results: readonly UpdateCheckResult[],
  registry: ReturnType<typeof useAppsStore.getState>["list"],
): boolean {
  if (results.length !== Object.keys(registry).length) return false;
  return results.every((result) => {
    const entry = registry[result.appId];
    if (!entry || entry.version !== result.installed) return false;
    return result.kind === "manual_only"
      ? entry.update_source === undefined
      : entry.update_source === result.source;
  });
}

export function assertSelectedUpdateBounds(
  candidates: readonly AvailableUpdate[],
): void {
  if (candidates.length > REPOSITORY_LIMITS.packagesPerManifest) {
    throw new Error(
      `Selected updates support at most ${REPOSITORY_LIMITS.packagesPerManifest} apps at once. Select a smaller batch.`,
    );
  }
  let bytes = 0;
  for (const candidate of candidates) {
    bytes += candidate.release.size;
    if (
      !Number.isSafeInteger(bytes) ||
      bytes > REPOSITORY_LIMITS.manifestPackageBytes
    ) {
      throw new Error(
        `Selected updates exceed the ${REPOSITORY_LIMITS.manifestPackageBytes}-byte aggregate download limit. Select a smaller batch.`,
      );
    }
  }
}

export function sameRelease(
  left: AvailableUpdate["release"],
  right: AvailableUpdate["release"],
): boolean {
  return (
    left.protocol === right.protocol &&
    left.id === right.id &&
    left.version === right.version &&
    left.sha256 === right.sha256 &&
    left.size === right.size
  );
}

export function selectionFingerprint(
  candidates: readonly AvailableUpdate[],
): string {
  return JSON.stringify(
    candidates.map(({ appId, installed, source, release, releaseDigest }) => ({
      appId,
      installed,
      source,
      release,
      releaseDigest,
    })),
  );
}

export function diagnosticText(value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  ) {
    return value.message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function registryUpdateFingerprint(
  registry: ReturnType<typeof useAppsStore.getState>["list"],
): string {
  return JSON.stringify(
    Object.entries(registry)
      .sort(([left], [right]) => compareCanonicalText(left, right))
      .map(([appId, entry]) => [
        appId,
        entry.version,
        entry.update_source ?? null,
      ]),
  );
}
