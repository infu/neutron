import { isJsonObject, type JsonObject } from "neutron-tools/app";
import { fromBaseUnits } from "./amount.ts";
import { tickToPrice } from "./liquidity_math.ts";
import { estimateLiquidityPayout } from "./liquidity_quote.ts";
import type { WalletTokenInfo } from "./wallet.ts";

export type ActionReviewInput = {
  operationId: string;
  kind: "swap" | "liquidity";
  input: JsonObject;
  plan: JsonObject;
  metadata: ReadonlyMap<string, Pick<WalletTokenInfo, "ledger" | "symbol" | "decimals">>;
};

const UNAVAILABLE = "Unavailable";

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function nat(value: unknown): bigint | null {
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return null;
}

function integer(value: unknown): string | null {
  if (typeof value === "string" && /^-?(0|[1-9][0-9]*)$/u.test(value)) return value;
  return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : null;
}

function afterFee(amount: unknown, fee: unknown): string | null {
  const gross = nat(amount), cost = nat(fee);
  return gross === null || cost === null ? null : (gross > cost ? gross - cost : 0n).toString();
}

/** Exit consent fixes the protocol request and costs. Output amounts, fee
 * growth and spot price are observations, not liquidity slippage guarantees. */
export function sameLiquidityExitTerms(approved: JsonObject, prepared: JsonObject): boolean {
  const a = isJsonObject(approved.request) ? approved.request : null;
  const b = isJsonObject(prepared.request) ? prepared.request : null;
  if (!a || !b || !["decrease", "close", "claim", "withdraw"].includes(String(a.kind))) return false;
  for (const key of ["pool", "kind", "position_id", "tick_lower", "tick_upper", "amount0", "amount1", "liquidity", "withdraw_token", "withdraw_amount"]) {
    if (a[key] !== b[key]) return false;
  }
  for (const key of ["pool", "owner", "fee", "tick_spacing", "fee0", "fee1", "price_protection"]) {
    if (approved[key] !== prepared[key]) return false;
  }
  for (const key of ["token0", "token1"]) {
    const left = approved[key], right = prepared[key];
    if (!isJsonObject(left) || !isJsonObject(right) || left.address !== right.address || left.standard !== right.standard) return false;
  }
  return [approved.funding0, approved.funding1, prepared.funding0, prepared.funding1].every((value) => nat(value) === 0n);
}

/** A compact review of the retained plan; formatting never rounds atomic amounts. */
export function buildActionReview({ operationId, kind, input, plan, metadata }: ActionReviewInput): JsonObject {
  const infoFor = (ledger: string | null): Pick<WalletTokenInfo, "ledger" | "symbol" | "decimals"> | null => {
    const info = ledger === null ? undefined : metadata.get(ledger);
    return info && info.ledger === ledger && Number.isSafeInteger(info.decimals) && info.decimals >= 0 && info.decimals <= 255 && info.symbol.trim() !== "" ? info : null;
  };
  const label = (ledger: string | null): string => infoFor(ledger)?.symbol ?? ledger ?? "Unknown token";
  const amount = (value: unknown, ledger: string | null): string => {
    const atoms = nat(value);
    if (atoms === null) return UNAVAILABLE;
    const info = infoFor(ledger);
    return info ? `${fromBaseUnits(atoms, info.decimals)} ${info.symbol}` : `${atoms} atoms (${ledger ?? "unknown ledger"})`;
  };
  const exactAction: JsonObject = { operationId, input, plan };

  if (kind === "swap") {
    const from = text(plan.input_address), to = text(plan.output_address);
    const slippage = nat(plan.slippage);
    return {
      title: "Swap through ICPSwap",
      pair: `${label(from)} → ${label(to)}`,
      amount: amount(plan.amount_in, from),
      expectedOutputNet: amount(plan.expected_out ?? afterFee(plan.quoted_out, plan.token_out_fee), to),
      quotedOutputGross: amount(plan.quoted_out, to),
      minimumOutputGross: amount(plan.amount_out_minimum, to),
      minimumOutputNetEstimate: amount(afterFee(plan.amount_out_minimum, plan.token_out_fee), to),
      estimatedWalletDebit: amount(plan.total_debit, from),
      slippage: slippage === null ? UNAVAILABLE : `${fromBaseUnits(slippage, 3)}%`,
      pool: text(plan.pool) ?? UNAVAILABLE,
      funding: { route: "Approve the pool", amount: amount(plan.funding_amount, from) },
      fees: { inputLedgerFee: amount(plan.token_in_fee, from), outputLedgerFee: amount(plan.token_out_fee, to) },
      notes: [
        "The pool enforces the gross minimum. The output ledger fee reduces the amount received in Wallet.",
        "The estimated Wallet debit includes the input amount, the approval fee and the pool's transfer fee.",
        "A protocol success is separate from the outgoing transfer settling in Wallet.",
      ],
      exactAction,
    };
  }

  const request = isJsonObject(plan.request) ? plan.request : {};
  const operation = text(request.kind) ?? text(input.kind) ?? "liquidity";
  const token0 = isJsonObject(plan.token0) ? plan.token0 : {};
  const token1 = isJsonObject(plan.token1) ? plan.token1 : {};
  const ledger0 = text(token0.address), ledger1 = text(token1.address);
  const adding = operation === "mint" || operation === "increase";
  const titles: Record<string, string> = {
    mint: "Create an ICPSwap position", increase: "Add ICPSwap liquidity",
    decrease: "Remove ICPSwap liquidity", close: "Close an ICPSwap position",
    claim: "Collect ICPSwap fees", withdraw: "Withdraw unused ICPSwap funds",
  };
  const notes = [
    "ICPSwap liquidity methods have no protocol-enforced minimum amounts or deadline. Expected amounts can change before execution.",
    "Payouts and refunds settle asynchronously. A successful protocol call does not confirm receipt in Wallet.",
  ];
  if (adding) notes.push("Token maximums cap position inputs. The pool may refund unused input asynchronously; check refunds and unused balances before reusing those funds.");
  else if (operation !== "withdraw") notes.push("Expected pool amounts are before transfer fees. Only amounts above the token's transfer fee can be sent to Wallet.");

  const funding: JsonObject[] = [];
  for (const [suffix, token, ledger] of [["0", token0, ledger0], ["1", token1, ledger1]] as const) {
    const deficit = nat(plan[`funding${suffix}`]), fee = nat(plan[`fee${suffix}`]);
    if (deficit === 0n) continue;
    const standard = text(token.standard), direct = standard === "ICRC1" || standard === "ICP";
    funding.push({
      token: label(ledger),
      poolFundingDeficit: amount(plan[`funding${suffix}`], ledger),
      route: standard === "ICRC2" ? "Approve the pool" : direct ? "Send to the pool deposit account" : UNAVAILABLE,
      requestedWalletAmount: amount(deficit === null ? null : direct ? fee === null ? null : (deficit + fee).toString() : deficit.toString(), ledger),
      estimatedWalletDebit: amount(deficit === null || fee === null ? null : (deficit + 2n * fee).toString(), ledger),
    });
  }
  const positionId = nat(request.position_id);
  const lower = integer(request.tick_lower), upper = integer(request.tick_upper);
  let range = lower === null || upper === null ? UNAVAILABLE : `Ticks ${lower} to ${upper}`;
  const info0 = infoFor(ledger0), info1 = infoFor(ledger1);
  if (info0 && info1 && lower !== null && upper !== null) {
    try {
      const display = (tick: string) => Number(tickToPrice(Number(tick), info0.decimals, info1.decimals)).toPrecision(8).replace(/(\.[0-9]*?)0+(?=e|$)/u, "$1").replace(/\.(?=e|$)/u, "");
      range = `≈ ${display(lower)} to ${display(upper)} ${info1.symbol} / ${info0.symbol}`;
    } catch { /* Exact retained ticks remain usable if a historical range cannot be formatted. */ }
  }
  const review: JsonObject = {
    title: titles[operation] ?? "Review ICPSwap liquidity",
    pair: `${label(ledger0)} / ${label(ledger1)}`,
    pool: text(plan.pool) ?? UNAVAILABLE,
    position: operation === "mint" ? "New position" : positionId === null ? operation === "withdraw" ? "Pool unused balance" : UNAVAILABLE : `#${positionId}`,
    range: operation === "withdraw" ? null : range,
    funding,
    fees: { token0LedgerFee: amount(plan.fee0, ledger0), token1LedgerFee: amount(plan.fee1, ledger1) },
    notes,
    exactAction,
  };
  if (adding) {
    review.maximums = [amount(request.amount0, ledger0), amount(request.amount1, ledger1)];
    review.expectedPositionAmounts = [amount(plan.expected_amount0, ledger0), amount(plan.expected_amount1, ledger1)];
  } else if (operation === "withdraw") {
    const ledger = text(request.withdraw_token);
    const fee = ledger === ledger0 ? plan.fee0 : ledger === ledger1 ? plan.fee1 : null;
    review.amount = amount(request.withdraw_amount, ledger);
    review.expectedOutputNet = amount(afterFee(request.withdraw_amount, fee), ledger);
    notes.push("The withdrawal amount is gross; one outgoing ledger fee is deducted from the Wallet receipt.");
  } else {
    review.expectedPoolAmountsGross = [amount(plan.expected_amount0, ledger0), amount(plan.expected_amount1, ledger1)];
    review.estimatedWalletAmountsNet = ["0", "1"].map((suffix) => {
      const ledger = suffix === "0" ? ledger0 : ledger1;
      const gross = nat(plan[`expected_amount${suffix}`]), fee = nat(plan[`fee${suffix}`]);
      if (gross === null || fee === null) return UNAVAILABLE;
      const payout = estimateLiquidityPayout(gross, fee);
      if (payout.status === "retained_in_pool") notes.push(`${amount(gross.toString(), ledger)} is at or below the transfer fee. It would stay in your pool balance; no Wallet payout or transfer fee debit is expected for this token.`);
      return amount(payout.net.toString(), ledger);
    });
    if (operation === "decrease" || operation === "close") {
      const liquidity = nat(request.liquidity);
      review.liquidityToRemove = liquidity === null ? UNAVAILABLE : liquidity.toString();
    }
  }
  return review;
}
