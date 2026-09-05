import {
  appApprove,
  appReject,
  clearInstallError,
  resolveAppUninstall,
  useAppsStore,
  type AppInstallRequest,
  type AppCompiled,
  type AppOperation,
  type AppOperationPhase,
  type AppUninstallRequest,
} from "./reducer/apps.ts";
import { useEffect, useRef } from "react";
import { IoCheckmarkSharp, IoTrashOutline } from "react-icons/io5";
import { CAPABILITY_CATALOG } from "neutron-tools/src/capabilities/catalog.js";
import type { CapabilityPlanDiffV1 } from "neutron-tools/src/capabilities/wire.js";
import { formatAppVersionLabel } from "neutron-tools/src/version.js";
import {
  formatBytes,
  formatCycles,
  formatExactNat,
} from "./settings/format.ts";
import {
  BACKEND_CALL_PERSISTENCE_DISCLOSURE,
  BACKEND_RESERVATION_SCOPE_DISCLOSURES,
  BROWSER_PERMISSION_FEATURE_DISCLOSURES,
  BROWSER_PERMISSION_PERSISTENCE_DISCLOSURE,
  DEDICATED_RESIDENT_ORIGIN_DISCLOSURE,
  browserPermissionFeaturesTitle,
  browserPermissionRequestDisclosure,
  certifiedAssetsCollectionDisclosure,
  functionResourceLabel,
  permissionKey,
  permissionLevel,
  type FunctionMode,
  type Permission,
  type PermissionLevel,
} from "./lib/perm.ts";
import {
  ConsentTechnicalDetails,
  focusConsentControl,
  useConsentUiMode,
} from "./consent/ConsentPresentation.tsx";
import {
  getPermissionChangesForReview,
  PermissionConsequences,
} from "./consent/PermissionConsequences.tsx";
import { CapabilityChangeSummary } from "./consent/CapabilityChangeSummary.tsx";
import type { KernelUiMode } from "./ui_mode.ts";
import { DeploymentBuildReview } from "./install_review/DeploymentBuildReview.tsx";

export function AppDialogs() {
  return (
    <>
      <AppRequest />
      <AppUninstallRequest />
      <AppInstall />
    </>
  );
}

export function AppInstall() {
  const operation = useAppsStore((state) => state.operation);
  const error = useAppsStore((state) => state.installError);

  if (!operation && !error) return null;
  if (error) {
    const noun =
      error.kind === "install"
        ? "Installation"
        : error.kind === "update"
          ? "Update"
          : "Uninstall";
    return (
      <>
        <div className="backdrop"></div>
        <div
          aria-modal="true"
          className="dialog dialog-danger"
          data-tid="install-error"
          role="alertdialog"
        >
          <div className="title">{noun} failed</div>
          <div className="call">
            <div data-tid="install-error-message">{error.message}</div>
            <div className="btn-actions">
              <button
                type="button"
                className="btn"
                data-tid="install-error-close"
                onClick={() => clearInstallError()}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }
  if (!operation) return null;
  const labels = operationLabels(operation);
  const currentIndex = labels.findIndex(([phase]) => phase === operation.phase);

  return (
    <>
      <div className="backdrop"></div>
      <div
        aria-live="polite"
        aria-modal="true"
        className="dialog"
        data-operation-kind={operation.kind}
        data-tid="install-progress"
        role="dialog"
      >
        <div className="title">
          {operation.kind === "install"
            ? "Installing"
            : operation.kind === "update"
              ? "Updating"
              : "Uninstalling"}
        </div>
        <div className="install-progress">
          {labels.map(([phase, label], index) => {
            const complete = index < currentIndex || phase === "complete";
            const active = index === currentIndex && phase !== "complete";
            return (
              <div
                className={`install-progress-row${
                  index > currentIndex ? " install-progress-row--pending" : ""
                }`}
                key={phase}
              >
                <span className="install-progress-icon" aria-hidden="true">
                  {complete ? (
                    <IoCheckmarkSharp />
                  ) : active ? (
                    <span className="loader" />
                  ) : null}
                </span>
                <span className={complete ? "success" : undefined}>
                  {label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function AppUninstallRequest() {
  const request = useAppsStore((state) => state.uninstallRequest);
  if (!request) return null;
  return <AppUninstallRequestDialog request={request} />;
}

export function AppUninstallRequestDialog({
  request,
  uiMode: uiModeOverride,
}: {
  request: AppUninstallRequest;
  uiMode?: KernelUiMode;
}) {
  const uiMode = useConsentUiMode(uiModeOverride);
  const appCount = request.apps.length;
  const memories = request.apps.flatMap(({ appId, memoryIds }) =>
    memoryIds.map((memoryId) => ({ appId, memoryId })),
  );
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    focusConsentControl(cancelRef.current);
  }, [request]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      resolveAppUninstall(false);
      return;
    }
    if (event.key !== "Tab") return;
    const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
      'summary, button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (!controls?.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      <div className="backdrop" onClick={() => resolveAppUninstall(false)} />
      <div
        aria-describedby="uninstall-description"
        aria-labelledby="uninstall-title"
        aria-modal="true"
        className="dialog dialog-danger uninstall-dialog"
        data-tid="uninstall-dialog"
        onKeyDown={onKeyDown}
        ref={dialogRef}
        role="alertdialog"
      >
        <div className="title" id="uninstall-title">
          Uninstall {appCount === 1 ? "application" : "applications"}
        </div>
        <div className="call">
          <div className="a-infogrid uninstall-summary">
            <div className="label">
              {appCount === 1 ? "Application" : "Applications"}
            </div>
            <div className="val uninstall-app-list">
              {request.apps.map(({ appId, appName }) => (
                <div key={appId}>
                  <span>{appName}</span>
                  <code>{appId}</code>
                </div>
              ))}
            </div>
          </div>
          <div className="uninstall-warning" id="uninstall-description">
            This permanently removes the selected app
            {appCount === 1 ? "" : "s"}, owned memory, files, credentials,
            resident processes, and every open tile.
          </div>
          {memories.length > 0 ? (
            <div className="dialog-section">
              <div className="section-title">Owned memory</div>
              <div className="uninstall-memory-list">
                {memories.map(({ appId, memoryId }) => (
                  <code key={`${appId}/${memoryId}`}>
                    {appCount === 1 ? memoryId : `${appId}/${memoryId}`}
                  </code>
                ))}
              </div>
            </div>
          ) : null}
          <DeploymentBuildReview
            {...request.deploymentReview}
            uiMode={uiMode}
          />
          <div className="btn-actions uninstall-actions">
            <button
              className="btn btn-sec"
              data-tid="uninstall-cancel"
              onClick={() => resolveAppUninstall(false)}
              ref={cancelRef}
              type="button"
            >
              Cancel
            </button>
            <button
              className="btn btn-danger"
              data-tid="uninstall-confirm"
              onClick={() => resolveAppUninstall(true)}
              type="button"
            >
              <IoTrashOutline aria-hidden="true" />
              Uninstall{appCount === 1 ? "" : ` ${appCount} apps`}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function operationLabels(
  operation: AppOperation,
): [AppOperationPhase, string][] {
  if (operation.kind === "install") {
    return [
      ["staging", "Staging package files"],
      ["activating", "Activating application runtime"],
      ["cleaning", "Finalizing installation"],
      ["complete", "Installation complete"],
    ];
  }
  if (operation.kind === "update") {
    return [
      ["staging", "Staging updated package files"],
      ["activating", "Activating updated application runtime"],
      ["cleaning", "Finalizing update"],
      ["complete", "Update complete"],
    ];
  }
  return [
    ["preparing", "Preparing application removal"],
    ["staging", "Staging the replacement runtime"],
    ["activating", "Activating the replacement runtime"],
    ["cleaning", "Removing application data"],
    ["complete", "Uninstall complete"],
  ];
}

export function AppRequest() {
  const rq = useAppsStore((state) => state.request);
  const compiled = useAppsStore((state) => state.compiled);

  if (!rq) return null;
  return <AppRequestDialog compiled={compiled} request={rq} />;
}

export function AppRequestDialog({
  compiled,
  request: rq,
  uiMode: uiModeOverride,
}: {
  compiled: AppCompiled | null;
  request: AppInstallRequest;
  uiMode?: KernelUiMode;
}) {
  const uiMode = useConsentUiMode(uiModeOverride);
  const rejectRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    focusConsentControl(rejectRef.current);
    return () => previousFocus?.focus();
  }, [rq]);

  const maxPermissionLevel = rq.permissions.reduce(
    (max, permission) => Math.max(max, permissionLevel(permission)),
    0,
  );
  const dialogTone =
    maxPermissionLevel >= 3
      ? "dialog-danger"
      : maxPermissionLevel > 0
        ? "dialog-warning"
        : "";
  const acceptTone =
    maxPermissionLevel >= 3
      ? "btn-danger"
      : maxPermissionLevel > 0
        ? "btn-warning"
        : "";
  const backendCalls = rq.permissions.filter(
    (
      permission,
    ): permission is Extract<Permission, { kind: "backend_calls" }> =>
      permission.kind === "backend_calls",
  );
  const preapprovedSelfCalls = rq.permissions.filter(
    (
      permission,
    ): permission is Extract<Permission, { kind: "preapproved_self_call" }> =>
      permission.kind === "preapproved_self_call",
  );
  const publicMethods = rq.permissions.filter(
    (
      permission,
    ): permission is Extract<Permission, { kind: "public_method" }> =>
      permission.kind === "public_method",
  );
  const otherPermissions = rq.permissions.filter(
    (permission) =>
      permission.kind !== "backend_calls" &&
      permission.kind !== "preapproved_self_call" &&
      permission.kind !== "public_method",
  );
  const reviewPermissions = uiMode === "normal" && rq.operation === "update"
    ? getPermissionChangesForReview(rq.permissions, rq.capabilityPlanDiff)
    : rq.permissions;

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      appReject();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
      'summary, button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (!controls?.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      <div className="backdrop" onClick={() => appReject()}></div>
      <div
        aria-describedby="install-permission-summary"
        aria-labelledby="install-permission-title"
        aria-modal="true"
        className={`dialog install-permission-dialog ${dialogTone}`}
        data-tid="install-dialog"
        onKeyDown={onKeyDown}
        ref={dialogRef}
        role="alertdialog"
      >
        <h2 className="title" id="install-permission-title">
          {rq.operation === "update"
            ? "Update application"
            : "Install application"}
        </h2>

        <div className="call">
          <InstallDecisionSummary mode={uiMode} request={rq} />
          {rq.operation === "update" ? (
            <CapabilityChangeSummary diff={rq.capabilityPlanDiff} mode={uiMode} />
          ) : null}
          {rq.operation !== "update" || reviewPermissions.length > 0 ? (
            <PermissionConsequences mode={uiMode} permissions={reviewPermissions} />
          ) : null}
          <ConsentTechnicalDetails
            summary={
              uiMode === "developer" ? "Developer details" : "Technical details"
            }
          >
            {uiMode === "normal" ? (
              <p className="permission-copy">
                The app name comes from the package. Neutron checked the package
                structure, integrity, and executable rules, but has not verified
                who published it or endorsed its code.
              </p>
            ) : null}
            <div className="a-infogrid install-summary">
            <div className="label">Application</div>
            <div className="val">{rq.packageName}</div>
            <div className="label">App id</div>
            <div className="val">{rq.id}</div>
            <div className="label">Version</div>
            <div className="val">
              {formatAppVersionLabel(rq.packageVersion)}
            </div>
            <div className="label">Package size</div>
            <div className="val">{rq.size} kb</div>
            <div className="label">Package digest</div>
            <div className="val instance-id">{rq.packageDigest}</div>
            {rq.offer ? (
              <>
                <div className="label">Offered by</div>
                <div className="val">
                  {rq.offer.requester.kind === "agent"
                    ? `${rq.offer.requester.rootAppName} (${rq.offer.requester.rootAppId})`
                    : `${rq.offer.requester.appName} (${rq.offer.requester.appId})`}
                </div>
                <div className="label">Offer source</div>
                <div className="val principal">{rq.offer.source}</div>
                <div className="label">Initiated through</div>
                <div className="val">
                  {rq.offer.requester.kind === "agent"
                    ? "Agent tool"
                    : rq.offer.requester.surface === "tile"
                      ? "Application tile"
                      : rq.offer.requester.surface === "tray"
                        ? "Application tray"
                        : "Background process"}
                </div>
                {rq.offer.requester.kind === "agent" ? (
                  <>
                    <div className="label">Agent entrypoint</div>
                    <div className="val instance-id">
                      {rq.offer.requester.entrypoint}
                    </div>
                    <div className="label">Executing app</div>
                    <div className="val">
                        {rq.offer.requester.appName} ({rq.offer.requester.appId}
                        )
                    </div>
                    <div className="label">Scoped tool</div>
                    <div className="val instance-id">
                      {rq.offer.requester.tool}
                    </div>
                  </>
                ) : null}
              </>
            ) : null}
            <div className="label">Capability plan</div>
            <div
              className="val instance-id"
              title={rq.capabilityPlanFingerprint}
            >
              {rq.capabilityPlanFingerprint}
            </div>
          </div>
          {rq.operation === "update" ? (
            <CapabilityPlanChanges diff={rq.capabilityPlanDiff} />
          ) : null}
          <section
            aria-label="Kernel-verified capability plan"
            className="dialog-section"
          >
            <h3 className="section-title">
                Capability plan — kernel-verified (
                {rq.capabilityDisclosures.length})
            </h3>
            {rq.capabilityDisclosures.length > 0 ? (
              <div className="install-disclosure-list">
                {rq.capabilityDisclosures.map((disclosure) => (
                  <details
                    className="permission-item"
                    data-capability={disclosure.id}
                    key={disclosure.id}
                  >
                    <summary>
                      {disclosure.title} · {disclosure.provenance}
                    </summary>
                    <p className="permission-copy">{disclosure.summary}</p>
                    <p className="permission-copy">
                        Machine-enforced authority fields only. App-provided
                        prose is listed separately as unverified.
                    </p>
                    <pre className="permission-plan-config">
                      {JSON.stringify(
                        capabilityAuthorityConfig(disclosure.entry),
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                ))}
              </div>
            ) : (
              <div className="perm-green">No capability entries.</div>
            )}
          </section>
          {rq.permissions.length ? (
            <section
              aria-label="Kernel-verified requested access"
              className="dialog-section"
            >
              <h3 className="section-title">
                Requested access — kernel-verified ({rq.permissions.length})
              </h3>
              <div className="permission-list install-disclosure-list">
                {backendCalls.map((permission) => (
                  <BackendCallsDisclosure
                    key={permissionKey(permission)}
                    permission={permission}
                  />
                ))}
                {preapprovedSelfCalls.length > 0 ? (
                  <PreapprovedSelfCallsDisclosure
                    permissions={preapprovedSelfCalls}
                  />
                ) : null}
                {publicMethods.length > 0 ? (
                  <PublicMethodsDisclosure permissions={publicMethods} />
                ) : null}
                {otherPermissions.map((permission) => (
                  <PermissionDisclosure
                    key={permissionKey(permission)}
                    permission={permission}
                  />
                ))}
              </div>
            </section>
          ) : (
            <div className="perm-green">
              This application does not need any exceptional permissions.
            </div>
          )}
          {rq.appExplanations.length > 0 ? (
            <section
              aria-label="Unverified explanations supplied by the app"
              className="dialog-section app-explanation-section"
              data-source="app"
            >
              <h3 className="section-title">
                App-provided explanation — unverified
              </h3>
              <div className="app-explanation-note">
                  This text describes the app developer&apos;s intent. The
                  kernel does not verify it and does not use it to determine
                  access or risk.
              </div>
              <div className="app-explanation-list">
                {rq.appExplanations.map((explanation, index) => (
                  <div
                    className="app-explanation"
                    data-kind={explanation.kind}
                    key={`${explanation.kind}:${index}`}
                  >
                    {explanation.kind === "chain_key_signing_slot_purpose" ||
                    explanation.kind === "stable_store_purpose" ? (
                      <>
                        <strong>App-provided purpose — unverified</strong>
                        <br />
                        {explanation.text}
                      </>
                      ) : (
                        explanation.text
                      )}
                  </div>
                ))}
              </div>
            </section>
          ) : null}
          </ConsentTechnicalDetails>
          {compiled ? (
            <div data-tid="install-compiled">
              {uiMode === "developer" || !compiled.deploymentReview ? (
                <div className="compile-done">
                  {uiMode === "developer"
                    ? `Successfully compiled. Wasm size: ${compiled.size} kb`
                    : "Preparing installation review…"}
                </div>
              ) : null}
              {compiled.deploymentReview ? (
                <DeploymentBuildReview
                  {...compiled.deploymentReview}
                  uiMode={uiMode}
                />
              ) : null}
            </div>
          ) : (
            <div className="compile-loading" data-tid="install-compiling">
              <div className="loader" />
              <div>{uiMode === "developer" ? "Compiling..." : "Preparing app…"}</div>
            </div>
          )}
          <div className="btn-actions">
            <button
              type="button"
              className={`btn ${acceptTone}`}
              disabled={!compiled?.deploymentReview}
              data-tid="install-accept"
              onClick={() => {
                if (compiled?.deploymentReview) appApprove();
              }}
            >
              {rq.operation === "update" ? "Update" : "Install"}
            </button>
            <button
              type="button"
              className="btn btn-sec"
              data-tid="install-reject"
              onClick={() => appReject()}
              ref={rejectRef}
            >
              {uiMode === "developer" ? "Reject" : "Cancel"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function InstallDecisionSummary({
  mode,
  request,
}: {
  mode: KernelUiMode;
  request: AppInstallRequest;
}) {
  return (
    <div className="consent-install-summary" id="install-permission-summary">
      <div>
        <strong>{request.packageName}</strong>
        <span>{formatAppVersionLabel(request.packageVersion)}</span>
      </div>
      {mode === "developer" ? (
        <p>
          The app name comes from the package. Neutron checked the package
          structure, integrity, and executable rules, but has not verified who
          published it or endorsed its code.
        </p>
      ) : null}
      {request.offer ? (
        <p>
          Offered by{" "}
          <strong>
            {request.offer.requester.kind === "agent"
              ? request.offer.requester.rootAppName
              : request.offer.requester.appName}
          </strong>{" "}
          from{" "}
          <span className="consent-source-host">{request.offer.source}</span>.
        </p>
      ) : (
        <p>
          {request.acquisition === "url"
            ? "From the download link you entered."
            : "From a package file on this device."}
        </p>
      )}
      {mode === "normal" ? <p>Only install apps from a source you trust.</p> : null}
    </div>
  );
}

function CapabilityPlanChanges({
  diff,
}: {
  diff: CapabilityPlanDiffV1 | undefined;
}) {
  return (
    <section
      aria-label="Kernel-verified capability changes"
      className="dialog-section"
      data-tid="install-capability-diff"
    >
      <h3 className="section-title">
        Capability changes — kernel-verified
        {diff ? ` (${diff.entries.length})` : ""}
      </h3>
      {!diff ? (
        <div className="settings-warning" role="alert">
          The installed capability plan is unavailable for comparison.
        </div>
      ) : (
        <>
          <div className="a-infogrid install-summary">
            <div className="label">Installed plan</div>
            <div
              className="val instance-id"
              title={diff.previous.plan_fingerprint}
            >
              {formatAppVersionLabel(diff.previous.version)} ·{" "}
              {diff.previous.plan_fingerprint}
            </div>
            <div className="label">Target plan</div>
            <div
              className="val instance-id"
              title={diff.target.plan_fingerprint}
            >
              {formatAppVersionLabel(diff.target.version)} ·{" "}
              {diff.target.plan_fingerprint}
            </div>
          </div>
          <p className="permission-copy">
            This is an exact structural comparison. Changed entries show both
            enforced configurations; the kernel does not guess that a JSON
            change is narrower or safer.
          </p>
          {diff.entries.length === 0 ? (
            <div className="perm-green">
              No capability authority entries changed.
            </div>
          ) : (
            <div className="install-disclosure-list">
              {diff.entries.map((change) => (
                <details
                  className="permission-item"
                  data-capability={change.id}
                  data-change={change.change}
                  key={change.id}
                >
                  <summary>
                    {changeLabel(change.change)} ·{" "}
                    {CAPABILITY_CATALOG[change.id].title}
                  </summary>
                  {change.before ? (
                    <CapabilityDiffConfig
                      entry={change.before}
                      label="Installed authority config"
                    />
                  ) : null}
                  {change.after ? (
                    <CapabilityDiffConfig
                      entry={change.after}
                      label="Target authority config"
                    />
                  ) : null}
                </details>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function CapabilityDiffConfig({
  entry,
  label,
}: {
  entry: NonNullable<CapabilityPlanDiffV1["entries"][number]["before"]>;
  label: string;
}) {
  return (
    <>
      <div className="permission-fact-label">{label}</div>
      <pre className="permission-plan-config">
        {JSON.stringify(capabilityAuthorityConfig(entry), null, 2)}
      </pre>
    </>
  );
}

function changeLabel(
  change: CapabilityPlanDiffV1["entries"][number]["change"],
): string {
  if (change === "added") return "Added";
  if (change === "removed") return "Removed";
  return "Changed";
}

function capabilityAuthorityConfig(
  entry: AppInstallRequest["capabilityDisclosures"][number]["entry"],
): unknown {
  switch (entry.id) {
    case "backend_calls":
      return {
        api: entry.config.api,
        reservation_scopes: entry.config.reservation_scopes,
        ...(entry.config.install_reservations
          ? { install_reservations: entry.config.install_reservations }
          : {}),
        max_concurrency: entry.config.max_concurrency,
        max_cycles_per_call: entry.config.max_cycles_per_call,
        max_cycles_per_day: entry.config.max_cycles_per_day,
      };
    case "randomness":
      return {
        api: entry.config.api,
      };
    case "chain_key_signing":
      return {
        api: entry.config.api,
        slots: entry.config.slots.map((slot) => ({
          id: slot.id,
          algorithm: slot.algorithm,
          max_assertion_bytes: slot.max_assertion_bytes,
        })),
      };
    case "https_outcalls":
      return {
        api: entry.config.api,
        endpoints: entry.config.endpoints.map((endpoint) => ({
          id: endpoint.id,
          url_prefix: endpoint.url_prefix,
          methods: endpoint.methods,
          request_headers: endpoint.request_headers,
          max_request_bytes: endpoint.max_request_bytes,
          max_response_bytes: endpoint.max_response_bytes,
          transform: endpoint.transform,
        })),
      };
    case "stable_store":
      return {
        api: entry.config.api,
        stores: entry.config.stores.map((store) => ({
          id: store.id,
          schema_version: store.schema_version,
          max_entries: store.max_entries,
          max_key_bytes: store.max_key_bytes,
          max_value_bytes: store.max_value_bytes,
          max_bytes: store.max_bytes,
        })),
      };
    case "vetkeys":
      return {
        api: entry.config.api,
        slots: entry.config.slots.map(({ id }) => ({ id })),
      };
    default:
      return entry.config;
  }
}

type BackendCallsPermission = Extract<Permission, { kind: "backend_calls" }>;
type PreapprovedSelfCallPermission = Extract<
  Permission,
  { kind: "preapproved_self_call" }
>;
type PublicMethodPermission = Extract<Permission, { kind: "public_method" }>;

function PermissionFrame({
  children,
  kind,
  level,
}: {
  children: React.ReactNode;
  kind: Permission["kind"] | "preapproved_self_calls" | "public_methods";
  level: PermissionLevel;
}) {
  return (
    <div
      className={`permission-group perm-level-${level}`}
      data-kind={kind}
      data-source="kernel"
      tabIndex={0}
    >
      {children}
    </div>
  );
}

function BackendCallsDisclosure({
  permission,
}: {
  permission: BackendCallsPermission;
}) {
  return (
    <PermissionFrame kind={permission.kind} level={permissionLevel(permission)}>
      <h4 className="permission-group-title">Persistent backend-call grants</h4>
      <p className="permission-copy">
        {permission.installReservations?.length
          ? "Accepting this installation creates the exact persistent grants listed below. The app may request other declared grants later."
          : "This app may later ask for persistent outbound access to canister targets. Installation itself grants no canister or method target."}
      </p>
      {permission.installReservations?.length ? (
        <>
          <div className="permission-fact-label">
            Grants created during installation (
            {permission.installReservations.length})
          </div>
          <ul className="permission-inventory">
            {permission.installReservations.map((reservation) => (
              <li
                data-scope={reservation.kind}
                key={`${reservation.kind}:${
                  "principal" in reservation ? reservation.principal : ""
                }:${"method" in reservation ? reservation.method : ""}`}
              >
                <code>{reservation.kind}</code>
                <span>
                  {"principal" in reservation
                    ? reservation.principal
                    : "Any eligible non-system canister"}
                  {"method" in reservation
                    ? ` · ${reservation.method}`
                    : " · every method"}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <div className="permission-fact-label">
        Allowed reservation modes ({permission.reservationScopes.length})
      </div>
      <ul className="permission-inventory">
        {permission.reservationScopes.map((scope) => {
          const disclosure = BACKEND_RESERVATION_SCOPE_DISCLOSURES[scope];
          return (
            <li
              className={disclosure.broad ? "permission-broad-scope" : ""}
              data-scope={scope}
              key={scope}
            >
              <code>{scope}</code>
              <span>
                <strong>{disclosure.label}:</strong> {disclosure.meaning}.
                {disclosure.broad ? " This is a broad reservation mode." : ""}
              </span>
            </li>
          );
        })}
      </ul>
      <dl className="permission-facts">
        <div>
          <dt>Maximum concurrency</dt>
          <dd>{permission.maxConcurrency} calls in flight or in one batch</dd>
        </div>
        <div>
          <dt>Stored grants</dt>
          <dd>Not limited by the concurrency value</dd>
        </div>
        <div>
          <dt>Maximum attached per call</dt>
          <dd>{formatCycles(permission.maxCyclesPerCall)}</dd>
        </div>
        <div>
          <dt>Maximum charged + unresolved per UTC day</dt>
          <dd>{formatCycles(permission.maxCyclesPerDay)}</dd>
        </div>
      </dl>
      <p className="permission-copy">
        Every target not granted during installation still requires later kernel
        approval unless an equivalent valid grant already exists. A matching
        grant authorizes repeated calls with app-chosen arguments.
      </p>
      <p className="permission-copy permission-persistence">
        {BACKEND_CALL_PERSISTENCE_DISCLOSURE}
      </p>
      <p className="permission-copy permission-persistence">
        The per-call ceiling applies to gross cycles attached. The daily ceiling
        counts cycles still charged or unresolved on their original dispatch
        day; an observed refund reopens that day&apos;s headroom. Neither
        includes ordinary compute or call execution cost. A zero per-call
        ceiling means backend calls cannot attach cycles.
      </p>
    </PermissionFrame>
  );
}

function PreapprovedSelfCallsDisclosure({
  permissions,
}: {
  permissions: readonly PreapprovedSelfCallPermission[];
}) {
  return (
    <PermissionFrame kind="preapproved_self_calls" level={2}>
      <h4 className="permission-group-title">
        Preapproved same-app calls ({permissions.length})
      </h4>
      <p className="permission-copy">
        A live tile or background belonging to this exact app may ask the kernel
        to sign these same-canister calls without another owner prompt.
      </p>
      <ul className="permission-inventory permission-method-inventory">
        {permissions.map((permission) => (
          <li
            className={
              permission.mode === "update" ? "permission-update-method" : ""
            }
            data-mode={permission.mode}
            key={permissionKey(permission)}
          >
            <code>{permission.method}</code>
            <span>
              {permission.mode === "update"
                ? "Update — may change canister state"
                : "Query — reads canister state"}
            </span>
          </li>
        ))}
      </ul>
      <p className="permission-copy">
        Backend owner authorization and live Candid argument validation still
        apply. Method names are identifiers; their app-defined semantics are not
        verified by the kernel.
      </p>
    </PermissionFrame>
  );
}

function PublicMethodsDisclosure({
  permissions,
}: {
  permissions: readonly PublicMethodPermission[];
}) {
  return (
    <PermissionFrame kind="public_methods" level={1}>
      <h4 className="permission-group-title">
        Methods callable without owner authorization ({permissions.length})
      </h4>
      <ul className="permission-inventory permission-method-inventory">
        {permissions.map((permission) => (
          <li data-mode={permission.mode} key={permissionKey(permission)}>
            <code>{permission.method}</code>
            <span>{methodModeLabel(permission.mode)}</span>
          </li>
        ))}
      </ul>
      <p className="permission-copy">
        The kernel attests only the exposed method identifiers and call modes,
        not their app-defined semantics.
      </p>
    </PermissionFrame>
  );
}

function methodModeLabel(mode: FunctionMode) {
  if (mode === "query") return "Query — reads canister state";
  if (mode === "update") return "Update — may change canister state";
  return "Internal function exposure";
}

function formatPermissionByteLimit(value: number): string {
  return `${formatBytes(value)} (${formatExactNat(value)} bytes)`;
}

export function PermissionDisclosure({
  permission,
}: {
  permission: Permission;
}) {
  const level = permissionLevel(permission);
  switch (permission.kind) {
    case "kernel_replacement":
      return (
        <PermissionFrame kind={permission.kind} level={level}>
          <h4 className="permission-group-title">Replace the Neutron kernel</h4>
          <p className="permission-copy">
            Replace privileged kernel code that controls the installed system.
          </p>
        </PermissionFrame>
      );
    case "persistent_background_storage":
      return (
        <PermissionFrame kind={permission.kind} level={level}>
          <h4 className="permission-group-title">
            Persistent background storage
          </h4>
          <p className="permission-copy">
            Store data persistently in this app&apos;s isolated browser origin.
          </p>
        </PermissionFrame>
      );
    case "dedicated_resident_origin":
      return (
        <PermissionFrame kind={permission.kind} level={level}>
          <h4 className="permission-group-title">
            Ephemeral isolated resident origin
          </h4>
          <p className="permission-copy">
            {`Run this app's background on an ${DEDICATED_RESIDENT_ORIGIN_DISCLOSURE}. Browser storage APIs may still exist inside the temporary partition, but it cannot read ordinary or persistent browser storage.`}
          </p>
        </PermissionFrame>
      );
    case "browser_permissions": {
      const browserPermissionTitle = browserPermissionFeaturesTitle(
        permission.tiles.flatMap(({ features }) => features),
      );
      return (
        <PermissionFrame kind={permission.kind} level={level}>
          <h4 className="permission-group-title">
            Browser {browserPermissionTitle.toLowerCase()} access
          </h4>
          <p className="permission-copy">
            Installing this app does not activate a camera or microphone. Its
            declared open tiles may request only the access listed below.
          </p>
          <ul className="permission-inventory">
            {permission.tiles.flatMap(({ id, features }) =>
              features.map((feature) => (
                <li key={`${id}:${feature}`}>
                  <strong>
                    {BROWSER_PERMISSION_FEATURE_DISCLOSURES[feature].title}
                  </strong>
                  <span>{browserPermissionRequestDisclosure(id, feature)}</span>
                </li>
              )),
            )}
          </ul>
          <p className="permission-copy permission-persistence">
            {BROWSER_PERMISSION_PERSISTENCE_DISCLOSURE}
          </p>
        </PermissionFrame>
      );
    }
    case "randomness":
      return (
        <PermissionFrame kind={permission.kind} level={level}>
          <h4 className="permission-group-title">Consensus randomness</h4>
          <p className="permission-copy">
            Request fresh 32-byte consensus entropy through the kernel.
          </p>
          <p className="permission-copy permission-persistence">
            Each request spends Neutron cycles. The kernel enforces bounded
            concurrency and a minimum remaining cycle balance. The app never
            receives the management canister actor.
          </p>
        </PermissionFrame>
      );
    case "chain_key_signing":
      return (
        <PermissionFrame kind={permission.kind} level={level}>
          <h4 className="permission-group-title">
            Autonomous cryptographic assertions
          </h4>
          <p className="permission-copy">
            This app can create signatures for assertions it chooses without
            asking each time.
          </p>
          <ul className="permission-inventory">
            {permission.slots.map((slot) => (
              <li key={slot.id}>
                <strong>
                  <code>{slot.id}</code>
                </strong>
                <span>
                  <code>{slot.algorithm}</code>
                </span>
                <dl className="permission-facts">
                  <div>
                    <dt>Maximum assertion</dt>
                    <dd>{slot.maxAssertionBytes} bytes</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
          <p className="permission-copy permission-persistence">
            A fixed app, installation, and slot domain prevents direct raw
            blockchain transaction signing. Verifiers may still treat an
            assertion as authorization, so these signatures can carry
            high-impact authority.
          </p>
          <p className="permission-copy permission-persistence">
            Every accepted signature spends shared Neutron cycles. If the
            outcome is unknown, the threshold service may still have produced a
            valid signature. Each slot has a live on/off control in Settings.
          </p>
        </PermissionFrame>
      );
    case "stable_store":
      return (
        <PermissionFrame kind={permission.kind} level={level}>
          <h4 className="permission-group-title">
            Durable backend stores ({permission.stores.length})
          </h4>
          <p className="permission-copy">
            Keep key/value blobs in kernel-managed storage isolated to this app
            installation.
          </p>
          <ul className="permission-inventory">
            {permission.stores.map((store) => (
              <li key={store.id}>
                <strong>
                  <code>{store.id}</code>
                </strong>
                <span>Schema {store.schemaVersion}</span>
                <dl className="permission-facts">
                  <div>
                    <dt>Entry limit</dt>
                    <dd>{store.maxEntries}</dd>
                  </div>
                  <div>
                    <dt>Key / value limit</dt>
                    <dd>
                      {store.maxKeyBytes} / {store.maxValueBytes} bytes
                    </dd>
                  </div>
                  <div>
                    <dt>Total data limit</dt>
                    <dd>{store.maxBytes} bytes</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
          <p className="permission-copy permission-persistence">
            Store contents consume shared Neutron memory and canister cycles.
            They survive compatible app upgrades, remain inaccessible to other
            apps, and are purged when this installation is removed. Each store
            has its own live on/off control in Settings.
          </p>
          <p className="permission-copy permission-persistence">
            These blobs are ordinary canister state: app isolation does not
            encrypt them or certify them for public HTTP reads.
          </p>
        </PermissionFrame>
      );
    case "https_outcalls": {
      const hasPost = permission.endpoints.some(({ methods }) =>
        methods.includes("post"),
      );
      const hasAuthorization = permission.endpoints.some(({ requestHeaders }) =>
        requestHeaders.includes("authorization"),
      );
      return (
        <PermissionFrame kind={permission.kind} level={level}>
          <h4 className="permission-group-title">
            External HTTPS endpoints ({permission.endpoints.length})
          </h4>
          <p className="permission-copy">
            Make paid, single-node HTTPS requests only beneath these exact URL
            prefixes. The app may use relative unreserved path segments and
            structured query values, but cannot choose another origin.
          </p>
          <ul className="permission-inventory">
            {permission.endpoints.map((endpoint) => (
              <li key={endpoint.id}>
                <strong>
                  <code>{endpoint.id}</code>
                </strong>
                <span>
                  <code>{endpoint.urlPrefix}</code>
                </span>
                <dl className="permission-facts">
                  <div>
                    <dt>Methods</dt>
                    <dd>
                      {endpoint.methods
                        .map((method) => method.toUpperCase())
                        .join(", ")}
                    </dd>
                  </div>
                  <div>
                    <dt>Request headers</dt>
                    <dd>
                      {endpoint.requestHeaders.length === 0
                        ? "None"
                        : endpoint.requestHeaders.join(", ")}
                    </dd>
                  </div>
                  <div>
                    <dt>Request / reply</dt>
                    <dd>
                      {endpoint.maxRequestBytes} / {endpoint.maxResponseBytes}{" "}
                      bytes
                    </dd>
                  </div>
                  <div>
                    <dt>Response transform</dt>
                    <dd>
                      Strip all headers
                      {endpoint.methods.includes("head")
                        ? " and every HEAD body"
                        : ""}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
          <p className="permission-copy permission-persistence">
            Request and response plaintext is visible to the IC subnet replicas
            and the destination service. This is not a confidential transport.
            Each accepted request spends Neutron cycles; the kernel checks
            bounded concurrency, quoted per-call cost, and remaining-cycle
            safety.
          </p>
          <p className="permission-copy permission-persistence">
            Responses are not cross-checked by subnet consensus and may be
            forged by the selected node. Redirect responses are rejected and
            every response header is removed. Each endpoint has a live on/off
            control in Settings.
            {hasPost
              ? " POST requires a caller-supplied idempotency key, which the kernel places in its fixed header; the remote service must perform deduplication."
              : ""}
          </p>
          {hasAuthorization ? (
            <p className="permission-copy permission-persistence">
              <strong>Authorization is allowed for a declared endpoint.</strong>{" "}
              Its value is visible to subnet replicas and the destination and
              must not be treated as secret from node providers.
            </p>
          ) : null}
        </PermissionFrame>
      );
    }
    case "public_ingress_route": {
      const callerLabel =
        permission.mode === "update"
          ? permission.caller === "canister"
            ? "Canister calls funding the required base charge"
            : "Direct ingress from self-authenticating principals only"
          : permission.caller === "any"
          ? "Anyone, including anonymous callers"
          : permission.caller === "authenticated"
            ? "Authenticated principals only"
            : "Canister principals only";
      return (
        <PermissionFrame kind={permission.kind} level={level}>
          <h4 className="permission-group-title">Public protocol endpoint</h4>
          <p className="permission-copy">
            Accept <strong>{permission.mode}</strong> calls at{" "}
            <code>{`${permission.protocol}:${permission.method}`}</code> and run{" "}
            <code>{permission.handler}</code>.
          </p>
          <dl className="permission-facts">
            <div>
              <dt>Protocol / method</dt>
              <dd>
                <code>{permission.protocol}</code> /{" "}
                <code>{permission.method}</code>
              </dd>
            </div>
            <div>
              <dt>Call mode</dt>
              <dd>{methodModeLabel(permission.mode)}</dd>
            </div>
            <div>
              <dt>Accepted callers</dt>
              <dd>{callerLabel}</dd>
            </div>
            <div>
              <dt>Request / reply</dt>
              <dd>
                {permission.maxRequestBytes} / {permission.maxResponseBytes}{" "}
                bytes
              </dd>
            </div>
            {permission.mode === "update" ? (
              <>
                {permission.caller === "canister" ? (
                  <div>
                    <dt>Required base charge</dt>
                    <dd>
                      {formatExactNat(permission.requiredCycles)} cycles
                      accepted by the kernel and attributed to this app
                    </dd>
                  </div>
                ) : (
                  <div>
                    <dt>Cycle payment</dt>
                    <dd>
                      None accepted; this Neutron funds the ingress and app work
                    </dd>
                  </div>
                )}
                <div>
                  <dt>External limit</dt>
                  <dd>{permission.maxCallsPerHour} admitted calls per hour</dd>
                </div>
                {permission.maxCallsPerCallerPerHour === undefined ? null : (
                  <div>
                    <dt>Per-caller limit</dt>
                    <dd>
                      {permission.maxCallsPerCallerPerHour} admitted calls per
                      caller per hour
                    </dd>
                  </div>
                )}
              </>
            ) : null}
          </dl>
          <p className="permission-copy permission-persistence">
            The kernel binds this exact route to compiler-generated app code,
            enforces its admission and byte limits, and can disable it live.
            {permission.mode === "update"
              ? permission.caller === "canister"
                ? ` A calling canister must fund at least the ${formatExactNat(permission.requiredCycles)}-cycle base charge. Calls below that base trap before app code runs. The kernel accepts and attributes the configured base charge to this app. This base is not a total-cost cap: the app may request additional kernel-mediated cycles later in the call. Accepted calls may change canister state.`
                : " This direct-ingress variant accepts only self-authenticating caller principals; anonymous and canister principals are rejected. It accepts no caller cycles, so this Neutron funds the ingress and app work. Accepted calls may change canister state."
              : " Query calls do not change canister state."}
          </p>
        </PermissionFrame>
      );
    }
    case "http_route":
      if (permission.mode === "certified_store") {
        const sharedPath = permission.surface === "shared_app_path";
        const authority =
          permission.authorityMode === "exact_neutron_host_v1"
            ? "Exact Neutron host (Host-bound)"
            : "Supported canister gateway (canister-portable proof)";
        return (
          <PermissionFrame kind={permission.kind} level={level}>
            <h4 className="permission-group-title">
              Public certified read route
            </h4>
            <p className="permission-copy">
              Publish certified responses at{" "}
              <code>{permission.publicPath}</code>{" "}
              {sharedPath
                ? "on Neutron’s ordinary public host."
                : "on this app’s dedicated host."}
            </p>
            <dl className="permission-facts">
              <div>
                <dt>Mount</dt>
                <dd>
                  <code>{permission.id}</code>
                </dd>
              </div>
              <div>
                <dt>Surface</dt>
                <dd>
                  {sharedPath ? "Shared Neutron path" : "Dedicated app host"}
                </dd>
              </div>
              <div>
                <dt>Public base</dt>
                <dd>
                  <code>{permission.publicPath}</code>
                </dd>
              </div>
              <div>
                <dt>Methods</dt>
                <dd>{permission.methods.join(", ")}</dd>
              </div>
              <div>
                <dt>Authority</dt>
                <dd>{authority}</dd>
              </div>
              <div>
                <dt>Store</dt>
                <dd>
                  <code>{permission.store}</code>
                </dd>
              </div>
            </dl>
            <p className="permission-copy permission-persistence">
              Anyone can read these responses. Serving them does not run app
              code; the kernel owns routing, presentation, limits, and
              certification.
            </p>
            <p className="permission-copy permission-persistence">
              {permission.authorityMode === "exact_neutron_host_v1"
                ? "The proof is bound to the exact ordinary Neutron Host."
                : "The proof is portable across supported gateways for this canister, but a verifier must still validate the expected Neutron canister principal."}{" "}
              Only the collection&apos;s fixed passive response profiles are
              allowed; this is not an executable app surface.
            </p>
            <p className="permission-copy permission-persistence">
              <strong>Route disable is separate from write freeze.</strong>{" "}
              Disabling this public route detaches its object responses and
              leaves the policy-specific certified 404. It does not delete the
              stored collection bodies. Freezing writes separately does not hide
              already published responses.
            </p>
          </PermissionFrame>
        );
      }
      const sharedPath = permission.surface === "shared_app_path";
      return (
        <PermissionFrame kind={permission.kind} level={level}>
          <h4 className="permission-group-title">
            Public POST → backend handler
          </h4>
          <p className="permission-copy">
            Let anyone POST to <code>{permission.publicPath}</code>{" "}
            {sharedPath
              ? "on Neutron’s ordinary public host"
              : "on this app’s dedicated host"}{" "}
            and run <code>{permission.handler}</code>.
          </p>
          <dl className="permission-facts">
            <div>
              <dt>Mount</dt>
              <dd>
                <code>{permission.id}</code>
              </dd>
            </div>
            <div>
              <dt>Surface</dt>
              <dd>
                {sharedPath ? "Shared Neutron path" : "Dedicated app host"}
              </dd>
            </div>
            <div>
              <dt>Public base</dt>
              <dd>
                <code>{permission.publicPath}</code>
              </dd>
            </div>
            <div>
              <dt>Request / reply</dt>
              <dd>
                {permission.maxRequestBytes} / {permission.maxResponseBytes}{" "}
                bytes
              </dd>
            </div>
            <div>
              <dt>External limit</dt>
              <dd>
                {permission.maxCallsPerHour} accepted non-authorized POST
                {permission.maxCallsPerHour === 1 ? "" : "s"} per hour
              </dd>
            </div>
            <div>
              <dt>Idempotency</dt>
              <dd>
                <code>Idempotency-Key</code> required · completed replies
                replayed for 1 hour
              </dd>
            </div>
            <div>
              <dt>Forwarded headers</dt>
              <dd>
                {permission.forwardHeaders.length === 0 ? (
                  "None"
                ) : (
                  <span className="permission-code-list">
                    {permission.forwardHeaders.map((header) => (
                      <code key={header}>{header}</code>
                    ))}
                  </span>
                )}
              </dd>
            </div>
          </dl>
          <p className="permission-copy permission-persistence">
            Each accepted request runs app backend code, may change canister
            state, and spends Neutron cycles. The kernel bounds request and
            reply sizes, concurrency, and duplicate keys. Non-authorized callers
            share the declared external request window; authorized Neutron
            principals bypass it and do not increment it. Across this app,
            external POST declarations are capped at 240 admissions and 8 MiB of
            possible replay replies per hour. There is no separate per-handler
            instruction allowance below the IC message limit, and a forwarded
            header is never a Neutron identity.
          </p>
          {sharedPath ? (
            <p className="permission-copy permission-persistence">
              This kernel-derived path shares Neutron&apos;s ordinary browser
              origin. Replies keep fixed restrictive security headers and cannot
              add CORS, cookies, redirects, or executable browser policy.
            </p>
          ) : null}
        </PermissionFrame>
      );
    case "certified_assets": {
      const chargedReceiptLanes =
        permission.maxEntries + permission.maxIdempotencyReceipts;
      return (
        <PermissionFrame kind={permission.kind} level={level}>
          <h4 className="permission-group-title">
            Certified public plaintext collections
          </h4>
          <p className="permission-copy">
            Every committed body is deliberately public plaintext. It is not
            encrypted, and the app can mutate only the install-reviewed
            collection kinds and locator spaces below.
          </p>
          <dl className="permission-facts">
            <div>
              <dt>Maximum logical records</dt>
              <dd>{formatExactNat(permission.maxEntries)}</dd>
            </div>
            <div>
              <dt>Maximum committed bytes</dt>
              <dd>{formatPermissionByteLimit(permission.maxCommittedBytes)}</dd>
            </div>
            <div>
              <dt>Maximum object</dt>
              <dd>{formatPermissionByteLimit(permission.maxObjectBytes)}</dd>
            </div>
            <div>
              <dt>Active upload stages</dt>
              <dd>{formatExactNat(permission.maxPendingStages)}</dd>
            </div>
            <div>
              <dt>Maximum staged bytes</dt>
              <dd>{formatPermissionByteLimit(permission.maxStagedBytes)}</dd>
            </div>
            <div>
              <dt>Maximum batch</dt>
              <dd>
                {formatExactNat(permission.maxBatchOperations)} operations /{" "}
                {formatPermissionByteLimit(permission.maxBatchBytes)}
              </dd>
            </div>
            <div>
              <dt>General receipt lanes</dt>
              <dd>{formatExactNat(permission.maxIdempotencyReceipts)}</dd>
            </div>
            <div>
              <dt>Per-record revocation lanes</dt>
              <dd>
                One per committed record, up to{" "}
                {formatExactNat(permission.maxEntries)}
              </dd>
            </div>
            <div>
              <dt>Maximum charged receipt lanes</dt>
              <dd>{formatExactNat(chargedReceiptLanes)}</dd>
            </div>
          </dl>
          <div className="permission-fact-label">
            Install-reviewed collections ({permission.collections.length})
          </div>
          <ul className="permission-inventory">
            {permission.collections.map((collection) => {
              const disclosure =
                certifiedAssetsCollectionDisclosure(collection);
              return (
                <li key={collection.id}>
                  <strong>
                    <code>{collection.id}</code> on mount{" "}
                    <code>{collection.mount}</code> · {disclosure.title}
                  </strong>
                  <span>{disclosure.locator}</span>
                  <dl className="permission-facts">
                    <div>
                      <dt>Mutation</dt>
                      <dd>{disclosure.mutation}</dd>
                    </div>
                    <div>
                      <dt>Body source</dt>
                      <dd>{disclosure.bodySource}</dd>
                    </div>
                    <div>
                      <dt>Delivery</dt>
                      <dd>{disclosure.delivery}</dd>
                    </div>
                    <div>
                      <dt>Disabled or absent</dt>
                      <dd>{disclosure.absence}</dd>
                    </div>
                    <div>
                      <dt>Maximum object</dt>
                      <dd>
                        {formatPermissionByteLimit(
                          collection.max_object_bytes ??
                            permission.maxObjectBytes,
                        )}
                      </dd>
                    </div>
                  </dl>
                </li>
              );
            })}
          </ul>
          <p className="permission-copy permission-persistence">
            General receipts and per-record revocation outcomes reconcile
            retries for 24 hours. That is an outcome-reconciliation window, not
            a promise that deleted content stays available.
          </p>
          <p className="permission-copy permission-persistence">
            <strong>Write freeze does not disable the public route.</strong>{" "}
            Freezing mutation blocks positive record, byte, stage, and receipt
            growth without deleting or hiding existing public bodies.
            Non-increasing CAS, conditional delete, abort, and cleanup remain
            available. Disable the public route separately to stop serving
            object bodies and return its fixed certified 404.
          </p>
        </PermissionFrame>
      );
    }
    case "vetkeys":
      return (
        <PermissionFrame kind={permission.kind} level={level}>
          <h4 className="permission-group-title">App-isolated private keys</h4>
          <p className="permission-copy">
            This app declares {permission.slots.length} isolated threshold-key
            slot{permission.slots.length === 1 ? "" : "s"}. Installation does
            not create or release a key. Reserving a slot later requires a
            focused-tile approval.
          </p>
          <ul className="permission-inventory">
            {permission.slots.map((slot) => (
              <li key={slot.id}>
                <code>{slot.id}</code>
                <span>Declared slot identifier</span>
              </li>
            ))}
          </ul>
          <p className="permission-copy">
            An enabled app version can request its slot key encrypted to an
            originating live browser endpoint, and recovery spends canister
            cycles. Compatible updates inherit access. Neutron stores namespace
            and lifecycle metadata, not the private key.
          </p>
          <p className="permission-copy permission-persistence">
            Disabling stops future supported recovery but cannot erase a key
            already held by a browser. App code can intentionally disclose keys
            from its own slots.
          </p>
        </PermissionFrame>
      );
    case "agent_entrypoint":
      return (
        <PermissionFrame kind={permission.kind} level={level}>
          <h4 className="permission-group-title">Optional agent mode</h4>
          <p className="permission-copy">
            May request owner approval to run agent entrypoint{" "}
            <code>{permission.entrypoint}</code>.
          </p>
        </PermissionFrame>
      );
    case "scheduled_task":
      return (
        <PermissionFrame kind={permission.kind} level={level}>
          <h4 className="permission-group-title">Scheduled backend task</h4>
          <p className="permission-copy">
            Run <code>{permission.method}</code> as task{" "}
            <code>{permission.id}</code> every {permission.intervalSeconds}{" "}
            seconds
            {permission.runOnStart ? ", including once after activation" : ""}.
          </p>
          <p className="permission-copy permission-persistence">
            Each run may make at most {permission.maxBackendCalls} backend call
            {permission.maxBackendCalls === 1 ? "" : "s"}. The task can be
            disabled later in Settings.
          </p>
        </PermissionFrame>
      );
    case "background_ui_request":
      return (
        <PermissionFrame kind={permission.kind} level={level}>
          <h4 className="permission-group-title">Background owner attention</h4>
          <p className="permission-copy">
            The background may ask the kernel to show category{" "}
            <code>{permission.category}</code>.
          </p>
        </PermissionFrame>
      );
    case "ethereum_provider":
      return (
        <PermissionFrame kind={permission.kind} level={level}>
          <h4 className="permission-group-title">
            Focused-tile Ethereum provider
          </h4>
          <div className="permission-fact-label">
            Chains ({permission.chains.length})
          </div>
          <div className="permission-code-list">
            {permission.chains.map((chain) => (
              <code key={chain}>{chain}</code>
            ))}
          </div>
          <div className="permission-fact-label">
            Provider methods ({permission.methods.length})
          </div>
          <ul className="permission-inventory">
            {permission.methods.map((method) => (
              <li
                className={
                  method === "eth_sendTransaction"
                    ? "permission-update-method"
                    : ""
                }
                key={method}
              >
                <code>{method}</code>
                {method === "eth_sendTransaction" ? (
                  <span>May submit a state-changing transaction</span>
                ) : null}
              </li>
            ))}
          </ul>
        </PermissionFrame>
      );
    case "app_dependency":
      return (
        <PermissionFrame kind={permission.kind} level={level}>
          <h4 className="permission-group-title">App backend dependency</h4>
          <p className="permission-copy">
            Use backend functions from <code>{permission.app}</code> version{" "}
            {permission.minVersion} or newer.
          </p>
          <div className="permission-code-list">
            {permission.functions.map((method) => (
              <code key={method}>{`${permission.app}.${method}`}</code>
            ))}
          </div>
        </PermissionFrame>
      );
    case "connection":
      return (
        <PermissionFrame kind={permission.kind} level={level}>
          <h4 className="permission-group-title">
            Kernel connection: <code>{permission.provider}</code>
          </h4>
          <p className="permission-copy">
            Deliver this connection credential to the app&apos;s isolated
            background process.
          </p>
          {permission.scopes.length > 0 ? (
            <>
              <div className="permission-fact-label">
                Connection scopes ({permission.scopes.length})
              </div>
              <div className="permission-code-list">
                {permission.scopes.map((scope) => (
                  <code key={scope}>{scope}</code>
                ))}
              </div>
            </>
          ) : null}
        </PermissionFrame>
      );
    case "internal_app_function":
      return (
        <PermissionFrame kind={permission.kind} level={level}>
          <h4 className="permission-group-title">
            Export app backend function
          </h4>
          <p className="permission-copy">
            Expose internal function <code>{permission.method}</code> to other
            installed apps through the kernel.
          </p>
        </PermissionFrame>
      );
    case "function_resources":
      return (
        <PermissionFrame kind={permission.kind} level={level}>
          <h4 className="permission-group-title">Backend function resources</h4>
          <p className="permission-copy">
            Inject into <code>{permission.method}</code> ({permission.mode}).
          </p>
          <div className="permission-code-list">
            {permission.resources.map((resource, index) => (
              <code key={`${permissionKey(permission)}:${index}`}>
                {functionResourceLabel(resource)}
              </code>
            ))}
          </div>
        </PermissionFrame>
      );
    case "kernel_memory_replacement":
      return (
        <PermissionFrame kind={permission.kind} level={level}>
          <h4 className="permission-group-title">Replace kernel memory</h4>
          <p className="permission-copy">
            Replace the stable memory owned by the kernel.
          </p>
        </PermissionFrame>
      );
    case "memory_retirement":
      return (
        <PermissionFrame kind={permission.kind} level={level}>
          <h4 className="permission-group-title">
            {permission.consolidation
              ? "Move and retire app memory"
              : "Permanently delete app memory"}
          </h4>
          <p className="permission-copy">
            {permission.consolidation
              ? "Move data during consolidation and retire"
              : "Permanently retire and delete"}{" "}
            memory <code>{permission.memoryId}</code>.
          </p>
        </PermissionFrame>
      );
    case "backend_calls":
      return <BackendCallsDisclosure permission={permission} />;
    case "preapproved_self_call":
      return <PreapprovedSelfCallsDisclosure permissions={[permission]} />;
    case "public_method":
      return <PublicMethodsDisclosure permissions={[permission]} />;
  }
}
