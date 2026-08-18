import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  IoAdd,
  IoLinkOutline,
  IoRefresh,
  IoSearch,
  IoTrashOutline,
} from "react-icons/io5";
import {
  appDependencyImpact,
  planAppRegistryDependencies,
} from "neutron-compiler/src/install.js";
import {
  install_app,
  isAuthorityPendingState,
  uninstall_app,
  useAppsStore,
  type AppInstallSource,
} from "../reducer/apps.ts";
import { isAbortError } from "../tools/package_url.ts";
import {
  launcherEntriesFromApps,
  launcherSystemActions,
  type LauncherEntry,
} from "./launcher_entries.ts";
import { useWorkspaceStore } from "./store.ts";
import type { WorkspaceId } from "./types.ts";

type LauncherProps =
  | {
      open: boolean;
      onClose: () => void;
      placement?: "modal";
    }
  | {
      placement: "workspace";
      workspaceId: WorkspaceId;
    };

export function Launcher(props: LauncherProps) {
  const placement = props.placement ?? "modal";
  const open = props.placement === "workspace" ? true : props.open;
  const onClose =
    props.placement === "workspace" ? undefined : props.onClose;
  const idPrefix =
    props.placement === "workspace"
      ? `workspace-launcher-${props.workspaceId}`
      : "launcher";
  const testId = (id: string) =>
    placement === "modal" ? id : `workspace-${id}`;
  const [query, setQuery] = useState("");
  const [installSource, setInstallSource] = useState<
    "file" | "url" | "uninstall" | null
  >(null);
  const [installUrl, setInstallUrl] = useState("");
  const [installError, setInstallError] = useState<string | null>(null);
  const [urlInstallOpen, setUrlInstallOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const installUrlInputRef = useRef<HTMLInputElement>(null);
  const installUrlButtonRef = useRef<HTMLButtonElement>(null);
  const installRunRef = useRef(false);
  const urlDownloadAbortRef = useRef<AbortController | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const apps = useAppsStore((state) => state.list);
  const operationBusy = useAppsStore((state) => state.operationBusy);
  const authorityPending = useAppsStore(isAuthorityPendingState);
  const appMutationBlocked = operationBusy || authorityPending;
  const openTile = useWorkspaceStore((state) => state.openTile);
  const resetCurrentWorkspace = useWorkspaceStore(
    (state) => state.resetCurrentWorkspace,
  );

  useEffect(() => {
    if (!open) {
      urlDownloadAbortRef.current?.abort();
      urlDownloadAbortRef.current = null;
      return;
    }
    setQuery("");
    setInstallError(null);
    setInstallUrl("");
    setUrlInstallOpen(false);
    if (placement === "modal") {
      openerRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open, placement]);

  useEffect(
    () => () => {
      urlDownloadAbortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (open && urlInstallOpen) installUrlInputRef.current?.focus();
  }, [open, urlInstallOpen]);

  const close = (restoreFocus: boolean) => {
    const opener = openerRef.current;
    urlDownloadAbortRef.current?.abort();
    urlDownloadAbortRef.current = null;
    onClose?.();
    if (placement === "workspace") {
      setQuery("");
      setInstallError(null);
      setInstallUrl("");
      setUrlInstallOpen(false);
    } else if (restoreFocus && opener?.isConnected) {
      requestAnimationFrame(() => opener.focus());
    }
  };

  const entries = useMemo(
    () => launcherEntriesFromApps(apps, query),
    [apps, query],
  );
  const dependencyPlan = useMemo(() => {
    try {
      return planAppRegistryDependencies(apps);
    } catch {
      return null;
    }
  }, [apps]);

  if (!open) return null;

  const launch = (entry: LauncherEntry) => {
    openTile({
      appId: entry.appId,
      tileId: entry.tileId,
      title: workspaceTileTitle(entry.appName, entry.title),
      path: entry.path,
      icon: entry.icon,
    });
    close(true);
  };

  const installPackage = async (source: AppInstallSource) => {
    if (
      installRunRef.current ||
      useAppsStore.getState().operationBusy ||
      isAuthorityPendingState(useAppsStore.getState())
    ) return;
    installRunRef.current = true;
    setInstallSource(source.kind);
    setInstallError(null);
    try {
      const result = await install_app(source);
      if (result) {
        const entry = result.apps[result.appId];
        const tile = entry?.tiles[0];
        if (entry && tile) {
          openTile({
            appId: result.appId,
            tileId: tile.id,
            title: workspaceTileTitle(entry.name, tile.title),
            path: tile.path,
            icon: tile.icon,
          });
        }
      }
      close(true);
    } catch (error) {
      if (!quietInstallCancellation(error)) {
        const message = installErrorMessage(error);
        setInstallError(message);
        console.error(`Install package failed: ${message}`);
      }
    } finally {
      if (source.kind === "url") urlDownloadAbortRef.current = null;
      installRunRef.current = false;
      setInstallSource(null);
    }
  };

  const installPackageFromUrl = () => {
    const abort = new AbortController();
    urlDownloadAbortRef.current?.abort();
    urlDownloadAbortRef.current = abort;
    void installPackage({
      kind: "url",
      signal: abort.signal,
      url: installUrl,
    });
  };

  const closeUrlInstall = (restoreFocus: boolean) => {
    urlDownloadAbortRef.current?.abort();
    urlDownloadAbortRef.current = null;
    setInstallError(null);
    setInstallUrl("");
    setUrlInstallOpen(false);
    if (restoreFocus) {
      requestAnimationFrame(() => installUrlButtonRef.current?.focus());
    }
  };

  const uninstallPackage = async (appId: string) => {
    if (
      installRunRef.current ||
      useAppsStore.getState().operationBusy ||
      isAuthorityPendingState(useAppsStore.getState())
    ) return;
    setInstallSource("uninstall");
    try {
      const result = await uninstall_app(appId);
      if (result) close(true);
    } catch (error) {
      console.error("Uninstall package failed", error);
    } finally {
      setInstallSource(null);
    }
  };

  return (
    <>
      {placement === "modal" ? (
        <div
          aria-hidden="true"
          className="launcher-backdrop"
          onClick={() => close(true)}
        />
      ) : null}
      <div
        aria-label="App launcher"
        aria-modal={placement === "modal" ? "true" : undefined}
        className={`launcher launcher--${placement}`}
        data-tid={
          placement === "modal" ? "launcher" : "workspace-launcher"
        }
        onKeyDown={
          placement === "modal"
            ? (event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  close(true);
                  return;
                }
                if (event.key === "Tab" && dialogRef.current) {
                  trapLauncherFocus(dialogRef.current, event);
                }
              }
            : undefined
        }
        ref={dialogRef}
        role={placement === "modal" ? "dialog" : "region"}
        tabIndex={placement === "modal" ? -1 : undefined}
      >
        <div className="launcher-search">
          <IoSearch aria-hidden="true" />
          <input
            aria-label="Search app tiles"
            ref={inputRef}
            data-tid={testId("launcher-search")}
            value={query}
            placeholder="Search tiles"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && entries[0]) launch(entries[0]);
            }}
          />
        </div>
        {placement === "modal" ? (
          <div className="launcher-actions launcher-actions--modal">
            <button
              type="button"
              className="launcher-action"
              data-tid={launcherSystemActions.resetWorkspace}
              onClick={() => {
                resetCurrentWorkspace();
                close(true);
              }}
            >
              <IoRefresh aria-hidden="true" />
              <span>Reset Current Workspace</span>
            </button>
          </div>
        ) : null}
        {urlInstallOpen ? (
          <form
            aria-busy={installSource === "url"}
            className="launcher-url-panel"
            id={`${idPrefix}-install-url-panel`}
            noValidate
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              closeUrlInstall(true);
            }}
            onSubmit={(event) => {
              event.preventDefault();
              installPackageFromUrl();
            }}
          >
            <label htmlFor={`${idPrefix}-install-url`}>
              App package URL
            </label>
            <div className="launcher-url-row">
              <div className="launcher-url-input">
                <IoLinkOutline aria-hidden="true" />
                <input
                  aria-describedby={
                    installError
                      ? `${idPrefix}-install-url-error`
                      : `${idPrefix}-install-url-help`
                  }
                  aria-invalid={installError ? "true" : undefined}
                  autoComplete="url"
                  data-tid={testId("launcher-install-url-input")}
                  disabled={installSource !== null || appMutationBlocked}
                  id={`${idPrefix}-install-url`}
                  onChange={(event) => {
                    setInstallUrl(event.target.value);
                    setInstallError(null);
                  }}
                  placeholder="https://example.com/app.v0.1.0.neutron"
                  ref={installUrlInputRef}
                  spellCheck={false}
                  type="url"
                  value={installUrl}
                />
              </div>
              <button
                className="btn launcher-url-submit"
                data-tid={testId("launcher-install-url-submit")}
                disabled={installSource !== null || appMutationBlocked}
                type="submit"
              >
                {installSource === "url" ? "Preparing..." : "Install"}
              </button>
              <button
                className="btn btn-sec launcher-url-cancel"
                data-tid={testId("launcher-install-url-cancel")}
                onClick={() => closeUrlInstall(true)}
                type="button"
              >
                Cancel
              </button>
            </div>
            {installError ? (
              <div
                className="launcher-install-error"
                data-tid={testId("launcher-install-url-error")}
                id={`${idPrefix}-install-url-error`}
                role="alert"
              >
                {installError}
              </div>
            ) : (
              <div
                className="launcher-url-help"
                id={`${idPrefix}-install-url-help`}
              >
                HTTPS package URL. You will review the same install request before
                anything changes.
              </div>
            )}
          </form>
        ) : installError ? (
          <div className="launcher-install-error" role="alert">
            {installError}
          </div>
        ) : null}
        <div className="launcher-results">
          <div className="launcher-tile-row launcher-install-entry">
            <div className="launcher-install-tile">
              <span aria-hidden="true" className="launcher-install-icon">
                <IoAdd />
              </span>
              <div
                aria-label="Install app from"
                className="launcher-install-buttons"
                role="group"
              >
                <button
                  aria-label="Install app from File"
                  className="launcher-install-button"
                  data-tid={testId(launcherSystemActions.installPackage)}
                  disabled={installSource !== null || appMutationBlocked}
                  onClick={() => {
                    closeUrlInstall(false);
                    void installPackage({ kind: "file" });
                  }}
                  type="button"
                >
                  <span>File</span>
                </button>
                <button
                  aria-controls={`${idPrefix}-install-url-panel`}
                  aria-expanded={urlInstallOpen}
                  aria-label="Install app from URL"
                  className={`launcher-install-button${urlInstallOpen ? " is-active" : ""}`}
                  data-tid={testId(launcherSystemActions.installPackageUrl)}
                  disabled={installSource !== null || appMutationBlocked}
                  onClick={() => {
                    if (urlInstallOpen) closeUrlInstall(false);
                    else {
                      setInstallError(null);
                      setUrlInstallOpen(true);
                    }
                  }}
                  ref={installUrlButtonRef}
                  type="button"
                >
                  <span>URL</span>
                </button>
              </div>
            </div>
          </div>
          {entries.map((entry) => {
            const impact = dependencyPlan
              ? appDependencyImpact(dependencyPlan, entry.appId)
              : null;
            const dependentNames = [
              ...new Set(
                (impact?.direct ?? []).map(({ consumer }) => consumer),
              ),
            ].map((consumer) => apps[consumer]?.name ?? consumer);
            const uninstallDisabled =
              installSource !== null ||
              appMutationBlocked ||
              dependencyPlan === null ||
              dependentNames.length > 0;
            const uninstallTitle =
              dependentNames.length > 0
                ? `Required by ${dependentNames.join(", ")}`
                : authorityPending
                  ? "Finish or discard the pending installation first"
                  : dependencyPlan === null
                    ? "Resolve app dependency metadata before uninstalling"
                    : `Uninstall ${entry.appName}`;
            return (
              <div
                className="launcher-tile-row"
                key={`${entry.appId}/${entry.tileId}`}
              >
                <button
                  type="button"
                  className="launcher-tile"
                  data-tid={testId(
                    `launcher-tile-${entry.appId}-${entry.tileId}`,
                  )}
                  onClick={() => launch(entry)}
                >
                  <img src={entry.icon} alt="" />
                  <span className="launcher-tile-title">{entry.title}</span>
                </button>
                <button
                  type="button"
                  className="launcher-uninstall"
                  title={uninstallTitle}
                  aria-label={uninstallTitle}
                  disabled={uninstallDisabled}
                  onClick={() =>
                    void uninstallPackage(entry.appId)
                  }
                >
                  <IoTrashOutline aria-hidden="true" />
                </button>
              </div>
            );
          })}
          {entries.length === 0 ? (
            <div className="launcher-empty">No matching tiles</div>
          ) : null}
        </div>
      </div>
    </>
  );
}

function trapLauncherFocus(
  dialog: HTMLElement,
  event: ReactKeyboardEvent<HTMLElement>,
): void {
  const focusable = [...dialog.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  )];
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusable[0]!;
  const last = focusable.at(-1)!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function quietInstallCancellation(error: unknown): boolean {
  return (
    isAbortError(error) ||
    (error instanceof Error &&
      (error.message === "File picker cancelled" ||
        error.message === "User rejected" ||
        error.message === "Install request cancelled"))
  );
}

function installErrorMessage(error: unknown): string {
  const fallback = "The app package could not be prepared";
  const message = error instanceof Error ? error.message.trim() : fallback;
  if (!message) return fallback;
  return message.length <= 320 ? message : `${message.slice(0, 317)}...`;
}

function workspaceTileTitle(appName: string, tileTitle: string): string {
  return appName.trim().toLocaleLowerCase() ===
    tileTitle.trim().toLocaleLowerCase()
    ? tileTitle
    : `${appName}: ${tileTitle}`;
}
