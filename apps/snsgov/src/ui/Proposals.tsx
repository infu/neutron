import { useCallback, useEffect, useState } from "react";
import { copyToClipboard } from "neutron-tools/app";
import { SnsError } from "../data/errors";
import { formatTimestamp, formatTokenAmount, shortenId } from "../data/format";
import { getProposal, listProposals } from "../data/governance";
import type { RegistryEntry } from "../data/registry";
import type { ProposalDetail, ProposalStatus, ProposalSummary } from "../data/types";
import { IconButton } from "./IconButton";
import { rowProps } from "./Row";
import { BusyOr, Empty, Pending } from "./Status";
import { BackIcon, CopyIcon, RefreshIcon } from "./Icons";

const STATUS_TONE: Record<ProposalStatus, string> = {
  open: "nt-badge--info",
  adopted: "nt-badge--success",
  executed: "nt-badge--success",
  rejected: "nt-badge--warning",
  failed: "nt-badge--danger",
  unknown: "",
};

type State =
  | { phase: "loading" }
  | { phase: "ready"; proposals: ProposalSummary[]; nextBefore?: bigint }
  | { phase: "error"; message: string };

export function ProposalsView({
  entry,
  initialProposalId,
}: {
  entry: RegistryEntry;
  /** Opened straight to this proposal — how an agent points at one. */
  initialProposalId?: bigint | undefined;
}) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [openId, setOpenId] = useState<bigint | null>(initialProposalId ?? null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Separate from `state`: wiping to `phase: "loading"` on every refresh blanks
  // the table and then reflows it back, which is the flicker. The rows stay put
  // and a hairline says work is happening.
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const page = await listProposals(entry.canisters.governance, { limit: 25 });
      setState({
        phase: "ready",
        proposals: page.proposals,
        ...(page.nextBefore === undefined ? {} : { nextBefore: page.nextBefore }),
      });
    } catch (error) {
      setState({ phase: "error", message: describe(error) });
    } finally {
      setBusy(false);
    }
  }, [entry.canisters.governance]);

  useEffect(() => {
    void load();
  }, [load]);

  // A later request for a different proposal must retarget an open view.
  useEffect(() => {
    setOpenId(initialProposalId ?? null);
  }, [initialProposalId]);

  const loadMore = useCallback(async () => {
    if (state.phase !== "ready" || state.nextBefore === undefined) return;
    setLoadingMore(true);
    try {
      const page = await listProposals(entry.canisters.governance, {
        limit: 25,
        beforeProposal: state.nextBefore,
      });
      setState({
        phase: "ready",
        proposals: [...state.proposals, ...page.proposals],
        ...(page.nextBefore === undefined ? {} : { nextBefore: page.nextBefore }),
      });
    } catch (error) {
      setState({ phase: "error", message: describe(error) });
    } finally {
      setLoadingMore(false);
    }
  }, [entry.canisters.governance, state]);

  if (openId !== null) {
    return (
      <ProposalDetailView
        key={`${entry.canisters.governance}:${openId}`}
        entry={entry}
        onBack={() => setOpenId(null)}
        proposalId={openId}
      />
    );
  }

  return (
    <section className="nt-section">
      <header className="nt-section-header">
        <h2 className="nt-section-heading">Proposals</h2>
        {state.phase === "ready" && (
          <span className="nt-section-count">{state.proposals.length}</span>
        )}
        <span className="snsgov-spacer" />
        <IconButton disabled={busy} label="Refresh proposals" onClick={() => void load()}>
          <BusyOr busy={busy}>
            <RefreshIcon />
          </BusyOr>
        </IconButton>
      </header>

      {state.phase === "loading" && <Pending label="Reading proposals" />}
      {state.phase === "error" && (
        <div className="nt-alert nt-alert--danger" role="alert">
          {state.message}
        </div>
      )}
      {state.phase === "ready" && state.proposals.length === 0 && (
        <Empty label="This SNS has no proposals yet." />
      )}
      {state.phase === "ready" && state.proposals.length > 0 && (
        <>
          <div className="nt-table-wrap">
            <table className="nt-table snsgov-table snsgov-table--proposals">
              <thead>
                <tr>
                  <th className="snsgov-num" scope="col">#</th>
                  <th scope="col">Title</th>
                  <th className="snsgov-nowrap" scope="col">Type</th>
                  <th scope="col">Status</th>
                  <th className="snsgov-nowrap" scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {state.proposals.map((proposal) => (
                  <tr key={proposal.id.toString()} {...rowProps(() => setOpenId(proposal.id))}>
                    <td className="snsgov-num">{proposal.id.toString()}</td>
                    <th scope="row">
                      <button
                        className="snsgov-link snsgov-title-cell"
                        onClick={() => setOpenId(proposal.id)}
                        type="button"
                      >
                        {/* On-chain, user-supplied text. Rendered as plain text only. */}
                        {proposal.title || "(untitled)"}
                      </button>
                    </th>
                    <td className="snsgov-nowrap" title={proposal.actionKind}>
                      {proposal.actionKind}
                    </td>
                    <td>
                      <span className={`nt-badge ${STATUS_TONE[proposal.status]}`}>
                        {proposal.status}
                      </span>
                    </td>
                    <td className="snsgov-nowrap">
                      {formatTimestamp(proposal.createdAtSeconds).slice(0, 10)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {state.nextBefore !== undefined && (
            <button
              className="nt-button snsgov-more"
              disabled={loadingMore}
              onClick={() => void loadMore()}
              type="button"
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function ProposalDetailView({
  entry,
  proposalId,
  onBack,
}: {
  entry: RegistryEntry;
  proposalId: bigint;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<ProposalDetail | null | "error">(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // get_proposal, not list_proposals: the latter scopes ballots to the
        // caller, and our reads are anonymous, so it returns none.
        const result = await getProposal(entry.canisters.governance, proposalId);
        if (!cancelled) setDetail(result ?? "error");
      } catch {
        if (!cancelled) setDetail("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entry.canisters.governance, proposalId]);

  return (
    <section className="nt-section">
      <header className="nt-section-header">
        <IconButton label="Back to the proposal list" onClick={onBack}>
          <BackIcon />
        </IconButton>
        <h2 className="nt-section-heading">Proposal {proposalId.toString()}</h2>
        <span className="snsgov-spacer" />
        <IconButton
          label="Copy proposal id"
          onClick={() => void copyToClipboard(proposalId.toString())}
        >
          <CopyIcon />
        </IconButton>
      </header>

      {detail === null && <Pending label="Reading proposal" />}
      {detail === "error" && (
        <div className="nt-alert nt-alert--danger" role="alert">
          That proposal could not be read.
        </div>
      )}
      {detail !== null && detail !== "error" && (
        <>
          <h3 className="nt-subtitle">{detail.title || "(untitled)"}</h3>
          <dl className="nt-detail-grid">
            <Row label="Status" value={detail.status} />
            <Row label="Type" value={detail.actionKind} />
            {detail.topic && <Row label="Topic" value={detail.topic} />}
            <Row label="Created" value={formatTimestamp(detail.createdAtSeconds)} />
            {detail.deadlineSeconds !== undefined && (
              <Row label="Deadline" value={formatTimestamp(detail.deadlineSeconds)} />
            )}
            {detail.executedAtSeconds !== undefined && (
              <Row label="Executed" value={formatTimestamp(detail.executedAtSeconds)} />
            )}
            {detail.rejectCostE8s !== undefined && (
              <Row
                label="Reject cost"
                value={entry.token
                  ? `${formatTokenAmount(detail.rejectCostE8s, entry.token.decimals, { group: false })} ${entry.token.symbol}`
                  : `${detail.rejectCostE8s} atoms`}
              />
            )}
            {detail.proposerNeuronId && (
              <Row label="Proposer" value={shortenId(detail.proposerNeuronId, 8, 6)} />
            )}
            <Row
              label="Ballots"
              value={`${detail.ballots.filter((b) => b.vote !== 0).length} cast of ${detail.ballots.length} eligible`}
            />
          </dl>

          {detail.tally && (
            <Tally
              no={detail.tally.no}
              total={detail.tally.total}
              yes={detail.tally.yes}
            />
          )}

          {detail.summary && (
            <div className="snsgov-prose">
              <h4 className="nt-section-title">Summary</h4>
              {/* Untrusted on-chain text: plain text only, never markup. */}
              <pre className="nt-pre nt-pre--wrap">{detail.summary}</pre>
            </div>
          )}

          {detail.payloadTextRendering && (
            <div className="snsgov-prose">
              <h4 className="nt-section-title">Payload</h4>
              <pre className="nt-pre nt-pre--wrap">{detail.payloadTextRendering}</pre>
            </div>
          )}

          {detail.url && (
            <p className="nt-meta snsgov-footnote">
              <span className="nt-code">{detail.url}</span>
            </p>
          )}
        </>
      )}
    </section>
  );
}

function Tally({ yes, no, total }: { yes: bigint; no: bigint; total: bigint }) {
  // Percentages are display-only, so Number() is safe here; the underlying
  // values stay bigint everywhere they matter.
  const pct = (value: bigint): number =>
    total === 0n ? 0 : Number((value * 10_000n) / total) / 100;
  return (
    <div className="snsgov-tally">
      <div className="snsgov-tally-bar">
        <span className="snsgov-tally-yes" style={{ width: `${pct(yes)}%` }} />
        <span className="snsgov-tally-no" style={{ width: `${pct(no)}%` }} />
      </div>
      <p className="nt-meta">
        Yes {pct(yes).toFixed(1)}% · No {pct(no).toFixed(1)}% of total voting power
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="nt-detail">
      <dt className="nt-detail-label">{label}</dt>
      <dd className="nt-detail-value">{value}</dd>
    </div>
  );
}

function describe(error: unknown): string {
  return error instanceof SnsError ? error.message : String(error);
}
