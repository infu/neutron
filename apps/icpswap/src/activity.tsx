import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { callTool, isJsonObject, onAppStateChange, type JsonObject, type JsonValue } from "neutron-tools/app";
import { continueAction, parseActionProgress, type ActionProgress } from "./action_client.ts";
import { formatDateTime, shortPrincipal } from "./format.ts";
import { createRequestId } from "./funding.ts";
import { parseActionOperation, type ActionOperation } from "./action_backend.ts";
import { eligibleDirectDepositRecoveries, type EligibleDirectDepositRecovery } from "./recovery_workflow.ts";

export type SavedAction = JsonObject & {
  id: string; input_json: string; state: string; detail: string;
  created_at: string; updated_at: string;
};
export type ActionPage = { items: SavedAction[]; nextCursor: string | null };
export async function loadActionHistory(cursor?: string, signal?: AbortSignal): Promise<ActionPage> {
  const value = await callTool<JsonValue>({ target: "app:icpswap:background", name: "icpswap_history_v1", arguments: { limit: 50, ...(cursor ? { cursor } : {}) } }, signal ? { signal } : undefined);
  if (!isJsonObject(value) || !Array.isArray(value.items)) throw new Error("Saved activity is unavailable.");
  const items = value.items.map((item) => {
    if (!isJsonObject(item) || typeof item.id !== "string" || typeof item.input_json !== "string" || typeof item.state !== "string" || typeof item.detail !== "string" || typeof item.created_at !== "string" || typeof item.updated_at !== "string") throw new Error("A saved activity record is unreadable.");
    return item as SavedAction;
  });
  if (value.nextCursor !== undefined && value.nextCursor !== null && typeof value.nextCursor !== "string") throw new Error("Activity returned an unreadable page cursor.");
  return { items, nextCursor: typeof value.nextCursor === "string" ? value.nextCursor : null };
}
export function newestSavedAction(current: SavedAction | undefined, incoming: SavedAction): SavedAction {
  if (!current || current.id !== incoming.id) return incoming;
  if (typeof current.revision === "string" && typeof incoming.revision === "string") {
    return BigInt(current.revision) > BigInt(incoming.revision) ? current : incoming;
  }
  return BigInt(current.updated_at) > BigInt(incoming.updated_at) ? current : incoming;
}
export function savedActionInput(action: Pick<SavedAction, "input_json">): JsonObject | null {
  try {
    const value: JsonValue = JSON.parse(action.input_json);
    if (!isJsonObject(value)) return null;
    return value.version === 1 && isJsonObject(value.input) ? value.input : value;
  } catch { return null; }
}
export function retainedPool(action: Pick<SavedAction, "input_json">): string | null {
  const input = savedActionInput(action);
  return typeof input?.pool === "string" ? input.pool : null;
}
export function canContinueSavedAction(action: Pick<SavedAction, "input_json" | "state">): boolean {
  if (!["prepared", "funding_requested", "funding_required", "funded"].includes(action.state)) return false;
  try {
    const value: JsonValue = JSON.parse(action.input_json);
    return isJsonObject(value) && value.version === 1 && isJsonObject(value.owner) && value.owner.appId === "icpswap" && value.owner.rootMode === false;
  } catch { return false; }
}
const actionLabels: Record<string, string> = { mint: "New liquidity position", increase: "Add liquidity", decrease: "Remove liquidity", close: "Close liquidity position", claim: "Collect fees", withdraw: "Withdraw unused funds", swap: "Swap", recover_deposit: "Recover funded deposit" };
const stateLabels: Record<string, string> = { prepared: "Ready to review", funding_requested: "Funding", funding_required: "Funding", funded: "Funded", execution_requested: "In progress", complete: "Completed", completed: "Completed", stopped: "Stopped", uncertain: "Needs reconciliation", ambiguous: "Needs reconciliation", pending: "In progress" };
export function actionTitle(action: Pick<SavedAction, "input_json">): string {
  const input = savedActionInput(action);
  const kind = typeof input?.kind === "string" ? input.kind : input?.from_ledger_id ? "swap" : input?.sourceOperationId ? "recover_deposit" : "";
  return actionLabels[kind] ?? "ICPSwap action";
}
function displayTime(value: string): string {
  const ns = Number(value);
  return Number.isFinite(ns) && ns > 0 ? formatDateTime(ns) : "";
}

export function ActionCard({ action, progress, onChange, onNewAction }: { action: SavedAction; progress?: Pick<ActionProgress, "state" | "message">; onChange?: (next: SavedAction) => void; onNewAction?: (next: SavedAction) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [poolObservation, setPoolObservation] = useState<JsonObject | null>(null);
  const [preparedEvidence, setPreparedEvidence] = useState<{ operation: ActionOperation; plan: JsonObject } | null>(null);
  const [recoveryMessage, setRecoveryMessage] = useState("");
  const [observedProgress, setObservedProgress] = useState<{ revision: string; state: string; message: string } | null>(null);
  const recoveryRequests = useRef(new Map<number, JsonObject>());
  const recoverable = useMemo(() => preparedEvidence ? eligibleDirectDepositRecoveries(preparedEvidence.operation, preparedEvidence.plan) : [], [preparedEvidence]);
  const latest = observedProgress && typeof action.revision === "string" && BigInt(observedProgress.revision) >= BigInt(action.revision) ? observedProgress : progress;
  const visibleState = latest?.state ?? action.state;
  const canContinue = !["funding_expired", "funding_rejected", "rejected"].includes(visibleState) && canContinueSavedAction(action);
  const check = useCallback(async (resume: boolean) => {
    setBusy(true); setError("");
    try {
      const progress: ActionProgress = resume ? await continueAction(action.id) : parseActionProgress(await callTool<JsonValue>({ target: "app:icpswap:background", name: "icpswap_reconcile_v1", arguments: { operationId: action.id } }, 300), action.id);
      const updated = progress.raw.operation;
      if (isJsonObject(updated) && typeof updated.revision === "string") setObservedProgress({ revision: updated.revision, state: progress.state, message: progress.message });
      if (isJsonObject(progress.raw.pool)) setPoolObservation(progress.raw.pool);
      if (isJsonObject(updated) && isJsonObject(progress.raw.plan)) setPreparedEvidence({ operation: parseActionOperation(updated), plan: progress.raw.plan });
      if (isJsonObject(updated) && updated.id === action.id) onChange?.(updated as SavedAction);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }, [action.id, onChange]);
  const recover = async (candidate: EligibleDirectDepositRecovery) => {
    const request = recoveryRequests.current.get(candidate.tokenIndex) ?? { operationId: createRequestId(), sourceOperationId: action.id, tokenIndex: candidate.tokenIndex };
    recoveryRequests.current.set(candidate.tokenIndex, request);
    setBusy(true); setError(""); setRecoveryMessage("");
    try {
      const progress = parseActionProgress(await callTool<JsonValue>({ target: "app:icpswap:background", name: "icpswap_recover_deposit_v1", arguments: request }, 300), String(request.operationId));
      setRecoveryMessage(`${progress.message} · Recovery ${progress.operationId}`);
      if (isJsonObject(progress.raw.operation)) onNewAction?.(progress.raw.operation as SavedAction);
      await check(false);
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : String(cause)} Recovery ${String(request.operationId)} remains the same request; use it again or inspect Activity.`);
    } finally { setBusy(false); }
  };
  const input = savedActionInput(action);
  const pool = retainedPool(action);
  return <article className="ics-action-card">
    <header><strong>{actionTitle(action)}</strong><span className={`ics-action-state ics-action-state--${visibleState}`}>{stateLabels[visibleState] ?? visibleState.replaceAll("_", " ")}</span></header>
    <p role="status">{latest?.message ?? action.detail}</p>
    {!canContinueSavedAction(action) && ["prepared", "funding_requested", "funding_required", "funded"].includes(action.state) ? <p className="nt-meta">Continue in the Agent or app that started this action.</p> : null}
    <div className="ics-action-meta"><time>{displayTime(action.updated_at)}</time>{pool ? <span title={pool}>Pool {shortPrincipal(pool)}</span> : null}</div>
    {error ? <p className="nt-alert nt-alert--danger" role="alert">{error}</p> : null}
    {poolObservation ? <PoolRecovery observation={poolObservation} /> : null}
    {recoverable.length > 0 ? <div className="ics-deposit-recovery"><strong>Transferred funds awaiting pool credit</strong><p className="nt-meta">Recover the existing transfer into your unused pool balance. This does not send tokens from Wallet again.</p>{recoverable.map((candidate) => <button key={candidate.tokenIndex} className="nt-button nt-button--secondary nt-button--sm" disabled={busy} title={candidate.ledger} onClick={() => void recover(candidate)} type="button">Recover deposit · token {candidate.tokenIndex}</button>)}</div> : null}
    {recoveryMessage ? <p className="nt-meta" role="status">{recoveryMessage}</p> : null}
    <div className="ics-inline-actions">{canContinue ? <button className="nt-button nt-button--sm" disabled={busy} onClick={() => void check(true)} type="button">{busy ? "Following operation…" : "Continue"}</button> : null}<button className="nt-button nt-button--secondary nt-button--sm" disabled={busy} onClick={() => void check(false)} type="button">{busy && !canContinue ? "Checking…" : "Check status"}</button><details className="ics-action-details"><summary>Details</summary><dl><div><dt>Operation</dt><dd>{action.id}</dd></div>{input ? Object.entries(input).map(([key, value]) => <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd>{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd></div>) : null}</dl>{Array.isArray(action.effects) ? <ul>{action.effects.map((effect, index) => isJsonObject(effect) ? <li key={index}>{String(effect.method)} · {String(effect.state)}{effect.error ? ` · ${String(effect.error)}` : ""}</li> : null)}</ul> : null}</details></div>
  </article>;
}

export function PoolRecovery({ observation }: { observation: JsonObject }) {
  const transactions = Array.isArray(observation.transactions) ? observation.transactions.filter((value): value is JsonObject => isJsonObject(value)) : [];
  const queue = Array.isArray(observation.queue) ? observation.queue : [];
  const unresolved = transactions.filter((item) => item.support_required === true || item.error || (item.state !== "Completed" && item.state !== "completed"));
  return <div className="ics-pool-recovery">
    {typeof observation.protocol_diagnostics === "string" && observation.protocol_diagnostics ? <p className="nt-alert nt-alert--warning">{observation.protocol_diagnostics}</p> : null}
    {unresolved.map((item, index) => <p className="nt-alert nt-alert--warning" key={String(item.id ?? index)}>{String(item.kind ?? "Protocol transfer")} #{String(item.id ?? "")} · {String(item.state ?? "Unknown")}{item.error ? `: ${String(item.error)}` : ""}{item.support_required === true ? " · Protocol support required" : ""}</p>)}
    {queue.length > 0 ? <p className="nt-meta">{queue.length} payout{queue.length === 1 ? "" : "s"} in the protocol queue.</p> : null}
    {typeof observation.unused0 === "string" && typeof observation.unused1 === "string" && (BigInt(observation.unused0) > 0n || BigInt(observation.unused1) > 0n) ? <p className="nt-meta">Unused tokens remain in this pool. Open Liquidity to inspect and withdraw them after any pending payout is resolved.</p> : null}
  </div>;
}

export function ActivityView() {
  const [items, setItems] = useState<SavedAction[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const load = useCallback(async (next?: string) => {
    const generation = ++sequence.current;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true); setError("");
    try {
      const page = await loadActionHistory(next, controller.signal);
      if (generation !== sequence.current || controller.signal.aborted) return;
      setItems((old) => {
        const incoming = page.items.map((item) => newestSavedAction(old.find((row) => row.id === item.id), item));
        return next ? [...old.map((item) => incoming.find((row) => row.id === item.id) ?? item), ...incoming.filter((item) => !old.some((row) => row.id === item.id))] : incoming;
      });
      setCursor(page.nextCursor);
    } catch (cause) { if (generation === sequence.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (generation === sequence.current && !controller.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => { void load(); const stop = onAppStateChange("activity", () => { void load(); }); return () => { stop(); pending.current?.abort(); sequence.current += 1; }; }, [load]);
  return <section className="ics-activity nt-stack">
    <header className="ics-section-top"><h2 className="nt-subtitle">Activity</h2><button className="nt-button nt-button--ghost nt-button--sm" disabled={loading} onClick={() => void load()} type="button">Refresh</button></header>
    {error ? <p className="nt-alert nt-alert--danger" role="alert">{error}</p> : null}
    {items.map((action) => <ActionCard key={action.id} action={action} onChange={(next) => setItems((old) => old.map((item) => item.id === next.id ? newestSavedAction(item, next) : item))} onNewAction={(next) => setItems((old) => [newestSavedAction(old.find((item) => item.id === next.id), next), ...old.filter((item) => item.id !== next.id)])} />)}
    {loading ? <p className="nt-state nt-state--loading" role="status">Reading activity…</p> : items.length === 0 ? <div className="ics-empty-block"><h3 className="nt-subtitle">No saved actions yet</h3><p className="nt-muted">Swaps, liquidity changes and their recovery steps appear here.</p></div> : null}
    {cursor ? <button className="nt-button nt-button--secondary" disabled={loading} onClick={() => void load(cursor)} type="button">Load older activity</button> : null}
  </section>;
}
