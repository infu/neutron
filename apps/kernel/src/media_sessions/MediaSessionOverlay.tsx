import { useEffect, useMemo, useRef, useState } from "react";
import { appMediaSessionUrl } from "neutron-tools/src/runtime.js";
import { getNeutronId } from "../config.ts";
import { ensureFrameEndpointConnected, registerFrameContext } from "../frame_context.ts";
import { useAppsStore } from "../reducer/apps.ts";
import { assertRuntimeFrameUrl, getRuntimeDeployment } from "../runtime_deployment.ts";
import {
  approvePendingMediaSession,
  closeActiveMediaSession,
  rejectPendingMediaSession,
  useMediaSessionStore,
} from "./store.ts";

export function MediaSessionOverlay() {
  const pending = useMediaSessionStore((state) => state.pending);
  const active = useMediaSessionStore((state) => state.active);
  const [approving, setApproving] = useState(false);

  useEffect(() => setApproving(false), [pending?.id]);

  return (
    <>
      {pending ? (
        <div className="media-session-consent-backdrop" data-tid="media-session-consent">
          <section
            aria-describedby="media-session-purpose"
            aria-labelledby="media-session-title"
            aria-modal="true"
            className="media-session-consent"
            role="dialog"
          >
            <p className="media-session-eyebrow">Device access</p>
            <h2 id="media-session-title">Start media for {pending.appName}?</h2>
            <p id="media-session-purpose">{pending.purpose}</p>
            <dl className="media-session-details">
              <div><dt>Devices</dt><dd>{pending.features.join(" + ")}</dd></div>
              <div><dt>Maximum time</dt><dd>{formatDuration(pending.durationSeconds)}</dd></div>
            </dl>
            <p className="media-session-privacy">
              Your browser will ask separately. Media runs in this visible,
              isolated surface and stops when you end it or the lease expires.
            </p>
            <div className="media-session-actions">
              <button type="button" disabled={approving} onClick={() => rejectPendingMediaSession()}>
                Not now
              </button>
              <button
                type="button"
                className="primary"
                data-tid="media-session-approve"
                disabled={approving}
                onClick={() => {
                  setApproving(true);
                  void approvePendingMediaSession().finally(() => setApproving(false));
                }}
              >
                {approving ? "Starting…" : "Continue"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {active ? <ActiveMediaSurface key={active.sessionId} /> : null}
    </>
  );
}

function ActiveMediaSurface() {
  const active = useMediaSessionStore((state) => state.active)!;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const app = useAppsStore((state) => state.list[active.appId]);
  const instance = useAppsStore((state) => state.appInstances[active.appId]);
  const generation = useAppsStore((state) => state.runtimeGenerations[active.appId] ?? 0);
  const deployment = getRuntimeDeployment();
  const src = useMemo(
    () => assertRuntimeFrameUrl(
      appMediaSessionUrl({
        canisterId: getNeutronId(),
        appId: active.appId,
        entrypoint: active.entrypoint,
        binding: {
          installationUid: active.installationUid,
          originNonce: active.originNonce,
          authorityEpoch: active.authorityEpoch,
        },
        local: deployment.local,
        ...(deployment.localHost ? { localHost: deployment.localHost } : {}),
      }),
      true,
      deployment,
    ),
    [active, deployment],
  );
  const authorityCurrent =
    Boolean(app && instance) &&
    app?.version === active.appVersion &&
    app?.capability_plan_fingerprint === active.planFingerprint &&
    instance?.scope.installationUid === active.installationUid &&
    generation === active.appGeneration;

  useEffect(() => {
    if (!authorityCurrent) void closeActiveMediaSession();
  }, [authorityCurrent]);

  useEffect(() => {
    const delay = Number(BigInt(active.expiresAtNanoseconds) / 1_000_000n - BigInt(Date.now()));
    if (delay <= 0) {
      void closeActiveMediaSession();
      return;
    }
    const timer = window.setTimeout(() => void closeActiveMediaSession(), Math.min(delay, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [active.expiresAtNanoseconds, active.sessionId]);

  useEffect(() => {
    if (!authorityCurrent || !app || !instance) return;
    const source = iframeRef.current?.contentWindow ?? null;
    return registerFrameContext(
      source,
      { role: "media", appId: active.appId, sessionId: active.sessionId },
      {
        appVersion: active.appVersion,
        appGeneration: active.appGeneration,
        appScope: { appId: active.appId, installationUid: active.installationUid },
        origin: new URL(src).origin,
        isAuthorityCurrent: () => useMediaSessionStore.getState().active?.sessionId === active.sessionId,
      },
    );
  }, [active, app, authorityCurrent, instance, src]);

  if (!authorityCurrent) return null;
  // In an iframe `allow` attribute, 'self' names the embedding Kernel origin.
  // Delegate only to this lease's nonce origin instead of using `*`.
  const mediaOrigin = new URL(src).origin;
  const allow = active.features.map((feature) => `${feature} ${mediaOrigin}`).join("; ");
  return (
    <aside className="media-session-overlay" data-tid="media-session-overlay">
      <header>
        <div>
          <span className="media-session-live-dot" aria-hidden="true" />
          <strong>{active.appName}</strong>
          <span>{active.features.join(" + ")} active</span>
        </div>
        <button type="button" data-tid="media-session-end" onClick={() => void closeActiveMediaSession()}>
          End
        </button>
      </header>
      <iframe
        ref={iframeRef}
        allow={allow}
        className="media-session-frame"
        onLoad={() => ensureFrameEndpointConnected(iframeRef.current?.contentWindow ?? null)}
        referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-same-origin"
        src={src}
        title={`${active.appName} media session`}
        {...({ credentialless: "true" } as Record<string, string>)}
      />
    </aside>
  );
}

function formatDuration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`;
  if (seconds % 60 === 0) return `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}
