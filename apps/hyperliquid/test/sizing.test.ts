import { expect, test } from "bun:test";
import { calculateFundingCapacity, calculateOrderCapacity, isEmptyTradingAccount, sizeAtPercent, type OrderCapacityEvidence, type OrderCapacityInput } from "../src/sizing";
import type { AccountSnapshot, ActiveAsset, OrderBook, Snapshot } from "../src/market";

const address = `0x${"11".repeat(20)}`;
const summary = { accountValue: "100", totalMarginUsed: "0", totalNtlPos: "0", totalRawUsd: "100" };
function account(): AccountSnapshot {
  return {
    environment: "mainnet", observedAt: 1000, complete: true, errors: [], address, observations: [], abstraction: "disabled", balanceSource: "perps", warnings: [], excludedOrderCount: 0,
    clearinghouseState: { assetPositions: [], marginSummary: { ...summary }, crossMarginSummary: { ...summary }, crossMaintenanceMarginUsed: "0", withdrawable: "100", time: 990 },
    positions: [], openOrders: [], fees: { userCrossRate: "0", userAddRate: "0" }, balances: null,
  };
}
function emptyAccount(): AccountSnapshot {
  const value = account();
  for (const summary of [value.clearinghouseState!.marginSummary, value.clearinghouseState!.crossMarginSummary]) for (const key of Object.keys(summary) as (keyof typeof summary)[]) summary[key] = "0";
  value.clearinghouseState!.withdrawable = "0";
  value.abstraction = "default"; value.balanceSource = "unknown"; value.balances = { balances: [] };
  value.warnings = ["The account balance mode is not resolved. Perps and token balances must not be added together or treated as available collateral."];
  return value;
}
function active(): ActiveAsset & Snapshot {
  return { environment: "mainnet", observedAt: 1100, complete: true, errors: [], user: address, coin: "ETH", leverage: { type: "cross", value: 10 }, maxTradeSzs: ["100", "100"], availableToTrade: ["100", "100"], markPx: "10" };
}
const book: OrderBook = { coin: "ETH", time: 1090, levels: [[{ px: "10", sz: "100", n: 1 }], [{ px: "10", sz: "100", n: 1 }]] };
const request: OrderCapacityInput = { coin: "ETH", side: "buy", orderType: "market", slippageBps: 0 };
function evidence(): OrderCapacityEvidence { return { market: { name: "ETH", szDecimals: 2 }, account: account(), activeAsset: active(), book }; }

test("Max follows the venue's side-specific size and current leverage, rounded down", () => {
  const proof = evidence(); proof.market!.szDecimals = 5;
  proof.activeAsset!.maxTradeSzs = ["2.123456", "9.111119"];
  proof.activeAsset!.leverage = { type: "isolated", value: 2, rawUsd: "8" };
  const buy = calculateOrderCapacity(request, proof), sell = calculateOrderCapacity({ ...request, side: "sell" }, proof);
  expect(buy.maxSize).toBe("2.12345"); expect(sell.maxSize).toBe("9.11111");
  expect(buy.leverage).toBe(2); expect(buy.marginMode).toBe("isolated"); expect(buy.availableMarginUsdc).toBe("100"); expect(buy.observedAt).toBe(1100);
});
test("Max reserves actual trading fees without counting maker rebates as collateral", () => {
  const proof = evidence(); proof.account!.fees = { userCrossRate: "0.01", userAddRate: "-0.02" };
  const result = calculateOrderCapacity(request, proof);
  // 100 USDC / (1 USDC initial margin + 0.1 USDC fee per ETH).
  expect(result.maxSize).toBe("90.9"); expect(result.feeRate).toBe("0.01"); expect(result.venueMaxSize).toBe("100");
  expect(result.reason).toContain("estimate");
});
test("market Max uses the real book side and selected slippage, with adverse mark-price cost", () => {
  const proof = evidence(); proof.account!.fees = { userCrossRate: "0.01", userAddRate: "0" };
  const buy = calculateOrderCapacity({ ...request, slippageBps: 1000 }, proof);
  const sell = calculateOrderCapacity({ ...request, side: "sell", slippageBps: 1000 }, proof);
  // Buy boundary 11: 100/(1 margin + 1 adverse mark difference + .11 fee).
  expect(buy.worstPrice).toBe("11"); expect(buy.maxSize).toBe("47.39");
  // Sell boundary 9: same margin/difference; fee estimate uses mark 10.
  expect(sell.worstPrice).toBe("9"); expect(sell.maxSize).toBe("47.61");
  const spread = { ...book, levels: [book.levels[0], [{ px: "12", sz: "1", n: 1 }]] } as OrderBook;
  expect(calculateOrderCapacity(request, { ...proof, book: spread }).worstPrice).toBe("12");
});
test("favorable resting limits never enlarge the venue's current maximum", () => {
  const proof = evidence();
  expect(calculateOrderCapacity({ ...request, orderType: "limit", price: "8" }, proof).maxSize).toBe("100");
  expect(calculateOrderCapacity({ ...request, orderType: "limit", side: "sell", price: "12" }, proof).maxSize).toBe("100");
  expect(calculateOrderCapacity({ ...request, orderType: "limit", price: "12" }, proof).maxSize).toBe("33.33");
});
test("venue available margin can lower a stale/inconsistent size observation", () => {
  const proof = evidence(); proof.activeAsset!.availableToTrade = ["25", "50"];
  expect(calculateOrderCapacity(request, proof).maxSize).toBe("25");
  expect(calculateOrderCapacity({ ...request, side: "sell" }, proof).maxSize).toBe("50");
});
test("ordinary Max remains unavailable when fees, book, market or account binding is missing", () => {
  const proof = evidence();
  expect(calculateOrderCapacity(request, { ...proof, account: { ...account(), fees: null } }).maxSize).toBeNull();
  expect(calculateOrderCapacity(request, { ...proof, book: null }).maxSize).toBeNull();
  expect(calculateOrderCapacity(request, { ...proof, market: { name: "BTC", szDecimals: 5 } }).maxSize).toBeNull();
  expect(calculateOrderCapacity(request, { ...proof, activeAsset: { ...active(), user: `0x${"22".repeat(20)}` } }).maxSize).toBeNull();
  expect(calculateOrderCapacity(request, { ...proof, activeAsset: { ...active(), environment: "testnet" } }).maxSize).toBeNull();
  expect(calculateOrderCapacity(request, { ...proof, activeAsset: { ...active(), maxTradeSzs: ["-1", "100"] } }).maxSize).toBeNull();
});
test("limit Max requires a valid executable venue price, not a malformed decimal", () => {
  for (const price of [undefined, "0", "NaN", "1e3", "1.12345"]) expect(calculateOrderCapacity({ ...request, orderType: "limit", ...(price ? { price } : {}) }, evidence()).maxSize).toBeNull();
  expect(calculateOrderCapacity({ ...request, side: "sell", slippageBps: 10000 }, evidence()).maxSize).toBeNull();
});
test("reduce-only Max closes the remaining position even with no collateral or fee/book reads", () => {
  const current = emptyAccount(); current.fees = null;
  current.positions = [{ coin: "ETH", szi: "-3.456789", leverage: { type: "isolated", value: 3 } } as NonNullable<AccountSnapshot["positions"]>[number]];
  const result = calculateOrderCapacity({ ...request, reduceOnly: true }, { market: { name: "ETH", szDecimals: 5 }, activeAsset: null, account: current });
  expect(result.maxSize).toBe("3.45678"); expect(result.leverage).toBe(3); expect(result.marginMode).toBe("isolated");
  expect(calculateOrderCapacity({ ...request, reduceOnly: true, side: "sell" }, { ...evidence(), account: current }).maxSize).toBe("0");
  expect(calculateOrderCapacity({ ...request, reduceOnly: true }, { ...evidence(), account: { ...current, positions: null } }).maxSize).toBeNull();
});
test("empty active asset reports zero rather than an inaccessible error", () => {
  const proof = evidence(); proof.account = emptyAccount(); proof.account.fees = null; proof.activeAsset!.maxTradeSzs = ["0", "0"]; proof.activeAsset!.availableToTrade = ["0", "0"];
  const result = calculateOrderCapacity(request, proof);
  expect(result.maxSize).toBe("0"); expect(result.reason).toBe("Deposit USDC to start trading.");
});
test("percent slider floors exact base size and handles high precision without floating rounding", () => {
  expect(sizeAtPercent("3.456789", 100, 5)).toBe("3.45678");
  expect(sizeAtPercent("3.456789", 25, 5)).toBe("0.86419");
  expect(sizeAtPercent("9007199254740993.123456", 50, 6)).toBe("4503599627370496.561728");
  expect(sizeAtPercent("0.000001", 99, 6)).toBe("0");
  expect(sizeAtPercent("1", 33.333, 6)).toBe("0.33333");
  for (const percent of [-1, 101, NaN, Infinity]) expect(() => sizeAtPercent("100", percent, 6)).toThrow();
});
test("new default account is empty only with observed zero balances; raw warning remains intact", () => {
  const empty = emptyAccount(); expect(isEmptyTradingAccount(empty)).toBe(true); expect(empty.warnings[0]).toContain("must not be added together");
  expect(isEmptyTradingAccount({ ...empty, balances: null })).toBe(false);
  expect(isEmptyTradingAccount({ ...empty, positions: null })).toBe(false);
  expect(isEmptyTradingAccount({ ...empty, abstraction: null })).toBe(false);
  expect(isEmptyTradingAccount({ ...empty, excludedOrderCount: 1 })).toBe(false);
  expect(isEmptyTradingAccount({ ...empty, balances: { balances: [{ coin: "HYPE", token: 150, total: "1", hold: "0", entryNtl: "0" }] } })).toBe(false);
  empty.clearinghouseState!.marginSummary.accountValue = "-1"; expect(isEmptyTradingAccount(empty)).toBe(false);
  expect(isEmptyTradingAccount(account())).toBe(false);
});
test("deposit Max is the exact native-USDC balance without deducting USDC bridge fees twice", () => {
  expect(calculateFundingCapacity({ direction: "deposit" }, { nativeUsdcAtoms: "12345678", observedAt: 123 })).toEqual({ maxAmountUsdc: "12.345678", observedAt: 123 });
  expect(calculateFundingCapacity({ direction: "deposit" }, { nativeUsdcAtoms: "9007199254740993123456" }).maxAmountUsdc).toBe("9007199254740993.123456");
  expect(calculateFundingCapacity({ direction: "deposit" }, { nativeUsdcAtoms: "0" }).maxAmountUsdc).toBe("0");
  for (const nativeUsdcAtoms of [undefined, null, "1.1", "-100", "0x100"]) expect(calculateFundingCapacity({ direction: "deposit" }, { ...(nativeUsdcAtoms === undefined ? {} : { nativeUsdcAtoms }) }).maxAmountUsdc).toBeNull();
  expect(calculateFundingCapacity({ direction: "deposit", environment: "testnet" }, { nativeUsdcAtoms: "10000000" }).maxAmountUsdc).toBeNull();
});
test("perps withdrawal Max uses venue withdrawable, not equity or leverage, and includes its fee", () => {
  const current = account(); current.clearinghouseState!.withdrawable = "12.3456789";
  expect(calculateFundingCapacity({ direction: "withdraw" }, { account: current }).maxAmountUsdc).toBe("12.345678");
  current.clearinghouseState!.withdrawable = "-1";
  expect(calculateFundingCapacity({ direction: "withdraw" }, { account: current }).maxAmountUsdc).toBe("0");
  expect(calculateFundingCapacity({ direction: "withdraw" }, { account: { ...current, clearinghouseState: null } }).maxAmountUsdc).toBeNull();
});
test("unified withdrawal respects maintenance and token holds without summing perps equity", () => {
  const current = account(); current.balanceSource = "unified"; current.abstraction = "portfolioMargin";
  current.balances = { balances: [{ coin: "USDC", token: 0, total: "50", hold: "10", entryNtl: "0" }], tokenToAvailableAfterMaintenance: [[0, "30.1234567"]] };
  expect(calculateFundingCapacity({ direction: "withdraw" }, { account: current }).maxAmountUsdc).toBe("30.123456");
  current.balances.tokenToAvailableAfterMaintenance = [[0, "45"]];
  expect(calculateFundingCapacity({ direction: "withdraw" }, { account: current }).maxAmountUsdc).toBe("40");
  current.balances.tokenToAvailableAfterMaintenance = [[0, "-5"]];
  expect(calculateFundingCapacity({ direction: "withdraw" }, { account: current }).maxAmountUsdc).toBe("0");
  delete current.balances.tokenToAvailableAfterMaintenance;
  expect(calculateFundingCapacity({ direction: "withdraw" }, { account: current }).maxAmountUsdc).toBeNull();
});
test("unknown funded account requires an explicit balance source and rejects known-mode conflicts", () => {
  const current = account(); current.abstraction = "default"; current.balanceSource = "unknown";
  expect(calculateFundingCapacity({ direction: "withdraw" }, { account: current }).maxAmountUsdc).toBeNull();
  expect(calculateFundingCapacity({ direction: "withdraw", sourceBalance: "perps" }, { account: current }).maxAmountUsdc).toBe("100");
  expect(calculateFundingCapacity({ direction: "withdraw", sourceBalance: "unified" }, { account: account() }).maxAmountUsdc).toBeNull();
  expect(calculateFundingCapacity({ direction: "withdraw" }, { account: emptyAccount() }).maxAmountUsdc).toBe("0");
  expect(calculateFundingCapacity({ direction: "withdraw" }, { account: { ...emptyAccount(), abstraction: null } }).maxAmountUsdc).toBeNull();
});
