import { useEffect, useRef, useState } from "react";
import {
  IoPauseOutline,
  IoShieldCheckmarkOutline,
  IoStop,
} from "react-icons/io5";
import { useAppsStore } from "./reducer/apps.ts";
import { useAuthStore } from "./reducer/auth.ts";
import { SettingsDisclosure } from "./settings/SettingsDisclosure.tsx";
import {
  approveAgentGrant,
  cancelAgentRoot,
  disableAgentMode,
  rejectAgentGrant,
  requestAgentGrant,
  useAgentModeStore,
  type PendingAgentGrant,
} from "./ui_attention/agent.ts";
import { declaredCapability } from "./capabilities/plan.ts";
import { formatAppVersionLabel } from "neutron-tools/src/version.js";
import {
  ConsentNotice,
  ConsentTechnicalDetails,
  focusConsentControl,
  useConsentUiMode,
} from "./consent/ConsentPresentation.tsx";
import type { KernelUiMode } from "./ui_mode.ts";

export function AgentGrantDialog() {
  const request = useAgentModeStore((state) => state.pendingGrant);
  if (!request) return null;
  return <AgentGrantRequestDialog request={request} />;
}

export function AgentGrantRequestDialog({
  request,
  uiMode: uiModeOverride,
}: {
  request: PendingAgentGrant;
  uiMode?: KernelUiMode;
}) {
  const uiMode = useConsentUiMode(uiModeOverride);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    focusConsentControl(cancelRef.current);
  }, [request.appId, request.entrypoint]);
  return (
    <>
      <div className="backdrop" onClick={rejectAgentGrant} />
      <div
        aria-describedby="agent-grant-warning"
        aria-labelledby="agent-grant-title"
        aria-modal="true"
        className="dialog dialog-danger agent-grant-dialog"
        data-tid="agent-grant-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            rejectAgentGrant();
            return;
          }
          if (event.key !== "Tab") return;
          const controls =
            dialogRef.current?.querySelectorAll<HTMLElement>(
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
        }}
        ref={dialogRef}
        role="alertdialog"
      >
        <div className="title" id="agent-grant-title">
          Allow this app to act for you?
        </div>
        <div className="call">
          <ConsentNotice tone="danger">
            <span id="agent-grant-warning">
              <strong>{request.appName}</strong> (name supplied by the app) may
              control other apps during an active agent turn without asking
              for every direct action. It can also decide new permission
              requests made by apps it calls. Enable this only if you trust it
              to act as your orchestrator.
            </span>
          </ConsentNotice>
          <ConsentTechnicalDetails mode={uiMode}>
          <div className="a-infogrid">
            <div className="label">App-provided name — unverified</div>
            <div className="val">{request.appName}</div>
            <div className="label">App id</div>
            <div className="val instance-id">{request.appId}</div>
            <div className="label">Entrypoint</div>
            <div className="val">{request.entrypoint}</div>
          </div>
          <div className="uninstall-warning">
            This app may control other apps during an active agent turn without
            asking you for each direct action. Called apps remain isolated and
            their new permission requests are decided by the agent.
          </div>
          </ConsentTechnicalDetails>
          <div className="btn-actions">
            <button
              className="btn btn-sec"
              data-tid="agent-grant-cancel"
              onClick={rejectAgentGrant}
              ref={cancelRef}
              type="button"
            >
              Cancel
            </button>
            <button
              className="btn btn-danger"
              data-tid="agent-grant-approve"
              onClick={approveAgentGrant}
              type="button"
            >
              Enable agent control
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

export function AgentModeIndicator() {
  const grant = useAgentModeStore((state) => state.grant);
  const root = useAgentModeStore((state) => state.activeRoot);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!root) return;
    setNow(Date.now());
    const timer = globalThis.setInterval(() => setNow(Date.now()), 1_000);
    return () => globalThis.clearInterval(timer);
  }, [root?.id]);
  if (!grant) return null;

  return (
    <div
      className={`agent-mode-indicator${root ? " is-running" : ""}`}
      data-tid="agent-mode-indicator"
      title={`Agent Mode for ${grant.appId}; app-provided name — unverified: ${grant.appName}`}
    >
      <span className="agent-mode-dot" aria-hidden="true" />
      <span className="agent-mode-name">{grant.appId}</span>
      {root ? (
        <span className="agent-mode-elapsed">
          {formatElapsed(now - root.startedAt)}
        </span>
      ) : null}
      {root ? (
        <button
          aria-label="Stop agent turn"
          className="icon-button agent-mode-action"
          data-tid="agent-mode-stop"
          onClick={() => cancelAgentRoot(root.id, "Stopped by owner")}
          title="Stop agent turn"
          type="button"
        >
          <IoStop aria-hidden="true" />
        </button>
      ) : null}
      <button
        aria-label="Disable Agent Mode"
        className="icon-button agent-mode-action"
        data-tid="agent-mode-disable"
        onClick={() => disableAgentMode()}
        title="Disable Agent Mode"
        type="button"
      >
        <IoPauseOutline aria-hidden="true" />
      </button>
    </div>
  );
}

export function AgentModeSettings() {
  const [open, setOpen] = useState(false);
  const apps = useAppsStore((state) => state.list);
  const appInstances = useAppsStore((state) => state.appInstances);
  const principal = useAuthStore((state) => state.principal);
  const grant = useAgentModeStore((state) => state.grant);
  const root = useAgentModeStore((state) => state.activeRoot);
  const decisions = useAgentModeStore((state) => state.decisions);
  const eligible = Object.entries(apps).flatMap(([appId, app]) => {
    const appInstance = appInstances[appId];
    if (!appInstance) return [];
    return (
      declaredCapability(app, "agent_entrypoints")?.entrypoints ?? []
    ).map((entrypoint) => ({ appId, app, appInstance, entrypoint }));
  });

  return (
    <SettingsDisclosure
      description="Optional delegated app control"
      icon={<IoShieldCheckmarkOutline aria-hidden="true" />}
      id="settings-agent-mode"
      onToggle={() => setOpen((value) => !value)}
      open={open}
      testId="settings-agent-mode-toggle"
      title="Agent Mode"
    >
      <div className="agent-settings" data-tid="settings-agent-mode">
        {eligible.map(({ appId, app, appInstance, entrypoint }) => {
          const enabled =
            grant?.appId === appId && grant.entrypoint === entrypoint;
          return (
            <div className="agent-settings-app" key={`${appId}:${entrypoint}`}>
              <div>
                <strong>{appId}</strong>
                <small>App-provided name — unverified: {app.name}</small>
                <code>{entrypoint}</code>
              </div>
              {enabled ? (
                <button
                  className="btn btn-sec"
                  onClick={() => disableAgentMode()}
                  type="button"
                >
                  Disable
                </button>
              ) : (
                <button
                  className="btn btn-sec"
                  disabled={Boolean(grant)}
                  onClick={() =>
                    void requestAgentGrant({
                      appId,
                      appName: app.name,
                      version: app.version,
                      installationUid: appInstance.scope.installationUid,
                      entrypoint,
                      ownerPrincipal: principal,
                    }).catch(() => undefined)
                  }
                  type="button"
                >
                  Enable
                </button>
              )}
            </div>
          );
        })}
        {eligible.length === 0 ? (
          <div className="settings-empty">No installed agent apps</div>
        ) : null}
        {grant ? (
          <dl className="agent-settings-status">
            <div>
              <dt>App id</dt>
              <dd>{grant.appId} {formatAppVersionLabel(grant.version)}</dd>
            </div>
            <div>
              <dt>App-provided name — unverified</dt>
              <dd>{grant.appName}</dd>
            </div>
            <div>
              <dt>Entrypoint</dt>
              <dd>{grant.entrypoint}</dd>
            </div>
            <div>
              <dt>Owner</dt>
              <dd title={grant.ownerPrincipal}>{shortPrincipal(grant.ownerPrincipal)}</dd>
            </div>
            <div>
              <dt>State</dt>
              <dd>
                {root
                  ? `Running, ${root.remainingCalls} calls and ${root.remainingChallenges} decisions left`
                  : "Idle"}
              </dd>
            </div>
          </dl>
        ) : null}
        {decisions.length > 0 ? (
          <div className="agent-decision-list">
            {decisions.slice(-8).reverse().map((decision) => (
              <div className="agent-decision" key={decision.id}>
                <span className={`is-${decision.decision}`} />
                <strong>{decision.requesterAppId}</strong>
                <span>{decision.kind.replaceAll("_", " ")}</span>
                <small>{decision.reason}</small>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </SettingsDisclosure>
  );
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function shortPrincipal(value: string): string {
  return value.length <= 24 ? value : `${value.slice(0, 11)}...${value.slice(-8)}`;
}
