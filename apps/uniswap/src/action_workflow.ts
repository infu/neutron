import {
  parseEvmOperationResult, parseEvmSendTransactionRequest, parseEvmTransactionResult,
  type EvmAccount, type EvmAccountId, type EvmOperationResult, type EvmReceipt, type EvmSendTransactionRequest,
  type EvmTransactionResult, type EvmWalletCaller, type EvmWalletClient,
} from "neutron-tools/evm_wallet";
import { getAddress, keccak256, stringToHex } from "viem";
import type { ActionPlan } from "./action_types.ts";
import type { ActionRecord, ActionStore } from "./action_store.ts";
import { positionManager } from "./positions.ts";
import { prepareLiquidityGas } from "./liquidity_gas.ts";

export type ActionEnvelope = {
  operationId: string; kind: string; chainId: string; accountId: EvmAccountId; input: Record<string, unknown>;
};
export type ActionIntent = {
  version: 1; envelope: ActionEnvelope; account: EvmAccount;
  caller: EvmWalletCaller | null; agentMode: boolean; attempt: string;
};
export type ActionAuthorizationFailure = {
  requestId: string; code: "AGENT_CONSENT_DENIED" | "AGENT_MODE_REVOKED"; message: string;
};
export type ActionJournalStep = {
  request: EvmSendTransactionRequest;
  /** These flags survive an old prepared observation and a later lost reply. */
  dispatched: boolean; unresolvedDispatch: boolean;
  operation: EvmOperationResult | null; evidence: EvmTransactionResult | null;
  /** A review/authority error is not a Wallet rejection or proof that no other
   * invocation signed this request. Preserve it separately from execution. */
  authorizationFailure?: ActionAuthorizationFailure;
  /** This app journals receipt headers and required mint events, not a second
   * full Wallet receipt. The public transaction tool retains the full logs. */
  receiptLogsFiltered: true; operationReceiptLogsOmitted: number; evidenceReceiptLogsOmitted: number;
};
export type ActionState = { version: 1; plan: ActionPlan; steps: ActionJournalStep[]; successor: string | null };
export type ActionReceipt = Pick<EvmReceipt, "status" | "blockNumber" | "finality">;
export type ActionResult = {
  operationId: string; recordId: string; state: "complete" | "pending" | "review" | "stopped";
  phase: string; summary: string; transactionHash: string | null; message: string;
  steps: { label: string; kind: "approval" | "transaction"; status: string; transactionHash: string | null; receipt: ActionReceipt | null }[];
  details: Record<string, unknown>; positionTokenIds: string[];
};
export type ActionInvocation = {
  operationId: string; recordId: string; toolName: "uniswap_swap_v2" | "uniswap_manage_liquidity_v1";
  argumentsJson: string; gasEstimateJson: string | null; caller: EvmWalletCaller | null; agentMode: boolean; humanOwned: boolean;
};
export type ReconciledAction = Omit<ActionResult, "steps"> & {
  /** Completeness of attempted linked-hash reads, not transaction completion. */
  readComplete?: boolean;
  steps: (ActionResult["steps"][number] & { requestId: string; checked: boolean; authorizationFailure?: ActionAuthorizationFailure | null; readError?: { code: string | null; message: string } | null })[];
};
export type PrepareAction = (context: {
  wallet: EvmWalletClient; envelope: ActionEnvelope; account: EvmAccount;
  onProgress: (message: string) => void; now: () => number;
}) => Promise<ActionPlan>;
export type ActionOptions = {
  signal?: AbortSignal; onProgress?: (message: string, result: ActionResult | null) => void;
  onRecord?: (record: ActionRecord) => void; now?: () => number;
  wait?: (signal?: AbortSignal) => Promise<void>;
};

function stable(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  throw new Error("Action inputs must contain serializable JSON values.");
}
function envelopeChecked(value: ActionEnvelope): ActionEnvelope {
  if (!value || !/^[0-9a-f]{32}$/.test(value.operationId)) throw new Error("operationId must be 32 lowercase hexadecimal characters; reuse it on retry.");
  if (typeof value.kind !== "string" || !value.kind || !/^[1-9][0-9]*$/.test(value.chainId) || value.accountId !== "main") throw new Error("Invalid action kind, chain or account.");
  if (!value.input || typeof value.input !== "object" || Array.isArray(value.input)) throw new Error("Action inputs must be an object.");
  return JSON.parse(stable(value)) as ActionEnvelope;
}
export function actionAttemptId(operationId: string, attempt: string): string {
  return attempt === "0" ? operationId : keccak256(stringToHex(`neutron:uniswap-action:v1:${operationId}:${attempt}`)).slice(2, 34);
}
export function actionRequestId(recordId: string, index: number): string {
  return keccak256(stringToHex(`neutron:uniswap-action-step:v1:${recordId}:${index}`)).slice(2, 34);
}
function sameAccount(a: EvmAccount, b: EvmAccount): boolean {
  return a.accountId === b.accountId && a.address.toLowerCase() === b.address.toLowerCase()
    && a.keyFingerprint === b.keyFingerprint && a.namespaceVersion === b.namespaceVersion;
}
export function parseActionIntent(record: ActionRecord): ActionIntent {
  const intent = JSON.parse(record.input_json) as ActionIntent;
  if (intent.version !== 1 || !/^(0|[1-9][0-9]*)$/.test(intent.attempt)) throw new Error("Unsupported saved action intent.");
  envelopeChecked(intent.envelope);
  if (actionAttemptId(intent.envelope.operationId, intent.attempt) !== record.id || !intent.account
      || intent.account.accountId !== intent.envelope.accountId || typeof intent.account.keyFingerprint !== "string"
      || typeof intent.account.namespaceVersion !== "string" || typeof intent.agentMode !== "boolean") throw new Error("Saved action identity does not match its journal.");
  getAddress(intent.account.address);
  if (intent.caller !== null && (!intent.caller || typeof intent.caller.appId !== "string" || !intent.caller.appId || typeof intent.caller.installationUid !== "string" || !/^[1-9][0-9]*$/.test(intent.caller.installationUid))) throw new Error("Invalid saved action caller.");
  if (intent.agentMode && intent.caller === null) throw new Error("An Agent action requires its authenticated provider caller.");
  if (record.operationId !== intent.envelope.operationId || record.kind !== intent.envelope.kind || record.chainId !== intent.envelope.chainId || record.accountId !== intent.envelope.accountId || record.humanOwned !== (intent.caller === null && !intent.agentMode)) throw new Error("Saved action summary does not match its owner and inputs.");
  return intent;
}
function checkedPlan(plan: ActionPlan, intent: ActionIntent): ActionPlan {
  if (!plan || plan.chainId !== intent.envelope.chainId || plan.accountId !== intent.envelope.accountId
      || getAddress(plan.accountAddress) !== getAddress(intent.account.address) || !/^[1-9][0-9]*$/.test(plan.deadline)
      || typeof plan.summary !== "string" || !plan.summary || !Array.isArray(plan.steps) || !plan.steps.length
      || plan.steps.at(-1)?.kind !== "transaction" || !plan.details || typeof plan.details !== "object" || Array.isArray(plan.details)) throw new Error("The prepared action does not match its saved account and chain.");
  for (const step of plan.steps) {
    if (typeof step.label !== "string" || !["approval", "transaction"].includes(step.kind)) throw new Error("Invalid prepared action step.");
    const tx = step.transaction;
    if (tx.accountId !== plan.accountId || tx.chainId !== plan.chainId) throw new Error("An action step changed the selected account or network.");
    parseEvmSendTransactionRequest({ requestId: "0".repeat(32), accountId: tx.accountId, chainId: tx.chainId, to: tx.to, valueWei: tx.value, data: tx.data, ...(tx.gasLimit === undefined ? {} : { gasLimit: tx.gasLimit }) });
  }
  return JSON.parse(stable(plan)) as ActionPlan;
}
function validateOperation(intent: ActionIntent, step: ActionJournalStep, raw: unknown): EvmOperationResult {
  const operation = parseEvmOperationResult(raw);
  if (operation.requestId !== step.request.requestId || operation.accountId !== intent.envelope.accountId || operation.chainId !== intent.envelope.chainId
      || getAddress(operation.address) !== getAddress(intent.account.address) || operation.kind !== "transaction") throw new Error("Wallet operation does not match this saved action step.");
  if (operation.receipt && !operation.transactionHash) throw new Error("Wallet receipt is missing its transaction hash.");
  return operation;
}
function executionMatches(intent: ActionIntent, step: ActionJournalStep, evidence: EvmTransactionResult): boolean {
  const actual = evidence.transaction, request = step.request;
  return actual !== null && getAddress(actual.from) === getAddress(intent.account.address)
    && actual.to?.toLowerCase() === request.to.toLowerCase() && actual.data.toLowerCase() === request.data.toLowerCase() && actual.valueWei === request.valueWei;
}
export function parseActionState(record: ActionRecord): ActionState {
  const intent = parseActionIntent(record), state = JSON.parse(record.state_json) as ActionState;
  if (state.version !== 1 || !Array.isArray(state.steps) || (state.successor !== null && state.successor !== actionAttemptId(intent.envelope.operationId, String(BigInt(intent.attempt) + 1n)))) throw new Error("Invalid saved action progress.");
  checkedPlan(state.plan, intent);
  if (state.steps.length !== state.plan.steps.length) throw new Error("Saved action step count changed.");
  state.steps.forEach((step, index) => {
    const tx = state.plan.steps[index]!.transaction;
    const expected = parseEvmSendTransactionRequest({ requestId: actionRequestId(record.id, index), accountId: tx.accountId, chainId: tx.chainId, to: tx.to, valueWei: tx.value, data: tx.data, ...(tx.gasLimit === undefined ? {} : { gasLimit: tx.gasLimit }) });
    if (stable(parseEvmSendTransactionRequest(step.request)) !== stable(expected) || typeof step.dispatched !== "boolean" || typeof step.unresolvedDispatch !== "boolean" || (step.unresolvedDispatch && !step.dispatched)
        || step.receiptLogsFiltered !== true || !Number.isSafeInteger(step.operationReceiptLogsOmitted) || step.operationReceiptLogsOmitted < 0
        || !Number.isSafeInteger(step.evidenceReceiptLogsOmitted) || step.evidenceReceiptLogsOmitted < 0) throw new Error("Saved action transaction or dispatch identity changed.");
    if (step.operation !== null) validateOperation(intent, step, step.operation);
    if (step.authorizationFailure !== undefined && (!step.authorizationFailure || step.authorizationFailure.requestId !== step.request.requestId
        || !["AGENT_CONSENT_DENIED", "AGENT_MODE_REVOKED"].includes(step.authorizationFailure.code)
        || typeof step.authorizationFailure.message !== "string")) throw new Error("Invalid saved action authorization evidence.");
    if (step.evidence !== null) {
      if (!step.operation) throw new Error("Transaction evidence has no authenticated Wallet operation.");
      const hash = step.evidence.transactionHash;
      if (hash !== step.operation.transactionHash && hash !== step.operation.replacementTransactionHash) throw new Error("Transaction evidence is not linked to the saved Wallet request.");
      parseEvmTransactionResult(step.evidence, { chainId: intent.envelope.chainId, transactionHash: hash });
    }
  });
  return state;
}
function view(intent: ActionIntent, step: ActionJournalStep): { status: string; transactionHash: string | null; message: string | null; receipt: ActionReceipt | null } {
  if (step.unresolvedDispatch) return { status: "unknown", transactionHash: step.operation?.transactionHash ?? null, message: "The Wallet reply is unresolved; retain this exact request.", receipt: null };
  const operation = step.operation;
  if (!operation) return { status: "queued", transactionHash: null, message: null, receipt: null };
  const evidence = step.evidence;
  if (evidence) {
    const receipt = evidence.receipt ? { status: evidence.receipt.status, blockNumber: evidence.receipt.blockNumber, finality: evidence.receipt.finality } : null;
    if (!evidence.transaction) return { status: "unknown", transactionHash: evidence.transactionHash, message: "The transaction is not visible yet.", receipt };
    if (!executionMatches(intent, step, evidence)) return { status: receipt ? "replaced" : "unknown", transactionHash: evidence.transactionHash, message: "The observed transaction does not execute the saved action. This step remains incomplete.", receipt };
    // This independent receipt can be newer than the Wallet operation snapshot.
    // Its status and prose must agree even when that snapshot still says pending.
    return { status: receipt ? receipt.status === "success" ? "confirmed" : "reverted" : "submitted", transactionHash: evidence.transactionHash, receipt,
      message: receipt ? `Transaction ${receipt.status === "success" ? "succeeded" : "reverted"} in block ${receipt.blockNumber}. Receipt finality: ${receipt.finality}.`
        : "The transaction is visible and awaits a receipt." };
  }
  // Completion always requires independent transaction fields and its receipt.
  return { status: operation.receipt ? "unknown" : operation.status, transactionHash: operation.transactionHash, message: operation.message, receipt: null };
}
const TERMINAL = ["rejected", "reverted", "failed", "replaced"];
function stoppedAuthorization(intent: ActionIntent, step: ActionJournalStep): ActionAuthorizationFailure | null {
  // An actual signing/submission or terminal Wallet/chain observation is more
  // informative than a failed review in another invocation of the same request.
  return step.authorizationFailure && ["queued", "unknown", "preparing", "prepared"].includes(view(intent, step).status) ? step.authorizationFailure : null;
}
function authorizationMessage(failure: ActionAuthorizationFailure): string {
  return `Wallet authorization was ${failure.code === "AGENT_CONSENT_DENIED" ? "declined" : "revoked"} (${failure.code}) for request ${failure.requestId}: ${failure.message} This authorization error does not prove the request was unsigned or submitted. Its execution evidence remains separate; retain the original operation and request IDs. The failed review is not sent again automatically.`;
}
function observedPhase(intent: ActionIntent, state: ActionState, index: number): string {
  const failure = stoppedAuthorization(intent, state.steps[index]!);
  return `step_${index}_${failure ? failure.code === "AGENT_CONSENT_DENIED" ? "authorization_denied" : "authorization_revoked" : view(intent, state.steps[index]!).status}`;
}
function reconciledPhase(intent: ActionIntent, state: ActionState, previous: string): string {
  if (state.successor) return previous;
  if (view(intent, state.steps.at(-1)!).status === "confirmed") return "complete";
  let index = state.steps.length - 1;
  while (index >= 0 && !state.steps[index]!.dispatched) index -= 1;
  return index < 0 ? previous : observedPhase(intent, state, index);
}
const TRANSFER_TOPIC = keccak256(stringToHex("Transfer(address,address,uint256)"));
function mintedPositions(intent: ActionIntent, state: ActionState): string[] {
  const final = state.steps.at(-1)!;
  if (view(intent, final).status !== "confirmed") return [];
  const input = intent.envelope.input;
  if (intent.envelope.kind !== "liquidity" || input.operation !== "mint" || !["v3", "v4"].includes(String(input.protocol))
      || getAddress(final.request.to) !== positionManager(intent.envelope.chainId, input.protocol as "v3" | "v4")) return [];
  const recipient = getAddress(typeof input.recipient === "string" ? input.recipient : intent.account.address);
  const ids = new Set<string>();
  for (const log of final.evidence?.receipt?.logs ?? []) {
    if (log.address.toLowerCase() !== final.request.to.toLowerCase() || log.topics.length !== 4 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || BigInt(log.topics[1]!) !== 0n || log.data !== "0x") continue;
    if (getAddress(`0x${log.topics[2]!.slice(-40)}`) === recipient) ids.add(BigInt(log.topics[3]!).toString());
  }
  return [...ids];
}
export function actionResult(record: ActionRecord, status?: ActionResult["state"], message?: string): ActionResult {
  const intent = parseActionIntent(record), state = parseActionState(record), views = state.steps.map((step) => view(intent, step));
  const final = views.at(-1)!;
  const authorizationFailure = state.steps.map((step) => stoppedAuthorization(intent, step)).find((failure) => failure !== null);
  const derived = final.status === "confirmed" ? "complete" : views.some((step) => TERMINAL.includes(step.status)) || authorizationFailure ? "stopped" : views.some((step) => ["preparing", "prepared"].includes(step.status)) ? "review" : "pending";
  const terminal = derived === "complete" || derived === "stopped";
  const terminalMessage = derived === "complete" ? `Complete: ${final.message}` : views.find((step) => TERMINAL.includes(step.status))?.message ?? (authorizationFailure ? authorizationMessage(authorizationFailure) : "The action stopped before completion.");
  return {
    operationId: intent.envelope.operationId, recordId: record.id, state: terminal ? derived : status ?? derived, phase: record.phase, summary: record.summary,
    transactionHash: final.transactionHash, message: terminal ? terminalMessage : message ?? "The saved action can continue with its original operation ID.",
    steps: views.map((step, index) => ({ label: state.plan.steps[index]!.label, kind: state.plan.steps[index]!.kind, status: step.status, transactionHash: step.transactionHash, receipt: step.receipt })),
    details: state.plan.details, positionTokenIds: mintedPositions(intent, state),
  };
}
export async function latestAction(store: ActionStore, operationId: string): Promise<ActionRecord | null> {
  let record = await store.get(operationId);
  while (record) {
    const state = parseActionState(record);
    if (!state.successor) return record;
    const next = await store.get(state.successor);
    if (!next) return record; // Renewal marker survives a lost successor-begin reply.
    const before = parseActionIntent(record), after = parseActionIntent(next);
    if (stable(before.envelope) !== stable(after.envelope) || stable(before.caller) !== stable(after.caller) || before.agentMode !== after.agentMode || !sameAccount(before.account, after.account)) throw new Error("Saved action successor changed its original owner or inputs.");
    record = next;
  }
  return null;
}

/** The persisted, canonical inputs are sufficient to continue the original
 * invocation. Reading them grants no authority to execute it: runAction still
 * checks the original caller, execution mode and signing account. */
export function actionInvocation(record: ActionRecord): ActionInvocation {
  const intent = parseActionIntent(record), { envelope } = intent, gasEstimate = parseActionState(record).plan.details.gasEstimate;
  if (!["swap", "liquidity"].includes(envelope.kind)) throw new Error("This saved action has no supported continuation tool.");
  return {
    operationId: envelope.operationId, recordId: record.id,
    toolName: envelope.kind === "swap" ? "uniswap_swap_v2" : "uniswap_manage_liquidity_v1",
    argumentsJson: stable({ ...envelope.input, operationId: envelope.operationId, chainId: envelope.chainId, accountId: envelope.accountId }),
    gasEstimateJson: gasEstimate === undefined ? null : stable(gasEstimate),
    caller: intent.caller, agentMode: intent.agentMode, humanOwned: record.humanOwned,
  };
}

function retainedEvidence(intent: ActionIntent, step: ActionJournalStep, evidence: EvmTransactionResult | null): ActionJournalStep {
  const fullLogCount = evidence?.receipt?.logs.length ?? 0;
  if (evidence?.receipt) evidence.receipt = { ...evidence.receipt, logs: evidence.receipt.logs.filter((log) =>
    intent.envelope.kind === "liquidity" && intent.envelope.input.operation === "mint"
    && log.address.toLowerCase() === step.request.to.toLowerCase() && log.topics.length === 4
    && log.topics[0]?.toLowerCase() === TRANSFER_TOPIC && BigInt(log.topics[1]!) === 0n && log.data === "0x") };
  return { ...step, evidence, receiptLogsFiltered: true, evidenceReceiptLogsOmitted: fullLogCount - (evidence?.receipt?.logs.length ?? 0) };
}

/** Refresh only transaction hashes already linked to authenticated Wallet
 * observations in this journal. operationStatus intentionally is not available:
 * that Wallet tool can rebroadcast signed bytes. A dispatch with no saved hash
 * therefore remains unknown until explicit recovery through the original tool.
 * Only journal observations change; no request, quote or position is created. */
export async function reconcileAction(
  wallet: Pick<EvmWalletClient, "transaction">, store: ActionStore, operationId: string,
  options: Pick<ActionOptions, "signal" | "onProgress"> & { includeAuthorization?: boolean; includeDiagnostics?: boolean } = {},
): Promise<ReconciledAction | null> {
  if (!/^[0-9a-f]{32}$/.test(operationId)) throw new Error("operationId must be 32 lowercase hexadecimal characters.");
  const callOptions = options.signal ? { signal: options.signal } : undefined;
  for (;;) {
    options.signal?.throwIfAborted();
    let record = await latestAction(store, operationId);
    if (!record) return null;
    const intent = parseActionIntent(record), state = parseActionState(record), checked = new Set<string>();
    const readErrors = new Map<string, { code: string | null; message: string }>();
    try {
      for (let index = state.steps.length - 1; index >= 0; index -= 1) {
        const step = state.steps[index]!, operation = step.operation;
        if (!step.dispatched || !operation) continue;
        const hash = operation.receipt ? operation.transactionHash : operation.replacementTransactionHash ?? operation.transactionHash;
        if (!hash) continue;
        options.onProgress?.(`Checking ${state.plan.steps[index]!.label.toLowerCase()}…`, actionResult(record));
        const request = { chainId: intent.envelope.chainId, transactionHash: hash };
        try {
          const evidence = parseEvmTransactionResult(await wallet.transaction(request, callOptions), request);
          options.signal?.throwIfAborted();
          state.steps[index] = retainedEvidence(intent, { ...step, unresolvedDispatch: evidence.transaction === null && step.unresolvedDispatch }, evidence);
          checked.add(step.request.requestId);
        } catch (error) {
          options.signal?.throwIfAborted();
          // Archive/provider failures for an old approval must not suppress a
          // different step's receipt or its saved rejection/authorization facts.
          // Keep prior durable evidence; report this read as unavailable only.
          readErrors.set(step.request.requestId, {
            code: typeof error === "object" && error !== null && "code" in error ? String(error.code) : null,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const phase = reconciledPhase(intent, state, record.phase);
      options.signal?.throwIfAborted();
      try { record = await store.update(record, state, phase); }
      catch (error) {
        const latest = await store.get(record.id);
        if (latest && latest.revision !== record.revision) throw new ConcurrentActionUpdate();
        throw error;
      }
      const missingHash = state.steps.some((step) => step.dispatched && !step.operation?.transactionHash && !step.operation?.replacementTransactionHash
        && (step.unresolvedDispatch || !step.operation || !["preparing", "prepared", ...TERMINAL].includes(step.operation.status)));
      const message = missingHash
        ? "A dispatched request has no saved transaction hash; its outcome remains unknown. This check did not send or renew anything. Retrieve the saved invocation for explicit recovery with the same operation ID."
        : readErrors.size ? "Some saved transaction hashes could not be checked. No unavailable receipt is presented as a current confirmation."
        : "Existing transaction evidence was refreshed. This check did not approve, send or renew anything. Retrieve the saved invocation before explicitly continuing any remaining steps with the same operation ID.";
      // A failed live read cannot certify its cached receipt. Derive only this
      // response from unresolved evidence without erasing the durable snapshot.
      const observedState: ActionState = { ...state, steps: state.steps.map(step => {
        if (!readErrors.has(step.request.requestId)) return step;
        const { authorizationFailure: _historicalFailure, ...prior } = step;
        return { ...prior, unresolvedDispatch: true };
      }) };
      const observedRecord = readErrors.size ? { ...record, state_json: stable(observedState), phase: reconciledPhase(intent, observedState, record.phase) } : record;
      const result = actionResult(observedRecord, undefined, message);
      if (readErrors.size) result.message += ` Some transaction evidence could not be refreshed: ${[...readErrors].map(([requestId, error]) => `request ${requestId}: ${error.message}`).join("; ")}. Unavailable steps are not live confirmations; their prior journal observations were retained. This check did not sign or send anything.`;
      return { ...result, ...(options.includeDiagnostics ? { readComplete: readErrors.size === 0 } : {}), steps: result.steps.map((step, index) => {
        const saved = state.steps[index]!, readError = readErrors.get(saved.request.requestId) ?? null;
        return { ...step, ...(readError ? { status: "read_unavailable", receipt: null } : {}), requestId: saved.request.requestId, checked: checked.has(saved.request.requestId), ...(options.includeAuthorization ? { authorizationFailure: saved.authorizationFailure ?? null } : {}), ...(options.includeDiagnostics ? { readError } : {}) };
      }) };
    } catch (error) {
      if (!(error instanceof ConcurrentActionUpdate)) throw error;
      // A continuation may have advanced or renewed the journal during these
      // reads. Reload it instead of overwriting that progress with our snapshot.
    }
  }
}
function receiptWait(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(signal?.reason ?? new Error("Action tracking paused")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, 2500);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}
class ConcurrentActionUpdate extends Error {}

/** Durable sequential provider workflow. It never invents root authority; every
 * effect uses the caller's public Wallet client and its exact review flow. */
export async function runAction(
  wallet: EvmWalletClient, store: ActionStore, rawEnvelope: ActionEnvelope,
  caller: EvmWalletCaller | null, agentMode: boolean, prepare: PrepareAction, options: ActionOptions = {},
): Promise<ActionResult> {
  const envelope = envelopeChecked(rawEnvelope), now = options.now ?? Date.now, wait = options.wait ?? receiptWait;
  const callOptions = options.signal ? { signal: options.signal } : undefined;
  if (agentMode && caller === null) throw new Error("An Agent action requires its authenticated provider caller.");
  let record: ActionRecord | null = null;
  const abort = () => options.signal?.throwIfAborted();
  const update = (next: ActionRecord) => { record = next; options.onRecord?.(next); };
  const progress = (message: string) => options.onProgress?.(message, record ? actionResult(record) : null);
  const assertOwner = (saved: ActionRecord) => {
    const intent = parseActionIntent(saved);
    if (stable(intent.envelope) !== stable(envelope) || stable(intent.caller) !== stable(caller) || intent.agentMode !== agentMode) throw new Error("This operationId belongs to different inputs or another caller. Continue the original request unchanged.");
    return intent;
  };
  const account = async (previous?: EvmAccount) => {
    const selected = (await wallet.accounts(callOptions)).accounts.find((entry) => entry.accountId === envelope.accountId);
    if (!selected || (previous && !sameAccount(previous, selected))) throw new Error("The EVM Wallet signing identity changed. This action cannot continue with a replacement account.");
    return selected;
  };
  const persist = async (saved: ActionRecord, state: ActionState, phase: string) => {
    abort();
    try { const next = await store.update(saved, state, phase); update(next); return next; }
    catch (error) {
      const latest = await store.get(saved.id);
      if (latest && latest.revision !== saved.revision) { update(latest); throw new ConcurrentActionUpdate(); }
      throw error;
    }
  };
  const create = async (attempt: string, previous?: EvmAccount): Promise<ActionRecord> => {
    const id = actionAttemptId(envelope.operationId, attempt), existing = await store.get(id);
    if (existing) { assertOwner(existing); return existing; }
    abort();
    const selected = await account(previous), intent: ActionIntent = { version: 1, envelope, account: selected, caller, agentMode, attempt };
    const plan = checkedPlan(await prepare({ wallet, envelope: structuredClone(envelope), account: structuredClone(selected), onProgress: progress, now }), intent);
    abort();
    const state: ActionState = { version: 1, plan, successor: null, steps: plan.steps.map((step, index) => ({
      request: parseEvmSendTransactionRequest({ requestId: actionRequestId(id, index), accountId: step.transaction.accountId, chainId: step.transaction.chainId, to: step.transaction.to, valueWei: step.transaction.value, data: step.transaction.data, ...(step.transaction.gasLimit === undefined ? {} : { gasLimit: step.transaction.gasLimit }) }),
      dispatched: false, unresolvedDispatch: false, operation: null, evidence: null,
      receiptLogsFiltered: true, operationReceiptLogsOmitted: 0, evidenceReceiptLogsOmitted: 0,
    })) };
    const summary = stable({ title: plan.summary, kind: envelope.kind, operationId: envelope.operationId, chainId: envelope.chainId, accountId: envelope.accountId, humanOwned: caller === null && !agentMode });
    return store.begin({ id, input_json: stable(intent), state_json: stable(state), summary, phase: "ready" });
  };
  const observe = async (intent: ActionIntent, step: ActionJournalStep, raw: unknown, reply = false): Promise<ActionJournalStep> => {
    const observed = validateOperation(intent, step, raw);
    // The authenticated operation status supplies replacement ancestry. A caller
    // cannot supply a hash to bypass the original request's identity.
    const hash = observed.receipt ? observed.transactionHash : observed.replacementTransactionHash ?? observed.transactionHash;
    const evidence = hash ? parseEvmTransactionResult(await wallet.transaction({ chainId: envelope.chainId, transactionHash: hash }, callOptions), { chainId: envelope.chainId, transactionHash: hash }) : null;
    const operationReceiptLogsOmitted = observed.receipt?.logs.length ?? 0;
    const operation = { ...observed, receipt: observed.receipt ? { ...observed.receipt, logs: [] } : null };
    // A poll can see an older unsigned revision while the dispatched Wallet
    // call is still running. Only its reply resolves that dispatch; preparing
    // and prepared polls must retain the original ambiguity through expiry.
    const unresolvedDispatch = step.unresolvedDispatch && ["preparing", "prepared"].includes(operation.status) && !reply;
    return retainedEvidence(intent, { ...step, operation, unresolvedDispatch, operationReceiptLogsOmitted }, evidence);
  };
  const requested = new Set<string>();
  abort();
  const first = await store.get(envelope.operationId);
  if (first) assertOwner(first); // Ownership precedes any Wallet read or effect.
  update(first ? (await latestAction(store, envelope.operationId))! : await create("0"));
  for (;;) {
    abort();
    try {
      const latest = await latestAction(store, envelope.operationId);
      if (!latest) throw new Error("The saved action disappeared.");
      update(latest);
      const intent = assertOwner(record!), state = parseActionState(record!);
      await account(intent.account); abort();
      if (state.successor) { update(await create(String(BigInt(intent.attempt) + 1n), intent.account)); continue; }
      const retrySameRequest = new Set<string>();

      // Observe every dispatched step before renewal, including the final one.
      // This preserves lost replies even if an earlier approval also changes.
      for (let index = state.steps.length - 1; index >= 0; index -= 1) {
        const isFinal = index === state.steps.length - 1;
        // A previously included receipt can be reorganized. Recheck the final
        // request before returning cached completion or updated finality.
        if (!isFinal && view(intent, state.steps.at(-1)!).status === "confirmed") break;
        const step = state.steps[index]!;
        if (!step.dispatched) continue;
        const previous = view(intent, step);
        if (!isFinal && previous.status === "confirmed") continue;
        progress(`Checking ${state.plan.steps[index]!.label.toLowerCase()}…`);
        const result = await wallet.operationStatus({ accountId: envelope.accountId, chainId: envelope.chainId, requestId: step.request.requestId }, callOptions);
        abort();
        if (result.status === "not_found") { if (step.unresolvedDispatch) retrySameRequest.add(step.request.requestId); continue; }
        state.steps[index] = await observe(intent, step, result);
        if (state.steps[index]!.unresolvedDispatch && ["preparing", "prepared"].includes(result.status)) retrySameRequest.add(step.request.requestId);
        await persist(record!, state, observedPhase(intent, state, index));
      }
      const views = state.steps.map((step) => view(intent, step)), final = views.at(-1)!;
      if (final.status === "confirmed") {
        if (record!.phase !== "complete") await persist(record!, state, "complete");
        const completed = actionResult(record!, "complete");
        try {
          const recipient = getAddress(typeof envelope.input.recipient === "string" ? envelope.input.recipient : intent.account.address);
          if (recipient === getAddress(intent.account.address)) for (const tokenId of completed.positionTokenIds) await store.trackPosition({ chainId: envelope.chainId, protocol: envelope.input.protocol as "v3" | "v4", tokenId });
        } catch {
          completed.message = "Complete: the final transaction succeeded. Its position ID is retained in this receipt; saving the discovery reference can be retried with this same operationId.";
        }
        return completed;
      }
      const stopped = views.find((step) => TERMINAL.includes(step.status));
      if (stopped) return actionResult(record!, "stopped", stopped.message ?? `The action ${stopped.status}. An approval alone does not complete it.`);
      if (state.steps.some((step) => stoppedAuthorization(intent, step))) return actionResult(record!);
      const expired = BigInt(state.plan.deadline) <= BigInt(Math.floor(now() / 1000));
      if (state.steps.some((step) => step.unresolvedDispatch && (expired || !retrySameRequest.has(step.request.requestId)))) return actionResult(record!, "pending", "The Wallet reply is unresolved. Continue with this same operationId to reconcile its original request before any further transaction.");

      // Released rows may have lost the dispatch marker when polling an
      // interrupted preparation. Do not renew their expired exact requests.
      if (expired && state.steps.some((step) => step.operation?.status === "preparing")) return actionResult(record!, "pending", "The original Wallet preparation is still unresolved and its quote has expired. Reconcile that same request; no new attempt was created.");
      const pending = views.some((step, index) => !["queued", "preparing", "prepared", "confirmed"].includes(step.status) && !retrySameRequest.has(state.steps[index]!.request.requestId));
      if (pending) { progress("Waiting for transaction confirmation. The next step follows automatically…"); await wait(options.signal); continue; }

      if (expired) {
        // CAS freezes this known-unsigned predecessor before allocating any new
        // requests; another concurrent invocation can no longer dispatch it.
        progress("Updating the expired quote and checking existing approvals…");
        state.successor = actionAttemptId(envelope.operationId, String(BigInt(intent.attempt) + 1n));
        await persist(record!, state, "superseded");
        update(await create(String(BigInt(intent.attempt) + 1n), intent.account)); continue;
      }
      const index = views.findIndex((step) => step.status !== "confirmed");
      let step = state.steps[index]!;
      if (requested.has(step.request.requestId)) return actionResult(record!, "review", "Wallet refreshed the exact transaction for review. Continue this same operationId for its updated review.");
      if (!step.dispatched) {
        const gas = await prepareLiquidityGas(wallet, { kind: envelope.kind, input: envelope.input, stepKind: state.plan.steps[index]!.kind, accountAddress: intent.account.address, request: step.request }, callOptions);
        abort();
        if (gas) {
          step = { ...step, request: gas.request };
          state.plan.steps[index]!.transaction = { ...state.plan.steps[index]!.transaction, gasLimit: gas.request.gasLimit! };
          state.plan.details.gasEstimate = gas.diagnostics;
        }
      }
      requested.add(step.request.requestId);
      progress(`Step ${index + 1} of ${state.steps.length}: ${state.plan.steps[index]!.label}`);
      state.steps[index] = { ...step, dispatched: true, unresolvedDispatch: true };
      await persist(record!, state, `step_${index}_requested`);
      abort();
      try {
        const result = await wallet.sendTransaction(step.request, callOptions);
        state.steps[index] = await observe(intent, state.steps[index]!, result, true);
        await persist(record!, state, `step_${index}_${view(intent, state.steps[index]!).status}`);
      } catch (error) {
        abort();
        if (error instanceof ConcurrentActionUpdate) throw error;
        const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
        if (code === "AGENT_CONSENT_DENIED" || code === "AGENT_MODE_REVOKED") {
          const failure: ActionAuthorizationFailure = { requestId: step.request.requestId, code, message: error instanceof Error ? error.message : String(error) };
          // Merge into the latest same-request observation. Another invocation
          // may have recorded a receipt while this one's review was rejected.
          for (;;) {
            const saved = await store.get(record!.id);
            if (!saved) throw new Error("The saved action disappeared.");
            const currentIntent = assertOwner(saved), current = parseActionState(saved), currentStep = current.steps[index]!;
            if (currentStep.request.requestId !== failure.requestId) throw new Error("The saved authorization request changed.");
            currentStep.authorizationFailure = failure;
            try { await persist(saved, current, reconciledPhase(currentIntent, current, saved.phase)); break; }
            catch (writeError) { if (!(writeError instanceof ConcurrentActionUpdate)) throw writeError; }
          }
          return actionResult(record!);
        }
        return actionResult(record!, "pending", `The Wallet call did not return complete evidence. Continue this same operationId to reconcile its exact request. ${error instanceof Error ? error.message : String(error)}`);
      }
      if (["preparing", "prepared"].includes(view(intent, state.steps[index]!).status)) return actionResult(record!, "review", "Wallet refreshed the exact transaction for review. Continue this same operationId for its updated review.");
    } catch (error) {
      if (!(error instanceof ConcurrentActionUpdate)) throw error;
      // A concurrent continuation or a lost CAS reply advanced this same flow.
      // Reload its durable state before deciding on another effect.
    }
  }
}
