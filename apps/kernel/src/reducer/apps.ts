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
  BROWSER_SURFACE_ORIGINS_PATH,
  compileAppUninstall,
  compilePackages,
  compilePackageInstall,
  createDeploymentNonce,
  deployPreparedPackages,
  normalizeAppRegistry,
  parseBrowserSurfaceOriginsSidecar,
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
import { persistenceModeFromCompilerId } from "neutron-compiler/src/compile.js";
import {
  BROWSER_SURFACE_ORIGIN_ASSEMBLER_ID,
  LEGACY_V25_ASSEMBLER_ID,
  normalizeBrowserSurfaceOriginAppIds,
} from "neutron-compiler/src/assemble.js";
import {
  parseDeploymentBuildRecord,
  type CompleteDeploymentBuildRecord,
} from "neutron-compiler/src/deployment_record.js";
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
import {
  prepareBrowserDeployment,
  type PreparedBrowserDeployment,
} from "../install_review/prepare_browser_deployment.ts";
import {
  createDeploymentBuildReviewModel,
  type DeploymentBuildReviewInput,
} from "../install_review/deployment_build_review.ts";
import { assertPackageProvenanceCoverage } from "../install_review/provenance_binding.ts";

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

export type AppCompiled = {
  size: number;
  /** Present on every production compile path; optional only for old view tests. */
  deploymentReview?: DeploymentBuildReviewInput;
};

type AppCompileResult = {
  baselineFingerprint: string;
  compiled: CompileResult;
  deployment: PreparedBrowserDeployment;
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
  deploymentReview: DeploymentBuildReviewInput;
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
  getPreparedDeployment(
    packages: readonly PreparedPackageInstall[],
    compiled: CompileResult,
  ): PreparedBrowserDeployment;
  deploy(input: {
    packages: readonly PreparedPackageInstall[];
    compiled: CompileResult;
    deploymentBuildRecord: CompleteDeploymentBuildRecord;
    provenance: Readonly<Record<string, RepositoryInstallProvenance>>;
  }): Promise<AppRegistry>;
  cancel(): void;
};

export type PackageUpdateSession = {
  readonly baseline: RepositoryInstallBaseline;
  compile(packages: readonly PreparedPackageInstall[]): Promise<CompileResult>;
  getPreparedDeployment(
    packages: readonly PreparedPackageInstall[],
    compiled: CompileResult,
  ): PreparedBrowserDeployment;
  deploy(input: {
    packages: readonly PreparedPackageInstall[];
    compiled: CompileResult;
    deploymentBuildRecord: CompleteDeploymentBuildRecord;
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
  runtimeAssemblerId: string | null;
  runtimeCapabilityAuthorityRevision: string | null;
  authorityRevision: number;
  browserSurfaceOriginAppIds: readonly string[];
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
      runtimeAssemblerId?: string;
      runtimeCapabilityAuthorityRevision?: string | null;
      browserSurfaceOriginAppIds?: readonly string[];
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
  runtimeAssemblerId: null,
  runtimeCapabilityAuthorityRevision: null,
  authorityRevision: 0,
  browserSurfaceOriginAppIds: Object.freeze([]),
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
      const candidateInstances = suppliedInstances
        ? requireInstancesForRegistry(normalized, suppliedInstances)
        : retainMatchingAppInstances(normalized, state.appInstances);
      const stableApps = retainRegistryIdentity(normalized, state.list);
      const appInstances = retainAppInstanceInventoryIdentity(
        candidateInstances,
        state.appInstances,
      );
      const candidateBrowserSurfaceOriginAppIds =
        canonicalBrowserSurfaceOriginAppIds(
        options.browserSurfaceOriginAppIds ??
          state.browserSurfaceOriginAppIds.filter(
            (appId) => stableApps[appId],
          ),
        stableApps,
      );
      const browserSurfaceOriginAppIds =
        JSON.stringify(candidateBrowserSurfaceOriginAppIds) ===
        JSON.stringify(state.browserSurfaceOriginAppIds)
          ? state.browserSurfaceOriginAppIds
          : candidateBrowserSurfaceOriginAppIds;
      const runtimeCapabilityAuthorityRevision = Object.hasOwn(
        options,
        "runtimeCapabilityAuthorityRevision",
      )
        ? (options.runtimeCapabilityAuthorityRevision ?? null)
        : state.runtimeCapabilityAuthorityRevision;
      const runtimeCapabilityAuthorityChanged =
        runtimeCapabilityAuthorityRevision !==
        state.runtimeCapabilityAuthorityRevision;
      const previousBrowserSurfaceOrigins = new Set(
        state.browserSurfaceOriginAppIds,
      );
      const nextBrowserSurfaceOrigins = new Set(
        browserSurfaceOriginAppIds,
      );
      reconcileAgentGrant(stableApps, appInstances);
      const runtimeGenerations = { ...state.runtimeGenerations };
      let runtimeGenerationChanged = false;
      const appIds = new Set([
        ...Object.keys(state.list),
        ...Object.keys(stableApps),
        ...forced,
      ]);
      for (const appId of appIds) {
        if (
          runtimeCapabilityAuthorityChanged ||
          forced.has(appId) ||
          previousBrowserSurfaceOrigins.has(appId) !==
            nextBrowserSurfaceOrigins.has(appId) ||
          !registryEntriesEqual(state.list[appId], stableApps[appId]) ||
          !sameAppInstance(
            state.appInstances[appId],
            appInstances[appId],
          )
        ) {
          runtimeGenerations[appId] =
            (state.runtimeGenerations[appId] ?? 0) + 1;
          runtimeGenerationChanged = true;
          if (state.list[appId] || state.appInstances[appId]) {
            revokedAppIds.add(appId);
          }
        }
      }
      return {
        list: stableApps,
        appInstances,
        runtimeGenerations: runtimeGenerationChanged
          ? runtimeGenerations
          : state.runtimeGenerations,
        runtimeAssemblerId:
          options.runtimeAssemblerId ?? state.runtimeAssemblerId,
        runtimeCapabilityAuthorityRevision,
        authorityRevision:
          runtimeGenerationChanged ||
          runtimeCapabilityAuthorityRevision !==
            state.runtimeCapabilityAuthorityRevision
            ? state.authorityRevision + 1
            : state.authorityRevision,
        browserSurfaceOriginAppIds,
        registryStatus: "ready",
        registryError: null,
        registryUpdatedAt: Date.now(),
      };
    });
    for (const appId of revokedAppIds) removeAppRuntimeState(appId, false);
  },
  setRegistryLoading: () =>
    set({ registryStatus: "loading", registryError: null }),
  setRegistryError: (message) => {
    const wasPending = isAuthorityPendingState(get());
    set((state) => ({
      registryStatus: "error",
      registryError: message,
      authorityRevision: state.authorityRevision + 1,
      runtimeAuthorityFence:
        state.pendingInstallRecovery || state.runtimeAuthorityFence
          ? state.runtimeAuthorityFence
          : { deploymentId: null, reason: "observation_failed" },
    }));
    revokeOnAuthorityTransition(wasPending, get());
  },
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
    set((state) => ({
      pendingInstallRecovery,
      authorityRevision: state.authorityRevision + 1,
    }));
    revokeOnAuthorityTransition(wasPending, get());
  },
  setRuntimeAuthorityFence: (runtimeAuthorityFence) => {
    const wasPending = isAuthorityPendingState(get());
    set((state) => ({
      runtimeAuthorityFence,
      authorityRevision: state.authorityRevision + 1,
    }));
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
  const state = useAppsStore.getState();
  if (!state.compiled?.deploymentReview) return;
  callbacks?.resolve();
  callbacks = null;
  // The exact reviewed record and package bytes remain in the awaiting install
  // stack; retire the UI copy as soon as the final action is taken.
  state.setCompiled(null);
  state.clearAppRequest();
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
  if (request.deploymentReview.suppliedPackages.length !== 0) {
    throw new Error("App uninstall review cannot contain supplied packages");
  }
  const deploymentRecord = parseDeploymentBuildRecord(
    request.deploymentReview.record,
  );
  if (deploymentRecord.state !== "complete") {
    throw new Error("App uninstall requires a complete deployment build record");
  }
  if (
    deploymentRecord.warnings.removed_apps.length !== 1 ||
    deploymentRecord.warnings.removed_apps[0] !== request.appId
  ) {
    throw new Error(
      "App uninstall request does not match the build record removal plan",
    );
  }
  const recordedMemoryIds = deploymentRecord.warnings.destructive_memory_roots
    .filter(({ owner }) => owner === request.appId)
    .map(({ memory_id }) => memory_id)
    .sort(compareCanonicalText);
  const requestedMemoryIds = [...new Set(request.memoryIds)].sort(
    compareCanonicalText,
  );
  if (JSON.stringify(recordedMemoryIds) !== JSON.stringify(requestedMemoryIds)) {
    throw new Error(
      "App uninstall request does not match the build record memory plan",
    );
  }
  const deploymentReview = Object.freeze({
    ...request.deploymentReview,
    record: deploymentRecord,
  });
  createDeploymentBuildReviewModel(deploymentReview);
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
    deploymentReview,
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
  const authorityRevision = useAppsStore.getState().authorityRevision;
  try {
    const neutron = await getNeutronCan();
    const {
      registry,
      runtime,
      pendingRecovery,
      provenance,
      browserSurfaceOriginAppIds,
    } =
      await readConsistentAppRegistry(neutron);
    if (registry === undefined) throw new Error("App registry was not found");
    const apps = registry;
    const appInstances = assertRegistryMatchesRuntime(apps, runtime);

    if (loadId === registryLoadSequence) {
      assertRuntimeAuthorityRevision(authorityRevision);
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
      useAppsStore.getState().setApps(apps, {
        appInstances,
        runtimeAssemblerId: runtime.assembler_id,
        runtimeCapabilityAuthorityRevision:
          normalizeRuntimeCapabilityAuthorityRevision(runtime),
        browserSurfaceOriginAppIds,
      });
      useAppsStore.getState().setRuntimeAuthorityFence(null);
    }
    return { apps, provenance, runtime };
  } catch (error) {
    const registryError = toInstallError(error);
    if (
      loadId === registryLoadSequence &&
      authorityRevision === useAppsStore.getState().authorityRevision
    ) {
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
  | {
      status: "changed";
      deploymentId: string;
      change: "runtime" | "capabilities";
    }
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
  currentAssemblerId = useAppsStore.getState().runtimeAssemblerId,
  currentCapabilityAuthorityRevision =
    useAppsStore.getState().runtimeCapabilityAuthorityRevision,
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
  if (
    currentAssemblerId === null ||
    runtime.assembler_id !== currentAssemblerId ||
    !sameAppInstanceInventory(currentInstances, observedInstances)
  ) {
    return {
      status: "changed",
      deploymentId: runtime.deployment_id,
      change: "runtime",
    };
  }
  const observedCapabilityAuthorityRevision =
    normalizeRuntimeCapabilityAuthorityRevision(runtime);
  if (
    observedCapabilityAuthorityRevision !== currentCapabilityAuthorityRevision
  ) {
    return {
      status: "changed",
      deploymentId: runtime.deployment_id,
      change: "capabilities",
    };
  }
  return { status: "current", deploymentId: runtime.deployment_id };
}

export function normalizeRuntimeCapabilityAuthorityRevision(
  runtime: Pick<
    KernelRuntimeInfo,
    "assembler_id" | "capability_authority_revision"
  >,
): string | null {
  const raw = runtime.capability_authority_revision;
  if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) {
    if (runtime.assembler_id === BROWSER_SURFACE_ORIGIN_ASSEMBLER_ID) {
      throw new Error(
        "Current runtime is missing its capability authority revision",
      );
    }
    return null;
  }
  if (!Array.isArray(raw) || raw.length !== 1) {
    throw new Error("Runtime capability authority revision is invalid");
  }
  const value = raw[0];
  const revision =
    typeof value === "bigint"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? BigInt(value)
        : null;
  if (revision === null || revision < 0n || revision > 0xffffffffffffffffn) {
    throw new Error("Runtime capability authority revision is invalid");
  }
  return revision.toString();
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
  const state = useAppsStore.getState();
  if (state.pendingInstallRecovery || state.runtimeAuthorityFence) return;
  state.setRuntimeAuthorityFence({
    deploymentId: null,
    reason: "observation_failed",
  });
}

function assertRuntimeAuthorityRevision(expected: number): void {
  if (useAppsStore.getState().authorityRevision === expected) return;
  throw new Error(
    "Runtime authority changed while installed app state was being verified",
  );
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
  browserSurfaceOriginAppIds: readonly string[];
}> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let pendingBefore: PendingInstallJournalError | null = null;
    try {
      await ensureInstallJournalSettled(neutron, {
        timeoutMs: PASSIVE_INSTALL_RECOVERY_TIMEOUT_MS,
      });
    } catch (error) {
      if (!(error instanceof PendingInstallJournalError)) throw error;
      pendingBefore = error;
    }
    const before = await neutron.kernel_runtime_info();
    if (pendingBefore?.deploymentId === before.deployment_id) {
      throw pendingBefore;
    }

    const [registry, rawBrowserSurfaceOrigins, provenance] = await Promise.all([
      readKernelAssetJson<AppRegistry>("/system/apps.json"),
      readKernelAssetJson<unknown>(BROWSER_SURFACE_ORIGINS_PATH),
      readInstallProvenance(),
    ]);
    const after = await neutron.kernel_runtime_info();
    let pendingAfter = pendingBefore;
    let finalRuntime = after;
    if (pendingBefore === null) {
      try {
        const trailingRecovery = await ensureInstallJournalSettled(neutron, {
          timeoutMs: PASSIVE_INSTALL_RECOVERY_TIMEOUT_MS,
        });
        if (trailingRecovery === "committed") continue;
      } catch (error) {
        if (!(error instanceof PendingInstallJournalError)) throw error;
        pendingAfter = error;
      }
      finalRuntime = await neutron.kernel_runtime_info();
    }
    if (
      before.deployment_id !== after.deployment_id ||
      after.deployment_id !== finalRuntime.deployment_id ||
      before.assembler_id !== after.assembler_id ||
      after.assembler_id !== finalRuntime.assembler_id ||
      normalizeRuntimeCapabilityAuthorityRevision(before) !==
        normalizeRuntimeCapabilityAuthorityRevision(after) ||
      normalizeRuntimeCapabilityAuthorityRevision(after) !==
        normalizeRuntimeCapabilityAuthorityRevision(finalRuntime)
    ) {
      continue;
    }
    if (pendingAfter?.deploymentId === finalRuntime.deployment_id) {
      throw pendingAfter;
    }
    if (registry === undefined) {
      return {
        registry,
        runtime: finalRuntime,
        provenance,
        browserSurfaceOriginAppIds: Object.freeze([]),
        pendingRecovery: pendingAfter
          ? { deploymentId: pendingAfter.deploymentId }
          : null,
      };
    }
    const normalizedRegistry = normalizeAppRegistry(registry);
    const browserSurfaceOriginAppIds =
      parseBrowserSurfaceOriginAuthoritySnapshot(
        rawBrowserSurfaceOrigins,
        normalizedRegistry,
        finalRuntime.assembler_id,
      );
    return {
      registry: normalizedRegistry,
      runtime: finalRuntime,
      provenance,
      browserSurfaceOriginAppIds,
      pendingRecovery: pendingAfter
        ? { deploymentId: pendingAfter.deploymentId }
        : null,
    };
  }
  throw new Error(
    "Installed app state kept changing in another tab. Wait for it to finish and try again.",
  );
}

/**
 * Bind the closed sidecar shape to the only two runtime generations this
 * frontend can safely bridge. V26 always has a sidecar, including for an empty
 * set; the exact v25 predecessor never has one.
 */
export function parseBrowserSurfaceOriginAuthoritySnapshot(
  value: unknown,
  registry: AppRegistry,
  assemblerId: string,
): readonly string[] {
  if (assemblerId === LEGACY_V25_ASSEMBLER_ID) {
    if (value !== undefined) {
      throw new Error(
        "The v25 runtime cannot own a browser-surface origins sidecar",
      );
    }
    return Object.freeze([]);
  }
  if (assemblerId !== BROWSER_SURFACE_ORIGIN_ASSEMBLER_ID) {
    throw new Error(
      `Unsupported runtime assembler generation ${assemblerId}`,
    );
  }
  if (value === undefined) {
    throw new Error("The v26 browser-surface origins sidecar is missing");
  }
  return Object.freeze(
    parseBrowserSurfaceOriginsSidecar(value, Object.keys(registry)),
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
  expectedBrowserSurfaceOriginAppIds: readonly string[],
  options: { invalidateAppIds?: readonly string[] } = {},
): Promise<void> {
  // Runtime info exposes the exact running actor, which is the staged target
  // between activation and commit. Never turn that projection into browser
  // authority until the independently queried journal is absent on both sides
  // of the read.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const authorityRevision = useAppsStore.getState().authorityRevision;
    await ensureInstallJournalSettled(neutron, {
      timeoutMs: PASSIVE_INSTALL_RECOVERY_TIMEOUT_MS,
    });
    const before = await neutron.kernel_runtime_info();
    const rawBrowserSurfaceOrigins = await readKernelAssetJson<unknown>(
      BROWSER_SURFACE_ORIGINS_PATH,
    );
    const after = await neutron.kernel_runtime_info();
    const trailing = await ensureInstallJournalSettled(neutron);
    if (trailing === "committed") continue;
    const finalRuntime = await neutron.kernel_runtime_info();
    if (
      before.deployment_id !== after.deployment_id ||
      after.deployment_id !== finalRuntime.deployment_id ||
      before.assembler_id !== after.assembler_id ||
      after.assembler_id !== finalRuntime.assembler_id ||
      normalizeRuntimeCapabilityAuthorityRevision(before) !==
        normalizeRuntimeCapabilityAuthorityRevision(after) ||
      normalizeRuntimeCapabilityAuthorityRevision(after) !==
        normalizeRuntimeCapabilityAuthorityRevision(finalRuntime)
    ) {
      continue;
    }
    assertCurrentBrowserSurfaceOriginAssembler(finalRuntime.assembler_id);
    const appInstances = assertRegistryMatchesRuntime(apps, finalRuntime);
    const browserSurfaceOriginAppIds =
      parseBrowserSurfaceOriginAuthoritySnapshot(
        rawBrowserSurfaceOrigins,
        apps,
        finalRuntime.assembler_id,
      );
    if (
      JSON.stringify(browserSurfaceOriginAppIds) !==
      JSON.stringify(expectedBrowserSurfaceOriginAppIds)
    ) {
      throw new Error(
        "Committed browser-surface origin authority does not match the compiled deployment",
      );
    }
    if (useAppsStore.getState().authorityRevision !== authorityRevision) {
      continue;
    }
    if (useAppsStore.getState().pendingInstallRecovery !== null) {
      useAppsStore.getState().setRuntimeAuthorityFence({
        deploymentId: finalRuntime.deployment_id,
        reason: "runtime_changed",
      });
    }
    useAppsStore.getState().setPendingInstallRecovery(null);
    useAppsStore.getState().setApps(apps, {
      ...options,
      appInstances,
      runtimeAssemblerId: finalRuntime.assembler_id,
      runtimeCapabilityAuthorityRevision:
        normalizeRuntimeCapabilityAuthorityRevision(finalRuntime),
      browserSurfaceOriginAppIds,
    });
    useAppsStore.getState().setRuntimeAuthorityFence(null);
    return;
  }
  throw new Error(
    "Committed app identity kept changing after installation. Reload and try again.",
  );
}

export function assertCurrentBrowserSurfaceOriginAssembler(
  assemblerId: string,
): void {
  if (assemblerId === BROWSER_SURFACE_ORIGIN_ASSEMBLER_ID) return;
  throw new Error(
    `Committed deployment did not activate ${BROWSER_SURFACE_ORIGIN_ASSEMBLER_ID}; found ${assemblerId}`,
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
  const baseline = await readConsistentManualInstallBaseline(neutron);
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
    existingApps: kernelState.apps,
    existingBrowserSurfaceOriginAppIds:
      kernelState.browserSurfaceOriginAppIds,
    existingStable: kernelState.previousStable,
    connectionProviderSupport: kernelState.connectionProviderSupport,
    preparedPackage,
    deploymentNonce: createDeploymentNonce(),
    vetKeysEnvironment: runtimeCompilerEnvironment(),
    persistenceMode: persistenceModeFromCompilerId(
      baseline.runtime.compiler_id,
    ),
  });
  const deployment = await prepareBrowserDeployment({
    targetCanisterId: getRuntimeDeployment().canisterId,
    packages: [preparedPackage],
    state: kernelState,
    compiled,
    expectedDeploymentId: baseline.expectedDeploymentId,
    provenance: baseline.provenance,
    runtime: baseline.runtime,
  });

  if (installId === installSequence) {
    useAppsStore.getState().setCompiled({
      size: Math.ceil(compiled.wasm.length / 1024),
      deploymentReview: deployment.review,
    });
  }
  return {
    baselineFingerprint: baseline.fingerprint,
    compiled,
    deployment,
    state: kernelState,
    expectedDeploymentId: baseline.expectedDeploymentId,
  };
}

type ManualInstallBaseline = Readonly<{
  state: KernelPackageState;
  runtime: KernelRuntimeInfo;
  expectedDeploymentId: string;
  provenance: InstallProvenance;
  fingerprint: string;
}>;

type ManualInstallProvenanceSnapshot = Readonly<{
  provenance: InstallProvenance;
  assetFingerprint: string;
}>;

/**
 * Bracket the complete compiler state and the exact optional provenance asset
 * with the running deployment. The same snapshot is taken again after the
 * user reviews the build and before any staging work begins.
 */
async function readConsistentManualInstallBaseline(
  neutron: Awaited<ReturnType<typeof getNeutronCan>>,
): Promise<ManualInstallBaseline> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await ensureInstallJournalSettled(neutron, {
      timeoutMs: PASSIVE_INSTALL_RECOVERY_TIMEOUT_MS,
    });
    const before = await neutron.kernel_runtime_info();
    const [state, provenanceSnapshot] = await Promise.all([
      readCurrentKernelPackageState(neutron),
      readManualInstallProvenanceSnapshot(),
    ]);
    const after = await neutron.kernel_runtime_info();
    const trailingRecovery = await ensureInstallJournalSettled(neutron, {
      timeoutMs: PASSIVE_INSTALL_RECOVERY_TIMEOUT_MS,
    });
    if (trailingRecovery === "committed") continue;
    if (
      before.deployment_id === after.deployment_id &&
      before.assembler_id === after.assembler_id &&
      normalizeRuntimeCapabilityAuthorityRevision(before) ===
        normalizeRuntimeCapabilityAuthorityRevision(after)
    ) {
      assertKernelPackageBaselineMatchesRuntime(state, after);
      const fingerprint = hashContent(
        JSON.stringify(
          canonicalValue({
            packageBaseline: packageBaselineFingerprint({
              state,
              runtime: after,
              provenance: provenanceSnapshot.provenance,
            }),
            provenanceAsset: provenanceSnapshot.assetFingerprint,
          }),
        ),
      );
      return Object.freeze({
        state,
        runtime: after,
        expectedDeploymentId: after.deployment_id,
        provenance: provenanceSnapshot.provenance,
        fingerprint,
      });
    }
  }
  throw new Error(
    "Installed app state kept changing in another tab. Wait for it to finish and try again.",
  );
}

async function ensureInstallJournalSettled(
  neutron: Awaited<ReturnType<typeof getNeutronCan>>,
  options?: { timeoutMs?: number },
): Promise<"none" | "committed"> {
  const recovery = await recoverPendingInstall(neutron, options);
  if (recovery.status === "pending") {
    throw new PendingInstallJournalError(recovery.deploymentId);
  }
  return recovery.status === "committed" ? "committed" : "none";
}

// Registry loading is passive: probe an already-activated target once, then
// show the committed apps and the recovery banner instead of polling in the
// background. The active deploy and explicit Retry paths retain the full wait.
const PASSIVE_INSTALL_RECOVERY_TIMEOUT_MS = 10;

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
  await resetNeutronCanBinding();
  await getApps();
  announceRuntimeAuthorityChange({
    deploymentId,
    phase: "committed",
  });
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

async function readManualInstallProvenanceSnapshot(): Promise<ManualInstallProvenanceSnapshot> {
  const value = await readKernelAssetJson<unknown>(INSTALL_PROVENANCE_PATH);
  const assetFingerprint = hashContent(
    JSON.stringify(
      canonicalValue({
        present: value !== undefined,
        value: value ?? null,
      }),
    ),
  );
  try {
    return Object.freeze({
      provenance: installProvenanceOrEmpty(value),
      assetFingerprint,
    });
  } catch (error) {
    // Preserve the manual repair path, but retain an exact fingerprint so an
    // invalid historical asset cannot change while the review is open.
    console.warn(
      "Installed package provenance is invalid; retained archive digests will be marked unavailable",
      error,
    );
    return Object.freeze({
      provenance: installProvenanceOrEmpty(undefined),
      assetFingerprint,
    });
  }
}

function removeInstallProvenanceAssets(
  current: InstallProvenance,
  appId: string,
): InstallStagedAsset[] {
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

function manualInstallProvenanceAssets(
  current: InstallProvenance,
  appId: string,
  acquisition: "file" | "url",
  packageDigest: string,
): InstallStagedAsset[] {
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
      deployment: PreparedBrowserDeployment;
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
            existingApps: state.apps,
            existingBrowserSurfaceOriginAppIds:
              state.browserSurfaceOriginAppIds,
            existingStable: state.previousStable,
            connectionProviderSupport: state.connectionProviderSupport,
            deploymentNonce: createDeploymentNonce(),
            vetKeysEnvironment: runtimeCompilerEnvironment(),
            persistenceMode: persistenceModeFromCompilerId(
              runtime.compiler_id,
            ),
          });
          const deployment = await prepareBrowserDeployment({
            targetCanisterId: getRuntimeDeployment().canisterId,
            packages,
            state,
            compiled,
            expectedDeploymentId: runtime.deployment_id,
            provenance,
            runtime,
          });
          assertActive();
          compiledAttempt = Object.freeze({
            compiled,
            deployment,
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
      getPreparedDeployment(packages, compiled) {
        assertActive();
        if (
          compiledAttempt?.compiled !== compiled ||
          compiledAttempt.packageFingerprint !==
            preparedPackageBatchFingerprint(packages)
        ) {
          throw new Error(
            "Package batch changed after compilation. Compile this exact batch again.",
          );
        }
        return compiledAttempt.deployment;
      },
      async deploy({
        packages,
        compiled,
        deploymentBuildRecord,
        provenance: provenanceEntries,
      }) {
        beginCall();
        const appIds = packages.map(({ manifest }) => manifest.id);
        let deployStarted = false;
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
          if (
            compiledAttempt.deployment.prepared.record !==
            deploymentBuildRecord
          ) {
            throw new Error(
              "Deployment build record changed after review. Compile this exact batch again.",
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
          const targetCanisterId = getRuntimeDeployment().canisterId;
          const revalidatedDeployment = await prepareBrowserDeployment({
            targetCanisterId,
            packages,
            state: currentState,
            compiled,
            expectedDeploymentId: currentRuntime.deployment_id,
            provenance: currentProvenance,
            runtime: currentRuntime,
          });
          assertActive();
          if (
            !equalByteArrays(
              revalidatedDeployment.prepared.recordBytes,
              compiledAttempt.deployment.prepared.recordBytes,
            )
          ) {
            throw new Error(
              "Installed package evidence changed during review. Review the newly compiled deployment before continuing.",
            );
          }
          useAppsStore.getState().setOperation({
            kind: mode === "update" ? "update" : "install",
            ...(appIds.length === 1 ? { appId: appIds[0] } : {}),
            phase: "staging",
          });
          if (appIds.includes("kernel")) {
            disableAgentMode("Kernel update started");
          }

          const nextProvenance = withInstallProvenance(
            currentProvenance,
            provenanceEntries,
          );
          deployStarted = true;
          const { apps } = await deployPreparedPackages({
            actor: neutron,
            targetCanisterId,
            packages: [...packages],
            compiled,
            existingApps: currentState.apps,
            existingBrowserSurfaceOriginAppIds:
              currentState.browserSurfaceOriginAppIds,
            previousModulePaths: currentState.existingModules.map(
              ({ path }) => path,
            ),
            deploymentBuildRecord,
            expectedDeploymentId: currentRuntime.deployment_id,
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

          await setCommittedAppsFromRuntime(
            neutron,
            apps,
            compiled.browserSurfaceOriginAppIds,
            mode === "update" ? { invalidateAppIds: appIds } : {},
          );
          announceRuntimeAuthorityChange({
            deploymentId: compiled.deploymentId,
            phase: "committed",
            kernelUpdated: appIds.includes("kernel"),
          });
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
          if (deployStarted) {
            await retainFrontendAuthorityAfterDeployFailure(neutron);
          }
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

async function readConsistentRepositoryPackageState(
  neutron: Awaited<ReturnType<typeof getNeutronCan>>,
): Promise<{
  state: KernelPackageState;
  runtime: KernelRuntimeInfo;
  provenance: InstallProvenance;
}> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await ensureInstallJournalSettled(neutron, {
      timeoutMs: PASSIVE_INSTALL_RECOVERY_TIMEOUT_MS,
    });
    const before = await neutron.kernel_runtime_info();
    const [state, provenance] = await Promise.all([
      readCurrentKernelPackageState(neutron),
      readInstallProvenance(),
    ]);
    const after = await neutron.kernel_runtime_info();
    const trailingRecovery = await ensureInstallJournalSettled(neutron, {
      timeoutMs: PASSIVE_INSTALL_RECOVERY_TIMEOUT_MS,
    });
    if (trailingRecovery === "committed") continue;
    if (
      before.deployment_id === after.deployment_id &&
      before.assembler_id === after.assembler_id &&
      normalizeRuntimeCapabilityAuthorityRevision(before) ===
        normalizeRuntimeCapabilityAuthorityRevision(after)
    ) {
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
        connectionProviderSupport: state.connectionProviderSupport,
        browserSurfaceOriginAppIds: state.browserSurfaceOriginAppIds,
        browserSurfaceOriginsSidecarPresent:
          state.browserSurfaceOriginsSidecarPresent,
        provenance,
        runtime: {
          deploymentId: runtime.deployment_id,
          assemblerId: runtime.assembler_id,
          compilerId: runtime.compiler_id,
          capabilityAuthorityRevision:
            normalizeRuntimeCapabilityAuthorityRevision(runtime),
          apps: runtime.apps
            .map(
              ({
                scope,
                version,
                deployment_id,
                capability_plan_fingerprint,
                browser_origin_nonce,
                browser_origin_authority_epoch,
                resident_frame_security,
              }) => ({
                id: scope.app_id,
                installationUid: String(scope.installation_uid),
                version: String(version),
                deploymentId: deployment_id,
                capabilityPlanFingerprint: capability_plan_fingerprint,
                browserOriginNonce: browser_origin_nonce,
                browserOriginAuthorityEpoch: String(
                  browser_origin_authority_epoch,
                ),
                residentFrameSecurity: resident_frame_security,
              }),
            )
            .sort((left, right) => compareCanonicalText(left.id, right.id)),
          memories: (runtime.memories ?? [])
            .map(({ owner, id, version, schema }) => ({
              owner,
              id,
              version: String(version),
              schema,
            }))
            .sort(
              (left, right) =>
                compareCanonicalText(left.owner, right.owner) ||
                compareCanonicalText(left.id, right.id),
            ),
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

function equalByteArrays(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export async function uninstall_app(
  appId: string,
): Promise<AppInstallResult | null> {
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

async function uninstallAppInternal(
  appId: string,
): Promise<AppInstallResult | null> {
  useAppsStore.getState().setOperation({
    kind: "uninstall",
    appId,
    phase: "preparing",
  });
  useAppsStore.getState().setInstallError(null);
  let deployStarted = false;
  try {
    const neutron = await getNeutronCan();
    const baseline = await readConsistentManualInstallBaseline(neutron);
    const { state, expectedDeploymentId, runtime } = baseline;
    const compiled = await compileAppUninstall({
      state,
      appId,
      deploymentNonce: createDeploymentNonce(),
      vetKeysEnvironment: runtimeCompilerEnvironment(),
      persistenceMode: persistenceModeFromCompilerId(runtime.compiler_id),
    });
    const app = state.apps[appId];
    if (!app) {
      throw new Error(`${appId} is not installed`);
    }
    const targetCanisterId = getRuntimeDeployment().canisterId;
    const deployment = await prepareBrowserDeployment({
      compiled,
      expectedDeploymentId,
      packages: [],
      provenance: baseline.provenance,
      removedApps: [appId],
      runtime,
      state,
      targetCanisterId,
    });
    useAppsStore.getState().setOperation(null);
    const approved = await requestAppUninstall({
      appId,
      appName: app.name,
      memoryIds: deployment.prepared.record.warnings.destructive_memory_roots
        .filter(({ owner }) => owner === appId)
        .map(({ memory_id }) => memory_id),
      deploymentReview: deployment.review,
    });
    if (!approved) return null;

    const currentBaseline = await readConsistentManualInstallBaseline(neutron);
    if (currentBaseline.fingerprint !== baseline.fingerprint) {
      throw new Error(
        "Installed app state changed during uninstall review. Review the newly compiled removal before continuing.",
      );
    }
    const revalidatedDeployment = await prepareBrowserDeployment({
      compiled,
      expectedDeploymentId: currentBaseline.expectedDeploymentId,
      packages: [],
      provenance: currentBaseline.provenance,
      removedApps: [appId],
      runtime: currentBaseline.runtime,
      state: currentBaseline.state,
      targetCanisterId,
    });
    if (
      !equalByteArrays(
        revalidatedDeployment.prepared.recordBytes,
        deployment.prepared.recordBytes,
      )
    ) {
      throw new Error(
        "Installed package evidence changed during uninstall review. Review the newly compiled removal before continuing.",
      );
    }
    const provenanceAssets = removeInstallProvenanceAssets(
      currentBaseline.provenance,
      appId,
    );
    useAppsStore.getState().setOperation({
      kind: "uninstall",
      appId,
      phase: "staging",
    });
    deployStarted = true;
    const result = await deployPreparedPackages({
      actor: neutron,
      targetCanisterId,
      packages: [],
      compiled,
      existingApps: state.apps,
      existingBrowserSurfaceOriginAppIds:
        state.browserSurfaceOriginAppIds,
      previousModulePaths: state.existingModules.map(({ path }) => path),
      removedApps: [appId],
      ...(provenanceAssets.length > 0
        ? { stagedAssets: provenanceAssets }
        : {}),
      deploymentBuildRecord: deployment.prepared.record,
      expectedDeploymentId,
      onStep(step) {
        setDeployOperation("uninstall", appId, step);
        announceActivationStep(step, compiled.deploymentId, false);
      },
    });
    await setCommittedAppsFromRuntime(
      neutron,
      result.apps,
      result.compiled.browserSurfaceOriginAppIds,
    );
    announceRuntimeAuthorityChange({
      deploymentId: result.compiled.deploymentId,
      phase: "committed",
    });
    removeAppRuntimeState(appId, true);
    await resetNeutronCanBinding();
    await delay(300);
    useAppsStore.getState().setInstalled();
    return { appId, apps: result.apps };
  } catch (error) {
    const neutron = await getNeutronCan().catch(() => null);
    if (neutron && deployStarted) {
      await retainFrontendAuthorityAfterDeployFailure(neutron);
    } else if (isAuthorityPendingState(useAppsStore.getState())) {
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
  const suppliedProvenance = Object.freeze({
    [id]: Object.freeze({
      kind: "manual" as const,
      acquisition: source.kind,
      package_digest: packageDigest,
    }),
  });
  assertPackageProvenanceCoverage([preparedPackage], suppliedProvenance);
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

  let deployStarted = false;
  try {
    const currentBaseline = await readConsistentManualInstallBaseline(neutron);
    if (currentBaseline.fingerprint !== compileDetails.baselineFingerprint) {
      throw new Error(
        "Installed app state or provenance changed during review. Review the newly compiled deployment before continuing.",
      );
    }
    const revalidatedDeployment = await prepareBrowserDeployment({
      targetCanisterId: getRuntimeDeployment().canisterId,
      packages: [preparedPackage],
      state: currentBaseline.state,
      compiled: compileDetails.compiled,
      expectedDeploymentId: currentBaseline.expectedDeploymentId,
      provenance: currentBaseline.provenance,
      runtime: currentBaseline.runtime,
    });
    if (
      !equalByteArrays(
        revalidatedDeployment.prepared.recordBytes,
        compileDetails.deployment.prepared.recordBytes,
      )
    ) {
      throw new Error(
        "Installed package evidence changed during review. Review the newly compiled deployment before continuing.",
      );
    }
    // Re-hash the exact retained archive immediately before staging so browser
    // memory mutation after review cannot bind different bytes to provenance.
    assertPackageProvenanceCoverage([preparedPackage], suppliedProvenance);
    const provenanceAssets = manualInstallProvenanceAssets(
      currentBaseline.provenance,
      id,
      source.kind,
      packageDigest,
    );
    useAppsStore.getState().setOperation({
      kind: "install",
      appId: id,
      phase: "staging",
    });
    if (id === "kernel") disableAgentMode("Kernel update started");
    deployStarted = true;
    const { apps: appconfig } = await deployPreparedPackages({
      actor: neutron,
      targetCanisterId: getRuntimeDeployment().canisterId,
      packages: [preparedPackage],
      compiled: compileDetails.compiled,
      existingApps: currentBaseline.state.apps,
      existingBrowserSurfaceOriginAppIds:
        currentBaseline.state.browserSurfaceOriginAppIds,
      previousModulePaths: currentBaseline.state.existingModules.map(
        ({ path }) => path,
      ),
      deploymentBuildRecord: compileDetails.deployment.prepared.record,
      expectedDeploymentId: currentBaseline.expectedDeploymentId,
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

    await setCommittedAppsFromRuntime(
      neutron,
      appconfig,
      compileDetails.compiled.browserSurfaceOriginAppIds,
      {
        invalidateAppIds: decisionOperation === "update" ? [id] : [],
      },
    );
    announceRuntimeAuthorityChange({
      deploymentId: compileDetails.compiled.deploymentId,
      phase: "committed",
      kernelUpdated: id === "kernel",
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
      if (deployStarted) {
        await retainFrontendAuthorityAfterDeployFailure(neutron);
      }
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

function retainRegistryIdentity(
  next: AppRegistry,
  current: AppRegistry,
): AppRegistry {
  const nextIds = Object.keys(next);
  const currentIds = Object.keys(current);
  if (
    nextIds.length === currentIds.length &&
    nextIds.every(
      (appId) =>
        current[appId] !== undefined &&
        registryEntriesEqual(current[appId], next[appId]),
    )
  ) {
    return current;
  }
  return Object.fromEntries(
    nextIds.map((appId) => [
      appId,
      registryEntriesEqual(current[appId], next[appId])
        ? current[appId]!
        : next[appId]!,
    ]),
  );
}

function retainAppInstanceInventoryIdentity(
  next: Readonly<Record<string, AppInstanceProjection>>,
  current: Readonly<Record<string, AppInstanceProjection>>,
): Readonly<Record<string, AppInstanceProjection>> {
  const nextIds = Object.keys(next);
  const currentIds = Object.keys(current);
  if (
    nextIds.length === currentIds.length &&
    nextIds.every(
      (appId) =>
        current[appId] !== undefined &&
        sameAppInstance(current[appId], next[appId]),
    )
  ) {
    return current;
  }
  return Object.freeze(
    Object.fromEntries(
      nextIds.map((appId) => [
        appId,
        sameAppInstance(current[appId], next[appId])
          ? current[appId]!
          : next[appId]!,
      ]),
    ),
  );
}

function canonicalBrowserSurfaceOriginAppIds(
  appIds: readonly string[],
  registry: AppRegistry,
): readonly string[] {
  const canonical = normalizeBrowserSurfaceOriginAppIds(
    appIds,
    Object.keys(registry),
  );
  if (JSON.stringify(canonical) !== JSON.stringify(appIds)) {
    throw new Error("Browser-surface origin app IDs are not canonical");
  }
  return Object.freeze(canonical);
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
