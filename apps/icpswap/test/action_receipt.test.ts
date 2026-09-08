import { describe, expect, test } from "bun:test";
import type { JsonObject, MsgBusToolContext } from "neutron-tools/app";
import { buildLiquidityReceipt } from "../src/action_receipt.ts";
import { createActionHandlers } from "../src/action_tools.ts";
import type { ActionBackend, ActionPrepared } from "../src/action_backend.ts";

const ID = "a1".repeat(16), POOL = "mohjv-bqaaa-aaaag-qjyia-cai", OWNER = "3rurp-vyaaa-aaaay-aacua-cai";
const ICP = "ryjl3-tyaaa-aaaaa-aaaba-cai", USDC = "xevnm-gaaaa-aaaar-qafnq-cai";
const LARGE = "900719925474099312345678901234567890";
const methods = { mint: "mint", increase: "increaseLiquidity", decrease: "decreaseLiquidity", close: "decreaseLiquidity", claim: "claim", withdraw: "withdraw" };

function fixture(action: keyof typeof methods = "mint"): ActionPrepared {
  return {
    operation: {
      id: ID, input_json: JSON.stringify({ version: 1, kind: "liquidity", owner: {}, input: {} }), plan_json: "", funding_json: "",
      state: "settlement_pending", detail: "Protocol confirmed", result_json: "", revision: "9", created_at: "1", updated_at: "2",
      effects: [
        { key: "deposit0", canister: POOL, method: "depositFrom", state: "succeeded", result_nat: "12345" },
        { key: "liquidity", canister: POOL, method: methods[action], state: "succeeded", completed_at: "1788951212345678901",
          result_nat: action === "mint" || action === "increase" ? LARGE : null,
          result_amount0: action === "claim" || action === "decrease" || action === "close" ? LARGE : null,
          result_amount1: action === "claim" || action === "decrease" || action === "close" ? "0" : null },
      ],
    },
    plan: {
      pool: POOL, owner: OWNER, token0: { address: ICP, standard: "ICRC2" }, token1: { address: USDC, standard: "ICRC2" },
      request: { kind: action, pool: POOL, position_id: action === "mint" ? null : LARGE,
        amount0: "10000000", amount1: "300000", liquidity: "190341512", withdraw_token: USDC, withdraw_amount: "50000" },
      expected_amount0: "9686761", expected_amount1: "299999", expected_liquidity: "190341512",
    },
  };
}

describe("liquidity protocol receipts", () => {
  test.each(["mint", "increase"] as const)("%s exposes the exact returned position, without inventing actual use or refunds", (kind) => {
    const prepared = fixture(kind), receipt = buildLiquidityReceipt(prepared)!;
    expect(receipt).toMatchObject({ version: 1, kind: "liquidity", operationId: ID, action: kind, pool: POOL, owner: OWNER,
      positionId: LARGE, grossOutputAmounts: null, liquidityRemoved: null, actualTokenUse: null, refunds: null,
      protocol: { status: "succeeded", method: methods[kind], completedAtNs: "1788951212345678901", resultNat: LARGE },
      settlement: { status: "unverified", payoutReferences: [] } });
    expect(receipt.token0.address).toBe(ICP); expect(receipt.token1.address).toBe(USDC);
    expect(receipt.amountNote).toContain("not actual amounts");
    expect(receipt.settlement.reason).toContain("no operation-linked ledger");
    expect(JSON.stringify(receipt)).not.toContain("9686761");
    expect(JSON.stringify(receipt)).not.toContain("300000");
  });

  test.each(["decrease", "close"] as const)("%s links actual gross output with saved exact removal, independently of estimates", (kind) => {
    const prepared = fixture(kind), receipt = buildLiquidityReceipt(prepared)!;
    expect(receipt.positionId).toBe(LARGE);
    expect(receipt.grossOutputAmounts).toEqual({ amount0: LARGE, amount1: "0" });
    expect(receipt.liquidityRemoved).toBe("190341512");
    expect(receipt.actualTokenUse).toBeNull(); expect(receipt.refunds).toBeNull();
    expect(receipt.settlement.status).toBe("unverified");
    expect(receipt.amountNote).toContain("principal and fees");
  });

  test("only an exact confirmed zero-output claim requires no payout", () => {
    const prepared = fixture("claim");
    prepared.operation.effects[1]!.result_amount0 = "0";
    expect(buildLiquidityReceipt(prepared)).toMatchObject({ positionId: LARGE,
      grossOutputAmounts: { amount0: "0", amount1: "0" }, liquidityRemoved: null,
      settlement: { status: "not_required", payoutReferences: [] } });
    prepared.operation.state = "complete";
    expect(buildLiquidityReceipt(prepared)?.settlement.status).toBe("not_required");
    prepared.operation.effects[1]!.result_amount0 = "1";
    expect(buildLiquidityReceipt(prepared)?.settlement.status).toBe("unverified");
    prepared.operation.effects[1]!.result_amount0 = null;
    expect(buildLiquidityReceipt(prepared)).toMatchObject({ grossOutputAmounts: null, settlement: { status: "unverified" } });
  });

  test.each(["decrease", "close"] as const)("zero amounts on %s are not recast as a zero-payout claim", (kind) => {
    const prepared = fixture(kind); prepared.operation.effects[1]!.result_amount0 = "0";
    expect(buildLiquidityReceipt(prepared)?.settlement.status).toBe("unverified");
  });

  test("unavailable result fields remain null rather than estimates, deposit amounts or position guesses", () => {
    const prepared = fixture(); prepared.operation.effects[1]!.result_nat = null;
    expect(buildLiquidityReceipt(prepared)?.positionId).toBeNull();
    prepared.operation.effects[1]!.result_nat = "0";
    expect(buildLiquidityReceipt(prepared)?.positionId).toBe("0");
    prepared.operation.effects[1]!.result_nat = Number(LARGE);
    expect(buildLiquidityReceipt(prepared)?.positionId).toBeNull();
    const withdrawal = fixture("withdraw"); withdrawal.operation.effects[1]!.result_nat = "50000";
    expect(buildLiquidityReceipt(withdrawal)).toMatchObject({ positionId: null, grossOutputAmounts: null,
      protocol: { resultNat: "50000" }, settlement: { status: "unverified" } });
  });

  test.each(["prepared", "funded", "settlement_pending", "complete"])("%s state alone cannot manufacture protocol success", (state) => {
    const prepared = fixture(); prepared.operation.state = state; prepared.operation.effects.pop();
    expect(buildLiquidityReceipt(prepared)).toBeNull();
  });

  test.each(["failed", "uncertain", "requested"])("%s effects never become receipts", (state) => {
    const prepared = fixture("claim"); prepared.operation.effects[1]!.state = state;
    expect(buildLiquidityReceipt(prepared)).toBeNull();
    prepared.operation.effects[1]!.state = "succeeded"; prepared.operation.effects[0]!.state = state;
    expect(buildLiquidityReceipt(prepared)).toBeNull();
  });

  test.each(["uncertain", "stopped"])("%s operation does not claim a successful terminal receipt", (state) => {
    const prepared = fixture(); prepared.operation.state = state;
    expect(buildLiquidityReceipt(prepared)).toBeNull();
  });

  test("matching retained success remains useful when the compact operation state lags", () => {
    const prepared = fixture(); prepared.operation.state = "execution_requested";
    expect(buildLiquidityReceipt(prepared)?.positionId).toBe(LARGE);
  });

  test("receipt must match the retained pool and exact protocol action", () => {
    const prepared = fixture(); prepared.operation.effects[1]!.method = "depositFrom";
    expect(buildLiquidityReceipt(prepared)).toBeNull();
    prepared.operation.effects[1]!.method = "mint"; prepared.operation.effects[1]!.canister = "aaaaa-aa";
    expect(buildLiquidityReceipt(prepared)).toBeNull();
    prepared.operation.effects[1]!.canister = POOL; (prepared.plan.request as JsonObject).pool = "aaaaa-aa";
    expect(buildLiquidityReceipt(prepared)).toBeNull();
  });
});

test("status returns typed liquidity receipt and retained plan provenance without any effect or Wallet call", async () => {
  const prepared = fixture(), calls: string[] = [];
  const handlers = createActionHandlers({
    backendFor: () => ({
      actionGet: async () => { calls.push("actionGet"); return prepared.operation; },
      liquidityStatus: async () => { calls.push("liquidityStatus"); return prepared; },
    } as unknown as ActionBackend),
    authorize: async () => { throw new Error("Read-only status requested authorization"); },
  });
  const result = await handlers.status({ operationId: ID }, { kernel: {} } as MsgBusToolContext);
  expect((result.receipt as JsonObject).positionId).toBe(LARGE);
  expect(result.plan).toEqual(prepared.plan);
  expect((result.operation as JsonObject).plan_json).toBe("");
  expect(result.planSource).toMatchObject({ kind: "durable_candid_plan_blob" });
  expect((result.planSource as JsonObject).note).toContain("legacy JSON slot");
  expect(calls).toEqual(["actionGet", "liquidityStatus"]);
});

test("existing swap receipt remains byte-for-byte compatible", async () => {
  const prepared = fixture(); prepared.operation.input_json = JSON.stringify({ version: 1, kind: "swap", owner: {}, input: {} });
  prepared.plan = { pool: POOL };
  prepared.receipt = { state: "settlement_pending", quoted_out: LARGE, received_out: "0", detail: "Existing swap evidence" };
  const handlers = createActionHandlers({ backendFor: () => ({ actionGet: async () => prepared.operation, swapStatus: async () => prepared } as unknown as ActionBackend), authorize: async () => {} });
  const result = await handlers.status({ operationId: ID }, { kernel: {} } as MsgBusToolContext);
  expect(result.receipt).toEqual(prepared.receipt);
});
