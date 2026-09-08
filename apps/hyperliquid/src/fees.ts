import Decimal from "decimal.js";
import type { UserFees } from "./market";

const D = Decimal.clone({ precision: 80, toExpNeg: -100, toExpPos: 100 });
const decimal = (value: unknown): Decimal | null => typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value) ? new D(value) : null;

export type PerpFeeRates = { takerRate: string; makerRate: string; activeReferralDiscount?: string };

/** Default-perps rates from userFees already include the account's fee tier and
 * staking discount. The separately observed referral discount applies to taker
 * fees and positive maker fees, but does not reduce maker rebates.
 * https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees#fee-formula-for-developers
 * Keep raw observations unchanged; an omitted discount is not an observed zero. */
export function calculatePerpFeeRates(fees: UserFees | null | undefined): PerpFeeRates | null {
  const taker = decimal(fees?.userCrossRate), maker = decimal(fees?.userAddRate);
  if (!taker || !maker) return null;
  if (fees?.activeReferralDiscount === undefined) return { takerRate: taker.toFixed(), makerRate: maker.toFixed() };
  const discount = decimal(fees.activeReferralDiscount);
  if (!discount || discount.lt(0) || discount.gt(1)) return null;
  const factor = new D(1).minus(discount);
  return {
    takerRate: taker.mul(factor).toFixed(),
    makerRate: (maker.gt(0) ? maker.mul(factor) : maker).toFixed(),
    activeReferralDiscount: discount.toFixed(),
  };
}
