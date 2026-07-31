import { create } from "zustand";
import { get_app_details } from "../tools/app.ts";
import { pickFile, readFile } from "../tools/file_picker.ts";
import { fetchPackageFromUrl } from "../tools/package_url.ts";
import {
  configInstallDisclosures,
  type AppPermissionExplanation,
  type Permission,
} from "../lib/perm.ts";
import {
  appDependencyImpact,
  assertKernelPackageBaselineMatchesRuntime,
  compileAppUninstall,
  compilePackages,
  compilePackageInstall,
  createDeploymentNonce,
  deployPreparedPackages,
  normalizeAppRegistry,
  planAppRegistryDependencies,
  REMOTE_NEUTRON_PACKAGE_DECODE_LIMITS,
  recoverPendingInstall,
  readKernelPackageState,
  type AppRegistry,
  type CompileResult,
  type DeployPackageStep,
  type InstallJournalStatus,
  type KernelRuntimeInfo,
  type InstallStagedAsset,
  type KernelPackageState,
  type PreparedPackageInstall,
} from "neutron-compiler/src/install.js";
import { disposeMotokoCompiler } from "neutron-motoko-wasm";
import { getRuntimeDeployment } from "../runtime_deployment.ts";
import { removeFrontendAppState } from "./msg_bus.ts";
import {
  removeAllCallRequests,
  removeCallRequestsForApp,
} from "./request.ts";
import { removeBackendCallRequestsForApp } from "./backend_calls.ts";
import { useWorkspaceStore } from "../workspace/store.ts";
import {
  disableAgentMode,
  reconcileAgentGrant,
  removeAgentAppState,
} from "../ui_attention/agent.ts";
import { removeUiAttentionAppState } from "../ui_attention/owner.ts";
import {
  reconcileTrayRegistry,
  removeTrayAppState,
} from "../tray/service.ts";
import { removeConnectionRequestsForApp } from "./connections.ts";
import { hashContent } from "neutron-tools/src/hash.js";
import { compareCanonicalText } from "neutron-tools/src/canonical.js";
import {
  diffCapabilityPlans,
  type CapabilityInstallDisclosureWireV1,
  type CapabilityPlanDiffV1,
} from "neutron-tools/src/capabilities/wire.js";
import {
  INSTALL_PROVENANCE_PATH,
  installProvenanceOrEmpty,
  serializeInstallProvenance,
  withoutInstallProvenance,
  withInstallProvenance,
  type AppInstallProvenance,
  type InstallProvenance,
  type RepositoryInstallProvenance,
} from "../repository/provenance.ts";
import {
  normalizeAppInstanceInventory,
  sameAppInstance,
  sameAppInstanceInventory,
  type AppInstanceProjection,
} from "../app_scope.ts";
import { announceRuntimeAuthorityChange } from "../runtime_authority_signal.ts";
import { clearInstallOfferForApp } from "../install_offers/service.ts";
import type { AttestedInstallOfferRequester } from "../install_offers/types.ts";
import { residentFrameSecurityMode } from "../capabilities/plan.ts";
import {
  assertAppSurfaceInventoryCapacity,
  assertTargetAppSurfaceCapacity,
} from "../runtime_limits.ts";

function runtimeCompilerEnvironment(): "production" | "local" {
  // Runtime deployment is loaded from the Kernel's certified closed config
  // before app management starts. Package, app, and dialog input cannot select
  // this compiler target.
  return getRuntimeDeployment().target === "pocketic"
    ? "local"
    : "production";
}

export type AppInstallRequest = {
  readonly id: string;
  readonly packageName: string;
  readonly packageVersion: number;
  readonly packageDigest: string;
  readonly size: number;
  readonly acquisition?: "file" | "url";
  readonly operation: "install" | "update";
  readonly capabilityPlanFingerprint: string;
  readonly capabilityPlanDiff?: CapabilityPlanDiffV1;
  readonly capabilityDisclosures: readonly CapabilityInstallDisclosureWireV1[];
  readonly permissions: readonly Permission[];
  readonly appExplanations: readonly AppPermissionExplanation[];
  readonly offer?: AppInstallOfferReview;
};

export type AppInstallSource =
  | { readonly kind: "file" }
  | {
      readonly kind: "url";
      readonly signal?: AbortSignal;
      readonly url: string;
    };

export type AppInstallOfferReview = {
  readonly source: string;
  readonly requester: AttestedInstallOfferRequester;
};

export type AppInstallOptions = {
  /**
   * App- and agent-originated offers may install a new app, but never replace
   * the Kernel or any already installed app. The authenticated compiler
   * baseline re-checks this after package decoding and before compilation.
   */
  readonly installOnly?: boolean;
  readonly offer?: AppInstallOfferReview;
};

export type AppInstallRequestInput = {
  readonly id: string;
  readonly packageName: string;
  readonly packageVersion: number;
  readonly packageDigest: string;
  readonly size: number;
  readonly acquisition?: "file" | "url";
  readonly operation?: "install" | "update";
  readonly capabilityPlanFingerprint: string;
  readonly capabilityPlanDiff?: CapabilityPlanDiffV1;
  readonly capabilityDisclosures: readonly CapabilityInstallDisclosureWireV1[];
  readonly permissions: readonly Permission[];
  readonly appExplanations?: readonly AppPermissionExplanation[];
  readonly offer?: AppInstallOfferReview;
};

type AppCompiled = {
  size: number;
};

type AppCompileResult = {
  compiled: CompileResult;
  state: KernelPackageState;
  expectedDeploymentId: string;
};

export type AppOperationKind = "install" | "update" | "uninstall";

export type AppOperationPhase =
  "preparing" | "staging" | "activating" | "cleaning" | "complete";

export type AppOperation = {
  kind: AppOperationKind;
  appId?: string;
  phase: AppOperationPhase;
};

type AppInstallError = {
  kind: AppOperationKind;
  message: string;
};

export type AppUninstallRequest = {
  appId: string;
  appName: string;
  memoryIds: string[];
};

export type AppRegistryStatus = "idle" | "loading" | "ready" | "error";

export type PendingInstallRecovery = {
  deploymentId: string;
  runningTarget?: boolean;
  blockers?: readonly PendingInstallReservationBlocker[];
};

export type PendingInstallReservationBlocker = {
  id: bigint;
  appId: string;
  installationUid: bigint;
  scope: string;
  reason: PendingInstallReservationBlockerReason;
};

export type PendingInstallReservationBlockerReason =
  | "scope_conflict"
  | "app_capacity"
  | "global_capacity";

export type RuntimeAuthorityFence = {
  deploymentId: string | null;
  reason: "runtime_changed" | "observation_failed";
};

export type AppInstallResult = {
  appId: string;
  apps: AppRegistry;
};

export type RepositoryInstallBaseline = {
  readonly state: KernelPackageState;
  readonly runtime: KernelRuntimeInfo;
};

export type RepositoryInstallSession = {
  readonly baseline: RepositoryInstallBaseline;
  compile(packages: readonly PreparedPackageInstall[]): Promise<CompileResult>;
  deploy(input: {
    packages: readonly PreparedPackageInstall[];
    compiled: CompileResult;
    provenance: Readonly<Record<string, RepositoryInstallProvenance>>;
  }): Promise<AppRegistry>;
  cancel(): void;
};

export type PackageUpdateSession = {
  readonly baseline: RepositoryInstallBaseline;
  compile(packages: readonly PreparedPackageInstall[]): Promise<CompileResult>;
  deploy(input: {
    packages: readonly PreparedPackageInstall[];
    compiled: CompileResult;
    provenance: Readonly<Record<string, AppInstallProvenance>>;
  }): Promise<AppRegistry>;
  cancel(): void;
};

type AppCallbacks = {
  resolve: () => void;
  reject: (error: Error) => void;
};

type AppsState = {
  list: AppRegistry;
  appInstances: Readonly<Record<string, AppInstanceProjection>>;
  runtimeGenerations: Record<string, number>;
  registryStatus: AppRegistryStatus;
  registryError: string | null;
  registryUpdatedAt: number | null;
  request: AppInstallRequest | null;
  uninstallRequest: AppUninstallRequest | null;
  compiled: AppCompiled | null;
  operation: AppOperation | null;
  operationBusy: boolean;
  installError: AppInstallError | null;
  pendingInstallRecovery: PendingInstallRecovery | null;
  runtimeAuthorityFence: RuntimeAuthorityFence | null;
  setApps: (
    apps: AppRegistry,
    options?: {
      invalidateAppIds?: readonly string[];
      appInstances?: Readonly<Record<string, AppInstanceProjection>>;
    },
  ) => void;
  setRegistryLoading: () => void;
  setRegistryError: (message: string) => void;
  addAppRequest: (request: AppInstallRequestInput) => void;
  clearAppRequest: () => void;
  setUninstallRequest: (request: AppUninstallRequest | null) => void;
  setCompiled: (compiled: AppCompiled | null) => void;
  setOperation: (operation: AppOperation | null) => void;
  setOperationBusy: (busy: boolean) => void;
  setInstallError: (error: AppInstallError | null) => void;
  setPendingInstallRecovery: (recovery: PendingInstallRecovery | null) => void;
  setRuntimeAuthorityFence: (fence: RuntimeAuthorityFence | null) => void;
  setInstalled: () => void;
};

export const useAppsStore = create<AppsState>((set, get) => ({
  list: {},
  appInstances: {},
  runtimeGenerations: {},
  registryStatus: "idle",
  registryError: null,
  registryUpdatedAt: null,
  request: null,
  uninstallRequest: null,
  compiled: null,
  operation: null,
  operationBusy: false,
  installError: null,
  pendingInstallRecovery: null,
  runtimeAuthorityFence: null,
  setApps: (apps, options = {}) => {
    const normalized = normalizeAppRegistry(apps);
    assertAppSurfaceInventoryCapacity(normalized);
    const suppliedInstances = options.appInstances;
    const revokedAppIds = new Set<string>();
    reconcileTrayRegistry(normalized);
    set((state) => {
      const forced = new Set(options.invalidateAppIds ?? []);
      const appInstances = suppliedInstances
        ? requireInstancesForRegistry(normalized, suppliedInstances)
        : retainMatchingAppInstances(normalized, state.appInstances);
      reconcileAgentGrant(normalized, appInstances);
      const runtimeGenerations = { ...state.runtimeGenerations };
      const appIds = new Set([
        ...Object.keys(state.list),
        ...Object.keys(normalized),
        ...forced,
      ]);
      for (const appId of appIds) {
        if (
          forced.has(appId) ||
          !registryEntriesEqual(state.list[appId], normalized[appId]) ||
          !sameAppInstance(
            state.appInstances[appId],
            appInstances[appId],
          )
        ) {
          runtimeGenerations[appId] =
            (state.runtimeGenerations[appId] ?? 0) + 1;
          if (state.list[appId] || state.appInstances[appId]) {
            revokedAppIds.add(appId);
          }
        }
      }
      return {
        list: normalized,
        appInstances,
        runtimeGenerations,
        registryStatus: "ready",
        registryError: null,
        registryUpdatedAt: Date.now(),
      };
    });
    for (const appId of revokedAppIds) removeAppRuntimeState(appId, false);
  },
  setRegistryLoading: () =>
    set({ registryStatus: "loading", registryError: null }),
  setRegistryError: (message) =>
    set({ registryStatus: "error", registryError: message }),
  addAppRequest: (request) =>
    set({
      compiled: null,
      installError: null,
      request: snapshotAppInstallRequest(request),
    }),
  clearAppRequest: () => set({ request: null }),
  setUninstallRequest: (uninstallRequest) => set({ uninstallRequest }),
  setCompiled: (compiled) => set({ compiled }),
  setOperation: (operation) => {
    const wasPending = isAuthorityPendingState(get());
    set({
      operation,
      ...(operation ? { installError: null } : {}),
    });
    revokeOnAuthorityTransition(wasPending, get());
  },
  setOperationBusy: (operationBusy) => set({ operationBusy }),
  setInstallError: (installError) => set({ installError }),
  setPendingInstallRecovery: (pendingInstallRecovery) => {
    const wasPending = isAuthorityPendingState(get());
    set({ pendingInstallRecovery });
    revokeOnAuthorityTransition(wasPending, get());
  },
  setRuntimeAuthorityFence: (runtimeAuthorityFence) => {
    const wasPending = isAuthorityPendingState(get());
    set({ runtimeAuthorityFence });
    revokeOnAuthorityTransition(wasPending, get());
  },
  setInstalled: () =>
    set({
      compiled: null,
      operation: null,
      installError: null,
    }),
}));

export function isAuthorityPendingState(
  state: Pick<
    AppsState,
    "operation" | "pendingInstallRecovery" | "runtimeAuthorityFence"
  >,
): boolean {
  if (state.pendingInstallRecovery || state.runtimeAuthorityFence) return true;
  return Boolean(
    state.operation &&
      (state.operation.phase === "activating" ||
        state.operation.phase === "cleaning" ||
        state.operation.phase === "complete"),
  );
}

function revokeOnAuthorityTransition(
  wasPending: boolean,
  state: AppsState,
): void {
  if (wasPending || !isAuthorityPendingState(state)) return;
  removeAllCallRequests();
  for (const appId of Object.keys(state.list)) {
    removeAppRuntimeState(appId, false);
  }
}

async function getNeutronCan() {
  return (await import("./auth.ts")).getNeutronCan();
}

async function readKernelAssetText(path: string): Promise<string | undefined> {
  return (await import("./auth.ts")).readKernelAssetTextIfExists(path);
}

async function readKernelAssetJson<T>(path: string): Promise<T | undefined> {
  return (await import("./auth.ts")).readKernelAssetJson<T>(path);
}

async function resetNeutronCanBinding(): Promise<void> {
  try {
    (await import("./auth.ts")).resetNeutronCan();
  } catch (error) {
    console.warn("Failed to invalidate the cached Neutron actor", error);
  }
}

let callbacks: AppCallbacks | null = null;
let uninstallCallback: ((approved: boolean) => void) | null = null;
let uninstallFocusTarget: HTMLElement | null = null;
let installSequence = 0;
let registryLoadSequence = 0;

function immutableClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => immutableClone(entry))) as T;
  }
  if (value && typeof value === "object") {
    const clone = Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, immutableClone(entry)]),
    );
    return Object.freeze(clone) as T;
  }
  return value;
}

export function snapshotAppInstallRequest(
  request: AppInstallRequestInput,
): AppInstallRequest {
  const operation = request.operation ?? "install";
  if (request.capabilityPlanDiff) {
    if (operation !== "update") {
      throw new Error("Capability plan diff is valid only for an update");
    }
    if (
      request.capabilityPlanDiff.app_id !== request.id ||
      request.capabilityPlanDiff.target.plan_fingerprint !==
        request.capabilityPlanFingerprint
    ) {
      throw new Error("Capability plan diff does not match the update request");
    }
  }
  return Object.freeze({
    id: request.id,
    packageName: request.packageName,
    packageVersion: request.packageVersion,
    packageDigest: request.packageDigest,
    size: request.size,
    ...(request.acquisition ? { acquisition: request.acquisition } : {}),
    operation,
    capabilityPlanFingerprint: request.capabilityPlanFingerprint,
    ...(request.capabilityPlanDiff
      ? { capabilityPlanDiff: immutableClone(request.capabilityPlanDiff) }
      : {}),
    capabilityDisclosures: immutableClone([
      ...request.capabilityDisclosures,
    ]),
    permissions: immutableClone([...request.permissions]),
    appExplanations: immutableClone([...(request.appExplanations ?? [])]),
    ...(request.offer ? { offer: immutableClone(request.offer) } : {}),
  });
}

export function appRequest(req: AppInstallRequestInput): Promise<void> {
  callbacks?.reject(new Error("Superseded by another install request"));
  useAppsStore.getState().addAppRequest(req);
  return new Promise((resolve, reject) => {
    callbacks = { resolve, reject };
  });
}

export function appApprove(): void {
  if (!useAppsStore.getState().compiled) return;
  callbacks?.resolve();
  callbacks = null;
  useAppsStore.getState().clearAppRequest();
}

export function appReject(error = new Error("User rejected")): void {
  installSequence += 1;
  void disposeMotokoCompiler();
  callbacks?.reject(error);
  callbacks = null;
  useAppsStore.getState().setCompiled(null);
  useAppsStore.getState().clearAppRequest();
}

export function clearInstallError(): void {
  useAppsStore.getState().setInstallError(null);
}

export function requestAppUninstall(
  request: AppUninstallRequest,
): Promise<boolean> {
  if (request.appId === "kernel") {
    throw new Error("The kernel app cannot be uninstalled");
  }
  const apps = useAppsStore.getState().list;
  if (apps[request.appId]) {
    const impact = appDependencyImpact(
      planAppRegistryDependencies(apps),
      request.appId,
    );
    if (impact.direct.length > 0) {
      const names = [
        ...new Set(impact.direct.map(({ consumer }) => consumer)),
      ].map((consumer) => apps[consumer]?.name ?? consumer);
      throw new Error(
        `${request.appName} cannot be uninstalled; required by ${names.join(", ")}`,
      );
    }
  }
  uninstallCallback?.(false);
  uninstallFocusTarget =
    typeof document !== "undefined" &&
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  useAppsStore.getState().setUninstallRequest({
    ...request,
    memoryIds: [...request.memoryIds],
  });
  return new Promise((resolve) => {
    uninstallCallback = resolve;
  });
}

export function resolveAppUninstall(approved: boolean): void {
  const callback = uninstallCallback;
  const focusTarget = uninstallFocusTarget;
  uninstallCallback = null;
  uninstallFocusTarget = null;
  useAppsStore.getState().setUninstallRequest(null);
  callback?.(approved);
  if (!approved && focusTarget?.isConnected) {
    setTimeout(() => focusTarget.focus(), 0);
  }
}

export type AppUpdateMetadataSnapshot = Readonly<{
  apps: AppRegistry;
  provenance: InstallProvenance;
  deploymentId: string;
}>;

export async function getApps(): Promise<AppRegistry> {
  return (await loadAppRegistrySnapshot()).apps;
}

export async function getAppUpdateSnapshot(): Promise<AppUpdateMetadataSnapshot> {
  const loaded = await loadAppRegistrySnapshot();
  return Object.freeze({
    apps: loaded.apps,
    provenance: loaded.provenance,
    deploymentId: loaded.runtime.deployment_id,
  });
}

async function loadAppRegistrySnapshot(): Promise<{
  apps: AppRegistry;
  provenance: InstallProvenance;
  runtime: KernelRuntimeInfo;
}> {
  const loadId = ++registryLoadSequence;
  useAppsStore.getState().setRegistryLoading();
  try {
    const neutron = await getNeutronCan();
    const { registry, runtime, pendingRecovery, provenance } =
      await readConsistentAppRegistry(neutron);
    if (registry === undefined) throw new Error("App registry was not found");
    const apps = normalizeAppRegistry(registry);
    const appInstances = assertRegistryMatchesRuntime(apps, runtime);

    if (loadId === registryLoadSequence) {
      if (
        pendingRecovery === null &&
        useAppsStore.getState().pendingInstallRecovery !== null
      ) {
        useAppsStore.getState().setRuntimeAuthorityFence({
          deploymentId: runtime.deployment_id,
          reason: "runtime_changed",
        });
      }
      useAppsStore.getState().setPendingInstallRecovery(pendingRecovery);
      useAppsStore.getState().setApps(apps, { appInstances });
      useAppsStore.getState().setRuntimeAuthorityFence(null);
    }
    return { apps, provenance, runtime };
  } catch (error) {
    const registryError = toInstallError(error);
    if (loadId === registryLoadSequence) {
      if (error instanceof PendingInstallJournalError) {
        useAppsStore.getState().setPendingInstallRecovery({
          deploymentId: error.deploymentId,
        });
      }
      useAppsStore.getState().setRegistryError(registryError.message);
    }
    throw registryError;
  }
}

export type RuntimeAuthorityObservation =
  | { status: "current"; deploymentId: string }
  | { status: "changed"; deploymentId: string }
  | { status: "pending"; deploymentId: string };

export type RuntimeAuthorityRefreshResult =
  | RuntimeAuthorityObservation
  | { status: "initialized" };

type RuntimeAuthorityActor = Pick<
  Awaited<ReturnType<typeof getNeutronCan>>,
  "kernel_install_status" | "kernel_runtime_info"
>;

/**
 * A cheap authority observation used between full certified registry reads.
 * The journal query comes first so a pre-activation install also fences the
 * old browser runtime. A full registry/assets reconciliation is only needed
 * after this observation sees a committed actor change.
 */
export async function observeRuntimeAuthority(
  neutron: RuntimeAuthorityActor,
  currentInstances = useAppsStore.getState().appInstances,
): Promise<RuntimeAuthorityObservation> {
  const rawStatus = await neutron.kernel_install_status(null);
  if (!Array.isArray(rawStatus) || rawStatus.length > 1) {
    throw new Error("Install journal status is invalid");
  }
  const status = rawStatus[0] ?? null;
  if (status) {
    if (!isRuntimeDeploymentId(status.deployment_id)) {
      throw new Error("Install journal deployment id is invalid");
    }
    return { status: "pending", deploymentId: status.deployment_id };
  }

  const runtime = await neutron.kernel_runtime_info();
  if (!isRuntimeDeploymentId(runtime.deployment_id)) {
    throw new Error("Runtime deployment id is invalid");
  }
  const observedInstances = normalizeAppInstanceInventory(
    runtime.apps,
    runtime.deployment_id,
  );
  return {
    status: sameAppInstanceInventory(currentInstances, observedInstances)
      ? "current"
      : "changed",
    deploymentId: runtime.deployment_id,
  };
}

let runtimeAuthorityRefresh: Promise<RuntimeAuthorityRefreshResult> | null = null;

export function refreshRuntimeAuthority(): Promise<RuntimeAuthorityRefreshResult> {
  if (runtimeAuthorityRefresh) return runtimeAuthorityRefresh;
  const refresh = refreshRuntimeAuthorityInternal().finally(() => {
    if (runtimeAuthorityRefresh === refresh) runtimeAuthorityRefresh = null;
  });
  runtimeAuthorityRefresh = refresh;
  return refresh;
}

async function refreshRuntimeAuthorityInternal(): Promise<RuntimeAuthorityRefreshResult> {
  const state = useAppsStore.getState();
  if (Object.keys(state.appInstances).length === 0) {
    try {
      await getApps();
      return { status: "initialized" };
    } catch (error) {
      retainObservationFailureFence();
      throw error;
    }
  }

  let observation: RuntimeAuthorityObservation;
  try {
    observation = await observeRuntimeAuthority(await getNeutronCan());
  } catch (error) {
    retainObservationFailureFence();
    throw error;
  }
  if (observation.status === "pending") {
    useAppsStore.getState().setPendingInstallRecovery({
      deploymentId: observation.deploymentId,
    });
    return observation;
  }

  const current = useAppsStore.getState();
  const needsReconciliation =
    observation.status === "changed" ||
    current.pendingInstallRecovery !== null ||
    current.runtimeAuthorityFence !== null;
  if (!needsReconciliation) return observation;

  // Fence before any async asset read. This also prevents a stale authority
  // window while a journal that disappeared in another tab is reconciled.
  current.setRuntimeAuthorityFence({
    deploymentId: observation.deploymentId,
    reason: "runtime_changed",
  });
  // The combined app Candid changes with the committed runtime. Retire both
  // cached actors before the new registry generation can mount any frames.
  await resetNeutronCanBinding();
  await getApps();
  return observation;
}

export async function retainFrontendAuthorityAfterDeployFailure(
  neutron: RuntimeAuthorityActor,
): Promise<void> {
  if (!isAuthorityPendingState(useAppsStore.getState())) return;
  try {
    const observation = await observeRuntimeAuthority(neutron);
    if (observation.status === "pending") {
      useAppsStore.getState().setPendingInstallRecovery({
        deploymentId: observation.deploymentId,
      });
    } else if (observation.status === "changed") {
      useAppsStore.getState().setRuntimeAuthorityFence({
        deploymentId: observation.deploymentId,
        reason: "runtime_changed",
      });
    } else {
      // An activation signal may already have fenced sibling tabs. Tell them
      // immediately when the deploy path proves the old committed actor is
      // still current (for example, after a safe pre-activation abort).
      announceRuntimeAuthorityChange({
        deploymentId: observation.deploymentId,
        phase: "committed",
      });
    }
  } catch {
    retainObservationFailureFence();
  }
}

function retainObservationFailureFence(): void {
  if (useAppsStore.getState().pendingInstallRecovery) return;
  useAppsStore.getState().setRuntimeAuthorityFence({
    deploymentId: null,
    reason: "observation_failed",
  });
}

function isRuntimeDeploymentId(value: unknown): value is string {
  return (
    typeof value === "string" && /^[a-zA-Z0-9_-]{4,96}$/u.test(value)
  );
}

async function readConsistentAppRegistry(
  neutron: Awaited<ReturnType<typeof getNeutronCan>>,
): Promise<{
  registry: AppRegistry | undefined;
  runtime: KernelRuntimeInfo;
  pendingRecovery: PendingInstallRecovery | null;
  provenance: InstallProvenance;
}> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let pendingBefore: PendingInstallJournalError | null = null;
    try {
      await ensureInstallJournalSettled(neutron);
    } catch (error) {
      if (!(error instanceof PendingInstallJournalError)) throw error;
      pendingBefore = error;
    }
    const before = await neutron.kernel_runtime_info();
    if (pendingBefore?.deploymentId === before.deployment_id) {
      throw pendingBefore;
    }

    const [registry, provenance] = await Promise.all([
      readKernelAssetJson<AppRegistry>("/system/apps.json"),
      readInstallProvenance(),
    ]);
    const after = await neutron.kernel_runtime_info();
    let pendingAfter: PendingInstallJournalError | null = null;
    try {
      const trailingRecovery = await ensureInstallJournalSettled(neutron);
      if (trailingRecovery === "committed") continue;
    } catch (error) {
      if (!(error instanceof PendingInstallJournalError)) throw error;
      pendingAfter = error;
    }
    const finalRuntime = await neutron.kernel_runtime_info();
    if (
      before.deployment_id !== after.deployment_id ||
      after.deployment_id !== finalRuntime.deployment_id
    ) {
      continue;
    }
    if (pendingAfter?.deploymentId === finalRuntime.deployment_id) {
      throw pendingAfter;
    }
    return {
      registry,
      runtime: finalRuntime,
      provenance,
      pendingRecovery: pendingAfter
        ? { deploymentId: pendingAfter.deploymentId }
        : null,
    };
  }
  throw new Error(
    "Installed app state kept changing in another tab. Wait for it to finish and try again.",
  );
}

function assertRegistryMatchesRuntime(
  registry: AppRegistry,
  runtime: KernelRuntimeInfo,
): Readonly<Record<string, AppInstanceProjection>> {
  const appInstances = normalizeAppInstanceInventory(
    runtime.apps,
    runtime.deployment_id,
  );
  const registryInventory = Object.entries(registry)
    .map(([id, entry]) => ({
      id,
      version: String(entry.version),
      fingerprint: entry.capability_plan_fingerprint,
    }))
    .sort((left, right) => compareCanonicalText(left.id, right.id));
  const runtimeInventory = Object.values(appInstances)
    .map((instance) => ({
      id: instance.scope.appId,
      version: String(instance.version),
      fingerprint: instance.capabilityPlanFingerprint,
    }))
    .sort((left, right) => compareCanonicalText(left.id, right.id));
  if (JSON.stringify(registryInventory) !== JSON.stringify(runtimeInventory)) {
    throw new Error(
      "Installed app registry does not match the active runtime capability plans",
    );
  }
  return appInstances;
}

async function setCommittedAppsFromRuntime(
  neutron: Awaited<ReturnType<typeof getNeutronCan>>,
  apps: AppRegistry,
  options: { invalidateAppIds?: readonly string[] } = {},
): Promise<void> {
  // Runtime info exposes the exact running actor, which is the staged target
  // between activation and commit. Never turn that projection into browser
  // authority until the independently queried journal is absent on both sides
  // of the read.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await ensureInstallJournalSettled(neutron);
    const runtime = await neutron.kernel_runtime_info();
    const trailing = await ensureInstallJournalSettled(neutron);
    if (trailing === "committed") continue;
    const appInstances = assertRegistryMatchesRuntime(apps, runtime);
    if (useAppsStore.getState().pendingInstallRecovery !== null) {
      useAppsStore.getState().setRuntimeAuthorityFence({
        deploymentId: runtime.deployment_id,
        reason: "runtime_changed",
      });
    }
    useAppsStore.getState().setPendingInstallRecovery(null);
    useAppsStore.getState().setApps(apps, { ...options, appInstances });
    useAppsStore.getState().setRuntimeAuthorityFence(null);
    return;
  }
  throw new Error(
    "Committed app identity kept changing after installation. Reload and try again.",
  );
}

function requireInstancesForRegistry(
  registry: AppRegistry,
  instances: Readonly<Record<string, AppInstanceProjection>>,
): Readonly<Record<string, AppInstanceProjection>> {
  const appIds = Object.keys(registry).sort(compareCanonicalText);
  const instanceIds = Object.keys(instances).sort(compareCanonicalText);
  if (
    appIds.length !== instanceIds.length ||
    appIds.some((appId, index) => appId !== instanceIds[index])
  ) {
    throw new Error("Runtime app instances do not match the installed registry");
  }
  for (const appId of appIds) {
    const app = registry[appId]!;
    const instance = instances[appId]!;
    if (
      instance.scope.appId !== appId ||
      instance.version !== app.version ||
      instance.capabilityPlanFingerprint !== app.capability_plan_fingerprint ||
      instance.residentFrameSecurity !== residentFrameSecurityMode(app)
    ) {
      throw new Error(`Runtime identity for ${appId} does not match its registry`);
    }
  }
  return instances;
}

function retainMatchingAppInstances(
  registry: AppRegistry,
  current: Readonly<Record<string, AppInstanceProjection>>,
): Readonly<Record<string, AppInstanceProjection>> {
  const retained: Record<string, AppInstanceProjection> = {};
  for (const [appId, app] of Object.entries(registry)) {
    const instance = current[appId];
    if (
      instance?.version === app.version &&
      instance.capabilityPlanFingerprint === app.capability_plan_fingerprint &&
      instance.residentFrameSecurity === residentFrameSecurityMode(app)
    ) {
      retained[appId] = instance;
    }
  }
  return Object.freeze(retained);
}

export async function compile_app({
  preparedPackage,
  installId = installSequence,
  installOnly = false,
}: {
  preparedPackage: PreparedPackageInstall;
  installId?: number;
  installOnly?: boolean;
}): Promise<AppCompileResult> {
  const neutron = await getNeutronCan();
  const baseline = await readConsistentKernelPackageState(neutron);
  const kernelState = baseline.state;
  if (installId !== installSequence) {
    throw new Error("Install request cancelled");
  }
  if (
    installOnly &&
    (preparedPackage.isKernel ||
      preparedPackage.manifest.id === "kernel" ||
      Boolean(
        kernelState.apps[preparedPackage.manifest.id] ||
          kernelState.existingConfigs[preparedPackage.manifest.id],
      ))
  ) {
    throw new Error(
      "App install offers can install only a new non-Kernel application",
    );
  }
  assertTargetAppSurfaceCapacity(kernelState.apps, [
    preparedPackage.manifest,
  ]);

  const compiled = await compilePackageInstall({
    existingModules: kernelState.existingModules,
    existingConfigs: kernelState.existingConfigs,
    existingStable: kernelState.previousStable,
    connectionProviderSupport: kernelState.connectionProviderSupport,
    preparedPackage,
    deploymentNonce: createDeploymentNonce(),
    vetKeysEnvironment: runtimeCompilerEnvironment(),
  });

  if (installId === installSequence) {
    useAppsStore.getState().setCompiled({
      size: Math.ceil(compiled.wasm.length / 1024),
    });
  }
  return {
    compiled,
    state: kernelState,
    expectedDeploymentId: baseline.expectedDeploymentId,
  };
}

async function readCurrentKernelState(): Promise<{
  neutron: Awaited<ReturnType<typeof getNeutronCan>>;
  state: KernelPackageState;
  expectedDeploymentId: string;
}> {
  const neutron = await getNeutronCan();
  const { state, expectedDeploymentId } =
    await readConsistentKernelPackageState(neutron);
  return { neutron, state, expectedDeploymentId };
}

/**
 * Read package state between two observations of the running deployment. A
 * state read that overlaps another tab's self-upgrade must never be paired with
 * the newer deployment id: that mixed baseline could otherwise pass the
 * checked journal guard while compiling stale registry/assets.
 */
async function readConsistentKernelPackageState(
  neutron: Awaited<ReturnType<typeof getNeutronCan>>,
): Promise<{ state: KernelPackageState; expectedDeploymentId: string }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await ensureInstallJournalSettled(neutron);
    const before = await neutron.kernel_runtime_info();
    const state = await readCurrentKernelPackageState(neutron);
    const after = await neutron.kernel_runtime_info();
    const trailingRecovery = await ensureInstallJournalSettled(neutron);
    if (trailingRecovery === "committed") continue;
    if (before.deployment_id === after.deployment_id) {
      assertKernelPackageBaselineMatchesRuntime(state, after);
      return { state, expectedDeploymentId: after.deployment_id };
    }
  }
  throw new Error(
    "Installed app state kept changing in another tab. Wait for it to finish and try again.",
  );
}

async function ensureInstallJournalSettled(
  neutron: Awaited<ReturnType<typeof getNeutronCan>>,
): Promise<"none" | "committed"> {
  const recovery = await recoverPendingInstall(neutron);
  if (recovery.status === "pending") {
    throw new PendingInstallJournalError(recovery.deploymentId);
  }
  return recovery.status === "committed" ? "committed" : "none";
}

class PendingInstallJournalError extends Error {
  constructor(readonly deploymentId: string) {
    super(
      `Installation ${deploymentId} is still active or was interrupted in another tab. Wait for it to finish before changing installed apps.`,
    );
    this.name = "PendingInstallJournalError";
  }
}

type PendingInstallRecoveryActor = Awaited<ReturnType<typeof getNeutronCan>>;

export async function inspectPendingInstallRecovery(
  deploymentId: string,
  actor?: PendingInstallRecoveryActor,
): Promise<PendingInstallRecovery | null> {
  const neutron = actor ?? (await getNeutronCan());
  const recovery = await readPendingInstallRecovery(neutron, deploymentId);
  if (recovery === null) {
    await reconcileCompletedPendingInstall(deploymentId);
    return null;
  }
  const current = useAppsStore.getState().pendingInstallRecovery;
  if (current?.deploymentId === deploymentId) {
    useAppsStore.getState().setPendingInstallRecovery(recovery);
  }
  return recovery;
}

export async function retryPendingInstallRecovery(
  deploymentId: string,
  actor?: PendingInstallRecoveryActor,
): Promise<boolean> {
  const current = useAppsStore.getState().pendingInstallRecovery;
  if (!current || current.deploymentId !== deploymentId) return false;
  const neutron = actor ?? (await getNeutronCan());
  const result = await recoverPendingInstall(neutron);
  if (result.status === "pending") {
    const recovery = await readPendingInstallRecovery(neutron, deploymentId);
    if (recovery === null) {
      await reconcileCompletedPendingInstall(deploymentId);
      return true;
    }
    if (
      useAppsStore.getState().pendingInstallRecovery?.deploymentId ===
      deploymentId
    ) {
      useAppsStore.getState().setPendingInstallRecovery(recovery);
    }
    return false;
  }
  await reconcileCompletedPendingInstall(deploymentId);
  return true;
}

export async function releasePendingInstallReservation(
  deploymentId: string,
  reservationId: bigint,
  actor?: PendingInstallRecoveryActor,
): Promise<boolean> {
  const current = useAppsStore.getState().pendingInstallRecovery;
  if (
    current?.deploymentId !== deploymentId ||
    current.runningTarget !== true ||
    !current.blockers?.some((blocker) => blocker.id === reservationId)
  ) {
    throw new Error("The pending installation blocker changed");
  }
  const neutron = actor ?? (await getNeutronCan());
  const released = await neutron.kernel_install_pending_reservation_release({
    deployment_id: deploymentId,
    reservation_id: reservationId,
  });
  if (!released) {
    await inspectPendingInstallRecovery(deploymentId, neutron);
    throw new Error("That backend access entry is no longer available");
  }
  return retryPendingInstallRecovery(deploymentId, neutron);
}

async function readPendingInstallRecovery(
  neutron: PendingInstallRecoveryActor,
  deploymentId: string,
): Promise<PendingInstallRecovery | null> {
  const status = normalizePendingInstallStatus(
    await neutron.kernel_install_status(null),
  );
  if (status === null) return null;
  if (status.deployment_id !== deploymentId) {
    throw new Error(
      "The pending installation changed in another tab. Check its status again.",
    );
  }
  const runtime = await neutron.kernel_runtime_info();
  const runningTarget = runtime.deployment_id === deploymentId;
  return {
    deploymentId,
    runningTarget,
    blockers: runningTarget
      ? normalizePendingInstallReservationBlockers(
          await neutron.kernel_install_pending_reservation_blockers({
            deployment_id: deploymentId,
          }),
        )
      : [],
  };
}

function normalizePendingInstallStatus(
  value: [] | [InstallJournalStatus],
): InstallJournalStatus | null {
  if (!Array.isArray(value) || value.length > 1) {
    throw new Error("Install journal status is invalid");
  }
  return value[0] ?? null;
}

export function normalizePendingInstallReservationBlockers(
  value: unknown,
): PendingInstallReservationBlocker[] {
  if (!Array.isArray(value) || value.length > 1) {
    throw new Error("Pending install blocker response is invalid");
  }
  return value
    .map((candidate) => {
      const blocker = recoveryRecord(
        candidate,
        "pending install blocker",
        ["reason", "reservation"],
      );
      const record = recoveryRecord(
        blocker.reservation,
        "pending reservation",
        [
          "app_id",
          "created_at",
          "created_by",
          "id",
          "installation_uid",
          "method",
          "principal",
          "scope_kind",
        ],
      );
      const id = recoveryNat(record.id, "reservation id");
      const appId = recoveryText(record.app_id, "reservation app");
      const installationUid = recoveryNat(
        record.installation_uid,
        "reservation installation",
      );
      if (installationUid === 0n) {
        throw new Error("Backend reservation claim was exposed");
      }
      const kind = recoveryText(record.scope_kind, "reservation scope");
      const principal = recoveryOptionalText(
        record.principal,
        "reservation principal",
      );
      const method = recoveryOptionalText(
        record.method,
        "reservation method",
      );
      const scope =
        kind === "exact" && principal !== null && method !== null
          ? `${principal} · ${method}`
          : kind === "principal" && principal !== null && method === null
            ? `Canister ${principal}`
            : kind === "method" && principal === null && method !== null
              ? `Method ${method}`
              : null;
      if (scope === null) {
        throw new Error("Backend reservation scope is invalid");
      }
      recoveryNat(record.created_at, "reservation creation time");
      recoveryPrincipalText(record.created_by, "reservation creator");
      return {
        id,
        appId,
        installationUid,
        scope,
        reason: recoveryBlockerReason(blocker.reason),
      };
    })
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
}

function recoveryRecord(
  value: unknown,
  label: string,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(`Invalid ${label}`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareCanonicalText);
  const expected = [...expectedKeys].sort(compareCanonicalText);
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return record;
}

function recoveryBlockerReason(
  value: unknown,
): PendingInstallReservationBlockerReason {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error("Invalid pending blocker reason");
  }
  const entries = Object.entries(value);
  if (entries.length !== 1 || entries[0]?.[1] !== null) {
    throw new Error("Invalid pending blocker reason");
  }
  const key = entries[0][0];
  if (
    key !== "scope_conflict" &&
    key !== "app_capacity" &&
    key !== "global_capacity"
  ) {
    throw new Error("Invalid pending blocker reason");
  }
  return key;
}

function recoveryNat(value: unknown, label: string): bigint {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return BigInt(value);
  }
  throw new Error(`Invalid ${label}`);
}

function recoveryText(value: unknown, label: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`Invalid ${label}`);
}

function recoveryPrincipalText(value: unknown, label: string): string {
  if (
    value !== null &&
    typeof value === "object" &&
    "toText" in value &&
    typeof value.toText === "function"
  ) {
    const text = value.toText.call(value);
    if (typeof text === "string" && text.length > 0) return text;
  }
  throw new Error(`Invalid ${label}`);
}

function recoveryOptionalText(value: unknown, label: string): string | null {
  if (!Array.isArray(value) || value.length > 1) {
    throw new Error(`Invalid ${label}`);
  }
  if (value.length === 0) return null;
  const item = value[0];
  if (typeof item === "string" && item.length > 0) return item;
  if (
    item !== null &&
    typeof item === "object" &&
    "toText" in item &&
    typeof item.toText === "function"
  ) {
    return item.toText.call(item);
  }
  throw new Error(`Invalid ${label}`);
}

async function reconcileCompletedPendingInstall(
  deploymentId: string,
): Promise<void> {
  useAppsStore.getState().setRuntimeAuthorityFence({
    deploymentId,
    reason: "runtime_changed",
  });
  useAppsStore.getState().setPendingInstallRecovery(null);
  announceRuntimeAuthorityChange({
    deploymentId,
    phase: "committed",
  });
  await resetNeutronCanBinding();
  await getApps();
}

export async function abortPendingInstallRecovery(
  deploymentId: string,
  actor?: PendingInstallRecoveryActor,
): Promise<void> {
  const pending = useAppsStore.getState().pendingInstallRecovery;
  if (!pending || pending.deploymentId !== deploymentId) return;
  if (pending.runningTarget !== false) {
    throw new Error(
      "The running installation cannot be discarded. Resolve its blocker and retry.",
    );
  }
  const neutron = actor ?? (await getNeutronCan());
  const status = normalizePendingInstallStatus(
    await neutron.kernel_install_status(null),
  );
  if (status && status.deployment_id !== deploymentId) {
    throw new Error(
      "The pending installation changed in another tab. Check its status again.",
    );
  }
  if (status) {
    await neutron.kernel_install_abort({ deployment_id: deploymentId });
  }
  useAppsStore.getState().setRuntimeAuthorityFence({
    deploymentId,
    reason: "runtime_changed",
  });
  useAppsStore.getState().setPendingInstallRecovery(null);
  await getApps();
}

async function readCurrentKernelPackageState(
  neutron: Awaited<ReturnType<typeof getNeutronCan>>,
): Promise<KernelPackageState> {
  return readKernelPackageState({
    listStatic: (prefix) => neutron.kernel_static_query({ list: { prefix } }),
    fetchText: async (path) => {
      const value = await readKernelAssetText(path);
      if (value === undefined) throw new Error(`Kernel asset ${path} was not found`);
      return value;
    },
    fetchJson: async (path, fallback) => {
      const value = await readKernelAssetJson<typeof fallback>(path);
      return value === undefined ? fallback : value;
    },
  });
}

async function readInstallProvenance(): Promise<InstallProvenance> {
  return installProvenanceOrEmpty(
    await readKernelAssetJson<unknown>(INSTALL_PROVENANCE_PATH),
  );
}

async function removeInstallProvenanceAssets(
  appId: string,
): Promise<InstallStagedAsset[]> {
  const value = await readKernelAssetJson<unknown>(INSTALL_PROVENANCE_PATH);
  if (value === undefined) return [];
  let current: InstallProvenance;
  try {
    current = installProvenanceOrEmpty(value);
  } catch {
    // A corrupt optional record must not take away any manual operation. It
    // contains no valid source claim that can be attributed to this app.
    console.warn(
      "Ignoring an invalid install provenance record during a manual app operation",
    );
    return [];
  }
  if (!current.apps[appId]) return [];
  return [
    {
      target: INSTALL_PROVENANCE_PATH,
      content: serializeInstallProvenance(
        withoutInstallProvenance(current, [appId]),
      ),
      contentType: "application/json",
    },
  ];
}

async function manualInstallProvenanceAssets(
  appId: string,
  acquisition: "file" | "url",
  packageDigest: string,
): Promise<InstallStagedAsset[]> {
  const value = await readKernelAssetJson<unknown>(INSTALL_PROVENANCE_PATH);
  let current: InstallProvenance;
  try {
    current = installProvenanceOrEmpty(value);
  } catch {
    console.warn(
      "Replacing an invalid install provenance record during a manual app install",
    );
    current = installProvenanceOrEmpty(undefined);
  }
  const next = withInstallProvenance(current, {
    [appId]: {
      kind: "manual",
      acquisition,
      package_digest: packageDigest,
    },
  });
  return [
    {
      target: INSTALL_PROVENANCE_PATH,
      content: serializeInstallProvenance(next),
      contentType: "application/json",
    },
  ];
}

/**
 * Acquire the same compiler/deployment mutex used by manual app operations and
 * keep an authenticated baseline alive across repository review. The returned
 * session is deliberately single-owner; callers must cancel it when the setup
 * is dismissed.
 */
export async function beginRepositoryInstallSession(): Promise<RepositoryInstallSession> {
  return beginPackageInstallSession({ mode: "setup" });
}

export async function beginPackageInstallSession({
  mode,
}: {
  mode: "setup" | "update";
}): Promise<PackageUpdateSession> {
  beginOperation();
  try {
    const neutron = await getNeutronCan();
    const { state, runtime, provenance } =
      await readConsistentRepositoryPackageState(neutron);
    const baselineFingerprint = packageBaselineFingerprint({
      state,
      runtime,
      provenance,
    });
    const reconciliationState = Object.freeze({
      ...state,
      // Repository reconciliation must see the registry exactly as it was
      // stored. `state.apps` remains enriched for compiler/deploy callers.
      apps: state.registry,
    });
    let finished = false;
    let inFlight = false;
    let cancelRequested = false;
    let compiledAttempt: Readonly<{
      compiled: CompileResult;
      packageFingerprint: string;
    }> | null = null;

    const finish = (): void => {
      if (finished) return;
      finished = true;
      endOperation();
    };
    const assertActive = (): void => {
      if (finished || cancelRequested) {
        throw new Error("Repository setup was cancelled");
      }
    };
    const beginCall = (): void => {
      assertActive();
      if (inFlight) {
        throw new Error("A repository compiler operation is already in progress");
      }
      inFlight = true;
    };
    const endCall = (): void => {
      inFlight = false;
      if (cancelRequested) finish();
    };

    return {
      baseline: Object.freeze({ state: reconciliationState, runtime }),
      async compile(packages) {
        beginCall();
        try {
          assertPackageSessionTargets(mode, state, packages);
          assertTargetAppSurfaceCapacity(
            state.apps,
            packages.map(({ manifest }) => manifest),
          );
          const compiled = await compilePackages({
            packages: [...packages],
            existingModules: state.existingModules,
            existingConfigs: state.existingConfigs,
            existingStable: state.previousStable,
            connectionProviderSupport: state.connectionProviderSupport,
            deploymentNonce: createDeploymentNonce(),
            vetKeysEnvironment: runtimeCompilerEnvironment(),
          });
          assertActive();
          compiledAttempt = Object.freeze({
            compiled,
            packageFingerprint: preparedPackageBatchFingerprint(packages),
          });
          return compiled;
        } catch (error) {
          compiledAttempt = null;
          throw error;
        } finally {
          endCall();
        }
      },
      async deploy({ packages, compiled, provenance: provenanceEntries }) {
        beginCall();
        const appIds = packages.map(({ manifest }) => manifest.id);
        useAppsStore.getState().setOperation({
          kind: mode === "update" ? "update" : "install",
          ...(appIds.length === 1 ? { appId: appIds[0] } : {}),
          phase: "staging",
        });
        useAppsStore.getState().setInstallError(null);
        try {
          if (
            compiledAttempt?.compiled !== compiled ||
            compiledAttempt.packageFingerprint !==
              preparedPackageBatchFingerprint(packages)
          ) {
            throw new Error(
              "Package batch changed after compilation. Compile this exact batch again.",
            );
          }
          assertPackageProvenanceCoverage(packages, provenanceEntries);
          const {
            state: currentState,
            runtime: currentRuntime,
            provenance: currentProvenance,
          } = await readConsistentRepositoryPackageState(neutron);
          // Owner changes and logout can cancel while the authenticated
          // baseline is being re-read. Stop before the first staging write.
          assertActive();
          const currentFingerprint = packageBaselineFingerprint({
            state: currentState,
            runtime: currentRuntime,
            provenance: currentProvenance,
          });
          if (currentFingerprint !== baselineFingerprint) {
            throw new Error(
              "Installed app state changed in another tab. Reload this setup before installing.",
            );
          }
          assertPackageSessionTargets(mode, currentState, packages);
          assertActive();
          if (appIds.includes("kernel")) {
            disableAgentMode("Kernel update started");
          }

          const nextProvenance = withInstallProvenance(
            provenance,
            provenanceEntries,
          );
          const { apps } = await deployPreparedPackages({
            actor: neutron,
            targetCanisterId: getRuntimeDeployment().canisterId,
            packages: [...packages],
            compiled,
            existingApps: state.apps,
            previousModulePaths: state.existingModules.map(({ path }) => path),
            expectedDeploymentId: runtime.deployment_id,
            stagedAssets: [
              {
                target: INSTALL_PROVENANCE_PATH,
                content: serializeInstallProvenance(nextProvenance),
                contentType: "application/json",
              },
            ],
            onStep(step) {
              setDeployOperation(
                mode === "update" ? "update" : "install",
                appIds.length === 1 ? appIds[0] : undefined,
                step,
              );
              announceActivationStep(
                step,
                compiled.deploymentId,
                appIds.includes("kernel"),
              );
            },
          });

          announceRuntimeAuthorityChange({
            deploymentId: compiled.deploymentId,
            phase: "committed",
            kernelUpdated: appIds.includes("kernel"),
          });
          await setCommittedAppsFromRuntime(
            neutron,
            apps,
            mode === "update" ? { invalidateAppIds: appIds } : {},
          );
          if (mode === "update") {
            for (const appId of appIds) {
              if (appId !== "kernel") removeAppRuntimeState(appId, false);
            }
          }
          await resetNeutronCanBinding();
          await delay(500);
          useAppsStore.getState().setInstalled();
          return apps;
        } catch (error) {
          await retainFrontendAuthorityAfterDeployFailure(neutron);
          if (cancelRequested) {
            useAppsStore.getState().setOperation(null);
            throw error;
          }
          const installError = toInstallError(error);
          useAppsStore.getState().setOperation(null);
          useAppsStore.getState().setInstallError({
            kind: mode === "update" ? "update" : "install",
            message: installError.message,
          });
          throw installError;
        } finally {
          endCall();
          finish();
        }
      },
      cancel() {
        cancelRequested = true;
        void disposeMotokoCompiler();
        if (!inFlight) finish();
      },
    };
  } catch (error) {
    endOperation();
    throw error;
  }
}

function assertPackageSessionTargets(
  mode: "setup" | "update",
  state: Pick<KernelPackageState, "apps" | "existingConfigs">,
  packages: readonly PreparedPackageInstall[],
): void {
  const seen = new Set<string>();
  for (const { manifest } of packages) {
    if (seen.has(manifest.id)) {
      throw new Error(`Package batch duplicates ${manifest.id}`);
    }
    seen.add(manifest.id);
    const installed = Boolean(
      state.apps[manifest.id] || state.existingConfigs[manifest.id],
    );
    if (mode === "setup" && installed) {
      throw new Error(
        `${manifest.id} is already installed. Reload this setup before installing.`,
      );
    }
    if (mode === "update" && !installed) {
      throw new Error(
        `${manifest.id} is no longer installed. Check for updates again.`,
      );
    }
  }
}

function preparedPackageBatchFingerprint(
  packages: readonly PreparedPackageInstall[],
): string {
  return JSON.stringify(
    [...packages]
      .sort((left, right) =>
        compareCanonicalText(left.manifest.id, right.manifest.id),
      )
      .map((prepared) => ({
        appId: prepared.manifest.id,
        appPrefix: prepared.appPrefix,
        capabilityPlanFingerprint: prepared.capabilityPlanFingerprint,
        files: [...prepared.files]
          .sort((left, right) => compareCanonicalText(left.path, right.path))
          .map(({ path, content }) => ({
            path,
            digest: hashContent(content),
            size: content.byteLength,
          })),
        isKernel: prepared.isKernel,
        manifest: prepared.manifest,
      })),
  );
}

function assertPackageProvenanceCoverage(
  packages: readonly PreparedPackageInstall[],
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
}

async function readConsistentRepositoryPackageState(
  neutron: Awaited<ReturnType<typeof getNeutronCan>>,
): Promise<{
  state: KernelPackageState;
  runtime: KernelRuntimeInfo;
  provenance: InstallProvenance;
}> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await ensureInstallJournalSettled(neutron);
    const before = await neutron.kernel_runtime_info();
    const [state, provenance] = await Promise.all([
      readCurrentKernelPackageState(neutron),
      readInstallProvenance(),
    ]);
    const after = await neutron.kernel_runtime_info();
    const trailingRecovery = await ensureInstallJournalSettled(neutron);
    if (trailingRecovery === "committed") continue;
    if (before.deployment_id === after.deployment_id) {
      assertKernelPackageBaselineMatchesRuntime(state, after);
      return { state, runtime: after, provenance };
    }
  }
  throw new Error(
    "Installed app state kept changing in another tab. Wait for it to finish and reload this setup.",
  );
}

function packageBaselineFingerprint({
  state,
  runtime,
  provenance,
}: {
  state: KernelPackageState;
  runtime: KernelRuntimeInfo;
  provenance: InstallProvenance;
}): string {
  return hashContent(
    JSON.stringify(
      canonicalValue({
        registry: state.registry,
        configs: state.existingConfigs,
        modules: state.existingModules
          .map(({ path, content }) => ({ path, content }))
          .sort((left, right) =>
            compareCanonicalText(left.path, right.path),
          ),
        previousStable: state.previousStable,
        provenance,
        runtime: {
          deploymentId: runtime.deployment_id,
          apps: runtime.apps
            .map(({ scope, version, capability_plan_fingerprint }) => ({
              id: scope.app_id,
              installationUid: String(scope.installation_uid),
              version: String(version),
              capabilityPlanFingerprint: capability_plan_fingerprint,
            }))
            .sort((left, right) => compareCanonicalText(left.id, right.id)),
        },
      }),
    ),
  );
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareCanonicalText(left, right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return typeof value === "bigint" ? String(value) : value;
}

export async function uninstall_app(appId: string): Promise<AppInstallResult> {
  if (appId === "kernel") {
    throw new Error("The kernel app cannot be uninstalled");
  }
  beginOperation();
  try {
    return await uninstallAppInternal(appId);
  } finally {
    endOperation();
  }
}

async function uninstallAppInternal(appId: string): Promise<AppInstallResult> {
  useAppsStore.getState().setOperation({
    kind: "uninstall",
    appId,
    phase: "preparing",
  });
  useAppsStore.getState().setInstallError(null);
  try {
    const { neutron, state, expectedDeploymentId } =
      await readCurrentKernelState();
    const provenanceAssets = await removeInstallProvenanceAssets(appId);
    const compiled = await compileAppUninstall({
      state,
      appId,
      deploymentNonce: createDeploymentNonce(),
      vetKeysEnvironment: runtimeCompilerEnvironment(),
    });
    const result = await deployPreparedPackages({
      actor: neutron,
      targetCanisterId: getRuntimeDeployment().canisterId,
      packages: [],
      compiled,
      existingApps: state.apps,
      previousModulePaths: state.existingModules.map(({ path }) => path),
      removedApps: [appId],
      ...(provenanceAssets.length > 0
        ? { stagedAssets: provenanceAssets }
        : {}),
      expectedDeploymentId,
      onStep(step) {
        setDeployOperation("uninstall", appId, step);
        announceActivationStep(step, compiled.deploymentId, false);
      },
    });
    announceRuntimeAuthorityChange({
      deploymentId: result.compiled.deploymentId,
      phase: "committed",
    });
    await setCommittedAppsFromRuntime(neutron, result.apps);
    removeAppRuntimeState(appId, true);
    await resetNeutronCanBinding();
    await delay(300);
    useAppsStore.getState().setInstalled();
    return { appId, apps: result.apps };
  } catch (error) {
    const neutron = await getNeutronCan().catch(() => null);
    if (neutron) await retainFrontendAuthorityAfterDeployFailure(neutron);
    else if (isAuthorityPendingState(useAppsStore.getState())) {
      retainObservationFailureFence();
    }
    const installError = toInstallError(error);
    useAppsStore.getState().setOperation(null);
    useAppsStore.getState().setInstallError({
      kind: "uninstall",
      message: installError.message,
    });
    throw installError;
  }
}

export async function install_app(
  source: AppInstallSource = { kind: "file" },
  options: AppInstallOptions = {},
): Promise<AppInstallResult | null> {
  beginOperation();
  try {
    return await installAppInternal(source, options);
  } catch (error) {
    if (options.offer && !useAppsStore.getState().installError) {
      const installError = toInstallError(error);
      useAppsStore.getState().setInstallError({
        kind: "install",
        message: installError.message,
      });
    }
    throw error;
  } finally {
    endOperation();
  }
}

async function installAppInternal(
  source: AppInstallSource,
  options: AppInstallOptions,
): Promise<AppInstallResult | null> {
  const installId = ++installSequence;
  useAppsStore.getState().setCompiled(null);
  useAppsStore.getState().setInstallError(null);
  const neutron = await getNeutronCan();

  const pkg =
    source.kind === "file"
      ? new Uint8Array(await readFile(await pickFile()))
      : await fetchPackageFromUrl(source.url, {
          ...(source.signal ? { signal: source.signal } : {}),
        });
  const { neutronConfig, preparedPackage } = await get_app_details(
    neutron,
    pkg,
    source.kind === "url"
      ? { limits: REMOTE_NEUTRON_PACKAGE_DECODE_LIMITS }
      : {},
  );

  const size = Math.ceil(pkg.length / 1024);
  const {
    capabilityDisclosures,
    permissions,
    appExplanations,
    planFingerprint,
  } =
    configInstallDisclosures(neutronConfig);
  if (planFingerprint !== preparedPackage.capabilityPlanFingerprint) {
    throw new Error("Prepared package capability plan mismatch");
  }
  const id = neutronConfig.id;
  const installedApp = useAppsStore.getState().list[id];
  if (
    options.installOnly &&
    (id === "kernel" || preparedPackage.isKernel || Boolean(installedApp))
  ) {
    throw new Error(
      "App install offers can install only a new non-Kernel application",
    );
  }
  const decisionOperation = installedApp ? "update" : "install";
  const capabilityPlanDiff = installedApp
    ? diffCapabilityPlans(
        installedApp.capability_plan,
        preparedPackage.capabilityPlan,
      )
    : undefined;
  if (
    installedApp &&
    capabilityPlanDiff?.previous.plan_fingerprint !==
      installedApp.capability_plan_fingerprint
  ) {
    throw new Error("Installed capability plan fingerprint mismatch");
  }
  const packageDigest = hashContent(pkg);
  const compilePromise = compile_app({
    preparedPackage,
    installId,
    ...(options.installOnly ? { installOnly: true } : {}),
  });

  let compileDetails: AppCompileResult;
  try {
    [compileDetails] = await Promise.all([
      compilePromise,
      appRequest({
        id,
        packageName: neutronConfig.name,
        packageVersion: neutronConfig.version,
        packageDigest,
        size,
        acquisition: source.kind,
        operation: decisionOperation,
        capabilityPlanFingerprint: planFingerprint,
        ...(capabilityPlanDiff ? { capabilityPlanDiff } : {}),
        capabilityDisclosures,
        permissions,
        appExplanations,
        ...(options.offer ? { offer: options.offer } : {}),
      }),
    ]);
  } catch (error) {
    if (installId === installSequence) {
      const installError = toInstallError(error);
      appReject(installError);
      useAppsStore
        .getState()
        .setInstallError({ kind: "install", message: installError.message });
    }
    throw error;
  }
  if (installId !== installSequence)
    throw new Error("Install request cancelled");
  useAppsStore.getState().setOperation({
    kind: "install",
    appId: id,
    phase: "staging",
  });
  if (id === "kernel") disableAgentMode("Kernel update started");

  try {
    const provenanceAssets = await manualInstallProvenanceAssets(
      id,
      source.kind,
      packageDigest,
    );
    const { apps: appconfig } = await deployPreparedPackages({
      actor: neutron,
      targetCanisterId: getRuntimeDeployment().canisterId,
      packages: [preparedPackage],
      compiled: compileDetails.compiled,
      existingApps: compileDetails.state.apps,
      previousModulePaths: compileDetails.state.existingModules.map(
        ({ path }) => path,
      ),
      expectedDeploymentId: compileDetails.expectedDeploymentId,
      ...(provenanceAssets.length > 0
        ? { stagedAssets: provenanceAssets }
        : {}),
      onStep(step) {
        setDeployOperation("install", id, step);
        announceActivationStep(
          step,
          compileDetails.compiled.deploymentId,
          id === "kernel",
        );
      },
    });

    announceRuntimeAuthorityChange({
      deploymentId: compileDetails.compiled.deploymentId,
      phase: "committed",
      kernelUpdated: id === "kernel",
    });
    await setCommittedAppsFromRuntime(neutron, appconfig, {
      invalidateAppIds: decisionOperation === "update" ? [id] : [],
    });
    if (decisionOperation === "update" && id !== "kernel") {
      removeAppRuntimeState(id, false);
    }
    await resetNeutronCanBinding();
    await delay(500);
    useAppsStore.getState().setInstalled();
    return { appId: id, apps: appconfig };
  } catch (error) {
    if (installId === installSequence) {
      await retainFrontendAuthorityAfterDeployFailure(neutron);
      const installError = toInstallError(error);
      useAppsStore.getState().setOperation(null);
      useAppsStore
        .getState()
        .setInstallError({ kind: "install", message: installError.message });
    }
    throw error;
  }
}

function removeAppRuntimeState(appId: string, removeTiles: boolean): void {
  clearInstallOfferForApp(appId);
  removeFrontendAppState(appId);
  removeCallRequestsForApp(appId);
  removeBackendCallRequestsForApp(appId);
  removeAgentAppState(appId);
  removeUiAttentionAppState(appId);
  removeTrayAppState(appId);
  removeConnectionRequestsForApp(appId);
  if (removeTiles) useWorkspaceStore.getState().removeAppTiles(appId);
}

function registryEntriesEqual(
  left: AppRegistry[string] | undefined,
  right: AppRegistry[string] | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

function beginOperation(): void {
  const state = useAppsStore.getState();
  if (state.operationBusy) {
    throw new Error("Another app operation is already in progress");
  }
  if (state.pendingInstallRecovery || state.runtimeAuthorityFence) {
    throw new Error(
      "Finish or discard the pending installation before changing installed apps",
    );
  }
  state.setOperationBusy(true);
}

function endOperation(): void {
  useAppsStore.getState().setOperationBusy(false);
}

function setDeployOperation(
  kind: AppOperationKind,
  appId: string | undefined,
  step: DeployPackageStep,
): void {
  const phase: AppOperationPhase =
    step === "record-journal" ||
    step === "install-code" ||
    step === "verify-runtime"
      ? "activating"
      : step === "commit-assets"
        ? "cleaning"
        : step === "complete"
          ? "complete"
          : step === "abort"
            ? "cleaning"
            : "staging";
  useAppsStore.getState().setOperation({
    kind,
    ...(appId ? { appId } : {}),
    phase,
  });
}

function announceActivationStep(
  step: DeployPackageStep,
  deploymentId: string,
  kernelUpdated: boolean,
): void {
  // `install-code` is emitted only after the checked journal begin returns,
  // so sibling tabs fence immediately without trusting a merely attempted
  // journal write.
  if (step !== "install-code") return;
  announceRuntimeAuthorityChange({
    deploymentId,
    phase: "pending",
    kernelUpdated,
  });
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function toInstallError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
