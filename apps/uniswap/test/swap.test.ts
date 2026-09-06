import { describe, expect, test } from "bun:test";
import { decodeFunctionData, encodeFunctionResult, getAddress, parseAbi, type Address, type Hex } from "viem";
import {
  amountAtoms, customToken, defaultTokens, network, prepareSwap, quoteSwap,
  slippageBasisPoints, swapTransaction, validateInput, type QuoteInput, type Reader,
} from "../src/swap.ts";

// Independent contract interfaces: SwapRouter02 / IV3SwapRouter, QuoterV2,
// IUniswapV3Factory, and IUniswapV3PoolState from the official Uniswap repos.
// These tests deliberately do not import the application's ABIs or addresses.
const ROUTER = getAddress("0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45");
const QUOTER = getAddress("0x61ffe014ba17989e743c5f6cb21bf9697530b21e");
const FACTORY = getAddress("0x1f98431c8ad98523631ae4a59f267346ea31f984");
const ACCOUNT = getAddress("0x1111111111111111111111111111111111111111");
const RECIPIENT = getAddress("0x2222222222222222222222222222222222222222");
const POOL = getAddress("0x3333333333333333333333333333333333333333");
const CUSTOM = getAddress("0x4444444444444444444444444444444444444444");
const NOW = 1_800_000_000_000;
const DEPLOYMENTS = {
  "1": { wrapped: getAddress("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"), usdc: getAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48") },
  "42161": { wrapped: getAddress("0x82af49447d8a07e3bd95bd0d56f35241523fbab1"), usdc: getAddress("0xaf88d065e77c8cc2239327c5edb3a432268e5831") },
} as const;
const routerAbi = parseAbi([
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function unwrapWETH9(uint256 amountMinimum,address recipient) payable",
  "function refundETH() payable",
]);
const quoteAbi = parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)"]);
const tokenAbi = parseAbi([
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)", "function symbol() view returns (string)",
]);
const factoryAbi = parseAbi(["function getPool(address tokenA,address tokenB,uint24 fee) view returns (address pool)"]);
const poolAbi = parseAbi(["function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)"]);

function input(chainId: keyof typeof DEPLOYMENTS = "1", direction: "native-token" | "token-native" | "token-token" = "native-token"): QuoteInput {
  const deployment = DEPLOYMENTS[chainId];
  const native = { chainId, address: null, symbol: "ETH", decimals: 18 };
  const usdc = { chainId, address: deployment.usdc, symbol: "USDC", decimals: 6 };
  const wrapped = { chainId, address: deployment.wrapped, symbol: "WETH", decimals: 18 };
  return { chainId, accountId: "primary", accountAddress: ACCOUNT, tokenIn: direction === "native-token" ? native : usdc,
    tokenOut: direction === "native-token" ? usdc : direction === "token-native" ? native : wrapped,
    amountIn: "1000000", slippageBps: 50, recipient: RECIPIENT, deadline: "1800000600" };
}

type ReadCall = { chainId: string; to: Address; data: Hex; blockTag: string | undefined };
function reader(options: { outputs?: Partial<Record<number, bigint | Error>>; allowance?: bigint; impactFails?: boolean; blockNumber?: string | null; sqrtPriceX96?: bigint } = {}) {
  const calls: ReadCall[] = [];
  const read: Reader = async (chainId, to, data, blockTag) => {
    calls.push({ chainId, to, data, blockTag });
    const result = (data: Hex) => ({ data, blockNumber: options.blockNumber === undefined ? "21000000" : options.blockNumber, observedAtMs: NOW - 123 });
    if (to === QUOTER) {
      const decoded = decodeFunctionData({ abi: quoteAbi, data });
      const fee = decoded.args[0].fee;
      const output = options.outputs ? options.outputs[fee] : fee === 500 ? 2_000_000n : 1_800_000n;
      if (output instanceof Error) throw output;
      if (output === undefined) throw new Error("No liquidity");
      return result(encodeFunctionResult({ abi: quoteAbi, functionName: "quoteExactInputSingle", result: [output, 2n ** 96n, 1, 90_000n] }));
    }
    if (to === FACTORY) {
      if (options.impactFails) throw new Error("Factory unavailable");
      return result(encodeFunctionResult({ abi: factoryAbi, functionName: "getPool", result: POOL }));
    }
    if (to === POOL) return result(encodeFunctionResult({ abi: poolAbi, functionName: "slot0", result: [options.sqrtPriceX96 ?? 2n ** 96n, 0, 0, 1, 1, 0, true] }));
    const decoded = decodeFunctionData({ abi: tokenAbi, data });
    if (decoded.functionName === "allowance") return result(encodeFunctionResult({ abi: tokenAbi, functionName: "allowance", result: options.allowance ?? 0n }));
    throw new Error(`Unexpected contract read: ${to} ${data}`);
  };
  return { read, calls };
}

function word(value: string | bigint | number): string {
  return (typeof value === "string" ? value.replace(/^0x/, "").toLowerCase() : BigInt(value).toString(16)).padStart(64, "0");
}
function unwrapMulticall(data: Hex) {
  expect(data.slice(0, 10)).toBe("0x5ae401dc");
  const decoded = decodeFunctionData({ abi: routerAbi, data });
  if (decoded.functionName !== "multicall") throw new Error("Expected deadline multicall");
  return decoded.args;
}

describe.each(["1", "42161"] as const)("Uniswap deployment on chain %s", (chainId) => {
  test("native input funds exactly one swap and returns unused ETH", async () => {
    const { read, calls } = reader();
    const request = input(chainId);
    const quote = await quoteSwap(read, request, NOW);
    const prepared = await prepareSwap(read, quote, NOW);
    expect(prepared.approval).toBeNull();
    expect(prepared.allowance).toBeNull();
    expect(prepared.swap).toMatchObject({ chainId, accountId: "primary", to: ROUTER, value: "1000000" });
    const [deadline, data] = unwrapMulticall(prepared.swap.data);
    expect(deadline).toBe(1_800_000_600n);
    expect(data).toHaveLength(2);
    // Static ABI words provide a vector independent of viem's encoder.
    expect(data[0]).toBe(`0x04e45aaf${word(DEPLOYMENTS[chainId].wrapped)}${word(DEPLOYMENTS[chainId].usdc)}${word(500)}${word(RECIPIENT)}${word(1_000_000n)}${word(1_990_000n)}${word(0)}`);
    expect(data[1]).toBe("0x12210e8a");
    expect(calls.every((call) => call.chainId === chainId)).toBe(true);
    const quoteCalls = calls.filter((call) => call.to === QUOTER);
    expect(quoteCalls).toHaveLength(4);
    for (const call of quoteCalls) {
      expect(call.data.slice(0, 10)).toBe("0xc6a5026a");
      expect(decodeFunctionData({ abi: quoteAbi, data: call.data }).args[0]).toMatchObject({ tokenIn: DEPLOYMENTS[chainId].wrapped, tokenOut: DEPLOYMENTS[chainId].usdc, amountIn: 1_000_000n, sqrtPriceLimitX96: 0n });
    }
  });

  test("native output is received by router then unwrapped to the requested recipient", async () => {
    const { read } = reader();
    const quote = await quoteSwap(read, input(chainId, "token-native"), NOW);
    const prepared = await prepareSwap(read, quote, NOW);
    expect(prepared.swap.value).toBe("0");
    const [, data] = unwrapMulticall(prepared.swap.data);
    expect(data).toHaveLength(2);
    const swap = decodeFunctionData({ abi: routerAbi, data: data[0]! });
    if (swap.functionName !== "exactInputSingle") throw new Error("Expected exactInputSingle");
    expect(swap.args[0]).toEqual({ tokenIn: DEPLOYMENTS[chainId].usdc, tokenOut: DEPLOYMENTS[chainId].wrapped, fee: 500, recipient: ROUTER, amountIn: 1_000_000n, amountOutMinimum: 1_990_000n, sqrtPriceLimitX96: 0n });
    expect(data[1]).toBe(`0x49404b7c${word(1_990_000n)}${word(RECIPIENT)}`);
    expect(prepared.approval).toMatchObject({ chainId, accountId: "primary", to: DEPLOYMENTS[chainId].usdc, value: "0" });
    expect(prepared.approval!.data).toBe(`0x095ea7b3${word(ROUTER)}${word(1_000_000n)}`);
  });

  test.each([0n, 999_999n, 1_000_000n, 2n ** 256n - 1n])("token input allowance %s only requests an exact approval when needed", async (allowance) => {
    const { read, calls } = reader({ allowance });
    const quote = await quoteSwap(read, input(chainId, "token-token"), NOW);
    const prepared = await prepareSwap(read, quote, NOW);
    expect(prepared.allowance).toBe(allowance.toString());
    expect(prepared.swap.value).toBe("0");
    const [, data] = unwrapMulticall(prepared.swap.data);
    expect(data).toHaveLength(1);
    const swap = decodeFunctionData({ abi: routerAbi, data: data[0]! });
    if (swap.functionName !== "exactInputSingle") throw new Error("Expected exactInputSingle");
    expect(swap.args[0].recipient).toBe(RECIPIENT);
    if (allowance >= 1_000_000n) expect(prepared.approval).toBeNull();
    else expect(prepared.approval!.data).toBe(`0x095ea7b3${word(ROUTER)}${word(1_000_000n)}`);
    const allowanceCall = calls.find((call) => call.to === DEPLOYMENTS[chainId].usdc)!;
    expect(allowanceCall.data).toBe(`0xdd62ed3e${word(ACCOUNT)}${word(ROUTER)}`);
  });
});

test("quotes choose the greatest output, break ties by fee, and retain failed-pool warnings", async () => {
  const { read, calls } = reader({ outputs: { 100: new Error("missing pool"), 500: 1_500n, 3000: 2_001n, 10000: 2_001n } });
  const quote = await quoteSwap(read, input(), NOW);
  expect(quote).toMatchObject({ fee: 3000, amountOut: "2001", minimumOut: "1990", blockNumber: "21000000", quotedAtMs: NOW - 123, gasEstimate: "90000", pool: POOL });
  expect(quote.routeWarnings).toEqual(["0.01% pool unavailable: Error: missing pool"]);
  const factory = calls.find((call) => call.to === FACTORY)!;
  expect(factory.blockTag).toBe("0x1406f40");
  expect(decodeFunctionData({ abi: factoryAbi, data: factory.data }).args).toEqual([DEPLOYMENTS["1"].wrapped, DEPLOYMENTS["1"].usdc, 3000]);
  expect(calls.find((call) => call.to === POOL)?.blockTag).toBe(factory.blockTag);
});

test("independent fee tiers share one read round and retain each failure", async () => {
  const fixture = reader({ outputs: { 100: new Error("No liquidity in 100-fee pool"), 500: 2_000n, 3000: 1_500n, 10000: 1_000n } });
  let release!: () => void;
  const providerRound = new Promise<void>((resolve) => { release = resolve; });
  const started: number[] = [];
  const progress: string[] = [];
  const read: Reader = async (...args) => {
    if (args[1] === QUOTER) {
      started.push(decodeFunctionData({ abi: quoteAbi, data: args[2] }).args[0].fee);
      await providerRound;
    }
    return fixture.read(...args);
  };
  const pending = quoteSwap(read, input(), NOW, (message) => progress.push(message));
  await Promise.resolve();
  // This barrier fails the former serialized implementation without relying on
  // timing thresholds: all four requests must start before any one completes.
  expect(started).toEqual([100, 500, 3000, 10000]);
  expect(progress).toEqual(["Comparing pools · 0/4"]);
  release();
  const quote = await pending;
  expect(quote).toMatchObject({ fee: 500, amountOut: "2000", minimumOut: "1990", pool: POOL });
  expect(quote.routeWarnings).toEqual(["0.01% pool unavailable: Error: No liquidity in 100-fee pool"]);
  expect(fixture.calls).toHaveLength(6);
  expect(progress).toEqual([
    "Comparing pools · 0/4", "Comparing pools · 1/4", "Comparing pools · 2/4",
    "Comparing pools · 3/4", "Comparing pools · 4/4", "Reading pool price impact…",
  ]);
});

test("price impact uses token ordering and the pool fee in integer arithmetic", async () => {
  // sqrtPriceX96=2^97 means 4 atomic token1 per token0, before 0.05% fee.
  const direct = await quoteSwap(reader({ outputs: { 500: 3_900_000n }, sqrtPriceX96: 2n ** 97n }).read, input("1", "token-token"), NOW);
  const reverse = await quoteSwap(reader({ outputs: { 500: 245_000n }, sqrtPriceX96: 2n ** 97n }).read, input("1", "native-token"), NOW);
  expect(direct.priceImpactBps).toBe("245");
  expect(reverse.priceImpactBps).toBe("195");
});

test("a missing impact read is visible and does not discard a successful quote", async () => {
  const { read } = reader({ impactFails: true, blockNumber: null });
  const quote = await quoteSwap(read, input(), NOW);
  expect(quote.amountOut).toBe("2000000");
  expect(quote.priceImpactBps).toBeNull();
  expect(quote.blockNumber).toBeNull();
  expect(quote.routeWarnings).toContain("Price impact unavailable: Error: Factory unavailable");
});

test("all failed pools or zero-output pools fail before any wallet transaction is prepared", async () => {
  await expect(quoteSwap(reader({ outputs: {} }).read, input(), NOW)).rejects.toThrow("No direct V3 pool quote is available");
  await expect(quoteSwap(reader({ outputs: { 100: 0n, 500: 0n, 3000: 0n, 10000: 0n } }).read, input(), NOW)).rejects.toThrow("Pool returned no output");
});

test("slippage floors the minimum atom count and rejects a zero minimum", async () => {
  const { read } = reader({ outputs: { 500: 101n } });
  const quote = await quoteSwap(read, { ...input(), slippageBps: 100 }, NOW);
  expect(quote.minimumOut).toBe("99");
  const exact = await quoteSwap(read, { ...input(), slippageBps: 0 }, NOW);
  expect(exact.minimumOut).toBe("101");
  await expect(quoteSwap(reader({ outputs: { 500: 1n } }).read, input(), NOW)).rejects.toThrow("Minimum received rounds to zero");
});

test("expired quotes, changed routes, and changed slippage fail before allowance reads", async () => {
  const { read } = reader();
  const quote = await quoteSwap(read, input(), NOW);
  for (const changed of [
    { ...quote, router: CUSTOM }, { ...quote, quoter: CUSTOM }, { ...quote, fee: 2500 },
    { ...quote, minimumOut: "2000000" }, { ...quote, amountOut: "1999999" },
    { ...quote, deadline: "1800000000" },
    { ...quote, chainId: "42161" },
  ]) {
    let reads = 0;
    const forbiddenRead: Reader = async () => { reads += 1; throw new Error("Unexpected read"); };
    await expect(prepareSwap(forbiddenRead, changed, NOW)).rejects.toThrow();
    expect(reads).toBe(0);
  }
  expect(() => swapTransaction(quote, NOW + 600_000)).toThrow("deadline has expired");
});

test("a failed allowance read cannot be treated as zero or enough allowance", async () => {
  const quote = await quoteSwap(reader().read, input("1", "token-token"), NOW);
  const unavailable: Reader = async () => { throw new Error("RPC providers disagree about allowance"); };
  await expect(prepareSwap(unavailable, quote, NOW)).rejects.toThrow("RPC providers disagree about allowance");
});

test("only own supported network IDs and their matching token addresses are accepted", () => {
  for (const chainId of ["10", "01", "0x1", "toString", "constructor", "__proto__"]) expect(() => network(chainId)).toThrow("Select Ethereum or Arbitrum");
  expect(defaultTokens("42161").slice(0, 3).map((token) => token.address)).toEqual([null, DEPLOYMENTS["42161"].usdc, DEPLOYMENTS["42161"].wrapped]);
  expect(() => validateInput({ ...input(), tokenOut: { ...input().tokenOut, chainId: "42161" } }, NOW)).toThrow("selected network");
  expect(() => validateInput({ ...input(), tokenOut: { ...input().tokenOut, address: DEPLOYMENTS["1"].wrapped } }, NOW)).toThrow("ETH/WETH wrapping");
});

test("input validation rejects malformed and overflowing amounts, expired deadlines, and invalid slippage", () => {
  const base = input();
  for (const amountIn of ["0", "-1", "1.2", "01", "1e6", (2n ** 256n).toString()]) expect(() => validateInput({ ...base, amountIn }, NOW)).toThrow("input amount");
  for (const slippageBps of [-1, 10_000, 0.5, NaN]) expect(() => validateInput({ ...base, slippageBps }, NOW)).toThrow("Slippage");
  expect(() => validateInput({ ...base, deadline: "1800000000" }, NOW)).toThrow("expired");
  expect(() => validateInput({ ...base, recipient: `0x${"0".repeat(40)}` }, NOW)).toThrow("nonzero recipient");
  expect(() => validateInput({ ...base, tokenOut: { ...base.tokenOut, decimals: 256 } }, NOW)).toThrow("selected network");
});

test("display amounts become exact atomic units without floating point or excess precision", () => {
  const usdc = input().tokenOut;
  expect(amountAtoms("0.000001", usdc)).toBe("1");
  expect(amountAtoms("10000000000000000.123456", usdc)).toBe("10000000000000000123456");
  for (const amount of ["0", "1.0000001", "1e2", "-1", "+1", ".1", "01", "NaN"]) expect(() => amountAtoms(amount, usdc)).toThrow();
  expect(() => amountAtoms((2n ** 256n).toString(), { ...usdc, decimals: 0 })).toThrow("uint256");
});

test("numeric strings reject trailing line terminators instead of accepting a regex prefix", () => {
  const base = input();
  for (const suffix of ["\n", "\r\n", "\r", "\u2028", "\u2029"]) {
    expect(() => amountAtoms(`1${suffix}`, base.tokenOut)).toThrow();
    expect(() => amountAtoms(`1.25${suffix}`, base.tokenOut)).toThrow();
    expect(() => validateInput({ ...base, amountIn: `1000000${suffix}` }, NOW)).toThrow("input amount");
    expect(() => validateInput({ ...base, deadline: `1800000600${suffix}` }, NOW)).toThrow("deadline");
  }
});

test("slippage percentages become exact basis points and reject invalid precision or trailing characters", () => {
  for (const [value, expected] of [["0.29", 29], ["0.57", 57], ["99.99", 9999], ["0", 0], ["0.01", 1], ["1.5", 150]] as const) {
    expect(slippageBasisPoints(value)).toBe(expected);
  }
  for (const value of ["100", "100.00", "100.01", "-1", "-0.01", "0.001", "0.290", "0.29\n", "0.57\r\n", "0\r", "0\u2028", "0\u2029", "NaN", "1e1", ""]) {
    expect(() => slippageBasisPoints(value)).toThrow();
  }
});

test("custom metadata is read on the selected chain; address remains authoritative if symbol fails", async () => {
  const calls: ReadCall[] = [];
  const read: Reader = async (chainId, to, data, blockTag) => {
    calls.push({ chainId, to, data, blockTag });
    if (data === "0x313ce567") return { data: encodeFunctionResult({ abi: tokenAbi, functionName: "decimals", result: 8 }), blockNumber: "1", observedAtMs: NOW };
    if (data === "0x95d89b41") return { data: encodeFunctionResult({ abi: tokenAbi, functionName: "symbol", result: "CUSTOM" }), blockNumber: "1", observedAtMs: NOW };
    throw new Error("Unexpected metadata call");
  };
  expect(await customToken(read, "42161", CUSTOM)).toEqual({ chainId: "42161", address: CUSTOM, decimals: 8, symbol: "CUSTOM" });
  expect(calls.map(({ chainId, to, data }) => [chainId, to, data])).toEqual([["42161", CUSTOM, "0x313ce567"], ["42161", CUSTOM, "0x95d89b41"]]);
  const noSymbol: Reader = async (...args) => { if (args[2] === "0x95d89b41") throw new Error("Legacy bytes32 symbol"); return read(...args); };
  expect((await customToken(noSymbol, "1", CUSTOM)).symbol).toBe(CUSTOM.slice(0, 8));
  const broken: Reader = async () => ({ data: "0x", blockNumber: null, observedAtMs: NOW });
  await expect(customToken(broken, "1", CUSTOM)).rejects.toThrow();
});
