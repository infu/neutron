import { useEffect, useState } from "react";
import { copyToClipboard } from "neutron-tools/app";
import { SnsError } from "../data/errors";
import {
  formatDuration,
  formatPercent,
  formatRewardRate,
  formatTokenAmount,
  shortenId,
} from "../data/format";
import {
  listNervousSystemFunctions,
  maxVotingPeriodExtensionSeconds,
  readMode,
  readParameters,
  uncategorizedFunctions,
} from "../data/governance";
import { readTreasuries } from "../data/ledger";
import { displayName, requireEntry, type RegistryEntry } from "../data/registry";
import type { NervousSystemFunctionInfo, SnsParameters, TreasuryBalances } from "../data/types";
import { NeuronsView } from "./Neurons";
import { ProposalsView } from "./Proposals";
import { IconButton } from "./IconButton";
import { SnsLogo } from "./Logo";
import { CanistersView } from "./Canisters";
import { RegistrationButton } from "./Registration";
import { Empty, Pending } from "./Status";
import { BackIcon, CopyIcon, ExternalIcon, WarnIcon } from "./Icons";

interface Loaded {
  entry: RegistryEntry;
  params?: SnsParameters;
  treasury?: TreasuryBalances;
  mode?: number;
  functions?: NervousSystemFunctionInfo[];
}

type State =
  | { phase: "loading" }
  | { phase: "ready"; data: Loaded }
  | { phase: "error"; message: string };

import { SNS_TABS, type SnsTab } from "../data/views";

type Tab = SnsTab;

export function SnsDetailView({
  rootCanisterId,
  onBack,
  initialTab,
  initialProposalId,
}: {
  rootCanisterId: string;
  onBack: () => void;
  /** Where an agent asked the owner to land. */
  initialTab?: Tab | undefined;
  initialProposalId?: bigint | undefined;
}) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [tab, setTab] = useState<Tab>(initialTab ?? "overview");

  // A second request while this SNS is already open must retarget it.
  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab, initialProposalId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setState({ phase: "loading" });
      try {
        const entry = await requireEntry(rootCanisterId);
        // Each read degrades independently: a dead governance canister must
        // still let the token and ledger panels render.
        const [params, mode, treasury, functions] = await Promise.all([
          entry.liveness.governance ? safe(() => readParameters(entry.canisters.governance)) : undefined,
          entry.liveness.governance ? safe(() => readMode(entry.canisters.governance)) : undefined,
          entry.liveness.ledger
            ? safe(() =>
                readTreasuries({
                  governanceCanisterId: entry.canisters.governance,
                  ledgerCanisterId: entry.canisters.ledger,
                }),
              )
            : undefined,
          entry.liveness.governance
            ? safe(() => listNervousSystemFunctions(entry.canisters.governance))
            : undefined,
        ]);
        if (cancelled) return;
        setState({
          phase: "ready",
          data: {
            entry,
            ...(params === undefined ? {} : { params }),
            ...(treasury === undefined ? {} : { treasury }),
            ...(mode === undefined ? {} : { mode }),
            ...(functions === undefined ? {} : { functions }),
          },
        });
      } catch (error) {
        if (cancelled) return;
        setState({
          phase: "error",
          message: error instanceof SnsError ? error.message : String(error),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rootCanisterId]);

  return (
    <div className="nt-page">
      <header className="nt-page-header snsgov-toolbar">
        <div className="nt-cluster">
          <IconButton label="Back to the SNS list" onClick={onBack}>
            <BackIcon />
          </IconButton>
          <h1 className="nt-title snsgov-detail-title">
            {state.phase === "ready" ? displayName(state.data.entry) : "…"}
          </h1>
        </div>
        <div className="nt-cluster snsgov-toolbar-actions">
          {state.phase === "ready" && state.data.entry.liveness.governance && (
            <RegistrationButton
              target={{
                rootCanisterId,
                governanceCanisterId: state.data.entry.canisters.governance,
                label: displayName(state.data.entry),
              }}
            />
          )}
          <IconButton
            label="Copy root canister id"
            onClick={() => void copyToClipboard(rootCanisterId)}
          >
            <CopyIcon />
          </IconButton>
          {state.phase === "ready" && (
            <SnsLogo
              logo={state.data.entry.metadata?.logo}
              name={displayName(state.data.entry)}
              size={28}
            />
          )}
        </div>
      </header>

      <section className="nt-page-main">
        {state.phase === "loading" && (
          <Pending label="Reading this SNS" />
        )}
        {state.phase === "error" && (
          <div className="nt-alert nt-alert--danger" role="alert">
            {state.message}
          </div>
        )}
        {state.phase === "ready" && (
          <>
            {state.data.entry.liveness.governance && (
              <div className="nt-tabs snsgov-tabs">
                <div aria-label="SNS sections" className="nt-tab-list" role="tablist">
                  {SNS_TABS.map((value) => (
                    <button
                      aria-selected={tab === value}
                      className="nt-tab"
                      key={value}
                      onClick={() => setTab(value)}
                      role="tab"
                      type="button"
                    >
                      {value[0]!.toUpperCase() + value.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {tab === "overview" && <DetailBody data={state.data} />}
            {tab === "types" && <ProposalTypes functions={state.data.functions} />}
            {tab === "canisters" && <CanistersView rootCanisterId={rootCanisterId} />}
            {tab === "proposals" && (
              <ProposalsView entry={state.data.entry} initialProposalId={initialProposalId} />
            )}
            {tab === "neurons" && <NeuronsView entry={state.data.entry} />}
          </>
        )}
      </section>
    </div>
  );
}

function DetailBody({ data }: { data: Loaded }) {
  const { entry, params, treasury, mode } = data;
  const token = entry.token;
  const symbol = token?.symbol ?? "";

  const amount = (value: bigint | undefined): string =>
    value === undefined ? "—" : token
      ? `${formatTokenAmount(value, token.decimals, { group: false })} ${symbol}`.trim()
      : `${value} atoms`;

  return (
    <>
      {!entry.liveness.governance && (
        <div className="nt-alert nt-alert--warning snsgov-alert" role="status">
          <WarnIcon />
          <span>
            This SNS&rsquo;s governance canister has no code installed, so parameters and proposals
            are unavailable.
            {entry.liveness.ledger ? " Token data below still comes from its live ledger." : ""}
          </span>
        </div>
      )}

      {entry.metadata?.description && (
        <p className="nt-text snsgov-description">{entry.metadata.description}</p>
      )}

      <Section count={token ? undefined : 0} title="Token">
        <dl className="nt-detail-grid">
          <Detail label="Name" value={token?.name ?? "—"} />
          <Detail label="Symbol" value={token?.symbol ?? "—"} />
          <Detail
            label="Transaction fee"
            value={token ? `${formatTokenAmount(token.fee, token.decimals, { group: false })} ${symbol}` : "—"}
          />
          <Detail
            label="Total supply"
            value={
              token?.totalSupply === undefined
                ? "—"
                : formatTokenAmount(token.totalSupply, token.decimals)
            }
          />
          <Detail
            label="ICP treasury"
            value={treasury?.icpE8s === undefined ? "—" : `${formatTokenAmount(treasury.icpE8s, 8)} ICP`}
          />
          <Detail
            label={`${symbol || "Token"} treasury`}
            value={
              amount(treasury?.tokenE8s)
            }
          />
        </dl>
      </Section>

      {params && (
        <Section title="Governance">
          <dl className="nt-detail-grid">
            <Detail label="Status" value={mode === 1 ? "Normal" : mode === 2 ? "Pre-swap" : "—"} />
            <Detail label="Initial voting period" value={duration(params.initialVotingPeriodSeconds)} />
            {/* Twice the raw parameter: a proposal extends to at most
                initial + 2 × wait_for_quiet_deadline_increase. */}
            <Detail
              label="Max voting period extension"
              value={duration(maxVotingPeriodExtensionSeconds(params))}
            />
            <Detail label="Reject cost" value={amount(params.rejectCostE8s)} />
            <Detail label="Min neuron stake" value={amount(params.neuronMinimumStakeE8s)} />
            <Detail
              label="Min dissolve delay to vote"
              value={duration(params.neuronMinimumDissolveDelayToVoteSeconds)}
            />
            <Detail label="Max dissolve delay" value={duration(params.maxDissolveDelaySeconds)} />
            <Detail
              label="Max dissolve delay bonus"
              value={percent(params.maxDissolveDelayBonusPercentage)}
            />
            <Detail label="Max age for age bonus" value={duration(params.maxNeuronAgeForAgeBonusSeconds)} />
            <Detail label="Max age bonus" value={percent(params.maxAgeBonusPercentage)} />
            <Detail label="Reward rate" value={formatRewardRate(params.rewards ?? {}) ?? "—"} />
            <Detail
              label="Max principals per neuron"
              value={params.maxNumberOfPrincipalsPerNeuron?.toString() ?? "—"}
            />
          </dl>
        </Section>
      )}

      {entry.metadata?.url && (
        <p className="nt-meta snsgov-footnote">
          <ExternalIcon /> <span>{entry.metadata.url}</span>
        </p>
      )}
    </>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number | undefined;
  children: React.ReactNode;
}) {
  return (
    <section className="nt-section">
      <header className="nt-section-header">
        <h2 className="nt-section-heading">{title}</h2>
        {count !== undefined && <span className="nt-section-count">{count}</span>}
      </header>
      {children}
    </section>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="nt-detail">
      <dt className="nt-detail-label">{label}</dt>
      <dd className="nt-detail-value">{value}</dd>
    </div>
  );
}

function duration(seconds: bigint | undefined): string {
  return seconds === undefined ? "—" : formatDuration(seconds);
}

function percent(value: bigint | undefined): string {
  return value === undefined ? "—" : formatPercent(value);
}

async function safe<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch {
    return undefined;
  }
}

/**
 * The DAO's registered proposal types.
 *
 * Its own tab rather than a slab at the bottom of the overview: OpenChat
 * registers 46 of these, which buried the parameters a reader came for.
 */
function ProposalTypes({ functions }: { functions: NervousSystemFunctionInfo[] | undefined }) {
  if (functions === undefined) {
    return <div className="nt-alert nt-alert--danger" role="alert">Proposal types could not be read.</div>;
  }
  const blocked = uncategorizedFunctions(functions);
  if (functions.length === 0) {
    return <Empty label="This SNS registers no proposal types." />;
  }
  return (
    <Section count={functions.length} title="Proposal types">
          {blocked.length > 0 && (
      <div className="nt-alert nt-alert--warning snsgov-alert" role="status">
        <WarnIcon />
        <span>
          {blocked.length} custom proposal {blocked.length === 1 ? "type has" : "types have"} no
          topic assigned, so the SNS rejects every submission of{" "}
          {blocked.length === 1 ? "it" : "them"}. The DAO must submit{" "}
          <code className="nt-code">SetTopicsForCustomProposals</code> to fix this.
        </span>
      </div>
      )}
      <div className="nt-table-wrap">
      <table className="nt-table snsgov-table snsgov-table--functions">
        <thead>
          <tr>
            <th scope="col">Type</th>
            <th scope="col">Kind</th>
            <th scope="col">Target</th>
            <th scope="col">Topic</th>
          </tr>
        </thead>
        <tbody>
          {functions.map((fn) => (
            <tr key={fn.id.toString()}>
              <th scope="row">{fn.name}</th>
              <td>{fn.kind}</td>
              <td>
                {fn.targetCanisterId ? (
                  <code className="nt-code">
                    {shortenId(fn.targetCanisterId, 5, 3)}::{fn.targetMethodName}
                  </code>
                ) : (
                  "—"
                )}
              </td>
              <td>
                {fn.kind === "generic" && fn.topic === undefined ? (
                  <span className="nt-badge nt-badge--warning">not proposable</span>
                ) : (
                  (fn.topic ?? "—")
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </Section>
  );
}
