import { useRef, useState } from "react";
import type { InstallationQuote, MarketplaceClient } from "../view-types.ts";
import { ErrorNote, Icon, errorMessage, useRead } from "./primitives.tsx";

/** Installation's protocol fee is reviewed on the existing Install control. */
export function InstallControl({ client, appIds, disabled = false, busy = false, label = "Install", onInstall, className = "mp-secondary" }: {
  client: MarketplaceClient;
  appIds: string[];
  disabled?: boolean;
  busy?: boolean;
  label?: string;
  onInstall: (ids: string[], quote: InstallationQuote) => Promise<void> | void;
  className?: string;
}) {
  const [revision, setRevision] = useState(0);
  const [dispatchBusy, setDispatchBusy] = useState(false);
  const [failure, setFailure] = useState<{ key: string; error: string } | null>(null);
  const dispatching = useRef(false);
  const selection = JSON.stringify(appIds);
  const retained = useRef<{ selection: string; operationId?: string }>({ selection });
  if (retained.current.selection !== selection) retained.current = { selection };
  const key = !disabled && appIds.length ? JSON.stringify([selection, revision]) : null;
  const read = useRead(key, async () => {
    const requested = [...appIds];
    const identity = retained.current;
    const operationId = identity.operationId;
    const quote = await client.quoteInstallation(requested, operationId);
    if (JSON.stringify(quote.appIds) !== JSON.stringify(requested)) throw new Error("The installation quote does not match the selected apps.");
    if (operationId && quote.operationId !== operationId) throw new Error("The refreshed quote changed the original installation request.");
    if (BigInt(quote.cycles.total) !== BigInt(quote.fee.totalCycles)) throw new Error("The installation quote has inconsistent cycle costs.");
    if (retained.current === identity) identity.operationId = quote.operationId;
    return quote;
  });
  const dispatchError = failure?.key === key ? failure.error : "";
  const quote = read.error || read.loading || dispatchError ? null : read.data;
  const working = busy || dispatchBusy;
  async function install() {
    if (disabled || working || dispatching.current || !quote || !key) return;
    const identity = retained.current;
    dispatching.current = true; setDispatchBusy(true); setFailure(null);
    try {
      // Keep a prepared installer handoff inside the original click gesture.
      const handoff = onInstall([...quote.appIds], quote);
      await handoff;
      if (!quote.setupUrl && retained.current === identity) setRevision((value) => value + 1);
    }
    catch (cause) { setFailure({ key, error: errorMessage(cause) }); }
    finally { dispatching.current = false; setDispatchBusy(false); }
  }
  return <div className="mp-install-control">
    <div className="mp-button-row">
      {!disabled && appIds.length > 0 && <span className="mp-muted mp-install-cost" aria-live="polite" title="Neutron reviews download access and installation costs next.">{quote ? quote.setupUrl ? "Prepared · No additional preparation charge" : `Prepare · ${BigInt(quote.cycles.total).toLocaleString("en-US")} cycles` : read.error || dispatchError ? "Refresh cost to continue" : "Checking cost…"}</span>}
      {!disabled && appIds.length > 0 && <button type="button" className="mp-text-button" aria-label="Refresh installation cost" title="Refresh cost" disabled={working || read.loading} onClick={() => setRevision((value) => value + 1)}><Icon name="refresh" /></button>}
      <button type="button" className={className} disabled={disabled || working || !quote} onClick={() => void install()}>{working ? "Opening install…" : quote?.setupUrl ? "Open installer" : label}</button>
    </div>
    <ErrorNote error={dispatchError || read.error} retry={!dispatchError && !working ? () => setRevision((value) => value + 1) : undefined} />
  </div>;
}
