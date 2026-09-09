/** Actual Hyperliquid React bundle with fixture resident-tool responses.
 * This qualifies UI behavior and tile layouts. Service, signing, persistence,
 * and contract execution are qualified separately; no live effects are sent. */
import { build } from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const app = fileURLToPath(new URL("../../", import.meta.url));
const artifacts = process.env.HL_BROWSER_ARTIFACTS || "/tmp/neutron-hyperliquid-browser";
await mkdir(artifacts, { recursive: true });
const mockTransport = `
const registered = new Map();
export function exposeTool(name,spec,handler) { registered.set(name,{spec,handler}); }
const context=()=>({caller:{appId:"hyperliquid",installationUid:"1",role:"background",endpoint:"app:hyperliquid:background"},agentMode:false,kernel:{callTool,querySelf,updateSelf},reportProgress:()=>{}});
export const querySelf = (name,args) => window.fixture("querySelf",[name,args]);
export const updateSelf = (name,args) => window.fixture("updateSelf",[name,args]);
export async function callTool(call,options) {
  if (options?.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
  let result=await window.fixture("callTool",[call]);
  if(result.__review){
    const tool=registered.get("hl_owner_review_v1"); if(!tool)throw Error("Owner review tool is missing");
    const outcome=await tool.handler({reviewJson:JSON.stringify(result.__review)},{...context(),signal:options?.signal});
    result=await window.fixture("reviewOutcome",[call,outcome]);
  }
  if (options?.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
  window.fixtureToolResults??={}; window.fixtureToolResults[call.name]=(window.fixtureToolResults[call.name]??0)+1;
  if(call.name==="hl_reconcile_v1"){window.fixtureReconcileResults??={};const id=call.arguments.operationId;window.fixtureReconcileResults[id]=(window.fixtureReconcileResults[id]??0)+1;}
  return result;
}
window.fixtureRequestReview=async(review,overrides={})=>{
  const tool=registered.get("hl_owner_review_v1"); if(!tool)throw Error("Owner review tool is missing");
  return tool.handler({reviewJson:JSON.stringify(review)},{...context(),...overrides});
};
`;

async function start() {
  const bundle = await build({
    absWorkingDir: app,
    entryPoints: [resolve(app, "src/main.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    outdir: resolve(artifacts, "build"),
    plugins: [{
      name: "fixture-transport",
      setup(builder) {
        builder.onResolve({ filter: /^(?:neutron-tools\/app|\.{1,2}\/app_entry\.ts)$/ }, () => ({ path: "transport", namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: mockTransport, loader: "js", resolveDir: app }));
      },
    }, sassPlugin()],
  });
  const scripts = {
    "/main.js": bundle.outputFiles.find(file => file.path.endsWith(".js")).text,
    "/main.css": bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text ?? "",
    "/static/icon.svg": await readFile(resolve(app, "public/static/icon.svg"), "utf8"),
  };
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    response.setHeader("Content-Type", path.endsWith(".css") ? "text/css" : path.endsWith(".svg") ? "image/svg+xml" : path.endsWith(".js") ? "text/javascript" : "text/html");
    response.end(scripts[path] ?? '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/main.css"></head><body><div id="root"></div><script src="/main.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try { browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || "/run/current-system/sw/bin/google-chrome-stable" }); }
  catch (error) { await new Promise(resolve => server.close(resolve)); throw error; }
  return { server, browser, url: "http://127.0.0.1:" + server.address().port };
}

async function assertNoOverflow(page, label) {
  const overflow = await page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    dialogs: [...document.querySelectorAll("dialog[open]")].map(element => ({ width: element.clientWidth, content: element.scrollWidth })),
  }));
  assert(overflow.document <= overflow.viewport, `${label}: document horizontal overflow: ${JSON.stringify(overflow)}`);
  assert(overflow.body <= overflow.viewport, `${label}: body horizontal overflow: ${JSON.stringify(overflow)}`);
  assert(overflow.dialogs.every(dialog => dialog.content <= dialog.width), `${label}: dialog horizontal overflow: ${JSON.stringify(overflow)}`);
  const splitAmounts = await page.locator(".hl-overview .hl-stat strong, .hl-market-price > strong").evaluateAll(elements => elements.filter(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    return range.getClientRects().length > 1;
  }).map(element => element.textContent));
  assert.deepEqual(splitAmounts, [], `${label}: financial amounts must not split their decimals across lines`);
}

async function waitEnabled(page, locator) {
  await locator.waitFor();
  await page.waitForFunction(element => !element.disabled, await locator.elementHandle());
}
async function candleCount(chart) {
  if (!await chart.count()) return 0;
  const value = await chart.getAttribute("data-candle-count");
  assert.notEqual(value, null, "Interactive chart exposes its actual series count");
  return Number(value);
}

// Fixture shapes and behavior assertions follow the public resident-tool models.
const address = "0x1111111111111111111111111111111111111111";
const agentAddress = "0x2222222222222222222222222222222222222222";
const now = () => Date.now();
const observation = (environment = "mainnet") => ({ environment, observedAt: now(), complete: true, errors: [] });
const asset = (name, index, price, previous, decimals, maxLeverage) => ({
  name, asset: index, szDecimals: decimals, maxLeverage, marginTableId: 56,
  context: { markPx: String(price), midPx: String(price), oraclePx: String(price - 2), funding: "0.0000125", openInterest: "18452.125", dayNtlVlm: "1832485079.62", prevDayPx: String(previous), dayBaseVlm: "16944.53", premium: "0.000018" },
});
const marketRows = [asset("BTC", 0, 108432, 105710, 5, 40), asset("ETH", 1, 4258.5, 4334.2, 4, 25), asset("SOL", 2, 204.83, 197.4, 2, 20)];
const positions = [{
  coin: "BTC", szi: "0.12", entryPx: "106400", leverage: { type: "cross", value: 5 },
  liquidationPx: "84872.5", marginUsed: "2602.368", maxLeverage: 40,
  positionValue: "13011.84", returnOnEquity: "0.093701", unrealizedPnl: "243.84",
  cumFunding: { allTime: "-3.21", sinceChange: "-1.02", sinceOpen: "-3.21" },
}, {
  coin: "ETH", szi: "-1.5", entryPx: "4300", leverage: { type: "isolated", value: 3, rawUsd: "2129.25" },
  liquidationPx: "5671.25", marginUsed: "2129.25", maxLeverage: 25,
  positionValue: "6387.75", returnOnEquity: "0.029236", unrealizedPnl: "62.25",
  cumFunding: { allTime: "1.14", sinceChange: "0.56", sinceOpen: "1.14" },
}];
const openOrders = [{
  coin: "BTC", oid: 178832906443, cloid: "0x" + "3".repeat(32), side: "B", limitPx: "104500", sz: "0.025", origSz: "0.025",
  timestamp: now() - 210000, reduceOnly: false, isTrigger: false, isPositionTpsl: false,
  orderType: "Limit", triggerCondition: "N/A", triggerPx: "0", children: [],
}];
function markets(environment) {
  return { ...observation(environment), markets: marketRows, marginTables: [[56, { marginTiers: [{ lowerBound: "0", maxLeverage: 40 }, { lowerBound: "150000000", maxLeverage: 20 }] }]], collateralToken: 0 };
}
function account(environment) {
  const marginSummary = { accountValue: "18467.38", totalMarginUsed: "4731.618", totalNtlPos: "19399.59", totalRawUsd: "18161.29" };
  const snapshot = {
    ...observation(environment), address,
    observations: ["clearinghouseState", "frontendOpenOrders", "userFees", "userAbstraction"].map(source => ({ source, observedAt: now(), serverTime: now() })),
    abstraction: "disabled", balanceSource: "perps", excludedOrderCount: 0, warnings: [], balances: null,
    clearinghouseState: { assetPositions: positions.map(position => ({ type: "oneWay", position })), marginSummary, crossMarginSummary: marginSummary, crossMaintenanceMarginUsed: "324.6", withdrawable: "12984.27", time: now() },
    positions, openOrders, fees: { userCrossRate: "0.00045", userAddRate: "0.00015", activeReferralDiscount: "0" },
  };
  if (accountMode === "empty") {
    const emptyMargin = Object.fromEntries(Object.keys(marginSummary).map(key => [key, "0"]));
    return { ...snapshot, abstraction: "default", balanceSource: "unknown", positions: [], openOrders: [], balances: { balances: [] }, clearinghouseState: { ...snapshot.clearinghouseState, assetPositions: [], marginSummary: emptyMargin, crossMarginSummary: emptyMargin, crossMaintenanceMarginUsed: "0", withdrawable: "0" }, warnings: ["The account balance mode is not resolved. Perps and token balances must not be added together or treated as available collateral."] };
  }
  if (accountMode === "perps") return snapshot;
  const balances = { balances: [{ coin: "USDC", token: 0, total: "9876.543210", hold: "160.25", entryNtl: "9876.543210" }, { coin: "HYPE", token: 150, total: "25", hold: "0", entryNtl: "725" }] };
  if (accountMode === "unknown") return { ...snapshot, abstraction: null, balanceSource: "unknown", balances, warnings: ["The account balance mode is not resolved. Perps and token balances must not be added together or treated as available collateral."] };
  return { ...snapshot, abstraction: "unifiedAccount", balanceSource: "unified", balances: accountMode === "unified_missing" ? null : accountMode === "unified_empty" ? { balances: [] } : balances,
    ...(accountMode === "unified_missing" ? { complete: false, errors: [{ source: "spotClearinghouseState", message: "Shared USDC balance is unavailable." }] } : {}) };
}
function book(coin, environment) {
  const price = Number(marketRows.find(market => market.name === coin).context.markPx);
  const step = coin === "BTC" ? 1 : 0.1;
  const side = sign => Array.from({ length: 20 }, (_, index) => ({ px: (price + sign * (index + 1) * step).toFixed(coin === "BTC" ? 0 : 2), sz: (0.12 + (index * 7 % 11) / 10).toFixed(3), n: 2 + index }));
  return { ...observation(environment), coin, time: now(), levels: [side(-1), side(1)] };
}
function candles(coin, interval, environment) {
  const unit = { "1m": 60000, "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000, "1d": 86400000 }[interval] ?? 3600000;
  const endTime = Math.floor(now() / unit) * unit - 1, count = 96;
  const price = Number(marketRows.find(market => market.name === coin).context.markPx);
  const bars = Array.from({ length: count }, (_, index) => {
    const start = endTime - (count - index) * unit + 1;
    const open = price * (0.971 + index / count * 0.029 + Math.sin(index * 0.45) * 0.004);
    const close = open + price * Math.sin(index * 0.77 + 1) * 0.002;
    const fixed = value => value.toFixed(coin === "BTC" ? 1 : 3);
    return { t: start, T: start + unit - 1, s: coin, i: interval, o: fixed(open), c: fixed(close), h: fixed(Math.max(open, close) + price * 0.0015), l: fixed(Math.min(open, close) - price * 0.0015), v: String(200 + index * 13 % 850), n: 100 + index * 37 };
  });
  return { ...observation(environment), coin, interval, startTime: bars[0].t, endTime, candles: bars, historyLimit: 5000, possiblyTruncated: false };
}
function session(state = "active") {
  return { state, walletAddress: address, agentAddress: state === "missing" ? null : agentAddress, agentName: state === "missing" ? null : "Neutron browser", createdAt: now() - 86400000, expiresAt: now() + 89 * 86400000, checkedAt: now(), deviceLocal: true, error: null, operation: null };
}
function tradePreview(intent, environment = "mainnet") {
  const market = marketRows.find(row => row.name === intent.coin) ?? marketRows[0];
  const closing = intent.kind === "close", canceling = intent.kind === "cancel" || intent.kind === "cancelAll";
  const size = intent.size ?? (closing ? positions.find(position => position.coin === intent.coin)?.szi.replace("-", "") : "0");
  const title = closing ? `Close ${intent.coin} position` : canceling ? `Cancel ${intent.coin ?? "perpetual"} order` : intent.kind === "leverage" ? `Set ${intent.coin} leverage` : intent.kind === "margin" ? `Adjust ${intent.coin} isolated margin` : intent.kind === "modify" ? `Edit ${intent.coin} order` : intent.kind === "trigger" ? `Protect ${intent.coin} position` : `${intent.side === "sell" ? "Short" : "Long"} ${intent.coin}`;
  const details = canceling ? [`Order ${intent.oid ?? "all"}`] : intent.kind === "leverage" ? [`${intent.leverage}× ${intent.isCross ? "cross" : "isolated"} margin`] : intent.kind === "margin" ? [`Margin adjustment: ${intent.amountUsdc} USDC`] : [`${size} ${market.name}`, intent.orderType === "limit" || intent.kind === "modify" ? `Limit price: ${intent.price} USDC` : "Market order · IOC", `${closing || intent.reduceOnly || intent.kind === "trigger" ? "Reduce only" : "Opens or increases exposure"}`, `Wallet: ${address}`];
  return { review: { ...intent, title, environment, walletAddress: address, operation: intent.kind, details }, action: {}, orders: canceling || ["leverage", "margin"].includes(intent.kind) ? [] : [{ coin: intent.coin, state: "prepared", size, cloid: "0x" + "4".repeat(32) }], observedAt: now(), warnings: intent.orderType === "market" || closing ? ["The IOC order can fill partially. Any unfilled remainder is canceled."] : [] };
}
function tradeOperation(operationId, intent, state = "filled", environment = "mainnet") {
  const preview = tradePreview(intent, environment);
  return { operationId, state, createdAt: now() - 1000, updatedAt: now(), intent, review: preview.review, orders: preview.orders.map(order => ({ ...order, state, oid: 178832906444, ...(state === "filled" ? { filledSize: order.size, averagePrice: "108432" } : {}) })), message: state === "uncertain" ? "The response was lost. Check order status before retrying." : "Order acknowledged by Hyperliquid.", canRetryExact: state === "uncertain" };
}
function fundingQuote(input) {
  const [whole, fraction = ""] = input.amount.split("."), amount = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"));
  return {
    input: { environment: input.environment, direction: input.direction, chainId: input.chainId, amount: input.amount, speed: input.speed ?? "fast", ...(input.sourceBalance ? { sourceBalance: input.sourceBalance } : {}) }, account: { accountId: "main", address, publicKey: "0x02" + "2".repeat(64), keyFingerprint: "0x" + "3".repeat(64), namespaceVersion: "1" }, recipient: address, observedAtMs: now(),
    amountAtoms: String(amount), estimatedFeeAtoms: "250000", maxFeeAtoms: "275000", minimumReceiveAtoms: String(amount - 275000n),
    protocolFeeAtoms: "12512", forwardingFeeAtoms: "237488", activationFeeAtoms: "0", sourceDex: "", accountMode: "standard", allowanceAtoms: "0",
    sourceGas: { estimatedFeeWei: input.direction === "deposit" ? "150000000000000" : null, maximumFeeWei: input.direction === "deposit" ? "190000000000000" : null, reason: input.direction === "deposit" ? "Exact USDC approval is needed first." : "Circle covers destination gas from the forwarding fee." },
    warnings: ["Forwarding fees are deducted from USDC. Ethereum source gas is additional."],
  };
}
function fundingOperation(operationId, input, state = "pending") {
  return { operationId, state, phase: state === "complete" ? "complete" : "waiting_attestation", summary: `${input.direction === "deposit" ? "Deposit" : "Withdraw"} ${input.amount} USDC ${input.direction === "deposit" ? "from" : "to"} ${input.chainId === "1" ? "Ethereum" : "Arbitrum"}`, message: state === "complete" ? "Destination USDC receipt confirmed." : "Source burn confirmed. Waiting for Circle attestation and destination credit.", direction: input.direction, chainId: input.chainId, amount: input.amount, sourceTransactionHash: "0x" + "a".repeat(64), destinationTransactionHash: state === "complete" ? "0x" + "b".repeat(64) : null, receivedUsdc: state === "complete" ? "124.873456" : null, quote: fundingQuote(input), steps: [{ label: "Deposit USDC through CCTP", status: "confirmed", transactionHash: "0x" + "a".repeat(64) }], observation: null };
}

const calls = [], effects = [], reviewOutcomes = [], forbiddenNetwork = [];
const savedTrades = new Map([["5".repeat(32), tradeOperation("5".repeat(32), { kind: "order", coin: "BTC", side: "buy", orderType: "market", size: "0.01", slippageBps: 50 }, "uncertain")]]);
const savedFunding = new Map();
const reconciliationResponses = new Map();
let failingReads = false, incompleteAccount = false, missingKey = false, readGate = null, nextEffectState = null;
let fundingEffectGate = null, fundingPageSize = null;
let nextFundingPhase = null;
let accountMode = "perps", wholeAccountFailure = false, unavailableCapacity = false, pendingKey = false;
let failingReconciliationId = null;
const encodeData = value => ({ dataJson: JSON.stringify(value) });
const encodeResult = value => ({ resultJson: JSON.stringify(value) });
const tradeIntent = (name, args) => {
  const { environment, operationId, ...intent } = args;
  const kinds = { hl_place_order_v1: "order", hl_preview_order_v1: "order", hl_close_position_v1: "close", hl_cancel_order_v1: "cancel", hl_leverage_v1: "leverage", hl_modify_order_v1: "modify", hl_protect_position_v1: "trigger", hl_isolated_margin_v1: "margin" };
  assert(kinds[name], `Unimplemented effect fixture: ${name}`);
  return { kind: kinds[name], ...intent };
};
async function fixture(kind, [call, outcome]) {
  calls.push({ kind, call: structuredClone(call), outcome: structuredClone(outcome) });
  assert(kind === "callTool" || kind === "reviewOutcome", `Unexpected ${kind} access: UI must use its resident tools.`);
  assert.equal(call.target, "app:hyperliquid:background");
  const args = call.arguments ?? {}, environment = args.environment ?? "mainnet";
  if (kind === "reviewOutcome") {
    reviewOutcomes.push({ call: structuredClone(call), ...outcome });
    if (!outcome.approved) throw new Error("Action declined.");
    effects.push(structuredClone(call));
    const intent = call.name === "hl_retry_trade_v1" ? savedTrades.get(args.operationId).intent : tradeIntent(call.name, args), state = nextEffectState ?? (intent.kind === "cancel" ? "canceled" : intent.orderType === "limit" ? "resting" : "filled");
    nextEffectState = null;
    const result = tradeOperation(args.operationId, intent, state, environment); savedTrades.set(args.operationId, result);
    return encodeResult(result);
  }
  if (readGate) await readGate;
  if (failingReads && ["hl_market_v1", "hl_preview_order_v1"].includes(call.name)) throw new Error("Hyperliquid market data unavailable: fixture provider disconnected.");
  if (wholeAccountFailure && call.name === "hl_account_v1") throw new Error("The complete account request failed: fixture account provider disconnected.");
  switch (call.name) {
    case "hl_markets_v1": return encodeData({ ...markets(environment), total: marketRows.length, nextOffset: null });
    case "hl_market_v1": {
      const chart = candles(args.coin, args.interval, environment), depth = book(args.coin, environment);
      const time = now();
      return encodeData({ environment, observedAt: time, market: marketRows.find(row => row.name === args.coin), book: { ...depth, time, observedAt: time }, candles: chart.candles, chart, analysis: {} });
    }
    case "hl_account_v1": return encodeData({ ...account(environment), wallet: fundingQuote({ environment: "mainnet", direction: "deposit", chainId: "1", amount: "1" }).account, ...(incompleteAccount ? { complete: false, positions: null, openOrders: null, clearinghouseState: null, errors: [{ source: "clearinghouseState", message: "Account provider did not return positions or orders." }] } : {}) });
    case "hl_setup_status_v1": return encodeData(session(pendingKey ? "approval_pending" : missingKey ? "missing" : "active"));
    case "hl_order_capacity_v1": return encodeData({ maxSize: unavailableCapacity ? null : args.reduceOnly ? args.side === "sell" ? "0.12345" : "0" : args.side === "buy" ? "0.12345" : "0.08765", availableMarginUsdc: unavailableCapacity ? null : "432.123456", leverage: 5, marginMode: "cross", observedAt: now(), ...(unavailableCapacity ? { reason: "Available margin is unavailable. Refresh to try again." } : {}) });
    case "hl_funding_capacity_v1": return encodeData({ maxAmountUsdc: unavailableCapacity ? null : args.direction === "withdraw" ? "42.987654" : args.chainId === "1" ? "250.123456" : "77.123456", observedAt: now(), ...(unavailableCapacity ? { reason: "USDC balance is unavailable. Refresh to try again." } : {}) });
    case "hl_preview_order_v1": return encodeData(tradePreview(tradeIntent(call.name, args), environment));
    case "hl_place_order_v1": case "hl_close_position_v1": case "hl_cancel_order_v1": case "hl_leverage_v1": case "hl_modify_order_v1": case "hl_protect_position_v1": case "hl_isolated_margin_v1": {
      assert.match(args.operationId, /^[0-9a-f]{32}$/);
      return { __review: tradePreview(tradeIntent(call.name, args), environment).review };
    }
    case "hl_retry_trade_v1": {
      const saved = savedTrades.get(args.operationId); assert(saved && saved.canRetryExact, "Explicit retry requires a retained uncertain operation");
      return { __review: saved.review };
    }
    case "hl_funding_quote_v1": return encodeData(fundingQuote(args));
    case "hl_funding_execute_v1": {
      assert.match(args.operationId, /^[0-9a-f]{32}$/);
      effects.push(structuredClone(call));
      const result = fundingOperation(args.operationId, args);
      if (nextFundingPhase) {
        result.phase = nextFundingPhase; nextFundingPhase = null;
        result.message = "Forwarded to HyperCore. Exact Core credit linkage is not yet available.";
        result.recovery = { status: "forwarded", methods: [], chainId: "999", gasSymbol: "HYPE", transactionHash: "0x" + "b".repeat(64), walletStatus: null, message: "The original message has already been forwarded." };
      }
      savedFunding.set(args.operationId, result);
      if (fundingEffectGate) await fundingEffectGate;
      return encodeResult(result);
    }
    case "hl_funding_recover_v1": {
      assert.deepEqual(Object.keys(args).sort(), ["environment", "method", "operationId"], "Recovery supplies only the saved operation ID and chosen method");
      const saved = savedFunding.get(args.operationId); assert(saved?.recovery, "Recovery must refer to an existing attested transfer");
      assert(saved.recovery.methods.includes(args.method), "Fixture recovery method must be currently offered");
      effects.push(structuredClone(call));
      const recovery = { ...saved.recovery, ...(args.method === "perps" ? { status: "complete", methods: [], message: "Your original deposit is now available in perps." } : args.method === "circle" ? { status: "ready", methods: ["wallet"], message: "The renewed attestation is ready to submit.", walletStatus: null } : saved.recovery.status === "pending" ? { status: "complete", methods: [], transactionHash: "0x" + "c".repeat(64), walletStatus: "confirmed", message: "Original transfer completed." } : { status: "pending", methods: ["wallet"], walletStatus: "submitted", message: "The destination transaction is awaiting confirmation." }) };
      const result = { ...saved, recovery, state: recovery.status === "complete" ? "complete" : "pending" };
      savedFunding.set(args.operationId, result); return encodeResult(result);
    }
    case "hl_activity_v1": {
      const rows = [...savedFunding.values()].reverse(), offset = Number(args.cursor ?? 0), count = fundingPageSize ?? rows.length;
      return encodeData({ environment, trades: [...savedTrades.values()], funding: rows.slice(offset, offset + count).map(result => ({ id: result.operationId, summary: result.summary, phase: result.phase, revision: "1", created_at: String(BigInt(now() - 1000) * 1000000n), updated_at: String(BigInt(now()) * 1000000n), result })), nextCursor: offset + count < rows.length ? String(offset + count) : null });
    }
    case "hl_reconcile_v1": {
      if (args.operationId === failingReconciliationId) throw new Error("Temporary venue status read failure.");
      const queued = reconciliationResponses.get(args.operationId)?.shift();
      if (queued) {
        const observed = await (typeof queued === "function" ? queued() : queued);
        savedTrades.set(args.operationId, observed);
        return encodeResult(observed);
      }
      const saved = args.kind === "funding" ? savedFunding.get(args.operationId) : savedTrades.get(args.operationId);
      assert(saved, "Status check retains an existing operation ID");
      return encodeResult(saved);
    }
    case "hl_setup_v1": {
      effects.push(structuredClone(call)); missingKey = args.action === "revoke";
      return encodeResult(session(missingKey ? "revoked" : "active"));
    }
    default: throw new Error("Unimplemented resident tool fixture: " + call.name);
  }
}

const { browser, server, url } = await start();
const errors = [], coverage = [], viewports = [{ width: 320, height: 900 }, { width: 400, height: 900 }, { width: 900, height: 700 }, { width: 1440, height: 900 }];
let page;
try {
  page = await browser.newPage({ viewport: viewports.at(-1) });
  page.setDefaultTimeout(15000);
  page.on("pageerror", error => errors.push(error.message));
  await page.exposeFunction("fixture", fixture);
  await page.addInitScript(() => {
    const sockets = [];
    class FixtureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      readyState = 0; sent = []; onopen = null; onmessage = null; onerror = null; onclose = null;
      constructor(url) {
        if (!["wss://api.hyperliquid.xyz/ws", "wss://api.hyperliquid-testnet.xyz/ws"].includes(url)) throw new Error("Unexpected market socket URL: " + url);
        this.url = url; sockets.push(this);
        setTimeout(() => { if (this.readyState !== 0) return; this.readyState = 1; this.onopen?.(new Event("open")); }, 0);
      }
      send(encoded) {
        if (this.readyState !== 1) throw new Error("Fixture socket is not open");
        const body = JSON.parse(encoded); this.sent.push(body);
        if (body.method === "ping") this.push({ channel: "pong" });
      }
      close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(new Event("close")); }
      push(envelope) { if (this.readyState === 1) this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(envelope) })); }
    }
    window.WebSocket = FixtureSocket;
    window.fixtureSockets = sockets;
    window.fixtureStream = envelope => sockets.filter(socket => socket.readyState === 1).forEach(socket => socket.push(envelope));
    const repeat = window.setInterval.bind(window), stop = window.clearInterval.bind(window), polls = new Map();
    window.setInterval = (callback, delay, ...args) => {
      const id = repeat(callback, delay, ...args);
      if (delay === 10000 || delay === 30000) polls.set(id, () => callback(...args));
      return id;
    };
    window.clearInterval = id => { polls.delete(id); stop(id); };
    window.fixturePoll = () => { for (const poll of [...polls.values()]) poll(); };
  });
  await page.route("https://**", route => { forbiddenNetwork.push(route.request().url()); return route.abort("blockedbyclient"); });
  let releaseReads;
  readGate = new Promise(resolve => { releaseReads = resolve; });
  await page.goto(url);
  await page.getByRole("button", { name: "Checking trading access…", exact: true }).waitFor();
  await page.screenshot({ path: resolve(artifacts, "loading-desktop.png"), fullPage: true });
  readGate = null; releaseReads();
  await page.getByText("Perps equity", { exact: true }).waitFor();
  await page.locator(".hl-overview").getByText("$18,467.38", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Trading access enabled", exact: true }).waitFor();
  assert.equal(await page.locator(".hl-candles-kind").count(), 0, "Redundant candle icon and Candles label are removed at every width");
  coverage.push("actual React bundle and public resident response contracts", "loading, connected account equity and ready trading key");

  const dialog = () => page.locator("dialog[open]");
  const nav = name => page.getByRole("navigation", { name: "Hyperliquid sections" }).getByRole("button", { name: new RegExp("^" + name) });
  const panel = async name => {
    const button = page.locator(".hl-compact-panels").getByRole("button", { name, exact: true });
    if (await button.isVisible()) await button.click();
  };
  const screenshot = async name => { await assertNoOverflow(page, name); await page.screenshot({ path: resolve(artifacts, name + ".png"), fullPage: true }); };
  const refresh = () => page.getByRole("button", { name: "Refresh market and account", exact: true }).click();
  const approve = async () => {
    await dialog().getByRole("button", { name: "Approve action", exact: true }).click();
    await dialog().waitFor({ state: "hidden" });
    await page.waitForFunction(() => !document.querySelector(".hl-execution")?.textContent.includes("Following your request"));
  };
  await page.getByRole("button", { name: "Select perpetual market, BTC selected", exact: true }).click();
  await dialog().locator(".hl-market-option").filter({ hasText: "SOL" }).click();
  await page.getByRole("button", { name: "5× cross · Configure", exact: true }).waitFor();
  await page.getByRole("button", { name: "5× cross · Configure", exact: true }).click();
  assert.equal(await dialog().getByLabel("Leverage", { exact: true }).inputValue(), "5", "Configured leverage remains visible even without an open position");
  assert.equal(await dialog().getByLabel("Margin mode", { exact: true }).inputValue(), "cross");
  await dialog().getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Select perpetual market, SOL selected", exact: true }).click();
  await dialog().locator(".hl-market-option").filter({ hasText: "BTC" }).click();
  await page.waitForFunction(() => Number(document.querySelector(".hl-candles-viewport")?.getAttribute("data-candle-count")) > 0);
  coverage.push("leverage dialog starts from venue-observed settings for a market without an open position");

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await nav("Trade").click(); await panel("Order");
    await page.getByRole("heading", { name: "Place order", exact: true }).waitFor();
    await screenshot(`trade-order-${viewport.width}x${viewport.height}`);
    await panel("Chart");
    const chart = page.getByRole("img", { name: /^BTC candlestick price chart/ });
    await chart.waitFor();
    assert(await candleCount(chart) >= 40, "Chart renders actual candle and volume series");
    if (await chart.getAttribute("data-candle-count") !== null) {
      assert(await chart.locator("canvas").count() >= 2, "Interactive chart renders its price and scale canvases");
      assert(await chart.locator("canvas").first().evaluate(canvas => canvas.width > 0 && canvas.height > 0), "Canvas is sized for the tile");
    }
    const box = await chart.boundingBox(); assert(box && box.width > 200 && box.height > 100, "Chart remains usable in this tile shape");
    const plotTop = await chart.evaluate(element => element.getBoundingClientRect().top + scrollY);
    assert(plotTop <= 360, `Candlestick plot starts high in the tile at ${viewport.width}px: ${plotTop}px`);
    assert.equal(await page.locator(".hl-candles-help, .hl-data-status, .hl-account-info").count(), 0, "Routine tips, healthy live timestamp, and account popup trigger are absent at every tile size");
    assert.equal(await page.getByText("Select a price to set a limit order.", { exact: true }).count(), 0, "Orderbook tip is removed");
    await screenshot(`trade-chart-${viewport.width}x${viewport.height}`);
    await panel("Book");
    await page.getByRole("heading", { name: "Order book", exact: true }).waitFor();
    assert.equal(await page.locator(".hl-book-row").count(), 18);
    await screenshot(`trade-book-${viewport.width}x${viewport.height}`);
  }
  coverage.push("320×900, 400×900, 900×700 and 1440×900 layouts without horizontal overflow", "candlestick OHLCV charts and orderbook depth in every tile shape");

  const interactiveChart = page.getByRole("img", { name: /^BTC candlestick price chart/ });
  const chartControls = page.getByRole("group", { name: "Interactive candlestick chart", exact: true });
  const rangeBefore = await chartControls.evaluate(element => Number(element.dataset.visibleTo) - Number(element.dataset.visibleFrom));
  await page.getByRole("button", { name: "Zoom in chart", exact: true }).click();
  await page.waitForFunction(previous => { const element = document.querySelector(".hl-candles-viewport"); return Number(element?.dataset.visibleTo) - Number(element?.dataset.visibleFrom) < previous; }, rangeBefore);
  await chartControls.focus();
  const selectedTime = await page.locator(".hl-candles-legend").getAttribute("data-selected-time");
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(previous => document.querySelector(".hl-candles-legend")?.getAttribute("data-selected-time") !== previous, selectedTime);
  await page.getByRole("button", { name: "Fit all candles", exact: true }).click();
  const levels = page.getByRole("button", { name: "Position & orders", exact: true });
  await levels.click(); assert.equal(await levels.getAttribute("aria-pressed"), "false"); await levels.click();
  coverage.push("no redundant chart tips, orderbook hint, healthy live status row or account-details popup", "interactive chart zoom, fit and keyboard candle inspection", "position and order chart overlays can be toggled");

  const liveDepth = book("BTC", "mainnet");
  liveDepth.levels = liveDepth.levels.map(side => side.map(level => ({ ...level, px: String(Number(level.px) + 3) })));
  await page.evaluate(payload => window.fixtureStream(payload), { channel: "l2Book", data: liveDepth });
  await page.getByRole("button", { name: "Use limit price 108434", exact: true }).waitFor();
  await page.evaluate(payload => window.fixtureStream(payload), { channel: "activeAssetCtx", data: { coin: "BTC", ctx: { ...marketRows[0].context, markPx: "108437" } } });
  await page.waitForFunction(() => document.querySelector(".hl-market-price > strong")?.textContent === "$108,437.00");
  await page.evaluate(payload => window.fixtureStream(payload), { channel: "activeAssetCtx", data: { coin: "ETH", ctx: { ...marketRows[1].context, markPx: "4000" } } });
  assert.equal(await page.locator(".hl-market-price > strong").innerText(), "$108,437.00", "Another coin's stream cannot update selected BTC");
  await page.evaluate(payload => window.fixtureStream(payload), { channel: "activeAssetCtx", data: { coin: "BTC", ctx: marketRows[0].context } });
  await page.evaluate(payload => window.fixtureStream(payload), { channel: "l2Book", data: book("BTC", "mainnet") });
  const candleStart = Math.floor(now() / 3600000) * 3600000;
  const liveBar = { t: candleStart, T: candleStart + 3599999, s: "BTC", i: "1h", o: "108432", h: "108445", l: "108425", c: "108440", v: "900.125", n: 421 };
  await page.evaluate(payload => window.fixtureStream(payload), { channel: "candle", data: liveBar });
  await page.waitForFunction(() => document.querySelector(".hl-candles-viewport")?.getAttribute("data-candle-count") === "97");
  await page.evaluate(payload => window.fixtureStream(payload), { channel: "candle", data: { ...liveBar, c: "108441" } });
  assert.equal(await candleCount(interactiveChart), 97, "Repeated streaming candle updates replace the same timestamp");
  coverage.push("actual market-stream parser updates book and mark directly", "stream subscription excludes a different coin");
  coverage.push("live candles append once and replace matching timestamps");
  const nextLiveBar = { ...liveBar, t: liveBar.t + 3600000, T: liveBar.T + 3600000, o: "108441", h: "108449", c: "108442", v: "3", n: 2 };
  await page.evaluate(payload => window.fixtureStream(payload), { channel: "candle", data: nextLiveBar });
  await page.waitForFunction(() => document.querySelector(".hl-candles-viewport")?.getAttribute("data-candle-count") === "98");
  await chartControls.focus(); await page.keyboard.press("Escape"); await page.keyboard.press("ArrowLeft");
  assert.equal(Number(await page.locator(".hl-candles-legend").getAttribute("data-selected-time")), liveBar.t / 1000, "After rollover, keyboard inspection retains the just-completed streamed candle");
  assert((await page.locator(".hl-candles-ohlc").innerText()).includes("108,441"), "The completed streamed revision does not revert to an older REST observation");
  const latestBeforeReconnect = await page.evaluate(() => window.fixtureSockets.length);
  await page.evaluate(() => window.fixtureSockets.filter(socket => socket.readyState === 1).forEach(socket => socket.close()));
  assert.equal(await candleCount(interactiveChart), 98, "A stream disconnect retains already observed candle history");
  await page.waitForFunction(previous => window.fixtureSockets.length > previous && window.fixtureSockets.some(socket => socket.readyState === 1), latestBeforeReconnect);
  await refresh();
  await page.getByRole("button", { name: "5× cross · Configure", exact: true }).waitFor();
  assert.equal(await candleCount(interactiveChart), 98, "Reconnect REST snapshots that trail the stream cannot discard completed streamed candles");
  coverage.push("live rollover retains completed candles and their final revision", "disconnect and reconnect preserve observed candles until REST catches up");


  await page.getByRole("button", { name: "Select perpetual market, BTC selected", exact: true }).click();
  await dialog().getByLabel("Search perpetual markets", { exact: true }).fill("ETH");
  let releaseMarket;
  readGate = new Promise(resolve => { releaseMarket = resolve; });
  await dialog().locator(".hl-market-option").filter({ hasText: "ETH" }).click();
  await page.getByRole("button", { name: "Select perpetual market, ETH selected", exact: true }).waitFor();
  assert.equal(await page.locator(".hl-market-price > strong").innerText(), "$4,258.50", "New selected market cannot inherit the previous market's price");
  assert.equal(await candleCount(page.getByRole("img", { name: /candlestick price chart/ })), 0, "New market clears previous candles while its request is pending");
  readGate = null; releaseMarket();
  await page.getByRole("img", { name: /^ETH candlestick price chart/ }).waitFor();
  await page.waitForFunction(() => Number(document.querySelector(".hl-candles-viewport")?.getAttribute("data-candle-count")) > 0);
  await page.getByRole("button", { name: "Select perpetual market, ETH selected", exact: true }).click();
  await dialog().getByLabel("Search perpetual markets", { exact: true }).fill("BTC");
  await dialog().locator(".hl-market-option").filter({ hasText: "BTC" }).click();
  await page.getByRole("img", { name: /^BTC candlestick price chart/ }).waitFor();
  await page.waitForFunction(() => Number(document.querySelector(".hl-candles-viewport")?.getAttribute("data-candle-count")) > 0);
  coverage.push("market search", "market switch clears previous candles and keeps quote identity scoped while loading");

  await page.setViewportSize({ width: 400, height: 900 });
  await panel("Chart"); await page.getByRole("button", { name: "4h", exact: true }).click();
  await page.getByRole("img", { name: /^BTC candlestick price chart, 4h interval/ }).waitFor();
  await page.waitForFunction(() => Number(document.querySelector(".hl-candles-viewport")?.getAttribute("data-candle-count")) > 0);
  assert(calls.some(entry => entry.call.name === "hl_market_v1" && entry.call.arguments.interval === "4h"));
  await panel("Book");
  await page.getByRole("button", { name: "Use limit price 108431", exact: true }).click();
  await page.getByLabel("Limit price", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Limit price", { exact: true }).inputValue(), "108431");
  await waitEnabled(page, page.locator(".hl-ticket").getByRole("button", { name: "Max", exact: true }));
  await page.locator(".hl-ticket").getByRole("button", { name: "Max", exact: true }).click();
  assert.equal(await page.getByLabel("Size", { exact: true }).inputValue(), "0.12345", "Max uses the current venue capacity, not withdrawable collateral or maximum market leverage");
  await page.locator(".hl-ticket").getByRole("button", { name: "25%", exact: true }).click();
  assert.equal(await page.getByLabel("Size", { exact: true }).inputValue(), "0.03086", "Percentage sizes round down to market precision");
  await page.getByRole("slider", { name: "Order allocation", exact: true }).fill("50");
  assert.equal(await page.getByLabel("Size", { exact: true }).inputValue(), "0.06172");
  unavailableCapacity = true; await refresh();
  await page.waitForFunction(() => document.querySelector(".hl-allocation-slider")?.disabled);
  assert(await page.locator(".hl-ticket").getByRole("button", { name: "Max", exact: true }).isDisabled(), "Missing capacity never produces an invented Max");
  unavailableCapacity = false; await refresh();
  coverage.push("venue-based exact Max, percentage presets and accessible allocation slider", "missing capacity disables allocation without preventing manually entered sizing");
  await page.getByLabel("Size", { exact: true }).fill("0.00501");
  await page.getByLabel("Post only", { exact: true }).check();
  const reviewLong = page.getByRole("button", { name: "Review long", exact: true });
  await waitEnabled(page, reviewLong); await reviewLong.click();
  await dialog().getByRole("button", { name: "Approve action" }).waitFor();
  await dialog().getByText("0.00501 BTC", { exact: true }).waitFor();
  await screenshot("limit-review-narrow");
  await dialog().getByRole("button", { name: "Decline", exact: true }).click();
  await dialog().waitFor({ state: "hidden" });
  assert.equal(effects.length, 0, "Declining exact review sends no effect");
  await waitEnabled(page, reviewLong); await reviewLong.click(); await approve();
  assert.equal(effects.at(-1).arguments.orderType, "limit");
  assert.equal(effects.at(-1).arguments.price, "108431");
  assert.equal(effects.at(-1).arguments.size, "0.00501");
  assert.equal(effects.at(-1).arguments.postOnly, true);
  coverage.push("book price selects limit order", "decimal size and limit price reach exact owner review", "declined review dispatches no effect", "post-only limit order submission");

  await page.getByRole("button", { name: "Market", exact: true }).click();
  const marketHelp = page.getByLabel("About market orders", { exact: true });
  assert.equal(await marketHelp.locator("..").getAttribute("open"), null, "Order explanation starts collapsed behind an information icon");
  await marketHelp.focus(); await page.keyboard.press("Enter");
  await page.getByRole("note").filter({ hasText: "Any unfilled quantity" }).waitFor();
  await marketHelp.press("Enter");
  await page.getByRole("button", { name: "Short", exact: true }).click();
  await page.getByLabel("Size", { exact: true }).fill("0.01234");
  await page.getByLabel("Maximum slippage percent", { exact: true }).fill("0.75");
  const reviewShort = page.getByRole("button", { name: "Review short", exact: true });
  await waitEnabled(page, reviewShort); await reviewShort.click(); await approve();
  assert.equal(effects.at(-1).arguments.side, "sell"); assert.equal(effects.at(-1).arguments.orderType, "market");
  assert.equal(effects.at(-1).arguments.size, "0.01234"); assert.equal(effects.at(-1).arguments.slippageBps, 75);
  coverage.push("market short with explicit slippage and exact decimal quantity");

  await page.getByRole("button", { name: /Configure/ }).click();
  await dialog().getByLabel("Leverage", { exact: true }).fill("7");
  await dialog().getByLabel("Margin mode", { exact: true }).selectOption("isolated");
  await screenshot("leverage-narrow");
  await dialog().getByRole("button", { name: "Review leverage", exact: true }).click(); await approve();
  assert.equal(effects.at(-1).name, "hl_leverage_v1"); assert.equal(effects.at(-1).arguments.leverage, 7); assert.equal(effects.at(-1).arguments.isCross, false);

  await nav("Positions").click();
  await screenshot("positions-narrow");
  await page.locator(".hl-position").filter({ hasText: "BTC" }).getByRole("button", { name: "TP / SL", exact: true }).click();
  await dialog().getByLabel("Trigger price", { exact: true }).fill("102000");
  await dialog().getByLabel("Quantity to protect", { exact: true }).fill("0.04");
  await screenshot("stop-loss-narrow");
  await dialog().getByRole("button", { name: "Review protection order", exact: true }).click(); await approve();
  assert.equal(effects.at(-1).name, "hl_protect_position_v1"); assert.equal(effects.at(-1).arguments.side, "sell"); assert.equal(effects.at(-1).arguments.triggerKind, "sl"); assert.equal(effects.at(-1).arguments.size, "0.04");
  await page.locator(".hl-position").filter({ hasText: "ETH" }).getByRole("button", { name: "Adjust isolated margin", exact: true }).click();
  await dialog().getByRole("button", { name: "Remove margin", exact: true }).click();
  await dialog().getByLabel("USDC margin to remove", { exact: true }).fill("10.123456");
  await screenshot("isolated-margin-narrow");
  await dialog().getByRole("button", { name: "Review margin removal", exact: true }).click(); await approve();
  assert.equal(effects.at(-1).name, "hl_isolated_margin_v1"); assert.equal(effects.at(-1).arguments.amountUsdc, "-10.123456");
  positions[0].szi = "0.12345"; await refresh();
  await page.getByText("0.12345 BTC", { exact: true }).waitFor();
  await page.locator(".hl-position").filter({ hasText: "BTC" }).getByRole("button", { name: "Close position", exact: true }).click();
  await dialog().getByRole("button", { name: "25%", exact: true }).click();
  assert.equal(await dialog().getByLabel("Close size", { exact: true }).inputValue(), "0.03086", "Partial-close preset respects BTC metadata size precision");
  await dialog().getByLabel("Close size", { exact: true }).fill("0.03");
  await screenshot("close-partial-narrow");
  await dialog().getByRole("button", { name: "Review partial close", exact: true }).click(); await approve();
  assert.equal(effects.at(-1).name, "hl_close_position_v1"); assert.equal(effects.at(-1).arguments.size, "0.03");
  await page.locator(".hl-position").filter({ hasText: "ETH" }).getByRole("button", { name: "Close position", exact: true }).click();
  await dialog().getByRole("button", { name: "Review full close", exact: true }).click(); await approve();
  assert.equal(effects.at(-1).arguments.coin, "ETH"); assert.equal("size" in effects.at(-1).arguments, false, "Full close requests the fresh venue position size");
  await nav("Orders").click(); await screenshot("orders-narrow");
  await page.getByRole("button", { name: "Edit order", exact: true }).click();
  await dialog().getByLabel("Remaining order size", { exact: true }).fill("0.02123");
  await dialog().getByLabel("Replacement limit price", { exact: true }).fill("103001");
  await screenshot("modify-order-narrow");
  await dialog().getByRole("button", { name: "Review replacement", exact: true }).click(); await approve();
  assert.equal(effects.at(-1).name, "hl_modify_order_v1"); assert.equal(effects.at(-1).arguments.oid, openOrders[0].oid); assert.equal(effects.at(-1).arguments.size, "0.02123"); assert.equal(effects.at(-1).arguments.price, "103001");
  await page.getByRole("button", { name: "Cancel order", exact: true }).click(); await approve();
  assert.equal(effects.at(-1).name, "hl_cancel_order_v1"); assert.equal(effects.at(-1).arguments.oid, openOrders[0].oid);
  coverage.push("long and short position cards", "partial and full position close", "cancel an exact exchange order ID");
  coverage.push("partial-close preset rounds to the market's size precision");
  coverage.push("leverage and margin-mode review", "reduce-only stop loss", "exact signed isolated-margin removal", "edit limit order price and remaining size");

  const rejectedModifyId = "d".repeat(32);
  const rejectedModifyMessage = "Replacement rejected. Original order 42 is canceled and no longer live.";
  const rejectedModify = tradeOperation(rejectedModifyId, { kind: "modify", coin: "BTC", oid: 42, side: "sell", size: "0.01", price: "108400", reduceOnly: true, postOnly: false }, "rejected");
  savedTrades.set(rejectedModifyId, {
    ...rejectedModify, message: rejectedModifyMessage,
    orders: rejectedModify.orders.map(order => ({ ...order, error: "Replacement could not be placed." })),
    modification: { checkedAt: now(), original: { coin: "BTC", oid: 42, state: "canceled", venueStatus: "canceled" }, originalLive: false, replacementLive: false, errors: [] },
  });
  await nav("Activity").click(); await refresh();
  const rejectedModifyRow = page.locator(".hl-activity").filter({ hasText: rejectedModifyMessage });
  await rejectedModifyRow.getByRole("button", { name: "Check status", exact: true }).click();
  await page.locator(".hl-execution").getByText(rejectedModifyMessage, { exact: true }).waitFor();
  await page.getByRole("button", { name: "Dismiss operation status", exact: true }).click();
  assert.equal(await page.locator(".hl-execution").count(), 0, "A rejected modification notice can be dismissed independently of its saved evidence");
  assert.equal(await rejectedModifyRow.getByRole("button", { name: "Retry saved request", exact: true }).count(), 0, "Read-only status access does not offer retry for a rejected replacement");
  assert.equal(await rejectedModifyRow.getByRole("button", { name: "Continue saved trade", exact: true }).count(), 0, "A rejected replacement cannot be resumed as a prepared trade");
  const effectsBeforeModifyCheck = effects.length, reviewsBeforeModifyCheck = reviewOutcomes.length;
  const modifyChecksBefore = calls.filter(entry => entry.call.name === "hl_reconcile_v1" && entry.call.arguments.operationId === rejectedModifyId).length;
  await waitEnabled(page, rejectedModifyRow.getByRole("button", { name: "Check status", exact: true }));
  await rejectedModifyRow.getByRole("button", { name: "Check status", exact: true }).click();
  await page.locator(".hl-execution").getByText(rejectedModifyMessage, { exact: true }).waitFor();
  assert.equal(calls.filter(entry => entry.call.name === "hl_reconcile_v1" && entry.call.arguments.operationId === rejectedModifyId).length, modifyChecksBefore + 1, "Activity can refresh both order outcomes after the rejected modification notice is dismissed");
  assert.equal(effects.length, effectsBeforeModifyCheck, "Checking rejected modification status does not dispatch another effect");
  assert.equal(reviewOutcomes.length, reviewsBeforeModifyCheck, "Checking rejected modification status does not request another trade approval");
  await screenshot("rejected-modification-activity-narrow");
  coverage.push("rejected modification retains original-order cancellation evidence and offers read-only Activity refresh after notice dismissal without retry or continuation");

  const acceptedModifyId = "e".repeat(32);
  const acceptedModify = tradeOperation(acceptedModifyId, { kind: "modify", coin: "BTC", oid: 43, side: "sell", size: "0.01", price: "108400", reduceOnly: true, postOnly: false }, "accepted");
  savedTrades.set(acceptedModifyId, { ...acceptedModify, message: "Modification accepted; replacement status is not available yet.", modification: { checkedAt: now(), original: { coin: "BTC", oid: 43, state: "resting", venueStatus: "open" }, originalLive: true, replacementLive: null, errors: [] } });
  await refresh();
  const acceptedModifyRow = page.locator(".hl-activity").filter({ hasText: acceptedModifyId });
  const effectsBeforeFailedCheck = effects.length, reviewsBeforeFailedCheck = reviewOutcomes.length;
  failingReconciliationId = acceptedModifyId;
  await acceptedModifyRow.getByRole("button", { name: "Check status", exact: true }).click();
  await page.locator(".hl-execution-error").getByText("Temporary venue status read failure.", { exact: true }).waitFor();
  failingReconciliationId = null;
  const filledModifyMessage = "Replacement filled. Original order 43 is canceled and no longer working.";
  savedTrades.set(acceptedModifyId, { ...tradeOperation(acceptedModifyId, acceptedModify.intent, "filled"), message: filledModifyMessage, modification: { checkedAt: now(), original: { coin: "BTC", oid: 43, state: "canceled", venueStatus: "canceled" }, originalLive: false, replacementLive: false, errors: [] } });
  await waitEnabled(page, page.locator(".hl-execution").getByRole("button", { name: "Check status", exact: true }));
  await page.locator(".hl-execution").getByRole("button", { name: "Check status", exact: true }).click();
  await page.locator(".hl-execution").getByText(filledModifyMessage, { exact: true }).waitFor();
  assert.equal(await page.locator(".hl-execution-error").count(), 0, "A successful same-ID status refresh clears the previous read failure styling");
  assert.equal(await page.locator(".hl-execution").getByText("Temporary venue status read failure.", { exact: true }).count(), 0, "An old read error must not hide newly confirmed order outcomes");
  assert.equal(effects.length, effectsBeforeFailedCheck, "Recovering a status read does not dispatch another trade");
  assert.equal(reviewOutcomes.length, reviewsBeforeFailedCheck, "Recovering a status read does not request another approval");
  coverage.push("a transient modification-status failure clears when same-ID reconciliation confirms filled replacement and canceled original");

  const trackingId = "f".repeat(32), trackingMessage = "Modification accepted; awaiting the replacement order outcome.";
  const trackingAccepted = { ...acceptedModify, operationId: trackingId, message: trackingMessage, modification: { checkedAt: now(), original: { coin: "BTC", oid: 43, state: "resting", venueStatus: "open" }, originalLive: true, replacementLive: null, errors: [] } };
  const trackingFilled = { ...tradeOperation(trackingId, acceptedModify.intent, "filled"), message: "Tracked replacement filled; original canceled.", modification: { checkedAt: now(), original: { coin: "BTC", oid: 43, state: "canceled", venueStatus: "canceled" }, originalLive: false, replacementLive: false, errors: [] } };
  savedTrades.set(trackingId, trackingAccepted);
  const trackingOriginalUnknown = { ...trackingFilled, message: "Replacement filled; original order status is not available yet.", modification: { ...trackingFilled.modification, originalLive: null } };
  reconciliationResponses.set(trackingId, [trackingAccepted, trackingAccepted, trackingOriginalUnknown, trackingFilled]);
  await refresh();
  const trackingRow = page.locator(".hl-activity").filter({ hasText: trackingId });
  assert.equal(await trackingRow.locator(".hl-badge.hl-positive").count(), 0, "An unresolved acceptance does not receive completed-outcome styling");
  const trackingEffects = effects.length, trackingReviews = reviewOutcomes.length;
  await trackingRow.getByRole("button", { name: "Check status", exact: true }).click();
  await page.waitForFunction(id => window.fixtureReconcileResults?.[id] >= 2, trackingId);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(calls.filter(entry => entry.call.name === "hl_reconcile_v1" && entry.call.arguments.operationId === trackingId).length, 2, "The immediate follow-up does not loop while acceptance is unchanged");
  assert.equal(await page.getByRole("button", { name: "Refresh market and account", exact: true }).isEnabled(), true, "Read-only tracking leaves the UI responsive");
  await page.evaluate(() => window.fixturePoll());
  await page.locator(".hl-execution").getByText(trackingOriginalUnknown.message, { exact: true }).waitFor();
  await trackingRow.getByText(trackingOriginalUnknown.message, { exact: true }).waitFor();
  await trackingRow.getByRole("button", { name: "Check status", exact: true }).waitFor();
  assert.equal(await trackingRow.getByRole("button", { name: "Continue saved trade", exact: true }).count(), 0, "A filled replacement with unresolved original evidence only offers a read check");
  assert.equal(await trackingRow.getByRole("button", { name: "Retry saved request", exact: true }).count(), 0, "Missing original-order evidence never authorizes replay of a filled replacement");
  await page.evaluate(() => window.fixturePoll());
  await page.locator(".hl-execution").getByText(trackingFilled.message, { exact: true }).waitFor();
  await trackingRow.getByText(trackingFilled.message, { exact: true }).waitFor();
  assert.equal(effects.length, trackingEffects, "Automatic status tracking does not dispatch or retry a trade");
  assert.equal(reviewOutcomes.length, trackingReviews, "Automatic status tracking does not prompt for trade approval");
  await page.evaluate(() => window.fixturePoll());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(calls.filter(entry => entry.call.name === "hl_reconcile_v1" && entry.call.arguments.operationId === trackingId).length, 4, "A proven outcome stops automatic tracking");

  const dismissedTrackingId = "c".repeat(32), dismissedAccepted = { ...trackingAccepted, operationId: dismissedTrackingId, message: "Awaiting a delayed order status." };
  let releaseDelayedStatus, delayedStatusStarted;
  const delayedStatus = new Promise(resolve => { releaseDelayedStatus = resolve; });
  const delayedStarted = new Promise(resolve => { delayedStatusStarted = resolve; });
  savedTrades.set(dismissedTrackingId, dismissedAccepted);
  reconciliationResponses.set(dismissedTrackingId, [dismissedAccepted, () => { delayedStatusStarted(); return delayedStatus; }]);
  await refresh();
  await page.locator(".hl-activity").filter({ hasText: dismissedTrackingId }).getByRole("button", { name: "Check status", exact: true }).click();
  await delayedStarted;
  await page.evaluate(() => window.fixturePoll());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(calls.filter(entry => entry.call.name === "hl_reconcile_v1" && entry.call.arguments.operationId === dismissedTrackingId).length, 2, "A refresh tick does not interrupt or duplicate a slow in-flight status read");
  await page.getByRole("button", { name: "Dismiss operation status", exact: true }).click();
  releaseDelayedStatus({ ...trackingFilled, operationId: dismissedTrackingId });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator(".hl-execution").count(), 0, "A late automatic status result cannot reopen a dismissed notice");
  assert.equal(effects.length, trackingEffects, "Dismissal and late observation do not replay the modification");
  coverage.push("accepted modifications receive immediate read-only follow-up and existing-clock reconciliation without blocking UI or retrying effects", "settled outcomes stop automatic reads and dismissed notices cannot be reopened by delayed responses");

  await nav("Orders").click();
  const transfer = () => page.getByRole("button", { name: /Transfer USDC/ }).first().click();
  await transfer();
  await waitEnabled(page, dialog().getByRole("button", { name: "Max", exact: true }));
  await dialog().getByRole("button", { name: "Max", exact: true }).click();
  assert.equal(await dialog().getByLabel("USDC amount", { exact: true }).inputValue(), "250.123456", "Deposit Max preserves the whole source USDC balance to six decimals");
  await dialog().getByRole("slider", { name: "Transfer allocation", exact: true }).fill("75");
  assert.equal(await dialog().getByLabel("USDC amount", { exact: true }).inputValue(), "187.592592");
  await dialog().getByLabel("Transfer network", { exact: true }).selectOption("42161");
  assert.equal(await dialog().getByLabel("USDC amount", { exact: true }).inputValue(), "", "Switching source networks clears the previous allocation");
  await waitEnabled(page, dialog().getByRole("button", { name: "Max", exact: true }));
  await dialog().getByRole("button", { name: "Max", exact: true }).click();
  assert.equal(await dialog().getByLabel("USDC amount", { exact: true }).inputValue(), "77.123456");
  await dialog().getByLabel("Transfer network", { exact: true }).selectOption("1");
  coverage.push("deposit allocation uses the selected source network balance and clears stale amounts on route changes");
  await dialog().getByLabel("USDC amount", { exact: true }).fill("125.123456");
  await waitEnabled(page, dialog().getByRole("button", { name: "Review deposit", exact: true }));
  await dialog().getByText("125.123456 USDC", { exact: true }).waitFor();
  await dialog().getByText("0.25 USDC", { exact: true }).waitFor();
  await dialog().getByText("0.00015 ETH", { exact: true }).waitFor();
  await screenshot("deposit-preview-narrow");
  await dialog().getByRole("button", { name: "Review deposit", exact: true }).click();
  await page.getByText(/Source burn confirmed\. Waiting for Circle/).first().waitFor();
  assert.equal(effects.at(-1).arguments.amount, "125.123456"); assert.equal(effects.at(-1).arguments.chainId, "1");
  assert.equal(effects.at(-1).arguments.direction, "deposit");
  await transfer(); await dialog().getByRole("button", { name: "Withdraw", exact: true }).click();
  await waitEnabled(page, dialog().getByRole("button", { name: "Max", exact: true }));
  await dialog().getByRole("button", { name: "Max", exact: true }).click();
  assert.equal(await dialog().getByLabel("USDC amount", { exact: true }).inputValue(), "42.987654", "Withdrawal Max uses the independently observed funding capacity");
  await dialog().getByLabel("USDC amount", { exact: true }).fill("50.000001");
  await waitEnabled(page, dialog().getByRole("button", { name: "Review withdraw", exact: true }));
  await screenshot("withdraw-preview-narrow");
  await dialog().getByRole("button", { name: "Review withdraw", exact: true }).click();
  await dialog().waitFor({ state: "hidden" });
  await page.waitForFunction(() => !document.querySelector(".hl-execution")?.textContent.includes("Following your request"));
  assert.equal(effects.at(-1).arguments.direction, "withdraw"); assert.equal(effects.at(-1).arguments.chainId, "1");
  assert.equal(effects.at(-1).arguments.amount, "50.000001");
  coverage.push("Ethereum deposit and withdrawal previews", "six-decimal USDC inputs", "source confirmation remains pending destination credit");
  let releaseFunding;
  fundingEffectGate = new Promise(resolve => { releaseFunding = resolve; });
  const effectsBeforePending = effects.length;
  await transfer(); await dialog().getByLabel("USDC amount", { exact: true }).fill("10");
  await waitEnabled(page, dialog().getByRole("button", { name: "Review deposit", exact: true }));
  await dialog().getByRole("button", { name: "Review deposit", exact: true }).click();
  await page.getByText("You can close this. Follow it in Activity.", { exact: true }).waitFor();
  assert.equal(effects.length, effectsBeforePending + 1);
  await page.getByRole("button", { name: "Dismiss operation status", exact: true }).click();
  assert.equal(await page.locator(".hl-execution").count(), 0, "A pending transfer notification is dismissible");
  await nav("Activity").click();
  await page.locator(".hl-activity").filter({ hasText: "Deposit 10 USDC" }).waitFor();
  assert.equal(effects.length, effectsBeforePending + 1, "Dismissal and Activity navigation do not dispatch another transfer");
  const resultCount = await page.evaluate(() => window.fixtureToolResults.hl_funding_execute_v1 ?? 0);
  fundingEffectGate = null; releaseFunding();
  await page.waitForFunction(count => (window.fixtureToolResults.hl_funding_execute_v1 ?? 0) > count, resultCount);
  assert.equal(await page.locator(".hl-execution").count(), 0, "A dismissed transfer notice stays dismissed after its pending request completes");
  assert.equal(effects.length, effectsBeforePending + 1, "A transfer keeps the same effect after its notice is closed");
  coverage.push("pending transfer notification can close without canceling or replaying funding", "in-flight transfer remains visible in Activity and late completion does not reopen dismissed notice");


  await nav("Activity").click();
  await page.getByText("Activity & recovery", { exact: true }).waitFor();
  await page.locator(".hl-activity").filter({ hasText: "response was lost" }).waitFor();
  await screenshot("activity-recovery-narrow");
  const effectCount = effects.length;
  await page.locator(".hl-activity").filter({ hasText: "response was lost" }).getByRole("button", { name: "Check status", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".hl-execution")?.textContent.includes("Following your request"));
  assert.equal(effects.length, effectCount, "Reconciliation does not dispatch another trade or transfer");
  assert(calls.some(entry => entry.call.name === "hl_reconcile_v1" && entry.call.arguments.operationId === "5".repeat(32)));
  await page.reload(); await nav("Activity").click();
  await page.locator(".hl-activity").filter({ hasText: "response was lost" }).waitFor();
  assert.equal(effects.length, effectCount, "Reload does not replay an effect");
  await page.locator(".hl-activity").filter({ hasText: "response was lost" }).getByRole("button", { name: "Retry saved request", exact: true }).click();
  await approve();
  assert.equal(effects.at(-1).name, "hl_retry_trade_v1"); assert.equal(effects.at(-1).arguments.operationId, "5".repeat(32), "Explicit retry retains the same trade operation ID");
  const transferRow = page.locator(".hl-activity").filter({ hasText: "Deposit 125.123456 USDC" });
  await transferRow.getByRole("button", { name: "Continue transfer", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".hl-execution")?.textContent.includes("Following your request"));
  assert.equal(effects.at(-1).name, "hl_funding_execute_v1");
  assert.equal(effects.at(-1).arguments.operationId, [...savedFunding.keys()][0], "Continuing transfer retains its original burn operation");
  coverage.push("saved trade and funding activity", "uncertain order reconciliation retains operation ID", "reload reads saved status without replay");
  coverage.push("explicit saved-trade retry and funding continuation reuse their original operation IDs");
  for (const [state, id, intent] of [
    ["prepared", "8".repeat(32), { kind: "order", coin: "BTC", side: "buy", orderType: "limit", size: "0.01001", price: "90000", reduceOnly: false, postOnly: true }],
    ["signed", "9".repeat(32), { kind: "close", coin: "ETH", size: "0.15", slippageBps: 75 }],
  ]) {
    const message = `Interrupted ${state} owner trade`;
    savedTrades.set(id, { ...tradeOperation(id, intent, state), ownedByCaller: true, message });
    await refresh();
    const row = page.locator(".hl-activity").filter({ hasText: message });
    await row.getByRole("button", { name: "Continue saved trade", exact: true }).click();
    await dialog().getByRole("button", { name: "Approve action", exact: true }).waitFor();
    const beforeApprove = effects.length;
    await dialog().getByRole("button", { name: "Decline", exact: true }).click();
    await dialog().waitFor({ state: "hidden" });
    await page.waitForFunction(() => !document.querySelector(".hl-execution")?.textContent.includes("Following your request"));
    assert.equal(effects.length, beforeApprove, "Continuing a saved trade still requires owner approval");
    await row.getByRole("button", { name: "Continue saved trade", exact: true }).click();
    await approve();
    const { kind, ...args } = intent;
    assert.equal(effects.at(-1).name, kind === "order" ? "hl_place_order_v1" : "hl_close_position_v1");
    assert.deepEqual(effects.at(-1).arguments, { ...args, environment: "mainnet", operationId: id }, "Activity resumes the exact original ID and intent through its existing effect tool");
  }
  const otherId = "a".repeat(32);
  savedTrades.set(otherId, { ...tradeOperation(otherId, { kind: "order", coin: "SOL", side: "buy", orderType: "limit", size: "1", price: "100" }, "prepared"), ownedByCaller: false, caller: { appId: "agent", installationUid: "2", role: "background" }, message: "Prepared Agent-owned trade" });
  await refresh();
  const agentRow = page.locator(".hl-activity").filter({ hasText: "Prepared Agent-owned trade" });
  await agentRow.waitFor();
  assert.equal(await agentRow.getByRole("button", { name: "Continue saved trade", exact: true }).count(), 0, "The owner tile cannot adopt an Agent's prepared trade identity");
  coverage.push("prepared and signed owner trades resume their exact IDs and inputs through fresh owner review", "declining saved-trade review sends no effect", "Agent-owned trades cannot be continued as the human tile");

  const recoveryDepositId = [...savedFunding.keys()][0], recoveryWithdrawId = [...savedFunding.keys()][1];
  const depositForRecovery = savedFunding.get(recoveryDepositId);
  const recoveryBase = { status: "ready", methods: ["wallet"], chainId: "999", gasSymbol: "HYPE", transactionHash: null, walletStatus: null, message: "The attested transfer can be completed on its destination network." };
  savedFunding.set(recoveryDepositId, { ...depositForRecovery, recovery: recoveryBase });
  await refresh();
  const depositRecoveryRow = page.locator(".hl-activity").filter({ hasText: "Deposit 125.123456 USDC" });
  await depositRecoveryRow.getByRole("button", { name: "Complete transfer", exact: true }).waitFor();
  await depositRecoveryRow.getByText(/HyperEVM transaction fees are paid in HYPE/).waitFor();
  assert.equal(await depositRecoveryRow.getByRole("button", { name: "Continue transfer", exact: true }).count(), 0, "An attested recovery presents one completion path instead of another deposit continuation");
  const depositCallsBeforeRecovery = effects.filter(call => call.name === "hl_funding_execute_v1").length;
  await depositRecoveryRow.getByRole("button", { name: "Complete transfer", exact: true }).click();
  await page.locator(".hl-execution").getByRole("button", { name: "Continue recovery", exact: true }).waitFor();
  assert.equal(effects.at(-1).name, "hl_funding_recover_v1");
  assert.equal(effects.at(-1).arguments.operationId, recoveryDepositId);
  assert.equal(effects.at(-1).arguments.method, "wallet");
  await page.locator(".hl-execution").getByRole("button", { name: "Continue recovery", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".hl-execution")?.textContent.includes("Complete"));
  assert.equal(effects.at(-1).arguments.operationId, recoveryDepositId, "Continuing destination recovery retains the original source transfer ID");
  assert.equal(effects.filter(call => call.name === "hl_funding_execute_v1").length, depositCallsBeforeRecovery, "Destination recovery never requests another source deposit");
  await refresh();
  assert.equal(await depositRecoveryRow.getByRole("button", { name: "Complete transfer", exact: true }).count(), 0, "A completed transfer offers no new mint action");
  const withdrawalForRecovery = savedFunding.get(recoveryWithdrawId);
  savedFunding.set(recoveryWithdrawId, { ...withdrawalForRecovery, recovery: { ...recoveryBase, status: "waiting_attestation", methods: ["circle"], chainId: "1", gasSymbol: "ETH", message: "This expired attestation can be refreshed for the original transfer." } });
  await refresh();
  const withdrawRecoveryRow = page.locator(".hl-activity").filter({ hasText: "Withdraw 50.000001 USDC" });
  await withdrawRecoveryRow.getByRole("button", { name: "Refresh attestation", exact: true }).waitFor();
  assert.equal(await withdrawRecoveryRow.getByRole("button", { name: "Complete transfer", exact: true }).count(), 0, "An expired attestation cannot be submitted before renewal");
  await withdrawRecoveryRow.getByRole("button", { name: "Refresh attestation", exact: true }).click();
  await page.locator(".hl-execution").getByRole("button", { name: "Complete transfer", exact: true }).waitFor();
  assert.equal(effects.at(-1).arguments.operationId, recoveryWithdrawId);
  assert.equal(effects.at(-1).arguments.method, "circle");
  await page.locator(".hl-execution").getByText(/Ethereum transaction fees are paid in ETH/).waitFor();
  savedFunding.set(recoveryWithdrawId, { ...savedFunding.get(recoveryWithdrawId), recovery: { ...recoveryBase, status: "forwarded", methods: ["circle", "wallet"] } });
  await refresh();
  await page.waitForFunction(() => [...document.querySelectorAll(".hl-activity")].some(element => element.textContent.includes("Withdraw 50.000001 USDC") && !element.textContent.includes("Complete transfer") && !element.textContent.includes("Refresh attestation")));
  await screenshot("destination-recovery-narrow");
  const cashRecoveryId = [...savedFunding.keys()][2];
  savedFunding.set(cashRecoveryId, { ...savedFunding.get(cashRecoveryId), phase: "forwarded_to_core_cash", recovery: { ...recoveryBase, status: "ready", methods: ["perps"], message: "Your original deposit arrived in your Hyperliquid cash balance. Move it into perps to trade." } });
  await refresh();
  const cashRecoveryRow = page.locator(".hl-activity").filter({ hasText: "Deposit 10 USDC" });
  await cashRecoveryRow.getByRole("button", { name: "Move to perps", exact: true }).waitFor();
  assert.equal(await cashRecoveryRow.getByText(/transaction fees are paid in/).count(), 0, "Moving proven cash fallback into perps does not claim a native-network gas cost");
  assert.equal(await cashRecoveryRow.getByRole("button", { name: "Complete transfer", exact: true }).count(), 0, "Already-minted cash fallback cannot be re-minted");
  await cashRecoveryRow.getByRole("button", { name: "Move to perps", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".hl-execution")?.textContent.includes("Complete"));
  assert.equal(effects.at(-1).name, "hl_funding_recover_v1");
  assert.equal(effects.at(-1).arguments.operationId, cashRecoveryId);
  assert.equal(effects.at(-1).arguments.method, "perps");
  assert.equal(effects.filter(call => call.name === "hl_funding_execute_v1").length, depositCallsBeforeRecovery);
  coverage.push("proven cash-balance fallback offers Move to perps using the original deposit ID and no new deposit or mint");
  coverage.push("attested destination completion and exact-request continuation use only original transfer ID and method", "destination recovery never starts a new source deposit", "HyperEVM recovery explains HYPE gas and Ethereum recovery explains ETH gas", "Circle attestation renewal is offered only for an eligible attestation status", "completed and already-forwarded transfers offer no remint action");

  nextFundingPhase = "forwarded_to_core";
  await transfer(); await dialog().getByLabel("USDC amount", { exact: true }).fill("19");
  await waitEnabled(page, dialog().getByRole("button", { name: "Review deposit", exact: true }));
  await dialog().getByRole("button", { name: "Review deposit", exact: true }).click();
  await page.locator(".hl-execution strong").filter({ hasText: "Forwarded" }).waitFor();
  const forwardedId = effects.at(-1).arguments.operationId;
  assert.equal(savedFunding.get(forwardedId).state, "pending", "Forwarded display does not pretend exact Core credit linkage is complete");
  assert.equal(await page.locator(".hl-execution").getByRole("button", { name: "Continue transfer", exact: true }).count(), 0, "A forwarded deposit notice offers no redundant transfer execution");
  await page.getByRole("button", { name: "Dismiss operation status", exact: true }).click();
  await nav("Activity").click();
  const forwardedRow = page.locator(".hl-activity").filter({ hasText: "Deposit 19 USDC" });
  await forwardedRow.locator(".hl-badge").getByText("Forwarded", { exact: true }).waitFor();
  assert.equal(await forwardedRow.getByRole("button", { name: "Continue transfer", exact: true }).count(), 0, "A forwarded saved deposit offers tracking instead of another execution");
  await forwardedRow.getByRole("button", { name: "Check status", exact: true }).waitFor();
  coverage.push("forwarded Core deposits remain machine-pending but display Forwarded with status checks and no repeat transfer action");

  fundingPageSize = 2;
  await refresh();
  await page.getByRole("button", { name: "Load older transfers", exact: true }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll("button")].some(button => button.textContent === "Loading activity…"));
  await refresh();
  await page.getByRole("button", { name: "Load older transfers", exact: true }).waitFor();
  assert.equal(calls.filter(entry => entry.call.name === "hl_activity_v1").at(-1).call.arguments.cursor, undefined, "Explicit refresh returns to the newest Activity page");
  await page.getByRole("button", { name: "Load older transfers", exact: true }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll("button")].some(button => button.textContent === "Loading activity…"));
  await transfer(); await dialog().getByLabel("USDC amount", { exact: true }).fill("99");
  await waitEnabled(page, dialog().getByRole("button", { name: "Review deposit", exact: true }));
  await dialog().getByRole("button", { name: "Review deposit", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".hl-execution")?.textContent.includes("Following your request"));
  await page.getByRole("button", { name: "Dismiss operation status", exact: true }).click();
  await page.locator(".hl-activity").filter({ hasText: "Deposit 99 USDC" }).waitFor();
  assert.equal(calls.filter(entry => entry.call.name === "hl_activity_v1").at(-1).call.arguments.cursor, undefined, "A newly saved transfer refreshes newest Activity even after browsing older pages");
  fundingPageSize = null;
  await refresh();
  coverage.push("explicit refresh and local effect completion return Activity to the newest saved transfers after pagination");

  await nav("Trade").click(); await panel("Order");
  missingKey = true; await refresh();
  await page.locator(".hl-enable-trading").waitFor();
  await page.locator(".hl-enable-trading").click();
  await dialog().getByRole("button", { name: "Enable trading", exact: true }).waitFor();
  await screenshot("trading-setup-narrow");
  await page.keyboard.press("Escape"); await dialog().waitFor({ state: "hidden" });
  assert(await page.locator(".hl-enable-trading").evaluate(element => element === document.activeElement), "Escape restores focus to setup trigger");
  const rejectedCaller = await page.evaluate(async () => {
    try { await window.fixtureRequestReview({ title: "Untrusted review" }, { caller: { appId: "another-app", installationUid: "2", role: "background", endpoint: "app:another-app:background" } }); return false; }
    catch { return true; }
  });
  assert.equal(rejectedCaller, true, "Review handler rejects a caller outside the Hyperliquid app");
  coverage.push("missing trading-key setup", "Escape closes modal and restores focus", "actual owner-review handler rejects untrusted caller");

  assert.equal(await page.getByLabel("Hyperliquid network", { exact: true }).count(), 0, "The production UI has no environment selector");
  assert(calls.every(entry => !entry.call.arguments?.environment || entry.call.arguments.environment === "mainnet"), "All UI requests use mainnet");
  pendingKey = true; await refresh();
  await page.getByRole("button", { name: "Continue trading setup", exact: true }).waitFor();
  const setupTop = await page.locator(".hl-enable-trading").evaluate(element => element.getBoundingClientRect().top + scrollY);
  assert(setupTop < 70, `Trading access remains prominent at the top: ${setupTop}px`);
  pendingKey = false; missingKey = false; await refresh();
  await page.getByRole("button", { name: "Trading access enabled", exact: true }).waitFor();
  coverage.push("mainnet-only production UI", "prominent top-level enable trading and pending-setup recovery actions");

  const overviewStat = label => page.locator(".hl-overview .hl-stat").filter({ hasText: label }).locator("strong");
  const waitOverview = (label, value) => page.waitForFunction(([label, value]) => [...document.querySelectorAll(".hl-overview .hl-stat")].some(element => element.querySelector(":scope > span")?.textContent === label && element.querySelector("strong")?.textContent === value), [label, value]);
  accountMode = "unified"; await refresh(); await waitOverview("Shared USDC", "9,876.54");
  assert.equal(await overviewStat("Shared USDC").getAttribute("title"), "9876.543210 USDC", "Shared collateral uses the exact raw USDC total, without adding position P&L or other tokens");
  assert.equal(await overviewStat("Withdrawable").innerText(), "—", "Perps withdrawal capacity is not reused for shared collateral");
  assert.equal(await page.locator(".hl-overview").getByText("Perps equity", { exact: true }).count(), 0);
  await screenshot("unified-usdc-balance-narrow");
  accountMode = "unified_missing"; await refresh(); await waitOverview("Shared USDC", "—");
  assert.equal(await overviewStat("Withdrawable").innerText(), "—", "Failed shared balance read does not fall back to perps amounts");
  accountMode = "unified_empty"; await refresh(); await waitOverview("Shared USDC", "0");
  assert.equal(await overviewStat("Shared USDC").getAttribute("title"), "0 USDC", "A successful empty unified balance is distinguishable from an unavailable read");
  accountMode = "unknown"; await refresh(); await waitOverview("Perps equity", "$18,467.38");
  assert.equal(await page.locator(".hl-overview").getByText("Shared USDC", { exact: true }).count(), 0, "Unknown account mode cannot present a shared-collateral total");
  assert.equal(await overviewStat("Withdrawable").innerText(), "—", "Unknown account mode does not imply zero or known withdrawable collateral");
  await screenshot("unknown-account-mode-narrow");
  accountMode = "empty"; missingKey = true;
  await page.setViewportSize({ width: 320, height: 900 }); await page.reload();
  await waitOverview("Perps equity", "$0.00");
  assert.equal(await overviewStat("Withdrawable").innerText(), "$0.00", "A fully observed empty account can show zero withdrawable without guessing its balance mode");
  await page.locator(".hl-enable-trading").waitFor();
  const initialChart = page.getByRole("img", { name: /^BTC candlestick price chart/ });
  await initialChart.waitFor();
  assert(await initialChart.evaluate(element => element.getBoundingClientRect().top + scrollY <= 405), "A new account starts on a visible chart with the setup action above it");
  assert.equal(await page.getByText(/The account balance mode is not resolved/).count(), 0, "An unfunded account does not show internal balance-mode warnings");
  assert.equal(await page.getByRole("button", { name: "Account balance details", exact: true }).count(), 0, "The account-details popup is removed while the balance bar remains");
  await screenshot("empty-account-chart-first-narrow");
  missingKey = false;
  coverage.push("unfunded account starts on chart with visible top trading-access action", "unfunded account keeps its balances without an account popup or technical balance-mode warnings");
  accountMode = "perps"; await refresh(); await waitOverview("Withdrawable", "$12,984.27");
  coverage.push("unified account shows raw shared USDC with exact precision in its title, without adding perps P&L or other tokens", "missing shared balances stay unavailable while a successful empty balance shows zero", "unknown account mode labels only perps equity and leaves withdrawal capacity unavailable");

  wholeAccountFailure = true;
  await refresh();
  await page.getByRole("alert").filter({ hasText: "Showing previous account data." }).waitFor();
  await nav("Positions").click();
  assert.equal(await page.locator(".hl-position").count(), positions.length, "Previous positions remain available with an explicit stale observation label");
  assert.equal(await overviewStat("Perps equity").innerText(), "$18,467.38");
  await screenshot("cached-account-refresh-failure-narrow");
  wholeAccountFailure = false; await refresh();
  await page.getByRole("alert").filter({ hasText: "Showing previous account data." }).waitFor({ state: "hidden" });
  coverage.push("failed account refresh visibly labels cached balances and positions until fresh observations recover");

  wholeAccountFailure = true;
  await page.reload();
  await nav("Positions").click(); await page.getByRole("heading", { name: "Positions unavailable", exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "No open positions", exact: true }).count(), 0, "A failed initial account request is not an empty portfolio");
  assert.equal(await overviewStat("Perps equity").innerText(), "—");
  assert.equal(await overviewStat("Unrealized P&L").innerText(), "—");
  await nav("Orders").click(); await page.getByRole("heading", { name: "Orders unavailable", exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "No open orders", exact: true }).count(), 0);
  await screenshot("whole-account-request-failure-narrow");
  wholeAccountFailure = false;
  await refresh();
  await waitOverview("Perps equity", "$18,467.38");
  coverage.push("whole account request failures with no cached data show unavailable positions and orders rather than empty balances");

  incompleteAccount = true; await refresh(); await nav("Positions").click();
  await page.getByRole("heading", { name: "Positions unavailable", exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "No open positions", exact: true }).count(), 0);
  assert.equal(await page.locator(".hl-overview .hl-stat").filter({ hasText: "Unrealized P&L" }).locator("strong").innerText(), "—", "Unavailable positions do not display zero P&L");
  await nav("Orders").click(); await page.getByRole("heading", { name: "Orders unavailable", exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "No open orders", exact: true }).count(), 0);
  await screenshot("account-unavailable-narrow");
  incompleteAccount = false; await refresh(); await nav("Trade").click();
  coverage.push("missing account responses remain unavailable instead of showing empty positions or zero P&L");

  await panel("Order"); await page.getByLabel("Size", { exact: true }).fill("0.01");
  await waitEnabled(page, page.getByRole("button", { name: "Review long", exact: true }));
  failingReads = true; await refresh();
  await page.getByRole("alert").filter({ hasText: "fixture provider disconnected" }).first().waitFor();
  assert(await page.getByRole("button", { name: "Review long", exact: true }).isDisabled(), "Failed order preview cannot enable review");
  await panel("Chart");
  await page.locator(".hl-candles-error").filter({ hasText: "Showing the previous observation." }).waitFor();
  await screenshot("provider-error-stale-chart-narrow");
  coverage.push("provider failure retains a labeled previous observation", "failed preview disables order review");

  assert.deepEqual(errors, [], "No unhandled browser errors");
  assert.deepEqual(forbiddenNetwork, [], "No live API, RPC, signing, or external asset request in UI qualification");
  const evidence = { result: "passed", scope: "Actual React UI with fixture resident-tool responses; service, persistence, signing, contracts and live effects are tested separately.", viewports, fixtureEffects: effects.length, ownerReviews: reviewOutcomes.length, coverage };
  await writeFile(resolve(artifacts, "result.json"), JSON.stringify(evidence, null, 2) + "\n");
  await writeFile(resolve(artifacts, "calls.json"), JSON.stringify(calls, null, 2) + "\n");
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  if (page) { await page.screenshot({ path: resolve(artifacts, "failure.png"), fullPage: true }); console.error((await page.locator("body").innerText()).slice(-9000)); }
  await writeFile(resolve(artifacts, "failure.json"), JSON.stringify({ result: "failed", error: String(error), errors, calls: calls.slice(-20) }, null, 2) + "\n");
  throw error;
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
