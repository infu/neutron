import { useEffect, useState } from "react";
import { copyToClipboard } from "neutron-tools/app";
import { formatDuration, formatPercent, formatRewardRate, formatTokenAmount } from "../data/format";
import { listNervousSystemFunctions, maxVotingPeriodExtensionSeconds, readMode, readParameters, uncategorizedFunctions } from "../data/governance";
import { readTreasuries } from "../data/ledger";
import { displayName, requireEntry, type RegistryEntry } from "../data/registry";
import type { NervousSystemFunctionInfo, SnsParameters, TreasuryBalances } from "../data/types";
import type { SnsTab } from "../data/views";
import { NeuronsView } from "./Neurons";
import { ProposalsView } from "./Proposals";
import { SnsLogo } from "./Logo";
import { CanistersView } from "./Canisters";
import { RegistrationButton } from "./Registration";
import { Empty, Pending } from "./Status";
import { Disclosure, ErrorNote, Help, PageHeading, safeExternalUrl, useRead } from "./Common";

type Tab = "overview" | "proposals" | "neurons" | "details";
const localTab = (tab: SnsTab | undefined): Tab => tab === "types" || tab === "canisters" ? "details" : tab ?? "overview";

export function SnsDetailView({ rootCanisterId, onBack, initialTab, initialProposalId }: {
  rootCanisterId: string; onBack: () => void; initialTab?: SnsTab | undefined; initialProposalId?: bigint | undefined;
}) {
  const [tab, setTab] = useState<Tab>(() => localTab(initialTab));
  const [refresh, setRefresh] = useState(0);
  const entryRead = useRead(rootCanisterId, () => requireEntry(rootCanisterId), refresh);
  const entry = entryRead.data;
  const governance = entry?.liveness.governance ? entry.canisters.governance : null;
  const parameters = useRead(governance, () => readParameters(governance!), refresh);
  const mode = useRead(governance, () => readMode(governance!), refresh);
  const treasuries = useRead(entry?.liveness.ledger ? rootCanisterId : null, () => readTreasuries({ governanceCanisterId: entry!.canisters.governance, ledgerCanisterId: entry!.canisters.ledger }), refresh);
  const functions = useRead(governance, () => listNervousSystemFunctions(governance!), refresh);
  useEffect(() => { setTab(localTab(initialTab)); }, [initialTab, initialProposalId]);
  const url = safeExternalUrl(entry?.metadata?.url);
  return <section className="nt-page snsgov-community-page">
    <PageHeading title={entry ? displayName(entry) : "Community"} onBack={onBack} actions={entry && <SnsLogo logo={entry.metadata?.logo} name={displayName(entry)} size={36} />} />
    <ErrorNote message={entryRead.error} />
    {!entry && entryRead.loading && <Pending label="Reading this community" />}
    {entryRead.error && <button className="nt-button" type="button" onClick={() => setRefresh(value => value + 1)}>Try again</button>}
    {entry && <>
      <nav className="snsgov-context-navigation" aria-label="Community sections">{([
        ["overview", "Overview"], ["proposals", "Proposals"], ["neurons", "My neurons"], ["details", "Details"],
      ] as const).filter(([value]) => entry.liveness.governance || value === "overview" || value === "details").map(([value, label]) => <button className="nt-tab" type="button" key={value} data-active={tab === value} aria-current={tab === value ? "page" : undefined} onClick={() => setTab(value)}>{label}</button>)}</nav>
      {tab === "overview" && <>
        {entry.metadata?.description && <p className="snsgov-community-intro">{entry.metadata.description}</p>}
        {!entry.liveness.governance && <p className="nt-alert nt-alert--warning" role="status">Governance is unavailable for this community.{entry.liveness.ledger ? " Its token ledger is still available." : ""}</p>}
        {entry.liveness.governance && <div className="snsgov-community-actions"><button className="nt-button" type="button" onClick={() => setTab("proposals")}>View proposals</button><button className="nt-button nt-button--secondary" type="button" onClick={() => setTab("neurons")}>Stake & manage neurons</button></div>}
        <section className="nt-section"><h3 className="nt-section-heading">Getting involved</h3><dl className="nt-detail-grid snsgov-summary-grid">
          <Detail label="Token" value={entry.token?.symbol ?? "Unavailable"} />
          <Detail label="Minimum stake" value={amount(parameters.data?.neuronMinimumStakeE8s, entry)} help="The smallest stake this community accepts when creating a neuron. A network transfer fee may also apply." />
          <Detail label="Unlock delay to vote" value={duration(parameters.data?.neuronMinimumDissolveDelayToVoteSeconds)} help="A neuron needs at least this much remaining unlock delay to qualify for new proposals. Only neurons in a proposal’s ballot can vote on that proposal." />
        </dl></section>
        {parameters.error && <p className="nt-meta snsgov-muted">Some community requirements could not be read. Refresh the details to try again.</p>}
        {entry.liveness.governance && <RegistrationButton target={{ rootCanisterId, governanceCanisterId: entry.canisters.governance, label: displayName(entry) }} />}
        {url && <a className="nt-link snsgov-community-site" href={url} target="_blank" rel="noopener noreferrer">Visit community website ↗</a>}
        <Disclosure title="How staking works"><p className="nt-text">Staking creates a neuron: tokens held for governance with an unlock delay you choose. The countdown starts when you choose to unlock, rather than automatically after staking.</p><p className="nt-text">Already have a neuron in another wallet? Add this Neutron’s address there to share voting access, while keeping the controls your wallet already has.</p></Disclosure>
      </>}
      {tab === "proposals" && <ProposalsView entry={entry} initialProposalId={initialProposalId} />}
      {tab === "neurons" && <NeuronsView entry={entry} />}
      {tab === "details" && <>
        <div className="nt-cluster"><p className="nt-text snsgov-muted snsgov-grow">The community’s current settings and infrastructure.</p><button className="nt-button nt-button--ghost" type="button" disabled={parameters.loading || functions.loading} onClick={() => setRefresh(value => value + 1)}>Refresh details</button></div>
        <Disclosure title="Token & treasury"><TokenDetails entry={entry} treasury={treasuries.data} /><ErrorNote message={treasuries.error} /></Disclosure>
        <Disclosure title="Voting & staking rules"><GovernanceDetails entry={entry} params={parameters.data} mode={mode.data} /><ErrorNote message={parameters.error || mode.error} /></Disclosure>
        <Disclosure title="Proposal types" open={initialTab === "types"}><ProposalTypes functions={functions.data} loading={functions.loading} error={functions.error} /></Disclosure>
        <Disclosure title="Canisters" open={initialTab === "canisters"}><CanistersView rootCanisterId={rootCanisterId} /></Disclosure>
        <Disclosure title="Community addresses"><dl className="snsgov-addresses">{Object.entries(entry.canisters).filter((pair): pair is [string, string] => typeof pair[1] === "string").map(([role, principal]) => <div key={role}><dt>{role}</dt><dd><code>{principal}</code><button className="nt-button nt-button--ghost" type="button" aria-label={`Copy ${role} address`} onClick={() => void copyToClipboard(principal)}>Copy</button></dd></div>)}</dl></Disclosure>
      </>}
    </>}
  </section>;
}

function TokenDetails({ entry, treasury }: { entry: RegistryEntry; treasury: TreasuryBalances | null }) {
  return <dl className="nt-detail-grid">
    <Detail label="Token name" value={entry.token?.name ?? "Unavailable"} />
    <Detail label="Symbol" value={entry.token?.symbol ?? "Unavailable"} />
    <Detail label="Transfer fee" value={amount(entry.token?.fee, entry)} help="The fee charged by the token ledger for a transfer. It is separate from the amount you stake or withdraw." />
    <Detail label="Total supply" value={amount(entry.token?.totalSupply, entry)} />
    <Detail label="ICP treasury" value={treasury?.icpE8s === undefined ? "Unavailable" : `${formatTokenAmount(treasury.icpE8s, 8)} ICP`} />
    <Detail label="Token treasury" value={amount(treasury?.tokenE8s, entry)} />
  </dl>;
}

function GovernanceDetails({ entry, params, mode }: { entry: RegistryEntry; params: SnsParameters | null; mode: number | undefined | null }) {
  if (!params) return <Empty label="Voting and staking rules are not available yet." />;
  return <dl className="nt-detail-grid">
    <Detail label="Governance state" value={mode === 1 ? "Active" : mode === 2 ? "Preparing launch" : "Unavailable"} />
    <Detail label="Voting period" value={duration(params.initialVotingPeriodSeconds)} />
    <Detail label="Maximum deadline extension" value={duration(maxVotingPeriodExtensionSeconds(params))} help="Late votes can extend a proposal’s deadline when they change the outcome. The proposal shows its current deadline." />
    <Detail label="Cost if a proposal is rejected" value={amount(params.rejectCostE8s, entry)} />
    <Detail label="Minimum stake" value={amount(params.neuronMinimumStakeE8s, entry)} />
    <Detail label="Unlock delay to vote" value={duration(params.neuronMinimumDissolveDelayToVoteSeconds)} help="A neuron needs this much remaining unlock delay to qualify for new proposals. Each proposal has its own eligible ballots." />
    <Detail label="Maximum unlock delay" value={duration(params.maxDissolveDelaySeconds)} />
    <Detail label="Maximum delay bonus" value={percent(params.maxDissolveDelayBonusPercentage)} help="A longer unlock delay can increase a neuron’s voting power, up to this bonus." />
    <Detail label="Age needed for full age bonus" value={duration(params.maxNeuronAgeForAgeBonusSeconds)} help="Locked neurons build an age bonus over time. Starting to unlock removes the age bonus while the countdown runs." />
    <Detail label="Maximum age bonus" value={percent(params.maxAgeBonusPercentage)} />
    <Detail label="Community reward rate" value={formatRewardRate(params.rewards ?? {}) ?? "Unavailable"} help="This is the community’s reward-distribution parameter, not a guaranteed return on your stake. Your rewards depend on voting and the community’s rules." />
    <Detail label="Maximum addresses per neuron" value={params.maxNumberOfPrincipalsPerNeuron?.toString() ?? "Unavailable"} />
  </dl>;
}

function ProposalTypes({ functions, loading, error }: { functions: NervousSystemFunctionInfo[] | null; loading: boolean; error: string }) {
  const withoutTopic = functions ? uncategorizedFunctions(functions) : [];
  return <section className="nt-section">
    <ErrorNote message={error ? "Proposal types could not be read. Refresh details to try again." : ""} />
    {!functions && loading && <Pending label="Reading proposal types" />}
    {functions?.length === 0 && <Empty label="No proposal types are registered." />}
    {withoutTopic.length > 0 && <p className="nt-alert nt-alert--warning" role="status">{withoutTopic.length} custom proposal {withoutTopic.length === 1 ? "type has" : "types have"} no topic. Newer governance versions may require one before submission; older communities can still accept these proposals.</p>}
    <div className="snsgov-function-list">{functions?.map(fn => <Disclosure key={fn.id.toString()} title={fn.name} description={fn.kind === "generic" ? fn.topic ?? "Topic not assigned" : "Built-in proposal"}>
      {fn.description && <p className="nt-text">{fn.description}</p>}
      <dl className="snsgov-facts"><dt>Type ID</dt><dd>{fn.id.toString()}</dd><dt>Topic</dt><dd>{fn.topic ?? "Not assigned"}</dd>{fn.targetCanisterId && <><dt>Target</dt><dd><code>{fn.targetCanisterId}</code></dd><dt>Method</dt><dd><code>{fn.targetMethodName}</code></dd></>}{fn.validatorCanisterId && <><dt>Validator</dt><dd><code>{fn.validatorCanisterId}</code></dd><dt>Validation method</dt><dd><code>{fn.validatorMethodName}</code></dd></>}</dl>
    </Disclosure>)}</div>
  </section>;
}

function Detail({ label, value, help }: { label: string; value: string; help?: string }) {
  return <div className="nt-detail"><dt className="nt-detail-label">{label}{help && <Help label={label}>{help}</Help>}</dt><dd className="nt-detail-value">{value}</dd></div>;
}
function amount(value: bigint | undefined, entry: RegistryEntry): string {
  return value === undefined ? "Unavailable" : entry.token ? `${formatTokenAmount(value, entry.token.decimals)} ${entry.token.symbol}` : `${value} base units`;
}
const duration = (value: bigint | undefined) => value === undefined ? "Unavailable" : formatDuration(value);
const percent = (value: bigint | undefined) => value === undefined ? "Unavailable" : formatPercent(value);
