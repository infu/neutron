import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IoAdd,
  IoCheckmark,
  IoCheckmarkDoneOutline,
  IoClose,
  IoBrowsersOutline,
  IoRefreshOutline,
} from "react-icons/io5";
import { createRoot } from "react-dom/client";
import {
  dismissTray,
  onAppStateChange,
} from "neutron-tools/app";
import {
  TRAY_DEMO_TOPIC,
  TrayDemoClient,
  type TrayDemoSnapshot,
} from "./tray_demo.ts";
import "./tray.scss";

const START_RETRY_DELAYS = [0, 120, 400, 1_000] as const;

export function TrayApp() {
  const client = useMemo(() => new TrayDemoClient(), []);
  const [snapshot, setSnapshot] = useState<TrayDemoSnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>("initial");
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const actionInFlight = useRef(false);

  const acceptSnapshot = useCallback(
    (next: TrayDemoSnapshot): void => {
      setSnapshot((current) => {
        if (current && BigInt(next.revision) < BigInt(current.revision)) {
          return current;
        }
        return next;
      });
      setError(null);
    },
    [],
  );

  const refresh = useCallback(async (): Promise<TrayDemoSnapshot> => {
    const sequence = ++requestSequence.current;
    try {
      const next = await client.snapshot();
      acceptSnapshot(next);
      return next;
    } catch (cause) {
      if (sequence === requestSequence.current) {
        setError(errorMessage(cause));
      }
      throw cause;
    }
  }, [acceptSnapshot, client]);

  useEffect(() => {
    let active = true;
    const start = async () => {
      for (const delay of START_RETRY_DELAYS) {
        if (!active) return;
        if (delay > 0) await wait(delay);
        try {
          await refresh();
          if (active) {
            setBusy(null);
          }
          return;
        } catch {
          // refresh records only the newest failure; startup retries are bounded.
        }
      }
      if (active) setBusy(null);
    };
    void start();
    return () => {
      active = false;
    };
  }, [refresh]);

  useEffect(
    () =>
      onAppStateChange(TRAY_DEMO_TOPIC, () => {
        void refresh().catch(() => undefined);
      }),
    [refresh],
  );

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void dismissTray();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, []);

  const run = async (
    operation: string,
    action: () => Promise<TrayDemoSnapshot>,
  ): Promise<void> => {
    if (actionInFlight.current || busy) return;
    actionInFlight.current = true;
    setBusy(operation);
    setError(null);
    const sequence = ++requestSequence.current;
    try {
      const next = await action();
      acceptSnapshot(next);
    } catch (cause) {
      if (sequence === requestSequence.current) {
        setError(errorMessage(cause));
      }
    } finally {
      actionInFlight.current = false;
      setBusy(null);
    }
  };

  return (
    <main className="nt-app nt-app--fill ks-tray-app" data-tid="kitchen-tray">
      <section className="nt-pane ks-tray-pane" aria-label="Kitchen Sink Tray Demo">
        <header className="nt-pane-header ks-tray-header">
          <span className="ks-tray-heading-icon" aria-hidden="true">
            <IoBrowsersOutline />
          </span>
          <span className="ks-tray-heading-copy">
            <strong>Kitchen Sink Tray Demo</strong>
            <span>Resident popout demo</span>
          </span>
          {snapshot && snapshot.unread > 0 ? (
            <span
              aria-label={`${snapshot.unread} active demo items`}
              className="nt-badge nt-badge--danger"
              data-tid="kitchen-tray-unread"
            >
              {snapshot.unread}
            </span>
          ) : null}
          <button
            aria-label="Close Kitchen Sink Tray Demo"
            className="nt-icon-button ks-tray-close"
            onClick={() => void dismissTray()}
            title="Close"
            type="button"
          >
            <IoClose aria-hidden="true" />
          </button>
        </header>

        <div
          aria-busy={busy === "initial"}
          className="nt-pane-body ks-tray-body"
        >
          {busy === "initial" ? (
            <div
              aria-label="Connecting to resident service"
              className="nt-state nt-state--loading"
              role="status"
            >
              <span aria-hidden="true" className="nt-spinner" />
            </div>
          ) : snapshot ? (
            snapshot.notifications.length > 0 ? (
              <div className="ks-tray-notifications" role="list">
                {snapshot.notifications.map((notification) => (
                  <article
                    className={
                      notification.read
                        ? "ks-tray-notification"
                        : "ks-tray-notification is-unread"
                    }
                    data-notification-id={notification.id}
                    key={notification.id}
                    role="listitem"
                  >
                    <span className="ks-tray-unread-dot" aria-hidden="true" />
                    <span className="ks-tray-notification-copy">
                      <span className="nt-sr-only">
                        {notification.read ? "Cleared" : "Active"}:{" "}
                      </span>
                      <span className="ks-tray-notification-line">
                        <strong>{notification.title}</strong>
                        <time>{notification.time}</time>
                      </span>
                      <span>{notification.detail}</span>
                    </span>
                    <button
                      aria-label={`Clear ${notification.title} from badge`}
                      className="nt-icon-button ks-tray-read"
                      disabled={notification.read || Boolean(busy)}
                      onClick={() =>
                        void run(`read-${notification.id}`, () =>
                          client.markRead(notification.id),
                        )
                      }
                      title={notification.read ? "Badge cleared" : "Clear from badge"}
                      type="button"
                    >
                      {notification.read ? (
                        <IoCheckmark aria-hidden="true" />
                      ) : (
                        <IoCheckmarkDoneOutline aria-hidden="true" />
                      )}
                    </button>
                  </article>
                ))}
              </div>
            ) : (
              <div className="nt-state nt-state--empty">
                <strong>Tray demo ready</strong>
                <span>Add a demo item to exercise live popout state and its badge.</span>
              </div>
            )
          ) : (
            <div className="nt-state nt-state--error" role="alert">
              <strong>Resident service unavailable</strong>
              <span>{error ?? "The service did not return a snapshot."}</span>
              <button
                className="nt-button nt-button--secondary nt-button--sm"
                onClick={() => void run("refresh", refresh)}
                type="button"
              >
                <IoRefreshOutline aria-hidden="true" />
                Retry
              </button>
            </div>
          )}
          {snapshot && error ? (
            <p className="nt-error ks-tray-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="nt-pane-footer ks-tray-footer">
          <span className="ks-tray-footer-status">
            <span className={`nt-status-dot ${error ? "nt-status-dot--danger" : snapshot ? "nt-status-dot--success" : "nt-status-dot--warning"}`} aria-hidden="true" />
            <span>{error ? "resident unavailable" : snapshot ? `resident · revision ${snapshot.revision}` : "resident loading"}</span>
          </span>
          <span className="ks-tray-footer-actions">
            <button
              className="nt-button nt-button--secondary nt-button--sm"
              disabled={Boolean(busy)}
              onClick={() => void run("add", () => client.add())}
              type="button"
            >
              <IoAdd aria-hidden="true" />
              Add demo item
            </button>
            <button
              className="nt-button nt-button--sm"
              disabled={Boolean(busy) || !snapshot?.unread}
              onClick={() =>
                void run("mark-all", () => client.markAllRead())
              }
              type="button"
            >
              <IoCheckmarkDoneOutline aria-hidden="true" />
              Clear badge
            </button>
          </span>
        </footer>
      </section>
    </main>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error ?? "Unknown error");
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

const container = document.getElementById("root");
if (!container) throw new Error("Tray root element not found");
createRoot(container).render(<TrayApp />);
