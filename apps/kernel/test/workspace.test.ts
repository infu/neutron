import { beforeEach, expect, test } from "bun:test";
import { layoutTiles, tileIdsInLayout } from "../src/workspace/layout.ts";
import {
  isLauncherShortcutEvent,
  isLayoutModifierEvent,
  isSystemModifierEvent,
} from "../src/workspace/modifier.ts";
import {
  launcherEntriesFromApps,
  launcherSystemActions,
} from "../src/workspace/launcher_entries.ts";
import {
  type WorkspaceMap,
  useWorkspaceStore,
  visibleWorkspaceIds,
  workspaceIds,
} from "../src/workspace/store.ts";
import { updateRatio } from "../src/workspace/tree.ts";
import { nextStartedTileRuntime } from "../src/workspace/tile_frame_lifecycle.ts";
import {
  assertBackgroundFramePreflight,
  advanceResidentFrameReadiness,
  backgroundKey,
  backgroundFrameEntries,
  backgroundFrameSecurity,
  INITIAL_RESIDENT_FRAME_READINESS,
  residentFrameAuthorityCurrent,
  runnableBackgroundFrameEntries,
} from "../src/workspace/AppBackgroundFrames.tsx";
import {
  ResidentFrameSecurityMode,
  selectResidentFrameSecurityMode,
} from "../src/capabilities/plan.ts";
import { frameRequestLabel } from "../src/request_label.ts";
import type {
  TileLaunchRequest,
  WorkspaceId,
  WorkspaceState,
} from "../src/workspace/types.ts";
import { registryApp } from "./app_registry_fixture.ts";
import { useAppsStore } from "../src/reducer/apps.ts";
import { MAX_RESIDENT_APP_FRAMES } from "../src/runtime_limits.ts";

const helloTile: TileLaunchRequest = {
  appId: "hello",
  tileId: "main",
  title: "Hello: Main",
  path: "index.html",
  icon: "/app/hello/static/icon.png",
};

beforeEach(() => {
  useWorkspaceStore.setState({
    activeWorkspaceId: 1,
    workspaceDropTargetId: null,
    workspaces: emptyWorkspaces(),
  });
  useAppsStore.setState({
    list: {},
    appInstances: {},
    runtimeGenerations: {},
    operation: null,
    pendingInstallRecovery: null,
    runtimeAuthorityFence: null,
  });
});

test("workspace store starts with three workspaces", () => {
  const state = useWorkspaceStore.getState();
  expect(workspaceIds).toHaveLength(20);
  expect(
    workspaceIds.every((workspaceId, index) => workspaceId === index + 1),
  ).toBe(true);
  expect(
    Object.keys(state.workspaces)
      .map(Number)
      .sort((left, right) => left - right),
  ).toEqual([1, 2, 3]);
  expect(visibleWorkspaceIds(state)).toEqual([1, 2, 3]);
});

test("a fourth workspace appears only after the initial three are occupied", () => {
  useWorkspaceStore.getState().openTile(helloTile);
  expect(visibleWorkspaceIds(useWorkspaceStore.getState())).toEqual([1, 2, 3]);

  useWorkspaceStore.getState().switchWorkspace(2);
  useWorkspaceStore.getState().openTile({
    ...helloTile,
    tileId: "main-2",
    title: "Hello: Workspace 2",
  });
  expect(visibleWorkspaceIds(useWorkspaceStore.getState())).toEqual([1, 2, 3]);

  useWorkspaceStore.getState().switchWorkspace(3);
  useWorkspaceStore.getState().openTile({
    ...helloTile,
    tileId: "main-3",
    title: "Hello: Workspace 3",
  });
  expect(visibleWorkspaceIds(useWorkspaceStore.getState())).toEqual([
    1, 2, 3, 4,
  ]);
});

test("sequentially filling workspaces reveals at most twenty", () => {
  for (const [index, workspaceId] of workspaceIds.entries()) {
    useWorkspaceStore.getState().switchWorkspace(workspaceId);
    useWorkspaceStore.getState().openTile({
      ...helloTile,
      tileId: `main-${workspaceId}`,
      title: `Hello: Workspace ${workspaceId}`,
    });

    expect(visibleWorkspaceIds(useWorkspaceStore.getState())).toEqual(
      workspaceIds.slice(
        0,
        Math.min(Math.max(3, index + 2), workspaceIds.length),
      ),
    );
  }

  const visible = visibleWorkspaceIds(useWorkspaceStore.getState());
  expect(visible).toHaveLength(20);
  expect(visible.at(-1)).toBe(20);
  expect(visible).not.toContain(21);
});

test("visibility contracts after closing the highest tile and keeps its active empty workspace", () => {
  const tiles = workspaceIds.slice(0, 4).map((workspaceId) => {
    useWorkspaceStore.getState().switchWorkspace(workspaceId);
    return useWorkspaceStore.getState().openTile({
      ...helloTile,
      tileId: `main-${workspaceId}`,
      title: `Hello: Workspace ${workspaceId}`,
    });
  });

  expect(visibleWorkspaceIds(useWorkspaceStore.getState())).toEqual(
    workspaceIds.slice(0, 5),
  );

  useWorkspaceStore.getState().closeTile(tiles[3]!.id);

  const state = useWorkspaceStore.getState();
  expect(state.activeWorkspaceId).toBe(4);
  expect(state.workspaces[4]!.tiles).toEqual([]);
  expect(visibleWorkspaceIds(state)).toEqual(workspaceIds.slice(0, 4));
});

test("replacement tile frames cold-start only in the active workspace", () => {
  expect(nextStartedTileRuntime(null, "runtime-a", false)).toBeNull();
  expect(nextStartedTileRuntime(null, "runtime-a", true)).toBe("runtime-a");
  expect(nextStartedTileRuntime("runtime-a", "runtime-a", false)).toBe(
    "runtime-a",
  );
  expect(nextStartedTileRuntime("runtime-a", "runtime-b", false)).toBeNull();
  expect(nextStartedTileRuntime(null, "runtime-b", true)).toBe("runtime-b");
  expect(nextStartedTileRuntime("runtime-b", null, true)).toBeNull();
});

test("opening the same app tile creates multiple instances", () => {
  const first = useWorkspaceStore.getState().openTile(helloTile);
  const second = useWorkspaceStore.getState().openTile(helloTile);
  const workspace = useWorkspaceStore.getState().workspaces[1];

  expect(first.id).not.toBe(second.id);
  expect(workspace.tiles.map((tile) => tile.id)).toEqual([first.id, second.id]);
  expect(workspace.focusedTileId).toBe(second.id);
  expect(workspace.layout?.type).toBe("split");
});

test("closing the last tile leaves the workspace empty", () => {
  const tile = useWorkspaceStore.getState().openTile(helloTile);

  useWorkspaceStore.getState().closeTile(tile.id);

  const workspace = useWorkspaceStore.getState().workspaces[1];
  expect(workspace.tiles).toEqual([]);
  expect(workspace.layout).toBeNull();
  expect(workspace.focusedTileId).toBeNull();
});

test("closing the focused tile moves focus to a visible remaining tile", () => {
  const first = useWorkspaceStore.getState().openTile(helloTile);
  const second = useWorkspaceStore.getState().openTile({
    ...helloTile,
    tileId: "tools",
    title: "Hello: Tools",
  });
  const third = useWorkspaceStore.getState().openTile({
    ...helloTile,
    tileId: "logs",
    title: "Hello: Logs",
  });

  useWorkspaceStore.getState().focusTile(second.id);
  useWorkspaceStore.getState().closeTile(second.id);

  const workspace = useWorkspaceStore.getState().workspaces[1];
  expect(workspace.tiles.map((tile) => tile.id)).toEqual([first.id, third.id]);
  expect(workspace.focusedTileId).not.toBe(second.id);
  expect(workspace.focusedTileId).toBeTruthy();
  expect(
    workspace.tiles.some((tile) => tile.id === workspace.focusedTileId),
  ).toBe(true);
});

test("workspace store switches between independent workspaces", () => {
  const first = useWorkspaceStore.getState().openTile(helloTile);
  useWorkspaceStore.getState().switchWorkspace(2);
  const second = useWorkspaceStore.getState().openTile({
    ...helloTile,
    tileId: "tools",
    title: "Hello: Tools",
  });
  useWorkspaceStore.getState().switchWorkspace(1);

  const state = useWorkspaceStore.getState();
  expect(state.activeWorkspaceId).toBe(1);
  expect(state.workspaces[1].tiles.map((tile) => tile.id)).toEqual([first.id]);
  expect(state.workspaces[2].tiles.map((tile) => tile.id)).toEqual([second.id]);
  expect(state.workspaces[3].tiles).toEqual([]);
  expect(state.workspaces[4]).toBeUndefined();
});

test("moving a tile between workspaces atomically moves the exact requested tile", () => {
  const requested = useWorkspaceStore.getState().openTile(helloTile);
  const sourceFocus = useWorkspaceStore.getState().openTile({
    ...helloTile,
    tileId: "tools",
    title: "Hello: Tools",
  });
  useWorkspaceStore.getState().switchWorkspace(2);
  const targetTile = useWorkspaceStore.getState().openTile({
    ...helloTile,
    appId: "notes",
    title: "Notes: Main",
  });
  useWorkspaceStore.getState().switchWorkspace(1);

  expect(useWorkspaceStore.getState().workspaces[1].focusedTileId).toBe(
    sourceFocus.id,
  );

  const observedStates: ReturnType<typeof useWorkspaceStore.getState>[] = [];
  const unsubscribe = useWorkspaceStore.subscribe((state) => {
    observedStates.push(state);
  });
  useWorkspaceStore.getState().moveTileToWorkspace(1, requested.id, 2);
  unsubscribe();

  expect(observedStates).toHaveLength(1);
  const state = useWorkspaceStore.getState();
  expect(state.activeWorkspaceId).toBe(2);
  expect(state.workspaces[1].tiles.map((tile) => tile.id)).toEqual([
    sourceFocus.id,
  ]);
  expect(state.workspaces[1].focusedTileId).toBe(sourceFocus.id);
  expect(state.workspaces[2].tiles.map((tile) => tile.id)).toEqual([
    targetTile.id,
    requested.id,
  ]);
  expect(state.workspaces[2].focusedTileId).toBe(requested.id);
  expect(tileIdsInLayout(state.workspaces[1].layout)).toEqual([
    sourceFocus.id,
  ]);
  expect(tileIdsInLayout(state.workspaces[2].layout).sort()).toEqual(
    [targetTile.id, requested.id].sort(),
  );
});

test("stale tile moves cannot insert phantom layout nodes", () => {
  const first = useWorkspaceStore.getState().openTile(helloTile);
  const second = useWorkspaceStore.getState().openTile({
    ...helloTile,
    appId: "notes",
    title: "Notes: Main",
  });
  const before = useWorkspaceStore.getState().workspaces[1];

  useWorkspaceStore
    .getState()
    .moveTile("missing-source", second.id, "left");
  useWorkspaceStore
    .getState()
    .moveTile(first.id, "missing-target", "right");

  const after = useWorkspaceStore.getState().workspaces[1];
  expect(after.layout).toEqual(before.layout);
  expect(after.focusedTileId).toBe(before.focusedTileId);
  expect(tileIdsInLayout(after.layout).sort()).toEqual(
    after.tiles.map(({ id }) => id).sort(),
  );
});

test("app uninstall removes its tiles from every workspace", () => {
  useWorkspaceStore.getState().openTile(helloTile);
  useWorkspaceStore.getState().switchWorkspace(2);
  useWorkspaceStore.getState().openTile(helloTile);
  useWorkspaceStore.getState().openTile({
    ...helloTile,
    appId: "files",
    tileId: "files",
    title: "Files",
  });

  useWorkspaceStore.getState().removeAppTiles("hello");

  const state = useWorkspaceStore.getState();
  expect(state.workspaces[1].tiles).toEqual([]);
  expect(state.workspaces[1].layout).toBeNull();
  expect(state.workspaces[2].tiles.map((tile) => tile.appId)).toEqual([
    "files",
  ]);
});

test("layout ratios clamp and rects honor the gap", () => {
  const first = useWorkspaceStore.getState().openTile(helloTile);
  const second = useWorkspaceStore.getState().openTile({
    ...helloTile,
    tileId: "tools",
    title: "Hello: Tools",
  });
  const layout = useWorkspaceStore.getState().workspaces[1].layout;
  if (!layout || layout.type !== "split")
    throw new Error("Expected split layout");

  const resized = updateRatio(layout, layout.id, 0.95);
  expect(resized.type).toBe("split");
  if (resized.type !== "split") return;
  expect(resized.ratio).toBe(0.85);

  const rects = {};
  layoutTiles(resized, { x: 0, y: 0, width: 100, height: 80 }, rects, 7);
  expect((rects as Record<string, { width: number }>)[first.id]?.width).toBe(
    79,
  );
  expect((rects as Record<string, { x: number }>)[second.id]?.x).toBe(86);
});

test("plain alt is a layout modifier but not a system shortcut modifier", () => {
  expect(isLayoutModifierEvent({ altKey: true })).toBe(true);
  expect(isSystemModifierEvent({ altKey: true })).toBe(false);
  expect(isSystemModifierEvent({ metaKey: true })).toBe(true);
  expect(
    isSystemModifierEvent({
      getModifierState: (key: string) => key === "Super",
    }),
  ).toBe(true);
});

test("modifier state is invoked with the browser event as this", () => {
  let calledWithEvent = false;
  const event = {
    getModifierState(this: unknown, key: string) {
      calledWithEvent = this === event;
      return key === "Super";
    },
  };

  expect(isSystemModifierEvent(event)).toBe(true);
  expect(calledWithEvent).toBe(true);
});

test("launcher shortcut uses browser-friendly command palette keys", () => {
  expect(isLauncherShortcutEvent({ ctrlKey: true, key: "k" })).toBe(true);
  expect(isLauncherShortcutEvent({ metaKey: true, key: "k" })).toBe(true);
  expect(isLauncherShortcutEvent({ ctrlKey: true, code: "Space" })).toBe(true);
  expect(isLauncherShortcutEvent({ metaKey: true, key: "d" })).toBe(true);
  expect(isLauncherShortcutEvent({ altKey: true, key: "d" })).toBe(false);
});

test("launcher filters app tiles and exposes system action ids", () => {
  const entries = launcherEntriesFromApps(
    {
      kernel: registryApp({ id: "kernel", name: "Kernel" }),
      hello: registryApp({
        id: "hello",
        name: "Hello",
        tiles: [
          {
            id: "main",
            title: "Main",
            path: "index.html",
            icon: "static/icon.png",
          },
          {
            id: "tools",
            title: "Tools",
            path: "tools/index.html",
            icon: "static/tools.png",
          },
        ],
      }),
      headless_app: registryApp({
        id: "headless_app",
        name: "Headless App",
        tiles: [],
      }),
    },
    "tools",
  );

  expect(entries).toEqual([
    {
      appId: "hello",
      appName: "Hello",
      tileId: "tools",
      title: "Tools",
      path: "tools/index.html",
      icon: "/app/hello/static/tools.png",
    },
  ]);
  expect(launcherSystemActions.installPackage).toBe("launcher-install-package");
  expect(launcherSystemActions.installPackageUrl).toBe(
    "launcher-install-package-url",
  );
  expect(launcherSystemActions.resetWorkspace).toBe("launcher-reset-workspace");
});

test("resident frames mount only for apps declaring one background", () => {
  const apps = {
    hello: registryApp({ id: "hello", name: "Hello" }),
    gemma: registryApp({
      id: "gemma",
      name: "Gemma",
      version: 101,
      background: { path: "service.html" },
    }),
  };

  expect(backgroundFrameEntries(apps).map(([appId]) => appId)).toEqual([
    "gemma",
  ]);
});

test("resident mounting fails closed above the admitted frame ceiling", () => {
  const apps = Object.fromEntries(
    Array.from({ length: MAX_RESIDENT_APP_FRAMES + 1 }, (_, index) => {
      const id = `resident_${index.toString().padStart(2, "0")}`;
      return [
        id,
        registryApp({
          id,
          name: `Resident ${index}`,
          background: { path: "service.html" },
        }),
      ];
    }),
  );

  expect(() => backgroundFrameEntries(apps)).toThrow(
    `maximum is ${MAX_RESIDENT_APP_FRAMES}`,
  );
});

test("resident readiness remounts once, then blocks without a reload loop", () => {
  const retry = advanceResidentFrameReadiness(
    INITIAL_RESIDENT_FRAME_READINESS,
    "deadline",
  );
  expect(retry).toEqual({ attempt: 1, phase: "waiting" });

  const blocked = advanceResidentFrameReadiness(retry, "deadline");
  expect(blocked).toEqual({ attempt: 1, phase: "blocked" });
  expect(advanceResidentFrameReadiness(blocked, "deadline")).toBe(blocked);

  const recovered = advanceResidentFrameReadiness(blocked, "connected");
  expect(recovered).toEqual({ attempt: 1, phase: "ready" });
  expect(advanceResidentFrameReadiness(recovered, "deadline")).toBe(recovered);
});

test("resident frames are unavailable without committed instance authority", () => {
  const apps = {
    gemma: registryApp({
      id: "gemma",
      name: "Gemma",
      background: { path: "service.html" },
    }),
  };
  const instances = {
    gemma: {
      scope: { appId: "gemma", installationUid: "17" },
      version: 100,
      deploymentId: "development",
      capabilityPlanFingerprint: apps.gemma.capability_plan_fingerprint,
      browserOriginNonce: "0123456789abcdef0123456789abcdef",
      browserOriginAuthorityEpoch: "1",
      residentFrameSecurity:
        ResidentFrameSecurityMode.CREDENTIALLESS_OPAQUE_V1,
    },
  };

  expect(runnableBackgroundFrameEntries(apps, {}, false)).toEqual([]);
  expect(runnableBackgroundFrameEntries(apps, instances, true)).toEqual([]);
  expect(
    runnableBackgroundFrameEntries(apps, instances, false).map(([appId]) =>
      appId
    ),
  ).toEqual(["gemma"]);
});

test("persistent background storage requires a dedicated app origin", () => {
  const canisterId = "4caro-hl777-77775-aaaba-cai";
  const browserOriginNonce = "0123456789abcdef0123456789abcdef";
  const app = registryApp({
    id: "gemma",
    name: "Gemma",
    background: { path: "service.html" },
    capabilities: {
      persistent_browser_storage: { api: 1, surface: "background" },
    },
  });

  expect(
    backgroundFrameSecurity(
      "gemma",
      app,
      `http://p0123456789abcdef01234567--${canisterId}.localhost:8000/app/gemma/service.html`,
      canisterId,
      browserOriginNonce,
      "7",
    ),
  ).toEqual({
    binding: {
      mode: ResidentFrameSecurityMode.PERSISTENT_DEDICATED_V1,
      browserOriginNonce,
      browserOriginAuthorityEpoch: "7",
    },
    credentialless: false,
    origin: `http://p0123456789abcdef01234567--${canisterId}.localhost:8000`,
    sandbox: "allow-scripts allow-same-origin",
  });
  expect(() =>
    backgroundFrameSecurity(
      "gemma",
      app,
      "http://100.88.36.22:9000/app/gemma/service.html",
      canisterId,
      browserOriginNonce,
      "7",
    ),
  ).toThrow("does not match its current origin authority");
  expect(() =>
    backgroundFrameSecurity(
      "gemma",
      app,
      `http://agemmaa--${canisterId}.localhost:8000/app/gemma/service.html`,
      canisterId,
      browserOriginNonce,
      "7",
    ),
  ).toThrow("does not match its current origin authority");
});

test("ephemeral dedicated residents use the nonce origin without persistence", () => {
  const canisterId = "4caro-hl777-77775-aaaba-cai";
  const browserOriginNonce = "fedcba9876543210fedcba9876543210";
  const app = registryApp({
    id: "files",
    name: "Files",
    background: { path: "service.html" },
    capabilities: {
      dedicated_resident_origin: {
        api: 1,
        surface: "background",
        mode: "credentialless_ephemeral_v1",
      },
    },
  });
  const src =
    `http://p${browserOriginNonce.slice(0, 24)}--${canisterId}` +
    ".localhost:8000/app/files/service.html";

  expect(
    backgroundFrameSecurity(
      "files",
      app,
      src,
      canisterId,
      browserOriginNonce,
      "11",
    ),
  ).toEqual({
    binding: {
      mode:
        ResidentFrameSecurityMode.CREDENTIALLESS_EPHEMERAL_DEDICATED_V1,
      browserOriginNonce,
      browserOriginAuthorityEpoch: "11",
    },
    credentialless: true,
    origin:
      `http://p${browserOriginNonce.slice(0, 24)}--${canisterId}.localhost:8000`,
    sandbox: "allow-scripts allow-same-origin",
  });
});

test("backgrounds without storage permission remain opaque", () => {
  const canisterId = "4caro-hl777-77775-aaaba-cai";
  const browserOriginNonce = "0123456789abcdef0123456789abcdef";
  expect(
    backgroundFrameSecurity(
      "hello",
      registryApp({
        id: "hello",
        name: "Hello",
        background: { path: "service.html" },
      }),
      `http://ahelloa--${canisterId}.localhost:8000/app/hello/service.html`,
      canisterId,
      browserOriginNonce,
      "1",
    ),
  ).toEqual({
    binding: {
      mode: ResidentFrameSecurityMode.CREDENTIALLESS_OPAQUE_V1,
      browserOriginNonce,
      browserOriginAuthorityEpoch: "1",
    },
    credentialless: true,
    origin: "null",
    sandbox: "allow-scripts",
  });
});

test("resident frame modes are closed and mutually exclusive", () => {
  expect(
    selectResidentFrameSecurityMode({
      persistentBrowserStorage: false,
      credentiallessEphemeralDedicatedOrigin: false,
    }),
  ).toBe(ResidentFrameSecurityMode.CREDENTIALLESS_OPAQUE_V1);
  expect(() =>
    selectResidentFrameSecurityMode({
      persistentBrowserStorage: true,
      credentiallessEphemeralDedicatedOrigin: true,
    }),
  ).toThrow("mutually exclusive");
  expect(() =>
    registryApp({
      id: "files",
      name: "Files",
      background: { path: "service.html" },
      capabilities: {
        persistent_browser_storage: { api: 1, surface: "background" },
        dedicated_resident_origin: {
          api: 1,
          surface: "background",
          mode: "credentialless_ephemeral_v1",
        },
      },
    }),
  ).toThrow("mutually exclusive");
});

test("credentialless preflight runs against the initial Window before navigation", () => {
  const initialWindow = { credentialless: true } as unknown as Window;
  const supported = {
    credentialless: true,
    contentWindow: initialWindow,
  } as unknown as HTMLIFrameElement;
  expect(
    assertBackgroundFramePreflight(
      supported,
      ResidentFrameSecurityMode.CREDENTIALLESS_EPHEMERAL_DEDICATED_V1,
    ),
  ).toBe(initialWindow);

  expect(() =>
    assertBackgroundFramePreflight(
      {
        credentialless: false,
        contentWindow: initialWindow,
      } as unknown as HTMLIFrameElement,
      ResidentFrameSecurityMode.CREDENTIALLESS_EPHEMERAL_DEDICATED_V1,
    ),
  ).toThrow("required credentialless resident frame");
  expect(() =>
    assertBackgroundFramePreflight(
      {
        credentialless: true,
        contentWindow: {
          credentialless: false,
        } as unknown as Window,
      } as unknown as HTMLIFrameElement,
      ResidentFrameSecurityMode.CREDENTIALLESS_EPHEMERAL_DEDICATED_V1,
    ),
  ).toThrow("required credentialless resident Window");
  expect(() =>
    assertBackgroundFramePreflight(
      supported,
      ResidentFrameSecurityMode.PERSISTENT_DEDICATED_V1,
    ),
  ).toThrow("unexpectedly inherited credentialless mode");

  const opaqueWindow = {} as Window;
  Object.defineProperty(opaqueWindow, "credentialless", {
    get() {
      throw new DOMException("opaque", "SecurityError");
    },
  });
  expect(
    assertBackgroundFramePreflight(
      {
        credentialless: true,
        contentWindow: opaqueWindow,
      } as unknown as HTMLIFrameElement,
      ResidentFrameSecurityMode.CREDENTIALLESS_OPAQUE_V1,
    ),
  ).toBe(opaqueWindow);
});

test("resident background keys bind package, deployment, scope, mode, nonce, and authority epoch", () => {
  const app = registryApp({
    id: "files",
    name: "Files",
    background: { path: "service.html" },
  });
  const base = {
    scope: { appId: "files", installationUid: "9" },
    version: app.version,
    deploymentId: "deployment",
    capabilityPlanFingerprint: app.capability_plan_fingerprint,
    browserOriginNonce: "1".padStart(32, "0"),
    browserOriginAuthorityEpoch: "1",
    residentFrameSecurity:
      ResidentFrameSecurityMode.CREDENTIALLESS_OPAQUE_V1,
  };
  expect(backgroundKey("files", app, base)).not.toBe(
    backgroundKey("files", app, {
      ...base,
      browserOriginAuthorityEpoch: "2",
    }),
  );
  expect(backgroundKey("files", app, base)).not.toBe(
    backgroundKey("files", app, {
      ...base,
      browserOriginNonce: "2".padStart(32, "0"),
    }),
  );
  expect(backgroundKey("files", app, base)).not.toBe(
    backgroundKey("files", app, {
      ...base,
      capabilityPlanFingerprint: "a".repeat(64),
    }),
  );
  expect(backgroundKey("files", app, base)).not.toBe(
    backgroundKey("files", app, {
      ...base,
      deploymentId: "next-deployment",
    }),
  );
  expect(backgroundKey("files", app, base)).not.toBe(
    backgroundKey("files", app, {
      ...base,
      scope: { ...base.scope, installationUid: "10" },
    }),
  );
  const packageChanged = registryApp({
    id: "files",
    name: "Files",
    background: { path: "service.html" },
    capabilities: { randomness: { api: 1 } },
  });
  expect(backgroundKey("files", app, base)).not.toBe(
    backgroundKey("files", packageChanged, {
      ...base,
      capabilityPlanFingerprint:
        packageChanged.capability_plan_fingerprint,
    }),
  );
  const modeChanged = registryApp({
    id: "files",
    name: "Files",
    background: { path: "service.html" },
    capabilities: {
      dedicated_resident_origin: {
        api: 1,
        surface: "background",
        mode: "credentialless_ephemeral_v1",
      },
    },
  });
  expect(backgroundKey("files", app, base)).not.toBe(
    backgroundKey("files", modeChanged, {
      ...base,
      capabilityPlanFingerprint: modeChanged.capability_plan_fingerprint,
      residentFrameSecurity:
        ResidentFrameSecurityMode.CREDENTIALLESS_EPHEMERAL_DEDICATED_V1,
    }),
  );
});

test("resident endpoint authority rechecks runtime mode, nonce, epoch, and generation", () => {
  const app = registryApp({
    id: "files",
    name: "Files",
    background: { path: "service.html" },
    capabilities: {
      dedicated_resident_origin: {
        api: 1,
        surface: "background",
        mode: "credentialless_ephemeral_v1",
      },
    },
  });
  const mode =
    ResidentFrameSecurityMode.CREDENTIALLESS_EPHEMERAL_DEDICATED_V1;
  const instance = {
    scope: { appId: "files", installationUid: "9" },
    version: app.version,
    deploymentId: "deployment",
    capabilityPlanFingerprint: app.capability_plan_fingerprint,
    browserOriginNonce: "9".padStart(32, "0"),
    browserOriginAuthorityEpoch: "4",
    residentFrameSecurity: mode,
  } as const;
  useAppsStore.setState({
    list: { files: app },
    appInstances: { files: instance },
    runtimeGenerations: { files: 3 },
  });
  const expected = {
    appId: "files",
    appVersion: app.version,
    appGeneration: 3,
    capabilityPlanFingerprint: app.capability_plan_fingerprint,
    deploymentId: "deployment",
    installationUid: "9",
    binding: {
      mode,
      browserOriginNonce: instance.browserOriginNonce,
      browserOriginAuthorityEpoch: "4",
    },
  } as const;

  expect(
    residentFrameAuthorityCurrent(expected, useAppsStore.getState()),
  ).toBe(true);
  useAppsStore.setState({
    appInstances: {
      files: { ...instance, browserOriginAuthorityEpoch: "5" },
    },
  });
  expect(
    residentFrameAuthorityCurrent(expected, useAppsStore.getState()),
  ).toBe(false);
  useAppsStore.setState({
    appInstances: { files: instance },
    runtimeGenerations: { files: 4 },
  });
  expect(
    residentFrameAuthorityCurrent(expected, useAppsStore.getState()),
  ).toBe(false);
});

test("approval labels distinguish tile and background callers", () => {
  expect(
    frameRequestLabel({
      role: "tile",
      appId: "hello",
      tileId: "main",
      instanceId: "one",
      workspace: 1,
    }),
  ).toBe("hello/main one");
  expect(frameRequestLabel({ role: "background", appId: "gemma" })).toBe(
    "gemma/background",
  );
});

function emptyWorkspaces(): WorkspaceMap {
  return Object.fromEntries(
    workspaceIds.slice(0, 3).map((id) => [id, emptyWorkspace(id)]),
  ) as WorkspaceMap;
}

function emptyWorkspace(id: WorkspaceId): WorkspaceState {
  return {
    id,
    layout: null,
    tiles: [],
    focusedTileId: null,
  };
}
