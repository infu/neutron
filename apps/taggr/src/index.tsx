import { findDomain } from "./domain.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { cx, nt } from "neutron-design-system";
import { onAppStateChange, onTileViewRequest } from "neutron-tools/app";
import {
  IoArrowBackOutline,
  IoCloseOutline,
  IoCreateOutline,
  IoFlameOutline,
  IoGlobeOutline,
  IoPersonCircleOutline,
  IoPersonOutline,
  IoRefreshOutline,
  IoSearchOutline,
  IoSettingsOutline,
  IoSparklesOutline,
} from "react-icons/io5";
import {
  addPost,
  browseRealms,
  conversation as loadConversation,
  domains as loadDomains,
  feed as loadFeed,
  FEED_PAGE_SIZE,
  MAX_POST_BYTES,
  postsByIds,
  react as sendReaction,
  recentTags,
  search as runSearch,
  stats as loadStats,
  tagFeed,
  toggleBookmark,
  toggleFollowingUser,
  toggleRealmMembership,
  user as loadUser,
  userPosts as loadUserPosts,
  type FeedMode,
} from "./taggr_api.ts";
import {
  configure,
  exportIdentity,
  importIdentity,
  installTileTransport,
  loadTileSettings,
  register,
  registerWithIcp,
  registrationQuote,
  resetIdentity,
  validateHandle,
  type RegistrationQuote,
  type TileSettings,
} from "./tile_client.ts";
import type {
  FeedEntry,
  PostId,
  Realm,
  SearchResult,
  TaggrStats,
  TaggrUser,
  UserId,
} from "./model.ts";
import type { MarkdownActions } from "./markdown.tsx";
import {
  ComposeDialog,
  IconButton,
  PostRow,
  ProfileHeader,
  RealmsView,
  SearchView,
  SettingsView,
  StateBlock,
  type PostActions,
} from "./ui.tsx";
import { errorMessage } from "./format.ts";
import "./style.scss";

type View =
  | { kind: "feed"; mode: FeedMode; realm: string | null }
  | { kind: "tags"; tags: string[] }
  | { kind: "thread"; id: PostId }
  | { kind: "realms" }
  | { kind: "search" }
  | { kind: "profile"; handle: string | null }
  | { kind: "settings" };

type Composer = { id: number; parent: PostId | null; realm: string | null; body: string };

let composerId = 0;
const draft = (parent: PostId | null = null, realm: string | null = null): Composer => ({ id: ++composerId, parent, realm, body: "" });

const HOT: View = { kind: "feed", mode: "hot", realm: null };
const NEW: View = { kind: "feed", mode: "new", realm: null };
const MINE: View = { kind: "feed", mode: "personal", realm: null };

const viewTitle = (view: View, me: TaggrUser | null): string => {
  switch (view.kind) {
    case "feed":
      if (view.realm) return view.realm;
      return view.mode === "hot" ? "Hot" : view.mode === "new" ? "New" : "For me";
    case "tags":
      return view.tags.map((tag) => `#${tag}`).join(" ");
    case "thread":
      return `Thread #${view.id}`;
    case "realms":
      return "Realms";
    case "search":
      return "Search";
    case "profile":
      return view.handle ? `@${view.handle}` : me ? `@${me.name}` : "Profile";
    case "settings":
      return "Settings";
    default:
      return "Taggr";
  }
};

export const App = () => {
  const [settings, setSettings] = useState<TileSettings | null>(null);
  const [me, setMe] = useState<TaggrUser | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [bootstrapRetry, setBootstrapRetry] = useState(0);
  const [view, setView] = useState<View>(HOT);
  const [entries, setEntries] = useState<FeedEntry[]>([]);
  const [realms, setRealms] = useState<Realm[]>([]);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [profile, setProfile] = useState<TaggrUser | null>(null);
  const [tags, setTags] = useState<Array<{ tag: string; weight: number }>>([]);
  const [stats, setStats] = useState<TaggrStats | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [composer, setComposer] = useState<Composer | null>(null);
  const composerRef = useRef(composer);
  composerRef.current = composer;
  const [composeError, setComposeError] = useState<string | null>(null);
  const [revealedIdentity, setRevealedIdentity] = useState<string | null>(null);
  const [quote, setQuote] = useState<RegistrationQuote | null>(null);
  const [reload, setReload] = useState(0);
  // Only the newest in-flight view load may write to state; a slow reply from an
  // abandoned view must not overwrite the current one.
  const requestId = useRef(0);
  const writeInFlight = useRef(false);
  const revealRequest = useRef(0);
  const loadedView = useRef("");

  const canWrite = me !== null;
  // The background resolves the hostname — it knows the deployment's own
  // canonical domain — so until settings arrive there is nothing to read under.
  const domain = settings?.domain ?? "";
  const domainConfig = useMemo(
    () => (settings ? findDomain(settings.domains, settings.domain) : null),
    [settings],
  );

  const openProfile = useCallback((handle: string) => {
    setView({ kind: "profile", handle });
  }, []);

  const openTag = useCallback((tag: string) => {
    setView({ kind: "tags", tags: [tag] });
  }, []);

  const markdownActions = useMemo<MarkdownActions>(
    () => ({ onUser: openProfile, onTag: openTag }),
    [openProfile, openTag],
  );

  const refreshIdentity = useCallback(async (activeDomain: string) => {
    try {
      const person = await loadUser(activeDomain, null);
      setMe(person);
      setIdentityError(null);
      return person;
    } catch (cause) {
      setIdentityError(errorMessage(cause));
      return null;
    }
  }, []);

  /* ---- bootstrap ---- */

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        // Every Taggr call from the tile is forwarded to the resident
        // background, which owns the identity and the network client.
        installTileTransport();
        const loaded = await loadTileSettings();
        if (cancelled) return;
        setSettings(loaded);
        const [person, statsValue] = await Promise.allSettled([
          loadUser(loaded.domain, null),
          loadStats(),
        ]);
        if (cancelled) return;
        if (person.status === "fulfilled") { setMe(person.value); setIdentityError(null); }
        else setIdentityError(errorMessage(person.reason));
        if (statsValue.status === "fulfilled") setStats(statsValue.value);
      } catch (cause: unknown) {
        if (!cancelled) {
          setError(errorMessage(cause));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bootstrapRetry]);

  // The resident background publishes a revision after it writes, so a post made
  // by an agent shows up here without polling.
  useEffect(
    () => onAppStateChange("taggr", () => setReload((value) => value + 1)),
    [],
  );

  useEffect(
    () =>
      onTileViewRequest((requested) => {
        if (requested === "compose") setComposer((current) => current ?? draft());
        else if (requested === "hot") setView(HOT);
        else if (requested === "new") setView(NEW);
        else if (requested === "realms") setView({ kind: "realms" });
        else if (requested === "search") setView({ kind: "search" });
        else if (requested === "settings") setView({ kind: "settings" });
      }),
    [],
  );

  /* ---- view loading ---- */

  const load = useCallback(
    async (nextPage: number, append: boolean) => {
      if (!settings || view.kind === "settings") return;
      const id = (requestId.current += 1);
      const isCurrent = () => id === requestId.current;
      setLoading(true);
      setError(null);
      try {
        switch (view.kind) {
          case "feed": {
            const items = await loadFeed({
              domain,
              mode: view.mode,
              realm: view.realm,
              page: nextPage,
            });
            if (!isCurrent()) return;
            setEntries((current) => (append ? [...new Map([...current, ...items].map((entry) => [entry.post.id, entry])).values()] : items));
            setMore(items.length >= FEED_PAGE_SIZE);
            break;
          }
          case "tags": {
            const items = await tagFeed({ domain, tags: view.tags, page: nextPage });
            if (!isCurrent()) return;
            setEntries((current) => (append ? [...new Map([...current, ...items].map((entry) => [entry.post.id, entry])).values()] : items));
            setMore(items.length >= FEED_PAGE_SIZE);
            break;
          }
          case "thread": {
            // Taggr splits a conversation in two: `thread` is the ancestor
            // chain and a post carries only the ids of its replies.
            const { entries: items } = await loadConversation(view.id);
            if (!isCurrent()) return;
            setEntries(items);
            setMore(false);
            break;
          }
          case "realms": {
            const items = await browseRealms({ domain });
            if (!isCurrent()) return;
            setRealms(items);
            setMore(false);
            break;
          }
          case "search": {
            const trimmed = query.trim();
            const items = trimmed.length === 0 ? [] : await runSearch(domain, trimmed);
            if (!isCurrent()) return;
            setResults(items);
            setMore(false);
            break;
          }
          case "profile": {
            const person = await loadUser(domain, view.handle);
            if (!isCurrent()) return;
            setProfile(person);
            const handle = view.handle ?? person?.name ?? null;
            const posts = handle
              ? await loadUserPosts({ domain, handle, page: nextPage })
              : [];
            if (!isCurrent()) return;
            setEntries((current) => (append ? [...new Map([...current, ...posts].map((entry) => [entry.post.id, entry])).values()] : posts));
            setMore(posts.length >= FEED_PAGE_SIZE);
            break;
          }
          default:
            break;
        }
        if (isCurrent()) setPage(nextPage);
      } catch (cause: unknown) {
        if (isCurrent()) setError(errorMessage(cause));
      } finally {
        if (isCurrent()) setLoading(false);
      }
    },
    [domain, query, settings, view],
  );

  useEffect(() => {
    const key = JSON.stringify({ view, domain, canister: settings?.canister, principal: settings?.principal, query });
    if (loadedView.current !== key) {
      loadedView.current = key;
      setEntries([]);
      setProfile(null);
      setResults([]);
      setRealms([]);
      setTags([]);
      setMore(false);
      setError(null);
    }
    setPage(0);
    void load(0, false);
    return () => { requestId.current += 1; };
  }, [load, reload]);

  // Navigating away from Settings drops the revealed key out of tile memory.
  useEffect(() => {
    if (view.kind !== "settings") { revealRequest.current += 1; setRevealedIdentity(null); }
  }, [view.kind]);

  useEffect(() => {
    if (!settings || view.kind !== "feed") return;
    let cancelled = false;
    void (async () => {
      try {
        const values = await recentTags({ domain, realm: view.realm, limit: 24 });
        if (!cancelled) setTags(values);
      } catch {
        // Trending tags are decoration; their failure must not blank the feed.
        if (!cancelled) setTags([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [domain, settings, view, reload]);

  /* ---- actions ---- */

  const refreshPost = useCallback(async (id: PostId) => {
    try {
      const [updated] = await postsByIds([id]);
      if (!updated) return;
      setEntries((current) =>
        current.map((entry) => (entry.post.id === id ? updated : entry)),
      );
    } catch {
      // A stale reaction count is a smaller failure than dropping the feed.
    }
  }, []);

  const runWrite = useCallback(
    async (action: () => Promise<string | null>) => {
      if (writeInFlight.current) return;
      writeInFlight.current = true;
      setBusy(true);
      setError(null);
      try {
        const message = await action();
        if (message) setNotice(message);
      } catch (cause: unknown) {
        setError(errorMessage(cause));
      } finally {
        writeInFlight.current = false;
        setBusy(false);
      }
    },
    [],
  );

  const postActions = useMemo<PostActions>(
    () => ({
      markdown: markdownActions,
      onOpenThread: (id) => setView({ kind: "thread", id }),
      onOpenRealm: (realm) => setView({ kind: "feed", mode: "new", realm }),
      onReply: (id, realm) => { setComposeError(null); setComposer(draft(id, realm)); },
      onReact: (id, reaction) =>
        void runWrite(async () => {
          await sendReaction(id, reaction);
          await refreshPost(id);
          return null;
        }),
      onBookmark: (id) =>
        void runWrite(async () => {
          const added = await toggleBookmark(id);
          return added ? `Bookmarked #${id}` : `Removed the bookmark on #${id}`;
        }),
    }),
    [markdownActions, refreshPost, runWrite],
  );

  const onPublish = useCallback(async () => {
    if (!composer || writeInFlight.current) return;
    writeInFlight.current = true;
    const submitted = composer;
    setBusy(true);
    setComposeError(null);
    try {
      const id = await addPost({
        body: composer.body,
        parent: composer.parent,
        realm: composer.realm,
      });
      setComposer((current) => current === submitted ? null : current);
      setNotice(`Published post #${id}`);
      setReload((value) => value + 1);
    } catch (cause: unknown) {
      if (composerRef.current?.id === submitted.id) setComposeError(errorMessage(cause));
      else setError(`The earlier post could not be confirmed: ${errorMessage(cause)}`);
    } finally {
      writeInFlight.current = false;
      setBusy(false);
    }
  }, [composer]);

  const onConfigure = useCallback(
    (input: { canister: string; domain: string | null }) =>
      void runWrite(async () => {
        const updated = await configure(input);
        setSettings(updated);
        setMe(null);
        setQuote(null);
        setRevealedIdentity(null);
        await refreshIdentity(updated.domain);
        const statsValue = await loadStats().catch(() => null);
        if (statsValue) setStats(statsValue);
        setReload((value) => value + 1);
        return `Now reading ${updated.domain}`;
      }),
    [refreshIdentity, runWrite],
  );

  const onRegister = useCallback(
    (name: string, invite: string) =>
      void runWrite(async () => {
        await register(name, invite);
        const person = await refreshIdentity(domain);
        return person ? `Registered as @${person.name}` : "Registration submitted";
      }),
    [domain, refreshIdentity, runWrite],
  );

  // The kernel accepts a clipboard write only from a focused tile with live
  // transient user activation, and the backup has to be fetched from the
  // background first. So revealing and copying are two steps: this one fetches
  // it into a readonly field, and the field's own copy button writes the
  // clipboard synchronously inside its handler.
  const onQuote = useCallback(
    () =>
      void runWrite(async () => {
        const value = await registrationQuote();
        setQuote(value);
        return value.paid
          ? "Taggr already has a paid invoice for this identity."
          : null;
      }),
    [runWrite],
  );

  const onRegisterWithIcp = useCallback(
    (name: string) =>
      void runWrite(async () => {
        // Wallet opens its own tile, shows the destination and amount, and moves
        // the value; this resolves once it has settled.
        await registerWithIcp(name);
        const person = await refreshIdentity(domain);
        setQuote(null);
        return person ? `Registered as @${person.name}` : "Registration submitted";
      }),
    [domain, refreshIdentity, runWrite],
  );

  const onRevealIdentity = useCallback(
    () =>
      void runWrite(async () => {
        const request = ++revealRequest.current;
        const backup = await exportIdentity();
        if (request !== revealRequest.current) return null;
        setRevealedIdentity(backup);
        return "Anyone holding this string can post as this account.";
      }),
    [runWrite],
  );

  const onHideIdentity = useCallback(() => { revealRequest.current += 1; setRevealedIdentity(null); }, []);

  const refreshChangedIdentity = useCallback(async (principal: string) => {
    revealRequest.current += 1;
    setRevealedIdentity(null);
    setQuote(null);
    setMe(null);
    setSettings((current) => current ? { ...current, principal } : current);
    let activeDomain = domain;
    try {
      const updated = await loadTileSettings();
      setSettings(updated);
      activeDomain = updated.domain;
    } catch (cause) {
      setError(`Identity changed, but settings could not be refreshed: ${errorMessage(cause)}`);
    }
    await refreshIdentity(activeDomain);
    setReload((value) => value + 1);
  }, [domain, refreshIdentity]);

  const onImportIdentity = useCallback(
    (backup: string) =>
      void runWrite(async () => {
        const principal = await importIdentity(backup);
        await refreshChangedIdentity(principal);
        return `Now posting as ${principal}`;
      }),
    [refreshChangedIdentity, runWrite],
  );

  const onResetIdentity = useCallback(
    () =>
      void runWrite(async () => {
        const principal = await resetIdentity();
        await refreshChangedIdentity(principal);
        return `New identity ${principal}`;
      }),
    [refreshChangedIdentity, runWrite],
  );

  const onToggleRealm = useCallback(
    (realm: string) =>
      void runWrite(async () => {
        const joined = await toggleRealmMembership(realm);
        return joined ? `Joined ${realm}` : `Left ${realm}`;
      }),
    [runWrite],
  );

  const onToggleFollow = useCallback(
    (userId: UserId) =>
      void runWrite(async () => {
        const following = await toggleFollowingUser(userId);
        return following ? "Now following" : "No longer following";
      }),
    [runWrite],
  );

  /* ---- render ---- */

  const title = viewTitle(view, me);
  const showBack =
    view.kind === "thread" ||
    view.kind === "profile" ||
    view.kind === "tags" ||
    (view.kind === "feed" && view.realm !== null);
  const threadRoot = view.kind === "thread" ? view.id : null;

  return (
    <main className={cx(nt.appFill, "taggr-app")}>
      <div className="nt-page taggr-shell">
        <header className="nt-page-header taggr-bar">
          {showBack ? (
            <IconButton
              icon={<IoArrowBackOutline />}
              label="Back to the hot feed"
              onClick={() => setView(HOT)}
            />
          ) : null}
          <h1 className="nt-title taggr-title" title={title}>
            {title}
          </h1>
          <span className="taggr-spacer" />
          <nav aria-label="Taggr views" className="taggr-nav">
            <IconButton
              active={view.kind === "feed" && view.mode === "hot" && view.realm === null}
              icon={<IoFlameOutline />}
              label="Hot posts"
              onClick={() => setView(HOT)}
            />
            <IconButton
              active={view.kind === "feed" && view.mode === "new" && view.realm === null}
              icon={<IoSparklesOutline />}
              label="Newest posts"
              onClick={() => setView(NEW)}
            />
            <IconButton
              active={view.kind === "feed" && view.mode === "personal"}
              disabled={!canWrite}
              icon={<IoPersonOutline />}
              label={
                canWrite
                  ? "Your personal feed"
                  : "Register this Neutron on Taggr for a personal feed"
              }
              onClick={() => setView(MINE)}
            />
            <IconButton
              active={view.kind === "realms"}
              icon={<IoGlobeOutline />}
              label="Browse realms"
              onClick={() => setView({ kind: "realms" })}
            />
            <IconButton
              active={view.kind === "search"}
              icon={<IoSearchOutline />}
              label="Search Taggr"
              onClick={() => setView({ kind: "search" })}
            />
            <IconButton
              disabled={!canWrite}
              icon={<IoCreateOutline />}
              label={canWrite ? "Write a post" : "Register this Neutron on Taggr to post"}
              onClick={() => setComposer((current) => current ?? draft())}
            />
            <IconButton
              active={view.kind === "profile"}
              icon={<IoPersonCircleOutline />}
              label={me ? `Your profile, @${me.name}` : "Your profile"}
              onClick={() => setView({ kind: "profile", handle: me?.name ?? null })}
            />
            <IconButton
              icon={<IoRefreshOutline />}
              label="Reload from Taggr"
              onClick={() => { if (!settings || view.kind === "settings" || identityError) setBootstrapRetry((value) => value + 1); else setReload((value) => value + 1); }}
            />
            <IconButton
              active={view.kind === "settings"}
              icon={<IoSettingsOutline />}
              label="Settings"
              onClick={() => setView({ kind: "settings" })}
            />
          </nav>
        </header>

        <div className="nt-page-main taggr-main">
          {notice ? (
            <p className="nt-alert nt-alert--success taggr-flash">
              <span>{notice}</span>
              <span className="taggr-spacer" />
              <IconButton
                icon={<IoCloseOutline />}
                label="Dismiss this message"
                onClick={() => setNotice(null)}
              />
            </p>
          ) : null}

          {error ? (
            <p className="nt-alert nt-alert--danger" role="alert">
              {error}
            </p>
          ) : null}

          {composer ? (
            <ComposeDialog
              body={composer.body}
              busy={busy}
              error={composeError}
              maxBytes={MAX_POST_BYTES}
              onCancel={() => {
                setComposer(null);
                setComposeError(null);
              }}
              onChange={(body) => setComposer({ ...composer, body })}
              onSubmit={() => void onPublish()}
              parent={composer.parent}
              realm={composer.realm}
            />
          ) : null}

          {!settings ? (
            error ? null : <StateBlock tone="loading">Loading app settings…</StateBlock>
          ) : view.kind === "settings" ? (
            <SettingsView
              busy={busy}
              me={me}
              identityError={identityError}
              onConfigure={onConfigure}
              onHideIdentity={onHideIdentity}
              onImportIdentity={onImportIdentity}
              onRegister={onRegister}
              onResetIdentity={onResetIdentity}
              onRevealIdentity={onRevealIdentity}
              onQuote={onQuote}
              onRegisterWithIcp={onRegisterWithIcp}
              onValidateName={validateHandle}
              quote={quote}
              revealedIdentity={revealedIdentity}
              settings={settings}
              stats={stats}
            />
          ) : view.kind === "search" ? (
            <SearchView
              error={error}
              loading={loading}
              onOpen={(result) => {
                if (result.result === "user") setView({ kind: "profile", handle: String(result.id) });
                else if (result.result === "realm") setView({ kind: "feed", mode: "new", realm: result.genericId });
                else if (result.result === "tag") openTag(result.relevant);
                else setView({ kind: "thread", id: result.id });
              }}
              onQuery={setQuery}
              query={query}
              results={results}
            />
          ) : view.kind === "realms" ? (
            <RealmsView
              error={error}
              busy={busy}
              canWrite={canWrite}
              loading={loading}
              onOpen={(realm) => setView({ kind: "feed", mode: "new", realm })}
              onToggle={onToggleRealm}
              realms={realms}
            />
          ) : (
            <>
              {view.kind === "profile" && profile ? (
                <ProfileHeader
                  busy={busy}
                  canWrite={canWrite}
                  isSelf={profile.principal === settings.principal}
                  onFollow={onToggleFollow}
                  profile={profile}
                />
              ) : null}

              {view.kind === "feed" && tags.length > 0 ? (
                <div aria-label="Trending tags" className="nt-tag-list taggr-tags">
                  {tags.slice(0, 18).map((entry) => (
                    <button
                      className="nt-tag taggr-tag"
                      key={entry.tag}
                      onClick={() => openTag(entry.tag)}
                      title={`Posts tagged #${entry.tag}`}
                      type="button"
                    >
                      #{entry.tag}
                    </button>
                  ))}
                </div>
              ) : null}

              {loading && entries.length === 0 ? (
                <StateBlock tone="loading">
                  Loading posts…
                </StateBlock>
              ) : entries.length === 0 && !error ? (
                <StateBlock tone="empty">
                  Nothing here. If that is unexpected, check which domain you
                  are reading as in Settings — a domain the deployment does not
                  know returns an empty feed.
                </StateBlock>
              ) : (
                <div className="taggr-feed">
                  {entries.map((entry) => (
                    <PostRow
                      actions={postActions}
                      busy={busy}
                      canWrite={canWrite}
                      domain={domainConfig}
                      entry={entry}
                      highlighted={threadRoot === entry.post.id}
                      key={entry.post.id}
                    />
                  ))}
                </div>
              )}

              {more ? (
                <button
                  className="nt-button nt-button--sm nt-button--ghost taggr-more"
                  disabled={loading}
                  onClick={() => {
                    const next = page + 1;
                    void load(next, true);
                  }}
                  type="button"
                >
                  {loading ? "Loading…" : "Load more"}
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </main>
  );
};

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element not found");
}
createRoot(container).render(<App />);
