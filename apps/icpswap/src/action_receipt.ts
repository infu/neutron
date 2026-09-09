import { isJsonObject, type JsonObject } from "neutron-tools/app";
import type { ActionPrepared } from "./action_backend.ts";

type LiquidityKind = "mint" | "increase" | "decrease" | "close" | "claim" | "withdraw";
type Token = { address: string; standard: string };
type PairAmounts = { amount0: string; amount1: string };

/** A protocol result is evidence of its exact effect, not a ledger receipt.
 * Decimal strings remain exact; absent actual amounts never become zeros or
 * amounts copied from a pre-execution estimate.
 */
export type LiquidityReceipt = {
  version: 1;
  kind: "liquidity";
  operationId: string;
  action: LiquidityKind;
  pool: string;
  owner: string;
  token0: Token;
  token1: Token;
  positionId: string | null;
  protocol: { status: "succeeded"; effectKey: "liquidity"; method: string; completedAtNs: string | null; resultNat: string | null };
  grossOutputAmounts: PairAmounts | null;
  liquidityRemoved: string | null;
  actualTokenUse: null;
  refunds: null;
  amountNote: string;
  settlement: {
    status: "not_required" | "unverified";
    payoutReferences: [];
    reason: string;
  };
};

const methods: Record<LiquidityKind, string> = {
  mint: "mint", increase: "increaseLiquidity", decrease: "decreaseLiquidity",
  close: "decreaseLiquidity", claim: "claim", withdraw: "withdraw",
};
function text(value: unknown): string | null { return typeof value === "string" && value !== "" ? value : null; }
function nat(value: unknown): string | null { return typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value) ? value : null; }
function token(value: unknown): Token | null {
  if (!isJsonObject(value)) return null;
  const address = text(value.address), standard = text(value.standard);
  return address && standard ? { address, standard } : null;
}

/** Call with the backend's decoded typed plan and full retained effects.
 * History summaries intentionally lack the evidence needed for a receipt.
 */
export function buildLiquidityReceipt({ operation, plan }: ActionPrepared): LiquidityReceipt | null {
  if (!isJsonObject(plan.request) || typeof plan.request.kind !== "string" || !Object.hasOwn(methods, plan.request.kind)) return null;
  if (operation.state === "uncertain" || operation.state === "stopped" ||
    operation.effects.some((effect) => effect.state === "requested" || effect.state === "uncertain" || effect.state === "failed")) return null;
  const action = plan.request.kind as LiquidityKind, pool = text(plan.pool), owner = text(plan.owner);
  const token0 = token(plan.token0), token1 = token(plan.token1);
  if (!pool || !owner || !token0 || !token1 || plan.request.pool !== pool) return null;
  const matching = operation.effects.filter((effect) => effect.key === "liquidity");
  if (matching.length !== 1) return null;
  const effect = matching[0]!;
  if (effect.state !== "succeeded" || effect.canister !== pool || effect.method !== methods[action]) return null;
  const adding = action === "mint" || action === "increase";
  const pairedOutput = action === "decrease" || action === "close" || action === "claim";
  const amount0 = nat(effect.result_amount0), amount1 = nat(effect.result_amount1);
  const grossOutputAmounts = pairedOutput && amount0 !== null && amount1 !== null ? { amount0, amount1 } : null;
  const noPayout = action === "claim" && grossOutputAmounts?.amount0 === "0" && grossOutputAmounts.amount1 === "0";
  return {
    version: 1, kind: "liquidity", operationId: operation.id, action, pool, owner, token0, token1,
    positionId: adding ? nat(effect.result_nat) : action === "withdraw" ? null : nat(plan.request.position_id),
    protocol: { status: "succeeded", effectKey: "liquidity", method: methods[action],
      completedAtNs: nat(effect.completed_at), resultNat: nat(effect.result_nat) },
    grossOutputAmounts,
    liquidityRemoved: action === "decrease" || action === "close" ? nat(plan.request.liquidity) : null,
    actualTokenUse: null, refunds: null,
    amountNote: adding
      ? "The protocol returns a position ID, not actual token use or refunds. Saved budgets and expected amounts are not actual amounts."
      : "Pair outputs are gross amounts from the protocol reply; they can include principal and fees. Actual token use, refunds and net Wallet credits are not established by this reply.",
    settlement: {
      status: noPayout ? "not_required" : "unverified",
      payoutReferences: [],
      reason: noPayout
        ? "The retained successful claim returned 0/0, so this effect requires no ledger payout."
        : "The retained reply has no operation-linked ledger block, recipient and amount receipts. Empty queues or changed balances do not prove settlement.",
    },
  };
}

export const durablePlanSource: JsonObject = {
  kind: "durable_candid_plan_blob",
  note: "plan is decoded from the retained plan_blob. operation.plan_json is the legacy JSON slot and can be empty without losing the typed plan.",
};

/** The saved swap backend has never established an outgoing ledger receipt.
 * Retain its legacy numeric field for existing callers, but make the unknown
 * net amount explicit. Quotes and successful protocol outputs cannot verify it.
 */
export function buildSwapReceipt(prepared: ActionPrepared): JsonObject | null {
  if (!prepared.receipt) return null;
  return {
    ...prepared.receipt,
    version: 1, kind: "swap", operationId: prepared.operation.id,
    received_out_verified: false,
    netOutputAtoms: null,
    settlement: {
      status: "unverified", payoutReferences: [],
      reason: "No operation-linked ledger payout has been verified. received_out is a legacy placeholder, not an observed zero; netOutputAtoms remains null until exact payout evidence exists.",
    },
  };
}
