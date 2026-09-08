import { describe, expect, test } from "bun:test";
import { createBackendClient, type BackendTransport } from "../src/backend.ts";
import { createActionBackend, parseActionOperation, parseLiquidityPlan, parseRecoveryPlan } from "../src/action_backend.ts";

const atoms = "123456789012345678901234567890";
const quote = {
  pool: "pool-a", pool_key: "pool-key", fee_tier: "3000",
  input_address: "input-ledger", output_address: "output-ledger",
  decimals_in: "8", decimals_out: "6", zero_for_one: true,
  amount_in: atoms, quoted_out: "1020000", amount_out_minimum: "1004900", expected_out: "1010000",
  token_in_fee: "10000", token_out_fee: "10000", funding_amount: atoms,
  total_debit: "123456789012345678901234587890", price_impact: 0.002, warn: false,
  slippage: "500", funding_ledger: "input-ledger", funding_spender: "pool-a", at: "1788890400000000000",
};
const request = { requestId: "ab".repeat(16), inputAddress: "input-ledger", outputAddress: "output-ledger", amountIn: BigInt(atoms), slippage: 500 };
const operation = {
  id: request.requestId, input_json: "{}", plan_json: "{}", funding_json: "[]", state: "prepared",
  detail: "Prepared", result_json: "", revision: "9007199254740993",
  created_at: "1788890400000000000", updated_at: "1788890400000000001", effects: [],
};
const liquidityRequest = {
  pool: "pool-a", kind: "mint", position_id: null, tick_lower: "-120", tick_upper: "60",
  amount0: atoms, amount1: "3000000", liquidity: "0", withdraw_token: "", withdraw_amount: "0",
};
const plan = {
  request: liquidityRequest, pool: "pool-a", owner: "owner", token0: { address: "token0", standard: "ICRC2" },
  token1: { address: "token1", standard: "ICRC1" }, fee: "3000", tick_spacing: "60", tick: "-13",
  sqrt_price_x96: "79228162514264337593543950336", fee0: "10000", fee1: "10000",
  funding0: atoms, funding1: "3000000", expected_amount0: atoms, expected_amount1: "2999999",
  expected_liquidity: "12345678901234567890", unused0: "0", unused1: "0", baseline_positions: [],
  observed_at: "1788890400000000000", price_protection: false, detail: "No protocol price guard",
};

function transport(handler: (kind: "query" | "update", method: string, args: unknown[]) => Promise<unknown> | unknown): BackendTransport {
  return {
    querySelf: (method: string, args: unknown[] = []) => Promise.resolve(handler("query", method, args)),
    updateSelf: (method: string, args: unknown[] = []) => Promise.resolve(handler("update", method, args)),
  } as unknown as BackendTransport;
}

describe("legacy quote transport regression", () => {
  test("reads the already-unwrapped successful quote and retains atomic precision", async () => {
    const calls: unknown[] = [];
    const backend = createBackendClient(transport((kind, method, args) => { calls.push({ kind, method, args }); return quote; }));
    const result = await backend.quoteSwap(request);
    expect(result.pool).toBe("pool-a");
    expect(result.amountIn).toBe(BigInt(atoms));
    expect(result.amountOutMinimum).toBe(1004900n);
    expect(result.fundingAmount).toBe(BigInt(atoms));
    expect(calls).toEqual([{ kind: "update", method: "icpswap_swap_quote", args: [{
      request_id: request.requestId, input_address: "input-ledger", output_address: "output-ledger", amount_in: atoms, slippage: 500,
    }] }]);
  });

  test("keeps overlapping invocations on their originating scoped transport", async () => {
    let resolveFirst!: (value: unknown) => void;
    const firstCalls: string[] = [];
    const secondCalls: string[] = [];
    const first = createBackendClient(transport((_kind, method) => {
      firstCalls.push(method);
      return new Promise((resolve) => { resolveFirst = resolve; });
    }));
    const second = createBackendClient(transport((_kind, method) => {
      secondCalls.push(method);
      return { ...quote, pool: "pool-second", amount_in: "42" };
    }));
    const pendingFirst = first.quoteSwap(request);
    const secondResult = await second.quoteSwap({ ...request, amountIn: 42n });
    resolveFirst({ ...quote, pool: "pool-first" });
    const firstResult = await pendingFirst;
    expect(firstResult.pool).toBe("pool-first");
    expect(firstResult.amountIn).toBe(BigInt(atoms));
    expect(secondResult.pool).toBe("pool-second");
    expect(secondResult.amountIn).toBe(42n);
    expect(firstCalls).toEqual(["icpswap_swap_quote"]);
    expect(secondCalls).toEqual(["icpswap_swap_quote"]);
  });

  test("preserves a rejected backend Result's diagnostic", async () => {
    const failure = new Error("ICPSwap quote failed: pool is unavailable");
    const client = createBackendClient(transport(() => { throw failure; }));
    await expect(client.quoteSwap(request)).rejects.toBe(failure);
  });
});

describe("durable action transport", () => {
  test("normalizes bigint and optional fields without rounding or dropping zero results", () => {
    const parsed = parseActionOperation({ ...operation, revision: 9007199254740993n, effects: [{
      key: "mint", canister: "pool-a", method: "mint", state: "succeeded", error: "",
      dispatched_at: 1788890400000000000n, completed_at: [1788890400000000001n],
      result_nat: [0n], result_amount0: [], result_amount1: null,
    }] });
    expect(parsed.revision).toBe("9007199254740993");
    expect(parsed.effects[0]).toMatchObject({ completed_at: "1788890400000000001", result_nat: "0", result_amount0: null, result_amount1: null });
    expect(() => JSON.stringify(parsed)).not.toThrow();
  });

  test("rejects unsafe or missing amounts with the exact field instead of inventing zero", () => {
    expect(() => parseLiquidityPlan({ ...plan, funding0: Number.MAX_SAFE_INTEGER + 1 })).toThrow("plan.funding0");
    expect(() => parseLiquidityPlan({ ...plan, expected_amount1: undefined })).toThrow("plan.expected_amount1");
    expect(() => parseLiquidityPlan({ ...plan, funding1: "-1" })).toThrow("plan.funding1");
    expect(() => parseLiquidityPlan({ ...plan, price_protection: undefined })).toThrow("plan.price_protection");
    expect(parseLiquidityPlan(plan).tick).toBe("-13");
  });

  test("reads saved plans directly, handles absent operations, and propagates backend failures", async () => {
    const backend = createActionBackend(transport((_kind, method, args) => {
      if (args[0] === "missing") return null;
      if (args[0] === "failed") throw new Error("Retained operation is uncertain");
      if (method === "icpswap_action_status" && args[0] === "swap") return { swap: { operation, plan: quote, receipt: [] } };
      if (method === "icpswap_action_status" && args[0] === "liquidity") return [{ liquidity: { operation, plan } }];
      return operation;
    }));
    expect((await backend.swapStatus("swap"))?.plan.amount_in).toBe(atoms);
    expect((await backend.swapStatus("swap"))?.receipt).toBeNull();
    expect((await backend.liquidityStatus("liquidity"))?.plan.sqrt_price_x96).toBe(plan.sqrt_price_x96);
    expect(await backend.swapStatus("liquidity")).toBeNull();
    expect(await backend.liquidityStatus("swap")).toBeNull();
    expect(await backend.recoveryStatus("swap")).toBeNull();
    expect(await backend.actionGet("missing")).toBeNull();
    expect(await backend.swapStatus("missing")).toBeNull();
    await expect(backend.swapStatus("failed")).rejects.toThrow("Retained operation is uncertain");
  });

  test("rejects malformed generic status variants without selecting an arbitrary action", async () => {
    for (const response of [{}, { unknown: { operation, plan } }, { swap: { operation, plan: quote }, liquidity: { operation, plan } }]) {
      const backend = createActionBackend(transport(() => response));
      await expect(backend.swapStatus("saved")).rejects.toThrow("one swap, liquidity, or recovery variant arm");
    }
  });

  test("preserves exact funding bytes and revision across a scoped update and dispatch", async () => {
    const calls: unknown[] = [];
    const backend = createActionBackend(transport((kind, method, args) => {
      calls.push({ kind, method, args });
      return method === "icpswap_action_update" ? operation : { operation, plan };
    }));
    const update = {
      id: operation.id, expected_revision: operation.revision, state: "funding_requested",
      detail: "Requested", result_json: "", funding_json: '{"requestId":"original-id","validUntilNs":"1788890400000000000"}',
    };
    await backend.actionUpdate(update);
    await backend.liquidityExecute({ id: operation.id, expected_revision: operation.revision });
    expect(calls).toEqual([
      { kind: "update", method: "icpswap_action_update", args: [update] },
      { kind: "update", method: "icpswap_liquidity_execute", args: [{ id: operation.id, expected_revision: operation.revision }] },
    ]);
  });

  test("does not mistake an extra Result envelope for a valid prepared action", async () => {
    const backend = createActionBackend(transport(() => ({ ok: { operation, plan } })));
    await expect(backend.liquidityPrepare({ id: operation.id, input_json: "{}", request: liquidityRequest })).rejects.toThrow("operation");
  });

  test("direct-deposit recovery retains the exact gross amount and original history reference", async () => {
    const sourceId = `app:icpswap:root:${"cd".repeat(16)}`;
    const recoveryPlan = {
      source_id: sourceId, token_index: 1n, pool: "pool-a", owner: "owner",
      token: { address: "token1", standard: "ICRC1" }, gross_amount: BigInt(atoms),
      fee: 10000n, credit_amount: BigInt(atoms) - 10000n, observed_at: 1788890400000000000n,
    };
    const calls: unknown[] = [];
    const backend = createActionBackend(transport((kind, method, args) => {
      calls.push({ kind, method, args });
      if (args[0] === "absent") return null;
      const saved = { operation, plan: recoveryPlan };
      return method === "icpswap_action_status" ? { recovery: saved } : saved;
    }));
    const request = { id: operation.id, input_json: '{"kind":"recover"}', source_id: sourceId, token_index: "1" };
    const saved = await backend.recoveryPrepare(request);
    expect(saved.plan).toEqual({ ...recoveryPlan, token_index: "1", gross_amount: atoms, fee: "10000",
      credit_amount: "123456789012345678901234557890", observed_at: "1788890400000000000" });
    await backend.recoveryExecute({ id: operation.id, expected_revision: operation.revision });
    expect((await backend.recoveryStatus(operation.id))?.plan.source_id).toBe(sourceId);
    expect(await backend.recoveryStatus("absent")).toBeNull();
    expect(calls).toEqual([
      { kind: "update", method: "icpswap_liquidity_recover_prepare", args: [request] },
      { kind: "update", method: "icpswap_liquidity_recover_execute", args: [{ id: operation.id, expected_revision: operation.revision }] },
      { kind: "query", method: "icpswap_action_status", args: [operation.id] },
      { kind: "query", method: "icpswap_action_status", args: ["absent"] },
    ]);
    expect(() => parseRecoveryPlan({ ...recoveryPlan, gross_amount: Number.MAX_SAFE_INTEGER + 1 })).toThrow("plan.gross_amount");
    expect(() => parseRecoveryPlan({ ...recoveryPlan, source_id: undefined })).toThrow("plan.source_id");
    expect(() => parseRecoveryPlan({ ...recoveryPlan, credit_amount: undefined })).toThrow("plan.credit_amount");
  });
});
