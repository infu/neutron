import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { IoNotificationsOutline } from "react-icons/io5";
import type { AppRegistryEntry } from "neutron-compiler/src/install.js";
import type { AppInstanceProjection } from "../app_scope.ts";
import {
  appFrameAuthorityCurrent,
  appFrameEndpointAuthority,
  CREDENTIALLESS_APP_FRAME_PROPS,
  ordinaryAppFramePolicy,
  prepareOrdinaryAppFrame,
} from "../app_frame_security.ts";
import { getRuntimeDeployment } from "../runtime_deployment.ts";
import {
  markFrameEndpointLoaded,
  registerFrameContext,
} from "../frame_context.ts";
import {
  isAuthorityPendingState,
  useAppsStore,
} from "../reducer/apps.ts";
import {
  subscribeTrayDismiss,
  useTrayStore,
} from "../tray/service.ts";
import { TrayPopover } from "./TrayPopover.tsx";

export function AppTray({ children }: { children?: ReactNode }) {
  const apps = useAppsStore((state) => state.list);
  const appInstances = useAppsStore((state) => state.appInstances);
  const runtimeGenerations = useAppsStore((state) => state.runtimeGenerations);
  const authorityPending = useAppsStore(isAuthorityPendingState);
  const browserSurfaceOriginAppIds = useAppsStore(
    (state) => state.browserSurfaceOriginAppIds,
  );
  const trayStates = useTrayStore((state) => state.apps);
  const entries = (authorityPending ? [] : Object.entries(apps))
    .filter((entry): entry is [string, AppRegistryEntry] =>
      Boolean(
        entry[1].tray && entry[1].background && appInstances[entry[0]],
      ),
    )
    .sort(([leftId], [rightId]) => leftId.localeCompare(rightId));

  return (
    <div className="app-tray" aria-label="System tray" role="group">
      {entries.length > 0 ? (
        <div className="app-tray-apps" aria-label="App tray" role="group">
          {entries.map(([appId, app]) => (
            <AppTrayItem
              app={app}
              appId={appId}
              appGeneration={runtimeGenerations[appId] ?? 0}
              appInstance={appInstances[appId]!}
              badge={trayStates[appId]?.badge ?? null}
              browserSurfaceOriginAdopted={
                browserSurfaceOriginAppIds.includes(appId)
              }
              key={[
                appId,
                app.version,
                appInstances[appId]!.scope.installationUid,
                runtimeGenerations[appId] ?? 0,
                app.tray?.path ?? "",
                app.tray?.icon ?? "",
                browserSurfaceOriginAppIds.includes(appId)
                  ? "surface-v26"
                  : "surface-v25",
              ].join(":")}
            />
          ))}
        </div>
      ) : null}
      {children}
    </div>
  );
}

function AppTrayItem({
  appId,
  app,
  appGeneration,
  appInstance,
  badge,
  browserSurfaceOriginAdopted,
}: {
  appId: string;
  app: AppRegistryEntry;
  appGeneration: number;
  appInstance: AppInstanceProjection;
  badge: number | null;
  browserSurfaceOriginAdopted: boolean;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [instanceId, setInstanceId] = useState<string | null>(null);
  const [iconFailed, setIconFailed] = useState(false);
  const tray = app.tray!;
  const popoverId = `app-tray-popover-${appId}`;
  const itemLabel = trayButtonLabel(`${tray.title}, app ${appId}`, badge);

  useEffect(() => setIconFailed(false), [tray.icon]);

  const handleOpenChange = useCallback((isOpen: boolean) => {
    setInstanceId((current) =>
      isOpen ? current ?? createTrayInstanceId() : null,
    );
  }, []);

  useEffect(
    () =>
      subscribeTrayDismiss((dismissedAppId, dismissedInstanceId) => {
        if (
          dismissedAppId === appId &&
          dismissedInstanceId === instanceId &&
          popoverRef.current?.matches(":popover-open")
        ) {
          popoverRef.current.hidePopover();
        }
      }),
    [appId, instanceId],
  );

  return (
    <TrayPopover
      buttonLabel={itemLabel}
      dataAppId={appId}
      onOpenChange={handleOpenChange}
      popoverId={popoverId}
      popoverRef={popoverRef}
      popoverTestId={`app-tray-popover-${appId}`}
      subtitle={trayIdentitySubtitle(tray.title, appId, app.name)}
      title={tray.title}
      trigger={
        <>
          {iconFailed ? (
            <IoNotificationsOutline aria-hidden="true" />
          ) : (
            <img
              alt=""
              draggable={false}
              onError={() => setIconFailed(true)}
              src={tray.icon}
            />
          )}
          {badge ? (
            <span aria-hidden="true" className="app-tray-badge">
              {formatTrayBadge(badge)}
            </span>
          ) : null}
        </>
      }
      triggerTestId={`app-tray-button-${appId}`}
    >
      {instanceId ? (
        <AppTrayFrame
          app={app}
          appId={appId}
          appGeneration={appGeneration}
          appInstance={appInstance}
          browserSurfaceOriginAdopted={browserSurfaceOriginAdopted}
          instanceId={instanceId}
          key={instanceId}
        />
      ) : null}
    </TrayPopover>
  );
}

const AppTrayFrame = memo(function AppTrayFrame({
  appId,
  app,
  appGeneration,
  appInstance,
  instanceId,
  browserSurfaceOriginAdopted,
}: {
  appId: string;
  app: AppRegistryEntry;
  appGeneration: number;
  appInstance: AppInstanceProjection;
  instanceId: string;
  browserSurfaceOriginAdopted: boolean;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const launchedFrameRef = useRef<{
    src: string;
    source: Window;
    origin: string;
  } | null>(null);
  const deployment = getRuntimeDeployment();
  const installationUid = appInstance.scope.installationUid;
  const tray = app.tray;
  if (!tray) {
    throw new Error(`App '${appId}' has no tray`);
  }
  const framePolicy = useMemo(
    () =>
      ordinaryAppFramePolicy({
        appId,
        app,
        appInstance,
        endpoint: {
          role: "tray",
          path: tray.path,
          instanceId,
        },
        deployment,
        browserSurfaceOriginAdopted,
      }),
    [
      app,
      appId,
      appInstance,
      browserSurfaceOriginAdopted,
      deployment,
      instanceId,
      tray.path,
    ],
  );
  const endpointAuthority = useMemo(
    () =>
      appFrameEndpointAuthority({
        appId,
        app,
        appInstance,
        appGeneration,
        browserSurfaceOriginAdopted,
      }),
    [
      app,
      appGeneration,
      appId,
      appInstance,
      browserSurfaceOriginAdopted,
    ],
  );

  useLayoutEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    let launched = launchedFrameRef.current;
    if (
      !launched ||
      launched.src !== framePolicy.src ||
      launched.source !== iframe.contentWindow
    ) {
      const prepared = prepareOrdinaryAppFrame(iframe, framePolicy);
      launched = {
        src: framePolicy.src,
        source: prepared.source,
        origin: prepared.origin,
      };
      launchedFrameRef.current = launched;
    }
    const source = launched.source;
    const unregister = registerFrameContext(
      source,
      { role: "tray", appId, instanceId },
      {
        appVersion: app.version,
        appGeneration,
        appScope: { appId, installationUid },
        origin: launched.origin,
        isAuthorityCurrent: () => {
          const state = useAppsStore.getState();
          return appFrameAuthorityCurrent(
            endpointAuthority,
            state,
            isAuthorityPendingState(state),
          );
        },
      },
    );
    if (iframe.getAttribute("src") !== framePolicy.src) {
      iframe.setAttribute("src", framePolicy.src);
    }
    return unregister;
  }, [
    app.version,
    appGeneration,
    appId,
    endpointAuthority,
    framePolicy,
    installationUid,
    instanceId,
  ]);

  return (
    <iframe
      className="app-tray-frame"
      data-app-id={appId}
      data-instance-id={instanceId}
      data-tid="app-tray-frame"
      onLoad={() => {
        if (iframeRef.current?.getAttribute("src") !== framePolicy.src) return;
        markFrameEndpointLoaded(iframeRef.current?.contentWindow ?? null);
      }}
      ref={iframeRef}
      title={`${app.tray?.title ?? app.name} panel`}
      {...CREDENTIALLESS_APP_FRAME_PROPS}
    />
  );
});

export function formatTrayBadge(badge: number): string {
  return badge > 99 ? "99+" : String(badge);
}

export function trayButtonLabel(title: string, badge: number | null): string {
  if (!badge) return title;
  return `${title}, ${badge} new item${badge === 1 ? "" : "s"}`;
}

export function trayIdentitySubtitle(
  title: string,
  appId: string,
  appName: string,
): string | null {
  const seen = new Set([title.trim().toLowerCase()]);
  const distinct = [appId, appName].flatMap((value) => {
    const trimmed = value.trim();
    const normalized = trimmed.toLowerCase();
    if (!trimmed || seen.has(normalized)) return [];
    seen.add(normalized);
    return [trimmed];
  });
  return distinct.length > 0 ? distinct.join(" · ") : null;
}

export { positionTrayPopover } from "./TrayPopover.tsx";

function createTrayInstanceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replaceAll("-", "");
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}
