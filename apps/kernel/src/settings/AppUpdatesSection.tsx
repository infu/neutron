import {
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { IoCopyOutline } from "react-icons/io5";
import { formatAppVersionLabel } from "neutron-tools/src/version.js";
import { compareCanonicalText } from "neutron-tools/src/canonical.js";
import { formatBytes } from "./format.ts";
import {
  applyPreparedUpdates,
  backToUpdateResults,
  cancelUpdateWork,
  clearUpdateResults,
  prepareAllAvailableUpdates,
  prepareAppUpdates,
  prepareAppUpdate,
} from "../updates/service.ts";
import { updateFailureMessage, type UpdateReview } from "../updates/model.ts";
import {
  useUpdateCheckStore,
  type UpdateCheckState,
} from "../updates/store.ts";
import {
  ConsentNotice,
  ConsentTechnicalDetails,
  focusConsentControl,
  useConsentUiMode,
} from "../consent/ConsentPresentation.tsx";
import { PermissionConsequences } from "../consent/PermissionConsequences.tsx";
import { CapabilityChangeSummary } from "../consent/CapabilityChangeSummary.tsx";
import type { KernelUiMode } from "../ui_mode.ts";
import { DeploymentBuildReview } from "../install_review/DeploymentBuildReview.tsx";

export function AppUpdatesCoordinator({
  fallbackFocusRef,
  onUpdated,
  returnFocusRef,
}: {
  fallbackFocusRef: RefObject<HTMLElement | null>;
  onUpdated?: () => void | Promise<void>;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const uiMode = useConsentUiMode();
  const state = useUpdateCheckStore();
  const previousPhase = useRef("idle");

  useEffect(() => {
    if (state.phase === "success" && previousPhase.current !== "success") {
      void onUpdated?.();
    }
    previousPhase.current = state.phase;
  }, [onUpdated, state.phase]);

  useEffect(
    () => () => {
      if (useUpdateCheckStore.getState().phase !== "applying") {
        clearUpdateResults();
      }
    },
    [],
  );

  return (
    <>
      <div
        aria-atomic="true"
        aria-live="polite"
        className="sr-only"
        data-checked-at={state.checkedAt ?? undefined}
        data-tid="app-updates-status"
      >
        {liveStatus(state)}
      </div>
      {state.phase === "review" && state.review ? (
        <UpdateReviewDialog
          fallbackFocusRef={fallbackFocusRef}
          returnFocusRef={returnFocusRef}
          review={state.review}
          uiMode={uiMode}
        />
      ) : null}
    </>
  );
}

export function AppUpdatesFeedback() {
  const state = useUpdateCheckStore();
  if (!state.error && state.phase !== "success") return null;

  if (state.phase === "success") {
    return (
      <div className="settings-success settings-app-updates-feedback">
        <strong>Updated {applicationCount(state.updatedAppCount)}.</strong>
        <span>
          Installed version and integrity records were committed together.
        </span>
      </div>
    );
  }

  return (
    <div
      className="settings-warning settings-app-updates-feedback"
      role="alert"
    >
      <strong>{errorHeading(state.errorStage)}</strong>
      <span>{state.error}</span>
      {state.errorStage === "apply" ? (
        <span>
          Neutron will use the checked deployment journal and existing recovery
          status; do not assume the installed version changed until Settings
          refreshes it.
        </span>
      ) : null}
      {state.results.length > 0 && state.errorStage !== "apply" ? (
        <button
          className="btn btn-sec"
          onClick={backToUpdateResults}
          type="button"
        >
          Back to checked results
        </button>
      ) : null}
    </div>
  );
}

export function AppUpdatesBulkAction({
  deleteDisabled,
  deleteTitle,
  disabled,
  onDeleteSelected,
  returnFocusRef,
  actionAppIds,
}: {
  actionAppIds: readonly string[];
  deleteDisabled: boolean;
  deleteTitle: string;
  disabled: boolean;
  onDeleteSelected: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const state = useUpdateCheckStore();
  const availableCount = state.results.filter(
    ({ kind }) => kind === "available",
  ).length;
  const selectedAvailableCount = state.results.filter(
    ({ appId, kind }) =>
      kind === "available" && actionAppIds.includes(appId),
  ).length;
  const preparing = state.phase === "preparing";
  const reviewing = state.phase === "review";
  const applying = state.phase === "applying";

  if (preparing) {
    return (
      <div className="settings-app-updates-toolbar">
        <button
          className="btn btn-sec settings-app-update-cancel"
          data-tid="settings-update-cancel"
          onClick={cancelUpdateWork}
          ref={returnFocusRef}
          type="button"
        >
          <span aria-hidden="true" className="settings-app-update-spinner" />
          Cancel
        </button>
      </div>
    );
  }

  if (reviewing || applying) {
    return (
      <div className="settings-app-updates-toolbar">
        <button className="btn" disabled ref={returnFocusRef} type="button">
          {reviewing ? "Reviewing updates" : "Updating apps"}
        </button>
      </div>
    );
  }

  const resultsUsable =
    state.phase === "ready" ||
    (state.phase === "error" && state.errorStage !== "apply");

  if (actionAppIds.length > 0) {
    return (
      <div className="settings-app-updates-toolbar">
        <button
          aria-label={`Delete selected: ${applicationCount(actionAppIds.length)}`}
          className="btn btn-danger"
          data-tid="settings-delete-selected"
          disabled={deleteDisabled || state.errorStage === "apply"}
          onClick={onDeleteSelected}
          title={deleteTitle}
          type="button"
        >
          Delete selected ({actionAppIds.length})
        </button>
        <button
          aria-label={`Update selected: ${applicationCount(selectedAvailableCount)}`}
          className="btn"
          data-tid="settings-update-selected"
          disabled={
            disabled || !resultsUsable || selectedAvailableCount === 0
          }
          onClick={(event) => {
            returnFocusRef.current = event.currentTarget;
            void prepareAppUpdates(actionAppIds);
          }}
          ref={returnFocusRef}
          type="button"
        >
          Update selected ({selectedAvailableCount})
        </button>
      </div>
    );
  }

  if (availableCount < 2 || !resultsUsable) return null;

  return (
    <div className="settings-app-updates-toolbar">
      <button
        aria-label={`Upgrade all ${availableCount} available apps`}
        className="btn"
        data-tid="settings-upgrade-all"
        disabled={disabled}
        onClick={(event) => {
          returnFocusRef.current = event.currentTarget;
          void prepareAllAvailableUpdates();
        }}
        ref={returnFocusRef}
        type="button"
      >
        Upgrade all ({availableCount})
      </button>
    </div>
  );
}

export function AppUpdateCell({
  appId,
  appName,
  disabled,
  returnFocusRef,
  updateSource,
}: {
  appId: string;
  appName: string;
  disabled: boolean;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  updateSource?: string;
}) {
  const state = useUpdateCheckStore();
  const result = state.results.find((candidate) => candidate.appId === appId);
  const selected = state.selectedAppIds.includes(appId);

  if (selected && state.phase === "preparing") {
    return <UpdateBusy label="Preparing" />;
  }

  const activeLabel = selected
    ? state.phase === "review"
      ? "Reviewing"
      : state.phase === "applying"
        ? "Updating"
        : null
    : null;
  if (activeLabel) return <UpdateBusy label={activeLabel} />;

  if (selected && state.phase === "error" && state.errorStage === "apply") {
    return <span title={state.error ?? undefined}>Status unknown</span>;
  }
  if (!result) {
    return state.phase === "checking" && updateSource ? (
      <UpdateBusy label="Checking" />
    ) : (
      <span>{updateSource ? "Not checked" : "Manual"}</span>
    );
  }

  switch (result.kind) {
    case "queued":
    case "checking":
      return <UpdateBusy label="Checking" />;
    case "manual_only":
      return <span>Manual</span>;
    case "current":
      return <span className="is-current">Up to date</span>;
    case "available":
      return (
        <button
          aria-label={`Update ${appName} to ${formatAppVersionLabel(result.release.version)}`}
          className="btn settings-app-update-action"
          data-tid={`settings-update-${appId}`}
          disabled={
            disabled ||
            state.phase === "checking" ||
            state.phase === "preparing" ||
            state.phase === "review" ||
            state.phase === "applying" ||
            state.errorStage === "apply"
          }
          onClick={(event) => {
            returnFocusRef.current = event.currentTarget;
            void prepareAppUpdate(appId);
          }}
          ref={
            selected && state.selectedAppIds.length === 1
              ? returnFocusRef
              : undefined
          }
          title={`Update ${appName} to ${formatAppVersionLabel(result.release.version)}`}
          type="button"
        >
          Update
        </button>
      );
    case "not_published":
      return (
        <span title="The configured source has no release for this app">
          Not published
        </span>
      );
    case "source_regression":
      return (
        <span
          title={`The source advertises ${formatAppVersionLabel(result.advertised)}`}
        >
          Source behind
        </span>
      );
    case "failed":
      return (
        <span title={updateFailureMessage(result.reason)}>Check failed</span>
      );
    case "cancelled":
      return <span>Not checked</span>;
  }
}

function UpdateBusy({ label }: { label: string }) {
  return (
    <span className="settings-app-update-busy">
      <span aria-hidden="true" className="settings-app-update-spinner" />
      {label}
    </span>
  );
}

function UpdateReviewDialog({
  fallbackFocusRef,
  returnFocusRef,
  review,
  uiMode,
}: {
  fallbackFocusRef: RefObject<HTMLElement | null>;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  review: UpdateReview;
  uiMode: KernelUiMode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const migrationRows = useMemo(
    () => review.migrationPlan.upgrades.filter(({ kind }) => kind !== "keep"),
    [review.migrationPlan.upgrades],
  );
  const reviewedAppIds = useMemo(
    () => new Set(review.apps.map(({ appId }) => appId)),
    [review.apps],
  );

  useEffect(() => {
    focusConsentControl(backRef.current);
    return () => {
      if (
        returnFocusRef.current?.isConnected &&
        !returnFocusRef.current.disabled
      ) {
        returnFocusRef.current.focus();
      } else {
        fallbackFocusRef.current?.focus();
      }
    };
  }, [fallbackFocusRef, returnFocusRef]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      backToUpdateResults();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
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
      <div className="backdrop" onClick={backToUpdateResults} />
      <div
        aria-describedby="app-update-review-summary"
        aria-labelledby="app-update-review-title"
        aria-modal="true"
        className="dialog app-update-review-dialog"
        data-tid="app-update-review-dialog"
        onKeyDown={onKeyDown}
        ref={dialogRef}
        role="alertdialog"
      >
        <h2 className="title" id="app-update-review-title">
          Review app {review.apps.length === 1 ? "update" : "updates"}
        </h2>
        <div className="call app-update-review-content">
          <ConsentNotice tone="warning">
            <span id="app-update-review-summary">
              Neutron verified certified transport, package integrity, and
              executable rules, then compiled the update. This verifies the
              package facts, not publisher identity or code endorsement. The
              reviewed batch commits completely or not at all.
            </span>
          </ConsentNotice>
          <div className="app-update-review-summary">
            <span>
              <strong>{review.apps.length}</strong> apps
            </span>
            <span>
              <strong>{formatBytes(review.compiledSizeKiB * 1024)}</strong>{" "}
              compiled Wasm
            </span>
            <span>
              <strong>{migrationRows.length}</strong> memory changes
            </span>
          </div>

          <DeploymentBuildReview {...review.deploymentBuild} uiMode={uiMode} />

          <div className="app-update-review-list">
            {review.apps.map((app) => (
              <article className="app-update-review-app" key={app.appId}>
                <header>
                  <div>
                    <strong>{app.name}</strong>
                    {uiMode === "developer" ? <code>{app.appId}</code> : null}
                  </div>
                  <span>
                    {formatAppVersionLabel(app.installedVersion)}
                    <span aria-hidden="true"> → </span>
                    <strong>{formatAppVersionLabel(app.targetVersion)}</strong>
                  </span>
                </header>
                <CapabilityChangeSummary diff={app.capabilityPlanDiff} />
                {app.capabilityPlanDiff.entries.length > 0 ? (
                  <PermissionConsequences permissions={app.permissions} />
                ) : null}
                <div className="app-update-normal-facts">
                  <span>
                    <strong>Future updates:</strong>{" "}
                    {futureUpdateSourceLabel(
                      app.currentUpdateSource,
                      app.targetUpdateSource,
                    )}
                  </span>
                  <span>
                    {app.appId === "kernel"
                      ? "Neutron reloads after the atomic commit."
                      : "The app restarts after the atomic commit."}
                  </span>
                </div>
                <ConsentTechnicalDetails
                  summary="Package and capability technical details"
                >
                <dl>
                  <ReviewFact
                    label="Download"
                    value={formatBytes(app.packageBytes)}
                  />
                    <ReviewCopyFact label="Source" value={app.source} />
                  <ReviewFact
                    label="Package SHA-256"
                    value={app.packageDigest}
                    mono
                  />
                  <ReviewFact
                    label="Capabilities"
                    value={
                      app.capabilityPlanDiff.entries.length === 0
                        ? "No authority changes"
                        : `${app.capabilityPlanDiff.entries.length} changes`
                    }
                  />
                  <ReviewFact
                    label="Dependencies"
                    value={
                      Object.keys(app.dependencies).length === 0
                        ? "None"
                        : `${Object.keys(app.dependencies).length} required ${
                              Object.values(app.dependencies).filter(
                                ({ app }) => reviewedAppIds.has(app),
                            ).length
                          } updated in this batch`
                    }
                  />
                  <ReviewFact
                    label="Future updates"
                    value={futureUpdateSourceLabel(
                      app.currentUpdateSource,
                      app.targetUpdateSource,
                    )}
                    mono={app.currentUpdateSource !== app.targetUpdateSource}
                  />
                  <ReviewFact
                    label="Activation"
                    value={
                      app.appId === "kernel"
                        ? "Neutron reloads after the atomic commit"
                        : "App runtime restarts after the atomic commit"
                    }
                  />
                </dl>
                {Object.keys(app.dependencies).length > 0 ? (
                  <details>
                    <summary>Dependency requirements</summary>
                    <ul>
                      {Object.entries(app.dependencies)
                        .sort(([left], [right]) =>
                          compareCanonicalText(left, right),
                        )
                        .map(([alias, dependency]) => (
                          <li key={alias}>
                            <strong>{alias}</strong> → {dependency.app} · at
                              least{" "}
                              {formatAppVersionLabel(dependency.min_version)}
                            {reviewedAppIds.has(dependency.app)
                              ? " · updated in this batch"
                              : " · resolved from the installed set"}
                            <br />
                            Functions: {dependency.functions.join(", ")}
                          </li>
                        ))}
                    </ul>
                  </details>
                ) : null}
                {app.capabilityPlanDiff.entries.length > 0 ? (
                  <details>
                    <summary>Capability authority changes</summary>
                    <ul>
                      {app.capabilityPlanDiff.entries.map((entry) => (
                        <li key={entry.id}>
                          <strong>{entry.change}</strong> · {entry.id}
                          {entry.before ? (
                            <pre>
                              {JSON.stringify(entry.before.config, null, 2)}
                            </pre>
                          ) : null}
                          {entry.after ? (
                            <pre>
                              {JSON.stringify(entry.after.config, null, 2)}
                            </pre>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                {app.permissions.length > 0 ? (
                  <details>
                    <summary>
                      Target package access ({app.permissions.length})
                    </summary>
                    <ul>
                      {app.permissions.map((permission, index) => (
                        <li key={`${permission.kind}:${index}`}>
                          {permission.kind.replaceAll("_", " ")}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                {app.appExplanations.length > 0 ? (
                  <details>
                    <summary>App-provided explanations — unverified</summary>
                    <ul>
                      {app.appExplanations.map((explanation, index) => (
                        <li key={index}>{explanation.text}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                </ConsentTechnicalDetails>
              </article>
            ))}
          </div>

          {migrationRows.length > 0 && uiMode === "developer" ? (
            <section className="app-update-review-memory">
              <h3>Managed-memory plan</h3>
              <ul>
                {migrationRows.map((upgrade, index) => (
                  <li key={`${upgrade.owner}:${upgrade.memoryId}:${index}`}>
                    {memoryUpgradeLabel(upgrade)}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {review.migrationPlan.destructiveMemoryRoots.length > 0 ? (
            <ConsentNotice tone="danger">
              <strong>Destructive managed-memory changes</strong>
              <span>
                {" "}
                {uiMode === "developer"
                  ? review.migrationPlan.destructiveMemoryRoots
                      .map(({ owner, memoryId }) => `${owner}.${memoryId}`)
                      .join(", ")
                  : `${review.migrationPlan.destructiveMemoryRoots.length} app data ${
                      review.migrationPlan.destructiveMemoryRoots.length === 1
                        ? "area will"
                        : "areas will"
                    } be permanently retired or deleted.`}
              </span>
            </ConsentNotice>
          ) : migrationRows.length > 0 && uiMode === "normal" ? (
            <ConsentNotice tone="neutral">
              {migrationRows.length} managed app data{" "}
              {migrationRows.length === 1 ? "area changes" : "areas change"} as
              part of this update. No destructive retirement is planned.
            </ConsentNotice>
          ) : null}

          {review.diagnostics.length > 0 ||
          review.compatibilityDiagnostics.length > 0 ? (
            <ConsentTechnicalDetails
              className="app-update-review-diagnostics"
              summary="Compiler diagnostics"
            >
              <ul>
                {[
                  ...review.diagnostics,
                  ...review.compatibilityDiagnostics,
                ].map((diagnostic, index) => (
                    <li key={index}>{diagnostic}</li>
                ))}
              </ul>
            </ConsentTechnicalDetails>
          ) : null}

          <div className="btn-actions">
            <button
              className="btn"
              data-tid="app-updates-apply"
              onClick={() => void applyPreparedUpdates()}
              type="button"
            >
              Update {applicationCount(review.apps.length)}
            </button>
            <button
              className="btn btn-sec"
              data-tid="app-updates-back"
              onClick={backToUpdateResults}
              ref={backRef}
              type="button"
            >
              Back
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function futureUpdateSourceLabel(
  currentSource: string | undefined,
  targetSource: string | undefined,
): string {
  if (currentSource === targetSource) {
    return currentSource ? "Same source" : "Manual updates";
  }
  if (!currentSource) return `Adds source ${targetSource}`;
  if (!targetSource) {
    return `Removes source ${currentSource} · manual updates`;
  }
  return `Changes source ${currentSource} → ${targetSource}`;
}

function ReviewFact({
  label,
  mono = false,
  value,
}: {
  label: string;
  mono?: boolean;
  value: string;
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={mono ? "instance-id" : undefined} title={value}>
        {value}
      </dd>
    </>
  );
}

function ReviewCopyFact({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className="app-update-review-copy-value">
        <code>{value}</code>
        <button
          aria-label={`Copy ${label.toLowerCase()} ${value}`}
          className="icon-button"
          onClick={() => void copyReviewValue(value)}
          title={`Copy ${label.toLowerCase()}`}
          type="button"
        >
          <IoCopyOutline aria-hidden="true" />
        </button>
      </dd>
    </>
  );
}

async function copyReviewValue(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) return;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // Clipboard permission is optional; the full value remains selectable.
  }
}

function errorHeading(stage: UpdateCheckState["errorStage"]): string {
  switch (stage) {
    case "prepare":
      return "No updates were applied.";
    case "apply":
      return "Deployment did not report success.";
    case "check":
    case null:
      return "Updates could not be checked.";
  }
}

function liveStatus(state: UpdateCheckState): string {
  if (state.error) return state.error;
  if (state.phase === "checking") return "Checking app update sources.";
  if (state.phase === "preparing") {
    return "Preparing and compiling selected updates.";
  }
  if (state.phase === "review") return "Update review is ready.";
  if (state.phase === "applying") {
    return "Applying the selected update batch.";
  }
  if (state.phase === "success") {
    return `Updated ${applicationCount(state.updatedAppCount)}.`;
  }
  if (state.phase === "ready") {
    const counts = new Map<string, number>();
    for (const result of state.results) {
      counts.set(result.kind, (counts.get(result.kind) ?? 0) + 1);
    }
    const available = counts.get("available") ?? 0;
    const unresolved =
      (counts.get("failed") ?? 0) +
      (counts.get("source_regression") ?? 0) +
      (counts.get("cancelled") ?? 0);
    const current = counts.get("current") ?? 0;
    const notPublished = counts.get("not_published") ?? 0;
    const manual = counts.get("manual_only") ?? 0;
    const parts = [
      available > 0
        ? `${available} ${available === 1 ? "update" : "updates"} available`
        : "",
      unresolved > 0
        ? `${unresolved} ${unresolved === 1 ? "check needs" : "checks need"} attention`
        : "",
      current > 0 ? `${current} current` : "",
      notPublished > 0 ? `${notPublished} not published` : "",
      manual > 0 ? `${manual} manual only` : "",
    ].filter(Boolean);
    return parts.length > 0
      ? `Update check complete: ${parts.join(", ")}.`
      : "Update check complete.";
  }
  return "";
}

function memoryUpgradeLabel(
  upgrade: UpdateReview["migrationPlan"]["upgrades"][number],
): string {
  const memory = `${upgrade.owner}.${upgrade.memoryId}`;
  switch (upgrade.kind) {
    case "initialize":
      return `Initialize ${memory} at v${upgrade.to}`;
    case "keep":
      return `Keep ${memory} at v${upgrade.version}`;
    case "migrate":
      return `Migrate ${memory} v${upgrade.from} → v${upgrade.to} through ${upgrade.path.length} step${upgrade.path.length === 1 ? "" : "s"}`;
    case "retire":
      return `Retire ${memory} from v${upgrade.from}`;
  }
}

function applicationCount(count: number): string {
  return `${count} ${count === 1 ? "app" : "apps"}`;
}
