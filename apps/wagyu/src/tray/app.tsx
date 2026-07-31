import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  IoArrowRedoOutline,
  IoChatbubbleOutline,
  IoHeartOutline,
  IoNotificationsOutline,
  IoPersonAddOutline,
  IoRefreshOutline,
  IoWarningOutline,
} from "react-icons/io5";
import {
  dismissTray,
  onAppStateChange,
} from "neutron-tools/app";
import {
  WAGYU_RESIDENT_TOPICS,
  type WagyuResidentNotification,
} from "../resident/contracts.ts";
import type { WagyuResidentSnapshot } from "../resident/orchestrator.ts";
import { WagyuResidentClient } from "./client.ts";

const START_RETRY_DELAYS = [0, 120, 400, 1_000] as const;
const RECOVERY_POLL_MS = 60_000;

export function WagyuTrayApp() {
  const client = useMemo(() => new WagyuResidentClient(), []);
  const [snapshot, setSnapshot] = useState<WagyuResidentSnapshot | null>(null);
  const [busy, setBusy] = useState(true);
  const [transportError, setTransportError] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const accept = useCallback((next: WagyuResidentSnapshot): void => {
    setSnapshot((current) => {
      if (
        current !== null &&
        BigInt(next.residentRevision) < BigInt(current.residentRevision)
      ) {
        return current;
      }
      return next;
    });
    setTransportError(null);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const sequence = ++requestSequence.current;
    setBusy(true);
    try {
      accept(await client.snapshot());
    } catch (cause) {
      if (sequence === requestSequence.current) {
        setTransportError(errorMessage(cause));
      }
    } finally {
      if (sequence === requestSequence.current) setBusy(false);
    }
  }, [accept, client]);

  useEffect(() => {
    let active = true;
    const start = async () => {
      for (const delay of START_RETRY_DELAYS) {
        if (!active) return;
        if (delay > 0) await wait(delay);
        const sequence = ++requestSequence.current;
        try {
          const next = await client.snapshot();
          if (active) {
            accept(next);
            setBusy(false);
          }
          return;
        } catch (cause) {
          if (active && sequence === requestSequence.current) {
            setTransportError(errorMessage(cause));
          }
        }
      }
      if (active) setBusy(false);
    };
    void start();
    return () => {
      active = false;
    };
  }, [accept, client]);

  useEffect(
    () =>
      onAppStateChange(WAGYU_RESIDENT_TOPICS.notifications, () => {
        void refresh();
      }),
    [refresh],
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, RECOVERY_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void dismissTray();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, []);

  const displayedError =
    transportError ??
    (snapshot?.lastError?.operation === "notification_page"
      ? snapshot.lastError.message
      : null);
  const notifications = snapshot?.notificationItems ?? [];

  return (
    <main className="nt-app nt-app--fill wagyu-tray" data-tid="wagyu-tray">
      <section
        className="nt-pane wagyu-tray__pane"
        aria-label="Wagyu notifications"
      >
        <div className="nt-pane-body wagyu-tray__body">
          {busy && snapshot === null ? (
            <div
              aria-label="Loading notifications"
              className="wagyu-tray__loading"
              role="status"
            >
              <span aria-hidden="true" className="wagyu-tray__spinner" />
            </div>
          ) : snapshot === null ? (
            <div className="nt-state nt-state--error" role="alert">
              <strong>Notifications unavailable</strong>
              <span>{displayedError ?? "Wagyu could not load notifications."}</span>
              <button
                className="nt-button nt-button--secondary nt-button--sm"
                onClick={() => void refresh()}
                type="button"
              >
                <IoRefreshOutline aria-hidden="true" />
                Retry
              </button>
            </div>
          ) : notifications.length > 0 ? (
            <div className="wagyu-tray__notifications" role="list">
              {notifications.map((notification) => (
                <NotificationRow
                  item={notification}
                  key={notification.localSequence}
                />
              ))}
            </div>
          ) : (
            <div className="nt-state nt-state--empty wagyu-tray__empty">
              <IoNotificationsOutline aria-hidden="true" />
              <strong>No notifications yet</strong>
              <span>Follows, likes, replies, and shares will appear here.</span>
            </div>
          )}

          {snapshot !== null && displayedError ? (
            <p className="nt-error wagyu-tray__error" role="alert">
              Notifications may be out of date. {displayedError}
            </p>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function NotificationRow({ item }: { item: WagyuResidentNotification }) {
  const actor = shortNode(item.actorNodeId);
  return (
    <article
      className={`wagyu-notification${item.read ? "" : " is-unread"}`}
      role="listitem"
    >
      <span className="wagyu-notification__icon" aria-hidden="true">
        <NotificationIcon kind={item.kind} />
      </span>
      <span className="wagyu-notification__copy">
        <span title={item.actorNodeId}>
          <strong>{actor}</strong> {notificationAction(item.kind)}
        </span>
        <time dateTime={notificationDate(item.receivedAtNs)}>
          {relativeNotificationTime(item.receivedAtNs)}
        </time>
      </span>
      {!item.read ? (
        <span className="wagyu-notification__unread">
          <span className="nt-sr-only">Unread</span>
        </span>
      ) : null}
    </article>
  );
}

function NotificationIcon({
  kind,
}: {
  kind: WagyuResidentNotification["kind"];
}) {
  switch (kind) {
    case "follow":
      return <IoPersonAddOutline />;
    case "like":
      return <IoHeartOutline />;
    case "reply":
      return <IoChatbubbleOutline />;
    case "share":
      return <IoArrowRedoOutline />;
    case "unsupported":
      return <IoWarningOutline />;
  }
}

function notificationAction(
  kind: WagyuResidentNotification["kind"],
): string {
  switch (kind) {
    case "follow":
      return "followed you";
    case "like":
      return "liked your post";
    case "reply":
      return "replied to your post";
    case "share":
      return "shared your post";
    case "unsupported":
      return "sent activity";
  }
}

function shortNode(principal: string): string {
  return principal.length <= 22
    ? principal
    : `${principal.slice(0, 10)}…${principal.slice(-8)}`;
}

function notificationDate(nanoseconds: string): string {
  try {
    return new Date(Number(BigInt(nanoseconds) / 1_000_000n)).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function relativeNotificationTime(nanoseconds: string): string {
  const milliseconds = Date.parse(notificationDate(nanoseconds));
  const seconds = Math.round((milliseconds - Date.now()) / 1_000);
  const absolute = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (absolute < 60) return formatter.format(seconds, "second");
  if (absolute < 3_600) {
    return formatter.format(Math.round(seconds / 60), "minute");
  }
  if (absolute < 86_400) {
    return formatter.format(Math.round(seconds / 3_600), "hour");
  }
  return formatter.format(Math.round(seconds / 86_400), "day");
}

function errorMessage(cause: unknown): string {
  const message =
    cause instanceof Error ? cause.message : "Resident request failed";
  return message.slice(0, 240);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
