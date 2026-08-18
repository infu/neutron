import {
  KERNEL_INSTALL_MAX_COPIES,
  REMOTE_NEUTRON_PACKAGE_DECODE_LIMITS,
  type CompileResult,
  type PreparedPackageInstall,
} from "neutron-compiler/src/install.js";
import type { CompleteDeploymentBuildRecord } from "neutron-compiler/src/deployment_record.js";
import { REPOSITORY_LIMITS } from "neutron-tools/repository";
import { compareCanonicalText } from "neutron-tools/src/canonical.js";
import { diffCapabilityPlans } from "neutron-tools/src/capabilities/wire.js";
import { normalizeManifestUpdateSource } from "neutron-tools/src/schema.js";
import { configInstallDisclosures } from "../lib/perm.ts";
import { createDeploymentBuildReviewModel } from "../install_review/deployment_build_review.ts";
import {
  beginPackageInstallSession,
  getAppUpdateSnapshot,
  useAppsStore,
  type PackageUpdateSession,
} from "../reducer/apps.ts";
import {
  type UpdateSourceInstallProvenance,
} from "../repository/provenance.ts";
import { get_app_details } from "../tools/app.ts";
import { checkForAppUpdates } from "./check.ts";
import {
  fetchUpdatePackage,
  fetchUpdateRelease,
  type UpdateHttpClientOptions,
} from "./client.ts";
import {
  type UpdateCheckResult,
  type UpdateReview,
  type UpdateReviewApp,
} from "./model.ts";
import {
  assertSelectedUpdateBounds,
  diagnosticText,
  installedUpdateApps,
  sameRelease,
  selectedCandidates,
  selectionFingerprint,
  updateResultsMatchRegistry,
  watchRegistrySnapshot,
} from "./helpers.ts";
import {
  updateCheckState,
  useUpdateCheckStore,
} from "./store.ts";

let generation = 0;
let activeAbort: AbortController | null = null;
let activeSession: PackageUpdateSession | null = null;
let activeCompiled: CompileResult | null = null;
let activePackages: readonly PreparedPackageInstall[] = [];
let activeDeploymentBuildRecord: CompleteDeploymentBuildRecord | null = null;
let activeProvenance: Readonly<
  Record<string, UpdateSourceInstallProvenance>
> = Object.freeze({});
let activeSelectionFingerprint = "";
let stopReadyRegistryWatch: (() => void) | null = null;

export async function checkAppUpdates(
  clientOptions: UpdateHttpClientOptions = {},
): Promise<void> {
  if (useAppsStore.getState().operationBusy) {
    updateCheckState.error("Another app operation is already in progress", "check");
    return;
  }
  abandonActiveWork();
  const attempt = ++generation;
  const abort = new AbortController();
  activeAbort = abort;
  updateCheckState.checking();
  let registryChanged = false;
  let stopWatchingRegistry: () => void = () => undefined;
  try {
    const snapshot = await getAppUpdateSnapshot();
    if (attempt !== generation || abort.signal.aborted) return;
    const registry = snapshot.apps;
    const provenance = snapshot.provenance;
    const installed = installedUpdateApps(registry, provenance);
    updateCheckState.queue(installed);
    stopWatchingRegistry = watchRegistrySnapshot(registry, abort, () => {
      registryChanged = true;
    });
    const summary = await checkForAppUpdates(installed, {
      fetchRelease: (source, appId, { signal }) =>
        fetchUpdateRelease(source, appId, {
          ...clientOptions,
          ...(signal ? { signal } : {}),
        }),
      signal: abort.signal,
      onProgress(progress) {
        if (attempt === generation) updateCheckState.progress(progress);
      },
      onResult(result) {
        if (attempt === generation) updateCheckState.result(result);
      },
    });
    if (attempt !== generation || abort.signal.aborted) return;
    updateCheckState.ready(summary.results, summary.checkedAt);
    watchReadyRegistry(registry);
  } catch (error) {
    if (attempt !== generation) return;
    if (registryChanged) {
      updateCheckState.error(
        "Installed apps changed while checking. Refresh Settings to use the current versions.",
        "check",
      );
      return;
    }
    if (isAbortError(error)) return;
    updateCheckState.error(safeUpdateError(error), "check");
  } finally {
    stopWatchingRegistry();
    if (activeAbort === abort) activeAbort = null;
  }
}

export async function retryFailedUpdateChecks(
  clientOptions: UpdateHttpClientOptions = {},
): Promise<void> {
  const previous = useUpdateCheckStore.getState();
  const retryIds = new Set(
    previous.results
      .filter(
        ({ kind }) =>
          kind === "failed" ||
          kind === "source_regression" ||
          kind === "cancelled",
      )
      .map(({ appId }) => appId),
  );
  if (retryIds.size === 0 || useAppsStore.getState().operationBusy) return;
  abandonActiveWork();
  const attempt = ++generation;
  const abort = new AbortController();
  activeAbort = abort;
  updateCheckState.retrying();
  let registryChanged = false;
  let stopWatchingRegistry: () => void = () => undefined;
  try {
    const snapshot = await getAppUpdateSnapshot();
    if (attempt !== generation || abort.signal.aborted) return;
    const registry = snapshot.apps;
    const provenance = snapshot.provenance;
    if (!updateResultsMatchRegistry(previous.results, registry)) {
      updateCheckState.clear();
      updateCheckState.error(
        "Installed apps changed after the last check. Refresh Settings to use the current versions.",
        "check",
      );
      return;
    }
    const installed = installedUpdateApps(registry, provenance).filter(
      ({ appId }) => retryIds.has(appId),
    );
    stopWatchingRegistry = watchRegistrySnapshot(registry, abort, () => {
      registryChanged = true;
    });
    const summary = await checkForAppUpdates(installed, {
      fetchRelease: (source, appId, { signal }) =>
        fetchUpdateRelease(source, appId, {
          ...clientOptions,
          ...(signal ? { signal } : {}),
        }),
      signal: abort.signal,
      onProgress(progress) {
        if (attempt === generation) updateCheckState.progress(progress);
      },
      onResult(result) {
        if (attempt === generation) updateCheckState.result(result);
      },
    });
    if (attempt !== generation || abort.signal.aborted) return;
    const replacements = new Map(
      summary.results.map((result) => [result.appId, result]),
    );
    const merged = previous.results
      .map((result) => replacements.get(result.appId) ?? result)
      .filter((result) => Boolean(registry[result.appId]));
    const previousSelected = new Set(previous.selectedAppIds);
    updateCheckState.ready(merged, summary.checkedAt);
    updateCheckState.selection(
      merged
        .filter(isSelectableUpdateResult)
        .filter(({ appId }) => previousSelected.has(appId))
        .map(({ appId }) => appId),
    );
    watchReadyRegistry(registry);
  } catch (error) {
    if (attempt !== generation) return;
    if (registryChanged) {
      updateCheckState.error(
        "Installed apps changed while checking. Refresh Settings to use the current versions.",
        "check",
      );
      return;
    }
    if (isAbortError(error)) return;
    updateCheckState.error(safeUpdateError(error), "check");
  } finally {
    stopWatchingRegistry();
    if (activeAbort === abort) activeAbort = null;
  }
}

export function toggleUpdateSelection(appId: string): void {
  const state = useUpdateCheckStore.getState();
  if (state.phase !== "ready" && state.phase !== "error") return;
  const selectable = new Set(
    state.results
      .filter(isSelectableUpdateResult)
      .map(({ appId: id }) => id),
  );
  if (!selectable.has(appId)) return;
  const selected = new Set(state.selectedAppIds);
  if (selected.has(appId)) selected.delete(appId);
  else selected.add(appId);
  updateCheckState.selection([...selected]);
}

export async function prepareAppUpdate(
  appId: string,
  clientOptions: UpdateHttpClientOptions = {},
): Promise<void> {
  const state = useUpdateCheckStore.getState();
  if (
    state.errorStage === "apply" ||
    (state.phase !== "ready" &&
      !(state.phase === "error" && state.results.length > 0)) ||
    !state.results.some(
      (result) => result.appId === appId && result.kind === "available",
    )
  ) {
    return;
  }
  updateCheckState.selection([appId]);
  await prepareSelectedUpdates(clientOptions);
}

export async function prepareAllAvailableUpdates(
  clientOptions: UpdateHttpClientOptions = {},
): Promise<void> {
  const state = useUpdateCheckStore.getState();
  if (
    state.errorStage === "apply" ||
    (state.phase !== "ready" &&
      !(state.phase === "error" && state.results.length > 0))
  ) {
    return;
  }
  const availableAppIds = state.results
    .filter(
      (result): result is Extract<UpdateCheckResult, { kind: "available" }> =>
        result.kind === "available",
    )
    .map(({ appId }) => appId);
  if (availableAppIds.length === 0) return;
  updateCheckState.selection(availableAppIds);
  await prepareSelectedUpdates(clientOptions);
}

export async function prepareSelectedUpdates(
  clientOptions: UpdateHttpClientOptions = {},
): Promise<void> {
  const state = useUpdateCheckStore.getState();
  if (
    state.errorStage === "apply" ||
    (state.phase !== "ready" &&
      !(state.phase === "error" && state.results.length > 0))
  ) {
    return;
  }
  const candidates = selectedCandidates(state.results, state.selectedAppIds);
  if (candidates.length === 0) return;
  try {
    assertSelectedUpdateBounds(candidates);
  } catch (error) {
    updateCheckState.error(safeUpdateError(error), "prepare");
    return;
  }

  stopWatchingReadyRegistry();
  abandonPreparedSession();
  const attempt = ++generation;
  const abort = new AbortController();
  activeAbort = abort;
  updateCheckState.preparing();
  let session: PackageUpdateSession | null = null;
  try {
    session = await beginPackageInstallSession({ mode: "update" });
    if (attempt !== generation || abort.signal.aborted) {
      session.cancel();
      return;
    }
    activeSession = session;

    let archiveEntries = 0;
    let decodedBytes = 0;
    const packages: PreparedPackageInstall[] = [];
    const reviewApps: UpdateReviewApp[] = [];
    const provenance: Record<string, UpdateSourceInstallProvenance> =
      Object.create(null);

    for (const candidate of candidates) {
      throwIfAborted(abort.signal);
      const baseline = session.baseline.state.apps[candidate.appId];
      if (
        !baseline ||
        baseline.version !== candidate.installed ||
        baseline.update_source !== candidate.source
      ) {
        throw new Error(
          `${candidate.name} changed after the update check. Refresh Settings before updating.`,
        );
      }

      const currentRelease = await fetchUpdateRelease(
        candidate.source,
        candidate.appId,
        { ...clientOptions, signal: abort.signal },
      );
      if (
        !currentRelease ||
        currentRelease.releaseDigest !== candidate.releaseDigest ||
        !sameRelease(currentRelease.record, candidate.release)
      ) {
        throw new Error(
          `${candidate.name}'s published release changed. Refresh Settings before updating.`,
        );
      }
      const bytes = await fetchUpdatePackage(
        candidate.source,
        currentRelease.record,
        { ...clientOptions, signal: abort.signal },
      );
      const remainingEntries =
        REPOSITORY_LIMITS.manifestArchiveEntries - archiveEntries;
      const remainingDecoded =
        REPOSITORY_LIMITS.decodedManifestBytes - decodedBytes;
      if (remainingEntries < 1 || remainingDecoded < 1) {
        throw new Error("Selected updates exceed the aggregate package limits");
      }
      const details = await get_app_details(null, bytes, {
        limits: {
          ...REMOTE_NEUTRON_PACKAGE_DECODE_LIMITS,
          maxEntries: Math.min(
            REMOTE_NEUTRON_PACKAGE_DECODE_LIMITS.maxEntries,
            remainingEntries,
          ),
          maxDecodedTotalBytes: Math.min(
            REMOTE_NEUTRON_PACKAGE_DECODE_LIMITS.maxDecodedTotalBytes,
            remainingDecoded,
          ),
        },
        expectedIdentity: {
          id: currentRelease.record.id,
          version: currentRelease.record.version,
          sha256: currentRelease.record.sha256,
          size: currentRelease.record.size,
        },
      });
      archiveEntries += details.preparedPackage.files.length;
      decodedBytes = details.preparedPackage.files.reduce(
        (total, file) => total + file.content.byteLength,
        decodedBytes,
      );
      if (
        archiveEntries > REPOSITORY_LIMITS.manifestArchiveEntries ||
        decodedBytes > REPOSITORY_LIMITS.decodedManifestBytes
      ) {
        throw new Error("Selected updates exceed the aggregate package limits");
      }
      const disclosures = configInstallDisclosures(details.neutronConfig);
      if (
        disclosures.planFingerprint !==
        details.preparedPackage.capabilityPlanFingerprint
      ) {
        throw new Error(
          `Prepared capability plan mismatch for ${candidate.appId}`,
        );
      }
      const capabilityPlanDiff = diffCapabilityPlans(
        baseline.capability_plan,
        details.preparedPackage.capabilityPlan,
      );
      if (
        capabilityPlanDiff.previous.plan_fingerprint !==
        baseline.capability_plan_fingerprint
      ) {
        throw new Error(
          `Installed capability plan mismatch for ${candidate.appId}`,
        );
      }
      packages.push(details.preparedPackage);
      const targetSource = normalizeManifestUpdateSource(
        details.preparedPackage.manifest,
      );
      reviewApps.push(
        Object.freeze({
          appId: candidate.appId,
          name: details.preparedPackage.manifest.name,
          installedVersion: candidate.installed,
          targetVersion: currentRelease.record.version,
          source: candidate.source,
          currentUpdateSource: candidate.source,
          ...(targetSource ? { targetUpdateSource: targetSource } : {}),
          packageBytes: bytes.byteLength,
          packageDigest: currentRelease.record.sha256,
          releaseDigest: currentRelease.releaseDigest,
          capabilityPlanDiff,
          capabilityDisclosures: Object.freeze([
            ...disclosures.capabilityDisclosures,
          ]),
          permissions: Object.freeze([...disclosures.permissions]),
          appExplanations: Object.freeze([
            ...disclosures.appExplanations,
          ]),
          dependencies: Object.freeze({
            ...(details.preparedPackage.manifest.dependencies ?? {}),
          }),
        }),
      );
      provenance[candidate.appId] = Object.freeze({
        kind: "update_source",
        source_canister: candidate.source,
        release_digest: currentRelease.releaseDigest,
        package_digest: currentRelease.record.sha256,
        checked_at: state.checkedAt ?? Date.now(),
      });
    }

    const copyCount =
      5 +
      packages.reduce(
        (total, pkg) =>
          total +
          pkg.files.filter(({ path }) => !path.startsWith("mo/")).length,
        0,
      );
    if (copyCount > KERNEL_INSTALL_MAX_COPIES) {
      throw new Error(
        `Selected updates require ${copyCount} asset copies; this kernel supports ${KERNEL_INSTALL_MAX_COPIES}.`,
      );
    }
    const compiled = await session.compile(packages);
    if (attempt !== generation || abort.signal.aborted) {
      session.cancel();
      return;
    }
    const deployment = session.getPreparedDeployment(packages, compiled);
    // Validate every display/export reconciliation before publishing raw archive
    // bytes into the review store. A bad record remains a preparation failure.
    createDeploymentBuildReviewModel(deployment.review);
    const review: UpdateReview = Object.freeze({
      apps: Object.freeze(
        reviewApps.sort((left, right) =>
          compareCanonicalText(left.appId, right.appId),
        ),
      ),
      deploymentBuild: deployment.review,
      compiledSizeKiB: Math.ceil(compiled.wasm.byteLength / 1024),
      migrationPlan: compiled.migrationPlan,
      diagnostics: Object.freeze(compiled.diagnostics.map(diagnosticText)),
      compatibilityDiagnostics: Object.freeze(
        compiled.compatibilityDiagnostics.map(diagnosticText),
      ),
    });
    activePackages = Object.freeze([...packages]);
    activeCompiled = compiled;
    activeDeploymentBuildRecord = deployment.prepared.record;
    activeProvenance = Object.freeze({ ...provenance });
    activeSelectionFingerprint = selectionFingerprint(candidates);
    updateCheckState.review(review);
  } catch (error) {
    session?.cancel();
    if (activeSession === session) activeSession = null;
    activeCompiled = null;
    activePackages = [];
    activeDeploymentBuildRecord = null;
    activeProvenance = Object.freeze({});
    activeSelectionFingerprint = "";
    if (attempt !== generation || isAbortError(error)) return;
    updateCheckState.error(safeUpdateError(error), "prepare");
  } finally {
    if (activeAbort === abort) activeAbort = null;
  }
}

export async function applyPreparedUpdates(): Promise<void> {
  const state = useUpdateCheckStore.getState();
  if (state.phase !== "review" || !state.review) return;
  if (
    !activeSession ||
    !activeCompiled ||
    !activeDeploymentBuildRecord ||
    activePackages.length === 0
  ) {
    abandonPreparedSession();
    updateCheckState.error(
      "The prepared update expired before deployment. Review it again.",
      "prepare",
    );
    return;
  }
  if (state.review.deploymentBuild.record !== activeDeploymentBuildRecord) {
    abandonPreparedSession();
    updateCheckState.error(
      "The deployment build record changed after compilation. Review it again.",
      "prepare",
    );
    return;
  }
  const candidates = selectedCandidates(state.results, state.selectedAppIds);
  if (selectionFingerprint(candidates) !== activeSelectionFingerprint) {
    abandonPreparedSession();
    updateCheckState.error(
      "The selected update set changed after compilation. Review it again.",
      "prepare",
    );
    return;
  }
  const session = activeSession;
  const compiled = activeCompiled;
  const packages = activePackages;
  const deploymentBuildRecord = activeDeploymentBuildRecord;
  const provenance = activeProvenance;
  updateCheckState.applying();
  try {
    await session.deploy({
      packages,
      compiled,
      deploymentBuildRecord,
      provenance,
    });
    activeSession = null;
    activeCompiled = null;
    activePackages = [];
    activeDeploymentBuildRecord = null;
    activeProvenance = Object.freeze({});
    activeSelectionFingerprint = "";
    updateCheckState.success(packages.length);
  } catch (error) {
    activeSession = null;
    activeCompiled = null;
    activePackages = [];
    activeDeploymentBuildRecord = null;
    activeProvenance = Object.freeze({});
    activeSelectionFingerprint = "";
    updateCheckState.error(safeUpdateError(error), "apply");
  }
}

export function backToUpdateResults(): void {
  const state = useUpdateCheckStore.getState();
  abandonPreparedSession();
  if (state.checkedAt !== null) {
    updateCheckState.ready(state.results, state.checkedAt);
    updateCheckState.selection(state.selectedAppIds);
    watchReadyRegistry(useAppsStore.getState().list);
  } else {
    updateCheckState.clear();
  }
}

export function cancelUpdateWork(): void {
  const phase = useUpdateCheckStore.getState().phase;
  if (
    phase !== "checking" &&
    phase !== "preparing" &&
    phase !== "review"
  ) return;
  generation += 1;
  abandonActiveWork();
  updateCheckState.cancelled();
  if (useUpdateCheckStore.getState().results.length > 0) {
    watchReadyRegistry(useAppsStore.getState().list);
  }
}

export function clearUpdateResults(): void {
  generation += 1;
  abandonActiveWork();
  updateCheckState.clear();
}

function abandonPreparedSession(): void {
  activeSession?.cancel();
  activeSession = null;
  activeCompiled = null;
  activePackages = [];
  activeDeploymentBuildRecord = null;
  activeProvenance = Object.freeze({});
  activeSelectionFingerprint = "";
}

function isSelectableUpdateResult(result: UpdateCheckResult): boolean {
  return (
    result.kind === "available" ||
    result.kind === "failed" ||
    result.kind === "source_regression" ||
    result.kind === "cancelled"
  );
}

function abandonActiveWork(): void {
  stopWatchingReadyRegistry();
  activeAbort?.abort();
  activeAbort = null;
  abandonPreparedSession();
}

function watchReadyRegistry(
  registry: ReturnType<typeof useAppsStore.getState>["list"],
): void {
  stopWatchingReadyRegistry();
  const abort = new AbortController();
  let stop: () => void = () => undefined;
  stop = watchRegistrySnapshot(registry, abort, () => {
    stop();
    if (stopReadyRegistryWatch === stop) stopReadyRegistryWatch = null;
    generation += 1;
    abandonPreparedSession();
    updateCheckState.clear();
    updateCheckState.error(
      "Installed apps changed after this check. Refresh Settings to use the current versions.",
      "check",
    );
  });
  stopReadyRegistryWatch = stop;
}

function stopWatchingReadyRegistry(): void {
  stopReadyRegistryWatch?.();
  stopReadyRegistryWatch = null;
}

function safeUpdateError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error("The update operation failed.");
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (typeof DOMException !== "undefined") {
    throw new DOMException("Update operation cancelled", "AbortError");
  }
  const error = new Error("Update operation cancelled");
  error.name = "AbortError";
  throw error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
