// Nuance tile.
//
// The shell paints from the app canister's own state first -- identity, drafts,
// reading list -- which is a free query, then loads the feed straight from
// Nuance. Article reads never touch this app's backend: Nuance's read surface is
// public `query`, so the browser calls it anonymously for free rather than paying
// for a replicated round trip through the canister. Writes still go through the
// backend, which is what holds the Neutron's posting identity.

import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { requestBackendCallReservations } from "neutron-tools/app";
import {
  createApi,
  globalCaller,
  isErr,
  type AppState,
  type Bookmark,
  type FeedPage,
  type FeedRow,
  type Identity,
  type LocalIdentity,
} from "./api";
import { EditorView } from "./editor";
import { AccountView, FeedView, ReaderView } from "./views";
import { ArticleImage } from "./html";
import { count, tidyListTitle, toNumber } from "./format";
import { IconButton, StateBlock } from "./ui";
import "./style.scss";

const api = createApi(globalCaller);
const PAGE_SIZE = 20;

type View = "feed" | "reader" | "editor" | "account" | "bookmarks";

type Selection = { postId: string; bucketCanisterId: string };

function App() {
  const [view, setView] = useState<View>("feed");
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [tags, setTags] = useState<[string, string][]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const bookmarked = new Set(bookmarks.map((entry) => entry.postId));
  const [activeDraftId, setActiveDraftId] = useState<string>("");
  const [draftCount, setDraftCount] = useState(0);

  const [source, setSource] = useState("latest");
  const [searchTerm, setSearchTerm] = useState("");
  const [page, setPage] = useState<FeedPage | null>(null);
  const [feedLoading, setFeedLoading] = useState(true);
  const [feedError, setFeedError] = useState<string | null>(null);

  const [selection, setSelection] = useState<Selection | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [reading, setReading] = useState<FeedPage | null>(null);

  // Feed loads are now free queries rather than replicated updates, but the
  // ordering guards stay: a slow shard can still let an earlier response land
  // after a later one. The chain keeps at most one in flight, and the generation
  // counter means only the newest may write state -- a stale response is
  // discarded rather than overwriting the tab the reader is now looking at.
  const feedRequest = useRef(0);
  const feedChain = useRef<Promise<void>>(Promise.resolve());

  const note = useCallback((message: string) => {
    setStatus(message);
    window.setTimeout(() => setStatus((current) => (current === message ? null : current)), 4000);
  }, []);

  const applyState = useCallback((next: AppState) => {
    setIdentity({ ...next.identity, dailyAllowance: "0" });
    setBookmarks(next.bookmarks);
    setActiveDraftId(next.activeDraftId);
    setDraftCount(next.drafts.length);
  }, []);

  const loadFeed = useCallback((which: string, term: string): Promise<void> => {
    const request = feedRequest.current + 1;
    feedRequest.current = request;
    setFeedLoading(true);
    setFeedError(null);

    const run = async (): Promise<void> => {
      // Superseded before this one even started: skip the round trip.
      if (feedRequest.current !== request) return;
      const result =
        which === "search"
          ? await api.search(term, PAGE_SIZE)
          : await api.feed(which, 0, PAGE_SIZE);
      if (feedRequest.current !== request) return;
      setFeedLoading(false);
      if (isErr(result)) {
        setFeedError(result.err);
        return;
      }
      setPage(result.ok);
    };

    feedChain.current = feedChain.current.then(run, run);
    return feedChain.current;
  }, []);

  // Two independent starts, fired together: the canister's own state through the
  // kernel, and the feed straight from Nuance. Awaiting the first before starting
  // the second put a whole message-bus round trip in front of the first request
  // that actually fills the screen.
  useEffect(() => {
    void loadFeed("latest", "");
    void (async () => {
      let local: LocalIdentity | undefined;
      try {
        const next = await api.state();
        applyState(next);
        local = next.identity;
      } catch (error) {
        note(error instanceof Error ? error.message : String(error));
      }
      // Hand the snapshot over rather than making `whoami` read it again.
      const who = await api.whoami(local);
      if (!isErr(who)) setIdentity(who.ok);
    })();
  }, [applyState, loadFeed, note]);

  // Tag names are only needed by the editor's tag picker, so they are fetched
  // the first time it opens rather than on every tile open.
  useEffect(() => {
    if (view !== "editor" || tags.length > 0) return;
    void api.tags().then((result) => {
      if (!isErr(result)) setTags(result.ok);
    });
  }, [view, tags.length]);

  const refreshLocalState = useCallback(async () => {
    try {
      const next = await api.state();
      setBookmarks(next.bookmarks);
      setActiveDraftId(next.activeDraftId);
      setDraftCount(next.drafts.length);
    } catch {
      // A local snapshot failing is not worth interrupting the reader.
    }
  }, []);

  // The reading list stores only ids, so its rows are hydrated from Nuance for
  // free -- live titles and covers rather than whatever was saved.
  const loadReadingList = useCallback(async () => {
    const result = await api.readingList();
    if (isErr(result)) note(result.err);
    else setReading(result.ok);
  }, [note]);

  // Reload when the view opens, and whenever the saved set changes -- keyed on
  // the ids rather than the array, which `api.state()` replaces on every read.
  const bookmarkKey = bookmarks.map((entry) => entry.postId).join(",");
  useEffect(() => {
    if (view !== "bookmarks") return;
    void loadReadingList();
  }, [view, bookmarkKey, loadReadingList]);

  const openSource = useCallback(
    (which: string) => {
      setSource((current) => {
        if (current === which) return current;
        setSearchTerm("");
        void loadFeed(which, "");
        return which;
      });
    },
    [loadFeed],
  );

  const search = useCallback(
    (term: string) => {
      if (!term) {
        openSource("latest");
        return;
      }
      setSource("search");
      setSearchTerm(term);
      void loadFeed("search", term);
    },
    [loadFeed, openSource],
  );

  const openArticle = useCallback((row: FeedRow) => {
    setSelection({ postId: row.postId, bucketCanisterId: row.bucketCanisterId });
    setView("reader");
  }, []);

  const toggleBookmark = useCallback(
    async (row: { postId: string; bucketCanisterId: string; title: string; handle: string }) => {
      const result = await api.toggleBookmark(
        row.postId,
        row.bucketCanisterId,
        row.title,
        row.handle,
      );
      if (isErr(result)) {
        note(result.err);
        return;
      }
      note(result.ok);
      // The canister is the source of truth for the reading list, so re-read it
      // rather than guessing which way the toggle went.
      void refreshLocalState();
    },
    [note, refreshLocalState],
  );

  // Commenting and voting are sent from the canister, so a new Nuance shard needs
  // an owner-approved reservation before either works on articles it holds.
  // Reading needs nothing: that happens in this page, anonymously. The kernel
  // owns the dialog; the backend learns about the shard afterwards, as a
  // principal rather than as text.
  const grantShard = useCallback(
    async (bucket: string) => {
      try {
        await requestBackendCallReservations({
          actions: [{ kind: "reserve", scope: { kind: "principal", principal: bucket } }],
        });
        const registered = await api.registerBucket(bucket);
        note(isErr(registered) ? registered.err : registered.ok);
      } catch (error) {
        note(error instanceof Error ? error.message : String(error));
      }
    },
    [note],
  );

  const startDraft = useCallback(async () => {
    const result = await api.draftNew("", "");
    if (isErr(result)) {
      note(result.err);
      return;
    }
    if ("conflict" in result) return;
    setActiveDraftId(result.ok.id);
    setDraftCount((value) => value + 1);
    setView("editor");
  }, [note]);

  const openEditor = useCallback(async () => {
    if (activeDraftId) {
      setView("editor");
      return;
    }
    await startDraft();
  }, [activeDraftId, startDraft]);

  const revise = useCallback(
    async (postId: string, bucketCanisterId: string) => {
      const result = await api.draftLoad(postId, bucketCanisterId);
      if (isErr(result)) {
        note(result.err);
        return;
      }
      if ("conflict" in result) return;
      setActiveDraftId(result.ok.id);
      setDraftCount((value) => value + 1);
      setView("editor");
      note("Loaded into the editor. Formatting was flattened to text.");
    },
    [note],
  );

  return (
    <main className="nt-app nt-app--fill nuance-app" data-tid="nuance-tile">
      <div className="nt-page nuance-shell">
        <header className="nuance-rail">
          <span className="nuance-rail-group">
            <IconButton
              active={view === "feed"}
              label="Browse articles"
              onClick={() => setView("feed")}
              testId="nuance-rail-feed"
            >
              ◎
            </IconButton>
            <IconButton
              active={view === "bookmarks"}
              label="Reading list"
              onClick={() => setView("bookmarks")}
              badge={bookmarks.length > 0 ? String(bookmarks.length) : undefined}
            >
              ★
            </IconButton>
          </span>
          <span className="nuance-rail-title">Nuance</span>
          <span className="nuance-rail-group">
            <IconButton
              active={view === "editor"}
              label="Write or edit a draft"
              onClick={() => void openEditor()}
              testId="nuance-rail-editor"
              badge={draftCount > 0 ? String(draftCount) : undefined}
            >
              ✎
            </IconButton>
            <IconButton
              active={view === "account"}
              label="Nuance account"
              onClick={() => setView("account")}
              testId="nuance-rail-account"
            >
              ◑
            </IconButton>
          </span>
        </header>

        <div className="nuance-content" data-tid={`nuance-view-${view}`}>
          {view === "feed" ? (
            <FeedView
              bookmarked={bookmarked}
              error={feedError}
              loading={feedLoading}
              onOpen={openArticle}
              onReload={() => void loadFeed(source, searchTerm)}
              onSearch={search}
              onSource={openSource}
              onToggleBookmark={(row) => void toggleBookmark(row)}
              page={page}
              searchTerm={searchTerm}
              source={source}
            />
          ) : null}

          {view === "reader" && selection ? (
            <ReaderView
              api={api}
              bookmarked={bookmarked.has(selection.postId)}
              bucketCanisterId={selection.bucketCanisterId}
              identity={identity}
              onBack={() => setView("feed")}
              onRevise={(postId, bucket) => void revise(postId, bucket)}
              onStatus={note}
              onToggleBookmark={(article) => void toggleBookmark(article)}
              postId={selection.postId}
            />
          ) : null}

          {view === "editor" ? (
            activeDraftId ? (
              <EditorView
                key={activeDraftId}
                api={api}
                draftId={activeDraftId}
                onPublished={(url, isDraft) => {
                  note(
                    `${isDraft ? "Saved to Nuance as a draft" : "Published"}: ${url}`,
                  );
                  void refreshLocalState();
                }}
                onStatus={(message) => {
                  note(message);
                  setActiveDraftId("");
                  setDraftCount((value) => Math.max(0, value - 1));
                  setView("feed");
                }}
                tags={tags}
              />
            ) : (
              <StateBlock kind="empty">
                <button className="nt-button nt-button--sm" onClick={() => void startDraft()} type="button">
                  Start a draft
                </button>
              </StateBlock>
            )
          ) : null}

          {view === "bookmarks" ? (
            <div className="nuance-feed">
              <header className="nt-section-header">
                <h2 className="nt-section-heading">Reading list</h2>
                <span className="nt-section-count">{bookmarks.length}</span>
              </header>
              {bookmarks.length === 0 ? (
                <StateBlock kind="empty">
                  Nothing saved yet. Use the star on any article.
                </StateBlock>
              ) : reading === null ? (
                <StateBlock kind="loading">Loading your reading list…</StateBlock>
              ) : (
                <ul className="nt-settings-list nuance-rows">
                  {reading.rows.map((row) => (
                    <li className="nt-settings-row nuance-row" key={row.postId}>
                      <span aria-hidden="true" className="nuance-row-thumb">
                        <ArticleImage
                          className="nuance-row-thumb-img"
                          src={row.headerImage}
                        />
                      </span>
                      <button
                        className="nuance-row-main"
                        onClick={() => openArticle(row)}
                        type="button"
                      >
                        <strong className="nuance-row-title">
                          {tidyListTitle(row.title) || "Untitled"}
                        </strong>
                        <span className="nuance-row-meta">
                          @{row.handle}
                          {toNumber(row.wordCount) > 0
                            ? ` · ${count(row.wordCount)}w`
                            : ""}
                        </span>
                      </button>
                      <IconButton
                        active
                        label="Remove from reading list"
                        onClick={() => void toggleBookmark(row)}
                      >
                        ★
                      </IconButton>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}

          {view === "account" ? (
            <AccountView
              api={api}
              identity={identity}
              onGrantShard={grantShard}
              onIdentity={setIdentity}
              onOpen={openArticle}
              onStatus={note}
            />
          ) : null}
        </div>

        {status ? (
          <footer className="nuance-status">
            <output aria-live="polite" className="nt-result nuance-status-text" data-tid="nuance-status">
              {status}
            </output>
          </footer>
        ) : null}
      </div>
    </main>
  );
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element not found");
}
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
