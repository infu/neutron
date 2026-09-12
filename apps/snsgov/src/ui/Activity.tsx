import { useEffect, useState } from "react";
import { invoke } from "../data/actions_client";
import { shortenId } from "../data/format";
import { Disclosure, ErrorNote, PageHeading, errorMessage, useRead } from "./Common";
import { Empty, Pending } from "./Status";

interface Operation {
  operationId: string;
  rootCanisterId?: string;
  kind?: string;
  title?: string;
  status?: string;
  review?: unknown;
  input?: unknown;
  state?: unknown;
  steps?: { stepId: string; status: string; error?: string; argsHex?: string; replyHex?: string }[];
  outcomes?: ActionOutcome[];
  fundingInstructions?: unknown;
  message?: string;
  createdAtSeconds?: string | number;
  updatedAtSeconds?: string | number;
}
interface History { operations: Operation[]; nextCursor?: string | null; total?: string }
interface ActionOutcome {
  stepId?: string; neuronId?: string; status?: string; method?: string;
  outcome?: { ok: boolean; command?: string; errorMessage?: string; proposalId?: string; neuronId?: string; transferBlockHeight?: string };
  reconciled?: boolean; message?: string; error?: string; result?: unknown;
}
const readable = (text: string | undefined): string => (text ?? "Pending").replace(/[_-]/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
const stepState = (status: string): string => ({ prepared: "Not sent yet", dispatching: "Waiting for a reply", replied: "Reply received", unknown: "Reply not confirmed" })[status] ?? readable(status);
const operationTitle = (operation: Operation): string => operation.title ?? (typeof operation.review === "object" && operation.review !== null && "title" in operation.review && typeof operation.review.title === "string" ? operation.review.title : operation.kind ? readable(operation.kind) : "Saved action");
function outcomeDescription(result: ActionOutcome): string {
  if (result.error || result.outcome?.errorMessage) return result.error ?? result.outcome!.errorMessage!;
  if (result.reconciled || result.status === "reconciled") return result.message ?? "Confirmed from the current state.";
  if (result.message) return result.message;
  if (result.outcome?.ok || result.status === "succeeded") return "Accepted by the community.";
  if (result.status === "completed") return "The governance method returned successfully.";
  if (result.outcome?.ok === false || result.status === "rejected") return "The community rejected this step.";
  if (result.status === "unattempted") return "Not sent. Continue the saved action when you are ready.";
  if (result.status === "unknown") return "The reply was interrupted. Check the saved result before retrying.";
  return "No confirmed result yet.";
}

export function ActivityView({ initialOperationId, navigationKey = 0 }: { initialOperationId?: string; navigationKey?: number }) {
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<string | null>(initialOperationId ?? null);
  const [older, setOlder] = useState<Operation[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const history = useRead("operations", signal => invoke<History>("sns_operation_history_v1", {}, signal), refresh);
  useEffect(() => { setSelected(initialOperationId ?? null); }, [initialOperationId, navigationKey]);
  useEffect(() => { if (history.data) { setOlder([]); setCursor(history.data.nextCursor); } }, [history.data]);
  const loadMore = async () => {
    if (!cursor || history.loading) return;
    setLoadingMore(true); setError("");
    try {
      const page = await invoke<History>("sns_operation_history_v1", { cursor });
      setOlder(previous => [...previous, ...page.operations]); setCursor(page.nextCursor);
    } catch (caught) { setError(errorMessage(caught)); } finally { setLoadingMore(false); }
  };
  if (selected) return <OperationDetail key={selected} operationId={selected} onBack={() => { setSelected(null); setRefresh(value => value + 1); }} />;
  const rows = [...new Map([...(history.data?.operations ?? []), ...older].map(row => [row.operationId, row])).values()];
  return <section className="nt-page">
    <PageHeading title="Activity" description="Your votes, staking and neuron changes." actions={<button className="nt-button nt-button--ghost" type="button" disabled={history.loading || loadingMore} onClick={() => setRefresh(value => value + 1)}>Refresh</button>} />
    <ErrorNote message={history.error || error} />
    {!history.data && history.loading && <Pending label="Reading activity" />}
    {history.data && rows.length === 0 && <Empty label="Your actions will appear here with their results and any next steps." />}
    <div className="snsgov-activity-list">{rows.map(operation => <button className="snsgov-activity-row" type="button" key={operation.operationId} onClick={() => setSelected(operation.operationId)}>
      <span><strong>{operationTitle(operation)}</strong><small>{operationTime(operation.updatedAtSeconds ?? operation.createdAtSeconds)}</small>{!operation.kind && <small>{shortenId(operation.operationId, 8, 6)} · {operation.steps?.length ?? 0} steps</small>}</span>
      <span className="nt-badge">{operation.status === "recorded" ? "View result" : readable(operation.status)}</span><span aria-hidden="true">›</span>
    </button>)}</div>
    {cursor && <button className="nt-button" type="button" disabled={loadingMore || history.loading} onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Load more"}</button>}
  </section>;
}

function OperationDetail({ operationId, onBack }: { operationId: string; onBack: () => void }) {
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const read = useRead(operationId, signal => invoke<Operation>("sns_operation_status_v1", { operationId }, signal), refresh);
  const operation = read.data;
  const continueOperation = async () => {
    setBusy(true); setMessage("");
    try { await invoke("sns_continue_v1", { operationId }); setRefresh(value => value + 1); }
    catch (caught) { setMessage(errorMessage(caught)); } finally { setBusy(false); }
  };
  const status = operation?.status ?? "";
  const canContinue = /^(?:prepared|pending|awaiting_funding|awaitingFunding|needs_attention|needsAttention|ready|interrupted)$/.test(status);
  return <section className="nt-page">
    <PageHeading title={operation ? operationTitle(operation) : "Action details"} onBack={onBack} actions={<button className="nt-button nt-button--ghost" type="button" disabled={read.loading || busy} onClick={() => setRefresh(value => value + 1)}>Check status</button>} />
    <ErrorNote message={read.error || message} />
    {!operation && read.loading && <Pending label="Checking the saved result" />}
    {operation && <>
      <p className="snsgov-operation-status" role="status">{readable(status)}</p>
      <p className="nt-text snsgov-muted">{operation.message ?? (status.toLowerCase().includes("unknown") || operation.steps?.some(step => step.status === "unknown") ? "The reply was interrupted. Check the saved result before taking another action." : "Your original request and its received results are saved, including after you reopen the app.")}</p>
      {operation.steps && operation.steps.length > 0 && <ol className="snsgov-operation-steps">{operation.steps.map(step => <li key={step.stepId}><strong>{readable(step.stepId)}</strong><span>{stepState(step.status)}</span>{step.error && <ErrorNote message={step.error} />}</li>)}</ol>}
      {operation.outcomes && operation.outcomes.length > 0 && <section className="nt-section"><h3 className="nt-section-heading">Results</h3>{operation.outcomes.map((result, index) => <div className="snsgov-action-outcome" key={`${result.stepId}:${index}`}>
        <strong>{result.neuronId ? `Neuron ${shortenId(result.neuronId, 8, 6)}` : readable(result.outcome?.command ?? result.method ?? result.stepId ?? "Action")}</strong>
        <p className="nt-text">{outcomeDescription(result)}</p>
        {result.outcome?.proposalId && <p className="nt-meta">Proposal {result.outcome.proposalId}</p>}
        {result.outcome?.neuronId && <p className="nt-meta">Neuron <code>{result.outcome.neuronId}</code></p>}
        {result.outcome?.transferBlockHeight && <p className="nt-meta">Transfer record {result.outcome.transferBlockHeight}</p>}
      </div>)}</section>}
      {Array.isArray(operation.fundingInstructions) && operation.fundingInstructions.length > 0 && <p className="nt-alert nt-alert--info" role="status">This action is waiting for its original Wallet funding step. Continue from the agent or wallet flow that began it, using the saved reference below.</p>}
      {canContinue && <button className="nt-button" type="button" disabled={busy} onClick={() => void continueOperation()}>{busy ? "Continuing…" : "Continue this action"}</button>}
      <Disclosure title="Action details"><dl className="snsgov-facts"><dt>Reference</dt><dd className="nt-code">{operationId}</dd>{operation.rootCanisterId && <><dt>Community</dt><dd className="nt-code">{shortenId(operation.rootCanisterId, 12, 8)}</dd></>}<dt>Updated</dt><dd>{operationTime(operation.updatedAtSeconds)}</dd></dl>{operation.review !== undefined && <pre className="nt-pre nt-pre--wrap">{JSON.stringify(operation.review, null, 2)}</pre>}{operation.outcomes !== undefined && <pre className="nt-pre nt-pre--wrap">{JSON.stringify(operation.outcomes, null, 2)}</pre>}</Disclosure>
    </>}
  </section>;
}

function operationTime(value: string | number | undefined) {
  if (value === undefined) return "";
  try {
    const timestamp = Number(BigInt(value)) * 1000;
    if (!Number.isFinite(timestamp)) return "Date unavailable";
    const date = new Date(timestamp), exact = date.toISOString();
    return <time dateTime={exact} title={exact}>{date.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}</time>;
  } catch { return "Date unavailable"; }
}
