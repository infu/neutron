import {
  refreshRuntimeAuthority,
  type RuntimeAuthorityRefreshResult,
} from "./reducer/apps.ts";
import {
  isFrontendAuthorityPending,
  markFrontendAuthorityStale,
} from "./runtime_authority.ts";
import {
  subscribeRuntimeAuthorityChanges,
  type RuntimeAuthoritySignal,
} from "./runtime_authority_signal.ts";

export const RUNTIME_AUTHORITY_POLL_MS = 20_000;

type MonitorWindow = Pick<
  Window,
  "addEventListener" | "removeEventListener" | "setInterval" | "clearInterval"
>;

type MonitorDocument = Pick<
  Document,
  "addEventListener" | "removeEventListener" | "visibilityState"
>;

export type RuntimeAuthorityMonitorOptions = {
  refresh?: () => Promise<RuntimeAuthorityRefreshResult>;
  markStale?: (deploymentId: string) => void;
  subscribe?: (
    listener: (signal: RuntimeAuthoritySignal) => void,
  ) => () => void;
  authorityPending?: () => boolean;
  reload?: () => void;
  window?: MonitorWindow;
  document?: MonitorDocument;
  pollIntervalMs?: number;
};

/**
 * Keep an open shell bound to the canister actor it reconciled. Same-browser
 * commits signal immediately; a single low-frequency journal/runtime probe
 * covers other devices and missed signals. Probes coalesce, only run while a
 * tab is visible, and only trigger the expensive registry/assets read after a
 * change or an uncertainty fence.
 */
export function startRuntimeAuthorityMonitor(
  options: RuntimeAuthorityMonitorOptions = {},
): () => void {
  const hostWindow = options.window ?? window;
  const hostDocument = options.document ?? document;
  const refresh = options.refresh ?? refreshRuntimeAuthority;
  const markStale =
    options.markStale ??
    ((deploymentId: string) => markFrontendAuthorityStale(deploymentId));
  const subscribe = options.subscribe ?? subscribeRuntimeAuthorityChanges;
  const authorityPending =
    options.authorityPending ?? isFrontendAuthorityPending;
  const reload = options.reload ?? (() => globalThis.location.reload());
  const pollIntervalMs = options.pollIntervalMs ?? RUNTIME_AUTHORITY_POLL_MS;
  let stopped = false;
  let inFlight: Promise<RuntimeAuthorityRefreshResult> | null = null;
  let runAgain = false;
  let reloadAfterRefresh = false;
  let reloadRequested = false;
  let appOnlyDeploymentId: string | null = null;

  const run = (force = false): void => {
    if (stopped) return;
    if (!force && hostDocument.visibilityState !== "visible") return;
    if (inFlight) {
      runAgain = true;
      return;
    }
    const pending = refresh();
    inFlight = pending;
    void pending
      .then((result) => {
        const reconciledAppOnlyDeployment =
          (result.status === "current" || result.status === "changed") &&
          result.deploymentId === appOnlyDeploymentId;
        const externallyChanged =
          result.status === "changed" && !reconciledAppOnlyDeployment;
        if (
          !reloadRequested &&
          !authorityPending() &&
          result.status !== "pending" &&
          (reloadAfterRefresh || externallyChanged)
        ) {
          reloadRequested = true;
          reload();
        }
        if (reconciledAppOnlyDeployment) appOnlyDeploymentId = null;
      })
      .catch(() => {
        // refreshRuntimeAuthority installs a fail-closed fence itself. The
        // next focus, signal, or interval retries without a noisy rejection.
      })
      .finally(() => {
        if (inFlight === pending) inFlight = null;
        if (runAgain && !stopped) {
          runAgain = false;
          run(true);
        }
      });
  };

  const onFocus = (): void => run();
  const onVisibility = (): void => run();
  const unsubscribe = subscribe((signal) => {
    // Revoke synchronously, before even the first canister query resolves.
    markStale(signal.deploymentId);
    reloadAfterRefresh ||=
      signal.phase === "committed" && signal.kernelUpdated;
    if (signal.phase === "committed" && !signal.kernelUpdated) {
      // The exact same-browser commit proves this shell remains compatible.
      // A changed actor observed without that proof reloads conservatively.
      appOnlyDeploymentId = signal.deploymentId;
    }
    run(true);
  });
  hostWindow.addEventListener("focus", onFocus);
  hostDocument.addEventListener("visibilitychange", onVisibility);
  const interval = hostWindow.setInterval(() => run(), pollIntervalMs);
  run(true);

  return () => {
    stopped = true;
    unsubscribe();
    hostWindow.removeEventListener("focus", onFocus);
    hostDocument.removeEventListener("visibilitychange", onVisibility);
    hostWindow.clearInterval(interval);
  };
}
