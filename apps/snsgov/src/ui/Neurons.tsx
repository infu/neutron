import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { copyToClipboard } from "neutron-tools/app";
import { listAllNeurons, listNeurons } from "../data/governance";
import { displayName, getRegistry, type RegistryEntry } from "../data/registry";
import { readHotkey } from "../data/relay";
import { pool } from "../data/pool";
import { shortenId } from "../data/format";
import type { NeuronSummary } from "../data/types";
import { Disclosure, ErrorNote, PageHeading } from "./Common";
import { Empty, Pending } from "./Status";
import { NeuronDetail, NeuronRow } from "./NeuronDetail";
import { StakingDialog } from "./StakingDialog";

interface Source {
  entry: RegistryEntry;
  neurons?: NeuronSummary[];
  error?: string | undefined;
  incomplete?: boolean;
  loading?: boolean;
}

export function MyNeuronsView({ onConnect, initialRootCanisterId, initialNeuronId, navigationKey = 0 }: {
  onConnect?: () => void;
  initialRootCanisterId?: string | undefined;
  initialNeuronId?: string;
  navigationKey?: number;
}) {
  const [sources, setSources] = useState<Source[]>([]);
  const [entries, setEntries] = useState<RegistryEntry[]>([]);
  const [principal, setPrincipal] = useState<string>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  const [stake, setStake] = useState(false);
  const [connect, setConnect] = useState(false);
  const [selected, setSelected] = useState<{ root: string; id: string } | undefined>(() =>
    initialRootCanisterId && initialNeuronId ? { root: initialRootCanisterId, id: initialNeuronId } : undefined);
  const generation = useRef(0);
  const listRoot = useRef<HTMLDivElement>(null);
  const returnTo = useRef<{ id: string; y: number } | undefined>(undefined);
  useLayoutEffect(() => {
    if (!selected && returnTo.current) {
      listRoot.current?.querySelector<HTMLButtonElement>(`[data-neuron-id="${returnTo.current.id}"]`)?.focus({ preventScroll: true });
      window.scrollTo(0, returnTo.current.y);
    }
  }, [selected]);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  useEffect(() => {
    setSelected(initialRootCanisterId && initialNeuronId
      ? { root: initialRootCanisterId, id: initialNeuronId } : undefined);
  }, [initialRootCanisterId, initialNeuronId, navigationKey]);

  const scan = useCallback(async (failedOnly = false) => {
    const current = ++generation.current;
    setBusy(true);
    setError(undefined);
    try {
      const [registry, hotkey] = await Promise.all([getRegistry(), readHotkey()]);
      if (current !== generation.current) return;
      setPrincipal(hotkey.principal);
      const available = registry.entries.filter(entry => registry.livenessKnown === false || entry.liveness.governance);
      setEntries(available);
      const previous = sourcesRef.current;
      const targets = failedOnly ? available.filter(entry => previous.some(source =>
        source.entry.canisters.root === entry.canisters.root && (source.error || source.incomplete))) : available;
      const targetIds = new Set(targets.map(entry => entry.canisters.root));
      setSources(available.map(entry => ({ ...previous.find(source => source.entry.canisters.root === entry.canisters.root),
        entry, loading: targetIds.has(entry.canisters.root) })));
      await pool(targets, 8, async entry => {
        let replacement: Source;
        try {
          const result = await listAllNeurons(entry.canisters.governance, { ofPrincipal: hotkey.principal });
          const details = result.failures.map(failure => failure.message).join("; ");
          const old = previous.find(source => source.entry.canisters.root === entry.canisters.root)?.neurons ?? [];
          const neurons = result.truncated || result.failures.length
            ? [...new Map([...old, ...result.neurons].map(neuron => [neuron.id, neuron])).values()]
            : result.neurons;
          replacement = { entry, neurons, incomplete: result.truncated || result.failures.length > 0,
            error: details || undefined, loading: false };
        } catch (caught) {
          replacement = { ...previous.find(source => source.entry.canisters.root === entry.canisters.root),
            entry, error: String(caught), incomplete: true, loading: false };
        }
        if (current !== generation.current) return;
        setSources(existing => existing.map(source => source.entry.canisters.root === entry.canisters.root ? replacement : source));
      });
    } catch (caught) {
      if (current === generation.current) setError(String(caught));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }, []);
  useEffect(() => { void scan(); return () => { generation.current += 1; }; }, [scan]);

  const selectedEntry = selected && entries.find(entry => entry.canisters.root === selected.root);
  if (selectedEntry && selected && principal) return <NeuronDetail key={`${selected.root}/${selected.id}`} entry={selectedEntry}
    neuronId={selected.id} principal={principal} onBack={() => setSelected(undefined)} />;
  const count = sources.reduce((total, source) => total + (source.neurons?.length ?? 0), 0);
  const failures = sources.filter(source => source.error || source.incomplete);
  const checked = sources.filter(source => !source.loading).length;
  return <div className="nt-page snsgov-my-neurons" ref={listRoot}>
    <PageHeading title="My neurons" description="Staked tokens and neurons that grant this Neutron access."
      actions={<><button className="nt-button nt-button--primary" type="button" onClick={() => setStake(true)}>Stake tokens</button>
        <button className="nt-button nt-button--secondary" type="button" onClick={() => { setConnect(value => !value); }}>Connect existing neurons</button>
        <button className="nt-button nt-button--ghost" type="button" disabled={busy} onClick={() => void scan()}>Refresh neurons</button></>} />
    <section className="nt-page-main">
      {error && <ErrorNote message={error ?? null} />}
      {connect && <section className="nt-section snsgov-connect">
        <h2 className="nt-section-heading">Connect existing neurons</h2>
        <p>Keep your neuron in its current wallet and grant this Neutron the access you want it to have.</p>
        <ol><li>Copy this Neutron’s principal.</li><li>In the wallet that controls your neuron, add the principal with Vote permission (4). Add Submit proposals (3) only if desired.</li><li>Return here and check the connection.</li></ol>
        {principal ? <div className="snsgov-neuron-copy"><code className="nt-code">{principal}</code><button className="nt-button nt-button--secondary" type="button" onClick={() => void copyToClipboard(principal)}>Copy Neutron principal</button></div> : <Pending label="Reading Neutron principal" />}
        <p className="nt-meta">The access you select in the controlling wallet determines what this Neutron can do. Copying a principal does not grant any permissions.</p>
        <div className="snsgov-neuron-actions"><button className="nt-button nt-button--secondary" type="button" disabled={busy} onClick={() => void scan()}>Check connection</button>
          {onConnect && <button className="nt-button nt-button--ghost" type="button" onClick={onConnect}>Connection settings</button>}</div>
      </section>}
      {busy && <Pending label={sources.length ? `Checking communities: ${checked} of ${sources.length}` : "Finding your neurons"} />}
      {failures.length > 0 && <div className="nt-alert nt-alert--warning" role="status">
        <p>Neuron discovery is incomplete in {failures.length} {failures.length === 1 ? "community" : "communities"}. Previously read neurons remain visible.</p>
        <button className="nt-button nt-button--secondary" type="button" disabled={busy} onClick={() => void scan(true)}>Retry unavailable communities</button>
        <Disclosure title="Read details">{failures.map(source => <p key={source.entry.canisters.root}>{displayName(source.entry)}: {source.error || "Additional neurons could not be read."}</p>)}</Disclosure>
      </div>}
      {!busy && count === 0 && !error && <Empty label={failures.length ? "No connected neurons found in the communities checked successfully." : "No connected neurons yet. Stake tokens or connect an existing neuron to begin."} />}
      {sources.filter(source => source.neurons?.length).map(source => <section className="nt-section" key={source.entry.canisters.root}>
        <header className="nt-section-header"><h2 className="nt-section-heading">{displayName(source.entry)}</h2><span className="nt-section-count">{source.neurons!.length}</span></header>
        <div className="snsgov-neuron-list">{source.neurons!.map(neuron => <NeuronRow key={neuron.id} neuron={neuron} entry={source.entry} principal={principal}
          onOpen={() => { returnTo.current = { id: neuron.id, y: window.scrollY }; setSelected({ root: source.entry.canisters.root, id: neuron.id }); }} />)}</div>
      </section>)}
      {selected && !selectedEntry && !busy && <ErrorNote message="The requested neuron’s community could not be found in the registry." />}
    </section>
    {stake && <StakingDialog entries={entries} initialRootCanisterId={initialRootCanisterId} onClose={() => setStake(false)} onComplete={() => void scan()} />}
  </div>;
}

/** Community explorer keeps explicit pagination and same-query rows after errors. */
export function NeuronsView({ entry }: { entry: RegistryEntry }) {
  const [neurons, setNeurons] = useState<NeuronSummary[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [applied, setApplied] = useState<string>();
  const [next, setNext] = useState<Uint8Array>();
  const [incomplete, setIncomplete] = useState(false);
  const [principal, setPrincipal] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const generation = useRef(0);
  const queryKey = useRef<string | undefined>(undefined);
  const load = useCallback(async (ofPrincipal?: string, startPageAt?: Uint8Array) => {
    const current = ++generation.current;
    const key = `${entry.canisters.governance}/${ofPrincipal ?? ""}`;
    if (queryKey.current !== key) { setNeurons(undefined); setNext(undefined); setIncomplete(false); }
    queryKey.current = key;
    setApplied(ofPrincipal); setBusy(true); setError(undefined);
    try {
      const result = await listNeurons(entry.canisters.governance, { ...(ofPrincipal ? { ofPrincipal } : {}), ...(startPageAt ? { startPageAt } : {}), limit: 100 });
      if (current !== generation.current) return;
      setNeurons(old => startPageAt ? [...new Map([...(old ?? []), ...result.neurons].map(neuron => [neuron.id, neuron])).values()] : result.neurons);
      setNext(result.nextStartPageAt);
      setIncomplete(result.truncated && !result.nextStartPageAt);
    } catch (caught) { if (current === generation.current) setError(String(caught)); }
    finally { if (current === generation.current) setBusy(false); }
  }, [entry.canisters.governance]);
  useEffect(() => { void load(); void readHotkey().then(key => setPrincipal(key.principal), () => {});
    return () => { generation.current += 1; }; }, [load]);
  if (selected) return <NeuronDetail key={selected} entry={entry} neuronId={selected} principal={principal} onBack={() => setSelected(undefined)} />;
  return <section className="nt-section">
    <header className="nt-section-header"><h2 className="nt-section-heading">Neurons</h2><span className="snsgov-spacer" />
      <button type="button" className="nt-button nt-button--secondary" disabled={busy} onClick={() => void load(applied)}>Refresh neurons</button></header>
    <p className="nt-meta">Public neurons in this community. Filter by a principal to see the access it holds.</p>
    <div className="snsgov-filter"><label className="nt-sr-only" htmlFor="snsgov-principal-filter">Filter by principal</label>
      <input className="nt-input" id="snsgov-principal-filter" placeholder="Principal" value={filter} onChange={event => setFilter(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) void load(filter.trim() || undefined); }} />
      <button className="nt-button nt-button--secondary" type="button" aria-label="Filter neurons by principal" onClick={() => void load(filter.trim() || undefined)}>Filter</button></div>
    {busy && <Pending label="Reading neurons" />}
    {error && <ErrorNote message={error ?? null} />}
    {neurons?.length === 0 && <Empty label={applied ? "No neuron grants that principal any permission." : "No neurons found."} />}
    <div className="snsgov-neuron-list">{neurons?.map(neuron => <div key={neuron.id}><NeuronRow entry={entry} neuron={neuron} principal={principal} onOpen={() => setSelected(neuron.id)} />
      <button type="button" className="nt-button nt-button--ghost snsgov-neuron-copy-action" aria-label="Copy neuron id" onClick={() => void copyToClipboard(neuron.id)}>Copy {shortenId(neuron.id, 8, 6)}</button></div>)}</div>
    {incomplete && <p role="status" className="nt-alert nt-alert--warning">This response may omit additional neurons; the community did not provide a usable continuation.</p>}
    {next && <button className="nt-button nt-button--secondary" type="button" disabled={busy} onClick={() => void load(applied, next)}>Load more neurons</button>}
  </section>;
}
