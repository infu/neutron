/** Read-only liquidity previews from public ICPSwap queries. The saved action
 * backend independently revalidates every funding and protocol mutation. */
import type { JsonObject } from "neutron-tools/app";
import { Principal } from "@icp-sdk/core/principal";
import type { LiquidityWire } from "./action_backend.ts";
import { createLiquidityReadClient, type BrowserPoolView, type BrowserPosition } from "./liquidity_reads.ts";
import { amountsForLiquidity, getSqrtRatioAtTick, liquidityForAmounts, MAX_TICK, MIN_TICK } from "./liquidity_math.ts";

export type LiquidityPreviewReads = Pick<ReturnType<typeof createLiquidityReadClient>, "readPool">;

/** Public ICPSwap v3.7.0 claim/removal settlement estimate. Positive output
 * <= fee remains pool credit: no ledger transfer or fee debit is expected. */
export function estimateLiquidityPayout(gross: bigint, ledgerFee: bigint): {
  net: bigint; status: "no_output" | "retained_in_pool" | "transfer_estimated";
} {
  if (gross < 0n || ledgerFee < 0n) throw new Error("Payout amounts and ledger fees must be nonnegative.");
  if (gross === 0n) return { net: 0n, status: "no_output" };
  if (gross <= ledgerFee) return { net: 0n, status: "retained_in_pool" };
  return { net: gross - ledgerFee, status: "transfer_estimated" };
}

function nat(value: string, label: string): bigint {
  if (typeof value !== "string" || !/^[0-9]+$/u.test(value)) throw new Error(`${label} must be an exact nonnegative integer.`);
  return BigInt(value);
}

function tick(value: string, label: string): number {
  if (typeof value !== "string" || !/^-?[0-9]+$/u.test(value)) throw new Error(`${label} must be an exact integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be an exact integer.`);
  return parsed;
}

function observedAt(view: BrowserPoolView): string {
  const milliseconds = Date.parse(view.source.observedAt);
  if (!Number.isSafeInteger(milliseconds)) throw new Error("Pool observation time is unavailable.");
  // Date precision is milliseconds. Convert to the existing nanosecond field
  // without implying that these separate pool queries form an atomic snapshot.
  return (BigInt(milliseconds) * 1_000_000n).toString();
}

function positionToWire(value: BrowserPosition): JsonObject {
  const current = value.feeError === null && value.tokensOwed0 !== null && value.tokensOwed1 !== null;
  return {
    id: value.id, tick_lower: String(value.tickLower), tick_upper: String(value.tickUpper), liquidity: value.liquidity,
    amount0: value.amount0, amount1: value.amount1,
    fees0: current ? value.tokensOwed0 : null, fees1: current ? value.tokensOwed1 : null,
    fees_current: current, error: current ? "" : value.feeError ?? "Current position fees are unavailable.",
  };
}

/** Preserve existing pool field names for action reconciliation. A failed
 * public read stays null; it is never presented as an observed empty balance,
 * position list, queue or fee estimate. Queue totals are scheduled net amounts,
 * matching ICPSwap's getUserWithdrawQueue, and are not ledger receipts. */
export function browserPoolToWire(view: BrowserPoolView): JsonObject {
  const queued = (token: string) => view.withdrawals === null ? null : view.withdrawals
    .filter((item) => item.token === token)
    .reduce((sum, item) => sum + BigInt(item.amount), 0n).toString();
  return {
    pool: view.pool.pool, key: view.pool.key, owner: view.owner,
    token0: { ...view.pool.token0 }, token1: { ...view.pool.token1 },
    fee: String(view.pool.fee), tick_spacing: String(view.pool.tickSpacing),
    tick: view.metadata === null ? null : String(view.metadata.tick),
    sqrt_price_x96: view.metadata?.sqrtPriceX96 ?? null, liquidity: view.metadata?.liquidity ?? null,
    fee0: view.cachedFees?.token0Fee ?? null, fee1: view.cachedFees?.token1Fee ?? null,
    available: view.available, unused0: view.unused?.balance0 ?? null, unused1: view.unused?.balance1 ?? null,
    queued0: queued(view.pool.token0.address), queued1: queued(view.pool.token1.address),
    reserved0: view.reserved?.balance0 ?? null, reserved1: view.reserved?.balance1 ?? null,
    positions: view.positions === null ? null : view.positions.map(positionToWire),
    queue: view.withdrawals === null ? null : view.withdrawals.map((item) => ({
      transaction_id: item.transactionId, token: item.token, amount: item.amount, fee: item.fee,
      recipient: item.recipient, recipient_subaccount: item.recipientSubaccount,
    })),
    transactions: view.transactions === null ? null : view.transactions.map((item) => ({
      id: item.id, kind: item.action, state: item.status, token: item.token, amount: item.amount,
      error: item.error ?? "", unused_reserved: item.unusedReserved, support_required: item.supportRequired,
    })),
    protocol_diagnostics: view.errors.map((issue) => `${issue.method}: ${issue.message}`).join("; "),
    observed_at: observedAt(view), source: { ...view.source }, read_errors: view.errors.map((issue) => ({ ...issue })),
  };
}

function unavailable(view: BrowserPoolView, field: string): never {
  const diagnostics = view.errors.map((issue) => `${issue.method}: ${issue.message}`).join("; ");
  throw new Error(`${field} is unavailable in the current pool observation.${diagnostics ? ` ${diagnostics}` : ""}`);
}

function range(sqrtPrice: bigint, lower: number, upper: number): [bigint, bigint] {
  if (lower >= upper) throw new Error("The lower tick must be less than the upper tick.");
  if (sqrtPrice < getSqrtRatioAtTick(MIN_TICK) || sqrtPrice >= getSqrtRatioAtTick(MAX_TICK)) {
    throw new Error("Pool sqrt price is outside the initialized protocol range.");
  }
  return [getSqrtRatioAtTick(lower), getSqrtRatioAtTick(upper)];
}

/** Compatible plan fields for the public preview tool, without a Neutron
 * update, ledger read, approval, saved intent or protocol mutation. Funding
 * deficits are based on hard maxima less unreserved pool credit; they are not
 * a claim that the Wallet has sufficient balance or an existing allowance. */
export async function previewLiquidity(
  request: LiquidityWire,
  owner: string,
  reads: LiquidityPreviewReads = createLiquidityReadClient(),
  signal?: AbortSignal,
): Promise<JsonObject> {
  signal?.throwIfAborted();
  if (!["mint", "increase", "decrease", "close", "claim", "withdraw"].includes(request.kind)) throw new Error("Unknown liquidity operation kind.");
  const poolId = Principal.fromText(request.pool).toText();
  owner = Principal.fromText(owner).toText();
  const maximum0 = nat(request.amount0, "Token0 maximum"), maximum1 = nat(request.amount1, "Token1 maximum");
  const requestedLiquidity = nat(request.liquidity, "Liquidity"), withdrawalAmount = nat(request.withdraw_amount, "Withdrawal amount");
  let lower = tick(request.tick_lower, "Lower tick"), upper = tick(request.tick_upper, "Upper tick");
  const positionId = request.position_id === null ? null : nat(request.position_id, "Position ID").toString();
  const view = await reads.readPool(poolId, owner, signal);
  signal?.throwIfAborted();
  if (view.pool.pool !== poolId || view.owner !== owner) throw new Error("Pool observation does not match the requested pool and Neutron account.");
  if (view.metadata === null) unavailable(view, "Pool price");
  if (view.cachedFees === null) unavailable(view, "Pool token fees");
  if (view.available === null) unavailable(view, "Pool availability");
  if (!view.available) throw new Error("This pool is not available to this Neutron.");
  if (view.positions === null) unavailable(view, "Owned positions");
  if (view.unused === null) unavailable(view, "Pool unused balance");
  const sqrtPrice = nat(view.metadata.sqrtPriceX96, "Pool sqrt price");
  const fee0 = nat(view.cachedFees.token0Fee, "Token0 fee"), fee1 = nat(view.cachedFees.token1Fee, "Token1 fee");
  let effective: LiquidityWire = { ...request, pool: poolId, position_id: positionId,
    tick_lower: String(lower), tick_upper: String(upper), amount0: maximum0.toString(), amount1: maximum1.toString(),
    liquidity: requestedLiquidity.toString(), withdraw_amount: withdrawalAmount.toString() };
  let selected: BrowserPosition | null = null;
  if (["increase", "decrease", "close", "claim"].includes(request.kind)) {
    if (positionId === null) throw new Error("A position ID is required.");
    selected = view.positions.find((position) => position.id === positionId) ?? null;
    if (selected === null) throw new Error("This Neutron does not own the selected position.");
    // A failed getUserPosition leaves only the owner-list's stored state. It
    // cannot supply a current range/liquidity or a current fee estimate.
    if (selected.feeError !== null || selected.tokensOwed0 === null || selected.tokensOwed1 === null) {
      throw new Error(`Current position state is unavailable. ${selected.feeError ?? "The selected position has no current fee observation."}`);
    }
    lower = selected.tickLower; upper = selected.tickUpper;
    effective = { ...effective, tick_lower: String(lower), tick_upper: String(upper) };
  }
  const usesUnused = request.kind === "mint" || request.kind === "increase" || request.kind === "withdraw";
  if (usesUnused && (view.availableUnused === null || view.reserved === null || view.transactions === null)) {
    unavailable(view, "Unreserved pool balance");
  }
  let amount0 = 0n, amount1 = 0n, liquidity = 0n, funding0 = 0n, funding1 = 0n;
  if (request.kind === "mint" || request.kind === "increase") {
    if (view.pool.tickSpacing <= 0 || lower % view.pool.tickSpacing !== 0 || upper % view.pool.tickSpacing !== 0) {
      throw new Error("Position ticks must align with the factory's tick spacing.");
    }
    const [a, b] = range(sqrtPrice, lower, upper);
    liquidity = liquidityForAmounts(sqrtPrice, a, b, maximum0, maximum1);
    if (liquidity === 0n) throw new Error("These amounts would create zero liquidity at the observed pool price.");
    ({ amount0, amount1 } = amountsForLiquidity(sqrtPrice, a, b, liquidity, true));
    const deficit = (maximum: bigint, available: string) => maximum > BigInt(available) ? maximum - BigInt(available) : 0n;
    funding0 = deficit(maximum0, view.availableUnused!.balance0);
    funding1 = deficit(maximum1, view.availableUnused!.balance1);
    for (const [token, funding, fee] of [[view.pool.token0, funding0, fee0], [view.pool.token1, funding1, fee1]] as const) {
      if (funding === 0n) continue;
      if (!["ICRC2", "ICRC1", "ICP"].includes(token.standard)) throw new Error(`Wallet funding is unavailable for the pool token standard ${token.standard}.`);
      if (token.standard === "ICRC2" && funding <= fee) throw new Error("ICPSwap depositFrom requires a positive funding deficit greater than the token fee.");
    }
  } else if (selected !== null) {
    const fees0 = nat(selected.tokensOwed0!, "Current token0 fees"), fees1 = nat(selected.tokensOwed1!, "Current token1 fees");
    if (request.kind === "claim") {
      amount0 = fees0; amount1 = fees1;
    } else {
      const ownedLiquidity = nat(selected.liquidity, "Owned liquidity");
      liquidity = request.kind === "close" ? ownedLiquidity : requestedLiquidity;
      if (liquidity === 0n || liquidity > ownedLiquidity) throw new Error("The removal amount must be positive and no greater than the owned position's liquidity.");
      effective = { ...effective, liquidity: liquidity.toString() };
      const [a, b] = range(sqrtPrice, lower, upper);
      ({ amount0, amount1 } = amountsForLiquidity(sqrtPrice, a, b, liquidity));
      // Partial removal collects all current fees, not a proportional share.
      amount0 += fees0; amount1 += fees1;
    }
  } else if (request.kind === "withdraw") {
    const index = request.withdraw_token === view.pool.token0.address ? 0 : request.withdraw_token === view.pool.token1.address ? 1 : null;
    if (index === null) throw new Error("Withdrawal token must be one of the verified pool tokens.");
    const available = BigInt(index === 0 ? view.availableUnused!.balance0 : view.availableUnused!.balance1);
    if (withdrawalAmount <= (index === 0 ? fee0 : fee1) || withdrawalAmount > available) {
      throw new Error("The gross unused withdrawal must exceed its fee and fit the balance not reserved by the withdrawal queue.");
    }
    if (index === 0) amount0 = withdrawalAmount; else amount1 = withdrawalAmount;
  }
  signal?.throwIfAborted();
  const deposit = request.kind === "mint" || request.kind === "increase";
  const warnings: string[] = [];
  const payout = (amount: bigint, fee: bigint, token: string) => {
    if (deposit) return { net: null, status: "not_applicable" };
    const estimate = estimateLiquidityPayout(amount, fee);
    if (estimate.status === "retained_in_pool") {
      // ICPSwap v3.7.0 credits claim/removal gross output to TokenHolder.
      // _withdraw exits before a balance debit or ledger transfer for <= fee;
      // the amount is retained pool credit, not a fee already charged or lost.
      warnings.push(`${token}: the gross amount (${amount} atoms) does not exceed its transfer fee (${fee} atoms). No Wallet transfer is expected; the amount would remain in your pool balance.`);
    }
    return { net: estimate.net.toString(), status: estimate.status };
  };
  const payout0 = payout(amount0, fee0, view.pool.token0.address);
  const payout1 = payout(amount1, fee1, view.pool.token1.address);
  return {
    version: 1,
    request: { ...effective }, pool: poolId, owner,
    token0: { ...view.pool.token0 }, token1: { ...view.pool.token1 },
    fee: String(view.pool.fee), tick_spacing: String(view.pool.tickSpacing), tick: String(view.metadata.tick), sqrt_price_x96: view.metadata.sqrtPriceX96,
    fee0: fee0.toString(), fee1: fee1.toString(), funding0: funding0.toString(), funding1: funding1.toString(),
    expected_amount0: amount0.toString(), expected_amount1: amount1.toString(), expected_liquidity: liquidity.toString(),
    amount_semantics: deposit ? "input_consumption" : "gross_pool_output",
    expected_net_amount0: payout0.net, expected_net_amount1: payout1.net,
    payout0: payout0.status, payout1: payout1.status, warnings,
    unused0: view.unused.balance0, unused1: view.unused.balance1, baseline_positions: view.positions.map(positionToWire),
    observed_at: observedAt(view), price_protection: false,
    detail: "Expected amounts reflect the observed pool state. ICPSwap liquidity methods have no price minimum or deadline. Desired amounts cap input consumption. Protocol success does not prove a refund or withdrawal reached Wallet.",
    source: { ...view.source }, read_errors: view.errors.map((issue) => ({ ...issue })),
  };
}
