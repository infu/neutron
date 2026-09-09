import Decimal from "decimal.js";
import type { AccountSnapshot } from "./market";

const D = Decimal.clone({ precision: 80, toExpNeg: -100, toExpPos: 100 });

/** Current reducible exposure, shared by sizing and order review. This is an
 * observation, not a reservation or a restriction on venue-supported orders. */
export function observeReduction(coin: string, side: "buy" | "sell", sizeDecimals: number, positions: AccountSnapshot["positions"]) {
  const unavailable = (reason: string) => ({ positionSize: null, maxSize: null, reason });
  if (!positions) return unavailable("Your current position is unavailable. Refresh to try again.");
  const position = positions.find(value => value.coin === coin);
  if (position && !/^-?\d+(?:\.\d+)?$/.test(position.szi)) return unavailable("Your current position size is unavailable.");
  const remaining = new D(position?.szi ?? "0");
  if (remaining.isZero()) return { positionSize: "0", maxSize: "0", reason: `There is no ${coin} position to reduce.` };
  const closesPosition = side === "buy" ? remaining.lt(0) : remaining.gt(0);
  return closesPosition
    ? { positionSize: remaining.toFixed(), maxSize: remaining.abs().toDecimalPlaces(sizeDecimals, D.ROUND_DOWN).toFixed() }
    : { positionSize: remaining.toFixed(), maxSize: "0", reason: `Choose ${remaining.gt(0) ? "Sell" : "Buy"} to reduce this position.` };
}
