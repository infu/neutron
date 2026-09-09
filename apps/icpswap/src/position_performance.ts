import { getJson } from "./api.ts";
import { fromBaseUnits } from "./amount.ts";

export type PerformanceToken = {
  ledgerId: string; decimals: number | null; amountAtoms: string | null;
  feesAtoms: string | null; priceUsd: number | null;
};
export type PositionPerformanceInput = {
  poolId: string; owner: string; positionId: string; liquidity: string;
  token0: PerformanceToken; token1: PerformanceToken;
};
export type PositionPerformance = {
  status: "estimated" | "unavailable"; reason: string | null;
  pnlUsd: number | null; pnlPercent: number | null; contributedUsd: number | null;
  withdrawnUsd: number | null; currentValueUsd: number | null;
  principalUsd: number | null; uncollectedFeesUsd: number | null;
  source: "ICPSwap analytics"; historyThroughMs: number | null;
  includesNetworkFees: false; settlementVerified: false;
};
export type PositionPerformanceHistory = {
  transactions: unknown[]; transfers: unknown[]; throughMs: number;
};
// One current snapshot per pool/owner. A timestamp in the shared API cache key
// would retain another complete history on every refresh for the tile's life.
const histories = new Map<string, { throughMs: number; promise: Promise<PositionPerformanceHistory> }>();
export function invalidatePositionPerformanceCache(): void { histories.clear(); }
type RecordValue = Record<string, unknown>;
function record(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is unavailable`);
  return value as RecordValue;
}
function id(value: unknown, label: string): string {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== "string" || !/^(0|[1-9]\d*)$/u.test(text)) throw new Error(`${label} is unavailable`);
  return text;
}
function count(value: unknown, label: string): number {
  const n = Number(id(value, label));
  if (!Number.isSafeInteger(n)) throw new Error(`${label} is unavailable`);
  return n;
}
function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} cannot be valued`);
  return value;
}
function decimals(token: PerformanceToken): number {
  if (token.decimals === null || !Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 255) throw new Error("Token decimals are unavailable");
  return token.decimals;
}
function amount(value: unknown, token: PerformanceToken): bigint {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/u.test(value)) throw new Error("Historical token amounts are unavailable");
  const [whole, fraction = ""] = value.split(".");
  const places = decimals(token);
  if (/[^0]/u.test(fraction.slice(places))) throw new Error("Historical token amounts exceed ledger precision");
  return BigInt(whole!) * 10n ** BigInt(places) + BigInt(fraction.slice(0, places).padEnd(places, "0") || "0");
}
function price(value: unknown): number {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+(?:\.\d+)?$/u.test(value))) throw new Error("Token prices are unavailable");
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0) throw new Error("Token prices are unavailable");
  return result;
}
function usd(atoms: bigint, token: PerformanceToken, unitPrice: number): number {
  return finite(Number(fromBaseUnits(atoms, decimals(token))) * unitPrice, "Token amount");
}
function unavailable(reason: string, throughMs: number | null = null): PositionPerformance {
  return { status: "unavailable", reason, pnlUsd: null, pnlPercent: null, contributedUsd: null,
    withdrawnUsd: null, currentValueUsd: null, principalUsd: null, uncollectedFeesUsd: null,
    source: "ICPSwap analytics", historyThroughMs: throughMs, includesNetworkFees: false, settlementVerified: false };
}
function currentValues(input: PositionPerformanceInput): { principalUsd: number; uncollectedFeesUsd: number } {
  let principalUsd = 0, uncollectedFeesUsd = 0;
  for (const token of [input.token0, input.token1]) {
    if (token.amountAtoms === null) throw new Error("Current position holdings are unavailable");
    if (token.feesAtoms === null) throw new Error("Current uncollected fees are unavailable");
    const unitPrice = price(token.priceUsd);
    principalUsd += usd(BigInt(id(token.amountAtoms, "Current holdings")), token, unitPrice);
    uncollectedFeesUsd += usd(BigInt(id(token.feesAtoms, "Current fees")), token, unitPrice);
  }
  return { principalUsd: finite(principalUsd, "Current holdings"), uncollectedFeesUsd: finite(uncollectedFeesUsd, "Current fees") };
}

/** Estimated lifetime position return from complete API pages, before funding,
 * ledger and network fees. Protocol outputs are gross; they do not prove payout.
 * Pool/owner filters are documented; positionId is NOT an upstream filter.
 */
export function calculatePositionPerformance(input: PositionPerformanceInput, history: PositionPerformanceHistory): PositionPerformance {
  try {
    const positionId = id(input.positionId, "Position ID");
    const currentLiquidity = BigInt(id(input.liquidity, "Current liquidity"));
    const current = currentValues(input);
    for (const value of history.transfers) {
      const transfer = record(value, "Position transfer history");
      if (transfer.poolId !== input.poolId) throw new Error("Position transfer history has mismatched pool coverage");
      if (id(transfer.positionId, "Transfer position ID") === positionId) throw new Error("This position was transferred; acquisition cost is unknown");
    }
    const seen = new Set<string>();
    const rows: RecordValue[] = [];
    for (const value of history.transactions) {
      const row = record(value, "Position history");
      if (row.poolId !== input.poolId) throw new Error("Position history has mismatched pool coverage");
      if (id(row.positionId, "Historical position ID") !== positionId) continue;
      if (typeof row.txHash !== "string" || !row.txHash || seen.has(row.txHash)) throw new Error("Position history contains missing or duplicate transaction IDs");
      seen.add(row.txHash);
      if (row.fromPrincipalId !== input.owner || (row.fromSubaccount !== undefined && row.fromSubaccount !== null && row.fromSubaccount !== "" && row.fromSubaccount !== "0".repeat(64))) throw new Error("Position history does not establish this owner's cost basis");
      if (row.token0LedgerId !== input.token0.ledgerId || row.token1LedgerId !== input.token1.ledgerId) throw new Error("Position history token identities do not match the pool");
      if (count(row.txTime, "Historical transaction time") > history.throughMs) throw new Error("Position history changed during the read");
      rows.push(row);
    }
    // API rows are newest first; reversing preserves order for same-second
    // protocol events while sorting handles paginated timestamp ties stably.
    rows.reverse();
    rows.sort((a, b) => count(a.txTime, "Historical transaction time") - count(b.txTime, "Historical transaction time"));
    if (rows.length === 0 || rows[0]!.actionType !== "AddLiquidity") throw new Error("Original liquidity addition is missing from position history");
    let liquidity = 0n, contributedUsd = 0, withdrawnUsd = 0;
    for (const row of rows) {
      const adding = row.actionType === "AddLiquidity" || row.actionType === "IncreaseLiquidity";
      const decreasing = row.actionType === "DecreaseLiquidity";
      if (!adding && !decreasing && row.actionType !== "Claim") throw new Error("Position history contains an unsupported action");
      const delta = BigInt(id(row.liquidity, "Historical liquidity"));
      if (adding) {
        if (delta === 0n) throw new Error("Historical liquidity addition is incomplete");
        liquidity += delta;
      } else if (decreasing) {
        if (delta === 0n || delta > liquidity) throw new Error("Position liquidity history is incomplete");
        liquidity -= delta;
      } else if (delta !== 0n) throw new Error("Claim history has unexpected liquidity changes");
      for (const [index, token] of [input.token0, input.token1].entries()) {
        const incoming = amount(row[`token${index}AmountIn`], token);
        const outgoing = amount(row[`token${index}AmountOut`], token);
        if ((adding && outgoing !== 0n) || (!adding && incoming !== 0n)) throw new Error("Historical position cash flows are ambiguous");
        if (incoming === 0n && outgoing === 0n) continue;
        const unitPrice = price(row[`token${index}Price`]);
        contributedUsd += usd(incoming, token, unitPrice);
        withdrawnUsd += usd(outgoing, token, unitPrice);
      }
    }
    if (liquidity !== currentLiquidity) throw new Error("Analytics history has not caught up with current position liquidity");
    if (!(contributedUsd > 0)) throw new Error("Original position cost is unavailable");
    const currentValueUsd = finite(current.principalUsd + current.uncollectedFeesUsd, "Current position");
    const pnlUsd = finite(currentValueUsd + withdrawnUsd - contributedUsd, "Position return");
    return { status: "estimated", reason: null, pnlUsd, pnlPercent: finite(pnlUsd / contributedUsd * 100, "Position return"),
      contributedUsd: finite(contributedUsd, "Historical additions"), withdrawnUsd: finite(withdrawnUsd, "Historical outputs"), currentValueUsd,
      ...current, source: "ICPSwap analytics", historyThroughMs: history.throughMs, includesNetworkFees: false, settlementVerified: false };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : "Position performance is unavailable", history.throughMs);
  }
}

async function allPages(path: string, query: URLSearchParams, signal?: AbortSignal): Promise<unknown[]> {
  const rows: unknown[] = [], seen = new Set<string>();
  let page = 1, expectedTotal: number | null = null;
  for (;;) {
    signal?.throwIfAborted();
    query.set("page", String(page)); query.set("limit", "100");
    const data = record(await getJson(`${path}?${query}`, signal), "Analytics history page");
    const total = count(data.totalElements, "History count"), actualPage = count(data.page, "History page"), limit = count(data.limit, "History page size");
    if (actualPage !== page || limit === 0 || (expectedTotal !== null && total !== expectedTotal) || !Array.isArray(data.content)) throw new Error("Analytics history changed or has incomplete pagination");
    expectedTotal = total;
    if (data.content.length > limit || rows.length + data.content.length > total) throw new Error("Analytics history returned inconsistent coverage");
    for (const value of data.content) {
      const row = record(value, "Analytics history row");
      const key = path === "/transaction/find" ? row.txHash : `${row.poolId}:${id(row.txId, "Position transfer ID")}`;
      if (typeof key !== "string" || !key || seen.has(key)) throw new Error("Analytics history repeated a page or transaction");
      seen.add(key); rows.push(row);
    }
    if (rows.length === total) return rows;
    if (data.content.length !== limit) throw new Error("Analytics history ended before all records were returned");
    page += 1;
  }
}

/** Pass one historyAtMs for positions from the same live pool snapshot to share
 * its complete history. A refresh replaces the prior snapshot; failed/cancelled
 * reads are discarded rather than poisoning future reads.
 */
export async function fetchPositionPerformance(input: PositionPerformanceInput, options: { signal?: AbortSignal; historyAtMs?: number } = {}): Promise<PositionPerformance> {
  const throughMs = options.historyAtMs ?? Date.now();
  try {
    options.signal?.throwIfAborted();
    currentValues(input);
    if (!Number.isSafeInteger(throughMs) || throughMs <= 0) throw new Error("Position observation time is unavailable");
    const key = `${input.poolId}/${input.owner}`;
    let entry = histories.get(key);
    if (!entry || entry.throughMs !== throughMs) {
      const promise = (async () => {
        const base = { principal: input.owner, end: String(throughMs) };
        const transactions = await allPages("/transaction/find", new URLSearchParams({ ...base, poolId: input.poolId }), options.signal);
        const transfers = await allPages("/record/transferPosition/list", new URLSearchParams({ ...base, poolIds: input.poolId }), options.signal);
        return { transactions, transfers, throughMs };
      })().catch((error: unknown) => {
        if (histories.get(key)?.promise === promise) histories.delete(key);
        throw error;
      });
      entry = { throughMs, promise };
      histories.set(key, entry);
    }
    const history = await entry.promise;
    options.signal?.throwIfAborted();
    return calculatePositionPerformance(input, history);
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : "Position performance is unavailable", throughMs);
  }
}
