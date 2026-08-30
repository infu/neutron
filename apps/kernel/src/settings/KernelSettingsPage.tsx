import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from "react";
import { IoArrowBack, IoHardwareChipOutline, IoRefresh } from "react-icons/io5";
import {
  appDependencyImpact,
  KERNEL_INSTALL_MAX_APP_REMOVALS_PER_COMMIT,
  planAppRegistryDependencies,
  type AppDependencyImpact,
  type KernelRuntimeInfo,
} from "neutron-compiler/src/install.js";
import { getNeutronId } from "../config.ts";
import {
  getApps,
  isAuthorityPendingState,
  refreshRuntimeAuthority,
  uninstall_apps,
  useAppsStore,
} from "../reducer/apps.ts";
import {
  getNeutronCan,
  readKernelAssetTextIfExists,
  useAuthStore,
} from "../reducer/auth.ts";
import {
  formatBytes,
  formatExactNat,
  formatTrillionCycles,
  formatTimestamp,
  type NatValue,
} from "./format.ts";
import {
  reconcileAppRegistry,
  settingsAppRows,
  validateScheduledTasks,
  appUsageScopeKey,
  type KernelAppUsageSnapshot,
  type KernelSettingsSnapshot,
  type ScheduledTaskSummary,
} from "./model.ts";
import {
  capabilitySummaryKey,
  loadCapabilityRegistry,
  reconcileCapabilityRegistry,
  replaceCapabilitySummary,
  setCapabilityRegistryEnabled,
  type CapabilitySummary,
  type ReconciledCapabilityInventory,
} from "./capability_registry.ts";
import {
  loadKernelAppUsageSnapshot,
  loadKernelSettingsSnapshot,
} from "./snapshot.ts";
import { AccessSettings } from "./AccessSettings.tsx";
import {
  AppSettingsEntry,
  type AppUsageCellState,
} from "./AppSettingsEntry.tsx";
import {
  AppUpdateCell,
  AppUpdatesBulkAction,
  AppUpdatesCoordinator,
  AppUpdatesFeedback,
} from "./AppUpdatesSection.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { SettingsDisclosure } from "./SettingsDisclosure.tsx";
import {
  listAllBackendReservations,
  revokeBackendReservation,
  type BackendCallReservation,
} from "../backend_calls/service.ts";
import { AgentModeSettings } from "../AgentModeUI.tsx";
import { VetKeysSettings } from "./VetKeysSettings.tsx";
import {
  INSTALL_PROVENANCE_PATH,
  installProvenanceOrEmpty,
  type InstallProvenance,
} from "../repository/provenance.ts";
import { KernelUiModeSettings } from "./KernelUiModeSettings.tsx";
import { useKernelUiModeStore } from "../ui_mode.ts";
import { checkAppUpdates } from "../updates/service.ts";
import { useUpdateCheckStore } from "../updates/store.ts";
import { AppInstallRecoveryPanel } from "./AppInstallRecoveryPanel.tsx";
import { committedFrontendDeploymentId } from "../runtime_authority.ts";
import { announceRuntimeAuthorityChange } from "../runtime_authority_signal.ts";
import {
  compareInstalledModuleHash,
  loadCertifiedInstalledModuleHash,
  type CertifiedInstalledModuleHash,
} from "./deployment_integrity.ts";
import {
  DeploymentModuleHashDetail,
  DeploymentModuleHashError,
} from "./DeploymentIntegrityDetails.tsx";
import {
  DeploymentBuildRecordDetails,
  type DeploymentBuildRecordViewState,
} from "./DeploymentBuildRecordDetails.tsx";
import {
  DEPLOYMENT_BUILD_RECORD_PATH,
  deploymentRecordRuntimeInconsistency,
  loadInstalledDeploymentBuildRecord,
  type InstalledDeploymentBuildRecordInspection,
} from "./deployment_build_record.ts";
import {
  installedPackageAssetBasePath,
  loadInstalledPackageRecordInventory,
  type InstalledPackageRecordInspection,
  type InstalledPackageRecordInventory,
} from "./installed_package_record.ts";

type ResourceState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
};

type IntegrityRefreshFence =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "ready" }>
  | Readonly<{
      status: "raced";
      beforeDeploymentId: string;
      afterDeploymentId: string;
    }>
  | Readonly<{ status: "unavailable"; message: string }>;

const initialResource = <T,>(): ResourceState<T> => ({
  data: null,
  error: null,
  loading: true,
});

const LOADING_PACKAGE_RECORD = Object.freeze({
  status: "loading" as const,
});

export function KernelSettingsPage({ onBack }: { onBack: () => void }) {
  const principal = useAuthStore((state) => state.principal);
  const uiMode = useKernelUiModeStore((state) => state.mode);
  const updateCheckPhase = useUpdateCheckStore((state) => state.phase);
  const apps = useAppsStore((state) => state.list);
  const appInstances = useAppsStore((state) => state.appInstances);
  const registryStatus = useAppsStore((state) => state.registryStatus);
  const registryError = useAppsStore((state) => state.registryError);
  const operationBusy = useAppsStore((state) => state.operationBusy);
  const authorityPending = useAppsStore(isAuthorityPendingState);
  const appMutationBlocked = operationBusy || authorityPending;
  const [snapshot, setSnapshot] =
    useState<ResourceState<KernelSettingsSnapshot>>(initialResource);
  const [runtime, setRuntime] =
    useState<ResourceState<KernelRuntimeInfo>>(initialResource);
  const [installedModuleHash, setInstalledModuleHash] =
    useState<ResourceState<CertifiedInstalledModuleHash>>(initialResource);
  const [deploymentBuildRecord, setDeploymentBuildRecord] =
    useState<ResourceState<InstalledDeploymentBuildRecordInspection>>(
      initialResource,
    );
  const [integrityRefreshFence, setIntegrityRefreshFence] =
    useState<IntegrityRefreshFence>({ status: "loading" });
  const [packageRecords, setPackageRecords] =
    useState<ResourceState<InstalledPackageRecordInventory>>(initialResource);
  const [backendReservations, setBackendReservations] =
    useState<ResourceState<BackendCallReservation[]>>(initialResource);
  const [scheduledTasks, setScheduledTasks] =
    useState<ResourceState<ScheduledTaskSummary[]>>(initialResource);
  const [capabilities, setCapabilities] =
    useState<ResourceState<readonly CapabilitySummary[]>>(initialResource);
  const [appUsage, setAppUsage] =
    useState<ResourceState<KernelAppUsageSnapshot>>(initialResource);
  const [provenance, setProvenance] =
    useState<ResourceState<InstallProvenance>>(initialResource);
  const [capabilityOperation, setCapabilityOperation] = useState<string | null>(null);
  const [actionAppIds, setActionAppIds] = useState<string[]>([]);
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const [lastSuccessfulRefresh, setLastSuccessfulRefresh] = useState<
    number | null
  >(null);
  const refreshGeneration = useRef(0);
  const settingsRequestActive = useRef(false);
  const installedAppsRef = useRef<HTMLElement>(null);
  const updateReturnFocusRef = useRef<HTMLButtonElement>(null);
  const canisterId = getNeutronId();

  const refresh = useCallback(async () => {
    if (settingsRequestActive.current) return;
    settingsRequestActive.current = true;
    const generation = ++refreshGeneration.current;
    setSnapshot((current) => ({ ...current, error: null, loading: true }));
    setRuntime((current) => ({ ...current, error: null, loading: true }));
    setInstalledModuleHash((current) => ({
      ...current,
      error: null,
      loading: true,
    }));
    setDeploymentBuildRecord((current) => ({
      ...current,
      error: null,
      loading: true,
    }));
    setIntegrityRefreshFence({ status: "loading" });
    setPackageRecords({ data: null, error: null, loading: true });
    setBackendReservations((current) => ({
      ...current,
      error: null,
      loading: true,
    }));
    setScheduledTasks((current) => ({ ...current, error: null, loading: true }));
    setCapabilities((current) => ({ ...current, error: null, loading: true }));
    setAppUsage((current) => ({
      ...current,
      error: null,
      loading: true,
    }));
    setProvenance((current) => ({ ...current, error: null, loading: true }));

    try {
      const actor = getNeutronCan();
      const currentApps = useAppsStore.getState();
      // Recovery owns journal inspection and commit retries. Re-reading the
      // registry through getApps() here would wait for activation and make
      // unrelated Settings refreshes appear frozen behind a pending install.
      const registryRefresh = isAuthorityPendingState(currentApps)
        ? Promise.resolve(currentApps.list)
        : getApps();
      const packageRecordRefresh = registryRefresh.then((registry) =>
        loadInstalledPackageRecordInventory(registry),
      );
      const runtimeBeforeRefresh = actor.then((kernel) =>
        kernel.kernel_runtime_info(),
      );
      const installedModuleHashRefresh = runtimeBeforeRefresh.then(() =>
        loadCertifiedInstalledModuleHash(),
      );
      const deploymentBuildRecordRefresh = runtimeBeforeRefresh.then(() =>
        loadInstalledDeploymentBuildRecord({ canisterId }),
      );
      const runtimeAfterRefresh = Promise.allSettled([
        installedModuleHashRefresh,
        deploymentBuildRecordRefresh,
      ]).then(() => actor.then((kernel) => kernel.kernel_runtime_info()));
      const results = await Promise.allSettled([
        registryRefresh,
        runtimeBeforeRefresh,
        loadKernelSettingsSnapshot(actor),
        actor
          .then((kernel) => kernel.kernel_scheduled_tasks_snapshot(null))
          .then(validateScheduledTasks),
        actor.then(loadCapabilityRegistry),
        listAllBackendReservations(),
        readKernelAssetTextIfExists(INSTALL_PROVENANCE_PATH).then((value) =>
          installProvenanceOrEmpty(value === undefined ? undefined : JSON.parse(value)),
        ),
        installedModuleHashRefresh,
        deploymentBuildRecordRefresh,
        packageRecordRefresh,
        runtimeAfterRefresh,
        loadKernelAppUsageSnapshot(actor),
      ]);
      if (generation !== refreshGeneration.current) return;

      const [
        ,
        runtimeBeforeResult,
        snapshotResult,
        scheduledResult,
        capabilitiesResult,
        reservationsResult,
        provenanceResult,
        installedModuleHashResult,
        deploymentBuildRecordResult,
        packageRecordsResult,
        runtimeAfterResult,
        appUsageResult,
      ] = results;
      const runtimeResult =
        runtimeAfterResult?.status === "fulfilled"
          ? runtimeAfterResult
          : runtimeBeforeResult;
      const nextIntegrityFence: IntegrityRefreshFence =
        runtimeBeforeResult.status !== "fulfilled"
          ? {
              status: "unavailable",
              message: errorMessage(runtimeBeforeResult.reason),
            }
          : runtimeAfterResult?.status !== "fulfilled"
            ? {
                status: "unavailable",
                message: errorMessage(runtimeAfterResult?.reason),
              }
            : runtimeBeforeResult.value.deployment_id !==
                runtimeAfterResult.value.deployment_id
              ? {
                  status: "raced",
                  beforeDeploymentId: runtimeBeforeResult.value.deployment_id,
                  afterDeploymentId: runtimeAfterResult.value.deployment_id,
                }
              : { status: "ready" };
      setIntegrityRefreshFence(nextIntegrityFence);
      setRuntime((current) =>
        runtimeResult.status === "fulfilled"
          ? { data: runtimeResult.value, error: null, loading: false }
          : {
              ...current,
              error: errorMessage(runtimeResult.reason),
              loading: false,
            },
      );
      setSnapshot((current) =>
        snapshotResult.status === "fulfilled"
          ? { data: snapshotResult.value, error: null, loading: false }
          : {
              ...current,
              error: errorMessage(snapshotResult.reason),
              loading: false,
            },
      );
      setBackendReservations((current) =>
        reservationsResult?.status === "fulfilled"
          ? { data: reservationsResult.value, error: null, loading: false }
          : {
              ...current,
              error: errorMessage(reservationsResult?.reason),
              loading: false,
            },
      );
      setScheduledTasks((current) =>
        scheduledResult?.status === "fulfilled"
          ? { data: scheduledResult.value, error: null, loading: false }
          : {
              ...current,
              error: errorMessage(scheduledResult?.reason),
              loading: false,
            },
      );
      setCapabilities(() =>
        capabilitiesResult?.status === "fulfilled"
          ? { data: capabilitiesResult.value, error: null, loading: false }
          : {
              data: null,
              error: errorMessage(capabilitiesResult?.reason),
              loading: false,
            },
      );
      setAppUsage((current) =>
        appUsageResult?.status === "fulfilled"
          ? { data: appUsageResult.value, error: null, loading: false }
          : {
              ...current,
              error: errorMessage(appUsageResult?.reason),
              loading: false,
            },
      );
      setProvenance((current) =>
        provenanceResult?.status === "fulfilled"
          ? { data: provenanceResult.value, error: null, loading: false }
          : {
              ...current,
              error: errorMessage(provenanceResult?.reason),
              loading: false,
            },
      );
      setInstalledModuleHash((current) =>
        installedModuleHashResult?.status === "fulfilled"
          ? {
              data: installedModuleHashResult.value,
              error: null,
              loading: false,
            }
          : {
              ...current,
              error: errorMessage(installedModuleHashResult?.reason),
              loading: false,
            },
      );
      setDeploymentBuildRecord((current) =>
        deploymentBuildRecordResult?.status === "fulfilled"
          ? {
              data: deploymentBuildRecordResult.value,
              error: null,
              loading: false,
            }
          : {
              ...current,
              error: errorMessage(deploymentBuildRecordResult?.reason),
              loading: false,
            },
      );
      setPackageRecords(() =>
        packageRecordsResult?.status === "fulfilled"
          ? {
              data: packageRecordsResult.value,
              error: null,
              loading: false,
            }
          : {
              data: null,
              error: errorMessage(packageRecordsResult?.reason),
              loading: false,
            },
      );
      const settingsSucceeded = results
        .slice(0, results.length - 1)
        .every((result) => result.status === "fulfilled");
      const currentUpdatePhase = useUpdateCheckStore.getState().phase;
      const updateWorkActive =
        currentUpdatePhase === "checking" ||
        currentUpdatePhase === "preparing" ||
        currentUpdatePhase === "review" ||
        currentUpdatePhase === "applying";
      if (
        !useAppsStore.getState().operationBusy &&
        !isAuthorityPendingState(useAppsStore.getState()) &&
        !updateWorkActive
      ) {
        await checkAppUpdates();
      }
      if (generation !== refreshGeneration.current) return;
      if (settingsSucceeded && nextIntegrityFence.status === "ready") {
        setLastSuccessfulRefresh(Date.now());
      }
    } finally {
      settingsRequestActive.current = false;
    }
  }, [canisterId]);

  useEffect(() => {
    void refresh();
    return () => {
      refreshGeneration.current += 1;
    };
  }, [refresh]);

  const installedModuleHashComparison = useMemo(() => {
    if (
      integrityRefreshFence.status !== "ready" ||
      !installedModuleHash.data ||
      installedModuleHash.error !== null ||
      !runtime.data ||
      runtime.error !== null ||
      deploymentBuildRecord.error !== null ||
      deploymentBuildRecord.data?.status !== "declared"
    ) {
      return null;
    }
    return compareInstalledModuleHash(
      installedModuleHash.data,
      runtime.data.deployment_id,
      deploymentBuildRecord.data.expectedModuleHash,
    );
  }, [
    deploymentBuildRecord.data,
    deploymentBuildRecord.error,
    installedModuleHash.data,
    installedModuleHash.error,
    integrityRefreshFence.status,
    runtime.data,
    runtime.error,
  ]);
  const deploymentRecordRuntimeError = useMemo(() => {
    if (
      integrityRefreshFence.status !== "ready" ||
      !runtime.data ||
      runtime.error !== null ||
      deploymentBuildRecord.error !== null ||
      deploymentBuildRecord.data?.status !== "declared"
    ) {
      return null;
    }
    return deploymentRecordRuntimeInconsistency(
      deploymentBuildRecord.data.record,
      runtime.data,
    );
  }, [
    deploymentBuildRecord.data,
    deploymentBuildRecord.error,
    integrityRefreshFence.status,
    runtime.data,
    runtime.error,
  ]);

  useEffect(() => {
    const recordNeedsAttention =
      deploymentBuildRecord.error !== null ||
      deploymentBuildRecord.data?.status === "invalid" ||
      deploymentBuildRecord.data?.status === "unavailable" ||
      integrityRefreshFence.status === "raced" ||
      integrityRefreshFence.status === "unavailable" ||
      deploymentRecordRuntimeError !== null ||
      installedModuleHashComparison?.status === "deployment_mismatch" ||
      installedModuleHashComparison?.status === "mismatch";
    if (runtime.error || installedModuleHash.error || recordNeedsAttention) {
      setRuntimeOpen(true);
    }
  }, [
    deploymentBuildRecord.data,
    deploymentBuildRecord.error,
    deploymentRecordRuntimeError,
    integrityRefreshFence.status,
    installedModuleHash.error,
    installedModuleHashComparison,
    runtime.error,
  ]);

  const rows = useMemo(
    () => settingsAppRows(apps, runtime.data),
    [apps, runtime.data],
  );
  const actionAppIdSet = useMemo(
    () => new Set(actionAppIds),
    [actionAppIds],
  );

  useEffect(() => {
    setActionAppIds((current) => {
      const next = current.filter(
        (appId) => appId !== "kernel" && apps[appId] !== undefined,
      );
      return next.length === current.length ? current : next;
    });
  }, [apps]);

  const toggleAppSelection = useCallback((appId: string) => {
    if (appId === "kernel") return;
    setActionAppIds((current) => {
      const selected = new Set(current);
      if (selected.has(appId)) selected.delete(appId);
      else selected.add(appId);
      return [...selected].sort();
    });
  }, []);
  const reconciliation = useMemo(() => {
    if (!runtime.data || registryStatus !== "ready") return null;
    try {
      return reconcileAppRegistry(apps, runtime.data);
    } catch (error) {
      return { ok: false, issues: [errorMessage(error)] };
    }
  }, [apps, registryStatus, runtime.data]);
  const capabilityReconciliation = useMemo<{
    data: ReconciledCapabilityInventory | null;
    error: string | null;
  }>(() => {
    if (capabilities.data === null || registryStatus !== "ready") {
      return { data: null, error: null };
    }
    try {
      return {
        data: reconcileCapabilityRegistry(apps, appInstances, capabilities.data),
        error: null,
      };
    } catch (error) {
      return { data: null, error: errorMessage(error) };
    }
  }, [appInstances, apps, capabilities.data, registryStatus]);
  const appUsageByScope = useMemo(
    () =>
      new Map(
        (appUsage.data?.apps ?? []).map((usage) => [
          appUsageScopeKey(usage.appId, usage.installationUid),
          usage,
        ]),
      ),
    [appUsage.data],
  );
  const dependencyGraph = useMemo(() => {
    try {
      return { error: null, plan: planAppRegistryDependencies(apps) };
    } catch (error) {
      return { error: errorMessage(error), plan: null };
    }
  }, [apps]);
  const dependencyImpacts = useMemo<Map<string, AppDependencyImpact>>(() => {
    const plan = dependencyGraph.plan;
    if (!plan) return new Map();
    return new Map(
      rows.map(({ id }) => [id, appDependencyImpact(plan, id)]),
    );
  }, [dependencyGraph.plan, rows]);
  const selectedDependencyNames = useMemo(() => {
    const names = new Set<string>();
    for (const appId of actionAppIds) {
      for (const { consumer } of dependencyImpacts.get(appId)?.direct ?? []) {
        if (!actionAppIdSet.has(consumer)) {
          names.add(apps[consumer]?.name ?? consumer);
        }
      }
    }
    return [...names].sort();
  }, [actionAppIds, actionAppIdSet, apps, dependencyImpacts]);
  const registryReconciled = reconciliation?.ok === true;
  const appActionsDisabled =
    appMutationBlocked ||
    capabilityOperation !== null ||
    registryStatus !== "ready" ||
    !registryReconciled;
  const selectionDisabledTitle = appMutationBlocked
    ? authorityPending
      ? "Finish or discard the pending installation first"
      : "Another app operation is in progress"
    : registryStatus !== "ready" || !registryReconciled
      ? "Refresh and reconcile app state before selecting apps"
      : "App actions are temporarily unavailable";
  const deleteSelectionTitle =
    actionAppIds.length > KERNEL_INSTALL_MAX_APP_REMOVALS_PER_COMMIT
      ? `Select at most ${KERNEL_INSTALL_MAX_APP_REMOVALS_PER_COMMIT} apps per deletion`
      : dependencyGraph.plan === null
        ? "Resolve app dependency metadata before deleting apps"
        : selectedDependencyNames.length > 0
          ? `Also select required dependents: ${selectedDependencyNames.join(", ")}`
          : `Delete ${actionAppIds.length} selected app${actionAppIds.length === 1 ? "" : "s"}`;
  const deleteSelectionDisabled =
    appActionsDisabled ||
    dependencyGraph.plan === null ||
    selectedDependencyNames.length > 0 ||
    actionAppIds.length > KERNEL_INSTALL_MAX_APP_REMOVALS_PER_COMMIT;
  const refreshing =
    snapshot.loading ||
    runtime.loading ||
    installedModuleHash.loading ||
    deploymentBuildRecord.loading ||
    integrityRefreshFence.status === "loading" ||
    packageRecords.loading ||
    backendReservations.loading ||
    scheduledTasks.loading ||
    capabilities.loading ||
    appUsage.loading ||
    provenance.loading ||
    updateCheckPhase === "checking" ||
    registryStatus === "loading";
  const deploymentBuildRecordView: DeploymentBuildRecordViewState =
    deploymentBuildRecord.data ??
    (deploymentBuildRecord.loading
      ? { status: "loading" }
      : {
          status: "unavailable",
          recordPath: DEPLOYMENT_BUILD_RECORD_PATH,
          message:
            deploymentBuildRecord.error ??
            "Deployment build record inspection did not return a result",
        });
  const integrityRefreshRace =
    integrityRefreshFence.status === "raced"
      ? {
          beforeDeploymentId: integrityRefreshFence.beforeDeploymentId,
          afterDeploymentId: integrityRefreshFence.afterDeploymentId,
        }
      : null;
  const integrityComparisonUnavailableMessage =
    integrityRefreshFence.status === "unavailable"
      ? `Could not fence the integrity refresh: ${integrityRefreshFence.message}`
      : deploymentBuildRecord.error
        ? `Deployment build record is unavailable: ${deploymentBuildRecord.error}`
        : installedModuleHash.error
          ? `Certified live module hash is unavailable: ${installedModuleHash.error}`
          : runtime.error
            ? `Runtime identity is unavailable: ${runtime.error}`
            : null;

  const uninstallSelected = async () => {
    if (actionAppIds.length === 0) return;
    try {
      const result = await uninstall_apps(actionAppIds);
      if (result) {
        setActionAppIds([]);
        await refresh();
      }
    } catch {
      // The shared operation dialog owns the actionable error.
    }
  };

  const refreshAfterUpdate = useCallback(async () => {
    setActionAppIds([]);
    await refresh();
  }, [refresh]);

  const revokeReservation = async (reservation: BackendCallReservation) => {
    await revokeBackendReservation(reservation);
    await refresh();
  };

  const setCapabilityEnabled = async (
    capability: CapabilitySummary,
    enabled: boolean,
  ) => {
    if (settingsRequestActive.current) return;
    settingsRequestActive.current = true;
    const key = capabilitySummaryKey(capability);
    setCapabilityOperation(key);
    setCapabilities((current) => ({ ...current, error: null }));
    try {
      const actor = await getNeutronCan();
      const updated = await setCapabilityRegistryEnabled(
        actor,
        capability,
        enabled,
      );
      // The update response proves the backend toggle and every specialized
      // reconciliation committed. Retire this app's local ports first, then
      // synchronously notify sibling tabs before doing any UI refresh work.
      const appsState = useAppsStore.getState();
      appsState.setApps(appsState.list, {
        appInstances: appsState.appInstances,
        invalidateAppIds: [capability.appId],
      });
      const deploymentId = committedFrontendDeploymentId();
      if (deploymentId) {
        announceRuntimeAuthorityChange({
          deploymentId,
          phase: "committed",
        });
      }
      // Do not rely on this tab receiving its own BroadcastChannel message.
      // Reconcile the authoritative runtime revision now; a failed query keeps
      // the fail-closed fence installed for the next monitor retry.
      await refreshRuntimeAuthority();
      setCapabilities((current) => ({
        data: current.data
          ? replaceCapabilitySummary(current.data, updated)
          : current.data,
        error: null,
        loading: false,
      }));
    } catch (reason) {
      setCapabilities((current) => ({
        ...current,
        error: errorMessage(reason),
      }));
    } finally {
      setCapabilityOperation(null);
      settingsRequestActive.current = false;
    }
  };

  return (
    <section
      aria-labelledby="settings-title"
      className="kernel-settings"
      data-tid="kernel-settings"
    >
      <div className="kernel-settings-inner">
        <header className="settings-header">
          <button
            aria-label="Back to workspace"
            autoFocus
            className="icon-button settings-back"
            data-tid="settings-back"
            onClick={onBack}
            title="Back to workspace"
            type="button"
          >
            <IoArrowBack aria-hidden="true" />
          </button>
          <div className="settings-heading">
            <h1 id="settings-title">Settings</h1>
            <span className="settings-refresh-time">
              {lastSuccessfulRefresh
                ? `Updated ${formatTimestamp(lastSuccessfulRefresh)}`
                : "System information"}
            </span>
          </div>
          <button
            aria-label="Refresh settings"
            className="icon-button settings-refresh"
            data-tid="settings-refresh"
            disabled={
              refreshing ||
              operationBusy ||
              capabilityOperation !== null
            }
            onClick={() => void refresh()}
            title="Refresh settings"
            type="button"
          >
            <IoRefresh aria-hidden="true" />
          </button>
        </header>

        <div className="settings-identity" data-tid="settings-identity">
          <IdentityValue label="Canister" value={canisterId} />
        </div>

        <SettingsSection title="System">
          {snapshot.error ? (
            <InlineError
              message={snapshot.error}
              onRetry={() => void refresh()}
            />
          ) : null}
          {snapshot.data ? (
            <dl className="settings-metric-grid" data-tid="settings-system">
              <Metric
                exact={formatTrillionCycles(snapshot.data.cycles_balance)}
                label="Cycle balance"
                value={formatTrillionCycles(snapshot.data.cycles_balance)}
              />
              <Metric
                exactBytes={snapshot.data.heap_size_bytes}
                label="Memory"
                value={formatBytes(snapshot.data.heap_size_bytes)}
              />
              {uiMode === "developer" ? (
                <>
                  <Metric
                    exactBytes={snapshot.data.stable_memory_bytes}
                    label="Stable memory"
                    value={formatBytes(snapshot.data.stable_memory_bytes)}
                  />
                  <Metric
                    exactBytes={snapshot.data.logical_stable_memory_bytes}
                    label="Logical stable memory"
                    value={formatBytes(
                      snapshot.data.logical_stable_memory_bytes,
                    )}
                  />
                </>
              ) : null}
            </dl>
          ) : snapshot.loading ? (
            <SectionLoading label="Loading system metrics" />
          ) : null}
        </SettingsSection>

        <AppUpdatesCoordinator
          fallbackFocusRef={installedAppsRef}
          onUpdated={refreshAfterUpdate}
          returnFocusRef={updateReturnFocusRef}
        />

        <SettingsSection
          count={rows.length}
          sectionRef={installedAppsRef}
          testId="settings-installed-apps"
          title="Installed Apps"
        >
          <AppInstallRecoveryPanel />
          <AppUpdatesFeedback />
          <AppUpdatesBulkAction
            deleteDisabled={deleteSelectionDisabled}
            deleteTitle={deleteSelectionTitle}
            disabled={appActionsDisabled}
            onDeleteSelected={() => void uninstallSelected()}
            returnFocusRef={updateReturnFocusRef}
            actionAppIds={actionAppIds}
          />
          {registryError ? (
            <InlineError
              message={registryError}
              onRetry={() => void refresh()}
            />
          ) : null}
          {reconciliation && !reconciliation.ok ? (
            <div className="settings-warning" role="alert">
              <strong>Registry and runtime are out of sync.</strong>
              <span>{reconciliation.issues.join(" ")}</span>
            </div>
          ) : null}
          {dependencyGraph.error ? (
            <div className="settings-warning" role="alert">
              <strong>App dependencies are inconsistent.</strong>
              <span>{dependencyGraph.error}</span>
            </div>
          ) : null}
          {scheduledTasks.error ? (
            <div className="settings-warning" role="alert">
              <strong>Scheduled-task status is unavailable.</strong>
              <span>{scheduledTasks.error}</span>
            </div>
          ) : null}
          {capabilities.error ? (
            <div className="settings-warning" role="alert">
              <strong>Capability status is unavailable.</strong>
              <span>{capabilities.error}</span>
            </div>
          ) : null}
          {capabilityReconciliation.error ? (
            <div className="settings-warning" role="alert">
              <strong>Capability inventory was rejected.</strong>
              <span>{capabilityReconciliation.error}</span>
            </div>
          ) : null}
          {provenance.error ? (
            <div className="settings-warning" role="alert">
              <strong>Install source records are unavailable.</strong>
              <span>{provenance.error}</span>
            </div>
          ) : null}
          {appUsage.error ? (
            <div className="settings-warning" role="alert">
              <strong>App cycle totals are unavailable.</strong>
              <span>
                {appUsage.data
                  ? `Showing the last successfully loaded totals. ${appUsage.error}`
                  : appUsage.error}
              </span>
            </div>
          ) : null}
          {registryStatus === "loading" && rows.length === 0 ? (
            <SectionLoading label="Loading installed apps" />
          ) : rows.length === 0 ? (
            <div className="settings-empty">No installed apps</div>
          ) : (
            <table
              aria-label="Installed apps"
              className="settings-app-list settings-app-table"
              data-tid="settings-app-list"
            >
              <colgroup>
                <col className="settings-app-column--app" />
                <col className="settings-app-column--cycles" />
                <col className="settings-app-column--cycles-in" />
                <col className="settings-app-column--update" />
                <col className="settings-app-column--version" />
                <col className="settings-app-column--details" />
                <col className="settings-app-column--selection" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">App</th>
                  <th scope="col">Cycles used</th>
                  <th scope="col">Cycles in</th>
                  <th scope="col">Update</th>
                  <th scope="col">Version</th>
                  <th scope="col"><span className="sr-only">Details</span></th>
                  <th scope="col"><span className="sr-only">Select</span></th>
                </tr>
              </thead>
              {rows.map(({ id, entry, memories, runtimeVersion }) => {
                const isKernel = id === "kernel";
                const dependencies =
                  dependencyGraph.plan?.dependenciesByConsumer[id] ?? [];
                const impact = dependencyImpacts.get(id) ?? {
                  direct: [],
                  transitiveConsumers: [],
                };
                const appProvenance = provenance.data?.apps[id];
                const legalInspection: InstalledPackageRecordInspection =
                  packageRecords.loading
                    ? LOADING_PACKAGE_RECORD
                    : packageRecords.data?.[id] ?? {
                        status: "unavailable",
                        recordPath: `${installedPackageAssetBasePath(id)}legal/package-record.v1.json`,
                        message:
                          packageRecords.error ??
                          "Installed package inspection did not return a result",
                      };
                const appInstance = appInstances[id];
                const usage: AppUsageCellState = isKernel
                  ? { kind: "system" }
                  : appUsage.data && appInstance
                    ? {
                        kind: "ready",
                        usage:
                          appUsageByScope.get(
                            appUsageScopeKey(
                              id,
                              appInstance.scope.installationUid,
                            ),
                          ) ?? null,
                      }
                    : appUsage.loading
                      ? { kind: "loading" }
                      : appUsage.error
                        ? { kind: "unavailable", message: appUsage.error }
                        : !appInstance
                          ? {
                              kind: "unavailable",
                              message: "Installation scope is unavailable",
                            }
                          : { kind: "ready", usage: null };
                return (
                  <AppSettingsEntry
                    backendReservations={(
                      backendReservations.data ?? []
                    ).filter(
                      (reservation) =>
                        reservation.appId === id &&
                        reservation.installationUid.toString() ===
                          appInstances[id]?.scope.installationUid,
                    )}
                    dependencies={dependencies}
                    dependents={impact.direct}
                    entry={entry}
                    id={id}
                    legalInspection={legalInspection}
                    uiMode={uiMode}
                    key={id}
                    memories={memories}
                    capabilityActionsDisabled={
                      refreshing ||
                      appMutationBlocked ||
                      capabilities.loading ||
                      capabilityOperation !== null ||
                      capabilityReconciliation.data === null
                    }
                    capabilityOperation={capabilityOperation}
                    capabilitySummaries={
                      capabilityReconciliation.data?.byApp[id] ?? []
                    }
                    {...(appProvenance ? { provenance: appProvenance } : {})}
                    onToggleSelected={() => toggleAppSelection(id)}
                    onRevokeReservation={(reservation) =>
                      void revokeReservation(reservation)
                    }
                    onSetCapabilityEnabled={(capability, enabled) =>
                      void setCapabilityEnabled(capability, enabled)
                    }
                    reservationActionsDisabled={
                      refreshing ||
                      appMutationBlocked ||
                      backendReservations.loading ||
                      capabilityOperation !== null
                    }
                    scheduledTasks={(scheduledTasks.data ?? []).filter(
                      (task) => task.app_id === id,
                    )}
                    registry={apps}
                    runtimeVersion={runtimeVersion}
                    transitiveDependentIds={impact.transitiveConsumers}
                    selected={actionAppIdSet.has(id)}
                    selectionDisabled={appActionsDisabled}
                    selectionTitle={
                      appActionsDisabled
                        ? selectionDisabledTitle
                        : actionAppIdSet.has(id)
                          ? `Deselect ${entry.name}`
                          : `Select ${entry.name} for app actions`
                    }
                    update={
                      <AppUpdateCell
                        appId={id}
                        appName={entry.name}
                        disabled={appActionsDisabled}
                        returnFocusRef={updateReturnFocusRef}
                        {...(entry.update_source
                          ? { updateSource: entry.update_source }
                          : {})}
                      />
                    }
                    usage={usage}
                  />
                );
              })}
            </table>
          )}
        </SettingsSection>

        <KernelUiModeSettings />

        <SettingsDisclosure
          description="Compiler, deployment, and memory details"
          icon={<IoHardwareChipOutline aria-hidden="true" />}
          id="settings-runtime"
          onToggle={() => setRuntimeOpen((open) => !open)}
          open={runtimeOpen}
          testId="settings-runtime-toggle"
          title="Runtime"
        >
          {runtime.error ? (
            <InlineError
              message={runtime.error}
              onRetry={() => void refresh()}
            />
          ) : null}
          {installedModuleHash.error ? (
            <DeploymentModuleHashError
              message={installedModuleHash.error}
              onRetry={() => void refresh()}
            />
          ) : null}
          {runtime.data ? (
            <dl className="settings-runtime-grid" data-tid="settings-runtime">
              <Detail label="Deployment" value={runtime.data.deployment_id} />
              <Detail label="Compiler" value={runtime.data.compiler_id} />
              <Detail label="Assembler" value={runtime.data.assembler_id} />
              {installedModuleHash.data ? (
                <DeploymentModuleHashDetail
                  hash={installedModuleHash.data.sha256}
                />
              ) : (
                <Detail
                  label="Installed canister Wasm SHA-256"
                  value={
                    installedModuleHash.loading ? "Loading…" : "Unavailable"
                  }
                />
              )}
              <Detail
                label="RTS"
                value={snapshot.data?.rts_version ?? "Unavailable"}
              />
              <Detail
                label="Installed apps"
                value={String(runtime.data.apps.length)}
              />
              <Detail
                label="Memory roots"
                value={String(runtime.data.memories.length)}
              />
              {snapshot.data ? (
                <>
                  <Detail
                    label="Maximum live heap"
                    title={`${formatExactNat(snapshot.data.max_live_size_bytes)} bytes`}
                    value={formatBytes(snapshot.data.max_live_size_bytes)}
                  />
                  <Detail
                    label="Allocated counter"
                    title={`${formatExactNat(snapshot.data.total_allocation_bytes)} bytes`}
                    value={formatBytes(snapshot.data.total_allocation_bytes)}
                  />
                  <Detail
                    label="Reclaimed counter"
                    title={`${formatExactNat(snapshot.data.reclaimed_bytes)} bytes`}
                    value={formatBytes(snapshot.data.reclaimed_bytes)}
                  />
                </>
              ) : null}
            </dl>
          ) : runtime.loading ? (
            <SectionLoading label="Loading runtime information" />
          ) : null}
          <DeploymentBuildRecordDetails
            comparison={
              deploymentRecordRuntimeError === null
                ? installedModuleHashComparison
                : null
            }
            comparisonUnavailableMessage={
              integrityComparisonUnavailableMessage
            }
            inspection={deploymentBuildRecordView}
            refreshRace={integrityRefreshRace}
            runtimeInconsistency={deploymentRecordRuntimeError}
          />
        </SettingsDisclosure>

        <AgentModeSettings />

        <VetKeysSettings currentPrincipal={principal} />

        <AccessSettings currentPrincipal={principal} />
      </div>
    </section>
  );
}

function SettingsSection({
  children,
  count,
  sectionRef,
  testId,
  title,
}: {
  children: ReactNode;
  count?: number;
  sectionRef?: RefObject<HTMLElement | null>;
  testId?: string;
  title: string;
}) {
  return (
    <section
      className="settings-section"
      data-tid={testId}
      ref={sectionRef}
      tabIndex={sectionRef ? -1 : undefined}
    >
      <div className="settings-section-heading">
        <h2>{title}</h2>
        {count === undefined ? null : <span>{count}</span>}
      </div>
      {children}
    </section>
  );
}

function IdentityValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="settings-identity-row">
      <span>{label}</span>
      <code title={value}>{value}</code>
      <CopyButton label={`Copy ${label.toLowerCase()}`} value={value} />
    </div>
  );
}

function Metric({
  exact,
  exactBytes,
  label,
  value,
}: {
  exact?: string;
  exactBytes?: NatValue;
  label: string;
  value: string;
}) {
  const title =
    exact ??
    (exactBytes === undefined
      ? undefined
      : `${formatExactNat(exactBytes)} bytes`);
  return (
    <div className="settings-metric" title={title}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Detail({
  label,
  title,
  value,
}: {
  label: string;
  title?: string;
  value: string;
}) {
  return (
    <div className="settings-detail" title={title}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function SectionLoading({ label }: { label: string }) {
  return (
    <div aria-label={label} className="settings-loading" role="status">
      <span className="loader" aria-hidden="true" />
    </div>
  );
}

function InlineError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="settings-inline-error" role="alert">
      <span>{message}</span>
      <button
        className="icon-button"
        onClick={onRetry}
        title="Retry"
        type="button"
      >
        <IoRefresh aria-label="Retry" />
      </button>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
