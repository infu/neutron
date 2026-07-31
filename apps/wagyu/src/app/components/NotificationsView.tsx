import {
  IoArrowRedoOutline,
  IoChatbubbleOutline,
  IoHeartOutline,
  IoNotificationsOutline,
  IoPersonAddOutline,
  IoRefreshOutline,
  IoTimeOutline,
  IoWarningOutline,
} from "react-icons/io5";
import { useEffect, useRef, useState } from "react";
import type { NotificationItem, NotificationPage } from "../model.ts";
import {
  notificationCopy,
  profileMayRenderRemoteText,
  relativeTime,
} from "../presentation.ts";
import { Avatar } from "./Avatar.tsx";

const NOTIFICATION_MOUNT_LIMIT = 100;
const NOTIFICATION_WINDOW_STEP = 50;

export function notificationNeedsAutomaticHydration(
  item: NotificationItem,
): boolean {
  if (
    item.verification === "transport-authenticated" ||
    item.verification === "verified"
  ) {
    return item.actorProfileProof === "loading";
  }
  return item.kind !== "follow" && item.verification === "pending";
}

export function NotificationsView({
  page,
  loadingMore,
  verifyingIds,
  onLoadMore,
  onOpenPost,
  onVerify,
  windowStart,
  onWindowChange,
}: {
  page: NotificationPage;
  loadingMore: boolean;
  verifyingIds: ReadonlySet<string>;
  onLoadMore: () => void;
  onOpenPost?: ((item: NotificationItem) => void) | undefined;
  onVerify: (item: NotificationItem) => void;
  onRefresh?: () => void;
  windowStart?: number;
  onWindowChange?: (start: number) => void;
}) {
  const [internalWindowStart, setInternalWindowStart] = useState(0);
  const pendingOlderCount = useRef<number | null>(null);
  const requestedStart = windowStart ?? internalWindowStart;
  const maximumStart = Math.max(0, page.items.length - NOTIFICATION_MOUNT_LIMIT);
  const start = Math.min(Math.max(0, requestedStart), maximumStart);
  const end = Math.min(page.items.length, start + NOTIFICATION_MOUNT_LIMIT);
  const updateWindow = (next: number) => {
    const bounded = Math.min(Math.max(0, next), maximumStart);
    if (windowStart === undefined) setInternalWindowStart(bounded);
    onWindowChange?.(bounded);
  };
  useEffect(() => {
    if (requestedStart !== start) updateWindow(start);
  }, [page.items.length, requestedStart, start]);
  useEffect(() => {
    const pending = pendingOlderCount.current;
    if (pending === null || page.items.length <= pending) return;
    pendingOlderCount.current = null;
    updateWindow(Math.max(0, page.items.length - NOTIFICATION_MOUNT_LIMIT));
  }, [page.items.length]);
  const hasNewer = start > 0;
  const hasLoadedOlder = end < page.items.length;

  return (
    <div className="wg-notifications">
      <header className="wg-view-heading">
        <h1>Notifications</h1>
      </header>
      {hasNewer ? (
        <button
          className="nt-button nt-button--secondary wg-load-more"
          onClick={() => updateWindow(start - NOTIFICATION_WINDOW_STEP)}
          type="button"
        >
          Show newer notifications
        </button>
      ) : null}
      <div className="wg-notification-list">
        {page.items.slice(start, end).map((item) => (
          <NotificationRow
            item={item}
            key={item.id}
            onOpenPost={onOpenPost}
            onVerify={onVerify}
            verifying={verifyingIds.has(item.id)}
          />
        ))}
        {page.items.length === 0 ? (
          <div className="nt-state nt-state--empty wg-empty-state">
            <span className="wg-empty-state__icon"><IoNotificationsOutline aria-hidden="true" /></span>
            <strong>No notifications yet</strong>
            <span>Follows, likes, replies, and shares will appear here.</span>
          </div>
        ) : null}
      </div>
      {hasLoadedOlder || page.nextCursor ? (
        <button
          aria-label="Load older notifications"
          className="nt-button nt-button--secondary wg-load-more"
          disabled={loadingMore && !hasLoadedOlder}
          onClick={() => {
            if (hasLoadedOlder) {
              updateWindow(start + NOTIFICATION_WINDOW_STEP);
            } else {
              pendingOlderCount.current = page.items.length;
              onLoadMore();
            }
          }}
          type="button"
        >
          {loadingMore && !hasLoadedOlder
            ? "Loading…"
            : "Show older notifications"}
        </button>
      ) : page.items.length > 0 ? (
        <p className="wg-end-marker">
          <span /> You're all caught up <span />
        </p>
      ) : null}
    </div>
  );
}

function NotificationRow({
  item,
  verifying,
  onOpenPost,
  onVerify,
}: {
  item: NotificationItem;
  verifying: boolean;
  onOpenPost?: ((item: NotificationItem) => void) | undefined;
  onVerify: (item: NotificationItem) => void;
}) {
  const authenticatedEvent =
    item.verification === "verified" ||
    item.verification === "transport-authenticated";
  const safeProfile = profileMayRenderRemoteText(item.actorProfileProof);
  const evidenceCanRetry =
    item.kind !== "follow" &&
    (item.verification === "pending" ||
      item.verification === "unavailable");
  // A notification page starts authenticated actors at "loading", which is
  // hydrated automatically. Once that attempt resolves to unavailable or
  // unverified, keep the safe user-ID fallback without offering a button that
  // can only return to the same state. A later page refresh starts a fresh
  // bounded lookup from "loading".
  const profileCanHydrate =
    authenticatedEvent && item.actorProfileProof === "loading";
  const canHydrate = evidenceCanRetry || profileCanHydrate;
  const actorName =
    safeProfile && item.actorDisplayName ? item.actorDisplayName : null;
  const canOpenPost =
    Boolean(onOpenPost) &&
    Boolean(item.targetPostId) &&
    authenticatedEvent &&
    (item.kind !== "reply" || Boolean(item.verifiedReply));
  const openPost = canOpenPost ? () => onOpenPost?.(item) : undefined;
  return (
    <article
      aria-label={openPost ? `Open post for ${notificationCopy(item)}` : undefined}
      className={`wg-notification ${item.read ? "" : "is-unread"}${openPost ? " is-openable" : ""}`}
      data-verification={item.verification}
      onClick={openPost}
      onKeyDown={openPost
        ? (event) => {
          if (event.currentTarget !== event.target) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          openPost();
        }
        : undefined}
      role={openPost ? "link" : undefined}
      tabIndex={openPost ? 0 : undefined}
    >
      <span className="wg-notification__kind" aria-hidden="true">
        <KindIcon item={item} />
      </span>
      <Avatar
        imageUrl={safeProfile ? item.actorAvatarUrl : null}
        label={actorName ? `${actorName}'s avatar` : "User avatar"}
        nodeId={item.actorNodeId}
        size="md"
      />
      <div className="wg-notification__copy">
        <strong>{notificationCopy(item)}</strong>
        <span>{relativeTime(item.receivedAt)}</span>
      </div>
      {!authenticatedEvent ? (
        <span className={`wg-notification__state is-${item.verification}`}>
          {item.verification === "pending" ? (
            <IoTimeOutline aria-hidden="true" />
          ) : (
            <IoWarningOutline aria-hidden="true" />
          )}
          {item.verification === "pending" ? "Loading" : "Unavailable"}
        </span>
      ) : null}
      {canHydrate ? (
        <button
          aria-label={
            evidenceCanRetry ? "Load notification" : "Load user profile"
          }
          className="nt-button nt-button--secondary nt-button--sm wg-notification__verify"
          disabled={verifying}
          onClick={(event) => {
            event.stopPropagation();
            onVerify(item);
          }}
          type="button"
        >
          <IoRefreshOutline aria-hidden="true" />
          {verifying
            ? "Loading…"
            : evidenceCanRetry
              ? item.verification === "pending"
                ? "Load"
                : "Retry"
              : item.actorProfileProof === "loading"
                ? "Load profile"
                : "Retry"}
        </button>
      ) : null}
      {!item.read ? <span className="wg-unread-dot"><span className="nt-sr-only">Unread</span></span> : null}
    </article>
  );
}

function KindIcon({ item }: { item: NotificationItem }) {
  switch (item.kind) {
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
