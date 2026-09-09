import { describe, expect, test } from "bun:test";
import { normalizeToolDescriptor, validateToolResult, type JsonObject, type MsgBusToolContext, type MsgBusToolHandler } from "neutron-tools/app";
import { swapQuoteOutputSchema, liquidityQuoteOutputSchema } from "../src/quote_schema.ts";
import { registerTools } from "../src/tools.ts";
import { createActionHandlers, registerActionTools } from "../src/action_tools.ts";
import type { ActionBackend } from "../src/action_backend.ts";
import type { BrowserPoolView } from "../src/liquidity_reads.ts";
import { Q96 } from "../src/liquidity_math.ts";

const OWNER = "3rurp-vyaaa-aaaay-aacua-cai", POOL = "mohjv-bqaaa-aaaag-qjyia-cai";
const ICP = "ryjl3-tyaaa-aaaaa-aaaba-cai", USDC = "xevnm-gaaaa-aaaar-qafnq-cai";
const context: MsgBusToolContext = { kernel: {} as MsgBusToolContext["kernel"], reportProgress() {} };
const descriptor = (name: string, outputSchema: JsonObject) => normalizeToolDescriptor({
  name, inputSchema: { type: "object" }, outputSchema,
});
const swapDescriptor = descriptor("icpswap_quote_swap", swapQuoteOutputSchema);
const liquidityDescriptor = descriptor("icpswap_liquidity_quote_v1", liquidityQuoteOutputSchema);

async function swapResult() {
  let handler: MsgBusToolHandler | undefined;
  registerTools({
    accountFor: async () => { throw new Error("A public swap preview does not need an account read"); },
    backendFor: () => { throw new Error("No backend request expected"); },
    tokenInfoFor: async (_context, ledger) => ({ ledger, account: OWNER, name: null, symbol: ledger === ICP ? "ICP" : "ckUSDC",
      decimals: ledger === ICP ? 8 : 6, feeAtoms: 10000n, balanceAtoms: 0n, observedAtNs: 1n }),
    quotes: {
      preparePair: async () => undefined,
      quote: async (request) => ({
        pool: POOL, poolKey: "ICP_USDC_3000", feeTier: 3000, inputAddress: ICP, outputAddress: USDC,
        decimalsIn: 8, decimalsOut: 6, zeroForOne: true, amountIn: request.amountIn,
        quotedOut: 289584n, amountOutMinimum: 288143n, expectedOut: 279584n,
        tokenInFee: 10000n, tokenOutFee: 10000n, fundingAmount: request.amountIn,
        totalDebit: request.amountIn + 20000n, priceImpact: 0.0030003, warn: false,
        slippage: 500, fundingLedger: ICP, fundingSpender: POOL, at: 1788917400, contextAt: 1788917390,
      }),
    },
    expose: (name, options, current) => {
      if (name === "icpswap_quote_swap") {
        expect(normalizeToolDescriptor({ name, ...options }).outputSchema).toEqual(swapQuoteOutputSchema);
        handler = current;
      }
    },
  });
  return await handler!({ from_ledger_id: ICP, to_ledger_id: USDC, amount: "10000000", slippage: 500 }, context) as JsonObject;
}

function poolView(fees0 = "429", fees1 = "0"): BrowserPoolView {
  return {
    pool: { pool: POOL, key: "ICP_USDC_3000", token0: { address: ICP, standard: "ICRC2" }, token1: { address: USDC, standard: "ICRC2" }, fee: 3000, tickSpacing: 60 },
    owner: OWNER, metadata: { sqrtPriceX96: Q96.toString(), tick: 0, liquidity: "100000000" },
    positions: [{ id: "5090", tickLower: -60, tickUpper: 120, liquidity: "123456", amount0: "738", amount1: "369", tokensOwed0: fees0, tokensOwed1: fees1, feeError: null }],
    unused: { balance0: "100000", balance1: "100000" }, reserved: { balance0: "0", balance1: "0" },
    availableUnused: { balance0: "100000", balance1: "100000" }, cachedFees: { token0Fee: "10000", token1Fee: "10000" },
    available: true, withdrawals: [], transactions: [], errors: [],
    source: { kind: "direct-canister-query", host: "https://icp-api.io", observedAt: "2026-09-09T01:30:00.123Z" },
  };
}

async function liquidityResult(kind: string, view = poolView()) {
  const handlers = createActionHandlers({
    backendFor: () => ({ account: async () => OWNER } as ActionBackend),
    authorize: async () => { throw new Error("A quote cannot request approval"); },
    reads: { readPool: async () => view },
  });
  return handlers.liquidityQuote({ kind, pool: POOL,
    ...(kind === "mint" || kind === "withdraw" ? {} : { positionId: "5090" }),
    amount0: "1000000", amount1: "2000000", tickLower: -60, tickUpper: 120,
    liquidity: "30864", token: ICP, amount: "50000",
  }, context);
}

describe("versioned public quote output contracts", () => {
  test("registered liquidity descriptor exposes the same validated contract as the handler result", () => {
    let registered = false;
    registerActionTools({
      backendFor: () => { throw new Error("Registration must not read state"); },
      authorize: async () => { throw new Error("Registration must not prompt"); },
    }, (name, options) => {
      if (name === "icpswap_liquidity_quote_v1") {
        expect(normalizeToolDescriptor({ name, ...options }).outputSchema).toEqual(liquidityQuoteOutputSchema);
        registered = true;
      }
    });
    expect(registered).toBe(true);
  });

  test("real swap tool output validates, with report 7's gross minimum above the net expectation", async () => {
    const result = await swapResult();
    expect(() => validateToolResult(swapDescriptor, result)).not.toThrow();
    expect(result).toMatchObject({ version: 1, quoted_out_gross: "289584", expected_out: "279584",
      minimum_out: "288143", minimum_out_gross: "288143", minimum_out_net_estimate: "278143",
      total_debited: "10020000", context_as_of: "2026-09-09T01:29:50.000Z" });
    expect(289584n * 100000n / (100000n + 500n)).toBe(288143n);
    const properties = swapQuoteOutputSchema.properties as JsonObject;
    expect((properties.minimum_out as JsonObject).description).toContain("DEPRECATED");
    expect((properties.minimum_out as JsonObject).description).toContain("GROSS");
    expect((properties.minimum_out_gross as JsonObject).description).toContain("100000 + slippage_thousandths_percent");
  });

  test.each(["mint", "increase", "decrease", "close", "claim", "withdraw"])("actual %s quote handler validates without a save, approval or execution", async (kind) => {
    const result = await liquidityResult(kind);
    expect(() => validateToolResult(liquidityDescriptor, result)).not.toThrow();
    const plan = result.plan as JsonObject;
    expect(plan.version).toBe(1);
    expect(plan.price_protection).toBe(false);
    const deposit = kind === "mint" || kind === "increase";
    expect(plan.amount_semantics).toBe(deposit ? "input_consumption" : "gross_pool_output");
    if (deposit) expect(plan).toMatchObject({ expected_net_amount0: null, expected_net_amount1: null, payout0: "not_applicable", payout1: "not_applicable", warnings: [] });
    if (kind === "withdraw") expect(plan).toMatchObject({ expected_amount0: "50000", expected_net_amount0: "40000", payout0: "transfer_estimated", payout1: "no_output" });
  });

  test.each(["429", "10000"])("claim gross %s at or below the fee remains pool credit, not a promised Wallet credit or fee debit", async (fees0) => {
    const result = await liquidityResult("claim", poolView(fees0));
    expect(() => validateToolResult(liquidityDescriptor, result)).not.toThrow();
    const plan = result.plan as JsonObject;
    expect(plan).toMatchObject({ expected_amount0: fees0, expected_amount1: "0", expected_net_amount0: "0", expected_net_amount1: "0", payout0: "retained_in_pool", payout1: "no_output" });
    expect(plan.warnings).toHaveLength(1);
    expect((plan.warnings as string[])[0]).toContain("No Wallet transfer is expected; the amount would remain in your pool balance.");
  });

  test("zero-fee and positive transferable claims remain distinct estimates", async () => {
    const zero = await liquidityResult("claim", poolView("0", "0"));
    expect(() => validateToolResult(liquidityDescriptor, zero)).not.toThrow();
    expect(zero.plan).toMatchObject({ payout0: "no_output", payout1: "no_output", warnings: [] });
    const above = await liquidityResult("claim", poolView("10001", "21000"));
    expect(() => validateToolResult(liquidityDescriptor, above)).not.toThrow();
    expect(above.plan).toMatchObject({ expected_net_amount0: "1", expected_net_amount1: "11000", payout0: "transfer_estimated", payout1: "transfer_estimated", warnings: [] });
  });

  test("partial read errors and unknown unrelated position fees remain typed nulls", async () => {
    const view = poolView();
    view.positions!.push({ id: "5091", tickLower: -120, tickUpper: 120, liquidity: "9007199254740993123", amount0: null, amount1: null, tokensOwed0: null, tokensOwed1: null, feeError: "Position query unavailable" });
    view.errors.push({ canister: POOL, method: "getUserPosition", message: "Position query unavailable" });
    const result = await liquidityResult("claim", view);
    expect(() => validateToolResult(liquidityDescriptor, result)).not.toThrow();
    expect(((result.plan as JsonObject).baseline_positions as JsonObject[])[1]).toMatchObject({ amount0: null, amount1: null, fees0: null, fees1: null, fees_current: false });
  });

  test("SDK rejects schema drift in version, exact atom types, missing accounting fields and unknown fields", async () => {
    const swap = await swapResult();
    for (const patch of [{ version: 2 }, { quoted_out_gross: 289584 }, { minimum_out_net_estimate: null }, { unexpected: true }]) {
      expect(() => validateToolResult(swapDescriptor, { ...swap, ...patch })).toThrow("Invalid result");
    }
    const missing = { ...swap }; delete missing.minimum_out_net_estimate;
    expect(() => validateToolResult(swapDescriptor, missing)).toThrow("Invalid result");
    const liquidity = await liquidityResult("claim");
    for (const patch of [{ version: 2 }, { expected_amount0: 429 }, { payout0: "settled" }, { expected_net_amount0: -1 }, { warnings: [null] }]) {
      expect(() => validateToolResult(liquidityDescriptor, { ...liquidity, plan: { ...(liquidity.plan as JsonObject), ...patch } })).toThrow("Invalid result");
    }
  });
});
