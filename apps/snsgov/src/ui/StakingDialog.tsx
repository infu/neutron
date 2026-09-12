import { useEffect, useState } from "react";
import { Principal } from "@dfinity/principal";
import { invoke, operationId } from "../data/actions_client";
import { NEURON_PERMISSIONS } from "../data/neuron_actions";
import { readParameters } from "../data/governance";
import { balanceOf, readTokenInfo } from "../data/ledger";
import { readHotkey } from "../data/relay";
import { formatDuration, parseTokenAmount } from "../data/format";
import { displayName, type RegistryEntry } from "../data/registry";
import { Dialog, Disclosure, ErrorNote, Help, useRead } from "./Common";
import { Pending } from "./Status";
import { DurationField, Field, jsonText, neuronAmount, NeuronOperationResult } from "./NeuronFields";

export function StakingDialog({ entries, initialRootCanisterId, neuronId, onClose, onComplete }: {
  entries: RegistryEntry[]; initialRootCanisterId?: string | undefined; neuronId?: string; onClose: () => void; onComplete: () => void;
}) {
  const [root, setRoot] = useState(initialRootCanisterId ?? entries[0]?.canisters.root ?? "");
  const [amount, setAmount] = useState("");
  const [delay, setDelay] = useState("0");
  const [unit, setUnit] = useState("86400");
  const [preview, setPreview] = useState<{ args: Record<string, unknown>; value: unknown }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [operation, setOperation] = useState<{ id: string; result?: unknown; error?: string }>();
  const [refresh, setRefresh] = useState(0);
  const entry = entries.find(item => item.canisters.root === root);
  useEffect(() => { if (!root && entries[0]) setRoot(entries[0].canisters.root); }, [entries, root]);
  const state = useRead(root || null, async () => {
    if (!entry) throw new Error("Choose a community.");
    const [token, parameters, hotkey] = await Promise.all([readTokenInfo(entry.canisters.ledger), readParameters(entry.canisters.governance), readHotkey()]);
    const balance = await balanceOf(entry.canisters.ledger, { owner: Principal.fromText(hotkey.principal) });
    return { token, parameters, principal: hotkey.principal, balance };
  }, refresh);
  const reset = () => { setPreview(undefined); setError(undefined); };
  const known = entry && state.data ? { ...entry, token: state.data.token } : undefined;
  let atoms: bigint | undefined;
  let seconds: bigint | undefined;
  let validation = "";
  try {
    if (!state.data) throw new Error("Token scale, fee, minimum stake and account balance must be read before continuing.");
    atoms = parseTokenAmount(amount, state.data.token.decimals);
    if (atoms <= 0n) throw new Error("Enter an amount greater than zero.");
    if (atoms + state.data.token.fee > state.data.balance) throw new Error("The amount plus transfer fee exceeds this account’s available balance.");
    if (!neuronId && state.data.parameters.neuronMinimumStakeE8s !== undefined && atoms < state.data.parameters.neuronMinimumStakeE8s) throw new Error("The amount is below this community’s minimum stake.");
    if (!/^\d+$/.test(delay.trim())) throw new Error("Enter a whole number for the unlock delay.");
    seconds = BigInt(delay) * BigInt(unit);
    if (!neuronId && state.data.parameters.maxDissolveDelaySeconds !== undefined && seconds > state.data.parameters.maxDissolveDelaySeconds) throw new Error("The unlock delay exceeds this community’s maximum.");
  } catch (caught) { validation = caught instanceof Error ? caught.message : String(caught); }
  const prepare = async () => {
    if (!entry || atoms === undefined || seconds === undefined || validation) return;
    setBusy(true); setError(undefined);
    try {
      const args: Record<string, unknown> = { operationId: operationId(), rootCanisterId: root, amountAtoms: atoms.toString(), ...(neuronId ? { neuronId } : { dissolveDelaySeconds: seconds.toString() }) };
      const value = neuronId ? { action: "Increase stake", amountAtoms: atoms.toString(), neuronId }
        : (await invoke<{ review: unknown }>("sns_stake_preview_v1", args)).review;
      setPreview({ args, value });
    } catch (caught) { setError(String(caught)); }
    finally { setBusy(false); }
  };
  const execute = async () => {
    if (!preview || busy || operation) return;
    const id = String(preview.args.operationId);
    setBusy(true); setOperation({ id });
    try {
      const result = await invoke(neuronId ? "sns_top_up_v1" : "sns_stake_v1", { ...preview.args, operationId: id });
      setOperation({ id, result }); onComplete();
    } catch (caught) { setOperation({ id, error: String(caught) }); }
    finally { setBusy(false); }
  };
  return <Dialog title={neuronId ? "Increase stake" : "Stake tokens"} onClose={onClose} footer={!operation && <div className="snsgov-neuron-dialog-footer">
    {known && atoms !== undefined && !validation && <strong>Total: {neuronAmount(atoms + known.token!.fee, known)}</strong>}
    {!preview ? <button className="nt-button nt-button--primary" type="button" disabled={busy || !!validation || state.loading} onClick={() => void prepare()}>{busy ? "Preparing stake…" : "Preview stake"}</button>
      : <button className="nt-button nt-button--primary" type="button" disabled={busy || state.loading} onClick={() => void execute()}>Continue to {neuronId ? "increase stake" : "stake"} review</button>}
    </div>}>
    <p>{neuronId ? "Add tokens to this neuron and refresh its recorded stake. Adding stake can reduce its age bonus." : "Stake tokens in a new neuron for this Neutron. Review the controls this community grants before staking."}</p>
    {operation ? <><NeuronOperationResult {...operation} />{busy && <Pending label="Waiting for reviewed staking operation" />}</> : <>
      <div className="snsgov-neuron-field"><label className="nt-label" htmlFor="snsgov-stake-community">Community</label>
        <select className="nt-input" id="snsgov-stake-community" value={root} disabled={!!neuronId || busy} onChange={event => { setRoot(event.target.value); setAmount(""); reset(); }}>
          <option value="" disabled>Choose a community</option>{entries.map(item => <option key={item.canisters.root} value={item.canisters.root}>{displayName(item)}</option>)}</select></div>
      {state.loading && <Pending label="Reading token, fees and Neutron balance" />}
      <ErrorNote message={state.error} />
      {state.error && <button className="nt-button nt-button--secondary" type="button" onClick={() => setRefresh(value => value + 1)}>Retry account read</button>}
      {state.data && known && <>
        <dl className="nt-detail-grid snsgov-neuron-values"><div><dt>Available in Neutron account</dt><dd>{neuronAmount(state.data.balance, known)}</dd></div>
          <div><dt>Transfer fee</dt><dd>{neuronAmount(state.data.token.fee, known)}</dd></div>
          {!neuronId && <div><dt>Minimum stake</dt><dd>{state.data.parameters.neuronMinimumStakeE8s === undefined ? "Not reported" : neuronAmount(state.data.parameters.neuronMinimumStakeE8s, known)}</dd></div>}</dl>
        <Disclosure title="Account and initial controls"><p className="nt-meta">Neutron’s default account on the {state.data.token.symbol} ledger</p><code className="nt-code">{state.data.principal}</code>
          {!neuronId && <p className="nt-meta">Your controls: {state.data.parameters.neuronClaimerPermissions?.map(id => NEURON_PERMISSIONS[id] ?? `Permission ${id}`).join(", ") || "Not reported. Review the community’s grant before staking."}</p>}
        </Disclosure>
      </>}
      <Field label={`Amount${state.data ? ` (${state.data.token.symbol})` : ""}`} value={amount} onChange={value => { setAmount(value); reset(); }} inputMode="decimal" disabled={busy} help="The transfer fee is additional to the amount staked." />
      {!neuronId && <><DurationField label="Unlock delay" value={delay} unit={unit} onChange={value => { setDelay(value); reset(); }} onUnitChange={value => { setUnit(value); reset(); }} disabled={busy} />
        <p>The unlock countdown starts only when you choose Start unlocking. <Help label="staking unlock delay">A new neuron starts locked. Starting to unlock begins the countdown; it does not withdraw tokens. Increasing the delay cannot be undone by reducing it.</Help></p>
        {state.data?.parameters.neuronMinimumDissolveDelayToVoteSeconds !== undefined && <p className="nt-meta">Minimum delay to vote: {formatDuration(state.data.parameters.neuronMinimumDissolveDelayToVoteSeconds)}. {seconds !== undefined && seconds < state.data.parameters.neuronMinimumDissolveDelayToVoteSeconds ? "This delay does not qualify for voting." : "Each new proposal determines its own eligible neurons."}</p>}
      </>}
      {known && atoms !== undefined && !validation && <p><strong>Total leaving your account: {neuronAmount(atoms + known.token!.fee, known)}</strong></p>}
      {amount && validation && <p role="alert" className="nt-field-error">{validation}</p>}
      <ErrorNote message={error ?? null} />
      {preview && <section className="snsgov-neuron-review"><h3 className="nt-section-heading">Review {neuronId ? "stake increase" : "new stake"}</h3>
          <p>{neuronId ? "The existing neuron receives this deposit." : "This deposits tokens, claims the same intended neuron, and applies the reviewed unlock delay."} If a step is interrupted, continue the saved operation from Activity.</p>
          <Disclosure title="Exact preview"><pre className="snsgov-code">{jsonText(preview.value)}</pre></Disclosure>
          </section>}
    </>}
  </Dialog>;
}
