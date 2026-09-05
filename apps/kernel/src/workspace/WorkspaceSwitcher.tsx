import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { IoColorPaletteOutline } from "react-icons/io5";
import type { AppRegistry } from "neutron-compiler/src/install.js";
import {
  WORKSPACE_COLORS,
  WORKSPACE_COLOR_VALUES,
  useAppearanceStore,
  type NavigationLayout,
  type WorkspaceColor,
} from "../appearance.ts";
import { useAppsStore } from "../reducer/apps.ts";
import { workspaceStateById, type WorkspaceMap } from "./store.ts";
import { positionNavigationPopover } from "./TrayPopover.tsx";
import type { WorkspaceId, WorkspaceState } from "./types.ts";

const PREVIEW_POPOVER_ID = "workspace-preview-popover";
const HOVER_EXIT_DELAY_MS = 100;

export type WorkspacePreviewApp = Readonly<{
  appId: string;
  icon: string;
  name: string;
}>;

export function WorkspaceSwitcher({
  activeWorkspaceId,
  onSelectWorkspace,
  shownWorkspaceIds,
  workspaceDropTargetId,
  workspaces,
}: {
  activeWorkspaceId: WorkspaceId;
  onSelectWorkspace: (workspaceId: WorkspaceId) => void;
  shownWorkspaceIds: readonly WorkspaceId[];
  workspaceDropTargetId: WorkspaceId | null;
  workspaces: WorkspaceMap;
}) {
  const apps = useAppsStore((state) => state.list);
  const navigationLayout = useAppearanceStore(
    (state) => state.navigationLayout,
  );
  const workspaceColors = useAppearanceStore((state) => state.workspaceColors);
  const setWorkspaceColor = useAppearanceStore(
    (state) => state.setWorkspaceColor,
  );
  const [previewWorkspaceId, setPreviewWorkspaceId] =
    useState<WorkspaceId | null>(null);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const previewColorRef = useRef<HTMLButtonElement>(null);
  const keyboardPreviewFocusRef = useRef<WorkspaceId | null>(null);
  const triggerRefs = useRef(new Map<WorkspaceId, HTMLButtonElement>());
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelScheduledClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const closePreview = useCallback(() => {
    cancelScheduledClose();
    keyboardPreviewFocusRef.current = null;
    setPreviewWorkspaceId(null);
    setColorPickerOpen(false);
  }, [cancelScheduledClose]);

  const scheduleClose = useCallback(
    (respectFocus: boolean) => {
      cancelScheduledClose();
      closeTimerRef.current = setTimeout(() => {
        closeTimerRef.current = null;
        const activeElement = document.activeElement;
        if (
          respectFocus &&
          activeElement &&
          (switcherRef.current?.contains(activeElement) ||
            previewRef.current?.contains(activeElement))
        )
          return;
        setPreviewWorkspaceId(null);
        setColorPickerOpen(false);
      }, HOVER_EXIT_DELAY_MS);
    },
    [cancelScheduledClose],
  );

  const showPreview = useCallback(
    (workspaceId: WorkspaceId) => {
      if (workspaceDropTargetId !== null) return;
      cancelScheduledClose();
      if (previewWorkspaceId === workspaceId) return;
      setColorPickerOpen(false);
      setPreviewWorkspaceId(workspaceId);
    },
    [cancelScheduledClose, previewWorkspaceId, workspaceDropTargetId],
  );

  const enterPreviewFromKeyboard = useCallback(
    (workspaceId: WorkspaceId) => {
      if (workspaceDropTargetId !== null) return;
      cancelScheduledClose();
      if (
        previewWorkspaceId === workspaceId &&
        previewColorRef.current !== null
      ) {
        keyboardPreviewFocusRef.current = null;
        previewColorRef.current.focus({ preventScroll: true });
        return;
      }
      keyboardPreviewFocusRef.current = workspaceId;
      setColorPickerOpen(false);
      setPreviewWorkspaceId(workspaceId);
    },
    [cancelScheduledClose, previewWorkspaceId, workspaceDropTargetId],
  );

  useEffect(
    () => () => {
      cancelScheduledClose();
    },
    [cancelScheduledClose],
  );

  useEffect(() => {
    if (
      workspaceDropTargetId !== null ||
      (previewWorkspaceId !== null &&
        !shownWorkspaceIds.includes(previewWorkspaceId))
    ) {
      closePreview();
    }
  }, [
    closePreview,
    previewWorkspaceId,
    shownWorkspaceIds,
    workspaceDropTargetId,
  ]);

  useEffect(() => {
    closePreview();
  }, [activeWorkspaceId, closePreview]);

  useLayoutEffect(() => {
    if (previewWorkspaceId === null) return;
    positionWorkspacePreview(
      previewRef.current,
      triggerRefs.current.get(previewWorkspaceId) ?? null,
      navigationLayout,
    );
    if (keyboardPreviewFocusRef.current === previewWorkspaceId) {
      keyboardPreviewFocusRef.current = null;
      previewColorRef.current?.focus({ preventScroll: true });
    }
  }, [navigationLayout, previewWorkspaceId]);

  useEffect(() => {
    if (previewWorkspaceId === null) return;
    const reposition = () => {
      const trigger = triggerRefs.current.get(previewWorkspaceId) ?? null;
      positionWorkspacePreview(
        previewRef.current,
        trigger,
        navigationLayout,
      );
    };
    const switcher = switcherRef.current;
    window.addEventListener("resize", reposition);
    switcher?.addEventListener("scroll", reposition);
    window.visualViewport?.addEventListener("resize", reposition);
    window.visualViewport?.addEventListener("scroll", reposition);
    return () => {
      window.removeEventListener("resize", reposition);
      switcher?.removeEventListener("scroll", reposition);
      window.visualViewport?.removeEventListener("resize", reposition);
      window.visualViewport?.removeEventListener("scroll", reposition);
    };
  }, [navigationLayout, previewWorkspaceId]);

  const previewWorkspace =
    previewWorkspaceId === null
      ? null
      : (workspaces[previewWorkspaceId] ?? null);
  const previewApps = useMemo(
    () =>
      previewWorkspace ? workspacePreviewApps(previewWorkspace, apps) : [],
    [apps, previewWorkspace],
  );
  const selectedColor =
    previewWorkspaceId === null
      ? null
      : (workspaceColors[previewWorkspaceId] ?? null);

  return (
    <>
      <div
        className="workspace-switcher"
        data-tid="workspace-switcher"
        ref={switcherRef}
      >
        {shownWorkspaceIds.map((id) => {
          const workspace = workspaceStateById(workspaces, id);
          const active = id === activeWorkspaceId;
          const dropTarget = id === workspaceDropTargetId;
          const occupancy = workspaceOccupancy(workspace.tiles.length);
          const color = workspaceColors[id] ?? null;
          return (
            <button
              aria-controls={
                previewWorkspaceId === id ? PREVIEW_POPOVER_ID : undefined
              }
              aria-current={active ? "page" : undefined}
              aria-expanded={previewWorkspaceId === id}
              aria-haspopup="dialog"
              aria-label={`Workspace ${id}, ${occupancy.label}`}
              className={[
                active ? "active" : "",
                occupancy.occupied ? "occupied" : "empty",
                dropTarget ? "workspace-drop-target" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              data-tile-count={occupancy.indicatorCount}
              data-tid={`workspace-switch-${id}`}
              data-workspace-drop-target={id}
              id={`workspace-switch-trigger-${id}`}
              key={id}
              onBlur={() => scheduleClose(true)}
              onClick={() => {
                closePreview();
                onSelectWorkspace(id);
              }}
              onFocus={() => showPreview(id)}
              onKeyDown={(event) => {
                if (
                  event.key !== workspacePreviewEntryKey(navigationLayout)
                ) {
                  return;
                }
                event.preventDefault();
                enterPreviewFromKeyboard(id);
              }}
              onPointerEnter={(event: ReactPointerEvent<HTMLButtonElement>) => {
                if (event.pointerType !== "touch" && event.buttons === 0) {
                  showPreview(id);
                }
              }}
              onPointerLeave={() => scheduleClose(false)}
              ref={(element) => {
                if (element) triggerRefs.current.set(id, element);
                else triggerRefs.current.delete(id);
              }}
              type="button"
            >
              <span
                aria-hidden="true"
                className={`workspace-glyph workspace-glyph--${occupancy.indicatorCount}`}
                style={workspaceGlyphStyle(color)}
              >
                {Array.from(
                  { length: occupancy.indicatorCount },
                  (_, index) => (
                    <span className="workspace-glyph-cell" key={index} />
                  ),
                )}
              </span>
            </button>
          );
        })}
      </div>
      {previewWorkspace && previewWorkspaceId !== null ? (
        <div
          aria-labelledby={`workspace-switch-trigger-${previewWorkspaceId}`}
          className="workspace-preview"
          data-tid="workspace-preview"
          data-workspace-id={previewWorkspaceId}
          id={PREVIEW_POPOVER_ID}
          onBlurCapture={(event) => {
            const next = event.relatedTarget;
            if (
              !(next instanceof Node) ||
              !event.currentTarget.contains(next)
            ) {
              scheduleClose(true);
            }
          }}
          onFocusCapture={cancelScheduledClose}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            const trigger = triggerRefs.current.get(previewWorkspaceId) ?? null;
            trigger?.focus({ preventScroll: true });
            closePreview();
          }}
          onPointerEnter={cancelScheduledClose}
          onPointerLeave={() => scheduleClose(false)}
          ref={previewRef}
          role="dialog"
        >
          <div className="workspace-preview-content">
            {previewApps.length > 0 ? (
              <div
                aria-label={`Apps in workspace ${previewWorkspaceId}`}
                className="workspace-preview-apps"
                role="list"
              >
                {previewApps.map((app) => (
                  <div
                    className="workspace-preview-app"
                    data-app-id={app.appId}
                    key={app.appId}
                    role="listitem"
                  >
                    <img alt="" draggable={false} src={app.icon} />
                    <span>{app.name}</span>
                  </div>
                ))}
              </div>
            ) : null}
            <button
              aria-expanded={colorPickerOpen}
              aria-label={
                selectedColor
                  ? `Change workspace ${previewWorkspaceId} color, currently ${selectedColor}`
                  : `Choose workspace ${previewWorkspaceId} color`
              }
              className="workspace-preview-color"
              data-tid="workspace-preview-color"
              onClick={() => setColorPickerOpen((open) => !open)}
              ref={previewColorRef}
              type="button"
            >
              <span
                aria-hidden="true"
                className="workspace-preview-color-swatch"
                style={workspaceSwatchStyle(selectedColor)}
              >
                {selectedColor === null ? <IoColorPaletteOutline /> : null}
              </span>
            </button>
            {colorPickerOpen ? (
              <div
                aria-label={`Workspace ${previewWorkspaceId} color`}
                className="workspace-color-picker"
                data-tid="workspace-color-picker"
                role="group"
              >
                {WORKSPACE_COLORS.map((color) => {
                  const selected = color === selectedColor;
                  return (
                    <button
                      aria-label={`${color}${
                        selected ? ", selected; choose again to clear" : ""
                      }`}
                      aria-pressed={selected}
                      className="workspace-color-option"
                      data-color={color}
                      key={color}
                      onClick={() =>
                        setWorkspaceColor(
                          previewWorkspaceId,
                          selected ? null : color,
                        )
                      }
                      style={workspaceSwatchStyle(color)}
                      title={color}
                      type="button"
                    />
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

export function workspacePreviewApps(
  workspace: Pick<WorkspaceState, "tiles">,
  apps: AppRegistry,
): WorkspacePreviewApp[] {
  const seen = new Set<string>();
  const previewApps: WorkspacePreviewApp[] = [];
  for (const tile of workspace.tiles) {
    if (seen.has(tile.appId)) continue;
    seen.add(tile.appId);
    const app = apps[tile.appId];
    previewApps.push({
      appId: tile.appId,
      icon: tile.icon || app?.icon || "",
      name: app?.name || tile.title || tile.appId,
    });
  }
  return previewApps;
}

export function workspaceOccupancy(tileCount: number): Readonly<{
  indicatorCount: number;
  label: string;
  occupied: boolean;
}> {
  return {
    indicatorCount: Math.min(tileCount, 4),
    label:
      tileCount === 0
        ? "empty"
        : `${tileCount} open tile${tileCount === 1 ? "" : "s"}`,
    occupied: tileCount > 0,
  };
}

export function workspacePreviewEntryKey(
  navigationLayout: NavigationLayout,
): "ArrowDown" | "ArrowRight" {
  return navigationLayout === "vertical" ? "ArrowRight" : "ArrowDown";
}

export function positionWorkspacePreview(
  popover: HTMLElement | null,
  button: HTMLElement | null,
  navigationLayout: NavigationLayout = "horizontal",
): void {
  const glyph = button?.querySelector<HTMLElement>(".workspace-glyph") ?? null;
  const firstIcon = popover?.querySelector<HTMLElement>(
    ".workspace-preview-app img, .workspace-preview-color-swatch",
  );
  const popoverRect = popover?.getBoundingClientRect();
  const iconRect = firstIcon?.getBoundingClientRect();
  positionNavigationPopover(popover, button, {
    align: "start",
    anchor: glyph,
    anchorBlockOffset:
      popoverRect && iconRect ? iconRect.top - popoverRect.top : 0,
    anchorInlineOffset:
      popoverRect && iconRect ? iconRect.left - popoverRect.left : 0,
    placement: navigationLayout === "vertical" ? "right" : "below",
    propertyPrefix: "workspace-preview",
    gap: 6,
  });
}

function workspaceGlyphStyle(
  color: WorkspaceColor | null,
): CSSProperties | undefined {
  return color ? { color: WORKSPACE_COLOR_VALUES[color] } : undefined;
}

function workspaceSwatchStyle(
  color: WorkspaceColor | null,
): CSSProperties | undefined {
  return color
    ? ({ "--workspace-color": WORKSPACE_COLOR_VALUES[color] } as CSSProperties)
    : undefined;
}
