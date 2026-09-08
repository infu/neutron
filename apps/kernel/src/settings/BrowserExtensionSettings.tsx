import { useEffect, useMemo, useState } from "react";
import { IoExtensionPuzzleOutline, IoRefresh } from "react-icons/io5";
import {
  connectBrowserExtension,
  disconnectBrowserExtension,
  refreshBrowserExtensionGrants,
  refreshBrowserExtensionStatus,
  revokeBrowserExtensionGrant,
  useBrowserExtensionStore,
} from "../browser_extension/service.ts";
import { useAuthStore } from "../reducer/auth.ts";
import { SettingsDisclosure } from "./SettingsDisclosure.tsx";

export function BrowserExtensionSettings() {
  const principal = useAuthStore((state) => state.principal);
  const status = useBrowserExtensionStore((state) => state.status);
  const grants = useBrowserExtensionStore((state) => state.grants);
  const connectionError = useBrowserExtensionStore((state) => state.error);
  const [open, setOpen] = useState(false);
  const [operation, setOperation] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const activeGrants = useMemo(
    () => grants.filter(
      (grant) => grant.ownerPrincipal === principal && !grant.revoked,
    ),
    [grants, principal],
  );

  useEffect(() => {
    if (open) refreshBrowserExtensionGrants();
  }, [open, principal]);

  const perform = async (name: string, action: () => void | Promise<void>) => {
    if (operation) return;
    setOperation(name);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperation(null);
    }
  };

  const revokeGrant = (id: string) => {
    setActionError(null);
    try {
      revokeBrowserExtensionGrant(id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const paired = status?.available && status.paired && !status.incompatible;
  const busy = operation !== null;
  const connectionTitle = status?.incompatible
    ? "Extension update required"
    : paired
      ? "Connected"
      : status?.available
        ? "Ready to connect"
        : status
          ? "Extension not found"
          : "Connection not checked";
  const connectionDescription = status?.incompatible
    ? "Update the Neutron browser extension, then check again."
    : paired
      ? "This connection stays active until you disconnect it."
      : status?.available
        ? "Connect once to enable extension features for approved apps."
        : status
          ? "Install the Neutron browser extension, then check again."
          : "Check for the optional Neutron browser extension.";

  return (
    <SettingsDisclosure
      contentTestId="settings-browser-extension"
      description="Optional browser connection and permanent app access"
      icon={<IoExtensionPuzzleOutline aria-hidden="true" />}
      id="settings-browser-extension"
      onToggle={() => {
        setOpen((current) => !current);
        if (!open) void perform("refresh", refreshBrowserExtensionStatus);
      }}
      open={open}
      testId="settings-browser-extension-toggle"
      title="Browser extension"
    >
      <div className="settings-theme-controls">
        <div className="settings-theme-control">
          <span className="settings-theme-control-copy">
            <strong role="status">
              {operation === "connect"
                ? "Approve the connection in the extension"
                : operation === "refresh"
                  ? "Checking connection…"
                  : connectionTitle}
            </strong>
            <small>{connectionDescription}</small>
          </span>
          <span className="settings-theme-background-actions">
            {paired ? (
              <button
                className="btn btn-sec btn-sm"
                data-tid="settings-browser-extension-disconnect"
                disabled={busy}
                onClick={() =>
                  void perform("disconnect", disconnectBrowserExtension)
                }
                type="button"
              >
                {operation === "disconnect" ? "Disconnecting…" : "Disconnect"}
              </button>
            ) : status?.available && !status.incompatible ? (
              <button
                className="btn btn-sec btn-sm"
                data-tid="settings-browser-extension-connect"
                disabled={busy}
                onClick={() =>
                  void perform("connect", connectBrowserExtension)
                }
                type="button"
              >
                {operation === "connect" ? "Connecting…" : "Connect extension"}
              </button>
            ) : null}
            <button
              aria-label="Check extension connection"
              className="btn btn-sec btn-sm"
              data-tid="settings-browser-extension-refresh"
              disabled={busy}
              onClick={() =>
                void perform("refresh", refreshBrowserExtensionStatus)
              }
              title="Check extension connection"
              type="button"
            >
              <IoRefresh aria-hidden="true" />
              {!paired ? "Check again" : null}
            </button>
          </span>
        </div>

        <div className="settings-theme-control">
          <span className="settings-theme-control-copy">
            <strong>App access</strong>
            <small>
              Approved apps keep access until you revoke it here. Disconnecting
              the extension keeps these permissions for when you reconnect.
            </small>
          </span>
        </div>

        {activeGrants.length === 0 ? (
          <p className="settings-empty">No apps have extension access.</p>
        ) : activeGrants.map((grant) => (
          <div className="settings-theme-control" key={grant.id}>
            <span className="settings-theme-control-copy">
              <strong>{grant.appName || grant.appId}</strong>
              <small>Extension route</small>
            </span>
            <span className="settings-theme-background-actions">
              <button
                aria-label={`Revoke extension access for ${grant.appName || grant.appId}`}
                className="btn btn-sec btn-sm"
                data-tid="settings-browser-extension-grant-revoke"
                onClick={() => revokeGrant(grant.id)}
                type="button"
              >
                Revoke
              </button>
            </span>
          </div>
        ))}

        {actionError || connectionError ? (
          <div className="settings-field-error" role="alert">
            {actionError || connectionError}
          </div>
        ) : null}
      </div>
    </SettingsDisclosure>
  );
}
