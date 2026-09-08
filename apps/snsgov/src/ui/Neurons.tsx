import { useCallback, useEffect, useRef, useState } from "react";
import { copyToClipboard } from "neutron-tools/app";
import { SnsError } from "../data/errors";
import { formatDuration, formatTimestamp, formatTokenAmount, shortenId } from "../data/format";
import { listNeurons } from "../data/governance";
import type { RegistryEntry } from "../data/registry";
import type { NeuronSummary } from "../data/types";
import { IconButton } from "./IconButton";
import { BusyOr, Empty, Pending } from "./Status";
import { CopyIcon, RefreshIcon, SearchIcon, WarnIcon } from "./Icons";

/** SNS NeuronPermissionType values we care about naming. */
const PERMISSION_NAMES: Record<number, string> = {
  0: "Unspecified",
  1: "ConfigureDissolveState",
  2: "ManagePrincipals",
  3: "SubmitProposal",
  4: "Vote",
  5: "Disburse",
  6: "Split",
  7: "MergeMaturity",
  8: "DisburseMaturity",
  9: "StakeMaturity",
  10: "ManageVotingPermission",
};

type State =
  | { phase: "loading" }
  | { phase: "ready"; neurons: NeuronSummary[]; truncated: boolean }
  | { phase: "error"; message: string };

export function NeuronsView({ entry }: { entry: RegistryEntry }) {
  const [state, setState] = useState<State>({ phase: "loading" });
  // See Proposals: a refresh must not blank the table it is refreshing.
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [appliedFilter, setAppliedFilter] = useState<string | undefined>();
  // A filter can change before the preceding anonymous read returns. Only the
  // latest request may replace the rows or their loading state.
  const request = useRef(0);

  const load = useCallback(
    async (ofPrincipal?: string) => {
      const current = ++request.current;
      setBusy(true);
      setAppliedFilter(ofPrincipal);
      try {
        const result = await listNeurons(entry.canisters.governance, {
          ...(ofPrincipal ? { ofPrincipal } : {}),
          limit: 100,
        });
        if (current !== request.current) return;
        setState({ phase: "ready", neurons: result.neurons, truncated: result.truncated });
      } catch (error) {
        if (current !== request.current) return;
        setState({
          phase: "error",
          message: error instanceof SnsError ? error.message : String(error),
        });
      } finally {
        if (current === request.current) setBusy(false);
      }
    },
    [entry.canisters.governance],
  );

  useEffect(() => {
    void load();
    return () => { request.current += 1; };
  }, [load]);

  return (
    <section className="nt-section">
      <header className="nt-section-header">
        <h2 className="nt-section-heading">Neurons</h2>
        {state.phase === "ready" && <span className="nt-section-count">{state.neurons.length}</span>}
        <span className="snsgov-spacer" />
        <IconButton disabled={busy} label="Refresh neurons" onClick={() => void load(appliedFilter)}>
          <BusyOr busy={busy}>
            <RefreshIcon />
          </BusyOr>
        </IconButton>
      </header>

      <div className="snsgov-filter">
        <label className="nt-sr-only" htmlFor="snsgov-principal-filter">
          Filter by principal
        </label>
        <input
          className="nt-input"
          id="snsgov-principal-filter"
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void load(filter.trim() || undefined);
          }}
          placeholder="Filter by principal (matches any permission holder)"
          value={filter}
        />
        <IconButton
          label="Filter neurons by principal"
          onClick={() => void load(filter.trim() || undefined)}
        >
          <SearchIcon />
        </IconButton>
      </div>

      {state.phase === "loading" && <Pending label="Reading neurons" />}
      {state.phase === "error" && (
        <div className="nt-alert nt-alert--danger" role="alert">
          {state.message}
        </div>
      )}
      {state.phase === "ready" && state.neurons.length === 0 && (
        <Empty
          label={appliedFilter ? "No neuron grants that principal any permission." : "No neurons found."}
        />
      )}
      {state.phase === "ready" && state.neurons.length > 0 && (
        <>
          {state.truncated && (
            <div className="nt-alert nt-alert--warning snsgov-alert" role="status">
              <WarnIcon />
              <span>
                Showing the first 100. When filtering by principal the SNS caps results at 100 and
                ignores pagination, so any further neurons cannot be listed.
              </span>
            </div>
          )}
          <div className="nt-table-wrap">
            <table className="nt-table snsgov-table snsgov-table--neurons">
              <thead>
                <tr>
                  <th scope="col">Neuron</th>
                  <th className="snsgov-num" scope="col">Stake</th>
                  <th className="snsgov-nowrap" scope="col">Dissolve</th>
                  <th scope="col">Principals</th>
                  <th scope="col">
                    <span className="nt-sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {state.neurons.map((neuron) => (
                  <tr key={neuron.id}>
                    <th scope="row">
                      <code className="nt-code">{shortenId(neuron.id, 8, 6)}</code>
                    </th>
                    <td className="snsgov-num" data-label="Stake">
                      {entry.token
                        ? `${formatTokenAmount(neuron.stakeE8s, entry.token.decimals, { maxFractionDigits: 2 })} ${entry.token.symbol}`
                        : `${neuron.stakeE8s} atoms`}
                    </td>
                    <td className="snsgov-nowrap" data-label="Dissolve">
                      {neuron.dissolveState === undefined
                        ? "—"
                        : neuron.dissolveState.kind === "delay"
                          ? formatDuration(neuron.dissolveState.value)
                          : `dissolving → ${formatTimestamp(neuron.dissolveState.value).slice(0, 10)}`}
                    </td>
                    <td data-label="Principals">
                      <ul className="snsgov-principals">
                        {neuron.permissions.map((entryPermission, index) => (
                          <li key={`${neuron.id}-${entryPermission.principal ?? index}`}>
                            <code className="nt-code">
                              {entryPermission.principal
                                ? shortenId(entryPermission.principal, 5, 3)
                                : "—"}
                            </code>{" "}
                            <span
                              className="nt-meta"
                              title={entryPermission.permissions
                                .map((id) => PERMISSION_NAMES[id] ?? id)
                                .join(", ")}
                            >
                              {describePermissions(entryPermission.permissions)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className="snsgov-row-actions">
                      <IconButton
                        label="Copy neuron id"
                        onClick={() => void copyToClipboard(neuron.id)}
                      >
                        <CopyIcon />
                      </IconButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * A short label for a permission set. `[3, 4]` — SubmitProposal and Vote — is
 * the exact grant this app asks for, and is worth calling out by name because
 * it is what a correctly configured hotkey looks like.
 */
function describePermissions(permissions: number[]): string {
  const set = new Set(permissions);
  if (set.size === 2 && set.has(3) && set.has(4)) return "vote + propose";
  if (set.size === 1 && set.has(4)) return "vote";
  if (set.has(2) || set.size >= 10) return "full control";
  return `${permissions.length} permission${permissions.length === 1 ? "" : "s"}`;
}
