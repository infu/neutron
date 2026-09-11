import { useEffect, useId, useState } from "react";
import { invoke, operationId } from "../data/actions_client";
import { proposalActionCatalog, buildProposalAction, proposalActionToJson, validateProposalText } from "../data/proposal_actions";
import { readHotkey } from "../data/relay";
import { readRegistration } from "../data/registration";
import { listNervousSystemFunctions, readParameters } from "../data/governance";
import { displayName, type RegistryEntry } from "../data/registry";
import { formatTokenAmount, parseTokenAmount, shortenId } from "../data/format";
import { Dialog, Disclosure, ErrorNote, Help, useRead } from "./Common";
import { Pending } from "./Status";

const catalog = proposalActionCatalog();
const COMMON = new Set(["Motion", "ManageSnsMetadata", "TransferSnsTreasuryFunds", "MintSnsTokens", "ManageNervousSystemParameters", "ManageLedgerParameters", "ExecuteGenericNervousSystemFunction", "UpgradeSnsToNextVersion"]);
export interface ProposalOperationResult {
  operationId?: string; status?: string; proposalId?: string | number; cleanupWarning?: string; message?: string;
  outcomes?: { stepId?: string; outcome?: { ok?: boolean; proposalId?: string | number; errorMessage?: string }; message?: string }[];
  review?: Record<string, unknown>;
  steps?: { stepId: string; status: string }[];
  operation?: { steps?: { stepId: string; status: string }[] };
}
export function confirmedProposalId(result: ProposalOperationResult): bigint | undefined {
  const value = result.proposalId ?? result.outcomes?.find(row => row.outcome?.ok && row.outcome.proposalId !== undefined)?.outcome?.proposalId;
  return value !== undefined && /^\d+$/.test(String(value)) ? BigInt(value) : undefined;
}

export function ProposalCreate({ entry, onClose, onCreated }: {
  entry: RegistryEntry; onClose: () => void; onCreated?: ((id?: bigint) => void) | undefined;
}) {
  const prefix = useId();
  const [kind, setKind] = useState("Motion");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [url, setUrl] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [neuronId, setNeuronId] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [json, setJson] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<Record<string, unknown> | null>(null);
  const [prepared, setPrepared] = useState<Record<string, unknown> | null>(null);
  const [result, setResult] = useState<ProposalOperationResult | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [customPreview, setCustomPreview] = useState<{ rendering?: string; note?: string } | null>(null);
  const [activeOperation, setActiveOperation] = useState<string | null>(null);
  const descriptor = catalog.find(action => action.actionKind === kind)!;
  const reads = useRead(`proposal-create:${entry.canisters.root}`, async () => {
    const [hotkey, parameters, functions] = await Promise.all([readHotkey(), readParameters(entry.canisters.governance), listNervousSystemFunctions(entry.canisters.governance)]);
    const access = await readRegistration(entry.canisters.governance, hotkey.principal);
    return { access, parameters, functions, hotkey };
  });
  const proposers = reads.data?.access.found.filter(neuron => !neuron.missing.includes(3)) ?? [];
  useEffect(() => { if (proposers.length === 1 && !neuronId) setNeuronId(proposers[0]!.neuronId); }, [reads.data, neuronId]);
  const set = (name: string, value: string) => { setFields(previous => ({ ...previous, [name]: value })); setReview(null); setPrepared(null); setError(null); };
  const locked = busy || activeOperation !== null;
  const input = (name: string, label: string, options: { multiline?: boolean; help?: string; placeholder?: string } = {}) => <label className="snsgov-field" key={name} htmlFor={`${prefix}-${name}`}>
    <span>{label}</span>{options.multiline ? <textarea id={`${prefix}-${name}`} aria-label={label} aria-describedby={options.help ? `${prefix}-${name}-help` : undefined} className="nt-textarea" rows={4} value={fields[name] ?? ""} disabled={locked} onChange={event => set(name, event.target.value)} />
      : <input id={`${prefix}-${name}`} aria-label={label} aria-describedby={options.help ? `${prefix}-${name}-help` : undefined} className="nt-input" value={fields[name] ?? ""} disabled={locked} placeholder={options.placeholder} onChange={event => set(name, event.target.value)} />}
    {options.help && <small id={`${prefix}-${name}-help`} className="nt-meta">{options.help}</small>}
  </label>;

  const build = async () => {
    validateProposalText({ title, summary, url });
    let body: unknown;
    if (advanced || !COMMON.has(kind)) body = JSON.parse(json);
    else if (kind === "Motion") body = { motion_text: fields.motion ?? "" };
    else if (kind === "ManageSnsMetadata") body = compact({ name: fields.name, description: fields.description, url: fields.website, logo: fields.logo });
    else if (kind === "UpgradeSnsToNextVersion") body = {};
    else if (kind === "ManageLedgerParameters") body = compact({ token_name: fields.tokenName, token_symbol: fields.tokenSymbol, token_logo: fields.tokenLogo, transfer_fee: fields.fee ? amount(fields.fee, entry.token?.decimals) : undefined });
    else if (kind === "ManageNervousSystemParameters") body = compact({
      initial_voting_period_seconds: seconds(fields.votingDays), neuron_minimum_dissolve_delay_to_vote_seconds: seconds(fields.minimumDelayDays),
      reject_cost_e8s: fields.rejectCost ? amount(fields.rejectCost, entry.token?.decimals) : undefined,
    });
    else if (kind === "TransferSnsTreasuryFunds" || kind === "MintSnsTokens") {
      const icp = kind === "TransferSnsTreasuryFunds" && fields.treasury === "icp";
      body = compact({ ...(kind === "TransferSnsTreasuryFunds" ? { from_treasury: icp ? 1 : 2 } : {}),
        amount_e8s: amount(fields.amount ?? "", icp ? 8 : entry.token?.decimals), to_principal: fields.recipient,
        to_subaccount: fields.subaccount ? { subaccount: { hex: fields.subaccount } } : undefined,
        memo: fields.memo,
      });
    } else {
      const validation = await invoke<{ payloadHex: string; valid: boolean; error?: string; rendering?: string; validation?: { status?: string } }>("sns_validate_payload", {
        rootCanisterId: entry.canisters.root, functionId: fields.functionId ?? "", value: JSON.parse(fields.arguments ?? "{}"),
      });
      if (!validation.payloadHex) throw new Error(validation.error ?? "The custom action could not be encoded.");
      if (validation.validation?.status === "rejected") throw new Error(validation.error ?? "The community's validator rejected these arguments.");
      setCustomPreview({ ...(validation.rendering ? { rendering: validation.rendering } : {}), ...(!validation.valid ? { note: validation.error ?? "The query validator did not confirm this payload. SNS Governance performs authoritative validation at submission." } : {}) });
      body = { function_id: fields.functionId, payload: { hex: validation.payloadHex } };
    }
    const action = proposalActionToJson(buildProposalAction(kind, body));
    return { rootCanisterId: entry.canisters.root, neuronId, title, summary, url, action };
  };

  const preview = async () => {
    setBusy(true); setError(null);
    try {
      const input = { ...await build(), operationId: operationId() };
      const value = await invoke<Record<string, unknown>>("sns_preview_proposal_v1", input);
      setPrepared(input); setReview((value.review ?? value) as Record<string, unknown>);
    } catch (reason) { setError(describe(reason)); }
    finally { setBusy(false); }
  };
  const submit = async () => {
    if (!prepared || activeOperation) return;
    const id = String(prepared.operationId); setActiveOperation(id); setBusy(true); setError(null);
    try { setResult(await invoke<ProposalOperationResult>("sns_submit_proposal_v1", { ...prepared, operationId: id })); }
    catch (reason) { setError(`${describe(reason)} Check this saved operation before submitting again.`); setResult({ operationId: id, status: "pending" }); }
    finally { setBusy(false); }
  };
  const check = async (continueSaved = false) => {
    if (!activeOperation) return;
    setBusy(true); setError(null);
    try { setResult(await invoke<ProposalOperationResult>(continueSaved ? "sns_continue_v1" : "sns_operation_status_v1", { operationId: activeOperation })); }
    catch (reason) { setError(describe(reason)); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setError(null);
    try { const input = await build(); const value = await invoke<{ draftId: string }>("sns_draft_proposal", { rootCanisterId: entry.canisters.root, title, summary, url, action: input.action }); setSaved(value.draftId); }
    catch (reason) { setError(describe(reason)); }
    finally { setBusy(false); }
  };
  const confirmed = result ? confirmedProposalId(result) : undefined;
  const cost = reads.data?.parameters.rejectCostE8s;

  return <Dialog title={`Create a proposal · ${displayName(entry)}`} onClose={onClose} footer={!activeOperation ? <div className="nt-cluster snsgov-composer-actions">
      <button type="button" className="nt-button nt-button--ghost" disabled={locked || !title.trim()} onClick={() => void save()}>Save draft</button>
      {review ? <button type="button" className="nt-button" disabled={locked} onClick={() => void submit()}>Submit proposal</button> : <button type="button" className="nt-button" disabled={locked || !title.trim() || !proposers.some(neuron => neuron.neuronId === neuronId)} onClick={() => void preview()}>{busy ? "Preparing…" : "Review proposal"}</button>}
    </div> : undefined}>
    <div className="snsgov-proposal-composer">
      {error && <ErrorNote message={error} />}{reads.error && <ErrorNote message={reads.error} />}
      {saved && <p className="nt-alert nt-alert--success" role="status">Draft {saved} saved. It can be reviewed in Drafts.</p>}
      {result && <ProposalReceipt result={result} />}
      {confirmed !== undefined && <button type="button" className="nt-button" onClick={() => onCreated?.(confirmed)}>View proposal {confirmed.toString()}</button>}
      {activeOperation && confirmed === undefined && <div className="nt-cluster"><button type="button" className="nt-button" disabled={busy} onClick={() => void check()}>Check saved submission</button>{(result?.steps ?? result?.operation?.steps)?.some(step => step.status === "prepared") && <button type="button" className="nt-button" disabled={busy} onClick={() => void check(true)}>Continue saved submission</button>}</div>}
      {!activeOperation && <>
        <label className="snsgov-field"><span>Proposal type</span><select className="nt-select" aria-label="Proposal type" disabled={locked} value={kind} onChange={event => { setKind(event.target.value); setCustomPreview(null); setFields({}); setAdvanced(false); setJson(defaultJson(event.target.value)); setReview(null); setPrepared(null); setError(null); }}>{catalog.map(action => <option key={action.actionKind} value={action.actionKind}>{action.name}</option>)}</select><small className="nt-meta">{descriptor.description}</small></label>
        {descriptor.availabilityNote && <p className="nt-alert nt-alert--warning">{descriptor.availabilityNote}</p>}
        <label className="snsgov-field"><span>Title</span><input className="nt-input" value={title} disabled={locked} onChange={event => { setTitle(event.target.value); setReview(null); }} /></label>
        <label className="snsgov-field"><span>Summary for voters</span><textarea className="nt-textarea" rows={4} value={summary} disabled={locked} onChange={event => { setSummary(event.target.value); setReview(null); }} /></label>
        <label className="snsgov-field"><span>Supporting link (optional)</span><input className="nt-input" value={url} disabled={locked} onChange={event => { setUrl(event.target.value); setReview(null); }} /></label>
        {!advanced && COMMON.has(kind) && <div className="snsgov-proposal-fields">
          {kind === "Motion" && input("motion", "Motion text", { multiline: true, help: "The decision you want the community to adopt." })}
          {kind === "ManageSnsMetadata" && <><p className="nt-meta">Leave fields blank to keep their current values. Use the full editor to explicitly clear an optional value.</p>{input("name", "New community name")}{input("description", "New description", { multiline: true })}{input("website", "New website URL")}{input("logo", "New logo data URL")}</>}
          {(kind === "TransferSnsTreasuryFunds" || kind === "MintSnsTokens") && <>
            {kind === "TransferSnsTreasuryFunds" && <label className="snsgov-field"><span>Treasury</span><select className="nt-select" disabled={locked} value={fields.treasury ?? "sns"} onChange={event => set("treasury", event.target.value)}><option value="sns">{entry.token?.symbol ?? "SNS tokens"}</option><option value="icp">ICP</option></select></label>}
            {input("amount", `Amount (${fields.treasury === "icp" && kind === "TransferSnsTreasuryFunds" ? "ICP" : entry.token?.symbol ?? "token metadata unavailable"})`)}
            {input("recipient", "Recipient principal", { help: "Review the entire destination before submitting." })}
            <Disclosure title="Destination subaccount and memo (optional)">{input("subaccount", "Subaccount (64 hex characters)")}{input("memo", "Memo (whole number)")}</Disclosure>
          </>}
          {kind === "ManageNervousSystemParameters" && <><p className="nt-meta">Only entered settings will change.</p>{input("votingDays", "Initial voting period (days)")}{input("minimumDelayDays", "Minimum unlock delay for voting (days)")}{input("rejectCost", `Cost if rejected (${entry.token?.symbol ?? "metadata unavailable"})`)}</>}
          {kind === "ManageLedgerParameters" && <>{input("tokenName", "New token name")}{input("tokenSymbol", "New token symbol")}{input("tokenLogo", "New token logo data URL")}{input("fee", `Transfer fee (${entry.token?.symbol ?? "metadata unavailable"})`)}</>}
          {kind === "ExecuteGenericNervousSystemFunction" && <>
            <label className="snsgov-field"><span>Community proposal type</span><select className="nt-select" disabled={locked} value={fields.functionId ?? ""} onChange={event => set("functionId", event.target.value)}><option value="">Choose a proposal type…</option>{reads.data?.functions.filter(fn => fn.kind === "generic").map(fn => <option key={fn.id.toString()} value={fn.id.toString()}>{fn.name}{!fn.topic ? " — no topic assigned" : ""}</option>)}</select></label>
            {fields.functionId && !reads.data?.functions.find(fn => fn.id.toString() === fields.functionId)?.topic && <p className="nt-meta snsgov-warning">This function has no topic assigned. Governance versions that require topics may reject it; the community's canister decides whether it is supported.</p>}
            {customPreview?.note && <p className="nt-alert nt-alert--warning">{customPreview.note}</p>}{customPreview?.rendering && <pre className="nt-pre nt-pre--wrap">{customPreview.rendering}</pre>}
            <Disclosure title="Custom method arguments" open>{input("arguments", "Arguments (JSON)", { multiline: true, help: "Use decimal strings for large integers and principal text for addresses. Multiple method arguments use an array; no arguments use []." })}<p className="nt-meta">Preview only uses query validation. A validator that requires updates is checked by SNS Governance during authoritative submission.</p></Disclosure>
          </>}
        </div>}
        <Disclosure title="Advanced: full action schema and Candid input" open={!COMMON.has(kind)}>
          {COMMON.has(kind) && <label className="snsgov-checkbox"><input type="checkbox" checked={advanced} disabled={locked} onChange={event => { setAdvanced(event.target.checked); setReview(null); }} />Use the full action editor</label>}
          {(advanced || !COMMON.has(kind)) && <label className="snsgov-field"><span>Action fields (JSON)</span><textarea className="nt-textarea nt-code" rows={9} disabled={locked} value={json} onChange={event => { setJson(event.target.value); setReview(null); }} /><small className="nt-meta">Optional values may be omitted or null. Integers use decimal strings; variants use one named key; blobs use {`{"hex":"..."}`}. This input is validated against the exact bundled Candid type.</small></label>}
          <Disclosure title="Full field schema"><pre className="nt-pre nt-pre--wrap">{JSON.stringify(descriptor.schema, null, 2)}</pre></Disclosure>
        </Disclosure>
        <label className="snsgov-field"><span>Propose with</span><select className="nt-select" aria-label="Propose with" disabled={locked} value={neuronId} onChange={event => { setNeuronId(event.target.value); setReview(null); }}><option value="">Choose a neuron…</option>{proposers.map(neuron => <option key={neuron.neuronId} value={neuron.neuronId}>Neuron {shortenId(neuron.neuronId, 10, 6)} · Can propose</option>)}</select></label>
        {reads.loading && <Pending label="Finding neurons that may propose" />}
        {reads.data && !proposers.length && <p className="nt-meta">No connected neuron grants SubmitProposal permission. You can still save this proposal as a draft.</p>}
        {reads.data?.access.truncated && <p className="nt-meta snsgov-warning">Proposer discovery is incomplete; only the neurons found so far are listed.</p>}
        {cost !== undefined && <p className="nt-text">Cost if rejected: <strong>{entry.token ? `${formatTokenAmount(cost, entry.token.decimals)} ${entry.token.symbol}` : `${cost} atoms`}</strong> <Help label="Cost if rejected">SNS Governance charges the proposing neuron's fee balance when a proposal is accepted for submission. Adoption restores the rejection cost; a rejected proposal keeps that cost.</Help></p>}
        {review && <div className="snsgov-proposal-review"><h3 className="nt-section-heading">Ready to review</h3><p className="nt-text">“{title}” · {descriptor.name} · {displayName(entry)}</p><p className="nt-meta">Submission puts the proposal on-chain. The exact action and consequences appear in the final review.</p><Disclosure title="Exact preview"><pre className="nt-pre nt-pre--wrap">{JSON.stringify(review, null, 2)}</pre></Disclosure></div>}

      </>}
    </div>
  </Dialog>;
}

export function ProposalReceipt({ result }: { result: ProposalOperationResult }) {
  const id = confirmedProposalId(result);
  return <div className={`nt-alert ${id === undefined ? "nt-alert--warning" : "nt-alert--success"}`} role="status">
    <p>{id !== undefined ? `Proposal ${id} was submitted.` : result.status === "rejected" ? "The SNS rejected this submission." : "Submission is saved. A confirmed proposal ID is not yet available."}</p>
    {result.message && <p>{result.message}</p>}{result.cleanupWarning && <p>{result.cleanupWarning}</p>}
    {result.outcomes?.map((row, index) => (row.outcome?.errorMessage || row.message) && <p key={row.stepId ?? index}>{row.outcome?.errorMessage ?? row.message}</p>)}
    {result.operationId && <p className="nt-meta snsgov-wrap-anywhere">Operation {result.operationId}</p>}
  </div>;
}
function compact(value: Record<string, unknown>) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== "")); }
function amount(value: string, decimals?: number) {
  if (decimals === undefined) throw new Error("Token decimals could not be read. Refresh community metadata before entering a token amount.");
  const parsed = parseTokenAmount(value, decimals);
  if (parsed < 0n) throw new Error("Amounts cannot be negative.");
  return parsed.toString();
}
function seconds(value?: string) { return value ? (parseTokenAmount(value, 0) * 86400n).toString() : undefined; }
function defaultJson(kind: string): string { return kind === "RemoveGenericNervousSystemFunction" ? '"1000"' : kind === "ExecuteGenericNervousSystemFunction" ? '{"function_id":"1000","payload":{"hex":"4449444c0000"}}' : "{}"; }
function describe(reason: unknown) { return reason instanceof Error ? reason.message : String(reason); }
