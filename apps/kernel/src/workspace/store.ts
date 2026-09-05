import { create } from "zustand";
import { tileIdsInLayout } from "./layout.ts";
import {
  findNodeByTileId,
  insertTile,
  nextTileId,
  removeTile,
  tileNode,
  updateRatio,
} from "./tree.ts";
import type {
  InsertSide,
  LayoutNode,
  TileInstance,
  TileLaunchRequest,
  WorkspaceId,
  WorkspaceState,
} from "./types.ts";
import { isWorkspaceId, WORKSPACE_IDS } from "./types.ts";

const STORAGE_KEY = "neutron-kernel-workspaces-v2";
const PERSIST_DELAY_MS = 120;
const DEFAULT_WORKSPACE_COUNT = 3;

let pendingPersistState: PersistedWorkspaceRoot | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

type DefaultWorkspaceId = 1 | 2 | 3;

export type WorkspaceMap = Record<DefaultWorkspaceId, WorkspaceState> &
  Partial<Record<WorkspaceId, WorkspaceState>>;

export type WorkspaceRootState = {
  activeWorkspaceId: WorkspaceId;
  workspaces: WorkspaceMap;
};

type PersistedWorkspaceRoot = WorkspaceRootState;

export type ExpandedWorkspaceTile = {
  workspaceId: WorkspaceId;
  instanceId: string;
};

export type TilePlacement = {
  workspaceId?: WorkspaceId;
  relativeTo?: string;
  side?: InsertSide;
  size?: number;
};

export type SplitResize = {
  splitId: string;
  ratio: number;
};

type KernelWorkspaceStore = PersistedWorkspaceRoot & {
  workspaceDropTargetId: WorkspaceId | null;
  expandedTile: ExpandedWorkspaceTile | null;
  openTile: (tile: TileLaunchRequest, placement?: TilePlacement) => TileInstance;
  closeTile: (tileId: string) => void;
  focusTile: (tileId: string) => void;
  resizeSplits: (
    updates: readonly SplitResize[],
    workspaceId?: WorkspaceId,
  ) => void;
  moveTile: (
    tileId: string,
    targetTileId: string,
    side: InsertSide,
    size?: number,
    workspaceId?: WorkspaceId,
  ) => void;
  switchWorkspace: (workspaceId: WorkspaceId) => void;
  moveTileToWorkspace: (
    sourceWorkspaceId: WorkspaceId,
    tileId: string,
    targetWorkspaceId: WorkspaceId,
    placement?: Omit<TilePlacement, "workspaceId">,
    activateTarget?: boolean,
  ) => void;
  moveFocusedTileToWorkspace: (workspaceId: WorkspaceId) => void;
  setExpandedTile: (tile: ExpandedWorkspaceTile | null) => void;
  setWorkspaceDropTarget: (workspaceId: WorkspaceId | null) => void;
  resetCurrentWorkspace: () => void;
  removeAppTiles: (appId: string) => void;
};

export const workspaceIds = WORKSPACE_IDS;

export function visibleWorkspaceIds(
  state: WorkspaceRootState,
): WorkspaceId[] {
  return WORKSPACE_IDS.filter((id) => state.workspaces[id] !== undefined);
}

export function workspaceStateById(
  workspaces: WorkspaceMap,
  workspaceId: WorkspaceId,
): WorkspaceState {
  const workspace = workspaces[workspaceId];
  if (!workspace) {
    throw new Error(`Workspace ${workspaceId} is not available`);
  }
  return workspace;
}

export const useWorkspaceStore = create<KernelWorkspaceStore>((set, get) => ({
  ...loadInitialState(),
  workspaceDropTargetId: null,
  expandedTile: null,

  openTile(tile, placement = {}) {
    const instance: TileInstance = {
      ...tile,
      id: nextTileId(tile.appId, tile.tileId),
    };
    set((state) => {
      const workspaceId = placement.workspaceId ?? state.activeWorkspaceId;
      const workspace = workspaceStateById(state.workspaces, workspaceId);
      const target =
        placement.relativeTo ??
        workspace.focusedTileId ??
        workspace.tiles[0]?.id ??
        null;
      if (
        placement.relativeTo !== undefined &&
        !workspace.tiles.some(
          (candidate) => candidate.id === placement.relativeTo,
        )
      ) {
        throw new Error("Relative tile is not in the target workspace");
      }
      const nextWorkspace = (() => {
        const layout =
          workspace.layout && target
            ? insertTile(
                workspace.layout,
                target,
                instance.id,
                placement.side ?? "right",
                placement.size,
              )
            : tileNode(instance.id);
        return {
          ...workspace,
          tiles: [...workspace.tiles, instance],
          layout,
          focusedTileId: instance.id,
        };
      })();
      return {
        ...normalizeWorkspaceRoot({
          ...state,
          workspaces: {
            ...state.workspaces,
            [workspaceId]: nextWorkspace,
          },
        }),
        expandedTile:
          workspaceId === state.activeWorkspaceId
            ? null
            : state.expandedTile,
      };
    });
    persistWorkspaceState(get());
    return instance;
  },

  closeTile(tileId) {
    set((state) => {
      const workspaceId = workspaceIdForTile(state, tileId);
      if (!workspaceId) return state;
      return {
        ...normalizeWorkspaceRoot({
          ...state,
          workspaces: {
            ...state.workspaces,
            [workspaceId]: closeTileInWorkspace(
              workspaceStateById(state.workspaces, workspaceId),
              tileId,
            ),
          },
        }),
        expandedTile:
          state.expandedTile?.instanceId === tileId ? null : state.expandedTile,
      };
    });
    persistWorkspaceState(get());
  },

  focusTile(tileId) {
    set((state) =>
      withActiveWorkspace(state, (workspace) => ({
        ...workspace,
        focusedTileId: workspace.tiles.some((tile) => tile.id === tileId)
          ? tileId
          : workspace.focusedTileId,
      })),
    );
    persistWorkspaceState(get());
  },

  resizeSplits(updates, workspaceId) {
    set((state) =>
      updateWorkspace(
        state,
        workspaceId ?? state.activeWorkspaceId,
        (workspace) =>
          workspace.layout && updates.length > 0
            ? {
                ...workspace,
                layout: updates.reduce(
                  (layout, update) =>
                    updateRatio(layout, update.splitId, update.ratio),
                  workspace.layout,
                ),
              }
            : workspace,
      ),
    );
    persistWorkspaceState(get());
  },

  moveTile(tileId, targetTileId, side, size, workspaceId) {
    set((state) =>
      updateWorkspace(
        state,
        workspaceId ?? state.activeWorkspaceId,
        (workspace) => {
          if (!workspace.layout || tileId === targetTileId) return workspace;
          if (
            !workspace.tiles.some((tile) => tile.id === tileId) ||
            !workspace.tiles.some((tile) => tile.id === targetTileId) ||
            !findNodeByTileId(workspace.layout, tileId) ||
            !findNodeByTileId(workspace.layout, targetTileId)
          ) {
            return workspace;
          }
          const removed = removeTile(workspace.layout, tileId);
          if (!removed) return workspace;
          return {
            ...workspace,
            layout: insertTile(removed, targetTileId, tileId, side, size),
          };
        },
      ),
    );
    persistWorkspaceState(get());
  },

  switchWorkspace(workspaceId) {
    set((state) => {
      if (
        workspaceId === state.activeWorkspaceId ||
        !visibleWorkspaceIds(state).includes(workspaceId)
      ) {
        return state;
      }
      return {
        ...normalizeWorkspaceRoot({
          ...state,
          activeWorkspaceId: workspaceId,
        }),
        expandedTile: null,
      };
    });
    persistWorkspaceState(get());
  },

  moveTileToWorkspace(
    sourceWorkspaceId,
    tileId,
    targetWorkspaceId,
    placement,
    activateTarget = true,
  ) {
    set((state) => {
      const next = moveTileBetweenWorkspaces(
        state,
        sourceWorkspaceId,
        tileId,
        targetWorkspaceId,
        placement,
        activateTarget,
      );
      const moved =
        workspaceTile(state, tileId)?.workspaceId !==
        workspaceTile(next, tileId)?.workspaceId;
      return {
        ...next,
        workspaceDropTargetId: null,
        expandedTile:
          moved && state.expandedTile?.instanceId === tileId
            ? null
            : state.expandedTile,
      };
    });
    persistWorkspaceState(get());
  },

  moveFocusedTileToWorkspace(workspaceId) {
    set((state) => {
      const source = workspaceStateById(
        state.workspaces,
        state.activeWorkspaceId,
      );
      const tileId = source.focusedTileId;
      if (!visibleWorkspaceIds(state).includes(workspaceId)) return state;
      if (workspaceId === source.id) {
        return state.workspaceDropTargetId === null
          ? state
          : { ...state, workspaceDropTargetId: null };
      }
      if (!tileId) {
        return {
          ...normalizeWorkspaceRoot({
            ...state,
            activeWorkspaceId: workspaceId,
          }),
          workspaceDropTargetId: null,
        };
      }
      return {
        ...moveTileBetweenWorkspaces(
          state,
          source.id,
          tileId,
          workspaceId,
          undefined,
          true,
        ),
        workspaceDropTargetId: null,
        expandedTile:
          state.expandedTile?.instanceId === tileId ? null : state.expandedTile,
      };
    });
    persistWorkspaceState(get());
  },

  setExpandedTile(tile) {
    set((state) => {
      if (tile === null) {
        return state.expandedTile === null ? state : { expandedTile: null };
      }
      const workspace = state.workspaces[tile.workspaceId];
      if (
        state.activeWorkspaceId !== tile.workspaceId ||
        !workspace?.tiles.some((candidate) => candidate.id === tile.instanceId)
      ) {
        return state;
      }
      return { expandedTile: tile };
    });
  },

  setWorkspaceDropTarget(workspaceId) {
    set((state) => {
      const target =
        workspaceId !== null &&
        workspaceId !== state.activeWorkspaceId &&
        visibleWorkspaceIds(state).includes(workspaceId)
          ? workspaceId
          : null;
      return target === state.workspaceDropTargetId
        ? state
        : { workspaceDropTargetId: target };
    });
  },

  resetCurrentWorkspace() {
    set((state) => ({
      ...normalizeWorkspaceRoot({
        ...state,
        workspaces: {
          ...state.workspaces,
          [state.activeWorkspaceId]: emptyWorkspace(state.activeWorkspaceId),
        },
      }),
      expandedTile: null,
    }));
    persistWorkspaceState(get());
  },

  removeAppTiles(appId) {
    set((state) => ({
      ...normalizeWorkspaceRoot({
        ...state,
        workspaces: Object.fromEntries(
          visibleWorkspaceIds(state).map((id) => [
            id,
            removeAppFromWorkspace(
              workspaceStateById(state.workspaces, id),
              appId,
            ),
          ]),
        ) as WorkspaceMap,
      }),
      expandedTile:
        state.expandedTile &&
        workspaceTile(state, state.expandedTile.instanceId)?.tile.appId === appId
          ? null
          : state.expandedTile,
    }));
    persistWorkspaceState(get());
  },
}));

function removeAppFromWorkspace(
  workspace: WorkspaceState,
  appId: string,
): WorkspaceState {
  let next = workspace;
  for (const tile of workspace.tiles) {
    if (tile.appId === appId) next = closeTileInWorkspace(next, tile.id);
  }
  return next;
}

function closeTileInWorkspace(
  workspace: WorkspaceState,
  tileId: string,
): WorkspaceState {
  const tiles = workspace.tiles.filter((tile) => tile.id !== tileId);
  const layout = workspace.layout ? removeTile(workspace.layout, tileId) : null;
  return {
    ...workspace,
    tiles,
    layout,
    focusedTileId: keepValidFocus(tiles, layout, workspace.focusedTileId),
  };
}

function moveTileBetweenWorkspaces(
  state: PersistedWorkspaceRoot,
  sourceWorkspaceId: WorkspaceId,
  tileId: string,
  targetWorkspaceId: WorkspaceId,
  placement: Omit<TilePlacement, "workspaceId"> = {},
  activateTarget = true,
): PersistedWorkspaceRoot {
  if (!visibleWorkspaceIds(state).includes(targetWorkspaceId)) return state;
  if (sourceWorkspaceId === targetWorkspaceId) {
    return {
      ...state,
      activeWorkspaceId: activateTarget
        ? targetWorkspaceId
        : state.activeWorkspaceId,
    };
  }

  const source = state.workspaces[sourceWorkspaceId];
  if (!source) return state;
  const tile = source.tiles.find((item) => item.id === tileId);
  if (!tile) return state;

  const target = workspaceStateById(state.workspaces, targetWorkspaceId);
  const targetFocus =
    placement.relativeTo ?? target.focusedTileId ?? target.tiles[0]?.id ?? null;
  if (
    placement.relativeTo !== undefined &&
    !target.tiles.some((item) => item.id === placement.relativeTo)
  ) {
    return state;
  }
  const nextTarget: WorkspaceState = {
    ...target,
    tiles: [...target.tiles, tile],
    layout:
      target.layout && targetFocus
        ? insertTile(
            target.layout,
            targetFocus,
            tile.id,
            placement.side ?? "right",
            placement.size,
          )
        : tileNode(tile.id),
    focusedTileId: activateTarget
      ? tile.id
      : target.focusedTileId ?? tile.id,
  };

  return normalizeWorkspaceRoot({
    ...state,
    activeWorkspaceId: activateTarget
      ? targetWorkspaceId
      : state.activeWorkspaceId,
    workspaces: {
      ...state.workspaces,
      [sourceWorkspaceId]: closeTileInWorkspace(source, tile.id),
      [targetWorkspaceId]: nextTarget,
    },
  });
}

export function workspaceTile(
  state: WorkspaceRootState,
  instanceId: string,
): { workspaceId: WorkspaceId; tile: TileInstance } | null {
  for (const workspaceId of visibleWorkspaceIds(state)) {
    const tile = state.workspaces[workspaceId]?.tiles.find(
      (candidate) => candidate.id === instanceId,
    );
    if (tile) return { workspaceId, tile };
  }
  return null;
}

function workspaceIdForTile(
  state: WorkspaceRootState,
  instanceId: string,
): WorkspaceId | null {
  return workspaceTile(state, instanceId)?.workspaceId ?? null;
}

function normalizeWorkspaceRoot(
  state: PersistedWorkspaceRoot,
): PersistedWorkspaceRoot {
  let highestRequiredId = Math.max(
    DEFAULT_WORKSPACE_COUNT,
    state.activeWorkspaceId,
  );
  for (const id of WORKSPACE_IDS) {
    if (state.workspaces[id]?.tiles.length) {
      highestRequiredId = Math.max(highestRequiredId, id);
    }
  }

  let count = Math.min(highestRequiredId, WORKSPACE_IDS.length);
  const workspaces: Record<number, WorkspaceState> = {};
  for (const id of WORKSPACE_IDS.slice(0, count)) {
    workspaces[id] = state.workspaces[id] ?? emptyWorkspace(id);
  }

  const currentIds = WORKSPACE_IDS.slice(0, count);
  if (
    count < WORKSPACE_IDS.length &&
    currentIds.every((id) => workspaces[id]!.tiles.length > 0)
  ) {
    count += 1;
    const nextId = WORKSPACE_IDS[count - 1];
    if (nextId) {
      workspaces[nextId] = state.workspaces[nextId] ?? emptyWorkspace(nextId);
    }
  }

  return {
    activeWorkspaceId: state.activeWorkspaceId,
    workspaces: workspaces as WorkspaceMap,
  };
}

function keepValidFocus(
  tiles: TileInstance[],
  layout: LayoutNode | null,
  current: string | null,
): string | null {
  const visibleIds = new Set(tileIdsInLayout(layout));
  if (current && visibleIds.has(current)) return current;
  return tiles.find((tile) => visibleIds.has(tile.id))?.id ?? null;
}

function withActiveWorkspace(
  state: PersistedWorkspaceRoot,
  update: (workspace: WorkspaceState) => WorkspaceState,
): PersistedWorkspaceRoot {
  const workspace = workspaceStateById(
    state.workspaces,
    state.activeWorkspaceId,
  );
  return {
    ...state,
    workspaces: {
      ...state.workspaces,
      [state.activeWorkspaceId]: update(workspace),
    },
  };
}

function updateWorkspace(
  state: PersistedWorkspaceRoot,
  workspaceId: WorkspaceId,
  update: (workspace: WorkspaceState) => WorkspaceState,
): PersistedWorkspaceRoot {
  return {
    ...state,
    workspaces: {
      ...state.workspaces,
      [workspaceId]: update(workspaceStateById(state.workspaces, workspaceId)),
    },
  };
}

function loadInitialState(): PersistedWorkspaceRoot {
  const fallback = defaultWorkspaceRoot();
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    return sanitizePersistedState(JSON.parse(raw));
  } catch {
    return fallback;
  }
}

function persistWorkspaceState(state: PersistedWorkspaceRoot): void {
  if (typeof window === "undefined") return;
  pendingPersistState = {
    activeWorkspaceId: state.activeWorkspaceId,
    workspaces: state.workspaces,
  };
  if (persistTimer) return;
  persistTimer = setTimeout(flushWorkspaceState, PERSIST_DELAY_MS);
}

function flushWorkspaceState(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (typeof window === "undefined" || !pendingPersistState) return;
  const state = pendingPersistState;
  pendingPersistState = null;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        activeWorkspaceId: state.activeWorkspaceId,
        workspaces: state.workspaces,
      }),
    );
  } catch {
    // Local storage is best-effort only.
  }
}

if (
  typeof window !== "undefined" &&
  typeof window.addEventListener === "function"
) {
  window.addEventListener("pagehide", flushWorkspaceState);
}

function sanitizePersistedState(value: unknown): PersistedWorkspaceRoot {
  if (!isRecord(value)) return defaultWorkspaceRoot();
  const workspaces: Record<number, WorkspaceState> = {};
  if (isRecord(value.workspaces)) {
    for (const id of WORKSPACE_IDS) {
      const workspace = value.workspaces[id];
      if (!isRecord(workspace)) continue;
      workspaces[id] = {
        id,
        layout: isRecord(workspace.layout)
          ? (workspace.layout as LayoutNode)
          : null,
        tiles: Array.isArray(workspace.tiles)
          ? (workspace.tiles.filter(isTileInstance) as TileInstance[])
          : [],
        focusedTileId:
          typeof workspace.focusedTileId === "string"
            ? workspace.focusedTileId
            : null,
      };
      const sanitizedWorkspace = workspaces[id]!;
      sanitizedWorkspace.focusedTileId = keepValidFocus(
        sanitizedWorkspace.tiles,
        sanitizedWorkspace.layout,
        sanitizedWorkspace.focusedTileId,
      );
    }
  }
  const requestedActiveWorkspaceId = workspaceIdFromUnknown(
    value.activeWorkspaceId,
  );
  const activeWorkspaceId =
    requestedActiveWorkspaceId && workspaces[requestedActiveWorkspaceId]
      ? requestedActiveWorkspaceId
      : 1;
  return normalizeWorkspaceRoot({
    activeWorkspaceId,
    workspaces: workspaces as WorkspaceMap,
  });
}

function defaultWorkspaceRoot(): PersistedWorkspaceRoot {
  return {
    activeWorkspaceId: 1,
    workspaces: defaultWorkspaces(),
  };
}

function defaultWorkspaces(): WorkspaceMap {
  return Object.fromEntries(
    WORKSPACE_IDS.slice(0, DEFAULT_WORKSPACE_COUNT).map((id) => [
      id,
      emptyWorkspace(id),
    ]),
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

function workspaceIdFromUnknown(value: unknown): WorkspaceId | null {
  return isWorkspaceId(value) ? value : null;
}

function isTileInstance(value: unknown): value is TileInstance {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.appId === "string" &&
    typeof value.tileId === "string" &&
    typeof value.title === "string" &&
    typeof value.path === "string" &&
    typeof value.icon === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
