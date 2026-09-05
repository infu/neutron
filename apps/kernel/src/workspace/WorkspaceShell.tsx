import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { IoApps } from "react-icons/io5";
import { useAuthStore } from "../reducer/auth.ts";
import { startRuntimeAuthorityMonitor } from "../runtime_authority_monitor.ts";
import { KernelSettingsPage } from "../settings/KernelSettingsPage.tsx";
import { Launcher } from "./Launcher.tsx";
import {
  isLauncherShortcutEvent,
  isSystemModifierEvent,
} from "./modifier.ts";
import { AppBackgroundFrames } from "./AppBackgroundFrames.tsx";
import { AppTray } from "./AppTray.tsx";
import { DesktopBackground } from "./DesktopBackground.tsx";
import { FullscreenToggle } from "./FullscreenToggle.tsx";
import { KernelTrayItem } from "./KernelTrayItem.tsx";
import {
  useWorkspaceStore,
  visibleWorkspaceIds,
  workspaceStateById,
} from "./store.ts";
import { WorkspaceView } from "./WorkspaceView.tsx";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.tsx";
import type { WorkspaceId } from "./types.ts";
import { AgentModeIndicator } from "../AgentModeUI.tsx";
import { useAppearanceStore } from "../appearance.ts";

export function WorkspaceShell() {
  const { logged, authorized, loading, principal, sessionGeneration } =
    useAuthStore();
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [kernelView, setKernelView] = useState<"workspace" | "settings">(
    "workspace",
  );
  const navigationLayout = useAppearanceStore(
    (state) => state.navigationLayout,
  );
  const tileGap = useAppearanceStore((state) => state.tileGap);
  const kernelTrayTriggerRef = useRef<HTMLButtonElement>(null);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const workspaceSession =
    logged && authorized && !loading
      ? `${sessionGeneration}:${principal}`
      : null;
  // Avoid cold-starting every restored app, but never tear down a workspace
  // visited by this authenticated principal. A different auth session must
  // not revive frames retained by the previous one.
  const [mountedWorkspaces, setMountedWorkspaces] = useState<{
    session: string | null;
    ids: ReadonlySet<WorkspaceId>;
  }>(() => ({ session: workspaceSession, ids: new Set([activeWorkspaceId]) }));
  const mountedWorkspaceIds =
    mountedWorkspaces.session === workspaceSession
      ? mountedWorkspaces.ids
      : new Set<WorkspaceId>([activeWorkspaceId]);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const workspaceDropTargetId = useWorkspaceStore(
    (state) => state.workspaceDropTargetId,
  );
  const shownWorkspaceIds = visibleWorkspaceIds({
    activeWorkspaceId,
    workspaces,
  });
  const switchWorkspace = useWorkspaceStore((state) => state.switchWorkspace);
  const setExpandedTile = useWorkspaceStore((state) => state.setExpandedTile);
  const moveFocusedTileToWorkspace = useWorkspaceStore(
    (state) => state.moveFocusedTileToWorkspace
  );
  const closeTile = useWorkspaceStore((state) => state.closeTile);

  const mountWorkspace = useCallback((workspaceId: WorkspaceId) => {
    setMountedWorkspaces((mounted) => {
      const ids =
        mounted.session === workspaceSession
          ? mounted.ids
          : new Set<WorkspaceId>([activeWorkspaceId]);
      if (
        mounted.session === workspaceSession &&
        ids.has(workspaceId)
      ) {
        return mounted;
      }
      return {
        session: workspaceSession,
        ids: new Set([...ids, workspaceId]),
      };
    });
  }, [activeWorkspaceId, workspaceSession]);

  useEffect(() => {
    setMountedWorkspaces((mounted) => {
      const ids =
        mounted.session === workspaceSession
          ? mounted.ids
          : new Set<WorkspaceId>();
      if (
        mounted.session === workspaceSession &&
        ids.has(activeWorkspaceId)
      ) {
        return mounted;
      }
      return {
        session: workspaceSession,
        ids: new Set([...ids, activeWorkspaceId]),
      };
    });
  }, [activeWorkspaceId, workspaceSession]);

  useEffect(() => {
    setExpandedTile(null);
  }, [setExpandedTile, workspaceSession]);

  useEffect(() => {
    if (!logged || !authorized || loading) return;
    return startRuntimeAuthorityMonitor();
  }, [logged, authorized, loading]);

  const closeSettings = () => {
    setKernelView("workspace");
    requestAnimationFrame(() => kernelTrayTriggerRef.current?.focus());
  };

  const openSettings = () => {
    setLauncherOpen(false);
    if (document.activeElement instanceof HTMLIFrameElement) {
      document.activeElement.blur();
    }
    setKernelView("settings");
  };

  const openLauncher = () => {
    if (document.querySelector('[aria-modal="true"]')) return;
    setKernelView("workspace");
    setLauncherOpen(true);
  };

  const selectWorkspace = useCallback((workspaceId: WorkspaceId) => {
    setKernelView("workspace");
    mountWorkspace(workspaceId);
    switchWorkspace(workspaceId);
  }, [mountWorkspace, switchWorkspace]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (launcherOpen) return;
      if (shouldIgnoreShortcut(event)) return;

      if (
        event.key === "Escape" &&
        kernelView === "settings" &&
        !document.querySelector('[aria-modal="true"]') &&
        !document.querySelector("[popover]:popover-open")
      ) {
        event.preventDefault();
        closeSettings();
        return;
      }

      const key = event.key.toLowerCase();
      const systemModifier = isSystemModifierEvent(event);

      if (isLauncherShortcutEvent(event)) {
        event.preventDefault();
        if (document.querySelector('[aria-modal="true"]')) return;
        setKernelView("workspace");
        setLauncherOpen((open) => !open);
        return;
      }

      const workspaceId = workspaceIdFromKey(
        event.key,
        visibleWorkspaceIds(useWorkspaceStore.getState()),
      );
      if (systemModifier && workspaceId) {
        event.preventDefault();
        if (event.shiftKey) {
          setKernelView("workspace");
          mountWorkspace(workspaceId);
          moveFocusedTileToWorkspace(workspaceId);
        } else {
          selectWorkspace(workspaceId);
        }
        return;
      }

      if (systemModifier && key === "q" && kernelView === "workspace") {
        const state = useWorkspaceStore.getState();
        const workspace = workspaceStateById(
          state.workspaces,
          state.activeWorkspaceId,
        );
        if (workspace.focusedTileId) {
          event.preventDefault();
          closeTile(workspace.focusedTileId);
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    closeTile,
    launcherOpen,
    kernelView,
    mountWorkspace,
    moveFocusedTileToWorkspace,
    selectWorkspace,
    switchWorkspace,
  ]);

  if (!logged || !authorized || loading) return null;

  return (
    <main
      className={`desktop-shell desktop-shell--nav-${navigationLayout}`}
      data-navigation-layout={navigationLayout}
      style={{ "--desktop-tile-gap": `${tileGap}px` } as CSSProperties}
    >
      <DesktopBackground />
      <div
        aria-hidden={launcherOpen ? true : undefined}
        className="desktop-topbar"
        data-tid="desktop-topbar"
        inert={launcherOpen ? true : undefined}
        onClickCapture={
          kernelView === "settings"
            ? () => setKernelView("workspace")
            : undefined
        }
      >
        <button
          type="button"
          className="icon-button desktop-start-button"
          data-tid="launcher-open"
          title="Open launcher"
          aria-label="Open launcher"
          onClick={openLauncher}
        >
          <IoApps aria-hidden="true" />
        </button>
        <WorkspaceSwitcher
          activeWorkspaceId={activeWorkspaceId}
          onSelectWorkspace={selectWorkspace}
          shownWorkspaceIds={shownWorkspaceIds}
          workspaceDropTargetId={workspaceDropTargetId}
          workspaces={workspaces}
        />
        <div className="desktop-topbar-actions">
          <AgentModeIndicator />
          <FullscreenToggle />
          <AppTray>
            <KernelTrayItem
              onOpenSettings={openSettings}
              triggerRef={kernelTrayTriggerRef}
            />
          </AppTray>
        </div>
      </div>
      <div
        aria-hidden={launcherOpen ? true : undefined}
        className="desktop-content"
        inert={launcherOpen ? true : undefined}
      >
        <div
          aria-hidden={kernelView === "settings" ? true : undefined}
          className={`kernel-workspace-surface${
            kernelView === "settings" ? " kernel-workspace-surface--hidden" : ""
          }`}
          inert={kernelView === "settings" ? true : undefined}
        >
          {shownWorkspaceIds.map((workspaceId) => {
            if (
              workspaceId !== activeWorkspaceId &&
              !mountedWorkspaceIds.has(workspaceId)
            ) {
              return null;
            }
            const active = workspaceId === activeWorkspaceId;
            return (
              <div
                aria-hidden={active ? undefined : true}
                className={`kernel-workspace-layer${
                  active ? " kernel-workspace-layer--active" : ""
                }`}
                data-active={active ? "true" : undefined}
                data-tid="workspace-layer"
                data-workspace-id={workspaceId}
                inert={active ? undefined : true}
                key={workspaceId}
              >
                <WorkspaceView
                  active={active}
                  interactive={
                    active && kernelView === "workspace" && !launcherOpen
                  }
                  workspaceId={workspaceId}
                />
              </div>
            );
          })}
        </div>
        {kernelView === "settings" ? (
          <KernelSettingsPage onBack={closeSettings} />
        ) : null}
      </div>
      {/* Let the browser discover visible tile frames before resident work. */}
      <AppBackgroundFrames />
      <Launcher open={launcherOpen} onClose={() => setLauncherOpen(false)} />
    </main>
  );
}

function workspaceIdFromKey(
  key: string,
  availableWorkspaceIds: readonly WorkspaceId[],
): WorkspaceId | null {
  const numeric = Number(key);
  if (availableWorkspaceIds.includes(numeric as WorkspaceId)) {
    return numeric as WorkspaceId;
  }
  return null;
}

function shouldIgnoreShortcut(event: KeyboardEvent): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  if (target.closest("[data-shortcuts-root]")) return false;
  if (target instanceof HTMLInputElement) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLSelectElement) return true;
  if ((target as HTMLElement).isContentEditable) return true;
  return false;
}
