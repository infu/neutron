import { exposeTool, type JsonObject, type JsonValue, type MsgBusToolContext } from "neutron-tools/app";
import { requireEvmWalletCaller } from "neutron-tools/evm_wallet";
import { getAddress } from "viem";
import { createServiceWallet } from "./agent_wallet.ts";
import { createActionStore, type ActionRecord } from "./action_store.ts";
import { actionInvocation, actionResult, latestAction, reconcileAction, runAction, type ActionEnvelope, type ActionResult } from "./action_workflow.ts";
import { walletReader } from "./controller.ts";
import { prepareLiquidity, type LiquidityInput, type LiquidityPreview } from "./liquidity.ts";
import type { ActionPlan } from "./action_types.ts";
import { listPositions, readPool, readPosition, type PoolInput, type PoolState, type PositionListCursor, type PositionProtocol, type PositionRecord } from "./positions.ts";

export const toolText = { type: "string" };
export const toolAddress = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" };
export const toolUint = { type: "string", pattern: "^0$|^[1-9][0-9]*$" };
export const toolPositive = { type: "string", pattern: "^[1-9][0-9]*$" };
export const toolNullableText = { oneOf: [toolText, { type: "null" }] };
export const toolOperationId = { type: "string", pattern: "^[0-9a-f]{32}$" };
export function toolSchema(properties: JsonObject, required = Object.keys(properties)): JsonObject { return { type: "object", properties, required, additionalProperties: false }; }
export function toolJson(value: unknown): JsonValue { return value as JsonValue; }
export const tokenOutputSchema = toolSchema({ address: { oneOf: [toolAddress, { type: "null" }] }, symbol: toolText, decimals: { type: "integer" } });
export const poolOutputSchema = toolSchema({ protocol: { enum: ["v3", "v4"] }, chainId: toolText, token0: tokenOutputSchema, token1: tokenOutputSchema, fee: { type: "integer" }, tickSpacing: { type: "integer" }, hooks: toolAddress, address: toolNullableText, poolId: toolNullableText, sqrtPriceX96: toolText, tick: { type: "integer" }, liquidity: toolText, blockNumber: toolText });
export function compactToken(token: PoolState["token0"]) { return { address: token.address, symbol: token.symbol, decimals: token.decimals }; }
export function compactPool(pool: PoolState) { return { protocol: pool.protocol, chainId: pool.chainId, token0: compactToken(pool.token0), token1: compactToken(pool.token1), fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: pool.hooks, address: pool.address ?? null, poolId: pool.poolId ?? null, sqrtPriceX96: pool.sqrtPriceX96, tick: pool.tick, liquidity: pool.liquidity, blockNumber: pool.blockNumber }; }
const positionOutputSchema = toolSchema({ protocol: { enum: ["v3", "v4"] }, chainId: toolText, accountId: toolText, tokenId: toolText, owner: toolAddress, manager: toolAddress, pool: poolOutputSchema, tickLower: { type: "integer" }, tickUpper: { type: "integer" }, liquidity: toolText, amount0: toolText, amount1: toolText, fees0: toolText, fees1: toolText, owed0: toolText, owed1: toolText, claimable0: toolText, claimable1: toolText, inRange: { type: "boolean" }, hasSubscriber: { type: "boolean" }, blockNumber: toolText });
export function compactPosition(position: PositionRecord) { return { ...position, pool: compactPool(position.pool) }; }
const liquidityPreviewSchema = toolSchema({ operation: toolText, protocol: { enum: ["v3", "v4"] }, tokenId: toolNullableText, token0: tokenOutputSchema, token1: tokenOutputSchema, tickLower: { type: "integer" }, tickUpper: { type: "integer" }, liquidity: toolText, amount0: toolText, amount1: toolText, amount0Max: toolText, amount1Max: toolText, amount0Min: toolText, amount1Min: toolText, recipient: toolAddress, deadline: toolText, inRange: { type: "boolean" }, pool: poolOutputSchema, warnings: { type: "array", items: toolText } });

export const actionOutputSchema = toolSchema({
  operationId: toolText, recordId: toolNullableText, state: { enum: ["complete", "pending", "review", "stopped"] }, phase: toolText,
  summary: toolText, transactionHash: toolNullableText,
  steps: { type: "array", items: toolSchema({ label: toolText, kind: toolText, status: toolText, transactionHash: toolNullableText }) },
  positionTokenIds: { type: "array", items: toolText }, message: toolText,
});

/** Preserve the published closed tool response shape. Full receipts and calldata
 * remain in the journal; terminal prose includes the receipt's block/finality. */
export function compactActionResult(result: ActionResult) {
  return { operationId: result.operationId, recordId: result.recordId, state: result.state, phase: result.phase, summary: result.summary, transactionHash: result.transactionHash, steps: result.steps.map(({ label, kind, status, transactionHash }) => ({ label, kind, status, transactionHash })), positionTokenIds: result.positionTokenIds, message: result.message };
}

type PrepareAction = Parameters<typeof runAction>[5];
const actionCalls = new Map<string, Promise<ActionResult>>();

/** Yield before the existing Agent transport deadline, retaining the original
 * operation and request IDs. This is continuation, not an operation time limit. */
export async function runToolAction(context: MsgBusToolContext, envelope: ActionEnvelope, prepare: PrepareAction, toolName: string): Promise<JsonValue> {
  const caller = requireEvmWalletCaller(context), controller = new AbortController();
  const cancel = () => controller.abort(context.signal?.reason ?? new Error("Action tracking paused"));
  context.signal?.addEventListener("abort", cancel, { once: true });
  if (context.signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new Error("Continue the saved action in another tool call")), 240_000);
  const continuation = `Call ${toolName} again with the same operationId and identical original arguments to reconcile and continue. Approval alone is not completion. An interrupted reply does not mean the transaction failed; do not create a second operation.`;
  let latest: ActionRecord | null = null;
  const key = `${caller.appId}:${caller.installationUid}:${envelope.operationId}`;
  const previous = actionCalls.get(key);
  const task = Promise.resolve(previous).catch(() => undefined).then(() => {
    controller.signal.throwIfAborted();
    return runAction(createServiceWallet({ ...context, signal: controller.signal }), createActionStore(context.kernel), envelope, caller, !!context.agentMode, prepare, {
      signal: controller.signal,
      onRecord: (record) => { latest = record; },
      onProgress: (phase) => context.reportProgress({ phase, operationId: envelope.operationId }),
    });
  });
  actionCalls.set(key, task);
  const release = () => { if (actionCalls.get(key) === task) actionCalls.delete(key); };
  void task.then(release, release);
  let interruptedListener!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    interruptedListener = () => reject(controller.signal.reason ?? new Error("Action tracking paused"));
    controller.signal.addEventListener("abort", interruptedListener, { once: true });
    if (controller.signal.aborted) interruptedListener();
  });
  try {
    const result = compactActionResult(await Promise.race([task, interrupted]));
    if (result.state === "pending" || result.state === "review") result.message = `${result.message} ${continuation}`;
    return toolJson(result);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    if (latest) return toolJson(compactActionResult(actionResult(latest, "pending", `Tracking paused with the original operation retained. ${continuation}`)));
    return { operationId: envelope.operationId, recordId: null, state: "pending", phase: "preparing", summary: "Action preparation paused", transactionHash: null, steps: [], positionTokenIds: [], message: continuation };
  } finally {
    clearTimeout(timer); context.signal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", interruptedListener);
  }
}

export async function toolAccount(context: MsgBusToolContext, accountId: unknown = "main") {
  const wallet = createServiceWallet(context);
  const account = (await wallet.accounts()).accounts.find((entry) => entry.accountId === accountId);
  if (!account) throw new Error("EVM Wallet account is unavailable.");
  return { wallet, account, read: walletReader(wallet, account.accountId) };
}

const liquidityProperties: JsonObject = {
  operation: { enum: ["mint", "increase", "decrease", "collect", "close"] }, protocol: { enum: ["v3", "v4"] },
  chainId: { enum: ["1", "42161"] }, accountId: { const: "main" }, tokenId: toolUint,
  tokenA: { oneOf: [toolAddress, { type: "null" }] }, tokenB: { oneOf: [toolAddress, { type: "null" }] },
  maxAmountA: toolUint, maxAmountB: toolUint, fee: { type: "integer", minimum: 0 }, tickSpacing: { type: "integer", minimum: 1 }, hooks: toolAddress,
  tickLower: { type: "integer" }, tickUpper: { type: "integer" }, liquidityBps: { type: "integer", minimum: 1, maximum: 10000 }, liquidity: toolPositive,
  recipient: toolAddress, slippageBps: { type: "integer", minimum: 0, maximum: 9999 }, hookData: { type: "string", pattern: "^0x[0-9a-fA-F]*$" },
  quoteValiditySeconds: { type: "integer", minimum: 1 },
};

export function parseLiquidityToolInput(args: JsonObject): LiquidityInput {
  const fields = Object.fromEntries(Object.keys(liquidityProperties).filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));
  // Address normalization and explicit defaults make identical retries stable
  // across UI and Agent invocations; the planner validates protocol constraints.
  for (const key of ["tokenA", "tokenB", "recipient", "hooks"]) if (typeof fields[key] === "string") fields[key] = getAddress(fields[key] as string);
  return { ...fields, accountId: "main", slippageBps: args.slippageBps ?? 50, quoteValiditySeconds: args.quoteValiditySeconds ?? 1200 } as LiquidityInput;
}

function compactPlan(plan: ActionPlan) {
  const preview = plan.details.preview as LiquidityPreview | undefined;
  return { summary: plan.summary, chainId: plan.chainId, accountId: plan.accountId, deadline: plan.deadline, steps: plan.steps.map((step) => ({ label: step.label, kind: step.kind })), preview: preview ? { ...preview, token0: compactToken(preview.token0), token1: compactToken(preview.token1), pool: compactPool(preview.pool) } : null };
}

export function registerLiquidityTools() {
  exposeTool("uniswap_liquidity_quote_v1", {
    title: "Preview a Uniswap liquidity action",
    description: "Read and prepare a V3 or V4 position action without signing or sending anything. mint creates a position in an existing pool; increase adds within its existing range; decrease withdraws exact liquidity or liquidityBps; collect collects available amounts; close withdraws all, collects and burns the NFT. Collected stored owed amounts can include withdrawn principal as well as fees; do not count the entire collection as profit. Position reads separate freshly accrued fees from stored owed amounts. maxAmountA/B are hard atomic token budgets. Null token means native ETH. For existing positions tokenA/B optionally orient budgets, otherwise pool currency0/1. Defaults: main account, own recipient, 50 slippage bps, 1200 seconds, mint fee 3000 and full range. Pool/range fields on existing positions must match on-chain state; V4 hooks and hookData are explicit advanced inputs. Use uniswap_manage_liquidity_v1 for the complete action.",
    inputSchema: toolSchema(liquidityProperties, ["operation", "protocol", "chainId"]),
    outputSchema: toolSchema({ summary: toolText, chainId: toolText, accountId: toolText, deadline: toolText, steps: { type: "array", items: toolSchema({ label: toolText, kind: toolText }) }, preview: { oneOf: [liquidityPreviewSchema, { type: "null" }] } }),
    annotations: { "neutron:effects": ["read", "network"], "neutron:longRunning": true },
  }, async (args, context) => {
    const input = parseLiquidityToolInput(args), { account, read } = await toolAccount(context, input.accountId);
    context.reportProgress({ phase: "Reading position and preparing exact liquidity amounts" });
    return toolJson(compactPlan(await prepareLiquidity(read, account, input)));
  });

  exposeTool("uniswap_manage_liquidity_v1", {
    title: "Manage Uniswap liquidity through approval and confirmation",
    description: "Complete a V3 or V4 mint, increase, decrease, collect or close action, including every required allowance, Wallet review and final confirmed transaction. Use one stable 32-hex operationId; after pending, review or a lost reply call again with identical original arguments. Continue until complete; approval alone is never completion. Serialize effectful swap and liquidity flows within one Agent run; independent reads can run in parallel. Amounts are hard maximum atomic budgets; withdrawals use exact liquidity or liquidityBps (10000 = all). Collect transfers available amounts, which may include withdrawn principal and fees; it is not entirely profit. Position reads separately report fresh fees and stored owed amounts. The Wallet presents exact effects to the human or current Agent judge using the owner's existing instructions. Defaults and pool/range semantics match uniswap_liquidity_quote_v1. A minted position ID is reported only from the confirmed NFT Transfer receipt.",
    inputSchema: toolSchema({ operationId: toolOperationId, ...liquidityProperties }, ["operationId", "operation", "protocol", "chainId"]),
    outputSchema: actionOutputSchema, annotations: { "neutron:effects": ["read", "write", "network", "user_visible_ui"], "neutron:longRunning": true },
  }, (args, context) => {
    const input = parseLiquidityToolInput(args);
    return runToolAction(context, { operationId: String(args.operationId), kind: "liquidity", chainId: input.chainId, accountId: "main", input: input as unknown as Record<string, unknown> }, ({ wallet, account, envelope, now }) => prepareLiquidity(walletReader(wallet, account.accountId), account, envelope.input as LiquidityInput, now()), "uniswap_manage_liquidity_v1");
  });

  exposeTool("uniswap_action_status_v1", {
    title: "Read saved Uniswap action progress",
    description: "Read compact durable progress for a V2 swap or liquidity action, following quote-renewal attempts. This reads the journal, not live receipts. Use uniswap_action_reconcile_v1 to refresh known transaction evidence without sending, or uniswap_action_input_v1 to recover the saved invocation before explicitly continuing the same operation.",
    inputSchema: toolSchema({ operationId: toolOperationId }), outputSchema: toolSchema({ action: { oneOf: [actionOutputSchema, { type: "null" }] } }), annotations: { "neutron:effects": ["read"] },
  }, async (args, context) => {
    const record = await latestAction(createActionStore(context.kernel), String(args.operationId));
    return toolJson({ action: record ? compactActionResult(actionResult(record)) : null });
  });

  exposeTool("uniswap_action_input_v1", {
    title: "Recover the saved Uniswap invocation",
    description: "Read the canonical saved arguments, original operationId, continuation tool and caller ownership for a V2 swap or liquidity action, following quote renewals. argumentsJson includes saved defaults and can be used unchanged with the returned toolName for explicit continuation. gasEstimateJson contains any retained pre-dispatch gas observation, block and chosen limit; null means none was saved. Reading does not authorize execution: the original caller installation, Agent mode and signing identity still apply. Check uniswap_action_reconcile_v1 first; never replay a completed mint as a new operation. No Wallet or network call is made.",
    inputSchema: toolSchema({ operationId: toolOperationId }),
    outputSchema: toolSchema({ invocation: { oneOf: [toolSchema({ operationId: toolText, recordId: toolText, toolName: { enum: ["uniswap_swap_v2", "uniswap_manage_liquidity_v1"] }, argumentsJson: toolText, gasEstimateJson: toolNullableText, caller: { oneOf: [toolSchema({ appId: toolText, installationUid: toolText }), { type: "null" }] }, agentMode: { type: "boolean" }, humanOwned: { type: "boolean" } }), { type: "null" }] } }),
    annotations: { "neutron:effects": ["read"] },
  }, async (args, context) => {
    const record = await latestAction(createActionStore(context.kernel), String(args.operationId));
    return toolJson({ invocation: record ? actionInvocation(record) : null });
  });

  exposeTool("uniswap_action_reconcile_v1", {
    title: "Refresh saved Uniswap transaction receipts",
    description: "Refresh public transaction fields and receipts for hashes already linked to saved Wallet requests, following quote renewals. Updates only the Uniswap journal; never signs, broadcasts, opens a review, creates a quote or continues a queued step. Each step reports its exact requestId, whether it was checked live, and receipt status/block/finality. A disappeared receipt becomes pending/unknown; success is verified against saved sender, destination, calldata and value. A dispatched request with no saved hash stays unknown: retrieve uniswap_action_input_v1 for explicit recovery through the original invocation. Successful mint IDs come from the matching receipt and must not be reminted.",
    inputSchema: toolSchema({ operationId: toolOperationId }),
    outputSchema: toolSchema({ action: { oneOf: [toolSchema({ ...(actionOutputSchema.properties as JsonObject), steps: { type: "array", items: toolSchema({ label: toolText, kind: toolText, status: toolText, transactionHash: toolNullableText, requestId: toolText, checked: { type: "boolean" }, receipt: { oneOf: [toolSchema({ status: { enum: ["success", "reverted"] }, blockNumber: toolText, finality: { enum: ["included", "safe", "finalized"] } }), { type: "null" }] } }) } }), { type: "null" }] } }),
    annotations: { "neutron:effects": ["read", "write", "network"], "neutron:longRunning": true },
  }, async (args, context) => {
    const result = await reconcileAction(createServiceWallet(context), createActionStore(context.kernel), String(args.operationId), {
      ...(context.signal ? { signal: context.signal } : {}), onProgress: (phase) => context.reportProgress({ phase }),
    });
    return toolJson({ action: result ? { ...compactActionResult(result), steps: result.steps } : null });
  });

  exposeTool("uniswap_actions_page_v1", {
    title: "Read a page of Uniswap liquidity and swap activity",
    description: "Read compact saved action summaries, newest first. Start with cursor null and follow nextCursor until null. A quote renewal can have another recordId for the same operationId. Use action_status for current progress; this history call performs no Wallet effect.",
    inputSchema: toolSchema({ cursor: toolNullableText, limit: { type: "integer", minimum: 1 } }, []),
    outputSchema: toolSchema({ actions: { type: "array", items: toolSchema({ operationId: toolText, recordId: toolText, kind: toolText, summary: toolText, phase: toolText, chainId: toolText, accountId: toolText, createdAtNs: toolText, updatedAtNs: toolText }) }, nextCursor: toolNullableText }), annotations: { "neutron:effects": ["read"] },
  }, async (args, context) => {
    const page = await createActionStore(context.kernel).page(args.cursor as string | null | undefined, args.limit === undefined ? undefined : Number(args.limit));
    return toolJson({ actions: page.rows.map((row) => ({ operationId: row.operationId, recordId: row.id, kind: row.kind, summary: row.summary, phase: row.phase, chainId: row.chainId, accountId: row.accountId, createdAtNs: row.created_at, updatedAtNs: row.updated_at })), nextCursor: page.nextCursor });
  });

  exposeTool("uniswap_positions_v1", {
    title: "List owned Uniswap V3 and V4 positions",
    description: "Read a page of owned liquidity positions and current principal, freshly accrued fees, stored owed amounts and total available to collect. V3 discovery is on-chain; V4 uses public browser index hints and verifies every owner and pool on-chain. A partial or unavailable index returns complete:false and errors, never a false empty portfolio. Start with cursor null; follow nextCursor with the same chain/protocol until null. Saved imports are included. Atomic amounts follow pool token0/token1. Stored V3 owed amounts may include withdrawn principal, not only fees. For USD valuation, call EVM Wallet evm_wallet_prices_v1 with the returned token chain IDs and addresses and multiply each atomic amount by its price using the returned token decimals; check the market timestamps and treat unavailable prices as unknown, not zero.",
    inputSchema: toolSchema({ chainId: { enum: ["1", "42161"] }, accountId: { const: "main" }, protocol: { enum: ["v3", "v4"] }, cursor: toolNullableText, pageSize: { type: "integer", minimum: 1 } }, ["chainId"]),
    outputSchema: toolSchema({ positions: { type: "array", items: positionOutputSchema }, totalOwned: toolSchema({ v3: toolNullableText, v4: toolNullableText }), complete: { type: "boolean" }, errors: { type: "array", items: toolText }, nextCursor: toolNullableText, blockNumber: toolText }),
    annotations: { "neutron:effects": ["read", "network"], "neutron:longRunning": true },
  }, async (args, context) => {
    const { account, read } = await toolAccount(context, args.accountId ?? "main"), chainId = String(args.chainId);
    const knownIds = await createActionStore(context.kernel).positionRefs(chainId);
    const cursor = args.cursor === undefined || args.cursor === null ? undefined : JSON.parse(String(args.cursor)) as PositionListCursor;
    context.reportProgress({ phase: "Discovering and verifying owned liquidity positions" });
    const result = await listPositions(read, { accountId: account.accountId, address: getAddress(account.address) }, chainId, { knownIds, ...(args.protocol ? { protocol: args.protocol as PositionProtocol } : {}), ...(cursor ? { cursor } : {}), ...(args.pageSize !== undefined ? { pageSize: Number(args.pageSize) } : {}), ...(context.signal ? { signal: context.signal } : {}) });
    return toolJson({ ...result, positions: result.positions.map(compactPosition), nextCursor: result.nextCursor === null ? null : JSON.stringify(result.nextCursor) });
  });

  const positionInputSchema = toolSchema({ chainId: { enum: ["1", "42161"] }, accountId: { const: "main" }, protocol: { enum: ["v3", "v4"] }, tokenId: toolUint }, ["chainId", "protocol", "tokenId"]);
  const getPosition = async (args: JsonObject, context: MsgBusToolContext) => {
    const { account, read } = await toolAccount(context, args.accountId ?? "main");
    return readPosition(read, { chainId: String(args.chainId), accountId: account.accountId, owner: getAddress(account.address), protocol: args.protocol as PositionProtocol, tokenId: String(args.tokenId) });
  };
  exposeTool("uniswap_position_v1", {
    title: "Read an owned Uniswap position",
    description: "Verify a V3 or V4 NFT belongs to the Wallet, then read its actual pool, range, liquidity, token principal and collectible amounts at one block. This performs no signature or transaction. For a position missing from discovery, use uniswap_import_position_v1 to remember its verified ID. Changing a range requires withdrawing and creating a new position.",
    inputSchema: positionInputSchema, outputSchema: toolSchema({ position: positionOutputSchema }), annotations: { "neutron:effects": ["read", "network"], "neutron:longRunning": true },
  }, async (args, context) => toolJson({ position: compactPosition(await getPosition(args, context)) }));
  exposeTool("uniswap_import_position_v1", {
    title: "Remember an owned Uniswap position",
    description: "Verify an existing V3 or V4 position on-chain and save its protocol/token ID so it appears even when the public index is behind. Does not send an EVM transaction or change the NFT; ownership is verified again on every future read.",
    inputSchema: positionInputSchema, outputSchema: toolSchema({ position: positionOutputSchema }), annotations: { "neutron:effects": ["read", "write", "network"], "neutron:longRunning": true },
  }, async (args, context) => {
    const position = await getPosition(args, context);
    await createActionStore(context.kernel).trackPosition({ chainId: position.chainId, protocol: position.protocol, tokenId: position.tokenId });
    return toolJson({ position: compactPosition(position) });
  });
  exposeTool("uniswap_pool_v1", {
    title: "Read an existing Uniswap liquidity pool",
    description: "Read an initialized V3 or V4 pool's currencies, fee, tick spacing, current tick, sqrtPriceX96 and active liquidity at one block. For V4 specify its exact tickSpacing and hooks if present. A missing pool is reported as an error; this tool does not create or initialize pools. Null token means ETH (WETH in V3).",
    inputSchema: toolSchema({ chainId: { enum: ["1", "42161"] }, accountId: { const: "main" }, protocol: { enum: ["v3", "v4"] }, tokenA: { oneOf: [toolAddress, { type: "null" }] }, tokenB: { oneOf: [toolAddress, { type: "null" }] }, fee: { type: "integer", minimum: 0 }, tickSpacing: { type: "integer", minimum: 1 }, hooks: toolAddress }, ["chainId", "protocol", "tokenA", "tokenB", "fee"]),
    outputSchema: toolSchema({ pool: poolOutputSchema }), annotations: { "neutron:effects": ["read", "network"], "neutron:longRunning": true },
  }, async (args, context) => {
    const { read } = await toolAccount(context, args.accountId ?? "main");
    return toolJson({ pool: compactPool(await readPool(read, args as unknown as PoolInput)) });
  });
}
