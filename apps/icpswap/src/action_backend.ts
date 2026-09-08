import type { JsonObject, JsonValue } from "neutron-tools/app";
import type { BackendTransport } from "./backend.ts";
import type { FundingOperation, FundingUpdate } from "./funding_workflow.ts";

/** Agent and tile calls must retain their own invocation-scoped transport. */
export type ActionOperation = FundingOperation & { effects: JsonObject[] };
export type ActionSummary = Pick<ActionOperation, "id" | "input_json" | "state" | "detail" | "revision" | "created_at" | "updated_at" | "effects">;
export type ActionPage = { items: ActionSummary[]; nextCursor: string | null };
export type ActionPrepared = { operation: ActionOperation; plan: JsonObject; receipt?: JsonObject | null };
export type SwapWire = {
  request_id: string; input_address: string; output_address: string; amount_in: string; slippage: string;
};
export type LiquidityWire = {
  pool: string; kind: string; position_id: string | null; tick_lower: string; tick_upper: string;
  amount0: string; amount1: string; liquidity: string; withdraw_token: string; withdraw_amount: string;
};
export type PrepareRequest<T> = { id: string; input_json: string; request: T };
export type ExecuteRequest = { id: string; expected_revision: string };
export type RecoveryPrepareRequest = { id: string; input_json: string; source_id: string; token_index: string };
export interface ActionBackend {
  actionGet(id: string): Promise<ActionOperation | null>;
  actionPage(request: { cursor: string | null; limit: number }): Promise<ActionPage>;
  actionUpdate(request: FundingUpdate): Promise<ActionOperation>;
  swapPrepare(request: PrepareRequest<SwapWire>): Promise<ActionPrepared>;
  swapExecute(request: ExecuteRequest): Promise<ActionPrepared>;
  swapStatus(id: string): Promise<ActionPrepared | null>;
  liquidityPrepare(request: PrepareRequest<LiquidityWire>): Promise<ActionPrepared>;
  liquidityExecute(request: ExecuteRequest): Promise<ActionPrepared>;
  liquidityStatus(id: string): Promise<ActionPrepared | null>;
  liquidityReconcile(id: string): Promise<ActionPrepared & { pool: JsonObject }>;
  liquidityPreview(request: LiquidityWire): Promise<JsonObject>;
  liquidityPool(pool: string): Promise<JsonObject>;
  recoveryPrepare(request: RecoveryPrepareRequest): Promise<ActionPrepared>;
  recoveryExecute(request: ExecuteRequest): Promise<ActionPrepared>;
  recoveryStatus(id: string): Promise<ActionPrepared | null>;
  account(): Promise<string>;
}

function invalid(path: string, expected: string): never {
  throw new Error(`Invalid ICPSwap backend ${path}: expected ${expected}`);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid(path, "record");
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  return typeof value === "string" ? value : invalid(path, "text");
}

function integer(value: unknown, path: string, signed = false): string {
  const result = typeof value === "bigint" ? value.toString()
    : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof result !== "string" || !(signed ? /^-?(0|[1-9][0-9]*)$/u : /^(0|[1-9][0-9]*)$/u).test(result)) {
    return invalid(path, signed ? "exact integer" : "exact nonnegative integer");
  }
  return result === "-0" ? "0" : result;
}

function flag(value: unknown, path: string): boolean {
  return typeof value === "boolean" ? value : invalid(path, "boolean");
}

function real(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return invalid(path, "finite number");
  return value;
}

function list<T>(value: unknown, path: string, parse: (value: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) return invalid(path, "array");
  return value.map((item, index) => parse(item, `${path}[${index}]`));
}

/** Self calls omit absent optional record fields and expose present values
 * directly. Accept explicit null and Candid's raw []/[T] form as well, without
 * mistaking ordinary vectors for optional values. */
function optional<T>(value: unknown, path: string, parse: (value: unknown, path: string) => T): T | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.length !== 1) return invalid(path, "optional value");
    return parse(value[0], path);
  }
  return parse(value, path);
}

type Parser = (value: unknown, path: string) => JsonValue;
function fields(value: unknown, path: string, shape: Record<string, Parser>): JsonObject {
  const raw = object(value, path);
  return Object.fromEntries(Object.entries(shape).map(([key, parse]) => [key, parse(raw[key], `${path}.${key}`)]));
}
const nat: Parser = (value, path) => integer(value, path);
const int: Parser = (value, path) => integer(value, path, true);
const optNat: Parser = (value, path) => optional(value, path, integer);
const optInt: Parser = (value, path) => optional(value, path, (item, at) => integer(item, at, true));
const token: Parser = (value, path) => fields(value, path, { address: text, standard: text });
const position: Parser = (value, path) => fields(value, path, {
  id: nat, tick_lower: int, tick_upper: int, liquidity: nat, amount0: nat, amount1: nat,
  fees0: nat, fees1: nat, fees_current: flag, error: text,
});
const requestShape: Record<string, Parser> = {
  pool: text, kind: text, position_id: optNat, tick_lower: int, tick_upper: int,
  amount0: nat, amount1: nat, liquidity: nat, withdraw_token: text, withdraw_amount: nat,
};
const liquidityRequest: Parser = (value, path) => fields(value, path, requestShape);

export function parseActionOperation(value: unknown, path = "operation"): ActionOperation {
  return fields(value, path, {
    id: text, input_json: text, plan_json: text, funding_json: text, state: text, detail: text,
    result_json: text, revision: nat, created_at: int, updated_at: int,
    effects: (items, at) => list(items, at, (item, itemPath) => fields(item, itemPath, {
      key: text, canister: text, method: text, state: text, error: text,
      dispatched_at: int, completed_at: optInt, result_nat: optNat,
      result_amount0: optNat, result_amount1: optNat,
    })),
  }) as ActionOperation;
}

export function parseActionSummary(value: unknown, path = "summary"): ActionSummary {
  return fields(value, path, {
    id: text, input_json: text, state: text, detail: text,
    revision: nat, created_at: int, updated_at: int,
    effects: (items, at) => list(items, at, (item, itemPath) => fields(item, itemPath, {
      key: text, canister: text, method: text, state: text, error: text,
      dispatched_at: int, completed_at: optInt,
    })),
  }) as ActionSummary;
}

/** Read every page for pool discovery, including pools whose final position
 * was closed. The requested page size controls payload size, not total history. */
export async function readAllActionSummaries(
  backend: Pick<ActionBackend, "actionPage">,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<ActionSummary[]> {
  const items: ActionSummary[] = [], seen = new Set<string>();
  let cursor: string | null = null;
  do {
    options.signal?.throwIfAborted();
    const page = await backend.actionPage({ cursor, limit: options.limit ?? 20 });
    options.signal?.throwIfAborted();
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor !== null) {
      if (seen.has(cursor)) throw new Error("Activity returned a repeated history cursor.");
      seen.add(cursor);
    }
  } while (cursor !== null);
  return items;
}

export function parseLiquidityPlan(value: unknown, path = "plan"): JsonObject {
  return fields(value, path, {
    request: liquidityRequest, pool: text, owner: text, token0: token, token1: token,
    fee: nat, tick_spacing: int, tick: int, sqrt_price_x96: nat,
    fee0: nat, fee1: nat, funding0: nat, funding1: nat,
    expected_amount0: nat, expected_amount1: nat, expected_liquidity: nat,
    unused0: nat, unused1: nat, baseline_positions: (items, at) => list(items, at, position),
    observed_at: int, price_protection: flag, detail: text,
  });
}

export function parseLiquidityPool(value: unknown, path = "pool"): JsonObject {
  return fields(value, path, {
    pool: text, key: text, owner: text, token0: token, token1: token,
    fee: nat, tick_spacing: int, tick: int, sqrt_price_x96: nat, liquidity: nat,
    fee0: nat, fee1: nat, available: flag, unused0: nat, unused1: nat,
    queued0: nat, queued1: nat, reserved0: nat, reserved1: nat,
    positions: (items, at) => list(items, at, position),
    queue: (items, at) => list(items, at, (item, itemPath) => fields(item, itemPath, {
      transaction_id: nat, token: text, amount: nat, fee: nat, recipient: text,
    })),
    transactions: (items, at) => list(items, at, (item, itemPath) => fields(item, itemPath, {
      id: nat, kind: text, state: text, token: (item, itemPath) => optional(item, itemPath, text),
      amount: nat, error: text, unused_reserved: flag, support_required: flag,
    })),
    protocol_diagnostics: text, observed_at: int,
  });
}

export function parseSwapPlan(value: unknown, path = "plan"): JsonObject {
  return fields(value, path, {
    pool: text, pool_key: text, fee_tier: nat, input_address: text, output_address: text,
    decimals_in: nat, decimals_out: nat, zero_for_one: flag, amount_in: nat,
    quoted_out: nat, amount_out_minimum: nat, expected_out: nat,
    token_in_fee: nat, token_out_fee: nat, funding_amount: nat, total_debit: nat,
    price_impact: real, warn: flag, slippage: nat, funding_ledger: text, funding_spender: text, at: int,
  });
}

export function parseRecoveryPlan(value: unknown, path = "plan"): JsonObject {
  return fields(value, path, {
    source_id: text, token_index: nat, pool: text, owner: text, token,
    gross_amount: nat, fee: nat, credit_amount: nat, observed_at: int,
  });
}

function parseSwapReceipt(value: unknown, path: string): JsonObject {
  return fields(value, path, {
    request_id: text, state: text, pool: text, input_address: text, output_address: text,
    amount_in: nat, amount_out_minimum: nat, swapped_out: nat, received_out: nat,
    detail: text, needs_funding: flag, funding_ledger: text, funding_spender: text,
    funding_amount: nat, at: int,
  });
}

function prepared(value: unknown, plan: (value: unknown, path: string) => JsonObject): ActionPrepared {
  const raw = object(value, "prepared action");
  return {
    operation: parseActionOperation(raw.operation), plan: plan(raw.plan, "plan"),
    ...(Object.hasOwn(raw, "receipt") ? { receipt: optional(raw.receipt, "receipt", parseSwapReceipt) } : {}),
  };
}

/** The Kernel already unwraps a Candid Result and rejects its error arm. Parsing
 * an additional `ok` envelope here would discard valid replies (the legacy quote
 * bug). Each parser therefore validates the actual returned record exactly once. */
export function createActionBackend(kernel: BackendTransport): ActionBackend {
  const swap = (value: unknown) => prepared(value, parseSwapPlan);
  const liquidity = (value: unknown) => prepared(value, parseLiquidityPlan);
  const recovery = (value: unknown) => prepared(value, parseRecoveryPlan);
  const status = async (id: string, family: "swap" | "liquidity" | "recovery", parse: (value: unknown) => ActionPrepared) =>
    optional(await kernel.querySelf("icpswap_action_status", [id]), "action status", (value, path) => {
      const variant = object(value, path);
      const tags = Object.keys(variant);
      if (tags.length !== 1 || !["swap", "liquidity", "recovery"].includes(tags[0]!)) {
        return invalid(path, "one swap, liquidity, or recovery variant arm");
      }
      return tags[0] === family ? parse(variant[family]) : null;
    });
  return {
    actionGet: async (id) => optional(await kernel.querySelf("icpswap_action_get", [id]), "operation", parseActionOperation),
    actionPage: async ({ cursor, limit }) => {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("History page size must be a positive exact integer.");
      let count = limit;
      for (;;) {
        let reply: unknown;
        try {
          reply = await kernel.querySelf("icpswap_action_page", [{ cursor, limit: String(count) }]);
        } catch (error) {
          // Existing transport limits vary with the size of each saved intent.
          // Retry this read with fewer rows, retaining the same cursor; callers
          // continue from the returned cursor to discover every saved action.
          const message = error instanceof Error ? error.message : String(error);
          const overflow = [
            "Self-call Candid reply exceeds the raw byte limit",
            "Self-call Candid reply exceeds the raw metadata limit",
            "Self-call result exceeds the metadata byte limit",
            "Candid reply exceeds the container element limit",
            "Candid reply exceeds the decoder allocation limit",
            "Self-call value exceeds the Candid container element limit",
          ].includes(message);
          if (!overflow || count === 1) throw error;
          count = Math.max(1, Math.floor(count / 2));
          continue;
        }
        const value = object(reply, "history page");
        return {
          items: list(value.items, "history page.items", parseActionSummary),
          nextCursor: optional(value.next_cursor, "history page.next_cursor", text),
        };
      }
    },
    actionUpdate: async (request) => parseActionOperation(await kernel.updateSelf("icpswap_action_update", [request])),
    swapPrepare: async (request) => swap(await kernel.updateSelf("icpswap_swap_prepare_v1", [request])),
    swapExecute: async (request) => swap(await kernel.updateSelf("icpswap_swap_execute_v1", [request])),
    swapStatus: (id) => status(id, "swap", swap),
    liquidityPrepare: async (request) => liquidity(await kernel.updateSelf("icpswap_liquidity_prepare", [request])),
    liquidityExecute: async (request) => liquidity(await kernel.updateSelf("icpswap_liquidity_execute", [request])),
    liquidityStatus: (id) => status(id, "liquidity", liquidity),
    liquidityReconcile: async (id) => {
      const value = await kernel.updateSelf("icpswap_liquidity_reconcile", [id]);
      return { ...liquidity(value), pool: parseLiquidityPool(object(value, "reconciliation").pool) };
    },
    liquidityPreview: async (request) => parseLiquidityPlan(await kernel.updateSelf("icpswap_liquidity_preview", [request])),
    liquidityPool: async (pool) => parseLiquidityPool(await kernel.updateSelf("icpswap_liquidity_pool", [pool])),
    recoveryPrepare: async (request) => recovery(await kernel.updateSelf("icpswap_liquidity_recover_prepare", [request])),
    recoveryExecute: async (request) => recovery(await kernel.updateSelf("icpswap_liquidity_recover_execute", [request])),
    recoveryStatus: (id) => status(id, "recovery", recovery),
    account: async () => text(await kernel.querySelf("icpswap_account", []), "account"),
  };
}
