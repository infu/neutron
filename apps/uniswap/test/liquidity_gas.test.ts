import { expect, test } from "bun:test";
import {
  createEvmWalletClient, type EvmEstimateTransactionRequest,
  type EvmEstimateTransactionResult, type EvmSendTransactionRequest,
} from "neutron-tools/evm_wallet";
import { prepareLiquidityGas, v3IncreaseGasLimit, v4CollectGasLimit } from "../src/liquidity_gas.ts";
import { positionManager, V3_POSITION_MANAGER } from "../src/positions.ts";

const accountAddress = "0x1111111111111111111111111111111111111111";
const request: EvmSendTransactionRequest = {
  requestId: "ab".repeat(16), accountId: "main", chainId: "1",
  to: V3_POSITION_MANAGER, valueWei: "0", data: "0x219f5d17",
};
const context = {
  kind: "liquidity", input: { protocol: "v3", operation: "increase" },
  stepKind: "transaction" as const, accountAddress, request,
};
function observation(request: EvmEstimateTransactionRequest): EvmEstimateTransactionResult {
  return {
    ...request, address: accountAddress, status: "available", gasLimit: "231999",
    gasPriceWei: "10", baseFeePerGasWei: "9", maxPriorityFeePerGasWei: "1", maxFeePerGasWei: "19",
    estimatedFeeWei: "2319990", maximumFeeWei: "4407981", blockNumber: "25934514",
    observedAtNs: "1788890000000000000", feeBasis: "base_fee_plus_priority", postingCosts: "not_applicable",
    reasons: [], source: "evm_rpc",
  };
}
function fixture(respond: (request: EvmEstimateTransactionRequest) => unknown = observation) {
  const calls: { request: EvmEstimateTransactionRequest; signal?: AbortSignal }[] = [];
  const wallet = createEvmWalletClient({ callTool: async (call, options) => {
    expect(call.target).toBe("app:evm_wallet:background");
    expect(call.name).toBe("evm_estimate_transaction_v1");
    const request = call.arguments as EvmEstimateTransactionRequest;
    calls.push({ request, ...(typeof options === "object" && options.signal ? { signal: options.signal } : {}) });
    return respond(request) as never;
  } });
  return { wallet, calls };
}

test("V3 increase reserves gas beyond the observed production state-cost change and retains exact evidence", async () => {
  const app = fixture(), before = JSON.stringify(context), controller = new AbortController();
  const result = await prepareLiquidityGas(app.wallet, context, { signal: controller.signal });
  expect(result?.request).toEqual({ ...request, to: request.to.toLowerCase(), gasLimit: "331999" });
  expect(BigInt(result!.request.gasLimit!)).toBeGreaterThan(245079n + (245079n + 4n) / 5n);
  expect(result?.diagnostics).toMatchObject({
    version: 1, additionalGas: "100000", gasLimit: "331999", maximumFeeWei: "6307981",
    observation: { gasLimit: "231999", blockNumber: "25934514", source: "evm_rpc", data: request.data },
  });
  expect(app.calls).toEqual([{
    request: { accountId: "main", chainId: "1", to: request.to.toLowerCase(), valueWei: "0", data: request.data }, signal: controller.signal,
  }]);
  expect(JSON.stringify(context)).toBe(before);
  expect(v3IncreaseGasLimit(9007199254740993n)).toBe(9007199254840993n);
});

test("other effects and retained explicit gas requests are unchanged and require no estimate", async () => {
  const app = fixture();
  for (const changed of [
    { ...context, kind: "swap" },
    { ...context, input: { protocol: "v4", operation: "increase" } },
    { ...context, input: { protocol: "v3", operation: "mint" } },
    { ...context, stepKind: "approval" as const },
    { ...context, request: { ...request, gasLimit: "333333" } },
  ]) expect(await prepareLiquidityGas(app.wallet, changed)).toBeNull();
  expect(app.calls).toEqual([]);
});

test.each(["1", "42161"])("V4 collection on chain %s retains a block-pinned estimate and fee-accrual reserve", async (chainId) => {
  const request = { ...context.request, chainId, to: positionManager(chainId, "v4"), data: "0xdd46508f" };
  const collect = { ...context, input: { protocol: "v4", operation: "collect" }, request };
  const app = fixture(request => ({ ...observation(request), gasLimit: "99608", estimatedFeeWei: "996080", maximumFeeWei: "1892552", blockNumber: "25935604",
    feeBasis: chainId === "42161" ? "arbitrum_total_gas" : "base_fee_plus_priority", postingCosts: chainId === "42161" ? "included" : "not_applicable" }));
  const result = await prepareLiquidityGas(app.wallet, collect);
  expect(result?.request).toEqual({ ...request, to: request.to.toLowerCase(), gasLimit: "199608" });
  expect(result?.diagnostics).toMatchObject({
    basis: "wallet_estimate_plus_v4_collect_reserve", additionalGas: "100000", gasLimit: "199608", maximumFeeWei: "3792552",
    observation: { blockNumber: "25935604", gasLimit: "99608", data: request.data },
  });
  expect(v4CollectGasLimit(99608n)).toBeGreaterThan(113315n + (113315n + 4n) / 5n);
  expect(v4CollectGasLimit(9007199254740993n)).toBe(9007199254840993n);
  expect(() => v4CollectGasLimit(0n)).toThrow("positive");
  expect(await prepareLiquidityGas(app.wallet, { ...collect, request: result!.request })).toBeNull();
  expect(app.calls).toHaveLength(1);
  await expect(prepareLiquidityGas(app.wallet, { ...collect, request: { ...request, to: V3_POSITION_MANAGER } })).rejects.toThrow("V4 collect does not target");
});

test("a failed, unpinned or mismatched estimate cannot become a guessed gas limit", async () => {
  for (const respond of [
    () => { throw new Error("RPC offline"); },
    (request: EvmEstimateTransactionRequest) => ({ ...observation(request), data: "0x00" }),
    (request: EvmEstimateTransactionRequest) => ({ ...observation(request), address: "0x2222222222222222222222222222222222222222" }),
    (request: EvmEstimateTransactionRequest) => ({ ...observation(request), blockNumber: null }),
    (request: EvmEstimateTransactionRequest) => ({
      ...observation(request), status: "unavailable", gasLimit: null, estimatedFeeWei: null,
      maximumFeeWei: null, feeBasis: "unavailable", reasons: ["insufficient allowance"],
    }),
  ]) await expect(prepareLiquidityGas(fixture(respond).wallet, context)).rejects.toThrow();
  const failed = fixture(request => ({
    ...observation(request), status: "unavailable", gasLimit: null, estimatedFeeWei: null,
    maximumFeeWei: null, feeBasis: "unavailable", reasons: ["insufficient allowance"],
  }));
  await expect(prepareLiquidityGas(failed.wallet, context)).rejects.toThrow("Continue the same operation ID");
  expect(request.gasLimit).toBeUndefined();
});

test("gas evidence remains usable when only independent fee pricing is unavailable", async () => {
  const app = fixture(request => ({
    ...observation(request), status: "unavailable", estimatedFeeWei: null, maximumFeeWei: null,
    maxFeePerGasWei: null, feeBasis: "unavailable", reasons: ["Fee pricing unavailable"],
  }));
  const result = await prepareLiquidityGas(app.wallet, context);
  expect(result?.request.gasLimit).toBe("331999");
  expect(result?.diagnostics.maximumFeeWei).toBeNull();
});

test("cancelled preparation cannot reach a gas estimate", async () => {
  const app = fixture(), controller = new AbortController(); controller.abort(new Error("Cancelled"));
  await expect(prepareLiquidityGas(app.wallet, context, { signal: controller.signal })).rejects.toThrow("Cancelled");
  expect(app.calls).toEqual([]);
});
