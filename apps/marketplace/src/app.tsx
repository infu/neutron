import { useEffect, useMemo, useRef, useState } from "react";
import { connectEthereumFundingBrowser } from "./ethereum.ts";
import { createMarketplaceClient } from "./tile_client.ts";
import type { AppListing, AppTier, LibraryApp, MarketplaceClient, OperationResult, Page, RankingWindow, Session, InstallationQuote } from "./view-types.ts";
import { Checkout } from "./components/checkout.tsx";
import { AppDetailDialog } from "./components/detail.tsx";
import { EarningsPanel } from "./components/earnings.tsx";
import { PublisherPanel } from "./components/publisher.tsx";
import { InstallControl } from "./components/install.tsx";
import { AgentReviewHost } from "./components/agent_review.tsx";
import { AppIcon, EmptyState, ErrorNote, Icon, Loading, Modal, dateLabel, errorMessage, shortPrincipal, usd, useRead } from "./components/primitives.tsx";

type Tab = "explore" | "library" | "publish" | "earnings";
type ActiveOperation = { result: OperationResult; resume?: (() => Promise<OperationResult>) | undefined };
const tabs = [{ id: "explore", title: "Explore", icon: "store" }, { id: "library", title: "My Apps", icon: "apps" }, { id: "publish", title: "Publish", icon: "publish" }, { id: "earnings", title: "Earnings", icon: "earnings" }] as const;

export default function App({ client: suppliedClient }: { client?: MarketplaceClient }) {
  const client: MarketplaceClient = useMemo(() => suppliedClient ?? createMarketplaceClient(), [suppliedClient]);
  const [session, setSession] = useState<Session | null>(null), [tab, setTab] = useState<Tab>("explore");
  const [revision, setRevision] = useState(0), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [initializing, setInitializing] = useState(true), [setupError, setSetupError] = useState(""), [settings, setSettings] = useState(false);
  const setupInFlight = useRef<Promise<Session> | null>(null);
  const [detail, setDetail] = useState<AppListing | null>(null), [checkout, setCheckout] = useState<AppListing[] | null>(null);
  const [active, setActive] = useState<ActiveOperation | null>(null), [tracking, setTracking] = useState(false), [installing, setInstalling] = useState(false);
  const [publisherOpened, setPublisherOpened] = useState(false);
  const installActive = useRef(false);
  const [recoveryHash, setRecoveryHash] = useState("");
  const saved = useRead(session?.connected ? `${session.canisterId}:operations` : null, () => client.recentOperations(), revision);
  useEffect(() => {
    let alive = true;
    setInitializing(true); setSetupError(""); setSession(null);
    void client.initialize().then((value) => {
      if (alive) { setSession(value); setSetupError(value.connectionError ?? ""); }
    }, (cause) => { if (alive) setSetupError(errorMessage(cause)); }).finally(() => { if (alive) setInitializing(false); });
    return () => { alive = false; };
  }, [client]);
  useEffect(() => {
    if (active?.result.state !== "pending" || active.result.installation) return;
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
    if (setupInFlight.current) return setupInFlight.current;
    setInitializing(true); setSetupError("");
    const pending = (session ? client.connect() : client.initialize()).then((value) => {
      setSession(value);
      if (value.connectionError) throw new Error(value.connectionError);
      setRevision((v) => v + 1);
      return value;
    }).catch((cause) => { setSetupError(errorMessage(cause)); throw cause; }).finally(() => {
      setupInFlight.current = null; setInitializing(false);
    });
    setupInFlight.current = pending;
    return pending;
  }
  function retrySetup() { void connect().catch(() => {}); }
  async function acquire(app: AppListing) {
    if (!session?.connected) { try { await connect(); } catch { return; } }
    setDetail(null); setCheckout([app]);
  }
  async function install(ids: string[], quote: InstallationQuote) {
    if (installActive.current) return;
    installActive.current = true;
    setInstalling(true); setError("");
    try { const result = await client.install(ids, quote); onOperation(result, () => resumeSaved(result)); }
    catch (cause) { setError(errorMessage(cause)); setRevision((v) => v + 1); throw cause; }
    finally { installActive.current = false; setInstalling(false); }
  }
  function onOperation(result: OperationResult, resume?: () => Promise<OperationResult>) {
    setActive({ result, resume });
    setRevision((v) => v + 1);
    if (result.state === "complete") setNotice(result.message);
  }
  async function resumeSaved(item: OperationResult) {
    if (item.installation?.setupUrl) return client.openInstallation(item.installation);
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
      const result = resume && captured.result.installation?.setupUrl ? await client.openInstallation(captured.result.installation) : resume && captured.resume ? await captured.resume() : await client.operation(captured.result.operationId);
      setActive((current) => current?.result.operationId === result.operationId ? { ...current, result } : current);
      if (result.state === "complete") { setRevision((v) => v + 1); setNotice(result.message); }
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setTracking(false); }
  }
  return <main className="nt-app mp-app"><div className="mp-shell">
    <header className="nt-app-header mp-header"><div className="nt-app-header-main"><span className="nt-app-header-icon mp-brand"><Icon name="store" /></span><div className="nt-app-header-copy"><h1 className="nt-app-header-title">Marketplace</h1><p className="nt-app-header-subtitle">Apps for your Neutron</p></div></div><div className="nt-app-header-actions"><button type="button" className="mp-icon-button nt-app-header-icon-button" aria-label="Refresh marketplace" title="Refresh" onClick={() => setRevision((v) => v + 1)}><Icon name="refresh" /></button><button type="button" className="mp-icon-button nt-app-header-icon-button" aria-label="Marketplace settings" title="Settings" onClick={() => setSettings(true)}><Icon name="settings" /></button></div></header>
    <nav className="mp-navigation" aria-label="Marketplace">{tabs.map((item) => <button type="button" className={`mp-nav-item${tab === item.id ? " is-active" : ""}`} aria-current={tab === item.id ? "page" : undefined} key={item.id} onClick={() => { setTab(item.id); if (item.id === "publish") setPublisherOpened(true); setError(""); }}><Icon name={item.icon} /><span>{item.title}</span></button>)}</nav>
    <div className="mp-body">
      {setupError && <div className="mp-error mp-setup-error" role="alert"><div><strong>Marketplace setup is unavailable</strong><p>{setupError}</p></div><button type="button" className="mp-secondary" disabled={initializing} onClick={retrySetup}>{initializing ? "Retrying…" : "Retry setup"}</button></div>}
      {initializing && <Loading label={session?.configured ? "Preparing your apps…" : "Opening marketplace…"} />}
      <ErrorNote error={error} />
      {notice && <div className="mp-success" role="status"><Icon name="check" /><span>{notice}</span><button type="button" className="mp-icon-button" aria-label="Dismiss message" onClick={() => setNotice("")}><Icon name="close" /></button></div>}
      {active?.result.entitled && active.result.settlement?.state === "pending" && <div className="mp-notice" role="status"><strong>Payment conversion processing</strong><p>{active.result.settlement.message}</p></div>}
      {active && active.result.state !== "complete" && <section className="mp-operation" aria-live="polite"><div><strong>{active.result.installation ? active.result.installation.setupUrl ? "Ready to install" : "Review installation" : active.result.state === "pending" ? "Waiting for confirmation" : active.result.state === "approval_required" ? "Approval needed" : active.result.state === "review_required" ? "Review needed" : "Action stopped"}</strong><p>{active.result.message}</p><details><summary>Saved request</summary><code>{active.result.operationId}</code>{(active.result.ethereumWallet || active.result.paymentRail === "ethereum") && <div className="mp-stack"><label>Original Ethereum payment hash<input value={recoveryHash} onChange={event => setRecoveryHash(event.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" disabled={tracking} /></label><p className="mp-muted">If your wallet sent the deposit but the reply was lost, verify that original transaction. This does not send another payment.</p><button type="button" className="mp-secondary" disabled={tracking || !/^0x[0-9a-fA-F]{64}$/.test(recoveryHash.trim())} onClick={() => void verifyOriginalPayment()}>Review & verify original payment</button><button type="button" className="mp-secondary" disabled={tracking} onClick={() => void cancelCheckout()}>Cancel checkout</button></div>}</details></div><div className="mp-button-row"><button type="button" className="mp-secondary" disabled={tracking} onClick={() => void track()}>{tracking ? "Checking…" : "Check status"}</button>{active.result.installation && active.result.nextAction !== "none" && <InstallControl key={active.result.operationId} client={client} appIds={active.result.installation.appIds} preparedQuote={active.result.installation.setupUrl ? active.result.installation : undefined} busy={installing || tracking} label="Install" className="mp-primary" onInstall={install} />}{!active.result.installation && (active.result.nextAction === "resume" || active.result.nextAction === "review") && active.resume && <button type="button" className="mp-primary" disabled={tracking} onClick={() => void track(true)}>{active.result.ethereumWallet === "browser" ? "Connect wallet & continue" : active.result.nextAction === "review" ? "Review" : "Continue"}</button>}</div></section>}
      {session && !session.configured && <EmptyState title="Choose your marketplace" icon="store" action={<button type="button" className="mp-primary" onClick={() => setSettings(true)}>Set up marketplace <Icon name="arrow" /></button>}>Choose the marketplace canister to browse apps and restore this Neutron’s purchases.</EmptyState>}
      {tab === "library" && <ErrorNote error={saved.error ? `Saved action history unavailable: ${saved.error}` : ""} retry={() => setRevision((v) => v + 1)} />}
      {tab === "library" && saved.data && saved.data.filter((item) => item.state !== "complete" && item.operationId !== active?.result.operationId).map((item) => <section className="mp-operation" key={item.operationId}><strong>Saved action</strong><p>{item.message}</p><button className="mp-secondary" type="button" onClick={() => setActive({ result: item, resume: () => resumeSaved(item) })}>View saved progress</button></section>)}
      {session?.configured && (tab === "explore" ? <Explore key={session.canisterId} client={client} refresh={revision} select={setDetail} acquire={(app) => void acquire(app)} /> : tab === "library" ? <Library key={`${session.canisterId}:${session.account ?? ""}`} client={client} connected={session.connected} refresh={revision} select={setDetail} install={(ids, quote) => install(ids, quote)} installing={installing} explore={() => setTab("explore")} /> : tab === "earnings" ? <EarningsPanel key={session.canisterId} client={client} connected={session.connected} refresh={revision} onOperation={onOperation} /> : null)}
      {session?.configured && publisherOpened && <div hidden={tab !== "publish"}><PublisherPanel key={session.canisterId} client={client} connected={session.connected} refresh={revision} onChanged={() => setRevision((v) => v + 1)} /></div>}
    </div>
    {settings && <Settings session={session} client={client} close={() => setSettings(false)} changed={(value) => { setSession(value); setDetail(null); setCheckout(null); setActive(null); setPublisherOpened(false); setNotice(""); setSetupError(value.connectionError ?? ""); setRevision((v) => v + 1); }} />}
    {detail && <AppDetailDialog key={`${session?.canisterId ?? ""}:${session?.account ?? ""}:${detail.id}`} client={client} app={detail} installing={installing} close={() => setDetail(null)} acquire={(app) => void acquire(app)} install={(ids, quote) => install(ids, quote)} connected={session?.connected ?? false} connect={connect} />}
    {checkout && <Checkout client={client} apps={checkout} close={() => setCheckout(null)} complete={(result) => { onOperation(result); setTab("library"); }} pending={onOperation} />}
    <AgentReviewHost />
  </div></main>;
}

function Explore({ client, refresh, select, acquire }: { client: MarketplaceClient; refresh: number; select: (app: AppListing) => void; acquire: (app: AppListing) => void }) {
  const [window, setWindow] = useState<RankingWindow>("week"), [search, setSearch] = useState("");
  return <div className="mp-explore">
    <label className="mp-search"><Icon name="search" /><span className="mp-sr-only">Search apps</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search apps" autoComplete="off" /></label>
    <div className="mp-chart-controls"><h2>{search ? "Search results" : "Discover apps"}</h2><label><span className="mp-sr-only">Ranking period</span><select value={window} onChange={(event) => setWindow(event.target.value as RankingWindow)}><option value="week">7 days</option><option value="month">30 days</option><option value="all">All time</option></select></label></div>
    {(["paid", "free"] as const).map((tier) => <CatalogSection key={JSON.stringify([tier, window, search.trim(), refresh])} client={client} tier={tier} window={window} search={search.trim()} select={select} acquire={acquire} />)}
  </div>;
}

function CatalogSection({ client, tier, window, search, select, acquire }: { client: MarketplaceClient; tier: AppTier; window: RankingWindow; search: string; select: (app: AppListing) => void; acquire: (app: AppListing) => void }) {
  const [pages, setPages] = useState<AppListing[]>([]), [nextCursor, setNextCursor] = useState<string | null | undefined>(undefined), [paging, setPaging] = useState(false), [pageError, setPageError] = useState(""), [retry, setRetry] = useState(0);
  const read = useRead(JSON.stringify([tier, window, search]), () => client.catalog({ tier, window, search }), retry, search ? 200 : 0);
  const pagingActive = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const cursor = nextCursor === undefined ? read.data?.nextCursor : nextCursor;
  async function more() {
    if (!cursor || pagingActive.current) return;
    pagingActive.current = true; setPaging(true); setPageError("");
    try {
      const page = await client.catalog({ tier, window, search, cursor });
      if (alive.current) { setPages((old) => [...old, ...page.items]); setNextCursor(page.nextCursor); }
    } catch (cause) { if (alive.current) setPageError(errorMessage(cause)); }
    finally { pagingActive.current = false; if (alive.current) setPaging(false); }
  }
  const rows = [...(read.data?.items ?? []), ...pages].filter((app, index, all) => all.findIndex((other) => other.id === app.id) === index);
  const title = `${search ? "" : "Top "}${tier}`;
  return <section className="mp-catalog-section" aria-label={search ? `${tier === "paid" ? "Paid" : "Free"} apps` : title}>
    <h3>{search ? `${tier === "paid" ? "Paid" : "Free"} apps` : title}</h3>
    <ErrorNote error={read.error} retry={() => setRetry((value) => value + 1)} /><ErrorNote error={pageError} retry={() => void more()} />
    {read.data?.warning && <p className="mp-notice">{read.data.warning}</p>}
    {read.loading && !read.data ? <div className="mp-app-grid" aria-label={`Loading ${tier} apps`} aria-busy="true">{Array.from({ length: 3 }, (_, i) => <div className="mp-card-skeleton" key={i}><span /><div><i /><i /><i /></div></div>)}</div> : rows.length === 0 && !read.error ? <p className="mp-catalog-empty">{search ? `No matching ${tier} apps.` : `New ${tier} apps are on their way.`}</p> : <div className="mp-app-grid">{rows.map((app) => <AppCard key={app.id} app={app} select={() => select(app)} acquire={() => acquire(app)} />)}</div>}
    {cursor && <button type="button" className="mp-secondary mp-load-more" disabled={paging} onClick={() => void more()}>{paging ? "Loading…" : `Show more ${tier} apps`}</button>}
    {read.data?.asOf && <p className="mp-chart-footnote">Ranked by acquisitions · {dateLabel(read.data.asOf)}</p>}
  </section>;
}

function AppCard({ app, select, acquire }: { app: AppListing; select: () => void; acquire: () => void }) {
  return <article className="mp-app-card"><button className="mp-card-main" type="button" onClick={select}><AppIcon app={app} /><span className="mp-card-copy"><strong>{app.title}</strong><span className="mp-card-category">{app.category}</span><span className="mp-card-summary">{app.summary}</span></span></button><div className="mp-card-bottom"><span className="mp-rating">{app.rating === null ? "New" : <>{app.rating.toFixed(1)} <span aria-hidden="true">★</span> <small>({app.ratingCount.toLocaleString()})</small></>}</span><button type="button" className="mp-get-button" onClick={app.owned ? select : acquire}>{app.owned ? "Owned" : usd(app.priceUsdMicros)}</button></div></article>;
}

function Library({ client, connected, refresh, select, install, installing, explore }: { client: MarketplaceClient; connected: boolean; refresh: number; select: (app: AppListing) => void; install: (ids: string[], quote: InstallationQuote) => void | Promise<void>; installing: boolean; explore: () => void }) {
  const read = useRead(connected ? "library" : null, () => client.library(), refresh);
  const [selected, setSelected] = useState<Set<string>>(new Set()), [more, setMore] = useState<Page<LibraryApp> | null>(null), [paging, setPaging] = useState(false), [error, setError] = useState("");
  useEffect(() => { setMore(null); setSelected(new Set()); }, [refresh, connected]);
  const apps = [...(read.data?.items ?? []), ...(more?.items ?? [])].filter((app, index, all) => all.findIndex((other) => other.id === app.id) === index);
  const installable = apps.filter((app) => app.available && !app.installedVersion);
  const actualSelected = [...selected].filter((id) => installable.some((app) => app.id === id));
  if (!connected) return <EmptyState title="Your library is unavailable">Retry setup above to load the apps owned by this Neutron.</EmptyState>;
  async function next() {
    const cursor = more ? more.nextCursor : read.data?.nextCursor; if (!cursor || paging) return;
    setPaging(true); setError("");
    try { const page = await client.library(cursor); setMore((old) => ({ ...page, items: [...(old?.items ?? []), ...page.items] })); }
    catch (cause) { setError(errorMessage(cause)); } finally { setPaging(false); }
  }
  return <div className="mp-stack"><div className="mp-section-title"><div><h2>My Apps</h2><p>Owned by this Neutron. Yours to install again.</p></div><button className="mp-text-button" type="button" onClick={explore}>Explore apps <Icon name="arrow" /></button></div><ErrorNote error={read.error || error} />{read.loading && !read.data ? <Loading label="Loading your apps…" /> : apps.length === 0 && !read.error ? <EmptyState title="Make room for something useful" action={<button type="button" className="mp-primary" onClick={explore}>Explore apps</button>}>Your free and purchased apps will be saved here, even after uninstalling them.</EmptyState> : <><div className="mp-library-toolbar"><label className="mp-check-label"><input type="checkbox" checked={installable.length > 0 && actualSelected.length === installable.length} onChange={(event) => setSelected(new Set(event.target.checked ? installable.map((app) => app.id) : []))} disabled={installable.length === 0 || installing} />Select available</label><span className="mp-muted">{apps.length} {apps.length === 1 ? "app" : "apps"}</span></div><div className="mp-library-list">{apps.map((app) => <article className="mp-library-row" key={app.id}><input type="checkbox" aria-label={`Select ${app.title}`} checked={selected.has(app.id)} disabled={!app.available || !!app.installedVersion || installing} onChange={(event) => setSelected((old) => { const next = new Set(old); event.target.checked ? next.add(app.id) : next.delete(app.id); return next; })} /><button type="button" className="mp-library-app" onClick={() => select(app)}><AppIcon app={app} /><span><strong>{app.title}</strong><small>{app.available ? app.installedVersion === app.version ? "Installed · Up to date" : app.installedVersion ? `Update to ${app.version} in Settings` : "Ready to install" : app.unavailableReason || "Waiting for an approved release"}</small></span></button><InstallControl client={client} appIds={[app.id]} disabled={!app.available || !!app.installedVersion} busy={installing} label={app.installedVersion ? "Installed" : "Install"} className="mp-get-button" onInstall={install} /></article>)}</div>{(more ? more.nextCursor : read.data?.nextCursor) && <button type="button" className="mp-secondary mp-load-more" disabled={paging} onClick={() => void next()}>{paging ? "Loading…" : "Load more"}</button>}{actualSelected.length > 0 && <div className="mp-selection-bar"><span>{actualSelected.length} selected</span><InstallControl client={client} appIds={actualSelected} busy={installing} label="Install selected" className="mp-primary" onInstall={install} /></div>}</>}</div>;
}

function Settings({ client, session, close, changed }: { client: MarketplaceClient; session: Session | null; close: () => void; changed: (session: Session) => void }) {
  const [canisterId, setCanisterId] = useState(session?.canisterId ?? ""), [host, setHost] = useState(session?.host ?? "https://icp-api.io"), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function save() { setBusy(true); setError(""); try { const value = await client.configure({ canisterId: canisterId.trim(), host: host.trim() }); changed(value); close(); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); } }
  return <Modal title="Marketplace settings" close={close} footer={<button type="button" className="mp-primary" disabled={busy || !canisterId.trim()} onClick={() => void save()}>{busy ? "Saving…" : "Save settings"}</button>}><div className="mp-stack">{session?.account && <div className="mp-account-card"><span className="mp-muted">Purchases belong to this Neutron</span><strong title={session.account}>{shortPrincipal(session.account)}</strong><p>Your library stays with this account after an app is uninstalled.</p></div>}<label>Marketplace canister<input value={canisterId} autoComplete="off" onChange={(event) => setCanisterId(event.target.value)} placeholder="Canister principal ID" /></label><details><summary>Connection details</summary><label>IC gateway<input type="url" value={host} onChange={(event) => setHost(event.target.value)} /></label></details><p className="mp-muted">Changing marketplaces changes the catalog and library shown here. It does not delete previous purchases.</p><ErrorNote error={error} /></div></Modal>;
}
