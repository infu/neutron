import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  markFrameEndpointLoaded,
  registerFrameContext,
} from "../frame_context.ts";
import {
  appFrameAuthorityCurrent,
  appFrameEndpointAuthority,
  CREDENTIALLESS_APP_FRAME_PROPS,
  ordinaryAppFramePolicy,
  prepareOrdinaryAppFrame,
} from "../app_frame_security.ts";
import {
  isAuthorityPendingState,
  useAppsStore,
} from "../reducer/apps.ts";
import type { TileInstance, WorkspaceId } from "./types.ts";
import { nextStartedTileRuntime } from "./tile_frame_lifecycle.ts";
import { getRuntimeDeployment } from "../runtime_deployment.ts";

export const AppTileFrame = memo(function AppTileFrame({
  active,
  tile,
  workspaceId,
}: {
  active: boolean;
  tile: TileInstance;
  workspaceId: WorkspaceId;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const launchedFrameRef = useRef<{
    runtimeIdentity: string;
    source: Window;
    origin: string;
  } | null>(null);
  const app = useAppsStore((state) => state.list[tile.appId]);
  const appInstance = useAppsStore(
    (state) => state.appInstances[tile.appId],
  );
  const authorityPending = useAppsStore(isAuthorityPendingState);
  const browserSurfaceOriginAdopted = useAppsStore(
    (state) => state.browserSurfaceOriginAppIds.includes(tile.appId),
  );
  const appInstalled = Boolean(app && appInstance && !authorityPending);
  const appGeneration = useAppsStore(
    (state) => state.runtimeGenerations[tile.appId] ?? 0,
  );
  const appVersion = app?.version ?? 0;
  const installationUid = appInstance?.scope.installationUid;
  const deployment = getRuntimeDeployment();
  const framePolicy = useMemo(
    () =>
      app && appInstance && !authorityPending
        ? ordinaryAppFramePolicy({
            appId: tile.appId,
            app,
            appInstance,
            endpoint: {
              role: "tile",
              path: tile.path,
              tileId: tile.tileId,
              instanceId: tile.id,
              workspace: workspaceId,
            },
            deployment,
            browserSurfaceOriginAdopted,
          })
        : null,
    [
      app,
      appInstance,
      authorityPending,
      browserSurfaceOriginAdopted,
      deployment,
      tile.appId,
      tile.id,
      tile.path,
      tile.tileId,
      workspaceId,
    ],
  );
  const endpointAuthority = useMemo(
    () =>
      app && appInstance && !authorityPending
        ? appFrameEndpointAuthority({
            appId: tile.appId,
            app,
            appInstance,
            appGeneration,
            browserSurfaceOriginAdopted,
          })
        : null,
    [
      app,
      appGeneration,
      appInstance,
      authorityPending,
      browserSurfaceOriginAdopted,
      tile.appId,
    ],
  );
  const runtimeIdentity = appInstalled
    ? `${appVersion}:${appGeneration}:${installationUid ?? "unbound"}:${browserSurfaceOriginAdopted ? "surface-v26" : "surface-v25"}:${framePolicy?.src ?? "unbound"}`
    : null;
  const loadedRuntimeRef = useRef<string | null>(null);
  const [startedRuntime, setStartedRuntime] = useState<string | null>(null);
  const frameStarted =
    runtimeIdentity !== null && startedRuntime === runtimeIdentity;

  useLayoutEffect(() => {
    if (loadedRuntimeRef.current !== runtimeIdentity) {
      loadedRuntimeRef.current = null;
    }
    setStartedRuntime((current) =>
      nextStartedTileRuntime(current, runtimeIdentity, active),
    );
  }, [active, runtimeIdentity]);

  useLayoutEffect(() => {
    if (
      !active ||
      !frameStarted ||
      !appInstalled ||
      !appInstance ||
      !framePolicy ||
      !endpointAuthority ||
      !runtimeIdentity
    ) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    let launched = launchedFrameRef.current;
    if (
      !launched ||
      launched.runtimeIdentity !== runtimeIdentity ||
      launched.source !== iframe.contentWindow
    ) {
      const prepared = prepareOrdinaryAppFrame(iframe, framePolicy);
      launched = {
        runtimeIdentity,
        source: prepared.source,
        origin: prepared.origin,
      };
      launchedFrameRef.current = launched;
    }
    const source = launched.source;
    const unregister = registerFrameContext(
      source,
      {
        role: "tile",
        appId: tile.appId,
        tileId: tile.tileId,
        instanceId: tile.id,
        workspace: workspaceId,
      },
      {
        appVersion,
        appGeneration,
        appScope: {
          appId: tile.appId,
          installationUid: appInstance.scope.installationUid,
        },
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
    if (loadedRuntimeRef.current === runtimeIdentity) {
      markFrameEndpointLoaded(source);
    }
    return unregister;
  }, [
    active,
    appInstalled,
    frameStarted,
    appGeneration,
    appVersion,
    endpointAuthority,
    framePolicy,
    installationUid,
    runtimeIdentity,
    tile.appId,
    tile.id,
    tile.tileId,
    workspaceId,
  ]);

  if (!appInstalled || !frameStarted || !runtimeIdentity || !framePolicy) {
    return null;
  }

  return (
    <iframe
      key={`${tile.id}:${runtimeIdentity}`}
      ref={iframeRef}
      className="tile-iframe"
      data-tid="app-frame"
      data-app-id={tile.appId}
      data-tile-id={tile.tileId}
      data-instance-id={tile.id}
      onLoad={() => {
        if (iframeRef.current?.getAttribute("src") !== framePolicy.src) return;
        loadedRuntimeRef.current = runtimeIdentity;
        if (active) {
          markFrameEndpointLoaded(
            iframeRef.current?.contentWindow ?? null,
          );
        }
      }}
      title={tile.title}
      {...CREDENTIALLESS_APP_FRAME_PROPS}
    />
  );
});
