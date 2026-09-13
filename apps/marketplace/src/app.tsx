import { useEffect, useMemo, useRef, useState } from "react";
import { onAppStateChange } from "neutron-tools/app";
import { connectEthereumFundingBrowser } from "./ethereum.ts";
import { createMarketplaceClient } from "./tile_client.ts";
import type { AppListing, LibraryApp, MarketplaceClient, OperationResult, Page, Session, InstallationQuote, DiscountPreference } from "./view-types.ts";
import { Checkout } from "./components/checkout.tsx";
import { AppDetailDialog } from "./components/detail.tsx";
import { EarningsPanel } from "./components/earnings.tsx";
import { Explore } from "./components/explore.tsx";
import { PublisherPanel } from "./components/publisher.tsx";
import { PublisherProfileDialog } from "./components/publisher_profile.tsx";
import { PublisherLink } from "./components/app_card.tsx";
import { InstallControl } from "./components/install.tsx";
import { NotificationsPanel, NotificationBell } from "./components/notifications.tsx";
import { canDismissNotification, notificationAttentionCount, notificationFingerprint, readDismissedNotifications, visibleNotifications, type DismissedNotifications } from "./notification-state.ts";
import { DiscountCodeDialog, discountPercent, noDiscount } from "./components/discount.tsx";
import { AgentReviewHost } from "./components/agent_review.tsx";
import { AppIcon, EmptyState, ErrorNote, Icon, Loading, dateLabel, errorMessage, useRead } from "./components/primitives.tsx";

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
  const [dismissedState, setDismissedState] = useState<{ key: string; entries: DismissedNotifications } | null>(null);
  const observationSequence = useRef(0), observationVersions = useRef<Record<string, number>>({});
  const [initializing, setInitializing] = useState(true), [setupError, setSetupError] = useState("");
  const setupInFlight = useRef<Promise<Session> | null>(null);
  const [detail, setDetail] = useState<AppListing | null>(null), [checkout, setCheckout] = useState<AppListing[] | null>(null);
  const [active, setActive] = useState<ActiveOperation | null>(null), [installing, setInstalling] = useState(false);
  const [publisherOpened, setPublisherOpened] = useState(false);
  const [publisherId, setPublisherId] = useState<string | null>(null);
  const [releasePreferenceRevision, setReleasePreferenceRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setRevision(value => value + 1);
    const unsubscribe = onAppStateChange("kernel.release-preferences", () => {
      // This event invalidates presentation; every read and new effect still
      // checks the Kernel authority. Saved financial reviews remain retained.
      setDetail(null); setPublisherId(null); setReleasePreferenceRevision(value => value + 1); refresh();
    });
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => { unsubscribe(); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", visible); };
  }, []);
  function openPublisher(id: string) { setDetail(null); setPublisherId(id); }
  function openApp(app: AppListing) { setPublisherId(null); setDetail(app); }
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
  const notificationStorageKey = session?.account ? `marketplace:activity-dismissed:${JSON.stringify([session.host, session.canisterId, session.account])}` : null;
  useEffect(() => {
    if (!notificationStorageKey) { setDismissedState(null); return; }
    let entries: DismissedNotifications = {};
    try { entries = readDismissedNotifications(localStorage, notificationStorageKey); } catch { /* Browser storage may be unavailable. */ }
    setDismissedState({ key: notificationStorageKey, entries });
  }, [notificationStorageKey]);
  const dismissed = dismissedState?.key === notificationStorageKey ? dismissedState.entries : {};
  const notifications = visibleNotifications(operations, dismissed);
  const attentionCount = notificationAttentionCount(notifications);
  function dismissOperation(operation: OperationResult) {
    const latest = operations.find(item => item.operationId === operation.operationId);
    if (!notificationStorageKey || !latest || !canDismissNotification(latest) || notificationFingerprint(latest) !== notificationFingerprint(operation)) return;
    const entries = { ...dismissed, [operation.operationId]: notificationFingerprint(latest) };
    setDismissedState({ key: notificationStorageKey, entries });
    try { localStorage.setItem(notificationStorageKey, JSON.stringify(entries)); }
    catch { setActivityError("Dismissed for this session. This browser could not remember the change after a reload."); }
  }
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
      {session?.configured && (tab === "explore" ? <Explore key={`${session.canisterId}:${releasePreferenceRevision}`} client={client} refresh={revision} discount={discount} select={openApp} publisher={openPublisher} /> : tab === "library" ? <Library key={`${session.canisterId}:${session.account ?? ""}:${releasePreferenceRevision}`} client={client} connected={session.connected} refresh={revision} select={openApp} install={(ids, quote) => install(ids, quote)} installing={installing} explore={() => setTab("explore")} publisher={openPublisher} /> : tab === "activity" ? <NotificationsPanel operations={notifications} onDismiss={dismissOperation} loading={saved.loading} error={saved.error || activityError} onRefresh={() => setRevision(v => v + 1)} onCheck={item => observe(client.operation(item.operationId))} onResume={resumeOperation} onVerify={(item, hash) => observe(client.verifyEthereumTransaction(item.operationId, hash))} onCancel={item => observe(client.cancelEthereumCheckout(item.operationId))} /> : tab === "earnings" ? <EarningsPanel key={session.canisterId} client={client} connected={session.connected} refresh={revision} onOperation={onOperation} /> : null)}
      {session?.configured && publisherOpened && <div hidden={tab !== "publish"}><PublisherPanel key={`${session.canisterId}:${session.account ?? ""}`} client={client} connected={session.connected} refresh={revision} onChanged={() => setRevision((v) => v + 1)} publisher={openPublisher} /></div>}
    </div>
    {detail && <AppDetailDialog key={`${session?.canisterId ?? ""}:${session?.account ?? ""}:${detail.id}`} client={client} app={detail} refreshRevision={revision} discount={discount} installing={installing} close={() => setDetail(null)} acquire={(app) => void acquire(app)} install={(ids, quote) => install(ids, quote)} connected={session?.connected ?? false} connect={connect} publisher={openPublisher} />}
    {publisherId && <PublisherProfileDialog key={`${session?.canisterId ?? ""}:${publisherId}`} client={client} publisherId={publisherId} refreshRevision={revision} discount={discount} close={() => setPublisherId(null)} select={openApp} publisher={openPublisher} />}
    {checkout && <Checkout client={client} apps={checkout} discount={discount} close={() => setCheckout(null)} complete={(result) => { onOperation(result); setTab("library"); }} pending={onOperation} />}
    {discountOpen && <DiscountCodeDialog client={client} discount={discount} close={() => setDiscountOpen(false)} changed={changeDiscount} />}
    <AgentReviewHost />
  </div></main>;
}

function Library({ client, connected, refresh, select, install, installing, explore, publisher }: { client: MarketplaceClient; connected: boolean; refresh: number; select: (app: AppListing) => void; install: (ids: string[], quote: InstallationQuote) => void | Promise<void>; installing: boolean; explore: () => void; publisher: (id: string) => void }) {
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
  return <div className="mp-stack"><div className="mp-section-title"><div><h2>My Apps</h2><p>Owned by this Neutron. Yours to install again.</p></div><button className="mp-text-button" type="button" onClick={explore}>Explore apps <Icon name="arrow" /></button></div><ErrorNote error={read.error || error} />{read.loading && !read.data ? <Loading label="Loading your apps…" /> : apps.length === 0 && !read.error ? <EmptyState title="Make room for something useful" action={<button type="button" className="mp-primary" onClick={explore}>Explore apps</button>}>Your free and purchased apps will be saved here, even after uninstalling them.</EmptyState> : <><div className="mp-library-toolbar"><label className="mp-check-label"><input type="checkbox" checked={installable.length > 0 && actualSelected.length === installable.length} onChange={(event) => setSelected(new Set(event.target.checked ? installable.map((app) => app.id) : []))} disabled={installable.length === 0 || installing} />Select available</label><span className="mp-muted">{apps.length} {apps.length === 1 ? "app" : "apps"}</span></div><div className="mp-library-list">{apps.map((app) => <article className="mp-library-row" key={app.id}><input type="checkbox" aria-label={`Select ${app.title}`} checked={selected.has(app.id)} disabled={!app.available || !!app.installedVersion || installing} onChange={(event) => setSelected((old) => { const next = new Set(old); event.target.checked ? next.add(app.id) : next.delete(app.id); return next; })} /><div className="mp-library-app"><AppIcon app={app} /><div className="mp-library-copy"><button type="button" className="mp-library-title" onClick={() => select(app)} aria-label={app.title}><strong>{app.title}</strong>{app.channel === "beta" && <span className="mp-badge">Beta v{app.version}</span>}</button><PublisherLink app={app} open={publisher} /><small>{libraryReleaseStatus(app)}</small></div></div><InstallControl client={client} appIds={[app.id]} selectionIdentity={JSON.stringify([app.releasePreferences, app.releaseSelection])} disabled={!app.available || !!app.installedVersion} busy={installing} label={app.installedVersion ? "Installed" : "Install"} className="mp-get-button" onInstall={install} /></article>)}</div>{(more ? more.nextCursor : read.data?.nextCursor) && <button type="button" className="mp-secondary mp-load-more" disabled={paging} onClick={() => void next()}>{paging ? "Loading…" : "Load more"}</button>}{actualSelected.length > 0 && <div className="mp-selection-bar"><span>{actualSelected.length} selected</span><InstallControl client={client} appIds={actualSelected} selectionIdentity={JSON.stringify(apps.filter(app => actualSelected.includes(app.id)).map(app => [app.releasePreferences, app.releaseSelection]))} busy={installing} label="Install selected" className="mp-primary" onInstall={install} /></div>}</>}</div>;
}
function libraryReleaseStatus(app: LibraryApp): string {
  if (!app.available) return app.unavailableReason || "Waiting for an approved release";
  if (!app.installedVersion) return "Ready to install";
  if (app.installedVersion === app.version) return "Installed · Up to date";
  if (/^\d+$/.test(app.installedVersion) && /^\d+$/.test(app.version) && BigInt(app.installedVersion) > BigInt(app.version)) return app.channel !== "beta" ? "Ahead of stable — waiting for a stable release" : "Installed · Ahead of the offered release";
  return `Update to ${app.version} in Settings`;
}
