import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { copyToClipboard } from "neutron-tools/app";
import { neuronPermissions, dissolveDelay } from "../data/neuron_actions";
import { readTokenInfo } from "../data/ledger";
import { getNeuron, readParameters } from "../data/governance";
import { displayName, type RegistryEntry } from "../data/registry";
import { formatDuration, formatTimestamp, shortenId } from "../data/format";
import type { NeuronSummary } from "../data/types";
import { Disclosure, ErrorNote, Help, PageHeading, useRead } from "./Common";
import { Empty, Pending } from "./Status";
import { NeuronManagement } from "./NeuronManagement";
import { neuronAmount } from "./NeuronFields";
import { StakingDialog } from "./StakingDialog";

export const PERMISSION_LABELS: Record<number, string> = {
  0: "Unspecified", 1: "Change unlock settings", 2: "Manage all access", 3: "Submit proposals", 4: "Vote",
  5: "Withdraw stake", 6: "Split stake", 7: "Merge rewards", 8: "Withdraw rewards", 9: "Stake rewards", 10: "Manage voting access",
};
export function heldPermissions(neuron: NeuronSummary, principal?: string): number[] {
  return principal ? neuronPermissions(neuron, principal) : [];
}
export function neuronUnlock(neuron: NeuronSummary, now = BigInt(Math.floor(Date.now() / 1000))) {
  const state = neuron.dissolveState;
  const remaining = dissolveDelay(neuron, now);
  if (remaining === 0n) return { label: "Ready to withdraw", detail: "The unlock delay has ended.", remaining };
  if (state?.kind === "dissolving") return { label: "Unlocking", detail: `${formatDuration(remaining)} remaining · ${formatTimestamp(state.value)}`, remaining };
  return { label: "Locked", detail: `${formatDuration(remaining)} unlock delay · countdown has not started`, remaining };
}
function accessLabel(held: number[]): string {
  if (held.length === 0) return "Public neuron · no access detected";
  if ([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].every(permission => held.includes(permission))) return "Full permissions granted to this Neutron";
  return `Connected neuron · ${held.map(permission => PERMISSION_LABELS[permission] ?? `Permission ${permission}`).join(", ")}`;
}
export function NeuronRow({ neuron, entry, principal, onOpen }: { neuron: NeuronSummary; entry: RegistryEntry; principal?: string | undefined; onOpen: () => void }) {
  const unlock = neuronUnlock(neuron);
  return <article className="snsgov-neuron-row">
    <button className="snsgov-neuron-open" type="button" data-neuron-id={neuron.id} onClick={onOpen} aria-label={`Open neuron ${shortenId(neuron.id, 8, 6)}`}>
      <span className="snsgov-neuron-row-top"><strong className="snsgov-neuron-amount">{neuronAmount(neuron.stakeE8s, entry)}</strong><span className="nt-badge">{unlock.label}</span></span>
      <span className="nt-text">{unlock.detail}</span>
      <span className="nt-meta">{accessLabel(heldPermissions(neuron, principal))}</span>
      <span className="nt-meta">Voting rewards: {neuronAmount(neuron.maturityE8s, entry)} equivalent · Neuron {shortenId(neuron.id, 8, 6)}</span>
    </button>
  </article>;
}
export function NeuronDetail({ entry, neuronId, principal, onBack }: { entry: RegistryEntry; neuronId: string; principal?: string | undefined; onBack: () => void }) {
  const [refresh, setRefresh] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { root.current?.querySelector<HTMLElement>(".nt-title")?.focus(); }, []);
  const [topUp, setTopUp] = useState(false);
  const [now, setNow] = useState(() => BigInt(Math.floor(Date.now() / 1000)));
  const read = useRead(`${entry.canisters.root}/${neuronId}`, () => getNeuron(entry.canisters.governance, neuronId), refresh);
  const parameters = useRead(entry.canisters.governance, () => readParameters(entry.canisters.governance), refresh);
  const token = useRead(entry.canisters.ledger, () => readTokenInfo(entry.canisters.ledger), refresh);
  const { token: _cachedToken, ...withoutToken } = entry;
  const liveEntry: RegistryEntry = token.data ? { ...entry, token: token.data } : withoutToken;
  useEffect(() => { const timer = setInterval(() => setNow(BigInt(Math.floor(Date.now() / 1000))), 30_000); return () => clearInterval(timer); }, []);
  const neuron = read.data;
  const unlock = neuron && neuronUnlock(neuron, now);
  const permissions = neuron ? heldPermissions(neuron, principal) : [];
  const vestedAt = neuron?.vestingPeriodSeconds === undefined ? undefined : neuron.createdAtSeconds + neuron.vestingPeriodSeconds;
  const vesting = vestedAt !== undefined && vestedAt > now;
  return <div className="nt-page snsgov-neuron-detail" ref={root}>
    <PageHeading title="Neuron" description={displayName(entry)} onBack={onBack}
      actions={<button className="nt-button nt-button--secondary" type="button" disabled={read.loading} onClick={() => setRefresh(value => value + 1)}>Refresh neuron</button>} />
    <section className="nt-page-main">
      {read.loading && <Pending label="Reading neuron" />}
      <ErrorNote message={read.error} />
      {!read.loading && !read.error && !neuron && <Empty label="This neuron was not found." />}
      {neuron && unlock && <>
        <section className="nt-section snsgov-neuron-summary">
          <h3 className="snsgov-neuron-balance">{neuronAmount(neuron.stakeE8s, liveEntry)}</h3>
          <div><span className="nt-badge">{unlock.label}</span> <Help label="unlock delay">The time to wait after starting to unlock before stake can be withdrawn. A locked neuron has not started its countdown. Other conditions, such as vesting, still apply.</Help></div>
          <p>{unlock.detail}</p>
          {vesting && <p className="nt-alert nt-alert--warning">Vesting continues until {formatTimestamp(vestedAt!)}. The SNS restricts withdrawal, splitting and changing unlock settings while vesting applies.</p>}
          <dl className="nt-detail-grid snsgov-neuron-values">
            <div><dt>Voting rewards (maturity) <Help label="maturity">Reward accounting from voting, shown in token-equivalent units. Maturity is not a transferable token balance; the amount and timing of conversion depend on the chosen reward action and SNS rules.</Help></dt><dd>{neuronAmount(neuron.maturityE8s, liveEntry)} equivalent</dd></div>
            <div><dt>Staked rewards</dt><dd>{neuronAmount(neuron.stakedMaturityE8s, liveEntry)} equivalent</dd></div>
            {neuron.feesE8s !== undefined && <div><dt>Accumulated neuron fees</dt><dd>{neuronAmount(neuron.feesE8s, liveEntry)}</dd></div>}
          </dl>
          <p className="snsgov-neuron-access">{accessLabel(permissions)}</p>
          {!principal && <p className="nt-meta">Neutron principal unavailable. Refresh the app to read your management access.</p>}
          {permissions.length > 0 && <button className="nt-button nt-button--secondary" type="button" onClick={() => setTopUp(true)}>Increase stake</button>}
        </section>
        {principal && permissions.length > 0 && <NeuronManagement entry={liveEntry} neuron={neuron} principal={principal} parameters={parameters.data ?? undefined} onChanged={() => setRefresh(value => value + 1)} />}
        {token.error && <ErrorNote message={`Token metadata could not be read: ${token.error}. Amount-entry actions require a known token scale.`} />}
        {parameters.error && <ErrorNote message={`Community parameters could not be read: ${parameters.error}`} />}
        <Disclosure title="Access and neuron details">
          <p>Permissions are shared grants. They do not identify an immutable owner or prove this neuron was created here.</p>
          <p className="snsgov-neuron-copy"><code className="nt-code">{neuron.id}</code><button className="nt-button nt-button--secondary" type="button" onClick={() => void copyToClipboard(neuron.id)}>Copy neuron id</button></p>
          <ul className="snsgov-access-list">{neuron.permissions.map((permission, index) => <li key={`${permission.principal}/${index}`}><code className="nt-code">{permission.principal ?? "Principal unavailable"}</code>
            <p>{permission.permissions.map(value => `${PERMISSION_LABELS[value] ?? "Unknown"} (${value})`).join(", ") || "No permissions"}</p></li>)}</ul>
          <dl className="nt-detail-grid snsgov-neuron-values"><div><dt>Created</dt><dd>{formatTimestamp(neuron.createdAtSeconds)}</dd></div>
            <div><dt>Voting power multiplier</dt><dd>{neuron.votingPowerMultiplierPercent.toString()}%</dd></div>
            <div><dt>Automatic staking of maturity</dt><dd>{neuron.autoStakeMaturity === undefined ? "Not reported" : neuron.autoStakeMaturity ? "On" : "Off"}</dd></div>
            {parameters.data?.neuronMinimumDissolveDelayToVoteSeconds !== undefined && <div><dt>Minimum unlock delay to vote</dt><dd>{formatDuration(parameters.data.neuronMinimumDissolveDelayToVoteSeconds)}</dd></div>}
          </dl>
          <p className="nt-meta">Each proposal determines its eligible neurons and voting power from its own ballot snapshot.</p>
        </Disclosure>
        <Disclosure title="Following and pending reward withdrawals">
          <h3 className="nt-section-heading">Following by proposal type</h3>
          {(neuron.followees ?? []).length ? neuron.followees!.map(item => <p key={item.functionId.toString()}>Type {item.functionId.toString()}: {item.neuronIds.join(", ") || "No followees"}</p>) : <p>No proposal-type followees reported.</p>}
          <h3 className="nt-section-heading">Following by topic</h3>
          {(neuron.topicFollowees ?? []).length ? neuron.topicFollowees!.map(item => <p key={item.topicId}>{item.topic ?? `Topic ${item.topicId}`}: {item.neuronIds.join(", ") || "No followees"}</p>) : <p>No topic followees reported.</p>}
          <h3 className="nt-section-heading">Pending reward withdrawals</h3>
          {(neuron.disburseMaturityInProgress ?? []).length ? neuron.disburseMaturityInProgress!.map((item, index) => <p key={index}>{neuronAmount(item.amountE8s, liveEntry)} equivalent · requested {formatTimestamp(item.timestampSeconds)}{item.finalizeDisbursementTimestampSeconds === undefined ? " · finalization time not reported" : ` · finalization ${formatTimestamp(item.finalizeDisbursementTimestampSeconds)}`}</p>) : <p>No pending reward withdrawals reported.</p>}
        </Disclosure>
      </>}
    </section>
    {topUp && <StakingDialog entries={[entry]} neuronId={neuronId} initialRootCanisterId={entry.canisters.root} onClose={() => setTopUp(false)} onComplete={() => setRefresh(value => value + 1)} />}
  </div>;
}
