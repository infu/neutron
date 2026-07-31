import {
  type ReactNode,
  useEffect,
  useRef,
} from "react";
import {
  IoArrowRedoOutline,
  IoChatbubbleOutline,
} from "react-icons/io5";
import { NodeIdentity } from "./Avatar.tsx";

export type PostCardAuthor = {
  nodeId: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};

export type PostCardReplyContext = {
  label: string;
  onOpen?: (() => void) | undefined;
};

/**
 * Presentation-only social post shell.
 *
 * Callers own every trust decision before passing text to this component.
 * In particular, remote feed callers must continue to use `safeFeedBody`;
 * this shell never inspects, verifies, or promotes remote bytes.
 */
export function PostCard({
  accessibleLabel,
  actions,
  author,
  body,
  emptyBody = "This post has no text.",
  menu,
  notice,
  onOpenAuthor,
  onOpen,
  onVisibilityChange,
  replyTo,
  sharedBy,
  showReplyContext = true,
  timestamp,
  withdrawn = false,
}: {
  accessibleLabel: string;
  actions?: ReactNode;
  author: PostCardAuthor;
  body: string | null;
  emptyBody?: string;
  menu?: ReactNode;
  notice?: ReactNode;
  onOpenAuthor?: (() => void) | undefined;
  onOpen?: (() => void) | undefined;
  onVisibilityChange?: ((visible: boolean) => void) | undefined;
  replyTo?: PostCardReplyContext | null;
  sharedBy?: string | null;
  showReplyContext?: boolean;
  timestamp?: string | null;
  withdrawn?: boolean;
}) {
  const articleRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!onVisibilityChange) return;
    const article = articleRef.current;
    if (!article || typeof IntersectionObserver === "undefined") {
      onVisibilityChange(true);
      return () => onVisibilityChange(false);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        onVisibilityChange(entries.some((entry) => entry.isIntersecting));
      },
      { rootMargin: "160px 0px" },
    );
    observer.observe(article);
    return () => {
      observer.disconnect();
      onVisibilityChange(false);
    };
  }, [onVisibilityChange]);

  const replyContext = replyTo ? (
    <>
      <IoChatbubbleOutline aria-hidden="true" />
      <span>
        Reply to <strong>{replyTo.label}</strong>
      </span>
    </>
  ) : null;
  const openPost = onOpen ?? replyTo?.onOpen;
  const content = (
    <>
      {notice}
      {sharedBy ? (
        <div className="wg-shared-by">
          <IoArrowRedoOutline aria-hidden="true" />
          <span>
            <strong>{sharedBy}</strong> shared
          </span>
        </div>
      ) : null}
      <header className="wg-feed-card__header">
        {author.nodeId ? (
          <NodeIdentity
            avatarUrl={author.avatarUrl}
            copyable={false}
            displayName={author.displayName}
            nodeId={author.nodeId}
            onOpenProfile={onOpenAuthor}
            secondary={
              timestamp ? <span title={timestamp}>{timestamp}</span> : undefined
            }
          />
        ) : (
          <div className="wg-identity">
            <div className="wg-identity__copy">
              <strong>{author.displayName || "You"}</strong>
              {timestamp ? (
                <span className="wg-identity__secondary">{timestamp}</span>
              ) : null}
            </div>
          </div>
        )}
      </header>
      {replyTo && showReplyContext ? (
        <div className="wg-reply-context">{replyContext}</div>
      ) : null}
      <div className="wg-feed-card__body">
        {body ? (
          <p>{body}</p>
        ) : (
          <p className="wg-muted-post">{emptyBody}</p>
        )}
      </div>
    </>
  );
  return (
    <article
      aria-label={accessibleLabel}
      className={[
        "wg-feed-card",
        menu ? "has-menu" : "",
        withdrawn ? "is-withdrawn" : "",
      ].filter(Boolean).join(" ")}
      ref={articleRef}
    >
      {menu ? <div className="wg-feed-card__menu">{menu}</div> : null}
      {openPost ? (
        <div
          aria-label={
            replyTo
              ? `Open thread replying to ${replyTo.label}`
              : `Open ${accessibleLabel}`
          }
          className="wg-feed-card__thread-link"
          onClick={openPost}
          onKeyDown={(event) => {
            if (event.currentTarget !== event.target) return;
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            openPost();
          }}
          role="link"
          tabIndex={0}
        >
          {content}
        </div>
      ) : content}
      {actions ? (
        <footer className="wg-feed-card__actions">{actions}</footer>
      ) : null}
    </article>
  );
}
