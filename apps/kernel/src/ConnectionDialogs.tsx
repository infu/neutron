import {
  approveConnectionConsent,
  approveDisconnectConsent,
  rejectConnectionConsent,
  useConnectionsStore,
} from "./reducer/connections.ts";
import { PauseRequests } from "./Requests.tsx";
import {
  ConsentNotice,
  ConsentTechnicalDetails,
  focusConsentControl,
  useConsentUiMode,
} from "./consent/ConsentPresentation.tsx";
import { useEffect, useRef } from "react";

export function ConnectionDialogs() {
  const uiMode = useConsentUiMode();
  const dialog = useConnectionsStore((state) => state.dialog);
  if (!dialog) return null;

  if (dialog.kind === "disconnect") {
    return (
      <DialogShell
        describedBy="connection-consent-summary"
        labelledBy="connection-consent-title"
        onDismiss={() => rejectConnectionConsent()}
      >
        <div className="title" id="connection-consent-title">
          Disconnect {dialog.providerName}
        </div>
        <div className="call">
          <ConsentNotice tone="warning">
            <span id="connection-consent-summary">
              <strong>{dialog.appName}</strong> will immediately lose access to{" "}
              <strong>{dialog.providerName}</strong> on this Neutron.
            </span>
          </ConsentNotice>
          <ConsentTechnicalDetails mode={uiMode}>
            <div className="a-infogrid connection-summary">
              <div className="label">Application</div>
              <div className="val">{dialog.appName}</div>
              <div className="label">Provider</div>
              <div className="val">{dialog.providerName}</div>
            </div>
            <div className="dialog-section connection-disclosure">
              The app will lose access to this connection on Neutron.
            </div>
          </ConsentTechnicalDetails>
          <div className="btn-actions">
            <PauseRequests
              appId={dialog.appId}
              onPause={() => rejectConnectionConsent()}
            />
            <button
              type="button"
              className="btn btn-danger"
              onClick={approveDisconnectConsent}
            >
              Disconnect
            </button>
            <button
              data-consent-initial-focus
              type="button"
              className="btn btn-sec"
              onClick={() => rejectConnectionConsent()}
            >
              Cancel
            </button>
          </div>
        </div>
      </DialogShell>
    );
  }

  return (
    <DialogShell
      describedBy="connection-consent-summary"
      labelledBy="connection-consent-title"
      onDismiss={() => rejectConnectionConsent()}
    >
      <div className="title" id="connection-consent-title">
        Connect to {dialog.providerName}
      </div>
      <div className="call">
        <ConsentNotice tone="danger">
          <span id="connection-consent-summary">
            <strong>{dialog.appName}</strong> wants to connect to{" "}
            <strong>{dialog.providerName}</strong>. Its isolated background
            process will receive the credential and can use it directly while
            running.
          </span>
        </ConsentNotice>
        {dialog.scopes.length > 0 ? (
          <ConsentNotice tone="neutral">
            <strong>Requested service access:</strong>{" "}
            {dialog.scopes.join(", ")}
          </ConsentNotice>
        ) : null}
        <ConsentTechnicalDetails mode={uiMode}>
          <div className="a-infogrid connection-summary">
            <div className="label">Application</div>
            <div className="val">{dialog.appName}</div>
            <div className="label">Provider</div>
            <div className="val">{dialog.providerName}</div>
            {dialog.scopes.length > 0 && (
              <>
                <div className="label">Scopes</div>
                <div className="val">{dialog.scopes.join(", ")}</div>
              </>
            )}
          </div>
          <div className="dialog-section connection-disclosure">
            {dialog.appName}&apos;s isolated resident process will receive the
            credential for direct provider requests.
          </div>
        </ConsentTechnicalDetails>
        {dialog.error && <div className="connection-error">{dialog.error}</div>}
        {dialog.phase === "waiting" ? (
          <div className="compile-loading connection-waiting">
            <div className="loader" />
            <div>Waiting for authorization</div>
          </div>
        ) : (
          <div className="btn-actions">
            <PauseRequests
              appId={dialog.appId}
              onPause={() => rejectConnectionConsent()}
            />
            <button
              type="button"
              className="btn btn-warning"
              onClick={approveConnectionConsent}
            >
              Continue
            </button>
            <button
              type="button"
              className="btn btn-sec"
              data-consent-initial-focus
              onClick={() => rejectConnectionConsent()}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </DialogShell>
  );
}

function DialogShell({
  children,
  describedBy,
  labelledBy,
  onDismiss,
}: {
  children: React.ReactNode;
  describedBy: string;
  labelledBy: string;
  onDismiss: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    focusConsentControl(
      dialogRef.current?.querySelector<HTMLElement>(
        "[data-consent-initial-focus]",
      ),
    );
  }, [describedBy, labelledBy]);
  return (
    <>
      <div className="backdrop" onClick={onDismiss}></div>
      <div
        aria-describedby={describedBy}
        aria-labelledby={labelledBy}
        aria-modal="true"
        className="dialog dialog-warning connection-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onDismiss();
            return;
          }
          if (event.key !== "Tab") return;
          const controls =
            dialogRef.current?.querySelectorAll<HTMLElement>(
              'summary, button:not([disabled]), select:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
            );
          if (!controls?.length) return;
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (!first || !last) return;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        ref={dialogRef}
        role="alertdialog"
      >
        {children}
      </div>
    </>
  );
}
