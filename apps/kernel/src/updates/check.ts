import {
  UPDATE_CHECK_WAVE_SIZE,
  UpdateCheckError,
  type FetchedRelease,
  type InstalledUpdateApp,
  type UpdateCheckFailureCode,
  type UpdateCheckResult,
  type UpdateCheckSummary,
  type UpdateSourceProgress,
} from "./model.ts";
import { compareCanonicalText } from "neutron-tools/src/canonical.js";

export type CheckForAppUpdatesOptions = Readonly<{
  fetchRelease: (
    source: string,
    appId: string,
    options: { signal?: AbortSignal },
  ) => Promise<FetchedRelease | null>;
  now?: () => number;
  onProgress?: (progress: UpdateSourceProgress) => void;
  onResult?: (result: UpdateCheckResult) => void;
  signal?: AbortSignal;
  waveSize?: number;
}>;

export async function checkForAppUpdates(
  installedApps: readonly InstalledUpdateApp[],
  options: CheckForAppUpdatesOptions,
): Promise<UpdateCheckSummary> {
  const waveSize = options.waveSize ?? UPDATE_CHECK_WAVE_SIZE;
  if (
    !Number.isSafeInteger(waveSize) ||
    waveSize < 1 ||
    waveSize > UPDATE_CHECK_WAVE_SIZE
  ) {
    throw new Error(`Update-check wave size must be between 1 and ${UPDATE_CHECK_WAVE_SIZE}`);
  }
  const deduplicatedApps = deduplicateInstalledApps(installedApps);
  const manualResults: UpdateCheckResult[] = [];
  const grouped = new Map<string, InstalledUpdateApp[]>();
  for (const app of deduplicatedApps.sort((left, right) =>
    compareCanonicalText(left.appId, right.appId),
  )) {
    if (!app.updateSource) {
      const result: UpdateCheckResult = {
        kind: "manual_only",
        appId: app.appId,
        name: app.name,
        installed: app.version,
      };
      manualResults.push(result);
      options.onResult?.(result);
      continue;
    }
    const group = grouped.get(app.updateSource) ?? [];
    group.push(app);
    grouped.set(app.updateSource, group);
  }

  const results = [...manualResults];
  const sources = [...grouped.keys()].sort(compareCanonicalText);
  for (const source of sources) {
    throwIfAborted(options.signal);
    const apps = grouped.get(source)!;
    let completed = 0;
    options.onProgress?.({ source, completed, total: apps.length });
    for (let offset = 0; offset < apps.length; offset += waveSize) {
      throwIfAborted(options.signal);
      const wave = apps.slice(offset, offset + waveSize);
      for (const app of wave) {
        options.onResult?.({
          kind: "checking",
          appId: app.appId,
          name: app.name,
          installed: app.version,
          source,
        });
      }
      const waveResults = await Promise.all(
        wave.map(async (app) => {
          const result = await checkOne(app, source, options);
          options.onResult?.(result);
          return result;
        }),
      );
      results.push(...waveResults);
      completed += wave.length;
      options.onProgress?.({ source, completed, total: apps.length });
    }
  }
  results.sort((left, right) => compareCanonicalText(left.appId, right.appId));
  return Object.freeze({
    checkedAt: (options.now ?? Date.now)(),
    results: Object.freeze(results),
    sources: Object.freeze(sources),
  });
}

async function checkOne(
  app: InstalledUpdateApp,
  source: string,
  options: CheckForAppUpdatesOptions,
): Promise<UpdateCheckResult> {
  try {
    const fetched = await options.fetchRelease(source, app.appId, {
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!fetched) {
      return {
        kind: "not_published",
        appId: app.appId,
        name: app.name,
        installed: app.version,
        source,
      };
    }
    const { record, releaseDigest } = fetched;
    if (record.version > app.version) {
      return {
        kind: "available",
        appId: app.appId,
        name: app.name,
        installed: app.version,
        source,
        release: record,
        releaseDigest,
      };
    }
    if (record.version < app.version) {
      return {
        kind: "source_regression",
        appId: app.appId,
        name: app.name,
        installed: app.version,
        source,
        advertised: record.version,
      };
    }
    if (!app.packageDigest) {
      return failed(app, source, "unverifiable");
    }
    if (app.packageDigest !== record.sha256) {
      return failed(app, source, "equivocation");
    }
    return {
      kind: "current",
      appId: app.appId,
      name: app.name,
      installed: app.version,
      source,
      release: record,
      releaseDigest,
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return failed(
      app,
      source,
      error instanceof UpdateCheckError ? error.code : "unavailable",
    );
  }
}

function failed(
  app: InstalledUpdateApp,
  source: string,
  reason: UpdateCheckFailureCode,
): UpdateCheckResult {
  return {
    kind: "failed",
    appId: app.appId,
    name: app.name,
    installed: app.version,
    source,
    reason,
  };
}

function deduplicateInstalledApps(
  apps: readonly InstalledUpdateApp[],
): InstalledUpdateApp[] {
  const byId = new Map<string, InstalledUpdateApp>();
  for (const app of apps) {
    const previous = byId.get(app.appId);
    if (!previous) {
      byId.set(app.appId, app);
      continue;
    }
    if (!sameInstalledApp(previous, app)) {
      throw new Error(`Conflicting installed snapshots for ${app.appId}`);
    }
  }
  return [...byId.values()];
}

function sameInstalledApp(
  left: InstalledUpdateApp,
  right: InstalledUpdateApp,
): boolean {
  return (
    left.appId === right.appId &&
    left.name === right.name &&
    left.version === right.version &&
    left.updateSource === right.updateSource &&
    left.packageDigest === right.packageDigest
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (typeof DOMException !== "undefined") {
    throw new DOMException("Update check cancelled", "AbortError");
  }
  const error = new Error("Update check cancelled");
  error.name = "AbortError";
  throw error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
