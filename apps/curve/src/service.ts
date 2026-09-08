import { exposeTool, type JsonObject, type JsonValue, type MsgBusToolContext } from "neutron-tools/app";
import { createEvmWalletClient, requireEvmWalletCaller } from "neutron-tools/evm_wallet";
import { getAddress } from "viem";
import { chain, FAMILIES, poolKey, poolRef, walletReader, type PoolRef } from "./contracts.ts";
import { catalogTokens, fetchPools, findPool, readToken } from "./pools.ts";
import { describeToken, searchTokens } from "./tokens.ts";
import { estimateFees, parseInput, poolPosition, preparePlan, type Input, type Plan } from "./plans.ts";
import { createStore, type RecordRow } from "./store.ts";
import { intentOf, latestRecord, operationId, resultOf, runOperation, type Result } from "./workflow.ts";

const text = { type: "string" }, nullableText = { oneOf: [text, { type: "null" }] };
const address = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }, nullableAddress = { oneOf: [address, { type: "null" }] };
const uint = { type: "string", pattern: "^0$|^[1-9][0-9]*$" }, chainSchema = { enum: ["1", "42161"] };
const idSchema = { type: "string", pattern: "^[0-9a-f]{32}$" };
const schema = (properties: JsonObject, required = Object.keys(properties)): JsonObject => ({ type: "object", properties, required, additionalProperties: false });
const json = (value: unknown) => value as JsonValue;
const poolSchema = schema({ chainId: chainSchema, address, family: { enum: FAMILIES } });
const inputProperties: JsonObject = {
  kind: { enum: ["swap", "deposit", "withdraw", "withdraw_one"] }, chainId: chainSchema,
  tokenIn: nullableAddress, tokenOut: nullableAddress, amountIn: uint, pool: { oneOf: [poolSchema, { type: "null" }] },
  amounts: { type: "array", items: uint }, lpAmount: uint, coinIndex: { type: "integer", minimum: 0 }, useNative: { type: "boolean" },
  recipient: nullableAddress, slippageBps: { type: "integer", minimum: 0, maximum: 10000 }, quoteValiditySeconds: uint,
};
const resultSchema = schema({ operationId: text, recordId: nullableText, summary: text, state: { enum: ["complete", "pending", "review", "stopped"] }, phase: text, transactionHash: nullableText, message: text,
  steps: { type: "array", items: schema({ label: text, status: text, transactionHash: nullableText }) } });
const readAnnotations: JsonObject = { "neutron:effects": ["read", "network"], "neutron:longRunning": true };
const effectAnnotations: JsonObject = { "neutron:effects": ["read", "write", "network", "user_visible_ui"], "neutron:longRunning": true };
const calls = new Map<string, Promise<Result>>();

function caller(context: MsgBusToolContext) {
  const authenticated = requireEvmWalletCaller(context);
  // Only the app's own authenticated human tile owns UI continuations. An
  // external app or Agent cannot turn a saved invocation into a tile request.
  return !context.agentMode && authenticated.appId === "curve" && context.caller?.role === "tile" ? null : authenticated;
}
async function account(context: MsgBusToolContext) {
  const wallet = createEvmWalletClient(context.kernel, context.signal ? { callOptions: { signal: context.signal } } : {});
  const selected = (await wallet.accounts()).accounts.find((account) => account.accountId === "main");
  if (!selected) throw new Error("Install EVM Wallet to use your Ethereum account in Curve.");
  return { wallet, account: selected, read: walletReader(wallet, context.signal) };
}

async function execute(context: MsgBusToolContext, id: string, input: Input, effects: boolean): Promise<JsonValue> {
  operationId(id);
  const owner = caller(context), store = createStore(context.kernel), controller = new AbortController();
  const cancel = () => controller.abort(context.signal?.reason ?? new Error("Curve tracking paused"));
  context.signal?.addEventListener("abort", cancel, { once: true });
  if (context.signal?.aborted) cancel();
  // Match the existing long-tool transport window; no operation or attempt
  // expires when tracking yields. Every retry retains its original identity.
  const timer = setTimeout(() => controller.abort(new Error("Continue this saved operation to keep tracking")), 240000);
  const key = `${owner?.appId ?? "human"}:${owner?.installationUid ?? "tile"}:${id}`;
  let latest: RecordRow | null = null;
  const task = Promise.resolve(calls.get(key)).catch(() => undefined).then(() => runOperation(
    createEvmWalletClient(context.kernel, { callOptions: { signal: controller.signal } }), store, id, input, owner, !!context.agentMode,
    { execute: effects, signal: controller.signal, onRecord: (record) => { latest = record; }, onProgress: (message) => context.reportProgress({ phase: message, operationId: id }) },
  ));
  calls.set(key, task);
  const release = () => { if (calls.get(key) === task) calls.delete(key); };
  void task.then(release, release);
  let listener!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    listener = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", listener, { once: true });
    if (controller.signal.aborted) listener();
  });
  try { return json(await Promise.race([task, interrupted])); }
  catch (error) {
    if (!controller.signal.aborted) throw error;
    return json(latest ? resultOf(latest, "pending", "Tracking paused. Continue this same operation ID; an interrupted reply does not mean the transaction failed.") : {
      operationId: id, recordId: null, state: "pending", phase: "preparing", summary: "Preparing Curve operation", transactionHash: null, steps: [], message: "Preparation paused. Retry the same operation ID and original inputs to recover any saved intent.",
    });
  } finally { clearTimeout(timer); context.signal?.removeEventListener("abort", cancel); controller.signal.removeEventListener("abort", listener); }
}

exposeTool("curve_pools_v1", {
  title: "Browse Curve pools", description: "Browse Curve StableSwap NG, Twocrypto NG, Tricrypto NG and the implemented legacy pools on Ethereum or Arbitrum. Search by asset, pool name or full address. API liquidity values are discovery observations; execution independently verifies factory registration and pool coins. Follow nextOffset for more results; complete false means discovery failed or is partial, not an empty wallet.",
  inputSchema: schema({ chainId: chainSchema, query: text, offset: { type: "integer", minimum: 0 }, pageSize: { type: "integer", minimum: 1 }, refresh: { type: "boolean" } }, ["chainId"]),
  outputSchema: schema({ poolsJson: text, nextOffset: { oneOf: [{ type: "integer" }, { type: "null" }] }, total: { type: "integer" }, complete: { type: "boolean" }, errors: { type: "array", items: text }, fetchedAtMs: { type: "number" } }), annotations: readAnnotations,
}, async (args, context) => {
  const catalog = await fetchPools(chain(args.chainId), { ...(context.signal ? { signal: context.signal } : {}), refresh: args.refresh === true });
  const query = String(args.query ?? "").trim().toLowerCase();
  const pools = catalog.pools.filter((pool) => `${pool.name} ${pool.address} ${pool.coins.map((token) => `${token.symbol} ${token.address ?? "ETH"}`).join(" ")}`.toLowerCase().includes(query));
  const offset = Number(args.offset ?? 0), count = Number(args.pageSize ?? 20), rows = pools.slice(offset, offset + count);
  return { poolsJson: JSON.stringify(rows), nextOffset: offset + rows.length < pools.length ? offset + rows.length : null, total: pools.length, complete: catalog.complete, errors: catalog.errors, fetchedAtMs: catalog.fetchedAtMs };
});

exposeTool("curve_tokens_v1", {
  title: "Find Curve assets", description: "Search available Curve pool assets and Neutron's curated token list by symbol, listed name or address. tokensJson entries include name, listed and sourceUrl: listed means an exact chain and contract match to the bundled list, not a safety rating. Listed addresses come first, then unlisted symbols alphabetically; this is not a liquidity ranking. A full address matches only that contract, with custom contracts read onchain. Null address is ETH; amounts use token decimals. Symbols and pool registration do not prove issuer identity or pool availability.",
  inputSchema: schema({ chainId: chainSchema, query: text, offset: { type: "integer", minimum: 0 }, pageSize: { type: "integer", minimum: 1 } }, ["chainId"]),
  outputSchema: schema({ tokensJson: text, nextOffset: { oneOf: [{ type: "integer" }, { type: "null" }] }, errors: { type: "array", items: text } }), annotations: readAnnotations,
}, async (args, context) => {
  const chainId = chain(args.chainId), query = String(args.query ?? "").trim().toLowerCase();
  const catalog = await fetchPools(chainId, context.signal ? { signal: context.signal } : {});
  let tokens = searchTokens(catalogTokens(chainId, catalog.pools), query);
  if (!tokens.length && /^0x[0-9a-f]{40}$/.test(query)) tokens = [describeToken(await readToken((await account(context)).read, chainId, getAddress(query)))];
  const offset = Number(args.offset ?? 0), count = Number(args.pageSize ?? 30), rows = tokens.slice(offset, offset + count);
  return { tokensJson: JSON.stringify(rows), nextOffset: offset + rows.length < tokens.length ? offset + rows.length : null, errors: catalog.errors };
});

exposeTool("curve_pool_v1", {
  title: "Read a verified Curve pool", description: "Verify the selected pool's factory registration, pool coins and token decimals; read its current balances and LP supply at one block. The family identifies the exact contract interface, including NG metapools versus plain pools.",
  inputSchema: schema({ pool: poolSchema }), outputSchema: schema({ poolJson: text }), annotations: readAnnotations,
}, async (args, context) => ({ poolJson: JSON.stringify(await findPool((await account(context)).read, poolRef(args.pool), context.signal ? { signal: context.signal } : {})) }));

exposeTool("curve_position_v1", {
  title: "Read a Curve liquidity balance", description: "Read the signing wallet's LP token balance and proportional pool assets at the verified block. Curve trading fees accrue within LP value; these are not separate claimable Uniswap fees. Staked LP tokens are separate from this wallet balance.",
  inputSchema: schema({ pool: poolSchema }), outputSchema: schema({ positionJson: text }), annotations: readAnnotations,
}, async (args, context) => {
  const connection = await account(context), pool = await findPool(connection.read, poolRef(args.pool), context.signal ? { signal: context.signal } : {});
  return { positionJson: JSON.stringify({ ...await poolPosition(connection.read, connection.account, pool), accountAddress: connection.account.address }) };
});

exposeTool("curve_tracked_pools_v1", {
  title: "Read saved Curve pool references", description: "List pools saved by this Curve installation. These references preserve discovery after API failures; use position_v1 to verify current ownership and balances. This is not exhaustive portfolio indexing.",
  inputSchema: schema({ chainId: chainSchema }), outputSchema: schema({ poolsJson: text }), annotations: { "neutron:effects": ["read"] },
}, async (args, context) => ({ poolsJson: JSON.stringify(await createStore(context.kernel).tracked(String(args.chainId))) }));

exposeTool("curve_track_pool_v1", {
  title: "Save a Curve pool", description: "Verify and save a pool reference for liquidity management independently of discovery delays. This does not move funds.",
  inputSchema: schema({ pool: poolSchema }), outputSchema: schema({ poolJson: text }), annotations: { "neutron:effects": ["read", "write", "network"], "neutron:longRunning": true },
}, async (args, context) => {
  const pool = await findPool((await account(context)).read, poolRef(args.pool), context.signal ? { signal: context.signal } : {});
  await createStore(context.kernel).track(pool);
  return { poolJson: JSON.stringify(pool) };
});

exposeTool("curve_quote_v1", {
  title: "Preview a Curve swap or liquidity operation", description: "Read an exact-input swap or liquidity preview using EVM Wallet. Swaps compare supported direct pools through Curve Router, including native ETH/WETH conversion; no global or multihop-best-route claim. Deposits use exact token budgets; withdrawals use LP atomic units and either proportional assets or coinIndex. NG metapools use their pool coins, including a base LP token, rather than silently redeeming underlying coins. Default slippage is 50 bps and quote freshness is 1200 seconds. Curve calldata enforces minimum output but contains no onchain deadline. Preview performs no signing. Use curve_execute_v1 to complete the operation.",
  inputSchema: schema(inputProperties, ["kind", "chainId"]), outputSchema: schema({ planJson: text }), annotations: readAnnotations,
}, async (args, context) => {
  const connection = await account(context);
  return { planJson: JSON.stringify(await preparePlan(connection.wallet, connection.account, parseInput(args), { ...(context.signal ? { signal: context.signal } : {}), onProgress: (phase) => context.reportProgress({ phase }) })) };
});

exposeTool("curve_fees_v1", {
  title: "Estimate Curve network fees", description: "Read EVM Wallet fee estimates for a preview's exact transactions. Estimates do not create Wallet commands or reserve nonces. A final call may not simulate until approval is mined; missing estimates remain unavailable. Arbitrum gas includes posting once. Wallet reviews current fees separately before signing.",
  inputSchema: schema({ planJson: text }), outputSchema: schema({ feesJson: text }), annotations: readAnnotations,
}, async (args, context) => ({ feesJson: JSON.stringify(await estimateFees(createEvmWalletClient(context.kernel), JSON.parse(String(args.planJson)) as Plan, context.signal)) }));

exposeTool("curve_execute_v1", {
  title: "Complete a Curve swap or liquidity operation", description: "Persist original inputs and exact Wallet request IDs, obtain each exact human or Agent Wallet review, wait for necessary approvals, send the final transaction and verify its successful receipt. Never stop at approval. Reuse one 32-hex operationId and identical original inputs after pending/review or a lost reply. Quote renewal only replaces known-unsigned plans and reuses sufficient allowances; ambiguous requests retain their IDs. Every effect uses EVM Wallet's public provider tool under the owner's current instructions. Serialize effectful flows within one Agent run. Defaults and contract semantics match curve_quote_v1.",
  inputSchema: schema({ operationId: idSchema, ...inputProperties }, ["operationId", "kind", "chainId"]), outputSchema: resultSchema, annotations: effectAnnotations,
}, (args, context) => execute(context, String(args.operationId), parseInput(args), true));

for (const [name, effects] of [["curve_continue_v1", true], ["curve_reconcile_v1", false]] as const) exposeTool(name, {
  title: effects ? "Continue a saved Curve operation" : "Check saved Curve transaction status",
  description: effects ? "Resume the original saved inputs and request IDs for this authenticated caller. Continue approvals through the final transaction with fresh Wallet review for every new effect. Human UI cannot take over an Agent-owned operation." : "Reconcile the saved operation's existing Wallet requests and actual chain receipts. May resend already approved signed bytes through Wallet recovery; never requests a fresh approval, signature or transaction. Use continue_v1 for an explicit continuation.",
  inputSchema: schema({ operationId: idSchema }), outputSchema: resultSchema, annotations: effects ? effectAnnotations : { "neutron:effects": ["read", "write", "network"], "neutron:longRunning": true },
}, async (args, context) => {
  const record = await createStore(context.kernel).get(String(args.operationId));
  if (!record) throw new Error("Saved Curve operation not found.");
  return execute(context, record.root_id, intentOf(record).input, effects);
});

exposeTool("curve_status_v1", {
  title: "Read saved Curve progress", description: "Read retained progress and original input without contacting the EVM network or sending transactions. Reconcile_v1 checks live receipts; continue_v1 resumes the same caller's flow.",
  inputSchema: schema({ operationId: idSchema }), outputSchema: schema({ result: { oneOf: [resultSchema, { type: "null" }] }, inputJson: nullableText, humanOwned: { type: "boolean" } }), annotations: { "neutron:effects": ["read"] },
}, async (args, context) => {
  const record = await latestRecord(createStore(context.kernel), String(args.operationId)), intent = record ? intentOf(record) : null;
  return json({ result: record ? resultOf(record) : null, inputJson: intent ? JSON.stringify(intent.input) : null, humanOwned: !!intent && intent.caller === null && !intent.agentMode });
});

exposeTool("curve_history_v1", {
  title: "Read Curve activity", description: "Read paginated saved operations with current retained progress. Follow nextCursor for older records. Every renewed quote remains attached to its original operation; history never prunes pending requests. This reads the journal, not live chain finality.",
  inputSchema: schema({ cursor: nullableText, limit: { type: "integer", minimum: 1 } }, []), outputSchema: schema({ rowsJson: text, nextCursor: nullableText }), annotations: { "neutron:effects": ["read"] },
}, async (args, context) => {
  const store = createStore(context.kernel), page = await store.page(args.cursor as string | null | undefined, args.limit as number | undefined);
  const rows = await Promise.all(page.rows.map(async (summary) => {
    const record = await latestRecord(store, summary.id);
    if (!record) throw new Error("A saved operation disappeared.");
    const intent = intentOf(record);
    return { ...summary, result: resultOf(record), input: intent.input, humanOwned: intent.caller === null && !intent.agentMode };
  }));
  return { rowsJson: JSON.stringify(rows), nextCursor: page.nextCursor };
});
