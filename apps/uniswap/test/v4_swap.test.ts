import { describe, expect, test } from "bun:test";
import { Actions, URVersion, V4Planner } from "@uniswap/v4-sdk";
import { decodeAbiParameters, decodeFunctionData, encodeFunctionResult, getAddress, parseAbi, parseAbiParameters, zeroAddress, type Address, type Hex } from "viem";
import { prepareV4Swap, quoteV4Swap, v4SwapTransaction, type V4QuoteInput } from "../src/v4_swap.ts";
import { v4PoolId, validateV4PoolKey, type V4PoolKey } from "../src/v4_common.ts";
import type { Reader } from "../src/swap.ts";

// Interfaces are independently transcribed from UR2.1.1 / IV4Quoter rather
// than importing production ABI constants. The SDK is a second encoder oracle.
const QUOTE_ABI = parseAbi(["function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)"]);
const ROUTER_ABI = parseAbi(["function execute(bytes commands,bytes[] inputs,uint256 deadline) payable"]);
const SLOT_ABI = parseAbi(["function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)"]);
const TOKEN_ABI = parseAbi(["function allowance(address owner,address spender) view returns (uint256)", "function approve(address spender,uint256 amount) returns (bool)"]);
const PERMIT_ABI = parseAbi(["function allowance(address owner,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)", "function approve(address token,address spender,uint160 amount,uint48 expiration)"]);
const SINGLE = parseAbiParameters("((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)");
const ACCOUNT = getAddress("0x1111111111111111111111111111111111111111");
const RECIPIENT = getAddress("0x2222222222222222222222222222222222222222");
const HOOK = getAddress("0x3333333333333333333333333333333333333333");
const PERMIT2 = getAddress("0x000000000022d473030f116ddee9f6b43ac78ba3");
const NOW = 1_800_000_000_000;
const DEPLOYMENTS = {
  "1": {
    router: getAddress("0x4c82d1fbfe28c977cbb58d8c7ff8fcf9f70a2cca"),
    quoter: getAddress("0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203"),
    state: getAddress("0x7ffe42c4a5deea5b0fec41c94c136cf115597227"),
    usdc: getAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"),
    wrapped: getAddress("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"),
  },
  "42161": {
    router: getAddress("0x8b844f885672f333bc0042cb669255f93a4c1e6b"),
    quoter: getAddress("0x3972c00f7ed4885e145823eb7c655375d275a1c5"),
    state: getAddress("0x76fd297e2d437cd7f76d50f01afe6160f86e9990"),
    usdc: getAddress("0xaf88d065e77c8cc2239327c5edb3a432268e5831"),
    wrapped: getAddress("0x82af49447d8a07e3bd95bd0d56f35241523fbab1"),
  },
} as const;

function input(chainId: keyof typeof DEPLOYMENTS = "1", nativeInput = true): V4QuoteInput {
  const eth = { chainId, address: null, symbol: "ETH", decimals: 18 };
  const usdc = { chainId, address: DEPLOYMENTS[chainId].usdc, symbol: "USDC", decimals: 6 };
  return { chainId, accountId: "primary", accountAddress: ACCOUNT, tokenIn: nativeInput ? eth : usdc, tokenOut: nativeInput ? usdc : eth, amountIn: "1000000", slippageBps: 50, recipient: RECIPIENT, deadline: "1800000600" };
}

type Call = { chainId: string; to: Address; data: Hex; blockTag: string | undefined };
function reader(options: { outputs?: Record<number, bigint | Error>; ercAllowance?: bigint; permitAllowance?: bigint; permitExpiration?: number; stateFails?: boolean; protocolFees?: number } = {}) {
  const calls: Call[] = [];
  const read: Reader = async (chainId, to, data, blockTag) => {
    calls.push({ chainId, to, data, blockTag });
    const deployment = DEPLOYMENTS[chainId as keyof typeof DEPLOYMENTS];
    const result = (value: Hex) => ({ data: value, observedAtMs: NOW - 15, blockNumber: "21000000" });
    if (to === deployment.quoter) {
      const { poolKey } = decodeFunctionData({ abi: QUOTE_ABI, data }).args[0];
      const output = options.outputs ? options.outputs[poolKey.fee] : poolKey.fee === 500 ? 2_000_000n : 1_500_000n;
      if (output instanceof Error) throw output;
      if (output === undefined) throw new Error("Pool not initialized");
      return result(encodeFunctionResult({ abi: QUOTE_ABI, functionName: "quoteExactInputSingle", result: [output, 95_000n] }));
    }
    if (to === deployment.state) {
      if (options.stateFails) throw new Error("Historical block unavailable");
      return result(encodeFunctionResult({ abi: SLOT_ABI, functionName: "getSlot0", result: [2n ** 96n, 0, options.protocolFees ?? 0, 500] }));
    }
    if (to === PERMIT2) {
      expect(decodeFunctionData({ abi: PERMIT_ABI, data })).toMatchObject({ functionName: "allowance", args: [ACCOUNT, deployment.usdc, deployment.router] });
      return result(encodeFunctionResult({ abi: PERMIT_ABI, functionName: "allowance", result: [options.permitAllowance ?? 0n, options.permitExpiration ?? 0, 0] }));
    }
    if (to === deployment.usdc) {
      expect(decodeFunctionData({ abi: TOKEN_ABI, data })).toMatchObject({ functionName: "allowance", args: [ACCOUNT, PERMIT2] });
      return result(encodeFunctionResult({ abi: TOKEN_ABI, functionName: "allowance", result: options.ercAllowance ?? 0n }));
    }
    throw new Error(`Unexpected RPC read ${to}`);
  };
  return { read, calls };
}

function decodeSwap(data: Hex) {
  const decoded = decodeFunctionData({ abi: ROUTER_ABI, data });
  const [commands, inputs, deadline] = decoded.args;
  const [actions, params] = decodeAbiParameters(parseAbiParameters("bytes,bytes[]"), inputs[0]!);
  const [swap] = decodeAbiParameters(SINGLE, params[0]!);
  return { commands, inputs, deadline, actions, params, swap };
}

describe.each(["1", "42161"] as const)("V4 on chain %s", (chainId) => {
  test("native input stays native, pays the explicit recipient, and refunds unused ETH", async () => {
    const { read, calls } = reader();
    const quote = await quoteV4Swap(read, input(chainId), NOW);
    const plan = await prepareV4Swap(read, quote, NOW);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.transaction).toMatchObject({ to: DEPLOYMENTS[chainId].router, value: "1000000", chainId });
    const decoded = decodeSwap(plan.steps[0]!.transaction.data);
    expect(decoded.commands).toBe("0x1004");
    expect(decoded.actions).toBe("0x060c0e");
    expect(decoded.deadline).toBe(1_800_000_600n);
    expect(decoded.swap).toEqual({ poolKey: { currency0: zeroAddress, currency1: DEPLOYMENTS[chainId].usdc, fee: 500, tickSpacing: 10, hooks: zeroAddress }, zeroForOne: true, amountIn: 1_000_000n, amountOutMinimum: 1_990_000n, minHopPriceX36: 0n, hookData: "0x" });
    expect(decodeAbiParameters(parseAbiParameters("address,uint256"), decoded.params[1]!)).toEqual([zeroAddress, 1_000_000n]);
    expect(decodeAbiParameters(parseAbiParameters("address,address,uint256"), decoded.params[2]!)).toEqual([DEPLOYMENTS[chainId].usdc, RECIPIENT, 0n]);
    expect(decodeAbiParameters(parseAbiParameters("address,address,uint256"), decoded.inputs[1]!)).toEqual([zeroAddress, ACCOUNT, 0n]);
    expect(calls.filter((call) => call.to === DEPLOYMENTS[chainId].quoter)).toHaveLength(4);
    expect(calls.every((call) => call.chainId === chainId)).toBe(true);
    expect(calls.find((call) => call.to === DEPLOYMENTS[chainId].state)?.blockTag).toBe("0x1406f40");
  });

  test("token to native plans both exact approvals and takes ETH directly", async () => {
    const { read } = reader();
    const quote = await quoteV4Swap(read, input(chainId, false), NOW);
    const plan = await prepareV4Swap(read, quote, NOW);
    expect(plan.steps.map((step) => step.kind)).toEqual(["approval", "approval", "transaction"]);
    expect(decodeFunctionData({ abi: TOKEN_ABI, data: plan.steps[0]!.transaction.data })).toEqual({ functionName: "approve", args: [PERMIT2, 1_000_000n] });
    expect(decodeFunctionData({ abi: PERMIT_ABI, data: plan.steps[1]!.transaction.data })).toEqual({ functionName: "approve", args: [DEPLOYMENTS[chainId].usdc, DEPLOYMENTS[chainId].router, 1_000_000n, 1_800_000_600] });
    const decoded = decodeSwap(plan.steps[2]!.transaction.data);
    expect(decoded.commands).toBe("0x10");
    expect(decoded.inputs).toHaveLength(1);
    expect(decoded.swap.zeroForOne).toBe(false);
    expect(decodeAbiParameters(parseAbiParameters("address,address,uint256"), decoded.params[2]!)).toEqual([zeroAddress, RECIPIENT, 0n]);
    expect(plan.steps[2]!.transaction.value).toBe("0");
  });
});

test("UR2.1.1 action calldata matches the independently pinned SDK encoder", async () => {
  const quote = await quoteV4Swap(reader().read, input(), NOW);
  const decoded = decodeSwap(v4SwapTransaction(quote, NOW).data);
  const planner = new V4Planner();
  planner.addAction(Actions.SWAP_EXACT_IN_SINGLE, [{ ...decoded.swap, amountIn: decoded.swap.amountIn.toString(), amountOutMinimum: decoded.swap.amountOutMinimum.toString(), minHopPriceX36: "0" }], URVersion.V2_1_1);
  planner.addAction(Actions.SETTLE_ALL, [zeroAddress, quote.amountIn]);
  planner.addAction(Actions.TAKE, [quote.tokenOut.address, quote.recipient, "0"]);
  expect(String(decoded.inputs[0])).toBe(planner.finalize());
  const old = new V4Planner();
  old.addAction(Actions.SWAP_EXACT_IN_SINGLE, [{ ...decoded.swap, amountIn: decoded.swap.amountIn.toString(), amountOutMinimum: decoded.swap.amountOutMinimum.toString() }]);
  expect(old.params[0]).not.toBe(decoded.params[0]);
});

test("existing sufficient approvals are reused and expiring Permit2 allowances are renewed", async () => {
  const enough = reader({ ercAllowance: 2n ** 256n - 1n, permitAllowance: 2n ** 160n - 1n, permitExpiration: 1_800_000_600 });
  const quote = await quoteV4Swap(enough.read, input("1", false), NOW);
  expect((await prepareV4Swap(enough.read, quote, NOW)).steps).toHaveLength(1);
  const deficient = reader({ ercAllowance: 999_999n, permitAllowance: 1_000_000n, permitExpiration: 1_800_000_599 });
  const plan = await prepareV4Swap(deficient.read, quote, NOW);
  expect(plan.steps).toHaveLength(3);
  expect(decodeFunctionData({ abi: TOKEN_ABI, data: plan.steps[0]!.transaction.data }).args).toEqual([PERMIT2, 1_000_000n]);
  expect(decodeFunctionData({ abi: PERMIT_ABI, data: plan.steps[1]!.transaction.data }).args).toEqual([DEPLOYMENTS["1"].usdc, DEPLOYMENTS["1"].router, 1_000_000n, 1_800_000_600]);
});

test("explicit hook pool retains its exact key and hook bytes without imposing V3 fee tiers", async () => {
  const poolKey: V4PoolKey = { currency0: zeroAddress, currency1: DEPLOYMENTS["1"].usdc, fee: 0x800000, tickSpacing: 20, hooks: HOOK };
  const { read, calls } = reader({ outputs: { [0x800000]: 123_456n } });
  const quote = await quoteV4Swap(read, { ...input(), poolKey, hookData: "0xabcd0100" }, NOW);
  expect(quote.poolKey).toEqual(poolKey);
  expect(quote.hookData).toBe("0xabcd0100");
  expect(quote.poolId).toBe(v4PoolId(poolKey));
  expect(quote.priceImpactBps).toBeNull();
  expect(calls).toHaveLength(1);
  expect(decodeFunctionData({ abi: QUOTE_ABI, data: calls[0]!.data }).args[0].hookData).toBe("0xabcd0100");
  expect(decodeSwap(v4SwapTransaction(quote, NOW).data).swap).toMatchObject({ poolKey, hookData: "0xabcd0100" });
});

test("V4 recognizes native ETH and wrapped ETH as different currencies", async () => {
  const request = input();
  request.tokenOut = { ...request.tokenOut, address: DEPLOYMENTS["1"].wrapped, symbol: "WETH", decimals: 18 };
  const quote = await quoteV4Swap(reader().read, request, NOW);
  expect(quote.poolKey.currency0).toBe(zeroAddress);
  expect(quote.poolKey.currency1).toBe(DEPLOYMENTS["1"].wrapped);
});

test("best output wins with deterministic fee tie break and failed candidates remain visible", async () => {
  const progress: string[] = [];
  const quote = await quoteV4Swap(reader({ outputs: { 100: new Error("Missing pool"), 500: 1500n, 3000: 2001n, 10000: 2001n } }).read, input(), NOW, (value) => progress.push(value));
  expect(quote).toMatchObject({ protocol: "v4", fee: 3000, amountOut: "2001", minimumOut: "1990", quotedAtMs: NOW - 15, blockNumber: "21000000" });
  expect(quote.routeWarnings).toEqual(["V4 pool fee 100, spacing 1 unavailable: Error: Missing pool"]);
  expect(progress[0]).toBe("Comparing V4 pools · 0/4");
  expect(progress.at(-1)).toBe("Reading V4 pool price impact…");
});

test("state read failure preserves a successful quote and reports unavailable price impact", async () => {
  const quote = await quoteV4Swap(reader({ stateFails: true }).read, input(), NOW);
  expect(quote.minimumOut).toBe("1990000");
  expect(quote.priceImpactBps).toBeNull();
  expect(quote.routeWarnings).toContain("Price impact unavailable: Error: Historical block unavailable");
});

test("price impact removes the direction-specific protocol fee before comparing pool output", async () => {
  const fixture = reader({ outputs: { 500: 998_900n }, protocolFees: 500 | (1000 << 12) });
  const forward = await quoteV4Swap(fixture.read, input(), NOW);
  const reverse = await quoteV4Swap(fixture.read, input("1", false), NOW);
  // Forward: 0.05% protocol + LP yields 0.1% combined. Reverse: 0.1%
  // protocol + LP yields 0.15%. Their packed fee halves must not be mixed.
  expect(forward.priceImpactBps).toBe("1");
  expect(reverse.priceImpactBps).toBe("-4");
});

test("empty pools and zero or overflowing output cannot produce an executable quote", async () => {
  for (const outputs of [{}, { 500: 0n }, { 500: 2n ** 128n }]) await expect(quoteV4Swap(reader({ outputs }).read, input(), NOW)).rejects.toThrow("No direct V4 pool quote is available");
  await expect(quoteV4Swap(reader({ outputs: { 500: 1n } }).read, input(), NOW)).rejects.toThrow("Minimum received rounds to zero");
});

test("expired or mismatched serialized quote fails before approval reads", async () => {
  const quote = await quoteV4Swap(reader().read, input("1", false), NOW);
  const changed = [
    { ...quote, protocol: "v3" }, { ...quote, router: HOOK }, { ...quote, quoter: HOOK },
    { ...quote, fee: 3000 }, { ...quote, poolId: `0x${"00".repeat(32)}` },
    { ...quote, poolKey: { ...quote.poolKey, currency1: HOOK } },
    { ...quote, minimumOut: "2000000" }, { ...quote, amountOut: (2n ** 128n).toString() },
    { ...quote, deadline: "1800000000" }, { ...quote, hookData: "0xabc" },
  ];
  let reads = 0;
  const noReads: Reader = async () => { reads += 1; throw new Error("Unexpected read"); };
  for (const value of changed) await expect(prepareV4Swap(noReads, value as typeof quote, NOW)).rejects.toThrow();
  expect(reads).toBe(0);
});

test("pool validation follows V4 protocol bounds and exact currency ordering", async () => {
  const key: V4PoolKey = { currency0: zeroAddress, currency1: DEPLOYMENTS["1"].usdc, fee: 1234, tickSpacing: 20, hooks: zeroAddress };
  expect(validateV4PoolKey(key)).toEqual(key);
  for (const bad of [{ ...key, fee: -1 }, { ...key, fee: 1_000_001 }, { ...key, fee: 0x800001 }, { ...key, tickSpacing: 0 }, { ...key, tickSpacing: 32768 }, { ...key, currency0: key.currency1 }, { ...key, currency0: key.currency1, currency1: zeroAddress }]) expect(() => validateV4PoolKey(bad)).toThrow();
  for (const amountIn of ["0", "1\n", (2n ** 128n).toString()]) await expect(quoteV4Swap(reader().read, { ...input(), amountIn }, NOW)).rejects.toThrow();
  await expect(quoteV4Swap(reader().read, { ...input(), poolKey: { ...key, currency1: HOOK } }, NOW)).rejects.toThrow("currencies do not match");
  await expect(quoteV4Swap(reader().read, { ...input(), tokenIn: { ...input().tokenIn, address: zeroAddress } }, NOW)).rejects.toThrow("Select ETH as the native currency");
});
