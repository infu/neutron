import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../data/actions_client";
import { canPropose, listDrafts, type DraftRow } from "../data/drafts";
import { formatTokenAmount, shortenId, toHex } from "../data/format";
import { readRegistration } from "../data/registration";
import { readHotkey } from "../data/relay";
import { getRegistry, requireEntry, displayName } from "../data/registry";
import { readParameters } from "../data/governance";
import { decodeProposalAction, proposalActionToJson } from "../data/proposal_actions";
import { Disclosure, ErrorNote, Help, PageHeading, useRead } from "./Common";
import { SnsLogo } from "./Logo";
import { Empty, Pending } from "./Status";
import { actionLabel, ProposalTime, safeExternalUrl } from "./Proposals";
import { confirmedProposalId, ProposalReceipt, type ProposalOperationResult } from "./ProposalCreate";

export function DraftsView({ onBack, focusDraftId = null, onChanged }: {
  onBack: () => void; focusDraftId?: string | null; onChanged?: (() => void) | undefined;
}) {
  const [drafts, setDrafts] = useState<DraftRow[] | null>(null);
  const [open, setOpen] = useState<string | null>(focusDraftId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const submitted = useRef(new Set<string>());
  const registry = useRead("draft-communities", () => getRegistry());
  const load = useCallback(async () => {
    const request = ++generation.current;
    setBusy(true); setError(null);
    try { const rows = await listDrafts(); if (request === generation.current) setDrafts(rows); }
    catch (reason) { if (request === generation.current) setError(describe(reason)); }
    finally { if (request === generation.current) setBusy(false); }
  }, []);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
  useEffect(() => { setOpen(focusDraftId); void load(); }, [focusDraftId, load]);
  const selected = drafts?.find(draft => draft.id === open);
  const available = drafts?.filter(draft => !submitted.current.has(draft.id));
  const changed = () => { onChanged?.(); void load(); };

  return <div className="nt-page snsgov-drafts">
    <PageHeading title="Drafts" description="Saved proposals ready for a human review." onBack={onBack} actions={<button className="nt-button nt-button--ghost" type="button" disabled={busy} onClick={() => void load()}>{busy ? "Refreshing…" : "Refresh drafts"}</button>} />
    <section className="nt-page-main">
      {error && <ErrorNote message={error} />}
      {!drafts && !error && <Pending label="Reading drafts" />}
      {open && drafts && !selected && <p className="nt-meta">This draft is no longer available.</p>}
      {!selected && available?.length === 0 && <Empty label="No saved drafts. Create a proposal from the feed or a community page, or ask your agent to prepare one." />}
      {!selected && <div className="snsgov-draft-list">{available?.map(draft => {
        const entry = registry.data?.entries.find(entry => entry.canisters.root === draft.sns);
        const name = entry ? displayName(entry) : shortenId(draft.sns, 8, 6);
        return <article className="snsgov-post" key={draft.id}>
          <div className="snsgov-post-byline"><SnsLogo name={name} logo={entry?.metadata?.logo} size={28} /><span className="snsgov-post-community">{name}</span><span className="nt-meta">Updated <ProposalTime seconds={draft.updatedAtSeconds} relative /></span></div>
          <h3 className="snsgov-post-title"><button className="snsgov-link" type="button" onClick={() => setOpen(draft.id)}>{draft.title || "Untitled proposal"}</button></h3>
          <p className="nt-meta">{draftActionLabel(draft)} · Drafted by {draft.createdBy}</p>
          <p className="snsgov-proposal-body">{draft.summary.length > 240 ? `${draft.summary.slice(0, 240)}…` : draft.summary}</p>
          <button className="nt-button nt-button--ghost" type="button" onClick={() => setOpen(draft.id)}>Review draft</button>
        </article>;
      })}</div>}
      {selected && <DraftDetail key={JSON.stringify(selected, (_name, value: unknown) => typeof value === "bigint" ? value.toString() : value)} draft={selected} onClose={() => setOpen(null)} onSubmitted={() => { submitted.current.add(selected.id); onChanged?.(); }} onDiscarded={() => { setOpen(null); changed(); }} />}
    </section>
  </div>;
}

function DraftDetail({ draft, onClose, onSubmitted, onDiscarded }: {
  draft: DraftRow; onClose: () => void; onSubmitted: () => void; onDiscarded: () => void;
}) {
  const [neuronId, setNeuronId] = useState(draft.proposer ? toHex(draft.proposer) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProposalOperationResult | null>(null);
  const [started, setStarted] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [discarding, setDiscarding] = useState(false);
  const sent = useRef(false);
  const access = useRead(`draft-access:${draft.governance}`, async () => {
    const hotkey = await readHotkey();
    return readRegistration(draft.governance, hotkey.principal);
  }, refresh);
  const metadata = useRead(`draft-community:${draft.sns}`, () => requireEntry(draft.sns));
  const parameters = useRead(`draft-parameters:${draft.governance}`, () => readParameters(draft.governance));
  const eligible = access.data?.found.filter(neuron => canPropose(neuron.missing)) ?? [];
  useEffect(() => {
    if (!draft.proposer && eligible.length === 1 && !neuronId) setNeuronId(eligible[0]!.neuronId);
  }, [access.data, draft.proposer, neuronId]);
  const name = metadata.data ? displayName(metadata.data) : draft.sns;
  const ready = eligible.some(neuron => neuron.neuronId === neuronId);
  const token = metadata.data?.token;
  const cost = parameters.data?.rejectCostE8s;

  const submit = async (checkOnly = false) => {
    if (busy || (!started && !ready)) return;
    setBusy(true); setError(null); setStarted(true);
    try {
      // The service derives one immutable operation ID from this saved draft.
      // Retargeting a screen, losing a reply or cleanup failure cannot create a
      // second proposal operation for the same draft.
      let next: ProposalOperationResult;
      if (checkOnly) {
        const id = result?.operationId ?? (await invoke<{ drafts: { id: string; operationId: string }[] }>("sns_drafts")).drafts.find(row => String(row.id) === draft.id)?.operationId;
        if (!id) throw new Error("The saved draft's operation ID could not be read.");
        next = await invoke<ProposalOperationResult>("sns_operation_status_v1", { operationId: id });
      } else next = result?.operationId
        ? await invoke<ProposalOperationResult>("sns_continue_v1", { operationId: result.operationId })
        : await invoke<ProposalOperationResult>("sns_submit_draft_v1", { draftId: draft.id, neuronId });
      setResult(next);
      if (confirmedProposalId(next) !== undefined && !sent.current) { sent.current = true; onSubmitted(); }
    } catch (reason) { setError(`${describe(reason)} Check the saved submission before trying another proposal.`); }
    finally { setBusy(false); }
  };
  const discard = async () => {
    setBusy(true); setError(null);
    try { await invoke("sns_delete_draft_v1", { draftId: draft.id }); onDiscarded(); }
    catch (reason) { setError(describe(reason)); }
    finally { setBusy(false); }
  };
  const payload = nativeAction(draft);
  const confirmed = result ? confirmedProposalId(result) : undefined;
  return <section className="nt-section snsgov-review">
    <header className="nt-section-header snsgov-proposal-toolbar"><h2 className="nt-section-heading">Review draft</h2><div className="nt-cluster"><button className="nt-button nt-button--ghost" type="button" onClick={onClose}>Close</button>{!started && <button className="nt-button nt-button--ghost" type="button" disabled={busy} onClick={() => setDiscarding(true)}>Discard draft</button>}</div></header>
    {error && <ErrorNote message={error} />}
    {discarding && <div className="nt-alert nt-alert--warning"><p>Discard this saved draft?</p><div className="nt-cluster"><button type="button" className="nt-button" disabled={busy} onClick={() => void discard()}>Discard</button><button type="button" className="nt-button nt-button--ghost" disabled={busy} onClick={() => setDiscarding(false)}>Keep draft</button></div></div>}
    {result && <ProposalReceipt result={result} />}
    <article className="snsgov-proposal">
      <div className="snsgov-post-byline"><SnsLogo name={name} logo={metadata.data?.metadata?.logo} size={28} /><span className="snsgov-post-community">{name}</span></div>
      <h3 className="nt-title snsgov-proposal-title">{draft.title || "Untitled proposal"}</h3>
      <p className="nt-meta">{draftActionLabel(draft)}</p>
      <p className="snsgov-proposal-body">{draft.summary}</p>
      {safeExternalUrl(draft.url) && <a href={safeExternalUrl(draft.url)} target="_blank" rel="noopener noreferrer">Supporting information ↗</a>}
      {draft.motionText !== undefined && <><h4 className="nt-section-title">Motion</h4><p className="snsgov-proposal-body">{draft.motionText}</p></>}
      {draft.rendering !== undefined && <><h4 className="nt-section-title">Proposed change</h4><pre className="nt-pre nt-pre--wrap snsgov-readable-payload">{draft.rendering}</pre></>}
      {payload !== undefined && <><h4 className="nt-section-title">Proposed change</h4><pre className="nt-pre nt-pre--wrap snsgov-readable-payload">{JSON.stringify(payload, null, 2)}</pre></>}
    </article>
    {confirmed === undefined && <>
      {cost !== undefined && <p className="nt-text">Cost if rejected: <strong>{token ? `${formatTokenAmount(cost, token.decimals)} ${token.symbol}` : `${cost} atoms`}</strong> <Help label="Cost if rejected">This amount is charged to the proposing neuron's fee balance when the proposal is submitted. Adoption restores the rejection cost; rejection keeps the charge.</Help></p>}
      {parameters.error && <p className="nt-meta">The rejection cost could not be read. The final submission preview checks current parameters.</p>}
      {access.loading && <Pending label="Finding neurons that may propose" />}
      {access.error && <><ErrorNote message={access.error} /><button type="button" className="nt-button nt-button--ghost" disabled={access.loading} onClick={() => setRefresh(value => value + 1)}>Retry proposer lookup</button></>}
      {access.data && !eligible.length && <p className="nt-alert nt-alert--warning">No connected neuron grants SubmitProposal permission on this community. Add proposal access in the wallet that controls a neuron, then check again.</p>}
      {eligible.length > 0 && <label className="snsgov-field" htmlFor="snsgov-proposer"><span>Neuron to propose with</span><select className="nt-select" id="snsgov-proposer" aria-label="Neuron to propose with" value={neuronId} disabled={busy || started} onChange={event => setNeuronId(event.target.value)}><option value="">Choose a neuron…</option>{eligible.map(neuron => <option key={neuron.neuronId} value={neuron.neuronId}>Neuron {shortenId(neuron.neuronId, 10, 6)} · Can propose</option>)}</select></label>}
      {access.data?.truncated && <p className="nt-meta snsgov-warning">Neuron discovery is incomplete; more eligible proposers may exist.</p>}
      <p className="nt-meta">Submitting puts this proposal on-chain. Review its exact contents and consequences before approving.</p>
      <button className="nt-button" type="button" disabled={busy || (!started && !ready)} onClick={() => void submit(started)}>{busy ? "Checking submission…" : started ? "Check saved submission" : "Review and submit"}</button>
      {started && <button className="nt-button nt-button--ghost" type="button" disabled={busy} onClick={() => void submit()}>Continue saved submission</button>}
    </>}
    <Disclosure title="Draft details and original payload"><dl className="nt-detail-grid"><div className="nt-detail"><dt>Draft ID</dt><dd>{draft.id}</dd></div><div className="nt-detail"><dt>Created by</dt><dd>{draft.createdBy}</dd></div><div className="nt-detail"><dt>Updated</dt><dd><ProposalTime seconds={draft.updatedAtSeconds} /></dd></div><div className="nt-detail"><dt>Community root</dt><dd className="snsgov-wrap-anywhere">{draft.sns}</dd></div>{draft.functionId !== undefined && <div className="nt-detail"><dt>Function ID</dt><dd>{draft.functionId.toString()}</dd></div>}</dl>{draft.payload && <pre className="nt-pre nt-pre--wrap">{toHex(draft.payload)}</pre>}</Disclosure>
  </section>;
}
function nativeAction(draft: DraftRow): unknown {
  if (draft.actionKind !== "NativeActionV1" || !draft.payload) return undefined;
  try { return proposalActionToJson(decodeProposalAction(draft.payload)); } catch { return undefined; }
}
function draftActionLabel(draft: DraftRow) { const action = nativeAction(draft); return action && typeof action === "object" ? actionLabel(Object.keys(action)[0] ?? draft.actionKind) : actionLabel(draft.actionKind); }
function describe(reason: unknown) { return reason instanceof Error ? reason.message : String(reason); }
