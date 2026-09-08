/**
 * Setup: the voting principal, and the allowlist it acts through.
 *
 * The previous version asked the owner to pick SNSes one at a time out of a
 * dropdown of all fifty-four, which meant remembering which DAOs they hold
 * neurons in. The governance canisters already know that, so the primary action
 * here is a scan: ask every live SNS which of its neurons name our principal,
 * then admit them all at once.
 */

import { useCallback, useEffect, useState } from "react";
import { copyToClipboard, querySelf, updateSelf } from "neutron-tools/app";
import { REQUIRED_PERMISSIONS } from "../data/manage_neuron";
import { displayName, getRegistry } from "../data/registry";
import { readHotkey, type HotkeyStatus } from "../data/relay";
import { scanForNeurons, type DiscoveredSns } from "../data/registration";
import { IconButton } from "./IconButton";
import { BusyOr, Empty, Pending } from "./Status";
import { BackIcon, CopyIcon, NeuronIcon, RefreshIcon, TrashIcon, WarnIcon } from "./Icons";

interface AllowlistRow {
  sns: string;
  governance: string;
  votingEnabled: boolean;
  agentVotingEnabled: boolean;
  label: string;
}

export function SetupView({ onBack }: { onBack: () => void }) {
  const [hotkey, setHotkey] = useState<HotkeyStatus | null>(null);
  const [rows, setRows] = useState<AllowlistRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const [key, raw] = await Promise.all([
        readHotkey(),
        querySelf("snsgov_config", [null]) as Promise<unknown>,
      ]);
      setHotkey(key);
      const parsed = raw as { snses: Record<string, unknown>[] };
      setRows(
        parsed.snses.map((row) => ({
          sns: text(row.sns),
          governance: text(row.governance),
          votingEnabled: Boolean(row.voting_enabled),
          agentVotingEnabled: Boolean(row.agent_voting_enabled),
          label: String(row.label_text ?? ""),
        })),
      );
      return true;
    } catch (error) {
      setMessage(String(error));
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const upsert = useCallback(
    async (row: AllowlistRow) => {
      setBusy(true);
      setMessage(null);
      try {
        // A refusal arrives as a thrown value: the Kernel projects the
        // backend's `{#ok; #err}` by returning ok and throwing err, so there is
        // no `{ err }` envelope to test.
        await updateSelf("snsgov_sns_upsert", [
          {
            sns: row.sns,
            governance: row.governance,
            voting_enabled: row.votingEnabled,
            agent_voting_enabled: row.agentVotingEnabled,
            label_text: row.label.slice(0, 64),
          },
        ]);
        return await load();
      } catch (error) {
        setMessage(String(error));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const remove = useCallback(
    async (sns: string) => {
      setBusy(true);
      setMessage(null);
      try {
        // `snsgov_sns_remove` takes the root principal itself, not a record.
        await updateSelf("snsgov_sns_remove", [sns]);
        await load();
      } catch (error) {
        setMessage(String(error));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  return (
    <div className="nt-page">
      <header className="nt-page-header snsgov-toolbar">
        <div className="nt-cluster">
          <IconButton label="Back to the SNS list" onClick={onBack}>
            <BackIcon />
          </IconButton>
          <h1 className="nt-title snsgov-detail-title">Setup</h1>
        </div>
        <div className="nt-cluster snsgov-toolbar-actions">
          <IconButton disabled={busy || loading} label="Refresh setup" onClick={() => void load()}>
            <RefreshIcon />
          </IconButton>
        </div>
      </header>

      <section className="nt-page-main">
        {message && (
          <div className="nt-alert nt-alert--danger" role="alert">
            {message}
          </div>
        )}

        <PrincipalSection hotkey={hotkey} loading={loading} />
        <NeuronScan busy={busy || loading} hotkey={hotkey} onAdd={upsert} rows={rows} />
        <Allowlist
          busy={busy || loading}
          loading={loading}
          onRemove={remove}
          onUpsert={upsert}
          rows={rows}
        />
      </section>
    </div>
  );
}

/** The principal to register, and whether the backend may sign yet. */
function PrincipalSection({ hotkey, loading }: { hotkey: HotkeyStatus | null; loading: boolean }) {
  if (hotkey === null) {
    return (
      <section className="nt-section">
        <header className="nt-section-header">
          <h2 className="nt-section-heading">Your voting principal</h2>
        </header>
        {loading ? (
          <Pending label="Reading your voting principal" />
        ) : (
          <Empty label="Voting principal unavailable. Refresh to try again." />
        )}
      </section>
    );
  }

  return (
    <section className="nt-section">
      <header className="nt-section-header">
        <h2 className="nt-section-heading">Your voting principal</h2>
      </header>
      <div className="nt-copy-field snsgov-copyfield">
        <input
          aria-label="Your voting principal"
          className="nt-input"
          readOnly
          value={hotkey.principal}
        />
        <IconButton
          label="Copy your voting principal"
          onClick={() => void copyToClipboard(hotkey.principal)}
        >
          <CopyIcon />
        </IconButton>
      </div>
      <p className="nt-text snsgov-description">
        Add this as a hotkey on your SNS neurons, in whichever wallet controls them. It grants only{" "}
        <code className="nt-code">Vote</code> and <code className="nt-code">SubmitProposal</code>{" "}
        (permissions {REQUIRED_PERMISSIONS.join(" and ")}) — neither can move, dissolve, or disburse
        anything. It is this Neutron&rsquo;s own canister, so voting keeps working with no browser
        open.
      </p>
      {!hotkey.canManageNeuron && (
        <div className="nt-alert nt-alert--warning snsgov-alert" role="status">
          <WarnIcon />
          <span>
            The backend cannot sign yet. This app requests a single{" "}
            <code className="nt-code">manage_neuron</code> reservation at install time — install an
            app update to grant that. One grant then covers every SNS, including ones launched
            later.
          </span>
        </div>
      )}
    </section>
  );
}

/**
 * Ask every live SNS which of its neurons already name our principal.
 *
 * Not automatic on mount: it is one query per SNS, and the owner should choose
 * when to spend them.
 */
function NeuronScan({
  hotkey,
  rows,
  onAdd,
  busy,
}: {
  hotkey: HotkeyStatus | null;
  rows: AllowlistRow[] | null;
  onAdd: (row: AllowlistRow) => Promise<boolean>;
  busy: boolean;
}) {
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<DiscoveredSns[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const scan = useCallback(async () => {
    if (!hotkey) return;
    setScanning(true);
    setError(null);
    try {
      const registry = await getRegistry();
      const live = registry.entries
        .filter((entry) => entry.liveness.governance)
        .map((entry) => ({
          rootCanisterId: entry.canisters.root,
          governanceCanisterId: entry.canisters.governance,
          label: displayName(entry),
        }));
      setFound(await scanForNeurons(live, hotkey.principal));
    } catch (caught) {
      setError(String(caught));
    } finally {
      setScanning(false);
    }
  }, [hotkey]);

  const missing = (found ?? []).filter(
    (entry) => !rows?.some((row) => row.sns === entry.rootCanisterId && row.votingEnabled),
  );

  const addAll = useCallback(async () => {
    setAdding(true);
    try {
      for (const entry of missing) {
        const existing = rows?.find((row) => row.sns === entry.rootCanisterId);
        const added = await onAdd({
          sns: entry.rootCanisterId,
          governance: entry.governanceCanisterId,
          votingEnabled: true,
          agentVotingEnabled: existing?.agentVotingEnabled ?? false,
          label: existing?.label || entry.label,
        });
        // Keep a refusal visible and leave the remaining SNSes for a new click.
        if (!added) break;
      }
    } finally {
      setAdding(false);
    }
  }, [missing, onAdd, rows]);

  return (
    <section className="nt-section">
      <header className="nt-section-header">
        <h2 className="nt-section-heading">Find your neurons</h2>
        <div className="nt-cluster snsgov-toolbar-actions">
          <IconButton
            disabled={scanning || adding || busy || hotkey === null}
            label="Scan every SNS for neurons that name your principal"
            onClick={() => void scan()}
          >
            <BusyOr busy={scanning}>
              <NeuronIcon />
            </BusyOr>
          </IconButton>
        </div>
      </header>

      {error && (
        <div className="nt-alert nt-alert--danger" role="alert">
          {error}
        </div>
      )}
      {scanning && <Pending label="Asking every SNS" />}
      {!scanning && found === null && !error && (
        <p className="nt-text snsgov-description">
          Rather than picking DAOs off a list, ask them. This checks every live SNS for neurons that
          already name your principal, and admits them in one step.
        </p>
      )}
      {!scanning && found !== null && found.length === 0 && (
        <Empty label="No SNS names your principal yet. Add it as a hotkey on a neuron first." />
      )}
      {!scanning && found !== null && found.length > 0 && (
        <>
          <div className="nt-table-wrap">
            <table className="nt-table snsgov-table snsgov-table--scan">
              <thead>
                <tr>
                  <th scope="col">SNS</th>
                  <th className="snsgov-num" scope="col">
                    Neurons
                  </th>
                  <th className="snsgov-num" scope="col">
                    Ready
                  </th>
                  <th className="snsgov-nowrap" scope="col">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {found.map((entry) => {
                  const admitted = rows?.some(
                    (row) => row.sns === entry.rootCanisterId && row.votingEnabled,
                  );
                  return (
                    <tr key={entry.rootCanisterId}>
                      <th scope="row">{entry.label}</th>
                      <td className="snsgov-num">{entry.status.found.length}</td>
                      <td className="snsgov-num">{entry.status.ready}</td>
                      <td className="snsgov-nowrap">
                        {admitted ? "voting enabled" : "not yet allowed"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="snsgov-filter">
            <button
              className="nt-button"
              disabled={busy || adding || rows === null || missing.length === 0}
              onClick={() => void addAll()}
              type="button"
            >
              {missing.length === 0
                ? "All allowed"
                : `Allow voting for ${missing.length} SNS${missing.length === 1 ? "" : "es"}`}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function Allowlist({
  rows,
  onUpsert,
  onRemove,
  busy,
  loading,
}: {
  rows: AllowlistRow[] | null;
  onUpsert: (row: AllowlistRow) => Promise<boolean>;
  onRemove: (sns: string) => Promise<void>;
  busy: boolean;
  loading: boolean;
}) {
  return (
    <section className="nt-section">
      <header className="nt-section-header">
        <h2 className="nt-section-heading">Allowlisted SNSes</h2>
        {rows && <span className="nt-section-count">{rows.length}</span>}
      </header>
      <p className="nt-text snsgov-description">
        This app will only ever sign for an SNS on this list, and only for{" "}
        <code className="nt-code">manage_neuron</code>. Agent voting stays off until you turn it on
        per SNS.
      </p>
      {rows === null && (loading ? (
        <Pending label="Reading the allowlist" />
      ) : (
        <Empty label="Allowlist unavailable. Refresh to try again." />
      ))}
      {rows !== null && rows.length === 0 && (
        <Empty label="Nothing admitted yet. Scan above, or use the neuron button on any SNS page." />
      )}
      {rows !== null && rows.length > 0 && (
        <div className="nt-table-wrap">
          <table className="nt-table snsgov-table snsgov-table--allowlist">
            <thead>
              <tr>
                <th scope="col">SNS</th>
                <th scope="col">Voting</th>
                <th scope="col">Agent voting</th>
                <th scope="col">
                  <span className="nt-sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.sns}>
                  <th scope="row">{row.label || row.sns}</th>
                  <td>
                    <Toggle
                      checked={row.votingEnabled}
                      disabled={busy}
                      label={`Allow voting for ${row.label || row.sns}`}
                      onChange={(value) => void onUpsert({ ...row, votingEnabled: value })}
                    />
                  </td>
                  <td>
                    <Toggle
                      checked={row.agentVotingEnabled}
                      disabled={busy || !row.votingEnabled}
                      label={`Allow agent voting for ${row.label || row.sns}`}
                      onChange={(value) => void onUpsert({ ...row, agentVotingEnabled: value })}
                    />
                  </td>
                  <td className="snsgov-row-actions">
                    <IconButton
                      disabled={busy}
                      label={`Remove ${row.label || row.sns} from the allowlist`}
                      onClick={() => void onRemove(row.sns)}
                    >
                      <TrashIcon />
                    </IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className="nt-checkbox snsgov-toggle">
      <input
        aria-label={label}
        checked={checked}
        disabled={disabled ?? false}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <span className="nt-sr-only">{label}</span>
    </label>
  );
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof (value as { toText?: () => string }).toText === "function") {
    return (value as { toText: () => string }).toText();
  }
  return String(value);
}
