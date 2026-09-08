import { afterEach, describe, expect, test } from "bun:test";
import { invalidateCache } from "../src/api.ts";
import { calculatePositionPerformance, fetchPositionPerformance, invalidatePositionPerformanceCache, type PositionPerformanceInput } from "../src/position_performance.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; invalidateCache(); invalidatePositionPerformanceCache(); });
const POOL = "mohjv-bqaaa-aaaag-qjyia-cai", OWNER = "3rurp-vyaaa-aaaay-aacua-cai";
const ICP = "ryjl3-tyaaa-aaaaa-aaaba-cai", USD = "xevnm-gaaaa-aaaar-qafnq-cai";
const throughMs = 1_788_910_000_000;
function input(): PositionPerformanceInput {
  return { poolId: POOL, owner: OWNER, positionId: "5088", liquidity: "150",
    token0: { ledgerId: ICP, decimals: 8, amountAtoms: "400000000", feesAtoms: "10000000", priceUsd: 4 },
    token1: { ledgerId: USD, decimals: 6, amountAtoms: "2000000", feesAtoms: "500000", priceUsd: 1 } };
}
function row(actionType: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { poolId: POOL, positionId: 5088, txHash: `${POOL}1`, txTime: throughMs - 1000,
    fromPrincipalId: OWNER, fromSubaccount: "0".repeat(64), token0LedgerId: ICP, token1LedgerId: USD,
    token0AmountIn: "0", token1AmountIn: "0", token0AmountOut: "0", token1AmountOut: "0",
    token0Price: "2", token1Price: "1", liquidity: "0", actionType, ...overrides };
}
function lifecycle(): Record<string, unknown>[] {
  return [
    row("Claim", { txHash: `${POOL}4`, txTime: throughMs - 1000, token0AmountOut: "0.1", token1AmountOut: "0.5", token0Price: "4" }),
    row("DecreaseLiquidity", { txHash: `${POOL}3`, txTime: throughMs - 2000, liquidity: "50", token0AmountOut: "1", token1AmountOut: "1", token0Price: "3" }),
    row("AddLiquidity", { txHash: `${POOL}2`, txTime: throughMs - 3000, liquidity: "100", token0AmountIn: "1", token1AmountIn: "1", token0Price: "3" }),
    row("AddLiquidity", { txHash: `${POOL}1`, txTime: throughMs - 4000, liquidity: "100", token0AmountIn: "2", token1AmountIn: "1" }),
  ];
}
const calculate = (transactions = lifecycle(), snapshot = input(), transfers: unknown[] = []) => calculatePositionPerformance(snapshot, { transactions, transfers, throughMs });

describe("position performance accounting", () => {
  test("uses actual multiple additions, gross partial removals, claims and current uncollected fees", () => {
    const result = calculate();
    expect(result.status).toBe("estimated");
    expect(result.contributedUsd).toBe(9); // 2 ICP at $2 + $1, then 1 ICP at $3 + $1.
    expect(result.withdrawnUsd).toBeCloseTo(4.9); // Principal withdrawal $4, claim $0.9.
    expect(result.principalUsd).toBe(18);
    expect(result.uncollectedFeesUsd).toBeCloseTo(0.9);
    expect(result.currentValueUsd).toBeCloseTo(18.9);
    expect(result.pnlUsd).toBeCloseTo(14.8);
    expect(result.pnlPercent).toBeCloseTo(14.8 / 9 * 100);
    expect(result.includesNetworkFees).toBe(false);
    expect(result.settlementVerified).toBe(false);
  });

  test("report 4 closed lifecycle retains two-atom rounding loss instead of counting principal as profit", () => {
    const snapshot = input(); snapshot.liquidity = "0";
    for (const token of [snapshot.token0, snapshot.token1]) { token.amountAtoms = "0"; token.feesAtoms = "0"; }
    const token0Price = "2.9471138648681099";
    const transactions = [
      row("DecreaseLiquidity", { txHash: "closed", txTime: throughMs - 1, token0Price, liquidity: "142756134", token0AmountOut: "0.0726507", token1AmountOut: "0.224999" }),
      row("DecreaseLiquidity", { txHash: "partial", txTime: throughMs - 2, token0Price, liquidity: "47585378", token0AmountOut: "0.0242169", token1AmountOut: "0.074999" }),
      row("Claim", { txHash: "claim", txTime: throughMs - 3, token0Price }),
      row("AddLiquidity", { txHash: "mint", txTime: throughMs - 4, token0Price, liquidity: "190341512", token0AmountIn: "0.09686762", token1AmountIn: "0.3" }),
    ];
    const result = calculate(transactions, snapshot);
    expect(result.status).toBe("estimated");
    expect(result.pnlUsd).toBeCloseTo(-2e-8 * Number(token0Price) - 2e-6, 12);
    expect(result.includesNetworkFees).toBe(false);
  });

  test("rejects missing acquisition, mismatched liquidity and unknown ownership basis", () => {
    expect(calculate(lifecycle().slice(0, 3)).status).toBe("unavailable");
    expect(calculate([lifecycle()[0]!]).reason).toContain("Original liquidity addition");
    const snapshot = input(); snapshot.liquidity = "151";
    expect(calculate(lifecycle(), snapshot).reason).toContain("caught up");
    expect(calculate(lifecycle(), input(), [{ poolId: POOL, positionId: 5088 }]).reason).toContain("transferred");
  });

  test("unknown current fees or missing historical/current prices never become zero P&L", () => {
    const snapshot = input(); snapshot.token0.feesAtoms = null;
    expect(calculate(lifecycle(), snapshot)).toMatchObject({ status: "unavailable", pnlUsd: null });
    snapshot.token0.feesAtoms = "0"; snapshot.token0.priceUsd = null;
    expect(calculate(lifecycle(), snapshot).reason).toContain("prices");
    const transactions = lifecycle(); transactions[3]!.token0Price = "";
    expect(calculate(transactions).status).toBe("unavailable");
    transactions[3]!.token0Price = "0";
    expect(calculate(transactions).status).toBe("unavailable");
  });

  test("unavailable event price is harmless only for a provably zero cash flow", () => {
    const transactions = lifecycle(); transactions[0]!.token0AmountOut = "0"; transactions[0]!.token1AmountOut = "0";
    transactions[0]!.token0Price = ""; transactions[0]!.token1Price = "";
    expect(calculate(transactions).status).toBe("estimated");
  });

  test.each([
    { token0LedgerId: USD }, { fromPrincipalId: "other-owner" }, { fromSubaccount: "1".repeat(64) },
    { token0AmountIn: "garbage" }, { token0AmountIn: "0.000000001" }, { token0AmountOut: "1" },
    { txTime: throughMs + 1 }, { positionId: 9007199254740992 }, { liquidity: "wrong" },
  ])("rejects incomplete or contradictory event fields %j", (change) => {
    const transactions = lifecycle(); Object.assign(transactions[3]!, change);
    expect(calculate(transactions).status).toBe("unavailable");
  });

  test("does not round unsafe position IDs or process unsupported position actions", () => {
    expect(calculate([row("Mint", { liquidity: "150" })]).status).toBe("unavailable");
    const transactions = lifecycle(); transactions[0]!.liquidity = "1";
    expect(calculate(transactions).reason).toContain("unexpected liquidity");
    transactions[0]!.liquidity = "0"; transactions[0]!.txHash = transactions[1]!.txHash;
    expect(calculate(transactions).reason).toContain("duplicate");
  });
});

function mockPages(handler: (url: URL) => unknown): URL[] {
  const seen: URL[] = [];
  globalThis.fetch = (async (request) => {
    const url = new URL(String(request)); seen.push(url);
    return new Response(JSON.stringify({ code: 200, data: handler(url) }));
  }) as typeof fetch;
  return seen;
}
function page(content: unknown[], totalElements = content.length, number = 1, limit = 100): unknown {
  return { content, totalElements, page: number, limit };
}

describe("complete analytics position history", () => {
  test("paginates every pool-owner record and transfer page; filters positions locally and caches one snapshot", async () => {
    const transactions = [row("Swap", { positionId: 0, txHash: "unrelated" }), ...lifecycle()];
    const transfers = [{ poolId: POOL, positionId: 7, txId: 10 }, { poolId: POOL, positionId: 8, txId: 11 }];
    const seen = mockPages((url) => {
      const number = Number(url.searchParams.get("page"));
      const rows = url.pathname.endsWith("/transaction/find") ? transactions : transfers;
      return page(rows.slice((number - 1) * 2, number * 2), rows.length, number, 2);
    });
    expect((await fetchPositionPerformance(input(), { historyAtMs: throughMs })).status).toBe("estimated");
    expect(seen).toHaveLength(4);
    for (const url of seen) {
      expect(url.searchParams.get("positionId")).toBeNull();
      expect(url.searchParams.get("principal")).toBe(OWNER);
      expect(url.searchParams.get("end")).toBe(String(throughMs));
      expect(url.searchParams.get(url.pathname.endsWith("/transaction/find") ? "poolId" : "poolIds")).toBe(POOL);
    }
    expect((await fetchPositionPerformance(input(), { historyAtMs: throughMs })).status).toBe("estimated");
    expect(seen).toHaveLength(4);
  });

  test("transfer discovery failure leaves cost basis unavailable", async () => {
    mockPages((url) => url.pathname.endsWith("/transaction/find") ? page(lifecycle()) : { content: [], page: 1, limit: 100 });
    expect((await fetchPositionPerformance(input(), { historyAtMs: throughMs })).status).toBe("unavailable");
  });

  test("a new pool snapshot replaces the previous cached full history", async () => {
    const seen = mockPages((url) => page(url.pathname.endsWith("/transaction/find") ? lifecycle() : []));
    expect((await fetchPositionPerformance(input(), { historyAtMs: throughMs })).status).toBe("estimated");
    expect((await fetchPositionPerformance(input(), { historyAtMs: throughMs + 1 })).status).toBe("estimated");
    expect((await fetchPositionPerformance(input(), { historyAtMs: throughMs + 1 })).status).toBe("estimated");
    expect(seen).toHaveLength(4);
    // The old timestamp was evicted, rather than retaining all refresh history.
    expect((await fetchPositionPerformance(input(), { historyAtMs: throughMs })).status).toBe("estimated");
    expect(seen).toHaveLength(6);
  });

  test.each(["duplicate", "missing", "changed", "wrong-page"])("does not accept %s pagination as complete", async (fault) => {
    mockPages((url) => {
      const number = Number(url.searchParams.get("page"));
      if (number === 1) return page(lifecycle().slice(0, 2), 4, 1, 2);
      if (fault === "duplicate") return page(lifecycle().slice(0, 2), 4, 2, 2);
      if (fault === "missing") return page([], 4, 2, 2);
      if (fault === "changed") return page(lifecycle().slice(2), 5, 2, 2);
      return page(lifecycle().slice(2), 4, 1, 2);
    });
    expect((await fetchPositionPerformance(input(), { historyAtMs: throughMs })).status).toBe("unavailable");
  });

  test("aborted reads do not poison a subsequent refresh", async () => {
    const controller = new AbortController(); controller.abort();
    const seen = mockPages((url) => page(url.pathname.endsWith("/transaction/find") ? lifecycle() : []));
    const cancelled = await fetchPositionPerformance(input(), { signal: controller.signal, historyAtMs: throughMs });
    expect(cancelled.status).toBe("unavailable"); expect(seen).toHaveLength(0);
    expect((await fetchPositionPerformance(input(), { historyAtMs: throughMs })).status).toBe("estimated");
    expect(seen).toHaveLength(2);
  });

  test("cancellation during a page request discards that in-flight cached history", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const active = new Promise<void>((resolve) => { started = resolve; });
    globalThis.fetch = ((_request, options) => new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      started();
    })) as typeof fetch;
    const pending = fetchPositionPerformance(input(), { signal: controller.signal, historyAtMs: throughMs });
    await active; controller.abort();
    expect((await pending).status).toBe("unavailable");
    const seen = mockPages((url) => page(url.pathname.endsWith("/transaction/find") ? lifecycle() : []));
    expect((await fetchPositionPerformance(input(), { historyAtMs: throughMs })).status).toBe("estimated");
    expect(seen).toHaveLength(2);
  });
});
