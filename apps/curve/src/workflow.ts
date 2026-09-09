import { getAddress, keccak256, stringToHex } from "viem";
import { parseEvmOperationResult, parseEvmSendTransactionRequest, parseEvmTransactionResult, type EvmAccount, type EvmOperationResult, type EvmSendTransactionRequest, type EvmTransactionResult, type EvmWalletCaller, type EvmWalletClient } from "neutron-tools/evm_wallet";
import { parseInput, preparePlan, type Input, type Plan } from "./plans.ts";
import { stable, type RecordRow, type Store } from "./store.ts";
import { errorMessage } from "./pools.ts";

export type Intent = { version: 1; operationId: string; attempt: string; account: EvmAccount; input: Input; caller: EvmWalletCaller | null; agentMode: boolean };
export type JournalStep = {
  request: EvmSendTransactionRequest; dispatched: boolean; unresolved: boolean;
  operation: EvmOperationResult | null; evidence: EvmTransactionResult | null;
};
export type State = { version: 1; plan: Plan; steps: JournalStep[]; successor: string | null };
export type Result = {
  operationId: string; recordId: string | null; summary: string; state: "complete" | "pending" | "review" | "stopped";
  phase: string; transactionHash: string | null; message: string;
  steps: { label: string; status: string; transactionHash: string | null }[];
};
export type RunOptions = {
  signal?: AbortSignal; now?: () => number; wait?: (signal?: AbortSignal) => Promise<void>;
  prepare?: typeof preparePlan; onRecord?: (record: RecordRow) => void; onProgress?: (message: string) => void;
  /** Status reconciliation can update observations or resend already signed
   * bytes. Only an explicit continuation may request fresh Wallet reviews. */
  execute?: boolean;
};
export function operationId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/.test(value)) throw new Error("Keep one 32-hex operation ID and reuse it after an interrupted reply.");
  return value;
}
export function attemptId(id: string, attempt: string): string {
  return attempt === "0" ? id : keccak256(stringToHex(`neutron:curve:attempt:v1:${id}:${attempt}`)).slice(2, 34);
}
export function requestId(id: string, index: number): string {
  return keccak256(stringToHex(`neutron:curve:transaction:v1:${id}:${index}`)).slice(2, 34);
}
function sameAccount(a: EvmAccount, b: EvmAccount): boolean {
  return a.accountId === b.accountId && a.address.toLowerCase() === b.address.toLowerCase() && a.keyFingerprint === b.keyFingerprint && a.namespaceVersion === b.namespaceVersion;
}
export function intentOf(record: RecordRow): Intent {
  const intent = JSON.parse(record.input_json) as Intent;
  if (intent.version !== 1 || !/^(0|[1-9][0-9]*)$/.test(intent.attempt) || attemptId(operationId(intent.operationId), intent.attempt) !== record.id || record.root_id !== intent.operationId || typeof intent.agentMode !== "boolean") throw new Error("Invalid saved Curve operation identity.");
  if (!intent.account || intent.account.accountId !== "main" || typeof intent.account.keyFingerprint !== "string" || typeof intent.account.namespaceVersion !== "string") throw new Error("Invalid saved signing identity.");
  getAddress(intent.account.address);
  if (intent.agentMode && !intent.caller) throw new Error("Agent operations require their authenticated caller.");
  if (intent.caller && (typeof intent.caller.appId !== "string" || !/^[1-9][0-9]*$/.test(intent.caller.installationUid))) throw new Error("Invalid saved caller.");
  if (stable(parseInput(intent.input)) !== stable(intent.input)) throw new Error("Saved Curve inputs changed.");
  return intent;
}
function validatePlan(intent: Intent, plan: Plan) {
  if (!plan || plan.chainId !== intent.input.chainId || getAddress(plan.accountAddress) !== getAddress(intent.account.address) || !/^[1-9][0-9]*$/.test(plan.validUntil) || !Array.isArray(plan.steps) || !plan.steps.length || plan.steps.at(-1)?.kind !== "transaction") throw new Error("The transaction plan changed its account, network or final action.");
  for (const step of plan.steps) {
    if (step.transaction.chainId !== intent.input.chainId || step.transaction.accountId !== "main" || !["approval", "transaction"].includes(step.kind)) throw new Error("A plan step changed the account or network.");
    parseEvmSendTransactionRequest({ ...step.transaction, requestId: "0".repeat(32) });
  }
}
export function stateOf(record: RecordRow): State {
  const intent = intentOf(record), state = JSON.parse(record.state_json) as State;
  if (state.version !== 1 || !Array.isArray(state.steps) || (state.successor !== null && state.successor !== attemptId(intent.operationId, String(BigInt(intent.attempt) + 1n)))) throw new Error("Invalid saved Curve progress.");
  validatePlan(intent, state.plan);
  if (state.steps.length !== state.plan.steps.length) throw new Error("The saved step count changed.");
  state.steps.forEach((step, index) => {
    const expected = parseEvmSendTransactionRequest({ ...state.plan.steps[index]!.transaction, requestId: requestId(record.id, index) });
    if (stable(parseEvmSendTransactionRequest(step.request)) !== stable(expected) || typeof step.dispatched !== "boolean" || typeof step.unresolved !== "boolean" || (step.unresolved && !step.dispatched)) throw new Error("Saved Wallet request changed.");
    if (step.operation) validateOperation(intent, step, step.operation);
    if (step.evidence) {
      if (!step.operation || ![step.operation.transactionHash, step.operation.replacementTransactionHash].includes(step.evidence.transactionHash)) throw new Error("Transaction evidence is not linked to this Wallet request.");
      parseEvmTransactionResult(step.evidence, { chainId: intent.input.chainId, transactionHash: step.evidence.transactionHash });
    }
  });
  return state;
}
function validateOperation(intent: Intent, step: JournalStep, raw: unknown) {
  const operation = parseEvmOperationResult(raw, step.request, "transaction");
  if (getAddress(operation.address) !== getAddress(intent.account.address)) throw new Error("Wallet operation belongs to another signing account.");
  return operation;
}
function stepView(intent: Intent, step: JournalStep) {
  const hash = step.evidence?.transactionHash ?? step.operation?.transactionHash ?? null;
  if (step.unresolved) return { status: "unknown", transactionHash: hash };
  const evidence = step.evidence, actual = evidence?.transaction;
  if (evidence) {
    if (!actual) return { status: "unknown", transactionHash: hash };
    if (getAddress(actual.from) !== getAddress(intent.account.address) || actual.to?.toLowerCase() !== step.request.to.toLowerCase() || actual.valueWei !== step.request.valueWei || actual.data.toLowerCase() !== step.request.data.toLowerCase()) return { status: evidence.receipt ? "replaced" : "unknown", transactionHash: hash };
    return { status: evidence.receipt ? evidence.receipt.status === "success" ? "confirmed" : "reverted" : "submitted", transactionHash: hash };
  }
  return { status: step.operation?.receipt ? "unknown" : step.operation?.status ?? "queued", transactionHash: hash };
}
const stopped = ["rejected", "reverted", "failed", "replaced"];
export function resultOf(record: RecordRow, override?: Result["state"], message?: string): Result {
  const intent = intentOf(record), saved = stateOf(record), views = saved.steps.map((step) => stepView(intent, step)), final = views.at(-1)!;
  const state = override ?? (final.status === "confirmed" ? "complete" : views.some((step) => stopped.includes(step.status)) ? "stopped" : views.some((step) => ["preparing", "prepared"].includes(step.status)) ? "review" : "pending");
  return { operationId: intent.operationId, recordId: record.id, summary: saved.plan.summary, state, phase: record.phase, transactionHash: final.transactionHash,
    message: message ?? (state === "complete" ? "Confirmed. The final transaction completed successfully." : state === "stopped" ? "The operation stopped before completion. Token approval alone does not complete it." : state === "review" ? "Continue to review the updated transaction in your wallet." : "Progress is saved. Continue with this operation ID to reconcile and finish."),
    steps: views.map((view, i) => ({ ...view, label: saved.plan.steps[i]!.label })) };
}
/** A tracking interruption does not undo a saved final receipt or rejection. */
export function trackingPausedResult(record: RecordRow): Result {
  const result = resultOf(record);
  return result.state === "complete" || result.state === "stopped" ? result : {
    ...result, state: "pending", message: "Tracking paused. Continue this same operation ID; an interrupted reply does not mean the transaction failed.",
  };
}
export async function latestRecord(store: Store, id: string): Promise<RecordRow | null> {
  let row = await store.get(id);
  while (row) {
    const intent = intentOf(row), nextId = stateOf(row).successor;
    if (!nextId) return row;
    const next = await store.get(nextId);
    if (!next) return row;
    const successor = intentOf(next);
    if (stable(intent.input) !== stable(successor.input) || stable(intent.caller) !== stable(successor.caller) || intent.agentMode !== successor.agentMode || !sameAccount(intent.account, successor.account)) throw new Error("Renewed operation changed the original inputs or owner.");
    row = next;
  }
  return null;
}
function waitForReceipt(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, 2500);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}
class ConcurrentUpdate extends Error {}
class InitialPreparationFailed extends Error {}

export async function runOperation(wallet: EvmWalletClient, store: Store, id: string, raw: Input, caller: EvmWalletCaller | null, agentMode: boolean, options: RunOptions = {}): Promise<Result> {
  operationId(id);
  const input = parseInput(raw), now = options.now ?? Date.now, execute = options.execute !== false;
  if (agentMode && !caller) throw new Error("Agent operations require an authenticated caller.");
  const abort = () => options.signal?.throwIfAborted(), callOptions = options.signal ? { signal: options.signal } : undefined;
  const owner = (row: RecordRow) => {
    const intent = intentOf(row);
    if (stable(input) !== stable(intent.input) || stable(caller) !== stable(intent.caller) || agentMode !== intent.agentMode) throw new Error("Continue with the original inputs and caller; this operation ID is already in use.");
    return intent;
  };
  const account = async (prior?: EvmAccount) => {
    abort();
    const selected = (await wallet.accounts(callOptions)).accounts.find((account) => account.accountId === "main");
    if (!selected || (prior && !sameAccount(prior, selected))) throw new Error("The EVM Wallet signing identity changed. Reconcile with the original wallet.");
    return selected;
  };
  let row: RecordRow | null = null;
  const remember = (saved: RecordRow) => { row = saved; options.onRecord?.(saved); return saved; };
  const persist = async (saved: RecordRow, state: State, phase: string) => {
    abort();
    try { return remember(await store.update(saved, state, phase)); }
    catch (error) {
      const latest = await store.get(saved.id);
      if (latest && latest.revision !== saved.revision) { remember(latest); throw new ConcurrentUpdate(); }
      throw error;
    }
  };
  const create = async (attempt: string, prior?: EvmAccount) => {
    const recordId = attemptId(id, attempt), existing = await store.get(recordId);
    if (existing) { owner(existing); return existing; }
    const selected = await account(prior), intent: Intent = { version: 1, operationId: id, attempt, input, caller, agentMode, account: selected };
    let plan: Plan;
    try {
      plan = await (options.prepare ?? preparePlan)(wallet, selected, input, { ...(options.signal ? { signal: options.signal } : {}), ...(options.onProgress ? { onProgress: options.onProgress } : {}), now: now() });
    } catch (error) {
      abort();
      // Only initial read-only planning establishes that this attempt never
      // asked Wallet to send. Store writes and renewal errors remain ambiguous.
      if (attempt === "0") throw new InitialPreparationFailed(errorMessage(error));
      throw error;
    }
    validatePlan(intent, plan); abort();
    const state: State = { version: 1, plan, successor: null, steps: plan.steps.map((step, index) => ({ request: parseEvmSendTransactionRequest({ ...step.transaction, requestId: requestId(recordId, index) }), dispatched: false, unresolved: false, operation: null, evidence: null })) };
    return store.begin({ id: recordId, root_id: id, input_json: stable(intent), summary: stable({ title: plan.summary, chainId: input.chainId, kind: input.kind, humanOwned: caller === null && !agentMode }), state_json: stable(state), phase: "ready" });
  };
  const observe = async (intent: Intent, step: JournalStep, raw: unknown, reply: boolean): Promise<JournalStep> => {
    const operation = validateOperation(intent, step, raw);
    const hash = operation.receipt ? operation.transactionHash : operation.replacementTransactionHash ?? operation.transactionHash;
    const evidence = hash ? parseEvmTransactionResult(await wallet.transaction({ chainId: input.chainId, transactionHash: hash }, callOptions), { chainId: input.chainId, transactionHash: hash }) : null;
    // Keep the exact transaction and receipt header. Wallet retains complete
    // receipt logs; this consumer does not duplicate them in every journal.
    if (operation.receipt) operation.receipt = { ...operation.receipt, logs: [] };
    if (evidence?.receipt) evidence.receipt = { ...evidence.receipt, logs: [] };
    // Status can see an older unsigned revision while the dispatched Wallet
    // call is still running. Only its reply resolves that dispatch; neither
    // preparing nor prepared polls establish that an expired plan can renew.
    return { ...step, operation, evidence, unresolved: step.unresolved && ["preparing", "prepared"].includes(operation.status) && !reply };
  };
  abort();
  const first = await store.get(id);
  if (first) owner(first);
  else if (!execute) throw new Error("No saved operation was found.");
  try { remember(first ? (await latestRecord(store, id))! : await create("0")); }
  catch (error) {
    if (!(error instanceof InitialPreparationFailed)) throw error;
    abort();
    // A concurrent invocation might have saved this ID during discovery. Its
    // actual journal takes precedence over this invocation's failed preview.
    const saved = await latestRecord(store, id);
    if (saved) { owner(saved); return resultOf(saved); }
    return { operationId: id, recordId: null, summary: "Preparing Curve operation", state: "stopped", phase: "preparation_failed", transactionHash: null, steps: [],
      message: `Preparation failed before any Wallet transaction was requested. ${error.message} Retry with this same operation ID and original inputs.` };
  }
  const reviewed = new Set<string>();
  for (;;) {
    abort();
    try {
      remember((await latestRecord(store, id))!);
      const intent = owner(row!), state = stateOf(row!);
      await account(intent.account); abort();
      if (state.successor) {
        if (!execute) return resultOf(row!, "review", "Continue to refresh the unsigned quote.");
        remember(await create(String(BigInt(intent.attempt) + 1n), intent.account)); continue;
      }
      const retrySame = new Set<string>();
      for (let i = state.steps.length - 1; i >= 0; i--) {
        const step = state.steps[i]!;
        if (!step.dispatched) continue;
        // Recheck the final successful receipt on explicit status/continuation
        // so reorganizations remain observable. Completed prerequisites need
        // not be revisited once the matching final action has executed.
        if (i !== state.steps.length - 1 && stepView(intent, state.steps.at(-1)!).status === "confirmed") break;
        options.onProgress?.(`Checking ${state.plan.steps[i]!.label.toLowerCase()}…`);
        const operation = await wallet.operationStatus({ requestId: step.request.requestId, chainId: step.request.chainId, accountId: step.request.accountId }, callOptions); abort();
        if (operation.status === "not_found") {
          if (step.unresolved) retrySame.add(step.request.requestId);
          continue;
        }
        state.steps[i] = await observe(intent, step, operation, false);
        if (state.steps[i]!.unresolved && ["preparing", "prepared"].includes(operation.status)) retrySame.add(step.request.requestId);
        await persist(row!, state, `step_${i}_${stepView(intent, state.steps[i]!).status}`);
      }
      const views = state.steps.map((step) => stepView(intent, step));
      if (views.at(-1)!.status === "confirmed") {
        if (row!.phase !== "complete") await persist(row!, state, "complete");
        const result = resultOf(row!, "complete");
        if (state.plan.pool) {
          try { await store.track(state.plan.pool); }
          catch { result.message += " The pool is retained in this operation; saving its discovery reference can be retried."; }
        }
        return result;
      }
      if (views.some((view) => stopped.includes(view.status))) return resultOf(row!, "stopped");
      if (!execute) return resultOf(row!);
      const expired = BigInt(state.plan.validUntil) <= BigInt(Math.floor(now() / 1000));
      if (state.steps.some((step) => step.unresolved && (expired || !retrySame.has(step.request.requestId)))) return resultOf(row!, "pending", "The Wallet reply remains unresolved. Continue this same operation to check its original request.");
      // Released rows may already have lost their ambiguity marker when
      // polling interrupted preparation. Keep their original expired request.
      if (expired && state.steps.some((step) => step.operation?.status === "preparing")) return resultOf(row!, "pending", "The original Wallet preparation is unresolved and its quote has expired. Reconcile that same request; no new attempt was created.");
      if (views.some((view, index) => !["queued", "preparing", "prepared", "confirmed"].includes(view.status) && !retrySame.has(state.steps[index]!.request.requestId))) {
        options.onProgress?.("Waiting for confirmation. The next step follows automatically…");
        await (options.wait ?? waitForReceipt)(options.signal); continue;
      }
      if (expired) {
        state.successor = attemptId(id, String(BigInt(intent.attempt) + 1n));
        await persist(row!, state, "renewing");
        remember(await create(String(BigInt(intent.attempt) + 1n), intent.account)); continue;
      }
      const index = views.findIndex((view) => view.status !== "confirmed"), step = state.steps[index]!;
      if (reviewed.has(step.request.requestId)) return resultOf(row!, "review");
      reviewed.add(step.request.requestId);
      options.onProgress?.(`Step ${index + 1} of ${state.steps.length}: ${state.plan.steps[index]!.label}`);
      state.steps[index] = { ...step, dispatched: true, unresolved: true };
      await persist(row!, state, `step_${index}_requested`); abort();
      try {
        const operation = await wallet.sendTransaction(step.request, callOptions);
        state.steps[index] = await observe(intent, state.steps[index]!, operation, true);
        await persist(row!, state, `step_${index}_${stepView(intent, state.steps[index]!).status}`);
      } catch (error) {
        abort();
        if (error instanceof ConcurrentUpdate) throw error;
        return resultOf(row!, "pending", `The Wallet reply was interrupted. Keep this saved operation and check its status. ${errorMessage(error)}`);
      }
      if (["preparing", "prepared"].includes(state.steps[index]!.operation?.status ?? "")) return resultOf(row!, "review");
    } catch (error) { if (!(error instanceof ConcurrentUpdate)) throw error; }
  }
}
