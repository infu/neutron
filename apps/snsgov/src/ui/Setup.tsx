import { useCallback, useEffect, useRef, useState } from "react";
import { copyToClipboard, querySelf, updateSelf } from "neutron-tools/app";
import { displayName, getRegistry } from "../data/registry";
import { readHotkey, type HotkeyStatus } from "../data/relay";
import { scanForNeuronsDetailed, type DiscoveredSns } from "../data/registration";
import { Disclosure, ErrorNote, Help, PageHeading, useRead } from "./Common";
import { RegistrationButton } from "./Registration";

interface AllowlistRow {
  sns: string;
  governance: string;
  votingEnabled: boolean;
  agentVotingEnabled: boolean;
  label: string;
}

type ScanTarget = Pick<DiscoveredSns, "rootCanisterId" | "governanceCanisterId" | "label">;
type ScanFailure = { scope: string; code: string; message: string };

async function readConnections(): Promise<AllowlistRow[]> {
  const raw = await querySelf("snsgov_config", [null]) as unknown as { snses: Record<string, unknown>[] };
  return raw.snses.map(row => ({
    sns: principalText(row.sns), governance: principalText(row.governance),
    votingEnabled: Boolean(row.voting_enabled), agentVotingEnabled: Boolean(row.agent_voting_enabled),
    label: String(row.label_text ?? ""),
  }));
}

export function SetupView({ onBack }: { onBack: () => void }) {
  const [refresh, setRefresh] = useState(0);
  const hotkey = useRead("settings-principal", () => readHotkey(), refresh);
  const connections = useRead("settings-connections", readConnections, refresh);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const running = useRef(false);
  const loading = hotkey.loading || connections.loading;

  const upsert = useCallback(async (row: AllowlistRow): Promise<boolean> => {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    setMessage(null);
    try {
      await updateSelf("snsgov_sns_upsert", [{
        sns: row.sns, governance: row.governance, voting_enabled: row.votingEnabled,
        agent_voting_enabled: row.agentVotingEnabled, label_text: row.label.slice(0, 64),
      }]);
      setRefresh(value => value + 1);
      return true;
    } catch (error) {
      setMessage(String(error));
      return false;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);

  const remove = async (sns: string) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage(null);
    try {
      await updateSelf("snsgov_sns_remove", [sns]);
      setRefresh(value => value + 1);
    } catch (error) {
      setMessage(String(error));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  return <div className="nt-page snsgov-settings">
    <PageHeading title="Connections & settings" onBack={onBack}
      description="Connect communities and manage neuron access."
      actions={<button className="nt-button nt-button--ghost" disabled={busy || loading} onClick={() => setRefresh(value => value + 1)} type="button">
        {loading ? "Refreshing…" : "Refresh settings"}
      </button>} />
    <section className="nt-page-main">
      <ErrorNote message={message} />
      <ErrorNote message={hotkey.error} />
      <ErrorNote message={connections.error} />
      <PrincipalSection hotkey={hotkey.data} loading={hotkey.loading} />
      <NeuronScan busy={busy || loading} hotkey={hotkey.data} onAdd={upsert} rows={connections.data} />
      <section className="nt-section">
        <header className="nt-section-header">
          <h2 className="nt-section-heading">Connected communities</h2>
          {connections.data && <span className="nt-section-count">{connections.data.length}</span>}
        </header>
        <p className="nt-text">Connections allow neuron actions for each community, using the permissions granted to this Neutron.</p>
        {connections.data === null && <p className="nt-meta" role="status">
          {connections.loading ? "Reading your connections…" : "Connections unavailable. Refresh settings to try again."}
        </p>}
        {connections.data?.length === 0 && <p className="nt-text">No communities connected yet. Find your neurons above to get started.</p>}
        {connections.data && connections.data.length > 0 && <ul className="snsgov-settings-list" aria-label="Connected communities">
          {connections.data.map(row => <li className="snsgov-settings-row" key={row.sns}>
            <strong className="snsgov-settings-name">{row.label || row.sns}</strong>
            <div className="snsgov-preference-row">
              <label className="snsgov-setting-toggle">
                <input className="nt-checkbox" aria-label={`Connection for ${row.label || row.sns}`} checked={row.votingEnabled} disabled={busy || loading}
                  onChange={event => void upsert({ ...row, votingEnabled: event.target.checked })} type="checkbox" />
                <span>Connection</span>
              </label>
              <Help label={`connection to ${row.label || row.sns}`}>Allows this app to send neuron actions to this community's governance canister with the permissions already granted to this Neutron.</Help>
            </div>
            <p className="nt-meta">{row.votingEnabled ? "Connected" : "This community is disconnected in the app."}</p>
            <RegistrationButton target={{ rootCanisterId: row.sns, governanceCanisterId: row.governance, label: row.label || row.sns }}
              onChanged={() => setRefresh(value => value + 1)} />
            <Disclosure title="Legacy relay compatibility">
              <p className="nt-text">This preference applies only to the older voting relay. Current tools follow Kernel mode and owner reviews.</p>
              <div className="snsgov-preference-row">
                <label className="snsgov-setting-toggle">
                  <input className="nt-checkbox" aria-label={`Legacy agent voting for ${row.label || row.sns}`} checked={row.agentVotingEnabled} disabled={busy || loading || !row.votingEnabled}
                    onChange={event => void upsert({ ...row, agentVotingEnabled: event.target.checked })} type="checkbox" />
                  <span>Legacy agent voting</span>
                </label>
                <Help label={`legacy agent voting in ${row.label || row.sns}`}>Allows agent votes through the older relay when this community is connected. It does not control current neuron tools.</Help>
              </div>
            </Disclosure>
            <Disclosure title="Connection details">
              <dl className="snsgov-settings-values">
                <dt>SNS root</dt><dd><code className="nt-code snsgov-principal-text">{row.sns}</code></dd>
                <dt>Governance</dt><dd><code className="nt-code snsgov-principal-text">{row.governance}</code></dd>
              </dl>
              <p className="nt-text">Disconnecting removes this app's connection. Permissions already granted on your neurons stay in place.</p>
              <button aria-label={`Disconnect ${row.label || row.sns}`} className="nt-button nt-button--ghost" disabled={busy || loading}
                onClick={() => void remove(row.sns)} type="button">Disconnect community</button>
            </Disclosure>
          </li>)}
        </ul>}
      </section>
    </section>
  </div>;
}

function PrincipalSection({ hotkey, loading }: { hotkey: HotkeyStatus | null; loading: boolean }) {
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const copy = async () => {
    if (!hotkey) return;
    try { await copyToClipboard(hotkey.principal); setCopied(true); setMessage(null); }
    catch (error) { setMessage(`Could not copy your principal: ${String(error)}`); }
  };
  return <section className="nt-section">
    <header className="nt-section-header"><h2 className="nt-section-heading">Connect existing neurons</h2></header>
    <p className="nt-text">In the wallet that controls your neuron, add this Neutron's principal as a hotkey with Vote permission. Then choose Find my neurons below.</p>
    {hotkey === null ? <p className="nt-meta" role="status">
      {loading ? "Reading this Neutron's principal…" : "Principal unavailable. Refresh settings to try again."}
    </p> : <>
      <div className="snsgov-principal-row">
        <code aria-label="Your voting principal" className="nt-code snsgov-principal-text">{hotkey.principal}</code>
        <button aria-label="Copy your voting principal" className="nt-button nt-button--ghost" onClick={() => void copy()} type="button">{copied ? "Copied" : "Copy principal"}</button>
      </div>
      <ErrorNote message={message} />
      <Disclosure title="Permissions and connection details">
        <p className="nt-text">Vote permission (4) lets this Neutron vote. Add SubmitProposal (3) if you also want to publish proposals.
          These permissions alone cannot move tokens or change when a neuron unlocks. Other permissions previously granted remain in place.</p>
        <p className="nt-text">This principal belongs to your Neutron canister, so connected capabilities can work while your browser is closed.</p>
        <p className="nt-text">Each connected SNS is recorded in this app's allowlist. The installed governance signing capability is for <code className="nt-code">manage_neuron</code>.</p>
        {!hotkey.canManageNeuron && <p className="nt-alert nt-alert--warning" role="status">The installed app does not have its governance signing capability yet. Install a compatible app update to grant it.</p>}
      </Disclosure>
    </>}
  </section>;
}

function NeuronScan({ hotkey, rows, onAdd, busy }: {
  hotkey: HotkeyStatus | null; rows: AllowlistRow[] | null;
  onAdd: (row: AllowlistRow) => Promise<boolean>; busy: boolean;
}) {
  const [scanning, setScanning] = useState(false);
  const [adding, setAdding] = useState(false);
  const [found, setFound] = useState<DiscoveredSns[] | null>(null);
  const [targets, setTargets] = useState<ScanTarget[]>([]);
  const [failures, setFailures] = useState<ScanFailure[]>([]);
  const [checked, setChecked] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const running = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const failedTargets = targets.filter(target => failures.some(failure =>
    failure.scope === target.rootCanisterId || failure.scope === target.governanceCanisterId ||
    failure.scope.startsWith(`${target.rootCanisterId}:`) || failure.scope.startsWith(`${target.governanceCanisterId}:`),
  ));

  const scan = async (retry = false) => {
    if (!hotkey || running.current) return;
    running.current = true;
    setScanning(true);
    setError(null);
    try {
      const requested = retry ? failedTargets : (await getRegistry()).entries.map(entry => ({
        rootCanisterId: entry.canisters.root, governanceCanisterId: entry.canisters.governance, label: displayName(entry),
      }));
      if (!mounted.current) return;
      if (!retry) setTargets(requested);
      const result = await scanForNeuronsDetailed(requested, hotkey.principal);
      if (!mounted.current) return;
      setFound(previous => retry
        ? [...(previous ?? []).filter(entry => !requested.some(target => target.rootCanisterId === entry.rootCanisterId)), ...result.value]
        : result.value);
      setFailures(previous => retry
        ? [...previous.filter(failure => !requested.some(target => failure.scope === target.rootCanisterId || failure.scope === target.governanceCanisterId || failure.scope.startsWith(`${target.rootCanisterId}:`) || failure.scope.startsWith(`${target.governanceCanisterId}:`))), ...result.failures]
        : result.failures);
      if (!retry) setChecked(requested.length);
    } catch (caught) {
      if (mounted.current) setError(String(caught));
    } finally {
      running.current = false;
      if (mounted.current) setScanning(false);
    }
  };

  const missing = (found ?? []).filter(entry => !rows?.some(row => row.sns === entry.rootCanisterId && row.votingEnabled));
  const add = async (entries: DiscoveredSns[]) => {
    setAdding(true);
    try {
      for (const entry of entries) {
        const existing = rows?.find(row => row.sns === entry.rootCanisterId);
        if (!await onAdd({ sns: entry.rootCanisterId, governance: entry.governanceCanisterId,
          votingEnabled: true, agentVotingEnabled: existing?.agentVotingEnabled ?? false, label: existing?.label || entry.label })) break;
      }
    } finally { if (mounted.current) setAdding(false); }
  };

  return <section className="nt-section">
    <header className="nt-section-header"><h2 className="nt-section-heading">Find my neurons</h2></header>
    <p className="nt-text">Check communities for neurons that already grant this Neutron permission.</p>
    <div className="snsgov-settings-actions">
      <button className="nt-button" disabled={scanning || adding || busy || hotkey === null} onClick={() => void scan()} type="button">
        {scanning ? "Finding neurons…" : "Find my neurons"}
      </button>
      {failures.length > 0 && <button className="nt-button nt-button--ghost" disabled={scanning || adding || busy || hotkey === null}
        onClick={() => void scan(failedTargets.length > 0)} type="button">Retry failed communities</button>}
    </div>
    <ErrorNote message={error} />
    {found !== null && <p className="nt-meta" role="status">
      Checked {checked} communit{checked === 1 ? "y" : "ies"} · Found {found.reduce((sum, entry) => sum + entry.status.found.length, 0)} connected neuron{found.reduce((sum, entry) => sum + entry.status.found.length, 0) === 1 ? "" : "s"}
      {failures.length > 0 ? " · Results are incomplete" : ""}
    </p>}
    {failures.length > 0 && <>
      <p className="nt-alert nt-alert--warning" role="status">Some community reads failed. There may be more neurons or permissions than shown here.</p>
      <Disclosure title="Unavailable reads">
        <ul className="snsgov-settings-list">{failures.map((failure, index) => <li className="snsgov-settings-row" key={`${failure.scope}:${index}`}>
          <strong>{targets.find(target => target.rootCanisterId === failure.scope || target.governanceCanisterId === failure.scope)?.label || failure.scope}</strong>
          <p className="nt-meta">{failure.message}</p>
          <code className="nt-code snsgov-principal-text">{failure.code} · {failure.scope}</code>
        </li>)}</ul>
      </Disclosure>
    </>}
    {found?.length === 0 && <p className="nt-text">{failures.length > 0
      ? "No neurons found in the available results. Retry the failed communities to finish checking."
      : "No connected neurons found. Add this principal in the wallet that controls your neuron, then check again."}</p>}
    {found && found.length > 0 && <>
      <ul className="snsgov-settings-list" aria-label="Discovered neurons">
        {found.map(entry => {
          const connected = rows?.some(row => row.sns === entry.rootCanisterId && row.votingEnabled);
          const voting = entry.status.found.filter(neuron => !neuron.missing.includes(4)).length;
          const proposing = entry.status.found.filter(neuron => !neuron.missing.includes(3)).length;
          return <li className="snsgov-settings-row" key={entry.rootCanisterId}>
            <strong className="snsgov-settings-name">{entry.label}</strong>
            <p className="nt-meta">{entry.status.found.length} neuron{entry.status.found.length === 1 ? "" : "s"} · {voting} can vote · {proposing} can propose</p>
            {connected ? <span className="nt-meta">Connected</span> : <button className="nt-button" disabled={busy || adding || rows === null}
              onClick={() => void add([entry])} type="button">Connect {entry.label}</button>}
          </li>;
        })}
      </ul>
      {missing.length > 1 && <div className="snsgov-settings-actions"><button className="nt-button" disabled={busy || adding || rows === null} onClick={() => void add(missing)} type="button">
        {adding ? "Connecting…" : `Connect ${missing.length} communities`}
      </button></div>}
    </>}
  </section>;
}

function principalText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof (value as { toText?: () => string }).toText === "function") return (value as { toText: () => string }).toText();
  return String(value);
}
