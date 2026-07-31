import {
  KERNEL_INSTALL_MAX_COPIES,
  REMOTE_NEUTRON_PACKAGE_DECODE_LIMITS,
  type CompileResult,
  type PreparedPackageInstall,
} from "neutron-compiler/src/install.js";
import { planAppDependencies } from "neutron-compiler/src/app_dependencies.js";
import {
  REPOSITORY_LIMITS,
  clearPendingRepositorySetup,
  readPendingRepositorySetup,
  stagePendingRepositorySetup,
  type RepositorySetupReference,
} from "neutron-tools/repository";
import { normalizeManifestDependencies } from "neutron-tools/src/schema.js";
import { formatAppVersionLabel } from "neutron-tools/src/version.js";
import { configInstallDisclosures } from "../lib/perm.ts";
import { kernelSetupStorage } from "../bootstrap.ts";
import type { AttestedInstallOfferRequester } from "../install_offers/types.ts";
import {
  beginRepositoryInstallSession,
  type RepositoryInstallSession,
} from "../reducer/apps.ts";
import { get_app_details } from "../tools/app.ts";
import {
  availableRepositoryPackageIds,
  reconcileRepositoryPackages,
  resolveRepositorySelection,
  type VerifiedRepositoryPackage,
} from "./model.ts";
import {
  loadRepositorySetupBytes,
  type RepositoryClientOptions,
} from "./client.ts";
import type { RepositoryInstallProvenance } from "./provenance.ts";
import {
  canStartRepositoryLoad,
  repositorySetupState,
  useRepositorySetupStore,
} from "./store.ts";

let activeSession: RepositoryInstallSession | null = null;
let activeAbort: AbortController | null = null;
let activeCompiled: CompileResult | null = null;
let compiledPackageIds: readonly string[] = [];
let activeExpiryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
let generation = 0;

export function refreshPendingRepositorySetup({
  freshCapture = false,
}: { freshCapture?: boolean } = {}): void {
  let pending;
  try {
    pending = readPendingRepositorySetup(kernelSetupStorage);
  } catch (error) {
    console.warn("Unable to read pending repository setup", error);
    return;
  }
  const reference = pending?.reference ?? null;
  if (!reference) {
    clearExpiryTimer();
    return;
  }
  const current = useRepositorySetupStore.getState().reference;
  if (current && referencesEqual(current, reference) && !freshCapture) {
    schedulePendingExpiry(reference, pending!.capturedAt);
    return;
  }
  abandonActiveAttempt(false);
  repositorySetupState.pending(reference);
  schedulePendingExpiry(reference, pending!.capturedAt);
}

/**
 * Admit an already owner-approved app/agent offer into the existing certified
 * repository pipeline. The offer dialog supplied the pre-contact consent, so
 * this stages the canonical same-tab reference and begins loading immediately
 * instead of showing the external-link contact prompt a second time.
 */
export function startRepositorySetupFromOffer(
  reference: RepositorySetupReference,
  offeredBy: AttestedInstallOfferRequester,
): void {
  const state = useRepositorySetupStore.getState();
  if (state.phase !== "idle" || state.reference) {
    throw new Error("Another repository setup is already active");
  }
  if (readPendingRepositorySetup(kernelSetupStorage)) {
    throw new Error(
      "Another repository setup was captured while this offer was open",
    );
  }
  abandonActiveAttempt(false);
  const pending = stagePendingRepositorySetup(
    kernelSetupStorage,
    reference,
    Date.now(),
  );
  repositorySetupState.pending(pending.reference, offeredBy);
  schedulePendingExpiry(pending.reference, pending.capturedAt);
  void loadRepositorySetup();
}

export async function loadRepositorySetup(
  clientOptions: RepositoryClientOptions = {},
): Promise<void> {
  const initialState = useRepositorySetupStore.getState();
  if (!canStartRepositoryLoad(initialState.phase, initialState.errorStage)) return;
  const reference = initialState.reference;
  if (!reference) return;
  try {
    requireCurrentPendingReference(reference);
  } catch (error) {
    repositorySetupState.error("load", error);
    return;
  }
  const attempt = ++generation;
  abandonActiveAttempt(false, false);
  repositorySetupState.loading({
    label: "Preparing an authenticated install baseline",
    current: 0,
    total: 1,
  });
  const abort = new AbortController();
  activeAbort = abort;
  try {
    const session = await beginRepositoryInstallSession();
    if (attempt !== generation || abort.signal.aborted) {
      session.cancel();
      return;
    }
    activeSession = session;
    const fetched = await loadRepositorySetupBytes(reference, {
      ...clientOptions,
      signal: abort.signal,
      onProgress(progress) {
        if (attempt === generation) repositorySetupState.progress(progress);
        clientOptions.onProgress?.(progress);
      },
    });

    let decodedBytes = 0;
    let archiveEntries = 0;
    const packages: VerifiedRepositoryPackage[] = [];
    for (const [index, fetchedPackage] of fetched.packages.entries()) {
      if (abort.signal.aborted) throw abortError();
      repositorySetupState.progress({
        label: `Validating package ${index + 1} of ${fetched.packages.length}`,
        current: index,
        total: fetched.packages.length,
      });
      const remainingEntries =
        REPOSITORY_LIMITS.manifestArchiveEntries - archiveEntries;
      const remainingDecodedBytes =
        REPOSITORY_LIMITS.decodedManifestBytes - decodedBytes;
      if (remainingEntries < 1 || remainingDecodedBytes < 1) {
        throw new Error("Repository setup exceeds its aggregate decode limits");
      }
      const details = await get_app_details(
        null,
        fetchedPackage.bytes,
        {
          limits: {
            ...REMOTE_NEUTRON_PACKAGE_DECODE_LIMITS,
            maxEntries: Math.min(
              REMOTE_NEUTRON_PACKAGE_DECODE_LIMITS.maxEntries,
              remainingEntries,
            ),
            maxDecodedTotalBytes: Math.min(
              REMOTE_NEUTRON_PACKAGE_DECODE_LIMITS.maxDecodedTotalBytes,
              remainingDecodedBytes,
            ),
          },
          expectedIdentity: {
            id: fetchedPackage.metadata.id,
            version: fetchedPackage.metadata.version,
            sha256: fetchedPackage.metadata.sha256,
            size: fetchedPackage.metadata.size,
          },
        },
      );
      const expected = fetchedPackage.metadata;
      if (
        details.neutronConfig.id !== expected.id ||
        details.neutronConfig.version !== expected.version
      ) {
        throw new Error(
          `Package identity mismatch for ${expected.id}: expected ${formatAppVersionLabel(expected.version)}, received ${details.neutronConfig.id} ${formatAppVersionLabel(details.neutronConfig.version)}`,
        );
      }
      if (details.neutronConfig.id === "kernel" || details.preparedPackage.isKernel) {
        throw new Error("Repository setup cannot replace the Neutron kernel");
      }
      archiveEntries = checkedAdd(
        archiveEntries,
        details.preparedPackage.files.length,
        "archive entries",
      );
      decodedBytes = details.preparedPackage.files.reduce(
        (total, file) => checkedAdd(total, file.content.byteLength, "decoded bytes"),
        decodedBytes,
      );
      if (archiveEntries > REPOSITORY_LIMITS.manifestArchiveEntries) {
        throw new Error("Repository setup exceeds the aggregate archive-entry limit");
      }
      if (decodedBytes > REPOSITORY_LIMITS.decodedManifestBytes) {
        throw new Error("Repository setup exceeds the aggregate decoded-byte limit");
      }
      const disclosures = configInstallDisclosures(details.neutronConfig);
      if (
        disclosures.planFingerprint !==
        details.preparedPackage.capabilityPlanFingerprint
      ) {
        throw new Error("Prepared package capability plan mismatch");
      }
      packages.push(
        Object.freeze({
          id: expected.id,
          version: expected.version,
          digest: expected.sha256,
          rawSize: expected.size,
          ...(expected.publisher
            ? { publisher: Object.freeze({ ...expected.publisher }) }
            : {}),
          ...(expected.source ? { source: expected.source } : {}),
          preparedPackage: details.preparedPackage,
          capabilityPlanFingerprint: disclosures.planFingerprint,
          capabilityDisclosures: Object.freeze([
            ...disclosures.capabilityDisclosures,
          ]),
          permissions: Object.freeze([...disclosures.permissions]),
          appExplanations: Object.freeze([...disclosures.appExplanations]),
        }),
      );
    }

    const { reconciliation, selection } = prepareRepositoryLoadState({
      packages,
      baseline: session.baseline,
    });
    if (attempt !== generation || abort.signal.aborted) return;
    repositorySetupState.loaded(
      {
        info: fetched.info,
        manifest: fetched.manifest,
        packages,
        reconciliation,
      },
      selection,
    );
    if (availableRepositoryPackageIds(packages, reconciliation).length === 0) {
      session.cancel();
      activeSession = null;
    }
  } catch (error) {
    if (attempt !== generation || abort.signal.aborted) return;
    activeSession?.cancel();
    activeSession = null;
    repositorySetupState.error("load", error);
  } finally {
    if (activeAbort === abort) activeAbort = null;
  }
}

export function toggleRepositoryPackage(appId: string): void {
  const state = useRepositorySetupStore.getState();
  if (state.phase !== "selecting" || !state.loaded) return;
  if (state.selection?.automatic.has(appId)) return;
  const roots = new Set(state.rootIds);
  if (roots.has(appId)) roots.delete(appId);
  else roots.add(appId);
  setRoots(roots);
}

export function selectAllRepositoryPackages(selected: boolean): void {
  const state = useRepositorySetupStore.getState();
  if (state.phase !== "selecting" || !state.loaded) return;
  setRoots(
    new Set(
      selected
        ? availableRepositoryPackageIds(
            state.loaded.packages,
            state.loaded.reconciliation,
          )
        : [],
    ),
  );
}

export async function reviewRepositorySelection(): Promise<void> {
  const state = useRepositorySetupStore.getState();
  const canCompile =
    state.phase === "selecting" ||
    (state.phase === "error" && state.errorStage === "compile");
  if (
    !canCompile ||
    !activeSession ||
    !state.loaded ||
    !state.selection ||
    state.selection.selected.size === 0 ||
    state.selection.blockers.length > 0
  ) {
    return;
  }
  try {
    requireCurrentPendingReference(state.reference!);
  } catch (error) {
    expireActiveSetup(error);
    return;
  }
  const attempt = generation;
  const packages = selectedPackages(state.loaded.packages, state.selection.selected);
  const copyCount =
    4 +
    packages.reduce(
      (total, pkg) =>
        checkedAdd(
          total,
          pkg.files.filter(({ path }) => !path.startsWith("mo/")).length,
          "install journal copies",
        ),
      0,
    );
  if (copyCount > KERNEL_INSTALL_MAX_COPIES) {
    repositorySetupState.error(
      "compile",
      new Error(
        `Selected applications require ${copyCount} asset copies; this kernel supports ${KERNEL_INSTALL_MAX_COPIES}`,
      ),
    );
    return;
  }
  const ids = packages.map(({ manifest }) => manifest.id).sort();
  repositorySetupState.compiling();
  try {
    const compiled = await activeSession.compile(packages);
    if (attempt !== generation) return;
    activeCompiled = compiled;
    compiledPackageIds = Object.freeze(ids);
    repositorySetupState.review(Math.ceil(compiled.wasm.byteLength / 1024));
  } catch (error) {
    if (attempt !== generation) return;
    repositorySetupState.error("compile", error);
  }
}

export function backToRepositorySelection(): void {
  const state = useRepositorySetupStore.getState();
  if (!state.loaded || !state.selection) return;
  activeCompiled = null;
  compiledPackageIds = [];
  repositorySetupState.selection(state.rootIds, state.selection);
}

export async function installRepositorySelection(): Promise<void> {
  const state = useRepositorySetupStore.getState();
  if (
    state.phase !== "review" ||
    !activeSession ||
    !activeCompiled ||
    !state.loaded ||
    !state.selection
  ) return;
  try {
    requireCurrentPendingReference(state.reference!);
  } catch (error) {
    expireActiveSetup(error);
    return;
  }
  const packages = selectedPackages(state.loaded.packages, state.selection.selected);
  const compiled = activeCompiled;
  const ids = packages.map(({ manifest }) => manifest.id).sort();
  if (JSON.stringify(ids) !== JSON.stringify(compiledPackageIds)) {
    repositorySetupState.error(
      "compile",
      new Error("The selected app set changed after compilation"),
    );
    return;
  }
  const reference = state.reference!;
  const provenance = Object.fromEntries(
    state.loaded.packages
      .filter(({ id }) => state.selection!.selected.has(id))
      .map(({ id, digest }) => [
        id,
        {
          kind: "repository" as const,
          repository: reference.repo,
          manifest_id: reference.manifest,
          manifest_digest: reference.digest,
          package_digest: digest,
        } satisfies RepositoryInstallProvenance,
      ]),
  );
  const session = activeSession;
  const attempt = generation;
  // The user has now approved the exact compiled transaction. It may finish
  // after the setup-link lifetime without being cancelled mid-deployment.
  clearExpiryTimer();
  repositorySetupState.installing();
  await nextPaint();
  if (attempt !== generation) {
    session.cancel();
    return;
  }
  try {
    await session.deploy({ packages, compiled, provenance });
    if (attempt !== generation) return;
    clearPendingRepositorySetup(kernelSetupStorage);
    activeCompiled = null;
    compiledPackageIds = [];
    repositorySetupState.success();
  } catch (error) {
    if (attempt === generation) {
      try {
        // Final approval pauses expiry so an in-flight transaction is not
        // cancelled halfway through. If deployment fails, resume the original
        // deadline (or fail it closed immediately if it elapsed meanwhile).
        requireCurrentPendingReference(reference);
        repositorySetupState.error("install", error);
      } catch (pendingError) {
        expireActiveSetup(pendingError);
      }
    }
  } finally {
    if (activeSession === session) activeSession = null;
  }
}

export async function retryRepositorySetup(
  stage: "load" | "compile" | "install" | null,
): Promise<void> {
  if (stage === "compile" && activeSession) {
    await reviewRepositorySelection();
    return;
  }
  await loadRepositorySetup();
}

export async function dismissRepositorySetup(): Promise<void> {
  abandonActiveAttempt(true);
  repositorySetupState.clear();
}

export async function finishRepositorySetup(): Promise<void> {
  abandonActiveAttempt(true);
  repositorySetupState.clear();
}

export function clearRepositorySetupForOwnerChange(): void {
  abandonActiveAttempt(true);
  repositorySetupState.clear();
}

function setRoots(roots: Set<string>): void {
  const state = useRepositorySetupStore.getState();
  if (!state.loaded) return;
  activeCompiled = null;
  compiledPackageIds = [];
  const selection = resolveRepositorySelection({
    packages: state.loaded.packages,
    reconciliation: state.loaded.reconciliation,
    roots,
  });
  repositorySetupState.selection([...roots], selection);
}

function selectedPackages(
  packages: readonly VerifiedRepositoryPackage[],
  selected: ReadonlySet<string>,
): PreparedPackageInstall[] {
  return packages
    .filter(({ id }) => selected.has(id))
    .map(({ preparedPackage }) => preparedPackage);
}

function abandonActiveAttempt(
  clearStorage: boolean,
  incrementGeneration = true,
): void {
  if (incrementGeneration) {
    generation += 1;
    clearExpiryTimer();
  }
  activeAbort?.abort();
  activeAbort = null;
  activeSession?.cancel();
  activeSession = null;
  activeCompiled = null;
  compiledPackageIds = [];
  if (clearStorage) {
    try {
      clearPendingRepositorySetup(kernelSetupStorage);
    } catch (error) {
      console.warn("Unable to clear pending repository setup", error);
    }
  }
}

export function prepareRepositoryLoadState({
  packages,
  baseline,
}: {
  packages: readonly VerifiedRepositoryPackage[];
  baseline: RepositoryInstallSession["baseline"];
}): {
  reconciliation: ReturnType<typeof reconcileRepositoryPackages>;
  selection: ReturnType<typeof resolveRepositorySelection>;
} {
  // Validate the advertised graph independently of the user's later choice.
  // Repository manifests override an older installed package only for this
  // validation pass; reconciliation still prevents replacing that package and
  // reports its incompatibility when a dependent root is selected.
  planAppDependencies(
    repositoryValidationTarget(packages, baseline.state.existingConfigs),
  );
  const reconciliation = reconcileRepositoryPackages({
    packages,
    registry: baseline.state.apps,
    configs: baseline.state.existingConfigs,
    runtime: baseline.runtime,
  });
  return {
    reconciliation,
    selection: resolveRepositorySelection({
      packages,
      reconciliation,
      roots: new Set(),
    }),
  };
}

function repositoryValidationTarget(
  packages: readonly VerifiedRepositoryPackage[],
  installed: RepositoryInstallSession["baseline"]["state"]["existingConfigs"],
): RepositoryInstallSession["baseline"]["state"]["existingConfigs"] {
  const target = Object.fromEntries(
    packages.map(({ id, preparedPackage }) => [id, preparedPackage.manifest]),
  );
  const pending = packages.map(({ preparedPackage }) => preparedPackage.manifest);
  for (let index = 0; index < pending.length; index += 1) {
    for (const dependency of Object.values(
      normalizeManifestDependencies(pending[index]!),
    )) {
      if (target[dependency.app]) continue;
      const provider = installed[dependency.app];
      if (!provider) continue;
      target[dependency.app] = provider;
      pending.push(provider);
    }
  }
  return target;
}

function requireCurrentPendingReference(
  reference: RepositorySetupReference,
): void {
  const pending = readPendingRepositorySetup(kernelSetupStorage);
  const pendingReference = pending?.reference ?? null;
  if (!pendingReference || !referencesEqual(reference, pendingReference)) {
    throw new Error(
      "This setup link expired or was replaced. Open the provider link again.",
    );
  }
  schedulePendingExpiry(reference, pending!.capturedAt);
}

function schedulePendingExpiry(
  reference: RepositorySetupReference,
  capturedAt: number,
): void {
  clearExpiryTimer();
  const expiresAt = capturedAt + REPOSITORY_LIMITS.pendingSetupLifetimeMs;
  const schedule = (): void => {
    const remaining = expiresAt - Date.now();
    if (remaining >= 0) {
      activeExpiryTimer = globalThis.setTimeout(schedule, remaining + 1);
      return;
    }
    activeExpiryTimer = null;
    const state = useRepositorySetupStore.getState();
    if (
      !state.reference ||
      !referencesEqual(state.reference, reference) ||
      state.phase === "idle" ||
      state.phase === "installing" ||
      state.phase === "success"
    ) {
      return;
    }
    expireActiveSetup(
      new Error(
        "This setup link expired. Open the provider link again before compiling or installing.",
      ),
    );
  };
  schedule();
}

function clearExpiryTimer(): void {
  if (activeExpiryTimer === null) return;
  globalThis.clearTimeout(activeExpiryTimer);
  activeExpiryTimer = null;
}

function expireActiveSetup(error: unknown): void {
  abandonActiveAttempt(true);
  repositorySetupState.error("load", error);
}

function checkedAdd(left: number, right: number, label: string): number {
  if (!Number.isSafeInteger(right) || right < 0 || left > Number.MAX_SAFE_INTEGER - right) {
    throw new Error(`Repository ${label} overflow`);
  }
  return left + right;
}

function referencesEqual(
  left: RepositorySetupReference,
  right: RepositorySetupReference,
): boolean {
  return (
    left.repo === right.repo &&
    left.manifest === right.manifest &&
    left.digest === right.digest
  );
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

function abortError(): Error {
  return new DOMException("Repository setup was cancelled", "AbortError");
}
