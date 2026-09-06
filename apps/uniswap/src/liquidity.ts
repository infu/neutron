import { Percent } from "@uniswap/sdk-core";
import { TickMath } from "@uniswap/v3-sdk";
import { Position as V4Position, V4PositionPlanner } from "@uniswap/v4-sdk";
import { encodeFunctionData, getAddress, isAddress, isHex, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import type { EvmAccount } from "neutron-tools/evm_wallet";
import { network, type Reader, type Token, type Transaction } from "./swap.ts";
import type { ActionPlan } from "./action_types.ts";
import { planErc20Approval, permit2ApprovalSteps } from "./approval_plan.ts";
import { fullRangeTicks, positionWithinBudgets, sdkLiquidityPosition } from "./liquidity_math.ts";
import { readPool, readPosition, V3_POSITION_MANAGER, type PoolState, type PositionRecord } from "./positions.ts";
import { v4Deployment } from "./v4_common.ts";

export type LiquidityOperation = "mint" | "increase" | "decrease" | "collect" | "close";
export type LiquidityInput = {
  operation: LiquidityOperation; protocol: "v3" | "v4"; chainId: string; accountId: string;
  tokenId?: string; tokenA?: string | null; tokenB?: string | null; maxAmountA?: string; maxAmountB?: string;
  fee?: number; tickSpacing?: number; hooks?: string; tickLower?: number; tickUpper?: number;
  liquidityBps?: number; liquidity?: string; recipient?: string; slippageBps?: number;
  hookData?: string; quoteValiditySeconds?: number;
};
export type LiquidityPreview = {
  operation: LiquidityOperation; protocol: "v3" | "v4"; tokenId: string | null;
  token0: Token; token1: Token; tickLower: number; tickUpper: number; liquidity: string;
  amount0: string; amount1: string; amount0Max: string; amount1Max: string; amount0Min: string; amount1Min: string;
  recipient: string; deadline: string; inRange: boolean; pool: PoolState; warnings: string[];
};
export { V3_POSITION_MANAGER } from "./positions.ts";
export const LIQUIDITY_V3_ABI = parseAbi([
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) payable returns(uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  "function increaseLiquidity((uint256 tokenId,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) payable returns(uint128 liquidity,uint256 amount0,uint256 amount1)",
  "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) payable returns(uint256 amount0,uint256 amount1)",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) params) payable returns(uint256 amount0,uint256 amount1)",
  "function burn(uint256 tokenId) payable", "function multicall(bytes[] data) payable returns(bytes[] results)",
  "function refundETH() payable", "function unwrapWETH9(uint256 amountMinimum,address recipient) payable", "function sweepToken(address token,uint256 amountMinimum,address recipient) payable",
]);
export const LIQUIDITY_V4_ABI = parseAbi(["function modifyLiquidities(bytes unlockData,uint256 deadline) payable"]);
const UINT128_MAX = (1n << 128n) - 1n;
const uint = (value: string | undefined, label: string, bits = 256): bigint => {
  if (typeof value !== "string" || /^(?:0|[1-9][0-9]*)$/u.exec(value)?.[0] !== value || BigInt(value) >= 1n << BigInt(bits)) throw new Error(`Invalid ${label}; use an atomic uint${bits} decimal amount.`);
  return BigInt(value);
};
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function currencyAddress(input: string | null, chainId: string, protocol: "v3" | "v4"): Address {
  if (input === null) return protocol === "v4" ? zeroAddress : network(chainId).wrapped;
  if (!isAddress(input) || same(input, zeroAddress)) throw new Error("Use null for native ETH, or a nonzero token contract address.");
  return getAddress(input);
}
function checkedInput(account: EvmAccount, input: LiquidityInput, nowMs: number) {
  network(input.chainId);
  if (!["mint", "increase", "decrease", "collect", "close"].includes(input.operation) || !["v3", "v4"].includes(input.protocol)) throw new Error("Select a supported liquidity operation and protocol.");
  if (input.accountId !== account.accountId || !isAddress(account.address)) throw new Error("Liquidity account does not match the selected Wallet account.");
  const owner = getAddress(account.address), recipient = getAddress(input.recipient ?? owner);
  if (same(owner, zeroAddress) || same(recipient, zeroAddress)) throw new Error("Select a nonzero recipient.");
  const slippageBps = input.slippageBps ?? 50, validity = input.quoteValiditySeconds ?? 1200;
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10000) throw new Error("Slippage must be between 0 and 99.99%.");
  if (!Number.isSafeInteger(validity) || validity <= 0 || !Number.isFinite(nowMs)) throw new Error("Quote validity must be a positive number of seconds.");
  const deadline = (BigInt(Math.floor(nowMs / 1000)) + BigInt(validity)).toString();
  const hookData = input.hookData ?? "0x";
  if (!isHex(hookData) || hookData.length % 2 !== 0) throw new Error("Hook data must be complete hexadecimal bytes.");
  if (input.protocol === "v3" && (hookData !== "0x" || input.hooks && !same(input.hooks, zeroAddress))) throw new Error("V3 positions do not have hooks.");
  if (input.operation === "mint") {
    if (input.tokenId !== undefined) throw new Error("A new position does not have an NFT ID yet.");
    if (input.tokenA === undefined || input.tokenB === undefined) throw new Error("Select both tokens for the new position.");
  } else if (uint(input.tokenId, "position ID") === 0n) throw new Error("Select a valid position ID.");
  if (input.operation !== "mint" && input.operation !== "increase" && (input.maxAmountA !== undefined || input.maxAmountB !== undefined)) throw new Error("Token input budgets apply only when adding liquidity.");
  if (input.operation !== "decrease" && (input.liquidity !== undefined || input.liquidityBps !== undefined)) throw new Error("Select a removal amount only for a decrease operation; close removes the entire position.");
  if (input.operation === "increase" && !same(recipient, owner)) throw new Error("Adding to an existing position returns any unused tokens or credited fees to this Wallet account.");
  return { owner, recipient, slippageBps, deadline, hookData: hookData as Hex };
}
function validatePoolAndPosition(input: LiquidityInput, pool: PoolState, position: PositionRecord | null, owner: Address): void {
  if (pool.protocol !== input.protocol || pool.chainId !== input.chainId || BigInt(pool.sqrtPriceX96) <= 0n) throw new Error("Pool does not match this operation or has not been initialized.");
  if (input.operation !== "mint") {
    if (!position || position.tokenId !== input.tokenId || position.protocol !== input.protocol || position.chainId !== input.chainId || !same(position.owner, owner)) throw new Error("This position is not owned by the selected Wallet account.");
    if (input.fee !== undefined && input.fee !== pool.fee || input.tickSpacing !== undefined && input.tickSpacing !== pool.tickSpacing || input.hooks !== undefined && !same(input.hooks, pool.hooks)) throw new Error("The supplied pool settings do not match this position.");
    if (input.tickLower !== undefined && input.tickLower !== position.tickLower || input.tickUpper !== undefined && input.tickUpper !== position.tickUpper) throw new Error("An existing position's price range cannot change. Create a new position for a different range.");
  }
}
function amountOrientation(input: LiquidityInput, pool: PoolState) {
  const p0 = pool.token0.address ?? zeroAddress, p1 = pool.token1.address ?? zeroAddress;
  const a = input.tokenA === undefined ? p0 : currencyAddress(input.tokenA, input.chainId, input.protocol);
  const b = input.tokenB === undefined ? p1 : currencyAddress(input.tokenB, input.chainId, input.protocol);
  if (same(a, b) || !(same(a, p0) && same(b, p1) || same(a, p1) && same(b, p0))) throw new Error("Selected tokens do not match this position's pool currencies.");
  return { aIs0: same(a, p0), nativeAddress: input.protocol === "v4" && pool.token0.address === null ? zeroAddress
    : input.protocol === "v3" && (input.tokenA === null || input.tokenB === null) ? network(input.chainId).wrapped : null };
}

/** Pure effect construction from an authoritative observation. Exposed for local
 * contract fixtures and independently decoded call checks; it never sends. */
export function buildLiquidity(pool: PoolState, position: PositionRecord | null, account: EvmAccount, input: LiquidityInput, nowMs = Date.now()): { preview: LiquidityPreview; transaction: Transaction; approvalTokens: Array<{ address: Address; amount: string; symbol: string }> } {
  const { owner, recipient, slippageBps, deadline, hookData } = checkedInput(account, input, nowMs);
  validatePoolAndPosition(input, pool, position, owner);
  const orientation = amountOrientation(input, pool), tolerance = new Percent(slippageBps, 10000);
  const ticks = input.operation === "mint" ? { ...fullRangeTicks(pool.tickSpacing), ...(input.tickLower === undefined ? {} : { tickLower: input.tickLower }), ...(input.tickUpper === undefined ? {} : { tickUpper: input.tickUpper }) }
    : { tickLower: position!.tickLower, tickUpper: position!.tickUpper };
  if (!Number.isInteger(ticks.tickLower) || !Number.isInteger(ticks.tickUpper) || ticks.tickLower < TickMath.MIN_TICK || ticks.tickUpper > TickMath.MAX_TICK || ticks.tickLower >= ticks.tickUpper || ticks.tickLower % pool.tickSpacing !== 0 || ticks.tickUpper % pool.tickSpacing !== 0) throw new Error("Price-range ticks must be ordered and aligned to this pool's spacing.");
  let amount0 = "0", amount1 = "0", max0 = "0", max1 = "0", min0 = "0", min1 = "0", liquidity = "0";
  let data: string, value = "0";
  const adding = input.operation === "mint" || input.operation === "increase";
  const approvalTokens: Array<{ address: Address; amount: string; symbol: string }> = [];
  const manager = input.protocol === "v4" ? v4Deployment(input.chainId).positionManager : V3_POSITION_MANAGER;
  if (adding) {
    const budgetA = uint(input.maxAmountA ?? "0", "first token budget", input.protocol === "v4" ? 128 : 256);
    const budgetB = uint(input.maxAmountB ?? "0", "second token budget", input.protocol === "v4" ? 128 : 256);
    if (budgetA === 0n && budgetB === 0n) throw new Error("Enter at least one token amount to add.");
    const budget0 = orientation.aIs0 ? budgetA : budgetB, budget1 = orientation.aIs0 ? budgetB : budgetA;
    const sdk = positionWithinBudgets(pool, ticks.tickLower, ticks.tickUpper, budget0, budget1, slippageBps);
    liquidity = sdk.liquidity.toString();
    if (position && BigInt(position.liquidity) + BigInt(liquidity) > UINT128_MAX) throw new Error("The resulting position liquidity would exceed the contract uint128 limit.");
    amount0 = sdk.mintAmounts.amount0.toString(); amount1 = sdk.mintAmounts.amount1.toString();
    const limits = sdk.mintAmountsWithSlippage(tolerance);
    if (sdk instanceof V4Position) {
      max0 = limits.amount0.toString(); max1 = limits.amount1.toString();
      const planner = new V4PositionPlanner();
      if (input.operation === "mint") {
        planner.addMint(sdk.pool, ticks.tickLower, ticks.tickUpper, liquidity, max0, max1, recipient, hookData);
        planner.addSettlePair(sdk.pool.currency0, sdk.pool.currency1);
      } else {
        planner.addIncrease(input.tokenId!, liquidity, max0, max1, hookData);
        // Accrued fees can reverse either currency delta; close handles both.
        planner.addCloseCurrency(sdk.pool.currency0); planner.addCloseCurrency(sdk.pool.currency1);
      }
      if (sdk.pool.currency0.isNative) { value = max0; planner.addSweep(sdk.pool.currency0, owner); }
      data = encodeFunctionData({ abi: LIQUIDITY_V4_ABI, functionName: "modifyLiquidities", args: [planner.finalize() as Hex, BigInt(deadline)] });
    } else {
      max0 = amount0; max1 = amount1; min0 = limits.amount0.toString(); min1 = limits.amount1.toString();
      // SDK math supplies exact desired amounts and slippage minima. Encode
      // our public contract interface without importing Solidity build artifacts.
      const amounts = { amount0Desired: BigInt(amount0), amount1Desired: BigInt(amount1), amount0Min: BigInt(min0), amount1Min: BigInt(min1), deadline: BigInt(deadline) };
      const calls: Hex[] = [input.operation === "mint"
        ? encodeFunctionData({ abi: LIQUIDITY_V3_ABI, functionName: "mint", args: [{ token0: getAddress(sdk.pool.token0.address), token1: getAddress(sdk.pool.token1.address), fee: sdk.pool.fee, ...ticks, ...amounts, recipient }] })
        : encodeFunctionData({ abi: LIQUIDITY_V3_ABI, functionName: "increaseLiquidity", args: [{ tokenId: BigInt(input.tokenId!), ...amounts }] })];
      if (orientation.nativeAddress !== null) {
        value = same(sdk.pool.token0.address, orientation.nativeAddress) ? amount0 : amount1;
        if (BigInt(value) > 0n) calls.push(encodeFunctionData({ abi: LIQUIDITY_V3_ABI, functionName: "refundETH" }));
      }
      data = calls.length === 1 ? calls[0]! : encodeFunctionData({ abi: LIQUIDITY_V3_ABI, functionName: "multicall", args: [calls] });
    }
    for (const [token, max] of [[pool.token0, max0], [pool.token1, max1]] as const) {
      if (token.address !== null && BigInt(max) > 0n && (orientation.nativeAddress === null || !same(token.address, orientation.nativeAddress))) approvalTokens.push({ address: getAddress(token.address), amount: max, symbol: token.symbol });
    }
  } else {
    const current = uint(position!.liquidity, "position liquidity", 128);
    if (input.protocol === "v4" && input.operation === "collect" && current === 0n) throw new Error("This empty V4 position has no fees to collect. Close it to remove the NFT.");
    let remove = 0n;
    if (input.operation === "close") remove = current;
    else if (input.operation === "decrease") {
      if (input.liquidity !== undefined && input.liquidityBps !== undefined) throw new Error("Specify liquidity units or a removal percentage, not both.");
      if (input.liquidity !== undefined) remove = uint(input.liquidity, "liquidity to remove", 128);
      else {
        const bps = input.liquidityBps ?? 10000;
        if (!Number.isInteger(bps) || bps < 1 || bps > 10000) throw new Error("Removal percentage must be greater than zero and at most 100%.");
        remove = current * BigInt(bps) / 10000n;
      }
      if (remove === 0n || remove > current) throw new Error("Removal must fit the liquidity currently in this position.");
    }
    liquidity = remove.toString();
    const sdk = sdkLiquidityPosition(pool, ticks.tickLower, ticks.tickUpper, liquidity);
    amount0 = sdk.amount0.quotient.toString(); amount1 = sdk.amount1.quotient.toString();
    const minima = sdk.burnAmountsWithSlippage(tolerance); min0 = minima.amount0.toString(); min1 = minima.amount1.toString();
    if (input.operation === "collect") { amount0 = position!.claimable0; amount1 = position!.claimable1; }
    if (sdk instanceof V4Position) {
      const planner = new V4PositionPlanner();
      if (input.operation === "close") planner.addBurn(input.tokenId!, min0, min1, hookData);
      else planner.addDecrease(input.tokenId!, liquidity, min0, min1, hookData);
      planner.addTakePair(sdk.pool.currency0, sdk.pool.currency1, recipient);
      data = encodeFunctionData({ abi: LIQUIDITY_V4_ABI, functionName: "modifyLiquidities", args: [planner.finalize() as Hex, BigInt(deadline)] });
    } else {
      // Collect returns all owned accrued fees and removed principal in the same
      // transaction; decrease alone would leave assets owed by the NFT manager.
      const calls: Hex[] = [];
      if (remove > 0n) calls.push(encodeFunctionData({ abi: LIQUIDITY_V3_ABI, functionName: "decreaseLiquidity", args: [{ tokenId: BigInt(input.tokenId!), liquidity: remove, amount0Min: BigInt(min0), amount1Min: BigInt(min1), deadline: BigInt(deadline) }] }));
      calls.push(encodeFunctionData({ abi: LIQUIDITY_V3_ABI, functionName: "collect", args: [{ tokenId: BigInt(input.tokenId!), recipient: orientation.nativeAddress === null ? recipient : manager, amount0Max: UINT128_MAX, amount1Max: UINT128_MAX }] }));
      if (orientation.nativeAddress !== null) {
        const native0 = same(pool.token0.address!, orientation.nativeAddress);
        calls.push(encodeFunctionData({ abi: LIQUIDITY_V3_ABI, functionName: "unwrapWETH9", args: [BigInt(native0 ? min0 : min1), recipient] }));
        calls.push(encodeFunctionData({ abi: LIQUIDITY_V3_ABI, functionName: "sweepToken", args: [getAddress((native0 ? pool.token1 : pool.token0).address!), BigInt(native0 ? min1 : min0), recipient] }));
      }
      if (input.operation === "close") calls.push(encodeFunctionData({ abi: LIQUIDITY_V3_ABI, functionName: "burn", args: [BigInt(input.tokenId!)] }));
      data = calls.length === 1 ? calls[0]! : encodeFunctionData({ abi: LIQUIDITY_V3_ABI, functionName: "multicall", args: [calls] });
    }
  }
  const warnings: string[] = [];
  if (!same(pool.hooks, zeroAddress)) warnings.push("This pool has a hook. Its contract can change fees, token accounting or requirements for adding and removing liquidity.");
  if (pool.tick < ticks.tickLower || pool.tick >= ticks.tickUpper) warnings.push("This position is outside the current price range and will not earn swap fees until the price enters it.");
  if (input.operation === "decrease" || input.operation === "close") warnings.push("Outputs include any collected fees in addition to the principal estimate shown.");
  return { preview: { operation: input.operation, protocol: input.protocol, tokenId: input.tokenId ?? null, token0: pool.token0, token1: pool.token1, ...ticks, liquidity, amount0, amount1, amount0Max: max0, amount1Max: max1, amount0Min: min0, amount1Min: min1, recipient, deadline, inRange: pool.tick >= ticks.tickLower && pool.tick < ticks.tickUpper, pool, warnings },
    transaction: { chainId: input.chainId, accountId: input.accountId, to: manager, data: data as Hex, value }, approvalTokens };
}

/** Read, quote and prepare exact provider-reviewed steps. No signatures or sends. */
export async function prepareLiquidity(read: Reader, account: EvmAccount, input: LiquidityInput, nowMs = Date.now()): Promise<ActionPlan> {
  const checked = checkedInput(account, input, nowMs);
  const position = input.operation === "mint" ? null : await readPosition(read, { chainId: input.chainId, accountId: input.accountId, owner: checked.owner, protocol: input.protocol, tokenId: input.tokenId! });
  const fee = input.fee ?? 3000;
  const pool = position?.pool ?? await readPool(read, { chainId: input.chainId, protocol: input.protocol, tokenA: input.tokenA!, tokenB: input.tokenB!, fee,
    ...(input.tickSpacing === undefined ? {} : { tickSpacing: input.tickSpacing }), ...(input.hooks === undefined ? {} : { hooks: input.hooks }) });
  const built = buildLiquidity(pool, position, account, input, nowMs);
  const steps = input.protocol === "v4" ? await permit2ApprovalSteps(read, { chainId: input.chainId, accountId: input.accountId, accountAddress: checked.owner, spender: built.transaction.to, deadline: built.preview.deadline, tokens: built.approvalTokens, nowSeconds: Math.floor(nowMs / 1000).toString() }) : [];
  if (input.protocol === "v3") for (const token of built.approvalTokens) steps.push(...await planErc20Approval(read, { chainId: input.chainId, accountId: input.accountId, owner: checked.owner, token: token.address, spender: built.transaction.to, amount: token.amount, symbol: token.symbol }));
  const labels: Record<LiquidityOperation, string> = { mint: "Create liquidity position", increase: "Add liquidity", decrease: "Remove liquidity", collect: "Collect fees", close: "Close liquidity position" };
  const summary = `${labels[input.operation]} · ${built.preview.token0.symbol}/${built.preview.token1.symbol} · ${input.protocol.toUpperCase()}`;
  steps.push({ label: labels[input.operation], kind: "transaction", transaction: built.transaction });
  return { chainId: input.chainId, accountId: input.accountId, accountAddress: checked.owner, deadline: built.preview.deadline, summary, steps, details: { kind: "liquidity", input, preview: built.preview } };
}
