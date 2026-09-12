import { useCallback, useEffect, useRef, useState } from "react";
import { dismissTray, onAppStateChange, openAppTile } from "neutron-tools/app";
import type { FeedbackClient, FeedbackThread } from "./types.ts";
import { Icon } from "./icons.tsx";
import { EmptyState, ErrorNote, KINDS, Loading, errorMessage, isoDate, relativeDate } from "./App.tsx";

export function FeedbackTray({ client }: { client: FeedbackClient }) {
  const [items, setItems] = useState<FeedbackThread[] | null>(null);
  const [unread, setUnread] = useState(0), [loading, setLoading] = useState(true), [opening, setOpening] = useState<string | null>(null), [error, setError] = useState("");
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const [session, page] = await Promise.all([client.session(), client.list({ unreadOnly: true })]);
      if (generation.current !== current) return;
      setUnread(session.unreadReplies); setItems(page.items); setError("");
    } catch (cause) { if (generation.current === current) setError(errorMessage(cause)); }
    finally { if (generation.current === current) setLoading(false); }
  }, [client]);
  useEffect(() => { void refresh(); return () => { generation.current++; }; }, [refresh]);
  useEffect(() => onAppStateChange("feedback", () => { void refresh(); }), [refresh]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); void dismissTray(); } };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);
  async function open(view?: string) {
    if (opening) return;
    const request = openAppTile({ appId: "feedback", tileId: "main", reuseExisting: true, ...(view ? { view } : {}) });
    setOpening(view ?? "all");
    try { await request; await dismissTray(); }
    catch (cause) { setError(errorMessage(cause)); setOpening(null); }
  }
  return <main className="nt-app nt-app--fill fb-tray" aria-label="Feedback replies">
    <header className="fb-tray-header"><span className="fb-brand-icon"><Icon name="feedback" /></span><div><h1>New replies{unread > 0 && <span className="fb-count">{unread > 99 ? "99+" : unread}</span>}</h1><p>Pick up the conversation.</p></div><button type="button" className="nt-icon-button" aria-label="Refresh replies" title="Refresh replies" onClick={() => void refresh()}><Icon name="refresh" /></button></header>
    <div className="fb-tray-body" aria-busy={loading}>
      {error && <ErrorNote error={error} retry={refresh} title={items ? "Showing your last update" : "Couldn’t load replies"} />}
      {loading && !items ? <Loading label="Loading replies" /> : items?.length ? <div className="fb-tray-list">{items.map(thread => <button className="fb-tray-row" type="button" key={thread.id} disabled={opening !== null} onClick={() => void open(`thread/${thread.id}`)}><span className="fb-unread-dot" /><span className="fb-tray-row-copy"><strong>{thread.title}</strong><span>{KINDS[thread.kind].short} · Support replied</span></span><time dateTime={isoDate(thread.updatedAt)}>{relativeDate(thread.updatedAt)}</time><Icon name="arrow" /></button>)}</div> : items && <EmptyState icon="check" title="You’re all caught up" detail="Replies from the support team will appear here." />}
    </div>
    <footer className="fb-tray-footer"><button type="button" className="fb-text-button" disabled={opening !== null} onClick={() => void open("new")}><Icon name="plus" />New message</button><button type="button" className="nt-button" disabled={opening !== null} onClick={() => void open()}>{opening === "all" && <span className="nt-spinner" />}Open Feedback</button></footer>
  </main>;
}
