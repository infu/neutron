// Feed, reader, and account views.

import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { copyToClipboard } from "neutron-tools/app";
import {
  isErr,
  type Api,
  type Article,
  type CommentNode,
  type FeedPage,
  type FeedRow,
  type Identity,
  type ShardStatus,
} from "./api";
import { ArticleBody, ArticleImage } from "./html";
import { count, relativeFromMillis, tidyListTitle, toNumber } from "./format";
import { IconButton, Notice, StateBlock, Tags } from "./ui";

const SOURCES: [string, string][] = [
  ["latest", "Latest"],
  ["popular_today", "Today"],
  ["popular_week", "Week"],
  ["popular_month", "Month"],
];

const MAX_COMMENT = 400;

// ------------------------------------------------------------------- feed

export function FeedView({
  page,
  loading,
  error,
  source,
  bookmarked,
  onSource,
  onOpen,
  onReload,
  onToggleBookmark,
  searchTerm,
  onSearch,
}: {
  page: FeedPage | null;
  loading: boolean;
  error: string | null;
  source: string;
  /// Post ids on the reading list. Bookmarks are canister state and feed rows
  /// come from Nuance, so the star is resolved here rather than on the row.
  bookmarked: ReadonlySet<string>;
  onSource: (source: string) => void;
  onOpen: (row: FeedRow) => void;
  onReload: () => void;
  onToggleBookmark: (row: FeedRow) => void;
  searchTerm: string;
  onSearch: (term: string) => void;
}) {
  const [term, setTerm] = useState(searchTerm);
  const searching = source === "search";

  return (
    <div className="nuance-feed" data-tid="nuance-feed">
      {/*
        This app uses no form elements at all. Tiles run in a sandbox of
        `allow-scripts allow-same-origin` with no `allow-forms`, so the browser
        blocks submission outright: implicit Enter submission never reaches an
        onSubmit handler and logs a console error instead. Enter is wired
        explicitly on the input instead.
      */}
      <div className="nuance-search" role="search">
        <input
          aria-label="Search Nuance"
          className="nt-input nuance-search-input"
          data-tid="nuance-search-input"
          onChange={(event) => setTerm(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onSearch(term.trim());
            } else if (event.key === "Escape" && searching) {
              event.preventDefault();
              setTerm("");
              onSearch("");
            }
          }}
          placeholder="Search articles"
          type="search"
          value={term}
        />
        <IconButton
          disabled={term.trim().length === 0 && !searching}
          label="Search Nuance"
          onClick={() => onSearch(term.trim())}
          testId="nuance-search-submit"
        >
          ⌕
        </IconButton>
        {searching ? (
          <IconButton
            label="Clear search and return to the feed"
            onClick={() => {
              setTerm("");
              onSearch("");
            }}
          >
            ×
          </IconButton>
        ) : null}
      </div>

      {!searching ? (
        <div className="nt-segmented nuance-sources" role="group" aria-label="Feed source">
          {SOURCES.map(([value, label]) => (
            <button
              aria-pressed={source === value}
              className={`nt-tab${source === value ? " is-selected" : ""}`}
              data-tid={`nuance-source-${value}`}
              key={value}
              onClick={() => onSource(value)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}

      {error ? (
        <StateBlock kind="error" onRetry={onReload}>
          {error}
        </StateBlock>
      ) : null}

      {loading && !page ? <StateBlock kind="loading">Loading articles…</StateBlock> : null}

      {page && page.rows.length === 0 && !loading ? (
        <StateBlock kind="empty">
          {searching ? "No articles matched that search." : "No articles here yet."}
        </StateBlock>
      ) : null}

      <ul className="nt-settings-list nuance-rows">
        {page?.rows.map((row) => (
          <li className="nt-settings-row nuance-row" key={`${row.postId}-${row.bucketCanisterId}`}>
            {/*
              The slot is always present, even with no cover and even if the
              request later fails, so one imageless article in a list does not
              shift every other row's text.
            */}
            <span aria-hidden="true" className="nuance-row-thumb">
              <ArticleImage className="nuance-row-thumb-img" src={row.headerImage} />
            </span>
            <button
              className="nuance-row-main"
              data-tid="nuance-row"
              onClick={() => onOpen(row)}
              type="button"
            >
              <strong className="nuance-row-title">{tidyListTitle(row.title) || "Untitled"}</strong>
              <span className="nuance-row-meta">
                @{row.handle} · {relativeFromMillis(row.publishedDate)} ·{" "}
                {count(row.wordCount)}w
                {toNumber(row.claps) > 0 ? ` · ♥ ${count(row.claps)}` : ""}
                {toNumber(row.views) > 0 ? ` · ${count(row.views)} views` : ""}
              </span>
              <Tags tags={row.tags} />
            </button>
            <IconButton
              active={bookmarked.has(row.postId)}
              label={
                bookmarked.has(row.postId)
                  ? "Remove from reading list"
                  : "Save to reading list"
              }
              onClick={() => onToggleBookmark(row)}
            >
              {bookmarked.has(row.postId) ? "★" : "☆"}
            </IconButton>
          </li>
        ))}
      </ul>

      {loading && page ? <StateBlock kind="loading">Refreshing…</StateBlock> : null}
    </div>
  );
}

// ----------------------------------------------------------------- reader

export function ReaderView({
  api,
  postId,
  bucketCanisterId,
  identity,
  bookmarked,
  onBack,
  onStatus,
  onRevise,
  onToggleBookmark,
}: {
  api: Api;
  postId: string;
  bucketCanisterId: string;
  identity: Identity | null;
  bookmarked: boolean;
  onBack: () => void;
  onStatus: (message: string) => void;
  onRevise: (postId: string, bucket: string) => void;
  onToggleBookmark: (article: Article) => void;
}) {
  const [article, setArticle] = useState<Article | null>(null);
  const [comments, setComments] = useState<CommentNode[] | null>(null);
  const [total, setTotal] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showComments, setShowComments] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [draftComment, setDraftComment] = useState("");
  const [posting, setPosting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await api.article(postId, bucketCanisterId);
    setLoading(false);
    if (isErr(result)) {
      setError(result.err);
      return;
    }
    setError(null);
    setArticle(result.ok);
  }, [api, bucketCanisterId, postId]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadComments = useCallback(async () => {
    const result = await api.comments(postId, bucketCanisterId);
    if (isErr(result)) {
      onStatus(result.err);
      return;
    }
    setComments(result.ok.comments);
    setTotal(result.ok.total);
  }, [api, bucketCanisterId, onStatus, postId]);

  const copyLink = useCallback((href: string) => {
    void copyToClipboard(href).then(
      () => onStatus("Link copied."),
      () => onStatus("The kernel declined the clipboard write."),
    );
  }, [onStatus]);

  const submitComment = useCallback(async () => {
    const content = draftComment.trim();
    if (!content) return;
    setPosting(true);
    try {
      const result = await api.comment({
        postId,
        bucketCanisterId,
        content,
        ...(replyTo ? { replyToCommentId: replyTo } : {}),
      });
      if (isErr(result)) {
        onStatus(result.err);
        return;
      }
      if (result.ok.refreshed) {
        setComments(result.ok.comments);
        setTotal(result.ok.total);
      }
      setDraftComment("");
      setReplyTo(null);
      onStatus(result.ok.refreshed
        ? result.ok.message
        : `${result.ok.message} Comments could not refresh: ${result.ok.refreshError}`);
    } finally {
      setPosting(false);
    }
  }, [api, bucketCanisterId, draftComment, onStatus, postId, replyTo]);

  const vote = useCallback(
    async (commentId: string, direction: "up" | "down") => {
      const result = await api.voteComment(bucketCanisterId, commentId, direction, postId);
      if (isErr(result)) onStatus(result.err);
      else if (result.ok.refreshed) {
        setComments(result.ok.comments);
        setTotal(result.ok.total);
      } else {
        onStatus(`${result.ok.message} Comments could not refresh: ${result.ok.refreshError}`);
      }
    },
    [api, bucketCanisterId, onStatus, postId],
  );

  if (loading && !article) return <StateBlock kind="loading">Loading article…</StateBlock>;
  if (error && !article) {
    return (
      <div className="nuance-reader" data-tid="nuance-reader">
        <IconButton label="Back to the feed" onClick={onBack}>←</IconButton>
        <StateBlock kind="error" onRetry={() => void load()}>{error}</StateBlock>
      </div>
    );
  }
  if (!article) return null;

  const mine = identity?.registered === true && identity.handle === article.handle;

  return (
    <div className="nuance-reader" data-tid="nuance-reader">
      <header className="nuance-reader-bar">
        <IconButton label="Back to the feed" onClick={onBack}>←</IconButton>
        <span className="nuance-reader-actions">
          <IconButton
            active={bookmarked}
            label={bookmarked ? "Remove from reading list" : "Save to reading list"}
            onClick={() => onToggleBookmark(article)}
          >
            {bookmarked ? "★" : "☆"}
          </IconButton>
          <IconButton
            label={`Comments (${total})`}
            onClick={() => {
              setShowComments((value) => !value);
              if (!comments) void loadComments();
            }}
            active={showComments}
            badge={toNumber(total) > 0 ? total : undefined}
          >
            ☰
          </IconButton>
          <IconButton
            label="Applaud this article"
            onClick={() => {
              void api.clap(article.postId).then((result) => {
                onStatus(isErr(result) ? result.err : result.ok);
              });
            }}
          >
            ♥
          </IconButton>
          <IconButton
            label="Copy the nuance.xyz link"
            onClick={() => copyLink(article.url)}
          >
            ⧉
          </IconButton>
          {mine ? (
            <IconButton
              label="Revise this article in the editor"
              onClick={() => onRevise(article.postId, article.bucketCanisterId)}
            >
              ✎
            </IconButton>
          ) : null}
        </span>
      </header>

      <article className="nuance-article">
        {/* Decorative: the title sits directly beneath it, so it carries no alt. */}
        <ArticleImage className="nuance-cover" src={article.headerImage} />
        <h1 className="nt-title nuance-article-title" data-tid="nuance-article-title">{article.title}</h1>
        <p className="nt-meta nuance-byline">
          @{article.handle} · {relativeFromMillis(article.publishedDate)} ·{" "}
          {count(article.wordCount)} words
          {toNumber(article.claps) > 0 ? ` · ♥ ${count(article.claps)}` : ""}
        </p>
        <Tags tags={article.tags} />
        {article.subtitle ? (
          <p className="nt-subtitle nuance-standfirst">{article.subtitle}</p>
        ) : null}

        {article.available ? (
          <ArticleBody html={article.html} onCopyLink={copyLink} />
        ) : (
          <StateBlock kind="empty">
            {article.isPremium || article.isMembersOnly
              ? "Nuance did not return a body: this article is premium or members-only, and this Neutron's account is not entitled to read it."
              : "Nuance returned an empty body for this article."}
          </StateBlock>
        )}
      </article>

      {showComments ? (
        <section className="nuance-comments">
          <header className="nt-section-header">
            <h2 className="nt-section-heading">Comments</h2>
            <span className="nt-section-count">{total}</span>
          </header>

          {comments === null ? (
            <StateBlock kind="loading">Loading comments…</StateBlock>
          ) : comments.length === 0 ? (
            <StateBlock kind="empty">No comments yet.</StateBlock>
          ) : (
            <ul className="nuance-comment-list">
              {comments.map((comment) => (
                <li
                  className="nuance-comment"
                  key={comment.commentId}
                  style={{ marginInlineStart: `${Math.min(comment.depth, 3) * 12}px` }}
                >
                  <p className="nt-meta nuance-comment-meta">
                    @{comment.handle || "unknown"} ·{" "}
                    {relativeFromMillis(comment.createdAt)}
                  </p>
                  <p className="nt-text nuance-comment-body">
                    {comment.isCensored ? "[removed by moderation]" : comment.content}
                  </p>
                  <span className="nuance-comment-actions">
                    <IconButton
                      label="Upvote this comment"
                      onClick={() => void vote(comment.commentId, "up")}
                      badge={comment.upVotes > 0 ? String(comment.upVotes) : undefined}
                    >
                      ▲
                    </IconButton>
                    <IconButton
                      label="Downvote this comment"
                      onClick={() => void vote(comment.commentId, "down")}
                      badge={comment.downVotes > 0 ? String(comment.downVotes) : undefined}
                    >
                      ▼
                    </IconButton>
                    <IconButton
                      active={replyTo === comment.commentId}
                      label="Reply to this comment"
                      onClick={() =>
                        setReplyTo((value) =>
                          value === comment.commentId ? null : comment.commentId,
                        )
                      }
                    >
                      ↩
                    </IconButton>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {identity?.registered ? (
            <div className="nuance-comment-composer">
              {replyTo ? (
                <p className="nt-help">
                  Replying to a comment.{" "}
                  <button
                    className="nuance-linklike"
                    onClick={() => setReplyTo(null)}
                    type="button"
                  >
                    Cancel
                  </button>
                </p>
              ) : null}
              <textarea
                aria-label="Write a comment"
                className="nt-textarea"
                data-tid="nuance-comment-input"
                maxLength={MAX_COMMENT}
                onChange={(event) => setDraftComment(event.target.value)}
                onKeyDown={(event) => {
                  // Enter inserts a newline; the shortcut posts.
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    if (!posting && draftComment.trim()) void submitComment();
                  }
                }}
                placeholder="Add a comment (Ctrl+Enter to post)"
                rows={3}
                value={draftComment}
              />
              <div className="nuance-comment-submit">
                <span className="nt-meta">
                  {draftComment.length}/{MAX_COMMENT}
                </span>
                <button
                  className="nt-button nt-button--sm"
                  data-tid="nuance-comment-submit"
                  disabled={posting || draftComment.trim().length === 0}
                  onClick={() => void submitComment()}
                  type="button"
                >
                  {posting ? "Posting…" : replyTo ? "Reply" : "Comment"}
                </button>
              </div>
            </div>
          ) : (
            <Notice tone="info">
              Register a Nuance handle in Account to comment.
            </Notice>
          )}
        </section>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- account

export function AccountView({
  api,
  identity,
  onIdentity,
  onStatus,
  onOpen,
  onGrantShard,
}: {
  api: Api;
  identity: Identity | null;
  onIdentity: (identity: Identity) => void;
  onStatus: (message: string) => void;
  onOpen: (row: FeedRow) => void;
  onGrantShard: (bucket: string) => Promise<void>;
}) {
  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mine, setMine] = useState<FeedPage | null>(null);
  const [kind, setKind] = useState<"published" | "drafts">("published");
  const [shards, setShards] = useState<ShardStatus | null>(null);

  // Reading needs no reservation: the tile queries Nuance directly. Only
  // comments and votes are sent from the canister, and only those need one.
  const loadShards = useCallback(async () => {
    const result = await api.shardStatus();
    if (!isErr(result)) setShards(result.ok);
  }, [api]);

  useEffect(() => {
    void loadShards();
  }, [loadShards]);

  const refreshIdentity = useCallback(async () => {
    setBusy(true);
    const result = await api.whoami();
    setBusy(false);
    if (isErr(result)) setError(result.err);
    else {
      setError(null);
      onIdentity(result.ok);
    }
  }, [api, onIdentity]);

  const loadMine = useCallback(
    async (which: "published" | "drafts") => {
      setKind(which);
      const result = await api.myPosts(which, 0, 20);
      if (isErr(result)) onStatus(result.err);
      else setMine(result.ok);
    },
    [api, onStatus],
  );

  const register = useCallback(async () => {
    setBusy(true);
    try {
      const result = await api.register(handle.trim(), displayName.trim() || handle.trim(), "");
      if (isErr(result)) {
        setError(result.err);
        return;
      }
      setError(null);
      onIdentity(result.ok);
      onStatus(`Registered @${result.ok.handle} on Nuance.`);
    } finally {
      setBusy(false);
    }
  }, [api, displayName, handle, onIdentity, onStatus]);

  const submitOnEnter = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (busy || handle.trim().length === 0) return;
      void register();
    },
    [busy, handle, register],
  );

  return (
    <div className="nuance-account" data-tid="nuance-account">
      <section className="nt-section">
        <header className="nt-section-header">
          <h2 className="nt-section-heading">Nuance identity</h2>
        </header>

        <Notice tone="info">{identity?.note ?? "Loading identity…"}</Notice>

        <dl className="nt-detail-grid">
          <div className="nt-detail">
            <dt className="nt-detail-label">Handle</dt>
            <dd className="nt-detail-value">
              {identity?.registered ? `@${identity.handle}` : "not registered"}
            </dd>
          </div>
          <div className="nt-detail">
            <dt className="nt-detail-label">Principal</dt>
            <dd className="nt-detail-value nuance-principal">
              {identity?.principalId ?? "—"}
              {identity ? (
                <IconButton
                  label="Copy this Neutron's principal"
                  onClick={() => {
                    void copyToClipboard(identity.principalId).then(
                      () => onStatus("Principal copied."),
                      () => onStatus("The kernel declined the clipboard write."),
                    );
                  }}
                >
                  ⧉
                </IconButton>
              ) : null}
            </dd>
          </div>
          {identity?.registered ? (
            <div className="nt-detail">
              <dt className="nt-detail-label">Daily post allowance</dt>
              <dd className="nt-detail-value">{identity.dailyAllowance}</dd>
            </div>
          ) : null}
        </dl>

        <div className="nuance-account-actions">
          <IconButton
            disabled={busy}
            label="Re-check this Neutron's Nuance account"
            onClick={() => void refreshIdentity()}
          >
            ⟳
          </IconButton>
        </div>

        {error ? <Notice tone="danger">{error}</Notice> : null}

        {identity && !identity.registered ? (
          <div className="nt-form nuance-register">
            <label className="nt-field">
              <span className="nt-label">Handle</span>
              <input
                className="nt-input"
                data-tid="nuance-register-handle"
                maxLength={32}
                onChange={(event) => setHandle(event.target.value)}
                onKeyDown={submitOnEnter}
                placeholder="letters, digits, hyphens"
                value={handle}
              />
              <span className="nt-help">
                Claimed once for this Neutron and unique across Nuance.
              </span>
            </label>
            <label className="nt-field">
              <span className="nt-label">Display name</span>
              <input
                className="nt-input"
                maxLength={64}
                onChange={(event) => setDisplayName(event.target.value)}
                onKeyDown={submitOnEnter}
                placeholder="optional"
                value={displayName}
              />
            </label>
            <button
              className="nt-button"
              data-tid="nuance-register-submit"
              disabled={busy || handle.trim().length === 0}
              onClick={() => void register()}
              type="button"
            >
              {busy ? "Registering…" : "Register on Nuance"}
            </button>
          </div>
        ) : null}
      </section>

      {shards && shards.unregistered.length > 0 ? (
        <section className="nt-section">
          <header className="nt-section-header">
            <h2 className="nt-section-heading">Comment access</h2>
          </header>
          <Notice tone="warning">
            Nuance has added storage shards this app cannot write to. Reading is
            unaffected; commenting and voting on articles held there will fail
            until you grant access.
          </Notice>
          <ul className="nt-settings-list nuance-rows">
            {shards.unregistered.map((shard) => (
              <li className="nt-settings-row nuance-row" key={shard}>
                <span className="nuance-row-meta nuance-principal">{shard}</span>
                <button
                  className="nt-button nt-button--sm"
                  onClick={() => {
                    void onGrantShard(shard).then(loadShards);
                  }}
                  type="button"
                >
                  Grant
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {identity?.registered ? (
        <section className="nt-section">
          <header className="nt-section-header">
            <h2 className="nt-section-heading">My articles</h2>
          </header>
          <div className="nt-segmented nuance-sources" role="group" aria-label="Which articles">
            {(["published", "drafts"] as const).map((value) => (
              <button
                aria-pressed={kind === value}
                className={`nt-tab${kind === value ? " is-selected" : ""}`}
                key={value}
                onClick={() => void loadMine(value)}
                type="button"
              >
                {value === "published" ? "Published" : "Drafts"}
              </button>
            ))}
          </div>
          {mine === null ? (
            <StateBlock kind="empty">Choose Published or Drafts to load.</StateBlock>
          ) : mine.rows.length === 0 ? (
            <StateBlock kind="empty">Nothing here yet.</StateBlock>
          ) : (
            <ul className="nt-settings-list nuance-rows">
              {mine.rows.map((row) => (
                <li className="nt-settings-row nuance-row" key={row.postId}>
                  <span aria-hidden="true" className="nuance-row-thumb">
                    <ArticleImage className="nuance-row-thumb-img" src={row.headerImage} />
                  </span>
                  <button className="nuance-row-main" onClick={() => onOpen(row)} type="button">
                    <strong className="nuance-row-title">
                      {tidyListTitle(row.title) || "Untitled"}
                    </strong>
                    <span className="nuance-row-meta">
                      {relativeFromMillis(row.publishedDate)} · {count(row.wordCount)}w
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
