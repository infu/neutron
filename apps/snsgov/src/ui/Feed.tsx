import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getFeedRegistry, loadProposalFeedPage, compareFeedProposals, type FeedProposal, type ProposalFeedPage } from "../data/feed";
import { listProposals, readMetadata } from "../data/governance";
import { displayName, type RegistryEntry } from "../data/registry";
import { readHotkey } from "../data/relay";
import { scanForNeuronsDetailed } from "../data/registration";
import { Dialog, Disclosure, ErrorNote, PageHeading, useRead } from "./Common";
import { Empty, Pending } from "./Status";
import { acceptsVotes, ProposalDetailView, ProposalPost } from "./Proposals";
import { ProposalCreate } from "./ProposalCreate";

interface FeedState extends ProposalFeedPage { key: string }

export function FeedView({ onOpenSns }: { onOpenSns?: ((entry: RegistryEntry) => void) | undefined } = {}) {
  const registry = useRead("feed-registry", () => getFeedRegistry());
  const [enriched, setEnriched] = useState<Record<string, RegistryEntry["metadata"]>>({});
  const [communityFilter, setCommunityFilter] = useState("all");
  const [activityFilter, setActivityFilter] = useState("voting");
  const [myRoots, setMyRoots] = useState<string[] | null>(null);
  const [myError, setMyError] = useState<string | null>(null);
  const [myLoading, setMyLoading] = useState(false);
  const [state, setState] = useState<FeedState | null>(null);
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
  const entries = registry.data?.entries.filter(entry => registry.data?.livenessKnown === false || entry.liveness.governance).map(entry => enriched[entry.canisters.root] ? { ...entry, metadata: enriched[entry.canisters.root]! } : entry) ?? [];
  const byRoot = new Map(entries.map(entry => [entry.canisters.root, entry]));
  const rootsKey = entries.map(entry => entry.canisters.root).sort().join(",");
  const selectedKey = communityFilter === "all" ? rootsKey : communityFilter === "my" ? myRoots?.slice().sort().join(",") : communityFilter;
  const selectedRoots = useMemo(() => selectedKey ? selectedKey.split(",") : [], [selectedKey]);
  const metadataStarted = useRef(new Set<string>());
  useEffect(() => {
    const roots = [...new Set([...(state?.proposals ?? []), ...progressive].map(row => row.sns))];
    for (const root of roots) {
      const entry = registry.data?.entries.find(entry => entry.canisters.root === root);
      if (!entry || entry.metadata?.name || metadataStarted.current.has(root)) continue;
      metadataStarted.current.add(root);
      void readMetadata(entry.canisters.governance).then(metadata => setEnriched(current => ({ ...current, [root]: metadata })), () => { /* Proposal reads remain usable when branding is unavailable. */ });
    }
  }, [state, progressive, registry.data]);

  const findMine = useCallback(async () => {
    if (!registry.data) return;
    const request = ++myGeneration.current;
    setMyLoading(true); setMyError(null);
    try {
      const hotkey = await readHotkey();
      const result = await scanForNeuronsDetailed(registry.data.entries.filter(entry => registry.data?.livenessKnown === false || entry.liveness.governance).map(entry => ({
        rootCanisterId: entry.canisters.root, governanceCanisterId: entry.canisters.governance, label: displayName(entry),
      })), hotkey.principal);
      if (request !== myGeneration.current) return;
      setMyRoots(result.value.map(entry => entry.rootCanisterId));
      if (result.failures.length) setMyError(`${result.failures.length} communities could not be checked for your neurons. Your community list is incomplete.`);
    } catch (reason) { if (request === myGeneration.current) setMyError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (request === myGeneration.current) setMyLoading(false); }
  }, [registry.data]);

  useEffect(() => {
    if (communityFilter === "my" && myRoots === null && !myLoading && !myError) void findMine();
  }, [communityFilter, myRoots, myLoading, myError, findMine]);
  useEffect(() => () => { myGeneration.current++; }, []);

  const readFeed = useCallback(async (cursor?: string, isRefresh = false) => {
    if (selectedKey === undefined || !registry.data) return;
    const request = ++generation.current;
    const entriesByRoot = new Map(registry.data.entries.map(entry => [entry.canisters.root, entry]));
    const visited = new Set<string>();
    setBusy(true); setError(null); setChecked(0);
    if (!cursor && !isRefresh) setProgressive([]);
    try {
      const result = await loadProposalFeedPage({ sns: selectedRoots, limit: 20, ...(cursor ? { cursor } : {}) }, async params => {
        const entry = entriesByRoot.get(params.sns);
        if (!entry) throw new Error(`Community ${params.sns} is no longer in the registry.`);
        try {
          const page = await listProposals(entry.canisters.governance, {
            limit: params.limit, ...(params.beforeProposal === undefined ? {} : { beforeProposal: params.beforeProposal }),
          });
          if (request === generation.current && !cursor && !isRefresh) setProgressive(previous => merge(previous, page.proposals.map(proposal => ({ sns: params.sns, proposal }))));
          return page;
        } finally {
          if (request === generation.current) { visited.add(params.sns); setChecked(visited.size); }
        }
      });
      if (request !== generation.current) return;
      const page = { ...result, key: selectedKey };
      if (isRefresh) {
        setFresh(result.proposals.length > 0 ? page : null);
        // Existing posts keep their position while current tallies/status update.
        setState(previous => {
          if (previous?.key !== selectedKey) return previous;
          const updates = new Map(result.proposals.map(row => [key(row), row]));
          return { ...previous, failures: result.failures, proposals: previous.proposals.map(row => updates.get(key(row)) ?? row) };
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
  const newCount = fresh?.proposals.filter(row => !current?.proposals.some(old => key(old) === key(row))).length ?? 0;
  const openedEntry = opened ? byRoot.get(opened.sns) : undefined;

  return <div className="snsgov-feed">
    <div ref={feed} hidden={opened !== null}>
      <PageHeading title="Feed" description="Proposals from communities across the SNS network." actions={<>
        <button type="button" className="nt-button nt-button--ghost" disabled={busy || !current} onClick={() => void readFeed(undefined, true)}>{busy && current ? "Refreshing…" : "Refresh"}</button>
        <button type="button" className="nt-button" disabled={!entries.length} onClick={() => { setCreateRoot(entries[0]?.canisters.root ?? ""); setChooseCommunity(true); }}>Create proposal</button>
      </>} />
      <div className="snsgov-feed-filters">
        <label className="snsgov-field"><span>Communities</span><select className="nt-select" value={communityFilter} onChange={event => setCommunityFilter(event.target.value)}>
          <option value="all">All communities</option><option value="my">My communities</option>
          {entries.map(entry => <option key={entry.canisters.root} value={entry.canisters.root}>{displayName(entry)}</option>)}
        </select></label>
        <label className="snsgov-field"><span>Show</span><select className="nt-select" value={activityFilter} onChange={event => setActivityFilter(event.target.value)}><option value="voting">Accepting votes</option><option value="all">All activity</option></select></label>
      </div>
      {registry.error && <ErrorNote message={registry.error} />}
      {error && <ErrorNote message={error} />}
      {(registry.loading && !registry.data) && <Pending label="Reading communities" />}
      {communityFilter === "my" && myLoading && <Pending label="Checking communities for your neurons" />}
      {communityFilter === "my" && myError && <><ErrorNote message={myError} /><button type="button" className="nt-button nt-button--ghost" disabled={myLoading} onClick={() => void findMine()}>Retry community discovery</button></>}
      {busy && <p className="nt-meta" role="status">{current ? "Reading more proposals…" : `Checking ${checked} of ${selectedRoots.length} communities…`}</p>}
      {current?.failures.length ? <div className="nt-alert nt-alert--warning">
        <p>Feed coverage is incomplete: {current.failures.length} communities could not be read.</p>
        <Disclosure title="Unavailable communities">{current.failures.map(failure => <p key={failure.scope} className="nt-meta">{byRoot.get(failure.scope) ? displayName(byRoot.get(failure.scope)!) : failure.scope}: {failure.message}</p>)}</Disclosure>
        <button type="button" className="nt-button nt-button--ghost" disabled={busy} onClick={() => void readFeed(current.nextCursor)}>Retry failed communities</button>
      </div> : null}
      {fresh && <button type="button" className="nt-button snsgov-new-proposals" onClick={() => { setState({ ...fresh, proposals: merge(current?.proposals ?? [], fresh.proposals) }); setFresh(null); }}>{newCount ? `Show ${newCount} new proposal${newCount === 1 ? "" : "s"}` : "Show refreshed feed"}</button>}
      {!busy && current && visible.length === 0 && <Empty label={communityFilter === "my" && selectedRoots.length === 0 ? "No connected neurons found. Use My neurons to connect an existing neuron or stake tokens." : current.nextCursor ? "No matching proposals in the pages loaded so far. Load more to keep looking." : current.failures.length ? "No matching proposals from the communities that could be read." : "No proposals match these filters."} />}
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
    {chooseCommunity && <Dialog title="Create a proposal" onClose={() => setChooseCommunity(false)}>
      <label className="snsgov-field"><span>Community</span><select className="nt-select" value={createRoot} onChange={event => setCreateRoot(event.target.value)}>{entries.map(entry => <option key={entry.canisters.root} value={entry.canisters.root}>{displayName(entry)}</option>)}</select></label>
      <button type="button" className="nt-button" disabled={!byRoot.has(createRoot)} onClick={() => { setCreating(byRoot.get(createRoot) ?? null); setChooseCommunity(false); }}>Continue</button>
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
