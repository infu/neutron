import { exposeTool, isJsonObject, isMsgBusInstallationUid, type JsonObject, type JsonValue, type MsgBusToolContext, type ScopedKernelClient } from "neutron-tools/app";
import { createDirectFundingRequest, createFundingRequest, createRequestId, type FundingRequest } from "./funding.ts";
import { continueOperationFunding, savedFundingRequests, type FundingOperation } from "./funding_workflow.ts";
import { readTokenInfo, type WalletTokenInfo } from "./wallet.ts";
import { createBackendClient } from "./backend.ts";
import { buildActionReview, sameLiquidityExitTerms } from "./action_review.ts";
import { ActionReviewDeclinedError } from "./provider.ts";
import { buildLiquidityReceipt, buildSwapReceipt, durablePlanSource, liquiditySettlementGuidance } from "./action_receipt.ts";
import { readPayoutEvidence, type PayoutBlockReference } from "./payout_evidence.ts";
import { createLiquidityReadClient } from "./liquidity_reads.ts";
import { browserPoolToWire, previewLiquidity } from "./liquidity_quote.ts";
import { liquidityQuoteOutputSchema } from "./quote_schema.ts";
import { runDepositRecovery } from "./recovery_workflow.ts";
import { publishAppStateChange } from "neutron-tools/app";
import type { ActionBackend, ActionPrepared, ActionOperation, LiquidityWire, SwapWire } from "./action_backend.ts";

export type ActionDependencies = {
  backendFor: (kernel: ScopedKernelClient) => ActionBackend;
  authorize: (context: MsgBusToolContext, review: JsonObject) => Promise<void>;
  reads?: Pick<ReturnType<typeof createLiquidityReadClient>, "readPool">;
};
type Owner = { appId: string; installationUid: string; rootMode: boolean };
type Intent = { version: 1; kind: "swap" | "liquidity" | "recover_deposit"; owner: Owner; input: JsonObject };
type ActionContext = MsgBusToolContext;
const idSchema: JsonObject = { type: "string", pattern: "^[0-9a-f]{32}$" };
const textSchema: JsonObject = { type: "string" };
const natSchema: JsonObject = { type: "string", pattern: "^0$|^[1-9][0-9]*$" };
const readAnnotations: JsonObject = { "neutron:effects": ["read", "network"], "neutron:longRunning": true };
const effectAnnotations: JsonObject = { "neutron:effects": ["read", "write", "network", "user_visible_ui"], "neutron:consent": "provider_once", "neutron:longRunning": true };
const schema = (properties: JsonObject, required: string[] = []): JsonObject => ({ type: "object", properties, required, additionalProperties: false });
const asJson = (value: unknown) => value as JsonValue;

function id(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/.test(value)) throw new Error("Use one 32-character lowercase hexadecimal operationId and retain it for recovery.");
  return value;
}
function nat(value: unknown, label: string, fallback = "0"): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} must be an atomic decimal integer string.`);
  return value;
}
function integer(value: unknown, label: string, fallback = 0): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${label} must be an integer.`);
  return value;
}
function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required.`);
  return value.trim();
}
function owner(context: ActionContext): Owner {
  const caller = context.caller;
  if (!caller || typeof caller.appId !== "string" || !caller.appId || !isMsgBusInstallationUid(caller.installationUid)) {
    throw new Error("ICPSwap actions require the authenticated calling application.");
  }
  return { appId: caller.appId, installationUid: caller.installationUid, rootMode: !!context.agentMode };
}
function intentOf(operation: FundingOperation): Intent {
  const value: JsonValue = JSON.parse(operation.input_json);
  if (!isJsonObject(value) || value.version !== 1 || (value.kind !== "swap" && value.kind !== "liquidity" && value.kind !== "recover_deposit") || !isJsonObject(value.owner) || !isJsonObject(value.input)) {
    throw new Error("The saved action has no compatible original intent. Inspect its retained evidence.");
  }
  return value as unknown as Intent;
}
function assertOwner(intent: Intent, context: ActionContext): void {
  const current = owner(context);
  if (intent.owner.appId !== current.appId || intent.owner.installationUid !== current.installationUid || intent.owner.rootMode !== current.rootMode) {
    throw new Error("Continue this action from its original application and Normal or Root mode. Switching funding callers creates a different Wallet command.");
  }
}
function swapInput(args: JsonObject): JsonObject {
  const amount = nat(args.amount, "amount");
  if (amount === "0") throw new Error("Swap amount must be greater than zero.");
  const slippage = integer(args.slippage, "slippage", 500);
  if (slippage < 1 || slippage > 50_000) throw new Error("Swap slippage must be 1–50000 thousandths of a percent (500 is 0.5%).");
  const from = requiredText(args.from_ledger_id, "from_ledger_id"), to = requiredText(args.to_ledger_id, "to_ledger_id");
  if (from === to) throw new Error("Choose two different token ledgers.");
  return { from_ledger_id: from, to_ledger_id: to, amount, slippage };
}
function liquidityInput(args: JsonObject): JsonObject {
  const kind = requiredText(args.kind, "kind");
  if (!["mint", "increase", "decrease", "close", "claim", "withdraw"].includes(kind)) throw new Error("Unknown liquidity action.");
  const result: JsonObject = { kind, pool: requiredText(args.pool, "pool"), positionId: args.positionId === undefined || args.positionId === null ? null : nat(args.positionId, "positionId"),
    amount0: nat(args.amount0, "amount0"), amount1: nat(args.amount1, "amount1"), tickLower: integer(args.tickLower, "tickLower"), tickUpper: integer(args.tickUpper, "tickUpper"),
    liquidity: nat(args.liquidity, "liquidity"), token: typeof args.token === "string" ? args.token : "", amount: nat(args.amount, "amount") };
  if (["increase", "decrease", "close", "claim"].includes(kind) && result.positionId === null) throw new Error("positionId is required for this action.");
  return result;
}
function swapWire(operationId: string, input: JsonObject): SwapWire {
  return { request_id: operationId, input_address: String(input.from_ledger_id), output_address: String(input.to_ledger_id), amount_in: String(input.amount), slippage: String(input.slippage) };
}
function liquidityWire(input: JsonObject): LiquidityWire {
  return { pool: String(input.pool), kind: String(input.kind), position_id: input.positionId as string | null,
    amount0: String(input.amount0), amount1: String(input.amount1), tick_lower: String(input.tickLower), tick_upper: String(input.tickUpper),
    liquidity: String(input.liquidity), withdraw_token: String(input.token), withdraw_amount: String(input.amount) };
}
function response(prepared: ActionPrepared, message?: string): JsonObject {
  const liquidityReceipt = buildLiquidityReceipt(prepared);
  return asJson({ operationId: prepared.operation.id, state: prepared.operation.state,
    message: message ?? liquiditySettlementGuidance(liquidityReceipt) ?? prepared.operation.detail,
    operation: prepared.operation, plan: prepared.plan, planSource: durablePlanSource,
    receipt: buildSwapReceipt(prepared) ?? liquidityReceipt, fundingInstructions: [] }) as JsonObject;
}
/** A declined review only frees the form when the retained operation has
 * never dispatched anything. Missing/malformed evidence is not an empty log. */
function noDispatchRequested(operation: ActionOperation): boolean {
  if (operation.state !== "prepared" || operation.result_json !== "" || !Array.isArray(operation.effects)) return false;
  try { if (savedFundingRequests(operation).length !== 0) return false; }
  catch { return false; }
  return operation.effects.every((effect) => isJsonObject(effect) && effect.state === "not_requested"
    && effect.dispatched_at === "0" && effect.completed_at === null
    && effect.result_nat === null && effect.result_amount0 === null && effect.result_amount1 === null);
}

function pendingEffects(operation: FundingOperation): boolean {
  const effects = (operation as FundingOperation & { effects?: JsonObject[] }).effects ?? [];
  return effects.some((effect) => effect.state === "requested" || effect.state === "uncertain");
}

export function createActionHandlers(dependencies: ActionDependencies) {
  const reads = dependencies.reads ?? createLiquidityReadClient();
  const active = new Map<string, Promise<JsonObject>>();
  const exclusive = (context: ActionContext, operationId: string, run: () => Promise<JsonObject>): Promise<JsonObject> => {
    const key = `${owner(context).appId}:${owner(context).installationUid}:${operationId}`;
    const task = Promise.resolve(active.get(key)).catch(() => undefined).then(run);
    active.set(key, task);
    const cleanup = () => { if (active.get(key) === task) active.delete(key); void publishAppStateChange("activity", Date.now()).catch(() => undefined); };
    void task.then(cleanup, cleanup);
    return task;
  };
  const preparedFor = async (backend: ActionBackend, operation: FundingOperation, intent: Intent): Promise<ActionPrepared> => {
    const value = intent.kind === "swap" ? await backend.swapStatus(operation.id) : intent.kind === "liquidity" ? await backend.liquidityStatus(operation.id) : await backend.recoveryStatus(operation.id);
    if (!value) throw new Error("The saved operation has no retained protocol plan.");
    return value;
  };
  const displayMetadata = async (context: ActionContext, fundingMetadata: ReadonlyMap<string, WalletTokenInfo>) => {
    const metadata = new Map<string, Pick<WalletTokenInfo, "ledger" | "symbol" | "decimals">>();
    try {
      // These are saved display labels, never funding amounts, balances or fee
      // authority. An exit must not refresh Wallet balances just for formatting.
      const snapshot = await createBackendClient(context.kernel).getMarket("symbol", true);
      for (const row of snapshot.rows) if (row.symbol && Number.isInteger(row.decimals) && row.decimals >= 0 && row.decimals <= 255) {
        metadata.set(row.address, { ledger: row.address, symbol: row.symbol, decimals: row.decimals });
      }
    } catch { context.signal?.throwIfAborted(); /* Unknown labels display exact atoms. */ }
    for (const [ledger, info] of fundingMetadata) metadata.set(ledger, info);
    return metadata;
  };

  async function fundingBuilder(prepared: ActionPrepared, intent: Intent, context: ActionContext, metadata: Map<string, WalletTokenInfo>): Promise<(nowMs: number) => FundingRequest[]> {
    // Funding that has already been requested must be replayed without live
    // balance/fee reads preventing recovery of its original outcome.
    if (prepared.operation.state !== "prepared") return () => { throw new Error("Requested funding cannot be regenerated."); };
    if (intent.kind === "swap") {
      const plan = prepared.plan;
      const ledger = requiredText(plan.funding_ledger, "Swap funding ledger");
      const info = metadata.get(ledger) ?? await readTokenInfo(context.kernel, ledger);
      metadata.set(ledger, info);
      if (info.feeAtoms !== BigInt(nat(plan.token_in_fee, "Pool input fee"))) throw new Error("The pool input fee differs from Wallet's live ledger fee. Prepare a fresh quote before funding.");
      return (nowMs) => [createFundingRequest({ requestId: createRequestId(), ledger, spender: requiredText(plan.funding_spender, "Pool spender"), amountAtoms: nat(plan.funding_amount, "Swap funding amount"), nowMs })];
    }
    const plan = prepared.plan, requirements: Array<{ ledger: string; standard: string; amount: string; fee: string }> = [];
    for (const suffix of ["0", "1"]) {
      const amount = nat(plan[`funding${suffix}`], "Pool funding deficit");
      if (amount === "0") continue;
      const token = plan[`token${suffix}`];
      if (!isJsonObject(token)) throw new Error("The saved liquidity plan has no canonical token identity.");
      const ledger = requiredText(token.address, "Token ledger"), standard = requiredText(token.standard, "Token standard");
      if (!["ICRC2", "ICRC1", "ICP"].includes(standard)) throw new Error(`Wallet cannot fund ${standard} tokens. No funding was requested.`);
      const info = metadata.get(ledger) ?? await readTokenInfo(context.kernel, ledger), fee = nat(plan[`fee${suffix}`], "Pool ledger fee");
      metadata.set(ledger, info);
      if (info.account !== plan.owner) throw new Error("Wallet and the pool plan refer to different owner accounts.");
      if (info.feeAtoms !== BigInt(fee)) throw new Error("The pool's cached fee differs from Wallet's live ledger fee. No new funding was requested.");
      const needed = BigInt(amount) + 2n * info.feeAtoms;
      if (info.balanceAtoms < needed) throw new Error(`Wallet ${info.symbol} balance does not cover the funding deficit and both ledger fees.`);
      requirements.push({ ledger, standard, amount, fee });
    }
    return (nowMs) => requirements.map((value) => value.standard === "ICRC2"
      ? createFundingRequest({ requestId: createRequestId(), ledger: value.ledger, spender: String(plan.pool), amountAtoms: value.amount, nowMs })
      : createDirectFundingRequest({ requestId: createRequestId(), ledger: value.ledger, pool: String(plan.pool), owner: String(plan.owner), amountAtoms: value.amount, feeAtoms: value.fee, nowMs }));
  }

  async function run(context: ActionContext, operationId: string, supplied?: { kind: "swap" | "liquidity"; input: JsonObject }, fundingResults?: JsonValue[], prepareOnly = false): Promise<JsonObject> {
    context.signal?.throwIfAborted();
    const backend = dependencies.backendFor(context.kernel), metadata = new Map<string, WalletTokenInfo>();
    const existing = await backend.actionGet(operationId);
    let intent: Intent, prepared: ActionPrepared;
    let approvedPreview: JsonObject | null = null;
    let reviewMetadata: Awaited<ReturnType<typeof displayMetadata>> | null = null;
    if (existing) {
      intent = intentOf(existing); assertOwner(intent, context);
      if (supplied && (supplied.kind !== intent.kind || JSON.stringify(supplied.input) !== JSON.stringify(intent.input))) throw new Error("This operationId already belongs to different original inputs. Continue it without replacing the intent.");
      if (intent.kind === "recover_deposit") return runDepositRecovery({ operationId, ...(fundingResults ? { fundingResults } : {}) }, context, dependencies);
      prepared = await preparedFor(backend, existing, intent);
    } else {
      if (!supplied) throw new Error("No saved operation was found. If the original preparation reply was lost, call its original tool with the same operationId and exact original inputs.");
      intent = { version: 1, kind: supplied.kind, owner: owner(context), input: supplied.input };
      const input_json = JSON.stringify(intent);
      if (!prepareOnly && intent.kind === "liquidity" && ["decrease", "close", "claim", "withdraw"].includes(String(intent.input.kind))) {
        const [account, labels] = await Promise.all([backend.account(), displayMetadata(context, metadata)]);
        const preview = await previewLiquidity(liquidityWire(intent.input), account, reads, context.signal);
        context.signal?.throwIfAborted();
        await dependencies.authorize(context, buildActionReview({ operationId, kind: "liquidity", input: intent.input, plan: preview, metadata: labels }));
        context.signal?.throwIfAborted();
        approvedPreview = preview;
        reviewMetadata = labels;
      }
      if (intent.kind === "swap") {
        const tokenCache = createBackendClient(context.kernel);
        for (const ledger of [String(intent.input.from_ledger_id), String(intent.input.to_ledger_id)]) {
          let info: WalletTokenInfo;
          try { info = await readTokenInfo(context.kernel, ledger); }
          catch (error) {
            throw new Error(`${error instanceof Error ? error.message : String(error)} If this ledger is not selected, add ${ledger} with Wallet wallet_add_ledger_v1 (or wallet_add_ledger_root_v1 directly from Root), then retry this same operationId and original inputs.`);
          }
          context.signal?.throwIfAborted();
          metadata.set(ledger, info);
          await tokenCache.setTokenInfo(ledger, info.decimals, info.feeAtoms);
        }
      }
      prepared = intent.kind === "swap"
        ? await backend.swapPrepare({ id: operationId, input_json, request: swapWire(operationId, intent.input) })
        : await backend.liquidityPrepare({ id: operationId, input_json, request: liquidityWire(intent.input) });
    }
    let operation: ActionOperation = prepared.operation;
    if (prepareOnly) return response(prepared, "The original intent is saved. Continue this operationId to review funding and execution.");
    if (["stopped", "uncertain", "protocol_complete", "settlement_pending", "complete"].includes(operation.state) || pendingEffects(operation)) return response(prepared);
    context.signal?.throwIfAborted();
    const createRequests = await fundingBuilder(prepared, intent, context, metadata);
    if (intent.kind === "recover_deposit") throw new Error("Recovery actions use their retained recovery workflow.");
    if (approvedPreview === null || !sameLiquidityExitTerms(approvedPreview, prepared.plan)) {
      reviewMetadata ??= await displayMetadata(context, metadata);
      try {
        await dependencies.authorize(context, buildActionReview({ operationId, kind: intent.kind, input: intent.input, plan: prepared.plan, metadata: reviewMetadata }));
      } catch (error) {
        // An explicit owner decline is a successful review outcome, not an
        // unknown Wallet reply. Re-read after the dialog: another invocation
        // may have advanced the journal while the owner was deciding.
        if (intent.kind === "swap" && !context.agentMode && error instanceof ActionReviewDeclinedError && noDispatchRequested(prepared.operation)) {
          context.signal?.throwIfAborted();
          let latest: ActionOperation | null;
          try { latest = await backend.actionGet(operationId); }
          catch { throw error; }
          context.signal?.throwIfAborted();
          if (latest?.id === operationId && latest.input_json === prepared.operation.input_json && noDispatchRequested(latest)) {
            return { ...response({ ...prepared, operation: latest }, "Swap cancelled. No funds were sent. The prepared action remains in Activity."), state: "review_declined" };
          }
        }
        throw error;
      }
    }
    context.signal?.throwIfAborted();
    const noFundingExit = intent.kind === "liquidity" && ["decrease", "close", "claim", "withdraw"].includes(String(intent.input.kind))
      && prepared.plan.funding0 === "0" && prepared.plan.funding1 === "0"
      && (operation.state === "prepared" || operation.state === "funded") && savedFundingRequests(operation).length === 0;
    if (!noFundingExit && (operation.state === "prepared" || operation.state === "funding_requested" || operation.state === "funded")) {
      const progress = await continueOperationFunding({ operation, store: { get: (value) => backend.actionGet(value), update: (value) => backend.actionUpdate(value) }, client: context.kernel,
        rootMode: !!context.agentMode, fundingCallerAppId: context.agentMode ? owner(context).appId : "icpswap", createRequests, ...(fundingResults ? { fundingResults } : {}), ...(context.signal ? { signal: context.signal } : {}) });
      operation = { ...progress.operation, effects: (progress.operation as Partial<ActionOperation>).effects ?? prepared.operation.effects ?? [] };
      prepared = { ...prepared, operation };
      if (progress.status !== "ready") return { ...response(prepared, progress.message), state: progress.status === "pending" ? "pending" : progress.status, fundingInstructions: asJson(progress.fundingInstructions) };
    }
    context.signal?.throwIfAborted();
    // The protocol enforces expiry too. A replayed historical Wallet approval
    // cannot make an already expired allowance useful for a fresh pool call.
    const expired = savedFundingRequests(operation).some((request) => {
      if (request.route.kind !== "allowance" || BigInt(request.route.expiresAtNs) > BigInt(Date.now()) * 1_000_000n) return false;
      if (intent.kind === "liquidity") {
        const token0 = prepared.plan.token0, token1 = prepared.plan.token1;
        const index = isJsonObject(token0) && token0.address === request.ledger ? "0" : isJsonObject(token1) && token1.address === request.ledger ? "1" : null;
        if (index !== null && operation.effects?.some((effect) => effect.key === `deposit${index}` && effect.state === "succeeded")) return false;
      }
      return true;
    });
    if (expired) return { ...response(prepared, "A retained Wallet allowance has expired. No new protocol call was sent. Inspect this operation and any direct-funded pool account before preparing new funding."), state: "funding_expired" };
    try {
      const request = { id: operationId, expected_revision: operation.revision };
      return response(intent.kind === "swap" ? await backend.swapExecute(request) : await backend.liquidityExecute(request));
    } catch (error) {
      // Read the exact operation after an interrupted response. Never turn a
      // lost protocol reply into a new request or a clean failure claim.
      try {
        const latest = await backend.actionGet(operationId);
        if (latest) {
          const observed = await preparedFor(backend, latest, intent);
          if (["stopped", "uncertain", "protocol_complete", "settlement_pending", "complete"].includes(observed.operation.state)) return response(observed);
          return response(observed, `Tracking paused: ${error instanceof Error ? error.message : String(error)}. Continue or reconcile this same operation; no duplicate protocol request was created.`);
        }
      } catch { /* Original durable dispatch state remains authoritative. */ }
      return { ...response(prepared), state: "pending", message: "The protocol reply is unresolved. Inspect or continue this same operationId; do not create another intent." };
    }
  }

  const swap = (args: JsonObject, context: ActionContext) => { const operationId = id(args.operationId); return exclusive(context, operationId, () => run(context, operationId, { kind: "swap", input: swapInput(args) })); };
  const liquidity = (args: JsonObject, context: ActionContext) => { const operationId = id(args.operationId); return exclusive(context, operationId, () => run(context, operationId, { kind: "liquidity", input: liquidityInput(args) })); };
  const continueSaved = (args: JsonObject, context: ActionContext) => { const operationId = id(args.operationId); return exclusive(context, operationId, () => run(context, operationId, undefined, Array.isArray(args.fundingResults) ? args.fundingResults : undefined)); };
  const recoverDeposit = (args: JsonObject, context: ActionContext) => { const operationId = id(args.operationId); return exclusive(context, operationId, () => runDepositRecovery(args, context, dependencies)); };
  const status = async (args: JsonObject, context: ActionContext): Promise<JsonObject> => {
    const operationId = id(args.operationId), backend = dependencies.backendFor(context.kernel), operation = await backend.actionGet(operationId);
    if (!operation) return { operationId, state: "not_found", message: "No saved operation found.", operation: null, fundingInstructions: [] };
    return response(await preparedFor(backend, operation, intentOf(operation)));
  };
  const reconcile = async (args: JsonObject, context: ActionContext): Promise<JsonObject> => {
    if (args.walletEvidence !== undefined && typeof args.walletEvidence !== "boolean") throw new Error("walletEvidence must be true or false.");
    const payoutBlocks: PayoutBlockReference[] = [];
    if (args.payoutBlocks !== undefined) {
      if (!Array.isArray(args.payoutBlocks)) throw new Error("payoutBlocks must be a list of ledger and blockIndex references.");
      for (const value of args.payoutBlocks) {
        if (!isJsonObject(value) || typeof value.blockIndex !== "string") throw new Error("Each payout block needs a ledger and exact blockIndex string.");
        payoutBlocks.push({ ledger: requiredText(value.ledger, "Payout ledger"), blockIndex: nat(value.blockIndex, "Payout blockIndex") });
      }
      if (args.walletEvidence === false && payoutBlocks.length) throw new Error("Enable walletEvidence to inspect payoutBlocks.");
    }
    const operationId = id(args.operationId), backend = dependencies.backendFor(context.kernel), operation = await backend.actionGet(operationId);
    if (!operation) return { operationId, state: "not_found", message: "No saved operation found.", operation: null, fundingInstructions: [] };
    const intent = intentOf(operation);
    const prepared = await preparedFor(backend, operation, intent);
    const poolId = requiredText(prepared.plan.pool, "Saved pool");
    let account: string | null = null;
    let accountError: unknown;
    let pool: JsonObject;
    try {
      try { account = typeof prepared.plan.owner === "string" ? prepared.plan.owner : await backend.account(); }
      catch (error) { accountError = error; throw error; }
      pool = browserPoolToWire(await reads.readPool(poolId, account, context.signal));
    } catch (error) {
      context.signal?.throwIfAborted();
      pool = { pool: poolId, owner: account, protocol_diagnostics: error instanceof Error ? error.message : String(error), complete: false };
    }
    const result = { ...response(prepared), pool };
    if (args.walletEvidence === false) return result;
    try {
      if (account === null) throw accountError ?? new Error("The Neutron account is unavailable.");
      const walletEvidence = await readPayoutEvidence({ prepared, kernel: context.kernel, owner: account, payoutBlocks,
        ...(context.signal ? { signal: context.signal } : {}) });
      return { ...result, walletEvidence: asJson(walletEvidence) };
    } catch (error) {
      return { ...result, walletEvidence: { version: 1, operationId, status: "unavailable",
        reason: "Wallet evidence could not be read. The retained protocol result remains available; no payout conclusion was made.",
        settlementVerified: false, operationLinkVerified: false, effect: null, ledgers: [], explicitBlocks: [],
        errors: [error instanceof Error ? error.message : String(error)] } };
    }
  };
  const history = async (args: JsonObject, context: ActionContext): Promise<JsonObject> => {
    const cursor = typeof args.cursor === "string" ? args.cursor : null;
    const limit = integer(args.limit, "limit", 20); if (limit < 1) throw new Error("History limit must be positive.");
    const page = await dependencies.backendFor(context.kernel).actionPage({ cursor, limit });
    return { items: asJson(page.items), nextCursor: page.nextCursor };
  };
  const legacySwap = (args: JsonObject, context: ActionContext) => {
    const suppliedId = args.request_id ?? args.operationId, operationId = suppliedId === undefined ? createRequestId() : id(suppliedId);
    return exclusive(context, operationId, () => run(context, operationId, { kind: "swap", input: swapInput(args) }, undefined, suppliedId === undefined));
  };
  const liquidityQuote = async (args: JsonObject, context: ActionContext): Promise<JsonObject> => {
    const request = liquidityWire(liquidityInput(args));
    context.signal?.throwIfAborted();
    const account = await dependencies.backendFor(context.kernel).account();
    return { version: 1, plan: await previewLiquidity(request, account, reads, context.signal), transport: "direct-canister-query" };
  };
  return { swap, liquidity, continue: continueSaved, status, reconcile, history, legacySwap, recoverDeposit, liquidityQuote };
}

const swapProperties: JsonObject = { operationId: idSchema, from_ledger_id: textSchema, to_ledger_id: textSchema, amount: natSchema,
  slippage: { type: "integer", minimum: 1, maximum: 50000, description: "Thousandths of one percent; 500 is 0.5%." } };
const liquidityProperties: JsonObject = { operationId: idSchema, kind: { enum: ["mint", "increase", "decrease", "close", "claim", "withdraw"] }, pool: textSchema,
  positionId: natSchema, amount0: natSchema, amount1: natSchema, tickLower: { type: "integer" }, tickUpper: { type: "integer" }, liquidity: natSchema, token: textSchema, amount: natSchema };

export function registerActionTools(dependencies: ActionDependencies, register: typeof exposeTool = exposeTool) {
  const handlers = createActionHandlers(dependencies);
  register("icpswap_swap_v1", { title: "Swap through ICPSwap", description: "Save an exact pool/minimum-output swap and retain all Wallet and protocol request identities. Atomic input amount; slippage 500 means 0.5%. Normal mode opens owner review. Root mode returns exact Wallet fundingInstructions for the depth-zero Agent to call directly, then continue with their raw fundingResults. Reuse operationId and identical inputs after any interrupted reply; approval alone is not a completed swap.", inputSchema: schema(swapProperties, ["operationId", "from_ledger_id", "to_ledger_id", "amount"]), annotations: effectAnnotations }, handlers.swap);
  register("icpswap_liquidity_v1", { title: "Manage ICPSwap liquidity", description: "Mint/increase a canonical pool position, decrease exact liquidity, close the entire saved position, claim fees, or withdraw gross unused funds. amount0/amount1 are token0/token1 atomic maxima. positionId identifies an owned position. withdraw uses token and gross amount. Liquidity methods have no onchain minimum amounts/deadline. Funding and protocol dispatch remain in one durable operation; payouts/refunds settle asynchronously. Root fundingInstructions must be called directly by the root Agent before continuing.", inputSchema: schema(liquidityProperties, ["operationId", "kind", "pool"]), annotations: effectAnnotations }, handlers.liquidity);
  register("icpswap_recover_deposit_v1", { title: "Recover a funded ICPSwap deposit", description: "Use a NEW recovery operationId with sourceOperationId and canonical tokenIndex (0 or 1) to credit an already-confirmed direct Wallet transfer from the pool's owner deposit subaccount into pool-unused funds. Reviews the original gross amount and current deposit fee. Never requests another Wallet transfer. Unknown original Wallet commands must be reconciled through their exact original caller; Root may supply matching raw fundingResults. An already dispatched or uncertain pool deposit is never repeated. Continue the recovery's own operationId after a lost reply.", inputSchema: schema({ operationId: idSchema, sourceOperationId: idSchema, tokenIndex: { type: "integer", enum: [0, 1] }, fundingResults: { type: "array", items: { type: "object" } } }, ["operationId", "sourceOperationId", "tokenIndex"]), annotations: effectAnnotations }, handlers.recoverDeposit);
  register("icpswap_continue_v1", { title: "Continue a saved ICPSwap action", description: "Continue original intent and exact request identities from the same application and Normal/Root mode. For Root funding, pass the raw Wallet output objects in fundingResults. Unknown protocol effects are never replayed. Human callers cannot take over a Root-funded command by changing its Wallet caller namespace.", inputSchema: schema({ operationId: idSchema, fundingResults: { type: "array", items: { type: "object" } } }, ["operationId"]), annotations: effectAnnotations }, handlers.continue);
  register("icpswap_status_v1", { title: "Read an ICPSwap action", description: "Read retained typed plan, funding, protocol effects and available protocol receipt for a durable operationId. plan decodes the durable plan_blob even when operation.plan_json is empty. Receipt unknown amounts remain null. Liquidity payoutEstimates separate expected pool credit from Wallet payout using saved fees; neither estimates nor successful protocol replies verify ledger settlement. This read sends no Wallet request or protocol mutation.", inputSchema: schema({ operationId: idSchema }, ["operationId"]), annotations: { "neutron:effects": ["read"] } }, handlers.status);
  register("icpswap_reconcile_v1", { title: "Refresh ICPSwap action recovery", description: "Refresh the saved action and verified pool. By default, read recent incoming pool-to-Wallet transfers for successful effects; walletEvidence=false skips Wallet reads. Optional payoutBlocks inspect exact ledger/blockIndex references, including archives when available. Returned Wallet transfers are contextual evidence, not operation-linked settlement proof; empty queues or pages do not prove a payout is absent. Never repeats a swap, deposit or liquidity mutation.", inputSchema: schema({ operationId: idSchema, walletEvidence: { type: "boolean", description: "Defaults to true. false skips Wallet reads and cannot be combined with nonempty payoutBlocks." }, payoutBlocks: { type: "array", description: "Exact ledger/block references to inspect. Requires walletEvidence=true or omitted. For older account history call Wallet wallet_account_transactions_v1 with beforeBlock from the returned coverage pagination.", items: schema({ ledger: textSchema, blockIndex: natSchema }, ["ledger", "blockIndex"]) } }, ["operationId"]), annotations: readAnnotations }, handlers.reconcile);
  register("icpswap_history_v1", { title: "Read ICPSwap actions", description: "Paginate all retained ICPSwap actions, including pending funding and uncertain protocol calls. Follow nextCursor for older records. Journals remain available after closing the tile.", inputSchema: schema({ cursor: textSchema, limit: { type: "integer", minimum: 1 } }), annotations: { "neutron:effects": ["read"] } }, handlers.history);
  register("icpswap_liquidity_quote_v1", { title: "Preview ICPSwap liquidity", outputSchema: liquidityQuoteOutputSchema, description: "Query ICPSwap directly from the browser for current pool/position state, live amounts, range, fees and funding deficits without moving funds or saving a plan. Preparation revalidates these observations as the Neutron account. Liquidity amounts are estimates; the protocol has no minimum output/deadline protection.", inputSchema: schema(Object.fromEntries(Object.entries(liquidityProperties).filter(([key]) => key !== "operationId")), ["kind", "pool"]), annotations: readAnnotations }, handlers.liquidityQuote);
  return handlers;
}
