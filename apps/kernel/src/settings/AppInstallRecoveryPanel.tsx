import { useEffect, useRef, useState } from "react";
import type { AppRegistry } from "neutron-compiler/src/install.js";
import {
  abortPendingInstallRecovery,
  inspectPendingInstallRecovery,
  releasePendingInstallReservation,
  retryPendingInstallRecovery,
  useAppsStore,
  type PendingInstallRecovery,
  type PendingInstallReservationBlockerReason,
} from "../reducer/apps.ts";
import {
  useKernelUiModeStore,
  type KernelUiMode,
} from "../ui_mode.ts";

type RecoveryAction =
  | "inspect"
  | "retry"
  | "abort"
  | `release:${string}`;

export function AppInstallRecoveryPanel() {
  const recovery = useAppsStore((state) => state.pendingInstallRecovery);
  const apps = useAppsStore((state) => state.list);
  const uiMode = useKernelUiModeStore((state) => state.mode);
  const actionSequence = useRef(0);
  const busyRef = useRef<RecoveryAction | null>(null);
  const [busy, setBusy] = useState<RecoveryAction | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const run = async (
    action: RecoveryAction,
    operation: () => Promise<unknown>,
  ): Promise<void> => {
    if (busyRef.current !== null) return;
    const sequence = ++actionSequence.current;
    busyRef.current = action;
    setBusy(action);
    setFeedback(null);
    try {
      const result = await operation();
      if (
        result === false &&
        useAppsStore.getState().pendingInstallRecovery !== null
      ) {
        setFeedback(pendingRecoveryFeedback());
      }
    } catch (error) {
      const detail =
        uiMode === "developer" && error instanceof Error
          ? ` ${error.message}`
          : "";
      setFeedback(`Recovery could not be completed. Try again.${detail}`);
    } finally {
      if (actionSequence.current === sequence) {
        busyRef.current = null;
        setBusy(null);
      }
    }
  };

  useEffect(() => {
    if (!recovery || recovery.runningTarget !== undefined) return;
    void run("inspect", () =>
      inspectPendingInstallRecovery(recovery.deploymentId),
    );
    // Inspect once for each newly observed journal. A resolved inspection
    // updates this same journal in the store without starting another call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recovery?.deploymentId]);

  if (!recovery) return null;

  return (
    <AppInstallRecoveryPanelView
      apps={apps}
      busy={busy}
      feedback={feedback}
      onAbort={() =>
        void run("abort", () =>
          abortPendingInstallRecovery(recovery.deploymentId),
        )
      }
      onInspect={() =>
        void run("inspect", () =>
          inspectPendingInstallRecovery(recovery.deploymentId),
        )
      }
      onRelease={(reservationId) =>
        void run(`release:${reservationId}`, () =>
          releasePendingInstallReservation(
            recovery.deploymentId,
            reservationId,
          ),
        )
      }
      onRetry={() =>
        void run("retry", () =>
          retryPendingInstallRecovery(recovery.deploymentId),
        )
      }
      recovery={recovery}
      uiMode={uiMode}
    />
  );
}

export function AppInstallRecoveryPanelView({
  apps,
  busy,
  feedback,
  onAbort,
  onInspect,
  onRelease,
  onRetry,
  recovery,
  uiMode,
}: {
  apps: AppRegistry;
  busy: RecoveryAction | null;
  feedback: string | null;
  onAbort: () => void;
  onInspect: () => void;
  onRelease: (reservationId: bigint) => void;
  onRetry: () => void;
  recovery: PendingInstallRecovery;
  uiMode: KernelUiMode;
}) {
  const blockers = recovery.blockers ?? [];
  const working = busy !== null;

  return (
    <div
      aria-busy={working}
      aria-live="polite"
      className="settings-warning install-recovery-panel"
      data-tid="install-recovery-panel"
      role="status"
    >
      <strong>Installation needs attention</strong>
      <span>
        {recovery.runningTarget === true
          ? "The new version is running, but the final install commit is still pending. Resolve any saved-access blocker below, then retry."
          : recovery.runningTarget === false
            ? "The staged version is not running. You can check again or discard only its staged changes; the currently installed apps stay in place."
            : "Checking whether the staged version is running and can be completed safely."}
      </span>
      {uiMode === "developer" ? (
        <span className="instance-id">{recovery.deploymentId}</span>
      ) : null}
      {recovery.runningTarget === true ? (
        <div
          className="install-recovery-blockers"
          data-tid="install-recovery-blockers"
        >
          {blockers.length === 0 ? (
            <span>
              No saved connection can be safely removed. Retry to check whether
              the commit can now finish.
            </span>
          ) : (
            blockers.map((blocker) => {
              const releaseAction = `release:${blocker.id}` as const;
              return (
                <div
                  className="install-recovery-blocker"
                  data-tid={`install-recovery-blocker-${blocker.id}`}
                  key={blocker.id.toString()}
                >
                  <div>
                    <strong>{apps[blocker.appId]?.name ?? blocker.appId}</strong>
                    <div className="install-recovery-reason">
                      {pendingInstallBlockerReasonText(blocker.reason)}
                    </div>
                    {uiMode === "developer" ? (
                      <div className="instance-id">{blocker.scope}</div>
                    ) : null}
                  </div>
                  <button
                    className="btn btn-warning"
                    data-tid={`install-recovery-release-${blocker.id}`}
                    disabled={working}
                    onClick={() => onRelease(blocker.id)}
                    type="button"
                  >
                    {busy === releaseAction
                      ? "Removing…"
                      : "Remove saved access & retry"}
                  </button>
                </div>
              );
            })
          )}
        </div>
      ) : null}
      {feedback ? (
        <span data-tid="install-recovery-feedback" role="alert">
          {feedback}
        </span>
      ) : null}
      <div className="btn-actions install-recovery-actions">
        <button
          className="btn btn-sec"
          data-tid="install-recovery-check"
          disabled={working}
          onClick={
            recovery.runningTarget === true ? onRetry : onInspect
          }
          type="button"
        >
          {busy === "retry"
            ? "Retrying…"
            : busy === "inspect"
              ? "Checking…"
              : recovery.runningTarget === true
                ? "Retry installation"
                : "Check again"}
        </button>
        {recovery.runningTarget === false ? (
          <button
            className="btn btn-warning"
            data-tid="install-recovery-abort"
            disabled={working}
            onClick={onAbort}
            type="button"
          >
            {busy === "abort" ? "Discarding…" : "Discard staged install"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function pendingRecoveryFeedback(): string {
  const recovery = useAppsStore.getState().pendingInstallRecovery;
  if (recovery?.runningTarget === true) {
    return (recovery.blockers ?? []).length > 0
      ? "The installation is still pending. Resolve the saved-access blocker, then retry."
      : "The installation is still pending. No saved-access blocker can be safely removed right now.";
  }
  return "The staged installation is still pending.";
}

function pendingInstallBlockerReasonText(
  reason: PendingInstallReservationBlockerReason,
): string {
  if (reason === "scope_conflict") {
    return "This saved connection overlaps access the new version needs.";
  }
  if (reason === "app_capacity") {
    return "This app has too many saved connections for the new version.";
  }
  return "Neutron has reached its total saved connection limit.";
}
