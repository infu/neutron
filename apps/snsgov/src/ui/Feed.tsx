import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getFeedRegistry, loadProposalFeedPage, compareFeedProposals, type FeedProposal, type ProposalFeedPage } from "../data/feed";
import { classifyError, isInactive } from "../data/errors";
import { listProposals, readMetadata } from "../data/governance";
import { displayName, type RegistryEntry } from "../data/registry";
import { readHotkey } from "../data/relay";
import { scanForNeuronsDetailed } from "../data/registration";
import { Dialog, Disclosure, ErrorNote, PageHeading, useRead } from "./Common";
import { Empty, Pending } from "./Status";
import { acceptsVotes, ProposalDetailView, ProposalPost } from "./Proposals";
import { ProposalCreate } from "./ProposalCreate";

interface FeedState extends ProposalFeedPage { key: string }
type CommunitySelection = { mode: "except" | "only"; roots: string[] };
const SELECTION_KEY = "snsgov.feed.communities.v1";

export function FeedView({ onOpenSns }: { onOpenSns?: ((entry: RegistryEntry) => void) | undefined } = {}) {
  const registry = useRead("feed-registry", () => getFeedRegistry());
  const [enriched, setEnriched] = useState<Record<string, RegistryEntry["metadata"]>>({});
  const [availability, setAvailability] = useState<Record<string, boolean>>({});
  const availabilityRef = useRef(availability);
  availabilityRef.current = availability;
  const [communityScope, setCommunityScope] = useState<"all" | "my">("all");
  const [selection, setSelection] = useState<CommunitySelection>(readSelection);
  const [filterDraft, setFilterDraft] = useState<CommunitySelection | null>(null);
  const [filterSearch, setFilterSearch] = useState("");
  const [activityFilter, setActivityFilter] = useState("voting");
  const [myRoots, setMyRoots] = useState<string[] | null>(null);
  const [myError, setMyError] = useState<string | null>(null);
  const [myLoading, setMyLoading] = useState(false);
  const [state, setState] = useState<FeedState | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [progressive, setProgressive] = useState<FeedProposal[]>([]);
  const [fresh, setFresh] = useState<FeedState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState(0);
  const [opened, setOpened] = useState<FeedProposal | null>(null);
  const [chooseCommunity, setChooseCommunity] = useState(false);
  const [creating, setCreating] = useState<RegistryEntry | null>(null);
  const [createRoot, setCreateRoot] = useState("");
  const generation = useRef(0);
  const myGeneration = useRef(0);
  const feed = useRef<HTMLDivElement>(null);
  const backTarget = useRef<HTMLButtonElement | null>(null);
  const feedScroll = useRef(0);
  const entries = registry.data?.entries.map(entry => enriched[entry.canisters.root] ? { ...entry, metadata: enriched[entry.canisters.root]! } : entry) ?? [];
  const byRoot = new Map(entries.map(entry => [entry.canisters.root, entry]));
  const cachedAvailable = new Set(registry.data?.availableRoots ?? []);
  const availableEntries = entries.filter(entry => availability[entry.canisters.root] ?? cachedAvailable.has(entry.canisters.root)).sort((a, b) => displayName(a).localeCompare(displayName(b)));
  const availableByRoot = new Map(availableEntries.map(entry => [entry.canisters.root, entry]));
  // Query identities stay stable while availability arrives. An inactive SNS
  // leaves the picker immediately; a fresh Refresh still checks its recovery.
  const rootsKey = entries.filter(entry => includesCommunity(selection, entry.canisters.root)).map(entry => entry.canisters.root).sort().join(",");
  const selectedKey = communityScope === "all" ? rootsKey : myRoots?.filter(root => byRoot.has(root) && includesCommunity(selection, root)).sort().join(",");
  const selectedRoots = useMemo(() => selectedKey ? selectedKey.split(",") : [], [selectedKey]);
  const selectedAvailable = availableEntries.filter(entry => includesCommunity(selection, entry.canisters.root) && (communityScope === "all" || myRoots?.includes(entry.canisters.root)));
  const metadataStarted = useRef(new Set<string>());

  useEffect(() => {
    try { localStorage.setItem(SELECTION_KEY, JSON.stringify(selection)); } catch { /* A local UI preference must not require browser storage. */ }
  }, [selection]);
  useEffect(() => {
    const roots = [...new Set([
      ...[...(state?.proposals ?? []), ...progressive].map(row => row.sns),
      ...registry.data?.availableRoots ?? [],
      ...Object.entries(availability).filter(([, active]) => active).map(([root]) => root),
    ])];
    for (const root of roots) {
      const entry = registry.data?.entries.find(entry => entry.canisters.root === root);
      if (!entry || entry.metadata?.name || metadataStarted.current.has(root)) continue;
      metadataStarted.current.add(root);
      void readMetadata(entry.canisters.governance).then(metadata => setEnriched(current => ({ ...current, [root]: metadata })), () => { /* Proposal reads remain usable when branding is unavailable. */ });
    }
  }, [state, progressive, registry.data, availability]);

  const findMine = useCallback(async () => {
    if (!registry.data) return;
    const request = ++myGeneration.current;
    setMyLoading(true); setMyError(null);
    try {
      const hotkey = await readHotkey();
      const result = await scanForNeuronsDetailed(registry.data.entries.filter(entry => availabilityRef.current[entry.canisters.root] !== false).map(entry => ({
        rootCanisterId: entry.canisters.root, governanceCanisterId: entry.canisters.governance, label: displayName(entry),
      })), hotkey.principal);
      if (request !== myGeneration.current) return;
      setMyRoots(result.value.map(entry => entry.rootCanisterId));
      const failures = result.failures.filter(failure => failure.code !== "SNS_GOVERNANCE_INACTIVE");
      if (failures.length) setMyError(`Couldn't check your neurons in ${failures.length} ${failures.length === 1 ? "community" : "communities"}.`);
    } catch (reason) { if (request === myGeneration.current) setMyError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (request === myGeneration.current) setMyLoading(false); }
  }, [registry.data]);

  useEffect(() => {
    if (communityScope === "my" && myRoots === null && !myLoading && !myError) void findMine();
  }, [communityScope, myRoots, myLoading, myError, findMine]);
  useEffect(() => () => { myGeneration.current++; }, []);

  const readFeed = useCallback(async (cursor?: string, isRefresh = false) => {
    if (selectedKey === undefined || !registry.data) return;
    const request = ++generation.current;
    const entriesByRoot = new Map(registry.data.entries.map(entry => [entry.canisters.root, entry]));
    const visited = new Set<string>();
    setBusy(true); setError(null); setChecked(0);
    if (!cursor && !isRefresh) setProgressive([]);
    try {
      const result = await loadProposalFeedPage({ sns: selectedRoots, limit: 20, registry: registry.data, ...(cursor ? { cursor } : {}) }, async params => {
        const entry = entriesByRoot.get(params.sns);
        if (!entry) throw new Error(`Community ${params.sns} is no longer in the registry.`);
        try {
          const page = await listProposals(entry.canisters.governance, {
            limit: params.limit, ...(params.beforeProposal === undefined ? {} : { beforeProposal: params.beforeProposal }),
          });
          if (request === generation.current) {
            setAvailability(previous => ({ ...previous, [params.sns]: true }));
            if (!cursor && !isRefresh) setProgressive(previous => merge(previous, page.proposals.map(proposal => ({ sns: params.sns, proposal }))));
          }
          return page;
        } catch (reason) {
          if (request === generation.current && isInactive(classifyError(reason, { sns: params.sns, role: "governance" }))) setAvailability(previous => ({ ...previous, [params.sns]: false }));
          throw reason;
        } finally {
          if (request === generation.current) { visited.add(params.sns); setChecked(visited.size); }
        }
      });
      if (request !== generation.current) return;
      const page = { ...result, key: selectedKey };
      if (isRefresh) {
        setFresh(stateRef.current?.key === selectedKey && result.proposals.length > 0 ? page : null);
        setState(previous => {
          if (previous?.key !== selectedKey) return page;
          const updates = new Map(result.proposals.map(row => [key(row), row]));
          return { ...previous, failures: result.failures, unavailable: result.unavailable ?? [], activeSns: result.activeSns ?? [], proposals: previous.proposals.map(row => updates.get(key(row)) ?? row) };
        });
      } else setState(previous => ({ ...page, proposals: cursor && previous?.key === selectedKey ? merge(previous.proposals, page.proposals) : page.proposals }));
      setProgressive([]);
    } catch (reason) { if (request === generation.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (request === generation.current) setBusy(false); }
  }, [selectedKey, selectedRoots, registry.data]);

  useEffect(() => {
    setState(null); setFresh(null); setOpened(null); setProgressive([]);
    if (selectedKey !== undefined && registry.data) void readFeed();
    return () => { generation.current++; };
  }, [readFeed, selectedKey, registry.data]);

  const current = state?.key === selectedKey ? state : null;
  const rows = current?.proposals ?? progressive.slice(0, 20);
  const visible = activityFilter === "voting" ? rows.filter(row => acceptsVotes(row.proposal)) : rows;
  const failures = current?.failures.filter(failure => failure.code !== "SNS_GOVERNANCE_INACTIVE" && availability[failure.scope] !== false) ?? [];
  const newCount = fresh?.proposals.filter(row => !current?.proposals.some(old => key(old) === key(row))).length ?? 0;
  const openedEntry = opened ? byRoot.get(opened.sns) : undefined;
  const noSelection = selection.mode === "only" && selection.roots.length === 0;
  const customSelection = selection.mode === "only" || selection.roots.length > 0;
  const openFilter = () => { setFilterDraft({ ...selection, roots: [...selection.roots] }); setFilterSearch(""); };
  const filteredEntries = availableEntries.filter(entry => `${displayName(entry)} ${entry.token?.symbol ?? ""} ${entry.canisters.root}`.toLowerCase().includes(filterSearch.trim().toLowerCase()));

  return <div className="snsgov-feed">
    <div ref={feed} hidden={opened !== null}>
      <PageHeading title="Feed" description="Proposals from communities across the SNS network." actions={<>
        <button type="button" className="nt-button nt-button--ghost" disabled={busy || !registry.data} onClick={() => void readFeed(undefined, true)}>{busy && current ? "Refreshing…" : "Refresh"}</button>
        <button type="button" className="nt-button" disabled={!availableEntries.length} onClick={() => { setCreateRoot(availableEntries[0]?.canisters.root ?? ""); setChooseCommunity(true); }}>Create proposal</button>
      </>} />
      <div className="snsgov-feed-controls">
        <div className="snsgov-feed-scope" aria-label="Community scope">
          <button type="button" className="nt-button nt-button--ghost" aria-pressed={communityScope === "all"} onClick={() => setCommunityScope("all")}>All communities</button>
          <button type="button" className="nt-button nt-button--ghost" aria-pressed={communityScope === "my"} onClick={() => setCommunityScope("my")}>My communities</button>
        </div>
        <button type="button" className="nt-icon-button snsgov-community-filter-button" aria-label="Filter communities" title="Filter communities" aria-haspopup="dialog" aria-expanded={filterDraft !== null} onClick={openFilter}>
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M4 6h16M7 12h10M10 18h4" /></svg>
          {customSelection && <span className="snsgov-filter-active" aria-hidden="true" />}
        </button>
        <label className="snsgov-feed-activity"><span className="nt-sr-only">Proposal activity</span><select className="nt-select" aria-label="Proposal activity" value={activityFilter} onChange={event => setActivityFilter(event.target.value)}><option value="voting">Accepting votes</option><option value="all">All activity</option></select></label>
      </div>
      {customSelection && <p className="nt-meta snsgov-selection-summary">{selectedAvailable.length} {selectedAvailable.length === 1 ? "community" : "communities"} selected <button type="button" className="snsgov-link" onClick={() => setSelection({ mode: "except", roots: [] })}>Reset filter</button></p>}
      {registry.error && <ErrorNote message={registry.error} />}
      {error && <ErrorNote message={error} />}
      {(registry.loading && !registry.data) && <Pending label="Reading communities" />}
      {communityScope === "my" && myLoading && <Pending label="Checking communities for your neurons" />}
      {communityScope === "my" && myError && <div className="snsgov-feed-read-note"><span className="nt-meta">{myError}</span><button type="button" className="nt-button nt-button--ghost" disabled={myLoading} onClick={() => void findMine()}>Retry</button></div>}
      {busy && <p className="nt-meta" role="status">{current ? "Reading more proposals…" : `Checking ${checked} of ${selectedRoots.length} communities…`}</p>}
      {failures.length > 0 && <div className="snsgov-feed-read-note">
        <Disclosure title={`Couldn't refresh ${failures.length} ${failures.length === 1 ? "community" : "communities"}`}>
          <p className="nt-meta">Showing proposals read so far. These communities may have newer proposals.</p>
          {failures.map(failure => <p key={failure.scope} className="nt-meta">{byRoot.get(failure.scope) ? displayName(byRoot.get(failure.scope)!) : failure.scope}: {failure.message}</p>)}
        </Disclosure>
        <button type="button" className="nt-button nt-button--ghost" disabled={busy} aria-label="Retry unavailable communities" onClick={() => void readFeed(current?.nextCursor, !current?.nextCursor)}>Retry</button>
      </div>}
      {fresh && <button type="button" className="nt-button snsgov-new-proposals" onClick={() => { setState({ ...fresh, proposals: merge(current?.proposals ?? [], fresh.proposals) }); setFresh(null); }}>{newCount ? `Show ${newCount} new proposal${newCount === 1 ? "" : "s"}` : "Show refreshed feed"}</button>}
      {!busy && current && visible.length === 0 && <>
        <Empty label={noSelection ? "No communities selected. Choose communities to see their proposals." : communityScope === "my" && selectedRoots.length === 0 ? "No connected communities match your filter. Connect a neuron in My neurons or change the filter." : current.nextCursor ? "No matching proposals in the pages loaded so far. Load more to keep looking." : failures.length ? "No matching proposals from the communities that could be read." : "No proposals match these filters."} />
        {noSelection && <button type="button" className="nt-button" onClick={openFilter}>Choose communities</button>}
      </>}
      <div className="snsgov-feed-posts">{visible.map(row => {
        const entry = byRoot.get(row.sns);
        return entry && <ProposalPost key={key(row)} entry={entry} proposal={row.proposal} onOpenSns={onOpenSns} onOpen={button => {
          backTarget.current = button;
          feedScroll.current = feed.current?.closest<HTMLElement>(".snsgov-content, .nt-page-main")?.scrollTop ?? 0;
          setOpened(row);
        }} />;
      })}</div>
      {current?.nextCursor && <button type="button" className="nt-button snsgov-more" disabled={busy} onClick={() => void readFeed(current.nextCursor)}>{busy ? "Loading…" : "Load more"}</button>}
    </div>
    {opened && openedEntry && <ProposalDetailView key={key(opened)} entry={openedEntry} proposalId={opened.proposal.id} onBack={() => {
      setOpened(null);
      requestAnimationFrame(() => {
        backTarget.current?.focus({ preventScroll: true });
        const owner = feed.current?.closest<HTMLElement>(".snsgov-content, .nt-page-main");
        if (owner) owner.scrollTop = feedScroll.current;
      });
    }} />}
    {filterDraft && <Dialog title="Filter communities" onClose={() => setFilterDraft(null)} footer={<button type="button" className="nt-button" onClick={() => { setSelection(filterDraft); setFilterDraft(null); }}>Apply filter</button>}>
      <div className="snsgov-community-filter">
        <p className="nt-meta">Choose the communities included in your feed. My communities also limits results to communities with your connected neurons.</p>
        <label className="snsgov-field"><span className="nt-sr-only">Search communities</span><input type="search" className="nt-input" aria-label="Search communities" placeholder="Search communities" value={filterSearch} onChange={event => setFilterSearch(event.target.value)} /></label>
        <div className="snsgov-community-filter-actions"><button type="button" className="nt-button nt-button--ghost" onClick={() => setFilterDraft({ mode: "except", roots: [] })}>Select all</button><button type="button" className="nt-button nt-button--ghost" onClick={() => setFilterDraft({ mode: "only", roots: [] })}>Clear selection</button><span className="nt-meta">{availableEntries.filter(entry => includesCommunity(filterDraft, entry.canisters.root)).length} selected</span></div>
        <fieldset className="snsgov-community-checks"><legend className="nt-sr-only">Available communities</legend>{filteredEntries.map(entry => <label key={entry.canisters.root}>
          <input type="checkbox" checked={includesCommunity(filterDraft, entry.canisters.root)} onChange={event => setFilterDraft(previous => previous ? toggleCommunity(previous, entry.canisters.root, event.target.checked) : previous)} />
          <span><span className="snsgov-community-check-name">{displayName(entry)}</span>{entry.token?.symbol && <small className="nt-meta">{entry.token.symbol}</small>}</span>
        </label>)}</fieldset>
        {filteredEntries.length === 0 && <p className="nt-meta">{busy && availableEntries.length === 0 ? "Checking community availability…" : filterSearch.trim() ? "No communities match your search." : "No active communities have been found yet. Refresh the feed to check again."}</p>}
      </div>
    </Dialog>}
    {chooseCommunity && <Dialog title="Create a proposal" onClose={() => setChooseCommunity(false)}>
      <label className="snsgov-field"><span>Community</span><select className="nt-select" aria-label="Community" value={availableByRoot.has(createRoot) ? createRoot : ""} onChange={event => setCreateRoot(event.target.value)}><option value="" disabled>Choose a community…</option>{availableEntries.map(entry => <option key={entry.canisters.root} value={entry.canisters.root}>{displayName(entry)}</option>)}</select></label>
      <button type="button" className="nt-button" disabled={!availableByRoot.has(createRoot)} onClick={() => { setCreating(availableByRoot.get(createRoot) ?? null); setChooseCommunity(false); }}>Continue</button>
    </Dialog>}
    {creating && <ProposalCreate entry={creating} onClose={() => setCreating(null)} onCreated={id => {
      const entry = creating; setCreating(null);
      if (id !== undefined) setOpened({ sns: entry.canisters.root, proposal: { id, title: "", summary: "", url: "", status: "unknown", actionKind: "", createdAtSeconds: 0n } });
      void readFeed(undefined, true);
    }} />}
  </div>;
}

function key(row: FeedProposal) { return `${row.sns}:${row.proposal.id}`; }
function merge(a: FeedProposal[], b: FeedProposal[]) { return [...new Map([...a, ...b].map(row => [key(row), row])).values()].sort(compareFeedProposals); }
function includesCommunity(selection: CommunitySelection, root: string): boolean { return selection.mode === "except" ? !selection.roots.includes(root) : selection.roots.includes(root); }
function toggleCommunity(selection: CommunitySelection, root: string, checked: boolean): CommunitySelection {
  const add = selection.mode === "only" ? checked : !checked;
  return { ...selection, roots: add ? [...new Set([...selection.roots, root])] : selection.roots.filter(value => value !== root) };
}
function readSelection(): CommunitySelection {
  try {
    const value = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? "null") as CommunitySelection | null;
    if (value && (value.mode === "except" || value.mode === "only") && Array.isArray(value.roots) && value.roots.every(root => typeof root === "string")) return value;
  } catch { /* Unsupported storage or an old preference uses the default view. */ }
  return { mode: "except", roots: [] };
}
