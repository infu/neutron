import { useState } from "react";
import { Principal } from "@dfinity/principal";
import { invoke, operationId } from "../data/actions_client";
import { NEURON_COMMANDS, neuronCapabilities } from "../data/neuron_actions";
import { candidTypeSchema, candidValueFromJson } from "../data/candid_codec";
import { governanceCommandType, candidVariantFields } from "../data/governance_codec";
import { decodeIcrcAccount } from "../data/accounts";
import { parseTokenAmount, toHex } from "../data/format";
import type { RegistryEntry } from "../data/registry";
import type { NeuronSummary, SnsParameters } from "../data/types";
import { Dialog, Disclosure, ErrorNote } from "./Common";
import { Pending } from "./Status";
import { PERMISSION_LABELS, neuronUnlock } from "./NeuronDetail";
import { DurationField, Field, jsonText, neuronAmount, NeuronOperationResult } from "./NeuronFields";

type Action = "delay" | "start" | "stop" | "auto" | "stakeRewards" | "mergeRewards" | "withdrawRewards" | "split" | "withdraw" | "follow" | "topic" | "share" | "remove" | "transfer" | "refresh" | "advanced";
const TITLES: Record<Action, string> = { delay: "Increase unlock delay", start: "Start unlocking", stop: "Stop unlocking", auto: "Automatic reward staking", stakeRewards: "Stake rewards", mergeRewards: "Merge rewards into stake", withdrawRewards: "Withdraw rewards", split: "Split neuron", withdraw: "Withdraw stake", follow: "Follow by proposal type", topic: "Follow by topic", share: "Share access", remove: "Remove access", transfer: "Transfer control", refresh: "Refresh recorded stake", advanced: "Advanced command" };
const TOPICS = ["DappCanisterManagement", "DaoCommunitySettings", "ApplicationBusinessLogic", "CriticalDappOperations", "TreasuryAssetManagement", "Governance", "SnsFrameworkManagement"];
const EXAMPLES: Record<string, object> = {
  Configure: { operation: { IncreaseDissolveDelay: { additional_dissolve_delay_seconds: 86400 } } },
  Disburse: { to_account: null, amount: null }, Split: { memo: "0", amount_e8s: "0" },
  MergeMaturity: { percentage_to_merge: 100 }, StakeMaturity: { percentage_to_stake: 100 },
  DisburseMaturity: { percentage_to_disburse: 100, to_account: null },
  Follow: { function_id: "0", followees: [] }, SetFollowing: { topic_following: [] },
  RegisterVote: { proposal: { id: "0" }, vote: 1 },
  MakeProposal: { title: "", summary: "", url: "", action: { Motion: { motion_text: "" } } },
  AddNeuronPermissions: { principal_id: null, permissions_to_add: { permissions: [4] } },
  RemoveNeuronPermissions: { principal_id: null, permissions_to_remove: { permissions: [4] } },
  ClaimOrRefresh: { by: { NeuronId: {} } },
};

export function NeuronManagement({ entry, neuron, principal, parameters, onChanged }: {
  entry: RegistryEntry; neuron: NeuronSummary; principal: string; parameters?: SnsParameters | undefined; onChanged: () => void;
}) {
  const [action, setAction] = useState<Action>();
  const capability = neuronCapabilities(neuron, principal, parameters);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const vesting = neuron.vestingPeriodSeconds !== undefined && neuron.createdAtSeconds + neuron.vestingPeriodSeconds > now;
  const unlock = neuronUnlock(neuron, now);
  const button = (kind: Action, allowed: boolean) => allowed && <button className="nt-button nt-button--secondary" type="button" onClick={() => setAction(kind)}>{TITLES[kind]}</button>;
  return <section className="nt-section snsgov-neuron-management">
    <h3 className="nt-section-heading">Manage neuron</h3>
    <div className="snsgov-neuron-actions">
      {button("delay", capability.canConfigure && !vesting)}
      {button("start", capability.canConfigure && !vesting && unlock.label === "Locked")}
      {button("stop", capability.canConfigure && !vesting && unlock.label === "Unlocking")}
      {button("withdraw", capability.canDisburse && !vesting && unlock.remaining === 0n)}
      {button("stakeRewards", capability.canStakeMaturity)}
      {button("withdrawRewards", capability.canDisburseMaturity)}
    </div>
    {!capability.canConfigure && !capability.canDisburse && <p className="nt-meta">This grant cannot change the unlock delay or withdraw stake. Use the controlling wallet to change those permissions.</p>}
    <Disclosure title="More management actions">
      <div className="snsgov-neuron-actions">
        {button("split", capability.canSplit && !vesting)}{button("mergeRewards", capability.canMergeMaturity)}
        {button("auto", capability.canConfigure)}{button("follow", capability.canVote)}{button("topic", capability.canVote)}
        {button("share", capability.canManageVotingAccess)}{button("remove", capability.canManageVotingAccess)}
        {button("transfer", capability.canManagePrincipals)}{button("refresh", true)}{button("advanced", true)}
      </div>
      <p className="nt-meta">Available actions reflect the permissions currently granted to this Neutron. The community validates every command again before it is sent.</p>
    </Disclosure>
    {action && <ActionDialog key={action} action={action} entry={entry} neuron={neuron} principal={principal} parameters={parameters} onClose={() => setAction(undefined)} onChanged={onChanged} />}
  </section>;
}

function ActionDialog({ action, entry, neuron, principal, parameters, onClose, onChanged }: {
  action: Action; entry: RegistryEntry; neuron: NeuronSummary; principal: string; parameters?: SnsParameters | undefined; onClose: () => void; onChanged: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [duration, setDuration] = useState("1");
  const [durationUnit, setDurationUnit] = useState("86400");
  const [percentage, setPercentage] = useState("100");
  const [destination, setDestination] = useState(principal);
  const [target, setTarget] = useState("");
  const [followees, setFollowees] = useState("");
  const [functionId, setFunctionId] = useState("0");
  const [topic, setTopic] = useState("Governance");
  const [permissions, setPermissions] = useState<number[]>([4]);
  const [auto, setAuto] = useState(!neuron.autoStakeMaturity);
  const [keepVoting, setKeepVoting] = useState(true);
  const [memo, setMemo] = useState(() => BigInt(`0x${operationId().slice(0, 16)}`).toString());
  const [kind, setKind] = useState("Configure");
  const [raw, setRaw] = useState(jsonText(EXAMPLES.Configure));
  const [preview, setPreview] = useState<{ id: string; command?: unknown; review: unknown }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [operation, setOperation] = useState<{ id: string; result?: unknown; error?: string }>();
  const caps = neuronCapabilities(neuron, principal, parameters);
  const reset = () => { setPreview(undefined); setError(undefined); };
  const change = (set: (value: string) => void) => (value: string) => { set(value); reset(); };
  const nat = (value: string, label: string) => { if (!/^\d+$/.test(value.trim())) throw new Error(`${label} must be a whole non-negative number.`); return BigInt(value).toString(); };
  const money = (value: string) => {
    if (!entry.token) throw new Error("Token decimals and fees are unavailable. Read token metadata before entering a financial amount.");
    const result = parseTokenAmount(value, entry.token.decimals);
    if (result <= 0n) throw new Error("The token amount must be greater than zero.");
    return result.toString();
  };
  const percent = () => { const n = Number(nat(percentage, "Percentage")); if (n < 1 || n > 100) throw new Error("Choose a percentage from 1 to 100."); return n; };
  const account = () => { const value = decodeIcrcAccount(destination); return { owner: value.owner.toText(), subaccount: value.subaccount ? { subaccount: { hex: toHex(value.subaccount) } } : null }; };
  const ids = () => followees.trim() ? followees.trim().split(/[\s,]+/).map(id => { if (!/^[0-9a-f]{64}$/i.test(id)) throw new Error("Each followee must be a 32-byte neuron ID (64 hexadecimal characters)."); return { id: { hex: id.toLowerCase() } }; }) : [];
  const command = (): unknown => {
    switch (action) {
      case "delay": return { Configure: { operation: { IncreaseDissolveDelay: { additional_dissolve_delay_seconds: (BigInt(nat(duration, "Additional unlock delay")) * BigInt(durationUnit)).toString() } } } };
      case "start": return { Configure: { operation: { StartDissolving: {} } } };
      case "stop": return { Configure: { operation: { StopDissolving: {} } } };
      case "auto": return { Configure: { operation: { ChangeAutoStakeMaturity: { requested_setting_for_auto_stake_maturity: auto } } } };
      case "stakeRewards": return { StakeMaturity: { percentage_to_stake: percent() } };
      case "mergeRewards": return { MergeMaturity: { percentage_to_merge: percent() } };
      case "withdrawRewards": return { DisburseMaturity: { percentage_to_disburse: percent(), to_account: account() } };
      case "withdraw": return { Disburse: { to_account: account(), amount: amount.trim() ? { e8s: money(amount) } : null } };
      case "split": return { Split: { memo: nat(memo, "Split nonce"), amount_e8s: money(amount) } };
      case "follow": return { Follow: { function_id: nat(functionId, "Proposal type ID"), followees: ids() } };
      case "topic": return { SetFollowing: { topic_following: [{ topic: { [topic]: null }, followees: ids().map(neuron_id => ({ neuron_id, alias: null })) }] } };
      case "share": case "remove": {
        const principal_id = Principal.fromText(target.trim()).toText();
        if (!permissions.length) throw new Error("Select at least one permission.");
        return action === "share" ? { AddNeuronPermissions: { principal_id, permissions_to_add: { permissions } } }
          : { RemoveNeuronPermissions: { principal_id, permissions_to_remove: { permissions } } };
      }
      case "refresh": return { ClaimOrRefresh: { by: { NeuronId: {} } } };
      case "advanced": return { [kind]: JSON.parse(raw) };
      case "transfer": return undefined;
    }
  };
  const prepare = async () => {
    setBusy(true); setError(undefined);
    try {
      const id = operationId();
      if (action === "transfer") {
        const to = Principal.fromText(target.trim()).toText();
        if (to === principal) throw new Error("Choose a recipient other than this Neutron.");
        setPreview({ id, review: { recipient: to, keepVotingAccess: keepVoting, permissions: caps.permissions,
          steps: ["Grant the recipient the permissions currently held by this Neutron.", "Remove this Neutron’s permissions except retained voting access, if chosen."],
          note: "Other principals retain their existing grants. The recipient can change access after the first step." } });
      } else {
        const value = command();
        candidValueFromJson(governanceCommandType(), value);
        const response = await invoke<{ review: unknown }>("sns_preview_neuron_v1", { operationId: id, rootCanisterId: entry.canisters.root, neuronId: neuron.id, command: value });
        setPreview({ id, command: value, review: response.review });
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  const execute = async () => {
    if (!preview || busy || operation) return;
    const id = preview.id; setBusy(true); setOperation({ id });
    try {
      const result = await invoke(action === "transfer" ? "sns_transfer_control_v1" : "sns_manage_neuron_v1", {
        rootCanisterId: entry.canisters.root, neuronId: neuron.id, operationId: id,
        ...(action === "transfer" ? { toPrincipal: target.trim(), keepVotingAccess: keepVoting } : { command: preview.command }),
      });
      setOperation({ id, result }); onChanged();
    } catch (caught) { setOperation({ id, error: String(caught) }); }
    finally { setBusy(false); }
  };
  const changingAccess = action === "share" || action === "remove";
  const rewards = ["stakeRewards", "mergeRewards", "withdrawRewards"].includes(action);
  const schemaType = candidVariantFields(governanceCommandType()).find(([name]) => name === kind)?.[1];
  return <Dialog title={TITLES[action]} onClose={onClose} footer={!operation && (!preview
    ? <button className="nt-button nt-button--primary" type="button" disabled={busy} onClick={() => void prepare()}>{busy ? "Checking command…" : "Preview change"}</button>
    : <button className="nt-button nt-button--primary" type="button" disabled={busy} onClick={() => void execute()}>Continue to review</button>)}>
    {operation ? <><NeuronOperationResult {...operation} />{busy && <Pending label="Waiting for reviewed neuron operation" />}</> : <>
      <p>Current stake: <strong>{neuronAmount(neuron.stakeE8s, entry)}</strong> · {neuronUnlock(neuron).label}</p>
      <p className="nt-meta">{neuronUnlock(neuron).detail}</p>
      {action === "start" && <p>Start the unlock countdown. Starting to unlock resets the age bonus to zero; the remaining delay decreases until stake is ready for withdrawal.</p>}
      {action === "stop" && <p>Stop the countdown at the remaining unlock delay. The neuron becomes locked and starts aging again; the previous age bonus is not restored.</p>}
      {action === "delay" && <><DurationField label="Additional unlock delay" value={duration} unit={durationUnit} onChange={change(setDuration)} onUnitChange={change(setDurationUnit)} disabled={busy} /><p>The delay can be increased but cannot be shortened. Enter the additional time to add.</p></>}
      {action === "auto" && <label className="snsgov-check-label"><input type="checkbox" checked={auto} disabled={busy} onChange={event => { setAuto(event.target.checked); reset(); }} /> Automatically stake future maturity</label>}
      {rewards && <><Field label="Rewards to use (%)" value={percentage} onChange={change(setPercentage)} inputMode="numeric" disabled={busy} /><p>Available maturity: {neuronAmount(neuron.maturityE8s, entry)} equivalent.</p>
        <p>{action === "withdrawRewards" ? "Maturity is deducted when requested. Tokens are minted after the SNS waiting period, normally at least seven days; maturity modulation may change the final amount." : action === "stakeRewards" ? "This moves maturity into staked maturity, increasing voting stake without creating a liquid token balance." : "This converts the selected maturity into this neuron’s token stake under the SNS rules."}</p></>}
      {(action === "withdraw" || action === "split") && <Field label={`Amount${entry.token ? ` (${entry.token.symbol})` : ""}`} value={amount} onChange={change(setAmount)} inputMode="decimal" disabled={busy} help={action === "withdraw" ? "Leave blank to withdraw the available stake. The SNS deducts applicable fees." : "The split amount is deducted from this neuron; the child receives it after its transfer fee. Both neurons must meet the community’s minimum stake."} />}
      {(action === "withdraw" || action === "withdrawRewards") && <Field label="Destination account" value={destination} onChange={change(setDestination)} disabled={busy} help="Enter a principal for its default account, or a checksummed ICRC account address." />}
      {action === "split" && <><p>Current transfer fee: {parameters?.transactionFeeE8s === undefined ? "Not reported" : neuronAmount(parameters.transactionFeeE8s, entry)}. Minimum stake: {parameters?.neuronMinimumStakeE8s === undefined ? "Not reported" : neuronAmount(parameters.neuronMinimumStakeE8s, entry)}.</p><Disclosure title="Split identifier"><Field label="Split nonce" value={memo} onChange={change(setMemo)} inputMode="numeric" disabled={busy} help="This identifier determines the new neuron and is saved unchanged with the operation." /></Disclosure></>}
      {(action === "follow" || action === "topic") && <>
        {action === "follow" ? <Field label="Proposal type ID" value={functionId} onChange={change(setFunctionId)} inputMode="numeric" disabled={busy} /> : <div className="snsgov-neuron-field"><label className="nt-label" htmlFor="snsgov-follow-topic">Topic</label><select id="snsgov-follow-topic" className="nt-input" value={topic} disabled={busy} onChange={event => { setTopic(event.target.value); reset(); }}>{TOPICS.map(value => <option key={value} value={value}>{value.replace(/([a-z])([A-Z])/g, "$1 $2")}</option>)}</select></div>}
        <Field label="Followee neuron IDs" value={followees} onChange={change(setFollowees)} multiline disabled={busy} help="One ID per line. Leave empty to remove following for this selected proposal type or topic." /><p>Following lets this neuron vote automatically based on the chosen neurons for this proposal type or topic.</p>
      </>}
      {(changingAccess || action === "transfer") && <Field label={action === "transfer" ? "Recipient principal" : "Principal to change"} value={target} onChange={change(setTarget)} disabled={busy} />}
      {changingAccess && <fieldset className="snsgov-neuron-permissions"><legend>Permissions to {action === "share" ? "grant" : "remove"}</legend>
        {Object.entries(PERMISSION_LABELS).filter(([id]) => Number(id) > 0 && (caps.canManagePrincipals || [3, 4, 10].includes(Number(id)))).map(([id, label]) => <label key={id} className="snsgov-check-label"><input type="checkbox" checked={permissions.includes(Number(id))} disabled={busy} onChange={event => { setPermissions(values => event.target.checked ? [...values, Number(id)] : values.filter(value => value !== Number(id))); reset(); }} /> {label} ({id})</label>)}
      </fieldset>}
      {action === "remove" && <p>Removing management permissions can make the neuron inaccessible to that principal. Review each permission and the remaining access.</p>}
      {action === "transfer" && <><label className="snsgov-check-label"><input type="checkbox" checked={keepVoting} disabled={busy} onChange={event => { setKeepVoting(event.target.checked); reset(); }} /> Keep this Neutron’s existing Vote and Submit proposals permissions</label><p>This is a two-step handover: grant the recipient this Neutron’s permissions, then remove this Neutron’s control. Other principals keep their grants. The recipient can change access between these steps.</p></>}
      {action === "refresh" && <p>Read the neuron’s staking account and ask governance to update the recorded stake. This does not send a new token transfer.</p>}
      {action === "advanced" && <>
        <p>Every supported manage_neuron command is available here. The same permission checks, exact review and saved operation apply.</p>
        <div className="snsgov-neuron-field"><label className="nt-label" htmlFor="snsgov-command-kind">Command</label><select className="nt-input" id="snsgov-command-kind" value={kind} disabled={busy} onChange={event => { setKind(event.target.value); setRaw(jsonText(EXAMPLES[event.target.value] ?? {})); reset(); }}>{NEURON_COMMANDS.map(item => <option key={item.kind} value={item.kind}>{item.title} ({item.kind})</option>)}</select></div>
        <Field label="Command fields (JSON)" value={raw} onChange={change(setRaw)} multiline disabled={busy} help="Use decimal strings for exact integers, principal strings, {hex: &quot;…&quot;} for bytes, null for absent optionals, and single-key objects for variants." />
        <Disclosure title="Command field schema"><pre className="snsgov-code">{schemaType ? jsonText(candidTypeSchema(schemaType)) : "Unavailable"}</pre></Disclosure>
      </>}
      <ErrorNote message={error ?? null} />
      {preview && <section className="snsgov-neuron-review"><h3 className="nt-section-heading">Change ready for review</h3><p>{TITLES[action]} for this neuron. Review the exact command before authorizing it.</p>
          <Disclosure title="Exact preview"><pre className="snsgov-code">{jsonText(preview.review)}</pre></Disclosure>
          </section>}
    </>}
  </Dialog>;
}
