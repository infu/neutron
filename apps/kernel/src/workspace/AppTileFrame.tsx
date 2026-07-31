import { memo, useLayoutEffect, useRef, useState } from "react";
import { appIndexUrl } from "neutron-tools/src/runtime.js";
import { getNeutronId } from "../config.ts";
import {
  ensureFrameEndpointConnected,
  registerFrameContext,
} from "../frame_context.ts";
import {
  isAuthorityPendingState,
  useAppsStore,
} from "../reducer/apps.ts";
import type { TileInstance, WorkspaceId } from "./types.ts";
import { usesUnprefixedAppFrameOrigin } from "../capabilities/plan.ts";
import { nextStartedTileRuntime } from "./tile_frame_lifecycle.ts";
import {
  assertRuntimeFrameUrl,
  getRuntimeDeployment,
} from "../runtime_deployment.ts";

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
  const app = useAppsStore((state) => state.list[tile.appId]);
  const appInstance = useAppsStore(
    (state) => state.appInstances[tile.appId],
  );
  const authorityPending = useAppsStore(isAuthorityPendingState);
  const appInstalled = Boolean(app && appInstance && !authorityPending);
  const appGeneration = useAppsStore(
    (state) => state.runtimeGenerations[tile.appId] ?? 0,
  );
  const appVersion = app?.version ?? 0;
  const installationUid = appInstance?.scope.installationUid;
  const deployment = getRuntimeDeployment();
  const unprefixed = usesUnprefixedAppFrameOrigin(app);
  const src = assertRuntimeFrameUrl(
    appIndexUrl({
      canisterId: getNeutronId(),
      appId: tile.appId,
      path: tile.path,
      tileId: tile.tileId,
      instanceId: tile.id,
      workspace: workspaceId,
      unprefixed,
      local: deployment.local,
      ...(deployment.localHost ? { localHost: deployment.localHost } : {}),
    }),
    !unprefixed,
    deployment,
  );
  const runtimeIdentity = appInstalled
    ? `${appVersion}:${appGeneration}:${installationUid ?? "unbound"}:${src}`
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
    if (!active || !frameStarted || !appInstalled || !appInstance) return;
    const source = iframeRef.current?.contentWindow ?? null;
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
        origin: "null",
      },
    );
    // Initial documents connect from onLoad. A retained frame has already
    // loaded, so reconnect its fresh endpoint immediately on reactivation.
    if (loadedRuntimeRef.current === runtimeIdentity) {
      ensureFrameEndpointConnected(source);
    }
    return unregister;
  }, [
    active,
    appInstalled,
    frameStarted,
    appGeneration,
    appVersion,
    installationUid,
    runtimeIdentity,
    src,
    tile.appId,
    tile.id,
    tile.tileId,
    workspaceId,
  ]);

  if (!appInstalled || !frameStarted || !runtimeIdentity) return null;

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
        loadedRuntimeRef.current = runtimeIdentity;
        if (active) {
          ensureFrameEndpointConnected(iframeRef.current?.contentWindow ?? null);
        }
      }}
      sandbox="allow-scripts"
      src={src}
      title={tile.title}
      {...({ credentialless: "true" } as Record<string, string>)}
    />
  );
});
