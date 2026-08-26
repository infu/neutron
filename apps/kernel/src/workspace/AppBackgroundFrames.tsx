import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  appBackgroundUrl,
  isDedicatedAppOrigin,
} from "neutron-tools/src/runtime.js";
import type { AppRegistryEntry } from "neutron-compiler/src/install.js";
import type { AppInstanceProjection } from "../app_scope.ts";
import {
  appFrameAuthorityCurrent,
  appFrameEndpointAuthority,
  CREDENTIALLESS_APP_FRAME_PROPS,
  credentiallessOriginfulFrameSupported,
  OPAQUE_APP_FRAME_SANDBOX,
  ORIGINFUL_APP_FRAME_SANDBOX,
  ordinaryAppFramePolicy,
  prepareOrdinaryAppFrame,
  type AppFrameEndpointAuthority,
  type CredentiallessIFrame,
  type CredentiallessWindow,
} from "../app_frame_security.ts";
import { getNeutronId } from "../config.ts";
import {
  isFrameEndpointReady,
  markFrameEndpointLoaded,
  registerFrameContext,
  subscribeEndpointChanges,
} from "../frame_context.ts";
import {
  isAuthorityPendingState,
  useAppsStore,
} from "../reducer/apps.ts";
import {
  assertResidentFrameSecurityBinding,
  residentFrameSecurityMode,
  ResidentFrameSecurityMode,
  type ResidentFrameSecurityBinding,
  type ResidentFrameSecurityMode as ResidentFrameSecurityModeValue,
} from "../capabilities/plan.ts";
import {
  assertRuntimeFrameUrl,
  getRuntimeDeployment,
} from "../runtime_deployment.ts";
import { assertAppSurfaceInventoryCapacity } from "../runtime_limits.ts";

export const RESIDENT_FRAME_READY_TIMEOUT_MS = 15_000;

export type ResidentFrameReadiness = Readonly<{
  attempt: 0 | 1;
  phase: "waiting" | "ready" | "blocked";
}>;

export const INITIAL_RESIDENT_FRAME_READINESS: ResidentFrameReadiness =
  Object.freeze({
    attempt: 0,
    phase: "waiting",
  });

export function advanceResidentFrameReadiness(
  current: ResidentFrameReadiness,
  event: "connected" | "disconnected" | "deadline",
): ResidentFrameReadiness {
  if (event === "connected") {
    return current.phase === "ready"
      ? current
      : Object.freeze({ attempt: current.attempt, phase: "ready" });
  }
  if (event === "disconnected") {
    return current.phase === "ready"
      ? Object.freeze({ attempt: current.attempt, phase: "waiting" })
      : current;
  }
  if (current.phase !== "waiting") return current;
  return current.attempt === 0
    ? Object.freeze({ attempt: 1, phase: "waiting" })
    : Object.freeze({ attempt: 1, phase: "blocked" });
}

export function AppBackgroundFrames() {
  const apps = useAppsStore((state) => state.list);
  const appInstances = useAppsStore((state) => state.appInstances);
  const runtimeGenerations = useAppsStore((state) => state.runtimeGenerations);
  const authorityPending = useAppsStore(isAuthorityPendingState);
  const browserSurfaceOriginAppIds = useAppsStore(
    (state) => state.browserSurfaceOriginAppIds,
  );
  const backgroundApps = runnableBackgroundFrameEntries(
    apps,
    appInstances,
    authorityPending,
  );

  return (
    <div className="app-background-frames" aria-hidden="true">
      {backgroundApps.map(([appId, app]) => (
        <AppBackgroundFrame
          key={`${backgroundKey(appId, app, appInstances[appId]!, browserSurfaceOriginAppIds.includes(appId))}:${appInstances[appId]!.scope.installationUid}:${runtimeGenerations[appId] ?? 0}`}
          appId={appId}
          app={app}
          appInstance={appInstances[appId]!}
          appGeneration={runtimeGenerations[appId] ?? 0}
          browserSurfaceOriginAdopted={browserSurfaceOriginAppIds.includes(
            appId,
          )}
        />
      ))}
    </div>
  );
}

const AppBackgroundFrame = memo(function AppBackgroundFrame({
  appId,
  app,
  appInstance,
  appGeneration,
  browserSurfaceOriginAdopted,
}: {
  appId: string;
  app: AppRegistryEntry;
  appInstance: AppInstanceProjection;
  appGeneration: number;
  browserSurfaceOriginAdopted: boolean;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const launchedFrameRef = useRef<{
    key: string;
    source: Window;
    origin: string;
  } | null>(null);
  const [preflightFailure, setPreflightFailure] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<ResidentFrameReadiness>(
    INITIAL_RESIDENT_FRAME_READINESS,
  );
  const deployment = getRuntimeDeployment();
  const canisterId = getNeutronId();
  const installationUid = appInstance.scope.installationUid;
  const background = app.background;
  if (!background) {
    throw new Error(`App '${appId}' has no resident background`);
  }
  const mode = residentFrameSecurityMode(app);
  if (appInstance.residentFrameSecurity !== mode) {
    throw new Error(
      "Resident frame security does not match the current runtime authority",
    );
  }
  const dedicated =
    mode !== ResidentFrameSecurityMode.CREDENTIALLESS_OPAQUE_V1;
  const residentBinding = dedicated
    ? {
        installationUid,
        mode,
        browserOriginNonce: appInstance.browserOriginNonce,
        browserOriginAuthorityEpoch:
          appInstance.browserOriginAuthorityEpoch,
      }
    : undefined;
  const ordinaryFramePolicy = useMemo(
    () =>
      dedicated
        ? null
        : ordinaryAppFramePolicy({
            appId,
            app,
            appInstance,
            endpoint: { role: "background", path: background.path },
            deployment,
            browserSurfaceOriginAdopted,
          }),
    [
      app,
      appId,
      appInstance,
      background.path,
      browserSurfaceOriginAdopted,
      dedicated,
      deployment,
    ],
  );
  const residentSrc = dedicated
    ? assertRuntimeFrameUrl(
        appBackgroundUrl({
          canisterId,
          appId,
          path: background.path,
          ...(residentBinding ? { residentBinding } : {}),
          local: deployment.local,
          ...(deployment.localHost ? { localHost: deployment.localHost } : {}),
        }),
        true,
        deployment,
      )
    : null;
  const src = ordinaryFramePolicy?.src ?? residentSrc;
  if (!src) throw new Error("Background frame has no runtime URL");
  const residentSecurity = residentSrc
    ? backgroundFrameSecurity(
        appId,
        app,
        residentSrc,
        canisterId,
        appInstance.browserOriginNonce,
        appInstance.browserOriginAuthorityEpoch,
      )
    : null;
  const endpointAuthority = useMemo(
    () => {
      const ordinaryAuthority = appFrameEndpointAuthority({
        appId,
        app,
        appInstance,
        appGeneration,
        browserSurfaceOriginAdopted,
      });
      return Object.freeze({
        ...ordinaryAuthority,
        ...(residentSecurity ? { binding: residentSecurity.binding } : {}),
      });
    },
    [
      app,
      appGeneration,
      appId,
      appInstance,
      browserSurfaceOriginAdopted,
      residentSecurity?.binding.mode,
      residentSecurity?.binding.browserOriginNonce,
      residentSecurity?.binding.browserOriginAuthorityEpoch,
    ],
  );
  const launchFailure =
    preflightFailure ??
    (readiness.phase === "blocked"
      ? "Background service did not become ready after two launch attempts"
      : null);

  useLayoutEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const launchKey = residentSecurity
      ? [
          src,
          residentSecurity.binding.mode,
          residentSecurity.binding.browserOriginNonce,
          residentSecurity.binding.browserOriginAuthorityEpoch,
        ].join("\0")
      : `${src}\0ordinary`;
    let source = iframe.contentWindow;
    let origin = launchedFrameRef.current?.origin ?? "null";
    if (
      !source ||
      launchedFrameRef.current?.source !== source ||
      launchedFrameRef.current.key !== launchKey
    ) {
      try {
        if (ordinaryFramePolicy) {
          const prepared = prepareOrdinaryAppFrame(
            iframe,
            ordinaryFramePolicy,
          );
          source = prepared.source;
          origin = prepared.origin;
        } else if (residentSecurity) {
          // The initial about:blank Window inherits the final iframe flags.
          // Check it before assigning the app URL so an unsupported ephemeral
          // implementation can never execute app HTML or start a Worker.
          source = assertBackgroundFramePreflight(
            iframe,
            residentSecurity.binding.mode,
          );
          origin = residentSecurity.origin;
        } else {
          throw new Error("Background frame security is unavailable");
        }
      } catch (error) {
        iframe.removeAttribute("src");
        setPreflightFailure(
          error instanceof Error
            ? error.message
            : "Resident frame security preflight failed",
        );
        return;
      }
      launchedFrameRef.current = { key: launchKey, source, origin };
    }
    setPreflightFailure(null);
    const unregister = registerFrameContext(
      source,
      {
        role: "background",
        appId,
      },
      {
        appVersion: app.version,
        appGeneration,
        appScope: { appId, installationUid },
        origin,
        ...(residentSecurity
          ? { residentSecurityBinding: residentSecurity.binding }
          : {}),
        isAuthorityCurrent: () =>
          backgroundFrameAuthorityCurrent(
            endpointAuthority,
            useAppsStore.getState(),
          ),
      },
    );
    if (iframe.getAttribute("src") !== src) iframe.setAttribute("src", src);
    let active = true;
    let readinessTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const armReadinessDeadline = (): void => {
      if (!active || readinessTimer !== undefined) return;
      readinessTimer = globalThis.setTimeout(() => {
        readinessTimer = undefined;
        if (!active || markReady()) return;
        if (
          !backgroundFrameAuthorityCurrent(
            endpointAuthority,
            useAppsStore.getState(),
          )
        ) {
          return;
        }
        setReadiness((current) =>
          advanceResidentFrameReadiness(current, "deadline"),
        );
      }, RESIDENT_FRAME_READY_TIMEOUT_MS);
    };
    const markReady = (): boolean => {
      if (!active || !isFrameEndpointReady(source)) return false;
      if (readinessTimer !== undefined) {
        globalThis.clearTimeout(readinessTimer);
        readinessTimer = undefined;
      }
      setReadiness((current) =>
        advanceResidentFrameReadiness(current, "connected"),
      );
      return true;
    };
    const refreshReadiness = (): boolean => {
      if (markReady()) return true;
      setReadiness((current) =>
        advanceResidentFrameReadiness(current, "disconnected"),
      );
      armReadinessDeadline();
      return false;
    };
    const unsubscribeEndpoints = subscribeEndpointChanges(refreshReadiness);
    refreshReadiness();
    const unsubscribeAuthority = useAppsStore.subscribe((state) => {
      if (
        active &&
        !backgroundFrameAuthorityCurrent(endpointAuthority, state)
      ) {
        active = false;
        unregister();
      }
    });
    return () => {
      active = false;
      if (readinessTimer !== undefined) {
        globalThis.clearTimeout(readinessTimer);
      }
      unsubscribeEndpoints();
      unsubscribeAuthority();
      unregister();
    };
  }, [
    app.version,
    appGeneration,
    appId,
    installationUid,
    ordinaryFramePolicy,
    residentSecurity?.origin,
    residentSecurity?.credentialless,
    residentSecurity?.binding.mode,
    residentSecurity?.binding.browserOriginNonce,
    residentSecurity?.binding.browserOriginAuthorityEpoch,
    endpointAuthority,
    readiness.attempt,
    src,
  ]);

  return (
    <iframe
      key={readiness.attempt}
      ref={iframeRef}
      className="app-background-frame"
      data-tid="app-background-frame"
      data-app-id={appId}
      onLoad={() => {
        if (iframeRef.current?.getAttribute("src") !== src) return;
        const result = markFrameEndpointLoaded(
          iframeRef.current?.contentWindow ?? null,
        );
        if (result !== "preserved") {
          setReadiness((current) =>
            advanceResidentFrameReadiness(current, "disconnected"),
          );
        }
      }}
      data-resident-launch={
        launchFailure
          ? "blocked"
          : readiness.phase === "ready"
            ? "ready"
            : readiness.attempt === 0
              ? "preflight"
              : "retry"
      }
      {...(launchFailure
        ? { "data-resident-launch-error": launchFailure }
        : {})}
      {...(residentSecurity ? { sandbox: residentSecurity.sandbox } : {})}
      title={`${app.name} background`}
      tabIndex={-1}
      {...(ordinaryFramePolicy || residentSecurity?.credentialless
        ? CREDENTIALLESS_APP_FRAME_PROPS
        : {})}
    />
  );
});

export function backgroundFrameSecurity(
  appId: string,
  app: AppRegistryEntry,
  src: string,
  canisterId: string,
  browserOriginNonce: string,
  browserOriginAuthorityEpoch: string,
): BackgroundFrameSecurity {
  const mode = residentFrameSecurityMode(app);
  const binding = Object.freeze({
    mode,
    browserOriginNonce,
    browserOriginAuthorityEpoch,
  });
  assertResidentFrameSecurityBinding(binding);
  const dedicated =
    mode !== ResidentFrameSecurityMode.CREDENTIALLESS_OPAQUE_V1;
  const correctOrigin = isDedicatedAppOrigin(
    src,
    canisterId,
    appId,
    dedicated ? browserOriginNonce : undefined,
  );
  if (!correctOrigin) {
    throw new Error(
      dedicated
        ? "Dedicated resident frame does not match its current origin authority"
        : "Opaque resident frame does not match its app origin",
    );
  }
  return mode === ResidentFrameSecurityMode.PERSISTENT_DEDICATED_V1
    ? {
        binding,
        credentialless: false,
        origin: new URL(src).origin,
        sandbox: ORIGINFUL_APP_FRAME_SANDBOX,
      }
    : mode ===
        ResidentFrameSecurityMode.CREDENTIALLESS_EPHEMERAL_DEDICATED_V1
      ? {
          binding,
          credentialless: true,
          origin: new URL(src).origin,
          sandbox: ORIGINFUL_APP_FRAME_SANDBOX,
        }
      : {
          binding,
          credentialless: true,
          origin: "null",
          sandbox: OPAQUE_APP_FRAME_SANDBOX,
        };
}

export type BackgroundFrameSecurity = Readonly<{
  binding: ResidentFrameSecurityBinding;
  credentialless: boolean;
  origin: string;
  sandbox:
    | typeof OPAQUE_APP_FRAME_SANDBOX
    | typeof ORIGINFUL_APP_FRAME_SANDBOX;
}>;

export function assertBackgroundFramePreflight(
  iframe: HTMLIFrameElement,
  mode: ResidentFrameSecurityModeValue,
): Window {
  const source = iframe.contentWindow as CredentiallessWindow | null;
  if (!source) {
    throw new Error("Resident frame has no initial Window");
  }
  const frameCredentialless = (iframe as CredentiallessIFrame).credentialless;
  if (mode !== ResidentFrameSecurityMode.PERSISTENT_DEDICATED_V1) {
    if (frameCredentialless !== true) {
      throw new Error(
        "This browser does not provide the required credentialless resident frame",
      );
    }
    // The opaque sandbox intentionally prevents the kernel from inspecting
    // its initial Window. The dedicated ephemeral frame retains same-origin
    // solely for this pre-navigation proof and for its Worker.
    if (
      mode ===
        ResidentFrameSecurityMode.CREDENTIALLESS_EPHEMERAL_DEDICATED_V1 &&
      !credentiallessOriginfulFrameSupported(iframe)
    ) {
      throw new Error(
        "This browser does not provide the required credentialless resident Window",
      );
    }
  } else if (frameCredentialless === true || source.credentialless === true) {
    throw new Error(
      "Persistent resident frame unexpectedly inherited credentialless mode",
    );
  }
  return source;
}

export function backgroundFrameEntries(
  apps: Record<string, AppRegistryEntry>
): Array<[string, AppRegistryEntry]> {
  assertAppSurfaceInventoryCapacity(apps);
  return Object.entries(apps).filter((entry) => Boolean(entry[1].background));
}

export function runnableBackgroundFrameEntries(
  apps: Record<string, AppRegistryEntry>,
  appInstances: Readonly<Record<string, AppInstanceProjection>>,
  authorityPending: boolean,
): Array<[string, AppRegistryEntry]> {
  if (authorityPending) return [];
  return backgroundFrameEntries(apps).filter(
    ([appId]) => appInstances[appId] !== undefined,
  );
}

export function backgroundKey(
  appId: string,
  app: AppRegistryEntry,
  appInstance: AppInstanceProjection,
  browserSurfaceOriginAdopted: boolean,
): string {
  const mode = residentFrameSecurityMode(app);
  if (appInstance.residentFrameSecurity !== mode) {
    throw new Error(
      "Resident frame security does not match the current runtime authority",
    );
  }
  return [
    appId,
    app.version,
    app.background?.path ?? "",
    app.capability_plan_fingerprint,
    appInstance.capabilityPlanFingerprint,
    appInstance.deploymentId,
    appInstance.scope.installationUid,
    browserSurfaceOriginAdopted ? "surface-v26" : "surface-v25",
    mode,
    appInstance.browserOriginNonce,
    appInstance.browserOriginAuthorityEpoch,
  ].join(":");
}

type BackgroundFrameEndpointAuthority = AppFrameEndpointAuthority & Readonly<{
  binding?: ResidentFrameSecurityBinding;
}>;

type ResidentFrameEndpointAuthority = BackgroundFrameEndpointAuthority &
  Readonly<{
    binding: ResidentFrameSecurityBinding;
  }>;

type AppsStateSnapshot = ReturnType<typeof useAppsStore.getState>;

export function residentFrameAuthorityCurrent(
  expected: ResidentFrameEndpointAuthority,
  state: AppsStateSnapshot,
): boolean {
  if (!backgroundFrameBaseAuthorityCurrent(expected, state)) return false;
  const app = state.list[expected.appId]!;
  const instance = state.appInstances[expected.appId]!;
  if (
    instance.browserOriginNonce !== expected.binding.browserOriginNonce ||
    instance.browserOriginAuthorityEpoch !==
      expected.binding.browserOriginAuthorityEpoch ||
    instance.residentFrameSecurity !== expected.binding.mode
  ) return false;
  try {
    return residentFrameSecurityMode(app) === expected.binding.mode;
  } catch {
    return false;
  }
}

export function ordinaryBackgroundFrameAuthorityCurrent(
  expected: BackgroundFrameEndpointAuthority,
  state: AppsStateSnapshot,
): boolean {
  if (!backgroundFrameBaseAuthorityCurrent(expected, state)) return false;
  const app = state.list[expected.appId]!;
  const instance = state.appInstances[expected.appId]!;
  try {
    return (
      instance.residentFrameSecurity ===
        ResidentFrameSecurityMode.CREDENTIALLESS_OPAQUE_V1 &&
      residentFrameSecurityMode(app) ===
        ResidentFrameSecurityMode.CREDENTIALLESS_OPAQUE_V1
    );
  } catch {
    return false;
  }
}

function backgroundFrameAuthorityCurrent(
  expected: BackgroundFrameEndpointAuthority,
  state: AppsStateSnapshot,
): boolean {
  return expected.binding
    ? residentFrameAuthorityCurrent(
        expected as ResidentFrameEndpointAuthority,
        state,
      )
    : ordinaryBackgroundFrameAuthorityCurrent(expected, state);
}

function backgroundFrameBaseAuthorityCurrent(
  expected: BackgroundFrameEndpointAuthority,
  state: AppsStateSnapshot,
): boolean {
  return appFrameAuthorityCurrent(
    expected,
    state,
    isAuthorityPendingState(state),
  );
}
