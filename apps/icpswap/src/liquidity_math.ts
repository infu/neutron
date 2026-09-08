/**
 * Exact atom/range arithmetic for ICPSwap v3. Amount0 liquidity deliberately
 * floors the intermediate sqrtA * sqrtB / Q96, as its LiquidityAmounts does.
 * No price tolerance here implies protocol-enforced liquidity slippage.
 *
 * Tick factors and the Q128 tick algorithm are adapted from @uniswap/v3-sdk
 * 3.31.3, src/utils/tickMath.ts, under the following license:
 *
 * MIT License
 * Copyright (c) 2021 Uniswap Labs
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const Q96 = 1n << 96n;
const Q192 = Q96 * Q96;
const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

const TICK_FACTORS = [
  0xfffcb933bd6fad37aa2d162d1a594001n,
  0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n,
  0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n,
  0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n,
  0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n,
] as const;

export function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error("Tick is outside the protocol range");
  }
  const absolute = Math.abs(tick);
  let ratio = 1n << 128n;
  for (let bit = 0; bit < TICK_FACTORS.length; bit++) {
    if ((absolute & (1 << bit)) !== 0) {
      ratio = (ratio * TICK_FACTORS[bit]!) >> 128n;
    }
  }
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

export function usableTickRange(spacing: number): { lower: number; upper: number } {
  if (!Number.isSafeInteger(spacing) || spacing <= 0) {
    throw new Error("Tick spacing must be a positive integer");
  }
  const lower = Math.ceil(MIN_TICK / spacing) * spacing;
  const upper = Math.floor(MAX_TICK / spacing) * spacing;
  if (lower >= upper) throw new Error("Tick spacing has no usable range");
  return { lower, upper };
}

function unsigned(value: bigint, maximum: bigint, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > maximum) {
    throw new Error(`${label} is outside its protocol integer range`);
  }
  return value;
}

function sqrtPrices(sqrtP: bigint, sqrtA: bigint, sqrtB: bigint): [bigint, bigint] {
  for (const value of [sqrtP, sqrtA, sqrtB]) {
    unsigned(value, MAX_UINT160, "Square-root price");
    if (value === 0n) throw new Error("Square-root price must be positive");
  }
  if (sqrtA === sqrtB) throw new Error("Price range must have distinct bounds");
  return sqrtA < sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
}

export function liquidityForAmounts(
  sqrtP: bigint, sqrtA: bigint, sqrtB: bigint, amount0: bigint, amount1: bigint,
): bigint {
  const [a, b] = sqrtPrices(sqrtP, sqrtA, sqrtB);
  unsigned(amount0, MAX_UINT256, "Token0 amount");
  unsigned(amount1, MAX_UINT256, "Token1 amount");
  const from0 = (lower: bigint, upper: bigint) => unsigned(
    amount0 * (lower * upper / Q96) / (upper - lower), MAX_UINT128, "Liquidity",
  );
  const from1 = (lower: bigint, upper: bigint) => unsigned(
    amount1 * Q96 / (upper - lower), MAX_UINT128, "Liquidity",
  );
  if (sqrtP <= a) return from0(a, b);
  if (sqrtP >= b) return from1(a, b);
  const liquidity0 = from0(sqrtP, b);
  const liquidity1 = from1(a, sqrtP);
  return liquidity0 < liquidity1 ? liquidity0 : liquidity1;
}

export function amountsForLiquidity(
  sqrtP: bigint, sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp = false,
): { amount0: bigint; amount1: bigint } {
  const [a, b] = sqrtPrices(sqrtP, sqrtA, sqrtB);
  unsigned(liquidity, MAX_UINT128, "Liquidity");
  const divide = (numerator: bigint, denominator: bigint) => roundUp
    ? (numerator + denominator - 1n) / denominator
    : numerator / denominator;
  const amount0 = (lower: bigint, upper: bigint) =>
    divide(liquidity * Q96 * (upper - lower), lower * upper);
  const amount1 = (lower: bigint, upper: bigint) =>
    divide(liquidity * (upper - lower), Q96);
  if (sqrtP <= a) return { amount0: amount0(a, b), amount1: 0n };
  if (sqrtP >= b) return { amount0: 0n, amount1: amount1(a, b) };
  return { amount0: amount0(sqrtP, b), amount1: amount1(a, sqrtP) };
}

function decimalDifference(decimals0: number, decimals1: number): number {
  for (const decimals of [decimals0, decimals1]) {
    // ICRC-1 decimals is nat8; this is its wire range, not an app policy.
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
      throw new Error("Token decimals must fit the ICRC-1 nat8 field");
    }
  }
  return decimals0 - decimals1;
}

/**
 * Exact finite decimal for the Q96 tick price, token1 per token0. Consumers
 * may shorten it for display, but should retain this string for conversions.
 */
export function tickToPrice(tick: number, decimals0: number, decimals1: number): string {
  const difference = decimalDifference(decimals0, decimals1);
  const sqrt = getSqrtRatioAtTick(tick);
  // 1 / 2^192 = 5^192 / 10^192, so no decimal approximation is needed.
  const scaled = sqrt * sqrt * (5n ** 192n) * (10n ** BigInt(Math.max(0, difference)));
  const places = 192 + Math.max(0, -difference);
  const digits = scaled.toString().padStart(places + 1, "0");
  const whole = digits.slice(0, -places);
  const fraction = digits.slice(-places).replace(/0+$/u, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

/**
 * Align a positive decimal token1-per-token0 price to a usable tick without
 * converting its value to Number. Throws if the requested rounding cannot be
 * represented inside the pool's usable range; it never silently clamps bounds.
 */
export function priceToTick(
  price: string, decimals0: number, decimals1: number, spacing: number,
  rounding: "down" | "up",
): number {
  const difference = decimalDifference(decimals0, decimals1);
  const { lower, upper } = usableTickRange(spacing);
  if (typeof price !== "string" || !/^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(price)) {
    throw new Error("Price must be a positive decimal string");
  }
  if (rounding !== "down" && rounding !== "up") throw new Error("Invalid tick rounding");
  const [whole = "", fraction = ""] = price.split(".");
  let numerator = BigInt(`${whole || "0"}${fraction}`);
  if (numerator === 0n) throw new Error("Price must be positive");
  let denominator = 10n ** BigInt(fraction.length);
  if (difference > 0) denominator *= 10n ** BigInt(difference);
  if (difference < 0) numerator *= 10n ** BigInt(-difference);
  const compareTick = (tick: number) => {
    const sqrt = getSqrtRatioAtTick(tick);
    const difference = sqrt * sqrt * denominator - numerator * Q192;
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  };
  if (compareTick(MIN_TICK) > 0 || compareTick(MAX_TICK) < 0) {
    throw new Error("Price is outside the protocol tick range");
  }
  let low = MIN_TICK;
  let high = MAX_TICK;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (compareTick(middle) <= 0) low = middle;
    else high = middle - 1;
  }
  const exactOrDown = low;
  const requested = rounding === "up" && compareTick(exactOrDown) !== 0
    ? exactOrDown + 1 : exactOrDown;
  const aligned = (rounding === "up" ? Math.ceil(requested / spacing) : Math.floor(requested / spacing)) * spacing;
  if (aligned < lower || aligned > upper) {
    throw new Error("Rounded price is outside the pool's usable tick range");
  }
  return Object.is(aligned, -0) ? 0 : aligned;
}
