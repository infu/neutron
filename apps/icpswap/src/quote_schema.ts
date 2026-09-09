/** Versioned public quote contracts. Atomic amounts stay decimal strings;
 * estimates never stand in for a successful funding or settlement receipt. */
import type { JsonObject } from "neutron-tools/app";

const text: JsonObject = { type: "string" };
const nat: JsonObject = { type: "string", pattern: "^0$|^[1-9][0-9]*$" };
const integer: JsonObject = { type: "string", pattern: "^0$|^-?[1-9][0-9]*$" };
const nullableNat: JsonObject = { oneOf: [nat, { type: "null" }] };
const object = (properties: JsonObject, description?: string): JsonObject => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
  ...(description ? { description } : {}),
});
const token = object({ address: text, standard: text });
const source = object({ kind: { type: "string", enum: ["direct-canister-query"] }, host: text, observedAt: text },
  "Public query source and response time. Separate canister queries are not an atomic snapshot.");
const readIssue = object({ canister: text, method: text, message: text });
const position = object({
  id: nat, tick_lower: integer, tick_upper: integer, liquidity: nat,
  amount0: nullableNat, amount1: nullableNat, fees0: nullableNat, fees1: nullableNat,
  fees_current: { type: "boolean" }, error: text,
}, "Observed position principal and fee estimates. Unavailable amounts are null; stale stored fees are not current zeros.");
const payout = {
  type: "string", enum: ["not_applicable", "no_output", "retained_in_pool", "transfer_estimated"],
  description: "not_applicable for deposit consumption; no_output for zero gross output; retained_in_pool when positive gross does not exceed the ledger fee (no Wallet transfer or ledger fee debit expected); transfer_estimated when gross exceeds the fee. No value is a settlement receipt.",
};

export const swapQuoteOutputSchema: JsonObject = object({
  version: { type: "integer", enum: [1] },
  source: { type: "string", enum: ["icpswap-pool"] },
  transport: { type: "string", enum: ["direct-canister-query"] },
  as_of: { ...text, description: "ISO response time, not a promise of an atomic chain snapshot." },
  as_of_kind: { type: "string", enum: ["response_time"] },
  note: text,
  context_as_of: { ...text, description: "ISO time of the briefly reused pool context; can precede the quote response time." },
  pool: text, pool_key: text, fee_tier: { type: "integer", minimum: 0 },
  from_ledger_id: text, to_ledger_id: text, amount_in: nat,
  expected_out: { ...nat, description: "Expected NET Wallet output: quoted_out_gross minus the observed output ledger fee. Estimate, not a receipt." },
  minimum_out: { ...nat, description: "DEPRECATED ambiguous alias of minimum_out_gross. This is GROSS pool output before its ledger fee and must not be compared directly with NET expected_out. Use minimum_out_net_estimate for a net-to-net comparison." },
  minimum_out_gross: { ...nat, description: "Gross minimum enforced by the pool. Slippage convention: floor(quoted_out_gross * 100000 / (100000 + slippage_thousandths_percent)); it is division by (1 + slippage), not multiplication by (1 - slippage)." },
  minimum_out_net_estimate: { ...nat, description: "Estimated NET output at the gross minimum: max(minimum_out_gross - output_ledger_fee, 0). The output ledger fee is an observation, not locked by this preview." },
  quoted_out_gross: { ...nat, description: "Quoted gross pool output before the output ledger transfer fee." },
  price_impact_percent: { type: "number" }, high_price_impact: { type: "boolean" },
  input_ledger_fee: nat, output_ledger_fee: nat,
  total_debited: { ...nat, description: "Estimated total Wallet debit including input-side funding fees; not an actual transfer receipt." },
  slippage_thousandths_percent: { type: "integer", minimum: 1, maximum: 50000 },
  funding: object({
    continuation_tool: { type: "string", enum: ["icpswap_swap_v1"] },
    target: { type: "string", enum: ["app:icpswap:background"] },
    ledger: text, spender: text, amount_atoms: nat, note: text,
  }, "Informational funding estimate. Use the saved action tool to prepare a retained, reviewed Wallet request before funding."),
}, "ICPSwap browser swap quote, version 1. Gross pool output and net Wallet estimates use distinct fields; no funds move.");

export const liquidityPlanOutputSchema: JsonObject = object({
  version: { type: "integer", enum: [1] },
  request: object({
    pool: text, kind: { type: "string", enum: ["mint", "increase", "decrease", "close", "claim", "withdraw"] },
    position_id: nullableNat, tick_lower: integer, tick_upper: integer,
    amount0: nat, amount1: nat, liquidity: nat, withdraw_token: text, withdraw_amount: nat,
  }),
  pool: text, owner: text, token0: token, token1: token,
  fee: nat, tick_spacing: integer, tick: integer, sqrt_price_x96: nat,
  fee0: { ...nat, description: "Observed token0 ledger transfer fee in atoms." },
  fee1: { ...nat, description: "Observed token1 ledger transfer fee in atoms." },
  funding0: { ...nat, description: "Token0 funding deficit from hard maximum less unreserved pool credit; does not establish Wallet balance or allowance." },
  funding1: { ...nat, description: "Token1 funding deficit from hard maximum less unreserved pool credit; does not establish Wallet balance or allowance." },
  expected_amount0: { ...nat, description: "Estimated input consumption for mint/increase, otherwise GROSS output before any ledger transfer fee. Interpret with amount_semantics." },
  expected_amount1: { ...nat, description: "Estimated input consumption for mint/increase, otherwise GROSS output before any ledger transfer fee. Interpret with amount_semantics." },
  expected_liquidity: { ...nat, description: "Estimated liquidity added or removed; zero for claim and unused withdrawal." },
  amount_semantics: { type: "string", enum: ["input_consumption", "gross_pool_output"] },
  expected_net_amount0: { ...nullableNat, description: "Null for deposit consumption; otherwise estimated token0 Wallet transfer max(expected_amount0 - fee0, 0). Not a payout guarantee or receipt." },
  expected_net_amount1: { ...nullableNat, description: "Null for deposit consumption; otherwise estimated token1 Wallet transfer max(expected_amount1 - fee1, 0). Not a payout guarantee or receipt." },
  payout0: payout, payout1: payout,
  warnings: { type: "array", items: text, description: "Actionable estimate guidance, including positive gross amounts that would remain as unused pool credit because they do not exceed a transfer fee." },
  unused0: nat, unused1: nat,
  baseline_positions: { type: "array", items: position },
  observed_at: { ...integer, description: "Observation response time in nanoseconds, with millisecond precision; underlying public queries need not share one snapshot." },
  price_protection: { type: "boolean", enum: [false], description: "ICPSwap liquidity methods have no protocol minimum output or deadline. Hard deposit maxima do not protect the execution price." },
  detail: text, source, read_errors: { type: "array", items: readIssue },
}, "Read-only browser liquidity preview. Prepared execution independently revalidates the plan; gross exits can include principal and all current fees, not only profit.");

export const liquidityQuoteOutputSchema: JsonObject = object({
  version: { type: "integer", enum: [1] },
  plan: liquidityPlanOutputSchema,
  transport: { type: "string", enum: ["direct-canister-query"] },
}, "ICPSwap browser liquidity quote, version 1. This does not save an intent, fund the pool or prove settlement.");
