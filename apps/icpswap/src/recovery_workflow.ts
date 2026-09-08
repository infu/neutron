import { isJsonObject, isMsgBusInstallationUid, type JsonObject, type JsonValue, type MsgBusToolContext, type ScopedKernelClient } from "neutron-tools/app";
import type { ActionBackend, ActionOperation, ActionPrepared } from "./action_backend.ts";
import { fromBaseUnits } from "./amount.ts";
import { assertFundingResultMatchesRequest, parseFundingResult, poolDepositAccount, WALLET_FUND_ROOT_TOOL, WALLET_TARGET, type DirectFundingRequest, type FundingRequest, type FundingResult } from "./funding.ts";
import { savedFundingRequests } from "./funding_workflow.ts";
import { readTokenInfo, type WalletTokenInfo } from "./wallet.ts";

type Owner = { appId: string; installationUid: string; rootMode: boolean };
type RecoveryIntent = { version: 1; kind: "recover_deposit"; owner: Owner; input: { sourceOperationId: string; tokenIndex: number } };
type SavedResult = { requestId: string; result: FundingResult };
export type DepositRecoveryDependencies = {
  backendFor: (kernel: ScopedKernelClient) => ActionBackend;
  authorize: (context: MsgBusToolContext, review: JsonObject) => Promise<void>;
};

function operationId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/u.test(value)) throw new Error("Retain one 32-character lowercase hexadecimal operationId for recovery.");
  return value;
}
function tokenIndex(value: unknown): number {
  if (value !== 0 && value !== 1) throw new Error("tokenIndex must be 0 or 1 in the saved pool's canonical token order.");
  return value;
}
function nat(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) throw new Error(`The saved ${label} is unavailable.`);
  return BigInt(value);
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`The saved ${label} is unavailable.`);
  return value;
}
function parseOwner(value: unknown): Owner {
  if (!isJsonObject(value as JsonValue)) throw new Error("The saved action has no original caller identity.");
  const owner = value as JsonObject;
  if (typeof owner.appId !== "string" || owner.appId === "" || !isMsgBusInstallationUid(owner.installationUid) || typeof owner.rootMode !== "boolean") {
    throw new Error("The saved action has no original caller identity.");
  }
  return { appId: owner.appId, installationUid: owner.installationUid, rootMode: owner.rootMode };
}
function caller(context: MsgBusToolContext): Owner {
  return parseOwner({ appId: context.caller?.appId, installationUid: context.caller?.installationUid, rootMode: !!context.agentMode });
}
function sameOwner(a: Owner, b: Owner): boolean {
  return a.appId === b.appId && a.installationUid === b.installationUid && a.rootMode === b.rootMode;
}
function intent(operation: ActionOperation): JsonObject {
  const value: JsonValue = JSON.parse(operation.input_json);
  if (!isJsonObject(value) || value.version !== 1 || !isJsonObject(value.input)) throw new Error("The saved action has no compatible original intent.");
  parseOwner(value.owner);
  return value;
}
function recoveryIntent(operation: ActionOperation): RecoveryIntent {
  const value = intent(operation);
  if (value.kind !== "recover_deposit") throw new Error("This operationId belongs to another action kind.");
  const input = value.input as JsonObject;
  return { version: 1, kind: "recover_deposit", owner: parseOwner(value.owner),
    input: { sourceOperationId: operationId(input.sourceOperationId), tokenIndex: tokenIndex(input.tokenIndex) } };
}
function resultFor(value: JsonValue, requests: FundingRequest[], sourceOwner: Owner): SavedResult {
  const result = parseFundingResult(value);
  const namespace = sourceOwner.rootMode ? sourceOwner.appId : "icpswap";
  const request = requests.find((item) => result.commandId === `${namespace}:${item.requestId}`);
  if (!request) throw new Error("Wallet evidence does not match the original funding caller and exact request ID.");
  assertFundingResultMatchesRequest(result, request);
  if (result.status === "transferred" && (result.blockIndex === null || result.duplicate === null)) {
    throw new Error("A confirmed Wallet transfer must include its ledger block and duplicate result.");
  }
  return { requestId: request.requestId, result };
}
function resultsFor(operation: ActionOperation, requests: FundingRequest[], sourceOwner: Owner): SavedResult[] {
  if (operation.result_json === "") return [];
  const envelope: JsonValue = JSON.parse(operation.result_json);
  if (!isJsonObject(envelope) || envelope.kind !== "wallet_funding_v1" || !Array.isArray(envelope.results)) {
    throw new Error("The original action has no usable saved Wallet funding evidence. Reconcile its original Wallet command before recovery.");
  }
  const results = envelope.results.map((value) => {
    if (!isJsonObject(value)) throw new Error("Malformed saved Wallet funding evidence.");
    const parsed = resultFor(value.result as JsonValue, requests, sourceOwner);
    if (parsed.requestId !== value.requestId) throw new Error("Saved Wallet evidence identifies a different funding request.");
    return parsed;
  });
  if (new Set(results.map((value) => value.requestId)).size !== results.length) throw new Error("The original action repeats Wallet evidence for one funding request.");
  return results;
}
function sourceDeposit(operation: ActionOperation, plan: JsonObject, index: number) {
  const sourceIntent = intent(operation), sourceOwner = parseOwner(sourceIntent.owner);
  if (sourceIntent.kind !== "liquidity") throw new Error("Deposit recovery requires an original liquidity action.");
  if (operation.effects.some((effect) => effect.key === `deposit${index}`)) {
    throw new Error("This original pool deposit already has a dispatch or saved recovery. Reconcile it; do not deposit those funds again.");
  }
  const token = plan[`token${index}`];
  if (!isJsonObject(token) || (token.standard !== "ICRC1" && token.standard !== "ICP")) throw new Error("Only previously transferred ICRC1 or ICP pool-subaccount funding uses deposit recovery.");
  const ledger = text(token.address, "token ledger"), pool = text(plan.pool, "pool"), owner = text(plan.owner, "pool owner");
  const deficit = nat(plan[`funding${index}`], "funding deficit"), oldFee = nat(plan[`fee${index}`], "deposit fee");
  if (deficit === 0n) throw new Error("The original token leg had no direct funding deficit.");
  const requests = savedFundingRequests(operation);
  const matches = requests.filter((request): request is DirectFundingRequest => request.route.kind === "direct" && request.ledger === ledger &&
    request.route.to === poolDepositAccount(pool, owner) && request.amountAtoms === (deficit + oldFee).toString());
  if (matches.length !== 1) throw new Error("The original action has no unique exact Wallet transfer to this pool's owner deposit account.");
  return { sourceOwner, requests, request: matches[0]!, ledger, results: resultsFor(operation, requests, sourceOwner) };
}

export type EligibleDirectDepositRecovery = { tokenIndex: 0 | 1; ledger: string; grossAmount: string; requestId: string; commandId: string; blockIndex: string };

/** UI eligibility uses the same evidence checks as execution. A summary or
 * malformed/unconfirmed record never presents an actionable recovery button. */
export function eligibleDirectDepositRecoveries(operation: ActionOperation, plan: JsonObject): EligibleDirectDepositRecovery[] {
  const eligible: EligibleDirectDepositRecovery[] = [];
  for (const index of [0, 1] as const) {
    try {
      const value = sourceDeposit(operation, plan, index);
      const result = value.results.find((item) => item.requestId === value.request.requestId)?.result;
      if (result?.status === "transferred" && result.blockIndex !== null) eligible.push({ tokenIndex: index, ledger: value.ledger,
        grossAmount: value.request.amountAtoms, requestId: value.request.requestId, commandId: result.commandId, blockIndex: result.blockIndex });
    } catch { /* Availability must not be inferred from incomplete journal data. */ }
  }
  return eligible;
}
function response(prepared: ActionPrepared, message = prepared.operation.detail): JsonObject {
  return { operationId: prepared.operation.id, state: prepared.operation.state, message,
    operation: prepared.operation as unknown as JsonObject, plan: prepared.plan, receipt: null, fundingInstructions: [] };
}
function dispatched(operation: ActionOperation): boolean {
  return operation.effects.some((effect) => ["requested", "uncertain", "succeeded", "failed"].includes(String(effect.state)));
}

/** Recover only previously transferred pool-subaccount funds. This flow never calls a Wallet funding tool. */
export async function runDepositRecovery(args: JsonObject, context: MsgBusToolContext, dependencies: DepositRecoveryDependencies): Promise<JsonObject> {
  const check = () => context.signal?.throwIfAborted();
  check();
  const id = operationId(args.operationId), currentOwner = caller(context), backend = dependencies.backendFor(context.kernel);
  const existing = await backend.actionGet(id);
  check();
  let savedIntent: RecoveryIntent, prepared: ActionPrepared;
  if (existing) {
    savedIntent = recoveryIntent(existing);
    if (!sameOwner(savedIntent.owner, currentOwner)) throw new Error("Continue this saved recovery from its original application installation and Normal or Root mode.");
    if ((args.sourceOperationId !== undefined && operationId(args.sourceOperationId) !== savedIntent.input.sourceOperationId) ||
        (args.tokenIndex !== undefined && tokenIndex(args.tokenIndex) !== savedIntent.input.tokenIndex)) {
      throw new Error("This recovery operationId already belongs to another source action or token.");
    }
    const value = await backend.recoveryStatus(id);
    if (!value) throw new Error("The saved recovery has no retained protocol plan. Inspect this same operationId before retrying.");
    prepared = value;
  } else {
    const sourceId = operationId(args.sourceOperationId), index = tokenIndex(args.tokenIndex);
    if (sourceId === id) throw new Error("Use a separate recovery operationId and retain the original sourceOperationId.");
    const source = await backend.liquidityStatus(sourceId);
    check();
    if (!source || source.operation.id !== sourceId) throw new Error("The original liquidity operation was not found.");
    const validation = sourceDeposit(source.operation, source.plan, index);
    const { sourceOwner, request, requests } = validation;
    let results = validation.results;
    if (args.fundingResults !== undefined) {
      if (!Array.isArray(args.fundingResults)) throw new Error("fundingResults must contain the original raw Wallet replies.");
      if (args.fundingResults.length) {
        if (!sourceOwner.rootMode || !sameOwner(sourceOwner, currentOwner)) {
          throw new Error("Only the original Root caller may acknowledge its direct Wallet replies. A different caller may recover already-confirmed funding without new Wallet requests.");
        }
        const supplied = args.fundingResults.map((value) => resultFor(value, requests, sourceOwner));
        if (new Set(supplied.map((value) => value.requestId)).size !== supplied.length) throw new Error("Repeated Wallet funding acknowledgment.");
        for (const incoming of supplied) {
          const prior = results.find((value) => value.requestId === incoming.requestId);
          if (prior && prior.result.status !== "pending") {
            if (incoming.result.status !== prior.result.status || incoming.result.blockIndex !== prior.result.blockIndex) {
              throw new Error("A new Wallet reply contradicts the original terminal funding result. Reconcile that exact Wallet command.");
            }
            continue;
          }
          results = [...results.filter((value) => value.requestId !== incoming.requestId), incoming];
        }
        check();
        source.operation = await backend.actionUpdate({ id: sourceId, expected_revision: source.operation.revision,
          state: source.operation.state, detail: "Original Root Wallet replies retained for direct-funded deposit recovery.",
          result_json: JSON.stringify({ kind: "wallet_funding_v1", results }), funding_json: source.operation.funding_json });
        check();
      }
    }
    const confirmed = results.find((value) => value.requestId === request.requestId)?.result;
    if (confirmed?.status !== "transferred") {
      const mayReconcile = sameOwner(sourceOwner, currentOwner);
      const rejected = confirmed?.status === "rejected";
      return { operationId: id, state: rejected ? "funding_rejected" : "funding_unresolved",
        message: rejected ? "The original Wallet transfer was rejected. No pool recovery was prepared and no new funding was requested."
          : mayReconcile && sourceOwner.rootMode ? "Reconcile this exact original Wallet request directly from the Root Agent, then pass its raw reply in fundingResults to this recovery. No new funding or pool deposit was requested."
          : mayReconcile ? "Reconcile the original action's retained Wallet command through the original ICPSwap funding flow before recovering this deposit. This recovery does not request funding."
          : "The original Wallet transfer is not yet confirmed. Its original application and Normal or Root mode must reconcile that command first. This recovery does not request funding.",
        operation: null, plan: null, receipt: null, sourceOperationId: sourceId,
        fundingInstructions: !rejected && mayReconcile && sourceOwner.rootMode ? [{ target: WALLET_TARGET, name: WALLET_FUND_ROOT_TOOL, arguments: request }] : [],
        ...(mayReconcile ? { originalWalletRequest: request, originalWalletCommandId: `${sourceOwner.rootMode ? sourceOwner.appId : "icpswap"}:${request.requestId}` } : {}),
      };
    }
    savedIntent = { version: 1, kind: "recover_deposit", owner: currentOwner, input: { sourceOperationId: sourceId, tokenIndex: index } };
    check();
    prepared = await backend.recoveryPrepare({ id, input_json: JSON.stringify(savedIntent), source_id: sourceId, token_index: String(index) });
  }
  check();
  // Reuse the retained plan after lost preparation replies; terminal or unknown
  // non-idempotent pool effects are only observed, never dispatched again here.
  if (prepared.operation.id !== id || prepared.operation.input_json !== JSON.stringify(savedIntent)) throw new Error("The recovery reply does not match this exact saved intent.");
  if (prepared.operation.state !== "prepared" || dispatched(prepared.operation)) return response(prepared);
  const plan = prepared.plan;
  if (plan.source_id !== savedIntent.input.sourceOperationId || plan.token_index !== String(savedIntent.input.tokenIndex) || !isJsonObject(plan.token)) {
    throw new Error("The retained recovery plan does not match the source token leg.");
  }
  const ledger = text(plan.token.address, "recovery token"), gross = nat(plan.gross_amount, "gross deposit amount"), fee = nat(plan.fee, "current deposit fee"), credit = nat(plan.credit_amount, "pool credit");
  if (gross <= fee || credit !== gross - fee) throw new Error("The recovery credit does not match its exact gross amount and current fee.");
  let metadata: WalletTokenInfo | null = null;
  try { metadata = await readTokenInfo(context.kernel, ledger); } catch { check(); }
  check();
  if (metadata && metadata.feeAtoms !== fee) throw new Error("The pool deposit fee differs from Wallet's live ledger fee. No recovery deposit was sent; refresh the pool before reviewing recovery again.");
  const amount = (value: bigint) => metadata ? `${fromBaseUnits(value, metadata.decimals)} ${metadata.symbol}` : `${value} atoms (${ledger})`;
  await dependencies.authorize(context, {
    title: "Recover an ICPSwap pool deposit", token: metadata?.symbol ?? ledger,
    sourceOperationId: savedIntent.input.sourceOperationId, pool: text(plan.pool, "recovery pool"),
    amountAlreadyTransferred: amount(gross), depositFee: amount(fee), expectedPoolCredit: amount(credit),
    notes: ["This uses the confirmed transfer already in the pool's owner deposit account. No new Wallet funding is requested.",
      "The credited funds remain in your pool-unused balance. Withdraw or reuse them with a separate reviewed action; this recovery does not resume the original position action."],
    exactAction: { operationId: id, input: savedIntent.input, plan },
  });
  check();
  try { return response(await backend.recoveryExecute({ id, expected_revision: prepared.operation.revision })); }
  catch (error) {
    check();
    try {
      const latest = await backend.recoveryStatus(id);
      if (latest) return response(latest, latest.operation.state !== "prepared" ? latest.operation.detail
        : `Recovery tracking paused: ${error instanceof Error ? error.message : String(error)}. Continue this same operationId.`);
    } catch { /* The backend retains the original dispatch before any pool call. */ }
    return { ...response(prepared), state: "pending", message: "The recovery reply is unresolved. Continue or inspect this same operationId; do not create another deposit request." };
  }
}
