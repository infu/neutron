import { useId, useState, type ReactNode } from "react";
import { invoke } from "../data/actions_client";
import { formatTokenAmount } from "../data/format";
import type { RegistryEntry } from "../data/registry";
import { Disclosure, ErrorNote } from "./Common";

export function neuronAmount(value: bigint, entry: RegistryEntry): string {
  return entry.token ? `${formatTokenAmount(value, entry.token.decimals)} ${entry.token.symbol}` : `${value} atoms`;
}
export function Field({ label, value, onChange, help, multiline = false, inputMode, disabled = false }: {
  label: string; value: string; onChange: (value: string) => void; help?: ReactNode;
  multiline?: boolean; inputMode?: "decimal" | "numeric" | "text"; disabled?: boolean;
}) {
  const id = useId();
  return <div className="snsgov-neuron-field"><label className="nt-label" htmlFor={id}>{label}</label>
    {multiline ? <textarea className="nt-input" id={id} value={value} disabled={disabled} onChange={event => onChange(event.target.value)} rows={5} aria-describedby={help ? `${id}-help` : undefined} />
      : <input className="nt-input" id={id} value={value} disabled={disabled} inputMode={inputMode ?? "text"} onChange={event => onChange(event.target.value)} aria-describedby={help ? `${id}-help` : undefined} />}
    {help && <div className="nt-meta" id={`${id}-help`}>{help}</div>}
  </div>;
}
export function DurationField({ label, value, unit, onChange, onUnitChange, disabled = false }: {
  label: string; value: string; unit: string; onChange: (value: string) => void; onUnitChange: (value: string) => void; disabled?: boolean;
}) {
  const id = useId();
  const exact = /^\d+$/.test(value.trim()) ? (BigInt(value) * BigInt(unit)).toString() : undefined;
  return <><div className="snsgov-neuron-duration"><Field label={label} value={value} onChange={onChange} inputMode="numeric" disabled={disabled} />
    <div className="snsgov-neuron-field"><label className="nt-label" htmlFor={id}>Unit</label><select className="nt-input" id={id} aria-label={`${label} unit`} value={unit} disabled={disabled} onChange={event => onUnitChange(event.target.value)}>
      <option value="86400">Days</option><option value="2592000">Months (30 days)</option><option value="31536000">Years (365 days)</option><option value="3600">Hours</option><option value="1">Seconds</option>
    </select></div></div>{exact !== undefined && <p className="nt-meta">Exact duration: {exact} seconds.</p>}</>;
}
export const jsonText = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);

/** Retained provider results, including interrupted operations, stay inspectable. */
export function NeuronOperationResult({ id, result, error }: { id: string; result?: unknown; error?: string }) {
  const [status, setStatus] = useState<unknown>(result);
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true); setFailure(undefined);
    try { setStatus(await invoke("sns_operation_status_v1", { operationId: id })); }
    catch (caught) { setFailure(String(caught)); }
    finally { setBusy(false); }
  };
  const value = status ?? result;
  const record = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const phase = typeof record?.status === "string" ? record.status : undefined;
  const outcomes = Array.isArray(record?.outcomes) ? record.outcomes as { stepId?: string; outcome?: { ok?: boolean; command?: string; errorMessage?: string }; reconciled?: boolean; message?: string }[] : [];
  const headline = phase === "completed" ? "Completed" : phase === "rejected" ? "Needs attention: the SNS rejected a step" : phase === "pending" ? "Pending: a step needs reconciliation" : phase === "prepared" ? "Saved: ready to continue" : "Checking recorded outcome";
  return <section className="snsgov-operation-result" aria-label="Operation result">
    <h3 className="nt-section-heading">Operation activity</h3>
    {error && <ErrorNote message={error ?? null} />}
    <p role="status"><strong>{headline}</strong></p>
    {error && <p>The request did not return a confirmed outcome. Check its saved status before creating another request.</p>}
    {typeof record?.message === "string" && <p>{record.message}</p>}
    {outcomes.length > 0 && <ul>{outcomes.map((item, index) => <li key={`${item.stepId}/${index}`}><strong>{(item.stepId ?? "Step").replace(/_/g, " ")}</strong>: {item.reconciled ? "Confirmed by reading current state" : item.outcome?.ok ? `${item.outcome.command ?? "Command"} accepted` : item.outcome?.errorMessage ?? item.message ?? "Outcome not confirmed"}</li>)}</ul>}
    {Array.isArray(record?.fundingInstructions) && record.fundingInstructions.length > 0 && <p>Token funding needs attention. Open this saved operation in Activity to continue with the same deposit identifiers.</p>}
    <p className="nt-meta">Operation <code className="nt-code">{id}</code></p>
    {value !== undefined && <Disclosure title="Recorded outcome details"><pre className="snsgov-code">{jsonText(value)}</pre></Disclosure>}
    <ErrorNote message={failure ?? null} />
    <button className="nt-button nt-button--secondary" type="button" disabled={busy} onClick={() => void check()}>{busy ? "Checking saved status…" : "Check saved status"}</button>
    <p className="nt-meta">Use Activity to continue a saved operation. Funding and governance steps retain the same request identifiers.</p>
  </section>;
}
