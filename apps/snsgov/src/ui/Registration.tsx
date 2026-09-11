import { useRef, useState } from "react";
import { copyToClipboard, querySelf, updateSelf } from "neutron-tools/app";
import { invoke, operationId } from "../data/actions_client";
import { readRegistration, type NeuronRegistration } from "../data/registration";
import { readHotkey } from "../data/relay";
import type { NeuronOperationResult } from "../data/neuron_actions";
import { shortenId } from "../data/format";
import { Disclosure, ErrorNote, useRead } from "./Common";

export interface RegistrationTarget {
  rootCanisterId: string;
  governanceCanisterId: string;
  label: string;
}

interface Allowlisted { votingEnabled: boolean; agentVotingEnabled: boolean; present: boolean; label: string }
interface PermissionAction { id: string; result?: NeuronOperationResult; error?: string }

async function readAllowlisted(rootCanisterId: string): Promise<Allowlisted> {
  const raw = await querySelf("snsgov_config", [null]) as unknown as {
    snses: { sns: string | { toText(): string }; voting_enabled?: boolean; agent_voting_enabled?: boolean; label_text?: string }[];
  };
  const row = raw.snses.find(entry => (typeof entry.sns === "string" ? entry.sns : entry.sns.toText()) === rootCanisterId);
  return { present: row !== undefined, votingEnabled: Boolean(row?.voting_enabled), agentVotingEnabled: Boolean(row?.agent_voting_enabled), label: row?.label_text ?? "" };
}

export function RegistrationButton({ target, onChanged }: { target: RegistrationTarget; onChanged?: () => void }) {
  return <VotingAccess key={`${target.rootCanisterId}:${target.governanceCanisterId}`} target={target} {...(onChanged ? { onChanged } : {})} />;
}

function VotingAccess({ target, onChanged }: { target: RegistrationTarget; onChanged?: () => void }) {
  const [opened, setOpened] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [actions, setActions] = useState<Record<string, PermissionAction>>({});
  const running = useRef(false);
  const key = opened ? `${target.rootCanisterId}:${target.governanceCanisterId}` : null;
  const read = useRead(key, async () => {
    const hotkey = await readHotkey();
    const [status, allowlisted] = await Promise.all([
      readRegistration(target.governanceCanisterId, hotkey.principal), readAllowlisted(target.rootCanisterId),
    ]);
    return { hotkey, status, allowlisted };
  }, refresh);
  const data = read.data;
  const refreshAccess = () => { setRefresh(value => value + 1); onChanged?.(); };

  const enableVoting = async () => {
    if (!data || running.current) return;
    running.current = true;
    setBusy(true);
    setMessage(null);
    try {
      // This changes an app preference. Permission changes below use the resident tool.
      const current = await readAllowlisted(target.rootCanisterId);
      await updateSelf("snsgov_sns_upsert", [{
        sns: target.rootCanisterId, governance: target.governanceCanisterId,
        voting_enabled: true, agent_voting_enabled: current.agentVotingEnabled, label_text: (current.label || target.label).slice(0, 64),
      }]);
      refreshAccess();
    } catch (error) { setMessage(String(error)); }
    finally { running.current = false; setBusy(false); }
  };

  const grant = async (neuron: NeuronRegistration) => {
    if (!data || running.current) return;
    const permissions = grantable(neuron);
    if (permissions.length === 0) return;
    const id = operationId();
    running.current = true;
    setBusy(true);
    setMessage(null);
    setActions(previous => ({ ...previous, [neuron.neuronId]: { id } }));
    try {
      const result = await invoke<NeuronOperationResult>("sns_manage_neuron_v1", {
        operationId: id, rootCanisterId: target.rootCanisterId, neuronId: neuron.neuronId,
        command: { AddNeuronPermissions: { principal_id: data.hotkey.principal, permissions_to_add: { permissions } } },
      });
      setActions(previous => ({ ...previous, [neuron.neuronId]: { id, result } }));
      refreshAccess();
    } catch (error) {
      setActions(previous => ({ ...previous, [neuron.neuronId]: { id, error: String(error) } }));
    } finally { running.current = false; setBusy(false); }
  };

  const checkAction = async (neuronId: string, action: PermissionAction) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const result = await invoke<NeuronOperationResult>("sns_operation_status_v1", { operationId: action.id });
      setActions(previous => ({ ...previous, [neuronId]: { id: action.id, result } }));
      refreshAccess();
    } catch (error) { setMessage(String(error)); }
    finally { running.current = false; setBusy(false); }
  };

  const copyPrincipal = async () => {
    if (!data) return;
    try { await copyToClipboard(data.hotkey.principal); setCopied(true); }
    catch (error) { setMessage(`Could not copy your principal: ${String(error)}`); }
  };
  const voteCount = data?.status.found.filter(neuron => !neuron.missing.includes(4)).length ?? 0;
  const proposeCount = data?.status.found.filter(neuron => !neuron.missing.includes(3)).length ?? 0;
  const incomplete = data?.status.truncated || (data?.status.failures?.length ?? 0) > 0;

  return <details className="nt-disclosure snsgov-disclosure snsgov-voting-access" onToggle={event => {
    if (event.currentTarget.open) setOpened(true);
  }}>
    <summary className="snsgov-disclosure-summary"><span>Voting access</span><span aria-hidden="true">⌄</span></summary>
    <div className="snsgov-disclosure-body">
      <div className="snsgov-settings-row-head">
        <strong>{target.label}</strong>
        <button className="nt-button nt-button--ghost" disabled={busy || read.loading} onClick={() => setRefresh(value => value + 1)} type="button">
          {read.loading ? "Checking access…" : "Refresh access"}
        </button>
      </div>
      <ErrorNote message={read.error || message} />
      {!data && read.loading && <p className="nt-meta" role="status">Checking the permissions granted to this Neutron…</p>}
      {data && <>
        <p className="nt-text">{voteCount} neuron{voteCount === 1 ? "" : "s"} can vote · {proposeCount} can propose.</p>
        <p className="nt-meta">{data.allowlisted.votingEnabled ? "This community is connected." : "This community is disconnected in the app."}</p>
        {!data.allowlisted.votingEnabled && <div className="snsgov-settings-actions"><button className="nt-button" disabled={busy || read.loading} onClick={() => void enableVoting()} type="button">Connect {target.label}</button></div>}
        {!data.hotkey.canManageNeuron && <p className="nt-alert nt-alert--warning" role="status">The installed app does not have its governance signing capability. Install a compatible app update before changing neuron permissions.</p>}
        {incomplete && <p className="nt-alert nt-alert--warning" role="status">Access checks are incomplete. Additional neurons or permissions may be unavailable until you refresh.</p>}
        {data.status.found.length === 0 && <p className="nt-text">{incomplete
          ? "No neurons were found in the available results."
          : "No neurons in this community currently name this Neutron."} In the wallet that controls your neuron, add the principal below with Vote permission, then refresh access.</p>}
        <Disclosure title="Connect from another wallet">
          <p className="nt-text">Add this principal as a hotkey with Vote (4). Also add SubmitProposal (3) to let this Neutron publish proposals.
            These permissions alone do not move tokens or change a neuron's unlock date.</p>
          <div className="snsgov-principal-row">
            <code className="nt-code snsgov-principal-text">{data.hotkey.principal}</code>
            <button className="nt-button nt-button--ghost" onClick={() => void copyPrincipal()} type="button">{copied ? "Copied" : "Copy principal"}</button>
          </div>
          <p className="nt-meta">A principal with ManagePrincipals or ManageVotingPermission must grant the relevant permissions. The SNS also decides which permissions may be granted.</p>
        </Disclosure>
        {data.status.found.length > 0 && <Disclosure title="Neuron permissions">
          <ul className="snsgov-settings-list">
            {data.status.found.map(neuron => {
              const permissions = grantable(neuron);
              const action = actions[neuron.neuronId];
              const unresolved = action !== undefined && action.result?.status !== "completed" && action.result?.status !== "rejected";
              const external = neuron.missing.some(permission => !permissions.includes(permission));
              return <li className="snsgov-settings-row" key={neuron.neuronId}>
                <strong>Neuron {shortenId(neuron.neuronId, 6, 4)}</strong>
                <p className="nt-meta">{neuron.missing.includes(4) ? "Cannot vote" : "Can vote"} · {neuron.missing.includes(3) ? "Cannot propose" : "Can propose"}</p>
                <code className="nt-code snsgov-principal-text">{neuron.neuronId}</code>
                {permissions.length > 0 && !unresolved && <>
                  <p className="nt-text">This Neutron can add {permissionNames(permissions)} to its own access on this neuron.</p>
                  <button className="nt-button" disabled={busy || read.loading || !data.hotkey.canManageNeuron || !data.allowlisted.votingEnabled}
                    onClick={() => void grant(neuron)} type="button">Add {permissionNames(permissions)}</button>
                </>}
                {external && <a className="nt-link" href={`https://nns.ic0.app/neuron/?u=${encodeURIComponent(target.rootCanisterId)}&neuron=${encodeURIComponent(neuron.neuronId)}`} target="_blank" rel="noreferrer noopener">Manage missing permissions in NNS dapp</a>}
                {action && <div className="snsgov-permission-outcome" role="status">
                  <p>{action.result?.status === "completed" ? "Permission change confirmed." : action.result?.status === "rejected" ? "The permission change was rejected." : "The permission change is not confirmed. Check its saved status before trying again."}</p>
                  <ErrorNote message={action.error || action.result?.message || null} />
                  <button className="nt-button nt-button--ghost" disabled={busy} onClick={() => void checkAction(neuron.neuronId, action)} type="button">Check saved status</button>
                  <Disclosure title="Permission change details">
                    <p className="nt-meta">Operation <code className="nt-code snsgov-principal-text">{action.id}</code></p>
                    {action.result && <pre className="nt-pre nt-pre--wrap">{JSON.stringify(action.result.outcomes ?? action.result, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2)}</pre>}
                    <p className="nt-meta">Activity keeps this action's saved result and any next steps.</p>
                  </Disclosure>
                </div>}
              </li>;
            })}
          </ul>
        </Disclosure>}
        {(data.status.failures?.length ?? 0) > 0 && <Disclosure title="Unavailable access reads">
          <ul className="snsgov-settings-list">{data.status.failures!.map((failure, index) => <li className="snsgov-settings-row" key={`${failure.scope}:${index}`}>
            <p className="nt-text">{failure.message}</p><code className="nt-code snsgov-principal-text">{failure.code} · {failure.scope}</code>
          </li>)}</ul>
        </Disclosure>}
      </>}
    </div>
  </details>;
}

function grantable(neuron: NeuronRegistration): number[] {
  const canManage = neuron.held?.some(permission => permission === 2 || permission === 10) ?? false;
  return canManage ? (neuron.grantableMissing ?? []).filter(permission => permission === 3 || permission === 4) : [];
}
function permissionNames(permissions: number[]): string {
  return permissions.map(permission => permission === 4 ? "Vote" : "SubmitProposal").join(" and ");
}
