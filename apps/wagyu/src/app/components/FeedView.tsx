import {
  Fragment,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  IoArrowRedoOutline,
  IoChatbubbleOutline,
  IoEllipsisHorizontal,
  IoHeart,
  IoHeartOutline,
  IoRefreshOutline,
  IoShieldCheckmarkOutline,
  IoTimeOutline,
  IoTrashBinOutline,
  IoWarningOutline,
} from "react-icons/io5";
import type {
  AuthoredItem,
  AuthoredPage,
  AuthoredPost,
  FeedAuthor,
  FeedItem,
  FeedPage,
  NotificationItem,
  PublishStage,
  VerificationIssueCode,
  WagyuProfile,
} from "../model.ts";
import { canonicalFeedItems } from "../feed_state.ts";
import {
  profileMayRenderRemoteText,
  relativeTime,
  safeFeedBody,
  shortenNodeId,
  verificationPresentation,
} from "../presentation.ts";
import { Avatar } from "./Avatar.tsx";
import { PostCard } from "./PostCard.tsx";
import {
  ThreadView,
  type ThreadReplyNode,
} from "./ThreadView.tsx";
import {
  displayedLikeCount,
  useActiveEngagement,
} from "../active_engagement.tsx";

const NO_BLOCKED_USERS: ReadonlySet<string> = new Set();
// Home can render one received and one authored lane; sixty rows per lane
// keeps the combined mounted timeline at roughly the launch target of 120.
const TIMELINE_MOUNT_LIMIT = 60;
const TIMELINE_WINDOW_STEP = 25;

export function FeedView({
  page,
  loadingMore,
  verifyingIds,
  likingIds,
  actionStages,
  authored,
  authoredLoadingMore,
  onVerify,
  onLike,
  onOpenLikes,
  onOpenAuthoredLikes,
  onReply,
  onResumeAction,
  onResumePost,
  onShare,
  onAdvanceWithdrawal,
  onLoadMore,
  onLoadMoreAuthored,
  onOpenUser,
  onWithdraw,
  peerDeliveryEnabled = true,
  profile,
  replies = [],
  indexedReplies = [],
  threadItem: controlledThreadItem,
  onThreadChange,
  renderThreadReplyComposer,
  showRootPostsOnly = false,
  emptyStateTitle = "Your feed is quiet",
  emptyStateBody = "Follow users to see their posts here.",
  showEndMarker = true,
  blockedNodeIds = NO_BLOCKED_USERS,
  timelineWindowStart,
  onTimelineWindowChange,
  authoredTimelineWindowStart,
  onAuthoredTimelineWindowChange,
}: {
  page: FeedPage;
  loadingMore: boolean;
  verifyingIds: ReadonlySet<string>;
  likingIds: ReadonlySet<string>;
  actionStages: ReadonlyMap<string, PublishStage>;
  /** Owner-local posts merged into Home. */
  authored?: AuthoredPage;
  /** Whether an older owner-local page is loading. */
  authoredLoadingMore?: boolean;
  onVerify: (item: FeedItem) => void;
  onLike: (item: FeedItem) => void;
  onOpenLikes: (item: FeedItem) => void;
  onReply: (item: FeedItem) => void;
  onShare: (item: FeedItem) => void;
  onWithdraw?: (item: AuthoredPost) => void;
  onResumePost?: (item: AuthoredPost) => void;
  onResumeAction?: ((item: AuthoredItem) => void) | undefined;
  onOpenAuthoredLikes?: (item: AuthoredPost) => void;
  onAdvanceWithdrawal?: (item: AuthoredPost) => void;
  onLoadMoreAuthored?: () => void;
  onOpenUser?: ((author: FeedAuthor) => void) | undefined;
  onLoadMore: () => void;
  /** @deprecated Refresh is global in the Wagyu top bar. */
  onRefresh?: () => void;
  peerDeliveryEnabled?: boolean;
  profile?: WagyuProfile;
  replies?: readonly NotificationItem[];
  /** Certified direct replies loaded from the selected post author's index. */
  indexedReplies?: readonly FeedItem[];
  threadItem?: FeedItem | null;
  onThreadChange?: ((item: FeedItem | null) => void) | undefined;
  renderThreadReplyComposer?: ((parent: FeedItem) => ReactNode) | undefined;
  /** Keep replies in the conversation index without rendering them in the list. */
  showRootPostsOnly?: boolean;
  emptyStateTitle?: string;
  emptyStateBody?: string;
  showEndMarker?: boolean;
  /** Already-loaded local Block rows; no peer lookup is performed. */
  blockedNodeIds?: ReadonlySet<string>;
  timelineWindowStart?: number;
  onTimelineWindowChange?: (start: number) => void;
  authoredTimelineWindowStart?: number;
  onAuthoredTimelineWindowChange?: (start: number) => void;
}) {
  const items = canonicalFeedItems(page.items).filter(
    (item) =>
      item.verification !== "invalid" &&
      feedItemAllowedByBlock(item, blockedNodeIds),
  );
  const authoredPosts =
    authored?.items.filter(
      (item): item is AuthoredPost => item.kind === "post",
    ) ?? [];
  const ownerPostMenu = (item: FeedItem) => {
    if (!item.localOrigin || !onWithdraw) return undefined;
    const authoredPost = authoredPosts.find(
      (candidate) =>
        candidate.postId === item.postId &&
        candidate.state === "live",
    );
    if (!authoredPost) return undefined;
    return (
      <PostOptionsMenu
        disabled={actionStages.has(`withdraw:${authoredPost.postId}`)}
        onDelete={() => onWithdraw(authoredPost)}
      />
    );
  };
  const conversation = buildConversationIndex(
    items,
    authoredPosts,
    replies,
    profile,
    indexedReplies,
    blockedNodeIds,
  );
  const [internalThreadItem, setInternalThreadItem] =
    useState<FeedItem | null>(null);
  const threadItem =
    controlledThreadItem === undefined
      ? internalThreadItem
      : controlledThreadItem;
  const changeThread = onThreadChange ?? setInternalThreadItem;
  const selectedThreadItem = threadItem &&
      feedItemAllowedByBlock(threadItem, blockedNodeIds)
    ? conversation.byPost.get(feedItemKey(threadItem)) ?? threadItem
    : null;
  const threadAncestors = selectedThreadItem
    ? conversationAncestors(
        selectedThreadItem,
        conversation,
        blockedNodeIds,
      )
    : [];
  const threadReplies = selectedThreadItem
    ? conversationDirectReplies(selectedThreadItem, conversation)
    : [];
  const timelineItems = showRootPostsOnly
    ? items.filter((item) => !item.replyTo || item.sharedBy !== null)
    : items;
  const timelineWindow = useMountedTimelineWindow(
    timelineItems.length,
    timelineWindowStart,
    onTimelineWindowChange,
  );
  const mountedTimelineItems = timelineItems.slice(
    timelineWindow.start,
    timelineWindow.end,
  );
  if (
    selectedThreadItem &&
    selectedThreadItem.verification === "verified" &&
    selectedThreadItem.promotion === "committed" &&
    selectedThreadItem.kind !== "tombstone"
  ) {
    return (
      <ThreadView
        ancestors={threadAncestors}
        item={selectedThreadItem}
        replies={threadReplies}
        onBack={() => changeThread(null)}
        replyComposer={renderThreadReplyComposer?.(selectedThreadItem)}
        renderPost={(post, nestedUnderParent) => (
          <VerifiedFeedCard
            item={post}
            liking={likingIds.has(post.id)}
            menu={ownerPostMenu(post)}
            onLike={onLike}
            onOpenLikes={onOpenLikes}
            onOpenAuthor={onOpenUser}
            onReply={onReply}
            onRetryPromotion={onVerify}
            onShare={onShare}
            onThread={changeThread}
            peerDeliveryEnabled={peerDeliveryEnabled}
            promoting={verifyingIds.has(post.id)}
            replyCount={conversationReplyCount(post, conversation)}
            showReplyContext={!nestedUnderParent}
            sharingStage={
              actionStages.get(`share:${post.id}`) ?? null
            }
          />
        )}
      />
    );
  }
  const hasAuthoredPosts =
    !!authored &&
    !!onWithdraw &&
    !!onResumePost &&
    !!onAdvanceWithdrawal &&
    authored.items.some((item) => item.kind === "post" && !item.replyTo);
  return (
    <div className="wg-feed">
      {authored && onWithdraw && onResumePost && onAdvanceWithdrawal ? (
        <AuthoredPostsPanel
          actionStages={actionStages}
          contentFilter="posts"
          likingIds={likingIds}
          onLike={onLike}
          onAdvanceWithdrawal={onAdvanceWithdrawal}
          onOpenFeedLikes={onOpenLikes}
          onOpenUser={onOpenUser}
          onOpenThread={(item) => changeThread(item)}
          onReply={onReply}
          onResumePost={onResumePost}
          onShare={onShare}
          onWithdraw={onWithdraw}
          page={authored}
          peerDeliveryEnabled={peerDeliveryEnabled}
          replies={replies}
          threadParents={items}
          {...(authoredLoadingMore === undefined
            ? {}
            : { loadingMore: authoredLoadingMore })}
          {...(onLoadMoreAuthored ? { onLoadMore: onLoadMoreAuthored } : {})}
          {...(onOpenAuthoredLikes
            ? { onOpenLikes: onOpenAuthoredLikes }
            : {})}
          {...(onResumeAction ? { onResumeAction } : {})}
          {...(profile ? { profile } : {})}
          {...(authoredTimelineWindowStart === undefined
            ? {}
            : { timelineWindowStart: authoredTimelineWindowStart })}
          {...(onAuthoredTimelineWindowChange
            ? { onTimelineWindowChange: onAuthoredTimelineWindowChange }
            : {})}
          blockedNodeIds={blockedNodeIds}
        />
      ) : null}
      {timelineWindow.hasNewer ? (
        <button
          className="nt-button nt-button--secondary wg-load-more"
          onClick={timelineWindow.showNewer}
          type="button"
        >
          Show newer posts
        </button>
      ) : null}
      <div aria-live="polite" className="wg-feed__list">
        {mountedTimelineItems.map((item) => (
          <div className="wg-timeline-thread" key={item.id}>
            {item.verification === "verified" ? (
              <VerifiedFeedCard
                item={item}
                liking={likingIds.has(item.id)}
                onLike={onLike}
                onOpenLikes={onOpenLikes}
                onOpenAuthor={onOpenUser}
                onReply={onReply}
                onRetryPromotion={onVerify}
                onShare={onShare}
                onThread={(post) => changeThread(post)}
                peerDeliveryEnabled={peerDeliveryEnabled}
                promoting={verifyingIds.has(item.id)}
                replyCount={conversationReplyCount(item, conversation)}
                sharingStage={actionStages.get(`share:${item.id}`) ?? null}
              />
            ) : (
              <CandidateCard
                item={item}
                onVerify={onVerify}
                verifying={verifyingIds.has(item.id)}
              />
            )}
          </div>
        ))}
        {timelineItems.length === 0 && !hasAuthoredPosts ? (
          <div className="nt-state nt-state--empty wg-empty-state">
            <span className="wg-empty-state__icon"><IoShieldCheckmarkOutline aria-hidden="true" /></span>
            <strong>{emptyStateTitle}</strong>
            <span>{emptyStateBody}</span>
          </div>
        ) : null}
      </div>

      {timelineWindow.hasLoadedOlder || page.nextCursor ? (
        <button
          className="nt-button nt-button--secondary wg-load-more"
          disabled={loadingMore && !timelineWindow.hasLoadedOlder}
          onClick={() => {
            if (timelineWindow.hasLoadedOlder) {
              timelineWindow.showOlder();
            } else {
              timelineWindow.expectOlderPage();
              onLoadMore();
            }
          }}
          type="button"
        >
          {loadingMore && !timelineWindow.hasLoadedOlder
            ? "Loading…"
            : "Show older posts"}
        </button>
      ) : showEndMarker ? (
        <p className="wg-end-marker"><span /> You're all caught up <span /></p>
      ) : null}
    </div>
  );
}

function VerifiedFeedCard({
  accessibleLabel,
  item,
  liking,
  menu,
  notice,
  onLike,
  onOpenLikes,
  onOpenAuthor,
  onReply,
  onRetryPromotion,
  onShare,
  onThread,
  peerDeliveryEnabled,
  promoting,
  replyCount = null,
  showReplyContext = true,
  sharingStage,
}: {
  accessibleLabel?: string;
  item: FeedItem;
  liking: boolean;
  menu?: ReactNode;
  notice?: ReactNode;
  onLike?: ((item: FeedItem) => void) | undefined;
  onOpenLikes?: ((item: FeedItem) => void) | undefined;
  onOpenAuthor?: ((author: FeedAuthor) => void) | undefined;
  onReply?: ((item: FeedItem) => void) | undefined;
  onRetryPromotion?: ((item: FeedItem) => void) | undefined;
  onShare?: ((item: FeedItem) => void) | undefined;
  onThread?: ((item: FeedItem) => void) | undefined;
  peerDeliveryEnabled: boolean;
  promoting: boolean;
  replyCount?: number | null;
  showReplyContext?: boolean;
  sharingStage: PublishStage | null;
}) {
  const {
    engagement,
    optimisticLikeFloor,
    onVisibilityChange,
  } = useActiveEngagement(item);
  const likeCount = displayedLikeCount(
    item,
    engagement?.likeCount ?? null,
    optimisticLikeFloor,
  );
  const displayedItem = {
    ...item,
    likedByOwner: item.likedByOwner || optimisticLikeFloor !== null,
    likeSummary: {
      ...item.likeSummary,
      verified: likeCount,
    },
    ...(engagement
      ? { verifiedReplyCount: engagement.replyCount }
      : {}),
  };
  item = displayedItem;
  replyCount = engagement?.replyCount ?? replyCount;
  const body = safeFeedBody(item);
  const promotionFailed = item.promotion !== "committed";
  const interactionReady =
    Boolean(item.postId) &&
    Boolean(item.bodyDigest) &&
    Boolean(item.objectDigest) &&
    Boolean(item.bodyLength);
  const interactionUnavailableReason =
    "This post's interaction proof isn't available in the current view.";
  const peerDeliveryReason =
    "Enable peer delivery before interacting with other users.";
  const name =
    profileMayRenderRemoteText(item.author.profileProof) && item.author.displayName
      ? item.author.displayName
      : null;
  const authorLabel = name ?? shortenNodeId(item.author.nodeId);
  const postLabel = shortDigest(item.postId);
  const verifiedLikeLabel =
    item.likeSummary.verified === 1
      ? "1 like"
      : `${item.likeSummary.verified.toLocaleString()} likes`;
  const replyCountLabel = replyCount === null
    ? null
    : replyCount === 1
      ? "1 reply"
      : `${replyCount.toLocaleString()} replies`;
  if (item.kind === "tombstone") {
    return (
      <article
        aria-label="Deleted post"
        className="wg-feed-card wg-feed-card--withdrawn"
        data-promotion={item.promotion}
      >
        <IoTrashBinOutline aria-hidden="true" />
        <div>
          <strong>
            {promotionFailed
              ? "This deletion still needs attention"
              : "This post was deleted"}
          </strong>
          <p>
            {promotionFailed
              ? "Wagyu could not finish updating this feed item."
              : "The original post is no longer available."}
          </p>
          {promotionFailed ? (
            <button
              aria-label="Retry deleted post update"
              className="nt-button nt-button--secondary nt-button--sm"
              disabled={promoting || !onRetryPromotion}
              onClick={() => onRetryPromotion?.(item)}
              type="button"
            >
              <IoRefreshOutline aria-hidden="true" />
              {promoting ? "Retrying…" : "Retry"}
            </button>
          ) : null}
        </div>
      </article>
    );
  }
  return (
    <PostCard
      accessibleLabel={accessibleLabel ?? `Post by ${authorLabel}`}
      author={{
        avatarUrl: profileMayRenderRemoteText(item.author.profileProof)
          ? item.author.avatarUrl
          : null,
        displayName: name,
        nodeId: item.author.nodeId,
      }}
      body={promotionFailed ? null : body}
      emptyBody={
        promotionFailed
          ? "This post is still being added to your feed."
          : "This post has no text."
      }
      notice={promotionFailed
        ? (
          <div className="wg-feed-promotion-warning" role="status">
            <IoWarningOutline aria-hidden="true" />
            <span>
              <strong>This post needs attention.</strong>
              Wagyu could not finish adding it to your feed.
            </span>
            <button
              aria-label={`Retry adding post ${postLabel} to the feed`}
              className="nt-button nt-button--secondary nt-button--sm"
              disabled={promoting || !onRetryPromotion}
              onClick={() => onRetryPromotion?.(item)}
              type="button"
            >
              <IoRefreshOutline aria-hidden="true" />
              {promoting ? "Retrying…" : "Retry"}
            </button>
          </div>
        )
        : notice}
      menu={menu}
      onOpenAuthor={
        onOpenAuthor ? () => onOpenAuthor(item.author) : undefined
      }
      onOpen={onThread ? () => onThread(item) : undefined}
      onVisibilityChange={onVisibilityChange}
      replyTo={!promotionFailed && item.replyTo
        ? {
            label:
              item.replyTo.author &&
                profileMayRenderRemoteText(
                  item.replyTo.author.profileProof,
                ) &&
                item.replyTo.author.displayName
                ? item.replyTo.author.displayName
                : shortenNodeId(item.replyTo.authorNodeId),
          }
        : null}
      sharedBy={item.sharedBy
        ? profileMayRenderRemoteText(item.sharedBy.profileProof) &&
            item.sharedBy.displayName
          ? item.sharedBy.displayName
          : shortenNodeId(item.sharedBy.nodeId)
        : null}
      showReplyContext={showReplyContext}
      timestamp={relativeTime(item.createdAt ?? item.receivedAt)}
      actions={
        <>
          <div className="wg-post-action">
            <button
              aria-label={
                item.likedByOwner
                  ? `You liked post ${postLabel} by ${authorLabel}`
                  : `Like post ${postLabel} by ${authorLabel}`
              }
              className={item.likedByOwner ? "is-active" : ""}
              disabled={
                !peerDeliveryEnabled ||
                promotionFailed ||
                !interactionReady ||
                item.localOrigin ||
                !onLike ||
                item.likedByOwner ||
                liking
              }
              onClick={() => onLike?.(item)}
              title={
                liking
                  ? "Liking…"
                  : !peerDeliveryEnabled
                    ? peerDeliveryReason
                    : item.localOrigin
                      ? "You cannot like your own post."
                      : !onLike
                        ? "Like is unavailable in the current view."
                        : !interactionReady
                          ? interactionUnavailableReason
                          : "Like"
              }
              type="button"
            >
              {item.likedByOwner
                ? <IoHeart aria-hidden="true" />
                : <IoHeartOutline aria-hidden="true" />}
            </button>
            <button
              aria-label={`View ${verifiedLikeLabel} for post ${postLabel} by ${authorLabel}`}
              className="wg-post-action__count"
              disabled={promotionFailed || !interactionReady || !onOpenLikes}
              onClick={() => onOpenLikes?.(item)}
              title="View likes"
              type="button"
            >
              {item.likeSummary.verified.toLocaleString()}
            </button>
          </div>
          <div className="wg-post-action">
            <button
              aria-label={`Reply to post ${postLabel} by ${authorLabel}`}
              disabled={
                !peerDeliveryEnabled ||
                promotionFailed ||
                !interactionReady ||
                !onReply
              }
              onClick={() => onReply?.(item)}
              title={
                !peerDeliveryEnabled
                  ? peerDeliveryReason
                  : !onReply
                    ? "Reply is unavailable in the current view."
                    : !interactionReady
                      ? interactionUnavailableReason
                      : "Reply"
              }
              type="button"
            >
              <IoChatbubbleOutline aria-hidden="true" />
            </button>
            {replyCount !== null && replyCountLabel ? (
              <button
                aria-label={`Reply to post ${postLabel} by ${authorLabel}; ${replyCountLabel}`}
                className="wg-post-action__count"
                disabled={
                  !peerDeliveryEnabled ||
                  promotionFailed ||
                  !interactionReady ||
                  !onReply
                }
                onClick={() => onReply?.(item)}
                title={
                  !peerDeliveryEnabled
                    ? peerDeliveryReason
                    : !onReply
                      ? "Reply is unavailable in the current view."
                      : !interactionReady
                        ? interactionUnavailableReason
                        : "Reply"
                }
                type="button"
              >
                {replyCount.toLocaleString()}
              </button>
            ) : null}
          </div>
          <div className="wg-post-action">
            <button
              aria-label={`Share post ${postLabel} by ${authorLabel}`}
              disabled={
                !peerDeliveryEnabled ||
                promotionFailed ||
                !item.originalPostRefBytes ||
                !onShare ||
                sharingStage !== null
              }
              onClick={() => onShare?.(item)}
              title={
                sharingStage
                  ? actionStageLabel(sharingStage)
                  : !peerDeliveryEnabled
                    ? peerDeliveryReason
                    : !onShare
                      ? "Share is unavailable in the current view."
                      : item.originalPostRefBytes
                        ? "Share"
                        : "This post cannot be shared right now"
              }
              type="button"
            >
              <IoArrowRedoOutline aria-hidden="true" />
            </button>
          </div>
        </>
      }
    />
  );
}

function PostOptionsMenu({
  disabled = false,
  onDelete,
}: {
  disabled?: boolean;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const deleteButton = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    deleteButton.current?.focus();
    const closeFromOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !root.current?.contains(event.target)
      ) setOpen(false);
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromKeyboard);
    };
  }, [open]);

  return (
    <div
      className="wg-post-menu"
      onBlur={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        ) setOpen(false);
      }}
      ref={root}
    >
      <button
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Post options"
        className="wg-post-menu__trigger"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        ref={trigger}
        title="Post options"
        type="button"
      >
        <IoEllipsisHorizontal aria-hidden="true" />
      </button>
      <div
        aria-label="Post options"
        className="wg-post-menu__popover"
        hidden={!open}
        id={menuId}
        role="menu"
      >
        <button
          aria-label="Delete post"
          className="wg-post-menu__item"
          onClick={() => {
            setOpen(false);
            onDelete();
          }}
          ref={deleteButton}
          role="menuitem"
          type="button"
        >
          <IoTrashBinOutline aria-hidden="true" />
          <span>Delete post</span>
        </button>
      </div>
    </div>
  );
}

function resolveThreadParent(
  reply: FeedItem,
  items: readonly FeedItem[],
  blockedNodeIds: ReadonlySet<string> = NO_BLOCKED_USERS,
): FeedItem | null {
  const reference = reply.replyTo;
  if (!reference) {
    return reply.verification === "verified" &&
        reply.promotion === "committed" &&
        reply.kind !== "tombstone"
      ? reply
      : null;
  }
  if (blockedNodeIds.has(reference.authorNodeId)) return null;
  const loaded = items.find(
    (item) =>
      item.verification === "verified" &&
      item.promotion === "committed" &&
      item.author.nodeId === reference.authorNodeId &&
      item.postId === reference.postId,
  );
  if (loaded) return loaded;
  if (!reference.verified) return null;
  const author = reference.author ?? {
    nodeId: reference.authorNodeId,
    displayName: null,
    avatarUrl: null,
    profileProof: "loading" as const,
  };
  return {
    id: `thread-parent:${reference.authorNodeId}:${reference.postId ?? "unknown"}`,
    localSequence: reply.localSequence,
    receivedAt: reply.receivedAt,
    immediateSender: reference.authorNodeId,
    kind: "original",
    verification: "verified",
    promotion: "committed",
    author,
    postId: reference.postId ?? "",
    body: reference.body,
    bodyDigest: null,
    objectDigest: null,
    bodyLength: reference.body
      ? new TextEncoder().encode(reference.body).byteLength
      : null,
    createdAt: null,
    sharedBy: null,
    replyTo: null,
    likedByOwner: false,
    likeSummary: {
      verified: 0,
      invalid: 0,
      unavailable: 0,
      awaitingBatch: 0,
    },
    localOrigin: false,
    opaqueEventBytes: null,
    originalPostRefBytes: null,
  };
}

export function AuthoredPostsPanel({
  page,
  actionStages,
  contentFilter = "all",
  likingIds,
  loadingMore = false,
  nestAuthoredReplies = false,
  onLike,
  onWithdraw,
  onResumePost,
  onResumeAction,
  onOpenFeedLikes,
  onOpenLikes,
  onOpenUser,
  onOpenThread,
  onReply,
  onShare,
  onAdvanceWithdrawal,
  onLoadMore,
  peerDeliveryEnabled = true,
  profile,
  replies = [],
  showEmptyState = false,
  threadParents = [],
  blockedNodeIds = NO_BLOCKED_USERS,
  timelineWindowStart,
  onTimelineWindowChange,
}: {
  page: AuthoredPage;
  actionStages: ReadonlyMap<string, PublishStage>;
  contentFilter?: "all" | "posts" | "replies";
  likingIds?: ReadonlySet<string>;
  loadingMore?: boolean;
  nestAuthoredReplies?: boolean;
  onLike?: ((item: FeedItem) => void) | undefined;
  onWithdraw: (item: AuthoredPost) => void;
  onResumePost: (item: AuthoredPost) => void;
  onResumeAction?: ((item: AuthoredItem) => void) | undefined;
  onOpenFeedLikes?: ((item: FeedItem) => void) | undefined;
  onOpenLikes?: ((item: AuthoredPost) => void) | undefined;
  onOpenUser?: ((author: FeedAuthor) => void) | undefined;
  onOpenThread?: ((item: FeedItem) => void) | undefined;
  onReply?: ((item: FeedItem) => void) | undefined;
  onShare?: ((item: FeedItem) => void) | undefined;
  onAdvanceWithdrawal: (item: AuthoredPost) => void;
  onLoadMore?: (() => void) | undefined;
  peerDeliveryEnabled?: boolean;
  profile?: WagyuProfile;
  replies?: readonly NotificationItem[];
  showEmptyState?: boolean;
  threadParents?: readonly FeedItem[];
  blockedNodeIds?: ReadonlySet<string>;
  timelineWindowStart?: number;
  onTimelineWindowChange?: (start: number) => void;
}) {
  const [localThreadItem, setLocalThreadItem] =
    useState<FeedItem | null>(null);

  const allPosts = page.items.filter(
    (item): item is AuthoredPost =>
      item.kind === "post" && item.state !== "withdrawn",
  );
  const conversation = buildConversationIndex(
    threadParents,
    allPosts,
    replies,
    profile,
    [],
    blockedNodeIds,
  );
  const availableThreadParents = conversation.items;
  const selectedThreadItem = localThreadItem
    ? conversation.byPost.get(feedItemKey(localThreadItem)) ?? localThreadItem
    : null;
  const localThreadAncestors = selectedThreadItem
    ? conversationAncestors(
        selectedThreadItem,
        conversation,
        blockedNodeIds,
      )
    : [];
  const localThreadReplies = selectedThreadItem
    ? conversationDirectReplies(selectedThreadItem, conversation)
    : [];
  const openThread = onOpenThread ?? setLocalThreadItem;
  const posts = allPosts.filter((post) =>
    contentFilter === "all" ||
    (contentFilter === "posts" ? !post.replyTo : Boolean(post.replyTo))
  );
  const timelineWindow = useMountedTimelineWindow(
    posts.length,
    timelineWindowStart,
    onTimelineWindowChange,
  );
  const mountedPosts = posts.slice(timelineWindow.start, timelineWindow.end);
  const recoveryActions = contentFilter === "replies"
    ? []
    : page.items.filter(
      (item) => item.kind !== "post" && authoredActionNeedsAttention(item),
    );
  const repliesByPost = verifiedRepliesByTarget(replies);
  const authoredRepliesByPost = authoredRepliesByTarget(allPosts);
  if (!onOpenThread && selectedThreadItem) {
    return (
      <ThreadView
        ancestors={localThreadAncestors}
        item={selectedThreadItem}
        onBack={() => setLocalThreadItem(null)}
        replies={localThreadReplies}
        renderPost={(post, nestedUnderParent) => (
          <VerifiedFeedCard
            item={post}
            liking={likingIds?.has(post.id) ?? false}
            menu={post.localOrigin
              ? (() => {
                  const authoredPost = allPosts.find(
                    (candidate) =>
                      candidate.postId === post.postId &&
                      candidate.state === "live",
                  );
                  return authoredPost
                    ? (
                        <PostOptionsMenu
                          disabled={actionStages.has(
                            `withdraw:${authoredPost.postId}`,
                          )}
                          onDelete={() => onWithdraw(authoredPost)}
                        />
                      )
                    : undefined;
                })()
              : undefined}
            onLike={onLike}
            onOpenLikes={onOpenFeedLikes}
            onOpenAuthor={onOpenUser}
            onReply={onReply}
            onShare={onShare}
            onThread={setLocalThreadItem}
            peerDeliveryEnabled={peerDeliveryEnabled}
            promoting={false}
            replyCount={conversationReplyCount(post, conversation)}
            showReplyContext={!nestedUnderParent}
            sharingStage={
              actionStages.get(`share:${post.id}`) ?? null
            }
          />
        )}
      />
    );
  }
  if (
    posts.length === 0 &&
    recoveryActions.length === 0 &&
    !page.nextCursor
  ) {
    return showEmptyState ? (
      <div className="nt-state nt-state--empty wg-empty-state">
        <strong>
          {contentFilter === "replies" ? "No replies yet" : "No posts yet"}
        </strong>
        <span>
          {contentFilter === "replies"
            ? "Replies you send will appear here."
            : "Posts you send will appear here."}
        </span>
      </div>
    ) : null;
  }
  return (
    <section
      aria-label={
        contentFilter === "replies" ? "Your replies" : "Your posts"
      }
    >
      {timelineWindow.hasNewer ? (
        <button
          className="nt-button nt-button--secondary nt-button--sm wg-load-more"
          onClick={timelineWindow.showNewer}
          type="button"
        >
          Show newer posts
        </button>
      ) : null}
      <div aria-live="polite" className="wg-feed__list">
        {mountedPosts.map((post) => {
          const resumeStage =
            actionStages.get(
              `resume:${post.kind}:${post.actionId}`,
            ) ??
            actionStages.get(`resume:${post.postId}`) ??
            null;
          const stage =
            actionStages.get(`withdraw:${post.postId}`) ??
            resumeStage;
          const closing =
            post.state === "withdrawal-closing" ||
            stage === "withdrawal-closing";
          const resume = () => {
            if (onResumeAction) onResumeAction(post);
            else onResumePost(post);
          };
          const postReplies = nestAuthoredReplies
            ? repliesByPost.get(post.postId) ?? []
            : [];
          const nestedAuthoredReplies =
            nestAuthoredReplies && profile
              ? authoredRepliesByPost.get(
                authoredReplyTargetKey(profile.nodeId, post.postId),
              ) ?? []
              : [];
          const postItem = authoredPostFeedItem(
            post,
            profile,
            availableThreadParents,
          );
          const liveOwnerMenu = (
            <PostOptionsMenu
              disabled={stage !== null}
              onDelete={() => onWithdraw(post)}
            />
          );
          return (
            <div
              className={[
                "wg-timeline-thread",
                postReplies.length > 0 || nestedAuthoredReplies.length > 0
                  ? "wg-home-thread"
                  : "",
              ].filter(Boolean).join(" ")}
              key={post.postId}
            >
              {post.state === "live" && postItem ? (
                <VerifiedFeedCard
                  accessibleLabel={post.replyTo ? "Your reply" : "Your post"}
                  item={postItem}
                  liking={likingIds?.has(postItem.id) ?? false}
                  menu={liveOwnerMenu}
                  onLike={onLike}
                  onOpenLikes={onOpenLikes
                    ? () => onOpenLikes(post)
                    : undefined}
                  onOpenAuthor={onOpenUser}
                  onReply={onReply}
                  onShare={onShare}
                  onThread={openThread}
                  peerDeliveryEnabled={peerDeliveryEnabled}
                  promoting={false}
                  replyCount={conversationReplyCount(
                    postItem,
                    conversation,
                  )}
                  sharingStage={
                    actionStages.get(`share:${postItem.id}`) ?? null
                  }
                />
              ) : (
                <PostCard
                  accessibleLabel={post.replyTo ? "Your reply" : "Your post"}
                  actions={
                    <>
                      {post.localLikeView && onOpenLikes ? (
                        <button
                          aria-label="View likes on your post"
                          onClick={() => onOpenLikes(post)}
                          type="button"
                        >
                          <IoHeartOutline aria-hidden="true" />
                          {post.localLikeView.unsealedReceiptCount > 0
                            ? post.localLikeView.unsealedReceiptCount === 1
                              ? "1 recent like"
                              : `${post.localLikeView.unsealedReceiptCount.toLocaleString()} recent likes`
                            : "Likes"}
                        </button>
                      ) : null}
                      {post.state === "awaiting-proof" ? (
                        <button
                          aria-label="Finish sending your post"
                          className="nt-button nt-button--secondary nt-button--sm"
                          disabled={
                            !peerDeliveryEnabled ||
                            !post.objectDigest ||
                            resumeStage !== null ||
                            !onResumeAction && !onResumePost
                          }
                          onClick={resume}
                          title={
                            !peerDeliveryEnabled
                              ? "Enable peer delivery before finishing this post"
                              : !post.objectDigest
                                ? "This post is not ready to resume"
                                : undefined
                          }
                          type="button"
                        >
                          <IoRefreshOutline aria-hidden="true" />
                          {resumeStage
                            ? actionStageLabel(resumeStage)
                            : "Finish sending"}
                        </button>
                      ) : null}
                      {post.state === "withdrawal-awaiting-proof" ? (
                        <button
                          aria-label="Finish deleting your post"
                          className="nt-button nt-button--secondary nt-button--sm"
                          disabled={stage !== null}
                          onClick={() => onWithdraw(post)}
                          type="button"
                        >
                          <IoRefreshOutline aria-hidden="true" />
                          {stage
                            ? actionStageLabel(stage)
                            : "Finish deletion"}
                        </button>
                      ) : null}
                      {post.state === "withdrawal-closing" ? (
                        <button
                          aria-label="Continue deleting your post"
                          className="nt-button nt-button--secondary nt-button--sm"
                          disabled={stage !== null}
                          onClick={() => onAdvanceWithdrawal(post)}
                          type="button"
                        >
                          <IoRefreshOutline aria-hidden="true" />
                          {stage
                            ? actionStageLabel(stage)
                            : "Continue deletion"}
                        </button>
                      ) : null}
                      {post.state === "withdrawn" ? (
                        <span className="wg-proof-pill">Deleted</span>
                      ) : null}
                    </>
                  }
                  author={{
                    avatarUrl: profile?.avatarUrl ?? null,
                    displayName: profile?.displayName || "You",
                    nodeId: profile?.nodeId ?? null,
                  }}
                  body={post.bodyMarkdown ?? null}
                  emptyBody="Post text is unavailable."
                  notice={closing ? (
                    <div className="wg-authored__closing" role="status">
                      <IoTimeOutline aria-hidden="true" />
                      <span>
                        <strong>Deletion is still finishing</strong>
                        You can safely continue it below.
                      </span>
                    </div>
                  ) : null}
                  replyTo={post.replyTo
                    ? {
                        label: shortenNodeId(post.replyTo.authorNodeId),
                      }
                    : null}
                  timestamp={
                    post.createdAt ? relativeTime(post.createdAt) : null
                  }
                  withdrawn={post.state === "withdrawn"}
                />
              )}
              {nestedAuthoredReplies.map((reply) => {
                const replyItem = authoredPostFeedItem(
                  reply,
                  profile,
                  postItem
                    ? [postItem, ...availableThreadParents]
                    : availableThreadParents,
                );
                const receivedReplies =
                  repliesByPost.get(reply.postId) ?? [];
                return replyItem ? (
                  <Fragment key={reply.postId}>
                    <VerifiedFeedCard
                      accessibleLabel="Your reply"
                      item={replyItem}
                      liking={likingIds?.has(replyItem.id) ?? false}
                      menu={
                        <PostOptionsMenu
                          disabled={actionStages.has(
                            `withdraw:${reply.postId}`,
                          )}
                          onDelete={() => onWithdraw(reply)}
                        />
                      }
                      onLike={onLike}
                      onOpenLikes={onOpenLikes
                        ? () => onOpenLikes(reply)
                        : undefined}
                      onOpenAuthor={onOpenUser}
                      onReply={onReply}
                      onShare={onShare}
                      onThread={openThread}
                      peerDeliveryEnabled={peerDeliveryEnabled}
                      promoting={false}
                      replyCount={conversationReplyCount(
                        replyItem,
                        conversation,
                      )}
                      showReplyContext={false}
                      sharingStage={
                        actionStages.get(`share:${replyItem.id}`) ?? null
                      }
                    />
                    {receivedReplies.map((receivedReply) => (
                      <NotificationReplyCard
                        item={receivedReply}
                        key={receivedReply.id}
                        liking={likingIds?.has(
                          `notification-reply:${receivedReply.id}`,
                        ) ?? false}
                        onLike={onLike}
                        onOpenLikes={onOpenFeedLikes}
                        onOpenUser={onOpenUser}
                        onOpenThread={openThread}
                        onReply={onReply}
                        onShare={onShare}
                        parent={replyItem}
                        peerDeliveryEnabled={peerDeliveryEnabled}
                        replyCount={notificationReplyCount(
                          receivedReply,
                          conversation,
                        )}
                        sharingStage={
                          actionStages.get(
                            `share:notification-reply:${receivedReply.id}`,
                          ) ?? null
                        }
                      />
                    ))}
                  </Fragment>
                ) : null;
              })}
              {postReplies.map((reply) => (
                <NotificationReplyCard
                  item={reply}
                  key={reply.id}
                  liking={likingIds?.has(
                    `notification-reply:${reply.id}`,
                  ) ?? false}
                  onLike={onLike}
                  onOpenLikes={onOpenFeedLikes}
                  onOpenUser={onOpenUser}
                  onOpenThread={openThread}
                  onReply={onReply}
                  onShare={onShare}
                  parent={postItem}
                  peerDeliveryEnabled={peerDeliveryEnabled}
                  replyCount={notificationReplyCount(reply, conversation)}
                  sharingStage={
                    actionStages.get(
                      `share:notification-reply:${reply.id}`,
                    ) ?? null
                  }
                />
              ))}
            </div>
          );
        })}
      </div>
      {recoveryActions.length > 0 ? (
        <section
          aria-labelledby="wg-authored-recovery-title"
          className="wg-authored"
        >
          <header>
            <h2 id="wg-authored-recovery-title">Needs attention</h2>
          </header>
          <div className="wg-authored__list">
            {recoveryActions.map((item) => {
              const resumeStage =
                actionStages.get(`resume:${item.kind}:${item.actionId}`) ??
                null;
              const resumeNeedsPeerDelivery = item.kind !== "tombstone";
              return (
                <article
                  aria-label={`${authoredKindLabel(item.kind)}: ${authoredStateLabel(item)}`}
                  data-kind={item.kind}
                  data-state={item.state}
                  key={`${item.kind}:${item.actionId}`}
                >
                  <div className="wg-authored__identity">
                    <IoTimeOutline aria-hidden="true" />
                    <span>
                      <strong>{authoredKindLabel(item.kind)}</strong>
                      <small>
                        {item.createdAt
                          ? `${relativeTime(item.createdAt)} · `
                          : ""}
                        {authoredStateLabel(item)}
                      </small>
                    </span>
                  </div>
                  <div className="wg-authored__actions">
                    {item.state === "awaiting-proof" && onResumeAction ? (
                      <button
                        aria-label={`${authoredResumeLabel(item.kind)} action`}
                        className="nt-button nt-button--secondary nt-button--sm"
                        disabled={
                          (!peerDeliveryEnabled && resumeNeedsPeerDelivery) ||
                          !item.objectDigest ||
                          resumeStage !== null
                        }
                        onClick={() => onResumeAction(item)}
                        title={
                          !peerDeliveryEnabled && resumeNeedsPeerDelivery
                            ? "Enable peer delivery before finishing this action"
                            : !item.objectDigest
                              ? "This action is not ready to resume"
                              : undefined
                        }
                        type="button"
                      >
                        <IoRefreshOutline aria-hidden="true" />
                        {resumeStage
                          ? actionStageLabel(resumeStage)
                          : authoredResumeLabel(item.kind)}
                      </button>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}
      {timelineWindow.hasLoadedOlder || page.nextCursor ? (
        <footer className="wg-authored__pagination">
          <button
            aria-label="Load older posts"
            className="nt-button nt-button--secondary nt-button--sm"
            disabled={
              !timelineWindow.hasLoadedOlder && (loadingMore || !onLoadMore)
            }
            onClick={() => {
              if (timelineWindow.hasLoadedOlder) {
                timelineWindow.showOlder();
              } else if (onLoadMore) {
                timelineWindow.expectOlderPage();
                onLoadMore();
              }
            }}
            title={
              timelineWindow.hasLoadedOlder || onLoadMore
                ? "Show older posts"
                : "Older posts are not available yet"
            }
            type="button"
          >
            <IoRefreshOutline aria-hidden="true" />
            {loadingMore && !timelineWindow.hasLoadedOlder
              ? "Loading older posts…"
              : timelineWindow.hasLoadedOlder || onLoadMore
                ? "Show older posts"
                : "Older posts available"}
          </button>
        </footer>
      ) : null}
    </section>
  );
}

function useMountedTimelineWindow(
  itemCount: number,
  controlledStart?: number,
  onChange?: (start: number) => void,
): {
  start: number;
  end: number;
  hasNewer: boolean;
  hasLoadedOlder: boolean;
  showNewer: () => void;
  showOlder: () => void;
  expectOlderPage: () => void;
} {
  const [internalStart, setInternalStart] = useState(0);
  const pendingOlderCount = useRef<number | null>(null);
  const requestedStart = controlledStart ?? internalStart;
  const maximumStart = Math.max(0, itemCount - TIMELINE_MOUNT_LIMIT);
  const start = Math.min(Math.max(0, requestedStart), maximumStart);
  const update = (next: number) => {
    const bounded = Math.min(Math.max(0, next), maximumStart);
    if (controlledStart === undefined) setInternalStart(bounded);
    onChange?.(bounded);
  };

  useEffect(() => {
    if (requestedStart !== start) update(start);
  }, [itemCount, requestedStart, start]);

  useEffect(() => {
    const pending = pendingOlderCount.current;
    if (pending === null || itemCount <= pending) return;
    pendingOlderCount.current = null;
    update(Math.max(0, itemCount - TIMELINE_MOUNT_LIMIT));
  }, [itemCount]);

  const end = Math.min(itemCount, start + TIMELINE_MOUNT_LIMIT);
  return {
    start,
    end,
    hasNewer: start > 0,
    hasLoadedOlder: end < itemCount,
    showNewer: () => update(start - TIMELINE_WINDOW_STEP),
    showOlder: () => update(start + TIMELINE_WINDOW_STEP),
    expectOlderPage: () => {
      pendingOlderCount.current = itemCount;
    },
  };
}

function authoredReplyTargetKey(
  authorNodeId: string,
  postId: string,
): string {
  return `${authorNodeId.length}:${authorNodeId}${postId}`;
}

function authoredRepliesByTarget(
  posts: readonly AuthoredPost[],
): ReadonlyMap<string, AuthoredPost[]> {
  const grouped = new Map<string, AuthoredPost[]>();
  for (const post of posts) {
    if (!post.replyTo) continue;
    const key = authoredReplyTargetKey(
      post.replyTo.authorNodeId,
      post.replyTo.postId,
    );
    const replies = grouped.get(key) ?? [];
    replies.push(post);
    grouped.set(key, replies);
  }
  for (const replies of grouped.values()) {
    replies.sort((left, right) =>
      (left.createdAt ?? "").localeCompare(right.createdAt ?? "")
    );
  }
  return grouped;
}

function verifiedRepliesByTarget(
  items: readonly NotificationItem[],
): ReadonlyMap<string, NotificationItem[]> {
  const grouped = new Map<string, NotificationItem[]>();
  for (const item of items) {
    if (
      item.kind !== "reply" ||
      item.verification !== "verified" ||
      !item.targetPostId ||
      !item.verifiedReply
    ) continue;
    const replies = grouped.get(item.targetPostId) ?? [];
    replies.push(item);
    grouped.set(item.targetPostId, replies);
  }
  for (const replies of grouped.values()) {
    replies.sort((left, right) =>
      (left.verifiedReply?.createdAt ?? left.receivedAt).localeCompare(
        right.verifiedReply?.createdAt ?? right.receivedAt,
      )
    );
  }
  return grouped;
}

function NotificationReplyCard({
  item,
  liking,
  onLike,
  onOpenLikes,
  onOpenUser,
  onOpenThread,
  onReply,
  onShare,
  parent,
  peerDeliveryEnabled,
  replyCount = null,
  sharingStage,
}: {
  item: NotificationItem;
  liking: boolean;
  onLike?: ((item: FeedItem) => void) | undefined;
  onOpenLikes?: ((item: FeedItem) => void) | undefined;
  onOpenUser?: ((author: FeedAuthor) => void) | undefined;
  onOpenThread?: ((item: FeedItem) => void) | undefined;
  onReply?: ((item: FeedItem) => void) | undefined;
  onShare?: ((item: FeedItem) => void) | undefined;
  parent: FeedItem | null;
  peerDeliveryEnabled: boolean;
  replyCount?: number | null;
  sharingStage: PublishStage | null;
}) {
  const safeProfile = profileMayRenderRemoteText(item.actorProfileProof);
  const authorLabel =
    safeProfile && item.actorDisplayName
      ? item.actorDisplayName
      : shortenNodeId(item.actorNodeId);
  const replyItem = notificationReplyFeedItem(item, parent);
  if (!replyItem) return null;
  return (
    <VerifiedFeedCard
      accessibleLabel={`Reply by ${authorLabel}`}
      item={replyItem}
      liking={liking}
      onLike={onLike}
      onOpenLikes={onOpenLikes}
      onOpenAuthor={onOpenUser}
      onReply={onReply}
      onShare={onShare}
      onThread={onOpenThread}
      peerDeliveryEnabled={peerDeliveryEnabled}
      promoting={false}
      replyCount={replyCount}
      showReplyContext={false}
      sharingStage={sharingStage}
    />
  );
}

function authoredPostFeedItem(
  post: AuthoredPost,
  profile: WagyuProfile | undefined,
  parents: readonly FeedItem[],
): FeedItem | null {
  const bodyHash = post.localLikeView?.postBodyHash ?? null;
  if (
    post.state !== "live" ||
    !profile ||
    !bodyHash ||
    !post.objectDigest ||
    !post.bodyLength
  ) return null;
  const parent = post.replyTo
    ? parents.find(
        (item) =>
          item.verification === "verified" &&
          item.promotion === "committed" &&
          item.author.nodeId === post.replyTo?.authorNodeId &&
          item.postId === post.replyTo.postId,
      ) ?? null
    : null;
  return {
    id: `authored:${post.postId}`,
    localSequence: post.sequence,
    receivedAt: post.createdAt ?? new Date(0).toISOString(),
    immediateSender: profile.nodeId,
    kind: "original",
    verification: "verified",
    promotion: "committed",
    author: {
      nodeId: profile.nodeId,
      displayName: profile.displayName || null,
      avatarUrl: profile.avatarUrl,
      profileProof: profile.proofState,
    },
    postId: post.postId,
    body: post.bodyMarkdown ?? null,
    bodyDigest: bodyHash,
    objectDigest: post.objectDigest,
    bodyLength: post.bodyLength,
    createdAt: post.createdAt,
    sharedBy: null,
    replyTo: post.replyTo
      ? {
          authorNodeId: post.replyTo.authorNodeId,
          author: parent?.author ?? null,
          postId: post.replyTo.postId,
          body: parent ? safeFeedBody(parent) : null,
          verified: Boolean(parent),
        }
      : null,
    likedByOwner: false,
    likeSummary: {
      verified: 0,
      invalid: 0,
      unavailable: 0,
      awaitingBatch: post.localLikeView?.unsealedReceiptCount ?? 0,
    },
    localOrigin: true,
    localAwaitingLikerIds:
      post.localLikeView?.unsealedLikerIds ?? [],
    opaqueEventBytes: null,
    originalPostRefBytes: null,
  };
}

function notificationReplyFeedItem(
  item: NotificationItem,
  parent: FeedItem | null,
): FeedItem | null {
  if (
    item.kind !== "reply" ||
    item.verification !== "verified" ||
    !item.actionId ||
    !item.objectDigest ||
    !item.objectLength ||
    !item.verifiedReply
  ) return null;
  return {
    id: `notification-reply:${item.id}`,
    localSequence: item.localSequence,
    receivedAt: item.receivedAt,
    immediateSender: item.actorNodeId,
    kind: "original",
    verification: "verified",
    promotion: "committed",
    author: {
      nodeId: item.actorNodeId,
      displayName: item.actorDisplayName,
      avatarUrl: item.actorAvatarUrl,
      profileProof: item.actorProfileProof,
    },
    postId: item.actionId,
    body: item.verifiedReply.bodyMarkdown,
    bodyDigest: item.verifiedReply.bodyHash,
    objectDigest: item.objectDigest,
    bodyLength: item.objectLength,
    createdAt: item.verifiedReply.createdAt,
    sharedBy: null,
    replyTo: parent
      ? {
          authorNodeId: parent.author.nodeId,
          author: parent.author,
          postId: parent.postId,
          body: safeFeedBody(parent),
          verified: true,
        }
      : null,
    likedByOwner: false,
    likeSummary: {
      verified: 0,
      invalid: 0,
      unavailable: 0,
      awaitingBatch: 0,
    },
    localOrigin: false,
    opaqueEventBytes: null,
    originalPostRefBytes: null,
  };
}

type ConversationIndex = {
  items: readonly FeedItem[];
  byPost: ReadonlyMap<string, FeedItem>;
  children: ReadonlyMap<string, readonly FeedItem[]>;
};

function buildConversationIndex(
  feedItems: readonly FeedItem[],
  authoredPosts: readonly AuthoredPost[],
  notifications: readonly NotificationItem[],
  profile: WagyuProfile | undefined,
  indexedReplies: readonly FeedItem[] = [],
  blockedNodeIds: ReadonlySet<string> = NO_BLOCKED_USERS,
): ConversationIndex {
  const byPost = new Map<string, FeedItem>();
  const items: FeedItem[] = [];
  const add = (item: FeedItem | null) => {
    if (
      !item ||
      item.verification !== "verified" ||
      item.promotion !== "committed" ||
      item.kind === "tombstone" ||
      !feedItemAllowedByBlock(item, blockedNodeIds)
    ) return;
    const key = feedItemKey(item);
    if (byPost.has(key)) return;
    byPost.set(key, item);
    items.push(item);
  };

  for (const item of feedItems) add(item);
  const orderedAuthored = [...authoredPosts].sort((left, right) =>
    (left.createdAt ?? "").localeCompare(right.createdAt ?? "")
  );
  for (const post of orderedAuthored.filter((candidate) => !candidate.replyTo)) {
    add(authoredPostFeedItem(post, profile, items));
  }
  for (const post of orderedAuthored.filter((candidate) => candidate.replyTo)) {
    add(authoredPostFeedItem(post, profile, items));
  }
  for (const reply of indexedReplies) add(reply);
  for (const notification of notifications) {
    if (
      notification.kind !== "reply" ||
      notification.verification !== "verified" ||
      !notification.targetPostId
    ) continue;
    let parent: FeedItem | null = null;
    if (profile) {
      parent = byPost.get(
        authoredReplyTargetKey(profile.nodeId, notification.targetPostId),
      ) ?? null;
    }
    parent ??=
      items.find((candidate) =>
        candidate.postId === notification.targetPostId
      ) ??
      null;
    add(notificationReplyFeedItem(notification, parent));
  }

  const children = new Map<string, FeedItem[]>();
  for (const item of items) {
    if (!item.replyTo?.postId) continue;
    const key = authoredReplyTargetKey(
      item.replyTo.authorNodeId,
      item.replyTo.postId,
    );
    const rows = children.get(key) ?? [];
    rows.push(item);
    children.set(key, rows);
  }
  for (const rows of children.values()) {
    rows.sort((left, right) =>
      (left.createdAt ?? left.receivedAt).localeCompare(
        right.createdAt ?? right.receivedAt,
      )
    );
  }
  return { items, byPost, children };
}

function feedItemKey(item: FeedItem): string {
  return authoredReplyTargetKey(item.author.nodeId, item.postId);
}

function feedItemAllowedByBlock(
  item: FeedItem,
  blockedNodeIds: ReadonlySet<string>,
): boolean {
  return (
    !blockedNodeIds.has(item.author.nodeId) &&
    !blockedNodeIds.has(item.immediateSender) &&
    (
      item.sharedBy === null ||
      !blockedNodeIds.has(item.sharedBy.nodeId)
    )
  );
}

function conversationReplyCount(
  item: FeedItem,
  conversation: ConversationIndex,
): number | null {
  const loadedCount =
    conversation.children.get(feedItemKey(item))?.length ?? 0;
  if (item.verifiedReplyCount === undefined && loadedCount === 0) return null;
  return Math.max(loadedCount, item.verifiedReplyCount ?? 0);
}

function notificationReplyCount(
  item: NotificationItem,
  conversation: ConversationIndex,
): number {
  if (!item.actionId) return 0;
  return (
    conversation.children.get(
      authoredReplyTargetKey(item.actorNodeId, item.actionId),
    )?.length ?? 0
  );
}

function conversationAncestors(
  item: FeedItem,
  conversation: ConversationIndex,
  blockedNodeIds: ReadonlySet<string> = NO_BLOCKED_USERS,
): FeedItem[] {
  const ancestors: FeedItem[] = [];
  const seen = new Set<string>([feedItemKey(item)]);
  let current = item;
  for (let depth = 0; depth < 32; depth += 1) {
    const reference = current.replyTo;
    if (!reference?.postId) break;
    if (blockedNodeIds.has(reference.authorNodeId)) break;
    const key = authoredReplyTargetKey(
      reference.authorNodeId,
      reference.postId,
    );
    if (seen.has(key)) break;
    const parent =
      conversation.byPost.get(key) ??
      resolveThreadParent(current, conversation.items, blockedNodeIds);
    if (!parent) break;
    ancestors.unshift(parent);
    seen.add(key);
    current = parent;
  }
  return ancestors;
}

function conversationDirectReplies(
  item: FeedItem,
  conversation: ConversationIndex,
): ThreadReplyNode[] {
  return (conversation.children.get(feedItemKey(item)) ?? []).map(
    (reply) => ({ item: reply, depth: 1 }),
  );
}

export function notificationThreadTarget(
  item: NotificationItem,
  authoredItems: readonly AuthoredItem[],
  profile: WagyuProfile,
  feedItems: readonly FeedItem[],
): FeedItem | null {
  if (!item.targetPostId) return null;
  const feedTarget =
    feedItems.find(
      (candidate) =>
        candidate.verification === "verified" &&
        candidate.promotion === "committed" &&
        candidate.author.nodeId === profile.nodeId &&
        candidate.postId === item.targetPostId &&
        (
          item.targetBodyHash === null ||
          candidate.bodyDigest === item.targetBodyHash
        ),
    ) ?? null;
  const authoredTarget = authoredItems.find(
    (candidate): candidate is AuthoredPost =>
      candidate.kind === "post" &&
      candidate.postId === item.targetPostId &&
      (
        item.targetBodyHash === null ||
        candidate.localLikeView?.postBodyHash === item.targetBodyHash
      ),
  );
  const parent =
    feedTarget ??
    (authoredTarget
      ? authoredPostFeedItem(authoredTarget, profile, feedItems)
      : null);
  if (!parent) return null;
  if (item.kind !== "reply") return parent;
  return notificationReplyFeedItem(item, parent);
}

function authoredActionNeedsAttention(
  item: Exclude<AuthoredItem, AuthoredPost>,
): boolean {
  return (
    item.state === "awaiting-publication" ||
    item.state === "awaiting-proof" ||
    item.state === "uncertain" ||
    item.state === "failed"
  );
}

function authoredStateLabel(item: AuthoredItem): string {
  if (item.kind === "post") {
    switch (item.state) {
      case "awaiting-proof":
        return "finishing";
      case "live":
        return "live";
      case "withdrawal-awaiting-proof":
        return "deletion needs attention";
      case "withdrawal-closing":
        return "closing";
      case "withdrawn":
        return "deleted";
      case "unknown":
        return "status unavailable";
    }
  }
  switch (item.state) {
    case "awaiting-publication":
      return "finishing in the background";
    case "awaiting-proof":
      return "ready to finish";
    case "certified":
      return "complete";
    case "uncertain":
      return "checking status";
    case "failed":
      return "could not finish";
    case "unknown":
      return "status unavailable";
  }
}

function authoredKindLabel(kind: AuthoredItem["kind"]): string {
  switch (kind) {
    case "post":
      return "Post";
    case "share":
      return "Share";
    case "like":
      return "Like";
    case "tombstone":
      return "Deletion";
  }
}

function authoredResumeLabel(kind: AuthoredItem["kind"]): string {
  switch (kind) {
    case "post":
      return "Finish sending";
    case "share":
      return "Finish sharing";
    case "like":
      return "Finish Like";
    case "tombstone":
      return "Finish deletion";
  }
}

function actionStageLabel(stage: PublishStage): string {
  switch (stage) {
    case "encoding":
      return "Preparing…";
    case "publishing":
      return "Sending…";
    case "awaiting-proof":
      return "Finishing…";
    case "certified-ref-ready":
      return "Finishing…";
    case "withdrawal-closing":
      return "Deleting…";
    case "fanout-queued":
      return "Sent";
    default:
      return "Working…";
  }
}

function shortDigest(value: string): string {
  return value.length > 20
    ? `${value.slice(0, 10)}…${value.slice(-8)}`
    : value;
}

function CandidateCard({
  item,
  verifying,
  onVerify,
}: {
  item: FeedItem;
  verifying: boolean;
  onVerify: (item: FeedItem) => void;
}) {
  const cardHeadingId = useId();
  const deliveryLabel = `${item.localSequence} from ${shortenNodeId(item.immediateSender)}`;
  const presentation = verificationPresentation(
    verifying && item.verification === "candidate"
      ? "fetching"
      : item.verification,
  );
  const processing =
    verifying ||
    item.verification === "candidate" ||
    item.verification === "fetching" ||
    item.verification === "http-certified" ||
    item.verification === "object-digest-valid" ||
    item.verification === "action-body-valid";
  if (processing) {
    return (
      <article
        aria-labelledby={cardHeadingId}
        className="wg-candidate wg-candidate--skeleton"
        data-verification={item.verification}
      >
        <h2 className="nt-sr-only" id={cardHeadingId}>
          Loading post {deliveryLabel}
        </h2>
        <div aria-hidden="true" className="wg-post-skeleton">
          <span className="wg-post-skeleton__avatar" />
          <div className="wg-post-skeleton__content">
            <div className="wg-post-skeleton__identity">
              <span />
              <span />
            </div>
            <div className="wg-post-skeleton__body">
              <span />
              <span />
              <span />
            </div>
            <div className="wg-post-skeleton__actions">
              <span />
              <span />
              <span />
            </div>
          </div>
        </div>
      </article>
    );
  }
  const detail =
    verificationIssueCopy(item.verificationIssue ?? null) ??
    "Wagyu couldn't connect to this post.";
  const statusLabel =
    item.verification === "unsupported" ? "Update needed" : "Unavailable";
  const mayRetry =
    item.verification === "candidate" ||
    item.verification === "unavailable" ||
    item.verification === "unverified";
  return (
    <article
      aria-labelledby={cardHeadingId}
      className={`wg-candidate wg-candidate--${presentation.tone}`}
      data-verification={item.verification}
    >
      <h2 className="nt-sr-only" id={cardHeadingId}>
        Loading post {deliveryLabel}
      </h2>
      <header>
        <div className="wg-candidate__origin">
          <Avatar imageUrl={null} nodeId={item.immediateSender} size="sm" />
          <span>
            Post from <code>{shortenNodeId(item.immediateSender)}</code>
          </span>
        </div>
        <span className={`wg-proof-pill wg-proof-pill--${presentation.tone}`}>
          <IoWarningOutline aria-hidden="true" />
          {statusLabel}
        </span>
      </header>
      <div className="wg-candidate__safe-copy">
        <div>
          <strong>Post unavailable</strong>
          <p>{detail}</p>
        </div>
      </div>
      <footer>
        <span>
          {relativeTime(item.receivedAt)}
        </span>
        {mayRetry ? (
          <button
            aria-label={`Retry loading post ${deliveryLabel}`}
            className="nt-button nt-button--secondary nt-button--sm"
            disabled={verifying}
            onClick={() => onVerify(item)}
            type="button"
          >
            <IoRefreshOutline aria-hidden="true" />
            {verifying ? "Loading…" : "Retry"}
          </button>
        ) : null}
      </footer>
    </article>
  );
}

export function verificationIssueCopy(
  issue: VerificationIssueCode | null,
): string | null {
  switch (issue) {
    case "fetch-unavailable":
      return "This post couldn't be loaded. Try again.";
    case "object-not-found":
      return "This post is no longer available.";
    case "certificate-invalid":
      return "Wagyu couldn't confirm this post, so it remains hidden.";
    case "content-digest-mismatch":
      return "Wagyu couldn't confirm this post, so it remains hidden.";
    case "object-digest-mismatch":
      return "Wagyu couldn't confirm this post, so it remains hidden.";
    case "candid-invalid":
      return "This post could not be read safely.";
    case "binding-invalid":
      return "Wagyu couldn't confirm who posted this, so it remains hidden.";
    case "promotion-failed":
      return "This post was confirmed but couldn't be added to your feed.";
    case "unsupported":
      return "This post needs a newer version of Wagyu.";
    case "unknown":
      return "This post couldn't be loaded safely. Try again.";
    case null:
      return null;
  }
}
