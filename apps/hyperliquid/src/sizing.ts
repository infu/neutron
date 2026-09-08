import Decimal from "decimal.js";
import type { AccountSnapshot, ActiveAsset, OrderBook, PerpMarket, Snapshot } from "./market";
import { boundedMarketPrice, validatePerpPrice } from "./trading";

const D = Decimal.clone({ precision: 80, toExpNeg: -100, toExpPos: 100 });
const decimal = (value: unknown): Decimal | null => typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value) ? new D(value) : null;
const nonnegative = (value: unknown): Decimal | null => { const n = decimal(value); return n && n.gte(0) ? n : null; };
const positive = (value: unknown): Decimal | null => { const n = decimal(value); return n && n.gt(0) ? n : null; };
const down = (value: Decimal, places: number) => value.toDecimalPlaces(places, D.ROUND_DOWN).toFixed();

export type OrderCapacityInput = { coin: string; side: "buy" | "sell"; orderType: "market" | "limit"; price?: string; slippageBps?: number; reduceOnly?: boolean };
export type OrderCapacity = {
  maxSize: string | null; availableMarginUsdc: string | null; leverage: number | null;
  marginMode: "cross" | "isolated" | null; observedAt: number; reason?: string;
  /** These are observations and an estimate, never a reservation or fill guarantee. */
  venueMaxSize?: string; worstPrice?: string; feeRate?: string; sizeDecimals?: number;
};
export type OrderCapacityEvidence = {
  market: Pick<PerpMarket, "name" | "szDecimals"> | null;
  activeAsset: (ActiveAsset & Snapshot) | null;
  account: AccountSnapshot | null;
  book?: OrderBook | null;
  observedAt?: number;
};

/** Percentage controls use exact arithmetic and always round down, including
 * a 100% selection. This is UI sizing, not a restriction on manually set orders. */
export function sizeAtPercent(maximum: string, percent: number, decimals: number): string {
  const max = nonnegative(maximum);
  if (!max || !Number.isFinite(percent) || percent < 0 || percent > 100 || !Number.isInteger(decimals) || decimals < 0 || decimals > 6) throw new Error("Invalid size percentage.");
  return down(max.mul(new D(String(percent))).div(100), decimals);
}

/** The official venue UI indexes activeAssetData as [buy/long, sell/short].
 * maxTradeSzs is base-asset size; availableToTrade is USDC at the account's
 * configured leverage/margin mode, rather than the market's maximum leverage.
 * https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals#retrieve-users-active-asset-data
 * https://hyperliquid.gitbook.io/hyperliquid-docs/trading/margining
 *
 * This estimate never enlarges the venue's observed maximum. It reserves the
 * user's current trading fee and adverse execution versus mark at the actual
 * order price boundary. The reserve is an estimate derived from the documented
 * mark-price margin formula, not an assertion about Hyperliquid's internal Max
 * implementation. Users can still enter another size; the venue validates it. */
export function calculateOrderCapacity(input: OrderCapacityInput, evidence: OrderCapacityEvidence): OrderCapacity {
  const { market, activeAsset, account } = evidence;
  const observedAt = evidence.observedAt ?? activeAsset?.observedAt ?? account?.observedAt ?? Date.now();
  const base: OrderCapacity = { maxSize: null, availableMarginUsdc: null, leverage: null, marginMode: null, observedAt };
  const unavailable = (reason: string): OrderCapacity => ({ ...base, reason });
  if (!market || market.name !== input.coin || !Number.isInteger(market.szDecimals) || market.szDecimals < 0 || market.szDecimals > 6) return unavailable("This market's size precision is unavailable.");
  if (input.side !== "buy" && input.side !== "sell" || input.orderType !== "market" && input.orderType !== "limit") return unavailable("Choose an order side and type.");
  base.sizeDecimals = market.szDecimals;
  const activeMatches = activeAsset?.coin === input.coin && account && activeAsset.user.toLowerCase() === account.address.toLowerCase() && activeAsset.environment === account.environment;
  if (activeMatches && Number.isInteger(activeAsset.leverage.value) && activeAsset.leverage.value >= 1 && ["cross", "isolated"].includes(activeAsset.leverage.type)) {
    base.leverage = activeAsset.leverage.value;
    base.marginMode = activeAsset.leverage.type;
    base.availableMarginUsdc = nonnegative(activeAsset.availableToTrade[input.side === "buy" ? 0 : 1])?.toFixed() ?? null;
  }
  if (input.reduceOnly) {
    if (!account?.positions) return unavailable("Your current position is unavailable. Refresh to try again.");
    const position = account.positions.find(value => value.coin === input.coin);
    if (!position) return { ...base, maxSize: "0", reason: `There is no ${input.coin} position to reduce.` };
    const remaining = decimal(position.szi);
    if (!remaining) return unavailable("Your current position size is unavailable.");
    base.leverage ??= position.leverage.value;
    base.marginMode ??= position.leverage.type;
    const closesPosition = input.side === "buy" ? remaining.lt(0) : remaining.gt(0);
    return closesPosition ? { ...base, maxSize: down(remaining.abs(), market.szDecimals) } : { ...base, maxSize: "0", reason: `Choose ${remaining.gt(0) ? "Sell" : "Buy"} to reduce this position.` };
  }
  if (!activeMatches || !base.leverage || base.availableMarginUsdc === null) return unavailable("Your available trading size is unavailable. Refresh to try again.");
  const venueMax = nonnegative(activeAsset.maxTradeSzs[input.side === "buy" ? 0 : 1]);
  const mark = positive(activeAsset.markPx);
  if (!venueMax || !mark) return unavailable("Hyperliquid has not reported a valid maximum trading size.");
  base.venueMaxSize = down(venueMax, market.szDecimals);
  if (venueMax.isZero()) return { ...base, maxSize: "0", reason: isEmptyTradingAccount(account) ? "Deposit USDC to start trading." : "No margin is currently available for this side." };
  const taker = decimal(account.fees?.userCrossRate), maker = decimal(account.fees?.userAddRate);
  if (!taker || !maker) return unavailable("Your current trading fees are unavailable. Refresh to calculate Max.");
  // A normal limit can execute as taker. Never count a maker rebate as collateral.
  const feeRate = D.max(0, taker, maker);
  let worstPrice: string;
  try {
    if (input.orderType === "limit") {
      if (!input.price) return unavailable("Enter a limit price to calculate Max.");
      worstPrice = validatePerpPrice(input.price, market.szDecimals);
    } else {
      if (evidence.book?.coin !== input.coin) return unavailable("The current orderbook is unavailable. Refresh to calculate Max.");
      const reference = evidence.book.levels[input.side === "buy" ? 1 : 0][0]?.px;
      if (!reference) return unavailable("There is no executable liquidity on this side of the orderbook.");
      worstPrice = boundedMarketPrice(reference, input.side === "buy", input.slippageBps ?? 50, market.szDecimals);
    }
  } catch (error) { return unavailable(error instanceof Error ? error.message : "A valid order price is required."); }
  const price = new D(worstPrice), initialMarginPerUnit = mark.div(base.leverage);
  const adverseExecutionPerUnit = D.max(0, input.side === "buy" ? price.minus(mark) : mark.minus(price));
  // A sell limit has no upside execution-price cap. Using max(mark, limit) for
  // its fee estimate avoids understating fees merely because its limit is lower.
  const feePerUnit = D.max(mark, price).mul(feeRate);
  const budget = D.min(new D(base.availableMarginUsdc), venueMax.mul(initialMarginPerUnit));
  const maxSize = down(D.min(venueMax, budget.div(initialMarginPerUnit.plus(adverseExecutionPerUnit).plus(feePerUnit))), market.szDecimals);
  return { ...base, maxSize, worstPrice, feeRate: feeRate.toFixed(), reason: "Max estimates the current available size, including trading fees and the selected price boundary. Balances and prices can change before execution." };
}

/** A new/default account can be shown as empty only when every relevant source
 * was actually observed as zero. A missing response never becomes a zero balance.
 * Raw account warnings stay intact for Agent diagnostics and detailed views. */
export function isEmptyTradingAccount(account: AccountSnapshot | null | undefined): boolean {
  if (!account?.clearinghouseState || !account.positions || !account.openOrders || account.abstraction === null || account.excludedOrderCount === null) return false;
  if (account.positions.some(position => !decimal(position.szi)?.isZero()) || account.openOrders.length || account.excludedOrderCount) return false;
  const state = account.clearinghouseState;
  if (![...Object.values(state.marginSummary), ...Object.values(state.crossMarginSummary), state.withdrawable, state.crossMaintenanceMarginUsed].every(value => decimal(value)?.isZero())) return false;
  if (account.balanceSource === "perps") return true;
  if (!account.balances) return false;
  return account.balances.balances.every(balance => [balance.total, balance.hold, balance.entryNtl].every(value => decimal(value)?.isZero()))
    && (account.balances.tokenToAvailableAfterMaintenance ?? []).every(([, value]) => decimal(value)?.isZero());
}

export type FundingCapacity = { maxAmountUsdc: string | null; reason?: string; observedAt: number };
export type FundingCapacityInput = { direction: "deposit" | "withdraw"; sourceBalance?: "perps" | "unified"; environment?: "mainnet" | "testnet" };
export type FundingCapacityEvidence = { account?: AccountSnapshot | null; nativeUsdcAtoms?: string | null; observedAt?: number };

/** Withdrawal fees are taken from the submitted amount by CoreDepositWallet,
 * not charged on top. Subtracting them here would prevent a full withdrawal.
 * Source: https://github.com/circlefin/hyperevm-circle-contracts/blob/master/src/CoreDepositWallet.sol
 * Deposit native-token gas is separate from the USDC balance. */
export function calculateFundingCapacity(input: FundingCapacityInput, evidence: FundingCapacityEvidence): FundingCapacity {
  const observedAt = evidence.observedAt ?? evidence.account?.observedAt ?? Date.now();
  const unavailable = (reason: string): FundingCapacity => ({ maxAmountUsdc: null, observedAt, reason });
  if (input.environment === "testnet") return unavailable("USDC transfers are available on mainnet.");
  if (input.direction === "deposit") {
    if (typeof evidence.nativeUsdcAtoms !== "string" || !/^\d+$/.test(evidence.nativeUsdcAtoms)) return unavailable("Your source wallet's USDC balance is unavailable. Refresh to try again.");
    return { maxAmountUsdc: new D(evidence.nativeUsdcAtoms).div(1_000_000).toFixed(), observedAt };
  }
  const account = evidence.account;
  if (!account || account.abstraction === null) return unavailable("Your Hyperliquid withdrawal balance is unavailable. Refresh to try again.");
  if (input.sourceBalance && account.balanceSource !== "unknown" && input.sourceBalance !== account.balanceSource) return unavailable("The selected balance does not match this account. Refresh its balance settings.");
  const source = account.balanceSource === "unknown" ? input.sourceBalance : account.balanceSource;
  if (!source) return isEmptyTradingAccount(account) ? { maxAmountUsdc: "0", observedAt, reason: "Deposit USDC to start trading." } : unavailable("Choose the balance to withdraw from in transfer options.");
  if (source === "perps") {
    const available = decimal(account.clearinghouseState?.withdrawable);
    return available ? { maxAmountUsdc: down(D.max(0, available), 6), observedAt } : unavailable("Your available perps USDC is unavailable. Refresh to try again.");
  }
  const balances = account.balances;
  if (!balances) return unavailable("Your shared USDC balance is unavailable. Refresh to try again.");
  const usdc = balances.balances.find(balance => balance.token === 0 && balance.coin === "USDC");
  const maintenance = balances.tokenToAvailableAfterMaintenance?.find(([token]) => token === 0);
  // Total minus hold alone is not withdrawable under shared collateral: positions
  // can consume maintenance margin even when the token has no spot order hold.
  if (!usdc) return balances.balances.length === 0 && isEmptyTradingAccount(account) ? { maxAmountUsdc: "0", observedAt } : unavailable("Hyperliquid has not reported an available shared USDC balance.");
  const total = decimal(usdc.total), hold = nonnegative(usdc.hold), afterMaintenance = decimal(maintenance?.[1]);
  if (!total || !hold || !afterMaintenance) return unavailable("Hyperliquid has not reported how much shared USDC can be withdrawn.");
  return { maxAmountUsdc: down(D.max(0, D.min(total.minus(hold), afterMaintenance)), 6), observedAt };
}
