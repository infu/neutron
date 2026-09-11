import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { onTileViewRequest } from "neutron-tools/app";
import "./style.scss";
import { displayName, getProvisionalRegistry, getRegistry, peekRegistry, type Registry } from "./data/registry";
import { listDrafts } from "./data/drafts";
import { formatView, parseView, type TileView } from "./data/views";
import { DraftsView } from "./ui/Drafts";
import { FeedView } from "./ui/Proposals";
import { MyNeuronsView } from "./ui/Neurons";
import { SetupView } from "./ui/Setup";
import { SnsDetailView } from "./ui/SnsDetail";
import { ReviewHost } from "./ui/ReviewHost";
import { ActivityView } from "./ui/Activity";
import { SnsLogo } from "./ui/Logo";
import { NeuronIcon, RefreshIcon, SearchIcon } from "./ui/Icons";
import { IconButton } from "./ui/IconButton";
import { BusyOr, Empty, Pending } from "./ui/Status";
import { ErrorNote, PageHeading, errorMessage } from "./ui/Common";

type MainTab = "feed" | "neurons" | "list" | "activity";
const NAVIGATION: { kind: MainTab; label: string }[] = [
  { kind: "feed", label: "Feed" }, { kind: "neurons", label: "My neurons" },
  { kind: "list", label: "Explore" }, { kind: "activity", label: "Activity" },
];
const mainTab = (view: TileView): MainTab => view.kind === "sns" ? "list" : view.kind === "setup" ? "neurons" : view.kind === "draft" || view.kind === "drafts" ? "activity" : view.kind;

export function App() {
  const [view, setView] = useState<TileView>({ kind: "feed" });
  const [visited, setVisited] = useState<Set<MainTab>>(new Set(["feed"]));
  const [draftCount, setDraftCount] = useState(0);
  const [routeRevision, setRouteRevision] = useState({ sns: 0, neurons: 0, activity: 0 });
  const history = useRef<TileView[]>([]);
  const current = useRef(view);
  current.current = view;
  const positions = useRef(new Map<string, { top: number; opener: HTMLElement | null }>());
  const content = useRef<HTMLDivElement>(null);
  const countDrafts = useCallback(async () => { try { setDraftCount((await listDrafts()).length); } catch { /* Draft availability does not block navigation. */ } }, []);
  useEffect(() => { void countDrafts(); }, [countDrafts]);
  const navigate = useCallback((next: TileView, remember = true) => {
    positions.current.set(formatView(current.current), { top: window.scrollY, opener: document.activeElement instanceof HTMLElement ? document.activeElement : null });
    if (remember) history.current.push(current.current);
    if (next.kind === "sns" || next.kind === "neurons" || next.kind === "activity") setRouteRevision(previous => ({ ...previous, [next.kind]: previous[next.kind] + 1 }));
    setVisited(previous => new Set([...previous, mainTab(next)]));
    setView(next);
  }, []);
  const back = useCallback(() => { navigate(history.current.pop() ?? { kind: "feed" }, false); void countDrafts(); }, [navigate, countDrafts]);
  useEffect(() => onTileViewRequest(raw => { const next = parseView(raw); if (next) { navigate(next); void countDrafts(); } }), [navigate, countDrafts]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const previous = positions.current.get(formatView(view));
      if (previous?.opener?.isConnected && !previous.opener.closest("[hidden]")) previous.opener.focus({ preventScroll: true });
      else content.current?.querySelector<HTMLElement>("[data-view-active='true'] h2")?.focus({ preventScroll: true });
      window.scrollTo({ top: previous?.top ?? 0 });
    });
    return () => cancelAnimationFrame(frame);
  }, [view]);
  const selectedTab = mainTab(view);
  return <main className="nt-app nt-app--fill snsgov-app">
    <div className="snsgov-shell">
      <header className="nt-app-header snsgov-app-header">
        <div className="nt-app-header-main"><span className="nt-app-header-icon snsgov-brand"><NeuronIcon /></span><div className="nt-app-header-copy"><h1 className="nt-app-header-title">SNS Gov</h1><p className="nt-app-header-subtitle">A voice in your communities</p></div></div>
        <div className="nt-app-header-actions">
          <button className="nt-button nt-button--ghost nt-app-header-control" type="button" onClick={() => navigate({ kind: "drafts" })}>Drafts{draftCount > 0 && <span className="snsgov-count-badge">{draftCount}</span>}</button>
          <button className="nt-button nt-button--ghost nt-app-header-control" type="button" onClick={() => navigate({ kind: "setup" })}>Connections</button>
        </div>
      </header>
      <nav className="snsgov-navigation" aria-label="SNS Gov sections">{NAVIGATION.map(item => <button className="nt-tab" type="button" key={item.kind} aria-current={selectedTab === item.kind ? "page" : undefined} data-active={selectedTab === item.kind} onClick={() => navigate({ kind: item.kind })}>{item.label}</button>)}</nav>
      <div className="snsgov-content" ref={content}>
        {visited.has("feed") && <div hidden={view.kind !== "feed"} data-view-active={view.kind === "feed"}><FeedView onOpenSns={entry => navigate({ kind: "sns", rootCanisterId: entry.canisters.root, tab: "overview" })} /></div>}
        {visited.has("neurons") && <div hidden={view.kind !== "neurons"} data-view-active={view.kind === "neurons"}><MyNeuronsView navigationKey={routeRevision.neurons} onConnect={() => navigate({ kind: "setup" })} {...(view.kind === "neurons" && view.rootCanisterId ? { initialRootCanisterId: view.rootCanisterId } : {})} {...(view.kind === "neurons" && view.neuronId ? { initialNeuronId: view.neuronId } : {})} /></div>}
        {visited.has("list") && <div hidden={view.kind !== "list"} data-view-active={view.kind === "list"}><ExploreView onOpen={rootCanisterId => navigate({ kind: "sns", rootCanisterId, tab: "overview" })} /></div>}
        {visited.has("activity") && <div hidden={view.kind !== "activity"} data-view-active={view.kind === "activity"}><ActivityView navigationKey={routeRevision.activity} {...(view.kind === "activity" && view.operationId ? { initialOperationId: view.operationId } : {})} /></div>}
        {view.kind === "sns" && <div data-view-active="true"><SnsDetailView key={`${view.rootCanisterId}:${routeRevision.sns}`} rootCanisterId={view.rootCanisterId} initialTab={view.tab} initialProposalId={view.proposalId} onBack={back} /></div>}
        {view.kind === "setup" && <div data-view-active="true"><SetupView onBack={back} /></div>}
        {(view.kind === "drafts" || view.kind === "draft") && <div data-view-active="true"><DraftsView focusDraftId={view.kind === "draft" ? view.draftId : null} onBack={back} onChanged={countDrafts} /></div>}
      </div>
    </div>
    <ReviewHost />
  </main>;
}

export function ExploreView({ onOpen }: { onOpen: (rootCanisterId: string) => void }) {
  const [registry, setRegistry] = useState<Registry | null>(() => peekRegistry() ?? null);
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const load = useCallback(async (force = false) => {
    const id = ++request.current;
    setBusy(true); setError("");
    try {
      if (!force && !peekRegistry()) {
        const provisional = await getProvisionalRegistry();
        if (id === request.current && provisional) setRegistry(provisional);
      }
      const value = await getRegistry(force ? { force: true } : {});
      if (id === request.current) setRegistry(value);
    } catch (caught) { if (id === request.current) setError(errorMessage(caught)); }
    finally { if (id === request.current) setBusy(false); }
  }, []);
  useEffect(() => { void load(); return () => { request.current += 1; }; }, [load]);
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (registry?.entries ?? []).filter(entry => showAll || registry?.livenessKnown === false || entry.liveness.governance)
      .filter(entry => `${displayName(entry)} ${entry.token?.symbol ?? ""} ${entry.canisters.root}`.toLowerCase().includes(needle))
      .sort((a, b) => displayName(a).localeCompare(displayName(b)));
  }, [registry, search, showAll]);
  const inactive = registry?.livenessKnown === false ? 0 : registry?.entries.filter(entry => !entry.liveness.governance).length ?? 0;
  return <section className="nt-page">
    <PageHeading title="Explore communities" description="Discover what people are building and help decide what comes next." actions={<IconButton disabled={busy} label="Refresh communities" onClick={() => void load(true)}><BusyOr busy={busy}><RefreshIcon /></BusyOr></IconButton>} />
    <div className="snsgov-explore-controls"><label className="snsgov-search"><SearchIcon /><span className="nt-sr-only">Search communities by name, token or address</span><input type="search" className="nt-input" placeholder="Search communities" value={search} onChange={event => setSearch(event.target.value)} /></label><button className="nt-button nt-button--ghost" type="button" aria-pressed={showAll} onClick={() => setShowAll(value => !value)}>{showAll ? "All communities" : "Active communities"}</button></div>
    <ErrorNote message={error} />
    {error && <button className="nt-button nt-button--ghost" type="button" disabled={busy} onClick={() => void load(true)}>Try again</button>}
    {!registry && busy && <Pending label="Finding communities" />}
    {registry && rows.length === 0 && <Empty label="No communities match. Try another name or include inactive communities." />}
    <div className="snsgov-community-list">{rows.map(entry => {
      const name = displayName(entry);
      const isInactive = registry?.livenessKnown !== false && !entry.liveness.governance;
      return <button className="snsgov-community-row" type="button" key={entry.canisters.root} onClick={() => onOpen(entry.canisters.root)}>
        <SnsLogo name={name} logo={entry.metadata?.logo} size={32} />
        <span className="snsgov-community-copy"><span className="snsgov-community-name"><strong>{name}</strong>{entry.token?.symbol && <span className="snsgov-token-symbol">{entry.token.symbol}</span>}</span><span className="snsgov-community-description">{entry.metadata?.description || "Explore this community’s proposals and staked tokens."}</span>{isInactive && <span className="nt-badge nt-badge--warning">{entry.liveness.ledger ? "Token only" : "Inactive"}</span>}</span>
        <span className="snsgov-chevron" aria-hidden="true">›</span>
      </button>;
    })}</div>
    {registry && <p className="nt-meta snsgov-muted">{rows.length} {rows.length === 1 ? "community" : "communities"}{!showAll && inactive > 0 ? ` · ${inactive} inactive hidden` : ""}{registry.livenessKnown === false ? " · Checking availability" : ""}</p>}
  </section>;
}

const container = document.getElementById("root");
if (container) createRoot(container).render(<StrictMode><App /></StrictMode>);
