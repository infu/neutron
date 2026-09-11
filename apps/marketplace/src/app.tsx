import { useEffect, useMemo, useRef, useState } from "react";
import { connectEthereumFundingBrowser } from "./ethereum.ts";
import { createMarketplaceClient } from "./tile_client.ts";
import type { AppListing, AppTier, LibraryApp, MarketplaceClient, OperationResult, Page, RankingWindow, Session, InstallationQuote, DiscountPreference } from "./view-types.ts";
import { Checkout } from "./components/checkout.tsx";
import { AppDetailDialog } from "./components/detail.tsx";
import { EarningsPanel } from "./components/earnings.tsx";
import { PublisherPanel } from "./components/publisher.tsx";
import { InstallControl } from "./components/install.tsx";
import { NotificationsPanel, NotificationBell } from "./components/notifications.tsx";
import { notificationAttentionCount } from "./notification-state.ts";
import { AppPrice, DiscountCodeDialog, discountPercent, noDiscount } from "./components/discount.tsx";
import { AgentReviewHost } from "./components/agent_review.tsx";
import { AppIcon, EmptyState, ErrorNote, Icon, Loading, acquisitionStats, dateLabel, errorMessage, useRead } from "./components/primitives.tsx";

type Tab = "explore" | "library" | "publish" | "earnings" | "activity";
type ActiveOperation = { result: OperationResult; resume?: (() => Promise<OperationResult>) | undefined };
const tabs = [{ id: "explore", title: "Explore", icon: "store" }, { id: "library", title: "My Apps", icon: "apps" }, { id: "publish", title: "Publish", icon: "publish" }, { id: "earnings", title: "Earnings", icon: "earnings" }] as const;

export default function App({ client: suppliedClient }: { client?: MarketplaceClient }) {
  const client: MarketplaceClient = useMemo(() => suppliedClient ?? createMarketplaceClient(), [suppliedClient]);
  const [session, setSession] = useState<Session | null>(null), [tab, setTab] = useState<Tab>("explore");
  const [revision, setRevision] = useState(0);
  const [discount, setDiscount] = useState<DiscountPreference>(noDiscount), [discountOpen, setDiscountOpen] = useState(false), [discountRevision, setDiscountRevision] = useState(0);
  const discountGeneration = useRef(0);
  const [observations, setObservations] = useState<Record<string, OperationResult>>({}), [activityError, setActivityError] = useState("");
  const observationSequence = useRef(0), observationVersions = useRef<Record<string, number>>({});
  const [initializing, setInitializing] = useState(true), [setupError, setSetupError] = useState("");
  const setupInFlight = useRef<Promise<Session> | null>(null);
  const [detail, setDetail] = useState<AppListing | null>(null), [checkout, setCheckout] = useState<AppListing[] | null>(null);
  const [active, setActive] = useState<ActiveOperation | null>(null), [installing, setInstalling] = useState(false);
  const [publisherOpened, setPublisherOpened] = useState(false);
  const installActive = useRef(false);
  const saved = useRead(session?.connected ? `${session.canisterId}:operations` : null, async () => {
    const startedAt = observationSequence.current;
    return { operations: await client.recentOperations(), startedAt };
  }, revision);
  useEffect(() => {
    if (!saved.data) return;
    const fresh = saved.data;
    const superseded = fresh.operations.filter(item => (observationVersions.current[item.operationId] ?? 0) <= fresh.startedAt);
    if (!superseded.length) return;
    for (const item of superseded) observationVersions.current[item.operationId] = ++observationSequence.current;
    setObservations(current => {
      const next = { ...current };
      for (const item of superseded) delete next[item.operationId];
      return next;
    });
    setActive(current => {
      const result = current && superseded.find(item => item.operationId === current.result.operationId);
      return result && current ? { ...current, result } : current;
    });
  }, [saved.data]);
  function recordObservation(result: OperationResult) {
    observationVersions.current[result.operationId] = ++observationSequence.current;
    setObservations(current => ({ ...current, [result.operationId]: result }));
  }
  useEffect(() => {
    let alive = true;
    setActive(null); setObservations({}); observationVersions.current = {}; setDiscount(noDiscount); setActivityError("");
    setInitializing(true); setSetupError(""); setSession(null);
    void client.initialize().then((value) => {
      if (alive) { setSession(value); setSetupError(value.connectionError ?? ""); }
    }, (cause) => { if (alive) setSetupError(errorMessage(cause)); }).finally(() => { if (alive) setInitializing(false); });
    return () => { alive = false; };
  }, [client]);
  useEffect(() => {
    if (!session?.connected) return;
    const generation = ++discountGeneration.current;
    let alive = true;
    void client.discount().then(value => { if (alive && generation === discountGeneration.current) setDiscount(value); }, cause => {
      if (alive && generation === discountGeneration.current) setDiscount(current => ({ ...current, active: false, error: errorMessage(cause) }));
    });
    return () => { alive = false; };
  }, [client, session?.canisterId, session?.account, session?.connected, discountRevision]);
  function changeDiscount(value: DiscountPreference) { ++discountGeneration.current; setDiscount(value); }
  const operations = [...Object.values(observations).reverse(), ...(saved.data?.operations ?? [])];
  const attentionCount = notificationAttentionCount(operations);
  useEffect(() => {
    if (active?.result.state !== "pending" || active.result.installation) return;
    const operationId = active.result.operationId;
    let alive = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const startedAt = observationVersions.current[operationId] ?? 0;
        const result = await client.operation(operationId);
        if (!alive) return;
        if ((observationVersions.current[operationId] ?? 0) !== startedAt) { timer = setTimeout(() => void poll(), 4000); return; }
        setActive((current) => current?.result.operationId === operationId ? { ...current, result } : current);
        recordObservation(result);
        setActivityError("");
        if (result.state === "complete") { setRevision((v) => v + 1); return; }
        if (result.state !== "pending") return;
      } catch (cause) { if (alive) setActivityError(errorMessage(cause)); }
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
    setInstalling(true);
    try {
      const result = await client.install(ids, quote);
      if (result.state === "failed" || result.state === "review_required" || result.state === "approval_required") throw new Error(result.message);
      // The Kernel owns its installation review. Keep the saved request for
      // retry, without turning a review handoff into a payment-progress card.
      setDetail(null);
      setRevision((v) => v + 1);
    }
    finally { installActive.current = false; setInstalling(false); }
  }
  function onOperation(result: OperationResult, resume?: () => Promise<OperationResult>) {
    setActive({ result, resume });
    setRevision((v) => v + 1);
    recordObservation(result);
    setActivityError("");
  }
  async function resumeSaved(item: OperationResult) {
    if (item.ethereumWallet !== "browser") return client.resumeOperation(item.operationId);
    const connection = await connectEthereumFundingBrowser();
    try { return await client.resumeOperation(item.operationId, connection); }
    finally { await connection.close().catch(() => undefined); }
  }
  async function observe(action: Promise<OperationResult>) {
    const result = await action;
    onOperation(result, active?.result.operationId === result.operationId ? active.resume : undefined);
    return result;
  }
  function resumeOperation(item: OperationResult) {
    return observe(active?.result.operationId === item.operationId && active.resume ? active.resume() : resumeSaved(item));
  }
  return <main className="nt-app mp-app"><div className="mp-shell">
    <header className="nt-app-header mp-header"><div className="nt-app-header-main"><span className="nt-app-header-icon mp-brand"><Icon name="store" /></span><div className="nt-app-header-copy"><h1 className="nt-app-header-title">Marketplace</h1><p className="nt-app-header-subtitle">Apps for your Neutron</p></div></div><div className="nt-app-header-actions"><button type="button" className={`mp-icon-button nt-app-header-icon-button mp-discount-button${discount.active ? " is-active" : ""}`} aria-label={discount.active ? `Discount code, ${discountPercent(discount.discountBps)} activated` : "Discount code"} title={discount.active ? `${discountPercent(discount.discountBps)} discount activated` : "Discount code"} onClick={() => setDiscountOpen(true)}><Icon name="discount" />{discount.active && <span className="mp-discount-indicator"><Icon name="check" /></span>}</button><button type="button" className="mp-icon-button nt-app-header-icon-button" aria-label="Refresh marketplace" title="Refresh" onClick={() => { setRevision(v => v + 1); setDiscountRevision(v => v + 1); }}><Icon name="refresh" /></button></div></header>
    <nav className="mp-navigation" aria-label="Marketplace">{tabs.map((item) => <button type="button" className={`mp-nav-item${tab === item.id ? " is-active" : ""}`} aria-current={tab === item.id ? "page" : undefined} key={item.id} onClick={() => { setTab(item.id); if (item.id === "publish") setPublisherOpened(true); }}><Icon name={item.icon} /><span>{item.title}</span></button>)}<button type="button" className={`mp-nav-item mp-activity-tab${tab === "activity" ? " is-active" : ""}`} aria-label="Activity" title={attentionCount ? `Activity · ${attentionCount} need attention` : "Activity"} aria-current={tab === "activity" ? "page" : undefined} onClick={() => setTab("activity")}><NotificationBell />{attentionCount > 0 && <span className="mp-notification-badge" aria-hidden="true">{attentionCount > 99 ? "99+" : attentionCount}</span>}</button></nav>
    <div className="mp-body">
      {setupError && <div className="mp-error mp-setup-error" role="alert"><div><strong>Marketplace setup is unavailable</strong><p>{setupError}</p></div><button type="button" className="mp-secondary" disabled={initializing} onClick={retrySetup}>{initializing ? "Retrying…" : "Retry setup"}</button></div>}
      {initializing && <Loading label={session?.configured ? "Preparing your apps…" : "Opening marketplace…"} />}
      {session && !session.configured && !setupError && <ErrorNote error="Marketplace setup is unavailable." retry={retrySetup} />}
      {session?.configured && (tab === "explore" ? <Explore key={session.canisterId} client={client} refresh={revision} discount={discount} editDiscount={() => setDiscountOpen(true)} select={setDetail} acquire={(app) => void acquire(app)} /> : tab === "library" ? <Library key={`${session.canisterId}:${session.account ?? ""}`} client={client} connected={session.connected} refresh={revision} select={setDetail} install={(ids, quote) => install(ids, quote)} installing={installing} explore={() => setTab("explore")} /> : tab === "activity" ? <NotificationsPanel operations={operations} loading={saved.loading} error={saved.error || activityError} onRefresh={() => setRevision(v => v + 1)} onCheck={item => observe(client.operation(item.operationId))} onResume={resumeOperation} onVerify={(item, hash) => observe(client.verifyEthereumTransaction(item.operationId, hash))} onCancel={item => observe(client.cancelEthereumCheckout(item.operationId))} /> : tab === "earnings" ? <EarningsPanel key={session.canisterId} client={client} connected={session.connected} refresh={revision} onOperation={onOperation} /> : null)}
      {session?.configured && publisherOpened && <div hidden={tab !== "publish"}><PublisherPanel key={session.canisterId} client={client} connected={session.connected} refresh={revision} onChanged={() => setRevision((v) => v + 1)} /></div>}
    </div>
    {detail && <AppDetailDialog key={`${session?.canisterId ?? ""}:${session?.account ?? ""}:${detail.id}`} client={client} app={detail} discount={discount} installing={installing} close={() => setDetail(null)} acquire={(app) => void acquire(app)} install={(ids, quote) => install(ids, quote)} connected={session?.connected ?? false} connect={connect} />}
    {checkout && <Checkout client={client} apps={checkout} discount={discount} close={() => setCheckout(null)} complete={(result) => { onOperation(result); setTab("library"); }} pending={onOperation} />}
    {discountOpen && <DiscountCodeDialog client={client} discount={discount} close={() => setDiscountOpen(false)} changed={changeDiscount} />}
    <AgentReviewHost />
  </div></main>;
}

function Explore({ client, refresh, discount, editDiscount, select, acquire }: { client: MarketplaceClient; refresh: number; discount: DiscountPreference; editDiscount: () => void; select: (app: AppListing) => void; acquire: (app: AppListing) => void }) {
  const [window, setWindow] = useState<RankingWindow>("week"), [search, setSearch] = useState("");
  return <div className="mp-explore">
    <label className="mp-search"><Icon name="search" /><span className="mp-sr-only">Search apps</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search apps" autoComplete="off" /></label>
    <div className="mp-chart-controls"><h2>{search ? "Search results" : "Discover apps"}</h2><div className="mp-chart-actions"><button type="button" className={`mp-text-button mp-discount-link${discount.active ? " is-active" : ""}`} onClick={editDiscount}><Icon name={discount.active ? "check" : "discount"} />{discount.active ? `${discountPercent(discount.discountBps)} off` : "Discount code"}</button><label><span className="mp-sr-only">Ranking period</span><select value={window} onChange={(event) => setWindow(event.target.value as RankingWindow)}><option value="week">7 days</option><option value="month">30 days</option><option value="all">All time</option></select></label></div></div>
    {(["paid", "free"] as const).map((tier) => <CatalogSection key={JSON.stringify([tier, window, search.trim(), refresh])} client={client} tier={tier} window={window} search={search.trim()} discount={discount} select={select} acquire={acquire} />)}
  </div>;
}

function CatalogSection({ client, tier, window, search, discount, select, acquire }: { client: MarketplaceClient; tier: AppTier; window: RankingWindow; search: string; discount: DiscountPreference; select: (app: AppListing) => void; acquire: (app: AppListing) => void }) {
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
    {read.loading && !read.data ? <div className="mp-app-grid" aria-label={`Loading ${tier} apps`} aria-busy="true">{Array.from({ length: 3 }, (_, i) => <div className="mp-card-skeleton" key={i}><span /><div><i /><i /><i /></div></div>)}</div> : rows.length === 0 && !read.error ? <p className="mp-catalog-empty">{search ? `No matching ${tier} apps.` : `New ${tier} apps are on their way.`}</p> : <div className="mp-app-grid">{rows.map((app) => <AppCard key={app.id} app={app} discount={discount} select={() => select(app)} acquire={() => acquire(app)} />)}</div>}
    {cursor && <button type="button" className="mp-secondary mp-load-more" disabled={paging} onClick={() => void more()}>{paging ? "Loading…" : `Show more ${tier} apps`}</button>}
    {read.data?.asOf && <p className="mp-chart-footnote">Ranked by acquisitions · {dateLabel(read.data.asOf)}</p>}
  </section>;
}

function AppCard({ app, discount, select, acquire }: { app: AppListing; discount: DiscountPreference; select: () => void; acquire: () => void }) {
  const acquisitions = acquisitionStats(app);
  return <article className="mp-app-card"><button className="mp-card-main" type="button" onClick={select}><AppIcon app={app} /><span className="mp-card-copy"><strong>{app.title}</strong><span className="mp-card-category">{app.category}</span><span className="mp-card-summary">{app.summary}</span></span></button><div className="mp-card-bottom"><div className="mp-card-metrics"><span className="mp-rating">{app.rating === null ? "New" : <>{app.rating.toFixed(1)} <span aria-hidden="true">★</span> <small>({app.ratingCount.toLocaleString()})</small></>}</span>{acquisitions && <span className="mp-acquisitions" title="All time">{acquisitions.count} {acquisitions.label}</span>}</div><button type="button" className="mp-get-button" onClick={app.owned ? select : acquire}>{app.owned ? "Owned" : <AppPrice micros={app.priceUsdMicros} discount={discount} />}</button></div></article>;
}

function Library({ client, connected, refresh, select, install, installing, explore }: { client: MarketplaceClient; connected: boolean; refresh: number; select: (app: AppListing) => void; install: (ids: string[], quote: InstallationQuote) => void | Promise<void>; installing: boolean; explore: () => void }) {
  const read = useRead(connected ? "library" : null, () => client.library(), refresh);
  const [selected, setSelected] = useState<Set<string>>(new Set()), [more, setMore] = useState<Page<LibraryApp> | null>(null), [paging, setPaging] = useState(false), [error, setError] = useState("");
  useEffect(() => { setMore(null); }, [refresh, connected]);
  useEffect(() => { setSelected(new Set()); }, [connected]);
  useEffect(() => {
    const installed = new Set([...(read.data?.items ?? []), ...(more?.items ?? [])].filter(app => app.installedVersion).map(app => app.id));
    if (installed.size) setSelected(previous => {
      const next = new Set([...previous].filter(id => !installed.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [read.data, more]);
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

