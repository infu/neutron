import Decimal from "decimal.js";
import { getWalletAddress, signL1Action, type AbstractWallet, type Signature } from "@nktkas/hyperliquid/signing";
import { HyperliquidData, type AccountSnapshot } from "./market";
import { getTradingSigner } from "./trading_key";
import { IndexedTradingStore, tradingCallerFromScope, tradingScope, withTradingLock, type JournalRecord, type TradingBinding, type TradingCaller, type TradingStore } from "./trading_store";

const D = Decimal.clone({ precision: 80, toExpNeg: -100, toExpPos: 100 });
type Side = "buy" | "sell";
type OrderId = number | string;
export type TradeIntent =
  | { kind: "order"; coin: string; side: Side; orderType: "market" | "limit"; size: string; price?: string; slippageBps?: number; reduceOnly?: boolean; postOnly?: boolean }
  | { kind: "close"; coin: string; size?: string; slippageBps?: number }
  | { kind: "trigger"; coin: string; side: Side; size: string; triggerPrice: string; triggerKind: "tp" | "sl"; execution: "market" | "limit"; price?: string; slippageBps?: number }
  | { kind: "cancel"; coin: string; oid: OrderId }
  | { kind: "cancelAll"; coin?: string }
  | { kind: "modify"; coin: string; oid: OrderId; side: Side; size: string; price: string; postOnly?: boolean; reduceOnly?: boolean }
  | { kind: "leverage"; coin: string; leverage: number; isCross: boolean }
  | { kind: "margin"; coin: string; amountUsdc: string };
export type TradeState = "prepared" | "signed" | "submitting" | "uncertain" | "accepted" | "resting" | "filled" | "partial" | "canceled" | "rejected";
export interface TradeOrderResult {
  coin?: string;
  cloid?: string;
  oid?: number;
  state: string;
  size?: string;
  filledSize?: string;
  averagePrice?: string;
  error?: string;
  venueStatus?: string;
}
export interface TradeReview {
  title: string;
  environment: "mainnet" | "testnet";
  walletAddress: string;
  operation: TradeIntent["kind"];
  details: string[];
  [key: string]: unknown;
}
export interface TradePreview {
  review: TradeReview;
  action: Record<string, unknown>;
  orders: TradeOrderResult[];
  observedAt: number;
  warnings: string[];
}
export interface PublicTradeOperation {
  operationId: string;
  state: TradeState;
  createdAt: number;
  updatedAt: number;
  intent: TradeIntent;
  review: TradeReview;
  orders: TradeOrderResult[];
  message?: string;
  reconciliation?: { checkedAt: number; errors: string[]; accountState?: unknown };
  canRetryExact: boolean;
  caller?: TradingCaller;
  ownedByCaller?: boolean;
}
interface TradeRecord extends JournalRecord, PublicTradeOperation {
  fingerprint: string;
  action: Record<string, unknown>;
  signerAddress?: string;
  envelope?: { action: Record<string, unknown>; nonce: number; signature: Signature };
  envelopeJson?: string;
  response?: unknown;
  attempts: number;
}
export interface TradingData {
  info<T>(body: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
  account?(address: string, signal?: AbortSignal): Promise<AccountSnapshot>;
}
export interface TradingDependencies {
  binding: TradingBinding;
  caller: TradingCaller;
  authorize: (review: TradeReview) => Promise<void>;
  data?: TradingData;
  store?: TradingStore;
  signer?: () => Promise<AbstractWallet>;
  fetcher?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
}
interface Market { name: string; asset: number; szDecimals: number; maxLeverage: number; onlyIsolated?: boolean; isDelisted?: boolean; marginMode?: string }
interface WireOrder { a: number; b: boolean; p: string; s: string; r: boolean; t: { limit: { tif: "Gtc" | "Alo" | "Ioc" } } | { trigger: { isMarket: boolean; triggerPx: string; tpsl: "tp" | "sl" } }; c?: string }
interface Position { coin: string; szi: string; leverage?: { type: string; value: number }; marginUsed?: string }

function object(value: unknown): Record<string, any> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed Hyperliquid response"); return value as Record<string, any>; }
function decimal(value: string, name: string, signed = false): Decimal {
  if (typeof value !== "string" || !(signed ? /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/ : /^(?:0|[1-9]\d*)(?:\.\d+)?$/).test(value)) throw new Error(`${name} must be an exact decimal string`);
  const result = new D(value);
  if (!result.isFinite()) throw new Error(`Invalid ${name}`);
  return result;
}
function positive(value: string, name: string): Decimal { const result = decimal(value, name); if (!result.gt(0)) throw new Error(`${name} must be greater than zero`); return result; }
function side(value: Side): boolean { if (value !== "buy" && value !== "sell") throw new Error("Side must be buy or sell"); return value === "buy"; }
function orderId(value: OrderId): OrderId { if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value; if (typeof value === "string" && /^0x[0-9a-f]{32}$/i.test(value)) return value.toLowerCase(); throw new Error("Order ID must be a safe integer or 16-byte client order ID"); }
function size(value: string, market: Market): string { const n = positive(value, "Size"); if (n.decimalPlaces() > market.szDecimals) throw new Error(`${market.name} size allows ${market.szDecimals} decimal places`); return n.toFixed(); }

/** Integer prices are exempt from the venue's five-significant-figure rule. */
export function validatePerpPrice(value: string, szDecimals: number): string {
  const n = positive(value, "Price");
  if (!Number.isInteger(szDecimals) || szDecimals < 0 || szDecimals > 6) throw new Error("Invalid perpetual size precision");
  if (!n.isInteger() && (n.sd() > 5 || n.decimalPlaces() > 6 - szDecimals)) throw new Error(`Price requires at most five significant figures and ${6 - szDecimals} decimal places; integer prices are allowed`);
  return n.toFixed();
}

/** Rounding stays inside the requested slippage boundary, including penny/tick transitions. */
export function boundedMarketPrice(reference: string, isBuy: boolean, slippageBps: number, szDecimals: number): string {
  if (!Number.isFinite(slippageBps) || slippageBps < 0 || (!isBuy && slippageBps >= 10_000)) throw new Error("Slippage must be nonnegative and a sell boundary must remain positive");
  const factor = new D(1).plus(new D(slippageBps).div(10_000).mul(isBuy ? 1 : -1));
  let price = positive(reference, "Reference price").mul(factor);
  const rounding = isBuy ? D.ROUND_FLOOR : D.ROUND_CEIL;
  if (!price.isInteger()) price = price.toSignificantDigits(5, rounding).toDecimalPlaces(6 - szDecimals, rounding);
  return validatePerpPrice(price.toFixed(), szDecimals);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return "{" + Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",") + "}";
}
async function cloidFor(scope: string, operationId: string, index: number): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([scope, operationId, index])));
  return `0x${Array.from(new Uint8Array(digest).slice(0, 16), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
function publicRecord(record: TradeRecord): PublicTradeOperation {
  return structuredClone({ operationId: record.operationId, state: record.state, createdAt: record.createdAt, updatedAt: record.updatedAt, intent: record.intent, review: record.review, orders: record.orders, ...(record.message ? { message: record.message } : {}), ...(record.reconciliation ? { reconciliation: record.reconciliation } : {}), canRetryExact: record.state === "uncertain" && !!record.envelope });
}
function aggregate(orders: TradeOrderResult[], fallback: TradeState = "accepted"): TradeState {
  if (!orders.length) return fallback;
  if (orders.some(order => order.state === "unknown")) return "uncertain";
  if (orders.every(order => order.state === "rejected")) return "rejected";
  if (orders.every(order => order.state === "filled")) return "filled";
  if (orders.every(order => order.state === "canceled")) return "canceled";
  if (orders.some(order => order.state === "partial" || (order.filledSize && new D(order.filledSize).gt(0)))) return "partial";
  if (orders.every(order => order.state === "resting")) return "resting";
  return fallback;
}
function parseStatus(status: unknown, previous: TradeOrderResult): TradeOrderResult {
  if (status === "success") return { ...previous, state: "canceled", venueStatus: "canceled" };
  if (status === "waitingForFill" || status === "waitingForTrigger") return { ...previous, state: "resting", venueStatus: status };
  if (!status || typeof status !== "object") return { ...previous, state: "unknown", error: "Unrecognized exchange order status" };
  const row = object(status);
  if (typeof row.error === "string") return { ...previous, state: "rejected", error: row.error };
  if (row.resting && Number.isSafeInteger(row.resting.oid)) return { ...previous, state: "resting", oid: row.resting.oid };
  if (row.filled && Number.isSafeInteger(row.filled.oid)) {
    const total = decimal(row.filled.totalSz, "Filled size");
    return { ...previous, state: previous.size && total.lt(previous.size) ? "partial" : "filled", venueStatus: "filled", oid: row.filled.oid, filledSize: total.toFixed(), averagePrice: positive(row.filled.avgPx, "Average fill price").toFixed() };
  }
  return { ...previous, state: "unknown", error: "Unrecognized exchange order status" };
}

export function createTradingEngine(dependencies: TradingDependencies) {
  const binding = { ...dependencies.binding, walletAddress: dependencies.binding.walletAddress.toLowerCase() };
  const scope = tradingScope(binding, dependencies.caller);
  const store = dependencies.store ?? new IndexedTradingStore();
  const data = dependencies.data ?? new HyperliquidData(binding.environment);
  const signer = dependencies.signer ?? (() => getTradingSigner(binding, dependencies.signal ? { signal: dependencies.signal } : {}));
  const fetcher = dependencies.fetcher ?? globalThis.fetch.bind(globalThis);
  const now = dependencies.now ?? Date.now;
  const signal = dependencies.signal;
  function assertLive() { signal?.throwIfAborted(); }
  function info<T>(body: Record<string, unknown>): Promise<T> { assertLive(); return data.info<T>(body, signal); }
  const exchange = `${binding.environment === "mainnet" ? "https://api.hyperliquid.xyz" : "https://api.hyperliquid-testnet.xyz"}/exchange`;
  function key(operationId: string): string { if (!/^[0-9a-f]{32}$/i.test(operationId)) throw new Error("operationId must be a 32-character hexadecimal request ID"); return `${scope}:${operationId.toLowerCase()}`; }
  async function save(record: TradeRecord, changes: Partial<TradeRecord>): Promise<TradeRecord> {
    const next = { ...record, ...changes, updatedAt: now(), revision: record.revision + 1 };
    await store.update(next, record.revision);
    return next;
  }
  async function requireRecord(operationId: string): Promise<TradeRecord> { const row = await store.get(key(operationId)); if (!row) throw new Error("Unknown operation for this wallet, environment and caller"); return row as TradeRecord; }
  async function markets(): Promise<Market[]> {
    const meta = object(await info({ type: "meta" }));
    if (!Array.isArray(meta.universe)) throw new Error("Perpetual metadata is unavailable");
    return meta.universe.map((entry: unknown, asset: number) => {
      const market = object(entry);
      if (typeof market.name !== "string" || !Number.isInteger(market.szDecimals) || market.szDecimals < 0 || market.szDecimals > 6 || !Number.isInteger(market.maxLeverage) || market.maxLeverage < 1) throw new Error("Invalid perpetual metadata");
      return { ...market, asset } as Market;
    });
  }
  async function position(coin: string): Promise<Position> {
    const state = object(await info({ type: "clearinghouseState", user: binding.walletAddress }));
    if (!Array.isArray(state.assetPositions)) throw new Error("Position state is unavailable");
    const found = state.assetPositions.map((entry: unknown) => object(object(entry).position) as Position).find((entry: Position) => entry.coin === coin);
    if (!found || decimal(found.szi, "Position size", true).isZero()) throw new Error(`No open ${coin} position`);
    return found;
  }
  async function preview(intent: TradeIntent): Promise<TradePreview> {
    const [universe, accountResult] = await Promise.all([
      markets(),
      data.account ? data.account(binding.walletAddress, signal).then(value => ({ value, error: null as string | null })).catch(error => ({ value: null, error: String(error instanceof Error ? error.message : error) })) : Promise.resolve({ value: null, error: "Account observations are unavailable from this data provider" }),
    ]);
    assertLive();
    const market = intent.coin ? universe.find(entry => entry.name === intent.coin) : undefined;
    if (intent.kind !== "cancelAll" && !market) throw new Error("Unknown default perpetual market; spot and builder-deployed markets are not supported");
    if (intent.coin && !market) throw new Error("Unknown default perpetual market");
    const review: TradeReview = { title: "Hyperliquid perpetuals", environment: binding.environment, walletAddress: binding.walletAddress, operation: intent.kind, details: [], ...(intent.coin ? { coin: intent.coin } : {}) };
    const warnings: string[] = [];
    let action: Record<string, unknown>;
    const orders: TradeOrderResult[] = [];
    if (intent.kind === "cancel" || intent.kind === "cancelAll") {
      if (intent.kind === "cancel" && typeof orderId(intent.oid) === "string") {
        action = { type: "cancelByCloid", cancels: [{ asset: market!.asset, cloid: orderId(intent.oid) }] };
        orders.push({ coin: market!.name, cloid: String(orderId(intent.oid)), state: "prepared" });
      } else {
        let cancels: { a: number; o: number }[];
        if (intent.kind === "cancel") { const oid = orderId(intent.oid) as number; cancels = [{ a: market!.asset, o: oid }]; orders.push({ coin: market!.name, oid, state: "prepared" }); }
        else {
          const open = await info<unknown>({ type: "openOrders", user: binding.walletAddress });
          if (!Array.isArray(open)) throw new Error("Open orders are unavailable");
          cancels = open.flatMap(entry => {
            const order = object(entry);
            const found = universe.find(item => item.name === order.coin);
            if (!found || (intent.coin && order.coin !== intent.coin)) return [];
            const oid = orderId(order.oid) as number;
            orders.push({ coin: found.name, oid, state: "prepared" });
            return [{ a: found.asset, o: oid }];
          });
        }
        action = { type: "cancel", cancels };
      }
      review.title = intent.kind === "cancelAll" ? `Cancel ${orders.length} open perpetual orders` : `Cancel ${intent.coin} order`;
      review.orders = orders.map(({ coin, oid, cloid }) => ({ coin, ...(oid !== undefined ? { oid } : { cloid }) }));
      review.details.push("Only the displayed orders are canceled. Orders filled before cancellation remain filled.");
    } else if (intent.kind === "leverage") {
      if (!Number.isInteger(intent.leverage) || intent.leverage < 1 || intent.leverage > market!.maxLeverage) throw new Error(`Leverage must be an integer from 1 to the venue maximum ${market!.maxLeverage}`);
      if (typeof intent.isCross !== "boolean") throw new Error("Margin mode is required");
      if (market!.onlyIsolated && intent.isCross) throw new Error("This perpetual supports isolated margin only");
      action = { type: "updateLeverage", asset: market!.asset, isCross: intent.isCross, leverage: intent.leverage };
      Object.assign(review, { title: `Set ${intent.coin} leverage`, leverage: intent.leverage, marginMode: intent.isCross ? "cross" : "isolated" });
      review.details.push("This changes the market's margin configuration. Higher leverage increases liquidation sensitivity; the venue enforces the position's margin tier.");
    } else if (intent.kind === "margin") {
      const amount = decimal(intent.amountUsdc, "Margin change", true);
      if (amount.isZero() || amount.decimalPlaces() > 6) throw new Error("Margin change must be nonzero with at most six USDC decimal places");
      const atomic = amount.mul(1_000_000);
      if (!atomic.isInteger() || !Number.isSafeInteger(atomic.toNumber())) throw new Error("Margin change exceeds the exchange integer representation");
      const current = await position(market!.name);
      if (current.leverage?.type !== "isolated") throw new Error("Margin can only be adjusted on an isolated position");
      action = { type: "updateIsolatedMargin", asset: market!.asset, isBuy: true, ntli: atomic.toNumber() };
      Object.assign(review, { title: `${amount.gt(0) ? "Add" : "Remove"} ${intent.coin} isolated margin`, amountUsdc: amount.toFixed(), currentMarginUsed: current.marginUsed });
      review.details.push("Removing margin reduces the position's liquidation buffer. The venue validates available collateral.");
    } else {
      if (market!.isDelisted) throw new Error("This perpetual is delisted");
      let buy: boolean;
      let amount: string;
      let reduceOnly: boolean;
      if (intent.kind === "close") {
        const current = await position(market!.name);
        const signedSize = decimal(current.szi, "Position size", true);
        buy = signedSize.lt(0);
        amount = size(intent.size ?? signedSize.abs().toFixed(), market!);
        if (new D(amount).gt(signedSize.abs())) throw new Error("Close size exceeds the current position");
        reduceOnly = true;
        review.positionSize = signedSize.toFixed();
      } else {
        buy = side(intent.side); amount = size(intent.size, market!); reduceOnly = intent.kind === "trigger" ? true : !!intent.reduceOnly;
      }
      const isMarket = intent.kind === "close" || (intent.kind === "order" && intent.orderType === "market") || (intent.kind === "trigger" && intent.execution === "market");
      if (intent.kind === "order" && intent.orderType !== "market" && intent.orderType !== "limit") throw new Error("Order type must be market or limit");
      if (intent.kind === "order" && intent.postOnly && isMarket) throw new Error("A market order cannot be post-only");
      let limitPrice: string;
      let triggerPrice: string | undefined;
      if (intent.kind === "trigger") {
        if (intent.triggerKind !== "tp" && intent.triggerKind !== "sl") throw new Error("Trigger must be tp or sl");
        if (intent.execution !== "market" && intent.execution !== "limit") throw new Error("Trigger execution must be market or limit");
        triggerPrice = validatePerpPrice(intent.triggerPrice, market!.szDecimals);
      }
      if (isMarket) {
        const slippageBps = intent.slippageBps ?? 50;
        let reference = triggerPrice;
        if (!reference) {
          const book = object(await info({ type: "l2Book", coin: market!.name }));
          if (!Array.isArray(book.levels) || !Array.isArray(book.levels[buy ? 1 : 0]) || !book.levels[buy ? 1 : 0].length) throw new Error("No executable order book liquidity");
          reference = String(object(book.levels[buy ? 1 : 0][0]).px);
          review.bookTimestamp = book.time;
        }
        limitPrice = boundedMarketPrice(reference, buy, slippageBps, market!.szDecimals);
        Object.assign(review, { referencePrice: reference, slippageBps });
        warnings.push("A market order is a bounded immediate-or-cancel order. It may partially fill or remain unfilled.");
      } else {
        const requestedPrice = "price" in intent ? intent.price : undefined;
        if (!requestedPrice) throw new Error("A limit price is required");
        limitPrice = validatePerpPrice(requestedPrice, market!.szDecimals);
      }
      const wire: WireOrder = { a: market!.asset, b: buy, p: limitPrice, s: amount, r: reduceOnly, t: intent.kind === "trigger" ? { trigger: { isMarket, triggerPx: triggerPrice!, tpsl: intent.triggerKind } } : { limit: { tif: isMarket ? "Ioc" : (("postOnly" in intent && intent.postOnly) ? "Alo" : "Gtc") } } };
      if (intent.kind === "modify") {
        action = { type: "modify", oid: orderId(intent.oid), order: wire };
        warnings.push("Modification only replaces a still-open order. The venue applies post-only behavior when always-place is omitted, so a replacement that would execute immediately can be rejected.");
      } else action = { type: "order", orders: [wire], grouping: "na" };
      orders.push({ coin: market!.name, state: "prepared", size: amount });
      Object.assign(review, { title: `${intent.kind === "close" ? "Close" : intent.kind === "modify" ? "Modify" : buy ? "Buy" : "Sell"} ${market!.name} perpetual`, side: buy ? "buy" : "sell", size: amount, limitPrice, reduceOnly, orderType: intent.kind === "trigger" ? "trigger" : isMarket ? "market" : "limit", estimatedNotionalUsdc: new D(limitPrice).mul(amount).toFixed(), ...(triggerPrice ? { triggerPrice, triggerKind: intent.kind === "trigger" ? intent.triggerKind : undefined } : {}), ...(intent.kind === "modify" ? { replacedOrderId: orderId(intent.oid) } : {}) });
      review.details.push(reduceOnly ? "Reduce-only prevents this order from increasing or reversing the position." : "This order can open, increase, reduce, or reverse a perpetual position depending on existing exposure.");
      if (intent.kind === "trigger") review.details.push("This is an independent reduce-only trigger with a fixed size. It is not linked to other take-profit or stop-loss orders.");
      if (isMarket) review.details.push(`Execution is bounded by ${limitPrice} USDC per ${market!.name}; any unfilled immediate quantity is canceled.`);
    }
    review.details.push("Orders are sent directly from this browser to Hyperliquid. Accepted resting and trigger orders remain at the venue when this browser closes.");
    const account = accountResult.value;
    if (account) {
      review.account = {
        observedAt: account.observedAt, complete: account.complete, errors: account.errors,
        abstraction: account.abstraction, balanceSource: account.balanceSource,
        marginSummary: account.clearinghouseState?.marginSummary ?? null,
        crossMaintenanceMarginUsed: account.clearinghouseState?.crossMaintenanceMarginUsed ?? null,
        withdrawable: account.clearinghouseState?.withdrawable ?? null,
        positions: account.positions?.filter(entry => !intent.coin || entry.coin === intent.coin) ?? null,
        sharedBalances: account.balanceSource === "unified" ? account.balances : null,
      };
      review.fees = account.fees ? { takerRate: account.fees.userCrossRate, makerRate: account.fees.userAddRate, observedAt: account.observedAt } : null;
      if (account.fees && typeof review.estimatedNotionalUsdc === "string") {
        const notional = positive(review.estimatedNotionalUsdc, "Estimated notional");
        review.estimatedFeesUsdc = { taker: notional.mul(decimal(account.fees.userCrossRate, "Taker fee rate", true)).toFixed(), maker: notional.mul(decimal(account.fees.userAddRate, "Maker fee rate", true)).toFixed() };
      }
      warnings.push(...account.warnings);
      if (!account.complete) warnings.push("Some account observations are unavailable. The review identifies missing sources; no balance or fee is assumed.");
      if (!account.fees) warnings.push("The account's current fee rates are unavailable.");
    } else {
      review.account = null; review.fees = null;
      warnings.push(`Account and fee observations unavailable: ${accountResult.error}`);
    }
    review.action = structuredClone(action);
    return { review, action, orders, observedAt: now(), warnings };
  }

  async function reconcileRecord(record: TradeRecord): Promise<TradeRecord> {
    if (record.state === "prepared" || record.state === "signed") return record;
    // A browser/process can disappear after the durable pre-send marker. No live
    // fetch remains after reload, so submitting is an ambiguous retained request.
    if (record.state === "submitting") record = await save(record, { state: "uncertain", orders: record.orders.map(order => order.state === "prepared" ? { ...order, state: "unknown" } : order) });
    const errors: string[] = [];
    let accountState: unknown;
    const orders = await Promise.all(record.orders.map(async order => {
      const identifier = order.oid ?? order.cloid;
      if (identifier === undefined) return order;
      try {
        const result = object(await info({ type: "orderStatus", user: binding.walletAddress, oid: identifier }));
        if (result.status === "unknownOid") return order.state === "prepared" || order.state === "unknown" ? { ...order, state: "unknown" } : order;
        if (result.status !== "order") throw new Error("Unexpected order status response");
        const detail = object(result.order);
        const venueOrder = object(detail.order);
        if (order.coin && venueOrder.coin !== order.coin) throw new Error("Order evidence belongs to another market");
        if (order.cloid && venueOrder.cloid && venueOrder.cloid.toLowerCase() !== order.cloid) throw new Error("Order evidence has a different client order ID");
        const observedStatus = String(detail.status);
        const terminalEvidence = ["filled", "canceled", "rejected"].includes(order.state) || /(?:filled|cancel(?:ed)?|rejected)$/i.test(order.venueStatus ?? "");
        const venueStatus = terminalEvidence && ["open", "triggered"].includes(observedStatus) ? order.venueStatus ?? order.state : observedStatus;
        const original = decimal(venueOrder.origSz ?? order.size ?? venueOrder.sz, "Original order size");
        const remaining = decimal(venueOrder.sz, "Remaining size");
        // Canceled orders can report zero remaining size without having filled.
        const retainedFilled = new D(order.filledSize ?? 0);
        const observedFilled = observedStatus === "open" ? original.minus(remaining) : new D(0);
        const filled = D.max(retainedFilled, observedFilled);
        let state = venueStatus === "open" || venueStatus === "triggered" ? "resting" : venueStatus === "filled" ? "filled" : /rejected$/i.test(venueStatus) ? "rejected" : /cancel(ed)?$/i.test(venueStatus) ? "canceled" : "unknown";
        const requested = new D(order.size ?? original);
        if (filled.gt(0)) state = filled.gte(requested) ? "filled" : "partial";
        return { ...order, oid: Number(venueOrder.oid), state, venueStatus, ...(order.filledSize !== undefined || observedStatus === "open" ? { filledSize: filled.toFixed() } : {}), ...(/rejected$/i.test(venueStatus) ? { error: venueStatus } : {}) };
      } catch (error) { errors.push(String(error instanceof Error ? error.message : error)); return order; }
    }));
    // Fill evidence supplements the order record and captures actual execution prices for partial IOC orders.
    if (orders.some(order => order.oid !== undefined)) {
      try {
        const fills = await info<unknown>({ type: "userFillsByTime", user: binding.walletAddress, startTime: Math.max(0, record.createdAt - 60_000), aggregateByTime: false });
        if (!Array.isArray(fills)) throw new Error("Fill evidence is unavailable");
        for (const order of orders) {
          const relevant = fills.map(object).filter(fill => fill.oid === order.oid && (!order.coin || fill.coin === order.coin));
          const seen = new Set<string>();
          let quantity = new D(0), notional = new D(0);
          for (const fill of relevant) {
            const identity = `${fill.tid}:${fill.hash}:${fill.oid}`;
            if (seen.has(identity)) continue;
            seen.add(identity);
            const qty = positive(fill.sz, "Fill size");
            quantity = quantity.plus(qty); notional = notional.plus(qty.mul(positive(fill.px, "Fill price")));
          }
          if (quantity.gt(0)) {
            // A bounded venue history can be incomplete. Do not replace larger execution evidence with a truncated total.
            if (!order.filledSize || quantity.gte(order.filledSize)) { order.filledSize = quantity.toFixed(); order.averagePrice = notional.div(quantity).toFixed(); }
            const evidencedQuantity = new D(order.filledSize ?? quantity);
            if (order.size && evidencedQuantity.gte(order.size)) order.state = "filled";
            else if (order.size && evidencedQuantity.lt(order.size)) order.state = "partial";
          }
        }
      } catch (error) { errors.push(String(error instanceof Error ? error.message : error)); }
    }
    if (!orders.length && record.state === "uncertain") {
      try { accountState = await info({ type: "clearinghouseState", user: binding.walletAddress }); }
      catch (error) { errors.push(String(error instanceof Error ? error.message : error)); }
      // Matching account configuration cannot prove attribution of an ambiguous leverage/margin request.
    }
    let state = orders.length ? aggregate(orders, record.state) : record.state;
    // The target's resting status proves that its placement exists, not that a
    // lost cancellation request was accepted. Keep the cancellation recoverable.
    if ((record.intent.kind === "cancel" || record.intent.kind === "cancelAll") && record.state === "uncertain" &&
      orders.some(order => ["resting", "accepted", "prepared", "unknown"].includes(order.state) || (order.state === "partial" && ["open", "triggered"].includes(order.venueStatus ?? "")))) state = "uncertain";
    const message = state === "uncertain" ? "The venue has not conclusively resolved this request. Inspect its evidence or explicitly retry the retained signed request; do not create a new operation to retry it." : orders.find(order => order.error)?.error ?? (state === "partial" ? "The order partially filled. Inspect the venue status to see whether any remainder is still open." : `Venue status: ${state}.`);
    return save(record, { orders, state, message, reconciliation: { checkedAt: now(), errors, ...(accountState ? { accountState } : {}) } });
  }

  async function send(record: TradeRecord): Promise<TradeRecord> {
    assertLive();
    if (!record.envelope || !record.envelopeJson) throw new Error("Signed operation was not persisted");
    record = await save(record, { state: "submitting", attempts: record.attempts + 1 });
    try {
      const timeout = AbortSignal.timeout(30_000);
      const response = await fetcher(exchange, { method: "POST", headers: { "Content-Type": "application/json" }, body: record.envelopeJson!, signal: signal ? AbortSignal.any([timeout, signal]) : timeout, credentials: "omit" });
      if (!response.ok) throw new Error(`Hyperliquid exchange HTTP ${response.status}; request outcome may be unknown`);
      const raw: unknown = await response.json();
      const result = object(raw);
      if (result.status === "err" && typeof result.response === "string") {
        // A duplicate/stale-nonce rejection on a replay does not establish what the original request did.
        if (record.attempts > 1) return reconcileRecord(await save(record, { response: raw, state: "uncertain", message: result.response }));
        return save(record, { response: raw, state: "rejected", message: result.response, orders: record.orders.map(order => ({ ...order, state: "rejected", error: result.response })) });
      }
      if (result.status !== "ok") throw new Error("Unrecognized exchange response; request outcome may be unknown");
      const details = object(result.response);
      if (details.type === "default") {
        if (!["modify", "updateLeverage", "updateIsolatedMargin"].includes(String(record.action.type))) throw new Error("Exchange omitted the required per-order results");
        // Modify's default response confirms dispatch, while orderStatus determines its new order state.
        const accepted = await save(record, { response: raw, state: "accepted", orders: record.orders.map(order => ({ ...order, state: "accepted" })) });
        return record.intent.kind === "modify" ? reconcileRecord(accepted) : accepted;
      }
      const expected = ["cancel", "cancelByCloid"].includes(String(record.action.type)) ? "cancel" : "order";
      if (details.type !== expected) throw new Error("Exchange result type does not match the submitted action");
      const statuses = object(details.data).statuses;
      if (!Array.isArray(statuses) || statuses.length !== record.orders.length) throw new Error("Exchange status count does not match the submitted orders");
      const orders = statuses.map((status: unknown, index: number) => parseStatus(status, record.orders[index]!));
      if (record.attempts > 1 && orders.some(order => order.state === "rejected")) return reconcileRecord(await save(record, { response: raw, state: "uncertain" }));
      const message = orders.find(order => order.error)?.error;
      return save(record, { response: raw, orders, state: aggregate(orders), ...(message ? { message } : {}) });
    } catch (error) {
      const uncertain = await save(record, { state: "uncertain", orders: record.orders.map(order => ({ ...order, state: "unknown" })), message: String(error instanceof Error ? error.message : error) });
      return reconcileRecord(uncertain);
    }
  }

  async function execute({ operationId, intent }: { operationId: string; intent: TradeIntent }): Promise<PublicTradeOperation> {
    assertLive();
    const id = operationId.toLowerCase();
    return withTradingLock(key(id), async () => {
      let record = await store.get(key(id)) as TradeRecord | undefined;
      const fingerprint = canonical(intent);
      if (record) {
        if (record.fingerprint !== fingerprint) throw new Error("This operation ID is already bound to a different trading intent");
        if (record.attempts > 0 || !["prepared", "signed"].includes(record.state)) return publicRecord(await reconcileRecord(record));
      } else {
        const prepared = await preview(intent);
        // Cloids are stable across reloads and are authenticated to this caller and wallet binding.
        for (let index = 0; index < prepared.orders.length; index++) {
          if (prepared.action.type === "order" || prepared.action.type === "modify") {
            const cloid = await cloidFor(scope, id, index);
            prepared.orders[index]!.cloid = cloid;
            if (prepared.action.type === "order") (prepared.action.orders as WireOrder[])[index]!.c = cloid;
            else (prepared.action.order as WireOrder).c = cloid;
          }
        }
        prepared.review.action = structuredClone(prepared.action);
        prepared.review.warnings = prepared.warnings;
        const timestamp = now();
        record = { key: key(id), scope, operationId: id, revision: 0, fingerprint, intent: structuredClone(intent), action: prepared.action, review: prepared.review, orders: prepared.orders, createdAt: timestamp, updatedAt: timestamp, state: "prepared", canRetryExact: false, attempts: 0 };
        await store.add(record);
      }
      if (record.intent.kind === "cancelAll" && !record.orders.length) return publicRecord(await save(record, { state: "accepted", message: "No matching open perpetual orders to cancel." }));
      assertLive();
      await dependencies.authorize(structuredClone(record.review));
      assertLive();
      const wallet = await signer();
      assertLive();
      const address = (await getWalletAddress(wallet)).toLowerCase();
      if (record.signerAddress && record.signerAddress !== address) throw new Error("The original trading key changed; this operation cannot be signed by its replacement");
      if (!record.envelope) {
        const nonce = await store.nextNonce(JSON.stringify([binding.environment, binding.installationId, address]), now());
        assertLive();
        const signature = await signL1Action({ wallet, action: record.action, nonce, isTestnet: binding.environment === "testnet" });
        const envelope = { action: record.action, nonce, signature };
        record = await save(record, { state: "signed", signerAddress: address, envelope, envelopeJson: JSON.stringify(envelope) });
      }
      return publicRecord(await send(record));
    });
  }
  async function reconcile(operationId: string) { return withTradingLock(key(operationId), async () => publicRecord(await reconcileRecord(await requireRecord(operationId)))); }
  async function retryExact(operationId: string) {
    assertLive();
    return withTradingLock(key(operationId), async () => {
      let record = await reconcileRecord(await requireRecord(operationId));
      if (record.state !== "uncertain") return publicRecord(record);
      if (!record.envelope) throw new Error("No retained signed request is available");
      const active = await signer();
      assertLive();
      if ((await getWalletAddress(active)).toLowerCase() !== record.signerAddress) throw new Error("The original trading key is no longer active");
      await dependencies.authorize({ ...structuredClone(record.review), title: `Retry retained request: ${record.review.title}`, retryExact: true, nonce: record.envelope.nonce, details: [...record.review.details, "The exact original signed bytes and nonce will be sent again. No new order or signature is created."] });
      assertLive();
      record = await send(record);
      return publicRecord(record);
    });
  }
  async function history(options: { allCallers?: boolean } = {}): Promise<PublicTradeOperation[]> {
    const records = options.allCallers ? await store.listBinding(binding) : await store.list(scope);
    return records.map(row => {
      const result = publicRecord(row as TradeRecord);
      const ownedByCaller = row.scope === scope;
      return { ...result, caller: tradingCallerFromScope(row.scope), ownedByCaller, canRetryExact: ownedByCaller && result.canRetryExact };
    }).sort((a, b) => b.createdAt - a.createdAt);
  }
  return { preview, execute, reconcile, retryExact, history };
}
