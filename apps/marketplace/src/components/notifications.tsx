import { useRef, useState } from "react";
import type { OperationResult } from "../view-types.ts";
import { canDismissNotification, canRecoverEthereumPayment, notificationTitle, visibleNotifications } from "../notification-state.ts";
import { ErrorNote, Icon, Loading, errorMessage } from "./primitives.tsx";

type ActionResult = Promise<unknown>;
export type NotificationsPanelProps = {
  /** Latest observation for an operation precedes any saved copy. */
  operations: readonly OperationResult[];
  loading?: boolean;
  error?: string;
  onRefresh: () => void;
  onCheck: (operation: OperationResult) => ActionResult;
  onResume: (operation: OperationResult) => ActionResult;
  onVerify: (operation: OperationResult, transactionHash: string) => ActionResult;
  onCancel: (operation: OperationResult) => ActionResult;
  onDismiss: (operation: OperationResult) => void;
};

export function NotificationBell() {
  return <svg className="mp-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>;
}

export function NotificationsPanel(props: NotificationsPanelProps) {
  const operations = visibleNotifications(props.operations);
  return <section className="mp-activity" aria-label="Activity">
    <div className="mp-section-title"><div><h2>Activity</h2><p>Your purchases and wallet updates.</p></div><button type="button" className="mp-icon-button" aria-label="Refresh activity" title="Refresh activity" onClick={props.onRefresh}><Icon name="refresh" /></button></div>
    <ErrorNote error={props.error ?? ""} retry={props.onRefresh} />
    {props.loading && operations.length === 0 ? <Loading label="Loading activity…" /> : operations.length === 0 && !props.error ? <div className="mp-activity-empty"><span><NotificationBell /></span><h3>You're all caught up</h3><p>Purchases and wallet progress will appear here.</p></div> : <div className="mp-activity-list">{operations.map(operation => <NotificationCard key={operation.operationId} operation={operation} onCheck={props.onCheck} onResume={props.onResume} onVerify={props.onVerify} onCancel={props.onCancel} onDismiss={props.onDismiss} />)}</div>}
  </section>;
}

function NotificationCard({ operation, onCheck, onResume, onVerify, onCancel, onDismiss }: Pick<NotificationsPanelProps, "onCheck" | "onResume" | "onVerify" | "onCancel" | "onDismiss"> & { operation: OperationResult }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [hash, setHash] = useState("");
  const pending = useRef(false);
  async function run(action: () => ActionResult) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await action(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { pending.current = false; setBusy(false); }
  }
  const complete = operation.state === "complete", recover = canRecoverEthereumPayment(operation);
  const settlement = operation.settlement;
  const showStatusCheck = !complete || settlement?.state === "pending" || settlement?.state === "failed";
  const canResume = !operation.entitled && (operation.nextAction === "resume" || operation.nextAction === "review");
  return <article className={`mp-activity-card${complete ? " is-complete" : ""}`} aria-label={`${notificationTitle(operation)}${operation.appIds?.length ? `: ${operation.appIds.join(", ")}` : ""}`}>
    <div className="mp-activity-card-heading"><span className="mp-activity-state-icon">{complete ? <Icon name="check" /> : <NotificationBell />}</span><div><h3>{notificationTitle(operation)}</h3>{operation.appIds?.length ? <p className="mp-activity-apps">{operation.appIds.map(id => id.replaceAll("_", " ")).join(" · ")}</p> : null}</div>{canDismissNotification(operation) && <button type="button" className="mp-icon-button" style={{ marginLeft: "auto" }} aria-label="Dismiss notification" title="Dismiss notification" disabled={busy} onClick={() => onDismiss(operation)}><Icon name="close" /></button>}</div>
    <p className="mp-activity-message">{operation.message}</p>
    {settlement && <p className={`mp-activity-settlement${settlement.state === "failed" ? " is-failed" : ""}`}>{settlement.message}</p>}
    {error && <ErrorNote error={error} />}
    {showStatusCheck && <div className="mp-activity-actions"><button type="button" className="mp-secondary" disabled={busy} onClick={() => void run(() => onCheck(operation))}>{busy ? "Working…" : "Check status"}</button>{canResume && <button type="button" className="mp-primary" disabled={busy} onClick={() => void run(() => onResume(operation))}>{operation.ethereumWallet === "browser" ? "Connect wallet & continue" : operation.nextAction === "review" ? "Review" : "Continue"}</button>}</div>}
    <details className="mp-activity-details"><summary>Details</summary><dl><div><dt>Saved request</dt><dd><code>{operation.operationId}</code></dd></div>{operation.ethereumTransactionHash && <div><dt>Ethereum transaction</dt><dd><code>{operation.ethereumTransactionHash}</code></dd></div>}{operation.ledgerBlock && <div><dt>Ledger block</dt><dd>{operation.ledgerBlock}</dd></div>}</dl>
      {recover && <div className="mp-activity-recovery"><label>Original Ethereum payment hash<input value={hash} onChange={event => setHash(event.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" disabled={busy} /></label><p>If your wallet sent the payment but its reply was lost, verify that original transaction here. This does not send another payment.</p><button type="button" className="mp-secondary" disabled={busy || !/^0x[0-9a-fA-F]{64}$/.test(hash.trim())} onClick={() => void run(() => onVerify(operation, hash.trim()))}>Review & verify original payment</button><button type="button" className="mp-text-button" disabled={busy} onClick={() => void run(() => onCancel(operation))}>Cancel checkout</button></div>}
    </details>
  </article>;
}
