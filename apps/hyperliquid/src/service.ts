import { exposeTool, onAppStateChange, publishAppStateChange, type JsonObject, type JsonValue, type MsgBusToolContext } from "neutron-tools/app";
import { createEvmWalletClient, requireEvmWalletCaller, serializeEvmTypedData, type EvmAccount } from "neutron-tools/evm_wallet";
import { HyperliquidData, CANDLE_INTERVALS, type Environment, type CandleInterval } from "./market.ts";
import { analyzeCandles, analyzeBook } from "./analysis.ts";
import { authorizeTrade } from "./provider.ts";
import { createStore } from "./store.ts";
import { createTradingEngine, type TradeIntent } from "./trading.ts";
import { quoteFunding, runFunding, fundingResult, fundingIntent } from "./funding.ts";
import type { FundingInput } from "./funding_protocol.ts";
import { approveTradingSession, revokeTradingSession, getTradingSession, DefinitiveMasterSigningError, type MasterTypedDataSigner } from "./trading_key.ts";
import { nextTradingMasterNonce } from "./trading_store.ts";

const text = { type: "string" }, bool = { type: "boolean" };
const integer = { type: "integer", minimum: 0 }, positiveInteger = { type: "integer", minimum: 1 };
const environmentSchema = { enum: ["mainnet", "testnet"] };
const coin = { type: "string", pattern: "^[^\\s@:/#]+$" };
// The transport's safe-regex subset excludes capture groups. The protocol
// parsers perform canonical decimal and precision validation after transport.
const decimal = { type: "string", pattern: "^[0-9]+\\.?[0-9]*$" };
const operationId = { type: "string", pattern: "^[0-9a-f]{32}$" };
const side = { enum: ["buy", "sell"] }, slippageBps = { type: "number", minimum: 0 };
const schema = (properties: JsonObject, required = Object.keys(properties)): JsonObject => ({ type: "object", properties, required, additionalProperties: false });
const input = (properties: JsonObject = {}, required: string[] = []) => schema({ environment: environmentSchema, ...properties }, required);
const dataOutput = schema({ dataJson: text }), resultOutput = schema({ resultJson: text });
const reads: JsonObject = { "neutron:effects": ["read", "network"], "neutron:longRunning": true };
const effects: JsonObject = { "neutron:effects": ["read", "write", "network", "user_visible_ui"], "neutron:longRunning": true, "neutron:audit": "metadata_only" };
const tradeEffects: JsonObject = { ...effects, "neutron:consent": "provider_once" };
const data = (value: unknown) => ({ dataJson: JSON.stringify(value) });
const result = (value: unknown) => ({ resultJson: JSON.stringify(value) });
function environment(args: JsonObject): Environment { return args.environment === "testnet" ? "testnet" : "mainnet"; }
const sources = new Map<Environment, HyperliquidData>();
function source(env: Environment) { let value = sources.get(env); if (!value) { value = new HyperliquidData(env); sources.set(env, value); } return value; }

let walletIdentity: Promise<EvmAccount> | null = null;
let ownInstallation: Promise<string> | null = null;
if (typeof window !== "undefined") onAppStateChange("evm_wallet", () => { walletIdentity = null; });
function wallet(context: MsgBusToolContext) {
  return createEvmWalletClient(context.kernel, { callOptions: { ...(context.signal ? { signal: context.signal } : {}), onProgress: context.reportProgress } });
}
async function account(context: MsgBusToolContext, refresh = false): Promise<EvmAccount> {
  if (refresh) walletIdentity = null;
  if (!walletIdentity) {
    const pending = wallet(context).accounts().then((response) => {
      const selected = response.accounts.find((entry) => entry.accountId === "main");
      if (!selected) throw new Error("Install and open EVM Wallet to connect your Hyperliquid account.");
      return selected;
    });
    walletIdentity = pending;
    void pending.catch(() => { if (walletIdentity === pending) walletIdentity = null; });
  }
  return walletIdentity;
}

// A local bus call obtains the resident's own Kernel-authenticated installation
// identity. External caller identity is never substituted for the app's scope.
exposeTool("hl_identity_v1", {
  title: "Identify this Hyperliquid resident", description: "Private installation binding for this resident's browser journal.",
  inputSchema: schema({}), outputSchema: schema({ installationUid: text }),
  annotations: { "neutron:visibility": "same_app", "neutron:effects": ["read"] },
}, (_args, context) => {
  const caller = requireEvmWalletCaller(context);
  if (caller.appId !== "hyperliquid" || context.caller?.role !== "background" || context.caller.endpoint !== "app:hyperliquid:background") throw new Error("Hyperliquid resident identity is unavailable to this caller.");
  return { installationUid: caller.installationUid };
});
async function installation(context: MsgBusToolContext): Promise<string> {
  if (!ownInstallation) {
    const pending = context.kernel.callTool<{ installationUid: string }>({ target: "app:hyperliquid:background", name: "hl_identity_v1", arguments: {} }).then((value) => value.installationUid);
    ownInstallation = pending;
    void pending.catch(() => { if (ownInstallation === pending) ownInstallation = null; });
  }
  return ownInstallation;
}
async function connection(context: MsgBusToolContext, env: Environment) {
  const [selected, uid] = await Promise.all([account(context), installation(context)]);
  return { selected, binding: { walletAddress: selected.address, installationId: `${uid}:${selected.keyFingerprint}:${selected.namespaceVersion}`, environment: env } };
}
async function engine(context: MsgBusToolContext, env: Environment) {
  const { binding } = await connection(context, env), caller = requireEvmWalletCaller(context);
  return createTradingEngine({ binding, caller: { ...caller, role: context.caller?.role ?? "unknown" }, data: source(env), authorize: (review) => authorizeTrade(context, review as JsonObject), ...(context.signal ? { signal: context.signal } : {}) });
}
async function effect<T>(context: MsgBusToolContext, run: () => Promise<T>) {
  context.signal?.throwIfAborted();
  try { return await run(); }
  finally { void publishAppStateChange("hyperliquid", Date.now()).catch(() => undefined); }
}

function masterSigner(context: MsgBusToolContext): MasterTypedDataSigner {
  return async (request) => {
    context.signal?.throwIfAborted();
    const selected = await account(context, true);
    if (selected.address.toLowerCase() !== request.address.toLowerCase()) throw new Error("Wallet account changed. Refresh the trading session before continuing.");
    const client = wallet(context), identity = { accountId: "main" as const, chainId: String(request.chainId), requestId: request.requestId };
    let operation = await client.operationStatus(identity);
    if (operation.status === "not_found" || operation.status === "prepared") {
      operation = await client.signTypedData({ ...identity, typedDataJson: serializeEvmTypedData(request.typedData) });
    }
    // Wallet's typed-data `failed` state is a failed preparation (main.mo
    // evm_wallet_prepare_v1); signing uncertainty uses signing/unknown instead.
    if ((operation.status === "rejected" || operation.status === "failed") && operation.signature === null) {
      throw new DefinitiveMasterSigningError(operation.message ?? "EVM Wallet stopped this trading-key request without signing. A new setup request can be reviewed.");
    }
    if (operation.status !== "signed" || !operation.signature) {
      throw new Error(`Trading key Wallet request ${request.requestId} is ${operation.status}. Continue this same setup operation to recover its exact request; update EVM Wallet to 0.1.20 for Hyperliquid signing.`);
    }
    if (operation.kind !== "typed_data" || operation.address.toLowerCase() !== selected.address.toLowerCase()) throw new Error("Wallet signature does not match the connected trading account.");
    return operation.signature as `0x${string}`;
  };
}
exposeTool("hl_setup_status_v1", {
  title: "Read this browser's trading authorization", description: "Read the connected Wallet and this installation's encrypted local trading-key status, checking current Hyperliquid registration and expiry. The delegated key can trade collateral and cause losses but cannot withdraw to another address. Profile loss needs a fresh key approval; no master private key is stored in this app.",
  inputSchema: input(), outputSchema: dataOutput, annotations: { "neutron:effects": ["read", "write", "network"], "neutron:longRunning": true },
}, async (args, context) => data(await getTradingSession((await connection(context, environment(args))).binding, { refresh: true, ...(context.signal ? { signal: context.signal } : {}) })));
exposeTool("hl_setup_v1", {
  title: "Authorize or revoke browser trading", description: "Authorize a fresh local Hyperliquid API wallet, or revoke this app's named trading key, using an exact master signature in EVM Wallet. The API key stays encrypted in this browser's installation storage and is never returned. It can trade away collateral and supports Hyperliquid's same-account actions; it cannot withdraw to another address. Reuse operationId after interruption. rebroadcast=true explicitly retries only the retained signed approval envelope. Key expiry is reported from the venue. EVM Wallet0.1.20 or newer is required.",
  inputSchema: input({ operationId, action: { enum: ["approve", "revoke"] }, rebroadcast: bool }, ["operationId"]), outputSchema: resultOutput, annotations: effects,
}, (args, context) => effect(context, async () => {
  requireEvmWalletCaller(context);
  const { binding } = await connection(context, environment(args));
  const action = args.action === "revoke" ? revokeTradingSession : approveTradingSession;
  return result(await action(binding, masterSigner(context), String(args.operationId), { ...(context.signal ? { signal: context.signal } : {}), ...(args.rebroadcast === true ? { rebroadcast: true } : {}) }));
}));

exposeTool("hl_markets_v1", {
  title: "Find Hyperliquid perpetual markets",
  description: "Discover validator-operated perps by exact symbol or search, with live mark/oracle prices, funding, daily volume, open interest, size precision and leverage/margin parameters. Environment defaults to mainnet. Results retain metadata asset IDs; spot, HIP-3 and vaults are outside this app. Ordered by observed daily notional volume; this is not a recommendation. Follow nextOffset, or set pageSize explicitly. Delisted markets remain identifiable with includeDelisted=true.",
  inputSchema: input({ query: text, offset: integer, pageSize: positiveInteger, includeDelisted: bool }), outputSchema: dataOutput, annotations: reads,
}, async (args, context) => {
  const snapshot = await source(environment(args)).markets(context.signal), query = String(args.query ?? "").trim().toLowerCase();
  const markets = snapshot.markets.filter((market) => (!market.isDelisted || args.includeDelisted === true) && market.name.toLowerCase().includes(query)).sort((a, b) => Number(b.context.dayNtlVlm) - Number(a.context.dayNtlVlm));
  const offset = Number(args.offset ?? 0), count = Number(args.pageSize ?? 30), page = markets.slice(offset, offset + count);
  return data({ ...snapshot, markets: page, total: markets.length, nextOffset: offset + page.length < markets.length ? offset + page.length : null });
});

const intervalMilliseconds: Record<CandleInterval, number> = { "1m": 60e3, "3m": 180e3, "5m": 300e3, "15m": 900e3, "30m": 1800e3, "1h": 3600e3, "2h": 7200e3, "4h": 14400e3, "8h": 28800e3, "12h": 43200e3, "1d": 86400e3, "3d": 259200e3, "1w": 604800e3, "1M": 2678400e3 };
const chartProperties = { coin, interval: { enum: [...CANDLE_INTERVALS] }, startTime: integer, endTime: integer };
async function candles(args: JsonObject, context: MsgBusToolContext) {
  const interval = String(args.interval ?? "1h") as CandleInterval, endTime = Number(args.endTime ?? Date.now());
  const startTime = Number(args.startTime ?? Math.max(0, endTime - intervalMilliseconds[interval] * 250));
  return source(environment(args)).candles(String(args.coin), interval, startTime, endTime, context.signal);
}
exposeTool("hl_market_v1", {
  title: "Read a perp trading screen", description: "Get current market metadata, orderbook, candles and descriptive analysis together. Defaults to 250 hourly candles. Observations have timestamps; chart metrics are not predictions and a book snapshot does not guarantee execution.",
  inputSchema: input(chartProperties, ["coin"]), outputSchema: dataOutput, annotations: reads,
}, async (args, context) => {
  const api = source(environment(args));
  const [catalog, book, chart] = await Promise.all([api.markets(context.signal), api.book(String(args.coin), context.signal), candles(args, context)]);
  const market = catalog.markets.find((entry) => entry.name === args.coin);
  if (!market) throw new Error("This symbol is not a default Hyperliquid perpetual market.");
  return data({ environment: environment(args), observedAt: Date.now(), market, book, candles: chart.candles, chart, analysis: { chart: analyzeCandles(chart.candles, { now: Math.min(Date.now(), chart.endTime + 1) }), book: analyzeBook(book) } });
});
exposeTool("hl_chart_v1", {
  title: "Analyze perpetual price candles", description: "Read OHLCV candles and technical observations including trend, returns, RSI, volatility and volume. Specify interval and epoch millisecond range; default250 hourly candles. Reports missing/insufficient data and incomplete candles. Hyperliquid retains at most5000 recent candles per interval; narrower time ranges cannot recover older data. Metrics describe the observed sample, not future price probabilities.",
  inputSchema: input(chartProperties, ["coin"]), outputSchema: dataOutput, annotations: reads,
}, async (args, context) => { const chart = await candles(args, context); return data({ ...chart, analysis: analyzeCandles(chart.candles, { now: Math.min(Date.now(), chart.endTime + 1) }) }); });
exposeTool("hl_orderbook_v1", {
  title: "Analyze a perp orderbook", description: "Read bid/ask levels, spread, cumulative depth, imbalance and an optional walk for side and base-asset size. Supply limitPrice to evaluate only executable levels inside that bound. Reports unfilled quantity when displayed depth is insufficient. Level2 aggregation and changing liquidity limit the estimate; price impact is not a fill guarantee.",
  inputSchema: input({ coin, side, size: decimal, limitPrice: decimal }, ["coin"]), outputSchema: dataOutput, annotations: reads,
}, async (args, context) => {
  const book = await source(environment(args)).book(String(args.coin), context.signal);
  return data({ ...book, analysis: analyzeBook(book, { ...(args.side ? { side: args.side as "buy" | "sell" } : {}), ...(args.size ? { size: String(args.size) } : {}), ...(args.limitPrice ? { limitPrice: String(args.limitPrice) } : {}) }) });
});
exposeTool("hl_account_v1", {
  title: "Read perp balances, positions, orders and fees", description: "Read the connected Wallet's Hyperliquid account, current positions, liquidation/margin/funding observations, open orders and actual fee tier. Preserves detected account mode; unified collateral reads may include spot balances even though this app trades perps only. Unknown mode, failed reads and unavailable balances remain explicit. No signing or account-mode changes.",
  inputSchema: input(), outputSchema: dataOutput, annotations: reads,
}, async (args, context) => { const selected = await account(context); return data({ ...await source(environment(args)).account(selected.address, context.signal), wallet: selected }); });
exposeTool("hl_fills_v1", {
  title: "Read perpetual fills", description: "Read actual fills, closed PnL, fees and order IDs for the connected Wallet. Optional startTime is epoch milliseconds. Follow returned history/truncation indicators; an empty result is not proof an uncertain order was never accepted.",
  inputSchema: input({ startTime: integer }), outputSchema: dataOutput, annotations: reads,
}, async (args, context) => data(await source(environment(args)).fills((await account(context)).address, args.startTime === undefined ? undefined : Number(args.startTime), context.signal)));
exposeTool("hl_funding_rates_v1", {
  title: "Read perpetual funding history", description: "Read a default perp's historical funding rate observations for an explicit time range in epoch milliseconds. This is position funding, distinct from USDC deposits. Rates vary and past funding is not a promised yield.",
  inputSchema: input({ coin, startTime: integer, endTime: integer }, ["coin", "startTime"]), outputSchema: dataOutput, annotations: reads,
}, async (args, context) => data(await source(environment(args)).funding(String(args.coin), Number(args.startTime), args.endTime === undefined ? undefined : Number(args.endTime), context.signal)));

const orderProperties: JsonObject = { coin, side, orderType: { enum: ["market", "limit"] }, size: decimal, price: decimal, slippageBps, reduceOnly: bool, postOnly: bool };
function orderIntent(args: JsonObject): TradeIntent {
  return { kind: "order", coin: String(args.coin), side: args.side as "buy" | "sell", orderType: args.orderType as "market" | "limit", size: String(args.size), ...(args.price !== undefined ? { price: String(args.price) } : {}), ...(args.slippageBps !== undefined ? { slippageBps: Number(args.slippageBps) } : {}), ...(args.reduceOnly !== undefined ? { reduceOnly: args.reduceOnly === true } : {}), ...(args.postOnly !== undefined ? { postOnly: args.postOnly === true } : {}) };
}
exposeTool("hl_preview_order_v1", {
  title: "Preview a perpetual order", description: "Prepare an exact perps order with current metadata, book and account context without signing. Size is a decimal base-asset quantity. Market orders are IOC limits with explicit slippage bounds and can partially fill. Limit orders use GTC or post-only. Execution obtains a fresh exact review; a preview grants no trading authority.",
  inputSchema: input(orderProperties, ["coin", "side", "orderType", "size"]), outputSchema: dataOutput, annotations: reads,
}, async (args, context) => data(await (await engine(context, environment(args))).preview(orderIntent(args))));

function tradeTool(name: string, title: string, description: string, properties: JsonObject, required: string[], intent: (args: JsonObject) => TradeIntent) {
  exposeTool(name, { title, description: `${description} Environment defaults to mainnet. Reuse the same 32-hex operationId and identical inputs after interruption. Every new action receives exact owner or Agent review. Signed envelopes are retained before direct browser dispatch; uncertain outcomes require reconciliation, not a fresh operation ID.`, inputSchema: input({ operationId, ...properties }, ["operationId", ...required]), outputSchema: resultOutput, annotations: tradeEffects },
    (args, context) => effect(context, async () => result(await (await engine(context, environment(args))).execute({ operationId: String(args.operationId), intent: intent(args) }))));
}
tradeTool("hl_place_order_v1", "Place a perpetual market or limit order", "Trade a default perp using a decimal base-asset size. Market orders use bounded IOC execution and can partially fill. Limit orders use GTC; postOnly selects ALO. Set reduceOnly to prevent increasing exposure. The exact price bound, quantity, fees and account observations are part of review.", orderProperties, ["coin", "side", "orderType", "size"], orderIntent);
tradeTool("hl_close_position_v1", "Close all or part of a perp position", "Read the actual position and submit a reduce-only bounded IOC order in the opposite direction. Omit size to close the currently observed position, or supply a decimal base-asset quantity for a partial close. Fills can be partial; inspect the resulting position before claiming it is closed.", { coin, size: decimal, slippageBps }, ["coin"], (args) => ({ kind: "close", coin: String(args.coin), ...(args.size !== undefined ? { size: String(args.size) } : {}), ...(args.slippageBps !== undefined ? { slippageBps: Number(args.slippageBps) } : {}) }));
tradeTool("hl_cancel_order_v1", "Cancel a perpetual order", "Cancel one exchange order ID on the specified default perp. A concurrent fill can precede cancellation; inspect returned status and fills.", { coin, oid: integer }, ["coin", "oid"], (args) => ({ kind: "cancel", coin: String(args.coin), oid: Number(args.oid) }));
tradeTool("hl_cancel_orders_v1", "Cancel open perpetual orders", "Cancel the observed default-perps orders, optionally restricted to one symbol. Review contains the exact order list. Orders created after the snapshot are outside this request.", { coin }, [], (args) => ({ kind: "cancelAll", ...(args.coin ? { coin: String(args.coin) } : {}) }));
tradeTool("hl_modify_order_v1", "Edit a perpetual limit order", "Replace the specified open default-perps order with an exact side, size and limit price. Post-only and reduce-only are explicit. Reconciliation retains the original ID and replacement client ID.", { coin, oid: integer, side, size: decimal, price: decimal, postOnly: bool, reduceOnly: bool }, ["coin", "oid", "side", "size", "price"], (args) => ({ kind: "modify", coin: String(args.coin), oid: Number(args.oid), side: args.side as "buy" | "sell", size: String(args.size), price: String(args.price), postOnly: args.postOnly === true, reduceOnly: args.reduceOnly === true }));
tradeTool("hl_protect_position_v1", "Place a reduce-only stop loss or take profit", "Place a reduce-only trigger order for an existing default-perps position. Specify the closing side and base-asset quantity, trigger price and tp/sl condition. Execution can be market or limit. This is one independent protection order; it is not an OCO pair, and the sibling is not automatically canceled.", { coin, side, size: decimal, triggerPrice: decimal, triggerKind: { enum: ["tp", "sl"] }, execution: { enum: ["market", "limit"] }, price: decimal, slippageBps }, ["coin", "side", "size", "triggerPrice", "triggerKind", "execution"], (args) => ({ kind: "trigger", coin: String(args.coin), side: args.side as "buy" | "sell", size: String(args.size), triggerPrice: String(args.triggerPrice), triggerKind: args.triggerKind as "tp" | "sl", execution: args.execution as "market" | "limit", ...(args.price ? { price: String(args.price) } : {}), ...(args.slippageBps !== undefined ? { slippageBps: Number(args.slippageBps) } : {}) }));
tradeTool("hl_leverage_v1", "Set perpetual leverage and margin mode", "Set the selected default-perp's leverage and cross/isolated setting within its current protocol metadata. This changes margin and liquidation exposure; it does not place an order or enable portfolio account abstraction.", { coin, leverage: positiveInteger, isCross: bool }, ["coin", "leverage", "isCross"], (args) => ({ kind: "leverage", coin: String(args.coin), leverage: Number(args.leverage), isCross: args.isCross === true }));
tradeTool("hl_isolated_margin_v1", "Adjust an isolated perp's margin", "Add or remove USDC margin from an isolated default-perps position. amountUsdc is a signed decimal USDC amount: positive adds margin, negative removes it. Protocol checks determine what is available; removal changes liquidation exposure.", { coin, amountUsdc: { type: "string", pattern: "^-?[0-9]+\\.?[0-9]*$" } }, ["coin", "amountUsdc"], (args) => ({ kind: "margin", coin: String(args.coin), amountUsdc: String(args.amountUsdc) }));

exposeTool("hl_retry_trade_v1", {
  title: "Retry an unresolved trade's exact signed request", description: "Reconcile an unresolved browser-local operation, then obtain exact review before resending its retained signed envelope if it remains unresolved. Uses the original signature, action, nonce and client order IDs; never creates a fresh order identity. A duplicate nonce reply alone does not reveal the original outcome. Use this only for the same operationId, wallet, environment and authenticated caller.",
  inputSchema: input({ operationId }, ["operationId"]), outputSchema: resultOutput, annotations: tradeEffects,
}, (args, context) => effect(context, async () => result(await (await engine(context, environment(args))).retryExact(String(args.operationId)))));

const fundingProperties: JsonObject = { direction: { enum: ["deposit", "withdraw"] }, chainId: { enum: ["1", "42161"] }, amount: decimal, speed: { enum: ["fast", "standard"] }, sourceBalance: { enum: ["perps", "unified"] } };
function fundingInput(args: JsonObject): FundingInput {
  if (environment(args) !== "mainnet") throw new Error("USDC transfers are available on mainnet Ethereum and Arbitrum. Testnet trading uses separate test funds.");
  return { environment: "mainnet", direction: args.direction as "deposit" | "withdraw", chainId: args.chainId as "1" | "42161", amount: String(args.amount), ...(args.speed ? { speed: args.speed as "fast" | "standard" } : {}), ...(args.sourceBalance ? { sourceBalance: args.sourceBalance as "perps" | "unified" } : {}) };
}
function fundingCaller(context: MsgBusToolContext) {
  const caller = requireEvmWalletCaller(context);
  return !context.agentMode && caller.appId === "hyperliquid" && context.caller?.role === "tile" ? null : caller;
}
exposeTool("hl_funding_quote_v1", {
  title: "Quote a USDC transfer to or from Hyperliquid", description: "Quote native USDC between the same EVM Wallet and HyperCore default perps using current Circle CCTP fees. Mainnet Ethereum chain1 or Arbitrum42161. amount is decimal USDC, not atomic units. Deposits can need USDC allowance and source ETH gas; withdrawals use a master-wallet signature. Quotes do not transfer funds. Circle domain IDs and EVM chain IDs are distinct.",
  inputSchema: input(fundingProperties, ["direction", "chainId", "amount"]), outputSchema: dataOutput, annotations: reads,
}, async (args, context) => data(await quoteFunding(wallet(context), fundingInput(args), { ...(context.signal ? { signal: context.signal } : {}) })));
exposeTool("hl_funding_execute_v1", {
  title: "Transfer USDC between Wallet and Hyperliquid", description: "Persist and execute a native-USDC CCTP deposit or withdrawal to the same Wallet account through exact EVM Wallet reviews. Reuse operationId and identical inputs to continue pending operations. No burn is repeated after an uncertain reply. Completion requires destination evidence, not only source burn or API acknowledgement. Mainnet Ethereum/Arbitrum only; size is decimal USDC.",
  inputSchema: input({ operationId, ...fundingProperties }, ["operationId", "direction", "chainId", "amount"]), outputSchema: resultOutput, annotations: effects,
}, (args, context) => effect(context, async () => {
  const selected = await account(context, true);
  return result(await runFunding(wallet(context), createStore(context.kernel), String(args.operationId), fundingInput(args), fundingCaller(context), !!context.agentMode, { execute: true, nextNonce: () => nextTradingMasterNonce({ walletAddress: selected.address, environment: "mainnet" }), ...(context.signal ? { signal: context.signal } : {}), onProgress: (phase: string) => context.reportProgress({ phase }) }));
}));

exposeTool("hl_reconcile_v1", {
  title: "Reconcile a saved trade or USDC transfer", description: "Check the original operation's retained envelope, Wallet request IDs and venue/chain evidence. Does not create a fresh order, signature or burn. Trade records are browser-local; funding records are durable in this Neutron. The authenticated caller retains its operation ownership.",
  inputSchema: input({ operationId, kind: { enum: ["trade", "funding"] } }, ["operationId", "kind"]), outputSchema: resultOutput, annotations: { "neutron:effects": ["read", "write", "network"], "neutron:longRunning": true },
}, (args, context) => effect(context, async () => {
  if (args.kind === "trade") return result(await (await engine(context, environment(args))).reconcile(String(args.operationId)));
  const store = createStore(context.kernel), row = await store.get(String(args.operationId));
  if (!row) throw new Error("Saved USDC transfer not found.");
  const saved = fundingIntent(row);
  if (environment(args) !== saved.input.environment) throw new Error("This transfer belongs to a different environment.");
  return result(await runFunding(wallet(context), store, row.id, saved.input, fundingCaller(context), !!context.agentMode, { execute: false, ...(context.signal ? { signal: context.signal } : {}) }));
}));
exposeTool("hl_activity_v1", {
  title: "Read retained Hyperliquid activity", description: "Read browser-local trading activity for this caller and durable funding activity. The authenticated human Hyperliquid tile also sees Agent-owned trades with explicit ownership labels; it cannot continue them as the Agent. Follow nextCursor for older funding entries. A pending state is not a failed transaction; use reconcile with the same operationId. Browser-profile loss can lose local order intent; current venue positions/orders remain queryable.",
  inputSchema: input({ cursor: text, pageSize: positiveInteger }), outputSchema: dataOutput, annotations: { "neutron:effects": ["read", "network"], "neutron:longRunning": true },
}, async (args, context) => {
  const store = createStore(context.kernel);
  const caller = requireEvmWalletCaller(context);
  const ownerTile = !context.agentMode && caller.appId === "hyperliquid" && context.caller?.role === "tile";
  const [trades, page] = await Promise.all([(await engine(context, environment(args))).history({ allCallers: ownerTile }), store.page(args.cursor ? String(args.cursor) : null, Number(args.pageSize ?? 20))]);
  const funding = await Promise.all(page.rows.map(async (summary) => {
    const row = await store.get(summary.id);
    if (!row) return { ...summary, result: null, humanOwned: false, ownedByCaller: false };
    const intent = fundingIntent(row), humanOwned = intent.caller === null && !intent.agentMode;
    const ownedByCaller = humanOwned ? ownerTile : intent.caller?.appId === caller.appId && intent.caller.installationUid === caller.installationUid && intent.agentMode === !!context.agentMode;
    return { ...summary, result: fundingResult(row), humanOwned, ownedByCaller, caller: intent.caller };
  }));
  return data({ trades, funding, nextCursor: page.nextCursor, environment: environment(args) });
});
