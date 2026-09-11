import { useCallback, useEffect, useRef, useState } from "react";
import { querySelf } from "neutron-tools/app";
import { invoke, operationId } from "../data/actions_client";
import { getProposal } from "../data/governance";
import { shortenId } from "../data/format";
import { readHotkey } from "../data/relay";
import { isAlreadyVoted } from "../data/manage_neuron";
import { buildVotePlan } from "../data/voting";
import type { RegistryEntry } from "../data/registry";
import type { Ballot, ProposalSummary } from "../data/types";
import { Disclosure, ErrorNote, Help } from "./Common";

interface VoteRead {
  eligibleNeuronIds: string[];
  alreadyVotedNeuronIds: string[];
  acceptsVotes: boolean;
  alreadyVoted: { neuronId: string; vote: number }[];
  excludedNeurons: { neuronId: string; reason: string }[];
  discoveryComplete: boolean;
  failures: { scope: string; message: string }[];
}
interface VoteOutcome {
  neuronId: string; ok: boolean; reconciled?: boolean; alreadyVoted?: boolean; outcomeUnknown?: boolean; error?: string;
}
interface VoteReply {
  operationId?: string; status?: string; outcomes?: VoteOutcome[]; error?: string; message?: string;
  unattemptedNeuronIds?: string[]; outcomeUnknownNeuronIds?: string[];
  alreadyVoted?: { neuronId: string; vote: number }[];
}
interface VoteReceipt {
  id: string; adopt: boolean; selected: string[]; reply: VoteReply; ballots: Ballot[]; ballotError?: string;
}

/** Same vote controls in a cross-SNS post and in the full proposal article. */
export function VoteControls({ entry, proposal, eager = false, onChanged }: {
  entry: RegistryEntry; proposal: ProposalSummary; eager?: boolean; onChanged?: () => void;
}) {
  const [visible, setVisible] = useState(eager);
  const [plan, setPlan] = useState<VoteRead | null>(null);
  const [signingNote, setSigningNote] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<VoteReceipt | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const dispatching = useRef(false);
  const latestOnChanged = useRef(onChanged);
  latestOnChanged.current = onChanged;

  useEffect(() => {
    if (visible) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(rows => {
      if (rows.some(row => row.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "160px" });
    if (anchor.current) observer.observe(anchor.current);
    return () => observer.disconnect();
  }, [visible]);

  const load = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true); setError(null);
    try {
      const [hotkey, config] = await Promise.all([
        readHotkey(), querySelf("snsgov_config", [null]) as Promise<unknown>,
      ]);
      const row = (config as { snses?: { sns?: string | { toText(): string }; voting_enabled?: boolean }[] })?.snses?.find(row => String(typeof row.sns === "object" ? row.sns.toText() : row.sns) === entry.canisters.root);
      const votingEnabled = row?.voting_enabled === true;
      const result = await buildVotePlan({
        rootCanisterId: entry.canisters.root, governanceCanisterId: entry.canisters.governance,
        proposalId: proposal.id, votingPrincipal: hotkey.principal, canSign: hotkey.canManageNeuron,
        votingEnabled,
      });
      if (request !== generation.current) return;
      setPlan(result as VoteRead);
      setSigningNote(!hotkey.canManageNeuron ? "Voting needs the Neutron's signing connection. Check Settings to enable it." : null);
      // Explicit subsets only lose eligibility; a refresh never adds a neuron.
      setSelected(current => current === null ? null : current.filter(id => result.eligibleNeuronIds.includes(id)));
    } catch (reason) { if (request === generation.current) setError(describe(reason)); }
    finally { if (request === generation.current) setLoading(false); }
  }, [entry.canisters.root, entry.canisters.governance, proposal.id]);

  useEffect(() => {
    if (visible) void load();
    return () => { generation.current++; };
  }, [visible, load]);

  const eligible = plan?.eligibleNeuronIds ?? [];
  const chosen = selected === null ? eligible : selected.filter(id => eligible.includes(id));
  const pending = receipt?.reply.status === "pending" || receipt?.reply.status === "prepared" || receipt?.reply.outcomeUnknownNeuronIds?.length || receipt?.selected.some(id => {
    const result = receipt.reply.outcomes?.find(outcome => outcome.neuronId === id);
    return result?.outcomeUnknown || (!result && !receipt.reply.unattemptedNeuronIds?.includes(id));
  });

  const readReceipt = async (id: string, adopt: boolean, ids: string[], reply: VoteReply) => {
    try {
      const detail = await getProposal(entry.canisters.governance, proposal.id);
      setReceipt({ id, adopt, selected: ids, reply, ballots: detail?.ballots ?? [], ...(detail ? {} : { ballotError: "The proposal's ballots are unavailable." }) });
    } catch (reason) { setReceipt({ id, adopt, selected: ids, reply, ballots: [], ballotError: describe(reason) }); }
  };

  const vote = async (adopt: boolean) => {
    if (dispatching.current || chosen.length === 0 || pending) return;
    dispatching.current = true; setBusy(true); setError(null);
    const ids = [...chosen];
    const id = operationId();
    setReceipt({ id, adopt, selected: ids, reply: { status: "pending" }, ballots: [] });
    try {
      const raw = await invoke<unknown>("sns_vote", {
        rootCanisterId: entry.canisters.root, proposalId: proposal.id.toString(),
        adopt, neuronIds: ids, operationId: id,
      });
      await readReceipt(id, adopt, ids, normalizeReply(raw, ids));
    } catch (reason) {
      await readReceipt(id, adopt, ids, { status: "pending", error: `${describe(reason)} The saved operation must be checked before sending another vote.`, outcomeUnknownNeuronIds: ids });
    } finally {
      dispatching.current = false; setBusy(false); void load(); latestOnChanged.current?.();
    }
  };

  const reconcile = async (continueSaved = false) => {
    if (!receipt || dispatching.current) return;
    dispatching.current = true; setBusy(true); setError(null);
    try {
      const raw = await invoke<unknown>(continueSaved ? "sns_continue_v1" : "sns_operation_status_v1", { operationId: receipt.id });
      await readReceipt(receipt.id, receipt.adopt, receipt.selected, normalizeReply(raw, receipt.selected));
    } catch (reason) { setError(describe(reason)); }
    finally { dispatching.current = false; setBusy(false); void load(); }
  };

  return <div className="snsgov-vote" ref={anchor}>
    {!visible || (!plan && loading) ? <p className="nt-meta" role="status">Checking your eligible neurons…</p> : null}
    {error && <><ErrorNote message={error} /><button type="button" className="nt-button nt-button--ghost" disabled={loading || busy} onClick={() => void load()}>Retry voting access</button></>}
    {plan && <>
      {!plan.discoveryComplete && <p className="nt-meta snsgov-warning">Neuron discovery is incomplete. Only the neurons found so far are included.</p>}
      {plan.failures?.map(failure => <p className="nt-meta snsgov-warning" key={`${failure.scope}:${failure.message}`}>{failure.message}</p>)}
      {signingNote && <p className="nt-meta">{signingNote}</p>}
      {eligible.length > 0 && plan.acceptsVotes && <>
        <Disclosure title={selected === null ? `All ${eligible.length} eligible neuron${eligible.length === 1 ? "" : "s"}` : `${chosen.length} of ${eligible.length} neurons selected`}>
          <p className="nt-meta">Choose which neurons cast this vote. <Help label="Eligible neurons">A neuron needs Vote permission and an uncast ballot in this proposal. New neurons do not receive ballots for proposals created before they became eligible.</Help></p>
          <div className="nt-cluster">
            <button type="button" className="nt-button nt-button--ghost" disabled={busy} onClick={() => setSelected(null)}>Select all eligible</button>
            <button type="button" className="nt-button nt-button--ghost" disabled={busy} onClick={() => setSelected([])}>Clear selection</button>
          </div>
          <fieldset className="snsgov-neuron-selection" disabled={busy}>
            <legend className="nt-sr-only">Neurons for this proposal</legend>
            {eligible.map(id => <label key={id}><input type="checkbox" checked={chosen.includes(id)} onChange={event => setSelected(current => {
              const before = current ?? eligible;
              return event.target.checked ? [...new Set([...before, id])] : before.filter(value => value !== id);
            })} /><span>Neuron <code title={id}>{shortenId(id, 10, 6)}</code></span><span className="nt-meta">Not voted</span></label>)}
          </fieldset>
        </Disclosure>
        <div className="snsgov-vote-buttons">
          <button type="button" className="nt-button snsgov-vote-yes" disabled={busy || !!pending || !!signingNote || chosen.length === 0} onClick={() => void vote(true)} aria-label={`Vote Yes with ${chosen.length} neuron${chosen.length === 1 ? "" : "s"}`}>Yes</button>
          <button type="button" className="nt-button nt-button--secondary snsgov-vote-no" disabled={busy || !!pending || !!signingNote || chosen.length === 0} onClick={() => void vote(false)} aria-label={`Vote No with ${chosen.length} neuron${chosen.length === 1 ? "" : "s"}`}>No</button>
          <span className="nt-meta">{busy ? "Recording votes…" : `With ${chosen.length} selected neuron${chosen.length === 1 ? "" : "s"}`}</span>
        </div>
      </>}
      {!plan.acceptsVotes && <p className="nt-meta">Voting has closed.</p>}
      {plan.acceptsVotes && eligible.length === 0 && <p className="nt-meta">{plan.alreadyVoted.length ? "Your eligible neurons have already voted." : "No connected neuron has an uncast ballot for this proposal."}</p>}
      {!!plan.alreadyVoted.length && <Disclosure title={`Already voted (${plan.alreadyVoted.length})`}>
        <ul className="snsgov-ballot-list">{plan.alreadyVoted.map(ballot => <li key={ballot.neuronId}><code title={ballot.neuronId}>{shortenId(ballot.neuronId, 10, 6)}</code><span>Already voted {voteName(ballot.vote)}</span></li>)}</ul>
      </Disclosure>}
      {!!plan.excludedNeurons.length && <Disclosure title={`Other connected neurons (${plan.excludedNeurons.length})`}>
        <ul className="snsgov-ballot-list">{plan.excludedNeurons.map(neuron => <li key={neuron.neuronId}><code title={neuron.neuronId}>{shortenId(neuron.neuronId, 10, 6)}</code><span>{({ "no-vote-permission": "No Vote permission", "no-ballot": "No ballot in this proposal", "deadline-passed": "Voting has closed" } as Record<string, string>)[neuron.reason] ?? neuron.reason}</span></li>)}</ul>
      </Disclosure>}
    </>}
    {receipt && <VoteResults receipt={receipt} busy={busy} pending={!!pending} onReconcile={() => void reconcile()} onContinue={() => void reconcile(true)} />}
  </div>;
}

function VoteResults({ receipt, busy, pending, onReconcile, onContinue }: { receipt: VoteReceipt; busy: boolean; pending: boolean; onReconcile: () => void; onContinue: () => void }) {
  const requested = receipt.adopt ? "Yes" : "No";
  const rows = receipt.selected.map(id => {
    const outcome = receipt.reply.outcomes?.find(value => value.neuronId === id);
    const ballot = receipt.ballots.find(value => value.neuronId === id);
    const recordedVote = ballot?.vote || receipt.reply.alreadyVoted?.find(value => value.neuronId === id)?.vote;
    const actual = recordedVote === 1 || recordedVote === 2 ? voteName(recordedVote) : undefined;
    let label: string;
    let recorded = false;
    if (outcome?.alreadyVoted) label = `Already voted ${actual ?? "— choice not yet known"}`;
    else if (outcome?.reconciled) label = actual ? `Ballot is ${actual} — checked` : "Reconciled — refreshing ballot";
    else if (outcome?.ok && !outcome.outcomeUnknown) {
      recorded = !actual || actual === requested;
      label = actual && actual !== requested ? `Ballot is ${actual}; requested ${requested}` : `${requested} ${actual ? "recorded" : "accepted — checking ballot"}`;
    } else if (receipt.reply.unattemptedNeuronIds?.includes(id)) label = actual ? `Not sent; ballot is ${actual}` : "Not sent";
    else if (outcome?.outcomeUnknown || !outcome || receipt.reply.outcomeUnknownNeuronIds?.includes(id)) label = actual ? `Ballot is ${actual}; operation result unknown` : "Result unknown — check saved operation";
    else label = actual ? `Could not record ${requested}; ballot is ${actual}` : "Could not vote";
    return { id, label, recorded, already: !!outcome?.alreadyVoted, error: outcome?.error };
  });
  return <div className="snsgov-vote-result" aria-live="polite">
    <p className="nt-text" role="status">{busy ? "Checking the saved vote operation…" : `${requested} accepted for ${rows.filter(row => row.recorded).length} · ${rows.filter(row => row.already).length} already voted · ${rows.filter(row => !row.recorded && !row.already).length} need attention`}</p>
    {(receipt.reply.error || receipt.reply.message) && <ErrorNote message={receipt.reply.error ?? receipt.reply.message} />}
    {receipt.ballotError && <p className="nt-meta">Ballots could not be refreshed: {receipt.ballotError}</p>}
    <Disclosure title="Per-neuron results" open={pending || rows.some(row => !row.recorded)}>
      <ul className="snsgov-ballot-list">{rows.map(row => <li key={row.id}><code title={row.id}>{shortenId(row.id, 10, 6)}</code><span>{row.label}</span>{row.error && <small>{row.error}</small>}</li>)}</ul>
      <p className="nt-meta snsgov-wrap-anywhere">Operation {receipt.id}</p>
    </Disclosure>
    {!!receipt.reply.unattemptedNeuronIds?.length && receipt.reply.status !== "not_required" && <button type="button" className="nt-button" disabled={busy} onClick={onContinue}>Continue unsent votes</button>}
    {(pending || receipt.ballotError) && <button type="button" className="nt-button nt-button--ghost" disabled={busy} onClick={onReconcile}>Check saved vote result</button>}
  </div>;
}
const voteName = (vote: number) => vote === 1 ? "Yes" : vote === 2 ? "No" : "— choice unknown";
const describe = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Preserve protocol evidence from the journal's public result projection. */
function normalizeReply(raw: unknown, selected: string[]): VoteReply {
  const value = raw as { operationId?: string; status?: string; message?: string; error?: string;
    outcomes?: { neuronId: string; status: string; outcome?: Parameters<typeof isAlreadyVoted>[0]; message?: string }[];
    alreadyVoted?: { neuronId: string; vote: number }[]; unknownNeuronIds?: string[]; unattemptedNeuronIds?: string[] };
  const outcomes: VoteOutcome[] = (value.outcomes ?? []).map(row => ({
    neuronId: row.neuronId, ok: row.status === "succeeded" && row.outcome?.ok === true,
    alreadyVoted: row.outcome ? isAlreadyVoted(row.outcome) : false,
    reconciled: row.status === "reconciled", outcomeUnknown: row.status === "unknown",
    ...(row.outcome?.errorMessage || row.message ? { error: row.outcome?.errorMessage ?? row.message! } : {}),
  }));
  for (const ballot of value.alreadyVoted ?? []) if (!outcomes.some(row => row.neuronId === ballot.neuronId)) outcomes.push({ neuronId: ballot.neuronId, ok: false, alreadyVoted: true });
  return { ...value, outcomes,
    outcomeUnknownNeuronIds: value.unknownNeuronIds ?? [],
    unattemptedNeuronIds: value.status === "not_required" ? selected.filter(id => !outcomes.some(row => row.neuronId === id)) : value.unattemptedNeuronIds ?? [],
  };
}
