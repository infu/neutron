// Presentational components. Nothing here talks to Taggr or holds app state:
// every network effect is owned by the shell in index.tsx, so these render
// predictably from props and stay easy to reason about.

import {
  describeDomain,
  findDomain,
  postSuppression,
  suppressionMessage,
} from "./domain.ts";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cx } from "neutron-design-system";
import { copyToClipboard } from "neutron-tools/app";
import {
  IoAddOutline,
  IoBookmarkOutline,
  IoChatbubbleOutline,
  IoCloseOutline,
  IoCopyOutline,
  IoCreateOutline,
  IoEnterOutline,
  IoHappyOutline,
  IoSearchOutline,
} from "react-icons/io5";
import {
  DOWNVOTE_REACTION_ID,
  reactionEmoji,
  REACTIONS,
  type FeedEntry,
  type PostFile,
  type PostId,
  type Realm,
  type SearchResult,
  type TaggrStats,
  type TaggrDomain,
  type TaggrUser,
  type UserId,
} from "./model.ts";
import { Markdown, type MarkdownActions } from "./markdown.tsx";
import { toPlainText } from "./markdown_source.ts";
import {
  bucketImageUrl,
  handleHue,
  handleMonogram,
  realmLogoUrl,
} from "./network.ts";
import {
  absoluteTime,
  compactCount,
  errorMessage,
  formatTokens,
  relativeTime,
  shortPrincipal,
} from "./format.ts";
import type { RegistrationQuote, TileSettings } from "./tile_client.ts";

export const IconButton = ({
  icon,
  label,
  onClick,
  active = false,
  disabled = false,
  danger = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  danger?: boolean;
}) => (
  <button
    aria-label={label}
    aria-pressed={active || undefined}
    className={cx("nt-icon-button", "taggr-icon-button", {
      "taggr-icon-button--active": active,
      "taggr-icon-button--danger": danger,
    })}
    disabled={disabled}
    onClick={onClick}
    title={label}
    type="button"
  >
    {icon}
  </button>
);

/**
 * Taggr has no user avatars — its `User` record carries no image and its own
 * client renders handles alone. This is a local monogram derived from the
 * handle, so a dense feed still has something to scan by.
 */
export const HandleAvatar = ({ handle }: { handle: string }) => (
  <span
    aria-hidden="true"
    className="taggr-avatar"
    style={{ "--taggr-avatar-hue": handleHue(handle) } as React.CSSProperties}
  >
    {handleMonogram(handle)}
  </span>
);

export const StateBlock = ({
  tone,
  children,
}: {
  tone: "empty" | "loading" | "error";
  children: ReactNode;
}) => (
  <div
    aria-busy={tone === "loading" || undefined}
    className={cx("nt-state", `nt-state--${tone}`, "taggr-state")}
  >
    {children}
  </div>
);

const ReactionPalette = ({
  onPick,
  onClose,
  disabled,
}: {
  onPick: (id: number) => void;
  onClose: () => void;
  disabled: boolean;
}) => (
  <span aria-label="Choose a reaction" className="taggr-palette" role="group">
    {REACTIONS.map((reaction) => (
      <button
        aria-label={reaction.label}
        className="taggr-palette-button"
        disabled={disabled}
        key={reaction.id}
        onClick={() => onPick(reaction.id)}
        title={`${reaction.label} · costs 1 credit`}
        type="button"
      >
        {reaction.emoji}
      </button>
    ))}
    <button
      aria-label="Downvote"
      className="taggr-palette-button taggr-palette-button--danger"
      disabled={disabled}
      onClick={() => onPick(DOWNVOTE_REACTION_ID)}
      title="Downvote · costs 1 credit"
      type="button"
    >
      ❌
    </button>
    <IconButton icon={<IoCloseOutline />} label="Close reactions" onClick={onClose} />
  </span>
);

const BLOB_PREFIX = "/blob/";

export type PostActions = {
  markdown: MarkdownActions;
  onOpenThread: (id: PostId) => void;
  onOpenRealm: (realm: string) => void;
  onReply: (id: PostId, realm: string | null) => void;
  onReact: (id: PostId, reaction: number) => void;
  onBookmark: (id: PostId) => void;
};

export const PostRow = ({
  entry,
  actions,
  canWrite,
  busy,
  domain,
  highlighted = false,
}: {
  entry: FeedEntry;
  actions: PostActions;
  canWrite: boolean;
  busy: boolean;
  /** The domain in use, which decides what it suppresses. */
  domain: TaggrDomain | null;
  highlighted?: boolean;
}) => {
  const [palette, setPalette] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const { post, meta } = entry;
  // Taggr's own front ends replace these with a notice rather than dropping
  // them, so the reader can see that something is there and why it is not.
  const suppressed = useMemo(
    () => postSuppression({ post, meta, domain }),
    [domain, meta, post],
  );
  const replies = post.children.length;
  const writeHint = canWrite ? null : "Register this installation on Taggr first";

  // `/blob/<id>` only means something inside the post that owns the file, so the
  // resolver is built per post rather than shared.
  const markdown = useMemo<MarkdownActions>(
    () => ({
      ...actions.markdown,
      resolveImage: (src) => {
        if (!src.startsWith(BLOB_PREFIX)) return src;
        const id = src.slice(BLOB_PREFIX.length);
        const file = post.files.find((entry) => entry.id === id);
        return file ? bucketImageUrl(file) : null;
      },
    }),
    [actions.markdown, post.files],
  );

  // Anything the body never references would otherwise be invisible.
  const unreferenced = useMemo<PostFile[]>(
    () => post.files.filter((file) => !post.body.includes(`${BLOB_PREFIX}${file.id}`)),
    [post.body, post.files],
  );

  return (
    <article
      className={cx("taggr-post", { "taggr-post--highlight": highlighted })}
      aria-label={`Post ${post.id} by ${meta.authorName}`}
    >
      <header className="taggr-post-head">
        <button
          className="taggr-author"
          onClick={() => actions.markdown.onUser?.(meta.authorName)}
          title={`Open @${meta.authorName}`}
          type="button"
        >
          <HandleAvatar handle={meta.authorName} />
          <span className="taggr-author-name">@{meta.authorName}</span>
        </button>
        <span className="taggr-meta" title={absoluteTime(post.timestamp)}>
          {relativeTime(post.timestamp)}
        </span>
        {post.realm ? (
          <button
            className="nt-tag taggr-realm-chip"
            onClick={() => actions.onOpenRealm(post.realm as string)}
            title={`Open the ${post.realm} realm`}
            type="button"
          >
            {post.realm}
          </button>
        ) : null}
        {meta.nsfw ? (
          <span className="nt-tag nt-tag--warning" title="Posted in an adult-content realm">
            nsfw
          </span>
        ) : null}
        <span className="taggr-spacer" />
        <span className="taggr-post-id" title="Taggr post id">
          #{post.id}
        </span>
      </header>

      {suppressed && !revealed ? (
        <div className="taggr-suppressed">
          <span className="taggr-suppressed-text">{suppressionMessage(suppressed)}</span>
          <IconButton
            label="Show anyway"
            onClick={() => setRevealed(true)}
            icon={
              <svg aria-hidden="true" viewBox="0 0 16 16">
                <path
                  d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <circle cx="8" cy="8" fill="currentColor" r="1.8" />
              </svg>
            }
          />
        </div>
      ) : null}

      <div className="taggr-post-body" hidden={suppressed !== null && !revealed}>
        <Markdown actions={markdown} text={post.body} />
        {unreferenced.length > 0 ? (
          <div className="taggr-attachments">
            {unreferenced.map((file) => (
              <img
                alt="Post attachment"
                className="taggr-image"
                key={`${file.id}@${file.bucket}`}
                loading="lazy"
                referrerPolicy="no-referrer"
                src={bucketImageUrl(file)}
              />
            ))}
          </div>
        ) : null}
        {post.extension?.kind === "poll" ? (
          <p className="nt-meta taggr-note-inline" title="Polls are read-only in this client">
            Poll: {post.extension.options.join(" · ")}
          </p>
        ) : null}
        {post.extension?.kind === "repost" ? (
          <button
            className="nt-meta taggr-note-inline taggr-linkish"
            onClick={() => actions.onOpenThread((post.extension as { postId: PostId }).postId)}
            title="Open the reposted post"
            type="button"
          >
            Repost of #{post.extension.postId}
          </button>
        ) : null}
      </div>

      <footer className="taggr-post-foot">
        {post.reactions.map((reaction) => (
          <button
            className={cx("taggr-reaction", {
              "taggr-reaction--down": reaction.id === DOWNVOTE_REACTION_ID,
            })}
            disabled={!canWrite || busy}
            key={reaction.id}
            onClick={() => actions.onReact(post.id, reaction.id)}
            title={writeHint ?? `React ${reactionEmoji(reaction.id)} · costs 1 credit`}
            type="button"
          >
            <span aria-hidden="true">{reactionEmoji(reaction.id)}</span>
            <span>{compactCount(reaction.users.length)}</span>
          </button>
        ))}

        {palette ? (
          <ReactionPalette
            disabled={!canWrite || busy}
            onClose={() => setPalette(false)}
            onPick={(id) => {
              setPalette(false);
              actions.onReact(post.id, id);
            }}
          />
        ) : (
          <IconButton
            disabled={!canWrite || busy}
            icon={<IoHappyOutline />}
            label={writeHint ?? "Add a reaction"}
            onClick={() => setPalette(true)}
          />
        )}

        <span className="taggr-spacer" />

        <IconButton
          icon={<IoChatbubbleOutline />}
          label={replies > 0 ? `Open thread · ${replies} replies` : "Open thread"}
          onClick={() => actions.onOpenThread(post.id)}
        />
        <IconButton
          disabled={!canWrite || busy}
          icon={<IoCreateOutline />}
          label={writeHint ?? "Reply"}
          onClick={() => actions.onReply(post.id, post.realm)}
        />
        <IconButton
          disabled={!canWrite || busy}
          icon={<IoBookmarkOutline />}
          label={writeHint ?? "Toggle bookmark"}
          onClick={() => actions.onBookmark(post.id)}
        />
      </footer>
    </article>
  );
};

export const ComposeDialog = ({
  parent,
  realm,
  body,
  onChange,
  onCancel,
  onSubmit,
  busy,
  error,
  maxBytes,
}: {
  parent: PostId | null;
  realm: string | null;
  body: string;
  onChange: (body: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
  busy: boolean;
  error: string | null;
  maxBytes: number;
}) => {
  const bytes = useMemo(() => new TextEncoder().encode(body).length, [body]);
  const tooLong = bytes > maxBytes;
  return (
    <section aria-labelledby="taggr-compose-title" className="nt-panel taggr-compose">
      <header className="taggr-compose-head">
        <h2 className="nt-section-heading" id="taggr-compose-title">
          {parent === null ? "New post" : `Reply to #${parent}`}
        </h2>
        {realm ? (
          <span className="nt-tag" title="This post goes into that realm">
            {realm}
          </span>
        ) : null}
        <span className="nt-meta">costs 2 credits</span>
        <span className="taggr-spacer" />
        <IconButton icon={<IoCloseOutline />} label="Discard this draft" onClick={onCancel} />
      </header>
      <label className="nt-field">
        <span className="nt-sr-only">Post body</span>
        <textarea
          autoFocus
          className="nt-textarea taggr-compose-input"
          onChange={(event) => onChange(event.target.value)}
          placeholder="Markdown. @handles and #tags become links."
          rows={6}
          value={body}
        />
      </label>
      {error ? (
        <p className="nt-alert nt-alert--danger" role="alert">
          {error}
        </p>
      ) : null}
      <div className="taggr-compose-foot">
        <span className={cx("nt-meta", { "nt-error": tooLong })}>
          {compactCount(bytes)} / {compactCount(maxBytes)} bytes
        </span>
        <span className="taggr-spacer" />
        <button
          className="nt-button nt-button--sm"
          disabled={busy || tooLong || body.trim().length === 0}
          onClick={onSubmit}
          type="button"
        >
          {busy ? "Publishing…" : "Publish to Taggr"}
        </button>
      </div>
    </section>
  );
};

export const ProfileHeader = ({
  profile,
  isSelf,
  canWrite,
  busy,
  onFollow,
}: {
  profile: TaggrUser;
  isSelf: boolean;
  canWrite: boolean;
  busy: boolean;
  onFollow: (id: UserId) => void;
}) => (
  <section className="nt-section taggr-profile">
    <header className="nt-section-header">
      <HandleAvatar handle={profile.name} />
      <h2 className="nt-section-heading">@{profile.name}</h2>
      {profile.stalwart ? <span className="nt-tag nt-tag--success">stalwart</span> : null}
      {isSelf ? <span className="nt-tag">this Neutron</span> : null}
      <span className="taggr-spacer" />
      {isSelf ? null : (
        <IconButton
          disabled={!canWrite || busy}
          icon={<IoAddOutline />}
          label={canWrite ? `Follow or unfollow @${profile.name}` : "Register on Taggr to follow"}
          onClick={() => onFollow(profile.id)}
        />
      )}
    </header>
    {profile.about ? <p className="nt-text">{toPlainText(profile.about, 400)}</p> : null}
    <dl className="nt-detail-grid">
      <div className="nt-detail">
        <dt className="nt-detail-label">Posts</dt>
        <dd className="nt-detail-value">{compactCount(profile.numPosts)}</dd>
      </div>
      <div className="nt-detail">
        <dt className="nt-detail-label">Followers</dt>
        <dd className="nt-detail-value">{compactCount(profile.followers.length)}</dd>
      </div>
      <div className="nt-detail">
        <dt className="nt-detail-label">Tokens</dt>
        <dd className="nt-detail-value">{formatTokens(profile.balance)}</dd>
      </div>
      <div className="nt-detail">
        <dt className="nt-detail-label">Credits</dt>
        <dd className="nt-detail-value">{compactCount(profile.credits)}</dd>
      </div>
    </dl>
  </section>
);

/** Taggr stores a realm logo as bare base64 PNG bytes on the realm record. */
export const RealmLogo = ({ realm }: { realm: Realm }) => {
  const source = realmLogoUrl(realm.logo);
  if (source === null) {
    return (
      <span aria-hidden="true" className="nt-settings-icon taggr-realm-fallback">
        {realm.id.slice(0, 2).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      alt=""
      className="nt-settings-icon taggr-realm-logo"
      loading="lazy"
      src={source}
    />
  );
};

export const RealmsView = ({
  realms,
  loading,
  error = null,
  canWrite,
  busy,
  onOpen,
  onToggle,
}: {
  realms: Realm[];
  loading: boolean;
  error?: string | null;
  canWrite: boolean;
  busy: boolean;
  onOpen: (realm: string) => void;
  onToggle: (realm: string) => void;
}) => {
  const [filter, setFilter] = useState("");
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle.length === 0) return realms;
    return realms.filter(
      (realm) =>
        realm.id.toLowerCase().includes(needle) ||
        realm.description.toLowerCase().includes(needle),
    );
  }, [filter, realms]);

  if (loading && realms.length === 0) {
    return <StateBlock tone="loading">Loading realms…</StateBlock>;
  }

  return (
    <div className="taggr-realms">
      <label className="nt-field taggr-filter">
        <span className="nt-sr-only">Filter realms</span>
        <input
          className="nt-input"
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter realms"
          value={filter}
        />
      </label>
      {error ? <StateBlock tone="error">{error}</StateBlock> : null}
      {visible.length === 0 ? (
        error ? null : <StateBlock tone="empty">No realm matches that filter.</StateBlock>
      ) : (
        <div className="nt-settings-list">
          {visible.map((realm) => (
            <div className="nt-settings-row taggr-realm-row" key={realm.id}>
              <RealmLogo realm={realm} />
              <span className="nt-settings-main">
                <strong className="nt-settings-title">
                  {realm.id}
                  {realm.adultContent ? (
                    <span className="nt-tag nt-tag--warning taggr-inline-tag">nsfw</span>
                  ) : null}
                </strong>
                <span className="nt-settings-description">
                  {toPlainText(realm.description, 160) || "No description"}
                </span>
              </span>
              <span className="nt-settings-meta">
                <span title="Members">{compactCount(realm.numMembers)} members</span>
                <span title="Posts">{compactCount(realm.numPosts)} posts</span>
              </span>
              <span className="nt-settings-actions">
                <IconButton
                  icon={<IoEnterOutline />}
                  label={`Open the ${realm.id} feed`}
                  onClick={() => onOpen(realm.id)}
                />
                <IconButton
                  disabled={!canWrite || busy}
                  icon={<IoAddOutline />}
                  label={
                    canWrite ? `Join or leave ${realm.id}` : "Register on Taggr to join a realm"
                  }
                  onClick={() => onToggle(realm.id)}
                />
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export const SearchView = ({
  query,
  results,
  loading,
  error = null,
  onQuery,
  onOpen,
}: {
  query: string;
  results: SearchResult[];
  loading: boolean;
  error?: string | null;
  onQuery: (value: string) => void;
  onOpen: (result: SearchResult) => void;
}) => {
  const [draft, setDraft] = useState(query);
  useEffect(() => setDraft(query), [query]);
  return (
    <div className="taggr-search">
      <div className="taggr-search-form" role="search">
        <label className="nt-field taggr-filter">
          <span className="nt-sr-only">Search Taggr</span>
          <input
            autoFocus
            className="nt-input"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Tile sandboxes do not allow native form submission.
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                onQuery(draft.trim());
              }
            }}
            placeholder="Search posts, users, realms"
            value={draft}
          />
        </label>
        <IconButton
          icon={<IoSearchOutline />}
          label="Run the search"
          onClick={() => onQuery(draft.trim())}
        />
      </div>
      {error ? <StateBlock tone="error">{error}</StateBlock> : null}
      {loading ? (
        <StateBlock tone="loading">Searching…</StateBlock>
      ) : results.length === 0 ? (
        error ? null : <StateBlock tone="empty">
          {query.length === 0 ? "Type a query and press enter." : "No matches."}
        </StateBlock>
      ) : (
        <div className="nt-settings-list">
          {results.map((result) => {
            const heading = result.result === "post"
              ? `Post #${result.id}`
              : result.result === "user"
                ? `User #${result.id}`
                : result.result === "realm"
                  ? result.genericId
                  : result.result === "tag"
                    ? `#${result.relevant}`
                    : "Unknown search result";
            const supported = ["post", "user", "realm", "tag"].includes(result.result);
            return (
              <button
                className="nt-settings-row taggr-result"
                disabled={!supported}
                key={`${result.result}-${result.genericId}-${result.id}-${result.relevant}`}
                onClick={() => onOpen(result)}
                title={supported ? `Open ${heading}` : `Unsupported result type: ${result.result}`}
                type="button"
              >
                <span className="nt-settings-main">
                  <strong className="nt-settings-title">{heading}</strong>
                  {result.result !== "tag" && result.relevant ? (
                    <span className="nt-settings-description">
                      {toPlainText(result.relevant, 200)}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

const IdentitySection = ({
  settings,
  me,
  identityError,
  busy,
  revealed,
  onReveal,
  onHide,
  onImport,
  onReset,
}: {
  settings: TileSettings;
  me: TaggrUser | null;
  identityError: string | null;
  busy: boolean;
  /** The key, once the owner has asked to see it. Never held otherwise. */
  revealed: string | null;
  onReveal: () => void;
  onHide: () => void;
  onImport: (backup: string) => void;
  onReset: () => void;
}) => {
  const [backup, setBackup] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    setBackup("");
    setConfirmReset(false);
  }, [settings.principal]);

  return (
    <section className="nt-section">
      <header className="nt-section-header">
        <h2 className="nt-section-heading">Identity</h2>
        <span className="nt-tag">{settings.network === "local" ? "local" : "IC"}</span>
      </header>
      <dl className="nt-detail-grid">
        <div className="nt-detail">
          <dt className="nt-detail-label">Taggr account</dt>
          <dd className="nt-detail-value">
            {identityError ? "unavailable" : me ? `@${me.name}` : "not registered"}
          </dd>
        </div>
        <div className="nt-detail">
          <dt className="nt-detail-label">Posts as</dt>
          <dd className="nt-detail-value">
            <span title={settings.principal}>{shortPrincipal(settings.principal)}</span>
            <button
              aria-label="Copy this installation's Taggr principal"
              className="nt-icon-button taggr-inline-copy"
              onClick={() => void copyToClipboard(settings.principal)}
              title="Copy this installation's Taggr principal"
              type="button"
            >
              <IoCopyOutline />
            </button>
          </dd>
        </div>
        <div className="nt-detail">
          <dt className="nt-detail-label">Credits</dt>
          <dd className="nt-detail-value">{me && !identityError ? compactCount(me.credits) : "—"}</dd>
        </div>
        <div className="nt-detail">
          <dt className="nt-detail-label">Tokens</dt>
          <dd className="nt-detail-value">{me && !identityError ? formatTokens(me.balance) : "—"}</dd>
        </div>
      </dl>
      {identityError ? (
        <p className="nt-alert nt-alert--warning" role="status">
          Could not read the Taggr account: {identityError}
        </p>
      ) : null}
      <p className="nt-text taggr-note">
        This app holds its own key and signs Taggr calls with it, so the account
        above is not your Neutron&rsquo;s principal.{" "}
        {settings.stored ? (
          <>
            The key is kept in this app&rsquo;s own memory in your Neutron, so
            clearing site data does not lose it. Export a backup anyway if you
            want the account usable from another client &mdash; Taggr&rsquo;s
            principal-change flow needs the old key to authorise a move.
          </>
        ) : (
          <>
            It has not been saved to your Neutron yet, so right now it exists
            only in this browser and clearing site data would lose it. Export a
            backup.
          </>
        )}
      </p>
      {settings.storageError ? (
        <p className="nt-alert nt-alert--warning" role="status">
          {settings.storageError}
        </p>
      ) : null}

      <div className="nt-form-grid nt-form-grid--two">
        <div className="nt-field">
          <span className="nt-label">Backup</span>
          {revealed === null ? (
            <>
              <button
                className="nt-button nt-button--sm"
                disabled={busy}
                onClick={onReveal}
                type="button"
              >
                Show identity backup
              </button>
              <span className="nt-help">
                Anyone holding this string can post as this account. Keep it
                somewhere only you can read.
              </span>
            </>
          ) : (
            <>
              <div className="nt-copy-field taggr-backup">
                <input
                  aria-label="Taggr identity backup"
                  className="nt-input"
                  onFocus={(event) => event.currentTarget.select()}
                  readOnly
                  spellCheck={false}
                  value={revealed}
                />
                {/*
                  The clipboard write has to be the first thing this handler
                  does: the kernel only accepts it from a focused tile while the
                  browser still reports transient user activation, so anything
                  awaited first would be rejected.
                */}
                <button
                  className="nt-button nt-button--sm"
                  onClick={() => void copyToClipboard(revealed)}
                  type="button"
                >
                  Copy
                </button>
              </div>
              <button
                className="nt-button nt-button--sm nt-button--ghost"
                onClick={onHide}
                type="button"
              >
                Hide it again
              </button>
            </>
          )}
        </div>
        <label className="nt-field">
          <span className="nt-label">Restore</span>
          <input
            className="nt-input"
            onChange={(event) => setBackup(event.target.value)}
            placeholder="paste an identity backup"
            spellCheck={false}
            value={backup}
          />
          <button
            className="nt-button nt-button--sm nt-button--secondary"
            disabled={busy || backup.trim().length === 0}
            onClick={() => {
              onImport(backup.trim());
            }}
            type="button"
          >
            Restore this identity
          </button>
        </label>
      </div>

      <div className="taggr-reservations">
        {confirmReset ? (
          <>
            <span className="nt-error">
              A new key means a new Taggr account. The current one stays on the
              network but this installation can no longer post as it.
            </span>
            <button
              className="nt-button nt-button--sm nt-button--danger"
              disabled={busy}
              onClick={() => {
                setConfirmReset(false);
                onReset();
              }}
              type="button"
            >
              Replace the key
            </button>
            <button
              className="nt-button nt-button--sm nt-button--ghost"
              onClick={() => setConfirmReset(false)}
              type="button"
            >
              Keep it
            </button>
          </>
        ) : (
          <button
            className="nt-button nt-button--sm nt-button--ghost"
            disabled={busy}
            onClick={() => setConfirmReset(true)}
            type="button"
          >
            Start a new identity
          </button>
        )}
      </div>
    </section>
  );
};

export const SettingsView = ({
  settings,
  me,
  identityError = null,
  stats,

  busy,
  onConfigure,
  onRegister,
  onValidateName,
  onQuote,
  onRegisterWithIcp,
  quote,
  onRevealIdentity,
  onHideIdentity,
  onImportIdentity,
  onResetIdentity,
  revealedIdentity,
}: {
  settings: TileSettings;
  me: TaggrUser | null;
  identityError?: string | null;
  stats: TaggrStats | null;

  busy: boolean;
  onConfigure: (input: { canister: string; domain: string | null }) => void;
  onRegister: (name: string, invite: string) => void;
  onValidateName: (name: string) => Promise<string | null>;
  onQuote: () => void;
  onRegisterWithIcp: (name: string) => void;
  quote: RegistrationQuote | null;
  onRevealIdentity: () => void;
  onHideIdentity: () => void;
  onImportIdentity: (backup: string) => void;
  onResetIdentity: () => void;
  revealedIdentity: string | null;
}) => {
  const [canister, setCanister] = useState(settings.canister);
  // The empty string means "follow the deployment", which is `domain: null` on
  // the wire; a name means the owner pinned it.
  const [domain, setDomain] = useState(settings.domainPinned ? settings.domain : "");
  const active = findDomain(settings.domains, domain || settings.domain);
  const [name, setName] = useState("");
  const [invite, setInvite] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const nameValidation = useRef(0);

  useEffect(() => {
    setCanister(settings.canister);
    setDomain(settings.domainPinned ? settings.domain : "");
  }, [settings.canister, settings.domain, settings.domainPinned]);

  useEffect(() => {
    // An in-flight reply belongs to the deployment and identity it checked.
    // It cannot decide whether a handle is valid for their replacement.
    nameValidation.current += 1;
    setNameError(null);
    return () => { nameValidation.current += 1; };
  }, [settings.canister, settings.principal]);

  const unchanged =
    canister === settings.canister &&
    domain === (settings.domainPinned ? settings.domain : "");

  return (
    <div className="taggr-settings">
      <IdentitySection
        busy={busy}
        identityError={identityError}
        me={me}
        onHide={onHideIdentity}
        onImport={onImportIdentity}
        onReset={onResetIdentity}
        onReveal={onRevealIdentity}
        revealed={revealedIdentity}
        settings={settings}
      />

      {me === null && identityError === null ? (
        <section className="nt-section">
          <header className="nt-section-header">
            <h2 className="nt-section-heading">Register on Taggr</h2>
          </header>
          <p className="nt-text">
            Taggr charges one thousand credits&rsquo; worth of ICP for a new
            account, or accepts an invite code instead. Pick a handle, then
            choose how to pay for it.
          </p>
          <label className="nt-field">
            <span className="nt-label">Handle</span>
            <input
              aria-invalid={nameError !== null || undefined}
              className="nt-input"
              maxLength={16}
              onBlur={() => {
                const validation = ++nameValidation.current;
                if (name.length === 0) {
                  setNameError(null);
                  return;
                }
                void onValidateName(name)
                  .then((result) => {
                    if (nameValidation.current === validation) setNameError(result);
                  })
                  .catch((cause: unknown) => {
                    if (nameValidation.current === validation) setNameError(errorMessage(cause));
                  });
              }}
              onChange={(event) => {
                nameValidation.current += 1;
                setNameError(null);
                setName(event.target.value.trim());
              }}
              placeholder="2-16 letters and digits"
              value={name}
            />
            {nameError ? <span className="nt-error">{nameError}</span> : null}
          </label>

          <div className="taggr-register-routes">
            <div className="nt-field taggr-register-route">
              <span className="nt-label">Pay with Wallet</span>
              <span className="nt-help">
                {quote === null
                  ? "Reads Taggr's current price, then opens Wallet to review and pay it."
                  : quote.paid
                    ? "Taggr already has a paid invoice for this identity; registering will use it."
                    : `Taggr wants ${formatTokens(Number(quote.amountAtoms))} ICP. Wallet shows the destination and amount before anything moves.`}
              </span>
              <div className="taggr-register-actions">
                {quote === null ? (
                  <button
                    className="nt-button nt-button--sm nt-button--secondary"
                    disabled={busy}
                    onClick={onQuote}
                    type="button"
                  >
                    Check the price
                  </button>
                ) : (
                  <button
                    className="nt-button nt-button--sm"
                    disabled={busy || name.length < 2 || nameError !== null}
                    onClick={() => onRegisterWithIcp(name)}
                    type="button"
                  >
                    {busy
                      ? "Waiting for Wallet…"
                      : quote.paid
                        ? "Register with the paid invoice"
                        : `Pay ${formatTokens(Number(quote.amountAtoms))} ICP and register`}
                  </button>
                )}
              </div>
            </div>

            <label className="nt-field taggr-register-route">
              <span className="nt-label">Or use an invite code</span>
              <input
                className="nt-input"
                onChange={(event) => setInvite(event.target.value.trim())}
                placeholder="invite code from another Taggr user"
                value={invite}
              />
              <div className="taggr-register-actions">
                <button
                  className="nt-button nt-button--sm nt-button--secondary"
                  disabled={busy || name.length < 2 || nameError !== null || invite.length === 0}
                  onClick={() => onRegister(name, invite)}
                  type="button"
                >
                  Register with the invite
                </button>
              </div>
            </label>
          </div>

          <p className="nt-text taggr-note">
            Wallet owns the payment. This app names the invoice account and the
            amount; Wallet shows both, and the transfer happens under its
            authority, never this app&rsquo;s.
          </p>
        </section>
      ) : null}

      <section className="nt-section">
        <header className="nt-section-header">
          <h2 className="nt-section-heading">Network</h2>
        </header>
        <div className="nt-form-grid nt-form-grid--two">
          <label className="nt-field">
            <span className="nt-label">Taggr canister</span>
            <input
              className="nt-input"
              onChange={(event) => setCanister(event.target.value.trim())}
              spellCheck={false}
              value={canister}
            />
            <span className="nt-help">
              Mainnet is 6qfxa-ryaaa-aaaai-qbhsq-cai. Point this at another
              deployment to browse a local or staging Taggr.
            </span>
          </label>
          <label className="nt-field">
            <span className="nt-label">Reading as</span>
            <select
              className="nt-input"
              onChange={(event) => setDomain(event.target.value)}
              value={domain}
            >
              <option value="">
                Follow this deployment ({settings.domain})
              </option>
              {settings.domains.map((option) => (
                <option key={option.name} value={option.name}>
                  {option.name}
                </option>
              ))}
            </select>
            <span className="nt-help">
              Taggr serves one canister under many hostnames, and each one shows
              a different slice: its own realm list and its own downvote limit.
              A browser front end uses the hostname it was opened from; this app
              follows the deployment&rsquo;s canonical domain unless you pick
              one.
              {active ? ` Now: ${describeDomain(active)}.` : null}
            </span>
          </label>
        </div>
        <button
          className="nt-button nt-button--sm"
          disabled={busy || unchanged || canister.length === 0}
          onClick={() => onConfigure({ canister, domain: domain || null })}
          type="button"
        >
          Save network settings
        </button>
      </section>

      {stats ? (
        <section className="nt-section">
          <header className="nt-section-header">
            <h2 className="nt-section-heading">Network</h2>
            <span className="nt-section-count">{compactCount(stats.users)} users</span>
          </header>
          <dl className="nt-detail-grid">
            <div className="nt-detail">
              <dt className="nt-detail-label">Posts</dt>
              <dd className="nt-detail-value">{compactCount(stats.posts)}</dd>
            </div>
            <div className="nt-detail">
              <dt className="nt-detail-label">Realms</dt>
              <dd className="nt-detail-value">{compactCount(stats.realms)}</dd>
            </div>
            <div className="nt-detail">
              <dt className="nt-detail-label">Online</dt>
              <dd className="nt-detail-value">{compactCount(stats.usersOnline)}</dd>
            </div>
          </dl>
        </section>
      ) : null}
    </div>
  );
};
