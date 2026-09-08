/**
 * Every canister the DAO owns, and what it is running on.
 *
 * The five system canisters were all this app used to show, which is a third of
 * the picture: Neutrinite owns eleven dapp canisters and a ledger archive on
 * top of them, and those are the ones that actually run out of cycles.
 *
 * The inventory is a free query and loads with the tab. Cycles are not: the
 * only method that returns them is an update that makes root fan out one
 * management call per canister and pay for each, so it is behind a button and
 * the answer is kept until the tab is left.
 */

import { useCallback, useEffect, useState } from "react";
import { copyToClipboard } from "neutron-tools/app";
import {
  formatTCycles,
  listSnsCanisters,
  readCanistersCycles,
  type CanisterCycles,
  type SnsCanister,
} from "../data/root";
import { formatTimestamp } from "../data/format";
import { IconButton } from "./IconButton";
import { BusyOr, Empty, Pending } from "./Status";
import { CopyIcon, RefreshIcon, WarnIcon } from "./Icons";

const ROLE_LABEL: Record<SnsCanister["role"], string> = {
  root: "Root",
  governance: "Governance",
  ledger: "Ledger",
  index: "Index",
  swap: "Swap",
  dapp: "Dapp",
  archive: "Archive",
};

export function CanistersView({ rootCanisterId }: { rootCanisterId: string }) {
  const [inventory, setInventory] = useState<SnsCanister[] | null>(null);
  const [cycles, setCycles] = useState<Map<string, CanisterCycles> | null>(null);
  const [readAt, setReadAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await listSnsCanisters(rootCanisterId);
        if (!cancelled) setInventory(list);
      } catch (error) {
        if (!cancelled) setMessage(String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rootCanisterId]);

  const loadCycles = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const rows = await readCanistersCycles(rootCanisterId);
      setCycles(new Map(rows.map((row) => [row.canisterId, row])));
      setReadAt(Date.now());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [rootCanisterId]);

  const total = [...(cycles?.values() ?? [])].reduce(
    (sum, row) => sum + (row.cycles ?? 0n),
    0n,
  );
  const unreachable = [...(cycles?.values() ?? [])].filter((row) => row.cycles === undefined);

  return (
    <section className="nt-section">
      <header className="nt-section-header">
        <h2 className="nt-section-heading">Canisters</h2>
        {inventory && <span className="nt-section-count">{inventory.length}</span>}
        <span className="snsgov-spacer" />
        <div className="nt-cluster snsgov-toolbar-actions">
          <IconButton
            disabled={busy || inventory === null}
            label={
              cycles
                ? "Re-read cycles — an update call the DAO pays for"
                : "Read cycles for every canister — an update call the DAO pays for"
            }
            onClick={() => void loadCycles()}
          >
            <BusyOr busy={busy}>
              <RefreshIcon />
            </BusyOr>
          </IconButton>
        </div>
      </header>


      {message && (
        <div className="nt-alert nt-alert--danger" role="alert">
          {message}
        </div>
      )}
      {inventory === null && !message && <Pending label="Reading the canister list" />}
      {inventory?.length === 0 && <Empty label="Root reports no canisters." />}

      {inventory && inventory.length > 0 && (
        <>
          <div className="nt-table-wrap">
            <table className="nt-table snsgov-table snsgov-table--canisters">
              <caption className="nt-sr-only">Canisters owned by this SNS</caption>
              <thead>
                <tr>
                  <th scope="col">Canister</th>
                  <th className="snsgov-nowrap" scope="col">
                    Role
                  </th>
                  <th className="snsgov-num" scope="col">
                    Cycles
                  </th>
                  <th className="snsgov-nowrap" scope="col">
                    Status
                  </th>
                  <th scope="col">
                    <span className="nt-sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {inventory.map((canister) => {
                  const row = cycles?.get(canister.canisterId);
                  return (
                    <tr key={canister.canisterId}>
                      <th scope="row">
                        <code className="nt-code">{canister.canisterId}</code>
                      </th>
                      <td className="snsgov-nowrap" data-label="Role">{ROLE_LABEL[canister.role]}</td>
                      <td className="snsgov-num" data-label="Cycles">
                        {cycles === undefined || cycles === null
                          ? "—"
                          : row?.cycles === undefined
                            ? "unknown"
                            : formatTCycles(row.cycles)}
                      </td>
                      <td className="snsgov-nowrap" data-label="Status">{row?.status ?? "—"}</td>
                      <td className="snsgov-row-actions">
                        <IconButton
                          label={`Copy ${canister.canisterId}`}
                          onClick={() => void copyToClipboard(canister.canisterId)}
                        >
                          <CopyIcon />
                        </IconButton>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {cycles === null ? (
            <p className="nt-meta snsgov-footnote">
              Cycles are not in this list yet. Reading them makes root call the management canister
              once per canister and pay for each, so it happens only when you ask.
            </p>
          ) : (
            <p className="nt-meta snsgov-footnote">
              {formatTCycles(total)} across {cycles.size} canister
              {cycles.size === 1 ? "" : "s"}
              {readAt === null ? "" : `, read ${formatTimestamp(BigInt(Math.floor(readAt / 1000)))}`}
              {unreachable.length > 0 ? ` · ${unreachable.length} unreachable` : ""}
            </p>
          )}

          {unreachable.length > 0 && (
            <div className="nt-alert nt-alert--warning snsgov-alert" role="status">
              <WarnIcon />
              <span>
                Root could not reach {unreachable.length} canister
                {unreachable.length === 1 ? "" : "s"}. That is how a stopped, frozen, or
                cross-subnet canister reports — it is not an error in this app, and the rest of the
                figures are good.
              </span>
            </div>
          )}
        </>
      )}
    </section>
  );
}
