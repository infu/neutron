import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { IoNotificationsOutline } from "react-icons/io5";
import { appTrayUrl } from "neutron-tools/src/runtime.js";
import { usesUnprefixedAppFrameOrigin } from "../capabilities/plan.ts";
import type { AppRegistryEntry } from "neutron-compiler/src/install.js";
import type { AppInstanceProjection } from "../app_scope.ts";
import { getNeutronId } from "../config.ts";
import {
  assertRuntimeFrameUrl,
  getRuntimeDeployment,
} from "../runtime_deployment.ts";
import {
  ensureFrameEndpointConnected,
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
              key={[
                appId,
                app.version,
                appInstances[appId]!.scope.installationUid,
                runtimeGenerations[appId] ?? 0,
                app.tray?.path ?? "",
                app.tray?.icon ?? "",
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
}: {
  appId: string;
  app: AppRegistryEntry;
  appGeneration: number;
  appInstance: AppInstanceProjection;
  badge: number | null;
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
      subtitle={<>{appId} · {app.name}</>}
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
}: {
  appId: string;
  app: AppRegistryEntry;
  appGeneration: number;
  appInstance: AppInstanceProjection;
  instanceId: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const loadedSrcRef = useRef<string | null>(null);
  const deployment = getRuntimeDeployment();
  const unprefixed = usesUnprefixedAppFrameOrigin(app);
  const installationUid = appInstance.scope.installationUid;
  const tray = app.tray;
  if (!tray) {
    throw new Error(`App '${appId}' has no tray`);
  }
  const src = assertRuntimeFrameUrl(
    appTrayUrl({
      canisterId: getNeutronId(),
      appId,
      path: tray.path,
      instanceId,
      unprefixed,
      local: deployment.local,
      ...(deployment.localHost ? { localHost: deployment.localHost } : {}),
    }),
    !unprefixed,
    deployment,
  );

  useLayoutEffect(() => {
    const source = iframeRef.current?.contentWindow ?? null;
    const unregister = registerFrameContext(
      source,
      { role: "tray", appId, instanceId },
      {
        appVersion: app.version,
        appGeneration,
        appScope: { appId, installationUid },
        origin: "null",
      },
    );
    // Pair registration with either ordering of React's layout phase and a
    // cached iframe's load event. Exactly one side observes the other first.
    if (loadedSrcRef.current === src) ensureFrameEndpointConnected(source);
    return unregister;
  }, [app.version, appGeneration, appId, installationUid, instanceId, src]);

  return (
    <iframe
      className="app-tray-frame"
      data-app-id={appId}
      data-instance-id={instanceId}
      data-tid="app-tray-frame"
      onLoad={() => {
        loadedSrcRef.current = src;
        ensureFrameEndpointConnected(iframeRef.current?.contentWindow ?? null);
      }}
      ref={iframeRef}
      sandbox="allow-scripts"
      src={src}
      title={`${app.tray?.title ?? app.name} panel`}
      {...({ credentialless: "true" } as Record<string, string>)}
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

export { positionTrayPopover } from "./TrayPopover.tsx";

function createTrayInstanceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replaceAll("-", "");
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}
