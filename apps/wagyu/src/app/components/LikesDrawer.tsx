import { useEffect, useMemo, useRef, useState } from "react";
import {
  IoChevronForwardOutline,
  IoCloseOutline,
  IoWarningOutline,
} from "react-icons/io5";
import type { FeedItem, LikeReceipt, LikesDetail } from "../model.ts";
import { Avatar } from "./Avatar.tsx";
import { useDialogFocus } from "./dialog_focus.ts";

const LIKE_PEOPLE_MOUNT_LIMIT = 100;
const LIKE_PEOPLE_WINDOW_STEP = 50;

export function LikesDrawer({
  detail,
  item,
  loading,
  error,
  continuing,
  continuationError,
  onClose,
  onLoadOlder,
  onOpenUser,
}: {
  item: FeedItem;
  detail: LikesDetail | null;
  loading: boolean;
  error: string | null;
  continuing: boolean;
  continuationError: string | null;
  onClose: () => void;
  onLoadOlder: () => void;
  onOpenUser: (like: LikeReceipt) => void;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);
  useDialogFocus(drawer, closeButton, onClose);
  const sealedLikes = useMemo(() => {
    return (
      detail?.packages
        .flatMap((group) =>
          group.state === "verified" ? group.receipts : [],
        )
        .filter((receipt) => receipt.state === "verified") ?? []
    );
  }, [detail]);
  const recentLikes = detail?.awaitingBatch ?? [];
  const recentLikeCount = Math.max(
    recentLikes.length,
    item.localOrigin ? item.likeSummary.awaitingBatch : 0,
  );
  const likes = useMemo(() => {
    const visible = [...sealedLikes];
    const seen = new Set(visible.map((receipt) => receipt.actorNodeId));
    for (const receipt of recentLikes) {
      if (seen.has(receipt.actorNodeId)) continue;
      seen.add(receipt.actorNodeId);
      visible.push(receipt);
    }
    return visible;
  }, [recentLikes, sealedLikes]);
  const [peopleWindowStart, setPeopleWindowStart] = useState(0);
  const maximumPeopleStart = Math.max(
    0,
    likes.length - LIKE_PEOPLE_MOUNT_LIMIT,
  );
  const boundedPeopleStart = Math.min(
    peopleWindowStart,
    maximumPeopleStart,
  );
  const visibleLikes = likes.slice(
    boundedPeopleStart,
    boundedPeopleStart + LIKE_PEOPLE_MOUNT_LIMIT,
  );
  useEffect(() => {
    setPeopleWindowStart(0);
  }, [item.id]);
  useEffect(() => {
    if (peopleWindowStart > maximumPeopleStart) {
      setPeopleWindowStart(maximumPeopleStart);
    }
  }, [maximumPeopleStart, peopleWindowStart]);
  const totalLikeCount = BigInt(sealedLikes.length + recentLikeCount);
  const missingRecentLikeCount = Math.max(
    0,
    recentLikeCount - recentLikes.length,
  );
  const incompleteEvidence =
    detail?.packages.some((group) =>
      group.state !== "verified" ||
      group.receipts.some((receipt) => receipt.state !== "verified")
    ) ?? false;

  return (
    <div
      className="wg-drawer-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <aside
        aria-label="Likes"
        aria-modal="true"
        className="wg-drawer"
        ref={drawer}
        role="dialog"
        tabIndex={-1}
      >
        <header className="wg-drawer__header">
          <div>
            <h2>Liked by</h2>
            <p>
              {detail
                ? `${totalLikeCount.toLocaleString()} verified ${
                    totalLikeCount === 1n ? "like" : "likes"
                  } shown`
                : "People who liked this post"}
            </p>
          </div>
          <button
            aria-label="Close likes"
            className="wg-icon-button"
            onClick={onClose}
            ref={closeButton}
            type="button"
          >
            <IoCloseOutline aria-hidden="true" />
          </button>
        </header>
        {detail?.truncated ? (
          <div className="nt-alert nt-alert--warning" role="status">
            <IoWarningOutline aria-hidden="true" />
            Some older likes aren't shown yet.
          </div>
        ) : null}
        {incompleteEvidence ? (
          <div className="nt-alert nt-alert--warning" role="status">
            <IoWarningOutline aria-hidden="true" />
            Some likes couldn't be verified and aren't included.
          </div>
        ) : null}
        {detail?.acceptingLikes === false ? (
          <div className="nt-alert" role="status">
            This post no longer accepts likes.
          </div>
        ) : null}
        <div aria-busy={loading} className="wg-drawer__body">
          {loading ? (
            <div
              aria-label="Loading likes"
              className="nt-state nt-state--loading"
              role="status"
            >
              <span aria-hidden="true" className="nt-spinner" />
            </div>
          ) : error ? (
            <div className="nt-state nt-state--error">
              <strong>Likes couldn't be loaded</strong>
              <span>Close this panel and try again.</span>
            </div>
          ) : detail ? (
            <>
              {missingRecentLikeCount > 0 ? (
                <p className="wg-like-list-note">
                  {missingRecentLikeCount === 1
                    ? "1 more like couldn't be loaded."
                    : `${missingRecentLikeCount.toLocaleString()} more likes couldn't be loaded.`}
                </p>
              ) : null}
              {likes.length > 0 ? (
                <>
                  {boundedPeopleStart > 0 ? (
                    <button
                      className="nt-button nt-button--secondary wg-load-more"
                      onClick={() =>
                        setPeopleWindowStart((current) =>
                          Math.max(0, current - LIKE_PEOPLE_WINDOW_STEP)
                        )}
                      type="button"
                    >
                      Show newer people
                    </button>
                  ) : null}
                  <ul
                    aria-label="People who liked this post"
                    className="wg-receipt-list"
                  >
                  {visibleLikes.map((like) => (
                    <li key={like.id}>
                      <button
                        aria-label={`Open profile for ${
                          like.actorDisplayName ?? like.actorNodeId
                        }`}
                        onClick={() => onOpenUser(like)}
                        type="button"
                      >
                        <Avatar
                          imageUrl={null}
                          label={
                            like.actorDisplayName
                              ? `${like.actorDisplayName}'s avatar`
                              : "User avatar"
                          }
                          nodeId={like.actorNodeId}
                          size="sm"
                        />
                        <span>
                          <strong>
                            {like.actorDisplayName ?? like.actorNodeId}
                          </strong>
                          {like.actorDisplayName ? (
                            <small>{like.actorNodeId}</small>
                          ) : null}
                        </span>
                        <IoChevronForwardOutline aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                  </ul>
                  {boundedPeopleStart + LIKE_PEOPLE_MOUNT_LIMIT <
                      likes.length ? (
                    <button
                      className="nt-button nt-button--secondary wg-load-more"
                      onClick={() =>
                        setPeopleWindowStart((current) =>
                          Math.min(
                            maximumPeopleStart,
                            current + LIKE_PEOPLE_WINDOW_STEP,
                          )
                        )}
                      type="button"
                    >
                      Show older people
                    </button>
                  ) : null}
                </>
              ) : recentLikeCount === 0 &&
                  !incompleteEvidence &&
                  !detail.truncated ? (
                <div className="nt-state nt-state--empty">
                  <strong>No likes yet</strong>
                  <span>Be the first to like this post.</span>
                </div>
              ) : null}
              {detail.loadOlder ? (
                <div className="wg-like-continuation">
                  {continuationError ? (
                    <div className="nt-alert nt-alert--warning" role="alert">
                      <IoWarningOutline aria-hidden="true" />
                      <span>Older likes couldn't be loaded. Try again.</span>
                    </div>
                  ) : null}
                  <button
                    className="nt-button nt-button--secondary wg-load-more"
                    disabled={continuing}
                    onClick={onLoadOlder}
                    type="button"
                  >
                    {continuing
                      ? "Loading older likes…"
                      : continuationError
                        ? "Retry"
                        : "Load older likes"}
                  </button>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
