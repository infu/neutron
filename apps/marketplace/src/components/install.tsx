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
    if (BigInt(quote.cycles.total) !== BigInt(quote.fee.totalCycles) + BigInt(quote.sourceAccess?.cycles ?? "0")) throw new Error("The installation quote has inconsistent cycle costs.");
    if (retained.current === identity) identity.operationId = quote.operationId;
    return quote;
  });
  const dispatchError = failure?.key === key ? failure.error : "";
  const quote = read.error || read.loading || dispatchError ? null : read.data;
  const working = busy || dispatchBusy;
  const hasPreparedSelection = !!read.data?.setupUrl;
  const unavailableReason = read.data?.unavailableReason;
  const canPrepareLatest = hasPreparedSelection || !!unavailableReason;
  function prepareLatest() {
    if (disabled || working || read.loading || !canPrepareLatest) return;
    // A fresh request is created only by this explicit action. Refresh and
    // interrupted-request recovery continue to retain their original IDs.
    retained.current = { selection, operationId: crypto.randomUUID().replaceAll("-", "") };
    setFailure(null);
    setRevision((value) => value + 1);
  }
  async function install() {
    if (disabled || working || dispatching.current || !quote || !key) return;
    const identity = retained.current;
    dispatching.current = true; setDispatchBusy(true); setFailure(null);
    try {
      await onInstall([...quote.appIds], quote);
      if (!quote.setupUrl && retained.current === identity) setRevision((value) => value + 1);
    }
    catch (cause) { setFailure({ key, error: errorMessage(cause) }); }
    finally { dispatching.current = false; setDispatchBusy(false); }
  }
  return <div className="mp-install-control">
    <div className="mp-button-row">
      {!disabled && appIds.length > 0 && <span className="mp-muted mp-install-cost" aria-live="polite" title="Includes selection preparation and private download access. Neutron reviews app permissions and installation costs next.">{quote ? quote.unavailableReason ? "Selection no longer available" : BigInt(quote.cycles.total) === 0n ? "Ready · No additional access charge" : `${BigInt(quote.cycles.total).toLocaleString("en-US")} cycles` : read.error || dispatchError ? "Refresh cost to continue" : "Checking cost…"}</span>}
      {!disabled && appIds.length > 0 && <button type="button" className="mp-text-button" aria-label="Refresh installation cost" title="Refresh cost" disabled={working || read.loading} onClick={() => setRevision((value) => value + 1)}><Icon name="refresh" /></button>}
      <button type="button" className={className} disabled={disabled || working || !quote || !!unavailableReason} onClick={() => void install()}>{working ? "Opening install…" : label}</button>
    </div>
    {!disabled && canPrepareLatest && <button type="button" className="mp-text-button" disabled={working || read.loading} onClick={prepareLatest} title="Review a new preparation request for the latest approved releases. Your previous request remains in saved history.">Prepare latest selection</button>}
    <ErrorNote error={dispatchError || read.error || unavailableReason || null} retry={!dispatchError && !unavailableReason && !working ? () => setRevision((value) => value + 1) : undefined} />
  </div>;
}
