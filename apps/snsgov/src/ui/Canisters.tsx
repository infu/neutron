import { useEffect, useRef, useState } from "react";
import { copyToClipboard } from "neutron-tools/app";
import { invoke, operationId } from "../data/actions_client";
import {
  formatTCycles, listSnsCanisters, readCanistersCycles,
  type CanisterCycles, type SnsCanister,
} from "../data/root";
import { formatTimestamp } from "../data/format";
import { Disclosure, ErrorNote, Help, useRead } from "./Common";

const ROLE_LABEL: Record<SnsCanister["role"], string> = {
  root: "Root", governance: "Governance", ledger: "Ledger", index: "Index",
  swap: "Swap", dapp: "Dapp", archive: "Archive",
};

export function CanistersView({ rootCanisterId }: { rootCanisterId: string }) {
  return <CanisterInventory key={rootCanisterId} rootCanisterId={rootCanisterId} />;
}

function CanisterInventory({ rootCanisterId }: { rootCanisterId: string }) {
  const [refresh, setRefresh] = useState(0);
  const inventory = useRead(rootCanisterId, () => listSnsCanisters(rootCanisterId), refresh);
  const [cycles, setCycles] = useState<Map<string, CanisterCycles> | null>(null);
  const [readAt, setReadAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const mounted = useRef(true);
  const running = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const loadCycles = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const next = await readCanistersCycles(rootCanisterId);
      if (!mounted.current) return;
      setCycles(new Map(next.map((row) => [row.canisterId, row])));
      setReadAt(Date.now());
    } catch (error) {
      if (mounted.current) setMessage(String(error));
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const copy = async (principal: string) => {
    try {
      await copyToClipboard(principal);
      if (mounted.current) setCopied(principal);
    } catch (error) {
      if (mounted.current) setMessage(`Could not copy the canister ID: ${String(error)}`);
    }
  };

  const known = [...(cycles?.values() ?? [])].filter((row) => row.cycles !== undefined);
  const total = known.reduce((sum, row) => sum + row.cycles!, 0n);
  const unavailable = cycles === null ? [] : (inventory.data ?? []).filter(
    (canister) => cycles.get(canister.canisterId)?.cycles === undefined,
  );

  return <section className="nt-section snsgov-canisters">
    <header className="nt-section-header snsgov-settings-heading">
      <h2 className="nt-section-heading">Canisters</h2>
      {inventory.data && <span className="nt-section-count">{inventory.data.length}</span>}
      <button className="nt-button nt-button--ghost" disabled={inventory.loading} onClick={() => setRefresh(value => value + 1)} type="button">
        {inventory.loading ? "Reading list…" : "Refresh list"}
      </button>
    </header>
    <p className="nt-text">The software canisters that run this community.</p>
    <ErrorNote message={inventory.error} />
    {inventory.data === null && inventory.loading && <p className="nt-meta" role="status">Reading the canister list…</p>}
    {inventory.data?.length === 0 && <p className="nt-text">This community reports no canisters.</p>}
    {inventory.data !== null && inventory.data.length > 0 && <>
      <div className="snsgov-settings-actions">
        <button className="nt-button" disabled={busy} onClick={() => void loadCycles()} type="button">
          {busy ? "Reading cycles…" : cycles === null ? "Read cycles" : "Refresh cycles"}
        </button>
        <Help label="cycles reads">Cycles pay for canister computation and storage. Reading these balances asks the root canister
          to check each canister through the management canister. The community pays cycles for those calls.</Help>
      </div>
      <p className="nt-meta">Each cycles read makes calls paid for by the community.</p>
      <ErrorNote message={message} />
      {cycles !== null && <p className="nt-meta" role="status">
        {formatTCycles(total)} across {known.length} canister{known.length === 1 ? "" : "s"} with a known balance
        {readAt === null ? "" : ` · Read ${formatTimestamp(BigInt(Math.floor(readAt / 1000)))}`}
      </p>}
      {unavailable.length > 0 && <p className="nt-alert nt-alert--warning" role="status">
        Balances are unavailable for {unavailable.length} canister{unavailable.length === 1 ? "" : "s"}.
        The total includes only known balances.
      </p>}
      <ul className="snsgov-settings-list" aria-label="Community canisters">
        {inventory.data.map((canister) => {
          const row = cycles?.get(canister.canisterId);
          return <li className="snsgov-settings-row" key={canister.canisterId}>
            <div className="snsgov-settings-row-head">
              <strong>{ROLE_LABEL[canister.role]}</strong>
              {cycles !== null && <span className="nt-meta">
                {row?.cycles === undefined ? "Balance unavailable" : `${formatTCycles(row.cycles)} cycles`}
                {row?.status ? ` · ${row.status}` : ""}
              </span>}
            </div>
            <div className="snsgov-principal-row">
              <code className="nt-code snsgov-principal-text">{canister.canisterId}</code>
              <button aria-label={`Copy ${canister.canisterId}`} className="nt-button nt-button--ghost" onClick={() => void copy(canister.canisterId)} type="button">
                {copied === canister.canisterId ? "Copied" : "Copy"}
              </button>
            </div>
            {row && (row.cycles !== undefined || row.memorySize !== undefined || row.idleBurnPerDay !== undefined) && <Disclosure title="Resource details">
              <dl className="snsgov-settings-values">
                {row.cycles !== undefined && <><dt>Exact cycles</dt><dd>{row.cycles.toString()}</dd></>}
                {row.memorySize !== undefined && <><dt>Memory</dt><dd>{row.memorySize.toString()} bytes</dd></>}
                {row.idleBurnPerDay !== undefined && <><dt>Idle cycles per day</dt><dd>{formatTCycles(row.idleBurnPerDay)}</dd></>}
              </dl>
            </Disclosure>}
          </li>;
        })}
      </ul>
      {unavailable.length > 0 && <Disclosure title="Why a balance may be unavailable">
        <p className="nt-text">Root may be unable to reach a stopped, frozen, or cross-subnet canister.
          Registered extensions can also appear in the inventory without a balance in the root summary.
          An unavailable balance is not a zero balance.</p>
      </Disclosure>}
    </>}
    <GovernanceMaintenance rootCanisterId={rootCanisterId} />
  </section>;
}

const MAINTENANCE_ACTIONS = [
  { method: "fail_stuck_upgrade_in_progress", label: "Check stuck upgrade", description: "Ask governance to mark an upgrade as failed if the SNS considers it stuck and its deadline has passed." },
  { method: "reset_timers", label: "Restart governance timers", description: "Restart the SNS governance background timers. Governance enforces its own waiting period between restarts." },
  { method: "get_maturity_modulation", label: "Refresh maturity modulation", description: "Run the governance update that refreshes the maturity adjustment used when maturity is converted to tokens." },
] as const;

interface MaintenanceResult { operationId?: string; status?: string; message?: string; outcomes?: unknown }
function GovernanceMaintenance({ rootCanisterId }: { rootCanisterId: string }) {
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<{ id: string; label: string; result?: MaintenanceResult; error?: string } | null>(null);
  const running = useRef(false);
  const start = async (item: typeof MAINTENANCE_ACTIONS[number]) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    const id = operationId();
    setAction({ id, label: item.label });
    try {
      const result = await invoke<MaintenanceResult>("sns_governance_recovery_v1", { operationId: id, rootCanisterId, method: item.method });
      setAction({ id, label: item.label, result });
    } catch (error) { setAction({ id, label: item.label, error: String(error) }); }
    finally { running.current = false; setBusy(false); }
  };
  const check = async () => {
    if (!action || running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const result = await invoke<MaintenanceResult>("sns_operation_status_v1", { operationId: action.id });
      setAction({ id: action.id, label: action.label, result });
    } catch (error) { setAction({ ...action, error: String(error) }); }
    finally { running.current = false; setBusy(false); }
  };
  const unresolved = action !== null && action.result?.status !== "completed" && action.result?.status !== "rejected";
  return <Disclosure title="Governance maintenance">
    <p className="nt-text">These actions can change governance maintenance state. Review the requested action before it is sent.</p>
    <ul className="snsgov-settings-list">{MAINTENANCE_ACTIONS.map(item => <li className="snsgov-settings-row" key={item.method}>
      <p className="nt-text">{item.description}</p>
      <button className="nt-button" disabled={busy || unresolved} onClick={() => void start(item)} type="button">{item.label}</button>
    </li>)}</ul>
    {action && <div className="snsgov-permission-outcome">
      <p role="status">{action.label}: {action.result?.status === "completed" ? "completed" : action.result?.status === "rejected" ? "rejected" : "outcome not confirmed"}.</p>
      {action.result?.status === "completed" && <p className="nt-meta">Governance returned a successful reply. A stuck-upgrade check does not confirm that the upgrade itself completed.</p>}
      <ErrorNote message={action.error || action.result?.message || null} />
      <button className="nt-button nt-button--ghost" disabled={busy} onClick={() => void check()} type="button">Check saved status</button>
      <Disclosure title="Maintenance result details">
        <p className="nt-meta">Operation <code className="nt-code snsgov-principal-text">{action.id}</code></p>
        {action.result && <pre className="nt-pre nt-pre--wrap">{JSON.stringify(action.result.outcomes ?? action.result, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2)}</pre>}
        <p className="nt-meta">Activity keeps the saved result and any next steps for this action.</p>
      </Disclosure>
    </div>}
  </Disclosure>;
}
