import { useEffect, useMemo, useRef, useState } from "react";
import { connectEthereumFundingBrowser } from "./ethereum.ts";
import { createMarketplaceClient } from "./tile_client.ts";
import type { AppListing, AppTier, LibraryApp, MarketplaceClient, OperationResult, Page, RankingWindow, Session } from "./view-types.ts";
import { Checkout } from "./components/checkout.tsx";
import { AppDetailDialog } from "./components/detail.tsx";
import { EarningsPanel } from "./components/earnings.tsx";
import { PublisherPanel } from "./components/publisher.tsx";
import { AgentReviewHost } from "./components/agent_review.tsx";
import { AppIcon, EmptyState, ErrorNote, Icon, Loading, Modal, dateLabel, errorMessage, shortPrincipal, usd, useRead } from "./components/primitives.tsx";

type Tab = "explore" | "library" | "publish" | "earnings";
type ActiveOperation = { result: OperationResult; resume?: (() => Promise<OperationResult>) | undefined };
const tabs = [{ id: "explore", title: "Explore", icon: "store" }, { id: "library", title: "My Apps", icon: "apps" }, { id: "publish", title: "Publish", icon: "publish" }, { id: "earnings", title: "Earnings", icon: "earnings" }] as const;

export default function App({ client: suppliedClient }: { client?: MarketplaceClient }) {
  const client: MarketplaceClient = useMemo(() => suppliedClient ?? createMarketplaceClient(), [suppliedClient]);
  const [session, setSession] = useState<Session | null>(null), [tab, setTab] = useState<Tab>("explore");
  const [revision, setRevision] = useState(0), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [connecting, setConnecting] = useState(false), [settings, setSettings] = useState(false);
  const [detail, setDetail] = useState<AppListing | null>(null), [checkout, setCheckout] = useState<AppListing[] | null>(null);
  const [active, setActive] = useState<ActiveOperation | null>(null), [tracking, setTracking] = useState(false), [installing, setInstalling] = useState(false);
  const [publisherOpened, setPublisherOpened] = useState(false);
  const [recoveryHash, setRecoveryHash] = useState("");
  const saved = useRead(session?.connected ? `${session.canisterId}:operations` : null, () => client.recentOperations(), revision);
  useEffect(() => { let alive = true; void client.initialize().then((value) => { if (alive) setSession(value); }, (cause) => { if (alive) setError(errorMessage(cause)); }); return () => { alive = false; }; }, [client]);
  useEffect(() => {
    if (active?.result.state !== "pending") return;
    const operationId = active.result.operationId;
    let alive = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await client.operation(operationId);
        if (!alive) return;
        setActive((current) => current?.result.operationId === operationId ? { ...current, result } : current);
        if (result.state === "complete") { setRevision((v) => v + 1); setNotice(result.message); return; }
        if (result.state !== "pending") return;
      } catch (cause) { if (alive) setError(errorMessage(cause)); }
      if (alive) timer = setTimeout(() => void poll(), 4000);
    };
    timer = setTimeout(() => void poll(), 4000);
    return () => { alive = false; clearTimeout(timer); };
  }, [client, active?.result.operationId, active?.result.state]);
  async function connect() {
    setConnecting(true); setError("");
    try { const result = await client.connect(); setSession(result); setRevision((v) => v + 1); return result; }
    catch (cause) { setError(errorMessage(cause)); throw cause; }
    finally { setConnecting(false); }
  }
  function connectQuietly() { void connect().catch(() => {}); }
  async function acquire(app: AppListing) {
    if (!session?.connected) { try { await connect(); } catch { return; } }
    setDetail(null); setCheckout([app]);
  }
  async function install(ids: string[]) {
    if (installing) return;
    setInstalling(true); setError("");
    try { const result = await client.install(ids); setNotice(result.message); setRevision((v) => v + 1); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setInstalling(false); }
  }
  function onOperation(result: OperationResult, resume?: () => Promise<OperationResult>) {
    setActive({ result, resume });
    setRevision((v) => v + 1);
    if (result.state === "complete") setNotice(result.message);
  }
  async function resumeSaved(item: OperationResult) {
    if (item.ethereumWallet !== "browser") return client.resumeOperation(item.operationId);
    const connection = await connectEthereumFundingBrowser();
    try { return await client.resumeOperation(item.operationId, connection); }
    finally { await connection.close().catch(() => undefined); }
  }
  async function cancelCheckout() {
    if (!active || tracking) return;
    setTracking(true); setError("");
    try { onOperation(await client.cancelEthereumCheckout(active.result.operationId)); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setTracking(false); }
  }
  async function verifyOriginalPayment() {
    if (!active || tracking) return;
    setTracking(true); setError("");
    try {
      const result = await client.verifyEthereumTransaction(active.result.operationId, recoveryHash.trim());
      onOperation(result, active.resume);
      if (result.entitled) { setTab("library"); setRecoveryHash(""); }
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setTracking(false); }
  }
  async function track(resume = false) {
    if (!active || tracking) return;
    setTracking(true); setError("");
    const captured = active;
    try {
      const result = resume && captured.resume ? await captured.resume() : await client.operation(captured.result.operationId);
      setActive((current) => current?.result.operationId === result.operationId ? { ...current, result } : current);
      if (result.state === "complete") { setRevision((v) => v + 1); setNotice(result.message); }
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setTracking(false); }
  }
  return <main className="nt-app mp-app"><div className="mp-shell">
    <header className="nt-app-header mp-header"><div className="nt-app-header-main"><span className="nt-app-header-icon mp-brand"><Icon name="store" /></span><div className="nt-app-header-copy"><h1 className="nt-app-header-title">Marketplace</h1><p className="nt-app-header-subtitle">Apps for your Neutron</p></div></div><div className="nt-app-header-actions">{session?.configured && <button type="button" className={`mp-connection nt-app-header-control ${session.connected ? "is-connected" : ""}`} disabled={connecting} title={session.account ?? "Connect your Neutron account"} onClick={session.connected ? () => setSettings(true) : connectQuietly}>{session.connected ? <><span className="mp-connection-dot" /><span className="mp-connected-label">Connected</span></> : connecting ? "Connecting…" : "Connect"}</button>}<button type="button" className="mp-icon-button nt-app-header-icon-button" aria-label="Refresh marketplace" title="Refresh" onClick={() => setRevision((v) => v + 1)}><Icon name="refresh" /></button><button type="button" className="mp-icon-button nt-app-header-icon-button" aria-label="Marketplace settings" title="Settings" onClick={() => setSettings(true)}><Icon name="settings" /></button></div></header>
    <nav className="mp-navigation" aria-label="Marketplace">{tabs.map((item) => <button type="button" className={`mp-nav-item${tab === item.id ? " is-active" : ""}`} aria-current={tab === item.id ? "page" : undefined} key={item.id} onClick={() => { setTab(item.id); if (item.id === "publish") setPublisherOpened(true); setError(""); }}><Icon name={item.icon} /><span>{item.title}</span></button>)}</nav>
    <div className="mp-body">
      <ErrorNote error={error} />
      {notice && <div className="mp-success" role="status"><Icon name="check" /><span>{notice}</span><button type="button" className="mp-icon-button" aria-label="Dismiss message" onClick={() => setNotice("")}><Icon name="close" /></button></div>}
      {active?.result.entitled && active.result.settlement?.state === "pending" && <div className="mp-notice" role="status"><strong>Payment conversion processing</strong><p>{active.result.settlement.message}</p></div>}
      {active && active.result.state !== "complete" && <section className="mp-operation" aria-live="polite"><div><strong>{active.result.state === "pending" ? "Waiting for confirmation" : active.result.state === "approval_required" ? "Approval needed" : active.result.state === "review_required" ? "Review needed" : "Action stopped"}</strong><p>{active.result.message}</p><details><summary>Saved request</summary><code>{active.result.operationId}</code>{(active.result.ethereumWallet || active.result.paymentRail === "ethereum") && <div className="mp-stack"><label>Original Ethereum payment hash<input value={recoveryHash} onChange={event => setRecoveryHash(event.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" disabled={tracking} /></label><p className="mp-muted">If your wallet sent the deposit but the reply was lost, verify that original transaction. This does not send another payment.</p><button type="button" className="mp-secondary" disabled={tracking || !/^0x[0-9a-fA-F]{64}$/.test(recoveryHash.trim())} onClick={() => void verifyOriginalPayment()}>Review & verify original payment</button><button type="button" className="mp-secondary" disabled={tracking} onClick={() => void cancelCheckout()}>Cancel checkout</button></div>}</details></div><div className="mp-button-row"><button type="button" className="mp-secondary" disabled={tracking} onClick={() => void track()}>{tracking ? "Checking…" : "Check status"}</button>{(active.result.nextAction === "resume" || active.result.nextAction === "review") && active.resume && <button type="button" className="mp-primary" disabled={tracking} onClick={() => void track(true)}>{active.result.ethereumWallet === "browser" ? "Connect wallet & continue" : active.result.nextAction === "review" ? "Review" : "Continue"}</button>}</div></section>}
      {!session && !error && <Loading label="Opening marketplace…" />}
      {session && !session.configured && <EmptyState title="Connect your marketplace" icon="store" action={<button type="button" className="mp-primary" onClick={() => setSettings(true)}>Set up marketplace <Icon name="arrow" /></button>}>Choose the marketplace canister to browse apps and restore this Neutron’s purchases.</EmptyState>}
      {tab === "library" && <ErrorNote error={saved.error ? `Saved action history unavailable: ${saved.error}` : ""} retry={() => setRevision((v) => v + 1)} />}
      {tab === "library" && saved.data && saved.data.filter((item) => item.state !== "complete" && item.operationId !== active?.result.operationId).map((item) => <section className="mp-operation" key={item.operationId}><strong>Saved action</strong><p>{item.message}</p><button className="mp-secondary" type="button" onClick={() => setActive({ result: item, resume: () => resumeSaved(item) })}>View saved progress</button></section>)}
      {session?.configured && (tab === "explore" ? <Explore key={session.canisterId} client={client} refresh={revision} select={setDetail} acquire={(app) => void acquire(app)} /> : tab === "library" ? <Library key={session.canisterId} client={client} connected={session.connected} connect={connectQuietly} refresh={revision} select={setDetail} install={(ids) => void install(ids)} installing={installing} explore={() => setTab("explore")} /> : tab === "earnings" ? <EarningsPanel key={session.canisterId} client={client} connected={session.connected} connect={connectQuietly} refresh={revision} onOperation={onOperation} /> : null)}
      {session?.configured && publisherOpened && <div hidden={tab !== "publish"}><PublisherPanel key={session.canisterId} client={client} connected={session.connected} connect={connect} refresh={revision} onChanged={() => setRevision((v) => v + 1)} /></div>}
    </div>
    {settings && <Settings session={session} client={client} close={() => setSettings(false)} changed={(value) => { setSession(value); setDetail(null); setCheckout(null); setActive(null); setPublisherOpened(false); setNotice(""); setRevision((v) => v + 1); }} />}
    {detail && <AppDetailDialog client={client} app={detail} close={() => setDetail(null)} acquire={(app) => void acquire(app)} install={(ids) => void install(ids)} connected={session?.connected ?? false} connect={connect} />}
    {checkout && <Checkout client={client} apps={checkout} close={() => setCheckout(null)} complete={(result) => { onOperation(result); setTab("library"); }} pending={onOperation} />}
    <AgentReviewHost />
  </div></main>;
}

function Explore({ client, refresh, select, acquire }: { client: MarketplaceClient; refresh: number; select: (app: AppListing) => void; acquire: (app: AppListing) => void }) {
  const [tier, setTier] = useState<AppTier>("free"), [window, setWindow] = useState<RankingWindow>("week"), [search, setSearch] = useState("");
  const [pages, setPages] = useState<AppListing[]>([]), [nextCursor, setNextCursor] = useState<string | null>(null), [paging, setPaging] = useState(false), [pageError, setPageError] = useState("");
  const key = JSON.stringify([tier, window, search.trim()]);
  const read = useRead(key, () => client.catalog({ tier, window, search: search.trim() }), refresh, search ? 200 : 0);
  useEffect(() => { setPages([]); setNextCursor(null); setPageError(""); }, [key, refresh]);
  const keyRef = useRef(key); keyRef.current = key;
  async function more() {
    const cursor = pages.length ? nextCursor : read.data?.nextCursor;
    if (!cursor || paging) return;
    const capturedKey = key; setPaging(true); setPageError("");
    try { const page = await client.catalog({ tier, window, search: search.trim(), cursor }); if (capturedKey === keyRef.current) { setPages((old) => [...old, ...page.items]); setNextCursor(page.nextCursor); } }
    catch (cause) { if (capturedKey === keyRef.current) setPageError(errorMessage(cause)); }
    finally { setPaging(false); }
  }
  const rows = [...(read.data?.items ?? []), ...pages].filter((app, index, all) => all.findIndex((other) => other.id === app.id) === index);
  return <div className="mp-explore"><label className="mp-search"><Icon name="search" /><span className="mp-sr-only">Search apps</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search apps" autoComplete="off" /></label><div className="mp-discovery-heading"><div><span className="mp-eyebrow">YOUR NEXT POSSIBILITY</span><h2>{search ? "Find your app" : "Small apps. More possibilities."}</h2></div><p>Choose your tools. Make them yours.</p></div><div className="mp-chart-controls"><div className="mp-segment" aria-label="App chart">{(["free", "paid"] as const).map((value) => <button type="button" key={value} aria-pressed={tier === value} onClick={() => setTier(value)}>Top {value}</button>)}</div><label><span className="mp-sr-only">Ranking period</span><select value={window} onChange={(event) => setWindow(event.target.value as RankingWindow)}><option value="week">7 days</option><option value="month">30 days</option><option value="all">All time</option></select></label></div><ErrorNote error={read.error || pageError} />{read.data?.warning && <p className="mp-notice">{read.data.warning}</p>}{read.loading && !read.data ? <div className="mp-app-grid" aria-label="Loading apps" aria-busy="true">{Array.from({ length: 6 }, (_, i) => <div className="mp-card-skeleton" key={i}><span /><div><i /><i /><i /></div></div>)}</div> : rows.length === 0 && !read.error ? <EmptyState title={search ? "No matching apps" : "New apps are on their way"} icon="search">{search ? "Try another app name or keyword." : "Approved releases appear here as publishers add them."}</EmptyState> : <div className="mp-app-grid">{rows.map((app, index) => <AppCard key={app.id} app={app} rank={search ? undefined : index + 1} select={() => select(app)} acquire={() => acquire(app)} />)}</div>}{(pages.length ? nextCursor : read.data?.nextCursor) && <button type="button" className="mp-secondary mp-load-more" disabled={paging} onClick={() => void more()}>{paging ? "Loading…" : "Show more apps"}</button>}{read.data?.asOf && <p className="mp-chart-footnote">Ranked by acquisitions · {dateLabel(read.data.asOf)}</p>}</div>;
}

function AppCard({ app, rank, select, acquire }: { app: AppListing; rank?: number | undefined; select: () => void; acquire: () => void }) {
  return <article className="mp-app-card"><button className="mp-card-main" type="button" onClick={select}>{rank !== undefined && <span className="mp-rank">{rank}</span>}<AppIcon app={app} /><span className="mp-card-copy"><strong>{app.title}</strong><span className="mp-card-category">{app.category}</span><span className="mp-card-summary">{app.summary}</span></span></button><div className="mp-card-bottom"><span className="mp-rating">{app.rating === null ? "New" : <>{app.rating.toFixed(1)} <span aria-hidden="true">★</span> <small>({app.ratingCount.toLocaleString()})</small></>}</span><button type="button" className="mp-get-button" onClick={app.owned ? select : acquire}>{app.owned ? "Owned" : usd(app.priceUsdMicros)}</button></div></article>;
}

function Library({ client, connected, connect, refresh, select, install, installing, explore }: { client: MarketplaceClient; connected: boolean; connect: () => void; refresh: number; select: (app: AppListing) => void; install: (ids: string[]) => void; installing: boolean; explore: () => void }) {
  const read = useRead(connected ? "library" : null, () => client.library(), refresh);
  const [selected, setSelected] = useState<Set<string>>(new Set()), [more, setMore] = useState<Page<LibraryApp> | null>(null), [paging, setPaging] = useState(false), [error, setError] = useState("");
  useEffect(() => { setMore(null); setSelected(new Set()); }, [refresh, connected]);
  const apps = [...(read.data?.items ?? []), ...(more?.items ?? [])].filter((app, index, all) => all.findIndex((other) => other.id === app.id) === index);
  const installable = apps.filter((app) => app.available && !app.installedVersion);
  const actualSelected = [...selected].filter((id) => installable.some((app) => app.id === id));
  if (!connected) return <EmptyState title="Your apps, always here" action={<button type="button" className="mp-primary" onClick={connect}>Connect this Neutron</button>}>Restore your library, install several apps at once, and reinstall whenever you need them.</EmptyState>;
  async function next() {
    const cursor = more ? more.nextCursor : read.data?.nextCursor; if (!cursor || paging) return;
    setPaging(true); setError("");
    try { const page = await client.library(cursor); setMore((old) => ({ ...page, items: [...(old?.items ?? []), ...page.items] })); }
    catch (cause) { setError(errorMessage(cause)); } finally { setPaging(false); }
  }
  return <div className="mp-stack"><div className="mp-section-title"><div><h2>My Apps</h2><p>Owned by this Neutron. Yours to install again.</p></div><button className="mp-text-button" type="button" onClick={explore}>Explore apps <Icon name="arrow" /></button></div><ErrorNote error={read.error || error} />{read.loading && !read.data ? <Loading label="Loading your apps…" /> : apps.length === 0 && !read.error ? <EmptyState title="Make room for something useful" action={<button type="button" className="mp-primary" onClick={explore}>Explore apps</button>}>Your free and purchased apps will be saved here, even after uninstalling them.</EmptyState> : <><div className="mp-library-toolbar"><label className="mp-check-label"><input type="checkbox" checked={installable.length > 0 && actualSelected.length === installable.length} onChange={(event) => setSelected(new Set(event.target.checked ? installable.map((app) => app.id) : []))} disabled={installable.length === 0 || installing} />Select available</label><span className="mp-muted">{apps.length} {apps.length === 1 ? "app" : "apps"}</span></div><div className="mp-library-list">{apps.map((app) => <article className="mp-library-row" key={app.id}><input type="checkbox" aria-label={`Select ${app.title}`} checked={selected.has(app.id)} disabled={!app.available || !!app.installedVersion || installing} onChange={(event) => setSelected((old) => { const next = new Set(old); event.target.checked ? next.add(app.id) : next.delete(app.id); return next; })} /><button type="button" className="mp-library-app" onClick={() => select(app)}><AppIcon app={app} /><span><strong>{app.title}</strong><small>{app.available ? app.installedVersion === app.version ? "Installed · Up to date" : app.installedVersion ? `Update to ${app.version} in Settings` : "Ready to install" : app.unavailableReason || "Waiting for an approved release"}</small></span></button><button type="button" className="mp-get-button" disabled={!app.available || !!app.installedVersion || installing} onClick={() => install([app.id])}>{app.installedVersion ? "Installed" : "Install"}</button></article>)}</div>{(more ? more.nextCursor : read.data?.nextCursor) && <button type="button" className="mp-secondary mp-load-more" disabled={paging} onClick={() => void next()}>{paging ? "Loading…" : "Load more"}</button>}{actualSelected.length > 0 && <div className="mp-selection-bar"><span>{actualSelected.length} selected</span><button type="button" className="mp-primary" disabled={installing} onClick={() => install(actualSelected)}><Icon name="download" />{installing ? "Opening install review…" : "Install selected"}</button></div>}</>}</div>;
}

function Settings({ client, session, close, changed }: { client: MarketplaceClient; session: Session | null; close: () => void; changed: (session: Session) => void }) {
  const [canisterId, setCanisterId] = useState(session?.canisterId ?? ""), [host, setHost] = useState(session?.host ?? "https://icp-api.io"), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function save() { setBusy(true); setError(""); try { const value = await client.configure({ canisterId: canisterId.trim(), host: host.trim() }); changed(value); close(); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); } }
  return <Modal title="Marketplace settings" close={close} footer={<button type="button" className="mp-primary" disabled={busy || !canisterId.trim()} onClick={() => void save()}>{busy ? "Saving…" : "Save settings"}</button>}><div className="mp-stack">{session?.account && <div className="mp-account-card"><span className="mp-muted">Purchases belong to this Neutron</span><strong title={session.account}>{shortPrincipal(session.account)}</strong><p>Your library stays with this account after an app is uninstalled.</p></div>}<label>Marketplace canister<input value={canisterId} autoComplete="off" onChange={(event) => setCanisterId(event.target.value)} placeholder="Canister principal ID" /></label><details><summary>Connection details</summary><label>IC gateway<input type="url" value={host} onChange={(event) => setHost(event.target.value)} /></label></details><p className="mp-muted">Changing marketplaces changes the catalog and library shown here. It does not delete previous purchases.</p><ErrorNote error={error} /></div></Modal>;
}
