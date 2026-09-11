import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { copyToClipboard } from "neutron-tools/app";
import { formatTokenAmount, shortenId } from "../data/format";
import { getProposal, listProposals } from "../data/governance";
import { displayName, type RegistryEntry } from "../data/registry";
import type { ProposalDetail, ProposalStatus, ProposalSummary } from "../data/types";
import { Disclosure, ErrorNote, Help } from "./Common";
import { SnsLogo } from "./Logo";
import { Empty, Pending } from "./Status";
import { VoteControls } from "./ProposalVote";
import { ProposalCreate } from "./ProposalCreate";

export { FeedView } from "./Feed";

const STATUS_TONE: Record<ProposalStatus, string> = {
  open: "nt-badge--info", adopted: "nt-badge--success", executed: "nt-badge--success",
  rejected: "nt-badge--warning", failed: "nt-badge--danger", unknown: "",
};

export function actionLabel(kind: string): string {
  const labels: Record<string, string> = {
    Motion: "Motion", ManageNervousSystemParameters: "Governance settings",
    ManageSnsMetadata: "Community details", TransferSnsTreasuryFunds: "Treasury transfer",
    MintSnsTokens: "Mint tokens", ExecuteGenericNervousSystemFunction: "Community action",
    UpgradeSnsToNextVersion: "Upgrade SNS", UpgradeSnsControlledCanister: "Upgrade canister",
    AddGenericNervousSystemFunction: "Add proposal type", RemoveGenericNervousSystemFunction: "Remove proposal type",
  };
  return labels[kind] ?? kind.replace(/([a-z])([A-Z])/g, "$1 $2");
}

export function acceptsVotes(proposal: ProposalSummary): boolean {
  // A decision can precede the end of the voting window, including a rejection.
  const projected = proposal as ProposalSummary & { acceptsVotes?: boolean };
  if (projected.acceptsVotes !== undefined) return projected.acceptsVotes;
  return proposal.deadlineSeconds !== undefined
    ? proposal.deadlineSeconds > BigInt(Math.floor(Date.now() / 1000))
    : proposal.status === "open";
}

export function ProposalsView({ entry, initialProposalId }: {
  entry: RegistryEntry; initialProposalId?: bigint | undefined;
}) {
  const [proposals, setProposals] = useState<ProposalSummary[] | null>(null);
  const [nextBefore, setNextBefore] = useState<bigint>();
  const [openId, setOpenId] = useState<bigint | null>(initialProposalId ?? null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const backTarget = useRef<HTMLButtonElement | null>(null);
  const listScroll = useRef(0);

  const load = useCallback(async (before?: bigint) => {
    const request = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      const page = await listProposals(entry.canisters.governance, {
        limit: 25, ...(before === undefined ? {} : { beforeProposal: before }),
      });
      if (request !== generation.current) return;
      setProposals(old => before === undefined ? page.proposals : mergeProposals(old ?? [], page.proposals));
      setNextBefore(page.nextBefore);
    } catch (reason) {
      if (request === generation.current) setError(describe(reason));
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }, [entry.canisters.governance]);

  useEffect(() => {
    setProposals(null);
    setNextBefore(undefined);
    void load();
    return () => { generation.current++; };
  }, [load]);
  useEffect(() => { setOpenId(initialProposalId ?? null); }, [initialProposalId, entry.canisters.root]);

  const back = () => {
    setOpenId(null);
    requestAnimationFrame(() => {
      backTarget.current?.focus({ preventScroll: true });
      const owner = listRef.current?.closest<HTMLElement>(".snsgov-content, .nt-page-main");
      if (owner) owner.scrollTop = listScroll.current;
    });
  };

  return <section className="nt-section snsgov-proposals">
    <div hidden={openId !== null} ref={listRef}>
      <header className="nt-section-header snsgov-proposal-toolbar">
        <h2 className="nt-section-heading">Proposals</h2>
        <div className="nt-cluster">
          <button type="button" className="nt-button nt-button--ghost" disabled={busy} onClick={() => void load()}>{busy ? "Refreshing…" : "Refresh proposals"}</button>
          <button type="button" className="nt-button" onClick={() => setCreating(true)}>Create proposal</button>
        </div>
      </header>
      {error && <ErrorNote message={error} />}
      {proposals === null && !error && <Pending label="Reading proposals" />}
      {proposals?.length === 0 && <Empty label="This community has no proposals yet." />}
      <div className="snsgov-feed-posts">
        {proposals?.map(proposal => <ProposalPost key={proposal.id.toString()} entry={entry} proposal={proposal} onOpen={button => {
          backTarget.current = button;
          listScroll.current = listRef.current?.closest<HTMLElement>(".snsgov-content, .nt-page-main")?.scrollTop ?? 0;
          setOpenId(proposal.id);
        }} />)}
      </div>
      {nextBefore !== undefined && <button type="button" className="nt-button snsgov-more" disabled={busy} onClick={() => void load(nextBefore)}>{busy ? "Loading…" : "Load more"}</button>}
    </div>
    {openId !== null && <ProposalDetailView key={`${entry.canisters.root}:${openId}`} entry={entry} proposalId={openId} onBack={back} />}
    {creating && <ProposalCreate entry={entry} onClose={() => setCreating(false)} onCreated={id => { setCreating(false); if (id !== undefined) setOpenId(id); void load(); }} />}
  </section>;
}

function mergeProposals(a: ProposalSummary[], b: ProposalSummary[]): ProposalSummary[] {
  return [...new Map([...a, ...b].map(p => [p.id.toString(), p])).values()];
}

export function ProposalPost({ entry, proposal, onOpen, onOpenSns }: {
  entry: RegistryEntry; proposal: ProposalSummary;
  onOpen: (button: HTMLButtonElement) => void; onOpenSns?: ((entry: RegistryEntry) => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const summaryIsLong = proposal.summary.length > 360;
  return <article className="snsgov-post" aria-label={`${displayName(entry)} proposal ${proposal.id}`}>
    <div className="snsgov-post-byline">
      <SnsLogo logo={entry.metadata?.logo} name={displayName(entry)} size={28} />
      {onOpenSns
        ? <button type="button" className="snsgov-post-community snsgov-link" onClick={() => onOpenSns(entry)}>{displayName(entry)}</button>
        : <span className="snsgov-post-community">{displayName(entry)}</span>}
      <span className="nt-meta">#{proposal.id.toString()} · <ProposalTime seconds={proposal.createdAtSeconds} relative /></span>
    </div>
    <h3 className="snsgov-post-title"><button type="button" className="snsgov-link" onClick={event => onOpen(event.currentTarget)}>{proposal.title || "Untitled proposal"}</button></h3>
    <div className="snsgov-post-meta"><ProposalStatusBadge proposal={proposal} /><span className="nt-meta">{actionLabel(proposal.actionKind)}</span></div>
    {proposal.summary && <p className={`snsgov-proposal-body${summaryIsLong && !expanded ? " snsgov-post-excerpt" : ""}`}>{summaryIsLong && !expanded ? `${proposal.summary.slice(0, 360)}…` : proposal.summary}</p>}
    {summaryIsLong && <button type="button" className="nt-button nt-button--ghost snsgov-show-more" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? "Show less" : "Show more"}</button>}
    {proposal.tally && <Tally {...proposal.tally} />}
    <VoteControls entry={entry} proposal={proposal} />
  </article>;
}

export function ProposalStatusBadge({ proposal }: { proposal: ProposalSummary }) {
  return <><span className={`nt-badge ${STATUS_TONE[proposal.status]}`}>{proposal.status}</span>
    {proposal.status !== "open" && acceptsVotes(proposal) && <span className="nt-meta">Voting still available</span>}</>;
}

export function ProposalDetailView({ entry, proposalId, onBack }: {
  entry: RegistryEntry; proposalId: bigint; onBack: () => void;
}) {
  const [detail, setDetail] = useState<ProposalDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const load = useCallback(async () => {
    const request = ++generation.current;
    setBusy(true); setError(null);
    try {
      const result = await getProposal(entry.canisters.governance, proposalId);
      if (request === generation.current) {
        if (result) setDetail(result);
        else setError("This proposal was not found in the community's governance canister.");
      }
    } catch (reason) { if (request === generation.current) setError(describe(reason)); }
    finally { if (request === generation.current) setBusy(false); }
  }, [entry.canisters.governance, proposalId]);
  useEffect(() => {
    setDetail(null); void load(); heading.current?.focus();
    return () => { generation.current++; };
  }, [load]);
  return <section className="nt-section snsgov-proposal-detail">
    <header className="nt-section-header snsgov-proposal-toolbar">
      <button type="button" className="nt-button nt-button--ghost" onClick={onBack} aria-label="Back to the proposal list">Back</button>
      <h2 className="nt-section-heading" tabIndex={-1} ref={heading}>Proposal {proposalId.toString()}</h2>
      <button type="button" className="nt-button nt-button--ghost" disabled={busy} onClick={() => void load()}>{busy ? "Refreshing…" : "Refresh"}</button>
    </header>
    {error && <ErrorNote message={error} />}
    {detail === null && !error && <Pending label="Reading proposal" />}
    {detail && <>
      <div className="snsgov-post-byline"><SnsLogo logo={entry.metadata?.logo} name={displayName(entry)} size={28} /><span>{displayName(entry)}</span></div>
      <h3 className="nt-title snsgov-proposal-title">{detail.title || "Untitled proposal"}</h3>
      <div className="snsgov-post-meta"><ProposalStatusBadge proposal={detail} /><span>{actionLabel(detail.actionKind)}</span></div>
      {detail.summary && <p className="snsgov-proposal-body">{detail.summary}</p>}
      {safeExternalUrl(detail.url) && <p className="nt-text"><a href={safeExternalUrl(detail.url)} target="_blank" rel="noopener noreferrer">Read supporting information ↗</a></p>}
      {detail.tally && <Tally {...detail.tally} />}
      {detail.deadlineSeconds !== undefined && <p className="nt-meta">Voting closes <ProposalTime seconds={detail.deadlineSeconds} /> <Help label="Voting deadline">A proposal may be decided while voting remains available for rewards. Late votes can extend this deadline under the community's rules.</Help></p>}
      <div className="snsgov-detail-voting"><VoteControls entry={entry} proposal={detail} eager onChanged={() => void load()} /></div>
      {detail.payloadTextRendering && <section className="snsgov-prose"><h4 className="nt-section-title">Proposed change</h4><pre className="nt-pre nt-pre--wrap snsgov-readable-payload">{detail.payloadTextRendering}</pre></section>}
      <Disclosure title="Voting rules and proposal details">
        <dl className="nt-detail-grid">
          <DetailRow label="Created" value={<ProposalTime seconds={detail.createdAtSeconds} />} />
          {detail.topic && <DetailRow label="Topic" value={detail.topic} />}
          {detail.executedAtSeconds !== undefined && <DetailRow label="Executed" value={<ProposalTime seconds={detail.executedAtSeconds} />} />}
          {detail.rejectCostE8s !== undefined && <DetailRow label="Cost if rejected" value={entry.token ? `${formatTokenAmount(detail.rejectCostE8s, entry.token.decimals, { group: false })} ${entry.token.symbol}` : `${detail.rejectCostE8s} atoms`} />}
          {detail.proposerNeuronId && <DetailRow label="Proposer neuron" value={detail.proposerNeuronId} />}
          <DetailRow label="Ballots" value={`${detail.ballots.filter(ballot => ballot.vote !== 0).length} cast of ${detail.ballots.length} eligible`} />
          {detail.minimumYesProportionOfTotal !== undefined && <DetailRow label="Minimum Yes share of total power" value={`${Number(detail.minimumYesProportionOfTotal) / 100}%`} />}
          {detail.minimumYesProportionOfExercised !== undefined && <DetailRow label="Minimum Yes share of votes cast" value={`${Number(detail.minimumYesProportionOfExercised) / 100}%`} />}
          <DetailRow label="SNS root" value={entry.canisters.root} />
          <DetailRow label="Action" value={detail.actionKind} />
        </dl>
        <button type="button" className="nt-button nt-button--ghost" onClick={() => void copyToClipboard(proposalId.toString())}>Copy proposal id</button>
        {detail.url && !safeExternalUrl(detail.url) && <p className="nt-meta snsgov-wrap-anywhere">Reference: {detail.url}</p>}
      </Disclosure>
      <Disclosure title={`Ballot details (${detail.ballots.length})`}>
        <ul className="snsgov-ballot-list">{detail.ballots.map(ballot => <li key={ballot.neuronId}><code title={ballot.neuronId}>{shortenId(ballot.neuronId, 10, 6)}</code><span>{ballot.vote === 1 ? "Yes" : ballot.vote === 2 ? "No" : "Not voted"}</span><span className="nt-meta">{ballot.votingPower.toLocaleString()} voting power</span></li>)}</ul>
      </Disclosure>
    </>}
  </section>;
}

export function Tally({ yes, no, total }: { yes: bigint; no: bigint; total: bigint }) {
  const pct = (value: bigint) => total === 0n ? 0 : Number((value * 10_000n) / total) / 100;
  return <div className="snsgov-tally" aria-label={`Yes ${pct(yes).toFixed(1)} percent, No ${pct(no).toFixed(1)} percent of total voting power`}>
    <div className="snsgov-tally-bar" aria-hidden="true"><span className="snsgov-tally-yes" style={{ width: `${Math.min(100, pct(yes))}%` }} /><span className="snsgov-tally-no" style={{ width: `${Math.min(100, pct(no))}%` }} /></div>
    <p className="nt-meta">Yes {pct(yes).toFixed(1)}% · No {pct(no).toFixed(1)}% of total voting power</p>
  </div>;
}
function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return <div className="nt-detail"><dt className="nt-detail-label">{label}</dt><dd className="nt-detail-value snsgov-wrap-anywhere">{value}</dd></div>;
}
export function safeExternalUrl(value: string): string | undefined {
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
function describe(error: unknown) { return error instanceof Error ? error.message : String(error); }

export function proposalDate(seconds: bigint, relative = false): string {
  const milliseconds = Number(seconds) * 1000;
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime()) || seconds <= 0n) return "Unknown date";
  const ago = Math.round((milliseconds - Date.now()) / 1000);
  if (relative && Math.abs(ago) < 86400) return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round(ago / (Math.abs(ago) < 3600 ? 60 : 3600)), Math.abs(ago) < 3600 ? "minute" : "hour");
  return new Intl.DateTimeFormat(undefined, relative ? { month: "short", day: "numeric", ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }) } : { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function ProposalTime({ seconds, relative = false }: { seconds: bigint; relative?: boolean }) {
  const date = new Date(Number(seconds) * 1000);
  if (seconds <= 0n || !Number.isFinite(date.getTime())) return <span>Unknown date</span>;
  const exact = date.toISOString();
  return <time dateTime={exact} title={exact}>{proposalDate(seconds, relative)}</time>;
}
