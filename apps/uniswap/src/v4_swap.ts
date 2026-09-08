import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, formatUnits, getAddress, parseAbi, parseAbiParameters, zeroAddress, type Hex } from "viem";
import type { ActionPlan } from "./action_types.ts";
import { permit2ApprovalSteps } from "./approval_plan.ts";
import { validateInput, type Quote, type QuoteInput, type QuoteProgress, type Reader, type Transaction } from "./swap.ts";
import { V4_DEFAULT_POOLS, V4_STATE_VIEW_ABI, v4Currency, v4Deployment, v4PoolId, validateV4PoolKey, type V4PoolKey } from "./v4_common.ts";
import { validateLiteralRecipient } from "./recipient.ts";

export type V4QuoteInput = QuoteInput & { poolKey?: V4PoolKey; hookData?: Hex };
export type V4Quote = Quote & { protocol: "v4"; pool: null; poolKey: V4PoolKey; poolId: Hex; hookData: Hex };

// UR tag 2.1.1 (999d561c) pins v4-periphery 3231810e. Unlike UR 2.0,
// its single-hop swap tuple includes minHopPriceX36 before hookData.
export const V4_QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)",
]);
export const V4_ROUTER_ABI = parseAbi(["function execute(bytes commands,bytes[] inputs,uint256 deadline) payable"]);
const SWAP_PARAMETERS = parseAbiParameters("((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)");
const UINT128_LIMIT = 2n ** 128n;

function positive128(value: string, label: string): bigint {
  if (/^[1-9][0-9]*$/u.exec(value)?.[0] !== value) throw new Error(`Invalid ${label}.`);
  const amount = BigInt(value);
  if (amount >= UINT128_LIMIT) throw new Error(`${label} must fit a positive uint128 for V4.`);
  return amount;
}

function inputPool(input: V4QuoteInput, nowMs: number): { poolKey?: V4PoolKey; hookData: Hex } {
  // V4 supports native ETH itself. Validate common fields using the native
  // zero-address currency so ETH and WETH remain distinct pool currencies.
  validateInput({ ...input, tokenIn: { ...input.tokenIn, address: v4Currency(input.tokenIn) }, tokenOut: { ...input.tokenOut, address: v4Currency(input.tokenOut) } }, nowMs);
  validateLiteralRecipient(input.recipient);
  for (const token of [input.tokenIn, input.tokenOut]) {
    if (token.address !== null && getAddress(token.address) === zeroAddress) throw new Error("Select ETH as the native currency, not the zero-address token.");
  }
  positive128(input.amountIn, "Input amount");
  const hookData = input.hookData ?? "0x";
  if (/^0x(?:[0-9a-fA-F]{2})*$/u.exec(hookData)?.[0] !== hookData) throw new Error("V4 hook data must contain complete hexadecimal bytes.");
  if (input.poolKey === undefined) return { hookData };
  const poolKey = validateV4PoolKey(input.poolKey);
  const currencies = [v4Currency(input.tokenIn), v4Currency(input.tokenOut)].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
  if (poolKey.currency0 !== currencies[0] || poolKey.currency1 !== currencies[1]) throw new Error("V4 pool currencies do not match the requested swap tokens.");
  return { poolKey, hookData };
}

export async function quoteV4Swap(read: Reader, input: V4QuoteInput, nowMs = Date.now(), onProgress?: QuoteProgress): Promise<V4Quote> {
  const requested = inputPool(input, nowMs), deployment = v4Deployment(input.chainId);
  const currencyIn = v4Currency(input.tokenIn), currencyOut = v4Currency(input.tokenOut);
  const zeroForOne = BigInt(currencyIn) < BigInt(currencyOut);
  const candidates = requested.poolKey ? [requested.poolKey] : V4_DEFAULT_POOLS.map(({ fee, tickSpacing }) => ({
    currency0: zeroForOne ? currencyIn : currencyOut,
    currency1: zeroForOne ? currencyOut : currencyIn, fee, tickSpacing, hooks: zeroAddress,
  }));
  let completed = 0;
  onProgress?.(`Comparing V4 pools · 0/${candidates.length}`);
  const results = await Promise.allSettled(candidates.map(async (poolKey) => {
    try {
      const response = await read(input.chainId, deployment.quoter, encodeFunctionData({ abi: V4_QUOTER_ABI, functionName: "quoteExactInputSingle", args: [{ poolKey, zeroForOne, exactAmount: BigInt(input.amountIn), hookData: requested.hookData }] }));
      const [amountOut, gasEstimate] = decodeFunctionResult({ abi: V4_QUOTER_ABI, functionName: "quoteExactInputSingle", data: response.data });
      if (amountOut <= 0n || amountOut >= UINT128_LIMIT) throw new Error("Pool output must fit a positive uint128 for V4.");
      return { poolKey, amountOut, gasEstimate, response };
    } finally {
      completed += 1;
      onProgress?.(`Comparing V4 pools · ${completed}/${candidates.length}`);
    }
  }));
  const available = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  if (!available.length) throw new Error(`No direct V4 pool quote is available. ${results.flatMap((result) => result.status === "rejected" ? [String(result.reason)] : []).join("; ")}`);
  available.sort((a, b) => a.amountOut > b.amountOut ? -1 : a.amountOut < b.amountOut ? 1 : a.poolKey.fee - b.poolKey.fee || a.poolKey.tickSpacing - b.poolKey.tickSpacing);
  const best = available[0]!, poolId = v4PoolId(best.poolKey);
  const routeWarnings = results.flatMap((result, index) => result.status === "rejected" ? [`V4 pool fee ${candidates[index]!.fee}, spacing ${candidates[index]!.tickSpacing} unavailable: ${String(result.reason)}`] : []);
  let priceImpactBps: string | null = null;
  if (best.poolKey.hooks === zeroAddress) {
    onProgress?.("Reading V4 pool price impact…");
    try {
      if (best.response.blockNumber === null) throw new Error("The quote block is unavailable; price impact requires matching block observations.");
      const block = BigInt(best.response.blockNumber), tag = `0x${block.toString(16)}`;
      const state = await read(input.chainId, deployment.stateView, encodeFunctionData({ abi: V4_STATE_VIEW_ABI, functionName: "getSlot0", args: [poolId] }), tag);
      if (state.blockNumber === null || BigInt(state.blockNumber) !== block) throw new Error("The pool price was observed at a different or unknown block.");
      const [sqrt, , protocolFees, lpFee] = decodeFunctionResult({ abi: V4_STATE_VIEW_ABI, functionName: "getSlot0", data: state.data });
      if (sqrt === 0n) throw new Error("Pool is not initialized.");
      const square = sqrt * sqrt, q192 = 2n ** 192n;
      // Protocol fees are direction-specific packed uint12 values. PoolManager
      // takes that fee first, then charges the LP fee on the remaining input.
      const protocolFee = zeroForOne ? protocolFees & 0xfff : protocolFees >> 12;
      const swapFee = protocolFee + lpFee - Math.floor(protocolFee * lpFee / 1_000_000);
      // Keep the spot quote rational until the final basis-point division;
      // rounding token atoms before fees can produce a false negative impact.
      const numerator = BigInt(input.amountIn) * (zeroForOne ? square : q192) * BigInt(1_000_000 - swapFee);
      const denominator = (zeroForOne ? q192 : square) * 1_000_000n;
      if (numerator > 0n) priceImpactBps = ((numerator - best.amountOut * denominator) * 10000n / numerator).toString();
    } catch (error) { routeWarnings.push(`Price impact unavailable: ${String(error)}`); }
  } else {
    routeWarnings.push("Price impact is unavailable for this hook pool; the quote includes its custom behavior.");
  }
  const minimumOut = best.amountOut * BigInt(10000 - input.slippageBps) / 10000n;
  if (minimumOut === 0n) throw new Error("Minimum received rounds to zero; change amount or slippage.");
  return {
    ...input, protocol: "v4", router: deployment.router, quoter: deployment.quoter,
    poolKey: best.poolKey, poolId, hookData: requested.hookData, pool: null, fee: best.poolKey.fee,
    amountOut: best.amountOut.toString(), minimumOut: minimumOut.toString(), gasEstimate: best.gasEstimate.toString(),
    priceImpactBps, quotedAtMs: best.response.observedAtMs, blockNumber: best.response.blockNumber, routeWarnings,
  };
}

export function v4SwapTransaction(quote: V4Quote, nowMs = Date.now()): Transaction {
  const { poolKey, hookData } = inputPool(quote, nowMs), deployment = v4Deployment(quote.chainId);
  if (quote.protocol !== "v4" || !poolKey || getAddress(quote.router) !== deployment.router || getAddress(quote.quoter) !== deployment.quoter || quote.fee !== poolKey.fee || quote.poolId.toLowerCase() !== v4PoolId(poolKey).toLowerCase()) throw new Error("Quote route does not match the V4 pool and deployment.");
  const amountOut = positive128(quote.amountOut, "Quoted output"), minimumOut = positive128(quote.minimumOut, "Minimum output");
  if (minimumOut !== amountOut * BigInt(10000 - quote.slippageBps) / 10000n) throw new Error("Quote minimum output does not match slippage.");
  const currencyIn = v4Currency(quote.tokenIn), currencyOut = v4Currency(quote.tokenOut);
  const params: Hex[] = [
    encodeAbiParameters(SWAP_PARAMETERS, [{ poolKey, zeroForOne: BigInt(currencyIn) < BigInt(currencyOut), amountIn: BigInt(quote.amountIn), amountOutMinimum: minimumOut, minHopPriceX36: 0n, hookData }]),
    encodeAbiParameters(parseAbiParameters("address,uint256"), [currencyIn, BigInt(quote.amountIn)]),
    // TAKE accepts an explicit recipient and amount zero means all output credit.
    // TAKE_ALL would send to the original caller and cannot implement this field.
    encodeAbiParameters(parseAbiParameters("address,address,uint256"), [currencyOut, quote.recipient, 0n]),
  ];
  const inputs: Hex[] = [encodeAbiParameters(parseAbiParameters("bytes,bytes[]"), ["0x060c0e", params])];
  const nativeInput = quote.tokenIn.address === null;
  if (nativeInput) inputs.push(encodeAbiParameters(parseAbiParameters("address,address,uint256"), [zeroAddress, quote.accountAddress, 0n]));
  return {
    chainId: quote.chainId, accountId: quote.accountId, to: deployment.router,
    value: nativeInput ? quote.amountIn : "0",
    data: encodeFunctionData({ abi: V4_ROUTER_ABI, functionName: "execute", args: [nativeInput ? "0x1004" : "0x10", inputs, BigInt(quote.deadline)] }),
  };
}

export async function prepareV4Swap(read: Reader, quote: V4Quote, nowMs = Date.now()): Promise<ActionPlan> {
  const transaction = v4SwapTransaction(quote, nowMs);
  const steps = quote.tokenIn.address === null ? [] : await permit2ApprovalSteps(read, {
    chainId: quote.chainId, accountId: quote.accountId, accountAddress: quote.accountAddress,
    spender: transaction.to, deadline: quote.deadline,
    nowSeconds: Math.floor(nowMs / 1000).toString(),
    tokens: [{ address: quote.tokenIn.address, amount: quote.amountIn, symbol: quote.tokenIn.symbol }],
  });
  steps.push({ label: `Swap ${quote.tokenIn.symbol} for ${quote.tokenOut.symbol}`, kind: "transaction", transaction });
  return {
    chainId: quote.chainId, accountId: quote.accountId, accountAddress: quote.accountAddress, deadline: quote.deadline,
    summary: `Swap ${formatUnits(BigInt(quote.amountIn), quote.tokenIn.decimals)} ${quote.tokenIn.symbol} for ${quote.tokenOut.symbol} on Uniswap V4`,
    steps, details: { kind: "swap", protocol: "v4", quote },
  };
}
