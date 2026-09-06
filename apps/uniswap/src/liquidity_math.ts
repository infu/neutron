import { Ether, Percent, Token as SdkToken, type Currency } from "@uniswap/sdk-core";
import { Pool as V3Pool, Position as V3Position, TickMath } from "@uniswap/v3-sdk";
import { Pool as V4Pool, Position as V4Position } from "@uniswap/v4-sdk";
import type { Token } from "./swap.ts";

/** Structural pool input lets public position reads use the same exact SDK math. */
export type LiquidityMathPool = {
  protocol: "v3" | "v4"; chainId: string; token0: Token; token1: Token;
  fee: number; tickSpacing: number; hooks: string; sqrtPriceX96: string; tick: number; liquidity: string;
};
export type SdkLiquidityPosition = V3Position | V4Position;
const MAX_LIQUIDITY = (1n << 128n) - 1n;

export function sdkCurrency(token: Token): Currency {
  return token.address === null ? Ether.onChain(Number(token.chainId))
    : new SdkToken(Number(token.chainId), token.address, token.decimals, token.symbol, token.name);
}
export function sdkLiquidityPool(pool: LiquidityMathPool): V3Pool | V4Pool {
  const a = sdkCurrency(pool.token0), b = sdkCurrency(pool.token1);
  if (pool.protocol === "v4") return new V4Pool(a, b, pool.fee, pool.tickSpacing, pool.hooks, pool.sqrtPriceX96, pool.liquidity, pool.tick);
  if (!a.isToken || !b.isToken) throw new Error("V3 pool currencies must be wrapped ERC-20 tokens.");
  return new V3Pool(a, b, pool.fee, pool.sqrtPriceX96, pool.liquidity, pool.tick);
}
export function sdkLiquidityPosition(pool: LiquidityMathPool, tickLower: number, tickUpper: number, liquidity: string): SdkLiquidityPosition {
  const sdk = sdkLiquidityPool(pool);
  return sdk instanceof V4Pool ? new V4Position({ pool: sdk, tickLower, tickUpper, liquidity })
    : new V3Position({ pool: sdk, tickLower, tickUpper, liquidity });
}
export function fullRangeTicks(tickSpacing: number): { tickLower: number; tickUpper: number } {
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0 || tickSpacing > 32767) throw new Error("Invalid pool tick spacing.");
  return { tickLower: Math.ceil(TickMath.MIN_TICK / tickSpacing) * tickSpacing, tickUpper: Math.floor(TickMath.MAX_TICK / tickSpacing) * tickSpacing };
}
export function liquidityAmounts(pool: LiquidityMathPool, tickLower: number, tickUpper: number, liquidity: string): { amount0: string; amount1: string } {
  const position = sdkLiquidityPosition(pool, tickLower, tickUpper, liquidity);
  return { amount0: position.amount0.quotient.toString(), amount1: position.amount1.quotient.toString() };
}
/** Fit exact liquidity to input ceilings, including V4's price-slippage maxima.
 * SDK rounding is preserved; no floating-point token or liquidity arithmetic. */
export function positionWithinBudgets(pool: LiquidityMathPool, tickLower: number, tickUpper: number, budget0: bigint, budget1: bigint, slippageBps: number): SdkLiquidityPosition {
  const sdk = sdkLiquidityPool(pool);
  const position = sdk instanceof V4Pool
    ? V4Position.fromAmounts({ pool: sdk, tickLower, tickUpper, amount0: budget0.toString(), amount1: budget1.toString(), useFullPrecision: true })
    : V3Position.fromAmounts({ pool: sdk, tickLower, tickUpper, amount0: budget0.toString(), amount1: budget1.toString(), useFullPrecision: false });
  const tolerance = new Percent(slippageBps, 10000);
  const make = (liquidity: bigint) => sdk instanceof V4Pool
    ? new V4Position({ pool: sdk, tickLower, tickUpper, liquidity: liquidity.toString() })
    : new V3Position({ pool: sdk, tickLower, tickUpper, liquidity: liquidity.toString() });
  const fits = (candidate: SdkLiquidityPosition) => {
    const amounts = candidate instanceof V4Position ? candidate.mintAmountsWithSlippage(tolerance) : candidate.mintAmounts;
    return BigInt(amounts.amount0.toString()) <= budget0 && BigInt(amounts.amount1.toString()) <= budget1;
  };
  let low = 0n, high = BigInt(position.liquidity.toString());
  if (high > MAX_LIQUIDITY) high = MAX_LIQUIDITY;
  if (fits(make(high))) low = high;
  else while (low < high) {
    const mid = (low + high + 1n) / 2n;
    if (fits(make(mid))) low = mid; else high = mid - 1n;
  }
  if (low === 0n) throw new Error("These amounts are too small for the selected price range and slippage.");
  return make(low);
}
