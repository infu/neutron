import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { AppTileFrame } from "./AppTileFrame.tsx";
import { TileFrame } from "./TileFrame.tsx";
import { isLayoutModifierEvent, useLayoutModifierActive } from "./modifier.ts";
import {
  dropSide,
  findControllingSplits,
  findResizeTarget,
  findTileAt,
  layoutTiles,
  tileIdsInLayout,
  type SplitInfo,
} from "./layout.ts";
import {
  useWorkspaceStore,
  visibleWorkspaceIds,
  workspaceStateById,
} from "./store.ts";
import { Launcher } from "./Launcher.tsx";
import type {
  InsertSide,
  Rect,
  TileInstance,
  TileRects,
  WorkspaceId,
} from "./types.ts";
import { isWorkspaceId } from "./types.ts";
import { useAppearanceStore } from "../appearance.ts";

const CORNER_HIT_SIZE = 54;
const IFRAME_FOCUS_POLL_MS = 100;
const MOBILE_TILE_GAP = 8;
const MOBILE_WORKSPACE_QUERY = "(max-width: 900px)";
const MOVE_DRAG_THRESHOLD = 6;

type DragState =
  | {
      type: "resize";
      splitId: string;
      start: { x: number; y: number };
      splitRect: Rect;
      orientation: "vertical" | "horizontal";
      initialRatio: number;
    }
  | {
      type: "corner-resize";
      start: { x: number; y: number };
      verticalSplit?: SplitInfo;
      horizontalSplit?: SplitInfo;
      initialVRatio?: number;
      initialHRatio?: number;
    }
  | {
      type: "move";
      tileId: string;
      start: { x: number; y: number };
      originalRect: Rect;
      preview: { x: number; y: number };
    };

type DropPreview = {
  tileId: string;
  side: InsertSide;
};

type PendingMove = {
  pointerId: number;
  tileId: string;
  start: { x: number; y: number };
  originalRect: Rect;
};

export function WorkspaceView({
  active,
  interactive,
  workspaceId,
}: {
  active: boolean;
  interactive: boolean;
  workspaceId: WorkspaceId;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pendingMoveRef = useRef<PendingMove | null>(null);
  const interactionPointerIdRef = useRef<number | null>(null);
  const [mobileLayout, setMobileLayout] = useState(
    () => mobileWorkspaceMedia()?.matches ?? false,
  );
  const [container, setContainer] = useState<Rect>({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  });
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [dropPreview, setDropPreview] = useState<DropPreview | null>(null);
  const [cursor, setCursor] = useState("default");
  const layoutModifierActive = useLayoutModifierActive(interactive);
  const configuredTileGap = useAppearanceStore((state) => state.tileGap);
  const tileOpacity = useAppearanceStore((state) => state.tileOpacity);
  const tileGap = mobileLayout ? MOBILE_TILE_GAP : configuredTileGap;

  const workspace = useWorkspaceStore(
    (state) => workspaceStateById(state.workspaces, workspaceId),
  );
  const expandedTile = useWorkspaceStore((state) => state.expandedTile);
  const setExpandedTile = useWorkspaceStore((state) => state.setExpandedTile);
  const focusTile = useWorkspaceStore((state) => state.focusTile);
  const closeTile = useWorkspaceStore((state) => state.closeTile);
  const resizeSplits = useWorkspaceStore((state) => state.resizeSplits);
  const moveTile = useWorkspaceStore((state) => state.moveTile);
  const moveTileToWorkspace = useWorkspaceStore(
    (state) => state.moveTileToWorkspace,
  );
  const setWorkspaceDropTarget = useWorkspaceStore(
    (state) => state.setWorkspaceDropTarget,
  );
  const spotlightTileId =
    expandedTile?.workspaceId === workspaceId
      ? expandedTile.instanceId
      : null;
  const focusedTileIdRef = useRef(workspace.focusedTileId);
  focusedTileIdRef.current = workspace.focusedTileId;

  const ownsActiveWorkspace = () =>
    interactive &&
    useWorkspaceStore.getState().activeWorkspaceId === workspaceId;

  const focusTileFromKernelInteraction = (tileId: string) => {
    if (!ownsActiveWorkspace()) return;
    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLIFrameElement &&
      activeElement.classList.contains("tile-iframe")
    ) {
      activeElement.blur();
    }
    focusTile(tileId);
  };

  // Chromium emits no parent focus event when focus moves between sibling iframes.
  useEffect(() => {
    if (!interactive) return;

    const syncIframeFocus = () => {
      const activeElement = document.activeElement;
      if (
        !(activeElement instanceof HTMLIFrameElement) ||
        !activeElement.classList.contains("tile-iframe") ||
        !containerRef.current?.contains(activeElement) ||
        !ownsActiveWorkspace()
      ) {
        return;
      }

      const tileId = activeElement.dataset.instanceId;
      if (!tileId || tileId === focusedTileIdRef.current) return;
      focusedTileIdRef.current = tileId;
      focusTile(tileId);
    };

    window.addEventListener("blur", syncIframeFocus);
    document.addEventListener("focusin", syncIframeFocus);
    const interval = window.setInterval(syncIframeFocus, IFRAME_FOCUS_POLL_MS);
    return () => {
      window.removeEventListener("blur", syncIframeFocus);
      document.removeEventListener("focusin", syncIframeFocus);
      window.clearInterval(interval);
    };
  }, [focusTile, interactive, workspaceId]);

  useEffect(() => {
    const media = mobileWorkspaceMedia();
    if (!media) return;
    const syncLayoutMode = () => setMobileLayout(media.matches);
    syncLayoutMode();
    media.addEventListener("change", syncLayoutMode);
    return () => media.removeEventListener("change", syncLayoutMode);
  }, []);

  useEffect(() => {
    if (!mobileLayout) return;
    const pendingMove = pendingMoveRef.current;
    if (
      pendingMove &&
      containerRef.current?.hasPointerCapture(pendingMove.pointerId)
    ) {
      containerRef.current.releasePointerCapture(pendingMove.pointerId);
    }
    pendingMoveRef.current = null;
    setDragState(null);
    setDropPreview(null);
    setWorkspaceDropTarget(null);
    setCursor("default");
  }, [
    mobileLayout,
    setWorkspaceDropTarget,
  ]);

  useEffect(() => {
    const pointerId =
      pendingMoveRef.current?.pointerId ?? interactionPointerIdRef.current;
    if (
      pointerId !== null &&
      containerRef.current?.hasPointerCapture(pointerId)
    ) {
      try {
        containerRef.current.releasePointerCapture(pointerId);
      } catch {
        // The browser may release capture while the workspace is switching.
      }
    }
    interactionPointerIdRef.current = null;
    pendingMoveRef.current = null;
    setDragState(null);
    setDropPreview(null);
    setWorkspaceDropTarget(null);
    setCursor("default");
    return () => {
      if (interactive) setWorkspaceDropTarget(null);
    };
  }, [
    interactive,
    setWorkspaceDropTarget,
  ]);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setContainer({
        x: 0,
        y: 0,
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const layoutRect = useMemo<Rect>(
    () => ({
      x: tileGap,
      y: tileGap,
      width: Math.max(0, container.width - tileGap * 2),
      height: Math.max(0, container.height - tileGap * 2),
    }),
    [container.height, container.width, tileGap]
  );

  const tileRects = useMemo<TileRects>(() => {
    const rects: TileRects = {};
    if (workspace.layout && layoutRect.width > 20 && layoutRect.height > 20) {
      layoutTiles(workspace.layout, layoutRect, rects, tileGap);
    }
    return rects;
  }, [workspace.layout, layoutRect, tileGap]);

  const visibleTileIds = useMemo(
    () => new Set(tileIdsInLayout(workspace.layout)),
    [workspace.layout]
  );
  const visibleTiles = workspace.tiles.filter((tile) => visibleTileIds.has(tile.id));
  const canClose = visibleTiles.length > 0;

  useLayoutEffect(() => {
    if (mobileLayout && spotlightTileId && containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
  }, [mobileLayout, spotlightTileId]);

  useEffect(() => {
    if (
      spotlightTileId !== null &&
      !visibleTileIds.has(spotlightTileId)
    ) {
      setExpandedTile(null);
    }
  }, [setExpandedTile, spotlightTileId, visibleTileIds]);

  useEffect(() => {
    if (spotlightTileId === null) return;
    const restoreFromOutside = (event: globalThis.PointerEvent) => {
      const target = event.target;
      const spotlight = containerRef.current?.querySelector(
        ".tile-rect--spotlight",
      );
      if (target instanceof Node && spotlight?.contains(target)) return;
      setExpandedTile(null);
    };
    document.addEventListener("pointerdown", restoreFromOutside, true);
    return () => {
      document.removeEventListener("pointerdown", restoreFromOutside, true);
    };
  }, [setExpandedTile, spotlightTileId]);

  const beginMove = (
    tileId: string,
    event: PointerEvent<HTMLElement>
  ) => {
    if (!ownsActiveWorkspace()) return;
    if (mobileLayout) {
      focusTileFromKernelInteraction(tileId);
      return;
    }
    if (event.button !== 0 || dragState) return;
    if (
      pendingMoveRef.current &&
      pendingMoveRef.current.pointerId !== event.pointerId
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const rect = tileRects[tileId];
    if (!rect || !containerRef.current) return;
    focusTileFromKernelInteraction(tileId);
    containerRef.current.setPointerCapture(event.pointerId);
    interactionPointerIdRef.current = event.pointerId;
    pendingMoveRef.current = {
      pointerId: event.pointerId,
      tileId,
      start: { x: event.clientX, y: event.clientY },
      originalRect: rect,
    };
  };

  const beginWorkspaceDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (
      !ownsActiveWorkspace() ||
      mobileLayout ||
      !containerRef.current ||
      dragState ||
      pendingMoveRef.current ||
      event.button !== 0 ||
      !workspace.layout
    ) {
      return;
    }
    const bounds = containerRef.current.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const tile = findTileAt(tileRects, x, y);
    const layoutModifier = isLayoutModifierEvent(event);

    if (tile && layoutModifier) {
      const [tileId, rect] = tile;
      const corner = cornerAt(rect, x, y);
      focusTileFromKernelInteraction(tileId);

      if (corner) {
        event.preventDefault();
        event.stopPropagation();
        containerRef.current.setPointerCapture(event.pointerId);
        interactionPointerIdRef.current = event.pointerId;
        const splits = findControllingSplits(
          workspace.layout,
          layoutRect,
          tileId,
          tileGap,
        );
        const verticalSplit = corner.includes("right")
          ? splits.right ?? splits.left
          : splits.left ?? splits.right;
        const horizontalSplit = corner.includes("bottom")
          ? splits.bottom ?? splits.top
          : splits.top ?? splits.bottom;
        setDragState({
          type: "corner-resize",
          start: { x: event.clientX, y: event.clientY },
          ...(verticalSplit ? { verticalSplit, initialVRatio: verticalSplit.node.ratio } : {}),
          ...(horizontalSplit
            ? { horizontalSplit, initialHRatio: horizontalSplit.node.ratio }
            : {}),
        });
        return;
      }

      startMove(tileId, rect, event);
      return;
    }

    const target = findResizeTarget(workspace.layout, layoutRect, x, y, tileGap);
    if (!target) return;

    event.preventDefault();
    containerRef.current.setPointerCapture(event.pointerId);
    interactionPointerIdRef.current = event.pointerId;
    setDragState({
      type: "resize",
      splitId: target.split.id,
      start: { x: event.clientX, y: event.clientY },
      splitRect: target.rect,
      orientation: target.split.orientation,
      initialRatio: target.split.ratio,
    });
  };

  const startMove = (
    tileId: string,
    rect: Rect,
    event: PointerEvent<HTMLElement>
  ) => {
    if (!containerRef.current || !ownsActiveWorkspace()) return;
    event.preventDefault();
    event.stopPropagation();
    focusTileFromKernelInteraction(tileId);
    containerRef.current.setPointerCapture(event.pointerId);
    interactionPointerIdRef.current = event.pointerId;
    setDragState({
      type: "move",
      tileId,
      start: { x: event.clientX, y: event.clientY },
      originalRect: rect,
      preview: { x: rect.x, y: rect.y },
    });
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (mobileLayout || !ownsActiveWorkspace()) return;
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds || !workspace.layout) return;
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;

    const pendingMove = pendingMoveRef.current;
    if (pendingMove) {
      if (pendingMove.pointerId !== event.pointerId) return;
      event.preventDefault();
      const dx = event.clientX - pendingMove.start.x;
      const dy = event.clientY - pendingMove.start.y;
      if (dx * dx + dy * dy < MOVE_DRAG_THRESHOLD * MOVE_DRAG_THRESHOLD) {
        return;
      }

      pendingMoveRef.current = null;
      const targetWorkspaceId = workspaceDropTargetAtPoint(
        event.clientX,
        event.clientY,
        workspaceId,
      );
      setWorkspaceDropTarget(targetWorkspaceId);
      const target = targetWorkspaceId
        ? null
        : findTileAt(tileRects, x, y, pendingMove.tileId);
      setDropPreview(
        target ? { tileId: target[0], side: dropSide(target[1], x, y) } : null
      );
      setDragState({
        type: "move",
        tileId: pendingMove.tileId,
        start: pendingMove.start,
        originalRect: pendingMove.originalRect,
        preview: {
          x: pendingMove.originalRect.x + dx,
          y: pendingMove.originalRect.y + dy,
        },
      });
      return;
    }

    if (!dragState) {
      if (isLayoutModifierEvent(event)) {
        const tile = findTileAt(tileRects, x, y);
        if (tile) {
          const [, rect] = tile;
          const corner = cornerAt(rect, x, y);
          setCursor(corner ? cursorForCorner(corner) : "grab");
          return;
        }
      }
      const resize = findResizeTarget(workspace.layout, layoutRect, x, y, tileGap);
      setCursor(
        resize
          ? resize.split.orientation === "vertical"
            ? "col-resize"
            : "row-resize"
          : "default"
      );
      return;
    }

    event.preventDefault();
    if (dragState.type === "resize") {
      setDropPreview(null);
      setWorkspaceDropTarget(null);
      const delta =
        dragState.orientation === "vertical"
          ? event.clientX - dragState.start.x
          : event.clientY - dragState.start.y;
      const total =
        dragState.orientation === "vertical"
          ? dragState.splitRect.width
          : dragState.splitRect.height;
      const nextRatio = dragState.initialRatio + delta / Math.max(1, total);
      resizeSplits(
        [{ splitId: dragState.splitId, ratio: nextRatio }],
        workspaceId,
      );
      return;
    }

    if (dragState.type === "corner-resize") {
      setDropPreview(null);
      setWorkspaceDropTarget(null);
      const updates: { splitId: string; ratio: number }[] = [];
      if (dragState.verticalSplit && dragState.initialVRatio !== undefined) {
        const deltaX = event.clientX - dragState.start.x;
        const nextRatio =
          dragState.initialVRatio +
          deltaX / Math.max(1, dragState.verticalSplit.rect.width);
        updates.push({
          splitId: dragState.verticalSplit.node.id,
          ratio: nextRatio,
        });
      }
      if (dragState.horizontalSplit && dragState.initialHRatio !== undefined) {
        const deltaY = event.clientY - dragState.start.y;
        const nextRatio =
          dragState.initialHRatio +
          deltaY / Math.max(1, dragState.horizontalSplit.rect.height);
        updates.push({
          splitId: dragState.horizontalSplit.node.id,
          ratio: nextRatio,
        });
      }
      if (updates.length > 0) resizeSplits(updates, workspaceId);
      return;
    }

    const dx = event.clientX - dragState.start.x;
    const dy = event.clientY - dragState.start.y;
    const targetWorkspaceId = workspaceDropTargetAtPoint(
      event.clientX,
      event.clientY,
      workspaceId,
    );
    setWorkspaceDropTarget(targetWorkspaceId);
    const target = targetWorkspaceId
      ? null
      : findTileAt(tileRects, x, y, dragState.tileId);
    setDropPreview(target ? { tileId: target[0], side: dropSide(target[1], x, y) } : null);
    setDragState({
      ...dragState,
      preview: {
        x: dragState.originalRect.x + dx,
        y: dragState.originalRect.y + dy,
      },
    });
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!containerRef.current || !ownsActiveWorkspace()) return;
    const pendingMove = pendingMoveRef.current;
    const endedPendingMove = pendingMove?.pointerId === event.pointerId;
    if (!dragState && !endedPendingMove) return;
    if (endedPendingMove) pendingMoveRef.current = null;
    interactionPointerIdRef.current = null;
    try {
      containerRef.current.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released by the browser.
    }

    if (endedPendingMove) {
      setWorkspaceDropTarget(null);
      return;
    }
    if (!dragState) return;

    if (dragState.type === "move") {
      const targetWorkspaceId = workspaceDropTargetAtPoint(
        event.clientX,
        event.clientY,
        workspaceId,
      );
      if (targetWorkspaceId) {
        setDragState(null);
        setDropPreview(null);
        setWorkspaceDropTarget(null);
        moveTileToWorkspace(
          workspaceId,
          dragState.tileId,
          targetWorkspaceId,
        );
        return;
      }
      const bounds = containerRef.current.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      const target = findTileAt(tileRects, x, y, dragState.tileId);
      if (target) {
        const [targetTileId, targetRect] = target;
        moveTile(dragState.tileId, targetTileId, dropSide(targetRect, x, y));
      }
    }
    setDragState(null);
    setDropPreview(null);
    setWorkspaceDropTarget(null);
  };

  const handlePointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    if (!ownsActiveWorkspace()) return;
    if (pendingMoveRef.current?.pointerId === event.pointerId) {
      pendingMoveRef.current = null;
    }
    interactionPointerIdRef.current = null;
    if (containerRef.current?.hasPointerCapture(event.pointerId)) {
      containerRef.current.releasePointerCapture(event.pointerId);
    }
    setDragState(null);
    setDropPreview(null);
    setWorkspaceDropTarget(null);
  };

  const handleLostPointerCapture = (event: PointerEvent<HTMLDivElement>) => {
    if (!ownsActiveWorkspace()) return;
    if (pendingMoveRef.current?.pointerId === event.pointerId) {
      pendingMoveRef.current = null;
    }
    if (interactionPointerIdRef.current === event.pointerId) {
      interactionPointerIdRef.current = null;
      setDragState(null);
      setDropPreview(null);
      setWorkspaceDropTarget(null);
    }
  };

  return (
    <div
      className={[
        "hyper-workspace",
        mobileLayout ? "hyper-workspace--mobile" : "",
        dragState ? "hyper-workspace--interacting" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      ref={containerRef}
      style={mobileLayout ? undefined : { cursor }}
      onPointerDown={
        interactive && !mobileLayout && spotlightTileId === null
          ? beginWorkspaceDrag
          : undefined
      }
      onPointerMove={
        interactive && !mobileLayout && spotlightTileId === null
          ? handlePointerMove
          : undefined
      }
      onPointerUp={
        interactive && !mobileLayout && spotlightTileId === null
          ? handlePointerUp
          : undefined
      }
      onPointerCancel={
        interactive && !mobileLayout && spotlightTileId === null
          ? handlePointerCancel
          : undefined
      }
      onLostPointerCapture={
        interactive && !mobileLayout && spotlightTileId === null
          ? handleLostPointerCapture
          : undefined
      }
      data-tid="workspace"
      data-workspace-id={workspaceId}
    >
      {visibleTiles.length === 0 ? (
        <div className="empty-workspace" data-tid="workspace-empty">
          {interactive ? (
            <Launcher placement="workspace" workspaceId={workspaceId} />
          ) : null}
        </div>
      ) : null}
      {spotlightTileId ? (
        <div
          aria-hidden="true"
          className="tile-spotlight-backdrop"
          data-tid="tile-spotlight-backdrop"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        />
      ) : null}
      {visibleTiles.map((tile) => {
        const spotlighted = spotlightTileId === tile.id;
        const tileDragState =
          dragState?.type === "move" && dragState.tileId === tile.id
            ? dragState
            : null;
        const dragging = Boolean(tileDragState);
        const rect = spotlighted
          ? layoutRect
          : tileDragState
          ? {
              ...tileDragState.originalRect,
              x: tileDragState.preview.x,
              y: tileDragState.preview.y,
            }
          : tileRects[tile.id];
        if (!mobileLayout && !rect) return null;
        return renderTile({
          tile,
          rect: mobileLayout ? undefined : rect,
          mobile: mobileLayout,
          focused:
            spotlighted || dragging || workspace.focusedTileId === tile.id,
          canClose,
          canSpotlight: spotlighted || !mobileLayout,
          endpointActive: active,
          workspaceId,
          opacity: tileOpacity,
          dragging,
          spotlighted,
          onFocus: dragging
            ? () => undefined
            : () => focusTileFromKernelInteraction(tile.id),
          onClose: dragging
            ? () => undefined
            : () => {
                if (!ownsActiveWorkspace()) return;
                closeTile(tile.id);
              },
          onMoveStart: dragging
            ? () => undefined
            : (event) => beginMove(tile.id, event),
          onToggleSpotlight: () => {
            if (!ownsActiveWorkspace()) return;
            if (spotlighted) {
              setExpandedTile(null);
              return;
            }
            if (mobileLayout) return;
            focusTileFromKernelInteraction(tile.id);
            setCursor("default");
            setExpandedTile({ workspaceId, instanceId: tile.id });
          },
          hitLayer:
            spotlightTileId === null &&
            (dragging ||
              (!mobileLayout && (layoutModifierActive || Boolean(dragState)))),
        });
      })}
      {dragState?.type === "move" && dropPreview
        ? (() => {
            const rect = tileRects[dropPreview.tileId];
            if (!rect) return null;
            return (
              <div
                className={`drop-preview drop-preview--${dropPreview.side}`}
                style={previewStyle(rect, dropPreview.side)}
              />
            );
          })()
        : null}
    </div>
  );
}

function mobileWorkspaceMedia(): MediaQueryList | null {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return null;
  }
  return window.matchMedia(MOBILE_WORKSPACE_QUERY);
}

function workspaceDropTargetAtPoint(
  clientX: number,
  clientY: number,
  sourceWorkspaceId: WorkspaceId,
): WorkspaceId | null {
  const element = document.elementFromPoint(clientX, clientY);
  const target = element?.closest<HTMLElement>(
    "[data-workspace-drop-target]",
  );
  const value = target?.dataset.workspaceDropTarget;
  if (!value) return null;

  const workspaceId = Number(value);
  if (!isWorkspaceId(workspaceId) || workspaceId === sourceWorkspaceId) {
    return null;
  }
  return visibleWorkspaceIds(useWorkspaceStore.getState()).includes(workspaceId)
    ? workspaceId
    : null;
}

function renderTile({
  tile,
  rect,
  mobile = false,
  focused,
  canClose,
  canSpotlight,
  endpointActive,
  workspaceId,
  opacity,
  dragging = false,
  spotlighted,
  hitLayer,
  onFocus,
  onClose,
  onMoveStart,
  onToggleSpotlight,
}: {
  tile: TileInstance;
  rect: Rect | undefined;
  mobile?: boolean;
  focused: boolean;
  canClose: boolean;
  canSpotlight: boolean;
  endpointActive: boolean;
  workspaceId: WorkspaceId;
  opacity: number;
  dragging?: boolean;
  spotlighted: boolean;
  hitLayer: boolean;
  onFocus: () => void;
  onClose: () => void;
  onMoveStart: (event: PointerEvent<HTMLElement>) => void;
  onToggleSpotlight: () => void;
}) {
  return (
    <div
      key={tile.id}
      className={[
        "tile-rect",
        dragging ? "tile-rect--preview" : "",
        mobile ? "tile-rect--mobile" : "",
        spotlighted ? "tile-rect--spotlight" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={
        rect
          ? {
              transform: `translate3d(${rect.x}px, ${rect.y}px, 0)`,
              width: rect.width,
              height: rect.height,
            }
          : undefined
      }
    >
      <TileFrame
        title={tile.title}
        icon={tile.icon}
        focused={focused}
        canClose={canClose}
        canSpotlight={canSpotlight}
        opacity={opacity}
        spotlighted={spotlighted}
        dragging={dragging}
        movable={!mobile && !spotlighted}
        onFocus={onFocus}
        onClose={onClose}
        onMoveStart={onMoveStart}
        onToggleSpotlight={onToggleSpotlight}
      >
        <div className="tile-frame-wrap">
          <AppTileFrame
            active={endpointActive}
            tile={tile}
            workspaceId={workspaceId}
          />
          {hitLayer ? <div className="tile-hit-layer" /> : null}
        </div>
      </TileFrame>
    </div>
  );
}

type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

function cornerAt(rect: Rect, x: number, y: number): Corner | null {
  const size = Math.min(
    CORNER_HIT_SIZE,
    Math.max(28, Math.min(rect.width, rect.height) * 0.28)
  );
  const left = x <= rect.x + size;
  const right = x >= rect.x + rect.width - size;
  const top = y <= rect.y + size;
  const bottom = y >= rect.y + rect.height - size;

  if (top && left) return "top-left";
  if (top && right) return "top-right";
  if (bottom && left) return "bottom-left";
  if (bottom && right) return "bottom-right";
  return null;
}

function cursorForCorner(corner: Corner): string {
  return corner === "top-left" || corner === "bottom-right"
    ? "nwse-resize"
    : "nesw-resize";
}

function previewStyle(rect: Rect, side: InsertSide): CSSProperties {
  const halfWidth = rect.width / 2;
  const halfHeight = rect.height / 2;
  if (side === "left") {
    return {
      transform: `translate3d(${rect.x}px, ${rect.y}px, 0)`,
      width: halfWidth,
      height: rect.height,
    };
  }
  if (side === "right") {
    return {
      transform: `translate3d(${rect.x + halfWidth}px, ${rect.y}px, 0)`,
      width: halfWidth,
      height: rect.height,
    };
  }
  if (side === "top") {
    return {
      transform: `translate3d(${rect.x}px, ${rect.y}px, 0)`,
      width: rect.width,
      height: halfHeight,
    };
  }
  return {
    transform: `translate3d(${rect.x}px, ${rect.y + halfHeight}px, 0)`,
    width: rect.width,
    height: halfHeight,
  };
}
