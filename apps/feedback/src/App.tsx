import { useCallback, useEffect, useId, useRef, useState } from "react";
import { copyToClipboard, onAppStateChange, onTileViewRequest } from "neutron-tools/app";
import type { Discussion, FeedbackClient, FeedbackKind, FeedbackMessage, FeedbackPage, FeedbackSession, FeedbackThread, PendingFeedbackRequest, ThreadListInput } from "./types.ts";
import { Icon, type IconName } from "./icons.tsx";
import { characterCount, MESSAGE_LIMIT, textLimitError, TITLE_LIMIT } from "./text_limits.ts";

export const KINDS: Record<FeedbackKind, { title: string; short: string; detail: string; icon: IconName; action: string; prompt: string }> = {
  issue: { title: "Report a problem", short: "Support ticket", detail: "Get help with Neutron or an app.", icon: "issue", action: "Send ticket", prompt: "What happened, and what did you expect? Steps to reproduce the problem are helpful." },
  feedback: { title: "Share feedback", short: "Feedback", detail: "Tell us what works and what could be better.", icon: "feedback", action: "Send feedback", prompt: "Tell us about your experience. What worked well, or what could feel better?" },
  app_suggestion: { title: "Suggest an app", short: "App idea", detail: "An app you’d love to have in Neutron.", icon: "app", action: "Suggest app", prompt: "What would this app help you do? Tell us why you would use it." },
  feature_suggestion: { title: "Suggest a feature", short: "Feature idea", detail: "A useful improvement to Neutron or an app.", icon: "idea", action: "Suggest feature", prompt: "What would you like to do, and how would this feature help?" },
};

type Page = "messages" | "new" | "moderation";
type Selection = { id: string; moderator: boolean } | null;
type Draft = { kind: FeedbackKind | null; title: string; appId: string; body: string };
type CreateIntent = { signature: string; requestId: string } | null;
const EMPTY_DRAFT: Draft = { kind: null, title: "", appId: "", body: "" };

export function FeedbackApp({ client }: { client: FeedbackClient }) {
  const [session, setSession] = useState<FeedbackSession | null>(null);
  const [sessionError, setSessionError] = useState("");
  const [sessionBusy, setSessionBusy] = useState(true);
  const [page, setPage] = useState<Page>("messages");
  const [selection, setSelection] = useState<Selection>(null);
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [notice, setNotice] = useState("");
  const [composerEpoch, setComposerEpoch] = useState(0);
  const alive = useRef(true);
  const sessionGeneration = useRef(0);
  const replyDrafts = useRef(new Map<string, { body: string; requestId: string; locked?: boolean }>());
  const createIntent = useRef<CreateIntent>(null);
  const currentPage = useRef(page); currentPage.current = page;
  const currentSession = useRef(session); currentSession.current = session;

  const refreshSession = useCallback(async () => {
    const generation = ++sessionGeneration.current;
    try {
      const next = await client.session();
      if (!alive.current || generation !== sessionGeneration.current) return;
      setSession(next); setSessionError("");
      if (!next.moderator) {
        setPage(current => current === "moderation" ? "messages" : current);
        setSelection(current => current?.moderator ? null : current);
        for (const key of replyDrafts.current.keys()) if (key.startsWith("moderator:")) replyDrafts.current.delete(key);
      }
    } catch (cause) {
      if (alive.current && generation === sessionGeneration.current) setSessionError(errorMessage(cause));
    } finally {
      if (alive.current && generation === sessionGeneration.current) setSessionBusy(false);
    }
  }, [client]);

  useEffect(() => {
    alive.current = true; void refreshSession();
    const timer = window.setInterval(() => { void refreshSession(); setRevision(value => value + 1); }, 30_000);
    return () => { alive.current = false; window.clearInterval(timer); };
  }, [refreshSession]);
  useEffect(() => onAppStateChange("feedback", () => { void refreshSession(); setRevision(value => value + 1); }), [refreshSession]);
  useEffect(() => onTileViewRequest(view => {
    if (view === "new") { setPage("new"); setSelection(null); return; }
    const match = /^thread\/([0-9]+)$/.exec(view);
    if (match) { setPage("messages"); setSelection({ id: match[1]!, moderator: false }); }
  }), []);

  function refresh() { void refreshSession(); setRevision(value => value + 1); }
  function navigate(next: Page) { setPage(next); setSelection(null); setNotice(""); }
  function changed() { refresh(); }
  const moderating = page === "moderation" && session?.moderator === true;

  return <main className="nt-app nt-app--fill fb-app">
    <header className="fb-header">
      <span className="fb-brand-icon"><Icon name="feedback" /></span>
      <div className="fb-brand"><h1>Feedback</h1><span>A little help. A better Neutron.</span></div>
      <button className="nt-icon-button fb-refresh" type="button" aria-label="Refresh" title="Refresh" onClick={refresh}><Icon name="refresh" /></button>
      <button className="nt-button fb-new-button" type="button" onClick={() => navigate("new")}><Icon name="plus" /><span>New message</span></button>
    </header>
    <nav className="fb-nav" aria-label="Feedback">
      <button type="button" className={page === "messages" ? "is-active" : ""} aria-current={page === "messages" ? "page" : undefined} onClick={() => navigate("messages")}><Icon name="inbox" />My messages{Boolean(session?.unreadReplies) && <span className="fb-count" aria-label={`${session!.unreadReplies} unread replies`}>{session!.unreadReplies > 99 ? "99+" : session!.unreadReplies}</span>}</button>
      {session?.moderator && <button type="button" className={moderating ? "is-active" : ""} aria-current={moderating ? "page" : undefined} onClick={() => navigate("moderation")}><Icon name="support" />Moderator inbox</button>}
      <span className="fb-private-label"><Icon name="lock" />Private conversations</span>
    </nav>
    <div className="fb-body">
      {sessionError && <ErrorNote error={sessionError} retry={refreshSession} title={session ? "Couldn’t refresh Feedback" : "Couldn’t open Feedback"} />}
      {notice && <div className="fb-notice" role="status"><Icon name="check" /><span>{notice}</span><button type="button" className="nt-icon-button" aria-label="Dismiss confirmation" onClick={() => setNotice("")}><Icon name="close" /></button></div>}
      {session && client.pending && client.resume && <SavedSends client={client} moderator={session.moderator} revision={revision} onRecovered={(request, result, editedCopy = false) => {
        if (createIntent.current?.requestId === request.requestId) { createIntent.current = null; setDraft(EMPTY_DRAFT); }
        for (const [key, saved] of replyDrafts.current) if (saved.requestId === request.requestId) { replyDrafts.current.delete(key); setComposerEpoch(value => value + 1); }
        const moderator = request.method === "moderationReply";
        if (!moderator || currentSession.current?.moderator) { setPage(moderator ? "moderation" : "messages"); setSelection({ id: "threadId" in result ? result.threadId : result.id, moderator }); }
        setNotice(editedCopy ? "Your edited copy was sent. The original saved message is unchanged." : "Your saved message is confirmed. It was sent once."); changed();
      }} />}
      {!session ? sessionBusy ? <Loading label="Opening Feedback" /> : null : page === "new" ? <Composer client={client} draft={draft} setDraft={setDraft} intent={createIntent} back={() => navigate("messages")} onFailed={changed} onCreated={(thread, requestId) => { if (createIntent.current?.requestId === requestId) { createIntent.current = null; setDraft(EMPTY_DRAFT); } if (currentPage.current === "new") { setPage("messages"); setSelection({ id: thread.id, moderator: false }); } setNotice(thread.kind === "issue" ? "Your ticket was sent. Replies will appear here and in the tray." : "Thanks for sharing your message with the team."); changed(); }} /> : <div className={`fb-workspace${selection ? " has-discussion" : ""}`}>
        <div className="fb-inbox-pane"><ThreadList key={moderating ? "moderation" : "own"} client={client} moderator={moderating} revision={revision} selected={selection?.id} choose={id => { setSelection({ id, moderator: moderating }); setNotice(""); }} compose={() => navigate("new")} /></div>
        {selection && (!selection.moderator || session.moderator) && <div className="fb-discussion-pane"><ThreadDiscussion key={`${selection.moderator}:${selection.id}:${composerEpoch}`} client={client} id={selection.id} moderator={selection.moderator} session={session} revision={revision} back={() => setSelection(null)} onChanged={changed} drafts={replyDrafts.current} /></div>}
      </div>}
    </div>
  </main>;
}

function ThreadList({ client, moderator, revision, selected, choose, compose }: { client: FeedbackClient; moderator: boolean; revision: number; selected?: string | undefined; choose: (id: string) => void; compose: () => void }) {
  const [filter, setFilter] = useState("all");
  const [kind, setKind] = useState<FeedbackKind | "all">("all");
  const [data, setData] = useState<FeedbackPage<FeedbackThread> | null>(null);
  const [loading, setLoading] = useState(true), [paging, setPaging] = useState(false), [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const sequence = useRef(0);
  const visible = useRef<FeedbackPage<FeedbackThread> | null>(null);
  const inputs = (): ThreadListInput => ({ ...(kind === "all" ? {} : { kind }), ...(filter === "replies" ? { unreadOnly: true } : filter === "needs_reply" ? { needsReply: true } : {}) });
  const read = (input: ThreadListInput) => moderator ? client.moderationList(input) : client.list(input);
  useEffect(() => {
    visible.current = null; setData(null);
  }, [filter, kind]);
  useEffect(() => {
    const generation = ++sequence.current; setLoading(true);
    const targetCount = visible.current?.items.length ?? 0;
    const load = async () => {
      let next = await read(inputs());
      while (next.nextCursor && next.items.length < targetCount && generation === sequence.current) {
        const following = await read({ ...inputs(), cursor: next.nextCursor });
        next = { items: mergeThreads(next.items, following.items), nextCursor: following.nextCursor };
      }
      if (generation === sequence.current) { visible.current = next; setData(next); setError(""); }
    };
    void load().catch(cause => { if (generation === sequence.current) setError(errorMessage(cause)); }).finally(() => { if (generation === sequence.current) setLoading(false); });
    return () => { sequence.current++; };
  }, [client, moderator, filter, kind, revision, retry]);
  async function more() {
    if (!data?.nextCursor || paging) return;
    const generation = sequence.current; setPaging(true);
    try { const next = await read({ ...inputs(), cursor: data.nextCursor }); if (generation === sequence.current) { const combined = { items: mergeThreads(visible.current?.items ?? [], next.items), nextCursor: next.nextCursor }; visible.current = combined; setData(combined); setError(""); } }
    catch (cause) { if (generation === sequence.current) setError(errorMessage(cause)); }
    finally { setPaging(false); }
  }
  return <section className="fb-inbox" aria-label={moderator ? "Moderator inbox" : "My messages"}>
    <div className="fb-section-heading"><div><h2>{moderator ? "Moderator inbox" : "My messages"}</h2><p>{moderator ? "Listen, help, and keep the conversation moving." : "Your tickets, feedback, and ideas — all in one place."}</p></div></div>
    <div className="fb-list-controls">
      <div className="fb-filters" aria-label="Filter messages">{(moderator ? [["all", "All"], ["needs_reply", "Needs reply"]] : [["all", "All"], ["replies", "New replies"]]).map(([id, title]) => <button type="button" aria-pressed={filter === id} className={filter === id ? "is-active" : ""} key={id} onClick={() => setFilter(id!)}>{title}</button>)}</div>
      <label className="fb-kind-filter"><span className="nt-sr-only">Message type</span><select className="nt-select" value={kind} onChange={event => setKind(event.target.value as FeedbackKind | "all")}><option value="all">All types</option>{Object.entries(KINDS).map(([id, info]) => <option key={id} value={id}>{info.short}</option>)}</select></label>
    </div>
    {error && <ErrorNote error={error} retry={() => setRetry(value => value + 1)} />}
    <div className="fb-thread-list" aria-busy={loading}>
      {!data && loading ? <Loading label="Loading messages" /> : data?.items.length ? data.items.map(thread => <button className={`fb-thread-row${thread.id === selected ? " is-selected" : ""}${thread.unreadReplies && !moderator ? " is-unread" : ""}`} key={thread.id} type="button" onClick={() => choose(thread.id)} aria-current={thread.id === selected ? "true" : undefined}>
        <span className={`fb-kind-icon fb-kind-${thread.kind}`}><Icon name={KINDS[thread.kind].icon} /></span>
        <span className="fb-thread-copy"><span className="fb-thread-title"><strong>{thread.title}</strong>{!moderator && thread.unreadReplies > 0 && <span className="fb-unread-dot" aria-label="New reply" />}</span><span className="fb-thread-meta"><span>{KINDS[thread.kind].short}</span>{thread.appId && <span>{thread.appId}</span>}<span className={`fb-thread-status${thread.resolved ? " is-resolved" : ""}`}>{threadLabel(thread, moderator)}</span></span>{moderator && <span className="fb-owner">Neutron {shortPrincipal(thread.owner)}</span>}</span>
        <span className="fb-thread-tail"><time dateTime={isoDate(thread.updatedAt)}>{relativeDate(thread.updatedAt)}</time><Icon name="arrow" /></span>
      </button>) : !error && <EmptyState icon={filter === "replies" ? "check" : "inbox"} title={filter === "replies" ? "You’re all caught up" : moderator ? filter === "needs_reply" ? "No tickets waiting for a reply" : "A quiet inbox" : "Your conversation starts here"} detail={filter === "replies" ? "New support replies will appear here and in your tray." : moderator ? "Messages from Neutron users will appear here." : "Get help, share your experience, or tell us what you’d like to see next."} action={!moderator && filter === "all" ? <button className="nt-button" type="button" onClick={compose}><Icon name="plus" />New message</button> : undefined} />}
    </div>
    {data?.nextCursor && <button className="nt-button nt-button--secondary fb-load-more" type="button" disabled={paging} onClick={() => void more()}>{paging && <span className="nt-spinner" />}Load more messages</button>}
  </section>;
}

function Composer({ client, draft, setDraft, intent, back, onCreated, onFailed }: { client: FeedbackClient; draft: Draft; setDraft: (draft: Draft) => void; intent: React.RefObject<CreateIntent>; back: () => void; onCreated: (thread: FeedbackThread, requestId: string) => void; onFailed: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const pending = useRef(false);
  const info = draft.kind ? KINDS[draft.kind] : null;
  const locked = Boolean(intent.current);
  const titleProblem = textLimitError(draft.title.trim(), TITLE_LIMIT, "Title");
  const bodyProblem = textLimitError(draft.body.trim(), MESSAGE_LIMIT, "Message");
  const update = (patch: Partial<Draft>) => { if (intent.current) return; setDraft({ ...draft, ...patch }); setError(""); };
  async function send() {
    if (!draft.kind || pending.current) return;
    if (!draft.title.trim() || !draft.body.trim()) { setError("Add a title and message before sending."); return; }
    if (!intent.current && (titleProblem || bodyProblem)) { setError(titleProblem || bodyProblem); return; }
    const payload = { kind: draft.kind, title: draft.title.trim(), body: draft.body.trim(), ...(draft.appId.trim() ? { appId: draft.appId.trim() } : {}) };
    const signature = JSON.stringify(payload);
    if (intent.current?.signature !== signature) intent.current = { signature, requestId: newRequestId() };
    pending.current = true; setBusy(true); setError("");
    const requestId = intent.current.requestId;
    try { const thread = await client.create({ ...payload, requestId }); onCreated(thread, requestId); }
    catch (cause) { if (!(await isPending(client, requestId)) && intent.current?.requestId === requestId) intent.current = null; setError(errorMessage(cause)); onFailed(); }
    finally { pending.current = false; setBusy(false); }
  }
  return <section className="fb-compose fb-content" aria-label="New message">
    <button className="fb-back" type="button" onClick={back}><Icon name="back" />Back</button>
    {!info ? <><div className="fb-compose-intro"><span className="fb-eyebrow">Make Neutron better</span><h2>What’s on your mind?</h2><p>A problem, a little feedback, or your next big idea.<br className="fb-wide-break" /> Choose what fits — we’ll take it from here.</p></div><div className="fb-kind-grid">{Object.entries(KINDS).map(([kind, choice]) => <button type="button" aria-label={choice.title} className={`fb-kind-choice fb-kind-${kind}`} key={kind} onClick={() => update({ kind: kind as FeedbackKind })}><span className="fb-kind-choice-icon"><Icon name={choice.icon} /></span><strong>{choice.title}</strong><span>{choice.detail}</span><Icon name="arrow" className="fb-choice-arrow" /></button>)}</div><PrivacyNote /></> : <>
      <div className="fb-compose-kind"><span className={`fb-kind-choice-icon fb-kind-${draft.kind}`}><Icon name={info.icon} /></span><div><h2>{info.title}</h2><p>{info.detail}</p></div><button className="fb-text-button" type="button" disabled={busy || locked} onClick={() => update({ kind: null })}>Change</button></div>
      <form className="fb-form" onSubmit={event => event.preventDefault()} onKeyDown={preventImplicitSubmit} aria-busy={busy}>
        <div className="nt-field"><div className="fb-field-heading"><label className="nt-label" htmlFor="feedback-title">Title</label><CharacterCounter id="title-count" value={draft.title.trim()} limit={TITLE_LIMIT} /></div><input className="nt-input" id="feedback-title" name="title" value={draft.title} onChange={event => update({ title: event.target.value })} placeholder={draft.kind === "issue" ? "A short summary of the problem" : "Give your message a short title"} aria-describedby={`title-count${titleProblem ? " title-limit-error" : ""}`} aria-invalid={Boolean(titleProblem)} disabled={busy} readOnly={locked} autoFocus required />{titleProblem && <p className="fb-field-limit-error" id="title-limit-error">{titleProblem}</p>}</div>
        {draft.kind !== "app_suggestion" && <label className="nt-field"><span className="nt-label">Affected app <span className="fb-optional">(optional)</span></span><input className="nt-input" name="app" value={draft.appId} onChange={event => update({ appId: event.target.value })} placeholder="Neutron, Files, IC Wallet…" disabled={busy} readOnly={locked} /></label>}
        <div className="nt-field"><div className="fb-field-heading"><label className="nt-label" htmlFor="feedback-message">Message</label><CharacterCounter id="message-count" value={draft.body.trim()} limit={MESSAGE_LIMIT} /></div><span className="nt-help" id="message-help">{info.prompt}</span><textarea className="nt-textarea" id="feedback-message" name="message" value={draft.body} onChange={event => update({ body: event.target.value })} placeholder="Write in your own words…" aria-describedby={`message-help image-help message-count${bodyProblem ? " message-limit-error" : ""}`} aria-invalid={Boolean(bodyProblem)} disabled={busy} readOnly={locked} required rows={7} />{bodyProblem && <p className="fb-field-limit-error" id="message-limit-error">{bodyProblem}</p>}</div>
        <ImageNote />
        <div className="fb-expectation"><Icon name={draft.kind === "issue" ? "support" : "check"} /><p>{draft.kind === "issue" ? "This starts a support conversation. You’ll see replies here and in the Feedback tray." : "The team will review your message. A reply isn’t required, but you’ll be notified if one arrives."}</p></div>
        {error && <ErrorNote error={error} />}
        {locked && !busy && <p className="fb-pending-note">Your original message is saved. Send again to confirm it without creating a duplicate.</p>}
        <div className="fb-form-footer"><PrivacyNote compact /><button className="nt-button" type="button" onClick={() => void send()} disabled={busy || (!locked && Boolean(titleProblem || bodyProblem))}>{busy ? <span className="nt-spinner" /> : <Icon name="arrow" />}{info.action}</button></div>
      </form>
    </>}
  </section>;
}

function ThreadDiscussion({ client, id, moderator, session, revision, back, onChanged, drafts }: { client: FeedbackClient; id: string; moderator: boolean; session: FeedbackSession; revision: number; back: () => void; onChanged: () => void; drafts: Map<string, { body: string; requestId: string; locked?: boolean }> }) {
  const key = `${moderator ? "moderator" : "user"}:${id}`;
  const [data, setData] = useState<Discussion | null>(null), [loading, setLoading] = useState(true), [paging, setPaging] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [body, setBody] = useState(drafts.get(key)?.body ?? "");
  const bodyProblem = textLimitError(body.trim(), MESSAGE_LIMIT, "Reply");
  const [retry, setRetry] = useState(0);
  const sequence = useRef(0), pending = useRef(false), acknowledged = useRef("");
  const visible = useRef<Discussion | null>(null);
  const read = (cursor?: string) => moderator ? client.moderationGet(id, cursor) : client.get(id, cursor);
  useEffect(() => {
    const generation = ++sequence.current; setLoading(true);
    const previous = visible.current;
    const load = async () => {
      let next = await read();
      const targetCount = previous?.messages.nextCursor === null ? next.thread.messageCount : previous?.messages.items.length ?? 0;
      while (next.messages.nextCursor && next.messages.items.length < targetCount && generation === sequence.current) {
        const following = await read(next.messages.nextCursor);
        next = { thread: following.thread, messages: { items: mergeMessages(next.messages.items, following.messages.items), nextCursor: following.messages.nextCursor } };
      }
      if (generation === sequence.current) { visible.current = next; setData(next); setLoadError(""); }
    };
    void load().catch(cause => { if (generation === sequence.current) { setLoadError(errorMessage(cause)); if (moderator) { visible.current = null; setData(null); } } }).finally(() => { if (generation === sequence.current) setLoading(false); });
    return () => { sequence.current++; };
  }, [client, id, moderator, revision, retry]);

  useEffect(() => {
    if (!data || moderator || data.thread.owner !== session.neutron || !data.thread.unreadReplies) return;
    const last = data.messages.items.at(-1)?.id;
    if (!last || (acknowledged.current && BigInt(last) <= BigInt(acknowledged.current))) return;
    acknowledged.current = last;
    let active = true;
    // This effect runs after React has committed the displayed message page.
    void client.markRead(id, last).then(thread => { if (active) setData(old => old && BigInt(thread.lastMessageId) >= BigInt(old.thread.lastMessageId) ? { ...old, thread } : old); onChanged(); }).catch(() => { if (acknowledged.current === last) acknowledged.current = ""; });
    return () => { active = false; };
  }, [data, moderator, client, id, session.neutron]);

  function editBody(next: string) { if (drafts.get(key)?.locked) return; setBody(next); const old = drafts.get(key); drafts.set(key, { body: next, requestId: old?.body === next ? old.requestId : newRequestId() }); }
  async function send() {
    if (pending.current || !body.trim()) return;
    if (!drafts.get(key)?.locked && bodyProblem) { setError(bodyProblem); return; }
    const stored = drafts.get(key) ?? { body, requestId: newRequestId() }; drafts.set(key, { ...stored, locked: true });
    pending.current = true; setBusy(true); setError("");
    try { const input = { requestId: stored.requestId, threadId: id, body: stored.body.trim() }; await (moderator ? client.moderationReply(input) : client.reply(input)); if (drafts.get(key)?.requestId === stored.requestId) { drafts.delete(key); setBody(""); } onChanged(); setRetry(value => value + 1); }
    catch (cause) { if (!(await isPending(client, stored.requestId)) && drafts.get(key)?.requestId === stored.requestId) drafts.set(key, { ...stored, locked: false }); setError(errorMessage(cause)); onChanged(); }
    finally { pending.current = false; setBusy(false); }
  }
  async function resolve() {
    if (!data || pending.current) return; pending.current = true; setBusy(true); setError("");
    try { const thread = await client.setResolved(id, !data.thread.resolved); setData(old => old ? { ...old, thread } : old); onChanged(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { pending.current = false; setBusy(false); }
  }
  async function more() {
    if (!data?.messages.nextCursor || paging) return;
    const generation = sequence.current; setPaging(true);
    try { const next = await read(data.messages.nextCursor); if (generation === sequence.current) { const old = visible.current; const combined = old ? { thread: next.thread, messages: { items: mergeMessages(old.messages.items, next.messages.items), nextCursor: next.messages.nextCursor } } : next; visible.current = combined; setData(combined); } }
    catch (cause) { if (generation === sequence.current) setError(errorMessage(cause)); }
    finally { setPaging(false); }
  }
  return <section className="fb-discussion" aria-label="Discussion">
    <button className="fb-back" type="button" onClick={back}><Icon name="back" />Back</button>
    {!data && loading ? <Loading label="Loading discussion" /> : data && <>
      <header className="fb-discussion-header"><div className="fb-discussion-kicker"><span className={`fb-kind-icon fb-kind-${data.thread.kind}`}><Icon name={KINDS[data.thread.kind].icon} /></span><span>{KINDS[data.thread.kind].short}</span><span className="fb-ticket-id">#{data.thread.id}</span><span className={`fb-status-label${data.thread.resolved ? " is-resolved" : ""}`}>{threadLabel(data.thread, moderator)}</span></div><h2>{data.thread.title}</h2><div className="fb-discussion-meta">{data.thread.appId && <span>{data.thread.appId}</span>}<span>Started {fullDate(data.thread.createdAt)}</span>{moderator && <span className="fb-principal" title={data.thread.owner}>Neutron {shortPrincipal(data.thread.owner)}</span>}</div></header>
      {moderator && <p className="fb-moderator-note"><Icon name="support" />You’re viewing this conversation as support.</p>}
      <div className="fb-messages" aria-label="Messages" aria-busy={loading}>{data.messages.items.map(message => <article className={`fb-message${message.role === "moderator" ? " from-support" : ""}`} key={message.id}><header><span className="fb-message-avatar"><Icon name={message.role === "moderator" ? "support" : "feedback"} /></span><strong>{message.role === "moderator" ? "Support" : message.author === session.neutron ? "You" : "Neutron user"}</strong>{message.role === "moderator" && <span className="fb-support-tag">Team</span>}<time dateTime={isoDate(message.createdAt)} title={fullDate(message.createdAt)}>{relativeDate(message.createdAt)}</time></header><MessageBody body={message.body} /></article>)}</div>
      {data.messages.nextCursor && <button className="nt-button nt-button--secondary fb-load-more" type="button" disabled={paging} onClick={() => void more()}>{paging && <span className="nt-spinner" />}Load more replies</button>}
      {!moderator && data.thread.kind === "issue" && <div className={`fb-resolution${data.thread.resolved ? " is-resolved" : ""}`}><div><Icon name={data.thread.resolved ? "check" : "issue"} /><span>{data.thread.resolved ? "You marked this issue as resolved." : "Everything working now?"}</span></div><button className="fb-text-button" type="button" disabled={busy} onClick={() => void resolve()}>{data.thread.resolved ? "Reopen ticket" : "Mark resolved"}</button></div>}
      <form className="fb-reply" onSubmit={event => event.preventDefault()} onKeyDown={preventImplicitSubmit} aria-busy={busy}><div className="nt-field"><div className="fb-field-heading"><label className="nt-label" htmlFor="feedback-reply">{moderator ? "Reply as support" : "Your reply"}</label><CharacterCounter id="reply-count" value={body.trim()} limit={MESSAGE_LIMIT} /></div><textarea className="nt-textarea" id="feedback-reply" value={body} onChange={event => editBody(event.target.value)} placeholder={moderator ? "Write a clear, helpful reply…" : "Add a little more detail or reply to the team…"} aria-describedby={`reply-count image-help${bodyProblem ? " reply-limit-error" : ""}`} aria-invalid={Boolean(bodyProblem)} disabled={busy} readOnly={drafts.get(key)?.locked ?? false} rows={4} required />{bodyProblem && <p className="fb-field-limit-error" id="reply-limit-error">{bodyProblem}</p>}</div><ImageNote />{drafts.get(key)?.locked && !busy && <p className="fb-pending-note">Your original reply is saved. Send again to confirm it without adding a duplicate.</p>}<div className="fb-reply-footer"><span><Icon name="lock" />Only this Neutron and support</span><button className="nt-button" type="button" onClick={() => void send()} disabled={busy || !body.trim() || (!drafts.get(key)?.locked && Boolean(bodyProblem))}>{busy ? <span className="nt-spinner" /> : <Icon name="arrow" />}{moderator ? "Reply as support" : "Send reply"}</button></div></form>
    </>}
    {(error || loadError) && <ErrorNote error={error || loadError} retry={!data ? () => setRetry(value => value + 1) : undefined} />}
  </section>;
}

function SavedSends({ client, moderator, revision, onRecovered }: { client: FeedbackClient; moderator: boolean; revision: number; onRecovered: (request: PendingFeedbackRequest, result: FeedbackThread | FeedbackMessage, editedCopy?: boolean) => void }) {
  const [items, setItems] = useState<PendingFeedbackRequest[]>([]), [cursor, setCursor] = useState<string | null>(null), [busy, setBusy] = useState<string | null>(null), [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [retry, setRetry] = useState(0);
  const [copies, setCopies] = useState<Record<string, PendingFeedbackRequest>>({});
  const [openCopies, setOpenCopies] = useState<string[]>([]);
  const sequence = useRef(0), sending = useRef(false);
  useEffect(() => {
    const generation = ++sequence.current;
    if (!moderator) setItems(old => old.filter(item => item.method !== "moderationReply"));
    void client.pending!().then(page => { if (generation === sequence.current) { setItems(page.items.filter(item => moderator || item.method !== "moderationReply")); setCursor(page.nextCursor); setLoadError(""); } }).catch(cause => { if (generation === sequence.current) setLoadError(errorMessage(cause)); });
    return () => { sequence.current++; };
  }, [client, moderator, revision, retry]);
  async function resume(request: PendingFeedbackRequest) {
    if (sending.current) return; sending.current = true; setBusy(request.requestId); setError("");
    try { const result = await client.resume!(request.requestId); setItems(old => old.filter(item => item.requestId !== request.requestId)); onRecovered(request, result); }
    catch (cause) { setError(errorMessage(cause)); if (!(await isPending(client, request.requestId))) setItems(old => old.filter(item => item.requestId !== request.requestId)); }
    finally { sending.current = false; setBusy(null); }
  }
  async function more() {
    if (!cursor || busy) return; setBusy("more"); const generation = sequence.current;
    try { const page = await client.pending!(cursor); if (generation === sequence.current) { setItems(old => [...old, ...page.items.filter(item => moderator || item.method !== "moderationReply")].filter((item, index, all) => all.findIndex(other => other.requestId === item.requestId) === index)); setCursor(page.nextCursor); } }
    catch (cause) { if (generation === sequence.current) setError(errorMessage(cause)); }
    finally { setBusy(null); }
  }
  const visibleItems = items.filter(item => moderator || item.method !== "moderationReply");
  const visibleError = error || loadError;
  const visibleCopies = Object.values(copies).filter(request => moderator || request.method !== "moderationReply");
  if (!visibleItems.length && !visibleError && !cursor && !visibleCopies.length) return null;
  return <section className="fb-saved-sends" aria-label="Saved sends"><header><Icon name="refresh" /><div><h2>{visibleItems.length ? "A message is waiting for confirmation" : visibleError ? "Saved sends are unavailable" : visibleCopies.length ? "Your draft copies" : "More saved sends"}</h2><p>{visibleItems.length ? "Confirm your saved send to continue. The original message will only be sent once." : visibleError ? "Your messages are preserved. Retry to check any unconfirmed sends." : visibleCopies.length ? "Your copies are kept here while you edit them." : "Continue to check the rest of your saved messages."}</p></div></header>{visibleItems.map(item => <div className="fb-saved-send" key={item.requestId}><details><summary>{item.title ?? (item.method === "moderationReply" ? "Your support reply" : "Your reply")}</summary><p className="fb-saved-body" dir="auto">{item.body}</p></details><div className="fb-saved-actions"><button className="nt-button nt-button--secondary" type="button" disabled={Boolean(busy)} onClick={() => void resume(item)}>{busy === item.requestId && <span className="nt-spinner" />}Confirm send</button>{savedSizeProblem(item) && <button className="fb-text-button" type="button" onClick={() => { setCopies(old => Object.prototype.hasOwnProperty.call(old, item.requestId) ? old : { ...old, [item.requestId]: item }); setOpenCopies(old => old.includes(item.requestId) ? old : [...old, item.requestId]); }}>Edit a copy</button>}</div></div>)}{cursor && <button className="fb-text-button" type="button" disabled={Boolean(busy)} onClick={() => void more()}>More saved sends</button>}{visibleError && <ErrorNote error={visibleError} retry={() => { setError(""); setRetry(value => value + 1); }} />}{visibleCopies.map(request => <div key={request.requestId}>{!openCopies.includes(request.requestId) && <button className="fb-text-button" type="button" onClick={() => setOpenCopies(old => [...old, request.requestId])}>Continue editing copy</button>}<div hidden={!openCopies.includes(request.requestId)}><SavedCopyEditor client={client} source={request} open={openCopies.includes(request.requestId)} close={() => setOpenCopies(old => old.filter(id => id !== request.requestId))} sent={(copy, result) => { setCopies(old => { const next = { ...old }; delete next[request.requestId]; return next; }); setOpenCopies(old => old.filter(id => id !== request.requestId)); onRecovered(copy, result, true); }} /></div></div>)}</section>;
}

function SavedCopyEditor({ client, source, open, close, sent }: { client: FeedbackClient; source: PendingFeedbackRequest; open: boolean; close: () => void; sent: (copy: PendingFeedbackRequest, result: FeedbackThread | FeedbackMessage) => void }) {
  const [title, setTitle] = useState(source.title ?? ""), [body, setBody] = useState(source.body), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const intent = useRef<{ requestId: string; title: string; body: string } | null>(null);
  const sending = useRef(false);
  const isCreate = source.method === "create";
  const titleProblem = isCreate ? textLimitError(title.trim(), TITLE_LIMIT, "Title") : "";
  const bodyProblem = textLimitError(body.trim(), MESSAGE_LIMIT, isCreate ? "Message" : "Reply");
  const locked = Boolean(intent.current);
  const fieldId = useId();
  const editor = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open || !editor.current) return;
    editor.current.scrollIntoView({ block: "start" });
    editor.current.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")?.focus({ preventScroll: true });
  }, [open]);
  async function send() {
    if (sending.current || !body.trim() || (isCreate && !title.trim())) return;
    if (!intent.current && (titleProblem || bodyProblem)) { setError(titleProblem || bodyProblem); return; }
    if (!intent.current) intent.current = { requestId: newRequestId(), title: title.trim(), body: body.trim() };
    const draft = intent.current;
    const copy = { ...source, requestId: draft.requestId, body: draft.body, ...(isCreate ? { title: draft.title } : {}) };
    sending.current = true; setBusy(true); setError("");
    try {
      const result = isCreate
        ? await client.create({ requestId: draft.requestId, kind: source.kind!, title: draft.title, body: draft.body, ...(source.appId ? { appId: source.appId } : {}) })
        : await (source.method === "moderationReply" ? client.moderationReply({ requestId: draft.requestId, threadId: source.threadId!, body: draft.body }) : client.reply({ requestId: draft.requestId, threadId: source.threadId!, body: draft.body }));
      sent(copy, result);
    } catch (cause) { if (!(await isPending(client, draft.requestId))) intent.current = null; setError(errorMessage(cause)); }
    finally { sending.current = false; setBusy(false); }
  }
  return <section ref={editor} className="fb-copy-editor" aria-label="Edit a copy"><header><div><h3>Edit a copy</h3><p>{isCreate ? "This creates a new message." : "This adds a new reply."} Your original saved send stays unchanged.</p></div><button className="nt-icon-button" type="button" aria-label="Close copy editor" onClick={close}><Icon name="close" /></button></header><form className="fb-form" onSubmit={event => event.preventDefault()} onKeyDown={preventImplicitSubmit} aria-busy={busy}>
    {isCreate && <div className="nt-field"><div className="fb-field-heading"><label className="nt-label" htmlFor={`${fieldId}-title`}>Title</label><CharacterCounter id={`${fieldId}-title-count`} value={title.trim()} limit={TITLE_LIMIT} /></div><input className="nt-input" id={`${fieldId}-title`} value={title} disabled={busy} readOnly={locked} onChange={event => { if (!intent.current) { setTitle(event.target.value); setError(""); } }} aria-invalid={Boolean(titleProblem)} aria-describedby={`${fieldId}-title-count${titleProblem ? ` ${fieldId}-title-error` : ""}`} />{titleProblem && <p className="fb-field-limit-error" id={`${fieldId}-title-error`}>{titleProblem}</p>}</div>}
    <div className="nt-field"><div className="fb-field-heading"><label className="nt-label" htmlFor={`${fieldId}-body`}>{isCreate ? "Message" : source.method === "moderationReply" ? "Reply as support" : "Your reply"}</label><CharacterCounter id={`${fieldId}-body-count`} value={body.trim()} limit={MESSAGE_LIMIT} /></div><textarea className="nt-textarea" id={`${fieldId}-body`} value={body} disabled={busy} readOnly={locked} onChange={event => { if (!intent.current) { setBody(event.target.value); setError(""); } }} aria-invalid={Boolean(bodyProblem)} aria-describedby={`${fieldId}-body-count${bodyProblem ? ` ${fieldId}-body-error` : ""}`} rows={5} />{bodyProblem && <p className="fb-field-limit-error" id={`${fieldId}-body-error`}>{bodyProblem}</p>}</div>
    {error && <ErrorNote error={error} />}{locked && !busy && <p className="fb-pending-note">This copy is saved. Send again to confirm it without adding a duplicate.</p>}<div className="fb-copy-footer"><button className="nt-button" type="button" disabled={busy || !body.trim() || (isCreate && !title.trim()) || (!locked && Boolean(titleProblem || bodyProblem))} onClick={() => void send()}>{busy && <span className="nt-spinner" />}Send edited copy</button></div>
  </form></section>;
}

function savedSizeProblem(request: PendingFeedbackRequest) { return (request.title ? textLimitError(request.title, TITLE_LIMIT, "Title") : "") || textLimitError(request.body, MESSAGE_LIMIT, "Message"); }

export function MessageBody({ body }: { body: string }) {
  const links = [...new Set(body.match(/https?:\/\/[^\s<>"']+/gu) ?? [])].map(value => value.replace(/[),.;!?]+$/u, "")).filter(value => { try { return ["https:", "http:"].includes(new URL(value).protocol); } catch { return false; } });
  const [error, setError] = useState("");
  return <div className="fb-message-body"><p dir="auto">{body}</p>{links.length > 0 && <div className="fb-message-links" aria-label="Links in this message">{links.map(link => <div className="fb-message-link" key={link}><span title={link}>{link}</span><button className="fb-copy-button" type="button" aria-label={`Copy link ${link}`} onClick={() => { void copyToClipboard(link).catch(cause => setError(errorMessage(cause))); }}><Icon name="copy" />Copy link</button></div>)}</div>}{error && <span className="nt-error" role="alert">{error}</span>}</div>;
}

function CharacterCounter({ id, value, limit }: { id: string; value: string; limit: number }) { const count = characterCount(value); return <span className={`fb-character-count${count > limit ? " is-over" : ""}`} id={id} aria-label={`${count.toLocaleString("en-US")} of ${limit.toLocaleString("en-US")} characters`}>{count.toLocaleString("en-US")} / {limit.toLocaleString("en-US")}</span>; }
function PrivacyNote({ compact = false }: { compact?: boolean }) { return <p className={`fb-privacy${compact ? " is-compact" : ""}`}><Icon name="lock" /><span>{compact ? "Private to you and support" : "Your messages are private to this Neutron and the support team."}</span></p>; }
function ImageNote() { return <p className="fb-image-note" id="image-help">Have an image? Add it to <strong>Files → Shared</strong> and paste its link. Shared file links are public.</p>; }
export function Loading({ label }: { label: string }) { return <div className="nt-state nt-state--loading fb-loading" role="status" aria-label={label}><span className="nt-spinner" aria-hidden="true" /></div>; }
export function ErrorNote({ error, retry, title }: { error: string; retry?: (() => unknown) | undefined; title?: string }) { return <div className="fb-error" role="alert"><Icon name="issue" /><div>{title && <strong>{title}</strong>}<p>{error}</p></div>{retry && <button className="nt-button nt-button--secondary" type="button" onClick={() => void retry()}>Retry</button>}</div>; }
export function EmptyState({ icon, title, detail, action }: { icon: IconName; title: string; detail: string; action?: React.ReactNode }) { return <div className="fb-empty"><span className="fb-empty-icon"><Icon name={icon} /></span><h3>{title}</h3><p>{detail}</p>{action}</div>; }
export function threadLabel(thread: FeedbackThread, moderator = false) { if (thread.resolved) return "Resolved"; if (!moderator && thread.unreadReplies > 0) return "New reply"; if (thread.kind !== "issue") return "Shared with the team"; return thread.needsReply ? moderator ? "Needs reply" : "With support" : "Support replied"; }
export function errorMessage(cause: unknown) { return cause instanceof Error ? cause.message : typeof cause === "object" && cause && "message" in cause ? String(cause.message) : "Something went wrong. Please try again."; }
function newRequestId() { return crypto.randomUUID(); }
async function isPending(client: FeedbackClient, requestId: string): Promise<boolean> { if (!client.pending) return true; try { let cursor: string | undefined; do { const page = await client.pending(cursor); if (page.items.some(item => item.requestId === requestId)) return true; cursor = page.nextCursor ?? undefined; } while (cursor); return false; } catch { return true; } }
function preventImplicitSubmit(event: React.KeyboardEvent<HTMLFormElement>) { if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault(); }
function shortPrincipal(principal: string) { return principal.length > 22 ? `${principal.slice(0, 11)}…${principal.slice(-5)}` : principal; }
function dateValue(value: string) { if (/^[0-9]+$/.test(value)) { const number = BigInt(value); return new Date(Number(number > 100_000_000_000_000n ? number / 1_000_000n : number)); } return new Date(value); }
export function isoDate(value: string) { const date = dateValue(value); return Number.isFinite(date.getTime()) ? date.toISOString() : undefined; }
function fullDate(value: string) { const date = dateValue(value); return Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "recently"; }
export function relativeDate(value: string) { const date = dateValue(value); if (!Number.isFinite(date.getTime())) return "Recently"; const minutes = Math.max(0, (Date.now() - date.getTime()) / 60_000); if (minutes < 1) return "Just now"; if (minutes < 60) return `${Math.floor(minutes)}m ago`; if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`; if (minutes < 2880) return "Yesterday"; return date.toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
function mergeThreads(old: FeedbackThread[], next: FeedbackThread[]) { return [...old, ...next].filter((item, index, all) => all.findIndex(other => other.id === item.id) === index); }
function mergeMessages(old: FeedbackMessage[], next: FeedbackMessage[]) { return [...old, ...next].filter((item, index, all) => all.findIndex(other => other.id === item.id) === index).sort((left, right) => BigInt(left.id) < BigInt(right.id) ? -1 : BigInt(left.id) > BigInt(right.id) ? 1 : 0); }
