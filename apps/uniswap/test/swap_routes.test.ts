import { expect, test } from "bun:test";
import { validate, type Schema } from "jsonschema";
import { decodeFunctionData, encodeFunctionResult, getAddress, parseAbi, zeroAddress, type Hex } from "viem";
import { parseUnifiedSwapInput, prepareUnifiedSwap, quoteUnifiedSwap } from "../src/swap_routes.ts";
import { actionOutputSchema, compactActionResult, parseLiquidityToolInput } from "../src/liquidity_tools.ts";
import type { ActionResult } from "../src/action_workflow.ts";
import type { Reader } from "../src/swap.ts";

const ACCOUNT = getAddress("0x1111111111111111111111111111111111111111");
const RECIPIENT = getAddress("0x2222222222222222222222222222222222222222");
const USDC = getAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
const V3_QUOTER = getAddress("0x61ffe014ba17989e743c5f6cb21bf9697530b21e");
const V3_ROUTER = getAddress("0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45");
const V4_QUOTER = getAddress("0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203");
const V4_ROUTER = getAddress("0x4c82d1fbfe28c977cbb58d8c7ff8fcf9f70a2cca");
const NOW = 1_800_000_000_000;
const account = { accountId: "main" as const, address: ACCOUNT, publicKey: `0x02${"aa".repeat(32)}`, keyFingerprint: "key-one", namespaceVersion: "1" };
const QUOTE3_ABI = parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)"]);
const QUOTE4_ABI = parseAbi(["function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns(uint256 amountOut,uint256 gasEstimate)"]);
const TOKEN_ABI = parseAbi(["function allowance(address owner,address spender) view returns(uint256)", "function approve(address spender,uint256 amount) returns(bool)"]);
const PERMIT_ABI = parseAbi(["function allowance(address owner,address token,address spender) view returns(uint160 amount,uint48 expiration,uint48 nonce)"]);
function input(extra: Record<string, unknown> = {}) { return parseUnifiedSwapInput({ chainId: "1", tokenIn: USDC.toLowerCase(), tokenOut: null, amountIn: "3000000", ...extra }); }
function reader(v3: bigint | Error, v4: bigint | Error) {
  const calls: { to: string; data: Hex }[] = [];
  const read: Reader = async (_chainId, to, data) => {
    calls.push({ to, data });
    let result: Hex;
    if (to === V3_QUOTER) {
      if (v3 instanceof Error) throw v3;
      result = encodeFunctionResult({ abi: QUOTE3_ABI, functionName: "quoteExactInputSingle", result: [v3, 1n << 96n, 0, 90000n] });
    } else if (to === V4_QUOTER) {
      if (v4 instanceof Error) throw v4;
      result = encodeFunctionResult({ abi: QUOTE4_ABI, functionName: "quoteExactInputSingle", result: [v4, 95000n] });
    } else if (to === USDC) result = encodeFunctionResult({ abi: TOKEN_ABI, functionName: "allowance", result: 0n });
    else if (to.toLowerCase() === "0x000000000022d473030f116ddee9f6b43ac78ba3") result = encodeFunctionResult({ abi: PERMIT_ABI, functionName: "allowance", result: [0n, 0, 0] });
    else throw new Error("Optional historical price data unavailable");
    return { data: result, blockNumber: "21000000", observedAtMs: NOW };
  };
  return { read, calls };
}

test("unified swap canonicalizes exact owner inputs and preserves default validity", () => {
  expect(input()).toEqual({ protocol: "auto", chainId: "1", accountId: "main", tokenIn: USDC, tokenOut: null, amountIn: "3000000", recipient: null, slippageBps: 50, quoteValiditySeconds: "1200" });
  expect(() => input({ amountIn: "3e6" })).toThrow("atomic units");
  expect(() => input({ recipient: zeroAddress })).toThrow("nonzero");
  expect(() => input({ hookData: "0x01" })).toThrow("Select v4");
  expect(() => input({ protocol: "v4", hookData: "0x1" })).toThrow("whole hexadecimal bytes");
});

test("auto compares both protocols and chooses the larger atomic output", async () => {
  const fixture = reader(1000n, 1200n), quote = await quoteUnifiedSwap(fixture.read, account, input({ recipient: RECIPIENT }), NOW);
  expect(quote).toMatchObject({ protocol: "v4", amountOut: "1200", minimumOut: "1194", recipient: RECIPIENT, deadline: "1800001200" });
  expect(fixture.calls.filter(({ to }) => to === V3_QUOTER)).toHaveLength(4);
  expect(fixture.calls.filter(({ to }) => to === V4_QUOTER)).toHaveLength(4);
});

test("auto retains the available version and reports the failed comparison", async () => {
  const quote = await quoteUnifiedSwap(reader(1200n, new Error("V4 pool absent")).read, account, input(), NOW);
  expect(quote.protocol).toBe("v3");
  expect(quote.routeWarnings.some((warning) => warning.includes("V4 comparison unavailable"))).toBe(true);
  expect((await quoteUnifiedSwap(reader(1200n, 1200n).read, account, input(), NOW)).protocol).toBe("v3");
});

test("explicit V4 hook pool is not replaced by auto routing", async () => {
  const fixture = reader(9000n, 1200n);
  const poolKey = { currency0: zeroAddress, currency1: USDC, fee: 0x800000, tickSpacing: 20, hooks: getAddress("0x3333333333333333333333333333333333333333") };
  const quote = await quoteUnifiedSwap(fixture.read, account, input({ protocol: "v4", poolKey, hookData: "0xabcd" }), NOW);
  expect(quote).toMatchObject({ protocol: "v4", poolKey, hookData: "0xabcd", amountOut: "1200" });
  expect(fixture.calls.filter(({ to }) => to === V3_QUOTER)).toHaveLength(0);
  expect(fixture.calls.filter(({ to }) => to === V4_QUOTER)).toHaveLength(1);
});

test("both route versions produce an exact approval sequence ending in the swap", async () => {
  for (const protocol of ["v3", "v4"] as const) {
    const plan = await prepareUnifiedSwap(reader(1200n, 1300n).read, account, input({ protocol }), NOW);
    expect(plan.steps.at(-1)).toMatchObject({ kind: "transaction", transaction: { to: protocol === "v3" ? V3_ROUTER : V4_ROUTER } });
    expect(plan.steps).toHaveLength(protocol === "v3" ? 2 : 3);
    const approval = decodeFunctionData({ abi: TOKEN_ABI, data: plan.steps[0]!.transaction.data });
    expect(approval.args?.[1]).toBe(3000000n);
    expect(plan.details.quote).toMatchObject({ protocol, amountIn: "3000000", recipient: ACCOUNT });
  }
});

test("liquidity tool canonicalization preserves zero hard budgets and original range", () => {
  expect(parseLiquidityToolInput({ operationId: "aa".repeat(16), operation: "mint", protocol: "v4", chainId: "1", tokenA: null, tokenB: USDC.toLowerCase(), maxAmountA: "0", maxAmountB: "3000000", tickLower: -100, tickUpper: 100 })).toEqual({ operation: "mint", protocol: "v4", chainId: "1", accountId: "main", tokenA: null, tokenB: USDC, maxAmountA: "0", maxAmountB: "3000000", tickLower: -100, tickUpper: 100, slippageBps: 50, quoteValiditySeconds: 1200 });
});

test("tool continuation preserves the published closed response shape and omits receipt payloads", () => {
  const large: ActionResult = { operationId: "aa".repeat(16), recordId: "bb".repeat(16), state: "pending", phase: "transaction_requested", summary: "Add USDC / ETH liquidity", transactionHash: null, message: "Continue the original action", steps: [{ label: "Approve USDC", kind: "approval", status: "confirmed", transactionHash: `0x${"cc".repeat(32)}`, receipt: { status: "success", blockNumber: "21000001", finality: "included" } }, { label: "Add liquidity", kind: "transaction", status: "pending", transactionHash: null, receipt: null }], positionTokenIds: [], details: { receipt: "x".repeat(100_000), calldata: `0x${"dd".repeat(40_000)}` } };
  const output = compactActionResult(large);
  expect(JSON.stringify(output).length).toBeLessThan(1500);
  expect(output).not.toHaveProperty("details");
  // Already-installed callers validate these four step fields with a closed
  // schema. Internal receipt summaries must not silently extend that contract.
  const publishedStepSchema: Schema = { type: "object", additionalProperties: false, required: ["label", "kind", "status", "transactionHash"], properties: {
    label: { type: "string" }, kind: { type: "string" }, status: { type: "string" }, transactionHash: { oneOf: [{ type: "string" }, { type: "null" }] },
  } };
  expect(output.steps).toEqual([
    { label: "Approve USDC", kind: "approval", status: "confirmed", transactionHash: `0x${"cc".repeat(32)}` },
    { label: "Add liquidity", kind: "transaction", status: "pending", transactionHash: null },
  ]);
  for (const step of output.steps) expect(validate(step, publishedStepSchema).errors).toEqual([]);
  expect(Object.keys(output).sort()).toEqual(["operationId", "recordId", "state", "phase", "summary", "transactionHash", "steps", "positionTokenIds", "message"].sort());
  expect(validate(output, actionOutputSchema as Schema).errors).toEqual([]);
  const properties = actionOutputSchema.properties as Record<string, unknown>;
  expect(properties.steps).toEqual({ type: "array", items: publishedStepSchema });
  expect(output.operationId).toBe(large.operationId);
});
