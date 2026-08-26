import { useEffect, useState, type ReactNode } from "react";
import {
  IoChevronDown,
  IoClose,
  IoCubeOutline,
  IoLockClosedOutline,
  IoTimeOutline,
  IoTrashOutline,
} from "react-icons/io5";
import type { BackendCallReservation } from "../backend_calls/service.ts";
import {
  publicIngressResourceId,
  type NeutronBrowserPermissionTileConfig,
  type NeutronCertifiedAssetsCapabilityConfig,
  type NeutronChainKeySigningSlotV1,
  type NeutronHttpsOutcallEndpointV1,
  type NeutronPublicIngressRouteV1,
  type NeutronStableStoreV1,
} from "neutron-tools/src/capabilities/catalog.js";
import type {
  AppRegistry,
  AppRegistryEntry,
  AppRegistryFunction,
  KernelRuntimeInfo,
} from "neutron-compiler/src/install.js";
import type {
  AppDependent,
  ResolvedAppDependency,
} from "neutron-compiler/src/app_dependencies.js";
import {
  BACKEND_CALL_PERSISTENCE_DISCLOSURE,
  BACKEND_RESERVATION_SCOPE_DISCLOSURES,
  BROWSER_PERMISSION_FEATURE_DISCLOSURES,
  BROWSER_PERMISSION_PERSISTENCE_DISCLOSURE,
  DEDICATED_RESIDENT_ORIGIN_DISCLOSURE,
  browserPermissionFeaturesTitle,
  browserPermissionRequestDisclosure,
  certifiedAssetsCollectionDisclosure,
  capabilityPlanPermissions,
  permissionLevel,
  type Permission,
} from "../lib/perm.ts";
import {
  formatBytes,
  formatExactNat,
  formatTrillionCycles,
  type NatValue,
} from "./format.ts";
import type { AppUsage, ScheduledTaskSummary } from "./model.ts";
import { AppUsagePanel } from "./AppUsagePanel.tsx";
import type { AppInstallProvenance } from "../repository/provenance.ts";
import { formatAppVersionLabel } from "neutron-tools/src/version.js";
import {
  capabilitySettings,
  declaredCapability,
  hasPersistentBackgroundStorage,
} from "../capabilities/plan.ts";
import {
  capabilitySummaryKey,
  type CapabilitySummary,
} from "./capability_registry.ts";
import type { KernelUiMode } from "../ui_mode.ts";
import { CertifiedAssetsSettingsControls } from "./CertifiedAssetsSettingsControls.tsx";
import { InstalledPackageLegalDetails } from "./InstalledPackageLegalDetails.tsx";
import type { InstalledPackageRecordInspection } from "./installed_package_record.ts";

export function AppSettingsEntry({
  backendReservations,
  capabilityActionsDisabled,
  capabilityOperation,
  capabilitySummaries,
  dependencies,
  dependents,
  entry,
  id,
  legalInspection,
  uiMode,
  usage,
  memories,
  onUninstall,
  onRevokeReservation,
  onSetCapabilityEnabled,
  provenance,
  reservationActionsDisabled,
  registry,
  runtimeVersion,
  scheduledTasks,
  transitiveDependentIds,
  uninstallDisabled,
  uninstallTitle,
  update,
}: {
  backendReservations: BackendCallReservation[];
  capabilityActionsDisabled: boolean;
  capabilityOperation: string | null;
  capabilitySummaries: readonly CapabilitySummary[];
  dependencies: ResolvedAppDependency[];
  dependents: AppDependent[];
  entry: AppRegistryEntry;
  id: string;
  legalInspection?: InstalledPackageRecordInspection;
  uiMode: KernelUiMode;
  usage: AppUsageCellState;
  memories: KernelRuntimeInfo["memories"];
  onUninstall: () => void;
  onRevokeReservation: (reservation: BackendCallReservation) => void;
  onSetCapabilityEnabled: (
    capability: CapabilitySummary,
    enabled: boolean,
  ) => void;
  provenance?: AppInstallProvenance;
  reservationActionsDisabled: boolean;
  registry: AppRegistry;
  runtimeVersion: NatValue | undefined;
  scheduledTasks: ScheduledTaskSummary[];
  transitiveDependentIds: string[];
  uninstallDisabled: boolean;
  uninstallTitle: string;
  update: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const isKernel = id === "kernel";
  const functions = entry.functions ?? [];
  const settings = capabilitySettings(entry);
  const connections =
    declaredCapability(entry, "connections")?.providers ?? [];
  const backendCalls = declaredCapability(entry, "backend_calls");
  const vetkeys = declaredCapability(entry, "vetkeys");
  const chainKeySigning = declaredCapability(entry, "chain_key_signing");
  const stableStore = declaredCapability(entry, "stable_store");
  const certifiedAssets = declaredCapability(entry, "certified_assets");
  const dedicatedResidentOrigin = declaredCapability(
    entry,
    "dedicated_resident_origin",
  );
  const browserPermissions = declaredCapability(entry, "browser_permissions");
  const preapprovedSelfCalls =
    declaredCapability(entry, "preapproved_self_calls")?.methods ?? [];
  const agentEntrypoints =
    declaredCapability(entry, "agent_entrypoints")?.entrypoints ?? [];
  const backgroundUiRequests =
    declaredCapability(entry, "background_ui_requests")?.categories ?? [];
  const ethereumProvider = declaredCapability(entry, "ethereum_provider");
  const publicRoutes = permissionsOf(
    capabilityPlanPermissions(entry.capability_plan),
    "http_route",
  );
  const certifiedReadRoutes = publicRoutes.filter(
    (route) => route.mode === "certified_store",
  );
  const publicPostRoutes = publicRoutes.filter(
    (route) => route.mode === "http_post_update_handler",
  );
  const httpsOutcalls = declaredCapability(entry, "https_outcalls");
  const publicIngressRoutes =
    declaredCapability(entry, "public_ingress")?.routes ?? [];
  const declaredScheduledTasks =
    declaredCapability(entry, "scheduled_tasks")?.tasks ?? [];
  const preapprovedMethods = new Set(
    preapprovedSelfCalls.map(({ method }) => method),
  );
  const capabilityCount = settings.entries.length;
  const certifiedAssetsSummary = capabilitySummaries.find(
    (summary) => summary.kind === "certified_assets",
  );
  const certifiedRouteSummaries = capabilitySummaries.filter(
    (summary) =>
      summary.kind === "certified_read_routes" &&
      certifiedReadRoutes.some(
        ({ id: mountId }) => mountId === summary.resourceId,
      ),
  );
  const detailsId = `settings-app-details-${id}`;

  return (
    <tbody
      className="settings-app-entry"
      data-app-id={id}
      data-tid={`settings-app-${id}`}
    >
      <tr className="settings-app-row">
        <th className="settings-app-cell settings-app-cell--app" scope="row">
          <div className="settings-app-summary">
            <AppIcon
              name={entry.name}
              src={entry.tiles[0]?.icon ?? entry.tray?.icon ?? null}
            />
            <div className="settings-app-main">
              <div className="settings-app-name">
                <strong>{entry.name}</strong>
                <small title="App-provided name — unverified">
                  App-provided
                </small>
              </div>
              <div
                className="settings-app-description"
                title={
                  entry.description
                    ? `App-provided description — unverified: ${entry.description}`
                    : "No description supplied"
                }
              >
                {entry.description || "No description supplied"}
              </div>
            </div>
          </div>
        </th>
        <td className="settings-app-cell settings-app-cell--cycles">
          <span className="settings-app-cell-label">Cycles used</span>
          <AppCyclesUsed state={usage} />
        </td>
        <td className="settings-app-cell settings-app-cell--cycles-in">
          <span className="settings-app-cell-label">Cycles in</span>
          <AppCyclesIn state={usage} />
        </td>
        <td className="settings-app-cell settings-app-cell--update">
          <span className="settings-app-cell-label">Updates</span>
          {update}
        </td>
        <td className="settings-app-cell settings-app-cell--version">
          <span className="settings-app-cell-label">Version</span>
          <span>{formatAppVersionLabel(entry.version)}</span>
        </td>
        <td className="settings-app-cell settings-app-cell--details">
          <span className="settings-app-cell-label">Details</span>
          <button
            aria-controls={detailsId}
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} details for ${entry.name}`}
            className="icon-button settings-app-details-toggle"
            data-tid={`settings-app-details-toggle-${id}`}
            onClick={() => setOpen((current) => !current)}
            title={`${open ? "Hide" : "Show"} app details`}
            type="button"
          >
            <IoChevronDown
              aria-hidden="true"
              className={open ? "is-open" : undefined}
            />
          </button>
        </td>
        <td className="settings-app-cell settings-app-cell--uninstall">
          <span className="settings-app-cell-label">Uninstall</span>
          {isKernel ? (
            <span
              aria-label="Neutron is the system app and cannot be uninstalled"
              className="settings-app-lock"
              role="img"
              title="Neutron is the system app and cannot be uninstalled"
            >
              <IoLockClosedOutline aria-hidden="true" />
            </span>
          ) : (
            <button
              aria-label={`Uninstall ${entry.name}`}
              className="icon-button settings-app-uninstall"
              data-tid={`settings-uninstall-${id}`}
              disabled={uninstallDisabled}
              onClick={onUninstall}
              title={uninstallTitle}
              type="button"
            >
              <IoTrashOutline aria-hidden="true" />
            </button>
          )}
        </td>
      </tr>

      <tr
        className="settings-app-details-row"
        data-tid={`settings-app-details-${id}`}
        hidden={!open}
        id={detailsId}
      >
        <td colSpan={7}>
          <div className="settings-app-details">
        {legalInspection ? (
          <InstalledPackageLegalDetails
            appId={id}
            inspection={legalInspection}
            {...(provenance
              ? { provenancePackageSha256: provenance.package_digest }
              : {})}
            uiMode={uiMode}
          />
        ) : null}
        {uiMode === "developer" ? (
          <>
        <dl className="settings-app-facts">
          <AppFact label="App ID" value={id} />
          <AppFact label="Manifest" value={`format ${entry.format}`} />
          <AppFact label="Package" value={formatAppVersionLabel(entry.version)} />
          <AppFact
            label="Updates"
            value={entry.update_source ?? "manual only"}
          />
          <AppFact
            label="Runtime"
            value={
              runtimeVersion === undefined
                ? "unknown"
                : formatAppVersionLabel(runtimeVersion)
            }
          />
          <AppFact label="Tiles" value={String(entry.tiles.length)} />
          <AppFact label="Tray" value={entry.tray ? "declared" : "none"} />
          <AppFact label="Functions" value={String(functions.length)} />
          <AppFact label="Memory roots" value={String(memories.length)} />
          <AppFact label="Capabilities" value={String(capabilityCount)} />
          <AppFact
            label="Capability plan"
            value={`v${settings.format} · ${settings.plan_fingerprint}`}
          />
          {provenance ? (
            <AppFact
              label="Source"
              value={
                provenance.kind === "repository"
                  ? "repository"
                  : provenance.kind === "update_source"
                    ? "update source"
                    : provenance.kind === "provisioned"
                      ? "provisioned"
                      : `manual ${provenance.acquisition}`
              }
            />
          ) : null}
        </dl>

        {provenance ? (
          <section
            aria-label="Verified install source"
            className="settings-app-provenance"
            data-tid={`settings-app-provenance-${id}`}
          >
            <h4>Install source and integrity</h4>
            <p>
              Certified record committed by the kernel with this app installation.
            </p>
            {provenance.kind === "repository" ? (
              <dl className="settings-app-facts">
                <AppFact label="Repository" value={provenance.repository} />
                <AppFact label="Manifest" value={provenance.manifest_id} />
                <AppFact
                  label="Manifest SHA-256"
                  value={provenance.manifest_digest}
                />
                <AppFact
                  label="Package SHA-256"
                  value={provenance.package_digest}
                />
              </dl>
            ) : provenance.kind === "update_source" ? (
              <dl className="settings-app-facts">
                <AppFact
                  label="Update source"
                  value={provenance.source_canister}
                />
                <AppFact
                  label="Release SHA-256"
                  value={provenance.release_digest}
                />
                <AppFact
                  label="Package SHA-256"
                  value={provenance.package_digest}
                />
                <AppFact
                  label="Checked"
                  value={new Date(provenance.checked_at).toLocaleString()}
                />
              </dl>
            ) : provenance.kind === "provisioned" ? (
              <dl className="settings-app-facts">
                <AppFact
                  label="Package SHA-256"
                  value={provenance.package_digest}
                />
              </dl>
            ) : (
              <dl className="settings-app-facts">
                <AppFact
                  label="Acquired from"
                  value={provenance.acquisition}
                />
                <AppFact
                  label="Package SHA-256"
                  value={provenance.package_digest}
                />
              </dl>
            )}
          </section>
        ) : null}

        {open && usage.kind === "ready" ? (
          <AppUsagePanel appId={id} usage={usage.usage} />
        ) : null}

        <div className="settings-app-detail-groups">
          {settings.entries.length > 0 ? (
            <AppDetailGroup
              count={settings.entries.length}
              title="Capability plan"
              wide
            >
              {settings.entries.map((capability) => {
                const routeIds =
                  capability.id === "http_routes"
                    ? new Set(publicPostRoutes.map(({ id: routeId }) => routeId))
                    : capability.id === "certified_read_routes"
                      ? new Set(
                          certifiedReadRoutes.map(({ id: routeId }) => routeId),
                        )
                      : null;
                const resources = capabilitySummaries.filter((summary) =>
                  routeIds
                    ? summary.kind === capability.id &&
                      routeIds.has(summary.resourceId)
                    : summary.kind === capability.id,
                );
                return (
                  <div
                    className="settings-capability-plan-entry"
                    key={capability.id}
                  >
                    <AppDetailItem
                      description={`${capability.summary} Quota: ${capability.quota} Audit: ${capability.audit}`}
                      fullDescription
                      meta={[
                        capability.id,
                        `${capability.provenance} · API ${capability.api}`,
                        capability.delivery.join(", ").replaceAll("_", " "),
                        `grant: ${policyLabel(capability.grant)}`,
                        `approval: ${policyLabel(capability.escalation)}`,
                        `disable: ${policyLabel(capability.disable)}`,
                        `revoke: ${policyLabel(capability.revocation)}`,
                      ]}
                      title={capability.title}
                    />
                    {capability.id === "http_routes" ? (
                      <HttpRouteSettingsDetails routes={publicPostRoutes} />
                    ) : null}
                    {capability.id === "certified_read_routes" ? (
                      <HttpRouteSettingsDetails routes={certifiedReadRoutes} />
                    ) : null}
                    {capability.id === "https_outcalls" && httpsOutcalls ? (
                      <HttpsOutcallsSettingsDetails
                        endpoints={httpsOutcalls.endpoints}
                      />
                    ) : null}
                    {capability.id === "chain_key_signing" && chainKeySigning ? (
                      <ChainKeySigningSettingsDetails
                        slots={chainKeySigning.slots}
                      />
                    ) : null}
                    {capability.id === "stable_store" && stableStore ? (
                      <StableStoreSettingsDetails stores={stableStore.stores} />
                    ) : null}
                    {capability.id === "certified_assets" && certifiedAssets ? (
                      <CertifiedAssetsSettingsDetails
                        config={certifiedAssets}
                      />
                    ) : null}
                    {capability.id === "public_ingress" ? (
                      <PublicIngressSettingsDetails routes={publicIngressRoutes} />
                    ) : null}
                    {capability.id === "browser_permissions" &&
                    browserPermissions ? (
                      <BrowserPermissionsSettingsDetails
                        tiles={browserPermissions.tiles}
                      />
                    ) : null}
                    {resources.map((resource) => (
                      <CapabilityRuntimeRow
                        activeGrantCount={
                          resource.kind === "backend_calls"
                            ? resource.enabled
                              ? backendReservations.length
                              : 0
                            : undefined
                        }
                        actionsDisabled={capabilityActionsDisabled}
                        capability={resource}
                        key={capabilitySummaryKey(resource)}
                        onSetEnabled={onSetCapabilityEnabled}
                        operation={capabilityOperation}
                      />
                    ))}
                  </div>
                );
              })}
            </AppDetailGroup>
          ) : null}

          {entry.tiles.length > 0 ? (
            <AppDetailGroup count={entry.tiles.length} title="Tiles">
              {entry.tiles.map((tile) => (
                <AppDetailItem
                  description={`App-provided title — unverified: ${tile.title}${
                    tile.description
                      ? `. App-provided description — unverified: ${tile.description}`
                      : ""
                  }`}
                  fullDescription
                  key={tile.id}
                  meta={[`tile id: ${tile.id}`, `path: ${tile.path}`]}
                  title={`Tile ${tile.id}`}
                  unverified
                />
              ))}
            </AppDetailGroup>
          ) : null}

          {entry.background ? (
            <AppDetailGroup count={1} title="Resident process">
              <AppDetailItem
                description={
                  dedicatedResidentOrigin
                    ? `This app uses an ${DEDICATED_RESIDENT_ORIGIN_DISCLOSURE}. Browser storage APIs may still exist inside that temporary partition, but it cannot read ordinary or persistent browser storage.`
                    : undefined
                }
                fullDescription={dedicatedResidentOrigin !== undefined}
                meta={[
                  entry.background.path,
                  hasPersistentBackgroundStorage(entry)
                    ? "persistent browser storage"
                    : dedicatedResidentOrigin
                      ? "ephemeral credential partition"
                      : "credentialless isolated origin",
                ]}
                title="Background endpoint"
              />
              {entry.background.description ? (
                <AppDetailItem
                  description={entry.background.description}
                  fullDescription
                  meta={["unverified", "not authority"]}
                  title="App-provided background description — unverified"
                  unverified
                />
              ) : null}
            </AppDetailGroup>
          ) : null}

          {entry.tray ? (
            <AppDetailGroup count={1} title="Tray">
              <AppDetailItem
                description="Shown in the kernel-owned top bar without an install permission. The resident process can change only its bounded numeric badge; the kernel owns the icon chrome, position, and popout limits."
                fullDescription
                meta={[`path: ${entry.tray.path}`, "transient sandboxed popout"]}
                title={`App-provided title — unverified: ${entry.tray.title}`}
                unverified
              />
            </AppDetailGroup>
          ) : null}

          {connections.length > 0 ? (
            <AppDetailGroup count={connections.length} title="Connections">
              {connections.map((connection) => (
                <AppDetailItem
                  description={
                    connection.scopes.length > 0
                      ? `Scopes: ${connection.scopes.join(", ")}`
                      : "No provider scopes requested"
                  }
                  key={connection.provider}
                  meta={["resident background credential"]}
                  title={connection.provider}
                />
              ))}
            </AppDetailGroup>
          ) : null}

          {backendCalls ? (
            <AppDetailGroup
              count={backendCalls.reservation_scopes.length}
              title="Backend capability"
            >
              <AppDetailItem
                description={`Installation granted no canister or method target. The app may ask later for persistent targets through a kernel-owned approval. ${BACKEND_CALL_PERSISTENCE_DISCLOSURE}`}
                fullDescription
                meta={[
                  `${backendCalls.max_concurrency} maximum calls in flight or per batch`,
                  `${formatTrillionCycles(backendCalls.max_cycles_per_call)} maximum gross attached per call`,
                  `${formatTrillionCycles(backendCalls.max_cycles_per_day)} maximum charged + unresolved per UTC day; refunds reopen dispatch-day headroom`,
                ]}
                title="Persistent outbound canister access"
              />
              {backendCalls.reservation_scopes.map((scope) => {
                const disclosure = BACKEND_RESERVATION_SCOPE_DISCLOSURES[scope];
                return (
                  <AppDetailItem
                    description={disclosure.meaning}
                    fullDescription
                    key={scope}
                    meta={[scope, disclosure.broad ? "broad scope" : "narrow scope"]}
                    title={disclosure.label}
                  />
                );
              })}
              <AppDetailItem
                description={backendCalls.description}
                fullDescription
                meta={["unverified", "not authority"]}
                title="App-provided explanation — unverified"
                unverified
              />
            </AppDetailGroup>
          ) : null}

          {vetkeys ? (
            <AppDetailGroup count={vetkeys.slots.length} title="Private-key slots">
              <AppDetailItem
                description="Declaration grants no key by itself. A focused tile must activate a slot. After activation, the app can recover its key on demand in its live tile or resident; recovery stays source-bound and spends canister cycles. Compatible updates inherit access; disabling cannot erase browser-held keys."
                fullDescription
                meta={["app-isolated", "threshold-derived"]}
                title="Kernel recovery policy"
              />
              {vetkeys.slots.map((slot) => (
                <AppDetailItem
                  description={`App-provided purpose — unverified: ${slot.purpose}`}
                  fullDescription
                  key={slot.id}
                  meta={["not yet a reserved key"]}
                  title={slot.id}
                  unverified
                />
              ))}
              <AppDetailItem
                description={vetkeys.description}
                fullDescription
                meta={["unverified", "not authority"]}
                title="App-provided explanation — unverified"
                unverified
              />
            </AppDetailGroup>
          ) : null}

          {declaredScheduledTasks.length > 0 ? (
            <AppDetailGroup
              count={declaredScheduledTasks.length}
              title="Scheduled tasks"
              wide
            >
              <div className="settings-scheduled-list">
                {declaredScheduledTasks.map((declared) => {
                  const task = scheduledTasks.find(
                    (candidate) =>
                      candidate.id === declared.id && candidate.app_id === id,
                  );
                  return (
                    <div className="settings-scheduled-row" key={declared.id}>
                      <span className="settings-scheduled-icon">
                        {task?.running ? (
                          <span className="settings-scheduled-spinner" />
                        ) : (
                          <IoTimeOutline aria-hidden="true" />
                        )}
                      </span>
                      <span className="settings-app-detail-item-main">
                        <strong>{declared.id}</strong>
                        <small>
                          {formatTaskInterval(declared.interval_seconds)} / {declared.method}
                        </small>
                      </span>
                      <span className="settings-app-detail-item-meta">
                        <code>{declared.max_backend_calls} calls</code>
                        {declared.run_on_start ? <code>runs on start</code> : null}
                        <code
                          title="Enable or disable this task for this app in the Capability plan above"
                        >
                          {task?.running
                            ? "running"
                            : task && !task.enabled
                              ? "disabled"
                              : task
                                ? "idle"
                                : "unavailable"}
                        </code>
                      </span>
                    </div>
                  );
                })}
              </div>
            </AppDetailGroup>
          ) : null}

          {ethereumProvider ? (
            <AppDetailGroup
              count={ethereumProvider.methods.length}
              title="Ethereum wallet"
            >
              {ethereumProvider.methods.map((method) => (
                <AppDetailItem
                  key={method}
                  meta={[
                    `chains ${ethereumProvider.chains.join(", ")}`,
                    method === "eth_sendTransaction" ? "transaction" : "RPC",
                  ]}
                  title={method}
                />
              ))}
            </AppDetailGroup>
          ) : null}

          {agentEntrypoints.length > 0 ? (
            <AppDetailGroup count={agentEntrypoints.length} title="Agent entrypoints">
              {agentEntrypoints.map((entrypoint) => (
                <AppDetailItem key={entrypoint} meta={[]} title={entrypoint} />
              ))}
            </AppDetailGroup>
          ) : null}

          {backgroundUiRequests.length > 0 ? (
            <AppDetailGroup
              count={backgroundUiRequests.length}
              title="Background attention"
            >
              {backgroundUiRequests.map((category) => (
                <AppDetailItem
                  key={category}
                  meta={[]}
                  title={category.replaceAll("_", " ")}
                />
              ))}
            </AppDetailGroup>
          ) : null}

          {dependencies.length > 0 ? (
            <AppDetailGroup count={dependencies.length} title="Requires">
              {dependencies.map((dependency) => (
                <AppDetailItem
                  description={`${dependency.provider} as ${dependency.alias}`}
                  key={dependency.alias}
                  meta={[
                    `${formatAppVersionLabel(dependency.minVersion)}+ / ${formatAppVersionLabel(dependency.providerVersion)} installed`,
                    dependency.functions.join(", "),
                  ]}
                  title={
                    registry[dependency.provider]?.name ?? dependency.provider
                  }
                />
              ))}
            </AppDetailGroup>
          ) : null}

          {dependents.length > 0 || transitiveDependentIds.length > 0 ? (
            <AppDetailGroup
              count={
                new Set([
                  ...dependents.map(({ consumer }) => consumer),
                  ...transitiveDependentIds,
                ]).size
              }
              title="Required by"
            >
              {dependents.map((dependent) => (
                <AppDetailItem
                  description={`${dependent.consumer} as ${dependent.alias}`}
                  key={`${dependent.consumer}:${dependent.alias}`}
                  meta={[
                    `requires v${dependent.minVersion}+`,
                    dependent.functions.join(", "),
                  ]}
                  title={
                    registry[dependent.consumer]?.name ?? dependent.consumer
                  }
                />
              ))}
              {transitiveDependentIds.map((consumerId) => (
                <AppDetailItem
                  description={consumerId}
                  key={`transitive:${consumerId}`}
                  meta={["transitive"]}
                  title={registry[consumerId]?.name ?? consumerId}
                />
              ))}
            </AppDetailGroup>
          ) : null}

          {backendReservations.length > 0 ? (
            <AppDetailGroup
              count={backendReservations.length}
              title="Backend access"
              wide
            >
              <div className="settings-reservation-list">
                {backendReservations.map((reservation) => (
                  <div
                    className="settings-reservation-row"
                    key={reservation.id.toString()}
                  >
                    <span className="settings-app-detail-item-main">
                      <strong>{reservationLabel(reservation)}</strong>
                      <small title={reservationDescription(reservation)}>
                        {reservationDescription(reservation)}
                      </small>
                    </span>
                    <span className="settings-app-detail-item-meta">
                      <code>{reservation.scopeKind}</code>
                      <code>
                        {formatCanisterTimestamp(reservation.createdAt)}
                      </code>
                    </span>
                    <button
                      aria-label={`Revoke backend access ${reservation.id}`}
                      className="icon-button settings-reservation-revoke"
                      disabled={reservationActionsDisabled}
                      onClick={() => onRevokeReservation(reservation)}
                      title="Revoke backend access"
                      type="button"
                    >
                      <IoClose aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            </AppDetailGroup>
          ) : null}

          {memories.length > 0 ? (
            <AppDetailGroup count={memories.length} title="Active memory">
              {memories.map((memory) => (
                <AppDetailItem
                  key={memory.id}
                  meta={[
                    `v${formatExactNat(memory.version)}`,
                    compactIdentifier(memory.schema),
                  ]}
                  metaTitles={[undefined, memory.schema]}
                  title={memory.id}
                />
              ))}
            </AppDetailGroup>
          ) : null}

          {functions.length > 0 ? (
            <AppDetailGroup
              count={functions.length}
              title="Backend functions"
              wide
            >
              <div className="settings-app-function-list">
                {functions.map((method) => (
                  <AppFunction
                    key={method.name}
                    method={method}
                    preapproved={preapprovedMethods.has(method.name)}
                  />
                ))}
              </div>
            </AppDetailGroup>
          ) : null}
        </div>
          </>
        ) : (
          <NormalAppDetails
            appId={id}
            appName={entry.name}
            backendReservations={backendReservations}
            capabilityActionsDisabled={capabilityActionsDisabled}
            capabilityOperation={capabilityOperation}
            capabilitySummaries={capabilitySummaries}
            dependencies={dependencies}
            dependents={dependents}
            entry={entry}
            isKernel={isKernel}
            onRevokeReservation={onRevokeReservation}
            onSetCapabilityEnabled={onSetCapabilityEnabled}
            provenance={provenance}
            registry={registry}
            reservationActionsDisabled={reservationActionsDisabled}
            scheduledTasks={scheduledTasks}
            transitiveDependentIds={transitiveDependentIds}
          />
        )}
        {uiMode === "developer" &&
          open &&
          certifiedAssets &&
          certifiedAssetsSummary ? (
          <CertifiedAssetsSettingsControls
            actionsDisabled={capabilityActionsDisabled}
            appId={id}
            appName={entry.name}
            capabilitySummary={certifiedAssetsSummary}
            manifest={certifiedAssets}
            open={open}
            routeSummaries={certifiedRouteSummaries}
          />
        ) : null}
          </div>
        </td>
      </tr>
    </tbody>
  );
}

function NormalAppDetails({
  appId,
  appName,
  backendReservations,
  capabilityActionsDisabled,
  capabilityOperation,
  capabilitySummaries,
  dependencies,
  dependents,
  entry,
  isKernel,
  onRevokeReservation,
  onSetCapabilityEnabled,
  provenance,
  registry,
  reservationActionsDisabled,
  scheduledTasks,
  transitiveDependentIds,
}: {
  appId: string;
  appName: string;
  backendReservations: BackendCallReservation[];
  capabilityActionsDisabled: boolean;
  capabilityOperation: string | null;
  capabilitySummaries: readonly CapabilitySummary[];
  dependencies: ResolvedAppDependency[];
  dependents: AppDependent[];
  entry: AppRegistryEntry;
  isKernel: boolean;
  onRevokeReservation: (reservation: BackendCallReservation) => void;
  onSetCapabilityEnabled: (
    capability: CapabilitySummary,
    enabled: boolean,
  ) => void;
  provenance: AppInstallProvenance | undefined;
  registry: AppRegistry;
  reservationActionsDisabled: boolean;
  scheduledTasks: ScheduledTaskSummary[];
  transitiveDependentIds: string[];
}) {
  const permissions = capabilityPlanPermissions(entry.capability_plan);
  const backendCalls = permissionsOf(permissions, "backend_calls")[0];
  const chainKeySigning = permissionsOf(permissions, "chain_key_signing")[0];
  const stableStore = permissionsOf(permissions, "stable_store")[0];
  const httpsOutcalls = permissionsOf(permissions, "https_outcalls")[0];
  const vetkeys = permissionsOf(permissions, "vetkeys")[0];
  const scheduled = permissionsOf(permissions, "scheduled_task");
  const agentEntrypoints = permissionsOf(permissions, "agent_entrypoint");
  const ethereumProvider = permissionsOf(permissions, "ethereum_provider")[0];
  const connections = permissionsOf(permissions, "connection");
  const publicIngress = permissionsOf(permissions, "public_ingress_route");
  const httpRoutes = permissionsOf(permissions, "http_route");
  const certifiedAssets = permissionsOf(permissions, "certified_assets")[0];
  const browserStorage = permissionsOf(
    permissions,
    "persistent_background_storage",
  )[0];
  const browserPermissions = permissionsOf(
    permissions,
    "browser_permissions",
  )[0];
  const browserPermissionTitle = browserPermissions
    ? browserPermissionFeaturesTitle(
        browserPermissions.tiles.flatMap(({ features }) => features),
      )
    : "Device access";
  const dedicatedResidentOrigin = declaredCapability(
    entry,
    "dedicated_resident_origin",
  );
  const controlsFor = (kind: CapabilitySummary["kind"]) =>
    capabilitySummaries.filter((summary) => summary.kind === kind);
  const relationshipNames = normalRelationshipNames(
    dependents,
    transitiveDependentIds,
    registry,
  );
  const hasMaterialAccess =
    permissions.some(isNormalMaterialPermission) ||
    backendReservations.length > 0 ||
    entry.background !== undefined;

  if (isKernel) {
    return (
      <div
        className="settings-app-normal"
        data-tid={`settings-app-normal-${appId}`}
      >
        <NormalAppIntro
          description="Neutron is the system app that runs the desktop and enforces app permissions."
          provenance={provenance}
        />
      </div>
    );
  }

  return (
    <div
      className="settings-app-normal"
      data-tid={`settings-app-normal-${appId}`}
    >
      <NormalAppIntro
        description="Neutron keeps this app in its own protected space. Access that reaches outside it or can run in the background is shown below."
        provenance={provenance}
      />

      {!hasMaterialAccess ? (
        <div className="settings-app-normal-safe" data-tid="settings-app-no-outside-access">
          <strong>No outside access</strong>
          <span>This app uses only isolated or per-action Neutron features.</span>
        </div>
      ) : null}

      <div className="settings-app-normal-grid">
        {browserPermissions ? (
          <NormalPermissionCard
            description="Declared open tiles can ask the browser for device access. Installing the app does not activate a device."
            kind="browser_permissions"
            title={browserPermissionTitle}
          >
            <div className="settings-app-normal-lines">
              {browserPermissions.tiles.flatMap(({ id, features }) =>
                features.map((feature) => (
                  <NormalPermissionLine
                    description={browserPermissionRequestDisclosure(
                      id,
                      feature,
                    )}
                    key={`${id}:${feature}`}
                    title={`${BROWSER_PERMISSION_FEATURE_DISCLOSURES[feature].title} · tile ${id}`}
                  />
                )),
              )}
              <NormalPermissionLine
                description={BROWSER_PERMISSION_PERSISTENCE_DISCLOSURE}
                title="Delegation lifetime"
              />
            </div>
          </NormalPermissionCard>
        ) : null}

        {backendCalls || backendReservations.length > 0 ? (
          <NormalPermissionCard
            description={normalBackendDescription(backendCalls)}
            kind="backend_calls"
            title="Other canisters"
            wide={backendReservations.length > 0}
          >
            <NormalCapabilityControls
              actionsDisabled={capabilityActionsDisabled}
              appName={appName}
              label={() => "Canister access"}
              onSetEnabled={onSetCapabilityEnabled}
              operation={capabilityOperation}
              summaries={controlsFor("backend_calls")}
            />
            <NormalBackendReservations
              actionsDisabled={reservationActionsDisabled}
              onRevoke={onRevokeReservation}
              reservations={backendReservations}
            />
          </NormalPermissionCard>
        ) : null}

        {httpsOutcalls ? (
          <NormalPermissionCard
            description="This app can send data to the services below. The destination and IC subnet replicas can read that data, and each request spends Neutron cycles."
            kind="https_outcalls"
            title="External services"
          >
            <NormalCapabilityControls
              actionsDisabled={capabilityActionsDisabled}
              appName={appName}
              detail={(summary) =>
                httpsOutcalls.endpoints
                  .find(({ id }) => id === summary.resourceId)
                  ?.methods.map((method) => method.toUpperCase())
                  .join(", ")
              }
              label={(summary) =>
                httpsOutcalls.endpoints.find(
                  ({ id }) => id === summary.resourceId,
                )?.urlPrefix ?? "External service"
              }
              onSetEnabled={onSetCapabilityEnabled}
              operation={capabilityOperation}
              summaries={controlsFor("https_outcalls")}
            />
          </NormalPermissionCard>
        ) : null}

        {chainKeySigning ? (
          <NormalPermissionCard
            description="This app can create cryptographic signatures without asking each time. A service may treat a signature as authorization, and each signature spends Neutron cycles."
            kind="chain_key_signing"
            title="Cryptographic signing"
          >
            <NormalCapabilityControls
              actionsDisabled={capabilityActionsDisabled}
              appName={appName}
              label={(_, index) => `Signing permission ${index + 1}`}
              onSetEnabled={onSetCapabilityEnabled}
              operation={capabilityOperation}
              summaries={controlsFor("chain_key_signing")}
            />
          </NormalPermissionCard>
        ) : null}

        {publicIngress.length > 0 || httpRoutes.length > 0 || certifiedAssets ? (
          <NormalPermissionCard
            description="These parts of the app are reachable without opening its tile. Update routes can change app data: inter-canister protocols require their declared base charge, while direct authenticated ingress spends this Neutron's cycles."
            kind="public_access"
            title="Public access"
            wide
          >
            <div className="settings-app-normal-lines">
              {publicIngress.map((route) => (
                <NormalPermissionLine
                  description={
                    route.mode === "update"
                      ? route.caller === "canister"
                        ? `A calling canister must fund the ${formatExactNat(route.requiredCycles)}-cycle base charge; calls below that base trap before app code runs. The app may request additional kernel-mediated cycles later in the call.`
                        : "A direct IC ingress call signed by a self-authenticating principal can run this update. Canister principals and anonymous ingress are rejected; the owner can disable the route."
                      : "Outside callers can read through this endpoint; it cannot change state."
                  }
                  key={`${route.protocol}:${route.method}`}
                  title={`${route.protocol} ${route.mode === "update" ? "updates" : "reads"}`}
                />
              ))}
              {httpRoutes.map((route) => (
                <NormalPermissionLine
                  description={
                    route.mode === "http_post_update_handler"
                      ? "Public requests can run app work and spend cycles."
                      : `${route.methods.join(", ")} serves fixed passive certified responses. ${
                          route.authorityMode === "exact_neutron_host_v1"
                            ? "Proofs are bound to the exact Neutron Host."
                            : "Proofs are portable across supported gateways for this canister; verifiers must still check the expected canister principal."
                        } Disabling this route hides object bodies behind its fixed certified 404 without deleting stored data.`
                  }
                  key={route.id}
                  title={
                    route.mode === "http_post_update_handler"
                      ? `Public requests at ${route.publicPath}`
                      : `Published data at ${route.publicPath}`
                  }
                />
              ))}
              {certifiedAssets && httpRoutes.length === 0 ? (
                <NormalPermissionLine
                  description="The app can publish data only beneath its Kernel-derived routes."
                  title="Published app content"
                />
              ) : null}
              {certifiedAssets ? (
                <>
                  <NormalPermissionLine
                    description={`Up to ${formatExactNat(certifiedAssets.maxEntries)} logical records and ${formatSettingsByteLimit(certifiedAssets.maxCommittedBytes)} committed. Each object is at most ${formatSettingsByteLimit(certifiedAssets.maxObjectBytes)}. Committed bodies are public plaintext, not encrypted.`}
                    title="Public plaintext limits"
                  />
                  <NormalPermissionLine
                    description={`${formatExactNat(certifiedAssets.maxPendingStages)} active upload stage; ${formatSettingsByteLimit(certifiedAssets.maxStagedBytes)} staged; batches up to ${formatExactNat(certifiedAssets.maxBatchOperations)} operations and ${formatSettingsByteLimit(certifiedAssets.maxBatchBytes)}.`}
                    title="Upload and batch limits"
                  />
                  <NormalPermissionLine
                    description={`${formatExactNat(certifiedAssets.maxIdempotencyReceipts)} general receipt lanes plus one revocation lane per committed record (${formatExactNat(certifiedAssets.maxEntries)} maximum; ${formatExactNat(certifiedAssets.maxEntries + certifiedAssets.maxIdempotencyReceipts)} charged lanes total). Outcomes reconcile retries for 24 hours.`}
                    title="Receipt and revocation limits"
                  />
                  {certifiedAssets.collections.map((collection) => {
                    const disclosure =
                      certifiedAssetsCollectionDisclosure(collection);
                    return (
                      <NormalPermissionLine
                        description={`${disclosure.locator}. ${disclosure.mutation}. ${disclosure.delivery}. Disabled or absent: ${disclosure.absence}.`}
                        key={collection.id}
                        title={`${disclosure.title} ${collection.id} · mount ${collection.mount}`}
                      />
                    );
                  })}
                  <NormalPermissionLine
                    description="Write freeze blocks positive record, byte, stage, and receipt growth but does not delete or hide existing public bodies; non-increasing CAS, conditional delete, abort, and cleanup remain available. Route disable is separate and stops serving object bodies behind a fixed certified 404 without deleting them."
                    title="Write freeze versus route disable"
                  />
                </>
              ) : null}
            </div>
            <NormalCapabilityControls
              actionsDisabled={capabilityActionsDisabled}
              appName={appName}
              detail={(summary) => {
                const route = publicIngress.find(
                  (candidate) =>
                    publicIngressResourceId(
                      candidate.protocol,
                      candidate.method,
                    ) === summary.resourceId,
                );
                return route?.mode === "update"
                  ? route.caller === "canister"
                    ? `Canister-paid · base charge ${formatExactNat(route.requiredCycles)} cycles`
                    : "Direct self-authenticating ingress · owner-funded"
                  : "Read only";
              }}
              label={(summary) => {
                const route = publicIngress.find(
                  (candidate) =>
                    publicIngressResourceId(
                      candidate.protocol,
                      candidate.method,
                    ) === summary.resourceId,
                );
                return route
                  ? `${route.protocol} public access`
                  : "Public protocol access";
              }}
              onSetEnabled={onSetCapabilityEnabled}
              operation={capabilityOperation}
              summaries={controlsFor("public_ingress")}
            />
            <NormalCapabilityControls
              actionsDisabled={capabilityActionsDisabled}
              appName={appName}
              detail={(summary) => {
                const route = httpRoutes.find(
                  (candidate) => candidate.id === summary.resourceId,
                );
                return route?.mode === "http_post_update_handler"
                  ? "Runs app work"
                  : "Public route toggle · hides bodies without deleting them";
              }}
              label={(summary) => {
                const route = httpRoutes.find(
                  (candidate) => candidate.id === summary.resourceId,
                );
                return route?.publicPath ?? "Public app route";
              }}
              onSetEnabled={onSetCapabilityEnabled}
              operation={capabilityOperation}
              summaries={[
                ...controlsFor("http_routes"),
                ...controlsFor("certified_read_routes"),
              ]}
            />
            <NormalCapabilityControls
              actionsDisabled={capabilityActionsDisabled}
              appName={appName}
              detail={() =>
                "Scoped publication authority. Runtime write freeze and public-read route visibility are separate controls below."
              }
              label={() => "Certified-assets capability"}
              onSetEnabled={onSetCapabilityEnabled}
              operation={capabilityOperation}
              summaries={controlsFor("certified_assets")}
            />
          </NormalPermissionCard>
        ) : null}

        {stableStore || browserStorage || vetkeys ? (
          <NormalPermissionCard
            description="These features keep app data or keys separated from other installed apps."
            kind="app_data"
            title="App data and keys"
          >
            <div className="settings-app-normal-lines">
              {stableStore ? (
                <NormalPermissionLine
                  description="Keeps data in isolated storage in this Neutron. The data is not encrypted; turning storage off pauses access without deleting it."
                  title="App storage"
                />
              ) : null}
              {browserStorage ? (
                <NormalPermissionLine
                  description="Keeps data in this app's isolated browser space. Turning it off blocks future app loads without erasing stored data."
                  title="Browser storage"
                />
              ) : null}
              {vetkeys ? (
                <NormalPermissionLine
                  description="Uses encrypted key slots isolated to this installation. Turning access off does not erase keys already held by the browser."
                  title="Private keys"
                />
              ) : null}
            </div>
            <NormalCapabilityControls
              actionsDisabled={capabilityActionsDisabled}
              appName={appName}
              label={(_, index) => `App storage ${index + 1}`}
              onSetEnabled={onSetCapabilityEnabled}
              operation={capabilityOperation}
              summaries={controlsFor("stable_store")}
            />
            <NormalCapabilityControls
              actionsDisabled={capabilityActionsDisabled}
              appName={appName}
              label={() => "Browser storage"}
              onSetEnabled={onSetCapabilityEnabled}
              operation={capabilityOperation}
              summaries={controlsFor("persistent_browser_storage")}
            />
            <NormalCapabilityControls
              actionsDisabled={capabilityActionsDisabled}
              appName={appName}
              label={(_, index) => `Private key access ${index + 1}`}
              onSetEnabled={onSetCapabilityEnabled}
              operation={capabilityOperation}
              summaries={controlsFor("vetkeys")}
            />
          </NormalPermissionCard>
        ) : null}

        {scheduled.length > 0 || entry.background ? (
          <NormalPermissionCard
            description="This app can stay active or run work without an open tile. It remains limited to the permissions shown here."
            kind="background_work"
            title="Runs automatically"
          >
            {entry.background ? (
              <div className="settings-app-normal-lines">
                <NormalPermissionLine
                  description={
                    dedicatedResidentOrigin
                      ? `Stays active while Neutron is open on an ${DEDICATED_RESIDENT_ORIGIN_DISCLOSURE}. This is separate from persistent browser storage; browser storage APIs may still exist inside the temporary partition.`
                      : browserStorage
                        ? "Stays active while Neutron is open with persistent browser storage."
                        : "Stays active while Neutron is open."
                  }
                  title="Background activity"
                />
              </div>
            ) : null}
            <NormalCapabilityControls
              actionsDisabled={capabilityActionsDisabled}
              appName={appName}
              detail={(summary) => {
                const task = scheduledTasks.find(
                  (candidate) => candidate.id === summary.resourceId,
                );
                return task?.running
                  ? "Running now"
                  : task && !task.enabled
                    ? "Disabled"
                    : undefined;
              }}
              label={(summary) => {
                const task = scheduled.find(
                  (candidate) => candidate.id === summary.resourceId,
                );
                return task
                  ? formatTaskInterval(task.intervalSeconds)
                  : "Scheduled work";
              }}
              onSetEnabled={onSetCapabilityEnabled}
              operation={capabilityOperation}
              summaries={controlsFor("scheduled_tasks")}
            />
          </NormalPermissionCard>
        ) : null}

        {connections.length > 0 || ethereumProvider ? (
          <NormalPermissionCard
            description="Connections still require their own approval before this app receives access."
            kind="connections"
            title="Connected services"
          >
            <div className="settings-app-normal-lines">
              {connections.map((connection) => (
                <NormalPermissionLine
                  description="Can keep approved access while the app runs in the background."
                  key={connection.provider}
                  title={connection.provider}
                />
              ))}
              {ethereumProvider ? (
                <NormalPermissionLine
                  description={
                    ethereumProvider.methods.includes("eth_sendTransaction")
                      ? "Can ask the wallet to submit transactions. The wallet still confirms each transaction."
                      : "Can ask for Ethereum wallet access; it cannot submit transactions."
                  }
                  title="Ethereum wallet"
                />
              ) : null}
            </div>
            <NormalCapabilityControls
              actionsDisabled={capabilityActionsDisabled}
              appName={appName}
              label={(summary) => summary.resourceId}
              onSetEnabled={onSetCapabilityEnabled}
              operation={capabilityOperation}
              summaries={controlsFor("connections")}
            />
          </NormalPermissionCard>
        ) : null}

        {agentEntrypoints.length > 0 ? (
          <NormalPermissionCard
            description="Authorized agents can use tools supplied by this app after agent access is approved."
            kind="agent_entrypoints"
            title="Agent tools"
          />
        ) : null}

        {controlsFor("randomness").length > 0 ? (
          <NormalPermissionCard
            description="This feature stays inside Neutron's brokered, app-specific limits."
            kind="isolated_features"
            title="Other app features"
          >
            <NormalCapabilityControls
              actionsDisabled={capabilityActionsDisabled}
              appName={appName}
              label={() => "Secure randomness"}
              onSetEnabled={onSetCapabilityEnabled}
              operation={capabilityOperation}
              summaries={controlsFor("randomness")}
            />
          </NormalPermissionCard>
        ) : null}

        {dependencies.length > 0 || relationshipNames.length > 0 ? (
          <NormalPermissionCard
            description="App relationships are limited to the installed apps shown here."
            kind="relationships"
            title="Works with"
            wide
          >
            <div className="settings-app-normal-lines">
              {dependencies.length > 0 ? (
                <NormalPermissionLine
                  description={normalAppNames(
                    dependencies.map(({ provider }) => provider),
                    registry,
                  ).join(", ")}
                  title="Uses"
                />
              ) : null}
              {relationshipNames.length > 0 ? (
                <NormalPermissionLine
                  description={`${relationshipNames.join(", ")} must be removed first.`}
                  title="Required by"
                />
              ) : null}
            </div>
          </NormalPermissionCard>
        ) : null}
      </div>
    </div>
  );
}

function NormalAppIntro({
  description,
  provenance,
}: {
  description: string;
  provenance: AppInstallProvenance | undefined;
}) {
  return (
    <div className="settings-app-normal-intro">
      <p>{description}</p>
      {provenance ? <span>{normalSourceLabel(provenance)}</span> : null}
    </div>
  );
}

function NormalPermissionCard({
  children,
  description,
  kind,
  title,
  wide = false,
}: {
  children?: ReactNode;
  description: string;
  kind: string;
  title: string;
  wide?: boolean;
}) {
  return (
    <section
      className={`settings-app-normal-card${wide ? " settings-app-normal-card--wide" : ""}`}
      data-permission-kind={kind}
    >
      <header>
        <h3>{title}</h3>
        <p>{description}</p>
      </header>
      {children}
    </section>
  );
}

function NormalPermissionLine({
  description,
  title,
}: {
  description: string;
  title: string;
}) {
  return (
    <div className="settings-app-normal-line">
      <strong>{title}</strong>
      <span>{description}</span>
    </div>
  );
}

function NormalCapabilityControls({
  actionsDisabled,
  appName,
  detail,
  label,
  onSetEnabled,
  operation,
  summaries,
}: {
  actionsDisabled: boolean;
  appName: string;
  detail?: (summary: CapabilitySummary, index: number) => string | undefined;
  label: (summary: CapabilitySummary, index: number) => string;
  onSetEnabled: (capability: CapabilitySummary, enabled: boolean) => void;
  operation: string | null;
  summaries: readonly CapabilitySummary[];
}) {
  if (summaries.length === 0) return null;
  return (
    <div className="settings-app-normal-controls">
      {summaries.map((summary, index) => {
        const key = capabilitySummaryKey(summary);
        const title = label(summary, index);
        const description = detail?.(summary, index);
        return (
          <div
            className="settings-app-normal-control"
            data-capability-kind={summary.kind}
            data-capability-resource={summary.resourceId}
            data-capability-status={summary.enabled ? "active" : "disabled"}
            key={key}
          >
            <span>
              <strong>{title}</strong>
              {description ? <small>{description}</small> : null}
            </span>
            <span
              className={`settings-app-normal-status${summary.enabled ? " is-active" : ""}`}
            >
              {summary.enabled ? "On" : "Off"}
            </span>
            {summary.toggleable ? (
              <button
                aria-checked={summary.enabled}
                aria-label={`${summary.enabled ? "Turn off" : "Turn on"} ${title} for ${appName}`}
                className={`settings-task-switch${summary.enabled ? " is-on" : ""}`}
                disabled={
                  actionsDisabled ||
                  operation === key
                }
                onClick={() => onSetEnabled(summary, !summary.enabled)}
                role="switch"
                type="button"
              >
                <span />
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function NormalBackendReservations({
  actionsDisabled,
  onRevoke,
  reservations,
}: {
  actionsDisabled: boolean;
  onRevoke: (reservation: BackendCallReservation) => void;
  reservations: readonly BackendCallReservation[];
}) {
  if (reservations.length === 0) {
    return <p className="settings-app-normal-empty">Nothing is approved yet.</p>;
  }
  return (
    <div className="settings-app-normal-reservations">
      <h4>Approved access</h4>
      {reservations.map((reservation) => (
        <div className="settings-app-normal-reservation" key={reservation.id.toString()}>
          <span>
            <strong>{normalReservationTitle(reservation)}</strong>
            <small>
              {reservation.scopeKind === "exact"
                ? "One exact method"
                : "Broad access"}
              {" · remains approved until revoked"}
            </small>
          </span>
          <button
            aria-label={`Revoke backend access ${reservation.id}`}
            className="icon-button settings-reservation-revoke"
            disabled={actionsDisabled}
            onClick={() => onRevoke(reservation)}
            title="Revoke backend access"
            type="button"
          >
            <IoClose aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}

function normalBackendDescription(
  permission: Extract<Permission, { kind: "backend_calls" }> | undefined,
): string {
  if (!permission) {
    return "This app has no declared way to request new canister access. Existing approvals remain visible until revoked.";
  }
  const transfer =
    permission.maxCyclesPerCall > 0
      ? ` It can transfer up to ${formatTrillionCycles(permission.maxCyclesPerCall)} per call and ${formatTrillionCycles(permission.maxCyclesPerDay)} per day.`
      : " It cannot transfer cycles with those calls.";
  return `This app can ask you to approve access to another canister. Installation alone grants no target.${transfer}`;
}

function normalReservationTitle(reservation: BackendCallReservation): string {
  if (reservation.scopeKind === "principal") {
    return `All methods on ${reservation.principal ?? "an unknown canister"}`;
  }
  if (reservation.scopeKind === "method") {
    return `${reservation.method ?? "One method"} on eligible canisters`;
  }
  return `${reservation.method ?? "One method"} on ${reservation.principal ?? "an unknown canister"}`;
}

function normalSourceLabel(provenance: AppInstallProvenance): string {
  if (provenance.kind === "repository") {
    return "Installed from a repository · package integrity verified";
  }
  if (provenance.kind === "update_source") {
    return "Installed from its update source · package integrity verified";
  }
  if (provenance.kind === "provisioned") {
    return "Installed during Neutron provisioning · package integrity verified";
  }
  return `Installed manually from a ${provenance.acquisition} · package identity recorded`;
}

function normalRelationshipNames(
  dependents: readonly AppDependent[],
  transitiveDependentIds: readonly string[],
  registry: AppRegistry,
): string[] {
  return normalAppNames(
    [
      ...dependents.map(({ consumer }) => consumer),
      ...transitiveDependentIds,
    ],
    registry,
  );
}

function normalAppNames(ids: readonly string[], registry: AppRegistry): string[] {
  return [...new Set(ids)].map((id) => registry[id]?.name ?? id);
}

function isNormalMaterialPermission(permission: Permission): boolean {
  if (
    permission.kind === "kernel_replacement" ||
    permission.kind === "kernel_memory_replacement" ||
    permission.kind === "memory_retirement"
  ) {
    return false;
  }
  if (permissionLevel(permission) >= 3) return true;
  return (
    permission.kind === "backend_calls" ||
    permission.kind === "https_outcalls" ||
    permission.kind === "public_ingress_route" ||
    permission.kind === "ethereum_provider" ||
    permission.kind === "connection"
  );
}

function permissionsOf<K extends Permission["kind"]>(
  permissions: readonly Permission[],
  kind: K,
): Array<Extract<Permission, { kind: K }>> {
  return permissions.filter(
    (permission): permission is Extract<Permission, { kind: K }> =>
      permission.kind === kind,
  );
}

export type AppUsageCellState =
  | Readonly<{ kind: "system" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "unavailable"; message: string }>
  | Readonly<{ kind: "ready"; usage: AppUsage | null }>;

export const UPDATE_EXECUTION_BASE_CYCLES_13_NODE = 5_000_000n;

export function combinedAppCycles(usage: AppUsage | null): bigint {
  return (
    (usage?.lifetimeInstructions ?? 0n) +
    (usage?.lifetimeExecutions ?? 0n) *
      UPDATE_EXECUTION_BASE_CYCLES_13_NODE +
    (usage?.lifetimeOutgoingCycles ?? 0n)
  );
}

function AppCyclesUsed({ state }: { state: AppUsageCellState }) {
  if (state.kind === "system") {
    return (
      <span title="The system app is not included in per-app usage telemetry">
        —
      </span>
    );
  }
  if (state.kind === "loading") {
    return (
      <span
        aria-label="Loading cycles used"
        className="settings-app-usage-loading"
      >
        <span aria-hidden="true" className="settings-app-update-spinner" />
      </span>
    );
  }
  if (state.kind === "unavailable") {
    return <span title={state.message}>Unavailable</span>;
  }

  const instructions = state.usage?.lifetimeInstructions ?? 0n;
  const executions = state.usage?.lifetimeExecutions ?? 0n;
  const outgoing = state.usage?.lifetimeOutgoingCycles ?? 0n;
  const executionBase =
    executions * UPDATE_EXECUTION_BASE_CYCLES_13_NODE;
  const exact = `${formatExactNat(instructions)} instructions at one cycle per instruction + ${formatExactNat(executionBase)} update execution base cycles (${formatExactNat(executions)} × 5,000,000) + ${formatExactNat(outgoing)} message, transfer, and call-base cycles`;
  return (
    <span
      aria-label={`${formatTrillionCycles(combinedAppCycles(state.usage))} cycles used; ${exact}`}
      className="settings-app-cycle-total"
      data-tid="settings-app-cycles-used"
      title={exact}
    >
      {formatTrillionCycles(combinedAppCycles(state.usage))}
    </span>
  );
}

function AppCyclesIn({ state }: { state: AppUsageCellState }) {
  if (state.kind === "system") {
    return (
      <span title="The system app is not included in per-app usage telemetry">
        —
      </span>
    );
  }
  if (state.kind === "loading") {
    return (
      <span
        aria-label="Loading cycles in"
        className="settings-app-usage-loading"
      >
        <span aria-hidden="true" className="settings-app-update-spinner" />
      </span>
    );
  }
  if (state.kind === "unavailable") {
    return <span title={state.message}>Unavailable</span>;
  }

  const incomingAccepted =
    state.usage?.lifetimeIncomingCyclesAccepted ?? 0n;
  const exact = `${formatExactNat(incomingAccepted)} cycles accepted by this installation through paid public ingress`;
  return (
    <span
      aria-label={`${formatTrillionCycles(incomingAccepted)} cycles in; ${exact}`}
      className="settings-app-cycle-total"
      data-tid="settings-app-cycles-in"
      title={exact}
    >
      {formatTrillionCycles(incomingAccepted)}
    </span>
  );
}

function AppIcon({ name, src }: { name: string; src: string | null }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [src]);

  return (
    <span className="settings-app-icon" aria-hidden="true" title={name}>
      {!src || failed ? (
        <IoCubeOutline />
      ) : (
        <img alt="" onError={() => setFailed(true)} src={src} />
      )}
    </span>
  );
}

function AppFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="settings-app-fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function AppDetailGroup({
  children,
  count,
  title,
  wide = false,
}: {
  children: ReactNode;
  count: number;
  title: string;
  wide?: boolean;
}) {
  return (
    <section
      className={
        wide
          ? "settings-app-detail-group settings-app-detail-group--wide"
          : "settings-app-detail-group"
      }
    >
      <header className="settings-app-detail-heading">
        <h3>{title}</h3>
        <code>{count}</code>
      </header>
      {children}
    </section>
  );
}

function AppDetailItem({
  description,
  fullDescription = false,
  meta,
  metaTitles = [],
  title,
  unverified = false,
}: {
  description?: string | undefined;
  fullDescription?: boolean;
  meta: string[];
  metaTitles?: Array<string | undefined>;
  title: string;
  unverified?: boolean;
}) {
  return (
    <div
      className={`settings-app-detail-item${
        unverified ? " settings-app-detail-item--unverified" : ""
      }${fullDescription ? " settings-app-detail-item--expanded" : ""}`}
      data-source={unverified ? "app" : undefined}
    >
      <span className="settings-app-detail-item-main">
        <strong>{title}</strong>
        {description ? <small title={description}>{description}</small> : null}
      </span>
      <span className="settings-app-detail-item-meta">
        {meta.map((value, index) => (
          <code key={`${value}-${index}`} title={metaTitles[index]}>
            {value}
          </code>
        ))}
      </span>
    </div>
  );
}

function HttpRouteSettingsDetails({
  routes,
}: {
  routes: readonly Extract<Permission, { kind: "http_route" }>[];
}) {
  return (
    <>
      {routes.map((route) => {
        const sharedPath = route.surface === "shared_app_path";
        return route.mode === "certified_store" ? (
          <AppDetailItem
            description={`Public certified read on Neutron’s ordinary shared path. ${
              route.authorityMode === "exact_neutron_host_v1"
                ? "The proof is bound to the exact Neutron Host."
                : "The proof is portable across supported gateways for this canister, but verifiers must still check the expected canister principal."
            } Only the collection kind’s fixed passive delivery policy is allowed. Disabling the route detaches object responses behind its fixed certified 404 without deleting stored bodies; write freeze is separate.`}
            fullDescription
            key={route.id}
            meta={[
              `mount ${route.id}`,
              "shared Neutron path",
              `${route.methods.join(", ")} ${route.publicPath}`,
              route.authorityMode.replaceAll("_", " "),
              "store certified_assets",
            ]}
            title="Shared certified read route"
          />
        ) : (
          <AppDetailItem
            description={
              sharedPath
                ? "Public anonymous update ingress on Neutron’s ordinary origin. Replies use fixed restrictive security headers. Each admitted request executes app backend code and spends Neutron cycles; forwarded headers are not a Neutron identity and matching completed replies replay for one hour."
                : "Public anonymous update ingress on this app’s dedicated host. Each admitted request executes app backend code and spends Neutron cycles, with no separate instruction allowance below the IC message limit. Forwarded headers are not a Neutron identity; matching completed replies replay for one hour."
            }
            fullDescription
            key={route.id}
            meta={[
              `mount ${route.id}`,
              sharedPath ? "shared Neutron path" : "dedicated app host",
              `POST ${route.publicPath} → ${route.handler}`,
              `request ≤ ${route.maxRequestBytes} bytes`,
              `reply ≤ ${route.maxResponseBytes} bytes`,
              `external limit ${route.maxCallsPerHour}/hour`,
              "Idempotency-Key required",
              route.forwardHeaders.length === 0
                ? "forwards no headers"
                : `forwards ${route.forwardHeaders.join(", ")}`,
            ]}
            title={sharedPath ? "Shared public POST handler" : "Public POST handler"}
          />
        );
      })}
    </>
  );
}

function BrowserPermissionsSettingsDetails({
  tiles,
}: {
  tiles: readonly NeutronBrowserPermissionTileConfig[];
}) {
  return (
    <>
      {tiles.flatMap(({ id, features }) =>
        features.map((feature) => (
          <AppDetailItem
            description={browserPermissionRequestDisclosure(id, feature)}
            fullDescription
            key={`${id}:${feature}`}
            meta={[
              `tile ${id}`,
              `feature ${feature}`,
              "browser decision remains authoritative",
            ]}
            title={BROWSER_PERMISSION_FEATURE_DISCLOSURES[feature].title}
          />
        )),
      )}
      <AppDetailItem
        description={BROWSER_PERMISSION_PERSISTENCE_DISCLOSURE}
        fullDescription
        meta={["structural declaration", "no runtime toggle"]}
        title="Delegation lifetime"
      />
    </>
  );
}

function HttpsOutcallsSettingsDetails({ endpoints }: {
  endpoints: readonly NeutronHttpsOutcallEndpointV1[];
}) {
  return (
    <>
      <AppDetailItem
        description="Paid replicated HTTPS. Request and response plaintext is visible to subnet replicas and each destination. Response headers are stripped, redirects are rejected, and no request is automatically retried."
        fullDescription
        meta={[
          "bounded concurrency and per-call cost safety",
          "live endpoint toggles below",
        ]}
        title="HTTPS transport policy"
      />
      {endpoints.map((endpoint) => (
        <AppDetailItem
          description={
            endpoint.methods.includes("post")
              ? "POST requires an idempotency key owned by the caller; the kernel injects its fixed header and never retries. The remote service must deduplicate."
              : "GET and HEAD require an empty body. HEAD replies expose no body."
          }
          fullDescription
          key={endpoint.id}
          meta={[
            `endpoint ${endpoint.id}`,
            endpoint.url_prefix,
            endpoint.methods.map((method) => method.toUpperCase()).join(", "),
            endpoint.request_headers.length === 0
              ? "no request headers"
              : `headers: ${endpoint.request_headers.join(", ")}`,
            `request ≤ ${endpoint.max_request_bytes} bytes`,
            `reply ≤ ${endpoint.max_response_bytes} bytes`,
            "response headers stripped",
          ]}
          title="External HTTPS endpoint"
        />
      ))}
    </>
  );
}

function ChainKeySigningSettingsDetails({ slots }: {
  slots: readonly NeutronChainKeySigningSlotV1[];
}) {
  return (
    <>
      <AppDetailItem
        description="The app may sign assertions it chooses without asking each time. A fixed app, installation, and slot domain prevents direct raw blockchain transaction signing, but a verifier may still treat an assertion as authorization. Every accepted signature spends shared Neutron cycles; an unknown outcome may still have produced a valid signature."
        fullDescription
        meta={[
          "bounded concurrency and per-call cost safety",
          "live slot toggles below",
        ]}
        title="Autonomous cryptographic assertions"
      />
      {slots.flatMap((slot) => [
        <AppDetailItem
          description="This is a compiler-bound assertion slot. Its algorithm, payload ceiling, and app/install/slot signing domain are fixed authority."
          fullDescription
          key={`authority:${slot.id}`}
          meta={[
            `slot ${slot.id}`,
            slot.algorithm,
            `assertion ≤ ${slot.max_assertion_bytes} bytes`,
          ]}
          title="Assertion-signing authority"
        />,
        <AppDetailItem
          description={slot.purpose}
          fullDescription
          key={`purpose:${slot.id}`}
          meta={[`slot ${slot.id}`, "not authority"]}
          title="App-provided purpose — unverified"
          unverified
        />,
      ])}
    </>
  );
}

function CertifiedAssetsSettingsDetails({
  config,
}: {
  config: NeutronCertifiedAssetsCapabilityConfig;
}) {
  const chargedReceiptLanes =
    config.max_entries + config.max_idempotency_receipts;
  return (
    <>
      <AppDetailItem
        description="Every committed body is deliberately public plaintext, not encrypted. General receipts and per-record revocation outcomes reconcile retries for 24 hours. Each committed record reserves one compact revocation lane."
        fullDescription
        meta={[
          `${formatExactNat(config.max_entries)} logical records`,
          `${formatSettingsByteLimit(config.max_committed_bytes)} committed`,
          `object ≤ ${formatSettingsByteLimit(config.max_object_bytes)}`,
          `${formatExactNat(config.max_pending_stages)} active stage`,
          `${formatSettingsByteLimit(config.max_staged_bytes)} staged`,
          `batch ≤ ${formatExactNat(config.max_batch_operations)} operations / ${formatSettingsByteLimit(config.max_batch_bytes)}`,
          `${formatExactNat(config.max_idempotency_receipts)} general receipts`,
          `${formatExactNat(config.max_entries)} revocation lanes`,
          `${formatExactNat(chargedReceiptLanes)} charged lanes total`,
          "24-hour reconciliation",
        ]}
        title="Certified public plaintext and manifest limits"
      />
      {config.collections.map((collection) => {
        const disclosure = certifiedAssetsCollectionDisclosure(collection);
        return (
          <AppDetailItem
            description={`${disclosure.locator}. ${disclosure.mutation}. ${disclosure.delivery}. Disabled or absent: ${disclosure.absence}.`}
            fullDescription
            key={collection.id}
            meta={[
              `collection ${collection.id}`,
              `mount ${collection.mount}`,
              disclosure.bodySource,
              `object ≤ ${formatSettingsByteLimit(
                collection.max_object_bytes ?? config.max_object_bytes,
              )}`,
            ]}
            title={disclosure.title}
          />
        );
      })}
      <AppDetailItem
        description="Write freeze blocks positive record, byte, stage, and receipt growth without deleting or hiding existing public bodies; non-increasing compare-and-swap, conditional delete, abort, and cleanup remain available. Route disable is a separate visibility control: it detaches object responses behind each collection kind’s fixed certified 404 without deleting stored bodies."
        fullDescription
        meta={[
          "write freeze: mutation admission",
          "route disable: public visibility",
          "lifecycle cleanup: kernel-owned",
        ]}
        title="Write freeze versus route disable"
      />
    </>
  );
}

function StableStoreSettingsDetails({
  stores,
}: {
  stores: readonly NeutronStableStoreV1[];
}) {
  return (
    <>
      <AppDetailItem
        description="Kernel-managed key/value blobs are isolated to this app installation. They are ordinary canister state, not encrypted or certified public content. Contents survive compatible upgrades and are purged with the installation. Reads and writes stop while an individual store is disabled."
        fullDescription
        meta={[
          `${stores.reduce((sum, store) => sum + store.max_entries, 0)} declared entries`,
          `${stores.reduce((sum, store) => sum + store.max_bytes, 0)} declared bytes`,
          "live store toggles below",
        ]}
        title="Durable backend storage policy"
      />
      {stores.flatMap((store) => [
        <AppDetailItem
          description="This logical namespace exposes bounded blob keys and values, revision-checked writes, schema-stamped records, and cursor pagination. It exposes no raw Region, stable-memory offset, or physical namespace."
          fullDescription
          key={`authority:${store.id}`}
          meta={[
            `store ${store.id}`,
            `schema ${store.schema_version}`,
            `${store.max_entries} entries`,
            `${store.max_bytes} bytes`,
            `key ≤ ${store.max_key_bytes} bytes`,
            `value ≤ ${store.max_value_bytes} bytes`,
          ]}
          title="Durable store authority"
        />,
        <AppDetailItem
          description={store.purpose}
          fullDescription
          key={`purpose:${store.id}`}
          meta={[`store ${store.id}`, "not authority"]}
          title="App-provided purpose — unverified"
          unverified
        />,
      ])}
    </>
  );
}

function formatSettingsByteLimit(value: number): string {
  return `${formatBytes(value)} (${formatExactNat(value)} bytes)`;
}

function PublicIngressSettingsDetails({
  routes,
}: {
  routes: readonly NeutronPublicIngressRouteV1[];
}) {
  return (
    <>
      {routes.map((route) => (
        <AppDetailItem
          description={
            route.mode === "update"
              ? route.caller === "canister"
                ? `Compiler-bound, canister-paid public update protocol. A calling canister must fund the ${formatExactNat(route.required_cycles)}-cycle base charge; calls below that base trap before app code runs. The kernel accepts and attributes that base to this app. It is not a total-cost cap: the app may request additional kernel-mediated cycles later in the call. Admitted calls may change canister state.`
                : "Compiler-bound direct authenticated IC ingress update. The kernel admits only self-authenticating caller principals, rejects anonymous and canister principals, accepts no base charge, and attributes the 13-node ingress-reception and self-handler call bases to this app. Admitted calls may change canister state."
              : "Compiler-bound public query ingress. Query calls do not change canister state."
          }
          fullDescription
          key={`${route.protocol}:${route.id}`}
          meta={[
            `${route.protocol}:${route.id}`,
            route.mode,
            `callers: ${route.caller}`,
            `request ≤ ${route.max_request_bytes} bytes`,
            `reply ≤ ${route.max_response_bytes} bytes`,
            ...(route.mode === "update"
              ? route.caller === "canister"
                ? [
                    `required base charge ${formatExactNat(route.required_cycles)} cycles`,
                    `external limit ${route.max_calls_per_hour}/hour`,
                    ...(route.max_calls_per_caller_per_hour === undefined
                      ? []
                      : [
                          `per caller ${route.max_calls_per_caller_per_hour}/hour`,
                        ]),
                  ]
                : [
                    "self-authenticating ingress only",
                    "no cycle payment accepted",
                    `external limit ${route.max_calls_per_hour}/hour`,
                    ...(route.max_calls_per_caller_per_hour === undefined
                      ? []
                      : [
                          `per caller ${route.max_calls_per_caller_per_hour}/hour`,
                        ]),
                  ]
              : []),
          ]}
          title="Public protocol endpoint"
        />
      ))}
    </>
  );
}

function CapabilityRuntimeRow({
  activeGrantCount,
  actionsDisabled,
  capability,
  onSetEnabled,
  operation,
}: {
  activeGrantCount: number | undefined;
  actionsDisabled: boolean;
  capability: CapabilitySummary;
  onSetEnabled: (capability: CapabilitySummary, enabled: boolean) => void;
  operation: string | null;
}) {
  const key = capabilitySummaryKey(capability);
  const changing = operation === key;
  const { usage } = capability;
  const last =
    usage.lastAt === null
      ? "No recorded operations"
      : `Last ${policyLabel(usage.lastOperation!)} · ${policyLabel(
          usage.lastOutcome!,
        )} · ${formatCanisterTimestamp(usage.lastAt)}`;
  return (
    <div
      className={`settings-capability-runtime-row${
        capability.toggleable ? "" : " is-fixed"
      }`}
      data-capability-kind={capability.kind}
      data-capability-resource={capability.resourceId}
      data-capability-status={capability.enabled ? "active" : "disabled"}
    >
      <span className="settings-app-detail-item-main">
        <strong>
          <span
            className={`settings-capability-status${
              capability.enabled ? " is-active" : ""
            }`}
          >
            {capability.enabled ? "Active" : "Disabled"} for this app
          </span>{" "}
          · {capability.resourceId}
        </strong>
        <small title={last}>{last}</small>
      </span>
      <span
        aria-label="Runtime operation counts"
        className="settings-app-detail-item-meta settings-capability-counters"
      >
        {activeGrantCount === undefined ? null : (
          <code>{activeGrantCount} active grants</code>
        )}
        <code>total {formatExactNat(usage.total)}</code>
        <code>success {formatExactNat(usage.succeeded)}</code>
        <code>denied {formatExactNat(usage.denied)}</code>
        <code>failed {formatExactNat(usage.failed)}</code>
        {capability.kind === "public_ingress" || capability.kind === "http_routes" ? (
          <code>rate {formatExactNat(usage.rateLimited)}</code>
        ) : null}
        <code>busy {formatExactNat(usage.busy)}</code>
        <code>revoked {formatExactNat(usage.revoked)}</code>
      </span>
      {capability.toggleable ? (
        <button
          aria-checked={capability.enabled}
          aria-label={`${capability.enabled ? "Disable" : "Enable"} ${capability.kind} resource ${capability.resourceId} for this app`}
          className={`settings-task-switch${capability.enabled ? " is-on" : ""}`}
          disabled={actionsDisabled || changing}
          onClick={() => onSetEnabled(capability, !capability.enabled)}
          role="switch"
          title={`${capability.enabled ? "Disable" : "Enable"} for this app`}
          type="button"
        >
          <span />
        </button>
      ) : null}
    </div>
  );
}

function AppFunction({
  method,
  preapproved,
}: {
  method: AppRegistryFunction;
  preapproved: boolean;
}) {
  return (
    <div className="settings-app-function-row">
      <code className="settings-app-function-name" title={method.name}>
        {method.name}
      </code>
      <span className="settings-app-function-meta">
        <span>{method.type}</span>
        <span className={`is-${method.access}`}>{method.access}</span>
        {preapproved ? <span>preapproved</span> : null}
        {method.expose === "apps" ? <span>apps</span> : null}
        {method.async === "sync" ? null : <span>{method.async}</span>}
        {method.args.map((arg) => (
          <code key={arg}>+{arg}</code>
        ))}
      </span>
    </div>
  );
}

function compactIdentifier(value: string): string {
  return value.length > 22
    ? `${value.slice(0, 10)}...${value.slice(-6)}`
    : value;
}

function policyLabel(value: string): string {
  return value.replaceAll("_", " ");
}

function reservationLabel(reservation: BackendCallReservation): string {
  if (reservation.scopeKind === "principal") return "Entire canister";
  if (reservation.scopeKind === "method") return `Method ${reservation.method}`;
  return reservation.method ?? "One canister method";
}

function reservationDescription(reservation: BackendCallReservation): string {
  if (reservation.scopeKind === "method") {
    return `One method on eligible non-system canisters except targets owned as whole canisters. This tier takes priority over exact grants. ${BACKEND_CALL_PERSISTENCE_DISCLOSURE}`;
  }
  if (reservation.scopeKind === "principal") {
    return `${reservation.principal ?? "Unknown canister"}. Every current and future method; this tier takes priority over method-wide and exact grants. ${BACKEND_CALL_PERSISTENCE_DISCLOSURE}`;
  }
  return `${reservation.principal ?? "Unknown canister"}. One exact method, effective only when no whole-canister or method-wide owner has priority. ${BACKEND_CALL_PERSISTENCE_DISCLOSURE}`;
}

function formatCanisterTimestamp(value: bigint): string {
  const milliseconds = value / 1_000_000n;
  const numeric = Number(milliseconds);
  return Number.isSafeInteger(numeric)
    ? new Date(numeric).toLocaleString()
    : value.toString();
}

function formatTaskInterval(seconds: number): string {
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return `every ${days} day${days === 1 ? "" : "s"}`;
  }
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return `every ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `every ${seconds} seconds`;
}
